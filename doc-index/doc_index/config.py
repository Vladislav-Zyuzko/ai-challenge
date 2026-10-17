"""Настройки пайплайна индексации: корпус, модель, параметры чанкинга, пути.

Всё в одном месте, потому что от этих чисел зависит сравнение стратегий:
менять размер окна между прогонами и потом сравнивать метрики нельзя.
"""
from dataclasses import dataclass
from pathlib import Path

# Корпус — хранилище Obsidian. Путь по умолчанию, переопределяется --vault.
DEFAULT_VAULT = Path(r"C:\Users\user\Desktop\apocrypha\effective-ai")
# Артефакты индекса и отчёты — рядом с кодом, а не в хранилище: хранилище не под git,
# и пайплайн не должен в него писать (только читать).
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "out"

# Служебные каталоги хранилища: в индекс не идут.
EXCLUDE_DIRS = (".obsidian", "_tools", ".trash", ".git", ".smart-env")


@dataclass(frozen=True)
class Config:
    vault: Path = DEFAULT_VAULT
    out: Path = DEFAULT_OUT
    model: str = "bge-m3"
    ollama_url: str = "http://127.0.0.1:11434"
    batch_size: int = 16
    request_timeout: float = 300.0

    # Стратегия 1: фиксированное окно (в символах, с перекрытием).
    fixed_size: int = 1000
    fixed_overlap: int = 150

    # Стратегия 2: по структуре заголовков.
    structural_max: int = 1200   # длинную секцию режем по абзацам
    structural_min: int = 200    # короткую секцию приклеиваем к соседней

    # --- Что вообще попадает в корпус -------------------------------------------
    # По умолчанию корпус — хранилище Obsidian: только markdown, а служебные папки
    # перечислены выше. Корпус проекта (день 31) устроен иначе: там есть node_modules,
    # .venv, артефакты моделей и папки с точкой, часть которых — документация. Поэтому
    # правила вынесены в настройки, а не зашиты в обход каталогов.
    exclude_dirs: tuple[str, ...] = EXCLUDE_DIRS
    suffixes: tuple[str, ...] = (".md",)
    # Отдельные файлы, которые не нужны в корпусе, хотя расширение подходит: lock-файлы
    # зависимостей дают десятки тысяч строк шума и ни одного смысла для поиска.
    exclude_names: tuple[str, ...] = ()
    # Скрытые каталоги пропускаются (в репозитории это `.git`, `.venv`, `.pytest_cache`),
    # но `.dsh/SKILLS` и `.dsh/.harness` — такая же документация проекта, и её можно
    # вернуть явным разрешением.
    allow_dirs: tuple[str, ...] = ()
    # Обратный случай: взять из репозитория только эти каталоги. Корпус поддержки
    # (день 33) — это FAQ продукта и его README, а не весь репозиторий.
    only_dirs: tuple[str, ...] = ()
    max_file_bytes: int = 2_000_000

    def db_path(self) -> Path:
        return self.out / "index.db"

    def faiss_path(self, strategy: str) -> Path:
        return self.out / f"index_{strategy}.faiss"

    def chunks_json(self, strategy: str) -> Path:
        return self.out / f"chunks_{strategy}.json"

    def ensure_out(self) -> Path:
        self.out.mkdir(parents=True, exist_ok=True)
        return self.out


def folder_label(folder: str) -> str:
    """`20_Понятия` → `Понятия`, `ai-gladkov/30_Понятия_1` → `ai-gladkov › Понятия 1`.

    Нужно для хлебных крошек: в них читаемый раздел, а не имя каталога с префиксом.
    Вложенные каталоги склеиваются через `›`, чтобы крошка читалась как путь.
    """
    crumbs: list[str] = []
    for part in folder.split("/"):
        if not part:
            continue
        bits = part.split("_", 1)
        tail = bits[1] if len(bits) == 2 and bits[0].isdigit() else part
        crumbs.append(tail.replace("_", " ").strip())
    return " › ".join(crumbs)
