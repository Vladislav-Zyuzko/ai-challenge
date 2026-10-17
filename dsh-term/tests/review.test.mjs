/**
 * Тесты ревью PR (день 32) — без модели, без сети и без GitHub.
 *
 * Проверяется детерминированная часть пайплайна из `lib/review.mjs`: как выбирается PR,
 * как распознаётся уже опубликованное ревью, что уходит в промпт ревьюверу, как
 * разбирается его ответ и как раскладываются комментарии. Работа с `gh` подменяется
 * заглушкой-адаптером — именно для этого модуль и вынесен из `dsh-term.mjs`.
 *
 * Главная проверка дня: **каждый комментарий начинается с тега агента**. Аккаунт GitHub
 * один, и без тега ревью агента не отличить от комментария владельца репозитория.
 *
 * Запуск: node dsh-term/tests/review.test.mjs
 */
import {
  REVIEW_AGENT,
  REVIEW_BASES,
  REVIEW_BEGIN,
  REVIEW_END,
  REVIEW_FINDINGS_BEGIN,
  REVIEW_FINDINGS_END,
  REVIEW_MARK,
  alreadyReviewed,
  buildReviewPrompt,
  countBySeverity,
  extractBetween,
  patchPositions,
  parseFindings,
  postReviewComments,
  resolveReviewTarget,
  reviewCommentBody,
  reviewPaths,
} from '../lib/review.mjs'

const checks = []
const check = (name, ok, extra = '') => checks.push({ name, ok, extra })

/** Заглушка gh: отвечает заранее заготовленными результатами и записывает вызовы. */
function fakeGh(responses) {
  const calls = []
  const gh = (args) => {
    calls.push(args)
    const key = args.join(' ')
    for (const [pattern, value] of responses) {
      if (key.includes(pattern)) {
        return typeof value === 'function' ? value(args) : value
      }
    }
    return { ok: false, err: `заглушка не знает команду: ${key}` }
  }
  gh.calls = calls
  return gh
}

const okJson = (obj) => ({ ok: true, out: JSON.stringify(obj) })

const PR = {
  number: 42,
  url: 'https://github.com/o/r/pull/42',
  title: 'feat(x): проба',
  body: 'описание PR',
  headRefName: 'week7/day32',
  baseRefName: 'feature/week7',
  author: { login: 'me' },
  additions: 12,
  deletions: 4,
  state: 'OPEN',
  files: [
    { path: 'doc-index/doc_index/collect.py', additions: 10, deletions: 3 },
    { path: 'README.md', additions: 2, deletions: 1 },
  ],
}

// 1. Выбор PR: ссылка, номер, ветка, отсутствие PR.
{
  const byUrl = resolveReviewTarget({
    arg: 'https://github.com/o/r/pull/42',
    branch: 'week7/day32',
    gh: fakeGh([['pr view 42', okJson(PR)]]),
  })
  check('ссылка разбирается в номер PR', byUrl.pr?.number === 42, byUrl.error ?? '')

  const ghNumber = fakeGh([['pr view 7', okJson({ ...PR, number: 7, headRefOid: 'abc1234' })]])

  const byNumber = resolveReviewTarget({ arg: '7', gh: ghNumber })
  check('номер PR принимается как есть', byNumber.pr?.number === 7, byNumber.error ?? '')
  check('номер уходит в gh без лишних запросов',
    ghNumber.calls.length === 1 && ghNumber.calls[0][0] === 'pr', ghNumber.calls.flat().join(' '))
  // Без SHA головы PR построчные комментарии привязать не к чему — их молча пропустит
  // проверка `headSha`; поэтому поле обязано запрашиваться у gh.
  check('у gh запрашивается SHA головы PR',
    ghNumber.calls[0].join(' ').includes('headRefOid'), ghNumber.calls[0].join(' '))
  check('SHA головы доходит до результата', byNumber.pr?.headRefOid === 'abc1234',
    String(byNumber.pr?.headRefOid))

  const ghBranch = fakeGh([
    ['pr list --head week7/day32', okJson([{ number: 42 }])],
    ['pr view 42', okJson(PR)],
  ])
  const byBranch = resolveReviewTarget({ branch: 'week7/day32', gh: ghBranch })
  check('без аргумента берётся PR текущей ветки', byBranch.pr?.number === 42, byBranch.error ?? '')

  const none = resolveReviewTarget({
    branch: 'week7/day32',
    gh: fakeGh([['pr list --head week7/day32', okJson([])]]),
  })
  check('нет PR для ветки — понятная ошибка',
    /нет открытого PR/.test(none.error ?? ''), none.error ?? '')

  const noBranch = resolveReviewTarget({ arg: '', branch: '', gh: fakeGh([]) })
  check('без ветки и без аргумента — ошибка', Boolean(noBranch.error), noBranch.error ?? '')

  const closed = resolveReviewTarget({
    arg: '42',
    gh: fakeGh([['pr view 42', okJson({ ...PR, state: 'MERGED' })]]),
  })
  check('закрытый PR не ревьюится', /MERGED/.test(closed.error ?? ''), closed.error ?? '')

  const broken = resolveReviewTarget({ arg: '42', gh: fakeGh([['pr view 42', { ok: false, err: 'нет доступа' }]]) })
  check('ошибка gh возвращается текстом', /нет доступа/.test(broken.error ?? ''), broken.error ?? '')
}

