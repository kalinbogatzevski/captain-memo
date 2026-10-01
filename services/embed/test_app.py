"""Sidecar behaviour when the model cannot load. Run: pip install pytest && pytest services/embed/test_app.py
(from a venv that has requirements.txt installed; the model is stubbed, so no weights are needed)."""
import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app as sidecar


class FakeModel:
    def __init__(self, *, model_name, device, embedding_dim):
        self.dim = embedding_dim

    def embed_batch(self, texts, *, input_type):
        return np.zeros((len(texts), self.dim), dtype=np.float32)


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.setattr(sidecar, "_model", None)
    monkeypatch.setattr(sidecar, "_load_error", None)
    monkeypatch.setattr(sidecar, "LOAD_RETRY_SECONDS", 0.05)
    yield
    # let a still-retrying thread succeed and exit, so it cannot touch the next test's stubs
    monkeypatch.setattr(sidecar, "EmbeddingsModel", FakeModel)
    for t in threading.enumerate():
        if t.name == "embed-load-retry":
            t.join(5)


def test_healthy_when_model_loads(monkeypatch):
    monkeypatch.setattr(sidecar, "EmbeddingsModel", FakeModel)
    with TestClient(sidecar.app) as c:
        h = c.get("/health").json()
        assert h["healthy"] is True and "error" not in h
        r = c.post("/v1/embeddings", json={"input": "hi"})
        assert r.status_code == 200 and len(r.json()["data"][0]["embedding"]) == sidecar.EMBED_DIM


def test_load_failure_stays_up_and_says_why(monkeypatch):
    def boom(**_):
        raise AttributeError("'NoneType' object has no attribute '__name__'")

    monkeypatch.setattr(sidecar, "EmbeddingsModel", boom)
    with TestClient(sidecar.app) as c:
        h = c.get("/health").json()
        assert h["healthy"] is False
        assert "AttributeError" in h["error"] and "__name__" in h["error"]
        r = c.post("/v1/embeddings", json={"input": "hi"})
        assert r.status_code == 503 and "failed to load" in r.json()["detail"]


def test_recovers_when_a_later_load_succeeds(monkeypatch):
    calls = {"n": 0}

    def flaky(**kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("huggingface.co unreachable")
        return FakeModel(**kw)

    monkeypatch.setattr(sidecar, "EmbeddingsModel", flaky)
    with TestClient(sidecar.app) as c:
        assert c.get("/health").json()["healthy"] is False
        for _ in range(100):
            if c.get("/health").json()["healthy"]:
                break
            time.sleep(0.05)
        assert c.get("/health").json()["healthy"] is True
        assert c.post("/v1/embeddings", json={"input": "hi"}).status_code == 200
