#!/usr/bin/env python3
"""
build.py — генератор статического учебника.

Использование:
    python build.py            # пересобрать сайт
    python build.py --serve    # пересобрать и поднять сервер на :8000
    python build.py --stats    # только статистика по курсу
    python build.py --check    # проверить битые внутренние ссылки

Зависимостей нет. Работает на чистом Python 3.9+.
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime

import minidown
from minidown import _relative, to_html

ROOT = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.join(ROOT, "content")
TEMPLATE = os.path.join(ROOT, "template.html")
OUT = os.path.join(ROOT, "lectures")

TRACKS = [
    {"id": "start", "name": "Старт", "color": "#8b9dc3", "icon": "◈"},
    {"id": "devops", "name": "DevOps", "color": "#38bdf8", "icon": "⬢"},
    {"id": "net", "name": "Сетевое оборудование", "color": "#fbbf24", "icon": "⬡"},
    {"id": "mlops", "name": "MLOps", "color": "#a78bfa", "icon": "◈"},
    {"id": "ru", "name": "Российский сегмент", "color": "#34d399", "icon": "▣"},
]

LEVELS = {
    "junior": "Новичок",
    "middle": "Продвинутый",
    "senior": "Профи",
    "pro": "Профи",
}

DEFAULTS = {
    "title": "",
    "summary": "",
    "track": "devops",
    "module": "",
    "order": "999",
    "duration": "",
    "level": "junior",
    "tags": "",
    "practice": "",
}

# --- привязка лекций к курсам тренажёра ------------------------------------ #
TRAINER_COURSES = {
    "k8s": ["kubernetes", "k8s", "под", "pod", "deployment", "ingress",
            "kubectl", "namespace", "контейнер в k8s", "кластер"],
    "linux": ["linux", "файл", "процесс", "systemd", "пайп", "grep", "find",
              "chmod", "sudo", "права", "журнал", "терминал", "юнит"],
    "net": ["сет", "порт", "dns", "маршрут", "интерфейс", "tcp", "udp",
            "vlan", "маршрутизац", "таблица маршрут", "ip-адрес"],
    "git": ["git", "ветк", "коммит", "merge", "rebase", "pull request",
            "истори", "дифф"],
    "docker": ["docker", "контейнер", "образ", "compose", "том", "volume"],
    "ansible": ["ansible", "плейбук", "inventory", "идемпотент", "плей"],
    "auto": ["cron", "скрипт", "bash", "автоматиз", "планировщик", "шелл",
            "очеред", "воркер", "kafka", "rabbitmq", "dlq", "worker"],
    "cicd": ["ci/cd", "пайплайн", "github actions", "gitlab", "сборк",
             "деплой", "релиз", "ci", "тестовый набор"],
    "obs": ["prometheus", "графан", "метрик", "алерт", "мониторинг", "лог",
            "трейс", "наблюдаемост", "экспортер", "snmp", "health-check",
            "балансировк", "отказоустойчивост", "keepalived", "healthcheck"],
    "ops": ["systemd", "юнит", "nginx", "сервис", "эксплуатац", "хоста",
            "обновлен", "пользовател", "backup", "бэкап", "rpo", "rto",
            "восстановление", "active directory", "gpo", "репликация",
            "dcdiag", "лес", "dr"],
    "data": ["postgres", "redis", "sql", "база данных", "запрос", "индекс",
             "vacuum", "кэш"],
    "cloud": ["aws", "terraform", "облак", "ec2", "finops", "затрат",
              "стоимост"],
    "rag": ["rag", "retrieval", "pgvector", "эмбеддинг", "векторн", "чанк",
            "rerank", "grounding", "базе знаний", "поиск по документ",
            "llm-поиск", "цитат", "ocr", "датасет", "разметк",
            "пайплайн данных"],
    "prompt": ["промпт", "prompt", "system prompt", "инструкци модел",
               "шаблон запрос", "promptfoo", "jinja", "nunjucks",
               "формулировк", "тон ответ", "system message", "оценка llm"],
    "inference": ["инференс", "inference", "gpu", "vllm", "ollama", "llama",
                  "квантизац", "gguf", "batch", "ttft", "пропускная способност",
                  "лимит запрос", "шлюз", "gateway", "openai-совместим",
                  "llm-систем", "llmops", "дообуч", "масштабирован",
                  "контекстное окн", "как устроена llm", "локальная инфраструктур",
                  "self-hosted", "vram", "цена вопроса"],
    "mlops": ["mlflow", "langfuse", "grafana", "прометеус", "prometheus",
              "трассиров", "трейс", "trace", "эксперимент", "реестр моделей",
              "реестр промптов", "алерт", "дашборд", "mlops", "llmops",
              "пайплайн", "метрик качества", "логирование", "артефакт"],
    "agents": ["агент", "agent", "mcp", "prompt injection", "инъекц", "инъек",
               "утечк", "пдн", "152-фз", "персональн", "отравлен",
               "привилеги", "аудит", "секрет", "маскир", "data poisoning",
               "jailbreak"],
    "incident": ["диплом", "постмортем", "post-mortem", "postmortem",
                 "инцидент", "incident", "дежурн", "разбор отказ", "rca",
                 "mta", "mttr", "sla", "бюджет", "roi", "стоимость внедрения"],
    "python": ["python", "numpy", "тензор", "asyncio", "асинхрон",
               "venv", "pip", "pytest", "mypy", "градиентн", "переобучен",
               "точность и полнота", "python для ml", "математик",
               "классификация", "регрессия", "val test", "функция потерь",
               "обучение модели", "гиперпараметр"],
    "netdev": ["routeros", "cisco", "коммутатор", "access-port", "trunk",
               "vlan", "bridge", "ethernet", "ios", "уровень 3", "l3",
               "конфигурац устройств", "сетев оборудован"],
}

# Лекции треков, которые почти целиком относятся к одному курсу тренажёра.
# None — курс выбирается подбором по ключевым словам.
TRACK_COURSE = {
    "devops": None,
    "net": "netdev",
    "mlops": None,
    "ru": None,
}
# Для этих треков релевантен только набор курсов про LLM и агентов.
AI_COURSES = ("rag", "prompt", "inference", "mlops", "agents", "incident", "python")
AI_TRACKS = ("mlops", "ru")


def guess_trainer(it):
    """Подбирает курс тренажёра по содержанию лекции. None — если не уверен."""
    track = it["track"]
    if track not in TRACK_COURSE:
        return None
    forced = TRACK_COURSE[track]
    if forced:
        return forced
    hay = " ".join([
        it["title"].lower(), it["summary"].lower(), it["module"].lower(),
        " ".join(it["tags"]).lower(),
    ])
    allowed = AI_COURSES if track in AI_TRACKS else None
    best, best_score = None, 0
    for course, words in TRAINER_COURSES.items():
        if allowed and course not in allowed:
            continue
        score = sum(2 if w in it["title"].lower() else 1
                    for w in words if w in hay)
        if score > best_score:
            best, best_score = course, score
    return best if best_score >= 2 else None


TRAINER_LABELS = {
    "k8s": "Kubernetes", "linux": "Linux", "net": "Сети", "git": "Git",
    "docker": "Контейнеры", "ansible": "Ansible", "auto": "Автоматизация",
    "cicd": "CI/CD", "obs": "Наблюдаемость", "ops": "OPS",
    "data": "Данные", "cloud": "Cloud",
    "rag": "RAG · PG", "prompt": "Промпты", "inference": "Инференс",
    "netdev": "Сеть · оборудование", "agents": "Агенты · безопасность",
    "mlops": "MLflow · Langfuse", "incident": "Инцидент · постмортем",
    "python": "Python · ML",
}


# --------------------------------------------------------------------------- #

def parse_frontmatter(text):
    """Достаёт YAML-подобный frontmatter. Поддерживает key: value и key: [a, b]."""
    meta = dict(DEFAULTS)
    if not text.startswith("---"):
        return meta, text
    end = text.find("\n---", 3)
    if end == -1:
        return meta, text
    block = text[3:end].strip("\n")
    body = text[end + 4 :].lstrip("\n")

    for line in block.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip().lower()
        val = val.strip().strip('"').strip("'")
        meta[key] = val
    return meta, body


def load_lessons():
    items = []
    for dirpath, _dirnames, filenames in os.walk(CONTENT):
        for fn in sorted(filenames):
            if not fn.endswith(".md") or fn.startswith("_"):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, CONTENT).replace("\\", "/")
            if rel == "index.md":
                continue
            with open(full, encoding="utf-8") as f:
                raw = f.read()
            meta, body = parse_frontmatter(raw)
            if not meta["title"]:
                meta["title"] = fn[:-3].replace("-", " ").title()

            slug = fn[:-3]
            track = meta["track"]
            out_path = f"lectures/{track}/{slug}.html"

            try:
                order = float(meta["order"])
            except ValueError:
                order = 999.0

            items.append(
                {
                    "slug": slug,
                    "track": track,
                    "title": meta["title"],
                    "summary": meta["summary"],
                    "module": meta["module"],
                    "order": order,
                    "duration": meta["duration"],
                    "level": LEVELS.get(meta["level"].lower(), meta["level"]),
                    "level_key": meta["level"].lower(),
                    "tags": [t.strip() for t in meta["tags"].strip("[]").split(",") if t.strip()],
                    "practice": meta["practice"],
                    "body": body,
                    "src": rel,
                    "out": out_path,
                }
            )

    torder = {t["id"]: i for i, t in enumerate(TRACKS)}
    items.sort(key=lambda x: (torder.get(x["track"], 99), x["order"], x["title"]))

    # сквозная нумерация + соседи
    for idx, it in enumerate(items):
        it["n"] = idx + 1
        it["total"] = len(items)
        prev = items[idx - 1] if idx > 0 else None
        nxt = items[idx + 1] if idx + 1 < len(items) else None
        it["prev"] = {"url": prev["out"], "title": prev["title"]} if prev else None
        it["next"] = {"url": nxt["out"], "title": nxt["title"]} if nxt else None
    return items


def build_curriculum(items):
    """Дерево: трек -> модуль -> лекции (только метаданные, без тела)."""
    tree = []
    for t in TRACKS:
        tl = [i for i in items if i["track"] == t["id"]]
        if not tl:
            continue
        modules = []
        for it in tl:
            mname = it["module"] or "Общее"
            found = None
            for m in modules:
                if m["name"] == mname:
                    found = m
                    break
            if not found:
                found = {"name": mname, "lessons": []}
                modules.append(found)
            # только метаданные: полный body в JSON программы попадать не должен
            found["lessons"].append(
                {
                    "slug": it["slug"],
                    "title": it["title"],
                    "out": it["out"],
                    "track": it["track"],
                    "duration": it["duration"],
                    "level": it["level"],
                    "level_key": it["level_key"],
                }
            )

        tree.append(
            {
                "id": t["id"],
                "name": t["name"],
                "color": t["color"],
                "icon": t["icon"],
                "count": len(tl),
                "hours": _hours(tl),
                "modules": modules,
            }
        )
    return tree


def _hours(lessons):
    """Суммарная длительность в ЧАСАХ (округлённая до десятых)."""
    total = 0
    for it in lessons:
        m = re.search(r"(\d+)", it.get("duration", ""))
        if m:
            total += int(m.group(1))
    return round(total / 60.0, 1)


def track_cards(curriculum, lessons, base):
    cards = []
    for t in curriculum:
        ls = [i for i in lessons if i["track"] == t["id"]]
        items = "".join(
            f'<li><a href="{_relative(base, i["out"])}">{i["title"]}</a>'
            f'<span class="mini">{i["module"]}</span></li>'
            for i in ls
        )
        cards.append(
            f'<div class="track-card" style="--tc:{t["color"]}">'
            f'<h3><span class="ticon">{t["icon"]}</span>{t["name"]}</h3>'
            f'<div class="track-meta">{t["count"]} лекций · ~{t["hours"]} ч</div>'
            f"<ul>{items}</ul></div>"
        )
    return '<div class="track-grid">' + "".join(cards) + "</div>"


def meta_badge(it):
    parts = []
    if it["duration"]:
        parts.append(f'<span class="badge">{it["duration"]}</span>')
    parts.append(f'<span class="badge lvl-{it["level_key"]}">{it["level"]}</span>')
    if it["practice"]:
        parts.append(f'<span class="badge practice">Практика</span>')
    return "".join(parts)


def page_for_src(src):
    """content/<track>/<slug>.md  ->  lectures/<track>/<slug>.html"""
    if src in ("index.md", "index"):
        return "index.html"
    return "lectures/" + (src[:-3] if src.endswith(".md") else src) + ".html"


FENCE_SPLIT_RE = re.compile(r"(^```.*?^```\s*$)", re.M | re.S)


def build_link_map(lessons):
    """'devops/01-x.md' -> 'lectures/devops/01-x.html'"""
    m = {it["src"]: it["out"] for it in lessons}
    m["index.md"] = "index.html"
    return m


def resolve_link(target, src, linkmap):
    """Ищет страницу для ссылки на исходник. Ссылка может быть записана
    и относительно своей папки ('02-x.md'), и относительно content/ ('devops/02-x.md')."""
    if target.startswith("#") or "://" in target or target.startswith("mailto:"):
        return target
    base = os.path.dirname(src)
    cands = []
    if target.startswith("/"):
        cands.append(target[1:])
    else:
        if base:
            cands.append(os.path.normpath(os.path.join(base, target)))
        cands.append(os.path.normpath(target))
    for c in cands:
        c = c.replace("\\", "/")
        if c in linkmap:
            return linkmap[c]
    return None


def resolve_body_links(body, src, linkmap, base_page):
    """Переписывает ссылки на .md в готовые относительные .html. Код не трогаем."""
    def repl(match):
        label, target = match.group(1), match.group(2)
        if not target.endswith(".md"):
            return match.group(0)
        page = resolve_link(target, src, linkmap)
        if page is None:
            return match.group(0)
        return f"[{label}]({minidown._relative(base_page, page)})"

    parts = FENCE_SPLIT_RE.split(body)
    for i in range(0, len(parts), 2):
        parts[i] = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", repl, parts[i])
    return "".join(parts)


def render_page(template, it, curriculum_json, search_json):
    body = it.get("body_resolved") or it["body"]
    content_html = (it.get("prefix_html", "") or "") + to_html(
        body, it.get("base_page", "")
    )

    tags_html = ""
    if it["tags"]:
        tags_html = '<div class="tags">' + "".join(
            f'<span class="tag">{t}</span>' for t in it["tags"]
        ) + "</div>"

    # добавляем ID к заголовкам h2 для оглавления
    headings = re.findall(r'<h([23]) id="([^"]+)">(.*?)</h\1>', content_html)
    toc = ""
    if headings:
        lis = "".join(
            f'<li class="toc-l{lvl}"><a href="#{aid}">'
            f'{re.sub(r"<[^>]+>", "", txt)}</a></li>'
            for lvl, aid, txt in headings
        )
        toc = f'<nav class="toc"><div class="toc-title">На этой странице</div><ul>{lis}</ul></nav>'

    practice_html = ""
    if it["practice"]:
        practice_html = (
            '<div class="practice-box">'
            '<div class="practice-title">\U0001f6e0 Практика</div>'
            f'<div>{minidown.render_inline(it["practice"])}</div></div>'
        )

    # кнопка «потренироваться» — только для трека DevOps, где есть совпадение
    trainer_html = ""
    course = it.get("trainer_course")
    if course:
        label = TRAINER_LABELS.get(course, course)
        trainer_html = (
            f'<a class="trainer-btn" href="../trainer/index.html?course={course}">'
            f'<span class="tb-ico">▸</span>'
            f'<span class="tb-txt"><b>Потренироваться в тренажёре</b>'
            f'<em>курс «{label}» — 20 курсов, 321 задание, ничего не ломается</em></span>'
            f'<span class="tb-go">→</span></a>'
        )

    if it["prev"]:
        prev_html = (
            f'<a class="nav-prev" href="{_relative(it["out"], it["prev"]["url"])}">'
            f'<span>\u2190 Предыдущая</span><b>{it["prev"]["title"]}</b></a>'
        )
    else:
        prev_html = '<span></span>'

    if it["next"]:
        next_html = (
            f'<a class="nav-next" href="{_relative(it["out"], it["next"]["url"])}">'
            f'<span>Следующая \u2192</span><b>{it["next"]["title"]}</b></a>'
        )
    else:
        next_html = '<span></span>'

    values = {
        "{{TITLE}}": it["title"],
        "{{BASE}}": "../" * it["out"].count("/"),
        "{{SUMMARY}}": it["summary"],
        "{{TRACK}}": it["track"],
        "{{TRACK_NAME}}": next(
            (t["name"] for t in TRACKS if t["id"] == it["track"]), it["track"]
        ),
        "{{MODULE}}": it["module"],
        "{{N}}": str(it["n"]),
        "{{TOTAL}}": str(it["total"]),
        "{{META}}": meta_badge(it),
        "{{TAGS}}": tags_html,
        "{{CONTENT}}": content_html,
        "{{TOC}}": toc,
        "{{PRACTICE}}": practice_html,
        "{{TRAINER}}": trainer_html,
        "{{PREV}}": prev_html,
        "{{NEXT}}": next_html,
        "{{SLUG}}": it["track"] + "/" + it["slug"],
        "{{HERO}}": it.get("hero", ""),
        "{{ARTCLASS}}": it.get("artclass", ""),
        "{{CURICULUM_JSON}}": curriculum_json,
        "{{SEARCH_JSON}}": search_json,
        "{{BUILD}}": datetime.now().strftime("%d.%m.%Y %H:%M"),
        "{{YEAR}}": str(datetime.now().year),
    }

    html = template
    for k, v in values.items():
        html = html.replace(k, v)
    return html


def build(lessons, quiet=False):
    linkmap = build_link_map(lessons)
    for it in lessons:
        it["base_page"] = page_for_src(it["src"])
        it["body_resolved"] = resolve_body_links(it["body"], it["src"], linkmap, it["base_page"])
        it["trainer_course"] = guess_trainer(it)

    curriculum = build_curriculum(lessons)
    curriculum_json = json.dumps(curriculum, ensure_ascii=False)

    search = []
    for it in lessons:
        search.append(
            {
                "t": it["title"],
                "s": it["summary"],
                "g": it["tags"],
                "k": it["track"],
                "m": it["module"],
                "u": it["out"],
                "n": it["n"],
            }
        )
    search_json = json.dumps(search, ensure_ascii=False)

    with open(TEMPLATE, encoding="utf-8") as f:
        template = f.read()

    written = 0
    for it in lessons:
        dest = os.path.join(ROOT, it["out"])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(render_page(template, it, curriculum_json, search_json))
        written += 1

    # главная страница
    idx_src = os.path.join(CONTENT, "index.md")
    if os.path.exists(idx_src):
        with open(idx_src, encoding="utf-8") as f:
            raw = f.read()
        meta, body = parse_frontmatter(raw)
        total_h = _hours(lessons)
        n_prac = len([i for i in lessons if i["practice"]])
        hero = (
            '<section class="hero">'
            '<h1>DevOps <em>&amp;</em> MLOps:<br>учебник от новичка до про</h1>'
            '<p>Полный практический курс: Linux и сети, контейнеры и Kubernetes, '
            'CI/CD и наблюдаемость — и поверх этого полный цикл ML/LLM-систем: '
            'от Python и RAG до инференса, агентов и продакшн-эксплуатации.</p>'
            '<div class="hero-stats">'
            f'<div class="hs-item"><b>{len(lessons)}</b><span>лекций</span></div>'
            f'<div class="hs-item"><b>{total_h}</b><span>часов</span></div>'
            f'<div class="hs-item"><b>{n_prac}</b><span>с практикой</span></div>'
            f'<div class="hs-item"><b>{len(curriculum)}</b><span>трека</span></div>'
            "</div></section>"
        )
        home = {
            "out": "index.html",
            "base_page": "index.html",
            "body_resolved": resolve_body_links(body, "index.md", linkmap, "index.html"),
            "title": "Учебник DevOps & MLOps",
            "body": body,
            "summary": "Практический курс DevOps и MLOps",
            "track": "start",
            "slug": "__home__",
            "tags": [],
            "practice": "",
            "duration": "",
            "level": "",
            "level_key": "",
            "module": "",
            "n": "0",
            "total": str(len(lessons)),
            "hero": hero,
            "artclass": " home",
            "prefix_html": trainer_banner() + track_cards(curriculum, lessons, "index.html"),
            "trainer_course": None,
            "prev": {"url": "lectures/index.html", "title": "Все лекции"},
            "next": {
                "url": lessons[0]["out"] if lessons else "#",
                "title": lessons[0]["title"] if lessons else "Начать",
            },
        }
        home_html = render_page(template, home, curriculum_json, search_json)
        with open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8") as f:
            f.write(home_html)
        written += 1

    # страница со списком всех лекций
    # страница со списком всех лекций
    listing_page = "lectures/index.html"
    if lessons:
        index_hours = _hours(lessons)
        rows = []
        for it in lessons:
            link = _relative(listing_page, it["out"])
            rows.append(
                f'<tr><td class="num">{it["n"]}</td>'
                f'<td><span class="dot track-{it["track"]}"></span>'
                f'<a href="{link}">{it["title"]}</a>'
                f'<div class="row-sub">{it["summary"]}</div></td>'
                f'<td class="mod">{it["module"]}</td>'
                f'<td class="lvl"><span class="lvl-pill lvl-{it["level_key"]}">{it["level"]}</span></td>'
                f'<td class="dur">{it["duration"]}</td></tr>'
            )
        cards = track_cards(curriculum, lessons, listing_page)

        page = template
        vals = {
            "{{TITLE}}": "Все лекции",
            "{{BASE}}": "../",
            "{{SUMMARY}}": "Полный индекс учебника",
            "{{TRACK}}": "start",
            "{{TRACK_NAME}}": "Все лекции",
            "{{MODULE}}": "Индекс",
            "{{N}}": "0",
            "{{TOTAL}}": str(len(lessons)),
            "{{META}}": (
                f'<span class="badge">{len(lessons)} лекций</span>'
                f'<span class="badge">~{index_hours} ч</span>'
            ),
            "{{TAGS}}": "",
            "{{CONTENT}}": (
                cards
                + '<h2 id="polnyj-indeks">Полный индекс</h2>'
                + '<div class="table-wrap"><table class="index-table"><thead><tr>'
                + "<th>#</th><th>Лекция</th><th>Модуль</th><th>Уровень</th><th>Время</th>"
                + "</tr></thead><tbody>" + "".join(rows) + "</tbody></table></div>"
            ),
            "{{TOC}}": "",
            "{{PRACTICE}}": "",
            "{{TRAINER}}": "",
            "{{PREV}}": '<a class="nav-prev" href="../index.html"><span>\u2190</span><b>На главную</b></a>',
            "{{NEXT}}": "",
            "{{SLUG}}": "__index__",
            "{{HERO}}": "",
            "{{ARTCLASS}}": "",
            "{{CURICULUM_JSON}}": curriculum_json,
            "{{SEARCH_JSON}}": search_json,
            "{{BUILD}}": datetime.now().strftime("%d.%m.%Y %H:%M"),
            "{{YEAR}}": str(datetime.now().year),
        }
        for k, v in vals.items():
            page = page.replace(k, v)
        dest = os.path.join(ROOT, "lectures", "index.html")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(page)
        written += 1
    if not quiet:
        total_h = _hours(lessons)
        print(f"\n  Собрано {written} страниц из {len(lessons)} лекций  ·  ~{total_h} ч материала\n")
        for t in curriculum:
            print(f"   {t['icon']}  {t['name']:<8} {t['count']:>3} лекций  {t['hours']:>4} ч")
        print("\n  -> открой index.html в браузере\n")
    return written


def check_links(lessons):
    """Ищет битые внутренние ссылки в .md-исходниках."""
    linkmap = build_link_map(lessons)
    broken = []
    for it in lessons:
        parts = FENCE_SPLIT_RE.split(it["body"])
        for i in range(0, len(parts), 2):
            for m in re.finditer(r"\[([^\]]+)\]\(([^)\s]+)\)", parts[i]):
                target = m.group(2)
                if "://" in target or target.startswith("#") or target.startswith("mailto:"):
                    continue
                if resolve_link(target, it["src"], linkmap) is None:
                    broken.append((it["src"], target))
    if broken:
        print("\n  Битые ссылки:")
        for src, target in broken:
            print(f"   {src}  ->  {target}")
        return 1
    print("\n  Все внутренние ссылки в порядке.\n")
    return 0


def stats(lessons):
    total_h = _hours(lessons)
    print(f"\n  Лекций: {len(lessons)}")
    print(f"  Объём:  ~{total_h} ч")
    print(f"  Практических заданий: {len([i for i in lessons if i['practice']])}")
    for t in TRACKS:
        ls = [i for i in lessons if i["track"] == t["id"]]
        if ls:
            print(f"    {t['name']:<8} {len(ls):>3} лекций, {_hours(ls):>4} ч, "
                  f"{len([i for i in ls if i['practice']])} с практикой")
    print()


def build_trainer():
    """Пересобирает тренажёр, если есть исходник content/trainer/source.html."""
    src = os.path.join(ROOT, "content", "trainer", "source.html")
    gen = os.path.join(ROOT, "build-trainer.py")
    if not (os.path.exists(src) and os.path.exists(gen)):
        return False
    import subprocess
    r = subprocess.run([sys.executable, gen], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("  ! тренажёр не собран:\n" + (r.stderr or "")[:500])
        return False
    return True


def trainer_banner(count=None):
    """Баннер-вход в тренажёр на главной странице."""
    return (
        '<a class="trainer-hero" href="lectures/trainer/index.html">'
        '<div class="th-l">'
        '<div class="th-kicker">практический стенд</div>'
        '<div class="th-t">Тренажёр DevOps и LLM</div>'
        '<div class="th-d">20 курсов · 321 задание · настоящие команды в '
        'браузере. Kubernetes, сети RouterOS/IOS, RAG на PostgreSQL, '
        'промпты, инференс — сломать ничего нельзя.</div>'
        '</div>'
        '<div class="th-r"><span>Открыть</span><b>→</b></div>'
        "</a>"
    )


def main():
    # Windows-консоль по умолчанию cp1251 — переключаем на UTF-8
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--stats", action="store_true")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    if not os.path.exists(TEMPLATE):
        sys.exit("Не найден template.html")

    lessons = load_lessons()
    if not lessons:
        sys.exit("В content/ нет ни одной лекции.")

    if args.stats:
        stats(lessons)
        return

    build(lessons)

    if build_trainer() and not args.stats:
        print("  ▸ тренажёр собран: lectures/trainer/index.html")

    if args.check:
        sys.exit(check_links(lessons))

    if args.serve:
        import http.server
        import socketserver

        os.chdir(ROOT)
        port = args.port
        while port < args.port + 20:
            try:
                socketserver.TCPServer.allow_reuse_address = True
                with socketserver.TCPServer(("", port), http.server.SimpleHTTPRequestHandler) as httpd:
                    print(f"\n  Учебник: http://localhost:{port}/")
                    print("  Остановить — Ctrl+C\n")
                    try:
                        httpd.serve_forever()
                    except KeyboardInterrupt:
                        print("\n  Сервер остановлен.\n")
                        return
            except OSError:
                port += 1


if __name__ == "__main__":
    main()
