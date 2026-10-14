---
title: Очереди и воркеры
track: devops
module: G. Зрелость эксплуатации
order: 27
duration: 75 мин
level: middle
tags: [kafka, rabbitmq, очереди, воркеры, dlq, идемпотентность]
practice: Подними RabbitMQ из лекции, прогони 200 задач индексации через воркер с ack, nack и requeue=false, намеренно подставь «ядовитое» сообщение и убедись, что оно попало в DLQ и что повторная обработка документа не создала дубль в базе; затем повтори то же самое на PostgreSQL через FOR UPDATE SKIP LOCKED.
---

Пользователь нажал «загрузить 500 документов» в RAG-сервисе. Если индексация идёт в HTTP-запросе, он сорок секунд смотрит на крутилки, а потом уходит к себе в почту. Что произошло на самом деле — пятьдесят секунд работы, которую можно было разложить на минуту фонового труда и вернуть пользователю сразу с идентификатором задачи. Ровно это и делает очередь. Разбираем, какую очередь взять, как написать воркер, который не потеряет и не задублирует работу при падении, и почему «просто сделай ретрай» — худшее из возможных решений.

## Зачем очередь в ИИ-системе

Пять задач, каждая из которых сегодня где-то крутится в HTTP-запросе:

| Задача | Сколько занимает | Что будет, если делать синхронно |
| --- | --- | --- |
| Индексация загруженного корпуса | 40–120 с на 500 документов | пользователь уходит, отмена запроса, половина корпуса в неопределённом состоянии |
| Пакетная генерация отчётов | минуты | HTTP-таймаут, пользователь не знает, готов отчёт или нет |
| Отправка в модель батчами | секунды на батч | нельзя пережить лимит провайдера, одна ошибка валит весь запрос |
| Переиндексация после смены модели эмбеддингов | часы | невозможно сделать без остановки сервиса |
| Отправка отчёта в Telegram/email | секунды | основной обработчик стоит в ожидании стороннего сервиса |

Что даёт очередь: **разрыв во времени** (задача выполняется когда удобно), **буфер** (всплеск нагрузки не роняет систему, а копится), **изоляция сбоев** (упавший воркер не роняет приёмник), **повторяемость** (попытку можно повторить тем же кодом) и **наблюдаемость** (длина очереди — метрика, а не догадка).

Чего очередь не даёт: мгновенного ответа пользователю, транзакционности между «записать в БД» и «сообщение ушло» (это решается через outbox-паттерн или через повтор с идемпотентностью — см. ниже) и порядка обработки, если воркеров больше одного. Порядок надо либо обеспечивать ключом, либо не обещать.

## Выбор транспорта

| Критерий | Redis Streams | RabbitMQ | Kafka | SQS-подобные | PostgreSQL `SKIP LOCKED` |
| --- | --- | --- | --- | --- | --- |
| Что уже есть у тебя | почти всегда | нет | нет | нет | почти всегда |
| Подтверждение и повторная доставка | `XACK` + `XAUTOCLAIM` | `ack`/`nack`, DLX | offset, redelivery по таймауту | ручные удаления | транзакция БД |
| Маршрутизация сообщений | нет | routing key, типы обменников | только по ключу в партицию | фильтры подписчиков | нет, очередь это таблица |
| Порядок | нет | нет (в очереди — да, между потребителями — нет) | **только внутри партиции** | нет | нет |
| Несколько независимых потребителей | отдельные группы | конкурирующие или раздельные очереди | разные consumer group | разные подписки | нет |
| Пропускная способность | высокая | высокая | очень высокая | высокая | средняя |
| Эксплуатация | ноль новых сервисов | отдельный сервис | кластер из трёх сервисов | внешний сервис | ноль |
| Когда брать | уже есть Redis, задач до сотни в минуту | сложная маршрутизация, приоритеты, DLQ из коробки | поток событий и аналитика поверх него | если уже в облаке AWS | задачи живут в той же базе, что и данные |

