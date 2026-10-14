---
title: Grafana, Loki и алерты
track: devops
module: D. Наблюдаемость
order: 17
duration: 85 мин
level: middle
tags: [grafana, loki, дашборды, alertmanager, шаблоны]
summary: Как превратить метрики Prometheus в дашборд, который отвечает на вопрос «что сломалось», и как настроить оповещения, которые не игнорируют
practice: Подними связку Prometheus + Grafana + Loki из лекции, собери один дашборд с переменной $host, экспортируй его в JSON в Git-репозиторий и настрой Alertmanager так, чтобы критические алерты приходили в Telegram-бот, а предупреждения — раз в 4 часа.
---

Метрики без витрины — это просто занимающий место текст в TSDB. В [лекции о Prometheus](devops/16-prometheus.md) ты получил поток чисел: экспортёры, цели, PromQL, правила алертов. В этой превращаешь его в две вещи, ради которых наблюдаемость вообще существует: **экран, на котором видно состояние системы**, и **сообщение, которое приходит в 3 часа ночи ровно один раз**. Обе вещи легко сделать плохо: дашборд из двадцати панелей, в котором ничего не видно, и алерты, которые звонят каждую минуту и в итоге выключаются. Разберём, как их делать правильно.

## Grafana — не витрина, а отчётность

### Дашборд — это утверждение о системе

Каждая панель на дашборде отвечает на вопрос. Если ты не можешь сформулировать вопрос, панель не нужна. Плохая практика — «дашборд всего»: двадцать графиков, где ничего не выделено. Хорошая — три экрана под три роли:

- **дежурному** — один экран: что горит, что деградирует, кого будить;
- **владельцу сервиса** — тренды за сутки и неделю, расход ресурсов, предвестники деградации;
- **себе по утрам** — ёмкость дисков, состояние бэкапов, версии, что изменилось за ночь.

Панель без владельца умирает за полгода: кто-то сменил схему сети, график стал пустым, никто не заметил, потому что смотреть его некому. Отсюда правило, которое стоит записать в папку проекта: **дашборд идёт в Git вместе с кодом, у него есть владелец и есть дата последнего осмысленного изменения**. Пятилетний дашборд без изменений — это мусор в браузере.

### Переменные и шаблонизация

Переменная — параметр дашборда, который позволяет одной панелью обслуживать всю инфраструктуру. Создаётся в `Dashboard settings → Variables → New`, тип `Query`:

- `Query` — список значений из источника данных. Для Prometheus это `label_values(node_uname_info, instance)`, для Loki — `label_values({job="node"}, host)`;
- `Custom` — забитый руками список (`prod`, `stage`);
- `Textbox` — свободный ввод, для запроса вроде `/api/v1/query?query=up{job="$job"}`;
- `Interval` — диапазон времени, чтобы один дашборд работал и на «последний час», и на «за год».

Дальше переменная подставляется в запрос панели:

```promql
node_load1{instance=~"$host"}
```

Три детали, которые ломают шаблонизацию чаще всего:

1. **Фильтр по метке, а не по подстроке в имени.** `instance=~"$host"` надёжнее, чем `instance=~".*$host.*"`. Всегда используй `=~`, потому что переменная — регулярка.
2. **`multi` + `includeAll` с `All value: .*`.** Множественный выбор бесполезен, если пункт «Все» возвращает пустое значение — график будет пустым и студент решит, что сломалось всё.
3. **Ссылка на дашборд с параметром.** Скопируй URL из браузера — в нём будет `var-host=ubuntu-01&from=now-6h`. Именно эту ссылку и нужно вставлять в уведомление Alertmanager, чтобы дежурный попал сразу на нужный экран.

## Панели: что выбрать и как читать график

| Тип панели | Для чего | Ошибка при выборе |
| --- | --- | --- |
| **Time series** | динамика величины во времени | пихать в неё счётчики (растёт монотонно) без `rate()` |
| **Stat** | одно число «сейчас» + sparkline | ставить без юнита: `0.92` от чего? |
| **Gauge** | значение относительно нормы (0–100%) | для величин без осмысленного максимума |
| **Table** | «топ» — узлы, потребители, каталоги логов | тянуть туда 50 000 строк без сортировки |
| **Heatmap** | распределение по времени суток (когда нагрузка) | использовать для одной скалярной величины |
| **Logs / Traces** | сырые логи Loki, трейсы Tempo | ожидать, что они заменят метрики |

