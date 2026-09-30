"""Две стратегии чанкинга и одинаковые метаданные для обеих.

Стратегия 1 (`fixed`) — скользящее окно по символам с перекрытием, рез по строкам.
О структуре заметки не знает, но `section` заполняет: ближайший заголовок выше начала
окна. Это нужно для честного сравнения — иначе оконная стратегия проигрывала бы не
из-за границ чанков, а из-за пустых метаданных.

Стратегия 2 (`structural`) — по иерархии заголовков. Листовая секция = чанк, в текст
для модели спереди уходит хлебная крошка («Понятия › Агент разработки ПО › Определение»).
Длинные секции режутся по абзацам, короткие приклеиваются к предыдущему чанку, чтобы
в индексе не было огрызков из одного заголовка.

Обе стратегии возвращают `Chunk` с одним и тем же набором полей — по нему и сравниваем.
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

from .collect import HEADING_RE, Note
from .config import Config

# Соотношение символов и токенов для XLM-R-токенизатора (он же у bge-m3), замерено
# на русском тексте: ≈3.4 символа на токен. Оценка нужна только для отчёта: лимит
# bge-m3 в 8192 токена при окне 1000 символов недостижим.
CHARS_PER_TOKEN = 3.4
FENCE_RE = re.compile(r"^\s*(```|~~~)")


@dataclass
class Chunk:
    chunk_id: str
    strategy: str
    source: str
    file: str
    title: str
    section: str
    breadcrumb: str
    folder: str
    folder_label: str
    tags: list[str] = field(default_factory=list)
    links: list[str] = field(default_factory=list)
    doc_source: str = ""
    start_line: int = 0
    end_line: int = 0
    text: str = ""            # то, что показываем человеку
    embed_text: str = ""      # то, что уходит в модель (крошка + теги + текст)
    merged: bool = False      # в чанк доклеены короткие секции

    @property
    def n_chars(self) -> int:
        return len(self.text)

    @property
    def n_tokens_est(self) -> int:
        return round(self.n_chars / CHARS_PER_TOKEN)

    def row(self) -> dict:
        """Плоская запись для SQLite/JSON."""
        return {
            "chunk_id": self.chunk_id,
            "strategy": self.strategy,
            "source": self.source,
            "file": self.file,
            "title": self.title,
            "section": self.section,
            "breadcrumb": self.breadcrumb,
            "folder": self.folder,
            "folder_label": self.folder_label,
            "tags": self.tags,
            "links": self.links,
            "doc_source": self.doc_source,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "n_chars": self.n_chars,
            "n_tokens_est": self.n_tokens_est,
            "merged": self.merged,
            "text": self.text,
        }


# ───────────────────────── разбор заголовков ─────────────────────────

def heading_map(lines: list[str]) -> list[str | None]:
    """Для каждой строки — заголовок, если строка им является и он не внутри код-блока.

    Без учёта ``` решётки внутри примеров кода ломали бы и секции, и хлебные крошки.
    """
    heads: list[str | None] = [None] * len(lines)
    in_fence = False
    for i, line in enumerate(lines):
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING_RE.match(line)
        if m:
            heads[i] = m.group(2).strip()
    return heads


def heading_before(heads: list[str | None], idx: int, default: str) -> str:
    for i in range(min(idx, len(heads) - 1), -1, -1):
        if heads[i]:
            return heads[i]  # type: ignore[return-value]
    return default


def heading_level(line: str) -> int:
    m = HEADING_RE.match(line)
    return len(m.group(1)) if m else 0


def make_embed_text(breadcrumb: str, tags: list[str], text: str, *, with_breadcrumb: bool = True) -> str:
    """Текст для модели: крошка и теги спереди — они отделяют «где это» от «что тут»."""
    head: list[str] = []
    if with_breadcrumb and breadcrumb:
        head.append(breadcrumb)
    if tags:
        head.append("теги: " + ", ".join(tags))
    return ("\n".join(head) + "\n\n" + text).strip() if head else text


def _new_chunk(note: Note, strategy: str, index: int, section: str, breadcrumb: str,
               start: int, end: int, text: str, *, with_breadcrumb: bool = True) -> Chunk:
    return Chunk(
        chunk_id=f"{strategy}:{note.source}#{index:04d}",
        strategy=strategy,
        source=note.source,
        file=note.abs_path.name,
        title=note.title,
        section=section,
        breadcrumb=breadcrumb,
        folder=note.folder,
        folder_label=note.folder_label,
        tags=list(note.tags),
        links=list(note.links),
        doc_source=note.doc_source,
        start_line=start,
        end_line=end,
        text=text,
        embed_text=make_embed_text(breadcrumb, note.tags, text, with_breadcrumb=with_breadcrumb),
    )


# ───────────────────────── стратегия 1: фиксированный размер ─────────────────────────

def _wrap_long_line(line: str, limit: int):
    """Одну строку длиннее лимита режем по словам.

    В этих заметках абзац часто записан одной строкой. Без этой нарезки «окно 1000»
    на деле давало чанки до 1600 символов, и стратегия переставала быть оконной.
    Номер строки у всех кусков один и тот же — он и уходит в метаданные.
    """
    if len(line) <= limit:
        yield line
        return
    buf = ""
    for word in line.split(" "):
        if buf and len(buf) + 1 + len(word) > limit:
            yield buf
            buf = word
        else:
            buf = f"{buf} {word}" if buf else word
    if buf:
        yield buf


def chunk_fixed(note: Note, cfg: Config, *, strategy: str = "fixed") -> list[Chunk]:
    """Окно `fixed_size` символов с перекрытием `fixed_overlap`, рез по границам строк."""
    chunks: list[Chunk] = []
    heads = heading_map(note.lines)
    buf: list[tuple[int, str]] = []          # (номер строки в заметке, кусок текста)
    size = 0
    index = 0

    def flush() -> None:
        nonlocal buf, size, index
        if not buf:
            return
        text = "\n".join(piece for _, piece in buf).strip()
        start_line, end_line = buf[0][0], buf[-1][0]
        if text:
            section = heading_before(heads, start_line, note.title)
            breadcrumb = f"{note.folder_label} › {section}" if note.folder_label else section
            chunks.append(_new_chunk(note, strategy, index, section, breadcrumb,
                                     start_line, end_line, text))
            index += 1
        # перекрытие: хвост не меньше fixed_overlap, но и не больше половины окна —
        # иначе хвост не оставляет места новому тексту и чанк выходит за лимит
        kept: list[tuple[int, str]] = []
        acc = 0
        for item in reversed(buf):
            if kept and acc + len(item[1]) + 1 > cfg.fixed_size // 2:
                break
            kept.insert(0, item)
            acc += len(item[1]) + 1
            if acc >= cfg.fixed_overlap:
                break
        buf = kept if acc >= cfg.fixed_overlap else []
        size = sum(len(piece) + 1 for _, piece in buf)

    for line_no, line in enumerate(note.lines):
        for piece in _wrap_long_line(line, cfg.fixed_size):
            # Сбрасываем ДО добавления: иначе окно перерастало лимит на длину куска,
            # и «чанки по 1000 символов» на деле доходили до 1600.
            if buf and size + len(piece) + 1 > cfg.fixed_size:
                flush()
                if buf and size + len(piece) + 1 > cfg.fixed_size:
                    buf, size = [], 0        # перекрытие не помещается — жертвуем им
            buf.append((line_no, piece))
            size += len(piece) + 1
            if size >= cfg.fixed_size:
                flush()
    flush()
    return chunks


# ───────────────────────── стратегия 2: по структуре ─────────────────────────

def split_sections(lines: list[str], note_title: str) -> list[dict]:
    """Секции заметки по заголовкам; вводный текст до первого заголовка не теряется."""
    heads = heading_map(lines)
    head_idx = [i for i, title in enumerate(heads) if title]
    levels = {i: heading_level(lines[i]) for i in head_idx}
    sections: list[dict] = []

    preamble_end = head_idx[0] if head_idx else len(lines)
    if any(line.strip() for line in lines[:preamble_end]):
        sections.append({
            "level": 0,
            "title": note_title,
            "heading_line": 0,
            "body": lines[:preamble_end],
            "end_line": max(preamble_end - 1, 0),
            "path": [note_title],
            "has_children": False,
        })

    stack: list[tuple[int, str]] = []
    for pos, idx in enumerate(head_idx):
        end = head_idx[pos + 1] if pos + 1 < len(head_idx) else len(lines)
        level = levels[idx]
        title = heads[idx] or note_title
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, title))
        next_level = levels[head_idx[pos + 1]] if pos + 1 < len(head_idx) else 0
        sections.append({
            "level": level,
            "title": title,
            "heading_line": idx,
            "body": lines[idx + 1:end],
            "end_line": max(end - 1, idx),
            "path": [t for _, t in stack],
            "has_children": next_level > level,
        })
    return sections


def _split_long(text: str, limit: int) -> list[str]:
    """Длинную секцию режем по абзацам, а слишком длинный абзац — по строкам."""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    buf = ""
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if buf and len(buf) + len(para) + 2 > limit:
            parts.append(buf)
            buf = para
        else:
            buf = f"{buf}\n\n{para}" if buf else para
        while len(buf) > limit:
            cut = buf.rfind("\n", 0, limit)
            cut = cut if cut > limit // 2 else limit
            parts.append(buf[:cut].strip())
            buf = buf[cut:].strip()
    if buf:
        parts.append(buf)
    return [p for p in parts if p]


def chunk_structural(note: Note, cfg: Config, *, strategy: str = "structural",
                     with_breadcrumb: bool = True) -> list[Chunk]:
    """Листовые секции заметки; короткие приклеиваются к предыдущему чанку."""
    chunks: list[Chunk] = []
    for section in split_sections(note.lines, note.title):
        body = "\n".join(section["body"]).strip()
        # У секции с детьми тоже есть свой текст — тот, что идёт до первого подзаголовка
        # (обычно вводный абзац заметки). Раньше он терялся: раздел пропускался целиком.
        if not body:
            continue
        path = section["path"]
        breadcrumb = " › ".join([note.folder_label, *path]) if note.folder_label else " › ".join(path)
        for part in _split_long(body, cfg.structural_max):
            # Заголовок поглощённой секции оставляем в тексте: иначе слово, по которому
            # её ищут («Почему это важно»), исчезает из выдачи.
            label = section["title"]
            prev = chunks[-1] if chunks else None
            addition = part
            if prev is not None and label and label not in prev.text:
                addition = f"{label}\n\n{part}"
            # короткий хвост клеим к предыдущему чанку, если он ещё не распух
            if (prev is not None and len(part) < cfg.structural_min
                    and len(prev.text) + len(addition) + 2 <= cfg.structural_max):
                prev.text = f"{prev.text}\n\n{addition}"
                prev.embed_text = make_embed_text(prev.breadcrumb, prev.tags, prev.text,
                                                  with_breadcrumb=with_breadcrumb)
                prev.end_line = section["end_line"]
                prev.merged = True
                continue
            chunks.append(_new_chunk(
                note, strategy, len(chunks), section["title"], breadcrumb,
                section["heading_line"], section["end_line"], part,
                with_breadcrumb=with_breadcrumb,
            ))
    return chunks


STRATEGIES = {
    "fixed": chunk_fixed,
    "structural": chunk_structural,
}

# Вариант структурной стратегии без хлебных крошек — для абляции: он показывает,
# сколько даёт именно крошка, а не сама нарезка по секциям.
NO_BREADCRUMB = "structural_nobc"


def build_chunks(notes: list[Note], cfg: Config, strategy: str, *,
                 with_breadcrumb: bool = True) -> list[Chunk]:
    if strategy == NO_BREADCRUMB:
        out: list[Chunk] = []
        for note in notes:
            out.extend(chunk_structural(note, cfg, strategy=NO_BREADCRUMB, with_breadcrumb=False))
        return out
    if strategy not in STRATEGIES:
        raise ValueError(f"неизвестная стратегия: {strategy}")
    out = []
    for note in notes:
        if strategy == "structural":
            out.extend(chunk_structural(note, cfg, strategy=strategy, with_breadcrumb=with_breadcrumb))
        else:
            out.extend(chunk_fixed(note, cfg, strategy=strategy))
    return out


def chunk_stats(chunks: list[Chunk]) -> dict:
    """Статистика чанков для сравнения стратегий."""
    sizes = [c.n_chars for c in chunks]
    if not sizes:
        return {"chunks": 0}
    return {
        "chunks": len(chunks),
        "sources": len({c.source for c in chunks}),
        "chars_total": sum(sizes),
        "chars_avg": round(statistics.mean(sizes)),
        "chars_median": round(statistics.median(sizes)),
        "chars_min": min(sizes),
        "chars_max": max(sizes),
        "chunks_under_200": sum(1 for s in sizes if s < 200),
        "with_section": sum(1 for c in chunks if c.section),
        "with_tags": sum(1 for c in chunks if c.tags),
        "merged": sum(1 for c in chunks if c.merged),
        "tokens_est_avg": round(statistics.mean([c.n_tokens_est for c in chunks])),
    }
