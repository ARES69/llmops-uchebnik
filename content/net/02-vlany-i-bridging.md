---
title: VLAN, bridge и трехуровневая модель
track: net
module: A. MikroTik / RouterOS
order: 2
duration: 75 мин
level: middle
tags: [vlan, bridge, trunk, dhcp, l2 l3]
summary: Три уровня MikroTik — порты, мост, VLAN — и почему трафик проходит только когда описаны и порт, и VLAN; плюс DHCP, DNS, NAT и пошаговая диагностика, которая экономит час
practice: Собери на тестовом MikroTik схему из трёх VLAN (management 10.10.10.0/24, users 10.10.20.0/24, guests 10.10.30.0/24), раздай адреса DHCP, закрой гостей от внутренних сетей правилом forward, открой им интернет через masquerade и пройди диагностику по шагам из лекции, фиксируя, на каком шаге ломается.
---

Половина вопросов «настройки не работают, помогите» в теме MikroTik сводится к одному
и тому же непониманию: Ethernet-порт, программный мост и VLAN-интерфейс — это три
**разных** сущности с разными правилами, и работают они только вместе. Схема, где
управляющий VLAN навешен прямо на физический порт (как на многих домашних роутерах),
работает сама по себе. Схема с trunk-ом почти всегда не работает, пока инженер не
осознал, что «добавить VLAN» и «добавить порт в этот VLAN» — это две разные записи в
двух разных списках. Эта лекция — про эти три уровня и про то, что происходит между ними.

## Схема, которую мы собираем

Базовый офис на одном MikroTik: три VLAN, три подсети, доступ в интернет из двух,
изоляция гостей. Всё дальнейшее — вариации этой схемы.

| VLAN | Тег | Подсеть | Интернет | Доступ к management | DHCP |
| --- | :---: | --- | :---: | :---: | --- |
| management | 10 | 10.10.10.0/24 | да | сам | статика |
| users | 20 | 10.10.20.0/24 | да | да | 8 часов |
| guests | 30 | 10.10.30.0/24 | да | нет | 2 часа |

## Уровень 1: физический порт

`/interface ethernet` — это то, что впаяно в плату. Управлять ими почти не нужно: только
включить, задать имя и скорость, если она не определяется.

```routeros
/interface ethernet print
/interface ethernet monitor ether2 once
/interface ethernet set [find default-name=ether2] name=to-switch comment="uplink к 802.1Q-свитчу"
/interface ethernet set [find default-name=ether3] disabled=yes
```

По умолчанию порты включены в первом bridge — в RouterOS есть неявная «нулевая группа
ether1…etherN» (`bridge=ether1`), созданная при первом запуске. Это источник путаницы:
интерфейс, который ты думал, что снял с моста, всё ещё в нём. Проверяй колонку `bridge`
в `print`, а не догадывайся.

```routeros
/interface print where type="ether bridge"   # все порты, сидящие на мостах
/interface print detail where name="ether3"
```

## Уровень 2: bridge — это «свитч»

Программный мост объединяет порты в один L2-сегмент: то, что пришло на `ether2` с
тегом 20, уйдёт на `ether3` с тем же тегом. Мост — это чистый второй уровень, он ничего
не знает про IP.

```routeros
/interface bridge add name=bridge1 vlan-filtering=no comment="все VLAN в одном мосте"
/interface bridge port add bridge=bridge1 interface=ether2 pvid=20
/interface bridge port add bridge=bridge1 interface=ether3
/interface bridge print
/interface bridge port print
/interface bridge monitor bridge1 once
/interface bridge host print          # кто за каким портом — главная диагностика L2
```

> [!IMPORTANT]
> `/interface bridge host print` — твой `ip neigh` для второго уровня. Он показывает
> MAC-адрес, порт и VLAN каждого видимого устройства. Если в этой таблице пусто или
> нет твоего клиента — проблема на L2 (порт, VLAN, кабель), а всё, что ты дальше
> будешь проверять на третьем уровне, враньёт.

## Уровень 3: vlan — это шлюз в третьем уровне

`/interface vlan` создаёт **логический интерфейс**, у которого есть собственный MAC и
собственный IP. Это и есть «шлюз VLAN в третьем уровне»: подсеть пробрасывается сквозь
мост, а маршрутизацией занимается уже RouterOS.

