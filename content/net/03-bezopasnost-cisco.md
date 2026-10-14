---
title: Безопасность на Cisco: доступ, ACL, порты
track: net
module: B. Cisco IOS
order: 8
duration: 75 мин
level: middle
tags: [cisco, acl, aaa, ssh, port-security, bpdu guard]
summary: Как закрыть доступ к коммутатору по SSH вместо telnet, чем enable secret лучше password-encryption, зачем нужен AAA, как написать рабочий ACL и что дают port-security и BPDU Guard — с честным разбором того, что на Cisco, что на MikroTik, что на Eltex.
practice: Настрой на коммутаторе доступа SSH с локальной AAA-базой, ACL на management VLAN, port-security с sticky на портах пользователей и bpduguard на всех access-портах. Проверь `show access-lists`, `show port-security`, `show spanning-tree summary`.
---

Три предыдущие лекции дали тебе работающую сеть. Теперь вопрос, который
руководитель IT-отдела задаёт себе каждое утро: **что произойдёт, если в сеть
попадёт посторонний**. Сетевое оборудование Cisco исторически настраивалось
«как будто оно в стеклянной комнате», и именно поэтому его любят в атаках:
`show running-config` может содержат пароли в открытом виде, telnet на vty
по умолчанию, а порты доступа не блокируются. Эта лекция — про то, чтобы
закрыть всё это, и не выстрелить себе в ногу при настройке.

## Порядок доступа: консоль → enable → vty

У IOS три независимых способа попасть внутрь, и каждый закрывается отдельно:

1. **Консольный порт** (`line console 0`) — физический, работает всегда, даже
   когда сеть мертва. Не должен требовать пароль для входа в EXEC.
2. **Enable-режим** (`enable secret`) — режим привилегий для изменения
   конфигурации. Без него ты видишь только `show`.
3. **Виртуальные терминалы** (`line vty 0 15`) — удалённый доступ по SSH или
   telnet.

Базовый конфиг, который обязателен везде:

```bash
line console 0
 password ConsolePass123
 login
 exec-timeout 5 0
 logging synchronous
!
enable secret MyStrongEnableSecret
!
service password-encryption
```

Разберём каждую строку и — главное — то, чего в ней **нет**.

`service password-encryption` — команда, которую чаще всего понимают неправильно,
и это реальная проблема: она создаёт у инженеров ложное чувство защищённости.

> [!IMPORTANT]
> `service password-encryption` — это **не шифрование**. Это обратимое
> кодирование. Cisco исторически использует слабый симметричный алгоритм (Vigenère
> с ключом из passphrase), и его реализация публично известна. Любой, кто
> получил строку `7 070C285F4D06...` из конфига, расшифрует её за секунды —
> существует одна строка `openssl` или python-скрипт, который это делает.
>
> Настоящая цель команды — не защита от злоумышленника, а чтобы пароль **не
> читался плечами через плечо** и не светился в `show run` при чужом глазе.
> Против целенаправленного чтения конфига она не защищает ничего.

Настоящая защита паролей — тип `secret`. Сравнение, которое стоит знать наизусть:

| Строка в конфиге | Что это | Обратимо? | Оценка |
| --- | --- | --- | --- |
| `password 7 070C285F...` | `service password-encryption` | **да**, за секунды | как будто пароля нет |
| `enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0` | MD5, тип 5 (по умолчанию для `secret`) | нет (перебор) | средне: MD5 быстрый, словарный подбор реальный |
| `enable secret 9 $9$...` | **scrypt**, тип 9 (современные IOS XE) | нет | **сильно**: медленный хеш, устойчив к перебору |
| `username admin secret 9 ...` | то же для пользователей | нет | сильно |

Тип (`5`, `8`, `9`) указывается явно, если хочешь лучшее из доступного:

```bash
enable secret 9 $9$abc...$      # заранее сгенерированный scrypt-хеш
username admin privilege 15 secret 9 $9$def...
```

> [!CAUTION]
> Типы 8 (pbkdf2) и 9 (scrypt) появились начиная с IOS XE 17.x на платформах
> Catalyst 9000. На **классических ISR с IOS 15.x** команда `enable secret 9`
> **не поддерживается** — маршрутизатор ответит ошибкой. Сначала проверь:
> `do show version` — какая версия IOS. На ISR останется только тип 5 (MD5).
> Если нужен сильный хеш — генерируй пароль, вставляй готовый, но понимай,
> что тип 5 там единственный.

