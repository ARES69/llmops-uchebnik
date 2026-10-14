---
title: OpenSearch: поиск по логам, которое масштабируется
track: devops
module: G. Зрелость эксплуатации
order: 26
duration: 75 мин
level: middle
tags: [opensearch, elasticsearch, логи, индексы, дашборды]
summary: Полнотекстовый поиск по логам и событиям: устройство кластера и шардов, инвертированный индекс и маппинги, разница text и keyword, ILM для ротации и хранения, источники данных (Filebeat, Logstash, OpenTelemetry Collector) и честное сравнение с Loki и ClickHouse
practice: Подними OpenSearch и Dashboards из лекции, залей 20 тысяч синтетических логов шлюза через bulk API, собери индекс-шаблон с правильными text и keyword полями, напиши три запроса (5xx за час по хостам, поиск по тексту ошибки, агрегация по кодам) и собери дашборд в Dashboards.
---

В [лекции о Grafana и Loki](devops/17-grafana-loki-alerty.md) ты получил связку, которая дёшево решает 80% задач: агент шлёт поток, Loki сжимает чанки, метки работают как индекс. Проблема начинается, когда вопрос становится «покажи все вхождения `connection reset by peer` за последние две недели по всем хостам, кроме тех, у кого есть реквизиты в запросе». Loki на такой вопрос ответит либо очень долго, либо очень дорого, потому что он **ищет только по меткам**, а содержимое сканирует целиком в найденных чанках. OpenSearch — это когда логи становятся данными, по которым строят расследования и отчёты, а не просто смотрят последние полчаса.

## Что это за зверь и из чего он вырос

OpenSearch — форк Elasticsearch, который отделился от Elasticsearch и Kibana. Факт, который надо помнить, потому что из него следуют все остальные: **кодовая база — Elasticsearch 7.10.x и Kibana соответственно**. Отсюда следует:

- REST API совместим с Elastic **7.x** — почти всё, что ты читал в документации Elasticsearch 7, работает;
- совместимости с Elastic **8.x** нет: другой формат проверки лицензии, часть REST-эндпоинтов и настроек отличается, документацию Elastic 8 нельзя применять один в один;
- визуальная часть называется **OpenSearch Dashboards** и является форком Kibana того же поколения: привычки,Dev Tools и импорт дашбордов у тебя сохраняются.

> [!NOTE]
> OpenSearch развивается быстро: добавляются data streams, автоматическая
> оптимизация числа шардов, плагин безопасности с расширенными ролями,
> меняются названия параметров кластера и полей ILM. Поэтому здесь я описываю
> **механизм**, а конкретные имена полей и флагов всегда сверяй с
> `GET /` (версия), `GET _cat/plugins` и документацией **своей** сборки.
> Проверка совместимости на практике одна: подставь свой запрос в Dev Tools
> и посмотри ответ, а не ищи ответ в чужой вики.

Когда OpenSearch нужен, а когда нет:

| Задача | Нужен ли OpenSearch |
| --- | --- |
| «что было в логах шлюза за последний час» | нет, Loki справится |
| «покажи все 5xx за неделю с группировкой по хостам и кодам» | да, агрегации и фильтры |
| «найди все запросы с определённой строкой в теле или в user-agent» | да, полнотекстовый поиск по тексту |
| «кто и когда обращался к документу X за месяц» | да, аудит требует долгого хранения |
| метрики и тренды | нет, это Prometheus |
| 200 хостов × 3 строки в секунду, сутки | не нужно, Loki дешевле в разы |

## Кластер: роли нод, шарды, реплики

Индекс в OpenSearch разбит на **шарды** (части индекса), у каждого шарда есть одна или несколько **реплик** (копий). Документ пишется в шард по `hash(_id) % shard_count`. Ноды кластера играют три роли, и в реальности они совмещаются, но понимать их раздельно обязательно.

| Роль | Что делает | Что будет, если её нет |
| --- | --- | --- |
| **Data** | хранит шарды, самая тяжёлая по CPU, памяти и диску | потеря данных без реплики, невозможность записи |
| **Cluster manager** (раньше называлась master) | хранит состояние кластера, решает, где лежат шарды, ведёт выборы | кластер «зависает», ноды перестают координироваться |
| **Coordinating** (любая нода) | принимает запрос, раздаёт его по нодам, собирает ответ | — |
| Ingest | конвейеры преобразования данных на записи | логи пишутся «как есть» |

