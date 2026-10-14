---
title: Cisco IOS: режимы и базовая настройка
track: net
module: B. Cisco IOS
order: 6
duration: 80 мин
level: middle
tags: [cisco, ios, vlan, trunk, интерфейсы]
summary: Как устроена иерархия режимов Cisco IOS, почему она защищает от ошибок, и как с нуля собрать рабочий конфиг коммутатора доступа с VLAN, trunk и EtherChannel — без риска потерять доступ к устройству.
practice: Собеди в Packet Tracer или на CML схему: коммутатор на 8 портов, management VLAN 99, пользовательский VLAN 10, серверный VLAN 20, trunk на порт 24. Загрузи полученный конфиг и проверь `show vlan brief`, `show interfaces trunk`, `show interfaces status`.
---

Сети в твоём контуре Proxmox ты администрируешь как серверы — через SSH и
конфиги. А коммутатор стоит в кладовке, и к нему нет ни SSH, ни конфига, есть
только консольный кабель и человек, который вообще-то не понимает, что делает.
Эта лекция — про то, как перестать быть этим человеком: разобрать иерархию
режимов IOS, научиться читать и править конфиг коммутатора, и при этом не
потерять к нему доступ. Всё дальнейшее — маршрутизация, безопасность,
диагностика — держится именно на этом фундаменте.

## Модель режимов: три уровня и почему их не один

Cisco IOS — не оболочка Linux, не интерактивный интерпретатор. Это конечный
автомат с тремя основными состояниями, и каждая команда существует
**только в одном из них**. При попытке выполнить команду не в том режиме ты
получаешь `% Invalid input detected at '^' marker` — и это не ошибка кода, а
защита.

| Режим | Prompt | Как попасть | Что можно делать |
| --- | --- | --- | --- |
| Пользовательский EXEC | `SW> ` | сразу после логина | только просмотр: `show ...`, `ping`, `traceroute` |
| Привилегированный EXEC | `SW# ` | `enable` (спросит пароль) | просмотр + операции: `copy`, `clear`, `reload`, `write` |
| Глобальная конфигурация | `SW(config)# ` | `configure terminal` (`conf t`) | менять конфигурацию |
| Подрежимы | `SW(config-if)# ` | `interface Gi0/0/1` | настройка одного интерфейса |
| | `SW(config-vlan)# ` | `vlan 10` | настройка одного VLAN |
| | `SW(config-line)# ` | `line vty 0 15` | настройка удалённого доступа |
| | `SW(config-router)# ` | `router ospf 1` | настройка протокола маршрутизации |

Логика простая: **изменение требует привилегий, просмотр — нет**. Руководитель
отдела может зайти по SSH, посмотреть состояние и прислать тебе вывод, но не
может ни сбросить счётчики, ни перезагрузить коммутатор, ни случайно ввести
`erase startup-config`. Для этого нужен пароль `enable`.

### Зачем нужен ещё и глобальный режим

В Linux ты пишешь команды конфигурации в один момент времени, и они применяются
сразу. В IOS глобальный режим — это «редактор конфига», в котором ты
перемещаешься по иерархии и накапливаешь изменения, а они применяются к
устройству по мере ввода. Выйти из глобального режима — `end` (или `Ctrl+Z`),
вернуться ровно в привилегированный EXEC.

```bash
enable
configure terminal
hostname SW-ACCESS-01
interface GigabitEthernet1/0/10
 description user-PC-anna
 switchport mode access
 switchport access vlan 10
exit
interface GigabitEthernet1/0/20
 switchport mode trunk
exit
end
write memory
```

`exit` выходит на уровень выше (`config-if` → `config` → `exec`).
`end` работает всегда и выбрасывает сразу в `SW#`, даже из вложенного подрежима.
Команда `end` — это, по сути, `Ctrl+Z`.

> [!TIP]
> Из глобального режима выполнять `show`-команды без `do` нельзя. Префикс `do`
> позволяет выполнить exec-команду прямо в конфигурации:
> `do show interfaces trunk`, `do show running-config interface Gi1/0/10`.
> Это экономит полминуты на каждой проверке. Поддерживается на Catalyst и ISR,
> но не на всех платформах — на supervisor-based коммутаторах 4500 может быть
> недоступно.

