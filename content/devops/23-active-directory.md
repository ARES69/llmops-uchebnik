---
title: Active Directory: администрирование
track: devops
module: F. Хранилища и интеграции
order: 23
duration: 95 мин
level: middle
tags: [active directory, gpo, репликация, sysvol, dcdiag, лес]
summary: Как устроен и чинится Active Directory: репликация NTDS и DNS, объектная модель и права, порядок применения GPO, SYSVOL, политики паролей, аудит и диагностика типовых поломок
practice: Разберись в репликации через repadmin и dcdiag, проверь состояние SYSVOL и DFSR, сгенерируй отчёт gpresult с клиента, разбери ACL на OU через dsacls и SDDL, а затем пройди сценарий «пользователи не могут залогиниться» от whoami /all до проверки политик.
---

Две предыдущие лекции про хранилища данных, где права и структура задаются кодом и миграциями. Active Directory — противоположность: права, структура и поведение задаются политиками, которые применяются в рантайме на каждой машине, и про которые системный администратор часто знает меньше, чем думает. Для контура, где в AD живут учётки сотрудников, сервисные учётки LLM-сервиса и корпоративный портал, понимание AD перестаёт быть «доменными делами» — это часть управления доступом к LLM-системе. Разбираем его основательно: репликацию, GPO, SYSVOL и диагностику, потому что почти все «пользователи не могут войти» решаются тремя командами, если знать, какими.

## Что делает AD и зачем он в LLM-контуре

AD отвечает на три вопроса: **кто** этот субъект, **чем** он является (состоит в группах), и **что ему разрешено** (ACL на объектах, членство в группах). Плюс он хранит конфигурацию клиентов в виде групповых политик и отдаёт учётные данные сервисам по протоколу Kerberos.

| Задача | Механизм AD | Как это используется в LLM-контуре |
| --- | --- | --- |
| Единый вход | Kerberos, доменный логон | сотрудник открывает корпоративный ассистент без отдельного пароля |
| Авторизация по группам | членство в группах + ACL | сервис LLM проверяет «в группе `LLM-Admins`», а не «роль в таблице» |
| Распространение конфигурации | GPO через SYSVOL | параметры прокси, адреса шлюза, политики хранения логов на клиентах |
| Управление сервисными учётками | отдельные OU, ротация паролей | учётка `svc-rag`, которой дано минимум прав на файл-шару с корпусом |
| Аудит доступа | Security-лог с кодами событий | «кто и когда открыл документ, попавший в ответ ассистента» |

> [!IMPORTANT]
> Для архитектуры LLM-системы отсюда следует правило: авторизацию в RAG
> проверяй по группам AD, а не по собственному списку пользователей.
> Тогда добавление нового отдела — это изменение членства в группе,
> а не правка кода и не миграция базы, и аудит приходит из Security-лога
> того же домена, а не из отдельной системы.

## Структура леса

Лес — это набор доменов, между которыми есть двустороннее доверие. Внутри леса реплицируются одни и те же схемы и части глобального каталога.

| Объект | Что это | Устройство |
| --- | --- | --- |
| Лес (forest) | верхний контейнер, общая схема и `Configuration` | один набор доменов |
| Домен (domain) | логическая единица безопасности, своя политика паролей и DNS-зона | `DC=corp,DC=example,DC=com` |
| Дерево (tree) | домен и все домены под ним | `corp.example.com` и `corp.example.com\Sub` |
| Контроллер домена (DC) | сервер, хранящий копию `NTDS.dit` | один = read-only DC, два = отказоустойчивость |
| Глобальный каталог (GC) | подмножество объектов всех доменов леса, доступно только для чтения | всегда минимум один, лучше два |
| RODC | контроллер домена только для чтения на филиале | фильтрует конфиденциальные атрибуты, кэширует пароли |
| Сайт | подмножество домена, связанное быстрой сетью | влияет на топологию репликации |
| OU | контейнер для объектов и назначения политик | не является контейнером Windows, группа безопасности с другим смыслом |

Сайты — ключевая для администратора сущность, потому что топология репликации строится по ним, а не по «расстоянию». Два DC в одном сайте реплицируются каждые 15 минут в обе стороны независимо от реальной задержки в сети. Если два сервера стоят в разных стойках, но в одном сайте, они считаются «близкими» — и это часто источник проблем при переезде между площадками.

```powershell
Get-ADForest corp.example.com | Format-List Name, DomainNamingMaster, RootDomain, SchemaSchemaClass
Get-ADDomain -Server dc01.corp.example.com | Format-List DNSRoot, NetBIOSName, Forest, Sites
Get-ADDomainController -Filter * -Property * | Select-Object HostName, Site, IsGlobalCatalog, IPv4Address |
  Format-Table -AutoSize
Get-ADReplicationSite -Filter * | Select-Object Name, InterSiteTopologyGenerator
Get-ADReplicationSiteLink | Select-Object Name, Cost, SitesIncluded
```

