"""Проверка дня 24: обязательные источники и цитаты + режим «не знаю».

Прогоняет набор вопросов через RAG в строгом режиме и по каждому ответу считает
то, что требует задание:

- **есть ли источники** — блок ИСТОЧНИКИ не пуст, и все названные источники
  действительно были в контексте (выдуманные ловятся отдельно);
- **есть ли цитаты** — блок ЦИТАТЫ не пуст, и каждая цитата дословно встречается
  в том фрагменте, на который ссылается её номер;
- **совпадает ли смысл ответа с цитатами** — слепой судья отдельным промптом;
- **режим «не знаю»** — на вопросы, которых в корпусе нет (`answerable: false`),
  ассистент обязан отказаться и попросить уточнение, а не сочинить ответ.

Отдельно считаются запрещённые формулировки (`must_not_contain`): ими ловится
выдуманный ответ на несуществующую тему — например, конкретная цифра курса валют.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .citations import (SUPPORT_TEMPLATE, ParsedAnswer, QuoteCheck, check_citations,
                        parse_answer, quotes_block_text)
from .compare import _usage, check_facts, parse_judgement
from .config import Config
from .pipelines import Filters, retrieve
from .rag import Answerer, answer_question
from .search import Searcher

# Формулировки, которые считаются просьбой уточнить.
CLARIFY_RE = ("уточн", "конкретизир", "какая именно", "какие именно", "о чём именно", "о чем именно")


def check_forbidden(answer: str, must_not_contain: list[list[str]] | None) -> list[str]:
    """Найти запрещённые формулировки: признак выдуманного ответа."""
    low = (answer or "").lower()
    hits: list[str] = []
    for variants in must_not_contain or []:
        for variant in variants:
            if str(variant).lower() in low:
                hits.append(str(variant))
    return hits


def asks_clarification(answer: str) -> bool:
    low = (answer or "").lower()
    return any(marker in low for marker in CLARIFY_RE)


@dataclass
class VerifyRow:
    """Результат проверки одного вопроса."""

    entry: dict


def run_verification(questions: list[dict], searcher: Searcher, agent: Answerer, *,
                     filters: Filters | None = None, judge: bool = True,
                     max_chars: int = 6000, min_dense: float | None = 0.5,
                     topics: str = "", verbose: bool = True) -> dict:
    """Прогон набора в строгом режиме со всеми проверками дня 24."""
    filters = filters or Filters()
    entries: list[dict] = []
    for item in questions:
        answerable = item.get("answerable", True)
        got = retrieve(searcher, item["question"], pipeline="threshold", filters=filters)
        before = _usage(agent)
        # Порог отказа применяется ко всем вопросам: «обязан сказать не знаю» — это
        # правило поведения, а не свойство отдельной группы вопросов.
        reply = answer_question(
            agent, item["question"], question_id=item["id"], mode="rag",
            hits=got.context_hits, max_chars=max_chars, strict=True,
            min_dense=min_dense, topics=topics,
        )
        after = _usage(agent)
        parsed: ParsedAnswer = parse_answer(reply.answer)
        refused = reply.refused or parsed.refusal
        # У отказа проверять нечего: источников и цитат в нём нет по замыслу, а слова
        # в кавычках — часть объяснения, а не цитата. Иначе отказ выглядел бы как
        # выдуманная цитата.
        check = QuoteCheck() if refused else check_citations(parsed, got.context_hits)
        support: int | None = None
        support_reason = ""
        if judge and not refused:
            prompt = SUPPORT_TEMPLATE.format(question=item["question"], answer=parsed.answer,
                                             quotes=quotes_block_text(parsed.quotes))
            judge_reply = agent.ask(prompt)
            support = parse_judgement(judge_reply.text)
            support_reason = judge_reply.text.strip()

        forbidden = check_forbidden(reply.answer, item.get("must_not_contain"))
        facts = check_facts(reply.answer, item.get("must_contain") or [])
        clarify = asks_clarification(reply.answer)

        entries.append({
            "id": item["id"],
            "question": item["question"],
            "answerable": answerable,
            "strict": True,
            "refused": refused,
            "refused_by_gate": reply.refused,
            "answer": reply.answer,
            "parsed": {
                "answer": parsed.answer,
                "sources": [s.raw for s in parsed.sources],
                "quotes": [q.text for q in parsed.quotes],
                "format_ok": parsed.format_ok,
                "problems": parsed.problems,
            },
            "sources_present": bool(parsed.sources),
            "quotes_present": bool(parsed.quotes),
            "format_ok": parsed.format_ok,
            "sources_total": check.sources_total,
            "sources_real": check.sources_real,
            "unknown_sources": check.unknown_sources,
            "quotes_total": check.total,
            "quotes_exact": check.exact,
            "quotes_verbatim": check.verbatim,
            "quotes_misplaced": check.misplaced,
            "quotes_unnumbered": check.unnumbered,
            "fabricated_quotes": check.fabricated,
            "context_chunk_ids": [hit["chunk_id"] for hit in got.context_hits],
            "support": support,
            "support_reason": support_reason,
            "clarify_requested": clarify,
            "forbidden": forbidden,
            "facts": facts.__dict__,
            "best_score": reply.best_score,
            "context_fragments": len(got.context_hits),
            "prompt_chars": len(reply.prompt),
            "seconds": round(reply.seconds, 2),
            "tokens": {"prompt": after[0] - before[0], "completion": after[1] - before[1]},
        })
        if verbose:
            mark = "отказ" if refused else ("ok" if parsed.format_ok else "формат!")
            print(f"  [{item['id']}] {mark} · источники {check.sources_real}/{check.sources_total}"
                  f" · цитаты {check.verbatim}/{check.total}"
                  + (f" (точно по ссылке {check.exact})" if check.misplaced else "")
                  + (f" · судья {support}" if support is not None else "")
                  + (f" · уточнение {'да' if clarify else 'нет'}" if not answerable else ""))

    return {"entries": entries, "filters": filters.__dict__, "min_dense": min_dense,
            "judged": judge, "topics": topics}


def summarize(result: dict) -> dict:
    """Сводка по требованиям задания.

    Метрики источников и цитат считаются по **отвеченным** вопросам: у отказа их
    нет по замыслу, и подмешивать его в знаменатель значило бы наказывать за
    правильное поведение.
    """
    entries = result["entries"]
    answerable = [e for e in entries if e["answerable"]]
    unanswerable = [e for e in entries if not e["answerable"]]
    answered = [e for e in answerable if not e["refused"]]
    supports = [e["support"] for e in answered if e["support"] is not None]
    quotes_total = sum(e["quotes_total"] for e in answered)
    quotes_verbatim = sum(e["quotes_verbatim"] for e in answered)
    quotes_exact = sum(e["quotes_exact"] for e in answered)
    return {
        "questions": len(entries),
        "answerable": len(answerable),
        "answered": len(answered),
        "unanswerable": len(unanswerable),
        "with_sources": sum(1 for e in answered if e["sources_present"]),
        "with_quotes": sum(1 for e in answered if e["quotes_present"]),
        "format_ok": sum(1 for e in answered if e["format_ok"]),
        "sources_total": sum(e["sources_total"] for e in answered),
        "sources_real": sum(e["sources_real"] for e in answered),
        "unknown_sources": sum(len(e["unknown_sources"]) for e in answered),
        "quotes_total": quotes_total,
        "quotes_exact": quotes_exact,
        "quotes_verbatim": quotes_verbatim,
        "quotes_verbatim_share": round(quotes_verbatim / quotes_total, 3) if quotes_total else 0.0,
        "quotes_attribution_share": round(quotes_exact / quotes_total, 3) if quotes_total else 0.0,
        "quotes_misplaced": sum(len(e["quotes_misplaced"]) for e in answered),
        "quotes_unnumbered": sum(len(e["quotes_unnumbered"]) for e in answered),
        "fabricated_quotes": sum(len(e["fabricated_quotes"]) for e in answered),
        "support_mean": round(sum(supports) / len(supports), 2) if supports else None,
        "support_zeros": sum(1 for s in supports if s == 0),
        "refusals_expected": len(unanswerable),
        "refusals_done": sum(1 for e in unanswerable if e["refused"]),
        "refusals_with_clarify": sum(1 for e in unanswerable if e["refused"] and e["clarify_requested"]),
        "refusals_by_gate": sum(1 for e in unanswerable if e["refused_by_gate"]),
        "forbidden_hits": sum(len(e["forbidden"]) for e in entries),
        "false_refusals": sum(1 for e in answerable if e["refused"]),
        "gate_refusals_on_answerable": sum(1 for e in answerable if e["refused_by_gate"]),
        "facts_covered": sum(e["facts"]["covered"] for e in answerable),
        "facts_total": sum(e["facts"]["total"] for e in answerable),
        "prompt_tokens": sum(e["tokens"]["prompt"] for e in entries),
        "seconds_avg": round(sum(e["seconds"] for e in entries) / len(entries), 2),
    }


def brief(searcher: Searcher, agent: Answerer, question: str, *, filters: Filters | None = None,
          max_chars: int = 6000, min_dense: float | None = 0.5, topics: str = "",
          judge: bool = False) -> dict:
    """Справка по базе для одного вопроса: строгий ответ + машинная проверка.

    Это тот же путь, что в `verify`, но без набора и без статистики: нужен один
    ответ фиксированной формы и вердикт, не выдуманы ли источники и цитаты.
    Судья по умолчанию выключен — в интерактивной команде важнее скорость, а
    дословность и реальность источников проверяются кодом.
    """
    filters = filters or Filters()
    got = retrieve(searcher, question, pipeline="threshold", filters=filters)
    reply = answer_question(agent, question, question_id="brief", mode="rag",
                            hits=got.context_hits, max_chars=max_chars, strict=True,
                            min_dense=min_dense, topics=topics)
    parsed = parse_answer(reply.answer)
    refused = reply.refused or parsed.refusal
    check = QuoteCheck() if refused else check_citations(parsed, got.context_hits)
    support: int | None = None
    support_reason = ""
    if judge and not refused:
        prompt = SUPPORT_TEMPLATE.format(question=question, answer=parsed.answer,
                                         quotes=quotes_block_text(parsed.quotes))
        judge_reply = agent.ask(prompt)
        support = parse_judgement(judge_reply.text)
        support_reason = judge_reply.text.strip()
    return {
        "question": question,
        "answer": reply.answer,
        "parsed": parsed,
        "check": check,
        "refused": refused,
        "refused_by_gate": reply.refused,
        "best_score": reply.best_score,
        "support": support,
        "support_reason": support_reason,
        "context_fragments": len(got.context_hits),
        "sources": [hit["source"] for hit in got.hits],
        "seconds": round(reply.seconds, 2),
    }


def format_brief(result: dict) -> str:
    """Печать справки: ответ как есть плюс строка машинной проверки."""
    check: QuoteCheck = result["check"]
    lines = [result["answer"].strip()]
    if result["refused"]:
        source = "порогом, без вызова модели" if result["refused_by_gate"] else "моделью"
        lines.append("")
        lines.append(f"— отказ: {source} · лучшее совпадение "
                     f"{result['best_score']:.3f} · фрагментов {result['context_fragments']}")
        return "\n".join(lines)
    parts = [
        f"источники {check.sources_real}/{check.sources_total} реальны",
        f"цитаты {check.verbatim}/{check.total} дословны",
    ]
    if check.misplaced:
        parts.append(f"смещённых ссылок {len(check.misplaced)}")
    parts.append(f"выдуманных {len(check.fabricated)}")
    parts.append(f"фрагментов {result['context_fragments']}")
    if result["best_score"] is not None:
        parts.append(f"лучшее совпадение {result['best_score']:.3f}")
    if result["support"] is not None:
        parts.append(f"судья {result['support']}")
    lines.append("")
    lines.append("— проверка: " + " · ".join(parts))
    return "\n".join(lines)


def write_report(result: dict, out_dir: Path, *, model: str = "", strategy: str = "",
                 encoder_name: str = "") -> Path:
    """Отчёт проверки: обязательные источники и цитаты + режим «не знаю»."""
    entries = result["entries"]
    summary = summarize(result)
    lines: list[str] = ["# Источники, цитаты и режим «не знаю»\n"]
    lines.append(f"Вопросов: **{summary['questions']}** "
                 f"(отвечаемых {summary['answerable']}, вне корпуса {summary['unanswerable']}). "
                 f"Модель: `{model or 'по умолчанию'}`"
                 + (f", стратегия `{strategy}`" if strategy else "")
                 + (f", реранкер `{encoder_name}`" if encoder_name else "") + ".\n")
    filters = result.get("filters", {})
    lines.append(f"Контекст: топ-{filters.get('k')} из {filters.get('candidates')} кандидатов, "
                 f"маржа {filters.get('margin')}, соседние чанки {filters.get('expand')}, "
                 f"порог отказа **{result.get('min_dense')}**.\n")
    lines.append("Ответы запрошены строгим контрактом: `ОТВЕТ` + `ИСТОЧНИКИ` + `ЦИТАТЫ`. "
                 "Источники и цитаты проверяются кодом, совпадение смысла — отдельным вопросом судье.\n")

    lines.append("## Требования задания\n")
    answered = summary["answered"]
    lines.append(f"Отвечено вопросов: **{answered}** из {summary['answerable']} "
                 f"(отвечаемых), отказов на них: {summary['false_refusals']}.\n")
    lines.append("| Требование | Результат |")
    lines.append("|---|---|")
    lines.append(f"| Источники есть в каждом ответе | **{summary['with_sources']}** из {answered} |")
    lines.append(f"| Цитаты есть в каждом ответе | **{summary['with_quotes']}** из {answered} |")
    lines.append(f"| Формат ответа соблюдён | {summary['format_ok']} из {answered} |")
    lines.append(f"| Источники реальны (нет выдуманных) | {summary['sources_real']} из "
                 f"{summary['sources_total']}, выдуманных: {summary['unknown_sources']} |")
    lines.append(f"| Цитаты дословны | {summary['quotes_verbatim']} из {summary['quotes_total']} "
                 f"({summary['quotes_verbatim_share']:.2f}) |")
    lines.append(f"| Цитаты приписаны тому же фрагменту | {summary['quotes_exact']} из "
                 f"{summary['quotes_total']} ({summary['quotes_attribution_share']:.2f}), "
                 f"смещённых ссылок: {summary['quotes_misplaced']} |")
    lines.append(f"| **Выдуманных цитат** | **{summary['fabricated_quotes']}** |")
    lines.append(f"| Смысл подтверждён цитатами (судья 0–2) | **{summary['support_mean']}**"
                 + (f", нулей: {summary['support_zeros']}" if summary["support_zeros"] else "") + " |")
    lines.append(f"| Отказ на вопросах вне корпуса | **{summary['refusals_done']}** из "
                 f"{summary['refusals_expected']}"
                 + (f" (порогом: {summary['refusals_by_gate']})" if summary["refusals_by_gate"] else "")
                 + " |")
    lines.append(f"| Отказ с просьбой уточнить | {summary['refusals_with_clarify']} из "
                 f"{summary['refusals_expected']} |")
    lines.append(f"| Запрещённые формулировки в ответах | {summary['forbidden_hits']} |")
    lines.append(f"| Покрытие фактов эталона (отвечаемые) | {summary['facts_covered']} из "
                 f"{summary['facts_total']} |")
    lines.append("")

    lines.append("## По вопросам\n")
    lines.append("| № | Вопрос | Отказ | Источники | Цитаты дословно | Судья | Уточнение |")
    lines.append("|---|---|---|---|---|---|---|")
    for entry in entries:
        refuse = "да" if entry["refused"] else "—"
        sources = f"{entry['sources_real']}/{entry['sources_total']}" if entry["sources_total"] else "—"
        quotes = f"{entry['quotes_verbatim']}/{entry['quotes_total']}" if entry["quotes_total"] else "—"
        support = entry["support"] if entry["support"] is not None else "—"
        clarify = "да" if entry["clarify_requested"] else "—"
        lines.append(f"| `{entry['id']}` | {entry['question']} | {refuse} | {sources} | "
                     f"{quotes} | {support} | {clarify} |")
    lines.append("")

    lines.append("## Разбор ответов\n")
    for entry in entries:
        lines.append(f"### {entry['id']}. {entry['question']}\n")
        if entry["refused"]:
            lines.append(f"Отказ{' (порогом, без вызова модели)' if entry['refused_by_gate'] else ''}"
                         f", лучшее совпадение {entry['best_score']}.\n")
            lines.append(f"> {entry['answer'].strip()}\n")
            continue
        parsed = entry["parsed"]
        lines.append(f"Источники: {entry['sources_real']}/{entry['sources_total']}"
                     + (f" · выдуманные: {', '.join(entry['unknown_sources'])}"
                        if entry["unknown_sources"] else "")
                     + f" · цитаты дословно: {entry['quotes_verbatim']}/{entry['quotes_total']}"
                     + (f" (по ссылке точно: {entry['quotes_exact']}, смещено: {len(entry['quotes_misplaced'])})"
                        if entry["quotes_misplaced"] else "")
                     + (f" · выдуманные цитаты: {'; '.join(entry['fabricated_quotes'])[:200]}"
                        if entry["fabricated_quotes"] else "")
                     + (f" · судья {entry['support']}" if entry["support"] is not None else "")
                     + ".\n")
        lines.append(f"> {parsed['answer'].strip() or entry['answer'].strip()[:400]}\n")
        if parsed["quotes"]:
            lines.append("Цитаты:")
            for quote in parsed["quotes"][:4]:
                lines.append(f"- «{quote[:220]}»")
            lines.append("")
        if entry["forbidden"]:
            lines.append(f"⚠ запрещённые формулировки: {', '.join(entry['forbidden'])}\n")

    path = out_dir / "citations.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "citations.json").write_text(
        json.dumps({"summary": summary, "entries": entries}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return path
