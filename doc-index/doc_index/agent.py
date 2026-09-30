"""Вызов агента харнесса из Python — то, чем RAG-ответ отличается от ответа «по памяти».

Один рантайм на весь прогон: `DeepSeekHarness` держит подпроцесс живым между вызовами,
поэтому 25 вопросов стоят один запуск, а не 25. Каждый вопрос уходит в **отдельную
сессию** (`run()` без `session_id` создаёт новую) — иначе предыдущие вопросы влияли бы
на следующие, и сравнение режимов поехало бы.

SDK лежит внутри установки харнесса (`python/sdk/src`) и не установлен как пакет,
поэтому путь добавляется в `sys.path`; путь переопределяется через `DSH_SDK_SRC`.
"""
from __future__ import annotations

import os
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path

DEFAULT_SDK_SRC = Path(r"C:\Program Files\dsh\deepseek-harness\python\sdk\src")
DEFAULT_DSH_HOME = Path.home() / ".dsh-term"


class AgentError(RuntimeError):
    """Понятная ошибка вместо стектрейса из недр SDK."""


@dataclass
class AgentReply:
    text: str
    seconds: float
    finish_reason: str | None


def sdk_src() -> Path:
    return Path(os.environ.get("DSH_SDK_SRC", str(DEFAULT_SDK_SRC)))


def dsh_home() -> Path:
    return Path(os.environ.get("DSH_HOME", str(DEFAULT_DSH_HOME)))


def find_dsh_bin() -> str | None:
    """Исполняемый файл харнесса: на Windows это `dsh.cmd` из PATH."""
    for name in ("dsh.cmd", "dsh"):
        found = shutil.which(name)
        if found:
            return found
    return None


class HarnessAgent:
    """Агент харнесса: один рантайм, отдельная сессия на каждый вопрос."""

    def __init__(self, *, model: str = "deepseek-v4-flash", provider: str = "deepseek-official",
                 cwd: Path | str | None = None, dsh_bin: str | None = None,
                 sdk_path: Path | None = None, home: Path | None = None,
                 profile: str = "sdk") -> None:
        self.model = model
        self.provider = provider
        self.profile = profile
        self.cwd = str(Path(cwd or Path.cwd()).resolve())
        self.sdk_path = Path(sdk_path) if sdk_path else sdk_src()
        self.home = Path(home) if home else dsh_home()
        self.dsh_bin = dsh_bin or find_dsh_bin()
        self.calls = 0
        self.seconds = 0.0
        self._harness = None

    def start(self) -> None:
        if self._harness is not None:
            return
        if not self.sdk_path.exists():
            raise AgentError(f"не найден Python SDK харнесса: {self.sdk_path}")
        if str(self.sdk_path) not in sys.path:
            sys.path.insert(0, str(self.sdk_path))
        try:
            from deepseek_harness import DeepSeekHarness
        except ImportError as exc:                       # noqa: PERF203
            raise AgentError(f"SDK харнесса не импортируется из {self.sdk_path}: {exc}") from exc
        if not self.home.exists():
            raise AgentError(f"нет домашнего каталога харнесса {self.home} с учётными данными")
        if self.dsh_bin is None:
            raise AgentError("не найден исполняемый файл dsh — нужен dsh.cmd в PATH")

        self._harness = DeepSeekHarness(
            provider=self.provider,
            model=self.model,
            cwd=self.cwd,
            dsh_home=str(self.home),
            profile=self.profile,
            dsh_bin=self.dsh_bin,
        )
        self._harness.start()

    def close(self) -> None:
        if self._harness is not None:
            self._harness.close()
            self._harness = None

    def __enter__(self) -> "HarnessAgent":
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def ask(self, prompt: str) -> AgentReply:
        """Один ход агента в чистой сессии."""
        if self._harness is None:
            self.start()
        started = time.time()
        try:
            result = self._harness.run(prompt)
        except Exception as exc:                          # noqa: BLE001 — нужна любая ошибка рантайма
            raise AgentError(f"агент не ответил: {exc}") from exc
        seconds = time.time() - started
        self.calls += 1
        self.seconds += seconds
        return AgentReply(
            text=(result.final_response or "").strip(),
            seconds=seconds,
            finish_reason=result.finish_reason,
        )

    def speed(self) -> float:
        return self.seconds / self.calls if self.calls else 0.0
