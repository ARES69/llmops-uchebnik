---
title: Мониторинг сети в Prometheus
track: net
module: E. Мониторинг и автоматизация
order: 16
duration: 80 мин
level: middle
tags: [snmp, prometheus, snmp_exporter, метрики, ifmib, мониторинг]
summary: Почему сетевое оборудование нельзя мониторить node_exporter'ом и как собрать из него наблюдаемую систему на snmp_exporter: SNMPv3, модули, метрики IF-MIB, алерты и blackbox-пробы
practice: Подними snmp_exporter рядом с Prometheus, переведи одно устройство на SNMPv3, опиши его в prometheus.yml, сними реальные имена и скорости интерфейсов через snmpwalk ifDescr, напиши три правила алертов (порт упал / ошибки / утилизация выше 80%) и дашборд, и проверь каждое правило искусственно подставленным значением.
---

Серверы ты уже научился наблюдать: `node_exporter` на хосте, `windows_exporter` в ВМ с AD, Prometheus тянет метрики по HTTP — разбирается всё это в [лекции про Prometheus](devops/16-prometheus.md). С сетевым оборудованием так не выйдет. На маршрутизатор нельзя поставить агент: установка чего-либо ломает гарантию, лицензию и, на части платформ, саму прошивку — после обновления производитель снимает поддержку. Значит, агент должен стоять **рядом** с сетью и ходить к устройству по протоколу, который устройство само поддерживает. Такой протокол один, и он старше, чем Prometheus, — SNMP.

Эта лекция — про то, как из этого старого протокола сделать наблюдаемость уровня DevOps: метрики в Prometheus, алерты в Alertmanager, дашборд в Grafana. Связка с проксом и лабораторной — [лабораторная 18](devops/18-lab-proxmox-monitoring.md) собирает вторую половину твоего контура.

## Почему node_exporter здесь бесполезен

`node_exporter` читает `/proc` и `/sys`. На Cisco, MikroTik, UniFi или SNR этих файлов нет, и никакого агента, который их читает, туда не положить. Вариантов ровно три, и третий — единственно честный.

| Подход | Что требует от устройства | Вердикт |
| --- | --- | --- |
| node_exporter на устройстве | агент Linux, ssh/telnet-доступ, файловая система | **невозможно** на сетевом железе |
| node_exporter на хосте рядом | ничего — но метрики будут от *хоста*, а не от коммутатора | враньё: увидишь сеть ВМ, а не порты |
| Опрашивающий экспортёр по SNMP | включённый SNMP на устройстве | **рабочий путь**, дальнейшая лекция |

Отсюда формулировка, которую стоит запомнить дословно: **у сетевого оборудования нет агента — есть экспортёр, который стоит на другом хосте и опрашивает устройство снаружи**. Он ничего не выполняет на устройстве: ни скрипта, ни команды, ни файла. Всё, что он получает, — это ответы на GET-запросы к MIB-объектам.

```text
   Prometheus ──HTTP /snmp?target=...&module=if-mib──> snmp_exporter ──SNMP GET/GETNEXT──> 10.10.10.1
        │                                               (твой Linux-хост)                 (MikroTik/Cisco/...)
        ├── TSDB ──> Grafana (дашборды)
        └── правила ──> Alertmanager ──> Telegram/Slack
```

## snmp_exporter: что это и как поставить

`snmp_exporter` — HTTP-сервис на порту **9116**. Prometheus шлёт ему обычный HTTP-запрос с параметрами `target` (адрес устройства), `module` (какой набор MIB обходить) и `auth` (какими учётными данными). Экспортёр делает SNMP-обход, превращает OID в метрики и отдаёт текст в формате exposition — тот же, что `node_exporter`. Дальше всё как обычно.

```bash
# Версию смотри в релизах проекта: между 0.23 и 0.24 формат конфигурации менялся
VER=0.28.0
ARCH=amd64
curl -fsSLO "https://github.com/prometheus/snmp_exporter/releases/download/v${VER}/snmp_exporter-${VER}.linux-${ARCH}.tar.gz"
tar xzf "snmp_exporter-${VER}.linux-${ARCH}.tar.gz"
install -o root -g root -m 0755 "snmp_exporter-${VER}.linux-${ARCH}/snmp_exporter" /usr/local/bin/snmp_exporter
install -o snmp_exporter -g snmp_exporter -m 0755 -d /var/lib/snmp_exporter
install -o root -g root -m 0644 "snmp_exporter-${VER}.linux-${ARCH}/snmp.yml.example" /etc/snmp_exporter/snmp.yml
id snmp_exporter >/dev/null 2>&1 || useradd --system --no-create-home -s /usr/sbin/nologin snmp_exporter

/usr/local/bin/snmp_exporter --version
```

```ini
# /etc/systemd/system/snmp_exporter.service
[Unit]
Description=Prometheus SNMP Exporter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=snmp_exporter
Group=snmp_exporter
ExecStart=/usr/local/bin/snmp_exporter \
  --config.file=/etc/snmp_exporter/snmp.yml \
  --snmp.module-concurrency=8 \
  --web.listen-address=:9116
Restart=always
RestartSec=5s
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
RestrictSUIDSGID=yes
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now snmp_exporter
curl -s http://127.0.0.1:9116/ | head -20        # список модулей и авторизаций
```

> [!IMPORTANT]
> Экспортёр сам по себе ничего не знает про твою сеть. Без корректного `snmp.yml` (блок `auths`) и без сгенерированных модулей (блок `modules`) он вернёт 500 на любой запрос. Это самая частая причина «запустился, но метрик нет», и она лечится двумя файлами, а не переустановкой.

## Ручной опрос: сначала snmpwalk, потом Prometheus

Прежде чем писать конфигурацию Prometheus, опроси устройство руками. Это занимает минуту и сразу показывает, есть ли SNMP, какая версия работает и **какие именно объекты устройство отдаёт**, а не обещает документация.

