/**
 * Логгер без зависимостей. Пишет в stderr (stdout занят транспортом stdio!) и никогда
 * не печатает токены: наружу уходят только имена инструментов, коды ошибок и тайминги.
 */
import type { Config } from './config.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

export type LogLevel = keyof typeof LEVELS

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** Слова, которые нельзя печатать целиком: даже случайный лог не должен утечь секрет. */
const SECRET_KEYS = /token|authorization|secret|cookie/i

function scrub(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : value
  }
  return out
}

export function createLogger(level: LogLevel, sink: (line: string) => void = (line) => process.stderr.write(line + '\n')): Logger {
  const threshold = LEVELS[level]
  const emit = (name: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[name] < threshold) return
    const safe = scrub(fields)
    const tail = safe && Object.keys(safe).length > 0 ? ' ' + JSON.stringify(safe) : ''
    sink(`${new Date().toISOString()} ${name.toUpperCase()} ${message}${tail}`)
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  }
}

export function loggerOf(config: Config): Logger {
  return createLogger(config.logLevel)
}
