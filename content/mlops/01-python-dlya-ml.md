---
title: Python для ML-инженера
track: mlops
module: F. Python и основы ML
order: 1
duration: 85 мин
level: middle
tags: [python, venv, uv, типизация, asyncio, api]
summary: Как устроен Python-сервис вокруг LLM — изоляция окружения, фиксация зависимостей, асинхронные вызовы с ретраями, контракты данных и структурированные логи
practice: Собери мини-шлюз, который параллельно опрашивает 50 эндпоинтов с лимитом 10 одновременных запросов, экспоненциальным backoff с jitter, таймаутом 5 секунд и JSON-логами; проверь на httpbin-подобном стенде, что при 503 он делает ровно 3 попытки и не превышает лимит.
---

Всё, что ты делал в DevOps-треке, ты делал как инженер, который чинит систему. Здесь ты начинаешь делать то же самое, но **внутри** системы: писать и ревьюить код, который стоит между пользователем и моделью. Ключевое отличие Python от всего, что было раньше, в том, что это единственный язык, в котором живут ML-библиотеки, оркестраторы пайплайнов и SDK всех LLM-провайдеров. Переключиться с оркестратора на Python дорого, поэтому архитектурное решение «где живёт логика пайплайна» принимается именно здесь.

Эта лекция — не курс языка. Она про три вещи, которые тебе нужны как архитектору: **изоляция окружения** (чтобы твоя работа не положила прод-хост), **асинхронность** (потому что инференс — это ожидание, а не вычисление), **контракты данных** (потому что без них API-шлюз превращается в источник ночных инцидентов).

## Что тебе реально нужно знать из Python

Не всё. Ты не пишешь `loss`. Вот карта языка по степени применимости к твоей роли:

| Конструкция | Где встречается в ML/LLM-системах | Нужна ли тебе |
| --- | --- | :---: |
| Циклы, условия, списки, словари | скрипты пайплайна, постобработка, склеивание результатов | обязательно |
| Функции, замыкания, comprehensions | трансформации, фильтры, батчи | обязательно |
| Классы и `dataclass` | модели предметной области, DTO через границы сервисов | обязательно |
| Исключения, контекстные менеджеры (`with`) | ретраи, работа с файлами, соединениями | обязательно |
| Декораторы | таймауты, ретраи, кэш, трассировка | очень полезно |
| Генераторы и `yield` | потоковая обработка больших файлов, стриминг | очень полезно |
| `asyncio` | конкурентные вызовы LLM-API, GPU-инференса, очередей | обязательно в ML |
| Типизация (аннотации) | контракты между пайплайном, шлюзом и моделью | обязательно |
| Метаклассы, `__getattr__`, C-расширения | фреймворки, плагины | никогда |
| Многопоточность `threading` | почти никогда в Python; GIL делает её бессмысленной | нет |

Последняя строка таблицы — типичная ловушка. Если тебе в коде встретится `threading.Thread` для «ускорения», спроси автора: что именно здесь CPU-bound. В ML-сервисах почти всё либо I/O (сеть, диск, ожидание GPU), либо C-код под GIL (numpy, torch), и тогда ускорение даёт `multiprocessing` или `asyncio.to_thread`, а не потоки.

## Изоляция окружения: почему это вопрос безопасности

У тебя в контуре есть Ubuntu-хосты, на которых крутится прод. Один неверный `pip install` в системный Python — и через неделю какой-нибудь `apt` или внутренний скрипт падает с `ImportError`, потому что пакет подтянул несовместимую версию `numpy` в общее окружение. Причина в том, что Debian/Ubuntu ставят Python-пакеты в один общий каталог `/usr/lib/python3/dist-packages`, и туда пишут все, у кого есть права. Решение — **виртуальное окружение**: каталог с собственной копией интерпретатора- ссылками и своим каталогом пакетов.

`venv` — встроенный в любой CPython модуль, работает везде. `uv` — современный инструмент, который делает то же самое, но в разы быстрее и умеет ещё фиксировать версию Python.