```bash
apt install snmp                                  # пакет называется snmp, а не snmp-client
export SNMP_AUTH='<auth-passphrase>'
export SNMP_PRIV='<priv-passphrase>'

# v2c — базовый уровень. community-строка это пароль, просто без шифрования
snmpwalk -v2c -c public 10.10.10.1 SNMPv2-MIB::sysDescr.0
snmpwalk -v2c -c public 10.10.10.1 IF-MIB::ifDescr

# v3 — правильный уровень
snmpwalk -v3 -l authPriv -u prometheus \
  -a SHA256 -A "$SNMP_AUTH" -x AES -X "$SNMP_PRIV" \
  10.10.10.1 IF-MIB::ifDescr

# одна конкретная величина
snmpget -v3 -l authPriv -u prometheus -a SHA256 -A "$SNMP_AUTH" \
  -x AES -X "$SNMP_PRIV" 10.10.10.1 IF-MIB::ifOperStatus.3

# индексы интерфейсов (нужны, чтобы сопоставить ifDescr с ifHighSpeed)
snmpwalk -v2c -c public -Oe 10.10.10.1 IF-MIB::ifDescr
snmpwalk -v2c -c public -Oe 10.10.10.1 IF-MIB::ifHighSpeed
```

Community-строка — это **пароль, передаваемый открытым текстом при каждом запросе**, и её нельзя отозвать, не заходя на каждое устройство. Значение по умолчанию `public` — это не «просто для теста», это ключ, который перебирают сканерами в первую очередь: один UDP-пакет с `public` на весь парк даёт злоумышленнику карту сети, список интерфейсов, версии прошивок и имена пользователей из `sysName`/`sysDescr`. Смени `public` на непредсказуемую строку, ограничь вход по адресу и **переходи на v3** — это разговор в следующем разделе.

| | SNMPv1 | SNMPv2c | SNMPv3 |
| --- | --- | --- | --- |
| Аутентификация | community-строка | community-строка | пользователь + auth-passphrase |
| Шифрование | нет | нет | `priv`, AES/DES |
| Целостность пакета | нет | нет | HMAC при `auth` |
| 64-битные счётчики | **нет** | да | да |
| Сколько обходов одного узла | 1 | 1 | 2 (auth и priv отдельно, по одному запросу с ключом) |
| Вердикт для продакшена | нет | только в изолированном сегменте | **да** |

## SNMPv3 — главный рычаг безопасности

В SNMPv3 появляется модель USM (User Security Model) с тремя уровнями. Разница между ними не косметическая, она определяет, что именно увидит тот, кто слушает твой сегмент.

| Уровень | Что проверяется | Что видит перехватчик |
| --- | --- | --- |
| `noAuthNoPriv` | ничего | всё, включая community-подобные учётные данные |
| `authNoPriv` | HMAC: пакет нельзя изменить или подделать | содержимое читается, подделать нельзя |
| `authPriv` | плюс шифрование полезной нагрузки | ничего: только мусор и факт «SNMP-пакет от такого-то» |

Правило, которое стоит зашить: **уровень `authPriv` и больше ничего**. `authNoPriv` — это компромисс, который на практике никто не использует: трафик всё равно читается, а требования к паролям вдобавок выше.

Три элемента, которые надо различать в SNMPv3, потому что их постоянно путают:

- **USM user** (`prometheus`) — имя пользователя, передаётся открытым текстом при каждом обходе. Это не секрет.
- **auth passphrase** (`-A`) — ключ HMAC. Длиннее 8 символов, иначе устройство не примет. Для SHA-256 имеет смысл 32+ символа.
- **priv passphrase** (`-X`) — ключ шифрования. Для AES он должен быть 16–24 символа (128–192 бит).

### Конфигурация на устройстве

На Cisco IOS/IOS-XE это выглядит так. Точная форма команд зависит от версии платформы, поэтому после настройки всегда проверяй фактическое состояние командой `show snmp user` и `show snmp group`, а не тем, что ты хотел ввести.

```text
ip access-list standard SNMP-PEERS
 permit 10.10.10.50
 deny   any log

snmp-server group NETOPS v3 priv
snmp-server user netops NETOPS auth sha <auth_pass_32_символа> priv aes 128 <priv_pass_16_24_символа>
snmp-server user netops NETOPS SNMP-PEERS

snmp-server location office-1, rack 3
snmp-server contact ops@company.local
```

> [!NOTE]
> На других платформах набор команд другой, а где-то и вендорских SNMPv3 нет вовсе. MikroTik: SNMPv3 включается в разделе `/snmp` и **зависит от версии RouterOS** — открой свой `/snmp` и посмотри, есть ли в списке v3; если там только v1 и v2c, значит этой версией v3 не поддержан, и выход — изолированный management-VLAN плюс длинная community-строка. Дешёвые коммутаторы подManage: часто SNMPv1/v2c только. Прежде чем строить план мониторинга, пройдись по списку устройств и запиши, что каждое реально умеет — как это делается на первом шаге в [сети как коде](net/18-set-kak-kod.md).

### Прокси на Linux: когда устройство пускает не оттуда

Реальная ситуация: устройство доверяет SNMP только с адреса своего management-VLAN, а Prometheus живёт в другом сегменте, и поднимать транзитный VLAN ради этого не хочется. Классическое решение — `snmpd` на хосте с Prometheus в роли прокси: он сам опрашивает устройство и отдаёт результат наружу.

```conf
# /etc/snmp/snmpd.conf  — сокращённо, только смысл
# 1) Кто может ходить в этот демон: только адрес Prometheus
rocommunity  netops-readonly  10.10.10.50/32
sysViewAll   10.10.10.50
sysLocation  office-1, rack 3
sysContact   ops@company.local

# 2) Пользователь SNMPv3 для самого демона (если нужен v3 и здесь)
rouser snmpv3user authPriv

# 3) Прокси-строки: запрос к 10.10.10.1 уходит на 10.10.10.1 от имени 10.10.10.99
proxy  10.10.10.1  10.10.10.1   .1
proxy -m 1.3.6.1.2.1.2.2  10.10.10.99  10.10.10.1  .1
```

```bash
apt install snmpd
systemctl enable --now snmpd
snmpd -f -Lo -C -c /etc/snmp/snmpd.conf     # проверка синтаксиса на переднем плане
```

