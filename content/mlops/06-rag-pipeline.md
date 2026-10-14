---
title: RAG-пайплайн
track: mlops
module: G. Данные и RAG
order: 6
duration: 95 мин
level: middle
tags: [rag, чанкинг, retrieval, reranking, hybrid search]
summary: Полный путь от файла до цитатируемого ответа: чанкинг с перекрытием, структура чанка, reranking кросс-энкодером, гибридный поиск через RRF, выбор top-k и генерация с отказом — с рабочим кодом, который поднимается на твоём ноутбуке
practice: Собери минимальный RAG на 30 документах: загрузка → структурный чанкинг → эмбеддинги → Qdrant в Docker → поиск top-10 → rerank → генерация через Ollama с цитатами. Сравни ответы с rerank и без, с overlap 0 и 200, и выпиши разницу.
---

У тебя есть корпус, есть эмбеддинги, есть векторная база. Осталось превратить это в работающий ассистента, и именно на этом участке RAG ломается чаще всего. Потому что векторный поиск — это не «поиск ответа», а поиск похожих кусков текста. Между «похожий кусок» и «нужный кусок» стоят чанкинг, ранжирование, число отобранных фрагментов и промпт. Эта лекция — самый практический модуль трека: здесь будет код, который ты запускаешь локально и получаешь работающий прототип.

## Зачем вообще RAG

Три причины, каждая из которых на практике важнее остальных.

1. **Модель не знает твою специфику.** Никакая языковая модель не знает, что у вас в 2024 году был переезд ЦОД и теперь сетевые адреса начинаются с 10.20, а не 10.10. Дообучение модели — это месяцы и GPU-кластер; RAG — это вечер работы и 200 долларов на эмбеддинги.
2. **Модель устаревает, документ — нет.** Модель переобучают раз в год, регламент безопасности меняется каждый месяц. При RAG обновляется документ, и индекс пересобирается инкрементально.
3. **Проверяемость и юридическая чистота.** Ответ со ссылкой на внутренний документ можно проверить, зааудировать и предъявить регулятору. Ответ, рождённый из параметров модели, проверить нельзя вообще.

Цена, которую ты за это платишь, известна заранее: **качество RAG ограничено качеством retrieval'а**, а не модели. Если ретривер не нашёл нужный документ, никакая модель — хоть GPT-5 — ответит правильно. Из этого следует всё остальное: сначала измеряй и чини поиск, генерацию трогай потом.

## Анатомия: два контура

RAG — это два независимых контура, которые пересекаются в одном месте — в векторной базе.

**Контур индексации** (офлайн, по расписанию из [лекции о данных](mlops/04-dannye-i-pipeliney.md)): загрузка → очистка → чанкинг → эмбеддинги → запись в векторную базу.

**Контур запроса** (онлайн, на каждый вопрос): переформулировка запроса → поиск кандидатов (top-20…50) → reranking → отбор top-k → сборка промпта → генерация → сборка цитат.

Ошибка в архитектуре, которую я вижу чаще всего, — **попытка сделать эти контуры одной транзакцией**. Нельзя. Индексация идёт по расписанию, запрос идёт по нажатию. Единственная точка синхронизации — снапшот коллекции. И это хорошо: именно поэтому переключение алиса из [прошлой лекции](mlops/04-dannye-i-pipeliney.md) даёт атомарную смену корпуса без даунтайма.

## Чанкинг: три стратегии

Чанк — это единица, которая уходит в эмбеддинг. Его размер определяет две вещи сразу: какие вопросы он сможет закрыть и сколько мусора попадёт в контекст.

**Фиксированный размер** — режет текст по N токенов с шагом N−overlap. Простой, предсказуемый, не зависит от структуры. Проблема в том, что режет по границам слов и абзацев: чанк может содержать конец одной главы и начало другой, и смысл у него соответствующий.

**По структуре** — режет по заголовкам. В markdown, Confluence и HTML заголовки есть всегда, и раздел документа — это уже готовый, осмысленный, семантически цельный юнит. Для технической документации это лучший вариант по умолчанию.

**Семантический** — режет по смене смысла (переход, новая тема). Лучший результат, но в 10–50 раз дороже и нестабильнее, потому что зависит от эмбеддингов до этапа эмбеддингов. В корпоративном RAG почти никогда не нужен.

| Стратегия | Когда применять | Размер чанка | Плюс | Минус |
| --- | --- | :---: | --- | --- |
| Фиксированный | нет структуры, логи, чат, письма | 300–600 токенов | предсказуемо, дёшево | рвёт смысл на полуслове |
| По структуре | документация, Confluence, runbook'и | по разделу, cap 800–1000 токенов | чанк = осмысленный раздел | раздел может быть на 50 страниц |
| Гибрид | почти всегда | структура, потом добить длинные разделы | баланс | чуть сложнее в коде |
| Семантический | исследования, длинные отчёты | по теме | лучший recall | дорого, нестабильно |

