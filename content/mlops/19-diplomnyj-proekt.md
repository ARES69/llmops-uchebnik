---
title: Дипломный проект
track: mlops
module: K. Финал
order: 19
duration: 100 мин
level: senior
tags: [проект, архитектура, интеграция, диплом, приемка]
summary: Выбираешь проект из реальной работы ИТ-отдела, собираешь его до приёмки и защищаешь как готовый продукт, а не как pet-проект
practice: Выбери один проект из шести, зафиксируй требования и критерии приёмки, подними эталонный стек в Docker Compose, собери golden set на 50 вопросов из своей базы знаний и прогони MVP по критериям из лекции — с отчётом, который покажешь руководителю.
---

Восемнадцать лекций позади — у тебя есть RAG, инференс, агенты, наблюдаемость и пайплайны по отдельности. Дипломный проект нужен не для красивого резюме, а чтобы доказать одну вещь: ты умеешь **собрать из этого работающий продукт**, у которого есть заказчик, критерии приёмки, бюджет и дата. Именно этот навык — то, что превращает DevOps-инженера в архитектора AI-систем. Разбираем, что именно построить и как это принять.

## Главное правило: бери проект из своей работы

Девять из десяти провальных дипломов — это «сделал LLM-чат с документацией» из интернета. Технически может быть хорошо, но у такого проекта нет главного: **нет реальной боли, которую он закрывает**. Руководство спросит «кому это нужно и что изменится», и ответа не будет.

Рабочее правило: тема диплома — это задача, которую ты и так ставишь команде каждый квартал. Набившая осколки база регламентов. Инциденты, на которые уходит день работы постфактум. Дежурный, который ищет инструкцию по ОС в забытом ящике. Если у тебя есть такой список — половина работы уже сделана: ты знаешь боль и можешь измерить эффект.

> [!IMPORTANT]
> Проект из реальной работы даёт тебе три вещи, которых нет ни у одного учебного:
> **реальные данные** (не синтетика), **реального заказчика** (который скажет «не работает» в первый же день)
> и **измеримый эффект** (на чём именно ты сэкономишь). Без всех трёх это pet-проект.

## Шесть вариантов проектов

Каждый вариант оценён по трём осям, которые важны именно тебе как руководителю: сколько инженерных часов, сколько календарного времени до приёмки и насколько заметен эффект для руководства.

| Проект | Что делает | Сложность | До приёмки | Эффект для ИТ-отдела | Что покажет комиссии |
| --- | --- | :---: | :---: | --- | --- |
| **1. Ассистент по регламентам** (RAG + агент) | Отвечает на вопросы по базе знаний со ссылками на источник, умеет посмотреть значение во внутренней базе (read-only) | Средняя | 6–8 недель | Высокий: снимает повторяющиеся вопросы, ускоряет онбординг новичков | Полный цикл: данные, индексация, RAG, агент, шлюз, наблюдаемость, приёмка |
| **2. Анализ инцидентов** | Логи и тикеты → классификация категории → черновик post-mortem с выдержками из логов | Средняя | 5–7 недель | Средний: экономит 2–4 часа на разборе каждого инцидента, даёт единый язык классификации | Работу с неструктурированными данными, оценку качества, интеграцию с Jira/Service Desk |
| **3. Ассистент по CMDB** | «Что сломается, если упадёт сервис X» — RAG по документации + граф зависимостей | Высокая | 10–12 недель | Очень высокий: уменьшает время планового обслуживания и риск каскадного отказа | Графовые запросы, работу с несколькими источниками, честную архитектуру со ссылками |
| **4. Чат к метрикам** | «Почему вчера были тормоза» → natural language → запрос к Prometheus → объяснение | Средняя+ | 6–8 недель | Средний: ускоряет разбор деградаций в разы, если сделан правильно | Text-to-SQL, безопасность запросов, связку с твоим Prometheus |
| **5. Голосовой помощник по инструкциям** | Тот же RAG, но голосовой ввод и синтез речи — для дежурных с руками занятыми | Средняя | 6–8 недель | Узкий, но реальный: быстрее открытие смен | Работу с голосом, отказоустойчивостью распознавания |
| **6. Проверка гигиены AD и безопасности** | Регулярный аудит: отключённые учётки, слабые пароли, устаревшие компьютерные записи, права админов | Низкая | 3–4 недели | Средний: ловит дыры до аудита | Автоматизацию на PowerShell/ADSI, понятные отчёты, меньше ML |

> [!TIP]
> Не выбирай самый эффектный проект — выбирай тот, который **ты доведёшь**. Вариант 6 технически проще всех, а вариант 3 легко убьёт полгода жизни, если ты не сделал RAG до этого. Если до диплома дошёл с опытом RAG — бери 1 или 3. Если нет — начинай с 1: он даёт полный цикл и однозначно нужен почти любому отделу.

### Как считать «сложность» честно

Сложность диплома — не число строк кода, а количество **разных подсистем, каждая из которых может сломаться**. RAG с Qdrant — это две подсистемы. RAG плюс агент с двумя инструментами, плюс API-шлюз с биллингом, плюс Langfuse — это пять. Умножь на свой реальный темп и добавь 40% на интеграцию: она всегда съедает больше, чем ты планировал.

## Рекомендуемый эталон: ассистент по регламентам

Дальше разбираем этот проект по слоям. Если ты выбрал другой — механика та же, меняются только источники данных и инструменты агента.

### Задача и границы

**Задача:** сотрудник задаёт вопрос обычным языком про регламенты, инструкции, порядки согласования, типовые инструкции для дежурного. Система отвечает, **обязательно ссылаясь на конкретный документ и раздел**, и умеет досмотреть факт в корпоративной базе (номер заявки, статус узла, ФИО владельца сервиса) — только на чтение.

**Явно вне области:** система не принимает решений сама, не пишет в базу, не отправляет письма и не закрывает инциденты. Границы фиксируются в первом же документе — и это не формальность, а то, что защитит тебя на приёмке.

**Пользователи:** 5–10 человек на старте (линейные инженеры, дежурные, новые сотрудники), а не весь отдел. Маленькая аудитория даёт быструю обратную связь и позволяет спокойно ловить качество.

## Архитектура: восемь слоёв и конкретный стек

