"""RAG-функция: вопрос → поиск релевантных чанков → объединение с вопросом → ответ агента.

Два режима отличаются **ровно одним блоком промпта**: в `rag` перед вопросом идут
найденные фрагменты с источниками, в `no-rag` их нет и агенту сказано отвечать по своим
знаниям. Формулировка задачи, требования к длине и запрет выдумывать совпадают
посимвольно — иначе сравнение мерило бы разные инструкции, а не наличие контекста.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .agent import AgentReply

RULES = (
    "Пиши по-русски, 3–6 предложений, по существу. "
    "Если данных не хватает — скажи об этом прямо, не выдумывай."
)
WITH_CONTEXT = "Ниже приведены фрагменты базы знаний. Отвечай, опираясь на них."
WITHOUT_CONTEXT = "База знаний недоступна: отвечай по своим общим знаниям."
CONTEXT_HEADER = "ФРАГМЕНТЫ БАЗЫ ЗНАНИЙ:"
MODES = ("rag", "no-rag")


class Answerer(Protocol):
    """Кто угодно, кто умеет ответить на промпт: агент харнесса или чистый клиент модели."""

    model: str
    calls: int
    seconds: float

    def ask(self, prompt: str) -> AgentReply: ...


@dataclass
class RagAnswer:
    question_id: str
    question: str
    mode: str
    answer: str
    prompt: str
    retrieved: list[str] = field(default_factory=list)
    seconds: float = 0.0
    finish_reason: str | None = None


def build_context(hits: list[dict], max_chars: int = 6000) -> str:
    """Фрагменты для промпта: с источником и хлебной крошкой, в пределах бюджета.

    Бюджет важен: без него RAG-режим получил бы в разы больше текста, чем модель
    может осмысленно использовать, и сравнение с «без RAG» стало бы нечестным
    соревнованием объёма.
    """
    blocks: list[str] = []
    used = 0
    for index, hit in enumerate(hits, start=1):
        head = f"[{index}] {hit['source']} · {hit.get('breadcrumb') or hit.get('section') or hit.get('title')}"
        body = hit["text"].strip()
        block = f"{head}\n{body}"
        if used + len(block) > max_chars and blocks:
            break
        blocks.append(block)
        used += len(block) + 2
    return "\n\n".join(blocks)


def usage(agent: object) -> tuple[int, int]:
    """Израсходованные токены (промпт, ответ). У агента харнесса счётчиков нет."""
    stats = getattr(agent, "usage", None)
    if stats is None:
        return (0, 0)
    return (stats.prompt_tokens, stats.completion_tokens)


def build_prompt(question: str, hits: list[dict] | None = None, *, max_chars: int = 6000) -> str:
    """Промпт для обоих режимов: отличается только блоком контекста."""
    lines = [RULES]
    if hits:
        lines.append(WITH_CONTEXT)
        lines.append("")
        lines.append(CONTEXT_HEADER)
        lines.append(build_context(hits, max_chars))
    else:
        lines.append(WITHOUT_CONTEXT)
    lines.append("")
    lines.append(f"ВОПРОС: {question}")
    return "\n".join(lines)


def answer_question(agent: Answerer, question: str, *, question_id: str, mode: str,
                    hits: list[dict] | None = None, max_chars: int = 6000) -> RagAnswer:
    if mode not in MODES:
        raise ValueError(f"неизвестный режим: {mode}")
    prompt = build_prompt(question, hits if mode == "rag" else None, max_chars=max_chars)
    reply: AgentReply = agent.ask(prompt)
    return RagAnswer(
        question_id=question_id,
        question=question,
        mode=mode,
        answer=reply.text,
        prompt=prompt,
        retrieved=[hit["source"] for hit in (hits or [])],
        seconds=reply.seconds,
        finish_reason=reply.finish_reason,
    )
