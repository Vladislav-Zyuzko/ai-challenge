"""Тесты сбора корпуса: frontmatter, чистка разметки, сохранение нумерации строк."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.collect import collect, parse_note, strip_block_comments  # noqa: E402
from doc_index.config import Config  # noqa: E402

SAMPLE = """---
tags: [ai-sdlc, понятие]
источник: "TRACKS_ZUN.pdf"
---

# Агент разработки ПО

Вводный абзац со ссылкой [[02_Модель|модель]] и вложением ![[картинка.png]].

> [!note] Важное замечание
> Текст внутри callout'а.

```
# это заголовок внутри код-блока, он не заголовок
```

%%комментарий
на две строки%%

## Определение

Агент — это инструмент.
"""


class CollectTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "20_Понятия").mkdir()
        (self.root / "_tools").mkdir()
        self.path = self.root / "20_Понятия" / "01_Агент.md"
        self.path.write_text(SAMPLE, encoding="utf-8")
        # в служебном каталоге лежит заметка — она тоже не должна попасть в индекс
        (self.root / "_tools" / "заметка.md").write_text("# служебное", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_frontmatter_и_теги(self) -> None:
        note = parse_note(self.path, self.root)
        self.assertEqual(note.tags, ["ai-sdlc", "понятие"])
        self.assertEqual(note.doc_source, "TRACKS_ZUN.pdf")
        self.assertEqual(note.title, "Агент разработки ПО")
        self.assertEqual(note.folder, "20_Понятия")
        self.assertEqual(note.folder_label, "Понятия")

    def test_чистка_разметки(self) -> None:
        note = parse_note(self.path, self.root)
        text = note.text
        self.assertIn("модель", text)                  # [[02_Модель|модель]] → подпись
        self.assertNotIn("[[", text)                   # wikilinks убраны
        self.assertNotIn("![[", text)                  # вложения убраны
        self.assertIn("Важное замечание", text)        # callout превратился в текст
        self.assertNotIn("[!note]", text)
        self.assertNotIn("%%", text)                   # блочный комментарий вырезан

    def test_нумерация_строк_сохраняется(self) -> None:
        note = parse_note(self.path, self.root)
        self.assertEqual(len(note.lines), len(SAMPLE.splitlines()))
        # H1 стоит в файле 6-й строкой (после четырёх строк frontmatter и пустой),
        # а закрывающий `---` не должен оставаться в тексте заметки.
        self.assertEqual(note.lines[5].strip(), "# Агент разработки ПО")
        self.assertNotIn("---", note.text.splitlines()[:6])

    def test_блочный_комментарий_не_сдвигает_строки(self) -> None:
        text = "первая\n%%две\nстроки%%\nпоследняя"
        cleaned = strip_block_comments(text)
        self.assertEqual(len(cleaned.splitlines()), len(text.splitlines()))

    def test_служебный_каталог_исключается(self) -> None:
        cfg = Config(vault=self.root, out=self.root / "out")
        notes, skipped = collect(cfg)
        self.assertEqual([n.source for n in notes], ["20_Понятия/01_Агент.md"])
        self.assertEqual(skipped, ["_tools/заметка.md"])

    def test_ссылки_собираются(self) -> None:
        note = parse_note(self.path, self.root)
        self.assertIn("02_Модель", note.links)


if __name__ == "__main__":
    unittest.main(verbosity=2)
