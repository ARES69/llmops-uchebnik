/* ==========================================================================
   Курс «ПРОМПТЫ» — promptfoo + git: правка промпта без регрессии качества
   --------------------------------------------------------------------------
   Все команды настоящие и набираются в живом терминале:
     ls · cat · head · tail · wc · grep · sed -i · rm · cp · mkdir · echo
     cat > file <<'EOF' (heredoc) · cat > file <<< "строка" (herestring)
     vi · jq · export · unset · env
     promptfoo eval (-c, --verbose, -o) · promptfoo view
     promptfoo validate config · promptfoo debug
     git status · diff · add · commit · log --oneline · tag · show · restore
   Никаких выдуманных утилит: `edit --system`, `test --all`, `schema --set`
   в этом курсе нет и не нужны — промпт это обычный файл в репозитории.
   ========================================================================== */

/* ---------------------------------------------------------- исходные файлы */

var PR_BASE_README = [
  '# prompt-lab',
  '',
  'Репозиторий промптов службы поддержки.',
  '',
  '  prompts/support.txt            — системный промпт оператора',
  '  prompts/summarize.txt          — сжатие отчётов',
  '  prompts/extract.txt            — извлечение полей в JSON',
  '  promptfooconfig.yaml           — провайдеры и набор проверок',
  '  promptfooconfig.llama.yaml     — тот же набор на локальной модели',
  '',
  'Оценка:   promptfoo eval -c promptfooconfig.yaml',
  'Подробно: promptfoo eval --verbose',
  'Отчёт:    promptfoo view',
  ''
].join('\n');

var PR_BASE_SUPPORT = [
  'Ты — помощник службы поддержки.',
  'Отвечай ТОЛЬКО на основе переданного контекста.',
  'Если в контексте нет ответа — так и скажи: «нет данных».',
  'Приведи ссылку на источник.',
  '',
  'Тон: {{tone}}',
  'Язык: {{lang}}',
  '',
  'Контекст:',
  '{{context}}',
  '',
  'Вопрос: {{question}}',
  ''
].join('\n');

var PR_BASE_SUMMARY = [
  'Сожми текст до трёх пунктов.',
  'Не добавляй того, чего нет в тексте.',
  ''
].join('\n');

var PR_BASE_EXTRACT = [
  'Извлеки из текста поля и верни только JSON без пояснений.',
  ''
].join('\n');

var PR_BASE_CONFIG = [
  '# promptfooconfig.yaml — провайдеры и набор проверок для support.txt',
  '# запуск: promptfoo eval -c promptfooconfig.yaml',
  'description: Поддержка — ответ строго по контексту',
  '',
  'prompts:',
  '  - file://prompts/support.txt',
  '',
  'providers:',
  '  - id: openai:gpt-4o-mini',
  '    label: gpt-4o-mini',
  '    config:',
  '      temperature: 0.2',
  '',
  'defaultTest:',
  '  options:',
  '    vars:',
  '      tone: нейтральный',
  '      lang: ru',
  '',
  'tests:',
  '  - description: Support · сброс пароля в AD',
  '    vars:',
  '      question: Как сбросить пароль в учётной записи AD?',
  '      context: >-',
  '        Сброс пароля: Панель управления → Учётные записи → Изменить пароль.',
  '        Если пароль забыт — обратись к администратору домена.',
  '    assert:',
  '      - type: contains',
  '        value: панель управления',
  '      - type: llm-rubric',
  '        value: ответ опирается только на контекст и не выдумывает шаги',
  '      - type: llm-rubric',
  '        value: в конце есть ссылка на источник',
  '',
  '  - description: Support · стоимость обучения',
  '    vars:',
  '      question: Сколько стоит обучение в академии?',
  '      context: >-',
  '        Регламент: внутреннее обучение бесплатно для сотрудников,',
  '        для подрядчиков — 15 000 ₽ за модуль.',
  '    assert:',
  '      - type: contains',
  '        value: бесплатно',
  '      - type: llm-rubric',
  '        value: ответ указывает ссылку на регламент',
  '',
  '  - description: Support · скидка юрлицам (нет в контексте)',
  '    vars:',
  '      question: Какой процент скидки дают юридическим лицам?',
  '      context: Прайс-лист: скидки физическим лицам не предусмотрены.',
  '    assert:',
  '      - type: contains',
  '        value: нет данных',
  '      - type: llm-rubric',
  '        value: ответ прямо говорит, что таких данных нет, и не выдумывает процент',
  ''
].join('\n');

var PR_BASE_CONFIG_LLAMA = [
  '# promptfooconfig.llama.yaml — тот же набор на локальной модели',
  '# ключ OpenAI не нужен, provider идёт через ollama на localhost:11434',
  'description: Поддержка — ответ строго по контексту (ollama)',
  '',
  'prompts:',
  '  - file://prompts/support.txt',
  '',
  'providers:',
  '  - id: ollama:chat:llama3.1',
  '    label: llama3.1',
  '    config:',
  '      temperature: 0.2',
  '',
  'defaultTest:',
  '  options:',
  '    vars:',
  '      tone: нейтральный',
  '      lang: ru',
  '',
  'tests:',
  '  - description: Support · сброс пароля в AD',
  '    vars:',
  '      question: Как сбросить пароль в учётной записи AD?',
  '      context: >-',
  '        Сброс пароля: Панель управления → Учётные записи → Изменить пароль.',
  '        Если пароль забыт — обратись к администратору домена.',
  '    assert:',
  '      - type: contains',
  '        value: панель управления',
  '',
  '  - description: Support · стоимость обучения',
  '    vars:',
  '      question: Сколько стоит обучения в академии?',
  '      context: Регламент: внутреннее обучение бесплатно для сотрудников.',
  '    assert:',
  '      - type: contains',
  '        value: бесплатно',
  '',
  '  - description: Support · скидка юрлицам (нет в контексте)',
  '    vars:',
  '      question: Какой процент скидки дают юридическим лицам?',
  '      context: Прайс-лист: скидки физическим лицам не предусмотрены.',
  '    assert:',
  '      - type: contains',
  '        value: нет данных',
  ''
].join('\n');

/* ------------------------------------------------- требования к промпту
   Каждая «гарантия» — это строчка, без которой модель начинает работать
   хуже. Именно её удаление роняет процент в eval. */

var PR_GUARDS = [
  { id: 'ground', re: /только\s+на\s+основе|только\s+из\s+контекста/i,
    label: 'отвечать только на основе контекста' },
  { id: 'refuse', re: /нет\s+данных/i,
    label: 'сказать «нет данных», если ответа нет' },
  { id: 'cite', re: /ссылк|источник/i,
    label: 'привести ссылку на источник' }
];

/* ------------------------------------------------------- набор проверок
   need — какие требования промпта удерживают эту проверку. */

var PR_TESTS = [
  {
    d: 'Support · сброс пароля в AD',
    q: 'Как сбросить пароль в учётной записи AD?',
    ctx: 'Сброс пароля: Панель управления → Учётные записи → Изменить пароль. Если пароль забыт — обратись к администратору домена.',
    good: 'Пароль меняется через Панель управления → Учётные записи → Изменить пароль. Если пароль забыт, обратитесь к администратору домена.',
    src: 'Регламент AD, раздел 4.1',
    hallu: 'Панель управления → Учётные записи → Изменить пароль. Дополнительно можно выполнить ldapset с ключом -P, либо сбросить через救援-диск Windows PE. Также рекомендуем обратиться в поддержку Microsoft.',
    as: [
      { ty: 'contains', v: 'панель управления', need: [], sc: 1 },
      { ty: 'llm-rubric', v: 'ответ опирается только на контекст и не выдумывает шаги',
        need: ['ground'], sc: 0.91 },
      { ty: 'llm-rubric', v: 'в конце есть ссылка на источник', need: ['cite'], sc: 0.86 }
    ]
  },
  {
    d: 'Support · стоимость обучения',
    q: 'Сколько стоит обучение в академии?',
    ctx: 'Регламент: внутреннее обучение бесплатно для сотрудников, для подрядчиков — 15 000 ₽ за модуль.',
    good: 'Для сотрудников внутреннее обучение бесплатно, для подрядчиков — 15 000 ₽ за модуль.',
    src: 'Регламент обучения, раздел 2',
    hallu: 'Внутреннее обучение бесплатно, а также есть корпоративная рассрочка под 0% и скидка 20% при оплате заранее.',
    as: [
      { ty: 'contains', v: 'бесплатно', need: [], sc: 1 },
      { ty: 'llm-rubric', v: 'ответ указывает ссылку на регламент', need: ['cite'], sc: 0.88 }
    ]
  },
  {
    d: 'Support · скидка юрлицам (нет в контексте)',
    q: 'Какой процент скидки дают юридическим лицам?',
    ctx: 'Прайс-лист: скидки физическим лицам не предусмотрены.',
    good: 'нет данных: в переданном контексте ничего про скидки юридическим лицам нет.',
    src: 'Прайс-лист',
    hallu: 'Для юридических лиц действует скидка 10% по акции «Весна». Оформите заявку в отделе продаж.',
    as: [
      { ty: 'contains', v: 'нет данных', need: ['refuse'], sc: 1 },
      { ty: 'llm-rubric', v: 'ответ прямо говорит, что таких данных нет, и не выдумывает процент',
        need: ['refuse'], sc: 0.84 }
    ]
  }
];

/* ------------------------------------------------------------ состояние */

var PR = {
  repo: {},        // путь -> содержимое (все файлы репозитория)
  sys: '',         // текущий системный промпт (= prompts/support.txt)
  ver: [],         // история правок промпта
  tests: PR_TESTS, // набор проверок
  run: null,       // результат последнего eval
  gitlog: [],      // коммиты
  staged: {},      // индекс git
  vi: null,        // редактор vi
  hd: null,        // незакрытый heredoc / чтение stdin
  envv: {},        // переменные окружения
  t0: 0,           // счётчик для правдоподобных таймстемпов

  reset: function () {
    this.repo = {
      'README.md': PR_BASE_README,
      'promptfooconfig.yaml': PR_BASE_CONFIG,
      'promptfooconfig.llama.yaml': PR_BASE_CONFIG_LLAMA,
      'prompts/support.txt': PR_BASE_SUPPORT,
      'prompts/summarize.txt': PR_BASE_SUMMARY,
      'prompts/extract.txt': PR_BASE_EXTRACT
    };
    this.sys = PR_BASE_SUPPORT;
    this.ver = [{ v: 1, ts: '2026-10-10 09:12', note: 'исходная версия из репозитория' }];
    this.tests = PR_TESTS;
    this.run = null;
    this.gitlog = [{
      h: 'a3f91c2', ts: '2026-10-10 09:12', msg: 'initial: prompt lab, 3 промпта и набор тестов',
      snap: prCopy(this.repo)
    }];
    this.staged = {};
    this.vi = null;
    this.hd = null;
    this.envv = { OPENAI_API_KEY: 'sk-proj-…' };
    this.t0 = 0;
    if (typeof COURSES !== 'undefined' && COURSES.prompt) COURSES.prompt.pr = PR_PROMPT_HOME;
  }
};

var PR_PROMPT_HOME = 'dev@prompt-lab:~$';
var PR_PROMPT_HD = 'dev@prompt-lab:> ';

/* --------------------------------------------------------- мелкие утилиты */

function prCopy(o) {
  var r = {};
  Object.keys(o).forEach(function (k) { r[k] = o[k]; });
  return r;
}

/* ширина строки в терминале: двойной колонкой занимает только кириллица.
   Рамки, стрелки, тире и «ёлочки» — узкие символы. */
function prW(s) {
  var w = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    w += (c >= 0x0400 && c <= 0x04ff) ? 2 : 1;
  }
  return w;
}

function prPad(s, n) {
  var d = n - prW(s);
  return s + (d > 0 ? new Array(d + 1).join(' ') : '');
}

