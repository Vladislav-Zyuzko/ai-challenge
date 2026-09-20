/**
 * Чистая логика калькулятора. Без DOM и без сети, ноль зависимостей.
 *
 * Публичный контракт — ровно четыре экспорта:
 *   OPERATIONS, compute, formatNumber, createCalculator.
 */

/** Список поддерживаемых идентификаторов операций. */
export const OPERATIONS = Object.freeze(['add', 'subtract', 'multiply', 'divide']);

// Приватная деталь модуля: символ клавиши → id операции. Наружу не экспортируется.
const OP_BY_SYMBOL = Object.freeze({
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
});

const DIGITS = '0123456789';
const MAX_ENTRY_LENGTH = 15;
const ERROR_BAD_NUMBER = 'Некорректное число';
const ERROR_UNKNOWN_OP = 'Неизвестная операция';
const ERROR_DIVISION_BY_ZERO = 'Деление на ноль';

/**
 * Вычислить a <op> b без округления.
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
export function compute(a, op, b) {
  if (
    typeof a !== 'number' ||
    !Number.isFinite(a) ||
    typeof b !== 'number' ||
    !Number.isFinite(b)
  ) {
    return { ok: false, error: ERROR_BAD_NUMBER };
  }
  if (OPERATIONS.indexOf(op) === -1) {
    return { ok: false, error: ERROR_UNKNOWN_OP };
  }
  if (op === 'divide' && b === 0) {
    return { ok: false, error: ERROR_DIVISION_BY_ZERO };
  }
  switch (op) {
    case 'add':
      return { ok: true, value: a + b };
    case 'subtract':
      return { ok: true, value: a - b };
    case 'multiply':
      return { ok: true, value: a * b };
    default:
      return { ok: true, value: a / b };
  }
}

/**
 * Привести число к строке для дисплея: округление до 12 значащих цифр.
 * @returns {string}
 */
export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Ошибка';
  }
  const r = Number(value.toPrecision(12));
  if (Object.is(r, -0)) {
    return '0';
  }
  return String(r);
}

/**
 * Создать независимый движок калькулятора:
 * метод press(key) и геттер display. Ключи: '0'…'9', '.', '+', '-', '*', '/', '=', 'C'.
 * Незнакомый ключ игнорируется.
 */
export function createCalculator() {
  let display = '0';
  let entry = null; // строка набираемого числа либо null, если дисплей не про ввод
  let value = 0; // числовое значение дисплея, когда entry === null
  let acc = 0; // первый (накопленный) операнд
  let operation = null; // идентификатор отложенной операции
  let failed = false; // режим ошибки

  function reset() {
    display = '0';
    entry = null;
    value = 0;
    acc = 0;
    operation = null;
    failed = false;
  }

  function currentNumber() {
    return entry === null ? value : Number(entry);
  }

  function fail(error) {
    failed = true;
    entry = null;
    value = 0;
    acc = 0;
    operation = null;
    display = error;
  }

  // Считает acc <operation> currentNumber(); при успехе обновляет дисплей.
  function applyPending() {
    const result = compute(acc, operation, currentNumber());
    if (!result.ok) {
      fail(result.error);
      return false;
    }
    acc = result.value;
    value = result.value;
    entry = null;
    display = formatNumber(result.value);
    return true;
  }

  function press(key) {
    if (typeof key !== 'string') {
      return;
    }
    if (failed) {
      // В режиме ошибки работает только полный сброс.
      if (key === 'C') {
        reset();
      }
      return;
    }
    if (key === 'C') {
      reset();
      return;
    }
    if (DIGITS.indexOf(key) !== -1) {
      if (entry === null) {
        entry = key;
      } else if (entry.length >= MAX_ENTRY_LENGTH) {
        return;
      } else if (entry === '0') {
        entry = key;
      } else {
        entry += key;
      }
      display = entry;
      return;
    }
    if (key === '.') {
      if (entry === null) {
        entry = '0.';
      } else if (entry.indexOf('.') !== -1) {
        return;
      } else if (entry.length >= MAX_ENTRY_LENGTH) {
        return;
      } else {
        entry += '.';
      }
      display = entry;
      return;
    }
    const op = OP_BY_SYMBOL[key];
    if (op !== undefined) {
      if (operation === null) {
        // Первая операция подряд: запоминаем, дисплей не меняется.
        acc = currentNumber();
        operation = op;
        entry = null;
        return;
      }
      if (entry === null) {
        // Операция сразу за операцией: предыдущая заменяется.
        operation = op;
        return;
      }
      if (!applyPending()) {
        return;
      }
      operation = op;
      return;
    }
    if (key === '=') {
      if (operation === null || entry === null) {
        // Нет операции или второе число не введено — игнор.
        return;
      }
      const result = compute(acc, operation, currentNumber());
      if (!result.ok) {
        fail(result.error);
        return;
      }
      value = result.value;
      entry = null;
      operation = null;
      acc = 0;
      display = formatNumber(result.value);
    }
  }

  return {
    press,
    get display() {
      return display;
    },
  };
}
