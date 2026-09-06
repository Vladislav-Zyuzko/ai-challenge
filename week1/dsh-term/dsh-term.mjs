#!/usr/bin/env node
/**
 * dsh-term — интерактивная терминальная CLI для DeepSeek Harness.
 *
 * Тонкий клиент поверх SDK JSON-RPC протокола (@deepseek-ai/dsh-sdk-protocol):
 * спавнит `dsh --profile sdk` и говорит с ним по newline-delimited JSON-RPC 2.0.
 * Ноль внешних зависимостей — только Node.js built-ins.
 *
 * При первом входе сам запрашивает DEEPSEEK API ключ и сохраняет его в
 * managed-хранилище `<home>/.credentials.yaml`; последняя сессия запоминается
 * и автоматически продолжается при следующем запуске. Пока модель думает —
 * в терминале плывёт кит DeepSeek.
 *
 * Протокол (см. packages/sdk/protocol/README.md):
 *   client→server: initialize {cwd,provider,model} / session/prompt {sessionId,contentBlocks} / shutdown
 *   server→client: session.event {sessionId,event} / session.status {sessionId,status} / subagent.*
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

// ---------- ANSI ----------
const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: '\x1b[2m', reset: '\x1b[22m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', reset: '', cyan: '', green: '', red: '', yellow: '', bold: '', off: '' }

// Состояние UI: oneShot = режим -p (ответ только в stdout, диагностика в stderr).
const UI = { oneShot: false, lastChar: '' }
function outWrite(s) {
  UI.lastChar = s.length > 0 ? s[s.length - 1] : UI.lastChar
  process.stdout.write(s)
}
const log = {
  out: (s) => outWrite(s),
  line: (s) => outWrite(s + '\n'),
  err: (s) => process.stderr.write(C.red + s + C.off + '\n'),
  dim: (s) => (UI.oneShot ? process.stderr : process.stdout).write(C.dim + s + C.reset + '\n'),
  tool: (s) => (UI.oneShot ? process.stderr : process.stdout).write(C.cyan + s + C.off + '\n'),
  ok: (s) => (UI.oneShot ? process.stderr : process.stdout).write(C.green + s + C.off + '\n'),
}

// Отладочная трассировка в файл (stdout при process.exit теряется, файл — нет).
const TRACE_FILE = process.env.DSH_TERM_TRACE
const trace = (s) => {
  if (!TRACE_FILE) return
  try { appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${s}\n`) } catch {}
}

// ---------- анимация: плавающий кит DeepSeek пока модель думает ----------
// Только TTY: на пайпе startStatus/stopStatus — no-op.
const CAPTION = `${C.bold}${C.cyan}deep diving…${C.off}`
const STATUS_FRAMES = [
  `🐋~~~~~~~~ ${CAPTION}`,
  `~🐋~~~~~~~ ${CAPTION}`,
  `~~🐋~~~~~~ ${CAPTION}`,
  `~~~🐋~~~~~ ${CAPTION}`,
  `~~~~🐋~~~~ ${CAPTION}`,
  `~~~~~🐋~~~ ${CAPTION}`,
  `~~~~~~🐋~~ ${CAPTION}`,
  `~~~~~~~🐋~ ${CAPTION}`,
  `~~~~~~~~🐋 ${CAPTION}`,
]
const status = { timer: null, frame: 0, enabled: process.stdout.isTTY && !process.env.DSH_TERM_NO_ANIM }

function startStatus() {
  if (UI.oneShot || !status.enabled || status.timer) return
  status.frame = 0
  const draw = () => {
    process.stdout.write(`\r\x1b[K${STATUS_FRAMES[status.frame % STATUS_FRAMES.length]}`)
    status.frame++
  }
  draw()
  status.timer = setInterval(draw, 140)
}
function stopStatus() {
  // Очищаем строку ТОЛЬКО если кит реально крутился: иначе \r\x1b[K на каждый
  // text-delta чанк стирал бы уже напечатанный текст ответа.
  if (!status.timer) return
  clearInterval(status.timer)
  status.timer = null
  if (status.enabled) process.stdout.write('\r\x1b[K')
}

// ---------- построчный читатель stdin (единая очередь для токена и REPL) ----------
// readline здесь сознательно НЕ используется: его внутренняя буферизация теряет
// строки при закрытии интерфейса (дважды ловили это на пайпе).
const input = { buf: '', lines: [], waiters: [], eof: false, secretActive: false }

function pushInputLine(line) {
  input.lines.push(line)
  if (input.waiters.length) input.waiters.shift()(input.lines.shift())
}

/** Взять следующую строку stdin; при EOF вернёт ''. */
function takeInputLine() {
  if (input.lines.length) return Promise.resolve(input.lines.shift())
  if (input.eof) return Promise.resolve('')
  return new Promise((resolve) => input.waiters.push(resolve))
}

/** Поднять один построчный читатель на весь процесс (onLine/onEof). */
function startInput(onLine, onEof) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    const text = String(chunk)
    // Ctrl+C, дошедший как данные (консоль застряла в raw-режиме) — глушим.
    if (!input.secretActive && text.includes('\u0003')) process.exit(130)
    if (input.secretActive) return // во время ввода секрета рулит raw-mode слушатель
    input.buf += chunk
    for (;;) {
      // Разделитель строк: \n, \r или \r\n (CRLF — один разделитель).
      let sep = -1
      for (let i = 0; i < input.buf.length; i++) {
        const ch = input.buf[i]
        if (ch === '\n' || ch === '\r') { sep = i; break }
      }
      if (sep < 0) break
      const line = input.buf.slice(0, sep)
      input.buf = input.buf.slice(sep + 1)
      if (input.buf[0] === '\n') input.buf = input.buf.slice(1) // CRLF: съели \r, скидываем \n
      onLine(line)
    }
  })
  process.stdin.on('end', () => {
    trace('stdin end')
    if (input.buf) onLine(input.buf)
    input.eof = true
    while (input.waiters.length) input.waiters.shift()('')
    onEof()
  })
}