```python
# /opt/rag-pipeline/chunker.py — гибридный чанкер: по структуре, с добором длинных разделов
import re
from dataclasses import dataclass, field

import tiktoken

ENC = tiktoken.get_encoding("cl100k_base")     # счётчик токенов OpenAI; для других моделей — свой


@dataclass
class Chunk:
    chunk_id: str
    text: str
    metadata: dict = field(default_factory=dict)


def ntok(s: str) -> int:
    return len(ENC.encode(s))


HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


def split_markdown(text: str, max_tokens: int = 800, min_tokens: int = 120,
                   overlap: int = 100) -> list[tuple[str, str]]:
    """Возвращает список (заголовок_раздела, текст_раздела)."""
    sections, cur, head = [], [], "Документ"
    for line in text.splitlines():
        m = HEADING.match(line)
        if m:
            if cur and ntok("\n".join(cur)) >= min_tokens:
                sections.append((head, "\n".join(cur)))
            cur, head = [], m.group(2).strip()
            if m.group(1) == "#" and head != "Документ":
                head = m.group(2).strip()
        cur.append(line)
    if cur and ntok("\n".join(cur)) >= min_tokens:
        sections.append((head, "\n".join(cur)))
    return sections


def hard_split(text: str, max_tokens: int, overlap: int) -> list[str]:
    """Аварийный разрез слишком большого раздела — по предложениям, с перекрытием."""
    tokens = ENC.encode(text)
    step = max(1, max_tokens - overlap)
    out = []
    for i in range(0, len(tokens), step):
        piece = ENC.decode(tokens[i:i + max_tokens])
        if ntok(piece) > 20:
            out.append(piece)
        if i + max_tokens >= len(tokens):
            break
    return out


def chunk_document(text: str, doc_id: str, meta: dict,
                   max_tokens: int = 800, overlap: int = 100) -> list[Chunk]:
    chunks, n = [], 0
    for heading, body in split_markdown(text, max_tokens, overlap=overlap):
        pieces = [body] if ntok(body) <= max_tokens else hard_split(body, max_tokens, overlap)
        for piece in pieces:
            n += 1
            chunks.append(Chunk(
                chunk_id=f"{doc_id}::{n:04d}",
                text=piece,
                metadata={
                    **meta,
                    "doc_id": doc_id,
                    "chunk_no": n,
                    "section": heading,
                    "n_tokens": ntok(piece),
                },
            ))
    return chunks
```

### Перекрытие: зачем нужны 15–25% и что они стоят

Посмотри на границу двух чанков. Если разрез прошёл по середине предложения, первый чанк заканчивается на «...для этого нужно указать», второй начинается с «...адрес почты администратора в поле». По отдельности оба фрагмента бессмысленны. Модель, увидевшая только второй, не поймёт, о чём речь: ключевое слово «поле» — это и есть запрос.

**Overlap** решает эту проблему: последние 100–150 токенов каждого чанка дублируются в начало следующего. Цена — рост индекса на 15–25% и риск дублирования в выдаче (одна и та же цитата дважды в контексте).

| Размер чанка | Overlap | К индексации | Что даёт |
| ---: | :---: | :---: | --- |
| 300 токенов | 50 | +17% | страховка от разрыва фразы |
| 500 токенов | 100 | +20% | рабочий дефолт для документации |
| 800 токенов | 150 | +19% | для длинных разделов |
| 2000 токенов | 300 | +18% | много шума, лучше не надо |

> [!IMPORTANT]
> Overlap больше не спасает, если чанк режется в середине **таблицы** или **списка**: структура теряется полностью, потому что её границы не совпадают с границами токенов. Для таблиц нужен отдельный путь: каждая строка таблицы либо становится отдельным чанком, либо присоединяется к чанку с её заголовком.

### Слишком маленькие и слишком большие чанки

Маленький чанк (100 токенов) содержит ровно одно предложение. Эмбеддинг получается острым, но он теряет контекст: «вот так делаем» без «это делается при смене IP-адреса». Вопрос «как поменять адрес» не найдёт его, потому что вектор смещён в сторону «делать».

Большой чанк (3000 токенов) содержит всё сразу. Вектор становится размытым — он усредняет пять тем. Поиск находит его часто, но он занимает 4k токенов контекста и размывает внимание модели.

Рабочий диапазон для технической документации: **300–800 токенов**, а для коротких справочных статей Confluence — 200–400.

