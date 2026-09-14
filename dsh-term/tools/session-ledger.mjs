/**
 * Леджер сессии: сколько реально сняла компакция и сколько добавили ответы.
 *
 * Читает durable-лог сессии (v1/v2/v3, zstd с несколькими кадрами) и печатает
 * по каждому запросу размер промпта (usage) + события компакции/прунинга с их
 * собственными числами, а в конце — баланс окна.
 *
 * Запуск:
 *   node dsh-term/tools/session-ledger.mjs --home ~/.dsh-term            # самая свежая сессия
 *   node dsh-term/tools/session-ledger.mjs --grep Плутон                 # сессия, где есть текст
 *   node dsh-term/tools/session-ledger.mjs --session 5936bcfc-...
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const home = arg('--home', join(homedir(), '.dsh-term'))
const wantSession = arg('--session', '')
const grep = arg('--grep', '')

/** Все кадры zstd: Node читает только первый, поэтому режем по magic-байтам. */
function readLog(file) {
  const buf = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) starts.push(i)
  if (starts.length === 0) return buf.toString('utf8')
  let out = ''
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8') } catch {}
  }
  return out
}

function logs(root) {
  const found = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/^session(\.[\w-]+)?\.jsonl(\.zstd)?$/.test(e.name)) found.push({ path: p, m: statSync(p).mtimeMs })
    }
  }
  if (statSync(root, { throwIfNoEntry: false })) walk(root)
  return found.sort((a, b) => b.m - a.m)
}

const fmt = (n) => n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
const promptOf = (u) => (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0)
const cacheOf = (u) => (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0)

let chosen = null
for (const { path } of logs(join(home, 'sessions'))) {
  const text = readLog(path)
  if (wantSession && !path.includes(wantSession)) continue
  if (grep && !text.includes(grep)) continue
  chosen = { path, text }
  break
}
if (chosen === null) {
  console.error('лог не найден (home=' + home + ', session=' + wantSession + ', grep=' + grep + ')')
  process.exit(2)
}

const events = chosen.text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log(`сессия: ${chosen.path.split(/[\\/]/).slice(-2)[0]}`)
console.log(`событий в логе: ${events.length}\n`)

let req = 0
let prevPrompt = null
let sumNet = 0
let sumCall = 0
let sumFails = 0
let sumPruned = 0
let addedByMessages = 0
const first = { prompt: null }
const last = { prompt: null }

