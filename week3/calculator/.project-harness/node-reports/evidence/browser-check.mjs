// Инструмент проверки T6 (интеграция): реальный браузер через CDP, без установок.
// Запуск: node .dsh-scratch/browser-check.mjs  (сервер и Chrome уже подняты)
// Не является частью продукта: лежит в gitignored .dsh-scratch/.

const base = process.env.CDP_BASE ?? 'http://127.0.0.1:9222';
const expectUrlPart = process.env.PAGE_URL ?? '127.0.0.1:8765';

const expr = `(async () => {
  const click = (k) => {
    const b = document.querySelector('[data-key="' + k + '"]');
    if (!b) throw new Error('нет кнопки data-key=' + k);
    b.click();
  };
  const disp = () => document.getElementById('display').textContent;
  const run = (seq) => { click('C'); for (const k of seq) click(k); return disp(); };
  return JSON.stringify({
    '2+2=': run(['2','+','2','=']),
    '7-9=': run(['7','-','9','=']),
    '6*7=': run(['6','*','7','=']),
    '1/4=': run(['1','/','4','=']),
    '5/0=': run(['5','/','0','=']),
    'C': (() => { click('C'); return disp(); })(),
    buttons: document.querySelectorAll('#keypad button[data-key]').length
  });
})()`;

const list = await (await fetch(`${base}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && (t.url ?? '').includes(expectUrlPart));
if (!page) {
  console.error('Целевая страница не найдена. Открытые таргеты:');
  for (const t of list) console.error(` - ${t.type}: ${t.url}`);
  process.exit(1);
}
console.log(`target: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('WebSocket к CDP не открылся')), { once: true });
});

let seq = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
const result = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
});
ws.close();

if (result.exceptionDetails) {
  console.error('Ошибка в странице:', JSON.stringify(result.exceptionDetails, null, 2));
  process.exit(1);
}

const observed = JSON.parse(result.result.value);
const expected = {
  '2+2=': '4',
  '7-9=': '-2',
  '6*7=': '42',
  '1/4=': '0.25',
  '5/0=': 'Деление на ноль',
  C: '0',
  buttons: 17,
};

let failed = 0;
for (const [key, want] of Object.entries(expected)) {
  const got = observed[key];
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${key} → ${JSON.stringify(got)}${ok ? '' : ` (ожидалось ${JSON.stringify(want)})`}`);
}
console.log(failed === 0 ? 'BROWSER CHECK: PASS' : `BROWSER CHECK: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
