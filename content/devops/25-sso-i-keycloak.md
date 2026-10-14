---
title: Аутентификация для ИИ-сервисов: OIDC, SSO и Keycloak
track: devops
module: G. Зрелость эксплуатации
order: 25
duration: 90 мин
level: senior
tags: [keycloak, oidc, oauth, sso, jwt, токены]
summary: Как дать пять ИИ-сервисам единый вход и общую проверку прав: аутентификация против авторизации, OAuth 2.0 и OpenID Connect, токены и их проверка в сервисе, Keycloak как мост к Active Directory, машинные клиенты и ротация секретов
practice: Разверни Keycloak с Postgres, импортируй realm, в котором клиент шлюза забирает роли из групп AD, сними токен через curl, разбери его payload и включи проверку подписи в FastAPI-шлюзе; затем выключи сеть до контроллера домена и проверь, что именно продолжает работать.
---

Ты администрируешь Active Directory и умеешь раздавать права сотрудникам. Но в контуре LLM-системы живут пять сервисов, и ни один из них не умеет «заходить в домен» — у них нет браузера и нет кнопки «Войти». ЛLM-шлюз общается с RAG-сервисом по HTTP, n8n дёргает шлюз из сценария, телеграм-бот отвечает человеку с телефона, Grafana показывает графики тебе. Пока у каждого свой «кто ты», система держится на паролях в конфигах — а это ровно то, что утекает в Git, в `docker inspect` и в логи CI. Эта лекция закрывает дыру между «у меня есть домен» и «у меня есть современная аутентификация приложений».

## Пять сервисов и пять разных «кто ты»

| Сервис | Кто обращается | Чем доказывает сейчас | Что нужно на самом деле |
| --- | --- | --- | --- |
| LLM-шлюз | RAG-сервис, n8n, бот, дашборд | `Authorization: Bearer <api-key>` в конфиге | машинный клиент с минимальными ролями и ротацией |
| RAG-сервис | шлюз, агенты | тот же ключ на всех | токен со scope и проверкой подписи |
| Grafana | ты из браузера | логин/пароль в Grafana | SSO через домен, без второго пароля |
| n8n | ты из браузера + вебхуки от внешних систем | свой пароль | SSO + отдельный вебхук-токен |
| телеграм-бот | конечный пользователь | токен Telegram, внутри — `user.id` | привязка `user.id` к доменной учётке |

Почему привычные решения не подходят. **Cookie-сессия** привязана к конкретному браузеру: её нельзя предъявить в командной строке, она не переживает смену хоста, а `SameSite` и CSRF-токены превращают каждый сервис-сервис вызов в отдельную задачу по настройке. **Пароль в конфиге** — это секрет, который живёт в Git, в `docker inspect`, в бэкапе и в выдаче `kubectl describe`; его нельзя ротировать, не перезапуская всё. **«Спросим у AD при каждом запросе»** — рабочая идея ровно до первого обращения к домену: LDAP-запрос стоит единицы миллисекунд и десятки, а несут они блокировки на `NTDS.dit`. Дальше — про то, как сделать это правильно один раз.

## Три задачи, которые решает система идентификации

Их часто смешивают, и из этого смешения растут архитектурные ошибки.

| Задача | Вопрос | Кто отвечает | Пример в твоём контуре |
| --- | --- | --- | --- |
| **Аутентификация** | кто ты? | Active Directory, МФУ, ключ клиента | Иванов из `corp` вошёл в Grafana; `svc-rag` предъявил секрет |
| **Авторизация** | что тебе можно? | Keycloak: роли и группы, плюс права в самом приложении | Иванов в группе `LLM-Readers` не видит зарплатные документы; агент читает только свой корпус |
| **Федерация** | кому мы верим? | AD отдаёт аутентификацию, система идентификации хранит свои роли | пароль сотрудника никогда не хранится в Keycloak |

Граница между второй и третьей строкой — главное архитектурное решение. Есть два здоровых варианта: (а) AD — только источник аутентификации, а права живут в Keycloak и назначаются через группы AD; (б) AD — и аутентификация, и источник прав, а приложение проверяет членство в группе напрямую. Вариант (а) даёт тебе одну точку, где видно все права, и возможность добавить «гостей», «сервисные роли» и подрядчиков без правки AD. Вариант (б) проще на старте и быстро превращается в то, что у тебя уже было: список групп, размазанный по коду четырёх сервисов.

## Токены: сессия против токена

Два подхода, которые надо различать, когда говоришь «токен».

| Свойство | Сессионная cookie (opaque) | JWT (self-contained) |
| --- | | --- |
| Что хранится | случайный идентификатор, состояние — на сервере IDP | все claims внутри токена |
| Проверка | каждый вызов — запрос к IDP | локально по подписи и публичному ключу |
| Отзыв | мгновенный: удалил сессию — всё | сложный: либо короткий TTL, либо чёрный список |
| Масштабирование | требует общего хранилища сессий или sticky-сессий | не требует ничего, кроме публичных ключей |
| Масштаб содержимого | нет ограничений | токен не должен разрастаться: группами и ролями без счёта наполнять нельзя |

