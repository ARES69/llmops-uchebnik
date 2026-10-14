---
title: NETCONF, streaming telemetry и сбор конфигураций
track: net
module: E. Мониторинг и автоматизация
order: 17
duration: 75 мин
level: senior
tags: [netconf, restconf, telemetry, syslog, конфиги, журнал]
summary: Почему SNMP не отвечает на вопросы «что изменилось» и «кто это сделал», и как их закрывают NETCONF, RESTCONF, потоковая телеметрия и syslog — плюс регулярный сбор конфигураций в Git как фундамент для сети как кода
practice: Включи NETCONF и syslog на одном устройстве, подними rsyslog-коллектор, напиши запрос LogQL для поиска link-flap и неуспешных входов, настрой ежесуточный сбор running-config в Git-репозиторий и сделай первый коммит с конфигурацией устройства.
---

Мониторинг из [предыдущей лекции](net/16-monitoring-seti.md) отвечает на один вопрос: **что сейчас**. Порядковые счётчики, состояние портов, трафик. И это ровно то, чего SNMP умеет — читать значение, когда его спросили.

Но у инженера три вопроса, и только на первый из них есть ответ. «**Почему** порт погас» — SNMP не скажет, потому что не хранит причин. «**Кто** это изменил» — SNMP не скажет, потому что в MIB нет истории. «**Что настроено** на устройстве» — SNMP не скажет, потому что отдаёт счётчики, а не конфигурацию. Дальше разбираем, чем эти три вопроса закрываются, и почему конфигурации надо класть в Git уже сейчас — это фундамент [сети как кода](net/18-set-kak-kod.md).

## Три механизма, и каждый закрывает свой вопрос

| | SNMP | NETCONF / RESTCONF | Streaming telemetry |
| --- | --- | --- | --- |
| Модель | **опрос** (pull) | **RPC**: клиент шлёт операцию, устройство отвечает результатом | **поток** (push) |
| Что отвечает | «что сейчас с цифрами» | «что настроено», «как это сделать», «получилось ли» | «что изменилось» и «что сейчас», без опроса |
| Транспорт | UDP 161 | SSH 830 (NETCONF) или HTTPS 443 (RESTCONF) | gRPC/gNMI, обычно TCP 57400 |
| Формат | BER-бинарники, MIB | XML или JSON по моделям YANG | protobuf, JSON-IETF или gNMI |
| Размер ответа | десятки-сотни значений | вся конфигурация — килобайты и мегабайты | поток, без границы |
| Есть события | нет | частично: ответ на `commit` | да, можно слать по изменению |
| Требует агента на устройстве | нет | нет | нет, но требует настройки на устройстве |
| Зрелость в твоём парке | есть везде | **есть не везде** | есть у единиц платформ |
| Цена внедрения | низкая | средняя | высокая |

Практический вывод, который стоит запомнить: **это не замена друг другу, это три слоя**. SNMP — дешёвый фундамент телеметрии. NETCONF — управление конфигурацией и чтение состояния. Telemetry — события и быстрый поток. Убирать SNMP сейчас незачем: он работает на всём парке, включая самые дешёвые коммутаторы, а остальные два на тех же устройствах могут отсутствовать.

## NETCONF: управление вместо «строчки в консоли»

### Зачем он, если есть SSH и CLI

Можно же подключиться по SSH и выполнить `conf t`, а конфиг склеить из строк. Работает. И вот почему это плохо.

| Что ты хочешь | CLI по SSH | NETCONF |
| --- | --- | --- |
| Узнать, что уже настроено | `show running-config`, парсить текст | `get-config` отдаёт структурированное состояние |
| Применить конфиг и **узнать, что изменится** | нет такого режима | `compare` candidate против running |
| Проверить конфиг до применения | частично, через `?` и `do`-подстановку | `validate` на кандидате |
| Применить много строк атомарно | нет: выполнилось до ошибки — осталось как было | `commit` — транзакция |
| **Откатить неудачное применение** | вручную, по памяти | `confirmed-commit` и `rollback-on-error` |
| Кто и когда менял | в логах платформы, по-разному | журнал `netconf` в syslog единообразно |

Последние три строки — это и есть смысл. Написать сорок строк через SSH легко, но если шестая из тридцати ошибка, ты получаешь **наполовину применённый** конфиг, и разбираться придётся руками, вспоминая, что именно было до. NETCONF это превращает в одну транзакцию.

### Три хранилища конфигурации

