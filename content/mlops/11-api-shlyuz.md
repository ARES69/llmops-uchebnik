---
title: API-шлюз для LLM
track: mlops
module: H. LLM и инференс
order: 11
duration: 80 мин
level: senior
tags: [api, шлюз, rate limit, streaming, кэш, биллинг]
summary: Единая точка входа между приложениями и моделями: аутентификация, квоты по токенам, кэш, ретраи с фолбэком, проксирование стриминга через nginx, метрики RED и аудит расхода токенов
practice: Разверни шлюз (LiteLLM Proxy или FastAPI-вариант из лекции) с Redis, настрой rate limit по токенам и потоковый режим за nginx, затем смоделируй всплеск нагрузки и проверь, что приложение получает 429, а не падает. Сними метрики расхода токенов и деньгами в Prometheus.
---

Три предыдущие лекции дали тебе модель, железо и движок. Остался слой, который превращает набор разрозненных вызовов в **систему**: где живут ключи, кто сколько тратит, что происходит, когда провайдер лежит, и как заменить модель, не трогая ни одну строчку в приложениях. Этот слой называют API-шлюзом, и именно его внедряет архитектор — раньше, чем кто-то начнёт подключать к моделям отделы напрямую.

Если ты вынесешь из этой лекции одну вещь — пусть это будет тариф на токены по командам. Всё остальное — техника.

## Зачем нужен шлюз, если есть OpenAI-совместимый API

Контрпример: девять отделов подключились к OpenAI напрямую. Каждый хранит свой ключ. Стоимость выросла в четыре раза, никто не знает где. Провайдер поднял лимит — упали три сервиса. Модель устарела — миграция заняла квартал.

Шлюз превращает девять интеграций в одну и добавляет управляемость.

| Задача | Без шлюза | Со шлюзом |
| --- | --- | --- |
| Смена провайдера или модели | правишь код в каждом приложении, релиз, тесты | меняешь маршрут в конфигурации шлюза |
| Ключи API | у каждого приложения свой, утечка = инцидент | один ключ шлюза в секрет-хранилище, снаружи — свои токены по командам |
| Квоты | никого | «отдел продаж: 5 млн токенов в месяц, 50 RPS» |
| Учёт расходов | счёт провайдера обезличен, кто сколько — неизвестно | построчно: кто, когда, какая модель, сколько токенов, сколько денег |
| Отказоустойчивость | ошибка провайдера = простой | ретрай, фолбэк на другой провайдер или локальную модель |
| Кэш | нет | одинаковые вопросы не тарифицируются повторно |
| Наблюдаемость | метрики разных приложений в разных местах | RED-метрики и расход токенов в одном месте |
| Бюджет | узнаёшь о перерасходе постфактум | жёсткий месячный потолок с алертом на 80 % |

> [!IMPORTANT]
> Цена вопроса — миграция. Ввести шлюз, когда уже есть десять прямых интеграций, почти невозможно: придётся уговаривать все команды одновременно. Ввести его, когда интеграция **одна**, — работа на день. Поэтому первое правило архитектора: шлюз ставится **до** первой интеграции, а не после третьей.

## Что внутри шлюза

Восемь компонентов, и каждый из них — отдельное решение с отдельными граблями.

1. **Аутентификация** — кто из внутренних сервисов пришёл. Обычный `Authorization: Bearer <key>`, ключи хранятся в Vault/Kubernetes Secrets, сравнение — константное время.
2. **Авторизация** — что именно этому ключу можно: какие модели, какой бюджет, какая команда. Один токен на отдел, а не на сервис.
3. **Маршрутизация** — правило выбора модели: «для модели X сначала локальный vLLM, потом облако», «задача дешёвая — маленькая модель».
4. **Rate limiting и квоты** — сколько запросов и сколько **токенов** в секунду и в месяц.
5. **Кэш** — семантический или по точному хешу, с TTL и правилами на персональные данные.
6. **Ретраи и фолбэк** — что делать при 429, 500, таймауте.
7. **Логирование и трассировка** — кто, когда, какая модель, сколько токенов, какая латентность.
8. **Биллинг и квотирование** — токены в деньги, распределение по командам, месячные потолки.

