---
title: Лаборатория: мониторинг Proxmox, AD и Ubuntu
track: devops
module: D. Наблюдаемость
order: 18
duration: 120 мин
level: senior
tags: [lab, proxmox, active directory, windows, метрики, лабораторная]
summary: Собираем наблюдаемость реального контура целиком — Proxmox, Ubuntu-гости и Windows AD DC — без установки лишнего софта и без сети-ловушки с AD
practice: Собери три слоя метрик (железо, гипервизор, гости), включи smartd-сканирование и textfile-коллектор, поставь windows_exporter на контроллер домена со скриптом NTDS.dit, напиши правила алертов из лекции и добавь все источники в один дашборд Grafana.
---

Эта лекция — ключевая практическая работа всего DevOps-трека. До неё ты умел собирать метрики в теории: [Prometheus и PromQL](devops/16-prometheus.md), [дашборды, логи и алерты](devops/17-grafana-loki-alerty.md). После неё у тебя есть работающая система наблюдаемости на **твоём** контуре: Proxmox-гипервизор, Ubuntu-серверы и Windows AD DC. Материал рассчитан на два-три вечера, потому что часть шагов требует перезагрузки и прав администратора домена. Если у тебя нет доступа к Proxmox прямо сейчас — читай и собирай конфиги в стенде: все примеры воспроизводимы.

## Слои наблюдаемости

Главная ошибка при мониторинге виртуализированного контура — смотреть только внутрь гостя. Тогда классическая фраза «AD тормозит» превращается в гадание: то ли контроллер домена перегружен, то ли гипервизор отбирает у него CPU, то ли деградировал диск под виртуальной машиной, то ли умер вентилятор и всё встало на thermal throttling.

Правильный подход — три независимых слоя. Каждый отвечает на свой вопрос, и у каждого своя точка отказа:

| Слой | Источник | Что видим | Чего не видим |
| --- | --- | --- | --- |
| **Железо** | SMART (`smartctl`/`smartd`), `ipmitool`, `lm-sensors` | состояние дисков, температуру, вентиляторы, отказ PSU | что происходит на уровне ОС |
| **Гипервизор** | API Proxmox, `node_exporter` на хосте, QEMU-статистика | steal/iowait, память и swap хоста, загрузка ВМ, balloon | что происходит **внутри** гостя |
| **Гость** | `node_exporter` в Ubuntu, `windows_exporter` в Windows | процессы, диски, службы, доменные метрики | перегрузку со стороны гипервизора |

Порядок диагностики всегда сверху вниз. Если `pve01` показывает 25% steal — тебе не нужно подниматься внутрь ВМ вообще, проблема в гипервизоре. Если steal 0, а внутри гостя `iowait` 60% — иди в гость. Именно поэтому метрики гипервизора собираются первыми, а не последними.

> [!IMPORTANT]
> Внешние метрики ВМ из API Proxmox (`cpu`, `mem`, `netin`, `diskread`)
> показывают **нагрузку, которую гипервизор наблюдает снаружи**, а не то,
> что происходит внутри. Внутри ВМ может висеть процесс с дедлоком,
> который снаружи выглядит как «ВМ спит, CPU 0%». Это дыра, которую
> закрывает только агент в госте — и частично qemu-guest-agent.

## Слой 1: железо — SMART и температура

### Что можно получить без специального софта

В Proxmox `smartmontools` уже стоит, и вместе с ним идёт демон `smartd`, который умеет сам рассылать отчёты. Сначала посмотри, что уже есть, и не переустанавливай:

```bash
smartctl -a /dev/sda | head -40
smartctl --scan-open
systemctl status smartd --no-pager
cat /etc/smartd.conf
```

Дефолтный `/etc/smartd.conf` в Proxmox близок к этому — сканирование атрибутов раз в сутки плюс длинный self-test раз в неделю:

```bash
# /etc/smartd.conf — после правки
DEVICESCAN -a -o on -S on \
  -s (S/../.././02|L/../../6/03) \
  -m exec /usr/local/bin/smartd-notify.sh \
  -M exec /usr/local/bin/smartd-notify.sh
```

Зачем `-m exec` вместо почты: отчёт попадает не в почтовый ящик, а в файл, который превращается в метрику. Настоящая почта на `root@` в типовом контуре либо не настроена, либо ушла в спам и через полгода про неё забыли — это самая частая причина, по которой про диск узнают после его смерти.

```bash
# /usr/local/bin/smartd-notify.sh — вызывается smartd, $1 = устройство, stdin = отчёт
#!/bin/bash
OUTDIR=/var/lib/node_exporter/textfile_collector
mkdir -p "$OUTDIR"
DEV=$(echo "$1" | tr '/' '_')
cat >> "$OUTDIR/smartd_${DEV}.prom" <<EOF
# HELP node_smart_report Устройство: $1
# TYPE node_smart_report gauge
EOF
grep -E '^[A-Za-z_0-9]+:' >> "$OUTDIR/smartd_${DEV}.prom"
exit 0
```

```bash
chmod +x /usr/local/bin/smartd-notify.sh
install -d -m 0755 /var/lib/node_exporter/textfile_collector
systemctl restart smartd
```

> [!NOTE]
> Имена метрик, которые textfile-коллектор создаст из этого файла, зависят
> от версии `node_exporter`. Не угадывай их — посмотри:
> `curl -s localhost:9100/metrics | grep -i smart`. Дальше пиши алерты
> по фактическим именам. Разница между поколениями экспортёров — источник
> половины «не работает, хотя должно».

### Альтернатива: smartctl_exporter