Доверительные отношения нужны, когда организации должны быть разными (своя политика паролей, свой администратор), но должны видеть друг друга:

| Тип | Направление | Аутентификация | Типовой сценарий |
| --- | --- | --- | --- |
| Двустороннее (bidirectional) | A видит B и наоборот | полная (Kerberos) | слияние компаний, два подразделения |
| Одностороннее (one-way incoming) | A видит B, B не видит A | в стороне, где есть входящее, — Kerberos; в обратную — NTLM | филиал видит центральный домен, не наоборот |
| Одностороннее (one-way outgoing) | обратная предыдущему | то же | сокращение доверия в сторону головного офиса |
| Внешнее доверие (external) | между лесами | NTLM | подрядчик получает доступ к ресурсу |

Правило, которое экономит нервы: **не создавай доверие там, где можно обойтись гостевой учёткой**. Каждое доверие расширяет транзитивную зону доверия и делает Kerberoasting глобальной проблемой.

## Логика репликации: NTDS, USN, векторы версий

Вся база домена лежит в файле `C:\Windows\NTDS\NTDS.dit` на каждом контроллере. Это не файл, а набор страниц базы данных ESENT; изменения приходят между контроллерами не «файлом», а потоком операций изменения атрибутов.

Ключевые понятия:

- **NTDS** (Naming Tree Directory Service) — служба, которая хранит и реплицирует базу;
- **USN** (Update Sequence Number) — сквозной монотонный номер изменения, общий для всего леса;
- **репликационные метаданные** — для каждого атрибута каждого объекта хранится `versionLastChanged` (USN изменения) и `versionOriginator` (DC, сделавший изменение, и номер его вектора);
- **вектор версий** (version vector) — у каждого DC своя история изменений; конфликт разрешается правилом: побеждает DC с более высоким `versionOriginator` USN, ничья — приоритет по GUID.

Отсюда практический вывод: **репликация не транзакционная и не упорядоченная**. Изменения приходят в произвольном порядке и с задержкой до 15 минут внутри сайта и до 3 часов между сайтами по умолчанию. Если ты сменил пароль, ушёл сразу обратно в другой DC и не вошёл — это не баг, это репликация.

```powershell
# общая картина: кто кому что реплицирует
repadmin /replsummary
repadmin /replsummary dc01.corp.example.com /bytime /csv > C:\repl.csv
repadmin /showrepl * /csv | Import-Csv | Where-Object { $_.Status -ne '0' } | Format-Table

# принудительная репликация одного объекта/каталога с таймингом
repadmin /replicate dc01.corp.example.com dc02.corp.example.com /v /f

# подробности по конкретному NC
repadmin /showrepl dc01.corp.example.com /v /bytime "CN=Users,DC=corp,DC=example,DC=com"
repadmin /dsreplicaoverview
```

```text
# dcdiag /test:replications — что именно проверяется
Site/Bridgehead          есть ли исходный узел для межсайтовой репликации
Server/Warning           есть ли исходный узел для межсайтовой репликации
Ncsync/Nc                 синхронизация контекстов именования
Server/ReplicationsCheck  репликация внутри сайта
Server/SysVolCheck        SYSVOL и NETLOGON (см. ниже)
Server/Advertising        объявляет ли сервер себя как DC
Server/NcReplications      согласованность NC
Replications/RunningInV
```

Интервалы настраиваются явно, и для небольшого домена их стоит сократить:

```text
dcdiag /e /c /v

repadmin /addreplica dc02.corp.example.com CN=Configuration,DC=corp,DC=example,DC=com
```

## DNS — неотъемлемая часть AD

Контроллер домена — это DNS-сервер зоны `example.com`, и «DNS в AD» не означает «весь мой DNS лежит в Active Directory». AD-клиент ищет SRV-записи вида `_ldap._tcp.dc._msdcs.corp.example.com`. Нет этих записей — нет входа в домен.

```powershell
# клиентский участник должен находить DC
nslookup -type=SRV _ldap._tcp.dc._msdcs.corp.example.com
nltest /dsgetdc:corp.example.com

# какие зоны обслуживает конкретный сервер
Get-ADDomainController -Identity dc01 | Get-ADComputerService -Filter * |
  Select-Object Name, DNSHostName, IsPrimary, IsAutoCreated
Resolve-DnsName -Name _ldap._tcp.dc._msdcs.corp.example.com -Type SRV -Server dc01.corp.example.com
```

> [!CAUTION]
> Типичная ошибка, стоившая реальных часов работы: в AD-домене,
> поднятом на существующей сети, на DC в качестве DNS-сервера прописан
> внешний DNS-контроллер. Наружу это не выглядит ничем — но без локальных
> зон AD нет SRV-записей, поэтому `nltest /dsgetdc` не находит контроллер
> и машины не входят в домен. AD требует, чтобы DNS-сервер домена был
> на самом DC, а внешние запросы он форвардил через форвардеры
> (`/etc`-аналог — `dns.properties`, ключи `ServerForwarders` и
> `Forwarders` в реестре на `HKLM\SYSTEM\CurrentControlSet\Services\DNS`).

