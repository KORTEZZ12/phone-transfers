# Переводы по номеру телефона

Системный анализ перевода между клиентами банка по номеру телефона. Главный фокус — сбои: двойное нажатие, потерянный ответ, недоступный антифрод, дубли и перестановки событий.

Учебный проект: банк и продукт вымышленные, правила продукта — мои решения. Роли заказчика, ревьюеров, разработчика и QA выполняют ИИ-агенты, решения и приёмка — мои. Подробнее — [как устроена работа](docs/00-process.md).

**Статус:** итерации 1 и 2 из 4 — требования, контракты, sequence, модель данных, интеграции, ADR. Следующий шаг — независимое ревью `/sar` и `/sar-crosscheck`. Изменения — в [CHANGELOG](CHANGELOG.md).

## Что проверено инструментами

- OpenAPI 3.1 проходит Redocly lint без ошибок и предупреждений, примеры соответствуют схемам, HTML-документация собирается.
- AsyncAPI 3.1 проходит официальный парсер без замечаний.
- DDL выполняется на PostgreSQL 16, 14 проверок правил проходят, гонка за лимит проверена двумя параллельными сессиями.
- Все диаграммы Mermaid проходят парсер Mermaid.
- SOAP-запрос к ЦБ взят со страницы сервиса, команда для живого вызова — в [описании интеграции](docs/integrations/cbr-dailyinfo.md).

Документация API в браузере: [kortezz12.github.io/phone-transfers/api](https://kortezz12.github.io/phone-transfers/api/).

## Карта артефактов

| Артефакт | Где | Статус |
|---|---|---|
| Как устроена работа | [docs/00-process.md](docs/00-process.md) | v0.1 |
| Видение и границы | [docs/requirements/vision.md](docs/requirements/vision.md) | v0.1 |
| Бизнес-правила и параметры | [docs/requirements/business-rules.md](docs/requirements/business-rules.md) | v0.2 |
| Глоссарий | [docs/requirements/glossary.md](docs/requirements/glossary.md) | v0.1 |
| Статусная модель перевода | [docs/design/transfer-states.md](docs/design/transfer-states.md) | v0.2 |
| Таблица отказов | [docs/design/failure-modes.md](docs/design/failure-modes.md) | v0.2 |
| Sequence-диаграммы | [docs/design/sequences.md](docs/design/sequences.md) | v0.2 |
| Модель данных, DDL, проверки | [docs/design/data-model.md](docs/design/data-model.md) | v0.2 |
| OpenAPI, AsyncAPI, каталог ошибок | [docs/api](docs/api) | v0.2 |
| Интеграции: справочник, леджер, антифрод, ЦБ | [docs/integrations](docs/integrations) | v0.2 |
| Нефункциональные требования | [docs/requirements/nfr.md](docs/requirements/nfr.md) | v0.2 |
| ADR | [docs/decisions/adr](docs/decisions/adr) | v0.2 |
| Журнал решений | [docs/decisions/decision-log.md](docs/decisions/decision-log.md) | v0.2 |
| Mock, Postman, SQL сверки | — | итерация 3 |