Про Redis Streams подробно — в [лекции о Redis](devops/22-redis.md), там разобраны `XADD`, `XREADGROUP`, `XACK`, `XAUTOCLAIM`. Вывод оттуда: для индексации документов Streams — честный выбор, если в проекте уже есть Redis и нет нужды в сложной маршрутизации.

Правило выбора, которое работает в 90% случаев: **не поднимай отдельный брокер, пока очередь не упёрлась в то, чего нет в твоей базе.** Если задача — «сделай это с документом из таблицы `documents`», то строка в этой же таблице со статусом `pending` и `SELECT … FOR UPDATE SKIP LOCKED` даёт тебе ровно то же, что RabbitMQ, без нового сервиса в дежурстве. RabbitMQ нужен, когда появляются **несколько типов задач, приоритеты, разные потребители и маршрутизация**. Kafka — когда событий тысячи в секунду и у них несколько независимых потребителей.

## RabbitMQ: устройство

Четыре сущности, которые надо различать:

| Сущность | Что это | Типичная ошибка |
| --- | --- | --- |
| Exchange | точка публикации, сама ничего не хранит | публиковать в exchange, думая, что это очередь |
| Routing key | строка, по которой exchange решает судьбу сообщения | разные регистры в имени ключа — сообщение потерялось |
| Queue | структура, где лежат сообщения | забыть про DLX — «потерянные» сообщения просто исчезают |
| Binding | правило «этот ключ или паттерн → в эту очередь» | объявить очередь, но не привязать — сообщения не придут |

```bash
docker run -d --name rabbit \
  -p 127.0.0.1:5672:5672 -p 127.0.0.1:15672:15672 \
  -e RABBITMQ_DEFAULT_USER=llmops -e RABBITMQ_DEFAULT_PASS="$RABBIT_PASSWORD" \
  -e RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS="-rabbit disk_free_limit 2147483648" \
  rabbitmq:3.13-management
# встроенный эндпоинт метрик Prometheus — включён из коробки
curl -s -u "llmops:$RABBIT_PASSWORD" localhost:15672/api/definitions > /dev/null && echo ok
curl -s -u "llmops:$RABBIT_PASSWORD" localhost:15672/metrics | grep -E '^rabbitmq_queue_messages_ready' | head -3
```

Объявление очереди делается вместе с аргументами, и именно здесь задаётся вся политика повторов. Quorum-очередь ниже — она переживает падение ноды-брокера, потому что реплицирует сообщения, в отличие от classic.

```json
{
  "queues": [
    {
      "name": "rag.index",
      "vhost": "/",
      "durable": true,
      "auto_delete": false,
      "arguments": {
        "x-queue-type": "quorum",
        "x-delivery-limit": 5,
        "x-dead-letter-exchange": "dlx",
        "x-dead-letter-routing-key": "rag.index.dead"
      }
    },
    { "name": "rag.index.retry", "vhost": "/", "durable": true,
      "arguments": { "x-queue-type": "quorum", "x-message-ttl": 30000, "x-dead-letter-exchange": "" } },
    { "name": "rag.index.dead",  "vhost": "/", "durable": true,
      "arguments": { "x-queue-type": "quorum" } }
  ],
  "exchanges": [
    { "name": "dlx", "vhost": "/", "type": "fanout", "durable": true, "auto_delete": false }
  ],
  "bindings": [
    { "source": "dlx", "vhost": "/", "destination": "rag.index.dead", "destination_type": "queue",
      "routing_key": "", "arguments": {} }
  ]
}
```

### Типы обменников

Типы обменников выбираются по смыслу маршрутизации:

| Тип | Правило | Когда применять |
| --- | --- | --- |
| `direct` | routing key совпал | один тип задач в одну очередь |
| `topic` | routing key совпал с паттерном `audit.*`, `*.failed` | несколько типов задач, потребитель выбирает, что ему нужно |
| `fanout` | всем привязанным очередям | «залог событий в две очереди: обработка и аудит» |
| `headers` | по заголовкам | почти никогда, маршрутизация в payload проще |

