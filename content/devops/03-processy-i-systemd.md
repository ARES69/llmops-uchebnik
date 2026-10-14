---
title: Процессы, сигналы и systemd
track: devops
module: A. Linux и сеть
order: 3
duration: 70 мин
level: junior
tags: [linux, процессы, systemd, journalctl, юниты]
summary: Как устроены процессы в Linux, зачем нужны сигналы и как systemd стал главным инструментом управления сервисами
practice: Напиши systemd-юнит для собственного сервиса-пинга, запусти его, включи автостарт, сломай его намеренно и восстановись через journalctl — разберись, почему systemd-analyze blame показывает медленные юниты.
---

Модуль A почти закончен: ты умеешь читать файлы и права. Осталось главное — понять,
кто и как выполняет работу. Процесс — это исполняемая программа в памяти. `nginx`,
`node`, `python3`, твой bash-скрипт — всё это процессы, и именно ими ты
управляешь системой. В современном Linux управлять ими — значит работать через
systemd, а не через init-скрипты. Лекция даёт тебе полный рабочий юнит: шаблон,
который ты будешь копировать для каждого нового сервиса.
---

## PID, PPID и как устроен процесс

Каждый процесс имеет **PID** — числовой идентификатор, уникальный в момент
времени. У каждого процесса есть родитель — **PPID**. Начиная с PID 1, у каждого
есть родитель: это дерево, корень которого — init-система.

```bash
ps aux                          # все процессы всех пользователей
ps -ef                          # формат с полным командным путём
ps auxf                         # с деревом процессов
pstree -p                       # дерево с PID, нагляднее всего
pstree -sp $$                   # цепочка родителей текущего шелла
ps -o pid,ppid,stat,cmd -p 1    # кто PID 1 (systemd)
ps -ef | grep [j]ournald        # квадратные скобки — не матчится сам grep
```

| Столбец `ps aux` | Что означает |
| --- | --- |
| USER | владелец процесса |
| PID | идентификатор |
| %CPU, %MEM | потребление, нормированное относительно одного ядра |
| VSZ, RSS | виртуальный и резидентный размер в КБ (RSS = сколько в RAM) |
| TTY | терминал, `?` — демон |
| TIME | суммарное время CPU |
| CMD | командная строка |

### top и htop

`top` есть везде, `htop` почти всегда ставится одной командой. Ключ в `top` —
`/` — фильтр по процессам.

```bash
htop                            # сортировка по F6/M, поиск F3, деревья F5
top -p $(pgrep -d, nginx)      # top только по процессам nginx

# в top: Shift+M — по памяти, Shift+P — по CPU, 1 — по ядрам, k — убить PID
# в htop: F5 — tree view, F3 — поиск, F4 — фильтр, F6 — сортировка
```

> [!TIP]
> `pgrep -d, nginx` подставляет список PID через запятую — удобно для `top -p`,
> `kill`, `lsof`. Это короче и надёжнее, чем `grep` по выводу `ps`.

### Состояния процесса

| Состояние | Обозначение | Что значит |
| --- | --- | --- |
| running | R | выполняется на CPU прямо сейчас |
| sleeping | S | ждёт события (I/O, сети, сигнала) — **нормально** для сервера |
| uninterruptible sleep | D | ждёт диска или другого ядерного ресурса; не реагирует даже на SIGKILL |
| stopped | T | остановлен (Ctrl+Z, SIGSTOP) |
| zombie | Z | процесс завершился, но родитель не забрал его статус |

**D-состояние** — причина «сервер завис и не отвечает даже на ping по SSH, при
этом `%CPU` равен нулю». Процесс ждёт ввода-вывода: сломанный RAID, сетевой диск,
перегруженный NFS. `kill -9` не поможет: ядро не может прервать операцию.

**Зомби** — это не «процесс-призрак, который ест ресурсы». Ресурсы он уже
освободил (память и файлы закрыты). Осталась только запись в таблице процессов.
Но если зомби плодится — их тысячи, и таблица процессов переполняется, а новые
процессы не могут запуститься.

> [!IMPORTANT]
> Зомби появляется потому, что родитель не вызвал `wait()`. Ядро не умеет
> убирать записи за родителя — это работа приложения. Для нормальных сервисов
> этим занимается systemd: он всегда `wait()`-ит своих детей. Если у тебя
> тысячи зомби — ищи плохо написанный родительский процесс (свой скрипт на
> bash с `&`, или демон на Python без обработки `SIGCHLD`).

