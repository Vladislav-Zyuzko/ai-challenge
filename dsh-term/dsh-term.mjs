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
import { basename, join, resolve } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

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
// asking = на экране диалог клиента (вопрос/подтверждение): пока он открыт, живой
// счётчик и подпись не перерисовываются, иначе они мигают поверх меню.
const UI = { oneShot: false, lastChar: '', asking: false }
function outWrite(s) {
  drainMd() // сначала напечатать накопленный текст ответа (порядок вывода)
  meterEraseTail() // новый контент — сначала убрать хвостовой счётчик токенов
  UI.lastChar = s.length > 0 ? s[s.length - 1] : UI.lastChar
  meterNoteText(s) // служебные строки тоже двигают курсор — иначе счётчик уедет за границу
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

/** Пустые счётчики сессии: расход, кэш, запросы и работа суммаризатора. */
function emptyMetrics() {
  return { prompts: 0, outputs: 0, cacheReads: 0, calls: 0, lastPrompt: 0, compactions: 0, compactTokens: 0, compactFails: 0, factsCalls: 0, factsTokens: 0, profileCalls: 0, profileTokens: 0 }
}

// ---------- управление контекстом: компрессия истории ----------
// Настройки передаются харнессу патч-оверлеем (`dsh --patch`), поэтому править
// Program Files не нужно. Механизм харнесса: недавний «хвост» держится как есть
// (retainTokens), остальное суммируется LLM-ом и подставляется в запрос вместо
// полной истории (событие `compaction/summary`).
const COMPRESS_DEFAULT_RATIO = 0.1   // срабатывать при 10% заполнения окна
const COMPRESS_DEFAULT_KEEP = 50000  // «последние сообщения как есть» ≈ 50k токенов (5% окна)
const COMPRESS_SYSTEM_FLOOR = 8000   // неподвижный префикс: системный промпт + описания инструментов

/** Политика компрессии в токенах — единственная объективная метрика (сообщения субъективны). */
function compressPolicyText(c) {
  if (!c || c.mode !== 'on') return ''
  return ` (compact at ${fmtTok(c.thresholdTokens)} tokens, keep last ${fmtTok(c.keep)} tokens)`
}

/**
 * Замечания к выбранной политике компрессии (пусто — всё согласовано).
 * Харнесс требует `retainTokens < thresholdRatio × contextWindow`: иначе спека
 * отбрасывается (`TargetPressureConfigError`) и компакция НЕ работает — в логе
 * харнесса остаётся только warning, а сессия молча едет без сжатия.
 * @param {{mode: string, keep: number, thresholdTokens: number}} c - политика.
 * @returns {string[]} human-readable замечания для диагностики.
 */
function compressNotes(c, extraFloor = 0) {
  if (!c || c.mode !== 'on') return []
  const notes = []
  // Неподвижный префикс = системный промпт + описания инструментов (+ MCP, если
  // серверы подключены: их описания тоже уходят в каждый запрос).
  const floor = COMPRESS_SYSTEM_FLOOR + (Number.isFinite(extraFloor) ? extraFloor : 0)
  if (c.keep >= c.thresholdTokens) {
    notes.push(`keep ${fmtTok(c.keep)} >= threshold ${fmtTok(c.thresholdTokens)}: harness rejects this policy`
      + ' (retainTokens must be < threshold), so compaction will NOT run — raise --compress or lower --compress-keep')
  }
  if (c.thresholdTokens < floor + 5000) {
    notes.push(`compact threshold ${fmtTok(c.thresholdTokens)} is close to the fixed prefix (${fmtTok(floor)}`
      + `${extraFloor ? ` = ${fmtTok(COMPRESS_SYSTEM_FLOOR)} + ${fmtTok(extraFloor)} MCP` : ', system prompt + tools'})`
      + ' — in agentic turns compaction will fire at once; use --compress 0.05 for a sane default')
  }
  // За вычетом неподвижного префикса и хвоста «как есть» — сколько реально уходит в summary.
  // Порог 5k: сам summary весит ≈1k, поэтому участок меньше ~5k даёт выигрыш, который
  // не окупает вызов (он переигрывает префикс: in ≈ префикс + участок).
  const compactable = c.thresholdTokens - floor - c.keep
  if (c.keep < c.thresholdTokens && compactable < 5000) {
    notes.push(`only ≈ ${fmtTok(Math.max(0, compactable))} tokens per compaction (threshold ${fmtTok(c.thresholdTokens)}`
      + ` − prefix ${fmtTok(floor)} − keep ${fmtTok(c.keep)}), while the summary itself weighs ≈1k`
      + ' (fixed 8-section structure) — such compactions reclaim almost nothing; raise --compress or lower --compress-keep')
  }
  return notes
}

/**
 * YAML-оверлей профиля, включающий инструмент `ask_user_question`.
 * В base-бандле смонтирован сервис вопросов (`user-questions`), но сам
 * модельный инструмент — нет; строка добавляется через `insert` (оверлей умеет
 * и менять строки по id, и добавлять новые списком).
 */
function toolsPatchYaml() {
  return [
    '# dsh-term: инструмент ask_user_question (вопросы к пользователю с вариантами).',
    '# Отключить: DSH_TERM_NO_ASK_TOOL=1.',
    '- insert:',
    '    - id: tool-ask-user',
    "      name: '@deepseek-ai/dsh-tool-ask-user'",
    '',
  ].join('\n')
}

/**
 * Есть ли уже строка инструмента вопросов в пользовательском слое профиля.
 * Оверлей с `insert` НЕ идемпотентен: повторная вставка того же id валит
 * загрузку дерева плагинов («duplicate loader entry id»), поэтому проверяем.
 */
function profileHasAskToolRow(dshHome, profile) {
  const p = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  const md = readTextIfExists(p)
  return md !== null && md.includes('dsh-tool-ask-user')
}

/** YAML-патч для профиля: `on` — авто-компакция с нашими порогами, `off` — выключено. */function compressPatchYaml(compress) {
  if (compress.mode === 'off') {
    // Плагин НЕ отключаем: его сервис `compaction` нужен command-compact, иначе
    // дерево плагинов не загрузится. Просто выключаем автоматическую компакцию.
    return [
      '# dsh-term: авто-компрессия истории выключена (baseline для сравнения)',
      '- id: compaction-basic',
      '  config:',
      '    auto: false',
      '',
    ].join('\n')
  }
  return [
    '# dsh-term: авто-компрессия истории (thresholdRatio × contextWindow).',
    '# id-патч заменяет config целиком, поэтому задаём нужные поля явно.',
    '- id: compaction-basic',
    '  config:',
    '    auto: true',
    `    thresholdRatio: ${compress.ratio}`,
    `    retainTokens: ${compress.keep}`,
    '    maxTokens: 4096',
    '    compactionRetries: 1',
    '',
  ].join('\n')
}

// ---------- живой счётчик токенов во время генерации ----------
// Точный usage API присылает только в конце запроса, поэтому «живой» счётчик —
// оценка по символам стрима (текст + reasoning); отношение chars/token
// калибруется по факту на каждом usage. Растёт целыми шагами: 200 … 201;
// больше 1000 — компактно: 1.1k, 1.2k. Пока видна анимация — счётчик рядом
// с подписью (светлее), во время видимого ответа — хвостиком за текстом.
const meter = { estChars: 0, stepChars: 0, ratio: 4, shown: 0, active: false, tail: 0, col: 0, edge: false }

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

/**
 * Учесть выведенный чистый текст: позиция колонки (для гарда от переноса хвоста).
 * Учитываем `\n`/`\r` (сброс), табы (до следующей позиции кратной 8), ANSI-коды и
 * астральные символы. `edge` — «строка заполнена до последней колонки»: терминал
 * держит курсор в последней колонке (отложенный перенос), и следующий символ
 * уйдёт на новую строку. В этом состоянии счётчик рисовать нельзя — он окажется
 * на двух строках, и стирание до конца строки его не уберёт.
 */
function meterNoteText(s) {
  const cols = meterCols()
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\n' || ch === '\r') { meter.col = 0; meter.edge = false; continue }
    if (ch === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i))
      if (m) i += m[0].length - 1
      continue
    }
    if (ch === '\t') { meter.col += 8 - (meter.col % 8); continue }
    let w = 1
    if (s.codePointAt(i) > 0xffff) { w = 2; i++ }
    const next = meter.col + w
    meter.edge = next >= cols
    meter.col = meter.edge ? next - cols : next
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
 * Стереть хвостовой счётчик: backspace-ами по его ВИДИМОЙ ширине.
 *
 * Так можно, потому что рисовать счётчик разрешено только когда он целиком
 * помещается в текущую строку с запасом (см. meterDrawTail: `edge` запрещает
 * рисовать в заполненной строке, плюс запас в колонку). Значит `\b`×tail не
 * уходит на предыдущую строку, а пробелы не вызывают перенос.
 * Раньше это ломалось: колонка считалась без табов/ANSI/служебных строк, счётчик
 * рисовался у самой границы и уезжал на вторую строку — `\b` до него не доставал,
 * и в тексте ответа оставались куски «(3.1k t». Регресс ловит
 * tests/render-screen.test.mjs (в т.ч. DSH_TEST_IGNORE_SAVE=1 — терминал без
 * ESC 7/8: счётчик не должен зависеть от сохранения курсора).
 */
function meterEraseTail() {
  if (meter.tail <= 0) return
  process.stdout.write('\b'.repeat(meter.tail) + ' '.repeat(meter.tail) + '\b'.repeat(meter.tail))
  meter.tail = 0
}

/**
 * Нарисовать счётчик в хвосте строки (после видимого текста, строка не закрыта).
 * Если хвост не влезает с запасом в 1 колонку или строка уже заполнена до
 * последней колонки (отложенный перенос) — не рисуем вовсе: тогда стирание
 * backspace-ами гарантированно остаётся внутри строки.
 */
function meterDrawTail() {
  if (UI.asking) return // на экране диалог клиента — не рисуем поверх него
  if (process.env.DSH_TERM_NO_METER) return // диагностика: выключить живой счётчик
  if (!meter.active || UI.oneShot) return
  if (!process.stdout.isTTY) return // хвостик — визуальный гаджет, только для терминала
  if (!UI.lastChar || UI.lastChar === '\n') return
  if (!meterBump()) return
  const text = ' ' + C.dim + meterTextOf(meter.shown) + C.reset
  const w = meterVis(text)
  if (meter.edge || meter.col + w + 1 >= meterCols()) return // не влезает — пропускаем (безопасно)
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
  const styled = mdStyle(raw, mdCtx)
  process.stdout.write(styled)
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
    const caption = captionFor(f)
    process.stdout.write(`\r\x1b[K${caption}${suffix}`)
    // Строка под нашим контролем: счётчик затёрт, курсор — в конце подписи.
    meter.tail = 0
    const capW = meterVis(caption + suffix)
    meter.edge = capW >= meterCols()
    meter.col = meter.edge ? capW - meterCols() : capW
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
  if (status.enabled) {
    process.stdout.write('\r\x1b[K')
    meter.tail = 0 // строка очищена вместе с хвостовым счётчиком
    meter.col = 0
    meter.edge = false
  }
}

/**
 * Служебная строка при активной анимации: сначала погасить подпись, потом
 * печатать (иначе текст приклеивается к «Deep diving… (N tokens)»), затем
 * вернуть подпись.
 * @param {() => void} fn - вывод одной служебной строки.
 */
function withStatusPaused(fn) {
  const animated = status.timer !== null
  stopStatus()
  fn()
  if (animated) startStatus()
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

/**
 * Один служебный вызов DeepSeek вне сессии харнесса (facts и прочие вспомогательные
 * задачи): возвращает текст, распарсенный JSON (если есть) и расход токенов —
 * его обязательно считать отдельно, иначе сравнение стратегий будет нечестным.
 */
function llmJson({ token, model, provider }, system, user, maxTokens = 700) {
  if (provider && provider !== 'deepseek-official') return Promise.resolve(null)
  if (!token) return Promise.resolve(null)
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: model || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      // thinking выключен: служебный ответ нужен целиком в content и дешевле.
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
      timeout: 30000,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { data += d })
      res.on('end', () => {
        try {
          const j = JSON.parse(data)
          const text = String(j?.choices?.[0]?.message?.content ?? '')
          const u = j?.usage ?? {}
          const promptTokens = u.prompt_tokens ?? 0
          const outputTokens = u.completion_tokens ?? 0
          let json = null
          const m = /\{[\s\S]*\}/.exec(text)
          if (m) { try { json = JSON.parse(m[0]) } catch { json = null } }
          trace(`llm call: in ${promptTokens} out ${outputTokens}`)
          resolve({ text, json, promptTokens, outputTokens, tokens: promptTokens + outputTokens })
        } catch { resolve(null) }
      })
    })
    req.on('error', (e) => { trace(`llm call err: ${e.message}`); resolve(null) })
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

// ---------- стратегии управления контекстом (day10) ----------
// Контекст собирает КЛИЕНТ: dsh-term сам хранит диалог (транскрипт, facts, ветки)
// и на каждый ход отправляет в харнесс ровно то, что выбрала стратегия. Поэтому
// режим переключается на ходу (без перезапуска рантайма), а расход виден в метриках.
// Харнесс-сессия на каждый ход берётся свежая: иначе его поверхность накапливала бы
// полную историю и в модель уходило бы больше, чем решила стратегия.
const STRATEGIES = [
  { id: 'sliding', title: 'Sliding Window', desc: 'только последние N сообщений, остальное отбрасывается' },
  { id: 'facts', title: 'Sticky Facts', desc: 'facts (ключ-значение) + последние N сообщений' },
  { id: 'branch', title: 'Branching', desc: 'ветки диалога от чекпоинта + переключение между ними' },
]
/** Режим по умолчанию: контекстом управляет харнесс (компрессия из day9). */
const STRATEGY_HARNESS = 'harness'
const CTX_DEFAULT_WINDOW = 6   // N сообщений для окна
const CTX_FACTS_WINDOW = 10    // сколько последних сообщений видит обновление facts
const CTX_FACT_KEYS = ['цель', 'ограничения', 'предпочтения', 'решения', 'договорённости']

function contextDir(dshHome) { return join(dshHome, 'context') }
function contextPath(dshHome, id) { return join(contextDir(dshHome), id + '.json') }

/** Хранилище диалога (создаётся при первом ходе в режиме стратегии). */
function newContext(id, strategy, window) {
  return {
    id,
    strategy,
    window,
    messages: [],        // вся линия диалога (main)
    facts: {},           // ключ-значение: цель/ограничения/предпочтения/решения/договорённости
    checkpoint: null,    // { atMessage, note } — место ветвления
    branches: {},        // id ветки → { name, messages, createdAt }
    activeBranch: 'main',
    branchSeq: 0,
    factsCalls: 0,
    factsTokens: 0,
  }
}

function loadContext(dshHome, id) {
  try { return JSON.parse(readFileSync(contextPath(dshHome, id), 'utf8')) } catch { return null }
}

function saveContext(dshHome, ctx) {
  try {
    mkdirSync(contextDir(dshHome), { recursive: true })
    ctx.updatedAt = new Date().toISOString()
    writeFileSync(contextPath(dshHome, ctx.id), JSON.stringify(ctx, null, 2) + '\n', 'utf8')
  } catch (e) { trace(`context save failed: ${e.message}`) }
}

/** Сообщения активной линии диалога (main или выбранной ветки). */
function activeMessages(ctx) {
  if (ctx.activeBranch === 'main') return ctx.messages
  return ctx.branches[ctx.activeBranch]?.messages ?? []
}

/** Последние n сообщений активной линии. */
function windowMessages(ctx, n) {
  const m = activeMessages(ctx)
  return n > 0 ? m.slice(-n) : []
}

