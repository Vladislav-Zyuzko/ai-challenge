# Скилл: publish-week (команда `/publish-week`)

Публикация итогов недели в GitHub: **сводка недели → PR (feature/weekN → develop)** с описанием проделанного за неделю.

Исполняется командой `dsh-term /publish-week` (детерминированный макрос на git/gh) — или вручную по шагам, если просишь без команды.

## Предусловия

- Мы внутри репозитория `ai-challenge` (workspace dsh-term = корень репо).
- Текущая ветка — недели: `feature/weekN` (например `feature/week1`). Если нет — команда показывает ветки недель и просит переключиться.
- Дневные PR недели (day → week) **смёржены в `feature/weekN`** — иначе сводка недели неполная.
- `git` и `gh` доступны; `gh auth status` ок. Remote origin — HTTPS (не SSH).

## Шаги

### 1. Проверка состояния
```powershell
git branch --show-current           # должна быть feature/weekN
git status --porcelain              # рабочее дерево: обычно чистое (неделя = merge дневных PR)
git fetch origin
git pull                            # синхронизировать feature/weekN с origin (туда мержились PR дней)
git log --oneline develop..feature/weekN          # коммиты недели
git diff --stat develop...feature/weekN           # объём изменений недели
gh pr list --head feature/weekN --state merged --json number,title   # дневные PR для сводки
```
- Незакоммиченные изменения на `feature/weekN` — редкость (неделя собирается из merge). Если есть: разобраться — дооформить как день (`/publish-day`) или оставить на следующую неделю; «как есть» в недельный PR не тащим.
- Рабочее дерево чистое → коммит не нужен (сводку недели несёт описание PR).

### 2. Сводка недели — что писать в PR
Собирается из merge-коммитов дней / списка дневных PR и `git diff --stat develop...feature/weekN`:
- по дням/областям: что сделано (инструменты, эксперименты, файлы);
- результаты и выводы недели (summary/result файлы экспериментов — ссылками);
- заголовок: `docs(weekN): итоги недели — <кратко>` (или `feat(weekN): …`, если неделя = одна фича).

### 3. Коммит (только если на ветке недели есть правки)
- Если правили сводку/README на самой `feature/weekN` — осмысленный коммит: `docs(skills): …` и т.п. Дерево чистое → пропускаем.

### 4. Push
```powershell
git push -u origin feature/week1    # обычно ветка уже на origin (после merge PR дней)
```
- Force-push запрещён. Push отклонён → fetch + разобраться.

### 5. PR week → develop
```powershell
gh pr create --base develop --head feature/week1 `
  --title "docs(week1): итоги недели — …" `
  --body "…"
```

### 6. Описание PR — шаблон (итоги недели)
```text
## Что сделано за неделю
- день 1 (PR #N): …
- день 2 (PR #M): …
- …

## Результаты и выводы
- итоги экспериментов/задач недели, ссылки на summary/result

## Как проверить
- шаги проверки (если применимо)

## Заметки
- неочевидное: внешние патчи, особенности окружения
```

## После публикации
- Отчитаться: что вошло в сводку, куда запушено, **ссылка на PR**.
- Merge в `develop` (и далее `develop → main`) — только по явной команде пользователя: `gh pr merge <номер> --squash` (по умолчанию) или `--merge`.

## Ошибки — как действовать
| Симптом | Действие |
|---|---|
| PR уже есть (feature/weekN → develop) | показать ссылку на существующий (`gh pr list --head feature/weekN --base develop`) |
| текущая ветка не `feature/weekN` | показать ветки недель (`git branch --list 'feature/week*'`), переключиться |
| `develop` нет локально/на origin | создать от `main` (по модели веток), запушить, повторить |
| дневные PR недели не смёржены | сначала `/publish-day` по дням и merge day PR, затем повторить `/publish-week` |
| `not logged in` | `gh auth login` (пользователь) |
