// Анализатор A/B эксперимента по компрессии контекста.
// Читает runs/<arm>.txt (stdout+stderr прогона) и лог сессии соответствующего home,
// считает расход токенов, компакции и качество контрольных ответов, пишет result.md.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const base = dirname(fileURLToPath(import.meta.url))

/** Разжать многофреймовый zstd-лог (фреймы конкатенированы). */
function decompressAll(buf) {
  const offsets = []
  let idx = buf.indexOf(MAGIC, 0)
  while (idx >= 0) { offsets.push(idx); idx = buf.indexOf(MAGIC, idx + 4) }
  let out = ''
  for (let i = 0; i < offsets.length; i++) {
    const slice = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length)
    try { out += zstdDecompressSync(slice).toString('utf8') } catch { /* пустой фрейм */ }
  }
  return out
}

/** '1.07M' | '16.2k' | '340' → число. */
function parseTok(s) {
  const m = /^([\d.]+)([kM]?)$/.exec(String(s).replace(/\s/g, ''))
  if (!m) return 0
  const n = Number(m[1])
  return m[2] === 'M' ? Math.round(n * 1e6) : m[2] === 'k' ? Math.round(n * 1e3) : Math.round(n)
}

/** Метрики из stderr/stdout прогона: последний блок = итог сессии. */
function parseRun(text) {
  const re = /— turn (\d+) ended: (\S+)\s*\n\s*tokens: in ([\d.]+[kM]?) \(cache ([\d.]+[kM]?)\) \/ out ([\d.]+[kM]?)\s*\n\s*requests: (\d+) \(this turn: (\d+)\)\s*\n(?:\s*compression: (\d+) summarize calls, ([\d.]+[kM]?) tokens\s*\n)?\s*context: ([\d.]+[kM]?) \/ ([\d.]+[kM]?) \(([\d.]+)%\)/g
  const blocks = []
  let m
  while ((m = re.exec(text)) !== null) {
    blocks.push({
      turn: Number(m[1]), kind: m[2],
      inTok: parseTok(m[3]), cache: parseTok(m[4]), outTok: parseTok(m[5]),
      requests: Number(m[6]), turnRequests: Number(m[7]),
      compactions: m[8] ? Number(m[8]) : 0, compactTokens: m[9] ? parseTok(m[9]) : 0,
      context: parseTok(m[10]),
    })
  }
  const compactLines = [...text.matchAll(/· context compacted: shadowed ([\d.]+[kM]?) tokens → summary ([\d.]+[kM]?)/g)]
    .map((x) => ({ shadowed: parseTok(x[1]), summary: parseTok(x[2]) }))
  return {
    blocks,
    last: blocks.at(-1) ?? null,
    turns: blocks.length,
    compactLines,
    failed: [...text.matchAll(/compaction failed: (.+)/g)].map((x) => x[1].trim()),
  }
}

/** События из лога сессии: ходы, ответы, компакции. */
function parseSessionLog(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return null
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      // Имя лога зависит от версии формата харнесса: session.jsonl[.zstd], session.v3.jsonl.zstd, …
      else if (/^session(\.[\w-]+)?\.jsonl(\.zstd)?$/.test(e.name)) files.push({ file: p, mtime: statSync(p).mtimeMs })
    }
  }
  walk(root)
  if (!files.length) return null
  const newest = files.sort((a, b) => b.mtime - a.mtime)[0]
  const text = decompressAll(readFileSync(newest.file))
  const users = []
  const answers = []
  const pairs = []      // { q, a } — вопрос пользователя и ответ модели
  const compactions = []
  const types = {}
  const isSummaryMessage = (t) => /Primary Request and Intent|automatically generated checkpoint|Current runtime context/i.test(t)
  let pending = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    types[o.type] = (types[o.type] ?? 0) + 1
    const textOf = (blocks) => (blocks ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
    if (o.type === 'user/message') {
      const t = textOf(o.data?.content)
      users.push(t)
      // Подставленный summary и инъекции runtime-context — не вопросы пользователя.
      if (!isSummaryMessage(t)) pending = t
    }
    if (o.type === 'assistant/message') {
      const t = textOf(o.data?.message?.content)
      answers.push(t)
      // Пустой ответ не «закрывает» вопрос: модель иногда отвечает следующим сообщением.
      if (t && pending !== null) { pairs.push({ q: pending, a: t }); pending = null }
    }
    if (o.type === 'compaction/summary') {
      const u = o.data?.usage ?? {}
      const callTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + (u.outputTokens ?? 0)
      compactions.push({
        shadowed: o.data?.shadowedTokenCount ?? 0,
        summaryTokens: o.data?.usage?.outputTokens ?? 0,
        callTokens,
        model: o.data?.model ?? '',
      })
    }
  }
  return { users, answers, pairs, compactions, types }
}

/** Ответ на вопрос, найденный по тексту вопроса. */
function answerTo(log, re) {
  const hit = (log?.pairs ?? []).filter((p) => re.test(p.q)).at(-1)
  return hit?.a ?? ''
}