/** Диалог в виде текста: «Пользователь: … / Ассистент: …». */
function transcriptText(messages) {
  return messages.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.text}`).join('\n\n')
}

/**
 * Текст запроса по выбранной стратегии.
 * `harness` — отдаём только сообщение пользователя (контекстом управляет харнесс).
 * @param {object} ctx - хранилище диалога.
 * @param {string} userText - новое сообщение пользователя.
 * @param {{skipLast?: number}} [opts] - сколько последних сообщений не включать в окно
 *   (само новое сообщение уже лежит в памяти — иначе оно попало бы дважды).
 * @returns {{text: string, windowCount: number, factsCount: number}} что уйдёт в модель.
 */
function composeContextText(ctx, userText, opts = {}) {
  const all = activeMessages(ctx)
  const skip = Math.max(0, Math.min(opts.skipLast ?? 0, all.length))
  const win = (skip ? all.slice(0, all.length - skip) : all).slice(-ctx.window)
  const body = transcriptText(win)
  if (ctx.strategy === 'sliding') {
    if (!win.length) return { text: userText, windowCount: 0, factsCount: 0 }
    return {
      text: [
        `Ниже — последние ${win.length} сообщений нашего диалога (более ранние недоступны).`,
        '<диалог>',
        body,
        '</диалог>',
        '',
        'Новое сообщение пользователя:',
        userText,
      ].join('\n'),
      windowCount: win.length,
      factsCount: 0,
    }
  }
  // facts и branch: блок facts (в branch он появляется, только если что-то накоплено) + окно
  const lines = CTX_FACT_KEYS.filter((k) => ctx.facts[k]).map((k) => `- ${k}: ${ctx.facts[k]}`)
  const parts = []
  if (ctx.strategy === 'facts' || lines.length) {
    parts.push('Известные факты о задаче (ключ-значение):', lines.length ? lines.join('\n') : '- (пока пусто)')
  }
  if (win.length) parts.push('', `Последние ${win.length} сообщений диалога:`, '<диалог>', body, '</диалог>')
  parts.push('', 'Новое сообщение пользователя:', userText)
  return { text: parts.join('\n'), windowCount: win.length, factsCount: lines.length }
}

/**
 * Обновление facts после сообщения пользователя: отдельный дешёвый вызов DeepSeek
 * (вне сессии харнесса). На вход — прошлые facts + последние CTX_FACTS_WINDOW
 * сообщений, на выход — JSON с фиксированными ключами (пустые не затирают старые).
 * @returns {Promise<{facts: object, tokens: number}|null>} новые facts и расход вызова.
 */
function updateFacts({ token, model, provider }, ctx) {
  if (!token) return Promise.resolve(null)
  const prev = CTX_FACT_KEYS.filter((k) => ctx.facts[k]).map((k) => `- ${k}: ${ctx.facts[k]}`).join('\n') || '(пусто)'
  const dialog = transcriptText(windowMessages(ctx, CTX_FACTS_WINDOW))
  const system = 'Ты ведёшь «facts» (ключ-значение) о задаче пользователя для агента-ассистента. '
    + 'По диалогу обнови факты: цель, ограничения, предпочтения, решения, договорённости. '
    + 'Пиши кратко (до 200 символов на ключ), сохраняй конкретику: числа, сроки, названия, имена. '
    + 'НЕ удаляй известное, если оно не отменено явно; дополняй и уточняй. '
    + `Отвечай ТОЛЬКО JSON-объектом с ключами: ${CTX_FACT_KEYS.join(', ')}. `
    + 'Неизвестное оставляй пустой строкой.'
  const user = `Уже известные факты:\n${prev}\n\nДиалог (последние ${Math.min(CTX_FACTS_WINDOW, activeMessages(ctx).length)} сообщений):\n${dialog}`
  return llmJson({ token, model, provider }, system, user, 700).then((r) => {
    if (!r) return null
    const facts = { ...ctx.facts }
    for (const k of CTX_FACT_KEYS) {
      const v = r.json?.[k]
      if (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null') facts[k] = v.trim()
    }
    return { facts, tokens: r.tokens }
  })
}

/** Текущее состояние стратегии для UI: «sliding (окно 6)» / «harness». */
function strategyLabel(ctx) {
  if (!ctx || ctx.strategy === STRATEGY_HARNESS) return STRATEGY_HARNESS
  const win = ctx.strategy === 'branch' ? `ветка ${ctx.activeBranch}, окно ${ctx.window}` : `окно ${ctx.window}`
  return `${ctx.strategy} (${win})`
}

/** Следующий свободный id ветки: A, B, C, … Z, A27, B28 … */
function nextBranchId(ctx) {
  const n = (ctx.branchSeq ?? 0) + 1
  const letter = String.fromCharCode(65 + ((n - 1) % 26))
  return n > 26 ? `${letter}${n}` : letter
}

/**
 * Чекпоинт + ПАРА веток от одного места (стратегия branching): каждая ветка
 * получает копию диалога на момент чекпоинта и дальше живёт независимо.
 * @param {object} ctx - хранилище диалога.
 * @param {string} name - подпись пары веток.
 * @returns {string[]} id созданных веток.
 */
function createBranchPair(ctx, name) {
  const base = activeMessages(ctx)
  ctx.checkpoint = { atMessage: base.length, note: name, at: new Date().toISOString() }
  const mk = (suffix) => {
    ctx.branchSeq = (ctx.branchSeq ?? 0) + 1
    const id = nextBranchId({ branchSeq: ctx.branchSeq - 1 })
    ctx.branches[id] = {
      name: `${name}${suffix}`,
      messages: base.map((m) => ({ ...m })),
      createdAt: new Date().toISOString(),
    }
    return id
  }
  const a = mk(' · A')
  const b = mk(' · B')
  ctx.activeBranch = a
  return [a, b]
}

/** Переключить активную ветку диалога (main или созданная); id — без учёта регистра. */
function switchBranch(ctx, id) {
  if (typeof id !== 'string') return false
  const want = id.toLowerCase()
  if (want === 'main') { ctx.activeBranch = 'main'; return true }
  const found = Object.keys(ctx.branches ?? {}).find((b) => b.toLowerCase() === want)
  if (found === undefined) return false
  ctx.activeBranch = found
  return true
}

/** «Заголовок» + id тусклым, как в claude; без заголовка — просто id. */
function fmtSession(id, title) {  return title ? `«${title}» ${C.dim}${id}${C.reset}` : id
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
 * `sessions/<ns-по-рабочей-папке>/<sessionId>/session[.vN].jsonl[.zstd]` —
 * id сессии это имя папки, в которой лежит лог `session*.jsonl`. */
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
      // Имя лога зависит от версии формата: session.jsonl[.zstd], session.v3.jsonl.zstd, …
      else if (/^session(\.[\w-]+)?\.jsonl(\.zstd)?$/.test(e.name)) {
        const id = basename(d)
        // Служебные сессии ходов в режиме стратегий (day10) в списке не нужны.
        if (id.startsWith('ctx-')) continue
        out.push(id) // родительская папка = sessionId
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
    compress: undefined,     // компрессия истории: 'on' | 'off' | <ratio 0..1>
    compressKeep: undefined, // сколько последних токенов держать как есть
    strategy: undefined,     // стратегия управления контекстом: harness | sliding | facts | branch
    window: undefined,       // N сообщений для стратегий
    withProfiles: undefined, // --with-profiles: выбрать профиль пользователя в начале сессии
    userProfile: undefined,  // --user-profile <slug>: включить конкретный профиль пользователя
    mcp: undefined,          // --mcp <preset>: подключить MCP-сервер (повторяемый), напр. github
    mcpToolsets: undefined,  // --mcp-toolsets <list|all>: тулсеты GitHub MCP
    mcpReadwrite: undefined, // --mcp-readwrite: снять режим «только чтение» у MCP-пресета
    mcpCheck: undefined,     // --mcp-check [preset]: только соединение + список инструментов, без сессии
    offline: undefined,      // --mcp-check --offline: показать оверлей и выйти (без сети)
    autoApprove: undefined,  // разрешать запросы доступа без вопросов (env DSH_TERM_AUTO_APPROVE)
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
      case '--compress': opts.compress = next(); break
      case '--compress-keep': opts.compressKeep = Number(next()); break
      case '--strategy': case '--mode': opts.strategy = next(); break
      case '--window': opts.window = Number(next()); break
      case '--auto-approve': opts.autoApprove = true; break
      case '--with-profiles': opts.withProfiles = true; break
      case '--user-profile': opts.userProfile = next(); break
      case '--mcp': opts.mcp = [...(opts.mcp ?? []), next()]; break
      case '--mcp-toolsets': opts.mcpToolsets = next(); break
      case '--mcp-readwrite': opts.mcpReadwrite = true; break
      case '--mcp-check': {
        // Необязательный аргумент: `--mcp-check github` или просто `--mcp-check`.
        const v = argv[i + 1]
        opts.mcpCheck = v && !v.startsWith('-') ? next() : MCP_DEFAULT_PRESET
        break
      }
      case '--offline': opts.offline = true; break
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
    // Сервер может СПРАШИВАТЬ клиента (user/question, user/approval) — это
    // двусторонний JSON-RPC: id + method = запрос к нам, отвечаем id + result.
    this.onRequest = () => { throw new Error('client request handler is not installed') }
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
      if (msg.id !== undefined && msg.method !== undefined) { void this.#answer(msg); continue } // запрос сервера к клиенту
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

  /** Ответить на запрос сервера: result или error (клиент не должен молчать). */
  async #answer(msg) {
    trace(`incoming ${msg.method} id=${msg.id}`)
    let frame
    try {
      const result = await this.onRequest(msg.method, msg.params ?? {})
      frame = { jsonrpc: '2.0', id: msg.id, result }
    } catch (e) {
      trace(`incoming handler failed: ${e?.message ?? e}`)
      frame = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }
    }
    try { this.child.stdin.write(JSON.stringify(frame) + '\n') } catch (e) { trace(`reply failed: ${e.message}`) }
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
    // Ждём РЕАЛЬНОГО выхода процесса, а не таймаут: рантайм держит kernel-lease
    // сессии (named semaphore на Windows, flock на POSIX), и пока процесс жив,
    // следующий рантайм не сможет резюмировать ту же сессию («already owned by
    // an active write handle»). Поэтому после SIGKILL ждём события exit.
    await new Promise((r) => {
      let done = false
      const finish = () => { if (!done) { done = true; clearTimeout(t); clearTimeout(hard); r() } }
      const t = setTimeout(() => { try { this.child.kill('SIGKILL') } catch {} }, 1500)
      // Страховка: если события exit не будет вовсе, не висим дольше 4 секунд.
      const hard = setTimeout(finish, 4000)
      this.child.once('exit', finish)
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
  // Патч-оверлеи (наши настройки компрессии) накладываются поверх профиля.
  for (const p of opts.patches ?? []) args.push('--patch', p)
  // Окружение для рантайма: токен через DEEPSEEK_API_KEY (для харнесса окружение
  // приоритетнее managed-файла) либо уже сохранён в его home.
  const env = {
    ...process.env,
    DSH_HOME: opts.dshHome,
    ...(token ? { DEEPSEEK_API_KEY: token } : {}),
    // Секреты MCP-серверов: оверлей читает их через !!js, в файле их нет.
    ...(opts.mcpEnv ?? {}),
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
  { name: 'session', usage: '/session', desc: 'показать текущую сессию (заголовок и id)' },
  { name: 'strategy', usage: '/strategy [id]', desc: 'стратегия контекста: sliding | facts | branch | harness (меню)' },
  { name: 'branch', usage: '/branch [id|new]', desc: 'ветки диалога: чекпоинт, новая ветка, переключение (включает режим branch)' },
  { name: 'context', usage: '/context', desc: 'контекст: стратегия, факты, метрики, последний summary' },
  { name: 'profile', usage: '/profile [show|list|use <slug>|new|off]', desc: 'профиль пользователя (персонализация): показать, сменить, создать, выключить' },
  { name: 'mcp', usage: '/mcp [show|tools|refresh]', desc: 'MCP-серверы: соединение, список инструментов и их цена в промпте' },
  { name: 'resume', usage: '/resume [id]', desc: 'продолжить сессию: по id или выбором из списка' },
  { name: 'new', usage: '/new', desc: 'начать новую сессию' },
  { name: 'token', usage: '/token', desc: 'сменить сохранённый DEEPSEEK API ключ' },
  { name: 'publish-day', usage: '/publish-day', desc: 'git+gh: коммит → push → PR day→week (по SKILLS)' },
  { name: 'create-project', usage: '/create-project [что строим] [--check <path>]', desc: 'сессия архитектора проекта: опросник → .project-harness → инструменты → ноды' },
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

/**
 * Подсказка о текущем режиме прямо в списке команд: «/branch» имеет смысл только
 * в режиме branch (команда сама в него переключает), а /strategy показывает, где
 * мы сейчас. Значение обновляет main при каждом переключении режима/сессии.
 */
let strategyHint = STRATEGY_HARNESS

function commandDesc(c) {
  if (c.name === 'branch' && strategyHint !== 'branch') return `${c.desc} · переключит режим на branch`
  if (c.name === 'strategy') return `${c.desc} · сейчас: ${strategyHint}`
  return c.desc
}

function printCommandUsage(name) {
  const c = COMMANDS.find((x) => x.name === name)
  if (c) log.line(`  ${C.cyan}${c.usage}${C.off} — ${commandDesc(c)}`)
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
  const cols = meterCols()
  const w = meterVis(row0)
  // Ввод может занимать НЕСКОЛЬКО визуальных строк (перенос по ширине терминала).
  // `\r\x1b[J` стирает только текущую строку и ниже, поэтому сначала поднимаемся
  // на высоту прошлого рендера — иначе копии «dsh> …» остаются на строках выше и
  // каждый введённый символ добавляет ещё одну (регресс: tests/editor-wrap.test.mjs).
  const rows0 = Math.max(1, Math.ceil(w / cols))
  const prev = ed.rows ?? 1
  let out = (prev > 1 ? `\x1b[${prev - 1}A` : '') + '\r\x1b[J' + row0
  if (ed.menu) {
    const rows = [menuSeparator()]
    if (ed.menu.items.length) {
      for (let i = 0; i < ed.menu.items.length; i++) {
        const c = ed.menu.items[i]
        const sel = i === ed.menu.sel
        // Выбранный пункт — фирменный синий DeepSeek + ▸; остальные — спокойные.
        const row = sel
          ? `${DS.blue}▸${C.off} ${C.bold}${DS.blue}/${c.name}${C.off}${C.dim} — ${commandDesc(c)}${C.off}`
          : `  /${c.name}${C.dim} — ${commandDesc(c)}${C.off}`
        rows.push(menuClip(row))
      }
    } else {
      rows.push(menuClip(`${C.dim}  (нет команд по «/${ed.buf.slice(1)}»)${C.off}`))
    }
    rows.push(menuClip(`${DS.sky}${COMMAND_MENU_KEYS}${C.off}`))
    out += '\n' + rows.join('\n') + `\x1b[${rows.length}A`
    // Колонка курсора внутри ПЕРЕНЕСЁННОЙ строки: w % cols, а не w + 1.
    const col = w > 0 && w % cols === 0 ? cols : (w % cols) + 1
    out += `\x1b[${col}G`
  }
  ed.rows = rows0
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
      // Высоту прошлого рендера учитываем: длинный ввод занимал несколько строк.
      const prev = ed.rows ?? 1
      process.stdout.write((prev > 1 ? `\x1b[${prev - 1}A` : '') + '\r\x1b[J' + ed.prompt + line + '\n')
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

/**
 * Универсальный выбор из списка в стиле /resume (для /strategy и /branch):
 * стрелки, фильтр по подстроке, Enter — выбрать, Esc — отмена; в пайпе — номер или id.
 * @param {{prompt: string, items: Array<{id: string, label: string, note?: string, current?: boolean}>}} spec
 * @returns {Promise<string|null>} id выбранного пункта (null — отмена).
 */
function pickListTTY(spec) {
  const items = spec.items
  const multi = spec.multi === true // выбор нескольких: пробел — отметить, Enter — подтвердить
  const filter = (q) => {
    const s = String(q ?? '').trim().toLowerCase()
    if (!s) return items.slice()
    return items.filter((it) => it.id.toLowerCase().includes(s)
      || it.label.toLowerCase().includes(s) || String(it.note ?? '').toLowerCase().includes(s))
  }
  if (!process.stdin.isTTY) {
    items.forEach((it, i) => log.line(`  ${i + 1}. ${it.label}${it.note ? ` — ${it.note}` : ''}`))
    return askLine(multi ? 'номера через запятую (Enter — отмена): ' : 'номер или id (Enter — отмена): ').then((pick) => {
      const p = String(pick ?? '').trim()
      if (!p) return multi ? [] : null
      if (multi) {
        return p.split(/[,\s]+/).map((t) => {
          const n = Number(t)
          if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1].id
          const f = items.find((it) => it.id.toLowerCase() === t.toLowerCase())
          return f ? f.id : null
        }).filter((id) => id !== null)
      }
      const byNum = Number(p)
      if (Number.isInteger(byNum) && byNum >= 1 && byNum <= items.length) return items[byNum - 1].id
      const found = items.find((it) => it.id.toLowerCase() === p.toLowerCase())
      return found ? found.id : null
    })
  }
  const render = (st) => {
    const row0 = st.prompt + st.query
    const rows = []
    const { start, count } = pickWindow(st.items.length, st.sel, 8)
    if (st.items.length === 0) rows.push(menuClip(`${C.dim}  (ничего не найдено)${C.off}`))
    for (let k = 0; k < count; k++) {
      const it = st.items[start + k]
      const sel = start + k === st.sel
      const mark = sel ? `${DS.blue}▸${C.off}` : ' '
      const dot = it.current ? `${DS.sky}•${C.off}` : ' '
      const box = multi ? `${st.chosen.has(it.id) ? `${DS.sky}[x]${C.off}` : '[ ]'} ` : ''
      const label = sel ? `${C.bold}${DS.blue}${it.label}${C.off}` : it.label
      const note = it.note ? ` ${C.dim}${it.note}${C.reset}` : ''
      rows.push(menuClip(`${mark} ${dot} ${box}${label}${note}`))
    }
    process.stdout.write(`\r\x1b[J${row0}\n${[menuSeparator(), ...rows, `${C.dim}${SESSION_PICK_KEYS}${C.off}`].join('\n')}\x1b[${rows.length + 2}A\x1b[${meterVis(row0) + 1}G`)
  }
  return new Promise((resolve) => {
    const st = { prompt: spec.prompt, query: '', sel: 0, items: filter(''), chosen: new Set() }
    let done = false
    let onResize = () => {}
    const recompute = () => {
      st.items = filter(st.query)
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
      process.stdout.write(`\r\x1b[J${st.prompt}${st.query}\n`)
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
              render(st)
            }
            i = j
            continue
          }
          if (st.query) { st.query = ''; st.sel = 0; recompute(); render(st) } else { finish(null); return }
          continue
        }
        if (ch === '\u0003') { done = true; cleanup(); process.emit('SIGINT'); return }
        if (ch === '\u0004') { finish(multi ? [...st.chosen] : null); return }
        if (ch === '\r' || ch === '\n') {
          if (multi) { finish([...st.chosen]); return }
          finish(st.items[st.sel]?.id ?? null)
          return
        }
        if (multi && ch === ' ') {
          // Пробел отмечает/снимает текущий пункт (множественный выбор).
          const id = st.items[st.sel]?.id
          if (id !== undefined) {
            if (st.chosen.has(id)) st.chosen.delete(id)
            else st.chosen.add(id)
            render(st)
          }
          continue
        }
        if (ch === '\u007f' || ch === '\b') {
          if (!st.query) continue
          st.query = st.query.slice(0, -1)
          st.sel = 0
          recompute()
          render(st)
          continue
        }
        if (ch < ' ') continue
        st.query += ch
        st.sel = 0
        recompute()
        render(st)
      }
    }
    input.editorActive = true
    try {
      process.stdin.setRawMode(true)
    } catch {
      input.editorActive = false
      items.forEach((it, i) => log.line(`  ${i + 1}. ${it.label}`))
      askLine('номер или id (Enter — отмена): ').then((pick) => resolve(String(pick ?? '').trim() || null))
      return
    }
    onResize = () => { if (!done) render(st) }
    st.tick = setInterval(() => { if (!done) render(st) }, 300)
    if (st.tick.unref) st.tick.unref()
    process.stdout.on('resize', onResize)
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    render(st)
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

// ---------- профили пользователя (day12): персонализация поверх памяти ----------
// Профиль — предпочтения пользователя (стиль, формат, ограничения, интересы,
// явные просьбы, чего избегать). Живёт в ~/.dsh-term/user-profiles/<slug>.md
// (человекочитаемо, правится руками), а в модель попадает через system prompt:
// оверлей `- id: system-prompt` + `personaPrefix`. Папка `profiles/` занята
// рантайм-профилями харнесса (sdk/web), поэтому профили пользователя отдельно.
const USER_PROFILE_SECTIONS = [
  { key: 'style', title: 'Стиль' },
  { key: 'format', title: 'Формат' },
  { key: 'constraints', title: 'Ограничения' },
  { key: 'interests', title: 'Интересы и контекст' },
  { key: 'explicit', title: 'Явные просьбы' },
  { key: 'avoid', title: 'Чего избегать' },
]
const USER_PROFILE_MAX_ITEMS = 6       // пунктов в секции (после слияния)
const USER_PROFILE_ITEM_CHARS = 180    // длина пункта
const USER_PROFILE_BUDGET_TOKENS = 700 // бюджет текста профиля внутри system prompt

function userProfilesDir(dshHome) { return join(dshHome, 'user-profiles') }
function userProfilePath(dshHome, slug) { return join(userProfilesDir(dshHome), `${slug}.md`) }

/** Слаг из заголовка: латиница/цифры/дефис (кириллица транслитерируется грубо). */
function userProfileSlug(title) {
  const map = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  }
  const slug = String(title ?? '').toLowerCase().split('').map((ch) => map[ch] ?? ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return slug || 'default'
}

/** Собрать текст профиля — он же уходит в system prompt (personaPrefix). */
function renderUserProfile({ title, sections }) {
  const lines = [`# Профиль пользователя: ${title}`]
  for (const s of USER_PROFILE_SECTIONS) {
    const items = (sections?.[s.key] ?? []).filter(Boolean)
    if (!items.length) continue
    lines.push('', `## ${s.title}`, ...items.map((i) => `- ${i}`))
  }
  return lines.join('\n')
}

/** Разобрать профиль из md: `# Заголовок` + секции `## Название` со списком пунктов. */
function readUserProfile(dshHome, slug) {
  const raw = readTextIfExists(userProfilePath(dshHome, slug))
  if (raw === null) return null
  // Без снятия BOM первая строка не матчится и заголовок теряется (профиль,
  // сохранённый «Блокнотом»/VS Code с BOM, встречается регулярно).
  const text = raw.replace(/^\uFEFF/, '')
  const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? slug).trim().replace(/^Профиль пользователя:\s*/i, '')
  const sections = {}
  for (const s of USER_PROFILE_SECTIONS) sections[s.key] = []
  let current = null
  for (const line of text.split('\n')) {
    const head = /^##\s+(.+?)\s*$/.exec(line)
    if (head) {
      const found = USER_PROFILE_SECTIONS.find((s) => s.title.toLowerCase() === head[1].toLowerCase())
      current = found === undefined ? null : found.key
      continue
    }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
    if (item && current !== null) sections[current].push(item[1])
  }
  return { slug, title, sections, text: renderUserProfile({ title, sections }) }
}

/** Список профилей: slug, заголовок, размер в токенах, время изменения. */
function listUserProfiles(dshHome) {
  const dir = userProfilesDir(dshHome)
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const slug = e.name.slice(0, -3)
    const parsed = readUserProfile(dshHome, slug)
    if (parsed === null) continue
    let mtime = 0
    try { mtime = statSync(join(dir, e.name)).mtimeMs } catch {}
    out.push({ slug, title: parsed.title, tokens: userProfileTokens(parsed), mtime })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function writeUserProfile(dshHome, slug, { title, sections }) {
  try {
    mkdirSync(userProfilesDir(dshHome), { recursive: true })
    writeFileSync(userProfilePath(dshHome, slug), renderUserProfile({ title, sections }) + '\n', 'utf8')
    return true
  } catch (e) {
    trace(`user profile write failed: ${e.message}`)
    return false
  }
}

/**
 * Рамка приоритета: профиль — то, что пользователь выбрал сейчас, поэтому он
 * старше более ранних договорённостей из переписки. Без неё модель видит два
 * источника о стиле (профиль в system prompt и история диалога) и в конфликте
 * выбирает историю как более свежую: наблюдали профиль «только эмодзи», поверх
 * сессии, где раньше было сказано «эмодзи не нужны» — модель отвечала словами.
 */
const USER_PROFILE_PRECEDENCE = [
  'Пользователь выбрал профиль ниже — это его текущие предпочтения, и они главнее',
  'всего, что говорилось о стиле, формате, языке, длине ответа и эмодзи в истории',
  'диалога: прежние такие договорённости, включая те, что ты сам ранее подтверждал,',
  'отменены выбором профиля. Единственный источник правил стиля — этот профиль.',
].join('\n')

/** Сколько токенов занимает профиль в промпте (оценка по символам). */
function userProfileTokens(profile) {
  return Math.ceil(userProfilePromptText(profile).length / 4)
}

/** Текст профиля ровно в том виде, в каком он уходит в system prompt. */
function userProfilePromptText(profile) {
  return `${USER_PROFILE_PRECEDENCE}\n\n${renderUserProfile(profile)}`
}

/**
 * Объявление профиля для префикса к промпту. Рамки в system prompt недостаточно:
 * если в переписке раньше звучала просьба о стиле (например «эмодзи не нужны»),
 * модель держится за неё как за прямое указание пользователя и игнорирует профиль.
 * Объявление в САМОМ СВЕЖЕМ сообщении (как и контролы --format) даёт профилю
 * приоритет по свежести — проверено на сессии с противоречащей историей.
 */
function profileNoticeText(profile) {
  return profile
    ? `Пользователь выбрал профиль «${profile.title}»: его правила стиля, формата, языка и длины ответа действуют с этого сообщения и отменяют прежние договорённости об этом в переписке — даже если раньше звучала просьба наоборот.`
    : 'Персонализация отключена: прежние правила профиля (стиль, формат, язык, длина ответа) больше не действуют.'
}

/**
 * YAML-оверлей: профиль как personaPrefix системного промпта.
 *
 * Оверлей пишется из {@link userProfilePromptText} (профиль + рамка приоритета),
 * а не из «сырого» текста профиля: рамка — часть того, что видит модель.
 */
function userProfileOverlayYaml(profile) {
  const indented = userProfilePromptText(profile).split('\n').map((l) => `      ${l}`).join('\n')
  return [
    '# dsh-term: профиль пользователя в system prompt (personaPrefix).',
    '- id: system-prompt',
    '  config:',
    '    personaPrefix: |-',
    indented,
    '',
  ].join('\n')
}

/** Слить новые пункты в секции: без дублей, с лимитом пунктов на секцию. */
function mergeProfileSections(current, incoming) {
  const sections = {}
  const added = []
  for (const s of USER_PROFILE_SECTIONS) {
    const have = [...(current?.[s.key] ?? [])]
    const seen = new Set(have.map((i) => i.toLowerCase().replace(/\s+/g, ' ').trim()))
    for (const raw of incoming?.[s.key] ?? []) {
      const item = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, USER_PROFILE_ITEM_CHARS)
      if (item.length < 3) continue
      const key = item.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)
      have.push(item)
      added.push({ section: s.key, item })
    }
    sections[s.key] = have.slice(-USER_PROFILE_MAX_ITEMS)
  }
  return { sections, added }
}

/**
 * Персонализация по одному сообщению пользователя: что нового узнать о нём и о
 * том, как с ним работать. Возвращает только НОВЫЕ пункты (по секциям).
 */
function analyzePersonalization(llm, profile, userText, onUsage) {
  const system = 'Ты ведёшь профиль пользователя для ассистента-агента. По очередному сообщению '
    + 'пользователя найди ТОЛЬКО новое о нём и о том, как с ним работать: стиль общения, формат ответов, '
    + 'ограничения, интересы и рабочий контекст, явные просьбы, чего избегать. '
    + 'Не повторяй то, что уже есть в профиле, и не дублируй один пункт в разных разделах: '
    + 'каждый пункт идёт ровно в одну секцию — самую точную по смыслу (стиль и формат — как отвечать, '
    + 'ограничения — чего нельзя, интересы — контекст пользователя, явные просьбы — прямые просьбы о поведении, '
    + 'чего избегать — нелюбимое). Не создавай мета-пункты вида «запомнить предпочтения»: каждый пункт — '
    + 'самостоятельная инструкция. '
    + 'Пиши короткие императивные пункты (до 180 символов), '
    + 'без воды и без выводов о личности. Если нового нет — верни пустые массивы. '
    + `Отвечай ТОЛЬКО JSON с ключами: ${USER_PROFILE_SECTIONS.map((s) => s.key).join(', ')}.`
  const user = `Текущий профиль:\n${renderUserProfile(profile)}\n\nСообщение пользователя:\n"""\n${String(userText).slice(0, 4000)}\n"""`
  return llmJson(llm, system, user, 700).then((r) => {
    if (r) onUsage?.(r)
    return r?.json ?? null
  })
}

/** Собрать профиль из первоначального описания пользователя (+ заголовок ≤5 слов). */
function buildUserProfile(llm, description) {
  const system = 'Ты собираешь профиль пользователя для ассистента-агента по его описанию. '
    + 'Верни ТОЛЬКО JSON: title (2–5 слов, без кавычек) и массивы коротких императивных пунктов '
    + `(до 180 символов): ${USER_PROFILE_SECTIONS.map((s) => s.key).join(', ')}. `
    + 'Пустые разделы оставляй пустыми массивами, ничего не выдумывай.'
  return llmJson(llm, system, String(description).slice(0, 4000), 800).then((r) => r?.json ?? null)
}

/** Сжать профиль, если он перестал влезать в бюджет system prompt. */
function compactUserProfile(llm, profile) {
  const system = 'Сожми профиль пользователя, сохранив все важные предпочтения и убрав повторы. '
    + `Верни ТОЛЬКО JSON с ключами: title (2–5 слов) и массивы (не больше ${USER_PROFILE_MAX_ITEMS} пунктов в каждом): `
    + `${USER_PROFILE_SECTIONS.map((s) => s.key).join(', ')}.`
  return llmJson(llm, system, renderUserProfile(profile), 900).then((r) => r?.json ?? null)
}

/**
 * Персонализация на каждом ходу: разобрать сообщение пользователя и дописать в
 * профиль то, что в нём нового. Работает фоном (не задерживает ход модели),
 * найденные пункты попадут в system prompt со следующего запроса — перед ним
 * рантайм перезапустится по флагу state.profileDirty. Если профиль перерос
 * бюджет — сжимаем его, чтобы он не съедал контекст.
 */
function learnFromUserMessage(env, text) {
  const { llmCfg, state, dshHome } = env
  const profile = state.userProfile
  if (!profile || !llmCfg?.token) return
  if (state.profileLearning) { trace('personalization: пропуск, предыдущий разбор ещё идёт'); return }
  state.profileLearning = true
  const count = (u) => {
    state.metrics.profileCalls += 1
    state.metrics.profileTokens += u.tokens
    // Плюс к счётчикам хода: строка «personalization: …» печатается рядом с facts.
    if (state.turn) {
      state.turn.profileCalls = (state.turn.profileCalls ?? 0) + 1
      state.turn.profileTokens = (state.turn.profileTokens ?? 0) + u.tokens
    }
  }
  state.profileLearnPromise = analyzePersonalization(llmCfg, profile, text, count)
    .then(async (found) => {
      if (!found) return
      const { sections, added } = mergeProfileSections(profile.sections, found)
      if (!added.length) { trace('personalization: нового нет'); return }
      let next = { slug: profile.slug, title: profile.title, sections }
      let compacted = false
      const byTitle = USER_PROFILE_SECTIONS
        .filter((s) => added.some((a) => a.section === s.key))
        .map((s) => `${s.title.toLowerCase()}: ${added.filter((a) => a.section === s.key).length}`)
      if (userProfileTokens(next) > USER_PROFILE_BUDGET_TOKENS) {
        const squeezed = await compactUserProfile(llmCfg, next).catch(() => null)
        state.metrics.profileCalls += 1
        // Сжатый профиль заменяет прежний (а не добавляется к нему), иначе
        // слияние вернуло бы все старые пункты и компакция была бы пустой.
        const clean = squeezed ? mergeProfileSections({}, squeezed).sections : null
        if (clean && Object.values(clean).some((items) => items.length)) {
          next = {
            slug: profile.slug,
            title: String(squeezed.title ?? profile.title).slice(0, 80),
            sections: clean,
          }
          compacted = true
          trace(`personalization: профиль сжат до ~${userProfileTokens(next)} токенов`)
        }
      }
      if (!writeUserProfile(dshHome, profile.slug, next)) return
      state.userProfile = { ...next, text: renderUserProfile(next) }
      state.profileDirty = true
      log.dim(`  · профиль: +${added.length} пункт(ов) (${byTitle.join(', ')}) → в промпт со следующего хода`)
      // Сжатие меняет уже записанные пункты — об этом стоит сказать вслух.
      if (compacted) log.dim(`  · профиль перерос бюджет ~${USER_PROFILE_BUDGET_TOKENS} токенов и сжат до ~${userProfileTokens(next)}`)
    })
    .catch((e) => trace(`personalization failed: ${e.message}`))
    .finally(() => { state.profileLearning = false })
}

/** Дождаться фонового разбора профиля перед выходом (иначе запись потеряется). */
async function flushProfileLearning(state, ms = 6000) {
  const p = state.profileLearnPromise
  if (!p) return
  await Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))])
}

// ---------- MCP: подключение внешних серверов инструментов (day16) ----------
// Мост живёт в харнессе (`@deepseek-ai/dsh-mcp-client`): он подключается к
// MCP-серверу и регистрирует его инструменты как родные — модель видит их под
// именами `mcp__<serverName>__<tool>`. В базовых бандлах профиля строки MCP нет,
// поэтому dsh-term включает сервер оверлеем `insert` (как делает с ask_user_question).
//
// Цена вопроса: описания и схемы MCP-инструментов уходят в КАЖДЫЙ запрос. У
// официального GitHub-сервера это 45 инструментов ≈31k токенов; в режиме
// «только чтение + четыре тулсета» — 25 ≈16.3k (замерено зондом). Поэтому
// пресет по умолчанию — урезанный, а полный набор включается флагом.
const MCP_PRESETS = {
  github: {
    serverName: 'github',
    title: 'GitHub MCP (официальный remote)',
    url: 'https://api.githubcopilot.com/mcp/',
    // Токен берём из `gh auth token` и передаём в env рантайма: в файле-оверлее
    // секретов нет — там только `!!js`-выражение, читающее переменную окружения.
    tokenEnv: 'GITHUB_MCP_TOKEN',
    tokenFromGh: true,
    readonly: true,
    toolsets: 'context,repos,issues,pull_requests',
  },
  // Свой MCP-сервер вокруг личного трекера задач (проект `sl-tracker-mcp`).
  // Адрес и токен берутся из окружения: развёртывание у каждого своё, а сам сервер
  // работает по стандартному MCP и про dsh ничего не знает.
  // Заголовков тулсетов/readonly у него нет — режим чтения/записи задан на его стороне.
  sltracker: {
    serverName: 'sltracker',
    title: 'SL Tracker MCP (личный трекер задач)',
    url: 'https://mcp.72-56-41-79.sslip.io:8443/mcp',
    urlEnv: 'SL_MCP_URL',
    tokenEnv: 'SL_MCP_TOKEN',
    tokenFromEnv: 'SL_MCP_TOKEN',
    readonly: false,
    toolsets: '',
    what: 'создание задачи, правка описания, комментарий, чтение, смена статуса, справочник очередей',
  },
}
const MCP_DEFAULT_PRESET = 'github'
const MCP_FULL_TOOLSETS = 'all'
const MCP_PATCH_NAME = 'dsh-term-mcp.patch.yml'
// Харнесс регистрирует MCP-инструменты в своей канонической форме (без title,
// annotations, $schema и т.п.), поэтому в промпт уходит примерно вдвое меньше, чем
// весят сырые дескрипторы сервера. Коэффициент — из замеров: readonly+4 тулсета
// дали сырые ≈16.3k → +7.5k к `context:`; полный набор ≈31k → +13.7k.
const MCP_REGISTERED_RATIO = 0.46

/**
 * Разобрать флаги MCP в список серверов.
 * @param {{mcp?: string[], mcpToolsets?: string, mcpReadwrite?: boolean}} opts
 * @returns {{servers: Array<object>, unknown: string[]}}
 */
function resolveMcpServers(opts) {
  const servers = []
  const unknown = []
  for (const raw of opts.mcp ?? []) {
    const name = String(raw).trim().toLowerCase()
    if (!name) continue
    const preset = MCP_PRESETS[name]
    if (!preset) { unknown.push(name); continue }
    // Адрес может подсказываться окружением: у своего MCP-сервера развёртывание
    // у каждого своё, и дефолт в пресете — просто удобная точка входа.
    const urlFromEnv = preset.urlEnv ? String(process.env[preset.urlEnv] ?? '').trim() : ''
    servers.push({
      ...preset,
      url: urlFromEnv || preset.url,
      readonly: opts.mcpReadwrite === true ? false : preset.readonly,
      toolsets: opts.mcpToolsets === undefined
        ? preset.toolsets
        : (opts.mcpToolsets === MCP_FULL_TOOLSETS ? '' : opts.mcpToolsets),
    })
  }
  return { servers, unknown }
}

/** Заголовки запроса к MCP-серверу (для зонда; в оверлее они же, но через !!js). */
function mcpHeaders(server, { withSecret = true } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (withSecret && server.token) headers.Authorization = `Bearer ${server.token}`
  if (server.readonly) headers['X-MCP-Readonly'] = 'true'
  if (server.toolsets) headers['X-MCP-Toolsets'] = server.toolsets
  return headers
}

/**
 * YAML-оверлей с insert-строками MCP-серверов. Секретов в файле нет: токен
 * подставляется выражением `!!js`, которое загрузчик харнесса исполняет при
 * активации строки (переменную окружения даёт spawnRuntime).
 */
function mcpPatchYaml(servers) {
  const lines = [
    '# dsh-term: MCP-серверы через мост @deepseek-ai/dsh-mcp-client (day16).',
    '# Токены не хранятся в файле: значение читается из env рантайма (!!js).',
    '- insert:',
  ]
  for (const s of servers) {
    lines.push(`    - id: mcp-${s.serverName}`)
    lines.push("      name: '@deepseek-ai/dsh-mcp-client'")
    lines.push('      config:')
    lines.push(`        serverName: ${s.serverName}`)
    lines.push('        transport: streamable-http')
    lines.push(`        url: ${s.url}`)
    lines.push('        headers:')
    if (s.tokenEnv) {
      // Бэктики и ${} — часть JS-выражения, поэтому собираем строку конкатенацией.
      lines.push('          Authorization: !!js \'`Bearer ${process.env.' + s.tokenEnv + '}`\'')
    }
    if (s.readonly) lines.push("          'X-MCP-Readonly': 'true'")
    if (s.toolsets) lines.push(`          'X-MCP-Toolsets': '${s.toolsets}'`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Есть ли уже MCP-строка в пользовательском слое профиля: `insert` не
 * идемпотентен, повторная вставка того же id валит дерево плагинов
 * («duplicate loader entry id»), поэтому проверяем перед добавлением.
 */
function profileHasMcpRow(dshHome, profile, serverName) {
  const p = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  const md = readTextIfExists(p)
  return md !== null && (md.includes(`mcp-${serverName}`) || md.includes('dsh-mcp-client'))
}

/**
 * Зонд MCP по Streamable HTTP: `initialize` → `notifications/initialized` →
 * `tools/list`. Это и есть «минимальный клиент», который устанавливает
 * соединение и получает список инструментов; тем же зондом UI показывает
 * инструменты и их цену в промпте.
 *
 * @returns {Promise<{ok: boolean, toolCount: number, tools: Array<object>, tokens: number, ms: number, error?: string}>}
 */
async function mcpProbe(server, { timeoutMs = 20000 } = {}) {
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let sessionId = null
  let seq = 0
  const to = () => `таймаут ${timeoutMs} мс`
  const rpc = async (method, params, { notify = false } = {}) => {
    const body = { jsonrpc: '2.0', method, params }
    if (!notify) body.id = ++seq
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { ...mcpHeaders(server), ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (notify) return null
    // Ответ приходит либо JSON-ом, либо потоком SSE — берём последнюю data-строку.
    let payload = text
    if (text.includes('data:')) {
      const lines = text.split('\n').filter((l) => l.startsWith('data:'))
      payload = lines.length ? lines[lines.length - 1].slice(5).trim() : ''
    }
    if (!payload) return null
    const msg = JSON.parse(payload)
    if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error))
    return msg.result
  }
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-term', version: '0.1' },
    })
    await rpc('notifications/initialized', {}, { notify: true })
    const list = await rpc('tools/list', {})
    const tools = list?.tools ?? []
    return {
      ok: true,
      toolCount: tools.length,
      tools,
      schemaChars: JSON.stringify(tools).length,
      tokens: Math.ceil(JSON.stringify(tools).length / 4),
      serverInfo: init?.serverInfo,
      ms: Date.now() - started,
    }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? to() : (e?.message ?? String(e))
    return { ok: false, toolCount: 0, tools: [], tokens: 0, ms: Date.now() - started, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Добрать токены для пресетов: из `gh auth token` (GitHub) или из окружения
 * (свой MCP-сервер). В файл токены не попадут — уйдут в env рантайма, а оверлей
 * прочитает их выражением `!!js`.
 */
function mcpAttachTokens(servers) {
  for (const s of servers) {
    if (s.token) continue
    if (s.tokenFromEnv) {
      const value = String(process.env[s.tokenFromEnv] ?? '').trim()
      if (value) s.token = value
      else s.tokenError = `не задана переменная ${s.tokenFromEnv} с токеном MCP-клиента`
      continue
    }
    if (!s.tokenFromGh) continue
    const r = runGh(['auth', 'token'])
    if (r.ok && r.out) s.token = r.out
    else s.tokenError = r.err || 'gh auth token недоступен — нужен `gh auth login`'
  }
  return servers
}

/** Короткая подпись режима сервера: readonly/toolsets — то, что реально режет цену. */
function mcpModeLabel(server) {
  const bits = [server.readonly ? 'readonly' : 'read-write']
  bits.push(server.toolsets ? `toolsets=${server.toolsets}` : 'toolsets=all')
  return bits.join(', ')
}

/** Общая сводка по зонду: одна строка на сервер (её печатают старт и /mcp). */
function mcpProbeLine(server, probe) {
  if (!probe) return `${server.serverName}: нет данных зонда`
  if (!probe.ok) return `${server.serverName}: соединение не удалось — ${probe.error}`
  return `${server.serverName} · ${probe.toolCount} tools · сырые схемы ≈ ${fmtTok(probe.tokens)}`
    + ` → в промпте ≈ ${fmtTok(mcpRegisteredTokens(probe))} tokens · ${mcpModeLabel(server)}`
    + `${probe.serverInfo ? ` · ${probe.serverInfo.name}` : ''} · ${probe.ms} мс`
}

/** Оценка того, сколько инструменты сервера добавят к промпту (см. MCP_REGISTERED_RATIO). */
function mcpRegisteredTokens(probe) {
  return Math.round((probe?.tokens ?? 0) * MCP_REGISTERED_RATIO)
}

/**
 * `--mcp-check [preset]` — минимальный клиент из задания: соединение + список
 * инструментов, без сессии и модели. С `--offline` печатает только оверлей
 * (проверка формы YAML и того, что секрет в файл не попал).
 */
async function runMcpCheck(opts) {
  const { servers, unknown } = resolveMcpServers({
    mcp: [opts.mcpCheck],
    mcpToolsets: opts.mcpToolsets,
    mcpReadwrite: opts.mcpReadwrite,
  })
  if (unknown.length) {
    log.err(`неизвестный MCP-пресет: ${unknown.join(', ')}`)
    log.dim(`доступно: ${Object.keys(MCP_PRESETS).join(' | ')}`)
    return 1
  }
  if (!servers.length) {
    log.err('нечего проверять: не задан MCP-пресет')
    return 1
  }
  mcpAttachTokens(servers)
  for (const s of servers) {
    if (s.tokenError) log.err(`${s.serverName}: ${s.tokenError}`)
  }
  log.line(`${C.bold}mcp-check${C.off} ${servers.map((s) => s.serverName).join(', ')}`)
  log.dim(`  режим: ${servers.map(mcpModeLabel).join(' | ')}`)
  log.dim(`  оверлей (уходит в рантайм через --patch, секретов в файле нет):`)
  for (const l of mcpPatchYaml(servers).trimEnd().split('\n')) log.dim(`    ${l}`)
  if (opts.offline) {
    log.dim('  --offline: сеть не трогаем, соединение не проверялось')
    return 0
  }
  let ok = 0
  for (const s of servers) {
    log.line('')
    log.dim(`  подключаюсь к ${s.url} …`)
    const probe = await mcpProbe(s)
    if (!probe.ok) {
      log.err(`  соединение не установлено: ${probe.error}`)
      continue
    }
    ok += 1
    log.ok(`  соединение установлено (${probe.serverInfo?.name ?? '—'} · protocol OK · ${probe.ms} мс), инструментов: ${probe.toolCount}`)
    log.dim(`  сырые описания и схемы: ${probe.schemaChars} символов ≈ ${fmtTok(probe.tokens)} токенов`)
    log.dim(`  ожидаемая добавка к промпту: ≈ ${fmtTok(mcpRegisteredTokens(probe))} токенов на каждый запрос`)
    log.dim('  (харнесс регистрирует инструменты компактнее сырых схем; точную цифру даёт context: в сессии)')
    log.line('')
    for (const t of probe.tools) {
      const req = t.inputSchema?.required ?? []
      const props = Object.keys(t.inputSchema?.properties ?? {})
      const args = props.map((p) => (req.includes(p) ? `${p}*` : p)).join(', ')
      log.line(`  ${t.name}(${args})`)
      const desc = String(t.description ?? '').replace(/\s+/g, ' ')
      if (desc) log.dim(`      ${desc.slice(0, 150)}`)
    }
    if (probe.tools.length) {
      log.line('')
      log.dim(`  в сессии эти инструменты видны модели как mcp__${s.serverName}__<tool>`)
    }
  }
  return ok > 0 ? 0 : 1
}

// ---------- скилл create-project: харнесс продукта ----------
// Детерминированная часть скилла: найти/создать .project-harness, просканировать
// отчёты и определить, где остановилась работа (восстановление по репортам).
const NODE_STAGES = ['specification', 'planning', 'realization', 'verification', 'acceptance']
const STAGE_RU = {
  specification: 'спецификация',
  planning: 'планирование',
  realization: 'реализация',
  verification: 'верификация',
  acceptance: 'приёмка',
}
const STAGE_REPORT = {
  specification: 'specification-report.md',
  planning: 'planning-report.md',
  realization: 'realization-report.md',
  verification: 'verification-report.md',
  acceptance: 'acceptance-report.md',
}

function readTextIfExists(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

/** Версия правил харнесса из .dsh/.harness/README.md (для change propagation). */
function readHarnessVersion(harnessRoot) {
  const md = readTextIfExists(join(harnessRoot, 'README.md'))
  const m = md === null ? null : /Текущая версия правил:\s*\*\*([\d.]+)\*\*/.exec(md)
  return m ? m[1] : null
}

/** Разобрать шапку отчёта: Этап / Статус / Следующая роль / версии / Дата. */
function parseReportHeader(text) {
  const get = (re) => {
    const m = re.exec(text)
    return m ? m[1].trim() : null
  }
  return {
    stage: get(/^\s*Этап:\s*(.+)$/m),
    status: get(/^\s*Статус:\s*(.+)$/m),
    next: get(/^\s*Следующая роль:\s*(.+)$/m),
    contract: get(/^\s*contract_version:\s*(.+)$/m),
    harness: get(/^\s*harness_version:\s*(.+)$/m),
    date: get(/^\s*Дата:\s*(.+)$/m),
  }
}

/**
 * Скан харнесса продукта: узлы, их отчёты и точка возобновления.
 * Состояние берётся ТОЛЬКО из шапок отчётов — это и есть восстановление по репортам.
 * @param {string} harnessDir - путь к <project>/.project-harness.
 * @returns {{exists: boolean, mode: 'new'|'resume', nodes: Array, focus: object|null, lines: string[], warnings: string[]}}
 */
function scanProjectHarness(harnessDir) {
  const exists = existsSync(harnessDir)
  const nodes = new Map()
  const warnings = []
  const ensure = (rel) => {
    if (!nodes.has(rel)) nodes.set(rel, { rel, reports: {}, files: [] })
    return nodes.get(rel)
  }
  const walk = (dir, rel) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const inReports = basename(dir) === 'node-reports'
    const node = ensure(rel)
    for (const e of entries) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        // node-reports — служебная папка узла: её отчёты принадлежат самому узлу,
        // а не отдельной сущности (иначе узел «теряет» свои отчёты).
        walk(abs, inReports || e.name === 'node-reports' ? rel : (rel === '.' ? e.name : `${rel}/${e.name}`))
        continue
      }
      if (!e.name.endsWith('.md')) continue
      if (!inReports) node.files.push(e.name)
      if (!inReports) continue
      const stage = NODE_STAGES.find((s) => STAGE_REPORT[s] === e.name)
      if (stage === undefined) continue
      let mtime = 0
      try { mtime = statSync(abs).mtimeMs } catch {}
      node.reports[stage] = { ...parseReportHeader(readTextIfExists(abs) ?? ''), file: e.name, mtime }
    }
  }
  if (exists) walk(harnessDir, '.')

  const list = [...nodes.values()].map((n) => {
    const present = NODE_STAGES.filter((s) => n.reports[s] !== undefined)
    const last = present.length ? present[present.length - 1] : null
    const rep = last === null ? null : n.reports[last]
    const done = n.reports.acceptance !== undefined && /заверш|принят/i.test(n.reports.acceptance.status ?? '')
    const depth = n.rel === '.' ? 0 : n.rel.split('/').length
    return {
      rel: n.rel,
      depth,
      files: n.files,
      reports: n.reports,
      present,
      last,
      status: rep?.status ?? null,
      next: rep?.next ?? null,
      contract: rep?.contract ?? null,
      harness: rep?.harness ?? null,
      date: rep?.date ?? null,
      done,
    }
  }).sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))

  // Противоречия: неполная цепочка отчётов, провал/блокер, расхождение версий.
  for (const n of list) {
    const where = n.rel === '.' ? 'корень' : n.rel
    if (n.reports.realization !== undefined && n.reports.planning === undefined) warnings.push(`${where}: есть realization-report без planning-report`)
    if (n.reports.verification !== undefined && n.reports.realization === undefined) warnings.push(`${where}: есть verification-report без realization-report`)
    if (n.reports.acceptance !== undefined && n.reports.verification === undefined) warnings.push(`${where}: есть acceptance-report без verification-report`)
    const bad = n.present.filter((s) => /провал|блокер/i.test(n.reports[s].status ?? ''))
    if (bad.length) warnings.push(`${where}: ${bad.map((s) => `${STAGE_RU[s]} — ${n.reports[s].status}`).join('; ')}`)
    const versions = new Set(n.present.map((s) => n.reports[s].contract).filter(Boolean))
    if (versions.size > 1) warnings.push(`${where}: расхождение contract_version (${[...versions].join(', ')}) — возможна незавершённая смена контракта`)
  }

  const withReports = list.filter((n) => n.present.length > 0)
  const unfinished = withReports.filter((n) => !n.done)
  // Точка возобновления — самый глубокий незавершённый узел (если он есть).
  const focus = unfinished.length
    ? unfinished.slice().sort((a, b) => b.depth - a.depth || NODE_STAGES.indexOf(b.last) - NODE_STAGES.indexOf(a.last))[0]
    : (withReports.length ? null : null)

  const lines = []
  if (!exists) {
    lines.push('харнесс продукта ещё не создан')
  } else if (withReports.length === 0) {
    lines.push('отчётов нет — работа по правилам харнесса ещё не начиналась')
    if (list.some((n) => n.files.length)) lines.push(`файлы: ${[...new Set(list.flatMap((n) => n.files))].join(', ')}`)
  } else {
    for (const n of list) {
      if (n.present.length === 0 && n.files.length === 0) continue
      const label = n.rel === '.' ? 'корень' : n.rel
      if (n.present.length === 0) {
        lines.push(`${label}: файлы есть, отчётов нет (${n.files.join(', ')})`)
        continue
      }
      const tail = [n.contract ? `contract ${n.contract}` : null, n.harness ? `harness ${n.harness}` : null, n.date].filter(Boolean).join(' · ')
      lines.push(`${label}: ${n.done ? 'завершён' : STAGE_RU[n.last]} · ${n.status ?? '—'}${n.next ? ` → ${n.next}` : ''}${tail ? ` · ${tail}` : ''}`)
    }
  }
  if (focus !== null && focus !== undefined) {
    lines.push(`возобновление: ${focus.rel === '.' ? 'корень' : focus.rel} · этап ${STAGE_RU[focus.last]} · следующий шаг — ${focus.next ?? 'уточнить по отчёту'}`)
  }
  for (const w of warnings) lines.push(`⚠ ${w}`)

  return {
    exists,
    mode: withReports.length === 0 ? 'new' : 'resume',
    nodes: list,
    focus: focus ?? null,
    lines,
    warnings,
  }
}

