-- Переводы по номеру телефона: модель данных, версия 0.2
-- PostgreSQL 16. Две схемы — две базы двух сервисов: ledger (леджер) и transfers (сервис переводов).
-- Внешних ключей между схемами нет намеренно: в проде это разные базы, связь — через API леджера.
-- Функции в схеме ledger — исполняемая спецификация протокола операций леджера,
-- в сервисе их можно реализовать кодом с теми же гарантиями. Описание — data-model.md.

CREATE SCHEMA ledger;
CREATE SCHEMA transfers;

-- =====================================================================
-- ЛЕДЖЕР
-- =====================================================================

CREATE TABLE ledger.account (
    id          uuid PRIMARY KEY,
    client_id   uuid,                                   -- NULL у технических счетов банка
    type        text NOT NULL CHECK (type IN ('CLIENT_CURRENT', 'BANK_TECHNICAL')),
    currency    char(3) NOT NULL CHECK (currency IN ('RUB', 'USD', 'EUR', 'CNY')),
    is_primary  boolean NOT NULL DEFAULT false,
    status      text NOT NULL CHECK (status IN ('OPEN', 'BLOCKED', 'CLOSED')),
    balance     numeric(19, 2) NOT NULL DEFAULT 0,      -- проекция суммы проводок, ведёт триггер
    opened_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, currency),                              -- цель составных FK: операция в валюте счёта
    CHECK (type <> 'CLIENT_CURRENT' OR client_id IS NOT NULL),
    CHECK (type <> 'CLIENT_CURRENT' OR balance >= 0)    -- у текущего счёта клиента нет овердрафта
);
-- Один основной незакрытый счёт клиента в каждой валюте (TR-05)
CREATE UNIQUE INDEX account_one_primary_per_currency
    ON ledger.account (client_id, currency) WHERE is_primary AND status <> 'CLOSED';

-- Баланс — проекция проводок: счёт открывается с нулевым балансом, меняет баланс только
-- триггер apply_posting. Прямой UPDATE баланса из сервиса или руками — ошибка
CREATE FUNCTION ledger.guard_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.balance <> 0 THEN
        RAISE EXCEPTION 'Счёт открывается с нулевым балансом, деньги приходят только проводкой';
    END IF;
    -- глубина 1 — изменение пришло снаружи, глубина 2 — из apply_posting
    IF TG_OP = 'UPDATE' AND NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'Баланс меняется только проводкой: это проекция суммы проводок';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER account_guard_balance BEFORE INSERT OR UPDATE ON ledger.account
    FOR EACH ROW EXECUTE FUNCTION ledger.guard_balance();

CREATE TABLE ledger.hold (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id  uuid NOT NULL UNIQUE,                  -- TR-16: один холд на перевод
    account_id   uuid NOT NULL,
    currency     char(3) NOT NULL,
    amount       numeric(19, 2) NOT NULL CHECK (amount > 0),
    status       text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'CAPTURED')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    closed_at    timestamptz,
    CHECK ((status = 'ACTIVE') = (closed_at IS NULL)),
    FOREIGN KEY (account_id, currency) REFERENCES ledger.account (id, currency)
);
CREATE INDEX hold_active_by_account ON ledger.hold (account_id) WHERE status = 'ACTIVE';

-- Закрытые операции (TR-16): холд по transferId сняли раньше, чем он появился.
-- Запоздавший холд по такому transferId не создаётся, а возвращает ALREADY_RELEASED
CREATE TABLE ledger.closed_operation (
    transfer_id  uuid PRIMARY KEY,
    closed_at    timestamptz NOT NULL DEFAULT now()
);

-- Операции леджера по одному transferId выполняются по очереди: холд, снятие и проводка
-- по одному переводу не обгоняют друг друга
CREATE FUNCTION ledger.lock_operation(p_transfer_id uuid) RETURNS void LANGUAGE sql AS $$
    SELECT pg_advisory_xact_lock(hashtextextended(p_transfer_id::text, 0))
$$;

