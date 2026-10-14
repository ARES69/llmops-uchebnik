---
title: Prometheus и PromQL
track: devops
module: D. Наблюдаемость
order: 16
duration: 90 мин
level: middle
tags: [prometheus, promql, exporters, recording rules, alerts]
summary: Как устроена pull-модель Prometheus, как поднять node_exporter на Ubuntu, писать запросы PromQL и правила алертов с учётом кардинальности
practice: Подними node_exporter и Prometheus на Ubuntu-ВМ, опиши в prometheus.yml свой Proxmox-хост и Windows AD, напиши recording rule и три alert rule, проверь результат в /targets.
---

Предыдущая лекция объясняла, **что** мы хотим измерять и когда бить тревогу. Здесь — конкретный инструмент, который это делает в твоём контуре, и весь набор приёмов, без которых Prometheus в проде превращается в тяжёлый процесс, который ест память и отдаёт графики.

Главная особенность Prometheus: **он ничего не знает про твою систему заранее**. Он знает, как ходить по HTTP к экспортёрам, получать текст в формате exposition и складывать его в свою базу. Всё остальное — что собирать и что считать — решаешь ты через конфигурацию и запросы.

## Архитектура: pull-модель

```text
   node_exporter ──┐
windows_exporter ─┤
 postgres_exporter─┼──> HTTP /metrics ──> [ Prometheus ]──> TSDB (диск)
 cAdvisor ────────┤         scrape                │
 blackbox_exporter┘         каждые 15 с           ├──> Правила: алерты
                                              │   └──> Alertmanager ──> Telegram/Slack/PagerDuty
                                              │
                                              └──> Grafana ──> дашборды
```

Ключевые сущности:

- **Target** (цель) — адрес, с которого Prometheus забирает метрики: `http://10.10.10.11:9100/metrics`.
- **Scrape** — периодический опрос. Интервал по умолчанию 15 с (`scrape_interval`).
- **Job** — группа целей с общей ролью: все node_exporter'ы, все postgres'ы. Имя job — это лейбл, который потом используется в агрегациях.
- **TSDB** — база на локальном диске, ориентированная на запись, с агрессивным сжатием.
- **Time series** — уникальная комбинация имени метрики и набора лейблов. Одна новая метка = новая серия, навсегда.

> [!IMPORTANT]
> В Prometheus метрики **не тегируются вручную**. Лейблы — это измерения, а не аннотации. «Какой это сервис», «какая это версия», «какой это пользователь» — это разные типы вопросов, и все они выражаются лейблами. Отсюда правило: **лейбл — это то, по чему агрегируют**, а не то, что пишут для удобства.

## Почему pull, а не push

Push-модель (агент сам отправляет данные на сервер) кажется естественной, но у неё есть серьёзные ограничения, и понимание их важно не для выбора стороны, а для оценки рисков.

| | Pull (Prometheus) | Push (StatsD, OpenTelemetry Collector) |
| --- | :---: | :---: |
| Кто инициирует | Prometheus (централизованно) | агент на узле |
| Что видит система сразу | полную картину по всем целям | только то, что агент успел отправить |
| Что делать, если узел умер | просто `up == 0`, видно сразу | тишина, «нет данных» |
| Работа через NAT / в DMZ | нужен обратный доступ или VPN | агент сам инициирует соединение наружу |
| Накладные расходы сети | трафик идёт к Prometheus, можно агрегировать | каждый агент шлёт наружу сам |
| Работа в короткоживущих подах | нужно регистрировать/удалять цели | агент просто уходит |
| Задержка обнаружения | до `scrape_interval` | почти нулевая |

Главный аргумент за pull — **возможность узнать, что источник перестал отвечать**. В push-моделили «нет данных» и «узел выключен» выглядят одинаково; в Prometheus это `up{instance="..."} == 0`, и это самая частая метрика в любом дашборде.

Когда push всё же нужен: **кратковременные батчи, которые не переживают цикл опроса**, и вещи с очень высокой кардинальностью, которые невозможно держать в TSDB. Классический пример — метрики запроса (user_id, request_id, path с параметром). Для них используют **remote_write** в VictoriaMetrics, Thanos или ClickHouse, а Prometheus при этом живёт с агрегатами.

Граница, за которой pull-модель ломается, — **кардинальность около 10 000 уникальных значений одного лейбла**. Пример: `user_id` в метрике. 10 000 пользователей × 5 статусов × 3 endpoint'а = 150 000 серий, каждая из которых требует отдельной серии в памяти. Подробнее про это ниже.

## Экспортеры: что кто отдаёт

Экспортер — маленький агент, который лежит рядом с системой, собирает её внутреннее состояние и отдаёт его в текстовом формате Prometheus.

| Экспортер | Порт | Что отдаёт | Для чего тебе |
| --- | --- | --- | --- |
| `node_exporter` | 9100 | метрики ОС и железа узла: CPU, память, диски, сеть, файловые системы | **база**. Linux-хосты и ВМ на Proxmox |
| `windows_exporter` | 9182 | метрики Windows: CPU, сеть, диски, службы, процессы | твоя ВМ с Windows AD |
| `cAdvisor` | 9104 | контейнеры и их потребление CPU/памяти/сети | Docker и Kubernetes |
| `postgres_exporter` | 9187 | состояние БД: соединения, лаг репликации, блокировки, размер баз | когда появится БД |
| `mysqld_exporter` | 9104 | аналогично для MySQL/MariaDB | — |
| `blackbox_exporter` | 9115 | не метрики самой системы, а **активные пробы**: доступен ли HTTP, проходит ли TLS, отвечает ли DNS | синтетика: «доступен ли снаружи `dc.company.local`» |
| `process_exporter` | 9256 | метрики произвольного процесса по имени | «сколько памяти ест `ntds`» |
| `smartctl_exporter` | 9100 | SMART-атрибуты дисков | здоровье дисков в ZFS/Ceph |