Если не хочется писать скрипты — есть готовый `prometheus-community/smartctl_exporter`. Он поднимает HTTP-эндпоинт и сам забирает отчёты из `smartd`, который при этом настроен на `-m exec` в его адрес:

```bash
docker run -d --name smartctl-exporter --restart unless-stopped \
  -v /dev:/dev:ro \
  -p 9102:9102 \
  prom/smartctl-exporter:0.9.0 --verbose
```

```yaml
# фрагмент prometheus.yml
  - job_name: smart
    static_configs:
      - targets: ['pve01:9102']
    relabel_configs:
      - source_labels: [device]
        target_label: device
```

### Чего node_exporter не умеет принципиально

`node_exporter` — софтовый сборщик. Он не имеет права читать регистры материнской платы и контроллера вентиляторов. Он физически не видит:

- температуру материнской платы и VRM;
- скорость вентиляторов;
- состояние вентиляторов блока питания;
- температуру SSD (кроме тех значений, что есть в SMART-атрибутах).

Вариантов два, и это надо проговорить честно:

| Вариант | Когда применять | Что получишь |
| --- | --- | --- |
| `ipmi_exporter` | сервер с BMC/IPMI (материнка с IPMI, серверная платформа, IPMI-карта) | температуры всех датчиков, вентиляторы, статус PSU, температура процессора |
| `lm-sensors` + textfile | белая материнка без BMC | температура CPU (`coretemp`), иногда вентиляторы — если драйвер их отдаёт |
| Ничего | офисный ПК без датчиков в драйвере | только температура диска из SMART-атрибута 194/190 |

```bash
apt install lm-sensors
sensors-detect --auto
sensors
```

Кривая `sensors-textfile.sh` превращает вывод в метрики. Парсер здесь намеренно простой: вывод `sensors` на разных платах разный, и ты всё равно будешь его дописывать под свою материнку.

```bash
cat >/usr/local/bin/sensors-textfile.sh <<'EOF'
#!/bin/bash
OUT=/var/lib/node_exporter/textfile_collector/sensors.prom
install -d -m 0755 "$(dirname "$OUT")"
TMP="${OUT}.$$"
{
  echo "# HELP hw_sensor_temperature_celsius Температура датчиков, C"
  echo "# TYPE hw_sensor_temperature_celsius gauge"
  echo "# HELP hw_sensor_fan_rpm Скорость вентиляторов, RPM"
  echo "# TYPE hw_sensor_fan_rpm gauge"
  sensors 2>/dev/null | awk '
    /^[A-Za-z0-9_-]+:/ { chip=$0; sub(/:.*/,"",chip); next }
    /°C/ {
      key=$1; val=$3; gsub(/°C/,"",val); gsub(/\(.*/,"",val);
      if (chip != "" && chip != "Adapter" && val != "")
        printf "hw_sensor_temperature_celsius{chip=\"%s\",sensor=\"%s\"} %s\n", chip, key, val;
    }
    /RPM/ {
      key=$1; val=$3; gsub(/RPM/,"",val); gsub(/\(.*/,"",val);
      if (chip != "" && val != "")
        printf "hw_sensor_fan_rpm{chip=\"%s\",fan=\"%s\"} %s\n", chip, key, val;
    }'
} > "$TMP"
mv "$TMP" "$OUT"
EOF
chmod +x /usr/local/bin/sensors-textfile.sh
echo '*/5 * * * * root /usr/local/bin/sensors-textfile.sh' >/etc/cron.d/sensors-textfile
/usr/local/bin/sensors-textfile.sh && cat /var/lib/node_exporter/textfile_collector/sensors.prom
```

> [!WARNING]
> Если датчиков нет — это не проблема скрипта. Софтом температуру
> материнской платы не получить. Правильные варианты: IPMI-карта,
> BMC-модуль или внешний USB-датчик температуры. Дальше мониторинг
> дисков по SMART и всё. Не выдумывай «нормальную температуру» из
> ничего — это ложное чувство защищённости.

## Слой 2: гипервизор — метрики Proxmox без агента

Штатный список внешних metric-серверов Proxmox — **Graphite, InfluxDB и OpenTelemetry**. Prometheus в этом списке нет, плагин для Prometheus тоже. Вариантов было два: ставить агента-экспортёра на сам гипервизор либо разговаривать с API напрямую. Второй путь дешевле и надёжнее — API Proxmox сам по себе очень стабильная вещь.

### Токен с минимальными правами

Ключевая идея: пользователь без пароля, роль только на чтение, доступ выдан **напрямую токену**, а не через пользователя. Именно прямое назначение позволяет отключить privilege separation и не дать токену унаследовать права сверх нужных.

```bash
# 1. пользователь без пароля и без прав
pveum user add pveexporter@pve

# 2. минимальная роль: только аудит узлов, ВМ и хранилищ
pveum role add ProxmoxAudit -privs "Sys.Audit,VM.Audit,Datastore.Audit"

# 3. роль пользователю
pveum aclmod / -user pveexporter@pve -role ProxmoxAudit

# 4. роль напрямую токену — обязательное условие для --privsep 0
pveum aclmod / -user pveexporter@pve -token pvexport -role ProxmoxAudit

# 5. сам токен
pveum user token add pveexporter@pve pvexport --privsep 0
```

Команда выведет две строки: `token ID: pveexporter@pve!pvexport` и `value: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Их нужно сохранить **сейчас** — значение второй раз не показывается.

```bash
install -d -m 0700 /etc/pve-exporter
echo 'pveexporter@pve!pvexport=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' \
  >/etc/pve-exporter/token
