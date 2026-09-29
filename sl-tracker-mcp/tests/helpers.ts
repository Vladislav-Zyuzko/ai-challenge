/** Общие помощники тестов: свободный порт и клиент MCP поверх Streamable HTTP. */
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('не удалось определить свободный порт'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

export interface ToolText {
  readonly text: string
  readonly isError: boolean
  readonly structured?: Record<string, unknown>
}

/** Достаёт текст и признак ошибки из ответа инструмента. */
export function toolText(result: unknown): ToolText {
  const payload = result as {
    content?: { type: string; text?: string }[]
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  return {
    text,
    isError: payload.isError === true,
    ...(payload.structuredContent ? { structured: payload.structuredContent } : {}),
  }
}

export interface ConnectedClient {
  readonly client: Client
  close(): Promise<void>
}

/** Подключает настоящий MCP-клиент к нашему серверу по HTTP с bearer-токеном. */
export async function connectHttpClient(
  url: string,
  token: string | undefined,
  headers: Record<string, string> = {},
): Promise<ConnectedClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: {
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
      },
    },
  })
  const client = new Client({ name: 'sl-tracker-mcp-test', version: '0.0.1' })
  await client.connect(transport)
  return { client, close: () => client.close() }
}
