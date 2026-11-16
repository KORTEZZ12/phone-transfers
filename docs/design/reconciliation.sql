-- Ежедневная сверка (TR-31) и витрина для отчётности. PostgreSQL 16, запускается после ddl.sql.
-- В проде ledger и transfers — две базы двух сервисов: сверка читает их реплики в хранилище отчётности.
-- Здесь обе схемы в одной базе, поэтому запросы соединяют их напрямую. Описание — reconciliation.md.

CREATE SCHEMA reporting;

-- Сутки по Москве (NFR-12)
CREATE FUNCTION reporting.msk_day(ts timestamptz) RETURNS date LANGUAGE sql IMMUTABLE AS $$
    SELECT (ts AT TIME ZONE 'Europe/Moscow')::date
$$;

-- =====================================================================
-- СВЕРКА
-- =====================================================================

-- Проводка по переводу относится к дню, когда перевод выполнен, а не к дню проводки: леджер и сервис
-- переводов — разные базы, и проводка в 23:59:59 при COMPLETED в 00:00:00 иначе давала бы два ложных
-- расхождения подряд. Проводка без выполненного перевода относится к дню проводки.
--
-- severity: ERROR — инцидент операционному отделу (runbook), WARN — проверить на следующей сверке,
-- INFO — для журнала, действий не требует.
CREATE FUNCTION reporting.reconcile(p_day date)
RETURNS TABLE (severity text, check_type text, transfer_id uuid, account_id uuid, currency char(3),
               expected numeric, actual numeric, detail text)
LANGUAGE sql STABLE AS $$
WITH done AS (                                   -- выполненные за день переводы
    SELECT t.* FROM transfers.transfer t
     WHERE t.status = 'COMPLETED' AND reporting.msk_day(t.completed_at) = p_day
), tp AS (                                       -- проводки переводов
    SELECT p.* FROM ledger.posting p WHERE p.kind = 'TRANSFER'
), orphan AS (                                   -- проводки за день, у которых нет выполненного перевода
    SELECT tp.*, t.status AS transfer_status
      FROM tp LEFT JOIN transfers.transfer t ON t.id = tp.transfer_id
     WHERE reporting.msk_day(tp.posted_at) = p_day AND t.status IS DISTINCT FROM 'COMPLETED'
), day_postings AS (                             -- проводки, которые входят в итог дня
    SELECT tp.currency, tp.amount FROM tp JOIN done d ON d.id = tp.transfer_id
    UNION ALL
    SELECT o.currency, o.amount FROM orphan o WHERE o.transfer_status IS DISTINCT FROM 'POSTING'
)
-- 1. У выполненного перевода нет проводки
SELECT 'ERROR', 'COMPLETED_WITHOUT_POSTING', d.id, NULL::uuid, d.currency, d.amount, NULL::numeric,
       'Перевод выполнен, а проводки в леджере нет'
  FROM done d WHERE NOT EXISTS (SELECT 1 FROM tp WHERE tp.transfer_id = d.id)
UNION ALL
-- 2. Проводка не совпадает с переводом: сумма, валюта или счета
SELECT 'ERROR', 'POSTING_MISMATCH', d.id, NULL, d.currency, d.amount, tp.amount,
       format('Проводка %s: %s → %s, перевод: %s → %s', tp.id, tp.debit_account_id, tp.credit_account_id,
              d.source_account_id, d.target_account_id)
  FROM done d JOIN tp ON tp.transfer_id = d.id
 WHERE (tp.debit_account_id, tp.credit_account_id, tp.currency, tp.amount)
       IS DISTINCT FROM (d.source_account_id, d.target_account_id, d.currency, d.amount)
UNION ALL
-- 3. Проводка без выполненного перевода. Перевод в POSTING — ответ леджера ещё не обработан (отказ 8):
--    это не инцидент, перевод доведёт задача проводки
SELECT CASE WHEN o.transfer_status = 'POSTING' THEN 'WARN' ELSE 'ERROR' END,
       CASE WHEN o.transfer_status = 'POSTING' THEN 'POSTED_NOT_YET_COMPLETED' ELSE 'POSTING_WITHOUT_COMPLETED_TRANSFER' END,
       o.transfer_id, NULL, o.currency, NULL, o.amount,
       COALESCE('Статус перевода ' || o.transfer_status, 'Перевода с таким идентификатором нет')
  FROM orphan o