chmod 0600 /etc/pve-exporter/token

curl -s -H "Authorization: PVEAPIToken=$(cat /etc/pve-exporter/token)" \
  https://$(hostname -f):8006/api2/json/nodes/$(hostname)/status | head -c 200
```

Что конкретно отдают нужные эндпоинты — это и есть карта твоей наблюдаемости гипервизора:

| Эндпоинт | Ключевые поля | Что это значит |
| --- | --- | --- |
| `/nodes/{node}/status` | `cpu` (доля 0–1), `wait` (доля iowait), `idle`, `loadavg[3]`, `memory{total,used}`, `swap`, `rootfs{total,used,avail}`, `ksm{shared}`, `uptime`, `cpuinfo{cpus}` | состояние самого хоста |
| `/nodes/{node}/qemu` | список ВМ: `vmid`, `name`, `status` | инвентарь |
| `/nodes/{node}/qemu/{vmid}/status/current` | `cpu` (доля), `mem`, `maxmem`, `balloon`, `netin`, `netout` (байт/с), `diskread`, `diskwrite` (байт/с), `uptime`, `status`, `ha` | нагрузка конкретной ВМ снаружи |
| `/nodes/{node}/disks/list` | `health`, `model`, `serial`, `size`, `wearout` (NVMe), `smart` (если включён smartplug) | износ дисков, если есть smartplug |

> [!CAUTION]
> Поля `cpu`, `mem` в `/status/current` — это **среднее с прошлого опроса
> (примерно за минуту)**, а не моментальное значение. Не пытайся строить
> по ним панель с шагом 15 секунд: получишь ступеньки и решишь, что
> метрика «сглаживается». Для высокочастотных вещей внутри ВМ нужен агент
> в госте, для внешнего вида — `node_exporter` на самом гипервизоре.

### Экспортёр на стандартной библиотеке

Дальше — весь экспортёр целиком. Никаких pip-зависимостей: Python 3 на Proxmox уже есть, файл кладётся рядом с системными, запускается из systemd. Метрики отдаёт в стандартном текстовом формате, который понимает любой Prometheus.

```python
#!/usr/bin/env python3
# /opt/pve-exporter/pve_exporter.py
# Метрики Proxmox VE API -> Prometheus. Только стандартная библиотека.
import json, os, re, socket, ssl, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST    = os.environ.get("PVE_HOST", socket.getfqdn())
BIND    = os.environ.get("PVE_BIND", "0.0.0.0")
PORT    = int(os.environ.get("PVE_PORT", "9103"))
NODE    = os.environ.get("PVE_NODE", socket.gethostname())
CA      = os.environ.get("PVE_CA", "/etc/pve/pve-root-ca.pem")
VERIFY  = os.environ.get("PVE_VERIFY", "1") == "1"
TOKEN   = open("/etc/pve-exporter/token").read().strip()

ctx = ssl.create_default_context(cafile=CA if os.path.exists(CA) else None)
if not VERIFY:
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

dirty = re.compile(r"[^a-zA-Z0-9_]")


def esc(v):
    return dirty.sub("_", str(v))


def api(path):
    req = urllib.request.Request("https://%s:8006%s" % (HOST, path))
    req.add_header("Authorization", "PVEAPIToken=" + TOKEN)
    with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
        return json.load(r)["data"]


def node_metrics(node):
    d = api("/api2/json/nodes/%s/status" % node)
    lb = 'node="%s"' % esc(node)
    load = d.get("loadavg") or [0, 0, 0]
    out = [
        "pve_api_up 1",
        "pve_cpu_ratio{%s} %.4f" % (lb, float(d.get("cpu") or 0)),
        "pve_iowait_ratio{%s} %.4f" % (lb, float(d.get("wait") or 0)),
        "pve_load1{%s} %.3f" % (lb, float(load[0])),
        "pve_load5{%s} %.3f" % (lb, float(load[1])),
        "pve_load15{%s} %.3f" % (lb, float(load[2])),
        "pve_uptime_seconds{%s} %d" % (lb, int(d.get("uptime") or 0)),
    ]
    for part in ("memory", "swap", "rootfs"):
        blk = d.get(part) or {}
        for key in ("total", "used", "avail"):
            if key in blk:
                out.append("pve_%s_%s_bytes{%s} %d" % (part, key, lb, int(blk[key])))
    if d.get("ksm"):
        out.append('pve_ksm_shared_bytes{%s} %d' % (lb, int(d["ksm"].get("shared") or 0)))
    if d.get("cpuinfo"):
        out.append('pve_cpu_cores{%s} %d' % (lb, int(d["cpuinfo"].get("cpus") or 1)))
    return out


def vm_metrics(node):
    out = []
    for vm in api("/api2/json/nodes/%s/qemu" % node):
        st = api("/api2/json/nodes/%s/qemu/%s/status/current" % (node, vm["vmid"]))
        lb = 'id="%s",name="%s",node="%s"' % (
            vm["vmid"], esc(st.get("name") or "vm"), esc(node))
        mem = int(st.get("mem") or 0)
        maxmem = int(st.get("maxmem") or 0)
        out += [
            'pve_qemu_info{%s,status="%s"} 1' % (lb, esc(st.get("status") or "")),
            "pve_qemu_up{%s} %d" % (lb, 1 if st.get("status") == "running" else 0),
            "pve_qemu_cpu_ratio{%s} %.4f" % (lb, float(st.get("cpu") or 0)),
            "pve_qemu_mem_bytes{%s} %d" % (lb, mem),
            "pve_qemu_maxmem_bytes{%s} %d" % (lb, maxmem),
            "pve_qemu_mem_used_ratio{%s} %.4f" % (lb, mem / maxmem if maxmem else 0.0),
            "pve_qemu_balloon_bytes{%s} %d" % (lb, int(st.get("balloon") or 0)),
            "pve_qemu_netin_bytes_per_second{%s} %.1f" % (lb, float(st.get("netin") or 0)),
            "pve_qemu_netout_bytes_per_second{%s} %.1f" % (lb, float(st.get("netout") or 0)),
            "pve_qemu_diskread_bytes_per_second{%s} %.1f" % (lb, float(st.get("diskread") or 0)),
            "pve_qemu_diskwrite_bytes_per_second{%s} %.1f" % (lb, float(st.get("diskwrite") or 0)),
            "pve_qemu_uptime_seconds{%s} %d" % (lb, int(st.get("uptime") or 0)),
        ]
    return out