Заметь, что для твоего контура нужны **всего два**: `node_exporter` на каждой Ubuntu-ВМ и на самом Proxmox, `windows_exporter` на ВМ с AD. Остальные добавляются по мере появления соответствующих систем — и это правильный порядок: **сначала хост, потом приложение**.

## Установка node_exporter на Ubuntu

Ставить будем бинарником, а не из репозитория Ubuntu: там версия отстаёт на год–полтора, а обновления экспортёра приходят регулярно.

```bash
VER=1.8.2
ARCH=$(dpkg --print-architecture)          # amd64 или arm64

sudo install -d -o root -g root -m 0755 /opt/prometheus
cd /tmp
curl -fsSLO "https://github.com/prometheus/node_exporter/releases/download/v${VER}/node_exporter-${VER}.linux-${ARCH}.tar.gz"
tar xzf "node_exporter-${VER}.linux-${ARCH}.tar.gz"
sudo install -o root -g root -m 0755 \
  "node_exporter-${VER}.linux-${ARCH}/node_exporter" /usr/local/bin/node_exporter

# Отдельный непривилегированный пользователь. Демон мониторинга не должен работать от root.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin node-exporter

/usr/local/bin/node_exporter --version    # проверь, что бинарь вообще запускается
```

Дальше unit-файл. Кладём в `/etc/systemd/system/node_exporter.service`:

```ini
[Unit]
Description=Prometheus node_exporter
Documentation=https://github.com/prometheus/node_exporter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=node-exporter
Group=node-exporter
ExecStart=/usr/local/bin/node_exporter \
  --web.listen-address=:9100 \
  --collector.textfile.directory=/var/lib/node_exporter/textfile_collector \
  --collector.systemd \
  --no-collector.wifi
Restart=always
RestartSec=5s
TimeoutStopSec=15s

# systemd сам создаст каталог и выдаст права
StateDirectory=node_exporter

# Изоляция
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryMax=256M
TasksMax=64

[Install]
WantedBy=multi-user.target
```

Разберём неочевидные строки:

| Директива | Зачем |
| --- | --- |
| `StateDirectory=node_exporter` | создаёт `/var/lib/node_exporter` с правильными правами. Нужно для textfile-коллектора и совместимо с `ProtectSystem=strict` |
| `--collector.textfile.directory` | позволяет **класть свои метрики файлами** в этот каталог — так подключают скрипты от бэкапов и кастомные проверки |
| `--no-collector.wifi` | на сервере wifi-коллектор бесполезен и иногда вызывает ошибки |
| `--collector.systemd` | даёт метрики состояния systemd-юнитов (`node_systemd_unit_state`) — незаменимо, когда «сервис не стартовал» |
| `MemoryMax=256M` | защита: если экспортёр начнёт утекать, он умрёт, а не утащит за собой ВМ |
| `ProtectSystem=strict` | весь FS только для чтения, кроме StateDirectory |

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now node_exporter
systemctl status node_exporter --no-pager

# проверка: отдаёт ли метрики и что именно
curl -s http://127.0.0.1:9100/metrics | head -5
curl -s http://127.0.0.1:9100/metrics | grep -c '^node_'
ss -lntp | grep 9100
```

`ss -lntp` должен показать, что порт слушается на `0.0.0.0:9100`, а не только на `127.0.0.1`. Если экспортёр нужен снаружи ВМ (Prometheus стоит на другой машине) — оставь `:9100`, но закрой порт фаерволом от всего, кроме IP твоего сервера Prometheus:

```bash
sudo ufw allow from 10.10.10.10 to any port 9100 proto tcp
sudo ufw enable
```

### Windows-сторона

Для ВМ с Windows AD нужен `windows_exporter`. Он ставится как служба Windows:

```powershell
# На Windows-хосте или в ВМ AD
$url = "https://github.com/prometheus-community/windows_exporter/releases/download/v0.30.0/windows_exporter-0.30.0.amd64.msi"
Invoke-WebRequest $url -OutFile "$env:TEMP\windows_exporter.msi"
Start-Process msiexec.exe -ArgumentList "/i", "$env:TEMP\windows_exporter.msi", "/qn" -Wait -NoNewWindow

# Служба по умолчанию: windows_exporter, порт 9182
Set-Service windows_exporter -StartupType Automatic
Start-Service windows_exporter
Invoke-WebRequest -UseBasicParsing http://localhost:9182/metrics | Select-Object -Expand Content | Select-Object -First 3
```

В default-конфигурации он отдаёт очень много метрик. Для контроллера домена полезнее всего оставить конкретные коллекторы — NTDS, службы, диски:

```yaml
# windows_exporter.yml
 collectors:
   enabled:
     - cpu
     - memory
     - disk
     - network
     - process
     - service
     - ntds
     - logical_disk
```

Имя коллектора `ntds` даёт метрики `ntlds_database_size`, `ntlds_dsdatabase_size_bytes` — по ним ты поймаешь разрастание базы AD задолго до того, как контроллер начнёт отдавать по 20 секунд.

## Порты: памятка

| Порт | Кто слушает | Направление |
| --- | --- | --- |
| 9090 | Prometheus (веб-интерфейс и API) | ты → Prometheus |
| 9100 | node_exporter, mysqld_exporter | Prometheus → узел |
| 9104 | cAdvisor | Prometheus → хост с контейнерами |
| 9115 | blackbox_exporter | Prometheus → blackbox |
| 9182 | windows_exporter | Prometheus → Windows-узел |
| 9187 | postgres_exporter | Prometheus → Postgres |
| 9256 | process_exporter | Prometheus → узел |
| 9093 | Alertmanager | Prometheus → Alertmanager |
| 3000 | Grafana | браузер → Grafana |

Правило сетевой безопасности: **только 9090 открыт наружу** (и 3000, если Grafana смотрит наружу). Всё остальное — между Prometheus и агентами, в закрытом сегменте.

## prometheus.yml: конфигурация

```yaml
global:
  scrape_interval: 15s          # как часто опрашивать каждую цель
  scrape_timeout: 10s           # не может превышать scrape_interval
  evaluation_interval: 15s      # как часто пересчитываются правила
  external_labels:
    env: prod                   # добавится ко всем сериям — полезно для federation

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager.company.local:9093"]