// 2. Идемпотентность: повторный запуск не публикует второе ревью.
{
  const withComment = fakeGh([['comments,reviews', okJson({ comments: [{ body: `${REVIEW_MARK}\nтег` }], reviews: [] })]])
  check('ревью в комментариях распознаётся', alreadyReviewed({ number: 42, gh: withComment }) === true)

  const withReview = fakeGh([['comments,reviews', okJson({ comments: [], reviews: [{ body: REVIEW_MARK }] })]])
  check('ревью в отзывах распознаётся', alreadyReviewed({ number: 42, gh: withReview }) === true)

  const clean = fakeGh([['comments,reviews', okJson({ comments: [{ body: 'обычный комментарий' }], reviews: [] })]])
  check('чужой комментарий за ревью не считается', alreadyReviewed({ number: 42, gh: clean }) === false)

  const failed = fakeGh([['comments,reviews', { ok: false, err: 'gh упал' }]])
  check('ошибка gh не выдаётся за «ревью есть»', alreadyReviewed({ number: 42, gh: failed }) === false)
}

// 3. Промпт ревьюверу.
{
  const paths = reviewPaths('C:/repo', 42, (...parts) => parts.join('/'))
  const longDiff = 'diff --git a/x b/x\n' + 'x'.repeat(9000)
  const prompt = buildReviewPrompt({ workspace: 'C:/repo', pr: PR, diff: longDiff, paths })
  check('в промпте роль и рубрика', prompt.includes('.dsh/.harness/agents/code-reviewer.md'))
  check('в промпте скилл процесса', prompt.includes('.dsh/SKILLS/review-pr.md'))
  check('в промпте номер и заголовок PR', prompt.includes('PR #42') && prompt.includes('feat(x): проба'))
  check('в промпте ветки', prompt.includes('week7/day32 → feature/week7'))
  check('в промпте список изменённых файлов',
    prompt.includes('doc-index/doc_index/collect.py (+10/-3)'), '')
  check('в промпте указан файл с полным diff', prompt.includes(paths.diff))
  check('в промпте обе базы RAG',
    REVIEW_BASES.every((b) => prompt.includes(b)), REVIEW_BASES.join(', '))
  check('в промпте маркеры ответа',
    prompt.includes(REVIEW_BEGIN) && prompt.includes(REVIEW_FINDINGS_BEGIN))
  check('длинный diff обрезан и об этом сказано', prompt.includes('diff длиннее'))
  check('в промпт не уехал весь diff', !prompt.includes('x'.repeat(5000)))
  check('запрет на правки в промпте есть', prompt.includes('Ничего не меняй'))

  // Промпт уезжает аргументом процесса: у Windows предел ~32k символов, поэтому
  // ограничены не только diff, но и описание PR с списком файлов.
  const hugeBody = 'о'.repeat(40000)
  const manyFiles = Array.from({ length: 900 }, (_, i) => ({ path: `f${i}.py`, additions: 1, deletions: 0 }))
  const bigPrompt = buildReviewPrompt({
    workspace: 'C:/repo',
    pr: { ...PR, body: hugeBody, files: manyFiles },
    diff: 'diff --git a/x b/x',
    paths,
  })
  check('описание PR обрезано', bigPrompt.includes('…') && !bigPrompt.includes('о'.repeat(20000)),
    `длина ${bigPrompt.length}`)
  check('список файлов обрезан и указан полный список файлом',
    bigPrompt.includes('ещё 600 файлов') && bigPrompt.includes(paths.files))
  check('промпт остаётся в пределах argv', bigPrompt.length < 24000, `длина ${bigPrompt.length}`)
  check('в промпте назван предел замечаний', prompt.includes('не больше 12'))
}

