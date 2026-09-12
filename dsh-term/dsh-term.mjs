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
 * в терминале переливается синим подпись «Deep diving…».
 *
 * Протокол (см. packages/sdk/protocol/README.md):
 *   client→server: initialize {cwd,provider,model} / session/prompt {sessionId,contentBlocks} / shutdown
 *   server→client: session.event {sessionId,event} / session.status {sessionId,status} / subagent.*
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

// ---------- ANSI ----------
const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: '\x1b[2m', reset: '\x1b[22m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', reset: '', cyan: '', green: '', red: '', yellow: '', bold: '', off: '' }

// Промпт «dsh> »: «dsh» — жирным фирменным синим DeepSeek (#4D6BFE) для контраста;
// без цвета (пайп / NO_COLOR) — как раньше.
const PROMPT = process.stdout.isTTY && !process.env.NO_COLOR
  ? '\x1b[1;38;2;77;107;254mdsh\x1b[0m> '
  : 'dsh> '

// Состояние UI: oneShot = режим -p (ответ только в stdout, диагностика в stderr).
const UI = { oneShot: false, lastChar: '' }
function outWrite(s) {
  drainMd() // сначала напечатать накопленный текст ответа (порядок вывода)
  meterEraseTail() // новый контент — сначала убрать хвостовой счётчик токенов
  UI.lastChar = s.length > 0 ? s[s.length - 1] : UI.lastChar
  process.stdout.write(s)
}
const log = {
  out: (s) => outWrite(s),
  line: (s) => outWrite(s + '\n'),
  err: (s) => { drainMd(); meterEraseTail(); process.stderr.write(C.red + s + C.off + '\n') },
  dim: (s) => { const out = C.dim + s + C.reset + '\n'; UI.oneShot ? (drainMd(), process.stderr.write(out)) : outWrite(out) },
  tool: (s) => { const out = C.cyan + s + C.off + '\n'; UI.oneShot ? (drainMd(), process.stderr.write(out)) : outWrite(out) },
  ok: (s) => { const out = C.green + s + C.off + '\n'; UI.oneShot ? (drainMd(), process.stderr.write(out)) : outWrite(out) },
}