scrape_configs:
  - job_name: "prometheus"
    static_configs:
      - targets: ["localhost:9090"]

  - job_name: "proxmox-hosts"
    static_configs:
      - targets:
          - "10.10.10.11:9100"    # сам Proxmox VE
          - "10.10.10.12:9100"    # хранилище / второй гипервизор
        labels:
          site: hq
          role: hypervisor

  - job_name: "windows"
    static_configs:
      - targets: ["10.10.20.15:9182"]
        labels:
          role: domain-controller
          site: hq

  - job_name: "ubuntu"
    static_configs:
      - targets:
          - "10.10.20.21:9100"
          - "10.10.20.22:9100"

    relabel_configs:
      # Вытащить IP из __address__ в отдельный лейбл instance.
      # Узлы за NAT с одинаковым портом иначе не различить.
      - source_labels: [__address__]
        regex: "([^:]+):.*"
        target_label: instance
        replacement: "$1"

      # Оставить только staging-узлы
      - source_labels: [env]
        regex: "staging"
        action: keep
```

### Как статик превращается в список целей

Механику стоит понять, потому что 90% проблем с метками — это непонимание этого процесса:

1. Для каждого `scrape_configs` создаётся **одна группа** с меткой `job = <job_name>`.
2. Каждый `static_configs`-элемент — это **набор целей**. Каждый таргет из списка превращается в отдельную цель.
3. `labels` из `static_configs` добавляются **ко всем** целям этого элемента. Именно поэтому разные таргеты одного блока нельзя описать разными лейблами — нужно делать несколько `static_configs`-блоков внутри одного job.
4. Все `relabel_configs` применяются **по очереди к каждой цели**: значение `__address__` парсится, `__address__` перезаписывается, метки `keep`/`drop` фильтруют цели целиком.
5. Внутренние лейблы (`__address__`, `__metrics_path__`, `__scheme__`) используются для HTTP-запроса, обычные лейблы попадают в данные.

Порядок обработки внутренних лейблов: сначала `__scheme__`, `__metrics_path__`, `__address__` из таргета, потом твои `labels` из `static_configs`, потом `relabel_configs`.

Ещё одна деталь, которая удивляет: если в `relabel_configs` ты заменил `instance`, то значением по умолчанию для `instance` (которым Prometheus инициализирует это поле) становится результат замены. Поэтому в примере выше `instance` после relabel — это чистый IP без порта, и это то, что ты увидишь во всех запросах.

```bash
promtool check config /etc/prometheus/prometheus.yml
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool | head -40
```

## /targets — самая полезная страница

`http://<prometheus>:9090/targets` — это **первое**, куда ты идёшь, когда «графики пустые». Здесь видно всё: какие цели есть, в каком они состоянии, когда был последний скрейп и какая была ошибка.

| Значение | Что означает |
| --- | --- |
| `UP` | цель отвечает, последний скрейп успешен |
| `DOWN` | цель не отвечает или `/metrics` отдаёт мусор; причина — в колонке **Error** |
| `UNKNOWN` | ещё не было ни одного успешного скрейпа |
| Last Scrape | когда был последний запрос — если там 5 минут назад, значит `scrape_interval` нарушен или Prometheus завис |

Типовые ошибки в колонке Error:

| Текст ошибки | Причина | Что делать |
| --- | --- | --- |
| `connection refused` | экспортёр не запущен или слушает только на localhost | проверить `ss -lntp` на цели |
| `i/o timeout` | файрвол режет или маршрута нет | открыть порт, проверить с Prometheus: `curl` |
| `server returned HTTP status 500` | экспортёр упал на сборе конкретной метрики | смотреть лог экспортёра, часто помогает `--no-collector.<битый>` |
| `context deadline exceeded` | `scrape_timeout` меньше времени ответа | увеличить `scrape_timeout` до 10–20 с |
| `no such file or directory` | права: экспортёр не может прочитать `/proc` или `/sys` | неверный `User` в unit-файле |
| пусто, но `UP` | ответ не в формате exposition | обычно это HTML-страница nginx вместо `/metrics` — проверь `__metrics_path__` |

Практическая привычка: **при добавлении каждой цели первым делом смотри `/targets`**, а не график. Пустой график и «цель не запущена» выглядят одинаково, но чинятся по-разному.

## Типы метрик: counter, gauge, histogram, summary

Это самая частая причина неправильных запросов. Разберём на примере HTTP-метрик.

### Counter — только растёт

Счётчик монотонно увеличивается. Уменьшить его нельзя. Ответ на вопрос «сколько всего было» — только через `rate()` или `increase()`.

```text
# HELP http_requests_total Total number of HTTP requests.
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/v1/search",code="200"} 184723
http_requests_total{method="GET",route="/v1/search",code="500"} 271
```

### Gauge — плавает в обе стороны

Мгновенное значение: сколько памяти, сколько соединений, сколько работает воркеров.

```text
# TYPE node_memory_MemAvailable_bytes gauge
node_memory_MemAvailable_bytes 3.421e+09
```

### Histogram — наблюдения складываются в заданные границы

