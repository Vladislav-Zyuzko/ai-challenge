"""Сравнение двух режимов: контрольный набор, проверка фактов и слепое судейство.

Качество ответа нельзя измерить одной цифрой, поэтому здесь две независимые меры:

1. **Покрытие фактов** — детерминированная: в эталоне заранее перечислены факты, и для
   каждого ответа проверяется, какие из них в нём есть. Это не зависит от настроения судьи.
2. **Оценка судьи** — модель оценивает ответ по эталону по шкале 0–2. Судья **слепой**:
   в промпте нет ни режима, ни источников, а порядок двух ответов чередуется по вопросам,
   чтобы позиция не влияла на оценку.

Оговорка про судью: он той же модели, что и отвечала, поэтому возможна симпатия к своим
формулировкам. Именно поэтому основная мера — покрытие фактов, а судейство — вспомогательная.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .agent import AgentReply
from .config import Config
from .rag import Answerer, MODES, RagAnswer, answer_question
from .search import Searcher

JUDGE_TEMPLATE = """Оцени ответ на вопрос по эталону.

ШКАЛА:
2 — ответ передаёт суть эталона и не противоречит ему;
1 — ответ частично верен: часть эталона есть, но не всё или есть неточности;
0 — ответ не отвечает на вопрос или содержит выдуманные факты.

ЭТАЛОН:
{expect}

ВОПРОС: {question}

ОТВЕТ:
{answer}

