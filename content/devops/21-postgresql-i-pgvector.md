---
title: PostgreSQL и pgvector
track: devops
module: F. Хранилища и интеграции
order: 21
duration: 90 мин
level: middle
tags: [postgresql, pgvector, индексы, vacuum, sql, rds]
summary: Как устроен Postgres как хранилище LLM-системы: одна СУБД вместо трёх, индексы, VACUUM, планы запросов, бэкап с PITR, пул соединений и векторный поиск на pgvector
practice: Подними Postgres на Ubuntu, создай роль rag без суперпользователя, включи pg_stat_statements, собери таблицу doc_chunks с эмбеддингами и HNSW-индексом, выполни top-k поиск с фильтром по tenant_id и created_at, разбери EXPLAIN (ANALYZE, BUFFERS) и сделай pg_dump плюс настрой WAL-архивирование.
---

Предыдущая лекция закрыла тему безопасности контура. Дальше начинается модуль про хранилища и интеграции — то, на чём LLM-система стоит физически. Первым идёт Postgres, потому что это единственная точка, где сходятся сразу три вещи: транзакционные данные приложения, вектора для RAG и служебные метаданные. Разбирать его надо основательно: человек, который не отличает Seq Scan от Index Scan, не сможет ни объяснить, почему RAG «стал медленным после роста базы», ни принять решение «а не пора ли выносить вектора в отдельный сервис».

## Почему LLM-система выбирает Postgres

Типовой проект «корпоративный ассистент» тянет за собой три хранилища сразу: реляционную базу с пользователями, диалогами, тикетами и квотами; векторное хранилище с эмбеддингами чанков; и кэш/очередь. Три сервиса — три бэкапа, три мониторинга, три источника рассинхронизации. Postgres со расширением pgvector закрывает первые два в одном процессе, а кэш живёт в Redis, про который следующая лекция.

Что именно лежит в одной базе:

| Объект | Таблица | Зачем |
| --- | --- | --- |
| Чанки документов | `doc_chunks` с колонкой `embedding vector(N)` | векторный поиск по смыслу |
| Права на чанки | `acl_groups text[]` в той же строке | фильтр доступа в том же запросе, без второго сервиса |
| Процесс индексации | `documents`, `index_jobs` со статусом и прогрессом | одна транзакция на «записать документ и его чанки» |
| Диалоги и цитаты | `conversations`, `citations` | история для оценки качества, обучение ранжирования |
| Квоты и биллинг | `usage_events` | агрегаты по токенам для отчёта руководителю |
| Аудит | `audit_log` | кто и когда дёргал RAG, по контуру из лекции про безопасность |

Последние две строки обычно недооценивают. Квоты в LLM-системе — это не «счётчик», а финансовый контроль: один цикл с агентом может сделать 40 вызовов модели, и без учёта по `tenant`/`user_id` ты узнаёшь о счёте из счёта от провайдера.

## Установка: кластер, сервис, первый запрос

На Ubuntu Postgres ставится пакетом и сразу создаёт кластер. Именно кластер, а не «инстанс»: `pg_ctlcluster 16 main start` управляет конкретным кластером, и это важно, когда у тебя их два — прод и бэкап-стенд, или когда ты готовишь `pg_upgrade` к новой мажорной версии.

```bash
apt install -y postgresql-16 postgresql-client-16 postgresql-contrib-16
pg_lsclusters                     # видишь: 16 main 5432 online start

pg_ctlcluster 16 main start      # вручную, без systemd
systemctl enable --now postgresql  # через systemd, постоянно
systemctl status postgresql

# кто слушает
ss -tulpn | grep 5432

# вход: системный пользователь postgres соответствует роли postgres (peer)
sudo -u postgres psql -c "SELECT version(), current_user;"
sudo -u postgres psql -c "SHOW data_directory;"
```

Ключевой момент про файлы данных. `SHOW data_directory` обычно отдаёт `/var/lib/postgresql/16/main`. Внутри лежат подкаталоги по базам в `base/`, плюс `global/` с общими каталогами, `pg_wal/` с журналом упреждающей записи и `pg_stat_tmp/` со статистикой. Отсюда практический вывод: **бэкап — это не `cp -r` каталога**. Копировать работающий клатер можно только средствами самого Postgres, иначе получишь неконсистентный снимок.

```bash
# клиент: подключение к удалённому хосту, без интерактива
PGPASSWORD='***' psql -h 10.10.10.20 -U rag -d ragdb -c "SELECT 1;"
psql -h 10.10.10.20 -U rag -d ragdb -c "\conninfo"     # откуда реально подключились
```

## Аутентификация: pg_hba.conf

`pg_hba.conf` — файл правил доступа, и читается он **сверху вниз до первого совпадения**. Это главная причина «я поменял настройку, а ничего не изменилось»: новое правило оказалось ниже старого, которое уже сматчилось.

Три метода, которые встретишь чаще всего:

