import io
import json
import sys
import time
import zipfile
from pathlib import Path

import httpx
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402
from main import (  # noqa: E402
    EMBED_DIM,
    AuthError,
    RequestError,
    Settings,
    embed_texts,
    parse_embed,
    parse_ingest,
    run_ingestion,
    sign,
    to_pgvector,
    token_windows,
    verify,
)

SECRET = b"s" * 40
SETTINGS = Settings(
    shared_secret=SECRET,
    database_url="postgresql://unused",
    allowed_download_host="proj.supabase.co",
    allowed_callback_host="app.example.com",
)
BOOK_ID = "0b9f7c1e-1111-4222-8333-944455556666"


def _signed(body: str, secret: bytes = SECRET, ts: int | None = None) -> tuple[str, str, str]:
    ts = int(time.time()) if ts is None else ts
    return body, str(ts), sign(secret, ts, body.encode())


def _job(**overrides: object) -> str:
    payload = {
        "bookId": BOOK_ID,
        "downloadUrl": "https://proj.supabase.co/storage/v1/object/sign/books/x.epub?token=t",
        "callbackUrl": f"https://app.example.com/api/books/{BOOK_ID}/ingestion-complete",
        "mimeType": "application/epub+zip",
        "fileSizeBytes": 1000,
    }
    payload.update(overrides)
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# HMAC + request parsing
# ---------------------------------------------------------------------------


def test_signature_matches_typescript_scheme() -> None:
    # Same input as signPayload("k"*32, 1700000000, '{"a":1}') in src/lib/hmac.ts
    import hashlib
    import hmac as std_hmac

    expected = std_hmac.new(b"k" * 32, b'1700000000.{"a":1}', hashlib.sha256).hexdigest()
    assert sign(b"k" * 32, 1700000000, b'{"a":1}') == expected


def test_verify_rejects_stale_tampered_and_malformed() -> None:
    body, ts, sig = _signed('{"a":1}')
    verify(SECRET, body.encode(), ts, sig)
    verify(SECRET, body.encode(), ts, sig.upper())
    with pytest.raises(AuthError, match="Stale"):
        verify(SECRET, body.encode(), ts, sig, now=int(ts) + 301)
    with pytest.raises(AuthError, match="Invalid"):
        verify(SECRET, b'{"a":2}', ts, sig)
    with pytest.raises(AuthError, match="malformed"):
        verify(SECRET, body.encode(), "abc", sig)


def test_parse_ingest_accepts_valid_job() -> None:
    job = parse_ingest(SETTINGS, *_signed(_job()))
    assert job.bookId == BOOK_ID and job.mimeType == "application/epub+zip"


@pytest.mark.parametrize(
    "override",
    [
        {"downloadUrl": "https://evil.example.com/x.pdf"},
        {"downloadUrl": "http://proj.supabase.co/x.pdf"},
        {"callbackUrl": "https://evil.example.com/cb"},
        {"mimeType": "text/plain"},
        {"fileSizeBytes": 26 * 1024 * 1024},
        {"bookId": "not-a-uuid"},
    ],
)
def test_parse_ingest_rejects_bad_payloads(override: dict) -> None:
    with pytest.raises(RequestError):
        parse_ingest(SETTINGS, *_signed(_job(**override)))


def test_parse_rejects_wrong_secret_and_non_string_args() -> None:
    with pytest.raises(AuthError):
        parse_ingest(SETTINGS, *_signed(_job(), secret=b"x" * 40))
    with pytest.raises(AuthError):
        parse_embed(SETTINGS, {"texts": ["a"]}, "1", "f" * 64)


def test_parse_embed_limits() -> None:
    assert parse_embed(SETTINGS, *_signed('{"texts":["hello"]}')).texts == ["hello"]
    for bad in ('{"texts":[]}', '{"texts":["   "]}', json.dumps({"texts": ["a"] * 65})):
        with pytest.raises(RequestError):
            parse_embed(SETTINGS, *_signed(bad))