Правило, которое экономит нерги чаще всего: **cluster manager — одна нода на нечётном маленьком контуре (или три на продакшн), data — всё остальное**. Ставить две одинаковые ноды и называть обе «master» — значит получить кластер без кворума в самый неподходящий момент.

```bash
# что вообще в кластере
curl -s localhost:9200/ | python3 -m json.tool
curl -s 'localhost:9200/_cat/nodes?v&h=name,node.role,heap.percent,disk.avail,cpu'
curl -s 'localhost:9200/_cat/shards?v&h=index,shard,prirep,state,docs,store,node'
curl -s 'localhost:9200/_cluster/health?pretty'          # status: green / yellow / red
curl -s 'localhost:9200/_cluster/allocation/explain?pretty'  # почему шард unassigned
```

### Сколько шардов и почему их нельзя менять на живом индексе

Число основных шардов задаётся **при создании индекса** и определяет, как данные делятся по нодам. Изменить его на существующем индексе **нельзя**: это фундаментальное ограничение, а не недоработка. Можно только создать новый индекс с нужным числом шардов и перелить в него данные через `_reindex` — на терабайтах это часы работы и место для двойного объёма.

Отсюда правило: **число шардов — это решение на этапе создания индекса, и оно необратимо**. Ориентир: целевой размер шарда 20–50 ГБ, ниже 5 ГБ выселять не имеет смысла (накладные расходы на ноду съедают экономию), выше 80 ГБ шард восстановить при падении ноды долго. Отсюда `шарды ≈ объём_данных_на_год / 40 ГБ`, округлённо вверх, и **не больше числа нод, умноженного на несколько шардов на ноду** — иначе половина кластера будет состоять из крошечных шардов.

```bash
# разложение по дискам — так видно перекос
curl -s 'localhost:9200/_cat/allocation?v&h=node,shards,disk.indices,disk.used,disk.avail'
# сколько шаров на индекс — источник большинства «стал медленнее»
curl -s 'localhost:9200/_cat/shards?v&h=index,shard,prirep,docs,store' | awk '{print $1}' | sort | uniq -c | sort -rn | head
```

В новых версиях OpenSearch есть механизм автоматического переразбиения индексов, но планировать инфраструктуру надо так, чтобы он не понадобился: правильно выбранное число шардов дешевле любой автоматики.

### Инвертированный индекс, `_source` и анализаторы

Ключевая идея, без которой OpenSearch выглядит магией: обычный индекс — это как оглавление книги (быстро найти страницу по названию главы). **Инвертированный** — это список всех слов с номерами страниц, где они встречаются. Именно поэтому поиск по тексту быстрый, а платим мы памятью и местом на диске.

Цепочка прохождения документа при записи:

| Этап | Что происходит | Настройка |
| --- | --- | --- |
| Разбиение на токены | текст режется на слова | анализатор, токенизатор |
| Нормализация | регистр, диакритика, стемминг | фильтры `lowercase`, `asciifolding`, `stemmer` |
| Индексация | в индекс идут термы, в `_source` — оригинал | `index: true/false` |
| Хранение для сортировки и агрегаций | отдельная колонка `doc_values` | `doc_values: true/false` |

`_source` — это **исходный JSON документа**, как его отправили. Он хранится всегда (если не выключен), по нему работает обновление и переиндексация. Отключать его ради экономии нельзя: без него невозможно ни обновить документ, ни перелить индекс. Экономия достигается выборочным `index: false` на неиндексируемых полях, а не `_source: false`.

### `text` против `keyword`: ошибка, которая стоит недели

Это самая частая грабля новичка, потому что оба типа поля принимают строку, оба выглядят одинаково в интерфейсе, и запрос к одному не работает к другому.

| Тип | Что делает | Пример значения | Когда применять |
| --- | --- | --- | --- |
| `keyword` | хранит как есть, **не разбирает** | `error_timeout`, `GET`, `corr_all` | точные значения: коды статуса, `host`, `user`, `path`, идентификаторы |
| `text` | разбирает анализатором, индексирует слова | `Connection reset by peer` | свободный текст: сообщение, user-agent, стек-трейс |