| Симптом | Вероятная причина | Что делать |
| --- | --- | --- |
| recall@5 низкий, top-1 — огромный «обзорный» чанк | чанки слишком большие | уменьшить max_tokens до 500 |
| В ответах нет конкретики, модель цитирует общие фразы | чанки мелкие, потерян контекст | увеличить max_tokens или склеивать соседние чанки одного раздела |
| Много дублей цитат в ответе | слишком большой overlap | снизить overlap до 100–150 |
| Модель отвечает «в документе не сказано» при верном документе | чанк обрезан по границе фразы | поднять overlap до 200 |

## Анатомия чанка: метаданные и инъекция заголовка

Без метаданных чанк — это безымянный кусок текста. Пользователю нечего показать в качестве источника, а фильтровать по отделу нечем. Минимальный набор полей описан в [лекции об эмбеддингах](mlops/05-embedding-i-vektory.md); здесь важнее другое — **как метаданные попадают в сам текст**.

Практика, которая даёт заметный прирост к качеству: **инъекция заголовка в текст перед эмбеддингом и перед подачей в LLM**.

```python
def render_chunk_for_embedding(chunk: Chunk) -> str:
    """То, что уходит в модель эмбеддингов."""
    m = chunk.metadata
    return (f"Заголовок документа: {m['title']}\n"
            f"Раздел: {m['section']}\n"
            f"Текст: {chunk.text}")


def render_chunk_for_prompt(chunk: Chunk, idx: int) -> str:
    """То, что попадает в контекст LLM, вместе с номером для цитат."""
    m = chunk.metadata
    return (f"[{idx}] Документ: {m['title']}\n"
            f"Раздел: {m['section']}\n"
            f"Обновлён: {str(m.get('updated_at'))[:10]}\n"
            f"Источник: {m['url']}\n"
            f"---\n{chunk.text}")


def render_chunk_for_reranker(query: str, chunk: Chunk) -> tuple[str, str]:
    """Reranker-содержимое: запрос + документ одной строкой, без метаданных."""
    return query, chunk.text
```

Почему это улучшает ответ, а не только вид:

- **Для эмбеддинга.** Два раздела про «лимиты» из разных документов без заголовков дают почти одинаковые векторы. С заголовками — разные: «Лимиты API» и «Лимиты памяти» разводятся.
- **Для генерации.** Раздел документа — это указание модели, о чём именно этот фрагмент. Без него модель вынуждена догадываться и часто приписывает чанку чужую тему, а затем галлюцинирует.

> [!CAUTION]
> Заголовок инжектится в текст **на обоих этапах**. Если он попал в эмбеддинг, но не попал в промпт — вектор и контекст описывают разное. Если попал в промпт, но не в эмбеддинг — поиск работает, а модель не видит рамки. Расхождение здесь даёт «модель отвечает не по тому разделу», которое чинится месяцами.

## Retrieval: кандидаты

Векторный поиск по эмбеддингу запроса возвращает top-N кандидатов. Здесь важна цифра N: **N должно быть в 3–5 раз больше, чем k**, потому что дальше будет reranking. Если финальный контекст — 5 чанков, кандидатов бери 20–30.

```python
# Один векторный запрос — это базовая линия, с которой сравнивают всё остальное
def retrieve_dense(question: str, user_groups: list[str], n: int = 30) -> list[dict]:
    qv = embed_query(question)
    res = client.query_points(
        collection_name=COLLECTION,
        query=qv.tolist(),
        limit=n,
        search_params=models.SearchParams(hnsw_ef=192),
        query_filter=models.Filter(must=[
            models.FieldCondition(key="acl_groups",
                                  match=models.MatchAny(any=user_groups)),
        ]),
        with_payload=True,
    )
    return [{"id": str(p.id), "text": p.payload["content"], **p.payload} for p in res.points]
```

Три практических настройки, которые стоит замерить на golden set:

- **`hnsw_ef`** — 128 для чернового прогона, 256 для финального. Влияет на MRR на 2–4 пункта.
- **`score_threshold`** — отсекает совсем слабые совпадения. Полезно для случая «в базе нет ответа»: если максимальный score ниже порога, ты честно отвечаешь «не нашёл», а не скармливает модели мусор.
- **Фильтры до поиска** — обязательный ACL-фильтр из [прошлой лекции](mlops/05-embedding-i-vektory.md).

## Reranking: почему векторный поиск недостаточен

Разберём, что делает эмбеддинг. Он кодирует запрос и документ **независимо**. Запрос «как сбросить пароль в AD» превращается в точку, документ «Восстановление доступа» — в другую точку. Между ними нет интеракции: модель не знает, что именно в документе отвечает на «сбросить пароль».