Практический выбор для LLM-контура: **access token — короткоживущий JWT** (5–15 минут), **сессия — долгоживущая**, и именно она хранится в браузере. Так ты получаешь локальную проверку на каждом сервисе без похода в Keycloak и одновременно короткое окно, за который отозванный пользователь ещё может где-то пройти.

Как устроен JWT и что в нём проверять:

```text
eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleWNsb2FhLWtleS0yMDI2In0  .  <payload>  .  <подпись>

header:    {"alg":"RS256","kid":"keycloak-key-2026","typ":"JWT"}
payload:   {"iss":"https://sso.corp.example.com/realms/corp",
            "sub":"f:a1b2c3d4-…",          # идентификатор пользователя, не почта!
            "aud":["llm-gateway"],         # кому этот токен
            "exp":1760300400, "iat":1760300100, "nbf":1760300100,
            "scope":"openid profile email llm.read",
            "preferred_username":"ivanov",
            "email":"ivanov@corp.example.com",
            "groups":["CN=LLM-Readers,OU=Groups,DC=corp,DC=example,DC=com"],
            "realm_access":{"roles":["llm-reader","rag-user"]}}
signature: RSA-PKCS1-v1_5(private_key_id, header + "." + payload)
```

```python
# /opt/llmops/jwt_read.py — разобрать токен глазами, без проверки подписи
import base64, json, sys, time

def b64d(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))

def peek(token: str) -> dict:
    h, p, _ = token.split(".")
    out = {"header": json.loads(b64d(h)), "claims": json.loads(b64d(p))}
    for k in ("exp", "iat", "nbf"):
        if k in out["claims"]:
            out[k + "_human"] = time.strftime("%H:%M:%S", time.localtime(out["claims"][k]))
    out["ttl_sec"] = out["claims"].get("exp", 0) - int(time.time())
    return out

if __name__ == "__main__":
    print(json.dumps(peek(sys.argv[1].strip()), ensure_ascii=False, indent=2))
```

Три правила проверки, которые надо писать в коде, а не «смотреть глазами»:

- **подпись**. Асимметричная (RS256/ES256): приватный ключ есть только у выпускающего, публичный раздаётся бесплатно через JWKS-эндпоинт. Симметричная (HS256) означает, что секрет общий с каждым проверяющим: утечка у одного потребителя токенов даёт возможность выпускать свои.
- **`exp` обязателен, `aud` проверяется строго.** Токен, выпущенный для `llm-gateway`, не должен приниматься в `rag-service`: иначе скомпрометированный агент, которому выдали токен шлюза, пролезет в RAG. Если в `aud` стоит `account`, значит аудитория не настроена — это надо исправлять в realm, а не отключать проверку.
- **`iss` и `sub`, а не `email`.** Идентификатор пользователя (`sub`) стабилен, почта меняется. Авторизацию по почте ты будешь переписывать.

> [!IMPORTANT]
> Клиентский секрет (а он есть у каждого конфиденциального клиента и у каждого
> сервисного клиента) — это пароль. Он живёт в Vault, в Kubernetes Secrets,
> в systemd-credentials, в `.env` с правами 600 — но не в коде, не в Git и
> не в `docker-compose.yml`, который ты коммитишь. Подробно про хранилища
> секретов — в [лекции о безопасности инфраструктуры](devops/20-bezopasnost-infrastruktury.md).

## OAuth 2.0: роли и поток, без чтения RFC

OAuth — это не «про пароли», а про **делегирование доступа**. Четыре роли:

| Роль | Кто это в твоём контуре |
| --- | --- |
| Resource owner (владелец ресурса) | сотрудник, который нажал «войти» |
| Client (клиент) | приложение, которое просит доступ: Grafana, n8n, CLI-утилита |
| Authorization server | Keycloak — проверяет, выпускает токены |
| Resource server | API, которое принимает токен: шлюз, RAG |

Основной поток — **authorization code + PKCE**. Пользователь уходит на страницу Keycloak, там вводит доменный пароль и MFA, Keycloak возвращает одноразовый короткий код в адресную строку, клиент обменивает его на токены, предъявив код вместе с `code_verifier`. Поток **implicit** (токен прямо в URL) мёртв: токен попадает в историю браузера, в `Referer`, в логи обратного прокси, а в OAuth 2.1 его прямо запретили для публичных клиентов. Не проектируй новое приложение на implicit.