Если `host` объявлен как `text`, запрос `{"term": {"host": "srv-01"}}` не найдёт ничего, потому что в индексе лежит токен `srv` и отдельный `01`. А запрос `{"match": {"host": "srv-01"}}` по полю, объявленном как `keyword`, развалится на два, не найдёт ни одного. Правило простое: **точное значение — `keyword`, текст для чтения человеком — `text`**. Если нужно и то, и другое — используй multi-field: одно поле `text` с подполем `keyword`.

```json
PUT /_index_template/logs-nginx
{
  "index_patterns": ["logs-nginx-*"],
  "priority": 200,
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 0,
      "refresh_interval": "5s"
    },
    "mappings": {
      "dynamic_templates": [
        {
          "strings_as_keywords": {
            "match_mapping_type": "string",
            "mapping": { "type": "keyword", "ignore_above": 1024 }
          }
        }
      ],
      "properties": {
        "@timestamp":    { "type": "date" },
        "message":      { "type": "text", "analyzer": "standard" },
        "user_agent":   { "type": "text", "fields": { "raw": { "type": "keyword" } } },
        "http": {
          "properties": {
            "response": {
              "properties": {
                "status_code": { "type": "integer" },
                "body":        { "type": "text" }
              }
            },
            "request": {
              "properties": {
                "method":  { "type": "keyword" },
                "referrer":{ "type": "keyword", "ignore_above": 512 }
              }
            }
          }
        },
        "labels":     { "type": "nested" },
        "trace_id":  { "type": "keyword", "index": false, "doc_values": false },
        "tags":      { "type": "keyword" }
      }
    }
  }
}
```

Три решения в этом шаблоне, которые стоит уметь объяснить:

- `dynamic_templates` превращает любое неизвестное строковое поле в `keyword`. Без этого правила случайное поле `message_id` станет `text`, и запрос по нему перестанет работать. Для логов это разумный дефолт, но явные поля важнее.
- `nested` для `labels`: массив объектов. Без `nested` объект, у которого есть поле `name`, сольётся с объектом, у которого есть поле `value`, и запрос «есть ли метка с таким именем И таким значением» начнёт находить не то. Если массив однотипных скаляров — `keyword` достаточно, `nested` не нужен.
- `index: false, doc_values: false` для `trace_id`: поле нужно только для отображения и поиска в Kibana через `_source`, по нему не фильтруют и не агрегируют. Это экономит место без потери функциональности.

## Запросы: как перенести привычки из PromQL

Запрос в OpenSearch пишется JSON-объектом, вложенным в `query`. Структура ровно повторяет логику, которую ты уже знаешь по PromQL: выбрать по меткам → отфильтровать → ограничить диапазон → сгруппировать.

| PromQL | OpenSearch DSL | Смысл |
| --- | --- | --- |
| `rate(http_requests_total{job="gateway",status=~"5.."}[1h])` | агрегация по диапазону времени с `filter` | сколько 5xx в секунду |
| `up{instance="srv-01"}` | `{"term": {"host": "srv-01"}}` | точное совпадение поля |
| `http_requests_total / ignoring(status) sum(http_requests_total)` | `bool` с `must_not` | исключить подмножество |
| `label_replace(...)` | `terms` агрегация с `key_as` | переименовать метку в столбце таблицы |
| `histogram_quantile(0.95, ...)` | `percentiles` агрегация | хвост распределения |

Главное соответствие, которое стоит заучить: `term` — это `=`, а `match` — это полнотекстовый разбор. `term` по полю `keyword` даёт точный фильтр, `match` по полю `text` — поиск по словам.