Поэтому векторный поиск хорошо находит **тематически похожее** и плохо — **прямо отвечающее на вопрос**. Два типа ошибок:

- Вопрос «как настроить резервирование контроллера домена». Найдены: «Резервное копирование Exchange» (тема «резервное копирование» совпала), «Настройка DNS-зон» (тема «настройка»), «Резервное копирование AD» (нужный документ) — на 4-м месте.
- Вопрос «код ошибки 0x80072EE2». Семантически в документе про «не удаётся подключиться к серверу» нет ни одного общего слова, но именно он отвечает.

Кросс-энкодер решает это принципиально иначе: он берёт пару **(запрос, документ) целиком** и выдаёт одну оценку релевантности. Это медленно — вся пара проходит через трансформер, — но точность заметно выше, потому что модель видит их взаимодействие.

| | Би-энкодер (эмбеддинг) | Кросс-энкодер (reranker) |
| --- | --- | --- |
| Что кодирует | запрос и документ по отдельности | пару целиком |
| Скорость | 10 тыс. документов в секунду на GPU | 50–500 пар в секунду на GPU |
| Использование | поиск по всему корпусу | переупорядочивание 20–50 кандидатов |
| Что выбирают | базу кандидатов | финальный порядок |

```python
# /opt/rag-pipeline/rerank.py
from sentence_transformers import CrossEncoder

# Загружается один раз при старте процесса, ~600 МБ RAM
RERANKER = CrossEncoder("BAAI/bge-reranker-v2-m3", max_length=1024)


def rerank(query: str, candidates: list[dict], top_k: int = 8) -> list[dict]:
    if not candidates:
        return []
    # Текст чанка можно обрезать: reranker всё равно смотрит на первые ~512 токенов,
    # а длинные хвосты только съедают latency.
    pairs = [(query, c["text"][:2000]) for c in candidates]
    scores = RERANKER.predict(pairs, batch_size=32, show_progress_bar=False)
    ranked = sorted(zip(candidates, scores), key=lambda p: -float(p[1]))
    out = []
    for c, s in ranked[:top_k]:
        c = {**c, "rerank_score": float(s)}
        out.append(c)
    return out
```

> [!IMPORTANT]
> Reranker — самая дешёвая точка прироста качества во всём RAG. На типичном корпусе он поднимает MRR с 0.68 до 0.83 и recall@5 с 0.79 до 0.90 **без единого изменения в данных и эмбеддингах**. Единственная цена — 200–600 мс латентности и ~1,5 ГБ RAM на процесс. Если у тебя одна задача в бэклоге RAG, пусть это будет реранкер.

Осторожно с моделью: русскоязычный reranker подходит не всякий. Проверяй на golden set всегда, потому что модель, отличная на английском, может вести себя непредсказуемо на русских формулировках с техническими терминами.

## Гибридный поиск и RRF

Векторный поиск плохо работает с точными совпадениями: номера ошибок, имена хостов, артикулы, номера документов, редкие аббревиатуры. Зато BM25 по словам работает с ними идеально. И наоборот — BM25 не понимает синонимов и не найдёт «сброс пароля» по слову «восстановление доступа».

Гибридный поиск объединяет оба, и прирост на реальных корпоративных корпусах — 5–15 процентных пунктов recall.

Способ объединения, который не требует нормализации скоров, — **RRF (Reciprocal Rank Fusion)**. Вместо того чтобы сравнивать «cosine 0.83 против BM25 14.2», ты сравниваешь **места**: `score = сумма по ранжированиям 1 / (k + rank)`.

```python
# /opt/rag-pipeline/hybrid.py
from collections import defaultdict


def rrf_fuse(rankings: list[list[dict]], k: int = 60, top_k: int = 20) -> list[dict]:
    """rankings: список выдач от разных систем, каждая — [{'chunk_id':..., 'text':..., ...}]"""
    scores: dict[str, float] = defaultdict(float)
    merged: dict[str, dict] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            cid = item["chunk_id"]
            scores[cid] += 1.0 / (k + rank)      # k=60 — стандарт, гасит выбросы на первых местах
            merged.setdefault(cid, {**item, "fused_score": 0.0})
            merged[cid]["fused_score"] = scores[cid]
    return sorted(merged.values(), key=lambda x: -x["fused_score"])[:top_k]
```

```sql
-- Вторая половина hybrid — полнотекстовая выдача из Postgres (из лекции об эмбеддингах)
-- Планы Postgres + RRF добавлены в PostgreSQL 15+, поле __score
SELECT
    chunk_id, content, score
FROM (
    SELECT chunk_id, content,
           ts_rank_cd(tsvector, websearch_to_tsquery('russian', $1)) AS score
    FROM doc_chunks
    WHERE acl_groups && $2::text[]
      AND tsvector @@ websearch_to_tsquery('russian', $1)
    ORDER BY score DESC
    LIMIT 30
) AS bm25
ORDER BY bm25.score DESC;
```

