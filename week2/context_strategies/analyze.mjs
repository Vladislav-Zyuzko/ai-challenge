/**
 * Разбор прогонов day10: расход токенов, размер контекста и контроль знаний.
 *
 *   node week2/context_strategies/analyze.mjs            # таблицы в консоль
 *   node week2/context_strategies/analyze.mjs --md       # + markdown-блок для отчёта
 *
 * Читает runs/<плечо>.txt (stdout + блок stderr с метриками), который пишет run.ps1.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runsDir = join(here, 'runs')
const wantMd = process.argv.includes('--md')

/** Контрольные факты сценария: что должно сохраниться к концу диалога. */
const CHECKS = [
  { key: 'код KX-42', re: /KX-?\s?42/i },
  { key: 'бюджет 2.4 млн', re: /2[.,]4\s*млн/i },
  { key: 'дедлайн 30 апреля', re: /30\s+апреля/i },
  { key: 'оплата ЮKassa', re: /ю\s?kassa|юкасса/i },
  { key: 'интеграция 1С', re: /1\s?с(?![а-яa-z])/i },
  { key: 'интеграция СДЭК', re: /сдэк/i },
]
const REFUSAL = /не указан|не назван|не задан|не зафиксирован|выдумывать не буду|нет в (доступной|предоставленном)/i

const K = (s) => {
  if (s === undefined) return 0
  const m = /^([\d.]+)(k?)$/.exec(String(s))
  if (!m) return 0
  // «7.5k» → 7500, «4» → 4: в метриках единицы смешанные, суффикс обязателен.
  return Math.round(Number(m[1]) * (m[2] === 'k' ? 1000 : 1))
}

/** Разбор одного прогона. Метрики в REPL идут в stdout, поэтому ищем по всему файлу. */
function parseArm(name, text) {
  const stdout = text.split('# ===== stderr (метрики) =====')[0]
  const ctxTokens = [...stdout.matchAll(/· контекст \[(.*?)\]: (\d+) сообщений(?:\s*\+\s*(\d+) facts)?,\s*(\d+) токенов/g)]
    .map((m) => ({ label: m[1], messages: Number(m[2]), facts: Number(m[3] ?? 0), tokens: Number(m[4]) }))
  const cumIn = [...text.matchAll(/tokens: in ([\d.]+k?) \(cache ([\d.]+k?)\) \/ out ([\d.]+k?)/g)]
    .map((m) => ({ in: K(m[1]), cache: K(m[2]), out: K(m[3]) }))
  // Строка «strategy: N facts updates, X tokens» печатается ПО ХОДУ (сколько
  // потратил этот ход) — суммируем по всем ходам.
  const factsMatches = [...text.matchAll(/strategy: (\d+) facts updates?, ([\d.]+k?) tokens/g)]
  const factsTotal = factsMatches.length
    ? {
        calls: factsMatches.reduce((s, m) => s + Number(m[1]), 0),
        tokens: factsMatches.reduce((s, m) => s + K(m[2]), 0),
      }
    : { calls: 0, tokens: 0 }
  // Ответы: строки между '(queued …)' и разделителем хода.
  const lines = stdout.split('\n')
  const answers = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\(queued/.test(lines[i])) continue
    const buf = []
    for (let j = i + 1; j < lines.length && !/^[─—]/.test(lines[j]) && !/^\(queued/.test(lines[j]); j++) {
      if (lines[j].trim()) buf.push(lines[j].trim())
    }
    answers.push(buf.join('\n'))
  }
  const perTurnIn = cumIn.map((c, i) => (i === 0 ? c.in : c.in - cumIn[i - 1].in))
  // Сравниваем первые 14 ходов: в branch-плече дальше идёт расходящийся хвост
  // ветки B и возврат в A — их в общий зачёт не берём.
  const N = 14
  const perTurn12 = perTurnIn.slice(0, N)
  return {
    name,
    ctxTokens,
    cumIn,
    perTurnIn,
    factsTotal,
    answers,
    factsServiceTokens: factsTotal.tokens,
    totalIn: perTurn12.reduce((s, x) => s + x, 0),
    totalOut: cumIn.slice(0, N).reduce((s, c, i) => s + (i === 0 ? c.out : c.out - cumIn[i - 1].out), 0),
    totalCache: cumIn.length ? cumIn[Math.min(N, cumIn.length) - 1].cache : 0,
    turns: perTurnIn.length,
  }
}