UNION ALL
-- 4. Итог дня: сумма проводок равна сумме выполненных переводов в каждой валюте
SELECT 'ERROR', 'DAY_TOTAL_MISMATCH', NULL, NULL, c.currency, c.transfers, c.postings,
       'Сумма проводок за день не равна сумме выполненных переводов'
  FROM (SELECT cur AS currency,
               COALESCE((SELECT sum(amount) FROM done WHERE done.currency = cur), 0) AS transfers,
               COALESCE((SELECT sum(amount) FROM day_postings dp WHERE dp.currency = cur), 0) AS postings
          FROM unnest(ARRAY['RUB', 'USD', 'EUR', 'CNY']::char(3)[]) AS cur) c
 WHERE c.transfers <> c.postings
UNION ALL
-- 5. Сторно за день: исправление ошибки, у каждого должна быть запись в журнале инцидентов
SELECT 'INFO', 'REVERSAL', p.transfer_id, NULL, p.currency, NULL, p.amount,
       format('Сторно проводки %s', p.reverses_posting_id)
  FROM ledger.posting p
 WHERE p.kind = 'REVERSAL' AND reporting.msk_day(p.posted_at) = p_day
UNION ALL
-- 6. Баланс — проекция проводок: совпадает с суммой проводок по счёту
SELECT 'ERROR', 'BALANCE_PROJECTION_MISMATCH', NULL, a.id, a.currency, s.total, a.balance,
       'Баланс счёта не равен сумме проводок'
  FROM ledger.account a
  CROSS JOIN LATERAL (
        SELECT COALESCE(sum(CASE WHEN p.credit_account_id = a.id THEN p.amount ELSE -p.amount END), 0) AS total
          FROM ledger.posting p WHERE a.id IN (p.debit_account_id, p.credit_account_id)) s
 WHERE s.total <> a.balance
UNION ALL
-- 7. Холд финального перевода не снят, и задачи снятия нет (TR-17): деньги клиента заблокированы зря
SELECT 'ERROR', 'HOLD_NOT_RELEASED', h.transfer_id, h.account_id, h.currency, NULL, h.amount,
       'Статус перевода ' || COALESCE(t.status, 'нет перевода') || ', холд активен, задачи снятия нет'
  FROM ledger.hold h LEFT JOIN transfers.transfer t ON t.id = h.transfer_id
 WHERE h.status = 'ACTIVE'
   AND (t.id IS NULL OR transfers.is_final(t.status))
   AND NOT EXISTS (SELECT 1 FROM transfers.task k
                    WHERE k.transfer_id = h.transfer_id AND k.kind = 'RELEASE_HOLD' AND k.done_at IS NULL)
UNION ALL
-- 8. Перевод после холда без активного холда: инвариант статусной модели
SELECT 'ERROR', 'ACTIVE_TRANSFER_WITHOUT_HOLD', t.id, t.source_account_id, t.currency, t.amount, NULL,
       'Статус ' || t.status || ', активного холда нет'
  FROM transfers.transfer t
 WHERE t.status IN ('HELD', 'CHECKING', 'REVIEW', 'SUSPENDED', 'COOLING', 'POSTING')
   AND NOT EXISTS (SELECT 1 FROM ledger.hold h WHERE h.transfer_id = t.id AND h.status = 'ACTIVE')
   AND NOT EXISTS (SELECT 1 FROM tp WHERE tp.transfer_id = t.id)   -- POSTING после проводки: холд уже списан
UNION ALL
-- 9. Выполненный перевод, у которого холд не списан
SELECT 'ERROR', 'COMPLETED_HOLD_NOT_CAPTURED', d.id, NULL, d.currency, d.amount, NULL,
       'Холд: ' || COALESCE(h.status, 'нет')
  FROM done d LEFT JOIN ledger.hold h ON h.transfer_id = d.id
 WHERE h.status IS DISTINCT FROM 'CAPTURED'
$$;

-- Итог сверки за день: одна строка для отчёта и алерта «Расхождение сверки» (NFR-08)
CREATE FUNCTION reporting.reconciliation_summary(p_day date)
RETURNS TABLE (day date, ok boolean, errors bigint, warnings bigint, completed_transfers bigint, totals jsonb)
LANGUAGE sql STABLE AS $$
SELECT p_day,
       count(*) FILTER (WHERE r.severity = 'ERROR') = 0,
       count(*) FILTER (WHERE r.severity = 'ERROR'),
       count(*) FILTER (WHERE r.severity = 'WARN'),
       (SELECT count(*) FROM transfers.transfer t
         WHERE t.status = 'COMPLETED' AND reporting.msk_day(t.completed_at) = p_day),
       (SELECT COALESCE(jsonb_object_agg(currency, total), '{}'::jsonb) FROM (
            SELECT t.currency, sum(t.amount) AS total FROM transfers.transfer t
             WHERE t.status = 'COMPLETED' AND reporting.msk_day(t.completed_at) = p_day
             GROUP BY t.currency) x)
  FROM (SELECT 1) one LEFT JOIN reporting.reconcile(p_day) r ON true
