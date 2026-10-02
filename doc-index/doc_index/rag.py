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

# --- Строгий режим (день 24): ответ с обязательными источниками и цитатами ----
# Формат машинно разбираемый намеренно: иначе «есть ли источники в каждом ответе»
# и «есть ли цитаты» проверить нельзя, а можно только делать вид, что проверил.
ANSWER_MARK = "ОТВЕТ:"
SOURCES_MARK = "ИСТОЧНИКИ:"
QUOTES_MARK = "ЦИТАТЫ:"
STRICT_RULES = (
    "Пиши по-русски. Ответь строго в таком формате, без пояснений вокруг:\n"
    f"{ANSWER_MARK} <2–5 предложений по существу>\n"
    f"{SOURCES_MARK}\n"
    "- [1] <chunk_id> · <заметка> · <раздел>\n"
    f"{QUOTES_MARK}\n"
    "- [1] «<дословный фрагмент из источника 1>»\n"
    "\n"
    "Правила: нумеруй источники и цитаты согласованно; каждая цитата — точная копия "
    "текста из фрагмента с тем же номером, без пересказа; не выдумывай источники, "
    "которых нет в списке фрагментов; если во фрагментах нет ответа — "
    "напиши «Не знаю», объясни, чего не хватает, и попроси уточнить вопрос."
)
WITH_CONTEXT_STRICT = (
    "Ниже приведены фрагменты базы знаний с их chunk_id. Отвечай только по ним "
    "и цитируй их дословно."
)
# Шаблон отказа: показывается без вызова модели, когда поиск не нашёл ничего
# достаточно близкого. Требование «обязан сказать не знаю» выполняется кодом,
# а не надеждой на послушание модели.
REFUSAL_TEMPLATE = (
    "Не знаю: в базе знаний нет ответа на этот вопрос "
    "(лучшее совпадение {best:.2f} при пороге {floor:.2f}).\n"
    "Уточните, пожалуйста, что именно нужно: база посвящена {topics}."
)


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
    best_score: float | None = None   # лучший косинус контекста (для гейта)
    refused: bool = False             # ответ дан шаблоном отказа, модель не вызывалась
    strict: bool = False              # ответ запрошен в формате с источниками и цитатами


def build_context(hits: list[dict], max_chars: int = 6000, *, with_ids: bool = False) -> str:
    """Фрагменты для промпта: с источником и хлебной крошкой, в пределах бюджета.

    Бюджет важен: без него RAG-режим получил бы в разы больше текста, чем модель
    может осмысленно использовать, и сравнение с «без RAG» стало бы нечестным
    соревнованием объёма.

    `with_ids` добавляет в шапку фрагмента chunk_id и строки: без них модель не
    может сослаться на конкретный фрагмент, а проверка цитат не знает, где искать
    дословный текст. Включается строгим режимом, чтобы промпты дней 22–23
    остались неизменными.
    """
    blocks: list[str] = []
    used = 0
    for index, hit in enumerate(hits, start=1):
        section = hit.get("breadcrumb") or hit.get("section") or hit.get("title")
        if with_ids:
            head = (f"[{index}] chunk_id={hit['chunk_id']} · {hit['source']} · {section} "
                    f"(строки {hit['start_line']}–{hit['end_line']})")
        else:
            head = f"[{index}] {hit['source']} · {section}"
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


def build_prompt(question: str, hits: list[dict] | None = None, *, max_chars: int = 6000,
                 strict: bool = False, topics: str = "") -> str:
    """Промпт для обоих режимов: отличается только блоком контекста.

    `strict` (день 24) добавляет контракт ответа — источники и дословные цитаты —
    и подписывает фрагменты их chunk_id. Обычный режим не меняется: результаты
    дней 22–23 должны оставаться воспроизводимыми.
    """
    if strict:
        lines = [STRICT_RULES, WITH_CONTEXT_STRICT if hits else WITHOUT_CONTEXT]
        if hits:
            lines.append("")
            lines.append(CONTEXT_HEADER)
            lines.append(build_context(hits, max_chars, with_ids=True))
    else:
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


def refusal_text(best: float | None, floor: float, topics: str = "") -> str:
    """Ответ-отказ: обязателен, когда релевантность ниже порога."""
    return REFUSAL_TEMPLATE.format(best=best if best is not None else 0.0, floor=floor,
                                   topics=topics or "других тем")


def answer_question(agent: Answerer, question: str, *, question_id: str, mode: str,
                    hits: list[dict] | None = None, max_chars: int = 6000,
                    strict: bool = False, min_dense: float | None = None,
                    topics: str = "") -> RagAnswer:
    """Ответ на вопрос. При `min_dense` слабый контекст даёт отказ без вызова модели.

    Гейт стоит перед моделью намеренно: «обязан сказать не знаю» — это требование
    к поведению, а не пожелание в промпте. Заодно не тратятся токены на вопрос,
    которого в базе нет.
    """
    if mode not in MODES:
        raise ValueError(f"неизвестный режим: {mode}")
    context = hits if mode == "rag" else None
    best: float | None = None
    if context:
        scores = [float(h["dense_score"]) for h in context
                  if isinstance(h.get("dense_score"), (int, float))]
        best = max(scores) if scores else None
    if context and min_dense is not None and best is not None and best < min_dense:
        return RagAnswer(
            question_id=question_id,
            question=question,
            mode=mode,
            answer=refusal_text(best, min_dense, topics),
            prompt="",
            retrieved=[hit["source"] for hit in context],
            seconds=0.0,
            finish_reason="refused_below_threshold",
            best_score=best,
            refused=True,
            strict=strict,
        )
    prompt = build_prompt(question, context, max_chars=max_chars, strict=strict, topics=topics)
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
        best_score=best,
        strict=strict,
    )
