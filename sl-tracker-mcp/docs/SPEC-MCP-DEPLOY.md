# SPEC: развёртывание `sl-tracker-mcp` рядом с трекером

- **Статус:** спецификация к [`RFC-MCP-SERVER.md`](RFC-MCP-SERVER.md)
- **Что здесь меняется:** только `infra/` этого репозитория (Caddy, compose, `.env.example`).
- **Что здесь НЕ меняется:** код API и веб-клиента. MCP-сервер — отдельный проект (`sl-tracker-mcp`),
  его код живёт вне этого репозитория; здесь описаны только стыки.

---

## 0. Что реализовано иначе (итог ревью в PR #1)

Актуальный контракт — не §3–§6 ниже, а этот список:

| В спеке | В коде | Почему |
|---|---|---|
| `${MCP_SL_API_TOKEN:?…}` в compose (§3.1) | `${MCP_SL_API_TOKEN:-}` | compose подставляет переменные во **весь** файл до отсева сервисов по профилям: с `:?` переставал конфигурироваться весь стек, включая `deploy.sh`. Проверено на `compose config` |
| сервис поднимается всегда | сервис в профиле `mcp`, включается `COMPOSE_PROFILES=mcp` | выкат трекера не должен зависеть от того, склонирован ли репозиторий MCP |
| `health_uri`/`health_interval` в Caddy (§4) | убраны | апстрим один, отбраковывать некуда; при выключенном профиле проверки вечно писали бы ошибку в лог. Готовность стережёт `healthcheck` compose |
| `SL_MCP_DOMAIN` через `:?` | дефолт `mcp.localhost` | без MCP-переменных Caddy поднимает безвредную заглушку с внутренним сертификатом |
| `MCP_READONLY` — `0` в §3.1, `1` в §6 | `1` в обоих местах | начинаем с чтения: токен несёт полные права человека |
| — | `GET /api/tokens` без пагинации | действующих максимум 20 |

**Требования к `sl-tracker-mcp`, вытекающие отсюда** (выполнены в коде проекта):

1. **Падать на старте при пустом токене** — compose больше не страхует. Реализовано:
   `ConfigError` с перечислением обеих переменных и подсказкой, где взять PAT; проверено
   тестами процесса (код возврата 1) и запуском контейнера.
2. **Префикс `/api`** — адрес API склеивается в одном месте (`apiUrl()` в `src/sl-tracker.ts`),
   тест: `http://api:3000` + `/issues/DEV-1` → `http://api:3000/api/issues/DEV-1`.
3. **401 от трекера — это «машинный доступ кончился»** — доменный код
   `machine_access_expired` и подсказка «выпустите новый токен»; проверено против живого API.
4. **`Origin`**: пустой разрешён (curl, dsh-term, Claude Code его не шлют), посторонний — 403.
5. **`/healthz`** — голый `ok` без версий, путей и имён очередей.

---

## 1. Как это устроено

```
Интернет
   │  https (8443, 443 занят XRay)
   ▼
Caddy ── /api/*  ──▶ api:3000      (как сейчас)
   │    /mcp*   ──▶ mcp:8080       (новое)
   ▼
caddy: статика Flutter в корне
                   mcp:8080  ──(Bearer PAT участника)──▶  http://api:3000   (внутренняя сеть)
```

- MCP-сервер не публикует порты на хост: до него дотягивается только сеть compose, как до
  `postgres`/`redis`/`minio`.
- MCP-сервер не ходит в интернет за данными: он вызывает API по внутреннему имени `api`.
- Клиенты (dsh-term, Claude Code) ходят на `https://{$SL_MCP_DOMAIN}:8443/mcp` с
  собственным токеном `MCP_CLIENT_TOKEN`.

## 2. Варианты размещения (выбрать один)

**Вариант A (рекомендуется): сервис в боевом compose трекера.**
Плюсы: одна сеть, один `up -d`, Caddy сразу видит `mcp:8080` по имени сервиса, `depends_on: api`
даёт правильный порядок старта. Минус: сборка MCP-образа описана в репозитории трекера
(через `context` на клон `sl-tracker-mcp`).