### LiteLLM Proxy или самописный

LiteLLM — де-факто стандартный шлюз: одна библиотека нормализует 100+ провайдеров к единому OpenAI-совместимому интерфейсу, есть готовые rate limit, кэш, бюджеты, трейсинг и метрики Prometheus. Выбор между «взять готовое» и «написать своё» — это выбор между **временем до старта** и **контролем**.

| Критерий | LiteLLM Proxy | Самописный шлюз |
| --- | --- | --- |
| Время до продакшн | **часы** | недели |
| Поддержка новых провайдеров | добавляет мейнтейнер, твоя команда не ждёт | ты сам, вместе с каждой сменой API |
| Гибкость бизнес-правил | ограниченная, свои правила через хуки | **любая** |
| Своя логика (кэш по домену, переписывание промпта) | возможно, но в рамках их API | без ограничений |
| Отладка | чужой код, читать придётся исходники Python | **твой код** |
| Зависимости | большой Python-пакет с кучей зависимостей | **только то, что нужно** |
| Ответственность за инцидент | общая с мейнтейнерами | **твоя** |
| Когда выбирать | старт, стандартные сценарии, команда мала | нестандартная логика, жёсткие требования, команда есть |

Мой совет по умолчанию: **бери LiteLLM**, пока не упёрся в конкретное ограничение. Самописный шлюз — это ещё один сервис в поддержке, с дежурствами, обновлениями безопасности и объяснениями «почему оно упало» в три часа ночи.

```yaml
# config.yaml для LiteLLM Proxy
model_list:
  - model_name: chat-fast                 # имя, которое видят приложения
    litellm_params:
      model: ollama/qwen2.5:7b            # свой локальный движок
      api_base: http://vllm:8000

  - model_name: chat-strong
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL   # для бюджетов и аудита

litellm_settings:
  drop_params: true                       # не отправлять параметры, которых нет у модели
  request_timeout: 120
  num_retries: 2
  cache: true
  cache_type: redis
  redis_host: redis
  redis_port: 6379

router_settings:
  routing_strategy: usage-based-routing-v2 # выбирает модель по реальной задержке и отказам

budgets:
  - budget_name: platform
    monthly_limit: 500                    # жёсткий потолок в долларах
    reset_on: first_of_month

budget_settings:
  enforce_budget: true                    # не превышать, а не только предупреждать
```

```bash
docker run -d --name litellm \
  -p 4000:4000 \
  -v "$(pwd)/config.yaml:/app/config.yaml" \
  -e DATABASE_URL="postgresql://llm:pass@postgres:5432/llm" \
  -e LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY}" \
  ghcr.io/berriai/litellm:main-stable \
  --config /app/config.yaml --port 4000

# Приложение переключается одной переменной — это и было целью
curl -s http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"chat-fast","messages":[{"role":"user","content":"Привет"}]}'
```

## Самописный шлюз на FastAPI: полный рабочий пример

Когда LiteLLM не подходит — нестандартная логика, особые требования к аудиту — шлюз пишется сам. Ниже минимальный, но **рабочий** пример с четырьмя механиками: аутентификация по API-ключу, лимит по токенам через Redis, счёт расхода и проксирование в OpenAI-совместимый endpoint.