// 4. Разбор ответа агента.
{
  const raw = [
    'служебные строки харнесса',
    REVIEW_BEGIN,
    '## Потенциальные баги',
    '- [major] пустой корпус',
    REVIEW_END,
    REVIEW_FINDINGS_BEGIN,
    '[{"severity":"major","title":"пустой корпус","file":"a.py","line":7,"why":"молчит","fix":"ошибка"},',
    ' {"severity":"шутка","title":"мусор"}]',
    REVIEW_FINDINGS_END,
  ].join('\n')
  const review = extractBetween(raw, REVIEW_BEGIN, REVIEW_END)
  check('текст ревью извлекается между маркерами', review.startsWith('## Потенциальные баги'), review.slice(0, 40))
  const parsed = parseFindings(raw)
  check('замечания разбираются', parsed.findings.length === 1, JSON.stringify(parsed))
  check('неизвестная severity отбрасывается',
    parsed.findings.every((f) => f.severity === 'major'))
  check('поля замечания читаются',
    parsed.findings[0].file === 'a.py' && parsed.findings[0].line === 7
    && parsed.findings[0].fix === 'ошибка')
  check('строка превращается в число', typeof parsed.findings[0].line === 'number')

  const fenced = `${REVIEW_FINDINGS_BEGIN}\n\`\`\`json\n[{"severity":"minor","title":"t"}]\n\`\`\`\n${REVIEW_FINDINGS_END}`
  check('блок в ```json тоже разбирается', parseFindings(fenced).findings.length === 1)

  const broken = parseFindings(`${REVIEW_FINDINGS_BEGIN}\n[{битый json}\n${REVIEW_FINDINGS_END}`)
  check('битый JSON не роняет пайплайн',
    broken.findings.length === 0 && /JSON/.test(broken.error), broken.error)

  const missing = parseFindings('нет маркеров вовсе')
  check('без блока findings — честная ошибка', /отсутствует/.test(missing.error), missing.error)

  const notArray = parseFindings(`${REVIEW_FINDINGS_BEGIN}\n{"a":1}\n${REVIEW_FINDINGS_END}`)
  check('не массив — ошибка', /не массив/.test(notArray.error), notArray.error)

  const empty = parseFindings(`${REVIEW_FINDINGS_BEGIN}\n[]\n${REVIEW_FINDINGS_END}`)
  check('пустой массив — это «замечаний нет» без ошибки',
    empty.findings.length === 0 && empty.error === '', JSON.stringify(empty))

  // Предел замечаний держит код: ответ с полусотней находок иначе дал бы полсотни вызовов gh.
  const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({
    severity: i < 5 ? 'minor' : (i < 10 ? 'major' : 'blocker'),
    title: `t${i}`, file: 'a.py', line: i + 1, why: 'w', fix: 'f',
  })))
  const capped = parseFindings(`${REVIEW_FINDINGS_BEGIN}\n${many}\n${REVIEW_FINDINGS_END}`)
  check('замечаний не больше предела', capped.findings.length === 12, String(capped.findings.length))
  check('об отброшенных сообщается', capped.dropped === 18, String(capped.dropped))
  check('в первых строках — самые важные (blocker вперёд)',
    capped.findings[0].severity === 'blocker', capped.findings[0].severity)
}