```bash
ps -eo pid,ppid,stat,cmd | awk '$3 ~ /^Z/ {print}'   # найти зомби
# Убить зомби нельзя. Убить можно родителя:
kill -9 <PPID из вывода>
```

> [!CAUTION]
> Никогда не пиши `myapp.sh &` в init-скрипте или в cron. Если скрипт
> запустит фоновый процесс, тот станет зомби и не исчезнет до конца сессии.
> Используй `setsid` или `nohup ... &` с явным перенаправлением вывода.

---

## Сигналы: как ты говоришь процессу «стоп»

Сигнал — это асинхронное уведомление. Процесс его получает и решает сам, что
делать. Это ключевая идея: ядро доставляет сигнал, а поведение определяет
приложение. Именно поэтому `SIGKILL` — крайний случай.

| Номер | Имя | Действие по умолчанию | Что используют |
| --- | --- | --- | --- |
| 1 | SIGHUP | завершение | reload: перечитать конфиг без остановки |
| 2 | SIGINT | завершение | Ctrl+C в терминале |
| 9 | SIGKILL | немедленное завершение, необратимо | ядро, паника, зависший процесс |
| 15 | SIGTERM | завершение | **штатная остановка: слить, закрыть, выйти** |
| 18 | SIGCONT | продолжить | снятие с паузы (`fg` в терминале) |
| 19 | SIGSTOP | останов | пауза, нельзя перехватить |
| 17 | SIGCHLD | — | уведомление родителю: ребёнок изменил состояние |
| 10 | SIGUSR1 | завершение | nginx: переключить в verbose-режим |
| 12 | SIGUSR2 | завершение | nginx: бинарный upgrade без простоя |

### SIGTERM vs SIGKILL — главное различие

`SIGTERM` — это запрос «завершись корректно». Приложение в обработчике должно:
прекратить принимать новые соединения, доработать текущие запросы, сбросить
буферы на диск, закрыть соединения с базой, записать «остановился» в лог.

`SIGKILL` ядро обрабатывает **мгновенно и необратимо** — у процесса нет даже
шанса на обработчик. Приложение падает как есть.

```bash
kill -TERM 1234                      # корректно (по умолчанию именно TERM)
kill 1234                            # то же самое — TERM
kill -KILL 1234                      # жёстко
kill -9 1234                         # то же самое
kill -HUP 1234                       # reload
pkill -TERM -f 'myapp-worker'         # по имени/строке, осторожно с -f
killall -u devops node               # все node от пользователя devops
```

> [!CAUTION]
> Никогда не начинай с `kill -9`. Потеряются несохранённые данные, незакрытые
> транзакции, оборванная репликация. Порядок всегда такой: `TERM` → подождать
> (5-30 секунд) → если не помогло, разобраться почему → и только потом `KILL`.

`pkill -f` ищет по полной командной строке. `pkill -f nginx` в твоём случае
убьёт и балансировщик, и воркеры, и сам скрипт, который печатал слово nginx.
Всегда проверяй, что найдёт, через `pgrep -af 'паттерн'` **до** `pkill`.

```bash
pgrep -af 'nginx: worker'        # сначала посмотреть
pkill -TERM -f 'nginx: worker'   # потом убивать
```

### /proc — файловая система процессов

`/proc` — твой доступ внутрь любого процесса. Всё, что система знает о
процессе, лежит файлами.

```bash
ls /proc/1234/ | head
cat /proc/1234/cmdline | tr '\0' ' '      # реальная командная строка
tr '\0' '\n' < /proc/1234/environ          # переменные окружения (нужен root)
cat /proc/1234/status                      # состояние, память, потоки
cat /proc/1234/io                           # сколько прочитано/записано
ls -l /proc/1234/fd/                       # открытые дескрипторы
cat /proc/1234/cwd                          # где работает
ls -l /proc/1234/exe                        # исполняемый файл
sudo cat /proc/1234/stack                   # стек ядра (для D-состояний)
sudo cat /proc/1234/wchan                   # на чём именно спит
```

> [!NOTE]
> `ls -l /proc/<pid>/fd` — мощнейший инструмент. Именно он лежит в основе
> `lsof`: увидеть открытый дескриптор на удалённый файл можно так:
> `ls -l /proc/*/fd 2>/dev/null | grep '(deleted)'`. Это второй способ найти
> утечку диска из [предыдущей лекции](devops/02-fajlovaya-sistema-i-prava.md).