```text
   startup:   конфиг, загруженный при старте. Неизменяемый в рантайме.
        │  load
        ▼
   running:   то, что сейчас работает. Это то, что ты видишь в show running-config
        │
        │  copy-config startup → running  (сброс к заводским)
        │  edit-config + commit            (нормальный путь)
        ▼
   candidate: черновик. Меняется без последствий, пока не закоммичен.
              validate + compare + commit — вот весь смысл его существования.
```

Путь работы всегда один: **правь candidate → validate → compare с running → commit → (при необходимости) discard-changes, если не понравилось**.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <capabilities>
    <capability>urn:ietf:params:netconf:base:1.0</capability>
    <capability>urn:ietf:params:netconf:capability:candidate:1.0</capability>
    <capability>urn:ietf:params:netconf:capability:confirmed-commit:1.0</capability>
    <capability>urn:ietf:params:netconf:capability:rollback-on-error:1.0</capability>
    <capability>urn:ietf:params:netconf:capability:writable-running:1.0</capability>
  </capabilities>
</hello>
```

Этот `hello` устройство не спрашивает и не заставляет — оно само присылает свой при установлении сессии. Твоя задача — **посмотреть, что оно умеет**, прежде чем строить на нём автоматизацию. Если в capabilities нет `candidate:1.0`, значит режима «черновик» на этой платформе нет, и стратегию надо строить иную.

> [!IMPORTANT]
> Один порт — один механизм, но один канал — **много одновременных сессий**. Несколько автоматизаций могут держать сессии параллельно, и это нормально. А вот **два человека, редактирующих candidate одновременно, — это уже проблема**: устройство не знает, чью правку применять. Для этого есть `lock` с тайм-аутом: захватил, поработал, отпустил. Если устройство упало, пока кандидат был залочен, лок снимается по таймауту — но до этого момента новая сессия не сможет редактировать конфигурацию.

### Практика: Python через ncclient

```python
#!/usr/bin/env python3
# Транзакционная правка конфигурации: кандидат -> validate -> compare -> commit.
import os
import sys
from ncclient import manager
from ncclient.operations import RPCError

HOST = "10.10.10.1"
CONF = """
<config xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
  <interfaces xmlns="urn:ietf:params:xml:ns:yang:ietf-interfaces">
    <interface>
      <name>GigabitEthernet1/0/24</name>
      <description>UPLINK-TO-BRANCH-1</description>
      <enabled>true</enabled>
    </interface>
  </interfaces>
</config>
"""

APPLY = "--apply" in sys.argv     # по умолчанию НЕ применяем

conn = manager.connect(
    host=HOST,
    port=830,
    username="netops",
    password=os.environ["NETOPS_PASS"],   # секрет из окружения, не из кода
    hostkey_verify=True,
    key_filename="/etc/ssh/known_hosts",
    device_params={"name": "cisco_iosxe"},
    look_for_keys=False,
)

try:
    conn.edit_config(target="candidate", config=CONF)

    # 1) Устройство само проверит, что конфиг непротиворечив
    conn.validate(source="candidate")

    # 2) Что именно изменится — единственный способ увидеть это до применения
    diff = conn.compare_config()
    print("=== DIFF candidate -> running ===")
    print(diff.data if diff.data else "различий нет")

    if not APPLY:
        conn.discard_changes()
        print("[dry-run] изменения отброшены, ничего не применено")
        sys.exit(0)

    conn.commit()
    print("применено")
except RPCError as e:
    print("NETCONF error:", e.rpc_error)
    try:
        conn.discard_changes()
    except RPCError:
        pass
    sys.exit(1)
finally:
    conn.close_session()
```

```bash
pip install ncclient
python3 patch_iface.py             # только показать diff
python3 patch_iface.py --apply     # применить
```

### Что надо включить на Cisco IOS-XE

```text
ip access-list standard NETCONF-PEERS
 permit 10.10.10.50
 deny   any log

aaa new-model
aaa authentication login default local
aaa authorization exec default local
username netops privilege 15 secret <хэш>

line vty 0 15
 transport input ssh
 access-class NETCONF-PEERS in

netconf-yang ssh
 netconf-yang
netconf-yang http
 restconf

