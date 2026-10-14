---
title: Документы и OCR для RAG
track: mlops
module: M. Практика работы с ИИ
order: 23
duration: 85 мин
level: middle
tags: [ocr, pdf, документы, извлечение, таблицы, разметка]
summary: Как привести реальные корпоративные документы — PDF со сканов, из 1С, DOCX, XLSX и презентации — к структурированным чанкам с метаданными и ссылками на страницы, и почему этап загрузки ломает RAG чаще, чем всё остальное
practice: Возьми папку из 20 реальных PDF компании, раздели их на три группы по наличию текстового слоя, прогони извлечение, собери JSONL чанков с метаданными и ссылками на страницы, посчитай метрики качества извлечения, найди и удали дубли и почини утечку чанков при удалении документа из источника.
---

У тебя есть работающий RAG из [лекции о пайплайне](mlops/06-rag-pipeline.md): чанкинг, эмбеддинги, гибридный поиск, reranking, генерация с цитатами. И есть папка, которую ты дал на индексацию. Через полчаса выясняется, что из неё в индекс попало полторы страницы текста, а ответы на вопросы по регламенту — выдумка.

Так происходит почти всегда, потому что курсы про RAG рисуют корпус идеальным: markdown, Confluence, пара текстовых PDF. Реальность компании другая: выгрузка из 1С в PDF, договор, отсканированный на офисном МФУ в 2019 году, презентация со слайдами, Excel с прайсом, DOCX, в котором кто-то нарисовал таблицу текстовыми табуляциями. **Этап загрузки ломает RAG чаще, чем всё остальное вместе взятое**, и именно про него этот модуль.

## Классификация документов: что у тебя на диске

Первое решение, которое стоит принять до установки любой библиотеки: **как устроен конкретный файл**. Правильная стратегия зависит от ответа, а не от модного пакета.

| Тип | Примеры | Текстовый слой | Что делать | Типичная ошибка |
| --- | --- | --- | --- | --- |
| **Родной текстовый PDF** | PDF, сохранённый из Word, выгрузка из 1С, Confluence PDF | есть, корректный | извлекать напрямую, без OCR | прогнали через OCR и испортили |
| **Скан** | договор, распознанный копиром, PDF из факс-сервера | нет | рендер в картинку + OCR | отдали в индекс пустые страницы |
| **Смешанный** | страница с текстом и вставленным сканом внутрь | частично | посимвольно: текстовый слой + OCR только для картинок | самый частый случай и самый неприятный |
| **Табличный PDF** | прайс, реестр, ведомость | есть, но без сетки | извлекать таблицей, а не плоским текстом | строки склеились — цифры перепутаны |
| **DOCX / ODT** | регламенты в Word | есть, с корректной структурой | конвертировать в markdown, сохраняя заголовки | конвертация «в txt» убивает иерархию |
| **XLSX / CSV** | прайсы, справочники, реестры | есть, лист за листом | каждая строка = документ, лист и колонки = метаданные | засунули весь лист одним чанком |
| **PPTX** | презентации, инструкции | есть, по слайдам | один слайд = юнит с заголовком | текст вперемешку со слайдов |

> [!IMPORTANT]
> Правило, которое экономит больше всего времени: **документ с текстовым слоем через OCR не пропускают**. Это не «так проще», это порча данных: OCR переписывает готовый точный текст своими ошибками, путает `О` и `0`, `l` и `1`, разрывает слова на переносах, ломает нумерацию списков. Результат после OCR хуже исходного текстового слоя всегда — единственный случай, когда OCR уместен, это когда слоя нет.

Быстрая проверка «есть ли слой» занимает секунду:

```bash
# Быстрая диагностика папки: сколько страниц с текстовым слоем, сколько — чистые сканы
# Установка инструментов: poppler-utils даёт pdftotext/pdftoppm/pdfinfo
sudo apt-get update && sudo apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng

mkdir -p /opt/rag-work/diag && cd /opt/rag-work/diag
for f in /data/docs/*.pdf; do
  pages=$(pdfinfo "$f" 2>/dev/null | awk '/^Pages:/{print $2}')
  chars=$(pdftotext "$f" - 2>/dev/null | tr -d '[:space:]' | wc -c)
  awk -v n="$(basename "$f")" -v p="${pages:-1}" -v c="${chars:-0}" \
      'BEGIN {printf "%-60s pages=%-4d chars/page=%.0f\n", n, p, (p>0 ? c/p : 0)}'
done
```

Интерпретация простая: `chars/page` больше 300 — текстовый слой нормальный, бери напрямую. Меньше 100 — перед тобой скан или почти пустые страницы, бери OCR. Значение между 100 и 300 — смешанный случай, разбирай постранично. Для скана 300 dpi норма — 1500–3000 знаков на страницу; если меньше, качество скана плохое и сначала надо чинить скан, а не подбирать движок OCR.

## «Каша» из pdftotext: что именно не так

Дефолтный `pdftotext` — это не парсер, а дамп потока символов в порядке, в котором PDF-ридер отдал их. Порядок этот — не порядок чтения человеком. Вот реальный вывод с типового трёхколоночного документа:

```text
Служебная записка №14/2-118                    ТУРБИНИРОВАНИЕ ИЗДЕЛИЙ        стр. 3
от 12.03.2024                                                   Врач поликлиники №7
ТУРБИНИРОВАНИЕ ИЗДЕЛИЙ
Настоящим подтверждается, что пациент Иванов И.И.
1 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27
выполнено терапевтическое лечение зубов 26, 27,           Осмотр: 12.03.2024
28 в объеме лечебно-профилактической помощи.
Диагноз: кариес средней поверхности зуба 26.          Подпись врача ____________________
Л.: 6Б-243/24                                   М.П.
```

Что здесь произошло: колонка с нумерацией зубов попала между строк основного текста; колонтитул оказался в начале страницы; колонка с подписью врача перемешана с диагнозом; таблица (схема зубов) превратилась в поток чисел, в котором «26, 27, 28» неотличимы от номеров строк. Всё это — один абзац для чанкера и один вектор для эмбеддинга.

Почему из такой «каши» RAG не работает — четыре независимые причины, и важно понимать их по отдельности:

