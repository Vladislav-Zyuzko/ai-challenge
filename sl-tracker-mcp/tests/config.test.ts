/**
 * Конфигурация: главное здесь — **падение на старте при пустом токене**.
 * Это требование sl-tracker: compose больше не страхует переменные (`:?` убрали,
 * потому что оно ломало весь стек), поэтому сервер обязан отказаться работать.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, loadConfig } from '../src/config.js'

const base = {
  SL_API_TOKEN: 'pat-token',
  SL_MCP_TOKEN: 'client-token',
}

describe('loadConfig', () => {
  it('падает, если SL_API_TOKEN пуст', () => {
    assert.throws(
      () => loadConfig({ ...base, SL_API_TOKEN: '' }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('SL_API_TOKEN'),
    )
  })

  it('падает, если SL_MCP_TOKEN пуст (compose передаёт пустую строку)', () => {
    assert.throws(
      () => loadConfig({ ...base, SL_MCP_TOKEN: '   ' }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('SL_MCP_TOKEN'),
    )
  })

  it('в сообщении об ошибке есть подсказка, куда идти за PAT', () => {
    try {
      loadConfig({ ...base, SL_API_TOKEN: '' })
      assert.fail('должно было упасть')
    } catch (error) {
      assert.match((error as Error).message, /профиль → Доступ → Токены доступа/)
      assert.match((error as Error).message, /compose/)
    }
  })

  it('значения по умолчанию: http, 8080, таймаут 15с, запись разрешена, stateless', () => {
    const config = loadConfig(base)
    assert.equal(config.apiUrl, 'http://api:3000')
    assert.equal(config.transport, 'http')
    assert.equal(config.port, 8080)
    assert.equal(config.timeoutMs, 15000)
    assert.equal(config.readonlyMode, false)
    assert.equal(config.stateful, false)
    assert.deepEqual(config.allowedQueues, [])
  })

  it('срезает хвостовые слэши у адресов и читает флаги', () => {
    const config = loadConfig({
      ...base,
      SL_API_URL: 'http://api:3000///',
      SL_WEB_URL: 'https://tracker.example.com:8443/',
      SL_MCP_READONLY: '1',
      SL_MCP_STATEFUL: 'yes',
    })
    assert.equal(config.apiUrl, 'http://api:3000')
    assert.equal(config.webUrl, 'https://tracker.example.com:8443')
    assert.equal(config.readonlyMode, true)
    assert.equal(config.stateful, true)
  })

  it('разбирает allowlist очередей, схлопывая дубликаты', () => {
    const config = loadConfig({ ...base, SL_MCP_ALLOWED_QUEUES: 'DEV, OPS ,DEV; QA' })
    assert.deepEqual(config.allowedQueues, ['DEV', 'OPS', 'QA'])
  })

  it('отклоняет неизвестный транспорт, плохой порт и уровень логов', () => {
    assert.throws(() => loadConfig({ ...base, SL_MCP_TRANSPORT: 'sse' }), ConfigError)
    assert.throws(() => loadConfig({ ...base, PORT: '0' }), ConfigError)
    assert.throws(() => loadConfig({ ...base, SL_LOG_LEVEL: 'verbose' }), ConfigError)
    assert.throws(() => loadConfig({ ...base, SL_API_TIMEOUT_MS: '10' }), ConfigError)
  })
})