```python
# Сборка гибридной выдачи: dense + BM25 + RRF + reranker поверх
def retrieve_and_rerank(question: str, user_groups: list[str], final_k: int = 8) -> list[dict]:
    dense = retrieve_dense(question, user_groups, n=30)
    sparse = search_bm25(question, user_groups, n=30)
    fused = rrf_fuse([dense, sparse], k=60, top_k=40)
    return rerank(question, fused, top_k=final_k)
```

## Переформулировка запроса

Пользователь пишет «а как там с резервированием АД», а в базе написано «Windows Server Backup: резервное копирование контроллера домена». Два приёма:

- **Раскрытие аббревиатур и синонимов** через словарь домена. Это дешёвый и надёжный вариант: словарь на 50–100 терминов твоей компании даёт больше, чем любой LLM-рерайтер.
- **LLM-рерайтер**: модель переписывает вопрос в один-два поисковых запроса. Работает, но добавляет 300–800 мс и ещё одну точку отказа. Включай, когда доменного словаря не хватает.

```python
QUERY_REWRITES = {
    "резервирование ад": "резервное копирование контроллера домена Active Directory Windows Server Backup",
    "сброс пароля": "восстановление пароля учётной записи AD net user сброс пароля",
    "0x80072ee2": "не удаётся подключиться к серверу ошибка таймаут winhttp прокси",
}

def expand_query(q: str) -> list[str]:
    variants = [q]
    ql = q.lower()
    for short, long in QUERY_REWRITES.items():
        if short in ql:
            variants.append(ql.replace(short, long))
    return variants
```

## Сколько контекста класть в промпт

Здесь работает контринтуитивное правило: **больше контекста не значит лучше ответ**.

Причина — «потеря в середине». Внимание модели распределено неравномерно по длинному контексту: начало и конец цитируются хорошо, середина — плохо. Классический эксперимент (Liu et al., «Lost in the Middle») показывает резкое падение точности, когда нужный факт находится в середине 30-киломенного контекста.

| top-k | Токенов контекста | Что происходит |
| ---: | :---: | --- |
| 3 | ~1500 | мало шума, но рискно: нужный факт мог не попасть в выдачу |
| **5–8** | **~4000** | рабочий диапазон для большинства задач |
| 15 | ~8000 | +2k мусора, модель начинает путать источники |
| 30 | ~16000 | цитаты мешают друг другу, растут галлюцинации и latency |

Компромисс управляется двумя ручками: **rerank решает, что попадёт в топ**, и **score_threshold решает, попадёт ли туда хоть что-то**. Если после ранжирования максимальный score низкий — не подставляй контекст вообще, а верни отказ.

## Генерация: промпт, цитаты, отказ

Промпт RAG — это не «объясни модель, как работать», а жёсткий контракт: отвечать только из контекста, иначе сказать, что не знает.

```python
SYSTEM_PROMPT = """Ты — внутренний ассистент по документации компании.
Правила, которые нельзя нарушать:
1. Отвечай ТОЛЬКО на основе приведённого фрагментов документов.
2. Если в фрагментах нет ответа — так и напиши: "В документации не нашёл ответа на этот вопрос."
   Не используй свои знания и не делай предположений.
3. Каждое утверждение снабжай ссылкой на источник в формате [1], [2].
4. Не выдумывай номера версий, даты, имена и идентификаторы.
5. Если фрагменты противоречат друг другу — скажи об этом и приведи оба.
6. Отвечай на языке вопроса, кратко, без вступлений вроде "Конечно"."""

USER_PROMPT = """Вопрос: {question}

Фрагменты документов:
{context}

Ответь на вопрос, опираясь только на фрагменты."""
```

```python
# /opt/rag-pipeline/generate.py
from openai import OpenAI

client_llm = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")  # Ollama, OpenAI-совместимый


def answer(question: str, chunks: list[dict], model: str = "qwen2.5:7b-instruct") -> dict:
    if not chunks:
        return {"text": "В документации не нашёл ответа на этот вопрос.",
                "citations": [], "refused": True}

    context = "\n\n".join(render_chunk_for_prompt(c, i + 1) for i, c in enumerate(chunks))
    resp = client_llm.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": SYSTEM_PROMPT},
                  {"role": "user", "content": USER_PROMPT.format(question=question, context=context)}],
        temperature=0.0,          # для фактологических вопросов температура 0 — не настройка, а требование
        max_tokens=800,
    )
    text = resp.choices[0].message.content
    citations = [{"n": i + 1, "title": c["metadata"]["title"],
                  "section": c["metadata"]["section"], "url": c["metadata"]["url"]}
                 for i, c in enumerate(chunks) if f"[{i + 1}]" in text]
    return {"text": text, "citations": citations,
            "refused": "не нашёл ответа" in text.lower(),
            "usage": resp.usage}
```