### Среднее против минимума и максимума

Это главная причина, по которой инженеры смотрят на здоровый дашборд во время аварии. Разница видна на таком примере. Узел 24 ядра, каждые 5 секунд приходит пик на 2 секунды:

```promql
# среднее за окно — пик растворяется
avg by (instance) (node_load1{instance="pve01"})

# максимум внутри окна — пик виден
max_over_time(node_load1{instance="pve01"}[5m])

# хвост распределения — "как часто и насколько плохо"
quantile_over_time(0.99, node_load5{instance="pve01"}[5m])
```

На графике «avg» показывает ровную линию 1.2 — выглядит как норма. На графике «max» видно горки до 18 — а это уже признак того, что гипервизор отбирает CPU у ВМ. **Для алертов ставь порог по `max_over_time`, а не по `avg`** (разбор порогов — в [лабораторной лекции](devops/18-lab-proxmox-monitoring.md)).

Ещё три настройки панели, которые искажают картину:

- **Min step / Resolution** — если задать `5m` на панели с `rate()` от 15-секундного скрапа, короткие всплески исчезнут;
- **Connect null values** — соединение линии через разрывы превращает два отдельных инцидента в один длинный;
- **Legend format** — легенда должна содержать серию, а не `Series 1`. Формат `{{instance}} cpu={{value}}%` экономит минуты на каждом инциденте.

### Throttling и query step

Grafana отправляет в Prometheus запрос на весь выбранный диапазон. Если ты открыл «за год» на 500-серийном дашборде, получишь десятки тысяч точек, браузер зависнет. Защита — две настройки:

- `Max data points` в настройках панели (обычно 800–2000): Grafana сама поднимет `step`, и Prometheus вернёт огрублённый ряд;
- **`Min interval` в datasource** (например `15s`): сервер не будет запрашивать чаще, чем скрапится цель. Это лечит и недоступность, и лишнюю нагрузку.

Если страница открывается 30 секунд — сначала смотри `Max data points`, и только потом упрощай запрос. И никогда не пиши в панели тяжёлые `topk(50, ...)` по сырым рядам: сначала `rate()`/`irate()`, потом агрегация.

## Поднимаем связку: Prometheus, Grafana, Loki

Минимальный рабочий контур на одной машине. Каталог `obs/`:

```text
obs/
├── docker-compose.yml
└── configs/
    ├── prometheus.yml
    ├── alertmanager.yml
    ├── prometheus-rules.yml
    ├── loki-config.yml
    └── grafana/
        ├── datasources.yml
        └── dashboards.yml
```

```yaml
# obs/docker-compose.yml
services:
  prometheus:
    image: prom/prometheus:v2.54.1
    volumes:
      - ./configs/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./configs/prometheus-rules.yml:/etc/prometheus/rules.yml:ro
      - prom-data:/prometheus
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=30d
      - --web.enable-lifecycle
    ports: ["9090:9090"]
    restart: unless-stopped

  grafana:
    image: grafana/grafana:11.3.0
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:?задай в .env}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_ANALYTICS_REPORTING_ENABLED: "false"
      GF_INSTALL_PLUGINS: ""
    volumes:
      - ./configs/grafana/datasources.yml:/etc/grafana/provisioning/datasources/ds.yml:ro
      - ./configs/grafana/dashboards.yml:/etc/grafana/provisioning/dashboards/dash.yml:ro
      - ./dashboards:/var/lib/grafana/dashboards:ro
      - grafana-data:/var/lib/grafana
    ports: ["3000:3000"]
    depends_on: [prometheus, loki]
    restart: unless-stopped

  loki:
    image: grafana/loki:3.3.2
    command: -config.file=/etc/loki/loki-config.yml
    volumes:
      - ./configs/loki-config.yml:/etc/loki/loki-config.yml:ro
      - loki-data:/loki
    ports: ["3100:3100"]
    restart: unless-stopped

  alloy:
    image: grafana/alloy:v1.5.1
    command:
      - run
      - --server.http.listen-addr=0.0.0.0:12345
      - --storage.path=/var/lib/alloy/data
      - /etc/alloy/config.alloy
    volumes:
      - ./configs/config.alloy:/etc/alloy/config.alloy:ro
      - /var/log:/var/log:ro
      - /run/log/journal:/run/log/journal:ro
    restart: unless-stopped

  alertmanager:
    image: prom/alertmanager:v0.28.0
    volumes:
      - ./configs/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
      - am-data:/alertmanager
    ports: ["9093:9093"]
    restart: unless-stopped

volumes:
  prom-data:
  grafana-data:
  loki-data:
  am-data:
```