### Сокращения и префикс `no`

IOS разбирает команду по **достаточному уникальному префиксу**, а не по первому
символу. `conf t` = `configure terminal`, `int g0/0/1` = `interface
GigabitEthernet0/0/1`, `sh run` = `show running-config`, `wr` = `write memory`.
Минимальная допустимая длина зависит от платформы и версии образа: на ISR
допустимы очень короткие префиксы, на новых Catalyst IOS XE требуется чуть
больше. Правило простое: не запоминай минимальные префиксы, набирай понятные —
`int g1/0/1`, `sh run`.

Универсальный префикс `no` — отдельная особенность IOS, которой нет в Linux.
`no` перед любой командой означает «убрать эту настройку»:

```bash
no shutdown                                  # поднять интерфейс
no ip domain lookup                          # выключить резолв
no ip http server                            # выключить веб-интерфейс
no switchport port-security mac-address ...  # убрать sticky-MAC
no vlan 10                                   # удалить VLAN
no snmp community public ro                  # удалить community
```

В Linux для отключения используют отдельный флаг (`ip forward off`, `systemctl
disable`), здесь один и тот же префикс работает со всем. Именно поэтому
`show running-config` печатает команды **в нормальном виде** — в файле конфигурации
нет синтаксиса «отменить», там только итоговое состояние.

> [!WARNING]
> `no` не спрашивает подтверждения. Опечатка в имени интерфейса или VLAN означает,
> что ты не изменил то, что хотел, а создал/удалил нечто другое либо получил
> ошибку — но не откатил предыдущие команды в этом блоке. Поэтому каждый блок
> конфигурации проверяй через `do show running-config <секция>` до `end`.

## Сначала посмотри, потом меняй, потом сохраняй

Три команды, порядок которых нарушать нельзя:

```bash
show running-config      # что настроено сейчас (в памяти)
show startup-config      # что будет после перезагрузки (в энергонезависимой памяти)
copy running-config startup-config   # или write memory / wr mem
```

`running-config` живёт в оперативной памяти. `startup-config` — на флеш-памяти.
Пока ты не выполнил `copy`, все твои изменения живут до следующего `reload`,
`power cycle` или обрыва питания. Коммутатор без сохранённого конфига
загрузится в дефолтное состояние: имя `Switch`, все порты в VLAN 1, твой
пароль `enable` не работает.

```bash
show version | include uptime
# uptime is 3 weeks, 4 days, 2 hours
# Если uptime больше, чем время последней правки — конфиг не сохранён.
```

> [!CAUTION]
> `reload` на удалённом коммутаторе без сохранённого конфига — это не «перезагрузка»,
> а сброс в ноль. Всегда перед `reload` наклоняйся к оборудованию, а не к кнопке
> Reset. На устройствах серии ISR/ISR-G2 с кнопкой `Mode` перезагрузка зависает на
> 60+ секунд, если не сброшен `boot system`.

### Правило, которое экономит нервы

> [!IMPORTANT]
> **Никогда не настраивай единственный коммутатор, по которому идёт твой доступ.**

Это значит: перед любой правкой — убедись, что у тебя есть второй путь к
устройству. Физический консольный кабель, второй SSH-сеанс из другой сети,
console server. Правку одного устройства в одиночку начинай с того, что
подключился к нему **двумя** способами.

Порядок правки, который работает: изучил `show running-config` → понял, что
меняешь → внёс минимальный блок команд → проверил результат через `do show ...`
→ вышел через `end` → `write memory`.

## Имена интерфейсов и зачем нужны description

Имена портов на Cisco длинные и неоднородные. Схема нумерации зависит от
серии:

| Имя | Где встречается |
| --- | --- |
| `GigabitEthernet0/0/1` | роутеры ISR — `0` = слот, `0` = модуль, `1` = порт |
| `GigabitEthernet1/0/1` | Catalyst 9300/9200 — `1` = стек, `0` = модуль, `1` = порт |
| `TenGigabitEthernet1/1/1` | 10-гигабитные SFP+ порты Catalyst и ядра |
| `Te1/0/1` | сокращение для TenGigabitEthernet, принимается вводом |
| `Serial0/0/0` | WAN-интерфейсы на ISR |
| `Port-channel1` | агрегированный канал (EtherChannel) |
| `Vlan99` | SVI — интерфейс уровня 3 для management VLAN |
| `Loopback0` | служебный, всегда up |

