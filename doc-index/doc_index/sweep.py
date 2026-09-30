"""Настройка порога отсечения: свип по размеченному набору вопросов.

Порог нельзя «выбрать на глаз»: у каждого вопроса свой масштаб оценок, и одно и то
же число для одного вопроса отсекает мусор, а для другого — нужное. Поэтому здесь
перебираются значения, и для каждого считаются метрики поиска:

- **recall@1 / recall@5 / MRR** — не потеряли ли ожидаемую заметку;
- **precision@5** — сколько в контексте действительно нужных фрагментов;
- **фрагментов после фильтра** — цена фильтрации в токенах.

Победитель — конфигурация с максимальным precision@5 при recall@5 = 1.0: фильтр
имеет право убирать мусор, но не имеет права терять нужное.

Оценки cross-encoder кэшируются в `out/rerank_scores.json`: считать их заново на
каждое значение порога бессмысленно, а прогон модели небыстрый.
"""
from __future__ import annotations

import json
from pathlib import Path

from .config import Config
from .rerank import CrossEncoder, heuristic_score, threshold_filter
from .rewrite import expand_abbreviations, multi_query_search
from .search import Searcher

MARGINS = (0.0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.15, 0.20)
MIN_DENSE = (0.45, 0.50, 0.55, 0.58, 0.60, 0.62, 0.65)
CROSS_SCORES = (0.0, 0.01, 0.05, 0.10, 0.20, 0.30, 0.50, 0.70)
HEURISTIC_SCORES = (0.0, 0.2, 0.3, 0.4, 0.5, 0.6)
MMR_LAMBDAS = (0.5, 0.6, 0.7, 0.8, 0.9)


def candidate_pools(searcher: Searcher, questions: list[dict], *, candidates: int = 20,
                    mode: str = "dense") -> list[list[dict]]:
    """Топ-K до фильтрации — один раз на вопрос, дальше все пороги бесплатны."""
    return [searcher.search(item["question"], k=candidates, mode=mode, candidates=candidates)
            for item in questions]


def multiquery_pools(searcher: Searcher, questions: list[dict], *, candidates: int = 20,
                     mode: str = "dense") -> list[list[dict]]:
    """Пулы для rewrite-ветки: эвристическое раскрытие аббревиатур + исходный вопрос."""
    pools = []
    for item in questions:
        variants = [item["question"], expand_abbreviations(item["question"])]
        pools.append(multi_query_search(searcher, variants, k=candidates, mode=mode,
                                        candidates=candidates))
    return pools


def cross_score_cache(pools: list[list[dict]], questions: list[dict], encoder: CrossEncoder,
                      path: Path) -> dict[str, float]:
    """Оценки реранкера для всех пар «вопрос + кандидат» с кэшем на диск."""
    cache: dict[str, float] = {}
    if path.exists():
        cache = json.loads(path.read_text(encoding="utf-8"))
    missing = 0
    for item, pool in zip(questions, pools):
        texts = [hit["text"] for hit in pool]
        keys = [f"{item['id']}|{hit['chunk_id']}" for hit in pool]
        todo = [(key, text) for key, text in zip(keys, texts) if key not in cache]
        if not todo:
            continue
        scores = encoder.score(item["question"], [text for _, text in todo])
        for (key, _), score in zip(todo, scores):
            cache[key] = round(float(score), 5)
        missing += len(todo)
        print(f"  {item['id']}: посчитано {len(todo)} пар", flush=True)
    path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    print(f"  новых пар: {missing}, всего в кэше: {len(cache)}", flush=True)
    return cache


def _metrics(kept_per_question: list[list[dict]], questions: list[dict], k: int = 5) -> dict:
    recalls1 = recalls5 = mrr = 0.0
    precisions: list[float] = []
    kept_counts: list[int] = []
    for item, kept in zip(questions, kept_per_question):
        expected = set(item.get("expected") or [])
        sources = [hit["source"] for hit in kept[:k]]
        rank = next((i + 1 for i, src in enumerate(sources) if src in expected), None)
        recalls1 += 1 if rank == 1 else 0
        recalls5 += 1 if rank else 0
        mrr += 1.0 / rank if rank else 0.0
        if sources:
            precisions.append(sum(1 for src in sources if src in expected) / len(sources))
        kept_counts.append(len(kept))
    total = len(questions)
    return {
        "recall@1": round(recalls1 / total, 3),
        "recall@5": round(recalls5 / total, 3),
        "mrr": round(mrr / total, 3),
        "precision": round(sum(precisions) / len(precisions), 3) if precisions else 0.0,
        "kept_avg": round(sum(kept_counts) / total, 2),
    }