```yaml
# obs/configs/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 30s
  external_labels:
    stack: homelab

rule_files:
  - /etc/prometheus/rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]

  - job_name: node
    static_configs:
      - targets: ["node-exporter:9100"]
        labels:
          site: homelab
```

```yaml
# obs/configs/config.alloy
loki.write "default" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}

loki.source.journal "default" {
  forward_to = [loki.write.default.receiver]
  max_age     = "12h"
  labels = {
    host = sys.env("HOSTNAME"),
    job = "system",
  }
  relabel_rules = [
    { source_labels = ["_SYSTEMD_UNIT"], target_label = "unit" },
    { source_labels = ["_SYSTEMD_USER_UNIT"], target_label = "unit" },
    { source_labels = ["syslog_identifier"], target_label = "syslog_id" },
    { source_labels = ["_SYSTEMD_PRIORITY"], target_label = "priority" },
  ]
}

prometheus.scrape "node" {
  targets    = ["node-exporter:9100"]
  forward_to = [prometheus.remote_write.receiver]
}

prometheus.remote_write "default" {
  endpoint {
    url = "http://prometheus:9090/api/v1/write"
  }
}
```

Проверка, что стек ожил:

```bash
cd obs && docker compose up -d
curl -s localhost:9090/-/healthy && echo " prometheus ok"
curl -s localhost:3100/ready && echo " loki ok"
curl -s 'localhost:9090/api/v1/targets?state=active' | head -c 300
docker compose logs -f alloy | grep -i push
```

> [!NOTE]
> Promtail объявлен устаревшим и больше не обновляется — агентом сбора логов
> сейчас делают **Grafana Alloy**. Старый `promtail` с тем же конфигом
> (`clients: [{url: http://loki:3100/loki/api/v1/push}]` + `scrape_configs`)
> работает и ничего не сломается, но новые проекты на нём не начинают.

### Плагин для VictoriaMetrics

Если позже Prometheus заменится на VictoriaMetrics (обычно это происходит на 5–10 крупных инстансах: меньше памяти, длиннее хранение), дашборды не должны рассыпаться. Для этого в Grafana есть официальный плагин метрик VictoriaMetrics — ставится через `GF_INSTALL_PLUGINS` в переменных окружения:

```yaml
environment:
  GF_INSTALL_PLUGINS: grafana-victoriametrics-metrics-datasource
```

Плагин добавляет в datasource параметры `-search.maxLookback` и `-rollup.step` — это позволяет натянуть частоту скрапа на частоту панелей и убрать лишние точки у VictoriaMetrics. Само имя плагина менялось от версии к версии, поэтому перед установкой проверь его в каталоге плагинов; суть не в названии, а в том, что datasource Prometheus и VictoriaMetrics становятся взаимозаменяемыми, и дашборд переживает миграцию.

## Дашборд как код: JSON в Git

Grafana умеет отдавать дашборд в JSON (`Dashboard settings → JSON Model` или по API), и умеет наоборот — подхватить из файла. Это превращает графику в код, который проходит ревью:

```yaml
# obs/configs/grafana/dashboards.yml
apiVersion: 1
providers:
  - name: infra
    folder: Инфраструктура
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: false
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: true
```

