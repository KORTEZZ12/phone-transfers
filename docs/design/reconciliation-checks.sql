-- Проверка сверки и витрины: на чистых данных сверка молчит, на каждом виде дефекта — находит его.
-- Запуск на чистой базе: psql -v ON_ERROR_STOP=1 -f ddl.sql -f reconciliation.sql -f reconciliation-checks.sql
-- Каждый блок либо печатает «ok», либо падает с описанием нарушения.

\set QUIET on
SET client_min_messages = notice;

-- Счета: технические счета банка, отправитель с рублёвым и долларовым счётом, двое получателей
INSERT INTO ledger.account (id, client_id, type, currency, is_primary, status) VALUES
 ('00000000-0000-0000-0000-0000000000b0', NULL, 'BANK_TECHNICAL', 'RUB', false, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000b1', NULL, 'BANK_TECHNICAL', 'USD', false, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'CLIENT_CURRENT', 'RUB', true, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a5', '10000000-0000-0000-0000-000000000001', 'CLIENT_CURRENT', 'USD', true, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-000000000002', 'CLIENT_CURRENT', 'RUB', true, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a3', '20000000-0000-0000-0000-000000000002', 'CLIENT_CURRENT', 'USD', true, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a6', '30000000-0000-0000-0000-000000000003', 'CLIENT_CURRENT', 'RUB', true, 'OPEN');
INSERT INTO ledger.posting (kind, debit_account_id, credit_account_id, currency, amount) VALUES
 ('OTHER', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a1', 'RUB', 100000),
 ('OTHER', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a5', 'USD', 1000);
INSERT INTO transfers.currency_rate (currency, rate_date, nominal, rate)
VALUES ('USD', reporting.msk_day(now()), 1, 92.0000);

-- Перевод в NEW: реквизиты по умолчанию — отправитель 1 переводит получателю 2 в рублях
CREATE FUNCTION pg_temp.new_transfer(p_id uuid, p_amount numeric, p_currency char(3) DEFAULT 'RUB',
                                      p_target uuid DEFAULT '00000000-0000-0000-0000-0000000000a2')
RETURNS uuid LANGUAGE sql AS $$
    INSERT INTO transfers.transfer (id, sender_client_id, idempotency_key, request_hash, recipient_client_id,
           source_account_id, target_account_id, currency, amount, amount_rub, rate_date, limit_day, limit_month, status)
    VALUES (p_id, '10000000-0000-0000-0000-000000000001', gen_random_uuid(), 'h', '20000000-0000-0000-0000-000000000002',
            CASE p_currency WHEN 'RUB' THEN '00000000-0000-0000-0000-0000000000a1'::uuid ELSE '00000000-0000-0000-0000-0000000000a5'::uuid END,
            p_target, p_currency, p_amount,
            CASE p_currency WHEN 'RUB' THEN p_amount ELSE p_amount * 92 END,
            CASE p_currency WHEN 'RUB' THEN NULL ELSE reporting.msk_day(now()) END,
            reporting.msk_day(now()), date_trunc('month', reporting.msk_day(now()))::date, 'NEW')
    RETURNING id
$$;

-- Путь до POSTING: холд, антифрод разрешил
CREATE FUNCTION pg_temp.to_posting(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t transfers.transfer%ROWTYPE;
BEGIN
    SELECT * INTO t FROM transfers.transfer WHERE id = p_id;
    ASSERT ledger.place_hold(p_id, t.source_account_id, t.currency, t.amount) = 'HELD';
    UPDATE transfers.transfer SET status = 'HELD' WHERE id = p_id;
    UPDATE transfers.transfer SET status = 'CHECKING' WHERE id = p_id;
    INSERT INTO transfers.antifraud_check (transfer_id, attempt, outcome) VALUES (p_id, 1, 'ALLOW');
    UPDATE transfers.transfer SET status = 'POSTING' WHERE id = p_id;
END $$;

-- Полный путь до COMPLETED: проводка в леджере и закрытие задач, как это делает исполнитель
CREATE FUNCTION pg_temp.complete(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t transfers.transfer%ROWTYPE;
BEGIN
    SELECT * INTO t FROM transfers.transfer WHERE id = p_id;
    IF t.status <> 'POSTING' THEN PERFORM pg_temp.to_posting(p_id); END IF;
    ASSERT ledger.post_transfer(p_id, t.target_account_id) IN ('POSTED', 'ALREADY_POSTED');
    UPDATE transfers.task SET done_at = clock_timestamp(), outcome = 'POSTED' WHERE transfer_id = p_id AND done_at IS NULL;
    UPDATE transfers.transfer SET status = 'COMPLETED', completed_at = clock_timestamp() WHERE id = p_id;
END $$;

CREATE FUNCTION pg_temp.found(p_type text, p_transfer uuid DEFAULT NULL, p_severity text DEFAULT 'ERROR') RETURNS boolean LANGUAGE sql AS $$
    SELECT EXISTS (SELECT 1 FROM reporting.reconcile(reporting.msk_day(now())) r
                    WHERE r.check_type = p_type AND r.severity = p_severity
                      AND (p_transfer IS NULL OR r.transfer_id = p_transfer))
$$;

-- Чистый день: два выполненных перевода, отказ по лимиту, перевод на проверке, отменённый перевод
DO $$ BEGIN
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000001', 1500);
  PERFORM pg_temp.complete('40000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000002', 100, 'USD', '00000000-0000-0000-0000-0000000000a3');
  PERFORM pg_temp.complete('40000000-0000-0000-0000-000000000002');
  INSERT INTO transfers.transfer (id, sender_client_id, idempotency_key, request_hash, recipient_client_id,
         source_account_id, target_account_id, currency, amount, amount_rub, limit_day, limit_month, status, reject_reason)
  VALUES ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', gen_random_uuid(), 'h',
          '20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
          'RUB', 400000, 400000, reporting.msk_day(now()), date_trunc('month', reporting.msk_day(now()))::date, 'REJECTED', 'LIMIT_EXCEEDED');
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000004', 700);
  ASSERT ledger.place_hold('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a1', 'RUB', 700) = 'HELD';
  UPDATE transfers.transfer SET status = 'HELD' WHERE id = '40000000-0000-0000-0000-000000000004';
  UPDATE transfers.transfer SET status = 'CHECKING' WHERE id = '40000000-0000-0000-0000-000000000004';
  INSERT INTO transfers.antifraud_check (transfer_id, attempt, outcome) VALUES ('40000000-0000-0000-0000-000000000004', 1, 'REVIEW');
  UPDATE transfers.transfer SET status = 'REVIEW', review_deadline = now() + interval '48 hours' WHERE id = '40000000-0000-0000-0000-000000000004';
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000005', 300);
  ASSERT ledger.place_hold('40000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000a1', 'RUB', 300) = 'HELD';
  UPDATE transfers.transfer SET status = 'HELD' WHERE id = '40000000-0000-0000-0000-000000000005';
  UPDATE transfers.transfer SET status = 'CHECKING' WHERE id = '40000000-0000-0000-0000-000000000005';
  UPDATE transfers.transfer SET status = 'REVIEW', review_deadline = now() + interval '48 hours' WHERE id = '40000000-0000-0000-0000-000000000005';
  UPDATE transfers.transfer SET status = 'CANCELLED' WHERE id = '40000000-0000-0000-0000-000000000005';
  ASSERT ledger.release_hold('40000000-0000-0000-0000-000000000005') = 'RELEASED';
  UPDATE transfers.task SET done_at = clock_timestamp(), outcome = 'RELEASED'
   WHERE transfer_id = '40000000-0000-0000-0000-000000000005' AND kind = 'RELEASE_HOLD';

  ASSERT NOT EXISTS (SELECT 1 FROM reporting.reconcile(reporting.msk_day(now())) WHERE severity IN ('ERROR', 'WARN')),
         'на чистых данных сверка нашла расхождения: '
         || (SELECT string_agg(check_type, ', ') FROM reporting.reconcile(reporting.msk_day(now())));
  ASSERT (SELECT ok AND completed_transfers = 2 AND totals = '{"RUB": 1500.00, "USD": 100.00}'::jsonb
            FROM reporting.reconciliation_summary(reporting.msk_day(now()))), 'итог сверки за чистый день';
  RAISE NOTICE 'ok  TR-31 на чистых данных расхождений нет, итог дня по валютам';
END $$;

-- Отказ 8: леджер провёл, ответ потерялся, перевод ещё в POSTING — предупреждение, а не инцидент
DO $$ BEGIN
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000006', 200);
  PERFORM pg_temp.to_posting('40000000-0000-0000-0000-000000000006');
  ASSERT ledger.post_transfer('40000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-0000000000a2') = 'POSTED';
  ASSERT pg_temp.found('POSTED_NOT_YET_COMPLETED', '40000000-0000-0000-0000-000000000006', 'WARN');
  ASSERT NOT pg_temp.found('POSTING_WITHOUT_COMPLETED_TRANSFER') AND NOT pg_temp.found('DAY_TOTAL_MISMATCH');
  ASSERT (SELECT ok AND warnings = 1 FROM reporting.reconciliation_summary(reporting.msk_day(now())));
  PERFORM pg_temp.complete('40000000-0000-0000-0000-000000000006');   -- повтор задачи: ALREADY_POSTED
  ASSERT NOT pg_temp.found('POSTED_NOT_YET_COMPLETED', NULL, 'WARN');
  RAISE NOTICE 'ok  отказ 8: проводка до обработки ответа — предупреждение, после повтора задачи расхождения нет';
END $$;

-- Граница суток: проводка в 23:59:59, перевод выполнен в 00:00:00 — относится к дню выполнения перевода
DO $$
DECLARE
  d date := reporting.msk_day(now());
  midnight timestamptz := (d::timestamp AT TIME ZONE 'Europe/Moscow');
BEGIN
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000011', 250);
  PERFORM pg_temp.to_posting('40000000-0000-0000-0000-000000000011');
  -- леджер провёл за секунду до полуночи, сервис переводов записал COMPLETED уже в новых сутках
  INSERT INTO ledger.posting (kind, transfer_id, debit_account_id, credit_account_id, currency, amount, posted_at)
  VALUES ('TRANSFER', '40000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-0000000000a2', 'RUB', 250, midnight - interval '1 second');
  UPDATE ledger.hold SET status = 'CAPTURED', closed_at = midnight - interval '1 second'
   WHERE transfer_id = '40000000-0000-0000-0000-000000000011';
  UPDATE transfers.task SET done_at = clock_timestamp(), outcome = 'POSTED' WHERE transfer_id = '40000000-0000-0000-0000-000000000011' AND done_at IS NULL;
  UPDATE transfers.transfer SET status = 'COMPLETED', completed_at = midnight WHERE id = '40000000-0000-0000-0000-000000000011';
  ASSERT NOT EXISTS (SELECT 1 FROM reporting.reconcile(d - 1) WHERE severity IN ('ERROR', 'WARN')),
         'вчера: проводка без выполненного перевода — ложное расхождение';
  ASSERT NOT EXISTS (SELECT 1 FROM reporting.reconcile(d) WHERE severity IN ('ERROR', 'WARN')),
         'сегодня: выполненный перевод без проводки за день — ложное расхождение';
  ASSERT (SELECT totals = '{"RUB": 1950.00, "USD": 100.00}'::jsonb FROM reporting.reconciliation_summary(d)),
         'перевод в итоге дня выполнения';
  RAISE NOTICE 'ok  граница суток: проводка в 23:59:59 относится к дню выполнения перевода, ложных расхождений нет';
END $$;

-- Отказ 9 наоборот: дефект — перевод отмечен выполненным, а проводки нет
DO $$ BEGIN
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000007', 900);
  PERFORM pg_temp.to_posting('40000000-0000-0000-0000-000000000007');
  UPDATE transfers.transfer SET status = 'COMPLETED', completed_at = clock_timestamp() WHERE id = '40000000-0000-0000-0000-000000000007';
  ASSERT pg_temp.found('COMPLETED_WITHOUT_POSTING', '40000000-0000-0000-0000-000000000007');
  ASSERT pg_temp.found('COMPLETED_HOLD_NOT_CAPTURED', '40000000-0000-0000-0000-000000000007');
  ASSERT pg_temp.found('DAY_TOTAL_MISMATCH');
  RAISE NOTICE 'ok  выполненный перевод без проводки найден, итог дня не сходится';
END $$;

-- Дефект: проводка без перевода
DO $$ BEGIN
  INSERT INTO ledger.posting (kind, transfer_id, debit_account_id, credit_account_id, currency, amount)
  VALUES ('TRANSFER', '40000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a6', 'RUB', 999);
  ASSERT pg_temp.found('POSTING_WITHOUT_COMPLETED_TRANSFER', '40000000-0000-0000-0000-0000000000ff');
  RAISE NOTICE 'ok  проводка без перевода найдена';
END $$;

-- Дефект: сумма проводки не совпадает с суммой перевода. Сервис записал перевод на 1 000 ₽, леджер провёл 1 010 ₽
DO $$ BEGIN
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000008', 1000);
  PERFORM pg_temp.to_posting('40000000-0000-0000-0000-000000000008');
  ASSERT ledger.release_hold('40000000-0000-0000-0000-000000000008') = 'RELEASED';
  INSERT INTO ledger.posting (kind, transfer_id, debit_account_id, credit_account_id, currency, amount)
  VALUES ('TRANSFER', '40000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'RUB', 1010);
  UPDATE transfers.transfer SET status = 'COMPLETED', completed_at = clock_timestamp() WHERE id = '40000000-0000-0000-0000-000000000008';
  ASSERT pg_temp.found('POSTING_MISMATCH', '40000000-0000-0000-0000-000000000008');
  RAISE NOTICE 'ok  проводка с другой суммой найдена';
END $$;

-- TR-17: перевод отклонён, задача снятия закрыта, а холд остался — деньги клиента заблокированы зря
DO $$ BEGIN
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000009', 400);
  PERFORM pg_temp.to_posting('40000000-0000-0000-0000-000000000009');
  UPDATE transfers.transfer SET status = 'REJECTED', reject_reason = 'RECIPIENT_ACCOUNT_UNAVAILABLE' WHERE id = '40000000-0000-0000-0000-000000000009';
  ASSERT NOT pg_temp.found('HOLD_NOT_RELEASED', '40000000-0000-0000-0000-000000000009'), 'пока задача снятия открыта, это не расхождение';
  UPDATE transfers.task SET done_at = clock_timestamp(), outcome = 'RELEASED'
   WHERE transfer_id = '40000000-0000-0000-0000-000000000009' AND kind = 'RELEASE_HOLD';
  ASSERT pg_temp.found('HOLD_NOT_RELEASED', '40000000-0000-0000-0000-000000000009');
  RAISE NOTICE 'ok  TR-17 активный холд у финального перевода без задачи снятия найден';
END $$;

-- Инвариант: перевод на проверке без холда
DO $$ BEGIN
  ASSERT ledger.release_hold('40000000-0000-0000-0000-000000000004') = 'RELEASED';
  ASSERT pg_temp.found('ACTIVE_TRANSFER_WITHOUT_HOLD', '40000000-0000-0000-0000-000000000004');
  RAISE NOTICE 'ok  перевод на проверке без холда найден';
END $$;

-- Сторно попадает в отчёт как информация, а не как ошибка
DO $$ BEGIN
  INSERT INTO ledger.posting (kind, transfer_id, debit_account_id, credit_account_id, currency, amount, reverses_posting_id)
  SELECT 'REVERSAL', transfer_id, credit_account_id, debit_account_id, currency, amount, id
    FROM ledger.posting WHERE transfer_id = '40000000-0000-0000-0000-0000000000ff' AND kind = 'TRANSFER';
  ASSERT pg_temp.found('REVERSAL', '40000000-0000-0000-0000-0000000000ff', 'INFO');
  RAISE NOTICE 'ok  сторно в отчёте сверки';
END $$;

-- Баланс разошёлся с проводками: проводка записана в обход триггера apply_posting
DO $$ BEGIN
  SET LOCAL session_replication_role = replica;   -- триггеры выключены: так выглядит сбой проекции
  INSERT INTO ledger.posting (kind, debit_account_id, credit_account_id, currency, amount)
  VALUES ('OTHER', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a6', 'RUB', 50);
  SET LOCAL session_replication_role = origin;
  ASSERT EXISTS (SELECT 1 FROM reporting.reconcile(reporting.msk_day(now()))
                  WHERE check_type = 'BALANCE_PROJECTION_MISMATCH' AND account_id = '00000000-0000-0000-0000-0000000000a6');
  RAISE NOTICE 'ok  расхождение баланса и проводок найдено';
END $$;

DO $$ BEGIN
  ASSERT (SELECT NOT ok AND errors >= 7 FROM reporting.reconciliation_summary(reporting.msk_day(now()))), 'итог сверки — расхождения';
  RAISE NOTICE 'ok  итог сверки: день не сходится, алерт операционному отделу';
END $$;

-- Витрина: переводы за день
DO $$
DECLARE r reporting.transfer_daily%ROWTYPE;
BEGIN
  SELECT * INTO r FROM reporting.transfer_daily WHERE day = reporting.msk_day(now()) AND currency = 'RUB';
  ASSERT r.requests = 9, format('заявок %s', r.requests);
  ASSERT r.rejected_sync = 1 AND r.rejected_async = 1, 'отказ по лимиту — синхронный, по счёту получателя — асинхронный';
  ASSERT r.cancelled = 1 AND r.in_progress = 1, 'отменён один, на проверке один';
  ASSERT r.completed = 5 AND r.completed_amount = 1500 + 200 + 250 + 900 + 1000, format('выполнено %s на %s', r.completed, r.completed_amount);
  ASSERT r.waited_for_human = 1, 'ручная проверка — ожидание человека';
  ASSERT r.p95_seconds_to_final IS NOT NULL;
  SELECT * INTO r FROM reporting.transfer_daily WHERE day = reporting.msk_day(now()) AND currency = 'USD';
  ASSERT r.completed = 1 AND r.completed_amount = 100 AND r.completed_amount_rub = 9200, 'валютный перевод и его рублёвый эквивалент';
  ASSERT (SELECT transfers FROM reporting.reject_reasons_daily WHERE reject_reason = 'LIMIT_EXCEEDED' AND kind = 'SYNC') = 1;
  RAISE NOTICE 'ok  витрина: переводы по дням, валютам и исходам';
END $$;

-- Метрики видения: потерянный перевод и расхождения сверки видны в метриках
DO $$ BEGIN
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000010', 100);
  ASSERT ledger.place_hold('40000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-0000000000a1', 'RUB', 100) = 'HELD';
  UPDATE transfers.transfer SET status = 'HELD' WHERE id = '40000000-0000-0000-0000-000000000010';
  UPDATE transfers.task SET done_at = clock_timestamp(), outcome = 'LOST' WHERE transfer_id = '40000000-0000-0000-0000-000000000010';
  ASSERT (SELECT value = 1 AND NOT ok FROM reporting.vision_metrics(reporting.msk_day(now()), reporting.msk_day(now()))
           WHERE metric = 'Переводов в промежуточном статусе без открытой задачи');
  ASSERT (SELECT value = 0 AND ok FROM reporting.vision_metrics(reporting.msk_day(now()), reporting.msk_day(now()))
           WHERE metric LIKE 'Переводов с двумя списаниями%');
  ASSERT (SELECT NOT ok FROM reporting.vision_metrics(reporting.msk_day(now()), reporting.msk_day(now()))
           WHERE metric = 'Расхождений ежедневной сверки');
  RAISE NOTICE 'ok  метрики видения: потерянный перевод и расхождения сверки';
END $$;

-- Метрика «завершён за P-12»: перевод, закрытый из NEW регламентной проверкой, — невыполнение, а не исключение.
-- Синхронный отказ в знаменатель не входит
DO $$
DECLARE before numeric; after numeric; n_before bigint; n_after bigint;
BEGIN
  SELECT value INTO before FROM reporting.vision_metrics(reporting.msk_day(now()), reporting.msk_day(now()))
   WHERE metric LIKE 'Доля переводов без ожидания человека%';
  SELECT count(*) INTO n_before FROM reporting.transfer_facts WHERE NOT sync_rejected AND NOT waited_for_human
     AND (finished_at IS NOT NULL OR created_at < now() - interval '5 minutes');
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000012', 100);
  -- создан 6 минут назад, холда не было; регламентная проверка закрыла его как FAILED
  SET LOCAL session_replication_role = replica;
  UPDATE transfers.transfer SET created_at = now() - interval '6 minutes' WHERE id = '40000000-0000-0000-0000-000000000012';
  SET LOCAL session_replication_role = origin;
  UPDATE transfers.transfer SET status = 'FAILED' WHERE id = '40000000-0000-0000-0000-000000000012';
  ASSERT (SELECT NOT accepted AND NOT sync_rejected FROM reporting.transfer_facts WHERE id = '40000000-0000-0000-0000-000000000012'),
         'FAILED из NEW — не синхронный отказ';
  SELECT count(*) INTO n_after FROM reporting.transfer_facts WHERE NOT sync_rejected AND NOT waited_for_human
     AND (finished_at IS NOT NULL OR created_at < now() - interval '5 minutes');
  ASSERT n_after = n_before + 1, 'FAILED из NEW попал в знаменатель';
  SELECT value INTO after FROM reporting.vision_metrics(reporting.msk_day(now()), reporting.msk_day(now()))
   WHERE metric LIKE 'Доля переводов без ожидания человека%';
  ASSERT after < before, format('доля должна упасть: было %s, стало %s', before, after);
  ASSERT NOT EXISTS (SELECT 1 FROM reporting.transfer_facts WHERE sync_rejected AND reject_reason <> 'LIMIT_EXCEEDED'
                      AND id = '40000000-0000-0000-0000-000000000003'), 'отказ по лимиту — синхронный';
  RAISE NOTICE 'ok  метрика «завершён за P-12»: зависший в NEW перевод портит её, синхронный отказ не входит';
END $$;

-- Сигнал о двойном переводе от приложения: те же данные, разные ключи, меньше минуты
DO $$ BEGIN
  ASSERT (SELECT value = 0 AND ok IS NULL FROM reporting.vision_metrics(reporting.msk_day(now()), reporting.msk_day(now()))
           WHERE metric LIKE 'Подозрений на двойной перевод%'), 'до дубля сигнала нет';
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000013', 333);
  PERFORM pg_temp.complete('40000000-0000-0000-0000-000000000013');
  PERFORM pg_temp.new_transfer('40000000-0000-0000-0000-000000000014', 333);
  PERFORM pg_temp.complete('40000000-0000-0000-0000-000000000014');
  ASSERT (SELECT value = 1 FROM reporting.vision_metrics(reporting.msk_day(now()), reporting.msk_day(now()))
           WHERE metric LIKE 'Подозрений на двойной перевод%'), 'дубль с новым ключом виден';
  RAISE NOTICE 'ok  двойной перевод с новым ключом виден как сигнал, хотя ограничения ключа его не ловят';
END $$;

\echo 'Все проверки сверки и витрины пройдены'
