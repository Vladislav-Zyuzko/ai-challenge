/**
 * Тест выбора модели и локальной LLM (day26): диагностика `--llm-check`,
 * секция settings.yaml с маршрутом pi-ai и слияние с чужими настройками.
 *
 * Сессия и модель не нужны: проверяется то, что dsh-term записывает в конфиг,
 * по которому харнесс поднимает маршрут на Ollama.
 *
 * Запуск: node dsh-term/tests/model.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dshTerm = join(here, '..', 'dsh-term.mjs')

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [dshTerm, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
}

/**
 * Асинхронный запуск нужен там, где рядом живёт заглушечный сервер.
 * `spawnSync` блокирует цикл событий процесса-теста, и сервер физически не может
 * ответить: запрос истекает по таймауту, и тест «доказывает» несуществующую поломку.
 */
function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dshTerm, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    child.on('close', (code) => resolve({ out, code }))
    child.stdin.end()
  })
}

/** Поднять заглушку на свободном порту и вернуть её адрес. */
function serve(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => server.close(),
    }))
  })
}

const home = mkdtempSync(join(tmpdir(), 'dsh-llm-'))
const checks = []
const check = (name, ok, extra = '') => checks.push({ name, ok, extra })

// 1. Диагностика: маршрут локальной модели и список моделей Ollama.
const info = run(['--llm-check', '--dsh-home', home])
check('--llm-check: код 0', info.code === 0, `code=${info.code}`)
check('маршрут на Ollama', /baseURL: http:\/\/127\.0\.0\.1:11434\/v1/.test(info.out))
check('провайдер local объявлен', /providers:\s*\n\s*local:/.test(info.out))
check('протокол openai-completions', /api: openai-completions/.test(info.out))
check('ключ берётся из env, не из файла', /apiKeyEnv: OLLAMA_API_KEY/.test(info.out))
check('контекст задан явно (иначе RAG обрежется)', /contextWindow: 32768/.test(info.out))
check('живая модель Ollama попала в список', /qwen3:8b/.test(info.out))

// 2. Файл настроек: секция записана и ограничена маркерами.
const settingsPath = join(home, 'settings.yaml')
check('settings.yaml создан', existsSync(settingsPath))
const text = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
check('секция llm-pi-ai в файле', /^llm-pi-ai:/m.test(text))
check('маркеры начала и конца', text.includes('>>> dsh-term') && text.includes('<<< dsh-term'))

// 3. Слияние: чужие настройки пользователя не теряются.
const foreign = join(tmpdir(), `dsh-llm-foreign-${Date.now()}`)
const foreignFile = join(foreign, 'settings.yaml')
mkdirSync(foreign, { recursive: true })
writeFileSync(foreignFile, 'llm-deepseek:\n  providers:\n    deepseek-official:\n      baseURL: https://api.deepseek.com\n', 'utf8')
const merged = run(['--llm-check', '--dsh-home', foreign])
const mergedText = readFileSync(foreignFile, 'utf8')
check('чужая секция сохранена', mergedText.includes('llm-deepseek:'))
check('наша секция добавлена рядом', mergedText.includes('llm-pi-ai:'))
check('слияние без ошибок', merged.code === 0, `code=${merged.code}`)

// 4. Повторный запуск не дублирует секцию.
run(['--llm-check', '--dsh-home', foreign])
const twice = readFileSync(foreignFile, 'utf8')
check('секция не дублируется', (twice.match(/^llm-pi-ai:/gm) ?? []).length === 1,
  `вхождений: ${(twice.match(/^llm-pi-ai:/gm) ?? []).length}`)

// 5. Ollama недоступна: не падаем, предупреждаем и оставляем модель по умолчанию.
const dead = mkdtempSync(join(tmpdir(), 'dsh-llm-dead-'))
const deadRun = run(['--llm-check', '--dsh-home', dead, '--ollama-url', 'http://127.0.0.1:1'])
check('недоступная Ollama: код 0', deadRun.code === 0, `code=${deadRun.code}`)
check('недоступная Ollama: предупреждение', /Ollama не отвечает/.test(deadRun.out))
const deadText = readFileSync(join(dead, 'settings.yaml'), 'utf8')
check('недоступная Ollama: модель по умолчанию', /id: 'qwen3:8b'/.test(deadText))

// 6. Диагностика и команда видны в справке.
const help = run(['--help'])
check('--llm-check в справке', /--llm-check/.test(help.out))
check('команда /model в справке', /\/model \[имя\|show\]/.test(help.out))
check('--provider упоминает local', /--provider <id>.*local/.test(help.out))

// 7. Сервисный слой (день 30): адрес без /api/tags, но с /v1/models и ключом.
// Проверяется то, ради чего модель выносят за сервис: маршрут обязан указывать
// на сервис, а список моделей — приходить из его OpenAI-совместимого ответа.
const service = await serve((req, res) => {
  const authorized = req.headers.authorization === 'Bearer sk-service'
  if (req.url === '/api/tags') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"not found"}')
    return
  }
  if (req.url === '/v1/models') {
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":"no key"}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'rag-brief' }, { id: 'qwen3-8b' }, { id: 'bge-m3:latest' }] }))
    return
  }
  res.writeHead(404)
  res.end('{}')
})
const serviceHome = mkdtempSync(join(tmpdir(), 'dsh-llm-service-'))
const serviceRun = await runAsync(['--llm-check', '--dsh-home', serviceHome, '--ollama-url', service.url],
  { OLLAMA_API_KEY: 'sk-service' })
service.close()

check('сервис: код 0', serviceRun.code === 0, `code=${serviceRun.code}`)
check('сервис: модели из /v1/models', /rag-brief/.test(serviceRun.out) && /qwen3-8b/.test(serviceRun.out),
  serviceRun.out.split('\n').find((l) => l.includes('локальные модели')) ?? serviceRun.out.slice(0, 200))
check('сервис: эмбеддинги в списке чата не нужны', !/bge-m3/.test(serviceRun.out))
{
  const serviceText = readFileSync(join(serviceHome, 'settings.yaml'), 'utf8')
  check('сервис: маршрут указывает на сервис', serviceText.includes(`baseURL: ${service.url}/v1`),
    serviceText.split('\n').find((l) => l.includes('baseURL')) ?? '')
}

// 8. Без ключа сервис моделей не отдаёт — значит и список пустой, но не падение.
const noKeyHome = mkdtempSync(join(tmpdir(), 'dsh-llm-nokey-'))
const gate = await serve((req, res) => {
  res.writeHead(req.url === '/v1/models' ? 401 : 404, { 'Content-Type': 'application/json' })
  res.end('{"error":"no key"}')
})
const noKeyRun = await runAsync(['--llm-check', '--dsh-home', noKeyHome, '--ollama-url', gate.url],
  { OLLAMA_API_KEY: 'неверный' })
gate.close()
check('без ключа: код 0', noKeyRun.code === 0, `code=${noKeyRun.code}`)
check('без ключа: модель по умолчанию остаётся', /id: 'qwen3:8b'/.test(readFileSync(join(noKeyHome, 'settings.yaml'), 'utf8')))

let failed = 0
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` (${c.extra})`}`)
  if (!c.ok) failed += 1
}
if (failed) {
  console.error(`\n✖ провалено проверок: ${failed}`)
  console.error('--- вывод llm-check ---')
  console.error(info.out.slice(0, 1500))
  process.exit(1)
}
console.log(`✔ локальная модель: маршрут pi-ai пишется в settings.yaml, /model в списке команд (${checks.length} проверок)`)
