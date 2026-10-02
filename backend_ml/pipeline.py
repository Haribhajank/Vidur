"""Pure, dependency-light document processing: layout-aware extraction and semantic chunking.

Kept free of FastAPI / database / model imports so it can be unit-tested in isolation.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from posixpath import dirname, join, normpath
from typing import Iterable, Iterator
from xml.etree import ElementTree

MIN_CHUNK_WORDS = 200
MAX_CHUNK_WORDS = 500
OVERLAP_SENTENCES = 1
EPUB_WORDS_PER_PAGE = 300
MAX_HEADING_WORDS = 14

# Split after terminal punctuation, optionally followed by ONE closing quote/bracket (kept with the
# sentence). Two fixed-width lookbehinds are used because Python lookbehinds cannot vary in width.
_SENTENCE_RE = re.compile(r"(?:(?<=[.!?…])|(?<=[.!?…][\"'”’)\]]))\s+(?=[A-Z0-9\"'“‘(\[])")
_WS_RE = re.compile(r"[ \t\u00a0]+")
_HYPHEN_BREAK_RE = re.compile(r"(\w)-\n(\w)")
_PAGE_NUMBER_RE = re.compile(r"(page\s*)?(\d{1,4}|[ivxlcdm]{1,7})(\s*(of|/)\s*\d{1,4})?", re.IGNORECASE)
_HEADING_RE = re.compile(
    r"^(chapter|part|section|book|lesson|unit)\s+(\d{1,3}|[ivxlcdm]{1,7}|[a-z]|one|two|three|four|five|six|seven|eight|nine|ten)\b.*$"
    r"|^(prologue|epilogue|introduction|preface|foreword|conclusion|appendix|afterword|glossary|bibliography)\b[\s\w:.\-–—]*$"
    r"|^\d{1,2}(\.\d{1,2})*\.?\s+[A-Z][^\n]{0,80}$",
    re.IGNORECASE,
)


class ExtractionError(ValueError):
    """Raised when a document cannot be parsed into usable text."""


@dataclass(frozen=True)
class Block:
    """A paragraph-level unit of text with its source location."""

    text: str
    page: int
    heading: str | None = None
    is_heading: bool = False


@dataclass
class Chunk:
    chunk_index: int
    chapter_title: str | None
    content: str
    page_start: int
    page_end: int
    word_count: int = field(init=False)

    def __post_init__(self) -> None:
        self.word_count = len(self.content.split())


@dataclass(frozen=True)
class ExtractedDocument:
    blocks: list[Block]
    total_pages: int
    title: str | None
    author: str | None


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00ad", "")
    text = _HYPHEN_BREAK_RE.sub(r"\1\2", text)
    text = _WS_RE.sub(" ", text)
    return "\n".join(line.strip() for line in text.split("\n")).strip()


def looks_like_heading(line: str) -> bool:
    words = line.split()
    if not words or len(words) > MAX_HEADING_WORDS or line.endswith((".", ",", ";")):
        return False
    if _HEADING_RE.match(line):
        return True
    letters = [c for c in line if c.isalpha()]
    return len(letters) >= 4 and all(c.isupper() for c in letters)


def split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_RE.split(text) if s.strip()]


def _paragraphs(page_text: str) -> Iterator[str]:
    """Splits page text on blank lines; joins soft-wrapped lines inside a paragraph."""
    for raw in re.split(r"\n\s*\n", page_text):
        lines = [ln for ln in raw.split("\n") if ln.strip()]
        if not lines:
            continue
        if len(lines) == 1 or not any(len(ln) > 60 for ln in lines):
            yield from lines
        else:
            yield " ".join(lines)


def _line_key(line: str) -> str:
    """Exact (case/space-insensitive) text. Digits are NOT wildcarded: that would make successive
    headings such as "Chapter 1".."Chapter 7" look like one running header. Varying page numbers
    are removed separately by _PAGE_NUMBER_RE."""
    return " ".join(line.lower().split())


def _strip_running_headers(pages: list[list[str]]) -> list[list[str]]:
    """Removes non-empty lines that recur in the first/last two text lines of >=40% of pages
    (running headers, footers, page numbers). Blank lines are never touched: they carry the
    paragraph structure."""
    if len(pages) < 5:
        return pages
    counts: dict[str, int] = {}
    for lines in pages:
        text_lines = [ln for ln in lines if ln.strip()]
        for key in {_line_key(ln) for ln in text_lines[:2] + text_lines[-2:]}:
            counts[key] = counts.get(key, 0) + 1
    threshold = max(3, int(len(pages) * 0.4))
    noisy = {k for k, v in counts.items() if v >= threshold and 0 < len(k) < 80}
    return [[ln for ln in lines if not ln.strip() or _line_key(ln) not in noisy] for lines in pages]


def blocks_from_pages(page_texts: Iterable[str]) -> list[Block]:
    """Converts per-page text into heading-aware blocks, tracking the active chapter title."""
    pages = [[ln for ln in normalize_text(t).split("\n")] for t in page_texts]
    pages = _strip_running_headers(pages)
    blocks: list[Block] = []
    heading: str | None = None
    for page_no, lines in enumerate(pages, start=1):
        for para in _paragraphs("\n".join(lines)):
            para = para.strip()
            if not para or _PAGE_NUMBER_RE.fullmatch(para.strip(" -–—|.")):
                continue
            if looks_like_heading(para):
                heading = para[:200]
                blocks.append(Block(text=para, page=page_no, heading=heading, is_heading=True))
            else:
                blocks.append(Block(text=para, page=page_no, heading=heading))
    return blocks


def extract_pdf(data: bytes) -> ExtractedDocument:
    """Layout-aware PDF extraction (pdfplumber), falling back to pypdf per page."""
    import pdfplumber
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:  # noqa: BLE001 - pypdf raises several types here
                raise ExtractionError("PDF is password-protected") from exc
        meta = reader.metadata
        title = (str(meta.title).strip() or None) if meta is not None and meta.title else None
        author = (str(meta.author).strip() or None) if meta is not None and meta.author else None
    except PdfReadError as exc:
        raise ExtractionError(f"Unreadable PDF: {exc}") from exc

    page_texts: list[str] = []
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for index, page in enumerate(pdf.pages):
                text = page.extract_text(layout=False, x_tolerance=1.5, y_tolerance=3) or ""
                if not text.strip():
                    text = reader.pages[index].extract_text() or ""
                page_texts.append(text)
                page.flush_cache()
    except ExtractionError:
        raise
    except Exception:  # noqa: BLE001 - malformed PDFs: degrade to pypdf for every page
        page_texts = [(p.extract_text() or "") for p in reader.pages]

    if sum(len(t.strip()) for t in page_texts) < 200:
        raise ExtractionError("No extractable text (the PDF may be scanned images; OCR is not supported)")
    return ExtractedDocument(blocks=blocks_from_pages(page_texts), total_pages=len(page_texts), title=title, author=author)


# ---------------------------------------------------------------------------
# EPUB (stdlib only: zipfile + ElementTree + HTMLParser)
# ---------------------------------------------------------------------------

_BLOCK_TAGS = {"p", "div", "li", "blockquote", "pre", "section", "article", "tr", "dd", "dt", "figcaption"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4"}
_SKIP_TAGS = {"script", "style", "head", "nav", "svg", "math"}


class _XhtmlBlockParser(HTMLParser):
    """Collects (is_heading, text) pairs from XHTML, using semantic tags for headings."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[tuple[bool, str]] = []
        self._buf: list[str] = []
        self._skip_depth = 0
        self._heading_depth = 0

    def _flush(self, is_heading: bool) -> None:
        text = normalize_text(" ".join(self._buf)).replace("\n", " ")
        self._buf = []
        if text:
            self.items.append((is_heading, text))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag in _HEADING_TAGS:
            self._flush(False)
            self._heading_depth += 1
        elif tag in _BLOCK_TAGS or tag == "br":
            self._flush(self._heading_depth > 0)

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag in _HEADING_TAGS:
            self._flush(True)
            self._heading_depth = max(0, self._heading_depth - 1)
        elif tag in _BLOCK_TAGS:
            self._flush(self._heading_depth > 0)

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self._buf.append(data)

    def close(self) -> None:
        super().close()
        self._flush(self._heading_depth > 0)


