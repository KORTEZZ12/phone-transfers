// Сценарии Postman-коллекции. Из этого файла build.mjs собирает phone-transfers.postman_collection.json.
// Каждая папка — одна тема из таблицы отказов или истории, начинается со сброса mock и не зависит от других.
// Функции pre и test не выполняются здесь: сборщик берёт их текст и кладёт в скрипты Postman,
// поэтому внутри них доступны только pm, помощники из lib() и константы из consts.

// ------------------------------------------------------------------ окружение

export const environment = {
  baseUrl: 'http://localhost:4010',
  token_petr: 'mock-petr',
  token_olga: 'mock-olga',
  token_ivan: 'mock-ivan',
  petrRub: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6b',
  petrUsd: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6c',
  petrBlocked: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6d',
  petrSmall: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c6e',
  olgaRub: '0b8e7d6c-5a4f-4e3d-9c2b-1a0f9e8d7c70',
  ivanRub: 'a0000000-0000-4000-8000-000000000301',
  ivanUsd: 'a0000000-0000-4000-8000-000000000302',
  annaRub: 'a0000000-0000-4000-8000-000000000401',
  dmitryRub: 'a0000000-0000-4000-8000-000000001001',
  dmitryId: 'c0000000-0000-4000-8000-000000000010',
  bankRub: 'b0000000-0000-4000-8000-000000000643',
};

const PHONE = {
  petr: '+79990000001', ivan: '+79991234567', anna: '+79992223344', oleg: '+79996660000',
  sergey: '+79997770000', maria: '+79997771111', gleb: '+79998880000', nina: '+79995550000',
};

// ------------------------------------------------------------------ помощники внутри скриптов Postman

export function lib() {
  const BASE = pm.environment.get('baseUrl');
  const v = (k) => pm.collectionVariables.get(k);
  const setv = (k, x) => pm.collectionVariables.set(k, x);
  const json = () => pm.response.json();
  const ms = (iso) => Date.parse(iso);
  const MIN = 60e3;
  const HOUR = 3600e3;
  function status(code) {
    pm.test(`HTTP ${code}`, () => pm.response.to.have.status(code));
  }
  function problem(httpStatus, code) {
    pm.test(`${httpStatus} ${code}`, () => {
      pm.response.to.have.status(httpStatus);
      pm.expect(json().code).to.equal(code);
    });
  }
  function expectStatus(expected) {
    pm.test(`Статус перевода ${expected}`, () => pm.expect(json().status).to.equal(expected));
  }
  function call(method, path, payload, cb, headers) {
    pm.sendRequest({
      url: BASE + path,
      method,
      header: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: payload === undefined || payload === null ? undefined : { mode: 'raw', raw: JSON.stringify(payload) },
    }, (err, res) => {
      if (err) return pm.test(`Запрос ${method} ${path}`, () => { throw err; });
      let data = null;
      try { data = res.json(); } catch (e) { data = res.text(); }
      if (cb) cb(data, res);
    });
  }
  const mock = (method, path, payload, cb) => call(method, '/__mock' + path, payload, cb);
  const api = (as, method, path, payload, cb, headers) =>
    call(method, path, payload, cb, Object.assign({ Authorization: 'Bearer ' + pm.environment.get('token_' + as) }, headers || {}));
  const guid = () => pm.variables.replaceIn('{{$guid}}');
}

// ------------------------------------------------------------------ строители шагов

const step = (name, o) => ({ name, ...o });

const reset = () => step('Сброс mock: клиенты, счета и время — в исходное состояние', {
  method: 'POST', path: '/__mock/reset',
  pre: function () { pm.collectionVariables.clear(); },
  test: function () { status(200); },
});

const advance = (seconds, name) => step(name ?? `Время +${seconds} с`, {
  method: 'POST', path: '/__mock/clock/advance', body: { seconds },
  test: function () { status(200); },
});

const faults = (name, body) => step(name, {
  method: 'POST', path: '/__mock/faults', body,
  test: function () { status(200); },
});

const lookup = (name, { as = 'petr', phone, save = 'tok' }, test) => step(name, {
  method: 'POST', path: '/v1/recipients/lookup', as, body: { phone }, consts: { SAVE: save },
  test: test ?? function () {
    status(200);
    setv(SAVE, json().recipientToken);
  },
});

// Создание перевода. fresh — новый ключ идемпотентности перед запросом, иначе повтор с тем же ключом
function create(name, o, test) {
  const { as = 'petr', key = 'k1', fresh = true, token = 'tok', account = 'petrRub', amount = '1500.00', currency = 'RUB', comment, device = true, save, body } = o;
  const headers = {};
  if (device) headers['X-Device-Id'] = 'ios-mock-7F3A9C21';
  if (key) headers['Idempotency-Key'] = `{{${key}}}`;
  return step(name, {
    method: 'POST', path: '/v1/transfers', as, headers, consts: { KEY: key ?? null, SAVE: save ?? null },
    body: body ?? { recipientToken: `{{${token}}}`, sourceAccountId: `{{${account}}}`, amount: { value: amount, currency }, ...(comment !== undefined ? { comment } : {}) },
    pre: fresh && key ? function () { setv(KEY, guid()); } : undefined,
    save: !!save,
    test,
  });
}

const get = (name, id, test, as = 'petr') => step(name, { method: 'GET', path: `/v1/transfers/{{${id}}}`, as, test });
const cancel = (name, id, test, as = 'petr') => step(name, { method: 'POST', path: `/v1/transfers/{{${id}}}/cancel`, as, test });
const confirm = (name, id, test, as = 'petr') => step(name, { method: 'POST', path: `/v1/transfers/{{${id}}}/confirm`, as, test });
const internal = (name, id, test) => step(name, { method: 'GET', path: `/__mock/transfers/{{${id}}}`, test });
const account = (name, envKey, test) => step(name, { method: 'GET', path: `/__mock/accounts/{{${envKey}}}`, test });
const limits = (name, as, test) => step(name, { method: 'GET', path: '/v1/transfer-limits', as, test });
const control = (name, method, path, body, test) => step(name, { method, path, ...(body !== undefined ? { body } : {}), test: test ?? function () { status(200); } });
const decision = (name, id, value, decisionKey, test, fresh = true) => step(name, {
  method: 'POST', path: '/internal/v1/antifraud/decisions', consts: { DKEY: decisionKey },
  body: { decisionId: `{{${decisionKey}}}`, transferId: `{{${id}}}`, decision: value, decidedAt: '2026-11-16T12:20:40+03:00', reasonCode: null },
  pre: fresh ? function () { setv(DKEY, guid()); } : undefined,
  test,
});

const folder = (name, meta, items) => ({ name, rows: meta.rows ?? [], rules: meta.rules ?? [], stories: meta.stories ?? [], doc: meta.doc, items: [reset(), ...items] });

// ------------------------------------------------------------------ папки

