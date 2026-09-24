/**
 * Живая проверка MCP-сервера: соединение, список инструментов, справочник очередей
 * и (если задан ключ) чтение задачи. Нужна на выкате — «агент вызвал инструмент
 * и получил результат», но без агента.
 *
 * Запуск (сервер уже поднят, локально или на сервере):
 *   SL_MCP_URL=http://127.0.0.1:8080 SL_MCP_TOKEN=<токен клиента> \
 *   node --import tsx scripts/smoke-live.ts [КЛЮЧ-ЗАДАЧИ]
 *
 * Код возврата: 0 — всё хорошо, 1 — что-то не сработало (можно вставлять в чек-лист выката).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = process.env.SL_MCP_URL ?? 'http://127.0.0.1:8080'
const token = process.env.SL_MCP_TOKEN ?? ''
const issueKey = process.argv[2]

/** Принимаем и `https://host:port`, и `https://host:port/mcp` — приводим к эндпоинту. */
const endpoint = (() => {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (/\/mcp$/.test(trimmed)) return trimmed
  return `${trimmed}/mcp`
})()

if (!token) {
  process.stderr.write('нужен SL_MCP_TOKEN — токен MCP-клиента (не токен трекера)\n')
  process.exit(1)
}

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})
const client = new Client({ name: 'sl-tracker-mcp-smoke', version: '0.1.0' })

const textOf = (result: unknown): string => {
  const payload = result as { content?: { type: string; text?: string }[]; isError?: boolean }
  return (payload.content ?? []).map((block) => block.text ?? '').join('\n')
    + (payload.isError === true ? '\n(инструмент вернул ошибку)' : '')
}

/** Для чек-листа выката ошибка инструмента — это провал проверки, а не «просто текст». */
const failed = (result: unknown): boolean => (result as { isError?: boolean }).isError === true

try {
  await client.connect(transport)
  process.stdout.write(`✔ соединение с ${url}/mcp установлено\n`)

  const { tools } = await client.listTools()
  process.stdout.write(`✔ инструментов: ${tools.length} — ${tools.map((t) => t.name).join(', ')}\n`)

  const queues = await client.callTool({ name: 'list_queues', arguments: {} })
  process.stdout.write('\n--- list_queues ---\n' + textOf(queues) + '\n')

  let bad = failed(queues)

  if (issueKey !== undefined) {
    const issue = await client.callTool({ name: 'get_task', arguments: { key: issueKey, includeComments: true } })
    process.stdout.write(`\n--- get_task ${issueKey} ---\n` + textOf(issue) + '\n')
    bad = bad || failed(issue)
  }

  await client.close()
  if (bad) {
    process.stderr.write('\n✖ проверка не прошла: инструмент вернул ошибку (см. вывод выше)\n')
    process.exit(1)
  }
  process.stdout.write('\nготово\n')
  process.exit(0)
} catch (error) {
  process.stderr.write(`✖ проверка не прошла: ${(error as Error).message}\n`)
  await client.close().catch(() => {})
  process.exit(1)
}