## Ack, nack и prefetch: почему это критично

Механизм доставки — «at-least-once»: RabbitMQ считает сообщение доставленным, как только отдал его потребителю, и ждёт `ack`. Пока `ack` не пришёл, при перезапуске брокера сообщение вернётся другому потребителю.

```text
ack            — всё прошло, сообщение можно забыть
nack(requeue=True)   — вернуть в очередь немедленно (осторожно: горячий цикл)
nack(requeue=False)  — в мёртвую очередь, дальше не трогаем
basic.reject   — то же для одного сообщения
```

**Prefetch** — сколько сообщений брокер отдаёт потребителю без подтверждения. Это главная настройка, которую ставят неправильно:

| prefetch | Что происходит |
| --- | --- |
| 1 | справедливо, но медленно: воркер простаивает во время сети и БД |
| 10–50 | норма для HTTP-вызовов и вставок в БД |
| `0` (бесконечно) | **грабля**: брокер отдал воркеру все сообщения, воркер обрабатывает их по одному, остальные лежат в его памяти. Упал воркер — потерял пачку; перезапустился — взял ещё. Второй воркер при этом простаивает, потому что очередь «пуста» для него |

```python
# prefetch — это не оптимизация, а граница между «буфер» и «ловушка»
channel.basic_qos(prefetch_count=20)
```

## Kafka: когда она оправдана и почему порядок узкий

Kafka — журнал. Партиции — отдельные упорядоченные журналы внутри топика. Три свойства, которые надо знать до внедрения:

| Свойство | Механизм | Следствие для проектирования |
| --- | --- | --- |
| Порядок | гарантирован **только внутри партиции** | два обновления одного документа должны попасть в одну партицию |
| Как это обеспечить | ключ сообщения: `hash(key) % partitions` | ключ = `document_id` или `tenant_id`, но не `null` |
| Consumer group | партицию читает один потребитель группы | для масштабирования потребителя нужны партиции, не больше |
| Rebalancing | при падении потребителя его партиции переходят к другим | при большом числе потребителей ребалансировка становится дорогой |
| Ретенция | по времени (`--retention.ms`) и по размеру (`--retention.bytes`) | «журнал истины» с лимитом: старые события удаляются без предупреждения |

```bash
docker run -d --name kafka --hostname kafka -p 127.0.0.1:9092:9092 \
  -e KAFKA_NODE_ID=1 \
  -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 \
  -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092 \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:9093 \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
  -e KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0 \
  confluentinc/cp-kafka:7.6

# топик с ключом на партицию — порядок по документу сохранится
docker exec kafka kafka-topics --bootstrap-server localhost:9092 --create \
  --topic rag.events --partitions 6 --replication-factor 1 \
  --config retention.ms=604800000 --config retention.bytes=10737418240

docker exec kafka kafka-console-consumer --bootstrap-server localhost:9092 \
  --topic rag.events --from-beginning --max-messages 5 \
  --property print.key=true --property key.separator=$'\t'
```

> [!CAUTION]
> Собирать Kafka ради одного воркера — это эксплуатационные расходы без
> выгоды: три сервиса вместо одного, ZooKeeper или KRaft, настройка
> `min.insync.replicas`, `acks`, ребалансировка, разбор consumer group.
> Оправдана она ровно там, где поток событий нужен **нескольким
> независимым** потребителям (аналитика, обучение, аудит), и поток
> измеряется тысячами сообщений в секунду. На трёх десятках задач индексации
> в минуту ты проигрываешь, а не выигрываешь.

## Идемпотентность: тема, на которой строится всё остальное

Очередь доставит сообщение повторно. Не «может доставит», а доставит: после падения воркера между `ack` и следующим `ack` сообщение вернётся заново. Поэтому **обработка обязана быть безопасна при повторе**, и это не оптимизация, а условие корректности.