Порядок команд, который нельзя нарушать, чтобы не потерять доступ:
сначала `enable secret` (он не конфликтует с `enable password`), потом настройка
`vty`, и только потом проверка в **новой** SSH-сессии. Никогда не редактируй
единственный способ доступа, не открыв второй.

### SSH вместо telnet

```bash
ip domain name company.local
crypto key generate rsa modulus 2048
ip ssh version 2
ip ssh time-out 60
ip ssh authentication-retries 2
line vty 0 15
 transport input ssh
 login local
 exec-timeout 5 0
```

Шаг за шагом:

- **`ip domain name`** — обязателен **до** генерации ключа. Без доменного имени
  `crypto key generate rsa` не сработает: не на что делать subject ключа. Это
  самая частая ошибка новичка.
- **`crypto key generate rsa modulus 2048`** — создаёт пару ключей
  (приватный + публичный) для сервера SSH. 2048 бит — минимум сегодня;
  4096 — если есть запас CPU (ISR думает минуту). Повторный запуск спросит
  подтверждение замены ключей.
- **`ip ssh version 2`** — включает только SSHv2. SSHv1 имеет известные слабости
  и на современных IOS отключён; проверь, что v1 точно нет:
  `do show run | include ip ssh version` (в выводе должен быть ровно `version 2`).
- **`transport input ssh`** — на `vty` разрешает **только** SSH. Telnet и все
  прочие протоколы отключаются этой строкой, отдельно их выключать не нужно.
- **`login local`** — аутентификация по локальной базе пользователей (следующий
  раздел), а не по строке `password` на самой линии. Это ключевое отличие:
  `password` на vty — один общий пароль на весь доступ, `login local` —
  персональные учётки с логами.

> [!TIP]
> Порядок «сначала имя домена → потом ключ» и «сначала настроил vty → потом
> проверил новой сессией» решает 90% случаев «после настройки SSH я потерял
> доступ». Вторую проверку всегда делай **до** выхода из текущей сессии.

### Почему `vty 0 4` с паролем — плохо

Классическая конфигурация, которую надо исправить в первую очередь:

| Практика | Проблема | Правильно |
| --- | --- | --- |
| `line vty 0 4` | всего 5 одновременных сессий; на 6-й — отказ, хотя портов `0 15` | `line vty 0 15` (16 сессий на Cisco) |
| `password somepass` + `login` | один пароль на всех, не узнать, кто подключился | `login local` с персональными учётками |
| `transport input telnet` | трафик открытым текстом | `transport input ssh` |
| `enable password ...` | слабее `enable secret`, может сосуществовать | только `enable secret` |

## AAA: не «логин-пароль», а framework

**AAA** = Authentication (кто ты) + Authorization (что тебе можно) +
Accounting (что ты делал). На Cisco это включается глобально и меняет смысл
всей существующей аутентификации.

```bash
aaa new-model
!
aaa authentication login default local
aaa authorization exec default local
aaa accounting exec default start-stop
aaa accounting network default start-stop
!
username admin privilege 15 secret 9 $9$abc...
username operator privilege 1 secret 9 $9$def...
username operator autocommand show running-config
!
line vty 0 15
 transport input ssh
 login local
 exec-timeout 5 0
```

Разбор:

- **`aaa new-model`** — включает новую модель. **Внимание:** пока она не
  включена, `login` на vty без `password` или `login local` ведёт себя иначе.
  Включение `aaa new-model` требует, чтобы на каждой `line vty` **сразу** был
  задан `login local` (или `login authentication`), иначе доступ к устройству
  закрывается полностью. Это та же блокировка, что с `ip ssh version 2`.
- **`username ... privilege 15`** — локальная база. Уровни: 1 = `show run`,
  15 = полный доступ. Уровень 1 не даёт `configure terminal` — удобно для
  оператора-дежурного, которому надо читать состояние, но не менять.
- **`username ... autocommand show running-config`** — при входе этот
  пользователь автоматически попадает в вывод `show run` и не может выйти.
  Незаменимо для подрядчика — он видит конфиг и ничего не может сломать.
