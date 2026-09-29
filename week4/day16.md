# MCP: подключение GitHub-сервера к dsh-term

Задание: установить MCP SDK/клиент (или поднять MCP-сервер), написать минимальный код,
который **устанавливает MCP-соединение** и **получает список доступных инструментов**, и
проверить, что соединение устанавливается, а список возвращается корректно.

Сделано иначе, чем «скрипт на SDK в сторонке»: MCP подключён **к самому dsh-term**, а
минимальный клиент живёт внутри него как диагностический режим `--mcp-check`. Так задание
закрывается не учебным огрызком, а рабочей возможностью: сервер подключён, инструменты
видны модели, а их список и цена показываются в UI обёртки.

## 1. Что именно подключено

| | |
|---|---|
| Сервер | официальный **GitHub MCP** (remote, Streamable HTTP): `https://api.githubcopilot.com/mcp/` |
| Кто клиент | мост харнесса `@deepseek-ai/dsh-mcp-client` (в установке 0.1.5 уже есть, в профиле `sdk` по умолчанию **не смонтирован**) |
| Транспорт | `streamable-http` (альтернатива — `stdio`, тогда сервер запускается как дочерний процесс) |
| Авторизация | `Authorization: Bearer …`; токен берётся из `gh auth token` (у нас CLI авторизован) |
| Режим по умолчанию | `readonly` + тулсеты `context,repos,issues,pull_requests` → **25 инструментов** |
| Полный набор | `--mcp-toolsets all --mcp-readwrite` → **45 инструментов** |
| Имена инструментов у модели | `mcp__github__<tool>`, например `mcp__github__get_me` |

Схема пути:

```
dsh-term  ──(пишет оверлей)──▶  dsh-term-mcp.patch.yml
   │                                   │  --patch
   │  GITHUB_MCP_TOKEN в env           ▼
   └────────────────────────▶  рантайм харнесса
                                 └─ плагин dsh-mcp-client ──HTTP──▶ api.githubcopilot.com/mcp/
                                        └─ регистрирует инструменты на ctx.tools
                                              └─ модель видит mcp__github__<tool>
```

Оверлей, который пишет dsh-term:

```yaml
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: streamable-http
        url: https://api.githubcopilot.com/mcp/
        headers:
          Authorization: !!js '`Bearer ${process.env.GITHUB_MCP_TOKEN}`'
          'X-MCP-Readonly': 'true'
          'X-MCP-Toolsets': 'context,repos,issues,pull_requests'
```

Две неочевидные детали:

- **секрета в файле нет** — `Authorization` это выражение `!!js`, которое загрузчик харнесса
  исполняет при активации строки, а сам токен dsh-term кладёт в окружение рантайма только на
  время процесса. Рядом с оверлеем не появляется ни одного файла с токеном;
- **`insert` не идемпотентен**: повторная вставка того же `id` валит дерево плагинов
  («duplicate loader entry id»), поэтому перед подключением проверяется пользовательский
  слой профиля (`profiles/<профиль>/cordis.patch.yml`) и при наличии строки оверлей не
  добавляется.

## 2. Минимальный клиент: соединение + список инструментов

`dsh-term --mcp-check github` — это и есть требуемый минимальный код: он делает
`initialize` → `notifications/initialized` → `tools/list` и печатает результат. Ни сессии,
ни модели, ни ключа DeepSeek для этого не нужно. Реализация — `mcpProbe()` в
`dsh-term/dsh-term.mjs` (~60 строк: JSON-RPC поверх Streamable HTTP, ответ разбирается и
как JSON, и как SSE-поток).

Фактический вывод (сеть, живой сервер):

```
$ node dsh-term.mjs --mcp-check github
mcp-check github
  режим: readonly, toolsets=context,repos,issues,pull_requests
  оверлей (уходит в рантайм через --patch, секретов в файле нет):
    - insert:
        - id: mcp-github
          name: '@deepseek-ai/dsh-mcp-client'
          config:
            serverName: github
            transport: streamable-http
            url: https://api.githubcopilot.com/mcp/
            headers:
              Authorization: !!js '`Bearer ${process.env.GITHUB_MCP_TOKEN}`'
              'X-MCP-Readonly': 'true'
              'X-MCP-Toolsets': 'context,repos,issues,pull_requests'

  подключаюсь к https://api.githubcopilot.com/mcp/ …
  соединение установлено (github-mcp-server · protocol OK · 1982 мс), инструментов: 25
  сырые описания и схемы: 65301 символов ≈ 16.3k токенов
  ожидаемая добавка к промпту: ≈ 7.5k токенов на каждый запрос
  (харнесс регистрирует инструменты компактнее сырых схем; точную цифру даёт context: в сессии)
```