### Слои системы

Каждый слой ниже — отдельный сервис с отдельной зоной отказа. Если всё в одной программе, ты не сможешь заменить векторную БД, не перезапустив всё, и не поймёшь, где именно деградация.

| Слой | Компонент | Техвыбор | Почему так |
| --- | --- | --- | --- |
| 1. Источники | Confluence / SharePoint / файловый ресурс / git | Выгрузка по API + инкрементально | Версии документов важнее идеального парсинга |
| 2. Индексация | Чанкинг, эмбеддинги, векторная БД | Qdrant + локальная модель эмбеддингов | Фильтры по метаданным, один контейнер, простой бэкап |
| 3. Сервис RAG | Retrieval + rerank + генерация | Qdrant + bge-reranker + Ollama/vLLM | Полный контроль над стоимостью и над тем, что уходит в модель |
| 4. Агентный слой | Инструменты: поиск, чтение документа, SQL read-only | LangGraph или цикл ReAct с явным списком инструментов | Агент даёт «поиск + проверка факта», но не даёт права записи |
| 5. API-шлюз | Аутентификация, rate limit, квоты, биллинг токенов | Свой FastAPI-сервис + внешний IdP (Keycloak/AD) | Именно здесь живёт учёт токенов и ограничение расхода |
| 6. Интерфейс | Минимальный web-chat или Telegram-бот | Streamlit / HTML + n8n | Скорость: n8n уже есть в твоём стеке и закрывает маршрутизацию |
| 7. Наблюдаемость | Langfuse (трейсы) + Prometheus + Grafana | Открытые инструменты из DevOps-трека | Ответ на вопрос «куда ушли токены и почему агент ошибся» |
| 8. Алерты | Prometheus rules + Alertmanager | Те же правила, что в [Grafana и алерты](devops/17-grafana-loki-alerty.md) | Регрессия качества и рост расхода — это тоже авария |

> [!IMPORTANT]
> Агентный слой — **не обязательный**. Классический RAG с одним инструментом «поиск по базе» покрывает 70% вопросов и отладчивается за вечер. Агент нужен там, где ответ требует двух шагов: «найди регламент → посмотри статус узла в системе учёта». Добавляй агент только если на golden set он реально повышает точность — измеряй, а не угадывай.

### Стек и его связь с курсом

Каждый элемент стека ты уже разбирал. Здесь важно видеть, что диплом — это не новая дисциплина, а сборка знакомого.

| Элемент | Лекция в курсе | Что приносишь в проект |
| --- | --- | --- |
| Docker Compose как способ «поднять всё у себя» | [Docker Compose](devops/09-docker-compose.md) | Весь стек поднимается одной командой |
| Сбор и очистка корпуса | [Данные и пайплайны](mlops/04-dannye-i-pipeliney.md) | Чанкинг, манифест, снапшот корпуса |
| Эмбеддинги и векторная база | [Эмбеддинги и векторные базы](mlops/05-embedding-i-vektory.md) | Выбор модели эмбеддингов и Qdrant, ACL в payload |
| Слои retrieval, rerank, генерация | [RAG-пайплайн](mlops/06-rag-pipeline.md) | Фильтры до поиска, цитаты, отказ вместо выдумки |
| Оценка качества на golden set | [Оценка RAG](mlops/07-ocenka-rag.md) | Метрики точности, полноты ссылок, отказов |
| Пороги качества как SLO | [Оценка LLM-систем](mlops/15-ocenka-llm.md) | Пять срезов качества, порог для релиза |
| Устройство LLM и контекстное окно | [Как устроена LLM](mlops/08-llm-kak-ustroena.md) | Почему нужен rerank, а не «просто длинный контекст» |
| Выбор модели под VRAM | [GPU, VRAM и цена вопроса](mlops/09-gpu-vram-cena.md) | Квантизация, размер весов, потолок запросов |
| Локальный инференс | [Ollama и vLLM](mlops/10-lokalnyj-serving.md) | Поднять движок и получить OpenAI-совместимый API |
| Шлюз, лимиты, квоты | [API-шлюз](mlops/11-api-shlyuz.md) | Аутентификация, rate limit, биллинг |
| Цикл агента и инструменты | [Агенты и фреймворки](mlops/12-agent-frameworks.md) | Список инструментов, чекпойнты, отказ от агента, если не нужен |
| Минимальные права агента | [Безопасность агентов](mlops/14-bezopasnost-agentov.md) | Read-only доступ, guardrails, аудит действий |
| Метрики и Grafana | [Prometheus](devops/16-prometheus.md) | Экспорт метрик качества и стоимости |
| Трейсинг LLM | [Наблюдаемость LLM-систем](mlops/16-nablyudaemost-llm.md) | Langfuse: токены, латентность, ретраи |
| Прогон golden set в пайплайне | [Пайплайны LLMOps](mlops/17-llmops-pipeliney.md) | Тест качества как обязательный шаг сборки |
| CI/CD, версии образов | [Пайплайны](devops/14-cicd-pipeliney.md) | Сборка образа и откат по тегу |
| Стоимость запроса и окупаемость | [Масштабирование и цена](mlops/18-masshtabirovanie-i-cena.md) | Расчёт ₽ за запрос для защиты бюджета |

## От данных к векторной базе

### Чанкинг: чем резать регламенты

Для Markdown-документов резать по символам — плохо. Регламент состоит из заголовков, и смысловой кусок это «раздел целиком». Чанк должен пересекать границы структуры только в крайнем случае и **нести с собой метаданные**: путь документа, заголовок раздела, версию, дату обновления. Эти поля потом уходят в payload Qdrant и служат фильтрами и ссылками.

