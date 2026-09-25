# sl-tracker-mcp

MCP-сервер вокруг API трекера задач **SL Tracker** (`https://github.com/Vladislav-Zyuzko/sl-tracker`).
Работает с любым MCP-клиентом: dsh-term, Claude Code, MCP Inspector, Claude Desktop (через stdio).
От dsh не зависит: только переменные окружения и стандартный протокол.

## Инструменты

| Инструмент | Что делает | Эндпоинт SL Tracker |
|---|---|---|
| `create_task` | создать задачу (заголовок, описание, статус, приоритет) | `POST /api/queues/{key}/issues` |
| `update_task_description` | заменить описание (пустая строка — очистить) | `PATCH /api/issues/{key}` |
| `add_comment` | добавить комментарий (Markdown) | `POST /api/issues/{key}/comments` |
| `get_task` | прочитать задачу; `includeComments` добавляет комментарии | `GET /api/issues/{key}` |
| `set_task_status` | сменить статус по ключу (`in_progress`) или имени («В работе») | `PATCH /api/issues/{key}` |
| `list_queues` | справочник: проекты → очереди → статусы (`ключ=«имя»`) | `GET /api/projects…`, `/api/queues/{key}/statuses` |

Шестой инструмент — справочный: без него агент угадывал бы ключи очередей и имена статусов.

## Как это работает

```
MCP-клиент (dsh-term / Claude Code)
      │  Streamable HTTP + Authorization: Bearer <SL_MCP_TOKEN>
      ▼
sl-tracker-mcp                       ← вы здесь
      │  HTTP + Authorization: Bearer <PAT участника>
      ▼
SL Tracker API  (/api/issues, /api/queues/{key}/issues, /api/issues/{key}/comments)
```

- **Отдельной машинной учётки нет.** Токен трекера — это PAT участника проекта: права MCP
  равны его роли (`admin`/`member`/`reader`), задачи и комментарии подписываются его именем.
  Отозвать доступ человеку — и все его токены гаснут.
- **Два разных токена**: `SL_API_TOKEN` (PAT трекера, сервер ходит с ним в API) и
  `SL_MCP_TOKEN` (им клиенты представляются серверу). Первый — секрет трекера, второй —
  секрет этого сервера.
- **Предохранители** не зависят от прав владельца: `SL_MCP_READONLY=1` выключает все
  изменяющие инструменты, `SL_MCP_ALLOWED_QUEUES` сужает запись до перечисленных очередей.
- **Пустые токены — отказ старта** с внятным сообщением. Compose эти переменные не страхует
  (`${MCP_SL_API_TOKEN:-}`), поэтому проверка живёт здесь.

## Запуск

### Локально (stdio — так сервер запускают Claude Desktop и Inspector)

```bash
npm install
SL_API_URL=https://tracker.72-56-41-79.sslip.io:8443 \
SL_API_TOKEN=<PAT участника> \
SL_MCP_TRANSPORT=stdio \
node --import tsx src/index.ts
```

### Локально (HTTP)

```bash
SL_API_URL=https://tracker.72-56-41-79.sslip.io:8443 \
SL_API_TOKEN=<PAT> SL_MCP_TOKEN=<токен клиента> PORT=8080 \
node --import tsx src/index.ts
curl -s http://127.0.0.1:8080/healthz         # ok
SL_MCP_URL=http://127.0.0.1:8080 SL_MCP_TOKEN=<токен клиента> \
  node --import tsx scripts/smoke-live.ts DEV-1
```

### На сервере

Собирается из этого каталога (`sl-tracker-mcp/` репозитория `ai-challenge`): compose-профиль
`mcp` в `sl-tracker` берёт `MCP_BUILD_CONTEXT` (по умолчанию `/opt/sl-tracker-mcp/sl-tracker-mcp`)
и передаёт переменные. Порядок выката и проверки — в `docs/SPEC-MCP-DEPLOY.md`.

```bash
docker build -t sl-tracker-mcp:dev .
docker run --rm -p 8080:8080 -e SL_API_URL=http://api:3000 \
  -e SL_API_TOKEN=<PAT> -e SL_MCP_TOKEN=<токен клиента> sl-tracker-mcp:dev
```