-- Проводка — одна строка «дебет — кредит — сумма»: равенство дебета и кредита выполнено по построению
CREATE TABLE ledger.posting (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                 text NOT NULL CHECK (kind IN ('TRANSFER', 'REVERSAL', 'OTHER')),
    transfer_id          uuid,                          -- NULL только у прочих операций банка (OTHER)
    debit_account_id     uuid NOT NULL,
    credit_account_id    uuid NOT NULL,
    currency             char(3) NOT NULL,
    amount               numeric(19, 2) NOT NULL CHECK (amount > 0),
    reverses_posting_id  uuid UNIQUE REFERENCES ledger.posting (id),  -- одно сторно на проводку
    posted_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (transfer_id, kind),                         -- TR-16: одна проводка и одно сторно на перевод
    CHECK (debit_account_id <> credit_account_id),
    CHECK (kind = 'OTHER' OR transfer_id IS NOT NULL),
    CHECK ((kind = 'REVERSAL') = (reverses_posting_id IS NOT NULL)),
    FOREIGN KEY (debit_account_id, currency)  REFERENCES ledger.account (id, currency),
    FOREIGN KEY (credit_account_id, currency) REFERENCES ledger.account (id, currency)
);

-- TR-15: проводки не меняются и не удаляются
CREATE FUNCTION ledger.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Проводки неизменяемы, ошибка исправляется только сторно (TR-15)';
END $$;
CREATE TRIGGER posting_no_update_delete BEFORE UPDATE OR DELETE ON ledger.posting
    FOR EACH ROW EXECUTE FUNCTION ledger.forbid_change();
CREATE TRIGGER posting_no_truncate BEFORE TRUNCATE ON ledger.posting
    FOR EACH STATEMENT EXECUTE FUNCTION ledger.forbid_change();

-- Сторно зеркалит исходную проводку: счета меняются местами, сумма и валюта те же
CREATE FUNCTION ledger.check_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o ledger.posting%ROWTYPE;
BEGIN
    IF NEW.kind <> 'REVERSAL' THEN RETURN NEW; END IF;
    SELECT * INTO o FROM ledger.posting WHERE id = NEW.reverses_posting_id;
    IF o.kind = 'REVERSAL'
       OR o.debit_account_id  <> NEW.credit_account_id
       OR o.credit_account_id <> NEW.debit_account_id
       OR o.amount <> NEW.amount OR o.currency <> NEW.currency
       OR o.transfer_id IS DISTINCT FROM NEW.transfer_id THEN
        RAISE EXCEPTION 'Сторно должно зеркально повторять проводку %', o.id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER posting_check_reversal BEFORE INSERT ON ledger.posting
    FOR EACH ROW EXECUTE FUNCTION ledger.check_reversal();

-- Баланс меняется в той же транзакции, что и проводка. Счета блокируются в порядке id,
-- чтобы встречные переводы A→B и B→A не дали взаимоблокировку.
-- Именно FOR NO KEY UPDATE, а не FOR UPDATE: внешние ключи проводки уже взяли на эти счета
-- FOR KEY SHARE, и FOR UPDATE с ней конфликтует — две проводки с общим счётом ждали бы
-- друг друга. Проверка — ledger-concurrency-check.sh
CREATE FUNCTION ledger.apply_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM ledger.account
     WHERE id IN (NEW.debit_account_id, NEW.credit_account_id)
     ORDER BY id FOR NO KEY UPDATE;
    UPDATE ledger.account SET balance = balance - NEW.amount WHERE id = NEW.debit_account_id;
    UPDATE ledger.account SET balance = balance + NEW.amount WHERE id = NEW.credit_account_id;
    RETURN NEW;
END $$;
CREATE TRIGGER posting_apply AFTER INSERT ON ledger.posting
    FOR EACH ROW EXECUTE FUNCTION ledger.apply_posting();

CREATE VIEW ledger.account_available AS
SELECT a.id, a.client_id, a.currency, a.status, a.balance,
       a.balance - COALESCE(SUM(h.amount) FILTER (WHERE h.status = 'ACTIVE'), 0) AS available
  FROM ledger.account a
  LEFT JOIN ledger.hold h ON h.account_id = a.id
 GROUP BY a.id;

-- Операция «холд». Идемпотентна по transfer_id (TR-16)
CREATE FUNCTION ledger.place_hold(p_transfer_id uuid, p_account_id uuid, p_currency char(3), p_amount numeric)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    acc ledger.account%ROWTYPE;
    existing ledger.hold%ROWTYPE;
    held numeric;
