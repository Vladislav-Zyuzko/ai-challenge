/**
 * Режим техподдержки dsh-term (день 33): данные обращения и промпт режима.
 *
 * Вынесено из CLI отдельным модулем по той же причине, что и ревью (`lib/review.mjs`):
 * логику надо проверять тестом, а `dsh-term.mjs` при импорте сразу запускает сессию.
 *
 * Здесь же лежит главное решение дня: слепок обращения собирает КОД из локального
 * JSON, а не модель. Модель потом цитирует эти строки, поэтому пересказ недопустим —
 * в промпт уходят дословные сообщения переписки, версия, ОС и тариф.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const SUPPORT_BASE = 'support'
export const SUPPORT_MCP_PRESET = 'support'
export const SUPPORT_DATA_DIR = join('support-mcp', 'data')
export const SUPPORT_DEV_QUEUE = 'INFRA'
export const SUPPORT_DEV_TAG = 'DSH-TERM'
export const SUPPORT_STATUS_LABELS = { open: 'открыт', pending: 'ждёт пользователя', closed: 'закрыт' }
export const SUPPORT_FROM_LABELS = { user: 'пользователь', support: 'поддержка', system: 'система' }

/** Каталог JSON-хранилища поддержки: своё развёртывание — свой путь. */
export function supportDataDir(cwd = process.cwd()) {
  return process.env.DSH_TERM_SUPPORT_DATA
    ? resolve(cwd, String(process.env.DSH_TERM_SUPPORT_DATA))
    : join(cwd, SUPPORT_DATA_DIR)
}

/** Прочитать JSON поддержки. Ошибки возвращаются, а не печатаются. */
export function readSupportJson(name, cwd = process.cwd()) {
  const path = join(supportDataDir(cwd), name)
  if (!existsSync(path)) return { path, data: null, error: `нет файла данных: ${path}` }
  try {
    return { path, data: JSON.parse(readFileSync(path, 'utf8')), error: null }
  } catch (e) {
    return { path, data: null, error: `файл ${path} не читается: ${e.message}` }
  }
}

export function supportTickets(cwd = process.cwd()) {
  const got = readSupportJson('tickets.json', cwd)
  if (got.error) return { tickets: [], error: got.error }
  if (!Array.isArray(got.data)) return { tickets: [], error: `${got.path}: ожидается список обращений` }
  return { tickets: got.data, error: null }
}

export function supportUsers(cwd = process.cwd()) {
  const got = readSupportJson('users.json', cwd)
  if (got.error) return { users: [], error: got.error }
  if (!Array.isArray(got.data)) return { users: [], error: `${got.path}: ожидается список пользователей` }
  return { users: got.data, error: null }
}

/** Обращение по номеру: `t-1042` и `T-1042` — одно и то же. */
export function supportTicket(id, cwd = process.cwd()) {
  const got = supportTickets(cwd)
  if (got.error) return { ticket: null, error: got.error }
  const wanted = String(id ?? '').trim().toUpperCase()
  const ticket = got.tickets.find((t) => String(t.id).toUpperCase() === wanted)
  if (!ticket) {
    const open = got.tickets.filter((t) => t.status !== 'closed').map((t) => t.id)
    return {
      ticket: null,
      error: `обращение не найдено: ${wanted || '(пусто)'}`
        + (open.length ? ` · открытые: ${open.join(', ')}` : ''),
    }
  }
  return { ticket, error: null }
}

/** `2026-10-14T09:12:00+06:00` → `14.10 09:12`: короче в промпте, читаемо в консоли. */
export function supportWhen(at) {
  const raw = String(at ?? '')
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw)
  return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : raw
}

export function supportUserOf(ticket, users = []) {
  return users.find((u) => u.id === ticket?.user) ?? null
}

export function supportUserLine(user, fallbackId) {
  if (!user) return `пользователь: ${fallbackId ?? 'неизвестен'} (карточки нет в базе)`
  const bits = [`пользователь: ${user.name} <${user.email}>`, `тариф ${user.plan}`,
    user.platform, `dsh-term ${user.dsh_term_version}`]
  return bits.filter(Boolean).join(' · ')
}

/**
 * Слепок обращения для системного промпта: факты плоским списком.
 * Модель их цитирует, поэтому никаких пересказов и оценок — только данные.
 */
