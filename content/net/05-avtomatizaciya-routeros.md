---
title: Автоматизация RouterOS
track: net
module: A. MikroTik / RouterOS
order: 5
duration: 85 мин
level: senior
tags: [routeros scripting, rest api, git, бэкапы, автоматизация]
summary: Почему конфигурацию MikroTik можно хранить в Git и применять скриптом: export и бэкапы, язык скриптинга, планировщик, REST API с Python и правила безопасности автоматизации
practice: Сделай репозиторий с шаблонами конфигурации, добавь в него скрипт рендеринга и скрипт выгрузки `/export` на SFTP по расписанию через `/system scheduler`, напиши на Python вызов REST API, который сначала только печатает список интерфейсов, а по флагу dry-run выключает один — и ни разу не примени его к рабочему устройству без проверки.
---

Это единственная лекция модуля, после которой сетевое оборудование перестаёт быть
«чёрным ящиком, в который ходят руками». RouterOS — единственная из сетевых
платформ, чью конфигурацию можно целиком выгрузить в текст, положить в Git, сравнить
две версии и применить скриптом. Ansible, Terraform-провайдеры и готовые шаблоны
конфигураций для MikroTik существуют именно потому, что это возможно. Разберём, как
это устроено, и — обязательно — где автоматизация может положить всю сеть быстрее,
чем её поднимет человек.

## Три источника правды, и почему это важно

| Артефакт | Что внутри | Чего не внутри | Где применять |
| --- | --- | --- | --- |
| `/export file=x` | конфигурация текстом, как её видит RouterOS | runtime-состояния: динамические маршруты, аренды, сессии | Git, ревью, сравнение устройств |
| `/system backup save` | бинарный снимок состояния, шифруется | приватные ключи в открытом виде, ничего не видно без устройства | восстановление на том же устройстве |
| `/ip service api` + REST | живое состояние и команды | ничего — это интерфейс управления | автоматизация, мониторинг |

`/export` — то, что ты кладёшь в Git. `/system backup save` — то, что ты кладёшь на
флешку и думаешь, что этого достаточно. REST — то, через что ты меняешь устройство.

### Экспорт: что именно в нём

```routeros
/export file=backup-2026-10-12
/export file=backup-2026-10-12 hide-sensitive=yes
/export file=backup-2026-10-12 show-defaults=yes compact=no
/export verbose
/file print
/file edit backup-2026-10-12.rsc
```

| Параметр | Что делает | Когда нужен |
| --- | --- | --- |
| `file=` | сохранить в файл на устройстве | вместо `verbose`, для автоматизации |
| `hide-sensitive=yes` | прячет пароли, ключи, PSK | **всегда**, если файл уедет с устройства |
| `show-defaults=yes` | добавляет значения, совпадающие с умолчаниями | большой diff, зато видно «отсутствие» |
| `compact=no` | подробный формат | по умолчанию в большинстве версий |
| `verbose` (без `file=`) | печать в терминал | посмотреть глазами |

> [!IMPORTANT]
> `hide-sensitive=yes` прячет `pre-shared-key`, пароли и приватные ключи. Это делает
> файл пригодным для Git, но **непригодным для повторного импорта** — при `/import`
> скрытые значения останутся скрытыми или сбросятся в пустые. Поэтому схема рабочая
> такая: конфигурация живёт в Git в шаблонах с подстановками, а `/export hide-sensitive`
> хранится как «снимок состояния» для сравнения и аудита. Импортировать обратно имеет
> смысл только полный `/export`, взятый с устройства, которому ты хочешь вернуть
> исходное состояние.

### Импорт: почему он хрупкий

```routeros
/import file-name=backup-2026-10-12.rsc dry-run     # проверить, НЕ применяя
/import file-name=backup-2026-10-12.rsc verbose
/import file-name=backup-2026-10-12.rsc from-line=120 verbose
/system script add name=apply-template source="..." policy=read,write
```

Ключевой параметр здесь — `dry-run`. Он выполняет разбор файла и показывает, что
произойдёт, не меняя конфигурацию. Это встроенная в RouterOS защита от самого
дорогого сценария: файл от другого устройства, у которого другой порядок команд.
Пользуйся им всегда, когда файл приехал не от тебя.