## Объекты, группы и права

Объекты AD бывают контейнерными (`CN=Users`, `OU=`) и leaf-объектами (`CN=Иванов`). Схема задаёт, какие атрибуты у какого класса объекта, и расширяется через `schema.msc`. Обычному администратору расширять схему не нужно, но знать про `displayName`, `sAMAccountName`, `userPrincipalName`, `memberOf`, `description` стоит.

Группы — это то, где чаще всего происходит ошибка проектирования, которая всплывает через год.

| Область группы (scope) | Кого может содержать | Как реплицируется | Когда применять |
| --- | --- | --- | --- |
| **Domain Local** | любой домен леса | только на DC, где группа живёт | доступ к ресурсу: файлы на этом же сервере, локальные принтеры |
| **Global** | только свой домен | **во все домены леса** | политики, объединяющие учётки одного домена: `All-Staff` |
| **Universal** | любой домен | во все GC, дороже в разы | глобальная группа, в которую нужны учётки других доменов |

Классическая ошибка: сделать `All-Staff` универсальной «на всякий случай, вдруг придёт сотрудник из другого домена». Стоимость — группа реплицируется во все GC и начинает тормозить их при каждом изменении членства. Если задача GPO «всем сотрудникам» — нужен Global.

| Тип группы | Есть SID в токене | Можно использовать в ACL | Назначение |
| --- | --- | --- | --- |
| Security | да | да | всё, что связано с доступом |
| Distribution | нет | нет | рассылки, почта. Назначение в ACL — ошибка, приведёт к «доступу нет» без внятной причины |

ACL и SDDL. Каждый объект AD имеет дескриптор безопасности: владелец (`owner`), группа (`group`), DACL, SACL. SDDL — компактная текстовая запись, которую читаешь быстрее, чем список ACE в графической утилите.

```text
# Формат SDDL: O:<owner> G:<group> D:<DACL> S:<SACL>
# Флаги: FA — полный доступ, CI — контейнер наследует, OI — объекты наследуют
O:BAG:SYD:PAI(A;FA;CI;FA;;;BA)(A;FA;FA;;;SY)(A;CI;0x1200a9;;;BU)

O:BAG:BAD:   владелец — администраторы домена, DACL защищён от наследования
(A;FA;FA;;;SY)   SYSTEM — полный доступ, не наследуется
(A;CI;0x1200a9;;;BU)   пользователи домена — только чтение, распространяется на потомков
```

```powershell
# dsacls показывает и ACE, и флаги наследования — это главный инструмент по правам
dsacls "OU=LLM-Services,DC=corp,DC=example,DC=com"
dsacls "CN=svc-rag,OU=ServiceAccounts,DC=corp,DC=example,DC=com" /g
dsacls "OU=LLM-Services,DC=corp,DC=example,DC=com" /I /T    # включая потомков
Get-Acl "C:\Windows\System32\NTDS" -Audit | Format-List       # SACL: что аудируется

# группы и членство
Get-ADGroup -Filter "SamAccountName -eq 'All-Staff'" -Properties member | Select-Object -ExpandProperty member
Get-ADPrincipalGroupMembership -Identity "Иванов" | Select-Object SamAccountName
(Get-ADGroup "LLM-Admins").SID            # SID нужен для проверки прав в приложении
```

Порядок и смысл ACE: в DACL сначала идут явно запрещённые (`D`), потом явно разрешённые (`A`), потом унаследованные. Проверка идёт сверху вниз до первого решения. Отсюда правило **deny-first**: если ACL трогали несколько администраторов, первым в списке всегда должен быть явный Deny на Delete Child, иначе кто-то добавит правило снизу и не поймёт, почему удаление перестало работать. Наследование блокируется флагом `P` (protected) в SDDL, и это делает объект «островом» — после блокировки надо явно выдать права потомкам.

## GPO: порядок применения

Порядок, который надо знать наизусть:

1. **Site → Domain → OU**, от самой общей области к самой частной.
2. При одинаковом уровне — **обратный приоритет**: политика с меньшим номером в списке выигрывает.
3. Явное Deny всегда побеждает Allow.
4. Для одного пользователя на одной машине политики применяются **раздельно для Computer Configuration и User Configuration**.

Четвёртый пункт объясняет половину обращений. `Computer Configuration` приходит от политик, привязанных к OU компьютера (и учётной записи компьютера), `User Configuration` — от политик, привязанных к OU пользователя. Если ты ждёшь, что сетевой путь настроится политикой для пользователей, а привязал её к OU компьютеров, — настройки применятся не к тому объекту.