Ответь одной строкой строго в формате: ОЦЕНКА: <0|1|2> — <кратко почему>"""


@dataclass
class FactCheck:
    covered: int
    total: int
    missing: list[str] = field(default_factory=list)

    @property
    def share(self) -> float:
        return round(self.covered / self.total, 3) if self.total else 0.0


def load_control(path: Path) -> list[dict]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    questions = data.get("questions") if isinstance(data, dict) else data
    if not questions:
        raise ValueError(f"в {path} нет списка questions")
    for item in questions:
        if not item.get("question") or not item.get("expect"):
            raise ValueError(f"вопрос без question/expect: {item}")
        if isinstance(item.get("sources"), str):
            item["sources"] = [item["sources"]]
        item["must_contain"] = item.get("must_contain") or []
    return questions


def check_facts(answer: str, must_contain: list[list[str]]) -> FactCheck:
    """Сколько фактов эталона упомянуто: факт засчитан, если есть любая из формулировок."""
    low = answer.lower()
    missing: list[str] = []
    covered = 0
    for variants in must_contain:
        if any(str(v).lower() in low for v in variants):
            covered += 1
        else:
            missing.append(str(variants[0]))
    return FactCheck(covered=covered, total=len(must_contain), missing=missing)


def parse_judgement(text: str) -> int | None:
    """Оценка из ответа судьи. Нет оценки — None, а не «ноль»: это разные вещи."""
    match = re.search(r"ОЦЕНКА\s*:\s*([012])", text, re.IGNORECASE)
    if match:
        return int(match.group(1))
    match = re.search(r"\b([012])\b", text)
    return int(match.group(1)) if match else None


def judge_answer(agent: Answerer, item: dict, answer: RagAnswer) -> tuple[int | None, str]:
    prompt = JUDGE_TEMPLATE.format(expect=item["expect"].strip(), question=item["question"],
                                   answer=answer.answer or "(пустой ответ)")
    reply = agent.ask(prompt)
    return parse_judgement(reply.text), reply.text.strip()


def _usage(agent: object) -> tuple[int, int]:
    """Токены у клиента модели; у агента харнесса счётчиков нет."""
    usage = getattr(agent, "usage", None)
    if usage is None:
        return (0, 0)
    return (usage.prompt_tokens, usage.completion_tokens)


def run_control(questions: list[dict], searcher: Searcher, agent: Answerer, *,
                k: int = 5, max_chars: int = 6000, judge: bool = True,
                search_mode: str = "dense", expand: int = 0) -> dict:
    entries: list[dict] = []
    for index, item in enumerate(questions):
        hits = searcher.search(item["question"], k=k, mode=search_mode)
        sources = [hit["source"] for hit in hits]
        expected = set(item.get("sources") or [])
        retrieved_expected = sorted(expected & set(sources))
        # Расширение контекста соседними чанками заметки: поиск мог выбрать не тот
        # фрагмент (например, вводную строку списка вместо самого перечня).
        context_hits = hits + (searcher.neighbours(hits, expand) if expand else [])

        answers: dict[str, RagAnswer] = {}
        tokens: dict[str, tuple[int, int]] = {}
        for mode in MODES:
            before = _usage(agent)
            answers[mode] = answer_question(
                agent, item["question"], question_id=item["id"], mode=mode,
                hits=context_hits if mode == "rag" else None, max_chars=max_chars,
            )
            after = _usage(agent)
            tokens[mode] = (after[0] - before[0], after[1] - before[1])

        scores: dict[str, int | None] = {mode: None for mode in MODES}
        reasons: dict[str, str] = {mode: "" for mode in MODES}
        if judge:
            # Порядок судейства чередуется: у чётных вопросов первым оценивается rag,
            # у нечётных — no-rag. Это гасит позиционную предвзятость судьи.
            order = MODES if index % 2 == 0 else tuple(reversed(MODES))
            for mode in order:
                score, reason = judge_answer(agent, item, answers[mode])
                scores[mode] = score
                reasons[mode] = reason

        entries.append({
            "id": item["id"],
            "question": item["question"],
            "sources": sorted(expected),
            "retrieved": sources[:5],
            "retrieved_expected": retrieved_expected,
            "context_fragments": len(context_hits),
            "facts": {mode: check_facts(answers[mode].answer, item["must_contain"]).__dict__
                      for mode in MODES},
            "judge": scores,
            "judge_reason": reasons,
            "answers": {mode: answers[mode].answer for mode in MODES},
            "seconds": {mode: round(answers[mode].seconds, 2) for mode in MODES},
            "prompt_chars": {mode: len(answers[mode].prompt) for mode in MODES},
            "tokens": {mode: {"prompt": tokens[mode][0], "completion": tokens[mode][1]}
                       for mode in MODES},
            "finish_reason": {mode: answers[mode].finish_reason for mode in MODES},
        })
        print(f"  [{item['id']}] факты rag {entries[-1]['facts']['rag']['covered']}"
              f"/{entries[-1]['facts']['rag']['total']}"
              f" · no-rag {entries[-1]['facts']['no-rag']['covered']}"
              f"/{entries[-1]['facts']['no-rag']['total']}"
              f" · судья {scores['rag']}/{scores['no-rag']}")

    return {"entries": entries, "k": k, "search_mode": search_mode, "judged": judge,
            "expand": expand}


def summarize(result: dict) -> dict:
    entries = result["entries"]
    out: dict = {"questions": len(entries), "search_mode": result["search_mode"],
                 "judged": result["judged"], "expand": result.get("expand", 0)}
    for mode in MODES:
        facts = sum(e["facts"][mode]["covered"] for e in entries)
        total = sum(e["facts"][mode]["total"] for e in entries)
        scores = [e["judge"][mode] for e in entries if e["judge"][mode] is not None]
        out[mode] = {
            "facts_covered": facts,
            "facts_total": total,
            "facts_share": round(facts / total, 3) if total else 0.0,
            "judge_mean": round(sum(scores) / len(scores), 2) if scores else None,
            "judge_zeros": sum(1 for s in scores if s == 0),
            "judge_twos": sum(1 for s in scores if s == 2),
            "answers_empty": sum(1 for e in entries if not e["answers"][mode].strip()),
            "chars_avg": round(sum(len(e["answers"][mode]) for e in entries) / len(entries)),
            "seconds_avg": round(sum(e["seconds"][mode] for e in entries) / len(entries), 2),
            "prompt_tokens": sum(((e.get("tokens") or {}).get(mode) or {}).get("prompt", 0)
                                 for e in entries),
            "completion_tokens": sum(((e.get("tokens") or {}).get(mode) or {}).get("completion", 0)
                                     for e in entries),
        }
    out["retrieval_hits"] = sum(1 for e in entries if e["retrieved_expected"])
    out["retrieval_total"] = sum(1 for e in entries if e["sources"])
    return out


def write_report(result: dict, out_dir: Path, *, model: str = "", judge_caveat: str = "") -> Path:
    entries = result["entries"]
    summary = summarize(result)
    lines: list[str] = ["# RAG против «по памяти»: контрольный набор\n"]
    expand_note = (f", расширение контекста соседними чанками: {summary['expand']}"
                   if summary.get("expand") else "")
    lines.append(f"Вопросов: **{summary['questions']}**. Режим поиска для RAG: `{summary['search_mode']}`"
                 f"{expand_note}. Модель: `{model or 'по умолчанию'}`. Судейство: "
                 f"{'включено (слепое, порядок чередуется)' if result['judged'] else 'выключено'}.\n")
    lines.append("Два режима отличаются **только блоком контекста** в промпте: формулировка задачи, "
                 "требования к длине и запрет выдумывать совпадают посимвольно.\n")

    rows = []
    for entry in entries:
        hit = "✅" if entry["retrieved_expected"] else ("—" if not entry["sources"] else "❌")
        rows.append(
            f"| `{entry['id']}` | {entry['question']} | "
            f"{entry['facts']['rag']['covered']}/{entry['facts']['rag']['total']} | "
            f"{entry['facts']['no-rag']['covered']}/{entry['facts']['no-rag']['total']} | "
            f"{entry['judge']['rag'] if entry['judge']['rag'] is not None else '—'} | "
            f"{entry['judge']['no-rag'] if entry['judge']['no-rag'] is not None else '—'} | {hit} |"
        )
    lines.append("## По вопросам\n")
    lines.append("| № | Вопрос | Факты с RAG | Факты без RAG | Судья с RAG | Судья без RAG | Источник найден |")
    lines.append("|---|---|---|---|---|---|---|")
    lines.extend(rows)
    lines.append("")

    lines.append("## Итоги\n")
    lines.append("| Мера | С RAG | Без RAG |")
    lines.append("|---|---|---|")
    rag, plain = summary["rag"], summary["no-rag"]
    lines.append(f"| Покрытие фактов эталона | **{rag['facts_share']:.2f}** "
                 f"({rag['facts_covered']}/{rag['facts_total']}) | "
                 f"{plain['facts_share']:.2f} ({plain['facts_covered']}/{plain['facts_total']}) |")
    lines.append(f"| Средняя оценка судьи (0–2) | **{rag['judge_mean']}** | {plain['judge_mean']} |")
    lines.append(f"| Оценок «2» | {rag['judge_twos']} | {plain['judge_twos']} |")
    lines.append(f"| Оценок «0» | {rag['judge_zeros']} | {plain['judge_zeros']} |")
    lines.append(f"| Пустых ответов | {rag['answers_empty']} | {plain['answers_empty']} |")
    lines.append(f"| Средняя длина ответа, символов | {rag['chars_avg']} | {plain['chars_avg']} |")
    lines.append(f"| Среднее время ответа, с | {rag['seconds_avg']} | {plain['seconds_avg']} |")
    lines.append(f"| Токенов в промпте (всего) | {rag['prompt_tokens']} | {plain['prompt_tokens']} |")
    lines.append(f"| Токенов в ответах (всего) | {rag['completion_tokens']} | {plain['completion_tokens']} |")
    lines.append(f"\nНужный источник попал в топ-5 в **{summary['retrieval_hits']}** случаях "
                 f"из {summary['retrieval_total']} (это этап поиска, день 21).\n")

    lines.append("## Разбор: где разница видна наглядно\n")
    ranked = sorted(entries, key=lambda e: (e["facts"]["rag"]["covered"] - e["facts"]["no-rag"]["covered"]),
                    reverse=True)
    for entry in ranked[:3]:
        delta = entry["facts"]["rag"]["covered"] - entry["facts"]["no-rag"]["covered"]
        if delta <= 0:
            continue
        lines.append(f"### {entry['id']}. {entry['question']}\n")
        lines.append(f"Разница в покрытии фактов: **+{delta}** в пользу RAG.\n")
        for mode, title in (("rag", "С RAG"), ("no-rag", "Без RAG")):
            facts = entry["facts"][mode]
            lines.append(f"**{title}** (фактов {facts['covered']}/{facts['total']}"
                         + (f", не хватило: {', '.join(facts['missing'])}" if facts["missing"] else "")
                         + f"; судья {entry['judge'][mode] if entry['judge'][mode] is not None else '—'}):\n")
            lines.append(f"> {entry['answers'][mode].strip()[:900]}\n")
        lines.append("")

    lines.append("## Где RAG не помог\n")
    weak = [e for e in entries if e["facts"]["rag"]["covered"] <= e["facts"]["no-rag"]["covered"]]
    if not weak:
        lines.append("Таких вопросов нет: в режиме с RAG покрытие фактов не ниже, чем без него.\n")
    else:
        for entry in weak:
            lines.append(f"- `{entry['id']}` {entry['question']} — "
                         f"факты {entry['facts']['rag']['covered']}/{entry['facts']['rag']['total']} "
                         f"против {entry['facts']['no-rag']['covered']}/{entry['facts']['no-rag']['total']}, "
                         f"источник найден: {'да' if entry['retrieved_expected'] else 'нет'}")
        lines.append("")

    lines.append("## Ограничения измерения\n")
    lines.append("- **Судья — та же модель**, что отвечала: возможна симпатия к своим формулировкам. "
                 "Поэтому основная мера — покрытие фактов, судейство вспомогательное.")
    lines.append("- **Покрытие фактов — подстрочная проверка** по списку формулировок: верный по смыслу, "
                 "но иначе сформулированный ответ может не засчитаться. Ошибка систематическая "
                 "и действует на оба режима одинаково.")
    lines.append(f"- **Один прогон, {summary['questions']} вопросов**: различия в 1–2 факта — это шум, "
                 "устойчивы только крупные расхождения.")
    if judge_caveat:
        lines.append(f"- {judge_caveat}")
    lines.append("")

    path = out_dir / "rag-comparison.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "rag-answers.json").write_text(
        json.dumps({"summary": summary, "entries": entries}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return path