// 5. Тег комментария — сверху и всегда.
{
  const body = reviewCommentBody('', '## Потенциальные баги\n- нет')
  const lines = body.split('\n')
  check('маркер агента в первой строке', lines[0] === REVIEW_MARK, lines[0])
  check('видимый тег во второй строке',
    lines[1].includes('AI-РЕВЬЮ') && lines[1].includes(REVIEW_AGENT), lines[1] ?? '')
  check('тег отличает агента от человека', /не комментарий автора PR/.test(lines[1] ?? ''))
  const inline = reviewCommentBody('[major] пустой корпус', 'почему')
  check('в построчном комментарии тег тоже сверху',
    inline.split('\n')[0] === REVIEW_MARK && inline.split('\n')[1].includes('[major] пустой корпус'))
}

// 6. Раскладка комментариев.
// Построчный комментарий привязывается к позиции строки в патче: наш аккаунт валидирует
// запрос по старой схеме, где `line` не разрешён, а `position` — да.
const PATCH = [
  'diff --git a/a.py b/a.py',
  'index 111..222 100644',
  '--- a/a.py',
  '+++ b/a.py',
  '@@ -1,3 +1,4 @@',
  ' первая строка',
  '-удалённая строка',
  '+добавленная строка',
  '+ещё одна',
  ' последняя',
].join('\n')

{
  const positions = patchPositions(PATCH)
  check('позиции считаются по файлу',
    positions['a.py'] && Object.keys(positions['a.py']).length === 4, JSON.stringify(positions))
  // Позиция — номер строки внутри патча файла: первая строка после `+++` (заголовок ханка)
  // это 1, значит первая строка содержимого — 2. Именно такую нумерацию принимает GitHub.
  check('первая строка содержимого — позиция 2', positions['a.py'][1] === 2, String(positions['a.py'][1]))
  check('удалённая строка не занимает номер новой версии',
    positions['a.py'][2] === 4, String(positions['a.py'][2]))
  check('строки, которых нет в патче, отсутствуют', positions['a.py'][99] === undefined)
}