```bash
# НЕ делай этого на прод-хосте:
# sudo pip install httpx

# Базовая изоляция — venv, есть в любой поставке Python 3
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install httpx pydantic

# Современный путь — uv: ставит интерпретатор, venv и пакеты за секунды
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python pin 3.12          # фиксирует версию Python в .python-version
uv venv                     # создаёт .venv
uv add httpx pydantic pydantic-settings structlog
uv add --dev pytest pytest-asyncio ruff mypy respx
uv sync                     # восстанавливает точное окружение из uv.lock
```

Сравнение инструментов, между которыми ты будешь выбирать:

| Инструмент | Скорость | Lock-файл | Управление версией Python | Автопочинка зависимостей | Вердикт в 2026 |
| --- | :---: | :---: | :---: | :---: | :---: |
| `pip` + `venv` | медленно | нет (только `pip freeze`) | нет | нет | базовый минимум, для CI-образов |
| `pip-tools` | медленно | `requirements.lock` | нет | нет | если команда уже на нём |
| `poetry` | средне | `poetry.lock` | частично | нет | мощный, но избыточный для сервисов |
| **uv** | **в 10–100 раз быстрее** | `uv.lock` | да (`uv python pin`) | частично | **рекомендация по умолчанию** |

`uv` заменил `pip install` целиком и использует Rust, поэтому даже `torch` с его многогигабайтными wheel'ами ставится в разы быстрее. Для твоего CI это значит, что время на «поставить зависимости» падает с минут до секунд — а в пайплайне из [трека C](devops/14-cicd-pipeliney.md) это самый дорогой этап кэширования.

## Фиксация зависимостей: три уровня строгости

Три разных файла решают три разные задачи, и путать их — источник инцидентов:

- **`pyproject.toml`** — объявление: какие пакеты нужны и в каких диапазонах версий. Читает человек, редактирует разработчик, в нём же настройки линтера и тестов.
- **`uv.lock` / `poetry.lock`** — точный снимок: конкретные версии, хеши, дерево зависимостей. Его **не редактируют** и **коммитят в репозиторий**. Это то, что делает сборку воспроизводимой.
- **`requirements.txt`** — выходной артефакт для сред, которые не умеют lock-файл: Docker-образы на старых базах, `pip install -r` в CI, кластеры с воздушным гэпом. Все версии запинены точно.

```bash
# Собрать запиненный requirements из pyproject
uv pip compile pyproject.toml -o requirements-prod.lock
uv pip compile pyproject.toml --extra dev -o requirements-dev.lock

# Увидеть, что изменилось, до того как мержишь
uv lock --check        # exit 0 — lock совпадает с pyproject
uv tree                # кто реально тянет requests 2.31

# Проверить уязвимости в зафиксированных версиях
uv pip audit -r requirements-prod.lock
```

Почему `uv.lock` обязателен в репозитории, а не «у каждого своё»: без него трое разработчиков в понедельник получат три разных набора пакетов, у всех троих пройдут тесты, у одного из них в проде сломается. Это воспроизводимость, о которой ты уже говорил в DevOps-треке — только теперь она касается не образа, а Python-зависимостей внутри него.

## Структура проекта: почему `src/`

Два варианта: плоский (`my_module.py` в корне) и `src/`-layout (весь код в `src/имя-пакета/`). Разница не в красоте, а в том, **откуда Python импортирует код во время разработки**.

При плоской структуре пакет лежит в текущем каталоге, и Python находит его всегда. С `src/` код в корень не попадает, и чтобы его увидеть, нужно **установить** пакет (`uv sync` или `pip install -e .`). Что это даёт:

| Ситуация | Плоский | `src/` |
| --- | --- | --- |
| Импорт из чужого пакета с тем же именем | подхватит ваш файл, ошибка в проде | импортирует правильный пакет |
| Проверка «а работает ли вообще собранное?» | невозможно | возможно |
| Тест случайно подмешивает модуль из `cwd` | да | нет |
| Лишние файлы попадают в wheel | да | нет |