! проверить, что поднялось и что именно поддерживается
! show netconf-yang
! show running-config | section netconf
```

> [!CAUTION]
> **NETCONF есть не на всём оборудовании, и это надо проверить до того, как строить на нём план работ.** На Cisco IOS и IOS-XE он есть. На NX-OS — есть, но называется `netconf-yang agent` и `netconf-yang http-server`. На Juniper — есть, это штатная функциональность. На MikroTik **нет** — там своя модель доступа через [REST API и SSH-скрипты](net/05-avtomatizaciya-routeros.md). На Ubiquiti UniFi — нет, есть проприетарный REST. На Omada — нет. Поддержка NETCONF у Eltex NOS зависит от версии прошивки. Проверяется одним действием: попробуй подключиться на порт 830 и посмотри `hello`. Если порт закрыт — автоматизацию этого устройства строишь на том, что есть, и это нормальный подход.
>
> И отдельно: **точный набор команд и наличие `rollback-on-error` зависят от версии платформы.** На NX-OS есть `netconf-yang rollback-on-error N`, и там он задаёт таймаут подтверждённого коммита в минутах. Не переноси команду с одной платформы на другую по памяти — посмотри `show netconf-yang` и `?` в конфиге.

## RESTCONF: тот же NETCONF поверх HTTP

RESTCONF (RFC 8040) — это NETCONF-модель, но без XML-обвязки: обычный HTTP с JSON, который понимает `curl`, Python и любой HTTP-клиент. Именно поэтому для скриптов «сходи и поменяй одно поле» RESTCONF часто удобнее NETCONF, хотя под капотом — то же самое.

```bash
# Что настроено на интерфейсах
curl -u netops:'ПАРОЛЬ' -k \
  -H 'Accept: application/yang-data+json' \
  'https://10.10.10.1/restconf/data/ietf-interfaces:interfaces'

# Изменить адрес на интерфейсе. PATCH применяется к существующему узлу,
# PUT создаёт. Это разные операции — ошибиться легко.
curl -u netops:'ПАРОЛЬ' -k -X PATCH \
  -H 'Content-Type: application/yang-data+json' \
  -H 'Accept: application/yang-data+json' \
  -d '{"ietf-interfaces:interface":{
        "name":"GigabitEthernet1/0/24",
        "ietf-ip:ipv4":{"address":[{"ip":"10.30.1.2","netmask":"255.255.255.0"}]}}}' \
  'https://10.10.10.1/restconf/data/ietf-interfaces:interfaces/interface=GigabitEthernet1/0/24'

# Есть ли поддержка кандидата — ответ сервера скажет сам
curl -u netops:'ПАРОЛЬ' -k -i \
  -H 'Accept: application/yang-data+json' \
  'https://10.10.10.1/restconf/data'
```

| Метод | Что делает | Когда |
| --- | --- | --- |
| `GET` | прочитать узел | чтение состояния и проверка «применилось ли» |
| `PATCH` | изменить перечисленные поля существующего узла | точечная правка |
| `PUT` | заменить узел целиком или создать | создание нового объекта |
| `POST` | вызвать действие (`/actions/.../restart`) | reboot, ping из устройства |
| `DELETE` | удалить узел | снос интерфейса или адреса |

Три детали, на которых чаще всего и останавливаются:

- **Путь с `=` или без.** На части версий IOS-XE путь пишется как `.../interfaces/interface=GigabitEthernet1/0/24` (с новым синтаксисом контейнеров), на более старых — `.../interfaces/interface/GigabitEthernet1/0/24`. Не сработало — попробуй второй вариант и посмотри код ответа.
- **Типы данных.** В JSON значения передаются строками: `"enabled": "true"`, а не `true`. Это не опечатка документации, это требование YANG-модели к JSON-кодированию.
- **Коды ответа важнее тела.** `204 No Content` — успех, `400` — ошибка запроса, `409 Conflict` — конфигурация занята другой сессией, `500` — устройство не смогло применить. Всегда печатай код ответа в скрипте, а не только тело.

> [!NOTE]
> RESTCONF на разных платформах открывается на разных портах: на IOS-XE обычно 443, на NX-OS задаётся в `netconf-yang http-server port`. Плюс проверка сертификата: сетевое оборудование почти всегда отдаёт самоподписанный или корпоративный сертификат, и `-k` в `curl` — это не «отключить проверку насовсем», а способ не тратить время на первичную настройку. В рабочем скрипте проверку сертификата оставляй включённой и подложи CA.

## Streaming telemetry: устройство шлёт само

Третий механизм меняет саму модель. SNMP и NETCONF требуют, чтобы кто-то **спрашивал**. Telemetry — устройство **пушит** данные в коллектор по расписанию или по событию.

### Настройка коллектора и сенсоров на устройстве

```text
telemetry
 destination-group TG-MON
  host 10.10.10.50 port 57400
  encoding gNMI
  transport-type gnmi
 !
 sensor-group SG-INTERFACES
  sensor-path Cisco-IOS-XE-yang-oper:interface-stats
 !
 sensor-group SG-SYSTEM
  sensor-path Cisco-IOS-XE-yang-oper:system-information
 !
 subscription SUB-INTERFACES
  sensor-group SG-INTERFACES
  destination-group TG-MON
  sample-interval 30000
 !
 subscription SUB-SYSTEM
  sensor-group SG-SYSTEM
  destination-group TG-MON
  sample-interval 30000
 !
