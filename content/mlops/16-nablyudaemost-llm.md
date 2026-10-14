---
title: Наблюдаемость LLM-систем
track: mlops
module: J. LLMOps в продакшне
order: 16
duration: 85 мин
level: senior
tags: [observability, tracing, langfuse, openlit, трассировка, метрики качества]
summary: Три уровня наблюдаемости LLM-системы, трассировка каждого запроса, выбор инструмента и выгрузка метрик качества прямо в Prometheus
practice: Подними self-hosted Langfuse, инструментируй свой RAG-ответ через декоратор observe и выдели span на retrieval, выведи метрики доли ответов без цитаты и стоимости запроса в Prometheus, добавь алерт на рост доли ответов без источника.
---

Твой дашборд из [лекции про Prometheus](devops/16-prometheus.md) сейчас показывает красное, когда шлюз отдаёт 5xx, и зелёное, когда система отдаёт уверенную неправду. Это не недоработка дашборда. Это принципиальное свойство LLM-системы: **между «ответ неверен» и «ответа нет» нет технического признака**. Ни один код мониторинга не может отличить выдумку от факта, если ты не дал ему правила проверки.

Значит, наблюдаемость для LLM — это не «ещё один exporter». Это **новый класс сигналов**, и их нужно собирать осознанно. Предыдущая лекция дала способ измерять качество офлайн на golden set. Эта даёт способ видеть качество в продакшне, в реальном времени, по каждому конкретному запросу — и, что важнее для тебя как руководителя, даёт ответ на вопрос «а оно вообще работает?».

## Три уровня наблюдаемости

Разделять метрики на уровни нужно не для красоты архитектуры, а потому что у каждого уровня свой дежурный, свой период и своя реакция. Смешанный дашборд, где рядом лежит `5xx` и «доля галлюцинаций», бесполезен: дежурный ночной смены не может реагировать на качество так же, как на недоступность.

| Уровень | Что измеряем | Примеры метрик | Кто смотрит | Реакция |
| --- | --- | --- | --- | --- |
| **Инфраструктурный** | жив ли контур | rate ошибок шлюза, p95/p99 задержки, загрузка GPU и VRAM, длина очереди инференса, стоимость запроса | дежурный SRE | пайплайн, рестарт, откат |
| **Компонентный** | где именно внутри пайплайна просело | качество retrieval по каждой стадии, число переданных чанков, полнота ответа, доля ответов без цитаты | ML-инженер | промпт, чанкинг, reranker |
| **Продуктовый** | решает ли система задачу бизнеса | доля завершённых задач, повторные формулировки (значит, первый ответ не удовлетворил), CSAT, отток пользователей к ручному каналу | владелец продукта (ты) | приоритет, бюджет, план доработок |

Между уровнями есть жёсткая связь, и она не в пользу «хорошего» нижнего. Плохой retrieval даёт плохое качество, но при этом **ускоряет** ответ (нет времени на генерацию) и снижает стоимость. То есть компонентный и продуктовый уровни могут падать, а инфраструктурный — светиться зелёным и даже показывать ускорение. Это главная причина, по которой нужны все три.

> [!IMPORTANT]
> Алерты ставятся на **всех трёх** уровнях, но с разной реакцией. Инфраструктурный алерт разбудит дежурного. Продуктовый алерт разбудит тебя — но с утренним, а не ночным приоритетом, потому что решение по нему требует данных, а не рефлекса. Не смешивай их в один канал: иначе либо разбудишь ночью без причины, либо уедешь в утренний email.

## Трассировка: что такое trace и почему логов мало

Лог-строка отвечает на вопрос «что было в сообщении». Трассировка отвечает на вопрос **«что система делала, чтобы из этого сообщения получился этот ответ»**. Разница видна на одном примере: агент сделал 7 вызовов модели, дважды переспрашивал пользователя, один раз упал с таймаутом и попробовал другой инструмент. В логах это семь почти одинаковых строк подряд. В трассе это дерево с временами, токенами, стоимостью и результатом каждого шага.

