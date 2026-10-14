# Деплой учебника на VPS

Статический сайт: HTML + CSS + JS. На сервере нужен только nginx.

## Что лежит в папке

| Файл | Где работает | Зачем |
|---|---|---|
| `deploy.ps1` | твой компьютер (PowerShell) | главный скрипт: сборка → архив → scp → развёртывание → проверка |
| `server-setup.sh` | VPS (Linux) | ставит nginx, раскладывает сайт, настраивает конфиг, проверяет результат |
| `nginx.conf` | VPS | конфиг сайта: gzip, кэш, заголовки безопасности, 404 |

## Первый запуск

Нужен доступ по SSH с правами `sudo` и настроенный ключ:

```powershell
ssh root@ТВОЙ_IP
```

Открывается без пароля? Если спрашивает пароль — настрой ключ:

```powershell
ssh-keygen -t ed25519 -C "deploy-uchebnik"
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@ТВОЙ_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

Дальше пробный прогон — ничего не отправляет, только покажет план:

```powershell
.\deploy.ps1 -Server 10.0.0.5 -User root -DryRun
```

Уберился — деплой по-настоящему:

```powershell
.\deploy.ps1 -Server 10.0.0.5 -User root
```

Откроется `http://10.0.0.5/`.

## С доменом и HTTPS

DNS-запись типа A уже должна указывать на IP сервера. Дальше:

```powershell
.\deploy.ps1 -Server dev.example.ru -User root -Email admin@example.ru
```

Скрипт после развёртывания сам выпустит сертификат через certbot и включит
редирект на HTTPS. Проверить автопродление:

```powershell
ssh root@dev.example.ru "certbot renew --dry-run"
```

## Регулярные обновления

```powershell
.\deploy.ps1 -Server 10.0.0.5 -User root -Domain dev.example.ru -Email admin@example.ru
```

Скрипт сам пересоберёт сайт и заменит файлы. Предыдущая версия останется
в `/var/www/uchebnik.previous` — откат одной командой:

```powershell
ssh root@10.0.0.5 "sudo rm -rf /var/www/uchebnik && sudo mv /var/www/uchebnik.previous /var/www/uchebnik && sudo systemctl reload nginx"
```

## Ключи

| Параметр | По умолчанию | Смысл |
|---|---|---|
| `-Server` | обязательный | IP или домен |
| `-User` | `root` | пользователь SSH |
| `-Port` | `22` | порт SSH |
| `-Domain` | — | домен для сертификата |
| `-Email` | — | почта для Let's Encrypt, нужна при `-Domain` |
| `-WebRoot` | `/var/www/uchebnik` | каталог сайта на сервере |
| `-SkipBuild` | выкл | не пересобирать, ехать текущим HTML |
| `-SkipTls` | выкл | не выпускать сертификат |
| `-DryRun` | выкл | показать план, ничего не отправлять |

## Если что-то пошло не так

```powershell
# последние ошибки nginx
ssh root@10.0.0.5 "tail -n 50 /var/log/nginx/uchebnik.error.log"

# кто ходит на сайт
ssh root@10.0.0.5 "tail -n 20 /var/log/nginx/uchebnik.access.log"

# проверка конфига
ssh root@10.0.0.5 "nginx -t"
```

## Что НЕ попадает на сервер

В архив уходят только `index.html`, `lectures/`, `assets/`. Исходники
(`content/*.md`), Python-скрипты и `__pycache__` физически не могут уехать —
скрипт проверяет архив после сборки и падает, если там что-то лишнее.

## Прямой доступ без деплоя

Хочешь просто посмотреть на VPS, что лежит:

```powershell
ssh root@10.0.0.5 "ls -la /var/www/uchebnik"
```