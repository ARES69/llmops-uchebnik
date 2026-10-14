"""
minidown — минималистичный Markdown -> HTML без внешних зависимостей.

Поддерживает подмножество, достаточное для учебника:
  #..###### заголовки (с авто-якорями)
  ``` блоки кода с подсветкой номерами строк и копированием
  > цитаты и GitHub-алерты [!NOTE] [!TIP] [!WARNING] [!IMPORTANT] [!CAUTION]
  | таблицы | с выравниванием
  - * + / 1. списки с вложенностью и задачами (- [ ])
  --- горизонтальные линии
  `код` **жирный** *курсив* ~~зачёркнутый~~ [ссылка](url) ![картинка](url)
"""

import html
import re
import unicodedata

FENCE_RE = re.compile(r"^(`{3,}|~{3,})\s*([\w+#.-]*)\s*$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
HR_RE = re.compile(r"^(-{3,}|\*{3,}|_{3,})\s*$")
LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$")
CALLOUT_RE = re.compile(r"^\[!(\w+)\]\s*$", re.I)

CALLOUTS = {
    "note": ("Заметка", "i"),
    "tip": ("Подсказка", "\u2728"),
    "warning": ("Внимание", "!"),
    "important": ("Важно", "\u26a0"),
    "caution": ("Осторожно", "\u26a1"),
}


# --------------------------------------------------------------------------- #
# Утилиты
# --------------------------------------------------------------------------- #

def slugify(text):
    """Транслитерирует заголовок в якорь (RU -> латиница, чтобы ссылки были читаемы)."""
    table = {
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
        "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
        "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
        "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    }
    out = []
    for ch in text.lower():
        if ch in table:
            out.append(table[ch])
        elif "a" <= ch <= "z" or "0" <= ch <= "9":
            out.append(ch)
        elif ch in " -_":
            out.append("-")
        elif unicodedata.category(ch).startswith("L"):
            try:
                tr = ch.encode("ascii", "ignore").decode().lower()
                if tr:
                    out.append(tr)
            except Exception:
                pass
    slug = re.sub(r"-+", "-", "".join(out)).strip("-")
    return slug or "section"


def _esc(s):
    return html.escape(s, quote=False)


def _split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    cells, buf, esc = [], [], False
    for ch in line:
        if esc:
            buf.append(ch)
            esc = False
            continue
        if ch == "\\":
            esc = True
        elif ch == "|":
            cells.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    cells.append("".join(buf).strip())
    return cells


# --------------------------------------------------------------------------- #
# Инлайновая разметка
# --------------------------------------------------------------------------- #

def render_inline(text, base=""):
    store = []

    def stash(m):
        store.append(m.group(2).strip())
        return f"\x00{len(store) - 1}\x00"

    # 1. Вырезаем инлайн-код, чтобы разметка внутри него не обрабатывалась
    text = re.sub(r"(`+)(.+?)\1", stash, text, flags=re.S)
    text = _esc(text)

    # 2. Картинки
    def img(m):
        alt, url, title = m.group(1), m.group(2), m.group(3) or ""
        t = f' title="{_esc(title)}"' if title else ""
        return f'<img src="{url}" alt="{alt}" loading="lazy"{t}>'

    text = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"([^\"]*)\")?\)", img, text)

    # 3. Ссылки
    def link(m):
        label, url, title = m.group(1), m.group(2), m.group(3) or ""
        t = f' title="{_esc(title)}"' if title else ""
        ext = ""
        if url.startswith("http://") or url.startswith("https://"):
            ext = ' target="_blank" rel="noopener noreferrer"'
        elif url.startswith("#"):
            pass
        elif base and not url.endswith(".html"):
            # внутренняя ссылка на исходник лекции -> на сгенерированную страницу
            url = _relative(base, "lectures/" + url[:-3] + ".html" if url.endswith(".md")
                            else url)
        return f'<a href="{url}"{t}{ext}>{label}</a>'

    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)(?:\s+\"([^\"]*)\")?\)", link, text)

    # 4. Акценты (от более длинного к более короткому)
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<strong><em>\1</em></strong>", text, flags=re.S)
    text = re.sub(r"(?<![\w*])\*\*(?!\s)(.+?)(?<!\s)\*\*(?![\w*])", r"<strong>\1</strong>", text, flags=re.S)
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<strong><em>\1</em></strong>", text, flags=re.S)
    text = re.sub(r"___(.+?)___", r"<strong><em>\1</em></strong>", text, flags=re.S)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text, flags=re.S)
    text = re.sub(r"__(.+?)__", r"<strong>\1</strong>", text, flags=re.S)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text, flags=re.S)
    text = re.sub(r"(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])", r"<em>\1</em>", text, flags=re.S)
    text = re.sub(r"~~(.+?)~~", r"<del>\1</del>", text, flags=re.S)

    # 5. Возвращаем код
    text = re.sub(
        r"\x00(\d+)\x00",
        lambda m: f"<code>{_esc(store[int(m.group(1))])}</code>",
        text,
    )
    return text