export function supportDigest(ticket, user) {
  const status = SUPPORT_STATUS_LABELS[ticket.status] ?? ticket.status
  const lines = [
    `обращение: ${ticket.id} · «${ticket.subject}» · ${status}`
      + `${ticket.component ? ` · компонент ${ticket.component}` : ''}`
      + `${ticket.created_at ? ` · создано ${supportWhen(ticket.created_at)}` : ''}`,
    supportUserLine(user, ticket.user),
  ]
  if (user?.notes) lines.push(`о пользователе: ${user.notes}`)
  if (Array.isArray(ticket.tags) && ticket.tags.length) lines.push(`теги: ${ticket.tags.join(', ')}`)
  const messages = Array.isArray(ticket.messages) ? ticket.messages : []
  lines.push(`переписка (${messages.length}):`)
  for (const m of messages) {
    const who = SUPPORT_FROM_LABELS[m.from] ?? m.from
    const when = supportWhen(m.at)
    const text = String(m.text ?? '').replace(/\s+/g, ' ').trim()
    // Время может отсутствовать (комментарий, записанный вручную): пустые скобки
    // в промпте выглядят как сломанные данные.
    lines.push(when ? `  [${when}] ${who}: ${text}` : `  ${who}: ${text}`)
  }
  if (ticket.resolution) lines.push(`прежнее решение: ${ticket.resolution}`)
  return lines.join('\n')
}

/** Шаблон описания задачи для разработки: одинаковый — значит сравнимый. */
export function supportDevTaskTemplate(ticket, user) {
  return [
    '## Откуда',
    `- обращение поддержки: ${ticket.id} — «${ticket.subject}»`,
    `- ${supportUserLine(user, ticket.user)}`,
    '',
    '## Симптом',
    '(что видел пользователь: дословная формулировка из переписки)',
    '',
    '## Диагноз',
    '(причина: код, конфигурация, документация или окружение пользователя)',
    '',
    '## Что сделать',
    '- [ ] (правка в коде / сообщение об ошибке / заметка в FAQ)',
    '',
    '## Как проверить',
    '(шаги воспроизведения и ожидаемый результат)',
  ].join('\n')
}

/**
 * Инструкция режима поддержки. Едет в системный промпт оверлеем, поэтому:
 * коротко, только правила и данные. Всё, что модель должна ПОМНИТЬ (роль, порядок
 * вызовов, формат задачи), здесь, а не в пользовательском сообщении: сообщение
 * пользователя — это описание проблемы, а не настройка режима.
 */
export function supportInstructionText({ ticket, user, hasFaq, hasTracker }) {
  const indent = (text) => text.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n')
  const faqRule = hasFaq
    ? 'Вопросы про поведение dsh-term проверяй по базе FAQ: `rag_search` (база `support`). '
      + 'Ссылайся на заметку и строки, цитируй дословно 1–2 фрагмента.'
    : 'База FAQ в этой сессии не подключена — отвечай по своим знаниям и честно скажи об этом.'
  const trackerBlock = hasTracker
    ? [
      'В сессии подключён трекер задач (MCP `sltracker`). После того как ответил пользователю, заведи',
      'задачу в разработку одним вызовом:',
      `  mcp__sltracker__create_task(queue: "${SUPPORT_DEV_QUEUE}",`,
      `    title: "[${SUPPORT_DEV_TAG}] <что починить, коротко>",`,
      '    description: <markdown по шаблону ниже>)',
      `Заголовок ОБЯЗАТЕЛЬНО начинается с "${SUPPORT_DEV_TAG}" — тегов у трекера нет, префикс и есть тег.`,
      'Шаблон описания (подставь факты обращения, ничего не выдумывай):',
      indent(supportDevTaskTemplate(ticket, user)),
      'В конце ответа — строка «Задача в разработку: INFRA-<номер> — <заголовок>».',
      'Если обращение — чистый вопрос по использованию и дефекта не выявило, задачу не заводи,',
      'а строкой объясни почему: «Задача в разработку: не требуется — <причина>».',
    ].join('\n')
    : [
      'Трекер в этой сессии не подключён (нет токена), поэтому задачу в разработку создай текстом:',
      `последним блоком ответа дай «Задача в разработку (${SUPPORT_DEV_QUEUE}):» с заголовком`,
      `«[${SUPPORT_DEV_TAG}] …» и описанием по шаблону ниже.`,
      indent(supportDevTaskTemplate(ticket, user)),
    ].join('\n')
  return [
    'РЕЖИМ ТЕХПОДДЕРЖКИ dsh-term. Ты — инженер поддержки продукта dsh-term (терминальный CLI для',
    'DeepSeek Harness). В сессии разбирается одно обращение пользователя; он описывает проблему в чате.',
    '',
    'ДАННЫЕ ОБРАЩЕНИЯ (из хранилища поддержки, на момент включения режима):',
    supportDigest(ticket, user),
    '',
    'КАК ОТВЕЧАТЬ:',
    '1. Сразу по делу: что происходит, почему, что сделать — шагами. Без «здравствуйте, спасибо за обращение».',
    `2. ${faqRule}`,
    '3. Факты о пользователе, версии и переписку бери из блока выше или из `mcp__support__*`',
    '   (`support_get_ticket`, `support_get_user`, `support_find_tickets`) — не сочиняй версий,',
    '   ОС и цитат, которых нет ни в FAQ, ни в обращении.',
    '4. Если ответа нет ни в FAQ, ни в данных обращения — скажи это прямо, первой строкой ответа:',
    '   «в базе и в обращении этого нет», назови, какие данные нужны (лог, шаги, версия), и только',
    '   потом — что из темы обращения всё же относится к делу. Не подменяй вопрос темой обращения:',
    '   пользователь задал именно этот вопрос и ждёт ответа на него.',
    '5. Вопросы не про dsh-term и не про это обращение — вежливо верни к теме поддержки.',
    '6. Не обещай сроки и не придумывай номера задач, которых не создал.',
    '',
    'ПОСЛЕ ОТВЕТА — ЗАДАЧА В РАЗРАБОТКУ:',
    trackerBlock,
  ].join('\n')
}