```bash
# шаг 1 — пользователь входит, получает код (здесь запускаем руками)
# https://sso.corp.example.com/realms/corp/protocol/openid-connect/auth?
#   client_id=grafana&response_type=code&scope=openid profile email&
#   redirect_uri=https%3A%2F%2Fgrafana.corp.example.com%2Flogin%2Fgeneric_oauth&
#   code_challenge=<S256 от твоего verifier>&code_challenge_method=S256

# шаг 2 — обмен кода на токены
curl -s -X POST https://sso.corp.example.com/realms/corp/protocol/openid-connect/token \
  -d grant_type=authorization_code \
  -d client_id=grafana \
  -d code=PASTE_CODE_HERE \
  -d redirect_uri=https://grafana.corp.example.com/login/generic_oauth \
  -d code_verifier=<тот самый verifier> | python3 -m json.tool
```

Второй поток, который тебе нужен сильнее первого, — **client credentials**. Пользователя нет, есть только приложение, и токен нужен для вызова API: индексатор шлёт задачу, n8n дёргает шлюз, агент читает свой корпус.

```bash
# машинный клиент: логин = client_id, пароль = client_secret
curl -s -X POST https://sso.corp.example.com/realms/corp/protocol/openid-connect/token \
  -d grant_type=client_credentials \
  -d client_id=svc-rag \
  -d client_secret="$RAG_CLIENT_SECRET" \
  -d scope=llm.read \
  | tee /tmp/rag-token.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["token_type"], "expires_in=", d["expires_in"])'

# сразу смотрим, что внутри
python3 /opt/llmops/jwt_read.py "$(jq -r .access_token /tmp/rag-token.json)"
```

> [!CAUTION]
> В ответе `client_credentials` нет `refresh_token` — и это правильно. Машина
> не «помнит» вход: она получает токен, он истекает, она берёт новый. Поэтому
> срок жизни access token для сервисных клиентов можно делать коротким (5
> минут) без всяких неудобств — обновление происходит автоматически при каждом
> вызове.

## OpenID Connect: слой идентичности поверх OAuth

OAuth сам по себе отвечает на вопрос «что этому клиенту можно», но не «кто этот человек». OpenID Connect — тонкий слой поверх OAuth, который добавляет три вещи: `id_token` с утверждениями об идентичности, стандартный эндпоинт `userinfo` и стандартный набор scopes.

| Токен | Что доказывает | Кому показываем |
| --- | --- | --- |
| `access_token` | «я имею право вызвать API» | API-шлюзу, RAG, другим сервисам |
| `id_token` | «этот человек вошёл и вот кто он» | клиенту для показа имени и сессии |
| `refresh_token` | «продли сессию» | только клиенту, никогда API |

Claims, на которые стоит опираться: `sub` (идентификатор), `preferred_username`, `email`, `groups` (если настроен маппер), `realm_access.roles` (роли realm), плюс кастомные claim'ы вроде `department` или `cost_center`.

```bash
# «кто я» по предъявленному access token, без формы и без пароля
curl -s https://sso.corp.example.com/realms/corp/protocol/openid-connect/userinfo \
  -H "Authorization: Bearer $(jq -r .access_token /tmp/rag-token.json)"
```

Смысл для ИИ-системы такой: **доступ отдельно сотруднику и отдельно сервису** получается сам собой. Сотрудник приходит через `authorization code` и получает `id_token` с `groups`. Сервис приходит через `client credentials` и получает `access_token` без единого `sub`, только `azp` (кто выдал) и `scope`. Код, который различает эти два случая, — это проверка «есть ли в токене `sub` пользователя», а не отдельная сущность «машинный клиент» в базе приложения.

## Keycloak: realm, client, роль, группа

| Сущность | Что это | Типичная ошибка |
| --- | --- | --- |
| Realm | независимая «страна»: свой набор пользователей, ролей, клиентов | завести realm на каждый сервис вместо одного корпоративного |
| Client | приложение, которое может получать токены | завести отдельный клиент на каждую ВМ вместо одного на сервис |
| Role | разрешение, проверяемое в коде | дать роль «всем сотрудникам» и потом разбираться, кто под ней |
| Group | дерево, которое удобно наполнять и по которому удобно фильтровать | путать группу и роль: группа — про людей, роль — про разрешения |
| Flow | набор шагов аутентификации (логин → пароль → MFA) | разрешить регистрацию пользователей в корпоративном realm |

Типы клиентов: **confidential** (серверный, есть секрет: шлюз, RAG, n8n), **public** (браузерное и CLI-приложения, секрета нет, обязателен PKCE), плюс устаревший режим bearer-only для чистого resource server.

Сроки — то, что ты выставляешь в первую очередь:

| Параметр | Разумное значение | Почему |
| --- | --- | --- |
| Access Token Lifespan | 5–15 мин | окно компрометации = время жизни токена |
| SSO Session Idle | 30 мин – 1 ч | «закрыл браузер и ушёл на обед» |
| SSO Session Max | 8–12 ч | граница жизни сессии даже при активности |
| Offline Session Idle / Max | 7–30 сут | сервисы, которым нужен офлайн-доступ |
| Revoke Refresh Token | off | иначе каждое обновление токена требует нового логина |
| Rotate Refresh Token | off (для SPA) / on (для долгих сессий) | компромисс между безопасностью и UX |