$$;

-- =====================================================================
-- ВИТРИНА ДЛЯ ОТЧЁТНОСТИ
-- =====================================================================

-- Один перевод — одна строка с признаками для отчётов. История статусов берётся из outbox:
-- событие пишется в той же транзакции, что и статус, поэтому outbox — полный журнал видимых клиенту статусов
CREATE VIEW reporting.transfer_facts AS
SELECT t.id,
       t.sender_client_id,
       t.recipient_client_id,
       reporting.msk_day(t.created_at) AS day,
       t.currency,
       t.amount,
       t.amount_rub,
       t.status,
       transfers.client_status(t.status) AS client_status,
       t.reject_reason,
       -- принят к исполнению: сумма была заблокирована, первое событие — при холде (TR-27)
       EXISTS (SELECT 1 FROM transfers.outbox_event e WHERE e.transfer_id = t.id) AS accepted,
       -- отклонён синхронно: лимит, остаток или счёт до холда, клиент получил 422 и событий нет.
       -- Перевод, который регламентная проверка закрыла из NEW, тоже без событий, но это не синхронный отказ,
       -- а самый зависший перевод: из метрик «не висят» он не исключается
       (t.status = 'REJECTED' AND NOT EXISTS (SELECT 1 FROM transfers.outbox_event e WHERE e.transfer_id = t.id)) AS sync_rejected,
       -- ждал человека: сотрудника на ручной проверке или клиента по 161-ФЗ. Таймаут антифрода сюда не входит
       (EXISTS (SELECT 1 FROM transfers.antifraud_check c
                 WHERE c.transfer_id = t.id AND (c.outcome IN ('REVIEW', 'SUSPEND') OR c.decision_id IS NOT NULL))
        OR t.confirmation_deadline IS NOT NULL) AS waited_for_human,
       EXISTS (SELECT 1 FROM transfers.antifraud_check c WHERE c.transfer_id = t.id AND c.outcome = 'TIMEOUT') AS antifraud_timeout,
       t.confirmation_deadline IS NOT NULL AS suspended_161fz,
       t.execute_after IS NOT NULL AS delayed_161fz,
       t.created_at,
       fin.finished_at,
       EXTRACT(EPOCH FROM fin.finished_at - t.created_at) AS seconds_to_final
  FROM transfers.transfer t
  LEFT JOIN LATERAL (
        SELECT COALESCE(
                 (SELECT (e.payload ->> 'occurredAt')::timestamptz FROM transfers.outbox_event e
                   WHERE e.transfer_id = t.id AND (e.payload ->> 'isFinal')::boolean ORDER BY e.seq LIMIT 1),
                 CASE WHEN transfers.is_final(t.status) THEN t.updated_at END) AS finished_at) fin ON true;

-- Переводы по дням и валютам
CREATE VIEW reporting.transfer_daily AS
SELECT day,
       currency,
       count(*)                                                              AS requests,
       count(*) FILTER (WHERE accepted)                                      AS accepted,
       count(*) FILTER (WHERE status = 'COMPLETED')                          AS completed,
       count(*) FILTER (WHERE status = 'REJECTED' AND NOT accepted)          AS rejected_sync,
       count(*) FILTER (WHERE status = 'REJECTED' AND accepted)              AS rejected_async,
       count(*) FILTER (WHERE status = 'CANCELLED')                          AS cancelled,
       count(*) FILTER (WHERE status = 'FAILED')                             AS failed,
       count(*) FILTER (WHERE NOT transfers.is_final(status))                AS in_progress,
       COALESCE(sum(amount) FILTER (WHERE status = 'COMPLETED'), 0)          AS completed_amount,
       COALESCE(sum(amount_rub) FILTER (WHERE status = 'COMPLETED'), 0)      AS completed_amount_rub,
       count(*) FILTER (WHERE waited_for_human)                              AS waited_for_human,
       count(*) FILTER (WHERE suspended_161fz)                               AS suspended_161fz,
       count(*) FILTER (WHERE antifraud_timeout)                             AS antifraud_timeout,
       -- NFR-02, серверная часть: от создания до финального события, переводы без ожидания человека
       percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds_to_final)
           FILTER (WHERE NOT sync_rejected AND NOT waited_for_human AND finished_at IS NOT NULL) AS p95_seconds_to_final
  FROM reporting.transfer_facts
 GROUP BY day, currency;

