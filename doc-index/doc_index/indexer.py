"""Сборка индекса: корпус → чанки → эмбеддинги → SQLite + FAISS + JSON.

Кэш эмбеддингов ключуется хешем текста, поэтому повторный прогон после правки одной
заметки считает векторы только для изменившихся чанков. Это не оптимизация ради
оптимизации: без неё сравнение стратегий превращается в получасовое ожидание, и
экспериментировать с параметрами чанкинга уже не хочется.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from . import store
from .chunk import Chunk, build_chunks, chunk_stats
from .collect import collect
from .config import Config
from .embed import OllamaEmbedder, text_hash


@dataclass
class IndexReport:
    strategy: str
    chunks: int
    embedded: int
    cache_hits: int
    seconds: float
    stats: dict
    faiss_path: str
    json_path: str


def _prepare_vectors(conn, cfg: Config, embedder: OllamaEmbedder,
                     chunks: list[Chunk]) -> tuple[np.ndarray, int, int]:
    """Векторы для чанков: из кэша, недостающие — у модели. Возвращает (матрица, посчитано, из кэша)."""
    hashes = [text_hash(c.embed_text, cfg.model) for c in chunks]
    cached = store.cache_get(conn, hashes, cfg.model)
    misses = [(i, h) for i, h in enumerate(hashes) if h not in cached]

    dim = next(iter(cached.values())).shape[0] if cached else 0
    computed = 0
    if misses:
        vectors = embedder.embed([chunks[i].embed_text for i, _ in misses])
        dim = vectors.shape[1]
        store.cache_put(conn, [(h, vectors[j]) for j, (_, h) in enumerate(misses)], cfg.model)
        computed = len(misses)
        for j, (i, _) in enumerate(misses):
            cached[hashes[i]] = vectors[j]

    matrix = np.zeros((len(chunks), dim), dtype="float32")
    for i, h in enumerate(hashes):
        matrix[i] = cached[h]
    return matrix, computed, len(hashes) - computed


def build_index(cfg: Config, strategies: list[str], *, rebuild_cache: bool = False) -> list[IndexReport]:
    cfg.ensure_out()
    notes, skipped = collect(cfg)
    if not notes:
        raise RuntimeError(f"в корпусе {cfg.vault} не найдено ни одной заметки")
    print(f"корпус: {len(notes)} заметок, пропущено {len(skipped)}")
    for path in skipped[:5]:
        print(f"  пропуск: {path}")

    conn = store.connect(cfg.db_path())
    if rebuild_cache:
        conn.execute("DELETE FROM embedding_cache")
        conn.commit()

    embedder = OllamaEmbedder(cfg)
    health = embedder.health()
    if not health["model_present"]:
        raise RuntimeError(
            f"в Ollama нет модели {cfg.model}. Доступны: {', '.join(health['models']) or '—'}. "
            f"Поставь её: ollama pull {cfg.model}"
        )

    reports: list[IndexReport] = []
    # Прогрев: первый запрос загружает веса модели в память (несколько секунд) и
    # испортил бы замер скорости. Его время в отчёт не идёт.
    embedder.embed(["прогрев модели"])
    warmup = (embedder.embedded, embedder.seconds, embedder.batches)
    embedder.embedded = embedder.seconds = embedder.batches = 0

    for strategy in strategies:
        started = time.time()
        chunks = build_chunks(notes, cfg, strategy)
        if not chunks:
            print(f"[{strategy}] чанков не получилось — пропускаю")
            continue
        store.reset_strategy(conn, strategy)
        store.save_chunks(conn, chunks)
        matrix, computed, hits = _prepare_vectors(conn, cfg, embedder, chunks)
        store.save_embeddings(conn, strategy, cfg.model, [c.chunk_id for c in chunks], matrix)
        store.write_faiss(cfg.faiss_path(strategy), matrix)
        store.export_json(cfg.chunks_json(strategy), chunks)
        seconds = time.time() - started
        stats = chunk_stats(chunks)
        store.log_run(conn, strategy, cfg.model, len(chunks), computed, hits, seconds)
        reports.append(IndexReport(
            strategy=strategy, chunks=len(chunks), embedded=computed, cache_hits=hits,
            seconds=seconds, stats=stats,
            faiss_path=str(cfg.faiss_path(strategy)), json_path=str(cfg.chunks_json(strategy)),
        ))
        print(f"[{strategy}] чанков {len(chunks)}, посчитано {computed}, из кэша {hits}, "
              f"{seconds:.1f} с ({computed / seconds:.1f} чанков/с), avg {stats['chars_avg']} символов")
    print(f"эмбеддинги: {embedder.embedded} за {embedder.seconds:.1f} с "
          f"({embedder.speed():.1f} чанков/с), батчей {embedder.batches} (прогрев "
          f"{warmup[1]:.1f} с, в замер не входит)")
    conn.close()
    return reports
