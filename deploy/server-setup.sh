#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# server-setup.sh — однократная настройка VPS под статический учебник.
# Идемпотентен: можно запускать повторно, существующее не ломается.
#
#   sudo bash server-setup.sh <nginx.conf> <site.tar.gz> <webroot> <server_name>
# ---------------------------------------------------------------------------
set -euo pipefail

NGINX_SRC="${1:?нужен путь к nginx.conf}"
TARBALL="${2:?нужен путь к site.tar.gz}"
WEBROOT="${3:-/var/www/uchebnik}"
SERVER_NAME="${4:-uchebnik.local}"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запускай от root: sudo bash $0 ..."
[ -f "$NGINX_SRC" ] || die "нет файла $NGINX_SRC"
[ -f "$TARBALL" ]   || die "нет файла $TARBALL"

# --- 1. nginx -------------------------------------------------------------
if ! command -v nginx >/dev/null 2>&1; then
    log "ставлю nginx"
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq nginx curl
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y -q nginx curl
    elif command -v yum >/dev/null 2>&1; then
        yum install -y -q nginx curl
    else
        die "не знаю пакетный менеджер. Поставь nginx вручную и запусти снова."
    fi
else
    log "nginx уже установлен"
fi

# --- 2. certbot (нужен только если есть домен) ----------------------------
HAS_DOMAIN=0
case "$SERVER_NAME" in
    *.*) HAS_DOMAIN=1 ;;
esac

if [ "$HAS_DOMAIN" = "1" ]; then
    if ! command -v certbot >/dev/null 2>&1; then
        log "ставлю certbot"
        if command -v apt-get >/dev/null 2>&1; then
            export DEBIAN_FRONTEND=noninteractive
            apt-get install -y -qq certbot python3-certbot-nginx
        else
            dnf install -y -q certbot || yum install -y -q certbot
        fi
    else
        log "certbot уже установлен"
    fi
fi

# --- 3. каталоги ----------------------------------------------------------
log "готовлю $WEBROOT"
mkdir -p "$WEBROOT"
# атомарная раскладка: сначала во временный каталог, потом подмена
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$TARBALL" -C "$STAGE"

if [ -f "$WEBROOT/index.html" ]; then
    log "найдена прежняя версия — сохраняю как .previous"
    rm -rf "$WEBROOT.previous"
    cp -a "$WEBROOT" "$WEBROOT.previous"
fi

log "раскладываю сайт (старая версия сохранится на 1 релиз назад)"
find "$WEBROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a "$STAGE/." "$WEBROOT/"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
find "$WEBROOT" -type d -exec chmod 755 {} +
find "$WEBROOT" -type f -exec chmod 644 {} +

# --- 4. конфиг nginx ------------------------------------------------------
SITE_CONF="/etc/nginx/sites-available/uchebnik.conf"
if [ -f "$SITE_CONF" ]; then
    cp -a "$SITE_CONF" "$SITE_CONF.bak"
fi
sed "s/__SERVER_NAME__/$SERVER_NAME/g" "$NGINX_SRC" > "$SITE_CONF"

# дефолтный сайт мешает: наш конфиг использует :80 default_server
if [ -f /etc/nginx/sites-enabled/default ]; then
    log "отключаю стандартный сайт nginx"
    rm -f /etc/nginx/sites-enabled/default
fi

ln -sf "$SITE_CONF" /etc/nginx/sites-enabled/uchebnik.conf

# --- 5. проверка и перезапуск --------------------------------------------
log "проверяю конфигурацию nginx"
if ! nginx -t; then
    warn "конфигурация не прошла проверку — откатываю на предыдущую"
    if [ -f "$SITE_CONF.bak" ]; then
        cp -a "$SITE_CONF.bak" "$SITE_CONF"
        nginx -t && systemctl reload nginx 2>/dev/null || true
    else
        rm -f /etc/nginx/sites-enabled/uchebnik.conf
        [ -f /etc/nginx/sites-enabled/default ] && ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
    fi
    die "nginx не поднялся. Смотри: nginx -t"
fi
Ok "конфигурация валидна"

if command -v systemctl >/dev/null 2>&1; then
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx || systemctl restart nginx
    log "nginx перезапущен"
else
    nginx -s reload || nginx
    log "nginx перезагружен"
fi

# --- 6. firewall ----------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    log "открываю 80/443 в ufw"
    ufw allow 80/tcp  >/dev/null
    ufw allow 443/tcp >/dev/null
fi

# --- 7. проверка что сайт реально отвечает --------------------------------
sleep 1
CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $SERVER_NAME" http://127.0.0.1/ || echo 000)"
if [ "$CODE" = "200" ]; then
    log "сайт отвечает: HTTP $CODE"
else
    warn "сайт не отвечает (HTTP $CODE). Проверь: journalctl -u nginx -n 50 --no-pager"
fi

cat <<EOF

$(printf '\033[1;32m')Готово.$(printf '\033[0m')

  Каталог сайта : $WEBROOT
  Конфиг nginx  : $SITE_CONF
  Прежняя версия: $WEBROOT.previous
  Имя сервера   : $SERVER_NAME

  Дальше:
    - если у тебя домен, выпусти сертификат:
        sudo certbot --nginx -d $SERVER_NAME --redirect
    - перевыпуск по крону (certbot сам это делает, проверь):
        sudo certbot renew --dry-run
    - откат на предыдущую версию:
        sudo rm -rf $WEBROOT && sudo mv $WEBROOT.previous $WEBROOT
        sudo systemctl reload nginx

EOF