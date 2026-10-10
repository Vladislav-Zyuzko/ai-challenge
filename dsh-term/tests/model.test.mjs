/**
 * Тест выбора модели и локальной LLM (day26): диагностика `--llm-check`,
 * секция settings.yaml с маршрутом pi-ai и слияние с чужими настройками.
 *
 * Сессия и модель не нужны: проверяется то, что dsh-term записывает в конфиг,
 * по которому харнесс поднимает маршрут на Ollama.
 *
 * Запуск: node dsh-term/tests/model.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