```bash
OS=http://127.0.0.1:9200

# 1. все 5xx за последний час, с агрегацией по хостам
curl -s "$OS/logs-nginx-*/_search?pretty" -H 'Content-Type: application/json' -d '{
  "size": 0,
  "query": {
    "bool": {
      "filter": [
        { "range": { "@timestamp": { "gte": "now-1h" } } },
        { "range": { "http.response.status_code": { "gte": 500, "lt": 600 } } }
      ],
      "must_not": [ { "term": { "tags": "healthcheck" } } ]
    }
  },
  "aggs": {
    "by_host": {
      "terms": { "field": "host", "size": 20, "order": { "_count": "desc" } },
      "aggs": {
        "codes": { "terms": { "field": "http.response.status_code", "size": 10 } },
        "p95_latency_ms": { "percentiles": { "field": "http.duration_ms", "percents": [95] } }
      }
    }
  }
}'

# 2. полнотекстовый поиск по сообщению + по вложенным меткам одновременно
curl -s "$OS/logs-nginx-*/_search?pretty" -H 'Content-Type: application/json' -d '{
  "query": {
    "bool": {
      "must": [
        { "match": { "message": "connection reset by peer" } },
        { "nested": { "path": "labels",
          "query": { "bool": { "must": [
            { "term": { "labels.name": "env" } },
            { "term": { "labels.value": "prod" } }
          ] } } }
      ]
    }
  },
  "highlight": { "fields": { "message": {} } }
}'

# 3. точный фильтр по keyword-полю и диапазон по числу
curl -s "$OS/logs-nginx-*/_search?pretty" -H 'Content-Type: application/json' -d '{
  "query": { "bool": { "filter": [
    { "term": { "http.request.referrer": "https://portal.corp.example.com/" } },
    { "range": { "http.duration_ms": { "gt": 2000 } } }
  ] } },
  "_source": ["@timestamp", "host", "http.request.method"]
}'
```

Три параметра, которые экономят больше всего времени:

- `"size": 0` в агрегациях — не возвращать хиты, только агрегаты. Без этого ты грузишь в память Dashboards тысячи документов ради одного графика.
- `"filter"` вместо `must` внутри `bool`: `filter` не считает очки релевантности и кэшируется, `must` — считает. Одинаковый результат, разница в скорости в разы.
- `_source` с перечнем полей: не тянуть в ответ тело ответа LLM вместе с промптом, если тебе нужен только статус и хост.

## ILM: ротация, hot/warm и удаление

Индекс в OpenSearch **вечен** и только растёт. Никакого «хранить 30 дней» в нём нет — есть delete-фаза, которую кто-то должен настроить. Без неё через полгода диск заполнится, и сервис упадёт с `FORBIDDEN/12/disk watermark exceeded`. Для логов это самая частая авария, которую можно предотвратить.

| Способ | Как ротирует | Удаляет | Когда применять |
| --- | --- | --- | --- |
| Ничего | не ротирует | ничего | никогда, это и есть проблема |
| Индекс на сутки | шаблон с датой в имени, удаление по расписанию `find … -delete` | внешним скриптом | простой случай, логов мало |
| **ILM** | само по условиям, создаёт следующий индекс и переключает алиас | сам, по возрасту | правильный выбор |
| Data streams | сам, без алиаса, писать можно только в поток | сам | новые версии OpenSearch, если поддерживается твоей |

ILM работает как политика из фаз. Внутри фазы — шаги: `allocate` (сколько реплик на скольких нодах), `rollover` (когда создавать следующий индекс), `forcemerge` (склеить сегменты перед холодным чтением), `set_priority`.

```json
PUT /_ilm/policy/logs-nginx-policy
{
  "policy": {
    "phases": {
      "hot": {
        "actions": {
          "rollover": {
            "max_size": "30gb",
            "max_age": "1d"
          }
        }
      },
      "warm": {
        "min_age": "2d",
        "actions": {
          "allocate": {
            "number_of_replicas": 1,
            "total_shards_per_node": 2
          },
          "forcemerge": { "max_num_segments": 1 }
        }
      },
      "delete": {
        "min_age": "30d",
        "actions": { "delete": {} }
      }
    }
  }
}

PUT /logs-nginx-000001
{
  "aliases": { "logs-nginx-write": {} },
  "settings": {
    "index.lifecycle.name": "logs-nginx-policy",
    "index.lifecycle.rollover_alias": "logs-nginx-write"
  }
}
```

> [!CAUTION]
> В OpenSearch у политики ILM есть схема со списком допустимых полей, и она
> менялась от версии к версии: часть условий и полей в разных релизах называется
> по-разному или появляется позже. Проверяй `GET /_ilm/policy/logs-nginx-policy`
> и `_ilm/explain` после первого применения политики — если фаза не сработала,
> ты увидишь это в explain, а не через месяц в аварии.

