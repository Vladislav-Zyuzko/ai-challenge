"""Тесты второго этапа: пороги, эвристика, MMR, диспетчер реранкинга, rewrite, пайплайны.

Сеть, Ollama и модель не нужны: cross-encoder подменяется заглушкой с той же
сигнатурой, поиск — заглушкой Searcher, поэтому тесты идут без 570 МБ весов
и без API-ключа.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.pipelines import Filters, precision, retrieve  # noqa: E402
from doc_index.rerank import (  # noqa: E402
    RERANKERS,
    CrossEncoderUnavailable,
    RerankInfo,
    heuristic_score,
    mmr,
    rerank,
    rerank_cross,
    rerank_heuristic,
    threshold_filter,
)
from doc_index.rewrite import (  # noqa: E402
    expand_abbreviations,
    multi_query_search,
    parse_variants,
    rewrite_query,
)
from doc_index.sweep import _metrics  # noqa: E402


def hit(chunk_id, source, text, dense=0.6, **extra):
    base = {
        "chunk_id": chunk_id,
        "source": source,
        "text": text,
        "dense_score": dense,
        "score": dense if dense is not None else 0.5,
        "rank": 1,
        "title": "",
        "breadcrumb": "",
        "section": "",
    }
    base.update(extra)
    return base


class FakeReply:
    def __init__(self, text):
        self.text = text
        self.seconds = 0.0
        self.finish_reason = "stop"


class FakeAgent:
    """Отвечает заранее заданным текстом (варианты rewrite)."""

    def __init__(self, text="", fail=False):
        self.text = text
        self.fail = fail
        self.prompts = []

    def ask(self, prompt):
        self.prompts.append(prompt)
        if self.fail:
            raise RuntimeError("модель недоступна")
        return FakeReply(self.text)


class FakeEncoder:
    """Заглушка cross-encoder: оценка берётся из словаря по тексту фрагмента."""

    def __init__(self, scores):
        self.scores = scores
        self.calls = 0

    def score(self, query, texts):
        self.calls += 1
        return [self.scores.get(text, 0.0) for text in texts]


class FakeSearcher:
    """Заглушка поиска: у каждого запроса свой список фрагментов."""

    def __init__(self, per_query=None, neighbours=None):
        self.per_query = per_query or {}
        self._neighbours = neighbours or []
        self.queries = []
        self.index = None
        self.ids = []

    def search(self, query, *, k=5, mode="dense", candidates=20):
        self.queries.append(query)
        return [dict(h) for h in self.per_query.get(query, [])][:k]

    def neighbours(self, hits, span=1):
        return [dict(h) for h in self._neighbours]


class ThresholdTests(unittest.TestCase):
    def test_absolute_cuts_weak(self):
        hits = [hit("a", "x.md", "т", 0.70), hit("b", "y.md", "т", 0.55), hit("c", "z.md", "т", 0.40)]
        self.assertEqual([h["chunk_id"] for h in threshold_filter(hits, min_dense=0.5)], ["a", "b"])

    def test_margin_is_relative_to_best(self):
        """У «слабого» вопроса все оценки ниже, но разрыв сохраняется."""
        hits = [hit("a", "x.md", "т", 0.52), hit("b", "y.md", "т", 0.49), hit("c", "z.md", "т", 0.40)]
        self.assertEqual([h["chunk_id"] for h in threshold_filter(hits, margin=0.05)], ["a", "b"])

    def test_never_empties_context(self):
        """Фильтр не имеет права обнулить контекст: RAG выродился бы в «без RAG»."""
        hits = [hit("a", "x.md", "т", 0.30), hit("b", "y.md", "т", 0.20)]
        kept = threshold_filter(hits, min_dense=0.9)
        self.assertEqual([h["chunk_id"] for h in kept], ["a"])

    def test_min_keep_holds_several(self):
        hits = [hit("a", "x.md", "т", 0.30), hit("b", "y.md", "т", 0.28), hit("c", "z.md", "т", 0.10)]
        kept = threshold_filter(hits, min_dense=0.9, min_keep=2)
        self.assertEqual([h["chunk_id"] for h in kept], ["a", "b"])

    def test_missing_score_does_not_break(self):
        hits = [hit("a", "x.md", "т", None), hit("b", "y.md", "т", 0.7)]
        self.assertEqual([h["chunk_id"] for h in threshold_filter(hits, min_dense=0.5)], ["b"])

    def test_empty_input(self):
        self.assertEqual(threshold_filter([], min_dense=0.5), [])


class HeuristicTests(unittest.TestCase):
    def test_prefers_fragment_with_query_terms(self):
        hits = [hit("a", "x.md", "совершенно посторонний текст про погоду", 0.9),
                hit("b", "y.md", "агентный харнесс управляет циклом агента и инструментами", 0.5)]
        ranked = rerank_heuristic(hits, "что такое агентный харнесс и цикл агента", top_k=2)
        self.assertEqual(ranked[0]["chunk_id"], "b")

    def test_prefix_match_handles_morphology(self):
        """В вопросе «агента», в тексте «агентный» — совпадение по основе."""
        score = heuristic_score("агента", hit("a", "x.md", "агентный цикл"))
        self.assertEqual(score.coverage, 1.0)

    def test_extra_query_words_do_not_count_as_found(self):
        score = heuristic_score("что делает агента", hit("a", "x.md", "агентный цикл"))
        self.assertTrue(0 < score.coverage < 1.0)

    def test_heading_boost(self):
        plain = heuristic_score("харнесс", hit("a", "x.md", "текст без слова"))
        titled = heuristic_score("харнесс", hit("a", "x.md", "текст без слова", title="Харнесс"))
        self.assertGreater(titled.score, plain.score)

    def test_min_score_keeps_at_least_one(self):
        hits = [hit("a", "x.md", "погода"), hit("b", "y.md", "море")]
        ranked = rerank_heuristic(hits, "агентный харнесс", top_k=5, min_score=0.9)
        self.assertEqual(len(ranked), 1)

    def test_empty_query(self):
        self.assertEqual(heuristic_score("", hit("a", "x.md", "т")).score, 0.0)


class DispatcherTests(unittest.TestCase):
    def test_none_returns_top_k(self):
        hits = [hit(f"c{i}", f"{i}.md", "т", 0.9 - i * 0.01) for i in range(10)]
        kept, info = rerank(hits, method="none", top_k=3)
        self.assertEqual(len(kept), 3)
        self.assertEqual(info.method, "none")

    def test_unknown_method_raises(self):
        with self.assertRaises(ValueError):
            rerank([hit("a", "x.md", "т")], method="magic")

    def test_threshold_reports_counts(self):
        hits = [hit("a", "x.md", "т", 0.70), hit("b", "y.md", "т", 0.50), hit("c", "z.md", "т", 0.30)]
        kept, info = rerank(hits, method="threshold", margin=0.25, top_k=5)
        self.assertEqual([h["chunk_id"] for h in kept], ["a", "b"])
        self.assertEqual((info.candidates, info.kept, info.dropped), (3, 2, 1))

    def test_cross_without_encoder_raises(self):
        with self.assertRaises(CrossEncoderUnavailable):
            rerank([hit("a", "x.md", "т")], method="cross", top_k=1)

    def test_registry_is_complete(self):
        self.assertEqual(set(RERANKERS), {"none", "threshold", "heuristic", "cross", "mmr"})

    def test_mmr_without_index_falls_back(self):
        hits = [hit(f"c{i}", f"{i}.md", "т", 0.9) for i in range(4)]
        self.assertEqual(len(mmr(hits, None, [], None, top_k=2)), 2)

    def test_info_dropped_is_derived(self):
        self.assertEqual(RerankInfo(method="threshold", candidates=20, kept=5).dropped, 15)


class CrossEncoderStubTests(unittest.TestCase):
    def test_orders_by_model_score(self):
        hits = [hit("a", "x.md", "слабый", 0.9), hit("b", "y.md", "сильный", 0.5)]
        ranked = rerank_cross(FakeEncoder({"слабый": 0.05, "сильный": 0.95}), "вопрос", hits, top_k=2)
        self.assertEqual([h["chunk_id"] for h in ranked], ["b", "a"])
        self.assertEqual(ranked[0]["rerank_score"], 0.95)

    def test_threshold_keeps_one(self):
        hits = [hit("a", "x.md", "слабый", 0.9), hit("b", "y.md", "сильный", 0.5)]
        ranked = rerank_cross(FakeEncoder({"слабый": 0.05, "сильный": 0.1}), "вопрос",
                              hits, top_k=2, min_score=0.5)
        self.assertEqual([h["chunk_id"] for h in ranked], ["b"])

    def test_empty_hits(self):
        self.assertEqual(rerank_cross(FakeEncoder({}), "вопрос", []), [])


class RewriteTests(unittest.TestCase):
    def test_parse_variants_strips_markers(self):
        text = "1. первый вариант\n- второй вариант\n• третий вариант\n4) четвёртый"
        self.assertEqual(parse_variants(text, limit=4),
                         ["первый вариант", "второй вариант", "третий вариант", "четвёртый"])

    def test_parse_variants_dedupes_and_limits(self):
        text = "агентный цикл\nАгентный цикл\nхарнесс\nинструменты"
        self.assertEqual(parse_variants(text, limit=2), ["агентный цикл", "харнесс"])

    def test_parse_variants_skips_short(self):
        self.assertEqual(parse_variants("ок\nнастоящий вариант"), ["настоящий вариант"])

    def test_parse_variants_empty(self):
        self.assertEqual(parse_variants(""), [])
        self.assertEqual(parse_variants(None), [])

    def test_expand_abbreviations(self):
        self.assertIn("знания умения навыки", expand_abbreviations("что такое ЗУН-матрица"))

    def test_expand_abbreviations_noop(self):
        self.assertEqual(expand_abbreviations("вопрос про погоду"), "вопрос про погоду")

    def test_rewrite_uses_model_variants(self):
        variants, source = rewrite_query(FakeAgent("вариант раз\nвариант два"), "вопрос")
        self.assertEqual(source, "llm")
        self.assertEqual(variants, ["вариант раз", "вариант два"])

    def test_rewrite_falls_back_on_error(self):
        variants, source = rewrite_query(FakeAgent(fail=True), "что такое MCP")
        self.assertEqual(source, "heuristic")
        self.assertIn("Model Context Protocol", variants[0])

    def test_rewrite_falls_back_on_silence(self):
        variants, source = rewrite_query(FakeAgent(""), "что такое RAG")
        self.assertEqual(source, "heuristic")
        self.assertIn("retrieval augmented generation", variants[0])

    def test_multi_query_fuses_and_counts(self):
        searcher = FakeSearcher({
            "запрос один": [hit("a", "x.md", "т", 0.7, rank=1), hit("b", "y.md", "т", 0.6, rank=2)],
            "запрос два": [hit("b", "y.md", "т", 0.65, rank=1), hit("c", "z.md", "т", 0.5, rank=2)],
        })
        fused = multi_query_search(searcher, ["запрос один", "запрос два"], k=10)
        by_id = {h["chunk_id"]: h for h in fused}
        # b нашёлся обоими вариантами — RRF поднимает его выше остальных.
        self.assertEqual(fused[0]["chunk_id"], "b")
        self.assertEqual(by_id["b"]["found_count"], 2)
        self.assertEqual(by_id["a"]["found_count"], 1)
        # Косинус берётся из лучшего варианта: по нему работает порог.
        self.assertEqual(by_id["b"]["dense_score"], 0.65)
        self.assertEqual(by_id["b"]["found_by"], [0, 1])

    def test_multi_query_without_queries(self):
        self.assertEqual(multi_query_search(FakeSearcher(), []), [])


class PipelineTests(unittest.TestCase):
    def test_precision_counts_expected_sources(self):
        hits = [hit("a", "x.md", "т"), hit("b", "y.md", "т"), hit("c", "x.md", "т")]
        self.assertEqual(precision(hits, {"x.md"}), 0.667)

    def test_precision_none_without_hits(self):
        self.assertIsNone(precision([], {"x.md"}))

    def test_no_rag_pipeline_returns_nothing(self):
        got = retrieve(FakeSearcher(), "вопрос", pipeline="no-rag", filters=Filters())
        self.assertEqual(got.hits, [])
        self.assertEqual(got.context_hits, [])

    def test_baseline_takes_top_k_and_adds_neighbours(self):
        searcher = FakeSearcher({"вопрос": [hit(f"c{i}", f"{i}.md", "т", 0.9 - i * 0.01)
                                            for i in range(10)]},
                                neighbours=[hit("n1", "x.md", "сосед", 0.0)])
        got = retrieve(searcher, "вопрос", pipeline="baseline", filters=Filters(k=3, expand=1))
        self.assertEqual(len(got.hits), 3)
        self.assertEqual(len(got.context_hits), 4)
        self.assertEqual(got.info.method, "none")

    def test_baseline_without_expand_has_no_neighbours(self):
        searcher = FakeSearcher({"вопрос": [hit("a", "x.md", "т")]},
                                neighbours=[hit("n1", "x.md", "сосед")])
        got = retrieve(searcher, "вопрос", pipeline="baseline", filters=Filters(k=5, expand=0))
        self.assertEqual(len(got.context_hits), 1)

    def test_threshold_pipeline_filters_candidates(self):
        searcher = FakeSearcher({"вопрос": [hit("a", "x.md", "т", 0.70), hit("b", "y.md", "т", 0.50),
                                            hit("c", "z.md", "т", 0.30)]})
        got = retrieve(searcher, "вопрос", pipeline="threshold",
                       filters=Filters(k=5, expand=0, margin=0.25))
        self.assertEqual([h["chunk_id"] for h in got.hits], ["a", "b"])
        self.assertEqual(got.info.dropped, 1)

    def test_cross_pipeline_uses_encoder(self):
        searcher = FakeSearcher({"вопрос": [hit("a", "x.md", "слабый", 0.9),
                                            hit("b", "y.md", "сильный", 0.5)]})
        encoder = FakeEncoder({"слабый": 0.02, "сильный": 0.9})
        got = retrieve(searcher, "вопрос", pipeline="cross",
                       filters=Filters(k=2, expand=0, min_score=0.0), encoder=encoder)
        self.assertEqual([h["chunk_id"] for h in got.hits], ["b", "a"])
        self.assertEqual(encoder.calls, 1)

    def test_full_pipeline_rewrites_then_searches_then_reranks(self):
        """Сквозной путь full: rewrite → RRF → cross-encoder → контекст."""
        searcher = FakeSearcher({
            "что такое MCP": [hit("a", "mcp.md", "слабый", 0.60)],
            "Model Context Protocol протокол контекста": [hit("b", "mcp.md", "сильный", 0.58)],
        })
        encoder = FakeEncoder({"слабый": 0.10, "сильный": 0.95})
        agent = FakeAgent("Model Context Protocol протокол контекста")
        got = retrieve(searcher, "что такое MCP", pipeline="full",
                       filters=Filters(k=2, expand=0, min_score=0.0), encoder=encoder, agent=agent)
        # Первым вариантом всегда идёт исходный вопрос: переформулировка может быть хуже.
        self.assertEqual(got.variants,
                         ["что такое MCP", "Model Context Protocol протокол контекста"])
        self.assertEqual(got.rewrite_source, "llm")
        self.assertEqual(got.hits[0]["chunk_id"], "b")
        # Оба варианта запроса ушли в поиск: исходный вопрос и переформулировка.
        self.assertIn("что такое MCP", searcher.queries)
        self.assertIn("Model Context Protocol протокол контекста", searcher.queries)

    def test_heuristic_rewrite_keeps_original_question(self):
        """Без LLM rewrite — это исходный вопрос плюс раскрытие аббревиатур."""
        searcher = FakeSearcher({"что такое ЗУН": [hit("a", "zun.md", "т", 0.6)]})
        got = retrieve(searcher, "что такое ЗУН", pipeline="full",
                       filters=Filters(k=1, expand=0, min_score=0.0),
                       encoder=FakeEncoder({}), agent=None)
        self.assertEqual(got.rewrite_source, "heuristic")
        self.assertEqual(got.variants[0], "что такое ЗУН")
        self.assertIn("знания умения навыки", got.variants[1])

    def test_heuristic_pipeline_orders_by_overlap(self):
        searcher = FakeSearcher({"агентный харнесс": [hit("a", "x.md", "погода", 0.9),
                                                      hit("b", "y.md", "агентный харнесс", 0.5)]})
        got = retrieve(searcher, "агентный харнесс", pipeline="heuristic",
                       filters=Filters(k=2, expand=0, min_score=0.0))
        self.assertEqual(got.hits[0]["chunk_id"], "b")

    def test_unknown_pipeline_raises(self):
        with self.assertRaises(ValueError):
            retrieve(FakeSearcher(), "вопрос", pipeline="magic", filters=Filters())


class SweepMetricsTests(unittest.TestCase):
    def test_metrics_count_rank_and_precision(self):
        questions = [{"expected": ["x.md"]}, {"expected": ["y.md"]}]
        kept = [[hit("a", "x.md", "т"), hit("b", "z.md", "т")],     # rank 1, precision 0.5
                [hit("c", "z.md", "т"), hit("d", "y.md", "т")]]     # rank 2, precision 0.5
        metrics = _metrics(kept, questions, k=5)
        self.assertEqual(metrics["recall@1"], 0.5)
        self.assertEqual(metrics["recall@5"], 1.0)
        self.assertEqual(metrics["mrr"], 0.75)
        self.assertEqual(metrics["precision"], 0.5)
        self.assertEqual(metrics["kept_avg"], 2.0)

    def test_metrics_penalise_lost_note(self):
        questions = [{"expected": ["x.md"]}]
        metrics = _metrics([[hit("a", "z.md", "т")]], questions, k=5)
        self.assertEqual(metrics["recall@5"], 0.0)
        self.assertEqual(metrics["mrr"], 0.0)
        self.assertEqual(metrics["precision"], 0.0)


if __name__ == "__main__":
    unittest.main()