```text
gpupdate /force                          # принудительное обновление на клиенте
gpupdate /force /target:computer         # только компьютерная часть
gpresult /h C:\gpo-user.html /scope:user /r        # что применилось пользователю
gpresult /h C:\gpo-comp.html /scope:computer /r

gpresult /r /scope:user /v                          # текстом в консоль
gpresult /r /scope:computer /v /user:CONTOSO\ivanov
gpresult /a /f C:\report.html /g C:\gp.txt /u CONTOSO\ivanov /c CONTOSO\PC-01
```

`gpresult /h` создаёт HTML-отчёт **Resultant Set of Policy** — это то, к чему ты приходишь в первую очередь, когда «GPO не применяется». В отчёте по каждой политике видно четыре колонки: `User Policy`, `Computer Policy`, `Resultant`, и — критически важная — **«Applied GPOs» со статусом и причиной отказа**: `Not Applied (Filtered)`, `Not Applied (Disabled)`, `Not Applied (Empty)`, `Access Denied`. Почти всегда ответ там.

```powershell
Get-GPResultantSetOfPolicy -ReportType HTML -Path C:\rsop-user.html
Get-GPO -All | Where-Object { $_.LinksEnabled } | Select-Object DisplayName, GpoStatus
Get-GPInheritance -Target "OU=Workstations,OU=Corp,DC=corp,DC=example,DC=com" -ReportType HTML
```

### Loopback processing

Политика, привязанная к OU компьютеров, применяется к пользователю с Computer Configuration. Но бывает наоборот: пользовательские настройки должны применяться к самому компьютеру — например, политика на запуск сценария при входе или установку сертификата. Тогда включается **loopback processing**, и тут две ошибки:

| Режим | Что делает | Когда нужен |
| --- | --- | --- |
| Merge (по умолчанию) | добавляет User Configuration компьютера к пользовательским | почти всегда то, что ты хочешь |
| Replace | **заменяет** пользовательские настройки на компьютерные | редко, для машин, где всё должно задаваться централизованно |
| No Loopback (выключен) | ничего не применяется | текущее поведение |

Loopback включается в свойствах GPO: `Computer Configuration → Administrative Templates → System → Group Policy → Loopback Processing Mode`. Симптом ошибки: на рабочей машине политика работает, на тестовой нет — у тестовой учётки компьютера другой OU, и loopback настроен только в одном месте.

## SYSVOL: место, где живут сами политики

Это отдельная тема, потому что здесь ломается всё остальное. Содержимое GPO лежит в файловой шаре `\\domain\SYSVOL\domain\Policies\{GUID}`, а скрипты автонастройки — в `\\domain\SYSVOL\domain\Scripts`. Эта шара **должна быть реплицирована на все контроллеры домена**, потому что компьютер загружает политику с ближайшего DC, а не с «правильного».

До Windows 2008 это делалось через репликацию FRS по типу DFS, сейчас — через DFSR (DFS Replication) поверх набора файлов. Правильные настройки, без которых репликация SYSVOL не работает:

```powershell
# DFSR должен быть на каждом DC, SYSVOL и NETLOGON должны быть на NTFS
Get-Service DFSR | Select-Object Status, StartType
Get-SmbShare -Name NETLOGON, SYSVOL | Select-Object Name, Path, Special

# включить подпись SMB — без неё репликация SYSVOL не запускается
Set-SmbServerConfiguration -EnableAuthenticateMessageSigning $true -Force
Get-SmbServerConfiguration | Select-Object EnableAuthenticateMessageSigning, EnableSMB1Protocol

# состояние пространства репликации
dfsradmin membership
dfsradmin publication
dfsrdiag
```

Симптом рассинхрона выглядит так: политика применяется на части компьютеров, пользователи жалуются «у меня слетает настройка», а на одном DC в `SYSVOL\...\Policies` лежат папки, которых нет на другом. Причина — не «сломалось», а расхождение, которое надо свести:

```powershell
dcdiag /test:sysvol /v
repadmin /replicate dc01.corp.example.com dc02.corp.example.com /v
dfsutil /s /v \\corp.example.com\SYSVOL
icacls \\dc01.corp.example.com\SYSVOL\corp.example.com\Policies
```

Порядок ручной починки: проверить, что DFSR запущен на обоих DC; проверить, что папка репликации существует и не в состоянии ошибки (`dfsradmin membership`); удалить конфликтные папки вручную, **только** после того, как доказал, что какая-то из копий правильная, сравнив содержимое `Machine\Preferences` и `GptTmpl.inf`; затем `repadmin /replicate`. Удалять `SYSVOL` целиком — нельзя, это единственное хранилище политик.

## Парольная политика и блокировки

```powershell
# политика домена целиком
Get-ADDefaultDomainPasswordPolicy -Server dc01 |
  Format-List MinPasswordLength, MinPasswordAge, MaxPasswordAge, PasswordHistoryCount,
                LockoutThreshold, LockoutDuration, LockoutObservationWindow

net accounts /domain
```