```text
trace 0d8f...  user=u_4412  session=s_19a  env=prod   total=8.3s  cost=$0.0143
├── span  a1  POST /v1/answer                                      0.0 → 8.3s
├── span  b2  intent_classify                    1.9s  in=812   out=12   $0.0003
├── span  c3  rag.retrieve  query="отпуск 14 дней"               0.4 → 2.1s
│   ├── span c3.1 embed_query                     0.4s  in=18    out=0    $0.000002
│   └── span c3.2 vector_search top_k=20                          0.2s  → 20 чанков
├── span  d4  rag.rerank  bge-rer-v2                              2.1 → 2.6s  20 → 5
├── span  e5  llm.generate  gpt-4o-mini  temp=0.1                 2.6 → 8.1s  in=3410 out=214 $0.00071
│   └── span e5.1 provider call                                 2.6 → 8.1s  ttft=1.9s
├── span  f6  citation.validate  schema=v3                        8.1 → 8.2s  ok=true
└── span  g7  guardrails.pii_scan                                 8.2 → 8.3s  pii=0
```

Обязательный минимум в каждом span, иначе трассировка бесполезна: **вход, выход, длительность, модель и её параметры, токены входа и выхода, стоимость, версия кода (git SHA), версия промпта**. Именно последняя пара превращает трассу из любопытного журнала в инструмент расследования: «пользователь пожаловался 12 мая» → находишь его trace → видишь `prompt_version=rag-v7`, `model=gpt-4o-mini-2024-07-18`, `index_snapshot=2025-05-09` → ответ воспроизводим.

## Инструменты: выбор по одному главному критерию

Рынок наблюдаемости LLM консолидировался вокруг OpenTelemetry, и это меняет критерий выбора. Сравнивать надо не по красоте дашборда, а по одному вопросу: **через три года смогу ли я вытащить свои трассы, если поставщик сменится или вообще исчезнет?**

| Инструмент | Трассировка LLM | OpenTelemetry | Самохостинг | Фреймворки | Модель оплаты | Данные |
| --- | :---: | :---: | :---: | --- | --- | --- |
| **Langfuse** | отлично | нативно + OTel-экспорт | да, docker-compose | OpenAI/Anthropic SDK, LangChain, LlamaIndex, ручная разметка | бесплатно OSS; облако от $0 | свои, можно держать в ClickHouse |
| **OpenLIT** | хорошо | нативный OTel-экспорт | да | SDK всех облаков, LangChain, LlamaIndex | бесплатно OSS; облако | свои |
| **Phoenix (Arize)** | отлично (есть eval-интеграция) | OTel | да | OpenTelemetry-инструментация | бесплатно OSS; облако | свои |
| **Helicone** | хорошо (прокси) | частично | да (прокси-подход) | любой HTTP через reverse proxy | OSS + платный облачный gateway | свои, но требуется пропускать трафик через прокси |
| **Braintrust** | отлично | OTel | нет (только облако, enterprise — on-prem по договору) | SDK, eval-фреймворк | платный, по объёму трасс | у вендора |
| **OpenTelemetry Collector** | через семантические конвенции | это и есть OTel | да | что угодно, что умеет OTel | бесплатно OSS | свои (Tempo/Jaeger) |

Как выбирать под свою роль:

- **Хочу быстро увидеть, где просело качество, и не платить за это** → Langfuse self-hosted. Ставится за один `docker compose up`, поддерживает OpenTelemetry-экспорт в Tempo или напрямую в Grafana, умеет показывать трассу рядом с промптом — это ровно тот сценарий разбора, который тебе нужен как владельцу продукта.
- **Хочу единый стандарт и стек уже на OTel** → OpenLIT или Phoenix как OTel-инструментация поверх существующего Collector'а. Плюс: трассы лягут в твой уже знакомый Tempo рядом с микросервисными.
- **Уже всё в Grafana и нет желания тянуть ещё один UI** → Phoenix или OpenLIT с экспортом в Collector → Tempo → Grafana. Отдельный продукт не нужен вообще.
- **Нужна платформа с сильным eval (для команды разработки)** → Braintrust. Оговорка: это вендор-лок, и трассы уезжают к вендору. Для внутреннего проекта, который переживёт твой уход, риск неадекватный.

Разворачиваем Langfuse у себя на Proxmox — это ровно тот случай, когда self-hosted окупается.

