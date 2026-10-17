/**
 * Живой прогон режима поддержки (день 33): сценарии обращений на настоящей модели.
 *
 * Не входит в зелёный набор `*.test.mjs`: нужна модель (облачная или локальная),
 * поэтому запускается руками и пишет сырые ответы в `.dsh-scratch/support-eval/`.
 *
 *   node dsh-term/tests/eval-support.mjs            # все сценарии
 *   node dsh-term/tests/eval-support.mjs s-03 s-07  # выборочно
 *   SL_MCP_TOKEN=… node dsh-term/tests/eval-support.mjs s-09   # с трекером
 *
 * Проверки в сценарии — это не «правильный текст», а обязательные признаки ответа:
 * наличие источника из FAQ, цитаты из переписки, отсутствие выдумок. Формулировки
 * модель выбирает сама — именно это и проверяется живьём.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const dshTerm = join(here, '..', 'dsh-term.mjs')
const outDir = join(repo, '.dsh-scratch', 'support-eval')

const scenarios = [
  {
    id: 's-01',
    title: 'T-1042 · вопрос «почему не работает авторизация» — FAQ + переписка',
    ticket: 'T-1042',
    prompt: 'Почему не работает авторизация? Вчера всё работало, а сегодня dsh-term не запускается.',
    expect: [
      [/источник|support\/faq\//i, 'ссылка на заметку FAQ'],
      [/строки?\s*\d+[–-]\d+|строки?\s*\d+/i, 'номера строк в источнике'],
      [/4000/, 'адрес из переписки (4000)'],
      [/DSH_TERM_OLLAMA|переменн\w+ окружени/i, 'причина: переменная окружения'],
      [/это не авторизаци|не (проблема |ошибка )?авторизаци|ключ\w* [^.]{0,40}(ни при чём|не при чём|не относится)/i, 'снят ложный диагноз «авторизация»'],
      [/qwen3:8b/, 'модель из обращения названа'],
    ],
  },
  {
    id: 's-02',
    title: 'T-1051 · 429 и «второе окно сразу получает отказ» — лимиты сервиса',
    ticket: 'T-1051',
    prompt: 'Почему сыплется 429 «Deployment has all max_parallel_requests slots in use»? У меня же локальная модель, какие лимиты? И почему второе окно получает отказ сразу, даже не подождав?',
    expect: [
      [/max_parallel_requests/, 'назван параметр сервиса'],
      [/источник|support\/faq\//i, 'ссылка на заметку FAQ'],
      [/очеред|параллельн|одновремен/i, 'объяснена причина — параллельные запросы'],
      [/не (сломал|поломк|баг)|ожидаемо|это не ошибка|не поломка/i, 'сказано, что это не поломка'],
    ],
  },
  {
    id: 's-03',
    title: 'T-1058 · «/help отвечает не про мой вопрос, источники 0/0»',
    ticket: 'T-1058',
    prompt: 'Спрашиваю /help как настроить профиль пользователя — получаю ответ про документацию проекта, но в конце «источники 0/0». Как понять, что /help вообще отвечает?',
    expect: [
      [/0\/0/, 'разобран признак «источники 0/0»'],
      [/\/help/, '/help назван'],
      [/источник|support\/faq\//i, 'ссылка на заметку FAQ'],
      [/rag-brief|контекст проекта|документац/i, 'объяснено, чем /help отличается'],
    ],
  },
  {
    id: 's-04',
    title: 'T-1063 · инструменты MCP не появляются (версия 0.9.2)',
    ticket: 'T-1063',
    prompt: 'Запускаю dsh-term --mcp github, а инструментов в сессии не вижу. Токен ставлю через gh auth. Может, дело в старом релизе?',
    expect: [
      [/0\.9\.2/, 'версия из карточки пользователя использована'],
      [/mcp-check|--mcp\b/, 'предложена диагностика MCP'],
      [/источник|support\/faq\//i, 'ссылка на заметку FAQ'],
      [/мария|лебедева/i, 'обращение к пользователю по данным карточки'],
    ],
  },
  {
    id: 's-05',
    title: 'T-1077 · /publish-day упал после открытия PR — как повторить ревью',
    ticket: 'T-1077',
    prompt: 'Команда /publish-day дошла до «PR: https://github.com/...» и упала с сообщением про ревью. PR открыт, а ревью нет. Можно повторить только ревью, не создавая второй PR?',
    expect: [
      [/review-pr/, 'предложена /review-pr'],
      [/источник|support\/faq\//i, 'ссылка на заметку FAQ'],
      [/второ[йг]о PR|новый PR|заново PR/i, 'учтено «не создавать второй PR»'],
    ],
  },
  {
    id: 's-06',
    title: 'T-1042 · вопрос вне темы поддержки (отказ)',
    ticket: 'T-1042',
    prompt: 'Слушай, а сколько сейчас стоит iPhone 17 в Дубае? И заодно посоветуй отель.',
    expect: [
      [/поддержк|dsh-term|обращени/i, 'возврат к теме поддержки'],
      [/!не могу|не подскажу|не помогу|вне (моей )?тем|это не про dsh-term|не по теме/i, 'вежливый отказ'],
    ],
    reject: [
      [/источник:\s*support\/faq/i, 'не подставил источник FAQ под вопрос не по теме'],
    ],
  },
  {
    id: 's-07',
    title: 'T-1042 · данных нет ни в FAQ, ни в обращении — честное «не знаю»',
    ticket: 'T-1042',
    prompt: 'У меня в логе появился код ошибки X-77 при вложении файла. Что это значит и как исправить?',
    expect: [
      [/в базе и в обращении этого нет|в (faq|базе)[^.]{0,60}нет|данных (для разбора )?нет|не (нашл|нашла|нашёл)[аи]? в (faq|базе)/i, 'сказано, что данных нет'],
      [/уточн|пришли|пришлите|приложи|дай(те)? (лог|вывод)|какие данные|нужн\w+[^.]{0,50}(лог|фрагмент|данн)/i, 'запрошены недостающие данные'],
    ],
    reject: [
      [/X-77[^.]{0,80}означает/i, 'не выдумал расшифровку кода'],
    ],
  },
  {
    id: 's-08',
    title: 'T-1042 · вопрос про самого пользователя — факты из карточки',
    ticket: 'T-1042',
    prompt: 'Напомни, какая у меня версия dsh-term, на какой ОС я работаю и с какого месяца я с вами?',
    expect: [
      [/0\.9\.4/, 'версия из карточки'],
      [/Windows 11/i, 'ОС из карточки'],
      [/март|03\.2026|2026-03/i, 'дата регистрации из карточки'],
    ],
  },
  {
    id: 's-09',
    title: 'T-1070 (закрытое) · «локальная модель отвечает минуту» — решение из архива',
    ticket: 'T-1070',
    prompt: 'Спросил у локальной модели одно предложение — ждал почти минуту. Это нормально?',
    expect: [
      [/CPU|процессор|без дискретн/i, 'названа причина: CPU'],
      [/токен/i, 'объяснение через токены'],
      [/источник|support\/faq\//i, 'ссылка на заметку FAQ'],
    ],
  },
  {
    id: 's-10',
    title: 'T-1042 · трекер: задача в INFRA создаётся инструментом (нужен SL_MCP_TOKEN)',
    ticket: 'T-1042',
    prompt: 'Почему не работает авторизация? Вчера всё работало, а сегодня dsh-term не запускается.',
    tracker: true,
    expect: [
      [/Задача в разработку:\s*INFRA-\d+/, 'в ответе номер созданной задачи'],
      [/источник|support\/faq\//i, 'ссылка на заметку FAQ'],
    ],
  },
  {
    id: 's-11',
    title: 'T-1051 · трекер: вторая задача в INFRA из другого обращения',
    ticket: 'T-1051',
    prompt: 'Почему сыплется 429 «Deployment has all max_parallel_requests slots in use»? У меня же локальная модель, какие лимиты?',
    tracker: true,
    expect: [
      [/Задача в разработку:\s*INFRA-\d+/, 'в ответе номер созданной задачи'],
      [/max_parallel_requests/, 'назван параметр сервиса'],
    ],
  },
]

const only = process.argv.slice(2)
const picked = only.length ? scenarios.filter((s) => only.includes(s.id)) : scenarios

mkdirSync(outDir, { recursive: true })
const results = []

for (const s of picked) {
  const env = { ...process.env, DSH_TERM_COLOR: 'never' }
  if (!s.tracker) delete env.SL_MCP_TOKEN
  if (s.tracker && !String(env.SL_MCP_TOKEN ?? '').trim()) {
    console.log(`— ${s.id}: пропущен, нет SL_MCP_TOKEN`)
    results.push({ id: s.id, skipped: true })
    continue
  }
  const startedAt = Date.now()
  const r = spawnSync(process.execPath, [dshTerm, '--support', s.ticket, '-p', s.prompt], {
    encoding: 'utf8', cwd: repo, env, timeout: 600000,
    maxBuffer: 40 * 1024 * 1024,
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const secs = Math.round((Date.now() - startedAt) / 1000)
  writeFileSync(join(outDir, `${s.id}.txt`), out, 'utf8')

  const tools = {
    rag: (out.match(/⛭ rag\/rag_search/g) ?? []).length,
    ticket: (out.match(/⛭ support\/support_/g) ?? []).length,
    task: (out.match(/⛭ sltracker\/create_task/g) ?? []).length,
  }
  const matched = (s.expect ?? []).filter(([re]) => re.test(out)).length
  const rejected = (s.reject ?? []).filter(([re]) => re.test(out)).map(([, name]) => name)
  const ok = r.status === 0 && matched === (s.expect ?? []).length && rejected.length === 0
  results.push({ id: s.id, title: s.title, ok, secs, tools, matched,
    total: (s.expect ?? []).length, rejected, code: r.status })
  console.log(`${ok ? '✔' : '✖'} ${s.id} · ${matched}/${(s.expect ?? []).length} признаков`
    + ` · rag=${tools.rag} ticket=${tools.ticket} task=${tools.task}`
    + ` · ${secs} с${r.status !== 0 ? ` · код ${r.status}` : ''}`)
  if (!ok) {
    for (const [re, name] of (s.expect ?? [])) {
      if (!re.test(out)) console.log(`    не найдено: ${name} (${re})`)
    }
    for (const name of rejected) console.log(`    лишнее: ${name}`)
  }
}

const failed = results.filter((r) => r.ok === false)
const skipped = results.filter((r) => r.skipped)
console.log(`\nитого: ${results.length - skipped.length - failed.length}/${results.length - skipped.length}`
  + (skipped.length ? ` · пропущено ${skipped.length}` : '')
  + ` · сырые ответы: ${outDir}`)
writeFileSync(join(outDir, '_summary.json'), JSON.stringify(results, null, 2), 'utf8')
process.exit(failed.length ? 1 : 0)
