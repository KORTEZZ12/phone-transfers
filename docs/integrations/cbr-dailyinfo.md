# ЦБ РФ: курсы валют, DailyInfo

Публичный SOAP-сервис Банка России. Курсы нужны для рублёвого эквивалента валютных переводов в лимитах (TR-25, TR-26).

Контракт сверен живым вызовом 19 октября 2026 года, фрагмент ответа — [`examples/get-curs-on-date-response.xml`](examples/get-curs-on-date-response.xml).

| | |
|---|---|
| Адрес | `https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx`, описание — `?WSDL` |
| Протокол | SOAP 1.1, `Content-Type: text/xml; charset=utf-8` |
| Пространство имён | `http://web.cbr.ru/` |
| Операции | `GetLatestDateTime` — последняя дата, на которую установлены курсы; `GetCursOnDateXML` — курсы на дату |
| Доступ | Без авторизации, только HTTPS |

## Расписание загрузки

1. С 12:00 до 18:00 по Москве каждые 30 мин вызывать `GetLatestDateTime`.
2. Если дата новее последней загруженной, вызвать `GetCursOnDateXML` на эту дату.
3. Сохранить USD, EUR и CNY в `transfers.currency_rate`. Повторная загрузка той же даты обновляет запись, а не создаёт новую.
4. Если к 18:00 курса на сегодня нет — алерт операционному отделу. Переводы продолжают использовать последний курс (TR-26).

Для перевода на дату D берётся курс с наибольшей датой не позже D: курс, установленный в пятницу, действует и в выходные.

## Запрос

`SOAPAction: "http://web.cbr.ru/GetCursOnDateXML"`. Готовый файл — [`examples/get-curs-on-date.xml`](examples/get-curs-on-date.xml).

```xml
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetCursOnDateXML xmlns="http://web.cbr.ru/">
      <On_date>2026-10-19T00:00:00</On_date>
    </GetCursOnDateXML>
  </soap:Body>
</soap:Envelope>
```

Проверить живым вызовом:

```bash
curl -s https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx \
  -H 'Content-Type: text/xml; charset=utf-8' \
  -H 'SOAPAction: "http://web.cbr.ru/GetCursOnDateXML"' \
  --data @examples/get-curs-on-date.xml
```

## Ответ и маппинг

`GetCursOnDateXMLResult` содержит XML-документ `ValuteData` с элементами `ValuteCursOnDate`. В описании сервиса тип результата указан просто как `xml`, структура ниже подтверждена живым вызовом.

| Источник | Пример | Поле `currency_rate` | Правило |
|---|---|---|---|
| `ValuteData/@OnDate` | `20261017` | `rate_date` | формат `yyyyMMdd`; это дата установки курса, а не дата запроса |
| `ValuteCursOnDate/VchCode` | `USD` | `currency` | загружаем только USD, EUR, CNY |
| `ValuteCursOnDate/Vnom` | `1` | `nominal` | целое больше 0 |
| `ValuteCursOnDate/Vcurs` | `83.6177` | `rate` | рублей за `nominal` единиц, точка — десятичный разделитель |
| `ValuteCursOnDate/VunitRate` | `83.6177` | не используется | курс за единицу; бывает в экспоненциальной записи, поэтому считаем сами |
| — | — | `unit_rate` | вычисляется в базе: `rate / nominal` |

## Что показал живой вызов

| Наблюдение | Что из этого следует |
|---|---|
| На запрос с датой 19.10.2026, понедельник, пришли курсы с `OnDate="20261017"`, суббота | Сервис отдаёт последние установленные курсы. Правило «курс с наибольшей датой не позже даты операции» подтверждено, в `rate_date` пишем `OnDate`, а не дату запроса |
| У `ValuteData` стоит `xmlns=""` | Элементы курсов вне пространства имён `http://web.cbr.ru/`: в XPath к ним обращаемся без префикса, к обёртке ответа — с префиксом |
| `Vname` дополнен пробелами до фиксированной длины | Название не храним; если понадобится — обрезать пробелы |
| `VunitRate` бывает в экспоненциальной записи: у иранского риала `4.63812E-05` | Курс за единицу считаем сами как `Vcurs / Vnom`, не разбирая `VunitRate` |
| Номинал бывает 1, 10, 100, 1 000, 10 000 и 1 000 000 | Без деления на `Vnom` курс ошибётся в разы. Для USD, EUR и CNY сейчас номинал 1 |

Разбор ответа проверен на PostgreSQL: SQL на XPath загружает USD, EUR и CNY из фрагмента реального ответа и считает рублёвый эквивалент — блок «маппинг ответа ЦБ» в [`ddl-checks.sql`](../design/ddl-checks.sql).

## Отказы

| Ситуация | Что делаем |
|---|---|
| Таймаут 10 с, обрыв, HTTP 5xx | Ждём следующий слот расписания |
| SOAP Fault | Записываем код и текст, алерт: формат запроса или сервис изменился |
| В ответе нет нужной валюты | Остальные валюты сохраняем, по отсутствующей — алерт |
| `Vcurs` не число или `Vnom` не больше 0 | Курс по этой валюте не сохраняем, алерт |