```

Логика конфигурации читается прямо: `destination-group` — **куда** слать (хост, порт, кодировка), `sensor-group` — **что** слать (набор путей YANG-модели), `subscription` — **связывает** первое со вторым и задаёт `sample-interval`. Один `sensor-group` можно переиспользовать в нескольких подписках с разными интервалами: медленные данные раз в минуту, интерфейсы раз в 30 секунд.

Коллектор — отдельная программа. Самая распространённая открытая — `gnmic`:

```yaml
# /etc/gnmic/config.yaml
server:
  address: ":57400"

targets:
  hq-sw-01:
    addresses: ["10.10.10.1:57400"]
    subscriptions: ["sub-interfaces", "sub-system"]
  hq-sw-02:
    addresses: ["10.10.10.2:57400"]
    subscriptions: ["sub-interfaces"]

subscriptions:
  sub-interfaces:
    paths:
      - "Cisco-IOS-XE-yang-oper:interface-stats"
    mode: stream
    sample_interval: 30s
  sub-system:
    paths:
      - "Cisco-IOS-XE-yang-oper:system-information"
    mode: stream
    sample_interval: 300s

outputs:
  file:
    type: file
    format: json
    filename: /var/lib/gnmic/telemetry.jsonl
    write-timeout: 10s
```

### Что это даёт и чего стоит

| Плюсы | Минусы |
| --- | --- |
| Нет опроса: устройство не ждёт запроса, а шлёт по таймеру | **Нужен отдельный коллектор** — ещё один сервис, который надо мониторить и обновлять |
| События можно слать сразу, а не по расхождению значений | Канал gRPC обычно **обязан быть зашифрован**: gNMI без TLS передаёт данные открытым текстом |
| Точные типы из YANG, а не строки | Поддержка платформ узкая: Cisco IOS-XE/NX-OS — да, MikroTik и большинство бытовых платформ — нет |
| Меньше запросов к устройству: один поток вместо тысячи GET | Коллектор становится **единой точкой отказа** для всех метрик сети |
| Пути выбираешь точечно, а не обходишь всё дерево | Отладка сложнее: нет «просто покажи весь SNMP» |

> [!IMPORTANT]
> Про поддержку на конкретных платформах говори честно: **streaming telemetry — это фича корпоративных платформ**. Cisco IOS-XE и NX-OS — поддерживают. Juniper — свой стек (JTI/OpenConfig). Eltex NOS — зависит от версии, проверяется просто: есть ли в CLI раздел `telemetry` и включается ли `gnmi` транспорт. MikroTik — стандартного gNMI нет; ближайшее, что у него есть, — SNMP traps и собственный [REST API с планировщиком](net/05-avtomatizaciya-routeros.md). Ты не обязан приводить весь парк к общей технологии: **SNMP там, где нет ничего лучшего, telemetry там, где есть**, — это нормальная инженерная позиция, а не компромисс.

### Куда складывать, если нужен Prometheus

Связка есть, и она рабочая: коллектор получает поток gNMI по модели **OpenConfig** — это единая открытая модель вендоров, один и тот же путь `interfaces/interface/state/counters` на Cisco, Juniper и других платформах — и отдаёт метрики в формате Prometheus. В `gnmic` это отдельный тип вывода, в других коллекторах — свои экспортёры. Суть одна: **OpenConfig убирает необходимость писать отдельный экспортёр под каждого вендора**.

Насколько углубляться: для пары-трёх устройств и оперативных вопросов SNMP закрывает задачу полностью. Telemetry имеет смысл, когда у тебя десятки устройств, когда нужен поток событий или когда по SNMP ты упёрся в кардинальность. Это не первая лекция и не первый шаг — это масштабирование.

## Syslog: журнал изменений, который у тебя уже есть

Пока мы говорили о том, **что** собирать, проходил мимо простого факта: **сетевое оборудование уже пишет журнал сам, в которого видно, кто и что изменил, в момент когда это произошло**. Его просто никто не читает, потому что он остаётся в буфере устройства и перезатирается при перезагрузке.

### Уровни и формат

Syslog (RFC 5424) состоит из facility (какая подсистема породила сообщение, 0–23, локальные — `local0`…`local7`) и severity (насколько серьёзно, 0–7).

| Severity | Название | Что на самом деле приходит от сетевого оборудования |
| --- | :---: | --- |
| 0 | Emergency | «всё упало». От сетевого железа почти не приходит; на всякий случай маршрутизируй в буфер |
| 1 | Alert | «система немедленно требует внимания» |
| 2 | Critical | отказ компонента, потеря связности с управляющей сетью |
| 3 | Error | сбой операции: не применился интерфейс, отказал модуль |
| 4 | Warning | деградация, переход порта в down, потеря сессии |
| 5 | Notice | **изменения конфигурации, перезагрузки, смена соседства** |
| 6 | Informational | обычная жизнь: порт поднялся, сессия установилась, NTP синхронизирован |
| 7 | Debug | то, что нужно при разборе конкретной проблемы, и что генерирует тысячи строк в секунду |

Практическое правило: **не включай 6 и 7 на постоянной основе на боевом парке**. `debug` на Cisco меняет поведение устройства и способен положить его нагрузкой; `informational` без фильтра — это поток в десятки тысяч строк в сутки, который съест диск коллектора и заставит тебя фильтровать постфактум.

### Что читать в сообщениях

| Сообщение (типичный вид) | Уровень | Что это значит | Триаж |
| --- | :---: | --- | --- |
| `%LINK-3-UPDOWN: Interface GigabitEthernet1/0/12, changed state to down` | 3/6 | порт сменил состояние | кабель, оптика, трансивер, сосед выключил |
| Пачка `UPDOWN` одного интерфейса за минуты | 3/6 | **link flap** — главная головная боль эксплуатации | оптика (грязный коннектор), недонастроенный STP, отключённый storm-control |
| `%SPANTREE-5-ADJCHG: ... changed from ... to ...` | 5 | изменилось соседство STP | цикл в топологии либо порт отключили — смотри в паре с UPDOWN |
| `%SYS-5-CONFIG_I: Configured from console by admin on vty0 (10.10.10.77)` | 5 | **кто-то вошёл в конфигурацию** | самый ценный класс сообщений: связывает изменение с временем и источником |
| `%AUTH-4-LOGIN_FAILED: Login failed [user: ...]` / `%SEC-6-IPACCESSLOGP: ... denied` | 4/6 | попытка входа или доступ к сервису с запрещённого адреса | перебор паролей либо ложное срабатывание при неудачном вводе |
| `ntp: synced to ...` / `time zone changed` | 6 | время поехало | рассинхрон времени ломает Kerberos, AAA и подписи |
| `%% Low on free memory` | 3 | не хватает памяти платформы | приближается к перезагрузке |

> [!CAUTION]
> У сообщений **нет единого стандартного текста «link-flap»**. Ни SNMP, ни syslog не определяют «порт мигает» как отдельное событие: flap — это **паттерн из нескольких пар `up/down` за короткий промежуток**. Практически его ловят двумя способами: подсчётом изменений состояния в Prometheus (`changes(ifOperStatus[30m])`, [предыдущая лекция](net/16-monitoring-seti.md)) либо запросом в Loki по регулярке (ниже). Вендорные сообщения про «нестабильное соединение» бывают, но они есть у части платформ и только у части, поэтому на них нельзя завязывать алерт.
>
> И второе, менее очевидное: **«с какого порта вошёл админ» в сообщениях обычно не пишется**. `%SYS-5-CONFIG_I` даёт пользователя и линию (`vty0`) и на части платформ адрес источника — но это источник со стороны сети, а не физический порт. Надёжный источник — записи **RADIUS/TACACS+** на твоём AAA-сервере. Строить расследование только на syslog — значит упереться в стену на середине.

### Коллектор: rsyslog

```conf
# /etc/rsyslog.d/20-network-devices.conf
global(workDirectory="/var/spool/rsyslog")