```python
# chunker.py — разбивка Markdown-документов по заголовкам с перекрытием
import re, hashlib
from pathlib import Path

TARGET = 1200          # целевой размер чанка в символах
OVERLAP = 200          # перекрытие, чтобы не терять смысл на стыке разделов
SEP = re.compile(r"^(#{1,6})\s+(.+)$", re.M)


def split_sections(text: str):
    """Возвращает [(заголовок, текст)] — по h2/h3, верхний заголовок наследуется."""
    matches = list(SEP.finditer(text))
    if not matches:
        return [("", text)]
    head = text[: matches[0].start()]
    out, path = [], []
    for i, m in enumerate(matches):
        level, title = len(m.group(1)), m.group(2).strip()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        path = path[: level - 1] + [title]
        if level <= 3:
            out.append((" / ".join(path[:3]), text[m.end():end]))
    if head.strip():
        out.insert(0, ("(преамбула)", head))
    return out


def chunk_text(text: str, target=TARGET, overlap=OVERLAP):
    """Режет длинный кусок на окна с перекрытием, режет по границе предложения."""
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) <= target:
        return [text]
    parts, start = [], 0
    while start < len(text):
        end = min(start + target, len(text))
        if end < len(text):
            cut = max(text.rfind(". ", start, end), text.rfind("\n", start, end))
            if cut > start + target // 2:
                end = cut + 1
        parts.append(text[start:end].strip())
        if end >= len(text):
            break
        start = end - overlap
    return parts


def iter_documents(root: Path):
    for p in sorted(root.rglob("*.md")):
        raw = p.read_text(encoding="utf-8")
        rel = p.relative_to(root).as_posix()
        doc_id = hashlib.sha1(rel.encode()).hexdigest()[:16]
        for section, body in split_sections(raw):
            for i, part in enumerate(chunk_text(body)):
                yield {
                    "id": f"{doc_id}-{i:04d}",
                    "text": part,
                    "payload": {
                        "doc_id": doc_id,
                        "path": rel,
                        "section": section or "(без раздела)",
                        "chunk": i,
                        "url": f"https://wiki.corp.local/{rel}",
                        "updated": p.stat().st_mtime,
                    },
                }
```

Обрати внимание: `payload.url` — это та самая ссылка на источник, которая потом станет критерием приёмки. Если её нет на этапе индексации, её не будет и в ответе.

### Qdrant или pgvector

Оба варианта рабочие. Выбор определяется не модой, а тем, что у тебя уже есть и как часто ты будешь менять фильтры.

| Критерий | Qdrant | pgvector |
| --- | --- | --- |
| Что поднимать | Отдельный контейнер, одна команда | Ничего, если Postgres уже есть |
| Фильтры по метаданным | Богатые: `should`/`must`/`range`, без переписывания индекса | Через `WHERE`, индекс по GIN, планировщик Postgres |
| Объём | Сотни тысяч — миллионы точек | До ~500 тыс. точек комфортно, дальше растёт время vacuum и планирования |
| Бэкап | Достаточно снять снапшот каталога | Тот же бэкап Postgres, который у тебя уже настроен |
| Нагрузка на память | Собственный процесс, кэш в RAM | Делит память с приложением |
| Когда выбирать | Фильтры постоянно меняются, объём растёт, нужен отдельный сервис | База знаний меньше 200 тыс. чанков и Postgres уже есть |

**Для диплома бери Qdrant**: один контейнер вместо миграции чужой БД, payload-фильтры ты будешь использовать постоянно (по разделу, по версии документа, по типу доступа), и её не страшно снести и пересобрать.

```bash
# docker-compose.yml — ядро стека. Поднимается одной командой.
services:
  qdrant:
    image: qdrant/qdrant:v1.12.4
    restart: unless-stopped
    volumes:
      - qdrant_data:/qdrant/storage
    ports:
      - "127.0.0.1:6333:6333"   # наружу не выставляем: доступ только из внутренней сети
    healthcheck:
      test: ["CMD-SHELL", "bash -c '</dev/tcp/127.0.0.1/6333'"]
      interval: 10s
      retries: 5

  ollama:
    image: ollama/ollama:0.5.4
    restart: unless-stopped
    volumes:
      - ollama_models:/root/.ollama
    ports:
      - "127.0.0.1:11434:11434"

  langfuse:
    image: langfuse/langfuse:v2
    restart: unless-stopped
    depends_on: [postgres, clickhouse]
    environment:
      DATABASE_URL: postgresql://langfuse:${LANGFUSE_PG_PASSWORD}@postgres:5432/langfuse
      CLICKHOUSE_MIGRATION_URL: clickhouse://clickhouse:9000
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_USER: ${CLICKHOUSE_USER}
      CLICKHOUSE_PASSWORD: ${CLICKHOUSE_PASSWORD}
      NEXTAUTH_SECRET: ${LANGFUSE_SECRET}
      NEXTAUTH_URL: http://langfuse:3000
      ENCRYPTION_KEY: ${LANGFUSE_ENCRYPTION_KEY}
      TELEMETRY_ENABLED: "false"          # наружу ничего не отправляем

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: langfuse
      POSTGRES_PASSWORD: ${LANGFUSE_PG_PASSWORD}
      POSTGRES_DB: langfuse
    volumes:
      - langfuse_pg:/var/lib/postgresql/data

  clickhouse:
    image: clickhouse/clickhouse-server:24.8-alpine
    restart: unless-stopped
    volumes:
      - langfuse_ch:/var/lib/clickhouse

volumes:
  qdrant_data:
  ollama_models:
  langfuse_pg:
  langfuse_ch:
```

> [!WARNING]
> Весь этот стек — **локальная разработка и стенд**. В проде копии чувствительных регламентов лежат в Qdrant, а пароли — в секретах. Прежде чем переносить, прочитай [Безопасность инфраструктуры](devops/20-bezopasnost-infrastruktury.md): бэкап каталога Qdrant, доступ по SSH-туннелю вместо открытого порта и отдельный пользователь с правами только на чтение.

### Индексация: эмбеддинги и загрузка

Эмбединги считаются батчами, один вызов на 32–64 текста. Модель эмбеддингов фиксируется в конфиге и **никогда не меняется молча**: смена модели означает полную переиндексацию, потому что векторное пространство другое.