Развёртывание для лаборатории:

```yaml
# /opt/llmops/sso/docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: keycloak
      POSTGRES_USER: keycloak
      POSTGRES_PASSWORD: ${KC_DB_PASSWORD:?задай в .env}
    volumes:
      - kc-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U keycloak"]
      interval: 5s
      retries: 20
    restart: unless-stopped

  keycloak:
    image: quay.io/keycloak/keycloak:latest      # в проде — зафиксированный тег версии
    command: start-dev --import-realm             # start-dev только для лаборатории
    environment:
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: ${KC_DB_PASSWORD}
      KC_BOOTSTRAP_ADMIN_USERNAME: ${KC_ADMIN_LOGIN:?задай в .env}
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KC_ADMIN_PASSWORD:?задай в .env}
      KC_HOSTNAME: https://sso.corp.example.com
      KC_PROXY_HEADERS: xforwarded
      KC_HEALTH_ENABLED: "true"
    volumes:
      - ./realm-corp.json:/opt/keycloak/data/import/realm-corp.json:ro
      - kc-data:/opt/keycloak/data
    ports:
      - "127.0.0.1:8080:8080"     # наружу — только через обратный прокси с TLS
    depends_on:
      postgres: {condition: service_healthy}
    restart: unless-stopped

volumes:
  kc-db:
  kc-data:
```

> [!NOTE]
> Названия переменных и флагов менялись между мажорными версиями Keycloak:
> дистрибутив переехал с WildFly на Quarkus (в старых WildFly-сборках был
> `standalone.sh`, сейчас `kc.sh` и `start`/`start-dev`), состав полей в
> realm-экспорте тоже менялся, а в новых версиях до сих пор встречаются вещи,
> объявленные устаревшими. Механизм ниже — стабильный: realm, клиент,
> пользовательский federation-провайдер, мапперы, роли. Конкретные имена
> полей, флагов и версию проверяй по документации **своей** сборки, а
> экспортированный realm храни в Git как источник правды.

Импорт realm — файл в Git, а не ручная настройка в браузере:

```json
{
  "realm": "corp",
  "enabled": true,
  "sslRequired": "all",
  "accessTokenLifespan": 600,
  "ssoSessionIdleTimeout": 1800,
  "ssoSessionMaxLifespan": 28800,
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "duplicateEmailsAllowed": false,
  "roles": {
    "realm": [
      { "name": "llm-reader" },
      { "name": "llm-admin" },
      { "name": "svc-rag" },
      { "name": "svc-indexer" }
    ]
  },
  "clients": [
    {
      "clientId": "llm-gateway",
      "enabled": true,
      "publicClient": false,
      "standardFlowEnabled": true,
      "serviceAccountsEnabled": false,
      "redirectUris": ["https://grafana.corp.example.com/*"],
      "webOrigins": ["https://grafana.corp.example.com"],
      "protocolMappers": [
        {
          "name": "audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.client.audience": "llm-gateway",
            "id.token.claim": "false",
            "access.token.claim": "true"
          }
        }
      ]
    },
    {
      "clientId": "svc-rag",
      "enabled": true,
      "publicClient": false,
      "standardFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": true,
      "defaultClientScopes": ["web-origins", "roles"],
      "protocolMappers": [
        {
          "name": "audience",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.client.audience": "llm-gateway",
            "id.token.claim": "false",
            "access.token.claim": "true"
          }
        }
      ]
    }
  ]
}
```

Обрати внимание на две вещи в этом JSON. `publicClient: false` — серверное приложение, у него есть секрет. И маппер аудитории: без него `aud` в токене будет `account`, и строгая проверка аудитории в шлюзе (см. ниже) отвергнет собственный же токен клиента.

## Мост с Active Directory: главный сценарий

Keycloak умеет три разных вещи по отношению к AD, и их важно не путать:

| Механизм | Что делает | Когда брать |
| --- | --- | --- |
| **User Federation (LDAP)** | AD проверяет пароль, Keycloak хранит профиль и роли, синхронизирует группы | рабочий вариант по умолчанию |
| **Advanced LDAP/Kerberos federation** | аутентификация по Kerberos-билету, `krb5.conf` на узле Keycloak | если нужна SSO и на терминальных серверах |
| **LDAP Import** | разовая выгрузка пользователей, живой связи нет | только для не-SSO сценариев, для «мёртвых» справочников |

Federation — это про аутентификацию. Права — отдельный слой: группа в AD должна превратиться в роль или группу Keycloak, иначе федерация бессмысленна.

