// Тестовый преload: включает «TTY» для stdout, чтобы в пайпе прогнать живой
// счётчик токенов и анимацию «Deep diving…» — байты ловятся тестом и
// разбираются симулятором терминала (tests/render-screen.test.mjs).
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdout, 'columns', {
  value: Number(process.env.DSH_TEST_COLS || 80),
  configurable: true,
})

// DSH_TEST_FAKE_STDIN=1 дополнительно включает TTY-режим ввода: так прогоняется
// интерактивный редактор строки (tests/editor-wrap.test.mjs). На пайпе raw-mode
// недоступен, поэтому setRawMode подменяется заглушкой.
if (process.env.DSH_TEST_FAKE_STDIN === '1') {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdin, 'columns', {
    value: Number(process.env.DSH_TEST_COLS || 80),
    configurable: true,
  })
  process.stdin.setRawMode = () => {}
}