def disk_metrics(node):
    out = []
    try:
        disks = api("/api2/json/nodes/%s/disks/list" % node)
    except Exception:
        return out
    for dsk in disks:
        dev = esc(dsk.get("devpath"))
        lb = 'node="%s",dev="%s"' % (esc(node), dev)
        out.append('pve_disk_info{%s,health="%s"} 1' % (lb, esc(dsk.get("health") or "UNKNOWN")))
        out.append("pve_disk_size_bytes{%s} %d" % (lb, int(dsk.get("size") or 0)))
        if dsk.get("wearout") is not None:
            out.append("pve_disk_wear_percent{%s} %.1f" % (lb, float(dsk["wearout"])))
        for attr, val in re.findall(r"(\w+)_value=([0-9]+)", dsk.get("smart") or ""):
            out.append('pve_disk_smart_attr{%s,attr="%s"} %s' % (lb, attr.lower(), val))
    return out


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] not in ("/", "/metrics", "/healthz"):
            self.send_error(404)
            return
        try:
            body = "\n".join(node_metrics(NODE) + vm_metrics(NODE) + disk_metrics(NODE))
            code = 200
        except Exception as exc:
            body = "pve_api_up 0\n# %s\n" % str(exc).replace("\n", " ")
            code = 503
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer((BIND, PORT), Handler).serve_forever()
```

```ini
# /etc/systemd/system/pve-exporter.service
[Unit]
Description=Proxmox VE API exporter for Prometheus
After=network-online.target pveproxy.service

[Service]
Type=simple
User=root
Environment=PVE_HOST=your-pve-hostname.example.com
Environment=PVE_NODE=your-pve-hostname
Environment=PVE_CA=/etc/pve/pve-root-ca.pem
EnvironmentFile=-/etc/pve-exporter/env
ExecStart=/usr/bin/python3 /opt/pve-exporter/pve_exporter.py
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
python3 -m py_compile /opt/pve-exporter/pve_exporter.py && echo "синтаксис ок"
systemctl daemon-reload && systemctl enable --now pve-exporter
curl -s localhost:9103/metrics | grep -E '^pve_(api_up|qemu_up|load1|disk_info)'
```

Тонкости, на которых обычно спотыкаются:

- `PVE_HOST` должен совпадать с SAN в сертификате узла. Если не совпадает — поставь `PVE_VERIFY=0` и запри доступ файрволом, но не оставляй открытым в сеть.
- `pve_disk_smart_attr` заполняется только если в UI узла у диска включён smartplug: **Datacenter → Storage → Disks → выбрать диск → Use for SMART check**.
- Эндпоинт раскрывает инвентарь ВМ. Держи 9103 на управляющей сети и не пробрасывай наружу.

### node_exporter на самом гипервизоре

API Proxmox не отдаёт **steal time** — а это главный индикатор «хост отбирает ресурсы у гостя». Steal есть только в `/proc/stat`, то есть в `node_exporter`. Ставь его на самом хосте, иначе половина самой полезной метрики гипервизора теряется.

```bash
apt install prometheus-node-exporter
apt install lm-sensors smartmontools
systemctl enable --now prometheus-node-exporter
curl -s localhost:9100/metrics | grep -E '^node_cpu_seconds_total|^node_scrape_collector'
```

## Слой 3a: гость Ubuntu

Пакет есть и в Debian, и в Ubuntu, и в репозитории Proxmox. Начинай с него:

```bash
apt update && apt install -y prometheus-node-exporter
systemctl enable --now prometheus-node-exporter
curl -s localhost:9100/metrics | grep -E '^node_load1|^node_filesystem_avail_bytes' | head
```

Если пакета нет (минимальный образ, сторонний репозиторий, прокси без него) — ставится бинарником. Это не «плохой способ», это нормальный fallback: один файл, ноль зависимостей.

```bash
ARCH=amd64; VERSION=1.8.2
curl -sSL -o /tmp/ne.tar.gz \
  "https://github.com/prometheus/node_exporter/releases/download/v${VERSION}/node_exporter-${VERSION}.linux-${ARCH}.tar.gz"
tar -xzf /tmp/ne.tar.gz -C /tmp
install -m 0755 /tmp/node_exporter-${VERSION}.linux-${ARCH}/node_exporter /usr/local/bin/node_exporter
id prometheus >/dev/null 2>&1 || useradd -rs /bin/false -M prometheus
install -d -o prometheus -g prometheus -m 0755 /var/lib/node_exporter/textfile_collector
```

```ini
# /etc/systemd/system/node-exporter.service
[Unit]
Description=Prometheus node exporter
Documentation=https://github.com/prometheus/node_exporter
After=network-online.target