```routeros
/interface vlan
add name=vlan10-mgmt interface=bridge1 vlan-id=10
add name=vlan20-users interface=bridge1 vlan-id=20
add name=vlan30-guests interface=bridge1 vlan-id=30

/ip address
add address=10.10.10.1/24 interface=vlan10-mgmt network=10.10.10.0 comment="mgmt"
add address=10.10.20.1/24 interface=vlan20-users network=10.10.20.0 comment="users"
add address=10.10.30.1/24 interface=vlan30-guests network=10.10.30.0 comment="guests"
```

Названия `vlan10-mgmt` вместо `vlan10` — не украшательство. Через полгода в выводе
`/ip firewall filter` ты увидишь `in-interface=vlan20-users` и сразу поймёшь, о каком
VLAN речь, без обращения к документации.

## Почему трафик не проходит: правило двух записей

Для того чтобы кадр с тегом 20 дошёл до `vlan20-users`, нужны **две** записи:

1. Порт `ether3` должен быть **в мосте** — `/interface bridge port` с `bridge=bridge1`.
2. Порт `ether3` должен быть **в VLAN 20** — либо через `pvid=20` (кадр приходит без
   тега, коммутатор добавляет 20), либо через `/interface bridge vlan` с `untagged`,
   либо он `tagged` (кадр приходит уже с тегом).

Убери любое из двух — и VLAN будет «полупроводящим»: адрес на `vlan20-users` есть,
интерфейс `up`, а пакеты не доходят. Именно это ощущается как «настроил и не работает».

## Два способа сделать trunk

Есть две принципиально разные схемы, и их нельзя смешивать в голове.

| | Вариант A: PVID, `vlan-filtering=no` | Вариант B: таблица VLAN, `vlan-filtering=yes` |
| --- | --- | --- |
| Что делает `pvid` на порту | железо добавляет тег «из ничего», тег в трафике не нужен | тег приравнивается к VLAN 1 |
| Когда подходит | один VLAN на порт доступа; trunk — только если отдельно | настоящий 802.1Q-trunk с несколькими VLAN на одном порту |
| Где описывается тег для trunk | нигде — порт с `frame-types=admit-all` пропускает всё как есть | `/interface bridge vlan` |
| Почему интерфейсы с тегами | не работают (провайдер на `ether1` с тегами не пройдёт) | работают |
| Расход CPU | минимальный, есть аппаратная разгрузка | почти весь трафик идёт через CPU |

```routeros
# --- Вариант A: доступ + PVID ---
/interface bridge
set bridge1 vlan-filtering=no

/interface bridge port
add bridge=bridge1 interface=ether2 pvid=10 frame-types=admit-only-untagged-and-priority-tagged \
    ingress-filtering=yes
add bridge=bridge1 interface=ether2 pvid=20 frame-types=admit-only-untagged-and-priority-tagged \
    ingress-filtering=yes
add bridge=bridge1 interface=ether3 pvid=30 frame-types=admit-only-untagged-and-priority-tagged \
    ingress-filtering=yes

# trunk к внешнему свитчу: без pvid, пропускает кадры с тегами как есть
/interface bridge port
add bridge=bridge1 interface=ether1 frame-types=admit-all ingress-filtering=yes
```

> [!CAUTION]
> В варианте A порт с `pvid` **обязан** пропускать нетегированные кадры
> (`admit-only-untagged-and-priority-tagged`). Если поставить
> `frame-types=admit-only-vlan-tagged`, то клиент, который прислал кадр без тега,
> получит тишину — а ошибка выглядит как «не горит индикатор, но порт поднят».

## Таблица VLAN на мосте: tagged, untagged, bridge

Когда `vlan-filtering=yes`, теги задаются явно списком. Здесь важно понимать смысл трёх
слов: `tagged` — кадры этого порта уходят в интернет с тегом; `untagged` — порт отдаёт
кадр в VLAN **без** тега (это порт доступа для конечного устройства, которое не
понимает VLAN); `bridge` — сам роутер, который тоже является членом VLAN.

