"""MCP-сервер вокруг локального индекса: агент ищет по базе знаний инструментом.

Зачем. В RAG-режиме (день 22) база подкладывается в промпт заранее, и агент видит
готовые фрагменты. Здесь другой режим: база становится **инструментом сессии**, и
агент сам решает, когда её спросить, — как он делает с MCP-серверами задач или Figma.

Запускается харнессом по stdio, когда dsh-term стартует с `--rag <имя>`: мост
`@deepseek-ai/dsh-mcp-client` поднимает этот процесс и регистрирует инструменты.

    python -m doc_index.mcp_server --base effective-ai=C:\\path\\to\\doc-index --margin 0.04

Поиск идёт тем же путём, что в днях 21–23: dense по FAISS → фильтр по марже от
лучшего результата → фрагменты с источником и строками. Никакой второй логики
поиска здесь нет — модуль только оборачивает её в MCP.

Поток stdout занят протоколом, поэтому все сообщения уходят в stderr.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .config import Config
from .embed import OllamaEmbedder
from .rerank import threshold_filter
from .rewrite import expand_abbreviations, multi_query_search
from .search import Searcher
from . import store

DEFAULT_K = 5
DEFAULT_CANDIDATES = 20
DEFAULT_MARGIN = 0.04
DEFAULT_MIN_KEEP = 2
DEFAULT_STRATEGY = "structural"
# Абсолютный пол применимости базы. Относительная маржа фильтрует только *среди*
# результатов, поэтому на вопрос вне корпуса она честно вернёт «лучшее из плохого».
# Замеры (запросы по теме против вопросов вне корпуса): после раскрытия аббревиатур
# у «своих» вопросов top-1 начинается с 0.55, у чужих не поднимается выше 0.45 —
# пол ставим в этот разрыв, а не вплотную к «своим».
DEFAULT_MIN_DENSE = 0.50


def parse_base(value: str) -> tuple[str, Path]:
    """Разобрать `имя=путь` в аргументе `--base`."""
    name, _, path = value.partition("=")
    name, path = name.strip(), path.strip()
    if not name or not path:
        raise argparse.ArgumentTypeError(f"ожидается имя=путь, получено: {value!r}")
    root = Path(path).expanduser()
    if not root.is_dir():
        raise argparse.ArgumentTypeError(f"каталог не найден: {root}")
    return name, root


@dataclass
class SearchOutcome:
    """Результат поиска: фрагменты и причина, если база не ответила."""

    hits: list[dict] = field(default_factory=list)
    best_score: float | None = None
    below_floor: bool = False
    queries: list[str] = field(default_factory=list)


@dataclass
class KnowledgeBase:
    """Одна база знаний: каталог doc-index со своим индексом и настройками поиска."""

    name: str
    root: Path
    title: str = ""
    what: str = ""
    strategy: str = DEFAULT_STRATEGY
    margin: float | None = DEFAULT_MARGIN
    min_keep: int = DEFAULT_MIN_KEEP
    min_dense: float | None = DEFAULT_MIN_DENSE
    candidates: int = DEFAULT_CANDIDATES
    expand: bool = True
    _searcher: Searcher | None = field(default=None, repr=False)
    _conn: object = field(default=None, repr=False)

    def config(self) -> Config:
        return Config(out=self.root / "out")

    @property
    def search_ready(self) -> bool:
        return (self.config().db_path()).exists()

    def searcher(self) -> Searcher:
        """Поиск по базе. Индекс и модель поднимаются при первом обращении."""
        if self._searcher is None:
            cfg = self.config()
            self._conn = store.connect(cfg.db_path())
            self._searcher = Searcher(self._conn, cfg, OllamaEmbedder(cfg), self.strategy)
        return self._searcher

    def search(self, query: str, *, k: int = DEFAULT_K, mode: str = "dense") -> SearchOutcome:
        """Фрагменты по запросу: раскрытие → поиск → пол применимости → маржа → топ-k.

        Запрос ищется в двух вариантах — исходном и с раскрытыми аббревиатурами
        («ЗУН» → «знания умения навыки»), результаты сливаются через RRF. Исходный
        вариант идёт первым: раскрытие помогает не всегда, и терять то, что и так
        находилось, незачем.
        """
        variants = [query]
        if self.expand:
            expanded = expand_abbreviations(query)
            if expanded.strip() != query.strip():
                variants.append(expanded)
        if len(variants) > 1:
            hits = multi_query_search(self.searcher(), variants, k=self.candidates, mode=mode,
                                      candidates=self.candidates)
        else:
            hits = self.searcher().search(query, k=self.candidates, mode=mode,
                                          candidates=self.candidates)
        if not hits:
            return SearchOutcome(queries=variants)
        # Пол применимости проверяем по лучшей оценке среди кандидатов: после слияния
        # порядок задаёт RRF, и первый фрагмент не обязан быть самым близким по вектору.
        scores = [float(h["dense_score"]) for h in hits
                  if isinstance(h.get("dense_score"), (int, float))]
        best_score = max(scores) if scores else None
        if self.min_dense is not None and best_score is not None and best_score < self.min_dense:
            return SearchOutcome(best_score=best_score, below_floor=True, queries=variants)
        if self.margin is not None:
            hits = threshold_filter(hits, margin=self.margin, min_keep=self.min_keep)
        return SearchOutcome(hits=hits[:k], best_score=best_score, queries=variants)

    def describe(self) -> str:
        chunks = "—"
        try:
            stats = store.chunk_stats_from_db(self._connection(), self.strategy)
            chunks = str(stats.get("chunks", "—"))
        except Exception:  # база ещё не построена — это не ошибка инструмента
            pass
        title = self.title or self.name
        return f"{self.name} — {title}" + (f" · {self.what}" if self.what else "") + f" · чанков: {chunks}"

    def _connection(self):
        if self._conn is None:
            self._conn = store.connect(self.config().db_path())
        return self._conn


def format_hits(base: KnowledgeBase, query: str, outcome: SearchOutcome) -> str:
    """Текст для агента: источники, строки и сами фрагменты."""
    if outcome.below_floor:
        return (f"База «{base.name}»: ответа нет. Лучшее совпадение по запросу «{query}» "
                f"имеет косинус {outcome.best_score:.3f} — ниже порога применимости "
                f"{base.min_dense:.2f}, значит темы в базе нет. Скажи об этом прямо "
                f"и не выдумывай ответ.")
    hits = outcome.hits
    if not hits:
        return (f"База «{base.name}»: по запросу «{query}» ничего не найдено. "
                f"Скажи об этом прямо, не выдумывай ответ.")
    queries = outcome.queries or [query]
    header = f"База «{base.name}» · запрос: {queries[0]}"
    if len(queries) > 1:
        header += f" (+ раскрытие аббревиатур: {queries[1]})"
    lines = [f"{header} · фрагментов: {len(hits)}", ""]
    for number, hit in enumerate(hits, start=1):
        section = hit.get("breadcrumb") or hit.get("section") or hit.get("title") or ""
        score = hit.get("dense_score")
        score_text = f" · косинус {score:.3f}" if isinstance(score, (int, float)) else ""
        lines.append(f"[{number}] {hit['source']}"
                     + (f" · {section}" if section else "")
                     + f" (строки {hit['start_line']}–{hit['end_line']}{score_text})")
        lines.append((hit.get("text") or "").strip())
        lines.append("")
    lines.append("Ссылайся на заметку и строки из выдачи. Если в базе нет ответа — скажи прямо.")
    return "\n".join(lines)


def build_server(bases: list[KnowledgeBase], *, default_k: int = DEFAULT_K):
    """MCP-сервер с инструментами поиска. Импорт SDK внутри: модуль не обязателен."""
    from mcp.server.mcpserver import MCPServer

    server = MCPServer(
        name="rag",
        title="RAG: локальные базы знаний",
        instructions="Поиск по проиндексированным базам знаний с указанием источников.",
    )
    by_name = {base.name: base for base in bases}
    listing = "; ".join(base.name for base in bases) or "нет баз"

    @server.tool(description=f"Найти фрагменты в базе знаний. Доступные базы: {listing}")
    def rag_search(query: str, k: int = default_k, base: str | None = None) -> str:
        """Поиск по базе знаний: возвращает фрагменты заметок с источниками и строками."""
        if not bases:
            return "Базы знаний не подключены: сессия запущена без --rag."
        chosen = bases
        if base:
            found = by_name.get(base)
            if found is None:
                return f"Нет базы «{base}». Доступно: {listing}."
            chosen = [found]
        parts: list[str] = []
        for item in chosen:
            if not item.search_ready:
                parts.append(f"База «{item.name}»: индекс не найден в {item.config().db_path()} — "
                             f"соберите его командой `python -m doc_index index`.")
                continue
            try:
                outcome = item.search(query, k=k)
            except Exception as exc:  # сеть/Ollama/индекс — агент должен увидеть причину
                parts.append(f"База «{item.name}»: поиск не удался ({exc}).")
                continue
            parts.append(format_hits(item, query, outcome))
        return "\n\n".join(parts)

    @server.tool(description="Список подключённых баз знаний и их размер")
    def rag_bases() -> str:
        """Какие базы доступны в этой сессии."""
        if not bases:
            return "Базы знаний не подключены: сессия запущена без --rag."
        return "\n".join(f"- {base.describe()}" for base in bases)

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="doc_index.mcp_server",
                                     description="MCP-сервер поиска по базам знаний")
    parser.add_argument("--base", action="append", default=[], type=parse_base,
                        metavar="ИМЯ=ПУТЬ", help="каталог doc-index (повторяемый)")
    parser.add_argument("--title", action="append", default=[],
                        help="название базы в формате имя=заголовок (необязательно)")
    parser.add_argument("--what", action="append", default=[],
                        help="краткое описание базы в формате имя=описание (необязательно)")
    parser.add_argument("--strategy", default=DEFAULT_STRATEGY, help="стратегия чанкинга")
    parser.add_argument("--margin", type=float, default=DEFAULT_MARGIN,
                        help="маржа от лучшего результата (0 — без фильтра)")
    parser.add_argument("--min-dense", type=float, default=DEFAULT_MIN_DENSE,
                        help="пол применимости: ниже него база считается не отвечающей")
    parser.add_argument("--min-keep", type=int, default=DEFAULT_MIN_KEEP,
                        help="сколько фрагментов оставить даже ниже порога")
    parser.add_argument("--no-expand", action="store_true",
                        help="не раскрывать аббревиатуры словарём перед поиском")
    parser.add_argument("--candidates", type=int, default=DEFAULT_CANDIDATES,
                        help="сколько кандидатов брать до фильтрации")
    args = parser.parse_args(argv)

    def pairs(values: list[str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for value in values:
            name, _, text = value.partition("=")
            if name.strip():
                out[name.strip()] = text.strip()
        return out

    titles, whats = pairs(args.title), pairs(args.what)
    bases = [
        KnowledgeBase(name=name, root=root, title=titles.get(name, ""), what=whats.get(name, ""),
                      strategy=args.strategy, margin=args.margin or None,
                      min_dense=args.min_dense or None, expand=not args.no_expand,
                      min_keep=args.min_keep, candidates=args.candidates)
        for name, root in args.base
    ]
    if not bases:
        print("не задано ни одной базы: нужен хотя бы один --base имя=путь", file=sys.stderr)
        return 2
    print(f"rag: базы {', '.join(b.name for b in bases)} · стратегия {args.strategy} · "
          f"маржа {args.margin} · пол {args.min_dense} · "
          f"раскрытие {'выкл' if args.no_expand else 'вкл'}", file=sys.stderr, flush=True)
    build_server(bases).run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