| Параметр | Разумное значение для небольшого домена | Почему |
| --- | --- | --- |
| Минимальная длина | 14 | длина важнее набора «спецсимволов» |
| Сложность | включена | короткие словарные пароли остаются главным вектором |
| Максимальный срок | 180 дней, **без** требования периодической смены | вечная смена приучает писать `Password123!` |
| История | 24 | мешает ротации «12345 → 12346 → 12347» |
| Порог блокировки | 10 | ниже — включается DoS через подбор |
| Длительность блокировки | 15–30 минут | длиннее — при удалённой работе приходится ждать |

Fine-grained password policies дают разные правила для разных групп в одном домене — например, для сервисных учёток LLM-системы длиннее и реже:

```powershell
Get-ADFineGrainedPasswordPolicy -Filter * | Format-Table Name, Precedence, MinPasswordLength, MaxPasswordAge
Set-ADFineGrainedPasswordPolicy -Name "LLM-ServiceAccounts" -Precedence 10 `
  -MinPasswordLength 24 -MaxPasswordAge 90 -PasswordHistoryCount 24 `
  -LockoutThreshold 5 -LockoutDuration 00:15:00 -LockoutObservationWindow 00:30:00
Add-ADFineGrainedPasswordPolicySubject -Identity "LLM-ServiceAccounts" -Subjects "LLM-ServiceAccounts"
Reset-ADAccountLockout -Identity "ivanov"
```

## Аудит: какие события включать и что в них искать

Продвинутый аудит на контроллере домена включён по умолчанию, но политику проверять надо: на многих доменах «Directory Service Access» выключен, и тогда смены прав на объекты не пишутся.

```powershell
auditpol /get /subcategory:"Audit Directory Service Changes"
auditpol /set /subcategory:"Audit Directory Service Access" /success:enable /failure:enable
auditpol /get /category:* | Select-Object -Property "Machine Name", "Policy Target", Subcategory,
  "Subcategory/Subcategory GUID", InclusionSetting | Where-Object { $_.InclusionSetting -ne "No Auditing" }
```

| Код | Событие | Что искать в нём |
| --- | --- | --- |
| 4624 | успешный вход | тип входа (3 — сетевой), источник, учётка |
| 4625 | неуспешный вход | всплеск по одному источнику — подбор или истёкший пароль |
| 4648 | вход с явными учётными данными | `runas` администратора домена на рабочей станции |
| 4672 | выданы специальные привилегии | кто именно стал админом на этой машине |
| 4720 | создана учётная запись | появление нового `svc-*` без заявки |
| 4728 / 4732 / 4756 | добавление в глобальную / доменную локальную / универсальную группу | попадание в `Domain Admins` |
| 4724 | сброс пароля | массовые сбросы 1–2 событиями — это подбор |
| 4740 | блокировка учётки | источник блокировок из логов 4625 |
| 4776 | попытка аутентификации через NTLM | всплеск NTLM при полном переходе на Kerberos — признак старой настройки клиента |
| 5140 | доступ к сетевому объекту | чтение документа, попавшего в ответ ассистента |
| 5136 / 5137 | изменение атрибута / значения объекта | правка атрибутов, в том числе `memberOf` |
| 4781 | переименование учётки | попытка спрятать следы |
| 1102 | журнал аудита очищен | кто-то заметает следы — разбирать как инцидент |
| 4719 | изменение политики аудита | само по себе повод для расследования |

```powershell
# кто добавлялся в группу администраторов за неделю
$ids = 4728, 4732, 4756
Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=$ids; StartTime=(Get-Date).AddDays(-7) } |
  Select-Object TimeCreated, Id, @{n='Who';e={$_.Properties[0].Value}},
                @{n='Group';e={$_.Properties[2].Value}}, @{n='Added';e={$_.Properties[3].Value}} |
  Format-Table -AutoSize

# неуспешные входы, сгруппированные по источнику
Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=(Get-Date).AddHours(-24) } |
  Group-Object { $_.Properties[19].Value } | Sort-Object Count -Descending | Select-Object Count, Name
```

## Типовые поломки

| Симптом | Наиболее вероятная причина | Первая команда |
| --- | --- | --- |
| «Не удаётся войти», DNS-ошибка | DNS-сервер домена не на DC, нет SRV-записей | `nltest /dsgetdc:corp.example.com` |
| Вход медленный, потом проходит | рассинхрон времени (Kerberos требует ±5 минут), нагрузка на NTDS | `w32tm /query /status`, `dcdiag /test:time /v` |
| Пользователь входит на один DC, не входит на другой | рассинхрон репликации или разный SYSVOL | `repadmin /showrepl *`, `dcdiag /test:sysvol /v` |
| Учётка заблокирована «сама» | порог блокировки ниже, чем всплеск входа с одной машины | `Get-ADUser -Identity ivanov -Properties LockoutTime` |
| Политика применилась на части машин | loopback processing, фильтрация по OU, блокировка наследования | `gpresult /h C:\gpo.html /scope:computer /r` |
| Скрипт автонастройки не отрабатывает | SYSVOL рассинхронизирован, `Domain Policies Scripts Path` неверный | `dcdiag /test:sysvol /v`, `gpresult /r /v` |
| Две машины с одинаковым именем, вход ломается | клонирована ВМ с домена, совпадают SID компьютера и CN | `dsquery * -filter "(sAMAccountType=computer)" ...`, см. ниже |