1. **Границы чанков не совпадают со смыслом.** Чанкер режет по токенам, а не по предложениям. Внутри одного фрагмента оказываются три разных факта, и эмбеддинг усредняет их в точку, которая не похожа ни на один из них. Вопрос «что делали с зубом 26» найдёт этот чанк плохо.
2. **Строки таблиц теряют границы.** «26, 27, 28» отдельно от заголовка «зубы» — это не данные, это шум. Числа в соседних строках разных таблиц слипаются, и модель получает ответ на вопрос о цене, выдуманный из соседней строки.
3. **Колонтитулы съедают бюджет и снижают разнообразие.** Если каждая страница начинается с «ТУРБИНИРОВАНИЕ ИЗДЕЛИЙ ... стр. 3», то чанки соседних страниц становятся почти одинаковыми. Эмбеддинги сближаются, поиск выдаёт пять страниц одного документа вместо нужной из другого.
4. **Цитата ведёт не туда.** Даже если факт угадан, координата «страница 3» не соответствует ни одному конкретному утверждению: в выдаче нет способа сказать пользователю, где именно на странице смотреть.

Что делать — три уровня, от дешёвого к дорогому:

| Уровень | Инструмент | Что чинит | Чего не чинит |
| --- | --- | :---: | :---: |
| 1. Флаги | `pdftotext -layout`, `-raw` | порядок колонок «как есть» на странице | не восстанавливает иерархию |
| 2. Блоки | PyMuPDF: блоки с координатами и шрифтами | читает страницу блоками, видит размер шрифта | таблицы без сетки всё равно плоские |
| 3. Layout-анализ | сервис или модель, понимающая раскладку | колонки, таблицы, формы, заголовки | стоит денег и требует проверки на своих данных |

Промежуточный вариант, который стоит попробовать первым: `-layout` сохраняет горизонтальное позиционирование пробелами, и это уже позволяет отделить строку таблицы от абзаца, не поднимая OCR:

```bash
# Три способа достать текст из одного и того же PDF — сравни глазами
f="/data/docs/zapiska-14-2-118.pdf"
pdftotext        "$f" out_plain.txt     # по потоку символов: колонки перемешаны
pdftotext -layout "$f" out_layout.txt   # сохраняет колонки пробелами: читаемо для человека
pdftotext -raw    "$f" out_raw.txt      # как лежит в потоке: для отладки, не для индекса

# Проверить, есть ли у страницы текстовый слой, и сколько боксов на ней
python3 - <<'PY'
import pymupdf
doc = pymupdf.open("/data/docs/zapiska-14-2-118.pdf")
page = doc[0]
print("символов в слое:", len(page.get_text("text").strip()))
print("текстовых блоков:", len(page.get_text("blocks")))
print("изображений:", len(page.get_images(full=True)))
PY
```

> [!TIP]
> Практика, которая экономит дни: **выдели 10 характерных страниц корпуса, прогони на них все кандидатные извлекатели и сравни результат с тем, что видит на экране человек.** Десять страниц, выбранных так, чтобы среди них были: таблица, сканы, футер с номером, текст с картинкой, пустая страница. Это дешевле, чем любая теория о том, какой извлекатель «лучше», и даёт ответ про твой корпус, а не про демо-файл вендора.

## OCR: как работает и почему русский сложнее

OCR — это задача «изображение → последовательность символов». Классический движок решает её в четыре шага, и понимание шагов объясняет, почему он ломается:

1. **Бинаризация и очистка** — картинка превращается в чёрно-белое изображение. Это часть предобработки, о ней ниже.
2. **Анализ раскладки** — поиск строк, слов, колонок, таблиц, картинок. Здесь рождается порядок чтения. У Tesseract это один из самых слабых шагов.
3. **Распознавание символов** — каждая последовательность пикселей сопоставляется с символами по статистике начертаний и языковой модели.
4. **Сборка в текст** — язык помогает выбрать между похожими символами: это обязательный этап, а не украшение.

Отсюда первое практическое следствие: **порядок чтения задаётся на втором шаге, а не моделью**. Если движок не понял, что страница в три колонки, никакое улучшение распознавания символов не восстановит правильный порядок. Второе следствие: язык движка имеет алфавит и словарь, и русский там не всегда полноценно поддержан «из коробки» — отсюда проблемы ниже.

| Особенность | Как проявляется | Что с этим делать |
| --- | --- | :---: |
| Диакритика: `ё`, `й`, `ъ`, `і` | `е` вместо `ё`, потеря мягкого знака | языковые пакеты; словарь домена в постобработке |
| Похожие начертания | `О`↔`0`, `З`↔`3`, `l`↔`1`→`I` | проверка полей, которые должны быть числами или идентификаторами |
| Переносы по слогам | `сис-тема` → `сис тема` | склейка по словарю или по эвристике дефиса в конце строки |
| Мелкий шрифт подписей | пропадает целиком | увеличение DPI при рендере, а не смена движка |
| Сканы с рукописью | ложные срабатывания высокой частоты | вручную, OCR не для этого |
| Вертикальный текст и водяные знаки | ложные строки | отсечение по площади и положению блока |

**Tesseract — классика, и для качественных сканов её достаточно.** Это честное утверждение, а не ностальгия: у скана хорошего качества, снятого или полученного с нормального сканера при 300 dpi, Tesseract с русским языковым пакетом даёт точность 95–98 %, чего для корпоративного корпуса хватает. Проблемы начинаются там, где у документа сложная раскладка, а не плохой текст.

```bash
# Установка движка и языковых пакетов (один раз на хост)
sudo apt-get install -y tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng tesseract-ocr-osd
tesseract --list-langs
tesseract --version

# Рендер страницы в картинку 300 dpi (из poppler-utils)
pdftoppm -r 300 -png -f 1 -l 1 -gray "/data/docs/skan-dogovora.pdf" /tmp/page

# Запуск OCR с разбором по режимам раскладки
tesseract /tmp/page-01.png stdout -l rus+eng --psm 6 2>/dev/null | head -40

#   --psm 3  — автоматический анализ раскладки (по умолчанию): для целой страницы
#   --psm 6  — один сплошной блок: для вырезанного фрагмента или колонки
#   --psm 4  — одна колонка текста: для документов в одну колонку
#   --psm 11 — «разреженный» текст: для бланков, форм, каптионов к картинкам
#   --psm 12 — «всё, что не распознано как текст»: OSM-метка, использует --psm 11-12

# Оценка качества движка на конкретной странице: TSV с уверенностью по каждому слову
tesseract /tmp/page-01.png /tmp/page -l rus --psm 3 tsv 2>/dev/null
awk -F'\t' 'NR>1 && $11!="" && $11!="-1" {n++; s+=$11; if ($11<70) low++}
             END {printf "слов: %d, средняя уверенность: %.1f, ниже 70: %d (%.1f%%)\n",
                  n, s/n, low, 100*low/n}' /tmp/page.tsv
```

Средняя уверенность — полезная метрика, потому что она позволяет **отделять плохие страницы от нормальных и отправлять их в ручную очередь**, вместо того чтобы молча индексировать мусор.

### Классы решений и как выбирать