BEGIN
    PERFORM ledger.lock_operation(p_transfer_id);
    -- холд по закрытой операции не создаётся: её уже сняли (TR-16)
    IF EXISTS (SELECT 1 FROM ledger.closed_operation WHERE transfer_id = p_transfer_id) THEN
        RETURN 'ALREADY_RELEASED';
    END IF;
    -- блокировка счёта сериализует холды по нему: два перевода не потратят один остаток
    SELECT * INTO acc FROM ledger.account WHERE id = p_account_id FOR NO KEY UPDATE;
    SELECT * INTO existing FROM ledger.hold WHERE transfer_id = p_transfer_id;
    IF FOUND THEN
        IF existing.account_id <> p_account_id OR existing.amount <> p_amount OR existing.currency <> p_currency THEN
            RAISE EXCEPTION 'Холд по переводу % уже есть с другими параметрами', p_transfer_id;
        END IF;
        RETURN 'ALREADY_' || existing.status;
    END IF;
    IF acc.id IS NULL OR acc.status <> 'OPEN' THEN RETURN 'ACCOUNT_UNAVAILABLE'; END IF;
    IF acc.currency <> p_currency THEN RETURN 'CURRENCY_MISMATCH'; END IF;
    SELECT COALESCE(SUM(amount), 0) INTO held FROM ledger.hold WHERE account_id = p_account_id AND status = 'ACTIVE';
    IF acc.balance - held < p_amount THEN RETURN 'INSUFFICIENT_FUNDS'; END IF;
    INSERT INTO ledger.hold (transfer_id, account_id, currency, amount, status)
    VALUES (p_transfer_id, p_account_id, p_currency, p_amount, 'ACTIVE');
    RETURN 'HELD';
END $$;

