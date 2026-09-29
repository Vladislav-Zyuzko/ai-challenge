/**
 * Тест MCP-обвязки dsh-term (day16): сборка оверлея для моста
 * `@deepseek-ai/dsh-mcp-client`, гигиена секретов и контракт флага `--mcp-check`.
 *
 * Сеть не нужна: проверяется режим `--mcp-check --offline` (печатает оверлей и
 * выходит) — то есть форма YAML и то, что токен в файл не попадает.
 *
 * Запуск: node dsh-term/tests/mcp.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')

/** Запустить dsh-term и вернуть stdout+stderr и код выхода. */
function run(args, env = {}) {
  const r = spawnSync(process.execPath, [dshTerm, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
}

const checks = []
const check = (name, ok, extra = '') => checks.push({ name, ok, extra })

// 1. Пресет github: оверлей собирается, режим урезанный, секрета в файле нет.
const gh = run(['--mcp-check', 'github', '--offline'])
check('exit code 0 для пресета github', gh.code === 0, `code=${gh.code}`)
check('insert-строка с id mcp-github', /- id: mcp-github/.test(gh.out))
check('имя моста dsh-mcp-client', /name: '@deepseek-ai\/dsh-mcp-client'/.test(gh.out))
check('транспорт streamable-http', /transport: streamable-http/.test(gh.out))
// Хвостовой слэш убирается: канонический вид адреса — `…/mcp`.
check('url официального сервера', /url: https:\/\/api\.githubcopilot\.com\/mcp$/m.test(gh.out))
check('токен только выражением !!js', /Authorization: !!js '`Bearer \$\{process\.env\.GITHUB_MCP_TOKEN\}`'/.test(gh.out))
check('секрета в оверлее нет', !/ghp_|github_pat_/.test(gh.out))
check('readonly включён по умолчанию', /'X-MCP-Readonly': 'true'/.test(gh.out))
check('тулсеты урезаны по умолчанию', /'X-MCP-Toolsets': 'context,repos,issues,pull_requests'/.test(gh.out))

// 2. Полный набор: read-write и все тулсеты — режим меняется, секрет так же скрыт.
const full = run(['--mcp-check', 'github', '--offline', '--mcp-toolsets', 'all', '--mcp-readwrite'])
check('--mcp-toolsets all убирает строку тулсетов', !/'X-MCP-Toolsets'/.test(full.out))
check('--mcp-readwrite убирает readonly', !/'X-MCP-Readonly'/.test(full.out))

// 3. Пресет sltracker: адрес берётся из окружения и нормализуется до `…/mcp`.
// Без нормализации адрес без пути уходит в catch-all Caddy и возвращает 404 вместо MCP —
// ровно этот дефект поймал живой прогон на боевом сервере.
const sltBase = run(['--mcp-check', 'sltracker', '--offline'], { SL_MCP_URL: 'https://mcp.example.com:8443' })
check('sltracker: адрес из SL_MCP_URL + /mcp', /url: https:\/\/mcp\.example\.com:8443\/mcp$/m.test(sltBase.out))
check('sltracker: без тулсетов и readonly-заголовков', !/'X-MCP-Toolsets'/.test(sltBase.out) && !/'X-MCP-Readonly'/.test(sltBase.out))
check('sltracker: токен только через !!js', /Authorization: !!js '`Bearer \$\{process\.env\.SL_MCP_TOKEN\}`'/.test(sltBase.out))
const sltFull = run(['--mcp-check', 'sltracker', '--offline'], { SL_MCP_URL: 'https://mcp.example.com:8443/mcp/' })
check('sltracker: уже готовый /mcp не удваивается', /url: https:\/\/mcp\.example\.com:8443\/mcp$/m.test(sltFull.out))

// 4. Пресет figma (day20): локальный stdio-сервер. Адреса и заголовков у него нет —
// в оверлей уходят команда и путь к скрипту, который харнесс запускает сам.
const fig = run(['--mcp-check', 'figma', '--offline'])
check('figma: exit code 0', fig.code === 0, `code=${fig.code}`)
check('figma: insert-строка mcp-figma', /- id: mcp-figma/.test(fig.out))
check('figma: транспорт stdio', /transport: stdio/.test(fig.out))
check('figma: команда запуска', /command: node/.test(fig.out))
check('figma: путь к mcp-server.js попал в args', /- '.*mcp-server\.js'/.test(fig.out))
check('figma: ни адреса, ни заголовков, ни токена', !/url:/.test(fig.out) && !/headers:/.test(fig.out) && !/Authorization/.test(fig.out))
const figEnv = run(['--mcp-check', 'figma', '--offline'], { SL_FIGMA_MCP_SCRIPT: 'C:\\tmp\\bridge.js' })
check('figma: путь переопределяется SL_FIGMA_MCP_SCRIPT', /- 'C:\\tmp\\bridge\.js'/.test(figEnv.out))
// Отсутствующий скрипт должен давать внятную ошибку, а не падение спавна.
const figMissing = run(['--mcp-check', 'figma'], { SL_FIGMA_MCP_SCRIPT: 'C:\\nope\\missing.js' })
check('figma: нет скрипта → код 1 и подсказка', figMissing.code === 1 && /не найден/.test(figMissing.out), `code=${figMissing.code}`)

// 5. Несколько серверов сразу (день 20): оба транспорта в одном оверлее.
const both = run(['--mcp-check', 'figma,sltracker', '--offline'])
check('два сервера в одном оверлее', /- id: mcp-figma/.test(both.out) && /- id: mcp-sltracker/.test(both.out))
check('в оверлее оба транспорта', /transport: stdio/.test(both.out) && /transport: streamable-http/.test(both.out))
const allPresets = run(['--mcp-check', 'all', '--offline'])
check('--mcp-check all перечисляет все пресеты', /mcp-check github, sltracker, figma/.test(allPresets.out), allPresets.out.slice(0, 120))

// 4. Неизвестный пресет: внятная ошибка, ненулевой код.
const bad = run(['--mcp-check', 'nope', '--offline'])
check('неизвестный пресет → код 1', bad.code === 1, `code=${bad.code}`)
check('неизвестный пресет → сообщение и список', /неизвестный MCP-пресет: nope/.test(bad.out) && /github/.test(bad.out))

// 4. Без MCP оверлей не собирается: в справке флаг есть, сессия по умолчанию чистая.
const help = run(['--help'])
check('флаги MCP описаны в справке', /--mcp <preset>/.test(help.out) && /--mcp-check/.test(help.out))
check('скилл task-from-figma в списке команд', /\/task-from-figma/.test(help.out))

// 6. Разбор ссылки Figma (скилл /task-from-figma): node-id приходит из ссылки в трёх
// видах — двоеточие, %3A и дефис, — а имя файла слепка всегда через дефис.
const n1 = run(['--figma-node', 'https://www.figma.com/design/AbC/VKR?node-id=1143%3A5786&t=zz'])
check('--figma-node: %3A → дефис', n1.code === 0 && /node-id: 1143-5786/.test(n1.out), n1.out.trim())
const n2 = run(['--figma-node', 'https://figma.com/file/AbC/VKR?node-id=1:23'])
check('--figma-node: двоеточие → дефис', /node-id: 1-23/.test(n2.out), n2.out.trim())
const n3 = run(['--figma-node', 'https://figma.com/file/AbC/VKR?node-id=1-23'])
check('--figma-node: дефис остаётся', /node-id: 1-23/.test(n3.out), n3.out.trim())
const n4 = run(['--figma-node', 'MOBILE нужен экран настроек, ссылки нет'])
check('--figma-node: без ссылки → код 1', n4.code === 1, `code=${n4.code}`)

let bad_ = 0
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` (${c.extra})`}`)
  if (!c.ok) bad_ += 1
}
if (bad_) {
  console.error(`\n✖ провалено проверок: ${bad_}`)
  console.error('--- вывод последнего прогона ---')
  console.error(gh.out.slice(0, 2000))
  process.exit(1)
}
console.log(`✔ MCP: оверлей собирается, секрет не попадает в файл, режимы переключаются (${checks.length} проверок)`)
