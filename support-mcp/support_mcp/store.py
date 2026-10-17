"""Хранилище обращений поддержки: пользователи и тикеты в JSON.

Отдельный модуль, а не код внутри MCP-сервера, по той же причине, что и в дне 31:
всё, что можно проверить без протокола, должно проверяться без протокола. Сервер здесь —
тонкая обёртка над `SupportStore`.

Данные — два файла: `users.json` и `tickets.json`. Это фикстуры поддержки продукта
`dsh-term` (день 33): тикеты описывают реальные проблемы из отчётов дней 26–32, чтобы
ассистент отвечал по делу, а не по выдуманным примерам.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DATA = Path(__file__).resolve().parent.parent / "data"


class SupportError(RuntimeError):
    """Понятная ошибка вместо стектрейса: её увидит и агент, и тест."""


def _load(path: Path) -> list[dict]:
    if not path.exists():
        raise SupportError(f"нет файла данных: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SupportError(f"{path}: не разобрать JSON ({exc})") from exc
    if not isinstance(data, list):
        raise SupportError(f"{path}: ожидался массив записей")
    return data


def _index_by_id(rows: list[dict], path: Path) -> dict[str, dict]:
    """Словарь по `id` с понятной ошибкой на запись без идентификатора.

    Без проверки `KeyError` уходил бы трейсбеком мимо `except SupportError`, а
    модуль обещает диагностику, а не стектрейс (нашёл ревьювер на PR #31).
    """
    result: dict[str, dict] = {}
    for position, row in enumerate(rows, start=1):
        if not isinstance(row, dict) or not str(row.get("id", "")).strip():
            raise SupportError(f"{path}: запись №{position} без поля id")
        result[str(row["id"])] = row
    return result


def _write_json_atomic(path: Path, payload: object) -> None:
    """Записать JSON атомарно: временный файл рядом + `os.replace`.

    `write_text` поверх существующего файла при прерывании оставляет обрезанный
    `tickets.json` — то есть потерю всех обращений без копии.
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


@dataclass
class SupportStore:
    """Пользователи и тикеты поддержки. По умолчанию только чтение."""

    data_dir: Path = DEFAULT_DATA
    readonly: bool = True
    _users: dict[str, dict] = field(default_factory=dict, repr=False)
    _tickets: dict[str, dict] = field(default_factory=dict, repr=False)
    _order: list[str] = field(default_factory=list, repr=False)

    def load(self) -> "SupportStore":
        users_path = self.data_dir / "users.json"
        tickets_path = self.data_dir / "tickets.json"
        self._users = _index_by_id(_load(users_path), users_path)
        tickets = _load(tickets_path)
        self._tickets = _index_by_id(tickets, tickets_path)
        self._order = [str(ticket["id"]) for ticket in tickets]
        return self

    # --- чтение ---------------------------------------------------------------
    def tickets(self, status: str = "") -> list[dict]:
        """Список обращений: краткая карточка без переписки."""
        wanted = status.strip().lower()
        rows = []
        for ticket_id in self._order:
            ticket = self._tickets[ticket_id]
            if wanted and str(ticket.get("status", "")).lower() != wanted:
                continue
            rows.append(self._card(ticket))
        return rows

    def ticket(self, ticket_id: str) -> dict:
        """Полное обращение: карточка, пользователь и переписка."""
        ticket = self._require(ticket_id)
        return {
            **self._card(ticket),
            "user": self._users.get(str(ticket.get("user")), {"id": ticket.get("user")}),
            "messages": list(ticket.get("messages") or []),
            "resolution": str(ticket.get("resolution") or ""),
        }

    def user(self, key: str) -> dict:
        """Пользователь по id, почте или имени (без учёта регистра)."""
        needle = str(key).strip().lower()
        for user in self._users.values():
            if needle in (str(user.get("id", "")).lower(), str(user.get("email", "")).lower(),
                          str(user.get("name", "")).lower()):
                return user
        raise SupportError(f"пользователь не найден: {key}")

    def find(self, query: str) -> list[dict]:
        """Поиск по обращениям: тема, теги, переписка и компонент."""
        needle = str(query).strip().lower()
        if not needle:
            raise SupportError("пустой запрос: нужен текст для поиска")
        found = []
        for ticket_id in self._order:
            ticket = self._tickets[ticket_id]
            haystack = " ".join([
                str(ticket.get("subject", "")),
                str(ticket.get("component", "")),
                " ".join(str(tag) for tag in ticket.get("tags") or []),
                " ".join(str(item.get("text", "")) for item in ticket.get("messages") or []),
            ]).lower()
            if needle in haystack:
                found.append(self._card(ticket))
        return found

    # --- запись ---------------------------------------------------------------
    def add_comment(self, ticket_id: str, text: str) -> dict:
        """Записать сообщение в тикет: только в режиме не-readonly.

        `at` обязателен: слепок обращения в системном промпте печатает время реплики,
        и без него новая строка выглядела бы как «[] поддержка: текст».
        """
        if self.readonly:
            raise SupportError("запись отключена: сервер запущен в режиме только чтения")
        body = str(text).strip()
        if not body:
            raise SupportError("пустой комментарий")
        ticket = self._require(ticket_id)
        ticket.setdefault("messages", []).append({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "from": "support",
            "text": body,
        })
        self._tickets[ticket_id] = ticket
        payload = [self._tickets[ticket_id] for ticket_id in self._order]
        _write_json_atomic(self.data_dir / "tickets.json", payload)
        return {"id": ticket_id, "messages": len(ticket["messages"])}

    # --- внутреннее -----------------------------------------------------------
    def _require(self, ticket_id: str) -> dict:
        key = str(ticket_id).strip()
        if not key:
            raise SupportError("не указан тикет")
        if key not in self._tickets:
            raise SupportError(f"тикет не найден: {key}. Известные: {', '.join(self._order)}")
        return self._tickets[key]

    def _card(self, ticket: dict) -> dict:
        user = self._users.get(str(ticket.get("user")), {})
        return {
            "id": ticket.get("id"),
            "subject": ticket.get("subject"),
            "component": ticket.get("component"),
            "status": ticket.get("status"),
            "created_at": ticket.get("created_at"),
            "tags": list(ticket.get("tags") or []),
            "user": {"id": user.get("id"), "name": user.get("name"), "plan": user.get("plan")},
            "messages": len(ticket.get("messages") or []),
        }