```bash
# deploy/observability/docker-compose.yml — Langfuse + ClickHouse + Postgres
# Требования: 4 vCPU, 8 ГБ RAM, 100 ГБ SSD. Клади на ВМ Proxmox, не на Windows AD.
services:
  langfuse:
    image: langfuse/langfuse:3
    restart: unless-stopped
    ports: ["3001:3000"]            # порт наружу закрыт: только из твоей сети
    environment:
      DATABASE_URL: postgresql://lf:lf@postgres:5432/langfuse
      CLICKHOUSE_MIGRATION_URL: clickhouse://clickhouse:9000
      CLICKHOUSE_URL: clickhouse://clickhouse:8123
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: changeme_clickhouse
      LANGFUSE_SALT: "длинная-случайная-строка-из-secrets-менеджера"
      LANGFUSE_SECRET_ENCRYPTION_KEY: "00000000000000000000000000000000"
      TELEMETRY_ENABLED: "false"
    depends_on: [postgres, clickhouse]

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    volumes: ["pgdata:/var/lib/postgresql/data"]
    environment:
      POSTGRES_USER: lf
      POSTGRES_PASSWORD: lf
      POSTGRES_DB: langfuse

  clickhouse:
    image: clickhouse/clickhouse-server:24.8-alpine
    restart: unless-stopped
    volumes: ["chdata:/var/lib/clickhouse"]

volumes: { pgdata: {}, chdata: {} }
```

```bash
docker compose -f deploy/observability/docker-compose.yml up -d
docker compose -f deploy/observability/docker-compose.yml ps
curl -fsS http://localhost:3001/api/public/health | python3 -m json.tool
# дальше: UI на http://<хост>:3001, создай проект и сохрани ключи в секрет-хранилище
```