```python
# index_documents.py — загрузка чанков в Qdrant с идемпотентностью
import argparse, hashlib
from pathlib import Path
import requests
from chunker import iter_documents

QDRANT = "http://qdrant:6333"
OLLAMA = "http://ollama:11434"
COLLECTION = "reglamenty"
EMBED_MODEL = "bge-m3"          # менять только вместе с полной переиндексацией


def embed(texts: list[str]) -> list[list[float]]:
    out = []
    for i in range(0, len(texts), 32):
        batch = texts[i:i + 32]
        r = requests.post(f"{OLLAMA}/api/embed",
                          json={"model": EMBED_MODEL, "input": batch}, timeout=120)
        r.raise_for_status()
        out.extend(r.json()["embeddings"])
    return out


def recreate_collection() -> None:
    requests.delete(f"{QDRANT}/collections/{COLLECTION}").raise_for_status() \
        if False else None   # DELETE на отсутствующую коллекцию вернёт 404 — это норма
    requests.put(f"{QDRANT}/collections/{COLLECTION}",
                 json={"vectors": {"size": 1024, "distance": "Cosine"}}).raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", required=True, help="каталог с .md")
    ap.add_argument("--full", action="store_true", help="пересоздать коллекцию с нуля")
    args = ap.parse_args()

    docs = list(iter_documents(Path(args.docs)))
    if not docs:
        raise SystemExit("Не найдено ни одного документа — проверь путь и расширения")

    if args.full:
        recreate_collection()

    vectors = embed([d["text"] for d in docs])
    body = {
        "batch": {
            "ids": [d["id"] for d in docs],
            "vectors": vectors,
            "payloads": [d["payload"] for d in docs],
        }
    }
    r = requests.put(f"{QDRANT}/collections/{COLLECTION}/points?wait=true", json=body, timeout=300)
    r.raise_for_status()

    # хэш корпуса — чтобы понять, какая версия данных в индексе
    corpus_hash = hashlib.sha1(
        "".join(sorted(d["id"] + d["text"][:200] for d in docs)).encode()
    ).hexdigest()[:12]
    print(f"Загружено чанков: {len(docs)}, корпус: {corpus_hash}, модель: {EMBED_MODEL}")


if __name__ == "__main__":
    main()
```

## Сервис RAG: retrieval, rerank, генерация

Качество RAG собирается из трёх шагов, и каждый можно улучшить отдельно. Сначала дешёвый векторный поиск берёт 30–50 кандидатов, потом reranker пересортировывает их по реальному сходству с вопросом, и только потом модель получает 4–6 лучших.

```python
# rag.py — ядро сервиса: поиск, пересортировка, генерация с источниками
import requests
from dataclasses import dataclass

QDRANT = "http://qdrant:6333"
OLLAMA = "http://ollama:11434"
COLLECTION = "reglamenty"
GEN_MODEL = "qwen2.5:14b-instruct"
CANDIDATES = 40          # столько забирает векторный поиск
TOP_K = 5                # столько реально уходит в контекст


@dataclass
class Answer:
    text: str
    sources: list[dict]
    prompt_tokens: int
    completion_tokens: int


def search(question: str, access_group: str, limit: int = CANDIDATES) -> list[dict]:
    emb = requests.post(f"{OLLAMA}/api/embed",
                        json={"model": "bge-m3", "input": question}, timeout=60).json()["embeddings"][0]
    r = requests.post(
        f"{QDRANT}/collections/{COLLECTION}/points/search",
        json={
            "vector": emb, "limit": limit, "with_payload": True,
            # ФИЛЬТР ПО ПРАВАМ — обязателен. Иначе документ, который пользователь
            # не должен видеть, всё равно попадёт в контекст модели.
            "filter": {"must": [{"key": "access_group", "match": {"value": access_group}}]},
        }, timeout=30)
    r.raise_for_status()
    return r.json()["result"]


def rerank(question: str, hits: list[dict]) -> list[dict]:
    resp = requests.post(
        f"{OLLAMA}/api/rerank",
        json={"model": "bge-reranker-v2-m3", "query": question,
              "documents": [h["payload"]["text"] for h in hits],
              "top_n": TOP_K},
        timeout=30)
    resp.raise_for_status()
    order = resp.json()["results"]
    return [{"hit": hits[r["index"]], "score": r["relevance_score"]} for r in order]


SYSTEM_PROMPT = """Ты — внутренний ассистент ИТ-отдела. Отвечай ТОЛЬКО по приведённым
фрагментам регламентов. Если в фрагментах нет ответа — прямо скажи: «В базе знаний нет
ответа на этот вопрос, обратитесь к <владельцу процесса>».
Обязательно укажи источник в формате [путь#раздел] для каждого утверждения.
Не додумывай сроки, суммы и номера заявок, которых нет в тексте."""


def answer(question: str, access_group: str = "it-general") -> Answer:
    hits = search(question, access_group)
    ranked = rerank(question, hits)
    ctx_blocks, sources = [], []
    for n, item in enumerate(ranked, 1):
        p = item["hit"]["payload"]
        ctx_blocks.append(f"[{n}] (источник: {p['path']}#{p['section']})\n{item['hit']['payload']['text']}")
        sources.append({"path": p["path"], "section": p["section"], "url": p["url"], "score": item["score"]})

    prompt = f"Вопрос: {question}\n\nФрагменты:\n" + "\n\n".join(ctx_blocks)
    resp = requests.post(f"{OLLAMA}/api/generate",
                         json={"model": GEN_MODEL, "system": SYSTEM_PROMPT, "prompt": prompt,
                               "stream": False, "options": {"temperature": 0.1, "num_ctx": 8192}},
                         timeout=180)
    resp.raise_for_status()
    data = resp.json()
    return Answer(
        text=data["response"],
        sources=sources,
        prompt_tokens=data.get("prompt_eval_count", 0),
        completion_tokens=data.get("eval_count", 0),
    )
```

Три решения здесь неочевидны и стоят отдельного разговора:

- **Фильтр по `access_group` в самом поиске**, а не постфактум в ответе. Если фильтровать после генерации, модель уже видела закрытый текст и могла отразить его в ответе.
- **`temperature: 0.1`** для ответов по документам: нужна воспроизводимость, чтобы два прогона golden set сравнивались честно.
- **Отказ как явный путь.** Инструкция «скажи, что не знаешь» работает лучше, чем попытка сделать модель осторожнее промптом в надежде на авто-калибровку.

## Агентный слой и минимальные права

Агент нужен только ради одного класса задач: «найди правило **и** проверь текущее состояние». Инструментов должно быть ровно столько, сколько нужно, и все они — read-only.

