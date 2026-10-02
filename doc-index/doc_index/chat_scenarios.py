"""Проверка длинных сценариев чата (день 25): источники, память задачи, удержание цели.

Задание требует прогнать 2 сценария по 10–15 сообщений и проверить, что ассистент
**не теряет цель** и **продолжает выдавать ответы с источниками**. Поэтому проверки
идут по каждому ходу, а не по всему диалогу целиком:

- **источники** — есть ли в ответе ссылка на заметку базы (имя `.md`) или на строки;
- **цитаты** — если модель привела цитату, дословна ли она (механика дня 24);
- **цель** — судья отвечает, соответствует ли ответ цели диалога (0–2): потеря цели
  выглядит именно как «ответ сам по себе хороший, но уже не про то»;
- **ограничения** — не нарушены ли зафиксированные в диалоге ограничения
  (проверяются формулировками, заданными в сценарии);
- **память задачи** — что реально записано в состояние сессии (файл контекста
  dsh-term) и обновлялось ли оно по ходу;
- **отказ вне корпуса** — на вопрос, которого в базе нет, ожидается «не знаю»
  с просьбой уточнить, а не выдуманный ответ.

Здесь только измерение: чекер ничего не меняет в сессии и не вызывает её заново.
"""
from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .citations import QUOTE_INLINE, normalize
from .compare import parse_judgement

NOTE_RE = re.compile(r"[\wА-Яа-яЁё0-9_/.\-]+\.(?:md|py|json|ya?ml|txt)")
LINES_RE = re.compile(r"строк[аиу]?\s*\d+", re.IGNORECASE)
REFUSAL_RE = re.compile(
    r"не знаю|не могу ответить|нет ответа|не нашл|отсутству|не содержится"
    r"|в базе (?:этого|такого|этих|таких)? ?нет|нет в базе|не нашлось",
    re.IGNORECASE,
)
CLARIFY_RE = re.compile(r"уточн|конкретизир|какая именно|какие именно|о чём именно|о чем именно", re.IGNORECASE)

GOAL_TEMPLATE = """Оцени, отвечает ли ответ на цель диалога.

ЦЕЛЬ ДИАЛОГА: {goal}

ПРЕДЫДУЩИЕ ХОДЫ (кратко):
{history}

ВОПРОС ПОЛЬЗОВАТЕЛЯ: {question}

ОТВЕТ АССИСТЕНТА:
{answer}

ШКАЛА:
2 — ответ прямо продвигает цель диалога;
1 — ответ по теме, но цель диалога в нём не видна;
0 — ответ ушёл в сторону: не про цель, либо противоречит ей.

Ответь одной строкой строго в формате: ОЦЕНКА: <0|1|2> — <кратко почему>"""


@dataclass
class Corpus:
    """Индекс, по которому проверяем источники и цитаты.

    Тексты держим нормализованными (регистр, «ё», кавычки, markdown, пробелы):
    сравнивать цитату с сырым текстом через SQL LIKE нельзя — она не совпадёт
    из-за оформления, и дословная цитата выглядела бы выдуманной.
    """

    sources: set[str] = field(default_factory=set)
    texts: list[str] = field(default_factory=list)

    @classmethod
    def from_conn(cls, conn: sqlite3.Connection) -> "Corpus":
        sources = {Path(row[0]).name for row in conn.execute("SELECT DISTINCT source FROM chunks")}
        texts = [normalize(row[0] or "") for row in conn.execute("SELECT text FROM chunks")]
        return cls(sources=sources, texts=texts)

    def in_base(self, name: str) -> bool:
        return Path(name).name in self.sources

    def has_quote(self, quote: str) -> bool:
        needle = normalize(quote)
        return bool(needle) and any(needle in text for text in self.texts)


