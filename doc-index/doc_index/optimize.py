"""День 29: оптимизация локальной модели под конкретную задачу — строгую справку по базе.

Задача зафиксирована днём 26: локальная модель отвечает по найденным фрагментам так,
чтобы ответ можно было **проверить машинно** — формат «ОТВЕТ / ИСТОЧНИКИ / ЦИТАТЫ»,
источники только из выданных фрагментов, цитаты дословные, на неотвечаемый вопрос —
«не знаю». Здесь три рычага из задания сравниваются по одному, а не все сразу:

1. **параметры** (`temperature`, `top_p`, `num_ctx`, `num_predict`) — `qwen3:8b` + опции;
2. **prompt-шаблон под кейс** — контракт переезжает из каждого запроса в системный
   промпт модели (`Modelfile`), а в запрос уходит только «фрагменты + вопрос»;
3. **квантование** — те же параметры и шаблон, но веса Q8_0 вместо Q4_K_M.

Каждый шаг меняет ровно одно по отношению к предыдущему, поэтому разницу видно
и можно объяснить. Качество считается кодом, а не «на глаз»: разбор ответа тем же
парсером, что и в дне 24 (`parse_answer`), проверка цитат (`check_citations`)
и покрытие проверяемых фактов (`check_facts`) из контрольного набора.

Ожидание «перенос контракта в SYSTEM укоротит промпт и ускорит обработку» замер
**не подтвердил**: контракт остаётся частью запроса к модели, просто на стороне
системного сообщения, и токенов промпта столько же. Что действительно меняется —
сколько модель генерирует и насколько точно держит форму (см. отчёт дня 29).

Почему качество меряется без судьи-модели: судья — это ещё один вызов той же
медленной локальной модели на CPU, он умножил бы время прогона на два и добавил бы
шум. Формат, реальность источников, дословность цитат и наличие фактов проверяются
детерминированно; этого достаточно, чтобы увидеть деградацию от квантования.

Запуск:

    python -m doc_index.optimize --modelfiles          # показать Modelfile моделей
    python -m doc_index.optimize --only baseline,params
    python -m doc_index.optimize --json out/optimize.json
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import requests

from .citations import ParsedAnswer, QuoteCheck, check_citations, parse_answer
from .compare import check_facts, load_control
from .config import Config
from .embed import OllamaEmbedder
from .pipelines import Filters, Retrieved, retrieve
from .rag import CONTEXT_HEADER, build_context
from .search import Searcher
from . import store

DEFAULT_URL = "http://127.0.0.1:11434"
DEFAULT_TIMEOUT = 900.0
BASE_MODEL = "qwen3:8b"
BASE_MODEL_Q8 = "qwen3:8b-q8_0"
OPTIMIZED_MODEL = "rag-brief:8b"
OPTIMIZED_MODEL_Q8 = "rag-brief-q8:8b"

# Вопросы: три с ответом в базе (разные типы знания) и один без ответа — на нём
# проверяется поведение «не знаю», которое в оптимизированных конфигурациях
# приходится обеспечивать самой моделью: гейт по порогу здесь намеренно выключен,
# иначе отказ выдал бы код, и сравнение качества ничего бы не показало.
DEFAULT_QUESTION_IDS = ("c01", "c04", "c11", "r01")

# Контракт задачи. Он же уезжает в SYSTEM модели: в этом и смысл шага «шаблон».
# Формулировка — та же, что в дне 24 (`rag.STRICT_RULES`), плюс один абзац про роль,
# который в обычном промпте был не нужен, а в системном читается естественнее.
RAG_SYSTEM = (
    "Ты — справка по внутренней базе знаний. Отвечай только по фрагментам, которые "
    "приходят в запросе, и не используй собственные знания о теме.\n"
    "\n"
    "Формат ответа строго такой, без пояснений вокруг:\n"
    "ОТВЕТ: <2–5 предложений по существу>\n"
    "ИСТОЧНИКИ:\n"
    "- [1] <chunk_id> · <заметка> · <раздел>\n"
    "ЦИТАТЫ:\n"
    "- [1] «<дословный фрагмент из источника 1>»\n"
    "\n"
    "Правила: нумеруй источники и цитаты согласованно; каждая цитата — точная копия "
    "текста из фрагмента с тем же номером, без пересказа и без правок; не выдумывай "
    "источники, которых нет среди фрагментов; если во фрагментах нет ответа — напиши "
    "«Не знаю», объясни, чего не хватает, и попроси уточнить вопрос."
)

# Опции генерации для оптимизированных профилей. Смысл каждого:
#   temperature 0   — у задачи есть правильный ответ, случайность только вредит
#                     (базовая модель отвечает при 0.6 — это её заводская настройка);
#   top_p 1.0       — с temperature 0 отбор всё равно детерминированный, но пусть
#                     будет видно, что «хвост» не отрезается вторым параметром;
#   num_ctx 8192    — у qwen3 в Ollama по умолчанию 4096, а промпт справки больше:
#                     без явного значения контекст обрезался бы молча;
#   num_predict 400 — ответ по контракту — это 200–400 токенов; ограничение сверху
#                     не даёт модели «уехать» в рассуждения на минуты CPU-времени.
OPTIMIZED_OPTIONS: dict = {
    "temperature": 0.0,
    "top_p": 1.0,
    "num_ctx": 8192,
    "num_predict": 400,
}


@dataclass
class Profile:
    """Одна конфигурация: модель, её опции и то, откуда берётся контракт."""

    id: str
    title: str
    model: str
    options: dict = field(default_factory=dict)
    prompt: str = "full"          # full — контракт в запросе, compact — контракт в модели
    note: str = ""


PROFILES: tuple[Profile, ...] = (
    Profile(
        id="baseline",
        title="до оптимизации",
        model=BASE_MODEL,
        options={},
        prompt="full",
        note="заводские параметры Ollama (temperature 0.6, top_k 20, top_p 0.95), "
             "контракт задачи целиком в запросе — так работал день 26",
    ),
    Profile(
        id="params",
        title="+ параметры",
        model=BASE_MODEL,
        options=dict(OPTIMIZED_OPTIONS),
        prompt="full",
        note="те же веса и тот же промпт, но temperature 0, num_ctx 8192, num_predict 400",
    ),
    Profile(
        id="template",
        title="+ шаблон под кейс",
        model=OPTIMIZED_MODEL,
        options=dict(OPTIMIZED_OPTIONS),
        prompt="compact",
        note="контракт перенесён в SYSTEM модели, в запросе остаются только фрагменты "
             "и вопрос: токенов промпта столько же, но модель точнее держит форму "
             "и отвечает короче",
    ),
    Profile(
        id="quant",
        title="+ квантование Q8_0",
        model=OPTIMIZED_MODEL_Q8,
        options=dict(OPTIMIZED_OPTIONS),
        prompt="compact",
        note="те же параметры и шаблон, но веса Q8_0 (8.7 ГБ) вместо Q4_K_M (5.2 ГБ)",
    ),
)


def modelfile(base_model: str, *, system: str = RAG_SYSTEM,
              options: dict | None = None) -> str:
    """Modelfile оптимизированной модели: только SYSTEM и PARAMETER.

    Шаблон чата (`TEMPLATE`) не трогаем намеренно: у qwen3 он рабочий и от него
    зависит разметка сообщений ролей и вызов инструментов — правка ради красоты
    сломала бы модель, а не оптимизировала её.

    Многострочное значение оборачивается в тройные кавычки: без них Ollama читает
    только первую строку и падает на следующей («command must be one of …»).
    """
    options = OPTIMIZED_OPTIONS if options is None else options
    value = f'"""{system}"""' if "\n" in system else system
    lines = [f"FROM {base_model}", "", f"SYSTEM {value}", ""]
    for key, item in options.items():
        lines.append(f"PARAMETER {key} {item}")
    lines.append("")
    return "\n".join(lines)


def compact_prompt(question: str, hits: list[dict], *, max_chars: int = 6000) -> str:
    """Запрос для модели, у которой контракт уже в SYSTEM: контекст и вопрос."""
    return "\n".join([
        CONTEXT_HEADER,
        build_context(hits, max_chars, with_ids=True),
        "",
        f"ВОПРОС: {question}",
    ])


def chat_payload(model: str, prompt: str, *, system: str = "", options: dict | None = None,
                 think: bool = False, stream: bool = False) -> dict:
    """Тело запроса к нативному `/api/chat`. Отдельной функцией — чтобы проверялось тестом."""
    messages = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": prompt}
    ]
    payload: dict = {"model": model, "messages": messages, "stream": stream, "think": think}
    if options:
        payload["options"] = options
    return payload


def timings(data: dict) -> dict:
    """Разбор таймингов Ollama: наносекунды → секунды, токены → токены в секунду.

    Разделение обработки промпта и генерации принципиально: на CPU это два разных
    узких места (десятки токенов в секунду против единиц), и оптимизация,
    ускоряющая одно, может не ускорять другое.
    """
    def seconds(key: str) -> float:
        return round(float(data.get(key) or 0) / 1e9, 3)

    prefill_s, gen_s = seconds("prompt_eval_duration"), seconds("eval_duration")
    prompt_tokens = int(data.get("prompt_eval_count") or 0)
    eval_count = int(data.get("eval_count") or 0)
    return {
        "prompt_tokens": prompt_tokens,
        "eval_tokens": eval_count,
        "prefill_seconds": prefill_s,
        "generate_seconds": gen_s,
        "load_seconds": seconds("load_duration"),
        "total_seconds": seconds("total_duration"),
        "prefill_tps": round(prompt_tokens / prefill_s, 1) if prefill_s else 0.0,
        "generate_tps": round(eval_count / gen_s, 1) if gen_s else 0.0,
    }


def ask_local(model: str, prompt: str, *, url: str = DEFAULT_URL, system: str = "",
              options: dict | None = None, think: bool = False,
              timeout: float = DEFAULT_TIMEOUT) -> tuple[str, dict]:
    """Один запрос к Ollama. `think=False` у всех профилей: иначе сравнение мерило бы
    режим рассуждений, а не параметры, шаблон и квантование."""
    started = time.perf_counter()
    response = requests.post(f"{url}/api/chat",
                             json=chat_payload(model, prompt, system=system, options=options,
                                               think=think),
                             timeout=timeout)
    response.raise_for_status()
    data = response.json()
    data["_client_seconds"] = round(time.perf_counter() - started, 2)
    return (data.get("message", {}).get("content") or "").strip(), data


def loaded_models(url: str = DEFAULT_URL, timeout: float = 20.0) -> list[dict]:
    """Что сейчас лежит в оперативной памяти (`/api/ps`): имя и размер."""
    response = requests.get(f"{url}/api/ps", timeout=timeout)
    response.raise_for_status()
    return [
        {"name": item.get("name", ""), "size_gb": round((item.get("size") or 0) / 1024 ** 3, 2),
         "vram_gb": round((item.get("size_vram") or 0) / 1024 ** 3, 2)}
        for item in response.json().get("models", [])
    ]


def unload_others(model: str, *, url: str = DEFAULT_URL, timeout: float = 60.0) -> list[str]:
    """Оставить в памяти только нужную модель.

    У этой машины 31 ГБ RAM, и Q4 (5.2 ГБ) с Q8 (8.9 ГБ) вместе с индексами туда
    уже не помещаются без свопа. Своп искажает обе величины сразу — и скорость,
    и память, — поэтому перед каждым профилем лишние модели выгружаются:
    `keep_alive: 0` в `/api/generate` без промпта как раз это и делает.
    """
    dropped: list[str] = []
    try:
        loaded = loaded_models(url=url, timeout=timeout)
    except Exception:                                              # noqa: BLE001
        return dropped
    for item in loaded:
        if item["name"] == model:
            continue
        try:
            requests.post(f"{url}/api/generate", json={"model": item["name"], "keep_alive": 0},
                          timeout=timeout)
            dropped.append(item["name"])
        except Exception:                                          # noqa: BLE001
            continue
    return dropped


def prepare_contexts(searcher: Searcher, questions: list[dict], filters: Filters) -> dict:
    """Поиск считается один раз на вопрос: он одинаков для всех профилей, а стоит
    секунды (эмбеддинг + FAISS + реранкер). Иначе в «скорость профиля» попадала бы
    ещё и скорость поиска, одинаковая для всех."""
    contexts: dict = {}
    for item in questions:
        got: Retrieved = retrieve(searcher, item["question"], pipeline="threshold",
                                  filters=filters)
        contexts[item["id"]] = got.context_hits
    return contexts


def score_rows(rows: list[dict]) -> dict:
    """Качество по проверяемым признакам. Считается только по отвеченным вопросам,
    у которых в базе есть ответ: у законного отказа источников и цитат нет по замыслу.

    `quality` — среднее четырёх долей: формат разобран, источники реальны, цитаты
    дословны, проверяемые факты на месте. Это не «оценка ума», а оценка соблюдения
    контракта — ровно то, что можно проверить кодом.
    """
    answered = [r for r in rows if r["answerable"] and not r["refused"]]
    unanswerable = [r for r in rows if not r["answerable"]]
    shares = {
        "format_ok": _share(answered, lambda r: r["format_ok"]),
        "sources_real": _ratio(answered, "sources_real", "sources_total"),
        "quotes_verbatim": _ratio(answered, "quotes_verbatim", "quotes_total"),
        "facts_covered": _ratio(answered, "facts_covered", "facts_total"),
    }
    present = [v for v in shares.values() if v is not None]
    return {
        **shares,
        "quality": round(sum(present) / len(present), 3) if present else 0.0,
        "answered": len(answered),
        "fabricated_sources": sum(len(r["unknown_sources"]) for r in answered),
        "fabricated_quotes": sum(r["fabricated_quotes"] for r in answered),
        "bad_format": sum(1 for r in answered if not r["format_ok"]),
        "refusal_ok": (sum(1 for r in unanswerable if r["refused"]) == len(unanswerable)
                       if unanswerable else None),
        "refusals": sum(1 for r in unanswerable if r["refused"]),
        "refusals_expected": len(unanswerable),
        "false_refusals": sum(1 for r in rows if r["answerable"] and r["refused"]),
    }


def _share(rows: list[dict], predicate) -> float | None:
    return round(sum(1 for r in rows if predicate(r)) / len(rows), 3) if rows else None


def _ratio(rows: list[dict], part: str, total: str) -> float | None:
    total_sum = sum(r[total] for r in rows)
    return round(sum(r[part] for r in rows) / total_sum, 3) if total_sum else None


def check_answer(item: dict, text: str) -> dict:
    """Разбор ответа теми же проверками, что в дне 24."""
    parsed: ParsedAnswer = parse_answer(text)
    refused = bool(getattr(parsed, "refusal", False)) or not parsed.answer and not parsed.sources
    check: QuoteCheck = QuoteCheck() if refused else check_citations(parsed, item.get("_hits") or [])
    facts = check_facts(text, item.get("must_contain") or [])
    return {
        "refused": refused,
        "format_ok": bool(parsed.format_ok),
        "problems": list(parsed.problems),
        "sources_total": check.sources_total,
        "sources_real": check.sources_real,
        "unknown_sources": list(check.unknown_sources),
        "quotes_total": check.total,
        "quotes_verbatim": check.verbatim,
        "fabricated_quotes": len(check.fabricated),
        "facts_covered": facts.covered,
        "facts_total": facts.total,
    }


def run_profile(profile: Profile, questions: list[dict], contexts: dict, *,
                url: str = DEFAULT_URL, max_chars: int = 6000, timeout: float = DEFAULT_TIMEOUT,
                warmup: bool = True, verbose: bool = True) -> dict:
    """Прогон одного профиля по всем вопросам."""
    freed = unload_others(profile.model, url=url)
    if verbose and freed:
        print(f"    выгружено из памяти: {', '.join(freed)}")
    if warmup:
        # Прогрев: загружает веса в память (иначе первый вопрос профиля платит
        # за загрузку модели, и «скорость» превращается в «скорость диска»).
        try:
            ask_local(profile.model, "ответь одним словом: ок", url=url,
                      options={"num_predict": 1}, timeout=timeout)
        except Exception as exc:                                   # noqa: BLE001
            if verbose:
                print(f"    прогрев не удался: {exc}")

    rows: list[dict] = []
    for item in questions:
        hits = contexts[item["id"]]
        prompt = (compact_prompt(item["question"], hits, max_chars=max_chars)
                  if profile.prompt == "compact" else item["_full_prompt"])
        enriched = {**item, "_hits": hits}
        row: dict = {"id": item["id"], "question": item["question"],
                     "answerable": item.get("answerable", True)}
        try:
            text, data = ask_local(profile.model, prompt, url=url, options=profile.options,
                                   timeout=timeout)
            row.update(check_answer(enriched, text))
            row.update(timings(data))
            row["answer"] = text
            row["client_seconds"] = float(data.get("_client_seconds") or 0.0)
            row["error"] = ""
        except Exception as exc:                                   # noqa: BLE001
            row.update({"error": str(exc), "answer": "", "client_seconds": 0.0})
        rows.append(row)
        if verbose:
            mark = "контракт ок" if row.get("format_ok") else "формат нарушен"
            print(f"    [{row['id']}] {mark} · источники {row.get('sources_real', 0)}/"
                  f"{row.get('sources_total', 0)} · цитаты {row.get('quotes_verbatim', 0)}/"
                  f"{row.get('quotes_total', 0)} · факты {row.get('facts_covered', 0)}/"
                  f"{row.get('facts_total', 0)} · {row.get('prompt_tokens', 0)} промпт-токенов "
                  f"· {row.get('generate_tps', 0)} ток/с · {row.get('client_seconds', 0)} с"
                  + (f" · ОШИБКА {row['error']}" if row.get("error") else ""))

    quality = score_rows(rows)
    ok = [r for r in rows if not r.get("error")]
    loaded = [m for m in _safe_loaded(url) if m["name"].startswith(profile.model.split(":")[0])]
    return {
        "id": profile.id,
        "title": profile.title,
        "model": profile.model,
        "options": profile.options,
        "prompt": profile.prompt,
        "note": profile.note,
        "rows": rows,
        "quality": quality,
        "speed": {
            "client_seconds_avg": round(sum(r["client_seconds"] for r in ok) / len(ok), 2) if ok else 0.0,
            "prompt_tokens_avg": round(sum(r.get("prompt_tokens", 0) for r in ok) / len(ok), 0) if ok else 0,
            "prefill_tps_avg": _avg([r.get("prefill_tps") for r in ok]),
            "generate_tps_avg": _avg([r.get("generate_tps") for r in ok]),
            "eval_tokens_total": sum(r.get("eval_tokens", 0) for r in ok),
        },
        "memory": {"loaded": loaded,
                   "model_gb": loaded[0]["size_gb"] if loaded else None},
        "errors": [r["error"] for r in ok if r.get("error")],
    }


def _avg(values: list) -> float:
    clean = [float(v) for v in values if v]
    return round(sum(clean) / len(clean), 1) if clean else 0.0


def _safe_loaded(url: str) -> list[dict]:
    try:
        return loaded_models(url)
    except Exception:                                              # noqa: BLE001
        return []


def load_questions(path: Path, ids: tuple[str, ...]) -> list[dict]:
    """Взять из контрольного набора нужные вопросы, сохранив порядок `ids`."""
    everything = {item["id"]: item for item in load_control(path)}
    missing = [i for i in ids if i not in everything]
    if missing:
        raise KeyError(f"в наборе нет вопросов: {', '.join(missing)}")
    return [everything[i] for i in ids]


def compare(profiles: list[dict], *, questions: int, model_note: str = "") -> dict:
    return {"questions": questions, "model_note": model_note, "profiles": profiles}


def write_report(result: dict, out_dir: Path) -> Path:
    """Отчёт «до/после»: качество, скорость и память по профилям."""
    lines = ["# Оптимизация локальной модели под задачу справки\n"]
    lines.append(f"Вопросов в прогоне: **{result['questions']}** "
                 "(три с ответом в базе, один без ответа). "
                 "Режим рассуждений выключен у всех профилей, порог отказа — тоже: "
                 "поведение «не знаю» проверяется у самой модели.\n")
    if result.get("model_note"):
        lines.append(result["model_note"] + "\n")

    lines.append("## Качество (проверяется кодом, не судьёй)\n")
    lines.append("| Профиль | Модель | Формат | Источники реальны | Цитаты дословны | "
                 "Факты на месте | Выдуманных цитат | «Не знаю» | Качество |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for profile in result["profiles"]:
        q = profile["quality"]
        lines.append(
            f"| {profile['title']} | `{profile['model']}` | {_pct(q['format_ok'])} | "
            f"{_pct(q['sources_real'])} | {_pct(q['quotes_verbatim'])} | "
            f"{_pct(q['facts_covered'])} | {q['fabricated_quotes']} | "
            f"{_refusal(q)} | **{q['quality']:.2f}** |")

    lines.append("\n## Скорость и ресурсы\n")
    lines.append("| Профиль | Промпт-токенов | Обработка промпта | Генерация | "
                 "Секунд на вопрос | Модель в памяти |")
    lines.append("|---|---|---|---|---|---|")
    for profile in result["profiles"]:
        s = profile["speed"]
        gb = profile["memory"]["model_gb"]
        lines.append(f"| {profile['title']} | {s['prompt_tokens_avg']:.0f} | "
                     f"{s['prefill_tps_avg']} ток/с | {s['generate_tps_avg']} ток/с | "
                     f"{s['client_seconds_avg']} | {gb if gb else '—'} ГБ |")

    lines.append("\n## Что менялось на каждом шаге\n")
    for profile in result["profiles"]:
        lines.append(f"- **{profile['title']}** (`{profile['model']}`) — {profile['note']}")

    best = max(result["profiles"], key=lambda p: (p["quality"]["quality"],
                                                  p["speed"]["generate_tps_avg"]))
    lines.append(f"\n**Выбор:** {best['title']} — качество {best['quality']['quality']:.2f} "
                 f"при {best['speed']['generate_tps_avg']} ток/с.\n")
    path = out_dir / "optimize.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    (out_dir / "optimize.json").write_text(json.dumps(result, ensure_ascii=False, indent=1),
                                           encoding="utf-8")
    return path


def _pct(value) -> str:
    return "—" if value is None else f"{value * 100:.0f}%"


def _refusal(quality: dict) -> str:
    if quality["refusals_expected"] == 0:
        return "—"
    return f"{quality['refusals']}/{quality['refusals_expected']}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="doc_index.optimize",
                                     description="Оптимизация локальной модели под RAG-справку")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--questions", default="data/control-questions.yaml")
    parser.add_argument("--ids", default=",".join(DEFAULT_QUESTION_IDS),
                        help="какие вопросы взять из набора")
    parser.add_argument("--only", default="", help="профили через запятую (по умолчанию все)")
    parser.add_argument("--max-chars", type=int, default=6000)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--no-warmup", action="store_true")
    parser.add_argument("--modelfiles", default="",
                        help="куда записать Modelfile оптимизированных моделей и выйти")
    parser.add_argument("--json", default="", help="куда сохранить результат (JSON)")
    args = parser.parse_args(argv)

    if args.modelfiles:
        target = Path(args.modelfiles)
        target.mkdir(parents=True, exist_ok=True)
        plans = (("rag-brief.Modelfile", BASE_MODEL, OPTIMIZED_MODEL),
                 ("rag-brief-q8.Modelfile", BASE_MODEL_Q8, OPTIMIZED_MODEL_Q8))
        for name, base, model in plans:
            path = target / name
            path.write_text(modelfile(base), encoding="utf-8")
            print(f"{path} → ollama create {model} -f {path}")
        return 0

    ids = tuple(i.strip() for i in args.ids.split(",") if i.strip())
    selected = [p for p in PROFILES if not args.only or p.id in args.only.split(",")]
    if not selected:
        print("нет подходящих профилей")
        return 1

    cfg = Config()
    cfg.ensure_out()
    questions = load_questions(Path(args.questions), ids)
    conn = store.connect(cfg.db_path())
    searcher = Searcher(conn, cfg, OllamaEmbedder(cfg), "structural")
    filters = Filters(candidates=20, k=5, expand=1, search_mode="dense",
                      margin=0.04, min_dense=None, min_score=0.2, min_keep=1)
    print(f"вопросы: {', '.join(ids)} · профилей: {len(selected)}")
    contexts = prepare_contexts(searcher, questions, filters)

    # Промпт «как в день 24» готовится заранее: он одинаков во всех профилях со
    # стратегией `full`, и его длина — часть сравнения (шаг «шаблон» её уменьшает).
    from .rag import build_prompt
    for item in questions:
        item["_full_prompt"] = build_prompt(item["question"], contexts[item["id"]],
                                            max_chars=args.max_chars, strict=True)

    results: list[dict] = []
    for profile in selected:
        print(f"\n[{profile.id}] {profile.title} · {profile.model}")
        results.append(run_profile(profile, questions, contexts, url=args.url,
                                   max_chars=args.max_chars, timeout=args.timeout,
                                   warmup=not args.no_warmup))

    result = compare(results, questions=len(questions))
    path = write_report(result, cfg.out)
    for profile in results:
        q, s = profile["quality"], profile["speed"]
        print(f"  {profile['id']:<9} качество {q['quality']:.2f} · "
              f"{s['generate_tps_avg']} ток/с · {s['client_seconds_avg']} с/вопрос · "
              f"промпт {s['prompt_tokens_avg']:.0f} токенов")
    print(f"\nотчёт: {path}")
    if args.json:
        target = Path(args.json)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"результат: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