> [!CAUTION]
> Директива `createUser` в net-snmp читается **только из файла-хранилища** (`/var/lib/snmp/snmpd.conf` или тот, что передан как `--persistentDir`), только при старте демона и только если у файла права 0600 и владелец `snmpd`. Обычная ошибка: положили `createUser` в `/etc/snmp/snmpd.conf`, перезапустили — пользователь не создался, а `snmpwalk -v3` молча падает по таймауту. Создай пользователя в хранилище, убедись, что `snmpd -T` показывает его (`snmpd -Dmib_init -f`), и только потом закрывай доступ `rocommunity`.

### Секреты в конфигурации snmp.yml

Файл с паролями — это файл с паролями. Держи его в `0600`, владельцем `snmp_exporter`, вне репозитория, а в Git храни шаблон с плейсхолдерами. Отдельный пользователь SNMP с правом только на чтение — тоже обязателен: `rouser` в v3 и `rocommunity` в v2c существуют именно для этого.

```yaml
# /etc/snmp_exporter/snmp.yml — фрагмент auths, файл 0600, вне Git
auths:
  snmp3_v3_authpriv:
    version: 3
    security_level: authPriv
    username: prometheus
    password: "AUTH-PASSPHRASE-OUT-OF-GIT"
    auth_protocol: SHA256
    priv_protocol: AES
    priv_protocol_password: "PRIV-PASSPHRASE-OUT-OF-GIT"

  # Только для стенда. В проде так не оставляют.
  legacy_v2c:
    version: 2
    community: "длинная-непредсказуемая-строка"
```

Поддерживаемые `auth_protocol`: `MD5`, `SHA`, `SHA224`, `SHA256`, `SHA384`, `SHA512`. Поддерживаемые `priv_protocol`: `DES`, `3DES`, `AES`, `AES192`, `AES256`. Если после установки `AES` не работает — скорее всего, собранный net-snmp без поддержки AES; проверь `snmp_exporter --version` на строку с перечнем протоколов.

## Модули: почему snmp_exporter не знает IF-MIB из коробки

Слепо обойти **всё** дерево OID нельзя: на большом устройстве это десятки тысяч значений, лишняя нагрузка и взрыв кардинальности. Поэтому snmp_exporter работает по **генератору модулей**: ты описываешь, какие поддеревья MIB нужно обходить, генератор читает соответствующие `.mib`-файлы и превращает их в шаблон выборки (lookup-таблицы, типы, `implements`).

```yaml
# generator/generator.yml
modules:
  # Интерфейсы — рабочая лошадка, её достаточно для 90% задач
  if-mib:
    walk:
      - 1.3.6.1.2.1.1        # system: sysName, sysUpTime, sysDescr
      - 1.3.6.1.2.1.2.2      # ifTable: ifInOctets, ifOutOctets, ifOperStatus, ifInErrors...
      - 1.3.6.1.2.1.31.1.1   # ifXTable: ifName, ifAlias, ifHighSpeed, ifHCInOctets...
    get:
      - 1.3.6.1.2.1.1.3.0    # sysUpTime.0 одним точечным запросом

  # Только системная информация — для устройств, где IF-MIB отдаётся криво
  system:
    walk:
      - 1.3.6.1.2.1.1
```

```bash
cd generator
# MIB-файлы: положи в ./mibs (например, с mysnmp.org). Не генерируй без них —
# без определений генератор не знает ни типов, ни таблиц соответствия.
./generator --mibformat=netsnmp-mibs generate

# Проверка сгенерированных шаблонов парсера и синтаксиса OID.
# Тест НЕ проверяет живое устройство — только корректность шаблонов.
./generator --mibformat=netsnmp-mibs --validate-queries --doctest

# Свести сгенерированные модули и файл с учётными данными в один snmp.yml
./generator merge ../snmp-auth.yml > ../snmp.yml
```

> [!IMPORTANT]
> Между 0.23 и 0.24 формат конфигурации менялся принципиально: раньше модули были JSON-файлами, теперь это секция `modules:` в YAML, а каталог с MIB лежит отдельно. Точные флаги и пути вывода сверяй через `./generator --help` в **своей** версии и смотри глазами в `snmp.yml`, что получилось, а не доверяй примеру из интернета.

Как понять, что модуль корректен, не поднимая Prometheus:

```bash
# 1) Экспортёр встал и видит твои модули
curl -s http://127.0.0.1:9116/ | head -30

# 2) Прямой опрос: target + module + auth
curl -s "http://127.0.0.1:9116/probe?target=10.10.10.1&module=if-mib&auth=snmp3_v3_authpriv" \
  | grep -E '^if(Oper|Admin)Status|^ifHighSpeed|^ifHC(In|Out)Octets|^ifInErrors|^ifSpeed'

# 3) Сколько всего метрик пришло — многословные устройства отдают тысячи
curl -s "http://127.0.0.1:9116/probe?target=10.10.10.1&module=if-mib&auth=snmp3_v3_authpriv" \
  | grep -c '^# HELP'

# 4) Есть ли ошибки самого экспортёра
curl -s "http://127.0.0.1:9116/probe?target=10.10.10.1&module=if-mib&auth=snmp3_v3_authpriv" \
  | grep -E '^snmp_scrape_(error|samples_ignored)'
```

| Что видишь | Что это значит |
| --- | --- |
| `snmp_scrape_error 0`, десятки `ifOperStatus` | модуль корректен, можно добавлять в Prometheus |
| `snmp_scrape_error 1`, `snmp_scrape_samples_total 0` | не сошлись учётные данные или нет доступа — проверяй отдельно `snmpwalk` с теми же параметрами |
| `snmp_scrape_samples_ignored` большое | часть OID в walked-дереве не имеет шаблона: не хватает MIB-файлов. Лечится генерацией, а не фильтрами |
| Метрики есть, но без `ifHighSpeed` | устройство не отдаёт ifXTable. Проверяй `snmpwalk ... IF-MIB::ifHighSpeed` отдельно — возможно, SNMPv2c-обход урезается на этом дереве |

## Метрики IF-MIB: что с ними делать

Самая ценная метрика в мониторинге сети — не трафик и не загрузка процессора. Это `ifOperStatus`. По ней ты узнаёшь, что **порт погас**, раньше, чем об этом сообщит пользователь.

