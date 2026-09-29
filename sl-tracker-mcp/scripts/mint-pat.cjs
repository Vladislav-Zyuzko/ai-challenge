/**
 * Одноразовый скрипт: выпустить PAT участника через ОФИЦИАЛЬНЫЙ эндпоинт трекера.
 *
 * Зачем так: `POST /api/tokens` требует cookie-сессию человека, а у нас её нет (вход через
 * Яндекс ID в браузере). Поэтому создаём временную cookie-сессию владельца прямо в БД тем же
 * способом, что и OAuth-колбэк (HMAC-SHA256 от верификатора с SESSION_SECRET), вызываем
 * штатный эндпоинт и удаляем временную сессию.
 *
 * Запускается ВНУТРИ контейнера api (там есть node и модуль pg):
 *   docker cp mint-pat.cjs sl-tracker-api-1:/app/mint-pat.cjs
 *   docker exec sl-tracker-api-1 node /app/mint-pat.cjs
 * Печатает JSON; токен из него кладётся в .env и нигде больше не хранится.
 */
const { Client } = require('pg');
const crypto = require('node:crypto');

(async () => {
  const id = crypto.randomUUID();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const cookieToken = `${id}.${verifier}`;
  const tokenHash = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(verifier)
    .digest('hex');

  const client = new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  await client.connect();

  const owner = await client.query(
    `select u.id, u.display_name
       from access_entries e
       join users u on u.id = e.user_id
      where e.is_instance_owner
      limit 1`,
  );
  if (owner.rowCount === 0) throw new Error('владелец инстанса не найден в access_entries');
  const userId = owner.rows[0].id;

  // Временная cookie-сессия: одна цель — один вызов POST /api/tokens.
  await client.query(
    `insert into sessions (id, user_id, kind, token_hash, expires_at, last_seen_at)
     values ($1, $2, 'cookie', $3, now() + interval '30 minutes', now())`,
    [id, userId, tokenHash],
  );

  const response = await fetch('http://127.0.0.1:3000/api/tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `sl_session=${cookieToken}`,
      // CSRF небезопасных методов с cookie: Origin должен совпасть с APP_BASE_URL.
      Origin: process.env.APP_BASE_URL,
    },
    body: JSON.stringify({ name: 'dsh-mcp', expiresInDays: 365 }),
  });
  const payload = await response.json().catch(() => ({}));
  await client.end();

  if (response.status !== 201) {
    console.error('FAIL', response.status, JSON.stringify(payload));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      status: response.status,
      userId,
      display: owner.rows[0].display_name,
      name: payload.name,
      prefix: payload.prefix,
      expiresAt: payload.expiresAt,
      token: payload.token,
      temporarySessionId: id,
    }),
  );
})().catch((error) => {
  console.error('FAIL', error.message);
  process.exit(1);
});
