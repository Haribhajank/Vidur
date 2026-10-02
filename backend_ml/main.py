"""BookMentor AI: ingestion & embedding core (framework-agnostic, synchronous).

`app.py` exposes this as a Gradio app on a free ZeroGPU Space. Only bulk chunk embedding uses
the GPU (wrapped with `@spaces.GPU` in app.py); download, parsing, chunking, database writes and
single-query embeddings run on the Space's CPU and consume no GPU quota.

Ingestion flow (`run_ingestion`):
  1. Download the raw upload via a short-lived signed Supabase URL (streamed, 25 MB hard cap).
  2. Extract layout-aware text (PDF: pdfplumber/pypdf, EPUB: OPF spine) and chunk 200-500 words.
  3. Embed with all-MiniLM-L6-v2 (384-d). Chunks longer than the model's 256-token window are
     embedded as overlapping token windows and mean-pooled, so no text is silently truncated.
  4. In ONE Postgres transaction: replace the book's chunks and mark it `indexed`.
  5. Fire the signed completion callback; the Next.js app then auto-purges the raw file.
Any failure marks the book `failed`, and that callback triggers the raw-file purge as well.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Annotated, Any, Callable, Literal, Protocol, Sequence
from urllib.parse import urlparse

import httpx
import numpy as np
from pydantic import BaseModel, Field, HttpUrl, ValidationError, field_validator

from pipeline import Chunk, ExtractionError, chunk_blocks, extract_document

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
EMBED_DIM = 384
MAX_SEQ_TOKENS = 256
WINDOW_STRIDE_TOKENS = 192
SIGNATURE_MAX_SKEW_S = 300
INSERT_BATCH = 200

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("bookmentor.ml")


# ---------------------------------------------------------------------------
# Settings (loaded explicitly so the module imports cleanly in tests)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Settings:
    shared_secret: bytes
    database_url: str
    allowed_download_host: str
    allowed_callback_host: str
    model_name: str = "sentence-transformers/all-MiniLM-L6-v2"
    embed_batch: int = 64


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required Space secret: {name}")
    return value


def load_settings() -> Settings:
    secret = _require_env("ML_SHARED_SECRET").encode()
    if len(secret) < 32:
        raise RuntimeError("ML_SHARED_SECRET must be at least 32 characters")
    download_host = urlparse(_require_env("SUPABASE_URL")).hostname
    callback_host = urlparse(_require_env("APP_BASE_URL")).hostname
    if not download_host or not callback_host:
        raise RuntimeError("SUPABASE_URL and APP_BASE_URL must be absolute URLs")
    return Settings(
        shared_secret=secret,
        database_url=_require_env("DATABASE_URL"),
        allowed_download_host=download_host,
        allowed_callback_host=callback_host,
        model_name=os.environ.get("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
        embed_batch=int(os.environ.get("EMBED_BATCH", "64")),
    )


# ---------------------------------------------------------------------------
# HMAC (identical scheme to src/lib/hmac.ts: hex(HMAC-SHA256(secret, f"{ts}.{body}")))
# ---------------------------------------------------------------------------


class AuthError(Exception):
    """Signature missing, malformed, stale or invalid."""


def sign(secret: bytes, timestamp: int, body: bytes) -> str:
    return hmac.new(secret, f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()


def signed_headers(secret: bytes, body: bytes) -> dict[str, str]:
    ts = int(time.time())
    return {
        "content-type": "application/json",
        "x-bookmentor-timestamp": str(ts),
        "x-bookmentor-signature": sign(secret, ts, body),
    }


def verify(secret: bytes, body: bytes, timestamp: str | None, signature: str | None, now: float | None = None) -> None:
    if not timestamp or not signature or not timestamp.isdigit() or len(signature) != 64:
        raise AuthError("Missing or malformed signature")
    current = time.time() if now is None else now
    if abs(int(current) - int(timestamp)) > SIGNATURE_MAX_SKEW_S:
        raise AuthError("Stale signature")
    if not hmac.compare_digest(sign(secret, int(timestamp), body), signature.lower()):
        raise AuthError("Invalid signature")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class RequestError(Exception):
    """Authenticated request whose payload is invalid."""


class IngestRequest(BaseModel):
    bookId: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    downloadUrl: HttpUrl
    callbackUrl: HttpUrl
    mimeType: Literal["application/pdf", "application/epub+zip"]
    fileSizeBytes: int = Field(gt=0, le=MAX_UPLOAD_BYTES)


class EmbedRequest(BaseModel):
    texts: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(min_length=1, max_length=64)

    @field_validator("texts")
    @classmethod
    def _not_blank(cls, value: list[str]) -> list[str]:
        if any(not text.strip() for text in value):
            raise ValueError("texts must not be blank")
        return value


def _authenticated_body(settings: Settings, body: Any, timestamp: Any, signature: Any, limit: int) -> bytes:
    """Gradio does not enforce argument types, so every argument is checked here."""
    if not isinstance(body, str) or not isinstance(timestamp, str) or not isinstance(signature, str):
        raise AuthError("Missing or malformed signature")
    raw = body.encode()
    if len(raw) > limit:
        raise RequestError("Body too large")
    verify(settings.shared_secret, raw, timestamp, signature)
    return raw


def parse_ingest(settings: Settings, body: Any, timestamp: Any, signature: Any) -> IngestRequest:
    raw = _authenticated_body(settings, body, timestamp, signature, 8192)
    try:
        job = IngestRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise RequestError(str(exc)[:500]) from exc
    if job.downloadUrl.scheme != "https" or job.downloadUrl.host != settings.allowed_download_host:
        raise RequestError("downloadUrl must be an https URL on the configured Supabase host")
    if job.callbackUrl.host != settings.allowed_callback_host:
        raise RequestError("callbackUrl must target the configured app host")
    return job


def parse_embed(settings: Settings, body: Any, timestamp: Any, signature: Any) -> EmbedRequest:
    raw = _authenticated_body(settings, body, timestamp, signature, 300_000)
    try:
        return EmbedRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise RequestError(str(exc)[:500]) from exc


# ---------------------------------------------------------------------------
# Embedding (windowed mean-pooling for >256-token chunks)
# ---------------------------------------------------------------------------


class Tokenizer(Protocol):
    def encode(self, text: str, add_special_tokens: bool = ...) -> list[int]: ...

    def decode(self, ids: Sequence[int], skip_special_tokens: bool = ...) -> str: ...


# Encodes model-sized windows into an (n, 384) matrix. app.py supplies a CPU and a GPU variant.
EncodeFn = Callable[[list[str]], np.ndarray]


def token_windows(tokenizer: Tokenizer, text: str) -> list[str]:
    ids = tokenizer.encode(text, add_special_tokens=False)
    budget = MAX_SEQ_TOKENS - 2
    if len(ids) <= budget:
        return [text]
    windows = []
    for start in range(0, len(ids), WINDOW_STRIDE_TOKENS):
        windows.append(tokenizer.decode(ids[start : start + budget], skip_special_tokens=True))
        if start + budget >= len(ids):
            break
    return windows


def split_windows(tokenizer: Tokenizer, texts: Sequence[str]) -> tuple[list[str], list[int]]:
    """Flattens texts into windows; `owners[i]` is the index of the text window i came from."""
    flat: list[str] = []
    owners: list[int] = []
    for index, text in enumerate(texts):
        for window in token_windows(tokenizer, text):
            flat.append(window)
            owners.append(index)
    return flat, owners


def pool_windows(vectors: np.ndarray, owners: Sequence[int], count: int) -> np.ndarray:
    """Mean-pools window vectors per text and returns L2-normalized float32 rows."""
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.shape != (len(owners), EMBED_DIM):
        raise ValueError(f"Encoder returned shape {vectors.shape}; expected ({len(owners)}, {EMBED_DIM})")
    pooled = np.zeros((count, EMBED_DIM), dtype=np.float32)
    counts = np.zeros(count, dtype=np.float32)
    np.add.at(pooled, np.asarray(owners), vectors)
    np.add.at(counts, np.asarray(owners), 1.0)
    pooled /= np.maximum(counts, 1.0)[:, None]
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    return pooled / np.maximum(norms, 1e-12)


def embed_texts(tokenizer: Tokenizer, encode: EncodeFn, texts: Sequence[str]) -> np.ndarray:
    flat, owners = split_windows(tokenizer, texts)
    return pool_windows(encode(flat), owners, len(texts))


def to_pgvector(vector: np.ndarray) -> str:
    if vector.shape != (EMBED_DIM,) or not np.all(np.isfinite(vector)):
        raise ValueError("Embedding has the wrong shape or contains non-finite values")
    return "[" + ",".join(f"{v:.6f}" for v in vector.tolist()) + "]"


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


class IngestionFailure(Exception):
    """A user-presentable ingestion error (stored in books.ingest_error)."""


def download_capped(client: httpx.Client, url: str) -> bytes:
    """Streams the file, aborting as soon as the 25 MB cap is exceeded."""
    buffer = bytearray()
    try:
        with client.stream("GET", url, timeout=httpx.Timeout(60.0, connect=10.0)) as response:
            if response.status_code != 200:
                raise IngestionFailure(f"Could not download the uploaded file (HTTP {response.status_code})")
            declared = response.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
                raise IngestionFailure("File exceeds the 25 MB limit")
            for part in response.iter_bytes(64 * 1024):
                buffer.extend(part)
                if len(buffer) > MAX_UPLOAD_BYTES:
                    raise IngestionFailure("File exceeds the 25 MB limit")
    except httpx.HTTPError as exc:
        log.warning("download failed: %s", exc)
        raise IngestionFailure("Could not download the uploaded file. Please try again.") from exc
    if not buffer:
        raise IngestionFailure("Uploaded file is empty")
    return bytes(buffer)


class ChunkStore(Protocol):
    def persist_chunks(self, book_id: str, chunks: list[Chunk], vectors: np.ndarray, total_pages: int) -> bool: ...

    def mark_failed(self, book_id: str, message: str) -> None: ...


class PostgresStore:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    def persist_chunks(self, book_id: str, chunks: list[Chunk], vectors: np.ndarray, total_pages: int) -> bool:
        """Replaces the book's chunks and marks it indexed in ONE transaction.

        Returns False (writing nothing) if the book was deleted or is no longer `processing`,
        which makes the job safe against concurrent user deletion.
        """
        import psycopg

        rows = [
            (book_id, c.chunk_index, c.chapter_title, c.content, c.word_count, c.page_start, c.page_end, to_pgvector(v))
            for c, v in zip(chunks, vectors, strict=True)
        ]
        with psycopg.connect(self.database_url, autocommit=False, connect_timeout=15) as conn:
            with conn.cursor() as cur:
                cur.execute("SET LOCAL statement_timeout = '120s'")
                cur.execute("SELECT status FROM public.books WHERE id = %s FOR UPDATE", (book_id,))
                row = cur.fetchone()
                if row is None or row[0] != "processing":
                    conn.rollback()
                    return False
                cur.execute("DELETE FROM public.book_chunks WHERE book_id = %s", (book_id,))
                for start in range(0, len(rows), INSERT_BATCH):
                    cur.executemany(
                        "INSERT INTO public.book_chunks "
                        "(book_id, chunk_index, chapter_title, content, word_count, page_start, page_end, embedding) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)",
                        rows[start : start + INSERT_BATCH],
                    )
                cur.execute(
                    "UPDATE public.books SET status = 'indexed', chunk_count = %s, total_pages = %s, "
                    "ingest_error = NULL WHERE id = %s",
                    (len(rows), total_pages, book_id),
                )
            conn.commit()
        return True

    def mark_failed(self, book_id: str, message: str) -> None:
        import psycopg

        try:
            with psycopg.connect(self.database_url, autocommit=True, connect_timeout=15) as conn:
                conn.execute(
                    "UPDATE public.books SET status = 'failed', ingest_error = %s "
                    "WHERE id = %s AND status = 'processing'",
                    (message[:2000], book_id),
                )
        except psycopg.Error:
            log.exception("could not mark book %s as failed", book_id)


def send_callback(
    client: httpx.Client,
    secret: bytes,
    url: str,
    payload: dict[str, Any],
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """Signed callback with exponential backoff. Returns True once the app has answered."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    for attempt in range(5):
        try:
            response = client.post(url, content=body, headers=signed_headers(secret, body), timeout=30.0)
            if response.status_code < 500 and response.status_code != 429:
                if response.status_code >= 400:
                    log.warning("callback rejected status=%s body=%s", response.status_code, response.text[:300])
                return True
        except httpx.HTTPError as exc:
            log.warning("callback attempt %s failed: %s", attempt + 1, exc)
        sleep(2**attempt)
    log.error("callback permanently failed for %s", payload.get("bookId"))
    return False