// ---------- credentials: первый вход → запрос токена, дальше из хранилища ----------
const TOKEN_REF = 'DEEPSEEK_API_KEY'

function credentialsPath(dshHome) { return join(dshHome, '.credentials.yaml') }

function unquoteYaml(v) {
  v = v.trim()
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"')
  return v
}
function quoteYaml(v) { return `'${String(v).replace(/'/g, "''")}'` }

/** Прочитать DEEPSEEK_API_KEY из managed-документа `<home>/.credentials.yaml`. */
function readTokenFromStore(dshHome) {
  const file = credentialsPath(dshHome)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  let inRefs = false
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trimEnd()
    if (/^refs:\s*$/.test(t)) { inRefs = true; continue }
    if (!inRefs) continue
    if (/^\S/.test(t)) inRefs = false // следующая top-level секция
    else {
      const m = /^\s{2}([A-Za-z0-9_]+):\s*(.*)$/.exec(t)
      if (m && m[1] === TOKEN_REF) return unquoteYaml(m[2])
    }
  }
  return undefined
}

/** Сохранить токен в managed-документ, аккуратно вливаясь в существующий файл. */
function saveTokenToStore(dshHome, token) {
  mkdirSync(dshHome, { recursive: true })
  const file = credentialsPath(dshHome)
  const keyLine = `  ${TOKEN_REF}: ${quoteYaml(token)}`
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!existing.trim()) {
    writeFileSync(file, `version: 1\nrefs:\n${keyLine}\nrecords: {}\n`, 'utf8')
    return
  }
  const lines = existing.split(/\r?\n/)
  let versionIdx = -1
  let refsIdx = -1
  let keyIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimEnd()
    if (/^version:\s*1/.test(t) && versionIdx < 0) versionIdx = i
    if (/^refs:\s*$/.test(t)) refsIdx = i
    if (/^\s{2}DEEPSEEK_API_KEY:/.test(t)) keyIdx = i
  }
  if (keyIdx >= 0) {
    lines[keyIdx] = keyLine
  } else if (refsIdx >= 0) {
    lines.splice(refsIdx + 1, 0, keyLine)
  } else if (versionIdx >= 0) {
    lines.splice(versionIdx + 1, 0, 'refs:', keyLine)
  } else {
    lines.unshift('version: 1', 'refs:', keyLine)
  }
  const out = lines.join('\n').replace(/\n+$/g, '') + '\n'
  writeFileSync(file, out, 'utf8')
}

/**
 * Запрос секрета: на TTY — raw mode со скрытым вводом (звёздочки);
 * на пайпе — обычная строка из общей очереди stdin.
 */
function promptSecret(question) {
  process.stdout.write(question)
  if (!process.stdin.isTTY) return takeInputLine()
  return new Promise((resolve) => {
    input.secretActive = true
    process.stdin.setRawMode(true)
    let value = ''
    const cleanup = () => {
      input.secretActive = false
      process.stdin.setRawMode(false)
      process.stdin.removeListener('data', onData)
    }
    const onData = (chunk) => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') {
          cleanup()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') { // Ctrl+C
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1)
          process.stdout.write('\b \b')
        } else if (ch >= ' ') {
          value += ch
          process.stdout.write('*')
        }
      }
    }
    process.stdin.on('data', onData)
  })
}

/**
 * Токен в порядке приоритета: окружение → managed-хранилище → интерактивный
 * запрос с сохранением. Возвращает токен или бросает ошибку.
 */
async function ensureToken(dshHome) {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const stored = readTokenFromStore(dshHome)
  if (stored) return stored
  const token = (await promptSecret('Введите DEEPSEEK API ключ (ввод скрыт): ')).trim()
  if (!token) throw new Error('токен не введён — задайте DEEPSEEK_API_KEY или укажите --dsh-home с сохранённым ключом')
  saveTokenToStore(dshHome, token)
  log.dim(`(токен сохранён в ${credentialsPath(dshHome)})`)
  return token
}

// ---------- память сессий ----------
function statePath(dshHome) { return join(dshHome, 'dsh-term-state.json') }
function loadState(dshHome) {
  try { return JSON.parse(readFileSync(statePath(dshHome), 'utf8')) } catch { return null }
}
function saveState(dshHome, sessionId) {
  try {
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(statePath(dshHome), JSON.stringify({ lastSessionId: sessionId }, null, 2) + '\n', 'utf8')
  } catch {}
}

/** Сохранённые сессии из `<home>/sessions` (рекурсивно). Раскладка:
 * `sessions/<ns-по-рабочей-папке>/<sessionId>/session.jsonl[.zstd]` —
 * id сессии это имя папки, в которой лежит лог `session.jsonl`. */
function listSessions(dshHome) {
  const dir = join(dshHome, 'sessions')
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'session.jsonl' || e.name === 'session.jsonl.zstd') {
        out.push(basename(d)) // родительская папка = sessionId
      }
    }
  }
  walk(dir)
  return out.sort()
}