| Приём | Как | Когда применять |
| --- | --- | --- |
| Естественная идемпотентность | операция сама по себе повторяема: `INSERT … ON CONFLICT DO UPDATE`, `SET x = x + 1`, перезаписать ключ | встроенные векторы и векторный поиск — идеальный случай |
| Уникальный ключ в БД | уникальный индекс на `(document_id, model_version)`, повтор → `conflict do nothing` | индексация, выгрузка отчётов |
| Флаг в БД | `processed_tasks(job_id)` → `INSERT` перед обработкой | когда операция тяжёлая и не выражается одним запросом |
| Детерминированный ключ | `chunk_id = hash(document_id + page + model_version)` | избавляет от дублей на уровне данных |
| Неидемпотентно + отдельный токен | ключ идемпотентности в заголовке сообщения, сервис кладёт его в БД | платёжные и внешние API |

```sql
-- идемпотентная вставка чанка: повторный воркер не создаст дубль
-- ($1..$4 — параметры подготовленного запроса; в psycopg 3 это %s, %s, %s, %s)
CREATE TABLE doc_chunks (
  id          BIGSERIAL PRIMARY KEY,
  chunk_id    TEXT NOT NULL,
  document_id BIGINT NOT NULL,
  model_version TEXT NOT NULL,
  embedding   vector(1024) NOT NULL,
  indexed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON doc_chunks (chunk_id);

INSERT INTO doc_chunks (chunk_id, document_id, model_version, embedding)
VALUES ($1, $2, $3, $4)
ON CONFLICT (chunk_id) DO UPDATE
  SET indexed_at = now()
RETURNING (xmax = 0) AS was_inserted;   -- false = это был повтор, а не новая работа

-- вариант «пропустить совсем» для нагрузки на эмбеддинг
INSERT INTO doc_chunks (chunk_id, document_id, model_version, embedding)
SELECT $1, $2, $3, $4
WHERE NOT EXISTS (SELECT 1 FROM doc_chunks WHERE chunk_id = $1)
ON CONFLICT (chunk_id) DO NOTHING;
```

Побочный эффект: наличие уникального индекса превращает повторную доставку из бага в дешёвую операцию, и появляется метрика «сколько сообщений оказалось дублями» — лучший индикатор частых падений воркера.

## DLQ и «ядовитое» сообщение

Сообщение, которое ломает воркер, будет приходить снова и снова. Варианты поведения:

| Стратегия | Что получится |
| --- | --- |
| `nack(requeue=True)` вечно | горячий цикл: воркер 100% CPU, очередь не двигается, все нормальные сообщения зажаты за ядовитым |
| Фиксированное число попыток без DLQ | сообщение исчезает тихо; через неделю выясняется, что 30 документов не проиндексированы |
| DLQ с лимитом попыток | сообщение попадает в отдельную очередь, её видно в метриках, её разбирает человек |

Схема с пересчётом попыток в заголовке выглядит так: воркер при ошибке **не возвращает** сообщение в основную очередь, а публикует его обратно в очередь `retry` с увеличенным счётчиком; у `retry` есть `x-message-ttl` и DLX обратно в основную очередь, поэтому сообщение возвращается через задержку, а не мгновенно. Именно так реализуется backoff без sleep'а в воркере.

У quorum-очередей есть встроенный счётчик доставок: `x-delivery-limit` в аргументах, и при его превышении сообщение уходит в DLX сам, без участия кода. Значение по умолчанию тоже существует (порядка 20) и в разных версиях менялось — задавай его явно и проверяй фактическое поведение на своей версии.

## Наблюдаемость очередей: четыре метрики и три алерта

| Метрика | О чём говорит | Алерт |
| --- | --- | --- |
| Длина очереди (`messages_ready`) | поток задач не успевает или обработка встала | растёт дольше 10 минут — тревога |
| Время ожидания (`oldest_message_age`, если брокер его отдаёт) | сколько задача ждёт начала работы | больше порога — предупреждение |
| `messages_unacked` | потребители взяли и не отпустили | растёт при падении обработки |
| Скорость ретраев и DLQ | обработка систематически падает | любое попадание в DLQ — разбирать вручную |

