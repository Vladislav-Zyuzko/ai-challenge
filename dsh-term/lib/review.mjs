/**
 * Ревью PR локальным агентом-ревьювером: детерминированная часть (день 32).
 *
 * Модуль вынесен из `dsh-term.mjs` не для красоты: здесь всё, что можно проверить без
 * модели, сети и GitHub, — разбор целевого PR, проверка «уже ревьюили», сборка промпта,
 * разбор ответа агента и раскладка комментариев. Работа с `gh` приходит снаружи
 * адаптером `gh(args) -> { ok, out, err }`, поэтому в тестах она подменяется заглушкой,
 * а в dsh-term это обычный вызов `gh` в рабочей папке.
 *
 * Сам агент запускается рядом, в `dsh-term.mjs`: поднять отдельную сессию — это уже
 * инфраструктура терминала, а не логика ревью.
 */

/** Имя агента: попадает в тег комментариев и в текст промпта. */
export const REVIEW_AGENT = 'ai-challenge-reviewer'
/** Скрытый маркер: по нему ищется уже опубликованное ревью (идемпотентность). */
export const REVIEW_MARK = `<!-- ai-reviewer:${REVIEW_AGENT} v1 -->`
/** Видимый тег: аккаунт GitHub один, и без тега ревью агента не отличить от комментария человека. */
export const REVIEW_TAG = `**🤖 AI-РЕВЬЮ · агент \`${REVIEW_AGENT}\`** — сгенерировано автоматически, это не комментарий автора PR.`
export const REVIEW_BEGIN = '<!-- REVIEW:START -->'
export const REVIEW_END = '<!-- REVIEW:END -->'
export const REVIEW_FINDINGS_BEGIN = '<!-- FINDINGS:START -->'
export const REVIEW_FINDINGS_END = '<!-- FINDINGS:END -->'
export const REVIEW_SEVERITIES = ['blocker', 'major', 'minor']
/** Путь к спецификации роли: агент читает её сам, промпт только указывает файл. */
export const REVIEW_ROLE_PATH = '.dsh/.harness/agents/code-reviewer.md'
export const REVIEW_SKILL_PATH = '.dsh/SKILLS/review-pr.md'
/** Базы, которые подключаются ревьюверу: документация проекта и код проекта. */
export const REVIEW_BASES = ['project', 'project-code']
/** Сколько символов diff идёт прямо в промпт: остальное агент читает файлом. */
export const REVIEW_DIFF_INLINE = 4000

/** Куда складываются данные ревью: diff, промпт, ответ агента, готовый комментарий. */
export function reviewPaths(workspace, number, joinPath) {
  const join = joinPath ?? ((...parts) => parts.join('/'))
  const dir = join(workspace, 'out', 'review', `pr-${number}`)
  return {
    dir,
    diff: join(dir, 'diff.patch'),
    files: join(dir, 'files.json'),
    prompt: join(dir, 'prompt.md'),
    review: join(dir, 'review.md'),
    comment: join(dir, 'comment.md'),
    raw: join(dir, 'raw.log'),
  }
}

/** Разобрать JSON-ответ gh. Ошибки возвращаются, а не бросаются: ревью не роняет публикацию. */
export function parseGhJson(result) {
  if (!result || !result.ok) return { ok: false, err: (result && result.err) || 'gh вернул ошибку' }
  try {
    return { ok: true, data: JSON.parse(result.out) }
  } catch (e) {
    return { ok: false, err: `не разобрать JSON от gh: ${e.message}` }
  }
}

/**
 * Какой PR ревьюим.
 *
 * `arg` — номер, ссылка или имя ветки; пусто — PR текущей ветки. Ветку передаём
 * параметром, а не читаем внутри: так функция остаётся проверяемой без git.
 */
