// Проверка чата: веб-клиент → сервис → модель (день 30, пункт «с возможностью чата»).
//
// Проверяется именно сквозной путь, а не «контейнер запустился». Open WebUI
// обращается к сервису как обычный OpenAI-клиент с ключом, поэтому ответ здесь
// означает, что работают все три звена: чат, сервисный слой с ключом и модель.
//
// Первый зарегистрированный пользователь в Open WebUI становится администратором,
// поэтому учётка создаётся здесь и лежит в .env (файл не попадает в репозиторий).
import { execFileSync } from 'node:child_process';
import { hr, parseArgs, round, saveJson, settings } from './env.mjs';

const args = parseArgs(process.argv);
const cfg = settings(args);
const webui = args.webui ?? `http://127.0.0.1:${cfg.env.WEBUI_PORT ?? 3000}`;
const email = cfg.env.WEBUI_ADMIN_EMAIL ?? 'admin@local';
const password = cfg.env.WEBUI_ADMIN_PASSWORD ?? '';
const checks = [];

function report(title, ok, detail) {
  console.log(`  [${ok ? 'ок' : 'НЕ ТАК'}] ${title}: ${detail}`);
  checks.push({ title, ok, detail });
}

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${webui}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* не JSON */ }
  return { status: response.status, parsed, text };
}

hr('Веб-чат');
console.log(`чат: ${webui} · сервис: ${cfg.base}`);

// Готовность контейнера: он поднимается десятки секунд и сначала мигрирует базу.
let health = { status: 0 };
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    const response = await fetch(`${webui}/health`, { signal: AbortSignal.timeout(5000) });
    health = { status: response.status, body: await response.text() };
    if (response.status === 200) break;
  } catch { /* ещё не поднялся */ }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
report('чат отвечает', health.status === 200, `HTTP ${health.status} ${health.body ?? ''}`.trim());

if (!password) {
  console.log('  учётка не создана: задайте WEBUI_ADMIN_PASSWORD в .env');
} else {
  // Вход или регистрация: скрипт должен работать и на уже настроенном чате.
  let token = '';
  const signin = await post('/api/v1/auths/signin', { email, password });
  if (signin.status === 200) {
    token = signin.parsed?.token ?? '';
    console.log('  вход существующей учёткой администратора');
  } else {
    const signup = await post('/api/v1/auths/signup', { name: 'admin', email, password });
    token = signup.parsed?.token ?? '';
    report('учётка администратора создана', signup.status === 200,
           `HTTP ${signup.status} · ${signup.parsed?.role ?? signup.text.slice(0, 60)}`);
  }
  report('получен токен чата', Boolean(token), token ? `${token.slice(0, 12)}…` : 'токена нет');

  if (token) {
    const models = await fetch(`${webui}/api/models`, { headers: { Authorization: `Bearer ${token}` } });
    const list = await models.json().catch(() => ({}));
    const names = (list.data ?? []).map((item) => item.id).join(', ');
    report('чат видит модели сервиса', names.includes('rag-brief'), names || 'список пуст');

    const answer = await post('/api/chat/completions', {
      model: 'rag-brief',
      messages: [{ role: 'user', content: 'Ответь одним словом: ок' }],
      max_tokens: 8,
    }, token);
    const text = answer.parsed?.choices?.[0]?.message?.content ?? answer.text;
    report('ответ дошёл через чат', answer.status === 200 && text.length > 0,
           `HTTP ${answer.status} · «${String(text).slice(0, 60)}»`);
  }
}

const failed = checks.filter((item) => !item.ok).length;
console.log(`\nитог: проверок ${checks.length} · провалено ${failed}`);
const path = saveJson('chat.json', { webui, service: cfg.base, checks });
console.log(`результат: ${path}`);
process.exit(failed ? 1 : 0);