> [!NOTE]
> Не путай `0/0/1` и `1/0/1`: на ISR это разные устройства в разных слотах, на
> Catalyst 9300 `1/0/x` — стек 1. Всегда сверяйся с `show ip interface brief`
> перед тем, как писать `interface` в скрипте: опечатка в одной цифре создаст
> пустой интерфейс, и ошибка не будет очевидна.

`description` — бесплатная страховка. Через полгода понадобится не конфиг
читать, а спросить у человека «что было на порту 14 в марте», и он не вспомнит.

```bash
interface GigabitEthernet1/0/10
 description user-PC-anna
interface GigabitEthernet1/0/20
 description server-proxmox-nic2
interface GigabitEthernet1/0/24
 description UPLINK-to-core-router

show interfaces description
# Port      Name                        Status       Pvid  Duplex  Speed
# Gi1/0/10  user-PC-anna                connected      10    a-full  a-1000
```

`show interfaces description` — одна из самых полезных команд в IOS, и её
нет ни в `ip link` из Linux, ни в `ip -br addr`. Один вывод показывает имя,
состояние, PVID, дуплекс и скорость по всем портам.

## VLAN: два синтаксиса на разных поколениях

Создание VLAN — одна из немногих вещей, где Cisco **не имеет единого синтаксиса**
между платформами. Это главный источник ошибок при копировании чужих конфигов,
и об этом надо знать заранее.

**Вариант A — старый синтаксис (`vlan database`).** Классический Catalyst 2960
и вся серия до перехода на IOS XE. Отдельный режим, из него выходят через
`exit`:

```bash
vlan database
 vlan 10
  name USERS
 vlan 20
  name SERVERS
 exit
```

**Вариант B — новый синтаксис (Catalyst 9300/9200, IOS XE).** Режима
`vlan database` нет. Создать один VLAN можно прямо в глобальном режиме:

```bash
configure terminal
 vlan 10
  name USERS
 exit
 vlan 20
  name SERVERS
 exit
```

**Вариант C — через `configure switchport vlan`.** Удобен, когда VLAN много
или нужно задать диапазон одним входом в режим конфигурации VLAN:

```bash
configure switchport vlan 10
 name USERS
exit
configure switchport vlan 20-30
 name GUEST-RANGE
exit
```

> [!WARNING]
> На **ISR (серия 1800/2800/2900/4000)** коммутатор внутри маршрутизатора — это
> отдельный модуль, а не часть маршрутизатора. Команды `vlan database`,
> `switchport mode access` и `show vlan brief` там не существуют. Для разделения
> трафика используют **sub-интерфейсы** с тегом dot1Q. Если ты видишь в чужом
> конфиге `vlan database` и при этом устройство — ISR, конфиг копировать нельзя.

Sub-интерфей на маршрутизаторе выглядит так — это принципиально другой механизм
для того же самого:

```bash
interface GigabitEthernet0/1
 no ip address
interface GigabitEthernet0/1.10
 encapsulation dot1Q 10
 ip address 10.10.10.1 255.255.255.0
interface GigabitEthernet0/1.20
 encapsulation dot1Q 20
 ip address 10.10.20.1 255.255.255.0
```

### Порт в access-VLAN

Access-порт — порт, который отдаёт всю свою нагрузку в одну VLAN без тегов.
Рабочее место, принтер, IP-телефон.

```bash
interface GigabitEthernet1/0/10
 switchport mode access
 switchport access vlan 10
 spanning-tree portfast
 switchport nonegotiate
```

Три момента, каждый из которых стоил кому-то времени:

- **Без `switchport access vlan 10` порт останется в VLAN 1.** Это главная
  причина «я всё настроил, а трафик идёт не туда».
- **`switchport nonegotiate` выключает DTP** — протокол, который самовольно
  договаривается с соседом о режиме порта. Если порт пользовательский,
  DTP на нём не нужен: он создаёт условия для автоматического переключения
  access-порта в trunk без твоего участия.