```text
# HELP ifOperStatus Текущее операционное состояние интерфейса (1 up, 2 down, ...)
# TYPE ifOperStatus gauge
ifOperStatus{ifAlias="Uplink to core",ifDescr="GigabitEthernet0/1",ifIndex="1",ifName="Gi0/1"} 1
# HELP ifAdminStatus Конфигурационное состояние интерфейса (1 up, 2 down)
# TYPE ifAdminStatus gauge
ifAdminStatus{ifAlias="Uplink to core",ifDescr="GigabitEthernet0/1",ifIndex="1",ifName="Gi0/1"} 1
```

| Метрика | Тип | Значение состояний | Что делать в алерте |
| --- | --- | :---: | --- |
| `ifOperStatus` | gauge | 1 up, 2 down, 3 testing, 4 unknown, 5 dormant, 6 notPresent, **7 lowerLayerDown** | состояние `!= 1` при `ifAdminStatus == 1` = авария |
| `ifAdminStatus` | gauge | 1 up, 2 down, 3 testing | `== 2` = кто-то осознанно выключил порт. Это **не авария**, это info |
| `ifLastChange` | gauge (TimeTicks, с) | секунды с последней смены состояния | показывает «давно/недавно погас», полезно в аннотации |
| `ifHCInOctets` / `ifHCOutOctets` | counter (Counter64) | — | `rate(...)*8/1e6` = Мбит/с |
| `ifInOctets` / `ifOutOctets` | counter (Counter32) | — | **только** если устройство по SNMPv1 — и тогда осторожно, см. ниже |
| `ifInErrors` / `ifOutErrors` | counter | — | абсолютная скорость ошибок, а не процент |
| `ifInDiscards` / `ifOutDiscards` | counter | — | переполнение очереди: обычно QoS/shaping, а не физика |
| `ifHighSpeed` | gauge | **Мбит/с**, 0 у неактивных | знаменатель утилизации |
| `ifSpeed` | gauge | бит/с, у современных часто 4294967295 | не использовать как знаменатель |

> [!IMPORTANT]
> `ifAdminStatus == 2` и `ifOperStatus == 1` — это «упало не от нас». А вот `ifOperStatus == 7` (`lowerLayerDown`) стоит отдельно: интерфейс включён административно, но лежащий под ним слой (VLAN, туннель, агрегированный порт) не работает. Это почти всегда реальная неисправность конфигурации, а не «пользователь отключил».
>
> Ключевая мысль, ради которой затевается весь мониторинг: **`ifAdminStatus == 2` — это не авария**. Алертом уровня critical на каждое административно выключенный порт ты через месяц добьёшься того, что дежурный отключит уведомления целиком.

### `ifHCInOctets` и переполнение 32-битного счётчика

Разберём честно, потому что здесь половина учебников и почти все ИИ-ассистенты пишут одно и то же неверно.

Фраза «SNMPv2c отдаёт `Counter64`, а v1 — `Counter`» — упрощение. **Тип счётчика задан в MIB, а не в версии протокола:** в IF-MIB `ifInOctets` объявлен как `Counter32`, а `ifHCInOctets` — как `Counter64`. Разница в другом: 64-битные счётчики появились в SNMPv2, поэтому устройство, с которым говорят по **SNMPv1**, просто не может их отдать — в ответе будет `noSuchName`, и метрика исчезнет совсем.

Что из этого следует практически. Максимальное значение `Counter32` — 4 294 967 295 байт. Переполнение выглядит так: счётчик уезжает к максимуму, **откатывается к нулю** и ползёт вверх заново. `rate()` в этом случае видит отрицательную дельту и выдаёт мусор или пропуск. Время до переполнения считается элементарно: 4.29 ГБ делим на скорость.

| Скорость канала | Время до переполнения Counter32 |
| --- | --- |
| 10 Мбит/с | ~57 минут |
| 100 Мбит/с | ~5,7 минуты |
| 1 Гбит/с | ~34 секунды |
| 10 Гбит/с | ~3,4 секунды |

На канале 1 Гбит/с и выше **32-битные счётчики непригодны в принципе**. Отсюда правило: **на современном оборудовании используй `ifHCInOctets` / `ifHCOutOctets`, и если их нет — это повод разобраться с SNMP-версией, а не написать запрос по `ifInOctets`**. Проверить тип и OID можно самому:

```bash
snmptranslate -Td -On IF-MIB::ifHCInOctets
# ... IF-MIB::ifHCInOctets  -- = OID: 1.3.6.1.2.1.31.1.1.1.6
# ...   -- Textual Convention is "Counter64"
snmptranslate -Td -On IF-MIB::ifInOctets
# ... IF-MIB::ifInOctets  -- = OID: 1.3.6.1.2.1.2.2.1.10
# ...   -- Textual Convention is "Counter32"
```

> [!NOTE]
> 64-битного варианта **у счётчика ошибок нет** — `ifHCInErrors` в IF-MIB не существует, `ifInErrors` остаётся `Counter32`. Это нормально: счётчик ошибок не переполнится за время жизни устройства. Не ищи `ifHCInErrors` и не удивляйся, что его нет.

## Байты, биты и ошибка в 1000 раз

`rate()` отдаёт **байты в секунду**. Скорость канала измеряется в **битах в секунду**. Разница — множитель 8, а вместе с привычкой считать «мегабайты» вместо «мегабит» получается расхождение в 1000, в 8 и в 8 000 000 одновременно. Разложим все единицы, которые встречаются в одном запросе:

| Величина | Где встречается | Единица |
| --- | --- | --- |
| `rate(ifHCInOctets[5m])` | результат PromQL | байты/с |
| `rate(...) * 8` | пересчёт в биты | биты/с |
| `rate(...) * 8 / 1000` | кило | Кбит/с |
| `rate(...) * 8 / 1000000` | мега | **Мбит/с** |
| `rate(...) * 8 / 1000000000` | гига | Гбит/с |
| `ifSpeed` | IF-MIB | **бит/с** |
| `ifHighSpeed` | IF-MIB | **Мбит/с** |

> [!CAUTION]
> `ifSpeed` и `ifHighSpeed` — это **разные единицы в одном запросе**. Смешать их — значит ошибиться в миллион раз. А на устройствах с каналами быстрее 4 Гбит/с `ifSpeed` часто отдаёт `4294967295` — это не «очень быстрый интерфейс», это переполненное 32-битное поле. Используй `ifHighSpeed`.

### Утилизация интерфейса