def test_load_settings_requires_long_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ML_SHARED_SECRET", "short")
    monkeypatch.setenv("DATABASE_URL", "postgresql://x")
    monkeypatch.setenv("SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("APP_BASE_URL", "https://app.example.com")
    with pytest.raises(RuntimeError, match="32"):
        main.load_settings()
    monkeypatch.setenv("ML_SHARED_SECRET", "x" * 32)
    loaded = main.load_settings()
    assert loaded.allowed_download_host == "proj.supabase.co"
    assert loaded.allowed_callback_host == "app.example.com"


# ---------------------------------------------------------------------------
# Embedding windows + pooling
# ---------------------------------------------------------------------------


class WordTokenizer:
    """One token per word; enough to exercise the windowing logic."""

    def encode(self, text: str, add_special_tokens: bool = True) -> list[int]:
        return [len(word) for word in text.split()]

    def decode(self, ids: list[int], skip_special_tokens: bool = True) -> str:
        return " ".join("w" * i for i in ids)


def fake_encode(windows: list[str]) -> np.ndarray:
    rng = np.random.default_rng(len(windows))
    vectors = rng.normal(size=(len(windows), EMBED_DIM)).astype(np.float32)
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def test_long_text_is_split_into_overlapping_windows() -> None:
    text = " ".join(["word"] * 600)
    windows = token_windows(WordTokenizer(), text)
    assert len(windows) == 3  # starts at 0, 192, 384; last covers the tail
    assert all(len(w.split()) <= 254 for w in windows)
    assert token_windows(WordTokenizer(), "short text") == ["short text"]


def test_embed_texts_pools_to_one_normalized_row_per_text() -> None:
    texts = ["short", " ".join(["word"] * 600), "also short"]
    vectors = embed_texts(WordTokenizer(), fake_encode, texts)
    assert vectors.shape == (3, EMBED_DIM) and vectors.dtype == np.float32
    np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), 1.0, rtol=1e-5)


def test_embed_texts_rejects_wrong_encoder_shape() -> None:
    with pytest.raises(ValueError, match="shape"):
        embed_texts(WordTokenizer(), lambda w: np.zeros((len(w), 10)), ["a"])


def test_to_pgvector_formats_and_validates() -> None:
    assert to_pgvector(np.zeros(EMBED_DIM, dtype=np.float32)).count(",") == EMBED_DIM - 1
    with pytest.raises(ValueError):
        to_pgvector(np.full(EMBED_DIM, np.nan))


# ---------------------------------------------------------------------------
# run_ingestion (fake HTTP, store and embedder)
# ---------------------------------------------------------------------------


def _epub_bytes() -> bytes:
    sentence = "The mitochondria converts nutrients into usable cellular energy every single day. "
    chapter = "<html><body><h1>Chapter One</h1><p>" + sentence * 40 + "</p></body></html>"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        )
        zf.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Cells</dc:title>'
            "<dc:creator>A. Author</dc:creator></metadata>"
            '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
            '<spine><itemref idref="c1"/></spine></package>',
        )
        zf.writestr("OEBPS/c1.xhtml", chapter)
    return buffer.getvalue()


class FakeStore:
    def __init__(self, still_processing: bool = True) -> None:
        self.still_processing = still_processing
        self.persisted: list[tuple] = []
        self.failed: list[tuple[str, str]] = []

    def persist_chunks(self, book_id, chunks, vectors, total_pages) -> bool:
        self.persisted.append((book_id, len(chunks), vectors.shape, total_pages))
        return self.still_processing

    def mark_failed(self, book_id: str, message: str) -> None:
        self.failed.append((book_id, message))


def _client(file_response: httpx.Response, callbacks: list) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "proj.supabase.co":
            return file_response
        callbacks.append(request)
        return httpx.Response(200, json={"received": True})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _embed(texts: list[str]) -> np.ndarray:
    return embed_texts(WordTokenizer(), fake_encode, texts)