/**
 * Что уйдёт в системный промпт для обращения — без сессии и модели.
 * Нужно диагносте (`--support-check`) и тестам: оверлей должен быть виден текстом.
 */
export function supportPromptPreview(ticketId, { cwd = process.cwd(), hasFaq = true, hasTracker = true } = {}) {
  const got = supportTicket(ticketId, cwd)
  if (got.error) return { error: got.error }
  const users = supportUsers(cwd)
  const user = supportUserOf(got.ticket, users.users)
  return {
    ticket: got.ticket,
    user,
    usersError: users.error,
    text: supportInstructionText({ ticket: got.ticket, user, hasFaq, hasTracker }),
  }
}

/** Короткая тема обращения из первого сообщения: первая фраза, ужатая до 60 символов. */
export function supportIntakeSubject(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return 'Обращение без описания'
  const first = /^[^.!?…]*[.!?…]?/.exec(clean)?.[0]?.trim() || clean
  const short = first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first
  return short.charAt(0).toUpperCase() + short.slice(1)
}

/**
 * Промпт **первого** обращения: тикета ещё нет, пользователь только что написал.
 *
 * Это и есть нормальный вход в поддержку: номер обращения пользователь не знает и
 * вводить его не должен — номер присваивает поддержка (инструмент `support_create_ticket`),
 * а нужен он для ссылок в задаче разработки и в следующих сообщениях.
 */