| Метод | Что проверяет | Где применять | В проде |
| --- | --- | --- | --- |
| `peer` | системного пользователя ОС с ролью Postgres той же имени | `local` на самой машине: `sudo -u postgres psql` | да, для администрирования |
| `scram-sha-256` | пароль, хранится как хеш в самой БД | все TCP-подключения приложений | да, единственный выбор |
| `trust` | ничего | только в тестах, когда БД поднята на 127.0.0.1 и стёрта после | **никогда** |
| `md5` | пароль, но хеш MD5 | только для старых клиентов без SCRAM | нет, это простоявший дыру формат |

```conf
# /etc/postgresql/16/main/pg_hba.conf — правила для локальной машины и сети
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             postgres                                peer
local   all             all                                     peer
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             ::1/128                 scram-sha-256
# приложение подключается только из внутренней подсети, не из всего мира
host    ragdb           rag             10.10.10.0/24           scram-sha-256
host    all             all             0.0.0.0/0               reject
```

> [!WARNING]
> `local all all trust` — это не «быстро настроить», а публичный вход в базу
> для любого локального пользователя. На хосте, где есть контейнеры, веб-сервер
> или скомпрометированная учётка, это путь к полному доступу к данным
> приложения. Включил `trust`, чтобы «поднять» — поставь `scram-sha-256`
> до того, как на этот порт придёт хоть один запрос извне.

Правило `reject` в конце — осознанная защита: любой адрес, который не попал в список выше, получает отказ явно, а не падает на таймауте.

После правки файла:

```bash
pg_ctlcluster 16 main reload            # или systemctl reload postgresql
sudo -u postgres psql -c "SHOW hba_file;"
sudo -u postgres psql -c "SELECT type, database, user_name, address, auth_method FROM pg_hba_file_rules;"
```

## Роли и права: приложению — не суперпользователь

Роль — это именованный набор прав, она существует независимо от того, есть ли у неё пароль. Логин даётся только той роли, которая подключается по сети; всё остальное — для скриптов и миграций, и работает через `peer` или `SET ROLE`.

```sql
-- роль для приложения: логин, пароль, ресурсные лимиты
CREATE ROLE rag LOGIN PASSWORD '***'
  CONNECTION LIMIT 20
  IN ROLE app_reader;

-- базу создаёт суперпользователь и сразу отдаёт владельцу
CREATE DATABASE ragdb OWNER rag;
\c ragdb
CREATE EXTENSION IF NOT EXISTS vector;   -- расширения ставит суперпользователь
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

GRANT CONNECT ON DATABASE ragdb TO rag;
GRANT USAGE, CREATE ON SCHEMA public TO rag;   -- с PG15 public-схема закрыта от всех

-- логины: pg_hba отредактирован, пароль задан интерактивно, чтобы не светить его в истории
\password rag
```

Проверка «а не слишком ли много я дал» — одна команда:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin,
       rolconnlimit, rolpassword IS NOT NULL AS has_password
FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' ORDER BY rolsuper DESC;

-- какие права реально есть у роли
SELECT has_database_privilege('rag','ragdb','CREATE')  AS can_create_db,
       has_schema_privilege('rag','public','CREATE')  AS can_create_schema,
       has_table_privilege('rag','doc_chunks','DELETE') AS can_delete_rows;
```

> [!IMPORTANT]
> Почему приложению нельзя давать суперпользователя: такой доступ означает
> возможность читать и писать любые данные на инстансе, отключать
> `log_statement`, менять `pg_hba.conf` через `ALTER SYSTEM` и выгружать
> `pg_authid` с хешами паролей всех ролей. Одна SQL-инъекция в промпте
> пользователя — и злоумышленник получил не одну таблицу, а весь инстанс.

Соединение по Unix-сокету против TCP — не стилистика. Сокет даёт `peer`-аутентификацию, то есть пароль не передаётся вообще; TCP даёт `scram-sha-256` с защищённым каналом. Для приложения, запущенного на том же хосте, сокет строго лучше.

## Индексы: B-tree, GIN, BRIN и когда их нет

Индекс — не ускорение всего подряд, а отдельная структура, которая ускоряет конкретный класс запросов и при этом замедляет вставку и ест память и место на диске. Отсюда правило: индекс ставится под конкретный запрос, и если ты не можешь назвать этот запрос — индекс не нужен.

| Тип индекса | Что ускоряет | Где применяется в LLM-системе |
| --- | --- | --- |
| B-tree (default) | `=`, `<`, `>`, `BETWEEN`, `ORDER BY` с направлением | `tenant_id`, `created_at`, `conversation_id`, уникальность `chunk_id` |
| B-tree составной | несколько условий с AND | `(tenant_id, created_at DESC)` — главный индекс фильтра в RAG |
| GIN | массивы, JSONB, полнотекстовые векторы | `acl_groups text[]` через `&&`, `tsvector` для полнотекста |
| GiST | геометрия, диапазоны, близость по произвольной метрике | гео-фильтр, диапазон версий документа |
| BRIN | огромные таблицы, значения физически упорядочены | `audit_log` и `usage_events` по времени — в 100 раз меньше места, чем B-tree |
| Частичный (partial) | подмножество строк | только активные задачи: `WHERE status = 'pending'` |
| HNSW (pgvector) | поиск ближайших соседей | `embedding` в RAG |

```sql
CREATE INDEX idx_chunks_tenant_created
  ON doc_chunks (tenant_id, created_at DESC);

