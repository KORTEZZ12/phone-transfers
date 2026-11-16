// Ядро mock-сервера: сервис переводов, леджер, антифрод, outbox и потребители событий в одном процессе.
// Правила повторяют ddl.sql и business-rules.md: статусная модель, задачи продолжения, резерв лимита,
// идемпотентные операции леджера, аренда, матрица пушей. Время виртуальное: его двигает управляющий API,
// поэтому сценарии на 48 часов проверки или 2 дня отложенного исполнения проходят за миллисекунды.

import { createHash, randomUUID } from 'node:crypto';
import { BANK_ACCOUNTS, CLIENTS, DEFAULT_START, P, RATES } from './fixtures.mjs';

// ---------------------------------------------------------------------------------------------
// Время и деньги
// ---------------------------------------------------------------------------------------------

const MSK = 3 * 3600e3;
const DAY = 24 * 3600e3;

export const mskDate = (ts) => new Date(ts + MSK).toISOString().slice(0, 10);
export const fmtTime = (ts) => (ts == null ? null : new Date(ts + MSK).toISOString().slice(0, 19) + '+03:00');
const mskMidnight = (date) => Date.parse(date + 'T00:00:00Z') - MSK;
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const monthOf = (date) => date.slice(0, 8) + '01';
const nextMonth = (date) => {
  const [y, m] = date.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

export const MONEY_RE = /^\d{1,15}(\.\d{1,2})?$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CURRENCIES = ['RUB', 'USD', 'EUR', 'CNY'];

export function toKop(value) {
  const [i, f = ''] = value.split('.');
  return BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
}
export function kopToValue(k) {
  const sign = k < 0n ? '-' : '';
  const a = k < 0n ? -k : k;
  return `${sign}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
const SYMBOL = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥' };
// «1 500 ₽», «20 000 ₽», «1 500,50 ₽» — с неразрывными пробелами, как в текстах приложения
export function humanMoney(k, currency = 'RUB') {
  const whole = String(k / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = k % 100n === 0n ? '' : ',' + String(k % 100n).padStart(2, '0');
  return `${whole}${frac} ${SYMBOL[currency]}`;
}
const money = (k, currency) => ({ value: kopToValue(k), currency });

// Детерминированный генератор для разброса пауз: прогон воспроизводим
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Ошибки API: RFC 9457 и каталог кодов из docs/api/README.md
// ---------------------------------------------------------------------------------------------

const PROBLEMS = {
  VALIDATION_ERROR: [400, 'Ошибка в данных'],
  IDEMPOTENCY_KEY_REQUIRED: [400, 'Нужен ключ идемпотентности'],
  UNAUTHORIZED: [401, 'Нужно войти заново'],
  ACCOUNT_NOT_OWNED: [403, 'Счёт недоступен'],
  RECIPIENT_NOT_FOUND: [404, 'Получатель не найден'],
  TRANSFER_NOT_FOUND: [404, 'Перевод не найден'],
  IDEMPOTENCY_KEY_IN_PROGRESS: [409, 'Перевод ещё создаётся'],
  TRANSFER_NOT_CANCELLABLE: [409, 'Перевод уже нельзя отменить'],
  TRANSFER_NOT_CONFIRMABLE: [409, 'Перевод уже нельзя подтвердить'],
  SELF_TRANSFER: [422, 'Это ваш номер'],
  RECIPIENT_TOKEN_EXPIRED: [422, 'Найдите получателя ещё раз'],
  RECIPIENT_CURRENCY_UNAVAILABLE: [422, 'Получатель не принимает эту валюту'],
  LIMIT_EXCEEDED: [422, 'Превышен лимит'],
  INSUFFICIENT_FUNDS: [422, 'Недостаточно средств'],
  SOURCE_ACCOUNT_UNAVAILABLE: [422, 'С этого счёта сейчас нельзя переводить'],
  IDEMPOTENCY_KEY_REUSED: [422, 'Ключ уже использован для другого перевода'],
  LOOKUP_RATE_LIMITED: [429, 'Слишком много запросов'],
  SERVICE_UNAVAILABLE: [503, 'Сервис временно недоступен'],
};

export class ApiError extends Error {
  constructor(code, detail, extra = {}, headers = {}) {
    super(code);
    const [status, title] = PROBLEMS[code];
    this.status = status;
    this.headers = headers;
    this.body = {
      type: `https://api.bank.example/problems/${code.toLowerCase().replace(/_/g, '-')}`,
      title,
      status,
      code,
      ...(detail ? { detail } : {}),
      ...extra,
    };
  }
}
export const validationError = (errors, detail = 'Проверьте поля запроса.') =>
  new ApiError('VALIDATION_ERROR', detail, { errors });
export const unavailable = (retryAfter = 1) =>
  new ApiError('SERVICE_UNAVAILABLE', 'Повторите запрос с тем же ключом.', { retryAfterSeconds: retryAfter },
    { 'Retry-After': String(retryAfter) });

class Timeout extends Error {}

// ---------------------------------------------------------------------------------------------
// Статусная модель: копия таблицы status_transition из ddl.sql
// ---------------------------------------------------------------------------------------------

const TRANSITIONS = new Set([
  'NEW>HELD', 'NEW>REJECTED', 'NEW>FAILED',
  'HELD>CHECKING',
  'CHECKING>POSTING', 'CHECKING>REJECTED', 'CHECKING>REVIEW', 'CHECKING>SUSPENDED', 'CHECKING>COOLING',
  'REVIEW>POSTING', 'REVIEW>REJECTED', 'REVIEW>CANCELLED', 'REVIEW>SUSPENDED',
  'SUSPENDED>CHECKING', 'SUSPENDED>REJECTED', 'SUSPENDED>CANCELLED',
  'COOLING>POSTING', 'COOLING>CANCELLED',
  'POSTING>COMPLETED', 'POSTING>REJECTED', 'POSTING>FAILED',
]);
const FINAL = new Set(['COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED']);
const isFinal = (s) => FINAL.has(s);
export function clientStatus(s) {
  if (['NEW', 'HELD', 'CHECKING', 'POSTING'].includes(s)) return 'PROCESSING';
  return { REVIEW: 'ON_REVIEW', SUSPENDED: 'AWAITING_CONFIRMATION', COOLING: 'DELAYED' }[s] ?? s;
}

// Тексты пушей — матрица «статус × адресат» из business-rules.md
const REJECT_TEXT = {
  REVIEW_EXPIRED: 'проверка не завершена',
  NOT_CONFIRMED: 'перевод не подтверждён',
  RECIPIENT_ACCOUNT_UNAVAILABLE: 'счёт получателя недоступен',
  SOURCE_ACCOUNT_UNAVAILABLE: 'счёт списания недоступен',
};

// ---------------------------------------------------------------------------------------------
// Банк
// ---------------------------------------------------------------------------------------------

export class Bank {
  constructor({ start = process.env.MOCK_START ?? DEFAULT_START } = {}) {
    this.startAt = Date.parse(start);
    this.reset();
  }

  // ------------------------------------------------------------------ состояние