Импорт воспроизводит команды, а не состояние. Отсюда три честных ограничения:

1. **Дефолты разных моделей разные.** Конфиг с hEX на hEXS с тем же именем интерфейса
   даст другой результат. Импорт — не перенос устройства.
2. **Зависимость от порядка.** Некоторые узлы нельзя создать раньше зависимостей
   (интерфейс до адреса, туннель до маршрута). Импорт выполняет команды по порядку
   файла, и если ты правил конфиг вручную, порядок мог нарушиться.
3. **Идентификаторы не переносятся.** Ссылки вида `place-before=[find ...]` или
   `remove=[find interface=ether3]` описывают позицию в дереве, а не объект.

> [!CAUTION]
> Перед импортом на живое устройство: `/system backup save`, затем `/import` с
> `bypass-backup` **не** использовать. И всегда имей под рукой консольный доступ:
> после `/system reset-configuration` или неудачного импорта сеть может оказаться
> недоступна по сети, и единственный путь — физический доступ к устройству и
> `/system reset-configuration` в терминале.

## Дрейф: состояние ушло от шаблона

Между «применили шаблон» и «проверили» проходит неделя, в течение которой кто-то
зашёл в WinBox и добавил правило. Теперь устройство не соответствует коду в Git, и
никто этого не заметил. Это и называется дрейфом.

Как заметить: сравнить два экспорта — эталонный с машины, которая разворачивает
шаблон, и с реального устройства.

```bash
# На управляющей машине: забрать состояние с каждого устройства
for h in hq-router branch-router; do
  ssh "admin@$h" '/export file=state hide-sensitive=yes' >/dev/null
  scp "admin@$h:/state.rsc" "./state/$h.rsc"
done

# Сравнить два устройства или устройство с эталоном
diff -u ./state/hq-router.rsc ./state/branch-router.rsc
```

```routeros
/export file=state
/file print
```

> [!NOTE]
> В WinBox есть сравнение конфигураций: Files → открыть два файла и сравнить. В CLI
> отдельной команды сравнения нет — надёжный путь именно `diff`/`git diff` на рабочей
> машине. Не выдумывай команду: сравнение делается внешним инструментом.

Если разница больше ожидаемой (MAC-адреса, комментарии, динамические значения) —
значит, дрейф. Реакция: понять, чьё изменение правильнее, и провести его через шаблон,
а не через WinBox.

## Скриптовый язык: восемь слов, которых хватает

RouterOS scripting — не Bash и не Python. Это маленький интерпретатор, в котором
переменные живут в «дереве» `/system script`, есть цикл, условие, вывод и логирование.
Для задач «проверь, сделай, запиши» этого достаточно.

| Конструкция | Что делает | Пример смысла |
| --- | --- | --- |
| `:local` | локальная переменная внутри скрипта | `:local w "ether1"` |
| `:global` | глобальная переменная (живёт в `/system script environment`) | `:global lastFail ""` |
| `:set` | присвоение, `:set x ($x + 1)` | `:set n ($n + 1)` |
| `:if ... do={}` | условие | `if ($ok = true) do={...}` |
| `:foreach` | цикл по элементам или ключам | обойти интерфейсы |
| `:put` | вывод в терминал (или в лог скрипта) | `:put "готово"` |
| `:log` | запись в системный журнал | `:log warning "..."` |
| `:parse` | разбор строки в значение | `:parse "value"` |
| `:delay` | пауза | `:delay 5s` |
| `[ ... ]` | результат команды, например `[/ping ...]` | «выполни и подставь» |

> [!TIP]
> Учись скриптам через `:put`, а не через чтение. Набери в терминале
> `:put [/interface ethernet print]` и посмотри, что вернулось. Затем
> `:put [/ping 1.1.1.1 count=1 as-value]` — и ты увидешь точный состав полей,
> которые можно читать через `->"имя-поля"`. Это быстрее любой документации и
> честнее, чем угадывать имена.

## Скрипт 1: пинг-мониторинг с уведомлением

```routeros
/system script add name=check-wan source={
  :local targets {"1.1.1.1"; "8.8.8.8"; "router.company.local"}
  :foreach t in=$targets do={
    :local r [/ping $t count=3 as-value]
    :local rx ($r->"packets-received")
    :if ($rx = 0) do={
      :log error "Нет ответа от $t"
      /tool e-mail send to="ops@company.local" subject="MikroTik: link down" \
        body="Нет ответа от $t в $([/system clock get time])"
    }
  }
}
/system script run check-wan
/system script print detail
```

