---
title: Docker Compose: сети и тома
track: devops
module: B. Контейнеры и оркестрация
order: 9
duration: 60 мин
level: middle
tags: [docker, compose, тома, сети, зависимости]
summary: Как один YAML поднимает дерево сервисов, почему сервисы видят друг друга по имени, чем depends_on отличается от healthcheck и когда Compose уже не справляется.
practice: Собери рабочий docker-compose.yml из PostgreSQL, API и Redis с healthcheck у каждого сервиса, подними стек командой docker compose up -d и проверь, что API видит БД по имени db, а не по localhost.
---

Один контейнер поднять — это `docker run`, ты уже умеешь. Но любое приложение в работе тянет за собой базу, кэш, брокер, и иногда ещё фронтенд. Писать для этого длинную команду с кучей `-p`, `--link` и `--network` невозможно, а хранить в репозитории нужно именно воспроизводимую конфигурацию. Compose — это текстовый файл, в котором описано всё дерево сервисов, и одна команда, которая приводит дерево к этому описанию. Разбираем его ключи и — главное — то, как контейнеры находят друг друга по имени.

## Зачем Compose и когда он уже не нужен

Compose читает один YAML и превращает его в сеть контейнеров, общий проект, тома и политики перезапуска. Ценность в двух вещах: **воспроизводимость** (файл в репозитории — это и есть спецификация окружения) и **дешёвое локальное окружение** (поднять весь стек у себя на ноутбуке за одну команду).

| Сценарий | Подходит ли Compose |
| --- | :---: |
| Локальная разработка одного приложения | Да, основной сценарий |
| Интеграционные тесты: поднять зависимости на время прогона | Да, идеально |
| Маленький продакшн на одной ВМ, 3-5 сервисов | Да, осознанно и с ограничениями |
| Один ВМ, десятки сервисов, нужен авторестарт и переживание перезагрузки | Уже нет |
| Несколько нод, автоскейл, сервисы мигрируют между хостами | Нет, это задача оркестратора |

Граница простая: Compose умеет перезапустить контейнер на той же машине после падения. Он не умеет перенести нагрузку на другую машину, не умеет масштабироваться, не умеет катить обновление без простоя при нескольких репликах и ничего не знает про состояние «здоров». Всё это — [Kubernetes, лекция 10](devops/10-kubernetes-bazovye.md). Но Compose остаётся рабочим инструментом даже в большой компании: им гоняют тесты и локальное окружение всегда.

## Структура docker-compose.yml

```yaml
name: llmops-stack

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD:?задай DB_PASSWORD в .env}
      POSTGRES_DB: appdb
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped
    networks: [net]

  api:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["python", "-m", "uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
    environment:
      DATABASE_URL: postgresql://app:${DB_PASSWORD}@db:5432/appdb
      REDIS_URL: redis://cache:6379/0
    env_file:
      - .env
    ports:
      - "127.0.0.1:8000:8000"
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
    restart: unless-stopped
    networks: [net]

  cache:
    image: redis:7-alpine
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
    networks: [net]

networks:
  net:
    driver: bridge

volumes:
  pgdata:
```

Ключевые места, на которых спотыкаются:

| Ключ | Что делает | Типичная ошибка |
| --- | --- | --- |
| `image` | Образ из реестра | Ставить `latest` в общем окружении |
| `build` | Собрать из локального Dockerfile | Путают с `image` — можно только одно |
| `command` | Переопределяет `CMD` образа | Переопределяют `ENTRYPOINT` — и ломают signal handling |
| `environment` | Переменные для контейнера | Секреты в git |
| `env_file` | Подтянуть переменные из файла | Один файл на прод и на дев |
| `ports` | Проброс на хост | `-p 5432:5432` открывает БД всему интернету |
| `volumes` | Тома и bind mounts | Забыть про `-v` при `down -v` |
| `depends_on` | Порядок запуска | Считать, что это ждёт готовности |
| `healthcheck` | Проверка живости | Не задать — и `depends_on` ничего не ждёт |
| `deploy.resources` | Лимиты CPU и памяти | Без них один сервис съедает хост |

### `ports` — host:container

В `ports: "127.0.0.1:8000:8000"` первое число — порт **хоста**, второе — порт **внутри контейнера**. Если хост занят, Compose не стартует: `bind: address already in use`. Связка с `127.0.0.1` — сознательное решение: наружу наружу ничего не выставлено, доступ только с машины. Публикуй наружу через обратный прокси, а не через `0.0.0.0`.