```text
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.05"}   512
http_request_duration_seconds_bucket{le="0.1"}    940
http_request_duration_seconds_bucket{le="0.25"}   1180
http_request_duration_seconds_bucket{le="0.5"}    1301
http_request_duration_seconds_bucket{le="1"}      1380
http_request_duration_seconds_bucket{le="2.5"}    1418
http_request_duration_seconds_bucket{le="5"}      1440
http_request_duration_seconds_bucket{le="+Inf"}   1440
http_request_duration_seconds_count 1440
http_request_duration_seconds_sum   213.44
```

### Summary — квантили считает клиент

```text
# TYPE http_request_duration_seconds summary
http_request_duration_seconds{quantile="0.5"}  0.041
http_request_duration_seconds{quantile="0.95"} 0.312
http_request_duration_seconds{quantile="0.99"} 1.884
http_request_duration_seconds_sum   213.44
http_request_duration_seconds_count 1440
```

### Histogram против summary: главное различие

| | Histogram | Summary |
| --- | :---: | :---: |
| Как считается | границы (`le`) задаются на сервере, Prometheus группирует бакеты | квантили считаются на самом приложении |
| Что можно посчитать на бутстрапе | **любой** квантиль из своих бакетов | только те, что приложение реально считает |
| Слияние с нескольких инстансов | точное | приблизительное, если наборы квантилей разные |
| Среднее | точное (`_sum / _count`) | точное |
| Память на сервере | растёт с числом бакетов × лейблов | компактно, но объектов больше |
| Что выбирать | **лентенси, SLO, всё, где нужен p99** | когда нужен только общий p95 и инстансов мало |

Отсюда правило: **для расчёта SLO по латентности нужен histogram**, потому что SLO определяется на окне, а summary отдаёт тебе квантиль только на момент скрейпа. Есть подводный камень: агрегировать бакеты надо **до** `histogram_quantile()`, и обязательно с `by (le, ...)` — иначе получишь мусор.

```promql
# Правильно: сначала складываем бакеты по нужным лейблам, потом берём квантиль
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# Неправильно: histogram_quantile по одной серии, а потом сумма
sum(histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])))
```

## Имена метрик и лейблы: как лейблы убивают память

Имя метрики — `namespace_subsystem_measurement_unit`. У node_exporter namespace `node`, у cAdvisor `container`, у твоих приложений придумай свой, например `ragapi`:

```text
ragapi_retrieval_documents_total        # счётчик
ragapi_active_connections               # gauge
ragapi_request_duration_seconds         # histogram
ragapi_model_load_duration_seconds      # gauge, время загрузки модели
ragapi_tokens_total{type="input"}       # счётчик с лейблом
```

Про лейблы — главная проблема Prometheus. **Каждая уникальная комбинация «имя + набор лейблов» — это отдельная серия в памяти, существующая всё время жизни этой комбинации.** Порядок величин: примерно 1–3 КБ RAM на серию, плюс индексы чанков на диске. Один миллион серий — это 2–4 ГБ оперативной памяти и заметная нагрузка на диск.

Что убивает кардинальность:

```text
# Плохо: user_id — уникален для каждого пользователя
ragapi_requests_total{user_id="8841"} ...
ragapi_requests_total{user_id="8842"} ...

# Плохо: полный путь с идентификатором
ragapi_requests_total{route="/v1/search/88321"} ...

# Плохо: request_id — уникален всегда
ragapi_requests_total{request_id="a3f9-..."} ...

# Хорошо: конечное множество значений
ragapi_requests_total{route="/v1/search",code="200",method="POST"}
```

Практические меры:

- **никогда** не пишите лейблы `user_id`, `email`, `ip`, `request_id`, `timestamp`, полный путь с параметром, `error_message`;
- маршруты нормализуйте: `/v1/search` вместо `/v1/search/88321` — встраивайте это в фреймворк (`/v1/search/:id`), а не вручную;
- лейблы не меняют своё значение со временем: если значений 20, метрика раздуется до 20 серий и будет висеть вечно, даже когда событий больше не будет.

Как найти проблему, если память уже растёт:

```promql
# Топ-20 самых «тяжёлых» метрик по числу серий
topk(20, count by (__name__) ({__name__=~".+"}))

# Число серий по инстансу
count by (instance) ({__name__=~".+"})
```

А лечится это либо удалением лейбла в коде приложения, либо фильтром на scrape:

```yaml
scrape_configs:
  - job_name: "ragapi"
    static_configs:
      - targets: ["ragapi-1:8000"]
    metric_relabel_configs:
      - source_labels: [__name__]
        regex: "go_memstats_.*|promhttp_.*|process_open_fds"
        action: drop
```

## PromQL: язык запросов

PromQL работает с сериями во времени. Левая часть выражения — **селектор**, правая — функция. Почти всегда нужна `rate()` или `increase()`, потому что «сколько?» для счётчика бессмысленно, а «сколько в секунду?» — осмысленно.

| Функция | Что делает | Когда нужна |
| --- | --- | --- |
| `up` | 1, если последний скрейп цели успешен | «жив ли узел» |
| `rate(m[5m])` | прирост счётчика в секунду, размазанный по окну | **основной способ считать скорость** |
| `irate(m[5m])` | прирост по двум последним точкам | «что происходит прямо сейчас» на шумных графиках |
| `increase(m[1h])` | прирост счётчика за окно, **целым числом** | «сколько ошибок за час» |
| `sum by (x) (…)` | сумма с сохранением лейбла `x` | агрегация по job, route, коду |
| `sum without (x) (…)` | сумма по всем, кроме лейбла `x` | «все лейблы, кроме instance» |
| `topk(5, …)` | топ-5 самых больших | «кто нагружает» |
| `histogram_quantile(q, …)` | квантиль по бакетам | p99 латентности |
| `predict_linear(m[6h], 86400)` | линейная экстраполяция на 24 ч вперёд | «диск кончится завтра» |
| `offset` | сдвиг на интервал | «сейчас против прошлой недели» |
| `clamp_min(m, x)` | не опускать ниже x | защита от деления на ноль |
| `deriv(m[6h])` | скорость изменения | «растёт база NTDS» |