> [!IMPORTANT]
> Имена полей результата `:ping ... as-value` зависят от версии RouterOS. Перед
> использованием выполни `:put [/ping 1.1.1.1 count=1 as-value]` и посмотри, что
> вернулось — и используй те имена, которые видишь. Я не стану угадывать за тебя.

Для почты нужен один раз настроенный `/tool e-mail` (в v7 параметр называется
`start-tls`, в v6 — `tls`), а сам вызов `/tool e-mail send` одинаков. Альтернатива без
SMTP — `/tool fetch` к webhook (Telegram, Slack) или запись в лог, который уже уходит в
твою систему мониторинга.

## Скрипт 2: watchdog для WAN

Задача: если внешний интернет не отвечает несколько раз подряд — перезапустить
интерфейс. Классический, но полезный приём, который чинит зависшие PPP-сессии.

```routeros
/system script add name=watchdog-wan source={
  :global wanFail 0
  :local wan "pppoe-wan"
  :local r [/ping 1.1.1.1 count=3 as-value]
  :local rx ($r->"packets-received")

  :if ($rx > 0) do={
    :set wanFail 0
    :log info "WAN ok"
  } else={
    :set wanFail ($wanFail + 1)
    :log warning "WAN не отвечает, попытка $wanFail"
    :if ($wanFail >= 3) do={
      :log error "Перезапускаю $wan"
      /interface pppoe-client set $wan disabled=yes
      :delay 10s
      /interface pppoe-client set $wan disabled=no
      :set wanFail 0
    }
  }
}
```

`:global` здесь не случаен: счётчик должен пережить конец скрипта. Внутри `:local`
переменная исчезнет, и счётчик всегда будет 1.

## Скрипт 3: ежедневный бэкап наружу

```routeros
/tool e-mail
set from-address="router@company.local" to-address="ops@company.local" \
    smtp-server="smtp.company.local" smtp-port=587 start-tls=yes user="router" password="..."

/system script add name=backup-to-sftp source={
  :global sftpHost "10.10.10.5"
  :global sftpUser "backup"
  :global sftpPass "..."

  /system backup save name=auto encryption=aes password=$sftpPass
  :delay 5s
  /export file=auto hide-sensitive=yes

  /tool fetch upload=yes mode=sftp address=$sftpHost user=$sftpUser password=$sftpPass \
    src-path="auto.backup" dst-path="hq-router/auto.backup"
  /tool fetch upload=yes mode=sftp address=$sftpHost user=$sftpUser password=$sftpPass \
    src-path="auto.rsc" dst-path="hq-router/auto.rsc"
}
/system script print
```

Про `/tool fetch` стоит знать три вещи. Первая: при `upload=yes` параметр `src-path`
— это локальный файл, а `dst-path` — имя файла на удалённой стороне. Вторая: у команды
есть и короткая форма через `url=` (`sftp://backup:пароль@10.10.10.5/auto.backup`),
и в ней учётные данные прямо в строке — удобно, но неудобно для скриптов, потому что
пароль останется в `print`. Третья: `check-certificate` по умолчанию равен `no`, то
есть HTTPS-проверка не выполняется; для внутреннего SFTP по SSH это неважно, но если
когда-нибудь потянешь наружу через `https` — включай проверку явно.

> [!IMPORTANT]
> `/system backup save` пишет **на само устройство**, и если оно зависло — выгрузить
> нечего. Надёжность здесь достигается не периодичностью, а тем, что у бэкапа есть
> внешняя копия, снятая с живого устройства. Скрипт выше как раз и снимает её:
> сначала снимок, потом отправка.

## Планировщик: cron внутри устройства

`/system scheduler` — это cron в RouterOS. `on-event` принимает либо имя скрипта,
либо код.

```routeros
/system scheduler
add name=check-wan-every-5m interval=5m on-event=watchdog-wan policy=policy,read,write,test
add name=backup-daily interval=1d start-time=03:30:00 on-event=backup-to-sftp \
    policy=policy,read,write,test
add name=report-load start-time=09:00:00 interval=1d on-event="/system resource print" \
    policy=read,write
/system scheduler print detail
/system scheduler run check-wan-every-5m
```

