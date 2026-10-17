"""Тесты сервера поддержки: хранилище и инструменты — без сети и без модели.

MCP-часть проверяется через реестр инструментов SDK (как в `doc-index`): важно, что
инструменты зарегистрированы с правильными именами и что ошибки данных возвращаются
текстом, а не исключением — иначе агент увидит падение инструмента вместо причины.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from support_mcp.server import build_server, format_ticket, format_user  # noqa: E402
from support_mcp.store import SupportError, SupportStore  # noqa: E402

DATA = HERE / "data"


def make_store(readonly: bool = True, data_dir: Path | None = None) -> SupportStore:
    return SupportStore(data_dir=data_dir or DATA, readonly=readonly).load()


class StoreTest(unittest.TestCase):
    def test_loads_fixtures(self):
        store = make_store()
        tickets = store.tickets()
        self.assertEqual(len(tickets), 6)
        self.assertEqual(sum(1 for t in tickets if t["status"] == "open"), 5)

    def test_status_filter(self):
        store = make_store()
        self.assertEqual([t["id"] for t in store.tickets("open")], ["T-1042", "T-1051", "T-1058", "T-1063", "T-1077"])
        self.assertEqual([t["id"] for t in store.tickets("closed")], ["T-1070"])

    def test_ticket_has_user_and_messages(self):
        ticket = make_store().ticket("T-1042")
        self.assertEqual(ticket["user"]["name"], "Ирина Соколова")
        self.assertEqual(ticket["user"]["plan"], "team")
        self.assertGreaterEqual(len(ticket["messages"]), 2)
        self.assertTrue(any("4000" in m["text"] for m in ticket["messages"]))

    def test_unknown_ticket_is_explained(self):
        with self.assertRaises(SupportError) as ctx:
            make_store().ticket("T-9999")
        self.assertIn("тикет не найден", str(ctx.exception))
        self.assertIn("T-1042", str(ctx.exception))

    def test_user_by_id_email_and_name(self):
        store = make_store()
        self.assertEqual(store.user("u-101")["name"], "Ирина Соколова")
        self.assertEqual(store.user("p.dorohov@example.ru")["id"], "u-102")
        self.assertEqual(store.user("мария лебедева")["id"], "u-103")
        with self.assertRaises(SupportError):
            store.user("нет-такого")

    def test_find_by_tag_and_message(self):
        store = make_store()
        self.assertEqual([t["id"] for t in store.find("429")], ["T-1051"])
        self.assertEqual([t["id"] for t in store.find("api-key")], ["T-1042"])
        self.assertEqual([t["id"] for t in store.find("ревью")], ["T-1077"])
        self.assertEqual(store.find("курс доллара"), [])

    def test_empty_query_is_refused(self):
        with self.assertRaises(SupportError):
            make_store().find("   ")

    def test_write_is_disabled_by_default(self):
        with self.assertRaises(SupportError) as ctx:
            make_store().add_comment("T-1042", "итог")
        self.assertIn("только чтения", str(ctx.exception))

    def test_write_appends_message_to_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            shutil.copytree(DATA, data)
            store = make_store(readonly=False, data_dir=data)
            got = store.add_comment("T-1042", "итог разбора: убрать старую переменную")
            self.assertEqual(got["id"], "T-1042")
            saved = json.loads((data / "tickets.json").read_text(encoding="utf-8"))
            ticket = next(t for t in saved if t["id"] == "T-1042")
            self.assertEqual(ticket["messages"][-1]["from"], "support")
            self.assertIn("убрать старую переменную", ticket["messages"][-1]["text"])

    def test_written_message_has_timestamp(self):
        """Без `at` слепок обращения печатал бы «[] поддержка: текст» (PR #31)."""
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            shutil.copytree(DATA, data)
            store = make_store(readonly=False, data_dir=data)
            store.add_comment("T-1042", "проверка времени")
            saved = json.loads((data / "tickets.json").read_text(encoding="utf-8"))
            ticket = next(t for t in saved if t["id"] == "T-1042")
            at = ticket["messages"][-1].get("at", "")
            self.assertTrue(at, "у сообщения нет поля at")
            self.assertRegex(at, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")

    def test_write_is_atomic(self):
        """Временный файл не остаётся, а исходный JSON валиден после записи."""
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            shutil.copytree(DATA, data)
            store = make_store(readonly=False, data_dir=data)
            store.add_comment("T-1051", "атомарность")
            self.assertEqual([p.name for p in data.iterdir() if p.name.endswith(".tmp")], [])
            json.loads((data / "tickets.json").read_text(encoding="utf-8"))

    def test_record_without_id_is_explained(self):
        """Запись без `id` — SupportError, а не KeyError мимо обработчика."""
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            data.mkdir()
            (data / "users.json").write_text('[{"name": "без id"}]', encoding="utf-8")
            (data / "tickets.json").write_text("[]", encoding="utf-8")
            with self.assertRaises(SupportError) as ctx:
                make_store(data_dir=data)
            self.assertIn("без поля id", str(ctx.exception))
            self.assertIn("users.json", str(ctx.exception))

    def test_bad_data_dir_is_reported(self):
        with self.assertRaises(SupportError) as ctx:
            SupportStore(data_dir=Path(tempfile.gettempdir()) / "нет-такого-каталога").load()
        self.assertIn("нет файла данных", str(ctx.exception))


class FormatTest(unittest.TestCase):
    def test_ticket_text_has_user_and_messages(self):
        text = format_ticket(make_store().ticket("T-1042"))
        self.assertIn("Тикет T-1042", text)
        self.assertIn("Ирина Соколова", text)
        self.assertIn("тариф team", text)
        self.assertIn("переписка:", text)
        self.assertIn("пользователь", text)
        self.assertIn("4000", text)

    def test_user_text(self):
        text = format_user(make_store().user("u-104"))
        self.assertIn("Артём Ковалёв", text)
        self.assertIn("dsh-term: 0.9.4", text)


class ToolRegistryTest(unittest.TestCase):
    def names(self, server) -> list[str]:
        registry = getattr(getattr(server, "_tool_manager", None), "_tools", None)
        if not registry:
            self.skipTest("внутренний реестр инструментов недоступен в этой версии SDK")
        return sorted(registry)

    def test_readonly_tools(self):
        names = self.names(build_server(make_store(readonly=True)))
        self.assertEqual(names, ["support_find_tickets", "support_get_ticket",
                                 "support_get_user", "support_list_tickets"])

    def test_write_tool_appears_in_readwrite(self):
        names = self.names(build_server(make_store(readonly=False)))
        self.assertIn("support_add_comment", names)

    def test_tools_return_text_on_errors(self):
        server = build_server(make_store())
        registry = getattr(getattr(server, "_tool_manager", None), "_tools", None)
        if not registry:
            self.skipTest("внутренний реестр инструментов недоступен в этой версии SDK")
        text = registry["support_get_ticket"].fn(ticket_id="T-9999")
        self.assertIn("Тикет недоступен", text)
        self.assertIn("T-1042", text)


if __name__ == "__main__":
    unittest.main()