```python
# gateway.py — минимальный LLM-шлюз. pip install fastapi uvicorn httpx redis prometheus-client
import os
import time
import hashlib
import secrets
from collections import defaultdict

import httpx
import redis
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from prometheus_client import Counter, Histogram, generate_latest

UPSTREAM = os.getenv("UPSTREAM", "http://localhost:8000")   # vLLM
API_KEY  = os.getenv("GATEWAY_API_KEY")
if not API_KEY:
    raise SystemExit("GATEWAY_API_KEY обязателен")

r = redis.Redis(host="redis", port=6379, decode_responses=True)
app = FastAPI(title="llm-gateway")

REQUESTS = Counter("gw_requests_total", "Запросы к шлюзу", ["team", "model", "status"])
TOKENS   = Counter("gw_tokens_total", "Токены", ["team", "model", "direction"])
LATENCY  = Histogram("gw_latency_seconds", "Латентность", ["team", "model"])
CACHE_HIT = Counter("gw_cache_hits_total", "Попадания в кэш", ["team"])

# месячные лимиты в токенах: team -> лимит
MONTHLY_TOKENS = {"support": 50_000_000, "sales": 20_000_000, "default": 10_000_000}
REQUESTS_PER_MIN = {"support": 600, "sales": 120, "default": 60}
MAX_CONCURRENT = {"support": 32, "sales": 8, "default": 4}
CACHE_TTL = 3600

def month_key() -> str:
    return time.strftime("%Y-%m")

def check_ratelimit(team: str) -> None:
    """Скользящее окно в 60 секунд по числу запросов."""
    rpm = REQUESTS_PER_MIN.get(team, REQUESTS_PER_MIN["default"])
    bucket = f"rl:{team}:{int(time.time() // 60)}"
    if r.incr(bucket) == 1:
        r.expire(bucket, 120)          # TTL длиннее окна: гонки на границе минуты не будет
    if int(r.get(bucket)) > rpm:
        raise HTTPException(status_code=429,
                            detail=f"rate limit: больше {rpm} запросов в минуту")

def check_concurrency(team: str) -> None:
    """Сколько запросов одновременно висит на модели — лимит для батча на GPU."""
    key = f"cc:{team}"
    current = r.get(key) or 0
    if current >= MAX_CONCURRENT.get(team, 8):
        raise HTTPException(status_code=429, detail="concurrency: сервис занят")
    r.incr(key, 60)                    # ключ протухает за минуту без продления

def check_budget(team: str, est_tokens: int) -> None:
    used = int(r.get(f"tokens:{team}:{month_key()}") or 0)
    limit = MONTHLY_TOKENS.get(team, MONTHLY_TOKENS["default"])
    if used + est_tokens > limit:
        raise HTTPException(status_code=429, detail=f"budget: {used + est_tokens} > {limit} токенов")

def record_usage(team: str, model: str, usage: dict) -> None:
    pin, pout = usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
    TOKENS.labels(team, model, "input").inc(pin)
    TOKENS.labels(team, model, "output").inc(pout)
    r.incrby(f"tokens:{team}:{month_key()}", pin + pout)

def cache_key(model: str, body: dict) -> str:
    # Кэшируем только то, что детерминировано: без seed/random и без инструментов.
    payload = {k: body[k] for k in ("messages", "model") if k in body}
    raw = repr(sorted(payload.items(), key=lambda kv: kv[0])) + str(
        (body.get("temperature"), body.get("top_p"), body.get("max_tokens"))
    )
    return "cache:" + hashlib.sha256(raw.encode()).hexdigest()

@app.post("/v1/chat/completions")
async def chat(req: Request):
    # 1. Аутентификация: сравнение константного времени, чтобы не утечь ключ таймингом
    if not secrets.compare_digest(req.headers.get("authorization", ""), f"Bearer {API_KEY}"):
        raise HTTPException(status_code=401, detail="неверный API-ключ")

    body = await req.json()
    team = req.headers.get("x-team", "default")
    model = body.get("model", "unknown")
    started = time.perf_counter()

    try:
        check_ratelimit(team)
        check_concurrency(team)
        est = len(str(body.get("messages", ""))) // 2 + int(body.get("max_tokens") or 512)
        check_budget(team, est)

        # 2. Кэш: точное совпадение промпта + параметров + модели
        ck = cache_key(model, body)
        if not body.get("stream"):
            cached = r.get(ck)
            if cached:
                CACHE_HIT.labels(team).inc()
                return Response(cached, media_type="application/json")

        headers = {"Authorization": f"Bearer {os.getenv('UPSTREAM_KEY', 'EMPTY')}"}

        # 3. Стриминг проксируется байт в байт, буферизацию отключаем на своём уровне
        if body.get("stream"):
            async def proxy_stream():
                async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
                    async with client.stream("POST", f"{UPSTREAM}/v1/chat/completions",
                                             json=body, headers=headers) as resp:
                        async for line in resp.aiter_lines():
                            if line.startswith("data: ") and line.strip() != "data: [DONE]":
                                buf.append(line)
                            yield line.encode() + b"\n"
                REQUESTS.labels(team, model, "200").inc()
                LATENCY.labels(team, model).observe(time.perf_counter() - started)
            return StreamingResponse(proxy_stream(), media_type="text/event-stream",
                                     headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})

        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
            resp = await client.post(f"{UPSTREAM}/v1/chat/completions",
                                     json=body, headers=headers)
        if resp.status_code != 200:
            REQUESTS.labels(team, model, str(resp.status_code)).inc()
            raise HTTPException(status_code=502, detail=resp.text[:200])

        data = resp.json()
        record_usage(team, model, data.get("usage", {}))
        REQUESTS.labels(team, model, "200").inc()
        LATENCY.labels(team, model).observe(time.perf_counter() - started)

        # 4. Аудит: один JSON на запрос, уходит в stdout -> собирается в Loki/ELK
        print({"ts": time.time(), "team": team, "model": model,
               "tokens": data.get("usage", {}), "cache": False,
               "latency": round(time.perf_counter() - started, 3)}, flush=True)

        out = resp.text
        r.setex(ck, CACHE_TTL, out)
        return Response(out, media_type="application/json")

    except HTTPException:
        REQUESTS.labels(team, model, "error").inc()
        raise

@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type="text/plain")

@app.get("/admin/usage")
def usage():
    """Сколько токенов израсходовала каждая команда в этом месяце."""
    mk = month_key()
    return {t: int(r.get(f"tokens:{t}:{mk}") or 0) for t in MONTHLY_TOKENS}
```