def test_run_ingestion_success_persists_and_sends_signed_callback() -> None:
    callbacks: list[httpx.Request] = []
    store = FakeStore()
    job = parse_ingest(SETTINGS, *_signed(_job()))
    result = run_ingestion(
        job, SETTINGS, client=_client(httpx.Response(200, content=_epub_bytes()), callbacks), store=store, embed=_embed
    )
    assert result["status"] == "indexed" and result["chunkCount"] >= 1
    assert result["title"] == "Cells" and result["author"] == "A. Author"
    assert store.persisted and store.persisted[0][2] == (result["chunkCount"], EMBED_DIM)
    assert len(callbacks) == 1
    sent = callbacks[0]
    verify(SECRET, sent.content, sent.headers["x-bookmentor-timestamp"], sent.headers["x-bookmentor-signature"])
    assert json.loads(sent.content) == result


def test_run_ingestion_failure_marks_failed_and_calls_back() -> None:
    callbacks: list[httpx.Request] = []
    store = FakeStore()
    job = parse_ingest(SETTINGS, *_signed(_job()))
    result = run_ingestion(job, SETTINGS, client=_client(httpx.Response(404), callbacks), store=store, embed=_embed)
    assert result["status"] == "failed" and "HTTP 404" in result["error"]
    assert store.failed == [(BOOK_ID, result["error"])] and not store.persisted
    assert len(callbacks) == 1


def test_network_error_during_download_is_a_clean_failure() -> None:
    callbacks: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "proj.supabase.co":
            raise httpx.ConnectError("getaddrinfo failed")
        callbacks.append(request)
        return httpx.Response(200)

    job = parse_ingest(SETTINGS, *_signed(_job()))
    result = run_ingestion(
        job, SETTINGS, client=httpx.Client(transport=httpx.MockTransport(handler)), store=FakeStore(), embed=_embed
    )
    assert result == {"bookId": BOOK_ID, "status": "failed", "error": "Could not download the uploaded file. Please try again."}
    assert len(callbacks) == 1


def test_run_ingestion_unexpected_error_is_contained() -> None:
    callbacks: list[httpx.Request] = []
    store = FakeStore()
    job = parse_ingest(SETTINGS, *_signed(_job()))

    def broken(_texts: list[str]) -> np.ndarray:
        raise RuntimeError("CUDA out of memory")

    result = run_ingestion(
        job, SETTINGS, client=_client(httpx.Response(200, content=_epub_bytes()), callbacks), store=store, embed=broken
    )
    assert result["status"] == "failed" and "CUDA" not in result["error"]
    assert len(callbacks) == 1


def test_run_ingestion_discards_when_book_no_longer_processing() -> None:
    callbacks: list[httpx.Request] = []
    job = parse_ingest(SETTINGS, *_signed(_job()))
    result = run_ingestion(
        job,
        SETTINGS,
        client=_client(httpx.Response(200, content=_epub_bytes()), callbacks),
        store=FakeStore(still_processing=False),
        embed=_embed,
    )
    assert result["status"] == "discarded" and not callbacks


def test_download_cap_enforced_from_content_length() -> None:
    callbacks: list[httpx.Request] = []
    store = FakeStore()
    job = parse_ingest(SETTINGS, *_signed(_job()))
    big = httpx.Response(200, headers={"content-length": str(30 * 1024 * 1024)}, content=b"x")
    result = run_ingestion(job, SETTINGS, client=_client(big, callbacks), store=store, embed=_embed)
    assert result["status"] == "failed" and "25 MB" in result["error"]


def test_callback_retries_on_5xx_then_gives_up() -> None:
    attempts: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        return httpx.Response(503)

    delays: list[float] = []
    ok = main.send_callback(
        httpx.Client(transport=httpx.MockTransport(handler)), SECRET, "https://app.example.com/cb", {"bookId": "x"},
        sleep=delays.append,
    )
    assert not ok and len(attempts) == 5 and delays == [1, 2, 4, 8, 16]