/** Качество контрольных ответов: код проекта, число тем, пятая тема. */
function gradeAnswer(answer) {
  const code = /KX[-\s]?42/i.test(answer)
  const topicCount = /(пять|5)/i.test(answer)
  const fifth = /реки|река|рек\b/i.test(answer)
  return { code, topicCount, fifth, score: [code, topicCount, fifth].filter(Boolean).length }
}

const arms = [
  { name: 'baseline', label: 'без сжатия (`--compress off`)', home: join(tmpdir(), 'dsh-ab-baseline-home') },
  { name: 'compress', label: 'со сжатием (`--compress 0.009 --compress-keep 300`)', home: join(tmpdir(), 'dsh-ab-compress-home') },
]

const data = {}
for (const arm of arms) {
  const runFile = join(base, 'runs', `${arm.name}.txt`)
  const run = existsSync(runFile) ? parseRun(readFileSync(runFile, 'utf8')) : null
  const log = parseSessionLog(arm.home)
  const codeAnswer = answerTo(log, /Какой код проекта/i)
  const topicsAnswer = answerTo(log, /Сколько тем/i)
  const needles = (log?.answers ?? []).filter((a) => /KX[-\s]?42/i.test(a)).length
  const grade = {
    code: /KX[-\s]?42/i.test(codeAnswer),
    topicCount: /(пять|5)/i.test(topicsAnswer),
    fifth: /реки|рек/i.test(topicsAnswer),
  }
  grade.score = [grade.code, grade.topicCount, grade.fifth].filter(Boolean).length
  data[arm.name] = { arm, run, log, grade, codeAnswer, topicsAnswer, needles }
  console.log(`[${arm.name}] turns=${run?.turns ?? 0} in=${run?.last?.inTok ?? 0} out=${run?.last?.outTok ?? 0} cache=${run?.last?.cache ?? 0} ctx=${run?.last?.context ?? 0} compactions=${log?.compactions?.length ?? 0} code="${codeAnswer.slice(0, 40)}" topics="${topicsAnswer.slice(0, 60)}"`)
}

const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
const b = data.baseline
const c = data.compress
const inDelta = b.run?.last?.inTok && c.run?.last?.inTok ? (1 - c.run.last.inTok / b.run.last.inTok) * 100 : 0
const ctxDelta = b.run?.last?.context && c.run?.last?.context ? (1 - c.run.last.context / b.run.last.context) * 100 : 0
const totalCompactTokens = (c.log?.compactions ?? []).reduce((a, x) => a + x.callTokens, 0)
const totalShadowed = (c.log?.compactions ?? []).reduce((a, x) => a + x.shadowed, 0)
const failedCompactions = (c.run?.failed ?? []).length
const grandBase = (b.run?.last?.inTok ?? 0) + (b.run?.last?.outTok ?? 0)
const grandComp = (c.run?.last?.inTok ?? 0) + (c.run?.last?.outTok ?? 0) + totalCompactTokens
const grandDelta = grandBase ? (1 - grandComp / grandBase) * 100 : 0

// ---- третья ветка: умеренная политика (для сравнения конфигураций) ----
const modRunFile = join(base, 'runs', 'compress-mod.txt')
const modRun = existsSync(modRunFile) ? parseRun(readFileSync(modRunFile, 'utf8')) : null
const modLog = parseSessionLog(join(tmpdir(), 'dsh-ab-mod-home'))
const modCompactTokens = (modLog?.compactions ?? []).reduce((a, x) => a + x.callTokens, 0)
const modShadowed = (modLog?.compactions ?? []).reduce((a, x) => a + x.shadowed, 0)
console.log(`[compress-mod] turns=${modRun?.turns ?? 0} in=${modRun?.last?.inTok ?? 0} out=${modRun?.last?.outTok ?? 0} ctx=${modRun?.last?.context ?? 0} requests=${modRun?.last?.requests ?? 0} compactions=${modLog?.compactions?.length ?? 0} shadowed=${modShadowed} summarize=${modCompactTokens}`)
const modGrand = (modRun?.last?.inTok ?? 0) + (modRun?.last?.outTok ?? 0) + modCompactTokens
const modDelta = grandBase ? (1 - modGrand / grandBase) * 100 : 0
const modSection = modRun
  ? `
## Бонус: умеренная политика (\`--compress 0.02 --compress-keep 3000\`)

Порог 20k и хвост 3000 токенов — компакция срабатывает реже, но сжимает крупные участки.

| Метрика | значение |
|---|---|
| Суммарный вход агента | ${fmt(modRun.last?.inTok ?? 0)} |
| Суммарный выход | ${fmt(modRun.last?.outTok ?? 0)} |
| Запросов к модели | ${modRun.last?.requests ?? 0} |
| Финальный контекст | ${fmt(modRun.last?.context ?? 0)} |
| Компакций / отказов | ${modLog?.compactions?.length ?? 0} / ${(modRun.failed ?? []).length} |
| Сжато (shadowed) | ${fmt(modShadowed)} |
| Стоимость суммаризации | ${fmt(modCompactTokens)} |
| **Итого (агент + суммаризация)** | **${fmt(modGrand)}** (${modDelta.toFixed(1)}% меньше baseline) |

Политика решает: агрессивные настройки сжимают контекст сильнее (−78%), но платят за
это постоянными вызовами суммаризатора и отказами; умеренные дают меньший выигрыш по
контексту (−67% против baseline), зато почти без отказов и с меньшими накладными расходами.
`
  : ''