```bash
uvicorn gateway:app --host 0.0.0.0 --port 8080 --workers 4
curl -s http://localhost:8080/admin/usage
curl -s http://localhost:8080/metrics | grep '^gw_'
```

Обрати внимание на три детали, которые обычно упускают:

- `secrets.compare_digest` вместо `==` — обычное сравнение строк завершается на первом различии и позволяет подбирать ключ побайтово;
- `X-Accel-Buffering: no` в ответе — страховка на случай, если перед шлюзом стоит прокси, который всё-таки буферизует;
- запись аудита в `print` с `flush=True` — сознательный минимум. В бою это уходит в Loki или ClickHouse, но **строчка аудита появляется раньше, чем метрика агрегируется**, и именно по ней можно восстановить конкретный инцидент.

## Rate limiting: запросы или токены

Обычный rate limit считает запросы в минуту. Для LLM это неверная метрика: один запрос с 50K контекста стоит как пятьдесят запросов с коротким промптом. Ограничивая RPM, ты защищаешься от числа запросов, но не от расхода.

| Способ ограничения | Что защищает | Чего не защищает |
| --- | --- | --- |
| RPM (запросов в минуту) | от парсинга коротких промптов, от флуд-ботов | от одного запроса с 200K контекста |
| TPM (токенов в минуту) | **от расхода денег** | от всплеска, который уложится в лимит, но убьёт latency |
| Дневной/месячный потолок токенов | от накопления перерасхода | от необходимости остановиться ровно в момент месяца |
| Одновременные запросы (concurrency) | от исчерпания батча на GPU | от стоимости длинных ответов |

Правильный набор — **все четыре одновременно**. Медленный скользящий счётчик по токенам плюс быстрый счётчик по запросам плюс месячный потолок плюс лимит параллельности.

Для оценки токенов **до** вызова модели нужен токенизатор. Дёшево и достаточно: `len(prompt) / 4` для английского и `/ 2` для русского, плюс `max_tokens`. Точная оценка не нужна — нужна защита от запроса, который в 100 раз дороже ожидаемого.

> [!IMPORTANT]
> Rate limit нужен **и на клиенте, и на шлюзе**, и это не дублирование. Клиентский нужен, чтобы приложение само переживало 429 и не превращало её в каскад ретраев. Шлюзовой нужен, потому что клиентский лимит обходится одним неверным значением в коде, а у шлюза стоит перед ним. Ограничение на шлюзе — это граница безопасности; ограничение на клиенте — это вежливость.