Утилизация — это доля пропускной способности, **по направлению отдельно**. На дуплексе входящий и исходящий не складываются: 100 Мбит/с в каждую сторону не превращаются в 200 Мбит/с на одном порту.

```promql
# Утилизация ВХОДЯЩЕГО трафика, доля 0..1.
# ifHighSpeed в Мбит/с, поэтому rate()*8/1e6 даёт Мбит/с.
clamp_max(
  rate(ifHCInOctets{job="snmp"}[5m]) * 8 / 1000000 / clamp_min(ifHighSpeed, 1),
  1
)
```

```promql
# Утилизация ИСХОДЯЩЕГО
clamp_max(
  rate(ifHCOutOctets{job="snmp"}[5m]) * 8 / 1000000 / clamp_min(ifHighSpeed, 1),
  1
)
```

Почему здесь `clamp_min(ifHighSpeed, 1)`: у погашенного порта, петли, туннеля и логического интерфейса `ifHighSpeed` равен 0, и без защиты получится деление на ноль. Почему `clamp_max(..., 1)`: на агрегированном порту или при неверном `ifHighSpeed` утилизация может превысить единицу, и в панели это выглядит как ошибка данных.

> [!IMPORTANT]
> Бинарные операции в PromQL требуют **полностью совпадающих наборов лейблов**. `rate(ifHCInOctets[5m])` и `ifHighSpeed` несут одинаковые лейблы (`ifIndex`, `ifDescr`, `ifName`, `ifAlias`, `instance`, `job`), поэтому умножение работает как есть. Но если ты отфильтровал только одну сторону — например, `rate(ifHCInOctets{device="hq-sw-01"}[5m])`, — совпадения не будет, и результатом станет пустой график. Лечится явным сопоставлением:
>
> ```promql
> rate(ifHCInOctets{job="snmp"}[5m]) * 8 / 1000000
>   / on(instance, ifIndex) group_left() ifHighSpeed{job="snmp"}
> ```

### Дискриминация: не всё интерфейсы стоит считать

| Что отфильтровать | Зачем | Как |
| --- | --- | --- |
| `ifHighSpeed == 0` | выключенные порты, туннели, петли — деление на ноль | `and ifHighSpeed > 0` |
| `ifOperStatus != 1` | на погашенном порту график бесполезен | `and ifOperStatus == 1` |
| `Vlan`, `Loopback`, `Tunnel`, `Port-channel`, `Diag`, `Power` | служебные интерфейсы дают постоянный фоновый шум | `ifName!~"Vlan|Lo|Tunnel|Po|Diag"` |
| дублирующиеся `ifDescr` | у некоторых вендоров описания совпадают, `ifName` надёжнее | группировать по `ifName` |

## Лейблы: откуда брать имя и скорость интерфейса

Чтобы в алерте и на дашборде было написано «Gi0/12 к серверу», а не `.12`, нужны подписи. В IF-MIB их три, и они не взаимозаменяемы:

| Лейбл | Поле MIB | Что содержит | Надёжность |
| --- | --- | --- | --- |
| `ifDescr` | `1.3.6.1.2.1.2.2.1.2` | текстовое описание, часто с номером слота | есть почти везде |
| `ifName` | `1.3.6.1.2.1.31.1.1.1.1` | короткое имя `Gi0/12` | требует ifXTable, есть не везде |
| `ifAlias` | `1.3.6.1.2.1.31.1.1.1.18` | **то, что ты сам вписал** в описании порта | лучший вариант для человека |

Практический совет, который стоит сделать один раз при инвентаризации: **заполни `description` на всех портах и залей в `ifAlias` осмысленное имя** («srv-db-01», «AP-3F-floor2», «UPLINK-TO-HQ»). После этого любой алерт, любой дашборд и любая выборка в Grafana становятся читаемыми без дополнительных рук. Если платформа не даёт задать описание — вписывай смысл в `comment` и вытаскивай его в лейбл через `metric_relabel_configs` по имени интерфейса.

```bash
# Собрать таблицу «индекс → имя → описание → скорость» руками, один раз
for oid in ifDescr ifName ifHighSpeed ifOperStatus ifAdminStatus; do
  echo "=== $oid"
  snmpwalk -v2c -c public -Oe 10.10.10.1 "IF-MIB::$oid"
done

# Перевести OID в имена — если snmpwalk не знает MIB
snmptranslate -Tp -On 1.3.6.1.2.1.31.1.1.1.15
snmptranslate -Tp -On 1.3.6.1.2.1.2.2.1.10
```

## Готовая сборка: prometheus.yml

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  # Сетевое оборудование: SNMP-опрос
  - job_name: snmp
    scrape_interval: 30s          # SNMP-обход отвечает не мгновенно
    scrape_timeout: 20s            # но и не 10: на 48-портовом коммутаторе обход не мгновенный
    honor_timestamps: true
    static_configs:
      # Каждому блоку static_configs — свой набор лейблов: метки из labels
      # применяются ко всем целям блока, поэтому разные роли = разные блоки
      - targets: ['10.10.10.1']
        labels:
          module: if-mib
          auth: snmp3_v3_authpriv
          device: hq-sw-01
          site: hq
          role: core-switch
      - targets: ['10.10.10.2']
        labels:
          module: if-mib
          auth: snmp3_v3_authpriv
          device: hq-sw-02
          site: hq
          role: access-switch
      - targets:
          - '10.10.10.11'
          - '10.10.10.12'
          - '10.10.10.13'
        labels:
          module: if-mib
          auth: snmp3_v3_authpriv
          site: branch
          role: access-switch

    metric_relabel_configs:
      # Пакетные счётчики по протоколам на 48 портах дают тысячи серий
      # и почти никогда не читаются. Если они тебе реально нужны —
      # убери эту строку и заплати памятью осознанно.
      - source_labels: [__name__]
        regex: 'if(In|Out)(NUcast|Ucast)Pkts|ifHC(In|Out)(NUcast|Ucast)Pkts|ifInUnknownProtos'
        action: drop

  # Доступность: ICMP и TCP через blackbox_exporter
  - job_name: blackbox_icmp
    scrape_interval: 30s
    metrics_path: /probe
    params:
      module: [icmp]
    static_configs:
      - targets:
          - 10.10.10.1
          - 10.10.10.2
          - 10.10.10.11
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: 10.10.10.50:9115
```

```bash
promtool check config /etc/prometheus/prometheus.yml
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool | head -40
```

После перезагрузки первой страницей, куда ты идёшь, — `/targets`, а не Grafana. И вторая по важности — метрики самого экспортёра:

```promql
# Какие устройства не отдали ни одной метрики
snmp_scrape_error == 1

