#!/usr/bin/env node
// Mock-сервер сервиса переводов. Без зависимостей, Node 22+.
//   node mock/server.mjs                      — порт 4010, задачи выполняются сами раз в 200 мс
//   MOCK_PORT=4011 MOCK_AUTO_TICK_MS=0 node mock/server.mjs — без фонового исполнителя: время двигают тесты
// Публичный API — docs/api/openapi.yaml, колбэк антифрода — docs/api/internal-antifraud.yaml,
// управляющий API /__mock — mock/README.md.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ApiError, Bank, mskDate, validationError } from './bank.mjs';

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const AUTO_TICK_MS = Number(process.env.MOCK_AUTO_TICK_MS ?? 200);
const bank = new Bank();

const json = (status, body, headers = {}) => ({ status, body, headers });
const notFound = (what) => json(404, { error: `${what} не найден` });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw validationError([{ field: 'body', message: 'Тело — не JSON' }], 'Тело запроса — не JSON.');
  }
}

// Публичные операции: [метод, шаблон пути, operationId, обработчик]
const API = [
  ['POST', /^\/v1\/recipients\/lookup$/, 'lookupRecipient', async (c) => json(200, bank.lookupRecipient(c.sender(), await c.body()))],
  ['POST', /^\/v1\/transfers$/, 'createTransfer', async (c) => {
    const sender = c.sender();
    const r = await bank.createTransfer(sender, c.headers, await c.body());
    return json(r.status, r.body, r.headers);
  }],
  ['GET', /^\/v1\/transfers\/([^/]+)$/, 'getTransfer', async (c, id) => json(200, bank.getTransfer(c.sender(), id))],
  ['POST', /^\/v1\/transfers\/([^/]+)\/cancel$/, 'cancelTransfer', async (c, id) => json(200, bank.cancelTransfer(c.sender(), id))],
  ['POST', /^\/v1\/transfers\/([^/]+)\/confirm$/, 'confirmTransfer', async (c, id) => json(200, bank.confirmTransfer(c.sender(), id))],
  ['GET', /^\/v1\/transfer-limits$/, 'getTransferLimits', async (c) => json(200, bank.limitsView(c.sender()))],
  // Внутренний контур: в проде — mTLS, в mock без аутентификации
  ['POST', /^\/internal\/v1\/antifraud\/decisions$/, 'receiveAntifraudDecision', async (c) => json(200, bank.receiveDecision(await c.body()))],
];

// Управляющий API: сбои, время, наблюдение за внутренним состоянием. В проде его нет
const CONTROL = [
  ['POST', /^\/__mock\/reset$/, async () => { bank.reset(); return json(200, { reset: true, now: iso(bank.now()) }); }],
  ['GET', /^\/__mock\/clock$/, async () => json(200, clock())],
  ['POST', /^\/__mock\/clock\/advance$/, async (c) => {
    const b = (await c.body()) ?? {};
    const ms = (b.seconds ?? 0) * 1000 + (b.minutes ?? 0) * 60e3 + (b.hours ?? 0) * 3600e3 + (b.days ?? 0) * 86400e3;
    if (!(ms >= 0)) throw validationError([{ field: 'seconds', message: 'Время только вперёд' }]);
    bank.advance(ms);
    return json(200, clock());
  }],
  ['GET', /^\/__mock\/faults$/, async () => json(200, bank.faults)],
  ['POST', /^\/__mock\/faults$/, async (c) => json(200, bank.setFaults((await c.body()) ?? {}))],
  ['GET', /^\/__mock\/transfers\/([^/]+)$/, async (c, id) => bank.internalView(id) ? json(200, bank.internalView(id)) : notFound('Перевод')],
  ['DELETE', /^\/__mock\/transfers\/([^/]+)\/tasks$/, async (c, id) => json(200, bank.dropTasks(id))],
  ['GET', /^\/__mock\/accounts\/([^/]+)$/, async (c, id) => bank.accountView(id) ? json(200, bank.accountView(id)) : notFound('Счёт')],
  ['POST', /^\/__mock\/accounts\/([^/]+)\/status$/, async (c, id) => {
    const v = bank.setAccountStatus(id, (await c.body())?.status);
    return v ? json(200, v) : notFound('Счёт');
  }],
  ['POST', /^\/__mock\/phones$/, async (c) => {
    const b = (await c.body()) ?? {};
    return json(200, bank.reassignPhone(b.phone, b.clientId));
  }],
  ['POST', /^\/__mock\/ledger\/late-hold\/([^/]+)$/, async (c, id) => bank.deliverLateHold(id) ? json(200, bank.deliverLateHold(id)) : notFound('Перевод')],
  ['POST', /^\/__mock\/ledger\/postings$/, async (c) => json(201, bank.injectPosting((await c.body()) ?? {}))],
  ['GET', /^\/__mock\/events$/, async (c) => json(200, bank.outbox.filter((e) => !c.query.get('transferId') || e.transferId === c.query.get('transferId'))
    .map((e) => ({ ...e.payload, seq: e.seq, published: !!e.publishedAt })))],
  ['POST', /^\/__mock\/events\/([^/]+)\/redeliver$/, async (c, id) => {
    const r = bank.redeliver(id, (await c.body()) ?? {});
    if (r) bank.process();
    return r ? json(200, r) : notFound('Опубликованное событие');
  }],
  ['GET', /^\/__mock\/pushes$/, async (c) => json(200, bank.pushes.filter((p) => !c.query.get('transferId') || p.transferId === c.query.get('transferId')))],
  ['GET', /^\/__mock\/dlq$/, async () => json(200, bank.dlq)],
  ['GET', /^\/__mock\/alerts$/, async () => json(200, bank.alerts)],
  ['GET', /^\/__mock\/incidents$/, async () => json(200, bank.incidents)],
  ['GET', /^\/__mock\/antifraud$/, async () => json(200, bank.antifraudView())],
  ['POST', /^\/__mock\/cbr\/load$/, async () => json(200, bank.loadRates())],
  ['GET', /^\/__mock\/reconciliation$/, async (c) => json(200, bank.reconcile(c.query.get('day') ?? undefined))],
];

