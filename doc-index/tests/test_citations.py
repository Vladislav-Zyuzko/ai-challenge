"""Тесты источников и цитат (день 24): разбор ответа и проверка выдумок.

Сеть и модель не нужны: проверяются разбор строгого формата, нормализация,
дословность цитат (включая цитаты с многоточием), поиск выдуманных источников
и запрещённых формулировок.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.citations import (  # noqa: E402
    QuoteCheck,
    check_citations,
    normalize,
    parse_answer,
    quotes_block_text,
)
from doc_index.rag import REFUSAL_TEMPLATE, refusal_text  # noqa: E402
from doc_index.verify import asks_clarification, check_forbidden, format_brief  # noqa: E402


def hit(chunk_id, source, text, start=1, end=5):
    return {
        "chunk_id": chunk_id,
        "source": source,
        "text": text,
        "dense_score": 0.7,
        "start_line": start,
        "end_line": end,
        "breadcrumb": "Раздел › Подраздел",
        "section": "Подраздел",
        "title": "Заметка",
    }


GOOD = """ОТВЕТ: Гейты запрещают переход между стадиями до выполнения критериев выхода.
ИСТОЧНИКИ:
- [1] structural:a.md#0000 · 20_Понятия/a.md · Понятия › Гейты › Определение
ЦИТАТЫ:
- [1] «гейт запрещает переход к следующей стадии, пока не выполнены критерии выхода»
"""


class NormalizeTests(unittest.TestCase):
    def test_case_and_yo_are_ignored(self):
        self.assertEqual(normalize("Гейты ЁЖ"), normalize("гейты еж"))

    def test_markdown_and_punctuation_ignored(self):
        self.assertEqual(normalize("**Гейт** — это `правило`."), "гейт это правило")

    def test_quotes_of_all_kinds_ignored(self):
        self.assertEqual(normalize("«текст» \"текст\" “текст”"), "текст текст текст")


class ParseTests(unittest.TestCase):
    def test_parses_blocks(self):
        parsed = parse_answer(GOOD)
        self.assertTrue(parsed.format_ok)
        self.assertIn("запрещают переход", parsed.answer)
        self.assertEqual(len(parsed.sources), 1)
        self.assertEqual(parsed.sources[0].number, 1)
        self.assertEqual(parsed.sources[0].chunk_id, "structural:a.md#0000")
        self.assertEqual(len(parsed.quotes), 1)
        self.assertEqual(parsed.quotes[0].number, 1)
        self.assertEqual(parsed.problems, [])

    def test_format_without_sources_is_flagged(self):
        parsed = parse_answer("ОТВЕТ: просто ответ.\nЦИТАТЫ:\n- [1] «что-то из текста»")
        self.assertIn("нет источников", parsed.problems)

    def test_format_without_quotes_is_flagged(self):
        parsed = parse_answer("ОТВЕТ: ответ.\nИСТОЧНИКИ:\n- [1] note.md · заметка")
        self.assertIn("нет цитат", parsed.problems)

    def test_missing_answer_block_is_flagged(self):
        parsed = parse_answer("ИСТОЧНИКИ:\n- [1] note.md")
        self.assertTrue(any("ОТВЕТ" in problem for problem in parsed.problems))

    def test_bullets_and_numbering_variants(self):
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n* [1] a.md\n1. [2] b.md\n"
                "ЦИТАТЫ:\n• [2] «второй фрагмент текста тут»")
        parsed = parse_answer(text)
        self.assertEqual([s.chunk_id for s in parsed.sources], ["a.md", "b.md"])
        self.assertEqual(parsed.quotes[0].number, 2)

    def test_quote_without_number_is_still_collected(self):
        parsed = parse_answer('ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] a.md\nЦИТАТЫ:\n- «дословный фрагмент без номера»')
        self.assertEqual(len(parsed.quotes), 1)
        self.assertEqual(parsed.quotes[0].number, 0)

    def test_refusal_is_detected(self):
        parsed = parse_answer("Не знаю: в базе нет такого. Уточните вопрос.")
        self.assertTrue(parsed.refusal)

    def test_refusal_variants(self):
        for text in ("Не могу ответить на это", "Нет ответа в базе", "Подходящих данных не нашлось"):
            self.assertTrue(parse_answer(text).refusal, text)

    def test_source_without_dot_separator(self):
        parsed = parse_answer("ОТВЕТ: о\nИСТОЧНИКИ:\n- [1] some/note.md\nЦИТАТЫ:\n- [1] «кусок текста подлиннее»")
        self.assertEqual(parsed.sources[0].chunk_id, "some/note.md")


class CitationCheckTests(unittest.TestCase):
    def setUp(self):
        self.hits = [
            hit("structural:a.md#0000", "20_Понятия/a.md",
                "Гейт запрещает переход к следующей стадии, пока не выполнены критерии выхода."),
            hit("structural:b.md#0001", "20_Понятия/b.md",
                "Неблокирующее предупреждение лишь сигнализирует и не мешает движению дальше."),
        ]

    def test_verbatim_quote_accepted(self):
        parsed = parse_answer(GOOD)
        check = check_citations(parsed, self.hits)
        self.assertEqual((check.verbatim, check.total), (1, 1))
        self.assertEqual((check.sources_real, check.sources_total), (1, 1))

    def test_paraphrase_rejected(self):
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] structural:a.md#0000\n"
                "ЦИТАТЫ:\n- [1] «гейт не даёт перейти дальше, если критерии не выполнены»")
        check = check_citations(parse_answer(text), self.hits)
        self.assertEqual(check.verbatim, 0)
        self.assertEqual(len(check.fabricated), 1)

    def test_quote_with_ellipsis_accepted(self):
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] structural:a.md#0000\n"
                "ЦИТАТЫ:\n- [1] «Гейт запрещает переход к следующей стадии… критерии выхода»")
        check = check_citations(parse_answer(text), self.hits)
        self.assertEqual(check.verbatim, 1)

    def test_quote_from_other_fragment_is_misplaced_not_exact(self):
        """Цитата есть в контексте, но не в том фрагменте, на который ссылается номер."""
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] structural:a.md#0000\n"
                "ЦИТАТЫ:\n- [1] «Неблокирующее предупреждение лишь сигнализирует»")
        check = check_citations(parse_answer(text), self.hits)
        self.assertEqual(check.exact, 0)
        self.assertEqual(check.fabricated, [])
        self.assertEqual(len(check.misplaced), 1)

    def test_invented_source_detected(self):
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] structural:нет-такой.md#0000\n"
                "ЦИТАТЫ:\n- [1] «Гейт запрещает переход к следующей стадии»")
        check = check_citations(parse_answer(text), self.hits)
        self.assertEqual(check.unknown_sources, ["structural:нет-такой.md#0000"])
        self.assertEqual(check.sources_real, 0)

    def test_source_by_note_name_accepted(self):
        """Модель может назвать заметку без каталога и без chunk_id."""
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] a.md · заметка\n"
                "ЦИТАТЫ:\n- [1] «Гейт запрещает переход к следующей стадии»")
        self.assertEqual(check_citations(parse_answer(text), self.hits).sources_real, 1)

    def test_numbering_is_positional(self):
        """Номер источника — позиция фрагмента в контексте, а не rank поиска."""
        hits = [dict(self.hits[1], rank=7), dict(self.hits[0], rank=3)]
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] structural:b.md#0001\n"
                "ЦИТАТЫ:\n- [1] «Неблокирующее предупреждение лишь сигнализирует»")
        check = check_citations(parse_answer(text), hits)
        self.assertEqual(check.verbatim, 1)

    def test_quote_without_number_searched_across_context(self):
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] structural:a.md#0000\n"
                "ЦИТАТЫ:\n- «Неблокирующее предупреждение лишь сигнализирует»")
        check = check_citations(parse_answer(text), self.hits)
        self.assertEqual(check.verbatim, 1)
        self.assertEqual(len(check.unnumbered), 1)
        self.assertEqual(check.exact, 0)

    def test_misplaced_quote_is_not_fabrication(self):
        """Цитата есть в контексте, но приписана другому фрагменту — это смещение ссылки."""
        text = ("ОТВЕТ: ответ\nИСТОЧНИКИ:\n- [1] structural:a.md#0000\n"
                "ЦИТАТЫ:\n- [1] «Неблокирующее предупреждение лишь сигнализирует»")
        check = check_citations(parse_answer(text), self.hits)
        self.assertEqual(check.fabricated, [])
        self.assertEqual(len(check.misplaced), 1)
        self.assertEqual(check.verbatim, 1)
        self.assertEqual(check.exact, 0)
        self.assertEqual(check.attribution_share, 0.0)

    def test_share_and_all_verbatim_flags(self):
        empty = QuoteCheck()
        self.assertEqual(empty.verbatim_share, 0.0)
        self.assertEqual(empty.attribution_share, 0.0)
        self.assertFalse(empty.all_verbatim)
        half = QuoteCheck(total=4, exact=3)
        self.assertEqual(half.verbatim_share, 0.75)
        self.assertTrue(QuoteCheck(total=2, exact=1, misplaced=["x"]).all_verbatim)
        self.assertFalse(QuoteCheck(total=2, exact=1, fabricated=["x"]).all_verbatim)

    def test_quotes_block_text_marks_empty(self):
        self.assertEqual(quotes_block_text([]), "(цитат нет)")


class ForbiddenTests(unittest.TestCase):
    def test_detects_forbidden_phrases(self):
        rules = [["курс доллара составляет"], ["квантовый отжиг — это"]]
        found = check_forbidden("Сегодня курс доллара составляет 100 рублей", rules)
        self.assertEqual(found, ["курс доллара составляет"])

    def test_clean_answer_has_no_hits(self):
        self.assertEqual(check_forbidden("Не знаю, в базе нет данных", [["курс доллара составляет"]]), [])

    def test_no_rules(self):
        self.assertEqual(check_forbidden("любой текст", None), [])


class ClarifyTests(unittest.TestCase):
    def test_detects_clarification_request(self):
        self.assertTrue(asks_clarification("Уточните, пожалуйста, что именно нужно"))
        self.assertTrue(asks_clarification("Какая именно тема вас интересует?"))
        self.assertTrue(asks_clarification("Конкретизируйте вопрос"))

    def test_plain_answer_is_not_a_request(self):
        self.assertFalse(asks_clarification("Гейты запрещают переход между стадиями."))


class RefusalTests(unittest.TestCase):
    def test_refusal_text_mentions_reason_and_asks(self):
        text = refusal_text(0.41, 0.5, "AI SDLC")
        self.assertIn("Не знаю", text)
        self.assertIn("0.41", text)
        self.assertIn("0.50", text)
        self.assertIn("Уточните", text)
        self.assertIn("AI SDLC", text)
        self.assertTrue(asks_clarification(text))

    def test_template_has_no_placeholders_left(self):
        text = REFUSAL_TEMPLATE.format(best=0.4, floor=0.5, topics="темам базы")
        self.assertNotIn("{", text)


class BriefTests(unittest.TestCase):
    """Печать справки /rag-brief: форма ответа и строка машинной проверки."""

    def _result(self, answer, check, **extra):
        base = {
            "question": "вопрос",
            "answer": answer,
            "parsed": parse_answer(answer),
            "check": check,
            "refused": False,
            "refused_by_gate": False,
            "best_score": 0.66,
            "support": None,
            "support_reason": "",
            "context_fragments": 5,
            "sources": [],
            "seconds": 1.0,
        }
        base.update(extra)
        return base

    def test_prints_answer_and_check_line(self):
        check = QuoteCheck(total=2, exact=2, sources_total=2, sources_real=2)
        text = format_brief(self._result("ОТВЕТ: текст\nИСТОЧНИКИ:\n- [1] a.md", check))
        self.assertIn("ОТВЕТ: текст", text)
        self.assertIn("источники 2/2 реальны", text)
        self.assertIn("цитаты 2/2 дословны", text)
        self.assertIn("выдуманных 0", text)
        self.assertIn("0.660", text)

    def test_mentions_misplaced_links(self):
        check = QuoteCheck(total=2, exact=1, misplaced=["цитата"], sources_total=1, sources_real=1)
        text = format_brief(self._result("ОТВЕТ: текст", check))
        self.assertIn("смещённых ссылок 1", text)

    def test_refusal_by_gate_is_labelled(self):
        text = format_brief(self._result(
            "Не знаю: в базе нет ответа. Уточните, пожалуйста.",
            QuoteCheck(), refused=True, refused_by_gate=True, best_score=0.41))
        self.assertIn("отказ: порогом, без вызова модели", text)
        self.assertIn("0.410", text)

    def test_refusal_by_model_is_labelled(self):
        text = format_brief(self._result(
            "Не знаю: во фрагментах нет ответа. Уточните вопрос.",
            QuoteCheck(), refused=True, refused_by_gate=False, best_score=0.70))
        self.assertIn("отказ: моделью", text)

    def test_judge_score_is_shown_when_present(self):
        check = QuoteCheck(total=1, exact=1, sources_total=1, sources_real=1)
        text = format_brief(self._result("ОТВЕТ: текст", check, support=2))
        self.assertIn("судья 2", text)


if __name__ == "__main__":
    unittest.main()
