#!/usr/bin/env bash
# Гонка за лимит в двух параллельных сессиях (таблица отказов, строка 4; TR-08).
# Запуск после ddl.sql и ddl-checks.sql: DB=pt_check ./concurrency-check.sh
# Остаток дневного лимита — 8 500 ₽. Обе сессии хотят по 5 000 ₽. Сессия A держит транзакцию 2 с.
set -euo pipefail
DB="${DB:-pt_check}"
SENDER="10000000-0000-0000-0000-000000000001"
SQL="SELECT transfers.reserve_limit('$SENDER', DATE '2026-10-19', 5000, 300000, 500000, 2000000)"

psql -X -q -t -A -d "$DB" -c "BEGIN; $SQL; SELECT pg_sleep(2); COMMIT;" > /tmp/session_a.txt &
sleep 0.5
B_START=$(date +%s.%N)
B=$(psql -X -q -t -A -d "$DB" -c "$SQL")
B_WAIT=$(echo "$(date +%s.%N) - $B_START" | bc)
wait
A=$(head -1 /tmp/session_a.txt)

echo "Сессия A: $A"
echo "Сессия B: $B (ждала блокировку ${B_WAIT%.*} с)"
[ "$A" = "OK" ] && [ "$B" = "DAY" ] && echo "ok  параллельные переводы вместе не превысили лимит" || { echo "FAIL"; exit 1; }