- **`aaa accounting exec default start-stop`** — плюс `line vty` с
  `accounting exec default` и команда `accounting` на линии пишут в syslog,
  **кто и когда** подключался и что делал. Без этого ты не сможешь ответить на
  вопрос «кто это сделал вчера в 3 часа».

> [!NOTE]
> Для небольшого офиса `aaa new-model` + `local` — это правильно. Когда
> появятся несколько администраторов или требования аудита — подключай
> **TACACS+** или **RADIUS** (обычно RADIUS/NPS от Windows AD в твоём контуре):
> `aaa authentication login default group tacacs+ local` (с `local` как
> запасным — не остаться без доступа, если сервер недоступен). Это уже
> выходит за рамки IOS, но заложить интерфейс стоит сразу: `tacacs-server host`,
> `tacacs-server key ...`, группы `server ...`.

## ACL: правила доступа

ACL (Access Control List) — упорядоченный список правил: пакет проверяется
сверху вниз, первое совпавшее правило решает судьбу пакета, и **в конце
неявный `deny ip any any`**. Это главное, что нужно помнить.

Стандартные ACL (номер 1–99) фильтруют **только по адресу источника**,
расширенные (100–199 или именованные) — по источнику, назначению, протоколу
и порту. Для реальной работы нужны расширенные.

```bash
ip access-list extended MGMT-IN
 remark permit SSH and DNS only from management VLAN
 permit tcp 10.10.99.0 0.0.0.255 any eq 22
 permit tcp 10.10.99.0 0.0.0.255 any eq 443
 permit udp 10.10.99.0 0.0.0.255 any eq 53
 permit icmp any any echo-reply
 deny   ip any any log
exit
!
interface Vlan99
 ip access-group MGMT-IN in
```

Правила, которые важнее синтаксиса:

1. **Второй wildcard `0.0.0.255`, а не маска `255.255.255.0`.** Это, как и в OSPF,
   побитовое отрицание: `/24` записывается как `0.0.0.255`.
2. **`permit icmp any any echo-reply`, а не `permit icmp any any`.** Разреши весь
   ICMP — и вместе с ним `destination unreachable`, который может использоваться
   для разведки сети. Для диагностики достаточно `echo-reply` (ответ на пинг) и
   `echo` (запрос, если нужен активный пинг). Traceroute требует ещё
   `time-exceeded` и `unreachable` — если эти ICMP закрыты, `traceroute` покажет
   звёздочки до конца, и это не баг.
3. **Неявный deny в конце.** Если забыл `permit`, весь ACL = один сплошной
   `deny`. Проверяй `show access-lists` и счётчики совпадений.
4. **`deny ip any any log`** в конце — обязателен осознанно: он пишет в лог
   каждое отклонённое совпадение. Но **осторожно**: на загруженном интерфейсе
   тысячи `log`-совпадений в секунду сами по себе нагружают CPU. Если
   диагностируешь неисправность — сними `log` и добавь обратно после.

Где применять ACL:

```bash
! вариант 1: на интерфейс / SVI — направление in или out
interface GigabitEthernet1/0/20
 ip access-group MGMT-IN in
!
! вариант 2: на VLAN целиком (правильнее для коммутатора)
vlan access-map MGMT-MAP 10
 permit vlan 99
vlan access-map MGMT-MAP 20
 deny vlan 99
vlan filter MGMT-MAP 99
```

| Куда вешать | Что фильтрует | Когда |
| --- | --- | --- |
| `ip access-group` на интерфейс (in) | IP-пакеты одного порта | точечно, на границе |
| `ip access-group` на интерфейс (out) | уходящие пакеты | редко, легко сломать ответный трафик |
| `vlan access-map` на VLAN | трафик всего VLAN | **правильный способ** изолировать VLAN |
| на маршрутизаторе — `ip access-group` на интерфейсе L3 | между подсетями | на шлюзе |

> [!IMPORTANT]
> ACL на Cisco — **stateless**. Он не помнит, что разрешил исходящий пакет.
> Если ты разрешил исходящий трафик к внешнему серверу, но не разрешил в
> обратном направлении — соединения не заработают, и причина будет неочевидна.
> Либо разрешай оба направления явно, либо используй stateful-решение
> (zone-based firewall на ASA, stateful `established` на линуксовых, или
> `established` keyword в составном ACL, если достаточно).
>
> `established` в IOS работает только для TCP и проверяет, что у пакета есть
> установленная сессия:
> `permit tcp any any established`. Начальное соединение пропустит
> `permit tcp any any eq 443`, ответный — `established`.