@dataclass
class TurnCheck:
    index: int
    question: str
    answer: str
    calls: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    foreign_notes: list[str] = field(default_factory=list)
    sources_present: bool = False
    lines_cited: bool = False
    quotes_total: int = 0
    quotes_verbatim: int = 0
    refused: bool = False
    clarify_requested: bool = False
    goal_score: int | None = None
    goal_reason: str = ""
    violations: list[str] = field(default_factory=list)
    answer_chars: int = 0


def load_transcript(path: Path, dsh_home: Path | None = None) -> dict:
    """Прочитать расшифровку и подставить чистые ответы из состояния сессии.

    Зачем: драйвер снимает вывод терминала, а в нём есть и вызовы инструментов, и
    их результаты (содержимое файлов). Для метрик нужен именно текст ответа, и он
    лежит в файле состояния сессии (`context/<id>.json`, поле `messages`) — там
    роли и тексты без служебного шума. Инструменты остаются из stdout: по ним
    видно, обращался ли агент к базе.
    """
    transcript = json.loads(path.read_text(encoding="utf-8"))
    state = load_task_state(transcript.get("sessionId"), dsh_home) if dsh_home else {}
    messages = state.get("messages_list") or []
    answers = [m.get("text") or "" for m in messages if m.get("role") == "assistant"]
    if answers:
        turns = transcript.get("turns") or []
        for index, turn in enumerate(turns):
            if index < len(answers) and answers[index].strip():
                turn["answer"] = answers[index]
        transcript["answers_from_state"] = True
    return transcript


def load_task_state(session_id: str | None, dsh_home: Path) -> dict:
    """Память задачи из файла контекста сессии dsh-term (стратегия facts)."""
    if not session_id:
        return {}
    path = dsh_home / "context" / f"{session_id}.json"
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"facts": data.get("facts") or {}, "strategy": data.get("strategy"),
            "factsCalls": data.get("factsCalls"), "factsTokens": data.get("factsTokens"),
            "messages": len(data.get("messages") or []),
            "messages_list": data.get("messages") or []}


def check_turn(index: int, turn: dict, corpus: Corpus | None) -> TurnCheck:
    """Разобрать ход: источники, строки, цитаты, отказ.

    Источником считается только заметка **из индекса**: у агента есть файловые
    инструменты, и в длинном диалоге он может уйти читать сам проект (`README.md`,
    `cli.py`) — это не ответ по базе знаний, поэтому такие упоминания считаются
    отдельно (`foreign_notes`), а не как источники.
    """
    answer = turn.get("answer") or ""
    check = TurnCheck(index=index, question=turn.get("user", ""), answer=answer,
                      calls=turn.get("calls") or [], answer_chars=len(answer))
    mentioned = sorted({Path(name).name for name in NOTE_RE.findall(answer)})
    if corpus is not None:
        check.notes = [name for name in mentioned if corpus.in_base(name)]
        check.foreign_notes = [name for name in mentioned if not corpus.in_base(name)]
    else:
        check.notes = mentioned
    check.sources_present = bool(check.notes)
    check.lines_cited = bool(LINES_RE.search(answer))
    # Отказ — это когда ответ НАЧИНАЕТСЯ с отказа: в длинном диалоге агент часто
    # пишет «в базе нет прямого ответа, но…» и продолжает отвечать по другим
    # заметкам. Искать фразу по всему тексту значило бы считать такие ответы
    # отказом (проверено на прогоне: 6 «отказов» там, где ответы были).
    check.refused = bool(REFUSAL_RE.search(answer[:160]))
    check.clarify_requested = bool(CLARIFY_RE.search(answer))
    quotes = [q for q in QUOTE_INLINE.findall(answer) if len(q) >= 25]
    check.quotes_total = len(quotes)
    if corpus is not None:
        check.quotes_verbatim = sum(1 for quote in quotes if corpus.has_quote(quote))
    return check