{
  const paths = reviewPaths('C:/repo', 42, (...parts) => parts.join('/'))
  const findings = [
    { severity: 'blocker', title: 'b', file: 'a.py', line: 1, why: 'w', fix: 'f' },
    { severity: 'minor', title: 'm', file: 'b.py', line: null, why: 'w', fix: 'f' },
  ]
  const written = []
  const gh = fakeGh([
    ['repo view --json nameWithOwner', okJson({ nameWithOwner: 'o/r' })],
    ['pr review 42', { ok: true, out: '' }],
    ['pulls/42/comments', { ok: true, out: '' }],
  ])
  const result = postReviewComments({
    number: 42, reviewText: '## Итог', findings, paths, gh, slug: 'o/r', headSha: 'abc1234',
    patch: PATCH,
    write: (target, text) => written.push([target, text]),
  })
  check('сводный комментарий опубликован', result.posted === true && result.planned === 2)
  check('сводка пишется файлом и с тегом',
    written.length === 1 && written[0][1].startsWith(REVIEW_MARK), JSON.stringify(written[0]?.[0] ?? ''))
  check('построчно ушёл один комментарий', result.inline === 1, String(result.inline))
  check('без строки в патче замечание пропущено, а не потеряно',
    result.skipped === 1 && result.planned === 2, String(result.skipped))
  const apiCall = gh.calls.find((c) => c[0] === 'api')
  // Строка 1 патча — позиция 2; `line`/`side` не годятся: GitHub отвечает
  // «line is not a permitted key» и требует позицию внутри diff.
  check('построчный комментарий идёт через api с position и commit_id',
    Boolean(apiCall) && apiCall.includes('position=2') && apiCall.includes('commit_id=abc1234')
    && !apiCall.includes('side=RIGHT'), apiCall ? apiCall.join(' ') : 'нет вызова')
  check('в построчном комментарии есть тег',
    apiCall.some((a) => a.includes(REVIEW_MARK)) || apiCall.some((a) => a.includes('AI-РЕВЬЮ')))

  // Провал построчного комментария виден: молчаливый пропуск уже случался.
  const inlineFails = fakeGh([
    ['pr review 42', { ok: true, out: '' }],
    ['pulls/42/comments', { ok: false, err: 'Invalid request' }],
  ])
  const failedInline = postReviewComments({
    number: 42, reviewText: 'т', findings: [findings[0]], paths, gh: inlineFails, slug: 'o/r',
    headSha: 'abc1234', patch: PATCH, write: () => {},
  })
  check('ошибка построчного комментария попадает в отчёт',
    failedInline.inline === 0 && failedInline.failures.length === 1
    && /Invalid request/.test(failedInline.failures[0]), JSON.stringify(failedInline.failures))

  // Нет sha — построчные пропускаются, сводка всё равно публикуется.
  const noSha = fakeGh([['pr review 42', { ok: true, out: '' }], ['pulls/42/comments', { ok: true, out: '' }]])
  const noShaResult = postReviewComments({
    number: 42, reviewText: 'т', findings, paths, gh: noSha, slug: 'o/r', headSha: '',
    patch: PATCH, write: () => {},
  })
  check('без commit_id построчные не отправляются, сводка публикуется',
    noShaResult.posted === true && noShaResult.inline === 0
    && !noSha.calls.some((c) => c[0] === 'api'), JSON.stringify(noSha.calls))

  // Если `pr review` не сработал — публикуем обычным комментарием.
  const fallback = fakeGh([
    ['pr review 42', { ok: false, err: 'reviews недоступны' }],
    ['pr comment 42', { ok: true, out: '' }],
    ['repo view --json nameWithOwner', okJson({ nameWithOwner: 'o/r' })],
  ])
  const fallbackResult = postReviewComments({
    number: 42, reviewText: 'текст', findings: [], paths, gh: fallback, slug: 'o/r', write: () => {},
  })
  check('при отказе review используется comment',
    fallbackResult.posted === true && fallback.calls.some((c) => c[0] === 'pr' && c[1] === 'comment'))

  // Оба способа не сработали — честная ошибка, а не «опубликовано».
  const bothFail = fakeGh([
    ['pr review 42', { ok: false, err: 'нет прав' }],
    ['pr comment 42', { ok: false, err: 'нет прав' }],
  ])
  const failedResult = postReviewComments({
    number: 42, reviewText: 'текст', findings: [], paths, gh: bothFail, slug: 'o/r', write: () => {},
  })
  check('провал публикации сообщается',
    failedResult.posted === false && /нет прав/.test(failedResult.error), failedResult.error ?? '')

  // Сухой прогон: ни одного вызова gh, ничего не публикуется.
  const dryGh = fakeGh([])
  const dry = postReviewComments({
    number: 42, reviewText: 'текст', findings, paths, gh: dryGh, slug: 'o/r', write: () => {}, dryRun: true,
  })
  check('dry-run не трогает GitHub', dry.posted === false && dryGh.calls.length === 0)
  check('dry-run показывает план', dry.planned === 2 && dry.dryRun === true)
}

// 7. Счётчики для отчёта.
{
  const counts = countBySeverity([
    { severity: 'blocker' }, { severity: 'major' }, { severity: 'major' }, { severity: 'minor' },
  ])
  check('счёт по severity верен',
    counts.blocker === 1 && counts.major === 2 && counts.minor === 1, JSON.stringify(counts))
}

let failed = 0
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` (${c.extra})`}`)
  if (!c.ok) failed += 1
}
if (failed) {
  console.error(`\n✖ провалено проверок: ${failed}`)
  process.exit(1)
}
console.log(`✔ ревью PR: выбор PR, идемпотентность, промпт, разбор ответа и тег комментариев (${checks.length} проверок)`)