### Клонирование ВМ с тем же SID

Это реально бывает в контуре на Proxmox: сделал снимок рабочей машины или контроллера, чтобы «быстро поднять тестовую среду», склонировал — и получил в домене две учётные записи компьютера с **одинаковым SID**. DNS отдаёт обе, клиент получает не ту запись, Kerberos выдаёт билет для чужого SID, и вход либо не проходит, либо проходит как машина, которой ты не думал.

```powershell
# найти дубли SID среди компьютеров домена
Get-ADComputer -Filter * -Properties Name, ObjectGUID, SamAccountName |
  ForEach-Object {
    $sid = (New-Object System.DirectoryServices.AccountManagement.PrincipalContext(
             [System.DirectoryServices.AccountManagement.IdentityType]::Domain,
             'corp.example.com')).GetUser([System.Security.Principal.NTAccount]$_.SamAccountName).SID.Value
    [PSCustomObject]@{ Name=$_.Name; SID=$sid }
  } | Group-Object SID | Where-Object Count -gt 1

# корректный путь: снять с домена копию ДО клонирования
# djoin /provision /domain:corp.example.com /machine:PC-NEW-02 /domainou:"OU=Workstations,DC=corp,DC=example,DC=com"

# лечение существующей копии
Get-ADComputer -Identity "OLD-NAME" -Properties ObjectGUID   # запомнить GUID до изменений
```

Лечение состоит из двух шагов и требует прав администратора домена: удалить старую учётную запись компьютера (`Remove-ADComputer -Identity "OLD-NAME" -Confirm:$false`) после того, как на копии сменили имя и перезагрузили её, и дождаться репликации удаления, потому что DNS-записи устаревают медленно, чем сам объект. Если обратный путь недоступен — заходи локально администратором, чисти кэш (`klist /purge`), и удаление делай на том DC, где копия гарантированно не нужна.

### SYSVOL «разъезжается» после клонирования DC

Если клонируешь сам контроллер домена, нельзя просто копировать его `NTDS.dit` — учётная запись компьютера DC, SIDs и идентификаторы DSA внутри базы остаются прежними. Для тестового DC правильный путь — `dcdemo` или развёртывание через `sysprep /generalize` и `djoin /provision`, а не горячая копия работающего `NTDS.dit`.

## Восстановление: USN-роли и NTDS.dit

Роли FSMO — единая точка записи для операций, которые нельзя выполнять одновременно на двух DC. Их пять:

| Роль | Что без неё не работает |
| --- | --- |
| PDC Emulator | политика домена, эмуляция леса, изменение времени |
| RID Master | выдача RID для новых учёток |
| Domain Naming Master | добавление доменов в лес, OU внутри домена |
| Schema Master | расширение схемы |
| Infrastructure Master | перемещение объектов между доменами леса |

```powershell
Get-ADDomainController -Identity dc01.corp.example.com |
  Select-Object -ExpandProperty OperationRole
dsquery * -filter "(objectCategory=domainDNS)" -attr name -d corp.example.com
netdom query fsmo
# перенос роли — только осознанно и с планом отката
Set-ADOperationMaster -Identity dc02.corp.example.com -OperationRole PDCEmulator
```

Три точки отката, которые надо знать заранее:

- **Netlogon-папка** на DC — копия базы SAM. Потерял её — потерял часть учёток. Восстанавливается снапшотом VSS, если он был.
- **SYSVOL** — копия политик. Где нет бэкапа, там нет восстановления политик, кроме экспортированного бэкапа GPO.
- **NTDS.dit** — вся база. Восстановление — это снимок файловой системы (VSS), который снимается принудительно: `ntdsutil` → `snapshot create`, либо `vssadmin create shadow /for=C:\Windows\NTDS`. Снимок VSS делается на живом DC за секунды и не мешает репликации, а именно его чаще всего не делают «потому что жалко терять производительность».

```powershell
# VSS-снимок NTDS на DC — делать по расписанию, а не в день аварии
vssadmin create shadow /for=C:\Windows\NTDS /set "WRITERNAME=corp\dc01"
vssadmin list shadows
ntdsutil                                  # интерактивно: snapshot create / list / mount
```

## Инструменты администратора

| Инструмент | Что делает | Когда нужен |
| --- | --- | --- |
| RSAT | добавляет оснастки `Active Directory*` и `dcdiag`/`repadmin` в Windows 10/11 | удалённое управление доменом с рабочей машины |
| `dsquery` | поиск объектов из командной строки | быстрый поиск без GUI |
| `ldifde` | экспорт/импорт объектов в LDIF | перенос объекта между лесами, резервная копия OU |
| `csvde` | экспорт в CSV | инвентаризация учёток и групп для отчётности |
| `repadmin` | состояние и форсирование репликации | разбор рассинхрона |
| `dcdiag` | комплексная диагностика DC | универсальный первый инструмент |
| `ntdsutil` | снимки и экспорт базы AD | бэкап и восстановление |
| `Get-AD*` (RSAT) | скриптуемый доступ к AD | автоматизация учёта и выдачи прав |