-- частичный индекс: в 50 раз меньше строк, чем полный
CREATE INDEX idx_jobs_pending ON index_jobs (created_at)
  WHERE status = 'pending';

-- BRIN для журнала: помнит диапазоны страниц, а не каждое значение
CREATE INDEX idx_usage_created_brin ON usage_events USING brin (created_at)
  WITH (pages_per_range = 32);

-- GIN под массив прав доступа — ключ `&&` использует его
CREATE INDEX idx_chunks_acl ON doc_chunks USING gin (acl_groups);
```

Порядок колонок в составном индексе решает всё. Правило: сначала колонки со строгим равенством, потом колонки диапазона, потом колонки сортировки. Индекс `(tenant_id, created_at)` отвечает на запрос «все чанки конкретного арендатора за период» и может вернуть их уже отсортированными без отдельного `ORDER BY`. Индекс `(created_at, tenant_id)` на тот же запрос не сработает: Postgres умеет использовать составной индекс только начиная с первой колонки.

> [!TIP]
> Не создавай индекс на каждую колонку «на всякий случай». Два индекса на
> пересекающихся колонках — это дублирование, которое ускоряет почти
> ничего и утяжеляет каждую вставку. Начинай с одного составного индекса
> под главный запрос и добавляй по факту `EXPLAIN`.

## Транзакции и изоляция

Postgres использует MVCC: при обновлении строка не перезаписывается, а помечается версией, и старая остаётся видимой для тех, кто начал читать раньше. Отсюда и `DELETE`, который ничего не удаляет физически, и VACUUM как отдельная процедура.

| Уровень | Что гарантирует | Цена | Когда нужен |
| --- | --- | --- | --- |
| Read Committed | видно всё, что закоммичено к моменту чтения строки | нет блокировок на чтении | **по умолчанию для 95% приложений** |
| Repeatable Read | вся транзакция видит один снимок | больше работы с vacuum, возможен `40001` | отчёты, которые должны быть согласованы |
| Serializable | как RR плюс гарантия сериализуемости | `40001` при конфликтах, нужны ретраи | перевод денег, недетерминированные зависимости |
| Read Uncommitted | ничего | читает грязное | никогда |

Почему READ COMMITTED хватает для RAG и чата: запрос поиска читает один снимок и возвращает результат пользователю; если между двумя `SELECT` в приложении данные изменились — это не ошибка базы, а нормальная грязная логика чтения, которую надо решать в коде. Исключение — деньги и квоты: там, где два параллельных запроса могут перерасходовать лимит, нужен явный `SELECT ... FOR UPDATE` или сериализуемая транзакция с ретраями.

```sql
BEGIN;
SELECT quota_left FROM usage_quotas WHERE user_id = $1 FOR UPDATE;
UPDATE usage_quotas SET quota_left = quota_left - $2 WHERE user_id = $1;
COMMIT;
```

## VACUUM: почему таблица пухнет

Аналогия, которая работает: в Python после `del obj` объект не исчезает мгновенно — его удерживает счётчик ссылок, и память освободится только когда сборщик мусора дойдёт до него. В Postgres ровно то же, только вместо счётчика ссылок — снимки транзакций. `DELETE` ставит невидимую метку «мёртвая версия», а место переиспользуется, только когда **все** транзакции, которые могли увидеть эту строку, завершились. Пока жива хотя бы одна долгая транзакция — мёртвые строки нельзя убрать никому.

Отсюда две разные проблемы, которые часто путают:

- **bloat** — таблица на диске больше, чем данные в ней. Место внутри переиспользуется, но страницы фрагментированы, и сканы читают больше страниц, чем нужно. Файл на диске при этом не уменьшается: `VACUUM` не сжимает файл, для этого нужен `VACUUM FULL` или `pg_repack`.
- **рост мёртвых строк** — их просто не вычищают, и таблица разрастается линейно по числу `UPDATE` и `DELETE`.

```sql
-- что происходит с таблицами прямо сейчас
SELECT relname,
       n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum, last_autoanalyze, vacuum_count, autovacuum_count
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC LIMIT 10;

-- точная оценка bloat (расширение pgstattuple)
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT * FROM pgstattuple('doc_chunks');   -- dead_tuple_percent, free_percent

-- кто держит транзакцию и мешает vacuum
SELECT pid, state, now() - xact_start AS age, left(query, 120) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 10;

