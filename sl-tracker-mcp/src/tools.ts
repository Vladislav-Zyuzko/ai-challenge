/**
 * Шесть инструментов MCP: пять операций над задачами из задания и один справочник.
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
  listQueueStatuses,
  resolveStatusId,
  type CommentDto,
  type IssueDto,
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

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { client, config, logger } = ctx

  const register = <A extends object>(
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, z.ZodType>,
    handler: (args: A) => Promise<TextResult>,
  ): void => {
    const readOnly = name === 'get_task' || name === 'list_queues'
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
  register(
    'list_queues',
    'Очереди и статусы',
    'Показывает проекты, их очереди и статусы каждой очереди (ключ, имя, категория). '
      + 'Вызывайте перед созданием задачи или сменой статуса, чтобы не угадывать ключи.',
    {},
    async () => {
      const projects = await client.get<{ items: ProjectDto[] }>('/projects')
      const blocks: string[] = []
      const structured: Record<string, unknown> = {}
      for (const project of projects.items) {
        const queues = await client.get<{ items: QueueDto[] }>(
          `/projects/${encodeURIComponent(project.slug)}/queues`,
        )
        const lines = [`${project.slug}: ${project.name}`]
        for (const queue of queues.items) {
          const statuses = await listQueueStatuses(client, queue.key)
          lines.push(
            `  ${queue.key} («${queue.name}»): ${statuses.map((s) => `${s.key}=«${s.name}»`).join(', ')}`,
          )
        }
        blocks.push(lines.join('\n'))
        structured[project.slug] = queues.items.map((q) => ({ key: q.key, name: q.name }))
      }
      const text = blocks.length > 0
        ? `Очереди трекера (в скобках — статусы в виде ключ=«имя»):\n${blocks.join('\n')}`
        : 'В трекере нет доступных проектов.'
      return ok(text, structured)
    },
  )
}
