"""Хранилище индекса.

Три формы, у каждой своя роль:

- **SQLite** — основной: метаданные чанков, текст, эмбеддинги и кэш. Плюс FTS5 —
  лексический поиск (BM25) без единой внешней зависимости.
- **FAISS** — векторный поиск: `IndexFlatIP` по нормированным векторам (косинус).
  На нашем объёме он не нужен (перебор был бы мгновенным), но задание просит его,
  и это путь роста до сотен тысяч чанков.
- **JSON** — выгрузка чанков для глаз и диффов.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np

from .chunk import Chunk

SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id     TEXT PRIMARY KEY,
    strategy     TEXT NOT NULL,
    source       TEXT NOT NULL,
    file         TEXT,
    title        TEXT,
    section      TEXT,
    breadcrumb   TEXT,
    folder       TEXT,
    folder_label TEXT,
    tags         TEXT,
    links        TEXT,
    doc_source   TEXT,
    start_line   INTEGER,
    end_line     INTEGER,
    n_chars      INTEGER,
    n_tokens_est INTEGER,
    merged       INTEGER DEFAULT 0,
    text         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_strategy ON chunks(strategy);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    chunk_id  UNINDEXED,
    source    UNINDEXED,
    folder    UNINDEXED,
    strategy  UNINDEXED,
    title,
    section,
    tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id  TEXT NOT NULL,
    strategy  TEXT NOT NULL,
    model     TEXT NOT NULL,
    dim       INTEGER NOT NULL,
    vector    BLOB NOT NULL,
    faiss_pos INTEGER,
    PRIMARY KEY (chunk_id, model)
);

CREATE TABLE IF NOT EXISTS embedding_cache (
    hash   TEXT PRIMARY KEY,
    model  TEXT NOT NULL,
    dim    INTEGER NOT NULL,
    vector BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy   TEXT,
    model      TEXT,
    chunks     INTEGER,
    embedded   INTEGER,
    cache_hits INTEGER,
    seconds    REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(path: Path, *, check_same_thread: bool = True) -> sqlite3.Connection:
    """Открыть базу и создать схему, если её ещё нет.

    `check_same_thread=False` нужен многопоточным потребителям: MCP-сервер
    обслуживает вызовы инструментов в разных потоках, а соединение SQLite по
    умолчанию привязано к создавшему его потоку и падает с
    «SQLite objects created in a thread can only be used in that same thread».
    Однопоточные команды (CLI) оставляют проверку включённой.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=check_same_thread)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def to_blob(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype="float32").tobytes()


def from_blob(blob: bytes, dim: int) -> np.ndarray:
    return np.frombuffer(blob, dtype="float32", count=dim)


def reset_strategy(conn: sqlite3.Connection, strategy: str) -> None:
    """Повторная индексация той же стратегии не должна плодить дубликаты."""
    conn.execute("DELETE FROM chunks WHERE strategy = ?", (strategy,))
    conn.execute("DELETE FROM chunks_fts WHERE strategy = ?", (strategy,))
    conn.execute("DELETE FROM embeddings WHERE strategy = ?", (strategy,))
    conn.commit()


def save_chunks(conn: sqlite3.Connection, chunks: list[Chunk]) -> int:
    rows = [c.row() for c in chunks]
    conn.executemany(
        """INSERT OR REPLACE INTO chunks
           (chunk_id, strategy, source, file, title, section, breadcrumb, folder, folder_label,
            tags, links, doc_source, start_line, end_line, n_chars, n_tokens_est, merged, text)
           VALUES (:chunk_id, :strategy, :source, :file, :title, :section, :breadcrumb, :folder,
                   :folder_label, :tags_json, :links_json, :doc_source, :start_line, :end_line,
                   :n_chars, :n_tokens_est, :merged_int, :text)""",
        [{
            **row,
            "tags_json": json.dumps(row["tags"], ensure_ascii=False),
            "links_json": json.dumps(row["links"], ensure_ascii=False),
            "merged_int": int(bool(row["merged"])),
        } for row in rows],
    )
    conn.executemany(
        """INSERT INTO chunks_fts (text, chunk_id, source, folder, strategy, title, section)
           VALUES (:text, :chunk_id, :source, :folder, :strategy, :title, :section)""",
        rows,
    )
    conn.commit()
    return len(rows)


# ───────────────────────── кэш эмбеддингов ─────────────────────────