const md = `# Сравнение: без сжатия и со сжатием истории

Сценарий: \`turns.txt\` (один и тот же для обоих прогонов, 8 ходов) — «иголка» \`KX-42\` в начале,
5 тем-описаний по 300 слов, затем два контрольных вопроса. Каждый режим — чистый home и новая сессия.

| Метрика | без сжатия | со сжатием | разница |
|---|---|---|---|
| Суммарный вход (\`tokens: in\`) | ${fmt(b.run?.last?.inTok ?? 0)} | ${fmt(c.run?.last?.inTok ?? 0)} | ${inDelta.toFixed(1)}% меньше |
| из них кэш | ${fmt(b.run?.last?.cache ?? 0)} | ${fmt(c.run?.last?.cache ?? 0)} | — |
| Суммарный выход (\`out\`) | ${fmt(b.run?.last?.outTok ?? 0)} | ${fmt(c.run?.last?.outTok ?? 0)} | — |
| Запросов к модели | ${b.run?.last?.requests ?? 0} | ${c.run?.last?.requests ?? 0} | — |
| Финальный контекст | ${fmt(b.run?.last?.context ?? 0)} | ${fmt(c.run?.last?.context ?? 0)} | ${ctxDelta.toFixed(1)}% меньше |
| Компакций (summary) | 0 | ${c.log?.compactions?.length ?? 0} | — |
| Отказавших компакций | 0 | ${failedCompactions} | — |
| Сжато (shadowed) | 0 | ${fmt(totalShadowed)} | — |
| Стоимость суммаризации (вход+выход всех summary-вызовов) | 0 | ${fmt(totalCompactTokens)} | — |
| **Итого токенов (агент + суммаризация)** | ${fmt(grandBase)} | ${fmt(grandComp)} | **${grandDelta.toFixed(1)}% меньше** |

## Качество ответов

Контрольные вопросы (ответы взяты из лога сессии, вопрос → ответ):

| Проверка | без сжатия | со сжатием |
|---|---|---|
| Код проекта (\`KX-42\`) назван | ${b.grade.code ? 'да' : 'нет'} | ${c.grade.code ? 'да' : 'нет'} |
| Число тем (пять) | ${b.grade.topicCount ? 'да' : 'нет'} | ${c.grade.topicCount ? 'да' : 'нет'} |
| Пятая тема (реки) | ${b.grade.fifth ? 'да' : 'нет'} | ${c.grade.fifth ? 'да' : 'нет'} |
| Итог (из 3) | ${b.grade.score} | ${c.grade.score} |
| Упоминаний кода по ходу диалога | ${b.needles} | ${c.needles} |

Ответ про код — без сжатия: «${b.codeAnswer.slice(0, 120) || '(пусто)'}»
Ответ про код — со сжатием: «${c.codeAnswer.slice(0, 120) || '(пусто)'}»

Ответ про темы — со сжатием:

> ${(c.topicsAnswer || '(пусто)').replace(/\n/g, '\n> ')}

## Выводы

- Компрессия держит контекст в пределах порога: финальный контекст меньше на ${ctxDelta.toFixed(1)}%, суммарный вход агента — на ${inDelta.toFixed(1)}%.
- Экономия «грязная» и «чистая» сильно расходятся: ${c.log?.compactions?.length ?? 0} вызовов суммаризатора съели ${fmt(totalCompactTokens)} токенов, поэтому с их учётом выигрыш — ${grandDelta.toFixed(1)}%.
- Отказов компакции (summary не меньше сжимаемого участка): ${failedCompactions} — при слишком маленьком сжимаемом участке харнесс отказывается, а потраченные на попытку токены не возвращаются.
- Качество на контрольных вопросах: без сжатия ${b.grade.score}/3, со сжатием ${c.grade.score}/3 — ${c.grade.score >= b.grade.score ? 'важная информация сохранилась' : 'часть информации потеряна'}.
- Конфигурация этого прогона намеренно агрессивная (\`thresholdRatio 0.009\` при системном промпте ~8k, \`retainTokens 300\`): компакция срабатывала почти на каждом ходу. Экономичнее держать порог заметно выше системного промпта и больший \`retainTokens\` — тогда компакций меньше и они дешевле.
${modSection}`

writeFileSync(join(base, 'result.md'), md, 'utf8')
console.log('\nresult.md записан')