Список инструментов, который вернул сервер (25, звёздочкой — обязательные аргументы):

| Инструмент | Что делает |
|---|---|
| `get_me()` | профиль авторизованного пользователя |
| `get_commit(detail, owner*, page, perPage, repo*, sha*)` | детали коммита |
| `list_commits(author, fields, owner*, page, path, perPage, repo*, sha, since, until)` | история коммитов с фильтрами |
| `get_file_contents(fields, owner*, path, ref, repo*, sha)` | содержимое файла или каталога |
| `list_branches(owner*, page, perPage, repo*)` | ветки |
| `list_tags(owner*, page, perPage, repo*)` | теги |
| `get_tag(owner*, repo*, tag*)` | конкретный тег |
| `list_releases(fields, owner*, page, perPage, repo*)` | релизы |
| `get_latest_release(owner*, repo*)` | последний релиз |
| `get_release_by_tag(owner*, repo*, tag*)` | релиз по тегу |
| `list_issues(after, direction, field_filters, fields, labels, orderBy, owner*, perPage, repo*, since, state)` | issues с фильтрами |
| `issue_read(issue_number*, method*, owner*, page, perPage, repo*)` | чтение issue (поля, комментарии, подписки) |
| `list_issue_fields(owner*, repo)` / `list_issue_types(owner*, repo)` | метаданные issues проекта |
| `list_pull_requests(base, direction, fields, head, owner*, page, perPage, repo*, sort, state)` | список PR |
| `pull_request_read(after, method*, owner*, page, perPage, pullNumber*, repo*)` | чтение PR (diff, файлы, ревью, комментарии) |
| `search_code(fields, order, page, perPage, query*, sort)` | поиск по коду |
| `search_commits(order, page, perPage, query*, sort)` | поиск по коммитам |
| `search_issues(fields, order, owner, page, perPage, query*, repo, sort)` | поиск issues |
| `search_pull_requests(fields, order, owner, page, perPage, query*, repo, sort)` | поиск PR |
| `search_repositories(minimal_output, order, page, perPage, query*, sort)` | поиск репозиториев |
| `get_label(name*, owner*, repo*)` | метка |
| `list_repository_collaborators(affiliation, owner*, page, perPage, repo*)` | коллабораторы |
| `get_teams(user)` / `get_team_members(org*, team_slug*)` | команды организации (тулсет `context`) |

Проверка «список возвращается корректно» — не только по количеству: имена и параметры выше
сняты **с самого сервера** (тем же `tools/list`), а не из документации; курсор пагинации
сервер не отдавал, то есть 25 инструментов пришли одной страницей.

## 3. Проверка на живой сессии

Запуск с сервером и просьбой вызвать инструмент:

```
$ node dsh-term.mjs --mcp github -p 'Вызови MCP-инструмент mcp__github__get_me и назови мой GitHub-логин одной строкой.'
Vladislav-Zyuzko
```

Диагностика того же прогона (stderr в one-shot):

```
mcp: включён github · readonly, toolsets=context,repos,issues,pull_requests · запрашиваю список инструментов…
  mcp: github · 25 tools · сырые схемы ≈ 16.3k tokens · readonly, toolsets=context,repos,issues,pull_requests · github-mcp-server · 1868 мс · инструменты видны как mcp__github__*
⛭ github/get_me
✔ done
```

То есть: оверлей применился, мост зарегистрировал инструменты, **модель вызвала MCP-инструмент
и получила результат** (логин — из GitHub API, не выдуман). В UI вызов нарисован компактно
(`⛭ github/get_me`) — префикс `mcp__` не засоряет транскрипт.

В интерактивной сессии то же видно командами:

```
/mcp         — что подключено, режим, url, цена, имена инструментов
/mcp tools   — полный список инструментов с описаниями (mcp__github__<tool>(аргументы))
/mcp refresh — переподключиться и пересчитать
```

## 4. Цена в промпте (замеры, а не оценка)

Описания и схемы MCP-инструментов уходят в **каждый** запрос сессии. Замер: один и тот же
тривиальный промпт, один и тот же workspace и модель, менялся только набор MCP.

| Режим | Инструментов | Сырые схемы сервера | `context:` в сессии | Добавка к промпту |
|---|---|---|---|---|
| без MCP | — | — | 7.9k | — |
| `readonly` + 4 тулсета (default) | 25 | ≈16.3k | **15.4k** | **+7.5k** |
| `readonly` + `all` | 27 | ≈17.9k | 16.0k | +8.1k |
| `readwrite` + `all` | 45 | ≈31k | **21.6k** | **+13.7k** |