```bash
uv init --package llm-gateway
cd llm-gateway

mkdir -p src/llm_gateway tests
touch src/llm_gateway/__init__.py

uv add httpx pydantic pydantic-settings structlog tenacity
uv add --dev pytest pytest-asyncio ruff mypy respx pytest-cov

uv run python -c "import llm_gateway; print(llm_gateway.__file__)"
# .../llm-gateway/src/llm_gateway/__init__.py  <- установленный пакет, а не файл в cwd

uv run pytest -q
```

Итоговое дерево, на которое ты будешь ссылаться в ревью:

```
llm-gateway/
├── pyproject.toml          # зависимости + конфиг ruff/mypy/pytest
├── uv.lock                 # точная фиксация, коммитится
├── .python-version         # 3.12
├── .env.example            # образец переменных, БЕЗ секретов
├── src/
│   └── llm_gateway/
│       ├── __init__.py
│       ├── config.py       # pydantic-settings, чтение окружения
│       ├── schemas.py      # pydantic-модели запроса/ответа
│       ├── client.py       # async-вызов LLM с ретраями
│       └── logging_conf.py # настройка JSON-логов
├── tests/
│   ├── conftest.py         # фикстуры: клиент, настройки, мок
│   ├── test_client.py
│   └── test_schemas.py
├── Dockerfile
└── .github/workflows/ci.yml
```

## Почему инференсу нужна асинхронность

Вот ключевой факт, который определяет всю архитектуру ML-сервиса: **вызов LLM-API не нагружает CPU**. Твой процесс отправил HTTP-запрос и теперь ждёт — сеть, прокси, токенизация на стороне провайдера, генерация токенов на GPU. Это **I/O-bound** работа: полезной вычислительной работы почти ноль, а процесс всё это время висит.

Последовательный код при 50 запросах, каждый по 2 секунды, отработает за 100 секунд. Параллельный — за 4–5 секунд при десяти одновременных соединениях. Для батч-задачи «оценить 50 документов» это разница между «пользователь ждёт» и «сервис непригоден».

Три элемента, которых тебе достаточно:

```python
import asyncio

async def ask(url: str, payload: dict, sem: asyncio.Semaphore) -> dict:
    async with sem:                      # ограничиваем конкурентность
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=10.0)
            return resp.json()

async def main() -> None:
    sem = asyncio.Semaphore(10)          # не больше 10 одновременных вызовов
    urls = [f"https://api.internal/v1/doc/{i}" for i in range(50)]
    results = await asyncio.gather(*(ask(u, {}, sem) for u in urls))
    print(len(results))
```

- `async def` / `await` — «здесь можно подождать, не блокируя остальных».
- `asyncio.gather` — запустить всё сразу и дождаться всех.
- `asyncio.Semaphore` — **счётчик одновременных операций**. Это то, что спасает тебя от `429 Too Many Requests` и от того, что ты обрушишь чужой (или свой) inference-кластер одним батчем.

> [!IMPORTANT]
> `Semaphore` ограничивает **свой** код. У `httpx` есть свой пул соединений, у vLLM — свой лимит на параллельные sequences, у облачного API — свой rate limit на ключ. Семафор не знает про них. Твоя задача — держать **три** лимита согласованными: `Semaphore` в коде, `limits=` в клиенте, лимит на стороне провайдера.

Если внутри `async def` встречается CPU-bound работа (чанковый токенизатор на Python, рендер PDF, подсчёт метрик), она **блокирует event loop** — все остальные задачи встанут. Выноси в поток:

```python
import asyncio

def cpu_heavy(text: str) -> dict:
    ...  # что-то на чистом Python, без await

async def pipeline(text: str) -> dict:
    return await asyncio.to_thread(cpu_heavy, text)
```

## Рабочий мини-сервис: параллельный опрос с ретраями

Это тот код, который ты будешь ревьюить чаще всего. Собери его целиком — он покрывает ретраи, backoff с jitter, таймаут, лимит конкурентности и частичные отказы.