// Отладочная трассировка в файл (stdout при process.exit теряется, файл — нет).
const TRACE_FILE = process.env.DSH_TERM_TRACE
const trace = (s) => {
  if (!TRACE_FILE) return
  try { appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${s}\n`) } catch {}
}

// ---------- метрики токенов (usage из событий assistant/message) ----------
// У DeepSeek в usage поля РАЗДЕЛЬНЫЕ: inputTokens — без кэша, cacheRead/cacheWrite
// отдельно. Полный «контекст» запроса = их сумма. Максимум окна — как у адаптера
// llm-deepseek (DEFAULT_CONTEXT_WINDOW = 1_000_000); переопределить: DSH_TERM_CTX_MAX.
const CTX_MAX = (() => {
  const n = Number(process.env.DSH_TERM_CTX_MAX)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_000_000
})()

/** Компактный формат токенов: 340 / 1.2k / 1.5M. */
function fmtTok(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

/** Процент заполнения окна без лишних нулей: 0.03 / 0.6 / 12.5 / 100. */
function fmtPct(part, whole) {
  if (!whole || !Number.isFinite(part)) return '?'
  const p = (part / whole) * 100
  const s = p >= 100 ? p.toFixed(0) : p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3)
  return s.replace(/\.?0+$/, '')
}

/** Промпт-токены запроса (uncached input + кэш-чтение + кэш-запись). */
function promptTokensOf(u) {
  return (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0)
}

/** Кэш-токены запроса (чтение + запись) — показываются отдельно: они дешевле. */
function cacheTokensOf(u) {
  return (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0)
}

/** Пустые счётчики сессии: расход, кэш и число запросов к модели. */
function emptyMetrics() {
  return { prompts: 0, outputs: 0, cacheReads: 0, calls: 0 }
}

// ---------- живой счётчик токенов во время генерации ----------
// Точный usage API присылает только в конце запроса, поэтому «живой» счётчик —
// оценка по символам стрима (текст + reasoning); отношение chars/token
// калибруется по факту на каждом usage. Растёт целыми шагами: 200 … 201;
// больше 1000 — компактно: 1.1k, 1.2k. Пока видна анимация — счётчик рядом
// с подписью (светлее), во время видимого ответа — хвостиком за текстом.
const meter = { estChars: 0, stepChars: 0, ratio: 4, shown: 0, active: false, tail: 0, col: 0 }

function meterTarget() {
  return Math.floor(meter.estChars / meter.ratio)
}

function meterNum(n) {
  return n > 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
}

function meterCols() {
  const c = process.stdout.columns
  return Number.isInteger(c) && c > 10 ? c : 80
}

/** Видимая ширина строки: без ANSI-кодов; астральные символы (эмодзи) — 2 колонки. */
function meterVis(s) {
  let w = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
      if (m) i += m[0].length - 1
      continue
    }
    const c = s.codePointAt(i)
    if (c > 0xffff) { w += 2; i++ } else w += 1
  }
  return w
}

/** Учесть выведенный чистый текст: позиция колонки (для гарда от переноса хвоста). */
function meterNoteText(s) {
  const cols = meterCols()
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\n') { meter.col = 0; continue }
    let w = 1
    if (s.codePointAt(i) > 0xffff) { w = 2; i++ }
    meter.col += w
    if (meter.col >= cols) meter.col %= cols
  }
}

/** Шаг счётчика к цели: +1..6 за вызов (не обгоняем оценку). */
function meterBump() {
  const target = meterTarget()
  if (meter.shown >= target) return false
  meter.shown += Math.max(1, Math.min(6, target - meter.shown))
  return true
}

/** Текст счётчика «(N token)» / «(N tokens)». */
function meterTextOf(n) {
  return `(${meterNum(n)} ${n === 1 ? 'token' : 'tokens'})`
}

/** Текст счётчика после шага +1..6 (для анимации). */
function meterStepText() {
  meterBump()
  return meterTextOf(meter.shown)
}

/**
 * Стереть хвостовой счётчик (он всегда в конце текущей строки).
 * tail — ВИДИМАЯ ширина (без ANSI): иначе backspace уходил бы на предыдущую
 * строку и стирал текст ответа.
 */
function meterEraseTail() {
  if (meter.tail <= 0) return
  process.stdout.write('\b'.repeat(meter.tail) + ' '.repeat(meter.tail) + '\b'.repeat(meter.tail))
  meter.tail = 0
}

/**
 * Нарисовать счётчик в хвосте строки (после видимого текста, строка не закрыта).
 * Безопасно: только если хвост гарантированно помещается в строку — при
 * нехватке места (перенос строки сломал бы стирание) просто не рисуем.
 */
function meterDrawTail() {
  if (!meter.active || UI.oneShot) return
  if (!process.stdout.isTTY) return // хвостик — визуальный гаджет, только для терминала
  if (!UI.lastChar || UI.lastChar === '\n') return
  if (!meterBump()) return
  const text = ' ' + C.dim + meterTextOf(meter.shown) + C.reset
  const w = meterVis(text)
  if (meter.col + w >= meterCols()) return // не влезает — пропускаем (безопасно)
  meterEraseTail()
  process.stdout.write(text)
  meter.tail = w
}

// Тикер-подстраховка: если текст идёт реже тиков — счётчик всё равно догоняет цель.
const meterTicker = setInterval(() => {
  if (!meter.active || UI.oneShot || !process.stdout.isTTY) return
  if (UI.lastChar && UI.lastChar !== '\n') meterDrawTail()
}, 250)
if (meterTicker.unref) meterTicker.unref()

// ---------- лёгкий markdown-рендер ответа (вариант A) ----------
// Ничего не добавляет и не удаляет — только оборачивает фрагменты ANSI-кодами:
// текст, копия и -p (raw) не меняются. Незакрытые к началу следующего чанка
// конструкции остаются как есть (текст цел, стиль может «не успеть»); кодовые
// блоки (```/~~~) — состояние на весь ход. Только интерактивный TTY.
const mdCtx = { inFence: false, lineStart: true }

/** Цветной markdown-рендер включён: только интерактивный TTY, без NO_COLOR, не one-shot. */
function mdColorEnabled() {
  if (process.env.DSH_TERM_FORCE_MD) return true // диагностика/тесты
  return !!process.stdout.isTTY && !process.env.NO_COLOR && !UI.oneShot
}

/**
 * Раскрасить markdown-фрагмент. Без цвета (пайп / -p / NO_COLOR) — as-is.
 * ctx.lineStart/inFence — состояние между фрагментами одного хода.
 */
function mdStyle(s, ctx) {
  const colorOk = mdColorEnabled()
  if (!colorOk || !s) return s
  let out = ''
  let i = 0
  const n = s.length
  while (i < n) {
    const ch = s[i]
    if (ch === '\n') { ctx.lineStart = true; out += ch; i++; continue }
    if (ctx.lineStart) {
      ctx.lineStart = false
      const rest = s.slice(i)
      // Открытие/закрытие кодового блока — только с начала строки.
      const mFence = /^(```+|~~~+)[^\n]*/.exec(rest)
      if (mFence) {
        ctx.inFence = !ctx.inFence
        out += mFence[0] // саму строку-разделитель оставляем как есть
        i += mFence[0].length
        continue
      }
      if (!ctx.inFence) {
        const mHead = /^(#{1,6})[ \t]+/.exec(rest)
        if (mHead) {
          const bodyStart = i + mHead[0].length
          const e = s.indexOf('\n', bodyStart)
          const end = e < 0 ? n : e
          out += s.slice(i, bodyStart) + C.bold + DS.blue + s.slice(bodyStart, end) + C.off
          i = end
          continue
        }
      }
    }
    if (ctx.inFence) {
      // Содержимое кода: вся строка приглушённым цветом.
      const e = s.indexOf('\n', i)
      const end = e < 0 ? n : e
      out += C.dim + s.slice(i, end) + C.reset
      i = end
      continue
    }
    // Инлайн: `код`, **жирный**, *курсив*.
    if (ch === '`') {
      const close = s.indexOf('`', i + 1)
      if (close > i + 1) { out += C.cyan + s.slice(i + 1, close) + C.off; i = close + 1; continue }
      out += ch; i++; continue
    }
    if (ch === '*') {
      const two = s[i + 1] === '*'
      const close = two ? s.indexOf('**', i + 2) : s.indexOf('*', i + 1)
      if (close > i + (two ? 2 : 1)) {
        out += (two ? '\x1b[1m' : '\x1b[3m') + s.slice(i + (two ? 2 : 1), close) + (two ? '\x1b[22m' : '\x1b[23m')
        i = close + (two ? 2 : 1)
        continue
      }
      out += ch; i++; continue
    }
    out += ch
    i++
  }
  return out
}

/** Печать фрагмента ответа: markdown-стилизация + учёт колонок и последнего символа. */
function streamFlush(raw) {
  if (!raw) return
  meterEraseTail()
  UI.lastChar = raw[raw.length - 1]
  meterNoteText(raw)
  process.stdout.write(mdStyle(raw, mdCtx))
}

// Текст приходит крошечными чанками (1–2 символа), поэтому markdown-конструкции
// не успевают «собраться» в одном вызове. Буферизуем и стилизуем накопленное:
// по концу строки, по порогу длины или по таймеру (~120 мс) — почти как live.
const mdBuf = { s: '', timer: null }

/** Напечатать накопленный текст (если есть). */
function drainMd() {
  if (!mdBuf.s) return
  const raw = mdBuf.s
  mdBuf.s = ''
  if (mdBuf.timer) { clearTimeout(mdBuf.timer); mdBuf.timer = null }
  streamFlush(raw)
}

/** Накопить фрагмент ответа; напечатать, когда есть что стилизовать целиком. */
function mdFeed(raw) {
  if (!raw) return
  mdBuf.s += raw
  if (mdBuf.s.length >= 80 || mdBuf.s.endsWith('\n')) {
    drainMd()
  } else if (!mdBuf.timer) {
    mdBuf.timer = setTimeout(drainMd, 120)
    if (mdBuf.timer.unref) mdBuf.timer.unref()
  }
}

// ---------- анимация: переливающаяся синим подпись «Deep diving…» ----------
// Только TTY: на пайпе startStatus/stopStatus — no-op.
const CAPTION_TEXT = 'Deep diving…'

/**
 * Подпись «Deep diving…» с «переливанием» синим: каждый символ красится своим
 * truecolor-цветом по градиенту DeepSeek (тёмный #4166D5 → светло-голубой),
 * фаза волны сдвигается от кадра к кадру — светлый «гребень» бежит по тексту.
 * Без цвета (пайп / NO_COLOR) — обычная подпись cyan bold, как раньше.
 */
function captionFor(frame) {
  const colorOk = process.stdout.isTTY && !process.env.NO_COLOR
  if (!colorOk) return C.bold + C.cyan + CAPTION_TEXT + C.off
  const from = [65, 102, 213] // #4166D5 — тёмно-синий (акцент DeepSeek)
  const to = [178, 202, 255]  // светло-голубой (гребень «волны»)
  const L = CAPTION_TEXT.length
  const ph = (frame % 16) / 16 // полный цикл волны за 16 кадров (~2.2 с)
  let out = '\x1b[1m'
  for (let i = 0; i < L; i++) {
    const k = 0.5 + 0.5 * Math.sin(2 * Math.PI * (i / L - ph))
    const r = Math.round(from[0] + (to[0] - from[0]) * k)
    const g = Math.round(from[1] + (to[1] - from[1]) * k)
    const b = Math.round(from[2] + (to[2] - from[2]) * k)
    out += `\x1b[38;2;${r};${g};${b}m${CAPTION_TEXT[i]}`
  }
  return out + C.off
}
const status = { timer: null, frame: 0, enabled: process.stdout.isTTY && !process.env.DSH_TERM_NO_ANIM }

function startStatus() {
  if (UI.oneShot || !status.enabled || status.timer) return
  status.frame = 0
  const draw = () => {
    const f = status.frame++
    // Живой счётчик токенов — светлее, в скобках рядом с подписью.
    const suffix = meter.active ? ' ' + C.dim + meterStepText() + C.reset : ''
    process.stdout.write(`\r\x1b[K${captionFor(f)}${suffix}`)
  }
  draw()
  status.timer = setInterval(draw, 140)
}
function stopStatus() {
  // Очищаем строку ТОЛЬКО если анимация реально шла: иначе \r\x1b[K на каждый
  // text-delta чанк стирал бы уже напечатанный текст ответа.
  if (!status.timer) return
  clearInterval(status.timer)
  status.timer = null
  if (status.enabled) process.stdout.write('\r\x1b[K')
}

// ---------- построчный читатель stdin (единая очередь для токена и REPL) ----------
// readline здесь сознательно НЕ используется: его внутренняя буферизация теряет
// строки при закрытии интерфейса (дважды ловили это на пайпе).
const input = { buf: '', lines: [], waiters: [], eof: false, secretActive: false, editorActive: false }

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
    // Во время raw-ввода (секрет / редактор меню «/») рулит их собственный слушатель.
    if (input.editorActive || input.secretActive) return
    // Ctrl+C, дошедший как данные (консоль застряла в raw-режиме) — глушим.
    if (text.includes('\u0003')) process.exit(130)
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
function saveState(dshHome, sessionId, titles, locked) {
  try {
    mkdirSync(dshHome, { recursive: true })
    const data = { lastSessionId: sessionId }
    if (titles && Object.keys(titles).length) {
      // Мягкая обрезка: держим не больше 500 последних заголовков.
      const keys = Object.keys(titles)
      for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete titles[k]
      data.titles = titles
    }
    if (locked && locked.size) data.titleLocked = [...locked].slice(-500)
    writeFileSync(statePath(dshHome), JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch {}
}

/** Короткий заголовок сессии из первого промпта (когда харнесс свой ещё не дал). */
function titleFromPrompt(text) {
  const line = String(text).split('\n').find((l) => l.trim()) ?? ''
  const clean = line.replace(/[`*#>_[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > 48 ? clean.slice(0, 47).trimEnd() + '…' : clean
}

/** Привести ответ модели-саммаризатора к аккуратному заголовку. */
function cleanTitle(raw) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim()
  // Снимаем кавычки и завершающую пунктуацию в любом порядке (например «…». ).
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^[\s"'«»“”]+/, '').replace(/[\s"'«»“”]+$/, '').trim()
    t = t.replace(/[.。!?,;:]+$/, '').trim()
  }
  if (!t) return null
  const words = t.split(' ')
  if (words.length > 10) t = words.slice(0, 10).join(' ')
  if (t.length > 64) t = t.slice(0, 63).trimEnd() + '…'
  return t
}

/**
 * Заголовок-суть первого запроса через дешёвый отдельный вызов DeepSeek API
 * (≤10 слов). Ничего не пишет в сессию и не мешает диалогу; при любой ошибке
 * возвращает null — тогда остаётся черновой заголовок из первого промпта.
 */
function summarizeTitle(prompt, { token, model, provider }) {
  if (provider && provider !== 'deepseek-official') return Promise.resolve(null)
  if (!token) return Promise.resolve(null)
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: model || 'deepseek-v4-flash',
      messages: [
        {
          role: 'system',
          content: 'Сформулируй короткий заголовок сессии по первому сообщению пользователя. '
            + 'Передай суть запроса: 3–8 слов, без кавычек, без точки в конце, без пояснений. '
            + 'Отвечай ТОЛЬКО заголовком. Пример: «Привет! Помоги выбрать авиабилеты, проанализировав '
            + 'несколько источников» → Выбор авиабилетов из разных источников',
        },
        { role: 'user', content: String(prompt).slice(0, 2000) },
      ],
      max_tokens: 40,
      temperature: 0.2,
      // Заголовок нужен сразу и дешёво: у v4 thinking-режим по умолчанию съедает
      // весь бюджет в reasoning_content, оставляя content пустым.
      thinking: { type: 'disabled' },
      stream: false,
    })
    const req = httpsRequest('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 12000,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      trace(`title llm: http ${res.statusCode}`)
      res.on('data', (d) => { data += d })
      res.on('end', () => {
        trace(`title llm: body ${String(data).slice(0, 160)}`)
        try {
          const j = JSON.parse(data)
          const msg = j?.choices?.[0]?.message
          // content — обычный ответ; reasoning_content — на случай thinking-режима.
          resolve(cleanTitle(msg?.content) ?? cleanTitle(msg?.reasoning_content))
        } catch { resolve(null) }
      })
    })
    req.on('error', (e) => { trace(`title llm: err ${e.message}`); resolve(null) })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

/** «Заголовок» + id тусклым, как в claude; без заголовка — просто id. */
function fmtSession(id, title) {
  return title ? `«${title}» ${C.dim}${id}${C.reset}` : id
}

/** Выбор сессии по номеру, id, префиксу id или части заголовка. */
function resolveSessionPick(pick, list, titles) {
  if (/^\d+$/.test(pick)) return list[Number(pick) - 1] ?? null
  if (list.includes(pick)) return pick
  const byId = list.filter((id) => id.startsWith(pick))
  if (byId.length === 1) return byId[0]
  const low = pick.toLowerCase()
  const byTitle = list.filter((id) => (titles?.[id] ?? '').toLowerCase().includes(low))
  if (byTitle.length === 1) return byTitle[0]
  return null
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
  log.dim('В REPL: начни набирать «/» — появится меню команд (↑↓ — выбрать, Enter — запустить).')
}

// ---------- меню команд: raw-редактор строки ввода («/» как в claude) ----------
// Только интерактивный TTY: сам печатает промпт и ввод, ловит стрелки ↑/↓ для
// навигации по меню, Enter запускает выбранную команду, Esc закрывает меню.
// На пайпе и в one-shot (-p) не используется — там построчный читатель.
const COMMAND_MENU_KEYS = '↑↓ — выбрать · Enter — запустить · Esc — закрыть'

/** Совпадения по подстроке после «/»; префиксные — первыми. null — меню не нужно. */
function menuMatches(buf) {
  if (!buf.startsWith('/') || buf.includes(' ')) return null
  const low = buf.slice(1).toLowerCase()
  const hit = (c) => c.name.startsWith(low) || c.name.includes(low)
  const items = COMMANDS.filter(hit).sort(
    (a, b) => (b.name.startsWith(low) ? 1 : 0) - (a.name.startsWith(low) ? 1 : 0),
  )
  return { items, sel: 0 }
}

/** Ширина под одну строку терминала (чтобы ни одна строка не переносилась). */
function menuWidth() {
  const c = process.stdout.columns
  return Number.isInteger(c) && c > 20 ? c - 1 : 70
}

// Фирменная гамма DeepSeek (см. uicolours.com/brands/deepseek): основной синий
// #4D6BFE (77,107,254), светло-синий вариант #6E8BFF (110,139,255). Truecolor SGR;
// вне TTY / при NO_COLOR — пустые коды (рендер без цвета).
const DS = process.stdout.isTTY && !process.env.NO_COLOR
  ? { blue: '\x1b[38;2;77;107;254m', sky: '\x1b[38;2;110;139;255m' }
  : { blue: '', sky: '' }

/** Обрезать ANSI-строку до menuWidth видимых символов, не разрезая escape-коды. */
function menuClip(s) {
  const w = menuWidth()
  let vis = 0
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
      if (m) { out += m[0]; i += m[0].length - 1; continue }
      out += s[i]
      continue
    }
    if (vis >= w) return out + '…' + '\x1b[0m'
    out += s[i]
    vis++
  }
  return out
}

/** Линия-разделитель: светло-синяя, во всю ширину; отделяет меню от чата/ввода. */
function menuSeparator() {
  return DS.sky + '─'.repeat(Math.max(10, menuWidth())) + C.off
}

/** Перерисовать блок ввода+меню; курсор остаётся в конце строки ввода. force — repair-тик. */
function editorRender(ed, force) {
  const row0 = ed.prompt + ed.buf
  // no-op guard: состояние не менялось — не дёргаем экран (кроме force-перерисовки).
  const key = row0 + '\u0000' + (ed.menu ? ed.menu.items.map((x) => x.name).join(',') + '#' + ed.menu.sel : '-')
  if (!force && ed._key === key) return
  ed._key = key
  let out = '\r\x1b[J' + row0 // стереть строку ввода и всё ниже, нарисовать заново
  if (ed.menu) {
    const rows = [menuSeparator()]
    if (ed.menu.items.length) {
      for (let i = 0; i < ed.menu.items.length; i++) {
        const c = ed.menu.items[i]
        const sel = i === ed.menu.sel
        // Выбранный пункт — фирменный синий DeepSeek + ▸; остальные — спокойные.
        const row = sel
          ? `${DS.blue}▸${C.off} ${C.bold}${DS.blue}/${c.name}${C.off}${C.dim} — ${c.desc}${C.off}`
          : `  /${c.name}${C.dim} — ${c.desc}${C.off}`
        rows.push(menuClip(row))
      }
    } else {
      rows.push(menuClip(`${C.dim}  (нет команд по «/${ed.buf.slice(1)}»)${C.off}`))
    }
    rows.push(menuClip(`${DS.sky}${COMMAND_MENU_KEYS}${C.off}`))
    out += '\n' + rows.join('\n') + `\x1b[${rows.length}A\x1b[${meterVis(row0) + 1}G`
  }
  process.stdout.write(out)
}

/** Одна строка интерактивного ввода с меню команд. '' — пустая строка, null — EOF. */
function readLineTTY(promptText) {
  return new Promise((resolve) => {
    const ed = { prompt: promptText, buf: '', sel: 0, menu: null }
    let done = false
    const cleanup = () => {
      input.editorActive = false
      clearInterval(ed.tick)
      try { process.stdout.removeListener('resize', onResize) } catch {}
      try { process.stdin.setRawMode(false) } catch {}
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
    }
    const recompute = () => {
      ed.menu = menuMatches(ed.buf)
      if (ed.menu && ed.menu.items.length) ed.menu.sel = Math.min(ed.sel, ed.menu.items.length - 1)
    }
    const commit = (line) => {
      // Показать итоговую строку как «введённую» и перейти на следующую строку.
      process.stdout.write('\r\x1b[J' + ed.prompt + line + '\n')
    }
    const finish = (line) => {
      if (done) return
      done = true
      cleanup()
      commit(line)
      resolve(line)
    }
    const abort = () => {
      if (done) return
      done = true
      cleanup()
      resolve(null)
    }
    const onEnd = () => abort()
    const onData = (chunk) => {
      const seq = chunk.toString()
      for (let i = 0; i < seq.length; i++) {
        const ch = seq[i]
        if (ch === '\x1b') {
          if (seq[i + 1] === '[') {
            // CSI: пропускаем до финального байта (@..~); ↑ (A) / ↓ (B) — навигация по меню.
            let j = i + 2
            while (j < seq.length && !(seq.charCodeAt(j) >= 0x40 && seq.charCodeAt(j) <= 0x7e)) j++
            if (j >= seq.length) break // оборванная последовательность — отбрасываем
            const fn = seq[j]
            if ((fn === 'A' || fn === 'B') && ed.menu && ed.menu.items.length > 1) {
              const n = ed.menu.items.length
              ed.sel = fn === 'A' ? (ed.sel + n - 1) % n : (ed.sel + 1) % n
              ed.menu.sel = ed.sel
              editorRender(ed)
            }
            i = j
            continue
          }
          // Одиночный Esc — закрыть меню (набранное остаётся).
          if (ed.menu) { ed.menu = null; editorRender(ed) }
          continue
        }
        if (ch === '\u0003') {
          // Ctrl+C в raw-режиме: вернуть терминал в норму и уйти по штатному SIGINT.
          done = true
          cleanup()
          process.emit('SIGINT')
          return
        }
        if (ch === '\u0004') {
          // Ctrl+D: EOF при пустой строке — завершаемся.
          if (!ed.buf) { abort(); return }
          continue
        }
        if (ch === '\r' || ch === '\n') {
          // Enter: меню открыто и есть совпадения — запускаем выбранную команду.
          let line = ed.buf
          if (ed.menu && ed.menu.items.length) line = '/' + ed.menu.items[ed.menu.sel].name
          finish(line)
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          if (!ed.buf) continue
          ed.buf = ed.buf.slice(0, -1)
          recompute()
          editorRender(ed)
          continue
        }
        if (ch < ' ') continue // прочие управляющие байты (мусор фокуса/вкладок) — игнорируем
        ed.buf += ch
        recompute()
        editorRender(ed)
      }
    }
    input.editorActive = true
    try {
      process.stdin.setRawMode(true)
    } catch (e) {
      // Редкий случай: raw недоступен — читаем обычной строкой (без меню).
      input.editorActive = false
      process.stdout.write(promptText)
      takeInputLine().then((l) => resolve(l))
      return
    }
    // Самовосстановление: пока меню открыто, периодически перерисовываем блок —
    // стираем любые «призрачные» копии, которые терминал мог оставить после
    // переключения вкладок/фокуса (иначе строки «dsh> /» дублируются).
    const onResize = () => { if (!done && ed.menu) editorRender(ed, true) }
    ed.tick = setInterval(() => { if (!done && ed.menu) editorRender(ed, true) }, 300)
    if (ed.tick.unref) ed.tick.unref()
    process.stdout.on('resize', onResize)
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    editorRender(ed) // начальный промпт
  })
}

// ---------- выбор сессии стрелками (как меню команд) ----------
const SESSION_PICK_KEYS = '↑↓ — выбрать · Enter — ок · Esc — отмена · набор — фильтр'

/** Отфильтровать сессии по подстроке в id или заголовке. */
function pickFilter(list, titles, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return list.slice()
  return list.filter((id) => id.toLowerCase().includes(q) || String(titles?.[id] ?? '').toLowerCase().includes(q))
}

/** Видимое окно списка (не больше max строк), отцентрованное на выбранной. */
function pickWindow(total, sel, max) {
  if (total <= max) return { start: 0, count: total }
  const start = Math.max(0, Math.min(sel - Math.floor(max / 2), total - max))
  return { start, count: max }
}

/** Нарисовать блок выбора: строка запроса + разделитель + окно списка + подсказка. */
function pickRender(st) {
  const row0 = st.prompt + st.query
  const listRows = []
  const { start, count } = pickWindow(st.items.length, st.sel, 12)
  if (st.items.length === 0) {
    listRows.push(menuClip(`${C.dim}  (ничего не найдено)${C.off}`))
  } else {
    if (start > 0) listRows.push(`${C.dim}  … ещё ${start}${C.off}`)
    for (let k = 0; k < count; k++) {
      const i = start + k
      const id = st.items[i]
      const sel = i === st.sel
      const title = st.titles?.[id]
      const mark = sel ? `${DS.blue}▸${C.off}` : ' '
      // Метка: заголовок, а если его нет — сам id (иначе строка была бы пустой).
      const label = title ? `«${title}»` : id
      const labelStyled = sel ? `${C.bold}${DS.blue}${label}${C.off}` : label
      // id идёт вторичным (тусклым) текстом только когда есть заголовок.
      const tail = title ? ` ${C.dim}${id}${C.reset}` : ''
      listRows.push(menuClip(`${mark} ${labelStyled}${tail}`))
    }
    if (start + count < st.items.length) listRows.push(`${C.dim}  … ещё ${st.items.length - start - count}${C.off}`)
  }
  // Разделитель над списком — как у меню команд (светло-синий, во всю ширину).
  const rows = [menuSeparator(), ...listRows, `${C.dim}${SESSION_PICK_KEYS}${C.off}`]
  const out = `\r\x1b[J${row0}\n${rows.join('\n')}\x1b[${rows.length}A\x1b[${meterVis(row0) + 1}G`
  process.stdout.write(out)
}

/**
 * Выбор сессии: в TTY — стрелками/фильтром (как меню команд), в пайпе —
 * прежний построчный ввод. Возвращает id сессии или null (отмена).
 */
function pickSessionTTY(list, titles) {
  const prompt = 'resume> '
  if (!process.stdin.isTTY) {
    list.forEach((id, i) => log.line(`  ${i + 1}. ${fmtSession(id, titles?.[id])}`))
    return askLine('номер, id или часть заголовка (Enter — отмена): ').then((pick) => {
      const p = String(pick ?? '').trim()
      return p ? resolveSessionPick(p, list, titles) : null
    })
  }
  return new Promise((resolve) => {
    const st = { prompt, query: '', sel: 0, items: pickFilter(list, titles, ''), titles, tick: null }
    let done = false
    let onResize = () => {}
    const recompute = () => {
      st.items = pickFilter(list, titles, st.query)
      if (st.sel >= st.items.length) st.sel = Math.max(0, st.items.length - 1)
    }
    const cleanup = () => {
      input.editorActive = false
      clearInterval(st.tick)
      try { process.stdout.removeListener('resize', onResize) } catch {}
      try { process.stdin.setRawMode(false) } catch {}
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
    }
    const finish = (id) => {
      if (done) return
      done = true
      cleanup()
      // Закоммитить строку запроса и показать выбранное.
      process.stdout.write(`\r\x1b[J${st.prompt}${st.query}\n`)
      if (id) log.line(`  ${fmtSession(id, titles?.[id])}`)
      resolve(id)
    }
    const onEnd = () => finish(null)
    const onData = (chunk) => {
      const seq = chunk.toString()
      for (let i = 0; i < seq.length; i++) {
        const ch = seq[i]
        if (ch === '\x1b') {
          if (seq[i + 1] === '[') {
            let j = i + 2
            while (j < seq.length && !(seq.charCodeAt(j) >= 0x40 && seq.charCodeAt(j) <= 0x7e)) j++
            if (j >= seq.length) break
            const fn = seq[j]
            if ((fn === 'A' || fn === 'B') && st.items.length > 1) {
              const n = st.items.length
              st.sel = fn === 'A' ? (st.sel + n - 1) % n : (st.sel + 1) % n
              pickRender(st)
            }
            i = j
            continue
          }
          // Esc: сначала очищает фильтр, потом отменяет выбор.
          if (st.query) { st.query = ''; st.sel = 0; recompute(); pickRender(st) } else { finish(null); return }
          continue
        }
        if (ch === '\u0003') {
          done = true
          cleanup()
          process.emit('SIGINT')
          return
        }
        if (ch === '\u0004') { finish(null); return }
        if (ch === '\r' || ch === '\n') { finish(st.items[st.sel] ?? null); return }
        if (ch === '\u007f' || ch === '\b') {
          if (!st.query) continue
          st.query = st.query.slice(0, -1)
          st.sel = 0
          recompute()
          pickRender(st)
          continue
        }
        if (ch < ' ') continue
        st.query += ch
        st.sel = 0
        recompute()
        pickRender(st)
      }
    }
    input.editorActive = true
    try {
      process.stdin.setRawMode(true)
    } catch (e) {
      input.editorActive = false
      list.forEach((id, i) => log.line(`  ${i + 1}. ${fmtSession(id, titles?.[id])}`))
      askLine('номер, id или часть заголовка (Enter — отмена): ').then((pick) => {
        const p = String(pick ?? '').trim()
        resolve(p ? resolveSessionPick(p, list, titles) : null)
      })
      return
    }
    // Самовосстановление блока (как у меню команд): призраки после переключения вкладок.
    onResize = () => { if (!done) pickRender(st) }
    st.tick = setInterval(() => { if (!done) pickRender(st) }, 300)
    if (st.tick.unref) st.tick.unref()
    process.stdout.on('resize', onResize)
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    pickRender(st)
  })
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
    log.line('Меню команд: начни вводить «/» — список с фильтром по подстроке,')
    log.line('↑↓ — выбрать команду, Enter — запустить, Esc — закрыть меню.')
    log.line('')
    log.line('При первом входе dsh-term сам запросит DEEPSEEK API ключ и сохранит его')
    log.line(`в ${credentialsPath(opts.dshHome)}; последняя сессия запоминается и автоматически продолжается.`)
    log.line('Пока модель думает, в терминале переливается «Deep diving…» (отключить: DSH_TERM_NO_ANIM=1).')
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
    metrics: emptyMetrics(), // расход сессии: prompts/outputs/cacheReads/calls
    titles: { ...(saved?.titles ?? {}) }, // sessionId → короткий заголовок сессии
    titleLocked: new Set(saved?.titleLocked ?? []), // заголовки, которые харнесс не перебивает
    isNew: false,              // сессия создана в этом запуске (для авто-заголовка)
  }
  // В one-shot state не сохраняем: прогоны не должны затирать «последнюю сессию»
  // для интерактивного режима (у каждого -p запуска и так своя свежая сессия).
  state.isNew = !isOneShot && !(opts.session || (saved?.lastSessionId === sessionId))
  if (!isOneShot) saveState(opts.dshHome, sessionId, state.titles, state.titleLocked)

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
      // Заголовок сессии фиксируем ДО гейта по state.turn: харнесс добавляет
      // session/title после хода, когда state.turn уже null (как lastEndKind).
      if (mine && event.type === 'session/title') {
        const title = event.data?.title
        const cur = state.titles[state.sessionId]
        // Харнесс отдаёт свой (часто укороченный) заголовок: не перебиваем уже
        // сформулированный нами (LLM-саммаризация) и не укорачиваем свой черновой.
        const keepOurs = !!title && !!cur && cur.startsWith(title) && cur.length > title.length
        if (title && !state.titleLocked.has(state.sessionId) && !keepOurs && cur !== title) {
          state.titles[state.sessionId] = title
          trace(`session title: ${title}`)
          if (!UI.oneShot) {
            saveState(opts.dshHome, state.sessionId, state.titles, state.titleLocked)
            log.dim(`· заголовок сессии: «${title}»`)
          }
        }
      }
      if (!mine || !state.turn) return
      renderEvent(event)
    }
  }

  function renderEvent(event) {
    switch (event.type) {
      case 'assistant/chunk': {
        const c = event.data.chunk
        // Живой счётчик: считаем каждый символ стрима (текст + reasoning).
        if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
          meter.estChars += c.text.length
          meter.stepChars += c.text.length
        }
        if (c.type === 'text-delta') {
          // Пошёл видимый ответ — анимация останавливается, текст стримится.
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
          if (flush) { mdFeed(flush); t.streamedCount += flush.length }
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
        // Живой счётчик токенов: перерисовать в хвосте строки после фрагмента.
        if (!state.turn?.cut) meterDrawTail()
        // reasoning-delta намеренно не печатаем: в это время идёт анимация
        // (капшон «Deep diving…»), как в веб-приложении DeepSeek.
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
        // Пустая строка после вывода модели.
        if (state.streamedText) log.line('')
        const r = event.data.reason
        // Причина ошибки: `{ kind: 'error', error: LlmFailure }` — поле `error`,
        // а не `failure` (это было причиной «глухого» вывода ошибок).
        const f = r.error ?? r.failure
        const steps = state.turn?.steps ?? []
        if (steps.length) {
          // Линия на всю ширину терминала, затем блок, начинающийся с «turn».
          const ctx = steps[steps.length - 1].prompt
          log.dim('─'.repeat(Math.max(10, meterCols() - 1)))
          const head = f
            ? `— turn ${event.data.turn} ended: ${r.kind} (${f.code ?? f.name}: ${f.message})`
            : `— turn ${event.data.turn} ended: ${r.kind}`
          if (f) log.err(head)
          else log.dim(head)
          log.dim(`  tokens: in ${fmtTok(state.metrics.prompts)} (cache ${fmtTok(state.metrics.cacheReads)}) / out ${fmtTok(state.metrics.outputs)}`)
          log.dim(`  requests: ${state.metrics.calls} (this turn: ${steps.length})`)
          log.dim(`  context: ${fmtTok(ctx)} / ${fmtTok(CTX_MAX)} (${fmtPct(ctx, CTX_MAX)}%)`)
        } else if (f) {
          log.err(`— turn ${event.data.turn} ended: ${r.kind} (${f.code ?? f.name}: ${f.message})`)
        } else {
          log.dim(`— turn ${event.data.turn} ended: ${r.kind}`)
        }
        break
      }
      case 'assistant/message': {
        if (event.data.interrupted) {
          stopStatus()
          log.dim('— (interrupted)')
        }
        // Метрики токенов: usage приходит на каждое готовое сообщение шага.
        const u = event.data.usage
        const t = state.turn
        if (u && t) {
          const prompt = promptTokensOf(u)
          const output = u.outputTokens ?? 0
          const cache = cacheTokensOf(u)
          state.metrics.prompts += prompt
          state.metrics.outputs += output
          state.metrics.cacheReads += cache
          state.metrics.calls += 1 // один запрос к модели = одно готовое сообщение шага
          t.steps.push({ prompt, output, cache })
          // Калибровка «живого» счётчика по факту: символы стрима ↔ выходные токены.
          if (meter.stepChars > 20 && output > 0) {
            const r = meter.stepChars / output
            if (r > 0.5 && r < 20) meter.ratio = meter.ratio * 0.7 + r * 0.3
          }
          meter.stepChars = 0
          // Реактивно: в многошаговом ходе (цепочка инструментов) — стоимость каждого шага.
          if (t.steps.length >= 2) {
            // Текст ответа мог не закончиться переводом строки — сначала закроем строку
            // (иначе «· step N» приклеится к последнему символу ответа).
            if (!UI.oneShot && state.streamedText && UI.lastChar && UI.lastChar !== '\n') log.line('')
            log.dim(`· step ${t.steps.length}: in ${fmtTok(prompt)} / out ${fmtTok(output)}`)
          }
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
    if (tail) { mdFeed(tail); t.streamedCount += tail.length }
  }

  function finishTurn() {
    meter.active = false
    meterEraseTail() // хвостовой счётчик, если строка осталась незакрытой
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
        steps: [],    // usage по шагам хода: { prompt, output }
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
    // Живой счётчик токенов: новый ход — с нуля.
    meter.active = true
    meter.estChars = 0
    meter.stepChars = 0
    meter.shown = 0
    meter.tail = 0
    meter.col = 0
    // Markdown-состояние (кодовые блоки) и буфер — тоже с нуля.
    mdBuf.s = ''
    if (mdBuf.timer) { clearTimeout(mdBuf.timer); mdBuf.timer = null }
    mdCtx.inFence = false
    mdCtx.lineStart = true
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
      // Заголовок для новой сессии: сразу черновой (из промпта), затем в фоне —
      // LLM-саммаризация сути запроса (≤10 слов), которая его заменит.
      if (!UI.oneShot && state.isNew && !state.titles[state.sessionId]) {
        const title = titleFromPrompt(text)
        const sid = state.sessionId
        if (title) {
          state.titles[sid] = title
          saveState(opts.dshHome, sid, state.titles, state.titleLocked)
        }
        trace('title llm: start')
        summarizeTitle(text, { token, model: opts.model, provider: opts.provider }).then((sum) => {
          trace(`title llm: result=${sum}`)
          if (!sum || state.sessionId !== sid || state.titles[sid] === sum) return
          state.titles[sid] = sum
          state.titleLocked.add(sid) // финальный заголовок: харнесс своим не перебьёт
          trace(`title llm: ${sum}`)
          saveState(opts.dshHome, sid, state.titles, state.titleLocked)
          log.dim(`· заголовок сессии: «${sum}»`)
        }).catch(() => {})
      }
      const res = await rpc.request('session/prompt', {
        sessionId: state.sessionId,
        contentBlocks: [{ type: 'text', text: body }],
      })
      trace(`prompt queued: ${res.messageId}`)
      log.dim(`(queued ${res.messageId})`)
      startStatus() // модель думает — крутится «Deep diving…»
    } catch (e) {
      meter.active = false
      meterEraseTail()
      stopStatus()
      trace(`prompt failed: ${e.message}`)
      log.err(`prompt failed: ${e.message}`)
      state.turn = null
      return false
    }
    await waiting
    drainMd() // гарантированно допечатать остаток буфера (если таймер не успел)
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
        log.line(fmtSession(state.sessionId, state.titles[state.sessionId]))
        break
      }
      case 'resume': {
        const target = parts[1]
        if (target) {
          const known = listSessions(opts.dshHome)
          const resolved = resolveSessionPick(target, known, state.titles) ?? target
          state.sessionId = resolved
          state.children.clear()
          state.isNew = false
          state.metrics = emptyMetrics()
          saveState(opts.dshHome, resolved, state.titles, state.titleLocked)
          log.line(`${C.dim}resuming session:${C.reset} ${fmtSession(resolved, state.titles[resolved])}`)
        } else {
          const list = listSessions(opts.dshHome)
          if (list.length === 0) { log.err('нет сохранённых сессий в этом home'); break }
          const chosen = await pickSessionTTY(list, state.titles)
          if (!chosen) { log.line('отменено'); break }
          if (!chosen) { log.err('нет такой сессии'); break }
          state.sessionId = chosen
          state.children.clear()
          state.isNew = false
          state.metrics = emptyMetrics()
          saveState(opts.dshHome, chosen, state.titles, state.titleLocked)
          log.line(`${C.dim}resuming session:${C.reset} ${fmtSession(chosen, state.titles[chosen])}`)
        }
        break
      }
      case 'new': {
        state.sessionId = randomUUID()
        state.children.clear()
        state.isNew = true
        state.metrics = emptyMetrics()
        saveState(opts.dshHome, state.sessionId, state.titles, state.titleLocked)
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
      if (process.stdin.isTTY) {
        // Интерактивный TTY: raw-редактор строки с меню команд («/» + ↑↓).
        // Строки, набранные в cooked-режиме, пока модель думала, лежат в очереди —
        // обрабатываем их в первую очередь (type-ahead, как было раньше).
        while (!exiting) {
          if (input.eof) { exiting = true; break }
          let text
          if (input.lines.length > 0) {
            text = input.lines.shift()
          } else {
            const line = await readLineTTY(PROMPT)
            if (exiting) break
            if (line == null) { exiting = true; break } // EOF (Ctrl+D / закрыт stdin)
            text = line
          }
          const t = String(text).trim()
          trace(`pump line: ${t}`)
          if (!t) continue
          if (t.startsWith('/')) {
            await handleCommand(t)
            continue
          }
          await promptTurn(t)
        }
      } else {
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
      }
    } finally {
      busy = false
      trace('pump end')
      // EOF: ввод исчерпан — после обработки всех строк корректно завершаемся.
      if (!exiting && input.eof) exiting = true
      if (exiting) {
        stopStatus()
        try { await rpc.close() } catch {}
        process.exit(0)
      }
      if (!process.stdin.isTTY) process.stdout.write(PROMPT)
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
    // Диагностика UI: понятно, почему нет цветов/рендера (tty/NO_COLOR/one-shot).
    log.dim(`ui: in-tty=${process.stdin.isTTY ? 1 : 0} out-tty=${process.stdout.isTTY ? 1 : 0} colors=${C.cyan ? 1 : 0} md=${mdColorEnabled() ? 1 : 0}`)
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
  log.line(`${C.dim}${resumed ? 'resuming' : 'new'} session:${C.reset} ${fmtSession(state.sessionId, state.titles[state.sessionId])}`)
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
