"""Проект как корпус и как источник живого контекста (день 31).

Ассистент разработчика отвечает на вопросы о проекте, а не о внешней базе знаний.
Для этого нужны две разные вещи, и обе живут здесь:

1. **Документация проекта в RAG** — README, `docs`, отчёты по дням, правила и скиллы.
   Индексируется тем же пайплайном, что и хранилище Obsidian, но корпус устроен иначе:
   внутри репозитория рядом с документами лежат `node_modules`, `.venv`, артефакты
   моделей и папки с точкой, а часть скрытых папок (`.dsh/SKILLS`, `.dsh/.harness`) —
   это как раз документация проекта. Поэтому правила корпуса заданы здесь, а не
   выведены из структуры каталогов.

2. **Живой контекст из git** — какая ветка выкачана, что изменено, что в diff.
   Это принципиально не то же самое, что удалённый репозиторий на GitHub: там видны
   ветки и PR, но не рабочее дерево. Текущая ветка и незакоммиченные правки известны
   только локальному git, поэтому читаем его.

Функции git отдают данные как словари, а не как текст: их используют и MCP-инструменты
(агенту), и строгая справка `brief --repo` (мимо агента). Формат ответа решает потребитель.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from .config import Config

# Каталоги репозитория, которых в корпусе быть не должно. Список шире, чем для
# хранилища Obsidian: здесь это ещё и чужие зависимости, окружения и артефакты.
PROJECT_EXCLUDES = (
    ".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache",
    "out", "models", ".dsh-scratch", "dist", "build", ".mypy_cache", ".ruff_cache",
    "project-index",
)
# Документация проекта, которая лежит в скрытых каталогах.
PROJECT_ALLOW = (".dsh/SKILLS", ".dsh/.harness")

# Что считаем документацией. Код в корпус не идёт: отчёты и README описывают проект
# словами, а поиск по исходникам отвечает на другие вопросы и добавляет шума.
PROJECT_SUFFIXES = (".md",)


def docs_config(repo: Path, out: Path | None = None) -> Config:
    """Настройки корпуса «документация проекта» для указанного репозитория."""
    repo = Path(repo).expanduser().resolve()
    return Config(
        vault=repo,
        out=(Path(out) if out else repo / "project-index" / "out").expanduser(),
        exclude_dirs=PROJECT_EXCLUDES,
        allow_dirs=PROJECT_ALLOW,
        suffixes=PROJECT_SUFFIXES,
    )


class RepoError(RuntimeError):
    """Понятная ошибка вместо стектрейса из subprocess."""


def _git(repo: Path, *args: str, timeout: float = 30.0, strip: bool = True) -> str:
    """Выполнить read-only подкоманду git в репозитории.

    Белый список подкоманд, а не «любой git»: инструмент уходит агенту, и превращать
    его в универсальный исполнитель нельзя. `git` вызывается списком аргументов, без
    оболочки, поэтому ни пробелы в путях, ни подстановки не превращаются в команды.

    `strip=False` нужен там, где важен первый символ: в `git status --porcelain` это
    статус рабочего дерева, и обычная очистка строки съедает его вместе с ведущим
    пробелом — тогда путь разбирается со сдвигом на символ.
    """
    allowed = {"rev-parse", "status", "diff", "log", "branch", "show", "ls-files"}
    if not args or args[0] not in allowed:
        raise RepoError(f"подкоманда git не разрешена: {' '.join(args) or '(пусто)'}")
    repo = Path(repo).expanduser().resolve()
    if not (repo / ".git").exists():
        raise RepoError(f"не похоже на git-репозиторий: {repo}")
    try:
        done = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout)
    except FileNotFoundError as exc:
        raise RepoError("git не найден в PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise RepoError(f"git {args[0]} не ответил за {timeout:.0f} с") from exc
    if done.returncode != 0:
        message = (done.stderr or done.stdout).strip().splitlines()
        raise RepoError(f"git {args[0]}: {message[0] if message else 'ошибка'}")
    return done.stdout.strip() if strip else done.stdout


def git_branch(repo: Path) -> dict:
    """Текущая ветка и HEAD. Минимум задания: ассистент должен знать, где он работает."""
    name = _git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    head = _git(repo, "rev-parse", "--short", "HEAD")
    subject = _git(repo, "log", "-1", "--pretty=%s")
    when = _git(repo, "log", "-1", "--pretty=%cI")
    return {"branch": name, "head": head, "subject": subject, "committed_at": when,
            "detached": name == "HEAD"}


def git_status(repo: Path) -> dict:
    """Что изменено в рабочем дереве: списком, по одному файлу на строку.

    Формат `-z` (разделитель — нулевой байт) выбран не для краткости: в обычном
    выводе git берёт пути в кавычки и экранирует не-ASCII (`"\\320\\275..."`), а
    с `-z` этого не делает вовсе. Для репозитория с русскими именами файлов это
    разница между читаемым списком и мусором.
    """
    raw = _git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all", strip=False)
    entries = [entry for entry in raw.split("\0") if entry]
    changed: list[dict] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        code = entry[:2]
        path = entry[3:] if len(entry) > 3 else entry.strip()
        # У переименования и копирования вторым элементом идёт исходный путь.
        if code[:1] in ("R", "C") and index + 1 < len(entries):
            path = f"{entries[index + 1]} → {path}"
            index += 1
        changed.append({"code": code.strip(), "path": path.strip()})
        index += 1
    return {"changed": changed, "count": len(changed)}


def git_diff(repo: Path, *, staged: bool = False, stat_only: bool = True,
             max_chars: int = 4000) -> dict:
    """Diff рабочего дерева. По умолчанию — только статистика.

    Полный diff в промпт не влезает и не нужен: ассистенту важно понять, что затронуто.
    Если полный всё же нужен, он обрезается по `max_chars`, чтобы одна команда не
    вытеснила из контекста всё остальное.
    """
    args = ["diff", "--stat"] if stat_only else ["diff"]
    if staged:
        args.append("--cached")
    text = _git(repo, *args)
    truncated = len(text) > max_chars
    return {"staged": staged, "stat_only": stat_only, "truncated": truncated,
            "text": text[:max_chars]}


def list_files(repo: Path, *, pattern: str = "", limit: int = 200) -> dict:
    """Список файлов репозитория, которые видит git (то есть без мусора из .gitignore).

    `ls-files` вместо обхода каталогов: он уважает `.gitignore` и не показывает
    `node_modules` и `out/`, которые в проект не входят.
    """
    raw = _git(repo, "ls-files", "-z", strip=False)
    files = [line.strip() for line in raw.split("\0") if line.strip()]
    if pattern:
        needle = pattern.lower()
        files = [path for path in files if needle in path.lower()]
    return {"total": len(files), "shown": min(limit, len(files)), "files": files[:limit]}


def context_block(repo: Path, *, limit_files: int = 12) -> str:
    """Готовый блок «живой контекст проекта» для промпта строгой справки.

    Собирается кодом, а не моделью: ассистент не должен угадывать ветку и список
    изменённых файлов, он должен их получить. Если git недоступен, блок всё равно
    собирается — без выдуманных данных, но с честной пометкой.
    """
    repo = Path(repo).expanduser().resolve()
    lines = ["КОНТЕКСТ ПРОЕКТА (данные git, не из документации):"]
    try:
        branch = git_branch(repo)
        lines.append(f"- ветка: {branch['branch']} · HEAD {branch['head']} · {branch['subject']}")
        status = git_status(repo)
        if status["count"]:
            shown = status["changed"][:limit_files]
            lines.append(f"- изменено файлов: {status['count']}")
            for item in shown:
                lines.append(f"  - {item['code'] or '??'} {item['path']}")
            if status["count"] > len(shown):
                lines.append(f"  - … ещё {status['count'] - len(shown)}")
        else:
            lines.append("- рабочее дерево чистое")
    except RepoError as exc:
        lines.append(f"- git недоступен: {exc}")
    lines.append(f"- корень проекта: {repo}")
    return "\n".join(lines)