module(load="imudp" MaxSessions="2000")
module(load="imtcp" StreamDriverMode="1" StreamDriverPersistStateInterval="10")

# Слушаем ТОЛЬКО на адресе, доступном устройствам, и ограничиваем источники.
# imudp/imtcp без address() слушают 0.0.0.0 — это готовый UDP-спуфинг в твою сеть.
input(type="imudp" port="514" address="10.10.10.50" ruleset="netdev")
input(type="imtcp" port="6514" address="10.10.10.50" ruleset="netdev")

template(name="netdevFormat" type="string"
  string="<%pri%>1 %timestamp:::date-rfc3339% %hostname% %app-name% - - %msg%\n")

ruleset(name="netdev") {
  # На устройствах hostname = IP или имя, но на части платформ он пустой.
  # Надёжнее писать метку device в сообщение на самом устройстве.
  action(type="omfile"
         file="/var/log/netdev/network.log"
         template="netdevFormat"
         dirCreateMode="0750" createDirs="on")
  stop
}
```

```conf
# /etc/logrotate.d/netdev
/var/log/netdev/network.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    copytruncate        # rsyslog держит файл открытым, а не переоткрывает
    create 0640 syslog adm
}
```

```bash
rsyslogd -N1                      # проверка конфигурации, ничего не перезапуская
systemctl restart rsyslog
ss -lntup | grep -E ':(514|6514)'
tail -f /var/log/netdev/network.log | grep -i hq-sw-01
```

### Коллектор: Grafana Alloy, если логи идут в Loki

Если у тебя уже стек Grafana (Prometheus, Grafana, Loki), отдельный rsyslog не обязателен. Alloy умеет принимать syslog и писать в Loki, и тогда логи сетевых устройств попадают на те же дашборды и в те же алерты, что и метрики.

```hocon
// /etc/alloy/config.alloy
loki.source.syslog "netdev" {
  listener {
    address = "0.0.0.0:514"
    // Ключевой момент: без этих меток все устройства слипнутся в один поток
    // и в Loki будет невозможно отличить hq-sw-01 от branch-sw-07.
    labels = {
      job = "network-device",
    }
    label_keys = ["app_name", "device"]
  }
  forward_to = [loki.write.default]
}