```yaml
# observability/prometheus-rules-queues.yml
groups:
  - name: queues
    rules:
      - alert: QueueGrowing
        expr: rate(rabbitmq_queue_messages_ready{queue="rag.index"}[10m]) > 0
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "Очередь rag.index растёт: +{{ $value | printf \"%.1f\" }} сообщ/мин"
          description: "Потребители не успевают. Проверь CPU воркеров, latency БД и LLM-шлюза."

      - alert: QueueNotDraining
        expr: rabbitmq_queue_messages_ready{queue="rag.index"} > 5000
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "Очередь индексации не разгребается"

      - alert: ConsumersGone
        expr: rabbitmq_queue_consumers{queue="rag.index"} == 0
        for: 3m
        labels: { severity: critical }
        annotations:
          summary: "Ни одного потребителя на rag.index — задачи копятся молча"

      - alert: DeadLetterNotEmpty
        expr: rabbitmq_queue_messages_ready{queue="rag.index.dead"} > 0
        labels: { severity: warning }
        annotations:
          summary: "В мёртвой очереди {{ $value }} сообщений — их разбирает человек"
```

> [!IMPORTANT]
> «Очередь растёт» — лучший ранний признак проблемы во всей ИИ-системе.
> Она растёт раньше, чем вырастет латентность API (пользователь ещё не
> заметил), раньше, чем кончится место на диске, и раньше, чем упадёт
> воркер по таймауту. Поэтому метрика длины очереди должна быть на
> главном дашборде, а не в отчёте за месяц. Схема алертов —
> из [лекции об Alertmanager](devops/17-grafana-loki-alerty.md).

## Практика: воркер на RabbitMQ и на PostgreSQL

### Полный воркер на RabbitMQ

```python
# /opt/llmops/indexer/worker.py
import json, logging, os, socket, time
import pika, psycopg

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("indexer")

PARAMS = pika.URLParameters(
    "amqp://llmops:%s@rabbit:5672/%%2F" % os.environ["RABBIT_PASSWORD"]
)
MAX_ATTEMPTS = 5
RETRY_DELAY_MS = 30_000

def connect():
    """Переподключение: брокер может перезапуститься, и это не повод падать."""
    while True:
        try:
            return pika.BlockingConnection(PARAMS)
        except pika.exceptions.AMQPConnectionError:
            log.warning("rabbitmq недоступен, повтор через 5 с")
            time.sleep(5)

def process(payload: dict) -> None:
    """Сама работа. Идемпотентность — здесь: повтор не создаёт дубль."""
    chunk_id = payload["chunk_id"]
    with psycopg.connect(os.environ["PG_DSN"]) as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO doc_chunks (chunk_id, document_id, model_version, embedding)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (chunk_id) DO NOTHING""",
            (chunk_id, payload["document_id"], payload["model_version"], payload["embedding"]),
        )
        if cur.rowcount == 0:
            log.info("дубль %s пропущен (был повтор)", chunk_id)

def handle(ch, method, props, body):
    attempts = int(props.headers.get("x-attempts", 0)) + 1
    try:
        process(json.loads(body))
    except Exception as exc:                       # noqa: BLE001 — ловим всё, решение ниже
        log.exception("ошибка обработки (попытка %d/%d)", attempts, MAX_ATTEMPTS)
        if attempts >= MAX_ATTEMPTS:
            # requeue=False — сообщение уходит в DLX, то есть в rag.index.dead
            ch.basic_nack(method.delivery_tag, requeue=False)
            return
        # в очередь с TTL: сообщение вернётся через задержку, а не мгновенно
        ch.basic_publish(exchange="", routing_key="rag.index.retry",
                         body=body, properties=pika.BasicProperties(
                             headers={"x-attempts": attempts}, delivery_mode=2))
        ch.basic_ack(method.delivery_tag)           # эту копию обработали
    else:
        ch.basic_ack(method.delivery_tag)

def main():
    conn = connect()
    ch = conn.channel()
    ch.basic_qos(prefetch_count=20)                # ровно столько, сколько воркер успевает
    for q in ("rag.index", "rag.index.retry"):
        ch.queue_declare(queue=q, durable=True)
    ch.basic_consume(queue="rag.index", on_message_callback=handle, auto_ack=False)
    log.info("воркер %s на связи, жду задачи", socket.gethostname())
    try:
        ch.start_consuming()
    except KeyboardInterrupt:
        ch.stop_consuming()
    finally:
        conn.close()

if __name__ == "__main__":
    main()
```