**Вариант B: отдельный compose-проект `sl-tracker-mcp` с внешней сетью.**
```yaml
networks:
  sl-tracker_default:
    external: true
```
Плюс: полная изоляция репозиториев. Минус: два `up -d`, порядок старта вручную, сеть надо
объявлять внешней и следить, чтобы имя совпадало с именем проекта трекера.

Ниже расписан **вариант A**; для B меняется только место определения сервиса.

## 3. Изменения в `infra/compose/docker-compose.prod.yml`

### 3.1 Сервис `mcp`

```yaml
  mcp:
    # Код проекта sl-tracker-mcp клонируется на сервер отдельно (см. §5).
    build:
      context: ${MCP_BUILD_CONTEXT:-/opt/sl-tracker-mcp/sl-tracker-mcp}
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 8080
      # Внутренний адрес API: без TLS и без выхода в интернет.
      SL_API_URL: http://api:3000
      # PAT участника проекта (профиль → Доступ → Токены, срок 365 дней; см. SPEC-PAT-API.md).
      # Права MCP = права этого участника.
      SL_API_TOKEN: ${MCP_SL_API_TOKEN:?MCP_SL_API_TOKEN не задан}
      # Токен, который предъявляют MCP-клиенты (dsh-term, Claude Code).
      SL_MCP_TOKEN: ${MCP_CLIENT_TOKEN:?MCP_CLIENT_TOKEN не задан}
      SL_DEFAULT_QUEUE: ${MCP_DEFAULT_QUEUE:-SL}
      # Защита в глубину: 1 — сервер отказывает во всех изменяющих инструментах.
      SL_MCP_READONLY: ${MCP_READONLY:-0}
      SL_MCP_ALLOWED_QUEUES: ${MCP_ALLOWED_QUEUES:-}
      SL_LOG_LEVEL: ${MCP_LOG_LEVEL:-info}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"]
      interval: 15s
      timeout: 5s
      retries: 6
      start_period: 10s
    depends_on:
      api:
        condition: service_started
```

### 3.2 Сервис `caddy` — новая переменная

```yaml
      SL_MCP_DOMAIN: ${SL_MCP_DOMAIN:?SL_MCP_DOMAIN не задан}
```

## 4. Изменения в `infra/caddy/Caddyfile`

1. В блок HTTP→HTTPS добавить новый домен (иначе человек, набравший адрес без https, попадёт
   на XRay и увидит ошибку сертификата):

```
http://{$SL_DOMAIN}, http://{$SL_S3_DOMAIN}, http://{$SL_MCP_DOMAIN} {
	redir https://{host}:{$SL_HTTPS_PORT:443}{uri} 308
}
```

2. Новый site-блок (отдельное имя, а не путь внутри основного домена: у основного домена
   catch-all отдаёт Flutter SPA, и любой незнакомый путь уходит в `index.html`):

```
# --- MCP-сервер -----------------------------------------------------------
{$SL_MCP_DOMAIN} {
	encode zstd gzip

	log {
		output file /var/log/caddy/mcp-access.log {
			roll_size 10MiB
			roll_keep 5
		}
		format json
	}

	header {
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Strict-Transport-Security "max-age=31536000"
		-Server
	}

	# MCP-эндпоинт: один путь, POST (+ SSE-ответы).
	handle /mcp* {
		reverse_proxy mcp:8080 {
			# Без этого Caddy буферизует SSE и клиент не увидит поток.
			flush_interval -1
			health_uri /healthz
			health_interval 15s
		}
	}

	handle /healthz {
		reverse_proxy mcp:8080
	}

	handle {
		respond 404
	}
}
```

Почему так:

- `flush_interval -1` — обязательное условие работы Streamable HTTP (ответы могут быть
  SSE-потоком); без него длинные вызовы инструментов «висят» до закрытия соединения;
- отдельный домен = отдельный сертификат Let's Encrypt (домен `mcp.<ip>.sslip.io` уже
  резолвится в тот же адрес, проверено), отдельные логи и отдельная политика доступа;
