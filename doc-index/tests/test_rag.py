"""Тесты RAG-слоя: сборка промпта, проверка фактов, разбор оценки судьи — без сети."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.compare import check_facts, load_control, parse_judgement, summarize  # noqa: E402
from doc_index.rag import (  # noqa: E402
    CONTEXT_HEADER,
    RULES,
    WITHOUT_CONTEXT,
    WITH_CONTEXT,
    answer_question,
    build_context,
    build_prompt,
)

HITS = [
    {"chunk_id": "structural:20_Понятия/11_Агентный_харнесс.md#0001",
     "source": "20_Понятия/11_Агентный_харнесс.md", "breadcrumb": "Понятия › Харнесс › Определение",
     "section": "Определение", "start_line": 7, "end_line": 9,
     "text": "Харнесс организует цикл агента.", "rank": 1},
    {"chunk_id": "structural:20_Понятия/06_Цикл_агента.md#0002",
     "source": "20_Понятия/06_Цикл_агента.md", "breadcrumb": "Понятия › Цикл агента › Определение",
     "section": "Определение", "start_line": 3, "end_line": 5,
     "text": "Цикл: думай, действуй, наблюдай.", "rank": 2},
]

CONTROL = """
questions:
  - id: c01
    question: "Что такое харнесс?"
    expect: "Инфраструктура вокруг модели."
    sources: [20_Понятия/11_Агентный_харнесс.md]
    must_contain:
      - ["цикл", "цикла"]
      - ["контекст"]