---

## systemd: почему не init-скрипты

System V init работал так: `/etc/init.d/` с shell-скриптами, `update-rc.d` для
управления автозапуском. Каждый скрипт писался отдельно, каждый делал
`start`/`stop`/`restart` по-своему. Проблемы:

| Проблема SysVinit | Как решает systemd |
| --- | --- |
| Порядок запуска — вручную прописан номерами | зависимости `After=`/`Requires=` |
| Нет контроля: скрипт упал — тишина | автоматический `Restart=` |
| Нет централизованных логов | journald, всё в одном месте |
| Нет лимитов на процесс | `MemoryMax=`, `CPUQuota=` |
| Нет изоляции | cgroups, namespaces |
| Старт: последовательно, медленно | параллельный запуск |

Плюс главное: **журнал**. SysVinit писал логи в `/var/log/` разными форматами;
systemd собирает stdout и stderr всех юнитов в `journald`, с временными метками,
приоритетами и фильтрами.

```bash
systemctl status <unit>        # состояние + последние строки лога
systemctl start|stop|restart <unit>
systemctl reload <unit>        # SIGHUP-эквивалент
systemctl enable|disable <unit>   # автозапуск
systemctl enable --now <unit>     # enable + start одной командой
systemctl is-active|is-enabled <unit>
systemctl list-units --type=service
systemctl cat <unit>               # где файл юнита и что в нём
systemctl daemon-reload             # после правки .service файла
```

> [!IMPORTANT]
> После правки файла юнита `systemctl restart` **не подхватит изменения** —
> нужно `systemctl daemon-reload` (или `sudo systemctl restart` с `--no-reload`).
> Это самая частая причина «я поправил конфиг, а ничего не изменилось».

---

## Структура юнита

Юнит — это INI-файл в трёх секциях. Путь: `/etc/systemd/system/<name>.service`
(для своих сервисов) или `/lib/systemd/system/` (для поставляемых пакетом).

