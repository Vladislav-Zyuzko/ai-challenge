/**
 * Тонкий клиент SL Tracker API.
 *
 * Второе требование из PR #1 (п. 2): у API **глобальный префикс `/api`** —
 * маршруты живут по `http://api:3000/api/issues/...`, а не `/issues/...`.
 * Поэтому путь склеивается ровно в одном месте (`apiUrl()`), а не по коду инструментов:
 * имя переменной `SL_API_URL` провоцирует забыть префикс, и это ловится тестом.
 *
 * Ошибки переводятся в доменные коды, потому что для агента «401 от трекера» — это не
 * «инструмент не сработал», а «машинный доступ кончился: токен отозван или истёк».
 */
import type { Logger } from './logger.js'

export type SlErrorCode =
  | 'machine_access_expired'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'conflict'
  | 'rate_limited'
  | 'unreachable'
  | 'bad_response'

export class SlTrackerError extends Error {
  override readonly name = 'SlTrackerError'

  constructor(
    readonly code: SlErrorCode,
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message)
  }

  /** Короткий текст для модели: код + что делать. Без внутренних деталей. */
  hint(): string {
    switch (this.code) {
      case 'machine_access_expired':
        return 'Машинный доступ к трекеру закончился: токен отозван или истёк. '
          + 'Выпустите новый токен (профиль → Доступ → Токены доступа) и обновите SL_API_TOKEN.'
      case 'forbidden':
        return 'Трекер отказал по правам: у владельца токена нет доступа к этому проекту или '
          + 'его роль — «читатель». Права MCP равны правам владельца токена.'
      case 'not_found':
        return 'Задача, очередь или проект не найдены — проверьте ключ (например DEV-1).'
      case 'invalid_request':
        return 'Трекер отклонил данные: проверьте поля запроса.'
      case 'conflict':
        return 'Конфликт состояния в трекере — перечитайте задачу и повторите.'
      case 'rate_limited':
        return 'Слишком частые запросы к трекеру — повторите через минуту.'
      case 'unreachable':
        return 'Трекер недоступен: проверьте SL_API_URL и что API запущен.'
      default:
        return 'Трекер вернул неожиданный ответ.'
    }
  }
}

export interface SlTrackerClientOptions {
  readonly baseUrl: string
  readonly token: string
  readonly timeoutMs: number
  readonly logger: Logger
  /** Подменяемый fetch: тесты подставляют свой, в бою — глобальный. */
  readonly fetchImpl?: typeof fetch
}

/** Ответ API с `code`/`message` в теле ошибки — формат проекта (ValidationPipe). */
interface ApiErrorBody {
  code?: string
  message?: string
}

export class SlTrackerClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: SlTrackerClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Абсолютный адрес маршрута API. Префикс `/api` добавляется здесь и только здесь.
   */
  apiUrl(path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`
    return `${this.options.baseUrl}/api${normalized}`
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = this.apiUrl(path)
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          // Права MCP = права владельца токена: отдельной машинной учётки в трекере нет.
          Authorization: `Bearer ${this.options.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'AbortError'
      this.options.logger.warn('sl-tracker недоступен', {
        method,
        path,
        ms: Date.now() - started,
        aborted,
      })
      throw new SlTrackerError(
        'unreachable',
        aborted
          ? `таймаут ${this.options.timeoutMs} мс при обращении к трекеру`
          : `сеть недоступна: ${(error as Error).message}`,
      )
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    const parsed = text.length > 0 ? safeJson(text) : undefined

    if (!response.ok) {
      const body = (parsed ?? {}) as ApiErrorBody
      const detail = body.message ?? body.code ?? response.statusText
      this.options.logger.warn('sl-tracker вернул ошибку', {
        method,
        path,
        status: response.status,
        code: body.code,
      })
      throw new SlTrackerError(mapStatus(response.status), `HTTP ${response.status}: ${detail}`, response.status, parsed)
    }

    this.options.logger.debug('sl-tracker ок', { method, path, status: response.status, ms: Date.now() - started })
    return (parsed ?? (undefined as T)) as T
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body)
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function mapStatus(status: number): SlErrorCode {
  switch (status) {
    case 401:
      return 'machine_access_expired'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 429:
      return 'rate_limited'
    default:
      return status >= 400 && status < 500 ? 'invalid_request' : 'bad_response'
  }
}
