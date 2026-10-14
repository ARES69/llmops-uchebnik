---
title: Безопасность инфраструктуры
track: devops
module: E. Эксплуатация и безопасность
order: 20
duration: 80 мин
level: senior
tags: [безопасность, ssh, firewall, секреты, hardening, аудит]
summary: Минимальный набор контролей, который закрывает реальные риски типового IT-контура: SSH, файрвол, обновления, секреты, доступ и аудит
practice: Переведи доступ на SSH-ключи, закрой входящие соединения правилом «deny по умолчанию», включи unattended-upgrades для security-обновлений, вынеси секреты из Git и пройдись по хосту скриптом проверки из лекции.
---

Предыдущая лекция закончилась мыслью: бэкап без контроля доступа бесполезен. Эта — про то, как контроль доступа поставить. Здесь нет «секретных» приёмов: всё, что ниже, делается за вечер на любом Ubuntu-хосте, который у тебя есть. Разница между уязвимым и нормальным контуром — не в бюджете, а в том, закрыты ли базовые вещи.

## Модель угроз: что мы вообще защищаем

Без модели угроз любая мера безопасности выглядит как «надо бы ещё вот это закрыть». Модель отвечает на вопрос «от кого и от чего». Для типового IT-контура Proxmox + AD + Linux-серверы список короткий:

| Вектор | Цель атакующего | Типичная техника | Контроль |
| --- | --- | --- | --- |
| Внешний доступ | хост, панель гипервизора | перебор SSH, CVE в опубликованной панели | ключи вместо паролей, fail2ban, файрвол, обновления |
| Компрометация ВМ | гостевая ОС | повышение привилегий, злоупотребление sudo | непривилегированные пользователи, sudo с логом, patching |
| Доступ к домену | AD | Kerberoasting, pass-the-hash, слабые пароли, устаревшие протоколы | парольная политика, отключение NTLMv1 и SMBv1, аудит 4624/4625 |
| Доступ к данным | файлы, БД, бэкапы | избыточные права, секреты в Git, бэкап на том же хосте | минимальные права, менеджер секретов, air gap из [прошлой лекции](devops/19-backup-i-dr.md) |
| Supply chain | образы, зависимости, CI | подменённый образ, троян в пакете, утёкший токен CI | сканирование образов, подпись, короткоживущие токены |
| Ransomware | всё сразу | вход через RDP/SSH, затем шифрование бэкапов | MFA, сегментация, immutable-копии, отсутствие общих паролей |

Дальше идём по этим строкам. Одна мысль на всю лекцию: **каждый контроль должен быть либо включён, либо осознанно не включён с записанной причиной**. «Мы не используем fail2ban, потому что у нас VPN-only доступ» — нормально. «Не используем, ну лень» — нет.

## SSH: ключи вместо паролей

Пароль на SSH — это фактор, который можно перебирать автоматически, 24/7, из любой точки мира. Ключ ed25519 перебрать нельзя. Это не «безопаснее на уровне best practice», это смена порядка величины.

```bash
# генерация пары: ed25519 — современный формат, rsa 4096 — если нужен суровой консерватизм
ssh-keygen -t ed25519 -a 100 -C "ops@homelab" -f ~/.ssh/id_ed25519_ops

# копирование открытого ключа на хост
ssh-copy-id -i ~/.ssh/id_ed25519_ops.pub admin@pve01

# проверка входа ДО того, как закрыл пароль
ssh -i ~/.ssh/id_ed25519_ops admin@pve01 'id && hostname'
```

Ключи с passphrase. Тогда в игру вступает агент, и пароль вводится один раз за сессию:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519_ops
ssh-add -l
```

Закрываем пароли и root-вход. Правь `sshd_config` целиком, а не по одной строке — так не останется неучтённых дефолтов:

```bash
# /etc/ssh/sshd_config — ключевое
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AllowGroups sshusers
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2

