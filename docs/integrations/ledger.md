# Леджер

Внутренний сервис: счета, холды, проводки. Все изменяющие операции идемпотентны по `transferId`: повтор не создаёт вторую операцию и возвращает результат первой (TR-16). Поэтому таймаут при вызове леджера не опасен — запрос можно безопасно повторить.

Исполняемая спецификация операций — функции `ledger.place_hold`, `ledger.release_hold`, `ledger.post_transfer` в [`ddl.sql`](../design/ddl.sql), проверены [`ddl-checks.sql`](../design/ddl-checks.sql).

## Операции

| Операция | Запрос | Результаты | Повтор |
|---|---|---|---|
| `GET /internal/v1/accounts/{accountId}` | — | Владелец, валюта, статус, доступный остаток | чтение |
| `POST /internal/v1/holds` | transferId, accountId, currency, amount | HELD, ALREADY_ACTIVE, ALREADY_RELEASED, ALREADY_CAPTURED, INSUFFICIENT_FUNDS, ACCOUNT_UNAVAILABLE, CURRENCY_MISMATCH | безопасен |
| `POST /internal/v1/holds/{transferId}/release` | — | RELEASED, ALREADY_RELEASED, ALREADY_CAPTURED, NO_HOLD | безопасен |
| `POST /internal/v1/postings` | transferId, creditAccountId | POSTED, ALREADY_POSTED, HOLD_RELEASED, NO_HOLD, SOURCE_ACCOUNT_UNAVAILABLE, RECIPIENT_ACCOUNT_UNAVAILABLE | безопасен |

Снятие холда, которого ещё нет, закрывает transferId: ответ NO_HOLD, а холд по этому transferId, если он придёт позже, вернёт ALREADY_RELEASED и деньги не заблокирует. Так запоздавший холд не появляется у перевода, который уже закрыт как FAILED.
| `GET /internal/v1/operations/{transferId}` | — | Состояние холда и проводки по переводу | чтение |

Повтор холда с тем же transferId, но другой суммой или счётом — ошибка 409: это не повтор, а дефект вызывающей стороны, автоматически его не исправить.

## Результат операции → статус перевода

| Операция | Результат | Перевод | Приложение |
|---|---|---|---|
| Холд | HELD, ALREADY_ACTIVE | NEW → HELD | 201 PROCESSING |
| Холд | ALREADY_RELEASED | NEW → FAILED: операцию уже закрыли | 200 с переводом FAILED |
| Холд | ALREADY_CAPTURED | статус не меняется; если перевод в NEW — инцидент, такого сочетания быть не может | — |
| Холд | INSUFFICIENT_FUNDS | NEW → REJECTED | 422 INSUFFICIENT_FUNDS |
| Холд | ACCOUNT_UNAVAILABLE, CURRENCY_MISMATCH | NEW → REJECTED, причина SOURCE_ACCOUNT_UNAVAILABLE | 422 SOURCE_ACCOUNT_UNAVAILABLE |
| Холд | таймаут после повторов | остаётся NEW | 503, повтор с тем же ключом после окончания аренды P-14 продолжит обработку |
| Проводка | POSTED, ALREADY_POSTED | POSTING → COMPLETED | пуш «Выполнен» |
| Проводка | RECIPIENT_ACCOUNT_UNAVAILABLE, SOURCE_ACCOUNT_UNAVAILABLE | POSTING → REJECTED с той же причиной, холд снимается | пуш «Отклонён» |
| Проводка | HOLD_RELEASED, NO_HOLD | POSTING → FAILED и инцидент: холда нет, проводить нельзя, деньги не заблокированы | пуш «Не выполнен» |
| Проводка | таймаут после повторов | остаётся POSTING, повторы продолжаются | регламентная проверка (TR-30) |

Валюта и принадлежность счёта списания проверяются до создания перевода через `GET /accounts`. CURRENCY_MISMATCH и ACCOUNT_UNAVAILABLE на холде означают, что счёт изменился между проверкой и холдом.

## Блокировки и порядок

- Операции одного перевода выполняются по очереди: холд, снятие и проводка не обгоняют друг друга.
- Холд блокирует строку счёта списания: два перевода не потратят один остаток.
- Проводка блокирует холд и оба счёта в порядке `id`: проводки по одному счёту идут по очереди, встречные переводы не дают взаимоблокировку. Проверено нагрузочным тестом [`ledger-concurrency-check.sh`](../design/ledger-concurrency-check.sh).
- Подробно — [протокол блокировок](../design/data-model.md#протокол-блокировок).