Ручная настройка против ILM — честное сравнение: ручная (`delete_by_query` по времени, внешний cron) работает на маленьком объёме и требует места на диске под временный пик, но её можно увидеть глазами и откатить. ILM автоматичен, живёт в кластере, переживает его рестарты и умеет то, что руками неудобно: сначала `rollover`, потом `forcemerge`, и только потом удаление.

## Откуда логи: Filebeat, Logstash, OpenTelemetry Collector

Три способа доставить логи, и они не взаимозаменяемы полностью.

| Инструмент | Что это | Сильная сторона | Слабая сторона |
| --- | --- | --- | --- |
| **Filebeat** | лёгкий агент на хост, шлёт как есть | минимум ресурсов, простой конфиг, огромная база готовых модулей | сложная трансформация данных |
| **Logstash** | полноценный пайплайн с фильтрами | всё преобразуешь сам, grok, date, mutate | заметно жрёт память, отдельный сервис в стеке |
| **OpenTelemetry Collector** | единый агент для метрик, логов и трейсов | одна конфигурация на весь стек, роутинг, семантика полей | для логов требует осознанной настройки источника `filelog` |

```yaml
# /opt/llmops/obs/otel-collector.yaml — доставка логов контейнеров и journal в OpenSearch
receivers:
  filelog:
    include: ["/var/log/containers/*.log"]
    start_at: end
    operators:
      - type: container
        id: container-parser

processors:
  batch:
    timeout: 5s
    send_batch_size: 512
  attributes/drop_secrets:
    actions:
      - key: api_key
        action: delete
      - key: authorization
        action: delete
  resource/detect_env:
    detectors: [env, system]

exporters:
  opensearch:
    endpoints: ["https://sso-free-host:9200"]
    auth:
      username: "${OS_LOG_WRITER}"
      password: "${OS_LOG_WRITER_PASSWORD}"
    logs_index: "logs-otel-%{+yyyy.MM.dd}"

service:
  pipelines:
    logs:
      receivers: [filelog]
      processors: [resource/detect_env, attributes/drop_secrets, batch]
      exporters: [opensearch]
```

```bash
# Filebeat — если нужен минимум суеты и стандартные поля
cat > /etc/filebeat/filebeat.yml <<'YAML'
filebeat.inputs:
  - type: filestream
    id: llm-gateway
    paths: ["/opt/llmops/gateway/*.log"]
    parsers:
      - ndjson:
          target: ""
          add_error_key: true
    fields_under_root: true
    fields:
      service: llm-gateway
output.opensearch:
  hosts: ["https://127.0.0.1:9200"]
  username: "${OS_LOG_WRITER}"
  password: "${OS_LOG_WRITER_PASSWORD}"
  index: "logs-llm-%{+yyyy.MM.dd}"
setup.template.name: logs
setup.ilm.enabled: false        # ротацией занимается ILM на стороне OpenSearch
YAML
systemctl restart filebeat && journalctl -u filebeat -n 20 --no-pager
```

> [!IMPORTANT]
> У экспортёра OpenSearch в коллекторе логи ложатся в индексы с датой в
> имени. Если шаблон индекса у тебя называется `logs-nginx-*`, а экспортёр
> пишет в `logs-otel-*`, то ILM-политика к твоим индексам не применится, и
> через месяц диск заполнится. Либо приводи именование к одному шаблону,
> либо делай отдельную политику. Проверяется это ровно так:
> `curl -s 'localhost:9200/_cat/indices/logs-*?v&h=index,docs.count,store.size'`

## OpenSearch Dashboards: дашборды и алерты

Dashboards устроены так же, как Kibana: `data view` (в Kibana — index pattern) с выбором поля-времени, потом визуализации, потом дашборд. Разница в терминах и в том, что часть плагинов ( alerting) переехала внутрь дистрибутива. Импортированный из Kibana дашборд может потребовать правки — data sources, id объектов и сохранённых полей.