# Сколько метрик устройство отдало и сколько экспортёр выбросил
snmp_scrape_samples_total{job="snmp"}
snmp_scrape_samples_ignored{job="snmp"}
snmp_scrape_samples_parsed{job="snmp"}
snmp_scrape_duration_seconds{job="snmp"}
```

## Правила алертов: recording и alert

Сначала recording rules — они убирают тяжёлую цепочку из каждого правила и с дашборда. Схема именования та же, что в [Prometheus](devops/16-prometheus.md): `level:metric:operations`.

```yaml
# /etc/prometheus/rules/network-recording.yml
groups:
  - name: network-recording
    interval: 30s
    rules:
      - record: interface:utilisation_in:ratio5m
        expr: |
          clamp_max(
            rate(ifHCInOctets{job="snmp"}[5m]) * 8 / 1000000
              / clamp_min(ifHighSpeed, 1),
            1
          )

      - record: interface:utilisation_out:ratio5m
        expr: |
          clamp_max(
            rate(ifHCOutOctets{job="snmp"}[5m]) * 8 / 1000000
              / clamp_min(ifHighSpeed, 1),
            1
          )

      - record: interface:errors:rate5m
        expr: |
          clamp_min(rate(ifInErrors{job="snmp"}[5m]), 0)
            + clamp_min(rate(ifOutErrors{job="snmp"}[5m]), 0)

      - record: interface:errors:ratio5m
        expr: |
          interface:errors:rate5m
            / clamp_min(rate(ifHCInOctets{job="snmp"}[5m]), 1)
```

```yaml
# /etc/prometheus/rules/network-alerts.yml
groups:
  - name: network-availability
    rules:
      # Порядок важен: правило про недоступность устройства должно сработать
      # раньше, чем начнут сыпаться алерты про его порты.
      - alert: NetworkDeviceUnreachable
        expr: snmp_scrape_error{job="snmp"} == 1 or probe_success{job="blackbox_icmp"} == 0
        for: 3m
        labels:
          severity: critical
          runbook: net/device-unreachable
        annotations:
          summary: "{{ $labels.device }} не отвечает"
          description: >-
            SNMP-обход не удаётся дольше 3 минут. Устройство выключено,
            потерян management-доступ или сломан SNMP. Пользователи этого
            ещё не заметили — они заметят позже.

      - alert: InterfaceDown
        expr: |
          ifOperStatus{job="snmp"} != 1
            and ifAdminStatus{job="snmp"} == 1
            and ifHighSpeed > 0
        for: 2m
        labels:
          severity: critical
          runbook: net/interface-down
        annotations:
          summary: "Порт {{ $labels.ifAlias | default $labels.ifDescr }} упал на {{ $labels.device }}"
          description: >-
            ifOperStatus={{ $value }} при ifAdminStatus=1 — порт включён,
            но не работает. Состояние 7 (lowerLayerDown) означает проблему
            в VLAN/туннеле/агрегации под ним, а не в самом порту.

      # Кто-то выключил порт руками. Это не авария, но и не тишина.
      - alert: InterfaceAdminDown
        expr: ifAdminStatus{job="snmp"} == 2
        for: 5m
        labels:
          severity: info
          runbook: net/interface-admin-down
        annotations:
          summary: "Порт {{ $labels.ifAlias | default $labels.ifDescr }} на {{ $labels.device }} административно выключен"
          description: >-
            Кто-то сделал shutdown. Если это не ты — проверь журнал
            сообщений: время и источник изменения там есть.

      - alert: InterfaceFlapping
        expr: changes(ifOperStatus{job="snmp"}[30m]) >= 4
        for: 5m
        labels:
          severity: warning
          runbook: net/link-flap
        annotations:
          summary: "Порт {{ $labels.ifAlias | default $labels.ifDescr }} на {{ $labels.device }} мигает"
          description: "Не менее двух раз подряд менял состояние за 30 минут. Почти всегда — кабель, оптика или недонастроенный STP."

  - name: network-quality
    rules:
      # Абсолютная величина — правильно для гигабитных и выше каналов,
      # где 10 ошибок в секунду это катастрофа
      - alert: InterfaceErrorsHigh
        expr: interface:errors:rate5m > 1
        for: 10m
        labels:
          severity: warning
          runbook: net/interface-errors
        annotations:
          summary: "Ошибки на {{ $labels.ifAlias | default $labels.ifDescr }} ({{ $labels.device }})"
          description: "{{ $value | printf \"%.2f\" }} ошибок/с. Проверь оптику, разъём, а на медленных портах — duplex."

      # Относительная величина — единственно осмысленная на 10/100 Мбит/с,
      # где «1 ошибка в секунду» это нормальный фон
      - alert: InterfaceErrorRatioHigh
        expr: interface:errors:ratio5m > 1e-4
        for: 15m
        labels:
          severity: warning
          runbook: net/interface-errors
        annotations:
          summary: "Доля ошибок > 0,01% на {{ $labels.ifAlias | default $labels.ifDescr }}"

      - alert: InterfaceUtilisationHigh
        expr: |
          max(
            interface:utilisation_in:ratio5m,
            interface:utilisation_out:ratio5m
          ) > 0.80
        for: 15m
        labels:
          severity: warning
          runbook: net/interface-utilisation
        annotations:
          summary: "Утилизация {{ $value | humanizePercentage }} на {{ $labels.ifAlias | default $labels.ifDescr }} ({{ $labels.device }})"
          description: >-
            Один из двух каналов загружен выше 80%. Дальше начнутся
            отбрасывания и задержки в очередях — это видно по
            interface:discards, если их включил сборщик.

      - alert: InterfaceDiscardsGrowing
        expr: rate(ifOutDiscards{job="snmp"}[5m]) > 10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Отбрасывания на выходе {{ $labels.ifAlias | default $labels.ifDescr }}"
          description: "Физическая линия в порядке, но не справляется. Смотри QoS, shaping и burst на соседних устройствах."