```sql
-- Схема доступа агента. Пользователь создаётся с минимальными правами и без
-- права создавать временные таблицы — это закрывает classic SQLi через ; и pg_sleep.
CREATE ROLE rag_reader LOGIN PASSWORD 'берём из секрета, не из репозитория';
GRANT CONNECT ON DATABASE cmdb TO rag_reader;
GRANT USAGE ON SCHEMA public TO rag_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rag_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO rag_reader;          -- чтобы новые таблицы тоже были доступны
-- Чего НЕ делаем: не даём CREATE, не даём EXECUTE на pg_read_file/pg_lstat и т.п.,
-- не даём доступ к таблицам с ФИО и зарплатами.

-- Ограничение на тяжёлые запросы: иначе один вопрос про «все узлы за год»
-- положит боевую базу.
ALTER ROLE rag_reader SET statement_timeout = '3s';
ALTER ROLE rag_reader SET default_transaction_read_only = on;
ALTER ROLE rag_reader SET work_mem = '16MB';
```

```json
{
  "tools": [
    {
      "name": "kb_search",
      "description": "Поиск по базе знаний: регламенты, инструкции, порядки. Возвращает фрагменты со ссылками.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Поисковый запрос на русском языке"},
          "access_group": {"type": "string", "enum": ["it-general", "it-restricted"]}
        },
        "required": ["query"]
      }
    },
    {
      "name": "cmdb_lookup",
      "description": "ТОЛЬКО ЧТЕНИЕ. Точный запрос к инвентаризации: владелец сервиса, статус узла, последний инцидент по сервису.",
      "input_schema": {
        "type": "object",
        "properties": {
          "sql": {"type": "string", "description": "SELECT без UNION, без подзапросов к pg_* — проверяется allowlist'ом"}
        },
        "required": ["sql"]
      }
    }
  ]
}
```

> [!CAUTION]
> `SELECT`-only **не равно** безопасно. Через `SELECT` можно вытащить миллион строк и положить базу, можно прочитать то, что попадёт в следующий промпт и утечёт в логи трейсинга, а `pg_sleep` превращает вопрос в отказ в обслуживании. Поэтому: allowlist таблиц, `statement_timeout = 3s`, лимит строк в 200, проверка что в запросе нет слов `pg_`, `information_schema`, `pg_catalog`, и запрет на `UNION`. Это ровно тот случай, где «красивый SQL от модели» должен проходить через фильтр, а не через доверие.

## API-шлюз: квоты и биллинг токенов

Шлюз — место, где проект становится управляемым. Без него ты не узнаешь, кто сколько тратит, и не сможешь остановить runaway-агента до того, как он съест месячный бюджет.

```python
# gateway.py — аутентификация, rate limit, квота, биллинг
import os, time, json
from collections import defaultdict, deque
from fastapi import FastAPI, Depends, HTTPException, Header
import jwt, yaml
from rag import answer

app = FastAPI()

SETTINGS = yaml.safe_load(open(os.environ["RAG_SETTINGS"]))
bucket = defaultdict(deque)       # user -> времена запросов
spent  = defaultdict(int)         # user -> токены за текущий месяц
period = time.strftime("%Y%m")


def monthly_reset():
    global period
    now = time.strftime("%Y%m")
    if now != period:
        spent.clear(); period = now


def auth(authorization: str = Header(...)):
    try:
        # Токен выпускает твой IdP (Keycloak/AD). Проверяем подпись и аудиторию,
        # а не просто декодируем base64.
        claims = jwt.decode(authorization.removeprefix("Bearer "),
                            SETTINGS["jwt_public_key"], algorithms=["RS256"],
                            audience="rag-assistant")
        return {"sub": claims["sub"], "groups": claims.get("groups", ["it-general"])}
    except Exception:
        raise HTTPException(401, "Невалидный токен")


def quota_guard(user: str):
    monthly_reset()
    if spent[user] >= SETTINGS["monthly_token_quota"]:
        raise HTTPException(429, "Квота токенов на месяц исчерпана")

    now = time.time()
    times = bucket[user]
    while times and times[0] < now - 60:
        times.popleft()
    if len(times) >= SETTINGS["rate_limit_per_min"]:
        raise HTTPException(429, "Превышен лимит запросов в минуту")
    times.append(now)


@app.post("/v1/answer")
def ask(question: str, user: dict = Depends(auth)):
    if len(question) > 2000:
        raise HTTPException(400, "Вопрос слишком длинный")
    quota_guard(user["sub"])

    t0 = time.time()
    group = "it-restricted" if "it-restricted" in user["groups"] else "it-general"
    result = answer(question, access_group=group)

    spent[user["sub"]] += result.prompt_tokens + result.completion_tokens
    total = result.prompt_tokens + result.completion_tokens

    # Учёт стоимости — единственный способ узнать её до конца месяца
    cost = (result.prompt_tokens * SETTINGS["price_in_per_ktok"]
            + result.completion_tokens * SETTINGS["price_out_per_ktok"]) / 1000
    metrics_answer.observe(total)                       # Prometheus
    metrics_cost.observe(cost)
    metrics_latency.observe(time.time() - t0)
    return {"answer": result.text, "sources": result.sources,
            "usage": {"tokens": total, "cost_rub": round(cost, 4)}}
```

```yaml
# rag-settings.yaml — конфигурация в репозитории, а не в коде
model: qwen2.5:14b-instruct
max_sources: 5
monthly_token_quota: 2000000        # на пользователя в месяц
rate_limit_per_min: 10
price_in_per_ktok: 0.9              # ₽ за 1000 входных токенов — см. лекцию о цене
price_out_per_ktok: 2.7
```

## Интерфейс: минимум усилий

Веб-интерфейс для диплома — это три файла и пятьдесят строк. Всё остальное (SSO, роли) делает шлюз. Если в компании уже есть n8n, чат-интерфейс можно не писать вообще: n8n принимает webhook, держит состояние диалога, а HTTP Request-node ходит в твой `/v1/answer`.

