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
CREDENTIALS_PATH = Path.home() / ".dsh-term" / ".credentials.yaml"


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
                 timeout: float = 240.0) -> None:
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or load_api_key()
        self.max_tokens = max_tokens
        self.timeout = timeout
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
