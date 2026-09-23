/**
 * Регресс-тест персонализации (day12): профиль пользователя — это файл, который
 * подключается к сессии оверлеем `- id: system-prompt` (personaPrefix) и меняется
 * командами `/profile`. Модель не вызывается: проверяются только команды, файлы
 * и диагностика (создание оверлея, список профилей, переключение, отключение).
 *
 * Запуск: node dsh-term/tests/profile.test.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const preload = join(here, 'fake-tty.cjs')
const home = process.env.DSH_TEST_HOME || join(process.env.TEMP || '/tmp', 'dsh-temp-verify2-home')
if (!existsSync(join(home, 'profiles'))) {
  console.error(`✖ нет рантайм-профилей в ${home} — укажите DSH_TEST_HOME с рабочим home`)
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Фикстуры: два контрастных профиля в том формате, который читает dsh-term.
const dir = join(home, 'user-profiles')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 't-kratko.md'), [
  '# Профиль пользователя: Тест кратко',
  '', '## Стиль', '- Отвечай одной фразой, без предисловий.',
  '', '## Чего избегать', '- Списков и резюме.',
  '',
].join('\n'), 'utf8')
writeFileSync(join(dir, 't-podrobno.md'), [
  '# Профиль пользователя: Тест подробно',
  '', '## Стиль', '- Объясняй каждый шаг и причину решения.',
  '', '## Формат', '- Разбор по пунктам, затем «Итого».',
  '',
].join('\n'), 'utf8')

const patchFile = join(home, 'dsh-term-persona.patch.yml')
const child = spawn(process.execPath, ['--require', preload, dshTerm, '--dsh-home', home, '--user-profile', 't-kratko'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, DSH_TEST_COLS: '100' },
})
const out = []
const err = []
child.stdout.on('data', (d) => out.push(d))
child.stderr.on('data', (d) => err.push(d))

await sleep(12_000)
// Команды идут в REPL как строки; после /profile off профиль отключается,
// но оверлей на диске остаётся (он больше не подключается к рантайму).
child.stdin.write('/profile\r')
await sleep(600)
child.stdin.write('/profile list\r')
await sleep(600)
child.stdin.write('/profile use t-podrobno\r')
await sleep(600)
const afterSwitch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
child.stdin.write('/profile off\r')
await sleep(600)
child.stdin.write('/exit\r')

const code = await new Promise((resolve) => {
  const t = setTimeout(() => { child.kill(); resolve(null) }, 30_000)
  child.on('exit', (c) => { clearTimeout(t); resolve(c) })
})

const text = Buffer.concat(out).toString('utf8') + Buffer.concat(err).toString('utf8')
const checks = [
  ['стартовая диагностика профиля', /profile: «Тест кратко» \(t-kratko\) · ~\d+ токенов/.test(text)],
  ['/profile показал файл', new RegExp(`t-kratko\\.md`).test(text)],
  ['/profile list видит оба профиля', /t-kratko/.test(text) && /t-podrobno/.test(text)],
  ['переключение профиля', /«Тест подробно» \(t-podrobno\)/.test(text)],
  ['оверлей содержит новый профиль', /Объясняй каждый шаг/.test(afterSwitch)],
  ['оверлей объявляет приоритет профиля над историей', /Единственный источник правил стиля/.test(afterSwitch)],
  ['/profile off отключил персонализацию', /профиль отключён/.test(text)],
  ['exit code 0', code === 0],
]
let bad = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (!ok) bad++
}
if (bad) {
  console.error('\n--- вывод dsh-term ---')
  console.error(text.slice(-4000))
  process.exit(1)
}
console.log('✔ персонализация: профиль подключается, переключается и отключается')
