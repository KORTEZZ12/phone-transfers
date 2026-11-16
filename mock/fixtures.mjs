// Тестовые клиенты, счета, курсы и параметры mock-сервера.
// Банк вымышленный. Идентификаторы счетов Петра совпадают с примерами из openapi.yaml.

// Параметры из business-rules.md, время — в миллисекундах, суммы — в копейках
export const P = {
  P01_TOKEN_TTL: 10 * 60e3,
  P02_LOOKUPS_PER_MINUTE: 10,
  P03_LOOKUPS_PER_DAY: 50,
  P04_OPERATION_LIMIT: 300_000_00n,
  P05_DAY_LIMIT: 500_000_00n,
  P06_MONTH_LIMIT: 2_000_000_00n,
  P08_SWEEP_PERIOD: 15 * 60e3,
  P10_ANTIFRAUD_RETRY_CAP: 5 * 60e3,
  P11_REVIEW_TTL: 48 * 3600e3,
  P12_INTERMEDIATE_TTL: 5 * 60e3,
  P13_COMMENT_LENGTH: 140,
  P14_LEASE: 30e3,
  P17_LEDGER_RETRY_CAP: 60e3,
  P18_ANTIFRAUD_DRAIN_PER_SECOND: 100,
  P19_BREAKER_THRESHOLD: 20,
  P19_BREAKER_PROBE_PERIOD: 10e3,
  P21_COOLING: 2 * 24 * 3600e3,
  OUTBOX_LAG_ALERT: 30e3,
  CONSUMER_RETRY_DELAYS: [60e3, 5 * 60e3, 15 * 60e3],
};

// Технические счета банка: из них пополняются счета клиентов прочей проводкой (OTHER)
export const BANK_ACCOUNTS = [
  { id: 'b0000000-0000-4000-8000-000000000643', currency: 'RUB' },
  { id: 'b0000000-0000-4000-8000-000000000840', currency: 'USD' },
  { id: 'b0000000-0000-4000-8000-000000000978', currency: 'EUR' },
  { id: 'b0000000-0000-4000-8000-000000000156', currency: 'CNY' },
];

// antifraud.initial — ответ на проверку перевода этому получателю: ALLOW, DENY, REVIEW, SUSPEND.
// antifraud.confirmation — ответ на повторную сверку с базой ЦБ после подтверждения: ALLOW, DELAY
export const CLIENTS = [
  {
    key: 'petr', id: 'c0000000-0000-4000-8000-000000000001', name: 'Пётр С.', phone: '+79990000001',
    accounts: [
      { id: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6b', currency: 'RUB', primary: true, status: 'OPEN', balance: '1000000.00' },
      { id: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6c', currency: 'USD', primary: true, status: 'OPEN', balance: '20000.00' },
      { id: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6d', currency: 'RUB', primary: false, status: 'BLOCKED', balance: '50000.00' },
      { id: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6e', currency: 'RUB', primary: false, status: 'OPEN', balance: '100.00' },
    ],
  },
  {
    // За сегодня уже перевела 480 000 ₽, за месяц — 640 000 ₽: пример из US-02 и openapi.yaml
    key: 'olga', id: 'c0000000-0000-4000-8000-000000000002', name: 'Ольга К.', phone: '+79990000002',
    limitUsed: { day: '480000.00', month: '640000.00' },
    accounts: [
      { id: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c70', currency: 'RUB', primary: true, status: 'OPEN', balance: '900000.00' },
    ],
  },
  {
    key: 'ivan', id: 'c0000000-0000-4000-8000-000000000003', name: 'Иван П.', phone: '+79991234567',
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000000301', currency: 'RUB', primary: true, status: 'OPEN', balance: '5000.00' },
      { id: 'a0000000-0000-4000-8000-000000000302', currency: 'USD', primary: true, status: 'OPEN', balance: '0.00' },
    ],
  },
  {
    key: 'anna', id: 'c0000000-0000-4000-8000-000000000004', name: 'Анна М.', phone: '+79992223344',
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000000401', currency: 'RUB', primary: true, status: 'OPEN', balance: '0.00' },
    ],
  },
  {
    key: 'oleg', id: 'c0000000-0000-4000-8000-000000000005', name: 'Олег Ф.', phone: '+79996660000',
    antifraud: { initial: 'DENY' },
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000000501', currency: 'RUB', primary: true, status: 'OPEN', balance: '0.00' },
    ],
  },
  {
    key: 'sergey', id: 'c0000000-0000-4000-8000-000000000006', name: 'Сергей Н.', phone: '+79997770000',
    antifraud: { initial: 'SUSPEND', confirmation: 'DELAY' },
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000000601', currency: 'RUB', primary: true, status: 'OPEN', balance: '0.00' },
    ],
  },
  {
    key: 'maria', id: 'c0000000-0000-4000-8000-000000000007', name: 'Мария Л.', phone: '+79997771111',
    antifraud: { initial: 'SUSPEND', confirmation: 'ALLOW' },
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000000701', currency: 'RUB', primary: true, status: 'OPEN', balance: '0.00' },
    ],
  },
  {
    key: 'gleb', id: 'c0000000-0000-4000-8000-000000000008', name: 'Глеб Р.', phone: '+79998880000',
    antifraud: { initial: 'REVIEW' },
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000000801', currency: 'RUB', primary: true, status: 'OPEN', balance: '0.00' },
    ],
  },
  {
    // Клиент без открытого основного счёта: при поиске он «не найден» (TR-05)
    key: 'nina', id: 'c0000000-0000-4000-8000-000000000009', name: 'Нина Б.', phone: '+79995550000',
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000000901', currency: 'RUB', primary: true, status: 'CLOSED', balance: '0.00' },
    ],
  },
  {
    // Новый владелец номера в сценарии «номер перешёл к другому клиенту» (отказ 10)
    key: 'dmitry', id: 'c0000000-0000-4000-8000-000000000010', name: 'Дмитрий Ж.', phone: '+79994440000',
    accounts: [
      { id: 'a0000000-0000-4000-8000-000000001001', currency: 'RUB', primary: true, status: 'OPEN', balance: '0.00' },
    ],
  },
];

// Курсы ЦБ: рублей за nominal единиц, как Vcurs и Vnom в DailyInfo
export const RATES = {
  USD: { nominal: 1, rate: '92.0000' },
  EUR: { nominal: 1, rate: '100.0000' },
  CNY: { nominal: 1, rate: '12.5000' },
};

// Старт виртуальных часов: полдень по Москве. Фиксированная дата делает прогон воспроизводимым
export const DEFAULT_START = '2026-11-16T12:00:00+03:00';