Конкретные пакеты устаревают быстрее, чем лекция успевает устареть, поэтому выбор формулируется классами: у каждого класса есть свои критерии, и решение принимается по измерению на своих страницах.

| Класс | Что внутри | Критерий выбора | Про слабые стороны |
| --- | --- | --- | --- |
| Библиотечный OCR на CPU | Tesseract, pytesseract, EasyOCR, PaddleOCR-подобные | качество на сканах 300 dpi, язык ru, возможность офлайна | раскладка и таблицы — слабое место |
| Облачные и сервисные OCR | Document AI, Textract-подобные, распознавание с таблицами | распознавание таблиц и форм, готовые координаты, договорные условия и SLA | деньги за страницу, ПДн уезжают наружу, привязка к вендору |
| Layout-модели + классический OCR | два прохода: раскладка → распознавание по регионам | сложная вёрстка: журналы, много колонок | связка из двух инструментов и два места отказа |
| Мультимодальная модель | модель читает изображение страницы целиком | очень сложные документы: чертежи, схемы, рукописные правки | медленно, дорого, нестабильно между версиями |

Правильный вопрос не «какой пакет лучше», а **«какой доля моего корпуса требует тяжёлого подхода»**. Обычно это 3–10 % документов, и тогда выгоднее держать простой быстрый пайплайн на 90 % и отдельный дорогой маршрут для остатка.

## Предобработка: где выигрыш больше, чем в смене движка

Один из самых устойчивых выводов практики OCR: **большая часть улучшения даётся не сменой движка, а подготовкой картинки**. Каждый из четырёх шагов ниже стоит копейки по ресурсам и даёт заметный прирост, если сделано до распознавания.

| Шаг | Что делает | Прирост точности | Когда обязателен |
| --- | --- | :---: | --- |
| **Рендер в 300 dpi** | страница → картинка нужного разрешения | большой | всегда для сканов; для текстового слоя не нужен |
| **Обрезка полей** | убрать пустые края и сканерный фон | средний | всегда |
| **Выравнивание (deskew)** | повернуть страницу на угол, под которым она сканировалась | **большой** | всегда: 2–4° ломают распознавание строк |
| **Бинаризация** | свести к чистому чёрно-белому, убрать серый фон | средний | сканы, фото, ч/б копиры |
| **Поворот на 90/180°** | страница лежит боком | большой | всегда, дешёво через `--psm 0` |
| **Удаление шума** | медианный фильтр, despeckle | малый | только грязные сканы |

```python
# /opt/rag-pipeline/imgprep.py — предобработка страницы перед OCR
import numpy as np
import pymupdf

def render_page(page, dpi: int = 300) -> np.ndarray:
    """PDF-страница -> серое изображение. Для чисто текстовых страниц это шаг в никуда,
    для сканов — обязательный: модель работает по картинке, а не по текстовому слою."""
    zoom = dpi / 72
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    return img


def estimate_skew(img: np.ndarray) -> float:
    """Оценка наклона через минимальную площадь прямоугольника по текстовым пикселям.
    Работает на бинаризованном изображении; возвращает угол в градусах."""
    import cv2
    binary = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    coords = np.column_stack(np.where(binary > 0))
    if len(coords) < 100:
        return 0.0
    angle = cv2.minAreaRect(coords.astype(np.float32))[-1]
    return angle - 90 if angle < -45 else angle


def preprocess(img: np.ndarray, deskew: bool = True, binarize: bool = True) -> np.ndarray:
    """Полный конвейер предобработки. Порядок важен: сначала выравнивание по исходному
    изображению, потом бинаризация — обрезка текста и смена фона портят оценку наклона."""
    import cv2
    if deskew:
        angle = estimate_skew(img)
        if abs(angle) > 0.2:                       # меньше — не трогаем, чтобы не мылить
            h, w = img.shape
            m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
            img = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC,
                                 borderMode=cv2.BORDER_REPLICATE)
    if binarize:
        img = cv2.adaptiveThreshold(img, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv2.THRESH_BINARY, 31, 15)
    return img


def crop_margins(img: np.ndarray, pad: int = 10) -> np.ndarray:
    """Убрать пустые поля: они замедляют распознавание и иногда читаются как мусор."""
    import cv2
    binary = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    ys, xs = np.where(binary > 0)
    if len(xs) == 0:
        return img
    h, w = img.shape
    return img[max(ys.min() - pad, 0):min(ys.max() + pad, h),
               max(xs.min() - pad, 0):min(xs.max() + pad, w)]


def ocr_page(img: np.ndarray, lang: str = "rus+eng", psm: int = 3) -> str:
    """Вызов OCR. В проде это внешний процесс, здесь — через pytesseract."""
    import cv2, pytesseract
    hocr = pytesseract.image_to_data(
        cv2.imencode(".png", img)[1].tobytes(),
        lang=lang, config=f"--psm {psm}",
        output_type=pytesseract.Output.DICT,
    )
    lines: dict[tuple[int, int, int], list[str]] = {}
    for i, text in enumerate(hocr["text"]):
        if not text.strip():
            continue
        # Ключ строки: (номер блока, номер абзаца, номер строки) — это и есть группировка
        key = (hocr["block_num"][i], hocr["par_num"][i], hocr["line_num"][i])
        lines.setdefault(key, []).append(text)
    return "\n".join(" ".join(words) for _, words in sorted(lines.items()))
```

> [!IMPORTANT]
> Порядок в конвейере менять нельзя. Оценка наклона делается по исходному изображению: после бинаризации с агрессивным порогом и после обрезки полей текстовые пиксели теряются, и движок «уверенно» выравнивает страницу на 7°, потому что находит диагональную линию в подчёркивании таблицы. Классическая ошибка — поставить бинаризацию первой ради «чистоты» картинки и получить разъехавшийся текст.

## Структура документа: главное, что решает

Разбор текста без структуры даёт RAG, который ищет, но не рассуждает. Модель, увидевшая фрагмент, понимает, о чём он, но не понимает, **где он находится**: это определение раздела, это его вывод, это пункт договора со ссылкой на предыдущий. Разметка заголовков решает именно эту проблему и стоит дешевле любой замены модели.

Почему это важно именно в RAG:

- **эмбеддинг становится точнее** — заголовок раздела смещает вектор в сторону темы, и два раздела с похожим текстом («Лимиты API» и «Лимиты памяти») перестают быть неразличимы;
- **цитата становится адресной** — «раздел 3.2, страница 14» вместо «страница 14»;
- **чанк перестаёт резать смысл** — разделы естественный границы, и [чанкинг по структуре](mlops/06-rag-pipeline.md) становится рабочим режимом по умолчанию;
- **модель видит иерархию** — «3.2 Требования к отвопотению» в начале фрагмента подсказывает, чего ждать дальше.

