/**
 * Фальшивый SL Tracker API для тестов: повторяет формы ответов из
 * `apps/api/test/mcp-smoke.e2e-spec.ts` (тот тест ходит ровно теми же вызовами).
 *
 * Позволяет проверить MCP-сервер целиком, не поднимая Postgres/Redis и не имея PAT:
 * настоящий MCP-клиент → наш сервер → этот стенд.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface FakeIssue {
  key: string
  title: string
  description: string | null
  statusId: string
  priority: number
  storyPoints: number | null
  author: { id: string; displayName: string; avatarUrl: string | null }
  assignee: null
  queue: { key: string; name: string }
  project: { slug: string; name: string }
  createdAt: string
  updatedAt: string
}

export interface FakeComment {
  id: string
  body: string
  author: { id: string; displayName: string; avatarUrl: string | null }
  createdAt: string
  editedAt: string | null
}

export interface FakeTracker {
  readonly url: string
  readonly issues: Map<string, FakeIssue>
  readonly comments: Map<string, FakeComment[]>
  /** Что запрашивали: для проверки, что инструмент сходил именно туда, куда должен. */
  readonly calls: { method: string; path: string; body?: unknown }[]
  /** Принудительный ответ (например 401) — для проверки разбора ошибок. */
  forcedStatus: number | null
  close(): Promise<void>
}

const STATUSES = [
  { id: 'st-open', key: 'open', name: 'Открыт', category: 'open', position: 1 },
  { id: 'st-progress', key: 'in_progress', name: 'В работе', category: 'in_progress', position: 2 },
  { id: 'st-done', key: 'done', name: 'Готово', category: 'done', position: 3 },
]

const OWNER = { id: 'u-1', displayName: 'Борис Участников', avatarUrl: null }

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length > 0 ? JSON.parse(text) : undefined
}

export async function startFakeTracker(options: { apiToken?: string; port?: number } = {}): Promise<FakeTracker> {
  const apiToken = options.apiToken ?? 'pat-test-token'
  const issues = new Map<string, FakeIssue>()
  const comments = new Map<string, FakeComment[]>()
  const calls: { method: string; path: string; body?: unknown }[] = []
  let seq = 0
  const tracker: FakeTracker = {
    url: '',
    issues,
    comments,
    calls,
    forcedStatus: null,
    close: async () => {},
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname
      const method = request.method ?? 'GET'
      const body = method === 'POST' || method === 'PATCH' ? await readJson(request) : undefined
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })

      if (tracker.forcedStatus !== null) {
        send(response, tracker.forcedStatus, { code: 'forced', message: 'принудительный ответ стенда' })
        return
      }

      if (request.headers.authorization !== `Bearer ${apiToken}`) {
        send(response, 401, { code: 'session_expired', message: 'Сессия завершена' })
        return
      }

      // GET /api/projects
      if (method === 'GET' && path === '/api/projects') {
        send(response, 200, { items: [{ slug: 'sladkiy-limit', name: 'Сладкий Лимит' }], total: 1 })
        return
      }
      // GET /api/projects/:slug/queues
      const queues = /^\/api\/projects\/([^/]+)\/queues$/.exec(path)
      if (method === 'GET' && queues) {
        send(response, 200, { items: [{ key: 'DEV', name: 'Разработка' }], total: 1 })
        return
      }
      // GET /api/queues/:key/statuses
      const statuses = /^\/api\/queues\/([^/]+)\/statuses$/.exec(path)
      if (method === 'GET' && statuses) {
        send(response, 200, { items: STATUSES, total: STATUSES.length })
        return
      }
      // POST /api/queues/:key/issues
      const create = /^\/api\/queues\/([^/]+)\/issues$/.exec(path)
      if (method === 'POST' && create) {
        const queueKey = create[1]!
        const input = (body ?? {}) as { title?: string; description?: string; statusId?: string; priority?: number }
        if (!input.title) {
          send(response, 400, { code: 'invalid_token_name', message: 'Заголовок обязателен' })
          return
        }
        seq += 1
        const key = `${queueKey}-${seq}`
        const status = STATUSES.find((s) => s.id === input.statusId) ?? STATUSES[0]!
        const now = new Date().toISOString()
        const issue: FakeIssue = {
          key,
          title: input.title,
          description: input.description ?? null,
          statusId: status.id,
          priority: input.priority ?? 30,
          storyPoints: null,
          author: OWNER,
          assignee: null,
          queue: { key: queueKey, name: 'Разработка' },
          project: { slug: 'sladkiy-limit', name: 'Сладкий Лимит' },
          createdAt: now,
          updatedAt: now,
        }
        issues.set(key, issue)
        send(response, 201, toDto(issue))
        return
      }
      // /api/issues/:key (+ /comments)
      const issuePath = /^\/api\/issues\/([^/]+)$/.exec(path)
      const commentPath = /^\/api\/issues\/([^/]+)\/comments$/.exec(path)
      const key = issuePath?.[1] ?? commentPath?.[1]
      if (key !== undefined) {
        const issue = issues.get(key)
        if (!issue) {
          send(response, 404, { code: 'not_found', message: `Задача ${key} не найдена` })
          return
        }
        if (commentPath && method === 'GET') {
          send(response, 200, { items: comments.get(key) ?? [], total: (comments.get(key) ?? []).length })
          return
        }
        if (commentPath && method === 'POST') {
          const input = (body ?? {}) as { body?: string }
          const comment: FakeComment = {
            id: `c-${(comments.get(key)?.length ?? 0) + 1}`,
            body: input.body ?? '',
            author: OWNER,
            createdAt: new Date().toISOString(),
            editedAt: null,
          }
          comments.set(key, [...(comments.get(key) ?? []), comment])
          send(response, 201, comment)
          return
        }
        if (issuePath && method === 'GET') {
          send(response, 200, toDto(issue))
          return
        }
        if (issuePath && method === 'PATCH') {
          const input = (body ?? {}) as { description?: string | null; statusId?: string; title?: string }
          if (input.description !== undefined) issue.description = input.description
          if (input.title !== undefined) issue.title = input.title
          if (input.statusId !== undefined) {
            const status = STATUSES.find((s) => s.id === input.statusId)
            if (!status) {
              send(response, 400, { code: 'invalid_status', message: 'Статус чужой очереди' })
              return
            }
            issue.statusId = status.id
          }
          issue.updatedAt = new Date().toISOString()
          send(response, 200, toDto(issue))
          return
        }
      }
      send(response, 404, { code: 'not_found', message: 'маршрут стенда не реализован' })
    })().catch((error: unknown) => {
      send(response, 500, { code: 'internal', message: (error as Error).message })
    })
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('не удалось поднять стенд')
  ;(tracker as { url: string }).url = `http://127.0.0.1:${address.port}`
  ;(tracker as { close: () => Promise<void> }).close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  return tracker
}

/** Форма ответа задачи, как в `IssueDto` SL Tracker. */
function toDto(issue: FakeIssue): Record<string, unknown> {
  const status = STATUSES.find((s) => s.id === issue.statusId) ?? STATUSES[0]!
  return {
    key: issue.key,
    title: issue.title,
    description: issue.description,
    status: { key: status.key, name: status.name, category: status.category },
    priority: issue.priority,
    storyPoints: issue.storyPoints,
    author: issue.author,
    assignee: issue.assignee,
    queue: issue.queue,
    project: issue.project,
    links: [],
    role: 'member',
    permissions: {},
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}
