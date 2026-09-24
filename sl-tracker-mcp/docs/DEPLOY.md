# Развёртывание `sl-tracker-mcp` и подключение к dsh-term

Пошаговая инструкция для сервера `72.56.41.79`, где уже живёт SL Tracker.
Порядок важен: **API → экран → PAT → контейнер MCP → клиенты**. Если переставить, PAT будет
негде выпустить, а MCP-серверу не с чем ходить в трекер.

Обозначения: `<SSH>` — твой ssh-доступ к серверу, `<USER>` — пользователь на сервере.

---

## Шаг 0. Что должно быть готово

| Что | Как проверить |
|---|---|
| Доступ по SSH | `ssh <USER>@72.56.41.79 'docker --version && docker compose version'` |
| Трекер жив | `curl -s https://tracker.72-56-41-79.sslip.io:8443/api/health` → `{"status":"ok",…}` |
| Код MCP в репозитории | ветка с `sl-tracker-mcp/` влита в `feature/week4` или `develop` (репозиторий `ai-challenge`) |
| Свободные порты | MCP наружу не публикуется: он ходит через Caddy на 8443, как и трекер |

---

## Шаг 1. Выкатить sl-tracker (там PAT-эндпоинты и экран токенов)

```bash
ssh <USER>@72.56.41.79
cd /opt/sl-tracker
git fetch origin && git checkout develop && git pull --ff-only
git log --oneline -3          # должен быть коммит с PAT и экраном «Токены доступа»

# обычный выкат (он же собирает api и web и поднимает стек):
./infra/scripts/deploy.sh
```

Если хочется руками:

```bash
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env build api caddy
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env up -d
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env logs --tail=50 api-migrate
```

**Проверка шага 1:**

```bash
curl -s https://tracker.72-56-41-79.sslip.io:8443/api/health            # 200, postgres/redis up
# новый маршрут существует и требует вход (401, а не 404):
curl -s -o /dev/null -w '%{http_code}\n' https://tracker.72-56-41-79.sslip.io:8443/api/tokens
```

Миграция `0001_personal_access_tokens` применяется сервисом `api-migrate` при `up -d`;
в логах должно быть про успешное применение, без ошибок.

---

## Шаг 2. Выпустить PAT участника (токен для MCP-сервера)

1. Открыть трекер: `https://tracker.72-56-41-79.sslip.io:8443` → профиль → **Доступ** →
   **Токены доступа** (адрес — `/me/tokens`).
2. «Создать»: имя `dsh-mcp`, срок **365 дней** → «Создать».
3. **Скопировать токен сразу** — он показывается один раз (в базе лежит только HMAC).
   Потеряешь — выпусти новый и отзови старый.

Что важно помнить:

- это **токен трекера**, он даёт ровно твои права (роль в проекте, список доступа);
- задачи и комментарии будут подписаны твоим именем — отдельной машинной учётки нет;
- отзовёшь доступ себе — погаснут и все твои токены.

---

## Шаг 3. Положить код MCP-сервера на сервер

```bash
sudo mkdir -p /opt/sl-tracker-mcp && sudo chown "$USER" /opt/sl-tracker-mcp
git clone https://github.com/Vladislav-Zyuzko/ai-challenge.git /opt/sl-tracker-mcp
ls /opt/sl-tracker-mcp/sl-tracker-mcp      # здесь Dockerfile — это и есть build context
```

Обновление потом — `cd /opt/sl-tracker-mcp && git pull`.

---

## Шаг 4. Переменные в `.env` трекера

```bash
cd /opt/sl-tracker
cp .env .env.bak.$(date +%F)     # страховка: .env не в git
nano .env
```

Добавить:

```ini
# --- MCP-сервер -------------------------------------------------------------
COMPOSE_PROFILES=mcp
SL_MCP_DOMAIN=mcp.72-56-41-79.sslip.io
MCP_BUILD_CONTEXT=/opt/sl-tracker-mcp/sl-tracker-mcp

# PAT из шага 2 (не клиентский токен!)
MCP_SL_API_TOKEN=<токен из экрана «Токены доступа»>
# токен, которым клиенты (dsh-term, Claude Code) представляются MCP-серверу:
MCP_CLIENT_TOKEN=<вывод: openssl rand -hex 32>

MCP_DEFAULT_QUEUE=SL
# 1 — только чтение; для создания задач и комментариев нужно 0
MCP_READONLY=0
# очереди, куда вообще разрешена запись; пусто — все (безопаснее сузить)
MCP_ALLOWED_QUEUES=
MCP_LOG_LEVEL=info
```

Сгенерировать клиентский токен:

```bash
openssl rand -hex 32
```

⚠️ **Не добавлять `:?` к MCP-переменным** (`${MCP_SL_API_TOKEN:?...}`): compose подставляет
переменные во весь файл до отсева сервисов по профилям, и весь стек перестал бы
конфигурироваться. В `docker-compose.prod.yml` это уже учтено — там `${…:-}`.