- HTTP/3 по-прежнему выключен глобально (UDP занят WireGuard), порт — 8443.

## 5. Что делает владелец на сервере (один раз)

```bash
# 1. Код MCP-проекта (репозиторий ai-challenge, публичный)
git clone https://github.com/Vladislav-Zyuzko/ai-challenge.git /opt/sl-tracker-mcp
# внутри лежит каталог sl-tracker-mcp/ — он и есть build context

# 2. Переменные в .env трекера
cd /opt/sl-tracker
#   SL_MCP_DOMAIN=mcp.72-56-41-79.sslip.io
#   MCP_SL_API_TOKEN=<PAT участника: профиль → Доступ → Токены → «Создать», срок 365 дней>
#   MCP_CLIENT_TOKEN=<токен для MCP-клиентов, сгенерировать: openssl rand -hex 32>
#   MCP_DEFAULT_QUEUE=SL
#   MCP_READONLY=0
#   MCP_BUILD_CONTEXT=/opt/sl-tracker-mcp/sl-tracker-mcp

# 3. Выкат
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env build mcp
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env up -d
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env ps
docker compose -f infra/compose/docker-compose.prod.yml --env-file .env logs --tail=50 mcp
```

Порядок важен: сначала backend-правки из `SPEC-PAT-API.md` и PAT участника, потом MCP-сервис —
иначе `SL_API_TOKEN` неоткуда взять.

## 6. `.env.example` (добавить)

```ini
# --- MCP-сервер -------------------------------------------------------------
SL_MCP_DOMAIN=mcp.example.com
MCP_BUILD_CONTEXT=../sl-tracker-mcp
MCP_SL_API_TOKEN=
MCP_CLIENT_TOKEN=
MCP_DEFAULT_QUEUE=SL
MCP_READONLY=1
MCP_ALLOWED_QUEUES=
MCP_LOG_LEVEL=info
```

## 7. Проверка (обязательная, снаружи, без docker exec)

```bash
# 1. Сертификат и доступность
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.72-56-41-79.sslip.io:8443/healthz   # 200

# 2. Без токена — отказ
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://mcp.72-56-41-79.sslip.io:8443/mcp \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 401

# 3. Рукопожатие
curl -sS -X POST https://mcp.72-56-41-79.sslip.io:8443/mcp \
  -H "Authorization: Bearer $MCP_CLIENT_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 4. Список инструментов: ожидаем 6 (5 операций + справочник очередей)
#    (повторить запрос с Mcp-Session-Id из ответа шага 3)
curl -sS -X POST https://mcp.72-56-41-79.sslip.io:8443/mcp \
  -H "Authorization: Bearer $MCP_CLIENT_TOKEN" -H "Mcp-Session-Id: $SID" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 5. Вызов инструмента и проверка в трекере: создаётся задача, автор — владелец токена.
```

Дополнительно: `curl` с чужим `Origin` → 403 (проверка Origin на стороне MCP-сервера);
`SL_MCP_READONLY=1` → изменяющие инструменты отвечают ошибкой `readonly_mode`.

## 8. Откат

1. `docker compose ... stop mcp` и убрать site-блок из `Caddyfile` → `docker compose ... up -d caddy`.
2. Отозвать PAT: `DELETE /api/tokens/{id}` (или отозвать доступ владельцу — тогда погаснут все
   его токены, см. `SPEC-PAT-API.md`).
3. Backend-правки откатывать не нужно: они аддитивные и без MCP ни на что не влияют.

## 9. Открытые вопросы к владельцу

1. `MCP_READONLY=0` (разрешить создание/изменение задач) или начать с `1` и включить запись
   после проверки?
2. Ограничивать ли MCP одной очередью через `MCP_ALLOWED_QUEUES` (рекомендуется — тогда
   агент физически не сможет писать в чужие очереди)?
3. Нужен ли отдельный порт вместо 8443 (свободных портов на сервере нет, 443 занят XRay)?