```json
{
  "name": "corp-ad",
  "providerId": "ldap",
  "subComponents": [
    {
      "name": "User Storage",
      "providerId": "ldap",
      "subComponents": [
        {
          "name": "LDAP Storage",
          "providerId": "ldap",
          "subComponents": [
            {
              "name": "LDAP mapper",
              "providerId": "hardcoded-ldap-ldap-role-mapper",
              "config": {
                "ldap.role.prefix": "/",
                "ldap.role.suffix": "",
                "member.attribute": "memberOf"
              }
            }
          ]
        }
      ],
      "config": {
        "vendor": ["active-directory"],
        "connectionUrl": "ldaps://dc01.corp.example.com:636",
        "bindDn": "CN=svc-keycloak,OU=ServiceAccounts,DC=corp,DC=example,DC=com",
        "bindCredential": "${KC_AD_BIND_PASSWORD}",
        "startTls": "false",
        "usersDn": "OU=Users,DC=corp,DC=example,DC=com",
        "userLdapFilter": "(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(memberOf=CN=LLM-Users,OU=Groups,DC=corp,DC=example,DC=com)",
        "usernameLdapAttribute": "sAMAccountName",
        "rdnLdapAttribute": "cn",
        "uuidLdapAttribute": "objectGUID",
        "userObjectClasses": ["person", "organizationalPerson", "user"],
        "groupDn": "OU=Groups,DC=corp,DC=example,DC=com",
        "groupLdapFilter": "(objectClass=group)",
        "groupObjectClasses": ["group"],
        "groupsLdapFilter": "(memberOf=CN=LLM-*,OU=Groups,DC=corp,DC=example,DC=com)",
        "membershipLdapAttribute": "member",
        "membershipAttributeType": "DN",
        "membershipUserLdapAttribute": "memberOf",
        "editMode": "READ_ONLY",
        "importUsers": "false",
        "batchSizeForSync": "100",
        "fullSyncPeriod": "86400"
      }
    }
  ]
}
```

Что здесь важно понимать, а не копировать:

- **`ldaps://` или `startTls: true`.** Пароль bind-учётки летит по сети при каждой синхронизации. По обычному `ldap://` его видно в дампе трафика. Это не паранойя — это пароль доменной учётки с доступом к каталогу.
- **Bind-учётка — только чтение нужных OU.** Она участвует в каждом входе. Если у неё права на `OU=Users` целиком, Keycloak сможет (при неверной конфигурации режима записи) менять домен.
- **Фильтр пользователей решает две вещи сразу**: убирает выключенные учётки (иначе заблокированный сотрудник продолжает логиниться, пока пароль совпадает с кэшированным) и оставляет только тех, кому вход в LLM-контур вообще нужен. Импортировать в realm всех 800 сотрудников домена — значит расширить поверхность и усложнить разбор «кто вообще зашёл».
- **`editMode: READ_ONLY`.** Запись обратно в AD нужна только в самых специфических сценариях; для корпоративного контура она почти всегда лишний риск.
- **Маппер ролей** берёт значение атрибута (у AD это `memberOf`) и превращает каждое значение в роль. Если в realm включена синхронизация групп, ты получаешь две параллельные сущности — роль из маппера и группу из групповой синхронизации. Одна из них лишняя; выбери одну и не смешивай в коде.

### Что прилетает из AD и что с этим делать

| Что прилетает | Подводный камень | Решение |
| --- | --- | --- |
| `memberOf` | содержит только **прямые** группы, вложенность теряется | для глубокой вложенности используй `tokenGroups` (но атрибут тяжёлый) |
| `objectGUID` | в AD это двоичный SID, не строка | хранить как `sub` нельзя без преобразования, Keycloak это умеет, но проверь результат |
| `sAMAccountName` | у разных людей бывает одинаковым при разных почтах | логин брать из `userPrincipalName`, а не из почты |
| выключенные учётки | без фильтра продолжают входить | фильтр `userAccountControl` в `userLdapFilter` |
| срок действия пароля/учётки | Keycloak об этом не знает, пока не спросит AD | проверка идёт при каждом входе, но не в момент действия существующего токена |
| 700+ групп в домене | синхронизация забирает всех | `groupsLdapFilter` по префиксу групп |

### Когда AD лежит: сценарий «автоматизация встала»

Это ровно тот случай, из-за которого федерацию надо проектировать заранее.

| Что происходит | Что откажет | Что продолжит работать |
| --- | --- | --- |
| новый вход сотрудника | Keycloak не может проверить пароль в AD, логин падает | уже открытые сессии до `ssoSessionMax` |
| обновление access token | обычно проходит локально по подписи, но часть версий перечитывает пользователя | короткий TTL страхует: чем он меньше, тем быстрее система уходит в «нужен новый вход» |
| `client credentials` для `svc-rag` | **не ходит в AD** | работает, пока жив Keycloak |
| n8n-сценарии, боты, агенты | всё, что берёт токен по `client_credentials` | работает |
| Grafana по SSO | не обновляет сессию, но открытая вкладка живёт | до истечения SSO-сессии |