def judge_goal(agent, scenario: dict, history: list[TurnCheck], check: TurnCheck) -> tuple[int | None, str]:
    """Оценка судьи: продолжает ли ответ вести к цели диалога."""
    if agent is None:
        return None, ""
    brief_history = "\n".join(
        f"- пользователь: {h.question[:120]}\n  ассистент: {h.answer[:160]}" for h in history[-4:]
    ) or "(это первый ход)"
    prompt = GOAL_TEMPLATE.format(goal=scenario.get("goal", ""), history=brief_history,
                                  question=check.question, answer=check.answer[:2500])
    reply = agent.ask(prompt)
    return parse_judgement(reply.text), reply.text.strip()


def check_constraints(answer: str, constraints: list[str]) -> list[str]:
    """Нарушения ограничений: формулировки, которых в ответе быть не должно."""
    low = answer.lower()
    return [item for item in constraints if item.lower() in low]


def run_checks(transcript: dict, *, agent=None, corpus: Corpus | None = None,
               dsh_home: Path | None = None, judge: bool = True, verbose: bool = True) -> dict:
    """Проверить один сценарий по ходам.

    Ограничения берутся из самого сценария и действуют с указанного хода: до него
    ассистент о них ещё не знает, и «нарушением» это не считается.
    """
    scenario = transcript["scenario"]
    constraints_cfg = scenario.get("constraints") or {}
    from_turn = int(constraints_cfg.get("from_turn") or 1)
    phrases = constraints_cfg.get("phrases") or []

    checks: list[TurnCheck] = []
    for index, turn in enumerate(transcript.get("turns") or [], start=1):
        check = check_turn(index, turn, corpus)
        if index >= from_turn:
            check.violations = check_constraints(check.answer, phrases)
        # Отказные ходы не судим на «продвижение к цели»: правильное поведение на
        # вопрос вне корпуса — не продвигать цель, а честно сказать, что данных нет.
        if judge and check.answer.strip() and not check.refused:
            check.goal_score, check.goal_reason = judge_goal(agent, scenario, checks, check)
        checks.append(check)
        if verbose:
            print(f"  [{scenario['id']} #{index:02d}] источники {'да' if check.sources_present else 'НЕТ'}"
                  f" · цитаты {check.quotes_verbatim}/{check.quotes_total}"
                  f" · цель {check.goal_score}"
                  + (" · отказ" if check.refused else "")
                  + (f" · НАРУШЕНИЯ: {', '.join(check.violations)}" if check.violations else ""))
    state = load_task_state(transcript.get("sessionId"), dsh_home) if dsh_home else {}
    return {"scenario": scenario, "checks": checks,
            "state": {k: v for k, v in state.items() if k != "messages_list"},
            "sessionId": transcript.get("sessionId"), "ragBase": transcript.get("ragBase"),
            "answers_from_state": bool(transcript.get("answers_from_state"))}


def summarize(results: list[dict]) -> dict:
    turns = [c for r in results for c in r["checks"]]
    with_sources = sum(1 for c in turns if c.sources_present)
    quotes = sum(c.quotes_total for c in turns)
    verbatim = sum(c.quotes_verbatim for c in turns)
    goals = [c.goal_score for c in turns if c.goal_score is not None]
    return {
        "scenarios": len(results),
        "turns": len(turns),
        "with_sources": with_sources,
        "with_sources_share": round(with_sources / len(turns), 3) if turns else 0.0,
        "with_lines": sum(1 for c in turns if c.lines_cited),
        "foreign_notes": sum(len(c.foreign_notes) for c in turns),
        "turns_with_foreign": sum(1 for c in turns if c.foreign_notes),
        "refusals": sum(1 for c in turns if c.refused),
        "refusals_with_clarify": sum(1 for c in turns if c.refused and c.clarify_requested),
        "quotes_total": quotes,
        "quotes_verbatim": verbatim,
        "quotes_verbatim_share": round(verbatim / quotes, 3) if quotes else 0.0,
        "goal_mean": round(sum(goals) / len(goals), 2) if goals else None,
        "goal_zeros": sum(1 for g in goals if g == 0),
        "violations": sum(len(c.violations) for c in turns),
        "tool_calls": sum(len(c.calls) for c in turns),
        "turns_with_tools": sum(1 for c in turns if c.calls),
        "answers_empty": sum(1 for c in turns if not c.answer.strip()),
        "answer_chars_avg": round(sum(c.answer_chars for c in turns) / len(turns)) if turns else 0,
    }