// ---------- CLI args ----------
function parseArgs(argv) {
  const opts = {
    dshHome: join(homedir(), '.dsh-term'),
    profile: 'sdk',
    provider: process.env.DSH_TERM_PROVIDER ?? 'deepseek-official',
    model: process.env.DSH_TERM_MODEL ?? 'deepseek-v4-flash',
    maxTokens: undefined,
    temperature: undefined, // температура сэмплинга 0..2 (аналог --max-tokens, на агента)
    session: undefined,
    prompt: undefined,       // -p/--print: текст промпта (one-shot; claude-style)
    workspace: process.cwd(),
    dshBin: 'dsh',
    format: undefined,       // пресет или свободное описание формата ответа
    maxLength: undefined,    // лимит длины ответа в символах (мягко + обрезка показа)
    stopMarker: undefined,   // маркер-стоп: рендер обрывается на нём
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--dsh-home': opts.dshHome = next(); break
      case '--profile': opts.profile = next(); break
      case '--provider': opts.provider = next(); break
      case '--model': opts.model = next(); break
      case '--max-tokens': opts.maxTokens = Number(next()); break
      case '--temperature': opts.temperature = Number(next()); break
      case '--session': case '--resume': opts.session = next(); break
      case '--format': opts.format = next(); break
      case '--max-length': opts.maxLength = Number(next()); break
      case '--stop': opts.stopMarker = next(); break
      case '-p': case '--print': opts.prompt = next(); break
      case '--workspace': opts.workspace = next(); break
      case '--dsh-bin': opts.dshBin = next(); break
      case '-h': case '--help': opts.help = true; break
      default: log.err(`unknown option: ${a}`); opts.help = true
    }
  }
  return opts
}

// ---------- JSON-RPC transport over a child process ----------
class RpcClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.onNotification = () => {}
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => this.#onData(d))
    child.on('error', (e) => this.#failAll(`spawn error: ${e.message}`))
    child.on('exit', (code, signal) => { trace(`child exit code=${code} signal=${signal}`); this.#failAll(`runtime exited (code=${code}, signal=${signal})`) })
  }

  #onData(data) {
    this.buffer += data
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue } // malformed lines ignored (per protocol)
      if (msg.id !== undefined && msg.method !== undefined) continue // server→client requests unused
      if (msg.method !== undefined) { this.onNotification(msg); continue }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          trace(`resp id=${msg.id} ${msg.error ? `error ${msg.error.code}` : 'ok'}`)
          if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data))
          else p.resolve(msg.result)
        }
      }
    }
  }

  request(method, params) {
    const id = this.nextId++
    trace(`req id=${id} ${method}`)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  #failAll(reason) {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }

  async close() {
    // Shutdown ограничен по времени: рантайм может быть занят ходом или сам
    // гаситься по Ctrl+C (тот же консольный процесс) и не ответить — ждать
    // бесконечно нельзя, иначе dsh-term не завершится.
    const shutdown = this.request('shutdown', undefined).catch(() => {})
    const guard = new Promise((r) => setTimeout(r, 1200))
    await Promise.race([shutdown, guard])
    try { this.child.stdin.end() } catch {}
    await new Promise((r) => {
      const t = setTimeout(() => { try { this.child.kill('SIGKILL') } catch {} r() }, 1500)
      this.child.once('exit', () => { clearTimeout(t); r() })
    })
  }
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(`JSON-RPC error ${code}: ${message}`)
    this.code = code
    this.data = data
  }
}

// ---------- runtime spawn ----------
function spawnRuntime(opts, token) {
  const args = ['--profile', opts.profile]
  // Окружение для рантайма: токен через DEEPSEEK_API_KEY (для харнесса окружение
  // приоритетнее managed-файла) либо уже сохранён в его home.
  const env = {
    ...process.env,
    DSH_HOME: opts.dshHome,
    ...(token ? { DEEPSEEK_API_KEY: token } : {}),
  }
  let child
  if (process.platform === 'win32') {
    // .cmd/.bat нельзя запустить напрямую через CreateProcess (EINVAL).
    // cmd.exe /d /s /c с ВНЕШНИМИ кавычками вокруг всей команды: /s срезает
    // первую и последнюю кавычки, оставляя ровно `"<bin>" <args>`.
    // windowsVerbatimArguments — чтобы node не переквотировал аргументы сам.
    const cmdLine = `"${opts.dshBin}" ${args.map((a) => `"${a}"`).join(' ')}`
    child = spawn('cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsVerbatimArguments: true,
    })
  } else {
    child = spawn(opts.dshBin, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
  }
  // Не оставлять осиротевший рантайм, если наш процесс умирает нештатно.
  process.on('exit', () => { try { child.kill('SIGKILL') } catch {} })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => process.stderr.write(C.dim + d + C.reset))
  return new RpcClient(child)
}

// ---------- render ----------
function shortArgs(raw) {
  try {
    const o = JSON.parse(raw)
    const keys = Object.keys(o).slice(0, 4)
    const parts = keys.map((k) => `${k}=${typeof o[k] === 'string' ? JSON.stringify(o[k].slice(0, 60)) : JSON.stringify(o[k])}`)
    if (Object.keys(o).length > 4) parts.push('…')
    return parts.join(' ')
  } catch {
    return raw.slice(0, 120)
  }
}

// Режим «только итог» для one-shot: агентные модели склонны «проговаривать
// вслух» свои шаги обычным текстом, а протокол не отличает этот нарратив от
// ответа (это не reasoning — это text-delta). Поэтому в -p просим модель
// выводить исключительно финальный результат.
const FINAL_ONLY_SUFFIX = `

---

ВАЖНО (режим «только итоговый результат»): верни ТОЛЬКО итоговый ответ на задачу.
Запрещено: описывать свои действия или план, комментировать процесс, писать
промежуточные заметки и рассуждения, пересказывать, что ты делаешь. Работай
инструментами молча. Весь твой вывод сохраняется как результат — в нём не должно
быть ничего, кроме итога.`