def _xml_find_text(root: ElementTree.Element, local: str) -> str | None:
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == local and el.text and el.text.strip():
            return el.text.strip()
    return None


def extract_epub(data: bytes) -> ExtractedDocument:
    """Reads the OPF spine in reading order. Pages are synthetic (~300 words) for citations."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ExtractionError("Invalid EPUB archive") from exc

    with archive:
        if sum(info.file_size for info in archive.infolist()) > 200 * 1024 * 1024:
            raise ExtractionError("EPUB expands beyond the 200 MB safety limit")
        try:
            container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
            rootfile = next(el for el in container.iter() if el.tag.endswith("rootfile"))
            opf_path = rootfile.attrib["full-path"]
            opf = ElementTree.fromstring(archive.read(opf_path))
        except (KeyError, StopIteration, ElementTree.ParseError) as exc:
            raise ExtractionError("EPUB is missing a valid package document") from exc

        base = dirname(opf_path)
        manifest = {
            el.attrib["id"]: el.attrib.get("href", "")
            for el in opf.iter()
            if el.tag.endswith("}item") and "id" in el.attrib
        }
        spine = [el.attrib["idref"] for el in opf.iter() if el.tag.endswith("itemref") and "idref" in el.attrib]
        title = _xml_find_text(opf, "title")
        author = _xml_find_text(opf, "creator")

        blocks: list[Block] = []
        heading: str | None = None
        words_seen = 0
        for idref in spine:
            href = manifest.get(idref)
            if not href:
                continue
            target = href.split("#", 1)[0]
            member = normpath(join(base, target)) if base else normpath(target)
            try:
                raw = archive.read(member).decode("utf-8", errors="replace")
            except KeyError:
                continue
            parser = _XhtmlBlockParser()
            parser.feed(raw)
            parser.close()
            for is_heading, text in parser.items:
                page = words_seen // EPUB_WORDS_PER_PAGE + 1
                if is_heading and len(text.split()) <= MAX_HEADING_WORDS:
                    heading = text[:200]
                    blocks.append(Block(text=text, page=page, heading=heading, is_heading=True))
                else:
                    blocks.append(Block(text=text, page=page, heading=heading))
                words_seen += len(text.split())

    if words_seen < 50:
        raise ExtractionError("EPUB contains no readable text")
    return ExtractedDocument(
        blocks=blocks,
        total_pages=max(1, words_seen // EPUB_WORDS_PER_PAGE + 1),
        title=title,
        author=author,
    )


def extract_document(data: bytes, mime_type: str) -> ExtractedDocument:
    """Dispatches on MIME type after a magic-byte check (never trusts the declared type alone)."""
    if mime_type == "application/pdf":
        if not data.startswith(b"%PDF"):
            raise ExtractionError("File content is not a PDF")
        return extract_pdf(data)
    if mime_type == "application/epub+zip":
        if not data.startswith(b"PK"):
            raise ExtractionError("File content is not an EPUB")
        return extract_epub(data)
    raise ExtractionError(f"Unsupported MIME type: {mime_type}")


# ---------------------------------------------------------------------------
# Semantic chunking: 200-500 words, sentence-aligned, chapter-bounded, 1-sentence overlap
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class _Sentence:
    text: str
    page: int
    words: int


def _sections(blocks: list[Block], max_words: int) -> list[tuple[str | None, list[_Sentence]]]:
    """Groups sentences by chapter heading; hard-splits any single sentence above max_words."""
    sections: list[tuple[str | None, list[_Sentence]]] = []
    for block in blocks:
        if block.is_heading or not sections or sections[-1][0] != block.heading:
            sections.append((block.heading, []))
        if block.is_heading:
            continue
        for sentence in split_sentences(block.text):
            words = sentence.split()
            for i in range(0, len(words), max_words):
                piece = words[i : i + max_words]
                sections[-1][1].append(_Sentence(" ".join(piece), block.page, len(piece)))
    return [(h, s) for h, s in sections if s]


def _pack(sentences: list[_Sentence], min_words: int, max_words: int, overlap: int) -> list[tuple[int, int]]:
    """Greedy packing into [start, end) sentence ranges with `overlap` trailing sentences reused."""
    ranges: list[tuple[int, int]] = []
    start = 0
    n = len(sentences)
    while start < n:
        end = start
        total = 0
        while end < n and (end == start or total + sentences[end].words <= max_words):
            total += sentences[end].words
            end += 1
        ranges.append((start, end))
        if end >= n:
            break
        next_start = max(end - overlap, start + 1)
        if sum(s.words for s in sentences[next_start:end]) > max_words // 2:
            next_start = end
        start = next_start

    if len(ranges) >= 2:
        last_start, last_end = ranges[-1]
        prev_start, _ = ranges[-2]
        tail_words = sum(s.words for s in sentences[last_start:last_end])
        merged_words = sum(s.words for s in sentences[prev_start:last_end])
        if tail_words < min_words and merged_words <= int(max_words * 1.2):
            ranges[-2:] = [(prev_start, last_end)]
    return ranges


def chunk_blocks(
    blocks: list[Block],
    min_words: int = MIN_CHUNK_WORDS,
    max_words: int = MAX_CHUNK_WORDS,
    overlap_sentences: int = OVERLAP_SENTENCES,
) -> list[Chunk]:
    """Sentence-aligned chunks that never cross chapter boundaries.

    Chunks target ``min_words``..``max_words``; a short trailing chunk is merged into its
    predecessor when the result stays within 120% of ``max_words``. Short chapters yield a single
    chunk even if below ``min_words`` (merging across chapters would corrupt citations).
    """
    if min_words <= 0 or max_words < min_words or overlap_sentences < 0:
        raise ValueError("Invalid chunking parameters")
    chunks: list[Chunk] = []
    for heading, sentences in _sections(blocks, max_words):
        for start, end in _pack(sentences, min_words, max_words, overlap_sentences):
            group = sentences[start:end]
            content = " ".join(s.text for s in group).strip()
            if not content:
                continue
            chunks.append(
                Chunk(
                    chunk_index=len(chunks),
                    chapter_title=heading,
                    content=content,
                    page_start=min(s.page for s in group),
                    page_end=max(s.page for s in group),
                )
            )
    return chunks
