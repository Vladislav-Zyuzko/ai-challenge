/**
 * Восемь инструментов MCP: пять операций над задачами из задания, два чтения списков
 * (задачи очереди и комментарии) и один справочник.
 *
 * Описания инструментов попадают в контекст модели **на каждом запросе**, поэтому они
 * короткие и по делу: что делает, какой ключ принимает, что вернёт.
 *
 * Предохранители (защита в глубину, независимо от прав владельца токена):
 * - `SL_MCP_READONLY=1` — все изменяющие инструменты отказывают (`forbidden`);
 * - `SL_MCP_ALLOWED_QUEUES` — запись вне перечисленных очередей запрещена (`forbidden`).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from './config.js'
import {
  getIssue,
  issueCard,
  issueLine,
  issueRowLine,
  listQueueStatuses,
  resolveStatusId,
  resolveStatusKeys,
  type CommentDto,
  type IssueDto,
  type IssueRowDto,
  type ProjectDto,
  type QueueDto,
} from './domain.js'
import type { Logger } from './logger.js'
import { SlTrackerError, type SlTrackerClient } from './sl-tracker.js'

export interface ToolContext {
  readonly config: Config
  readonly client: SlTrackerClient
  readonly logger: Logger
}

interface TextResult {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const ok = (text: string, structured?: Record<string, unknown>): TextResult => ({
  content: [{ type: 'text', text }],
  ...(structured ? { structuredContent: structured } : {}),
})

/** Ошибка инструмента: код + текст, который видит и модель, и логи. */
const fail = (code: string, message: string): TextResult => ({
  content: [{ type: 'text', text: `[${code}] ${message}` }],
  isError: true,
})

function toFailure(error: unknown, tool: string, logger: Logger): TextResult {
  if (error instanceof SlTrackerError) {
    logger.warn('инструмент завершился ошибкой', { tool, code: error.code, status: error.status })
    return fail(error.code, `${error.message}. ${error.hint()}`)
  }
  logger.error('инструмент упал', { tool, message: (error as Error).message })
  return fail('internal_error', `внутренняя ошибка MCP-сервера: ${(error as Error).message}`)
}

/** Проверки для изменяющих инструментов: режим «только чтение» и allowlist очередей. */
function assertWritable(config: Config, queue: string): void {
  if (config.readonlyMode) {
    throw new SlTrackerError(
      'forbidden',
      'MCP-сервер запущен в режиме «только чтение» (SL_MCP_READONLY=1): запись отключена',
    )
  }
  if (config.allowedQueues.length > 0 && !config.allowedQueues.includes(queue)) {
    throw new SlTrackerError(
      'forbidden',
      `очередь ${queue} не разрешена: SL_MCP_ALLOWED_QUEUES=${config.allowedQueues.join(',')}`,
    )
  }
}

/** Очередь для создания задачи: явный аргумент → SL_DEFAULT_QUEUE → ошибка. */
function resolveQueue(config: Config, requested: string | undefined): string {
  const queue = requested?.trim() || config.defaultQueue
  if (!queue) {
    throw new SlTrackerError(
      'invalid_request',
      'очередь не указана: передайте queue или задайте SL_DEFAULT_QUEUE на сервере',
    )
  }
  return queue
}