- **`spanning-tree portfast`** отключает для порта протокол остовного дерева.
  Коммутатор перестанет ждать 30–50 секунд на блокировку порта при переподключении.

Режимы порта, которые ты можешь встретить в конфиге чужого коммутатора:

| `switchport mode ...` | Что делает | Когда |
| --- | --- | --- |
| `access` | один VLAN, без тегов | рабочее место, принтер |
| `trunk` | несколько VLAN с тегами 802.1Q | между коммутаторами, к маршрутизатору |
| `dynamic auto` | ждёт DTP и соглашается на trunk | устаревший, не используй |
| `dynamic desirable` | сам предлагает trunk | устаревший, не используй |
| `private-vlan host` | изолированный порт в private VLAN | гостиница, изоляция клиентов |
| `private-vlan promiscuous` | выход из private VLAN наружу | серверный порт |

## Trunk: теги, native VLAN и главная ошибка

Trunk-порт несёт несколько VLAN и помечает кадр 802.1Q-тегом (4 байта: тип
VLAN). Один VLAN на trunk идёт **без тега** — он называется native VLAN. По
умолчанию это VLAN 1.

```bash
interface GigabitEthernet1/0/24
 switchport mode trunk
 switchport trunk native vlan 999
 switchport trunk allowed vlan 10,20,30,99
 no shutdown
```

> [!NOTE]
> Команда `switchport trunk encapsulation dot1q` нужна только на очень старых
> коммутаторах 2950, которые умеют ещё и ISL. На Catalyst 9300/9200 и на
> современных образах ISR этой команды **не существует** — не путай её
> отсутствие с ошибкой настройки.

### Почему порядок команд важен

`switchport trunk allowed vlan 10,20` **заменяет** весь список. Если ты сначала
разрешил `10,20`, а потом добавил `switchport trunk allowed vlan add 30` —
получишь `10,20,30`. Если сделал `switchport trunk allowed vlan 10,20` ещё раз
после добавления 30 — потеряешь 30. Проверяй результат:

```bash
do show interfaces trunk
# Port        Mode         Encapsulation  Status        Native vlan
# Gi1/0/24    on           802.1q         trunking      999
#
# Port        Vlans allowed on trunk
# Gi1/0/24    10,20,30,99
```

### Ошибка, которая стоит дороже остальных

**Native VLAN должна совпадать на обоих концах trunk.** Если один коммутатор
думает, что untagged-трафик — это VLAN 999, а второй — что это VLAN 1, то:

- кадры из VLAN 999 уходят в сеть как VLAN 1 — **утечка трафика между VLAN**;
- тегированные кадры 10/20/30 интерпретируются нормально, поэтому «вроде всё
  работает», пока не проверишь конкретный VLAN;
- если native VLAN с другой стороны не существует в твоей базе VLAN, порт
  может не подняться trunk'ом вообще, и в `show logging` появится сообщение
  о том, что VLAN не найден.

Отсюда правило: native VLAN задаётся явно на **каждом** trunk-порту, в обе стороны,
и проверяется одним `show interfaces trunk` с двух сторон.

> [!TIP]
> Соглашение по именованию VLAN снимает половину проблем. Договорись в команде
> о схеме: `10` — пользователи, `20` — серверы, `30` — гости, `99` — управление,
> `999` — native на trunk. Запиши её в описании VLAN (`name`), тогда
> `show vlan brief` сам напомнит тебе, что есть что.

## EtherChannel: когда одного порта мало

EtherChannel объединяет несколько физических портов в один логический
(`Port-channel1`), чтобы получить суммарную полосу и единое отказоустойчивое
звено. Ключевое свойство: кадры распределяются по портам **по хешу**, а не
очереди. Это повышает пропускную способность, но не даёт гарантию, что один
поток получит всю полосу.

```bash
interface range GigabitEthernet1/0/22-23
 channel-group 1 mode active
interface Port-channel1
 switchport mode trunk
 switchport trunk allowed vlan 10,20,30,99
```

| `channel-group 1 mode ...` | Протокол | Поведение |
| --- | --- | --- |
| `active` | LACP | **используй этот**; обе стороны активно согласуют |
| `passive` | PAgP | старая технология Cisco, агрессию не проявляет |
| `on` | без согласования | порт принудительно в канале; **опасно** |

