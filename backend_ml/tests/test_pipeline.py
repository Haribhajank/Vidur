import io
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import (  # noqa: E402
    Block,
    ExtractionError,
    blocks_from_pages,
    chunk_blocks,
    extract_document,
    extract_epub,
    looks_like_heading,
    split_sentences,
)


def _sentences(n: int, words: int = 20, prefix: str = "Fact") -> str:
    body = " ".join(["word"] * (words - 2))
    return " ".join(f"{prefix} {i} {body}." for i in range(n))


def test_split_sentences_handles_quotes_and_abbreviation_free_text() -> None:
    parts = split_sentences('First sentence here. "Second one!" Third? 4 is a number.')
    assert parts == ["First sentence here.", '"Second one!"', "Third?", "4 is a number."]


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("Chapter 3: Thermodynamics", True),
        ("2.1 Entropy and Disorder", True),
        ("INTRODUCTION TO MECHANICS", True),
        ("This is a normal sentence that ends with a period.", False),
        ("x", False),
    ],
)
def test_heading_detection(line: str, expected: bool) -> None:
    assert looks_like_heading(line) is expected


def test_chunks_respect_word_bounds_and_overlap() -> None:
    blocks = [Block(text=_sentences(60), page=1 + i // 20, heading="Chapter 1") for i in range(1)]
    chunks = chunk_blocks(blocks)
    assert len(chunks) >= 2
    for chunk in chunks:
        assert chunk.word_count <= 600
        assert chunk.chapter_title == "Chapter 1"
    for chunk in chunks[:-1]:
        assert 200 <= chunk.word_count <= 500
    first_last_sentence = split_sentences(chunks[0].content)[-1]
    assert chunks[1].content.startswith(first_last_sentence)
    assert [c.chunk_index for c in chunks] == list(range(len(chunks)))


def test_chunks_never_cross_chapters_and_track_pages() -> None:
    blocks = [
        Block(text="Chapter 1", page=1, heading="Chapter 1", is_heading=True),
        Block(text=_sentences(5), page=1, heading="Chapter 1"),
        Block(text=_sentences(5), page=2, heading="Chapter 1"),
        Block(text="Chapter 2", page=3, heading="Chapter 2", is_heading=True),
        Block(text=_sentences(5), page=3, heading="Chapter 2"),
    ]
    chunks = chunk_blocks(blocks)
    assert [c.chapter_title for c in chunks] == ["Chapter 1", "Chapter 2"]
    assert (chunks[0].page_start, chunks[0].page_end) == (1, 2)
    assert (chunks[1].page_start, chunks[1].page_end) == (3, 3)


def test_short_tail_merges_into_previous_chunk() -> None:
    chunks = chunk_blocks([Block(text=_sentences(27), page=1, heading=None)])
    assert len(chunks) == 1
    assert chunks[0].word_count == 540


def test_overlong_sentence_is_hard_split() -> None:
    giant = " ".join(["token"] * 1200) + "."
    chunks = chunk_blocks([Block(text=giant, page=4, heading="H")])
    assert all(c.word_count <= 500 * 1.2 for c in chunks)
    assert sum(c.word_count for c in chunks) >= 1200


def test_invalid_chunk_parameters_rejected() -> None:
    with pytest.raises(ValueError):
        chunk_blocks([], min_words=0)


def test_blocks_from_pages_strips_running_headers_and_page_numbers() -> None:
    pages = [f"MY BOOK TITLE\n\nChapter {i}\n\n{_sentences(3)}\n\n{i}" for i in range(1, 8)]
    blocks = blocks_from_pages(pages)
    texts = [b.text for b in blocks]
    assert "MY BOOK TITLE" not in texts
    assert not any(t.strip().isdigit() for t in texts)
    assert blocks[0].is_heading and blocks[0].heading == "Chapter 1"
    assert blocks[-1].page == 7


def _make_epub(chapters: list[tuple[str, str]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
            "</rootfiles></container>",
        )
        items = "".join(f'<item id="c{i}" href="text/c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(chapters)))
        spine = "".join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))
        zf.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book</dc:title>'
            f"<dc:creator>Ada Author</dc:creator></metadata><manifest>{items}</manifest><spine>{spine}</spine></package>",
        )
        for i, (title, body) in enumerate(chapters):
            zf.writestr(
                f"OEBPS/text/c{i}.xhtml",
                f"<html><head><style>p{{}}</style></head><body><h1>{title}</h1><p>{body}</p><script>evil()</script></body></html>",
            )
    return buffer.getvalue()


def test_epub_extraction_reads_spine_metadata_and_headings() -> None:
    doc = extract_epub(_make_epub([("Origins", _sentences(20)), ("Growth", _sentences(20))]))
    assert doc.title == "Test Book"
    assert doc.author == "Ada Author"
    headings = [b.text for b in doc.blocks if b.is_heading]
    assert headings == ["Origins", "Growth"]
    assert all("evil" not in b.text for b in doc.blocks)
    chunks = chunk_blocks(doc.blocks)
    assert {c.chapter_title for c in chunks} == {"Origins", "Growth"}


def test_extract_document_validates_magic_bytes() -> None:
    with pytest.raises(ExtractionError):
        extract_document(b"not a pdf", "application/pdf")
    with pytest.raises(ExtractionError):
        extract_document(b"%PDF-1.7", "application/epub+zip")
    with pytest.raises(ExtractionError):
        extract_document(b"PK\x03\x04garbage", "application/epub+zip")
