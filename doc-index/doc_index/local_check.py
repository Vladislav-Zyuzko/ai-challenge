"""Локальная LLM: проверка запуска, HTTP-доступа и запросов разной сложности.

Задание дня 26 требует показать три вещи: модель **запускается локально**, к ней можно
**обратиться через CLI или HTTP API** и она **отвечает на простой запрос**. Плюс минимум
три запроса разной сложности. Здесь это собрано в одну проверку, чтобы результат был
воспроизводимым и срав нимым между моделями.

Проверяется:

1. **Список моделей** — `GET /api/tags`: что реально лежит в Ollama.
2. **HTTP API, два протокола**: нативный `/api/chat` и OpenAI-совместимый
   `/v1/chat/completions` (последний важен: через него локальную модель подключает харнесс).
3. **Три запроса разной сложности** — факт, объяснение с планом и задача на код;
   в отчёте видно время, токены и скорость генерации.
4. **Tool calling** — может ли модель вызвать инструмент: без этого она не сможет
   ходить в RAG (`rag_search`).

Запуск:

    python -m doc_index.local_check --model qwen3:8b
    python -m doc_index.local_check --model qwen3:8b --json out/local-llm.json
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import requests

DEFAULT_URL = "http://127.0.0.1:11434"
DEFAULT_TIMEOUT = 600.0

# Три запроса разной сложности: факт → объяснение с планом → задача на код.
TASKS = (
    {
        "id": "simple",
        "kind": "простой факт",
        "prompt": "Столица Австралии? Ответь одним словом.",
        "expect": "Канберра",
    },
    {
        "id": "medium",
        "kind": "объяснение с планом",
        "prompt": ("Объясни в трёх предложениях, чем RAG отличается от дообучения модели, "
                   "и назови по одному случаю, когда выбирают каждое."),
        "expect": "внешние знания против весов модели",
    },
    {
        "id": "hard",
        "kind": "код и рассуждение",
        "prompt": ("Напиши функцию на Python `rrf(rank_lists, k=60)`, которая сливает "
                   "несколько ранжированных списков по Reciprocal Rank Fusion и возвращает "
                   "список (id, score), отсортированный по убыванию. Кратко поясни формулу."),
        "expect": "сумма 1/(k+ранг) по спискам",
    },
)

TOOL_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "rag_search",
            "description": "Найти фрагменты в базе знаний по запросу",
            "parameters": {
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": {"type": "string", "description": "поисковый запрос"},
                },
            },
        },
    }
]


@dataclass
class TaskResult:
    id: str
    kind: str
    prompt: str
    answer: str = ""
    seconds: float = 0.0
    eval_count: int = 0
    prompt_tokens: int = 0
    error: str = ""

    @property
    def tokens_per_second(self) -> float:
        return round(self.eval_count / self.seconds, 1) if self.seconds and self.eval_count else 0.0


@dataclass
class LocalReport:
    url: str
    model: str
    models: list[str] = field(default_factory=list)
    tasks: list[TaskResult] = field(default_factory=list)
    openai_ok: bool = False
    openai_answer: str = ""
    openai_seconds: float = 0.0
    tool_ok: bool = False
    tool_calls: list[dict] = field(default_factory=list)
    tool_seconds: float = 0.0
    errors: list[str] = field(default_factory=list)


def list_models(url: str = DEFAULT_URL, timeout: float = 30.0) -> list[str]:
    """Что реально лежит в Ollama."""
    response = requests.get(f"{url}/api/tags", timeout=timeout)
    response.raise_for_status()
    return [item.get("name", "") for item in response.json().get("models", [])]


def health(url: str = DEFAULT_URL, timeout: float = 10.0) -> str:
    response = requests.get(f"{url}/api/version", timeout=timeout)
    response.raise_for_status()
    return str(response.json().get("version", "?"))


def chat(model: str, prompt: str, *, url: str = DEFAULT_URL, system: str = "",
         timeout: float = DEFAULT_TIMEOUT, think: bool = False) -> tuple[str, dict]:
    """Нативный протокол Ollama: /api/chat без стрима.

    `think=False` выключает режим рассуждений у qwen3. На CPU это принципиально:
    с рассуждениями модель генерирует в разы больше токенов, и запрос на код
    не укладывается даже в пять минут (проверено).
    """
    messages = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": prompt}
    ]
    started = time.perf_counter()
    response = requests.post(f"{url}/api/chat",
                             json={"model": model, "messages": messages, "stream": False,
                                   "think": think},
                             timeout=timeout)
    response.raise_for_status()
    data = response.json()
    data["_client_seconds"] = round(time.perf_counter() - started, 2)
    return (data.get("message", {}).get("content") or "").strip(), data


def chat_openai(model: str, prompt: str, *, url: str = DEFAULT_URL,
                timeout: float = DEFAULT_TIMEOUT) -> tuple[str, float]:
    """OpenAI-совместимый протокол: через него локальную модель подключает харнесс."""
    started = time.perf_counter()
    response = requests.post(
        f"{url}/v1/chat/completions",
        json={"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False},
        headers={"Authorization": "Bearer ollama"},
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    text = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    return text.strip(), round(time.perf_counter() - started, 2)


def tool_probe(model: str, *, url: str = DEFAULT_URL,
               timeout: float = DEFAULT_TIMEOUT) -> tuple[list[dict], float, str]:
    """Проверка tool calling: без него локальная модель не сходит в RAG."""
    started = time.perf_counter()
    response = requests.post(
        f"{url}/api/chat",
        json={
            "model": model,
            "stream": False,
            "messages": [{"role": "user",
                          "content": "Найди в базе знаний, что такое агентный харнесс."}],
            "tools": TOOL_SCHEMA,
        },
        timeout=timeout,
    )
    response.raise_for_status()
    message = response.json().get("message", {})
    return (message.get("tool_calls") or []), round(time.perf_counter() - started, 2), \
        (message.get("content") or "").strip()


def run_checks(model: str, *, url: str = DEFAULT_URL, timeout: float = DEFAULT_TIMEOUT,
               tasks: tuple = TASKS, verbose: bool = True) -> LocalReport:
    """Полная проверка: список моделей → HTTP → три запроса → tool calling."""
    report = LocalReport(url=url, model=model)
    try:
        report.models = list_models(url)
    except Exception as exc:
        report.errors.append(f"список моделей: {exc}")
    if verbose:
        print(f"Ollama: {url} · версия {health(url) if not report.errors else '—'}")
        print(f"модели: {', '.join(report.models) or '—'}")

    for spec in tasks:
        task = TaskResult(id=spec["id"], kind=spec["kind"], prompt=spec["prompt"])
        try:
            answer, data = chat(model, spec["prompt"], url=url, timeout=timeout)
            task.answer = answer
            task.seconds = float(data.get("_client_seconds") or 0.0)
            task.eval_count = int(data.get("eval_count") or 0)
            task.prompt_tokens = int(data.get("prompt_eval_count") or 0)
        except Exception as exc:
            task.error = str(exc)
            report.errors.append(f"{task.id}: {exc}")
        report.tasks.append(task)
        if verbose:
            if task.error:
                print(f"  [{task.id}] ошибка: {task.error}")
            else:
                print(f"  [{task.id}] {task.kind}: {task.seconds} с · {task.eval_count} токенов "
                      f"· {task.tokens_per_second} ток/с · «{task.answer[:70].replace(chr(10), ' ')}…»")

    try:
        answer, seconds = chat_openai(model, "Скажи одним предложением, что такое эмбеддинг.",
                                      url=url, timeout=timeout)
        report.openai_ok, report.openai_answer, report.openai_seconds = True, answer, seconds
    except Exception as exc:
        report.errors.append(f"openai-совместимый API: {exc}")
    if verbose:
        print(f"  [openai] /v1/chat/completions: "
              + (f"ок за {report.openai_seconds} с" if report.openai_ok
                 else f"ошибка: {report.errors[-1]}"))

    try:
        calls, seconds, text = tool_probe(model, url=url, timeout=timeout)
        report.tool_calls, report.tool_seconds = calls, seconds
        report.tool_ok = bool(calls)
        if not calls and text and verbose:
            print(f"  [tool] вызова нет, ответ текстом: «{text[:70]}»")
    except Exception as exc:
        report.errors.append(f"tool calling: {exc}")
    if verbose and report.tool_ok:
        names = [c.get("function", {}).get("name") for c in report.tool_calls]
        print(f"  [tool] вызов инструмента: {names} за {report.tool_seconds} с")
    return report


def summarize(report: LocalReport) -> dict:
    ok = [t for t in report.tasks if not t.error and t.answer]
    return {
        "url": report.url,
        "model": report.model,
        "models": report.models,
        "tasks_total": len(report.tasks),
        "tasks_ok": len(ok),
        "seconds_avg": round(sum(t.seconds for t in ok) / len(ok), 2) if ok else 0.0,
        "tokens_total": sum(t.eval_count for t in ok),
        "tokens_per_second_avg": round(sum(t.tokens_per_second for t in ok) / len(ok), 1) if ok else 0.0,
        "openai_ok": report.openai_ok,
        "tool_ok": report.tool_ok,
        "errors": report.errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="doc_index.local_check",
                                     description="Проверка локальной LLM через Ollama")
    parser.add_argument("--model", default="qwen3:8b", help="имя модели в Ollama")
    parser.add_argument("--url", default=DEFAULT_URL, help="адрес Ollama")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--json", default="", help="куда сохранить результат (JSON)")
    args = parser.parse_args(argv)

    report = run_checks(args.model, url=args.url, timeout=args.timeout)
    summary = summarize(report)
    print(f"\nитог: запросов {summary['tasks_ok']}/{summary['tasks_total']} · "
          f"в среднем {summary['seconds_avg']} с и {summary['tokens_per_second_avg']} ток/с · "
          f"OpenAI-совместимый API {'ок' if summary['openai_ok'] else 'НЕТ'} · "
          f"tool calling {'ок' if summary['tool_ok'] else 'НЕТ'}")
    if summary["errors"]:
        print("ошибки: " + "; ".join(summary["errors"]))
    if args.json:
        path = Path(args.json)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"summary": summary, "report": asdict(report)},
                                   ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"результат: {path}")
    return 0 if summary["tasks_ok"] == summary["tasks_total"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
