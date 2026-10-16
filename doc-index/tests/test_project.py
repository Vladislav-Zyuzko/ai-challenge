"""Тесты дня 31: проект как корпус документации и как источник живого git-контекста.

Проверяется без модели и без сети: сбор корпуса — на временном каталоге, git-функции —
на временном репозитории, который создаётся прямо в тесте. Так проверяется не «наша
машина», а поведение кода: какие файлы попадают в корпус и что именно возвращает git.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index.collect import collect  # noqa: E402
from doc_index.project import (  # noqa: E402
    PROJECT_ALLOW,
    PROJECT_EXCLUDES,
    RepoError,
    _git,
    context_block,
    docs_config,
    git_branch,
    git_diff,
    git_status,
    list_files,
)


def git_init(root: Path) -> None:
    """Пустой репозиторий с веткой main. Настройки коммита — локальные, чтобы тест
    не зависел от настроек машины и не трогал глобальный git config."""
    subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@local"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Тест"], cwd=root, check=True, capture_output=True)


def git_commit(root: Path, message: str) -> None:
    subprocess.run(["git", "add", "-A"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", message], cwd=root, check=True, capture_output=True)


class DocsConfigTest(unittest.TestCase):
    def test_project_preset(self):
        cfg = docs_config(Path(r"C:\some\repo"))
        self.assertEqual(cfg.vault, Path(r"C:\some\repo"))
        self.assertEqual(cfg.out, Path(r"C:\some\repo") / "project-index" / "out")
        self.assertEqual(cfg.suffixes, (".md",))
        self.assertEqual(cfg.exclude_dirs, PROJECT_EXCLUDES)
        self.assertEqual(cfg.allow_dirs, PROJECT_ALLOW)

    def test_explicit_out_wins(self):
        cfg = docs_config(Path(r"C:\some\repo"), Path(r"C:\tmp\idx"))
        self.assertEqual(cfg.out, Path(r"C:\tmp\idx"))

    def test_vault_preset_is_unchanged(self):
        """Пресет проекта не должен менять поведение по умолчанию для хранилища."""
        from doc_index.config import Config, EXCLUDE_DIRS
        self.assertEqual(Config().exclude_dirs, EXCLUDE_DIRS)
        self.assertEqual(Config().allow_dirs, ())


class CollectProjectTest(unittest.TestCase):
    """Что попадает в корпус документации проекта, а что нет."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "README.md").write_text("# Проект\n\nОписание проекта.\n", encoding="utf-8")
        (self.root / "docs").mkdir()
        (self.root / "docs" / "api.md").write_text("# API\n\nОписание API.\n", encoding="utf-8")
        (self.root / "week1").mkdir()
        (self.root / "week1" / "day1.md").write_text("# День 1\n\nЧто сделано.\n", encoding="utf-8")
        # Мусор, которого в корпусе быть не должно.
        (self.root / "node_modules" / "pkg").mkdir(parents=True)
        (self.root / "node_modules" / "pkg" / "README.md").write_text("# чужое\n", encoding="utf-8")
        (self.root / ".git").mkdir()
        (self.root / ".git" / "NOTES.md").write_text("# служебное\n", encoding="utf-8")
        (self.root / "src").mkdir()
        (self.root / "src" / "main.py").write_text("print('код в корпус не идёт')\n", encoding="utf-8")
        (self.root / "empty.md").write_text("", encoding="utf-8")
        (self.root / "huge.md").write_text("x" * 3000, encoding="utf-8")
        # Документация в скрытом каталоге: по умолчанию скрытое пропускается, но скиллы
        # проекта — это документация, поэтому каталог разрешён явно.
        (self.root / ".dsh" / "SKILLS").mkdir(parents=True)
        (self.root / ".dsh" / "SKILLS" / "publish-day.md").write_text("# Публикация дня\n", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def collect(self, **kwargs):
        cfg = docs_config(self.root, self.root / "idx")
        if kwargs:
            from dataclasses import replace
            cfg = replace(cfg, **kwargs)
        return collect(cfg)

    def test_only_markdown_from_project(self):
        notes, _ = self.collect()
        sources = {note.source for note in notes}
        self.assertIn("README.md", sources)
        self.assertIn("docs/api.md", sources)
        self.assertIn("week1/day1.md", sources)
        self.assertNotIn("src/main.py", sources)

    def test_dependencies_and_git_are_skipped(self):
        notes, skipped = self.collect()
        sources = {note.source for note in notes}
        self.assertNotIn("node_modules/pkg/README.md", sources)
        self.assertNotIn(".git/NOTES.md", sources)
        self.assertIn("node_modules/pkg/README.md", skipped)

    def test_allowed_hidden_dir_is_indexed(self):
        notes, _ = self.collect()
        self.assertIn(".dsh/SKILLS/publish-day.md", {note.source for note in notes})

    def test_without_allow_hidden_dir_is_skipped(self):
        notes, _ = self.collect(allow_dirs=())
        self.assertNotIn(".dsh/SKILLS/publish-day.md", {note.source for note in notes})

    def test_empty_and_huge_files_are_skipped(self):
        notes, skipped = self.collect(max_file_bytes=2000)
        sources = {note.source for note in notes}
        self.assertNotIn("empty.md", sources)
        self.assertNotIn("huge.md", sources)
        self.assertIn("huge.md", skipped)

    def test_suffixes_can_widen_the_corpus(self):
        notes, _ = self.collect(suffixes=(".md", ".py"))
        self.assertIn("src/main.py", {note.source for note in notes})


class GitContextTest(unittest.TestCase):
    """Живой контекст проекта: ветка, изменения, diff, список файлов."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        git_init(self.root)
        (self.root / "README.md").write_text("# Проект\n", encoding="utf-8")
        (self.root / "docs").mkdir()
        (self.root / "docs" / "api.md").write_text("# API\n", encoding="utf-8")
        (self.root / ".gitignore").write_text("out/\nnode_modules/\n", encoding="utf-8")
        git_commit(self.root, "первый коммит")

    def tearDown(self):
        self.tmp.cleanup()

    def test_branch_and_head(self):
        got = git_branch(self.root)
        self.assertEqual(got["branch"], "main")
        self.assertEqual(len(got["head"]), 7)
        self.assertEqual(got["subject"], "первый коммит")
        self.assertFalse(got["detached"])

    def test_status_is_clean_after_commit(self):
        self.assertEqual(git_status(self.root)["count"], 0)

    def test_status_lists_changes(self):
        (self.root / "README.md").write_text("# Проект\n\nправка\n", encoding="utf-8")
        (self.root / "новый.md").write_text("# новый\n", encoding="utf-8")
        got = git_status(self.root)
        paths = {item["path"] for item in got["changed"]}
        self.assertEqual(paths, {"README.md", "новый.md"})
        self.assertEqual(got["count"], 2)

    def test_diff_stat_and_truncation(self):
        (self.root / "README.md").write_text("# Проект\n" + "строка\n" * 200, encoding="utf-8")
        short = git_diff(self.root, max_chars=80)
        self.assertTrue(short["truncated"])
        self.assertLessEqual(len(short["text"]), 80)
        full = git_diff(self.root, stat_only=False, max_chars=10_000)
        self.assertIn("README.md", full["text"])

    def test_list_files_respects_gitignore(self):
        (self.root / "out").mkdir()
        (self.root / "out" / "мусор.md").write_text("# мусор\n", encoding="utf-8")
        got = list_files(self.root)
        self.assertIn("README.md", got["files"])
        self.assertNotIn("out/мусор.md", got["files"])

    def test_list_files_pattern(self):
        got = list_files(self.root, pattern="docs/")
        self.assertEqual(got["files"], ["docs/api.md"])
        self.assertEqual(got["total"], 1)

    def test_context_block_has_branch_and_changes(self):
        block = context_block(self.root)
        self.assertIn("ветка: main", block)
        self.assertIn("рабочее дерево чистое", block)
        (self.root / "README.md").write_text("# Проект\n\nправка\n", encoding="utf-8")
        block = context_block(self.root)
        self.assertIn("изменено файлов: 1", block)
        self.assertIn("README.md", block)

    def test_context_block_survives_missing_git(self):
        """Если git недоступен, блок собирается без выдуманных данных."""
        empty = Path(self.tmp.name) / "нет-репозитория"
        empty.mkdir()
        block = context_block(empty)
        self.assertIn("git недоступен", block)
        self.assertNotIn("ветка:", block)

    def test_unknown_subcommand_is_refused(self):
        """Инструмент уходит агенту: превращать его в универсальный git нельзя."""
        with self.assertRaises(RepoError):
            _git(self.root, "push")
        with self.assertRaises(RepoError):
            _git(self.root, "config", "user.name", "взлом")

    def test_missing_repo_is_reported(self):
        empty = Path(self.tmp.name) / "пусто"
        empty.mkdir()
        with self.assertRaises(RepoError):
            git_branch(empty)


if __name__ == "__main__":
    unittest.main()