> [!IMPORTANT]
> Права — это не формальность. Без `policy` в наборе команда падает с
> `not enough permissions (9)` в логе, и снаружи это выглядит как «задача есть,
> расписание есть, `run` вручную работает, а по расписанию — тишина». И обратная связь:
> скрипт, вызванный по имени, выполняется с правами **задачи**, и если у скрипта
> прав больше, чем у задачи, он будет отклонён. Права скрипта и права задачи должны
> совпадать.

> [!CAUTION]
> `start-time=startup` выполняется **до подъёма интерфейсов и до получения адреса
> DHCP-клиентом**. Для watchdog'а WAN или бэкапа это гарантированный способ увидеть
> «интерфейс не поднят» и сделать вывод, что всё упало. Такие задачи запускай по
> расписанию времени, а не на старте.

Два поля только для чтения, которые стоит смотреть регулярно, — `run-count` и
`next-run`. Если `run-count` не растёт, задача не выполняется; если `next-run` пуст,
у задачи нет следующего запуска (например, `interval=0s` после срабатывания).

### Скрипт для сбора состояния

```routeros
/system script add name=collect-daily source={
  :local r [/system resource print as-value]
  :local u [/interface wireless registration-table print count-only]
  :log info ("uptime=" . ($r->"uptime") . " cpu=" . ($r->"cpu-load") . \
             " free=" . ($r->"free-memory") . " wifi-clients=" . $u)
}
/system scheduler add name=collect-daily start-time=23:55:00 interval=1d \
  on-event=collect-daily policy=policy,read
```

Такой лог потом уезжает в твою систему сбора логов (см.
[лекцию про мониторинг сети](net/16-monitoring-seti.md)) и становится историей, по
которой видно деградацию за неделю до аварии.

## REST API: HTTP-поверх-RouterOS

REST даёт тебе текстовый интерфейс к тому же дереву конфигурации. URL соответствует
пути в конфиге, ответ — JSON.

```routeros
# Только из management-сети и только по TLS
/ip service set api-ssl available-from=10.10.10.0/24 certificate=mycert disabled=no
/ip service set api available-from=10.10.10.0/24 disabled=no      # только для теста
/ip service print
```

> [!WARNING]
> `api` (8728) — это HTTP без шифрования: логин и пароль идут открытым текстом по
> сети. Включай его только на время отладки с localhost-контейнера, с ограничением по
> адресу, и выключай сразу.

> [!IMPORTANT]
> У `api-ssl` **обязателен сертификат**. Без него (`certificate=none`) служба
> соглашается только на анонимный Diffie-Hellman: соединение шифруется, но роутер не
> доказывает свою личность, и `curl` или браузер к нему не подключатся вообще.
> Симптом — «API включил, а `curl` возвращает ошибку», и поиск уходит в сторону от
> настоящей причины.
> Сертификат создаётся в `/certificate`, подписывается и выбирается в свойстве
> `certificate` службы. Для первого знакомства допустимо включить `api` без TLS с
> ограничением по адресу — но только на время теста.

> [!CAUTION]
> Ограничение по адресу в `/ip service` не прячет порт от сканирования (подробно — в
> [лекции про RouterOS](01-routeros-os.md)). Чтобы порт 8729 не был виден снаружи,
> нужен ещё `drop` в цепочке `input` для интерфейса WAN.

### Методы и формат

| Метод | Что делает | Пример |
| --- | --- | --- |
| `GET` | прочитать узел или список | `/rest/system/resource` |
| `PUT` | создать объект, тело — JSON | `/rest/ip/address` |
| `PATCH` | изменить поля существующего | `/rest/interface/ether2` |
| `POST` | вызвать метод узла | `/rest/system/reboot` |
| `DELETE` | удалить | `/rest/ip/firewall/filter/3` |