Как извлекать заголовки, по убыванию надёжности:

| Способ | Надёжность | Когда работает |
| --- | :---: | --- |
| Встроенная структура (PDF bookmarks, `get_toc()`) | высокая | документы, свёрстанные в Word или InDesign |
| Стили PDF (`/P <</<</MCID 0/B 12>>/R 34 /P <</MCID 0>>/P 34>>/Span <</ActualText>>>`) | высокая | родные PDF — тег `/Heading1` можно вытащить напрямую |
| Размер шрифта и жирность | средняя | любой текстовый PDF, включая выгрузки из 1С |
| Эвристика по строке: короткая, без точки в конце, следующая строка длиннее | средняя | сканы после OCR, markdown |
| Пунктуация и «ПРИКАЗЫВАЮ» | низкая | только как последний довод |

```python
# /opt/rag-pipeline/structure.py — заголовки, абзацы и таблицы из PDF со шрифтовыми признаками
import re
from dataclasses import dataclass, field

import pymupdf

BULLET = re.compile(r"^\s*([-•*–—]|\d+[.)])\s+")


@dataclass
class Block:
    text: str
    page: int
    size: float          # средний кегль, pt
    bold: bool
    bbox: tuple[float, float, float, float]
    level: int = 0       # 0 — не заголовок


def page_blocks(page: "pymupdf.Page") -> list[Block]:
    out: list[Block] = []
    data = page.get_text("dict")
    for b in data["blocks"]:
        if b["type"] != 0:                 # 1 — изображение: текста здесь нет вовсе
            continue
        for line in b["lines"]:
            spans = line["spans"]
            text = "".join(s["text"] for s in spans).strip()
            if not text:
                continue
            sizes = [s["size"] for s in spans]
            bold = any("bold" in s["font"].lower() for s in spans)
            out.append(Block(text=text, page=page.number + 1,
                             size=round(max(sizes), 1), bold=bold,
                             bbox=tuple(line["bbox"])))
    return out


def body_size(blocks: list[Block]) -> float:
    """Кегль основного текста = самый частый кегль, а не минимальный: минимальный
    принадлежит колонтитулам и номерам страниц."""
    counts: dict[int, int] = {}
    for b in blocks:
        counts[int(round(b.size))] = counts.get(int(round(b.size)), 0) + len(b.text)
    return float(max(counts, key=lambda k: counts[k])) if counts else 10.0


def mark_headings(blocks: list[Block], min_chars: int = 4) -> list[Block]:
    base = body_size(blocks)
    for b in blocks:
        stripped = b.text.strip()
        looks = (len(stripped) <= 120 and not stripped.endswith((".", ";", ","))
                 and len(stripped) >= min_chars and not BULLET.match(stripped))
        bigger = b.size >= base + 1.5 and looks          # уровень 1
        bold = b.bold and b.size >= base - 0.5 and looks # уровень 2
        b.level = 1 if bigger else (2 if bold else 0)
    return blocks


def blocks_to_sections(blocks: list[Block], fallback_title: str = "Документ") -> list[dict]:
    """Склейка блоков в разделы: начало нового раздела — любой заголовок уровня 1."""
    sections, cur = [], {"title": fallback_title, "level": 0, "parts": [], "pages": set()}
    for b in mark_headings(blocks):
        if b.level == 1:
            if cur["parts"]:
                sections.append(cur)
            cur = {"title": b.text.strip(), "level": 1, "parts": [], "pages": {b.page}}
            continue
        cur["parts"].append(b.text)
        cur["pages"].add(b.page)
    if cur["parts"]:
        sections.append(cur)
    for s in sections:
        s["text"] = "\n".join(s.pop("parts"))
        s["page"] = min(s["pages"])                 # страница, где раздел начинается
    return sections
```

### Таблицы: почему их надо отдавать структурой

Таблица — самое частое место, где «просто текст» превращается в источник выдуманных цифр. Причины две: у строки нет собственного смысла вне заголовка колонок, и модель не видит связи «ячейка стоит в колонке «Цена»».

Правило: **таблица не разбирается на строки, а сохраняется как таблица**. В контекст уходит markdown-таблица или CSV с заголовком колонок, причём целиком, а не по частям. Для больших таблиц допустимо разбиение на части с **повторением шапки** в каждой части — иначе вторая половина теряет смысл.

| Что сделано с таблицей | Что получится в ответе |
| --- | --- |
| Markdown-таблица с шапкой, целиком | точные цифры, модель цитирует ячейку |
| CSV с повтором шапки в каждом чанке | точные цифры, работает на больших таблицах |
| Плоский текст с разделителем в одну колонку | цифры без привязки к названию — выдумки |
| Каждая ячейка отдельным чанком | полная потеря: вектор ячейки «1200» ничего не значит |
| Таблица как картинка в мультимодальную модель | зависит от модели; годится для схем, не для прайсов |

### Метаданные обязательны

Метаданные — это не «дополнительные поля», а условие эксплуатации. Без них нельзя выполнить три обязательные операции: показать источник, отфильтровать по дате и удалить данные.

| Поле | Откуда берётся | Что без него невозможно |
| --- | --- | --- |
| `source_path` / `doc_id` | путь на диске или идентификатор в коннекторе | не найти оригинал, не удалить точечно |
| `title` | метаданные файла, первый заголовок, заголовок окна | в выдаче пять чанков из «Документ» |
| `section` | разобранная иерархия заголовков | цитата «где-то на странице 14» |
| `page` / `page_end` | номер страницы из PDF | переход к источнику и проверка цитаты человеком |
| `doc_date`, `updated_at` | свойства файла или дата в тексте | фильтр «покажи то, что действует сейчас» |
| `author`, `owner` | свойства документа, AD-атрибуты | эскалация вопроса автору |
| `acl_groups` | из [лекции про метаданные](mlops/05-embedding-i-vektory.md) | фильтр доступа; отсутствие — утечка |
| `pipeline_version` | версия кода извлечения | понять, почему год назад индекс отличался |
| `content_hash` | sha256 файла | дедупликация и инкрементальность |

Отдельный пункт — **удаление по отзыву согласия**. Механизм описан в [лекции о персональных данных](ru/02-personalnye-dannye-152fz.md), и здесь важна инженерческая часть: когда сотрудник отзывает согласие, ты удаляешь не один файл, а **все производные артефакты** — исходник, текстовый слой, картинки страниц, чанки в векторной базе, записи в полнотекстовом индексе и в графе цитат. Без `doc_id`, связывающего все эти хранилища, процедура невыполнима, а её отсутствие — это не «недоработка», а инцидент.

## Дедупликация и версионирование корпуса