"""


class PromptTest(unittest.TestCase):
    def test_режимы_отличаются_только_контекстом(self) -> None:
        with_rag = build_prompt("Вопрос?", HITS)
        without = build_prompt("Вопрос?", None)
        self.assertIn(WITH_CONTEXT, with_rag)
        self.assertIn(WITHOUT_CONTEXT, without)
        self.assertNotIn(CONTEXT_HEADER, without)
        self.assertIn(CONTEXT_HEADER, with_rag)
        # общие правила и вопрос совпадают посимвольно — иначе сравнение нечестное
        for prompt in (with_rag, without):
            self.assertTrue(prompt.startswith(RULES))
            self.assertTrue(prompt.endswith("ВОПРОС: Вопрос?"))

    def test_контекст_содержит_источники_и_крошки(self) -> None:
        context = build_context(HITS)
        self.assertIn("[1] 20_Понятия/11_Агентный_харнесс.md", context)
        self.assertIn("Определение", context)
        self.assertIn("думай, действуй, наблюдай", context)

    def test_бюджет_контекста_соблюдается(self) -> None:
        context = build_context(HITS * 50, max_chars=500)
        self.assertLessEqual(len(context), 700)
        self.assertIn("[1]", context)

    def test_пустой_поиск_даёт_режим_без_rag(self) -> None:
        prompt = build_prompt("Вопрос?", [])
        self.assertIn(WITHOUT_CONTEXT, prompt)


class FactsTest(unittest.TestCase):
    def test_факты_считаются_по_вариантам_и_регистру(self) -> None:
        check = check_facts("Харнесс организует ЦИКЛ агента и управляет контекстом.",
                            [["цикл"], ["контекст"], ["журнал", "аудит"]])
        self.assertEqual((check.covered, check.total), (2, 3))
        self.assertEqual(check.missing, ["журнал"])
        self.assertAlmostEqual(check.share, 0.667, places=3)

    def test_пустой_ответ_не_даёт_фактов(self) -> None:
        check = check_facts("", [["цикл"]])
        self.assertEqual(check.covered, 0)


class JudgeTest(unittest.TestCase):
    def test_оценка_разбирается(self) -> None:
        self.assertEqual(parse_judgement("ОЦЕНКА: 2 — всё по делу"), 2)
        self.assertEqual(parse_judgement("оценка: 0 - выдумка"), 0)
        self.assertEqual(parse_judgement("Ответ хороший, ставлю 1 балл"), 1)

    def test_без_оценки_возвращается_none(self) -> None:
        self.assertIsNone(parse_judgement("не могу оценить"))


class ProjectContextPromptTest(unittest.TestCase):
    """Живой контекст проекта (день 31): блок git и правило к нему."""

    CONTEXT = ("КОНТЕКТ ПРОЕКТА (данные git, не из документации):\n"
               "- ветка: week7/day31 · HEAD abc1234 · последний коммит\n"
               "- рабочее дерево чистое")

    def test_context_block_goes_into_prompt(self):
        prompt = build_prompt("какая сейчас ветка?", HITS, strict=True,
                              project_context=self.CONTEXT)
        self.assertIn("КОНТЕКТ ПРОЕКТА", prompt)
        self.assertIn("week7/day31", prompt)

    def test_rule_allows_answering_without_citations(self):
        """Без этого правила строгий контракт заставляет отвечать «Не знаю» на вопрос
        о ветке: во фрагментах базы ветки нет."""
        prompt = build_prompt("какая сейчас ветка?", HITS, strict=True,
                              project_context=self.CONTEXT)
        self.assertIn("не документация", prompt)
        self.assertIn("НЕ добавляй блоки ИСТОЧНИКИ и ЦИТАТЫ", prompt)

    def test_without_context_no_extra_rule(self):
        prompt = build_prompt("какая сейчас ветка?", HITS, strict=True)
        self.assertNotIn("КОНТЕКТ ПРОЕКТА", prompt)
        self.assertNotIn("не документация", prompt)

    def test_context_block_is_last_before_question(self):
        prompt = build_prompt("вопрос", HITS, strict=True, project_context=self.CONTEXT)
        self.assertLess(prompt.index("КОНТЕКТ ПРОЕКТА"), prompt.index("ВОПРОС: вопрос"))
        self.assertGreater(prompt.index("ФРАГМЕНТЫ БАЗЫ ЗНАНИЙ"), 0)


class ThresholdGateWithProjectTest(unittest.TestCase):
    """Гейт отказа и живой контекст проекта."""

    class Agent:
        model = "заглушка"
        calls = 0

        def ask(self, prompt):
            self.calls += 1
            from doc_index.agent import AgentReply
            return AgentReply(text="ветка: week7/day31", seconds=0.1, finish_reason="stop")

    def weak_hits(self):
        return [{"source": "docs/x.md", "breadcrumb": "x", "text": "не по теме",
                 "rank": 1, "dense_score": 0.1, "chunk_id": "x#0001"}]

    def test_gate_refuses_without_project_context(self):
        """Слабый поиск без контекста проекта — отказ без вызова модели (день 24)."""
        agent = self.Agent()
        answer = answer_question(agent, "вопрос", question_id="q", mode="rag",
                                 hits=self.weak_hits(), min_dense=0.5)
        self.assertTrue(answer.refused)
        self.assertEqual(agent.calls, 0)

    def test_gate_lets_question_through_with_project_context(self):
        """С контекстом проекта вопрос доходит до модели: «какая сейчас ветка» по
        документации не ищется, и гейт отказал бы, не спросив модель."""
        agent = self.Agent()
        answer = answer_question(agent, "какая сейчас ветка?", question_id="q", mode="rag",
                                 hits=self.weak_hits(), min_dense=0.5,
                                 project_context="КОНТЕКТ ПРОЕКТА:\n- ветка: main")
        self.assertFalse(answer.refused)
        self.assertEqual(agent.calls, 1)
        self.assertIn("ветка: week7/day31", answer.answer)


class ControlTest(unittest.TestCase):
    def test_набор_читается_и_нормализуется(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "q.yaml"
            path.write_text(CONTROL, encoding="utf-8")
            questions = load_control(path)
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["sources"], ["20_Понятия/11_Агентный_харнесс.md"])

    def test_набор_без_expect_падает(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "q.yaml"
            path.write_text("questions:\n  - id: x\n    question: 'вопрос'\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_control(path)

    def test_итоги_считают_разницу_режимов(self) -> None:
        result = {
            "search_mode": "dense", "judged": True, "k": 5,
            "entries": [{
                "id": "c01", "question": "?", "sources": ["a.md"], "retrieved": ["a.md"],
                "retrieved_expected": ["a.md"],
                "facts": {"rag": {"covered": 2, "total": 2, "missing": []},
                          "no-rag": {"covered": 1, "total": 2, "missing": ["журнал"]}},
                "judge": {"rag": 2, "no-rag": 1},
                "answers": {"rag": "полный ответ", "no-rag": "частичный"},
                "seconds": {"rag": 3.0, "no-rag": 3.5},
            }],
        }
        summary = summarize(result)
        self.assertEqual(summary["rag"]["facts_share"], 1.0)
        self.assertEqual(summary["no-rag"]["facts_share"], 0.5)
        self.assertEqual(summary["rag"]["judge_mean"], 2.0)
        self.assertEqual(summary["retrieval_hits"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