```routeros
/interface bridge
set bridge1 vlan-filtering=yes

/interface bridge vlan
add bridge=bridge1 vlan-ids=10 tagged=bridge1,ether1
add bridge=bridge1 vlan-ids=20 tagged=bridge1,ether1 untagged=ether2
add bridge=bridge1 vlan-ids=30 tagged=bridge1,ether1 untagged=ether3

/interface bridge port
set [find interface=ether2] pvid=20 frame-types=admit-only-untagged-and-priority-tagged ingress-filtering=yes
set [find interface=ether3] pvid=30 frame-types=admit-only-untagged-and-priority-tagged ingress-filtering=yes
set [find interface=ether1] frame-types=admit-only-vlan-tagged ingress-filtering=yes
```

> [!IMPORTANT]
> `bridge1` в списке `tagged` — не формальность. Без него роутер не считается членом
> VLAN, и интерфейс `vlan20-users` не получит ни одного кадра: трафик пойдёт между
> портами, но не к процессу маршрутизации. Это вторая по частоте причина «VLAN настроен,
> а шлюз не отвечает».

Если во внутренней сети есть ещё коммутаторы, `ether1` (trunk) должен быть в `tagged`
**во всех** VLAN. Для VLAN по умолчанию (`vlan-ids=1`) добавь явную запись — иначе
нетегированный трафик без PVID упадёт.

```routeros
/interface bridge vlan print
/interface bridge vlan print detail where vlan-ids=20
```

## Bridge firewall против аппаратной разгрузки

Пока включён `bridge firewall` (`/interface bridge filter`) или `vlan-filtering=yes`, весь
трафик идёт через процессор: чип очистки не трогает, форвардинг — программный. На
hEX с загрузкой под 200 Мбит/с это уже видно в `cpu-load` и в `/interface bridge
monitor`. Отключение bridge-фильтра переводит часть трафика на железо.

```routeros
/interface bridge set bridge1 fast-forward=yes
/interface bridge print                    # колонка hw: есть ли разгрузка
/interface bridge port print               # колонка hw по каждому порту
/interface bridge filter print             # если список не пуст — разгрузки нет
/system resource print                     # cpu-load, free-memory, uptime
```

| Что включено | Аппаратная разгрузка | Что чинить, если сломалось |
| --- | :---: | --- |
| мост, `vlan-filtering=no`, без bridge-фильтра | да | — |
| мост, `vlan-filtering=yes` | нет | пересчитать, хватит ли CPU; для крупных сетей — отдельный L3-коммутатор |
| `/interface bridge filter` с правилами | нет | фильтр на мосте, а не на IP-уровне: удобно для привязки к порту, но дорого |
| `fast-forward=yes` | да | требует `vlan-filtering=no` и отсутствия bridge-фильтра |

> [!CAUTION]
> Подводный камень: часть моделей вообще не умеет форвардить между портами на чипе, и
> тогда разгрузки не будет вовсе, независимо от настроек. Проверяй колонку `hw` в
> `print`, а не верь документации конкретной модели. И не включай мостовой фильтр
> «на всякий случай», если он не делает ничего полезного: он молча убирает разгрузку.

## DHCP: сервер, пулы, статика

DHCP-сервер в RouterOS требует три вещи: пул адресов, сервер на интерфейсе (или в
группе интерфейсов) и сетевые параметры для клиентов.

```routeros
/ip pool
add name=pool-users ranges=10.10.20.10-10.10.20.200
add name=pool-guests ranges=10.10.30.10-10.10.30.100

/ip dhcp-server
add name=dhcp-users interface=vlan20-users address-pool=pool-users lease-time=8h disabled=no
add name=dhcp-guests interface=vlan30-guests address-pool=pool-guests lease-time=2h disabled=no

/ip dhcp-server network
add address=10.10.20.0/24 gateway=10.10.20.1 dns-server=10.10.10.1,1.1.1.1 \
    domain=company.local
add address=10.10.30.0/24 gateway=10.10.30.1 dns-server=10.10.30.1 comment="гости во внешний DNS"

/ip dhcp-server lease
add address=10.10.20.50 mac-address=AA:BB:CC:DD:EE:FF server=dhcp-users comment="принтер"

/ip dhcp-server lease print
/ip dhcp-server lease make-static [find address=10.10.20.77]
/ip dhcp-server lease print status=waited
```