def _relative(from_page, to_page):
    """Оба аргумента — пути страниц относительно корня сайта.

    _relative("lectures/index.html",              "lectures/devops/01-x.html")
      -> "../lectures/devops/01-x.html"
    _relative("lectures/devops/01-x.html",        "lectures/devops/02-y.html")
      -> "../../lectures/devops/02-y.html"
    """
    levels = from_page.count("/")
    out = []
    for seg in ("../" * levels + to_page).split("/"):
        if seg == "..":
            if out and out[-1] == "..":
                out.append(seg)
            elif out:
                out.pop()
            else:
                out.append(seg)
        elif seg in ("", "."):
            continue
        else:
            out.append(seg)
    return "/".join(out)


# --------------------------------------------------------------------------- #
# Блочный разбор
# --------------------------------------------------------------------------- #

class _Ctx:
    def __init__(self):
        self.headings = []


# --------------------------------------------------------------------------- #
# Подсветка синтаксиса (лёгкая, регулярками)
# --------------------------------------------------------------------------- #

_KEYWORDS = {
    "python": r"def|class|return|if|elif|else|for|while|break|continue|import|from|as|with|try|except|finally|raise|lambda|yield|async|await|pass|global|nonlocal|assert|del|in|is|not|and|or|match|case",
    "js": r"const|let|var|function|return|if|else|for|while|class|extends|import|export|from|async|await|try|catch|finally|throw|new|typeof|instanceof|switch|case|default|break|continue|delete|in|of|this|null|undefined",
    "go": r"func|package|import|return|if|else|for|range|var|const|type|struct|interface|map|chan|go|defer|select|switch|case|default|break|continue|nil|true|false",
    "rust": r"fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|break|continue|self|Self|where|move|ref|as|dyn|crate|super",
    "c": r"int|char|float|double|void|long|short|unsigned|struct|enum|typedef|static|const|return|if|else|for|while|do|switch|case|break|continue|goto|sizeof|union|volatile|extern|include|define|namespace|using|class|public|private|new|delete|template|typename|true|false|nullptr|bool|auto",
    "sql": r"SELECT|FROM|WHERE|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|AS|AND|OR|NOT|IN|EXISTS|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|VIEW|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|DEFAULT|WITH|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|COUNT|SUM|AVG|MIN|MAX|COALESCE|BETWEEN|LIKE|IS|NULL",
    "bash": r"if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source|echo|cd|ls|grep|awk|sed|cat|curl|docker|systemctl|apt|git|sudo|mkdir|rm|cp|mv|chmod|chown",
    "yaml": r"true|false|null|yes|no|on|off",
}

_LINE_COMMENT = {
    "python": "#", "bash": "#", "yaml": "#", "ruby": "#", "perl": "#",
    "c": "//", "js": "//", "go": "//", "rust": "//", "java": "//",
    "sql": "--", "ini": ";", "dockerfile": "#", "prometheus": "#", "grafana": "#",
}

_BLOCK_COMMENT = {"c", "js", "go", "rust", "java", "sql", "css"}


