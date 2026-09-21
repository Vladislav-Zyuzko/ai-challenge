// Тонкая связка DOM ↔ логика. Бизнес-правил здесь нет: движок считает,
// этот файл только передаёт ему клавиши и пишет готовую строку в дисплей.

import { createCalculator } from './calculator.js';

const calculator = createCalculator();
const display = document.getElementById('display');
const keypad = document.getElementById('keypad');

// Стартовое состояние отрисовывается один раз.
display.textContent = calculator.display;

// Один слушатель на контейнер клавиатуры: ключ берётся из data-key кнопки.
keypad.addEventListener('click', (event) => {
  const key = event.target.closest('[data-key]')?.dataset.key;
  if (key === null || key === undefined) {
    return;
  }
  calculator.press(key);
  display.textContent = calculator.display;
});