# ---------------------------------------------------------------------------
# Job runner
# ---------------------------------------------------------------------------


def run_ingestion(
    job: IngestRequest,
    settings: Settings,
    *,
    client: httpx.Client,
    store: ChunkStore,
    embed: Callable[[list[str]], np.ndarray],
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Never raises: every outcome ends in DB state + a signed callback (raw file purge trigger).

    `embed` maps chunk texts to pooled, normalized vectors (the GPU path in app.py).
    Returns the callback payload, or a `discarded` status if the book is no longer processing.
    """
    book_id = job.bookId
    callback_url = str(job.callbackUrl)
    started = time.monotonic()
    try:
        data = download_capped(client, str(job.downloadUrl))
        document = extract_document(data, job.mimeType)
        del data
        chunks = chunk_blocks(document.blocks)
        if not chunks:
            raise IngestionFailure("No text could be chunked from this document")
        vectors = embed([c.content for c in chunks])
        if not store.persist_chunks(book_id, chunks, vectors, document.total_pages):
            log.info("book %s no longer processing (deleted?); results discarded", book_id)
            return {"bookId": book_id, "status": "discarded"}
        log.info(
            "indexed book=%s chunks=%s pages=%s in %.1fs",
            book_id, len(chunks), document.total_pages, time.monotonic() - started,
        )
        payload: dict[str, Any] = {
            "bookId": book_id,
            "status": "indexed",
            "chunkCount": len(chunks),
            "totalPages": document.total_pages,
            "title": document.title[:300] if document.title else None,
            "author": document.author[:300] if document.author else None,
        }
    except (IngestionFailure, ExtractionError) as exc:
        payload = _fail(store, book_id, str(exc))
    except Exception:  # noqa: BLE001 - last-resort boundary for the job
        log.exception("unexpected ingestion failure for %s", book_id)
        payload = _fail(store, book_id, "Unexpected processing error. Please try uploading again.")
    send_callback(client, settings.shared_secret, callback_url, payload, sleep=sleep)
    return payload


def _fail(store: ChunkStore, book_id: str, message: str) -> dict[str, Any]:
    log.warning("ingestion failed book=%s: %s", book_id, message)
    store.mark_failed(book_id, message)
    return {"bookId": book_id, "status": "failed", "error": message[:2000]}


def embeddings_payload(vectors: np.ndarray) -> dict[str, Any]:
    return {"embeddings": [[round(float(x), 6) for x in row] for row in vectors]}