-- ручной запуск: сначала обычный, с анализом
VACUUM (ANALYZE) doc_chunks;
-- сжатие файла: блокирует таблицу, для прод-окна
VACUUM FULL doc_chunks;
```

Автовакуум включён по умолчанию, но его пороги заданы консервативно и не учитывают твой профиль. В RAG-базе, где чанки перезаписываются при переиндексации, дефолтные `autovacuum_vacuum_scale_factor = 0.2` означают «не трогать таблицу, пока не накопится 20% мёртвых строк» — а это часы работы.

```sql
ALTER TABLE doc_chunks SET (
  autovacuum_vacuum_scale_factor  = 0.02,
  autovacuum_vacuum_threshold     = 1000,
  autovacuum_vacuum_cost_delay    = 2,     -- ускоряет проход по большой таблице
  autovacuum_analyze_scale_factor = 0.01
);
```

> [!CAUTION]
> Самая частая причина «VACUUM не помогает, база всё равно растёт» — открытая
> транзакция. Репликация, пул соединений с `pool_mode = session`, забытый
> `psql` в терминале или дефолтный `idle_in_transaction_session_timeout = 0`
> держат снимок неделями. Сначала найди и закрой старые транзакции
> (`pg_stat_activity` выше), потом настраивай пороги.

## План запроса: EXPLAIN (ANALYZE, BUFFERS)

`EXPLAIN` показывает, что планировщик *собирается* сделать. `EXPLAIN ANALYZE` — что он *реально* сделал, с фактическим временем и числом строк. Разница между оценкой и фактом — это и есть диагноз.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content FROM doc_chunks
WHERE tenant_id = 42 AND created_at >= now() - interval '7 days'
ORDER BY created_at DESC LIMIT 20;

-- типичный результат и как его читать:
-- Limit  (cost=8.45..9.02 rows=20) (actual time=0.311..0.402 rows=20 loops=1)
--   ->  Index Scan using idx_chunks_tenant_created on doc_chunks
--         (cost=0.42..8.96 rows=1136) (actual time=0.289..0.371 rows=847)
--         Index Cond: (tenant_id = 42)
--         Buffers: shared hit=42
```

Читать план надо сверху вниз по строкам с наибольшим `actual time`:

- **Seq Scan** на большой таблице, возвращающий 20 строк — почти всегда ошибка планировщика или отсутствие индекса. Seq Scan на 5 строк из 5 — правильное решение, не трогай.
- **rows=1136 (оценка) против rows=847 (факт)** — расхождение больше чем в 10 раз говорит, что статистика устарела. Лечится `ANALYZE`, а не подгонкой индекса.
- **Buffers: shared hit=42, read=0** — всё из кэша. Если `read` большой и растёт — данных больше, чем памяти сервера, и тут поможет уже не Postgres, а архитектура.
- **Nested Loop с миллионами loops** — вложенный цикл, где внешняя выборка маленькая, а внутренняя идёт по индексу. Нормально. Если внутренняя идёт по Seq Scan — проблема.

```sql
-- диагностика «планировщик ошибся»: принудительный план ТОЛЬКО для проверки
BEGIN;
SET LOCAL enable_seqscan = off;
EXPLAIN (ANALYZE) SELECT ... ;   -- если план стал Index Scan и стал быстрее — индекс нужен
ROLLBACK;                        -- и никогда не оставляй enable_seqscan=off в проде

-- обновление статистики после массовой загрузки
ANALYZE doc_chunks;
```

## Медленные запросы и их бюджет

Ловить медленные запросы двумя способами: по порогу времени (быстро настроить, но пишет в лог каждый длинный запрос) и статистикой (собирает агрегаты, дешевле, но требует `pg_stat_statements`).

```sql
-- /etc/postgresql/16/main/conf.d/20-slowsql.conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 5000
pg_stat_statements.track = all        # считать и клиентские запросы изнутри функции
log_min_duration_statement = 500      # логировать всё, что дольше 500 мс
log_checkpoints = on
log_lock_waits = on
log_temp_files = 0                   -- сколько данных ушло в tmpfs на запрос
```

```sql
SELECT calls, round(total_exec_time) AS total_ms,
       round(mean_exec_time, 2) AS mean_ms,
       round(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       left(query, 100) AS query
FROM pg_stat_statements s
JOIN pg_database d ON d.oid = s.dbid
WHERE d.datname = 'ragdb'
ORDER BY total_exec_time DESC LIMIT 15;
```

Два вывода, которые видно сразу. Первый: `hit_pct` ниже 99% означает, что база не помещается в память и упирается в диск — лечится памятью или `work_mem`, а не индексом. Второй: запрос, который вызывается 400 тысяч раз в сутки по 3 мс, важнее запроса на 5 секунд, который случился один раз. Суммарное время, а не максимум.

> [!TIP]
> Алерты на метрики Postgres настраиваются теми же способами, что и в
> [лабораторной лекции](devops/18-lab-proxmox-monitoring.md): экспортёр
> `postgres_exporter` отдаёт `pg_stat_database_*`, а алерт вешается на
> `rate(pg_stat_database_xact_commit[5m])` и на рост
> `pg_stat_database_deadlocks`.

## Бэкап: три уровня, три инструмента

| Инструмент | Что копирует | Гранулярность | Для чего | Ограничение |
| --- | --- | --- | --- | --- |
| `pg_dump` | логический дамп | одна база | перенос на другой сервер, seed для dev | медленно на больших объёмах, не для PITR |
| `pg_dumpall` | логический дамп | кластер: базы + роли + таблицы пространства | пересоздание кластера | медленнее, глобальные объекты отдельно |
| `pg_basebackup` | физическая копия | весь кластер | репликация, PITR, быстрый старт standby | не переносится на другую мажорную версию |
| WAL-архивирование | журнал изменений | с точностью до секунды | point-in-time recovery | требует места и настроенного `archive_command` |
| Логическая репликация | поток изменений | таблицы подписки | миграция между мажорными версиями | только DML, сложнее |

