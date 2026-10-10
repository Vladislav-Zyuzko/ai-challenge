"""Тесты проверки длинных сценариев чата (день 25).

Сеть, Ollama и модель не нужны: проверяются разбор хода (источники, цитаты,
отказ), проверка ограничений, сводка, чтение памяти задачи из файла состояния
и сборка отчёта. Судья отключён — он требует модели.
"""
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.chat_scenarios import (  # noqa: E402
    Corpus,
    TurnCheck,
    check_constraints,
    check_turn,
    load_task_state,
    load_transcript,
    run_checks,
    summarize,
    write_report,
)


def turn(user, answer, calls=None):
    return {"user": user, "answer": answer, "calls": calls or []}


def transcript(turns, scenario=None, session_id="abc"):
    return {
        "scenario": scenario or {"id": "sX", "title": "тест", "goal": "цель теста",
                                 "constraints": {"from_turn": 3, "phrases": ["kubernetes"]}},
        "sessionId": session_id,
        "ragBase": "effective-ai",
        "turns": turns,
    }


class TurnCheckTests(unittest.TestCase):
    def test_extracts_note_names_and_lines(self):
        check = check_turn(1, turn("вопрос", "Смотри `20_Понятия/11_Харнесс.md` (строки 7–10) и ai.md."), None)
        self.assertTrue(check.sources_present)
        self.assertTrue(check.lines_cited)
        self.assertEqual(check.notes, ["11_Харнесс.md", "ai.md"])

    def test_answer_without_sources(self):
        check = check_turn(1, turn("вопрос", "Просто ответ без ссылок."), None)
        self.assertFalse(check.sources_present)
        self.assertFalse(check.lines_cited)

    def test_detects_refusal_and_clarification(self):
        check = check_turn(1, turn("вопрос", "Не знаю: в базе нет ответа. Уточните, пожалуйста."), None)
        self.assertTrue(check.refused)
        self.assertTrue(check.clarify_requested)

    def test_plain_answer_is_not_refusal(self):
        check = check_turn(1, turn("вопрос", "Вот ответ со ссылкой на заметку.md"), None)
        self.assertFalse(check.refused)
        self.assertFalse(check.clarify_requested)

    def test_counts_quotes_without_db(self):
        """Без базы цитаты считаются, но дословность не проверяется (0 из N)."""
        check = check_turn(1, turn("вопрос", "Как сказано: «вот такой довольно длинный фрагмент текста»."), None)
        self.assertEqual(check.quotes_total, 1)
        self.assertEqual(check.quotes_verbatim, 0)

    def test_keeps_tool_calls(self):
        check = check_turn(1, turn("вопрос", "ответ", [{"tool": "rag/rag_search", "args": "query=…"}]), None)
        self.assertEqual(len(check.calls), 1)


class ConstraintTests(unittest.TestCase):
    def test_finds_forbidden_phrase(self):
        self.assertEqual(check_constraints("Развернём в Kubernetes и всё будет хорошо.", ["kubernetes"]),
                         ["kubernetes"])

    def test_case_insensitive(self):
        self.assertEqual(check_constraints("Возьмём K8S", ["k8s"]), ["k8s"])

    def test_clean_answer(self):
        self.assertEqual(check_constraints("Обойдёмся docker-compose", ["kubernetes"]), [])


class StateTests(unittest.TestCase):
    def test_reads_facts_from_session_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "context").mkdir()
            (home / "context" / "abc.json").write_text(json.dumps({
                "strategy": "facts", "factsCalls": 5, "factsTokens": 900,
                "facts": {"цель": "выбрать MCP", "ограничения": "без Kubernetes"},
                "messages": [{"role": "user", "text": "привет"}],
            }, ensure_ascii=False), encoding="utf-8")
            state = load_task_state("abc", home)
            self.assertEqual(state["facts"]["цель"], "выбрать MCP")
            self.assertEqual(state["strategy"], "facts")
            self.assertEqual(state["factsCalls"], 5)
            self.assertEqual(state["messages"], 1)

    def test_missing_state_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(load_task_state("нет-такого", Path(tmp)), {})
            self.assertEqual(load_task_state(None, Path(tmp)), {})