```python
# bot.py — Telegram-бот поверх того же шлюза: 60 строк вместо веб-интерфейса
import os, requests
from telegram import Update
from telegram.ext import ApplicationBuilder, MessageHandler, ContextTypes, filters

GATEWAY = os.environ["RAG_GATEWAY_URL"]     # http://rag-api:8000
TELEGRAM_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ALLOWED = set(int(x) for x in os.environ["TELEGRAM_ALLOWED_USERS"].split(","))


async def handle(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    # Ограничение по Telegram-ID: бот не должен быть открытым, иначе его
    # раскрутят и он станет публичным LLM-сервисом на твоём железе.
    if update.effective_user.id not in ALLOWED:
        await update.message.reply_text("Доступ закрыт.")
        return

    # Персональный токен пользователя — им же шлюз считает квоту.
    user_token = ctx.user_data.get("token")
    if not user_token:
        r = requests.post(f"{GATEWAY}/v1/auth/exchange",
                          json={"tg_id": update.effective_user.id}, timeout=10)
        r.raise_for_status()
        user_token = ctx.user_data["token"] = r.json()["access_token"]

    resp = requests.post(f"{GATEWAY}/v1/answer",
                         json={"question": update.message.text},
                         headers={"Authorization": f"Bearer {user_token}"}, timeout=180)
    if resp.status_code != 200:
        await update.message.reply_text(f"Сервис временно недоступен: {resp.status_code}")
        return

    data = resp.json()
    srcs = "\n".join(f"• {s['path']}#{s['section']}" for s in data["sources"])
    await update.message.reply_text(
        f"{data['answer']}\n\nИсточники:\n{srcs}\n\n"
        f"[токены: {data['usage']['tokens']} · {data['usage']['cost_rub']} ₽]")
```

## Наблюдаемость: трейсы, метрики, алерты

Две системы решают разные задачи и не заменяют друг друга. **Langfuse** отвечает на вопрос «почему этот конкретный ответ был плох» — там видно ретраи, переписывания запроса, стоимость каждого шага. **Prometheus** отвечает на вопрос «что происходит с системой сейчас» — ночные деградации, рост отказов, всплеск расхода.

```python
# tracing.py — инициализация Langfuse + метрики качества в Prometheus
import os
from langfuse import Langfuse
from prometheus_client import Counter, Histogram, Gauge

lf = Langfuse(
    public_key=os.environ["LANGFUSE_PUBLIC_KEY"],
    secret_key=os.environ["LANGFUSE_SECRET_KEY"],
    host="http://langfuse:3000",
)

metrics_answer = Histogram("rag_answer_tokens_total", "Токенов на ответ",
                            labelnames=["model", "stage"])
metrics_cost = Histogram("rag_answer_cost_rub", "Стоимость ответа, ₽",
                         labelnames=["model", "user_type"])
metrics_latency = Histogram("rag_answer_latency_seconds", "Задержка ответа",
                            labelnames=["stage"])
groundedness = Gauge("rag_groundedness_ratio", "Доля ответов с корректными ссылками")


@lf.observe(name="rag.answer")
def traced_answer(question: str, group: str):
    with lf.start_as_current_observation(name="retrieval") as span:
        span.update_metadata={"access_group": group, "question_chars": len(question)})
        # в metadata пишем ТОЛЬКО метаданные. Сырой вопрос с персональными
        # данными в Langfuse не отправляем — это отдельное решение по retention.
    return answer(question, access_group=group)
```

```yaml
# prometheus-rules-rag.yml — правила, которые ловят деградацию раньше пользователей
groups:
  - name: rag-quality
    rules:
      - alert: RagNoSources
        expr: increase(rag_answers_total{has_sources="false"}[30m]) / clamp_min(increase(rag_answers_total[30m]), 1) > 0.2
        for: 15m
        labels: {severity: warning, team: ai-platform}
        annotations:
          summary: "Больше 20% ответов без ссылок на источник"

      - alert: RagGoldenSetRegression
        expr: rag_golden_accuracy < 0.75
        for: 10m
        labels: {severity: critical, team: ai-platform}
        annotations:
          summary: "Просела точность на golden set: {{ $value | humanizePercentage }}"
          description: "Откати версию промпта или индекса, если падение началось после релиза."

      - alert: RagDailyCostSpike
        expr: increase(rag_answer_cost_rub_sum[24h]) > 5000
        labels: {severity: warning, team: ai-platform}
        annotations:
          summary: "Расход за сутки больше 5 000 ₽"

      - alert: RagLatencyHigh
        expr: histogram_quantile(0.95, rate(rag_answer_latency_seconds_bucket[10m])) > 12
        for: 10m
        labels: {severity: warning, team: ai-platform}
```

Правило про golden set — самое ценное из трёх. Именно оно превращает «нам кажется, ответы стали хуже» в измеримое утверждение с датой, когда это произошло.

## План работы по неделям

План рассчитан на 8 недель при 10–12 часах в неделю. Ключевая особенность: **инфраструктура поднимается на первой-второй неделе**, а не в конце. Пока стенда нет, качество данных и промптов обсуждать не о чем.

| Неделя | Что делаешь | Артефакт, который сдаёшь | Точка контроля |
| --- | --- | --- | --- |
| 1 | Планирование: требования, границы, критерии приёмки, отказ от части функций | `docs/requirements.md` с подписью заказчика | Если заказчик не может назвать критерии — проект не начат |
| 2 | Инфраструктура: Compose, модели скачаны, health-check зелёный | `docker-compose.yml`, `make up` поднимает всё | Всё поднимается одной командой с нуля |
| 3 | Сбор и индексация данных: чанкинг, эмбеддинги, Qdrant | `chunker.py`, `index_documents.py`, отчёт по корпусу | Считаешь чанки, токены и время индексации |
| 4 | MVP: RAG без агента, генерация, ссылки на источники | Работающий `/v1/answer` через curl | Первый правильный ответ виден глазами |
| 5 | Агентный слой: инструменты, права, guardrails | Агент + `cmdb_lookup` с фильтром | Агент не может изменить данные — проверяешь руками |
| 6 | Качество: golden set 50 вопросов, оценка, итерации | `goldenset.jsonl`, `eval_report.md` | Есть цифра точности, а не ощущение |
| 7 | Наблюдаемость: Langfuse, метрики, алерты, шлюз с квотами | Дашборд качества и стоимости, правила алертов | Можешь ответить на вопрос «куда ушли токены за вчера» |
| 8 | Документация, приёмка, презентация заказчику | README, отчёт, демо | Заказчик подписывает критерии из недели 1 |