```powershell
# экспорт ветки в LDIF — делай до любых массовых изменений
ldifde /d "OU=LLM-Services,DC=corp,DC=example,DC=com" /f C:\backup\llm-services.ldif

# инвентаризация для отчётности руководству
csvde -d "DC=corp,DC=example,DC=com" -r "(objectClass=user)" -l sAMAccountName,mail,memberOf,accountExpires `
  -f C:\reports\users.csv
csvde -d "DC=corp,DC=example,DC=com" -r "(objectClass=group)" -l sAMAccountName,member -f C:\reports\groups.csv

# импорт обратно (осторожно: конфликты SID и objectGUID)
ldifde /i /f C:\backup\llm-services.ldif

# общая проверка домена перед совещанием
dcdiag /e /c /v /test:dns /test:replications /test:services /test:netlogon
dcdiag /test:advertising /v
```

## Наблюдаемость AD

Экспортёр `windows_exporter` с коллектором `ad` отдаёт метрики, которые ловят деградацию до того, как пользователи её заметят. Полная схема — в [лабораторной лекции](devops/18-lab-proxmox-monitoring.md); здесь — что именно смотреть и почему:

```promql
# очередь репликации: если не ноль дольше двух интервалов — репликация отстала
windows_ad_replication_pending_operations > 0

# LDAP-сессии на контроллере: рост без снижения = утечка соединений или поток LDAP-поисков
windows_ad_ldap_client_sessions

# рассинхрон схемы: сразу разбираться, иначе новые атрибуты не поедут
increase(windows_ad_replication_sync_requests_schema_mismatch_failure_total[1h]) > 0

# размер базы домена: NTDS.dit растёт монотонно, резкий скачок — обследовать
ad_ntds_dit_size_bytes

# доля неуспешных входов: всплеск = подбор или проблема с доменными паролями
increase(ad_failed_logon_total[15m]) > 20
```

Плюс четыре алерта, которые стоит настроить до первого инцидента: недоступность службы `NTDS`, ненулевой `replication_pending_operations`, `1102` (журнал аудита очищен) и `4776` с положительным счётчиком NTLM.

## Практика: «пользователи не могут залогиниться»

Сценарий: утро понедельника, часть сотрудников пишет «не пускает в домен». Порядок действий — от дешёвого к дорогому, без прыжков сразу в `dcdiag` на каждой машине.

**Шаг 1. Выяснить, у кого именно и как именно.** Это экономит половину времени: «не пускает» — это либо DNS-ошибка, либо неверный пароль, либо политика, либо машина вне сети.

```powershell
# 1.1 на клиенте: контекст безопасности и кэш билетов
whoami /all
klist /purge            # сбросить кэш Kerberos, потом попробовать снова
klist

# 1.2 видит ли клиент домен вообще
nltest /dsgetdc:corp.example.com
nslookup -type=SRV _ldap._tcp.dc._msdcs.corp.example.com
nslookup dc01.corp.example.com

# 1.3 время: расхождение больше 5 минут ломает Kerberos полностью
w32tm /query /status
w32tm /resync
```

**Шаг 2. Ответить, где именно ломается.** Три команды на контроллере домена покрывают большинство случаев:

```powershell
dcdiag /e /c /v /test:dns /test:replications /test:services /test:netlogon
repadmin /replsummary
repadmin /showrepl * /csv | Import-Csv | Where-Object { $_.Status -ne '0' }
```

Типичные находки: `Advertising test failed` (DC не отвечает), `Replications check failed` с указанием на конкретный партнёр (исправляется `repadmin /replicate`), `SysVol check failed` (рассинхронизован SYSVOL).

**Шаг 3. Проверить политику на самой машине клиента.**

```powershell
gpresult /h C:\gpo.html /scope:user /r
gpresult /h C:\gpo-comp.html /scope:computer /r
gpresult /r /scope:user /v | Select-String -Pattern "Not Applied|Access Denied|Denied"
```

Читаешь HTML-отчёт: политика в статусе `Not Applied (Filtered)` — не пройдена фильтрация безопасности или неверно привязана к OU; `Access Denied` — проблема с правами на объект OU или на сам GPO; политики нет в списке вообще — ты смотришь не на тот OU или политика не привязана.

**Шаг 4. Проверить учётку и группы.**

```powershell
Get-ADUser -Identity ivanov -Properties PasswordLastSet, LockoutTime, AccountExpires, MemberOf |
  Format-List Name, Enabled, PasswordLastSet, PasswordExpired, LockoutTime, AccountExpires, MemberOf
