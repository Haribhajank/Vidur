---
title: BookMentor ML
emoji: 📚
colorFrom: indigo
colorTo: blue
sdk: gradio
sdk_version: 6.29.0
app_file: app.py
pinned: false
---

# BookMentor ML ingestion service

A Gradio API for a free Hugging Face **ZeroGPU** Space. It extracts PDF and EPUB text, chunks it into 200–500 words, embeds the chunks with `all-MiniLM-L6-v2` (384 dimensions), and writes them to Supabase Postgres with pgvector. When it finishes, it sends a signed callback so the web app can auto-purge the raw file.

Only bulk chunk embedding runs on the GPU (`@spaces.GPU` in `app.py`). Downloading, parsing, database writes and query embeddings run on the Space CPU and use no GPU quota.

- `main.py`: framework-agnostic core (HMAC, validation, windowed embedding, Postgres, callback)
- `app.py`: the Gradio/ZeroGPU wiring
- `pipeline.py`: text extraction and chunking

## Deploying

1. Create a Space with **SDK: Gradio** and **Hardware: ZeroGPU**. Hosting a ZeroGPU Space needs a Hugging Face PRO (or Team/Enterprise) account. Without one, set the hardware to *CPU basic*: the same code runs unchanged on CPU, just slower.
2. Push the contents of `backend_ml/` (not the whole repo) to the Space's git repo, for example:
   ```bash
   git subtree split --prefix backend_ml -b space
   git push https://huggingface.co/spaces/<user>/bookmentor-ml space:main --force
   ```
3. Add the secrets below under *Settings → Variables and secrets*.

## Space secrets

| Name | Value |
|---|---|
| `ML_SHARED_SECRET` | Same value as the web app's `ML_SHARED_SECRET` (≥ 32 chars) |
| `DATABASE_URL` | Supabase **direct or session-pooler** connection string (`postgresql://…:5432/postgres?sslmode=require`) |
| `SUPABASE_URL` | `https://<project>.supabase.co`. Signed download URLs are only accepted from this host. |
| `APP_BASE_URL` | `https://<your-app>.vercel.app`. Callbacks are only sent to this host. |

Optional: `EMBEDDING_MODEL` (must produce 384-d vectors) and `EMBED_BATCH` (default 64).

## API

Every endpoint takes the Gradio inputs `[body, timestamp, signature]`, where `body` is a JSON string and `signature = hex(HMAC_SHA256(secret, "{timestamp}.{body}"))` (the same scheme as `src/lib/hmac.ts`). Requests whose timestamp is more than 300 s from the server clock are rejected.

```
POST /gradio_api/call/<name>   {"data": [body, timestamp, signature]}  →  {"event_id": "…"}
GET  /gradio_api/call/<name>/<event_id>                                 →  SSE: generating | complete | error
```

| Name | Body | Result |
|---|---|---|
| `ingest` | `{bookId, downloadUrl, callbackUrl, mimeType, fileSizeBytes}` | Emits `generating` with `{accepted: true, bookId}` once authenticated. The job continues after the caller disconnects, and the outcome is delivered via the signed callback. |
| `embed` | `{texts: [...]}` (1–64, ≤ 4000 chars each) | `{embeddings: [[…384 floats]]}` |
| `health` | none (call with `"data": []`) | `{ok, model, dim, zeroGpu}` |

Authentication and validation failures return an `error` event with the reason. If the Space is private, send `Authorization: Bearer <hf token>` (the web app does this when `ML_SERVICE_TOKEN` is set).

## Local testing

```bash
bash ../scripts/py-env.sh            # creates .venv with the test deps (no torch needed)
.venv/Scripts/python -m pytest -q tests
```