> [!TIP]
> Недели 1 и 8 — самые важные, хотя кода в них нет. Неделя 1 фиксирует критерии **до** начала работы, и это твоя главная защита, когда на шестой неделе качество упрётся в потолок. Неделя 8 превращает проект из «работает у меня» в «принято в эксплуатацию».

## Что должно быть в репозитории

Репозиторий диплома читает человек, который тебя не знает и который будет решать, можно ли это в прод. Проверяй себя по этому списку: если чего-то нет, проект не готов к защите.

| Что | Зачем проверяющему | Минимальное требование |
| --- | --- | --- |
| README с архитектурой | Понять систему за 3 минуты | Схема слоёв, одноразовая команда подъёма, список допущений |
| Инфраструктура как код | Пересобрать стенд | `docker-compose.yml` + `.env.example` без секретов |
| CI/CD | Проверить, что изменения не ломают качество | Тесты + прогон golden set на каждом коммите |
| Тесты | Проверить, что это не «работает у меня» | Юнит-тесты чанкинга и парсинга ответа, интеграционный тест шлюза |
| Golden set + eval-скрипт | Проверить качество количественно | 50 вопросов, эталонные ответы, отчёт с цифрами |
| Дашборд | Увидеть качество и стоимость | Графики: точность, p95 задержка, ₽/день, доля ответов без ссылок |
| Модель-карточка | Понять, что за система | Модель, промпт, версия схемы, температура — в одном файле |
| Runbook | Понять, что делать, когда сломается | Что делать при недоступности модели, при падении Qdrant, при росте расхода |

```yaml
# .gitlab-ci.yml — минимальный, но настоящий пайплайн диплома
stages: [lint, test, eval, build]

variables:
  GOLDEN_THRESHOLD: "0.75"

.python: &python
  image: python:3.11-slim
  before_script:
    - pip install -q -r requirements.txt

lint:
  <<: *python
  stage: lint
  script:
    - ruff check .
    - black --check .

test:
  <<: *python
  stage: test
  script:
    - pytest -q tests/            # юнит-тесты чанкинга, парсинга, guardrails

eval:                          # ключевая проверка: качество не должно падать молча
  <<: *python
  stage: eval
  script:
    - python scripts/eval_golden.py --dataset data/goldenset.jsonl --out eval_report.json
    - |
      ACC=$(python -c "import json;print(json.load(open('eval_report.json'))['accuracy'])")
      echo "Golden set accuracy: $ACC"
      python -c "import sys;sys.exit(0 if float('$ACC') >= $GOLDEN_THRESHOLD else 1)"
  artifacts:
    when: always
    paths: [eval_report.json]
    expire_in: 30 days
```

## Критерии приёмки

Критерии формулируются **до** начала работы, в числах, и подписываются заказчиком. Это единственный способ защититься от бесконечного «а можно ещё чуть-чуть улучшить». Предлагаемый набор — то, что реально измеримо и не требует субъективной оценки.

| Критерий | Порог | Как измеряется | Почему именно так |
| --- | --- | --- | --- |
| Точность на golden set | ≥ 75% | Доля вопросов, где ответ признан верным двумя независимыми проверяющими | Ниже 70% система вредит: люди перестают ей пользоваться |
| Ссылки на источники | 100% | Доля ответов, где хотя бы одна ссылка ведёт на реально релевантный раздел | Без ссылки ответ невозможно проверить, а значит, невозможно доверять |
| Отказ вместо выдумки | ≥ 90% на вопросах вне базы | Доля случаев «в базе нет ответа» на негативном наборе | Самая опасная ошибка RAG — уверенная выдумка |
| p95 задержка | ≤ 12 с | Метрика Prometheus `rag_answer_latency_seconds` | Выше 20 секунд пользователь уходит и не возвращается |
| Стоимость запроса | ≤ 3 ₽ | Счётчик токенов, делённый на число запросов | Определяет, выживет ли проект экономически |
| Устойчивость к недоступности модели | Деградация, не отказ | Гасишь Ollama — система отвечает «сервис временно недоступен» | Проверяется за 2 минуты и ломает доверие навсегда |
| Права агента | Ноль операций записи | Попытка `UPDATE`/`DELETE` через агента обязана отклоняться БД | Это проверяется не «по словам», а попыткой |
| Аутентификация | 100% запросов | Запрос без токена получает 401 | Открытый чат с корпоративными данными — инцидент |

```python
# scripts/eval_golden.py — считает метрики приёмки, а не «на глаз»
import json, time, argparse, requests
from rag import answer

NEGATIVE_MARKERS = ["нет ответа", "не знаю", "обратитесь", "в базе знаний нет"]


def has_source(res) -> bool:
    return any(s["score"] > 0.45 for s in res.sources)


def is_refusal(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in NEGATIVE_MARKERS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out", default="eval_report.json")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.dataset, encoding="utf-8") if l.strip()]
    if args.limit:
        rows = rows[: args.limit]

    ok = cited = refused_ok = 0
    latencies, tokens, cost_per_answer = [], [], []
    failures = []

    for r in rows:
        t0 = time.time()
        try:
            res = answer(r["question"])
        except Exception as exc:                      # прогон не падает из-за одного вопроса
            failures.append({"q": r["question"], "error": str(exc)})
            continue
        latencies.append(time.time() - t0)

        n = res.prompt_tokens + res.completion_tokens
        tokens.append(n)
        cost_per_answer.append(n * 3.6 / 1000)        # средняя ставка ₽ за 1000 токенов

        cited += has_source(res)
        if r.get("negative"):
            refused_ok += is_refusal(res.text)
        elif r["expected_facts"] and all(f.lower() in res.text.lower() for f in r["expected_facts"]):
            ok += 1
        else:
            failures.append({"q": r["question"], "expected": r["expected_facts"],
                             "got": res.text[:200]})

    latencies.sort()
    report = {
        "total": len(rows),
        "accuracy": round(ok / max(len(rows), 1), 3),
        "citation_rate": round(cited / max(len(rows), 1), 3),
        "refusal_rate_on_negatives": round(refused_ok / max(n, 1), 3),
        "p95_latency_s": round(latencies[int(len(latencies) * 0.95)] if latencies else 0, 2),
        "avg_tokens": round(sum(tokens) / max(len(tokens), 1), 1),
        "avg_cost_rub": round(sum(cost_per_answer) / max(len(cost_per_answer), 1), 4),
        "failures": failures[:20],
    }
    json.dump(report, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))

    # Прогон возвращает ненулевой код — и CI останавливает раскатку.
    if report["accuracy"] < 0.75 or report["citation_rate"] < 1.0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
```

