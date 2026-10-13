// Лимит контекста: что объявлено на сервисе и что реально происходит с длинным запросом.
//
// Вопрос дня — «базовые ограничения (rate limit / max context)». Здесь проверяется,
// где именно живёт ограничение контекста. Наивное ожидание: раз в конфиге сервиса
// написано `max_input_tokens: 8192`, длинный запрос получит отказ. Замер показывает
// другое, и это важно понимать, чтобы не считать сервис защищённым там, где он не защищает.
//
// Проверяется три уровня:
//   1. сервис — объявленный лимит (8192) и его фактическое поведение;
//   2. модель `qwen3:8b` — её окно 4096 токенов (заводское для qwen3 в Ollama);
//   3. модель `rag-brief:8b` — её окно 8192 токенов (задано в Modelfile, день 29).
// Если окно меньше промпта, Ollama молча обрезает начало, и это видно по
// `prompt_eval_count`: он упирается в размер окна, а не в длину запроса.
import { chat, hr, parseArgs, round, saveJson, settings } from './env.mjs';

const args = parseArgs(process.argv);
const cfg = settings(args);
const target = Number(args.tokens ?? 5000);
// Простой повтор слова даёт предсказуемую оценку: одно английское слово ≈ 1 токен.
const filler = `${'context '.repeat(target)}\n\nОтветь одним словом: ок`;
const observed = [];

function record(title, detail, ok = true) {
  console.log(`  ${ok ? '·' : '!'} ${title}: ${detail}`);
  observed.push({ title, detail, ok });
}

hr(`Контекст: запрос примерно на ${target} токенов`);

// 1. Через сервис: что он делает с запросом длиннее объявленного лимита.
{
  const service = await chat({ base: cfg.base, key: cfg.key, model: 'qwen3-8b',
                               prompt: filler, maxTokens: 8, timeoutMs: 1800000 });
  const tokens = service.parsed?.usage?.prompt_tokens ?? 0;
  record('сервис (объявлено max_input_tokens 8192)',
         `HTTP ${service.status} · токенов промпта ${tokens} · ${round(service.seconds)} с`,
         service.status === 200);
}

// 2 и 3. Напрямую в Ollama: видно окно каждой модели.
for (const model of ['qwen3:8b', 'rag-brief:8b', 'rag-brief-q8:8b']) {
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, think: false,
                           messages: [{ role: 'user', content: filler }],
                           options: { num_predict: 4 } }),
  });
  const data = await response.json().catch(() => ({}));
  const seconds = round((Date.now() - started) / 1000);
  if (response.status !== 200) {
    record(`${model} напрямую`, `HTTP ${response.status} · ${String(data.error).slice(0, 80)}`, false);
    continue;
  }
  const evaluated = data.prompt_eval_count ?? 0;
  const cut = evaluated < target * 0.9;
  record(`${model} напрямую`,
         `токенов промпта ${evaluated} из ~${target}` +
         (cut ? ' — окно меньше запроса, начало обрезано' : ' — запрос вошёл целиком') +
         ` · ${seconds} с`,
         !cut);
}

hr('Вывод');
console.log('Ограничение контекста в этой схеме держит модель, а не сервисный слой:');
console.log('сервис объявляет лимит, но не отклоняет длинный запрос — отказ приходит');
console.log('только от окна модели, и приходит он молчаливой обрезкой, а не ошибкой.');

const path = saveJson('context.json', { target, fillerChars: filler.length, observed });
console.log(`результат: ${path}`);