// ---------- формат/длина/стоп: пресеты и инструкции ----------
const FORMAT_PRESETS = {
  json: 'Отвечай СТРОГО валидным JSON: без markdown-обёртки (```), без текста вне JSON.',
  plain: 'Отвечай простым текстом без markdown-разметки.',
  markdown: 'Отвечай в формате Markdown.',
  bullets: 'Отвечай короткими буллетами, каждый с новой строки через «- ».',
  code: 'Отвечай кодом; пояснения — минимальные, вне блоков.',
  table: 'Отвечай в виде Markdown-таблицы.',
}
function formatInstruction(v) {
  const low = v.trim().toLowerCase()
  if (FORMAT_PRESETS[low]) return FORMAT_PRESETS[low]
  return `Формат ответа: ${v.trim()}. Строго следуй этому формату.`
}

// ---------- реестр команд REPL + git/gh (SKILLS) ----------
const COMMANDS = [
  { name: 'help', usage: '/help [команда]', desc: 'список команд / справка по команде' },
  { name: 'session', usage: '/session', desc: 'показать id текущей сессии' },
  { name: 'resume', usage: '/resume [id]', desc: 'продолжить сессию: по id или выбором из списка' },
  { name: 'new', usage: '/new', desc: 'начать новую сессию' },
  { name: 'token', usage: '/token', desc: 'сменить сохранённый DEEPSEEK API ключ' },
  { name: 'publish-day', usage: '/publish-day', desc: 'git+gh: коммит → push → PR day→week (по SKILLS)' },
  { name: 'exit', usage: '/exit', desc: 'завершить dsh-term (или Ctrl+C)' },
]

function levenshtein(a, b) {
  const m = a.length; const n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[m][n]
}

/** Подсказки для неверной команды: по префиксу, затем по опечатке. */
function suggestCommands(input) {
  const low = input.toLowerCase()
  const prefix = COMMANDS.filter((c) => c.name.startsWith(low))
  if (prefix.length) return prefix.slice(0, 3)
  return COMMANDS
    .map((c) => ({ c, d: levenshtein(c.name, low) }))
    .filter((x) => x.d <= 2)
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map((x) => x.c)
}

function printCommandUsage(name) {
  const c = COMMANDS.find((x) => x.name === name)
  if (c) log.line(`  ${C.cyan}${c.usage}${C.off} — ${c.desc}`)
}

function printCommandList() {
  log.line(`${C.bold}Доступные команды:${C.off}`)
  for (const c of COMMANDS) printCommandUsage(c.name)
  log.dim('Введи «/» — этот список; «/help <команда>» — подробнее.')
}

async function askLine(question) {
  process.stdout.write(question)
  return takeInputLine()
}

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() }
}
function runGh(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' })
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() }
}

function buildPrBody({ dayBranch, weekBranch, subject, body, statOut, porcelainOut }) {
  const lines = ['## Что сделано']
  const src = (statOut || porcelainOut || '').split('\n').filter(Boolean)
  if (src.length) {
    for (const row of src) {
      const f = row.split('|')[0].trim()
      if (f) lines.push(`- ${f}`)
    }
  } else lines.push('- изменения')
  lines.push('', '## Коммит', subject)
  if (body) lines.push('', body)
  lines.push('', `Ветки: \`${dayBranch}\` → \`${weekBranch}\``, '', '_Сгенерировано `dsh-term /publish-day` (см. .dsh/SKILLS)._')
  return lines.join('\n')
}

/**
 * /publish-day — публикация дня по SKILLS: коммит на ветке дня → push → PR в
 * ветку недели с описанием. Детерминированный клиентский макрос (git/gh).
 */