> [!IMPORTANT]
> Привязка по MAC делается в `/ip dhcp-server lease`, а **не** в
> `/interface bridge port`. Портовый `static-mac` в bridge работает на уровне MAC-адреса
> и не имеет никакого отношения к выдаче адреса. Ошибка «назначил статический IP в
> bridge port, а DHCP всё равно выдал другой» встречается постоянно.

Ещё две вещи, которые стоит знать:

- `address-limit` в аренде ограничивает количество выдаваемых адресов конкретному
  клиенту (полезно против однократного подключения поддельного MAC).
- Для DHCP-клиента, у которого MAC меняется (Windows рандомизирует MAC для приватности),
  статическая привязка перестанет работать — у клиента нужно отключить «случайный
  аппаратный адрес».

**Про две подсети с одного сервера.** Классическая ошибка: один `/ip dhcp-server` на
интерфейсе, две подсети в `/ip dhcp-server network`. Не сработает: сервер отдаёт адреса
из одного пула и маршрут клиентам выдаёт из той сети, которую он посчитал по адресу
сервера. И обойти это нельзя — свойства `interface-list` у `/ip dhcp-server` не
существует, сервер всегда вешается на **один конкретный интерфейс**.

Два сервера на одном интерфейсе тоже не запустятся: для непосредственно подключённых
клиентов на интерфейсе допустим ровно один сервер. Несколько серверов на одном
интерфейсе возможны только с разными значениями `relay` — это уже схема с DHCP-релеем,
а не «две подсети на одной точке доступа».

> [!IMPORTANT]
> Правильное решение простое и скучное: **по одному DHCP-серверу на VLAN**, у каждого
> свой пул, своя запись в `/ip/dhcp-server network`. Три VLAN — три сервера. Если
> серверов становится много, повторяющиеся куски удобно выносить в
> `/ip dhcp-server option` (наборы опций), а не пытаться ужать всё в один сервер.

Побочный эффект одного сервера на VLAN: аренда видна в одном списке, и ты сразу видишь,
в каком сегменте находится клиент. Это дешевле, чем разбираться с агрегированной
таблицей аренд из десяти подсетей.

## DNS: что отдавать клиентам

```routeros
/ip dns
set servers=10.10.10.10,1.1.1.1,9.9.9.9 allow-remote-requests=yes cache-size=2048

/ip dns static
add name=ad.company.local address=10.10.10.10 ttl=1d
add name=gitlab.company.local address=10.10.20.15
```

`allow-remote-requests` — это разрешение роутеру **отвечать клиентам** на порт 53.
Значение по умолчанию — `no`, то есть резолвер работает только для самого роутера.
Клиенты получают `10.10.20.1` шлюзом, идут к нему по DNS и получают отказ, который
выглядит как «интернет есть, а сайты не открываются» — при том что пинг до шлюза и до
`1.1.1.1` проходит идеально. Это одна из самых обидных поломок в RouterOS, потому что
первые четыре шага диагностики дают правильный ответ. Проверяй:

```routeros
/ip dns print
/ping 1.1.1.1 count=2                  # связность есть?
/ip dns cache print
/ip dns cache flush
```

> [!CAUTION]
> Второй важный момент: `allow-remote-requests=yes` открывает 53/udp и 53/tcp на **все
> адреса роутера**, включая WAN. Защищает только файрвол по умолчанию. Если ты
> переписывал цепочку `input` — не забудь правило на 53, иначе либо не работает DNS у
> клиентов, либо твой роутер становится открытым рекурсивным резолвером для интернета.
> Второй вариант заканчивается письмом от провайдера.

> [!CAUTION]
> В RouterOS нет полноценных DNS-views. Две записи `/ip dns static` с одинаковым именем
> и разными адресами дадут тебе чередование ответов, а не split-horizon. Если нужен
> честный split-horizon (внутри — внутренний адрес, снаружи — внешний), вариантов три:
> внешний DNS-резолвер (AdGuard Home, UniFi, Technitium) на внутреннем сервере, два
> разных сетевых на правилах `/ip firewall`, либо split-horizon на стороне Windows AD.
> Третий вариант — правильный, потому что DNS-резолвер у тебя в контуре всё равно есть.

## NAT для VLAN: наружу и внутрь