Реальная папка документов почти всегда содержит `Регламент_v3.pdf`, `Регламент_v3 (1).pdf`, копию в архиве и черновик, который забыли удалить. Каждая такая копия съедает место в индексе, **съедает бюджет и портит ответы**: пять одинаковых чанков в выдаче, из которых reranker выбирает один, а второй источник — актуальная версия — не попадает в top-k вообще.

| Стратегия | Что ловит | Ложные срабатывания | Действие |
| --- | --- | --- | --- |
| sha256 содержимого | точная копия, «Договор (1).pdf» | нет | второй файл не индексируем |
| sha256 нормализованного текста | копии, отличающиеся метаданными | нет | то же |
| Размер файла + первые 4 КБ | быстрый фильтр перед полным хешем | нет | предварительный отсев |
| MinHash / simhash | почти-дубли: то же с парой правок | редкие, на шаблонных документах | оставить более новый, остальные — в отчёт на ручное решение |
| Дата и версия в имени | старые версии рядом с новыми | бывают исключения («черновик на согласование») | архивировать, не удалять молча |

```python
# /opt/rag-pipeline/dedup.py — точные и почти-точные дубли
import hashlib
import re
from collections import defaultdict

from datasketch import MinHash, MinHashLSH

_WS = re.compile(r"\s+")
NUM = re.compile(r"\d+|[IVXLC]")


def content_hash(text: str) -> str:
    """Хеш нормализованного текста: разная вёрстка и разные метаданные дают одинаковый хеш."""
    norm = _WS.sub(" ", text).strip().lower()
    return hashlib.sha256(norm.encode()).hexdigest()


def is_template_boilerplate(text: str) -> bool:
    """Шапка регламента, повторяющаяся на каждой странице: в эмбеддинг она не должна
    попадать, но в подсчёте дубликатов участвует."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return len(lines) >= 3 and len({len(l) for l in lines[:3]}) == 1 and len(lines[0]) < 60


def find_duplicates(texts: dict[str, str], num_perm: int = 128, threshold: float = 0.9) -> dict:
    """texts: doc_id -> текст. Возвращает: exact[doc_id] -> master_doc_id,
    near[doc_id] -> (master_doc_id, jaccard). Мастер выбирается по правилу явным,
    чтобы результат не зависел от порядка обхода файлов."""
    exact: dict[str, str] = {}
    by_hash: dict[str, list[str]] = defaultdict(list)
    for doc_id, text in texts.items():
        by_hash[content_hash(text)].append(doc_id)
    for group in by_hash.values():
        if len(group) > 1:
            master = sorted(group)[0]
            for d in group:
                exact[d] = master

    lsh = MinHashLSH(threshold=threshold, num_perm=num_perm)
    for doc_id, text in texts.items():
        tokens = set(NUM.sub("#", w) for w in _WS.sub(" ", text).lower().split())
        mh = MinHash(num_perm=num_perm)
        for t in tokens:
            mh.update(t.encode())
        lsh.insert(doc_id, mh)

    near: dict[str, tuple[str, float]] = {}
    for doc_id in texts:
        if doc_id in exact:
            continue
        tokens = set(NUM.sub("#", w) for w in _WS.sub(" ", texts[doc_id]).lower().split())
        mh = MinHash(num_perm=num_perm)
        for t in tokens:
            mh.update(t.encode())
        candidates = [c for c in lsh.query(mh) if c != doc_id and c not in near]
        if not candidates:
            continue
        best = max(candidates,
                   key=lambda c: len(tokens & set(NUM.sub("#", w) for w in
                                                  _WS.sub(" ", texts[c]).lower().split()))
                   / max(len(tokens | set(NUM.sub("#", w) for w in
                                           _WS.sub(" ", texts[c]).lower().split())), 1))
        near[doc_id] = (best, round(best, 3))
    return {"exact": exact, "near": near}
```

> [!CAUTION]
> У почти-дублей нельзя применять порог вслепую. Два приложения к разным договорам, отличающиеся одним абзацем, дадут сходство 0.92, но удаление одного из них — потеря юридически значимого документа. Правило безопасное: **точный дубль удаляем автоматически, почти-дубль — только помечаем и отправляем человеку**. Порог 0.9 для технической документации нормален; для договоров и нормативки он должен быть выше 0.95, а решение принимает человек.

## Инкрементальная переиндексация: манифест корпуса

Манифест — это таблица «что сейчас должно быть в индексе». Без него инкрементальность превращается в набор скриптов, а удаление файла приводит к тихой порче индекса.

```python
# /opt/rag-pipeline/manifest.py — сверка источника и индекса: добавить, обновить, удалить
import json
import sqlite3
from pathlib import Path

MANIFEST_DB = Path("/var/lib/rag/manifest.sqlite")

SCHEMA = """
CREATE TABLE IF NOT EXISTS manifest (
    doc_id           TEXT PRIMARY KEY,
    source_path      TEXT NOT NULL,
    content_sha256   TEXT NOT NULL,      -- хеш ИСХОДНОГО файла
    text_sha256      TEXT,               -- хеш извлечённого текста
    pipeline_version TEXT NOT NULL,      -- изменился код извлечения -> всё пересобираем
    indexed_at       TEXT NOT NULL,
    chunk_ids        TEXT NOT NULL       -- JSON-массив, чтобы удалить ровно свои чанки
);
CREATE INDEX IF NOT EXISTS ix_manifest_hash ON manifest(content_sha256);
"""


def open_manifest() -> sqlite3.Connection:
    conn = sqlite3.connect(MANIFEST_DB)
    conn.executescript(SCHEMA)
    return conn


def plan(conn: sqlite3.Connection, discovered: dict[str, dict], pipeline_version: str) -> dict:
    """discovered: doc_id -> {path, content_sha256}. Возвращает три списка решений.
    Ключевая строка — третья: файла уже нет в источнике, значит его чанки обязаны
    исчезнуть из векторной базы. Это самая частая тихая ошибка инкрементальной индексации."""
    known = {r["doc_id"]: r for r in conn.execute(
        "SELECT doc_id, source_path, content_sha256, pipeline_version FROM manifest")}

    add, update, delete = [], [], []
    for doc_id, info in discovered.items():
        row = known.get(doc_id)
        if row is None:
            add.append(doc_id)
        elif row["content_sha256"] != info["content_sha256"]:
            update.append(doc_id)
        elif row["pipeline_version"] != pipeline_version:
            update.append(doc_id)          # сменился код извлечения — текст тоже другой
    for doc_id in known:
        if doc_id not in discovered:
            delete.append(doc_id)
    return {"add": add, "update": update, "delete": delete}


def drop_chunks(vector_db, chunk_ids: list[str]) -> None:
    """Удаление из индекса по списку чанков документа. Без этого шага удалённый
    документ продолжает отвечать на запросы — индекс о нём ничего не знает."""
    from qdrant_client import models
    for i in range(0, len(chunk_ids), 256):
        batch = chunk_ids[i:i + 256]
        vector_db.delete(collection_name=COLLECTION, points_selector=models.PointIdsList(points=batch))
```

