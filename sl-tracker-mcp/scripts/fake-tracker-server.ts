/**
 * Стенд SL Tracker для локальных проверок: поднимает фальшивый API на заданном порту,
 * чтобы прогнать MCP-сервер и агента без боевого трекера и без PAT.
 *
 *   node --import tsx scripts/fake-tracker-server.ts [порт] [api-токен]
 *   # фальшивый SL Tracker: http://127.0.0.1:18999  (SL_API_TOKEN=pat-test-token)
 *
 * Реализует те же маршруты, что и `apps/api/test/mcp-smoke.e2e-spec.ts` в sl-tracker:
 * проекты, очереди, статусы, создание задачи, правка, комментарии, чтение.
 */
import { startFakeTracker } from '../tests/fake-tracker.js'

const port = Number(process.argv[2] ?? 18999)
const apiToken = process.argv[3] ?? 'pat-test-token'

const tracker = await startFakeTracker({ apiToken, port })
process.stderr.write(
  `фальшивый SL Tracker слушает ${tracker.url}\n`
  + `  для MCP-сервера: SL_API_URL=${tracker.url} SL_API_TOKEN=${apiToken}\n`,
)

const stop = async (): Promise<void> => {
  await tracker.close()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
