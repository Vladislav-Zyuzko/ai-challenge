"""Тесты дня 26: локальная модель (Ollama) как бэкенд и её проверка.

Сеть не нужна: HTTP-вызовы подменяются заглушками, проверяются адрес локального
эндпоинта, разбор ответа и структура отчёта проверки.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index import local_check  # noqa: E402
from doc_index.llm import LOCAL_MODEL, local_base_url, local_client  # noqa: E402


class LocalClientTests(unittest.TestCase):
    def test_base_url_appends_v1(self):
        self.assertEqual(local_base_url("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1")

    def test_base_url_keeps_existing_v1(self):
        self.assertEqual(local_base_url("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1")

    def test_base_url_strips_trailing_slash(self):
        self.assertEqual(local_base_url("http://host:1234/"), "http://host:1234/v1")

    def test_client_targets_ollama(self):
        client = local_client("qwen3:8b", root="http://127.0.0.1:11434")
        self.assertEqual(client.base_url, "http://127.0.0.1:11434/v1")
        self.assertEqual(client.model, "qwen3:8b")
        # Ключ фиктивный: Ollama его не проверяет, но маршрут pi-ai требует значение.
        self.assertEqual(client.api_key, "ollama")

    def test_client_has_long_timeout_for_cpu(self):
        self.assertGreaterEqual(local_client(LOCAL_MODEL).timeout, 300)

    def test_default_model_name(self):
        self.assertEqual(local_client().model, LOCAL_MODEL)


class TaskSetTests(unittest.TestCase):
    def test_three_tasks_of_different_kinds(self):
        """Задание требует минимум три запроса разной сложности."""
        self.assertEqual(len(local_check.TASKS), 3)
        kinds = {task["kind"] for task in local_check.TASKS}
        self.assertEqual(len(kinds), 3)
        ids = [task["id"] for task in local_check.TASKS]
        self.assertEqual(ids, ["simple", "medium", "hard"])

    def test_every_task_has_prompt_and_expectation(self):
        for task in local_check.TASKS:
            self.assertTrue(task["prompt"].strip())
            self.assertTrue(task["expect"].strip())

    def test_tool_schema_is_rag_search(self):
        """Схема инструмента — именно поиск по базе: им проверяется готовность к RAG."""
        name = local_check.TOOL_SCHEMA[0]["function"]["name"]
        self.assertEqual(name, "rag_search")


class ReportTests(unittest.TestCase):
    """Отчёт проверки собирается из ответов модели — без сети, на заглушках."""

    def setUp(self):
        self.originals = (local_check.chat, local_check.chat_openai, local_check.tool_probe,
                          local_check.list_models, local_check.health)

    def tearDown(self):
        (local_check.chat, local_check.chat_openai, local_check.tool_probe,
         local_check.list_models, local_check.health) = self.originals

    def _stub(self, *, tokens=10, seconds=2.0, tools=True, openai=True):
        local_check.list_models = lambda *a, **k: ["qwen3:8b", "bge-m3:latest"]
        local_check.health = lambda *a, **k: "0.40.1"

        def fake_chat(model, prompt, **kwargs):
            return f"ответ на «{prompt[:20]}»", {"_client_seconds": seconds,
                                                "eval_count": tokens, "prompt_eval_count": 5}

        local_check.chat = fake_chat
        local_check.chat_openai = (lambda *a, **k: ("эмбеддинг — вектор", 1.0)) if openai \
            else (lambda *a, **k: (_ for _ in ()).throw(RuntimeError("нет соединения")))
        local_check.tool_probe = (lambda *a, **k: ([{"function": {"name": "rag_search"}}], 3.0, "")) \
            if tools else (lambda *a, **k: ([], 3.0, "не буду"))

    def test_report_counts_tasks_and_speed(self):
        self._stub(tokens=20, seconds=4.0)
        report = local_check.run_checks("qwen3:8b", verbose=False)
        summary = local_check.summarize(report)
        self.assertEqual(summary["tasks_ok"], 3)
        self.assertEqual(summary["tokens_total"], 60)
        self.assertEqual(summary["tokens_per_second_avg"], 5.0)
        self.assertTrue(summary["openai_ok"])
        self.assertTrue(summary["tool_ok"])

    def test_missing_tool_call_is_reported(self):
        self._stub(tools=False)
        report = local_check.run_checks("qwen3:8b", verbose=False)
        self.assertFalse(local_check.summarize(report)["tool_ok"])

    def test_openai_endpoint_failure_is_collected(self):
        self._stub(openai=False)
        report = local_check.run_checks("qwen3:8b", verbose=False)
        summary = local_check.summarize(report)
        self.assertFalse(summary["openai_ok"])
        self.assertTrue(any("openai" in err for err in summary["errors"]))

    def test_task_error_does_not_break_report(self):
        self._stub()

        def flaky_chat(model, prompt, **kwargs):
            if "rrf" in prompt:
                raise RuntimeError("timeout")
            return "ок", {"_client_seconds": 1.0, "eval_count": 5, "prompt_eval_count": 1}

        local_check.chat = flaky_chat
        report = local_check.run_checks("qwen3:8b", verbose=False)
        summary = local_check.summarize(report)
        self.assertEqual(summary["tasks_ok"], 2)
        self.assertEqual(summary["tasks_total"], 3)
        self.assertTrue(any("hard" in err for err in summary["errors"]))

    def test_report_is_json_serializable(self):
        self._stub()
        from dataclasses import asdict
        import json
        report = local_check.run_checks("qwen3:8b", verbose=False)
        text = json.dumps({"summary": local_check.summarize(report), "report": asdict(report)},
                          ensure_ascii=False)
        self.assertIn("qwen3:8b", text)


if __name__ == "__main__":
    unittest.main()
