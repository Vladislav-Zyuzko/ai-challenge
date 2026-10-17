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
from dataclasses import dataclass, field
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


@dataclass
class SupportStore:
    """Пользователи и тикеты поддержки. По умолчанию только чтение."""

    data_dir: Path = DEFAULT_DATA
    readonly: bool = True
    _users: dict[str, dict] = field(default_factory=dict, repr=False)
    _tickets: dict[str, dict] = field(default_factory=dict, repr=False)
    _order: list[str] = field(default_factory=list, repr=False)

    def load(self) -> "SupportStore":
        self._users = {str(user["id"]): user for user in _load(self.data_dir / "users.json")}
        tickets = _load(self.data_dir / "tickets.json")
        self._tickets = {str(ticket["id"]): ticket for ticket in tickets}
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
        """Записать сообщение в тикет: только в режиме не-readonly."""
        if self.readonly:
            raise SupportError("запись отключена: сервер запущен в режиме только чтения")
        body = str(text).strip()
        if not body:
            raise SupportError("пустой комментарий")
        ticket = self._require(ticket_id)
        ticket.setdefault("messages", []).append({"from": "support", "text": body})
        self._tickets[ticket_id] = ticket
        path = self.data_dir / "tickets.json"
        payload = [self._tickets[ticket_id] for ticket_id in self._order]
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
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
