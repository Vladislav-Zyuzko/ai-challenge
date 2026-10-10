"""Эмбеддинги через локальную Ollama.

Почему HTTP, а не библиотека: Ollama держит модель в памяти между вызовами, поэтому
индексация тысячи чанков не перезагружает веса на каждом батче. Плюс смена модели —
это одна строка в конфиге, а не новый стек зависимостей.

Кэш эмбеддингов живёт в SQLite (таблица `embedding_cache`) и ключуется хешем текста:
правка одной заметки не должна пересчитывать весь корпус.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request

import numpy as np

from .config import Config


class OllamaError(RuntimeError):
    pass


def text_hash(text: str, model: str) -> str:
    return hashlib.sha256(f"{model}\x00{text}".encode("utf-8")).hexdigest()


class OllamaEmbedder:
    """Клиент `/api/embed` с батчами, повторами и замером времени."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.embedded = 0          # сколько текстов реально ушло в модель
        self.cache_hits = 0
        self.batches = 0
        self.seconds = 0.0

    # ---- низкий уровень ----

    def _post(self, path: str, payload: dict, timeout: float) -> dict:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.cfg.ollama_url}{path}", data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def health(self) -> dict:
        """Есть ли сервис и загружена ли модель. Без этого индексация бессмысленна."""
        try:
            with urllib.request.urlopen(f"{self.cfg.ollama_url}/api/tags", timeout=10) as resp:
                tags = json.loads(resp.read().decode("utf-8"))
        except Exception as exc:                     # noqa: BLE001 — нужен любой сбой
            raise OllamaError(
                f"Ollama недоступна по {self.cfg.ollama_url}: {exc}. "
                "Запусти `ollama serve` или приложение Ollama."
            ) from exc
        names = [m.get("name", "") for m in tags.get("models", [])]
        has_model = any(n == self.cfg.model or n.startswith(f"{self.cfg.model}:") for n in names)
        return {"models": names, "model": self.cfg.model, "model_present": has_model}

    def embed(self, texts: list[str], *, retries: int = 3) -> np.ndarray:
        """Векторы для списка текстов, L2-нормированные (косинус = скалярное произведение)."""
        if not texts:
            return np.zeros((0, 0), dtype="float32")
        started = time.time()
        out: list[list[float]] = []
        for start in range(0, len(texts), self.cfg.batch_size):
            batch = texts[start:start + self.cfg.batch_size]
            last: Exception | None = None
            for attempt in range(retries):
                try:
                    payload = self._post("/api/embed", {"model": self.cfg.model, "input": batch},
                                         self.cfg.request_timeout)
                    embeddings = payload.get("embeddings")
                    if not embeddings or len(embeddings) != len(batch):
                        raise OllamaError(f"неожиданный ответ /api/embed: ключи {list(payload)}")
                    out.extend(embeddings)
                    last = None
                    break
                except Exception as exc:             # noqa: BLE001
                    last = exc
                    time.sleep(1.5 * (attempt + 1))
            if last is not None:
                raise OllamaError(f"не удалось получить эмбеддинги: {last}") from last
            self.batches += 1
        self.embedded += len(texts)
        self.seconds += time.time() - started
        vecs = np.asarray(out, dtype="float32")
        norms = np.linalg.norm(vecs, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return vecs / norms

    def speed(self) -> float:
        """Чанков в секунду — для отчёта."""
        return self.embedded / self.seconds if self.seconds > 0 else 0.0