sshd -t && systemctl reload ssh
```

Пользователя — в отдельную группу, чтобы `AllowGroups` действительно что-то ограничивал:

```bash
usermod -aG sshusers admin
grep -E '^(AllowGroups|AllowUsers)' /etc/ssh/sshd_config
```

`authorized_keys` умеет ограничивать ключ по источнику и по команде. Это недооценённая возможность: ключ для дежурного может быть привязан к подсети и к единственной команде:

```bash
# ~/.ssh/authorized_keys для пользователя monitor
from="10.10.10.0/24",no-agent-forwarding,no-port-forwarding,no-pty,command="/usr/local/bin/metrics-shell" ssh-ed25519 AAAAC3Nza... ops@homelab
```

### Алиасы и bastion

`~/.ssh/config` экономит время и убирает класс ошибок «забыл указать ключ»:

```text
# ~/.ssh/config
Host pve01
  HostName pve01.example.com
  User admin
  IdentityFile ~/.ssh/id_ed25519_ops
  IdentitiesOnly yes
  ServerAliveInterval 60

Host dc01
  HostName dc01.corp.example.com
  User svc_admin
  IdentityFile ~/.ssh/id_ed25519_ops
  IdentitiesOnly yes
  ProxyJump admin@pve01

Host prod
  HostName 10.10.10.44
  User deploy
  IdentityFile ~/.ssh/id_ed25519_deploy
  IdentitiesOnly yes
```

```bash
ssh -i ~/.ssh/id_ed25519_ops pve01        # алиас
ssh dc01                                  # идёт через pve01
ssh -N -D 1080 pve01                      # SOCKS-прокси через bastion
```

> [!NOTE]
> `ProxyJump` требует на бастионе разрешённого форвардинга портов
> (`AllowTcpForwarding yes` или ограниченный `permitopen`).
> Если bastion стоит снаружи, разрешай только конкретные адреса:
> `Match User svc_jump AllowTcpForwarding yes PermitOpen 10.10.10.0/24`.

### Fail2ban

Fail2ban — не защита от целенаправленной атаки. Это бан.ip на N минут после N неудачных попыток. На типовом контуре с ключами он всё равно полезен: убирает основную массу шума в логах, потому что весь мир пытается залогиниться на 22-й порт.

```bash
apt install fail2ban

# /etc/fail2ban/jail.local
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
ignoreip = 127.0.0.1/8 ::1 10.10.10.0/24 192.168.1.0/24

[sshd]
enabled = true
banaction = ufw
maxretry = 4
bantime  = 12h
```

```bash
fail2ban-client status sshd
fail2ban-client get sshd banip
fail2ban-client set sshd unbanip 1.2.3.4
```

## Файрвол: deny по умолчанию

Принцип, который стоит принять без исключений: **входящий трафик по умолчанию запрещён, разрешено — списком**. Обратный порядок («закрыл всё, кроме SSH») всегда оставляет дыру, просто ты её не помнишь.

`ufw` — удобная обёртка над `nftables`. Для одного сервера его достаточно:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow from 10.10.10.0/24 to any port 22 proto tcp comment 'SSH из офиса'
ufw allow from 10.10.10.0/24 to any port 8006 proto tcp comment 'Proxmox UI'
ufw allow from 10.10.10.0/24 to any port 443 proto tcp comment 'HTTPS'
ufw logging medium
ufw enable
ufw status numbered
```

Что реально нужно открывать **наружу** в твоём контуре:

| Порт | Сервис | Нужен ли наружу | Комментарий |
| --- | :---: | --- | --- |
| 22 | SSH | нет, если есть VPN | только из офисной сети или через VPN |
| 8006 | Proxmox UI | нет | открывать наружу — это приглашение сканировать CVE панели |
| 443 | HTTPS (reverse proxy, VPN) | да | единственная точка входа снаружи |
| 1194 | WireGuard | да, если нет 443 | удобная замена «торчащему» SSH |
| 3389 | RDP | **никогда** | не выставлять в интернет ни при каких условиях |
| 53, 139, 445 | DNS, SMB | нет | наружу не открываются никогда |