Заметка про скорость: манифест на sqlite даёт проверку «что изменилось» за миллисекунды на корпусе любого размера и не требует отдельной инфраструктуры. На корпусе от миллиона документов имеет смысл переходить на postgres, но менять придётся только три функции.

## Качество извлечения: метрики, которые нужно мерять

Пайплайн загрузки не падает — он просто перестаёт давать качественный текст, и это не видно ни в логах, ни на дашборде ошибок. Метрики у него свои, и они отвечают на вопрос «жив ли конвейер», а не «были ли исключения».

| Метрика | Что показывает | Порог тревоги | Где считается |
| --- | --- | ---: | --- |
| `pages_text_ratio` | доля страниц с распознанным текстом | < 0.9 | на пайплайне |
| `ocr_pages_ratio` | доля страниц, прошедших через OCR | резкий рост | на пайплайне |
| `ocr_mean_confidence` | средняя уверенность распознавания | < 85 | по TSV движка |
| `empty_chunks_ratio` | доля чанков короче 80 токенов | > 0.05 | после чанкинга |
| `chunk_tokens_p50 / p95` | распределение размера чанков | p95 > 1500 | после чанкинга |
| `tables_as_tables_ratio` | доля таблиц, сохранённых таблицей | < 0.8 | после извлечения |
| `dup_documents_ratio` | доля документов-дублей | > 0.02 | после дедупликации |
| `index_docs_gauge` | документов в индексе против ожидаемого | расхождение > 5% | на индексаторе |

```python
# /opt/rag-pipeline/ingest_metrics.py — отчёт по качеству извлечения
import json
import statistics


def ingest_report(records: list[dict]) -> dict:
    """records: по одной на документ — {doc_id, n_pages, n_text_pages, n_ocr_pages,
    n_tables, n_table_rows, n_chunks, n_empty_chunks, chunk_tokens, confidence}."""
    def ratio(num, den):
        return round(num / den, 4) if den else 0.0

    chunks = sum(r["n_chunks"] for r in records)
    tokens = [t for r in records for t in r["chunk_tokens"]]
    return {
        "documents": len(records),
        "pages_text_ratio": ratio(sum(r["n_text_pages"] for r in records),
                                  sum(r["n_pages"] for r in records)),
        "ocr_pages_ratio": ratio(sum(r["n_ocr_pages"] for r in records),
                                 sum(r["n_pages"] for r in records)),
        "ocr_mean_confidence": round(statistics.fmean(
            [r["confidence"] for r in records if r.get("confidence") is not None] or [0]), 1),
        "empty_chunks_ratio": ratio(sum(r["n_empty_chunks"] for r in records), chunks),
        "chunk_tokens_p50": int(statistics.median(tokens)) if tokens else 0,
        "chunk_tokens_p95": int(sorted(tokens)[int(len(tokens) * 0.95) - 1]) if tokens else 0,
        "tables_as_tables_ratio": ratio(sum(r["n_table_rows"] for r in records),
                                        sum(r["n_tables"] for r in records)),
        "alerts": [],
    }


def check_alerts(rep: dict) -> list[str]:
    """Пороговые проверки: то, что должно уйти в алерт, а не остаться в логе."""
    rules = [
        ("pages_text_ratio", "<", 0.90, "массовая потеря текстового слоя: сломался извлекатель"),
        ("empty_chunks_ratio", ">", 0.05, "растёт доля пустых чанков: проверь OCR и разметку"),
        ("tables_as_tables_ratio", "<", 0.80, "таблицы перестали распознаваться как таблицы"),
        ("dup_documents_ratio", ">", 0.02, "в корпусе просели дубли"),
    ]
    out = []
    for metric, op, limit, why in rules:
        v = rep.get(metric)
        if v is None:
            continue
        if (op == "<" and v < limit) or (op == ">" and v > limit):
            out.append(f"{metric}={v} (порог {op} {limit}): {why}")
    return out
```

Метрики экспортируются в node_exporter тем же способом, что и в [лекции про данные и пайплайны](mlops/04-dannye-i-pipeliney.md): текстовый файл с метриками, алерт на росте `ocr_pages_ratio` и падении `index_docs_gauge`.

## Практика: от папки с PDF до JSONL чанков

Полный конвейер, который можно положить в cron и забыть. Результат — файл чанков, который дальше идёт в эмбеддинг и индекс без единой правки.

