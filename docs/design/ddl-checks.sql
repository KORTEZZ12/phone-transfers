-- Проверка, что ограничения и функции из ddl.sql держат бизнес-правила.
-- Запуск на чистой базе: psql -v ON_ERROR_STOP=1 -f ddl.sql -f ddl-checks.sql
-- Каждый блок либо печатает «ok», либо падает с описанием нарушения.

\set QUIET on
SET client_min_messages = notice;

-- Счета: технический счёт банка, отправитель и получатель в рублях, получатель в долларах
INSERT INTO ledger.account (id, client_id, type, currency, is_primary, status) VALUES
 ('00000000-0000-0000-0000-0000000000b0', NULL, 'BANK_TECHNICAL', 'RUB', false, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'CLIENT_CURRENT', 'RUB', true, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-000000000002', 'CLIENT_CURRENT', 'RUB', true, 'OPEN'),
 ('00000000-0000-0000-0000-0000000000a3', '20000000-0000-0000-0000-000000000002', 'CLIENT_CURRENT', 'USD', true, 'OPEN');

-- Пополнение отправителя прочей операцией банка: 10 000 ₽
INSERT INTO ledger.posting (kind, debit_account_id, credit_account_id, currency, amount)
VALUES ('OTHER', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a1', 'RUB', 10000);

DO $$ BEGIN
  ASSERT (SELECT balance FROM ledger.account WHERE id = '00000000-0000-0000-0000-0000000000a1') = 10000,
         'баланс должен вырасти на сумму проводки';
  RAISE NOTICE 'ok  баланс — проекция проводок';
END $$;

-- TR-16: повтор холда возвращает существующий, второго холда нет
DO $$ BEGIN
  ASSERT ledger.place_hold('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'RUB', 3000) = 'HELD';
  ASSERT ledger.place_hold('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'RUB', 3000) = 'ALREADY_ACTIVE';
  ASSERT (SELECT count(*) FROM ledger.hold WHERE transfer_id = '30000000-0000-0000-0000-000000000001') = 1;
  RAISE NOTICE 'ok  TR-16 повтор холда идемпотентен';
END $$;

-- TR-12: холд сверх доступного остатка отклоняется (10 000 − 3 000 = 7 000 доступно)
DO $$ BEGIN
  ASSERT ledger.place_hold('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'RUB', 7500) = 'INSUFFICIENT_FUNDS';
  ASSERT (SELECT available FROM ledger.account_available WHERE id = '00000000-0000-0000-0000-0000000000a1') = 7000;
  RAISE NOTICE 'ok  TR-12 холд не превышает доступный остаток';
END $$;

-- TR-14, TR-16: проводка списывает холд и зачисляет получателю, повтор не проводит второй раз
DO $$ BEGIN
  ASSERT ledger.post_transfer('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2') = 'POSTED';
  ASSERT ledger.post_transfer('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a2') = 'ALREADY_POSTED';
  ASSERT (SELECT balance FROM ledger.account WHERE id = '00000000-0000-0000-0000-0000000000a1') = 7000;
  ASSERT (SELECT balance FROM ledger.account WHERE id = '00000000-0000-0000-0000-0000000000a2') = 3000;
  ASSERT (SELECT status FROM ledger.hold WHERE transfer_id = '30000000-0000-0000-0000-000000000001') = 'CAPTURED';
  RAISE NOTICE 'ok  TR-14 списание и зачисление одной проводкой, повтор безопасен';
END $$;

-- TR-18: зачисление на счёт в другой валюте не проводится
DO $$ BEGIN
  ASSERT ledger.place_hold('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', 'RUB', 100) = 'HELD';
  ASSERT ledger.post_transfer('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a3') = 'RECIPIENT_ACCOUNT_UNAVAILABLE';
  ASSERT ledger.release_hold('30000000-0000-0000-0000-000000000003') = 'RELEASED';
  ASSERT ledger.release_hold('30000000-0000-0000-0000-000000000003') = 'ALREADY_RELEASED';
  RAISE NOTICE 'ok  TR-18 счёт получателя в другой валюте отклоняется, снятие холда идемпотентно';
END $$;

-- Валюта проводки должна совпадать с валютой обоих счетов (составной FK)
DO $$ BEGIN
  BEGIN
    INSERT INTO ledger.posting (kind, debit_account_id, credit_account_id, currency, amount)
    VALUES ('OTHER', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a3', 'RUB', 1);
    RAISE EXCEPTION 'проводка в чужой валюте прошла';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok  проводка между счетами в разных валютах невозможна';
  END;
END $$;

-- TR-15: проводки не меняются; сторно только зеркальное
DO $$ BEGIN
  BEGIN
    UPDATE ledger.posting SET amount = 1 WHERE transfer_id = '30000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'проводку удалось изменить';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'проводку удалось%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  TR-15 проводку нельзя изменить';
  END;
  BEGIN
    INSERT INTO ledger.posting (kind, transfer_id, debit_account_id, credit_account_id, currency, amount, reverses_posting_id)
    SELECT 'REVERSAL', transfer_id, debit_account_id, credit_account_id, currency, amount, id
      FROM ledger.posting WHERE transfer_id = '30000000-0000-0000-0000-000000000001' AND kind = 'TRANSFER';
    RAISE EXCEPTION 'незеркальное сторно прошло';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'незеркальное%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  TR-15 сторно с теми же счетами отклонено';
  END;
END $$;

-- TR-16: снятие холда раньше самого холда закрывает операцию, запоздавший холд не появляется
DO $$ BEGIN
  ASSERT ledger.release_hold('30000000-0000-0000-0000-000000000004') = 'NO_HOLD';
  ASSERT ledger.place_hold('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a1', 'RUB', 100) = 'ALREADY_RELEASED';
  ASSERT NOT EXISTS (SELECT 1 FROM ledger.hold WHERE transfer_id = '30000000-0000-0000-0000-000000000004');
  RAISE NOTICE 'ok  TR-16 запоздавший холд после снятия не создаётся';
END $$;

-- TR-18: счёт отправителя заблокировали после холда — проводки нет, холд снимается
INSERT INTO ledger.account (id, client_id, type, currency, is_primary, status) VALUES
 ('00000000-0000-0000-0000-0000000000a4', '10000000-0000-0000-0000-000000000001', 'CLIENT_CURRENT', 'RUB', false, 'OPEN');
INSERT INTO ledger.posting (kind, debit_account_id, credit_account_id, currency, amount)
VALUES ('OTHER', '00000000-0000-0000-0000-0000000000b0', '00000000-0000-0000-0000-0000000000a4', 'RUB', 500);

DO $$ BEGIN
  ASSERT ledger.place_hold('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000a4', 'RUB', 200) = 'HELD';
  UPDATE ledger.account SET status = 'BLOCKED' WHERE id = '00000000-0000-0000-0000-0000000000a4';
  ASSERT ledger.post_transfer('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000a2') = 'SOURCE_ACCOUNT_UNAVAILABLE';
  ASSERT ledger.release_hold('30000000-0000-0000-0000-000000000005') = 'RELEASED';
  ASSERT (SELECT balance FROM ledger.account WHERE id = '00000000-0000-0000-0000-0000000000a4') = 500;
  RAISE NOTICE 'ok  TR-18 со счёта, заблокированного после холда, не списывается';
END $$;

-- Баланс — проекция проводок: без проводки его не изменить, счёт открывается с нулём
DO $$ BEGIN
  BEGIN
    UPDATE ledger.account SET balance = balance + 1000 WHERE id = '00000000-0000-0000-0000-0000000000a2';
    RAISE EXCEPTION 'баланс удалось изменить без проводки';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'баланс удалось%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO ledger.account (id, client_id, type, currency, is_primary, status, balance)
    VALUES ('00000000-0000-0000-0000-0000000000a9', '90000000-0000-0000-0000-000000000009', 'CLIENT_CURRENT', 'RUB', true, 'OPEN', 777);
    RAISE EXCEPTION 'счёт открыт с балансом без проводки';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'счёт открыт%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok  баланс меняется только проводкой, счёт открывается с нулём';
END $$;

-- Сервис переводов: перевод 1 500 ₽ проходит путь до COMPLETED
INSERT INTO transfers.limit_usage VALUES
 ('10000000-0000-0000-0000-000000000001', 'DAY',   DATE '2026-10-19', 0, 490000),
 ('10000000-0000-0000-0000-000000000001', 'MONTH', DATE '2026-10-01', 0, 490000);

DO $$ BEGIN
  ASSERT transfers.reserve_limit('10000000-0000-0000-0000-000000000001', DATE '2026-10-19', 1500, 300000, 500000, 2000000) = 'OK';
  INSERT INTO transfers.transfer (id, sender_client_id, idempotency_key, request_hash, recipient_client_id,
         source_account_id, target_account_id, currency, amount, amount_rub, limit_day, limit_month, status)
  VALUES ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000001', 'h1', '20000000-0000-0000-0000-000000000002',
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
          'RUB', 1500, 1500, DATE '2026-10-19', DATE '2026-10-01', 'NEW');
  UPDATE transfers.transfer SET status = 'HELD'     WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE transfers.transfer SET status = 'CHECKING' WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE transfers.transfer SET status = 'POSTING'  WHERE id = '40000000-0000-0000-0000-000000000001';
  UPDATE transfers.transfer SET status = 'COMPLETED', completed_at = now() WHERE id = '40000000-0000-0000-0000-000000000001';
  ASSERT (SELECT version FROM transfers.transfer WHERE id = '40000000-0000-0000-0000-000000000001') = 5;
  ASSERT (SELECT array_agg(payload->>'status' ORDER BY transfer_version) FROM transfers.outbox_event
           WHERE transfer_id = '40000000-0000-0000-0000-000000000001') = ARRAY['PROCESSING', 'COMPLETED'];
  ASSERT (SELECT reserved = 0 AND used = 491500 FROM transfers.limit_usage
           WHERE sender_client_id = '10000000-0000-0000-0000-000000000001' AND period = 'DAY');
  RAISE NOTICE 'ok  TR-27 события только о смене статуса для клиента, TR-09 резерв перешёл в использованное';
END $$;

-- TR-08: второй перевод сверх дневного лимита (осталось 8 500 ₽) отклоняется
DO $$ BEGIN
  ASSERT transfers.reserve_limit('10000000-0000-0000-0000-000000000001', DATE '2026-10-19', 9000, 300000, 500000, 2000000) = 'DAY';
  ASSERT transfers.reserve_limit('10000000-0000-0000-0000-000000000001', DATE '2026-10-19', 400000, 300000, 500000, 2000000) = 'OPERATION';
  INSERT INTO transfers.transfer (id, sender_client_id, idempotency_key, request_hash, recipient_client_id,
         source_account_id, target_account_id, currency, amount, amount_rub, limit_day, limit_month, status, reject_reason)
  VALUES ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000002', 'h2', '20000000-0000-0000-0000-000000000002',
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
          'RUB', 9000, 9000, DATE '2026-10-19', DATE '2026-10-01', 'REJECTED', 'LIMIT_EXCEEDED');
  ASSERT NOT EXISTS (SELECT 1 FROM transfers.outbox_event WHERE transfer_id = '40000000-0000-0000-0000-000000000002');
  RAISE NOTICE 'ok  TR-08 лимит не превышается, отказ по лимиту без события';
END $$;

-- TR-11: тот же ключ идемпотентности у того же отправителя второй раз не принимается
DO $$ BEGIN
  BEGIN
    INSERT INTO transfers.transfer (id, sender_client_id, idempotency_key, request_hash, recipient_client_id,
           source_account_id, target_account_id, currency, amount, amount_rub, limit_day, limit_month, status)
    VALUES (gen_random_uuid(), '10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001',
            'h-other', '20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1',
            '00000000-0000-0000-0000-0000000000a2', 'RUB', 10, 10, DATE '2026-10-19', DATE '2026-10-01', 'NEW');
    RAISE EXCEPTION 'второй перевод с тем же ключом создан';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok  TR-11 ключ идемпотентности уникален в пределах отправителя';
  END;
END $$;

-- TR-34: пока действует аренда, повтор не берёт перевод в работу; после окончания — берёт
DO $$ BEGIN
  INSERT INTO transfers.transfer (id, sender_client_id, idempotency_key, request_hash, recipient_client_id,
         source_account_id, target_account_id, currency, amount, amount_rub, limit_day, limit_month, status, lease_until)
  VALUES ('40000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000004', 'h4', '20000000-0000-0000-0000-000000000002',
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
          'RUB', 100, 100, DATE '2026-10-19', DATE '2026-10-01', 'NEW', clock_timestamp() + interval '30 seconds');
  ASSERT NOT transfers.take_lease('40000000-0000-0000-0000-000000000004', interval '30 seconds'), 'аренда занята первым запросом';
  UPDATE transfers.transfer SET lease_until = clock_timestamp() - interval '1 second' WHERE id = '40000000-0000-0000-0000-000000000004';
  ASSERT transfers.take_lease('40000000-0000-0000-0000-000000000004', interval '30 seconds'), 'истёкшую аренду должен взять повтор';
  ASSERT NOT transfers.take_lease('40000000-0000-0000-0000-000000000004', interval '30 seconds'), 'второй повтор аренду не получает';
  RAISE NOTICE 'ok  TR-34 повтор продолжает обработку только после окончания аренды первого запроса';
END $$;

-- Статусная модель: из финального статуса переходов нет
DO $$ BEGIN
  BEGIN
    UPDATE transfers.transfer SET status = 'REVIEW', review_deadline = now() + interval '48 hours', completed_at = NULL
     WHERE id = '40000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'выполненный перевод вернулся на проверку';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'выполненный%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  финальный статус не меняется: %', SQLERRM;
  END;
END $$;

-- TR-23: отмена и одобрение одновременно — побеждает первое зафиксированное
DO $$
DECLARE n int;
BEGIN
  INSERT INTO transfers.transfer (id, sender_client_id, idempotency_key, request_hash, recipient_client_id,
         source_account_id, target_account_id, currency, amount, amount_rub, limit_day, limit_month, status)
  VALUES ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
          '50000000-0000-0000-0000-000000000003', 'h3', '20000000-0000-0000-0000-000000000002',
          '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
          'RUB', 500, 500, DATE '2026-10-19', DATE '2026-10-01', 'NEW');
  UPDATE transfers.transfer SET status = 'HELD' WHERE id = '40000000-0000-0000-0000-000000000003';
  UPDATE transfers.transfer SET status = 'CHECKING' WHERE id = '40000000-0000-0000-0000-000000000003';
  UPDATE transfers.transfer SET status = 'REVIEW', review_deadline = now() + interval '48 hours'
   WHERE id = '40000000-0000-0000-0000-000000000003';
  -- одобрение антифрода зафиксировано первым
  UPDATE transfers.transfer SET status = 'POSTING' WHERE id = '40000000-0000-0000-0000-000000000003' AND status = 'REVIEW';
  -- отмена отправителя — условное обновление, которое уже ничего не находит
  UPDATE transfers.transfer SET status = 'CANCELLED' WHERE id = '40000000-0000-0000-0000-000000000003' AND status = 'REVIEW';
  GET DIAGNOSTICS n = ROW_COUNT;
  ASSERT n = 0, 'отмена не должна была примениться';
  RAISE NOTICE 'ok  TR-23 отмена после одобрения не применяется, приложение получает текущий статус';
END $$;

-- Маппинг ответа ЦБ (cbr-dailyinfo.md): фрагмент реального ответа GetCursOnDateXML от 19.10.2026.
-- Обёртка в пространстве имён web.cbr.ru, сами курсы — без пространства имён (xmlns="")
DO $$
DECLARE
    resp xml := $x$<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetCursOnDateXMLResponse xmlns="http://web.cbr.ru/"><GetCursOnDateXMLResult><ValuteData OnDate="20261017" xmlns=""><ValuteCursOnDate><Vname>Алжирский динар                                                                                                                                                                                                                                                </Vname><Vnom>100</Vnom><Vcurs>62.2034</Vcurs><Vcode>12</Vcode><VchCode>DZD</VchCode><VunitRate>0.622034</VunitRate></ValuteCursOnDate><ValuteCursOnDate><Vname>Доллар США                                                                                                                                                                                                                                                     </Vname><Vnom>1</Vnom><Vcurs>83.6177</Vcurs><Vcode>840</Vcode><VchCode>USD</VchCode><VunitRate>83.6177</VunitRate></ValuteCursOnDate><ValuteCursOnDate><Vname>Евро                                                                                                                                                                                                                                                           </Vname><Vnom>1</Vnom><Vcurs>93.7187</Vcurs><Vcode>978</Vcode><VchCode>EUR</VchCode><VunitRate>93.7187</VunitRate></ValuteCursOnDate><ValuteCursOnDate><Vname>Иранский риал                                                                                                                                                                                                                                                  </Vname><Vnom>1000000</Vnom><Vcurs>46.3812</Vcurs><Vcode>364</Vcode><VchCode>IRR</VchCode><VunitRate>4.63812E-05</VunitRate></ValuteCursOnDate><ValuteCursOnDate><Vname>Юань                                                                                                                                                                                                                                                           </Vname><Vnom>1</Vnom><Vcurs>12.4950</Vcurs><Vcode>156</Vcode><VchCode>CNY</VchCode><VunitRate>12.495</VunitRate></ValuteCursOnDate></ValuteData></GetCursOnDateXMLResult></GetCursOnDateXMLResponse></soap:Body></soap:Envelope>$x$;
    ns   text[] := ARRAY[ARRAY['soap', 'http://schemas.xmlsoap.org/soap/envelope/'],
                         ARRAY['cbr',  'http://web.cbr.ru/']];
    base text := '/soap:Envelope/soap:Body/cbr:GetCursOnDateXMLResponse/cbr:GetCursOnDateXMLResult/ValuteData';
BEGIN
    INSERT INTO transfers.currency_rate (currency, rate_date, nominal, rate)
    SELECT (xpath('/ValuteCursOnDate/VchCode/text()', v))[1]::text,
           to_date((xpath(base || '/@OnDate', resp, ns))[1]::text, 'YYYYMMDD'),
           (xpath('/ValuteCursOnDate/Vnom/text()', v))[1]::text::int,
           (xpath('/ValuteCursOnDate/Vcurs/text()', v))[1]::text::numeric
      FROM unnest(xpath(base || '/ValuteCursOnDate', resp, ns)) AS v
     WHERE (xpath('/ValuteCursOnDate/VchCode/text()', v))[1]::text IN ('USD', 'EUR', 'CNY');
    ASSERT (SELECT count(*) FROM transfers.currency_rate WHERE rate_date = DATE '2026-10-17') = 3,
           'должны загрузиться ровно USD, EUR и CNY';
    ASSERT (SELECT rate FROM transfers.currency_rate WHERE currency = 'USD') = 83.6177;
    ASSERT (SELECT round(100 * unit_rate, 2) FROM transfers.currency_rate WHERE currency = 'USD') = 8361.77;
    RAISE NOTICE 'ok  ответ ЦБ разбирается: USD, EUR, CNY на 17.10.2026, 100 USD = 8361,77 ₽';
END $$;

\echo 'Все проверки пройдены'