def sweep(searcher: Searcher, questions: list[dict], *, encoder: CrossEncoder | None = None,
          cfg: Config | None = None, candidates: int = 20, k: int = 5,
          mode: str = "dense") -> dict:
    """Перебрать пороги и вернуть таблицу метрик по конфигурациям."""
    cfg = cfg or Config()
    cfg.ensure_out()
    pools = candidate_pools(searcher, questions, candidates=candidates, mode=mode)
    rows: list[dict] = []

    rows.append({"family": "без фильтра", "value": "—", "note": f"top-{k} как есть",
                 **_metrics([pool[:k] for pool in pools], questions, k)})

    for margin in MARGINS:
        kept = [threshold_filter(pool, margin=margin) for pool in pools]
        rows.append({"family": "порог: маржа от top-1", "value": f"{margin:.2f}",
                     "note": "относительный", **_metrics(kept, questions, k)})

    for min_dense in MIN_DENSE:
        kept = [threshold_filter(pool, min_dense=min_dense) for pool in pools]
        rows.append({"family": "порог: абсолютный косинус", "value": f"{min_dense:.2f}",
                     "note": "по dense_score", **_metrics(kept, questions, k)})

    for min_score in HEURISTIC_SCORES:
        kept = []
        for item, pool in zip(questions, pools):
            scored = sorted(pool, key=lambda h: -heuristic_score(item["question"], h).score)
            filtered = [h for h in scored if heuristic_score(item["question"], h).score >= min_score]
            kept.append(filtered or scored[:1])
        rows.append({"family": "heuristic: пересечение термов", "value": f"{min_score:.2f}",
                     "note": "без модели", **_metrics(kept, questions, k)})

    if encoder is not None:
        cache = cross_score_cache(pools, questions, encoder,
                                  cfg.out / "rerank_scores.json")
        for min_score in CROSS_SCORES:
            kept = []
            for item, pool in zip(questions, pools):
                scored = sorted(pool, key=lambda h: -cache[f"{item['id']}|{h['chunk_id']}"])
                filtered = [h for h in scored
                            if cache[f"{item['id']}|{h['chunk_id']}"] >= min_score]
                kept.append(filtered or scored[:1])
            rows.append({"family": "cross-encoder: порог оценки", "value": f"{min_score:.2f}",
                         "note": "bge-reranker-v2-m3", **_metrics(kept, questions, k)})

    mq_pools = multiquery_pools(searcher, questions, candidates=candidates, mode=mode)
    rows.append({"family": "rewrite: раскрытие аббревиатур", "value": "—",
                 "note": "RRF двух запросов", **_metrics([pool[:k] for pool in mq_pools], questions, k)})

    return {"questions": len(questions), "candidates": candidates, "k": k,
            "mode": mode, "rows": rows}


def pick_best(sweep_result: dict) -> dict:
    """Лучшая конфигурация: максимум precision при recall@5 = 1.0."""
    perfect = [row for row in sweep_result["rows"] if row["recall@5"] >= 1.0]
    pool = perfect or sweep_result["rows"]
    return max(pool, key=lambda row: (row["precision"], -row["kept_avg"]))


def write_report(sweep_result: dict, out_dir: Path) -> Path:
    rows = sweep_result["rows"]
    best = pick_best(sweep_result)
    lines = ["# Настройка порога отсечения\n"]
    lines.append(f"Вопросов: **{sweep_result['questions']}**, кандидатов до фильтрации: "
                 f"{sweep_result['candidates']}, после: {sweep_result['k']}, "
                 f"поиск: `{sweep_result['mode']}`.\n")
    lines.append("Задача фильтра — поднять precision, **не потеряв** ожидаемую заметку. "
                 "Поэтому recall@5 = 1.0 — обязательное условие, а не пожелание.\n")
    lines.append("| Семейство | Значение | Примечание | recall@1 | recall@5 | MRR | precision | Фрагментов |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for row in rows:
        mark = " ⭐" if row is best else ""
        lines.append(f"| {row['family']}{mark} | {row['value']} | {row['note']} | "
                     f"{row['recall@1']:.2f} | {row['recall@5']:.2f} | {row['mrr']:.3f} | "
                     f"{row['precision']:.3f} | {row['kept_avg']:.2f} |")
    lines.append("")
    lines.append(f"**Выбор:** {best['family']} = {best['value']} — precision "
                 f"{best['precision']:.3f} при recall@5 {best['recall@5']:.2f}, "
                 f"в среднем {best['kept_avg']:.2f} фрагмента на вопрос.\n")
    path = out_dir / "sweep.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "sweep.json").write_text(
        json.dumps({"best": best, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    return path
