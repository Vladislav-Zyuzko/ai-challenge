"""Поиск по индексу: dense (FAISS) + лексический (FTS5/BM25) со слиянием RRF.

Лексический канал здесь не украшение. В корпусе полно аббревиатур и терминов
(«AI SDLC», «ЗУН», «харнесс», «MCP»), где векторный поиск промахивается, а точное
слово решает. Слияние — Reciprocal Rank Fusion: складываем 1/(60+ранг) по каждому
каналу, поэтому попадание в оба списка выигрывает у первого места в одном.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

import numpy as np

from .config import Config
from .embed import OllamaEmbedder
from .store import id_map, load_faiss

TOKEN_RE = re.compile(r"[\w\-]{2,}", re.UNICODE)


def fts_query(query: str) -> str:
    """Запрос для FTS5: токены через OR, каждый с префиксом.

    Префикс (`"агент"*`) частично компенсирует отсутствие стемминга: запрос «агента»
    найдёт «агент», «агенты», «агентный». Русскую морфологию это не заменяет, но
    для терминов работает.
    """
    tokens = [t for t in TOKEN_RE.findall(query.lower()) if not t.isdigit()]
    return " OR ".join(f'"{t}"*' for t in tokens)


def lexical_search(conn: sqlite3.Connection, strategy: str, query: str, k: int) -> list[tuple[str, float]]:
    q = fts_query(query)
    if not q:
        return []
    cur = conn.execute(
        """SELECT chunk_id, bm25(chunks_fts) AS score
           FROM chunks_fts
           WHERE chunks_fts MATCH ? AND strategy = ?
           ORDER BY score
           LIMIT ?""",
        (q, strategy, k),
    )
    # bm25 в SQLite отрицательный: чем меньше, тем лучше. Переворачиваем в «больше — лучше».
    return [(row["chunk_id"], -float(row["score"])) for row in cur]


def dense_search(index, ids: list[str], embedder: OllamaEmbedder, query: str, k: int,
                 query_vector: np.ndarray | None = None) -> list[tuple[str, float]]:
    vecs = query_vector if query_vector is not None else embedder.embed([query])
    if vecs is None or vecs.size == 0 or index is None:
        return []
    if vecs.ndim == 1:
        vecs = vecs.reshape(1, -1)
    scores, positions = index.search(np.ascontiguousarray(vecs, dtype="float32"), k)
    out: list[tuple[str, float]] = []
    for score, pos in zip(scores[0], positions[0]):
        if 0 <= pos < len(ids):
            out.append((ids[int(pos)], float(score)))
    return out


def rrf(rank_lists: list[list[tuple[str, float]]], k: int = 60) -> list[tuple[str, float]]:
    """Reciprocal Rank Fusion: устойчивое слияние без нормировки оценок."""
    fused: dict[str, float] = {}
    for lst in rank_lists:
        for rank, (chunk_id, _score) in enumerate(lst, start=1):
            fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.0 / (k + rank)
    return sorted(fused.items(), key=lambda item: -item[1])


class Searcher:
    """Поиск по одной стратегии чанкинга; FAISS-индекс держится в памяти."""

    def __init__(self, conn: sqlite3.Connection, cfg: Config, embedder: OllamaEmbedder,
                 strategy: str, faiss_path: Path | None = None):
        self.conn = conn
        self.cfg = cfg
        self.embedder = embedder
        self.strategy = strategy
        self.ids = id_map(conn, strategy, cfg.model)
        path = faiss_path or cfg.faiss_path(strategy)
        self.index = load_faiss(path) if path.exists() else None

    def search(self, query: str, *, k: int = 5, mode: str = "hybrid",
               candidates: int = 20, query_vector: np.ndarray | None = None) -> list[dict]:
        lists: list[list[tuple[str, float]]] = []
        dense_hits: list[tuple[str, float]] = []
        lexical_hits: list[tuple[str, float]] = []
        if mode in ("dense", "hybrid"):
            dense_hits = dense_search(self.index, self.ids, self.embedder, query, candidates, query_vector)
            lists.append(dense_hits)
        if mode in ("lexical", "hybrid"):
            lexical_hits = lexical_search(self.conn, self.strategy, query, candidates)
            lists.append(lexical_hits)
        fused = rrf(lists)[:k] if len(lists) > 1 else (lists[0][:k] if lists else [])

        dense_rank = {cid: r for r, (cid, _) in enumerate(dense_hits, 1)}
        lex_rank = {cid: r for r, (cid, _) in enumerate(lexical_hits, 1)}
        rows = self._rows([cid for cid, _ in fused])
        out: list[dict] = []
        for rank, (chunk_id, score) in enumerate(fused, start=1):
            row = rows.get(chunk_id)
            if row is None:
                continue
            row = dict(row)
            row["rank"] = rank
            row["score"] = round(score, 5)
            row["dense_rank"] = dense_rank.get(chunk_id)
            row["lexical_rank"] = lex_rank.get(chunk_id)
            out.append(row)
        return out

    def _rows(self, ids: list[str]) -> dict[str, sqlite3.Row]:
        if not ids:
            return {}
        marks = ",".join("?" * len(ids))
        cur = self.conn.execute(f"SELECT * FROM chunks WHERE chunk_id IN ({marks})", ids)
        return {row["chunk_id"]: row for row in cur}


def snippet(text: str, query: str, width: int = 200) -> str:
    """Короткий фрагмент вокруг первого совпадения — для вывода в консоль."""
    flat = " ".join(text.split())
    if len(flat) <= width:
        return flat
    tokens = [t for t in TOKEN_RE.findall(query.lower())]
    low = flat.lower()
    pos = min((low.find(t) for t in tokens if low.find(t) >= 0), default=-1)
    if pos < 0:
        return flat[:width] + "…"
    start = max(pos - width // 3, 0)
    return ("…" if start else "") + flat[start:start + width] + "…"