```

```yaml
# Alertmanager: не шлём «порт упал» и «устройство недоступно» одновременно
inhibit_rules:
  - source_matchers: ['alertname=~"NetworkDeviceUnreachable"']
    target_matchers: ['severity=~"warning|critical"']
    equal: ['instance', 'device']
```

## Дашборд в Grafana

Пять панелей, которые закрывают 90% вопросов «что с сетью». Конкретные PromQL — то, что вставляется в панель; для каждой важна единица измерения, иначе Grafana покажет «834112.5 Мбит/с» вместо нормального числа.

| Панель | PromQL | Единица / вид | Зачем |
| --- | --- | :--- | --- |
| Состояние портов | `ifOperStatus{job="snmp"}` | таблица, `Value mapping: 1=up, 2=down, 7=lowerLayerDown` | мгновенный срез «где сейчас плохо» |
| Утилизация входящих | `interface:utilisation_in:ratio5m` | percentunit, порог 0.8 красным | где кончится канал |
| Утилизация исходящих | `interface:utilisation_out:ratio5m` | percentunit | асимметрия обычно и есть проблема |
| Трафик, Мбит/с | `interface:utilisation_in:ratio5m * on(instance, ifIndex) group_left() ifHighSpeed` | Мбит/с | абсолютные числа для планирования |
| Ошибки в секунду | `interface:errors:rate5m` | short | физика и duplex |
| Отбрасывания | `rate(ifOutDiscards{job="snmp"}[5m])` | short | QoS, а не физика |
| Доступность (ping) | `probe_success{job="blackbox_icmp"}` | heatmap 0/1 | где рвётся |

Практические замечания по дашборду, которые экономят день:

- Переменная `$device` (`templating` → `query_result(job="snmp")` → `label_values(device)`) превращает панель из «простыни на 300 серий» в «три порта, которые мне сейчас интересны». **Это главный приём против взрыва графиков.**
- На графиках трафика держи легенду, но не в виде `{{ifAlias}}` для всех 48 портов — список портов внизу отдельной таблицей, где у каждого своя строка и своя легенда.
- Порог 80% задаётся в `Field override` панели, а не красной линией вручную. Тогда он совпадает с порогом алерта и не расходится с ним через месяц.
- Не выводи `ifIndex` в легенду — он не несёт смысла для человека.

## Пинг и доступность: blackbox_exporter

`snmp_exporter` отвечает на вопрос «живо ли устройство по SNMP». Он **не** отвечает на вопрос «проходит ли трафик через него»: устройство может быть полностью живо, принимать SNMP и при этом не форвардить ни одного пакета. Для этого нужен `blackbox_exporter` — в отличие от всех предыдущих, он не собирает метрики, а **активно проверяет достижимость** заданным методом и отдаёт результат: `probe_success` 0 или 1 плюс `probe_duration_seconds`.

```yaml
# /etc/blackbox_exporter/blackbox.yml
modules:
  icmp:
    prober: icmp
    timeout: 5s
  icmp_ttl_32:
    prober: icmp
    timeout: 5s
    ttl: 32            # ограничение по TTL: ловит неверную маршрутизацию
  tcp_22:
    prober: tcp
    timeout: 5s
    tcp:
      query_response: true
  tcp_443:
    prober: tcp
    timeout: 5s
    tcp:
      query_response: true
      tls: true
  http_2xx:
    prober: http
    timeout: 10s
    http:
      method: GET
      valid_status_codes: [200, 301, 302]
      preferred_ip_protocol: ip4
```

```bash
# Проверка вручную, до подключения к Prometheus
curl -s "http://127.0.0.1:9115/probe?target=10.10.10.1&module=icmp&debug=true"
```

### Как отличить «устройство умерло» от «упала ссылка между устройствами»

Это главный практический вопрос пингового мониторинга, и ответ — **не в самом пинге, а в сравнении двух источников**.

| Что наблюдаем | Вывод |
| --- | --- |
| `probe_success == 0` и `snmp_scrape_error == 1` к `10.10.10.1` | устройство выключено, зависло или потерян management-доступ |
| `probe_success == 0` к `10.10.10.1`, но SNMP к нему работает | устройство живо, ICMP заблокирован политикой или up |
| SNMP работает, но `ifOperStatus` у порта в сторону узла равен 2 | **упала именно ссылка**, а не устройство |
| То же самое с двух сторон (оба конца видят `down`) | кабель, оптика, трансивер или настройка |
| Только одна сторона видит `down` | проблема в настройке порта у одной из сторон |

Порядок действий при `probe_success == 0` всегда один: сначала SNMP на то же устройство, потом `ifOperStatus` на порту в сторону следующего хопа, потом — и только потом — физика. Пинг, который не дополнен SNMP, говорит только «где-то тут плохо» и вводит в заблуждение чаще, чем помогает.

> [!CAUTION]
> **ICMP-мониторинг всей сети создаёт шум, а не безопасность.** Если пинговать 10.10.10.1, .2, .3 и .4 — это один и тот же физический сервер по разным адресам, и при его падении ты получишь четыре алерта. Ещё хуже: добавь в чёрный список ICMP весь broadcast-сегмент, и после отказа любого устройства в сегменте пингующий узел начнёт получать broadcast на «несуществующие» адреса — часть мониторинга будет висеть с `probe_success == 0` по адресам, которых там и не было. **Мониторь конечные точки цепочки (пограничный маршрутизатор, DNS, AD DC, интернет через 1.1.1.1), а не каждый хоп.** Промежуточные хопы проверяются через `ifOperStatus` — это дешевле и точнее.

Дополнительный приём, который окупается: мониторь **пользовательские сервисы**, а не устройства. `http_2xx` на `https://dc.company.local` и `https://portal.company.local` скажет тебе «пользователи не могут войти» тогда, когда SNMP на четырёх устройствах ещё весь зелёный. Метрики устройств — это диагностика; метрики сервисов — это приоритет.

## Чего SNMP не даёт — и почему нужна следующая лекция

Пройдёмся честно по границам, иначе ты будешь ждать от мониторинга того, чего в SNMP нет по определению.

