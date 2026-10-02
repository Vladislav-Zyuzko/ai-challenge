"""CLI пайплайна индексации документов.

    python -m doc_index index --strategy fixed,structural,structural_nobc
    python -m doc_index search "чем агент отличается от модели"
    python -m doc_index evaluate
    python -m doc_index stats
"""
from __future__ import annotations

import argparse
import json
import textwrap
from pathlib import Path

from .agent import HarnessAgent
from .compare import load_control, run_control, summarize, write_report
from .llm import LlmClient
from . import store
from .chunk import build_chunks, chunk_stats
from .collect import collect
from .config import DEFAULT_OUT, DEFAULT_VAULT, Config
from .embed import OllamaEmbedder
from .evaluate import evaluate, load_questions, source_skew, write_report as write_eval_report
from .indexer import build_index
from .pipelines import (PIPELINES, Filters, run_pipelines, summarize_pipelines,
                        write_report as write_pipeline_report)
from .rag import answer_question
from .rerank import DEFAULT_MODEL_DIR as DEFAULT_RERANKER_DIR
from .rerank import CrossEncoder, CrossEncoderUnavailable
from .search import Searcher, snippet
from .sweep import pick_best, sweep, write_report as write_sweep_report

DEFAULT_STRATEGIES = "fixed,structural"
ALL_STRATEGIES = "fixed,structural,structural_nobc"