async function publishDay(workspace) {
  log.line(`${C.bold}/publish-day${C.off}: коммит → push → PR (${C.cyan}day → week${C.off}), по ${C.bold}.dsh/SKILLS${C.off}`)
  const repo = runGit(['-C', workspace, 'rev-parse', '--is-inside-work-tree'])
  if (!repo.ok || repo.out !== 'true') {
    log.err(`«${workspace}» не git-репозиторий — /publish-day работает внутри репозитория`)
    return
  }
  const br = runGit(['-C', workspace, 'branch', '--show-current'])
  const branch = br.out
  const m = /^(week\d+)\/(day.+)$/i.exec(branch)
  if (!m) {
    log.err(`текущая ветка «${branch || '(detached HEAD)'}» — не формат weekN/dayM`)
    const days = runGit(['-C', workspace, 'branch', '--list', 'week*/*'])
    if (days.ok && days.out) {
      log.line('ветки дней:')
      for (const l of days.out.split('\n')) { const t = l.trim().replace(/^\* /, ''); if (t) log.line(`  ${t}`) }
    }
    log.line('переключись на ветку дня (`git switch weekN/dayM`) и повтори /publish-day')
    return
  }
  const dayBranch = branch
  const weekBranch = `feature/${m[1].toLowerCase()}`
  log.dim(`ветка дня: ${dayBranch} → base неделя: ${weekBranch}`)

  const st = runGit(['-C', workspace, 'status', '--porcelain'])
  if (!st.ok) { log.err(`git status failed: ${st.err}`); return }
  if (!st.out) { log.err(`рабочее дерево чистое (${dayBranch}) — коммитить нечего`); return }
  log.line('изменения:')
  for (const l of st.out.split('\n')) log.line(`  ${l}`)
  const stat = runGit(['-C', workspace, 'diff', '--stat', 'HEAD'])
  if (stat.ok && stat.out) log.dim(stat.out.split('\n').map((l) => '  ' + l).join('\n'))

  const subject = (await askLine('Сообщение коммита (тип(область): описание; Enter — отмена): ')).trim()
  if (!subject) { log.line('отменено'); return }
  const cbody = (await askLine('Тело коммита (Enter — без тела): ')).trim()

  const add = runGit(['-C', workspace, 'add', '-A'])
  if (!add.ok) { log.err(`git add failed: ${add.err}`); return }
  const cargs = ['-C', workspace, 'commit', '-m', subject]
  if (cbody) cargs.push('-m', cbody)
  const c = runGit(cargs)
  if (!c.ok) { log.err(`git commit failed: ${c.err}`); return }
  log.ok('committed')

  const p = runGit(['-C', workspace, 'push', '-u', 'origin', dayBranch])
  if (!p.ok) {
    log.err(`git push failed: ${p.err}`)
    log.line('коммит уже создан — исправь причину и повтори /publish-day')
    return
  }
  const pl = (p.out || p.err || '').split('\n').filter(Boolean)
  log.ok(`pushed: ${pl.length ? pl[pl.length - 1] : dayBranch}`)

  // base-ветка недели: локально, иначе с origin (иначе — инструкция)
  const baseLocal = runGit(['-C', workspace, 'rev-parse', '--verify', '--quiet', weekBranch])
  if (!baseLocal.ok) {
    const baseRemote = runGit(['-C', workspace, 'ls-remote', '--heads', 'origin', weekBranch])
    if (baseRemote.ok && baseRemote.out) {
      runGit(['-C', workspace, 'fetch', 'origin', weekBranch])
      runGit(['-C', workspace, 'branch', '--track', weekBranch, `origin/${weekBranch}`])
    } else {
      log.err(`ветка ${weekBranch} не найдена ни локально, ни на origin — создай её от develop (SKILLS) и повтори`)
      return
    }
  }

  const body = buildPrBody({ dayBranch, weekBranch, subject, body: cbody, statOut: stat.ok ? stat.out : '', porcelainOut: st.out })
  const pr = runGh(['pr', 'create', '--base', weekBranch, '--head', dayBranch, '--title', subject, '--body', body], workspace)
  if (!pr.ok) {
    log.err(`gh pr create failed: ${pr.err}`)
    const ex = runGh(['pr', 'list', '--head', dayBranch, '--state', 'OPEN', '--json', 'url', '--jq', '.[0].url'], workspace)
    if (ex.ok && ex.out && ex.out !== 'null') log.line(`PR уже открыт: ${ex.out}`)
    return
  }
  log.ok(`PR: ${pr.out}`)
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    log.line(`${C.bold}dsh-term${C.off} — интерактивная терминальная CLI для DeepSeek Harness (SDK JSON-RPC клиент)`)
    log.line('')
    log.line('Использование:')
    log.line('  dsh-term                     интерактивный REPL')
    log.line('  dsh-term -p "вопрос" [флаги]  one-shot: один ответ с флагами и выход')
    log.line('')
    log.line('Опции:')
    log.line('  -p, --print <text>  промпт (one-shot, чистый контекст); файл — как в claude:')
    log.line('                      -p "$(Get-Content prompt.md -Raw)"')
    log.line('  --dsh-home <path>   Harness home (default: ~/.dsh-term)')
    log.line('  --profile <name>    профиль рантайма (default: sdk)')
    log.line('  --provider <id>     провайдер (default: deepseek-official; env DSH_TERM_PROVIDER)')
    log.line('  --model <name>      модель (default: deepseek-v4-flash; env DSH_TERM_MODEL)')
    log.line('  --max-tokens <n>    лимит токенов ответа (жёсткий кап адаптера)')
    log.line('  --temperature <n>   температура сэмплинга 0..2 (по умолчанию — провайдерская, 1.0)')
    log.line('  --format <spec>     формат ответа: пресет (json/plain/markdown/bullets/code/table) или описание')
    log.line('  --max-length <n>    лимит длины ответа в символах: инструкция + обрезка показа')
    log.line('  --stop <marker>     стоп-символ: передаётся с промптом; показ обрывается при генерации маркера')
    log.line('  --session <id>      продолжить конкретную сессию (синоним: --resume <id>)')
    log.line('  --workspace <path>  рабочая папка сессий (default: текущая)')
    log.line('  --dsh-bin <path>    путь к dsh (default: dsh из PATH)')
    log.line('')
    log.line('Команды REPL:')
    log.line('  /    список доступных команд')
    log.line('  /help [команда]  справка')
    log.line('  /session  показать id текущей сессии')
    log.line('  /resume [id]  продолжить сессию: по id или выбором из списка')
    log.line('  /new     начать новую сессию')
    log.line('  /token   сменить сохранённый API ключ')
    log.line('  /publish-day  git+gh: коммит → push → PR day→week (по .dsh/SKILLS)')
    log.line('  /exit    завершить (или Ctrl+C)')
    log.line('')
    log.line('При первом входе dsh-term сам запросит DEEPSEEK API ключ и сохранит его')
    log.line(`в ${credentialsPath(opts.dshHome)}; последняя сессия запоминается и автоматически продолжается.`)
    log.line('Пока модель думает, в терминале плывёт кит DeepSeek (отключить: DSH_TERM_NO_ANIM=1).')
    return
  }

  // One-shot (-p/--print): весь вывод ответа в stdout, диагностика в stderr.
  if (opts.prompt !== undefined) UI.oneShot = true

  // Контролы ответа (--format / --max-length / --stop): применяются к ОДНОМУ
  // следующему ответу, затем автосброс (скоуп «только на один ответ»).
  let pendingControls = null
  if (opts.format !== undefined || opts.maxLength !== undefined || opts.stopMarker !== undefined) {
    pendingControls = {
      format: opts.format ?? null,
      maxChars: Number.isFinite(opts.maxLength) && opts.maxLength > 0 ? Math.floor(opts.maxLength) : null,
      marker: opts.stopMarker ?? null,
    }
  }

  // Температура сэмплинга: валидируем диапазон до запуска рантайма.
  if (opts.temperature !== undefined
    && (!Number.isFinite(opts.temperature) || opts.temperature < 0 || opts.temperature > 2)) {
    log.err('--temperature должен быть числом в диапазоне 0..2')
    process.exit(1)
  }

  // SIGINT (Ctrl+C) должен гасить процесс в ЛЮБОМ состоянии — регистрируем
  // сразу, до токена/initialize (там нет своего обработчика).
  let rpcRef = null
  process.on('SIGINT', async () => {
    stopStatus()
    log.line('')
    // Жёсткий предохранитель: максимум ~2с на вежливое завершение рантайма.
    const killTimer = setTimeout(() => { try { rpcRef?.child.kill('SIGKILL') } catch {} }, 2000)
    killTimer.unref?.()
    if (rpcRef) { try { await rpcRef.close() } catch {} }
    clearTimeout(killTimer)
    process.exit(130)
  })

  // Единый построчный читатель: перехватывает и строки токена, и строки REPL.
  let initialized = false
  let pumpRef = () => {}
  startInput(
    (line) => { pushInputLine(line); pumpRef() },
    () => { pumpRef() },
  )

  // Токен: окружение → хранилище → интерактивный запрос при первом входе.
  const token = await ensureToken(opts.dshHome)

  // Состояние REPL: продолжаем последнюю сессию, если не указана явная.
  // ВАЖНО для one-shot: без --session всегда СВЕЖАЯ сессия (чистый контекст),
  // авто-resume последней сессии в -p/--print отключён.
  const saved = loadState(opts.dshHome)
  const isOneShot = opts.prompt !== undefined
  const sessionId = opts.session ?? (isOneShot ? randomUUID() : saved?.lastSessionId ?? randomUUID())
  const state = {
    sessionId,
    children: new Set(),       // subagent-сессии текущего дерева
    turn: null,                // { resolve, running, timer, maxChars, marker, … }
    streamedText: false,       // печатали ли текст за текущий ход
    lastEndKind: null,         // чем закончился последний ход ('completed'/'error'/…)
  }
  // В one-shot state не сохраняем: прогоны не должны затирать «последнюю сессию»
  // для интерактивного режима (у каждого -p запуска и так своя свежая сессия).
  if (!isOneShot) saveState(opts.dshHome, sessionId)

  const rpc = spawnRuntime(opts, token)
  rpcRef = rpc

  // ---- нотификации ----
  rpc.onNotification = (msg) => {
    trace(`notif ${msg.method}`)
    if (msg.method === 'session.status') {
      const { sessionId, status } = msg.params
      const mine = sessionId === state.sessionId || state.children.has(sessionId)
      if (mine && state.turn) {
        if (status === 'running') state.turn.running = true
        if (status === 'idle' && state.turn) finishTurn()
      }
      return
    }
    if (msg.method === 'subagent.started') {
      state.children.add(msg.params.childSessionId)
      stopStatus()
      log.dim(`↳ subagent ${msg.params.childSessionId}`)
      startStatus()
      return
    }
    if (msg.method === 'session.event') {
      const { sessionId, event } = msg.params
      const mine = sessionId === state.sessionId || state.children.has(sessionId)
      // Исход хода фиксируем ДО гейта по state.turn: порядок turn/end vs idle
      // между двумя notify-каналами не гарантирован, а lastEndKind нужен и в -p.
      if (mine && event.type === 'turn/end') state.lastEndKind = event.data?.reason?.kind ?? null
      if (!mine || !state.turn) return
      renderEvent(event)
    }
  }

  function renderEvent(event) {
    switch (event.type) {
      case 'assistant/chunk': {
        const c = event.data.chunk
        if (c.type === 'text-delta') {
          // Пошёл видимый ответ — кит останавливается, текст стримится.
          stopStatus()
          state.streamedText = true
          const t = state.turn
          if (!t || t.cut) break
          // Детект маркера ЧЕРЕЗ ГРАНИЦЫ чанков: задерживаем вывод на
          // (len-1) символов и ищем маркер в склейке «хвост + новый чанк».
          const markLen = t.marker ? t.marker.length : 0
          const combined = (t.tail ?? '') + c.text
          let head = combined
          let cut = null
          if (t.marker) {
            const i = combined.indexOf(t.marker)
            if (i >= 0) { head = combined.slice(0, i); cut = 'marker' }
          }
          if (t.maxChars != null && !cut) {
            const remain = t.maxChars - t.streamedCount
            if (head.length > remain) { head = head.slice(0, Math.max(0, remain)); cut = 'length' }
          }
          const hold = !cut && markLen > 1 ? Math.min(markLen - 1, head.length) : 0
          const flush = head.slice(0, head.length - hold)
          if (flush) { log.out(flush); t.streamedCount += flush.length }
          t.tail = !cut && markLen > 1 ? head.slice(head.length - hold) : ''
          trace(`td flush=${JSON.stringify(flush)} tail=${JSON.stringify(t.tail)} cut=${cut}`)
          if (cut === 'marker') {
            t.cut = 'marker'
            log.err(`…[стоп-маркер ${JSON.stringify(t.marker)} — показ обрезан]`)
          } else if (cut === 'length') {
            t.cut = 'length'
            t.streamedCount = t.maxChars
            log.err(`…[обрезано dsh-term: лимит ${t.maxChars} символов]`)
          }
        }
        // reasoning-delta намеренно не печатаем: в это время плывёт кит
        // (капшон «deep diving…»), как в веб-приложении DeepSeek.
        break
      }
      case 'tool/call': {
        stopStatus()
        log.tool(`▶ ${event.data.name} ${shortArgs(event.data.arguments)}`)
        startStatus() // модель снова думает после вызова инструмента
        break
      }
      case 'tool/result': {
        stopStatus()
        if (event.data.error) log.err(`✖ ${event.data.error.name}: ${event.data.error.code}`)
        else log.ok('✔ done')
        startStatus()
        break
      }
      case 'turn/end': {
        stopStatus()
        // Поток текста закончился: допечатать задержанный хвост ДО пустой строки,
        // иначе перенос строки оказался бы посреди текста (см. -p и маркер).
        flushTurnTail()
        // Текст стримился без перевода строки — отделяем от заголовка конца.
        if (state.streamedText) log.line('')
        const r = event.data.reason
        // Причина ошибки: `{ kind: 'error', error: LlmFailure }` — поле `error`,
        // а не `failure` (это было причиной «глухого» вывода ошибок).
        const f = r.error ?? r.failure
        if (f) log.err(`— turn ${event.data.turn} ended: ${r.kind} (${f.code ?? f.name}: ${f.message})`)
        else log.dim(`— turn ${event.data.turn} ended: ${r.kind}`)
        break
      }
      case 'assistant/message': {
        if (event.data.interrupted) {
          stopStatus()
          log.dim('— (interrupted)')
        }
        break
      }
    }
  }

  /** Допечатать хвост, задержанный для детекта маркера (маркер не встретился). */
  function flushTurnTail() {
    const t = state.turn
    if (!t || !t.tail) return
    let tail = t.tail
    t.tail = ''
    if (t.maxChars != null) {
      const remain = t.maxChars - (t.streamedCount ?? 0)
      if (tail.length > remain) {
        tail = tail.slice(0, Math.max(0, remain))
        log.err(`…[обрезано dsh-term: лимит ${t.maxChars} символов]`)
      }
    }
    if (tail) { log.out(tail); t.streamedCount += tail.length }
  }

  function finishTurn() {
    stopStatus()
    flushTurnTail() // хвост, если turn/end ещё не приходил (страховка)
    const t = state.turn
    state.turn = null
    clearTimeout(t.timer)
    if (!UI.oneShot) log.line('')
    t?.resolve()
  }

  function startTurn(controls) {
    state.streamedText = false
    state.lastEndKind = null
    return new Promise((resolve) => {
      state.turn = {
        resolve,
        running: false,
        maxChars: controls?.maxChars ?? null,
        marker: controls?.marker ?? null,
        streamedCount: 0,
        tail: '',    // задержанные символы для детекта маркера через границы чанков
        cut: null, // 'marker' | 'length' | null
        timer: setTimeout(() => {
          stopStatus()
          log.err('— таймаут ожидания idle (агент не завершил ход)')
          finishTurn()
        }, 30 * 60 * 1000),
      }
    })
  }

  async function promptTurn(text) {
    trace(`promptTurn start: ${text}`)
    const controls = pendingControls
    pendingControls = null // скоуп: применяется только к этому ответу
    const waiting = startTurn(controls)
    try {
      // Мягкие инструкции (формат/длина/стоп-маркер) — префиксом к промпту.
      const instructions = []
      if (controls?.format) instructions.push(formatInstruction(controls.format))
      if (controls?.maxChars != null) instructions.push(`Не длиннее ${controls.maxChars} символов в основном ответе.`)
      // Стоп-маркер передаётся С ПРОМТОМ: модель знает, что закончить ответ им,
      // а клиент обрезает вывод в момент генерации маркера (см. renderEvent).
      if (controls?.marker) {
        instructions.push(`Заверши свой ответ ровно маркером ${JSON.stringify(controls.marker)} — маркер должен быть последним, после него ничего не пиши.`)
      }
      const body = instructions.length ? `${instructions.join('\n')}\n\n---\n\n${text}` : text
      trace(`prompt body: ${body.slice(0, 200)}`)
      const res = await rpc.request('session/prompt', {
        sessionId: state.sessionId,
        contentBlocks: [{ type: 'text', text: body }],
      })
      trace(`prompt queued: ${res.messageId}`)
      log.dim(`(queued ${res.messageId})`)
      startStatus() // модель думает — кит плывёт
    } catch (e) {
      stopStatus()
      trace(`prompt failed: ${e.message}`)
      log.err(`prompt failed: ${e.message}`)
      state.turn = null
      return false
    }
    await waiting
    trace('promptTurn done (idle)')
    return state.lastEndKind === 'completed'
  }

  // ---- сериализованная обработка строк (REPL-цикл) ----
  let busy = false
  let exiting = false

  /** Диспетчер команд: «/» — список, /help — справка, /publish-day — SKILLS-макрос. */
  async function handleCommand(text) {
    const parts = text.slice(1).split(/\s+/).filter(Boolean)
    const cmdName = (parts[0] ?? '').toLowerCase()
    if (!cmdName) { printCommandList(); return } // просто «/» → список команд
    const cmd = COMMANDS.find((c) => c.name === cmdName)
    if (!cmd) {
      const sug = suggestCommands(cmdName)
      if (sug.length) {
        log.err(`unknown command /${cmdName} — возможно: ${sug.map((c) => '/' + c.name).join(', ')}`)
        log.dim('введи «/» — список всех команд')
      } else log.err(`unknown command /${cmdName} — введи «/» для списка команд`)
      return
    }
    const arg = parts.slice(1).join(' ')
    switch (cmd.name) {
      case 'help': {
        if (arg) {
          const c = COMMANDS.find((x) => x.name === arg.toLowerCase())
          if (c) printCommandUsage(c.name)
          else log.err(`нет команды /${arg} — «/» для списка`)
        } else printCommandList()
        break
      }
      case 'session': {
        log.line(state.sessionId)
        break
      }
      case 'resume': {
        const target = parts[1]
        if (target) {
          state.sessionId = target
          state.children.clear()
          saveState(opts.dshHome, target)
          log.dim(`resuming session: ${target}`)
        } else {
          const list = listSessions(opts.dshHome)
          if (list.length === 0) { log.err('нет сохранённых сессий в этом home'); break }
          list.forEach((id, i) => log.line(`  ${i + 1}. ${id}`))
          const pick = (await askLine('id или номер (Enter — отмена): ')).trim()
          if (!pick) { log.line('отменено'); break }
          const chosen = /^\d+$/.test(pick) ? list[Number(pick) - 1] : pick
          if (!chosen) { log.err('нет такой сессии'); break }
          state.sessionId = chosen
          state.children.clear()
          saveState(opts.dshHome, chosen)
          log.dim(`resuming session: ${chosen}`)
        }
        break
      }
      case 'new': {
        state.sessionId = randomUUID()
        state.children.clear()
        saveState(opts.dshHome, state.sessionId)
        log.dim(`new session: ${state.sessionId}`)
        break
      }
      case 'token': {
        const t = (await promptSecret('Новый DEEPSEEK API ключ (ввод скрыт): ')).trim()
        if (t) {
          saveTokenToStore(opts.dshHome, t)
          log.dim('токен сохранён — применится при следующем запуске (или перезапустите dsh-term)')
        } else log.err('пустой токен, не сохранено')
        break
      }
      case 'publish-day': {
        await publishDay(opts.workspace)
        break
      }
      case 'exit': {
        exiting = true
        try { await rpc.close() } catch {}
        process.exit(0)
        break
      }
    }
  }

  const pump = async () => {
    if (busy || !initialized) return
    busy = true
    trace('pump start')
    try {
      while (!exiting && input.lines.length > 0) {
        const text = input.lines.shift().trim()
        trace(`pump line: ${text}`)
        if (!text) continue
        if (text.startsWith('/')) {
          await handleCommand(text)
          continue
        }
        await promptTurn(text)
      }
    } finally {
      busy = false
      trace('pump end')
      // EOF: ввод исчерпан — после обработки всех строк корректно завершаемся.
      if (input.eof && !exiting) {
        exiting = true
        stopStatus()
        try { await rpc.close() } catch {}
        process.exit(0)
      }
      if (!exiting) process.stdout.write('dsh> ')
    }
  }
  pumpRef = pump

  // ---- handshake ----
  try {
    const res = await rpc.request('initialize', {
      cwd: opts.workspace,
      provider: opts.provider,
      model: opts.model,
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    })
    log.dim(`runtime: ${res.serverInfo.name} ${res.serverInfo.version} · provider=${opts.provider} model=${opts.model}`)
  } catch (e) {
    log.err(`initialize failed: ${e.message}`)
    log.err('Проверь credentials (DEEPSEEK_API_KEY или managed credentials в DSH_HOME) и доступность модели.')
    try { await rpc.close() } catch {}
    process.exit(1)
  }

  const oneShotText = opts.prompt ?? ''

  if (opts.prompt !== undefined) {
    // One-shot (-p / --print): один ответ с флагами
    // (--format/--max-length/--stop/--max-tokens) → в stdout только ответ;
    // выход 0 при completed, 1 при ошибке. Файл-промпт — как в claude:
    // -p "$(Get-Content prompt.md -Raw)".
    const text = oneShotText.trim() + FINAL_ONLY_SUFFIX
    if (!text) {
      log.err('one-shot требует непустой промпт: dsh-term -p "вопрос"')
      process.exit(1)
    }
    const ok = await promptTurn(text)
    if (UI.lastChar && UI.lastChar !== '\n') outWrite('\n')
    try { await rpc.close() } catch {}
    process.exit(ok ? 0 : 1)
  }

  const resumed = opts.session || (saved?.lastSessionId && saved.lastSessionId === state.sessionId)
  log.dim(`${resumed ? 'resuming' : 'new'} session: ${state.sessionId}`)
  initialized = true
  trace('initialized')
  // Промпт пишет только pump в finally — иначе он печатается дважды.
  pump()
}

process.on('unhandledRejection', (e) => { trace(`unhandledRejection: ${e?.stack ?? e}`) })
process.on('uncaughtException', (e) => {
  trace(`uncaughtException: ${e?.stack ?? e}`)
  try { log.err(`internal error: ${e?.message ?? e}`) } catch {}
})

main().catch((e) => {
  stopStatus()
  trace(`main catch: ${e?.stack ?? e}`)
  log.err(`fatal: ${e.message}`)
  process.exit(1)
})
