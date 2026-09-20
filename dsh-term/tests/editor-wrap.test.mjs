/**
 * Регресс-тест редактора строки: ввод длиннее терминала (перенос) не должен
 * дублировать промпт «dsh> » на строках выше.
 *
 * Причина бага: перерисовка делала `\r\x1b[J` — стирается только ТЕКУЩАЯ строка
 * и ниже, а при переносе предыдущие визуальные строки остаются на экране, и каждый
 * введённый символ добавляет ещё одну копию строки.
 *
 * Запуск: DSH_TEST_COLS=80 node dsh-term/tests/editor-wrap.test.mjs
 * Модель не вызывается: вводится `/exit` + длинный хвост, затем Enter.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const preload = join(here, 'fake-tty.cjs')
const cols = Number(process.env.DSH_TEST_COLS || 80)
const home = process.env.DSH_TEST_HOME || join(process.env.TEMP || '/tmp', 'dsh-temp-verify2-home')

/** Мини-симулятор терминала: только нужные последовательности (перенос — честный). */
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
  env: { ...process.env, DSH_TEST_COLS: String(cols), DSH_TEST_FAKE_STDIN: '1', DSH_TERM_NO_ANIM: '1' },
})
const out = []
child.stdout.on('data', (d) => out.push(d))
child.stderr.on('data', () => {})

// Ждём первый промпт, затем вводим длинную строку посимвольно (как человек).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(12_000)
const long = '/exit' + ' '.repeat(cols * 2)
for (const ch of long) {
  child.stdin.write(ch)
  await sleep(4)
}
await sleep(500)
child.stdin.write('\r')

const code = await new Promise((resolve) => {
  const t = setTimeout(() => { child.kill(); resolve(null) }, 20_000)
  child.on('exit', (c) => { clearTimeout(t); resolve(c) })
})

const screen = simulate(Buffer.concat(out), cols)
const lines = screen.split('\n')
const promptRows = lines.filter((l) => l.startsWith('dsh> '))
console.log(`ширина ${cols}, введено ${long.length} символов, exit=${code}`)
console.log(`строк с промптом «dsh> » на экране: ${promptRows.length}`)

if (promptRows.length > 1) {
  console.error('\n✖ ПРОМПТ ДУБЛИРУЕТСЯ ПРИ ПЕРЕНОСЕ СТРОКИ:')
  for (const l of promptRows.slice(0, 4)) console.error(`  ${l.slice(0, cols)}`)
  process.exit(1)
}
console.log('✔ строка ввода не дублируется при переносе')