```ini
[Unit]
Description=MyApp API server
Documentation=https://example.com/myapp
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=myapp
Group=myapp
WorkingDirectory=/opt/myapp
Environment=NODE_ENV=production
EnvironmentFile=-/etc/myapp/env
ExecStartPre=/usr/local/bin/myapp-migrate
ExecStart=/usr/local/bin/myapp --config /etc/myapp/config.yaml
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Секция [Unit] — «когда запускать и от чего зависит»

| Директива | Что делает |
| --- | --- |
| `Description=` | описание, видно в `systemctl status` |
| `After=` | запускать **после** указанных юнитов. Не тянет их за собой |
| `Before=` | запускать **до** указанных |
| `Requires=` | если этот юнит не запустится — мой тоже не запустится |
| `Wants=` | мягкая зависимость: попробуем, но не критично |
| `BindsTo=` | строгая: юнит упал → мой тоже падает (с `After=`) |
| `PartOf=` | если родитель перезапустили — меня тоже |
| `Conflicts=` | нельзя запускать одновременно |

> [!CAUTION]
> `After=network.target` — **не то же самое**, что `After=network-online.target`.
> `network.target` означает «сетевой стек поднят», а не «есть IP и шлюз». Если
> приложение при старте делает DNS-резолв или подключается к БД по имени —
> ему нужен `network-online.target` и `Wants=network-online.target`, иначе
> стартует раньше сети и упадёт с `Temporary failure in name resolution`.

### Секция [Service] — «что и как запускать»

| Директива | Что делает | Подводный камень |
| --- | --- | --- |
| `Type=simple` | запустить ExecStart и считать, что всё | процесс должен в foreground |
| `Type=exec` | как simple, но ждёт успешного exec | точнее, чем simple |
| `Type=notify` | процесс сам позвонит systemd по сокету `sd_notify` когда готов | для долгих инициализаций |
| `Type=forking` | процесс демонизируется и уходит в фон | PID не указан — `PIDFile=` |
| `Type=oneshot` | разовая задача, затем юнит inactive | нужен `RemainAfterExit=yes` для enable |
| `User=` / `Group=` | от чьего имени работать | **без этого — root** |
| `Environment=` | переменная окружения | видны в `systemctl show` |
| `EnvironmentFile=` | файл с `KEY=value` | `-` в начале = необязательный |
| `WorkingDirectory=` | cwd процесса | влияет на относительные пути |
| `ExecStartPre=` | выполнить перед стартом, при ошибке — юнит не стартует | для миграций, проверок |
| `ExecStartPost=` | после старта | для регистрации, уведомлений |
| `ExecReload=` | что делать по `systemctl reload` | обычно `kill -HUP $MAINPID` |
| `ExecStopPost=` | выполнить в любом случае при остановке | для уборки |
| `Restart=` | когда перезапускать | `always`, `on-failure`, `on-abnormal` |
| `RestartSec=` | пауза перед рестартом | защита от restart-шторма |
| `TimeoutStopSec=` | сколько ждать SIGTERM перед SIGKILL | 90s по умолчанию |
| `KillSignal=` | какой сигнал слать при остановке | по умолчанию SIGTERM |
| `KillMode=` | что делать с дочерними процессами | `control-group` (дефолт) |
| `MemoryMax=` | лимит памяти (cgroup v2) | превысил — OOM-kill |
| `CPUQuota=` | лимит CPU | `CPUQuota=50%` |
| `LimitNOFILE=` | лимит открытых файлов | **частая причина ошибок в Node/Python** |

> [!IMPORTANT]
> `ExecStart` **не выполняется в shell**. Никаких `&&`, `$VAR`, пайпов, glob-ов.
> `ExecStart=/bin/sh -c "myapp --flag && echo ok"` — это единственный способ, и
> его почти всегда можно избежать, вынеся логику в отдельный скрипт. Подробнее
> — в [лекции про Bash](devops/05-bash-skripty.md).

### Секция [Install] — «включать или нет»

`WantedBy=multi-user.target` — `systemctl enable` создаст симлинк в
`multi-user.target.wants/`. Именно поэтому «включённость» в systemd — это
симлинки: из [лекции про файловую систему](devops/02-fajlovaya-sistema-i-prava.md)
тебе уже знакомо, что такое `sites-enabled` в nginx — идея та же.

```bash
systemctl list-unit-files | grep enabled       # что автозапускается
systemctl list-dependencies --reverse nginx    # кто запустит nginx
```

### Спец-цели

| Цель | Когда |
| --- | --- |
| `multi-user.target` | обычная многопользовательская загрузка |
| `graphical.target` | с графическим интерфейсом |
| `rescue.target` | минимальная загрузка, без сетевых служб |
| `emergency.target` | только shell, чинить systemd |
| `network-online.target` | сеть **с адресом и шлюзом** |

---

## Практика: полный рабочий юнит

Задача — маленький сервис-пинг, который каждые 30 секунд шлёт HTTP-запрос на
целевой URL, пишет результат в лог и падает с ненулевым кодом при ошибке. Это
идеальная полигонная площадка: нет зависимостей, всё видно, ничего не сломаешь.

```bash
# --- 1. пользователь и каталоги ---
sudo useradd --system --home /opt/healthbot --shell /usr/sbin/nologin healthbot
sudo mkdir -p /opt/healthbot /var/log/healthbot /etc/healthbot
sudo chown -R healthbot:healthbot /opt/healthbot /var/log/healthbot

# --- 2. сам сервис ---
sudo tee /opt/healthbot/healthbot.py > /dev/null <<'EOF'
#!/usr/bin/env python3
import os, sys, time, urllib.request, urllib.error

URL   = os.environ["HEALTHBOT_URL"]
STATE = "/var/log/healthbot/state"
LOG   = "/var/log/healthbot/healthbot.log"

def log(msg: str) -> None:
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")

def main() -> int:
    log(f"старт, проверяю {URL}")
    interval = int(os.environ.get("HEALTHBOT_INTERVAL", "30"))
    while True:
        try:
            with urllib.request.urlopen(URL, timeout=10) as r:
                code = r.status
            if code >= 500:
                log(f"DEGRADED: {URL} вернул {code}")
                return 1
            log(f"OK: {URL} -> {code}")
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            log(f"DOWN: {URL} недоступен: {e}")
            return 1
        # короткая пауза, чтобы увидеть процесс в htop
        time.sleep(interval)

if __name__ == "__main__":
    sys.exit(main())