```bash
# прочитать состояние
curl -k -u ops:'пароль' https://10.10.10.1/rest/system/resource

# список адресов с выборочными полями
curl -k -u ops:'пароль' \
  'https://10.10.10.1/rest/ip/address?proplist=address,interface,disabled'

# создать правило firewall
curl -k -u ops:'пароль' -X PUT https://10.10.10.1/rest/ip/firewall/filter \
  -H 'Content-Type: application/json' \
  -d '{"chain":"input","action":"accept","in-interface":"vlan10-mgmt",
       "src-address":"10.10.10.0/24","comment":"ops-access"}'

# выключить интерфейс
curl -k -u ops:'пароль' -X PATCH https://10.10.10.1/rest/interface/ether2 \
  -H 'Content-Type: application/json' -d '{"disabled":"true"}'

# вызвать метод: выполнить скрипт
curl -k -u ops:'пароль' -X POST https://10.10.10.1/rest/system/script/run \
  -H 'Content-Type: application/json' -d '{"script-name":"check-wan"}'
```

> [!NOTE]
> Фильтр полей в URL пишется как `?proplist=` (в части версий — `?.proplist=`).
> Проверь по ответу: если вернулись все поля, значит фильтр не применился, и это
> безопасно — ты просто прочитал лишнее. Значения в JSON для `PATCH` передаются
> строками, даже если это `disabled`.

> [!IMPORTANT]
> Порядок вызова `method=on-response` в `curl` не важен, но порядок URL — важен:
> `/rest/ip/address` — это узел, `/rest/ip/address/2` — конкретный элемент. Ошибка
> в номере элемента при `DELETE` удалит не то правило, которое ты думал. Всегда
> сначала `GET` с `?proplist`, потом действие.

### Python: аккуратно и по-настоящему

Скрипт ниже делает четыре вещи: читает список интерфейсов, добавляет правило
firewall, собирает счётчики и — с защитой — выключает интерфейс по имени.

```python
import os
import sys
import requests

ROUTER = os.environ.get("ROUTER", "https://10.10.10.1")
USER = os.environ["ROUTER_USER"]
PASS = os.environ["ROUTER_PASS"]
CA = os.environ.get("ROUTER_CA", "/etc/pki/router-ca.pem")

DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"   # по умолчанию НЕ применяем

s = requests.Session()
s.auth = (USER, PASS)
s.verify = CA


def api(method, path, payload=None):
    url = f"{ROUTER}/rest/{path.lstrip('/')}"
    r = s.request(method, url, json=payload, timeout=10)
    r.raise_for_status()
    return r.json() if r.content.strip() else {}


def list_interfaces():
    return api("GET", "interface")


def add_allow_rule():
    payload = {
        "chain": "input",
        "action": "accept",
        "in-interface": "vlan10-mgmt",
        "src-address": "10.10.10.0/24",
        "comment": "added-by-automation",
    }
    if DRY_RUN:
        print(f"[dry-run] PUT /ip/firewall/filter {payload}")
        return None
    return api("PUT", "ip/firewall/filter", payload)


def counters():
    items = api("GET", "ip/firewall/filter?proplist=comment,action,bytes")
    return sorted(items, key=lambda x: int(x.get("bytes", 0)), reverse=True)[:10]


def disable_interface(name):
    found = [i for i in api("GET", "interface") if i.get("name") == name]
    if not found:
        raise SystemExit(f"интерфейс {name} не найден")
    if DRY_RUN:
        print(f"[dry-run] PATCH /interface/{name} disabled=true")
        return
    api("PATCH", f"interface/{name}", {"disabled": "true"})
    print(f"{name} выключен на {ROUTER}")


if __name__ == "__main__":
    # применяем только с явным флагом --enable
    if "--enable" in sys.argv:
        DRY_RUN = False
    print("режим:", "ПРИМЕНЯТЬ" if not DRY_RUN else "dry-run, ничего не меняется")

    print("интерфейсы:", [i.get("name") for i in list_interfaces()])
    add_allow_rule()
    print("топ по счётчикам:", counters())
    disable_interface("ether3")
```

> [!WARNING]
> Скрипт, который может выключить интерфейс, требует жёсткой дисциплины. Первый шаг —
> всегда dry run: он печатает, что *сделал бы*, и меняет ничего. Второй шаг — отдельная
> учётка с минимальными правами. Третий — запуск сначала на одном устройстве, а не
> на всех сразу. Четвёртый — вторая машина, с которой ты перезагрузишь это устройство,
> должна быть готова. Автоматизация, которая тиражирует ошибку на двадцать площадок,
> хуже ручной работы: она делает всё быстрее.

