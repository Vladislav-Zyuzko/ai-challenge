// Общее для скриптов сервиса: чтение .env, разбор аргументов, замеры.
//
// Отдельный модуль, а не копия в каждом скрипте: проверок три (сеть, нагрузка,
// лимиты), и все они должны ходить к сервису одинаково — иначе результаты
// нельзя сравнивать между собой.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Значения .env как объект. Отсутствующий файл — не ошибка: скрипты берут значения из аргументов. */
export function loadEnv() {
  const path = `${ROOT}/.env`;
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Аргументы вида `--url=http://…` и флаги `--json`. */
export function parseArgs(argv) {
  const args = {};
  for (const item of argv.slice(2)) {
    const eq = item.indexOf('=');
    if (item.startsWith('--') && eq > 0) args[item.slice(2, eq)] = item.slice(eq + 1);
    else if (item.startsWith('--')) args[item.slice(2)] = true;
  }
  return args;
}

/** Настройки по умолчанию: .env → аргументы командной строки. */
export function settings(args) {
  const env = loadEnv();
  return {
    root: ROOT,
    env,
    base: args.url ?? env.SERVICE_URL ?? 'http://127.0.0.1:4000',
    key: args.key ?? env.LITELLM_MASTER_KEY ?? 'sk-local-change-me',
    model: args.model ?? 'qwen3-8b',
    lanIp: args.lan ?? env.LAN_IP ?? '',
    ollama: args.ollama ?? 'http://127.0.0.1:11434',
  };
}

/** Один запрос к сервису. Возвращает код, время и текст — без исключений на HTTP-ошибках.
 *  `key = null` — запрос вообще без заголовка авторизации (проверка «пустит ли»). */
export async function chat({ base, key, model, prompt, maxTokens = 16, timeoutMs = 300000 }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* не JSON — оставим как есть */ }
    return {
      status: response.status,
      seconds: (Date.now() - started) / 1000,
      retryAfter: response.headers.get('retry-after'),
      text,
      parsed,
      answer: parsed?.choices?.[0]?.message?.content ?? '',
    };
  } catch (error) {
    return { status: 0, seconds: (Date.now() - started) / 1000, error: String(error), text: '', answer: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** Перцентиль по «ближайшему рангу»: для десятков замеров этого достаточно и честно. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Сохранить результат прогона, чтобы отчёт дня ссылался на файл, а не на пересказ. */
export function saveJson(name, data) {
  const dir = `${ROOT}/out`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}`;
  writeFileSync(path, JSON.stringify(data, null, 1), 'utf8');
  return path;
}

export function hr(title) {
  console.log(`\n=== ${title} ===`);
}