  reset() {
    this.realStart = Date.now();
    this.offset = 0;
    this.random = prng(20261116);
    this.seq = { posting: 0, task: 0, event: 0, push: 0, alert: 0, incident: 0 };

    this.clients = new Map(); // id → клиент
    this.clientsByToken = new Map(); // токен доступа → клиент
    this.phones = new Map(); // номер → id клиента
    this.accounts = new Map(); // ledger.account
    this.holds = new Map(); // ledger.hold по transferId
    this.closedOps = new Set(); // ledger.closed_operation
    this.postings = []; // ledger.posting
    this.recipientTokens = new Map(); // transfers.recipient_token
    this.lookups = new Map(); // журнал поисков отправителя для P-02 и P-03
    this.limitUsage = new Map(); // transfers.limit_usage
    this.transfers = new Map(); // transfers.transfer
    this.byKey = new Map(); // (отправитель, ключ) → id перевода
    this.tasks = []; // transfers.task
    this.outbox = []; // transfers.outbox_event
    this.antifraudChecks = []; // transfers.antifraud_check
    this.decisions = new Map(); // decisionId → результат колбэка
    this.rates = []; // transfers.currency_rate

    // Потребители событий
    this.deliveries = []; // доставки события потребителю уведомлений: по одной на пару «событие + адресат»
    this.pushes = []; // ушедшие пуши
    this.history = new Map(); // потребитель истории: transferId → последнее состояние
    this.historySeen = new Set();
    this.dlq = [];
    this.poisoned = new Set();

    this.alerts = [];
    this.incidents = [];
    this.faults = this.defaultFaults();
    this.breaker = { state: 'CLOSED', failuresInRow: 0, nextProbeAt: 0, probes: 0, opened: 0 };
    this.antifraudStats = { calls: 0, timeouts: 0 };
    this.bucket = { tokens: P.P18_ANTIFRAUD_DRAIN_PER_SECOND, at: this.now() };
    this.nextSweepAt = this.now() + P.P08_SWEEP_PERIOD;
    this.ratesLoadedFor = null;
    this.ratesAttemptedFor = mskDate(this.now());

    for (const b of BANK_ACCOUNTS) {
      this.accounts.set(b.id, { id: b.id, clientId: null, type: 'BANK_TECHNICAL', currency: b.currency, primary: false, status: 'OPEN', balance: 0n });
    }
    for (const c of CLIENTS) {
      const client = { ...c, antifraud: { initial: 'ALLOW', confirmation: 'ALLOW', ...(c.antifraud ?? {}) } };
      this.clients.set(c.id, client);
      this.clientsByToken.set(`mock-${c.key}`, client);
      this.phones.set(c.phone, c.id);
      for (const a of c.accounts) {
        this.accounts.set(a.id, { id: a.id, clientId: c.id, type: 'CLIENT_CURRENT', currency: a.currency, primary: a.primary, status: a.status, balance: 0n });
        const amount = toKop(a.balance);
        if (amount > 0n) this.insertPosting({ kind: 'OTHER', transferId: null, debit: this.bankAccount(a.currency), credit: a.id, currency: a.currency, amount });
      }
      if (c.limitUsed) {
        const day = mskDate(this.now());
        this.usage(c.id, 'DAY', day).used = toKop(c.limitUsed.day);
        this.usage(c.id, 'MONTH', monthOf(day)).used = toKop(c.limitUsed.month);
      }
    }
    this.loadRates();
  }

  defaultFaults() {
    return {
      antifraud: 'UP', // UP или DOWN: не отвечает за P-09
      ledger: 'UP', // UP, DOWN — не отвечает; LOST_RESPONSE — выполняет операцию, но ответ теряется
      relay: 'UP', // UP или DOWN: relay outbox не публикует
      cbr: 'UP', // UP или DOWN: DailyInfo недоступен
      pushRecipientFailures: 0, // сколько раз подряд упадёт пуш получателю
      ledgerLatencyMs: 0, // задержка холда в запросе на создание: нужна для проверки гонок
      requests: [], // [{operation, mode, count}], mode: UNAVAILABLE, LOST_RESPONSE, CRASH_BEFORE_HOLD
    };
  }

