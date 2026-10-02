/**
 * Драйвер длинного диалога: прогоняет сценарий дня 25 в живой сессии dsh-term
 * и сохраняет расшифровку для проверки.
 *
 * Зачем отдельный драйвер, а не «просто чат руками»: задание требует проверить
 * 2 сценария по 10–15 сообщений на удержание цели и источники — значит нужен
 * воспроизводимый прогон, из которого считается статистика.
 *
 * Что важно в реализации:
 * - сессия настоящая (dsh-term + харнесс), а не эмуляция;
 * - старт всегда с `/new`: прогон самодостаточен, память задачи начинается с нуля;
 * - синхронизация по «тишине» вывода и возврату промпта `dsh>`: ждать только маркер
 *   конца хода недостаточно — хвост предыдущего хода успевает приехать позже и
 *   ловится как конец следующего;
 * - NO_COLOR: нужен чистый текст для разбора (markdown-рендер здесь мешает);
 * - сохраняем ответы, вызовы инструментов, сырой вывод хода и id сессии — по id
 *   потом читается память задачи из context/<id>.json.
 *
 * Запуск: node dsh-term/tools/run-scenario.mjs <id> [--turns N] [--out <каталог>]
 *         node dsh-term/tools/run-scenario.mjs --list
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const preload = join(here, '..', 'tests', 'fake-tty.cjs')
const repo = join(here, '..', '..')
const scenariosPath = join(here, '..', 'scenarios', 'chat-dialogues.json')

const args = process.argv.slice(2)
const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8'))

if (args.includes('--list') || args.length === 0) {
  for (const s of scenarios.scenarios) {
    console.log(`${s.id} · ${s.title} · ходов: ${s.turns.length}`)
  }
  process.exit(0)
}

const scenarioId = args[0]
const scenario = scenarios.scenarios.find((s) => s.id === scenarioId)
if (!scenario) {
  console.error(`нет сценария ${scenarioId}; доступны: ${scenarios.scenarios.map((s) => s.id).join(', ')}`)
  process.exit(2)
}
const flag = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : fallback
}
const outDir = flag('--out', join(repo, 'doc-index', 'out'))
const turnsLimit = Number(flag('--turns', Infinity))
const ragBase = process.env.SCENARIO_RAG || 'effective-ai'
const turnTimeoutMs = Number(process.env.SCENARIO_TURN_TIMEOUT || 240000)
const dshHome = process.env.USERPROFILE || process.env.HOME || ''
mkdirSync(outDir, { recursive: true })

const startedAt = Date.now()
const child = spawn(process.execPath, ['--require', preload, dshTerm,
  '--strategy', 'facts', '--rag', ragBase], {
  cwd: repo,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NO_COLOR: '1',
    DSH_TEST_COLS: '120',
    // Прогон идёт без человека: подтверждения доступа некому нажимать, а висящий
    // запрос выглядит как «ход не завершился».
    DSH_TERM_AUTO_APPROVE: '1',
    // Инструмент «спроси пользователя» рисует меню и ждёт выбора — в автоматическом
    // прогоне это вечное ожидание. Без него агент отвечает сам (или честно говорит,
    // что данных нет).
    DSH_TERM_NO_ASK_TOOL: '1',
  },
})

let buffer = ''
const transcript = []
child.stdout.on('data', (d) => { buffer += d.toString('utf8') })
child.stderr.on('data', (d) => { buffer += d.toString('utf8') })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

/** Дождаться, когда вывод успокоился и вернулся промпт `dsh>`. */
async function waitIdle({ quietMs = 1500, timeoutMs = 90000 } = {}) {
  const started = Date.now()
  let lastLen = -1
  let quietSince = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (buffer.length !== lastLen) {
      lastLen = buffer.length
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= quietMs && /dsh>\s*$/.test(strip(buffer).replace(/\r/g, ''))) {
      return true
    }
    await sleep(200)
  }
  return false
}

/** Дождаться маркера конца хода, начиная поиск с позиции `from`. */
async function waitFor(pattern, timeoutMs, from) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const re = new RegExp(pattern.source, 'g')
    re.lastIndex = from
    const match = re.exec(buffer)
    if (match) return match
    await sleep(300)
  }
  return null
}

/**
 * Очистить вывод терминала: ANSI-коды, перерисовки счётчика (`\r`) и служебные
 * строки. Без этого в «ответ» попадает «Deep diving… (N tokens)» — счётчик
 * перерисовывает одну и ту же строку, поэтому из каждого `\r`-набора берём
 * последний вариант, как это видно на экране.
 */