```bash
DS_UID=opensearch-logs
cat > /tmp/datasource.json <<JSON
{
  "name": "OpenSearch",
  "id": "$DS_UID",
  "type": "opensearch",
  "connectionParams": {
    "hosts": ["http://127.0.0.1:9200"],
    "index": "logs-nginx-*",
    "auth": { "username": "admin", "password": "$OS_ADMIN_PASSWORD" }
  }
}
JSON
curl -s -u "admin:$OS_ADMIN_PASSWORD" -H 'Content-Type: application/json' \
  -X POST localhost:5601/api/data_sources \
  --data-binary @/tmp/datasource.json | python3 -m json.tool | head -8
```

Что на дашборде логов обязательно есть, а что — мусор: панель «5xx по хостам», «топ-10 шаблонов 4xx», «p95 латентности», «доля запросов с 401» (из [предыдущей лекции](devops/25-sso-i-keycloak.md) ты знаешь, что всплеск 401 — это либо баг, либо подбор пароля). Всё остальное — по требованиям. Дашборд без владельца умирает за полгода, и в OpenSearch это происходит быстрее, потому что полей становится больше.

Алёрты в Dashboards (встроенный плагин) удобны тем, что не надо поднимать Alertmanager, но для LLM-контура честнее считать метрики в Prometheus: во-первых, агрегаты из OpenSearch надо сначала выгрузить, во-вторых, у тебя уже есть маршрутизация и антишум из [лекции об алертах](devops/17-grafana-loki-alerty.md). Практичный компромисс — использовать Alerting OpenSearch только для редких событий («индекс ушёл в red», «за последний час вставлено в 10 раз меньше обычного»), а частые — считать в Prometheus.

## Практика: поднять и пощупать

```yaml
# /opt/llmops/obs-search/docker-compose.yml
services:
  opensearch:
    image: opensearchproject/opensearch:latest      # в проде — зафиксированный тег
    environment:
      discovery.type: single-node
      bootstrap.memory_lock: "true"
      OPENSEARCH_JAVA_OPTS: "-Xms1g -Xmx1g"
      DISABLE_INSTALL_DEMO_CONFIG: "true"            # не поднимать демо-конфиг с open-паролем
      OPENSEARCH_INITIAL_ADMIN_PASSWORD: ${OS_ADMIN_PASSWORD:?задай в .env}
      plugins.security.disabled: "false"
    ulimits:
      memlock: { soft: -1, hard: -1 }
      nofile:  { soft: 65536, hard: 65536 }
    volumes:
      - os-data:/usr/share/opensearch/data
    ports:
      - "127.0.0.1:9200:9200"
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:9200/_cluster/health || exit 1"]
      interval: 10s
      retries: 30
    restart: unless-stopped

  opensearch-dashboards:
    image: opensearchproject/opensearch-dashboards:latest
    environment:
      OPENSEARCH_HOSTS: '["http://opensearch:9200"]'
      DISABLE_SECURITY_DASHBOARDS_PLUGIN: "false"
    ports:
      - "127.0.0.1:5601:5601"
    depends_on:
      opensearch: {condition: service_healthy}
    restart: unless-stopped

volumes:
  os-data:
```

> [!WARNING]
> В версиях начиная с 2.12 демонстрационная конфигурация принудительно
> просит задать пароль администратора через `OPENSEARCH_INITIAL_ADMIN_PASSWORD`
> (либо `..._FILE`, если секрет лежит в файле), а в более новых сборках это
> стало условием старта. Если параметр не задан, кластер может подняться с
> паролем `admin` — то есть с открытым доступом, если порт смотрит наружу.
> Проверь поведение **своей** версии и проверь фактический результат:
> `curl -s -u "admin:$OS_ADMIN_PASSWORD" localhost:9200/_cluster/health`.
> В учебной VM допустимо `DISABLE_SECURITY_PLUGIN=true` вместе с
> `DISABLE_INSTALL_DEMO_CONFIG=true` — но только при публикации порта на
> `127.0.0.1`.

