"""Captain Memo embedder sidecar — exposes voyage-4-nano (or any
sentence-transformers model) at the universal /v1/embeddings shape.

Run via: uvicorn app:app --host 127.0.0.1 --port 8124

Environment variables:
- CAPTAIN_MEMO_EMBED_MODEL          (default: voyageai/voyage-4-nano)
- CAPTAIN_MEMO_EMBED_DIM            (default: 2048)
- CAPTAIN_MEMO_EMBED_DEVICE         (default: cpu)
- CAPTAIN_MEMO_EMBED_MAX_SEQ_LEN    (default: 512; see embeddings.py)
- CAPTAIN_MEMO_EMBED_INFERENCE_BATCH_SIZE (default: 8)
- CAPTAIN_MEMO_EMBED_TORCH_THREADS  (default: 4)
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Literal, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from embeddings import EmbeddingsModel, InputType

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("captain-memo-embed")

MODEL_NAME = os.environ.get("CAPTAIN_MEMO_EMBED_MODEL", "voyageai/voyage-4-nano")
EMBED_DIM = int(os.environ.get("CAPTAIN_MEMO_EMBED_DIM", "2048"))
DEVICE = os.environ.get("CAPTAIN_MEMO_EMBED_DEVICE", "cpu")
LOAD_RETRY_SECONDS = 60

app = FastAPI(title="captain-memo-embed", version="1.0")
_model: EmbeddingsModel | None = None
# Set when the model cannot load (e.g. a transformers release the model's remote code does not run
# under). The sidecar then stays up and says so in /health, so `captain-memo doctor` can name the
# cause instead of finding a crash-looping service with no answer.
_load_error: str | None = None


def get_model() -> EmbeddingsModel:
    global _model
    if _model is None:
        _model = EmbeddingsModel(model_name=MODEL_NAME, device=DEVICE, embedding_dim=EMBED_DIM)
    return _model


class EmbeddingsRequest(BaseModel):
    """OpenAI-compatible request shape with an optional input_type extension.

    `input` may be a single string or a list (matches OpenAI). `input_type`
    is a Captain Memo / Voyage extension — when set to "query" the model
    uses the query-prefix variant for higher retrieval quality. Other
    OpenAI-compatible servers ignore it.
    """
    input: Union[str, list[str]]
    model: str = Field(default=MODEL_NAME)
    input_type: Literal["query", "document"] = "document"


class EmbeddingItem(BaseModel):
    object: Literal["embedding"] = "embedding"
    embedding: list[float]
    index: int


class EmbeddingsResponse(BaseModel):
    object: Literal["list"] = "list"
    data: list[EmbeddingItem]
    model: str


@app.get("/health")
def health() -> dict:
    out: dict = {"healthy": _load_error is None, "model": MODEL_NAME, "dim": EMBED_DIM, "device": DEVICE}
    if _load_error:
        out["error"] = _load_error
    return out


@app.post("/v1/embeddings", response_model=EmbeddingsResponse)
def embeddings(req: EmbeddingsRequest) -> EmbeddingsResponse:
    if _load_error:
        raise HTTPException(status_code=503, detail=f"embedder model failed to load: {_load_error}")
    texts = [req.input] if isinstance(req.input, str) else req.input
    model = get_model()
    vecs = model.embed_batch(texts, input_type=req.input_type)
    data = [
        EmbeddingItem(embedding=vec.tolist(), index=i)
        for i, vec in enumerate(vecs)
    ]
    return EmbeddingsResponse(data=data, model=req.model)


def _load() -> None:
    global _load_error
    try:
        get_model()
        _load_error = None
    except Exception as e:  # noqa: BLE001 - any load failure is reported via /health, not a crash loop
        _load_error = f"{type(e).__name__}: {e}"[:500]
        logger.exception("model %s failed to load", MODEL_NAME)


def _retry_until_loaded() -> None:
    # A crash loop used to retry for free (e.g. HuggingFace unreachable at boot); staying up must too.
    while _load_error:
        time.sleep(LOAD_RETRY_SECONDS)
        _load()
        if not _load_error:
            logger.info("captain-memo-embed model loaded on retry (%s)", MODEL_NAME)


@app.on_event("startup")
def warm_on_startup() -> None:
    # Force model load + warmup before first request lands.
    _load()
    if _load_error:
        threading.Thread(target=_retry_until_loaded, daemon=True, name="embed-load-retry").start()
        return
    logger.info("captain-memo-embed ready on %s (dim=%d, device=%s)", MODEL_NAME, EMBED_DIM, DEVICE)
