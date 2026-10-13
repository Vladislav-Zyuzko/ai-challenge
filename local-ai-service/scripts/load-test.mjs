// Нагрузка: сколько запросов сервис держит и что происходит с очередью.
//
// На CPU это главный вопрос дня. Генерация идёт ~7 токенов в секунду, поэтому
// параллельные запросы не ускоряются, а делят одно и то же время процессора:
// проверяется не «стало быстрее», а «не падает ли и не растёт ли задержка
// неограниченно». Метрики: коды ответов, p50/p95 времени, суммарная пропускная
// способность.
//
// Отдельно считается p95: среднее на таких прогонах врёт, потому что один
// запрос, попавший в хвост очереди, тянет среднее вверх и прячет картину.
import { chat, hr, parseArgs, percentile, round, saveJson, settings } from './env.mjs';

const args = parseArgs(process.argv);
const cfg = settings(args);
const levels = (args.levels ?? '1,2,4,8').split(',').map((value) => Number(value.trim()));
const rounds = Number(args.rounds ?? 3);
const prompt = args.prompt ?? 'Ответь одним словом: ок';
const maxTokens = Number(args['max-tokens'] ?? 8);
const model = args.model ?? cfg.model;

hr('Нагрузка на сервис');
console.log(`модель: ${model} · уровни параллелизма: ${levels.join(', ')} · раундов на уровень: ${rounds}`);
console.log(`запрос: «${prompt}», максимум ${maxTokens} токенов ответа`);

// Прогрев. Без него первый уровень платит за загрузку весов с диска (на этой
// машине это ~10 секунд) и портит p95 — а меряется здесь поведение под нагрузкой,
// а не скорость диска.
if (!args['no-warmup']) {
  const warm = await chat({ base: cfg.base, key: cfg.key, model, prompt: 'ок', maxTokens: 1 });
  console.log(`прогрев: HTTP ${warm.status} за ${round(warm.seconds)} с`);
}

const summary = [];
for (const level of levels) {
  const times = [];
  const codes = {};
  let totalWall = 0;
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    const started = Date.now();
    const batch = await Promise.all(
      Array.from({ length: level }, () => chat({ base: cfg.base, key: cfg.key, model, prompt, maxTokens })),
    );
    const wall = (Date.now() - started) / 1000;
    totalWall += wall;
    for (const item of batch) {
      // Время отказа (429 приходит мгновенно) не должно попадать в перцентили
      // успешных ответов: иначе p50 «улучшается» от того, что сервис отказывает.
      if (item.status === 200) times.push(item.seconds);
      codes[item.status] = (codes[item.status] ?? 0) + 1;
    }
    const perSecond = round(level / wall);
    console.log(`  параллельно ${level}: раунд ${attempt + 1} — ${round(wall)} с, ` +
                `${perSecond} ответов/с, коды ${JSON.stringify(codes)}`);
  }
  const ok = codes[200] ?? 0;
  const refused = codes[429] ?? 0;
  const entry = {
    concurrency: level,
    requests: level * rounds,
    codes,
    ok,
    refused,
    seconds_p50: round(percentile(times, 50)),
    seconds_p95: round(percentile(times, 95)),
    seconds_max: round(Math.max(...times)),
    // Пропускная способность — это УСПЕШНЫЕ запросы, делённые на реальное время
    // прогона. Отказы 429 в неё не входят: сосчитать отказ за ответ — значит
    // показать, что сервис «держит нагрузку», когда он её отвергает.
    throughput_per_second: round(ok / totalWall),
  };
  summary.push(entry);
  console.log(`  ── параллельно ${level}: успешных ${ok}/${entry.requests} · p50 ${entry.seconds_p50} с · ` +
              `p95 ${entry.seconds_p95} с · ${entry.throughput_per_second} ответов/с · отказов ${refused}`);
}

hr('Итог');
console.log('| Параллельно | Запросов | Успешных | Отказов | p50, с | p95, с | Максимум, с | Ответов/с |');
console.log('|---|---|---|---|---|---|---|---|');
for (const row of summary) {
  console.log(`| ${row.concurrency} | ${row.requests} | ${row.ok} | ${row.refused} | ` +
              `${row.seconds_p50} | ${row.seconds_p95} | ${row.seconds_max} | ${row.throughput_per_second} |`);
}

const path = saveJson('load.json', { model, prompt, maxTokens, rounds, results: summary });
console.log(`\nрезультат: ${path}`);