```promql
up                                        # кто сейчас жив
up{job="windows"} == 0                     # кто умер

rate(http_requests_total[5m])              # скорость по каждой серии
sum by (job) (rate(http_requests_total[5m]))                  # RPS по сервисам
sum by (job, code) (rate(http_requests_total{code=~"5.."}[5m]))
increase(http_errors_total[1h])            # ошибок за час, числом

histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
topk(5, sum by (instance) (rate(node_network_receive_bytes_total[5m])))

# «Правда ли, что сейчас хуже, чем обычно?»
sum(rate(http_requests_total{code=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))
- (sum(rate(http_requests_total{code=~"5.."}[5m] offset 7d))
  / sum(rate(http_requests_total[5m] offset 7d))

# «Диск кончится за сутки?»
node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}
  / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"} < 0.15
predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}[6h], 24*3600) < 0

# «Хватает ли памяти?»
node_memory_MemAvailable_bytes
  / node_memory_MemTotal_bytes < 0.10
```

### `rate` против `irate` и почему окна в 5 минут не всегда хватает

`rate(m[5m])` берёт первую и последнюю точки окна и делит разницу на время. Значит, одна аномальная точка на краю окна **размазывает** себя на 5 минут: всплеск на 20 секунд превратится в «чуть-чуть больше обычного», а провал на 20 секунд — в «чуть-чуть меньше». Это поведение **правильное для дашбордов**, потому что график не дёргается.

`irate(m[5m])` использует только две последние точки и показывает **мгновенную** скорость. Она точнее отражает «сейчас», но гораздо шумнее: одно значение счётчика, которое пришло с опозданием, даёт на графике вертикальный пик ни о чём не говорящий. Поэтому `irate` хорош для дебага конкретного момента и плох для дашбордов и алертов.

Окно — это компромисс:

| Окно | Плюс | Минус |
| --- | --- | --- |
| `[1m]` | видно микровсплески | почти всегда шумно; при `scrape_interval: 15s` всего 4 точки |
| `[5m]` | стандарт, стабильно | тупой к коротким инцидентам |
| `[15m]` | ровнее | медленно реагирует |
| `[1h]` | очень стабильно | всплеск, длящийся 10 минут, не виден вообще |

Правило: **для дашбордов и burn-rate алертов — `rate` с окном не меньше `scrape_interval × 4`**. При `scrape_interval: 15s` это как раз 5 минут. Для более гладких графиков и для алертов с длинным окном — 15–30 минут. И не забывай: **окно в PromQL должно быть не меньше четырёх интервалов скрейпа**, иначе в нём слишком мало точек и rate становится нестабильным.

## Агрегация для дашборда

Готовая строка для дашборда, которая нужна почти всегда:

```promql
sum(rate(http_requests_total[5m])) by (job)
```

Разбор слева направо: выбираем все счётчики запросов → считаем скорость за 5 минут → суммируем всё, **группируя по job**. В результате остаётся ровно одна точка на каждый сервис, а не по пять на каждый инстанс. На практике `by` обычно ставят после `sum` — запись `sum by (job) (rate(...))` и `sum(rate(...)) by (job)` эквивалентна, но первая читается как «суммирую, сгруппировав по job», и её используют чаще.

Типичный набор панелей сервисного дашборда:

```promql
# Трафик
sum(rate(http_requests_total[5m])) by (job, route)

# Ошибки (абсолютные и доля)
sum(rate(http_requests_total{code=~"5.."}[5m])) by (job)
sum(rate(http_requests_total{code=~"5.."}[5m])) by (job)
  / clamp_min(sum(rate(http_requests_total[5m])) by (job), 0.001)

# Латентность
histogram_quantile(0.50, sum by (le, job) (rate(http_request_duration_seconds_bucket[5m])))
histogram_quantile(0.99, sum by (le, job) (rate(http_request_duration_seconds_bucket[5m])))

# Насыщение
node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes
```

`clamp_min(..., 0.001)` здесь не косметика: при нулевом трафике знаменатель равен нулю, результат — `NaN`, и вместо «нуля ошибок» на графике появляется дыра.

## Recording rules: зачем пересчитывать одно и то же

Тяжёлый запрос — та же цепочка `histogram_quantile(...)` по десяткам серий — считается **каждые 15 секунд на всех графиках, открытых в Grafana**, плюс ещё раз в каждом правиле, которое его использует. На реальных системах это превращается в заметную нагрузку и на «too many outstanding queries» в логах.

Recording rule — это именованный запрос, результат которого **сохраняется как новая временная серия**. Дальше все обращаются к ней как к готовой метрике.

```yaml
groups:
  - name: aggregations
    interval: 30s
    rules:
      - record: job:http_requests:rate5m
        expr: sum by (job) (rate(http_requests_total[5m]))

      - record: job:http_errors:rate5m
        expr: sum by (job) (rate(http_requests_total{code=~"5.."}[5m]))

      - record: job:http_error_ratio:rate5m
        expr: |
          job:http_errors:rate5m
            / clamp_min(job:http_requests:rate5m, 0.001)

      - record: instance:cpu_usage:ratio
        expr: 1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))

      - record: node:filesystem_used:ratio
        expr: |
          1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}
            / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"}
```

Имена recording rules подчиняются схеме **`level:metric:operations`**:

| Часть | Пример | Смысл |
| --- | --- | --- |
| level | `job`, `instance`, `node` | уровень агрегации |
| metric | `http_error_ratio` | что измеряем |
| operations | `rate5m` | какое применено преобразование |

