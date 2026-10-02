"""Тесты MCP-сервера RAG: разбор аргументов, поиск, формат ответа и инструменты.

Сеть, Ollama и модель не нужны: поиск подменяется заглушкой, поэтому проверяются
фильтрация, пол применимости, формат выдачи и то, что SDK видит инструменты.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.mcp_server import (  # noqa: E402
    DEFAULT_K,
    KnowledgeBase,
    SearchOutcome,
    build_server,
    format_hits,
    parse_base,
)


def hit(chunk_id, source, text, dense=0.7, start=1, end=5, **extra):
    base = {
        "chunk_id": chunk_id,
        "source": source,
        "text": text,
        "dense_score": dense,
        "score": dense,
        "start_line": start,
        "end_line": end,
        "breadcrumb": "Раздел › Подраздел",
        "section": "Подраздел",
        "title": "Заметка",
    }
    base.update(extra)
    return base


class FakeSearcher:
    """Заглушка поиска: отдаёт заранее заданные кандидаты."""

    def __init__(self, hits):
        self.hits = hits
        self.queries = []
        self.kwargs = []

    def search(self, query, *, k=5, mode="dense", candidates=20):
        self.queries.append(query)
        self.kwargs.append({"k": k, "mode": mode, "candidates": candidates})
        return [dict(h) for h in self.hits]


def make_base(hits, **kwargs):
    base = KnowledgeBase(name="test", root=Path("."), **kwargs)
    base._searcher = FakeSearcher(hits)
    return base


class ParseBaseTests(unittest.TestCase):
    def test_parses_name_and_path(self):
        name, path = parse_base(f"kb={Path.cwd()}")
        self.assertEqual(name, "kb")
        self.assertEqual(path, Path.cwd())

    def test_rejects_without_equals(self):
        with self.assertRaises(Exception):
            parse_base(str(Path.cwd()))

    def test_rejects_missing_directory(self):
        with self.assertRaises(Exception):
            parse_base("kb=C:\\нет-такого-каталога-42")


class SearchTests(unittest.TestCase):
    def test_returns_top_k_after_margin_filter(self):
        hits = [hit("a", "x.md", "т", 0.70), hit("b", "y.md", "т", 0.68), hit("c", "z.md", "т", 0.40)]
        base = make_base(hits, margin=0.04, min_dense=None, min_keep=1)
        outcome = base.search("вопрос", k=5)
        self.assertEqual([h["chunk_id"] for h in outcome.hits], ["a", "b"])

    def test_floor_reports_no_answer(self):
        """Запрос вне корпуса: инструмент обязан сказать «ответа нет», а не отдать мусор."""
        base = make_base([hit("a", "x.md", "помидоры", 0.41)], margin=0.04, min_dense=0.5)
        outcome = base.search("как выращивать помидоры")
        self.assertTrue(outcome.below_floor)
        self.assertEqual(outcome.hits, [])
        self.assertAlmostEqual(outcome.best_score, 0.41)

    def test_floor_uses_best_candidate_not_first(self):
        """После слияния запросов порядок задаёт RRF: пол считаем по лучшей оценке."""
        hits = [hit("a", "x.md", "т", 0.40), hit("b", "y.md", "т", 0.66)]
        base = make_base(hits, margin=None, min_dense=0.5)
        outcome = base.search("вопрос")
        self.assertFalse(outcome.below_floor)
        self.assertAlmostEqual(outcome.best_score, 0.66)

    def test_empty_candidates(self):
        base = make_base([], margin=0.04, min_dense=0.5)
        outcome = base.search("вопрос")
        self.assertEqual(outcome.hits, [])
        self.assertFalse(outcome.below_floor)

    def test_candidates_passed_to_search(self):
        base = make_base([hit("a", "x.md", "т", 0.7)], margin=None, min_dense=None, candidates=20)
        base.search("вопрос", k=3)
        self.assertEqual(base._searcher.kwargs[0]["candidates"], 20)

    def test_abbreviations_expand_into_second_query(self):
        """ЗУН и подобные аббревиатуры ищутся и в раскрытом виде."""
        base = make_base([hit("a", "zun.md", "т", 0.7)], margin=None, min_dense=None)
        outcome = base.search("что такое ЗУН-матрица")
        self.assertEqual(len(outcome.queries), 2)
        self.assertIn("знания умения навыки", outcome.queries[1])
        self.assertIn("знания умения навыки", base._searcher.queries[1])

    def test_expansion_can_be_disabled(self):
        base = make_base([hit("a", "zun.md", "т", 0.7)], margin=None, min_dense=None, expand=False)
        outcome = base.search("что такое ЗУН-матрица")
        self.assertEqual(outcome.queries, ["что такое ЗУН-матрица"])

    def test_query_without_abbreviations_uses_single_query(self):
        base = make_base([hit("a", "x.md", "т", 0.7)], margin=None, min_dense=None)
        outcome = base.search("как считается покрытие фактов")
        self.assertEqual(outcome.queries, ["как считается покрытие фактов"])


class FormatTests(unittest.TestCase):
    def test_format_lists_sources_and_lines(self):
        base = make_base([])
        hits = [hit("a", "20_Понятия/11_Харнесс.md", "текст про харнесс", 0.69, start=7, end=10)]
        text = format_hits(base, "что такое харнесс", SearchOutcome(hits=hits, best_score=0.69))
        self.assertIn("11_Харнесс.md", text)
        self.assertIn("строки 7–10", text)
        self.assertIn("0.690", text)
        self.assertIn("текст про харнесс", text)
        self.assertIn("Ссылайся на заметку", text)

    def test_format_reports_missing_answer(self):
        base = make_base([], min_dense=0.5)
        text = format_hits(base, "борщ", SearchOutcome(best_score=0.41, below_floor=True))
        self.assertIn("ответа нет", text)
        self.assertIn("0.410", text)

    def test_format_reports_empty_result(self):
        base = make_base([])
        text = format_hits(base, "вопрос", SearchOutcome())
        self.assertIn("ничего не найдено", text)

    def test_format_shows_expanded_query(self):
        base = make_base([])
        outcome = SearchOutcome(hits=[hit("a", "x.md", "т")],
                                queries=["что такое ЗУН", "что такое ЗУН знания умения навыки"])
        text = format_hits(base, "что такое ЗУН", outcome)
        self.assertIn("раскрытие аббревиатур", text)
        self.assertIn("знания умения навыки", text)


class ServerTests(unittest.TestCase):
    def test_tools_registered(self):
        """SDK должен видеть оба инструмента — иначе агент их не получит."""
        base = make_base([hit("a", "x.md", "т", 0.7)], margin=None, min_dense=None)
        server = build_server([base])
        names = sorted(server._tool_manager._tools) if hasattr(server, "_tool_manager") else []
        if not names:
            self.skipTest("внутренний реестр инструментов недоступен в этой версии SDK")
        self.assertEqual(names, ["rag_bases", "rag_search"])

    def test_default_k_is_used(self):
        self.assertEqual(DEFAULT_K, 5)


if __name__ == "__main__":
    unittest.main()
