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
    build_context,
    build_prompt,
)

HITS = [
    {"source": "20_Понятия/11_Агентный_харнесс.md", "breadcrumb": "Понятия › Харнесс › Определение",
     "text": "Харнесс организует цикл агента.", "rank": 1},
    {"source": "20_Понятия/06_Цикл_агента.md", "breadcrumb": "Понятия › Цикл агента › Определение",
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