[Service]
Type=simple
User=prometheus
Group=prometheus
EnvironmentFile=-/etc/default/node_exporter
ExecStart=/usr/local/bin/node_exporter \
  --collector.textfile.directory=/var/lib/node_exporter/textfile_collector \
  --collector.systemd \
  --web.listen-address=:9100
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5
LimitNOFILE=65536
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now node-exporter
systemctl status node-exporter --no-pager | head -5
curl -s localhost:9100/metrics | grep '^node_textfile' || echo "textfile-пока пуст"
```

Если ставил пакетом и хочешь только поменять аргументы — не правь юнит руками, а используй `systemctl edit node-exporter`, иначе апгрейд пакета перезапишет твои изменения.

## Слой 3b: гость Windows AD DC

### Почему это самая сложная часть

Контроллер домена — не «ещё одна Windows-машина». У него есть состояние, которое **нельзя пересоздать из образа**: база `NTDS.dit`, SYSVOL, учётные записи, SID-ы, учётные записи компьютеров. Залил такой ВМ из дешёвого бэкапа «месячной давности» — получил рассинхрон репликации, отсутствующих пользователей и объяснения пользователям, почему их «уволили» полгода назад.

Отсюда два правила, которые надо принять до установки экспортёра:

1. У всех метрик windows_exporter **английские имена даже в русской локали** Windows. Ищи `windows_ad_...`, а не `windows_домен_...`. Авторинговые коды событий при этом остаются цифрами — 4625 это 4625 в любой локали.
2. Установка требует прав администратора домена, а не локального администратора.

```powershell
winget install prometheus-community.windows_exporter
# или без winget: скачать windows_exporter-<версия>.amd64.msi и
# msiexec /i windows_exporter-*.msi /quiet
```

```yaml
# C:\Program Files\windows_exporter\windows_exporter.yml
collectors:
  enabled:
    - ad
    - cpu
    - dns
    - logical_disk
    - memory
    - network
    - os
    - physical_disk
    - service
    - system
    - time
    - textfile
  disabled: [mssql, iis, netframework, vmware, thermal]

textfile:
  directory: 'C:\Program Files\windows_exporter\textfile_collector'

enable_com_handler: true
```

```powershell
Get-Service windows_exporter
curl.exe -k https://localhost:9186/metrics?collector=ad | Select-Object -First 15
curl.exe -k https://localhost:9186/metrics | findstr /C:"ad_ntds" /C:"ntds_dit"

New-NetFirewallRule -DisplayName 'windows_exporter (Prometheus)' `
  -Direction Inbound -Protocol TCP -LocalPort 9186 `
  -RemoteAddress 10.10.10.0/24 -Action Allow
```

Коллектор `logical_disk` в старых сборках назывался `file_systems` — если у тебя старая версия, проверь `curl -k https://localhost:9186/metrics | findstr /C:"collector_success"` и посмотри, какие коллекторы реально включились.

### Коллекторы домена и ключевые метрики

| Коллектор | Что собирает | Ключевые метрики | Почему важно |
| --- | --- | --- | --- |
| `ad` | состояние служб каталога | `windows_ad_ldap_client_sessions`, `windows_ad_atq_outstanding_requests`, `windows_ad_replication_pending_operations`, `windows_ad_replication_sync_requests_schema_mismatch_failure_total` | очередь LDAP и отставшая репликация — ранние признаки деградации |
| `time` | Windows Time Service | `windows_time_offset_seconds` | рассинхрон ломает Kerberos: вход падает с ошибкой 0x8007052D |
| `service` | состояние служб | `windows_service_state{name="NTDS\|Netlogon\|DFSR\|DNS"}` | NTDS не в `running` = контроллер домена мёртв для клиентов |
| `dns` | DNS-сервер | `windows_dns_...` | без DNS домен не резолвится, пользователи не заходят |
| `physical_disk` | физические диски | `windows_physical_disk_health_status`, `windows_physical_disk_size_bytes` | здоровье диска ВМ, а не самого контроллера |
| `logical_disk` | логические тома | `windows_logical_disk_size_bytes`, `..._free_bytes` | NTDS и база WDS/SCCM могут расти быстрее всего |
| `os` | ОС | `windows_os_info`, `windows_os_memory_free_bytes`, uptime | общая картина гостя |
| `textfile` | кастомные `.prom` | всё, что ты туда положил | сюда попадёт NTDS.dit |

### Дыра, которую надо закрыть: рост NTDS.dit

Это причина №1 тормозов Active Directory на маленьком контуре, и ни один штатный коллектор её не показывает. Механизм такой: при загрузке DC весь `NTDS.dit` (а он может быть 20–40 ГБ) читается в память. Пока он влезает в кэш — всё быстро. Перестал влезать — каждая операция логина идёт на диск, и AD «встаёт колом», хотя CPU и сеть в норме.

Что сделать: раз в 5–15 минут измерять размер файла и класть его в textfile-коллектор. Заодно посчитаем события, которые о нём же говорят.

