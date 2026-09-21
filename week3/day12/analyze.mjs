/**
 * Разбор прогонов day12: как профиль пользователя меняет ответ, если вопросы одни
 * и те же. Персонализация живёт в system prompt (personaPrefix), поэтому весь
 * эффект виден в тексте ответа и в расходе токенов на выход.
 *
 *   node week2/day12/analyze.mjs        # таблицы в консоль
 *   node week2/day12/analyze.mjs --md   # + markdown-блок для отчёта
 *
 * Читает runs/<вариант>-q<N>.txt, который пишет run.ps1 (stdout = ответ,
 * блок «# ===== stderr (метрики) =====» = диагностика dsh-term).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const runsDir = join(here, 'runs')
const wantMd = process.argv.includes('--md')

const VARIANTS = ['none', 'kratko', 'podrobno', 'tolko-kod']
const QUESTIONS = [
  'Q1 JSON-файл: чтение и обработка ошибки',
  'Q2 отдельная ветка git под правку в одну строку',
  'Q3 forEach + async: что не так',
]

const K = (s) => {
  if (s === undefined) return 0
  const m = /^([\d.]+)(k?)$/.exec(String(s))
  if (!m) return 0
  return Math.round(Number(m[1]) * (m[2] === 'k' ? 1000 : 1))
}

/** Разбор одного прогона: ответ + метрики процесса + статистика текста. */
function parseRun(name, text) {
  const [stdoutRaw, stderrRaw = ''] = text.split('# ===== stderr (метрики) =====')
  const answer = stdoutRaw.replace(/\r/g, '').trim()
  const prof = /profile: «(.+?)» \((\S+)\)/.exec(stderrRaw)
  const noProfile = /profile: не выбран/.test(stderrRaw)
  const tok = /tokens: in ([\d.]+k?) \(cache ([\d.]+k?)\) \/ out ([\d.]+k?)/.exec(stderrRaw)
  const ctx = /context: ([\d.]+k?) \//.exec(stderrRaw)

  // Код считаем по блокам ``` … ``` в ответе.
  const blocks = [...answer.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const codeChars = blocks.reduce((s, b) => s + b.length, 0)
  const codeLines = blocks.reduce((s, b) => s + b.trim().split('\n').length, 0)
  const prose = answer.replace(/```[\s\S]*?```/g, '')
  const proseChars = prose.replace(/\s+/g, ' ').trim().length
  const proseLines = prose.split('\n').filter((l) => l.trim()).length
  const lines = answer.split('\n').filter((l) => l.trim())

  return {
    name,
    variant: name.replace(/-q\d+$/, ''),
    question: Number(/-q(\d+)$/.exec(name)?.[1] ?? 0),
    answer,
    title: prof?.[1] ?? (noProfile ? 'без профиля' : '—'),
    slug: prof?.[2] ?? '—',
    profileTokens: prof ? Number(/~(\d+) токенов/.exec(stderrRaw)?.[1] ?? 0) : 0,
    inTokens: K(tok?.[1]),
    cacheTokens: K(tok?.[2]),
    outTokens: K(tok?.[3]),
    ctxTokens: K(ctx?.[1]),
    chars: answer.length,
    proseChars,
    proseLines,
    lines: lines.length,
    codeBlocks: blocks.length,
    codeLines,
    codeShare: answer.length ? Math.round((codeChars / answer.length) * 100) : 0,
    // Заголовки и списки считаем только ВНЕ блоков кода: строки-комментарии вида
    // «# Short answer: …» внутри ``` — это не markdown-структура ответа.
    headings: (prose.match(/^#{1,6} /gm) ?? []).length,
    bullets: (prose.match(/^\s*[-*] /gm) ?? []).length,
    summary: /(^|\n)\s*(#+\s*)?(итого|вывод|резюме|в итоге)/i.test(prose),
    emoji: (answer.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []).length,
    intro: /^(отличн|конечно|разумеется|хорош|давай|давайте)/i.test(answer),
  }
}

const runs = readdirSync(runsDir)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => parseRun(f.replace(/\.txt$/, ''), readFileSync(join(runsDir, f), 'utf8')))

const byVariant = new Map(VARIANTS.map((v) => [v, runs.filter((r) => r.variant === v)]))
const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)

console.log('\n=== Профиль → ответ: средние по трём вопросам ===')
console.log(`${pad('вариант', 11)}${num('ответ, симв', 13)}${num('строк', 7)}${num('код, %', 8)}${num('заголовки', 11)}${num('списки', 8)}${num('in-токены', 11)}${num('out-токены', 12)}${pad('  профиль ~токенов', 20)}`)
for (const v of VARIANTS) {
  const rs = byVariant.get(v) ?? []
  if (!rs.length) continue
  console.log(
    pad(v, 11)
    + num(avg(rs.map((r) => r.chars)), 13)
    + num(avg(rs.map((r) => r.lines)), 7)
    + num(avg(rs.map((r) => r.codeShare)), 8)
    + num(avg(rs.map((r) => r.headings)), 11)
    + num(avg(rs.map((r) => r.bullets)), 8)
    + num(avg(rs.map((r) => r.inTokens)), 11)
    + num(avg(rs.map((r) => r.outTokens)), 12)
    + pad(`  ${rs[0].profileTokens || '—'}`, 20),
  )
}

console.log('\n=== По вопросам (символов в ответе / out-токены) ===')
for (let q = 1; q <= QUESTIONS.length; q++) {
  console.log(`\n--- ${QUESTIONS[q - 1]}`)
  for (const v of VARIANTS) {
    const r = (byVariant.get(v) ?? []).find((x) => x.question === q)
    if (!r) continue
    console.log(`  ${pad(v, 11)} ${num(r.chars, 6)} симв · ${num(r.outTokens, 5)} out · код ${num(r.codeShare, 3)}% · строк ${num(r.lines, 3)}`
      + `${r.summary ? ' · есть резюме' : ''}${r.bullets ? ` · списков ${r.bullets}` : ''}${r.headings ? ` · заголовков ${r.headings}` : ''}`)
  }
}

/**
 * Автопроверка: сработали ли правила профиля. Пороги взяты из самих профилей
 * (см. profiles/*.md), а не подогнаны под результат:
 *   kratko     — «максимум 5 строк обычного текста», без резюме и вступлений;
 *   podrobno   — структура (разбор по пунктам) и/или раздел «Итого»;
 *   tolko-kod  — либо почти всё код, либо (если текста не избежать) одна строка.
 */
const RULES = {
  kratko: (r) => !r.summary && !r.intro && r.proseLines <= 6,
  podrobno: (r) => r.summary || r.bullets >= 3 || r.chars >= 900,
  'tolko-kod': (r) => (r.codeShare >= 55 && r.headings === 0 && r.bullets === 0)
    || (r.proseLines <= 2 && r.proseChars <= 250 && r.headings === 0),
}
console.log('\n=== Правила профиля применились автоматически (без упоминания профиля в вопросе) ===')
for (const v of Object.keys(RULES)) {
  const rs = (byVariant.get(v) ?? []).filter((r) => r.question)
  const hits = rs.filter(RULES[v])
  console.log(`${pad(v, 11)} ${hits.length} из ${rs.length} ответов: ${rs.map((r) => `Q${r.question}${RULES[v](r) ? '✔' : '✖'}`).join(' ')}`)
}

if (wantMd) {
  console.log('\n=== markdown ===')
  console.log('| Профиль | Ответ, символов | Код, % | in-токены | out-токены | Резюме | Профиль в промпте, токенов | Правила сработали |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const v of VARIANTS) {
    const rs = byVariant.get(v) ?? []
    if (!rs.length) continue
    const label = v === 'none' ? 'без профиля' : `${v} — ${rs[0].title}`
    const ok = RULES[v] ? `${rs.filter(RULES[v]).length} из ${rs.length}` : '—'
    console.log(`| ${label} | ${avg(rs.map((r) => r.chars))} | ${avg(rs.map((r) => r.codeShare))} | ${avg(rs.map((r) => r.inTokens))} | ${avg(rs.map((r) => r.outTokens))} | ${rs.filter((r) => r.summary).length} из ${rs.length} | ${rs[0].profileTokens || '—'} | ${ok} |`)
  }
}