Отсюда три практических решения, и они ничего не стоят:

1. **Автоматизация не должна ходить по пользовательскому токену.** Сценарий n8n получает токен по `client_credentials` от собственного клиента с минимальной ролью — тогда падение AD не останавливает ни индекс, ни отчёты.
2. **Аварийный вход в обход AD.** Заведи локального пользователя-администратора в realm (он не federated) и держи его пароль в менеджере паролей офлайн. Это тот же приём, что «DSRM» в Windows-домене.
3. **Access token 5 минут, а не час.** Тогда «отвалившийся AD» превращается в «нужно перелогиниться», а не в «час без доступа к RAG».

И одно наблюдение, которое стоит вывести в метрики: доля неуспешных попыток входа в Keycloak, выросшая одновременно с 4625 в [Security-логе AD](devops/23-active-directory.md), означает «упал контроллер домена», а не «атака на SSO». Это разные инциденты с разными ответами.

## LDAP-фильтр в приложении против Keycloak

| Критерий | LDAP-библиотека в приложении | Keycloak как отдельный сервис |
| --- | --- | --- |
| Время до первого входа | часы | 2–4 дня с настройкой федерации |
| Единый вход для 5 сервисов | нет, каждый реализует свой | да, из коробки |
| Отзыв доступа | реализуешь сам, кэш и блокировки | одна кнопка в консоли |
| Токены для машинных клиентов | придётся изобретать | готовый `client_credentials` |
| MFA, WebAuthn, политики паролей | нет | есть, централизованно |
| Стоимость эксплуатации | низкая, пока один сервис | ещё один сервис в дежурство: БД, бэкапы, обновления |
| Утечка при компрометации | пароль домена у разработчика приложения | сервисный секрет без доступа к домену |
| Миграция с другого решения | средняя | средняя |

Правильный ответ: **для одного внутреннего сервиса, который никто не будет открывать наружу, LDAP-фильтр в коде — честный и быстрый выбор**. Он оправдан, пока выполняются три условия: сервис один, пароль к AD лежит в секрет-хранилище, а отзыв доступа устроен как «перезапуск приложения с новым фильтром». Как только появляется второй веб-сервис, требование «войти один раз» или клиент без браузера — начинай с Keycloak, потому что дешевле переехать с одного LDAP-фильтра на Keycloak, чем retrofit-ить SSO в пять самописных реализаций.

## Проверка подписи — в самом сервисе

Три правила, которые надо зафиксировать до первого инциденту:

1. **API проверяет токен сам.** Шлюз может проверить и отдать 401, но сервис за шлюзом обязан проверить тоже. Причины конкретные: внутренний сетевой путь к RAG существует в обход шлюза; проверка у шлюза часто сводится к «заголовок есть», а не к валидной подписи; правила по `scope` и `aud` различаются у разных ресурсов.
2. **Шлюз пробрасывает заголовок.** Если nginx не передаёт `Authorization` дальше, приложение не увидит токен и отвергнет легитимные запросы.
3. **Публичные ключи кэшируются.** Иначе каждый запрос к шлюзу — это запрос к Keycloak, и ты только что построил single point of failure с полной зависимостью от сети.

```nginx
# /etc/nginx/conf.d/llm-api.conf
upstream llm_gateway { server 10.10.10.31:8000; }

location /v1/ {
    proxy_pass http://llm_gateway;
    proxy_set_header Host              $host;
    proxy_set_header Authorization     $http_authorization;   # без этой строки сервис токена не увидит
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_request_buffering off;                              # чтобы стриминг не буферизовался
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

```python
# /opt/llmops/gateway/auth.py — проверка подписи, аудитории и прав
import os, time, jwt
from jwt import PyJWKClient
from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer

KC_ISSUER = os.environ["OIDC_ISSUER"]        # https://sso.corp.example.com/realms/corp
KC_AUDIENCE = os.environ["OIDC_AUDIENCE"]    # llm-gateway
_jwks = PyJWKClient(f"{KC_ISSUER}/protocol/openid-connect/certs", cache_keys=True)
_bearer = HTTPBearer(auto_error=False)

