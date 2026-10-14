#!/usr/bin/env python3
"""
build-trainer.py — встраивает внешний devops-тренажёр в портал.

Исходник: content/trainer/source.html (однофайловый тренажёр на JS + Tailwind).
Результат: lectures/trainer/index.html + assets/trainer/engine.js

Что делается с исходником:
  * убираются CDN-ссылки (шрифты, Tailwind) — всё берётся от портала;
  * цветовые литералы заменяются на CSS-переменные --tr-* темы сайта;
  * разметка body сохраняется: движок ищет конкретные id;
  * всплывающие окна заменяются на свёрстанные в теме портала;
  * счётчики курсов и заданий считаются в браузере из COURSES;
  * добавляется шапка портала и кнопка возврата в учебник.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "content", "trainer", "source.html")
OUT_HTML = os.path.join(ROOT, "lectures", "trainer", "index.html")
ASSETS = os.path.join(ROOT, "assets", "trainer")

# палитра тренажёра -> токены портала (см. trainer.css)
PALETTE = {
    "#3ddc84": "var(--tr-ok)",        "#7fe0b0": "var(--tr-ok-dim)",
    "#a9d9bd": "var(--tr-ok-dim)",     "#eafff3": "var(--tr-ok-bright)",
    "#c9e7d6": "var(--tr-ok-mute)",    "#5f8271": "var(--tr-ok-mute)",
    "#7fa08f": "var(--tr-ok-mute)",
    "#ffd166": "var(--tr-warn)",       "#ffd97f": "var(--tr-warn-dim)",
    "#ff7a7a": "var(--tr-err)",        "#ff5f8f": "var(--tr-pink)",
    "#f472b6": "var(--tr-pink)",       "#f0a6ca": "var(--tr-pink-dim)",
    "#ff9a3d": "var(--tr-orange)",     "#fb923c": "var(--tr-orange)",
    "#f43f5e": "var(--tr-red)",        "#a8a29e": "var(--tr-gray)",
    "#4da3ff": "var(--tr-accent)",     "#9ccaff": "var(--tr-accent-dim)",
    "#7fc4ff": "var(--tr-accent-dim)", "#22d3ee": "var(--tr-cyan)",
    "#c084fc": "var(--tr-accent2)",    "#c9a2ff": "var(--tr-accent2-dim)",
    "#818cf8": "var(--tr-accent2-dim)", "#a78bfa": "var(--tr-accent2)",
    "#34d399": "var(--tr-ok)",
    "#0b1218": "var(--tr-bg)",         "#0c141b": "var(--tr-bg2)",
    "#0a0f14": "var(--tr-bg3)",        "#070c10": "var(--tr-bg3)",
    "#06120b": "var(--tr-bg3)",
    "#101a22": "var(--tr-panel)",      "#0e1820": "var(--tr-panel)",
    "#152029": "var(--tr-panel2)",     "#16242e": "var(--tr-panel2)",
    "#1c2b35": "var(--tr-line)",       "#24384a": "var(--tr-line2)",
    "#24404f": "var(--tr-line2)",
    "#2a4356": "var(--tr-line3)",      "#33475a": "var(--tr-line3)",
    "#2a4a6a": "var(--tr-line-accent)", "#3d5566": "var(--tr-dim)",
    # тонированные границы кнопок-подсказок
    "#2a5a4a": "var(--tr-line-ok)",    "#4a2a6a": "var(--tr-line-accent2)",
    "#5a2a2a": "var(--tr-line-err)",   "#6a5a2a": "var(--tr-line-warn)",
    "#ff9a9a": "var(--tr-err-dim)",
}

HEX = re.compile(r"#[0-9a-fA-F]{6}\b")


def remap(text):
    text = re.sub(
        r"((?:bg|text|border|from|to|via|fill|stroke|shadow|ring|outline|decoration|caret|accent|placeholder)-)"
        r"\[(#[0-9a-fA-F]{6})\]",
        lambda m: f"{m.group(1)}[{PALETTE.get(m.group(2).lower(), m.group(2))}]",
        text,
    )
    return HEX.sub(lambda m: PALETTE.get(m.group(0).lower(), m.group(0)), text)


# --------------------------------------------------------------------------- #
# Всплывающие окна в теме портала
# --------------------------------------------------------------------------- #

WELCOME = """<div id="welM" class="ovl ovl-welcome open">
 <div class="mc wlc max-h-[92vh] overflow-y-auto scr">
  <div class="wlc-head">
   <div class="wlc-badge">
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--tr-ok)" stroke-width="1.5"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7L12 2z"/><circle cx="12" cy="12" r="3.2"/><path d="M12 5.5v3.3M12 15.2v3.3M6.3 8.8l2.9 1.6M14.8 13.6l2.9 1.6M6.3 15.2l2.9-1.6M14.8 10.4l2.9-1.6"/></svg>
   </div>
   <div>
    <div class="wlc-kicker">практический стенд учебника</div>
    <h2 class="wlc-title">DevOps Terminal Pro</h2>
    <p class="wlc-sub"><b id="wlcCourses">—</b> <span id="wlcCoursesW">курсов</span> ·
     <b id="wlcTasks">—</b> <span id="wlcTasksW">заданий</span> ·
     настоящие команды, ничего не ломается</p>
   </div>
  </div>

  <div class="wlc-boot">
   <div><i></i>loading kernel modules: kubectl, git, docker, ansible, terraform</div>
   <div><i></i>mounting /dev/brain &rarr; /skills</div>
   <div><i></i>starting cluster: 3 nodes ready · control node online</div>
   <div><i></i><span id="wlcFound">—</span> courses online</div>
   <div class="wlc-boot-wait">waiting for operator input<i class="caret-inline"></i></div>
  </div>

  <div class="wlc-grid" id="wlcGrid"></div>

  <div class="wlc-how">
   Читаете задание, вводите команду, среда реагирует. Застряли — три уровня
   подсказок и теория.
  </div>
  <div class="wlc-keys">
   <span><kbd>help</kbd> справка</span><span><kbd>&uarr;</kbd><kbd>&darr;</kbd> история</span>
   <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> курсор</span><span><kbd>Ctrl</kbd>+<kbd>L</kbd> очистка</span>
  </div>

  <button onclick="startCourse()" class="wlc-go">
   <span>&rarr;</span> Начать обучение — задание 1
  </button>
 </div>