По умолчанию Docker публикует на `0.0.0.0`, то есть на все интерфейсы, включая внешний. Базу данных наружу это выставляет автоматически. В compose для всего, что не должно быть видно извне, пиши `127.0.0.1:X:Y` или вообще убери `ports` и обращайся из соседнего контейнера по имени сервиса.

## Сети и DNS: почему `db:5432` работает

Вот это место, где чаще всего спрашивают «а откуда оно знает имя». При `up` Compose:

1. Создаёт **проектную сеть** — обычный Docker bridge-сеть с именем `<проект>_net`.
2. Подключает каждый сервис в эту сеть. Контейнер получает IP вида `172.18.0.3`.
3. Внутри этой сети работает **встроенный DNS Docker** (embedded DNS server в демоне). Он отдаёт каждому контейнеру `/etc/resolv.conf` с адресом `127.0.0.11`.

Запрос `db:5432` из контейнера `api` идёт на этот DNS, тот смотрит алиасы сети и отвечает IP-адресом контейнера `db`. Отдельный nameserver, отдельная зона, никакого CoreDNS, никакого round-robin на уровне Compose.

Два следствия, которые стоит запомнить:

- Из контейнера **нельзя** ходить в `localhost` — это сам контейнер. `localhost:5432` внутри `api` всегда будет «соединение отказано».
- Имя сервиса доступно **только внутри своей сети**. С хоста имя `db` не резолвится — там нужен либо опубликованный порт, либо `127.0.0.1:5432`, либо `docker compose exec`.

Проверка:

```bash
docker compose up -d
docker network ls
docker network inspect llmops-stack_net --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
docker compose exec api getent hosts db
docker compose exec api python -c "import socket; print(socket.gethostbyname('db'))"
```

## Порядок запуска: почему `depends_on` не ждёт готовности

Это главное заблуждение про Compose. `depends_on` управляет только **порядком старта контейнеров**, и всё. Он дождётся, что процесс `db` запустится, но не дождётся, что PostgreSQL закончит инициализацию, создаст кластер и начнёт принимать соединения. А это десятки секунд на свежем volume.

Отсюда классический симптом: первый запуск стека падает с `connection refused` к БД, хотя в логах видно, что база «уже поднялась». Второй запуск `docker compose up -d` проходит, потому что кластер уже создан. Причина — гонка, а не ошибка в коде.

Решение: `healthcheck` + `depends_on` с условием. Compose дожидается, пока healthcheck у зависимости не станет `healthy`:

```yaml
  api:
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
```

И вторую половину — **ретраи на стороне приложения**. Healthcheck покрывает старт, но не покрывает кратковременный сбой БД в рантайме. У psycopg, Redis-клиентов и почти всех ORM есть параметры вроде `connect_timeout`, `pool_pre_ping`, `retry_on_timeout` — включи их. Приложение, которое не переживает двадцатисекундный перезапуск БД, в проде будет падать на ровном месте.

> [!IMPORTANT]
> `service_healthy` спасает только от гонки на старте. Устойчивость к падению
> зависимости в рантайме — это ретраи в коде приложения. Одно без другого
> не работает.

## Проекты и profiles

Compose работает не с одним стеком, а с **проектами**. Проект определяется именем каталога (или флагом `-p`). Все имена ресурсов получают префикс: сеть `net` становится `llmops_net`, том `pgdata` — `llmops_pgdata`. Это то, что позволяет держать на одной машине несколько независимых копий окружения — например, стенд для приёмки и боевой.

```bash
docker compose config                 # итоговый конфиг после подстановки переменных
docker compose -p staging up -d      # проект staging, свои сети и тома
docker compose -p staging ps
docker compose --profile tools up -d tools   # запустить сервисы из профиля tools
docker compose config --services
```

**Profiles** — это способ держать в одном файле необязательные сервисы (pgAdmin, mailhog, отладочный exporter, тестовый набор), которые не стартуют по умолчанию. У сервиса появляется `profiles: ["tools"]`, и он запускается только с `--profile tools`.

## Рабочие команды и `down -v`

```bash
docker compose up -d --build      # поднять, пересобрав образы
docker compose ps                 # состояние, включая health-статус
docker compose logs -f api        # логи одного сервиса
docker compose exec api bash      # оболочка внутрь (для distroless не сработает)
docker compose run --rm api pytest tests/   # разовый запуск в новом контейнере
docker compose config -q          # проверить синтаксис, ничего не запуская
docker compose down               # остановить и удалить контейнеры и сети
```

Отдельно про два флага, которые ломают людям окружения.