## Хранение в Git: шаблоны против состояния

Репозиторий должен различать **шаблон** (то, что мы хотим) и **состояние** (то, что
есть). Смешивать их нельзя: иначе через месяц ты не отличишь свой код от мусора,
который накопился от ручных правок.

```
network/
  devices/
    hq-router/
      state.rsc            # выгрузка hide-sensitive — только для диффа и аудита
      backup-2026-10-12.backup
  templates/
    base.rsc.j2            # общие куски: сервисы, логирование, NTP
    edge-hq.rsc.j2         # площадка с WAN
    edge-branch.rsc.j2     # площадка без WAN
    ap-branch.rsc.j2       # точка доступа
  vars/
    inventory.yml          # имя, роль, адреса, ключи — без секретов
  scripts/
    render.py
    deploy.sh
```

Шаблон от состояния отличается тем, что в нём есть переменные. Jinja2 или простая
подстановка — без разницы; разница в дисциплине.

```jinja
# templates/edge-hq.rsc.j2
/ip service
set telnet disabled=yes
set ftp disabled=yes
set www disabled=yes
set api disabled=yes
set ssh available-from={{ mgmt_network }} port=2222

/ip address
add address={{ mgmt_ip }}/24 interface=bridge1 comment="management"

/ip firewall filter
add chain=input action=accept connection-state=established,related
add chain=input action=drop connection-state=invalid
add chain=input action=accept protocol=icmp
add chain=input action=accept in-interface=bridge1 src-address={{ mgmt_network }}
add chain=input action=drop in-interface={{ wan_if }}
```

```yaml
# vars/inventory.yml
hq_router:
  mgmt_network: 10.10.10.0/24
  mgmt_ip: 10.10.10.1
  wan_if: ether1
```

Правила, которые экономят нервы:

- **Секреты — не в Git.** Пароли, приватные ключи WireGuard, PSK IPsec, токены
  Telegram. В шаблоне — только имена переменных, значения подставляются на этапе
  применения из менеджера секретов или вручную. Ключ WireGuard, попавший в репозиторий,
  означает, что площадку скомпрометировали навсегда.
- **Рендеринг и применение — разные шаги.** Сначала получить файл, посмотреть глазами
  diff с тем, что сейчас на устройстве, и только потом `/import`.
- **Шаблоны — маленькие.** Один большой шаблон на всё офис — это не шаблон, а копия
  устройства со словом «шаблон». Общие куски выносятся в `base`.
- **Ansible умеет из коробки.** Коллекция `community.routeros` даёт `routeros_command`,
  `routeros_facts`, `routeros_interface` и другие модули — не нужно писать HTTP-клиент,
  если задача типовая. Как это стыкуется с IaC в целом — в
  [лекции про Terraform и Ansible](devops/12-terraform-i-ansible.md).

## Откат и «резервный канал управления»

Автоматизация без отката — это ставка. Откат на RouterOS выглядит так.

```routeros
/system backup save name=before-change encryption=aes password="..."
/system backup print
/file print

# — что-то пошло не так —
/file print where name~"before-change"
/system backup load name=before-change password="..."
```

| Ситуация | Что делать | Что нужно физически |
| --- | --- | --- |
| плохая конфигурация, устройство доступно | `/system backup load` | ничего |
| устройство не грузится | восстановление через меню загрузки и файл `.backup` с флешки | физический доступ |
| нужно начать с нуля | `/system reset-configuration no-defaults=yes` | доступ к терминалу (COM или serial) |
| всё сломалось, WinBox не открывается | сброс кнопкой на корпусе | физический доступ |

> [!IMPORTANT]
> Подготовка консольного доступа — это часть работы, а не запасной вариант.
> У большинства моделей есть COM-порт или serial-консоль: включи `/system console set
> port=usb-serial` и держи USB-кабель под рукой. Управление по сети — это
> удобство, а не канал восстановления. Подробнее про планы отказов и проверенные
> бэкапы — в [лекции про backup и DR](devops/19-backup-i-dr.md).

## Безопасность автоматизации