```bash
# логический дамп: кастомный формат, сжатие, параллельно
pg_dump -h 10.10.10.20 -U rag -d ragdb -Fc -Z6 -j4 -f /backup/ragdb_$(date +%F).dump
pg_restore -l /backup/ragdb_2026-10-12.dump | head        # что внутри, до восстановления
pg_restore -d ragdb_test --clean --if-exists /backup/ragdb_2026-10-12.dump

# физическая база для PITR
pg_basebackup -h 10.10.10.20 -U replicator -D /var/lib/postgresql/16/standby \
  -X stream -c fast -P

# WAL-архивирование: постреймовая репликация
psql -U postgres -c "ALTER SYSTEM SET archive_mode = on;"
psql -U postgres -c "ALTER SYSTEM SET archive_command = 'test ! -f /wal/%f && cp %p /wal/%f';"
psql -U postgres -c "ALTER SYSTEM SET wal_level = replica;"
systemctl restart postgresql
```

Восстановление на момент времени — это «поднять копию `pg_basebackup` и долить из архива WAL до нужной секунды»:

```conf
# postgresql.auto.conf на восстанавливаемом сервере
restore_command = 'cp /wal/%f %p'
recovery_target_time = '2026-10-12 09:14:22+03'
recovery_target_action = 'promote'
```

> [!WARNING]
> `pg_dump` — не бэкап прода. Он не содержит состояния на конкретный момент
> между дампами: если последний дамп был в 03:00, а инцидент в 09:14, потеряно
> шесть часов данных, и `pg_dump` это нигде не покажет. Для прода нужен
> `pg_basebackup` плюс непрерывное WAL-архивирование — как в схеме 3-2-1 из
> [лекции про бэкап и DR](devops/19-backup-i-dr.md). Регулярная проверка:
> восстановление в тестовую среду по расписанию, а не «раз в год вручную».

`pg_upgrade` — отдельная история. Он обновляет мажорную версию (16 → 17) без пересоздания данных: поднимаешь новый кластер, копируешь логические объекты через `pg_dumpall --globals-only`, запускаешь `pg_upgrade --old-datadir --new-datadir`, а потом `vacuumdb --all --analyze-in-stages`. Данные копируются один раз и быстро, но расширения требуют установленных версий в обоих кластерах, а `pg_upgrade` не откатывается — сначала делай снапшот диска ВМ.

## Пул соединений: PgBouncer

Каждое соединение к Postgres — это процесс операционной системы. Двести одновременных соединений — это двести процессов, двести общих буферов, двести переключений контекста, и планировщик, который тратит счётчики на каждое из них. При этом клиентский драйвер с пулом на 10 соединений спокойно обслуживает те же 200 пользователей.

```ini
# /etc/pgbouncer/pgbouncer.ini
[databases]
ragdb = host=10.10.10.20 port=5432 dbname=ragdb

[pgbouncer]
listen_addr = 10.10.10.20
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt      # формат: "rag" "SCRAM-SHA-256$..."
pool_mode = transaction                     # отдаём соединение на время транзакции
max_client_conn = 500
default_pool_size = 25
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 600
query_wait_timeout = 120

[logfile]
logfile = /var/log/pgsql/pgbouncer.log
```

```bash
systemctl enable --now pgbouncer
psql -h 127.0.0.1 -p 6432 -U rag -d ragdb -c "SHOW POOLS;"
psql -h 127.0.0.1 -p 6432 -U rag -d ragdb -c "SHOW STATS;"
```

`pool_mode = transaction` — главное решение. Сервер отдаёт соединение клиенту на время одной транзакции, а не на время сессии. Работает всё, кроме состояния на уровне сессии: `SET` без `LOCAL`, `LISTEN/NOTIFY`, advisory-локи, курсоры без `WITH HOLD`, временных таблиц. Если что-то из этого нужно — `pool_mode = session` или вынести этот случай в другую базу.

> [!CAUTION]
> `auth_type = scram-sha-256` в PgBouncer требует, чтобы секреты ролей были
> доступны посреднику — либо через `auth_file`, либо через
> `auth_query = SELECT usename, passwd FROM pg_shadow`. Без этого пул не
> поднимется. Хранить пароль приложения в открытом виде в `/etc/pgbouncer`
> — ровно тот же антипаттерн, что `.env` в Git, только менее заметный.

## pgvector: типы, метрики, индексы

`pgvector` добавляет в Postgres тип `vector(n)` — фиксированный массив `float4` заданной размерности — и операторы расстояния. Про расширение и `ALTER TABLE ... TYPE vector(N)` под смену модели эмбеддингов уже подробно в [лекции про векторы](mlops/05-embedding-i-vektory.md); здесь — эксплуатационная часть.