export const folders = [
  folder('01 Поиск получателя', {
    rows: [16], rules: ['TR-01', 'TR-02', 'TR-03', 'TR-04', 'TR-05'], stories: ['US-01'],
    doc: 'US-01: имя с первой буквой фамилии, токен на 10 минут, свой номер, скрытый статус клиента без счёта, лимит поисков и повтор без расхода лимита.',
  }, [
    lookup('Получатель найден: «Иван П.», валюты и токен на 10 минут', { phone: PHONE.ivan }, function () {
      status(200);
      const b = json();
      pm.test('TR-01 имя и первая буква фамилии', () => pm.expect(b.displayName).to.equal('Иван П.'));
      pm.test('TR-05 валюты основных счетов получателя', () => pm.expect(b.currencies).to.eql(['RUB', 'USD']));
      // Часы mock идут вместе с реальными: сравниваем с текущим временем mock, а не с константой
      mock('GET', '/clock', null, (c) => pm.test('TR-02 токен действует 10 минут', () => {
        const left = ms(b.expiresAt) - ms(c.now);
        pm.expect(left).to.be.within(10 * MIN - 1000, 10 * MIN);
      }));
      setv('tok', b.recipientToken);
    }),
    lookup('Сетевой повтор того же номера возвращает тот же токен', { phone: PHONE.ivan, save: 'tok2' }, function () {
      status(200);
      pm.test('TR-03 тот же токен', () => pm.expect(json().recipientToken).to.equal(v('tok')));
    }),
    lookup('Свой номер: «Это ваш номер»', { phone: PHONE.petr }, function () {
      problem(422, 'SELF_TRANSFER');
      pm.test('TR-04 текст для экрана', () => pm.expect(json().title).to.equal('Это ваш номер'));
    }),
    lookup('Клиент без открытого основного счёта ищется как не найденный', { phone: PHONE.nina }, function () {
      problem(404, 'RECIPIENT_NOT_FOUND');
      setv('ninaDetail', json().detail);
    }),
    lookup('Номер не клиента банка: тот же ответ, статус клиента не раскрывается', { phone: '+79990009999' }, function () {
      problem(404, 'RECIPIENT_NOT_FOUND');
      pm.test('TR-05 ответы неотличимы', () => pm.expect(json().detail).to.equal(v('ninaDetail')));
    }),
    lookup('Номер не в формате +7XXXXXXXXXX', { phone: '89991234567' }, function () {
      problem(400, 'VALIDATION_ERROR');
      pm.test('Подсвечивается поле phone', () => pm.expect(json().errors[0].field).to.equal('phone'));
    }),
    step('Без токена доступа — 401', {
      method: 'POST', path: '/v1/recipients/lookup', body: { phone: PHONE.ivan },
      test: function () { problem(401, 'UNAUTHORIZED'); },
    }),
    lookup('Отказ 16: одиннадцатый поиск за минуту получает 429 и время ожидания', { phone: '+79990001011' }, function () {
      problem(429, 'LOOKUP_RATE_LIMITED');
      pm.test('Retry-After не больше минуты', () => {
        const s = Number(pm.response.headers.get('Retry-After'));
        pm.expect(s).to.be.within(1, 60);
        pm.expect(json().retryAfterSeconds).to.equal(s);
      });
    }),
    lookup('Повтор уже найденного номера проходит и при исчерпанном лимите', { phone: PHONE.ivan, save: 'tok3' }, function () {
      status(200);
      pm.test('TR-03 тот же токен, лимит не расходуется', () => pm.expect(json().recipientToken).to.equal(v('tok')));
    }),
    advance(61, 'Время +61 с: минутное окно прошло'),
    lookup('Через минуту поиск снова доступен', { phone: PHONE.anna, save: 'tokAnna' }),
    advance(600, 'Время +10 мин: токен Ивана истёк'),
    lookup('После истечения токена поиск выдаёт новый токен', { phone: PHONE.ivan, save: 'tok4' }, function () {
      status(200);
      pm.test('TR-02 новый токен', () => pm.expect(json().recipientToken).to.not.equal(v('tok')));
    }),
  ].map((s, i) => (i === 7 ? { ...s, pre: function () {
    // Ещё 6 разных номеров: вместе с уже сделанными это 10 поисков за минуту
    ['+79990001001', '+79990001002', '+79990001003', '+79990001004', '+79990001005', '+79990001006']
      .forEach((p) => api('petr', 'POST', '/v1/recipients/lookup', { phone: p }));
  } } : s))),

  folder('02 Суточный лимит поисков', {
    rows: [16], rules: ['TR-03'], stories: ['US-01'],
    doc: 'P-03: не больше 50 поисков в сутки. После этого — ожидание до полуночи по Москве.',
  }, [
    lookup('51-й поиск за сутки получает 429 до конца суток', { phone: '+79991009999' }, function () {
      problem(429, 'LOOKUP_RATE_LIMITED');
      pm.test('Ждать до полуночи по Москве, больше часа', () => pm.expect(json().retryAfterSeconds).to.be.above(3600));
    }),
  ].map((s) => ({ ...s, pre: function () {
    // 5 серий по 10 поисков с паузой 61 с: минутный лимит не мешает, суточный исчерпан
    let batchNo = 0;
    function batch() {
      if (batchNo >= 5) return;
      let left = 10;
      for (let i = 0; i < 10; i++) {
        const phone = '+7999100' + String(batchNo * 10 + i).padStart(4, '0');
        api('petr', 'POST', '/v1/recipients/lookup', { phone }, () => {
          left -= 1;
          if (left === 0) { batchNo += 1; mock('POST', '/clock/advance', { seconds: 61 }, batch); }
        });
      }
    }
    batch();
  } }))),

  folder('03 Создание перевода', {
    rows: [4], rules: ['TR-06', 'TR-07', 'TR-08', 'TR-09', 'TR-12', 'TR-13', 'TR-14', 'TR-24', 'TR-25', 'TR-32'], stories: ['US-02'],
    doc: 'US-02: сразу видно, принят перевод или отклонён по лимиту, остатку или счёту. Холд, резерв лимита, проводка одной парой.',
  }, [
    lookup('Поиск Ивана', { phone: PHONE.ivan }),
    create('Перевод принят: 201, «В обработке», адрес перевода', { save: 't1', comment: 'За билеты' }, function () {
      status(201);
      expectStatus('PROCESSING');
      pm.test('Location ведёт на перевод', () => pm.expect(pm.response.headers.get('Location')).to.equal('/v1/transfers/' + json().id));
      pm.test('Сумма и комментарий как в запросе', () => {
        pm.expect(json().amount).to.eql({ value: '1500.00', currency: 'RUB' });
        pm.expect(json().comment).to.equal('За билеты');
        pm.expect(json().recipient.displayName).to.equal('Иван П.');
      });
    }),
    account('TR-12: 1 500 ₽ заблокированы на счёте отправителя', 'petrRub', function () {
      status(200);
      pm.test('Холд на сумму перевода', () => pm.expect(json().held).to.equal('1500.00'));
      pm.test('Баланс ещё не изменился', () => pm.expect(json().balance).to.equal('1000000.00'));
    }),
    limits('TR-08: незавершённый перевод уже входит в лимит', 'petr', function () {
      status(200);
      pm.test('Использовано 1 500 ₽ за сутки', () => pm.expect(json().day.used.value).to.equal('1500.00'));
      pm.test('Доступно 498 500 ₽', () => pm.expect(json().day.available.value).to.equal('498500.00'));
    }),
    advance(1, 'Время +1 с: антифрод и проводка'),
    get('Перевод выполнен', 't1', function () {
      status(200);
      expectStatus('COMPLETED');
      pm.test('Время выполнения заполнено', () => pm.expect(json().completedAt).to.be.a('string'));
      pm.test('Отменить уже нельзя', () => pm.expect(json().cancellable).to.equal(false));
    }),
    internal('TR-14: одна проводка «дебет отправителя — кредит получателя»', 't1', function () {
      status(200);
      const p = json().postings;
      pm.test('Ровно одна проводка TRANSFER', () => pm.expect(p.filter((x) => x.kind === 'TRANSFER')).to.have.length(1));
      pm.test('Счета и сумма', () => {
        pm.expect(p[0].debit).to.equal(pm.environment.get('petrRub'));
        pm.expect(p[0].credit).to.equal(pm.environment.get('ivanRub'));
        pm.expect(p[0].amount).to.equal('1500.00');
      });
      pm.test('Холд списан', () => pm.expect(json().hold.status).to.equal('CAPTURED'));
    }),
    account('Получатель получил 1 500 ₽', 'ivanRub', function () {
      pm.test('5 000 + 1 500', () => pm.expect(json().balance).to.equal('6500.00'));
    }),
    create('TR-06: сумма меньше 1 ₽ — ошибка формата', { amount: '0.50' }, function () {
      problem(400, 'VALIDATION_ERROR');
      pm.test('Поле amount.value', () => pm.expect(json().errors.map((e) => e.field)).to.include('amount.value'));
    }),
    create('TR-06: три знака после запятой — ошибка формата', { amount: '10.123' }, function () {
      problem(400, 'VALIDATION_ERROR');
    }),
    create('TR-32: комментарий длиннее 140 символов', { comment: 'х'.repeat(141) }, function () {
      problem(400, 'VALIDATION_ERROR');
      pm.test('Поле comment', () => pm.expect(json().errors.map((e) => e.field)).to.include('comment'));
    }),
    create('Без X-Device-Id — ошибка формата', { device: false }, function () {
      problem(400, 'VALIDATION_ERROR');
      pm.test('Поле X-Device-Id', () => pm.expect(json().errors.map((e) => e.field)).to.include('X-Device-Id'));
    }),
    create('Без ключа идемпотентности', { key: null }, function () {
      problem(400, 'IDEMPOTENCY_KEY_REQUIRED');
    }),
    create('Чужой счёт списания: 403', { account: 'ivanRub' }, function () {
      problem(403, 'ACCOUNT_NOT_OWNED');
    }),
    create('Заблокированный счёт списания: 422 до холда', { account: 'petrBlocked' }, function () {
      problem(422, 'SOURCE_ACCOUNT_UNAVAILABLE');
    }),
    create('Не хватает денег: 422, деньги не блокируются', { account: 'petrSmall', amount: '500.00' }, function () {
      problem(422, 'INSUFFICIENT_FUNDS');
    }),
    account('TR-12: на счёте со 100 ₽ холда нет', 'petrSmall', function () {
      pm.test('Ничего не заблокировано', () => pm.expect(json().held).to.equal('0.00'));
    }),
    create('TR-07: больше лимита на операцию', { amount: '300000.01' }, function () {
      problem(422, 'LIMIT_EXCEEDED');
      pm.test('Период OPERATION, доступно 300 000 ₽', () => pm.expect(json().limit).to.eql({ period: 'OPERATION', available: { value: '300000.00', currency: 'RUB' } }));
    }),
    lookup('Поиск Анны: у неё только рублёвый счёт', { phone: PHONE.anna, save: 'tokAnna' }),
    create('TR-05: у получателя нет счёта в долларах', { token: 'tokAnna', account: 'petrUsd', amount: '10.00', currency: 'USD' }, function () {
      problem(422, 'RECIPIENT_CURRENCY_UNAVAILABLE');
    }),
    create('TR-24: валюта перевода не совпадает с валютой счёта списания', { account: 'petrUsd', amount: '10.00', currency: 'RUB' }, function () {
      problem(400, 'VALIDATION_ERROR');
      pm.test('Поле amount.currency', () => pm.expect(json().errors.map((e) => e.field)).to.include('amount.currency'));
    }),
    create('TR-24: перевод в долларах между долларовыми счетами', { account: 'petrUsd', amount: '100.00', currency: 'USD', save: 'tUsd' }, function () {
      status(201);
    }),
    internal('TR-25: лимит считается в рублях по курсу ЦБ на дату операции', 'tUsd', function () {
      pm.test('100 $ × 92 ₽ = 9 200 ₽', () => pm.expect(json().amountRub).to.equal('9200.00'));
      pm.test('Дата курса — сегодня', () => pm.expect(json().rateDate).to.equal('2026-11-16'));
      pm.test('Зачисление на долларовый счёт получателя', () => pm.expect(json().targetAccountId).to.equal(pm.environment.get('ivanUsd')));
    }),
    lookup('Ольга ищет Ивана', { as: 'olga', phone: PHONE.ivan, save: 'tokOlga' }),
    limits('У Ольги за сегодня использовано 480 000 ₽ из 500 000 ₽', 'olga', function () {
      pm.test('Доступно 20 000 ₽', () => pm.expect(json().day.available.value).to.equal('20000.00'));
      pm.test('Месяц: использовано 640 000 ₽', () => pm.expect(json().month.used.value).to.equal('640000.00'));
    }),
    create('US-02: 30 000 ₽ при доступных 20 000 ₽ — «Превышен лимит, сегодня доступно 20 000 ₽»', { as: 'olga', token: 'tokOlga', account: 'olgaRub', amount: '30000.00' }, function () {
      problem(422, 'LIMIT_EXCEEDED');
      pm.test('Период DAY, доступно 20 000 ₽', () => pm.expect(json().limit).to.eql({ period: 'DAY', available: { value: '20000.00', currency: 'RUB' } }));
      pm.test('Текст для экрана', () => pm.expect(json().detail).to.equal('Сегодня можно перевести ещё 20 000 ₽.'));
    }),
    account('Деньги Ольги не заблокированы', 'olgaRub', function () {
      pm.test('Холда нет', () => pm.expect(json().held).to.equal('0.00'));
    }),
    create('Ровно 20 000 ₽ — проходит: граница лимита включительно', { as: 'olga', token: 'tokOlga', account: 'olgaRub', amount: '20000.00', save: 'tOlga' }, function () {
      status(201);
    }),
    limits('Лимит дня исчерпан', 'olga', function () {
      pm.test('Доступно 0 ₽', () => pm.expect(json().day.available.value).to.equal('0.00'));
      pm.test('Сбрасывается в полночь по Москве', () => pm.expect(json().day.resetsAt).to.equal('2026-11-17T00:00:00+03:00'));
    }),
    advance(12 * 3600, 'Время +12 ч: наступили новые сутки по Москве'),
    limits('TR-07: суточный лимит сбросился, месячный — нет', 'olga', function () {
      pm.test('Сутки: доступно 500 000 ₽', () => pm.expect(json().day.available.value).to.equal('500000.00'));
      pm.test('Месяц: 640 000 + 20 000 использовано', () => pm.expect(json().month.used.value).to.equal('660000.00'));
    }),
  ]),

  folder('04 Повторы и идемпотентность', {
    rows: [1, 2, 3, 19, 21, 22], rules: ['TR-10', 'TR-11', 'TR-16', 'TR-30', 'TR-34'], stories: ['US-03'],
    doc: 'US-03: потерянный ответ, повтор через 15 минут после истечения токена, другой запрос с тем же ключом, падение сервиса до холда, нормализация тела.',
  }, [
    lookup('Поиск Ивана', { phone: PHONE.ivan }),
    faults('Сбой: перевод создаётся, но ответ теряется', { requests: [{ operation: 'createTransfer', mode: 'LOST_RESPONSE' }] }),
    create('Отказ 2: ответ не дошёл — приложение получает 503', { comment: 'За билеты' }, function () {
      problem(503, 'SERVICE_UNAVAILABLE');
      pm.test('Retry-After есть', () => pm.expect(pm.response.headers.get('Retry-After')).to.equal('1'));
    }),
    create('Повтор с тем же ключом: тот же перевод, Idempotent-Replayed', { fresh: false, comment: 'За билеты', save: 't1' }, function () {
      status(200);
      pm.test('Idempotent-Replayed: true', () => pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.equal('true'));
      expectStatus('PROCESSING');
    }),
    advance(15 * 60, 'Время +15 мин: токен получателя уже истёк'),
    create('Отказ 22: повтор через 15 минут — тот же перевод с актуальным статусом, токен не проверяется', { fresh: false, comment: 'За билеты' }, function () {
      status(200);
      pm.test('Тот же перевод', () => pm.expect(json().id).to.equal(v('t1')));
      expectStatus('COMPLETED');
    }),
    create('Нормализация: сумма без копеек, пробелы в комментарии, токен в верхнем регистре — это тот же запрос', {
      fresh: false,
      body: { recipientToken: '{{tokUpper}}', sourceAccountId: '{{petrRub}}', amount: { value: '1500', currency: 'RUB' }, comment: '  За билеты  ' },
    }, function () {
      status(200);
      pm.test('Тот же перевод', () => pm.expect(json().id).to.equal(v('t1')));
    }),
    create('Отказ 3: тот же ключ с другой суммой — 422 с идентификатором созданного перевода', { fresh: false, amount: '15000.00', comment: 'За билеты' }, function () {
      problem(422, 'IDEMPOTENCY_KEY_REUSED');
      pm.test('existingTransferId — уже созданный перевод', () => pm.expect(json().existingTransferId).to.equal(v('t1')));
    }),
    account('Деньги ушли один раз: 5 000 + 1 500', 'ivanRub', function () {
      pm.test('Баланс получателя', () => pm.expect(json().balance).to.equal('6500.00'));
    }),
    lookup('Новый поиск Ивана', { phone: PHONE.ivan }),
    faults('Сбой: сервис падает после записи перевода, до холда', { requests: [{ operation: 'createTransfer', mode: 'CRASH_BEFORE_HOLD' }] }),
    create('Отказ 21: первый запрос упал до холда', { key: 'k2' }, function () {
      problem(503, 'SERVICE_UNAVAILABLE');
    }),
    create('Отказ 1: повтор, пока действует аренда первого запроса, — 409 и Retry-After: 1', { key: 'k2', fresh: false }, function () {
      problem(409, 'IDEMPOTENCY_KEY_IN_PROGRESS');
      pm.test('Повторить через секунду', () => {
        pm.expect(pm.response.headers.get('Retry-After')).to.equal('1');
        pm.expect(json().retryAfterSeconds).to.equal(1);
      });
    }),
    advance(31, 'Время +31 с: аренда P-14 истекла'),
    create('Повтор после аренды берёт её и продолжает с того же места', { key: 'k2', fresh: false, save: 't2' }, function () {
      status(200);
      pm.test('Idempotent-Replayed: true', () => pm.expect(pm.response.headers.get('Idempotent-Replayed')).to.equal('true'));
      expectStatus('PROCESSING');
    }),
    internal('Один холд, статус HELD', 't2', function () {
      pm.test('Холд активен', () => pm.expect(json().hold.status).to.equal('ACTIVE'));
      pm.test('Статус HELD', () => pm.expect(json().status).to.equal('HELD'));
    }),
    advance(1, 'Время +1 с'),
    get('Перевод выполнен', 't2', function () { expectStatus('COMPLETED'); }),
    create('Синхронный отказ: не хватает денег', { key: 'k3', account: 'petrSmall', amount: '500.00' }, function () {
      problem(422, 'INSUFFICIENT_FUNDS');
    }),
    create('Повтор отклонённого запроса возвращает тот же отказ', { key: 'k3', fresh: false, account: 'petrSmall', amount: '500.00' }, function () {
      problem(422, 'INSUFFICIENT_FUNDS');
    }),
    create('Тот же ключ с другой суммой после синхронного отказа: 422 без existingTransferId — перевода нет', { key: 'k3', fresh: false, account: 'petrSmall', amount: '50.00' }, function () {
      problem(422, 'IDEMPOTENCY_KEY_REUSED');
      pm.test('existingTransferId нет', () => pm.expect(json()).to.not.have.property('existingTransferId'));
    }),
    faults('Сбой: сервис недоступен до обработки', { requests: [{ operation: 'createTransfer', mode: 'UNAVAILABLE' }] }),
    create('TR-10: 503 — приложение повторит с тем же ключом', { key: 'k5' }, function () {
      problem(503, 'SERVICE_UNAVAILABLE');
    }),
    create('Повтор после 503 создаёт перевод впервые: 201', { key: 'k5', fresh: false }, function () {
      status(201);
    }),
    faults('Сбой: сервис падает до холда, повтора не будет', { requests: [{ operation: 'createTransfer', mode: 'CRASH_BEFORE_HOLD' }] }),
    create('Перевод записан в NEW, холда нет', { key: 'k4' }, function () {
      problem(503, 'SERVICE_UNAVAILABLE');
    }),
    advance(16 * 60, 'Время +16 мин: регламентная проверка нашла перевод в NEW дольше P-12'),
    create('Повтор с тем же ключом: перевод закрыт как FAILED', { key: 'k4', fresh: false, save: 't4' }, function () {
      status(200);
      expectStatus('FAILED');
    }),
    internal('TR-16: снятие холда закрыло операцию в леджере', 't4', function () {
      pm.test('Операция закрыта', () => pm.expect(json().operationClosed).to.equal(true));
      pm.test('Холда нет', () => pm.expect(json().hold).to.equal(null));
    }),
    control('Отказ 19: запоздавший холд дошёл до леджера', 'POST', '/__mock/ledger/late-hold/{{t4}}', undefined, function () {
      status(200);
      pm.test('Леджер ответил ALREADY_RELEASED', () => pm.expect(json().result).to.equal('ALREADY_RELEASED'));
      pm.test('Деньги не заблокированы', () => pm.expect(json().account.held).to.equal('0.00'));
    }),
    step('TR-27: перевод не был принят к исполнению — событий и пушей нет, итог клиент получает повтором', {
      method: 'GET', path: '/__mock/events?transferId={{t4}}',
      test: function () {
        pm.test('Событий нет', () => pm.expect(json()).to.have.length(0));
      },
    }),
  ].map((s) => (s.name.startsWith('Нормализация') ? { ...s, pre: function () { setv('tokUpper', String(v('tok')).toUpperCase()); } } : s))),

  folder('05 Антифрод, ручная проверка и отмена', {
    rows: [5, 6, 7, 30], rules: ['TR-09', 'TR-17', 'TR-19', 'TR-20', 'TR-21', 'TR-22', 'TR-23', 'TR-28'], stories: ['US-04', 'US-06'],
    doc: 'US-04: отмена до решения, решение сотрудника раньше отмены, отклонение, истечение 48 часов, недоступный антифрод.',
  }, [
    lookup('Поиск Глеба: антифрод отправляет переводы ему на ручную проверку', { phone: PHONE.gleb, save: 'tokGleb' }),
    create('Перевод Глебу', { token: 'tokGleb', amount: '150000.00', save: 't1' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    get('На проверке, можно отменить', 't1', function () {
      expectStatus('ON_REVIEW');
      pm.test('cancellable', () => pm.expect(json().cancellable).to.equal(true));
    }),
    step('Пуш «Перевод на проверке, можно отменить»', {
      method: 'GET', path: '/__mock/pushes?transferId={{t1}}',
      test: function () {
        pm.test('Один пуш отправителю', () => pm.expect(json().map((p) => p.text)).to.eql(['Перевод на проверке, можно отменить']));
      },
    }),
    cancel('US-04: отмена до решения', 't1', function () {
      status(200);
      expectStatus('CANCELLED');
    }),
    cancel('Повторная отмена возвращает тот же перевод', 't1', function () {
      status(200);
      expectStatus('CANCELLED');
    }),
    advance(1, 'Время +1 с: задача снятия холда'),
    account('Блокировка суммы снята', 'petrRub', function () {
      pm.test('Холда нет', () => pm.expect(json().held).to.equal('0.00'));
    }),
    limits('TR-09: отменённый перевод вернул лимит', 'petr', function () {
      pm.test('Использовано 0', () => pm.expect(json().day.used.value).to.equal('0.00'));
    }),
    decision('Отказ 7: решение сотрудника пришло после отмены — applied: false', 't1', 'ALLOW', 'd1', function () {
      status(200);
      pm.test('Решение не применено, перевод отменён', () => pm.expect(json()).to.eql({ applied: false, transferStatus: 'CANCELLED' }));
    }),
    create('Второй перевод Глебу', { token: 'tokGleb', amount: '1000.00', save: 't2' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    decision('Сотрудник одобрил', 't2', 'ALLOW', 'd2', function () {
      status(200);
      pm.test('Применено', () => pm.expect(json()).to.eql({ applied: true, transferStatus: 'PROCESSING' }));
    }),
    decision('Повтор колбэка с тем же decisionId — тот же результат', 't2', 'ALLOW', 'd2', function () {
      pm.test('Тот же ответ', () => pm.expect(json()).to.eql({ applied: true, transferStatus: 'PROCESSING' }));
    }, false),
    decision('Второе решение по уже одобренному переводу: applied: false, перевод не ждёт решения', 't2', 'DENY', 'd2b', function () {
      status(200);
      pm.test('Не применено', () => pm.expect(json()).to.eql({ applied: false, transferStatus: 'PROCESSING' }));
    }),
    cancel('US-04: сотрудник одобрил на секунду раньше — «Перевод уже нельзя отменить»', 't2', function () {
      problem(409, 'TRANSFER_NOT_CANCELLABLE');
      pm.test('Текущий статус в ответе', () => pm.expect(json().currentStatus).to.equal('PROCESSING'));
    }),
    advance(1, 'Время +1 с'),
    get('Перевод выполнен', 't2', function () { expectStatus('COMPLETED'); }),
    create('Третий перевод Глебу', { token: 'tokGleb', amount: '1000.00', save: 't3' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    decision('Сотрудник отклонил', 't3', 'DENY', 'd3', function () {
      pm.test('Применено', () => pm.expect(json()).to.eql({ applied: true, transferStatus: 'REJECTED' }));
    }),
    get('Отклонён: FRAUD_SUSPECTED', 't3', function () {
      expectStatus('REJECTED');
      pm.test('Причина', () => pm.expect(json().rejectReason).to.equal('FRAUD_SUSPECTED'));
    }),
    step('TR-28: колбэк по несуществующему переводу — 404', {
      method: 'POST', path: '/internal/v1/antifraud/decisions',
      body: { decisionId: '9c8b7a6f-5e4d-4c3b-8a2f-1e0d9c8b7a6f', transferId: '00000000-0000-4000-8000-000000000000', decision: 'ALLOW', decidedAt: '2026-11-16T12:20:40+03:00' },
      test: function () { problem(404, 'TRANSFER_NOT_FOUND'); },
    }),
    step('Колбэк с неизвестным решением — 400', {
      method: 'POST', path: '/internal/v1/antifraud/decisions',
      body: { decisionId: '9c8b7a6f-5e4d-4c3b-8a2f-1e0d9c8b7a60', transferId: '00000000-0000-4000-8000-000000000000', decision: 'MAYBE', decidedAt: '2026-11-16T12:20:40+03:00' },
      test: function () { problem(400, 'VALIDATION_ERROR'); },
    }),
    create('Четвёртый перевод Глебу', { token: 'tokGleb', amount: '1000.00', save: 't4' }, function () { status(201); }),
    advance(48 * 3600 + 15 * 60, 'Время +48 ч 15 мин: срок ручной проверки P-11 прошёл'),
    get('Отказ 6: «Отклонён: проверка не завершена»', 't4', function () {
      expectStatus('REJECTED');
      pm.test('Причина REVIEW_EXPIRED', () => pm.expect(json().rejectReason).to.equal('REVIEW_EXPIRED'));
    }),
    internal('Холд снят', 't4', function () {
      pm.test('RELEASED', () => pm.expect(json().hold.status).to.equal('RELEASED'));
    }),
    step('Пуш «Перевод отклонён: проверка не завершена»', {
      method: 'GET', path: '/__mock/pushes?transferId={{t4}}',
      test: function () {
        pm.test('Последний пуш отправителю', () => pm.expect(json().at(-1).text).to.equal('Перевод отклонён: проверка не завершена'));
      },
    }),
    lookup('Поиск Олега: антифрод отклоняет переводы ему', { phone: PHONE.oleg, save: 'tokOleg' }),
    create('Перевод Олегу', { token: 'tokOleg', amount: '5000.00', save: 't5' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    get('Отказ 30: отклонён антифродом', 't5', function () {
      expectStatus('REJECTED');
      pm.test('FRAUD_SUSPECTED', () => pm.expect(json().rejectReason).to.equal('FRAUD_SUSPECTED'));
    }),
    step('Отказ 30: получателю пуш не уходит, отправитель видит отказ без подробностей', {
      method: 'GET', path: '/__mock/pushes?transferId={{t5}}',
      test: function () {
        pm.test('Только отправителю', () => pm.expect(json().map((p) => p.to)).to.eql(['SENDER']));
        pm.test('Текст без подробностей правил', () => pm.expect(json()[0].text).to.equal('Банк не может выполнить этот перевод'));
      },
    }),
    lookup('Поиск Анны', { phone: PHONE.anna, save: 'tokAnna' }),
    faults('Сбой: антифрод не отвечает', { antifraud: 'DOWN' }),
    create('Перевод Анне', { token: 'tokAnna', amount: '2000.00', save: 't6' }, function () { status(201); }),
    advance(1, 'Время +1 с: антифрод не ответил за P-09'),
    get('Отказ 5: «На проверке», можно отменить', 't6', function () {
      expectStatus('ON_REVIEW');
      pm.test('cancellable', () => pm.expect(json().cancellable).to.equal(true));
      setv('reviewSince', json().updatedAt);
    }),
    advance(20 * 60, 'Время +20 мин'),
    internal('TR-20: проверка повторяется, пауза не больше P-10 с разбросом', 't6', function () {
      const task = json().tasks.find((k) => k.kind === 'ANTIFRAUD_CHECK');
      pm.test('Задача открыта, попыток несколько', () => {
        pm.expect(task.done).to.equal(false);
        pm.expect(task.attempts).to.be.within(5, 30);
        pm.expect(task.lastError).to.equal('TIMEOUT');
      });
      pm.test('TR-21: срок проверки — 48 ч от первого перехода в REVIEW, повторы его не продлевают', () => {
        pm.expect(ms(json().reviewDeadline) - ms(v('reviewSince'))).to.equal(48 * HOUR);
      });
    }),
    faults('Антифрод восстановился', { antifraud: 'UP' }),
    advance(8 * 60, 'Время +8 мин: следующая попытка проверки'),
    get('Без решения антифрода перевод не выполнялся, после решения — выполнен', 't6', function () {
      expectStatus('COMPLETED');
    }),
  ]),

  folder('06 Предохранитель антифрода', {
    rows: [24], rules: ['TR-20'], stories: [],
    doc: 'Антифрод лежит: после P-19 отказов подряд проверки по каждому переводу не уходят, раз в 10 с — одна проба. После восстановления очередь разбирается сама.',
  }, [
    lookup('Поиск Анны', { phone: PHONE.anna, save: 'tokAnna' }),
    faults('Сбой: антифрод не отвечает', { antifraud: 'DOWN' }),
    step('25 переводов Анне, пока антифрод лежит', {
      method: 'GET', path: '/__mock/antifraud',
      pre: function () {
        for (let i = 0; i < 25; i++) {
          api('petr', 'POST', '/v1/transfers', { recipientToken: v('tokAnna'), sourceAccountId: pm.environment.get('petrRub'), amount: { value: '100.00', currency: 'RUB' } },
            null, { 'Idempotency-Key': guid(), 'X-Device-Id': 'ios-mock-7F3A9C21' });
        }
      },
      test: function () { status(200); },
    }),
    advance(60, 'Время +60 с'),
    step('Отказ 24: предохранитель открыт, вместо повторов по каждому переводу — проба раз в 10 с', {
      method: 'GET', path: '/__mock/antifraud',
      test: function () {
        const b = json();
        pm.test('Предохранитель открыт', () => pm.expect(b.breaker.state).to.equal('OPEN'));
        pm.test('20 отказов подряд, затем одна проба раз в 10 с', () => {
          pm.expect(b.breaker.probes).to.be.within(5, 6);
          pm.expect(b.calls).to.equal(20 + b.breaker.probes);
        });
        pm.test('Без предохранителя было бы больше 100 вызовов за минуту', () => pm.expect(b.calls).to.be.below(30));
      },
    }),
    step('Алерт об открытом предохранителе', {
      method: 'GET', path: '/__mock/alerts',
      test: function () {
        pm.test('ANTIFRAUD_BREAKER_OPEN', () => pm.expect(json().map((a) => a.type)).to.include('ANTIFRAUD_BREAKER_OPEN'));
      },
    }),
    faults('Антифрод восстановился', { antifraud: 'UP' }),
    advance(11, 'Время +11 с: проба прошла, очередь разбирается'),
    step('Предохранитель закрыт', {
      method: 'GET', path: '/__mock/antifraud',
      test: function () {
        pm.test('CLOSED', () => pm.expect(json().breaker.state).to.equal('CLOSED'));
      },
    }),
    step('Все 25 переводов выполнены, сверка сходится', {
      method: 'GET', path: '/__mock/reconciliation',
      test: function () {
        pm.test('25 выполненных переводов', () => pm.expect(json().completedTransfers).to.equal(25));
        pm.test('Расхождений нет', () => pm.expect(json().ok).to.equal(true));
      },
    }),
  ]),

  folder('07 Приостановка по 161-ФЗ', {
    rows: [25, 26, 27, 28], rules: ['TR-22', 'TR-23', 'TR-35', 'TR-36', 'TR-37', 'TR-38'], stories: ['US-05'],
    doc: 'US-05: подтверждение без новых сведений, подтверждение с отложенным исполнением, истечение срока, гонка подтверждения и отмены.',
  }, [
    lookup('Поиск Марии: антифрод приостанавливает переводы ей, база ЦБ чиста', { phone: PHONE.maria, save: 'tokMaria' }),
    create('Перевод Марии', { token: 'tokMaria', amount: '150000.00', save: 't1' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    get('Отказ 25: «Подтвердите перевод до конца следующего дня»', 't1', function () {
      expectStatus('AWAITING_CONFIRMATION');
      pm.test('Можно подтвердить и отменить', () => {
        pm.expect(json().confirmable).to.equal(true);
        pm.expect(json().cancellable).to.equal(true);
      });
      pm.test('P-20: до конца 17 ноября по Москве', () => pm.expect(json().confirmationDeadline).to.equal('2026-11-18T00:00:00+03:00'));
    }),
    account('TR-35: холд остаётся', 'petrRub', function () {
      pm.test('150 000 ₽ заблокированы', () => pm.expect(json().held).to.equal('150000.00'));
    }),
    step('Пуш с запросом подтверждения', {
      method: 'GET', path: '/__mock/pushes?transferId={{t1}}',
      test: function () {
        pm.test('Срок в тексте', () => pm.expect(json().map((p) => p.text)).to.eql(['Подтвердите перевод до 2026-11-18T00:00:00+03:00']));
      },
    }),
    confirm('US-05: подтвердил — перевод уходит в обработку', 't1', function () {
      status(200);
      expectStatus('PROCESSING');
      pm.test('Больше не ждёт подтверждения', () => pm.expect(json().confirmable).to.equal(false));
    }),
    confirm('TR-38: повторное подтверждение возвращает тот же перевод', 't1', function () {
      status(200);
      expectStatus('PROCESSING');
    }),
    advance(1, 'Время +1 с: повторная сверка с базой ЦБ'),
    get('Новых сведений нет — выполнен', 't1', function () { expectStatus('COMPLETED'); }),
    internal('Повторная сверка была, подтверждённый перевод второй раз не приостанавливался', 't1', function () {
      pm.test('Проверки INITIAL и CONFIRMATION', () => pm.expect(json().antifraudChecks.map((c) => c.stage)).to.eql(['INITIAL', 'CONFIRMATION']));
    }),
    lookup('Поиск Сергея: получатель есть в базе ЦБ', { phone: PHONE.sergey, save: 'tokSergey' }),
    create('Перевод Сергею', { token: 'tokSergey', amount: '1000.00', save: 't2' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    get('Приостановлен: момент приостановки', 't2', function () {
      expectStatus('AWAITING_CONFIRMATION');
      setv('suspendedAt', json().updatedAt);
    }),
    confirm('Подтверждение', 't2', function () { expectStatus('PROCESSING'); }),
    advance(1, 'Время +1 с: сверка с базой ЦБ нашла сведения'),
    get('Отказ 27: «Будет выполнен не раньше» — через 2 дня от приостановки', 't2', function () {
      expectStatus('DELAYED');
      pm.test('Можно отменить', () => pm.expect(json().cancellable).to.equal(true));
      pm.test('P-21: 2 дня от приостановки', () => pm.expect(ms(json().executeAfter) - ms(v('suspendedAt'))).to.equal(48 * HOUR));
      setv('executeAfter', json().executeAfter);
    }),
    step('Пуш с датой исполнения', {
      method: 'GET', path: '/__mock/pushes?transferId={{t2}}',
      test: function () {
        pm.test('Последний пуш', () => pm.expect(json().at(-1).text).to.equal('Перевод будет выполнен не раньше ' + v('executeAfter')));
      },
    }),
    create('Второй перевод Сергею', { token: 'tokSergey', amount: '2000.00', save: 't3' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    confirm('Подтверждение второго перевода', 't3', function () { expectStatus('PROCESSING'); }),
    advance(1, 'Время +1 с'),
    cancel('Отложенный перевод можно отменить', 't3', function () {
      status(200);
      expectStatus('CANCELLED');
    }),
    advance(2 * 24 * 3600, 'Время +2 дня'),
    get('В дату исполнения перевод выполнен без нового подтверждения', 't2', function () { expectStatus('COMPLETED'); }),
    get('Отменённый остался отменённым', 't3', function () { expectStatus('CANCELLED'); }),
    lookup('Новый поиск Марии', { phone: PHONE.maria, save: 'tokMaria' }),
    create('Перевод Марии, который не подтвердят', { token: 'tokMaria', amount: '1000.00', save: 't4' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    advance(36 * 3600, 'Время +36 ч: срок подтверждения P-20 прошёл'),
    get('Отказ 26: «Отклонён: перевод не подтверждён»', 't4', function () {
      expectStatus('REJECTED');
      pm.test('NOT_CONFIRMED', () => pm.expect(json().rejectReason).to.equal('NOT_CONFIRMED'));
    }),
    confirm('Подтверждение после срока — 409 с текущим статусом', 't4', function () {
      problem(409, 'TRANSFER_NOT_CONFIRMABLE');
      pm.test('currentStatus REJECTED', () => pm.expect(json().currentStatus).to.equal('REJECTED'));
    }),
    internal('Холд снят', 't4', function () {
      pm.test('RELEASED', () => pm.expect(json().hold.status).to.equal('RELEASED'));
    }),
    lookup('Новый поиск Марии', { phone: PHONE.maria, save: 'tokMaria' }),
    create('Перевод Марии для гонки «отмена раньше подтверждения»', { token: 'tokMaria', amount: '1000.00', save: 't5' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    cancel('С одного устройства — отмена', 't5', function () { expectStatus('CANCELLED'); }),
    confirm('Отказ 28: со второго — подтверждение, 409 и текущий статус', 't5', function () {
      problem(409, 'TRANSFER_NOT_CONFIRMABLE');
      pm.test('currentStatus CANCELLED', () => pm.expect(json().currentStatus).to.equal('CANCELLED'));
    }),
    create('Перевод Марии для гонки «подтверждение раньше отмены»', { token: 'tokMaria', amount: '1000.00', save: 't6' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    confirm('С одного устройства — подтверждение', 't6', function () { expectStatus('PROCESSING'); }),
    cancel('Со второго — отмена: 409 и текущий статус', 't6', function () {
      problem(409, 'TRANSFER_NOT_CANCELLABLE');
      pm.test('currentStatus PROCESSING', () => pm.expect(json().currentStatus).to.equal('PROCESSING'));
    }),
    lookup('Поиск Глеба', { phone: PHONE.gleb, save: 'tokGleb' }),
    create('Перевод Глебу на ручную проверку', { token: 'tokGleb', amount: '1000.00', save: 't7' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    decision('TR-35: сотрудник на проверке нашёл признаки и приостановил', 't7', 'SUSPEND', 'd7', function () {
      pm.test('Применено', () => pm.expect(json()).to.eql({ applied: true, transferStatus: 'AWAITING_CONFIRMATION' }));
    }),
    decision('Ещё одно решение по приостановленному переводу: applied: false', 't7', 'ALLOW', 'd7b', function () {
      pm.test('Не применено, ждёт клиента', () => pm.expect(json()).to.eql({ applied: false, transferStatus: 'AWAITING_CONFIRMATION' }));
    }),
    lookup('Поиск Ивана', { phone: PHONE.ivan }),
    create('Обычный перевод Ивану', { save: 't8' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    confirm('Подтвердить можно только приостановленный перевод', 't8', function () {
      problem(409, 'TRANSFER_NOT_CONFIRMABLE');
      pm.test('currentStatus COMPLETED', () => pm.expect(json().currentStatus).to.equal('COMPLETED'));
    }),
  ]),

  folder('08 Леджер и задачи продолжения', {
    rows: [8, 9, 15, 18, 23], rules: ['TR-14', 'TR-16', 'TR-17', 'TR-18', 'TR-30'], stories: ['US-07'],
    doc: 'US-07: неизвестный исход проводки, алерт по зависшей задаче, счёт получателя или отправителя недоступен, леджер не снял холд, потерянная задача.',
  }, [
    lookup('Поиск Ивана', { phone: PHONE.ivan }),
    create('Перевод Ивану', { save: 't1' }, function () { status(201); }),
    faults('Сбой: леджер проводит, но ответ теряется', { ledger: 'LOST_RESPONSE' }),
    advance(5, 'Время +5 с'),
    get('Отказ 8: исход неизвестен — «В обработке»', 't1', function () { expectStatus('PROCESSING'); }),
    internal('Задача проводки повторяется, проводка уже есть', 't1', function () {
      const task = json().tasks.find((k) => k.kind === 'POST');
      pm.test('Повторы', () => pm.expect(task.attempts).to.be.above(0));
      pm.test('В POSTING перевод в FAILED не уходит', () => pm.expect(json().status).to.equal('POSTING'));
    }),
    step('Сверка в это время: предупреждение, а не расхождение', {
      method: 'GET', path: '/__mock/reconciliation',
      test: function () {
        pm.test('Расхождений нет', () => pm.expect(json().ok).to.equal(true));
        pm.test('POSTED_NOT_YET_COMPLETED', () => pm.expect(json().warnings.map((w) => w.type)).to.eql(['POSTED_NOT_YET_COMPLETED']));
      },
    }),
    faults('Леджер ответил', { ledger: 'UP' }),
    advance(60, 'Время +60 с'),
    get('Перевод выполнен', 't1', function () { expectStatus('COMPLETED'); }),
    internal('TR-16: повтор не провёл второй раз', 't1', function () {
      pm.test('Одна проводка', () => pm.expect(json().postings).to.have.length(1));
      pm.test('Последний ответ леджера — ALREADY_POSTED', () => pm.expect(json().tasks.find((k) => k.kind === 'POST').outcome).to.equal('ALREADY_POSTED'));
    }),
    create('Второй перевод Ивану', { save: 't2' }, function () { status(201); }),
    faults('Сбой: леджер не отвечает', { ledger: 'DOWN' }),
    advance(16 * 60, 'Время +16 мин: задача проводки висит дольше P-12'),
    step('US-07: операционист получает алерт с типом задачи', {
      method: 'GET', path: '/__mock/alerts',
      test: function () {
        const a = json().find((x) => x.type === 'TASK_OVERDUE' && x.transferId === v('t2'));
        pm.test('Алерт TASK_OVERDUE по задаче проводки', () => {
          pm.expect(a).to.be.ok;
          pm.expect(a.taskKind).to.equal('POST');
        });
      },
    }),
    faults('Леджер восстановился', { ledger: 'UP' }),
    advance(60, 'Время +60 с'),
    get('Задача довелась сама', 't2', function () { expectStatus('COMPLETED'); }),
    lookup('Новый поиск Ивана: прежний токен истёк', { phone: PHONE.ivan }),
    lookup('Поиск Анны', { phone: PHONE.anna, save: 'tokAnna' }),
    create('Перевод Анне', { token: 'tokAnna', amount: '700.00', save: 't3' }, function () { status(201); }),
    control('Счёт Анны закрыли между созданием перевода и проводкой', 'POST', '/__mock/accounts/{{annaRub}}/status', { status: 'CLOSED' }),
    advance(1, 'Время +1 с'),
    get('Отказ 9: «Отклонён: счёт получателя недоступен»', 't3', function () {
      expectStatus('REJECTED');
      pm.test('RECIPIENT_ACCOUNT_UNAVAILABLE', () => pm.expect(json().rejectReason).to.equal('RECIPIENT_ACCOUNT_UNAVAILABLE'));
    }),
    internal('Холд снят, проводки нет', 't3', function () {
      pm.test('RELEASED', () => pm.expect(json().hold.status).to.equal('RELEASED'));
      pm.test('Проводок нет', () => pm.expect(json().postings).to.have.length(0));
    }),
    create('Перевод Ивану', { save: 't4' }, function () { status(201); }),
    control('Счёт отправителя заблокировали после холда', 'POST', '/__mock/accounts/{{petrRub}}/status', { status: 'BLOCKED' }),
    advance(1, 'Время +1 с'),
    get('Отказ 18: «Отклонён: счёт списания недоступен»', 't4', function () {
      expectStatus('REJECTED');
      pm.test('SOURCE_ACCOUNT_UNAVAILABLE', () => pm.expect(json().rejectReason).to.equal('SOURCE_ACCOUNT_UNAVAILABLE'));
    }),
    control('Счёт отправителя разблокирован', 'POST', '/__mock/accounts/{{petrRub}}/status', { status: 'OPEN' }),
    lookup('Поиск Глеба', { phone: PHONE.gleb, save: 'tokGleb' }),
    create('Перевод Глебу на ручную проверку', { token: 'tokGleb', amount: '3000.00', save: 't5' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    faults('Сбой: леджер не отвечает', { ledger: 'DOWN' }),
    cancel('Отмена', 't5', function () { expectStatus('CANCELLED'); }),
    advance(120, 'Время +2 мин'),
    internal('Отказ 15: перевод отменён, снятие холда повторяется', 't5', function () {
      const task = json().tasks.find((k) => k.kind === 'RELEASE_HOLD');
      pm.test('Холд ещё активен', () => pm.expect(json().hold.status).to.equal('ACTIVE'));
      pm.test('Задача снятия открыта и повторяется', () => {
        pm.expect(task.done).to.equal(false);
        pm.expect(task.attempts).to.be.above(0);
      });
    }),
    faults('Леджер ответил', { ledger: 'UP' }),
    advance(60, 'Время +60 с'),
    internal('Деньги разблокированы, как только ответил леджер', 't5', function () {
      pm.test('RELEASED', () => pm.expect(json().hold.status).to.equal('RELEASED'));
    }),
    create('Перевод Ивану', { save: 't6' }, function () { status(201); }),
    control('Дефект: задача проверки потерялась после холда', 'DELETE', '/__mock/transfers/{{t6}}/tasks', undefined, function () {
      pm.test('Задача удалена', () => pm.expect(json().dropped).to.equal(1));
    }),
    advance(16 * 60, 'Время +16 мин: регламентная проверка'),
    step('Отказ 23: регламентная проверка восстановила задачу и завела инцидент', {
      method: 'GET', path: '/__mock/incidents',
      test: function () {
        pm.test('NO_OPEN_TASK по переводу', () => pm.expect(json().some((i) => i.type === 'NO_OPEN_TASK' && i.transferId === v('t6'))).to.equal(true));
      },
    }),
    get('Перевод довёлся', 't6', function () { expectStatus('COMPLETED'); }),
  ]),

  folder('09 События, пуши и outbox', {
    rows: [11, 12, 13, 14, 29], rules: ['TR-27', 'TR-28', 'TR-29'], stories: ['US-06'],
    doc: 'US-06: один пуш получателю о зачислении; события не теряются при остановке relay; дубль, перестановка, битое событие, сбой одного из двух пушей.',
  }, [
    lookup('Поиск Ивана', { phone: PHONE.ivan }),
    faults('Сбой: relay outbox остановлен', { relay: 'DOWN' }),
    create('Перевод Ивану', { save: 't1' }, function () { status(201); }),
    advance(60, 'Время +60 с'),
    get('Перевод выполнен', 't1', function () { expectStatus('COMPLETED'); }),
    step('Отказ 11: события записаны в outbox, но не опубликованы, пушей нет', {
      method: 'GET', path: '/__mock/events?transferId={{t1}}',
      eventSchema: true,
      test: function () {
        const events = json();
        pm.test('Два события: PROCESSING и COMPLETED', () => pm.expect(events.map((e) => e.status)).to.eql(['PROCESSING', 'COMPLETED']));
        pm.test('Ни одно не опубликовано', () => pm.expect(events.every((e) => !e.published)).to.equal(true));
        pm.test('Событие по схеме AsyncAPI', () => {
          const Ajv = require('ajv');
          const ajv = new Ajv({ allErrors: true });
          for (const e of events) {
            const { seq, published, ...payload } = e;
            pm.expect(ajv.validate(EVENT_SCHEMA, payload), ajv.errorsText()).to.equal(true);
          }
        });
        pm.test('Первое событие — при блокировке средств, previousStatus null', () => pm.expect(events[0].previousStatus).to.equal(null));
        pm.test('Версии растут', () => pm.expect(events[1].transferVersion).to.be.above(events[0].transferVersion));
        setv('evProcessing', events[0].eventId);
        setv('evCompleted', events[1].eventId);
      },
    }),
    advance(15 * 60, 'Время +15 мин: регламентная проверка'),
    step('Алерт: лаг outbox больше 30 с', {
      method: 'GET', path: '/__mock/alerts',
      test: function () {
        pm.test('OUTBOX_LAG', () => pm.expect(json().map((a) => a.type)).to.include('OUTBOX_LAG'));
      },
    }),
    faults('Relay перезапущен', { relay: 'UP' }),
    advance(1, 'Время +1 с'),
    step('US-06: пуш пришёл позже, каждому адресату — один', {
      method: 'GET', path: '/__mock/pushes?transferId={{t1}}',
      test: function () {
        const p = json();
        pm.test('Отправителю «Перевод выполнен»', () => pm.expect(p.filter((x) => x.to === 'SENDER').map((x) => x.text)).to.eql(['Перевод выполнен']));
        pm.test('Получателю «Пётр С. перевёл вам 1 500 ₽»', () => pm.expect(p.filter((x) => x.to === 'RECIPIENT').map((x) => x.text)).to.eql(['Пётр С. перевёл вам 1 500 ₽']));
        pm.test('collapse-key — перевод', () => pm.expect(p.every((x) => x.collapseKey === v('t1'))).to.equal(true));
      },
    }),
    control('Отказ 12: событие о выполнении доставлено ещё раз', 'POST', '/__mock/events/{{evCompleted}}/redeliver', {}),
    step('Дубль не дал второго пуша', {
      method: 'GET', path: '/__mock/pushes?transferId={{t1}}',
      test: function () {
        pm.test('По-прежнему два пуша', () => pm.expect(json()).to.have.length(2));
      },
    }),
    control('Отказ 13: событие «в обработке» пришло после «выполнен»', 'POST', '/__mock/events/{{evProcessing}}/redeliver', { reorder: true }, function () {
      pm.test('История не откатила финальный статус', () => pm.expect(json().history.status).to.equal('COMPLETED'));
    }),
    lookup('Новый поиск Ивана: прежний токен истёк', { phone: PHONE.ivan }),
    faults('Сбой: пуш получателю упадёт один раз', { pushRecipientFailures: 1 }),
    create('Второй перевод Ивану', { amount: '700.00', save: 't2' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    step('Отказ 29: отправитель получил пуш, получатель — пока нет', {
      method: 'GET', path: '/__mock/pushes?transferId={{t2}}',
      test: function () {
        pm.test('Только отправителю', () => pm.expect(json().map((p) => p.to)).to.eql(['SENDER']));
      },
    }),
    advance(61, 'Время +61 с: повтор через топик с паузой 1 мин'),
    step('Повтор только для получателя, отправитель второй пуш не получил', {
      method: 'GET', path: '/__mock/pushes?transferId={{t2}}',
      test: function () {
        pm.test('По одному пушу каждому', () => pm.expect(json().map((p) => p.to).sort()).to.eql(['RECIPIENT', 'SENDER']));
        pm.test('Получателю «перевёл вам 700 ₽»', () => pm.expect(json().find((p) => p.to === 'RECIPIENT').text).to.equal('Пётр С. перевёл вам 700 ₽'));
      },
    }),
    control('Отказ 14: потребитель не может обработать событие', 'POST', '/__mock/events/{{evCompleted}}/redeliver', { poison: true }),
    create('Тем временем — третий перевод', { amount: '300.00', save: 't3' }, function () { status(201); }),
    advance(1, 'Время +1 с'),
    step('Партиция не заблокирована: пуши по другому переводу идут', {
      method: 'GET', path: '/__mock/pushes?transferId={{t3}}',
      test: function () {
        pm.test('Два пуша', () => pm.expect(json()).to.have.length(2));
      },
    }),
    advance(22 * 60, 'Время +22 мин: повторы через 1, 5 и 15 мин'),
    step('Битое событие в DLQ', {
      method: 'GET', path: '/__mock/dlq',
      test: function () {
        pm.test('Событие в DLQ потребителя уведомлений', () => pm.expect(json().some((d) => d.eventId === v('evCompleted') && d.consumer === 'notifications')).to.equal(true));
      },
    }),
    step('Алерт о событии в DLQ', {
      method: 'GET', path: '/__mock/alerts',
      test: function () {
        pm.test('EVENT_IN_DLQ', () => pm.expect(json().map((a) => a.type)).to.include('EVENT_IN_DLQ'));
      },
    }),
  ]),

  folder('10 Номер получателя и чужие данные', {
    rows: [10], rules: ['TR-02'], stories: ['US-01'],
    doc: 'Перевод идёт по токену: деньги получает тот, кого отправитель видел на экране. Чужой токен и чужой перевод недоступны.',
  }, [
    lookup('Поиск по номеру Ивана', { phone: PHONE.ivan }),
    control('Номер Ивана перешёл к Дмитрию', 'POST', '/__mock/phones', { phone: PHONE.ivan, clientId: '{{dmitryId}}' }),
    create('Перевод по токену из поиска', { save: 't1' }, function () {
      status(201);
      pm.test('На экране — Иван', () => pm.expect(json().recipient.displayName).to.equal('Иван П.'));
    }),
    advance(1, 'Время +1 с'),
    internal('Отказ 10: деньги ушли Ивану, а не новому владельцу номера', 't1', function () {
      pm.test('Счёт Ивана', () => pm.expect(json().postings[0].credit).to.equal(pm.environment.get('ivanRub')));
    }),
    account('Дмитрию ничего не пришло', 'dmitryRub', function () {
      pm.test('Баланс 0', () => pm.expect(json().balance).to.equal('0.00'));
    }),
    advance(11 * 60, 'Время +11 мин: токен истёк'),
    lookup('Новый поиск по номеру находит нового владельца', { phone: PHONE.ivan, save: 'tokNew' }, function () {
      status(200);
      pm.test('Дмитрий Ж.', () => pm.expect(json().displayName).to.equal('Дмитрий Ж.'));
      setv(SAVE, json().recipientToken);
    }),
    create('TR-02: токен действует только для того, кто искал', { as: 'olga', token: 'tokNew', account: 'olgaRub' }, function () {
      problem(422, 'RECIPIENT_TOKEN_EXPIRED');
    }),
    get('Чужой перевод — 404, а не 403', 't1', function () { problem(404, 'TRANSFER_NOT_FOUND'); }, 'ivan'),
    cancel('Отмена чужого перевода — 404', 't1', function () { problem(404, 'TRANSFER_NOT_FOUND'); }, 'olga'),
    step('Несуществующий перевод — 404', {
      method: 'GET', path: '/v1/transfers/00000000-0000-4000-8000-000000000000', as: 'petr',
      test: function () { problem(404, 'TRANSFER_NOT_FOUND'); },
    }),
    step('Статус без токена доступа — 401', {
      method: 'GET', path: '/v1/transfers/{{t1}}',
      test: function () { problem(401, 'UNAUTHORIZED'); },
    }),
    step('Лимиты без токена доступа — 401', {
      method: 'GET', path: '/v1/transfer-limits',
      test: function () { problem(401, 'UNAUTHORIZED'); },
    }),
  ]),

  folder('11 Курсы ЦБ и сверка', {
    rows: [17], rules: ['TR-25', 'TR-26', 'TR-31'], stories: ['US-07'],
    doc: 'Курс не загрузился — лимиты по последнему курсу и алерт. Ежедневная сверка находит проводку без выполненного перевода.',
  }, [
    faults('Сбой: DailyInfo недоступен', { cbr: 'DOWN' }),
    advance(24 * 3600, 'Время +1 день: загрузка курса на новые сутки'),
    step('Отказ 17: алерт операционному отделу', {
      method: 'GET', path: '/__mock/alerts',
      test: function () {
        pm.test('CBR_RATE_NOT_LOADED', () => pm.expect(json().some((a) => a.type === 'CBR_RATE_NOT_LOADED' && a.date === '2026-11-17')).to.equal(true));
      },
    }),
    lookup('Поиск Ивана', { phone: PHONE.ivan }),
    create('Перевод в долларах проходит', { account: 'petrUsd', amount: '100.00', currency: 'USD', save: 't1' }, function () { status(201); }),
    internal('TR-26: лимит посчитан по последнему загруженному курсу', 't1', function () {
      pm.test('Курс от 16 ноября', () => pm.expect(json().rateDate).to.equal('2026-11-16'));
      pm.test('9 200 ₽', () => pm.expect(json().amountRub).to.equal('9200.00'));
    }),
    faults('DailyInfo ответил', { cbr: 'UP' }),
    advance(1, 'Время +1 с: загрузчик повторил'),
    create('Следующий перевод — по свежему курсу', { account: 'petrUsd', amount: '10.00', currency: 'USD', save: 't2' }, function () { status(201); }),
    internal('Курс от 17 ноября', 't2', function () {
      pm.test('rateDate', () => pm.expect(json().rateDate).to.equal('2026-11-17'));
    }),
    advance(1, 'Время +1 с'),
    step('TR-31: сверка за день сходится', {
      method: 'GET', path: '/__mock/reconciliation?day=2026-11-17',
      test: function () {
        pm.test('Расхождений нет', () => pm.expect(json().ok).to.equal(true));
        pm.test('Два выполненных перевода', () => pm.expect(json().completedTransfers).to.equal(2));
        pm.test('Сумма в долларах', () => pm.expect(json().totals.USD).to.eql({ transfers: '110.00', postings: '110.00' }));
      },
    }),
    control('Дефект: проводка без перевода', 'POST', '/__mock/ledger/postings', { debit: '{{bankRub}}', credit: '{{annaRub}}', amount: '999.00' }, function () { status(201); }),
    step('Сверка находит расхождение', {
      method: 'GET', path: '/__mock/reconciliation?day=2026-11-17',
      test: function () {
        const types = json().discrepancies.map((d) => d.type);
        pm.test('Не сходится', () => pm.expect(json().ok).to.equal(false));
        pm.test('Проводка без выполненного перевода', () => pm.expect(types).to.include('POSTING_WITHOUT_COMPLETED_TRANSFER'));
        pm.test('Сумма за день не совпала', () => pm.expect(types).to.include('DAY_TOTAL_MISMATCH'));
      },
    }),
    step('Алерт о расхождении сверки', {
      method: 'GET', path: '/__mock/alerts',
      test: function () {
        pm.test('RECONCILIATION_MISMATCH', () => pm.expect(json().map((a) => a.type)).to.include('RECONCILIATION_MISMATCH'));
      },
    }),
  ]),
];

// ------------------------------------------------------------------ чем строки и правила проверены вне коллекции

export const coverageNotes = {
  rows: {
    1: 'Настоящая параллельность: [`tests/concurrency-check.mjs`](../../tests/concurrency-check.mjs)',
    4: '[`tests/concurrency-check.mjs`](../../tests/concurrency-check.mjs), [`concurrency-check.sh`](../design/concurrency-check.sh) на PostgreSQL',
    7: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    8: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    11: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    18: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    19: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    20: '[`tests/concurrency-check.mjs`](../../tests/concurrency-check.mjs), [`ledger-concurrency-check.sh`](../design/ledger-concurrency-check.sh) на PostgreSQL',
    21: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    23: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    26: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
    27: '[`ddl-checks.sql`](../design/ddl-checks.sql)',
  },
  rules: {
    'TR-01': 'NFR-06 — маскирование номера в журналах: вне mock',
    'TR-08': '[`concurrency-check.sh`](../design/concurrency-check.sh), [`tests/concurrency-check.mjs`](../../tests/concurrency-check.mjs)',
    'TR-14': '[`ledger-concurrency-check.sh`](../design/ledger-concurrency-check.sh)',
    'TR-15': '[`ddl-checks.sql`](../design/ddl-checks.sql): проводки неизменяемы, сторно зеркальное',
    'TR-31': '[`reconciliation-checks.sql`](../design/reconciliation-checks.sql) на PostgreSQL',
    'TR-33': 'Ревью: проводок комиссии нет',
  },
};