-- Операция «снять холд». Идемпотентна. Если холда ещё нет, закрывает transferId:
-- запоздавший холд по нему уже не появится (TR-16)
CREATE FUNCTION ledger.release_hold(p_transfer_id uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
    PERFORM ledger.lock_operation(p_transfer_id);
    UPDATE ledger.hold SET status = 'RELEASED', closed_at = now()
     WHERE transfer_id = p_transfer_id AND status = 'ACTIVE';
    IF FOUND THEN RETURN 'RELEASED'; END IF;
    SELECT status INTO st FROM ledger.hold WHERE transfer_id = p_transfer_id;
    IF FOUND THEN RETURN 'ALREADY_' || st; END IF;
    INSERT INTO ledger.closed_operation (transfer_id) VALUES (p_transfer_id) ON CONFLICT DO NOTHING;
    RETURN 'NO_HOLD';
END $$;

-- Операция «провести перевод»: списать холд и зачислить получателю одной транзакцией (TR-14)
CREATE FUNCTION ledger.post_transfer(p_transfer_id uuid, p_credit_account_id uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    h ledger.hold%ROWTYPE;
    dr ledger.account%ROWTYPE;
    cr ledger.account%ROWTYPE;
BEGIN
    PERFORM ledger.lock_operation(p_transfer_id);
    SELECT * INTO h FROM ledger.hold WHERE transfer_id = p_transfer_id FOR UPDATE;
    IF NOT FOUND THEN RETURN 'NO_HOLD'; END IF;
    IF h.status = 'CAPTURED' THEN RETURN 'ALREADY_POSTED'; END IF;
    IF h.status = 'RELEASED' THEN RETURN 'HOLD_RELEASED'; END IF;
    -- оба счёта блокируются до проверок, в порядке id: статус не изменится между проверкой и проводкой
    PERFORM 1 FROM ledger.account WHERE id IN (h.account_id, p_credit_account_id)
     ORDER BY id FOR NO KEY UPDATE;
    SELECT * INTO dr FROM ledger.account WHERE id = h.account_id;
    IF dr.status <> 'OPEN' THEN
        RETURN 'SOURCE_ACCOUNT_UNAVAILABLE';             -- счёт отправителя заблокировали после холда (TR-18)
    END IF;
    SELECT * INTO cr FROM ledger.account WHERE id = p_credit_account_id;
    IF NOT FOUND OR cr.status <> 'OPEN' OR cr.currency <> h.currency THEN
        RETURN 'RECIPIENT_ACCOUNT_UNAVAILABLE';          -- сервис переводов отклонит перевод (TR-18)
    END IF;
    INSERT INTO ledger.posting (kind, transfer_id, debit_account_id, credit_account_id, currency, amount)
    VALUES ('TRANSFER', p_transfer_id, h.account_id, p_credit_account_id, h.currency, h.amount);
    UPDATE ledger.hold SET status = 'CAPTURED', closed_at = now() WHERE id = h.id;
    RETURN 'POSTED';
END $$;

-- =====================================================================
-- СЕРВИС ПЕРЕВОДОВ
-- =====================================================================

CREATE TABLE transfers.recipient_token (
    token                uuid PRIMARY KEY,
    sender_client_id     uuid NOT NULL,                 -- токен действует только для того, кто искал (TR-02)
    recipient_client_id  uuid NOT NULL,
    phone_hmac           text NOT NULL,                 -- HMAC номера: повтор поиска возвращает тот же токен (TR-03)
    display_name         text NOT NULL,
    accounts             jsonb NOT NULL,                -- основные счета получателя по валютам на момент поиска
    created_at           timestamptz NOT NULL DEFAULT now(),
    expires_at           timestamptz NOT NULL,
    CHECK (expires_at > created_at),
    CHECK (sender_client_id <> recipient_client_id)    -- TR-04
);
-- Повтор поиска того же номера, пока токен действует, находит этот токен и лимит не расходует (TR-03)
CREATE INDEX recipient_token_by_phone ON transfers.recipient_token (sender_client_id, phone_hmac, expires_at);

CREATE TABLE transfers.currency_rate (
    currency    char(3) NOT NULL CHECK (currency IN ('USD', 'EUR', 'CNY')),
    rate_date   date NOT NULL,                          -- ValuteData/@OnDate
    nominal     integer NOT NULL CHECK (nominal > 0),   -- Vnom
    rate        numeric(19, 4) NOT NULL CHECK (rate > 0), -- Vcurs, рублей за nominal единиц
    unit_rate   numeric(19, 8) GENERATED ALWAYS AS (rate / nominal) STORED,
    loaded_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (currency, rate_date)
);

CREATE TABLE transfers.transfer (
    id                   uuid PRIMARY KEY,
    sender_client_id     uuid NOT NULL,
    idempotency_key      uuid NOT NULL,
    request_hash         text NOT NULL,                 -- SHA-256 нормализованного тела: повтор или новый перевод (TR-11)
    recipient_client_id  uuid NOT NULL,
    source_account_id    uuid NOT NULL,
    target_account_id    uuid NOT NULL,
    currency             char(3) NOT NULL CHECK (currency IN ('RUB', 'USD', 'EUR', 'CNY')),
    amount               numeric(19, 2) NOT NULL CHECK (amount >= 1),   -- TR-06: от 1 единицы валюты
    amount_rub           numeric(19, 2) NOT NULL CHECK (amount_rub > 0),  -- для лимитов (TR-25)
    rate_date            date,                          -- дата курса ЦБ, NULL для рублей
    limit_day            date NOT NULL,                 -- период лимита фиксируется при создании,
    limit_month          date NOT NULL,                 -- чтобы снятие резерва попало в тот же период
    comment              varchar(140),                  -- P-13
    status               text NOT NULL CHECK (status IN
                             ('NEW', 'HELD', 'CHECKING', 'REVIEW', 'SUSPENDED', 'COOLING', 'POSTING',
                              'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED')),
    reject_reason        text CHECK (reject_reason IN
                             ('LIMIT_EXCEEDED', 'INSUFFICIENT_FUNDS', 'SOURCE_ACCOUNT_UNAVAILABLE',
                              'FRAUD_SUSPECTED', 'REVIEW_EXPIRED', 'RECIPIENT_ACCOUNT_UNAVAILABLE',
                              'NOT_CONFIRMED')),
    version              integer NOT NULL DEFAULT 1,    -- transferVersion в событиях
    review_deadline      timestamptz,
    lease_until          timestamptz,                   -- аренда обработки P-14 (TR-34)
    confirmation_deadline timestamptz,                  -- 161-ФЗ: подтвердить до конца следующего дня, P-20 (TR-36)
    confirmed_at         timestamptz,                   -- клиент подтвердил приостановленный перевод
    execute_after        timestamptz,                   -- 161-ФЗ: отложенное исполнение, P-21 (TR-37)
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    completed_at         timestamptz,
    UNIQUE (sender_client_id, idempotency_key),         -- TR-11
    CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL)),
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
    CHECK (status <> 'REVIEW' OR review_deadline IS NOT NULL),
    CHECK (status <> 'SUSPENDED' OR (confirmation_deadline IS NOT NULL AND confirmed_at IS NULL)),  -- подтверждённый не приостанавливается второй раз
    CHECK (status <> 'COOLING' OR (execute_after IS NOT NULL AND confirmed_at IS NOT NULL)),
    CHECK ((currency = 'RUB') = (rate_date IS NULL)),
    CHECK (currency <> 'RUB' OR amount_rub = amount),
    CHECK (limit_month = date_trunc('month', limit_day)::date),
    CHECK (limit_day = (created_at AT TIME ZONE 'Europe/Moscow')::date),  -- TR-07: сутки по Москве
    CHECK (sender_client_id <> recipient_client_id)                     -- TR-04: не себе
);
CREATE INDEX transfer_in_progress ON transfers.transfer (status, updated_at)
    WHERE status IN ('NEW', 'HELD', 'CHECKING', 'POSTING');  -- поиск зависших переводов (TR-30)
