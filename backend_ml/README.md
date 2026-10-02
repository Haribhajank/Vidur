---
title: BookMentor ML
emoji: 📚
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# BookMentor ML ingestion service

FastAPI service for a free Hugging Face CPU Space. It extracts PDF and EPUB text, chunks it into 200–500 words, embeds the chunks with `all-MiniLM-L6-v2` (384 dimensions), and writes them to Supabase Postgres with pgvector. When it finishes, it sends a signed callback so the web app can auto-purge the raw file.

## Space secrets

| Name | Value |
|---|---|
| `ML_SHARED_SECRET` | Same value as the web app's `ML_SHARED_SECRET` (≥ 32 chars) |
| `DATABASE_URL` | Supabase **direct or session-pooler** connection string (`postgresql://…:5432/postgres?sslmode=require`) |
| `SUPABASE_URL` | `https://<project>.supabase.co`. Signed download URLs are only accepted from this host. |
| `APP_BASE_URL` | `https://<your-app>.vercel.app`. Callbacks are only sent to this host. |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness check; also wakes a sleeping Space |
| POST | `/ingest` | HMAC | Accepts a job and returns `202` immediately; processing runs in the background |
| POST | `/embed` | HMAC | Embeds query text for hybrid search |

HMAC scheme: `x-bookmentor-signature = hex(HMAC_SHA256(secret, "{timestamp}.{raw_body}"))`, sent with `x-bookmentor-timestamp`. Requests are rejected when the timestamp is more than 300 s from the server clock.

## Local testing

```bash
pip install -r requirements-dev.txt
python -m pytest -q tests
```