Два вывода, которые стоит держать в голове:

- **сырые дескрипторы ≠ то, что попадает в промпт**: харнесс регистрирует инструменты в
  своей канонической форме (без `title`, `annotations`, `$schema` и служебных полей),
  поэтому реальная добавка почти вдвое меньше веса JSON-описаний сервера (16.3k → 7.5k).
  В коде это учтено коэффициентом `MCP_REGISTERED_RATIO = 0.46` (он и даёт в `/context`
  строку `fixed prefix: ≈ 15.5k tokens (system prompt + tools + 7.5k MCP)`, что совпадает
  с замером 15.4k);
- цена платится **всегда**, независимо от того, трогали ли мы GitHub в этом запросе. При
  этом фиксированный префикс кэшируется (в замере `in 15.4k (cache 15.1k)`), но смена
  профиля пользователя перезапускает рантайм и кэш префикса инвалидируется — это довод
  включать MCP флагом на нужную сессию, а не держать всегда.

`/context` теперь считает неподвижный префикс честно — с учётом MCP:
`fixed prefix: ≈ 15.5k tokens (system prompt + tools + 7.5k MCP) — не сжимается`, и
замечания компакции (`compressNotes`) тоже учитывают добавку.

## 5. Что сделано в коде

| Файл | Что |
|---|---|
| `dsh-term/dsh-term.mjs` | пресеты MCP, разбор флагов, сборка оверлея с `!!js`, guard от дубля `insert`, зонд `tools/list`, режим `--mcp-check`, команда `/mcp`, стартовая диагностика, рендер `⛭ <сервер>/<тул>`, учёт MCP в `/context` и заметках компакции |
| `dsh-term/tests/mcp.test.mjs` | 14 проверок без сети: форма оверлея, `readonly`/тулсеты по умолчанию и их переключение, отсутствие секрета в файле, коды выхода `--mcp-check` |
| `dsh-term/README.md` | опции, раздел «MCP: внешние серверы инструментов (day16)», команда `/mcp`, строка в таблице тестов |

Флаги:

```
--mcp github                     подключить сервер (инструменты как mcp__github__*)
--mcp-toolsets context,repos,…   сузить набор (или all — полный)
--mcp-readwrite                  снять readonly (по умолчанию только чтение)
--mcp-check [preset]             соединение + список инструментов без сессии
--mcp-check github --offline     только собрать оверлей (без сети)
```

Как повторить:

```powershell
node dsh-term/dsh-term.mjs --mcp-check github          # соединение и список инструментов
node dsh-term/tests/mcp.test.mjs                       # оверлей, секреты, режимы (без сети)
node dsh-term/dsh-term.mjs --mcp github                # сессия с подключённым GitHub MCP
#   в сессии: /mcp, /mcp tools, /context
```

## 6. Ограничения и что осталось

- Подключён **один** пресет (`github`) — остальные серверы добавляются записью в
  `MCP_PRESETS` (поле `serverName` + `url` + способ получить токен).
- Мост поддерживает **только инструменты**: ресурсы и промпты MCP (у GitHub-сервера они
  тоже есть) в модель не попадают — это ограничение `dsh-mcp-client`, а не dsh-term.
- Клиент моста объявляет `capabilities: {}`, поэтому инструменты, зависящие от
  roots/sampling/elicitation, у сервера не запрашиваются, а правила доступа
  (`X-MCP-Readonly`, тулсеты) задаются заголовками на каждом запросе.
- Сервер удалённый: без сети (или при истёкшем токене) инструменты не появятся, сессия при
  этом работает — в стартовой диагностике будет строка с ошибкой соединения.
- Сравнение MCP со связкой Skill + CLI — отдельная задача, здесь сознательно не делалось.

## 7. Итог по заданию

- Соединение устанавливается: `--mcp-check github` → `соединение установлено
  (github-mcp-server · 2224 мс)`.
- Список инструментов возвращается корректно: 25 инструментов с именами, аргументами и
  описаниями (таблица в §2), снято с сервера тем же методом `tools/list`.
- Соединение работает не только в диагностике: в живой сессии модель вызвала
  `mcp__github__get_me` и получила реальный логин, а UI показал вызов как `⛭ github/get_me`.
- Цена подключения измерена: +7.5k токенов на запрос в режиме по умолчанию, +13.7k в полном
  (`context:` 7.9k → 15.4k → 21.6k).
