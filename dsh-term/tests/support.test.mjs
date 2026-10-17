/**
 * Тест режима техподдержки (день 33): данные обращения, промпт режима и MCP-сервер.
 *
 * Сеть и модель не нужны. Логика берётся напрямую из `lib/support.mjs`, а CLI
 * проверяется через диагностику `--support-check` (печатает ровно то, что уйдёт в
 * системный промпт) и `--mcp-check support --offline` (оверлей моста).
 *
 * Запуск: node dsh-term/tests/support.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SUPPORT_DEV_QUEUE,
  SUPPORT_DEV_TAG,
  supportDigest,
  supportInstructionText,
  supportPromptPreview,
  supportTicket,
  supportTickets,
  supportUserOf,
  supportUsers,
  supportWhen,
} from '../lib/support.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const repo = join(here, '..', '..')
const dataDir = join(repo, 'support-mcp', 'data')

function run(args, env = {}, cwd = repo) {
  const r = spawnSync(process.execPath, [dshTerm, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
}

const checks = []
const check = (name, ok, extra = '') => checks.push({ name, ok, extra })

// ---- 1. Хранилище: фикстуры читаются и согласованы ---------------------------
const tickets = supportTickets(repo)
check('tickets.json читается', tickets.error === null && tickets.tickets.length === 6,
  tickets.error ?? `len=${tickets.tickets.length}`)
check('открытых обращений пять', tickets.tickets.filter((t) => t.status !== 'closed').length === 5)
const users = supportUsers(repo)
check('users.json читается', users.error === null && users.users.length === 4)
check('у каждого обращения есть карточка пользователя',
  tickets.tickets.every((t) => supportUserOf(t, users.users) !== null))
check('номера обращений уникальны',
  new Set(tickets.tickets.map((t) => t.id)).size === tickets.tickets.length)

const found = supportTicket('t-1042', repo)
check('номер ищется без учёта регистра', found.error === null && found.ticket.id === 'T-1042')
const missing = supportTicket('T-9999', repo)
check('неизвестный номер: понятная ошибка', missing.error !== null && /обращение не найдено/.test(missing.error))
check('неизвестный номер: подсказка со списком открытых', /T-1042/.test(missing.error ?? ''))
check('дата в человеческом виде', supportWhen('2026-10-14T09:12:00+06:00') === '14.10 09:12')

// ---- 2. Слепок обращения: факты дословно, а не пересказ ----------------------
const t1042 = supportTicket('T-1042', repo).ticket
const irina = supportUserOf(t1042, users.users)
const digest = supportDigest(t1042, irina)
check('слепок: номер и тема', /обращение: T-1042 · «Сессия не запускается/.test(digest))
check('слепок: статус по-русски', /· открыт ·/.test(digest))
check('слепок: имя, почта, тариф, ОС, версия',
  /Ирина Соколова <irina\.sokolova@example\.ru> · тариф team · Windows 11 · dsh-term 0\.9\.4/.test(digest))
check('слепок: заметка о пользователе', /о пользователе: команда из четырёх/.test(digest))
check('слепок: теги обращения', /теги: api-key, startup, local-model/.test(digest))
check('слепок: переписка целиком', /переписка \(3\):/.test(digest))
check('слепок: текст пользователя дословно',
  /pi-ai provider "local" has no configured model "qwen3:8b"/.test(digest))
check('слепок: адрес из переписки сохранён', /127\.0\.0\.1:4000/.test(digest))
check('слепок: реплика поддержки помечена', /\[14\.10 09:41\] поддержка:/.test(digest))

// ---- 3. Промпт режима: роль, правила, задача в разработку --------------------
const prompt = supportInstructionText({ ticket: t1042, user: irina, hasFaq: true, hasTracker: true })
check('промпт: роль инженера поддержки', /РЕЖИМ ТЕХПОДДЕРЖКИ dsh-term/.test(prompt))
check('промпт: данные обращения внутри', prompt.includes(digest))
check('промпт: поиск по FAQ через rag_search', /`rag_search` \(база `support`\)/.test(prompt))
check('промпт: правило про источники и цитаты', /цитируй дословно 1–2 фрагмента/.test(prompt))
check('промпт: данные можно добрать через MCP поддержки', /mcp__support__\*/.test(prompt))
check('промпт: запрет выдумывать версии и цитаты', /не сочиняй версий/.test(prompt))
check('промпт: честный отказ без данных', /в базе и в обращении этого нет/.test(prompt))
check('промпт: запрет подменять вопрос темой обращения', /Не подменяй вопрос темой обращения/.test(prompt))
check('промпт: вопрос вне темы возвращается к поддержке', /верни к теме поддержки/.test(prompt))
check('промпт: задача в очередь INFRA', new RegExp(`create_task\\(queue: "${SUPPORT_DEV_QUEUE}"`).test(prompt))
check('промпт: заголовок с тегом-префиксом',
  new RegExp(`title: "\\[${SUPPORT_DEV_TAG}\\] <что починить`).test(prompt))