`mode on` — источник реальных аварий: если на дальней стороне канал не настроен,
а тут `on`, ты получаешь цикл в L2 без всякой защиты.

```bash
show etherchannel summary
show lacp neighbor
```

> [!CAUTION]
> Типичное удивление: настроил канал из двух портов, а в
> `show etherchannel summary` в строке `s` (standby) вместо `s` стоит `I` или
> ты видишь, что в канале **один** порт. Это не ошибка: LACP собирает канал и из
> одного согласованного порта — просто второй не согласуется. Дальше ищи
> причину через `show lacp neighbor` (если сосед не показан — он не настроен на
> LACP, у него `mode on` или он вообще не коммутатор).
>
> Тот же принцип: **второй порт в канале не является резервом**. Если первый
> упал, канал выживет на втором — но только потому, что второй уже был в канале.
> Для настоящего резерва нужен отдельный порт в shutdown или второй канал.

### EtherChannel уровня 3

На маршрутизаторе (ISR) EtherChannel собирается иначе — как агрегированный
интерфейс L3:

```bash
interface GigabitEthernet0/2
 no ip address
interface GigabitEthernet0/3
 no ip address
interface Port-channel1
 no switchport
 ip address 10.0.0.1 255.255.255.252
 ip nat inside
 channel-member GigabitEthernet0/2
 channel-member GigabitEthernet0/3
```

На Catalyst 9300 тоже поддерживается, но через `no switchport` и `channel-group`
на интерфейсах — универсальный вариант выше работает на обоих.

## Полный конфиг: коммутатор доступа на 8 портов

Цель: management VLAN 99 с `10.10.99.2`, пользователи в VLAN 10, серверы
в VLAN 20, trunk на 24-м порту к ядру, неиспользуемые порты выключены.
Это ровно та база, с которой начинают в реальном офисе.

```bash
enable
configure terminal

! --- identity ---
hostname SW-ACCESS-01
enable secret MyStrongEnablePass
service password-encryption
no ip http server
no ip domain lookup

! --- management VLAN ---
vlan 99
 name MGMT
exit
interface Vlan99
 ip address 10.10.99.2 255.255.255.0
 ip access-group MGMT-IN in
exit

! --- user and server VLANs ---
vlan 10
 name USERS
exit
vlan 20
 name SERVERS
exit

! --- users ports 1-8 ---
interface range GigabitEthernet1/0/1-8
 description user-zone
 switchport mode access
 switchport access vlan 10
 switchport nonegotiate
 spanning-tree portfast
 spanning-tree bpduguard enable
 switchport port-security
 switchport port-security maximum 2
 switchport port-security violation restrict
 switchport port-security mac-address sticky
 no shutdown
exit

! --- server port 9 ---
interface GigabitEthernet1/0/9
 description srv-proxmox-nic2
 switchport mode access
 switchport access vlan 20
 switchport nonegotiate
 spanning-tree portfast
 spanning-tree bpduguard enable
 no shutdown
exit

! --- uplink trunk port 24 ---
interface GigabitEthernet1/0/24
 description UPLINK-to-core
 switchport mode trunk
 switchport trunk native vlan 999
 switchport trunk allowed vlan 10,20,99
 no shutdown
exit

! --- unused ports 10-23 stay shutdown ---
interface range GigabitEthernet1/0/10-23
 description UNUSED-port-disabled
 shutdown
exit

! --- L3 switch default gateway (needed only if this box routes) ---
ip default-gateway 10.10.99.1

spanning-tree mode rapid-pvst
end
copy running-config startup-config
```

Разбор нескольких строк, которые вызывают вопросы:

- **`ip default-gateway 10.10.99.1`** — на **L2-коммутаторе**. Коммутатор
  шлёт пакеты сам (SNMP, syslog, ICMP в ответ на пинг), и ему нужен шлюз для
  этого. На маршрутизаторе вместо этого пишется `ip route 0.0.0.0 0.0.0.0 ...`
  — разница в [лекции про маршрутизацию](02-marshrutizaciya.md).