export function supportIntakeInstructionText({ user, userKey, hasFaq, hasTracker, hasStore }) {
  const indent = (text) => text.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n')
  const faqRule = hasFaq
    ? 'Вопросы про поведение dsh-term проверяй по базе FAQ: `rag_search` (база `support`). '
      + 'Ссылайся на заметку и строки, цитируй дословно 1–2 фрагмента.'
    : 'База FAQ в этой сессии не подключена — отвечай по своим знаниям и честно скажи об этом.'
  const owner = user
    ? `${supportUserLine(user, userKey)} · id для инструмента: ${user.id}`
    : `пользователь: ${userKey || 'гость'} — карточки нет. Версию dsh-term, ОС и прочее уточняй `
      + 'в ответе, не выдумывай.'
  const ownerLine = owner.charAt(0).toUpperCase() + owner.slice(1)
  // Образец описания задачи: у первого обращения ещё нет переписки, поэтому «Симптом»
  // заполняется дословной фразой пользователя, а не выдуманным пересказом.
  const template = [
    '## Откуда',
    '- обращение поддержки: <номер, который вернул support_create_ticket>',
    `- ${supportUserLine(user, userKey || 'гость')}`,
    '',
    '## Симптом',
    '(дословная фраза пользователя из чата)',
    '',
    '## Диагноз',
    '(причина: код, конфигурация, документация или окружение пользователя)',
    '',
    '## Что сделать',
    '- [ ] (правка в коде / сообщение об ошибке / заметка в FAQ)',
    '',
    '## Как проверить',
    '(шаги воспроизведения и ожидаемый результат)',
  ].join('\n')
  const registryBlock = hasStore
    ? [
      '1) Сначала заведи само обращение:',
      '   mcp__support__support_create_ticket(subject: "<тема до 60 символов>",',
      '     message: "<сообщение пользователя дословно>", user_id: "<id или пусто>")',
      '   Номер обращения (T-…) — только из ответа инструмента. Не выдумывай его.',
    ].join('\n')
    : [
      '1) MCP поддержки в сессии нет — обращение не заводи. Скажи об этом и дай текст',
      '   обращения блоком «Новое обращение:» (тема + сообщение пользователя).',
    ].join('\n')
  const taskBlock = hasTracker
    ? [
      '2) Затем задачу в разработку одним вызовом:',
      `   mcp__sltracker__create_task(queue: "${SUPPORT_DEV_QUEUE}",`,
      `     title: "[${SUPPORT_DEV_TAG}] <что починить, коротко>",`,
      '     description: <markdown по шаблону ниже>)',
      `   Заголовок ОБЯЗАТЕЛЬНО начинается с "${SUPPORT_DEV_TAG}" — тегов у трекера нет,`,
      '   префикс в заголовке и есть тег.',
      'Шаблон описания (подставь факты, ничего не выдумывай):',
      indent(template),
      'В конце ответа — две строки: «Обращение: T-<номер>» и',
      '«Задача в разработку: INFRA-<номер> — <заголовок>». Если дефекта нет:',
      '«Задача в разработку: не требуется — <причина>».',
    ].join('\n')
    : [
      '2) Трекер не подключён (нет токена): задачу дай текстом последним блоком',
      `   «Задача в разработку (${SUPPORT_DEV_QUEUE}):» с заголовком «[${SUPPORT_DEV_TAG}] …».`,
      indent(template),
      'В конце ответа — строка «Обращение: T-<номер>», если обращение заведено.',
    ].join('\n')
  return [
    'РЕЖИМ ТЕХПОДДЕРЖКИ dsh-term — ПЕРВОЕ ОБРАЩЕНИЕ. Ты — инженер поддержки продукта dsh-term',
    '(терминальный CLI для DeepSeek Harness). Обращения ещё нет: пользователь только что написал',
    'в чат, его сообщение придёт следующим.',
    '',
    `ДАННЫЕ: обращения нет. ${ownerLine}`,
    'Всё, что известно о проблеме, — сообщение пользователя. Не придумывай версии, ОС, номера и цитаты.',
    '',
    'КАК ОТВЕЧАТЬ:',
    '1. Сразу по делу: что происходит, почему, что сделать — шагами. Без «здравствуйте, спасибо за обращение».',
    `2. ${faqRule}`,
    '3. Факты о пользователе бери из блока выше или из `mcp__support__support_get_user`; чего нет — не сочиняй.',
    '4. Если ответа нет ни в FAQ, ни в данных — скажи это прямо, первой строкой ответа:',
    '   «в базе и в обращении этого нет», назови, какие данные нужны (лог, шаги, версия).',
    '5. Вопросы не про dsh-term — вежливо верни к теме поддержки.',
    '6. Не обещай сроки и не придумывай номера задач, которых не создал.',
    '',
    'ПОСЛЕ ОТВЕТА — ОФОРМИТЬ ОБРАЩЕНИЕ И ЗАДАЧУ:',
    registryBlock,
    taskBlock,
  ].join('\n')
}

/** Превью промпта первого обращения — для `--support-check new` и тестов. */
export function supportIntakePreview({ cwd = process.cwd(), userKey = '', hasFaq = true, hasTracker = true, hasStore = true } = {}) {
  const users = supportUsers(cwd)
  let user = null
  let userError = users.error
  if (userKey) {
    user = users.users.find((u) => String(u.id).toLowerCase() === String(userKey).toLowerCase()
      || String(u.email ?? '').toLowerCase() === String(userKey).toLowerCase()
      || String(u.name ?? '').toLowerCase() === String(userKey).toLowerCase()) ?? null
    if (!user && !userError) {
      const known = users.users.map((u) => `${u.id} (${u.name})`).join(', ')
      userError = `пользователь не найден: ${userKey}${known ? ` · известные: ${known}` : ''}`
    }
  }
  return {
    user,
    userError,
    subject: 'тема будет из первого сообщения пользователя',
    text: supportIntakeInstructionText({ user, userKey, hasFaq, hasTracker, hasStore }),
  }
}