function iso(ts) {
  return new Date(ts).toISOString();
}
function clock() {
  const now = bank.now();
  return { now: iso(now), moscowDate: mskDate(now) };
}

function traceId(req) {
  const m = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(req.headers.traceparent ?? '');
  return m ? m[1] : randomBytes(16).toString('hex');
}

async function handle(req) {
  const url = new URL(req.url, 'http://mock');
  const ctx = {
    headers: req.headers,
    query: url.searchParams,
    sender: () => bank.auth(req.headers.authorization),
    body: (() => { let p; return () => (p ??= readBody(req)); })(),
  };
  const trace = traceId(req);
  if (url.pathname.startsWith('/__mock/')) {
    for (const [method, re, fn] of CONTROL) {
      const m = re.exec(url.pathname);
      if (m && method === req.method) return fn(ctx, ...m.slice(1));
    }
    return notFound('Управляющий метод');
  }
  for (const [method, re, operation, fn] of API) {
    const m = re.exec(url.pathname);
    if (!m || method !== req.method) continue;
    try {
      // Сбой «сервис недоступен» до обработки, для любой операции, кроме создания: там он проверяется после ключа
      if (operation !== 'createTransfer' && operation !== 'cancelTransfer' && operation !== 'confirmTransfer' && bank.takeRequestFault(operation, ['UNAVAILABLE'])) {
        throw new ApiError('SERVICE_UNAVAILABLE', 'Повторите запрос.', { retryAfterSeconds: 1 }, { 'Retry-After': '1' });
      }
      const r = await fn(ctx, ...m.slice(1));
      if (AUTO_TICK_MS > 0) bank.process();
      return r;
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { ...e.body, traceId: trace }, headers: e.headers, problem: true };
      throw e;
    }
  }
  return notFound('Метод');
}

const server = createServer(async (req, res) => {
  let r;
  try {
    r = await handle(req);
  } catch (e) {
    console.error(e);
    r = { status: 500, body: { error: String(e?.message ?? e) } };
  }
  const type = r.problem ? 'application/problem+json' : 'application/json';
  res.writeHead(r.status, { 'Content-Type': `${type}; charset=utf-8`, ...r.headers });
  res.end(JSON.stringify(r.body));
});

if (AUTO_TICK_MS > 0) setInterval(() => bank.process(), AUTO_TICK_MS).unref();

server.listen(PORT, () => {
  console.log(`mock: http://localhost:${PORT}, виртуальное время ${iso(bank.now())}, автоисполнитель ${AUTO_TICK_MS > 0 ? AUTO_TICK_MS + ' мс' : 'выключен'}`);
});