## Кэш ответов: считаем экономию

Ключ кэша — хеш от **промпта + параметров генерации + имени модели**. Изменение любой части даёт другой ключ. Отсюда важный вывод: `temperature: 0` и одинаковый промпт — идеальный кандидат на кэш; `temperature: 0.9` — нет, потому что ответ каждый раз разный.

```text
key = sha256(model + messages + temperature + top_p + max_tokens + stop)
```

| Что кэшировать | Почему | TTL |
| --- | --- | --- |
| Системные промпты и инструкции | не меняются, повторяются постоянно | сутки |
| Классификация и извлечение полей | детерминированный вход — детерминированный выход | 1–24 часа |
| FAQ-бот с фиксированной базой | 30–60 % вопросов повторяются | до обновления базы |
| RAG-ответы на типовые вопросы | повторяются после обновления индексов | 1–6 часов |
| Персональные данные пользователя | **нельзя** — утечка между пользователями | — |
| Запросы с меняющимися данными (время, курс, статус заказа) | кэш отдаст устаревший ответ | минуты, если очень нужно |
| Ответы с побочными эффектами (отправка письма, вызов API) | повторный вызов выполнит действие дважды | — |

> [!CAUTION]
> Главная ошибка — **кэш без изоляции по пользователю**. Если ключ строится только из промпта, два разных сотрудника с одинаковым вопросом «покажи мою зарплату» получат один и тот же ответ из кэша. Всегда добавляй в ключ идентификатор пользователя или тенанта, либо не кэшируй то, что содержит персональные данные. Второе правило: **никогда не кэшируй запрос, из которого вызываются инструменты с побочными эффектами**.

Экономия считается просто:

```text
    запросов в сутки:            100 000
    доля попаданий в кэш:           35 %
    запросов без кэша:            65 000
    средние токены на запрос:  2 500 (вход) + 400 (выход)
    цена входа:                 0,15 $ за 1M
    цена выхода:                0,60 $ за 1M

    без кэша:   65 000 × (2500/1e6 × 0.15 + 400/1e6 × 0.60) = 65 000 × 0.000615 = 39,98 $
    с кэшем:   те же 39,98 $, но 35 000 запросов отданы бесплатно
    экономия:  ~14,00 $ в сутки = 5 100 $ в год
```

На дешёвой модели это копейки. На флагманском API при 5 миллионах запросов в сутки и 40 % повторов кэш превращается в отдельную статью бюджета — **пять-шесть тысяч евро в месяц**. Это ровно тот расчёт, который стоит показать до того, как внедрять.

## Стриминг через nginx: главная грабля

Стриминг для LLM несущественен технически, но критичен по восприятию: ответ за 30 секунд, пришедший двумя секундами и плавно, воспринимается как мгновенный; тот же ответ, пришедший разом через 30 секунд, — как зависание.

По умолчанию nginx **буферизует ответ** целиком, и стрим превращается в обычный запрос. Три настройки обязательны, а забывают обычно про третью.

```nginx
upstream llm_gateway {
    server 10.10.20.30:8080;
    keepalive 64;
}

server {
    listen 443 ssl http2;
    server_name llm.company.local;

    ssl_certificate     /etc/ssl/certs/llm.pem;
    ssl_certificate_key /etc/ssl/private/llm.key;

    location / {
        proxy_pass http://llm_gateway;
        proxy_http_version 1.1;

        # Обязательно: не буферизовать тело ответа
        proxy_buffering off;
        proxy_cache off;

        # Обязательно: не разрывать соединение на долгий стрим
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;

        # Обязательно: отключить gzip — он тоже накапливает буфер
        gzip off;

        # SSE требует безбуферного апстрима, иначе данные залипают
        proxy_set_header Connection "";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
nginx -t && systemctl reload nginx

# Проверка, что данные действительно идут потоком, а не пачкой в конце
curl -N -s https://llm.company.local/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Team: support" \
  -d '{"model":"chat-fast","stream":true,
       "messages":[{"role":"user","content":"Опиши водопад"}]}' \
  | while IFS= read -r line; do printf '%s  %s\n' "$(date +%H:%M:%S.%3N)" "$line"; done
```