loki.write "default" {
  endpoint {
    url = "http://127.0.0.1:3100/loki/api/v1/push"
  }
}
```

> [!NOTE]
> Если устройство не пишет имя в поле `device`, передай его через тег в сообщении (например, префикс `dev=<hostname>`) и настрой парсинг на коллекторе. Лучше один раз дописать на устройстве `logging trap informational` с тегом, чем потом гадать, чей это порт. `loki.source.syslog` в Alloy — актуальный путь; `promtail` с его syslog-приёмником объявлен устаревшим для новых инсталляций.

### Запросы, которые понадобятся в первый же инцидент

LogQL (диалект PromQL для логов) — четыре запроса, покрывающие большую часть вопросов:

```logql
# 1. link-flap: сколько раз за час интерфейс менял состояние
sum by (device) (
  count_over_time(
    {job="network-device"} | regexp "(?i)changed state to (up|down)"
    [1h]
  )
)

# 2. Кто заходил в конфигурацию и когда
{job="network-device"} | regexp "(?i)CONFIG_|configured from|commit"

# 3. Неудачные входы и попытки доступа к сервисам
{job="network-device"} |= "LOGIN_FAILED" or {job="network-device"} |= "AUTH" |= "fail"

# 4. Всё по конкретному устройству за последний час — базовая линия разбора
{job="network-device", device="hq-sw-01"}
```

## Сбор конфигураций: фундамент автоматизации

Отдельный и самый недооценённый кусок. Пока конфигурация живёт только на устройстве, у тебя нет **истории изменений**: ты не знаешь, что было вчера, не знаешь, кто поменял ACL, и не знаешь, чем устройство на площадке отличается от такого же в лаборатории.

**Как только конфигурация каждого устройства лежит в Git, ты получаешь историю с автором и временем, возможность отката, ревью перед изменением и основу для автоматизации.** Это ровно то, о чём следующая лекция.

### Чем снимать

| Способ | Как | Плюсы | Ограничения |
| --- | --- | --- | --- |
| `copy running-config` + SCP/SFTP **с устройства** | `show running-config` по SSH | работает везде, где есть SSH; можно отфильтровать секреты | устройство должно само инициировать сессию или ждать |
| Архив конфигурации на устройстве | `archive` на IOS, аналоги у других | снимает даже при недоступном SSH наружу, пишет в своей флеш | есть не на всех платформах |
| `netconf get-config` | `ncclient`, `get_config(source="running")` | структурированный вывод, можно выборочно | только там, где есть NETCONF |
| MikroTik `/export hide-sensitive=yes` + SFTP | скрипт на `/system scheduler` | полный экспорт, есть в [отдельной лекции](net/05-avtomatizaciya-routeros.md) | с секретами после скрытия не импортируется обратно |
| **SNMP-SET для конфигурации** | — | — | **не использовать. Никогда.** |

Про SNMP-SET стоит объяснить прямо, потому что соблазн есть: «ну есть же SET, значит и конфиг можно». SNMP — **одноадресный протокол без транзакций и без подтверждения результата**. Запрос SET ушёл, устройство приняло или отвергло — ты узнаешь только когда полезешь проверять. Часть конфигурации применится, часть нет, порядок операций не гарантирован, отката нет, а community-строка у тебя, скорее всего, в v2c и без шифрования. Один `snmpset` с неверным индексом — и ты меняешь ACL или выключаешь интерфейс управления на устройстве, которое сейчас единственное. NETCONF для этого и создан.

### Скрипт ежесуточного сбора

```bash
#!/usr/bin/env bash
# /srv/net-git/scripts/collect-config.sh
# Забирает running-config с каждого устройства, нормализует и коммитит в Git.
# Секреты вырезаются ДО git add: в репозиторий они попасть не должны.
set -euo pipefail

