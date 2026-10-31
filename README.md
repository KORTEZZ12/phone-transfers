# Переводы по номеру телефона

[![checks](https://github.com/KORTEZZ12/phone-transfers/actions/workflows/checks.yml/badge.svg)](https://github.com/KORTEZZ12/phone-transfers/actions/workflows/checks.yml)
[![API](https://img.shields.io/badge/API-документация-blue)](https://kortezz12.github.io/phone-transfers/api/)

Системный анализ перевода между клиентами банка по номеру телефона. Здесь требования, контракты и модель данных, а ещё проверки, которые CI гоняет на каждый PR. Главный вопрос проекта: что будет с деньгами, когда что-то пошло не так? Двойное нажатие. Потерянный ответ. Антифрод, который лежит полчаса в час пик. Тридцать переводов одному человеку в одну секунду.

Проект учебный, банк вымышленный. Как я организовал работу, рассказываю в [docs/00-process.md](docs/00-process.md).

**Стек артефактов:** REST и OpenAPI 3.1 · Kafka и AsyncAPI 3.1 · SOAP · PostgreSQL и SQL · UML: sequence и state · BPMN 2.0 · ER · ADR · Gherkin · GitHub Actions

## Если есть 5 минут

1. [Таблица отказов](docs/design/failure-modes.md): 30 сценариев. В каждом видно, что сломалось, что делает система и что видит клиент.
2. [SD-2](docs/design/sequences.md#sd-2-повторы-и-потерянный-ответ) и [SD-5](docs/design/sequences.md#sd-5-неизвестный-исход-проводки): потерянный ответ и неизвестный исход проводки.
3. [ADR-001](docs/decisions/adr/ADR-001-sync-until-hold.md): почему клиент ждёт ответа только до блокировки суммы.
4. [Ревью](docs/reviews/README.md): две независимые проверки нашли 21 проблему, каждую я завёл issue и закрыл PR.

Так перевод проходит статусы внутри сервиса:

```mermaid
stateDiagram-v2
  [*] --> NEW: запрос на перевод
  [*] --> REJECTED: лимит превышен
  NEW --> HELD: средства заблокированы
  NEW --> REJECTED: нет средств
  NEW --> FAILED: дольше P-12, операция закрыта
  HELD --> CHECKING: запрос в антифрод
  CHECKING --> POSTING: разрешено
  CHECKING --> REJECTED: отклонено
  CHECKING --> REVIEW: ручная проверка или нет ответа
  REVIEW --> POSTING: разрешено
  REVIEW --> REJECTED: отклонено или истёк срок
  REVIEW --> CANCELLED: отмена отправителем
  CHECKING --> SUSPENDED: признаки перевода без согласия, 161-ФЗ
  REVIEW --> SUSPENDED: сотрудник нашёл признаки
  SUSPENDED --> CHECKING: клиент подтвердил
  SUSPENDED --> REJECTED: не подтверждён к сроку
  SUSPENDED --> CANCELLED: отмена отправителем
  CHECKING --> COOLING: после подтверждения есть сведения из базы ЦБ
  COOLING --> POSTING: прошло 2 дня
  COOLING --> CANCELLED: отмена отправителем
  POSTING --> COMPLETED: проводка выполнена
  POSTING --> REJECTED: счёт получателя или отправителя недоступен
  POSTING --> FAILED: холда нет
  COMPLETED --> [*]
  REJECTED --> [*]
  CANCELLED --> [*]
  FAILED --> [*]
```

## Что показывает проект

| Что умею | Где видно |
|---|---|
| Писать требования, которые можно проверить | [Бизнес-правила](docs/requirements/business-rules.md) с параметрами вместо чисел в тексте, [НФТ](docs/requirements/nfr.md) с точкой измерения, [истории](docs/requirements/user-stories.md) с критериями на Gherkin, [трассировка](docs/requirements/business-rules.md#трассировка-правило--проверка) каждого правила до проверки |
| Проектировать интеграции | [OpenAPI](docs/api/openapi.yaml), где у каждого кода ошибки есть реакция приложения; [AsyncAPI](docs/api/asyncapi.yaml); SOAP ЦБ, [сверенный живым вызовом](docs/integrations/cbr-dailyinfo.md) |
| Закладывать надёжность | Идемпотентность, outbox, задачи продолжения в той же транзакции, что и статус; [гонки проверены нагрузочным тестом](docs/design/ledger-concurrency-check.sh) |
| Работать с данными | [Модель данных](docs/design/data-model.md): правила держит база, а не текст; 22 проверки на PostgreSQL 16 |
| Описывать процессы с людьми | [BPMN процесса по 161-ФЗ](docs/design/bpmn/README.md), [runbook](docs/operations/runbook.md) операционного отдела, [состояния экрана](docs/design/client-states.md) |
| Принимать и объяснять решения | [Журнал решений](docs/decisions/decision-log.md) и шесть [ADR](docs/decisions/adr) с отвергнутыми вариантами |
| Работать с замечаниями | [Отчёты ревью](docs/reviews/README.md), issues и PR по каждой находке |

## Как проверить самому

```bash
cd docs/design
createdb pt_check && psql -v ON_ERROR_STOP=1 -d pt_check -f ddl.sql -f ddl-checks.sql
DB=pt_check ./concurrency-check.sh
createdb pt_conc && psql -d pt_conc -f ddl.sql && DB=pt_conc ./ledger-concurrency-check.sh
```

Это и проверку контрактов CI запускает на каждый PR: [checks.yml](.github/workflows/checks.yml).

## Кто что делал

Предметную область, правила продукта и решения выбирал я: они в [журнале решений](docs/decisions/decision-log.md) вместе с причинами и отвергнутыми вариантами. ИИ (Claude) писал черновики по моим вводным и делал независимое ревью. Находки ревью заведены в issues, исправления прошли через PR.

## Карта артефактов

| Артефакт | Где | Версия |
|---|---|---|
| Как устроена работа, ретро | [docs/00-process.md](docs/00-process.md) | 0.3 |
| Видение, метрики, границы | [docs/requirements/vision.md](docs/requirements/vision.md) | 0.3 |
| Бизнес-правила, параметры, пуши, трассировка | [docs/requirements/business-rules.md](docs/requirements/business-rules.md) | 0.3 |
| Пользовательские истории | [docs/requirements/user-stories.md](docs/requirements/user-stories.md) | 0.3 |
| Нефункциональные требования | [docs/requirements/nfr.md](docs/requirements/nfr.md) | 0.3 |
| Глоссарий | [docs/requirements/glossary.md](docs/requirements/glossary.md) | 0.3 |
| Статусная модель, задачи продолжения | [docs/design/transfer-states.md](docs/design/transfer-states.md) | 0.3 |
| Таблица отказов | [docs/design/failure-modes.md](docs/design/failure-modes.md) | 0.3 |
| Sequence-диаграммы | [docs/design/sequences.md](docs/design/sequences.md) | 0.3 |
| BPMN | [docs/design/bpmn](docs/design/bpmn/README.md) | 0.3 |
| Состояния экрана | [docs/design/client-states.md](docs/design/client-states.md) | 0.3 |
| Модель данных, DDL, проверки | [docs/design/data-model.md](docs/design/data-model.md) | 0.3 |
| OpenAPI, AsyncAPI, соглашения | [docs/api](docs/api/README.md) | 0.3 |
| Интеграции: справочник, леджер, антифрод, ЦБ | [docs/integrations](docs/integrations/README.md) | 0.3 |
| Runbook | [docs/operations/runbook.md](docs/operations/runbook.md) | 0.3 |
| ADR и журнал решений | [docs/decisions](docs/decisions/decision-log.md) | 0.3 |
| Отчёты ревью | [docs/reviews](docs/reviews/README.md) | 0.3 |
| Mock, Postman, SQL сверки | — | итерация 3 |

## Статус

Версия 0.3. Готовы итерации 1, 2 и 4: требования, контракты, модель данных, интеграции, ревью и исправления по нему. Дальше итерация 3: поднять mock-сервер, написать тесты Postman по таблице отказов и историям, собрать SQL сверки. [CHANGELOG](CHANGELOG.md).
