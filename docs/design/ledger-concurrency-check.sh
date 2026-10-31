#!/usr/bin/env bash
# Параллельные операции леджера: взаимоблокировок быть не должно.
# Запуск на чистой базе после ddl.sql: DB=pt_conc ./ledger-concurrency-check.sh
#   1. 30 одновременных проводок одному получателю (сбор денег на подарок)
#   2. 20 пар встречных проводок A→B и B→A
#   3. 20 проводок и 20 новых холдов по тем же счетам отправителей одновременно
# Сценарии идут по очереди, в каждом не больше 40 соединений: по умолчанию в PostgreSQL
# max_connections = 100, и 110 соединений разом упирались в лимит, а не в блокировки.
# До версии 0.3 сценарии 1 и 2 давали deadlock detected: FOR UPDATE в apply_posting
# конфликтовал с FOR KEY SHARE, которую берут внешние ключи проводки.
set -uo pipefail
DB="${DB:-pt_conc}"
N1=30; N2=20; N3=20
WORK=$(mktemp -d)
q() { psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" "$@"; }
id() { echo "md5('$1')::uuid"; }   # детерминированный uuid из строки

q >/dev/null <<SQL
INSERT INTO ledger.account (id, client_id, type, currency, is_primary, status)
VALUES ($(id bank), NULL, 'BANK_TECHNICAL', 'RUB', false, 'OPEN'),
       ($(id rcpt), $(id rcpt-client), 'CLIENT_CURRENT', 'RUB', true, 'OPEN');
-- сценарий 1: отправители s1-*; сценарий 2: пары a2-*, b2-*; сценарий 3: отправители s3-*
INSERT INTO ledger.account (id, client_id, type, currency, is_primary, status)
SELECT md5(p || g)::uuid, md5(p || g || '-client')::uuid, 'CLIENT_CURRENT', 'RUB', true, 'OPEN'
  FROM unnest(ARRAY['s1-', 'a2-', 'b2-', 's3-']) p, generate_series(1, $N1) g;
INSERT INTO ledger.posting (kind, debit_account_id, credit_account_id, currency, amount)
SELECT 'OTHER', $(id bank), md5(p || g)::uuid, 'RUB', 10000
  FROM unnest(ARRAY['s1-', 'a2-', 'b2-', 's3-']) p, generate_series(1, $N1) g;
SELECT count(*) FROM (
  SELECT ledger.place_hold(md5('t1-' || g)::uuid, md5('s1-' || g)::uuid, 'RUB', 100) FROM generate_series(1, $N1) g
  UNION ALL SELECT ledger.place_hold(md5('t2a-' || g)::uuid, md5('a2-' || g)::uuid, 'RUB', 100) FROM generate_series(1, $N2) g
  UNION ALL SELECT ledger.place_hold(md5('t2b-' || g)::uuid, md5('b2-' || g)::uuid, 'RUB', 100) FROM generate_series(1, $N2) g
  UNION ALL SELECT ledger.place_hold(md5('t3-' || g)::uuid, md5('s3-' || g)::uuid, 'RUB', 100) FROM generate_series(1, $N3) g
) s;
SQL

# Пачка сессий: строки «имя SQL» на входе, все сессии стартуют одновременно через 5 с
batch() {
  local start name sql
  start=$(q -c "SELECT (clock_timestamp() + interval '5 seconds')::text")
  while read -r name sql; do
    ( q -c "SELECT pg_sleep_until('$start')" -c "$sql" > "$WORK/$name.txt" 2>&1 ) &
  done
  wait
}

for i in $(seq 1 $N1); do echo "s1-$i SELECT ledger.post_transfer($(id t1-$i), $(id rcpt))"; done | batch
for i in $(seq 1 $N2); do
  echo "s2a-$i SELECT ledger.post_transfer($(id t2a-$i), $(id b2-$i))"
  echo "s2b-$i SELECT ledger.post_transfer($(id t2b-$i), $(id a2-$i))"
done | batch
for i in $(seq 1 $N3); do
  echo "s3p-$i SELECT ledger.post_transfer($(id t3-$i), $(id rcpt))"
  echo "s3h-$i SELECT ledger.place_hold($(id t3new-$i), $(id s3-$i), 'RUB', 100)"
done | batch

deadlocks=$(grep -l 'deadlock detected' "$WORK"/*.txt | wc -l)
posted=$(grep -lx 'POSTED' "$WORK"/*.txt | wc -l)
held=$(grep -lx 'HELD' "$WORK"/*.txt | wc -l)
expected_posted=$((N1 + 2 * N2 + N3))
balance=$(q -c "SELECT balance FROM ledger.account WHERE id = $(id rcpt)")
echo "проводок POSTED: $posted из $expected_posted, новых холдов: $held из $N3, deadlock: $deadlocks"
echo "баланс получателя: $balance (ожидается $(( (N1 + N3) * 100 )).00)"
errors=$(grep -h -E 'ERROR|FATAL' "$WORK"/*.txt | sed 's/^psql:[^ ]* //' | sort | uniq -c)
[ -n "$errors" ] && { echo "ошибки сессий:"; echo "$errors"; }
rm -rf "$WORK"
if [ "$deadlocks" -eq 0 ] && [ "$posted" -eq "$expected_posted" ] && [ "$held" -eq "$N3" ] && [ "$balance" = "$(( (N1 + N3) * 100 )).00" ]; then
  echo "ok  параллельные операции леджера без взаимоблокировок"
else
  echo "FAIL"; exit 1
fi