def _highlight(line, lang):
    """Подсвечивает одну строку кода. Возвращает HTML."""
    if not line:
        return ""
    lang = (lang or "").lower()
    if lang in ("text", "txt", "output", "log", ""):
        return _esc(line)

    kw = _KEYWORDS.get(lang)
    lcom = _LINE_COMMENT.get(lang)
    bcom = _LINE_COMMENT.get("c") if lang in _BLOCK_COMMENT else None
    dcom = _LINE_COMMENT.get("dockerfile")

    dq = r'"(?:\\.|[^"\\])*"'
    sq = r"'(?:\\.|[^'\\])*'"
    parts = []

    # собираем один alternation, порядок = приоритет
    alts = []
    if bcom:
        alts.append(f"(?P<cmt_blk>{bcom}.*?{bcom})")
    if lcom:
        alts.append(f"(?P<cmt_ln>{re.escape(lcom)}[^\\n]*)")
    if dcom and dcom != lcom:
        alts.append(f"(?P<cmt_docker>{re.escape(dcom)}[^\\n]*)")
    if lang == "python":
        alts.append(r'(?P<str_tpl>"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\')')
    alts.append(f"(?P<str_dq>{dq})")
    alts.append(f"(?P<str_sq>{sq})")
    if kw:
        alts.append(f"(?P<kw>\\b(?:{kw})\\b)")
    alts.append(r"(?P<num>\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)")
    alts.append(r"(?P<fn>\b[A-Za-z_]\w*(?=\s*\())")
    if lang in ("js", "go", "rust", "c", "java", "sql", "yaml"):
        alts.append(r"(?P<var>\$\{?\w+\}?)")

    rx = re.compile("|".join(alts))
    pos = 0
    for m in rx.finditer(line):
        if m.start() > pos:
            parts.append(_esc(line[pos:m.start()]))
        kind = m.lastgroup
        txt = _esc(m.group(0))
        cls = {"cmt_blk": "tok-cmt", "cmt_ln": "tok-cmt", "cmt_docker": "tok-cmt",
               "str_tpl": "tok-str", "str_dq": "tok-str", "str_sq": "tok-str",
               "kw": "tok-k", "num": "tok-n", "fn": "tok-fn", "var": "tok-var"}[kind]
        parts.append(f'<span class="{cls}">{txt}</span>')
        pos = m.end()
    parts.append(_esc(line[pos:]))
    return "".join(parts)


def _render_code(lang, code):
    lines = code.split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return ""
    lname = (lang or "text").lower()
    numbered = "".join(
        f'<span class="ln"><span class="ln-i">{i + 1}</span>'
        f"{_highlight(ln, lname)}</span>\n"
        for i, ln in enumerate(lines)
    )
    return (
        f'<div class="codeblock" data-lang="{_esc(lname)}">'
        f'<div class="codehead"><span class="code-lang">{_esc(lname)}</span>'
        f'<button class="copy-btn" type="button" data-copy>Копировать</button></div>'
        f'<pre class="code"><code>{numbered}</code></pre>'
        f"</div>"
    )


def _render_table(lines, i):
    header = _split_row(lines[i])
    align = []
    for c in _split_row(lines[i + 1]):
        c = c.strip()
        if c.startswith(":") and c.endswith(":"):
            align.append("center")
        elif c.endswith(":"):
            align.append("right")
        else:
            align.append("left")
    out = ['<div class="table-wrap"><table><thead><tr>']
    for j, cell in enumerate(header):
        a = align[j] if j < len(align) else "left"
        out.append(f'<th style="text-align:{a}">{render_inline(cell)}</th>')
    out.append("</tr></thead><tbody>")
    j = i + 2
    while j < len(lines) and lines[j].strip() and "|" in lines[j]:
        cells = _split_row(lines[j])
        out.append("<tr>")
        for k, cell in enumerate(cells):
            a = align[k] if k < len(align) else "left"
            out.append(f'<td style="text-align:{a}">{render_inline(cell)}</td>')
        out.append("</tr>")
        j += 1
    out.append("</tbody></table></div>")
    return "\n".join(out), j


def _render_quote(block):
    """block — список строк цитаты (без '>')."""
    m = CALLOUT_RE.match(block[0].strip()) if block else None
    if m:
        kind = m.group(1).lower()
        if kind in CALLOUTS:
            label, icon = CALLOUTS[kind]
            inner = "\n".join(block[1:])
            body = render_blocks(inner)
            return (
                f'<div class="callout callout-{kind}">'
                f'<div class="callout-title"><span class="callout-icon">{icon}</span>{label}</div>'
                f'<div class="callout-body">{body}</div></div>'
            )
    body = render_blocks("\n".join(block))
    return f"<blockquote>{body}</blockquote>"


def _render_list_item_content(item_lines):
    """Содержимое одного пункта: ведущие абзацы + вложенные списки."""
    parts, idx = [], 0
    # режем до первой вложенной строки списка
    nested_at = None
    for k, ln in enumerate(item_lines):
        if LIST_RE.match(ln) and ln.strip():
            nested_at = k
            break
    head = item_lines if nested_at is None else item_lines[:nested_at]
    head_txt = "\n".join(head).strip()
    if head_txt:
        # задача - [ ] / - [x]
        tm = re.match(r"^\[([ xX])\]\s+(.*)$", head_txt, flags=re.S)
        if tm:
            done = tm.group(1).lower() == "x"
            inner = render_inline(tm.group(2))
            parts.append(
                f'<label class="task"><input type="checkbox" disabled '
                f'{"checked" if done else ""}><span>{inner}</span></label>'
            )
        else:
            parts.append(render_inline(head_txt))
    if nested_at is not None:
        sub = "\n".join(item_lines[nested_at:])
        parts.append(_render_list(sub.split("\n")))
    return "".join(parts)