```python
#!/usr/bin/env python3
# /opt/rag-pipeline/ingest.py — папка с PDF → JSONL чанков с метаданными и ссылками на страницы.
# Использование: python3 ingest.py --src /data/docs --out /var/lib/rag/chunks.jsonl [--ocr auto]
import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pymupdf

PIPELINE_VERSION = "ingest-1.4.0"      # меняется при правке кода извлечения -> пересборка
MIN_CHUNK_CHARS = 200
MAX_CHUNK_CHARS = 3500
BOILERPLATE = re.compile(r"^\s*(?:страница|page)?\s*-?\d+\s*(?:из|/|-)?\s*-?\d*\s*$", re.I)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def page_text_layer(page: "pymupdf.Page") -> tuple[str, float]:
    """Текстовый слой страницы и оценка его пригодности: сколько знаков на квадрат
    километр страницы. Возвращает (текст, доля_площади_текста)."""
    raw = page.get_text("text")
    area = max(page.rect.width * page.rect.height, 1.0)
    text_area = sum((b[2] - b[0]) * (b[3] - b[1])
                    for b in page.get_text("blocks") if b[6] == 0 and b[4].strip())
    return raw, round(text_area / area, 3)


def strip_boilerplate(text: str) -> str:
    lines = [ln.rstrip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln.strip() and not BOILERPLATE.match(ln)).strip()


def ocr_page(pixmap: "pymupdf.Pixmap", lang: str = "rus+eng", psm: int = 3) -> str:
    """Рендер в 300 dpi -> предобработка -> OCR. Порядок обязателен: выравнивание,
    потом обрезка, потом бинаризация, и только затем распознавание."""
    import cv2
    from imgprep import preprocess, crop_margins

    img = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width)
    img = preprocess(img, deskew=True, binarize=True)
    img = crop_margins(img)
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        return ""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(buf.tobytes())
        path = tmp.name
    try:
        # --psm 0: определить ориентацию страницы, прежде чем её распознавать
        osd = subprocess.run(["tesseract", path, "stdout", "--psm", "0"],
                             capture_output=True, text=True, timeout=30).stdout
        if "Rotate" in osd:
            img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
            ok, buf = cv2.imencode(".png", img)
            path2 = path + "-r.png"
            Path(path2).write_bytes(buf.tobytes())
            path = path2
        out = subprocess.run(["tesseract", path, "stdout", "-l", lang, "--psm", str(psm)],
                             capture_output=True, text=True, timeout=180).stdout
        return out
    finally:
        for p in Path(path).parent.glob(Path(path).name + "*"):
            p.unlink(missing_ok=True)


def page_headings(page: "pymupdf.Page", body_size: float) -> list[tuple[int, str]]:
    """Заголовки страницы по размеру шрифта: строка крупнее основного текста."""
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        for line in b["lines"]:
            text = "".join(s["text"] for s in line["spans"]).strip()
            size = max(s["size"] for s in line["spans"])
            if text and 3 < len(text) <= 120 and not text.endswith((".", ";")) and size >= body_size + 1.5:
                out.append((line["bbox"][1], text))
    return sorted(out)


def document_body_size(doc: "pymupdf.Document") -> float:
    """Кегль основного текста по всему документу: самый частый, а не минимальный."""
    counts: dict[int, int] = {}
    for page in doc:
        for b in page.get_text("dict")["blocks"]:
            if b["type"] != 0:
                continue
            for line in b["lines"]:
                text = "".join(s["text"] for s in line["spans"]).strip()
                if len(text) < 30:
                    continue
                k = int(round(max(s["size"] for s in line["spans"])))
                counts[k] = counts.get(k, 0) + len(text)
    return float(max(counts, key=lambda k: counts[k])) if counts else 10.0


def extract_pdf(path: Path, ocr_mode: str, lang: str) -> tuple[list[dict], dict]:
    doc = pymupdf.open(path)
    stats = {"n_pages": len(doc), "n_text_pages": 0, "n_ocr_pages": 0, "n_tables": 0}
    body = document_body_size(doc)
    title = (doc.metadata or {}).get("title") or ""
    toc = doc.get_toc(simple=True)                      # закладки: самые надёжные заголовки
    sections: list[dict] = []
    current = {"title": title or path.stem, "level": 1, "parts": [], "pages": []}

    for page in doc:
        text, coverage = page_text_layer(page)
        used_ocr = False
        if ocr_mode == "always" or (ocr_mode == "auto" and len(text.strip()) < 80):
            # мало текста при большой площади = перед нами скан или картинка
            if coverage < 0.05 or ocr_mode == "always":
                pixmap = page.get_pixmap(dpi=300, colorspace=pymupdf.csGRAY)
                text = ocr_page(pixmap, lang=lang)
                used_ocr = True
                stats["n_ocr_pages"] += 1
        stats["n_text_pages"] += 0 if used_ocr else 1
        stats["n_tables"] += len(page.find_tables().tables) if hasattr(page, "find_tables") else 0

        clean = strip_boilerplate(text)
        if not clean:
            continue

        for _, head in page_headings(page, body):
            if current["parts"]:
                sections.append(current)
            current = {"title": head, "level": 1, "parts": [], "pages": [page.number + 1]}
        current["parts"].append(clean)
        current["pages"].append(page.number + 1)

    if current["parts"]:
        sections.append(current)
    for sec in sections:
        sec["text"] = "\n\n".join(sec.pop("parts"))
        sec["page_start"] = min(sec["pages"])
        sec["page_end"] = max(sec["pages"])
        sec["page"] = sec["page_start"]
    return sections, stats


def split_long(text: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """Аварийный разрез слишком большого раздела: по абзацам, с одним абзацем переноса."""
    parts, cur, tail = [], [], ""
    for para in text.split("\n\n"):
        cur.append(para)
        if len("\n\n".join(cur)) >= max_chars:
            parts.append("\n\n".join(cur))
            tail = cur[-1][:400]
            cur = [tail] if tail else []
    if cur:
        parts.append("\n\n".join(cur))
    return [p for p in parts if len(p.strip()) >= MIN_CHUNK_CHARS]


def ingest_file(path: Path, src_root: Path, ocr_mode: str, lang: str) -> tuple[list[dict], dict]:
    sections, stats = extract_pdf(path, ocr_mode, lang)
    file_hash = sha256_file(path)
    doc_id = str(path.relative_to(src_root)).replace("\\", "/")
    props = pymupdf.open(path).metadata or {}
    doc_title = (props.get("title") or "").strip() or path.stem
    meta_base = {
        "doc_id": doc_id,
        "source_path": str(path),
        "content_sha256": file_hash,
        "pipeline_version": PIPELINE_VERSION,
        "title": doc_title,
        "doc_date": (props.get("creationDate") or "")[:8] or None,
        "author": props.get("author") or None,
    }
    out, n = [], 0
    for sec in sections:
        for piece in split_long(sec["text"]):
            if len(piece.strip()) < MIN_CHUNK_CHARS:
                continue
            n += 1
            out.append({
                "chunk_id": f"{doc_id}::p{sec['page']:03d}::{n:04d}",
                "doc_id": doc_id,
                "text": piece,
                "metadata": {**meta_base,
                             "section": sec["title"],
                             "page": sec["page"],
                             "page_end": sec["page_end"],
                             "anchor": f"{path.name}#page={sec['page']}",
                             "n_chars": len(piece)},
            })
    return out, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ocr", choices=["auto", "always", "never"], default="auto")
    ap.add_argument("--lang", default="rus+eng")
    args = ap.parse_args()

    src, out_path = Path(args.src), Path(args.out)
    stats_rows, total, skipped = [], 0, 0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for pdf in sorted(src.rglob("*.pdf")):
            try:
                chunks, stats = ingest_file(pdf, src, args.ocr, args.lang)
            except Exception as exc:                      # один битый файл не роняет прогон
                skipped += 1
                stats_rows.append({"doc_id": pdf.name, "n_pages": 0, "n_text_pages": 0,
                                   "n_ocr_pages": 0, "n_tables": 0, "n_chunks": 0,
                                   "n_empty_chunks": 0, "chunk_tokens": [], "error": str(exc)[:200]})
                continue
            for c in chunks:
                fh.write(json.dumps(c, ensure_ascii=False) + "\n")
            total += len(chunks)
            skipped += 1 if not chunks else 0
            stats_rows.append({**stats, "doc_id": pdf.name, "n_chunks": len(chunks),
                               "n_empty_chunks": sum(1 for c in chunks
                                                     if c["metadata"]["n_chars"] < MIN_CHUNK_CHARS),
                               "chunk_tokens": [c["metadata"]["n_chars"] // 2 for c in chunks]})

    report = ingest_report(stats_rows)
    report["alerts"] = check_alerts(report)
    report["files_skipped"] = skipped
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["alerts"] else 0          # cron увидит ненулевой код и пришлёт алерт
```

