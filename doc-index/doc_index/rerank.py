"""Второй этап после поиска: фильтрация нерелевантного и реранкинг кандидатов.

Зачем отдельный этап. Поиск по вектору отдаёт фиксированный top-K, и в него
попадает всё, что «похоже» на вопрос, — включая соседние по теме заметки. Замер
дня 21 показал, что precision@5 на нашем корпусе держится около 0.78: каждый
пятый фрагмент контекста — из чужой заметки. Фильтр должен убрать именно их,
не потеряв нужное.

Три подхода, разрешённых заданием, реализованы все:

1. **Порог similarity** (`threshold`) — абсолютный по косинусу и/или
   относительный («маржа» от лучшего результата). Абсолютный порог на нашем
   корпусе почти бесполезен: bge-m3 сжимает все оценки в полосу 0.50–0.78,
   поэтому рабочим оказывается относительный.
2. **Отдельная модель** (`cross`) — cross-encoder bge-reranker-v2-m3: считает
   релевантность пары «вопрос + фрагмент» целиком, а не сравнивает два вектора.
   Его оценка калибрована, поэтому по ней порог осмыслен.
3. **Heuristic** (`heuristic`) — пересечение термов запроса с текстом и
   заголовком; `mmr` — диверсификация выдачи по векторам.

ВАЖНО про порядок. Фильтровать нужно **до** расширения соседними чанками
(`Searcher.neighbours`): у соседей оценка 0.0, и любой порог выбросил бы их.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .search import TOKEN_RE

RERANKERS = ("none", "threshold", "heuristic", "cross", "mmr")

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "bge-reranker-v2-m3-int8"

# ONNX-сборка bge-reranker-v2-m3, квантованная в INT8 под AVX2: 567 МБ вместо
# 2.2 ГБ fp32. Веса качаются один раз и лежат вне git (doc-index/models/).
MODEL_REPO = "kftof/bge-reranker-v2-m3-onnx-int8-avx2"
MODEL_FILES = ("model.onnx", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json")


def download_model(target: Path | str = DEFAULT_MODEL_DIR, *, repo: str = MODEL_REPO) -> Path:
    """Скачать веса и токенизатор реранкера (нужен `huggingface_hub`)."""
    from huggingface_hub import hf_hub_download

    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    total = 0
    for name in MODEL_FILES:
        path = Path(hf_hub_download(repo_id=repo, filename=name, local_dir=target))
        size = path.stat().st_size
        total += size
        print(f"  {name}: {size / 1e6:.1f} MB", flush=True)
    print(f"итого {total / 1e6:.1f} MB в {target}", flush=True)
    return target


# ---------------------------------------------------------------- порог


def _dense(hit: dict) -> float:
    value = hit.get("dense_score")
    return float(value) if value is not None else 0.0


def threshold_filter(hits: list[dict], *, min_dense: float | None = None,
                     margin: float | None = None, min_keep: int = 1) -> list[dict]:
    """Отсечь нерелевантное: абсолютный порог по косинусу и/или маржа от top-1.

    `margin` — относительный порог: оставить всё, что не дальше чем на `margin`
    от лучшего результата. Он устойчивее абсолютного: у «плохих» вопросов все
    оценки ниже, но порядок и разрывы сохраняются.

    `min_keep` не даёт фильтру обнулить контекст: один фрагмент остаётся всегда,
    иначе RAG-режим выродится в «без RAG» и сравнение потеряет смысл.
    """
    if not hits:
        return []
    top = max(_dense(h) for h in hits)
    kept: list[dict] = []
    for hit in hits:
        score = _dense(hit)
        if min_dense is not None and score < min_dense:
            continue
        if margin is not None and score < top - margin:
            continue
        kept.append(hit)
    if len(kept) < min_keep:
        best = sorted(hits, key=lambda h: -_dense(h))[:min_keep]
        return best
    return kept


# ---------------------------------------------------------------- эвристика


def _stems(tokens: list[str]) -> set[str]:
    """Грубая «основа» слова: первые 5 символов.

    Стемминга в проекте нет, а морфология русская: «агента» и «агентный» должны
    совпасть, поэтому сравниваем префиксы, а не точные токены.
    """
    return {t[:5] for t in tokens if len(t) >= 3}


@dataclass
class HeuristicScore:
    coverage: float      # доля термов вопроса, найденных в тексте фрагмента
    heading: float       # то же по заголовку и хлебной крошке
    score: float


def heuristic_score(query: str, hit: dict, *, heading_weight: float = 0.25) -> HeuristicScore:
    """Насколько фрагмент покрывает термы вопроса (без модели и без сети)."""
    q_tokens = _stems([t.lower() for t in TOKEN_RE.findall(query)])
    if not q_tokens:
        return HeuristicScore(0.0, 0.0, 0.0)
    body = _stems([t.lower() for t in TOKEN_RE.findall(hit.get("text") or "")])
    head_text = " ".join(str(hit.get(key) or "") for key in ("title", "breadcrumb", "section"))
    head = _stems([t.lower() for t in TOKEN_RE.findall(head_text)])
    coverage = len(q_tokens & body) / len(q_tokens)
    heading = len(q_tokens & head) / len(q_tokens)
    return HeuristicScore(round(coverage, 4), round(heading, 4),
                          round((1 - heading_weight) * coverage + heading_weight * heading, 4))


def rerank_heuristic(hits: list[dict], query: str, *, top_k: int = 5,
                     min_score: float | None = None, min_keep: int = 1) -> list[dict]:
    scored = []
    for hit in hits:
        item = dict(hit)
        hs = heuristic_score(query, hit)
        item["heuristic_score"] = hs.score
        item["heuristic_coverage"] = hs.coverage
        item["heuristic_heading"] = hs.heading
        scored.append(item)
    scored.sort(key=lambda h: (-h["heuristic_score"], h.get("rank") or 0))
    if min_score is not None:
        filtered = [h for h in scored if h["heuristic_score"] >= min_score]
        scored = filtered if len(filtered) >= min_keep else scored[:min_keep]
    return scored[:top_k]


# ---------------------------------------------------------------- MMR


def _positions(ids: list[str], hits: list[dict]) -> list[int]:
    index_of = {cid: i for i, cid in enumerate(ids)}
    return [index_of.get(h["chunk_id"], -1) for h in hits]


def mmr(hits: list[dict], index, ids: list[str], query_vector: np.ndarray | None, *,
        top_k: int = 5, lambda_: float = 0.7) -> list[dict]:
    """Maximal Marginal Relevance: релевантность минус похожесть на уже выбранное.

    Зачем в RAG: пять почти одинаковых фрагментов одной заметки тратят бюджет
    контекста, не добавляя фактов. MMR разводит выдачу по разным заметкам.
    """
    if not hits or index is None or query_vector is None:
        return hits[:top_k]
    positions = _positions(ids, hits)
    vectors: dict[str, np.ndarray] = {}
    for hit, pos in zip(hits, positions):
        if pos >= 0:
            vec = index.reconstruct(int(pos))
            vectors[hit["chunk_id"]] = vec / (np.linalg.norm(vec) + 1e-9)
    query = query_vector.reshape(-1)
    query = query / (np.linalg.norm(query) + 1e-9)

    chosen: list[dict] = []
    pool = list(hits)
    while pool and len(chosen) < top_k:
        best, best_value = None, -math.inf
        for hit in pool:
            cid = hit["chunk_id"]
            relevance = _dense(hit) if cid not in vectors else float(np.dot(vectors[cid], query))
            if chosen:
                similarity = max(float(np.dot(vectors[cid], vectors[c["chunk_id"]]))
                                 for c in chosen if c["chunk_id"] in vectors)
            else:
                similarity = 0.0
            value = lambda_ * relevance - (1 - lambda_) * similarity
            if value > best_value:
                best, best_value = hit, value
        pool.remove(best)
        chosen.append(best)
    return chosen


# ---------------------------------------------------------------- cross-encoder


class CrossEncoderUnavailable(RuntimeError):
    """Модель реранкера не скачана — подсказываем, что делать."""


class CrossEncoder:
    """bge-reranker-v2-m3 в ONNX: оценка пары «вопрос + фрагмент».

    Ollama реранкеры не умеет (нет ни `/api/rerank`, ни таких моделей в
    библиотеке), поэтому идём через onnxruntime напрямую. Токенизатор берём из
    `tokenizer.json` — пакет `tokenizers` уже стоит, ничего доустанавливать не надо.
    """

    def __init__(self, model_dir: Path | str = DEFAULT_MODEL_DIR, *, batch_size: int = 8,
                 max_length: int = 512):
        from tokenizers import Tokenizer
        import onnxruntime as ort

        model_dir = Path(model_dir)
        model_path = model_dir / "model.onnx"
        tokenizer_path = model_dir / "tokenizer.json"
        if not model_path.exists() or not tokenizer_path.exists():
            raise CrossEncoderUnavailable(
                f"нет модели в {model_dir}: ожидаются model.onnx и tokenizer.json "
                f"(скачать: python _fetch_reranker.py)"
            )
        self.model_dir = model_dir
        self.batch_size = batch_size
        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.enable_truncation(max_length=max_length)
        self.tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.input_names = {i.name for i in self.session.get_inputs()}
        self.calls = 0
        self.pairs = 0

    def score(self, query: str, texts: list[str]) -> list[float]:
        """Релевантность каждого текста вопросу: sigmoid от логита модели."""
        if not texts:
            return []
        scores: list[float] = []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start:start + self.batch_size]
            encodings = self.tokenizer.encode_batch([(query, text) for text in batch])
            feeds = {
                "input_ids": np.array([e.ids for e in encodings], dtype=np.int64),
                "attention_mask": np.array([e.attention_mask for e in encodings], dtype=np.int64),
            }
            if "token_type_ids" in self.input_names:
                feeds["token_type_ids"] = np.array([e.type_ids for e in encodings], dtype=np.int64)
            logits = self.session.run(None, feeds)[0]
            for value in np.asarray(logits).reshape(len(batch), -1)[:, 0]:
                scores.append(1.0 / (1.0 + math.exp(-float(value))))
            self.calls += 1
            self.pairs += len(batch)
        return scores


def rerank_cross(encoder: CrossEncoder, query: str, hits: list[dict], *, top_k: int = 5,
                 min_score: float | None = None, min_keep: int = 1) -> list[dict]:
    """Переставить кандидатов по оценке cross-encoder и отсечь слабые."""
    if not hits:
        return []
    scores = encoder.score(query, [h["text"] for h in hits])
    scored = []
    for hit, score in zip(hits, scores):
        item = dict(hit)
        item["rerank_score"] = round(score, 5)
        scored.append(item)
    scored.sort(key=lambda h: -h["rerank_score"])
    if min_score is not None:
        filtered = [h for h in scored if h["rerank_score"] >= min_score]
        scored = filtered if len(filtered) >= min_keep else scored[:min_keep]
    return scored[:top_k]


@dataclass
class RerankInfo:
    """Что произошло на втором этапе — для отчёта и метрик."""

    method: str
    candidates: int = 0
    kept: int = 0
    min_score: float | None = None
    margin: float | None = None
    scores: list[float] = field(default_factory=list)

    @property
    def dropped(self) -> int:
        return self.candidates - self.kept


def rerank(hits: list[dict], *, method: str = "none", query: str = "", top_k: int = 5,
           min_dense: float | None = None, margin: float | None = None,
           min_score: float | None = None, min_keep: int = 1,
           encoder: CrossEncoder | None = None, index=None, ids: list[str] | None = None,
           query_vector: np.ndarray | None = None, mmr_lambda: float = 0.7
           ) -> tuple[list[dict], RerankInfo]:
    """Единая точка входа второго этапа: вернуть отобранные фрагменты и статистику."""
    if method not in RERANKERS:
        raise ValueError(f"неизвестный реранкер: {method}")
    info = RerankInfo(method=method, candidates=len(hits), min_score=min_score, margin=margin)
    if method == "none" or not hits:
        info.kept = len(hits[:top_k])
        return hits[:top_k], info

    if method == "threshold":
        kept = threshold_filter(hits, min_dense=min_dense, margin=margin, min_keep=min_keep)
        info.scores = [_dense(h) for h in kept]
        info.kept = len(kept[:top_k])
        return kept[:top_k], info

    if method == "heuristic":
        kept = rerank_heuristic(hits, query, top_k=top_k, min_score=min_score, min_keep=min_keep)
        info.scores = [h.get("heuristic_score", 0.0) for h in kept]
        info.kept = len(kept)
        return kept, info

    if method == "mmr":
        kept = mmr(hits, index, ids or [], query_vector, top_k=top_k, lambda_=mmr_lambda)
        info.scores = [_dense(h) for h in kept]
        info.kept = len(kept)
        return kept, info

    if encoder is None:
        raise CrossEncoderUnavailable("для реранкера cross нужен загруженный CrossEncoder")
    kept = rerank_cross(encoder, query, hits, top_k=top_k, min_score=min_score, min_keep=min_keep)
    info.scores = [h.get("rerank_score", 0.0) for h in kept]
    info.kept = len(kept)
    return kept, info