```python
import asyncio
import random
import time
from typing import Any

import httpx
import structlog

log = structlog.get_logger("probe")

def backoff(attempt: int, cap: float = 8.0) -> float:
    """Экспонента с полным jitter: задержка = случайное из [0, min(2**n, cap)]."""
    return random.uniform(0.0, min(2 ** attempt, cap))

async def probe_one(
    client: httpx.AsyncClient,
    url: str,
    sem: asyncio.Semaphore,
    attempts: int = 3,
    timeout: float = 5.0,
) -> dict[str, Any]:
    async with sem:
        for attempt in range(1, attempts + 1):
            started = time.perf_counter()
            try:
                resp = await client.get(url, timeout=timeout)
                resp.raise_for_status()
                return {
                    "url": url,
                    "status": resp.status_code,
                    "latency_ms": round((time.perf_counter() - started) * 1000),
                    "attempt": attempt,
                }
            except (httpx.TimeoutException, httpx.HTTPStatusError) as exc:
                log.warning(
                    "probe_failed",
                    url=url,
                    attempt=attempt,
                    error=type(exc).__name__,
                    status=getattr(getattr(exc, "response", None), "status_code", None),
                )
                if attempt == attempts:
                    return {"url": url, "status": None, "attempt": attempt, "error": "exhausted"}
                await asyncio.sleep(backoff(attempt - 1))

async def probe_all(urls: list[str], concurrency: int = 10) -> list[dict[str, Any]]:
    sem = asyncio.Semaphore(concurrency)
    limits = httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency)
    async with httpx.AsyncClient(limits=limits, headers={"user-agent": "probe/1.0"}) as client:
        return await asyncio.gather(*(probe_one(client, u, sem) for u in urls))

async def main() -> None:
    urls = [f"https://api.internal/v1/health/instance-{i}" for i in range(50)]
    started = time.perf_counter()
    results = await probe_all(urls, concurrency=10)
    ok = sum(1 for r in results if r.get("status") == 200)
    log.info("probe_done", total=len(results), ok=ok,
             wall_s=round(time.perf_counter() - started, 2))
```

Три решения внутри, которые ты должен уметь объяснить в ревью:

- **Jitter обязателен.** Без него все клиенты, упавшие в 03:00 одновременно, повторят запросы в 03:00:01 — это гарантированный вторичный шторм. Случайность размазывает ретраи.
- **Ловим только сетевые ошибки и HTTP-статусы.** Исключение `KeyError` внутри обработки ретраями ретраить нельзя — оно уронит весь `gather`. Именно поэтому «частичный отказ» возвращается словарём, а не бросается наружу.
- **`httpx.Limits` дублирует семафор.** Намеренно: одна настройка ограничивает приложение, вторая — уровень сокета. Снятие одного лимита не должно обрушивать вторую стену.

Про `httpx` против `aiohttp` — выбор, который тебе зададут на ревью:

| Критерий | `httpx.AsyncClient` | `aiohttp.ClientSession` |
| --- | --- | --- |
| HTTP/2 | из коробки | только через плагин |
| Таймауты | раздельные на connect/read/write/pool, удобно читаются | числовой параметр, менее гибко |
| API для синхрона и асинхрона | **одинаковый** — тот же клиент в тестах | разные API, тесты пишутся иначе |
| Зависимости | `httpcore` + `h11`/`h2` | тяжелее, тянет свою реализацию |
| Поддержка сообществом | активная, используется в LangChain/LlamaIndex | стабильная, но уже не первая |
| Вердикт | **выбор по умолчанию** | если нужна уже интегрированная в проект библиотека |

## Контракты данных: почему это не «для красоты»

В пайплайне данные проходят через десятки границ: выгрузка из БД → нормализация → эмбеддинг → векторная БД → API → логирование. На каждой границе данные теряют типы. Что было `list[dict[str, Any]]`, превращается в `{"items": [...]}`, потом в `None`, потом в строку `"None"`. Ошибка всплывает через три деплоя в проде, и найти её почти невозможно.

Решение — **валидируемые контракты на границе**. `pydantic` описывает форму данных и проверяет её в момент парсинга, а не через три сервиса.