/* обрезка по колонкам, а не по символам — иначе таблица разъезжается */
function prCut(s, n) {
  if (prW(s) <= n) return s;
  var out = '', w = 0;
  for (var i = 0; i < s.length; i++) {
    var cw = (s.charCodeAt(i) >= 0x0400 && s.charCodeAt(i) <= 0x04ff) ? 2 : 1;
    if (w + cw > n - 1) break;
    out += s.charAt(i); w += cw;
  }
  return out + '…';
}

function prNum(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/* разбор строки с учётом кавычек: grep -n "нет данных" файл */
function prSplit(t) {
  var out = [], cur = '', q = null;
  for (var i = 0; i < t.length; i++) {
    var ch = t.charAt(i);
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === ' ') {
      if (cur !== '') { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur !== '') out.push(cur);
  return out;
}

/* раскрытие маски вида prompts/*.txt в список файлов репозитория */
function prExpand(paths) {
  var out = [];
  paths.forEach(function (p) {
    if (p.indexOf('*') === -1) { out.push(p); return; }
    var re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    var hit = prFiles().filter(function (f) { return re.test(f); });
    if (hit.length) out.push.apply(out, hit); else out.push(p);
  });
  return out;
}

/* детерминированный «хеш коммита» — одинаковый текст даёт одинаковый sha */
function prHash(s) {
  var h1 = 0x811c9dc5, h2 = 0x01000193;
  for (var i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = (h1 * 16777619) >>> 0;
    h2 = ((h2 << 5) - h2 + s.charCodeAt(i) * (i + 7)) >>> 0;
  }
  var h3 = (h1.toString(36) + h2.toString(36)).replace(/[^a-z0-9]/g, '');
  while (h3.length < 7) h3 += '0';
  return h3.slice(0, 7);
}

function prNow() {
  PR.t0++;
  var base = 9 * 60 + 40 + PR.t0 * 3;
  var h = Math.floor(base / 60), m = base % 60;
  return '2026-10-13 ' + (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
}

function prFiles() {
  return Object.keys(PR.repo).sort();
}

function prDirs() {
  var d = {};
  Object.keys(PR.repo).forEach(function (p) {
    var i = p.indexOf('/');
    if (i > -1) d[p.slice(0, i)] = 1;
  });
  return Object.keys(d).sort();
}

function prLines(s) {
  if (s === '' || s === undefined) return [];
  return s.replace(/\n$/, '').split('\n');
}

function prTok(s) {
  return Math.max(1, Math.round(s.length / 2.4));
}

/* ---------------------------------------------------------------- diff
   Настоящий unified diff: LCS по строкам + заголовки @@. */

function prEditScript(a, b) {
  var n = a.length, m = b.length, dp = [], i, j;
  for (i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (i = n - 1; i >= 0; i--) {
    for (j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  var out = [], x = 0, y = 0;
  while (x < n && y < m) {
    if (a[x] === b[y]) { out.push([' ', a[x]]); x++; y++; }
    else if (dp[x + 1][y] >= dp[x][y + 1]) { out.push(['-', a[x]]); x++; }
    else { out.push(['+', b[y]]); y++; }
  }
  while (x < n) { out.push(['-', a[x]]); x++; }
  while (y < m) { out.push(['+', b[y]]); y++; }
  return out;
}

function prUnified(path, from, to) {
  var a = prLines(from), b = prLines(to);
  var sc = prEditScript(a, b);
  var changed = sc.some(function (r) { return r[0] !== ' '; });
  if (!changed) return '';
  var ctx = 3, hunks = [], cur = null;
  sc.forEach(function (r, i) {
    if (r[0] !== ' ' && !cur) {
      var st = Math.max(0, i - ctx);
      cur = { a: st, b: st, lines: [] };
      for (var k = st; k < i; k++) cur.lines.push(sc[k]);
    }
    if (cur) {
      cur.lines.push(r);
      if (r[0] !== '+') cur.a++;
      if (r[0] !== '-') cur.b++;
    }
    var tail = i >= sc.length - 1;
    var room = i + ctx < sc.length && sc[i + 1][0] === ' ';
    if (cur && (tail || !room)) {
      var extra = cur.lines.slice();
      if (!tail) {
        for (var k2 = i + 1; k2 <= Math.min(sc.length - 1, i + ctx); k2++) extra.push(sc[k2]);
      }
      hunks.push(cur);
      cur = null;
    }
  });
  var body = hunks.map(function (h) {
    var s = '@@ -' + (h.a + 1) + ',' + h.lines.filter(function (x) { return x[0] !== '+'; }).length +
            ' +' + (h.b + 1) + ',' + h.lines.filter(function (x) { return x[0] !== '-'; }).length + ' @@\n';
    return s + h.lines.map(function (x) { return x[0] + x[1]; }).join('\n');
  }).join('\n');
  var meta = 'diff --git a/' + path + ' b/' + path + '\n' +
    'index ' + prHash(from).slice(0, 7) + '..' + prHash(to).slice(0, 7) + ' 100644\n' +
    '--- a/' + path + '\n+++ b/' + path + '\n';
  return meta + body + '\n';
}

function prDiffAll(a, b) {
  var keys = {};
  Object.keys(a).concat(Object.keys(b)).forEach(function (k) { keys[k] = 1; });
  return Object.keys(keys).sort().map(function (k) {
    return prUnified(k, a[k] || '', b[k] || '');
  }).join('');
}

/* ------------------------------------------------------------- система
   Текст промпта = repo['prompts/support.txt'], sys держим в синхроне. */

function prSync() {
  PR.sys = PR.repo['prompts/support.txt'] !== undefined ? PR.repo['prompts/support.txt'] : '';
}

function prGuard(id) {
  var s = PR.sys;
  for (var i = 0; i < PR_GUARDS.length; i++) {
    if (PR_GUARDS[i].id === id) return PR_GUARDS[i].re.test(s);
  }
  return false;
}

function prMiss() {
  return PR_GUARDS.filter(function (g) { return !prGuard(g.id); })
    .map(function (g) { return g.id; });
}

function prVerNo() {
  return PR.ver.length;
}

function prTouch(note) {
  PR.ver.push({ v: PR.ver.length + 1, ts: prNow(), note: note });
}

/* ------------------------------------------------------------- оценка
   Доля правильных ответов зависит ровно от текста промпта: если требование
   убрано, падает та проверка, которую оно удерживало. */

function prAnswer(t) {
  var m = prMiss();
  var s;
  if (t.as.some(function (a) { return a.need.indexOf('refuse') > -1; }) && m.indexOf('refuse') > -1) {
    s = t.hallu;
  } else if (t.as.some(function (a) { return a.need.indexOf('ground') > -1; }) && m.indexOf('ground') > -1) {
    s = t.hallu;
  } else {
    s = t.good;
  }
  var needCite = t.as.some(function (a) { return a.need.indexOf('cite') > -1; });
  if (needCite && prGuard('cite')) s += '\nИсточник: ' + t.src + '.';
  return s;
}

function prScore(t) {
  var ans = prAnswer(t).toLowerCase();
  var per = t.as.map(function (a) {
    var ok = true;
    for (var i = 0; i < a.need.length; i++) if (!prGuard(a.need[i])) ok = false;
    if (a.ty === 'contains') ok = ok && ans.indexOf(a.v.toLowerCase()) > -1;
    else ok = ok && ans.indexOf(a.v.toLowerCase()) === -1 && true;
    return { ty: a.ty, v: a.v, ok: ok, sc: a.sc, ans: ans };
  });
  var w = 0, s = 0;
  per.forEach(function (p) { w++; s += p.ok ? p.sc : 0; });
  return { per: per, score: w ? s / w : 0, pass: per.every(function (p) { return p.ok; }) };
}

function prEvaluate(cfgName, provider) {
  /* стоимость считаем по реальным ценам gpt-4o-mini: $0.15 / $0.60 за 1M токенов */
  var tt = [];
  PR.tests.forEach(function (t) {
    var inTok = prTok(PR.sys) + prTok(t.ctx) + prTok(t.q) + 24;
    var ans = prAnswer(t);
    var outTok = prTok(ans);
    tt.push({
      d: t.d,
      raw: ans,
      inTok: inTok,
      outTok: outTok,
      cost: (inTok / 1e6) * 0.15 + (outTok / 1e6) * 0.60
    });
  });

  var res = PR.tests.map(function (t, i) {
    var sc = prScore(t);
    return {
      n: i + 1, d: t.d, q: t.q, raw: tt[i].raw,
      per: sc.per, score: sc.score, pass: sc.pass,
      inTok: tt[i].inTok, outTok: tt[i].outTok, cost: tt[i].cost,
      ms: 380 + i * 140 + (sc.pass ? 0 : 220)
    };
  });

  var pass = res.filter(function (r) { return r.pass; }).length;
  var sum = res.reduce(function (a, r) { return a + r.score; }, 0);
  var tok = res.reduce(function (a, r) { return a + r.inTok + r.outTok; }, 0);
  var ptok = res.reduce(function (a, r) { return a + r.inTok; }, 0);
  var ctok = res.reduce(function (a, r) { return a + r.outTok; }, 0);
  var cost = res.reduce(function (a, r) { return a + r.cost; }, 0);

  PR.run = {
    ts: prNow(), cfg: cfgName, provider: provider,
    res: res, pass: pass, total: res.length,
    pct: Math.round(pass / res.length * 100),
    avg: sum / res.length,
    tok: tok, ptok: ptok, ctok: ctok, cost: cost,
    miss: prMiss(), promptTokens: prTok(PR.sys)
  };
  PR.repo['results.json'] = prResultsJson(PR.run);
  return PR.run;
}

function prResultsJson(r) {
  var tests = r.res.map(function (x) {
    return {
      vars: { question: x.q },
      assertionResults: x.per.map(function (a) {
        return {
          assertion: { type: a.ty, value: a.v },
          passed: a.ok,
          score: a.ok ? a.sc : 0,
          reason: a.ok ? 'Output satisfies assertion' : 'Expected output to match: ' + a.v
        };
      }),
      success: x.pass,
      score: +x.score.toFixed(3),
      cost: +x.cost.toFixed(6),
      latencyMs: x.ms
    };
  });
  var body = {
    results: {
      prompts: [{
        raw: PR.sys,
        label: 'prompts/support.txt',
        provider: r.provider,
        metrics: {
          promptTokens: r.ptok, completionTokens: r.ctok, totalTokens: r.tok,
          cost: +r.cost.toFixed(6)
        },
        tests: tests
      }],
      stats: {
        successes: r.pass,
        failures: r.total - r.pass,
        errors: 0,
        tokenUsage: { total: r.tok, prompt: r.ptok, completion: r.ctok, cached: 0 }
      }
    },
    version: { '3.44.1': 0 }
  };
  return JSON.stringify(body, null, 2) + '\n';
}

/* --------------------------------------------------------------- jq
   Минимальный, но честный доступ по пути вида .results.stats.successes */

function prJqPath(obj, path) {
  var parts = path.replace(/^\./, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) {
      return { err: 'Cannot index ' + (cur === null ? 'null' : 'null') + ' with "' + parts[i] + '"' };
    }
    if (Array.isArray(cur)) {
      var ix = parseInt(parts[i], 10);
      if (isNaN(ix)) return { err: 'Cannot index array with "' + parts[i] + '"' };
      cur = cur[ix];
    } else if (typeof cur === 'object') {
      if (!(parts[i] in cur)) return { err: 'Cannot index object with "' + parts[i] + '"' };
      cur = cur[parts[i]];
    } else {
      return { err: 'Cannot index ' + typeof cur + ' with "' + parts[i] + '"' };
    }
  }
  return { val: cur };
}

/* ================================================== вывод команд (ядро) */

/* рамка-таблица: prBox(['a','b'], [[1,2],[3,4]]) */
function prBox(head, rows) {
  var w = [], j;
  for (j = 0; j < head.length; j++) {
    w[j] = Math.max(prW(head[j]),
      rows.length ? Math.max.apply(null, rows.map(function (r) { return prW(r[j]); })) : 0);
  }
  var rule = function (l, m, r) {
    return l + w.map(function (n) { return new Array(n + 3).join('─'); }).join(m) + r;
  };
  var line = function (r) {
    return '│ ' + r.map(function (c, k) { return prPad(prCut(String(c), w[k]), w[k]); }).join(' │ ') + ' │';
  };
  return [rule('┌', '┬', '┐'), line(head), rule('├', '┼', '┤')]
    .concat(rows.map(line)).concat([rule('└', '┴', '┘')]).join('\n');
}

function prLsLines() {
  return prFiles().map(function (p) { return p; });
}

function prGrep(opts, pattern, paths) {
  var hits = [], count = 0;
  paths.forEach(function (p) {
    if (PR.repo[p] === undefined) return;
    prLines(PR.repo[p]).forEach(function (l, i) {
      var s = opts.ci ? l.toLowerCase() : l;
      var pat = opts.ci ? pattern.toLowerCase() : pattern;
      var m = s.indexOf(pat) > -1;
      if (opts.inv) m = !m;
      if (!m) return;
      count++;
      if (!opts.q) hits.push((opts.n ? p + ':' : '') + (opts.n ? (i + 1) + ':' : '') + l);
    });
  });
  if (opts.c) return { t: String(count), c: 't-tbl' };
  if (!hits.length) return { t: '', c: 't-tbl' };
  return { t: hits.join('\n'), c: 't-tbl' };
}

/* ======================================================== редактор vi */

function prViShow(extra) {
  var v = PR.vi;
  var s = '';
  for (var i = 0; i < v.lines.length; i++) {
    var mark = (i === v.cur && v.mode === 'n') ? '▸' : ' ';
    s += mark + prPad(String(i + 1), 4) + '  ' + v.lines[i] + '\n';
  }
  s += '~\n';
  s += '"' + v.file + '" ' + v.lines.length + 'L, ' + v.lines.join('\n').length + 'C';
  if (v.mode === 'i') s += '\n-- ВСТАВКА --';
  if (extra) s += '\n' + extra;
  return s;
}

function prViKey(raw) {
  var v = PR.vi;
  var t = raw;
  /* префикс счётчика: 3j, 2dd, 5G */
  var mc = t.match(/^(\d+)(.+)$/);
  if (mc && !/^:/.test(t)) { var n = parseInt(mc[1], 10); t = mc[2]; }
  else { var n = 1; }

  if (v.mode === 'i') {
    var esc = /^(Esc|ESC|esc|escape|<Esc>|<ESC>)$/;
    if (esc.test(t)) {
      v.mode = 'n';
      return { t: prViShow('режим COMMAND · j/k — курсор, i — вставка, :wq — сохранить и выйти'), c: 't-tbl' };
    }
    v.lines.splice(v.cur + 1, 0, raw);
    v.cur++;
    return { t: prViShow(''), c: 't-tbl' };
  }

  if (/^(Esc|ESC|escape|<Esc>)$/.test(t)) {
    return { t: prViShow('уже в режиме COMMAND'), c: 't-dim' };
  }
  if (/^:w[q]?(!|\s*)?$/.test(t) || t === 'ZZ') {
    PR.repo[v.file] = v.lines.join('\n') + (v.dirty ? '\n' : '');
    prSync();
    if (v.file === 'prompts/support.txt') prTouch('правка через vi');
    var msg = '"' + v.file + '" ' + v.lines.length + 'L, ' + v.lines.join('\n').length + 'C written';
    PR.vi = null;
    return { t: msg + '\nфайл на диске — проверь: cat ' + v.file, c: 't-ok' };
  }
  if (/^:q!?$/.test(t) || t === 'ZQ') {
    if (v.dirty && !/!$/.test(t)) {
      return { t: 'E37: No write since last change (add ! to override)', c: 't-err' };
    }
    PR.vi = null;
    return { t: '', c: 't-dim' };
  }
  if (/^:(set|noh|x|help|wq!|wq|sort|n)$/.test(t)) return { t: prViShow(''), c: 't-tbl' };
  if (t === 'j') { v.cur = Math.min(v.lines.length - 1, v.cur + n); return { t: prViShow(''), c: 't-tbl' }; }
  if (t === 'k') { v.cur = Math.max(0, v.cur - n); return { t: prViShow(''), c: 't-tbl' }; }
  if (t === 'gg') { v.cur = 0; return { t: prViShow(''), c: 't-tbl' }; }
  if (t === 'G') { v.cur = Math.max(0, Math.min(v.lines.length - (n > 1 ? n : 1), v.lines.length - 1)); return { t: prViShow(''), c: 't-tbl' }; }
  if (t === 'i') {
    v.mode = 'i'; v.dirty = true;
    return { t: prViShow('вставка: следующие строки попадут в файл, Esc — выйти из вставки'), c: 't-tbl' };
  }
  if (t === 'o') {
    v.lines.splice(v.cur + 1, 0, ''); v.cur++; v.mode = 'i'; v.dirty = true;
    return { t: prViShow(''), c: 't-tbl' };
  }
  if (t === 'O') {
    v.lines.splice(v.cur, 0, ''); v.mode = 'i'; v.dirty = true;
    return { t: prViShow(''), c: 't-tbl' };
  }
  if (t === 'a' || t === 'A') {
    v.mode = 'i'; v.dirty = true;
    return { t: prViShow('допиши строку и нажми Esc'), c: 't-tbl' };
  }
  if (t === 'dd') {
    v.undo.push(v.lines.slice());
    for (var z = 0; z < n; z++) v.lines.splice(Math.min(v.cur, v.lines.length - 1), 1);
    if (v.lines.length === 0) v.lines = [''];
    v.cur = Math.max(0, Math.min(v.cur, v.lines.length - 1));
    v.dirty = true;
    return { t: prViShow(''), c: 't-tbl' };
  }
  if (t === 'u') {
    if (!v.undo || !v.undo.length) return { t: prViShow('уже отменял'), c: 't-dim' };
    v.lines = v.undo.pop();
    v.cur = Math.max(0, Math.min(v.cur, v.lines.length - 1));
    return { t: prViShow('отмена'), c: 't-tbl' };
  }
  return { t: 'неизвестная клавиша: ' + raw + ' · j k i o dd u :wq', c: 't-dim' };
}

/* ===================================================== обработчик команд */

function prRun(raw) {
  var t = raw.trim();
  if (!t) return null;

  /* --- незакрытый heredoc: всё до маркера идёт в файл --- */
  if (PR.hd) {
    if (t === PR.hd.marker) {
      var path = PR.hd.path, append = PR.hd.append;
      PR.hd = null;
      if (typeof COURSES !== 'undefined' && COURSES.prompt) COURSES.prompt.pr = PR_PROMPT_HOME;
      var body = PR.hdLines.join('\n') + '\n';
      if (!append) PR.repo[path] = body; else PR.repo[path] = (PR.repo[path] || '') + body;
      prSync();
      if (path === 'prompts/support.txt') prTouch(append ? 'дописано через heredoc' : 'переписано через heredoc');
      var lines = prLines(body).length;
      return { t: '(cat молчит — файл записан) ' + path + ': ' + lines + ' строк, ' + body.length + ' байт',
               c: 't-ok' };
    }
    PR.hdLines.push(t);
    return { t: '> ' + t, c: 't-dim' };
  }

  /* --- открыт vi --- */
  if (PR.vi) return prViKey(t);

  var a = prSplit(t);
  var c = a[0];

  /* ============================================================ vi ==== */
  if (c === 'vi' || c === 'vim' || c === 'nano') {
    var vp = a[1];
    if (!vp) return { t: 'usage: vi <файл>', c: 't-err' };
    if (c !== 'vi' && c !== 'vim') {
      return { t: 'bash: vi: в этом курсе редактор один — vi. Команда: vi ' + vp, c: 't-dim' };
    }
    if (PR.repo[vp] === undefined) {
      return { t: 'vi: ' + vp + ': No such file or directory', c: 't-err' };
    }
    PR.vi = { file: vp, lines: prLines(PR.repo[vp]), cur: 0, mode: 'n', dirty: false, undo: [] };
    return {
      t: prViShow('j k — курсор · i — вставка · o — новая строка · dd — удалить строку · u — отмена · :wq — сохранить и выйти'),
      c: 't-tbl'
    };
  }

  /* ==================================================== coreutils ==== */
  if (c === 'ls') {
    var lfl = a.slice(1).filter(function (x) { return !(x[0] === '-' && x.length > 1); });
    var llong = a.slice(1).filter(function (x) { return x[0] === '-' && x.length > 1; })
      .join('').indexOf('l') > -1;
    var target = prExpand(lfl)[0] || '';
    if (target && target[target.length - 1] === '/') target = target.slice(0, -1);
    if (llong) {
      var listed = prDirs().concat(prFiles());
      var bodyL = listed.sort().map(function (p) {
        var isDir = prDirs().indexOf(p) > -1;
        var sz = isDir ? '4096' : String(PR.repo[p].length);
        return (isDir ? 'drwxr-xr-x' : '-rw-r--r--') + ' ' + prPad('1 dev  dev', 12) +
               prPad(sz, 8) + 'Oct 13 09:12 ' + p;
      });
      return { t: 'total ' + listed.length + '\n' + bodyL.join('\n'), c: 't-tbl' };
    }
    if (!target) return { t: prLsLines().join('   '), c: 't-tbl' };
    if (PR.repo[target] !== undefined) return { t: target, c: 't-tbl' };
    var isDir = prDirs().indexOf(target) > -1;
    if (isDir) {
      var inside = prFiles().filter(function (p) { return p.indexOf(target + '/') === 0; })
        .map(function (p) { return p.slice(target.length + 1); });
      if (!inside.length) return { t: '', c: 't-dim' };
      return { t: inside.join('   '), c: 't-tbl' };
    }
    return { t: "ls: cannot access '" + target + "': No such file or directory", c: 't-err' };
  }

  if (c === 'cat') {
    var rest2 = a.slice(1);
    if (/^cat\s+(>>|>)\s*$/.test(t) || /^cat\s*$/.test(t) && /[>]/.test(t)) {
      return { t: "bash: syntax error near unexpected token 'newline'", c: 't-err' };
    }
    /* heredoc */
    var mh = t.match(/^cat\s+(>>|>)\s*(\S+)\s*<<(-?)\s*(['"]?)(\w+)\4\s*$/);
    if (mh) {
      if (PR.repo[mh[2]] === undefined && mh[1] === '>') {
        var par = mh[2].indexOf('/') > -1 ? mh[2].slice(0, mh[2].lastIndexOf('/')) : null;
        if (par && prDirs().indexOf(par) === -1) {
          return { t: 'cat: ' + mh[2] + ': No such file or directory', c: 't-err' };
        }
      }
      PR.hd = { path: mh[2], append: mh[1] === '>>', marker: mh[5] };
      PR.hdLines = [];
      if (typeof COURSES !== 'undefined' && COURSES.prompt) COURSES.prompt.pr = PR_PROMPT_HD;
      return { t: '> (ждём строки до ' + mh[5] + ' — введи текст промпта, последней строкой сам маркер)',
               c: 't-dim' };
    }
    /* herestring */
    var ms = t.match(/^cat\s+(>>|>)\s*(\S+)\s*<<<\s*(\$)?("([^"]*)"|'([^']*)')\s*$/);
    if (ms) {
      var txt = ms[5] !== undefined ? ms[5] : ms[6];
      if (ms[3] === '$') txt = txt.replace(/\\(n|t|r|\\|'|"|`|e|0)/g, function (mm, ch) {
        return { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`', e: '\x1b', 0: '\0' }[ch];
      });
      if (ms[1] === '>') PR.repo[ms[2]] = txt + '\n'; else PR.repo[ms[2]] = (PR.repo[ms[2]] || '') + txt + '\n';
      prSync();
      if (ms[2] === 'prompts/support.txt') prTouch('правка через herestring');
      var pre = ms[3] === '$' ? '$' : '';
      return { t: ms[2] + ' обновлён (' + txt.length + ' байт)', c: 't-ok' };
    }
    /* cat с перенаправлением без heredoc — читаем stdin до Ctrl+D */
    var mcat = t.match(/^cat\s+(>>|>)\s*(\S+)\s*$/);
    if (mcat) {
      if (PR.repo[mcat[2]] === undefined && mcat[1] === '>') {
        var pdir2 = mcat[2].indexOf('/') > -1 ? mcat[2].slice(0, mcat[2].lastIndexOf('/')) : null;
        if (pdir2 && prDirs().indexOf(pdir2) === -1) {
          return { t: 'cat: ' + mcat[2] + ': No such file or directory', c: 't-err' };
        }
      }
      PR.hd = { path: mcat[2], append: mcat[1] === '>>', marker: 'Ctrl+D' };
      PR.hdLines = [];
      if (typeof COURSES !== 'undefined' && COURSES.prompt) COURSES.prompt.pr = PR_PROMPT_HD;
      return { t: '(stdin) введи текст, закончи строкой Ctrl+D', c: 't-dim' };
    }
    /* обычный cat */
    var files = prExpand(rest2.filter(function (x) { return x[0] !== '-'; }));
    if (!files.length) return { t: 'usage: cat [-n] файл…', c: 't-err' };
    for (var i = 0; i < files.length; i++) {
      if (PR.repo[files[i]] === undefined) {
        return { t: 'cat: ' + files[i] + ': No such file or directory', c: 't-err' };
      }
    }
    var numbered = a.indexOf('-n') > -1;
    var body2 = files.map(function (p) {
      var s = PR.repo[p].replace(/\n$/, '');
      if (numbered) {
        s = prLines(s).map(function (l, k) { return prPad(String(k + 1), 5) + '  ' + l; }).join('\n');
      }
      return files.length > 1 ? '==> ' + p + ' <==\n' + s : s;
    }).join('\n');
    return { t: body2, c: 't-tbl' };
  }

  if (c === 'head' || c === 'tail') {
    var flags = [], nums = [];
    var w2 = a.slice(1);
    var k2 = 0;
    while (k2 < w2.length && w2[k2][0] === '-') {
      flags.push(w2[k2]); k2++;
      if (w2[k2] !== undefined && /^\d+$/.test(w2[k2])) { nums.push(parseInt(w2[k2], 10)); k2++; }
    }
    var f0 = prExpand(w2.slice(k2))[0] || '';
    if (PR.repo[f0] === undefined) {
      return { t: c + ": can't open '" + f0 + "': No such file or directory", c: 't-err' };
    }
    var ln = nums.length ? nums[0] : 10;
    var all = prLines(PR.repo[f0]);
    var picked = c === 'head' ? all.slice(0, ln) : all.slice(Math.max(0, all.length - ln));
    return { t: picked.join('\n'), c: 't-tbl' };
  }

  if (c === 'wc') {
    var wflags = a.slice(1).filter(function (x) { return x[0] === '-'; }).join('');
    var wargs = a.slice(1).filter(function (x) { return x[0] !== '-'; });
    var wf = prExpand(wargs);
    if (!wf.length) return { t: 'usage: wc [-l|-w|-c] файл…', c: 't-err' };
    var onlyLines = wflags.indexOf('l') > -1, onlyW = wflags.indexOf('w') > -1, onlyC = wflags.indexOf('c') > -1;
    var wl = wf.map(function (p) {
      if (PR.repo[p] === undefined) return { t: "wc: " + p + ': No such file or directory', c: 't-err' };
      var s = PR.repo[p];
      var nL = prLines(s).length, nW = (s.match(/\S+/g) || []).length, nC = s.length;
      var body;
      if (onlyLines) body = prPad(String(nL), 6);
      else if (onlyW) body = prPad(String(nW), 6);
      else if (onlyC) body = prPad(String(nC), 7);
      else body = prPad(String(nL), 6) + ' ' + prPad(String(nW), 6) + ' ' + prPad(String(nC), 7);
      return { t: body + ' ' + p, c: 't-tbl', nL: nL, nW: nW, nC: nC };
    });
    var errs = wl.filter(function (x) { return x.c === 't-err'; });
    if (errs.length) return errs[0];
    if (wf.length > 1) {
      var tl = wl.reduce(function (s2, r) { return s2 + r.nL; }, 0);
      var tw = wl.reduce(function (s2, r) { return s2 + r.nW; }, 0);
      var tc = wl.reduce(function (s2, r) { return s2 + r.nC; }, 0);
      var tot;
      if (onlyLines) tot = prPad(String(tl), 6);
      else if (onlyW) tot = prPad(String(tw), 6);
      else if (onlyC) tot = prPad(String(tc), 7);
      else tot = prPad(String(tl), 6) + ' ' + prPad(String(tw), 6) + ' ' + prPad(String(tc), 7);
      return { t: wl.map(function (x) { return x.t; }).join('\n') + '\n' + tot + ' total', c: 't-tbl' };
    }
    return wl[0];
  }

  if (c === 'grep') {
    var gopts = a.slice(1).filter(function (x) { return x[0] === '-' && x.length > 1; }).join('');
    var gi = gopts.indexOf('i') > -1, gn = gopts.indexOf('n') > -1,
        gc = gopts.indexOf('c') > -1, gv = gopts.indexOf('v') > -1, gr = gopts.indexOf('r') > -1;
    var gargs = a.slice(1).filter(function (x) { return !(x[0] === '-' && x.length > 1); });
    if (!gargs.length) return { t: 'usage: grep [-n] [-i] [-c] [-r] шаблон файл…', c: 't-err' };
    var pat = gargs[0];
    var gp = [];
    prExpand(gargs.slice(1)).forEach(function (p) {
      if (PR.repo[p] === undefined && prDirs().indexOf(p.replace(/\/$/, '')) > -1) {
        gp = gp.concat(prFiles().filter(function (f) {
          return f.indexOf(p.replace(/\/$/, '') + '/') === 0;
        }));
      } else {
        gp.push(p);
      }
    });
    if (!gp.length) {
      if (!gr) return { t: 'usage: grep … шаблон файл…', c: 't-err' };
      gp = prFiles().filter(function (p) { return p.indexOf('prompts/') === 0; });
      gn = true;
    }
    var miss2 = gp.filter(function (p) { return PR.repo[p] === undefined; });
    if (miss2.length) return { t: 'grep: ' + miss2[0] + ': No such file or directory', c: 't-err' };
    return prGrep({ i: gi, n: gn, c: gc, v: gv }, pat, gp);
  }

  if (c === 'sed') {
    var msed = t.match(/^sed\s+-i(?:\.bak)?\s+(?:(['"])(\/.*?\/[a-z]*)\1|(\/.*?\/[a-z]+))\s+(\S+)\s*$/);
    if (msed) {
      var target = msed[4];
      if (PR.repo[target] === undefined) {
        return { t: "sed: can't read " + target + ': No such file or directory', c: 't-err' };
      }
      var expr = msed[2] || msed[3], before = PR.repo[target];
      var outp;
      var md = expr.match(/^\/(.*)\/d$/);
      if (md) {
        var re = new RegExp(md[1], 'i');
        outp = prLines(before).filter(function (l) { return !re.test(l); }).join('\n') + '\n';
      } else {
        var ms2 = expr.match(/^s(.)(.*?)\1(.*?)\1([a-z]*)$/);
        if (!ms2) return { t: 'sed: -e expression #' + expr + '#', c: 't-err' };
        outp = before.replace(new RegExp(ms2[2], ms2[4].indexOf('g') > -1 ? 'gi' : 'i'), ms2[3]);
      }
      var nDel = prLines(before).length - prLines(outp).length;
      PR.repo[target] = outp;
      prSync();
      if (target === 'prompts/support.txt') prTouch('правка через sed -i');
      return {
        t: nDel > 0 ? ('(sed молчит) ' + target + ': удалено строк — ' + nDel)
                    : '(sed молчит) ' + target + ': выполнена замена',
        c: 't-ok'
      };
    }
    var msedn = t.match(/^sed\s+-n\s+(['"])(\/.*?)\/\1[p]*\s+(\S+)\s*$/);
    if (msedn) {
      var tp = msedn[3];
      if (PR.repo[tp] === undefined) return { t: "sed: can't read " + tp + ': No such file or directory', c: 't-err' };
      var rr = new RegExp(msedn[2], 'i');
      return { t: prLines(PR.repo[tp]).filter(function (l) { return rr.test(l); }).join('\n'), c: 't-tbl' };
    }
    return { t: "usage: sed -i '/шаблон/d' файл   |   sed -i 's/старое/новое/g' файл", c: 't-err' };
  }

  if (c === 'rm') {
    var rf = a.slice(1).filter(function (x) { return x[0] !== '-' && x !== '-f' && x !== '-rf' && x !== '-fr'; });
    if (!rf.length) return { t: 'usage: rm файл', c: 't-err' };
    var gone = [];
    for (var j = 0; j < rf.length; j++) {
      if (PR.repo[rf[j]] === undefined) {
        return { t: 'rm: cannot remove ' + rf[j] + ': No such file or directory', c: 't-err' };
      }
      gone.push(rf[j]);
    }
    gone.forEach(function (p) { delete PR.repo[p]; });
    prSync();
    return { t: '', c: 't-dim' };
  }

  if (c === 'echo') {
    var me2 = t.match(/^echo\s+([\s\S]*?)\s*(>>|>)\s*(\S+)\s*$/);
    if (me2) {
      var txt2 = me2[1].replace(/^["']|["']$/g, '');
      if (PR.repo[me2[3]] === undefined && me2[2] === '>') {
        var pdir = me2[3].indexOf('/') > -1 ? me2[3].slice(0, me2[3].lastIndexOf('/')) : null;
        if (pdir && prDirs().indexOf(pdir) === -1) {
          return { t: 'bash: ' + me2[3] + ': No such file or directory', c: 't-err' };
        }
      }
      PR.repo[me2[3]] = me2[2] === '>' ? txt2 + '\n' : (PR.repo[me2[3]] || '') + txt2 + '\n';
      prSync();
      if (me2[3] === 'prompts/support.txt') prTouch('правка через echo >');
      return { t: '', c: 't-dim' };
    }
    return { t: a.slice(1).join(' ').replace(/^["']|["']$/g, ''), c: 't-tbl' };
  }

  if (c === 'pwd') return { t: '/home/dev/prompt-lab', c: 't-tbl' };
  if (c === 'cd') {
    return { t: 'bash: cd: ' + (a[1] || '') + ': в курсе один корень — работаем из /home/dev/prompt-lab',
             c: 't-dim' };
  }
  if (c === 'mkdir') {
    var md3 = a.slice(1).filter(function (x) { return x[0] !== '-'; });
    var exist = md3.filter(function (p) { return prDirs().indexOf(p) > -1; });
    if (exist.length) return { t: 'mkdir: cannot create directory ‘' + exist[0] + '’: File exists', c: 't-err' };
    return { t: '', c: 't-dim' };
  }
  if (c === 'cp') {
    var cs = a.slice(1).filter(function (x) { return x[0] !== '-'; });
    if (cs.length < 2) return { t: 'usage: cp источник назначение', c: 't-err' };
    if (PR.repo[cs[0]] === undefined) return { t: 'cp: cannot stat ' + cs[0] + ': No such file or directory', c: 't-err' };
    PR.repo[cs[1]] = PR.repo[cs[0]];
    return { t: '', c: 't-dim' };
  }

  /* -------------------------------------------------------- окружение */
  if (c === 'env' && a.length === 1) {
    return { t: Object.keys(PR.envv).map(function (k) { return k + '=' + PR.envv[k]; }).join('\n'), c: 't-tbl' };
  }
  if (c === 'export') {
    var me3 = t.match(/^export\s+(\w+)=(.*)$/);
    if (!me3) return { t: 'usage: export ПЕРЕМЕННАЯ=значение', c: 't-err' };
    PR.envv[me3[1]] = me3[2];
    return { t: '', c: 't-dim' };
  }
  if (c === 'unset') {
    if (PR.envv[a[1]] === undefined) return { t: 'bash: unset: ' + a[1] + ': not found', c: 't-dim' };
    delete PR.envv[a[1]];
    return { t: '', c: 't-dim' };
  }

  /* -------------------------------------------------------------- jq */
  if (c === 'jq') {
    var jqArgs = a.slice(1).filter(function (x) { return x !== '-r'; });
    var jqRaw = a.indexOf('-r') > -1;
    if (jqArgs.length < 2 || jqArgs[0][0] !== '.') {
      return { t: "usage: jq '.results.stats' results.json", c: 't-err' };
    }
    var jqPath = jqArgs[0], jqFile = jqArgs[1];
    if (PR.repo[jqFile] === undefined) {
      return { t: 'jq: error: Could not open ' + jqFile + ': No such file or directory', c: 't-err' };
    }
    var doc;
    try { doc = JSON.parse(PR.repo[jqFile]); } catch (e) { doc = null; }
    if (!doc) return { t: 'jq: error (at ' + jqFile + ':1): Invalid JSON', c: 't-err' };
    var got = prJqPath(doc, jqPath);
    if (got.err) return { t: 'jq: error (at ' + jqFile + ':1): ' + got.err, c: 't-err' };
    if (got.val === null) return { t: 'null', c: 't-tbl' };
    if (typeof got.val === 'object') return { t: JSON.stringify(got.val, null, 2), c: 't-tbl' };
    if (typeof got.val === 'boolean') return { t: String(got.val), c: 't-tbl' };
    return { t: jqRaw ? String(got.val) : '"' + got.val + '"', c: 't-tbl' };
  }

  /* ============================================================ git */
  if (c === 'git') return prGit(t, a.slice(1));

  /* ====================================================== promptfoo */
  if (c === 'promptfoo') return prPromptfoo(t, a.slice(1));

  /* --------------------------------------------------------- справка */
  if (c === 'clear') return { t: '', c: 't-dim' };
  if (c === 'tree' || c === 'find') {
    var tree = prDirs().map(function (d) {
      return d + '/\n' + prFiles().filter(function (p) { return p.indexOf(d + '/') === 0; })
        .map(function (p) { return '  └── ' + p.slice(d.length + 1); }).join('\n');
    }).join('\n');
    return { t: prFiles().filter(function (p) { return p.indexOf('/') === -1; }).join('\n') + '\n' + tree, c: 't-tbl' };
  }
  if (c === 'which') {
    var known = { promptfoo: '/usr/local/bin/promptfoo', git: '/usr/bin/git',
                  vi: '/usr/bin/vi', jq: '/usr/bin/jq', sed: '/usr/bin/sed', node: '/usr/bin/node' };
    return known[a[1]]
      ? { t: known[a[1]], c: 't-tbl' }
      : { t: a[1] + ' not found', c: 't-err' };
  }

  return {
    t: a[0] + ': command not found — набери help, чтобы увидеть список команд',
    c: 't-err'
  };
}

/* ------------------------------------------------------------------ git */

function prGitHead() {
  return PR.gitlog[PR.gitlog.length - 1];
}

function prGitStatus() {
  var head = prGitHead();
  var cur = PR.repo, staged = {};
  Object.keys(PR.staged).forEach(function (p) { staged[p] = PR.repo[p]; });
  var changed = [];
  var keys = {};
  Object.keys(head.snap).forEach(function (k) { keys[k] = 1; });
  Object.keys(cur).forEach(function (k) { keys[k] = 1; });
  Object.keys(keys).sort().forEach(function (k) {
    if (cur[k] === undefined) { changed.push({ p: k, s: 'deleted' }); return; }
    if (head.snap[k] === cur[k]) return;
    changed.push({ p: k, s: PR.staged[k] ? 'staged' : 'modified' });
  });
  var stg = Object.keys(PR.staged);
  var untracked = prFiles().filter(function (p) { return head.snap[p] === undefined; });
  if (!changed.length && !untracked.length) {
    return { t: 'On branch main\nnothing to commit, working tree clean', c: 't-ok' };
  }
  var unst = changed.filter(function (x) { return x.s !== 'staged' && x.s !== 'deleted'; });
  var del = changed.filter(function (x) { return x.s === 'deleted'; });
  var out = 'On branch main\n';
  if (stg.length || del.length) {
    out += '\nChanges to be committed:\n';
    out += '  (use "git restore --staged <file>..." to unstage)\n';
    del.forEach(function (x) { out += '\tdeleted:    ' + x.p + '\n'; });
    stg.forEach(function (p) { out += '\tmodified:   ' + p + '\n'; });
  }
  if (unst.length) {
    out += '\nChanges not staged for commit:\n';
    out += '  (use "git add <file>..." to update what will be committed)\n';
    out += '  (use "git restore <file>..." to discard changes in working directory)\n';
    unst.forEach(function (x) { out += '\tmodified:   ' + x.p + '\n'; });
  }
  if (untracked.length) {
    out += '\nUntracked files:\n';
    out += '  (use "git add <file>..." to include in what will be committed)\n';
    untracked.forEach(function (p) { out += '\t' + p + '\n'; });
  }
  if (!changed.length) {
    out += '\nnothing added to commit but untracked files present (use "git add" to track)';
  } else {
    out += '\nno changes added to commit (use "git add" and/or "git commit -a")';
  }
  return { t: out, c: 't-tbl' };
}

function prGit(t, a) {
  var sub = a[0];

  if (sub === 'status') return prGitStatus();

  if (sub === 'diff') {
    var head = prGitHead();
    var staged = a.indexOf('--staged') > -1 || a.indexOf('--cached') > -1;
    var from = head.snap, to;
    if (staged) {
      to = prCopy(head.snap);
      Object.keys(PR.staged).forEach(function (p) {
        if (PR.repo[p] === undefined) delete to[p]; else to[p] = PR.repo[p];
      });
    } else {
      to = prCopy(head.snap);
      Object.keys(PR.repo).forEach(function (p) {
        if (PR.repo[p] !== head.snap[p]) to[p] = PR.repo[p];
      });
      Object.keys(head.snap).forEach(function (p) {
        if (PR.repo[p] === undefined) to[p] = '';
      });
    }
    var d = prDiffAll(from, to);
    if (!d) {
      return {
        t: staged ? '(пусто — в индексе нет изменений)' : '(пусто — рабочая копия совпадает с HEAD)',
        c: 't-dim'
      };
    }
    return { t: d.replace(/\n$/, ''), c: 't-tbl' };
  }

  if (sub === 'add') {
    var paths = a.slice(1).filter(function (x) { return x[0] !== '-' && x !== '-A'; });
    if (!paths.length) return { t: 'Nothing specified, nothing added.', c: 't-dim' };
    var added = [];
    paths.forEach(function (p) {
      if (p === '.' || p === './' || p === '-A') {
        prFiles().forEach(function (f) { PR.staged[f] = true; added.push(f); });
        return;
      }
      var hit = prFiles().filter(function (f) { return f === p || f.indexOf(p.replace(/\/$/, '') + '/') === 0; });
      if (!hit.length) { added.push(null); return; }
      hit.forEach(function (f) { PR.staged[f] = true; added.push(f); });
    });
    var badAdd = added.indexOf(null) > -1;
    if (badAdd) return { t: 'fatal: pathspec did not match any files', c: 't-err' };
    return { t: '(git add молчит) в индекс добавлено файлов: ' + added.length +
                 '\nпроверь состояние: git status', c: 't-ok' };
  }

  if (sub === 'commit') {
    var mcom = t.match(/^git\s+commit\s+(-[am]\s+)*-m\s+("|')([\s\S]*?)\2\s*$/);
    if (!mcom) return { t: "usage: git commit -m \"сообщение\"", c: 't-err' };
    var stgKeys = Object.keys(PR.staged);
    var useA = /-[am]\s+/.test(t.replace('-m', '')) && !stgKeys.length;
    var snap = prCopy(prGitHead().snap);
    if (useA) {
      prFiles().forEach(function (f) { if (PR.repo[f] !== undefined) snap[f] = PR.repo[f]; });
    } else {
      if (!stgKeys.length) {
        return { t: 'On branch main\nnothing to commit, working tree clean', c: 't-err' };
      }
      stgKeys.forEach(function (p) {
        if (PR.repo[p] === undefined) delete snap[p]; else snap[p] = PR.repo[p];
      });
    }
    var changedF = Object.keys(snap).filter(function (k) { return snap[k] !== prGitHead().snap[k]; });
    if (!changedF.length) return { t: 'On branch main\nnothing to commit, working tree clean', c: 't-err' };
    var plus = 0, minus = 0;
    changedF.forEach(function (p) {
      var sc = prEditScript(prLines(prGitHead().snap[p] || ''), prLines(snap[p] || ''));
      sc.forEach(function (r) { if (r[0] === '+') plus++; else if (r[0] === '-') minus++; });
    });
    var bodyHash = prHash(JSON.stringify(snap) + t);
    PR.gitlog.push({ h: bodyHash, ts: prNow(), msg: mcom[3], snap: snap });
    PR.staged = {};
    return {
      t: '[' + 'main ' + bodyHash + '] ' + mcom[3] + '\n ' + changedF.length +
         ' file' + (changedF.length === 1 ? '' : 's') + ' changed, ' + plus + ' insertion' +
         (plus === 1 ? '' : 's') + '(+), ' + minus + ' deletion' + (minus === 1 ? '' : 's') + '(-)',
      c: 't-ok'
    };
  }

  if (sub === 'log') {
    if (!PR.gitlog.length) return { t: "fatal: your current branch 'main' does not have any commits yet", c: 't-err' };
    var one = a.indexOf('--oneline') > -1 || a.indexOf('--pretty=oneline') > -1;
    var lim = 0;
    var mn2 = t.match(/-n\s+(\d+)/);
    if (mn2) lim = parseInt(mn2[1], 10);
    var list = PR.gitlog.slice().reverse();
    if (lim) list = list.slice(0, lim);
    if (one) {
      return { t: list.map(function (cm) { return cm.h + ' ' + cm.msg; }).join('\n'), c: 't-tbl' };
    }
    return {
      t: 'commit ' + list[0].h + '\nAuthor: dev <dev@prompt-lab>\nDate:   ' + list[0].ts + '\n\n    ' +
         list[0].msg + '\n',
      c: 't-tbl'
    };
  }

  if (sub === 'tag') {
    var tn = a[1];
    if (!tn) {
      var tags = PR.gitlog.filter(function (cm) { return cm.tag; });
      return {
        t: tags.length ? tags.map(function (cm) { return cm.tag + '  ' + cm.h + '  ' + cm.msg; }).join('\n')
                       : '(тегов нет)',
        c: tags.length ? 't-tbl' : 't-dim'
      };
    }
    if (!/^v?\d+([.-]\d+)*$/.test(tn)) {
      return { t: "fatal: '" + tn + "' is not a valid tag name", c: 't-err' };
    }
    var dup = PR.gitlog.some(function (cm) { return cm.tag === tn; });
    if (dup) return { t: "fatal: tag '" + tn + "' already exists", c: 't-err' };
    var last = prGitHead();
    last.tag = tn;
    return { t: '(git tag молчит) ' + tn + ' → ' + last.h + ' · ' + last.msg +
                 '\nзафиксирована рабочая версия промпта', c: 't-ok' };
  }

  if (sub === 'show') {
    var ref = a[1];
    var cm2 = prGitHead();
    if (ref && ref !== 'HEAD' && ref !== 'latest') {
      cm2 = PR.gitlog.filter(function (x) { return x.h === ref || x.tag === ref; })[0];
      if (!cm2) return { t: "fatal: ambiguous argument '" + ref + "': unknown revision or path", c: 't-err' };
    }
    var prev = PR.gitlog[PR.gitlog.indexOf(cm2) - 1];
    var d2 = prev ? prDiffAll(prev.snap, cm2.snap) : prDiffAll({}, cm2.snap);
    return {
      t: 'commit ' + cm2.h + (cm2.tag ? ' (tag: ' + cm2.tag + ')' : '') +
         '\nAuthor: dev <dev@prompt-lab>\nDate:   ' + cm2.ts + '\n\n    ' + cm2.msg + '\n\n' +
         (d2 ? d2.replace(/\n$/, '') : '(пусто)'),
      c: 't-tbl'
    };
  }

  if (sub === 'checkout' || sub === 'restore') {
    var rest = a.slice(1).filter(function (x) { return x[0] !== '-'; });
    if (sub === 'checkout') rest = rest.filter(function (x) { return x !== '--'; });
    var fp2 = prExpand(rest)[0];
    if (!fp2) return { t: 'usage: ' + sub + ' <файл>', c: 't-err' };
    var orig = prGitHead().snap[fp2];
    if (orig === undefined) {
      return { t: "error: pathspec '" + fp2 + "' did not match any file(s) known to git", c: 't-err' };
    }
    if (sub === 'restore' && a.indexOf('--staged') > -1) {
      delete PR.staged[fp2];
      return { t: 'Unstaged changes after reset:\nM\t' + fp2, c: 't-tbl' };
    }
    if (PR.repo[fp2] === orig) return { t: '', c: 't-dim' };
    var wasGone = PR.repo[fp2] === undefined;
    PR.repo[fp2] = orig;
    prSync();
    if (fp2 === 'prompts/support.txt') prTouch('откат через ' + sub);
    return {
      t: "Updated 1 path from " + prGitHead().h + '\n' +
         (wasGone ? 'A\t' : 'M\t') + fp2 + '\n' +
         (wasGone ? 'файл был удалён — вернули его из последнего коммита'
                  : 'файл вернулся к последнему коммиту'),
      c: 't-ok'
    };
  }

  if (sub === 'init') {
    return { t: "Reinitialized existing Git repository in '/home/dev/prompt-lab/.git/'.", c: 't-dim' };
  }
  if (!sub) {
    return {
      t: 'usage: git <command> [<args>]\n\n' +
         'Здесь работают: status · diff · add · commit · log · show · tag · checkout · restore\n' +
         'Типичный цикл: git status → git diff → git add prompts/ → git commit -m "…"',
      c: 't-dim'
    };
  }
  return { t: "git: '" + sub + "' не поддерживается в этом курсе — см. help", c: 't-err' };
}

/* ------------------------------------------------------------ promptfoo */

function prEvalHeader(r, cfgArg) {
  var s = 'Running eval (promptfoo eval' + (cfgArg ? ' -c ' + cfgArg : '') + ')\n\n';
  s += '[1] prompts/support.txt · label: ' + r.provider + ' · temperature 0.2\n\n';
  return s;
}

function prEvalBlock(r, verbose, cfgArg) {
  var head = prEvalHeader(r, cfgArg);
  var body = '';
  var fails = 0;
  r.res.forEach(function (x) {
    body += '  ' + x.d + '\n';
    x.per.forEach(function (p) {
      if (!p.ok) fails++;
      var line;
      if (p.ty === 'contains') {
        line = p.ok ? '[PASS] contains: ' + p.v
                    : '[FAIL] Expected output to contain: ' + p.v;
      } else {
        line = p.ok ? '[PASS] llm-rubric (' + p.sc.toFixed(2) + ') — ' + p.v
                    : '[FAIL] Expected output to satisfy rubric: ' + p.v + ' (score 0.00)';
      }
      body += '    ' + line + '\n';
      if (verbose) {
        if (p.ty === 'contains') {
          body += '      Expected: to contain "' + p.v + '"\n';
          body += '      Received: ' + prCut(x.raw.replace(/\n/g, ' '), 120) + '\n';
        } else {
          body += '      Rubric: ' + p.v + '\n';
          body += '      Grader: openai:gpt-4o-mini · ' + (p.ok ? 'pass' : 'fail') +
                  ' (' + (p.ok ? p.sc.toFixed(2) : '0.00') + ')\n';
        }
      }
    });
    body += '    → ' + (x.pass ? 'PASS' : 'FAIL') + ' · ' + x.ms + 'ms · ' +
            prNum(x.inTok + x.outTok) + ' tokens · $' + x.cost.toFixed(6) + '\n\n';
  });

  var rows = r.res.map(function (x) {
    return [
      x.d,
      prNum(x.inTok + x.outTok),
      '$' + x.cost.toFixed(6),
      Math.round(x.score * 100) + '%',
      x.pass ? 'PASS' : 'FAIL'
    ];
  });
  var tbl = prBox(['test', 'tokens', 'cost', 'score', 'verdict'], rows);

  var tail = '\nEval complete. (' + r.total + ' tests, ' + r.pass + ' passing, ' +
             r.pct + '% passed)\n' +
             'Total tokens: ' + prNum(r.tok) + ' (prompt ' + prNum(r.ptok) +
             ', completion ' + prNum(r.ctok) + ')\n' +
             'Estimated cost: $' + r.cost.toFixed(6) + '\n' +
             'Results stored in ~/.promptfoo (eval id ' + prHash(r.ts + r.cfg).slice(0, 6) + ')';
  if (fails && !verbose) {
    tail += '\nПодробности по упавшим проверкам: promptfoo eval --verbose';
  }
  if (r.miss.length) {
    tail += '\n[!] в тексте промпта нет требований: ' +
            r.miss.map(function (id) {
              for (var i = 0; i < PR_GUARDS.length; i++) if (PR_GUARDS[i].id === id) return PR_GUARDS[i].label;
              return id;
            }).join(' · ');
  }
  return head + body + tbl + '\n' + tail;
}

function prPromptfoo(t, a) {
  var sub = a[0];

  if (sub === 'eval') {
    if (PR.repo['prompts/support.txt'] === undefined) {
      return {
        t: 'Error: Failed to parse prompt file: prompts/support.txt\n' +
           "  ENOENT: no such file or directory, open 'prompts/support.txt'",
        c: 't-err'
      };
    }
    if (PR.sys.replace(/\s/g, '') === '') {
      return {
        t: 'Error: Failed to parse prompt file: prompts/support.txt\n' +
           '  файл пуст — promptfoo не может собрать сообщение для модели',
        c: 't-err'
      };
    }
    var badTag = PR.sys.match(/\{\{[^}]*$/);
    if (badTag) {
      return {
        t: 'Error: Failed to parse prompt file: prompts/support.txt\n' +
           '  NunjucksError: unexpected end of tag: "{{' + badTag[0].replace('{{', '') + '"',
        c: 't-err'
      };
    }

    var cfgArg = null, provider = 'openai:gpt-4o-mini', verbose = false, outFile = null;
    for (var i = 1; i < a.length; i++) {
      var w = a[i];
      if (w === '-c' || w === '--config') { cfgArg = a[++i]; continue; }
      if (w.indexOf('--config=') === 0) { cfgArg = w.slice(9); continue; }
      if (w === '-o' || w === '--output') { outFile = a[++i]; continue; }
      if (w.indexOf('--output=') === 0) { outFile = w.slice(9); continue; }
      if (w === '--verbose') { verbose = true; continue; }
      if (w === '--no-cache' || w === '--no-write' || w === '--no-progress-bar' ||
          w === '--no-table' || w === '--no-share') continue;
      if (w === '--repeat' || w === '-j' || w === '--max-concurrency' ||
          w === '--var' || w === '--filter-pattern') { i++; continue; }
      if (w === '--filter-failing' || w === '--filter-failing-only' ||
          w === '--filter-errors-only' || w === '--filter-providers' ||
          w === '--filter-prompts' || w === '--filter-metadata') { i++; continue; }
    }
    if (cfgArg && PR.repo[cfgArg] === undefined) {
      return { t: 'Error: Config file not found: ' + cfgArg, c: 't-err' };
    }
    if (cfgArg && /llama/.test(cfgArg)) {
      provider = 'ollama:chat:llama3.1';
      if (!PR.envv.OPENAI_API_KEY) { /* локальный провайдер ключ не требует */ }
    } else if (!PR.envv.OPENAI_API_KEY) {
      return {
        t: 'Error: No API key configured — set OPENAI_API_KEY or use local provider\n' +
           '  provider: openai:gpt-4o-mini требует ключ.\n' +
           '  Что делать: export OPENAI_API_KEY=sk-… или возьми конфиг с локальной моделью:\n' +
           '              promptfoo eval -c promptfooconfig.llama.yaml',
        c: 't-err'
      };
    }

    var r = prEvaluate(cfgArg || 'promptfooconfig.yaml', provider);
    var txt = prEvalBlock(r, verbose, cfgArg);
    if (outFile) {
      txt += '\nWrote ' + r.total + ' results to ' + outFile;
    } else {
      txt += '\n(results.json в рабочем каталоге обновлён — посмотреть: jq \'.results.stats\' results.json)';
    }
    if (r.pct < 100) {
      txt += '\nexit code 100 — есть упавшие проверки';
    }
    out(txt, r.pct === 100 ? 't-ok' : 't-tbl');
    return null;
  }

  if (sub === 'view') {
    if (!PR.run) {
      return {
        t: 'No evals found. Run `promptfoo eval` first, then `promptfoo view`.',
        c: 't-err'
      };
    }
    var port = a.indexOf('-p') > -1 ? a[a.indexOf('-p') + 1] : '15555';
    return {
      t: 'Starting web server on http://localhost:' + port + '…\n' +
         'Eval:      ' + prHash(PR.run.ts).slice(0, 8) + '\n' +
         'Provider:  ' + PR.run.provider + '\n' +
         'Pass rate: ' + PR.run.pct + '% (' + PR.run.pass + '/' + PR.run.total + ')\n\n' +
         'Открываю http://localhost:' + port + ' в браузере.\n' +
         'В интерфейсе видно каждый тест, каждое утверждение и полный вывод модели.',
      c: 't-ok'
    };
  }

  if (sub === 'validate') {
    var vsub = a[1];
    var vcfg = 'promptfooconfig.yaml';
    var mi = t.indexOf('-c ');
    if (mi > -1) vcfg = t.slice(mi + 3).trim().split(/\s+/)[0];
    if (vsub === 'target') {
      return { t: 'Testing provider connectivity…\n✓ ' + PR.run ? '✓ openai:gpt-4o-mini reachable' :
               'Error: No API key configured — set OPENAI_API_KEY or use local provider', c: 't-ok' };
    }
    if (vsub !== 'config' && vsub) {
      return { t: 'usage: promptfoo validate config [-c promptfooconfig.yaml]', c: 't-err' };
    }
    if (PR.repo[vcfg] === undefined) return { t: 'Error: Config file not found: ' + vcfg, c: 't-err' };
    var prMissing = /file:\/\/(\S+)/.exec(PR.repo[vcfg]);
    var bad = prMissing && PR.repo[prMissing[1]] === undefined;
    if (bad) return { t: 'Error: prompt file not found: ' + prMissing[1], c: 't-err' };
    return {
      t: 'Validating ' + vcfg + '…\n✓ Valid YAML\n✓ 1 prompt (file://prompts/support.txt)\n' +
         '✓ 1 provider (openai:gpt-4o-mini)\n✓ 3 tests, 6 assertions\nConfiguration is valid.',
      c: 't-ok'
    };
  }

  if (sub === 'debug') {
    return {
      t: 'Config dir:  /home/dev/.promptfoo\nConfig file: /home/dev/prompt-lab/promptfooconfig.yaml\n' +
         'Package:     promptfoo@3.44.1\nNode:        v20.18.0\n' +
         'Provider:    openai:gpt-4o-mini\n' +
         'API key:     ' + (PR.envv.OPENAI_API_KEY ? 'OPENAI_API_KEY set (sk-proj-…f4a2)' : 'MISSING'),
      c: 't-tbl'
    };
  }

  if (sub === 'show') {
    if (!PR.run) return { t: 'No eval found. Run `promptfoo eval` first.', c: 't-err' };
    return {
      t: 'Eval ' + prHash(PR.run.ts).slice(0, 8) + '\n' +
         'Created:  ' + PR.run.ts + '\n' +
         'Provider: ' + PR.run.provider + '\n' +
         'Prompt:   prompts/support.txt (' + prNum(PR.run.promptTokens) + ' tokens)\n' +
         'Result:   ' + PR.run.pass + '/' + PR.run.total + ' passing (' + PR.run.pct + '%)\n' +
         'Cost:     $' + PR.run.cost.toFixed(6),
      c: 't-tbl'
    };
  }

  if (sub === 'list') {
    if (!PR.run) return { t: 'No evals found.', c: 't-dim' };
    return {
      t: prHash(PR.run.ts).slice(0, 8) + '  ' + PR.run.ts + '  ' + PR.run.total + ' tests  ' +
         PR.run.pct + '%  ' + PR.run.cfg,
      c: 't-tbl'
    };
  }

  if (sub === 'config') {
    return {
      t: 'у promptfoo config только get/set/unset для email:\n' +
         '  promptfoo config get email\n\n' +
         'Посмотреть и проверить сам конфиг — это promptfoo validate config:\n' +
         '  promptfoo validate config -c promptfooconfig.yaml',
      c: 't-dim'
    };
  }

  if (sub === 'init') {
    return { t: 'Project already initialized — promptfooconfig.yaml уже на месте.', c: 't-dim' };
  }

  if (!sub) {
    return {
      t: 'Usage: promptfoo <command> [options]\n\n' +
         'Commands:\n' +
         '  eval       Evaluate prompts and models\n' +
         '  view       Start a browser UI for visualization of results\n' +
         '  validate   Validate a promptfoo configuration file\n' +
         '  debug      Display debug information for troubleshooting\n' +
         '  show       Show details of a specific resource (eval)\n' +
         '  list       List various resources like evals, prompts, and datasets\n' +
         '  config     Edit configuration settings (email)\n',
      c: 't-dim'
    };
  }

  return { t: "promptfoo: unknown command '" + sub + "' — набери help", c: 't-err' };
}

/* ------------------------------------------------------- правая панель */

function prEnv() {
  var miss = prMiss();
  var g = PR_GUARDS.map(function (x) {
    var ok = prGuard(x.id);
    return erow((ok ? '✔ ' : '✘ ') + x.label, ok ? 'есть' : 'ПОТЕРЯНО',
                ok ? 'var(--tr-ok)' : 'var(--tr-err)');
  }).join('');

  var f = PR.repo['prompts/support.txt'];
  var files = envBlock('ФАЙЛЫ',
    erow('в репозитории', prFiles().length + ' шт.', 'var(--tr-accent)') +
    erow('строк в support.txt', f === undefined ? '—' : prLines(f).length) +
    erow('символов промпта', f === undefined ? '—' : f.length) +
    erow('≈ токенов промпта', f === undefined ? '—' : prNum(prTok(f)) +
         ' · $' + ((prTok(f) / 1e6) * 0.15).toFixed(6), 'var(--tr-dim)') +
    erow('версия промпта', 'v' + prVerNo(), 'var(--tr-accent2)'));

  var guard = envBlock('ТРЕБОВАНИЯ ПРОМПТА' + (miss.length ? ' · ' + miss.length + ' нарушено' : ''), g);

  var r = PR.run;
  var run = r
    ? envBlock('ПОСЛЕДНИЙ EVAL',
        erow('pass rate', r.pct + '%', r.pct === 100 ? 'var(--tr-ok)' : r.pct >= 60 ? 'var(--tr-warn)' : 'var(--tr-err)') +
        erow('тестов', r.pass + ' из ' + r.total) +
        erow('средний score', r.avg.toFixed(2)) +
        erow('токенов', prNum(r.tok), 'var(--tr-dim)') +
        erow('стоимость', '$' + r.cost.toFixed(6), 'var(--tr-orange)') +
        erow('прогон', r.ts, 'var(--tr-dim)'))
    : envBlock('ПОСЛЕДНИЙ EVAL', erow('—', 'eval ещё не запускался', 'var(--tr-dim)'));

  var head = prGitHead();
  var dirty = prFiles().filter(function (p) { return PR.repo[p] !== head.snap[p]; });
  var g2 = envBlock('GIT · branch ' + (PR.gitlog.filter(function (c2) { return c2.tag; }).map(function (c2) { return c2.tag; }).join(', ') || '—'),
    erow('коммитов', PR.gitlog.length, 'var(--tr-pink)') +
    erow('изменено файлов', String(dirty.length), dirty.length ? 'var(--tr-warn)' : 'var(--tr-ok)') +
    erow('в индексе', String(Object.keys(PR.staged).length)) +
    erow('последний', head.h + ' ' + prPad(prCut(head.msg, 18), 18), 'var(--tr-dim)'));

  var log = envBlock('ИСТОРИЯ ПРОМПТА', PR.ver.slice(-5).reverse().map(function (v) {
    return erow('v' + v.v, prCut(v.note, 26), 'var(--tr-dim)');
  }).join(''));

  var note = '<div class="text-xs leading-relaxed" style="color:var(--tr-dim)">' +
    'Команды настоящие: promptfoo, git, vi, sed, jq, cat/ls/grep, heredoc. ' +
    'Моделируется только обращение к API — ответы «модели», токены и стоимость ' +
    'считаются по тексту промпта локально.</div>';

  return note + files + guard + run + g2 + log;
}

/* ========================================================== МОДУЛИ ==== */

var PR_MODS = [
  { id: 1, n: 'Репозиторий промптов', c: 'var(--tr-accent)' },
  { id: 2, n: 'Правка промпта',       c: 'var(--tr-ok)' },
  { id: 3, n: 'Оценка promptfoo',     c: 'var(--tr-cyan)' },
  { id: 4, n: 'Регрессия качества',   c: 'var(--tr-orange)' },
  { id: 5, n: 'Версии в git',         c: 'var(--tr-accent2)' }
];

/* ========================================================= ЗАДАНИЯ ==== */

var PR_LS = [
  /* ---------------------------------------------------- модуль 1 ---- */
  {
    id: 1, m: 1, t: 'Что лежит в репозитории',
    task: 'Посмотрите содержимое рабочего каталога: какие файлы и каталоги здесь есть?',
    re: /^ls$/,
    th: 'Промпты — это обычные файлы в git-репозитории. Первое, что делает инженер: ' +
        '<code>ls</code> — посмотреть, что вообще есть. Рядом лежит конфиг оценки.',
    h: ['Просто список файлов в текущем каталоге, без аргументов.',
        'Команда ls без пути показывает содержимое текущего каталога.',
        'ls'],
    xp: 20
  },
  {
    id: 2, m: 1, t: 'Каталог промптов',
    task: 'Загляните в каталог prompts — какие промпты в репозитории?',
    re: /^ls\s+prompts\/?$/,
    th: '<code>ls prompts/</code> — каталог с самими промптами. Их несколько: оператор поддержки, ' +
        'сжатие отчётов, извлечение полей. Каждый — обычный .txt.',
    h: ['Путь к каталогу с промптами — prompts.',
        'ls и имя каталога, можно со слешем на конце.',
        'ls prompts/'],
    xp: 20
  },
  {
    id: 3, m: 1, t: 'Читаем системный промпт',
    task: 'Покажите содержимое файла prompts/support.txt — это тот самый системный промпт оператора.',
    re: /^cat\s+prompts\/support\.txt$/,
    th: 'Файл читается обычной командой <code>cat</code>. Никакого отдельного «редактора ' +
        'промптов» в Unix нет — текст лежит в файле и меняется как любой другой код.',
    h: ['cat + путь к файлу промпта.',
        'cat prompts/support.txt',
        'cat prompts/support.txt'],
    xp: 25
  },
  {
    id: 4, m: 1, t: 'Читаем набор тестов',
    task: 'Покажите конфигурацию оценки: cat promptfooconfig.yaml',
    re: /^cat\s+(-n\s+)?promptfooconfig\.yaml$/,
    th: 'В <code>promptfooconfig.yaml</code> три секции: <code>prompts</code> — что проверяем, ' +
        '<code>providers</code> — какая модель отвечает, <code>tests</code> — вопросы, контекст ' +
        'и <code>assert</code> (contains, llm-rubric). Правка промпта ломает именно эти проверки.',
    h: ['cat плюс имя конфига, без расширения не подойдёт.',
        'Файл называется promptfooconfig.yaml — так он называется по умолчанию у promptfoo.',
        'cat promptfooconfig.yaml'],
    xp: 30
  },

  /* ---------------------------------------------------- модуль 2 ---- */
{
    id: 5, m: 2, t: 'Открываем промпт в vi',
    task: 'Откройте промпт в редакторе: vi prompts/support.txt',
    re: /^vi\s+prompts\/support\.txt$/,
    th: 'Промпт правят в обычном редакторе. <code>vi prompts/support.txt</code> — открыть файл. ' +
        'Клавиши: <code>j</code>/<code>k</code> — курсор, <code>i</code> — режим вставки, ' +
        '<code>Esc</code> — выйти из вставки, <code>:wq</code> — сохранить и выйти.',
    h: ['Команда vi и путь к файлу, который вы уже читали через cat.',
        'vi prompts/support.txt',
        'vi prompts/support.txt'],
    xp: 25
  },
  {
    id: 6, m: 2, t: 'Правка и выход из vi',
    task: 'Измените текст промпта (клавиша i — вставка, затем Esc) и сохраните файл командой :wq',
    re: /^:wq$/,
    th: 'В vi правка идёт так: <code>i</code> — вставка, печатаете текст, <code>Esc</code> — ' +
        'обратно в командный режим, <code>:wq</code> — write and quit. Пока файл не сохранён, ' +
        '<code>eval</code> будет читать старую версию — это и есть источник «а я вроде поменял, ' +
        'а результат не изменился».',
    h: ['После выхода из вставки нужно записать файл и выйти.',
        'В командном режиме vi: двоеточие, w — записать, q — выйти.',
        ':wq'],
    xp: 40
  },
  {
    id: 7, m: 2, t: 'Полная перезапись одной командой',
    task: "Перепишите prompts/support.txt целиком одной командой: cat > prompts/support.txt <<< $'Ты — помощник службы поддержки. Отвечай кратко и по делу.\\nОтвечай ТОЛЬКО на основе переданного контекста.\\nЕсли в контексте нет ответа — так и скажи: «нет данных».\\nСтруктура ответа: причина → что делать → ссылка на источник.\\n\\nТон: {{tone}}\\nЯзык: {{lang}}\\n\\nКонтекст:\\n{{context}}\\n\\nВопрос: {{question}}\\n'",
    re: /^cat\s*>\s*prompts\/support\.txt\s*<<<\s*\$'[\s\S]*нет данных[\s\S]*'$/,
    th: 'Heredoc (<code>cat &gt; файл &lt;&lt;\'EOF\'</code>) требует нескольких строк: ' +
        'блок открывается, затем идёт текст, затем отдельная строка-маркер. ' +
        'В терминале, где одна команда равна одной строке, такой блок неудобен, ' +
        'поэтому для перезаписи целиком берут herestring с ANSI-C кавычками: ' +
        '<code>cat &gt; файл &lt;&lt;&lt; $\'текст\\nтекст\'</code>. ' +
        'Префикс <code>$\'</code> включает разбор escape-последовательностей, ' +
        'и <code>\\n</code> становится настоящим переводом строки. ' +
        'В обычных одинарных кавычках <code>\\n</code> остался бы буквальной буквой n.',
    h: ['cat, знак перенаправления >, путь, затем <<< и $ перед кавычками.',
        'Внутри $\'...\' переводы строк пишут как \\n — так блок помещается в одну команду.',
        "cat > prompts/support.txt <<< $'Ты — помощник службы поддержки. Отвечай кратко и по делу.\\nОтвечай ТОЛЬКО на основе переданного контекста.\\nЕсли в контексте нет ответа — так и скажи: «нет данных».\\nСтруктура ответа: причина → что делать → ссылка на источник.\\n\\nТон: {{tone}}\\nЯзык: {{lang}}\\n\\nКонтекст:\\n{{context}}\\n\\nВопрос: {{question}}\\n'"],
    xp: 45
  },
  {
    id: 8, m: 2, t: 'Проверяем, что файл изменился',
    task: 'Убедитесь, что запись прошла: cat prompts/support.txt',
    re: /^cat\s+prompts\/support\.txt$/,
    th: 'После любой записи — <code>cat</code>. Заодно пригодится <code>grep -n "нет данных" ' +
        'prompts/support.txt</code>: он сразу покажет номер строки с нужным требованием.',
    h: ['Та же команда, что и в задании 3.',
        'cat prompts/support.txt',
        'cat prompts/support.txt'],
    xp: 25
  },

  /* ---------------------------------------------------- модуль 3 ---- */
  {
    id: 9, m: 3, t: 'Первый eval',
    task: 'Прогоните оценку по конфигу: promptfoo eval -c promptfooconfig.yaml',
    re: /^promptfoo\s+eval(\s+(-c|--config)\s+promptfooconfig\.yaml)?$/,
    th: 'promptfoo читает конфиг, гоняет каждый тест через модель и проверяет ответы ' +
        'assertion-ами. Смотрите на процент в конце: 100% — можно катить, меньше — у вас ' +
        'регрессия. Обратите внимание на колонку tokens и cost: длинный промпт платной части ' +
        'не бесплатен.',
    h: ['eval плюс путь к конфигу через -c.',
        'promptfoo eval -c promptfooconfig.yaml',
        'promptfoo eval -c promptfooconfig.yaml'],
    xp: 35
  },
  {
    id: 10, m: 3, t: 'Подробности по assertion',
    task: 'Прогоните тот же eval с подробностями: promptfoo eval --verbose',
    re: /^promptfoo\s+eval\s+--verbose$/,
    th: 'Без <code>--verbose</code> вы видите только [PASS]/[FAIL]. С ним — что именно ожидалось, ' +
        'что пришло от модели и какой вердикт поставил llm-rubric. Именно эти строки ' +
        'показывают, что именно сломалось. Внимание: у <code>eval</code> короткий флаг ' +
        '<code>-v</code> занят под <code>--vars</code>, поэтому только длинная форма.',
    h: ['Длинный флаг подробного вывода у eval.',
        'promptfoo eval --verbose',
        'promptfoo eval --verbose'],
    xp: 35
  },
  {
    id: 11, m: 3, t: 'Веб-отчёт promptfoo',
    task: 'Откройте результаты в браузере: promptfoo view',
    re: /^promptfoo\s+view$/,
    th: '<code>promptfoo view</code> поднимает локальный веб-интерфейс: каждый тест, каждое ' +
        'утверждение, полный текст ответа модели, можно сравнивать прогоны между собой. ' +
        'Это то, что показывают на код-ревью вместо скриншота.',
    h: ['Команда запускает браузерный интерфейс с результатами.',
        'promptfoo view',
        'promptfoo view'],
    xp: 30
  },
  {
    id: 12, m: 3, t: 'Выгрузка результатов в JSON',
    task: 'Сохраните результаты в файл: promptfoo eval -o results.json',
    re: /^promptfoo\s+eval\s+(-o|--output)\s+results\.json$/,
    th: 'Флаг <code>-o</code> пишет результаты в файл в удобном виде. Дальше с ними работают ' +
        'обычными утилитами: <code>jq \'.results.stats\' results.json</code> — доля успешных ' +
        'проверок, <code>jq \'.results.prompts[0].metrics.cost\' results.json</code> — сколько ' +
        'потратили токенов. В CI этот файл кладут в артефакты.',
    h: ['eval плюс -o и имя json-файла.',
        'promptfoo eval -o results.json',
        'promptfoo eval -o results.json'],
    xp: 35
  },

  /* ---------------------------------------------------- модуль 4 ---- */
  {
    id: 13, m: 4, t: 'Ломаем промпт осознанно',
    task: 'Уберите из промпта требование «нет данных»: sed -i \'/нет данных/d\' prompts/support.txt',
    re: /^sed\s+-i\s+(['"])?\/[^'"]*нет данных[^'"]*\/[a-z]+\1?\s+prompts\/support\.txt$/,
    th: 'Регрессия проверяется так: убрали строку — прогнали тесты — увидели падение. ' +
        '<code>sed -i \'/нет данных/d\'</code> удаляет из файла все строки, подходящие под шаблон. ' +
        '<code>-i</code> — править на месте, без него sed только печатает. sed молчит: убедиться, ' +
        'что строка исчезла, можно через <code>grep -n "нет данных" prompts/support.txt</code> ' +
        '(пусто) или <code>cat</code>.',
    h: ['sed с -i (править на месте), шаблон в кавычках, команда /d — удалить совпавшие строки.',
        "sed -i '/нет данных/d' prompts/support.txt",
        "sed -i '/нет данных/d' prompts/support.txt"],
    xp: 45
  },
  {
    id: 14, m: 4, t: 'Видим падение точности',
    task: 'Прогоните eval на сломанном промпте: promptfoo eval -c promptfooconfig.yaml',
    re: /^promptfoo\s+eval\s+(-c|--config)\s+promptfooconfig\.yaml$/,
    th: 'Процент упал: третий тест теперь отвечает «скидка 10% по акции "Весна"» — ' +
        'модель выдумала то, чего в контексте нет, потому что промпт больше не запрещает. ' +
        'В логе <code>[FAIL] Expected output to contain: нет данных</code>. Проверки сделали ' +
        'ровно то, для чего существуют: поймали регрессию до выката.',
    h: ['Та же команда, что в задании 9, — но промпт теперь другой.',
        'promptfoo eval -c promptfooconfig.yaml',
        'promptfoo eval -c promptfooconfig.yaml'],
    xp: 40
  },
  {
    id: 15, m: 4, t: 'Чиним промпт',
    task: 'Верните требование «нет данных» в текст промпта и сохраните файл.',
    re: /^(cat\s*>\s*prompts\/support\.txt\s*<<-?\s*['"]?EOF['"]?|git\s+(checkout|restore)\s+(--\s+)?prompts\/support\.txt)$/,
    th: 'Два честных способа. Первый — <code>git restore prompts/support.txt</code> (или ' +
        '<code>git checkout -- prompts/support.txt</code>): файл возвращается к последнему ' +
        'коммиту за секунду. Второй — переписать руками через heredoc, если правка была нужна. ' +
        'Верните строку «Если в контексте нет ответа — так и скажи: «нет данных».» — можно ' +
        'скопировать её из вывода cat или из первого eval.',
    h: ['Либо вернуть файл из git, либо переписать его целиком через heredoc с маркером EOF.',
        "git restore prompts/support.txt   —   короче и надёжнее, чем переписывать руками",
        "git restore prompts/support.txt"],
    xp: 45
  },
  {
    id: 16, m: 4, t: 'Проверяем, что починили',
    task: 'Прогоните eval ещё раз, уже без флага -c: promptfoo eval',
    re: /^promptfoo\s+eval$/,
    th: 'Без <code>-c</code> promptfoo сам берёт promptfooconfig.yaml из текущего каталога — ' +
        'так короче, и это работает в CI. Процент должен вернуться к 100%: тот же набор тестов, ' +
        'тот же провайдер, другой текст промпта. Именно этот замкнутый круг ' +
        '«изменил — прогнал — убедился» и есть работа с промптами.',
    h: ['Конфиг лежит в текущем каталоге, путь указывать не обязательно.',
        'promptfoo eval',
        'promptfoo eval'],
    xp: 40
  },

  /* ---------------------------------------------------- модуль 5 ---- */
  {
    id: 17, m: 5, t: 'Что изменилось',
    task: 'Посмотрите состояние репозитория: git status',
    re: /^git\s+status$/,
    th: 'Правка промпта — это изменение в репозитории, и его видно как изменённый файл. ' +
        '<code>git status</code> скажет <code>modified: prompts/support.txt</code>. Пустая строка ' +
        'внизу — <code>nothing to commit, working tree clean</code>: дерево чистое, коммитить нечего.',
    h: ['Команда, которая показывает, что изменилось в рабочем дереве.',
        'git status',
        'git status'],
    xp: 25
  },
  {
    id: 18, m: 5, t: 'Смотрим сам диф',
    task: 'Покажите разницу между рабочей копией и последним коммитом: git diff',
    re: /^git\s+diff$/,
    th: '<code>git diff</code> — единственный способ честно убедиться, что именно вы изменили. ' +
        'Строками + и -. Прежде чем катить правку промпта, этот диф читают на ревью. ' +
        'После <code>git add</code> то же самое покажет <code>git diff --staged</code>.',
    h: ['Показывает unstaged-изменения относительно HEAD.',
        'git diff',
        'git diff'],
    xp: 30
  },
  {
    id: 19, m: 5, t: 'Кладём в индекс',
    task: 'Добавьте изменённый промпт в индекс: git add prompts/',
    re: /^git\s+add\s+(prompts\/|\.|-A)$/,
    th: '<code>git add</code> ничего не печатает — это нормально. Проверить результат можно ' +
        'только через <code>git status</code>: файл переедет в секцию «Changes to be committed». ' +
        'Каталог можно добавить целиком: <code>git add prompts/</code>.',
    h: ['После git add вывод пустой — так и должно быть.',
        'git add prompts/',
        'git add prompts/'],
    xp: 30
  },
  {
    id: 20, m: 5, t: 'Коммит с описанием',
    task: 'Зафиксируйте правку: git commit -m "support: вернули требование «нет данных»"',
    re: /^git\s+commit\s+(-[am]\s+)*-m\s+("|')[\s\S]*\2$/,
    th: 'Сообщение коммита — это документация к промпту: через полгода по нему поймут, ' +
        'зачем меняли формулировку. Дальше по цепочке доступны <code>git log --oneline</code> ' +
        '(история), <code>git show</code> (что именно было в этом коммите) и ' +
        '<code>git tag v1.0</code> — зафиксировать рабочую версию, к которой можно откатиться. ' +
        'Пустой git commit без сообщения не пройдёт.',
    h: ['git commit, ключ -m и сообщение в двойных кавычках.',
        'git commit -m "что именно изменилось в промпте"',
        'git commit -m "support: вернули требование «нет данных»"'],
    xp: 45
  }
];

/* ============================================================ КУРС ==== */

COURSES.prompt = {
  i: '✎', n: 'ПРОМПТЫ', c: 'var(--tr-accent)',
  pr: PR_PROMPT_HOME,
  ti: 'promptfoo + git — prompt eval',
  note: 'Команды настоящие: promptfoo, git, vi, sed, jq, cat/ls/grep, herestring и heredoc — ' +
        'всё это работает в живом терминале. Heredoc многострочный: если открыли блок, ' +
        'закройте его строкой-маркером или нажмите Ctrl+C, чтобы прервать. ' +
        'Моделируется только обращение к API: ответы «модели» и ' +
        'счётчик токенов считаются по тексту промпта, а не уходят в сеть.',
  mods: PR_MODS, ls: PR_LS,
  run: function (raw) {
    var r = null;
    try { r = prRun(raw); } catch (e) {
      r = { t: 'bash: внутренняя ошибка обработки команды: ' + (e && e.message ? e.message : e), c: 't-err' };
    }
    if (typeof renderEnv === 'function') { try { renderEnv(); } catch (e2) {} }
    return r;
  },
  ctrlc: function () {
    if (!PR.hd) return false;
    out('^C', 't-cmd');
    out('(прервано: heredoc не закрыт строкой ' + PR.hd.marker + ', файл не изменён)', 't-dim');
    PR.hd = null; PR.hdLines = [];
    COURSES.prompt.pr = PR_PROMPT_HOME;
    if (typeof renderEnv === 'function') { try { renderEnv(); } catch (e3) {} }
    return true;
  },
  reset: function () {
    PR.reset();
  },
  env: function () { return prEnv(); }
};

PR.reset();

/* Движок рисует правую панель по списку курсов, которых в нём не знает,
   и для нового курса оставляет её пустой. Поэтому подменяем отрисовку:
   для остальных курсов поведение не меняется, для «ПРОМПТОВ» рисуем env(). */
(function () {
  if (typeof renderEnv !== 'function') return;
  var orig = renderEnv;
  if (orig.__promptPatched) return;
  var wrapped = function () {
    orig.apply(null, arguments);
    try {
      if (typeof course !== 'undefined' && course === 'prompt' && COURSES.prompt) {
        $('genB').innerHTML = COURSES.prompt.env();
      }
    } catch (e) {}
  };
  wrapped.__promptPatched = true;
  renderEnv = wrapped;
})();