Про `negative`-вопросы: обязательная часть golden set. Десять процентов набора должны быть вопросами, ответа на которые в базе **нет**. Если на них система уверенно отвечает — у тебя нет RAG-система, у тебя генератор правдоподобных текстов.

## Три грабли, которые убивают диплом

**1. «Построили, но никто не пользуется».** Самая частая смерть. Причина почти всегда одна: выбранная задача не была болью. Симптомы: на демо есть 5 энтузиастов, через месяц ноль запросов. Лечится на этапе планирования — задай заказчику вопрос «как вы решаете это сейчас и сколько времени уходит», и если ответа нет, меняй тему, а не улучшай модель.

**2. Качество данных.** Не «модель плохая», а в базе лежат три устаревшие версии одного приказа, PDF-сканы без текстового слоя и документы с пометкой «УТРАТИЛ СИЛУ» в самом низу страницы. Модель ответит уверенно по отменённой версии — и виновата будет она. Разбор: чисти корпус, храни версию и дату в payload, фильтруй по актуальности при поиске.

**3. Недооценка объёма данных и расхода токенов.** Классика: 40 000 документов, средний чанк 1 200 символов, 100 тыс. чанков, средний вопрос тянет 6 кандидатов по 1 200 символов плюс ответ. Считай на этапе планирования, а не когда счёт придёт: `чанки × кандидаты × средние токены × ставка`. Всё, что не попало в расчёт, — это сюрприз на середине проекта.

## Если не успел

Честный MVP лучше брошенного большого проекта. Руководство прощает узкий инструмент, который работает и приносит пользу; оно не прощает демонстрацию недоработанного контура.

Отсекай в таком порядке — от того, что меньше всего влияет на ценность, к тому, что больше всего стоит:

| Оставляем | Убираем первым | Почему именно в таком порядке |
| --- | --- | --- |
| Один домен (регламенты по доступам) | Второй домен (закупки, кадры) | Качество одного домена измеримо, двух — нет |
| Локальный инференс | Внешний API и мультивендорный роутинг | Один источник отказов вместо трёх |
| Только веб-интерфейс | Telegram-бот и голос | Два интерфейса на одну логику — дублирование |
| Трассинг и метрики | Алерты и сложные дашборды | Без метрик ты не докажешь эффект, но без алертов спишь спокойнее |
| Квота в шлюзе | Тонкая ролевая модель доступа | 10 пользователей одного отдела — одна роль |

Что **нельзя** убирать ни при каких условиях: golden set с цифрами, ссылки на источники, read-only доступ агента и README. Это четыре вещи, без которых проект нельзя принять, сколько бы он ни стоил.

## Где это ломается

- **Смена модели эмбеддингов без переиндексации.** Индекс остаётся, поиск молча портится: векторы разных пространств в одной коллекции дают мусор без единой ошибки в логах. Всегда храни `EMBED_MODEL` в конфиге индекса и проверяй его при старте сервиса.
- **Секреты в `.env`, который попал в git.** Добавь `.env` в `.gitignore` **до** первого коммита и держи `.env.example` с пустыми значениями. Переписать историю после утечки ключа Langfuse дороже, чем потратить пять минут.
- **Каталоги без бэкапа.** Qdrant восстанавливается дешевле, чем пересобирается, но только если снапшот снимается. Проверь не наличие бэкапа, а восстановление из него — хотя бы один раз до приёмки.
- **Rate limit есть, квоты нет.** Один сотрудник запускает цикл из двадцати вопросов в цикле и за сутки съедает месячный бюджет. Лимит в минуту ограничивает всплеск, квота в месяц ограничивает расход. Нужны оба.
- **Фильтр по правам добавлен после генерации.** Текст закрытого регламента уже попал в контекст модели и в трейс Langfuse. Фильтр должен быть частью поискового запроса.
- **Golden set из тех же вопросов, что и в демо.** Качество на таких вопросах всегда 95%, и это ничего не значит. Набор должен быть собран до разговоров с пользователями и не редактироваться под результат.
- **Docker Compose на Kubernetes ради «как у всех».** Для одного проекта Kubernetes почти всегда избыточен: это лишние два дня на сетевые политики и лишний класс отказов. Переезжай, когда появится второй потребитель или требование к HA. Про это — в [Kubernetes: базовые](devops/10-kubernetes-bazovye.md).
- **Демо показывается на радости, а не на проблеме.** Руководство впечатлится интерфейсом и не купит проект. Показывай сначала боль и метрику до, потом демо, потом метрику после.

## Чек-лист понимания

- [ ] Я выбрал проект из списка шести и могу за 30 секунд объяснить, какую боль реальной работы он закрывает и как это измерится
- [ ] Я знаю, зачем нужны все восемь слоёв архитектуры и какой из них откажет первым при деградации качества
- [ ] Я обосновал выбор Qdrant против pgvector для своего объёма данных и своего Postgres
- [ ] Я умею объяснить, почему фильтр по правам должен быть в поисковом запросе, а не после генерации
- [ ] Я реализовал read-only доступ агента к базе и могу руками показать, что `UPDATE`/`DELETE` отклоняются
- [ ] У меня есть golden set минимум из 50 вопросов, из них 10% — вопросы без ответа в базе, и есть цифра точности
- [ ] Мой шлюз ограничивает и частоту запросов, и месячный расход токенов по каждому пользователю, а в репозитории лежат README, инфраструктура как код, CI с прогоном golden set, дашборд и runbook
- [ ] Я умею назвать стоимость одного ответа и p95 задержку по своим же метрикам

Следующая лекция — [ROI и защита бюджета](mlops/20-roi-i-zashchita-byudzheta.md). Проект готов; остаётся превратить его в строку в бюджете и в слова, которыми ты это защитишь перед руководством.