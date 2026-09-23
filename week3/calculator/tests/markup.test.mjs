// T5. Статические проверки файлов продукта: node:test + node:assert/strict + node:fs.
// Никакого DOM и браузера: HTML и CSS читаются с диска.
// Пути строятся только через new URL(..., import.meta.url), поэтому cwd не важен.
// Канонический прогон из папки продукта:
//   node --test-isolation=none --test tests/markup.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const HTML_URL = new URL('../index.html', import.meta.url);
const CSS_URL = new URL('../styles.css', import.meta.url);
const CALCULATOR_URL = new URL('../src/calculator.js', import.meta.url);
const APP_URL = new URL('../src/app.js', import.meta.url);
const TESTS_URL = new URL('../tests/', import.meta.url);
const ROOT_URL = new URL('../', import.meta.url);

const html = readFileSync(HTML_URL, 'utf8');
const css = readFileSync(CSS_URL, 'utf8');
const calculatorSource = readFileSync(CALCULATOR_URL, 'utf8');
const appSource = readFileSync(APP_URL, 'utf8');

// Ключи движка (T1), а не подписи клавиш (T3). Ровно 17 значений.
const EXPECTED_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '+', '-', '*', '/', '=', 'C'];

// Подписи-глифы операций: × = U+00D7, ÷ = U+00F7, − = U+2212.
const GLYPH_MULTIPLY = '\u00D7';
const GLYPH_DIVIDE = '\u00F7';
const GLYPH_MINUS = '\u2212';
const GLYPH_KEYS_RE = new RegExp(`data-key\\s*=\\s*"[${GLYPH_MULTIPLY}${GLYPH_DIVIDE}${GLYPH_MINUS}]"`);

// Регулярки намеренно не зависят от порядка атрибутов в теге <button>.
const BUTTON_TAG_RE = /<button\b[^>]*>/gi;
const BUTTON_WITH_TEXT_RE = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
const DATA_KEY_ATTR_RE = /(?:^|\s)data-key\s*=\s*"([^"]*)"/;

/** Значение атрибута data-key в строке тега либо undefined, если атрибута нет. */
function extractDataKey(tag) {
  const match = DATA_KEY_ATTR_RE.exec(tag);
  return match === null ? undefined : match[1];
}

// ---------------------------------------------------------------------------
// I6 — контейнеры разметки
// ---------------------------------------------------------------------------

test('I6: в index.html есть элементы id="display" и id="keypad"', () => {
  assert.match(html, /\bid\s*=\s*"display"/, 'нет элемента id="display"');
  assert.match(html, /\bid\s*=\s*"keypad"/, 'нет элемента id="keypad"');
});

// ---------------------------------------------------------------------------
// I6 — ровно 17 клавиш, у каждой есть data-key, набор значений точный
// ---------------------------------------------------------------------------

test('I6: в index.html ровно 17 кнопок с data-key, множество значений РАВНО набору ключей движка', () => {
  const buttons = html.match(BUTTON_TAG_RE) ?? [];
  assert.equal(buttons.length, 17, `найдено <button>: ${buttons.length}, ожидалось ровно 17`);

  const values = buttons.map((tag, index) => {
    const key = extractDataKey(tag);
    assert.notEqual(key, undefined, `кнопка #${index + 1} без data-key: ${tag}`);
    return key;
  });

  // Ни одного data-key за пределами кнопок: суммарно их тоже 17.
  const totalDataKeys = html.match(/\bdata-key\s*=/g) ?? [];
  assert.equal(totalDataKeys.length, 17, `всего data-key в разметке: ${totalDataKeys.length}, ожидалось 17`);

  // Дубль уменьшает мощность множества — набор перестаёт быть «ровно 17».
  assert.equal(new Set(values).size, values.length, 'значения data-key дублируются');

  // Сравниваем отсортированные множества: лишний или пропущенный ключ валит тест.
  assert.deepEqual([...values].sort(), [...EXPECTED_KEYS].sort());
});

// ---------------------------------------------------------------------------
// I6, стык T1↔T3 — data-key это ключ движка, подписи только видимый текст
// ---------------------------------------------------------------------------