check('промпт: тег объяснён (у трекера нет поля тегов)', /тегов у трекера нет, префикс и есть тег/.test(prompt))
check('промпт: шаблон описания задачи', /## Откуда/.test(prompt) && /## Как проверить/.test(prompt))
check('промпт: обращение указано в описании задачи', /обращение поддержки: T-1042/.test(prompt))
check('промпт: номер задачи берётся из ответа трекера', /Задача в разработку: INFRA-<номер>/.test(prompt))
check('промпт: право не заводить задачу объяснено', /не требуется — <причина>/.test(prompt))

const degraded = supportInstructionText({ ticket: t1042, user: irina, hasFaq: false, hasTracker: false })
check('без базы: честно сказано, что FAQ не подключён', /База FAQ в этой сессии не подключена/.test(degraded))
check('без трекера: задача уходит текстом', /задачу в разработку создай текстом/.test(degraded))
check('без трекера: вызов create_task не предлагается', !/create_task\(queue/.test(degraded))

// ---- 4. CLI-диагностика --support-check -------------------------------------
const cli = run(['--support-check', 'T-1042'])
check('--support-check: код 0', cli.code === 0, `code=${cli.code}`)
check('--support-check: номер и тема', /support-check T-1042 — «Сессия не запускается/.test(cli.out))
check('--support-check: пользователь в шапке', /Ирина Соколова <irina\.sokolova@example\.ru>/.test(cli.out))
check('--support-check: база FAQ найдена', /FAQ: база «support»/.test(cli.out))
check('--support-check: промпт напечатан целиком', /ПОСЛЕ ОТВЕТА — ЗАДАЧА В РАЗРАБОТКУ:/.test(cli.out))
check('--support-check: переписка в промпте', /переписка \(3\):/.test(cli.out))

const unknown = run(['--support-check', 'T-0000'])
check('--support-check: неизвестный номер → код 1', unknown.code === 1, `code=${unknown.code}`)
check('--support-check: неизвестный номер → подсказка', /обращение не найдено: T-0000/.test(unknown.out))

const help = run(['--help'])
check('--support в справке флагов', /--support \[<тикет>\]/.test(help.out))
check('--support-check в справке флагов', /--support-check <тикет>/.test(help.out))
check('/support в списке команд', /\/support \[<тикет>\|off\]/.test(help.out))

// ---- 5. Своё хранилище и битые данные --------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'dsh-support-'))
cpSync(dataDir, join(tmp, 'data'), { recursive: true })
const custom = run(['--support-check', 'T-1051'], { DSH_TERM_SUPPORT_DATA: join(tmp, 'data') })
check('DSH_TERM_SUPPORT_DATA: своё хранилище', custom.code === 0 && /T-1051/.test(custom.out),
  `code=${custom.code}`)
check('DSH_TERM_SUPPORT_DATA: данные из копии', /Артём Ковалёв/.test(custom.out))

writeFileSync(join(tmp, 'data', 'tickets.json'), '{ битый json', 'utf8')
const broken = run(['--support-check', 'T-1042'], { DSH_TERM_SUPPORT_DATA: join(tmp, 'data') })
check('битый JSON → код 1', broken.code === 1, `code=${broken.code}`)
check('битый JSON → путь и причина', /не читается/.test(broken.out) && /tickets\.json/.test(broken.out))

const noDir = run(['--support-check', 'T-1042'], { DSH_TERM_SUPPORT_DATA: join(tmp, 'нет-каталога') })
check('нет каталога → код 1 и путь', noDir.code === 1 && /нет файла данных/.test(noDir.out))

// ---- 6. MCP-сервер поддержки в оверлее моста -------------------------------
const overlay = run(['--mcp-check', 'support', '--offline'])
check('оверлей: exit 0', overlay.code === 0, `code=${overlay.code}`)
check('оверлей: insert-строка mcp-support', /- id: mcp-support/.test(overlay.out))
check('оверлей: stdio-транспорт', /transport: stdio/.test(overlay.out))
check('оверлей: python -m support_mcp.server',
  /command: python/.test(overlay.out) && /- '-m'/.test(overlay.out) && /- 'support_mcp\.server'/.test(overlay.out))
check('оверлей: PYTHONPATH на каталог пакета', /PYTHONPATH: '.*support-mcp'/.test(overlay.out))
check('оверлей: utf-8 для python', /PYTHONIOENCODING: 'utf-8'/.test(overlay.out))
check('оверлей: секретов нет', !/Authorization|token/i.test(overlay.out))

// Два stdio-сервера в одном оверлее (RAG + поддержка): у каждого свой `env:`,
// иначе PYTHONPATH уезжает в `args` и харнесс падает на «bad indentation».
const two = run(['--rag', 'support', '--mcp-check', 'support,rag', '--offline'])
check('два stdio-сервера: exit 0', two.code === 0, `code=${two.code}`)
const envBlocks = two.out.match(/^ {12}env:$/gm) ?? []
check('два stdio-сервера: два блока env:', envBlocks.length === 2, `env-блоков=${envBlocks.length}`)
const blocks = two.out.split(/- id: mcp-/).slice(1)
check('два stdio-сервера: у каждого блока есть env:',
  blocks.length === 2 && blocks.every((b) => /^ {12}env:$/m.test(b)), `блоков=${blocks.length}`)
check('два stdio-сервера: PYTHONPATH внутри env:, а не args',
  blocks.every((b) => /^ {12}env:\n {14}PYTHONPATH:/m.test(b)))

// ---- 7. Реестр баз: база поддержки объявлена -------------------------------
const registry = JSON.parse(readFileSync(join(repo, '.dsh', 'rag.json'), 'utf8'))
const bases = registry.bases ?? registry
check('реестр: база support есть', !!bases.support)
check('реестр: индекс в support-index/out', /support-index[\\/]out/.test(String(bases.support?.out ?? '')))
check('реестр: пакет doc-index', /doc-index/.test(String(bases.support?.index ?? '')))
check('реестр: в описании сказано «FAQ продукта»', /FAQ/.test(String(bases.support?.what ?? '')))

// ---- 8. Превью промпта как API (без CLI) ----------------------------------
const preview = supportPromptPreview('T-1058', { cwd: repo, hasFaq: true, hasTracker: true })
check('preview: обращение найдено', preview.ticket?.id === 'T-1058' && !preview.error)
check('preview: пользователь приложен', preview.user?.name === 'Павел Дорохов')
const previewMissing = supportPromptPreview('T-7777', { cwd: repo })
check('preview: ошибка вместо падения', !!previewMissing.error && !previewMissing.text)

let failed = 0
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` (${c.extra})`}`)
  if (!c.ok) failed += 1
}
if (failed) {
  console.error(`\n✖ провалено проверок: ${failed}`)
  console.error('--- последний вывод CLI ---')
  console.error(cli.out.slice(0, 2000))
  process.exit(1)
}
console.log(`\n✔ режим поддержки: проверок ${checks.length}, все прошли`)
