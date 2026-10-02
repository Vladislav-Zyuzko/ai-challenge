"""Источники и цитаты: разбор ответа и проверка, что они не выдуманы.

Задание дня 24 требует, чтобы ответ **обязательно** содержал источники и цитаты,
и чтобы это можно было проверить на наборе вопросов. Проверка здесь двух видов:

1. **Детерминированная.** Ответ разбирается на блоки (ОТВЕТ / ИСТОЧНИКИ / ЦИТАТЫ),
   затем проверяется: источники вообще есть среди найденных фрагментов (выдуманные
   ловятся), а каждая цитата дословно встречается в тексте того фрагмента, на
   который ссылается её номер. Это ловит главный риск — «цитату» из головы.
2. **Судейская.** Модель отвечает на отдельный вопрос: подтверждают ли приведённые
   цитаты утверждения ответа (0–2). Дословность ещё не означает, что ответ следует
   из цитат: можно набрать верных цитат и сделать из них неверный вывод.

Сравнение строк идёт после нормализации: регистр, «ё», кавычки, markdown-разметка
и пробелы не должны влиять на вердикт — иначе проверка ловила бы оформление,
а не выдумку.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .rag import ANSWER_MARK, QUOTES_MARK, SOURCES_MARK

# Строка источника: «- [1] chunk_id · заметка · раздел». Маркер списка необязателен
# и бывает любым: дефис, звёздочка, «1.» — модель выбирает оформление сама.
SOURCE_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])?\s*\[(\d+)\]\s*(.+)$")
# Строка цитаты: номер и текст в кавычках любого вида.
QUOTE_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])?\s*\[(\d+)\]\s*[«\"“'](.+?)[»\"”']\s*$")
QUOTE_INLINE = re.compile(r"[«\"“]([^«»\"”]{15,})[»\"”]")
_MARKS = (ANSWER_MARK, SOURCES_MARK, QUOTES_MARK)


def normalize(text: str) -> str:
    """Нормализовать текст для сравнения: без разметки, регистра и лишних пробелов."""
    flat = text.replace("ё", "е").replace("Ё", "Е").lower()
    flat = re.sub(r"[*_`>#]+", " ", flat)
    flat = re.sub(r"[«»\"“”'’]", " ", flat)
    flat = re.sub(r"[.,;:!?()\[\]—–-]+", " ", flat)
    return " ".join(flat.split())


@dataclass
class Source:
    number: int
    chunk_id: str
    note: str
    section: str
    raw: str


@dataclass
class Quote:
    number: int
    text: str


@dataclass
class ParsedAnswer:
    """Разобранный ответ: блоки, проблемы формата и признак «не знаю»."""

    answer: str = ""
    sources: list[Source] = field(default_factory=list)
    quotes: list[Quote] = field(default_factory=list)
    format_ok: bool = False
    problems: list[str] = field(default_factory=list)
    refusal: bool = False


def _section(text: str, mark: str, following: tuple[str, ...]) -> str:
    """Вырезать блок от маркера до следующего маркера."""
    start = text.find(mark)
    if start < 0:
        return ""
    body_start = start + len(mark)
    ends = [text.find(next_mark, body_start) for next_mark in following]
    ends = [end for end in ends if end >= 0]
    return text[body_start:min(ends) if ends else len(text)].strip()


def parse_answer(text: str) -> ParsedAnswer:
    """Разобрать ответ модели на ответ, источники и цитаты.

    Разбор терпимый: если модель нарушила формат, это фиксируется в `problems`,
    а не роняет проверку — «формат не соблюдён» и есть результат измерения.
    """
    parsed = ParsedAnswer()
    raw = text or ""
    low = raw.lower()

    # Признак отказа ищем и в строгом блоке ответа, и во всём тексте: шаблон отказа
    # приходит без структуры (модель не вызывалась), и это нормальный случай.
    parsed.refusal = bool(re.search(r"не знаю|не могу ответить|нет ответа|не нашл", low))

    parsed.answer = _section(raw, ANSWER_MARK, (SOURCES_MARK, QUOTES_MARK))
    sources_block = _section(raw, SOURCES_MARK, (QUOTES_MARK,))
    quotes_block = _section(raw, QUOTES_MARK, ())

    if not parsed.answer:
        parsed.problems.append(f"нет блока {ANSWER_MARK}")
    for line in sources_block.splitlines():
        match = SOURCE_LINE.match(line)
        if not match:
            continue
        number, body = int(match.group(1)), match.group(2).strip()
        parts = [part.strip() for part in re.split(r"\s*[·|]\s*", body) if part.strip()]
        chunk_id = parts[0] if parts else ""
        note = parts[1] if len(parts) > 1 else chunk_id
        section = parts[2] if len(parts) > 2 else ""
        parsed.sources.append(Source(number=number, chunk_id=chunk_id, note=note,
                                     section=section, raw=line.strip()))

    for line in quotes_block.splitlines():
        match = QUOTE_LINE.match(line)
        if match:
            parsed.quotes.append(Quote(number=int(match.group(1)), text=match.group(2).strip()))
            continue
        # Модель могла не пронумеровать цитату — берём кавычки как есть.
        for fragment in QUOTE_INLINE.findall(line):
            parsed.quotes.append(Quote(number=0, text=fragment.strip()))

    if not parsed.sources and not parsed.refusal:
        parsed.problems.append("нет источников")
    if not parsed.quotes and not parsed.refusal:
        parsed.problems.append("нет цитат")
    if parsed.answer and (parsed.sources or parsed.refusal):
        parsed.format_ok = True
    return parsed


@dataclass
class QuoteCheck:
    """Что показала проверка цитат против найденных фрагментов.

    Три исхода различаются намеренно, потому что это разные дефекты:

    - `exact` — цитата дословна и стоит под тем номером, из которого взята;
    - `misplaced` — цитата дословна, но приписана другому фрагменту: знание
      настоящее, ссылка неверная;
    - `fabricated` — такого текста в контексте нет вовсе: цитата придумана.
    """

    total: int = 0
    exact: int = 0
    misplaced: list[str] = field(default_factory=list)
    fabricated: list[str] = field(default_factory=list)
    unnumbered: list[str] = field(default_factory=list)
    sources_total: int = 0
    sources_real: int = 0
    unknown_sources: list[str] = field(default_factory=list)

    @property
    def verbatim(self) -> int:
        """Дословных цитат всего: верных по ссылке и misplaced."""
        return self.exact + len(self.misplaced)

    @property
    def verbatim_share(self) -> float:
        return round(self.verbatim / self.total, 3) if self.total else 0.0

    @property
    def attribution_share(self) -> float:
        """Доля цитат, приписанных именно тому фрагменту, откуда они взяты."""
        return round(self.exact / self.total, 3) if self.total else 0.0

    @property
    def all_verbatim(self) -> bool:
        return bool(self.total) and not self.fabricated


def note_of(source: str) -> str:
    """Имя заметки без каталога и расширения — так её узнают и модель, и проверка."""
    tail = source.replace("\\", "/").split("/")[-1]
    return tail[:-3] if tail.lower().endswith(".md") else tail


def _matches_source(hit: dict, token: str) -> bool:
    """Считается ли фрагмент тем, на который сослалась модель.

    Модель называет источник по-разному: chunk_id, путь заметки или её имя без
    каталога — принимаем любое из них.
    """
    token = token.strip().strip("`").lower()
    if not token:
        return False
    if token == str(hit.get("chunk_id", "")).lower():
        return True
    source = str(hit.get("source", "")).lower()
    return token == source or token == note_of(source).lower() or token in source


def _quote_parts(needle: str) -> list[str]:
    """Разбить цитату по многоточиям: модель часто цитирует с пропусками.

    Каждая часть должна встречаться дословно, а вместе они должны идти по порядку.
    Так «фрагмент… продолжение» проверяется честно, а пересказ — нет.
    """
    return [part.strip() for part in re.split(r"\s*(?:…|\.\.\.|\u2026)\s*", needle)
            if len(part.strip()) >= 12]


def _quote_matches(needle: str, haystack: str) -> bool:
    """Дословная цитата, возможно склеенная из нескольких кусков через многоточие."""
    parts = _quote_parts(needle)
    if not parts:
        return False
    position = 0
    for part in parts:
        found = haystack.find(part, position)
        if found < 0:
            return False
        position = found + len(part)
    return True


def check_citations(parsed: ParsedAnswer, hits: list[dict]) -> QuoteCheck:
    """Сверить источники и цитаты с тем, что действительно было в контексте.

    Нумерация — по позиции фрагмента в контексте: ровно так их нумерует
    `build_context`, поэтому «источник [2]» однозначно указывает на второй блок.
    """
    result = QuoteCheck()
    by_number = {number: hit for number, hit in enumerate(hits, start=1)}
    texts = {hit["chunk_id"]: normalize(hit.get("text") or "") for hit in hits}

    for source in parsed.sources:
        result.sources_total += 1
        if _matches_source_any(source, hits):
            result.sources_real += 1
        else:
            result.unknown_sources.append(source.chunk_id or source.raw)

    for quote in parsed.quotes:
        result.total += 1
        target = by_number.get(quote.number) if quote.number else None
        needle = normalize(quote.text)
        if not needle:
            result.fabricated.append(quote.text)
            continue
        if target is not None and _quote_matches(needle, texts.get(target["chunk_id"], "")):
            result.exact += 1
            continue
        # Не в том фрагменте, на который ссылается номер (или номера нет): ищем
        # цитату по всему контексту — тогда это misplaced, а не выдумка.
        if any(_quote_matches(needle, body) for body in texts.values()):
            result.misplaced.append(quote.text)
            if target is None:
                result.unnumbered.append(quote.text)
        else:
            result.fabricated.append(quote.text)
    return result


def _matches_source_any(source: Source, hits: list[dict]) -> bool:
    for token in (source.chunk_id, source.note):
        if token and any(_matches_source(hit, token) for hit in hits):
            return True
    return False


SUPPORT_TEMPLATE = """Проверь, подтверждают ли цитаты утверждения ответа.

ШКАЛА:
2 — все ключевые утверждения ответа опираются на приведённые цитаты;
1 — часть утверждений подтверждается, часть — нет;
0 — цитаты не подтверждают ответ или противоречат ему.

ВОПРОС: {question}

ОТВЕТ:
{answer}

ЦИТАТЫ:
{quotes}

Ответь одной строкой строго в формате: ОЦЕНКА: <0|1|2> — <кратно почему>"""


def quotes_block_text(quotes: list[Quote]) -> str:
    return "\n".join(f"- [{q.number}] «{q.text}»" for q in quotes) or "(цитат нет)"