## Port-security и защита портов доступа

User-порт физически доступен любому в офисе. Port-security ограничивает, сколько
MAC-адресов живёт на порту, и реагирует на превышение.

```bash
interface range GigabitEthernet1/0/1-8
 switchport mode access
 switchport access vlan 10
 switchport port-security
 switchport port-security maximum 2
 switchport port-security violation restrict
 switchport port-security mac-address sticky
```

`maximum 2`, а не 1, потому что **два MAC на порту — норма**: IP-телефон
(свой MAC) + ноутбук за ним (второй MAC). Один — слишком строго для телефонов,
связка не заработает. Sticky-режим запоминает первый увиденный MAC и больше
других не пускает.

| `violation` | Что делает при превышении | Когда применять |
| --- | --- | --- |
| `shutdown` | порт выключается (err-disable) | максимальная строгость, требует восстановления |
| `restrict` | порт остаётся, лишний MAC отбрасывается, шлётся violation-событие | **обычный выбор**: работает, но сообщает |
| `protect` | лишний MAC отбрасывается, **без уведомления** | тихий режим, хуже для расследования |

Автовосстановление, чтобы порт не «залип» выключенным навсегда:

```bash
errdisable recovery cause psecure-violation
errdisable recovery interval 300
```

### BPDU Guard: защита от «случайного коммутатора»

Сценарий: кто-то втыкает в порт пользователя обычный коммутатор (из кладовки,
на свалке, из своего роутера). Этот коммутатор отправляет BPDU — и становится
корнем или соседом в твоём остовном дереве. Дерево пересобирается, трафик
переносится на другой путь, и часть сегментов отваливается на минуты. Это не
теория: именно так устроено большинство «мистических» сетевых сбоев.

```bash
spanning-tree portfast          # порт не участвует в выборах (edge-порт)
spanning-tree bpduguard enable  # если придёт BPDU — порт в err-disable
!
spanning-tree bpduguard default # то же для ВСЕХ portfast-портов разом
```

`bpduguard default` — правильный способ для офиса: одна строка вместо
сорока. BPDU Guard работает только на **portfast**-портах (он по определению
не должен получать BPDU). И обязательно:

```bash
errdisable recovery cause bpduguard
errdisable recovery interval 300
```

Без recovery-строки после срабатывания порт останется выключенным до ручного
`shutdown`/`no shutdown` — и это может стать твоим инцидентом на полчаса.

Root Guard (`spanning-tree guard root`) защищает от корня, пролезшего по
некрасивому пути: порт перестаёт участвовать в выборах корня, но продолжает
передавать данные. BPDU Guard — это «выруби порт», Root Guard — «не дай стать
корнем».

### Шторм-контроль и выключение пустых портов

```bash
interface GigabitEthernet1/0/15
 description workstation-ivan
 storm-control broadcast level 20
 storm-control action shutdown
!
interface range GigabitEthernet1/0/16-23
 description UNUSED-port-disabled
 shutdown
```

Неиспользуемые порты — **выключены и описаны**. Это самая дешёвая мера: пустой
порт в рабочем VLAN — открытая дверь, в которую воткнётся ноутбук, принтер или
тот самый чужой коммутатор. Строка `shutdown` стоит копейки и убирает класс
проблем целиком.

## Одна задача — три платформы

Ты работаешь с оборудованием разных вендоров. Логика безопасности у всех
одинаковая, различается только командная строка:

| Задача | Cisco IOS | MikroTik RouterOS | Eltex (серия MES/SES) |
| --- | --- | --- | --- |
| Убрать пустой порт | `shutdown` на интерфейсе | `/interface bridge port` + `disabled=yes` | `no shutdown` отсутствует, порт выключается через `no ip ...` / состояние порта |
| Ограничить MAC | `switchport port-security maximum N` | `/interface bridge host` (bridge host — один MAC на порт) | `switchport security` + `mac max-count` |
| Фильтр по адресам | `ip access-list extended` + `ip access-group` | `/ip firewall filter` + цепочки `input`/`forward` | `access-list extended` + `ip access-group` (синтаксис близок к Cisco) |
| Ограничить вход на устройство | `line vty`, `aaa`, `login local` | `/user`, `/ip service` (`ssh`, `telnet` — выключить), `/ip firewall filter` на `input` | `username`, `ssh server`, ACL на `vlan` management |
| Защита от BPDU | `spanning-tree bpduguard default` | STP включён всегда, отдельного BPDU Guard нет; защита — отключить порт | `spanning-tree bpduguard default` (на MES поддерживается) |
| DHCP-сервер | `ip dhcp pool` | `/ip dhcp-server network` + `address-pool` | `ip dhcp pool` |

Синтаксис Eltex и Cisco действительно похож — Eltex (сделан на тех же
ASIC-чипах с Catalyst-подобной идеологией) ближе всего к Cisco. Но **проверяй
свою модель**: точная поддержка команды зависит от серии и версии прошивки.
MicroTik в этом ряду — полностью другой мир: там фильтрация всегда
многоуровневая, через цепочки, и `/ip firewall filter` пишется как список
правил с переходами (`chain`, `action`, `dst-address-list`). Сравнение двух
подходов — в [лекции про RouterOS](01-routeros-os.md).

## Где это ломается

- **Считал `service password-encryption` за защиту.** Это обратимое кодирование.
  Пароль, «зашифрованный» им, расшифровывается тривиально. Если в конфиге
  критичные пароли — переводи их на `enable secret` / `username secret` с типом 5
  или 9.
- **Не задал `ip domain name` перед `crypto key`.** Генерация ключа не проходит
  с ошибкой «domain name not set». Порядок обязателен.
- **Включил `aaa new-model`, не задав `login local` на vty.** Устройство
  перестаёт принимать удалённый вход. Всегда редактируй в одном блоке и
  проверяй второй сессией.
- **ACL без неявного deny в голове.** Первое правило `deny ip any any` убивает
  всё, что ниже. Правила идут строго сверху вниз — поставил общий `permit`
  раньше частных — частные не сработают никогда.
- **ACL только в одну сторону.** Cisco ACL stateless. Разрешил запрос, забыл
  ответ — соединение не поднимется, и в логах будет пусто.
- **Port-security с `maximum 1` на порту с IP-телефоном.** Телефон видит один
  MAC (свой), ноутбук за ним — второй, и он отбрасывается по `violation
  restrict`. Ставь `maximum 2` для телефонных портов.
- **BPDU Guard без err-disable recovery.** Порт сработал и остался выключенным.
  Без `errdisable recovery cause bpduguard` он не вернётся сам — жалоба
  «пользователь без сети», пока ты не подойдёшь физически.
- **Не выключил пустые порты.** Порт доступа в рабочем VLAN без ограничений —
  это не «просто потенциальная дыра», а реально используемый вектор: туда
  втыкают коммутатор и получают доступ ко всем VLAN.
- **Забыл `ip ssh version 2` проверкой.** Убедись через `show run | include ip
  ssh version`, что в выводе ровно `version 2`, а не обе версии.

## Чек-лист понимания

- [ ] Я понимаю, что `service password-encryption` — обратимое кодирование, а
      настоящая защита — `secret` с типом 5 или 9
- [ ] Я знаю, что `ip domain name` обязан идти **до** `crypto key generate rsa`,
      и понимаю, почему `line vty 0 15` + `login local` + `transport input ssh`
      правильно, а `vty 0 4` + `password` — нет
- [ ] Я знаю, что делает `aaa new-model` и почему после неё сразу нужен
      `login local` на vty
- [ ] Я различаю стандартный и расширенный ACL, знаю, что wildcard-маска — это
      отрицание маски, и что неявный `deny ip any any` в конце ACL — и что
      забытый `permit` блокирует всё
- [ ] Я знаю, что Cisco ACL stateless, и всегда разрешаю оба направления явно
- [ ] Я умею настроить port-security со sticky и правильным `maximum` для
      телефонов
- [ ] Я знаю, зачем BPDU Guard и почему после срабатывания нужен
      `err-disable recovery`
- [ ] Я умею выключить и описать все неиспользуемые порты коммутатора