Ключи (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`) живут в секрет-хранилище, а не в `.env` в репозитории. Это пересекается с материалом про [безопасность агентов](mlops/14-bezopasnost-agentov.md): ключ записи трасс — это ключ, которым можно залить в систему произвольные записи, а ключ чтения показывает чужие персональные данные.

## Подключаем Langfuse к приложению

```python
# app/observability.py — базовая инструментация RAG-ответа
import os
from contextlib import contextmanager

from langfuse import observe, get_client

lf = get_client()      # читает LANGFUSE_HOST / PUBLIC_KEY / SECRET_KEY из окружения

@observe(name="rag.retrieve")          # каждый шаг пайплайна — отдельный span
def retrieve(query: str, top_k: int = 20) -> list[dict]:
    docs = vector_store.search(query, top_k=top_k)
    return docs

@observe(name="rag.rerank")
def rerank(query: str, docs: list[dict], keep: int = 5) -> list[dict]:
    scores = reranker.predict([(query, d["text"]) for d in docs])
    order = sorted(range(len(docs)), key=lambda i: -scores[i])[:keep]
    out = [docs[i] for i in order]
    # Пишем в span то, что потом будешь искать при разборе инцидента
    lf.update_current_observation(
        output={"kept": [d["chunk_id"] for d in out],
                "scores": [round(float(scores[i]), 4) for i in order]},
        metadata={"reranker_version": RERANKER_VERSION, "keep": keep},
    )
    return out

@observe(name="rag.answer", propagate_attributes=True)
def answer(query: str, user_ctx: dict, request_id: str) -> dict:
    lf.update_current_trace(
        user_id=user_ctx["tenant_id"],           # НЕ почта: идентификатор тенанта
        session_id=user_ctx["session_id"],
        tags=["prod", "v" + PROMPT_VERSION],
        metadata={"prompt_version": PROMPT_VERSION, "git_sha": GIT_SHA,
                  "index_snapshot": INDEX_SNAPSHOT},
        input={"query": query},
    )

    with lf.start_as_current_observation(name="intent_classify", input={"query": query}) as s:
        intent = classify(query)
        s.update(output={"intent": intent})

    docs20 = retrieve(query, top_k=20)
    docs5 = rerank(query, docs20, keep=5)
    context = build_context(docs5)

    resp = llm.chat(model=LLM_MODEL,
                    messages=build_messages(query, context),
                    temperature=0.1,
                    max_tokens=800)

    with lf.start_as_current_observation(
        name="llm.generate", model=LLM_MODEL,
        model_parameters={"temperature": 0.1, "max_tokens": 800},
        input=messages_preview(query, context),          # усечённый контекст!
        output=resp.text,
        usage_details={"input": resp.usage.prompt_tokens,
                       "output": resp.usage.completion_tokens},
    ) as gen:
        gen.update(metadata={"ttft_ms": resp.ttft_ms, "finish_reason": resp.finish_reason})

    validate_citations(resp.raw)          # проверка схемы и цитат — тоже span
    return resp.raw
```

Три решения в этом коде, на которых обычно спотыкаются:

1. **`tags=["prod", "v"+PROMPT_VERSION]` и `metadata` с git SHA** — без них через месяц ты не отличишь трассу эксперимента от прода. Разбор инцидента превращается в гадание.
2. **Вход генерации усечён.** Полный контекст на 8000 токенов в трассу писать нельзя: трассы становятся дорогими, а данные — потенциально чувствительными. Пиши метаданные (сколько чанков, какие id, сколько токенов) и первые N символов.
3. **Стоимость считает сам SDK**, если передать `usage_details` и цену модели в настройках проекта. Не вычисляй стоимость вручную в коде — она расползётся по версиям моделей и станет неверной через месяц.

> [!NOTE]
> В Langfuse v2 API назывался `start_span` / `start_generation`, в v3 — `start_as_current_observation` с полями `model`, `model_parameters`, `usage_details`. Если копируешь пример из интернета, проверь версию SDK: `pip show langfuse`. Миграция v2 → v3 меняет все точки вызова, но не смысл.

## Что смотреть в трассе конкретно

Трасса — это не «лог подробнее». В ней есть вещи, которых **нет больше нигде**, и именно они отвечают на вопросы, ради которых ты сюда пришёл.

| Вопрос | Где смотреть в трассе | Типичная причина |
| --- | --- | --- |
| «Почему ответ такой длинный?» | `usage.output` в span генерации | не задан `max_tokens`, модель «разговорилась» |
| «Почему ответ не про то?» | список чанков в span `retrieval` + их `scores` в `rerank` | reranker понизил нужный документ; фильтр по метаданным отсёк верные |
| «Откуда взялась цифра?» | текст цитаты в ответе и `chunk_id` источника | rerank-порог слишком мягкий: слабый источник не отсечён |
| «Почему так долго?» | длительности span'ов | `retrieve` 2.1 с — идёт в БД, а не в векторный индекс; индекс на HDD |
| «Почему система позвала модель 7 раз?» | дерево span'ов агента | цикл не ограничен, нет детектора повторов; нужен `max_steps` |
| «Это была новая версия?» | `tags` и `metadata.git_sha` | вторая версия уехала в прод без тега — и её не найти |

Три приёма, которые экономят часы:

- **Сравнение двух трасс.** Langfuse умеет показывать diff двух наблюдений — берешь одну и ту же проблему до и после релиза и видишь, что именно изменилось. Это самый быстрый способ проверить гипотезу «мы ничего не меняли, но стало хуже».
- **Фильтр по тегам и по категории вопроса.** Если в разметке трасс есть `intent_category`, ты можешь построить график качества по категориям прямо в UI, не дожидаясь батчинга в Prometheus.
- **Сэмплирование.** 100% трассирования быстро съедает бюджет. Практика: 100% ошибок и медленных запросов + 10% остальных + 100% запросов от внутренних тестовых аккаунтов.

## Персональные данные в трассах: маскирование обязательно

Логи наблюдаемости — это новая, часто не учтённая точка утечки. Обычно их не вносят в перечень персональных данных, потому что «это же логи», а потом через полгода аудитор находит в трейсе полный текст обращения с номером паспорта. Маскирование должно быть в коде, до отправки, а не в настройках интерфейса.

```python
# app/masking.py — маскирование ДО отправки в Langfuse/OTel
import re, hashlib
from typing import Any

RULES = [
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b"), "[EMAIL]"),
    (re.compile(r"\+?\7?\d{3}[- ]?\d{3}[- ]?\d{2}[- ]?\d{2}\b"), "[PHONE]"),
    (re.compile(r"\b\d{3}[- ]?\d{3}[- ]?\d{2}[- ]?\d{2}[- ]?\d{2}\b"), "[CARD]"),
    (re.compile(r"\b\d{4}[\s-]?\d{2}[\s-]?\d{2}([\s-]?\d{2,4})?\b"), "[DOC_ID]"),
    (re.compile(r"\bИНН\s?\d{10,12}\b|\bСНИЛС\s?\d{3}[- ]?\d{3}[- ]?\d{3}[- ]?\d{2}\b", re.I), "[RU_ID]"),
    (re.compile(r"(?i)\b(пароль|pwd|token|api[_-]?key|secret)\b\s*[:=]\s*\S+"), r"\1=[REDACTED]"),
]

def mask_text(text: str) -> str:
    out = text or ""
    for rx, repl in RULES:
        out = rx.sub(repl, out)
    return out

def stable_pseudonym(value: str, salt: str) -> str:
    """Псевдоним, по которому трассы одного пользователя можно связать между собой.
       Необратимый, но стабильный — в отличие от хеша без соли, который ломается
       при ротации соли и ломает всю историю разбора."""
    return "u_" + hashlib.sha256((salt + value).encode()).hexdigest()[:12]

def mask_any(obj: Any, salt: str) -> Any:
    if isinstance(obj, str):
        return mask_text(obj)
    if isinstance(obj, dict):
        return {k: (stable_pseudonym(v, salt) if k in {"user_id", "email"} else mask_any(v, salt))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask_any(x, salt) for x in obj]
    return obj
```

Правила эксплуатации, которые оформляются не кодом, а регламентом:

- срок хранения трасс задаётся явно (обычно 30–90 дней) и стирается по расписанию, а не «когда кончится место»;
- доступ к трассам — отдельная роль, читать их может тот, кто чинит инцидент, а не вся команда;
- маскирование проверяется тестом: в наборе примеров есть заведомо персональные строки, и в CI проверяется, что ни одна не утекла;
- **вход и выход агента** маскируются отдельно: там чаще всего «протекает» системная инструкция или содержимое внутреннего документа, а не пользовательские данные.

## От трасс к метрикам: мостик в Prometheus

Трассы отвечают на вопрос «почему вот этот запрос». Метрики отвечают на вопрос «что происходит с системой в целом». Вторые нужны для дашборда и алертов, и они должны лежать рядом с инфраструктурными, а не в отдельном мире.

Хорошая новость: метрики качества — это **обычные временные ряды**. Никакой новой сущности в Prometheus не появляется, меняется только то, что мы измеряем.

```python
# app/metrics.py — метрики качества как обычные счётчики и гистограммы
from prometheus_client import Counter, Histogram, Gauge, Info

NORMALIZED = lambda v: v.replace(".", "_").replace("-", "_")

REQUEST_TOTAL = Counter(
    "llm_answer_total", "Все ответы LLM-системы",
    ["category", "model", "prompt_version", "has_citation", "refused"])

TOKENS = Histogram(
    "llm_tokens", "Токены на запрос",
    ["stage", "model"], buckets=(100, 500, 1000, 2000, 4000, 8000, 16000, 32000))

COST = Histogram(
    "llm_request_cost_usd", "Стоимость одного запроса, $",
    ["model"], buckets=(0.0001, 0.0005, 0.001, 0.003, 0.01, 0.03, 0.1))

TTFT = Histogram(
    "llm_ttft_seconds", "Время до первого токена",
    ["model"], buckets=(0.2, 0.5, 1, 2, 4, 8, 15))

CONTEXT_CHUNKS = Histogram(
    "llm_rag_chunks_returned", "Сколько чанков ушло в контекст",
    buckets=(0, 3, 5, 8, 12, 20, 30))

UNSUPPORTED = Counter(
    "llm_unsupported_claim_total", "Утверждения без опоры на источник (по данным LLM-судьи в проде)",
    ["category", "model"])

HALLUCINATION_GAUGE = Gauge(
    "llm_judge_sample_score", "Оценка случайной выборки ответов судьёй (окно 1 ч)", ["model"])

BUILD_INFO = Info("llm_build", "Версия кода и промптов")

def record_answer(*, category: str, model: str, prompt_version: str,
                  has_citation: bool, refused: bool) -> None:
    REQUEST_TOTAL.labels(category, model, prompt_version,
                         str(has_citation).lower(), str(refused).lower()).inc()

def record_llm_call(*, model: str, usage, cost_usd: float, ttft_s: float) -> None:
    TOKENS.labels("input", model).observe(usage.prompt_tokens)
    TOKENS.labels("output", model).observe(usage.completion_tokens)
    COST.labels(model).observe(cost_usd)
    TTFT.labels(model).observe(ttft_s)

def record_retrieval(n_chunks: int) -> None:
    CONTEXT_CHUNKS.observe(n_chunks)

# вызывается из middleware рядом с observe()-декоратором
BUILD_INFO.info({"git_sha": GIT_SHA, "prompt_version": PROMPT_VERSION,
                 "index_snapshot": INDEX_SNAPSHOT})
```

```yaml
# prometheus/rules/llm-quality.yml — качество как алерты, а не как графики
groups:
  - name: llm-quality
    rules:
      # 1. Ответы без источника — прямое следствие деградации retrieval или RAG
      - alert: LLMCitationRateDrop
        expr: |
          sum by (model) (rate(llm_answer_total{has_citation="true"}[30m]))
          / clamp_min(sum by (model) (rate(llm_answer_total[30m])), 0.001) < 0.80
        for: 20m
        labels: {severity: warning, owner: ml}
        annotations:
          summary: "Доля ответов со ссылкой на источник упала ниже 80%"
          runbook_url: "https://wiki.internal/runbooks/llm-citation"

      # 2. Откат релиза: новая версия даёт больше выдумок, чем старая
      - alert: LLMQualityRegression
        expr: |
          increase(llm_unsupported_claim_total{prompt_version="{{ $labels.prompt_version }}"}[2h])
          / clamp_min(increase(llm_answer_total[2h]), 1) > 0.15
        for: 15m
        labels: {severity: critical, owner: ml}
        annotations:
          summary: "Версия промпта {{ $labels.prompt_version }} даёт >15% неподкреплённых утверждений"

      # 3. Стоимость: рост в 2 раза за час — почти всегда утечка контекста
      - alert: LLMCostPerRequestJump
        expr: |
          avg_over_time(llm_request_cost_usd_sum[1h] / llm_request_cost_usd_count[1h]) > 2.5
          * avg_over_time(llm_request_cost_usd_sum[1h] / llm_request_cost_usd_count[1h] offset 7d)
        for: 15m
        labels: {severity: warning, owner: platform}
        annotations:
          summary: "Средняя стоимость запроса выросла более чем в 2,5 раза к прошлой неделе"

      # 4. Контекст распух: главный и самый частый источник роста расходов
      - alert: LLMContextTooLarge
        expr: histogram_quantile(0.95, sum by (le) (rate(llm_rag_chunks_returned_bucket[1h]))) > 15
        for: 30m
        labels: {severity: warning, owner: ml}
        annotations:
          summary: "p95 числа чанков в контексте вырос до {{ $value }} — проверь reranker"

      # 5. Дежурный уровень: инференс не тянет
      - alert: LLMTTFTDegraded
        expr: histogram_quantile(0.95, sum by (le, model) (rate(llm_ttft_seconds_bucket[10m]))) > 8
        for: 10m
        labels: {severity: critical, owner: platform}
```

Правило именования метрик здесь осознанное: префикс `llm_` отделяет качественные метрики от инфраструктурных, но **живут они в одном Prometheus и на одном дашборде**. В этом весь смысл: когда дежурный открывает панель «Ответы без источника», он видит рядом те же `instance` и `pod`, что и на дашборде инфраструктуры, и корреляция делается в уме за секунды.

### Дашборд, который отвечает на вопрос «а оно вообще работает?»

| Панель | Запрос | Взгляд на ответ |
| --- | --- | --- |
| Ответов в минуту | `sum by (model) (rate(llm_answer_total[5m]))` | система жива, нагрузка понятна |
| Доля ответов со ссылкой | `sum(rate(llm_answer_total{has_citation="true"}[30m])) / sum(rate(llm_answer_total[30m]))` | **главная панель качества** |
| Категории запросов | `topk(10, sum by (category) (rate(llm_answer_total[1h])))` | чем реально пользуются |
| Отказы (нет данных) | `sum(rate(llm_answer_total{refused="true"}[30m])) / sum(rate(llm_answer_total[30m]))` | система осознаёт границы |
| p95 TTFT и полное время | `histogram_quantile(0.95, sum by (le) (rate(llm_ttft_seconds_bucket[10m])))` | ощущаемая скорость |
| Стоимость запроса p95 и сумма | `histogram_quantile(0.95, sum by (le) (rate(llm_request_cost_usd_sum[10m]) / rate(llm_request_cost_usd_count[10m])))` | расходы в одном окне с качеством |
| Токены на входе p95 | `histogram_quantile(0.95, sum by (le) (rate(llm_tokens_bucket{stage="input"}[10m])))` | растёт → ищи утечку контекста |
| Активная версия промпта | `count by (prompt_version) (llm_build)` | какая версия в бою прямо сейчас |

Этот набор панелей — твой ответ на «оно работает». Не «да, ошибок нет», а: известное число ответов в минуту, известная доля с источником, известная доля осознанных отказов, известная стоимость и известное время, плюс одна ссылка на любой конкретный ответ для разбора.

## Где это ломается

- **Трассируют 100% и через месяц получают 12 ТБ и репутационно вредный чат с SaaS.** Сэмплируй с первого дня: 100% ошибок, 100% медленных, 10% остальных.
- **Логи наблюдаемости становятся источником утечки.** Маскирование в коде, до отправки — иначе аудит через полгода будет неприятным. Маскировать надо и вход агента, там часто проскакивает внутренний документ.
- **Судья в проде даёт ложную тревогу.** Прямой вызов LLM-судьи на каждом ответе в проде дорог и шумен. Правильно: 1–5% запросов + всё, что попало в жалобу или в долгий/ошибочный класс.
- **Кардинальность убивает Prometheus.** Лейбл `user_id` или `session_id` в метрике — это тысячи новых серий в секунду. В метриках у тебя только `category`, `model`, `prompt_version`. Персональная разбивка живёт в трассах, но не в TSDB.
- **Сравнивают два прогона с разными версиями судьи или промпта.** Перед любым сравнением фиксируй `judge_model` и `judge_prompt_sha` (см. [оценку LLM-систем](mlops/15-ocenka-llm.md)), иначе измеряешь шум.
- **Дашборд качества без разбивки по категориям.** Средние 89% выглядят хорошо ровно до того дня, когда падает редкая, но критичная категория. Разбивка по категориям обязательна, как в оценке офлайн.
- **Langfuse/ClickHouse на той же ВМ, что и Windows AD.** Требования к ресурсам у трассировки неожиданно высокие: 8 ГБ RAM и нормальный SSD. Отдельная ВМ на Proxmox, отдельный бэкап — иначе потеряешь и трассы, и доступность.

## Чек-лист понимания

- [ ] Я знаю, чем инфраструктурный, компонентный и продуктовый уровни наблюдаемости отличаются и почему зелёная инфраструктура не означает хорошего качества.
- [ ] Я могу нарисовать дерево трассы для агентного запроса и назвать обязательные поля каждого span'а.
- [ ] Я выбрал инструмент наблюдаемости по критерию «могу ли я унести свои трассы», а не по красоте интерфейса.
- [ ] Я понимаю, зачем в трассе `prompt_version` и `git_sha`, и могу по одной жалобе восстановить всю конфигурацию ответа.
- [ ] Я знаю, что маскирование персональных данных делается в коде до отправки, и умею проверить это тестом в CI.
- [ ] Я умею вывести метрику доли ответов без источника и стоимость запроса в Prometheus и собрать из них алерт.
- [ ] Я могу показать дашборд из восьми панелей, который отвечает руководству на вопрос «а оно вообще работает».
- [ ] Я знаю, какие метрики качества вычисляются честно и дёшево, а какие требуют выборки и LLM-судьи, и закладываю это в бюджет.