⚠️ `.env` не коммитить и не пересылать в мессенджеры. Токен PAT — секрет трекера,
токен клиента — секрет MCP-сервера.

---

## Шаг 5. Проверить Caddy **до** перезапуска

```bash
cd /opt/sl-tracker
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env config -q     # синтаксис compose
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env \
  run --rm --no-deps --entrypoint caddy caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Ожидаемое: `Valid configuration`. Если `run` пытается собрать образ web — это нормально
(Caddy собирается из того же образа, что отдаёт Flutter), просто дождись.

Домен `mcp.72-56-41-79.sslip.io` резолвится в тот же IP автоматически (sslip.io),
регистрация DNS не нужна. Сертификат Let's Encrypt Caddy получит при первом обращении.

---

## Шаг 6. Собрать и поднять MCP-контейнер

```bash
cd /opt/sl-tracker
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env build mcp
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env up -d
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env ps
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env logs --tail=50 mcp
```

Что должно быть в логах:

```
INFO MCP-сервер слушает {"url":"http://0.0.0.0:8080/mcp","mode":"stateless","readonly":false,"allowedQueues":"все"}
```

Чего быть **не должно**: `sl-tracker-mcp: не заданы обязательные переменные` — это значит,
что `MCP_SL_API_TOKEN` или `MCP_CLIENT_TOKEN` пусты (сервер намеренно не стартует с пустым
токеном). Заполни `.env` и повтори `up -d mcp`.

Контейнер сам себя проверяет: у него `healthcheck` на `/healthz`, статус виден в `ps` как
`healthy` (первые 10 секунд — `starting`).

---

## Шаг 7. Проверить снаружи

```bash
# 1. Домен и сертификат
getent hosts mcp.72-56-41-79.sslip.io                    # 72.56.41.79
curl -sS -o /dev/null -w 'healthz: %{http_code}\n' https://mcp.72-56-41-79.sslip.io:8443/healthz   # 200

# 2. Без токена — отказ
curl -sS -o /dev/null -w 'без токена: %{http_code}\n' -X POST https://mcp.72-56-41-79.sslip.io:8443/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'          # 401
```

Полноценная проверка «клиент → MCP → трекер» (список инструментов, справочник очередей):

```bash
cd /opt/sl-tracker-mcp/sl-tracker-mcp
SL_MCP_URL=https://mcp.72-56-41-79.sslip.io:8443 \
SL_MCP_TOKEN=<MCP_CLIENT_TOKEN из .env> \
node --import tsx scripts/smoke-live.ts
```

Ожидаемое: `✔ соединение … установлено`, `✔ инструментов: 6 — create_task, update_task_description,
add_comment, get_task, set_task_status, list_queues`, затем список очередей со статусами.
Если передать ключ задачи (`… scripts/smoke-live.ts SL-1`), он ещё и прочитает задачу.

> Этот же скрипт удобно запускать **с локальной машины** — он ходит по публичному URL.

---

## Шаг 8. Подключить MCP к dsh-term

dsh-term уже умеет это из коробки: пресет `sltracker`, адрес и токен — из окружения.

**Windows PowerShell (разово, текущая сессия):**

```powershell
$env:SL_MCP_URL   = 'https://mcp.72-56-41-79.sslip.io:8443/mcp'
$env:SL_MCP_TOKEN = '<MCP_CLIENT_TOKEN>'
node dsh-term\dsh-term.mjs --mcp sltracker
```

**Чтобы не вводить каждый раз** (новые окна терминала):

```powershell
setx SL_MCP_URL   "https://mcp.72-56-41-79.sslip.io:8443/mcp"
setx SL_MCP_TOKEN "<MCP_CLIENT_TOKEN>"
```

**Linux/macOS:** `export SL_MCP_URL=… SL_MCP_TOKEN=…` в `~/.bashrc` или `~/.zshrc`.

Что увидишь на старте:

```
mcp: включён sltracker · read-write, toolsets=all · запрашиваю список инструментов…
  mcp: sltracker · 6 tools · сырые схемы ≈ 1k → в промпте ≈ 470 tokens · sl-tracker-mcp · 54 мс ·
       инструменты видны как mcp__sltracker__*
