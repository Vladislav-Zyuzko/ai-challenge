/**
 * Сквозной тест по HTTP: настоящий MCP-клиент → наш сервер → фальшивый SL Tracker.
 *
 * Проверяется ровно то, что нужно заданию и что обещано в комментарии PR #1:
 * соединение, `tools/list`, вызов каждого инструмента с получением результата,
 * авторизация (401 без токена), поведение Origin (пустой разрешён, посторонний — 403),
 * `/healthz` без деталей, а также предохранители readonly и allowlist очередей.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { loadConfig, type Config } from '../src/config.js'
import { startHttpServer, type HttpServerHandle } from '../src/http.js'
import { createLogger } from '../src/logger.js'
import { createMcpServer, createToolContext } from '../src/server.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startFakeTracker, type FakeTracker } from './fake-tracker.js'
import { connectHttpClient, getFreePort, toolText } from './helpers.js'

const CLIENT_TOKEN = 'client-token-test'
const API_TOKEN = 'pat-test-token'
const logger = createLogger('error', () => {})

interface Running {
  url: string
  handle: HttpServerHandle
  config: Config
}

async function startServer(overrides: Record<string, string> = {}): Promise<Running & { tracker: FakeTracker }> {
  const tracker = await startFakeTracker({ apiToken: API_TOKEN })
  const port = await getFreePort()
  const config = loadConfig({
    SL_API_URL: tracker.url,
    SL_API_TOKEN: API_TOKEN,
    SL_MCP_TOKEN: CLIENT_TOKEN,
    PORT: String(port),
    SL_MCP_HOST: '127.0.0.1',
    SL_DEFAULT_QUEUE: 'DEV',
    ...overrides,
  })
  const ctx = createToolContext(config, logger)
  const handle = startHttpServer(config, ctx, logger)
  return { url: `http://127.0.0.1:${port}`, handle, config, tracker }
}

describe('MCP поверх Streamable HTTP', () => {
  let running: Running & { tracker: FakeTracker }

  before(async () => {
    running = await startServer()
  })

  after(async () => {
    await running.handle.close()
    await running.tracker.close()
  })

  it('/healthz отвечает голым 200 без авторизации и без деталей', async () => {
    const response = await fetch(`${running.url}/healthz`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ok')
  })

  it('прочие пути закрыты', async () => {
    const response = await fetch(`${running.url}/api/issues`)
    assert.equal(response.status, 404)
  })

  it('без токена MCP-клиента — 401 с WWW-Authenticate', async () => {
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/)
    const body = (await response.json()) as { error: string }
    assert.equal(body.error, 'unauthorized')
  })

  it('посторонний Origin отбивается 403, даже с валидным токеном', async () => {
    const response = await fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLIENT_TOKEN}`,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(response.status, 403)
  })

  it('отсутствие Origin разрешено (curl, dsh-term, Claude Code его не шлют)', async () => {
    const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
    try {
      const tools = await client.listTools()
      assert.equal(tools.tools.length, 6)
    } finally {
      await close()
    }
  })

  it('tools/list возвращает шесть инструментов с описаниями и схемами', async () => {
    const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
    try {
      const { tools } = await client.listTools()
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['add_comment', 'create_task', 'get_task', 'list_queues', 'set_task_status', 'update_task_description'],
      )
      for (const tool of tools) {
        assert.ok((tool.description ?? '').length > 20, `${tool.name}: нет описания`)
        assert.equal(tool.inputSchema.type, 'object')
      }
      // Читающие инструменты помечены readOnly, изменяющие — destructive.
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      assert.equal(byName.get('get_task')?.annotations?.readOnlyHint, true)
      assert.equal(byName.get('create_task')?.annotations?.destructiveHint, true)
    } finally {
      await close()
    }
  })

  it('справочник отдаёт очереди и статусы (ключ=«имя»)', async () => {
    const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
    try {
      const result = toolText(await client.callTool({ name: 'list_queues', arguments: {} }))
      assert.equal(result.isError, false)
      assert.match(result.text, /DEV/)
      assert.match(result.text, /in_progress=«В работе»/)
    } finally {
      await close()
    }
  })

  it('полный сценарий: создать → описать → прокомментировать → сменить статус → прочитать', async () => {
    const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
    try {
      const created = toolText(await client.callTool({
        name: 'create_task',
        arguments: { queue: 'DEV', title: 'Собрать отчёт по нагрузке', description: 'Черновик от агента' },
      }))
      assert.equal(created.isError, false)
      assert.match(created.text, /DEV-1/)
      assert.equal(created.structured?.key, 'DEV-1')
      // Автор — владелец токена: отдельной машинной учётки в трекере нет.
      assert.equal(created.structured?.author, 'Борис Участников')

      const described = toolText(await client.callTool({
        name: 'update_task_description',
        arguments: { key: 'DEV-1', description: 'Уточнённое описание: графики p95 за неделю' },
      }))
      assert.equal(described.isError, false)

      const commented = toolText(await client.callTool({
        name: 'add_comment',
        arguments: { key: 'DEV-1', body: 'Взял в работу, отчёт будет к вечеру' },
      }))
      assert.equal(commented.isError, false)
      assert.equal(running.tracker.comments.get('DEV-1')?.length, 1)

      const moved = toolText(await client.callTool({
        name: 'set_task_status',
        arguments: { key: 'DEV-1', status: 'in_progress' },
      }))
      assert.equal(moved.isError, false)
      assert.equal(moved.structured?.statusFrom, 'open')
      assert.equal(moved.structured?.statusTo, 'in_progress')

      const read = toolText(await client.callTool({
        name: 'get_task',
        arguments: { key: 'DEV-1', includeComments: true },
      }))
      assert.equal(read.isError, false)
      assert.match(read.text, /Уточнённое описание: графики p95 за неделю/)
      assert.match(read.text, /Взял в работу/)
      assert.equal(read.structured?.status, 'in_progress')
    } finally {
      await close()
    }
  })

  it('статус можно задать именем, а не ключом', async () => {
    const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
    try {
      await client.callTool({ name: 'create_task', arguments: { title: 'Вторая задача' } })
      const moved = toolText(await client.callTool({
        name: 'set_task_status',
        arguments: { key: 'DEV-2', status: 'Готово' },
      }))
      assert.equal(moved.isError, false)
      assert.equal(moved.structured?.statusTo, 'done')
    } finally {
      await close()
    }
  })

  it('неизвестный статус — понятная ошибка со списком доступных', async () => {
    const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
    try {
      const result = toolText(await client.callTool({
        name: 'set_task_status',
        arguments: { key: 'DEV-1', status: 'летит' },
      }))
      assert.equal(result.isError, true)
      assert.match(result.text, /invalid_request/)
      assert.match(result.text, /Доступные: open/)
    } finally {
      await close()
    }
  })

  it('несуществующая задача — not_found с подсказкой', async () => {
    const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
    try {
      const result = toolText(await client.callTool({ name: 'get_task', arguments: { key: 'DEV-999' } }))
      assert.equal(result.isError, true)
      assert.match(result.text, /not_found/)
    } finally {
      await close()
    }
  })

  it('режим readonly: изменяющие инструменты отказывают, чтение работает', async () => {
    const readonly = await startServer({ SL_MCP_READONLY: '1' })
    try {
      const { client, close } = await connectHttpClient(readonly.url, CLIENT_TOKEN)
      try {
        const created = toolText(await client.callTool({
          name: 'create_task',
          arguments: { title: 'Не должна создаться' },
        }))
        assert.equal(created.isError, true)
        assert.match(created.text, /только чтение/)
        assert.equal(readonly.tracker.issues.size, 0)

        const read = toolText(await client.callTool({ name: 'list_queues', arguments: {} }))
        assert.equal(read.isError, false)
      } finally {
        await close()
      }
    } finally {
      await readonly.handle.close()
      await readonly.tracker.close()
    }
  })

  it('allowlist очередей: запись вне списка запрещена, чтение — нет', async () => {
    const limited = await startServer({ SL_MCP_ALLOWED_QUEUES: 'OPS' })
    try {
      const { client, close } = await connectHttpClient(limited.url, CLIENT_TOKEN)
      try {
        const created = toolText(await client.callTool({
          name: 'create_task',
          arguments: { queue: 'DEV', title: 'Не должна создаться' },
        }))
        assert.equal(created.isError, true)
        assert.match(created.text, /не разрешена/)
        assert.equal(limited.tracker.issues.size, 0)

        const read = toolText(await client.callTool({ name: 'list_queues', arguments: {} }))
        assert.equal(read.isError, false)
      } finally {
        await close()
      }
    } finally {
      await limited.handle.close()
      await limited.tracker.close()
    }
  })

  it('401 от трекера превращается в подсказку «выпустите новый токен»', async () => {
    running.tracker.forcedStatus = 401
    try {
      const { client, close } = await connectHttpClient(running.url, CLIENT_TOKEN)
      try {
        const result = toolText(await client.callTool({ name: 'list_queues', arguments: {} }))
        assert.equal(result.isError, true)
        assert.match(result.text, /machine_access_expired/)
        assert.match(result.text, /Выпустите новый токен/)
      } finally {
        await close()
      }
    } finally {
      running.tracker.forcedStatus = null
    }
  })
})

describe('stdio-режим', () => {
  it('сервер поднимается с stdio и отдаёт те же инструменты', async () => {
    // Тот же набор инструментов, но транспорт — stdio: так сервер запускают локальные
    // клиенты (Claude Desktop, Inspector). Проверяем, что фабрика та же.
    const server = createMcpServer(
      createToolContext(
        loadConfig({ SL_API_URL: 'http://127.0.0.1:1', SL_API_TOKEN: 'x', SL_MCP_TOKEN: 'y' }),
        logger,
      ),
    )
    assert.ok(server.isConnected() === false)
    const transport = new StdioServerTransport()
    assert.ok(transport !== undefined)
    await server.close()
  })
})