```bash
# выгрузить все дашборды в файлы
mkdir -p obs/dashboards/infra
DS_UID=grafana TOKEN=$(curl -s -u admin:$GRAFANA_PASSWORD \
  http://localhost:3000/api/search?type=dash-db | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["uid"])')

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/dashboards/uid/$DS_UID" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);json.dump(d["dashboard"],open("obs/dashboards/infra/node.json","w"),ensure_ascii=False,indent=2)'

cd obs && git init && git add . && git commit -m "мониторинг: дашборд инфраструктуры в git"
```

`allowUiUpdates: false` — важный флаг: без него человек правит дашборд в интерфейсе, через пять минут файл из Git перезаписывает его правку, и человек злится. Правило простое: рисуешь в интерфейсе, потом экспортируешь в JSON, коммитишь, деплоишь.

## Loki: логи как временные ряски

### Идея, которая всё упрощает

Elasticsearch индексирует каждое слово лога. Loki этого не делает: он **не строит полнотекстовый индекс**. Вместо этого при запросе смотрит только на файлы, чьи метки совпали, и ищет подстроку в них. Отсюда всё остальное поведение:

- метки (`{job="node", host="ubuntu-01", unit="ssh.service"}`) — единственный индекс, они формируют «колонки» временного ряда;
- содержимое ищется только внутри найденных чанков, поэтому запрос по всем логам домена — дорогой;
- **дешёвое хранение**: чанки сжимаются, дубликаты меток не размножают индексы;
- **дёшево вставлять**: агент шлёт поток, Loki не строит ничего тяжёлого на запись.

LogQL — язык запросов. Три оператора покрывают 90% задач:

```logql
# 1. отфильтровать поток по меткам
{job="node", host=~"ubuntu-0.*"}

# 2. |= точное совпадение подстроки, |~ regex — самый частый случай
{job="system", unit="ssh.service"} |= "Failed password"
{job="system"} |~ "error|fatal|refused"

# 3. агрегация в метрику: сколько ошибок в минуту
sum by (host) (rate({job="system"} |= "error" [5m]))
```

Отдельно полезная штука — распечатка в структурном виде перед агрегацией. Ключи Loki не стабильны между релизами, поэтому сначала посмотри глазами, потом пиши запрос:

```logql
{job="system"} |= "sshd" | line_format "{{.time}} {{._SYSTEMD_UNIT}} {{.__CURSOR__}}"
```

### Loki, Elasticsearch, ClickHouse

| Критерий | Loki | Elasticsearch | ClickHouse |
| --- | --- | --- | --- |
| Индексация | только метки | полнотекстовая | по словарю (грань) |
| Цена хранения | низкая | высокая | средняя |
| Скорость записи | очень высокая | средняя | очень высокая |
| Поиск по произвольному тексту | медленный | лучший из трёх | средний |
| Фильтр по полям и агрегации | слабый | средний | лучший из трёх |
| Нагрузка на память | низкая | высокая | средняя |
| Логи контейнеров и `journalctl` | родная зона | через Filebeat | через Vector |
| Когда выбирают | 80% хостов и ВМ, метки известны | «grep по всей истории», произвольные тексты | структурированные логи, метрики по ним |

Практическое правило: **не запускай Elasticsearch ради того, чтобы посмотреть последний час `systemd`**. Логи не должны быть местом, где ты ищешь иголку. Настоящая причина строить ES — многотысячные архивы, произвольный полнотекстовый поиск и требования аудита.

### Агент на виртуалке

Alloy ставится на каждую ВМ, которая производит логи. Минимальная единица — journal. Проверка, что поток идёт:

```bash
curl -sG localhost:3100/loki/api/v1/label/host --data-urlencode 'start=0'
# {"status":"success","data":["ubuntu-01","pve01"]}
```

## Alertmanager: маршрутизация без шума

Prometheus **вычисляет** алерты, Alertmanager **доставляет** их. Разделение это принципиальное: Prometric не знает, кто дежурный и куда писать, а Alertmanager не знает, что такое метрика.

### Правило в Prometheus

