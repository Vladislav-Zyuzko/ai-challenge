/**
 * Доменные типы SL Tracker и мелкие операции поверх API, общие для инструментов.
 *
 * Формы взяты из `docs/api/openapi.json` и из сквозного теста `apps/api/test/mcp-smoke.e2e-spec.ts`
 * (он ходит ровно теми же пятью вызовами, что и этот сервер).
 */
import { SlTrackerError, type SlTrackerClient } from './sl-tracker.js'

export interface IssueUser {
  readonly id: string
  readonly displayName: string
  readonly avatarUrl: string | null
}

export interface IssueStatus {
  readonly key: string
  readonly name: string
  readonly category: string
}

export interface IssueDto {
  readonly key: string
  readonly title: string
  readonly description: string | null
  readonly status: IssueStatus
  readonly priority: number
  readonly storyPoints: number | null
  readonly author: IssueUser
  readonly assignee: IssueUser | null
  readonly queue: { readonly key: string; readonly name: string }
  readonly project: { readonly slug: string; readonly name: string }
  readonly createdAt: string
  readonly updatedAt: string
}

export interface CommentDto {
  readonly id: string
  readonly body: string
  readonly author: IssueUser
  readonly createdAt: string
  readonly editedAt: string | null
}

/**
 * Строка списка задач (`GET /api/queues/{key}/issues`). Отличается от `IssueDto`:
 * в списке **нет** описания, автора и проекта — только то, что помещается в таблицу.
 * Описание добирается `get_task` по ключу.
 */
export interface IssueRowDto {
  readonly key: string
  readonly title: string
  readonly status: IssueStatus
  readonly priority: number
  readonly storyPoints: number | null
  readonly assignee: IssueUser | null
}

export interface QueueStatusDto {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly category: string
  readonly position: number
}

export interface QueueDto {
  readonly key: string
  readonly name: string
  readonly projectSlug?: string
}

export interface ProjectDto {
  readonly slug: string
  readonly name: string
}

interface ListDto<T> {
  readonly items: T[]
  readonly total?: number
}

const norm = (value: string): string => value.trim().toLowerCase()

/**
 * Превратить то, что назвал агент, в `statusId`.
 *
 * D-10: переход разрешён из любого статуса очереди в любой другой, поэтому проверять
 * «откуда → куда» не нужно. Ищем по `key` (`in_progress`) или по имени («В работе») —
 * в описании инструмента перечисляются оба варианта, и агент может прислать любой.
 */
export async function resolveStatusId(
  client: SlTrackerClient,
  queueKey: string,
  requested: string,
): Promise<QueueStatusDto> {
  const list = await client.get<ListDto<QueueStatusDto>>(`/queues/${encodeURIComponent(queueKey)}/statuses`)
  const wanted = norm(requested)
  const found = list.items.find((s) => norm(s.key) === wanted || norm(s.name) === wanted)
  if (found) return found

  const available = list.items.map((s) => `${s.key} («${s.name}»)`).join(', ')
  throw new SlTrackerError(
    'invalid_request',
    `в очереди ${queueKey} нет статуса «${requested}». Доступные: ${available || 'нет ни одного'}`,
  )
}

export async function getIssue(client: SlTrackerClient, key: string): Promise<IssueDto> {
  return client.get<IssueDto>(`/issues/${encodeURIComponent(key)}`)
}

/**
 * Фильтр по статусам для списка задач: принимает ключи (`in_progress,review`) и имена
 * («В работе») и возвращает ключи, которые понимает API.
 *
 * API фильтрует по ключам (`query.status.split(',')`), а агент может назвать статус
 * словом — ровно как в `set_task_status`. Неизвестное значение — ошибка со списком
 * доступных: молча отдать пустой список хуже, чем сказать, что статус назван неверно.
 */
export async function resolveStatusKeys(
  client: SlTrackerClient,
  queueKey: string,
  requested: string,
): Promise<string[]> {
  const tokens = requested.split(',').map((token) => token.trim()).filter((token) => token.length > 0)
  if (tokens.length === 0) return []

  const statuses = await listQueueStatuses(client, queueKey)
  const keys: string[] = []
  for (const token of tokens) {
    const wanted = norm(token)
    const found = statuses.find((status) => norm(status.key) === wanted || norm(status.name) === wanted)
    if (found === undefined) {
      const available = statuses.map((status) => `${status.key} («${status.name}»)`).join(', ')
      throw new SlTrackerError(
        'invalid_request',
        `в очереди ${queueKey} нет статуса «${token}». Доступные: ${available || 'нет ни одного'}`,
      )
    }
    if (!keys.includes(found.key)) keys.push(found.key)
  }
  return keys
}

export async function listQueueStatuses(
  client: SlTrackerClient,
  queueKey: string,
): Promise<QueueStatusDto[]> {
  const list = await client.get<ListDto<QueueStatusDto>>(`/queues/${encodeURIComponent(queueKey)}/statuses`)
  return list.items
}

/** Одна строка для модели: ключ, заголовок, статус, очередь, автор. */
export function issueLine(issue: IssueDto, webUrl?: string): string {
  const parts = [
    `${issue.key}: «${issue.title}»`,
    `статус ${issue.status.key} («${issue.status.name}»)`,
    `очередь ${issue.queue.key}`,
    `автор ${issue.author.displayName}`,
  ]
  const link = webUrl ? ` · ${webUrl}/issues/${issue.key}` : ''
  return parts.join(' · ') + link
}

/** Компактная карточка задачи для инструмента чтения. */
export function issueCard(issue: IssueDto, comments: CommentDto[], webUrl?: string): string {
  const lines = [
    `${issue.key}: ${issue.title}`,
    `статус: ${issue.status.key} («${issue.status.name}», ${issue.status.category})`,
    `очередь: ${issue.queue.key} («${issue.queue.name}»), проект ${issue.project.slug}`,
    `автор: ${issue.author.displayName}${issue.assignee ? `, исполнитель: ${issue.assignee.displayName}` : ''}`,
    `приоритет: ${issue.priority}${issue.storyPoints === null ? '' : `, оценка: ${issue.storyPoints}`}`,
    `создана: ${issue.createdAt}, изменена: ${issue.updatedAt}`,
  ]
  if (webUrl) lines.push(`ссылка: ${webUrl}/issues/${issue.key}`)
  lines.push('', 'описание:', issue.description?.trim() ? issue.description : '—')
  if (comments.length > 0) {
    lines.push('', `комментарии (${comments.length}):`)
    for (const comment of comments) {
      lines.push(`- ${comment.author.displayName} (${comment.createdAt}): ${comment.body}`)
    }
  }
  return lines.join('\n')
}

/** Одна строка списка задач для модели: ключ, заголовок, статус, исполнитель, приоритет. */
export function issueRowLine(row: IssueRowDto, webUrl?: string): string {
  const parts = [
    `${row.key}: «${row.title}»`,
    `статус ${row.status.key} («${row.status.name}»)`,
    `исполнитель ${row.assignee?.displayName ?? 'не назначен'}`,
    `приоритет ${row.priority}`,
  ]
  const link = webUrl ? ` · ${webUrl}/issues/${row.key}` : ''
  return parts.join(' · ') + link
}
