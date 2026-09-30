"""Сбор корпуса: обход хранилища Obsidian, frontmatter, чистка разметки.

Две вещи, которые здесь важны:

1. **Нумерация строк сохраняется.** Чистка идёт построчно, одна входная строка —
   одна выходная. Поэтому у чанка есть настоящие `start_line`/`end_line`, и по ним
   можно открыть заметку в Obsidian и попасть в то же место.
2. **Чистится только то, что мешает эмбеддингу.** Wikilinks и вложения Obsidian
   в векторе бесполезны (это синтаксис, а не смысл), а callout'ы — обычный текст
   с украшением. Код-блоки и таблицы остаются как есть.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .config import Config, EXCLUDE_DIRS, folder_label

FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
EMBED_RE = re.compile(r"!\[\[([^\]]+)\]\]")
WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
BLOCK_COMMENT_RE = re.compile(r"%%.*?%%", re.S)          # однострочные (многострочные ниже)
CALLOUT_RE = re.compile(r"^>\s*\[!(\w+)\][-+]?\s*(.*)$")


@dataclass
class Note:
    """Заметка хранилища, готовая к чанкингу и эмбеддингу."""

    source: str                 # путь относительно корня хранилища, через /
    abs_path: Path
    folder: str                 # каталог верхнего уровня, например «20_Понятия»
    folder_label: str           # читаемое имя для хлебных крошек
    title: str                  # заголовок H1 или имя файла
    tags: list[str] = field(default_factory=list)
    doc_source: str = ""        # frontmatter «источник» (откуда пришло знание)
    links: list[str] = field(default_factory=list)   # исходящие wikilinks
    lines: list[str] = field(default_factory=list)   # очищенные строки 1:1 с файлом
    raw: str = ""

    @property
    def text(self) -> str:
        return "\n".join(self.lines)


def _tags_of(front: dict) -> list[str]:
    raw = front.get("tags") or front.get("теги") or []
    if isinstance(raw, str):
        raw = [t.strip() for t in raw.strip("[]").split(",")]
    return [str(t).strip().lstrip("#") for t in raw if str(t).strip()]


def strip_block_comments(text: str) -> str:
    """Многострочные `%%комментарии%%` → столько же переводов строки.

    Именно переводами, а не пустотой: иначе поедут номера строк, а по ним мы
    показываем, откуда чанк взялся.
    """
    return re.sub(r"%%.*?%%", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)


def clean_line(line: str) -> str:
    """Одна строка: убрать синтаксис Obsidian, сохранив смысл и структуру."""
    callout = CALLOUT_RE.match(line)
    if callout:                      # «> [!note] Заголовок» → «Заголовок»
        return callout.group(2).strip()
    out = EMBED_RE.sub("", line)     # вложения (![[картинка]]) в вектор не нужны
    # [[Заметка|подпись]] → подпись, [[Заметка]] → имя заметки без пути и .md
    out = WIKILINK_RE.sub(
        lambda m: (m.group(2) or m.group(1).split("/")[-1].removesuffix(".md")).strip(),
        out,
    )
    out = BLOCK_COMMENT_RE.sub("", out)
    stripped = out.lstrip()
    if stripped.startswith(">"):     # обычная цитата внутри callout'а
        out = stripped[1:].lstrip()
    return out.rstrip()


def parse_note(path: Path, root: Path) -> Note:
    raw = path.read_text(encoding="utf-8")
    front: dict = {}
    body_start = 0
    match = FRONTMATTER_RE.match(raw)
    if match:
        try:
            loaded = yaml.safe_load(match.group(1)) or {}
            front = loaded if isinstance(loaded, dict) else {}
        except yaml.YAMLError:
            front = {}
        # Длина блока в строках, а не число переводов строки: закрывающий `---`
        # тоже часть frontmatter, иначе он остаётся в тексте заметки.
        body_start = len(match.group(0).split("\n")) - 1

    raw_lines = raw.splitlines()
    body = strip_block_comments("\n".join(raw_lines[body_start:])).splitlines()
    # Строки до тела (frontmatter) заменяем пустыми — нумерация остаётся настоящей.
    lines = ["" for _ in range(body_start)] + [clean_line(line) for line in body]

    rel = path.relative_to(root).as_posix()
    folder = Path(rel).parts[0] if len(Path(rel).parts) > 1 else ""
    if rel.startswith("ai-gladkov/") and len(Path(rel).parts) > 2:
        folder = "/".join(Path(rel).parts[:2])       # ai-gladkov/30_Понятия_1

    title = str(front.get("title") or "").strip()
    if not title:
        for line in lines:
            h = HEADING_RE.match(line)
            if h and len(h.group(1)) == 1:
                title = h.group(2).strip()
                break
    if not title:
        title = path.stem

    # Ссылки собираем по СЫРЫМ строкам: в очищенных синтаксиса `[[…]]` уже нет.
    links: list[str] = []
    for line in raw_lines[body_start:]:
        for target in WIKILINK_RE.findall(line):
            name = target[0].split("/")[-1].removesuffix(".md").strip()
            if name and name not in links:
                links.append(name)

    return Note(
        source=rel,
        abs_path=path,
        folder=folder,
        # Заметки в корне хранилища: подписываем их именем самого хранилища, иначе
        # хлебная крошка начинается с пустоты.
        folder_label=folder_label(folder) or root.name,
        title=title,
        tags=_tags_of(front),
        doc_source=str(front.get("источник") or "").strip(),
        links=links,
        lines=lines,
        raw=raw,
    )


def collect(cfg: Config) -> tuple[list[Note], list[str]]:
    """Все заметки хранилища. Возвращает (заметки, пропущенные пути)."""
    root = cfg.vault
    if not root.is_dir():
        raise FileNotFoundError(f"нет каталога корпуса: {root}")
    notes: list[Note] = []
    skipped: list[str] = []
    for path in sorted(root.rglob("*.md")):
        rel_parts = path.relative_to(root).parts
        if any(part in EXCLUDE_DIRS or part.startswith(".") for part in rel_parts):
            skipped.append(path.relative_to(root).as_posix())
            continue
        if path.stat().st_size == 0:
            skipped.append(path.relative_to(root).as_posix())
            continue
        notes.append(parse_note(path, root))
    return notes, skipped
