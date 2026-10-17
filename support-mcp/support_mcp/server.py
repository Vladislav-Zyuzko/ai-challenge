"""MCP-сервер поддержки: тикеты и пользователи из JSON как инструменты агента.

Зачем MCP, а не «просто прочитать файл». Задание дня 33 требует подключить CRM **через MCP**,
и это же правильно архитектурно: данные обращений меняются, а инструменты дают агенту
единый способ их читать — тот же, что для Figma, GitHub или трекера задач. Сессия поддержки
(`/support` в dsh-term) поднимает этот сервер по stdio и получает инструменты
`mcp__support__*`.

Транспорт — stdio: сервер локальный, данные лежат рядом, сеть не нужна. Запуск:

    python -m support_mcp.server --data C:\\path\\to\\support-mcp\\data

По умолчанию сервер **только читает**: запись комментария включается флагом `--readwrite`,
потому что правка чужих обращений — действие, которое должно быть осознанным. Пресет
`--mcp support` в dsh-term этот флаг не передаёт, поэтому из сессии поддержки сервер всегда
read-only; для записи его запускают вручную:

    python -m support_mcp.server --readwrite
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .store import DEFAULT_DATA, SupportError, SupportStore

INSTRUCTIONS = (
    "Инструменты поддержки: список обращений, карточка тикета с перепиской, информация "
    "о пользователе и поиск по обращениям. Отвечай по данным инструментов, не выдумывай "
    "номера тикетов и детали переписки."
)


def new_server():
    """Сервер MCP, совместимый с обеими ветками SDK.

    В `mcp` 2.x класс называется `MCPServer`, в 1.x — `FastMCP`; набор методов совпадает.
    Тот же шим, что в `doc-index/doc_index/mcp_server.py`: пакет в окружении уже менялся,
    и сервер не должен падать из-за этого — иначе агент молча останется без инструментов.
    """
    try:
        from mcp.server.mcpserver import MCPServer  # mcp 2.x
        return MCPServer(name="support", title="Поддержка: тикеты и пользователи",
                         instructions=INSTRUCTIONS)
    except ModuleNotFoundError:
        from mcp.server.fastmcp import FastMCP  # mcp 1.x
        return FastMCP(name="support", instructions=INSTRUCTIONS)


def format_ticket(ticket: dict) -> str:
    """Карточка тикета с перепиской — то, что агент читает как «контекст обращения»."""
    lines = [
        f"Тикет {ticket['id']} · {ticket['subject']}",
        f"компонент: {ticket.get('component') or '—'} · статус: {ticket.get('status')} · "
        f"создан: {ticket.get('created_at') or '—'}",
        f"теги: {', '.join(ticket.get('tags') or []) or '—'}",
    ]
    user = ticket.get("user") or {}
    if user:
        lines.append(f"пользователь: {user.get('name') or user.get('id')} "
                     f"(id {user.get('id')}, тариф {user.get('plan') or '—'}, "
                     f"{user.get('platform') or '—'}, dsh-term {user.get('dsh_term_version') or '—'})")
        if user.get("notes"):
            lines.append(f"о пользователе: {user['notes']}")
    lines.append("")
    lines.append("переписка:")
    for message in ticket.get("messages") or []:
        who = "пользователь" if message.get("from") == "user" else "поддержка"
        when = f" ({message['at']})" if message.get("at") else ""
        lines.append(f"- {who}{when}: {message.get('text', '')}")
    if ticket.get("resolution"):
        lines.append("")
        lines.append(f"итог обращения: {ticket['resolution']}")
    return "\n".join(lines)


def format_list(tickets: list[dict]) -> str:
    if not tickets:
        return "обращений нет"
    lines = [f"обращений: {len(tickets)}"]
    for ticket in tickets:
        user = ticket.get("user") or {}
        lines.append(f"- {ticket['id']} · {ticket['status']} · {ticket['subject']} "
                     f"({ticket.get('component') or '—'}, {user.get('name') or user.get('id')})")
    return "\n".join(lines)


def format_user(user: dict) -> str:
    return "\n".join([
        f"пользователь {user.get('name')} (id {user.get('id')})",
        f"почта: {user.get('email')} · тариф: {user.get('plan')} · с {user.get('since') or '—'}",
        f"платформа: {user.get('platform') or '—'} · dsh-term: {user.get('dsh_term_version') or '—'}"
        f" · мест: {user.get('seats') or '—'}",
        f"заметки: {user.get('notes') or '—'}",
    ])


def build_server(store: SupportStore):
    """Сервер с инструментами поддержки. Импорт SDK внутри: модуль не обязателен."""
    server = new_server()

    @server.tool(description="Список обращений поддержки; status='open' — только открытые")
    def support_list_tickets(status: str = "") -> str:
        """Что сейчас в поддержке: номер, статус, тема, компонент и пользователь."""
        try:
            return format_list(store.tickets(status))
        except SupportError as exc:
            return f"Не удалось получить список: {exc}"

    @server.tool(description="Карточка обращения: тема, теги, пользователь и вся переписка")
    def support_get_ticket(ticket_id: str) -> str:
        """Полный контекст обращения — его читают перед ответом."""
        try:
            return format_ticket(store.ticket(ticket_id))
        except SupportError as exc:
            return f"Тикет недоступен: {exc}"

    @server.tool(description="Информация о пользователе по id, почте или имени")
    def support_get_user(key: str) -> str:
        """Тариф, платформа, версия продукта и заметки о пользователе."""
        try:
            return format_user(store.user(key))
        except SupportError as exc:
            return f"Пользователь не найден: {exc}"

    @server.tool(description="Поиск обращений по тексту: тема, теги, компонент, переписка")
    def support_find_tickets(query: str) -> str:
        """Найти обращения, похожие на описанную проблему."""
        try:
            return format_list(store.find(query))
        except SupportError as exc:
            return f"Поиск не удался: {exc}"

    if not store.readonly:
        @server.tool(description="Записать сообщение в обращение (только в режиме записи)")
        def support_add_comment(ticket_id: str, text: str) -> str:
            """Зафиксировать итог разбора в переписке тикета."""
            try:
                got = store.add_comment(ticket_id, text)
            except SupportError as exc:
                return f"Комментарий не записан: {exc}"
            return f"Комментарий записан в {got['id']}; сообщений стало {got['messages']}"

        @server.tool(description="Завести новое обращение из сообщения пользователя "
                                 "(номер присваивает поддержка)")
        def support_create_ticket(subject: str, message: str, user_id: str = "",
                                  component: str = "intake") -> str:
            """Первое обращение: тема, текст пользователя, кто он (пусто — гость)."""
            try:
                ticket = store.create_ticket(subject, message, user_id=user_id,
                                             component=component)
            except SupportError as exc:
                return f"Обращение не создано: {exc}"
            return format_ticket(ticket)

    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="support_mcp.server",
                                     description="MCP-сервер поддержки (JSON-тикеты)")
    parser.add_argument("--data", default=str(DEFAULT_DATA), help="каталог с users.json и tickets.json")
    parser.add_argument("--readwrite", action="store_true",
                        help="разрешить запись комментариев в тикеты")
    parser.add_argument("--check", action="store_true",
                        help="проверить данные и напечатать сводку, без запуска сервера")
    args = parser.parse_args(argv)

    store = SupportStore(data_dir=Path(args.data).expanduser(), readonly=not args.readwrite)
    try:
        store.load()
    except SupportError as exc:
        print(f"support: {exc}", file=sys.stderr, flush=True)
        return 2

    if args.check:
        tickets = store.tickets()
        print(json.dumps({"tickets": len(tickets), "open": sum(1 for t in tickets if t["status"] == "open"),
                          "readonly": store.readonly}, ensure_ascii=False), flush=True)
        return 0

    # Поток stdout занят протоколом, поэтому диагностика — в stderr.
    print(f"support: данных {args.data} · режим {'чтение' if store.readonly else 'чтение и запись'}",
          file=sys.stderr, flush=True)
    print(f"support: python {sys.executable} · {sys.version.split()[0]}", file=sys.stderr, flush=True)
    build_server(store).run("stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
