#!/usr/bin/env bash
# Creates backend_ml/.venv (Windows layout) and installs the Space's test dependencies.
# torch / sentence-transformers are intentionally NOT installed locally: tests inject a fake embedder.
# Output: logs/py-env.log
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
{
  if [ ! -x backend_ml/.venv/Scripts/python.exe ]; then
    python -m venv backend_ml/.venv || exit 1
  fi
  PY=backend_ml/.venv/Scripts/python.exe
  "$PY" -m pip install -q --upgrade pip
  "$PY" -m pip install -q -r backend_ml/requirements-dev.txt
  echo "== versions"
  "$PY" -m pip list 2>/dev/null | grep -iE '^(gradio|gradio_client|spaces|httpx|pydantic|psycopg|numpy|pypdf|pdfplumber|pytest) '
  echo "== END"
} > logs/py-env.log 2>&1
