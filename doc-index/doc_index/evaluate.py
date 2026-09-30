"""Оценка стратегий: recall@k и MRR на размеченном наборе вопросов.

Сравнивать стратегии «на глаз» бессмысленно: обе выдают что-то похожее на правду.
Поэтому набор вопросов размечен заранее — у каждого вопроса есть заметка, которая
обязана быть в выдаче, — и метрики считаются по ней.

Вектор вопроса считается один раз и переиспользуется по всем стратегиям: иначе
сравнение шести комбинаций превращается в шесть наборов эмбеддингов и разъезжается
по времени.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from .config import Config
from .embed import OllamaEmbedder
from .search import Searcher


def load_questions(path: Path) -> list[dict]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    questions = data.get("questions") if isinstance(data, dict) else data
    if not questions:
        raise ValueError(f"в {path} нет списка questions")
    for item in questions:
        if not item.get("question") or not item.get("expected"):
            raise ValueError(f"вопрос без question/expected: {item}")
        if isinstance(item["expected"], str):
            item["expected"] = [item["expected"]]
    return questions


def _share(rows: list[dict], n: int) -> float:
    return round(sum(1 for r in rows if r["rank"] and r["rank"] <= n) / len(rows), 3)


def evaluate(conn, cfg: Config, embedder: OllamaEmbedder, questions: list[dict], *,
             strategies: list[str], modes: list[str], k: int = 10,
             candidates: int = 20) -> dict:
    searchers = {s: Searcher(conn, cfg, embedder, s) for s in strategies}
    query_vectors = {q["id"]: embedder.embed([q["question"]]) for q in questions}

    results: dict[str, dict] = {}
    for strategy in strategies:
        searcher = searchers[strategy]
        for mode in modes:
            rows: list[dict] = []
            for item in questions:
                hits = searcher.search(
                    item["question"], k=k, mode=mode, candidates=candidates,
                    query_vector=query_vectors[item["id"]],
                )
                sources = [h["source"] for h in hits]
                expected = set(item["expected"])
                rank = next((i + 1 for i, src in enumerate(sources) if src in expected), None)
                rows.append({
                    "id": item["id"],
                    "question": item["question"],
                    "expected": sorted(expected),
                    "rank": rank,
                    "top": sources[:5],
                    "hit": sources[rank - 1] if rank else None,
                })
            results[f"{strategy}|{mode}"] = {
                "strategy": strategy,
                "mode": mode,
                "recall@1": _share(rows, 1),
                "recall@5": _share(rows, 5),
                "mrr": round(sum(1.0 / r["rank"] for r in rows if r["rank"]) / len(rows), 3),
                "misses": [r for r in rows if not r["rank"]],
                "rows": rows,
            }
    return {"k": k, "questions": len(questions), "strategies": strategies, "modes": modes,
            "results": results}


def source_skew(evaluation: dict, prefix: str) -> dict[str, int]:
    """Сколько раз в топ-5 попадал указанный источник (например, дамп исходного документа).

    Проверка риска: в корпусе лежит текст исходного документа целиком, и он может
    перетягивать выдачу на себя, заслоняя карточки понятий.
    """
    counts: dict[str, int] = {}
    for res in evaluation["results"].values():
        key = f"{res['strategy']}|{res['mode']}"
        counts[key] = sum(1 for row in res["rows"] for src in row["top"] if src.startswith(prefix))
    return counts


def write_report(evaluation: dict, out: Path, *, runs: list | None = None,
                 chunk_stats_by_strategy: dict | None = None,
                 corpus: dict | None = None, skew: dict[str, int] | None = None,
                 skew_prefix: str = "99_Приложения") -> Path:
    """Отчёт сравнения: таблица метрик, статистика чанков, провалы, примеры выдачи."""
    out.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append("# Сравнение стратегий чанкинга\n")
    lines.append(f"Вопросов в наборе: **{evaluation['questions']}**, глубина оценки: top-{evaluation['k']}.\n")
    if corpus:
        lines.append(f"Корпус: **{corpus.get('notes')} заметок**, "
                     f"{corpus.get('chars', 0):,} символов "
                     f"(≈{corpus.get('pages', 0)} страниц по 1800 символов), "
                     f"каталоги: {', '.join(corpus.get('folders', []) or [])}.\n".replace(",", " "))

    lines.append("## Метрики\n")
    lines.append("| Стратегия | Поиск | recall@1 | recall@5 | MRR |")
    lines.append("|---|---|---|---|---|")
    ordered = sorted(evaluation["results"].values(), key=lambda r: (-r["mrr"], r["strategy"]))
    for res in ordered:
        lines.append(f"| `{res['strategy']}` | {res['mode']} | {res['recall@1']:.2f} | "
                     f"{res['recall@5']:.2f} | {res['mrr']:.3f} |")
    best = ordered[0]
    lines.append(f"\nЛучшая комбинация по MRR: **`{best['strategy']}` + {best['mode']}** "
                 f"(recall@1 {best['recall@1']:.2f}, recall@5 {best['recall@5']:.2f}, MRR {best['mrr']:.3f}).\n")

    if chunk_stats_by_strategy:
        lines.append("## Статистика чанков\n")
        lines.append("| Стратегия | Чанков | Всего символов | Средний | Медиана | Мин | Макс | <200 симв. | Склеено | С тегами |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
        for name, st in chunk_stats_by_strategy.items():
            lines.append(f"| `{name}` | {st['chunks']} | {st['chars_total']} | {st['chars_avg']} | "
                         f"{st['chars_median']} | {st['chars_min']} | {st['chars_max']} | "
                         f"{st['chunks_under_200']} | {st['merged']} | {st['with_tags']} |")
        lines.append("")

    if runs:
        lines.append("## Сборка индекса\n")
        lines.append("| Стратегия | Чанков | Посчитано эмбеддингов | Из кэша | Время, с |")
        lines.append("|---|---|---|---|---|")
        for run in runs:
            lines.append(f"| `{run.strategy}` | {run.chunks} | {run.embedded} | {run.cache_hits} | "
                         f"{run.seconds:.1f} |")
        lines.append("")

    lines.append("## Провалы: какие вопросы не нашли свою заметку\n")
    best_rows = best["rows"]
    missed = [r for r in best_rows if not r["rank"]]
    if not missed:
        lines.append("Провалов нет: все вопросы набора нашли свою заметку в топ-5.\n")
    else:
        lines.append("| Вопрос | Ожидалось | Что вернулось первым |")
        lines.append("|---|---|---|")
        for row in missed:
            lines.append(f"| {row['question']} | `{row['expected'][0]}` | `{row['top'][0] if row['top'] else '—'}` |")
        lines.append("")

    if skew:
        lines.append("## Проверка риска: дамп исходного документа в выдаче\n")
        total = sum(len(res["rows"]) for res in evaluation["results"].values())
        lines.append(f"В корпусе лежит текст документа-эталона целиком (`{skew_prefix}`). "
                     f"Сколько раз он попал в топ-5 из {total} запросов:\n")
        lines.append("| Комбинация | Попаданий в топ-5 |")
        lines.append("|---|---|")
        for key, count in sorted(skew.items()):
            lines.append(f"| {key} | {count} |")
        lines.append("")

    lines.append("## По вопросам: на каком месте нужная заметка\n")
    header = "| Вопрос | " + " | ".join(f"`{res['strategy']}`/{res['mode']}" for res in ordered) + " |"
    lines.append(header)
    lines.append("|---" * (len(ordered) + 1) + "|")
    by_id: dict[str, dict[str, dict]] = {}
    for res in ordered:
        key = f"{res['strategy']}|{res['mode']}"
        for row in res["rows"]:
            by_id.setdefault(row["id"], {})[key] = row
    for qid, per_key in by_id.items():
        question = next(iter(per_key.values()))["question"]
        cells = []
        for res in ordered:
            row = per_key.get(f"{res['strategy']}|{res['mode']}")
            cells.append(str(row["rank"]) if row and row["rank"] else "—")
        lines.append(f"| {question} | " + " | ".join(cells) + " |")
    lines.append("")

    lines.append("## Примеры выдачи\n")
    for res in ordered[:2]:
        lines.append(f"### `{res['strategy']}` + {res['mode']}\n")
        for row in res["rows"][:3]:
            got = row["hit"] or (row["top"][0] if row["top"] else "—")
            mark = "✅" if row["rank"] else "❌"
            lines.append(f"- {mark} **{row['question']}** → ожидалось `{row['expected'][0]}`, "
                         f"получено `{got}` (место {row['rank'] or '—'})")
        lines.append("")

    path = out / "metrics.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    (out / "metrics.json").write_text(
        json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "rows"}
                    for k, v in evaluation["results"].items()}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return path
