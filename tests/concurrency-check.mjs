#!/usr/bin/env node
// Параллельные запросы к mock-серверу: то, что Postman-коллекция не проверит, потому что шлёт запросы по одному.
//   Отказ 1  — двойное нажатие: два одновременных запроса с одним ключом создают один перевод
//   Отказ 4  — два параллельных перевода вместе превышают дневной лимит: проходит только один
//   Отказ 20 — 30 одновременных переводов одному получателю: все выполнены, сверка сходится
// Запуск: MOCK_URL=http://localhost:4010 node tests/concurrency-check.mjs. Mock должен работать с MOCK_AUTO_TICK_MS=0.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BASE = process.env.MOCK_URL ?? 'http://localhost:4010';
const ACC = { petrRub: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6b', olgaRub: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c70', ivanRub: 'a0000000-0000-4000-8000-000000000301' };

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const mock = (method, path, body) => call(method, '/__mock' + path, body);
const as = (who) => ({ Authorization: `Bearer mock-${who}` });
const lookup = async (who, phone) => (await call('POST', '/v1/recipients/lookup', { phone }, as(who))).body.recipientToken;
const create = (who, key, body) => call('POST', '/v1/transfers', body, { ...as(who), 'Idempotency-Key': key, 'X-Device-Id': 'concurrency-check' });

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

await check('Отказ 1: два одновременных запроса с одним ключом — один перевод, второй получает 409, затем тот же перевод', async () => {
  await mock('POST', '/reset');
  await mock('POST', '/faults', { ledgerLatencyMs: 200 }); // холд «идёт» 200 мс: второй запрос приходит, пока первый держит аренду
  const tok = await lookup('petr', '+79991234567');
  const key = randomUUID();
  const body = { recipientToken: tok, sourceAccountId: ACC.petrRub, amount: { value: '1500.00', currency: 'RUB' } };
  const [a, b] = await Promise.all([create('petr', key, body), create('petr', key, body)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], `ответы ${statuses}`);
  const busy = a.status === 409 ? a : b;
  assert.equal(busy.body.code, 'IDEMPOTENCY_KEY_IN_PROGRESS');
  assert.equal(busy.headers.get('retry-after'), '1');
  const created = a.status === 201 ? a : b;
  const again = await create('petr', key, body); // повтор через Retry-After
  assert.equal(again.status, 200);
  assert.equal(again.body.id, created.body.id, 'тот же перевод');
  await mock('POST', '/clock/advance', { seconds: 1 });
  assert.equal((await mock('GET', `/accounts/${ACC.ivanRub}`)).body.balance, '6500.00', 'деньги ушли один раз');
});

await check('Отказ 4: два параллельных перевода по 15 000 ₽ при доступных 20 000 ₽ — проходит один', async () => {
  await mock('POST', '/reset');
  await mock('POST', '/faults', { ledgerLatencyMs: 200 }); // оба запроса одновременно внутри создания
  const tok = await lookup('olga', '+79991234567');
  const body = { recipientToken: tok, sourceAccountId: ACC.olgaRub, amount: { value: '15000.00', currency: 'RUB' } };
  const [a, b] = await Promise.all([create('olga', randomUUID(), body), create('olga', randomUUID(), body)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 422], `ответы ${statuses}`);
  const rejected = a.status === 422 ? a : b;
  assert.equal(rejected.body.code, 'LIMIT_EXCEEDED');
  assert.deepEqual(rejected.body.limit, { period: 'DAY', available: { value: '5000.00', currency: 'RUB' } }, 'доступно за вычетом резерва первого');
  const limits = (await call('GET', '/v1/transfer-limits', undefined, as('olga'))).body;
  assert.equal(limits.day.used.value, '495000.00', 'лимит не превышен');
});

await check('Отказ 20: 30 одновременных переводов одному получателю — все выполнены, проводки по одной, сверка сходится', async () => {
  await mock('POST', '/reset');
  await mock('POST', '/faults', { ledgerLatencyMs: 50 });
  const tok = await lookup('petr', '+79991234567');
  const amounts = Array.from({ length: 30 }, (_, i) => 100 + i);
  const responses = await Promise.all(amounts.map((a) => create('petr', randomUUID(), { recipientToken: tok, sourceAccountId: ACC.petrRub, amount: { value: `${a}.00`, currency: 'RUB' } })));
  assert.deepEqual([...new Set(responses.map((r) => r.status))], [201], 'все приняты');
  await mock('POST', '/clock/advance', { seconds: 2 });
  for (const r of responses) {
    const t = (await mock('GET', `/transfers/${r.body.id}`)).body;
    assert.equal(t.status, 'COMPLETED');
    assert.equal(t.postings.length, 1, `одна проводка у ${t.id}`);
  }
  const sum = amounts.reduce((s, a) => s + a, 0);
  assert.equal((await mock('GET', `/accounts/${ACC.ivanRub}`)).body.balance, `${5000 + sum}.00`);
  const rec = (await mock('GET', '/reconciliation')).body;
  assert.equal(rec.ok, true, JSON.stringify(rec.discrepancies));
  assert.equal(rec.completedTransfers, 30);
});

await mock('POST', '/reset');
console.log(failed ? `\nНе прошло проверок: ${failed}` : '\nВсе параллельные проверки пройдены');
process.exit(failed ? 1 : 0);
