# Sequence-диаграммы

Версия 0.2. Каждая диаграмма разбирает строки [таблицы отказов](failure-modes.md). Вызовы и коды ответов совпадают с [OpenAPI](../api/openapi.yaml), события — с [AsyncAPI](../api/asyncapi.yaml), операции леджера — с [контрактом леджера](../integrations/ledger.md).

| Диаграмма | Строки таблицы отказов |
|---|---|
| [SD-1. Успешный перевод](#sd-1-успешный-перевод) | 10 |
| [SD-2. Повторы и потерянный ответ](#sd-2-повторы-и-потерянный-ответ) | 1, 2, 3 |
| [SD-3. Гонка за лимит](#sd-3-гонка-за-лимит) | 4 |
| [SD-4. Антифрод, ручная проверка, отмена](#sd-4-антифрод-ручная-проверка-отмена) | 5, 6, 7 |
| [SD-5. Неизвестный исход проводки](#sd-5-неизвестный-исход-проводки) | 8, 9, 15 |
| [SD-6. События: сбой, дубль, перестановка, DLQ](#sd-6-события-сбой-дубль-перестановка-dlq) | 11, 12, 13, 14 |

Строки 16 и 17 — ограничение частоты поиска и недоступность ЦБ — описаны в [OpenAPI](../api/openapi.yaml) и [интеграции с ЦБ](../integrations/cbr-dailyinfo.md).

## SD-1. Успешный перевод

Перевод идёт по токену из поиска, а не по номеру, поэтому смена владельца номера между поиском и подтверждением ничего не ломает.

```mermaid
sequenceDiagram
  autonumber
  participant App as Приложение
  participant TS as Сервис переводов
  participant DIR as Справочник клиентов
  participant L as Леджер
  participant AF as Антифрод
  participant K as Kafka
  App->>TS: POST /v1/recipients/lookup, номер в теле
  TS->>DIR: найти клиента по номеру
  DIR-->>TS: клиент, основные счета
  TS-->>App: 200, токен получателя, «Иван П.», валюты
  App->>TS: POST /v1/transfers, Idempotency-Key, токен
  Note over TS: одна транзакция: резерв лимита и перевод NEW
  TS->>L: холд по transferId
  L-->>TS: HELD
  Note over TS: HELD и событие PROCESSING в outbox
  TS-->>App: 201, статус PROCESSING
  TS->>AF: проверить перевод, таймаут 2 с
  AF-->>TS: ALLOW
  TS->>L: провести перевод по transferId
  L-->>TS: POSTED
  Note over TS: COMPLETED и событие в outbox, резерв лимита стал использованным
  TS-)K: TransferStatusChanged COMPLETED через relay
  App->>TS: GET /v1/transfers/{id}
  TS-->>App: 200, статус COMPLETED
```

## SD-2. Повторы и потерянный ответ

Ключ идемпотентности создаёт приложение, поэтому сервис отличает повтор от нового перевода. Ключ проверяется первым: повтору не мешают ни истёкший токен получателя, ни изменившийся лимит. Сравнение с параметрами первого запроса отличает честный повтор от ошибки приложения, которое переиспользовало ключ.

```mermaid
sequenceDiagram
  autonumber
  participant App as Приложение
  participant TS as Сервис переводов
  participant DB as База переводов
  par двойное нажатие
    App->>TS: POST /v1/transfers, ключ K1
  and
    App->>TS: POST /v1/transfers, ключ K1
  end
  TS->>DB: создать перевод K1: NEW, резерв лимита и аренда атомарно
  DB-->>TS: создан, аренда до +30 с
  TS->>DB: создать перевод K1
  DB-->>TS: K1 уже есть, аренда действует
  TS-->>App: 409 IDEMPOTENCY_KEY_IN_PROGRESS, Retry-After 1
  TS--xApp: 201 PROCESSING, ответ потерялся в сети
  App->>TS: POST /v1/transfers, ключ K1, повтор через 15 мин
  TS->>DB: найти перевод K1 и параметры первого запроса
  DB-->>TS: найден, параметры совпали
  TS-->>App: 200, Idempotent-Replayed true, актуальный статус
  Note over App,TS: токен получателя к этому времени истёк, повтору это не мешает
  App->>TS: POST /v1/transfers, ключ K1, другая сумма
  TS->>DB: найти перевод K1 и параметры первого запроса
  DB-->>TS: найден, параметры не совпали
  TS-->>App: 422 IDEMPOTENCY_KEY_REUSED, existingTransferId
  Note over App: приложение показывает существующий перевод и ничего не переотправляет
```

Если первый запрос упал до холда, перевод остаётся в NEW. Пока действует аренда P-14, повтор получает 409; после — берёт аренду и продолжает обработку с того же места, холд идемпотентен по transferId. Перевод, который провёл в NEW дольше P-12, закрывает регламентная проверка (TR-30).

## SD-3. Гонка за лимит

Проверено на PostgreSQL двумя параллельными сессиями: [`concurrency-check.sh`](concurrency-check.sh).

```mermaid
sequenceDiagram
  autonumber
  participant A as Запрос A, 5 000 ₽
  participant B as Запрос B, 5 000 ₽
  participant DB as База переводов
  Note over DB: до дневного лимита осталось 8 500 ₽
  A->>DB: резерв лимита, блокирует строки DAY и MONTH
  B->>DB: резерв лимита, ждёт блокировку
  DB-->>A: OK, зарезервировано 5 000 ₽
  A->>DB: COMMIT
  DB-->>B: DAY, вместе с A получается больше лимита
  B-->>B: 422 LIMIT_EXCEEDED, доступно 3 500 ₽
```

## SD-4. Антифрод, ручная проверка, отмена

```mermaid
sequenceDiagram
  autonumber
  participant App as Приложение
  participant TS as Сервис переводов
  participant AF as Антифрод
  participant L as Леджер
  TS->>AF: проверить перевод
  Note over TS,AF: ответа нет 2 с
  TS->>TS: REVIEW, срок проверки 48 ч, событие ON_REVIEW
  loop каждые 5 мин, пока антифрод недоступен
    TS->>AF: проверить перевод повторно
  end
  AF-->>TS: REVIEW, нужна ручная проверка
  alt сотрудник одобрил первым
    AF->>TS: POST /internal/v1/antifraud/decisions, ALLOW
    TS->>TS: условный переход из REVIEW в POSTING
    TS-->>AF: 200, applied true
    App->>TS: POST /v1/transfers/{id}/cancel
    TS->>TS: условный переход из REVIEW, обновлено 0 строк
    TS-->>App: 409 TRANSFER_NOT_CANCELLABLE, currentStatus PROCESSING
    TS->>L: провести перевод
  else отправитель отменил первым
    App->>TS: POST /v1/transfers/{id}/cancel
    TS->>TS: REVIEW в CANCELLED, лимит освобождён
    TS->>L: снять холд
    TS-->>App: 200, статус CANCELLED
    AF->>TS: POST /internal/v1/antifraud/decisions, ALLOW
    TS-->>AF: 200, applied false, transferStatus CANCELLED
  else решения нет 48 ч
    TS->>TS: REVIEW в REJECTED, причина REVIEW_EXPIRED
    TS->>L: снять холд
  end
```

## SD-5. Неизвестный исход проводки

Таймаут не значит «не проведено». Повтор с тем же transferId безопасен, потому что леджер идемпотентен.

```mermaid
sequenceDiagram
  autonumber
  participant TS as Сервис переводов
  participant L as Леджер
  participant J as Регламентная проверка
  TS->>L: провести перевод по transferId
  L--xTS: таймаут, исход неизвестен
  TS->>L: провести перевод, тот же transferId
  alt проводка уже была
    L-->>TS: ALREADY_POSTED
    TS->>TS: COMPLETED
  else проводки не было
    L-->>TS: POSTED
    TS->>TS: COMPLETED
  else счёт получателя закрыли
    L-->>TS: RECIPIENT_ACCOUNT_UNAVAILABLE
    TS->>L: снять холд
    TS->>TS: REJECTED, причина RECIPIENT_ACCOUNT_UNAVAILABLE
  end
  Note over TS,J: если леджер недоступен дольше P-12
  J->>TS: переводы в POSTING дольше 5 мин
  J->>L: состояние операций по transferId
  L-->>J: холд ACTIVE, проводки нет
  J->>L: провести перевод, повтор безопасен
  J->>J: алерт операционному отделу
  Note over J,L: раз в 15 мин холды без активного перевода снимаются, заводится инцидент
```

## SD-6. События: сбой, дубль, перестановка, DLQ

Гарантия Kafka — «хотя бы один раз», поэтому дубли и повторы — норма, а не авария. Порядок событий одного перевода держит ключ transferId, а от перестановки при повторах relay защищает transferVersion.

```mermaid
sequenceDiagram
  autonumber
  participant TS as Сервис переводов
  participant OB as Outbox
  participant R as Relay
  participant K as Kafka
  participant N as Уведомления
  participant H as История операций
  TS->>OB: статус COMPLETED и событие в одной транзакции
  Note over TS: сервис упал сразу после коммита
  R->>OB: выбрать неопубликованные события
  R->>K: TransferStatusChanged, ключ transferId
  K--xR: подтверждение потерялось
  R->>K: то же событие повторно
  R->>OB: отметить опубликованным
  K->>N: событие E1
  K->>N: событие E1, дубль
  N->>N: E1 уже обработано, второй пуш не отправляется
  K->>H: COMPLETED, transferVersion 5
  K->>H: ON_REVIEW, transferVersion 3, пришло после повтора relay
  H->>H: версия 3 меньше сохранённой 5, событие не применяется
  N->>N: пуш не отправился 3 раза
  N->>K: событие в топик повторов уведомлений
  N->>K: повторы исчерпаны, событие в DLQ, алерт
```