CREATE INDEX transfer_review_deadline ON transfers.transfer (review_deadline) WHERE status = 'REVIEW';
CREATE INDEX transfer_confirmation_deadline ON transfers.transfer (confirmation_deadline) WHERE status = 'SUSPENDED';

-- Разрешённые переходы статусной модели (transfer-states.md)
CREATE TABLE transfers.status_transition (
    from_status text NOT NULL,
    to_status   text NOT NULL,
    PRIMARY KEY (from_status, to_status)
);
INSERT INTO transfers.status_transition VALUES
    ('NEW', 'HELD'), ('NEW', 'REJECTED'), ('NEW', 'FAILED'),
    ('HELD', 'CHECKING'),
    ('CHECKING', 'POSTING'), ('CHECKING', 'REJECTED'), ('CHECKING', 'REVIEW'),
    ('CHECKING', 'SUSPENDED'), ('CHECKING', 'COOLING'),
    ('REVIEW', 'POSTING'), ('REVIEW', 'REJECTED'), ('REVIEW', 'CANCELLED'), ('REVIEW', 'SUSPENDED'),
    ('SUSPENDED', 'CHECKING'), ('SUSPENDED', 'REJECTED'), ('SUSPENDED', 'CANCELLED'),
    ('COOLING', 'POSTING'), ('COOLING', 'CANCELLED'),
    ('POSTING', 'COMPLETED'), ('POSTING', 'REJECTED'), ('POSTING', 'FAILED');

