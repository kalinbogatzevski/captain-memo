"""Voyage-4-nano embeddings wrapper using sentence-transformers (CPU inference).

Adapted from Aelita's services/embed/embeddings.py, MIT-relicensed under the
Captain Memo project. Runs voyageai/voyage-4-nano open weights from
HuggingFace; loaded with trust_remote_code=True (required by the model card).
"""

from __future__ import annotations

import logging
import os
from typing import Literal

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

InputType = Literal["query", "document"]

# Model-card-recommended prefixes — measurably improves retrieval quality.
_QUERY_PREFIX = "Represent the query for retrieving supporting documents: "
_DOC_PREFIX = "Represent the document for retrieval: "

# CPU-tuning. voyage-4-nano supports 32K context but on CPU that scales
# quadratically — capping at 512 tokens keeps quality high for typical
# memory/skill/observation chunks and brings per-chunk inference from
# ~16s down to ~1s on a 4-vCPU box.
_MAX_SEQ_LEN = int(os.environ.get("CAPTAIN_MEMO_EMBED_MAX_SEQ_LEN", "512"))
_INFERENCE_BATCH_SIZE = int(os.environ.get("CAPTAIN_MEMO_EMBED_INFERENCE_BATCH_SIZE", "8"))


class EmbeddingsModel:
    def __init__(self, *, model_name: str, device: str = "cpu", embedding_dim: int = 2048):
        logger.info("loading model %s on %s", model_name, device)
        self.model_name = model_name
        self.embedding_dim = embedding_dim
        self.device = device
        if device == "cpu":
            torch.set_num_threads(int(os.environ.get("CAPTAIN_MEMO_EMBED_TORCH_THREADS", "4")))
        # trust_remote_code=True required by voyage-4-nano per its model card.
        self.model = SentenceTransformer(model_name, device=device, trust_remote_code=True)
        self.model.max_seq_length = _MAX_SEQ_LEN
        # Warm-up: cuts ~3s off first-call latency.
        _ = self.model.encode(
            ["warmup"], convert_to_numpy=True, batch_size=_INFERENCE_BATCH_SIZE
        )
        logger.info(
            "model loaded; warmup complete (max_seq_len=%d, batch_size=%d, threads=%d)",
            _MAX_SEQ_LEN, _INFERENCE_BATCH_SIZE, torch.get_num_threads(),
        )

    def _prep(self, text: str, input_type: InputType) -> str:
        prefix = _QUERY_PREFIX if input_type == "query" else _DOC_PREFIX
        return prefix + text

    def embed_batch(self, texts: list[str], *, input_type: InputType) -> np.ndarray:
        prepped = [self._prep(t, input_type) for t in texts]
        vecs = self.model.encode(
            prepped,
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=_INFERENCE_BATCH_SIZE,
            show_progress_bar=False,
        )
        # Truncate to embedding_dim if model produces longer (Matryoshka-style).
        if vecs.shape[1] > self.embedding_dim:
            vecs = vecs[:, : self.embedding_dim]
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            vecs = vecs / np.where(norms == 0, 1.0, norms)
        return vecs.astype(np.float32)
