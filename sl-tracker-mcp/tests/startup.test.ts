/**
 * Процессный тест: сервер обязан **упасть на старте**, если токены пусты.
 *
 * Это прямое требование sl-tracker (PR #1, п. 1): из compose переменные приходят как
 * `${MCP_SL_API_TOKEN:-}`, то есть пустой строкой, и compose больше не страхует.
 * Проверяем именно поведение процесса — код возврата и текст в stderr, — потому что
 * «тихий» старт с пустым токеном выглядит как рабочая установка, отвечающая 401 на всё.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'index.ts')

interface RunResult {
  code: number | null
  stderr: string
}

function run(env: Record<string, string>, timeoutMs = 20000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      env: { ...process.env, SL_MCP_TRANSPORT: 'stdio', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('процесс не завершился: похоже, он стартовал с пустым токеном'))
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
    child.on('error', reject)
  })
}

describe('старт процесса', () => {
  it('пустой SL_API_TOKEN → выход с кодом 1 и внятным сообщением', async () => {
    const result = await run({ SL_API_TOKEN: '', SL_MCP_TOKEN: 'client-token' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /SL_API_TOKEN/)
    assert.match(result.stderr, /Токены доступа/)
  })

  it('пустой SL_MCP_TOKEN → выход с кодом 1', async () => {
    const result = await run({ SL_API_TOKEN: 'pat', SL_MCP_TOKEN: '   ' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /SL_MCP_TOKEN/)
    assert.match(result.stderr, /openssl rand -hex 32/)
  })

  it('оба токена пусты → в сообщении перечислены оба', async () => {
    const result = await run({ SL_API_TOKEN: '', SL_MCP_TOKEN: '' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /SL_API_TOKEN/)
    assert.match(result.stderr, /SL_MCP_TOKEN/)
  })
})
