"""Тесты чанкеров: границы, метаданные, хлебные крошки, склейка и потери текста."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.chunk import (  # noqa: E402
    NO_BREADCRUMB,
    build_chunks,
    chunk_fixed,
    chunk_stats,
    chunk_structural,
    split_sections,
)
from doc_index.collect import Note  # noqa: E402
from doc_index.config import Config  # noqa: E402

CFG = Config()

LONG = "Слово " * 400          # ~2400 символов одной строкой — длиннее любого лимита
SAMPLE_LINES = [
    "# Карточка понятия",
    "Вводный абзац до первого подзаголовка.",
    "",
    "## Определение",
    "Определение в одну строку.",
    "",
    "## Как это описано в документе",
    LONG.strip(),
    "",
    "### Подраздел",
    "Короткий подраздел.",
    "",
    "## Хвост",
    "Совсем короткий хвост.",
]


def make_note(lines: list[str], source: str = "20_Понятия/01_Карточка.md") -> Note:
    return Note(
        source=source,
        abs_path=Path(source),
        folder="20_Понятия",
        folder_label="Понятия",
        title="Карточка понятия",
        tags=["ai-sdlc"],
        links=[],
        lines=lines,
    )


NORMAL_LINES = ["# Заметка о контексте"] + [
    f"Строка номер {i}: агент собирает контекст и вызывает инструменты." for i in range(40)
]


class FixedChunkTest(unittest.TestCase):
    def test_размер_не_превышает_лимит(self) -> None:
        chunks = chunk_fixed(make_note(SAMPLE_LINES), CFG)
        self.assertTrue(chunks)
        self.assertLessEqual(max(c.n_chars for c in chunks), CFG.fixed_size)

    def test_перекрытие_есть(self) -> None:
        chunks = chunk_fixed(make_note(NORMAL_LINES), CFG)
        self.assertGreater(len(chunks), 1)
        # последняя строка первого чанка должна начинать второй: это и есть перекрытие
        tail = [line for line in chunks[0].text.split("\n") if line.strip()][-1]
        self.assertIn(tail.strip(), chunks[1].text)

    def test_метаданные_заполнены(self) -> None:
        chunks = chunk_fixed(make_note(SAMPLE_LINES), CFG)
        for chunk in chunks:
            self.assertTrue(chunk.chunk_id.startswith("fixed:"))
            self.assertEqual(chunk.source, "20_Понятия/01_Карточка.md")
            self.assertEqual(chunk.folder_label, "Понятия")
            self.assertTrue(chunk.section, "секция должна быть заполнена и у оконной стратегии")
            self.assertIn("теги:", chunk.embed_text)
            self.assertLessEqual(chunk.start_line, chunk.end_line)

    def test_уникальные_идентификаторы(self) -> None:
        chunks = chunk_fixed(make_note(SAMPLE_LINES), CFG)
        self.assertEqual(len({c.chunk_id for c in chunks}), len(chunks))


class StructuralChunkTest(unittest.TestCase):
    def test_хлебная_крошка_содержит_путь(self) -> None:
        chunks = chunk_structural(make_note(SAMPLE_LINES), CFG)
        target = next(c for c in chunks if c.section == "Как это описано в документе")
        self.assertEqual(target.breadcrumb, "Понятия › Карточка понятия › Как это описано в документе")
        self.assertIn(target.breadcrumb, target.embed_text)

    def test_склеенная_секция_оставляет_заголовок_в_тексте(self) -> None:
        # «## Определение» короткая и приклеивается к предыдущему чанку: слово, по
        # которому её ищут, не должно из-за этого пропасть из текста
        chunks = chunk_structural(make_note(SAMPLE_LINES), CFG)
        merged = [c for c in chunks if c.merged]
        self.assertTrue(merged)
        self.assertTrue(any("Определение" in c.text for c in merged))

    def test_вводный_абзац_не_теряется(self) -> None:
        texts = " ".join(c.text for c in chunk_structural(make_note(SAMPLE_LINES), CFG))
        self.assertIn("Вводный абзац до первого подзаголовка", texts)

    def test_текст_родительской_секции_не_теряется(self) -> None:
        lines = ["# Заметка", "Текст родителя.", "## Дочерний", "Текст ребёнка."]
        texts = " ".join(c.text for c in chunk_structural(make_note(lines), CFG))
        self.assertIn("Текст родителя", texts)
        self.assertIn("Текст ребёнка", texts)

    def test_длинная_секция_режется_и_не_превышает_лимит(self) -> None:
        chunks = chunk_structural(make_note(SAMPLE_LINES), CFG)
        self.assertLessEqual(max(c.n_chars for c in chunks), CFG.structural_max)

    def test_короткая_секция_склеивается(self) -> None:
        chunks = chunk_structural(make_note(SAMPLE_LINES), CFG)
        self.assertTrue(any(c.merged for c in chunks))
        self.assertTrue(any("Совсем короткий хвост" in c.text for c in chunks))

    def test_заголовки_в_код_блоке_не_секции(self) -> None:
        lines = ["# Заметка", "```", "## это код, а не заголовок", "```", "## Настоящий заголовок", "текст"]
        sections = split_sections(lines, "Заметка")
        titles = [s["title"] for s in sections]
        self.assertIn("Настоящий заголовок", titles)
        self.assertNotIn("это код, а не заголовок", titles)

    def test_заметка_без_заголовков_индексируется(self) -> None:
        chunks = chunk_structural(make_note(["Просто текст без заголовков.", "Вторая строка."]), CFG)
        self.assertTrue(chunks)
        self.assertIn("Просто текст", chunks[0].text)

    def test_абляция_без_крошек_меняет_только_embed_text(self) -> None:
        with_bc = chunk_structural(make_note(SAMPLE_LINES), CFG)
        without = chunk_structural(make_note(SAMPLE_LINES), CFG, strategy=NO_BREADCRUMB,
                                  with_breadcrumb=False)
        self.assertEqual(len(with_bc), len(without))
        self.assertEqual([c.text for c in with_bc], [c.text for c in without])
        self.assertNotEqual(with_bc[0].embed_text, without[0].embed_text)


class BuildTest(unittest.TestCase):
    def test_обе_стратегии_по_всем_заметкам(self) -> None:
        notes = [
            make_note(SAMPLE_LINES, "20_Понятия/01_Карточка.md"),
            make_note(["# Вторая", "## Раздел", "текст"], "20_Понятия/02_Вторая.md"),
        ]
        fixed = build_chunks(notes, CFG, "fixed")
        structural = build_chunks(notes, CFG, "structural")
        self.assertEqual(len({c.source for c in fixed}), 2)
        self.assertEqual(len({c.source for c in structural}), 2)
        self.assertEqual(len({c.chunk_id for c in structural}), len(structural))

    def test_статистика_считается(self) -> None:
        stats = chunk_stats(build_chunks([make_note(SAMPLE_LINES)], CFG, "structural"))
        self.assertGreater(stats["chunks"], 0)
        self.assertGreater(stats["chars_avg"], 0)
        self.assertIn("merged", stats)
        self.assertEqual(stats["sources"], 1)

    def test_неизвестная_стратегия_падает(self) -> None:
        with self.assertRaises(ValueError):
            build_chunks([make_note(SAMPLE_LINES)], CFG, "нет-такой")


if __name__ == "__main__":
    unittest.main(verbosity=2)
