/**
 * Регресс-тест: пока на экране диалог клиента (вопрос/подтверждение), анимация
 * «Deep diving…» не должна перерисовываться поверх него.
 *
 * Зачем: рантайм спрашивает клиента прямо посреди хода, когда анимация ещё
 * крутится. Её тик (140 мс) пишет `\r\x1b[K Deep diving…` в текущую строку — то
 * есть ровно туда, где нарисован вопрос, и получается мигание «выбор> ↔ Deep diving».
 *
 * Проверка: подделываем TTY, запускаем REPL, просим модель задать вопрос с
 * вариантами, ждём появления вопроса, ждём паузу и считаем, сколько раз за неё
 * была перерисована подпись. С исправлением — ноль.
 *
 * Запуск: node dsh-term/tests/asking-flicker.test.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const preload = join(here, 'fake-tty.cjs')
const home = process.env.DSH_TEST_HOME || join(tmpdir(), 'dsh-temp-verify2-home')
const PAUSE_MS = Number(process.env.DSH_TEST_PAUSE_MS || 1500)

const child = spawn(process.execPath, ['--require', preload, dshTerm, '--dsh-home', home], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_TERM_NO_ANIM: '' },
})
let bytes = ''
let stderr = ''
child.stdout.on('data', (d) => { bytes += d.toString('utf8') })
child.stderr.on('data', (d) => { stderr += d.toString('utf8') })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (re, timeoutMs = 90_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (re.test(bytes)) return true
    await sleep(200)
  }
  return false
}

child.stdin.write('Используй инструмент ask_user_question: задай ровно один вопрос «Что выбрать?» с вариантами «Альфа» и «Бета». После ответа назови выбранный вариант.\n')

const asked = await waitFor(/Что выбрать\?|выбор>|номер или id|Альфа/, 120_000)
console.log(`вопрос задан: ${asked ? 'да' : 'НЕТ'}`)
if (!asked) {
  child.kill()
  console.error('модель не вызвала ask_user_question — это флак модели, повторите запуск')
  console.error(stderr.slice(-400))
  process.exit(2)
}

// Граница «вопрос на экране»: всё, что появится после неё, — конкуренция перерисовок.
const mark = bytes.length
await sleep(PAUSE_MS)
const during = bytes.slice(mark)
const caption = (during.match(/Deep diving/g) ?? []).length
const meter = (during.match(/\(\d[\d.]*k? tokens?\)/g) ?? []).length

console.log(`пауза ${PAUSE_MS} мс: перерисовок подписи ${caption}, счётчика ${meter}`)

child.stdin.write('1\n')
const answered = await waitFor(/Альфа|Бета/)
child.stdin.write('/exit\n')
await sleep(1500)
child.kill()

if (caption > 0 || meter > 0) {
  console.error('\n✖ ПОДПИСЬ/СЧЁТЧИК ПЕРЕРИСОВЫВАЮТСЯ ПОВЕРХ ДИАЛОГА — меню будет мигать')
  process.exit(1)
}
console.log(`✔ во время диалога подпись и счётчик не перерисовываются (ответ доехал: ${answered ? 'да' : 'нет'})`)
