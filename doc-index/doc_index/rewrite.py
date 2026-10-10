"""Query rewrite: переформулировка вопроса перед поиском.

Зачем. Вопрос пользователя и формулировка в базе знаний — разные тексты. Вопрос
«что такое ЗУН-матрица» не содержит слов «знания умения навыки», а заметка может
называться именно так. Переформулировка даёт поиску несколько заходов вместо одного.

Две стратегии:

1. **Multi-query через LLM** (`variants`): модель делает 3 варианта запроса —
   синонимы, раскрытие аббревиатур, развёрнутую формулировку. Результаты поиска по
   вариантам сливаются через RRF: попадание в несколько списков выигрывает у
   первого места в одном.
2. **Эвристика** (`expand_abbreviations`): локальный словарь аббревиатур корпуса.
   Работает без сети и модели, поэтому используется и как запасной вариант, когда
   LLM недоступна.

Rewrite не видит базу знаний — только вопрос, — поэтому не может «подсмотреть»
ответ и не влияет на честность сравнения.
"""
from __future__ import annotations

import re

from .search import rrf

REWRITE_TEMPLATE = """Ты помогаешь искать по базе знаний об AI SDLC, агентах и RAG.
Переформулируй вопрос так, чтобы поиск по базе знаний нашёл ответ.

ТРЕБОВАНИЯ:
- {n} варианта, каждый с новой строки, без нумерации и пояснений;
- раскрой аббревиатуры и добавь синонимы (например «ЗУН» → «знания умения навыки»);
- один вариант — короткий набор ключевых слов, другой — развёрнутая формулировка;
- не отвечай на вопрос и не добавляй факты, которых нет в вопросе.

ВОПРОС: {question}

ВАРИАНТЫ:"""

# Аббревиатуры и термины, которые в корпусе встречаются в двух видах.
EXPANSIONS: dict[str, str] = {
    "зун": "знания умения навыки",
    "mcp": "Model Context Protocol протокол контекста",
    "rag": "retrieval augmented generation поиск по базе знаний",
    "sdlc": "жизненный цикл разработки программного обеспечения",
    "llm": "большая языковая модель",
    "rrf": "reciprocal rank fusion слияние результатов поиска",
    "bm25": "лексический поиск bm25",
    "faiss": "векторный индекс faiss",
    "hyde": "hypothetical document embeddings",
    "top-k": "top k фрагментов контекста",
    "эмбеддинг": "векторное представление текста embedding",
    "эмбеддинги": "векторные представления текста embeddings",
    "чанкинг": "разбиение документа на фрагменты chunking",
    "харнесс": "обвязка агента harness",
    "гейт": "проверка качества gate",
}

_BULLET = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s*")


def expand_abbreviations(question: str) -> str:
    """Дописать к вопросу расшифровки известных аббревиатур (без модели)."""
    low = question.lower()
    extras = [text for key, text in EXPANSIONS.items() if key in low]
    return f"{question} {' '.join(extras)}" if extras else question


def parse_variants(text: str, limit: int = 3) -> list[str]:
    """Вытащить варианты из ответа модели: строки, без маркеров и дублей."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in (text or "").splitlines():
        line = _BULLET.sub("", raw).strip().strip('"').strip()
        if not line or len(line) < 3:
            continue
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(line)
        if len(out) >= limit:
            break
    return out


def rewrite_query(agent, question: str, *, n: int = 3) -> tuple[list[str], str]:
    """Варианты запроса: от модели, иначе эвристика. Возвращает (варианты, источник)."""
    prompt = REWRITE_TEMPLATE.format(n=n, question=question)
    try:
        reply = agent.ask(prompt)
    except Exception:
        return [expand_abbreviations(question)], "heuristic"
    variants = parse_variants(reply.text, limit=n)
    if not variants:
        return [expand_abbreviations(question)], "heuristic"
    return variants, "llm"


def multi_query_search(searcher, queries: list[str], *, k: int = 20, mode: str = "dense",
                       candidates: int = 20, rrf_k: int = 60) -> list[dict]:
    """Поиск по каждому варианту запроса и слияние результатов через RRF.

    У слияния один подвох: `score` после него — это RRF (≈1/(60+ранг)), а не
    косинус. Поэтому `dense_score` каждого фрагмента берётся из лучшего варианта,
    где он нашёлся: по нему потом работает порог отсечения.
    """
    if not queries:
        return []
    rank_lists: list[list[tuple[str, float]]] = []
    pool: dict[str, dict] = {}
    found_by: dict[str, list[int]] = {}
    for number, query in enumerate(queries):
        hits = searcher.search(query, k=k, mode=mode, candidates=candidates)
        rank_lists.append([(hit["chunk_id"], hit["score"]) for hit in hits])
        for hit in hits:
            cid = hit["chunk_id"]
            found_by.setdefault(cid, []).append(number)
            previous = pool.get(cid)
            if previous is None or (hit.get("dense_score") or 0) > (previous.get("dense_score") or 0):
                pool[cid] = hit

    fused = rrf(rank_lists, k=rrf_k)
    out: list[dict] = []
    for rank, (cid, score) in enumerate(fused, start=1):
        hit = dict(pool[cid])
        hit["rank"] = rank
        hit["score"] = round(score, 5)
        hit["found_by"] = found_by.get(cid, [])
        hit["found_count"] = len(hit["found_by"])
        out.append(hit)
    return out