def _render_list(lines):
    m0 = LIST_RE.match(lines[0])
    ordered = not re.match(r"^[-*+]$", m0.group(2))
    base = len(m0.group(1))
    items, cur = [], None
    for ln in lines:
        m = LIST_RE.match(ln)
        if m and len(m.group(1)) == base:
            if cur is not None:
                items.append(cur)
            cur = [m.group(3)]
        elif m and len(m.group(1)) > base and cur is not None:
            cur.append(ln[base:])
        elif cur is not None:
            if not ln.strip():
                if any(LIST_RE.match(x) for x in cur):
                    cur.append("")
            else:
                cur.append(ln.strip())
    if cur is not None:
        items.append(cur)

    tag = "ol" if ordered else "ul"
    start = ""
    om = re.match(r"^(\d+)", m0.group(2))
    if ordered and om and om.group(1) != "1":
        start = f' start="{om.group(1)}"'
    body = "".join(
        f"<li>{_render_list_item_content(it)}</li>" for it in items
    )
    cls = ' class="tasklist"' if ordered is False and any(
        re.match(r"^\[[ xX]\]", (it[0] or "").strip()) for it in items) else ""
    return f"<{tag}{start}{cls}>{body}</{tag}>"


def render_blocks(text, base=""):
    lines = text.replace("\r\n", "\n").split("\n")
    out = []
    i, n = 0, len(lines)

    while i < n:
        raw = lines[i]
        s = raw.strip()

        if not s:
            i += 1
            continue

        # --- блок кода ---
        m = FENCE_RE.match(s)
        if m:
            fence, lang = m.group(1), m.group(2)
            i += 1
            buf = []
            while i < n:
                cm = FENCE_RE.match(lines[i].strip())
                if cm and cm.group(1)[0] == fence[0] and len(cm.group(1)) >= len(fence):
                    i += 1
                    break
                buf.append(lines[i])
                i += 1
            out.append(_render_code(lang, "\n".join(buf)))
            continue

        # --- заголовок ---
        m = HEADING_RE.match(s)
        if m:
            level = len(m.group(1))
            title = m.group(2)
            anchor = slugify(re.sub(r"[`*]", "", title))
            out.append(f'<h{level} id="{anchor}">{render_inline(title, base)}</h{level}>')
            i += 1
            continue

        # --- горизонтальная линия ---
        if HR_RE.match(s):
            out.append("<hr>")
            i += 1
            continue

        # --- цитата / алерт ---
        if s.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append(_render_quote(buf))
            continue

        # --- таблица ---
        if "|" in s and i + 1 < n and TABLE_SEP_RE.match(lines[i + 1]) and "|" in lines[i + 1]:
            t, i = _render_table(lines, i)
            out.append(t)
            continue

        # --- список ---
        if LIST_RE.match(raw) and re.match(r"^\s*([-*+]|\d+[.)])\s+", raw):
            buf = []
            while i < n:
                ln = lines[i]
                if not ln.strip():
                    # список заканчивается, если дальше не продолжение
                    nxt = lines[i + 1] if i + 1 < n else ""
                    if not (nxt.strip() and (LIST_RE.match(nxt) or len(nxt) - len(nxt.lstrip()) >= 2)):
                        break
                    buf.append("")
                elif LIST_RE.match(ln) or len(ln) - len(ln.lstrip()) >= 2:
                    buf.append(ln)
                else:
                    break
                i += 1
            out.append(_render_list(buf))
            continue

        # --- абзац ---
        buf = []
        while i < n and lines[i].strip():
            s2 = lines[i].strip()
            if FENCE_RE.match(s2) or HEADING_RE.match(s2) or HR_RE.match(s2):
                break
            if s2.startswith(">"):
                break
            if LIST_RE.match(lines[i]) and re.match(r"^\s*([-*+]|\d+[.)])\s+", lines[i]):
                break
            if i + 1 < n and TABLE_SEP_RE.match(lines[i + 1]) and "|" in s2:
                break
            buf.append(s2)
            i += 1
        if buf:
            para = "\n".join(buf)
            para = re.sub(r"  \n", "<br>", para)
            out.append(f"<p>{render_inline(para, base)}</p>")

    return "\n".join(out)


def to_html(md, base=""):
    return render_blocks(md, base)