REPO=/srv/net-git
LOCK=/var/lock/net-collect.lock
LOG=/var/log/net-collect.log

exec 9>"$LOCK"
flock -n 9 || { echo "уже выполняется, выходим"; exit 0; }

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

# host|имя_в_репозитории|user|команда_получения_конфига
DEVICES=$(cat <<'EOF'
10.10.10.1|hq-sw-01|netops|show running-config
10.10.10.2|hq-sw-02|netops|show running-config
10.10.10.11|branch-sw-11|netops|show running-config
EOF
)

normalize() {
  # Выкидываем то, что меняется само и засоряет diff.
  sed -E \
    -e '/^! Last configuration change/d' \
    -e '/^! NVRG config last updated/d' \
    -e '/^Building configuration/d' \
    -e '/^Current configuration : [0-9]+ bytes/d' \
    -e '/^ntp clock-period/d' \
    -e '/^[[:space:]]*snmp-server community/d' \
    -e '/^[[:space:]]*snmp-server user .* (auth|priv) /d' \
    -e '/^[[:space:]]*(password|secret|enable secret) /s/ .*/ <REDACTED>/' \
    -e 's/[[:space:]]+$//'
}

rc=0
while IFS='|' read -r host name user cmd; do
  [ -z "$host" ] && continue
  target="$REPO/devices/$name/running.cfg"
  mkdir -p "$(dirname "$target")"

  if ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
         "$user@$host" "$cmd" | normalize > "$target.tmp" 2>/dev/null && [ -s "$target.tmp" ]; then
    mv "$target.tmp" "$target"
    log "OK   $name ($host), $(wc -l < "$target") строк"
  else
    rm -f "$target.tmp"
    log "FAIL $name ($host) — конфиг не получен, прошлый файл сохранён"
    rc=1
  fi
done <<< "$DEVICES"

cd "$REPO"
if git diff --quiet -- devices/; then
  log "изменений нет, коммит не нужен"
else
  git add devices/
  git commit -q -m "chore: автосбор конфигураций $(date -Is)" --author="netcollect <netcollect@company.local>"
  git push origin main
  log "изменения закоммичены: $(git rev-parse --short HEAD)"
fi
exit $rc
```

```bash
chmod +x /srv/net-git/scripts/collect-config.sh
install -m 0644 /dev/null /var/log/net-collect.log
# раз в сутки, но не в час пик и не одновременно с бекапами
echo '17 3 * * * root /srv/net-git/scripts/collect-config.sh' > /etc/cron.d/net-collect

bash -n /srv/net-git/scripts/collect-config.sh   # проверка синтаксиса
/srv/net-git/scripts/collect-config.sh            # первый прогон вручную
```

Ключевая деталь в скрипте — не сам код, а **`normalize`**. Без неё каждый коммит будет отличаться от предыдущего одной строкой «Last configuration change at 03:17:04», и через неделю `git log` перестанет читаться, потому что в нём будет тысяча одинаковых по смыслу коммитов. Нормализация — это не косметика, это условие, при котором история остаётся полезной.

> [!IMPORTANT]
> Порядок здесь именно такой: **сначала собрать и читать, потом сравнивать, и только потом применять.** Собранные конфигурации — это не цель, а разведданные. Несколько недель ты просто смотришь историю `git log -p devices/hq-sw-01/running.cfg` и учишься читать собственную сеть. Увидел неожиданный ACL в 02:00 — вот это и есть та находка, ради которой всё затевалось. Прыгать сразу к автоматическому применению значит тиражировать ошибку, которую ты ещё не нашёл.

Репозиторий на этом этапе может выглядеть так:

```text
net-git/
  devices/
    hq-sw-01/
      running.cfg          # снят автоматически, нормализован
      meta.yml             # платформа, версия, model, serial, management IP
    hq-sw-02/
    branch-sw-11/
  docs/
    audit-2026-10.md       # что нашли при первом разборе истории
  scripts/
    collect-config.sh