Побочные эффекты, о которых полезно знать:

- правило **записывает серию** — то есть увеличивает кардинальность. Не делай recording rules для того, что никто не читает;
- к записанной серии применимы те же `rate()` и агрегации, но **не применяй `rate()` дважды** подряд (записанная серия уже «скорость»);
- если правило по ошибке вернуло пустой результат, получится **разрыв в графике**, а не ноль. Это заметно и пугает.

```bash
promtool check rules /etc/prometheus/rules/infra.yml
curl -s 'http://localhost:9090/api/v1/rules' | python3 -m json.tool | head -30
```

## Alerting rules: структура и смысл `for`

```yaml
groups:
  - name: infra-alerts
    rules:
      - alert: NodeDown
        expr: up{job=~"ubuntu|proxmox-hosts"} == 0
        for: 5m
        labels:
          severity: critical
          service: infra
        annotations:
          summary: "Узел {{ $labels.instance }} недоступен"
          description: >-
            Цель {{ $labels.instance }} не отвечает на scrape {{ $value | humanizeDuration }}
            (job={{ $labels.job }}). Проверь: узел выключен, или сломан сетевой доступ.
          runbook_url: "https://wiki.internal/runbooks/node-down"

      - alert: DiskWillFillIn24h
        expr: |
          predict_linear(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|fuse.*"}[6h], 24*3600) < 0
            and node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.40
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Диск {{ $labels.mountpoint }} на {{ $labels.instance }} заполнится за сутки"
          description: "Тренд за 6 часов показывает конец свободного места раньше чем через 24 часа."
          runbook_url: "https://wiki.internal/runbooks/disk-full"

      - alert: HighErrorRate
        expr: |
          job:http_error_ratio:rate5m > 0.05
            and job:http_requests:rate5m > 1
        labels:
          severity: critical
        annotations:
          summary: "Доля 5xx на {{ $labels.job }} выше 5%"
          description: "Сейчас {{ $value | humanizePercentage }} запросов падает с 5xx."

      - alert: InodesRunningOut
        expr: |
          node_filesystem_files_free{fstype!~"tmpfs|overlay"}
            / node_filesystem_files{fstype!~"tmpfs|overlay"} < 0.10
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Мало свободных инодов на {{ $labels.instance }}"

      - alert: NTDSGrowing
        expr: |
          ntlds_dsdatabase_size_bytes > 5e9
            and ntlds_dsdatabase_size_bytes > ntlds_dsdatabase_size_bytes offset 30d * 1.2
        for: 30m
        labels:
          severity: warning
          service: active-directory
        annotations:
          summary: "База NTDS на {{ $labels.instance }} выросла более чем на 20% за месяц"
          runbook_url: "https://wiki.internal/runbooks/ntds-growth"
```

| Поле | Что делает |
| --- | --- |
| `expr` | выражение PromQL; алерт в состоянии `firing`, когда результат непустой |
| `for` | **сколько времени условие должно держаться**, прежде чем алерт уйдёт |
| `labels` | добавляются к меткам алерта; используются Alertmanager'ом для маршрутизации |
| `annotations` | длинный текст: шаблоны `{{ $labels.x }}` и `{{ $value }}` подставляются |
| `severity` | согласованная шкала (`critical`, `warning`, `info`), по ней решается будить или нет |

### Почему без `for` нельзя

Скрейп идёт каждые 15 секунд. За это время случается: деплой (30–90 секунд перезапуска), ночной бекап, `apt upgrade`, короткий сетевой сбой, деградация на 40 секунд. Каждое из этих событий — один «ненулевой» результат запроса, и **без `for` это один алерт**.

Что происходит дальше: дежурный получает уведомление о проблеме, которой уже нет. Через неделю таких уведомлений будет десять, и он начнёт их игнорировать. Через месяц — все. Классический alert fatigue рождается именно из отсутствия `for`, и это техническая ошибка, а не вопрос характера.

Сколько ставить:

| Что | Значение `for` |
| --- | --- |
| Узел недоступен | 2–5 мин (хочется узнать про падение ВМ быстро, но не будить из-за рестарта службы) |
| Диск / иноды | 15–30 мин (тут скорость не важна) |
| Доля ошибок по SLI | 10–30 мин, обычно равно окну burn rate |
| Недоступность для пользователей (SLO) | равно длинному окну из burn-rate-пары |

Альтернатива `for`, о которой стоит знать: в Alertmanager есть группировка и `group_wait` — они склеивают несколько алертов в одно уведомление, но **не защищают от одиночного срабатывания**. Паузу даёт только `for`.

```yaml
# Alertmanager: маршрутизация и подавление
route:
  receiver: default
  group_by: ["alertname", "instance"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: ['severity="critical"']
      receiver: oncall
      repeat_interval: 30m

inhibit_rules:
  - source_matchers: ['alertname="NodeDown"']
    target_matchers: ['severity=~"warning|critical"']
    equal: ["instance"]        # не шлём «диск кончается», если узел и так недоступен
```

## Модули node_exporter: какая метрика какую проблему показывает