EOF
sudo chown healthbot:healthbot /opt/healthbot/healthbot.py
sudo chmod 755 /opt/healthbot/healthbot.py
```

```bash
# --- 3. файл переменных окружения (секреты — отдельно от кода) ---
sudo tee /etc/healthbot/env > /dev/null <<'EOF'
HEALTHBOT_URL=https://api.example.com/healthz
HEALTHBOT_INTERVAL=30
EOF
sudo chown root:healthbot /etc/healthbot/env
sudo chmod 640 /etc/healthbot/env          # группа читает, остальные — нет
```

Теперь сам юнит:

```bash
sudo tee /etc/systemd/system/healthbot.service > /dev/null <<'EOF'
[Unit]
Description=HealthBot — периодическая проверка целевого сервиса
Documentation=man:systemd.service(5)
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=healthbot
Group=healthbot
WorkingDirectory=/opt/healthbot

# Переменные окружения: два источника — литерал и файл
Environment=PYTHONUNBUFFERED=1
EnvironmentFile=-/etc/healthbot/env

# Проверка перед стартом: если битый Python — юнит не стартует
ExecStartPre=/usr/bin/python3 -c "import urllib.request"

ExecStart=/usr/bin/python3 /opt/healthbot/healthbot.py

# Graceful reload: сервис сам перезапустит цикл
ExecReload=/bin/kill -HUP $MAINPID

Restart=on-failure
RestartSec=10s
TimeoutStopSec=15s

# Ограничения — сервис не сожжет всю машину
MemoryMax=128M
CPUQuota=20%

StandardOutput=journal
StandardError=journal
SyslogIdentifier=healthbot

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now healthbot.service
systemctl status healthbot.service
```

### Разбор построчно — что здесь важно

| Строка | Почему именно так |
| --- | --- |
| `After=network-online.target` | скрипт делает HTTP-запрос, без сети и DNS он упадёт при старте |
| `Wants=network-online.target` | без `Wants` таргет не активируется — `After` сам по себе ничего не тянет |
| `Type=exec` | `simple` не проверяет, что exec вообще удался; `exec` падает на ошибке запуска |
| `User=healthbot` | сервис **не должен** работать от root. Это первое, что спросит аудит |
| `EnvironmentFile=-` | минус = «если файла нет, не падай». Читает `KEY=value`, без `export` |
| `ExecStartPre` | дешёвая проверка: нет Python → понятная ошибка, а не «процесс умер с кодом 127» |
| `Restart=on-failure` | при умышленном `systemctl stop` рестарта не будет — иначе сервис невозможно остановить |
| `RestartSec=10s` | защита от бесконечного цикла «упал → рестарт → упал» каждые 50 мс |
| `TimeoutStopSec=15s` | за это время процесс должен завершиться; иначе SIGKILL |
| `MemoryMax=128M` | утечка памяти убьёт сервис и один узел, а не всю ВМ |
| `SyslogIdentifier=` | искать в `journalctl` по имени, а не по длинной командной строке |

```bash
# проверяем, что всё работает как задумано
systemctl is-active healthbot.service      # active
systemctl is-enabled healthbot.service     # enabled
systemctl show healthbot.service | grep -E 'User|MemoryMax|Restart'
sudo -u healthbot ls /var/log/healthbot/   # права на каталог есть?

# логи — главный инструмент
journalctl -u healthbot.service -n 50          # последние 50 строк
journalctl -u healthbot.service -f             # живое слежение
journalctl -u healthbot.service --since "10 min ago"
journalctl -u healthbot.service -p err         # только ошибки и выше
journalctl -u healthbot.service --since today  # grep по дате: journalctl --list-boots
```

### Намеренно ломаем и чиним

```bash
# 1. сломали: убрали бит исполнения
sudo chmod 644 /opt/healthbot/healthbot.py
sudo systemctl restart healthbot.service
systemctl status healthbot.service   # failed, код 203/EXEC
journalctl -u healthbot.service -n 5

# 2. чиним
sudo chmod 755 /opt/healthbot/healthbot.py
sudo systemctl restart healthbot.service
systemctl is-active healthbot.service

# 3. ломаем мягко: неверный URL (ошибка в данных, не в коде)
sudo sed -i 's|healthz|healthz-typo|' /etc/healthbot/env
sudo systemctl restart healthbot.service
journalctl -u healthbot.service -n 10   # видим DOWN: ... 404
#   важно: Restart=on-failure перезапустит, но это бесконечный цикл