```bash
# наполнить очередь и посмотреть, как всё это себя ведёт
for i in $(seq 1 200); do
  curl -s -u "llmops:$RABBIT_PASSWORD" -H 'Content-Type: application/json' \
    -XPOST localhost:15672/api/exchanges/%2F/amq.default/publish \
    -d "{\"properties\":{},\"routing_key\":\"rag.index\",\"payload\":\"{\\\"chunk_id\\\":\\\"doc-77-$i\\\",\\\"document_id\\\":77,\\\"model_version\\\":\\\"v1\\\",\\\"embedding\\\":\\\"[0.1,0.2]\\\"}\",\"payload_encoding\":\"string\"}" > /dev/null
done
curl -s -u "llmops:$RABBIT_PASSWORD" 'localhost:15672/api/queues/%2F/rag.index' | python3 -m json.tool | head -20

# повторно отправить те же 200 задач: дублей в базе быть не должно
psql "$PG_DSN" -c "SELECT count(*) FROM doc_chunks WHERE document_id = 77;" -c "SELECT count(DISTINCT chunk_id) FROM doc_chunks WHERE document_id = 77;"
```

### Та же очередь на PostgreSQL

Та же задача без брокера: таблица задач со статусом, воркер забирает пачку блокировкой строк.

```sql
CREATE TABLE index_jobs (
  id             BIGSERIAL PRIMARY KEY,
  document_id    BIGINT NOT NULL,
  chunk_id       TEXT NOT NULL UNIQUE,
  payload        JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending|running|done|failed
  attempts       INT  NOT NULL DEFAULT 0,
  last_error     TEXT,
  locked_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON index_jobs (status, id) WHERE status = 'pending';

UPDATE index_jobs SET status = 'running', locked_at = now()  -- мгновенно, не дожидаясь транзакции
WHERE id IN (
  SELECT id FROM index_jobs
  WHERE status = 'pending'
  ORDER BY id
  LIMIT 10
  FOR UPDATE SKIP LOCKED                -- чужие заблокированные строки просто пропускаем
)
RETURNING *;
```

```python
# воркер: один захват — одна транзакция
def fetch_batch(dsn: str, limit: int = 10) -> list[dict]:
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            """UPDATE index_jobs SET status='running', locked_at=now(), attempts=attempts+1
               WHERE id IN (SELECT id FROM index_jobs WHERE status='pending'
                            ORDER BY id LIMIT %s FOR UPDATE SKIP LOCKED)
               RETURNING *""", (limit,))
        rows = cur.fetchall()
        conn.commit()
        return [dict(zip([c.name for c in cur.description], r)) for r in rows]
```

Почему `SKIP LOCKED` — это правильно, а альтернативы нет: без него параллельные воркеры выстраиваются в очередь за одним и тот же блокировкой, и вся параллельность теряется. Побочная цена — мёртвые строки в статусе `running`, если воркер упал: их надо возвращать в `pending` по условию `locked_at < now() - интервал '10 минут'`, и это отдельная задача по расписанию, про которую забывают ровно один раз.