def write_report(results: list[dict], out_dir: Path, *, model: str = "") -> Path:
    summary = summarize(results)
    lines = ["# Длинные сценарии чата: цель, источники, память задачи\n"]
    lines.append(f"Сценариев: **{summary['scenarios']}**, ходов: **{summary['turns']}**. "
                 f"Режим: живая сессия dsh-term со стратегией `facts` и базой "
                 f"`{results[0].get('ragBase') or '—'}`"
                 + (f", модель `{model}`" if model else "") + ".\n")
    lines.append("## Итоги\n")
    lines.append("| Мера | Результат |")
    lines.append("|---|---|")
    lines.append(f"| Ответов с источниками из базы | **{summary['with_sources']}** из {summary['turns']} "
                 f"({summary['with_sources_share']:.2f}) |")
    lines.append(f"| Ответов со ссылкой на строки | {summary['with_lines']} из {summary['turns']} |")
    lines.append(f"| Ссылок на файлы вне базы (проект, README) | {summary['foreign_notes']} "
                 f"в {summary['turns_with_foreign']} ходах |")
    lines.append(f"| Цитаты в кавычках, дословные | {summary['quotes_verbatim']} из {summary['quotes_total']} "
                 f"({summary['quotes_verbatim_share']:.2f}) — в чате кавычки не по контракту: "
                 f"агент выделяет термины и пересказ, дословность гарантируется только в `/rag-brief` |")
    lines.append(f"| Ответ соответствует цели диалога (судья 0–2) | **{summary['goal_mean']}**"
                 + (f", нулей: {summary['goal_zeros']}" if summary["goal_zeros"] else "") + " |")
    lines.append(f"| Отказов на вопросы вне корпуса | {summary['refusals']}"
                 + (f" (с уточнением: {summary['refusals_with_clarify']})" if summary["refusals"] else "") + " |")
    lines.append(f"| Нарушений ограничений | {summary['violations']} |")
    lines.append(f"| Ходов с обращением к базе | {summary['turns_with_tools']} из {summary['turns']} "
                 f"(всего вызовов {summary['tool_calls']}) |")
    lines.append(f"| Пустых ответов | {summary['answers_empty']} |")
    lines.append(f"| Средняя длина ответа, символов | {summary['answer_chars_avg']} |")
    lines.append("")

    lines.append("## Память задачи (состояние сессии)\n")
    for result in results:
        state = result.get("state") or {}
        facts = state.get("facts") or {}
        lines.append(f"### {result['scenario']['id']} · {result['scenario']['title']}\n")
        lines.append(f"Стратегия контекста: `{state.get('strategy', '—')}`, "
                     f"вызовов обновления памяти: {state.get('factsCalls', '—')}, "
                     f"сообщений в состоянии: {state.get('messages', '—')}.\n")
        if facts:
            lines.append("| Ключ | Значение |")
            lines.append("|---|---|")
            for key, value in facts.items():
                lines.append(f"| {key} | {str(value)[:400]} |")
        else:
            lines.append("_Память задачи пуста._")
        lines.append("")

    lines.append("## По ходам\n")
    for result in results:
        scenario = result["scenario"]
        lines.append(f"### {scenario['id']} · {scenario['title']}\n")
        lines.append(f"**Цель:** {scenario.get('goal', '—')}\n")
        lines.append("| № | Вопрос | Источники | Цитаты | Цель | Отказ |")
        lines.append("|---|---|---|---|---|---|")
        for check in result["checks"]:
            sources = ", ".join(check.notes[:2]) if check.notes else "—"
            quotes = f"{check.quotes_verbatim}/{check.quotes_total}" if check.quotes_total else "—"
            goal = check.goal_score if check.goal_score is not None else "—"
            lines.append(f"| {check.index} | {check.question[:70]} | {sources} | {quotes} | {goal} | "
                         f"{'да' if check.refused else '—'} |")
        lines.append("")
        for check in result["checks"]:
            if check.answer.strip():
                lines.append(f"**Ход {check.index}.** {check.question}\n")
                lines.append(f"> {check.answer.strip()[:700]}\n")
        lines.append("")

    lines.append("## Как читать\n")
    lines.append("- **Источники** считаются по упоминанию заметки (`.md`) в тексте ответа: "
                 "именно это задание называет «всегда выводит источники».")
    lines.append("- **Цель** оценивает отдельный судья по цели сценария и последним ходам: "
                 "ноль означает, что ответ ушёл в сторону, а не что он неверен.")
    lines.append("- **Память задачи** читается из файла состояния сессии: важно не то, что "
                 "ассистент «помнит» по контексту, а то, что зафиксировано структурно.")
    lines.append("")
    path = out_dir / "chat-scenarios.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "chat-scenarios.json").write_text(
        json.dumps({"summary": summary,
                    "results": [{k: v for k, v in r.items() if k != "checks"}
                                | {"checks": [c.__dict__ for c in r["checks"]]} for r in results]},
                   ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    """Проверить расшифровки сценариев и собрать отчёт."""
    import argparse

    from .config import Config
    from .llm import LlmClient
    from . import store

    parser = argparse.ArgumentParser(prog="doc_index.chat_scenarios",
                                     description="Проверка длинных сценариев чата (день 25)")
    parser.add_argument("transcripts", nargs="+", help="файлы расшифровок chat-*.json")
    parser.add_argument("--out", default=str(Config().out), help="каталог отчётов")
    parser.add_argument("--dsh-home", default=str(Path.home() / ".dsh-term"),
                        help="каталог dsh-term с состоянием сессий")
    parser.add_argument("--no-judge", action="store_true",
                        help="без судьи «ответ соответствует цели диалога»")
    args = parser.parse_args(argv)

    cfg = Config(out=Path(args.out))
    cfg.ensure_out()
    conn = store.connect(cfg.db_path())
    corpus = Corpus.from_conn(conn)
    print(f"корпус: {len(corpus.sources)} заметок, {len(corpus.texts)} чанков")
    results: list[dict] = []
    with LlmClient() as agent:
        for path in args.transcripts:
            transcript = load_transcript(Path(path), Path(args.dsh_home))
            source = "состояние сессии" if transcript.get("answers_from_state") else "вывод терминала"
            print(f"сценарий {transcript['scenario']['id']}: "
                  f"{len(transcript.get('turns') or [])} ходов · ответы из: {source}")
            results.append(run_checks(transcript, agent=None if args.no_judge else agent,
                                      corpus=corpus, dsh_home=Path(args.dsh_home),
                                      judge=not args.no_judge))
        report = write_report(results, cfg.out, model=getattr(agent, "model", ""))

    summary = summarize(results)
    print(f"\nотчёт: {report}")
    print(f"  источники: {summary['with_sources']}/{summary['turns']} "
          f"({summary['with_sources_share']:.2f}) · цитаты дословны: "
          f"{summary['quotes_verbatim']}/{summary['quotes_total']}")
    print(f"  цель (судья 0–2): {summary['goal_mean']}"
          + (f" · нулей {summary['goal_zeros']}" if summary["goal_zeros"] else "")
          + f" · обращений к базе: {summary['turns_with_tools']}/{summary['turns']}")
    print(f"  нарушений ограничений: {summary['violations']}"
          f" · отказов: {summary['refusals']} (с уточнением {summary['refusals_with_clarify']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