Обрати внимание на `citations`: они собираются **по факту упоминания номера в тексте ответа**, а не «все найденные фрагменты». Это позволяет считать метрику «доля ответов с релевантной процитированной цитатой» из [оценки RAG](mlops/07-ocenka-rag.md) и не выдавать ссылку на документ, который модель даже не читала.

## Полный рабочий минимальный RAG

Всё вместе, от папки с markdown до ответа с цитатами. Это то, что ты запускаешь локально.

```bash
# Зависимости
pip install qdrant-client sentence-transformers torch \
            tiktoken openai pyyaml selectolax

# Локальные модели без облака. Ollama поднимает OpenAI-совместимый API.
ollama serve &
ollama pull qwen2.5:7b-instruct        # 4.7 ГБ, 8 ГБ VRAM
ollama pull nomic-embed-text          # 274 МБ, используется как эмбеддер

docker run -d --name qdrant -p 6333:6333 qdrant/qdrant:v1.12.4
mkdir -p /opt/mini-rag/{corpus,index}
```

```python
# /opt/mini-rag/mini_rag.py — запускается целиком, ~200 строк, весь RAG
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
import tiktoken
import yaml
from openai import OpenAI
from qdrant_client import QdrantClient, models

CORPUS = Path("/opt/mini-rag/corpus")
INDEX_DIR = Path("/opt/mini-rag/index")
COLLECTION = "mini_rag"
EMBED_MODEL = "nomic-embed-text"          # Ollama, как в предыдущих лекциях
GEN_MODEL = "qwen2.5:7b-instruct"
EMBED_DIM = 768                          # ВАЖНО: сверить с моделью, иначе Qdrant отвергнет точки
ENC = tiktoken.get_encoding("cl100k_base")
llm = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
db = QdrantClient(url="http://localhost:6333")

# ---------- 1. Загрузка и очистка ----------
def load_docs(root: Path) -> list[dict]:
    out = []
    for p in sorted(root.rglob("*.md")):
        raw = p.read_text(encoding="utf-8", errors="replace")
        text = raw.replace("\u00a0", " ")
        if len(text.strip()) < 200:                    # пропускаем огрызки
            continue
        doc_id = str(p.relative_to(root)).replace("\\", "/")
        out.append({"doc_id": doc_id, "text": text,
                    "url": f"https://wiki.company.local/{doc_id}",
                    "title": text.splitlines()[0].lstrip("# ").strip()[:120],
                    "updated_at": time.strftime("%Y-%m-%d"),
                    "sha256": hashlib.sha256(raw.encode()).hexdigest()})
    return out

# ---------- 2. Чанкинг ----------
def chunk_docs(docs: list[dict], max_tokens=600, overlap=120) -> list[dict]:
    chunks = []
    for d in docs:
        parts, cur, n = [], [], 0
        for para in d["text"].split("\n\n"):
            cur.append(para)
            if len(ENC.encode("\n\n".join(cur))) >= max_tokens:
                tail = "\n\n".join(cur)[-overlap * 4:]      # грубый overlap по символам
                parts.append(("\n\n".join(cur), tail))
                cur = []
        if cur:
            parts.append(("\n\n".join(cur), ""))
        for body, tail in parts:
            n += 1
            chunks.append({"chunk_id": f"{d['doc_id']}::{n:04d}",
                           "text": (body + "\n" + tail).strip(),
                           "metadata": {k: v for k, v in d.items() if k != "text"},
                           "n": n, "section": _section(body)})
    return chunks


def _section(body: str) -> str:
    for line in body.splitlines():
        if line.startswith("#"):
            return line.lstrip("# ").strip()[:120]
    return "Документ"

# ---------- 3. Эмбеддинги с кэшем ----------
def embed_texts(texts: list[str]) -> np.ndarray:
    cache_path = INDEX_DIR / "emb_cache.jsonl"
    cache = {}
    if cache_path.exists():
        for line in cache_path.read_text(encoding="utf-8").splitlines():
            if line:
                r = json.loads(line)
                cache[r["k"]] = r["v"]
    todo = [t for t in texts if t not in cache]
    if todo:
        print(f"эмбеддинг {len(todo)} новых из {len(texts)} (кэш: {len(cache)})")
        out = []
        for i in range(0, len(todo), 32):
            resp = llm.embeddings.create(model=EMBED_MODEL, input=todo[i:i + 32])
            out.extend(e["embedding"] for e in resp.data)
            time.sleep(0.05)                             # уважаем локальный инференс
        with open(cache_path, "a", encoding="utf-8") as f:
            for t, v in zip(todo, out):
                cache[t] = v
                f.write(json.dumps({"k": t, "v": v}, ensure_ascii=False) + "\n")
    return np.array([cache[t] for t in texts], dtype=np.float32)

# ---------- 4. Индексация ----------
def ensure_collection():
    if not db.collection_exists(COLLECTION):
        db.create_collection(
            collection_name=COLLECTION,
            vectors_config=models.VectorParams(size=EMBED_DIM, distance=models.Distance.COSINE),
            hnsw_config=models.HnswConfigDiff(m=16, ef_construct=128),
        )
        for f in ("doc_id", "chunk_id", "title", "section"):
            db.create_payload_index(COLLECTION, field_name=f,
                                    field_schema=models.PayloadSchemaType.KEYWORD)

def index_all(full: bool = False):
    docs = load_docs(CORPUS)
    chunks = chunk_docs(docs)
    if not db.collection_exists(COLLECTION):
        ensure_collection()
    else:
        seen = {c["doc_id"] for c in chunks}
        # инкрементальность: удаляем чанки исчезнувших или изменившихся документов
        for c in full_ids(db, COLLECTION):
            if c not in seen:
                db.delete(COLLECTION, points_selector=models.FilterSelector(
                    filter=models.Filter(must=[models.FieldCondition(
                        key="doc_id", match=models.MatchValue(value=c))])))
    vectors = embed_texts([_for_embedding(c) for c in chunks])
    for i in range(0, len(chunks), 256):
        part = chunks[i:i + 256]
        db.upsert(COLLECTION, points=[
            models.PointStruct(id=c["chunk_id"],
                               vector=vectors[i + j].tolist(),
                               payload={**c["metadata"], "content": c["text"],
                                        "chunk_id": c["chunk_id"]})
            for j, c in enumerate(part)])
    print(f"проиндексировано чанков: {len(chunks)}, документов: {len(docs)}")

def full_ids(db, coll):
    seen, off = set(), None
    while True:
        pts, off = db.scroll(coll, limit=4096, offset=off,
                             with_payload=["doc_id"], with_vectors=False)
        seen.update(p.payload["doc_id"] for p in pts)
        if off is None:
            return seen

def _for_embedding(c: dict) -> str:
    # инъекция заголовка и раздела в текст ДО эмбеддинга
    return (f"Заголовок документа: {c['metadata']['title']}\n"
            f"Раздел: {c['section']}\nТекст: {c['text']}")

# ---------- 5. Поиск и генерация ----------
def search(question: str, k: int = 8):
    v = embed_texts([f"search_query: {question}"])[0].tolist()
    res = db.query_points(COLLECTION, query=v, limit=k * 3,
                          search_params=models.SearchParams(hnsw_ef=256),
                          with_payload=True)
    return [p.payload for p in res.points][:k]

SYSTEM = ("Ты — ассистент по внутренней документации. Отвечай ТОЛЬКО на основе "
          "приведённых фрагментов. Если ответа нет — напиши «В документации не нашёл "
          "ответа». Каждое утверждение снабжай ссылкой [N]. Не выдумывай факты.")

def ask(question: str) -> dict:
    hits = search(question, k=8)
    if not hits:
        return {"text": "В документации не нашёл ответа.", "citations": [], "refused": True}
    ctx = "\n\n".join(
        f"[{i+1}] {h['title']} / {h['section']}\n{h['content']}"
        for i, h in enumerate(hits))
    r = llm.chat.completions.create(
        model=GEN_MODEL, temperature=0.0, max_tokens=700,
        messages=[{"role": "system", "content": SYSTEM},
                  {"role": "user", "content": f"Вопрос: {question}\n\nФрагменты:\n{ctx}"}])
    text = r.choices[0].message.content
    return {"text": text,
            "citations": [{"n": i+1, "title": h["title"], "url": h["url"]}
                          for i, h in enumerate(hits) if f"[{i+1}]" in text],
            "refused": "не нашёл ответа" in text.lower()}

if __name__ == "__main__":
    import sys
    if sys.argv[1:2] == ["index"]:
        index_all(full="--full" in sys.argv)
    else:
        for q in sys.argv[1:]:
            r = ask(q)
            print(f"\n=== {q}\n{r['text']}")
            for c in r["citations"]:
                print(f"   [{c['n']}] {c['title']} — {c['url']}")
```

