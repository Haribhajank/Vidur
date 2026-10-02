"""BookMentor AI — ingestion & embedding service (FastAPI on a Hugging Face CPU Space).

Flow for POST /ingest (HMAC-signed, answers 202 immediately):
  1. Download the raw upload via a short-lived signed Supabase URL (streamed, 25 MB hard cap).
  2. Extract layout-aware text (PDF: pdfplumber/pypdf, EPUB: OPF spine) and chunk 200-500 words.
  3. Embed with all-MiniLM-L6-v2 (384-d). Chunks longer than the model's 256-token window are
     embedded as overlapping token windows and mean-pooled, so no text is silently truncated.
  4. In ONE Postgres transaction: replace the book's chunks and mark it `indexed`.
  5. Fire the signed completion callback; the Next.js app then auto-purges the raw file.
Any failure marks the book `failed` and the callback triggers raw-file purge as well.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator, Literal
from urllib.parse import urlparse

import httpx
import numpy as np
import psycopg
from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, HttpUrl, field_validator

from pipeline import Chunk, ExtractionError, chunk_blocks, extract_document

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
EMBED_DIM = 384
EMBED_BATCH = int(os.environ.get("EMBED_BATCH", "32"))
MAX_SEQ_TOKENS = 256
WINDOW_STRIDE_TOKENS = 192
SIGNATURE_MAX_SKEW_S = 300
MAX_CONCURRENT_JOBS = int(os.environ.get("MAX_CONCURRENT_JOBS", "1"))
INSERT_BATCH = 200


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


SHARED_SECRET = _require_env("ML_SHARED_SECRET").encode()
DATABASE_URL = _require_env("DATABASE_URL")
ALLOWED_DOWNLOAD_HOST = urlparse(_require_env("SUPABASE_URL")).hostname
ALLOWED_CALLBACK_HOST = urlparse(_require_env("APP_BASE_URL")).hostname
if len(SHARED_SECRET) < 32:
    raise RuntimeError("ML_SHARED_SECRET must be at least 32 characters")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("bookmentor.ml")

# ---------------------------------------------------------------------------
# HMAC (identical scheme to src/lib/hmac.ts: hex(HMAC-SHA256(secret, f"{ts}.{body}")))
# ---------------------------------------------------------------------------


def sign(timestamp: int, body: bytes) -> str:
    return hmac.new(SHARED_SECRET, f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()


def signed_headers(body: bytes) -> dict[str, str]:
    ts = int(time.time())
    return {
        "content-type": "application/json",
        "x-bookmentor-timestamp": str(ts),
        "x-bookmentor-signature": sign(ts, body),
    }


def verify(body: bytes, timestamp: str | None, signature: str | None) -> None:
    if not timestamp or not signature or not timestamp.isdigit() or len(signature) != 64:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing or malformed signature")
    if abs(int(time.time()) - int(timestamp)) > SIGNATURE_MAX_SKEW_S:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Stale signature")
    if not hmac.compare_digest(sign(int(timestamp), body), signature):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid signature")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class IngestRequest(BaseModel):
    bookId: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    downloadUrl: HttpUrl
    callbackUrl: HttpUrl
    mimeType: Literal["application/pdf", "application/epub+zip"]
    fileSizeBytes: int = Field(gt=0, le=MAX_UPLOAD_BYTES)

    @field_validator("downloadUrl")
    @classmethod
    def _download_host(cls, value: HttpUrl) -> HttpUrl:
        if value.scheme != "https" or value.host != ALLOWED_DOWNLOAD_HOST:
            raise ValueError("downloadUrl must be an https URL on the configured Supabase host")
        return value

    @field_validator("callbackUrl")
    @classmethod
    def _callback_host(cls, value: HttpUrl) -> HttpUrl:
        if value.host != ALLOWED_CALLBACK_HOST:
            raise ValueError("callbackUrl must target the configured app host")
        return value


class EmbedRequest(BaseModel):
    texts: list[Annotated[str, Field(min_length=1, max_length=4000)]] = Field(min_length=1, max_length=64)


# ---------------------------------------------------------------------------
# Embedding (windowed mean-pooling for >256-token chunks)
# ---------------------------------------------------------------------------


class Embedder:
    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer

        self.model = SentenceTransformer(MODEL_NAME, device="cpu")
        self.model.max_seq_length = MAX_SEQ_TOKENS
        self.tokenizer = self.model.tokenizer
        dim = self.model.get_sentence_embedding_dimension()
        if dim != EMBED_DIM:
            raise RuntimeError(f"Model produces {dim}-d vectors; schema expects {EMBED_DIM}")

    def _windows(self, text: str) -> list[str]:
        ids: list[int] = self.tokenizer.encode(text, add_special_tokens=False)
        budget = MAX_SEQ_TOKENS - 2
        if len(ids) <= budget:
            return [text]
        windows = []
        for start in range(0, len(ids), WINDOW_STRIDE_TOKENS):
            piece = ids[start : start + budget]
            windows.append(self.tokenizer.decode(piece, skip_special_tokens=True))
            if start + budget >= len(ids):
                break
        return windows

    def embed(self, texts: list[str]) -> np.ndarray:
        """Returns an (n, 384) float32 matrix of L2-normalized vectors."""
        flat: list[str] = []
        owners: list[int] = []
        for index, text in enumerate(texts):
            for window in self._windows(text):
                flat.append(window)
                owners.append(index)
        vectors = self.model.encode(
            flat, batch_size=EMBED_BATCH, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False
        ).astype(np.float32)
        pooled = np.zeros((len(texts), EMBED_DIM), dtype=np.float32)
        counts = np.zeros(len(texts), dtype=np.float32)
        np.add.at(pooled, np.asarray(owners), vectors)
        np.add.at(counts, np.asarray(owners), 1.0)
        pooled /= np.maximum(counts, 1.0)[:, None]
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        return pooled / np.maximum(norms, 1e-12)


def to_pgvector(vector: np.ndarray) -> str:
    if vector.shape != (EMBED_DIM,) or not np.all(np.isfinite(vector)):
        raise ValueError("Embedding has the wrong shape or contains non-finite values")
    return "[" + ",".join(f"{v:.6f}" for v in vector.tolist()) + "]"


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


class IngestionFailure(Exception):
    """A user-presentable ingestion error (stored in books.ingest_error)."""


async def download_capped(client: httpx.AsyncClient, url: str) -> bytes:
    """Streams the file, aborting as soon as the 25 MB cap is exceeded."""
    buffer = bytearray()
    async with client.stream("GET", url, timeout=httpx.Timeout(60.0, connect=10.0)) as response:
        if response.status_code != 200:
            raise IngestionFailure(f"Could not download the uploaded file (HTTP {response.status_code})")
        declared = response.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
            raise IngestionFailure("File exceeds the 25 MB limit")
        async for part in response.aiter_bytes(64 * 1024):
            buffer.extend(part)
            if len(buffer) > MAX_UPLOAD_BYTES:
                raise IngestionFailure("File exceeds the 25 MB limit")
    if not buffer:
        raise IngestionFailure("Uploaded file is empty")
    return bytes(buffer)


def persist_chunks(book_id: str, chunks: list[Chunk], vectors: np.ndarray, total_pages: int) -> bool:
    """Replaces the book's chunks and marks it indexed in ONE transaction.

    Returns False (writing nothing) if the book was deleted or is no longer `processing`,
    which makes the job safe against concurrent user deletion.
    """
    rows = [
        (book_id, c.chunk_index, c.chapter_title, c.content, c.word_count, c.page_start, c.page_end, to_pgvector(v))
        for c, v in zip(chunks, vectors, strict=True)
    ]
    with psycopg.connect(DATABASE_URL, autocommit=False, connect_timeout=15) as conn:
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
                "UPDATE public.books SET status = 'indexed', chunk_count = %s, total_pages = %s, ingest_error = NULL "
                "WHERE id = %s",
                (len(rows), total_pages, book_id),
            )
        conn.commit()
    return True


def mark_failed(book_id: str, message: str) -> None:
    try:
        with psycopg.connect(DATABASE_URL, autocommit=True, connect_timeout=15) as conn:
            conn.execute(
                "UPDATE public.books SET status = 'failed', ingest_error = %s WHERE id = %s AND status = 'processing'",
                (message[:2000], book_id),
            )
    except psycopg.Error:
        log.exception("could not mark book %s as failed", book_id)


async def send_callback(client: httpx.AsyncClient, url: str, payload: dict[str, Any]) -> None:
    """Signed callback with exponential backoff; the cron reconciles if every attempt fails."""
    body = json.dumps(payload, separators=(",", ":")).encode()
    for attempt in range(5):
        try:
            response = await client.post(url, content=body, headers=signed_headers(body), timeout=30.0)
            if response.status_code < 500 and response.status_code != 429:
                if response.status_code >= 400:
                    log.warning("callback rejected status=%s body=%s", response.status_code, response.text[:300])
                return
        except httpx.HTTPError as exc:
            log.warning("callback attempt %s failed: %s", attempt + 1, exc)
        await asyncio.sleep(2**attempt)
    log.error("callback permanently failed for %s", payload.get("bookId"))


# ---------------------------------------------------------------------------
# Job runner
# ---------------------------------------------------------------------------


async def run_ingestion(app: FastAPI, job: IngestRequest) -> None:
    """Never raises: every outcome ends in DB state + a signed callback (raw file purge trigger)."""
    book_id = job.bookId
    client: httpx.AsyncClient = app.state.http
    semaphore: asyncio.Semaphore = app.state.jobs
    started = time.monotonic()
    async with semaphore:
        try:
            data = await download_capped(client, str(job.downloadUrl))
            document = await asyncio.to_thread(extract_document, data, job.mimeType)
            del data
            chunks = await asyncio.to_thread(chunk_blocks, document.blocks)
            if not chunks:
                raise IngestionFailure("No text could be chunked from this document")
            embedder: Embedder = app.state.embedder
            vectors = await asyncio.to_thread(embedder.embed, [c.content for c in chunks])
            written = await asyncio.to_thread(persist_chunks, book_id, chunks, vectors, document.total_pages)
            if not written:
                log.info("book %s no longer processing (deleted?); results discarded", book_id)
                return
            log.info(
                "indexed book=%s chunks=%s pages=%s in %.1fs",
                book_id, len(chunks), document.total_pages, time.monotonic() - started,
            )
            await send_callback(
                client,
                str(job.callbackUrl),
                {
                    "bookId": book_id,
                    "status": "indexed",
                    "chunkCount": len(chunks),
                    "totalPages": document.total_pages,
                    "title": document.title[:300] if document.title else None,
                    "author": document.author[:300] if document.author else None,
                },
            )
        except (IngestionFailure, ExtractionError) as exc:
            await _fail(client, job, str(exc))
        except Exception:  # noqa: BLE001 - last-resort boundary for the background task
            log.exception("unexpected ingestion failure for %s", book_id)
            await _fail(client, job, "Unexpected processing error. Please try uploading again.")


async def _fail(client: httpx.AsyncClient, job: IngestRequest, message: str) -> None:
    log.warning("ingestion failed book=%s: %s", job.bookId, message)
    await asyncio.to_thread(mark_failed, job.bookId, message)
    await send_callback(client, str(job.callbackUrl), {"bookId": job.bookId, "status": "failed", "error": message[:2000]})


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.embedder = await asyncio.to_thread(Embedder)
    app.state.http = httpx.AsyncClient(follow_redirects=False, headers={"user-agent": "bookmentor-ml/1.0"})
    app.state.jobs = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
    app.state.tasks = set()
    log.info("model %s loaded", MODEL_NAME)
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(title="BookMentor ML", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.exception_handler(Exception)
async def unhandled(_request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error: %s", exc)
    return JSONResponse({"error": {"code": "INTERNAL", "message": "Internal server error"}}, status_code=500)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "model": MODEL_NAME, "dim": EMBED_DIM, "activeJobs": len(app.state.tasks)}


async def _signed_body(request: Request, timestamp: str | None, signature: str | None, limit: int) -> bytes:
    body = await request.body()
    if len(body) > limit:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Body too large")
    verify(body, timestamp, signature)
    return body


@app.post("/ingest", status_code=status.HTTP_202_ACCEPTED)
async def ingest(
    request: Request,
    x_bookmentor_timestamp: Annotated[str | None, Header()] = None,
    x_bookmentor_signature: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    body = await _signed_body(request, x_bookmentor_timestamp, x_bookmentor_signature, 8192)
    try:
        job = IngestRequest.model_validate_json(body)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)[:500]) from exc
    task = asyncio.create_task(run_ingestion(app, job))
    app.state.tasks.add(task)
    task.add_done_callback(app.state.tasks.discard)
    return {"accepted": True, "bookId": job.bookId}


@app.post("/embed")
async def embed(
    request: Request,
    x_bookmentor_timestamp: Annotated[str | None, Header()] = None,
    x_bookmentor_signature: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    body = await _signed_body(request, x_bookmentor_timestamp, x_bookmentor_signature, 300_000)
    try:
        payload = EmbedRequest.model_validate_json(body)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)[:500]) from exc
    embedder: Embedder = app.state.embedder
    vectors = await asyncio.to_thread(embedder.embed, payload.texts)
    return {"embeddings": [[round(float(x), 6) for x in row] for row in vectors]}