Если таймстемпы равномерно растут — стрим работает. Если все чанки пришли с одной отметкой времени — буферизация, ищи либо `proxy_buffering`, либо gzip, либо апстримный балансировщик (Traefik, HAProxy, AWS ALB) с включённым буфером. **Буфер живёт на каждом прокси в цепочке**, и забыть можно любой из них.

## Наблюдаемость шлюза

Шлюз — идеальное место для метрик, потому что через него проходит 100 % трафика. Набор — это RED (см. [лекцию про метрики](devops/15-monitoring-concepts.md)) плюс три LLM-специфичные метрики.

```yaml
  - job_name: "llm-gateway"
    scrape_interval: 15s
    metrics_path: /metrics
    static_configs:
      - targets: ["llm-gw-1:8080", "llm-gw-2:8080"]
```

| Метрика | Тип | Что показывает | Смотреть на |
| --- | --- | --- | --- |
| `gw_requests_total{team,model,status}` | counter | RPS, доля ошибок | 5xx отдельно от 429: 429 — это работа шлюза, 5xx — инцидент |
| `gw_latency_seconds` | histogram | **время до первого токена** и полная латентность | TTFT p95 важнее полного p95: он определяет ощущение отзывчивости |
| `gw_tokens_total{team,model,direction}` | counter | расход токенов | расход по командам — готовая база для биллинга |
| `gw_cache_hits_total{team}` | counter | эффективность кэша | ниже 10 % — кэш настроен неправильно или бесполезен |
| стоимость в деньгах | вычисляемое | `tokens_input × цена + tokens_output × цена` | против месячного бюджета |

```promql
# RED: ошибки
sum by (status) (rate(gw_requests_total[5m]))

# Латентность до первого токена
histogram_quantile(0.95, sum by (le) (rate(gw_latency_seconds_bucket[5m])))

# Токены в час по командам — «кто жжёт»
sum by (team) (rate(gw_tokens_total[1h]))

# Расход в долларах за сутки (цены зашиты в запрос — проверяй их раз в квартал)
sum(gw_tokens_total{direction="input"}) / 1e6 * 0.15
  + sum(gw_tokens_total{direction="output"}) / 1e6 * 0.60

# Бюджет: сколько осталось в месяце
sum(gw_tokens_total) / 1e6 * 0.5 < monthly_limit

# Эффективность кэша
sum(rate(gw_cache_hits_total[1h]))
  / clamp_min(sum(rate(gw_requests_total[1h])), 0.001)
```

Алерт, который стоит поставить первым, звучит не про латентность, а про деньги: **дневной расход превысил плановый на 50 %**. Он срабатывает за один день, а не за один месяц.

## Аудит: готовая база для отчётности

Аудит-строка отвечает на вопрос, который руководство задаёт первым и который ты иначе не закроешь: **кто, когда, какую модель, сколько токенов и сколько денег**.

```json
{"ts": 1761028800.123, "team": "support", "user": "svc-telegram-bot",
 "model": "chat-fast", "upstream": "ollama/qwen2.5:7b",
 "prompt_tokens": 812, "completion_tokens": 143, "total_tokens": 955,
 "cost_usd": 0.00021, "cached": false, "latency_ms": 2840, "ttft_ms": 320}
```

Практические требования к аудиту:

- **не пиши в аудит сам промпт и ответ** без необходимости — там персональные данные, и аудит сам становится утечкой; пиши хеш и ссылку на запись в отдельном защищённом хранилище;
- **идентификатор пользователя** из токена, а не из тела запроса — иначе клиент подменяет его;
- **сверяй `usage` из ответа провайдера**, а не оценивай — оценки расходятся на десятки процентов;
- **срок хранения определи заранее** и укажи его в политике обработки персональных данных;
- агрегаты считай из журнала отдельным запросом (SQL или ClickHouse), а не пытайся вытащить их из метрик Prometheus: в метриках агрегат потеряет детализацию, а в журнале их нет.