export function resolveReviewTarget({ arg, branch, gh }) {
  let ref = String(arg ?? '').trim()
  const fromUrl = /\/pull\/(\d+)/.exec(ref)
  if (fromUrl) ref = fromUrl[1]
  if (!ref) {
    if (!branch) return { error: 'не удалось определить текущую ветку — укажите PR явно' }
    const list = parseGhJson(gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number']))
    if (!list.ok) return { error: `gh: ${list.err}` }
    if (!list.data.length) return { error: `для ветки ${branch} нет открытого PR — укажите номер или ссылку` }
    ref = String(list.data[0].number)
  }
  const view = parseGhJson(gh(['pr', 'view', ref, '--json',
    'number,url,title,body,headRefName,baseRefName,author,additions,deletions,files,state']))
  if (!view.ok) return { error: `PR ${ref}: ${view.err}` }
  if (view.data.state !== 'OPEN') {
    return { error: `PR #${view.data.number} в состоянии ${view.data.state} — ревью не требуется` }
  }
  return { pr: view.data }
}

/** Ревью уже опубликовано? Проверяются и комментарии, и ревью: тело ревью живёт отдельно. */
export function alreadyReviewed({ number, gh }) {
  const got = parseGhJson(gh(['pr', 'view', String(number), '--json', 'comments,reviews']))
  if (!got.ok) return false
  const bodies = [...(got.data.comments ?? []), ...(got.data.reviews ?? [])]
  return bodies.some((item) => String(item.body ?? '').includes(REVIEW_MARK))
}

/** Промпт ревьюверу: роль берётся из спецификации агента, данные PR — из gh. */
export function buildReviewPrompt({ workspace, pr, diff, paths }) {
  const files = (pr.files ?? [])
    .map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`)
    .join('\n') || '(список файлов пуст)'
  const clipped = diff.length > REVIEW_DIFF_INLINE
  const excerpt = clipped ? diff.slice(0, REVIEW_DIFF_INLINE) : diff
  return [
    `Ты — агент-ревьювер \`${REVIEW_AGENT}\`. Проведи ревью pull request и верни результат строго в заданном формате.`,
    '',
    `Роль, рубрика, шкала severity и формат вывода: файл \`${REVIEW_ROLE_PATH}\`.`,
    `Прочитай его инструментом чтения файла и следуй ему. Скилл процесса — \`${REVIEW_SKILL_PATH}\`.`,
    '',
    `Репозиторий (рабочая папка): ${workspace}`,
    `PR #${pr.number}: ${pr.title}`,
    `Ветки: ${pr.headRefName} → ${pr.baseRefName}`,
    `Объём: файлов ${(pr.files ?? []).length}, +${pr.additions}/-${pr.deletions}`,
    '',
    'Изменённые файлы:',
    files,
    '',
    'Описание PR:',
    (pr.body ?? '').trim() || '(пусто)',
    '',
    `Полный diff лежит в файле: ${paths.diff} — читай его инструментом (в промпт вошло только начало${clipped ? ', diff длиннее' : ''}).`,
    '',
    `Базы знаний уже подключены: \`rag_search\` по базе \`${REVIEW_BASES[0]}\` (документация проекта) и`,
    `\`${REVIEW_BASES[1]}\` (код проекта). Используй их, чтобы понять конвенции и найти похожий код.`,
    'Файлы репозитория читай обычными инструментами. Ничего не меняй: только чтение и поиск.',
    '',
    'Начало diff:',
    '```diff',
    excerpt,
    '```',
    '',
    'Формат ответа — ровно две части:',
    `1) текст ревью, обёрнутый в ${REVIEW_BEGIN} … ${REVIEW_END}`,
    `2) массив замечаний между ${REVIEW_FINDINGS_BEGIN} … ${REVIEW_FINDINGS_END} (JSON, поля severity/title/file/line/why/fix;`,
    '   если замечаний нет — пустой массив и явная фраза «замечаний нет» в тексте ревью).',
  ].join('\n')
}

/** Вырезать блок между маркерами. */
export function extractBetween(text, begin, end) {
  const i = text.indexOf(begin)
  if (i < 0) return ''
  const j = text.indexOf(end, i + begin.length)
  return text.slice(i + begin.length, j < 0 ? undefined : j).trim()
}

/** Разобрать машиночитаемый блок замечаний. Ошибка разбора не роняет ревью. */
export function parseFindings(text) {
  const block = extractBetween(text, REVIEW_FINDINGS_BEGIN, REVIEW_FINDINGS_END)
  if (!block) return { findings: [], error: 'блок findings отсутствует' }
  const cleaned = block.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  let data
  try {
    data = JSON.parse(cleaned)
  } catch (e) {
    return { findings: [], error: `JSON не разобран: ${e.message}` }
  }
  if (!Array.isArray(data)) return { findings: [], error: 'в блоке findings не массив' }
  const findings = data
    .filter((f) => f && typeof f === 'object' && REVIEW_SEVERITIES.includes(String(f.severity)))
    .map((f) => ({
      severity: String(f.severity),
      title: String(f.title ?? '').trim(),
      file: String(f.file ?? '').trim(),
      line: Number.isInteger(Number(f.line)) ? Number(f.line) : null,
      why: String(f.why ?? '').trim(),
      fix: String(f.fix ?? '').trim(),
    }))
  return { findings, error: '' }
}

/** Тело комментария: тег агента сверху — иначе его не отличить от комментария человека. */
export function reviewCommentBody(title, text) {
  return `${REVIEW_MARK}\n${REVIEW_TAG}${title ? ` · ${title}` : ''}\n\n${text}\n`
}

/**
 * Раскладка комментариев: сводный — целиком ревью, построчные — по замечаниям с файлом
 * и строкой. GitHub принимает построчный комментарий только к строке из diff: не вышло —
 * замечание остаётся в сводке, и это не ошибка.
 *
 * `gh` — адаптер; `write` — функция записи файла (в тестах не нужна файловая система).
 */
export function postReviewComments({ number, reviewText, findings, paths, gh, slug, write, dryRun = false }) {
  if (write) write(paths.comment, reviewCommentBody('', reviewText))
  if (dryRun) return { posted: false, inline: 0, planned: findings.length, dryRun: true }
  let posted = false
  let error = ''
  const review = gh(['pr', 'review', String(number), '--comment', '--body-file', paths.comment])
  if (review && review.ok) {
    posted = true
  } else {
    const plain = gh(['pr', 'comment', String(number), '--body-file', paths.comment])
    posted = Boolean(plain && plain.ok)
    if (!posted) error = (plain && plain.err) || (review && review.err) || 'gh ответил ошибкой'
  }
  let inline = 0
  if (posted && slug) {
    for (const f of findings) {
      if (!f.file || !f.line) continue
      const body = reviewCommentBody(`[${f.severity}] ${f.title}`, `${f.why}\n\n**Что сделать:** ${f.fix}`)
      const r = gh(['api', `repos/${slug}/pulls/${number}/comments`,
        '-f', `body=${body}`, '-f', `path=${f.file}`, '-F', `line=${f.line}`, '-f', 'side=RIGHT'])
      if (r && r.ok) inline += 1
    }
  }
  return { posted, inline, planned: findings.length, error }
}

/** Замечания по severity — для строки отчёта. */
export function countBySeverity(findings) {
  const counts = { blocker: 0, major: 0, minor: 0 }
  for (const f of findings) counts[f.severity] += 1
  return counts
}
