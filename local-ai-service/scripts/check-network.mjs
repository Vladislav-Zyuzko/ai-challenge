// Проверка доступа по сети (день 30, пункт «доступ к модели по сети»).
//
// Проверяется не «работает ли curl на localhost», а четыре разные вещи:
//   1. сервис слушает сетевой интерфейс, а не только петлю;
//   2. запрос приходит из другого сетевого стека (контейнер) — это настоящий
//      доступ по сети, а не обращение к самому себе;
//   3. без ключа сервис отказывает (401) — наружу смотрит не модель, а сервис;
//   4. сам Ollama снаружи недоступен: порт 11434 остаётся приватным.
//
// Четвёртый пункт — главный. Если он провалится, сервисный слой можно обойти
// вместе с ключами и лимитами, и никакой rate limit уже не важен.
import { execFileSync } from 'node:child_process';
import { chat, hr, parseArgs, round, saveJson, settings } from './env.mjs';

const args = parseArgs(process.argv);
const cfg = settings(args);
const results = [];

async function probe(title, url, key, { model = cfg.model, prompt = 'Ответь одним словом: ок', expect } = {}) {
  const answer = await chat({ base: url, key, model, prompt, maxTokens: 8, timeoutMs: 300000 });
  const ok = expect ? expect(answer.status) : answer.status === 200;
  const mark = ok ? 'ок' : 'НЕ ТАК';
  const retry = answer.retryAfter ? ` · retry-after=${answer.retryAfter}` : '';
  console.log(`  [${mark}] ${title}: HTTP ${answer.status || '—'} за ${round(answer.seconds)} с${retry}`);
  if (!ok && answer.text) console.log(`        ответ: ${answer.text.slice(0, 160)}`);
  results.push({ title, url, status: answer.status, seconds: round(answer.seconds), ok,
                 answer: answer.answer.slice(0, 80) });
  return ok;
}

/** Запрос из контейнера: другой сетевой стек, честная проверка «по сети». */
function probeFromContainer(base, key) {
  // Аргументы передаются массивом, а не строкой: execFileSync не запускает оболочку,
  // и склеенная строка превратилась бы в кашу из кавычек и лишних URL.
  const argv = ['run', '--rm', '--add-host=host.docker.internal:host-gateway',
    'curlimages/curl:latest', '-s', '-m', '20', '-w', '%{http_code}', '-o', '/dev/null',
    '-H', `Authorization: Bearer ${key}`, `${base}/v1/models`];
  try {
    const out = execFileSync('docker', argv, { encoding: 'utf8', timeout: 180000 });
    const status = Number(out.trim().slice(-3)) || 0;
    return { status, detail: `HTTP ${status || out.trim()}` };
  } catch (error) {
    return { status: 0, detail: String(error.message).slice(0, 120) };
  }
}

hr('Сервис по сети');
console.log(`адрес сервиса: ${cfg.base}` + (cfg.lanIp ? ` · сетевой адрес: ${cfg.lanIp}` : ''));

await probe('localhost с ключом', cfg.base, cfg.key, { expect: (s) => s === 200 });

// Отказ в доступе: важно, что запрос не доходит до модели, а не каким кодом это
// оформлено. Без базы LiteLLM не умеет проверять виртуальные ключи и на незнакомый
// ключ отвечает 400 «No connected db» вместо 401 — это записано в отчёте как
// известное ограничение, а не спрятано.
for (const [title, key] of [['без заголовка авторизации', null], ['с неверным ключом', 'sk-wrong-key']]) {
  const denied = await chat({ base: cfg.base, key, model: cfg.model, prompt: 'ок', maxTokens: 4 });
  const message = (denied.parsed?.error?.message ?? denied.text).slice(0, 90);
  const ok = denied.status !== 200;
  console.log(`  [${ok ? 'ок' : 'НЕ ТАК'}] ${title}: HTTP ${denied.status || '—'} · ${message}`);
  results.push({ title, url: cfg.base, status: denied.status, ok, detail: message });
}

// Из контейнера: через host.docker.internal, то есть по сети, а не через петлю.
{
  const from = probeFromContainer('http://host.docker.internal:4000', cfg.key);
  const ok = from.status === 200;
  console.log(`  [${ok ? 'ок' : 'НЕ ТАК'}] из контейнера (другой сетевой стек): ${from.detail}`);
  results.push({ title: 'из контейнера', url: 'http://host.docker.internal:4000', ok, status: from.status });
}

if (cfg.lanIp && !cfg.lanIp.startsWith('127.')) {
  // Сетевой адрес проверяется отдельно и может не отвечать: если VPN захватил
  // маршрут к локальной подсети, до своего же адреса не достучаться никому.
  const answer = await chat({ base: `http://${cfg.lanIp}:4000`, key: cfg.key, model: cfg.model,
                              prompt: 'ок', maxTokens: 4, timeoutMs: 15000 });
  const ok = answer.status === 200;
  console.log(`  [${ok ? 'ок' : 'не отвечает'}] сетевой адрес ${cfg.lanIp}: HTTP ${answer.status || '—'}` +
              (ok ? '' : ' — ожидаемо, если VPN забирает маршрут к 10.0.1.0/24'));
  results.push({ title: `сетевой адрес ${cfg.lanIp}`, url: `http://${cfg.lanIp}:4000`, ok, status: answer.status,
                 note: ok ? '' : 'маршрут к подсети перехвачен VPN' });
}

hr('Ollama снаружи');
if (cfg.lanIp && !cfg.lanIp.startsWith('127.')) {
  // Порт модели не должен отвечать по сетевому адресу: иначе сервисный слой обходится.
  const direct = await fetch(`http://${cfg.lanIp}:11434/api/tags`, { signal: AbortSignal.timeout(8000) })
    .then(() => ({ ok: false, detail: 'порт модели доступен снаружи' }),
          (error) => ({ ok: true, detail: `недоступен (${String(error.cause?.code ?? error.name)})` }));
  console.log(`  [${direct.ok ? 'ок' : 'НЕ ТАК'}] прямой доступ к Ollama: ${direct.detail}`);
  results.push({ title: 'Ollama напрямую', url: `http://${cfg.lanIp}:11434`, ok: direct.ok });
}

const failed = results.filter((item) => !item.ok).length;
console.log(`\nитог: проверок ${results.length} · провалено ${failed} (сетевой адрес не в счёт: он помечен)`);
const path = saveJson('network.json', { base: cfg.base, lanIp: cfg.lanIp, results });
console.log(`результат: ${path}`);
process.exit(failed ? 1 : 0);