| Метрика | Что показывает | На что смотреть |
| --- | --- | --- |
| `node_load1`, `node_load5`, `node_load15` | средняя очередь загрузки | выше числа ядер = есть очередь; `load15 >> load1` = проблема была и прошла |
| `node_load1 / count(node_cpu_seconds_total)` | нагрузка относительно числа ядер | > 1 = перегрузка; в ВМ сравнивай с `vCPU`, а не с хостом |
| `node_cpu_seconds_total{mode="iowait"}` | доля времени, когда CPU ждал диск | растёт — значит узкое место ввод-вывод, а не вычисления |
| `node_cpu_seconds_total{mode="steal"}` | доля времени, когда гипервизор забрал CPU | **только в ВМ**. Ненулевой `steal` = хост перегружен или настроен нечестно |
| `node_memory_MemAvailable_bytes` / `node_memory_MemTotal_bytes` | доступная память | смотри именно `Available`, а не `Free`. `Free` всегда мал и это нормально |
| `node_memory_SwapFree_bytes` | своп | ненулевой swap без нехватки памяти = процессы «залипли» в свопе, латентность вырастет |
| `node_oom_kill_total` | сколько раз ядро убило процесс по памяти | любое ненулевое значение = инцидент |
| `node_filesystem_avail_bytes` / `size_bytes` | свободное место | алерт на **абсолютную цифру в ГБ** надёжнее, чем на проценты |
| `node_filesystem_files_free` / `files` | свободные иноды | на массивах с миллионами файлов кончается раньше, чем место |
| `node_disk_io_time_seconds_total` | доля времени, когда диск был занят | > 0.9 в течение длительного времени = диск — узкое место |
| `node_disk_read_bytes_total` / `written_bytes_total` | поток чтения/записи | ненулевой поток без соответствующей нагрузки = возможно, бэкап |
| `node_network_receive_bytes_total{device}` | трафик по интерфейсу | спайк без причины = диагностируй |
| `node_boot_time_seconds` | когда узел загрузился | неожиданно маленькое значение = была перезагрузка |
| `node_systemd_unit_state{name="..."}` | состояние systemd-юнита | `failed` = сервис упал, и это ловится раньше, чем «пользователи жалуются» |
| `node_textfile_scrape_error` | ошибка чтения кастомных метрик | не 0 = твой скрипт для textfile отдаёт мусор |

Про `steal` стоит сказать отдельно, потому что это **виртуализация наоборот**: в ВМ на Proxmox `steal` показывает, сколько процессорного времени забрал гипервизор, когда физический хост уже отдал всё гостям. Если `steal` на твоей ВМ стабильно выше 2–3% — это не проблема ВМ, это **проблема хоста**: пересчитай Overcommit, либо перенеси ВМ на другой узел кластера. На bare-metal Linux `steal` всегда 0.

## Если сам Prometheus упал или был убит по памяти

Симптомы выглядят одинаково: `up{job="prometheus"} == 0`, на дашбордах пусто, «всё работает, но графиков нет».

```bash
systemctl status prometheus --no-pager
journalctl -u prometheus -n 200 --no-pager

# 1. Был ли OOM-kill — самое частое
dmesg -T | grep -Ei "killed process|out of memory" | tail -5
journalctl -k | grep -i "oom" | tail -5

# 2. Что заняло память
ps -o pid,rss,etime,cmd -C prometheus
du -sh /var/lib/prometheus/* 2>/dev/null

# 3. Сколько серий накопилось — главная причина OOM
curl -s 'http://localhost:9090/api/v1/status/tsdb' | python3 -m json.tool

# 4. Есть ли зацикленные правила или взорвавшиеся запросы
curl -s 'http://localhost:9090/api/v1/rules' | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(r['evaluationTime'] for g in d['data']['groups'] for r in g['rules']))"
```

Порядок действий при росте памяти:

1. Найти взрывную метрику: `topk(20, count by (__name__) ({__name__=~".+"}))`.
2. Убрать лишние лейблы **в приложении** — это единственное настоящее лечение; фильтрация в Prometheus лишь откладывает проблему.
3. Пока чинишь — сбросить сбор мусорных метрик через `metric_relabel_configs` (см. выше) или отключить job.
4. Ограничить память контейнера, но с запасом: умерший Prometheus с потерей несохранённого WAL хуже, чем живой с лишним гигабайтом.
5. Включить WAL и деградацию вместо падения: флаг `--storage.tsdb.wal-compression` экономит заметную часть диска.

> [!CAUTION]
> Никогда не решай проблему памяти увеличением `MemoryMax` без разбора. Если серий стало 5 миллионов, удвоение памяти даёт тебе не «больше места», а ещё несколько дней до следующего падения — с тем же корнем проблемы.

## Хранение: сколько живут данные и почему этого мало

Устройство TSDB объясняет и сроки хранения, и поведение при падениях:

- новые данные каждые пару часов пишутся в **маленькие блоки** (по умолчанию 2 часа) на диск, а не в память целиком;
- раз в сутки фоновый compaction **объединяет** мелкие блоки в крупные — старые данные после этого лежат на диске и в памяти не сидят;
- последние ~1–2 часа лежат в **WAL** (write-ahead log) на диске, а не в RAM. Поэтому перезапуск Prometheus не теряет свежие данные — в этом его отличие от «наивных» систем с буфером в памяти;
- в памяти сидят только блоки текущего окна плюс индексы.

Отсюда параметры хранения:

```bash
prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus \
  --storage.tsdb.retention.time=30d \
  --storage.tsdb.retention.size=50GB \
  --storage.tsdb.wal-compression \
  --web.enable-lifecycle
```

`--storage.tsdb.retention.time` (по умолчанию **15d**) — это и есть твой горизонт. Срок считается по **блокам целиком**, а не по отдельным точкам: блоки удаляются по границе, поэтому реальный диапазон всегда чуть короче заданного, с точностью до размера блока.

Проблема длинной истории — не «Prometheus плохо хранит», а **экономика**:

| Горизонт | Один Prometheus | С чем сравнить |
| --- | --- | --- |
| до 30 дней | отлично, 1 инстанс | — |
| 1–6 месяцев | дорого: память, диск, один инстанс | VictoriaMetrics, чем длиннее, тем сильнее выигрыш |
| 1–3 года | непрактично в одном инстансе | Thanos/Cortex поверх S3 — распределённое долговременное хранилище |