```yaml
# obs/configs/prometheus-rules.yml
groups:
  - name: node
    rules:
      - alert: NodeFilesystemAlmostFull
        expr: |
          (
            node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}
            / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}
          ) < 0.15
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Мало места на {{ $labels.instance }} ({{ $labels.mountpoint }})"
          description: "Свободно {{ $value | humanizePercentage }}, меньше порога 15%."

      - alert: NodeDown
        expr: up{job="node"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Узел {{ $labels.instance }} недоступен дольше 2 минут"
```

`for: 10m` — это `group_wait`-до-алерта на стороне Prometheus: метрика должна быть плохой десять минут подряд, прежде чем алерт уйдёт дежурному. Он отсекает ровно то, что портит жизнь: правило, которое сработало на микровсплеске в 3 часа ночи.

### Маршрутизация, группировка, шаблоны

```yaml
# obs/configs/alertmanager.yml
global:
  resolve_timeout: 15m

route:
  receiver: telegram-info
  group_by: ['alertname', 'instance']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers:
        - severity = "critical"
      receiver: telegram-critical
      repeat_interval: 30m
    - matchers:
        - severity = "warning"
      receiver: telegram-warning
      repeat_interval: 2h
    - matchers:
        - severity = "info"
      receiver: telegram-info

inhibit_rules:
  - source_matchers: [severity="critical"]
    target_matchers: [severity="warning"]
    equal: ['alertname', 'instance']

receivers:
  - name: telegram-critical
    telegram_configs:
      - bot_token: '123456789:AAHbotTOKENhere'
        chat_id: '-1001234567890'
        parse_mode: HTML
        message: |
          <b>{{ if eq .Status "firing" }}КРИТИЧНО{{ else }}РЕШЕНО{{ end }}</b>
          {{ range .Alerts }}
          <b>{{ .Labels.alertname }}</b> — {{ .Annotations.summary }}
          Узел: <code>{{ .Labels.instance }}</code>
          Значение: <code>{{ .Value }}</code> (с {{ .StartsAt.Format "15:04 02.01" }})
          {{ if .DashboardURL }}<a href="{{ .DashboardURL }}">Открыть график</a>{{ end }}
          {{ end }}
  - name: telegram-warning
    telegram_configs:
      - bot_token: '123456789:AAHbotTOKENhere'
        chat_id: '-1001234567890'
        parse_mode: HTML
        message: |
          <b>ВНИМАНИЕ</b> {{ range .Alerts }}{{ .Annotations.summary }} ({{ .Labels.instance }}) {{ end }}
  - name: telegram-info
    webhook_configs:
      - url: 'http://127.0.0.1:8000/hooks/ops'
```

> [!WARNING]
> Проверяй шаблон до того, как он станет дежурным: любой неверный
> `{{ .Annotations.summary }}` (например, пустое поле) уронит отправку целиком.
> Прогнать можно офлайн — `amtool check-config obs/configs/alertmanager.yml`.

Что означают тайминги — их надо понимать, а не копировать:

| Параметр | Смысл | Типовое значение |
| --- | --- | --- |
| `group_by` | какие алерты склеиваются в одно сообщение | `['alertname','instance']` |
| `group_wait` | сколько ждать первого уведомления, надеясь, что подтянутся «родственные» алерты | 30s |
| `group_interval` | минимальный интервал между сообщениями по той же группе | 5m |
| `repeat_interval` | как часто повторять, пока алерт горит | 4h для warning, 30m для critical |
| `inhibit_rules` | подавить «предупреждение», пока по этой сущности горит «критичное» | всегда полезно |

Проверка и временное глушение, не отключая правило:

```bash
docker compose -f obs/docker-compose.yml restart alertmanager
amtool alert query alertmanager:9093
amtool silence add alertname="NodeFilesystemAlmostFull" instance="ubuntu-01" \
  --duration=2h --comment="чищу диск, алерт ожидаем" --author=admin
amtool silence query alertmanager:9093
```

### Правило «одно правило — один симптом»

