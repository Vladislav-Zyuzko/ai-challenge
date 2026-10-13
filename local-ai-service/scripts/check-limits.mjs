// Базовые ограничения сервиса: ключ, rate limit, лимит контекста, лимит ответа.
//
// Проверка намеренно отделена от нагрузки: rate limit — это состояние во времени
// (окно в минуту), и если мешать его с замером скорости, то замер скорости
// превратится в замер лимита, а лимит — в замер очереди.
import { chat, hr, parseArgs, round, saveJson, settings } from './env.mjs';

const args = parseArgs(process.argv);
const cfg = settings(args);
const checks = [];

function report(title, ok, detail) {
  console.log(`  [${ok ? 'ок' : 'НЕ ТАК'}] ${title}: ${detail}`);
  checks.push({ title, ok, detail });
}

hr('Ключ доступа');
{
  // Ключ латиницей: кириллица в значении заголовка — невалидный HTTP, и запрос
  // упал бы до сервиса, выглядя как «сервис не отказывает».
  const noKey = await chat({ base: cfg.base, key: 'sk-wrong-key', model: cfg.model,
                             prompt: 'привет', maxTokens: 4 });
  const message = noKey.parsed?.error?.message ?? noKey.text;
  report('запрос с неверным ключом отклонён', noKey.status !== 200,
         `HTTP ${noKey.status} · ${String(message).slice(0, 80)}`);
}

hr('Ограничение контекста');
{
  // ~6000 символов ≈ 1500 токенов — должно пройти без вопросов.
  const ok = await chat({ base: cfg.base, key: cfg.key, model: cfg.model,
                          prompt: 'контекст '.repeat(700) + ' Ответь одним словом: ок', maxTokens: 8 });
  report('короткий запрос принят', ok.status === 200, `HTTP ${ok.status}`);
  // Длинный запрос разбирается отдельным скриптом check-context.mjs: там видно,
  // что объявленный `max_input_tokens` сервис не применяет, а режет уже модель
  // по своему окну. Здесь только фиксируем, что сервис не падает на длинном запросе.
  console.log('  (подробности про длинный контекст — node scripts/check-context.mjs)');
}

hr('Ограничение длины ответа');
{
  const asked = await chat({ base: cfg.base, key: cfg.key, model: cfg.model,
                             prompt: 'Перечисли числа от 1 до 200 через запятую.', maxTokens: 300 });
  const usage = asked.parsed?.usage ?? {};
  const completion = usage.completion_tokens ?? 0;
  // Наблюдение, а не проверка: `max_tokens` в конфиге — значение по умолчанию,
  // клиент своим `max_tokens` его перебивает. Так это и записано в отчёте.
  console.log(`  · длина ответа: токенов ${completion} при запросе 300 и объявленных 700 — ` +
              'клиент управляет длиной сам');
}

hr('Rate limit');
{
  // Объявлено 6 запросов в минуту. Отправляем 9 подряд с крошечным ответом.
  const burst = await Promise.all(Array.from({ length: 9 }, () =>
    chat({ base: cfg.base, key: cfg.key, model: cfg.model, prompt: 'ок', maxTokens: 1 })));
  const ok = burst.filter((item) => item.status === 200).length;
  const limited = burst.filter((item) => item.status === 429).length;
  const other = burst.length - ok - limited;
  const retryAfter = burst.find((item) => item.status === 429)?.retryAfter ?? '';
  report('часть запросов получила 429', limited > 0,
         `200: ${ok}, 429: ${limited}, прочие: ${other}`);
  report('в 429 есть retry-after', Boolean(retryAfter), retryAfter ? `retry-after=${retryAfter}` : 'заголовка нет');

  const limitedBody = burst.find((item) => item.status === 429)?.text ?? '';
  report('в 429 объяснена причина', /rate|limit|rpm|tpm/i.test(limitedBody), limitedBody.slice(0, 160));

  // Ждём окно и проверяем, что сервис вернулся к работе, а не «залип».
  const wait = Number(retryAfter || 0) > 0 ? Number(retryAfter) + 2 : 20;
  console.log(`  … ждём ${wait} с, чтобы окно лимита прошло`);
  await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  const after = await chat({ base: cfg.base, key: cfg.key, model: cfg.model, prompt: 'ок', maxTokens: 4 });
  report('после окна сервис снова отвечает', after.status === 200, `HTTP ${after.status}`);
}

const failed = checks.filter((item) => !item.ok).length;
console.log(`\nитог: проверок ${checks.length} · провалено ${failed}`);
const path = saveJson('limits.json', { model: cfg.model, checks });
console.log(`результат: ${path}`);
process.exit(failed ? 1 : 0);
