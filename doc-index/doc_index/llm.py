"""Прямой вызов модели по OpenAI-совместимому API — без инструментов и рабочей папки.

Зачем отдельный клиент, если уже есть агент харнесса. В первом прогоне контрольного
набора агент (профиль `sdk`) **прочитал файл с эталонами** `data/control-questions.yaml`
и пересказал мою же формулировку в режиме «без RAG», а в режиме «с RAG» он в принципе
мог бы читать сам корпус, минуя поиск. Тогда сравнивались бы не «с контекстом» и
«без контекста», а два агента с разным доступом к файлам.

Чистый вызов модели убирает этот класс ошибок: единственное различие двух режимов —
блок контекста в нашем промпте.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import yaml

from .agent import AgentReply

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-flash"
# Локальная модель в Ollama отдаёт тот же OpenAI-совместимый протокол, поэтому
# отдельного клиента не нужно — только другой адрес и фиктивный ключ.
LOCAL_ROOT = "http://127.0.0.1:11434"
LOCAL_MODEL = "qwen3:8b"
# Ключ сервисного слоя (день 30). Сама Ollama ключи не проверяет, но когда
# локальная модель стоит за сервисом (LiteLLM с ключом и лимитами), клиент
# обязан ключ предъявить. Пусто — прямое обращение к Ollama, как в днях 26–29.
SERVICE_KEY_ENV = "DSH_AI_SERVICE_KEY"
CREDENTIALS_PATH = Path.home() / ".dsh-term" / ".credentials.yaml"


def local_base_url(root: str | None = None) -> str:
    """`http://127.0.0.1:11434` → `http://127.0.0.1:11434/v1` (эндпоинт Ollama)."""
    root = (root or os.environ.get("DSH_TERM_OLLAMA") or LOCAL_ROOT).rstrip("/")
    return root if root.endswith("/v1") else f"{root}/v1"


def local_client(model: str = LOCAL_MODEL, *, root: str | None = None,
                 timeout: float = 600.0, reasoning_effort: str | None = "none",
                 temperature: float | None = 0.0, max_tokens: int = 400,
                 api_key: str | None = None, **kwargs) -> "LlmClient":
    """Клиент локальной модели: длинный таймаут, без рассуждений, детерминированно.

    Таймаут большой, потому что на CPU модель считает медленно (замеры: обработка
    промпта ~53 ток/с, генерация ~6-8 ток/с). Рассуждения выключены: у qwen3 они
    включены по умолчанию, стоят в разы больше токенов, чем ответ, и именно из-за
    них строгая справка выглядела «зависшей».

    `temperature=0` и `max_tokens=400` — результат дня 29: у задачи справки есть
    правильный ответ, случайность вредит, а контрактный ответ длиннее 400 токенов
    не бывает. Важная деталь: Ollama-специфичное поле `options` этот эндпоинт
    **молча игнорирует** (проверено: `options.num_predict` не влияет ни на что),
    поэтому `num_ctx` и `num_predict` задаются в самой модели через `Modelfile`
    (см. `doc_index.optimize`), а здесь работают только стандартные поля OpenAI.

    Ключ берётся из `DSH_AI_SERVICE_KEY`, когда модель стоит за сервисом (день 30):
    адрес сервиса задаётся тем же `DSH_TERM_OLLAMA`, потому что протокол один и
    тот же — меняется только то, что теперь нужен ключ.
    """
    key = api_key or os.environ.get(SERVICE_KEY_ENV, "").strip() or "ollama"
    return LlmClient(model=model, base_url=local_base_url(root), api_key=key,
                     timeout=timeout, reasoning_effort=reasoning_effort,
                     temperature=temperature, max_tokens=max_tokens, **kwargs)


class LlmError(RuntimeError):
    """Понятная ошибка вместо стектрейса из urllib."""


def load_api_key() -> str:
    """Ключ из окружения или из хранилища dsh-term. Сам ключ нигде не печатается."""
    from_env = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if from_env:
        return from_env
    if CREDENTIALS_PATH.exists():
        data = yaml.safe_load(CREDENTIALS_PATH.read_text(encoding="utf-8")) or {}
        key = (data.get("refs") or {}).get("DEEPSEEK_API_KEY")
        if key:
            return str(key).strip()
    raise LlmError(
        f"не найден ключ DEEPSEEK_API_KEY: ни в окружении, ни в {CREDENTIALS_PATH}"
    )


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    reasoning_tokens: int = 0


class LlmClient:
    """Интерфейс как у `HarnessAgent`: `ask(prompt) -> AgentReply`, счётчики вызовов и времени."""

    def __init__(self, *, model: str = DEFAULT_MODEL, base_url: str = DEFAULT_BASE_URL,
                 api_key: str | None = None, max_tokens: int = 4000,
                 timeout: float = 240.0, reasoning_effort: str | None = None,
                 temperature: float | None = None) -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or load_api_key()
        self.max_tokens = max_tokens
        self.timeout = timeout
        # `None` — «не вмешиваться»: у облачной модели температура подобрана
        # провайдером, и локальные выводы дня 29 на неё не переносятся.
        self.temperature = temperature
        # `reasoning_effort: none` выключает рассуждения у qwen3 в Ollama. Это
        # единственный работающий способ через OpenAI-совместимый эндпоинт:
        # `think: false` он игнорирует (проверено), `/no_think` в промпте и
        # `chat_template_kwargs` тоже не действуют, а без выключения модель тратит
        # на размышления больше токенов, чем на ответ: на CPU это минуты, и при
        # исчерпании бюджета ответ приходит пустым.
        self.reasoning_effort = reasoning_effort
        self.calls = 0
        self.seconds = 0.0
        self.retries = 0
        self.usage = Usage()

    def start(self) -> None:
        """Совместимость с агентом: у чистого клиента запускать нечего."""

    def close(self) -> None:
        """Совместимость с агентом: закрывать нечего."""

    def __enter__(self) -> "LlmClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def ask(self, prompt: str) -> AgentReply:
        reply = self._call(prompt, self.max_tokens)
        # Модель reasoning-типа: если бюджет выбран размышлением, content приходит пустым.
        # Пустой ответ нельзя оставлять как есть — он несправедливо занижает режим,
        # поэтому один раз пробуем с удвоенным бюджетом.
        if not reply.text and reply.finish_reason == "length":
            self.retries += 1
            reply = self._call(prompt, self.max_tokens * 2)
        return reply

    def _call(self, prompt: str, max_tokens: int) -> AgentReply:
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
        }
        if self.reasoning_effort is not None:
            payload["reasoning_effort"] = self.reasoning_effort
        if self.temperature is not None:
            payload["temperature"] = self.temperature
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self.api_key}"},
        )
        started = time.time()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:300]
            raise LlmError(f"модель вернула HTTP {exc.code}: {body}") from exc
        except Exception as exc:                              # noqa: BLE001
            raise LlmError(f"не удалось вызвать модель: {exc}") from exc

        seconds = time.time() - started
        self.calls += 1
        self.seconds += seconds
        usage = data.get("usage") or {}
        self.usage.prompt_tokens += int(usage.get("prompt_tokens") or 0)
        self.usage.completion_tokens += int(usage.get("completion_tokens") or 0)
        details = usage.get("completion_tokens_details") or {}
        self.usage.reasoning_tokens += int(details.get("reasoning_tokens") or 0)

        choices = data.get("choices") or []
        message = (choices[0].get("message") if choices else {}) or {}
        text = (message.get("content") or "").strip()
        return AgentReply(text=text, seconds=seconds,
                          finish_reason=choices[0].get("finish_reason") if choices else None)

    def speed(self) -> float:
        return self.seconds / self.calls if self.calls else 0.0