Гостям нужен интернет, но не нужна внутренняя сеть. Это делается двумя правилами:
`masquerade` на выход и `drop` в цепочке `forward` между подсетями.

```routeros
/ip firewall nat
add action=masquerade chain=srcnat out-interface=ether1 out-interface-list=WAN
add action=dst-nat chain=dstnat protocol=tcp dst-port=8443 in-interface=ether1 \
    to-addresses=10.10.20.10 to-ports=8443 comment="внутренний сервис наружу"

/ip firewall filter
add chain=forward action=accept connection-state=established,related
add chain=forward action=drop connection-state=invalid
add chain=forward action=drop in-interface=vlan30-guests out-interface=vlan20-users \
    comment="гости не видят пользователей"
add chain=forward action=drop in-interface=vlan30-guests out-interface=vlan10-mgmt \
    comment="гости не видят management"
add chain=forward action=accept in-interface=vlan20-users out-interface=ether1
add chain=forward action=accept in-interface=vlan30-guests out-interface=ether1
add chain=forward action=drop
```

Ключевая идея — изоляция через **отсутствие правила**, а не через запрет. Гость может
идти наружу, потому что есть `accept` для `out-interface=ether1`. Гость не может идти
внутрь, потому что подходящего `accept` нет, а финальный `drop` ловит всё остальное.

Проброс порта внутрь требует двух вещей: правила `dst-nat` **и** того, чтобы хост
не отвечал сам. На клиенте должен быть маршрут по умолчанию через `10.10.20.1` — иначе
ответ уйдёт напрямую провайдеру, и соединение не соберётся. Это второй по частоте
провал проброса: правило есть, порт открыт, `curl` не подключается.

## Диагностика по шагам

Держи последовательность жёсткой и не переходи дальше, пока текущий шаг не дал ответа.
Это тот же принцип, что и в [лекции про диагностику сети](devops/04-set-i-diagnostika.md),
только на сетевом оборудовании.

| # | Проверка | Команда | «Плохо» значит |
| --- | --- | --- | --- |
| 1 | порт видит соседей | `/interface bridge host print` | нет записей: порт не в мосте, кабель, VLAN |
| 2 | интерфейс поднят | `/ip address print detail where interface=vlan20-users` | `invalid` или `disabled` |
| 3 | ARP проходит | `/ip arp print where interface=vlan20-users` | клиента нет: неверная маска или он не в этом VLAN |
| 4 | сам шлюз | `/ping 10.10.20.1 count=3 interface=vlan20-users` | L3-проблема: адрес, маска, VLAN-интерфейс |
| 5 | шлюз извне | `/ping 10.10.20.10 count=3` с ноутбука клиента | маршрутизация между VLAN или правило forward |
| 6 | наружу | `/ping 1.1.1.1 count=3` + `/tool ping 1.1.1.1 count=3` | NAT, маршрут по умолчанию, WAN |
| 7 | DNS | `/tool ping github.com count=3`, клиент — `nslookup github.com` | `/ip dns`, `allow-remote-requests`, `dns-server` в DHCP |
| 8 | скорость | `/interface vlan20-users monitor vlan20-users once` | дуплекс, ошибки, отсутствие аппаратной разгрузки |

> [!TIP]
> Для шага 1 есть отдельный приём: посмотри `/interface ethernet monitor ether2 once` —
> там видно `rx-fcs-error`, `rx-no-buffer`, `tx-queue` и фактическую скорость на
> линке. Дуплекс 100 Мбит на гигабитном порту с жалобой «Wi-Fi тормозит» встречается
> чаще, чем хотелось бы.

## Сравнение: MikroTik, Cisco, Linux-роутер

Знание одной из этих моделей легко переносится на две другие — если понимать, что
решает одна и та же задача.