```bash
# Запуск и использование результата
cd /opt/rag-pipeline
pip install pymupdf numpy opencv-python-headless pillow datasketch
python3 ingest.py --src /data/docs --out /var/lib/rag/chunks.jsonl --ocr auto
wc -l /var/lib/rag/chunks.jsonl
head -1 /var/lib/rag/chunks.jsonl | python3 -m json.tool

# Дальше по конвейеру из лекции о RAG-пайплайне:
#   chunks.jsonl -> chunk_document() -> эмбеддинги -> Qdrant -> поиск с top-k и rerank
```

Метаданные `page`, `section`, `anchor` в каждом чанке — это ровно то, что потом использует `render_chunk_for_prompt` из [лекции о RAG-пайплайне](mlops/06-rag-pipeline.md): заголовок инжектится в текст перед эмбеддингом и перед генерацией, а номер страницы попадает в цитату.

## Сравнение подходов к извлечению

| Подход | Скорость | Качество на чистом PDF | Качество на скане | Денежная стоимость | Сложность |
| --- | :---: | :---: | :---: | :---: | :---: |
| `pdftotext -layout` | секунды на файл | среднее: порядок сохранён, иерархии нет | **нулевое** | бесплатно | минимальная |
| PyMuPDF (блоки, шрифты, `find_tables`) | секунды на файл | **высокое**: заголовки, координаты, таблицы | нулевое | бесплатно | средняя |
| Tesseract + предобработка | 1–5 с на страницу | среднее (ломает хороший текст) | высокое на хороших сканах | бесплатно, только CPU | средняя |
| PyMuPDF + Tesseract по страницам без слоя | смешанная | **высокое** | высокое | бесплатно | средняя |
| Облачный OCR с разбором раскладки | 0,5–3 с на страницу | среднее | высокое на сложных раскладках | от долей цента до единиц центов за страницу | низкая в коде, высокая в деньгах |
| Мультимодальная модель | 5–30 с на страницу | среднее | лучшее на схемах, чертежах, формах | заметная сумма на корпусе | низкая в коде |

Когда платить нейросетевым OCR — честный ответ:

- **не платить**, если у скана ровный текст 300 dpi, и движок даёт уверенность выше 90 %: качество уже достаточное, а деньги потрачены зря;
- **платить за 5–15 % страниц**, если это формы, многострочные таблицы, бланки с рамками и схемы — там классический движок ломается системно, и предобработка не помогает;
- **платить за 100 % корпуса** только при потоке, который не окупает отдельный пайплайн: разовые загрузки на несколько тысяч страниц, где настройка своего конвейера дороже облака.

> [!NOTE]
> Стоимость облачного распознавания считается не по страницам, а по страницам × страницам в месяц. Корпус в 20 000 страниц, обрабатываемый при каждом полном пересборе раз в месяц, — это честные 20 000 страниц; тот же корпус при ежедневной переиндексации из-за развёрнутой инкрементальности — это уже 600 000 страниц в месяц. Прежде чем выбирать дорогой распознаватель, посчитай, сколько раз в месяц ты будешь прогонять корпус заново.

## Где это ломается

1. **Прогнали PDF с текстовым слоем через OCR.** Качество упало гарантированно: ошибки распознавания, разорванные слова, потерянная нумерация. Проверяй `pages_text_ratio` — если сканы вдруг стали 80 % корпуса, скорее всего, кто-то поменял режим.
2. **Таблицы отданы плоским текстом.** Числа без шапки — источник выдуманных значений в ответе. Таблица должна уходить в контекст markdown-таблицей целиком.
3. **Колонтитулы не вырезаны.** Чанки соседних страниц становятся почти одинаковыми, поиск выдаёт пять страниц одного документа. Симптом: в выдаче много «страница N».
4. **Бинаризация перед выравниванием.** Движок выравнивает страницу по подчёркиванию таблицы и получает 7° наклона. Порядок: выравнивание → обрезка → бинаризация.
5. **Документ удалили из папки, а чанки остались в векторной базе.** Индекс продолжает отвечать по отозванным или устаревшим данным. Разбор — [лекция о персональных данных](ru/02-personalnye-dannye-152fz.md), механика — манифест выше.
6. **Почти-дубли удаляются автоматически по порогу сходства.** Одно отличие в договоре не делает документы одинаковыми. Точный дубль — автоматом, похожий — человеку.
7. **Нет метаданных страницы и раздела.** Цитата превращается в «источник: документ», пользователь не может ни проверить ответ, ни удалить данные по запросу.
8. **Метрики пайплайна не выведены.** Загрузка не падает — она тихо деградирует, и узнаёшь об этом от пользователей через месяц. Минимум: `pages_text_ratio`, `index_docs_gauge`, `ocr_pages_ratio`.
9. **Один файл с ошибкой роняет весь прогон.** 1 200 документов, один битый PDF — и индекс не обновился ни для одного. Исключения ловятся, файл пишется в отчёт пропущенных.
10. **Презентация засунута целиком.** Сорок слайдов одним чанком: в эмбеддинге усредняются десять тем, и ни один вопрос не находит нужный слайд. Слайд — это юнит, у него есть заголовок, и это идеальный чанк.

## Чек-лист понимания

- [ ] Я различаю документы с текстовым слоем, сканы и смешанные страницы и знаю, что через OCR текстовый слой не гоняют
- [ ] Я умею объяснить, почему «каша» из `pdftotext` ломает RAG на четырёх уровнях: чанки, таблицы, колонтитулы, цитаты
- [ ] Я знаю, какие предобработки дают больший выигрыш, чем смена движка OCR, и в каком порядке их выполнять
- [ ] Я умею извлекать заголовки по размеру шрифта и по закладкам PDF и понимаю, почему структура поднимает качество сильнее, чем «просто текст»
- [ ] Я отдаю таблицу в контекст структурой, а не плоскими строками, и понимаю, к чему приводит разбор таблицы на строки
- [ ] Я перечисляю обязательные метаданные и объясняю, без какого из них невозможны цитата, фильтр по дате и удаление данных по отзыву согласия
- [ ] Я отличаю точный дубль от почти-дубля и знаю, почему второй нельзя удалять автоматически
- [ ] Я умею по манифесту вычислить список документов на удаление и понимаю, почему без этого чанки живут в векторной базе вечно
- [ ] Я знаю, какие метрики качества извлечения нужно вывести и по каким порогам на них строить алерт