  setFaults(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in this.faults)) throw validationError([{ field: k, message: 'Неизвестный сбой' }]);
      this.faults[k] = k === 'requests' ? v.map((r) => ({ count: 1, ...r })) : v;
    }
    return this.faults;
  }

  // Сбой запроса из faults.requests: срабатывает count раз
  takeRequestFault(operation, modes) {
    const f = this.faults.requests.find((r) => (r.operation === operation || r.operation === '*') && r.count > 0 && modes.includes(r.mode));
    if (!f) return null;
    f.count -= 1;
    return f.mode;
  }

  // ------------------------------------------------------------------ часы

  now() {
    return this.startAt + (Date.now() - this.realStart) + this.offset;
  }

  // Двигает время вперёд, по пути выполняя всё, что наступает: задачи, повторы, регламентную проверку
  advance(ms) {
    const target = this.now() + ms;
    for (let i = 0; i < 500_000; i++) {
      this.process();
      const next = this.nextEventAt();
      if (next == null || next > target) break;
      if (next > this.now()) this.offset += next - this.now();
    }
    if (target > this.now()) this.offset += target - this.now();
    this.process();
    return this.now();
  }

  nextEventAt() {
    const times = [this.nextSweepAt, mskMidnight(addDays(mskDate(this.now()), 1))];
    for (const t of this.tasks) if (!t.doneAt) times.push(t.dueAt);
    for (const d of this.deliveries) if (d.state === 'RETRY') times.push(d.dueAt);
    return Math.min(...times);
  }

  // Всё, что должно произойти к текущему моменту
  process() {
    for (let guard = 0; guard < 100_000; guard++) {
      let progressed = false;
      // Курсы ЦБ раз в день: попытка в начале суток, при сбое — алерт и повтор, когда DailyInfo ответит
      const today = mskDate(this.now());
      if (this.ratesAttemptedFor !== today) {
        this.ratesAttemptedFor = today;
        if (this.ratesLoadedFor !== today) this.loadRates();
      } else if (this.ratesLoadedFor !== today && this.faults.cbr === 'UP') this.loadRates();
      if (this.relay()) progressed = true;
      if (this.consume()) progressed = true;
      if (this.now() >= this.nextSweepAt) {
        this.sweep();
        this.nextSweepAt = this.now() + P.P08_SWEEP_PERIOD;
        progressed = true;
      }
      const task = this.dueTask();
      if (task) {
        this.runTask(task);
        progressed = true;
      }
      if (!progressed) return;
    }
    throw new Error('mock: process() не сошёлся');
  }

  // ------------------------------------------------------------------ курсы ЦБ (TR-25, TR-26)

  loadRates() {
    const today = mskDate(this.now());
    if (this.faults.cbr !== 'UP') {
      this.alert('CBR_RATE_NOT_LOADED', { date: today, detail: 'DailyInfo недоступен, лимиты считаются по последнему курсу' });
      return { loaded: false, rateDate: this.lastRateDate() };
    }
    for (const [currency, r] of Object.entries(RATES)) {
      if (!this.rates.some((x) => x.currency === currency && x.rateDate === today)) {
        this.rates.push({ currency, rateDate: today, nominal: r.nominal, rate: r.rate });
      }
    }
    this.ratesLoadedFor = today;
    return { loaded: true, rateDate: today };
  }

  lastRateDate() {
    return this.rates.map((r) => r.rateDate).sort().at(-1) ?? null;
  }

  // Рублёвый эквивалент: amount × rate / nominal, до копеек, половина — от нуля (data-model.md)
  toRub(amount, currency) {
    if (currency === 'RUB') return { amountRub: amount, rateDate: null };
    const today = mskDate(this.now());
    const r = this.rates.filter((x) => x.currency === currency && x.rateDate <= today).sort((a, b) => (a.rateDate < b.rateDate ? 1 : -1))[0];
    if (!r) throw unavailable(60);
    const [whole, frac = ''] = r.rate.split('.');
    const rate4 = BigInt(whole) * 10000n + BigInt((frac + '0000').slice(0, 4)); // курс с 4 знаками
    const num = amount * rate4;
    const den = 10000n * BigInt(r.nominal);
    return { amountRub: (num + den / 2n) / den, rateDate: r.rateDate };
  }

  // ------------------------------------------------------------------ клиенты и счета

  auth(header) {
    const m = /^Bearer (\S+)$/.exec(header ?? '');
    const client = m && this.clientsByToken.get(m[1]);
    if (!client) throw new ApiError('UNAUTHORIZED');
    return client;
  }

  bankAccount(currency) {
    return BANK_ACCOUNTS.find((b) => b.currency === currency).id;
  }

  primaryAccounts(clientId) {
    const out = {};
    for (const a of this.accounts.values()) {
      if (a.clientId === clientId && a.primary && a.status === 'OPEN') out[a.currency] = a.id;
    }
    return out;
  }

  accountView(id) {
    const a = this.accounts.get(id);
    if (!a) return null;
    const held = [...this.holds.values()].filter((h) => h.accountId === id && h.status === 'ACTIVE').reduce((s, h) => s + h.amount, 0n);
    return { id, clientId: a.clientId, currency: a.currency, primary: a.primary, status: a.status, balance: kopToValue(a.balance), held: kopToValue(held), available: kopToValue(a.balance - held) };
  }

  setAccountStatus(id, status) {
    const a = this.accounts.get(id);
    if (!a) return null;
    if (!['OPEN', 'BLOCKED', 'CLOSED'].includes(status)) throw validationError([{ field: 'status', message: 'OPEN, BLOCKED или CLOSED' }]);
    a.status = status;
    return this.accountView(id);
  }

  reassignPhone(phone, clientId) {
    if (!this.clients.has(clientId)) throw validationError([{ field: 'clientId', message: 'Нет такого клиента' }]);
    this.phones.set(phone, clientId);
    return { phone, clientId };
  }

  // ------------------------------------------------------------------ леджер (функции схемы ledger)

  insertPosting(p) {
    const row = { id: randomUUID(), seq: ++this.seq.posting, postedAt: this.now(), reverses: null, ...p };
    if (row.transferId && this.postings.some((x) => x.transferId === row.transferId && x.kind === row.kind)) {
      throw new Error(`UNIQUE (transfer_id, kind): ${row.transferId} ${row.kind}`);
    }
    this.postings.push(row);
    this.accounts.get(row.debit).balance -= row.amount;
    this.accounts.get(row.credit).balance += row.amount;
    return row;
  }

  // Вызов леджера по сети: сбои из faults.ledger
  ledgerCall(fn) {
    if (this.faults.ledger === 'DOWN') throw new Timeout('ledger timeout');
    const result = fn();
    if (this.faults.ledger === 'LOST_RESPONSE') throw new Timeout('ledger response lost');
    return result;
  }

  placeHold(transferId, accountId, currency, amount) {
    if (this.closedOps.has(transferId)) return 'ALREADY_RELEASED';
    const existing = this.holds.get(transferId);
    if (existing) return 'ALREADY_' + existing.status;
    const acc = this.accounts.get(accountId);
    if (!acc || acc.status !== 'OPEN') return 'ACCOUNT_UNAVAILABLE';
    if (acc.currency !== currency) return 'CURRENCY_MISMATCH';
    if (toKop(this.accountView(accountId).available) < amount) return 'INSUFFICIENT_FUNDS';
    this.holds.set(transferId, { transferId, accountId, currency, amount, status: 'ACTIVE', createdAt: this.now(), closedAt: null });
    return 'HELD';
  }

  releaseHold(transferId) {
    const h = this.holds.get(transferId);
    if (h && h.status === 'ACTIVE') {
      h.status = 'RELEASED';
      h.closedAt = this.now();
      return 'RELEASED';
    }
    if (h) return 'ALREADY_' + h.status;
    this.closedOps.add(transferId);
    return 'NO_HOLD';
  }

  postTransfer(transferId, creditAccountId) {
    const h = this.holds.get(transferId);
    if (!h) return 'NO_HOLD';
    if (h.status === 'CAPTURED') return 'ALREADY_POSTED';
    if (h.status === 'RELEASED') return 'HOLD_RELEASED';
    if (this.accounts.get(h.accountId).status !== 'OPEN') return 'SOURCE_ACCOUNT_UNAVAILABLE';
    const cr = this.accounts.get(creditAccountId);
    if (!cr || cr.status !== 'OPEN' || cr.currency !== h.currency) return 'RECIPIENT_ACCOUNT_UNAVAILABLE';
    this.insertPosting({ kind: 'TRANSFER', transferId, debit: h.accountId, credit: creditAccountId, currency: h.currency, amount: h.amount });
    h.status = 'CAPTURED';
    h.closedAt = this.now();
    return 'POSTED';
  }

  // Холд, который дошёл до леджера позже, чем перевод закрыли (отказ 19)
  deliverLateHold(transferId) {
    const t = this.transfers.get(transferId);
    if (!t) return null;
    return { result: this.placeHold(t.id, t.sourceAccountId, t.currency, t.amount), account: this.accountView(t.sourceAccountId) };
  }

  // Дефект для проверки сверки: проводка в обход перевода
  injectPosting({ transferId = randomUUID(), debit, credit, amount, currency = 'RUB' }) {
    if (!this.accounts.has(debit) || !this.accounts.has(credit) || typeof amount !== 'string' || !MONEY_RE.test(amount)) {
      throw validationError([{ field: 'body', message: 'debit, credit — счета mock, amount — сумма строкой' }]);
    }
    const p = this.insertPosting({ kind: 'TRANSFER', transferId, debit, credit, currency, amount: toKop(amount) });
    return { ...p, amount: kopToValue(p.amount), postedAt: fmtTime(p.postedAt) };
  }

  // ------------------------------------------------------------------ поиск получателя (TR-01…TR-05)

  lookupRecipient(sender, body) {
    const phone = body?.phone;
    if (typeof phone !== 'string' || !/^\+7\d{10}$/.test(phone)) {
      throw validationError([{ field: 'phone', message: 'Номер в формате +7XXXXXXXXXX' }], 'Проверьте номер телефона.');
    }
    const now = this.now();
    // Повтор того же номера, пока токен действует, — тот же токен и без расхода лимита (TR-03)
    const phoneHash = createHash('sha256').update(phone).digest('hex');
    for (const tok of this.recipientTokens.values()) {
      if (tok.senderId === sender.id && tok.phoneHash === phoneHash && tok.expiresAt > now) return this.tokenView(tok);
    }
    const log = this.lookups.get(sender.id) ?? [];
    this.lookups.set(sender.id, log);
    const minute = log.filter((t) => t > now - 60e3);
    const today = log.filter((t) => mskDate(t) === mskDate(now));
    if (today.length >= P.P03_LOOKUPS_PER_DAY) {
      const wait = Math.ceil((mskMidnight(addDays(mskDate(now), 1)) - now) / 1000);
      throw new ApiError('LOOKUP_RATE_LIMITED', 'Поиск на сегодня исчерпан, попробуйте завтра.', { retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
    }
    if (minute.length >= P.P02_LOOKUPS_PER_MINUTE) {
      const wait = Math.max(1, Math.ceil((minute[0] + 60e3 - now) / 1000));
      throw new ApiError('LOOKUP_RATE_LIMITED', `Попробуйте через ${wait} с.`, { retryAfterSeconds: wait }, { 'Retry-After': String(wait) });
    }
    log.push(now);
    const recipientId = this.phones.get(phone);
    if (recipientId === sender.id) throw new ApiError('SELF_TRANSFER', 'Для перевода себе используйте перевод между своими счетами.');
    const accounts = recipientId ? this.primaryAccounts(recipientId) : {};
    if (!recipientId || Object.keys(accounts).length === 0) {
      throw new ApiError('RECIPIENT_NOT_FOUND', 'Клиента банка с этим номером нет. Проверьте номер.');
    }
    const tok = {
      token: randomUUID(), senderId: sender.id, recipientId, phoneHash,
      displayName: this.clients.get(recipientId).name, accounts, createdAt: now, expiresAt: now + P.P01_TOKEN_TTL,
    };
    this.recipientTokens.set(tok.token, tok);
    return this.tokenView(tok);
  }

  tokenView(tok) {
    return {
      recipientToken: tok.token,
      displayName: tok.displayName,
      currencies: CURRENCIES.filter((c) => c in tok.accounts),
      expiresAt: fmtTime(tok.expiresAt),
    };
  }

  // ------------------------------------------------------------------ лимиты (TR-07…TR-09)

  usage(sender, period, start) {
    const k = `${sender}|${period}|${start}`;
    if (!this.limitUsage.has(k)) this.limitUsage.set(k, { reserved: 0n, used: 0n });
    return this.limitUsage.get(k);
  }

  // Возвращает OK или период, лимит которого превышен, — как transfers.reserve_limit
  reserveLimit(sender, day, amountRub) {
    if (amountRub > P.P04_OPERATION_LIMIT) return { period: 'OPERATION', available: P.P04_OPERATION_LIMIT };
    const d = this.usage(sender, 'DAY', day);
    const m = this.usage(sender, 'MONTH', monthOf(day));
    if (d.reserved + d.used + amountRub > P.P05_DAY_LIMIT) return { period: 'DAY', available: P.P05_DAY_LIMIT - d.reserved - d.used };
    if (m.reserved + m.used + amountRub > P.P06_MONTH_LIMIT) return { period: 'MONTH', available: P.P06_MONTH_LIMIT - m.reserved - m.used };
    d.reserved += amountRub;
    m.reserved += amountRub;
    return null;
  }

  settleLimit(t) {
    for (const [period, start] of [['DAY', t.limitDay], ['MONTH', t.limitMonth]]) {
      const u = this.usage(t.senderId, period, start);
      u.reserved -= t.amountRub;
      if (t.status === 'COMPLETED') u.used += t.amountRub;
    }
  }

  limitsView(sender) {
    const day = mskDate(this.now());
    const d = this.usage(sender.id, 'DAY', day);
    const m = this.usage(sender.id, 'MONTH', monthOf(day));
    const period = (limit, u, resetsAt) => {
      const used = u.reserved + u.used;
      const available = limit > used ? limit - used : 0n;
      return { limit: money(limit, 'RUB'), used: money(used, 'RUB'), available: money(available, 'RUB'), resetsAt: fmtTime(resetsAt) };
    };
    return {
      perOperation: money(P.P04_OPERATION_LIMIT, 'RUB'),
      day: period(P.P05_DAY_LIMIT, d, mskMidnight(addDays(day, 1))),
      month: period(P.P06_MONTH_LIMIT, m, mskMidnight(nextMonth(day))),
    };
  }

  // ------------------------------------------------------------------ создание перевода (TR-10…TR-13, TR-34)

  validateCreate(headers, body) {
    const errors = [];
    if (!headers['x-device-id']) errors.push({ field: 'X-Device-Id', message: 'Нужен идентификатор устройства' });
    else if (headers['x-device-id'].length > 128) errors.push({ field: 'X-Device-Id', message: 'Не длиннее 128 символов' });
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      throw validationError([{ field: 'body', message: 'Ожидается JSON-объект' }]);
    }
    if (typeof body.recipientToken !== 'string' || !UUID_RE.test(body.recipientToken)) errors.push({ field: 'recipientToken', message: 'UUID из поиска получателя' });
    if (typeof body.sourceAccountId !== 'string' || !UUID_RE.test(body.sourceAccountId)) errors.push({ field: 'sourceAccountId', message: 'UUID счёта' });
    const a = body.amount;
    if (!a || typeof a !== 'object') errors.push({ field: 'amount', message: 'Объект {value, currency}' });
    else {
      if (typeof a.value !== 'string' || !MONEY_RE.test(a.value)) errors.push({ field: 'amount.value', message: 'Неверный формат суммы' });
      else if (toKop(a.value) < 100n) errors.push({ field: 'amount.value', message: 'Не меньше 1 единицы валюты' });
      if (!CURRENCIES.includes(a.currency)) errors.push({ field: 'amount.currency', message: 'RUB, USD, EUR или CNY' });
    }
    if (body.comment != null && (typeof body.comment !== 'string' || body.comment.length > P.P13_COMMENT_LENGTH)) {
      errors.push({ field: 'comment', message: `Не длиннее ${P.P13_COMMENT_LENGTH} символов` });
    }
    if (errors.length) throw validationError(errors, 'Сумма — от 1 до лимита на операцию, не больше двух знаков после запятой.');
  }

  // Нормализация тела для сравнения повторов: правила из docs/api/README.md
  requestHash(body) {
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    const norm = [
      body.recipientToken.toLowerCase(),
      body.sourceAccountId.toLowerCase(),
      kopToValue(toKop(body.amount.value)),
      body.amount.currency,
      comment,
    ];
    return createHash('sha256').update(JSON.stringify(norm)).digest('hex');
  }

  async createTransfer(sender, headers, body) {
    // 1. Формат запроса — 400
    this.validateCreate(headers, body);
    // 2. Ключ идемпотентности — первым, до токена, счёта, лимита и остатка (TR-11)
    const key = headers['idempotency-key'];
    if (!key) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 'Передайте заголовок Idempotency-Key.');
    if (!UUID_RE.test(key)) throw validationError([{ field: 'Idempotency-Key', message: 'UUID' }]);
    if (this.takeRequestFault('createTransfer', ['UNAVAILABLE'])) throw unavailable(1);

    const hash = this.requestHash(body);
    const existingId = this.byKey.get(`${sender.id}|${key.toLowerCase()}`);
    if (existingId) return this.replayCreate(this.transfers.get(existingId), hash);

    // 3. Только для нового ключа: токен получателя, валюта, счёт, лимит, остаток
    const now = this.now();
    const tok = this.recipientTokens.get(body.recipientToken.toLowerCase());
    if (!tok || tok.senderId !== sender.id || tok.expiresAt <= now) {
      throw new ApiError('RECIPIENT_TOKEN_EXPIRED', 'С момента поиска прошло больше 10 минут.');
    }
    const currency = body.amount.currency;
    const targetAccountId = tok.accounts[currency];
    if (!targetAccountId) {
      const available = CURRENCIES.filter((c) => c in tok.accounts).join(', ');
      throw new ApiError('RECIPIENT_CURRENCY_UNAVAILABLE', `У получателя нет основного счёта в этой валюте. Доступно: ${available}.`);
    }
    const source = this.accounts.get(body.sourceAccountId.toLowerCase());
    if (!source || source.clientId !== sender.id) throw new ApiError('ACCOUNT_NOT_OWNED', 'С этого счёта нельзя переводить.');
    if (source.currency !== currency) {
      throw validationError([{ field: 'amount.currency', message: 'Валюта перевода должна совпадать с валютой счёта списания' }], 'Перевод — только между счетами в одной валюте.');
    }

    const amount = toKop(body.amount.value);
    const { amountRub, rateDate } = this.toRub(amount, currency);
    const limitDay = mskDate(now);
    const comment = typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : null;
    const t = {
      id: randomUUID(), senderId: sender.id, key: key.toLowerCase(), hash,
      recipientId: tok.recipientId, recipientName: tok.displayName, sourceAccountId: source.id, targetAccountId,
      currency, amount, amountRub, rateDate, limitDay, limitMonth: monthOf(limitDay), comment,
      status: 'NEW', rejectReason: null, version: 1,
      reviewDeadline: null, leaseUntil: null, suspendedAt: null, confirmationDeadline: null, confirmedAt: null, executeAfter: null,
      pendingDecision: null, syncProblem: null,
      createdAt: now, updatedAt: now, completedAt: null,
    };

    const exceeded = this.reserveLimit(sender.id, limitDay, amountRub);
    if (exceeded) {
      // Отказ по лимиту записывается сразу в REJECTED: повтор с тем же ключом вернёт тот же отказ
      t.status = 'REJECTED';
      t.rejectReason = 'LIMIT_EXCEEDED';
      t.syncProblem = this.limitProblem(exceeded);
      this.save(t);
      throw this.syncError(t);
    }
    t.leaseUntil = now + P.P14_LEASE; // перевод создаётся сразу с арендой (TR-34)
    this.save(t);
    return this.holdAndRespond(t, 201);
  }

  save(t) {
    this.transfers.set(t.id, t);
    this.byKey.set(`${t.senderId}|${t.key}`, t.id);
  }

  limitProblem({ period, available }) {
    const detail = {
      OPERATION: `За одну операцию можно перевести не больше ${humanMoney(available)}.`,
      DAY: `Сегодня можно перевести ещё ${humanMoney(available)}.`,
      MONTH: `В этом месяце можно перевести ещё ${humanMoney(available)}.`,
    }[period];
    return { code: 'LIMIT_EXCEEDED', detail, extra: { limit: { period, available: money(available, 'RUB') } } };
  }

  syncError(t) {
    return new ApiError(t.syncProblem.code, t.syncProblem.detail, t.syncProblem.extra ?? {});
  }

  // Повтор с тем же ключом: ответ строится только по существующему переводу
  async replayCreate(t, hash) {
    if (t.hash !== hash) {
      // Если исходный запрос отклонён синхронно, перевода как ресурса нет: existingTransferId не передаётся
      const extra = t.syncProblem ? {} : { existingTransferId: t.id };
      throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'Перевод с этим ключом уже создан с другими данными. Откройте его, повторно не отправляйте.', extra);
    }
    if (t.syncProblem) throw this.syncError(t);
    const now = this.now();
    if (t.leaseUntil && t.leaseUntil > now) {
      throw new ApiError('IDEMPOTENCY_KEY_IN_PROGRESS', 'Повторите запрос с тем же ключом через секунду.', { retryAfterSeconds: 1 }, { 'Retry-After': '1' });
    }
    if (t.status === 'NEW') {
      // Первый запрос упал после записи перевода, до холда: повтор берёт аренду и продолжает (TR-34)
      t.leaseUntil = now + P.P14_LEASE;
      return this.holdAndRespond(t, 200);
    }
    return { status: 200, headers: { 'Idempotent-Replayed': 'true' }, body: this.view(t) };
  }

  async holdAndRespond(t, status) {
    if (this.takeRequestFault('createTransfer', ['CRASH_BEFORE_HOLD'])) {
      // Сервис упал после записи перевода: аренда остаётся до истечения P-14, клиент получает 503 от шлюза
      throw unavailable(1);
    }
    if (this.faults.ledgerLatencyMs > 0) await new Promise((r) => setTimeout(r, this.faults.ledgerLatencyMs));
    let result;
    try {
      result = this.ledgerCall(() => this.placeHold(t.id, t.sourceAccountId, t.currency, t.amount));
    } catch (e) {
      if (e instanceof Timeout) throw unavailable(1); // исход холда неизвестен: повтор продолжит, холд идемпотентен
      throw e;
    }
    t.leaseUntil = null;
    if (result === 'HELD' || result === 'ALREADY_ACTIVE') {
      this.transition(t, 'HELD');
    } else if (result === 'INSUFFICIENT_FUNDS') {
      t.syncProblem = { code: 'INSUFFICIENT_FUNDS', detail: 'На счёте недостаточно денег для перевода.' };
      this.transition(t, 'REJECTED', { rejectReason: 'INSUFFICIENT_FUNDS' });
      throw this.syncError(t);
    } else if (result === 'ACCOUNT_UNAVAILABLE') {
      t.syncProblem = { code: 'SOURCE_ACCOUNT_UNAVAILABLE', detail: 'Счёт заблокирован или закрыт. Выберите другой счёт.' };
      this.transition(t, 'REJECTED', { rejectReason: 'SOURCE_ACCOUNT_UNAVAILABLE' });
      throw this.syncError(t);
    } else {
      // ALREADY_RELEASED: регламентная проверка уже закрыла операцию, перевод в FAILED
      return { status: 200, headers: { 'Idempotent-Replayed': 'true' }, body: this.view(t) };
    }
    if (this.takeRequestFault('createTransfer', ['LOST_RESPONSE'])) throw unavailable(1); // перевод создан, ответ потерян
    const headers = status === 201 ? { Location: `/v1/transfers/${t.id}` } : { 'Idempotent-Replayed': 'true' };
    return { status, headers, body: this.view(t) };
  }

  // ------------------------------------------------------------------ чтение, отмена, подтверждение

  // Перевод отправителя. Чужой и синхронно отклонённый — 404: такого ресурса у клиента нет
  ownTransfer(sender, id) {
    const t = UUID_RE.test(id) ? this.transfers.get(id.toLowerCase()) : null;
    if (!t || t.senderId !== sender.id || t.syncProblem) throw new ApiError('TRANSFER_NOT_FOUND');
    this.applyDeadlines(t);
    return t;
  }

  getTransfer(sender, id) {
    return this.view(this.ownTransfer(sender, id));
  }

  // TR-22, TR-23: отменить можно на проверке, при ожидании подтверждения и в отложенном исполнении
  cancelTransfer(sender, id) {
    if (this.takeRequestFault('cancelTransfer', ['UNAVAILABLE'])) throw unavailable(1);
    const t = this.ownTransfer(sender, id);
    if (t.status !== 'CANCELLED') {
      if (!['REVIEW', 'SUSPENDED', 'COOLING'].includes(t.status)) {
        throw new ApiError('TRANSFER_NOT_CANCELLABLE', this.notCancellableDetail(t), { currentStatus: clientStatus(t.status) });
      }
      this.transition(t, 'CANCELLED');
    }
    return this.view(t);
  }

  notCancellableDetail(t) {
    return {
      COMPLETED: 'Перевод уже выполнен.',
      REJECTED: 'Перевод уже отклонён.',
      FAILED: 'Перевод не выполнен, деньги не списаны.',
    }[t.status] ?? 'Перевод уже в обработке.';
  }

  // TR-36…TR-38: подтвердить можно только приостановленный перевод до срока, повтор идемпотентен
  confirmTransfer(sender, id) {
    if (this.takeRequestFault('confirmTransfer', ['UNAVAILABLE'])) throw unavailable(1);
    const t = this.ownTransfer(sender, id);
    if (t.status === 'SUSPENDED') {
      t.confirmedAt = this.now();
      this.transition(t, 'CHECKING');
      return this.view(t);
    }
    if (t.confirmedAt && !['CANCELLED', 'REJECTED', 'FAILED'].includes(t.status)) return this.view(t);
    const detail = t.rejectReason === 'NOT_CONFIRMED' ? 'Срок подтверждения истёк, перевод отклонён.' : 'Перевод не ждёт подтверждения.';
    throw new ApiError('TRANSFER_NOT_CONFIRMABLE', detail, { currentStatus: clientStatus(t.status) });
  }

  // Срок проверки и срок подтверждения применяются и при обращении к переводу, а не только регламентной проверкой:
  // клиент не видит «Подтвердите до …» после этого «до»
  applyDeadlines(t) {
    const now = this.now();
    if (t.status === 'REVIEW' && t.reviewDeadline <= now) this.transition(t, 'REJECTED', { rejectReason: 'REVIEW_EXPIRED' });
    if (t.status === 'SUSPENDED' && t.confirmationDeadline <= now) this.transition(t, 'REJECTED', { rejectReason: 'NOT_CONFIRMED' });
  }

  view(t) {
    const s = t.status;
    return {
      id: t.id,
      status: clientStatus(s),
      rejectReason: s === 'REJECTED' ? t.rejectReason : null,
      amount: money(t.amount, t.currency),
      recipient: { displayName: t.recipientName },
      sourceAccountId: t.sourceAccountId,
      comment: t.comment,
      cancellable: ['REVIEW', 'SUSPENDED', 'COOLING'].includes(s),
      confirmable: s === 'SUSPENDED' && t.confirmationDeadline > this.now(),
      confirmationDeadline: s === 'SUSPENDED' ? fmtTime(t.confirmationDeadline) : null,
      executeAfter: s === 'COOLING' ? fmtTime(t.executeAfter) : null,
      createdAt: fmtTime(t.createdAt),
      updatedAt: fmtTime(t.updatedAt),
      completedAt: fmtTime(t.completedAt),
    };
  }

  // ------------------------------------------------------------------ колбэк антифрода (internal-antifraud.yaml)

  receiveDecision(body) {
    const errors = [];
    if (typeof body?.decisionId !== 'string' || !UUID_RE.test(body.decisionId)) errors.push({ field: 'decisionId', message: 'UUID' });
    if (typeof body?.transferId !== 'string' || !UUID_RE.test(body.transferId)) errors.push({ field: 'transferId', message: 'UUID' });
    if (!['ALLOW', 'DENY', 'SUSPEND'].includes(body?.decision)) errors.push({ field: 'decision', message: 'ALLOW, DENY или SUSPEND' });
    if (typeof body?.decidedAt !== 'string' || Number.isNaN(Date.parse(body.decidedAt))) errors.push({ field: 'decidedAt', message: 'Дата и время ISO 8601' });
    if (errors.length) throw validationError(errors);
    const done = this.decisions.get(body.decisionId.toLowerCase());
    if (done) return done; // идемпотентно по decisionId
    const t = this.transfers.get(body.transferId.toLowerCase());
    if (!t || t.syncProblem) throw new ApiError('TRANSFER_NOT_FOUND');
    this.applyDeadlines(t);
    let applied = false;
    if (t.status === 'CHECKING' && !t.confirmedAt) {
      // Первичная проверка ещё идёт: решение сотрудника пришло раньше, чем сервис записал REVIEW
      t.pendingDecision = body.decision;
      applied = true;
    } else if (t.status === 'REVIEW') {
      this.applyReviewDecision(t, body.decision);
      applied = true;
    }
    const result = { applied, transferStatus: clientStatus(t.status) };
    this.decisions.set(body.decisionId.toLowerCase(), result);
    return result;
  }

  applyReviewDecision(t, decision) {
    if (decision === 'ALLOW') this.transition(t, 'POSTING');
    else if (decision === 'DENY') this.transition(t, 'REJECTED', { rejectReason: 'FRAUD_SUSPECTED' });
    else if (decision === 'SUSPEND') this.suspend(t);
  }

  suspend(t) {
    const now = this.now();
    // P-20: до конца дня, следующего за днём приостановки, по Москве
    this.transition(t, 'SUSPENDED', { suspendedAt: now, confirmationDeadline: mskMidnight(addDays(mskDate(now), 2)) });
  }

  // ------------------------------------------------------------------ переход статуса: триггеры ddl.sql

  transition(t, to, patch = {}) {
    const from = t.status;
    if (!TRANSITIONS.has(`${from}>${to}`)) throw new Error(`Переход ${from} → ${to} запрещён статусной моделью`);
    Object.assign(t, patch);
    t.status = to;
    t.version += 1;
    t.updatedAt = this.now();
    if (to === 'COMPLETED') t.completedAt = this.now();
    if (to === 'REVIEW' && t.reviewDeadline == null) t.reviewDeadline = this.now() + P.P11_REVIEW_TTL; // срок не продлевается (TR-21)
    if (isFinal(to)) this.settleLimit(t); // settle_limit
    this.emitEvent(t, from); // emit_event
    this.enqueueTask(t, from); // enqueue_task
    if (to === 'REVIEW' && t.pendingDecision) {
      const d = t.pendingDecision;
      t.pendingDecision = null;
      this.applyReviewDecision(t, d);
    }
  }

  emitEvent(t, from) {
    const prev = clientStatus(from);
    const cur = clientStatus(t.status);
    if (!((from === 'NEW' && t.status === 'HELD') || (from !== 'NEW' && prev !== cur))) return;
    const eventId = randomUUID();
    this.outbox.push({
      eventId, seq: ++this.seq.event, transferId: t.id, transferVersion: t.version, createdAt: this.now(), publishedAt: null,
      payload: {
        eventId, occurredAt: fmtTime(this.now()), transferId: t.id, transferVersion: t.version,
        status: cur, previousStatus: from === 'NEW' ? null : prev, isFinal: isFinal(t.status),
        rejectReason: t.rejectReason, amount: money(t.amount, t.currency),
        senderClientId: t.senderId, recipientClientId: t.recipientId,
      },
      // Сроки для текста пуша сервис уведомлений берёт из API перевода; в mock они лежат рядом с событием
      meta: { confirmationDeadline: fmtTime(t.confirmationDeadline), executeAfter: fmtTime(t.executeAfter) },
    });
  }

  enqueueTask(t, from) {
    const to = t.status;
    let kind = null;
    let due = this.now();
    if (from === 'NEW' && to === 'HELD') kind = 'ANTIFRAUD_CHECK';
    else if (from === 'SUSPENDED' && to === 'CHECKING') kind = 'CONFIRMATION_CHECK';
    else if (to === 'COOLING') { kind = 'RESUME'; due = t.executeAfter; }
    else if (to === 'POSTING') kind = 'POST';
    else if (from === 'NEW' && to === 'REJECTED') kind = null; // холда не было
    else if (['REJECTED', 'CANCELLED', 'FAILED'].includes(to)) kind = 'RELEASE_HOLD';
    if (isFinal(to)) {
      for (const k of this.tasks) if (k.transferId === t.id && !k.doneAt) this.finishTask(k, 'NOT_NEEDED');
    }
    if (kind) this.addTask(t.id, kind, due);
  }

  addTask(transferId, kind, dueAt) {
    if (this.tasks.some((k) => k.transferId === transferId && k.kind === kind)) {
      throw new Error(`UNIQUE (transfer_id, kind): ${transferId} ${kind}`);
    }
    const task = { id: ++this.seq.task, transferId, kind, dueAt, attempts: 0, lastError: null, createdAt: this.now(), doneAt: null, outcome: null };
    this.tasks.push(task);
    return task;
  }

  finishTask(task, outcome) {
    task.doneAt = this.now();
    task.outcome = outcome;
  }

  // P-17: пауза растёт вдвое от 1 с до потолка, разброс ± 50% — как transfers.retry_task
  retryTask(task, error, cap) {
    const pause = Math.min(cap, 1000 * 2 ** Math.min(task.attempts, 20)) * (0.5 + this.random());
    task.attempts += 1;
    task.lastError = error;
    task.dueAt = this.now() + pause;
  }

  // ------------------------------------------------------------------ исполнитель задач продолжения

  dueTask() {
    const now = this.now();
    let best = null;
    for (const k of this.tasks) {
      if (k.doneAt || k.dueAt > now) continue;
      // Старые переводы первыми (TR-20): при равном сроке — по времени создания перевода
      if (!best || k.dueAt < best.dueAt || (k.dueAt === best.dueAt && this.transfers.get(k.transferId).createdAt < this.transfers.get(best.transferId).createdAt)) best = k;
    }
    return best;
  }

  runTask(task) {
    const t = this.transfers.get(task.transferId);
    switch (task.kind) {
      case 'ANTIFRAUD_CHECK': return this.runAntifraudCheck(task, t);
      case 'CONFIRMATION_CHECK': return this.runConfirmationCheck(task, t);
      case 'RESUME':
        if (t.status === 'COOLING') this.transition(t, 'POSTING');
        if (!task.doneAt) this.finishTask(task, 'RESUMED');
        return;
      case 'POST': return this.runPost(task, t);
      case 'RELEASE_HOLD': return this.runRelease(task, t);
      default: throw new Error(`Неизвестная задача ${task.kind}`);
    }
  }

  runAntifraudCheck(task, t) {
    if (t.status === 'HELD') this.transition(t, 'CHECKING');
    if (!['CHECKING', 'REVIEW'].includes(t.status)) return this.finishTask(task, 'NOT_NEEDED');
    const decision = this.callAntifraud(task, t, 'INITIAL');
    if (decision === null) return; // ждёт пробы предохранителя или очереди P-18
    if (decision === 'TIMEOUT') {
      // TR-20: перевод уходит на проверку, проверка повторяется с растущей паузой до P-10
      if (t.status === 'CHECKING') this.transition(t, 'REVIEW');
      if (!task.doneAt) this.retryTask(task, 'TIMEOUT', P.P10_ANTIFRAUD_RETRY_CAP);
      return;
    }
    this.finishTask(task, decision);
    if (t.pendingDecision && decision !== 'REVIEW') {
      // Колбэк с решением сотрудника пришёл, а проверка ответила сама: применяется ответ проверки,
      // расхождение антифрода разбирается как инцидент. Колбэку уже ответили applied: true
      this.incident('ANTIFRAUD_DECISION_DISCARDED', t.id, `Решение сотрудника ${t.pendingDecision} не применено: проверка ответила ${decision}`);
      t.pendingDecision = null;
    }
    if (decision === 'ALLOW') this.transition(t, 'POSTING');
    else if (decision === 'DENY') this.transition(t, 'REJECTED', { rejectReason: 'FRAUD_SUSPECTED' });
    else if (decision === 'SUSPEND') this.suspend(t);
    else if (decision === 'REVIEW' && t.status === 'CHECKING') this.transition(t, 'REVIEW'); // ждём колбэк
  }

  runConfirmationCheck(task, t) {
    if (t.status !== 'CHECKING') return this.finishTask(task, 'NOT_NEEDED');
    const decision = this.callAntifraud(task, t, 'CONFIRMATION');
    if (decision === null) return;
    if (decision === 'TIMEOUT') return this.retryTask(task, 'TIMEOUT', P.P10_ANTIFRAUD_RETRY_CAP); // перевод остаётся в обработке
    this.finishTask(task, decision);
    if (decision === 'ALLOW') this.transition(t, 'POSTING');
    else this.transition(t, 'COOLING', { executeAfter: t.suspendedAt + P.P21_COOLING }); // TR-37: 2 дня от приостановки
  }

  // Вызов антифрода с предохранителем (P-19) и ограниченным разбором очереди (P-18)
  callAntifraud(task, t, stage) {
    const now = this.now();
    const b = this.breaker;
    if (b.state === 'OPEN') {
      if (now < b.nextProbeAt) {
        task.dueAt = b.nextProbeAt; // проверка по каждому переводу не уходит, ждём пробу
        return null;
      }
      b.nextProbeAt = now + P.P19_BREAKER_PROBE_PERIOD; // этот вызов — проба
      b.probes += 1;
    }
    const refill = ((now - this.bucket.at) / 1000) * P.P18_ANTIFRAUD_DRAIN_PER_SECOND;
    this.bucket = { tokens: Math.min(P.P18_ANTIFRAUD_DRAIN_PER_SECOND, this.bucket.tokens + refill), at: now };
    if (this.bucket.tokens < 1) {
      task.dueAt = now + Math.ceil(((1 - this.bucket.tokens) / P.P18_ANTIFRAUD_DRAIN_PER_SECOND) * 1000);
      return null;
    }
    this.bucket.tokens -= 1;
    this.antifraudStats.calls += 1;
    const attempt = this.antifraudChecks.filter((c) => c.transferId === t.id).length + 1;
    const recipient = this.clients.get(t.recipientId);
    const outcome = this.faults.antifraud !== 'UP' ? 'TIMEOUT' : stage === 'INITIAL' ? recipient.antifraud.initial : recipient.antifraud.confirmation;
    this.antifraudChecks.push({ transferId: t.id, attempt, stage, outcome, sentAt: now });
    if (outcome === 'TIMEOUT') {
      this.antifraudStats.timeouts += 1;
      b.failuresInRow += 1;
      if (b.state === 'OPEN') return 'TIMEOUT';
      if (b.failuresInRow >= P.P19_BREAKER_THRESHOLD) {
        b.state = 'OPEN';
        b.opened += 1;
        b.nextProbeAt = now + P.P19_BREAKER_PROBE_PERIOD;
        this.alert('ANTIFRAUD_BREAKER_OPEN', { detail: `${b.failuresInRow} отказов подряд, проба раз в 10 с` });
      }
      return 'TIMEOUT';
    }
    b.failuresInRow = 0;
    if (b.state === 'OPEN') {
      // Проба прошла: очередь разбирается сразу, но не быстрее P-18, старые переводы первыми
      b.state = 'CLOSED';
      for (const k of this.tasks) {
        if (!k.doneAt && ['ANTIFRAUD_CHECK', 'CONFIRMATION_CHECK'].includes(k.kind) && k.dueAt > now) k.dueAt = now;
      }
    }
    return outcome;
  }

  runPost(task, t) {
    if (t.status !== 'POSTING') return this.finishTask(task, 'NOT_NEEDED');
    let r;
    try {
      r = this.ledgerCall(() => this.postTransfer(t.id, t.targetAccountId));
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
      // Исход неизвестен: повтор с тем же transferId, леджер второй раз не проведёт (TR-16, TR-30)
      return this.retryTask(task, e.message, P.P17_LEDGER_RETRY_CAP);
    }
    this.finishTask(task, r);
    if (r === 'POSTED' || r === 'ALREADY_POSTED') this.transition(t, 'COMPLETED');
    else if (r === 'RECIPIENT_ACCOUNT_UNAVAILABLE' || r === 'SOURCE_ACCOUNT_UNAVAILABLE') this.transition(t, 'REJECTED', { rejectReason: r });
    else {
      this.incident('POSTING_WITHOUT_HOLD', t.id, `Леджер ответил ${r}: холда нет, проводить нельзя`);
      this.transition(t, 'FAILED');
    }
  }

  runRelease(task, t) {
    try {
      const r = this.ledgerCall(() => this.releaseHold(t.id));
      this.finishTask(task, r);
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
      this.retryTask(task, e.message, P.P17_LEDGER_RETRY_CAP);
    }
  }

  // Потерянная задача: дефект, который должна поймать регламентная проверка (отказ 23, US-07)
  dropTasks(transferId) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((k) => !(k.transferId === transferId && !k.doneAt));
    return { dropped: before - this.tasks.length };
  }

  // ------------------------------------------------------------------ регламентная проверка раз в P-08 (TR-17, TR-30)

  sweep() {
    const now = this.now();
    for (const t of this.transfers.values()) {
      this.applyDeadlines(t);
      // Перевод в NEW дольше P-12: FAILED и снятие холда, которое закроет операцию в леджере
      if (t.status === 'NEW' && t.createdAt < now - P.P12_INTERMEDIATE_TTL && !(t.leaseUntil > now)) {
        t.leaseUntil = null;
        this.transition(t, 'FAILED');
      }
      // Перевод в HELD, CHECKING или POSTING без открытой задачи: восстановить задачу и завести инцидент
      if (['HELD', 'CHECKING', 'POSTING'].includes(t.status) && !this.tasks.some((k) => k.transferId === t.id && !k.doneAt)) {
        const kind = t.status === 'POSTING' ? 'POST' : t.confirmedAt ? 'CONFIRMATION_CHECK' : 'ANTIFRAUD_CHECK';
        this.tasks = this.tasks.filter((k) => !(k.transferId === t.id && k.kind === kind));
        this.addTask(t.id, kind, now);
        this.incident('NO_OPEN_TASK', t.id, `Перевод в ${t.status} без открытой задачи, задача ${kind} восстановлена`);
      }
    }
    // Задача не выполнена дольше P-12: алерт операционному отделу
    for (const k of this.tasks) {
      if (k.doneAt || k.alerted) continue;
      if ((k.attempts > 0 && k.createdAt < now - P.P12_INTERMEDIATE_TTL) || k.dueAt < now - P.P12_INTERMEDIATE_TTL) {
        k.alerted = true;
        this.alert('TASK_OVERDUE', { transferId: k.transferId, taskKind: k.kind, attempts: k.attempts, lastError: k.lastError });
      }
    }
    // Холд без активного перевода и без задачи снятия: снять и завести инцидент
    if (this.faults.ledger === 'UP') {
      for (const h of this.holds.values()) {
        if (h.status !== 'ACTIVE') continue;
        const t = this.transfers.get(h.transferId);
        const releasing = this.tasks.some((k) => k.transferId === h.transferId && k.kind === 'RELEASE_HOLD' && !k.doneAt);
        if ((!t || isFinal(t.status)) && !releasing) {
          this.releaseHold(h.transferId);
          this.incident('HOLD_WITHOUT_TRANSFER', h.transferId, 'Холд без активного перевода и без задачи снятия снят регламентной проверкой');
        }
      }
    }
    // Лаг outbox больше 30 с
    const lagging = this.outbox.find((e) => !e.publishedAt && e.createdAt < now - P.OUTBOX_LAG_ALERT);
    if (lagging && !this.alerts.some((a) => a.type === 'OUTBOX_LAG' && !a.resolvedAt)) {
      this.alert('OUTBOX_LAG', { oldestEventId: lagging.eventId, detail: 'Relay не публикует события' });
    }
    if (!lagging) for (const a of this.alerts) if (a.type === 'OUTBOX_LAG' && !a.resolvedAt) a.resolvedAt = now;
  }

  alert(type, data) {
    const a = { id: ++this.seq.alert, type, at: fmtTime(this.now()), resolvedAt: null, ...data };
    this.alerts.push(a);
    return a;
  }

  incident(type, transferId, detail) {
    this.incidents.push({ id: ++this.seq.incident, type, transferId, detail, at: fmtTime(this.now()) });
  }

  // ------------------------------------------------------------------ relay outbox и потребители событий (TR-27…TR-29)

  relay() {
    if (this.faults.relay !== 'UP') return false;
    let published = false;
    for (const e of this.outbox.sort((a, b) => a.seq - b.seq)) {
      if (e.publishedAt) continue;
      e.publishedAt = this.now();
      this.deliver(e, false);
      published = true;
    }
    return published;
  }

  // Событие пришло потребителям. redelivery — повторная доставка того же события (дубль «хотя бы один раз»)
  deliver(entry, poison) {
    const event = entry.payload;
    if (poison) this.poisoned.add(event.eventId);
    // Потребитель истории: дедупликация по eventId, финальный статус не откатывается (TR-29)
    if (!this.historySeen.has(event.eventId)) {
      this.historySeen.add(event.eventId);
      const cur = this.history.get(event.transferId);
      if (!cur || (event.transferVersion > cur.transferVersion && !cur.isFinal)) {
        this.history.set(event.transferId, { status: event.status, transferVersion: event.transferVersion, isFinal: event.isFinal, eventId: event.eventId });
      }
    }
    // Потребитель уведомлений: по доставке на каждую пару «событие + адресат» (D-14)
    for (const to of this.pushTargets(event)) {
      if (this.deliveries.some((d) => d.eventId === event.eventId && d.to === to)) continue;
      this.deliveries.push({ eventId: event.eventId, to, event, meta: entry.meta, state: 'PENDING', attempts: 0, dueAt: this.now() });
    }
  }

  pushTargets(e) {
    const targets = [];
    if (['ON_REVIEW', 'AWAITING_CONFIRMATION', 'DELAYED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED'].includes(e.status)) targets.push('SENDER');
    if (e.status === 'COMPLETED') targets.push('RECIPIENT'); // получатель узнаёт только о выполненном переводе
    return targets;
  }

  pushText(e, to, meta) {
    const amount = toKop(e.amount.value);
    if (to === 'RECIPIENT') return `${this.clients.get(e.senderClientId).name} перевёл вам ${humanMoney(amount, e.amount.currency)}`;
    switch (e.status) {
      case 'ON_REVIEW': return 'Перевод на проверке, можно отменить';
      case 'AWAITING_CONFIRMATION': return `Подтвердите перевод до ${meta.confirmationDeadline}`;
      case 'DELAYED': return `Перевод будет выполнен не раньше ${meta.executeAfter}`;
      case 'COMPLETED': return 'Перевод выполнен';
      case 'REJECTED': return e.rejectReason === 'FRAUD_SUSPECTED' ? 'Банк не может выполнить этот перевод' : `Перевод отклонён: ${REJECT_TEXT[e.rejectReason]}`;
      case 'CANCELLED': return 'Перевод отменён';
      case 'FAILED': return 'Перевод не выполнен, деньги не списаны';
      default: return null;
    }
  }

  consume() {
    const now = this.now();
    let progressed = false;
    for (const d of this.deliveries) {
      if (!['PENDING', 'RETRY'].includes(d.state) || d.dueAt > now) continue;
      progressed = true;
      d.attempts += 1;
      const fails = this.poisoned.has(d.eventId) || (d.to === 'RECIPIENT' && this.faults.pushRecipientFailures > 0);
      if (!fails) {
        d.state = 'DONE';
        const clientId = d.to === 'SENDER' ? d.event.senderClientId : d.event.recipientClientId;
        this.pushes.push({ id: ++this.seq.push, eventId: d.eventId, transferId: d.event.transferId, to: d.to, clientId, text: this.pushText(d.event, d.to, d.meta), collapseKey: d.event.transferId, at: fmtTime(now) });
        continue;
      }
      if (d.to === 'RECIPIENT' && this.faults.pushRecipientFailures > 0 && !this.poisoned.has(d.eventId)) this.faults.pushRecipientFailures -= 1;
      // Три попытки, затем топики повтора 1, 5 и 15 мин, затем DLQ с алертом. Партиция не блокируется
      const retryNo = d.attempts - 1;
      if (retryNo < P.CONSUMER_RETRY_DELAYS.length) {
        d.state = 'RETRY';
        d.dueAt = now + P.CONSUMER_RETRY_DELAYS[retryNo];
      } else {
        d.state = 'DLQ';
        this.dlq.push({ consumer: 'notifications', eventId: d.eventId, transferId: d.event.transferId, to: d.to, attempts: d.attempts, at: fmtTime(now) });
        this.alert('EVENT_IN_DLQ', { consumer: 'notifications', eventId: d.eventId });
      }
    }
    return progressed;
  }

  // Повторная доставка события: дубль (отказ 12), перестановка (отказ 13) или битое событие (отказ 14)
  // reorder — событие приходит позже следующих впервые, а не как дубль: потребитель истории его ещё не видел
  redeliver(eventId, { poison = false, reorder = false } = {}) {
    const e = this.outbox.find((x) => x.eventId === eventId);
    if (!e || !e.publishedAt) return null;
    if (reorder) this.historySeen.delete(eventId);
    if (poison) {
      // Битое событие: доставки по нему начинаются заново и падают
      this.deliveries = this.deliveries.filter((d) => d.eventId !== eventId);
    }
    this.deliver(e, poison);
    return { eventId, redelivered: true, poison, reorder, history: this.history.get(e.transferId) };
  }

  // ------------------------------------------------------------------ ежедневная сверка (TR-31), та же логика, что в reconciliation.sql

  reconcile(day = mskDate(this.now())) {
    // Проводка по переводу относится к дню выполнения перевода, проводка без выполненного перевода — к дню проводки
    const discrepancies = [];
    const warnings = [];
    const completed = [...this.transfers.values()].filter((t) => t.status === 'COMPLETED' && mskDate(t.completedAt) === day);
    const transferPostings = this.postings.filter((p) => p.kind === 'TRANSFER');
    const dayPostings = [];
    for (const t of completed) {
      const own = transferPostings.filter((p) => p.transferId === t.id);
      dayPostings.push(...own);
      if (own.length === 0) discrepancies.push({ type: 'COMPLETED_WITHOUT_POSTING', transferId: t.id });
      else if (own[0].amount !== t.amount || own[0].debit !== t.sourceAccountId || own[0].credit !== t.targetAccountId || own[0].currency !== t.currency) {
        discrepancies.push({ type: 'POSTING_MISMATCH', transferId: t.id });
      }
    }
    for (const p of transferPostings.filter((x) => mskDate(x.postedAt) === day)) {
      const t = this.transfers.get(p.transferId);
      if (t?.status === 'COMPLETED') continue;
      // Перевод в POSTING: ответ леджера ещё не обработан (отказ 8), перевод доведёт задача проводки
      if (t?.status === 'POSTING') warnings.push({ type: 'POSTED_NOT_YET_COMPLETED', transferId: p.transferId });
      else {
        dayPostings.push(p);
        discrepancies.push({ type: 'POSTING_WITHOUT_COMPLETED_TRANSFER', transferId: p.transferId, postingId: p.id });
      }
    }
    const totals = {};
    for (const c of CURRENCIES) {
      const tSum = completed.filter((t) => t.currency === c).reduce((s, t) => s + t.amount, 0n);
      const pSum = dayPostings.filter((p) => p.currency === c).reduce((s, p) => s + p.amount, 0n);
      if (tSum || pSum) totals[c] = { transfers: kopToValue(tSum), postings: kopToValue(pSum) };
      if (tSum !== pSum) discrepancies.push({ type: 'DAY_TOTAL_MISMATCH', currency: c, transfers: kopToValue(tSum), postings: kopToValue(pSum) });
    }
    for (const a of this.accounts.values()) {
      const sum = this.postings.reduce((s, p) => s + (p.credit === a.id ? p.amount : 0n) - (p.debit === a.id ? p.amount : 0n), 0n);
      if (sum !== a.balance) discrepancies.push({ type: 'BALANCE_PROJECTION_MISMATCH', accountId: a.id });
    }
    for (const h of this.holds.values()) {
      const t = this.transfers.get(h.transferId);
      const releasing = this.tasks.some((k) => k.transferId === h.transferId && k.kind === 'RELEASE_HOLD' && !k.doneAt);
      if (h.status === 'ACTIVE' && (!t || isFinal(t.status)) && !releasing) discrepancies.push({ type: 'HOLD_NOT_RELEASED', transferId: h.transferId });
    }
    if (discrepancies.length) this.alert('RECONCILIATION_MISMATCH', { day, count: discrepancies.length });
    return { day, ok: discrepancies.length === 0, completedTransfers: completed.length, totals, discrepancies, warnings };
  }

  // ------------------------------------------------------------------ внутреннее представление для тестов

  internalView(id) {
    const t = this.transfers.get(id);
    if (!t) return null;
    return {
      id: t.id, status: t.status, clientStatus: clientStatus(t.status), rejectReason: t.rejectReason, version: t.version,
      amount: money(t.amount, t.currency), amountRub: kopToValue(t.amountRub), rateDate: t.rateDate,
      recipientClientId: t.recipientId, targetAccountId: t.targetAccountId,
      reviewDeadline: fmtTime(t.reviewDeadline), confirmationDeadline: fmtTime(t.confirmationDeadline),
      confirmedAt: fmtTime(t.confirmedAt), executeAfter: fmtTime(t.executeAfter), leaseUntil: fmtTime(t.leaseUntil),
      hold: this.holds.has(t.id) ? { ...this.holds.get(t.id), amount: kopToValue(this.holds.get(t.id).amount), createdAt: fmtTime(this.holds.get(t.id).createdAt), closedAt: fmtTime(this.holds.get(t.id).closedAt) } : null,
      operationClosed: this.closedOps.has(t.id),
      postings: this.postings.filter((p) => p.transferId === t.id).map((p) => ({ id: p.id, kind: p.kind, debit: p.debit, credit: p.credit, amount: kopToValue(p.amount), currency: p.currency })),
      tasks: this.tasks.filter((k) => k.transferId === t.id).map((k) => ({ kind: k.kind, attempts: k.attempts, done: !!k.doneAt, outcome: k.outcome, lastError: k.lastError, dueAt: fmtTime(k.dueAt) })),
      antifraudChecks: this.antifraudChecks.filter((c) => c.transferId === t.id).map((c) => ({ attempt: c.attempt, stage: c.stage, outcome: c.outcome })),
      events: this.outbox.filter((e) => e.transferId === t.id).map((e) => ({ eventId: e.eventId, transferVersion: e.transferVersion, status: e.payload.status, published: !!e.publishedAt })),
      pushes: this.pushes.filter((p) => p.transferId === t.id),
      history: this.history.get(t.id) ?? null,
    };
  }

  antifraudView() {
    return { mode: this.faults.antifraud, breaker: { ...this.breaker, nextProbeAt: fmtTime(this.breaker.nextProbeAt) }, ...this.antifraudStats };
  }
}
