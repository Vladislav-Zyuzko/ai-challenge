"""Тесты дня 29: оптимизация локальной модели — без обращения к живой модели.

Проверяется то, что можно проверить без Ollama: состав профилей (каждый шаг меняет
ровно одно), Modelfile, сборка запроса, разбор таймингов, формула качества и отчёт.
Сами прогоны модели живые и медленные — они в отчёте дня, а не в юнит-тестах.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from doc_index.llm import LlmClient, local_client
from doc_index.optimize import (
    BASE_MODEL,
    BASE_MODEL_Q8,
    DEFAULT_QUESTION_IDS,
    OPTIMIZED_MODEL,
    OPTIMIZED_MODEL_Q8,
    OPTIMIZED_OPTIONS,
    PROFILES,
    RAG_SYSTEM,
    chat_payload,
    compact_prompt,
    compare,
    load_questions,
    modelfile,
    score_rows,
    timings,
    write_report,
)


class ProfileTest(unittest.TestCase):
    def test_ids_unique(self):
        ids = [p.id for p in PROFILES]
        self.assertEqual(len(ids), len(set(ids)))

    def test_one_change_per_step(self):
        """Каждый следующий профиль отличается от предыдущего одним рычагом."""
        baseline, params, template, quant = PROFILES
        self.assertEqual(baseline.options, {})
        self.assertEqual(baseline.prompt, "full")
        # шаг «параметры»: только опции
        self.assertEqual(params.model, baseline.model)
        self.assertEqual(params.prompt, baseline.prompt)
        self.assertNotEqual(params.options, baseline.options)
        # шаг «шаблон»: только промпт и модель, опции те же
        self.assertEqual(template.options, params.options)
        self.assertNotEqual(template.prompt, params.prompt)
        self.assertNotEqual(template.model, params.model)
        # шаг «квантование»: только веса
        self.assertEqual(quant.options, template.options)
        self.assertEqual(quant.prompt, template.prompt)
        self.assertNotEqual(quant.model, template.model)

    def test_quantization_step_uses_q8(self):
        """Шаг квантования — тот же шаблон, но модель собрана из весов Q8_0."""
        self.assertEqual(PROFILES[3].model, OPTIMIZED_MODEL_Q8)
        self.assertEqual(PROFILES[0].model, BASE_MODEL)
        self.assertEqual(PROFILES[2].model, OPTIMIZED_MODEL)
        self.assertIn(f"FROM {BASE_MODEL_Q8}", modelfile(BASE_MODEL_Q8))

    def test_default_questions_have_unanswerable(self):
        items = load_questions(Path("data/control-questions.yaml"), DEFAULT_QUESTION_IDS)
        self.assertEqual(len(items), 4)
        self.assertEqual(sum(1 for i in items if not i.get("answerable", True)), 1)

    def test_unknown_question_raises(self):
        with self.assertRaises(KeyError):
            load_questions(Path("data/control-questions.yaml"), ("нет-такого",))


class ModelfileTest(unittest.TestCase):
    def test_contains_base_system_and_params(self):
        text = modelfile(BASE_MODEL)
        self.assertIn(f"FROM {BASE_MODEL}", text)
        self.assertIn(RAG_SYSTEM.splitlines()[0], text)
        for key, value in OPTIMIZED_OPTIONS.items():
            self.assertIn(f"PARAMETER {key} {value}", text)

    def test_does_not_touch_chat_template(self):
        """Шаблон чата не переопределяем: от него зависит разметка ролей."""
        self.assertNotIn("TEMPLATE", modelfile(BASE_MODEL))

    def test_contract_has_required_marks(self):
        for mark in ("ОТВЕТ:", "ИСТОЧНИКИ:", "ЦИТАТЫ:", "Не знаю"):
            self.assertIn(mark, RAG_SYSTEM)


class PromptTest(unittest.TestCase):
    HITS = [{"chunk_id": "abc#0001", "source": "20_Понятия/11_Агентный_харнесс.md",
             "note": "Агентный харнесс", "section": "Определение", "text": "Харнесс — это …",
             "breadcrumb": "Понятия", "start_line": 1, "end_line": 3, "rank": 1}]

    def test_compact_prompt_has_context_and_question(self):
        prompt = compact_prompt("Что такое харнесс?", self.HITS)
        self.assertIn("ФРАГМЕНТЫ БАЗЫ ЗНАНИЙ:", prompt)
        self.assertIn("abc#0001", prompt)
        self.assertIn("ВОПРОС: Что такое харнесс?", prompt)

    def test_compact_prompt_has_no_contract(self):
        """Контракт живёт в SYSTEM модели — в запросе его быть не должно, иначе
        экономии промпта нет и шаг «шаблон» ничего не проверяет."""
        prompt = compact_prompt("Что такое харнесс?", self.HITS)
        self.assertNotIn("ЦИТАТЫ:", prompt)
        self.assertNotIn("Правила: нумеруй источники", prompt)

    def test_compact_prompt_shorter_than_full(self):
        from doc_index.rag import build_prompt
        full = build_prompt("Что такое харнесс?", self.HITS, strict=True)
        self.assertLess(len(compact_prompt("Что такое харнесс?", self.HITS)), len(full))


class PayloadTest(unittest.TestCase):
    def test_options_and_think_passed(self):
        payload = chat_payload("m", "привет", options={"temperature": 0.0}, think=False)
        self.assertEqual(payload["options"], {"temperature": 0.0})
        self.assertFalse(payload["think"])
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["messages"], [{"role": "user", "content": "привет"}])

    def test_system_message_first(self):
        payload = chat_payload("m", "вопрос", system="контракт")
        self.assertEqual([m["role"] for m in payload["messages"]], ["system", "user"])

    def test_no_options_key_when_empty(self):
        self.assertNotIn("options", chat_payload("m", "вопрос"))


class TimingsTest(unittest.TestCase):
    def test_nanoseconds_to_seconds(self):
        data = {"prompt_eval_count": 1000, "prompt_eval_duration": 20_000_000_000,
                "eval_count": 100, "eval_duration": 20_000_000_000,
                "load_duration": 1_500_000_000, "total_duration": 45_000_000_000}
        got = timings(data)
        self.assertEqual(got["prefill_seconds"], 20.0)
        self.assertEqual(got["generate_seconds"], 20.0)
        self.assertEqual(got["prefill_tps"], 50.0)
        self.assertEqual(got["generate_tps"], 5.0)
        self.assertEqual(got["load_seconds"], 1.5)
        self.assertEqual(got["total_seconds"], 45.0)

    def test_empty_data_is_zero_not_crash(self):
        got = timings({})
        self.assertEqual(got["generate_tps"], 0.0)
        self.assertEqual(got["prompt_tokens"], 0)


def row(**kwargs) -> dict:
    base = {"id": "x", "answerable": True, "refused": False, "format_ok": True,
            "sources_total": 3, "sources_real": 3, "unknown_sources": [],
            "quotes_total": 3, "quotes_verbatim": 3, "fabricated_quotes": 0,
            "facts_covered": 4, "facts_total": 5, "error": ""}
    base.update(kwargs)
    return base


class ScoreTest(unittest.TestCase):
    def test_ideal_rows_give_quality_one(self):
        got = score_rows([row(facts_covered=5), row(id="y", facts_covered=5)])
        self.assertEqual(got["quality"], 1.0)
        self.assertEqual(got["fabricated_quotes"], 0)
        self.assertEqual(got["false_refusals"], 0)

    def test_paraphrase_lowers_quotes_share(self):
        good = score_rows([row(quotes_verbatim=3, quotes_total=3)])
        bad = score_rows([row(quotes_verbatim=1, quotes_total=3)])
        self.assertGreater(good["quality"], bad["quality"])
        self.assertEqual(bad["quotes_verbatim"], 0.333)

    def test_invented_source_is_counted(self):
        got = score_rows([row(sources_total=3, sources_real=2, unknown_sources=["fake#0009"])])
        self.assertEqual(got["fabricated_sources"], 1)
        self.assertEqual(got["sources_real"], 0.667)

    def test_broken_format_counted(self):
        got = score_rows([row(format_ok=False)])
        self.assertEqual(got["bad_format"], 1)
        self.assertLess(got["quality"], 1.0)

    def test_refusal_scored_separately(self):
        """Отказ не портит оценку качества ответов: у него нет цитат по замыслу."""
        rows = [row(facts_covered=5), row(id="r", answerable=False, refused=True)]
        got = score_rows(rows)
        self.assertEqual(got["quality"], 1.0)
        self.assertTrue(got["refusal_ok"])
        self.assertEqual(got["answered"], 1)

    def test_false_refusal_on_answerable_is_counted(self):
        got = score_rows([row(refused=True), row(id="r", answerable=False, refused=False)])
        self.assertEqual(got["false_refusals"], 1)
        self.assertFalse(got["refusal_ok"])

    def test_no_answerable_rows_does_not_crash(self):
        got = score_rows([row(answerable=False, refused=True)])
        self.assertEqual(got["quality"], 0.0)
        self.assertIsNone(got["format_ok"])


class ClientPayloadTest(unittest.TestCase):
    """Что день 29 изменил в клиенте: детерминированность и ограничение длины.

    Сети нет: `urlopen` подменяется, проверяется само тело запроса.
    """

    def _payload(self, client) -> dict:
        captured: dict = {}

        class FakeResponse:
            def read(self) -> bytes:
                return json.dumps({"choices": [{"message": {"content": "ок"},
                                                "finish_reason": "stop"}],
                                   "usage": {}}).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, *_exc) -> bool:
                return False

        def fake_urlopen(request, timeout=None):                  # noqa: ARG001
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse()

        with mock.patch("doc_index.llm.urllib.request.urlopen", fake_urlopen):
            client.ask("вопрос")
        return captured["payload"]

    def test_local_client_is_deterministic_and_bounded(self):
        payload = self._payload(local_client("qwen3:8b"))
        self.assertEqual(payload["temperature"], 0.0)
        self.assertEqual(payload["max_tokens"], 400)
        self.assertEqual(payload["reasoning_effort"], "none")

    def test_cloud_client_keeps_provider_defaults(self):
        payload = self._payload(LlmClient(model="deepseek-v4-flash", api_key="test",
                                         base_url="http://example.invalid"))
        self.assertNotIn("temperature", payload)
        self.assertNotIn("reasoning_effort", payload)

    def test_ollama_options_field_is_not_sent(self):
        """`options` этот эндпоинт молча игнорирует, поэтому `num_ctx` задаётся
        в модели. Отправлять поле значило бы имитировать настройку, которой нет."""
        self.assertNotIn("options", self._payload(local_client("rag-brief:8b")))

    def test_service_key_comes_from_environment(self):
        """Когда локальная модель стоит за сервисом (день 30), клиент обязан
        предъявить ключ; без сервиса остаётся фиктивный ключ Ollama."""
        with mock.patch.dict("os.environ", {"DSH_AI_SERVICE_KEY": "sk-service"}):
            self.assertEqual(local_client("rag-brief").api_key, "sk-service")
        with mock.patch.dict("os.environ", {"DSH_AI_SERVICE_KEY": "sk-service"}):
            # Явный аргумент важнее окружения.
            self.assertEqual(local_client("rag-brief", api_key="sk-explicit").api_key, "sk-explicit")
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(local_client("rag-brief").api_key, "ollama")


class ReportTest(unittest.TestCase):
    def profile(self, pid: str, model: str, *, quality: float, gbps: float) -> dict:
        return {
            "id": pid, "title": pid, "model": model, "options": {}, "prompt": "full",
            "note": "заметка", "errors": [], "rows": [],
            "quality": {"quality": quality, "format_ok": 1.0, "sources_real": 1.0,
                        "quotes_verbatim": 0.8, "facts_covered": 0.9, "fabricated_quotes": 0,
                        "refusals": 1, "refusals_expected": 1},
            "speed": {"prompt_tokens_avg": 1200, "prefill_tps_avg": 50.0,
                      "generate_tps_avg": gbps, "client_seconds_avg": 40.0,
                      "eval_tokens_total": 400},
            "memory": {"loaded": [], "model_gb": 5.2},
        }

    def test_report_files_and_content(self):
        result = compare([self.profile("baseline", "qwen3:8b", quality=0.7, gbps=6.0),
                          self.profile("quant", "rag-brief-q8:8b", quality=0.95, gbps=3.1)],
                         questions=4)
        with tempfile.TemporaryDirectory() as tmp:
            path = write_report(result, Path(tmp))
            text = path.read_text(encoding="utf-8")
            self.assertIn("Оптимизация локальной модели", text)
            self.assertIn("rag-brief-q8:8b", text)
            self.assertIn("Качество", text)
            self.assertIn("Скорость и ресурсы", text)
            # победитель выбирается по качеству, а не по скорости
            self.assertIn("**Выбор:** quant", text)
            saved = json.loads((Path(tmp) / "optimize.json").read_text(encoding="utf-8"))
            self.assertEqual(len(saved["profiles"]), 2)
            self.assertEqual(saved["questions"], 4)


if __name__ == "__main__":
    unittest.main()
