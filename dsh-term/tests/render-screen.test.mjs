/**
 * Интеграционный тест рендера ответа: «экран» терминала не должен терять или
 * добавлять символы в текст модели.
 *
 * Зачем: живой счётчик токенов и подпись «Deep diving…» пишут прямо в строку
 * ответа, поэтому любая ошибка в стирании оставляет в выводе куски служебного
 * текста (или съедает символы ответа). Тест ловит это сравнением:
 *   текст ответа из durable-лога  ⊂  экран после симуляции терминала.
 *
 * Запуск (нужен рабочий home с профилем и токеном):
 *   node dsh-term/tests/render-screen.test.mjs
 * Переменные: DSH_TEST_HOME, DSH_TEST_COLS (по умолчанию 80), DSH_TEST_ARGS.
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const preload = join(here, 'fake-tty.cjs')
const cols = Number(process.env.DSH_TEST_COLS || 80)
const home = process.env.DSH_TEST_HOME || join(tmpdir(), 'dsh-temp-verify2-home')
const prompt = process.env.DSH_TEST_PROMPT
  || 'Ответь тремя короткими абзацами (по 40-60 слов) про Марс: атмосфера, поверхность, миссии.'

/**
 * Мини-симулятор терминала: только те последовательности, что пишет dsh-term,
 * но с честным «отложенным переносом» (pending wrap) — именно на границе
 * переноса ломается стирание через `\b`, поэтому без этой детали тест слеп.
 * @returns {screen, counterViolations} — экран и список перенесённых счётчиков.
 */
function simulateTerminal(bytes, width) {
  const rows = ['']
  let row = 0
  let col = 0
  let pendingWrap = false
  let saved = { row: 0, col: 0, pendingWrap: false }
  const ensure = (r) => { while (rows.length <= r) rows.push('') }
  const put = (ch) => {
    if (pendingWrap) { row += 1; col = 0; pendingWrap = false; ensure(row) }
    ensure(row)
    const line = rows[row].padEnd(col, ' ').split('')
    line[col] = ch
    rows[row] = line.join('')
    if (col + 1 >= width) { col = width - 1; pendingWrap = true } else col += 1
  }
  const text = bytes.toString('utf8')
  // Счётчик токенов в потоке: " (12 tokens)" / " (3.1k tokens)" — проверяем,
  // что он целиком лёг в одну строку (иначе `\b`-стирание его не уберёт).
  const spans = [...text.matchAll(/ \(\d[\d.]*k? tokens?\)/g)].map((m) => [m.index, m.index + m[0].length])
  const counterViolations = []
  let span = 0
  let spanStart = null
  for (let i = 0; i < text.length; i++) {
    if (span < spans.length && i === spans[span][0]) spanStart = { row, col, pendingWrap }
    const ch = text[i]
    if (ch === '\x1b') {
      const rest = text.slice(i)
      const csi = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(rest)
      if (csi) {
        const [seq, params, final] = csi
        if (final === 'K' && (params === '' || params === '0')) {
          const from = pendingWrap ? width - 1 : col
          const line = rows[row].split('')
          line.length = Math.max(line.length, from)
          for (let c = from; c < line.length; c++) line[c] = ' '
          rows[row] = line.join('').replace(/\s+$/, '')
        }
        i += seq.length - 1
      } else {
        const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest)
        // DSH_TEST_IGNORE_SAVE=1 эмулирует терминал без ESC 7 / ESC 8
        // (сохранение/восстановление курсора): так воспроизводится «прорастание»
        // счётчика в текст ответа.
        const ignoreSave = process.env.DSH_TEST_IGNORE_SAVE === '1'
        if (osc) i += osc[0].length - 1
        else if (rest[1] === '7') { if (!ignoreSave) saved = { row, col, pendingWrap }; i += 1 }
        else if (rest[1] === '8') { if (!ignoreSave) { row = saved.row; col = saved.col; pendingWrap = saved.pendingWrap }; i += 1 }
      }
    } else if (ch === '\n') { row += 1; col = 0; pendingWrap = false; ensure(row) } else if (ch === '\r') { col = 0; pendingWrap = false } else if (ch === '\b') {
      if (pendingWrap) { pendingWrap = false; col = width - 1 }
      col = Math.max(0, col - 1)
    } else if (ch !== '\x07') put(ch)
    if (span < spans.length && i === spans[span][1] - 1) {
      if (spanStart !== null && row !== spanStart.row) {
        counterViolations.push({ text: text.slice(spans[span][0], spans[span][1]), row: spanStart.row, endRow: row })
      }
      spanStart = null
      span += 1
    }
  }
  return { screen: rows.map((r) => r.replace(/\s+$/, '')).join('\n'), counterViolations, counterSpans: spans.length }
}