class RunChecksTests(unittest.TestCase):
    def test_constraints_apply_only_after_from_turn(self):
        data = transcript([
            turn("1", "Предлагаю Kubernetes."),          # до запрета — не нарушение
            turn("2", "Ещё раз про Kubernetes."),        # до запрета — не нарушение
            turn("3", "Снова Kubernetes, но теперь позже."),  # с 3-го хода — нарушение
        ])
        result = run_checks(data, judge=False, verbose=False)
        self.assertEqual([c.violations for c in result["checks"]], [[], [], ["kubernetes"]])

    def test_summary_counts(self):
        data = transcript([
            turn("1", "Ответ со ссылкой note.md (строки 3–5)"),
            turn("2", "Не знаю, в базе нет. Уточните вопрос."),
        ])
        result = run_checks(data, judge=False, verbose=False)
        summary = summarize([result])
        self.assertEqual(summary["turns"], 2)
        self.assertEqual(summary["with_sources"], 1)
        self.assertEqual(summary["with_lines"], 1)
        self.assertEqual(summary["refusals"], 1)
        self.assertEqual(summary["refusals_with_clarify"], 1)
        self.assertEqual(summary["goal_mean"], None)

    def test_summary_goal_mean(self):
        result = run_checks(transcript([turn("1", "Ответ")]), judge=False, verbose=False)
        result["checks"][0].goal_score = 2
        result["checks"].append(TurnCheck(index=2, question="q", answer="a", goal_score=0))
        summary = summarize([result])
        self.assertEqual(summary["goal_mean"], 1.0)
        self.assertEqual(summary["goal_zeros"], 1)

    def test_report_written_with_turns_and_state(self):
        data = transcript([turn("1", "Ответ со ссылкой note.md")])
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            (home / "context").mkdir()
            (home / "context" / "abc.json").write_text(
                json.dumps({"strategy": "facts", "facts": {"цель": "выбрать MCP"}}, ensure_ascii=False),
                encoding="utf-8")
            result = run_checks(data, judge=False, dsh_home=home, verbose=False)
            out = Path(tmp)
            path = write_report([result], out, model="тест-модель")
            text = path.read_text(encoding="utf-8")
            self.assertIn("Длинные сценарии чата", text)
            self.assertIn("Память задачи", text)
            self.assertIn("выбрать MCP", text)
            self.assertIn("note.md", text)
            self.assertTrue((out / "chat-scenarios.json").exists())

    def test_transcript_loader(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "chat-x.json"
            path.write_text(json.dumps(transcript([turn("1", "a")]), ensure_ascii=False), encoding="utf-8")
            self.assertEqual(load_transcript(path)["scenario"]["id"], "sX")


class SourceVsForeignTests(unittest.TestCase):
    """Ссылки на файлы проекта не считаются источниками из базы знаний."""

    def setUp(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE chunks (source TEXT, text TEXT)")
        conn.execute("INSERT INTO chunks VALUES (?, ?)",
                     ("20_Понятия/46_Блокирующие_гейты.md",
                      "Блокирующие гейты запрещают переход между стадиями конвейера."))
        conn.commit()
        self.corpus = Corpus.from_conn(conn)

    def test_corpus_reads_sources_and_texts(self):
        self.assertIn("46_Блокирующие_гейты.md", self.corpus.sources)
        self.assertEqual(len(self.corpus.texts), 1)

    def test_counts_only_base_notes_as_sources(self):
        answer = ("Смотри `20_Понятия/46_Блокирующие_гейты.md` (строки 7–10), "
                  "а также README.md и doc_index/cli.py.")
        check = check_turn(1, turn("вопрос", answer), self.corpus)
        self.assertEqual(check.notes, ["46_Блокирующие_гейты.md"])
        self.assertEqual(sorted(check.foreign_notes), ["README.md", "cli.py"])
        self.assertTrue(check.sources_present)

    def test_foreign_only_is_not_a_source(self):
        check = check_turn(1, turn("вопрос", "Открыл README.md и cli.py, всё понял."), self.corpus)
        self.assertEqual(check.notes, [])
        self.assertFalse(check.sources_present)
        self.assertEqual(sorted(check.foreign_notes), ["README.md", "cli.py"])

    def test_unknown_md_file_is_foreign(self):
        check = check_turn(1, turn("вопрос", "Смотри 20_Понятия/нет-такой.md"), self.corpus)
        self.assertEqual(check.notes, [])
        self.assertEqual(check.foreign_notes, ["нет-такой.md"])

    def test_verbatim_quote_checked_against_normalized_corpus(self):
        """Цитата сверяется с нормализованным текстом: регистр и пунктуация не мешают."""
        answer = ("Смотри `46_Блокирующие_гейты.md`: «Блокирующие гейты запрещают переход "
                  "между стадиями конвейера».")
        check = check_turn(1, turn("вопрос", answer), self.corpus)
        self.assertEqual(check.quotes_verbatim, 1)

    def test_paraphrase_is_not_verbatim(self):
        answer = "Цитата: «Гейты не дают перейти дальше, пока условия не выполнены»."
        check = check_turn(1, turn("вопрос", answer), self.corpus)
        self.assertEqual(check.quotes_total, 1)
        self.assertEqual(check.quotes_verbatim, 0)

    def test_summary_counts_foreign_links(self):
        result = run_checks(transcript([
            turn("1", "Ссылка на 46_Блокирующие_гейты.md и README.md"),
            turn("2", "Только README.md"),
        ]), judge=False, corpus=self.corpus, verbose=False)
        summary = summarize([result])
        self.assertEqual(summary["with_sources"], 1)
        self.assertEqual(summary["foreign_notes"], 2)
        self.assertEqual(summary["turns_with_foreign"], 2)


if __name__ == "__main__":
    unittest.main()