</div>"""

HELP = """<div id="helpM" class="ovl" onclick="if(event.target===this)this.classList.remove('open')">
 <div class="mc wlc wlc-wide max-h-[85vh] overflow-y-auto scr">
  <div class="wlc-head">
   <div class="wlc-badge wlc-badge-acc">
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--tr-accent2)" stroke-width="1.7"><path d="M4 5.5A2.5 2.5 0 016.5 3H19v15H6.5A2.5 2.5 0 004 20.5z"/><path d="M4 20.5A2.5 2.5 0 016.5 18H19v3H6.5"/></svg>
   </div>
   <div>
    <div class="wlc-kicker">справочник</div>
    <h2 class="wlc-title">Курсы тренажёра</h2>
    <p class="wlc-sub">в каждом курсе <b>help</b> в терминале показывает доступные команды</p>
   </div>
   <button onclick="$('helpM').classList.remove('open')" class="wlc-close" aria-label="Закрыть">&times;</button>
  </div>
  <div id="helpG" class="wlc-grid wlc-grid-dense"></div>
 </div>
</div>"""

FINISH = """<div id="finM" class="ovl">
 <div class="mc wlc wlc-narrow">
  <div class="wlc-fin-icon">&#127942;</div>
  <h2 class="fd font-bold text-2xl mb-1" id="finT">КУРС ПРОЙДЕН</h2>
  <p class="text-sm mb-4" style="color:var(--tr-ok-dim)" id="finS"></p>
  <div class="wlc-cmds">
   <div class="wlc-cmds-t">освоенные команды</div>
   <div id="finC" class="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs t-ok"></div>
  </div>
  <div class="flex justify-center gap-2">
   <button onclick="$('finM').classList.remove('open')" class="hb">Закрыть</button>
   <button onclick="restart()" class="hb wlc-btn-ok">&#8635; Пройти заново</button>
  </div>
 </div>