| Вопрос | Отвечает ли SNMP | Чем отвечает |
| --- | --- | --- |
| «Что сейчас с цифрами?» | **да** | snmp_exporter + Prometheus |
| «Почему порт погас?» | нет: `ifOperStatus = 2` не говорит ни про кабель, ни про оптику, ни про STP | syslog, NETCONF, логи соседей |
| «Кто это изменил и когда?» | нет принципиально: в MIB нет истории | syslog, `show archive`, Git |
| «Что сейчас настроено на устройстве?» | нет: SNMP отдаёт счётчики, а не конфигурацию | NETCONF `get-config`, `copy running-config` |
| «Что изменилось с прошлого раза?» | нет: это опрос, у него нет событий | streaming telemetry, syslog |
| «Почему SNMP-обход не сработал?» | частично: `snmp_scrape_error` скажет «не отвечает», но не почему | логи snmp_exporter, `snmpwalk` вручную |

Отсюда прямое требование к эксплуатации: **собирай с устройства не только метрики, но и события**. Событие «порт GigabitEthernet0/12 перешёл из состояния down в up» — это и есть причина. SNMP её не доставит никогда, потому что он не наблюдает переходы, он читает текущее значение. Темой этого и займётся следующая лекция: NETCONF, streaming telemetry, syslog и сбор конфигураций в Git.

> [!TIP]
> Прежде чем строить мониторинг, пройди по всем устройствам и запиши в таблицу: версия прошивки, поддерживаемые версии SNMP, реальные имена и скорости портов, включённые сборщики счётчиков (`ifHCInOctets` есть?), management-адрес. Десять минут с `snmpwalk` по каждому устройству экономят день угадывания, почему часть парка молчит в Grafana. Это первый шаг из [инвентаризации в сети как коде](net/18-set-kak-kod.md).

## Где это ломается

- **Модуль не сгенерировали или сгенерировали без MIB-файлов.** Экспортёр отвечает `500`, в Prometheus `/targets` — `i/o timeout` с пустым Error. Лечится `generator generate` с полным набором `.mib` в `./mibs`, а не фильтрами на scrape.
- **`public` на весь парк.** Один UDP-пакет наружу — и сканер рисует тебе карту сети. Сообщество должно быть длинным, случайным и ограниченным по адресу; на устройствах без v3 это минимум, а не максимум.
- **SNMPv1 «работает», но метрики врут.** При 1 Гбит/с 32-битный счётчик переполняется каждые 34 секунды, `rate()` выдаёт мусор, и алерт на утилизацию либо молчит, либо срабатывает на ровном месте. Симптом — «график трафика скачет от нуля до максимума каждые полминуты». Проверяй `snmptranslate -Td IF-MIB::ifHCInOctets` и наличие `ifHCInOctets` в выводе.
- **Утилизация считается как байты по битам.** Забыли `* 8` — метрика в 8 раз меньше правды и никогда не пересечёт порог. Забыли `/1000000`, а `ifHighSpeed` в Мбит/с — в миллион раз больше правды.
- **Алерт на `ifOperStatus != 1` без учёта `ifAdminStatus`.** Половина портов в парке законно выключена, и через неделю дежурный отключит уведомления. Проверка `ifAdminStatus == 1` обязательна.
- **Демпинг вместо скорости.** На коммутаторе с 48 портами `ifInNUcastPkts` и подобные счётчики дают десятки тысяч серий на устройство. Проверь `snmp_scrape_samples_ignored` и число серий: `topk(20, count by (job) ({__name__=~".+"}))`.
- **`scrape_timeout: 10s` на большом коммутаторе.** Обход ifTable на 96 портах с несколькими деревьями не укладывается в 10 секунд, цель выпадает из Prometheus целиком. Для SNMP ставь `scrape_interval: 30s`, `scrape_timeout: 20s` и проверяй `snmp_scrape_duration_seconds`.
- **`snmp.yml` с паролями в Git.** Файл с `password` и `priv_protocol_password` в репозитории означает, что любой, кто умеет делать `git clone`, получает SNMP-доступ ко всему парку. В Git лежит только шаблон.
- **ICMP-мониторинг каждого хопа.** Четыре алерта на один упавший сервер, плюс ложные срабатывания из-за broadcast в выключенном сегменте. Мониторь конечные точки и сервисы.
- **Модуль `system` вместо `if-mib`.** Кто-то начинает с простого модуля, видит `sysUpTime`, радуется — и месяц не знает, что происходит с портами. Порядок обратный: сначала интерфейсы.
- **Проверка правил только в теории.** Алерт, который ни разу не сработал в `firing`, не работает. Подставь значение через `vector()`, `promtool test rules` или временную метрику в `pushgateway` — ровно так же это описано в [лабораторной 18](devops/18-lab-proxmox-monitoring.md).

## Чек-лист понимания

- [ ] Я объясняю, почему `node_exporter` нельзя поставить на сетевое оборудование и чем это отличается от экспортёра, который стоит рядом
- [ ] Я умею читать устройство через `snmpwalk` (v1/v2c/v3), знаю, что такое community-строка, и понимаю, почему `public` — это не «просто для теста»
- [ ] Я различаю `noAuthNoPriv`, `authNoPriv` и `authPriv`, знаю, чем отличаются USM user, auth-passphrase и priv-passphrase, и умею завести SNMPv3 на устройстве и проверить `show snmp user`
- [ ] Я понимаю, почему `ifHCInOctets` обязателен, и могу объяснить переполнение `Counter32` через 34 секунды на гигабите; я знаю, что 64-битного варианта у `ifInErrors` нет
- [ ] Я знаю, в каких единицах измеряются `rate(ifHCInOctets[5m])`, `ifSpeed` и `ifHighSpeed`, и не путаю Мбит/с с байтами
- [ ] Я умею отличить «порт упал» (`ifOperStatus != 1 and ifAdminStatus == 1`) от «кто-то выключил порт» (`ifAdminStatus == 2`) и знаю, что такое `lowerLayerDown`
- [ ] Я умею заполнить `description`/`ifAlias` на портах и объяснить, откуда в дашборде берутся читаемые имена
- [ ] Я умею отличить «устройство не отвечает» от «упала ссылка между устройствами», понимаю, почему ICMP-мониторинг всей сети создаёт шум, и знаю, какие три вопроса SNMP не умеет отвечать: почему, кто изменил и что изменилось