**`docker compose down -v` удаляет тома.** Не контейнеры — тома, то есть **данные**. У тебя пропадёт база, кэш, загруженные файлы. Флаг существует, чтобы быстро пересоздать чистое окружение при разработке, и именно поэтому регулярно применяется в проде по привычке из локальной работы.

**`docker compose down -v` после `docker compose pull`** — сначала скачался новый `latest` для сервиса, потом удалены данные. Восстановление из бэкапа — отдельная операция с отдельным RTO.

> [!WARNING]
> `docker compose down -v` необратимо удаляет данные всех volume'ов проекта.
> Прогоняй его с `--dry-run`-проверкой (`docker compose config --volumes`
> покажет, что именно будет удалено) и никогда — на машине с единственной копией.

Опасность масштабируется тем, что имена томов у Compose с префиксом проекта, и в выводе `docker volume ls` ты видишь `llmops-stack_pgdata`, а не `pgdata`. Со временем ты перестаёшь помнить, какой том соответствует какому окружению. Держи бэкапы по расписанию и отдельно от Compose — см. лекции про наблюдаемость и эксплуатацию.

## Практика: стек из трёх сервисов

Возьми проект из лекции 08 и положи рядом `compose.yaml`:

```yaml
name: llmops-stack

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: devpass
      POSTGRES_DB: appdb
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks: [net]

  cache:
    image: redis:7-alpine
    networks: [net]

  api:
    build: .
    environment:
      DATABASE_URL: postgresql://app:devpass@db:5432/appdb
      REDIS_URL: redis://cache:6379/0
    ports:
      - "127.0.0.1:8000:8000"
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    networks: [net]

networks:
  net:

volumes:
  pgdata:
```

Проверка:

```bash
cp .env.example .env      # DB_PASSWORD, и т.д.
docker compose config -q
docker compose up -d --build
docker compose ps
docker compose exec api python -c "import socket; print(socket.gethostbyname('db'))"
curl -s localhost:8000/healthz
docker compose down        # данные остаются
docker compose up -d       # поднимается на прежних данных
```

Обрати внимание: `DATABASE_URL` собран из `db:5432` — внутри сети. Наружу ты не выставил ни БД, ни Redis. Только API на `127.0.0.1:8000`, и наружу его потом выставит nginx как reverse proxy.

## Где это ломается

1. **`depends_on` без healthcheck.** Первый запуск падает с `connection refused` к БД, второй проходит. Люди «чинят» это повторным `up` и не понимают причину.
2. **`ports: - "5432:5432"` без `127.0.0.1`.** Порт публикуется на `0.0.0.0`, и БД торчит наружу. С дефолтным паролем это полный доступ к данным из интернета.
3. **`localhost` вместо имени сервиса внутри контейнера.** `localhost` внутри `api` — это сам `api`. Ошибка выглядит как «сеть не работает».
4. **Переопределил `command`, потерял `ENTRYPOINT`.** В образе `ENTRYPOINT` — это точка входа приложения. Переопределение `command` не трогает его, но если переопределил и его — SIGTERM перестаёт доходить до процесса, и остановка идёт по таймауту с SIGKILL.
5. **Секреты в `environment` прямо в YAML.** Файл в git — значит, пароль в git. Нужен `env_file` с файлом, который не коммитится, или `${VAR}` из окружения.
6. **`docker compose down -v` в продакшне.** Данные удалены, бэкап двухчасовой давности, стенд стоит.
7. **Контейнеры едут на любой ноде, где есть место.** Compose так не умеет — все они живут на одной машине. Один упавший процесс, перезапустившийся в другом пода того же хоста, съедает память соседа. Это уже задача Kubernetes.

## Чек-лист понимания

- [ ] Я понимаю, что `ports` описывает пару host:container и почему нужно писать `127.0.0.1:X:Y`.
- [ ] Я могу объяснить механику DNS по имени сервиса внутри проектной сети и знаю, почему `localhost` внутри контейнера не работает.
- [ ] Я знаю, что `depends_on` управляет только порядком старта, и умею решать гонку через `healthcheck` + `condition: service_healthy`.
- [ ] Я знаю, зачем в приложении нужны ретраи подключения, и умею их включить.
- [ ] Я понимаю, что такое проект Compose, зачем `-p` и как тома получают префикс проекта.
- [ ] Я умею разбирать `docker network inspect` и находить IP контейнера.
- [ ] Я знаю, что именно удаляет `down -v`, и не запускаю его на единственной копии данных.
- [ ] Я понимаю границу применимости Compose и знаю, в какой момент нужны [Kubernetes](devops/10-kubernetes-bazovye.md).