/** Читающие инструменты: им разрешено работать в режиме «только чтение». */
const READ_ONLY_TOOLS = new Set(['get_task', 'list_queues', 'list_issues', 'list_comments'])

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { client, config, logger } = ctx

  const register = <A extends object>(
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodType>,
    handler: (args: A) => Promise<TextResult>,
  ): void => {
    const readOnly = READ_ONLY_TOOLS.has(name)
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema,
        annotations: {
          // Подсказки клиентам: изменяющие инструменты помечены destructive, читающие — readOnly.
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
        },
      },
      (async (args: A) => {
        const started = Date.now()
        try {
          const result = await handler(args)
          logger.info('инструмент выполнен', {
            tool: name,
            ms: Date.now() - started,
            ok: result.isError !== true,
          })
          return result
        } catch (error) {
          return toFailure(error, name, logger)
        }
      }) as never,
    )
  }

  // 1. Создание задачи с описанием ------------------------------------------
  interface CreateTaskArgs {
    queue?: string
    title: string
    description?: string
    status?: string
    priority?: number
  }
  register<CreateTaskArgs>(
    'create_task',
    'Создать задачу',
    'Создаёт задачу в очереди трекера. Заголовок обязателен, описание — Markdown. '
      + 'Статус можно не указывать (будет первый статус очереди); если указывать — ключ вроде '
      + 'in_progress или имя вроде «В работе». Возвращает ключ задачи (например DEV-1).',
    {
      queue: z.string().min(1).max(16).optional().describe('Ключ очереди, например DEV. По умолчанию — очередь сервера'),
      title: z.string().min(1).max(500).describe('Заголовок задачи'),
      description: z.string().max(20000).optional().describe('Описание в Markdown'),
      status: z.string().min(1).max(120).optional().describe('Ключ или имя статуса: in_progress, «В работе»'),
      priority: z.number().int().min(0).max(100).optional().describe('Приоритет 0..100 с шагом 10'),
    },
    async (args) => {
      const queueKey = resolveQueue(config, args.queue)
      assertWritable(config, queueKey)
      const body: Record<string, unknown> = { title: args.title }
      if (args.description !== undefined) body.description = args.description
      if (args.priority !== undefined) body.priority = args.priority
      if (args.status !== undefined) {
        body.statusId = (await resolveStatusId(client, queueKey, args.status)).id
      }

      const issue = await client.post<IssueDto>(`/queues/${encodeURIComponent(queueKey)}/issues`, body)
      return ok(`Создана задача. ${issueLine(issue, config.webUrl)}`, {
        key: issue.key,
        title: issue.title,
        status: issue.status.key,
        queue: issue.queue.key,
        author: issue.author.displayName,
        ...(config.webUrl ? { url: `${config.webUrl}/issues/${issue.key}` } : {}),
      })
    },
  )

  // 2. Изменение описания ----------------------------------------------------
  interface UpdateDescriptionArgs {
    key: string
    description: string
  }
  register<UpdateDescriptionArgs>(
    'update_task_description',
    'Изменить описание задачи',
    'Заменяет описание задачи целиком (Markdown). Пустая строка очищает описание. '
      + 'Заголовок и статус не трогает.',
    {
      key: z.string().min(1).max(32).describe('Ключ задачи, например DEV-1'),
      description: z.string().max(20000).describe('Новое описание в Markdown; пустая строка — очистить'),
    },
    async ({ key, description }) => {
      const issue = await getIssue(client, key)
      assertWritable(config, issue.queue.key)
      const updated = await client.patch<IssueDto>(`/issues/${encodeURIComponent(key)}`, { description })
      return ok(`Описание обновлено. ${issueLine(updated, config.webUrl)}`, {
        key: updated.key,
        descriptionLength: updated.description?.length ?? 0,
        status: updated.status.key,
      })
    },
  )

  // 3. Комментарий -----------------------------------------------------------
  interface AddCommentArgs {
    key: string
    body: string
  }
  register<AddCommentArgs>(
    'add_comment',
    'Добавить комментарий',
    'Добавляет комментарий к задаче. Текст в Markdown, автор — владелец токена. '
      + 'Упоминания оформляются как @[Имя](user:<uuid>); для обычного текста это не нужно.',
    {
      key: z.string().min(1).max(32).describe('Ключ задачи, например DEV-1'),
      body: z.string().min(1).max(20000).describe('Текст комментария в Markdown'),
    },
    async ({ key, body }) => {
      const issue = await getIssue(client, key)
      assertWritable(config, issue.queue.key)
      const comment = await client.post<CommentDto>(`/issues/${encodeURIComponent(key)}/comments`, { body })
      return ok(
        `Комментарий добавлен к ${issue.key} (${comment.author.displayName}, ${comment.createdAt}).`,
        { key: issue.key, commentId: comment.id, author: comment.author.displayName },
      )
    },
  )

  // 4. Чтение задачи ---------------------------------------------------------
  interface GetTaskArgs {
    key: string
    includeComments?: boolean
  }
  register<GetTaskArgs>(
    'get_task',
    'Прочитать задачу',
    'Возвращает задачу по ключу: заголовок, описание, статус, очередь, проект, автора, '
      + 'приоритет, даты. С includeComments=true добавляет комментарии.',
    {
      key: z.string().min(1).max(32).describe('Ключ задачи, например DEV-1'),
      includeComments: z.boolean().optional().describe('Добавить комментарии (по умолчанию false)'),
    },
    async ({ key, includeComments }) => {
      const issue = await getIssue(client, key)
      let comments: CommentDto[] = []
      if (includeComments === true) {
        const list = await client.get<{ items: CommentDto[] }>(`/issues/${encodeURIComponent(key)}/comments`)
        comments = list.items
      }
      return ok(issueCard(issue, comments, config.webUrl), {
        key: issue.key,
        title: issue.title,
        description: issue.description,
        status: issue.status.key,
        statusName: issue.status.name,
        priority: issue.priority,
        queue: issue.queue.key,
        project: issue.project.slug,
        author: issue.author.displayName,
        assignee: issue.assignee?.displayName ?? null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        comments: comments.length,
      })
    },
  )

  // 5. Смена статуса ---------------------------------------------------------
  interface SetStatusArgs {
    key: string
    status: string
  }
  register<SetStatusArgs>(
    'set_task_status',
    'Сменить статус задачи',
    'Переводит задачу в другой статус. Статус задаётся ключом (in_progress) или именем '
      + '(«В работе»); допустимые значения — в list_queues. Переход разрешён из любого статуса '
      + 'в любой, включая закрытие.',
    {
      key: z.string().min(1).max(32).describe('Ключ задачи, например DEV-1'),
      status: z.string().min(1).max(120).describe('Ключ или имя нового статуса'),
    },
    async ({ key, status }) => {
      const issue = await getIssue(client, key)
      assertWritable(config, issue.queue.key)
      const target = await resolveStatusId(client, issue.queue.key, status)
      const updated = await client.patch<IssueDto>(`/issues/${encodeURIComponent(key)}`, {
        statusId: target.id,
      })
      return ok(`${issue.key}: статус ${issue.status.key} → ${updated.status.key} («${updated.status.name}»).`, {
        key: updated.key,
        statusFrom: issue.status.key,
        statusTo: updated.status.key,
        statusName: updated.status.name,
      })
    },
  )

  // 6. Справочник очередей и статусов ---------------------------------------
  // Без него агент угадывал бы ключи очередей и имена статусов: у остальных инструментов
  // нет способа узнать, что вообще существует в трекере.
  interface ListQueuesArgs {
    project?: string
  }
  register<ListQueuesArgs>(
    'list_queues',
    'Очереди и статусы',
    'Показывает проекты, их очереди и статусы каждой очереди (ключ, имя, категория). '
      + 'Можно ограничить одним проектом. Вызывайте перед созданием задачи или сменой '
      + 'статуса, чтобы не угадывать ключи.',
    {
      project: z.string().min(1).max(64).optional()
        .describe('Слаг проекта, например sweet-limit. По умолчанию — все проекты'),
    },
    async ({ project }) => {
      const projects = project === undefined
        ? (await client.get<{ items: ProjectDto[] }>('/projects')).items
        : [{ slug: project, name: project }]
      const blocks: string[] = []
      const byProject: Record<string, unknown> = {}
      const items: { project: string; key: string; name: string }[] = []
      for (const entry of projects) {
        const queues = await client.get<{ items: QueueDto[] }>(
          `/projects/${encodeURIComponent(entry.slug)}/queues`,
        )
        const lines = [`${entry.slug}: ${entry.name}`]
        for (const queue of queues.items) {
          const statuses = await listQueueStatuses(client, queue.key)
          lines.push(
            `  ${queue.key} («${queue.name}»): ${statuses.map((s) => `${s.key}=«${s.name}»`).join(', ')}`,
          )
          items.push({ project: entry.slug, key: queue.key, name: queue.name })
        }
        blocks.push(lines.join('\n'))
        byProject[entry.slug] = queues.items.map((q) => ({ key: q.key, name: q.name }))
      }
      const text = blocks.length > 0
        ? `Очереди трекера (в скобках — статусы в виде ключ=«имя»):\n${blocks.join('\n')}`
        : 'В трекере нет доступных проектов.'
      // `items` — плоский список для машин: по нему потребитель (например сервис дайджеста)
      // строит справочник очередей, не разбирая текст. `projects` оставлен для совместимости.
      return ok(text, { items, projects: byProject })
    },
  )

  // 7. Задачи очереди -------------------------------------------------------
  // Появился под сервис дайджеста: чтобы собрать активные задачи, нужен список с фильтром
  // по статусам, а не чтение по одному ключу — ключи заранее неизвестны.
  interface ListIssuesArgs {
    queue: string
    status?: string
    limit?: number
  }
  register<ListIssuesArgs>(
    'list_issues',
    'Задачи очереди',
    'Список задач очереди с фильтром по статусам (ключи или имена через запятую: '
      + 'in_progress,review или «В работе»). Отдаёт ключи, заголовки, статусы, исполнителей '
      + 'и приоритеты. Описания в списке нет — за ним get_task.',
    {
      queue: z.string().min(1).max(16).describe('Ключ очереди, например INFRA'),
      status: z.string().min(1).max(200).optional()
        .describe('Статусы через запятую: in_progress,review,testing или «В работе»'),
      limit: z.number().int().min(1).max(100).optional().describe('Сколько задач вернуть (по умолчанию 50)'),
    },
    async ({ queue, status, limit }) => {
      const statusKeys = status === undefined ? [] : await resolveStatusKeys(client, queue, status)
      const query = new URLSearchParams({ limit: String(limit ?? 50) })
      if (statusKeys.length > 0) query.set('status', statusKeys.join(','))

      const page = await client.get<{
        items: IssueRowDto[]
        total?: number
        nextCursor?: string | null
      }>(`/queues/${encodeURIComponent(queue)}/issues?${query.toString()}`)

      const filterNote = statusKeys.length > 0 ? `, статусы ${statusKeys.join(', ')}` : ''
      const text = page.items.length === 0
        ? `В очереди ${queue} нет задач${filterNote || ' с указанным фильтром'}.`
        : `Задачи очереди ${queue}${filterNote} (${page.items.length} из ${page.total ?? page.items.length}):\n`
          + page.items.map((row) => `- ${issueRowLine(row, config.webUrl)}`).join('\n')

      return ok(text, {
        queue,
        statuses: statusKeys,
        total: page.total ?? page.items.length,
        items: page.items.map((row) => ({
          key: row.key,
          title: row.title,
          // queue объектом: потребителю нужен ключ, а в строке списка очередь не приходит
          queue: { key: queue },
          status: { key: row.status.key, name: row.status.name, category: row.status.category },
          priority: row.priority,
          storyPoints: row.storyPoints,
          assignee: row.assignee === null
            ? null
            : {
                id: row.assignee.id,
                displayName: row.assignee.displayName,
                avatarUrl: row.assignee.avatarUrl,
              },
        })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      })
    },
  )

  // 8. Комментарии задачи ---------------------------------------------------
  interface ListCommentsArgs {
    key: string
    limit?: number
  }
  register<ListCommentsArgs>(
    'list_comments',
    'Комментарии задачи',
    'Комментарии задачи: автор, дата, текст. Поле total — сколько всего комментариев, '
      + 'по нему видно, идёт ли обсуждение.',
    {
      key: z.string().min(1).max(32).describe('Ключ задачи, например INFRA-1'),
      limit: z.number().int().min(1).max(100).optional().describe('Сколько вернуть (по умолчанию 20)'),
    },
    async ({ key, limit }) => {
      const page = await client.get<{
        items: CommentDto[]
        total?: number
        canComment?: boolean
      }>(`/issues/${encodeURIComponent(key)}/comments?limit=${limit ?? 20}`)
      const total = page.total ?? page.items.length
      const text = page.items.length === 0
        ? `У задачи ${key} комментариев нет.`
        : `Комментарии ${key} (${page.items.length} из ${total}):\n`
          + page.items
            .map((comment) => `- ${comment.author.displayName} (${comment.createdAt}): ${comment.body}`)
            .join('\n')

      return ok(text, {
        key,
        total,
        items: page.items.map((comment) => ({
          id: comment.id,
          body: comment.body,
          author: {
            id: comment.author.id,
            displayName: comment.author.displayName,
            avatarUrl: comment.author.avatarUrl,
          },
          createdAt: comment.createdAt,
          editedAt: comment.editedAt,
        })),
        ...(page.canComment === undefined ? {} : { canComment: page.canComment }),
      })
    },
  )
}