test('I6 (стык T1↔T3): data-key="*"→"×", "/"→"÷", "-"→"−"; глифов в data-key нет', () => {
  const textByKey = new Map();
  for (const match of html.matchAll(BUTTON_WITH_TEXT_RE)) {
    const key = extractDataKey(match[0]);
    if (key !== undefined) {
      textByKey.set(key, match[1].replace(/<[^>]*>/g, '').trim());
    }
  }

  assert.ok(textByKey.has('*'), 'нет кнопки data-key="*"');
  assert.ok(textByKey.has('/'), 'нет кнопки data-key="/"');
  assert.ok(textByKey.has('-'), 'нет кнопки data-key="-"');

  assert.equal(textByKey.get('*'), GLYPH_MULTIPLY, 'видимый текст кнопки data-key="*" должен быть "×"');
  assert.equal(textByKey.get('/'), GLYPH_DIVIDE, 'видимый текст кнопки data-key="/" должен быть "÷"');
  assert.equal(textByKey.get('-'), GLYPH_MINUS, 'видимый текст кнопки data-key="-" должен быть "−"');

  // Подписи-глифы не должны подменять ключи движка.
  assert.doesNotMatch(html, GLYPH_KEYS_RE, 'глиф ×, ÷ или − не должен быть значением data-key');
});

// ---------------------------------------------------------------------------
// I1, I6 — только локальные подключения, без inline-обработчиков
// ---------------------------------------------------------------------------

test('I1/I6: подключены только ./styles.css и ./src/app.js, без внешних ссылок и inline-обработчиков', () => {
  assert.match(
    html,
    /<link\b[^>]*\brel\s*=\s*"stylesheet"[^>]*\bhref\s*=\s*"\.\/styles\.css"[^>]*>/,
    'нет <link rel="stylesheet" href="./styles.css">',
  );
  assert.match(
    html,
    /<script\b[^>]*\btype\s*=\s*"module"[^>]*\bsrc\s*=\s*"\.\/src\/app\.js"[^>]*>\s*<\/script>/,
    'нет <script type="module" src="./src/app.js"></script>',
  );

  for (const [name, text] of [['index.html', html], ['styles.css', css]]) {
    assert.doesNotMatch(text, /https?:\/\//i, `${name}: найдена внешняя ссылка http:// или https://`);
    assert.doesNotMatch(text, /@import/i, `${name}: найден @import`);
    assert.doesNotMatch(text, /url\(\s*["']?https?:/i, `${name}: найден url(http...)`);
  }

  // Inline-обработчики вида onclick= / onsubmit=. "content=" у <meta> не считается:
  // шаблон требует начало атрибута на "on".
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'index.html: найден inline-обработчик (onclick=/onsubmit=/...)');
});

// ---------------------------------------------------------------------------
// I1, I5 — чистота модулей: DOM только в адаптере, сети нет нигде
// ---------------------------------------------------------------------------

test('I1/I5: src/calculator.js без document/window, оба src-модуля без сети', () => {
  assert.doesNotMatch(
    calculatorSource,
    /\b(?:document|window)\b/,
    'src/calculator.js не должен обращаться к document/window',
  );
  assert.doesNotMatch(
    calculatorSource,
    /\b(?:fetch|XMLHttpRequest|WebSocket)\b/,
    'src/calculator.js не должен использовать сеть',
  );
  // app.js — адаптер: document там допустим, сеть — нет.
  assert.doesNotMatch(
    appSource,
    /\b(?:fetch|XMLHttpRequest|WebSocket)\b/,
    'src/app.js не должен использовать сеть',
  );
});

// ---------------------------------------------------------------------------
// I1, критерий 4 — ноль зависимостей и ноль сборки
// ---------------------------------------------------------------------------

test('I1 (критерий 4): в корне нет package.json и node_modules, в tests/ только .mjs', () => {
  assert.equal(existsSync(new URL('../package.json', import.meta.url)), false, 'package.json не должен существовать');
  assert.equal(existsSync(new URL('../node_modules', import.meta.url)), false, 'node_modules не должен существовать');

  const entries = readdirSync(TESTS_URL, { withFileTypes: true });
  assert.ok(entries.length > 0, 'каталог tests/ пуст');
  const offenders = entries
    .filter((entry) => !(entry.isFile() && entry.name.endsWith('.mjs')))
    .map((entry) => entry.name);
  assert.deepEqual(offenders, [], `в tests/ допустимы только .mjs-файлы, найдено: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// I5 — канонический запуск не требует установки
// ---------------------------------------------------------------------------

test('I5: нет lock-файлов и конфигов сборщиков (vite/webpack)', () => {
  for (const name of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']) {
    assert.equal(existsSync(new URL(name, ROOT_URL)), false, `найден lock-файл ${name}`);
  }

  const configRe = /^(?:vite|webpack)\.config\./;
  const offenders = readdirSync(ROOT_URL, { withFileTypes: true })
    .filter((entry) => configRe.test(entry.name))
    .map((entry) => entry.name);
  assert.deepEqual(offenders, [], `найден конфиг сборщика: ${offenders.join(', ')}`);
});