```python
# /opt/llmops/gen_logs.py — 20 000 синтетических логов шлюза в bulk-формате
import json, random, time, uuid

random.seed(42)
now = int(time.time() * 1000)
hosts = [f"srv-{i:02d}" for i in range(1, 9)]
paths = ["/v1/chat", "/v1/embeddings", "/v1/documents", "/health", "/v1/admin/audit"]
msgs = ["connection reset by peer", "upstream timed out",
        "token expired", "context length exceeded", "empty completion"]

with open("logs.ndjson", "w", encoding="utf-8") as f:
    for i in range(20000):
        code = random.choices([200, 400, 401, 429, 500, 503], [78, 6, 5, 4, 5, 2])[0]
        doc = {
            "@timestamp": now - random.randint(0, 24 * 3600) * 1000,
            "message": random.choice(msgs) if code >= 400 else "request completed",
            "host": random.choice(hosts),
            "http": {
                "request": {"method": "POST" if random.random() > 0.2 else "GET",
                            "referrer": random.choice(["https://portal.corp.example.com/", "-"])},
                "response": {"status_code": code,
                             "body": {"content": {"type": "text", "text": random.choice(msgs)}}},
                "duration_ms": int(random.lognormvariate(5, 1.2)),
            },
            "labels": [{"name": "env", "value": "prod"},
                       {"name": "route", "value": random.choice(paths)}],
            "trace_id": uuid.uuid4().hex,
            "tags": ["healthcheck"] if random.random() < 0.05 else [],
            "user_id": f"user-{random.randint(1, 40)}",
        }
        meta = {"index": {"_index": "logs-nginx-000001"}}
        f.write(json.dumps({"index": meta}) + "\n")
        f.write(json.dumps(doc) + "\n")
print("готово")
```

```bash
cd /opt/llmops/obs-search && python3 /opt/llmops/gen_logs.py
wc -l logs.ndjson
curl -s -u "admin:$OS_ADMIN_PASSWORD" -XPOST localhost:9200/_bulk \
  -H 'Content-Type: application/x-ndjson' --data-binary @logs.ndjson | head -c 300
curl -s -u "admin:$OS_ADMIN_PASSWORD" -XPOST 'localhost:9200/logs-nginx-000001/_refresh'
curl -s -u "admin:$OS_ADMIN_PASSWORD" 'localhost:9200/_cat/indices/logs-*?v&h=index,health,docs.count,store.size'

# то, ради чего всё затевалось: «покажи 5xx за сутки по хостам» одной строкой
curl -s -u "admin:$OS_ADMIN_PASSWORD" "$OS/logs-nginx-*/_search?pretty" -H 'Content-Type: application/json' -d '{
  "size": 0,
  "query": { "bool": { "filter": [
    { "range": { "@timestamp": { "gte": "now-24h" } } },
    { "range": { "http.response.status_code": { "gte": 500 } } }
  ] } },
  "aggs": { "by_host": { "terms": { "field": "host", "size": 10 } } }
}'

# а теперь тот же вопрос по тексту: Loki так не умеет быстро
curl -s -u "admin:$OS_ADMIN_PASSWORD" -H 'Content-Type: application/json' "$OS/logs-nginx-*/_search" -d '{
  "size": 3,
  "query": { "match": { "message": "connection reset by peer" } },
  "_source": ["@timestamp","host","http.response.status_code"]
}'
```

## Loki, OpenSearch, ClickHouse: честное сравнение

| Критерий | Loki | OpenSearch | ClickHouse |
| --- | --- | --- | --- |
| Что индексирует | метки | всё, включая текст | столбцы и часть словаря |
| Цена хранения | самая низкая | высокая | средняя |
| Скорость записи | самая высокая | средняя | высокая |
| Полнотекстовый поиск | слабый | лучший | средний |
| Агрегации и группировка | слабые | сильные | сильные |
| Нагрузка на память | низкая | высокая (JVM, куча) | средняя |
| Операционная сложность | нулевая | средняя (JVM, куча, плагины) | средняя |
| Долгое хранение дешёвых логов | да | дорого | да |

Мой ответ по умолчанию для контура, где 50 машин: **Loki достаточно**. OpenSearch появляется, когда выполняется хотя бы одно из трёх условий: нужны сложные агрегации по произвольным полям, нужен полнотекстовый поиск по архиву за месяцы, или есть требование аудита к сроку хранения, который невозможно обеспечить в Loki дёшево. ClickHouse — когда логи уже структурированы и главное в них «посчитать», а не «найти строку».

## Безопасность: три правила