| Оператор | Метрика | Оператор индекса | Когда применять |
| --- | --- | --- | --- |
| `<->` | L2 (евклидово) | `vector_l2_ops` | когда векторы не нормализованы и важна абсолютная разница |
| `<=>` | косинусное расстояние | `vector_cosine_ops` | **текстовые эмбеддинги по умолчанию**, шкала 0..2 |
| `<#>` | отрицательное скалярное произведение | `vector_ip_ops` | рекомендательные сценарии, когда важна не величина, а порядок |
| `<+>` | L1 (манхэттенское) | `vector_l1_ops` (pgvector 0.8+) | метрики, обученные на L1 |

Метрика в индексе и метрика в запросе обязаны совпадать, иначе индекс не будет использован вовсе — планировщик не сможет доказать, что порядок один. `ORDER BY embedding <-> $1` при индексе `vector_cosine_ops` даёт `Seq Scan`. Это самая частая причина «HNSW не ускорил».

Тип `halfvec(n)` — та же размерность, но половинная точность: вдвое меньше память индекса, при потере точности расстояния порядка процента. Имеет смысл, когда корпус большой и метрика позволяет.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE doc_chunks (
    id          bigserial PRIMARY KEY,
    chunk_id    text NOT NULL UNIQUE,          -- детерминированный: doc_id + номер чанка
    tenant_id   int  NOT NULL,
    doc_id      text NOT NULL,
    content     text NOT NULL,
    acl_groups  text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    embedding   vector(1024) NOT NULL
);

-- HNSW. m=16 — граф соседей, ef_construction=128 — глубина при построении
CREATE INDEX idx_chunks_hnsw ON doc_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);
```

Параметры, которые стоит понимать: `m` задаёт число связей у узла графа и влияет и на память, и на качество — 8 для коротких текстов, 16–24 для обычных, 48 для длинных. `ef_construction` определяет, насколько тщательно ищутся кандидаты при построении индекса: 128 — рабочее значение, 256–512 даёт лучший recall и заметно более долгую загрузку. Оба меняются только через пересоздание индекса. А вот `hnsw.ef_search` крутится в рантайме без переиндексации — это твой главный рычаг «точность против скорости».

```sql
SET hnsw.ef_search = 100;      -- на сессию, применяется к следующему запросу
SHOW hnsw.ef_search;
```

> [!IMPORTANT]
> Индекс HNSW строится в памяти. Если `maintenance_work_mem` не хватает,
> Postgres переключается на внешнюю сортировку, и вместо построения
> индекса ты получаешь `NOTICE: hnswindex creation only uses
> maintenance_work_mem` и в разы более медленную загрузку. Лечится
> памятью под конкретную сессию сборки:
> `SET maintenance_work_mem = '2GB'; SET max_parallel_maintenance_workers = 4;`

Сравнение HNSW и IVFFlat — то же, что в [лекции о векторных базах](mlops/05-embedding-i-vektory.md), но с поправкой на Postgres: IVFFlat требует переобучения при росте (`lists = rows / 1000`) и плохо переносит данные, добавленные пачками уже после обучения.

| Свойство | HNSW | IVFFlat |
| --- | --- | --- |
| Добавление данных | онлайн, без переобучения | качество падает, нужна пересборка |
| Параметры | `m`, `ef_construction`, `hnsw.ef_search` | `lists`, `probes` |
| Рост корпуса | линейный по памяти, индекс живёт | предсказуемее по памяти |
| Когда выбирать | универсальный RAG, данные прибывают постоянно | большой корпус с известным распределением |

## Фильтрация по метаданным ломает индекс

Это самое важное, что нужно понять про pgvector. Порядок выполнения запроса такой: сначала индекс HNSW выбирает примерно `ef_search` ближайших **по вектору** кандидатов, потом к ним применяется `WHERE`, и только после этого остаётся `LIMIT k`. Если фильтр отсекает 90% кандидатов — из 100 выбранных до тебя дойдут 10, и `LIMIT 20` не наберётся. Запрос не становится «чуть менее точным», он возвращает слишком мало строк.

Три способа это лечить:

1. **Поднимать `ef_search`.** Работает, пока фильтр не слишком селективен. Подбор значения — эксперимент на своей данных.
2. **Итеративный скан** (pgvector 0.8+): `SET hnsw.iterative_scan = relaxed_order;` — поиск продолжает обход графа, пока не наберёт достаточно кандидатов, прошедших фильтр. Это то, что в Qdrant сделано нативно.
3. **Планировать запрос заранее.** Отдельный HNSW-индекс на каждую крупную «изоляцию», чтобы фильтр резко сужал выборку ещё до векторного поиска.

```sql
-- вариант 3: отдельный индекс под одного крупного арендатора
CREATE INDEX idx_chunks_hnsw_tenant42 ON doc_chunks
  USING hnsw (embedding vector_cosine_ops) WHERE tenant_id = 42;

