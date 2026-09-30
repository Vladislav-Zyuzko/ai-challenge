"""Тесты поиска: FTS-запрос, слияние RRF и выдача с метаданными — без Ollama.

Эмбеддер подменён детерминированным «мешком слов»: тест проверяет пайплайн поиска
(индекс → каналы → слияние → метаданные), а не качество конкретной модели.
"""
import re
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from doc_index import store  # noqa: E402
from doc_index.chunk import Chunk  # noqa: E402
from doc_index.config import Config  # noqa: E402
from doc_index.search import Searcher, fts_query, lexical_search, rrf  # noqa: E402

DIM = 256


class FakeEmbedder:
    """Вектор = мешок слов, хешированный в DIM измерений (crc32 вместо hash — стабильно)."""

    def embed(self, texts: list[str]) -> np.ndarray:
        rows = []
        for text in texts:
            vec = np.zeros(DIM, dtype="float32")
            for token in re.findall(r"\w+", text.lower()):
                vec[zlib.crc32(token.encode()) % DIM] += 1.0
            norm = float(np.linalg.norm(vec)) or 1.0
            rows.append(vec / norm)
        return np.asarray(rows, dtype="float32")


def make_chunk(index: int, source: str, section: str, text: str) -> Chunk:
    return Chunk(
        chunk_id=f"structural:{source}#{index:04d}",
        strategy="structural",
        source=source,
        file=Path(source).name,
        title="Карточка",
        section=section,
        breadcrumb=f"Понятия › Карточка › {section}",
        folder="20_Понятия",
        folder_label="Понятия",
        tags=["ai-sdlc"],
        text=text,
        embed_text=text,
    )


CHUNKS = [
    make_chunk(0, "20_Понятия/11_Агентный_харнесс.md", "Определение",
               "Агентный харнесс организует цикл агента и управляет контекстом."),
    make_chunk(0, "20_Понятия/61_Промпт_инъекция.md", "Определение",
               "Промпт-инъекция — это попытка подменить инструкции через данные."),
    make_chunk(0, "20_Понятия/79_Канареечное_развёртывание.md", "Определение",
               "Канареечное развёртывание выпускает изменение на малую долю пользователей."),
]


class SearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.cfg = Config(vault=root, out=root / "out")
        cls.cfg.ensure_out()
        cls.conn = store.connect(cls.cfg.db_path())
        store.save_chunks(cls.conn, CHUNKS)
        vectors = FakeEmbedder().embed([c.text for c in CHUNKS])
        store.save_embeddings(cls.conn, "structural", cls.cfg.model, [c.chunk_id for c in CHUNKS], vectors)
        store.write_faiss(cls.cfg.faiss_path("structural"), vectors)
        cls.searcher = Searcher(cls.conn, cls.cfg, FakeEmbedder(), "structural")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.conn.close()
        cls.tmp.cleanup()

    def test_fts_запрос_строится_из_слов(self) -> None:
        query = fts_query("Что такое промпт-инъекция?")
        self.assertIn('"промпт-инъекция"*', query)
        self.assertIn(" OR ", query)
        self.assertNotIn("что", query.split('"')[0] + "")  # стоп-слов нет, но цифры отброшены
        self.assertEqual(fts_query("123 456"), "")

    def test_лексический_канал_находит_по_термину(self) -> None:
        hits = lexical_search(self.conn, "structural", "канареечное", 5)
        self.assertTrue(hits)
        self.assertEqual(hits[0][0], CHUNKS[2].chunk_id)

    def test_слияние_поднимает_попадание_в_оба_канала(self) -> None:
        dense = [("a", 0.9), ("b", 0.8)]
        lexical = [("b", 5.0), ("c", 4.0)]
        fused = dict(rrf([dense, lexical]))
        self.assertGreater(fused["b"], fused["a"])
        self.assertGreater(fused["b"], fused["c"])

    def test_поиск_возвращает_метаданные_и_текст(self) -> None:
        query_vector = FakeEmbedder().embed(["промпт-инъекция инструкции данные"])
        hits = self.searcher.search("промпт-инъекция", k=3, mode="hybrid", query_vector=query_vector)
        self.assertTrue(hits)
        top = hits[0]
        self.assertEqual(top["source"], "20_Понятия/61_Промпт_инъекция.md")
        self.assertEqual(top["section"], "Определение")
        self.assertIn("Понятия", top["breadcrumb"])
        self.assertIn("text", top)
        self.assertEqual(top["rank"], 1)
        self.assertIsNotNone(top["dense_rank"])
        self.assertIsNotNone(top["lexical_rank"])

    def test_лексический_режим_работает_без_вектора(self) -> None:
        hits = self.searcher.search("харнесс", k=2, mode="lexical")
        self.assertTrue(hits)
        self.assertEqual(hits[0]["source"], "20_Понятия/11_Агентный_харнесс.md")
        self.assertIsNone(hits[0]["dense_rank"])

    def test_пустой_запрос_не_падает(self) -> None:
        self.assertEqual(lexical_search(self.conn, "structural", "!!!", 5), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