```powershell
# C:\ProgramData\ad-textfile\ad-custom.ps1
# Кладёт кастомные метрики AD в textfile-коллектор windows_exporter.
$ErrorActionPreference = 'Stop'
$OutDir  = 'C:\Program Files\windows_exporter\textfile_collector'
$OutFile = Join-Path $OutDir 'ad_custom.prom'
$TmpFile = "$OutFile.tmp"

$L = New-Object 'System.Collections.Generic.List[string]'

$L.Add('# HELP ad_ntds_dit_size_bytes Размер базы данных Active Directory, байты')
$L.Add('# TYPE ad_ntds_dit_size_bytes gauge')
$Dit = Get-Item 'C:\Windows\NTDS\ntds.dit' -ErrorAction SilentlyContinue
if ($Dit) {
    $L.Add(('ad_ntds_dit_size_bytes {0}' -f $Dit.Length))
    $L.Add('# HELP ad_ntds_dit_age_hours Часов с последней записи в NTDS.dit')
    $L.Add('# TYPE ad_ntds_dit_age_hours gauge')
    $L.Add(('ad_ntds_dit_age_hours {0}' -f ([math]::Round(((Get-Date) - $Dit.LastWriteTime).TotalHours, 2))))
} else {
    $L.Add('ad_ntds_dit_size_bytes 0')
}

$L.Add('# HELP ad_sysvol_free_bytes Свободно на системном томе, байты')
$L.Add('# TYPE ad_sysvol_free_bytes gauge')
$Vol = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$L.Add(('ad_sysvol_free_bytes {0}' -f $Vol.FreeSpace))

$L.Add('# HELP ad_directory_service_events События журнала Directory Service за 15 минут')
$L.Add('# TYPE ad_directory_service_events gauge')
foreach ($Code in 4000, 4013, 4028, 4615) {
    $N = @(Get-WinEvent -FilterHashtable @{
        LogName = 'Directory Service'; Id = $Code
        StartTime = (Get-Date).AddMinutes(-15)
    } -ErrorAction SilentlyContinue).Count
    $L.Add(('ad_directory_service_events{{code="{0}"}} {1}' -f $Code, $N))
}

$L.Add('# HELP ad_failed_logon_total Неуспешные входы за 15 минут')
$L.Add('# TYPE ad_failed_logon_total gauge')
$Fail = @(Get-WinEvent -FilterHashtable @{
    LogName = 'Security'; Id = 4625
    StartTime = (Get-Date).AddMinutes(-15)
} -ErrorAction SilentlyContinue).Count
$L.Add(('ad_failed_logon_total {0}' -f $Fail))

$L.Add('# HELP ad_textfile_script_up Скрипт отработал успешно')
$L.Add('# TYPE ad_textfile_script_up gauge')
$L.Add('ad_textfile_script_up 1')

[System.IO.File]::WriteAllLines($TmpFile, $L)
Move-Item -Force $TmpFile $OutFile
```

Значения кодов: **4000** и **4013** — внутренняя ошибка службы каталога, чаще всего проблемы с базой или нехватка памяти при выделении; **4028** — общая внутренняя ошибка БД NTDS, обычно следствие рассинхрона времени или рассогласования `CN`; **4615** — контроллер домена не смог получить доступ к журналу безопасности; **4625** — неуспешный вход (нужен ещё аудит «Logon/Logoff», на контроллере домена он включён по умолчанию). Если хочешь читать описания на своей локали — `wevtutil gp Directory Service /lf:true | findstr /C:"0x" /C:4000`.

Задание по расписанию. Короткий вариант — одна команда:

```powershell
New-Item -ItemType Directory -Force -Path C:\ProgramData\ad-textfile | Out-Null
# положи сюда ad-custom.ps1, затем:
schtasks /Create /SC MINUTE /MO 10 /TN "ad-custom-textfile" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\ad-textfile\ad-custom.ps1" /RU SYSTEM /RL HIGHEST /F
schtasks /Run /TN "ad-custom-textfile"
type "C:\Program Files\windows_exporter\textfile_collector\ad_custom.prom"
```

Через `Register-ScheduledTask` — правильнее: задача видна в планировщике, у неё есть история и нормальная обработка ошибок.

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\ad-textfile\ad-custom.ps1'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'ad-custom-textfile' -Action $action `
  -Trigger $trigger -Principal $principal -Force
Start-ScheduledTask -TaskName 'ad-custom-textfile'
Get-ScheduledTaskInfo -TaskName 'ad-custom-textfile'
```

### qemu-guest-agent и почему он нужен

Без агента гипервизор не получает от гостя ничего, кроме данных о нагрузке. Отсюда — две конкретные дыры:

1. **Неточная память.** Если у гостя не включён balloon, `mem` в API покажет всю выделенную память, даже если гость использует треть. Для планирования ёмкости это враньё.
2. **Нет согласованных бэкапов и заморозки.** Агент умеет `fsfreeze`/`fsthaw` — без него снапшот делается «на живую», и об этом ещё будет лекция о бэкапах, но уже в [следующей](devops/19-backup-i-dr.md).

```bash
apt install qemu-guest-agent
systemctl enable --now qemu-guest-agent
echo -e "nameserver 10.10.10.1\nsearch corp.example.com" >/etc/resolv.conf.d/ad.conf
```

В Windows госте — `qemu-ga.msi` из ISO Proxmox, служба `QEMU Guest Agent`. После установки в веб-интерфейсе ВМ появится IP из гостя, а в конфигурации можно включить Balloon Device.

> [!IMPORTANT]
> Агент не заменяет метрики изнутри гостя. Он закрывает технический пробел
> между хостом и ВМ. Реальные метрики процессов, дисков и домена даёт
> только экспортёр, запущенный внутри гостя. Одно без другого — дыра.

## Собираем Prometheus и правила алертов

```yaml
# prometheus.yml — цели лаборатории
scrape_configs:
  - job_name: pve-exporter
    static_configs:
      - targets: ['pve01.example.com:9103']

  - job_name: pve-node
    static_configs:
      - targets: ['pve01.example.com:9100']

  - job_name: smart
    static_configs:
      - targets: ['pve01.example.com:9102']

  - job_name: ubuntu
    static_configs:
      - targets:
          - 'ubuntu-01.example.com:9100'
          - 'ubuntu-02.example.com:9100'

  - job_name: windows-ad
    scheme: https
    tls_config:
      insecure_skip_verify: true
    basic_auth:
      username: prometheus
      password_file: /etc/prometheus/secrets/win_password
    static_configs:
      - targets: ['dc-01.example.com:9186']
        labels:
          role: dc
    metric_relabel_configs:
      # помечаем ВМ контроллера домена, чтобы правила не били по всем
      - source_labels: [id]
        regex: '100'
        target_label: role
        replacement: dc