/** Контроль: ходы 12-14 сценария (последние три вопроса) — во всех плечах. */
const CONTROL_TURNS = [11, 12, 13]
function verdicts(arm) {
  const tail = CONTROL_TURNS.map((i) => arm.answers[i]).filter((x) => x !== undefined)
  return CHECKS.map((c) => {
    const hit = tail.some((a) => c.re.test(a))
    const refused = tail.some((a) => REFUSAL.test(a))
    return { ...c, ok: hit, refused, strength: hit ? 'есть' : refused ? 'потерян (честно сказал)' : 'потерян' }
  })
}

const arms = readdirSync(runsDir)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => parseArm(f.replace(/\.txt$/, ''), readFileSync(join(runsDir, f), 'utf8')))
  .sort((a, b) => a.totalIn - b.totalIn)

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)

console.log('\n=== Расход токенов (за 14 сообщений сценария, плечо branch — ветка A) ===')
console.log(`${pad('плечо', 10)}${num('вход', 10)}${num('кэш', 9)}${num('выход', 8)}${num('ctx/ход', 10)}${num('facts-вызовы', 13)}${num('facts-токены', 13)}`)
for (const a of arms) {
  const ctxAvg = a.ctxTokens.length ? Math.round(a.ctxTokens.reduce((s, c) => s + c.tokens, 0) / a.ctxTokens.length) : 0
  console.log(`${pad(a.name, 10)}${num(a.totalIn, 10)}${num(a.totalCache, 9)}${num(a.totalOut, 8)}${num(ctxAvg, 10)}${num(a.factsTotal.calls, 13)}${num(a.factsServiceTokens, 13)}`)
}

console.log('\n=== Размер контекста, который клиент отправлял в модель (токенов) ===')
for (const a of arms) {
  const list = a.ctxTokens.map((c) => c.tokens)
  const uniq = [...new Set(list)]
  console.log(`${pad(a.name, 10)} старт ${num(list[0] ?? 0, 4)} → до ${num(Math.max(...list, 0), 4)} токенов; рост: ${uniq.length > 6 ? `${uniq.slice(0, 3).join(', ')} … ${uniq.slice(-3).join(', ')}` : uniq.join(', ')}`)
}

console.log('\n=== Контроль знаний (детали из первых сообщений) ===')
for (const a of arms) {
  const v = verdicts(a)
  console.log(`${pad(a.name, 10)} ${v.map((x) => `${x.ok ? '✔' : '✖'} ${x.key}`).join(' | ')}`)
}

console.log('\n=== Ответы на контрольные вопросы ===')
for (const a of arms) {
  console.log(`\n--- ${a.name}`)
  a.answers.slice(-3).forEach((x, i) => console.log(`  Q${i + 1}: ${x.replace(/\n/g, ' ').slice(0, 300)}`))
}

if (wantMd) {
  console.log('\n=== markdown ===')
  console.log('| Плечо | Вход, токенов | Кэш | Выход | Контекст/ход | facts-вызовы | facts-токены | Ранние детали |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const a of arms) {
    const ctxAvg = a.ctxTokens.length ? Math.round(a.ctxTokens.reduce((s, c) => s + c.tokens, 0) / a.ctxTokens.length) : 0
    const v = verdicts(a)
    const kept = v.filter((x) => x.ok).length
    console.log(`| ${a.name} | ${a.totalIn} | ${a.totalCache} | ${a.totalOut} | ${ctxAvg} | ${a.factsTotal.calls} | ${a.factsServiceTokens} | ${kept} из ${v.length} |`)
  }
}
