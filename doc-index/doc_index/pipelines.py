"""Пайплайны дня 23: второй этап после поиска и сравнение режимов.

Пайплайн — это фиксированная цепочка «поиск → второй этап → контекст». Сравнивать
их нужно на одном и том же наборе вопросов и с одинаковым построением промпта,
иначе разница будет мериться не фильтром, а чем-то ещё.

    no-rag      без поиска вообще — эталонный пол
    baseline    dense top-5, как в дне 22
    threshold   top-20 → порог (маржа от лучшего) → top-5
    heuristic   top-20 → пересечение термов → top-5
    cross       top-20 → cross-encoder bge-reranker + порог по его оценке → top-5
    full        multi-query rewrite → RRF → cross-encoder + порог → top-5

Порядок внутри пайплайна важен: фильтр работает **до** расширения соседними
чанками, потому что у соседей оценка 0.0 и любой порог их выбросил бы.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .compare import check_facts, judge_answer
from .config import Config
from .rag import Answerer, answer_question, usage
from .rerank import CrossEncoder, RerankInfo, rerank, threshold_filter
from .rewrite import multi_query_search, rewrite_query
from .search import Searcher

PIPELINES = ("no-rag", "baseline", "threshold", "heuristic", "cross", "full")
RAG_PIPELINES = tuple(name for name in PIPELINES if name != "no-rag")


@dataclass
class Filters:
    """Настройки второго этапа: «топ-K до» и «топ-K после» + пороги."""

    candidates: int = 20          # топ-K до фильтрации
    k: int = 5                    # топ-K после фильтрации
    expand: int = 1               # соседние чанки (после фильтра)
    search_mode: str = "dense"
    margin: float | None = 0.08   # относительный порог: маржа от лучшего
    min_dense: float | None = None
    min_score: float | None = 0.2  # порог для heuristic/cross
    min_keep: int = 1
    mmr_lambda: float = 0.7


@dataclass
class Retrieved:
    """Что пайплайн достал: отобранные фрагменты, контекст и статистика."""

    hits: list[dict] = field(default_factory=list)
    context_hits: list[dict] = field(default_factory=list)
    info: RerankInfo | None = None
    variants: list[str] = field(default_factory=list)
    rewrite_source: str = ""

    @property
    def sources(self) -> list[str]:
        return [hit["source"] for hit in self.hits]


def rewrite_variants(agent: Answerer | None, question: str) -> tuple[list[str], str]:
    """Варианты запроса для multi-query поиска, всегда вместе с исходным вопросом.

    Исходный вопрос идёт первым не для симметрии: переформулировка может оказаться
    хуже оригинала, и без него мы бы потеряли то, что и так находилось. RRF всё
    равно поднимет фрагменты, найденные несколькими вариантами.
    """
    if agent is None:
        from .rewrite import expand_abbreviations
        expanded = expand_abbreviations(question)
        return ([question, expanded] if expanded != question else [question]), "heuristic"
    variants, source = rewrite_query(agent, question)
    merged = [question] + [v for v in variants if v.strip().lower() != question.strip().lower()]
    return merged, source


def retrieve(searcher: Searcher, question: str, *, pipeline: str, filters: Filters,
             encoder: CrossEncoder | None = None, agent: Answerer | None = None) -> Retrieved:
    """Прогнать один пайплайн: поиск → второй этап → контекст."""
    if pipeline not in PIPELINES:
        raise ValueError(f"неизвестный пайплайн: {pipeline}")
    if pipeline == "no-rag":
        return Retrieved()

    if pipeline == "baseline":
        hits = searcher.search(question, k=filters.k, mode=filters.search_mode,
                               candidates=filters.candidates)
        info = RerankInfo(method="none", candidates=len(hits), kept=len(hits))
        context = hits + (searcher.neighbours(hits, filters.expand) if filters.expand else [])
        return Retrieved(hits=hits, context_hits=context, info=info)

    # Кандидатов берём с запасом: фильтру нужно из чего выбирать.
    variants: list[str] = []
    rewrite_source = ""
    if pipeline == "full":
        variants, rewrite_source = rewrite_variants(agent, question)
        pool = multi_query_search(searcher, variants, k=filters.candidates,
                                  mode=filters.search_mode, candidates=filters.candidates)
    else:
        pool = searcher.search(question, k=filters.candidates, mode=filters.search_mode,
                               candidates=filters.candidates)

    if pipeline == "threshold":
        method = "threshold"
    elif pipeline == "heuristic":
        method = "heuristic"
    else:
        method = "cross"

    kept, info = rerank(
        pool, method=method, query=question, top_k=filters.k,
        min_dense=filters.min_dense, margin=filters.margin,
        min_score=filters.min_score, min_keep=filters.min_keep,
        encoder=encoder, index=searcher.index, ids=searcher.ids,
        query_vector=None, mmr_lambda=filters.mmr_lambda,
    )
    # Порядок фрагментов сохраняем таким, каким его вернул второй этап: у
    # cross-encoder и heuristic это их собственная ранжировка, и пересортировка
    # по `rank` из поиска обнулила бы решение реранкера. `rank` при этом
    # пересчитываем — он означает место в итоговом контексте.
    hits = kept
    for position, piece in enumerate(hits, start=1):
        piece["rank"] = position
    context = hits + (searcher.neighbours(hits, filters.expand) if filters.expand else [])
    return Retrieved(hits=hits, context_hits=context, info=info, variants=variants,
                     rewrite_source=rewrite_source)


def precision(hits: list[dict], expected: set[str]) -> float | None:
    """Доля фрагментов контекста, которые действительно из ожидаемой заметки."""
    if not hits:
        return None
    return round(sum(1 for hit in hits if hit["source"] in expected) / len(hits), 3)


def run_pipelines(questions: list[dict], searcher: Searcher, agent: Answerer, *,
                  pipelines: tuple[str, ...] = PIPELINES, filters: Filters | None = None,
                  judge: bool = True, max_chars: int = 6000,
                  encoder: CrossEncoder | None = None) -> dict:
    """Прогон всех пайплайнов на одном наборе вопросов."""
    filters = filters or Filters()
    entries: list[dict] = []
    active = tuple(name for name in pipelines if name in PIPELINES)
    for index, item in enumerate(questions):
        expected = set(item.get("sources") or [])
        retrieved: dict[str, Retrieved] = {}
        retrieve_tokens: dict[str, tuple[int, int]] = {}
        for name in active:
            # Вызовы rewrite тоже расходуют токены, и они происходят до ответа:
            # считаем их отдельно, иначе стоимость пайплайна `full` занижается.
            before = usage(agent)
            retrieved[name] = retrieve(searcher, item["question"], pipeline=name,
                                       filters=filters, encoder=encoder, agent=agent)
            after = usage(agent)
            retrieve_tokens[name] = (after[0] - before[0], after[1] - before[1])

        # Порядок ответов и судейства чередуется по вопросам: у каждого вопроса
        # свой сдвиг, чтобы позиция не влияла на оценку судьи.
        order = list(active)
        shift = index % len(order) if order else 0
        order = order[shift:] + order[:shift]

        answers: dict[str, object] = {}
        tokens: dict[str, tuple[int, int]] = {}
        for name in order:
            got = retrieved[name]
            before = usage(agent)
            answers[name] = answer_question(
                agent, item["question"], question_id=item["id"], mode="rag",
                hits=got.context_hits if name != "no-rag" else None, max_chars=max_chars,
            )
            after = usage(agent)
            tokens[name] = (after[0] - before[0], after[1] - before[1])

        scores: dict[str, int | None] = {}
        reasons: dict[str, str] = {}
        if judge:
            for name in reversed(order):
                score, reason = judge_answer(agent, item, answers[name])
                scores[name] = score
                reasons[name] = reason
        else:
            scores = {name: None for name in active}

        entry: dict = {
            "id": item["id"],
            "question": item["question"],
            "sources": sorted(expected),
            "variants": {name: retrieved[name].variants for name in active
                         if retrieved[name].variants},
            "rewrite_source": {name: retrieved[name].rewrite_source for name in active
                               if retrieved[name].rewrite_source},
            "pipelines": {},
        }
        for name in active:
            got = retrieved[name]
            info = got.info
            entry["pipelines"][name] = {
                "retrieved": [hit["source"] for hit in got.hits],
                "retrieved_expected": sorted(expected & set(got.sources)),
                "precision": precision(got.hits, expected),
                "candidates": info.candidates if info else 0,
                "kept": len(got.hits),
                "dropped": info.dropped if info else 0,
                "context_fragments": len(got.context_hits),
                "context_chars": sum(len(hit["text"]) for hit in got.context_hits),
                "scores": [round(float(s), 4) for s in (info.scores if info else [])],
                "answer": answers[name].answer,
                "prompt_chars": len(answers[name].prompt),
                "seconds": round(answers[name].seconds, 2),
                "tokens": {"prompt": tokens[name][0], "completion": tokens[name][1],
                           "retrieve_prompt": retrieve_tokens[name][0],
                           "retrieve_completion": retrieve_tokens[name][1]},
                "finish_reason": answers[name].finish_reason,
                "facts": check_facts(answers[name].answer, item["must_contain"]).__dict__,
                "judge": scores.get(name),
                "judge_reason": reasons.get(name, ""),
            }
        entries.append(entry)
        summary = " · ".join(
            f"{name} {entry['pipelines'][name]['facts']['covered']}"
            f"/{entry['pipelines'][name]['facts']['total']}"
            for name in active
        )
        print(f"  [{item['id']}] {summary}")

    return {"entries": entries, "pipelines": list(active), "judged": judge,
            "filters": filters.__dict__, "max_chars": max_chars}


def summarize_pipelines(result: dict) -> dict:
    """Сводка по пайплайнам: качество ответа + чистота контекста."""
    entries = result["entries"]
    out: dict = {"questions": len(entries), "pipelines": result["pipelines"],
                 "judged": result["judged"], "filters": result.get("filters", {})}
    for name in result["pipelines"]:
        cells = [e["pipelines"][name] for e in entries]
        facts = sum(c["facts"]["covered"] for c in cells)
        total = sum(c["facts"]["total"] for c in cells)
        scores = [c["judge"] for c in cells if c["judge"] is not None]
        precisions = [c["precision"] for c in cells if c["precision"] is not None]
        out[name] = {
            "facts_covered": facts,
            "facts_total": total,
            "facts_share": round(facts / total, 3) if total else 0.0,
            "judge_mean": round(sum(scores) / len(scores), 2) if scores else None,
            "judge_zeros": sum(1 for s in scores if s == 0),
            "judge_twos": sum(1 for s in scores if s == 2),
            "answers_empty": sum(1 for c in cells if not c["answer"].strip()),
            "retrieval_hits": sum(1 for c in cells if c["retrieved_expected"]),
            "precision": round(sum(precisions) / len(precisions), 3) if precisions else None,
            "candidates_avg": round(sum(c["candidates"] for c in cells) / len(cells), 1),
            "kept_avg": round(sum(c["kept"] for c in cells) / len(cells), 2),
            "context_fragments_avg": round(sum(c["context_fragments"] for c in cells) / len(cells), 2),
            "context_chars_avg": round(sum(c["context_chars"] for c in cells) / len(cells)),
            "chars_avg": round(sum(len(c["answer"]) for c in cells) / len(cells)),
            "seconds_avg": round(sum(c["seconds"] for c in cells) / len(cells), 2),
            "prompt_tokens": sum(c["tokens"]["prompt"] for c in cells),
            "completion_tokens": sum(c["tokens"]["completion"] for c in cells),
            "retrieve_tokens": sum(c["tokens"].get("retrieve_prompt", 0) for c in cells),
        }
    return out


TITLES = {
    "no-rag": "Без RAG",
    "baseline": "baseline",
    "threshold": "threshold",
    "heuristic": "heuristic",
    "cross": "cross",
    "full": "full",
}


def write_report(result: dict, out_dir: Path, *, model: str = "", encoder_name: str = "",
                 notes: list[str] | None = None) -> Path:
    """Отчёт сравнения пайплайнов: качество ответа и чистота контекста."""
    entries = result["entries"]
    names = result["pipelines"]
    summary = summarize_pipelines(result)
    filters = result.get("filters", {})
    lines: list[str] = ["# Реранкинг и фильтрация: сравнение пайплайнов\n"]
    lines.append(f"Вопросов: **{summary['questions']}**, пайплайнов: **{len(names)}**. "
                 f"Модель ответов: `{model or 'по умолчанию'}`"
                 + (f", реранкер: `{encoder_name}`" if encoder_name else "") + ".\n")
    lines.append(f"Топ-K до фильтрации: **{filters.get('candidates')}**, после: "
                 f"**{filters.get('k')}**, соседних чанков: {filters.get('expand')}, "
                 f"поиск: `{filters.get('search_mode')}`, маржа: {filters.get('margin')}, "
                 f"порог оценки: {filters.get('min_score')}.\n")
    lines.append("Пайплайны отличаются **только способом отбора фрагментов**: правила ответа, "
                 "модель, бюджет контекста и построение промпта совпадают.\n")

    lines.append("## По вопросам\n")
    header = "| № | Вопрос | " + " | ".join(TITLES.get(n, n) for n in names) + " | Precision |"
    lines.append(header)
    lines.append("|---" * (len(names) + 3) + "|")
    for entry in entries:
        cells = []
        for name in names:
            cell = entry["pipelines"][name]
            mark = "—" if cell["judge"] is None else cell["judge"]
            cells.append(f"{cell['facts']['covered']}/{cell['facts']['total']} · {mark}")
        precision_cells = [entry["pipelines"][n]["precision"] for n in names
                           if entry["pipelines"][n]["precision"] is not None]
        prec = f"{sum(precision_cells) / len(precision_cells):.2f}" if precision_cells else "—"
        lines.append(f"| `{entry['id']}` | {entry['question']} | " + " | ".join(cells) + f" | {prec} |")
    lines.append("")
    lines.append("В ячейке: покрытие фактов эталона · оценка судьи (0–2). "
                 "Precision — доля фрагментов контекста из ожидаемой заметки (без `no-rag`).\n")

    lines.append("## Итоги\n")
    lines.append("| Мера | " + " | ".join(TITLES.get(n, n) for n in names) + " |")
    lines.append("|---" * (len(names) + 1) + "|")

    def row(title: str, key: str, fmt: str = "{}") -> str:
        cells = []
        for name in names:
            value = summary[name][key]
            cells.append(fmt.format(value) if value is not None else "—")
        return f"| {title} | " + " | ".join(cells) + " |"

    lines.append(row("**Покрытие фактов эталона**", "facts_share", "**{:.2f}**"))
    lines.append(row("Покрытых фактов", "facts_covered"))
    lines.append(row("Средняя оценка судьи", "judge_mean"))
    lines.append(row("Оценок «2»", "judge_twos"))
    lines.append(row("Оценок «0»", "judge_zeros"))
    lines.append(row("Нужный источник найден", "retrieval_hits"))
    lines.append(row("Precision контекста", "precision"))
    lines.append(row("Кандидатов до фильтра", "candidates_avg"))
    lines.append(row("Фрагментов после фильтра", "kept_avg"))
    lines.append(row("Фрагментов в промпте", "context_fragments_avg"))
    lines.append(row("Символов контекста", "context_chars_avg"))
    lines.append(row("Токенов в промпте (всего)", "prompt_tokens"))
    lines.append(row("Токенов на rewrite", "retrieve_tokens"))
    lines.append(row("Среднее время ответа, с", "seconds_avg"))
    lines.append(row("Пустых ответов", "answers_empty"))
    lines.append("")

    lines.append("## Разбор по вопросам\n")
    for entry in entries:
        variants = entry.get("variants") or {}
        if variants:
            for name, items in variants.items():
                source = entry.get("rewrite_source", {}).get(name, "")
                lines.append(f"**{entry['id']} · {name}** ({source}): "
                             + " ⟂ ".join(f"«{v}»" for v in items) + "\n")
        rows = []
        for name in names:
            cell = entry["pipelines"][name]
            mark = "—" if cell["judge"] is None else cell["judge"]
            rows.append(f"{TITLES.get(name, name)}: {cell['facts']['covered']}/{cell['facts']['total']}"
                        f", судья {mark}, precision {cell['precision'] if cell['precision'] is not None else '—'}")
        lines.append(f"### {entry['id']}. {entry['question']}\n")
        lines.append("; ".join(rows) + "\n")
        for name in names:
            if name == "no-rag":
                continue
            cell = entry["pipelines"][name]
            if cell["candidates"]:
                lines.append(f"- `{name}`: отобрано {cell['kept']} из {cell['candidates']} "
                             f"(отсеяно {cell['dropped']}), фрагменты: "
                             + ", ".join(f"`{Path(s).stem}`" for s in cell["retrieved"][:5]))
        lines.append("")

    if notes:
        lines.append("## Заметки\n")
        for note in notes:
            lines.append(f"- {note}")
        lines.append("")

    path = out_dir / "rerank-comparison.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "rerank-answers.json").write_text(
        json.dumps({"summary": summary, "entries": entries}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return path