```

```yaml
# prometheus-rules-lab.yml
groups:
  - name: iron
    rules:
      - alert: HypervisorNodeDown
        expr: up{job=~"pve-node|pve-exporter"} == 0
        for: 2m
        labels: {severity: critical, layer: hardware}
        annotations:
          summary: "Гипервизор не отвечает: {{ $labels.instance }}"

      - alert: DiskSmartFailed
        expr: pve_disk_info{health!="PASSED"} == 1 or pve_disk_health != 1
        for: 1m
        labels: {severity: critical, layer: hardware}
        annotations:
          summary: "SMART: диск {{ $labels.dev }} на {{ $labels.node }} — {{ $value }}"

      - alert: NvmeWearoutLow
        expr: pve_disk_wear_percent < 10
        for: 30m
        labels: {severity: warning, layer: hardware}
        annotations:
          summary: "Ресурс NVMe {{ $labels.dev }} меньше 10%"
          description: "Осталось {{ $value }}% ресурса записи. Заказывай замену."

  - name: hypervisor
    rules:
      - alert: StealTimeHigh
        expr: |
          sum by (instance) (rate(node_cpu_seconds_total{mode="steal"}[5m]))
            / sum by (instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) > 0.10
        for: 15m
        labels: {severity: warning, layer: hypervisor}
        annotations:
          summary: "Steal {{ $value | humanizePercentage }} на {{ $labels.instance }}"
          description: "Гипервизор отбирает CPU у гостей. Проверь загрузку соседних ВМ и настройки vCPU."

      - alert: DomainControllerVmDown
        expr: pve_qemu_up{role="dc"} == 0
        for: 5m
        labels: {severity: critical, layer: hypervisor}
        annotations:
          summary: "ВМ контроллера домена выключена ({{ $labels.name }})"

      - alert: HypervisorMemoryPressure
        expr: |
          (1 - pve_memory_avail_bytes / pve_memory_total_bytes) > 0.90
        for: 10m
        labels: {severity: warning, layer: hypervisor}

  - name: guest
    rules:
      - alert: GuestDown
        expr: up{job=~"ubuntu|windows-ad"} == 0
        for: 3m
        labels: {severity: critical, layer: guest}

      - alert: GuestDiskSpaceLow
        expr: |
          (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}
            / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"}) < 0.15
        for: 15m
        labels: {severity: warning, layer: guest}
        annotations:
          summary: "Мало места на {{ $labels.instance }}:{{ $labels.mountpoint }} ({{ $value | humanizePercentage }})"

      - alert: GuestInodesLow
        expr: |
          (node_filesystem_files_free / node_filesystem_files) < 0.10
          and node_filesystem_files > 100000
        for: 15m
        labels: {severity: warning, layer: guest}
        annotations:
          summary: "Кончились иноды на {{ $labels.instance }}:{{ $labels.mountpoint }} ({{ $value | humanizePercentage }})"
          description: "Свободны файловые дескрипторы, а место есть. Ищи миллионы мелких файлов."

  - name: ad
    rules:
      - alert: ADControllerDown
        expr: up{job="windows-ad"} == 0 or windows_service_state{name="NTDS",state!="running"} == 1
        for: 2m
        labels: {severity: critical, layer: ad}
        annotations:
          summary: "Контроллер домена недоступен или NTDS не запущена"

      - alert: NTDSDatabaseTooBig
        expr: ad_ntds_dit_size_bytes > 30e9
        for: 1h
        labels: {severity: warning, layer: ad}
        annotations:
          summary: "NTDS.dit больше 30 ГБ ({{ $value | humanize1024 }})"
          description: "База не помещается в кэш — вход в домен будет медленным. Планируй расширение ОЗУ DC."

      - alert: ADClockSkew
        expr: abs(windows_time_offset_seconds) > 60
        for: 5m
        labels: {severity: critical, layer: ad}
        annotations:
          summary: "Рассинхрон времени на DC: {{ $value }} с"
          description: "Kerberos отклонит вход при расхождении больше 5 минут."

      - alert: ADReplicationBehind
        expr: windows_ad_replication_pending_operations > 0
        for: 30m
        labels: {severity: warning, layer: ad}

      - alert: ADSchemaMismatch
        expr: increase(windows_ad_replication_sync_requests_schema_mismatch_failure_total[1h]) > 0
        labels: {severity: warning, layer: ad}
        annotations:
          summary: "Конфликт схемы AD (FSMO-роль нужна на одном DC)"

      - alert: ADServiceEvent
        expr: increase(ad_directory_service_events[15m]) > 0
        labels: {severity: warning, layer: ad}
        annotations:
          summary: "Событие Directory Service, код {{ $labels.code }} (x{{ $value }})"

      - alert: ADFailedLogonSpike
        expr: increase(ad_failed_logon_total[15m]) > 20
        labels: {severity: warning, layer: ad}
        annotations:
          summary: "Много неуспешных входов: {{ $value }} за 15 минут"
