/**
 * Тест баз знаний в сессии dsh-term (day23): флаг `--rag`, реестр `.dsh/rag.json`,
 * синтез stdio-сервера для моста `@deepseek-ai/dsh-mcp-client` и инструкция в
 * системный промпт.
 *
 * Сеть и модель не нужны: проверяется режим `--mcp-check rag --offline`
 * (печатает оба оверлея и выходит) и внятность ошибок на битом реестре.
 *
 * Запуск: node dsh-term/tests/rag.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')
const repo = join(here, '..', '..')
const indexDir = join(repo, 'doc-index')

/** Запустить dsh-term и вернуть stdout+stderr и код выхода. */
function run(args, env = {}, cwd = repo) {
  const r = spawnSync(process.execPath, [dshTerm, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
}

/** Реестр баз во временном файле: рабочий вариант с одной базой. */
function registryFile(bases) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rag-'))
  const path = join(dir, 'rag.json')
  writeFileSync(path, JSON.stringify(bases, null, 2), 'utf8')
  return path
}

const goodRegistry = registryFile({
  'test-base': {
    title: 'тестовая база',
    index: indexDir,
    what: 'понятия и метрики',
    strategy: 'structural',
    margin: 0.04,
    minDense: 0.5,
  },
})

const checks = []
const check = (name, ok, extra = '') => checks.push({ name, ok, extra })

// 1. Оверлей MCP: сервер собран как stdio с python-пакетом и путём к базе.
const base = run(['--rag', 'test-base', '--mcp-check', 'rag', '--offline'],
  { DSH_TERM_RAG_FILE: goodRegistry })
check('exit code 0', base.code === 0, `code=${base.code}`)
check('insert-строка mcp-rag', /- id: mcp-rag/.test(base.out))
check('имя моста dsh-mcp-client', /name: '@deepseek-ai\/dsh-mcp-client'/.test(base.out))
check('транспорт stdio', /transport: stdio/.test(base.out))
check('команда python', /command: python/.test(base.out))
check('модуль MCP-сервера', /- 'doc_index\.mcp_server'/.test(base.out))
check('база передана как имя=путь', new RegExp(`- 'test-base=${indexDir.replace(/\\/g, '\\\\')}'`).test(base.out))
check('PYTHONPATH указывает на пакет', new RegExp(`PYTHONPATH: '${indexDir.replace(/\\/g, '\\\\')}'`).test(base.out))
check('настройки поиска из реестра', /- '0\.04'/.test(base.out) && /- 'structural'/.test(base.out))
check('база без токена: заголовков нет', !/Authorization/.test(base.out) && !/headers:/.test(base.out))

// 2. Инструкция в системном промпте: без неё инструмент есть, а привычки нет.
check('оверлей системного промпта', /- id: system-prompt/.test(base.out))
check('инструкция называет инструмент', /инструмент `rag_search`/.test(base.out))
check('инструкция перечисляет базу', /`test-base` — тестовая база/.test(base.out))
check('правило про источники', /ссылайся на заметку и строки/.test(base.out))
check('правило про «ответа нет»', /скажи об этом прямо/.test(base.out))

// 3. Неизвестная база: внятная ошибка и список доступных.
const unknown = run(['--rag', 'nope', '--mcp-check', 'rag', '--offline'],
  { DSH_TERM_RAG_FILE: goodRegistry })
check('неизвестная база → код 1', unknown.code === 1, `code=${unknown.code}`)
check('неизвестная база → сообщение и список', /неизвестная база знаний: nope/.test(unknown.out) && /test-base/.test(unknown.out))

// 4. База без `--rag`: проверять нечего, но подсказка должна быть.
const noRag = run(['--mcp-check', 'rag', '--offline'], { DSH_TERM_RAG_FILE: goodRegistry })
check('rag без --rag → код 1 и подсказка', noRag.code === 1 && /нужен --rag/.test(noRag.out), `code=${noRag.code}`)

// 5. Каталог базы не существует: ошибка до старта сессии, а не внутри рантайма.
const badDir = registryFile({ 'test-base': { title: 'нет каталога', index: join(repo, 'нет-такого-каталога') } })
const missing = run(['--rag', 'test-base', '--mcp-check', 'rag', '--offline'],
  { DSH_TERM_RAG_FILE: badDir })
check('нет каталога → код 1', missing.code === 1, `code=${missing.code}`)
check('нет каталога → подпись с путём', /каталог базы не найден/.test(missing.out))

// 6. Битый реестр и отсутствующий файл.
const brokenDir = mkdtempSync(join(tmpdir(), 'dsh-rag-broken-'))
const broken = join(brokenDir, 'rag.json')
writeFileSync(broken, '{ это не json', 'utf8')
const badJson = run(['--rag', 'test-base', '--mcp-check', 'rag', '--offline'],
  { DSH_TERM_RAG_FILE: broken })
check('битый реестр → код 1 и причина', badJson.code === 1 && /не читается/.test(badJson.out), `code=${badJson.code}`)
const noFile = run(['--rag', 'test-base', '--mcp-check', 'rag', '--offline'],
  { DSH_TERM_RAG_FILE: join(brokenDir, 'нет.json') })
check('нет реестра → код 1 и подсказка', noFile.code === 1 && /нет файла реестра/.test(noFile.out), `code=${noFile.code}`)

// 7. Несколько баз сразу: имена через запятую попадают в один сервер.
const two = registryFile({
  'base-a': { title: 'первая', index: indexDir },
  'base-b': { title: 'вторая', index: indexDir },
})
const multi = run(['--rag', 'base-a,base-b', '--mcp-check', 'rag', '--offline'],
  { DSH_TERM_RAG_FILE: two })
check('две базы: один сервер', (multi.out.match(/- id: mcp-rag/g) ?? []).length === 1)
check('две базы: оба --base в args', /base-a=/.test(multi.out) && /base-b=/.test(multi.out))
check('две базы: обе в инструкции', /`base-a`/.test(multi.out) && /`base-b`/.test(multi.out))

// 8. Флаги и команды видны в справке.
const help = run(['--help'])
check('--rag описан в справке', /--rag <имя>/.test(help.out))
check('команда /rag в списке команд', /\/rag \[list\]/.test(help.out))

let failed = 0
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` (${c.extra})`}`)
  if (!c.ok) failed += 1
}
if (failed) {
  console.error(`\n✖ провалено проверок: ${failed}`)
  console.error('--- вывод последнего прогона ---')
  console.error(multi.out.slice(0, 2000))
  process.exit(1)
}
console.log(`✔ RAG: базы подключаются сервером, инструкция уходит в промпт, ошибки внятные (${checks.length} проверок)`)
