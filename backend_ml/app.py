"""BookMentor AI ML Space: Gradio API over main.py, built for a free ZeroGPU Space.

API (called by the Next.js app via Gradio's HTTP API, see src/lib/mlClient.ts):
  POST /gradio_api/call/<name>  {"data": [body, timestamp, signature]}  -> {"event_id": ...}
  GET  /gradio_api/call/<name>/<event_id>                                -> SSE result stream
where `body` is a JSON string and `signature = hex(HMAC_SHA256(secret, f"{timestamp}.{body}"))`.

  ingest  generator: emits a `generating` event once the job is authenticated and accepted, then
          keeps running even if the caller disconnects; the outcome arrives via the signed callback.
  embed   returns {"embeddings": [[...384 floats]]} for query text (CPU, no GPU quota).
  health  returns {"ok": true, ...}; also useful to wake a sleeping Space.
"""

from __future__ import annotations

import spaces  # noqa: I001 - must be imported before torch on ZeroGPU

import logging
import os
from typing import Any, Iterator

import gradio as gr
import httpx
import numpy as np
from sentence_transformers import SentenceTransformer

from main import (
    EMBED_DIM,
    MAX_SEQ_TOKENS,
    AuthError,
    PostgresStore,
    RequestError,
    embed_texts,
    embeddings_payload,
    load_settings,
    parse_embed,
    parse_ingest,
    run_ingestion,
    split_windows,
    pool_windows,
)

log = logging.getLogger("bookmentor.ml")

settings = load_settings()
store = PostgresStore(settings.database_url)
http = httpx.Client(follow_redirects=False, headers={"user-agent": "bookmentor-ml/2.0"})

ON_ZERO_GPU = os.environ.get("SPACES_ZERO_GPU", "").lower() in {"1", "true"}


def _load(device: str) -> SentenceTransformer:
    model = SentenceTransformer(settings.model_name, device=device)
    model.max_seq_length = MAX_SEQ_TOKENS
    dim = model.get_sentence_embedding_dimension()
    if dim != EMBED_DIM:
        raise RuntimeError(f"Model produces {dim}-d vectors; schema expects {EMBED_DIM}")
    return model


# Queries run on a CPU copy so they never wait for (or spend) GPU quota. On ZeroGPU, moving the
# bulk model to "cuda" at import time is the supported pattern; the GPU is attached per call.
cpu_model = _load("cpu")
gpu_model = _load("cuda") if ON_ZERO_GPU else cpu_model
tokenizer = cpu_model.tokenizer


def _encode(model: SentenceTransformer, windows: list[str]) -> np.ndarray:
    return model.encode(
        windows,
        batch_size=settings.embed_batch,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    ).astype(np.float32)


def _gpu_seconds(windows: list[str]) -> int:
    # MiniLM on a ZeroGPU slice handles thousands of windows per second; reserve little so short
    # jobs are scheduled quickly, with headroom for the 25 MB worst case.
    return min(120, 20 + len(windows) // 500)


@spaces.GPU(duration=_gpu_seconds)
def encode_on_gpu(windows: list[str]) -> np.ndarray:
    return _encode(gpu_model, windows)


def embed_chunks(texts: list[str]) -> np.ndarray:
    windows, owners = split_windows(tokenizer, texts)
    if ON_ZERO_GPU:
        try:
            return pool_windows(encode_on_gpu(windows), owners, len(texts))
        except Exception:  # noqa: BLE001 - ZeroGPU allocation/worker failures must not fail the book
            log.exception("ZeroGPU encode failed for %s windows; falling back to CPU", len(windows))
    return pool_windows(_encode(cpu_model, windows), owners, len(texts))


def ingest(body: str, timestamp: str, signature: str) -> Iterator[dict[str, Any]]:
    try:
        job = parse_ingest(settings, body, timestamp, signature)
    except (AuthError, RequestError) as exc:
        raise gr.Error(str(exc), print_exception=False) from None
    yield {"accepted": True, "bookId": job.bookId}
    yield run_ingestion(job, settings, client=http, store=store, embed=embed_chunks)


def embed(body: str, timestamp: str, signature: str) -> dict[str, Any]:
    try:
        request = parse_embed(settings, body, timestamp, signature)
    except (AuthError, RequestError) as exc:
        raise gr.Error(str(exc), print_exception=False) from None
    vectors = embed_texts(tokenizer, lambda windows: _encode(cpu_model, windows), request.texts)
    return embeddings_payload(vectors)


def health() -> dict[str, Any]:
    return {"ok": True, "model": settings.model_name, "dim": EMBED_DIM, "zeroGpu": ON_ZERO_GPU}


with gr.Blocks(title="BookMentor ML") as demo:
    gr.Markdown("# BookMentor ML\nIngestion and embedding API for BookMentor AI. No UI; see the README.")
    gr.api(ingest, api_name="ingest", concurrency_limit=1)
    gr.api(embed, api_name="embed", concurrency_limit=4)
    gr.api(health, api_name="health")

demo.queue(max_size=32)

if __name__ == "__main__":
    log.info("model %s loaded (zeroGpu=%s)", settings.model_name, ON_ZERO_GPU)
    demo.launch()