```bash
# для машин без systemd-timesyncd и с ручным nftables — базовый ruleset
cat >/etc/nftables.conf <<'NFT'
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  set office { type ipv4_addr; flags interval; elements = { 10.10.10.0/24 } }

  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    ip saddr @office tcp dport { 22, 443, 8006 } accept
    ip saddr @office icmp type echo-request accept
    limit rate 5/minute accept
    log prefix "drop-input " level info
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output  { type filter hook output  priority 0; policy accept; }
}
NFT

nft -c -f /etc/nftables.conf && systemctl enable --now nftables
```

> [!IMPORTANT]
> После включения файрвола **не закрывай текущую сессию**. Держи вторую,
> уже установленную SSH-сессию открытой и проверяй новую из неё. Стандартная
> причина «уехал с сервера по таймауту» — правило не применилось, а sshd
> перезапустился.

### Смена портов — честный разбор

SSH на 2222, RDP на 13389, Proxmox UI на 8123. Что это даёт и чего не даёт:

- **даёт**: ~95% автоматических сканеров не найдут сервис и не сгенерируют шум в логах. Для администратора это чистый выигрыш в читаемости журналов;
- **не даёт**: целенаправленная атака не замедляется ни на секунду. Сканеры всего интернета за сутки проверяют все 65 тысяч портов на каждом IP. Скрытый порт — это не контроль безопасности, а фильтр шума.

Вывод: **менять порт можно, но только вместе с ключами, fail2ban и обновлениями, и только если у тебя есть причина — убрать шум**. Как единственная мера — самообман. Как дополнение — разумно. И обязательно предупреди команду: «порт не стандартный» — это информация, которая теряется при смене компьютера.

## Обновления: долг, который тихо растёт

Каждая неделя без патчей — это не «немного отстали», это стек известных уязвимостей, про которые кто-то уже написал эксплойт. Сканирование открытых портов ботнетом занимает минуты, а список актуальных CVE публикуется автоматически.