```python
from pydantic import BaseModel, Field, field_validator

class LLMRequest(BaseModel):
    model: str
    prompt: str = Field(min_length=1, max_length=32_000)
    temperature: float = 0.2
    max_tokens: int = Field(default=512, ge=1, le=8192)

    @field_validator("temperature")
    @classmethod
    def check_temp(cls, v: float) -> float:
        if not 0.0 <= v <= 2.0:
            raise ValueError("temperature вне диапазона [0, 2]")
        return v

class LLMResponse(BaseModel):
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str

req = LLMRequest.model_validate(json.loads(raw))   # упадёт тут, а не в проде
```

Три уровня контрактов, которые стоит различать при ревью:

| Инструмент | Валидация при создании | Сериализация | Строки в лог | Когда брать |
| --- | :---: | :---: | :---: | --- |
| `dict` / `TypedDict` | нет | нет | вся структура | черновик, внутренние функции |
| `dataclass` | нет (только тайп-чекер) | нет | все поля | внутренние структуры, где важнее скорость, чем валидация |
| **`pydantic.BaseModel`** | **да, сразу** | `.model_dump()` | безопасный `repr` | **всё, что пересекает границу** |

> [!TIP]
> Второй вариант — `pydantic` на входе и `dataclass` внутри. Внешний мир непредсказуем, внутренний код под твоим контролем. Валидируй один раз на границе, дальше работай с дешёвыми структурами.

Переменные окружения — та же история, только про конфигурацию. Никогда не читай `os.environ["KEY"]` напрямую: отсутствующая переменная уронит процесс с `KeyError` без понятного сообщения, а опечатка в значении пройдёт незамеченной.

```python
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="GATEWAY_", extra="ignore")

    upstream_url: str = "https://api.internal/v1"
    upstream_token: SecretStr                     # при печати покажет ****
    timeout_s: float = 5.0
    max_concurrency: int = 10
    retries: int = 3

    @property
    def token(self) -> str:
        return self.upstream_token.get_secret_value()

settings = Settings()
print(settings)   # upstream_token=SecretStr('**********') — в лог утечёт не может
```

`SecretStr` — дешёвая, но критичная привычка. Любой, кто засветит токен в лог или в трейс, автоматически его скомпрометирует, и это самая частая причина ротации ключей в проектах.

## Линт, типы, тесты: три страховки за минуту

Одна команда `ruff` заменяет `flake8`, `isort`, `black` и `pyupgrade`.

```bash
uv run ruff check .          # ошибки, неиспользуемый код, async-антипаттерны
uv run ruff check --fix .   # применить автоисправления
uv run ruff format .        # форматирование
uv run mypy src/            # статическая проверка типов
uv run pytest -q --cov=src --cov-report=term-missing
```

Что проверять в ML-сервисах, а что — нет:

| Объект | Тестируем | Не тестируем |
| --- | --- | --- |
| Ретраи и таймауты | детерминированно, через `respx` | реальная сеть |
| Парсинг и валидация ответов | фикстурами с реальными JSON-примерами | — |
| Логика батчинга и чанкинга | на маленьких фикстурах | на корпусе целиком |
| Сама модель LLM | **никогда** в CI — дорого и недетерминированно | всё |
| Стоимость вызова | считается в коде, тестируется как чистая функция | — |

```python
import asyncio
import pytest
from httpx import Response
import respx

from llm_gateway.client import probe_one

@pytest.mark.asyncio
@respx.mock
async def test_retries_then_succeeds():
    route = respx.get("https://api.internal/v1/health/instance-0").mock(
        side_effect=[Response(503), Response(200)]
    )
    sem = asyncio.Semaphore(1)
    result = await probe_one(
        client=_client(), url=str(route.calls[0].request.url),
        sem=sem, attempts=3, timeout=1.0, sleep=lambda d: asyncio.sleep(0),
    )
    assert result["status"] == 200
    assert route.call_count == 2      # 503, потом успех — и всё
```

Ключевая мысль для архитектуры: **детерминированность тестов достигается подменой сети, а не ожиданием её**. Тест, который ходит в реальный API, завтра упадёт из-за чужого инцидента, и команда начнёт его перезапускать, а потом и отключать.

## Управление памятью: почему ML-код течёт

Python освобождает память сам, но не всегда вовремя. В ML-сервисах утечки предсказуемы, и все три источника — в твоей власти:

| Источник утечки | Как выглядит | Лечение |
| --- | --- | --- |
| Данные целиком в памяти | `open(f).read()`, `json.loads(whole_file)` | стримить по батчам |
| Списки вместо генераторов | накопление эмбеддингов всех документов | `yield`, обрабатывать порциями |
| Кэш, который никто не чистит | `@lru_cache(maxsize=None)` на тяжёлой функции | задать `maxsize` |
| GPU-память | накопление тензоров между запросами | `del`, `torch.cuda.empty_cache()` |
| Фрагментация | `PYTHONMALLOC=malloc` | пиновать версию Python |

```python
import gc

def read_batches(path: str, size: int = 256):
    """Генератор: в памяти никогда не больше size строк."""
    buf: list[str] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            buf.append(line.strip())
            if len(buf) >= size:
                yield buf
                buf = []
    if buf:
        yield buf

vectors = []
for batch in read_batches("corpus.txt", size=256):
    vectors.extend(embed_batch(batch))     # эмбеддим только батч
    gc.collect()                          # не магия, а осознанное решение
```

> [!CAUTION]
> `gc.collect()` в горячем пути — антипаттерн, он жрёт CPU. Здесь он стоит, потому что ты осознанно отпускаешь батч между итерациями. В event loop внутри `async def` вызывать его нельзя: пауза блокирует все остальные задачи.

## Где это ломается

1. **`pip install` без `venv` на Ubuntu-хосте.** Один запуск — и через неделю падает чужой сервис. Восстановление идёт через `apt reinstall` и отнимает вечер.
2. **Нет lock-файла в репозитории.** У CI, у разработчика и в проде разные версии пакетов. Классика — «у меня локально работает».
3. **Ретраи без jitter.** Синхронный шторм: 50 клиентов падают в 03:00 и все повторяют в 03:00:01. Второй шторм гарантирован.
4. **`asyncio.gather` без `return_exceptions=True`.** Один таймаут из 50 запросов убивает весь батч, хотя остальные 49 могли бы вернуться.
5. **CPU-bound работа внутри `async def`.** Токенизация на Python блокирует event loop — p99 латентность улетает в десятки раз, и ты ищешь причину не там.
6. **Токен в логе или в `repr` модели.** Один `print(settings)` со строкой вместо `SecretStr` — и ключ уехал в Loki навсегда.
7. **`requirements.txt` без пинов.** `pandas>=2.0` через полгода притянет 3.x и сломает код на ровном месте — но уже не у тебя.
8. **Датасет целиком в памяти из-за `.read()`.** Сервис падает по памяти только под нагрузкой, и только на больших файлах — в тестах на маленьких всё «работает».
9. **Тесты, ходящие в реальный LLM-API.** Они дорогие, медленные и ломаются от чужих инцидентов. Команда начинает их пропускать, и через месяц не остаётся ничего.

## Чек-лист понимания

- [ ] Я понимаю, зачем нужно виртуальное окружение, и не установлю пакет в системный Python на сервере
- [ ] Я различаю `pyproject.toml`, lock-файл и `requirements.txt` и знаю, какой из них коммитится, а какой генерируется
- [ ] Я могу объяснить, почему инференс — это I/O-bound, и прикинуть прирост от `asyncio.gather` на своей задаче
- [ ] Я знаю, зачем нужен `asyncio.Semaphore` и чем его лимит отличается от лимита пула соединений и rate limit провайдера
- [ ] Я прочитал код с ретраями и могу сказать, зачем в `backoff` случайность, а не фиксированная задержка
- [ ] Я выбираю между `httpx` и `aiohttp` и обосновываю выбор
- [ ] Я знаю, где в проекте применяется `pydantic`, а где достаточно `dataclass`, и понимаю, зачем `SecretStr`
- [ ] Я умею найти утечку памяти в Python-коде и знаю, чем стриминг отличается от чтения целиком

Дальше — про то, почему эти сервисы считают не числами, а матрицами, и как читать график обучения, не имея степени по математике: [Математика без формул](mlops/02-matematika-bez-formul.md).