CREATE FUNCTION transfers.client_status(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN s IN ('NEW', 'HELD', 'CHECKING', 'POSTING') THEN 'PROCESSING'
        WHEN s = 'REVIEW' THEN 'ON_REVIEW'
        WHEN s = 'SUSPENDED' THEN 'AWAITING_CONFIRMATION'
        WHEN s = 'COOLING' THEN 'DELAYED'
        ELSE s END
$$;

CREATE FUNCTION transfers.is_final(s text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
    SELECT s IN ('COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED')
$$;

-- Переводы создаются только в NEW или сразу в REJECTED по лимиту.
-- Меняется только по разрешённым переходам, версия растёт на 1, ключевые поля неизменны
CREATE FUNCTION transfers.guard_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT (NEW.status = 'NEW' OR (NEW.status = 'REJECTED' AND NEW.reject_reason = 'LIMIT_EXCEEDED')) THEN
            RAISE EXCEPTION 'Перевод создаётся в NEW или сразу REJECTED по лимиту, а не в %', NEW.status;
        END IF;
        NEW.version := 1;
        RETURN NEW;
    END IF;
    IF (NEW.sender_client_id, NEW.idempotency_key, NEW.request_hash, NEW.recipient_client_id,
        NEW.source_account_id, NEW.target_account_id, NEW.currency, NEW.amount, NEW.amount_rub,
        NEW.limit_day, NEW.created_at)
       IS DISTINCT FROM
       (OLD.sender_client_id, OLD.idempotency_key, OLD.request_hash, OLD.recipient_client_id,
        OLD.source_account_id, OLD.target_account_id, OLD.currency, OLD.amount, OLD.amount_rub,
        OLD.limit_day, OLD.created_at) THEN
        RAISE EXCEPTION 'Реквизиты перевода % не меняются', OLD.id;
    END IF;
    IF NEW.status <> OLD.status AND NOT EXISTS (
        SELECT 1 FROM transfers.status_transition WHERE from_status = OLD.status AND to_status = NEW.status) THEN
        RAISE EXCEPTION 'Переход % → % запрещён статусной моделью', OLD.status, NEW.status;
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
    RETURN NEW;
END $$;
CREATE TRIGGER transfer_guard BEFORE INSERT OR UPDATE ON transfers.transfer
    FOR EACH ROW EXECUTE FUNCTION transfers.guard_transfer();

-- Аренда обработки (TR-34): пока запрос или регламентная проверка ведёт перевод, повтор с тем же
-- ключом получает 409. Перевод создаётся сразу с арендой; повтор после её окончания берёт аренду
-- и продолжает обработку. Возвращает true, если аренду удалось взять
CREATE FUNCTION transfers.take_lease(p_id uuid, p_ttl interval) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
    UPDATE transfers.transfer SET lease_until = clock_timestamp() + p_ttl
     WHERE id = p_id AND NOT transfers.is_final(status)
       AND (lease_until IS NULL OR lease_until < clock_timestamp());
    RETURN FOUND;
END $$;

-- Лимиты: резерв при создании, расчёт при финальном статусе (TR-07, TR-08, TR-09)
CREATE TABLE transfers.limit_usage (
    sender_client_id  uuid NOT NULL,
    period            text NOT NULL CHECK (period IN ('DAY', 'MONTH')),
    period_start      date NOT NULL,
    reserved          numeric(19, 2) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    used              numeric(19, 2) NOT NULL DEFAULT 0 CHECK (used >= 0),
    PRIMARY KEY (sender_client_id, period, period_start)
);

-- Возвращает OK или период, лимит которого превышен. Строки DAY и MONTH блокируются
-- всегда в одном порядке, поэтому параллельные переводы одного отправителя выстраиваются в очередь
CREATE FUNCTION transfers.reserve_limit(p_sender uuid, p_day date, p_amount_rub numeric,
                                        p_operation_limit numeric, p_day_limit numeric, p_month_limit numeric)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    m date := date_trunc('month', p_day)::date;
    d_row transfers.limit_usage%ROWTYPE;
    m_row transfers.limit_usage%ROWTYPE;
BEGIN
    IF p_amount_rub > p_operation_limit THEN RETURN 'OPERATION'; END IF;
    INSERT INTO transfers.limit_usage (sender_client_id, period, period_start)
    VALUES (p_sender, 'DAY', p_day), (p_sender, 'MONTH', m)
    ON CONFLICT DO NOTHING;
    SELECT * INTO d_row FROM transfers.limit_usage
     WHERE sender_client_id = p_sender AND period = 'DAY' AND period_start = p_day FOR UPDATE;
    SELECT * INTO m_row FROM transfers.limit_usage
     WHERE sender_client_id = p_sender AND period = 'MONTH' AND period_start = m FOR UPDATE;
    IF d_row.reserved + d_row.used + p_amount_rub > p_day_limit THEN RETURN 'DAY'; END IF;
    IF m_row.reserved + m_row.used + p_amount_rub > p_month_limit THEN RETURN 'MONTH'; END IF;
    UPDATE transfers.limit_usage SET reserved = reserved + p_amount_rub
     WHERE sender_client_id = p_sender AND period_start IN (p_day, m)
       AND ((period = 'DAY' AND period_start = p_day) OR (period = 'MONTH' AND period_start = m));
    RETURN 'OK';
END $$;

CREATE FUNCTION transfers.settle_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF transfers.is_final(OLD.status) OR NOT transfers.is_final(NEW.status) THEN RETURN NEW; END IF;
    UPDATE transfers.limit_usage
       SET reserved = reserved - NEW.amount_rub,
           used = used + CASE WHEN NEW.status = 'COMPLETED' THEN NEW.amount_rub ELSE 0 END
     WHERE sender_client_id = NEW.sender_client_id
       AND ((period = 'DAY' AND period_start = NEW.limit_day)
         OR (period = 'MONTH' AND period_start = NEW.limit_month));
    RETURN NEW;
END $$;
CREATE TRIGGER transfer_settle_limit AFTER UPDATE OF status ON transfers.transfer
    FOR EACH ROW EXECUTE FUNCTION transfers.settle_limit();

-- Outbox: событие пишется в той же транзакции, что и статус (TR-27, ADR-003).
-- Публикуются переводы, принятые к исполнению: с перехода NEW → HELD и при каждой смене статуса,
-- который видит клиент. Отказ при создании событий не порождает: клиент получил его в ответе
CREATE TABLE transfers.outbox_event (
    event_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq               bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- порядок выборки relay
    transfer_id       uuid NOT NULL REFERENCES transfers.transfer (id),
    transfer_version  integer NOT NULL,
    event_type        text NOT NULL,
    payload           jsonb NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at      timestamptz,
    UNIQUE (transfer_id, transfer_version)
);
-- Relay выбирает по seq, а не по времени: now() — начало транзакции, и у позднего изменения оно
-- может оказаться раньше. Внутри перевода seq идёт в порядке версий: изменения перевода выполняются по очереди
CREATE INDEX outbox_unpublished ON transfers.outbox_event (seq) WHERE published_at IS NULL;

CREATE FUNCTION transfers.emit_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    prev text := transfers.client_status(OLD.status);
    cur  text := transfers.client_status(NEW.status);
    e    uuid := gen_random_uuid();
BEGIN
    IF NOT ((OLD.status = 'NEW' AND NEW.status = 'HELD') OR (OLD.status <> 'NEW' AND prev <> cur)) THEN
        RETURN NEW;
    END IF;
    INSERT INTO transfers.outbox_event (event_id, transfer_id, transfer_version, event_type, payload)
    VALUES (e, NEW.id, NEW.version, 'TransferStatusChanged', jsonb_build_object(
        'eventId', e,
        'occurredAt', clock_timestamp(),            -- момент изменения, а не начало транзакции
        'transferId', NEW.id,
        'transferVersion', NEW.version,
        'status', cur,
        'previousStatus', CASE WHEN OLD.status = 'NEW' THEN NULL ELSE prev END,
        'isFinal', transfers.is_final(NEW.status),
        'rejectReason', NEW.reject_reason,
        'amount', jsonb_build_object('value', to_char(NEW.amount, 'FM999999999999990.00'), 'currency', NEW.currency),
        'senderClientId', NEW.sender_client_id,
        'recipientClientId', NEW.recipient_client_id));
    RETURN NEW;
END $$;
CREATE TRIGGER transfer_emit_event AFTER UPDATE OF status ON transfers.transfer
    FOR EACH ROW EXECUTE FUNCTION transfers.emit_event();

-- Задачи продолжения обработки (TR-30, ADR-005): что сделать с переводом дальше.
-- Задача пишется в той же транзакции, что и статус, поэтому шаг не теряется, даже если сервис
-- упал сразу после коммита. Исполнитель берёт задачи с наступившим due_at и повторяет по P-17
CREATE TABLE transfers.task (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id  uuid NOT NULL REFERENCES transfers.transfer (id),
    kind         text NOT NULL CHECK (kind IN ('ANTIFRAUD_CHECK', 'CONFIRMATION_CHECK', 'RESUME', 'POST', 'RELEASE_HOLD')),
    due_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    attempts     integer NOT NULL DEFAULT 0,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
    done_at      timestamptz,
    outcome      text,
    UNIQUE (transfer_id, kind),
    CHECK ((done_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX task_due ON transfers.task (due_at) WHERE done_at IS NULL;

-- Следующий шаг ставится тем же переходом статуса:
--   NEW → HELD — проверка антифродом; подтверждение SUSPENDED → CHECKING — повторная сверка с базой ЦБ;
--   → COOLING — возобновление в момент execute_after; → POSTING — проводка;
--   отказ, отмена или сбой после холда, а также NEW → FAILED — снятие холда.
-- NEW → FAILED снимает холд, которого может ещё не быть: снятие закрывает операцию в леджере (TR-16).
-- Финальный статус закрывает задачи, которые больше не нужны
CREATE FUNCTION transfers.enqueue_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    k text;
    due timestamptz := clock_timestamp();
BEGIN
    IF NEW.status = OLD.status THEN RETURN NEW; END IF;
    k := CASE
        WHEN OLD.status = 'NEW' AND NEW.status = 'HELD' THEN 'ANTIFRAUD_CHECK'
        WHEN OLD.status = 'SUSPENDED' AND NEW.status = 'CHECKING' THEN 'CONFIRMATION_CHECK'
        WHEN NEW.status = 'COOLING' THEN 'RESUME'
        WHEN NEW.status = 'POSTING' THEN 'POST'
        WHEN OLD.status = 'NEW' AND NEW.status = 'REJECTED' THEN NULL   -- холда не было: лимит, остаток, счёт
        WHEN NEW.status IN ('REJECTED', 'CANCELLED', 'FAILED') THEN 'RELEASE_HOLD'
    END;
    IF transfers.is_final(NEW.status) THEN
        UPDATE transfers.task SET done_at = clock_timestamp(), outcome = 'NOT_NEEDED'
         WHERE transfer_id = NEW.id AND done_at IS NULL;
    END IF;
    IF k = 'RESUME' THEN due := NEW.execute_after; END IF;
    IF k IS NOT NULL THEN
        INSERT INTO transfers.task (transfer_id, kind, due_at) VALUES (NEW.id, k, due);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER transfer_enqueue_task AFTER UPDATE OF status ON transfers.transfer
    FOR EACH ROW EXECUTE FUNCTION transfers.enqueue_task();

-- Повтор задачи (P-17): пауза растёт вдвое от 1 с до потолка, со случайным разбросом ± 50%.
-- Потолок — 5 мин для проверки антифродом (P-10), 1 мин для операций леджера
CREATE FUNCTION transfers.retry_task(p_id bigint, p_error text, p_cap interval) RETURNS timestamptz
LANGUAGE sql AS $$
    UPDATE transfers.task
       SET attempts = attempts + 1, last_error = p_error,
           due_at = clock_timestamp()
                    + least(p_cap, interval '1 second' * power(2, least(attempts, 20))) * (0.5 + random())
     WHERE id = p_id AND done_at IS NULL
    RETURNING due_at
$$;

-- Что требует внимания регламентной проверки (TR-30). P-12 = 5 мин
CREATE VIEW transfers.attention AS
SELECT t.id AS transfer_id, t.status, 'NEW_TOO_LONG' AS reason      -- закрыть: FAILED и снятие холда
  FROM transfers.transfer t
 WHERE t.status = 'NEW' AND t.created_at < clock_timestamp() - interval '5 minutes'
UNION ALL
SELECT t.id, t.status, 'NO_OPEN_TASK'                                -- инцидент: восстановить задачу
  FROM transfers.transfer t
 WHERE t.status IN ('HELD', 'CHECKING', 'POSTING')
   AND NOT EXISTS (SELECT 1 FROM transfers.task k WHERE k.transfer_id = t.id AND k.done_at IS NULL)
UNION ALL
SELECT k.transfer_id, t.status, 'TASK_OVERDUE'                       -- алерт: лежит зависимость или исполнитель
  FROM transfers.task k JOIN transfers.transfer t ON t.id = k.transfer_id
 WHERE k.done_at IS NULL
   AND ((k.attempts > 0 AND k.created_at < clock_timestamp() - interval '5 minutes')   -- повторяется дольше P-12
     OR k.due_at < clock_timestamp() - interval '5 minutes');                         -- срок прошёл, не взята

-- Попытки проверки антифродом и решения по ручной проверке
CREATE TABLE transfers.antifraud_check (
    transfer_id  uuid NOT NULL REFERENCES transfers.transfer (id),
    attempt      integer NOT NULL CHECK (attempt >= 1),
    sent_at      timestamptz NOT NULL DEFAULT now(),
    stage        text NOT NULL DEFAULT 'INITIAL' CHECK (stage IN ('INITIAL', 'CONFIRMATION')),
    outcome      text CHECK (outcome IN ('ALLOW', 'DENY', 'REVIEW', 'SUSPEND', 'DELAY', 'TIMEOUT', 'ERROR')),
    case_id      text,                                  -- номер кейса ручной проверки у антифрода
    decision_id  uuid UNIQUE,                           -- идемпотентность колбэка с решением
    PRIMARY KEY (transfer_id, attempt)
);