-- вариант 2: итеративный обход вместо фиксированного ef_search
SET hnsw.iterative_scan = relaxed_order;
SET hnsw.max_scan_tuples = 20000;
SET hnsw.ef_search = 100;
```

Выборка заранее тоже вариант, и часто лучший: сузить выборку до тысяч строк обычным B-tree, а векторный поиск делать точный, без индекса:

```sql
-- гибридный подход: дешёвый отбор по индексам + точный векторный поиск внутри
WITH candidates AS (
  SELECT embedding, content, doc_id
  FROM doc_chunks
  WHERE tenant_id = $1
    AND created_at >= now() - interval '90 days'
    AND acl_groups && $2::text[]
  LIMIT 5000
)
SELECT doc_id, content, embedding <=> $3::vector AS dist
FROM candidates ORDER BY dist LIMIT 10;
```

Это медленнее HNSW на миллионе строк и быстрее на ста тысячах. Проверяется только одним запросом `EXPLAIN ANALYZE` на твоих данных.

## Практика: RAG-таблица целиком

Собираем связку от пустого кластера до работающего поиска. Шаги 1–5 — то, что повторяется на каждом новом стенде.

```sql
-- 1. роль, база, расширения (от пользователя postgres)
CREATE ROLE rag LOGIN;
CREATE DATABASE ragdb OWNER rag;
\c ragdb
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO rag;
SET ROLE rag;

-- 2. синтетический вектор заданной размерности — чтобы наполнить базу без модели
CREATE OR REPLACE FUNCTION rand_vec(dim int) RETURNS vector AS $$
  SELECT array_agg(random()::real)::vector FROM generate_series(1, dim);
$$ LANGUAGE sql VOLATILE;

CREATE TABLE doc_chunks (
    id          bigserial PRIMARY KEY,
    chunk_id    text NOT NULL UNIQUE,
    tenant_id   int  NOT NULL,
    doc_id      text NOT NULL,
    content     text NOT NULL,
    acl_groups  text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    embedding   vector(1024) NOT NULL
);

-- 3. наполнение: 50k чанков, у арендатора 42 свежие записи
INSERT INTO doc_chunks (chunk_id, tenant_id, doc_id, content, acl_groups, created_at, embedding)
SELECT format('doc-%s#%s', g, i),
       CASE WHEN i % 20 = 0 THEN 42 ELSE 1 + (i % 9) END,
       format('doc-%s', g),
       'Служебная записка ' || i,
       CASE WHEN i % 20 = 0 THEN ARRAY['corp-all','domain-admins'] ELSE ARRAY['corp-all'] END,
       now() - (i || ' hours')::interval,
       rand_vec(1024)
FROM generate_series(1, 50000) i, LATERAL (SELECT i / 10 AS g) t;

-- 4. индексы: составной под фильтр и HNSW под поиск
SET maintenance_work_mem = '1GB';
CREATE INDEX idx_chunks_tenant_created ON doc_chunks (tenant_id, created_at DESC);
CREATE INDEX idx_chunks_acl ON doc_chunks USING gin (acl_groups);
CREATE INDEX idx_chunks_hnsw ON doc_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 128);
ANALYZE doc_chunks;
```

```sql
-- 5. поиск: 5.1 без фильтра — использует HNSW
EXPLAIN (ANALYZE, BUFFERS)
SELECT chunk_id, content, 1 - (embedding <=> $1::vector) AS similarity
FROM doc_chunks
ORDER BY embedding <=> $1::vector
LIMIT 10;

-- 5.2 с фильтром: сначала покажи, что фильтр срабатывает отдельно
EXPLAIN (ANALYZE)
SELECT count(*) FROM doc_chunks WHERE tenant_id = 42 AND created_at >= now() - interval '30 days';

-- 5.3 рабочий запрос с фильтром и итеративным сканом
SET hnsw.iterative_scan = relaxed_order;
SET hnsw.ef_search = 100;
EXPLAIN (ANALYZE, BUFFERS)
SELECT chunk_id, content, 1 - (embedding <=> $1::vector) AS similarity
FROM doc_chunks
WHERE tenant_id = $2
  AND created_at >= now() - interval '90 days'
  AND acl_groups && $3::text[]