```

Следующая лекция превращает `devices/` в шаблоны и инвентарь, а `collect-config.sh` — в детектор дрейфа.

## Где это ломается

- **NETCONF настроен, но открыт наружу.** `line vty` без `access-class` — и NETCONF слушает 830 на всех интерфейсах, включая WAN. Закрывай аксесс-листом и `transport input ssh` в первую очередь, до всего остального.
- **Автоматизация ломает тебе доступ и никто не может войти.** Сценарий: скрипт перевёл интерфейс управления в другой VLAN. Устройство живо, но ты снаружи. Страховки: консольный доступ настроен **до** автоматизации, а не после; у пары устройств — физический доступ.
- **`candidate` без `validate`.** Применённый конфиг с синтаксической ошибкой в середине пакета — половина изменений на месте, вторая половина нет. `validate` стоит бесплатно и ловит это до коммита.
- **RESTCONF с `-k` в рабочем скрипте.** Отключённая проверка сертификата означает, что скрипт с паролем подключится к чему угодно, что ответит на этом адресе. Для отладки `-k` допустим, для CI — нет.
- **Syslog на `0.0.0.0` без ограничения источников.** UDP без проверки источника — это готовый спуфинг: кто угодно может прислать тебе сообщение «link down» от имени твоего ядра сети. `input(... address="10.10.10.50")` в rsyslog — обязателен.
- **`logging trap debugging` на боевом устройстве.** Это не «больше информации», это способ положить платформу. Debug-уровень включают на пять минут под конкретную задачу и выключают.
- **Syslog без тега с именем устройства.** У части платформ поле `hostname` в сообщении пустое, и через месяц в Loki у тебя стена одинаковых строк, в которых не найти ничего. Допиши имя устройства в сообщение при отправке.
- **Один конфиг в Git и пароль в том же файле.** Регулярное выражение вырезает `snmp-server community` и `password`, но если формат строки на конкретной платформе чуть другой — секрет уедет в коммит навсегда. Проверяй результат `normalize` глазами до первого `git commit`, и заведи в CI проверку «в репозитории сети нет строк с `password`, `secret`, `community`, `psk`».
- **Сборщик без `normalize`.** История конфигураций превращается в тысячу коммитов вида «ничего не изменилось, кроме времени». Git перестаёт быть источником знания.
- **Скрипт сбора перезаписал прошлый хороший конфиг пустым файлом при неудачном SSH.** Классика. Поэтому в скрипте выше — запись во временный файл и `mv` только при непустом результате: неудача оставляет прошлую версию на месте.
- **Telemetry подняли, коллектор забыли в мониторинге.** Коллектор — такая же точка отказа, как и сам Prometheus: он тихо перестаёт собирать, а графики просто перестают обновляться. Мониторь сам коллектор так же, как всё остальное.

## Чек-лист понимания

- [ ] Я умею объяснить, почему SNMP не отвечает на вопросы «почему», «кто изменил» и «что изменилось», хотя на первый вопрос отвечает отлично
- [ ] Я различаю `running`, `candidate` и `startup`, знаю порядок `edit-config → validate → compare → commit → discard-changes` и понимаю, чем NETCONF отличается от набора команд по SSH
- [ ] Я знаю, на каком порту работает NETCONF (830) и RESTCONF (обычно 443), проверяю наличие NETCONF до того, как строю на нём план, и умею читать и править конфигурацию через RESTCONF (разница между `PATCH` и `PUT`)
- [ ] Я отличаю push-модель streaming telemetry от опроса SNMP и знаю, чем за это платишь: отдельный коллектор, TLS и узкая поддержка платформ
- [ ] Я знаю уровни syslog 0–7, понимаю, почему 6 и 7 нельзя держать постоянно, умею найти link-flap, config change и неудачный вход запросом в Loki и не рассчитываю, что стандартное сообщение «link-flap» существует
- [ ] Я могу объяснить, почему SNMP-SET нельзя использовать для конфигурации, даже когда он технически доступен
- [ ] У меня есть работающий ежесуточный сбор конфигураций в Git с нормализацией, и я понимаю, зачем нормализация нужна именно для читаемости истории