```bash
apt update && apt list --upgradable
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

```conf
//etc/apt/apt.conf.d/50unattended-upgrades — только security-репозиторий
Unattended-Upgrade::Origins-Pattern {
  "origin=Ubuntu,codename=${distro_codename}-security,label=Ubuntu-Security";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
```

Посмотреть, что система сама предлагает обновить:

```bash
unattended-upgrade --dry-run --debug | grep -E 'Packages that will be upgraded'
journalctl -u unattended-upgrades --since "30 days ago" | tail -40
```

Откладывать обновления — нормально, если это **осознанное окно**, а не «потом посмотрю». План: ежемесячная суббота, автоматическая перезагрузка в 4 утра, уведомление в Telegram по факту установки обновлений из списка `-security`. Аналогично для Windows: Windows Update в режиме «скачивать и устанавливать автоматически», но не перезагружать без окна — DC без предупреждения выключается посреди рабочего дня.

## Секреты: почему `.env` в репозитории — самая частая утечка

Пароль БД, токен API, ключ шифрования. Путь развития почти всегда одинаков: «быстро закину в репозиторий, потом вынесу», «вынесу» не происходит, через полгода репозиторий клонируется подрядчиком, а пароль менялся уже дважды, и непонятно, где его искать. Дальше — инцидент.

Что делать вместо:

| Инструмент | Где живёт секрет | Где видит код | Подходит для |
| --- | --- | --- | --- |
| **Переменные в CI** | в настройках пайплайна, замаскированные | пайплайн, без печати в лог | одноразовые токены CI |
| **SOPS + age** | в Git, но зашифрованные | расшифровывается только раннеру с ключом | конфиги, `.env` в репозитории |
| **HashiCorp Vault** | в отдельном сервисе с ACL и аудитом | приложение по токену с TTL | долгоживущие секреты, несколько сред |
| **Docker/K8s secrets** | в оркестраторе, не в образе | монтируется файлом или env из секрета | контейнерные приложения |
| **Просто переменная окружения на сервере** | в `/etc/косяк.env` с правами 0600 | процесс | одиночный хост, без CI |

```bash
# SOPS: шифруем .env вместе с репозиторием
brew install sops age
age-keygen -o keys.txt
sops --age $(cat keys.txt | grep 'public key' | cut -d: -f2) \
     --encrypt --in-place .env
git add .env && git commit -m "шифрованный конфиг"

# расшифровка перед запуском
sops --decrypt .env > /run/app.env && chmod 600 /run/app.env
```

```yaml
# в пайплайне: расшифровать, не печатая в лог
- name: Decrypt secrets
  run: sops --decrypt .env > /run/secrets.env
  env:
    SOPS_AGE_KEY_FILE: ${{ secrets.AGE_KEY_FILE }}
```

> [!CAUTION]
> Файл `.env`, попавший в историю Git, считается скомпрометированным
> навсегда. Удаление через `git rm` ничего не меняет — секрет остаётся
> в каждом клоне. Ротация обязательна, даже если репозиторий приватный.
> Проверяй историю регулярно: `gitleaks detect --source . --redact` или
> `trufflehog git file://. --only-verified`.

### Ротация

| Секрет | Как часто менять | Как отозвать при компрометации |
| --- | --- | --- |
| Пароль БД приложения | 90 дней | `ALTER ROLE ... PASSWORD`, перезапуск пула |
| SSH-ключ | 6–12 месяцев или при уходе человека | удалить строку из `authorized_keys` |
| Токен CI | при каждом уходе, иначе 90 дней | отозвать токен, выпустить новый |
| Ключ подписи | 1 год | перевыпустить, пересобрать и переподписать образы |
| Пароль доменной учётки | по политике AD | `Reset-Password` + `net user` |

## Минимальные права и sudo

Каждый, кто имеет `root` на сервере, является этим root. Если для задачи нужен только рестарт nginx — не выдавай `NOPASSWD: ALL`.

```bash
# /etc/sudoers.d/deploy — проверяй ВСЕГДА через visudo -c
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx, \
                           /usr/bin/systemctl reload nginx
Defaults timestamp_timeout=5
Defaults log_input,log_output
%sudo ALL=(ALL:ALL) ALL

visudo -c
grep -R "NOPASSWD" /etc/sudoers /etc/sudoers.d/
```

```bash
# кто и когда пользовался sudo — главный источник ответа на "кто это сделал"
journalctl _COMM=sudo --since "7 days ago"
grep -E 'COMMAND=' /var/log/auth.log | tail -50
```

Два принципа для Windows-контура:

- **Администратор домена не сидит в интерактивной сессии постоянно.** Рабочая учётка — обычный пользователь домена, повышение — `runas` или отдельная jump-машина. Тогда компрометация рабочей машины не даёт контроллера домена.
- **Роли назначаются через GPO, а не вручную на каждом ПК.** Проверяемость: `gpresult /r /scope:computer /v` на любой машине покажет, какие политики применились и почему нет.

## Проверка: что делать, когда что-то пошло не так

```bash
# что слушает наружу и кто за этим стоит
ss -ulpn
ss -tulpn | awk 'NR==1 || /LISTEN/'
sudo lsof -i -P -n | grep LISTEN

# успешные входы за сутки
journalctl _COMM=sshd --since "24 hours ago" | grep -E "Accepted|Failed" | \
  awk '{print $1,$2,$3,$9,$11}' | sort | uniq -c | sort -rn | head -20

# подозрительное: входы под root, вход ночью, вход с новых адресов
last -ai | head -30
grep "Accepted password" /var/log/auth.log   # должно быть пусто

# кто ходил по sudo
grep "COMMAND=" /var/log/auth.log | tail -20

# кто когда менял правила и запускал cron
journalctl _COMM=crond --since "7 days ago"
getent passwd | awk -F: '$3==0 {print $1}'   # все учётки с uid 0
```

Что искать в логах входа конкретно: повторяющиеся `Failed password` с одного адреса (перебор), `Accepted` с адреса, которого раньше не было (потерянный ноутбук), вход под `root` вообще (значит, `PermitRootLogin` не применился), сессии длиной в 1 секунду (сканер угадал пароль) и сразу после них `sudo` (эскалация).

## Образы: сканирование уязвимостей в CI

Проверять уязвимости в проде — поздно. Дёшево ловить их на этапе сборки, когда образ ещё никто не видел:

```yaml
# .github/workflows/ci.yml
- name: Trivy — образы и репозиторий
  uses: aquasecurity/trivy-action@0.28.0
  with:
    scan-type: image
    image-ref: ghcr.io/acme/llm-api:${{ github.sha }}
    severity: CRITICAL,HIGH
    ignore-unfixed: true
    exit-code: '1'
```

```bash
# то же локально, до пуша
trivy image --severity HIGH,CRITICAL --exit-code 1 ghcr.io/acme/llm-api:dev
trivy fs --scanners vuln,secret --exit-code 1 .
trivy config .          # проверка Dockerfile и docker-compose: теги, root user, секреты
```

`ignore-unfixed: true` — сознательный компромисс: уязвимости без исправления не роняют пайплайн, но остаются в отчёте. Без этого флага CI превращается в «красный всегда», и его перестают смотреть.

## Windows-контур: пароли, протоколы, аудит

### Парольная политика

```powershell
net accounts
Get-ADDefaultDomainPasswordPolicy | Format-List MinPasswordLength,MinPasswordAge,MaxPasswordAge
```

Разумные значения для небольшого домена: минимум 14 символов, сложность включена, срок 180 дней без вечного требования менять (вечные пароли приучают людей писать `Password123!` на стикера — это хуже, чем ротация). Гораздо эффективнее длины — **MFA на VPN и на административные входы**.

### Отключение устаревших протоколов

```powershell
# SMBv1 — источник WannaCry-подобных атак и EternalBlue
Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force
Get-SmbServerConfiguration | Select-Object EnableSMB1Protocol

# NTLMv1 и LM — нельзя отключить NTLM целиком (живёт в аутентификации AD),
# но можно запретить NTLMv1: уровень 5 = NTLMv2 only
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' `
  -Name LmCompatibilityLevel -Value 5 -Type DWord

# анонимные подключения и пустые сессии
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' `
  -Name RestrictAnonymous -Value 1
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' `
  -Name RestrictAnonymousSAM -Value 1
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters' `
  -Name NullSessionShares -Value ''
```

> [!WARNING]
> `LmCompatibilityLevel = 5` ломает вход старых клиентов и часть legacy-приложений
> (старые принтеры, сканеры, 1С-клиент, некоторые сетевые диски). Проверяй
> на тестовой машине и предупреди пользователей заранее. Откат — тот же
> ключ со значением 3.

### Аудит через метрики

Контроллер домена отдаёт события безопасности, а экспортёр из [лабораторной лекции](devops/18-lab-proxmox-monitoring.md) уже умеет считать их в метрики. Это позволяет видеть картину в Grafana, а не в блокноте:

```promql
# неуспешные входы по 15 минут
sum(increase(ad_failed_logon_total[15m]))

# всплеск неудачных входов — вчерашняя сценария
increase(ad_failed_logon_total[1h]) > 20

# кто и откуда заходит успешно
rate(win_event_4624_count[5m]) by (source_ip)
```

Коды, за которыми стоит настроить оповещения: **4624** (успешный вход), **4625** (неуспешный), **4672** (выданы специальные привилегии — появление админа), **4728/4732/4756** (добавление в группу, в том числе администраторов домена), **4688** (запуск процесса с командной строкой, если включён аудит), **4740** (блокировка учётки), **5145** (доступ к сетевой папке).

## Аудит: что логировать обязательно

Логирование — это уже не «было бы неплохо», а условие расследования. Минимальный набор, который должен вестись везде и никуда не перезаписываться:

| Что логировать | Где | Зачем | Как долго |
| --- | --- | --- | --- |
| Входы (успешные и нет) | `auth.log`, `journalctl -u ssh`, Security (4624/4625) | найти источник компрометации | 6–12 месяцев |
| Изменения прав | AD Security 4728/4732/4756, `sudoers`, ACL Proxmox | кто расширил доступ | 12 месяцев |
| Изменения конфигурации ВМ и сети | Proxmox `/var/log/pve`, `pveproxy` | найти источник изменения | 12 месяцев |
| Доступ к секретам | Vault audit log, CI secret access, чтение `/etc/pve/*.key` | понять, утекли ли ключи | 12 месяцев |
| Действия агентов ИИ | вызовы инструментов, доступ к БД, prompt-лог по policy | агент с доступом к системе — тот же сотрудник с правами, только быстрый | 12 месяцев |
| Изменения бэкапов | PBS-журнал, удаление снимков | ransomware удаляет копии первыми | 12 месяцев |

> [!IMPORTANT]
> Последняя строка — про то, что ждёт тебя в LLMOps. Агент ИИ с доступом к
> внутренним данным и инструментам должен проходить те же правила: минимальные
> права, ограниченный контекст, журнал каждого действия. Иначе через год ты
> не сможешь ответить на вопрос «кто попросил агента удалить эти данные».
> Логирование действий агента — не опция, а часть проектирования системы.

Чтобы логи нельзя было вычистить в одиночку, отправляй их на отдельный узел и запрети учётной записи, с которой работает прод, право их удалять:

```bash
# вход без прав на /var/log, но с правом только на чтение логов
usermod -aG adm svc_app
setfacl -m u:svc_app:r /var/log/auth.log
```

## Где это ломается

- **Закрыл пароли, не проверив вход по ключу.** Классика. Сначала вторая сессия, потом `sshd -t`, потом reload.
- **`AllowUsers admin@10.10.10.0/24` в sshd_config и ты подключаешься с другого адреса.** Подсказка лежит в `journalctl -u ssh` — `Connection closed by authenticating user`, и ты гадаешь дальше.
- **Fail2ban с `ignoreip` на всю свою подсеть.** Защита от ботов ушла, зато легитимный пользователь может вылететь на час и не понять почему.
- **Смена порта как единственная мера.** Успокоение без защиты. Метка «безопасный порт 2222» не является контролем.
- **Ключ без passphrase на ноутбуке.** Пароль от учётной записи — и ключ, и доступ к гипервизору.
- **Секрет в Git плюс `git rm` в следующем коммите.** Секрет остаётся в истории и в каждом клоне. Ротировать, не удалять.
- **Ротация всего сразу.** Попытка поменять пароли всем узлам одновременно заканчивается тем, что половина сервисов теряет доступ. Сначала второй путь доступа, потом смена.
- **Обновления «когда-нибудь».** Накопившийся за полгода объём превращается в ночное окно на 4 часа, в которое никто не готов.
- **Аудит логов без отправки куда-то ещё.** Учётная запись, под которой ты вошёл на взломанный хост, удаляет следы. Логи, которые пишутся туда же, откуда атакуют, — не логи.

## Чек-лист понимания

- [ ] Я назвал основные векторы угроз для своего контура, выбрал контроли против них и записал в журнал, какие сознательно не включил и почему
- [ ] Я захожу на любой свой сервер только по ключу, root по SSH отключён, `AllowGroups` настроен, а `~/.ssh/config` с алиасами и `ProxyJump` существует
- [ ] Я понимаю, что смена порта SSH снижает шум, но не является мерой безопасности, а fail2ban у меня включён и я умею посмотреть список забаненных
- [ ] Мой файрвол по умолчанию **deny inbound**, и наружу открыты только VPN и 443
- [ ] На узлах работает `unattended-upgrades` только по security-репозиторию, с перезагрузкой в окно обслуживания
- [ ] У меня нет секретов в Git: всё зашифровано через SOPS, история проверена gitleaks, ключи у секретов есть только там, где им и надо быть
- [ ] `sudo` выдан по правилам, а не `NOPASSWD: ALL`; я умею найти по логам, кто им пользовался, и одной командой вижу, что слушает наружу (`ss -ulpn`)
- [ ] Я отключил SMBv1 и запретил NTLMv1, а логи входов, изменений прав и доступа к секретам уходят на отдельный узел, недоступный для удаления с прода

Курс DevOps на этом завершён. Все модули — от Linux и сети до наблюдаемости и эксплуатации — собраны в [карте курса](start/01-karta-kursa.md): там видно, что уже пройдено и что идёт дальше. Дальше — трек MLOps, где все эти знания применяются к LLM-системам.