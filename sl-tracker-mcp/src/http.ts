/**
 * Streamable HTTP: один эндпоинт `/mcp`, `/healthz` для compose и никаких лишних путей.
 *
 * Что здесь важно и почему:
 * - **авторизация обязательна**: `Authorization: Bearer <SL_MCP_TOKEN>`, сравнение
 *   за постоянное время. Иначе наш сервер — открытая дверь к трекеру;
 * - **проверка `Origin`**: посторонний Origin отбиваем 403 (защита от DNS-rebinding),
 *   но **отсутствие Origin считается нормой** — его не присылают ни curl, ни dsh-term,
 *   ни Claude Code, и отбивать пустой заголовок значило бы отрезать штатных клиентов;
 * - **`/healthz` без авторизации и без деталей**: голый 200, ни версий, ни путей,
 *   ни имён очередей — его дёргает healthcheck compose;
 * - по умолчанию сервер **stateless** (состояния между вызовами нет), но `SL_MCP_STATEFUL=1`
 *   включает сессии `Mcp-Session-Id` для клиентов, которым они нужны.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Config } from './config.js'
import type { Logger } from './logger.js'
import { createMcpServer } from './server.js'
import type { ToolContext } from './tools.js'

const MCP_PATH = '/mcp'
const HEALTH_PATH = '/healthz'
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Сравнение секретов за постоянное время: длина хешей фиксирована. */
function secretEquals(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || undefined
}

/**
 * Политика Origin. Пустой заголовок разрешён всегда (не-браузерные клиенты), посторонний —
 * только если он явно перечислен в `SL_MCP_ALLOWED_ORIGINS` или совпадает с хостом запроса.
 */
export function originAllowed(request: IncomingMessage, config: Config): boolean {
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  const value = String(origin).trim().toLowerCase()
  if (config.allowedOrigins.some((allowed) => allowed.toLowerCase() === value)) return true
  const host = request.headers.host
  if (typeof host === 'string' && host.length > 0) {
    const hostLower = host.toLowerCase()
    if (value === `https://${hostLower}` || value === `http://${hostLower}`) return true
  }
  return false
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  response.end(payload)
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('тело запроса слишком большое')
    chunks.push(buf)
  }
  if (size === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('тело запроса не является валидным JSON')
  }
}

export interface HttpServerHandle {
  readonly server: Server
  close(): Promise<void>
}

export function startHttpServer(config: Config, ctx: ToolContext, logger: Logger): HttpServerHandle {
  /** В stateful-режиме: идентификатор сессии → её транспорт. */
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  const handleMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!originAllowed(request, config)) {
      logger.warn('отклонён запрос с посторонним Origin', { origin: request.headers.origin })
      sendJson(response, 403, { error: 'forbidden_origin', message: 'Origin не разрешён' })
      return
    }

    const presented = bearerOf(request)
    if (presented === undefined || !secretEquals(presented, config.mcpToken)) {
      logger.warn('отклонён запрос без валидного токена MCP-клиента', { method: request.method })
      sendJson(
        response,
        401,
        { error: 'unauthorized', message: 'нужен заголовок Authorization: Bearer <SL_MCP_TOKEN>' },
        { 'WWW-Authenticate': 'Bearer realm="sl-tracker-mcp"' },
      )
      return
    }

    let body: unknown
    if (request.method === 'POST') {
      try {
        body = await readBody(request)
      } catch (error) {
        sendJson(response, 400, { error: 'invalid_body', message: (error as Error).message })
        return
      }
    }

    // Stateful: продолжаем существующую сессию, если клиент принёс её идентификатор.
    const sessionId = request.headers['mcp-session-id']
    if (config.stateful && typeof sessionId === 'string' && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(request, response, body)
      return
    }

    // Stateless (по умолчанию) и первая инициализация stateful: свежий сервер на запрос.
    const server = createMcpServer(ctx)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: config.stateful ? () => randomUUID() : undefined,
      enableJsonResponse: config.jsonResponse,
      ...(config.stateful
        ? {
            onsessioninitialized: (id: string) => {
              sessions.set(id, transport)
            },
          }
        : {}),
    })
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
    }
    response.on('close', () => {
      // Stateless: транспорт и сервер живут ровно один запрос, иначе они копятся.
      if (!config.stateful) {
        void transport.close().catch(() => {})
        void server.close().catch(() => {})
      }
    })

    await server.connect(transport)
    await transport.handleRequest(request, response, body)
  }

  const server = createHttpServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (path === HEALTH_PATH) {
      // Голый 200: ни версии, ни путей, ни имён очередей — только признак живости.
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('ok')
      return
    }
    if (path === MCP_PATH) {
      void handleMcp(request, response).catch((error: unknown) => {
        logger.error('ошибка обработки MCP-запроса', { message: (error as Error).message })
        if (!response.headersSent) {
          sendJson(response, 500, { error: 'internal_error', message: 'внутренняя ошибка' })
        } else {
          response.end()
        }
      })
      return
    }
    sendJson(response, 404, { error: 'not_found', message: 'на этом сервере есть только /mcp и /healthz' })
  })

  server.listen(config.port, config.host, () => {
    logger.info('MCP-сервер слушает', {
      url: `http://${config.host}:${config.port}${MCP_PATH}`,
      mode: config.stateful ? 'stateful' : 'stateless',
      readonly: config.readonlyMode,
      allowedQueues: config.allowedQueues.length > 0 ? config.allowedQueues.join(',') : 'все',
    })
  })

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const transport of sessions.values()) void transport.close().catch(() => {})
        sessions.clear()
        server.close(() => resolve())
      }),
  }
}
