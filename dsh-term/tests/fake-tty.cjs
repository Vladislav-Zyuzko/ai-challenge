// Тестовый преload: включает «TTY» для stdout, чтобы в пайпе прогнать живой
// счётчик токенов и анимацию «Deep diving…» — байты ловятся тестом и
// разбираются симулятором терминала (tests/render-screen.test.mjs).
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
Object.defineProperty(process.stdout, 'columns', {
  value: Number(process.env.DSH_TEST_COLS || 80),
  configurable: true,
})