**VictoriaMetrics** — отдельный продукт, а не «ещё один Prometheus». Он отвечает тем же PromQL, хранит данные в собственной TSDB, потребляет заметно меньше памяти на серию и спокойно живёт с годами данных в одном инстансе. Переход для команд, привыкших к PromQL, почти безболезненный. Trade-off честный: это **другой продукт с другой командой поддержки и своей моделью отказов** — если он ляжет, ляжет не только «история», а всё живое наблюдение.

Правильный порядок внедрения, который почти всегда оказывается верным:

1. Сначала **живая** система: Prometheus + Grafana + алерты на узлы.
2. Данные за 30 дней — достаточно для большинства разборов инцидентов.
3. Реальная потребность в «что было в марте» появляется **только при разборе регрессий и при планировании мощности**.
4. Тогда и ставится VictoriaMetrics или Thanos — с уже понятным требованием, а не из-за абстрактного «а вдруг понадобится».

## Границы Prometheus

Это нужно проговорить прямо, потому что частая ошибка — пытаться решить в Prometheus задачу, которая ему не по силам.

- **Prometheus не хранит логи.** Он не покажет, каким текстом был ответ 500. Логи — Loki или Elasticsearch.
- **Prometheus не хранит трейсы.** Он не покажет, что внутри запроса к вашему LLM-сервису ушло 800 мс на конкретный вызов API. Трейсы — Tempo или Jaeger через OpenTelemetry.
- **Prometheus не знает, что «нормально».** Он не умеет считать error budget, burn rate и соответствие SLO. Это отдельный слой правил — и именно поэтому recording rule `job:http_error_ratio:rate5m` написан вручную, а не «получен автоматически».
- **Prometheus не хранит аудит и не заменяет логирование.** Он агрегирует, а детали теряет.
- **Prometheus не масштабируется «на износ».** Десятки тысяч целей и миллионы серий — это отдельный проект с Thanos/Cortex, federation и продуманным шардированием.

Правильная формулировка: **Prometheus отвечает на вопрос «что сейчас с цифрами», но не отвечает на вопросы «что было в конкретном запросе» и «это нормально или нет».** Первые два закрываются логами и трейсами, третий — правилами и процессом.

## Где это ломается

1. **Кардинальность.** Один лейбл с `user_id` или полным путём — и через месяц Prometheus ест десятки гигабайт и падает с OOM. Диагностика: `topk(20, count by (__name__) ({__name__=~".+"}))`.
2. **`rate()` на окне меньше четырёх интервалов скрейпа.** При `scrape_interval: 15s` и `[1m]` в окне всего четыре точки — rate становится мусором, и это выглядит как «сломанные графики».
3. **Цель не отвечает, а график пуст.** Все смотрят в Grafana вместо `/targets`. Страница `/targets` отвечает на этот вопрос за секунду.
4. **`up` без учёта `== 0`.** Выражение `up` возвращает 1 у всех живых и 0 у мёртвых, а `alerts`-панель Grafana показывает «0» как хорошее значение, если не подумать.
5. **Секрет попал в лейбл.** Пароль или токен в path или в URL создаёт уникальную серию на каждый запрос — и заодно утекает в данные.
6. **Recording rules для всего подряд.** Они сами увеличивают кардинальность и нагружают TSDB; правило, которое никто не читает, — чистый расход.
7. **`histogram_quantile` без `sum by (le, ...)`.** Квантиль по несмешанным бакетам разных инстансов даёт бессмысленное число.
8. **Алерт без `for`.** Каждый рестарт и каждый бекап — уведомление. Через месяц дежурный отключает всю систему целиком.
9. **Правило «сработало — увидел — не понял».** Нет `runbook_url` и `description` в `annotations`: в три ночи у тебя есть факт («Alertmanager: firing»), и больше ничего.
10. **`node_exporter` от root без `ProtectSystem`.** Не страшно, но в стандартном виде оставляет экспортёр с лишними правами на хосте.
11. **Хранение года в одном Prometheus «на всякий случай».** Диск забит, бэкап TSDB раздувает репозиторий, а нужной истории там всё равно нет в нужном разрешении.
12. **Фильтрация `job=~"ubuntu"` в правилах вместо `job=~"ubuntu|proxmox-hosts"`.** Забываешь узел — и не узнаёшь, что он умер, потому что ни одно правило его не покрывает.

## Чек-лист понимания

- [ ] Я объясняю, почему Prometheus использует pull, и знаю, в каком случае push всё-таки нужен
- [ ] Я установил node_exporter на Ubuntu как отдельный пользователь под systemd и понимаю, зачем в unit-файле каждая строка изоляции
- [ ] Я читаю `/targets` и по тексту ошибки понимаю, что именно сломалось: файрвол, битый экспортёр или неверный путь
- [ ] Я различаю counter, gauge, histogram и summary, знаю, почему для p99 нужен histogram, и умею находить взрывную метрику по кардинальности
- [ ] Я отличаю `rate` от `irate`, знаю, почему окно должно быть не меньше `scrape_interval × 4`, и пишу запрос для дашборда как `sum(rate(...)) by (job)`
- [ ] Я знаю, зачем нужны recording rules, следую схеме `level:metric:operations` и не делаю `rate()` по записанной серии
- [ ] Я написал alert rule с `for`, `severity`, `runbook_url` и понимаю, что именно `for` спасает от alert fatigue
- [ ] Я знаю, сколько данных хранит Prometheus по умолчанию, зачем `--storage.tsdb.retention.time`, в какой момент переходить на VictoriaMetrics — и что Prometheus не заменит ни логи, ни трейсы

Дальше — [Grafana, Loki и алерты](devops/17-grafana-loki-alerty.md): собираем дашборды, ищем причину по логам и доводим маршрутизацию алертов до рабочего состояния. А если хочешь сразу всё это руками в своём Proxmox-контуре — [лабораторная 18](devops/18-lab-proxmox-monitoring.md).