FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/home/user/.cache/huggingface \
    OMP_NUM_THREADS=2 \
    TOKENIZERS_PARALLELISM=false

RUN useradd --create-home --uid 1000 user
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu torch \
 && pip install -r requirements.txt

USER user
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

COPY --chown=user pipeline.py main.py ./

EXPOSE 7860
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1", "--timeout-keep-alive", "30"]