```bash
cd /opt/mini-rag
python mini_rag.py index                  # инкрементально
python mini_rag.py index --full           # полная переиндексация
python mini_rag.py "Как сбросить пароль в AD?" "Куда деплоить api-gateway?"
```

> [!NOTE]
> Кэш эмбеддингов в коде выше — это `emb_cache.jsonl`. Он экономит главное: повторная индексация после изменения чанкинга или после добавления 10 документов не пересчитывает векторы для старых 90%. На корпусе в 100k чанков локальный эмбеддинг через Ollama занимает часы; с кэшем — минуты. В проде то же делают Redis с TTL, а ключом служит sha256 от «текст + имя модели + версия препроцессинга».

## Мультиарендность: разделение индексов по доступу

Три уровня, от простого к сложному:

| Уровень | Реализация | Плюс | Минус |
| --- | --- | --- | --- |
| **Фильтр по метаданным** | `acl_groups` в payload, обязательный в каждом запросе | один индекс, экономия памяти | ошибка в коде = утечка; фильтр стоит latency |
| **Коллекция на арендатора** | отдельная коллекция на отдел/юрид. лицо | полная изоляция, простое удаление | больше памяти, сложнее поиск по нескольким сразу |
| **Коллекция + RLS в Postgres** | pgvector с Row-Level Security | изоляция на уровне БД | только pgvector |