```sql
-- Отчёт за месяц по командам: готовая таблица для совещания
SELECT
  team,
  model,
  count(*)                                   AS requests,
  sum(prompt_tokens) / 1e6                   AS m_in,
  sum(completion_tokens) / 1e6               AS m_out,
  sum(cost_usd)                              AS usd,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
FROM llm_audit
WHERE ts >= date_trunc('month', now())
GROUP BY team, model
ORDER BY usd DESC;
```

## Где это ломается

1. **Приложения подключились напрямую, минуя шлюз.** Потом не свести их вместе в принципе. Шлюз вводится до первой интеграции — либо не вводится никогда.
2. **Считали лимит в запросах в минуту.** Один запрос с 200K контекста проходит лимит и съедает месячный бюджет за сутки. Ограничивать надо токены.
3. **Не считали входные токены при оценке лимита** и пропускали через шлюз промпты с чужими документами на 150K токенов.
4. **Ключи от провайдера лежат в коде приложения.** Утечка ключа = счёт на чужой счёт. Все ключи — только в Vault или в секретах Kubernetes.
5. **Кэш без идентификатора пользователя в ключе.** Одинаковые вопросы разных людей получают один ответ — это утечка персональных данных, а не оптимизация.
6. **Кэш включили для всего подряд**, включая вызовы инструментов с побочными эффектами. Повторный запрос выполнил действие дважды.
7. **`proxy_buffering` не выключили за nginx.** Стриминг не работает, пользователи жалуются на «зависание», а приложение в логах показывает норму — потому что запрос и правда прошёл, просто ответ пришёл целиком.
8. **Забыли про gzip или про балансировщик в цепочке.** nginx настроили правильно, а ALB или Traefik всё равно буферизует. Буфер живёт на каждом прокси.
9. **Ретраи без ограничения по времени и без джиттера.** При падении провайдера 1000 параллельных ретраев усиливают падение и превращают деградацию в полный отказ.
10. **Ретраи без фолбэка на другой провайдер**, потому что «у нас же circuit breaker». Circuit breaker не появится сам: фолбэк по явному правилу — «дешёвые задачи сюда, дорогие туда» — надёжнее.
11. **Гонка при проверке месячного бюджета** (get, потом set). Две команды одновременно видят «лимит не исчерпан» и обе тратят. Счётчик в Redis должен атомарным быть.
12. **Писали аудит с промптами целиком.** Журнал аудита стал второй базой персональных данных, о которой никто не знает, — и источником самой неприятной утечки.
13. **Считали стоимость по своим оценкам токенов.** Расхождение с биллингом провайдера 20–40 % — и объяснить его нечем.
14. **Шлюз без таймаута.** Провийдер завис — твой воркер тоже завис, и через минуту у тебя лежит половина пула воркеров.
15. **Метрики с лейблом `prompt`.** Кардинальность взрывается так же, как в Prometheus из [лекции 16](devops/16-prometheus.md), только у тебя в шлюзе.

## Чек-лист понимания

- [ ] Я умею объяснить, зачем нужен шлюз, и знаю, в какой момент его вводить — до первой интеграции, а не после третьей
- [ ] Я называю все восемь компонентов шлюза и понимаю, какой из них чаще всего забывают
- [ ] Я выбираю между LiteLLM Proxy и самописным шлюзом и обосновываю выбор
- [ ] Я различаю ограничение по запросам и ограничение по токенам и знаю, почему второе важнее для LLM
- [ ] Я знаю, как строится ключ кэша и какой TTL разумный, умею посчитать экономию в деньгах и знаю, что кэшировать категорически нельзя
- [ ] Я настраиваю nginx для SSE: `proxy_buffering off`, длинные таймауты, gzip выключен, и знаю, что буфер есть на каждом прокси в цепочке
- [ ] Я сниму RED-метрики с расходом токенов по командам и веду аудит-лог без самих промптов — по нему собирается отчёт для руководства
- [ ] Я знаю, что делать при 429 (ждать с джиттером), при 5xx (ретрай с ограничением) и при таймауме (фолбэк на другого провайдера)

Дальше — [оценка LLM-систем](mlops/15-ocenka-llm.md): как доказать, что изменения в модели, промпте или шлюзе действительно улучшили продукт, а не просто сдвинули график.