for (const e of events) {
  if (e.type === 'assistant/message') {
    const u = e.data?.usage
    if (u === undefined) continue
    req += 1
    const prompt = promptOf(u)
    const visible = (e.data?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('').length
    const delta = prevPrompt === null ? '' : ` (${prompt - prevPrompt >= 0 ? '+' : ''}${fmt(prompt - prevPrompt)})`
    console.log(`req ${req} · turn ${e.data.turn}/step ${e.data.step}: prompt ${fmt(prompt)} (cache ${fmt(cacheOf(u))})${delta} · out ${fmt(u.outputTokens ?? 0)} · visible ${visible} chars`)
    if (first.prompt === null) first.prompt = prompt
    last.prompt = prompt
    prevPrompt = prompt
  } else if (e.type === 'compaction/summary') {
    const d = e.data ?? {}
    const summary = (d.summary ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('').length
    const outTok = d.usage?.outputTokens ?? 0
    const call = promptOf(d.usage) + outTok
    const shadowed = d.shadowedTokenCount ?? 0
    sumNet += shadowed - outTok
    sumCall += call
    console.log(`   ↳ compaction: shadowed ${fmt(shadowed)} → summary ${fmt(outTok)} (net ${shadowed - outTok >= 0 ? '−' : '+'}${fmt(Math.abs(shadowed - outTok))}, call ${fmt(call)}) · текст сводки ${summary} chars`)
  } else if (e.type === 'compaction/end' && e.data?.error) {
    sumFails += 1
    console.log(`   ↳ compaction FAILED: ${e.data.error}`)
  } else if (e.type === 'compaction/prune') {
    const s = e.data?.shadowedTokenCount ?? 0
    if (s > 0) { sumPruned += s; console.log(`   ↳ prune: ${fmt(s)} tokens shadowed (без вызова модели)`) }
  } else if (e.type === 'tool/result') {
    addedByMessages += JSON.stringify(e.data?.result ?? '').length
  }
}

console.log('\n— баланс —')
console.log(`запросов: ${req}`)
if (first.prompt !== null) console.log(`окно: ${fmt(first.prompt)} → ${fmt(last.prompt)} (${last.prompt - first.prompt >= 0 ? '+' : ''}${fmt(last.prompt - first.prompt)})`)
console.log(`компакции: net ${sumNet >= 0 ? '−' : '+'}${fmt(Math.abs(sumNet))} (снято с окна), вызовы стоили ${fmt(sumCall)}${sumFails ? `, отказов ${sumFails} (их usage не учтён)` : ''}`)
console.log(`прунер: −${fmt(sumPruned)} (модель не вызывалась)`)
console.log(`реально снято с окна: ${fmt(sumNet + sumPruned)}`)

// ---- поверхность: что именно ушло в summary и что осталось ----
const charLen = (e) => {
  if (e.type === 'compaction/summary') {
    return (e.data?.summary ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('').length
  }
  const blocks = e.type === 'assistant/message'
    ? e.data?.message?.content
    : e.type === 'user/message' || e.type === 'system/message' ? e.data?.message?.content ?? e.data?.content : undefined
  if (Array.isArray(blocks)) return blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('').length
  return JSON.stringify(e.data ?? '').length
}
let surface = []
for (const e of events) {
  if (e.type === 'system/message' || e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result') {
    const op = e.surfaceOp ?? e.data?.surfaceOp
    if (op?.op === 'replace') {
      const from = surface.findIndex((n) => n.seq === op.startSeq)
      const to = surface.findIndex((n) => n.seq === op.endSeq)
      const node = { seq: e.seq, type: e.type, chars: charLen(e) }
      if (from >= 0 && to >= from) surface = [...surface.slice(0, from), node, ...surface.slice(to + 1)]
      else surface.push(node)
    } else {
      surface.push({ seq: e.seq, type: e.type, chars: charLen(e) })
    }
  }
}
const totalChars = surface.reduce((s, n) => s + n.chars, 0)
console.log('\n— поверхность (то, что уходит в запрос) —')
for (const n of surface) console.log(`  seq ${n.seq} ${n.type.padEnd(17)} ${n.chars} chars`)
console.log(`  итого ${totalChars} chars${last.prompt ? ` → ≈${(totalChars / last.prompt).toFixed(2)} chars/token при промпте ${fmt(last.prompt)}` : ''}`)

const lastCompaction = [...events].reverse().find((e) => e.type === 'compaction/summary')
if (lastCompaction !== undefined) {
  const seqs = new Set(lastCompaction.data?.shadowedSeqs ?? [])
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  let shadowedChars = 0
  console.log('\n— последняя компакция —')
  for (const s of seqs) {
    const node = bySeq.get(s)
    const chars = node === undefined ? 0 : charLen(node)
    shadowedChars += chars
    console.log(`  затенён seq ${s} ${node?.type ?? '?'} ${chars} chars`)
  }
  console.log(`  затенено всего: ${seqs.size} узлов, ${shadowedChars} chars`)
  console.log(`  встало на место: ${charLen(lastCompaction)} chars текста сводки`)
  console.log(`  событие сообщило: shadowed ${fmt(lastCompaction.data?.shadowedTokenCount ?? 0)} (heuristic) → summary ${fmt(lastCompaction.data?.usage?.outputTokens ?? 0)} (выход вызова)`)
  console.log(`  вызов: in ${fmt(promptOf(lastCompaction.data?.usage))} / out ${fmt(lastCompaction.data?.usage?.outputTokens ?? 0)} = ${fmt(promptOf(lastCompaction.data?.usage) + (lastCompaction.data?.usage?.outputTokens ?? 0))}`)
}