Get-ADPrincipalGroupMembership -Identity ivanov | Select-Object SamAccountName
Reset-ADAccountLockout -Identity ivanov
Unlock-ADAccount -Identity ivanov
```

**Шаг 5. Журналы на клиенте и на контроллере.**

```powershell
Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4624,4625,4771,4776; StartTime=(Get-Date).AddMinutes(-30) } |
  Select-Object TimeCreated, Id, Message | Format-List

# на DC: что именно произошло с этой учёткой
Get-WinEvent -FilterHashtable @{ LogName='Security'; StartTime=(Get-Date).AddMinutes(-30) } |
  Where-Object { $_.Message -match 'ivanov' } | Select-Object TimeCreated, Id, Message
```

**Шаг 6. Если вход проходит, но не с той политикой или не с теми правами.** Тогда проблема уже не в Kerberos, а в GPO и ACL, и порядок другой: `gpresult` → `dsacls` на OU → членство в группах → при необходимости `repadmin /replicate` и повторный `gpupdate /force`.

> [!TIP]
> Заведи себе файл `C:\SOP\ad-login-troubleshooting.txt` с этими
> командами в порядке выполнения. В 9 случаях из 10 после него остаётся
> только одна нераскрытая причина, и на её разбор уходит час вместо дня.

## Где это ломается

- **Удалил объект, не дождавшись репликации.** Удаление ушло на один DC, но не на второй, и клиент рядом со вторым продолжает работать со старым состоянием. Всегда проверяй `repadmin /replsummary` после массовых изменений, и не делай их за минуту до отпуска.
- **Фильтрация безопасности на OU закрыла доступ к GPO.** Самая частая причина «политика не применяется». Видно только в `gpresult /h` — в консоли `gpupdate` об этом молчит.
- **Настройка loopback только на одном компьютере или в одной ветке OU.** Часть машин получает Computer Configuration из пользовательской политики, часть нет. Расхождение выглядит как «у одного сотрудника работает, у другого нет».
- **Смена модели безопасности с Sysvol на Security с плохим ACL.** После `Change object ownership` на `SYSVOL\domain\Policies` и неверной настройке GPO Folders ломается чтение политик на всех машинах одновременно. Симптом — массовый отказ применения GPO, и лечится `dcdiag /test:sysvol` плюс проверкой ACL на всей цепочке `SYSVOL\domain\Policies`.
- **Клонировал ВМ, попавшую в домен.** Два одинаковых SID, две записи в DNS, Kerberos выдаёт билет не той машине. Правило простое: снятие с домена должно предшествовать снимку.
- **Не настроил блокировку GPO на запись для админов домена.** GPO может удалить любой, у кого есть право на `Edit`. Одно забытое ограничение — и политика безопасности переписана.
- **Синхронизация времени.** Kerberos не прощает расхождения больше 5 минут, и в виртуализированном контуре на Proxmox это встречается после переезда хоста: часы гость отстали, а NTP внутри гостя не настроен.
- **Полный аудит включили постфактум и удивились объёму логов.** Аудит изменений (`5136`) на большом домене пишет десятки тысяч событий в день, и без агента с партиционированием это либо потеря событий, либо переполненный диск. Планируй место заранее.
- **Использовали `netdom` или скрипт для «массовой» правки без выгрузки в LDIF.** Один неверный фильтр — и потеряно членство в группах. `ldifde` перед массовым изменением занимает секунду.
- **Роли FSMO на одном DC без резервного, который в другом сайте.** Потеря этого DC — потеря возможности менять политику домена целиком, даже если в домене есть другие контроллеры.

## Чек-лист понимания

- [ ] Я объясняю разницу между лесом, доменом, сайтом, OU и контроллером домена и знаю, что топология репликации строится по сайтам, а не по расстоянию
- [ ] Я знаю, что такое USN, `versionLastChanged` и вектор версий, умею читать `repadmin /replsummary` и знаю, что означает ненулевой статус
- [ ] Я понимаю, почему DNS-сервер домена обязан быть на контроллере домена, и умею проверить SRV-записи через `nltest /dsgetdc`
- [ ] Я различаю глобальную, доменную локальную и универсальную группу и знаю цену бездумного перевода всех групп в универсальные
- [ ] Я читаю ACL и SDDL, понимаю порядок ACE, разницу между `CI` и `OI` и последствия блокировки наследования
- [ ] Я знаю порядок применения GPO (site → domain → OU, обратный приоритет), объясняю loopback processing и умею диагностировать «политика не применяется» через `gpresult /h`
- [ ] Я понимаю, что такое SYSVOL и NETLOGON, зачем они реплицируются через DFSR, и умею находить клонированные машины с одинаковым SID
- [ ] Я знаю про роли FSMO, регулярные VSS-снимки `NTDS.dit` и выгрузку в LDIF, а по событиям Security нахожу, кто создал учётку, вошёл неудачно и попал в группу администраторов

Дальше — [n8n](devops/24-n8n.md): последний элемент контура, который связывает Active Directory, хранилища и LLM в один процесс.