```

В сессии:

| Команда | Что делает |
|---|---|
| `/mcp` | что подключено, режим, url, цена в промпте |
| `/mcp tools` | полный список инструментов с аргументами |
| `/mcp refresh` | переподключиться и пересчитать |

Как это выглядит в работе (реальный прогон на стенде):

```
⛭ sltracker/list_queues
⛭ sltracker/create_task title="Проверить MCP-мост" description="создано агентом через MCP" queue="DEV"
⛭ sltracker/add_comment key="DEV-1" body="иду проверять"
⛭ sltracker/set_task_status key="DEV-1" status="in_progress"
```

Флаги и оговорки:

- `--mcp sltracker` — включить; без флага MCP не подключается вообще (нулевая цена);
- `--mcp-check sltracker` — только диагностика: соединение + список инструментов, без сессии;
- если `SL_MCP_TOKEN` не задан, dsh-term скажет об этом и **не** подключит сервер
  (в промпт не попадёт битый клиент);
- запись в трекер зависит от `MCP_READONLY` на стороне MCP-сервера: при `1` инструменты
  создания/правки/комментария/статуса отвечают `[forbidden] MCP-сервер запущен в режиме «только чтение»`.

**Claude Code** (файл `.mcp.json` в проекте или глобальный конфиг):

```json
{
  "mcpServers": {
    "sl-tracker": {
      "type": "http",
      "url": "https://mcp.72-56-41-79.sslip.io:8443/mcp",
      "headers": { "Authorization": "Bearer <MCP_CLIENT_TOKEN>" }
    }
  }
}
```

**Claude Desktop / MCP Inspector** — через stdio, сервер запускается локально:

```bash
SL_API_URL=https://tracker.72-56-41-79.sslip.io:8443 \
SL_API_TOKEN=<PAT> SL_MCP_TRANSPORT=stdio \
node --import tsx /opt/sl-tracker-mcp/sl-tracker-mcp/src/index.ts
```

---

## Шаг 9. Эксплуатация

### Ротация PAT (токен трекера)

1. Экран «Токены доступа» → «Создать» новый токен.
2. В `/opt/sl-tracker/.env` заменить `MCP_SL_API_TOKEN` на новый.
3. `docker compose -f infra/compose/docker-compose.prod.yml --env-file .env up -d mcp`
   (контейнер пересоздастся с новой переменной).
4. Старый токен → «Отозвать» в списке. Действует немедленно.

### Ротация клиентского токена

1. `openssl rand -hex 32` → новый `MCP_CLIENT_TOKEN` в `.env`.
2. `up -d mcp` → обновить переменную у клиентов (dsh-term: `setx`, Claude: конфиг).

### Обновление кода MCP-сервера

```bash
cd /opt/sl-tracker-mcp && git pull
cd /opt/sl-tracker && docker compose -f infra/compose/docker-compose.prod.yml --env-file .env build mcp \
  && docker compose -f infra/compose/docker-compose.prod.yml --env-file .env up -d mcp
```

### Откат

```bash
# выключить MCP, оставив трекер как есть:
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env stop mcp
# или совсем убрать из стека: убрать COMPOSE_PROFILES=mcp из .env и up -d
```
Плюс отозвать PAT в интерфейсе. Правки в sl-tracker откатывать не нужно: они аддитивные
и без MCP ни на что не влияют.

### Логи и наблюдаемость

```bash
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env logs -f --tail=100 mcp
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env exec caddy tail -f /var/log/caddy/mcp-access.log
```
В логах MCP нет токенов: поля с `token/secret/authorization/cookie` заменяются на `[redacted]`.

---

## Если что-то не работает

| Симптом | Причина и что делать |
|---|---|
| Клиент получает `401` | перепутаны токены: клиенту нужен `MCP_CLIENT_TOKEN`, а не PAT трекера |
| Инструмент отвечает `[machine_access_expired]` | PAT отозван или истёк → выпустить новый и обновить `MCP_SL_API_TOKEN`, `up -d mcp` |
| Инструмент отвечает `[forbidden] … только чтение` | на MCP-сервере `MCP_READONLY=1` → поставить `0` и `up -d mcp` |
| `[forbidden] очередь X не разрешена` | сужен `MCP_ALLOWED_QUEUES` — добавить очередь или очистить переменную |
| Контейнер `mcp` падает сразу | пустые `MCP_SL_API_TOKEN`/`MCP_CLIENT_TOKEN`: в логах будет список того, чего не хватает |
| `403 forbidden_origin` | запрос пришёл с чужого `Origin` (браузер); для curl/агентов заголовка нет и это норма |
| `502` на домене MCP | контейнер не поднят или профиль не включён: `COMPOSE_PROFILES=mcp` и `ps` |
| Сертификат не выдаётся | порт 80 занят? 443 трогать нельзя (XRay); в Caddyfile уже `https_port 8443` |

---

## Чек-лист (сокращённо)

```
[ ] 1. sl-tracker develop выкачен, /api/health 200, /api/tokens → 401
[ ] 2. PAT выпущен в UI (365 дней), скопирован
[ ] 3. ai-challenge склонирован в /opt/sl-tracker-mcp
[ ] 4. .env: COMPOSE_PROFILES=mcp, SL_MCP_DOMAIN, MCP_BUILD_CONTEXT,
       MCP_SL_API_TOKEN, MCP_CLIENT_TOKEN, MCP_DEFAULT_QUEUE, MCP_READONLY
[ ] 5. caddy validate → Valid configuration
[ ] 6. build mcp && up -d && ps (healthy) && logs без ошибок
[ ] 7. /healthz 200, POST /mcp без токена → 401, smoke-live.ts → 6 инструментов и очереди
[ ] 8. dsh-term --mcp sltracker: на старте «6 tools», /mcp tools показывает список
[ ] 9. Задача, созданная агентом, видна в трекере и подписана твоим именем
```