def require_auth(creds = Security(_bearer)) -> dict:
    if creds is None:
        raise HTTPException(401, "missing bearer token")
    try:
        key = _jwks.get_signing_key_from_jwt(creds.credentials)
        claims = jwt.decode(
            creds.credentials,
            key.key,
            algorithms=["RS256"],          # никаких "по договорённости", только перечисленные
            audience=KC_AUDIENCE,          # токен для соседнего сервиса сюда не пройдёт
            issuer=KC_ISSUER,
            leeway=30,                     # терпимость к рассинхрону часов
            options={"require": ["exp", "iat", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(401, f"invalid token: {exc}")
    return claims

def require_scope(claims: dict, *needed: str) -> None:
    have = set(claims.get("scope", "").split())
    if not have.intersection(needed):
        raise HTTPException(403, f"need one of {needed}, have {sorted(have)}")

def require_group(claims: dict, *allowed: str) -> None:
    """Проверка по группам AD. Сравниваем по DN, как их отдаёт AD."""
    groups = set(claims.get("groups", []))
    if not groups.intersection(allowed):
        raise HTTPException(403, f"not a member of {allowed}")
```

```python
# /opt/llmops/gateway/main.py
from fastapi import Depends, FastAPI
from .auth import require_auth, require_scope, require_group

app = FastAPI()

READER_GROUP = "CN=LLM-Readers,OU=Groups,DC=corp,DC=example,DC=com"
ADMIN_GROUP  = "CN=LLM-Admins,OU=Groups,DC=corp,DC=example,DC=com"

@app.post("/v1/chat")
def chat(claims: dict = Depends(require_auth)):
    require_scope(claims, "llm.read")
    return {"sub": claims.get("sub"), "azp": claims.get("azp"), "ok": True}

@app.get("/v1/admin/audit")
def audit(claims: dict = Depends(require_auth)):
    require_scope(claims, "llm.admin")
    require_group(claims, ADMIN_GROUP)     # группы AD — единственный источник «кто главный»
    return {"roles": claims.get("realm_access", {}).get("roles", [])}
```

> [!IMPORTANT]
> Ключевая строка в этой схеме — `sub`. У человека `sub` равен его
> идентификатору, и по нему ты берёшь права на конкретный корпус документов.
> У машинного клиента `sub` — это сервисная учётка (`service-account-...`),
> и по ней ты смотришь `scope`, а не группы. Смешивать эти две ветки в одном
> месте кода нельзя: агент с `llm.read` не должен получать доступ к
> документу только потому, что его `sub` не похож ни на один известный.

### Как ограничивать доступ по группам AD, не сделав всех админами

Три уровня, которые лучше разнести явно:

| Уровень | Механизм | Что защищает |
| --- | --- | --- |
| Кто вообще может войти | фильтр пользователей в federation (`LLM-Users`) | весь контур ИИ-сервисов |
| Что ему можно делать в системе | `scope` в токене + `require_scope` в коде | вызовы шлюза, чтение корпуса |
| Какие документы ему видны | группы в `claims`, фильтр при поиске в RAG | содержимое выдачи |

Третий уровень — самый недооценённый. Собрав один раз `groups` в токене, ты можешь фильтровать выдачу по доступу на каждом запросе, и тогда «сотрудник из другого отдела не видит зарплатные документы» становится свойством шлюза, а не заботой каждого приложения отдельно.

## Сервисные токены: хранение и ротация

| Что | Где живёт | Как ротируется |
| --- | --- | --- |
| секрет клиента `svc-rag` | Vault / K8s Secret / systemd credentials | второй клиент с тем же назначением, переключение, удаление старого |
| токен в памяти процесса | оперативная память, перечитывается при `401` | автоматически, истечение 5 минут |
| токен на диске | **нигде** | — |
| токен в логах | **никогда** — редактируй логгер, а не пиши в конфиг | — |

Ротация в Keycloak делается без остановки сервисов: создаёшь второй секрет или второй клиент с тем же `client_id`-назначением, переключаешь потребителя, удаляешь старый. Короткий TTL делает задачу тривиальной — токен, выпущенный со старым секретом, просто перестанет обновляться через 5 минут, и ты увидишь это по 401 в метриках, а не по инциденту.

Отдельная история — **агент ИИ**. У агента свой клиент, своя роль и своя группа: не больше. Общий клиент шлюза у агента означает, что баг в коде агента или инъекция через промпт дают доступ ко всему корпусу и к биллингу. Правило простое: клиент на единицу ответственности, роль по минимуму, токен — в памяти процесса. Подробно про границы доверия к агенту — в [лекции о безопасности агентов](mlops/14-bezopasnost-agentov.md).

## Сравнение решений

| Критерий | Keycloak | Authentik | Dex | LDAP-фильтр в приложении |
| --- | --- | --- | --- | --- |
| Разворачивается | Java-сервис + БД | Python-сервис + БД + Redis | маленький Go-сервис | одна библиотека |
| Federation с AD | да, из коробки | да, LDAP-источник | да, LDAP-источник | ты сам пишешь |
| SSO для веб-приложений | да, десятки клиентов из коробки | да | да, в основном для Kubernetes | нет |
| Токены для машинных клиентов | да, с ролями и аудиторией | да | да | нет |
| MFA, WebAuthn, TOTP, recovery-ключи | да | да | ограниченно | нет |
| Сложность в эксплуатации | средняя | средняя | низкая | нулевая, пока один сервис |
| Лицензия | Apache 2.0, OSS | OSS | Apache 2.0, OSS | — |
| Когда выбирать | корпоративный контур с AD и несколькими приложениями | если ближе Python-экосистема | кластеры Kubernetes, минимальный IdP | один сервис, без SSO |

## Практика: сквозной сценарий

```bash
cd /opt/llmops/sso && docker compose up -d
docker compose logs -f keycloak | grep -m1 "started in"

# 1. сервисный токен: машина получает доступ
curl -s -X POST http://127.0.0.1:8080/realms/corp/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=svc-rag \
  -d client_secret="$RAG_CLIENT_SECRET" -d scope=llm.read > /tmp/rag-token.json

# 2. что внутри — обязательно смотреть глазами перед тем, как писать проверки
python3 /opt/llmops/jwt_read.py "$(jq -r .access_token /tmp/rag-token.json)"

# 3. запрос к шлюзу с этим токеном
curl -si http://127.0.0.1:8080/v1/chat -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(jq -r .access_token /tmp/rag-token.json)" \
  -d '{"messages":[{"role":"user","content":"проверка"}]}' | head -3

# 4. контрольные проверки: без токена, с мусором и с токеном чужого клиента
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v1/chat
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v1/chat -H 'Authorization: Bearer abc.def.ghi'
TAMPER="$(jq -r .access_token /tmp/rag-token.json | cut -c1-40)x"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/v1/chat -H "Authorization: Bearer $TAMPER"

# 5. экспорт realm после изменений — в Git, это источник правды
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 --realm master --user "$KC_ADMIN_LOGIN" --password "$KC_ADMIN_PASSWORD"
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get realms/corp > realm-corp.backup.json
```

## Где это ломается

- **Режим разработчика в проде.** `start-dev` не проверяет конфигурацию так строго и не даёт гарантий по производительности. Продакшн — это `kc.sh build` и `start --optimized`, собранный образ и зафиксированный тег версии.
- **Отсутствует `aud` в проверке, и это сделали «чтобы заработало».** Токен шлюза принимается RAG-сервисом, у агента появляется лишний путь, и инцидент обнаруживается случайно. Настраивай audience mapper в realm.
- **LDAP по `ldap://` без TLS.** Пароль bind-учётки виден в дампе трафика. Для AD это ещё и риск репликации учётных данных при компрометации сети.
- **Импортировали всех сотрудников домена.** Синхронизация 800 человек и 700 групп ест память и время, а список «кто имеет доступ» перестаёт быть управляемым. Фильтр по группе — обязателен.
- **Права в AD поменяли, а в приложении всё по-старому.** Группы обновляются по расписанию синхронизации, а не мгновенно. Особенно больно для отзыва: уволенный сотрудник живёт в кэше ответов. Лечится версией прав в ключе кэша — ровно приём из [лекции о Redis](devops/22-redis.md).
- **Секрет клиента в `docker-compose.yml` в Git.** Это самая частая находка аудита. Секрет — в `.env`, `.env` — в `.gitignore`, а в репозитории лежит только шаблон.
- **Один Keycloak без бэкапа.** Потеря базы = потеря всех ролей, клиентов и сессий. Бэкап БД Keycloak — в том же расписании, что и остальные ВМ из [лекции о бэкапах](devops/19-backup-i-dr.md).
- **Автоматизация по пользовательскому токену.** Сценарий n8n логинится логином сотрудника, AD падает — встаёт вся автоматизация. Машинный клиент от падения AD не зависит.

## Чек-лист понимания

- [ ] Я различаю аутентификацию, авторизацию и федерацию и могу сказать, где в моём контуре проходит граница между AD и Keycloak
- [ ] Я могу расшифровать JWT и объяснить, что проверяют подпись, `exp`, `iss` и `aud`, и что будет, если `aud` не проверять
- [ ] Я знаю, чем `authorization code + PKCE` отличается от `client credentials` и какой поток нужен сервису, а какой — сотруднику в браузере
- [ ] Я поднял Keycloak с Postgres, импортировал realm и получил токен через `curl`, разобрав его payload
- [ ] Я настроил federation с AD, ограничил выборку группой и проверил, что выключенная учётка не может войти
- [ ] Я проверяю токен подписью внутри сервиса, а не только на шлюзе, и у меня есть тесты на 401 без токена и с подделанным токеном
- [ ] Я ограничил доступ по группам AD отдельной проверкой, а не выдал всем роль администратора «на всякий случай»
- [ ] Я знаю, что происходит с пользовательскими и машинными клиентами, когда AD недоступен, и проверил это, а не предположил

Дальше — [OpenSearch](devops/26-opensearch.md): как искать по тем самым логам, которые теперь пишут все эти сервисы вместе с результатами проверки токенов.