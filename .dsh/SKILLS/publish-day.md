# Скилл: publish-day (команда `/publish-day`)

Публикация рабочего дня в GitHub: **коммит → push → PR (day → week)** с описанием изменений.

Исполняется командой `dsh-term /publish-day` (детерминированный макрос на git/gh) — или вручную по шагам, если просишь без команды.

## Предусловия

- Мы внутри репозитория `ai-challenge` (workspace dsh-term = корень репо).
- Текущая ветка — дня: `weekN/dayM` (например `week1/day1`). Если нет — команда показывает ветки дней и просит переключиться.
- `git` и `gh` доступны; `gh auth status` ок (иначе: `gh auth login` — делает пользователь).
- Remote origin — HTTPS (не SSH).

## Шаги

### 1. Проверка состояния
```powershell
git branch --show-current        # должна быть weekN/dayM
git status --porcelain           # что изменилось
git diff --stat HEAD             # объём изменений
```
- Нет изменений → стоп («рабочее дерево чистое»), PR не создаём.

### 2. Коммит — осмысленное описание
- Стейджим всё (`git add -A`) — .gitignore уже защищает от мусора.
- Заголовок: `тип(область): краткое императивное описание` на русском.
  Типы: `feat` `fix` `docs` `refactor` `test` `chore` `build` `perf`. Область: `dsh-term`, `skills`, `week1`, `gh`…
- Тело (если нужно): что и почему, ссылки.
```powershell
git add -A
git commit -m "feat(dsh-term): команда /publish-day и список команд по «/»"
```
- Плохо: `update`, `изменения`, `asd`. Один коммит = одна логическая единица.

### 3. Push в ветку дня
```powershell
git push -u origin week1/day1    # первый раз; дальше просто git push
```
- Force-push запрещён. Если push отклонён — fetch + разобраться.

### 4. PR day → week
База — ветка недели: из `week1/day1` → `feature/week1`. Если её нет локально/на origin — создать от `develop` (по модели веток) и повторить.
```powershell
gh pr create --base feature/week1 --head week1/day1 `
  --title "docs(week1/day1): краткое описание" `
  --body "…"
```

### 5. Описание PR — шаблон
```text
## Что сделано
- файлы/изменения по пунктам (команда собирает из git diff --stat)

## Зачем
- какую привычку/задачу закрывает

## Как проверить
- шаги проверки (если применимо)

## Заметки
- неочевидное: патчи, переносы, внешние изменения
```
Команда формирует черновик автоматически (файлы + коммит); заголовок берёт из subject коммита.

## После публикации
- Отчитаться: что закоммичено, куда запушено, **ссылка на PR**.
- Merge — только по явной команде пользователя: `gh pr merge <номер> --squash` (по умолчанию) или `--merge`.

## Ошибки — как действовать
| Симптом | Действие |
|---|---|
| `Permission denied (publickey)` | remote на SSH → `git remote set-url origin https://github.com/Vladislav-Zyuzko/ai-challenge.git` |
| `not logged in` | `gh auth login` (пользователь) |
| PR уже есть для ветки | показать ссылку на существующий (`gh pr list --head <day>`) |
| `feature/weekN` нет | создать от `develop`, запушить, повторить |
