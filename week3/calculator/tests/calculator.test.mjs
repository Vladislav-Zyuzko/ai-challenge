// T4. Автотесты чистой логики калькулятора.
// Инструмент: Node v24 (встроенный node:test + node:assert/strict), ноль зависимостей.
// Инварианты: I2 (состав экспортов и операций), I3 (деление на ноль),
// I4 (форматирование чисел), I5 (логика без DOM), критерий 2 (сценарии движка).
// Канонический прогон из папки продукта:
//   node --test-isolation=none --test tests/calculator.test.mjs
// (обычный `node --test` в этой среде падает `spawn EPERM`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as calc from '../src/calculator.js';
import { OPERATIONS, compute, formatNumber, createCalculator } from '../src/calculator.js';

// Ожидаемый набор экспортов, отсортированный ровно так, как его вернёт sort().
const EXPECTED_EXPORTS = ['OPERATIONS', 'compute', 'createCalculator', 'formatNumber'];
const EXPECTED_OPERATIONS = ['add', 'subtract', 'multiply', 'divide'];
const ALL_KEYS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '+', '-', '*', '/', '=', 'C'];

/** Прогнать последовательность клавиш и вернуть строку дисплея. */
function run(keys) {
  const calculator = createCalculator();
  for (const key of keys) {
    calculator.press(key);
  }
  return calculator.display;
}

// ---------------------------------------------------------------------------
// I2 — состав экспортов и списка операций
// ---------------------------------------------------------------------------

test('I2: набор экспортов модуля равен ровно [OPERATIONS, compute, createCalculator, formatNumber]', async () => {
  const module = await import('../src/calculator.js');
  assert.deepEqual(Object.keys(module).sort(), EXPECTED_EXPORTS, 'пятый экспорт валит тест');
  assert.equal(Object.keys(module).length, 4);
  assert.equal(Object.keys(calc).length, 4);
});

test('I2: OPERATIONS — ровно четыре id и массив заморожен', () => {
  assert.deepEqual(OPERATIONS, EXPECTED_OPERATIONS);
  assert.equal(OPERATIONS.length, 4, 'пятая операция валит тест');
  assert.equal(Object.isFrozen(OPERATIONS), true);
});

test('I2: каждая из четырёх операций даёт верный результат', () => {
  assert.deepEqual(compute(2, 'add', 2), { ok: true, value: 4 });
  assert.deepEqual(compute(7, 'subtract', 9), { ok: true, value: -2 });
  assert.deepEqual(compute(6, 'multiply', 7), { ok: true, value: 42 });
  assert.deepEqual(compute(1, 'divide', 4), { ok: true, value: 0.25 });
});

test('I2: незнакомые операции (символы, пустая строка, undefined) → "Неизвестная операция"', () => {
  for (const op of ['+', 'pow', '', undefined]) {
    assert.deepEqual(
      compute(4, op, 2),
      { ok: false, error: 'Неизвестная операция' },
      `op=${String(op)} должен быть отвергнут как неизвестная операция`,
    );
  }
  // Символы + - * / — это клавиши движка, а не id операций: для compute они неизвестны.
  for (const op of ['-', '*', '/', 'ADD']) {
    assert.deepEqual(compute(4, op, 2), { ok: false, error: 'Неизвестная операция' });
  }
  // Не-число/не-конечное имеет приоритет над неизвестной операцией.
  assert.deepEqual(compute('4', 'pow', 2), { ok: false, error: 'Некорректное число' });
});

// ---------------------------------------------------------------------------
// I3 — деление на ноль
// ---------------------------------------------------------------------------

test('I3: compute(5, "divide", 0) и (5, "divide", -0) → "Деление на ноль" без value', () => {
  for (const divisor of [0, -0]) {
    const result = compute(5, 'divide', divisor);
    assert.deepEqual(result, { ok: false, error: 'Деление на ноль' });
    assert.equal('value' in result, false, 'у ошибки не должно быть поля value');
  }
});

test('I3: движок 5 / 0 = → "Деление на ноль", затем все ключи кроме C игнорируются, C → "0"', () => {
  const calculator = createCalculator();
  for (const key of ['5', '/', '0', '=']) {
    calculator.press(key);
  }
  assert.equal(calculator.display, 'Деление на ноль');

  for (const key of ALL_KEYS) {
    if (key === 'C') {
      continue;
    }
    calculator.press(key);
    assert.equal(calculator.display, 'Деление на ноль', `клавиша "${key}" должна игнорироваться в режиме ошибки`);
  }

  calculator.press('C');
  assert.equal(calculator.display, '0');
});

// ---------------------------------------------------------------------------
// I4 — форматирование чисел
// ---------------------------------------------------------------------------

