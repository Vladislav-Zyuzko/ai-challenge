/**
 * MCP-сервер как объект: фабрика нужна потому, что в stateless-режиме Streamable HTTP
 * на каждый запрос поднимается отдельный экземпляр (состояния между вызовами у нас нет).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Config } from './config.js'
import type { Logger } from './logger.js'
import { SlTrackerClient } from './sl-tracker.js'
import { registerTools, type ToolContext } from './tools.js'

export const SERVER_NAME = 'sl-tracker-mcp'
export const SERVER_VERSION = '0.1.0'

/** Инструкция серверу-клиенту: попадает в контекст модели один раз, поэтому коротко. */
const INSTRUCTIONS = [
  'Инструменты трекера задач SL Tracker: создание задачи, правка описания, комментарии,',
  'чтение задачи, смена статуса. Ключи задач выглядят как DEV-1. Перед созданием задачи',
  'или сменой статуса вызовите list_queues, чтобы узнать ключи очередей и статусов.',
  'Инструменты работают от имени владельца токена: права и авторство — его.',
].join(' ')

export function createToolContext(config: Config, logger: Logger): ToolContext {
  return {
    config,
    logger,
    client: new SlTrackerClient({
      baseUrl: config.apiUrl,
      token: config.apiToken,
      timeoutMs: config.timeoutMs,
      logger,
    }),
  }
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  )
  registerTools(server, ctx)
  return server
}