def cache_get(conn: sqlite3.Connection, hashes: list[str], model: str) -> dict[str, np.ndarray]:
    found: dict[str, np.ndarray] = {}
    for start in range(0, len(hashes), 500):
        part = hashes[start:start + 500]
        marks = ",".join("?" * len(part))
        cur = conn.execute(
            f"SELECT hash, dim, vector FROM embedding_cache WHERE model = ? AND hash IN ({marks})",
            [model, *part],
        )
        for row in cur:
            found[row["hash"]] = from_blob(row["vector"], row["dim"])
    return found


def cache_put(conn: sqlite3.Connection, items: list[tuple[str, np.ndarray]], model: str) -> None:
    conn.executemany(
        "INSERT OR REPLACE INTO embedding_cache (hash, model, dim, vector) VALUES (?, ?, ?, ?)",
        [(h, model, len(v), to_blob(v)) for h, v in items],
    )
    conn.commit()


# ───────────────────────── эмбеддинги и FAISS ─────────────────────────

def save_embeddings(conn: sqlite3.Connection, strategy: str, model: str,
                    chunk_ids: list[str], vectors: np.ndarray) -> None:
    conn.executemany(
        """INSERT OR REPLACE INTO embeddings (chunk_id, strategy, model, dim, vector, faiss_pos)
           VALUES (?, ?, ?, ?, ?, ?)""",
        [(cid, strategy, model, vectors.shape[1], to_blob(vectors[i]), i)
         for i, cid in enumerate(chunk_ids)],
    )
    conn.commit()


def write_faiss(path: Path, vectors: np.ndarray) -> None:
    import faiss  # импорт здесь: нужен только для векторного поиска

    index = faiss.IndexFlatIP(vectors.shape[1])
    index.add(np.ascontiguousarray(vectors, dtype="float32"))
    path.parent.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(path))


def load_faiss(path: Path):
    import faiss

    return faiss.read_index(str(path))


def id_map(conn: sqlite3.Connection, strategy: str, model: str) -> list[str]:
    """Порядок векторов в FAISS-индексе."""
    cur = conn.execute(
        "SELECT chunk_id FROM embeddings WHERE strategy = ? AND model = ? ORDER BY faiss_pos",
        (strategy, model),
    )
    return [row["chunk_id"] for row in cur]


def export_json(path: Path, chunks: list[Chunk]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([c.row() for c in chunks], ensure_ascii=False, indent=1),
        encoding="utf-8",
    )


def log_run(conn: sqlite3.Connection, strategy: str, model: str, chunks: int,
            embedded: int, cache_hits: int, seconds: float) -> None:
    conn.execute(
        """INSERT INTO runs (strategy, model, chunks, embedded, cache_hits, seconds)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (strategy, model, chunks, embedded, cache_hits, round(seconds, 1)),
    )
    conn.commit()


def index_stats(conn: sqlite3.Connection) -> dict:
    out: dict = {}
    for row in conn.execute(
        "SELECT strategy, COUNT(*) AS n, SUM(n_chars) AS chars FROM chunks GROUP BY strategy"
    ):
        out[row["strategy"]] = {"chunks": row["n"], "chars": row["chars"]}
    out["embeddings"] = conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]
    out["cache"] = conn.execute("SELECT COUNT(*) FROM embedding_cache").fetchone()[0]
    return out


def chunk_stats_from_db(conn: sqlite3.Connection, strategy: str) -> dict:
    """Та же статистика, что `chunk.chunk_stats`, но по тому, что реально лежит в индексе."""
    cur = conn.execute(
        "SELECT source, tags, section, merged, n_chars, n_tokens_est FROM chunks WHERE strategy = ?",
        (strategy,),
    )
    rows = cur.fetchall()
    if not rows:
        return {"chunks": 0}
    sizes = sorted(row["n_chars"] for row in rows)
    mid = sizes[len(sizes) // 2]
    return {
        "chunks": len(rows),
        "sources": len({row["source"] for row in rows}),
        "chars_total": sum(sizes),
        "chars_avg": round(sum(sizes) / len(sizes)),
        "chars_median": mid,
        "chars_min": sizes[0],
        "chars_max": sizes[-1],
        "chunks_under_200": sum(1 for s in sizes if s < 200),
        "with_section": sum(1 for row in rows if row["section"]),
        "with_tags": sum(1 for row in rows if row["tags"] and row["tags"] != "[]"),
        "merged": sum(1 for row in rows if row["merged"]),
        "tokens_est_avg": round(sum(row["n_tokens_est"] for row in rows) / len(rows)),
    }