| Свойство | RabbitMQ | PostgreSQL `SKIP LOCKED` |
| --- | --- | --- |
| Новый сервис в инфраструктуре | да | нет |
| Маршрутизация, приоритеты, DLX из коробки | да | нет, делаешь сам |
| Наблюдаемость без отдельной системы | метрики брокера | нужно самому отдавать в Prometheus |
| Согласованность с данными | «записали в БД — отправили в очередь», нужна аккуратность | одна транзакция на всё |
| Потеря задачи при сбое | брокер переживает перезапуск | «зависшие» строки возвращаются по таймеру |
| Когда выбирать | много типов задач, разные потребители | задачи живут рядом с данными, их десятки |

## Где это ломается

- **`nack(requeue=True)` в цикле.** Одно ядовитое сообщение забирает 100% CPU одного воркера и блокирует всю очередь. Проверяется это просто: положи в очередь заведомо битый документ и посмотри, как едут нормальные.
- **Prefetch не выставлен или выставлен в ноль.** Брокер отдал все сообщения одному воркеру, второй простаивает, а падение первого теряет пачку.
- **Обработка не идемпотентна.** Воркер упал после записи в базу, но до `ack` — при повторе появился дубль. Симптом через месяц: в выдаче RAG один и тот же фрагмент дважды, а модель уверенно ссылается на «источник 4» два раза.
- **Нет лимита попыток.** Сообщение возвращается до бесконечности, и оно же блокирует пачку нормальных. Правило: лимит попыток + DLQ + alert «в DLQ не пусто».
- **Нет обратного давления.** Продюсер шлёт быстрее, чем воркер успевает, очередь растёт, память кончается. Нужен лимит на длину очереди у брокера либо проверка перед публикацией в приложении.
- **Две операции без транзакции: «записать в БД» и «отправить в очередь».** Упало между ними — задача потеряна навсегда и никто не узнает. Решение: outbox-паттерн — в одной транзакции пишешь и в таблицу, и в `outbox`, а отдельный процесс разносит `outbox` в брокер с дедупликацией по ключу.
- **Очередь без метрик.** Воркер молча стоит, очередь растёт, но это видно только потому, что пользователь пожаловался. Алерт `ConsumersGone == 0` ловит это за три минуты.
- **Одна очередь на всё.** Заливка корпуса, отчёты и уведомления в одной очереди — и отчёт, ради которого ждут пять минут, встаёт за тысячей чанков. Разделяй по приоритету: отдельная очередь или отдельный ключ маршрутизации.
- **«Мы обработали 5000 задач» в отчёте без проверки дублей.** Считать нужно `count(distinct chunk_id)`, а не `count(*)`, иначе повторные доставки незаметно завышают отчёт.

## Чек-лист понимания

- [ ] Я могу назвать пять задач в ИИ-системе, которые не должны выполняться внутри HTTP-запроса, и объяснить, что даёт очередь помимо ответа «быстро пользователю»
- [ ] Я выбираю между Redis Streams, RabbitMQ, Kafka и `SKIP LOCKED` осознанно и знаю, что стоит за словами «маршрутизация», «порядок в партиции» и «потребительская группа»
- [ ] Я понимаю разницу между `ack`, `nack(requeue=True)` и `nack(requeue=False)` и знаю, почему бесконечный requeue хуже мёртвой очереди
- [ ] Я объясняю, зачем нужен prefetch и что происходит при `prefetch_count=0` для второго воркера
- [ ] Я умею обеспечить идемпотентность через уникальный ключ в БД и знаю, что `chunk_id` должен быть детерминированным
- [ ] Я настроил лимит попыток и DLQ и умею объяснить, как сообщение возвращается с задержкой, а не сразу
- [ ] Я умею перенести ту же очередь на PostgreSQL через `FOR UPDATE SKIP LOCKED` и знаю, зачем нужен сбор «зависших» строк
- [ ] У меня в Prometheus есть алерты на рост очереди, отсутствие потребителей и непустую мёртвую очередь

Дальше — [API-шлюз](mlops/11-api-shlyuz.md): точка, где все эти очереди, токены и лимиты сходятся в одном месте и где видно, сколько система стоит.