ORDER BY embedding <=> $1::vector
LIMIT 10;
```

Что ты должен увидеть в плане запроса 5.3 и как это читать:

- `Index Scan using idx_chunks_tenant_created` — если его нет, а `Seq Scan`, то фильтр не попал в индекс: проверь порядок колонок в составном индексе и что `acl_groups` фильтруется через GIN, а не последовательным сканированием массива;
- `Sort` с методом `top-N heapsort` и `actual rows` заметно меньше ожидаемых — это HNSW вернул меньше кандидатов, чем нужно, и именно это лечится `hnsw.iterative_scan`;
- `Buffers: shared hit` против `read` — во втором случае данных больше, чем памяти, и никакой HNSW это не спасёт;
- `rows=847 (оценка) против rows=790 (факт)` — статистика в порядке. Расхождение в разы — кандидат на `ANALYZE`.

Сравни 5.1 и 5.3 по времени: разница и есть цена фильтра. Если она больше, чем допустимая латентность бюджета из [лекции про API-шлюз](mlops/11-api-shlyuz.md), у тебя есть три развилки: вынести вектора в Qdrant, сделать частичные индексы под крупных арендаторов, или согласовать с бизнесом менее строгий фильтр.

## pgvector или Qdrant: матрица решения

| Критерий | pgvector | Qdrant отдельным сервисом |
| --- | --- | --- |
| Дополнительная инфраструктура | ноль, расширение | сервис, бэкап, мониторинг |
| Атомарность «документ + чанки» | одна транзакция | компенсация, либо outbox-паттерн |
| Фильтры по метаданным | B-tree/GIN + ручная подстройка `ef_search` | payload-индексы, фильтр внутри обхода графа |
| Объём | комфортно до ~1–2 млн векторов | десятки миллионов и выше |
| Итеративный поиск | `hnsw.iterative_scan` с 0.8 | нативно |
| Полнотекст + вектор в одном запросе | да, GIN по `tsvector` | отдельно, либо два движка |
| Эксплуатация | `maintenance_work_mem`, `REINDEX`, `VACUUM` | отдельный сервис в кластере |
| Стоимость владения | ниже | выше, но предсказуемее при росте |

Решение по умолчанию для нового проекта: **pgvector**, пока выполняются три условия — корпус меньше пары миллионов чанков, один-два арендатора масштаба отдела, и Postgres у тебя уже есть с бэкапами и мониторингом. Перенос в Qdrant — не «улучшение», а платёж за масштаб: платишь вторым сервисом, чтобы перестать подбирать `ef_search` вручную. Переноситься стоит по измеримому триггеру: p95 поиска не укладывается в бюджет **после** всех настроек, или один запрос без фильтра упирается в память сервера Postgres, который ты не готов расширять.

## Где это ломается

- **`trust` в `pg_hba.conf` «чтобы поднять».** Поднялось — и осталось. Проверяй `SELECT type, database, user_name, address, auth_method FROM pg_hba_file_rules;` перед тем, как считать настройку законченной.
- **Приложение под `postgres`.** Самая частая и самая дорогая ошибка: одна SQL-инъекка — и у атакующего весь инстанс вместе с хешами паролей ролей.
- **Индекс создан, а запрос всё равно `Seq Scan`.** Проверь три вещи по порядку: совпадает ли оператор расстояния с `vector_*_ops` в индексе, есть ли индекс вообще на нужную колонку, и не переоценена ли селективность. Начинай с первого — это в 8 случаях из 10 причина.
- **Фильтр по `tenant_id` в запросе, а в индексе только вектор.** HNSW отдаёт кандидатов по вектору, фильтр режет их после, `LIMIT` не набирается. Лечится итеративным сканом или планированием запроса, а не увеличением `ef_search` до 1000.
- **Забыли про транзакцию, которая держит vacuum.** `psql` в терминале, idle-транзакция в пуле, забытый репликационный слот — и `VACUUM` честно отрабатывает, а таблица всё равно растёт.
- **`HNSW index creation only uses maintenance_work_mem`.** Это NOTICE, а не ошибка: индекс построится, но в разы медленнее. Поднимай `maintenance_work_mem` на время загрузки.
- **Бэкап делается `pg_dump` по крону и считается бэкапом прода.** Он не покрывает окно между дампами. Нужен `pg_basebackup` плюс WAL-архивирование, и проверка восстановления по расписанию.
- **Пул соединений дали PgBouncer с `pool_mode = session`**, потому что «так ничего не сломалось». Не сломалось, но и не сэкономил: `transaction` даёт главный выигрыш, а `session` съедает его, оставляя только ограничение числа процессов.
- **Рост `n_dead_tup` не видно в Grafana.** Пока не настроишь метрику `pg_stat_user_tables.n_dead_tup`, ты узнаешь о проблеме по закончившемуся месту на диске — то есть слишком поздно.

## Чек-лист понимания

- [ ] Я могу объяснить, почему в LLM-системе Postgres закрывает три задачи (данные, вектора, метаданные) и в какой момент этот выбор перестаёт быть разумным
- [ ] Я знаю, что `pg_hba.conf` читается сверху вниз до первого совпадения, умею отличить `peer` от `scram-sha-256` и никогда не оставляю `trust` в работающей системе
- [ ] Я создам роль для приложения без `SUPERUSER` и с `CONNECTION LIMIT`, и объясню, что именно теряет злоумышленник при SQL-инъекции
- [ ] Я читаю `EXPLAIN (ANALYZE, BUFFERS)` и отличаю нормальный `Seq Scan` на маленькой таблице от ошибки планировщика на большой
- [ ] Я знаю, зачем существуют B-tree, GIN, BRIN и частичный индекс, выбираю порядок колонок составного индекса под конкретный запрос и не создаю индексы «на всякий случай»
- [ ] Я понимаю аналогию VACUUM с garbage collection в Python, умею найти транзакцию, которая мешает уборке, и настроил пороги автовакуума для своей таблицы
- [ ] Я различаю `pg_dump`, `pg_dumpall`, `pg_basebackup` и WAL-архивирование, знаю, почему `pg_dump` не бэкап прода, и понимаю ограничения PgBouncer при `pool_mode = transaction`
- [ ] Я умею собрать полный цикл роль → база → расширение → таблица → HNSW → top-k с фильтром → разбор плана, объясняю, почему фильтр ломает индекс, и называю измеримый триггер для перехода на Qdrant