```

Проверка перед загрузкой — обязательный шаг, он спасает от правил, которые не парсятся:

```bash
promtool check config prometheus.yml
promtool check rules prometheus-rules-lab.yml
curl -sG localhost:9090/api/v1/query --data-urlencode 'query=pve_qemu_up' | python3 -m json.tool
```

## Проверка под нагрузкой: не жди аварии

Алерт, который ни разу не срабатывал, не работает. Проверь каждый сценарий дешёвым способом — подставь значения через `expr`:

```promql
# имитация недоступного узла
up{job="pve-node"} == 0

# имитация диска, заполненного на 92%
(node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.15

# реальная проверка порога по подставленному значению
vector(1) > bool 0.5
```

Алгоритм: выбрал правило → выставил метрику в заведомо плохое значение через временный textfile-файл или `pushgateway` → убедился, что алерт перешёл в `firing` → убрал. Пока это не сделано, правило считается гипотезой.

## Симптом → куда смотреть

| Симптом | Слой | Первый запрос | Если не он — идём дальше |
| --- | --- | --- | --- |
| Пользователи не могут зайти в домен | AD | `windows_ad_ldap_client_sessions`, `windows_service_state{name="NTDS"}` | рассинхрон времени → память DC → логи Directory Service |
| Вход долгий, но удаётся | AD | `ad_ntds_dit_size_bytes`, `windows_ad_atq_outstanding_requests` | память DC, `iowait` внутри гостя |
| Вход падает с ошибкой времени | AD | `windows_time_offset_seconds` | состояние PDC Emulator, DNS |
| ВМ «зависла», но CPU 0% | гипервизор | `pve_qemu_cpu_ratio`, `pve_qemu_up` | steal на хосте, состояние ВМ в UI |
| Всё тормозит на одном хосте | гипервизор | `pve_load15 / pve_cpu_cores` | steal, iowait, `pve_memory_*` |
| Растёт задержка чтения на хосте | железо | `smartctl -a`, `pve_disk_info` | NVMe wearout, замена кабеля/диска |
| Гость медленный, хост спокоен | гость | `node_load15` внутри гостя | `node_filesystem_*`, `node_memory_MemAvailable_bytes` |
| Метрики ВМ пустые, а ВМ работает | гость | не установлен экспортёр | файрвол, сетевая доступность, авторизация |
| Резкий рост 4625 | AD | `ad_failed_logon_total` | аудит: откуда идут попытки, `4624` рядом |

## Где это ломается

- **Токен без `--privsep 0` и без ACL на сам токен.** Команда `pveum user token add` падает с невнятной ошибкой про права. Причина — не выданные токену права, а не пользователю.
- **Установил smartd, но не настроил `-m exec`.** По умолчанию отчёты уходят письмом на `root`, которого никто не читает. Диск с деградирующими секторами живёт месяцами.
- **Упёрся в лимит API.** Экспортёр делает по запросу на каждую ВМ плюс список. На 200 ВМ это 200+ запросов каждые 15 секунд, и `pveproxy` начинает отдавать 429. Смягчается увеличением `scrape_interval` для этого job и кэшированием инвентаря.
- **Текст на русском в имени метрики.** Значения лейблов и подписи в `.prom` должны быть в UTF-8; проверенные имена — латиницей. Метрика с пробелом в имени молча не импортируется.
- **Windows-метрики ищутся на русском.** Имена всегда английские, независимо от локали. Час на потерянный поиск.
- **Пароль Prometheus к windows_exporter в конфиге открытым текстом.** Держи `password_file` — этот файл попадает в бэкап и в Git, а пароль из него — в историю.
- **Алерт на `avg` вместо `max_over_time`.** Короткие пики, которые ломают вход в домен на минуту, никогда не пересекут порог по среднему.
- **Скрипт NTDS.dit запускается, но файл не появляется.** Проверь три вещи: каталог `textfile_collector` существует, задача реально отработала (`Get-ScheduledTaskInfo`), имя файла заканчивается на `.prom`. Плюс — запись должна идти во временный файл с последующим `Move-Item`, иначе коллектор периодически читает наполовину записанный файл.

## Чек-лист понимания

- [ ] Я могу назвать три слоя наблюдаемости и для каждого — что он видит и чего не видит
- [ ] Я создал токен Proxmox с `Sys.Audit,VM.Audit,Datastore.Audit` напрямую на токене и отключил `--privsep`
- [ ] Я понимаю, почему steal time нельзя получить из API Proxmox и зачем нужен `node_exporter` на хосте
- [ ] Я знаю, что `node_exporter` физически не видит температуру материнки и вентиляторы, выбрал ipmi или `lm-sensors` осознанно, а `smartd` у меня шлёт отчёты в метрики, а не на почту
- [ ] На контроллере домена работает `windows_exporter` с коллекторами `ad`, `time`, `service`, `physical_disk`, `logical_disk`, `textfile`
- [ ] Я измеряю размер `NTDS.dit` каждые 10 минут, знаю, при каком размере начнутся тормоза входа, и понимаю, почему журналы Directory Service и Security имеют разные коды и локализацию
- [ ] Я проверил каждое правило алерта искусственно и по строке таблицы «симптом → куда смотреть» сужаю область поиска за три минуты
- [ ] Я понимаю, зачем нужен qemu-guest-agent и почему он не заменяет экспортёр в госте

Следующая лекция — про [бэкапы и аварийное восстановление](devops/19-backup-i-dr.md): после того как система наблюдаемости поднята, вторая половина эксплуатации — не потерять данные.