Практическая рекомендация: **начинай с фильтра по метаданным, переходи на коллекции, когда появится юридическая необходимость изоляции**. Но в любом случае `acl_groups` должно быть в индексе уже с первого дня — перестраивать индекс задним числом, когда он уже в проде и в нём лежат персональные данные, дорого.

---

## Где это ломается

1. **Чанкинг по фиксированному размеру для документации с заголовками.** Разрезы посреди раздела, где «как настроить» отделено от «что это настраивает». Переходи на чанкинг по структуре.
2. **Overlap = 0.** Фраза на стыке чанков бессмысленна в обоих, и векторный поиск её не найдёт нигде. Минимум 100 токенов.
3. **Заголовок не попал в текст чанка.** Модель не понимает рамку фрагмента и приписывает ему чужую тему. Инъекция заголовка — две строки кода, а прирост заметный.
4. **Без rerank.** Кандидат с правильным документом на 8-м месте из 20 не попадает в top-5 и теряется. Это самая дешёвая точка прироста во всём RAG.
5. **Только векторный поиск.** Вопрос про код ошибки или номер заявки не найдётся никогда — нужна вторая ветка BM25 и RRF поверх.
6. **Фильтр по ACL есть в коде, но не во всех вызовах.** Одна новая ручка в приложении — и документы из закрытых папок в ответе.
7. **`temperature=0.7` для фактологических вопросов.** Это не «креативность», это способ получить два разных ответа на один вопрос и невозможность воспроизвести инцидент.
8. **top-k = 30, «чтобы точно нашлось».** Модель теряется в 16k контекста, цитаты мешают друг другу, latency растёт вчетверо. Правильный ответ — rerank и top-5…8.
9. **Промпт без запрета на домысливание.** Модель вежливо отвечает на вопрос, которого в базе нет, и ссылается при этом на реальный документ. Обязателен пункт про отказ и `expected_refusal` в golden set.
10. **Переэмбеддинг всего корпуса при каждом индексировании.** Без кэша это часы работы и лишние деньги на API. Ключ кэша — хеш от текста, модели и препроцессинга.

## Чек-лист понимания

- [ ] Я могу объяснить, почему качество RAG ограничено качеством retrieval'а, и описать два контура: индексации и запроса
- [ ] Я умею выбрать стратегию чанкинга под тип корпуса и обосновать размер чанка и overlap
- [ ] Я знаю, зачем нужны метаданные в каждом чанке и почему заголовок надо инжектить и в эмбеддинг, и в промпт
- [ ] Я объясняю разницу между би-энкодером и кросс-энкодером и знаю, что rerank даёт больший прирост качества, чем смена эмбеддинга
- [ ] Я умею собрать hybrid-поиск и объяснить, зачем нужен RRF и почему он лучше сложения скоров
- [ ] Я знаю, сколько кода брать в контекст и почему «больше контекста» ухудшает ответ
- [ ] Я умею запустить полный мини-RAG локально: индексация, поиск, генерация с цитатами и отказом
- [ ] Я понимаю, как кэшировать эмбеддинги, и знаю, что кэш надо инвалидировать при смене модели или препроцессинга
- [ ] Я выбираю между фильтрами по метаданным и отдельными коллекциями для мультиарендности

Дальше — [оценка RAG](mlops/07-ocenka-rag.md): как доказать, что всё это работает, и как не дать качеству упасть незаметно.