def _items(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def _config(args: argparse.Namespace) -> Config:
    base = Config()
    return Config(
        vault=Path(args.vault).expanduser(),
        out=Path(args.out).expanduser(),
        model=args.model,
        fixed_size=args.fixed_size,
        fixed_overlap=args.fixed_overlap,
        structural_max=args.structural_max,
        structural_min=args.structural_min,
        batch_size=args.batch_size,
    )


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--vault", default=str(DEFAULT_VAULT), help="каталог корпуса (хранилище Obsidian)")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="каталог артефактов индекса")
    parser.add_argument("--model", default=Config().model, help="модель эмбеддингов в Ollama")
    parser.add_argument("--batch-size", type=int, default=Config().batch_size)
    parser.add_argument("--fixed-size", type=int, default=Config().fixed_size)
    parser.add_argument("--fixed-overlap", type=int, default=Config().fixed_overlap)
    parser.add_argument("--structural-max", type=int, default=Config().structural_max)
    parser.add_argument("--structural-min", type=int, default=Config().structural_min)


def cmd_index(args: argparse.Namespace) -> int:
    cfg = _config(args)
    reports = build_index(cfg, _items(args.strategy), rebuild_cache=args.rebuild_cache)
    if not reports:
        print("ничего не проиндексировано")
        return 1
    out = cfg.ensure_out()
    print(f"\nиндекс: {out / 'index.db'}")
    for report in reports:
        print(f"  {report.strategy}: {report.faiss_path}")
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    cfg = _config(args)
    conn = store.connect(cfg.db_path())
    embedder = OllamaEmbedder(cfg)
    searcher = Searcher(conn, cfg, embedder, args.strategy)
    hits = searcher.search(args.query, k=args.k, mode=args.mode, candidates=args.candidates)
    if not hits:
        print("ничего не найдено")
        return 1
    print(f"запрос: {args.query}")
    print(f"стратегия: {args.strategy} · поиск: {args.mode} · найдено: {len(hits)}\n")
    for hit in hits:
        print(f"{hit['rank']}. {hit['source']} — {hit['section'] or hit['title']}")
        print(f"   строки {hit['start_line']}–{hit['end_line']} · {hit['n_chars']} символов · "
              f"score {hit['score']} · dense #{hit['dense_rank'] or '—'} · bm25 #{hit['lexical_rank'] or '—'}")
        print(f"   {snippet(hit['text'], args.query, args.width)}")
        if args.full:
            print(textwrap.indent(hit["text"], "      "))
        print()
    return 0


def cmd_evaluate(args: argparse.Namespace) -> int:
    cfg = _config(args)
    conn = store.connect(cfg.db_path())
    embedder = OllamaEmbedder(cfg)
    strategies = _items(args.strategies)
    modes = _items(args.modes)
    questions = load_questions(Path(args.questions))
    print(f"оцениваю: {len(questions)} вопросов × {len(strategies)} стратегий × {len(modes)} режимов поиска")
    evaluation = evaluate(conn, cfg, embedder, questions, strategies=strategies, modes=modes, k=args.k)

    from .indexer import IndexReport  # только для аннотации

    stats = {s: store.chunk_stats_from_db(conn, s) for s in strategies}
    notes, _skipped = collect(cfg)
    folders: list[str] = []
    for note in notes:
        if note.folder_label and note.folder_label not in folders:
            folders.append(note.folder_label)
    corpus = {
        "notes": len(notes),
        "chars": sum(len(n.text) for n in notes),
        "pages": round(sum(len(n.text) for n in notes) / 1800),
        "folders": folders,
    }
    path = write_eval_report(evaluation, cfg.out, chunk_stats_by_strategy=stats, corpus=corpus,
                             skew=source_skew(evaluation, "99_Приложения"))
    print(f"\nотчёт: {path}")
    for res in sorted(evaluation["results"].values(), key=lambda r: -r["mrr"]):
        print(f"  {res['strategy']:<18} {res['mode']:<8} recall@1 {res['recall@1']:.2f} · "
              f"recall@5 {res['recall@5']:.2f} · MRR {res['mrr']:.3f}")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    cfg = _config(args)
    notes, skipped = collect(cfg)
    chars = sum(len(note.text) for note in notes)
    print(f"корпус: {cfg.vault}")
    print(f"  заметок: {len(notes)} · символов: {chars} · ≈{round(chars / 1800)} страниц · "
          f"пропущено: {len(skipped)}")
    by_folder: dict[str, int] = {}
    for note in notes:
        by_folder[note.folder_label] = by_folder.get(note.folder_label, 0) + 1
    for folder, count in sorted(by_folder.items(), key=lambda x: -x[1]):
        print(f"    {folder}: {count}")
    print()
    for strategy in _items(args.strategies):
        chunks = build_chunks(notes, cfg, strategy)
        stats = chunk_stats(chunks)
        print(f"[{strategy}] " + json.dumps(stats, ensure_ascii=False))
    print()
    if cfg.db_path().exists():
        conn = store.connect(cfg.db_path())
        print("индекс:", json.dumps(store.index_stats(conn), ensure_ascii=False))
    else:
        print(f"индекса ещё нет: {cfg.db_path()}")
    return 0


def _answerer(args: argparse.Namespace):
    """Кто отвечает: чистый клиент модели или агент харнесса.

    По умолчанию чистый клиент: у агента харнесса есть инструменты, и он может
    выйти за пределы переданного контекста, тогда как для сравнения режимов
    нужен ровно один источник знаний — блок контекста.
    """
    if args.backend == "harness":
        return HarnessAgent(model=args.llm_model, cwd=Path(args.out).expanduser())
    return LlmClient(model=args.llm_model)


def cmd_ask(args: argparse.Namespace) -> int:
    """Один вопрос в двух режимах: с найденным контекстом и без него."""
    cfg = _config(args)
    conn = store.connect(cfg.db_path())
    hits: list[dict] = []
    if args.mode in ("rag", "both"):
        searcher = Searcher(conn, cfg, OllamaEmbedder(cfg), args.strategy)
        hits = searcher.search(args.question, k=args.k, mode=args.search_mode)
        if not hits:
            print("поиск ничего не нашёл — RAG-режим пойдёт без контекста")
        elif args.expand:
            hits = hits + searcher.neighbours(hits, args.expand)
    modes = ["rag", "no-rag"] if args.mode == "both" else [args.mode]
    with _answerer(args) as agent:
        for mode in modes:
            answer = answer_question(agent, args.question, question_id="ask", mode=mode,
                                     hits=hits if mode == "rag" else None, max_chars=args.max_chars)
            title = "С RAG" if mode == "rag" else "БЕЗ RAG"
            print(f"\n=== {title} · {answer.seconds:.1f} с · промпт {len(answer.prompt)} символов ===")
            print(answer.answer or "(пустой ответ)")
            if mode == "rag" and hits:
                print("\nисточники:")
                for hit in hits:
                    print(f"  [{hit['rank']}] {hit['source']} · {hit['breadcrumb'] or hit['section']} "
                          f"(строки {hit['start_line']}–{hit['end_line']})")
    return 0


def cmd_control(args: argparse.Namespace) -> int:
    """Прогон контрольного набора в обоих режимах со сравнением качества."""
    cfg = _config(args)
    cfg.ensure_out()
    conn = store.connect(cfg.db_path())
    questions = load_control(Path(args.questions))
    searcher = Searcher(conn, cfg, OllamaEmbedder(cfg), args.strategy)
    judge = not args.no_judge
    print(f"контрольный набор: {len(questions)} вопросов × 2 режима"
          + (" + слепое судейство" if judge else " (без судейства)"))
    with _answerer(args) as agent:
        result = run_control(questions, searcher, agent, k=args.k, max_chars=args.max_chars,
                             judge=judge, search_mode=args.search_mode, expand=args.expand)
        path = write_report(result, cfg.out, model=agent.model)
    summary = summarize(result)
    print(f"\nотчёт: {path}")
    for mode, title in (("rag", "с RAG"), ("no-rag", "без RAG")):
        part = summary[mode]
        print(f"  {title:<8} факты {part['facts_covered']}/{part['facts_total']} "
              f"({part['facts_share']:.2f}) · средняя оценка {part['judge_mean']} · "
              f"ответ {part['chars_avg']} символов за {part['seconds_avg']} с")
    print(f"  источник найден в топ-{args.k}: {summary['retrieval_hits']} из {summary['retrieval_total']}")
    return 0


def _reranker(dir_path: str) -> tuple[CrossEncoder | None, str]:
    """Загрузить cross-encoder; если модели нет — не падать, а сказать об этом."""
    try:
        encoder = CrossEncoder(dir_path)
        return encoder, Path(dir_path).name
    except CrossEncoderUnavailable as exc:
        print(f"cross-encoder недоступен: {exc}")
        return None, ""


def cmd_fetch_reranker(args: argparse.Namespace) -> int:
    """Скачать ONNX-веса реранкера (567 МБ, один раз)."""
    from .rerank import download_model

    print(f"загрузка bge-reranker-v2-m3 (INT8/AVX2) в {args.reranker_dir}")
    download_model(args.reranker_dir)
    return 0


def cmd_sweep(args: argparse.Namespace) -> int:
    """Свип порогов отсечения на размеченном наборе вопросов."""
    cfg = _config(args)
    cfg.ensure_out()
    conn = store.connect(cfg.db_path())
    questions = load_questions(Path(args.questions))
    searcher = Searcher(conn, cfg, OllamaEmbedder(cfg), args.strategy)
    encoder, _name = (None, "") if args.no_cross else _reranker(args.reranker_dir)

    print(f"свип порогов: {len(questions)} вопросов, кандидатов {args.candidates} → {args.k}")
    result = sweep(searcher, questions, encoder=encoder, cfg=cfg,
                   candidates=args.candidates, k=args.k, mode=args.search_mode)
    path = write_sweep_report(result, cfg.out)
    best = pick_best(result)
    print(f"\nотчёт: {path}")
    print(f"  лучшая конфигурация: {best['family']} = {best['value']} · "
          f"precision {best['precision']:.3f} · recall@5 {best['recall@5']:.2f} · "
          f"фрагментов {best['kept_avg']:.2f}")
    return 0


def cmd_compare(args: argparse.Namespace) -> int:
    """Сравнить пайплайны: без фильтра, порог, эвристика, cross-encoder, rewrite+фильтр."""
    cfg = _config(args)
    cfg.ensure_out()
    conn = store.connect(cfg.db_path())
    questions = load_control(Path(args.questions))
    pipelines = tuple(_items(args.pipelines))
    unknown = [name for name in pipelines if name not in PIPELINES]
    if unknown:
        raise SystemExit(f"неизвестные пайплайны: {', '.join(unknown)} (есть: {', '.join(PIPELINES)})")

    filters = Filters(candidates=args.candidates, k=args.k, expand=args.expand,
                      search_mode=args.search_mode, margin=args.margin,
                      min_dense=args.min_dense, min_score=args.min_score,
                      min_keep=args.min_keep)
    searcher = Searcher(conn, cfg, OllamaEmbedder(cfg), args.strategy)
    encoder, encoder_name = (None, "")
    if "cross" in pipelines or "full" in pipelines:
        encoder, encoder_name = _reranker(args.reranker_dir)

    judge = not args.no_judge
    print(f"пайплайны: {', '.join(pipelines)} · вопросов {len(questions)} · "
          f"кандидатов {filters.candidates} → {filters.k}"
          + (" + слепое судейство" if judge else " (без судейства)"))
    with _answerer(args) as agent:
        result = run_pipelines(questions, searcher, agent, pipelines=pipelines, filters=filters,
                               judge=judge, max_chars=args.max_chars, encoder=encoder)
        path = write_pipeline_report(
            result, cfg.out, model=agent.model, encoder_name=encoder_name,
            notes=[f"Порог выбран свипом: `python -m doc_index sweep` (см. `out/sweep.md`).",
                   f"Маржа от top-1: {filters.margin}, порог оценки: {filters.min_score}, "
                   f"абсолютный порог косинуса: {filters.min_dense}."],
        )

    summary = summarize_pipelines(result)
    print(f"\nотчёт: {path}")
    for name in pipelines:
        part = summary[name]
        judge_text = "—" if part["judge_mean"] is None else part["judge_mean"]
        precision_text = "—" if part["precision"] is None else f"{part['precision']:.2f}"
        print(f"  {name:<10} факты {part['facts_covered']}/{part['facts_total']} "
              f"({part['facts_share']:.2f}) · судья {judge_text} · precision {precision_text} · "
              f"фрагментов {part['kept_avg']} · токенов промпта {part['prompt_tokens']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="doc_index", description="Индексация документов: чанкинг, эмбеддинги, поиск")
    sub = parser.add_subparsers(dest="command", required=True)

    p_index = sub.add_parser("index", help="собрать индекс")
    _add_common(p_index)
    p_index.add_argument("--strategy", default=DEFAULT_STRATEGIES,
                         help=f"через запятую ({ALL_STRATEGIES})")
    p_index.add_argument("--rebuild-cache", action="store_true", help="сбросить кэш эмбеддингов")
    p_index.set_defaults(func=cmd_index)

    p_search = sub.add_parser("search", help="поиск по индексу")
    _add_common(p_search)
    p_search.add_argument("query")
    p_search.add_argument("--strategy", default="structural")
    p_search.add_argument("--mode", default="hybrid", choices=["hybrid", "dense", "lexical"])
    p_search.add_argument("--k", type=int, default=5)
    p_search.add_argument("--candidates", type=int, default=20)
    p_search.add_argument("--width", type=int, default=200, help="длина фрагмента в выводе")
    p_search.add_argument("--full", action="store_true", help="печатать текст чанка целиком")
    p_search.set_defaults(func=cmd_search)

    p_eval = sub.add_parser("evaluate", help="сравнить стратегии на наборе вопросов")
    _add_common(p_eval)
    p_eval.add_argument("--questions", default=str(Path(__file__).resolve().parent.parent / "data" / "questions.yaml"))
    p_eval.add_argument("--strategies", default=DEFAULT_STRATEGIES)
    p_eval.add_argument("--modes", default="dense,hybrid")
    p_eval.add_argument("--k", type=int, default=10)
    p_eval.set_defaults(func=cmd_evaluate)

    p_stats = sub.add_parser("stats", help="статистика корпуса и чанков")
    _add_common(p_stats)
    p_stats.add_argument("--strategies", default=ALL_STRATEGIES)
    p_stats.set_defaults(func=cmd_stats)

    def add_rag_flags(parser: argparse.ArgumentParser) -> None:
        parser.add_argument("--strategy", default="structural", help="стратегия чанкинга для поиска")
        parser.add_argument("--search-mode", default="dense", choices=["dense", "hybrid", "lexical"],
                            help="канал поиска: по дню 21 векторный точнее гибрида")
        parser.add_argument("--k", type=int, default=5, help="сколько фрагментов подать в контекст")
        parser.add_argument("--max-chars", type=int, default=6000, help="бюджет контекста в символах")
        parser.add_argument("--llm-model", default="deepseek-v4-flash", help="модель агента")
        parser.add_argument("--expand", type=int, default=0,
                            help="добавить в контекст N соседних чанков каждой найденной заметки")
        parser.add_argument("--backend", default="api", choices=["api", "harness"],
                            help="api — чистый вызов модели (по умолчанию); harness — агент с инструментами, "
                                 "он умеет читать файлы и может подглядеть в корпус или в эталоны")

    p_ask = sub.add_parser("ask", help="спросить базу: с RAG и без RAG")
    _add_common(p_ask)
    add_rag_flags(p_ask)
    p_ask.add_argument("question")
    p_ask.add_argument("--mode", default="both", choices=["both", "rag", "no-rag"])
    p_ask.set_defaults(func=cmd_ask)

    p_control = sub.add_parser("control", help="контрольный набор: сравнение качества с RAG и без")
    _add_common(p_control)
    add_rag_flags(p_control)
    p_control.add_argument("--questions",
                           default=str(Path(__file__).resolve().parent.parent / "data" / "control-questions.yaml"))
    p_control.add_argument("--no-judge", action="store_true", help="без слепого судейства моделью")
    p_control.set_defaults(func=cmd_control)

    p_fetch = sub.add_parser("fetch-reranker", help="скачать ONNX-веса реранкера (567 МБ)")
    p_fetch.add_argument("--reranker-dir", default=str(DEFAULT_RERANKER_DIR))
    p_fetch.set_defaults(func=cmd_fetch_reranker)

    p_sweep = sub.add_parser("sweep", help="настроить порог отсечения на размеченном наборе")
    _add_common(p_sweep)
    p_sweep.add_argument("--strategy", default="structural")
    p_sweep.add_argument("--questions",
                         default=str(Path(__file__).resolve().parent.parent / "data" / "questions.yaml"))
    p_sweep.add_argument("--candidates", type=int, default=20, help="топ-K до фильтрации")
    p_sweep.add_argument("--k", type=int, default=5, help="топ-K после фильтрации")
    p_sweep.add_argument("--search-mode", default="dense", choices=["dense", "hybrid", "lexical"])
    p_sweep.add_argument("--no-cross", action="store_true", help="без cross-encoder (быстро)")
    p_sweep.add_argument("--reranker-dir", default=str(DEFAULT_RERANKER_DIR))
    p_sweep.set_defaults(func=cmd_sweep)

    p_compare = sub.add_parser("compare", help="сравнить пайплайны: фильтр, реранкинг, rewrite")
    _add_common(p_compare)
    add_rag_flags(p_compare)
    p_compare.add_argument("--questions",
                           default=str(Path(__file__).resolve().parent.parent / "data" / "control-questions.yaml"))
    p_compare.add_argument("--pipelines", default=",".join(PIPELINES),
                           help=f"через запятую из {', '.join(PIPELINES)}")
    p_compare.add_argument("--candidates", type=int, default=20, help="топ-K до фильтрации")
    p_compare.add_argument("--margin", type=float, default=0.08,
                           help="относительный порог: маржа от лучшего результата")
    p_compare.add_argument("--min-dense", type=float, default=None,
                           help="абсолютный порог по косинусу")
    p_compare.add_argument("--min-score", type=float, default=0.2,
                           help="порог оценки для heuristic и cross-encoder")
    p_compare.add_argument("--min-keep", type=int, default=1,
                           help="сколько фрагментов оставить даже ниже порога: "
                                "страховка от ошибки в топ-1")
    p_compare.add_argument("--reranker-dir", default=str(DEFAULT_RERANKER_DIR))
    p_compare.add_argument("--no-judge", action="store_true", help="без слепого судейства моделью")
    p_compare.set_defaults(func=cmd_compare)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
