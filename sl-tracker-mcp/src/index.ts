/**
 * Точка входа MCP-сервера SL Tracker.
 *
 * Транспорт выбирается переменной `SL_MCP_TRANSPORT`:
 * - `http` (по умолчанию) — удалённо, за Caddy, эндпоинт `/mcp`, `/healthz` для compose;
 * - `stdio` — локально: Claude Desktop, MCP Inspector, любой клиент, запускающий процесс.
 *
 * Пустые `SL_API_TOKEN` / `SL_MCP_TOKEN` — немедленный выход с внятным сообщением:
 * compose намеренно не страхует эти переменные (см. `config.ts`).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, loadConfig } from './config.js'
import { startHttpServer } from './http.js'
import { createLogger } from './logger.js'
import { createMcpServer, createToolContext } from './server.js'

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      // Ошибку конфигурации печатаем в stderr и выходим: молчаливый старт с пустым
      // токеном выглядел бы как рабочая установка, которая отвечает 401 на всё.
      process.stderr.write(`\nsl-tracker-mcp: ${error.message}\n\n`)
      process.exit(1)
    }
    throw error
  }

  const logger = createLogger(config.logLevel)
  const ctx = createToolContext(config, logger)

  if (config.transport === 'stdio') {
    const server = createMcpServer(ctx)
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // В stdio stdout занят протоколом, поэтому всё пишем в stderr.
    logger.info('MCP-сервер запущен на stdio', { readonly: config.readonlyMode })
    return
  }

  const handle = startHttpServer(config, ctx, logger)

  const shutdown = (signal: string): void => {
    logger.info('останавливаюсь', { signal })
    void handle.close().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  process.stderr.write(`\nsl-tracker-mcp: фатальная ошибка: ${(error as Error).message}\n\n`)
  process.exit(1)
})