- **`no ip domain lookup`** — отключает попытку резолвить неизвестные команды
  как DNS-имена. Без этого опечатка в команде означает ожидание 30-секундного
  таймаута DNS вместо немедленной ошибки. Один из лучших хаков в IOS.
- **`no ip http server`** — выключает веб-интерфейс. На Catalyst 9300 он
  включён по умолчанию и слушает все интерфейсы; в некоторых образах для этого
  есть лицензия DNA Advantage. Не нужен — выключай.
- **`interface range Gi1/0/10-23` + `shutdown`** — неиспользуемые порты
  выключены **одной строкой**. Это основа безопасности: пустой порт в VLAN 10 —
  это дыра, в которую воткнут чужой ноутбук.

> [!IMPORTANT]
> Сохраняй конфиг **сразу после каждого логически завершённого блока**, а не в
> конце сессии. Один `copy running-config startup-config` занимает полсекунды и
> страхует от потери до получаса работы.

> [!NOTE]
> Этот конфиг — учебный и проверенный на классическом Catalyst (2960, 9300) и ISR.
> Если тебе нужен «соседский» опыт работы с Cisco, посмотри
> [RouterOS в соседнем треке](01-routeros-os.md) — там тот же набор задач
> решается другой командной строкой, и переключение между платформами часто
> оказывается самым полезным навыком при работе в команде с разными вендорами.

## Где это ломается

- **Забытый `copy running-config startup-config`.** Самая частая причина
  «коммутатор сам сбросился». `reload`, скачок питания, обновление образа —
  и устройство возвращается в нулевое состояние с паролем по умолчанию.
  Проверяй `show version | include uptime` — если аптайм больше, чем время
  твоей последней правки, конфиг не сохранён.
- **Native VLAN не совпадает на двух концах trunk.** Признак — «всё работает,
  но из VLAN 999 видно то, что видно быть не должно». Проявляется не сразу:
  проблема живёт до первого устройства, которое этим воспользуется.
- **`switchport trunk allowed vlan` перезаписывает список.** Заменил список
  вместо того, чтобы дополнить его, — потерял VLAN. Лечится проверкой через
  `do show interfaces trunk` до `end`.
- **Копирование `vlan database` на ISR или на Catalyst 9300.** Чужой конфиг с
  этой строкой не применится, а если применится частично — останется
  устройство с половиной настроек и без VLAN.
- **`mode on` в `channel-group`.** Канал, настроенный без согласования, в связке
  с устройством без EtherChannel даёт широковещательный цикл. Сеть встанет
  полностью, а `show spanning-tree` покажет петлю в `Role`/`Age`, если повезёт
  добраться до консоли.
- **Пустые порты в рабочем VLAN.** Ничего не делает, но даёт соседу доступ в
  твою сеть: тот самый «случайно подключённый коммутатор в порту пользователя»,
  который ломает остовное дерево. `shutdown` на неиспользуемых портах —
  одна строка, а риск исчезает.
- **DTP не выключен на access-портах.** Коммутатор, воткнутый в порт
  пользователя, может договориться о trunk и получить доступ ко всем VLAN.
  `switchport nonegotiate` закрывает это.

## Чек-лист понимания

- [ ] Я знаю все три режима IOS, различаю их prompt'ы и понимаю, зачем нужен
      `enable`
- [ ] Я умею выйти из любого подрежима через `exit` и `end`, и знаю, зачем нужен
      префикс `do`
- [ ] Я понимаю, что `no` — универсальный префикс отмены, и знаю, почему в
      конфиге нет синтаксиса «отменить»
- [ ] Я отличаю `running-config` от `startup-config` и всегда проверяю, что
      сохранил изменения
- [ ] Я называю порты Cisco в нотации `Gi0/0/1` / `Gi1/0/1` и знаю, чем они
      различаются
- [ ] Я различаю три синтаксиса создания VLAN и знаю, что на ISR используются
      sub-интерфейсы с `encapsulation dot1Q`
- [ ] Я настраиваю access- и trunk-порт и понимаю, зачем на trunk нужен
      согласованный native VLAN
- [ ] Я знаю, чем `channel-group mode active` отличается от `mode on`, и почему
      второй вариант опасен