/**
 * /create-project — сессия архитектора проекта по SKILLS: опросник (что делаем →
 * где делаем → требования) → .project-harness → гейт инструментов → тело проекта
 * → ноды.
 *
 * CLI НИЧЕГО не трактует буквально: любой текст после команды — это слова
 * пользователя, они уходят архитектору как его первое сообщение; путь, стек и
 * названия определяет и подтверждает сам архитектор в диалоге (инструментами).
 * Детерминированная часть здесь — только проверка процедурного харнесса и
 * диагностический скан отчётов по явному флагу `--check <path>`.
 */
async function createProject(opts, parts, askLineFn, promptTurnFn, state) {
  const args = parts.slice(1)
  const checkOnly = args.includes('--check')
  const brief = args.filter((p) => !p.startsWith('--')).join(' ').trim()

  const harnessRoot = join(opts.workspace, '.dsh', '.harness')
  if (!existsSync(join(harnessRoot, 'README.md'))) {
    log.err(`не найден процедурный харнесс: ${harnessRoot}`)
    log.dim('create-project работает внутри репозитория, где есть .dsh/.harness/')
    return
  }
  const harnessVersion = readHarnessVersion(harnessRoot)

  if (checkOnly) {
    // Диагностика, не часть опросника: путь здесь задаётся явно и осознанно.
    if (!brief) {
      log.err('для --check укажи путь явно: /create-project --check <path>')
      return
    }
    const ctxDir = join(resolve(opts.workspace, brief), '.project-harness')
    const scan = scanProjectHarness(ctxDir)
    log.line(`${C.bold}/create-project --check${C.off}: ${C.cyan}${ctxDir}${C.off}`)
    log.dim(`  харнесс процесса: ${harnessRoot}${harnessVersion ? ` · версия правил ${harnessVersion}` : ''}`)
    log.dim(`  режим: ${scan.mode === 'new' ? 'NEW' : 'RESUME'}`)
    for (const l of scan.lines) log.dim(`  ${l}`)
    return
  }

  const skill = readTextIfExists(join(opts.workspace, '.dsh', 'SKILLS', 'create-project.md'))
  const role = readTextIfExists(join(harnessRoot, 'agents', 'project-architect.md'))
  if (skill === null || role === null) {
    log.err('не читаются .dsh/SKILLS/create-project.md или .dsh/.harness/agents/project-architect.md')
    return
  }
  const strategyNote = state?.context && state.context.strategy !== 'harness'
    ? `\nВНИМАНИЕ: активна стратегия контекста «${state.context.strategy}» — промпт архитектора уйдёт с собранным по ней контекстом. Для чистой сессии архитектора лучше /strategy harness.`
    : ''
  if (strategyNote) log.dim(`  note: активна стратегия контекста «${state.context.strategy}» — для чистой сессии архитектора переключись на /strategy harness`)
  log.line(`${C.bold}/create-project${C.off}: сессия архитектора проекта (${C.cyan}${opts.workspace}${C.off})`)
  log.dim('  путь, стек и названия выясняет архитектор в диалоге — CLI их не угадывает')
  const prompt = [
    '=== СКИЛЛ: create-project ===',
    '(команда выполнила только детерминированную часть: проверила наличие .dsh/.harness',
    'и прочитала версию правил. Путь проекта, стек и названия параметрами НЕ переданы —',
    'их выясняешь сам в диалоге.)',
    '',
    skill,
    '',
    '=== РОЛЬ: архитектор проекта ===',
    role,
    '',
    '=== КОНТЕКСТ СЕССИИ ===',
    `Рабочая папка (репозиторий): ${opts.workspace}`,
    `Процедурный харнесс: ${harnessRoot}${harnessVersion ? ` (версия правил ${harnessVersion})` : ''}`,
    strategyNote,
    brief
      ? `Первое сообщение пользователя — сырой текст, интерпретируй сам:\n"""\n${brief}\n"""`
      : 'Пользователь заранее ничего не сказал — начни опросник с нуля.',
    '',
    'Работай как опросник (шаг 0 скилла): коротко представься и веди диалог блоками —',
    'что делаем, где делаем, что важно и какие требования; дай пользователю рассказать',
    'самому (чем подробнее, тем лучше). Ничего не воспринимай буквально: любые слова —',
    'это речь пользователя, а не команды и не параметры. Путь определи вместе с ним и',
    'проверь инструментами до создания: если по пути уже есть .project-harness — предложи',
    'продолжить по отчётам; если папка не пуста — предупреди и спроси.',
    '',
    'Правила харнесса прочитай сам по путям: .dsh/.harness/product-rules/project.md, node.md, state-machine.md, glossary.md.',
  ].join('\n')
  trace(`create-project prompt: ${prompt.length} chars, brief=${brief ? brief.slice(0, 60) : '(нет)'}`)
  await promptTurnFn(prompt)
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
    log.line('  --compress <mode>   компрессия истории: on (default) | off | <ratio 0..1> (env DSH_TERM_COMPRESS)')
    log.line('  --compress-keep <n> сколько последних токенов держать как есть (default 50000, ≈5% окна)')
    log.line('  --strategy <id>     стратегия контекста: harness (default) | sliding | facts | branch')
    log.line('  --window <n>        N сообщений для стратегии sliding/facts/branch (default 6)')
    log.line('  --auto-approve      не спрашивать подтверждения доступа (env DSH_TERM_AUTO_APPROVE=1)')
    log.line('  --with-profiles     выбрать профиль пользователя в начале сессии (меню)')
    log.line('  --user-profile <id> включить конкретный профиль пользователя (env DSH_TERM_USER_PROFILE)')
    log.line('  --mcp <preset>      подключить MCP-сервер (сейчас: github) — инструменты появятся как mcp__<сервер>__<тул>')
    log.line('  --mcp-toolsets <l>  тулсеты MCP-сервера: список через запятую или all (полный набор дороже по токенам)')
    log.line('  --mcp-readwrite     снять режим «только чтение» у MCP-пресета (по умолчанию readonly)')
    log.line('  --mcp-check [preset] диагностика: подключиться к MCP и напечатать список инструментов, без сессии')
    log.line('                      (--mcp-check --offline — только собрать оверлей, без сети)')
    log.line('  --session <id>      продолжить конкретную сессию (синоним: --resume <id>)')
    log.line('  --workspace <path>  рабочая папка сессий (default: текущая)')
    log.line('  --dsh-bin <path>    путь к dsh (default: dsh из PATH)')
    log.line('')
    log.line('Команды REPL:')
    log.line('  /    список доступных команд')
    log.line('  /help [команда]  справка')
    log.line('  /session  показать текущую сессию (заголовок и id)')
    log.line('  /context  контекст: стратегия, настройки компрессии, метрики, последний summary')
    log.line('  /strategy [id]  стратегия контекста: выбор из меню или sliding|facts|branch|harness')
    log.line('  /branch [id|new]  ветки диалога (включает режим branch): чекпоинт, ветка, переключение')
    log.line('  /resume [id]  продолжить сессию: по id или выбором из списка')
    log.line('  /new     начать новую сессию')
    log.line('  /token   сменить сохранённый API ключ')
    log.line('  /publish-day  git+gh: коммит → push → PR day→week (по .dsh/SKILLS)')
    log.line('  /create-project [что строим]  сессия архитектора проекта: опросник → .project-harness')
    log.line('                → гейт инструментов → ноды (по .dsh/SKILLS/create-project.md)')
    log.line('                --check <path> — только диагностика: состояние отчётов по пути')
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

  // ---- --mcp-check: минимальный MCP-клиент из задания -------------------------
  // Устанавливает соединение с сервером, вызывает `tools/list` и печатает
  // инструменты (плюс оценку их цены в промпте). Сессия и модель не нужны.
  if (opts.mcpCheck !== undefined) {
    // Код возврата становится кодом выхода: --mcp-check пригоден для скриптов и тестов.
    const code = await runMcpCheck(opts)
    process.exitCode = code
    return
  }

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

  // ---- управление контекстом: настройка компрессии истории ----
  // Политика задаётся в токенах — объективная метрика (число сообщений субъективно:
  // в агентной сессии «сообщение» — это шаг с инструментами, их размеры различаются
  // на порядки). Режимы: 'on' (по умолчанию), 'off' (baseline) или число — доля окна.
  const compressRaw = String(opts.compress ?? process.env.DSH_TERM_COMPRESS ?? 'on').trim().toLowerCase()
  const compressOff = ['off', '0', 'false', 'no'].includes(compressRaw)
  const ratioNum = Number(compressRaw)
  const ratio = !compressOff && Number.isFinite(ratioNum) && ratioNum > 0 && ratioNum < 1
    ? ratioNum
    : COMPRESS_DEFAULT_RATIO
  const compress = {
    mode: compressOff ? 'off' : 'on',
    ratio,
    keep: Number.isFinite(opts.compressKeep) && opts.compressKeep > 0 ? Math.floor(opts.compressKeep) : COMPRESS_DEFAULT_KEEP,
    thresholdTokens: Math.round(ratio * CTX_MAX),
  }
  // Патч компрессии пишем ПОСЛЕ выбора стратегии: в режиме стратегии
  // автокомпакция харнесса выключается, чтобы контекстом управлял только клиент.
  const saved = loadState(opts.dshHome)
  const isOneShot = opts.prompt !== undefined
  const sessionId = opts.session ?? (isOneShot ? randomUUID() : saved?.lastSessionId ?? randomUUID())

  // ---- стратегии управления контекстом (day10) ----
  // Режим хранится В СЕССИИ: явный флаг перекрывает сохранённый, иначе берём
  // сохранённый (так /strategy переключает режим на ходу и он держится для сессии).
  const strategyIds = [STRATEGY_HARNESS, ...STRATEGIES.map((s) => s.id)]
  const strategyFlag = opts.strategy === undefined ? null : String(opts.strategy).trim().toLowerCase()
  if (strategyFlag !== null && !strategyIds.includes(strategyFlag)) {
    log.err(`неизвестная стратегия контекста: ${strategyFlag}`)
    log.err(`доступно: ${strategyIds.join(' | ')}`)
    process.exit(1)
  }
  const envWindow = Number(process.env.DSH_TERM_WINDOW)
  const windowN = Number.isFinite(opts.window) && opts.window > 0
    ? Math.floor(opts.window)
    : Number.isFinite(envWindow) && envWindow > 0 ? Math.floor(envWindow) : CTX_DEFAULT_WINDOW
  const ctxStored = loadContext(opts.dshHome, sessionId)
  const strategy = strategyFlag ?? ctxStored?.strategy ?? STRATEGY_HARNESS
  const ctx = ctxStored ?? (strategy === STRATEGY_HARNESS ? null : newContext(sessionId, strategy, windowN))
  if (ctx) {
    ctx.strategy = strategy
    if (opts.window !== undefined || process.env.DSH_TERM_WINDOW !== undefined) ctx.window = windowN
    ctx.messages ??= []
    ctx.facts ??= {}
    ctx.branches ??= {}
    ctx.activeBranch ??= 'main'
    saveContext(opts.dshHome, ctx)
  }
  const strategyMode = strategy !== STRATEGY_HARNESS
  strategyHint = strategy
  if (strategyMode) compress.mode = 'off' // контекстом управляет стратегия, а не харнесс

  try {
    const patchPath = join(opts.dshHome, 'dsh-term-compress.patch.yml')
    mkdirSync(opts.dshHome, { recursive: true })
    writeFileSync(patchPath, compressPatchYaml(compress), 'utf8')
    opts.patches = [...(opts.patches ?? []), patchPath]
  } catch (e) {
    log.err(`compress patch failed: ${e.message}`)
  }

  // Оверлей с инструментом вопросов: без него модель не может спросить
  // пользователя с вариантами (сервис есть в base-бандле, инструмент — нет).
  // Если строка уже есть в патче профиля — не дублируем (insert не идемпотентен).
  if (process.env.DSH_TERM_NO_ASK_TOOL !== '1' && !profileHasAskToolRow(opts.dshHome, opts.profile)) {
    try {
      const toolsPatchPath = join(opts.dshHome, 'dsh-term-tools.patch.yml')
      mkdirSync(opts.dshHome, { recursive: true })
      writeFileSync(toolsPatchPath, toolsPatchYaml(), 'utf8')
      opts.patches = [...(opts.patches ?? []), toolsPatchPath]
    } catch (e) {
      log.err(`tools patch failed: ${e.message}`)
    }
  }

  const state = {
    sessionId,
    harnessSessionId: sessionId, // id сессии для ТЕКУЩЕГО хода (в режиме стратегии — свежий)
    turnSeq: 0,                  // номер хода в этом процессе (для id сессий ходов)
    context: ctx,                // хранилище диалога: транскрипт/facts/ветки (day10)
    ctxAnswer: '',               // накопленный «сырой» текст ответа текущего хода
    children: new Set(),       // subagent-сессии текущего дерева
    turn: null,                // { resolve, running, timer, maxChars, marker, … }
    streamedText: false,       // печатали ли текст за текущий ход
    streamAttempts: new Map(), // attemptId → { turn, step } для живого стрима (session.assistant-stream)
    liveStream: false,         // сервер присылал session.assistant-stream в этом процессе
    autoApprove: opts.autoApprove === true || process.env.DSH_TERM_AUTO_APPROVE === '1', // запросы доступа без вопросов
    compressHint: false,       // подсказка об убыточной компакции уже показана
    lastEndKind: null,         // чем закончился последний ход ('completed'/'error'/…)
    metrics: emptyMetrics(), // расход сессии: prompts/outputs/cacheReads/calls
    compress,                  // настройки компрессии истории (см. --compress)
    lastSummary: null,         // последний summary компакции: { text, model, shadowed, tokens }
    titles: { ...(saved?.titles ?? {}) }, // sessionId → короткий заголовок сессии
    titleLocked: new Set(saved?.titleLocked ?? []), // заголовки, которые харнесс не перебивает
    isNew: false,              // сессия создана в этом запуске (для авто-заголовка)
    userProfile: null,         // профиль пользователя (day12) — ставится ниже, до спавна
    profileDirty: false,       // профиль обновился — нужен перезапуск рантайма перед ходом
    profileNotice: null,       // объявление смены профиля — уходит префиксом к след. промпту
    profileLearning: false,    // фоновый разбор текущего сообщения на персонализацию
    mcp: null,                 // MCP-серверы (day16): серверы, зонды, цена в промпте
  }
  // В one-shot state не сохраняем: прогоны не должны затирать «последнюю сессию»
  // для интерактивного режима (у каждого -p запуска и так своя свежая сессия).
  state.isNew = !isOneShot && !(opts.session || (saved?.lastSessionId === sessionId))
  if (!isOneShot) saveState(opts.dshHome, sessionId, state.titles, state.titleLocked)

  // ---- профиль пользователя (day12): персонализация через system prompt ----
  // Профиль уходит оверлеем `- id: system-prompt` (personaPrefix), поэтому он
  // должен быть известен ДО спавна рантайма. `--with-profiles` показывает меню,
  // `--user-profile <slug>` берёт профиль сразу (для скриптов и прогонов).
  const llmCfg = { token, model: opts.model, provider: opts.provider }

  /** Меню профилей: выбрать существующий или создать новый по описанию. */
  async function pickOrCreateUserProfile() {
    const list = listUserProfiles(opts.dshHome)
    if (!list.length) {
      log.dim('профилей пользователя ещё нет — создаём первый')
      return await createUserProfileInteractive()
    }
    const items = list.map((p) => ({ id: p.slug, label: `${p.slug} — ${p.title}`, note: `~${p.tokens} токенов` }))
    items.push({ id: '__new__', label: '+ создать новый профиль', note: 'по вашему описанию' })
    const chosen = await pickListTTY({ prompt: 'профиль> ', items })
    if (!chosen) {
      log.line('профиль не выбран — сессия без персонализации')
      return null
    }
    if (chosen === '__new__') return await createUserProfileInteractive()
    return readUserProfile(opts.dshHome, chosen)
  }

  /** Создание профиля: описание от пользователя → LLM (заголовок ≤5 слов) → файл. */
  async function createUserProfileInteractive() {
    log.line('Опишите профиль: как с вами лучше работать (стиль, формат ответов, ограничения, интересы, чего избегать).')
    const description = String(await askLine('описание профиля> ') ?? '').trim()
    if (!description) log.dim('пустое описание — соберу нейтральный профиль')
    const built = await buildUserProfile(llmCfg, description || 'Нейтральный профиль без особых предпочтений.')
    const title = String(built?.title ?? 'Профиль по умолчанию')
      .replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 48) || 'Профиль по умолчанию'
    const sections = {}
    for (const s of USER_PROFILE_SECTIONS) sections[s.key] = Array.isArray(built?.[s.key]) ? built[s.key] : []
    const slug = userProfileSlug(title)
    writeUserProfile(opts.dshHome, slug, { title, sections })
    log.dim(`· профиль создан: «${title}» (${slug}) → ${userProfilePath(opts.dshHome, slug)}`)
    return readUserProfile(opts.dshHome, slug)
  }

  const personaPatchPath = join(opts.dshHome, 'dsh-term-persona.patch.yml')
  const profileSlug = opts.userProfile ?? process.env.DSH_TERM_USER_PROFILE ?? null
  let userProfile = null
  if (profileSlug) {
    userProfile = readUserProfile(opts.dshHome, profileSlug)
    if (userProfile === null) {
      log.err(`профиль пользователя «${profileSlug}» не найден в ${userProfilesDir(opts.dshHome)}`)
      const known = listUserProfiles(opts.dshHome)
      if (known.length) log.dim(`доступно: ${known.map((p) => p.slug).join(', ')}`)
      process.exit(1)
    }
  } else if (opts.withProfiles && !UI.oneShot) {
    userProfile = await pickOrCreateUserProfile()
  }

  /**
   * Подключить профиль к рантайму (или отключить при profile = null): профиль
   * едет в system prompt оверлеем `- id: system-prompt` + personaPrefix, а
   * system prompt фиксируется при спавне — поэтому смена профиля помечается
   * флагом profileDirty, и перед следующим ходом рантайм перезапускается.
   */
  function applyUserProfile(profile, { dirty = true } = {}) {
    state.userProfile = profile
    let patches = (opts.patches ?? []).filter((p) => p !== personaPatchPath)
    if (profile !== null) {
      try {
        mkdirSync(opts.dshHome, { recursive: true })
        writeFileSync(personaPatchPath, userProfileOverlayYaml(profile), 'utf8')
        patches = [...patches, personaPatchPath]
      } catch (e) {
        log.err(`persona patch failed: ${e.message}`)
      }
    }
    opts.patches = patches
    if (!dirty) return
    state.profileDirty = true
    state.profileNotice = profileNoticeText(profile)
  }
  applyUserProfile(userProfile, { dirty: false })
  // Продолжаем существующую сессию: в её истории могли остаться прежние
  // договорённости о стиле — объявляем профиль в первом же сообщении, иначе
  // модель может держаться за историю (проверено на живом случае).
  if (userProfile !== null && !state.isNew) state.profileNotice = profileNoticeText(userProfile)

  // ---- MCP (day16): внешние серверы инструментов -----------------------------
  // Мост `@deepseek-ai/dsh-mcp-client` включается оверлеем `insert` (в бандлах
  // строки нет), поэтому сервер, как и профиль, известен ДО спавна рантайма.
  // Секрет (токен GitHub) едет через env рантайма: в файле-оверлее только `!!js`.
  const mcpEnv = {}
  const { servers: mcpServers, unknown: mcpUnknown } = resolveMcpServers(opts)
  if (mcpUnknown.length) {
    log.err(`неизвестный MCP-пресет: ${mcpUnknown.join(', ')}`)
    log.dim(`доступно: ${Object.keys(MCP_PRESETS).join(' | ')}`)
    process.exit(1)
  }
  const mcpPatchPath = join(opts.dshHome, MCP_PATCH_NAME)
  if (mcpServers.length) {
    mcpAttachTokens(mcpServers)
    for (const s of mcpServers) {
      if (s.tokenError) log.err(`mcp ${s.serverName}: ${s.tokenError}`)
      if (s.tokenEnv && s.token) mcpEnv[s.tokenEnv] = s.token
    }
    // Сервер без токена не подключаем вовсе: иначе в промпт уехал бы битый MCP-клиент,
    // который на каждый вызов отвечает 401, а причина потерялась бы в логах.
    const usable = mcpServers.filter((s) => !s.tokenError)
    if (usable.length !== mcpServers.length) {
      log.dim('mcp: серверы без токена пропущены — сессия продолжается без них')
      mcpServers.length = 0
      mcpServers.push(...usable)
    }
    if (mcpServers.length) {
      try {
        mkdirSync(opts.dshHome, { recursive: true })
        writeFileSync(mcpPatchPath, mcpPatchYaml(mcpServers), 'utf8')
        if (profileHasMcpRow(opts.dshHome, opts.profile, mcpServers[0].serverName)) {
          log.dim('mcp: строка уже есть в пользовательском слое профиля — оверлей не подключаю (insert не идемпотентен)')
        } else {
          opts.patches = [...(opts.patches ?? []), mcpPatchPath]
        }
      } catch (e) {
        log.err(`mcp patch failed: ${e.message}`)
      }
    }
  }
  opts.mcpEnv = mcpEnv
  state.mcp = mcpServers.length
    ? { servers: mcpServers, probes: new Map(), tokens: 0, patchPath: mcpPatchPath }
    : null

  let rpc = spawnRuntime(opts, token)
  rpcRef = rpc

  // ---- нотификации ----
  function handleNotification(msg) {
    trace(`notif ${msg.method}`)
    if (msg.method === 'session.status') {
      const { sessionId, status } = msg.params
      const mine = sessionId === state.harnessSessionId || state.children.has(sessionId)
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
    // Живой стрим модели. В формате сессий v3 чанков в логе больше нет
    // (события assistant/chunk исчезли), поэтому харнесс шлёт их отдельной
    // нотификацией — её форвардит пропатченный SDK-сервер. Без патча
    // нотификации нет: текст тогда печатает фолбэк по assistant/message.
    if (msg.method === 'session.assistant-stream') {
      // Диагностика: DSH_TERM_NO_STREAM=1 глушит живой стрим — так проверяется
      // фолбэк по assistant/message (он же путь для харнесса без патча SDK-сервера).
      if (process.env.DSH_TERM_NO_STREAM) return
      const { sessionId, frame } = msg.params
      const mine = sessionId === state.harnessSessionId || state.children.has(sessionId)
      if (!mine || !frame) return
      state.liveStream = true // сервер отдаёт живой стрим — фолбэк не нужен
      const key = `${sessionId}:${frame.attemptId ?? ''}`
      if (frame.type === 'start') {
        state.streamAttempts.set(key, { turn: frame.turn, step: frame.step })
        return
      }
      if (frame.type === 'end') {
        state.streamAttempts.delete(key)
        return
      }
      if (frame.type !== 'chunk' || !frame.chunk || !state.turn) return
      const at = state.streamAttempts.get(key)
      renderEvent({ type: 'assistant/chunk', data: { turn: at?.turn, step: at?.step, chunk: frame.chunk } })
      return
    }
    if (msg.method === 'session.event') {
      const { sessionId, event } = msg.params
      trace(`event ${event?.type}`)
      const mine = sessionId === state.harnessSessionId || state.children.has(sessionId)
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
      // Компрессия контекста: события log-only, приходят и между ходами.
      if (mine && event.type === 'compaction/summary') {
        const d = event.data ?? {}
        const text = (d.summary ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        const tokens = d.usage?.outputTokens ?? Math.ceil(text.length / 4)
        const callTokens = promptTokensOf(d.usage) + (d.usage?.outputTokens ?? 0)
        state.lastSummary = { text, model: d.model ?? '', shadowed: d.shadowedTokenCount ?? 0, tokens, callTokens }
        state.metrics.compactions += 1
        state.metrics.compactTokens += callTokens
        if (state.turn) {
          state.turn.compactions = (state.turn.compactions ?? 0) + 1
          state.turn.compactTokens = (state.turn.compactTokens ?? 0) + callTokens
        }
        withStatusPaused(() => {
          // net — СКОЛЬКО СНЯТО С ОКНА: затенённый участок минус то, что встало на
          // его место (summary + рамка). `call` — СКОЛЬКО СТОИЛ вызов суммаризатора
          // (вход = переигранный префикс + участок, он же идёт в KV-кэш, плюс выход).
          const net = state.lastSummary.shadowed - tokens
          const netText = `net ≈ ${net >= 0 ? '−' : '+'}${fmtTok(Math.abs(net))}`
          // net < 2k — почти весь прирост съедает фиксированная структура summary (~1k).
          const wasteful = net < 2000 ? ', wasteful' : ''
          log.dim(`· context compacted: shadowed ${fmtTok(state.lastSummary.shadowed)} → summary ${fmtTok(tokens)} (${netText}, call ${fmtTok(callTokens)}${wasteful})${d.model ? ` (${d.model})` : ''}`)
          // Раз в сессию: объясняем убыточную компакцию и что с этим делать. Причина
          // почти всегда одна — хвост «как есть» набирается ЦЕЛЫМИ сообщениями, и
          // несколько крупных ответов съедают весь keep, оставляя сжимать крохи.
          if (wasteful && !state.compressHint) {
            state.compressHint = true
            log.dim(`  hint: снято всего ≈${fmtTok(Math.abs(net))} (сам summary весит ≈1k) — хвост «как есть» (keep ${fmtTok(state.compress.keep)})`
              + ' набирается целыми сообщениями, поэтому почти ничего старше него не осталось;'
              + ` снизьте --compress-keep (например ${fmtTok(Math.max(1000, Math.round(state.compress.keep / 3)))}) или поднимите --compress`)
          }
        })
      }
      if (mine && event.type === 'compaction/prune') {
        const shadowed = event.data?.shadowedTokenCount ?? 0
        if (shadowed > 0) withStatusPaused(() => log.dim(`· tool output pruned: ${fmtTok(shadowed)} tokens shadowed`))
      }
      if (mine && event.type === 'compaction/end' && event.data?.error) {
        // Отказ компакции: вызов суммаризатора уже потрачен, а usage харнесс в
        // событии не пишет — считаем хотя бы количество (см. строку compression).
        state.metrics.compactFails += 1
        if (state.turn) state.turn.compactFails = (state.turn.compactFails ?? 0) + 1
        withStatusPaused(() => log.err(`✖ compaction failed: ${event.data.error}`))
      }
      if (!mine || !state.turn) return
      renderEvent(event)
    }
  }

  /**
   * Вопрос от агента (ask_user_question, ревью плана): меню с вариантами или
   * свободный текст. Ответ уходит обратно в рантайм как { answers: [...] }.
   */
  async function answerUserQuestion(params) {
    const answers = []
    for (const q of params.questions ?? []) {
      if (q.header) log.line(`${C.bold}${q.header}${C.off}`)
      log.line(`${C.bold}${q.question}${C.off}`)
      if (q.detail) log.dim(String(q.detail).split('\n').map((l) => '  ' + l).join('\n'))
      if (q.intent?.kind === 'plan-review' && q.intent.approve) {
        log.dim(`  (одобрить — вариант «${q.intent.approve}»)`)
      }
      const opts = q.options ?? []
      if (!opts.length) {
        const text = String(await askLine('ответ> ') ?? '').trim()
        answers.push(text ? { id: q.id, selected: [], custom: text } : { id: q.id, selected: [] })
        continue
      }
      const items = opts.map((o) => ({ id: o.label, label: o.label, note: o.description ?? '' }))
      items.push({ id: '__custom__', label: 'свой вариант…', note: 'ввести текст' })
      if (q.multiSelect) {
        const picked = await pickListTTY({ prompt: 'выбор> ', items, multi: true })
        const chosen = picked ?? []
        const selected = chosen.filter((id) => id !== '__custom__')
        const custom = chosen.includes('__custom__')
          ? (String(await askLine('свой вариант> ') ?? '').trim() || undefined)
          : undefined
        answers.push({ id: q.id, selected, ...(custom === undefined ? {} : { custom }) })
        continue
      }
      const picked = await pickListTTY({ prompt: 'выбор> ', items })
      if (picked === null) { answers.push({ id: q.id, selected: [] }); continue }
      if (picked === '__custom__') {
        const custom = String(await askLine('свой вариант> ') ?? '').trim()
        answers.push({ id: q.id, selected: [], ...(custom ? { custom } : {}) })
        continue
      }
      answers.push({ id: q.id, selected: [picked] })
    }
    return { answers }
  }

  /**
   * Запрос доступа (approval/request от инструментов): разрешить или отклонить.
   * Исходы протокола однократные; «разрешить всё в этой сессии» — клиентская
   * настройка: дальше dsh-term отвечает allowed-once без вопросов.
   */
  async function answerApproval(params) {
    const what = `Запрос доступа: ${params.toolName}${params.callId ? ` · ${params.callId}` : ''}`
    if (state.autoApprove) {
      log.dim(`· ${what} — разрешено автоматически (авто-режим сессии)`)
      return { outcome: 'allowed-once' }
    }
    log.line(`${C.bold}${what}${C.off}`)
    if (params.reason) log.dim(`  причина: ${params.reason}`)
    const picked = await pickListTTY({
      prompt: 'доступ> ',
      items: [
        { id: 'allow', label: 'Разрешить', note: 'однократно' },
        { id: 'allow-session', label: 'Разрешить всё в этой сессии', note: 'без вопросов до конца сессии' },
        { id: 'deny', label: 'Отклонить', note: 'агент получит отказ (fail closed)' },
      ],
    })
    if (picked === 'allow') return { outcome: 'allowed-once' }
    if (picked === 'allow-session') {
      state.autoApprove = true
      log.dim('  авто-разрешение включено для этой сессии')
      return { outcome: 'allowed-once' }
    }
    if (picked === 'deny') return { outcome: 'rejected' }
    log.dim('  запрос отменён (ответ не отправлен как разрешение)')
    return { outcome: 'cancelled' }
  }

  // Рантайм СПРАШИВАЕТ клиента: ответить обязан клиент, иначе рантайм fail-closed
  // (подтверждения → unavailable, вопросы → ошибка инструмента).
  // На время диалога гасим подпись «Deep diving…» и живой счётчик: их тики пишут в
  // текущую строку, то есть ровно поверх меню вопроса (мигание «выбор> ↔ Deep diving»).
  async function handleClientRequest(method, params) {
    trace(`client request ${method}`)
    const wasAnimating = status.timer !== null
    stopStatus()
    UI.asking = true
    try {
      if (method === 'user/question') return await answerUserQuestion(params)
      if (method === 'user/approval') return await answerApproval(params)
      throw new Error(`unknown client request method: ${method}`)
    } finally {
      UI.asking = false
      if (wasAnimating) startStatus() // модель продолжает ход — подпись возвращается
    }
  }

  /** Параметры initialize — одни и те же при старте и при перезапуске рантайма. */
  const initParams = {
    cwd: opts.workspace,
    provider: opts.provider,
    model: opts.model,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  }

  /** Подписать клиента на нотификации и запросы рантайма. */
  function bindRuntime(client) {
    client.onNotification = handleNotification
    client.onRequest = handleClientRequest
  }

  /**
   * Перезапустить рантайм с текущими opts (в т.ч. с обновлённым оверлеем профиля)
   * и заново поздороваться. Сессия та же — харнесс её резюмирует, поэтому меняется
   * только системный промпт (personaPrefix) для следующих запросов.
   * Нужно потому, что system prompt собирается при спавне рантайма, а профиль
   * обновляется уже в ходе сессии (руками или автообучением).
   *
   * Порядок важен: сначала ПОЛНОСТЬЮ гасим прежний рантайм и только потом стартуем
   * новый. Сессию защищает kernel-lease (named semaphore на Windows, flock на POSIX),
   * и живой прежний процесс не даст новому её резюмировать — промпт упал бы с
   * «session … is already owned by an active write handle».
   *
   * @returns {Promise<boolean>} удалось ли поднять новый рантайм.
   */
  async function restartRuntime(reason) {
    log.dim(`  перезапуск рантайма: ${reason}`)
    const previous = rpc
    try { await previous.close() } catch (e) { trace(`previous runtime close: ${e.message}`) }
    const next = spawnRuntime(opts, token)
    rpc = next
    rpcRef = next
    bindRuntime(next)
    try {
      await next.request('initialize', initParams)
      return true
    } catch (e) {
      log.err(`перезапуск рантайма не удался: ${e.message}`)
      log.err('  изменения (профиль) в этой сессии не применены — попробуйте /new или перезапустить dsh-term')
      return false
    }
  }

  bindRuntime(rpc)

  /**
   * `session/prompt` с повтором на конфликт владения сессией: сразу после
   * перезапуска рантайма прежний процесс мог ещё не отпустить kernel-lease, и
   * харнесс отвечает «session … is already owned by an active write handle».
   * Пауза и повтор проходят, если конфликт был именно из-за этого; если сессию
   * держит другой живой процесс (второй dsh-term), ошибка уйдёт наружу.
   */
  async function requestPrompt(sessionId, text) {
    const params = { sessionId, contentBlocks: [{ type: 'text', text }] }
    for (let attempt = 0; ; attempt++) {
      try {
        return await rpc.request('session/prompt', params)
      } catch (e) {
        if (!/already owned by an active write handle/i.test(e.message) || attempt >= 3) throw e
        const wait = 300 * (attempt + 1)
        log.dim(`  сессия ещё числится за прежним рантаймом — повтор через ${wait} мс`)
        await new Promise((r) => setTimeout(r, wait))
      }
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
        if (c.type === 'text-delta') feedTextDelta(c.text, event.data.step)
        // Живой счётчик токенов: перерисовать в хвосте строки после фрагмента.
        if (!state.turn?.cut) meterDrawTail()
        // reasoning-delta намеренно не печатаем: в это время идёт анимация
        // (капшон «Deep diving…»), как в веб-приложении DeepSeek.
        break
      }
      case 'tool/call': {
        stopStatus()
        // Инструменты MCP приходят как `mcp__<сервер>__<тул>`: убираем служебный
        // префикс, чтобы в транскрипте было видно «кто» вызван (⛭ github/issue_read).
        const tname = String(event.data.name)
        if (tname.startsWith('mcp__')) {
          const [, srv, ...rest] = tname.split('__')
          log.tool(`⛭ ${srv}/${rest.join('__')} ${shortArgs(event.data.arguments)}`)
        } else {
          log.tool(`▶ ${tname} ${shortArgs(event.data.arguments)}`)
        }
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
          if (state.metrics.compactions || state.metrics.compactFails) {
            const n = state.metrics.compactions
            const fails = state.metrics.compactFails
            log.dim(`  compression: ${n} summarize call${n === 1 ? '' : 's'}${fails ? `, ${fails} failed` : ''}, ${fmtTok(state.metrics.compactTokens)} tokens${fails ? ' (failed calls not metered)' : ''}`)
          }
          // facts считаем ПО ХОДУ (в сводке), а не накопленным за процесс: иначе
          // строка печаталась бы и после переключения на стратегию без facts.
          if (state.turn?.factsCalls) {
            const fc = state.turn.factsCalls
            log.dim(`  strategy: ${fc} facts update${fc === 1 ? '' : 's'}, ${fmtTok(state.turn.factsTokens)} tokens`)
          }
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
        // Фолбэк вывода: только когда живого стрима в этом процессе не было
        // (харнесс без патча SDK-сервера) — печатаем готовый текст шага целиком.
        if (!state.liveStream && state.turn && state.turn.streamedStep !== event.data.step) {
          const blocks = event.data.message?.content ?? []
          const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
          if (text) feedMessageText(text, event.data.step)
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
          state.metrics.lastPrompt = prompt // размер последнего запроса (заполнение окна)
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
      case 'assistant/attempt': {
        // Попытка без готового сообщения (ошибка/отмена): показать то, что
        // успело прийти, если живого стрима по этому шагу не было.
        if (!state.liveStream && state.turn && state.turn.streamedStep !== event.data.step) {
          const text = textFromAttemptStream(event.data.stream)
          if (text) feedMessageText(text, event.data.step)
        }
        break
      }
    }
  }

  /**
   * Напечатать видимый текст ответа — стрим-чанк или (без живого стрима) весь
   * текст шага целиком. Обрезка по стоп-маркеру и лимиту символов общая.
   * @param {string} text - порция видимого текста модели.
   * @param {number|undefined} step - шаг хода (для фолбэка по assistant/message).
   */
  function feedTextDelta(text, step) {
    // Сырой текст ответа — в память диалога (стратегии day10): до всех клиентских
    // обрезок по стоп-маркеру и лимиту, чтобы в истории остался полный ответ.
    state.ctxAnswer += text
    // Пошёл видимый ответ — анимация останавливается, текст стримится.
    stopStatus()
    state.streamedText = true
    const t = state.turn
    if (!t) return
    if (step != null) t.streamedStep = step
    if (t.cut) return
    // Детект маркера ЧЕРЕЗ ГРАНИЦЫ чанков: задерживаем вывод на
    // (len-1) символов и ищем маркер в склейке «хвост + новый чанк».
    const markLen = t.marker ? t.marker.length : 0
    const combined = (t.tail ?? '') + text
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

  /**
   * Фолбэк вывода без живого стрима: учесть символы в «живом» счётчике,
   * напечатать текст шага и перерисовать хвостовой счётчик.
   * @param {string} text - готовый видимый текст шага.
   * @param {number|undefined} step - шаг хода.
   */
  function feedMessageText(text, step) {
    meter.estChars += text.length
    meter.stepChars += text.length
    feedTextDelta(text, step)
    if (!state.turn?.cut) meterDrawTail()
  }

  /**
   * Видимый текст из durable-потока попытки (assistant/attempt): записи
   * `text-chunks` — это сжатые серии дельт с массивом `texts`.
   * @param {Array<object>|undefined} stream - compact-записи потока модели.
   * @returns {string} склеенный видимый текст.
   */
  function textFromAttemptStream(stream) {
    let out = ''
    for (const rec of stream ?? []) {
      if (rec?.type === 'text-chunks' && Array.isArray(rec.texts)) out += rec.texts.join('')
    }
    return out
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
    state.streamAttempts.clear() // attemptId прошлого хода больше не встретятся
    return new Promise((resolve) => {
      state.turn = {
        resolve,
        running: false,
        maxChars: controls?.maxChars ?? null,
        marker: controls?.marker ?? null,
        streamedCount: 0,
        streamedStep: null, // шаг, видимый текст которого уже напечатан
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
    // Профиль обновился в прошлом ходу — system prompt фиксируется при спавне,
    // поэтому перед новым запросом перезапускаем рантайм (сессия та же).
    if (state.profileDirty) {
      state.profileDirty = false
      // Профиль мог обновиться фоновым разбором уже ПОСЛЕ записи оверлея —
      // перезапуск с прежним файлом подхватил бы старую версию профиля.
      applyUserProfile(state.userProfile, { dirty: false })
      let ok = false
      try {
        ok = await restartRuntime(state.userProfile ? 'профиль пользователя обновлён' : 'профиль пользователя отключён')
      } catch (e) {
        log.err(`перезапуск рантайма не удался: ${e.message}`)
      }
      // Без рабочего рантайма отправлять промпт некуда: честно останавливаемся,
      // иначе модель ответила бы со старым system prompt (без профиля).
      if (!ok) return false
    }
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
    meter.edge = false
    // Markdown-состояние (кодовые блоки) и буфер — тоже с нуля.
    mdBuf.s = ''
    if (mdBuf.timer) { clearTimeout(mdBuf.timer); mdBuf.timer = null }
    mdCtx.inFence = false
    mdCtx.lineStart = true
    try {
      // Мягкие инструкции (формат/длина/стоп-маркер) — префиксом к промпту.
      const instructions = []
      // Смена профиля объявляется один раз — в первом сообщении после переключения.
      if (state.profileNotice) { instructions.push(state.profileNotice); state.profileNotice = null }
      if (controls?.format) instructions.push(formatInstruction(controls.format))
      if (controls?.maxChars != null) instructions.push(`Не длиннее ${controls.maxChars} символов в основном ответе.`)
      // Стоп-маркер передаётся С ПРОМТОМ: модель знает, что закончить ответ им,
      // а клиент обрезает вывод в момент генерации маркера (см. renderEvent).
      if (controls?.marker) {
        instructions.push(`Заверши свой ответ ровно маркером ${JSON.stringify(controls.marker)} — маркер должен быть последним, после него ничего не пиши.`)
      }
      const body = instructions.length ? `${instructions.join('\n')}\n\n---\n\n${text}` : text
      trace(`prompt body: ${body.slice(0, 200)}`)
      // ---- стратегия контекста (day10) ----
      // Клиент сам решает, что уйдёт в модель: [facts] + последние N сообщений +
      // новое сообщение. Ход идёт в СВЕЖУЮ harness-сессию, иначе его поверхность
      // накапливала бы полную историю и в модель попадало бы больше задуманного.
      let sendText = body
      let sendSession = state.sessionId
      state.ctxAnswer = ''
      if (state.context && state.context.strategy !== STRATEGY_HARNESS) {
        const c = state.context
        state.turnSeq += 1
        // 1) сообщение пользователя — в память диалога (потом обновляем facts);
        activeMessages(c).push({ role: 'user', text, at: new Date().toISOString() })
        if (c.strategy === 'facts') {
          const r = await updateFacts({ token, model: opts.model, provider: opts.provider }, c)
          if (r) {
            c.facts = r.facts
            c.factsCalls += 1
            c.factsTokens += r.tokens
            state.metrics.factsCalls += 1
            state.metrics.factsTokens += r.tokens
            if (state.turn) {
              state.turn.factsCalls = (state.turn.factsCalls ?? 0) + 1
              state.turn.factsTokens = (state.turn.factsTokens ?? 0) + r.tokens
            }
            trace(`facts updated (${r.tokens} tokens): ${JSON.stringify(r.facts).slice(0, 200)}`)
          }
        }
        // 2) контекст по стратегии (само сообщение уже добавлено — не дублируем)
        const composed = composeContextText(c, body, { skipLast: 1 })
        sendText = composed.text
        state.lastCompose = { ...composed, strategy: c.strategy, branch: c.activeBranch, messages: activeMessages(c).length }
        saveContext(opts.dshHome, c)
        // 3) свежая сессия харнесса на этот ход
        if (state.turnSeq > 1) {
          sendSession = `ctx-${sessionId.slice(0, 8)}-t${state.turnSeq}-${randomUUID().slice(0, 4)}`
        }
        state.harnessSessionId = sendSession
        trace(`strategy ${c.strategy}: session=${sendSession} window=${composed.windowCount} facts=${composed.factsCount} chars=${sendText.length}`)
        trace(`strategy prompt:\n${sendText}`)
        // В one-shot это уходит в stderr — как и остальная диагностика.
        log.dim(`· контекст [${strategyLabel(c)}]: ${composed.windowCount} сообщений${composed.factsCount ? ` + ${composed.factsCount} facts` : ''}, ${fmtTok(Math.ceil(sendText.length / 4))} токенов ≈`)
      }
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
      const res = await requestPrompt(sendSession, sendText)
      trace(`prompt queued: ${res.messageId}`)
      log.dim(`(queued ${res.messageId})`)
      startStatus() // модель думает — крутится «Deep diving…»
      // Персонализация (day12): каждый prompt анализируем на новое о профиле —
      // не блокируя ход. Найденное дописывается в профиль и попадёт в system
      // prompt со следующего запроса (перед ним рантайм перезапустится).
      // В one-shot (-p) не учимся: прогоны должны быть воспроизводимыми и не
      // менять профиль, к тому же процесс завершается сразу после ответа.
      if (state.userProfile && !UI.oneShot) learnFromUserMessage({ llmCfg, state, dshHome: opts.dshHome }, text)
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
    // Ответ — в память диалога (сырой текст, без клиентских обрезок).
    if (state.context && state.context.strategy !== STRATEGY_HARNESS && state.ctxAnswer) {
      activeMessages(state.context).push({ role: 'assistant', text: state.ctxAnswer, at: new Date().toISOString() })
      saveContext(opts.dshHome, state.context)
      trace(`context: ${activeMessages(state.context).length} сообщений, ветка ${state.context.activeBranch}`)
    }
    trace('promptTurn done (idle)')
    return state.lastEndKind === 'completed'
  }

  // ---- сериализованная обработка строк (REPL-цикл) ----
  let busy = false
  let exiting = false

  /**
   * Переключить активный диалог: подтянуть его стратегию и память (day10).
   * @param {string} newId - id сессии (он же ключ хранилища контекста).
   * @param {{isNew?: boolean}} [o] - новая сессия (для авто-заголовка).
   */
  function switchSession(newId, o = {}) {
    state.sessionId = newId
    state.harnessSessionId = newId
    state.turnSeq = 0
    state.ctxAnswer = ''
    state.lastCompose = null
    state.children.clear()
    state.isNew = o.isNew === true
    state.metrics = emptyMetrics()
    const stored = loadContext(opts.dshHome, newId)
    state.context = stored ?? (strategyMode ? newContext(newId, strategy, windowN) : null)
    if (state.context) {
      state.context.messages ??= []
      state.context.facts ??= {}
      state.context.branches ??= {}
      state.context.activeBranch ??= 'main'
      if (strategyMode) state.context.strategy = strategy
      saveContext(opts.dshHome, state.context)
    }
    strategyHint = state.context?.strategy ?? STRATEGY_HARNESS
    saveState(opts.dshHome, newId, state.titles, state.titleLocked)
  }

  /**
   * Переключить стратегию контекста ТЕКУЩЕЙ сессии (применяется со следующего
   * сообщения: контекст собирается клиентом, перезапуск рантайма не нужен).
   * @param {string} id - harness | sliding | facts | branch.
   */
  function applyStrategy(id) {
    const c = state.context ?? newContext(state.sessionId, id, windowN)
    c.strategy = id
    c.window = c.window || windowN
    c.messages ??= []
    c.facts ??= {}
    c.branches ??= {}
    c.activeBranch ??= 'main'
    state.context = c
    saveContext(opts.dshHome, c)
    strategyHint = id
    if (id === STRATEGY_HARNESS) {
      log.dim(`· стратегия контекста: ${STRATEGY_HARNESS} — контекстом снова управляет харнесс (компрессия day9)`)
    } else {
      const info = STRATEGIES.find((s) => s.id === id)
      log.dim(`· стратегия контекста: ${id} — ${info?.title ?? ''}, окно ${c.window}`)
      log.dim('  применится со следующего сообщения; в этом режиме автокомпакция харнесса выключена')
    }
  }

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
      case 'strategy': {
        const ids = [STRATEGY_HARNESS, ...STRATEGIES.map((s) => s.id)]
        let chosen = (parts[1] ?? '').toLowerCase() || null
        if (chosen && !ids.includes(chosen)) {
          log.err(`неизвестная стратегия: ${chosen}`)
          log.dim(`доступно: ${ids.join(' | ')}`)
          break
        }
        if (!chosen) {
          const cur = state.context?.strategy ?? STRATEGY_HARNESS
          const items = STRATEGIES.map((s) => ({
            id: s.id,
            label: `${s.id} — ${s.title}`,
            note: s.desc,
            current: s.id === cur,
          }))
          items.push({
            id: STRATEGY_HARNESS,
            label: `${STRATEGY_HARNESS} — по умолчанию`,
            note: 'контекстом управляет харнесс (компрессия + прунер)',
            current: cur === STRATEGY_HARNESS,
          })
          chosen = await pickListTTY({ prompt: 'strategy> ', items })
          if (!chosen) { log.line('отменено'); break }
        }
        applyStrategy(chosen)
        break
      }
      case 'branch': {
        // Ветки — часть режима branch, поэтому команда ВСЕГДА приводит сессию в
        // этот режим. Раньше она молча работала поверх sliding/facts: ветки
        // создавались, а контекст продолжал собираться по прежней стратегии —
        // состояние было неочевидным.
        if (state.context?.strategy !== 'branch') applyStrategy('branch')
        const c = state.context
        const arg = (parts[1] ?? '').toLowerCase()
        const branchIds = () => Object.keys(c.branches)
        if (arg === 'new' || arg === 'create') {
          const name = parts.slice(2).join(' ') || `ветка ${c.branchSeq + 1}`
          createBranchPair(c, name)
          saveContext(opts.dshHome, c)
          log.dim(`· чекпоинт на ${c.checkpoint.atMessage} сообщениях; созданы ветки: ${branchIds().join(', ')}`)
          log.dim(`  активная: ${state.context.activeBranch} — продолжайте диалог здесь`)
          log.dim(`  стратегия: ${strategyLabel(c)}`)
          break
        }
        if (arg && (arg === 'main' || branchIds().some((b) => b.toLowerCase() === arg))) {
          switchBranch(c, arg)
          saveContext(opts.dshHome, c)
          log.dim(`· активная ветка: ${c.activeBranch} (${activeMessages(c).length} сообщений)`)
          break
        }
        if (arg) { log.err(`нет такой ветки: ${arg} (есть: main${branchIds().length ? ', ' + branchIds().join(', ') : ''})`); break }
        // Без аргумента — меню в стиле /resume.
        const items = [{ id: 'main', label: 'main — основная линия', note: `${c.messages.length} сообщений`, current: c.activeBranch === 'main' }]
        for (const id of branchIds()) {
          items.push({
            id,
            label: `${id} — ${c.branches[id].name}`,
            note: `${c.branches[id].messages.length} сообщений`,
            current: c.activeBranch === id,
          })
        }
        items.push({ id: '__new__', label: '+ новая ветка от текущего места', note: 'чекпоинт + пара веток' })
        const chosen = await pickListTTY({ prompt: 'branch> ', items })
        if (!chosen) { log.line('отменено'); break }
        if (chosen === '__new__') {
          createBranchPair(c, `ветка ${c.branchSeq + 1}`)
          saveContext(opts.dshHome, c)
          log.dim(`· чекпоинт на ${c.checkpoint.atMessage} сообщениях; созданы ветки: ${branchIds().join(', ')}`)
          log.dim(`  активная: ${c.activeBranch}`)
          break
        }
        switchBranch(c, chosen)
        saveContext(opts.dshHome, c)
        log.dim(`· активная ветка: ${c.activeBranch} (${activeMessages(c).length} сообщений) · стратегия: ${strategyLabel(c)}`)
        break
      }
      case 'session': {
        log.line(fmtSession(state.sessionId, state.titles[state.sessionId]))
        break
      }
      case 'context': {
        const m = state.metrics
        const ctx = m.lastPrompt || 0
        // Зонд MCP ходит в сеть фоном: без ожидания строка «fixed prefix» показала бы
        // префикс без MCP и ввела бы в заблуждение.
        if (state.mcp?.pending?.size) await Promise.allSettled([...state.mcp.pending.values()])
        const c = state.compress ?? { mode: 'on', ratio: COMPRESS_DEFAULT_RATIO, keep: COMPRESS_DEFAULT_KEEP }
        log.line(`${C.bold}context${C.off}`)
        log.dim(`  session: ${fmtSession(state.sessionId, state.titles[state.sessionId])}`)
        log.dim(`  strategy: ${strategyLabel(state.context)}${state.lastCompose ? ` · последний запрос: ${state.lastCompose.windowCount} сообщений${state.lastCompose.factsCount ? ` + ${state.lastCompose.factsCount} facts` : ''}` : ''}`)
        if (state.context && state.context.strategy !== STRATEGY_HARNESS) {
          const sc = state.context
          const brs = Object.keys(sc.branches ?? {})
          log.dim(`  dialogue: ${activeMessages(sc).length} сообщений, ветка ${sc.activeBranch}${brs.length ? `, веток: ${brs.join(', ')}` : ''}`)
          const fl = CTX_FACT_KEYS.filter((k) => sc.facts[k]).map((k) => `    - ${k}: ${sc.facts[k]}`)
          if (fl.length) { log.dim('  facts:'); for (const l of fl) log.dim(l) }
          if (sc.factsCalls) log.dim(`  facts updates: ${sc.factsCalls} calls, ${fmtTok(sc.factsTokens)} tokens`)
        }
        log.dim(`  compression: ${c.mode}${compressPolicyText(c)}${strategyMode ? ' (в режиме стратегии автокомпакция выключена)' : ''}`)
        if (c.mode === 'on') {
          const mcpTokens = state.mcp?.tokens ?? 0
          const floor = COMPRESS_SYSTEM_FLOOR + mcpTokens
          const compactable = Math.max(0, c.thresholdTokens - floor - c.keep)
          log.dim(`  fixed prefix: ≈ ${fmtTok(floor)} tokens (system prompt + tools${mcpTokens ? ` + ${fmtTok(mcpTokens)} MCP` : ''}) — не сжимается`)
          log.dim(`  per compaction: keep last ${fmtTok(c.keep)} verbatim, up to ≈ ${fmtTok(compactable)} older tokens summarized`)
          log.dim('    (это верхняя граница: хвост набирается целыми сообщениями, поэтому реально сжимается меньше — зависит от размеров ваших реплик)')
        }
        for (const note of compressNotes(c, state.mcp?.tokens ?? 0)) log.dim(`  note: ${note}`)
        log.dim(`  window: ${fmtTok(ctx)} / ${fmtTok(CTX_MAX)} (${fmtPct(ctx, CTX_MAX)}%)`)
        log.dim(`  tokens: in ${fmtTok(m.prompts)} (cache ${fmtTok(m.cacheReads)}) / out ${fmtTok(m.outputs)} · requests: ${m.calls}`)
        if (state.mcp) {
          for (const s of state.mcp.servers) {
            const probe = state.mcp.probes.get(s.serverName)
            log.dim(`  mcp: ${probe ? mcpProbeLine(s, probe) : `${s.serverName} · ${mcpModeLabel(s)} · зонд в процессе`}`)
          }
        } else log.dim('  mcp: не подключён')
        if (state.userProfile) {
          log.dim(`  profile: «${state.userProfile.title}» (${state.userProfile.slug}) · ~${userProfileTokens(state.userProfile)} токенов в промпте${m.profileCalls ? ` · обновлений: ${m.profileCalls} вызов(ов), ${fmtTok(m.profileTokens)} tokens` : ''}`)
        } else log.dim('  profile: не подключён')
        if (m.compactions || m.compactFails) {
          log.dim(`  summarize calls: ${m.compactions}${m.compactFails ? `, failed: ${m.compactFails} (их токены харнесс не пишет)` : ''} · ${fmtTok(m.compactTokens)} tokens`)
        }
        if (state.lastSummary) {
          const s = state.lastSummary
          log.dim(`  last summary: shadowed ${fmtTok(s.shadowed)} → ${fmtTok(s.tokens)} tokens${s.model ? ` (${s.model})` : ''}`)
          const head = s.text.split('\n').slice(0, 14).join('\n')
          log.dim(head.length > 900 ? head.slice(0, 900) + '…' : head)
        } else log.dim('  last summary: —')
        break
      }
      case 'profile': {
        const sub = (parts[1] ?? '').toLowerCase()
        const show = (p) => {
          log.line(`${C.bold}profile${C.off} «${p.title}» (${p.slug}) · ~${userProfileTokens(p)} токенов в system prompt`)
          log.dim(`  файл: ${userProfilePath(opts.dshHome, p.slug)}`)
          for (const l of renderUserProfile(p).split('\n').slice(1)) log.dim(`  ${l}`)
          const m = state.metrics
          if (m.profileCalls) log.dim(`  personalization calls: ${m.profileCalls}, ${fmtTok(m.profileTokens)} tokens`)
          log.dim('  профиль правится в файле или дополняется автоматически по вашим сообщениям')
        }
        if (!sub || sub === 'show' || sub === 'status') {
          if (state.userProfile) show(state.userProfile)
          else log.dim('профиль не подключён — /profile use <slug>, /profile new или запуск с --with-profiles')
          break
        }
        if (sub === 'list') {
          const list = listUserProfiles(opts.dshHome)
          if (!list.length) { log.dim('профилей ещё нет — /profile new'); break }
          for (const p of list) {
            const cur = p.slug === state.userProfile?.slug ? ' *' : ''
            log.dim(`  ${p.slug.padEnd(20)} ${p.title} · ~${p.tokens} токенов${cur}`)
          }
          log.dim(`  каталог: ${userProfilesDir(opts.dshHome)}`)
          break
        }
        if (sub === 'off' || sub === 'none') {
          if (!state.userProfile) { log.dim('профиль и так не подключён'); break }
          applyUserProfile(null)
          log.dim('профиль отключён — system prompt без персонализации со следующего сообщения')
          break
        }
        if (sub === 'new') {
          const created = await createUserProfileInteractive()
          if (!created) break
          applyUserProfile(created)
          show(created)
          log.dim('  применится со следующего сообщения')
          break
        }
        if (sub === 'use') {
          const slug = (parts[2] ?? '').trim()
          if (!slug) {
            const chosen = await pickOrCreateUserProfile()
            if (!chosen) { log.dim('профиль не выбран'); break }
            applyUserProfile(chosen)
            show(chosen)
            break
          }
          const found = readUserProfile(opts.dshHome, slug)
          if (found === null) {
            log.err(`профиль «${slug}» не найден`)
            const known = listUserProfiles(opts.dshHome)
            if (known.length) log.dim(`доступно: ${known.map((p) => p.slug).join(', ')}`)
            break
          }
          applyUserProfile(found)
          show(found)
          log.dim('  применится со следующего сообщения')
          break
        }
        log.err(`неизвестное действие: ${sub}`)
        log.dim('использование: /profile [show|list|use <slug>|new|off]')
        break
      }
      case 'resume': {
        const target = parts[1]
        if (target) {
          const known = listSessions(opts.dshHome)
          const resolved = resolveSessionPick(target, known, state.titles) ?? target
          switchSession(resolved)
          log.line(`${C.dim}resuming session:${C.reset} ${fmtSession(resolved, state.titles[resolved])}`)
          if (state.context) log.dim(`  стратегия сессии: ${strategyLabel(state.context)}`)
        } else {
          const list = listSessions(opts.dshHome)
          if (list.length === 0) { log.err('нет сохранённых сессий в этом home'); break }
          const chosen = await pickSessionTTY(list, state.titles)
          if (!chosen) { log.line('отменено'); break }
          switchSession(chosen)
          log.line(`${C.dim}resuming session:${C.reset} ${fmtSession(chosen, state.titles[chosen])}`)
          if (state.context) log.dim(`  стратегия сессии: ${strategyLabel(state.context)}`)
        }
        break
      }
      case 'mcp': {
        const m = state.mcp
        if (!m || !m.servers.length) {
          log.dim('MCP не подключён. Запуск с сервером: dsh-term --mcp github')
          log.dim('диагностика без сессии: dsh-term --mcp-check github')
          break
        }
        const sub = (parts[1] ?? '').toLowerCase()
        if (sub === 'refresh' || sub === 'reload') {
          log.dim('mcp: переподключаюсь…')
          for (const s of m.servers) {
            const probe = await mcpProbe(s)
            m.probes.set(s.serverName, probe)
            if (probe.ok) log.ok(`  ${mcpProbeLine(s, probe)}`)
            else log.err(`  ${mcpProbeLine(s, probe)}`)
          }
          m.tokens = [...m.probes.values()].filter((p) => p.ok).reduce((n, p) => n + mcpRegisteredTokens(p), 0)
          m.rawTokens = [...m.probes.values()].filter((p) => p.ok).reduce((n, p) => n + p.tokens, 0)
          break
        }
        // Первый зонд ходит в сеть фоном — команда дожидается его, чтобы показать
        // список и цену, а не «ещё не ответил».
        if (m.pending?.size) {
          const waiting = [...m.pending.values()]
          log.dim(`  mcp: жду ответ зонда (${waiting.length})…`)
          await Promise.allSettled(waiting)
        }
        if (sub === 'tools' || sub === 'list') {
          for (const s of m.servers) {
            const probe = m.probes.get(s.serverName)
            log.line(`${C.bold}${s.serverName}${C.off} — ${mcpModeLabel(s)}`)
            if (!probe) { log.dim('  зонд ещё не ответил — /mcp refresh'); continue }
            if (!probe.ok) { log.err(`  соединение не удалось: ${probe.error}`); continue }
            for (const t of probe.tools) {
              const req = t.inputSchema?.required ?? []
              const props = Object.keys(t.inputSchema?.properties ?? {})
              const args = props.map((p) => (req.includes(p) ? `${p}*` : p)).join(', ')
              log.line(`  mcp__${s.serverName}__${t.name}(${args})`)
              const desc = String(t.description ?? '').replace(/\s+/g, ' ')
              if (desc) log.dim(`      ${desc.slice(0, 140)}`)
            }
          }
          break
        }
        // По умолчанию (show): что подключено, режим, цена и как это выглядит для модели.
        log.line(`${C.bold}mcp${C.off} — мост @deepseek-ai/dsh-mcp-client, оверлей: ${m.patchPath}`)
        for (const s of m.servers) {
          const probe = m.probes.get(s.serverName)
          if (probe?.ok) log.dim(`  ${mcpProbeLine(s, probe)}`)
          else if (probe) log.err(`  ${mcpProbeLine(s, probe)}`)
          else log.dim(`  ${s.serverName} · ${mcpModeLabel(s)} · зонд в процессе`)
          log.dim(`    url: ${s.url}`)
          log.dim(`    инструменты для модели: mcp__${s.serverName}__<tool> — их описания уходят в каждый запрос`)
        }
        if (m.tokens) {
          log.dim(`  добавка к промпту: ≈ ${fmtTok(m.tokens)} токенов на каждый запрос (оценка по замеру;`)
          log.dim(`    сырые описания и схемы сервера весят ≈ ${fmtTok(m.rawTokens ?? 0)} — харнесс регистрирует компактнее)`)
          log.dim('    точную цифру даёт строка «context:» до и после включения MCP')
        }
        log.dim('  /mcp tools — полный список, /mcp refresh — переподключиться и пересчитать')
        break
      }
      case 'new': {
        switchSession(randomUUID(), { isNew: true })
        log.dim(`new session: ${state.sessionId}`)
        if (state.context) log.dim(`  стратегия: ${strategyLabel(state.context)}`)
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
      case 'create-project': {
        await createProject(opts, parts, askLine, promptTurn, state)
        break
      }
      case 'exit': {
        exiting = true
        await flushProfileLearning(state)
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
        await flushProfileLearning(state, 4000)
        try { await rpc.close() } catch {}
        process.exit(0)
      }
      if (!process.stdin.isTTY) process.stdout.write(PROMPT)
    }
  }
  pumpRef = pump

  // ---- handshake ----
  try {
    const res = await rpc.request('initialize', initParams)
    log.dim(`runtime: ${res.serverInfo.name} ${res.serverInfo.version} · provider=${opts.provider} model=${opts.model}`)
    // Диагностика UI: понятно, почему нет цветов/рендера (tty/NO_COLOR/one-shot).
    log.dim(`ui: in-tty=${process.stdin.isTTY ? 1 : 0} out-tty=${process.stdout.isTTY ? 1 : 0} colors=${C.cyan ? 1 : 0} md=${mdColorEnabled() ? 1 : 0}`)
    log.dim(`compress: ${compress.mode}${compressPolicyText(compress)}`)
    if (state.userProfile) {
      log.dim(`profile: «${state.userProfile.title}» (${state.userProfile.slug}) · ~${userProfileTokens(state.userProfile)} токенов в system prompt · файл: ${userProfilePath(opts.dshHome, state.userProfile.slug)}`)
    } else if (opts.withProfiles || profileSlug) {
      log.dim('profile: не выбран — сессия без персонализации')
    }
    // MCP: сразу видно, что включено; точный список инструментов и цена — фоном
    // (зонд ходит в сеть, сессию из-за него не задерживаем).
    if (state.mcp) {
      log.dim(`mcp: включён ${state.mcp.servers.map((s) => s.serverName).join(', ')} · ${state.mcp.servers.map(mcpModeLabel).join(' | ')} · запрашиваю список инструментов…`)
      state.mcp.pending = new Map()
      for (const s of state.mcp.servers) {
        const pending = mcpProbe(s).then((probe) => {
          if (!state.mcp) return probe
          state.mcp.probes.set(s.serverName, probe)
          state.mcp.pending?.delete(s.serverName)
          state.mcp.tokens = [...state.mcp.probes.values()].filter((p) => p.ok).reduce((n, p) => n + mcpRegisteredTokens(p), 0)
          state.mcp.rawTokens = [...state.mcp.probes.values()].filter((p) => p.ok).reduce((n, p) => n + p.tokens, 0)
          if (probe.ok) log.dim(`  mcp: ${mcpProbeLine(s, probe)} · инструменты видны как mcp__${s.serverName}__*`)
          else log.err(`  mcp: ${mcpProbeLine(s, probe)} — инструменты этого сервера модели недоступны`)
          return probe
        }).catch((e) => { trace(`mcp probe failed: ${e.message}`); return null })
        state.mcp.pending.set(s.serverName, pending)
      }
    }
    if (strategyMode) {
      log.dim(`strategy: ${strategyLabel(ctx)} — контекстом управляет ${
        ctx.strategy === 'facts' ? 'facts + окно сообщений' : ctx.strategy === 'branch' ? 'ветки диалога + окно сообщений' : 'окно сообщений'
      } (автокомпакция харнесса выключена)`)
    }
    // Несогласованная политика: харнесс молча отбросит спеку (см. compressNotes).
    for (const note of compressNotes(compress)) log.dim(`  note: ${note}`)
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