/** Все кадры zstd в файле распаковываются по отдельности (Node читает только первый). */
function readSessionLog(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) starts.push(i)
  if (starts.length === 0) return buf.toString('utf8')
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8') } catch {}
  }
  return out
}

function newestSessionLog(root) {
  let best = null
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^session(\.[\w-]+)?\.jsonl(\.zstd)?$/.test(e.name)) {
        const m = statSync(p).mtimeMs
        if (best === null || m > best.m) best = { path: p, m }
      }
    }
  }
  if (statSync(root, { throwIfNoEntry: false })) walk(root)
  return best?.path
}

const work = mkdtempSync(join(tmpdir(), 'dsh-render-test-'))
const inputFile = join(work, 'in.txt')
writeFileSync(inputFile, `${prompt}\n`, 'utf8')

const args = [dshTerm, '--dsh-home', home]
if (process.env.DSH_TEST_ARGS) args.push(...process.env.DSH_TEST_ARGS.split(' ').filter(Boolean))

const child = spawn(process.execPath, ['--require', preload, ...args], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_TERM_NO_ANIM: '' },
})
writeFileSync(join(work, 'stdin.txt'), readFileSync(inputFile))
const out = []
const err = []
child.stdout.on('data', (d) => out.push(d))
child.stderr.on('data', (d) => err.push(d))
child.stdin.end(readFileSync(inputFile))

const code = await new Promise((resolve) => child.on('exit', resolve))
const bytes = Buffer.concat(out)
const stderr = Buffer.concat(err).toString('utf8')
const { screen, counterViolations, counterSpans } = simulateTerminal(bytes, cols)

const logPath = newestSessionLog(join(home, 'sessions'))
if (logPath === undefined) {
  console.error('не найден лог сессии в', join(home, 'sessions'))
  process.exit(2)
}
const events = readSessionLog(logPath).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const answers = events
  .filter((e) => e.type === 'assistant/message')
  .map((e) => (e.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join(''))
  .filter((t) => t.trim().length > 0)
const answer = answers[answers.length - 1] ?? ''

const strip = (s) => s.replace(/\s+/g, '')
const flatScreen = strip(screen)
const flatAnswer = strip(answer)

// Служебная строка не должна приклеиваться к анимации: наблюдалось
// «Deep diving… (0 tokens)· context compacted: …».
const glued = screen.split('\n').filter((l) => l.includes('Deep diving') && /[·✖]/.test(l))
if (glued.length > 0) {
  console.error(`\n✖ СЛУЖЕБНАЯ СТРОКА ПРИКЛЕИЛАСЬ К АНИМАЦИИ (${glued.length}):`)
  for (const l of glued.slice(0, 3)) console.error(`  ${JSON.stringify(l.slice(0, 120))}`)
}

console.log(`exit=${code} cols=${cols} session=${logPath.split(/[\\/]/).slice(-2)[0]}`)
console.log(`stdout bytes=${bytes.length} answer chars=${answer.length} counter draws=${counterSpans}`)
const compLines = (screen.match(/· context compacted|· tool output pruned|✖ compaction failed/g) ?? []).length
if (compLines > 0) console.log(`compaction-строк на экране: ${compLines}`)
if (counterViolations.length > 0) {
  console.error(`\n✖ СЧЁТЧИК ПЕРЕНЕСЁН НА ДРУГУЮ СТРОКУ (${counterViolations.length} шт.) — \`\\b\`-стирание его не уберёт:`)
  for (const v of counterViolations.slice(0, 5)) console.error(`  ${JSON.stringify(v.text)} строка ${v.row} → ${v.endRow}`)
}

let ok = flatAnswer.length > 0 && flatScreen.includes(flatAnswer) && counterViolations.length === 0 && glued.length === 0
if (!ok && flatAnswer.length > 0 && !flatScreen.includes(flatAnswer)) {
  // Показать первое расхождение: сколько символов ответа дошло до экрана.
  let n = 0
  while (n < flatAnswer.length && n < flatScreen.length && flatScreen.includes(flatAnswer.slice(0, n + 1))) n += 1
  console.error(`\n✖ ТЕКСТ ОТВЕТА ИСПОРЧЕН: на экране совпало ${n} из ${flatAnswer.length} символов`)
  console.error(`  модель: …${flatAnswer.slice(Math.max(0, n - 40), n + 40)}…`)
  const at = flatScreen.indexOf(flatAnswer.slice(Math.max(0, n - 20), n))
  console.error(`  экран:  …${flatScreen.slice(Math.max(0, at + 20), at + 100)}…`)
  process.exit(1)
}
console.log(`✔ текст ответа на экране цел (${flatAnswer.length} символов, порядок и состав совпадают)`)
if (stderr.includes('compaction failed')) console.log('  (в stderr были отказы компакции — для этого теста неважно)')