test('I4: formatNumber округляет до 12 значащих цифр', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(1 / 3), '0.333333333333');
  assert.equal(formatNumber(1 / 7), '0.142857142857');
  assert.equal(formatNumber(1e-14), '1e-14');
  assert.equal(formatNumber(-2), '-2');
  assert.equal(formatNumber(-0), '0');
});

test('I4: formatNumber для не-числа/NaN/Infinity → "Ошибка"', () => {
  for (const value of [NaN, Infinity, -Infinity, '1', null, undefined]) {
    assert.equal(formatNumber(value), 'Ошибка', `значение ${String(value)}`);
  }
});

// ---------------------------------------------------------------------------
// I5 — логика без DOM (статическая проверка исходника + импорт в Node)
// ---------------------------------------------------------------------------

test('I5: src/calculator.js не содержит document/window и импортируется в Node без DOM', () => {
  const url = new URL('../src/calculator.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.doesNotMatch(source, /\bdocument\b/, 'логика не должна обращаться к document');
  assert.doesNotMatch(source, /\bwindow\b/, 'логика не должна обращаться к window');
  assert.equal(typeof globalThis.document, 'undefined', 'в Node нет DOM');
  assert.equal(typeof compute, 'function');
  assert.equal(typeof formatNumber, 'function');
  assert.equal(typeof createCalculator, 'function');
});

// ---------------------------------------------------------------------------
// Критерий 2 — сценарии движка через press/display
// ---------------------------------------------------------------------------

test('Критерий 2: старт "0", ведущий ноль заменяется', () => {
  assert.equal(run([]), '0');
  assert.equal(run(['0', '5']), '5');
  assert.equal(run(['0', '0', '7']), '7');
});

test('Критерий 2: 0.1 + 0.2 = "0.3"', () => {
  assert.equal(run(['0', '.', '1', '+', '0', '.', '2', '=']), '0.3');
});

test('Критерий 2: C после ввода → "0"', () => {
  assert.equal(run(['1', '2', '+', '3', 'C']), '0');
});

test('Критерий 2: повторный "=" не повторяет операцию', () => {
  const calculator = createCalculator();
  for (const key of ['2', '+', '2', '=']) {
    calculator.press(key);
  }
  assert.equal(calculator.display, '4');
  calculator.press('=');
  assert.equal(calculator.display, '4');
});

test('Критерий 2: "=" сразу после операции игнорируется (2 + = → "2")', () => {
  assert.equal(run(['2', '+', '=']), '2');
});

test('Критерий 2: операция сразу за операцией заменяет предыдущую (2 + - 3 = → "-1")', () => {
  assert.equal(run(['2', '+', '-', '3', '=']), '-1');
});

test('Критерий 2: цепочка 2 + 3 + 4 = → "9"', () => {
  assert.equal(run(['2', '+', '3', '+', '4', '=']), '9');
});

test('Критерий 2: цифра после "=" начинает новое число (2 + 2 = 7 → "7")', () => {
  assert.equal(run(['2', '+', '2', '=', '7']), '7');
});

test('Критерий 2: одна точка на число, точка на новом числе', () => {
  assert.equal(run(['1', '.', '.', '5']), '1.5');
  assert.equal(run(['.', '5']), '0.5');
});

test('Критерий 2: не более 15 знаков ввода (16 цифр → ровно 15)', () => {
  const sixteen = '1234567890123456';
  assert.equal(sixteen.length, 16);
  assert.equal(run(sixteen.split('')), '123456789012345');
  assert.equal(run(sixteen.split('')).length, 15);
});

test('Критерий 2: незнакомый ключ игнорируется, дисплей не меняется', () => {
  const calculator = createCalculator();
  for (const key of ['1', '2']) {
    calculator.press(key);
  }
  assert.equal(calculator.display, '12');
  for (const key of ['x', 'Enter', '', 'Backspace', '5x']) {
    calculator.press(key);
    assert.equal(calculator.display, '12', `ключ "${key}" должен игнорироваться`);
  }
});

// ---------------------------------------------------------------------------
// Стык I3/I4 — press устойчив к любому ключу
// ---------------------------------------------------------------------------

test('I3/I4: press не бросает исключений ни на одном ключе набора и на мусорных ключах', () => {
  const calculator = createCalculator();
  const garbage = [undefined, null, 0, 1, {}, [], () => {}, Symbol('k'), 'x', 'Enter', 'F9', '5x', ' '];
  for (const key of [...ALL_KEYS, ...garbage]) {
    assert.doesNotThrow(() => calculator.press(key), `press(${String(key)}) не должен бросать`);
    assert.equal(typeof calculator.display, 'string');
  }
  // После мусора движок остаётся рабочим.
  calculator.press('C');
  for (const key of ['2', '+', '2', '=']) {
    calculator.press(key);
  }
  assert.equal(calculator.display, '4');
});