</div>"""


def replace_modal(body, old_id, new_html):
    """Заменяет блок <div id="old_id"> ... </div> на новую разметку.

    Ленивый regex здесь не годится: внутри модалки много вложенных <div>,
    и `.*?</div>\\s*</div>` обрывается на первой же паре, оставляя хвост
    блока висеть в странице. Поэтому идём от открывающего тега и считаем
    глубину вложенности, чтобы найти настоящий закрывающий.
    """
    m = re.search(r'<div id="' + re.escape(old_id) + r'"[^>]*>', body)
    if not m:
        print(f"  ! не нашёл модалку {old_id}")
        return body
    start = m.start()
    i = m.end()
    depth = 1
    open_tag = re.compile(r"<div\b", re.I)
    close_tag = re.compile(r"</div\s*>", re.I)
    end = None
    while i < len(body) and depth > 0:
        nxt_open = open_tag.search(body, i)
        nxt_close = close_tag.search(body, i)
        if nxt_close is None:
            break
        if nxt_open is not None and nxt_open.start() < nxt_close.start():
            depth += 1
            i = nxt_open.end()
        else:
            depth -= 1
            i = nxt_close.end()
            if depth == 0:
                end = i
    if end is None:
        print(f"  ! не нашёл конец модалки {old_id}")
        return body
    return body[:start] + new_html + body[end:]


# --------------------------------------------------------------------------- #

def strip_external(html):
    html = re.sub(r"<script[^>]*src=[\"']https?://[^\"']+[\"'][^>]*>\s*</script>", "", html)
    html = re.sub(r"<link[^>]*href=[\"']https?://[^\"']*[\"'][^>]*>", "", html)
    return html


SCRIPT_TAIL = """
/* --- счётчики и сетка курсов в окне приветствия --- */
(function () {
  function fill() {
    var list = Object.keys(window.COURSES || {});
    if (!list.length) return;
    var tasks = 0;
    list.forEach(function (k) { tasks += (window.COURSES[k].ls || []).length; });
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    /* Русское склонение: 1 курс / 2 курса / 5 курсов; так же для заданий. */
    var plural = function (n, one, few, many) {
      var n10 = n % 10, n100 = n % 100;
      if (n10 === 1 && n100 !== 11) return one;
      if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
      return many;
    };
    set('wlcCourses', list.length);
    set('wlcTasks', tasks);
    set('wlcCoursesW', plural(list.length, 'курс', 'курса', 'курсов'));
    set('wlcTasksW', plural(tasks, 'задание', 'задания', 'заданий'));
    set('wlcFound', list.length);

    /* Панель вкладок строит engine.js в момент загрузки, когда в COURSES
       лежат только 12 базовых курсов. Курсы из course-*.js подключаются
       позже — без пересборки у них не будет ни вкладки, ни возможности
       переключиться (?course=). Поэтому строим заново. */
    if (typeof buildTabs === 'function') {
      try { buildTabs(); } catch (e) {}
    }
    /* Прогресс P[k] движок заводит при загрузке — тоже только для
       базовых 12. Без P[k] для нового курса switchCourse падает на
       loadLesson(P[c].cur) и панели остаются от предыдущего курса. */
    if (window.P) {
      Object.keys(window.COURSES || {}).forEach(function (k) {
        if (!window.P[k]) window.P[k] = { xp: 0, cur: 1, done: [] };
      });
    }
    /* Правую панель движок умеет рисовать только для 12 базовых курсов:
       там зашит список if (course==='net')… if (course==='cloud').
       Курсы из course-*.js отдают разметку через env(), но её никто
       не звал — панель оставалась пустой. Подставляем её сами.
       Базовые курсы env не объявляют, поэтому подмена их не задевает. */
    if (typeof window.renderEnv === 'function' && !window.__envWrapped) {
      window.__envWrapped = true;
      var baseRenderEnv = window.renderEnv;
      window.renderEnv = function () {
        var C = window.COURSES && window.COURSES[window.course];
        if (C && typeof C.env === 'function') {
          try {
            var t = document.getElementById('genT');
            var badge = document.getElementById('genC');
            var body = document.getElementById('genB');
            var kp = document.getElementById('k8sP');
            var lp = document.getElementById('linP');
            var gp = document.getElementById('genP');
            if (t) t.textContent = C.i + ' ' + C.n + ' · СРЕДА';
            if (badge) {
              badge.style.color = C.c;
              badge.innerHTML = '<span class="dot" style="background:' + C.c +
                ';box-shadow:0 0 8px ' + C.c + '"></span>online';
            }
            if (kp) kp.classList.add('hidden');
            if (lp) lp.classList.add('hidden');
            if (gp) gp.classList.remove('hidden');
            if (body) body.innerHTML = C.env() || '';
            return;
          } catch (e) { /* не вышло — рисуем штатно */ }
        }
        return baseRenderEnv.apply(this, arguments);
      };
    }

    var grid = document.getElementById('wlcGrid');
    if (grid && !grid.childNodes.length) {
      var groups = { 'DevOps': [], 'Данные и ИИ': [], 'Сеть': [] };
      var DEV = ['k8s', 'linux', 'net', 'git', 'docker', 'auto', 'ansible', 'cicd', 'obs', 'ops', 'data', 'cloud'];
      list.forEach(function (k) {
        var C = window.COURSES[k];
        var g = DEV.indexOf(k) !== -1 ? groups['DevOps']
              : (k === 'netdev' ? groups['Сеть'] : groups['Данные и ИИ']);
        g.push({ k: k, C: C });
      });
      var html = '';
      ['DevOps', 'Сеть', 'Данные и ИИ'].forEach(function (name) {
        var g = groups[name];
        if (!g.length) return;
        html += '<div class="wlc-group"><div class="wlc-group-t">' + name + '</div><div class="wlc-chips">';
        g.forEach(function (x) {
          html += '<button class="wlc-chip" data-course="' + x.k + '" style="--cc:' + x.C.c + '"'
            + ' title="' + String(x.C.ti || x.C.n).replace(/"/g, '&quot;') + '">'
            + '<span class="wlc-chip-i">' + x.C.i + '</span>'
            + '<span class="wlc-chip-n">' + x.C.n + '</span>'
            + '<span class="wlc-chip-c">' + (x.C.ls || []).length + '</span></button>';
        });
        html += '</div></div>';
      });
      grid.innerHTML = html;
      grid.addEventListener('click', function (e) {
        var b = e.target.closest('.wlc-chip');
        if (!b) return;
        var k = b.getAttribute('data-course');
        try { localStorage.setItem('devops-trainer-course', k); } catch (err) {}
        if (typeof switchCourse === 'function') { try { switchCourse(k); } catch (err) {} }
        var w = document.getElementById('welM');
        if (w) w.classList.remove('open');
        var inp = document.getElementById('inp');
        if (inp) inp.focus();
      });
    }
  }
  if (window.COURSES) fill();
  else document.addEventListener('DOMContentLoaded', fill);
  if (window.addEventListener) window.addEventListener('load', fill);
})();

/* --- переход из лекции: ?course=linux открывает нужный курс сразу --- */
(function () {
  var KEY = 'devops-trainer-course';
  var want = new URLSearchParams(location.search).get('course');
  var known = Object.keys(window.COURSES || {});
  try {
    if (!want) want = localStorage.getItem(KEY);
    if (want && known.indexOf(want) === -1) want = null;
  } catch (e) {}
  if (want && want !== window.course && typeof switchCourse === 'function') {
    try { switchCourse(want); } catch (e) {}
  }
  if (want) {
    try { localStorage.setItem(KEY, want); } catch (e) {}
    setTimeout(function () {
      var w = document.getElementById('welM');
      if (w) w.classList.remove('open');
      if (typeof startCourse === 'function') { try { startCourse(); } catch (e) {} }
    }, 0);
  }
})();

/* --- справочник в теме портала (переопределяем разметку движка) --- */
(function () {
  if (typeof window.COURSES === 'undefined') return;
  window.showHelp = function () {
    var box = document.getElementById('helpG');
    if (!box) return;
    var html = '';
    Object.keys(window.COURSES).forEach(function (k) {
      var C = window.COURSES[k];
      var ls = C.ls || [];
      html += '<div class="wlc-card" style="--cc:' + C.c + '">'
        + '<div class="wlc-card-t"><span>' + C.i + ' ' + C.n + '</span>'
        + '<span class="wlc-card-n">' + ls.length + ' заданий</span></div>'
        + '<div class="wlc-card-c">'
        + ls.slice(0, 3).map(function (l) { return '&middot; ' + l.t; }).join('<br>')
        + (ls.length > 3 ? '<br>&middot; и ещё ' + (ls.length - 3) + ' …' : '')
        + '</div></div>';
    });
    box.innerHTML = html;
    var m = document.getElementById('helpM');
    if (m) m.classList.add('open');
  };
})();

/* --- тема общая с порталом --- */
(function () {
  var saved = null;
  try { saved = localStorage.getItem('devops-mlops-theme'); } catch (e) {}
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  var t = document.getElementById('trTheme');
  if (!t) return;
  t.addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('devops-mlops-theme', next); } catch (e) {}
  });
})();
"""

PAGE = """<!DOCTYPE html>
<html lang="ru" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Тренажёр DevOps — учебник</title>
<meta name="description" content="Интерактивный тренажёр: настоящие команды в браузере. DevOps, RAG, промпты, инференс и сетевое оборудование.">
<link rel="stylesheet" href="../../assets/style.css">
<link rel="stylesheet" href="../../assets/trainer/trainer.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#9650;</text></svg>">
<style>
  :root { --grn: var(--tr-ok); --dim: var(--tr-ok-mute); --ln: var(--tr-line); }
  body { background: var(--tr-bg3); }
  .container { max-width: 1180px; }