Риск, который надо назвать прямо: **автоматизация с правами root на сетевом
оборудовании может положить всю сеть**. Не теоретически — одним циклом `for` по
списку устройств, одним опечатанным фильтром, одним `PATCH` не на тот интерфейс. Всё
это происходит быстрее, чем ты успеваешь заметить.

| Мера | Что даёт |
| --- | --- |
| отдельный пользователь `netops` с минимальными `policy` | скрипт не может, например, перезагрузить устройство, если это не разрешено |
| пользователь только для чтения — по умолчанию | забытый скрипт только читает |
| API-доступ ограничен адресом management-сети | вектор из интернета закрыт |
| только `api-ssl`, ключ или сертификат | пароль не летает открытым текстом по сети |
| dry run первым шагом | большинство ошибок видно до применения |
| консольный доступ настроен заранее | откат возможен, даже если сеть легла |
| скрипты в Git, а не в голове | любой может проверить, что именно будет применено |

> [!IMPORTANT]
> Группы и наборы политик в RouterOS отличаются между v6 и v7. Перед созданием своей
> группы посмотри `/user group print` и `/user group print detail` на конкретном
> устройстве и собирай минимальный набор прав осознанно, а не копируя пример из
> интернета. Универсального «правильного» списка политик не существует — он зависит от
> того, что именно твоя автоматизация должна уметь.

## Где это ломается

- **`hide-sensitive=yes` и импорт обратно.** Экспорт со скрытыми секретами годится для
  Git, но при обратном импорте секреты не восстановятся. Это две разные операции, и их
  путают.
- **Импорт на другую модель.** Дефолты и имена интерфейсов другие — получишь не то
  устройство, а всю перенастроенную сеть. Импорт — это воспроизведение команд, а не
  перенос настроек.
- **`place-before=[find ...]` в шаблоне.** Он описывает позицию, а не объект. Стоило
  тебе добавить правило руками — и скрипт встанет не туда. Именно поэтому
  сопоставлять по `comment`, а не по номеру строки.
- **Планировщик без `policy`.** Задача есть, расписание есть, `run` вручную работает,
  по расписанию — тишина. Смотри `/log`.
- **Бэкап на самом устройстве.** `/system backup save` кладёт файл на флешку того же
  устройства. Если оно зависло — бэкап недоступен, как и устройство.
- **Секреты в Git.** Приватный ключ WireGuard в репозитории — это не «неаккуратно»,
  это компрометация площадки навсегда, потому что ключ не перегенерируется.
- **Один пользователь `admin` на всю автоматизацию.** Один баг в Python — и доступ ко
  всем устройствам сразу. Скрипту нужен свой пользователь с меньшими правами.
- **Нет консольного доступа.** Автоматизация отключила интерфейс управления. WinBox не
  открывается. Сети нет. Физически подходить к устройству в 23:00 — не план.
- **Скрипт с `sleep`-подобной логикой без таймаута.** `/system scheduler` с `interval=30s`
  и командой, которая висит минуту, — это задача, которая накапливается. Проверяй
  `run-count` в `/system scheduler print`.
- **«Мы проверили на тестовом стенде».** Стенд и продакшн отличаются моделью,
  версией прошивки и списком пользователей. Прогон без `dry run` на одном устройстве
  из двадцати — обязательный шаг, а не опция.

## Чек-лист понимания

- [ ] Я понимаю разницу между `/export hide-sensitive`, `/system backup save`
      и тем, что вообще не является бэкапом
- [ ] Я могу объяснить, почему импорт конфига на другую модель даёт другое устройство
- [ ] Я умею отличить шаблон от состояния и знаю, зачем в репозитории обе сущности
- [ ] Я знаю 8–10 конструкций RouterOS-скриптинга и умею узнать имена полей
      через `:put`, а не угадывать их
- [ ] Я могу написать и поставить в `/system scheduler` watchdog-скрипт и понимаю,
      зачем в нём `:global`, а не `:local`
- [ ] Я знаю методы REST API (`GET`/`PUT`/`PATCH`/`POST`/`DELETE`) и умею прочитать
      состояние устройства через `curl` с проверкой сертификата
- [ ] Я умею написать скрипт, который сначала только печатает предполагаемое действие,
      и включать применение только явным флагом
- [ ] Я могу назвать меры, которые не дают автоматизации положить всю сеть,
      и знаю, почему консольный доступ — не опция, а часть работы