| Задача | MikroTik | Cisco IOS | Linux (`iproute2`, `dnsmasq`, `iptables`) |
| --- | --- | --- | --- |
| Коммутация портов | `/interface bridge` + `/interface bridge port` | `switchport` + `vlan` | `ip link add name br0 type bridge`, `ip link set eth1 master br0` |
| Тег VLAN на порту | `pvid`, `/interface bridge vlan` | `switchport trunk allowed vlan` | `ip link add link br0 name br0.20 type vlan id 20` |
| L3-шлюз VLAN | адрес на `/interface vlan` | SVI `interface vlan 20` | адрес на `br0.20` |
| DHCP | `/ip dhcp-server` + `/ip dhcp-server network` | `ip dhcp pool` + `network` + `default-router` | `dnsmasq` (`dhcp-range`, `dhcp-option`) |
| Таблица маршрутов | `/ip route` | `ip route` | `ip route` |
| NAT наружу | `action=masquerade` | `ip nat inside source` / `overload` | `iptables -t nat -A POSTROUTING -j MASQUERADE` |
| Проброс порта | `action=dst-nat` | `ip nat inside` + `static tcp` | `iptables -t nat -A PREROUTING -j DNAT` |
| Фильтр трафика | `/ip firewall filter` | `access-list` + `interface` | `iptables` / `nftables` |
| Таблица соседей | `/interface bridge host print`, `/ip arp print` | `show mac address-table`, `show ip arp` | `bridge fdb show`, `ip neigh` |

> [!IMPORTANT]
> Главное отличие не в синтаксисе, а в модели сети. Cisco научит тебя мыслить SVI и
> access/trunk-портами, MikroTik — PVID и мостом с CPU-портом, Linux — namespace и
> `br0.20`. Как только ты видишь, что все три описывают одно и то же разными словами,
> переключение между платформами перестаёт быть проблемой. Про безопасное хранение
> конфигураций такого оборудования — в
> [лекции про «инфраструктуру как код»](net/18-set-kak-kod.md).

## Где это ломается

- **Порт добавлен в мост, но не в VLAN (или наоборот).** Самая частая ошибка. Проверка:
  `/interface bridge port print` и `/interface bridge vlan print` должны показывать
  согласованную картину.
- **В таблице VLAN не указан сам `bridge`.** Трафик между портами идёт, но процесс
  маршрутизации не видит ничего — VLAN «не работает только для шлюза».
- **`vlan-filtering=yes` убил аппаратную разгрузку.** Сеть стала медленнее на том же
  железе. Смотри колонку `hw` в `/interface bridge print` и `/interface bridge port print`.
- **Порт доступа с `frame-types=admit-only-vlan-tagged`.** Конечное устройство шлёт кадры
  без тега, они молча отбрасываются. Для доступа нужен
  `admit-only-untagged-and-priority-tagged`.
- **Один DHCP-сервер на две подсети.** Клиент получает адрес из чужой подсети или вообще
  не получает. Нужен сервер на каждый VLAN со своим пулом.
- **Статический IP прописан в `/interface bridge port` вместо `/ip dhcp-server lease`.**
  Bridge ничего не знает про DHCP.
- **Проброс порта настроен, но у хоста нет шлюза по умолчанию.** Ответы уходят мимо
  роутера, соединение не собирается, а `dst-nat` в счётчиках растёт.
- **MAC-адрес изменился у беспроводного клиента.** Windows рандомизирует MAC для приватности
  — статическая аренда перестаёт совпадать, и принтер «теряется».
- **Изоляция гостей сделана через `/ip firewall address-list`, а не через цепочку
  `forward`.** `address-list` работает на `input`/`forward`, но без явного `drop`
  в `forward` между подсетями клиенты всё равно увидят друг друга, если есть любой
  `accept` с маской шире, чем ты думаешь.

## Чек-лист понимания

- [ ] Я могу назвать три уровня модели MikroTik и сказать, что отвечает за каждый:
      порт, мост, VLAN-интерфейс
- [ ] Я знаю, почему для прохождения кадра нужны две записи — порт в мосте и порт в VLAN
- [ ] Я понимаю разницу между `tagged`, `untagged` и `bridge` в
      `/interface bridge vlan` и знаю, зачем в `tagged` указывать сам роутер
- [ ] Я могу объяснить, почему `vlan-filtering=yes` отключает аппаратную разгрузку
      и как это проверить по колонке `hw`
- [ ] Я знаю, где в RouterOS привязывается статический адрес по MAC и почему
      `/interface bridge port` для этого не подходит
- [ ] Я умею проходить связность по шагам от `/interface bridge host print` до DNS
      и назвать, что означает отказ на каждом шаге
- [ ] Я могу объяснить, почему гостя без `accept` не пускает наружу, и зачем нужен
      финальный `drop` в цепочке `forward`