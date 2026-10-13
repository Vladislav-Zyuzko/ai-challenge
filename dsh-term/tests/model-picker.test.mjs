/**
 * Регресс-тест интерактивного выбора модели (`/model`): строка «model> » не должна
 * размножаться по экрану.
 *
 * Причина бага: кадр меню рисуется как «строка с промптом + N строк ниже», а в конце
 * курсор возвращается вверх на ВЫЧИСЛЕННОЕ число строк. Нижняя строка-подсказка
 * («↑↓ — выбрать · Enter — ок · …», 56 символов) не обрезалась по ширине терминала.
 * В терминале шириной 50 колонок она переносится на вторую физическую строку, счёт
 * строк расходится на единицу, курсор после каждого кадра остаётся на строку ниже —
 * и тик (300 мс) дорисовывает ещё одну «model> » над меню. На ширине 80 подсказка
 * помещается целиком, поэтому баг не проявлялся.
 *
 * Запуск: node dsh-term/tests/model-picker.test.mjs
 * Модель не вызывается: открываем меню, ждём несколько тиков, отменяем по Esc.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const preload = join(here, 'fake-tty.cjs')
// Ширина намеренно узкая: именно так подсказка меню перестаёт помещаться в строку.
const cols = Number(process.env.DSH_TEST_COLS || 50)
const home = process.env.DSH_TEST_HOME || join(process.env.TEMP || '/tmp', 'dsh-temp-verify2-home')
// Сколько тиков перерисовки пережить (тик меню — 300 мс).
const WAIT_MS = Number(process.env.DSH_TEST_WAIT_MS || 2200)

/** Мини-симулятор терминала: перенос строки честный, стирание вниз — как в терминале. */
function simulate(bytes, width) {
  const rows = ['']
  let row = 0
  let col = 0
  let pendingWrap = false
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
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\x1b') {
      const rest = text.slice(i)
      const csi = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(rest)
      if (csi) {
        const [seq, params, final] = csi
        const n = params === '' ? 1 : Number(params.split(';')[0])
        if (final === 'A') { row = Math.max(0, row - n); pendingWrap = false }
        else if (final === 'B') { row += n; ensure(row); pendingWrap = false }
        else if (final === 'G') { col = Math.max(0, Math.min(width - 1, n - 1)); pendingWrap = false }
        else if (final === 'K') { rows[row] = rows[row].slice(0, col) }
        else if (final === 'J') { rows[row] = rows[row].slice(0, col); rows.length = row + 1 }
        i += seq.length - 1
        continue
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest)
      if (osc) i += osc[0].length - 1
      continue
    }
    if (ch === '\n') { row += 1; col = 0; pendingWrap = false; ensure(row); continue }
    if (ch === '\r') { col = 0; pendingWrap = false; continue }
    if (ch === '\b') { col = Math.max(0, col - 1); continue }
    if (ch === '\x07') continue
    put(ch)
  }
  return rows.map((r) => r.replace(/\s+$/, '')).join('\n')
}

const child = spawn(process.execPath, ['--require', preload, dshTerm, '--dsh-home', home], {
  stdio: ['pipe', 'pipe', 'pipe'],
  // NO_COLOR снимаем намеренно: меню выбора модели открывается только при цветном
  // выводе (`/model` без аргумента иначе печатает список и выходит).
  env: {
    ...process.env, NO_COLOR: '', DSH_TERM_COLOR: '',
    DSH_TEST_COLS: String(cols), DSH_TEST_FAKE_STDIN: '1', DSH_TERM_NO_ANIM: '1',
  },
})
const out = []
let stderr = ''
child.stdout.on('data', (d) => out.push(d))
child.stderr.on('data', (d) => { stderr += d.toString('utf8') })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = () => Buffer.concat(out).toString('utf8')
const waitFor = async (re, timeoutMs) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (re.test(text())) return true
    await sleep(200)
  }
  return false
}

// Ждём приглашение редактора и открываем меню выбора модели.
// Регулярка терпит SGR-коды внутри приглашения: «dsh» и «> » печатаются разными
// цветами, поэтому в потоке между ними стоит escape-последовательность.
const ready = await waitFor(/dsh(?:\x1b\[[0-9;]*m)*> /, 60_000)
if (!ready) {
  child.kill()
  console.error('dsh-term не показал приглашение за 60 с')
  console.error(stderr.slice(-400))
  process.exit(2)
}
child.stdin.write('/model\r')
const opened = await waitFor(/model> /, 30_000)
if (!opened) {
  child.kill()
  console.error('меню выбора модели не открылось')
  process.exit(2)
}

// Несколько тиков перерисовки без единого нажатия: тут баг и проявляется.
await sleep(WAIT_MS)
const ticks = Math.round(WAIT_MS / 300)
child.stdin.write('\x1b')          // Esc — отмена
await sleep(400)
child.stdin.write('/exit\r')
await new Promise((resolve) => {
  const t = setTimeout(() => { child.kill(); resolve(null) }, 15_000)
  child.on('exit', (c) => { clearTimeout(t); resolve(c) })
})

const screen = simulate(Buffer.concat(out), cols)
const lines = screen.split('\n')
// Пробел после «>» не проверяем: симулятор срезает хвостовые пробелы строки.
const promptRows = lines.filter((l) => /^model>/.test(l))
console.log(`ширина ${cols}, тиков перерисовки ~${ticks}, строк с «model> » на экране: ${promptRows.length}`)

if (promptRows.length > 1) {
  console.error(`\n✖ СТРОКА «model> » РАЗМНОЖАЕТСЯ ПРИ ПЕРЕРИСОВКЕ (${promptRows.length} копий):`)
  for (const l of promptRows.slice(0, 5)) console.error(`  ${l.slice(0, cols)}`)
  console.error('  причина: строка кадра переносится по ширине терминала, а возврат курсора')
  console.error('  считает строки по числу логических строк меню')
  process.exit(1)
}
console.log('✔ меню выбора модели перерисовывается без дублей строки ввода')