-- Причины отказов по дням: синхронные — ответом 422, асинхронные — статусом REJECTED
CREATE VIEW reporting.reject_reasons_daily AS
SELECT day, reject_reason, CASE WHEN accepted THEN 'ASYNC' ELSE 'SYNC' END AS kind, count(*) AS transfers,
       sum(amount_rub) AS amount_rub
  FROM reporting.transfer_facts
 WHERE status = 'REJECTED'
 GROUP BY day, reject_reason, accepted;

-- Метрики из видения за период: значение, цель, выполнена ли
CREATE FUNCTION reporting.vision_metrics(p_from date, p_to date)
RETURNS TABLE (metric text, value numeric, target text, ok boolean)
LANGUAGE sql STABLE AS $$
WITH f AS (
    SELECT * FROM reporting.transfer_facts WHERE day BETWEEN p_from AND p_to
), no_human AS (
    SELECT * FROM f WHERE NOT sync_rejected AND NOT waited_for_human
)
-- Двух списаний по одному переводу и двух переводов по одному ключу не бывает по построению:
-- UNIQUE (transfer_id, kind) у проводок и UNIQUE (sender_client_id, idempotency_key) у переводов.
-- Строка остаётся как проверка ограничений, а не как измерение
SELECT 'Переводов с двумя списаниями по одному ключу (0 по построению: ограничения UNIQUE)', count(*)::numeric, '0', count(*) = 0
  FROM (SELECT p.transfer_id FROM ledger.posting p WHERE p.kind = 'TRANSFER'
          AND p.transfer_id IN (SELECT id FROM f) GROUP BY p.transfer_id HAVING count(*) > 1) x
UNION ALL
-- Реальный двойной перевод — приложение создало новый ключ на повторное нажатие — ключом не ловится.
-- Сигнал: тот же отправитель, получатель, сумма и валюта, разные ключи, оба выполнены, между созданием меньше минуты.
-- Законные повторные переводы бывают, поэтому цели нет: значение разбирают вместе с телеметрией приложения
SELECT 'Подозрений на двойной перевод от приложения: разные ключи, те же данные, меньше минуты', count(*)::numeric, 'сигнал, без цели', NULL::boolean
  FROM f a JOIN f b
    ON a.sender_client_id = b.sender_client_id AND a.recipient_client_id = b.recipient_client_id
   AND a.currency = b.currency AND a.amount = b.amount AND a.id < b.id
   AND a.status = 'COMPLETED' AND b.status = 'COMPLETED'
   AND abs(EXTRACT(EPOCH FROM b.created_at - a.created_at)) < 60
UNION ALL
SELECT 'Переводов в промежуточном статусе без открытой задачи', count(*)::numeric, '0', count(*) = 0
  FROM f
 WHERE f.status IN ('HELD', 'CHECKING', 'POSTING')
   AND NOT EXISTS (SELECT 1 FROM transfers.task k WHERE k.transfer_id = f.id AND k.done_at IS NULL)
UNION ALL
-- Незавершённый перевод старше P-12 считается невыполнением: иначе зависшие улучшали бы метрику
SELECT 'Доля переводов без ожидания человека, завершённых за P-12, %',
       round(100.0 * count(*) FILTER (WHERE seconds_to_final <= 300) / NULLIF(count(*), 0), 3),
       'не меньше 99,9',
       COALESCE(100.0 * count(*) FILTER (WHERE seconds_to_final <= 300) / NULLIF(count(*), 0) >= 99.9, true)
  FROM no_human
 WHERE finished_at IS NOT NULL OR created_at < now() - interval '5 minutes'
UNION ALL
SELECT 'Расхождений ежедневной сверки', count(*)::numeric, '0', count(*) = 0
  FROM generate_series(p_from, p_to, interval '1 day') d
  CROSS JOIN LATERAL reporting.reconcile(d::date) r
 WHERE r.severity = 'ERROR'
UNION ALL
SELECT 'p95 от создания до финального события, с (NFR-02, сервер)',
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds_to_final)::numeric, 3),
       'не больше 2,5',
       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds_to_final) <= 2.5, true)
  FROM no_human WHERE finished_at IS NOT NULL
$$;