function cleanStream(raw) {
  // Счётчик токенов перерисовывает одну строку через `\r`: такие куски выкидываем
  // целиком, иначе они вклеиваются в середину ответа.
  const kept = strip(raw)
    .split('\r')
    .filter((seg) => !/Deep diving|\(\d+ tokens\)\s*$|^\s*✔ done/.test(seg))
  return kept
    .join('\n')
    .split('\n')
    .filter((line) => !/Deep diving|✔ done|· step \d|tokens: in |requests: |context: \d|^\s*$/.test(line))
    .filter((line) => !/^(·|— turn|dsh>)/.test(line.trim()))
    // Служебные строки моста MCP и stderr python-сервера (faiss пишет в stderr).
    .filter((line) => !/^\(queued |Could not load library|ModuleNotFoundError|Loading faiss|Successfully loaded/.test(line.trim()))
    .join('\n')
    .replace(/\(\d+ tokens\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Разобрать ход: вызовы инструментов и текст ответа. */
function parseTurn(raw, userText) {
  const cleaned = cleanStream(raw)
  const calls = [...cleaned.matchAll(/⛭ ([\w/]+)\s*([^\n]*)/g)]
    .map((c) => ({ tool: c[1], args: c[2].trim() }))
  const answer = cleaned.replace(/^⛭.*$/gm, '').trim()
  return { user: userText, answer, calls, raw: raw.slice(0, 6000) }
}

async function send(text, label) {
  const before = buffer.length
  child.stdin.write(`${text}\r`)
  const ended = await waitFor(/— turn \d+ ended/, turnTimeoutMs, before)
  if (!ended) {
    // Ход не завершился: сохраняем сырой хвост — без него непонятно, ждёт ли
    // сессия подтверждения, задаёт встречный вопрос или просто молчит.
    const tail = strip(buffer.slice(before)).slice(-4000)
    console.error(`✖ ${label}: ход не завершился за ${turnTimeoutMs} мс`)
    console.error(`--- хвост вывода ---\n${tail}\n---------------------`)
    return { user: text, answer: "", calls: [], error: "turn-timeout", raw: tail }
  }
  await waitIdle({ quietMs: 1200, timeoutMs: 30000 })
  return parseTurn(buffer.slice(before), text)
}

console.log(`сценарий ${scenario.id}: ${scenario.title} · ходов ${Math.min(scenario.turns.length, turnsLimit)}`)
await waitIdle({ quietMs: 2000, timeoutMs: 120000 })
// Новая сессия: прогон самодостаточен, память задачи начинается с нуля.
child.stdin.write('/new\r')
await waitIdle({ quietMs: 2500, timeoutMs: 60000 })
const afterNew = buffer.length
child.stdin.write('/session\r')
await waitIdle({ quietMs: 1200, timeoutMs: 30000 })
const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
let sessionId = (uuidRe.exec(strip(buffer.slice(afterNew))) ?? [])[0] ?? null
if (!sessionId) {
  // Резерв: самый свежий файл состояния, появившийся после старта прогона.
  const ctxDir = join(dshHome, '.dsh-term', 'context')
  if (existsSync(ctxDir)) {
    const fresh = readdirSync(ctxDir)
      .map((name) => join(ctxDir, name))
      .filter((p) => statSync(p).mtimeMs >= startedAt)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    if (fresh.length) sessionId = fresh[0].replace(/\.json$/, '').split(/[\\/]/).pop()
  }
}
console.log(`сессия: ${sessionId ?? 'не определена'}`)

const turns = scenario.turns.slice(0, turnsLimit)
for (const [index, turn] of turns.entries()) {
  const parsed = await send(turn, `ход ${index + 1}`)
  if (!parsed) break
  transcript.push(parsed)
  if (parsed.error) {
    console.log(`  ${String(index + 1).padStart(2)}. ОШИБКА: ${parsed.error}`)
    continue
  }
  const notes = [...new Set([...parsed.answer.matchAll(/([\wА-Яа-я0-9_/.-]+\.md)/g)].map((m) => m[1]))]
  console.log(`  ${String(index + 1).padStart(2)}. tool=${parsed.calls.length} · источников: ${notes.length}`
    + ` · ${parsed.answer.slice(0, 70).replace(/\n/g, ' ')}…`)
}

child.stdin.write('/exit\r')
await sleep(2500)
try { child.kill() } catch { /* уже завершился */ }

const outPath = join(outDir, `chat-${scenario.id}.json`)
writeFileSync(outPath, JSON.stringify({
  scenario: { id: scenario.id, title: scenario.title, goal: scenario.goal, why: scenario.why,
    checkpoints: scenario.checkpoints, turns: scenario.turns },
  ragBase, sessionId, finishedAt: new Date().toISOString(), turns: transcript,
}, null, 1), 'utf8')
console.log(`\nрасшифровка: ${outPath}`)
console.log(`ходов записано: ${transcript.length} из ${turns.length}`)
if (sessionId) {
  const ctxPath = join(dshHome, '.dsh-term', 'context', `${sessionId}.json`)
  console.log(`память задачи: ${existsSync(ctxPath) ? ctxPath : 'файл контекста не найден'}`)
}