1. **Не выставлять наружу.** Порт 9200 на `0.0.0.0` с паролем `admin` — это открытый индекс всех твоих логов, включая промпты и user-agent'ы. Наружу — только обратный прокси с TLS и аутентификацией, и только для чтения.
2. **Аутентификация и авторизация — разные вещи.** Пароль администратора есть у одного человека; писать индексы должен отдельный пользователь с правами только на `create_index`, `write`, а читать — отдельный с `read` и без `delete`. Именно это убьёт последствия SQL-инъекции через промпт: даже если злоумышленник доберётся до индекса, он не сможет его стереть.
3. **TLS обязателен, как и в [лекции о безопасности](devops/20-bezopasnost-infrastruktury.md).** Внутри сети это не «для галочки»: логи контейнеров содержат заголовки авторизации, если агент не вырезал их.

## Где это ломается

- **Число шардов выбрано «на глаз» и зафиксировано навсегда.** Один шард на двести гигабайт восстанавливается час, двадцать шардов по пять гигабайт съедают кучу нод вхолостую. Считать от объёма и от числа нод, а не копировать из чужого примера.
- **`refresh_interval` не проиндексировали явно.** Значение по умолчанию — около секунды, и каждый `refresh` создаёт новый сегмент. На потоке в сотни тысяч документов в секунду это нагрузка без пользы; на потоке в десять документов в минуту это лишняя задержка появления лога в поиске.
- **Забыли про `_source` и выключили его «ради места».** Документ нельзя ни обновить, ни переиндексировать, ни восстановить из исходного JSON. Экономится это полем `index: false`, а не отключением `_source`.
- **`text` вместо `keyword` в полях идентификаторов.** Запросы не находят ничего, добрые люди начинают «чинить» это добавлением `"query_string"` с подстановкой, и через месяц в индексе лежат миллионы документов от рукопожатий.
- **Нет ILM.** Логи пишутся, ничего не удаляется, через три месяца срабатывает watermark по диску, индекс уходит в `read_only`, а Grafana и Dashboards молчат: логи-то есть, но записать новое нельзя. Настраивай delete-фазу в тот же день, когда создан первый индекс.
- **Слишком много мелких индексов.** Ты создаёшь индекс на сутки на каждый сервис — тридцать индексов по 50 МБ. Кластер тратит кучу heap на метаданные от пустых индексов, а смысла в них нет. Ротируй по размеру, а не по дате, пока объём не вырос.
- **Алерты в PromQL по метрикам, которых никто не выставил.** Экспортёры, написанные под Elasticsearch 7.x, обычно работают против OpenSearch — совместимость API в этом и состоит — но набор доступных метрик у них беднее, и `index_health` по нужным шардам там может не быть. Проверяй `/metrics` экспортёра глазами, а не доверяй дашборду из чужой статьи.
- **Пуш `refresh` вручную в проде.** `POST /index/_refresh` на боевом потоке создаёт сегмент на каждый вызов. Обновление видно через `refresh_interval`, а не через refresh по запросу.

## Чек-лист понимания

- [ ] Я могу объяснить, почему Loki дешевле, чем именно он плох, и назвать три задачи, ради которых в моём контуре нужен OpenSearch
- [ ] Я знаю, что OpenSearch — форк Elasticsearch 7.10.x, совместим с API Elastic 7.x и не совместим с 8.x, и проверяю параметры по документации своей версии
- [ ] Я различаю роли нод и умею прочитать `_cat/shards`, чтобы найти перекос по дискам
- [ ] Я могу посчитать число шардов от объёма данных и понимаю, почему изменить его на живом индексе нельзя
- [ ] Я отличаю `text` от `keyword`, объясню, почему `term` по `text`-полю не находит ничего, и умею описать multi-field
- [ ] Я переношу привычку из PromQL на DSL и писать запрос с `bool`/`filter`, вложенными полями и агрегациями
- [ ] Я настроил ILM с hot/warm/delete и проверяю `_ilm/explain`, а не надеюсь, что политика сработала
- [ ] Я не оставляю OpenSearch в сети без TLS и авторизации, а у пользователя на запись нет прав удалить индекс

Дальше — [Очереди и воркеры](devops/27-ocheredi-i-workers.md): почему индексация пятисот документов не должна занимать HTTP-запрос, и что делать, когда воркер упал посередине.