</style>
</head>
<body class="tr-body">

<div class="tr-top">
  <div class="in">
    <a class="tr-back" href="../index.html">
      <svg viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      К учебнику
    </a>
    <span class="tr-name">Тренажёр <em>настоящие команды, ничего не ломается</em></span>
    <button class="tr-theme" id="trTheme" aria-label="Сменить тему">
      <svg viewBox="0 0 24 24" class="off" style="width:17px;height:17px"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>
      <svg viewBox="0 0 24 24" class="on" style="width:17px;height:17px"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>
    </button>
  </div>
</div>

__BODY__

<script src="../../assets/trainer/engine.js"></script>
<script src="../../assets/trainer/courses.js"></script>
__COURSE_SCRIPTS__
<script>__TAIL__</script>
</body>
</html>
"""


def course_scripts():
    """Подключает course-*.js по алфавиту — каждый курс в своём файле."""
    files = sorted(f for f in os.listdir(ASSETS)
                   if f.startswith("course-") and f.endswith(".js"))
    if not files:
        return ""
    return "\n".join(f'<script src="../../assets/trainer/{f}"></script>' for f in files)


def main():
    if not os.path.exists(SRC):
        sys.exit(f"Нет исходника: {SRC}")

    raw = strip_external(open(SRC, encoding="utf-8").read())

    body = remap(re.search(r"<body[^>]*>(.*)</body>", raw, re.S).group(1))
    js = remap("".join(re.findall(r"<script[^>]*>(.*?)</script>", raw, re.S)))

    # Все инлайн-скрипты исходника уезжают в engine.js. Оставлять их ещё и
    # в теле страницы нельзя: движок выполнится дважды — баннер и список
    # курсов печатаются повторно, а инициализация стартует в два раза.
    body = re.sub(r"<script[^>]*>.*?</script>", "", body, flags=re.S)
    body = re.sub(r"<script[^>]*/>\s*", "", body)

    # всплывающие окна в теме портала
    for mid, html in (("welM", WELCOME), ("helpM", HELP), ("finM", FINISH)):
        body = replace_modal(body, mid, html)

    # тосты переносим вверх — не перекрываются шапкой
    body = re.sub(r'id="toasts" class="fixed top-16', 'id="toasts" class="fixed top-14', body)

    os.makedirs(ASSETS, exist_ok=True)
    hdr = (
        "/* Движок тренажёра. Логика исходника не изменена.\n"
        " * Правка одна: цветовые литералы заменены на CSS-переменные --tr-*,\n"
        " * чтобы оформление наследовало тему портала.\n"
        " */\n"
    )
    with open(os.path.join(ASSETS, "engine.js"), "w", encoding="utf-8", newline="") as f:
        f.write(hdr + js)

    page = (PAGE.replace("__BODY__", body)
                .replace("__COURSE_SCRIPTS__", course_scripts())
                .replace("__TAIL__", SCRIPT_TAIL))
    os.makedirs(os.path.dirname(OUT_HTML), exist_ok=True)
    with open(OUT_HTML, "w", encoding="utf-8", newline="") as f:
        f.write(page)

    ids = sorted(set(re.findall(r"\$\('([a-zA-Z][\w]*)'\)", js)))
    missing = [i for i in ids if f'id="{i}"' not in body and f"id='{i}'" not in body]

    print(f"\n  движок  : {len(js):,} символов -> assets/trainer/engine.js")
    print(f"  страница: {len(page):,} символов -> lectures/trainer/index.html")
    print(f"  id, нужные движку: {len(ids)}, отсутствуют: {len(missing)}")
    if missing:
        print("    " + ", ".join(missing))
    print(f"  осталось цветовых литералов: {len(HEX.findall(body))} (это «маковские» кружки окна)\n")


if __name__ == "__main__":
    main()