## Переменные окружения

| Переменная | Обязательна | По умолчанию | Смысл |
|---|---|---|---|
| `SL_API_TOKEN` | **да** | — | PAT участника трекера (профиль → Доступ → Токены доступа, 365 дней) |
| `SL_MCP_TOKEN` | **да** | — | токен MCP-клиентов; сгенерировать `openssl rand -hex 32` |
| `SL_API_URL` | нет | `http://api:3000` | адрес API **без** `/api`: префикс сервер добавляет сам |
| `SL_MCP_TRANSPORT` | нет | `http` | `http` (за Caddy) или `stdio` (локально) |
| `SL_MCP_HOST` / `PORT` | нет | `0.0.0.0` / `8080` | адрес и порт HTTP-режима |
| `SL_MCP_READONLY` | нет | `0` (в compose `1`) | `1` — только чтение |
| `SL_MCP_ALLOWED_QUEUES` | нет | пусто (все) | очереди, куда разрешена запись |
| `SL_DEFAULT_QUEUE` | нет | — | очередь для `create_task` по умолчанию |
| `SL_WEB_URL` | нет | — | адрес веб-интерфейса: из него ссылки на задачи в ответах |
| `SL_MCP_ALLOWED_ORIGINS` | нет | пусто | разрешённые `Origin`; пустой `Origin` разрешён всегда |
| `SL_MCP_STATEFUL` | нет | `0` | `1` — включить сессии `Mcp-Session-Id` |
| `SL_MCP_JSON_RESPONSE` | нет | `0` | `1` — отвечать JSON-ом вместо SSE |
| `SL_API_TIMEOUT_MS` / `SL_LOG_LEVEL` | нет | `15000` / `info` | таймаут трекера и подробность логов |

## Подключение клиентов

**Канонический адрес эндпоинта — с путём `/mcp`**: `https://mcp.72-56-41-79.sslip.io:8443/mcp`.
Адрес без пути тоже принимается (dsh-term и `scripts/smoke-live.ts` дописывают `/mcp` сами) —
это защита от 404 из catch-all прокси, который стоит за этим доменом.

**dsh-term** (в `ai-challenge`): `dsh-term --mcp sltracker` — пресет с URL и токеном;
инструменты видны модели как `mcp__sltracker__<tool>`.

**Claude Code** (`.mcp.json`):

```json
{ "mcpServers": { "sl-tracker": {
  "type": "http",
  "url": "https://mcp.72-56-41-79.sslip.io:8443/mcp",
  "headers": { "Authorization": "Bearer ${SL_MCP_TOKEN}" }
} } }
```

**Claude Desktop / Inspector** — через stdio: команда `node`, аргументы
`--import tsx /opt/sl-tracker-mcp/sl-tracker-mcp/src/index.ts`, переменные `SL_API_*`,
`SL_MCP_TRANSPORT=stdio`.

## Тесты

```bash
npm test          # 35 тестов: конфиг (в т.ч. отказ старта), клиент API, сквозной HTTP
npm run typecheck
```

Сквозной тест поднимает фальшивый SL Tracker, настоящий MCP-клиент и проходит полный
сценарий: создать → описать → прокомментировать → сменить статус → прочитать. Отдельно
проверяются 401 без токена, 403 на посторонний `Origin`, режим readonly, allowlist очередей
и подсказка при 401 от трекера.

## Документы

- `docs/DEPLOY.md` — **инструкция по развёртыванию** и подключению к dsh-term: пошагово,
  с проверками, ротацией токенов, откатом и разбором типовых ошибок.
- `docs/RFC-MCP-SERVER.md` — RFC для харнесса `sl-tracker`: зачем, что переиспользуем, решения.
- `docs/SPEC-PAT-API.md` — спецификация PAT-эндпоинтов и экрана «Токены доступа» (в трекере).
- `docs/SPEC-MCP-DEPLOY.md` — стыки с инфраструктурой трекера: профиль compose, Caddy, переменные.