Главный источник шума — правила, написанные на причину. «CPU больше 80%» — это не симптом, это состояние; нормальный при большой нагрузке процессор и есть 80%. Симптом — то, что человек почувствовал: «пользователи не могут зайти», «ответы ИИ-сервиса идут по 8 секунд», «бэкап не завершился за окно».

| Формулировка | Вердикт | Почему |
| --- | --- | --- |
| CPU > 80% | плохо | ни о чём не говорит без контекста |
| Диск заполнен на 95% | условно | хорошо только как `PredictDiskFull`, с прогнозом «свободное место кончится через 4 часа» |
| `NodeDown` 2 минуты | хорошо | это то, что человек заметит |
| `NTDS.dit` > 30 ГБ | хорошо | прямое предвестниковое тормозов AD |

И второе правило: **у алерта есть владелец и есть кнопка «это ожидаемо»**. Если дежурный не может за 30 секунд понять, что делать, алерт либо переводится в warning, либо удаляется. Молчащий Alertmanager в 4 часа утра — это не надёжная система, это тревожность.

> [!TIP]
> На маленьком контуре Telegram-бот — лучший канал: push на телефон без
> VPN и почтовых фильтров, доставка за секунды, бесплатно. Дальше по мере
> роста: email для warning, вебхук в свой сервис для автотикетов,
> PagerDuty (или его аналоги) — только когда появится круглосуточная дежурка.

> [!IMPORTANT]
> Alertmanager — не система доставки, а **система маршрутизации и антишума**.
> Если у тебя один приёмник и одно правило, весь этот слой не нужен.
> Он начинает окупаться на третьем-четвёртом разных получателе.

## Где это ломается

- **Правило на причину.** «Диск 90%» шлёт алерт в полдень каждый день, его отключают — и через неделю перестаёт приходить алерт про реально сломанный диск.
- **Нет `for:` и `group_wait` в нужном месте.** Десяток срабатываний подряд за минуту превращается в десяток сообщений. Без группировки Alertmanager — генератор шума, который выключают за один вечер.
- **Высокая кардинальность.** Лейбл `request_id` или `user` в метрике создаёт миллионы серий, `query` падает, а память Prometheus уезжает в OOM. Лейблы на метриках — это только `instance`, `job`, `route`, `method`.
- **Grafana как единственное место хранения дашбордов.** Потерял том с `grafana-data` — потерял всю наблюдаемость вместе с настройками. JSON в Git — это и бэкап, и ревью.
- **Неизвестные `Min interval` и `Max data points`.** Дашборд на 50 серий открывается 40 секунд и выглядит как «всё зависло», хотя Prometheus жив.
- **Бэкап Alertmanager и его конфига.** Потеряв `alertmanager.yml`, ты получаешь дежурство, которое молчит. Конфиг — в Git рядом с правилами Prometheus.
- **Прометеус без резервирования.** Стек из четырёх контейнеров на одном диске — четыре способа потерять наблюдаемость. Подробно про это — в [лекции о бэкапах](devops/19-backup-i-dr.md).

## Чек-лист понимания

- [ ] Я могу назвать вопрос, на который отвечает каждая панель дашборда, и сказать, кто её владелец
- [ ] Я понимаю разницу между `avg`, `max_over_time` и `quantile_over_time` на реальном пике нагрузки
- [ ] Я поднял связку Prometheus + Grafana + Loki и вижу логи `ssh.service` в панели Explore
- [ ] Я выгрузил дашборд в JSON, закоммитил в Git и умею задеплоить его обратно через provisioning
- [ ] Я знаю, чем `group_wait`, `group_interval` и `repeat_interval` отличаются и что именно они шлют в Telegram
- [ ] Я могу объяснить, почему Loki дешевле Elasticsearch и в каком случае Elasticsearch всё-таки нужен
- [ ] Я написал алерт на симптом, а не на причину, и проверяю его искусственно, а не жду реальной аварии
- [ ] Я знаю, что делать, если у меня один приёмник — и осознанно не разворачиваю Alertmanager в этом случае

Дальше — [лабораторная лекция](devops/18-lab-proxmox-monitoring.md), где вся эта теория превращается в работающий мониторинг реального контура: Proxmox, Ubuntu и Windows AD DC.