# 4. неверный путь в fstab-подобной правке — проверяем до перезагрузки
sudo systemctl daemon-reload      # после любой правки .service
```

> [!TIP]
> Уровни отладки юнита, которые стоит знать наизусть:
> `systemctl status` (кратко) → `journalctl -u` (подробно) →
> `systemd-analyze verify /etc/systemd/system/healthbot.service`
> (проверка синтаксиса до `daemon-reload`) →
> `systemd-analyze security healthbot.service` (обзор изоляции).

---

## Медленная загрузка: что делать, если система грузится долго

Если `systemd-analyze` показывает десятки секунд, ищи узкое место по
`blame` и `critical-chain`.

```bash
systemd-analyze                          # общая картина
systemd-analyze blame | head -15        # кто дольше всех стартует
systemd-analyze critical-chain          # цепочка, из-за которой всё поздно
systemd-analyze verify /etc/systemd/system/healthbot.service
journalctl -b -p err                    # ошибки текущей загрузки
journalctl --list-boots                  # все загрузки, можно сравнивать
```

| Симптом в `blame` | Причина | Решение |
| --- | --- | --- |
| `NetworkManager-wait-online.service` 30+ с | ждёт сеть, которой не будет | `systemctl disable` или сократить таймаут в `/etc/systemd/NetworkManager/wait-online.conf` |
| `dev-sda.device` | медленный диск, или его вообще нет | проверь `lsblk`, fstab, отодвинь неиспользуемые разделы |
| `systemd-udev-settle` | ожидание всех устройств | отключить, если не нужен |
| Долгий `ExecStartPre` | миграция БД при старте | вынести в отдельный таргет `migration.service`, ждать его явно |

> [!CAUTION]
> Не отключай `NetworkManager-wait-online` на сервере, где сервисы стартуют
> сразу. Лечится правильной зависимостью (`After=network-online.target`),
> а не выпиливанием ожидания. Выигрыш в 30 секунд не стоит сервиса, который
> не поднялся после ребута.

---

## Где это ломается

- **`systemctl restart` без `daemon-reload`.** Правил `.service`, перезапустил —
  ничего не изменилось. systemd работает с кэшем, а не с файлом.
- **`ExecStart` с шеллом-синтаксисом.** `ExecStart=/opt/app/run --flag 2>&1`
  не работает: нет shell, значит нет `2>&1`. Нужен `ExecStart=/bin/sh -c "..."`
  или скрипт-обёртка.
- **Сервис от root без `User=`.** Работает, но это дыра и это вопрос аудита.
  Первый шаг при разборе любого своего сервиса — добавить пользователя.
- **`Restart=always` с `Type=oneshot`.** Юнит без `RemainAfterExit=yes`
  считается завершившимся, и systemd перезапускает его в бесконечном цикле.
- **Фоновый процесс в юните.** `ExecStart=/opt/app/start.sh` с `&` внутри
  скрипта: systemd считает, что процесс завершился, убивает всю cgroup.
  Меняй `Type=` или убирай `&`.
- **Приложение игнорирует SIGTERM.** `TimeoutStopSec` истекает, systemd шлёт
  SIGKILL, несохранённое теряется. Признак в логах: «stopped (killed by
  SIGKILL)» после долгой паузы.
- **Зомби от cron-скриптов.** Регулярка с `&` без `wait`/`setsid` даёт
  накопление зомби. Смотри `ps -eo pid,stat,cmd | awk '$2 ~ /Z/'`.
- **`KillMode=process`.** Иногда встречается в чужих юнитах: убивается только
  главный процесс, а воркеры-дети продолжают жить и держать порт. Правильное
  значение по умолчанию — `control-group`.

## Чек-лист понимания

- [ ] Я могу объяснить разницу между SIGTERM и SIGKILL и назвать случай,
      когда SIGKILL уместен
- [ ] Я умею найти зомби-процесс и понимаю, почему его нельзя убить напрямую
- [ ] Я знаю, что лежит в `/proc/<pid>/` и как через него увидеть реальную
      командную строку и открытые дескрипторы
- [ ] Я различаю `After=`, `Requires=` и `Wants=` и знаю, почему `After=` сам
      по себе ничего не запускает
- [ ] Я понимаю, почему `After=network.target` не подходит для приложения,
      которому нужен DNS
- [ ] Я написал systemd-юнит, запустил его, намеренно сломал и починил, и
      нашёл причину через `journalctl`
- [ ] Я знаю, зачем нужен `daemon-reload` и в каком порядке нажимать кнопки
      при изменении юнита
- [ ] Я могу прочитать `systemd-analyze blame` и сказать, какой юнит тормозит
      загрузку и что с ним делать