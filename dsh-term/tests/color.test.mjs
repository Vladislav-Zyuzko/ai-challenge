/**
 * Тест режима цвета и markdown-рендера dsh-term: `--color auto|always|never`.
 *
 * Зачем отдельный тест: markdown-рендер справки (/rag-brief) и ответов включается
 * только когда цвета разрешены, а решение зависит от TTY, NO_COLOR и режима.
 * В пайпе TTY нет, поэтому здесь проверяется именно то, что видно в диагностике
 * `ui: …` — по ней пользователь и понимает, почему вывод не красится.
 *
 * Запуск: node dsh-term/tests/color.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')

/** Запустить dsh-term без сессии (stdin закрыт) и вернуть вывод. */
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [dshTerm, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, ...env },
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
}

/** Строка диагностики UI без ANSI-кодов. */
function uiLine(out) {
  const line = out.split('\n').find((l) => l.includes('ui: in-tty=')) ?? ''
  return line.replace(/\u001b\[[0-9;]*m/g, '').trim()
}

const checks = []
const check = (name, ok, extra = '') => checks.push({ name, ok, extra })

// 1. По умолчанию (auto) в пайпе цвета и рендер выключены — это ожидаемое поведение.
const auto = run(['--color', 'auto'])
check('auto без TTY: цвета выключены', /colors=0/.test(uiLine(auto.out)), uiLine(auto.out))
check('auto без TTY: markdown выключен', /md=0/.test(uiLine(auto.out)), uiLine(auto.out))
check('auto: режим виден в диагностике', /color=auto/.test(uiLine(auto.out)), uiLine(auto.out))

// 2. NO_COLOR выключает цвета даже там, где они были бы возможны.
const noColor = run([], { NO_COLOR: '1' })
check('NO_COLOR: цвета выключены', /colors=0/.test(uiLine(noColor.out)), uiLine(noColor.out))
check('NO_COLOR: помечен в диагностике', /no-color/.test(uiLine(noColor.out)), uiLine(noColor.out))

// 3. --color always форсирует цвета и markdown даже без TTY и при NO_COLOR:
//    именно этот случай нужен в терминалах, где TTY не определяется, и в шеллах,
//    которым харнесс выставляет NO_COLOR.
const forced = run(['--color', 'always'], { NO_COLOR: '1' })
check('always при NO_COLOR: цвета включены', /colors=1/.test(uiLine(forced.out)), uiLine(forced.out))
check('always при NO_COLOR: markdown включён', /md=1/.test(uiLine(forced.out)), uiLine(forced.out))
check('always: режим виден в диагностике', /color=always/.test(uiLine(forced.out)), uiLine(forced.out))
check('always: ANSI-коды реально в выводе', /\u001b\[/.test(forced.out))
check('always: не помечен как no-color', !/no-color/.test(uiLine(forced.out)), uiLine(forced.out))

// 4. --color never выключает цвета явно.
const never = run(['--color', 'never'], { DSH_TERM_COLOR: 'always' })
check('never сильнее переменной окружения', /colors=0/.test(uiLine(never.out)), uiLine(never.out))
check('never: markdown выключен', /md=0/.test(uiLine(never.out)), uiLine(never.out))

// 5. Переменная окружения работает как флаг.
const byEnv = run([], { DSH_TERM_COLOR: 'always' })
check('DSH_TERM_COLOR=always включает цвета', /colors=1/.test(uiLine(byEnv.out)), uiLine(byEnv.out))

// 6. Неверное значение: внятная ошибка со списком режимов.
const bad = run(['--color', 'радуга'])
check('неверный режим → сообщение', /--color: ожидается auto \| always \| never/.test(bad.out), bad.out.slice(0, 200))

// 7. Флаг описан в справке.
const help = run(['--help'])
check('--color описан в справке', /--color <режим>/.test(help.out))
check('в справке есть режимы', /auto \| always \| never/.test(help.out))

let failed = 0
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` (${c.extra})`}`)
  if (!c.ok) failed += 1
}
if (failed) {
  console.error(`\n✖ провалено проверок: ${failed}`)
  process.exit(1)
}
console.log(`✔ цвет: auto/always/never, NO_COLOR и DSH_TERM_COLOR работают как задумано (${checks.length} проверок)`)
