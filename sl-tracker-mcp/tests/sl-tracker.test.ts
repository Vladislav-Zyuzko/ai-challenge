/**
 * Клиент трекера: склейка адресов и перевод ошибок в доменные коды.
 *
 * Склейка — прямое требование sl-tracker (PR #1, п. 2): у API глобальный префикс `/api`,
 * и именно здесь, в одном месте, он добавляется. Ошибка 401 обязана читаться как
 * «машинный доступ кончился», а не как «инструмент не сработал».
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createLogger } from '../src/logger.js'
import { SlTrackerClient, SlTrackerError } from '../src/sl-tracker.js'
import { startFakeTracker, type FakeTracker } from './fake-tracker.js'

const silent = createLogger('error', () => {})

describe('SlTrackerClient', () => {
  it('добавляет префикс /api ровно один раз', () => {
    const client = new SlTrackerClient({
      baseUrl: 'http://api:3000',
      token: 't',
      timeoutMs: 1000,
      logger: silent,
    })
    assert.equal(client.apiUrl('/issues/DEV-1'), 'http://api:3000/api/issues/DEV-1')
    assert.equal(client.apiUrl('issues/DEV-1'), 'http://api:3000/api/issues/DEV-1')
    assert.equal(client.apiUrl('/queues/DEV/issues'), 'http://api:3000/api/queues/DEV/issues')
  })

  describe('ошибки и их подсказки', () => {
    let tracker: FakeTracker
    let client: SlTrackerClient

    before(async () => {
      tracker = await startFakeTracker({ apiToken: 'pat-test-token' })
      client = new SlTrackerClient({
        baseUrl: tracker.url,
        token: 'pat-test-token',
        timeoutMs: 2000,
        logger: silent,
      })
    })

    after(async () => {
      await tracker.close()
    })

    const cases: { status: number; code: string }[] = [
      { status: 401, code: 'machine_access_expired' },
      { status: 403, code: 'forbidden' },
      { status: 404, code: 'not_found' },
      { status: 409, code: 'conflict' },
      { status: 429, code: 'rate_limited' },
      { status: 400, code: 'invalid_request' },
    ]

    for (const { status, code } of cases) {
      it(`HTTP ${status} → ${code}`, async () => {
        tracker.forcedStatus = status
        try {
          await client.get('/me')
          assert.fail('должно было упасть')
        } catch (error) {
          assert.ok(error instanceof SlTrackerError)
          assert.equal(error.code, code)
          assert.equal(error.status, status)
        } finally {
          tracker.forcedStatus = null
        }
      })
    }

    it('при отозванном токене подсказка объясняет, что делать', async () => {
      tracker.forcedStatus = 401
      try {
        await client.get('/me')
        assert.fail('должно было упасть')
      } catch (error) {
        const hint = (error as SlTrackerError).hint()
        assert.match(hint, /токен отозван или истёк/)
        assert.match(hint, /Токены доступа/)
      } finally {
        tracker.forcedStatus = null
      }
    })

    it('при непривилегированной роли подсказка про права владельца токена', async () => {
      tracker.forcedStatus = 403
      try {
        await client.get('/me')
        assert.fail('должно было упасть')
      } catch (error) {
        assert.match((error as SlTrackerError).hint(), /роль — «читатель»/)
      } finally {
        tracker.forcedStatus = null
      }
    })

    it('недоступный трекер → unreachable с таймаутом', async () => {
      const broken = new SlTrackerClient({
        baseUrl: 'http://127.0.0.1:1',
        token: 'pat-test-token',
        timeoutMs: 1500,
        logger: silent,
      })
      await assert.rejects(
        () => broken.get('/me'),
        (error: unknown) => error instanceof SlTrackerError && error.code === 'unreachable',
      )
    })
  })
})
