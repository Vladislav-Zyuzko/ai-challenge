/**
 * Конфигурация MCP-сервера: только переменные окружения, ничего из dsh.
 *
 * Ключевое требование sl-tracker (комментарий в PR #1, п. 1): compose больше НЕ страхует
 * от пустого токена — `:?` пришлось убрать, потому что compose подставляет переменные во
 * весь файл до отсева сервисов по профилям. Поэтому сервер обязан **падать на старте**
 * с внятным сообщением, если `SL_API_TOKEN` или `SL_MCP_TOKEN` пусты: подняться молча
 * и отвечать 401 на каждый вызов — худший вариант.
 */

export interface Config {
  /** Куда ходить за данными трекера. У API глобальный префикс `/api` — см. `apiUrl()`. */
  readonly apiUrl: string;
  /** PAT участника проекта: права MCP равны правам этого человека. */
  readonly apiToken: string;
  /** Токен, который предъявляют MCP-клиенты (dsh-term, Claude Code, Inspector). */
  readonly mcpToken: string;
  /** Транспорт: `http` (удалённо, за Caddy) или `stdio` (локально). */
  readonly transport: 'http' | 'stdio';
  readonly host: string;
  readonly port: number;
  /** `1` — все изменяющие инструменты отказывают: начинаем с чтения. */
  readonly readonlyMode: boolean;
  /** Пусто — можно все очереди; иначе только перечисленные. */
  readonly allowedQueues: readonly string[];
  /** Очередь по умолчанию, если инструмент не назвал её явно. */
  readonly defaultQueue: string | undefined;
  /** Публичный адрес веб-интерфейса: из него собираем ссылки на задачи в ответах. */
  readonly webUrl: string | undefined;
  /** Разрешённые источники для заголовка `Origin`. Пустой список — не проверять. */
  readonly allowedOrigins: readonly string[];
  /** Stateful-режим Streamable HTTP: клиенты, которым нужен `Mcp-Session-Id`. */
  readonly stateful: boolean;
  /** Отвечать JSON-ом вместо SSE (удобно для curl; SSE — по умолчанию). */
  readonly jsonResponse: boolean;
  readonly timeoutMs: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function flag(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return TRUTHY.has(raw.trim().toLowerCase());
}

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Разбор env. Бросает `ConfigError` — вызывающий обязан показать сообщение и выйти. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = (env.SL_API_TOKEN ?? '').trim();
  const mcpToken = (env.SL_MCP_TOKEN ?? '').trim();

  // Оба токена обязательны. Подсказка про compose — потому что оттуда приходит пустая
  // строка, а не отсутствие переменной, и «тихий» старт с пустым токеном выглядит как
  // рабочая установка, которая отвечает 401 на всё.
  const missing: string[] = [];
  if (!apiToken) missing.push('SL_API_TOKEN (PAT участника: профиль → Доступ → Токены доступа)');
  if (!mcpToken) missing.push('SL_MCP_TOKEN (токен для MCP-клиентов: openssl rand -hex 32)');
  if (missing.length > 0) {
    throw new ConfigError(
      'не заданы обязательные переменные:\n  - ' + missing.join('\n  - ')
      + '\n\nВ docker compose переменные приходят как `${MCP_SL_API_TOKEN:-}` / `${MCP_CLIENT_TOKEN:-}`,'
      + '\nпоэтому пустое значение нужно заполнить в .env на сервере. Сервер намеренно не стартует:'
      + '\nподняться с пустым токеном и отвечать 401 на каждый вызов — худший из вариантов.',
    );
  }

  const transport = (env.SL_MCP_TRANSPORT ?? 'http').trim().toLowerCase();
  if (transport !== 'http' && transport !== 'stdio') {
    throw new ConfigError(`SL_MCP_TRANSPORT должен быть http или stdio, получено: ${transport}`);
  }

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT должен быть целым 1..65535, получено: ${env.PORT}`);
  }

  const timeoutMs = Number(env.SL_API_TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new ConfigError(`SL_API_TIMEOUT_MS должен быть числом ≥ 1000, получено: ${env.SL_API_TIMEOUT_MS}`);
  }

  const logLevel = (env.SL_LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError(`SL_LOG_LEVEL: debug | info | warn | error, получено: ${logLevel}`);
  }

  return {
    apiUrl: (env.SL_API_URL ?? 'http://api:3000').trim().replace(/\/+$/, ''),
    apiToken,
    mcpToken,
    transport: transport === 'stdio' ? 'stdio' : 'http',
    host: (env.SL_MCP_HOST ?? '0.0.0.0').trim(),
    port,
    readonlyMode: flag(env.SL_MCP_READONLY, false),
    allowedQueues: list(env.SL_MCP_ALLOWED_QUEUES),
    defaultQueue: (env.SL_DEFAULT_QUEUE ?? '').trim() || undefined,
    webUrl: (env.SL_WEB_URL ?? '').trim().replace(/\/+$/, '') || undefined,
    allowedOrigins: list(env.SL_MCP_ALLOWED_ORIGINS),
    stateful: flag(env.SL_MCP_STATEFUL, false),
    jsonResponse: flag(env.SL_MCP_JSON_RESPONSE, false),
    timeoutMs: Math.floor(timeoutMs),
    logLevel: logLevel as Config['logLevel'],
  };
}
