/* ==========================================================================
   Курс «MLFLOW · ЛАНГФЮЗ»
   Месяц 3 плана: пайплайны MLOps и наблюдаемость LLM-систем.

   Команды настоящие: mlflow (CLI), curl (API Prometheus и Langfuse),
   docker compose, jq, sha256sum, python. Ничего выдуманного.
   ========================================================================== */

var MO_PROMPT = 'mlops@ai-lab:~$';

/* ------------------------------------------------------- исходные данные */

function moRuns() {
  return [
    { exp: 1, id: 'a1b2c3d4', run: 'run-0001', loss: 0.62, acc: 0.81, epochs: 3,  lr: 0.01,  status: 'FINISHED', dur: '00:02:41' },
    { exp: 1, id: 'b2c3d4e5', run: 'run-0002', loss: 0.48, acc: 0.87, epochs: 5,  lr: 0.01,  status: 'FINISHED', dur: '00:04:12' },
    { exp: 1, id: 'c3d4e5f6', run: 'run-0003', loss: 0.41, acc: 0.90, epochs: 8,  lr: 0.01,  status: 'FINISHED', dur: '00:06:58' },
    { exp: 1, id: 'd4e5f6a7', run: 'run-0004', loss: 0.44, acc: 0.89, epochs: 8,  lr: 0.05,  status: 'FINISHED', dur: '00:07:03' }
  ];
}

function moTraces() {
  return [
    { id: 'tr-9f21', name: 'support-answer', model: 'gpt-4o-mini', lat: 812,  tok: 1420, pii: 0, user: 'T-1041' },
    { id: 'tr-9f22', name: 'support-answer', model: 'gpt-4o-mini', lat: 640,  tok: 1180, pii: 0, user: 'T-1042' },
    { id: 'tr-9f23', name: 'rag-retrieve',  model: 'bge-small',   lat: 96,   tok: 210,  pii: 0, user: 'T-1041' },
    { id: 'tr-9f24', name: 'support-answer', model: 'gpt-4o-mini', lat: 2380, tok: 3160, pii: 1, user: 'T-1043' }
  ];
}

/* -------------------------------------------------------------- состояние */

var MO = {
  stack: false,
  runs: [],
  traces: [],
  served: null,
  alert: false,
  expId: 1,

  reset: function () {
    this.stack = false;
    this.runs = moRuns();
    this.traces = moTraces();
    this.served = null;
    this.alert = false;
  },

  best: function () {
    return this.runs.reduce(function (a, b) { return b.loss < a.loss ? b : a; });
  },
  piiTraces: function () { return this.traces.filter(function (t) { return t.pii; }); },

  env: function () {
    return envBlock('СТЕНД',
        erow('docker compose', this.stack ? 'поднят' : 'не запущен', this.stack ? 'var(--tr-ok)' : 'var(--tr-err)') +
        erow('mlflow ui', this.stack ? ':5000' : '—') +
        erow('langfuse', this.stack ? ':3000' : '—') +
        erow('prometheus', this.stack ? ':9090' : '—'))
      + envBlock('ПРОГОНЫ',
        erow('всего', this.runs.length) +
        erow('лучший loss', this.best().loss.toFixed(2), 'var(--tr-ok)') +
        erow('лучший run', this.best().run))
      + envBlock('ТРАССЫ',
        erow('всего', this.traces.length) +
        erow('с ПДн', this.piiTraces().length, this.piiTraces().length ? 'var(--tr-err)' : 'var(--tr-ok)') +
        erow('медиана lat', this.medianLat() + ' мс'));
  },

  medianLat: function () {
    if (!this.traces.length) return 0;
    var v = this.traces.map(function (t) { return t.lat; }).sort(function (a, b) { return a - b; });
    return v[Math.floor(v.length / 2)];
  },

  run: function (raw) { return moRun(raw); }
};

function moMlflowRunId(id) { return id; }

function moRunDir(r) { return 'mlruns/' + r.exp + '/' + r.id; }

/* =========================================================== обработчик == */

function moRun(raw) {
  var t = raw.trim();
  if (!t) return null;

  /* --------------------------------------------------------------- help */
  if (/^(help|\?|--help)$/.test(t)) {
    return {
      t: '─── ' + COURSES.mlops.i + ' MLFLOW · ЛАНГФЮЗ · команды ───\n\n' +
         '  docker compose up -d                 поднять стенд\n' +
         '  python train.py --lr <x> --epochs <n>  обучение с логированием в MLflow\n' +
         '  mlflow experiments search             список экспериментов\n' +
         '  mlflow runs list --experiment-id <n>  прогоны эксперимента\n' +
         '  mlflow runs describe --run-id <id>   подробности прогона\n' +
         '  mlflow runs search --filter …        поиск по метрикам\n' +
         '  mlflow models list                   реестр моделей\n' +
         '  mlflow models serve -m models:/<имя>/<вер> -p 5000\n' +
         '  jq \'<путь>\' <файл.json>              разбор JSON\n' +
         '  sha256sum <файл>                     контрольная сумма артефакта\n' +
         '  curl \'<url>\'                         HTTP к Prometheus и Langfuse\n\n' +
         '  help — эта справка · Ctrl+L — очистка · ↑/↓ — история',
      c: 't-tbl'
    };
  }

  /* ==================================================== модуль 1: стенд */

  if (/^docker\s+compose\s+up\s+-d$/.test(t)) {
    if (MO.stack) return { t: 'Стенд уже поднят, повторно ничего не делаем.', c: 't-dim' };
    MO.stack = true;
    return {
      t: ' Creating network "ai-lab_default" \n' +
         ' Container ai-lab-mlflow   Created\n' +
         ' Container ai-lab-langfuse Created\n' +
         ' Container ai-lab-prom     Created\n' +
         ' Container ai-lab-grafana  Created\n' +
         ' Network ai-lab_default   Created\n' +
         ' ✔ Контейнеры запущены\n\n' +
         '  mlflow   http://localhost:5000\n' +
         '  langfuse http://localhost:3000\n' +
         '  prom     http://localhost:9090\n' +
         '  grafana  http://localhost:3001',
      c: 't-ok'
    };
  }

  if (/^python\s+train\.py\s+--lr\s+[\d.]+\s+--epochs\s+\d+$/.test(t)) {
    if (!MO.stack) {
      return {
        t: 'Traceback (most recent call last):\n' +
           '  File "train.py", line 12, in <module>\n' +
           '    mlflow.set_tracking_uri("http://localhost:5000")\n' +
           'ConnectionError: HTTPConnectionPool(host=\'localhost\', port=5000):\n' +
           '  Max retries exceeded — MLflow Tracking не отвечает.\n' +
           '\nСначала поднимите стенд: docker compose up -d',
        c: 't-err'
      };
    }
    var m = t.match(/--lr\s+([\d.]+)\s+--epochs\s+(\d+)/);
    var lr = parseFloat(m[1]), ep = parseInt(m[2], 10);
    var last = MO.runs[MO.runs.length - 1];
    var loss = Math.max(0.12, last.loss - 0.03 + lr * 0.9);
    var acc = Math.min(0.97, last.acc + 0.01 - lr * 0.2);
    var id = ('0' + (MO.runs.length + 1)).slice(-1);
    var nid = 'e5f6a7b' + id;
    MO.runs.push({ exp: 1, id: nid, run: 'run-000' + (MO.runs.length + 1), loss: loss,
                   acc: acc, epochs: ep, lr: lr, status: 'FINISHED', dur: '00:07:12' });
    return {
      t: 'Epoch ' + (1) + '/' + ep + '  step 40/400  loss 0.68  acc 0.79\n' +
         'Epoch ' + ep + '/' + ep + '  step 400/400  loss ' + loss.toFixed(3) + '  acc ' + acc.toFixed(3) + '\n' +
         'Logged ' + MO.runs[MO.runs.length - 1].id + ' to experiment 1 (Default)\n' +
         'Artifacts: model/weights.bin  (18.4 MB), model/config.json\n' +
         '\n(!) lr=' + lr.toFixed(2) + ' при прочих равных даёт loss хуже, чем меньший шаг.\n' +
         '    Рекомендуется искать прогон через mlflow runs search, а не на глаз.',
      c: 't-ok'
    };
  }

  if (/^ls\s+mlruns\/$/.test(t)) {
    if (!MO.stack) return { t: "ls: невозможно открыть каталог 'mlruns/': Нет такого файла или каталога", c: 't-err' };
    var dirs = {};
    MO.runs.forEach(function (r) { dirs[r.exp + '/' + r.id] = r; });
    var rows = Object.keys(dirs).map(function (k) { return 'drwxr-xr-x  ' + k + '/'; });
    rows.push('drwxr-xr-x  1/');
    rows.sort();
    return { t: rows.join('\n') + '\n\nКаталог на прогон, внутри — metrics/, tags/, artifacts/.', c: 't-tbl' };
  }

  /* ============================================ модуль 2: эксперименты */

  if (/^mlflow\s+experiments\s+search$/.test(t)) {
    if (!MO.stack) return { t: 'mlflow: не удалось подключиться к Tracking URI http://localhost:5000', c: 't-err' };
    return {
      t: 'Experiment Id  Name          Artifact Location                 Lifecycle Stage\n' +
         '-------------  -------------  --------------------------------  --------------\n' +
         '            1  Default       mlflow-experiments/1                active\n' +
         '            2  intent-class   mlflow-experiments/2                active\n' +
         '\nИспользуйте --experiment-id 1 для текущей задачи.',
      c: 't-tbl'
    };
  }

  if (/^mlflow\s+runs\s+list\s+--experiment-id\s+\d+$/.test(t)) {
    if (!MO.stack) return { t: 'mlflow: не удалось подключиться к Tracking URI http://localhost:5000', c: 't-err' };
    var mm = t.match(/--experiment-id\s+(\d+)/);
    var exp = parseInt(mm[1], 10);
    if (exp === 2) {
      return {
        t: 'Run Id       Run Name    Created              Status    metrics.accuracy\n' +
           '-----------  ----------  -------------------  --------  ---------------\n' +
           '7a1b2c3d     run-0007    2026-10-11 14:02:11  FINISHED  0.88\n' +
           '\nДругой эксперимент — другие прогоны. Метрики не сравниваются между собой.',
        c: 't-tbl'
      };
    }
    return {
      t: 'Run Id       Run Name    Created              Status    metrics.train_loss  metrics.accuracy\n' +
         '-----------  ----------  -------------------  --------  -----------------  ---------------\n' +
         MO.runs.map(function (r) {
           return r.id.padEnd(12) + r.run.padEnd(11) + '2026-10-1' + (MO.runs.indexOf(r) + 2) +
                  ' 0' + (MO.runs.indexOf(r) + 1) + ':1' + (MO.runs.indexOf(r) + 3) + '  ' +
                  r.status.padEnd(9) + r.loss.toFixed(3).padStart(18) + r.acc.toFixed(2).padStart(18);
         }).join('\n'),
      c: 't-tbl'
    };
  }

  if (/^mlflow\s+runs\s+describe\s+--run-id\s+[0-9a-f]{8}$/.test(t)) {
    if (!MO.stack) return { t: 'mlflow: не удалось подключиться к Tracking URI http://localhost:5000', c: 't-err' };
    var im = t.match(/--run-id\s+([0-9a-f]{8})/);
    var rec = MO.runs.filter(function (r) { return r.id === im[1]; })[0];
    if (!rec) return { t: 'mlflow: Run with id=' + im[1] + ' not found', c: 't-err' };
    return {
      t: 'Run Id:       ' + rec.id + '\n' +
         'Run Name:     ' + rec.run + '\n' +
         'Experiment:   1 (Default)\n' +
         'Status:       ' + rec.status + '\n' +
         'Duration:     ' + rec.dur + '\n' +
         'User:         mlops\n\n' +
         'Parameters:\n' +
         '  epochs: ' + rec.epochs + '\n' +
         '  lr: ' + rec.lr + '\n\n' +
         'Metrics:\n' +
         '  train_loss: ' + rec.loss.toFixed(4) + '\n' +
         '  accuracy: ' + rec.acc.toFixed(4) + '\n\n' +
         'Artifacts:\n' +
         '  model/weights.bin\n' +
         '  model/config.json',
      c: 't-tbl'
    };
  }

  /* ========================================== модуль 3: поиск и артефакты */

  if (/^mlflow\s+runs\s+search\s+--filter\s+"metrics\.train_loss\s*<\s*[\d.]+"\s+--order_by\s+"metrics\.train_loss\s+ASC"$/.test(t)) {
    if (!MO.stack) return { t: 'mlflow: не удалось подключиться к Tracking URI http://localhost:5000', c: 't-err' };
    var fv = parseFloat(t.match(/<\s*([\d.]+)"/)[1]);
    var found = MO.runs.filter(function (r) { return r.loss < fv; })
      .sort(function (a, b) { return a.loss - b.loss; });
    if (!found.length) {
      return { t: 'Ни один прогон не проходит фильтр metrics.train_loss < ' + fv + '.', c: 't-err' };
    }
    return {
      t: found.map(function (r) {
        return r.id.padEnd(12) + r.run.padEnd(11) + 'loss ' + r.loss.toFixed(3) + '  acc ' + r.acc.toFixed(2);
      }).join('\n') +
        '\n\nЛучший: ' + found[0].id + ' (loss ' + found[0].loss.toFixed(3) + ').\n' +
        'Порог ' + fv + ' — это ваш контракт качества. Не прошёл — не катим.',
      c: 't-tbl'
    };
  }

  if (/^mlflow\s+models\s+list$/.test(t)) {
    if (!MO.stack) return { t: 'mlflow: не удалось подключиться к Tracking URI http://localhost:5000', c: 't-err' };
    return {
      t: 'Name           Version   Created                          Description\n' +
         '-------------  -------  -------------------------------  ---------------------------\n' +
         'intent-class   1        2026-10-11 14:02:11 +0300        baseline, acc 0.88\n' +
         'intent-class   2        2026-10-13 10:41:55 +0300        +ручная правка порога\n' +
         '\nВерсии в реестре — это то, что можно откатить. Эксперимент — нет.',
      c: 't-tbl'
    };
  }

  if (/^sha256sum\s+mlruns\/1\/[0-9a-f]{8}\/artifacts\/model\/weights\.bin$/.test(t)) {
    if (!MO.stack) return { t: "sha256sum: mlruns/1/.../weights.bin: Нет такого файла или каталога", c: 't-err' };
    var rm = t.match(/mlruns\/1\/([0-9a-f]{8})/);
    var rr = MO.runs.filter(function (x) { return x.id === rm[1]; })[0];
    if (!rr) return { t: 'sha256sum: mlruns/1/' + rm[1] + '/artifacts/model/weights.bin: Нет такого файла или каталога', c: 't-err' };
    return {
      t: rr.id.slice(0, 4) + 'f7a2b8c4d6e1f0a3b5c8d2e6f9a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6e9f2  mlruns/1/' + rr.id + '/artifacts/model/weights.bin',
      c: 't-tbl'
    };
  }

  /* ========================================== модуль 4: трассировка LLM */

  if (/^curl\s+-s\s+'http:\/\/localhost:3000\/api\/public\/traces'\s+-\H\s+'Authorization:\s+Basic[^']*'$/.test(t)) {
    if (!MO.stack) return { t: 'curl: (7) Failed to connect to localhost port 3000: Connection refused', c: 't-err' };
    return {
      t: MO.traces.map(function (x) {
        return x.id.padEnd(9) + x.name.padEnd(16) + x.model.padEnd(13) + 'lat ' + String(x.lat).padStart(5) + ' мс  tok ' + String(x.tok).padStart(5);
      }).join('\n') +
        '\n\n4 трассы. Обратите внимание на tr-9f24: 2380 мс и 3160 токенов —\n' +
        'внезапный рост втрое против соседей. Это и есть повод смотреть трессы,\n' +
        'а не только счётчики ошибок.',
      c: 't-tbl'
    };
  }

  if (/^curl\s+-s\s+'http:\/\/localhost:3000\/api\/public\/traces'\s+\|\s*jq\s+'\.\[\]\.data\[\]\.name'\s*$/.test(t)) {
    if (!MO.stack) return { t: 'curl: (7) Failed to connect to localhost port 3000: Connection refused', c: 't-err' };
    var names = {};
    MO.traces.forEach(function (x) { names[x.name] = (names[x.name] || 0) + 1; });
    return {
      t: Object.keys(names).sort().map(function (n) { return n + '\n' + '  × ' + names[n]; }).join('\n') +
        '\n\nДва разных шага в одном запросе. Агент — это цепочка шагов,\n' +
        'и «медленно» почти всегда означает «один из шагов».',
      c: 't-tbl'
    };
  }

  if (/^curl\s+-s\s+'http:\/\/localhost:3000\/api\/public\/traces'\s+-H\s+'Authorization:\s+Basic\s+\S+'\s*\|\s*jq\s+'\.data\[\]\s*\|\s*select\(\.input\s*\|\s*test\("\\d\{3\}-\\d\{2\}-\\d\{2\}"\)\)'$/.test(t)) {
    if (!MO.stack) return { t: 'curl: (7) Failed to connect to localhost port 3000: Connection refused', c: 't-err' };
    if (!MO.piiTraces().length) return { t: '[]\n\nПДн в трассах не найдено.', c: 't-ok' };
    return {
      t: MO.piiTraces().map(function (x) {
        return '  trace_id: ' + x.id + '\n' +
               '    user_id: ' + x.user + '\n' +
               '    input:   "... документ 450-123-45-67, подскажите маршрут ..."';
      }).join('\n') +
        '\n\n(!) В трассе лежит номер документа. Langfuse шлёт это в свой бэкенд,\n' +
        '    вы — в свой. Маскировать надо ДО отправки, а не на чтении.',
      c: 't-err'
    };
  }

  /* ============================================ модуль 5: метрики и алерты */

  if (/^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=[a-z0-9_]+'$/.test(t)) {
    if (!MO.stack) return { t: 'curl: (7) Failed to connect to localhost port 9090: Connection refused', c: 't-err' };
    var qm = t.match(/query=([a-z0-9_]+)/);
    var q = qm[1];
    var data = {
      llm_hallucination_rate: { v: '0.07', note: 'доля ответов без опоры на контекст за час' },
      llm_p95_latency_seconds: { v: '2.38', note: '95-й перцентиль задержки' },
      llm_tokens_total: { v: '547300', note: 'токенов израсходовано за час' },
      llm_cost_usd_total: { v: '1.42', note: 'расход за час' }
    };
    if (!data[q]) return { t: 'curl: (22) The requested URL returned error: 400 — unknown metric "' + q + '"', c: 't-err' };
    return {
      t: '{\n' +
         '  "status": "success",\n' +
         '  "data": {\n' +
         '    "resultType": "vector",\n' +
         '    "result": [\n' +
         '      {\n' +
         '        "metric": { "__name__": "' + q + '", "job": "llm-api" },\n' +
         '        "value": [ 1790313600.000, "' + data[q].v + '" ]\n' +
         '      }\n' +
         '    ]\n' +
         '  }\n' +
         '}\n\n' + data[q].note,
      c: 't-tbl'
    };
  }

  if (/^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=[a-z0-9_]+'\s+\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/.test(t)) {
    if (!MO.stack) return { t: 'curl: (7) Failed to connect to localhost port 9090: Connection refused', c: 't-err' };
    var q2 = t.match(/query=([a-z0-9_]+)/)[1];
    var vals = {
      llm_hallucination_rate: '0.07', llm_p95_latency_seconds: '2.38',
      llm_tokens_total: '547300', llm_cost_usd_total: '1.42'
    };
    return {
      t: vals[q2] + '\n\nТак метрика попадает в скрипт проверки: одна строка —\n' +
         'одно значение, с которым можно сравнить в шелле.',
      c: 't-tbl'
    };
  }

  if (/^curl\s+-s\s+-X\s+POST\s+'http:\/\/localhost:9090\/api\/v1\/rules'$/.test(t)) {
    if (!MO.stack) return { t: 'curl: (7) Failed to connect to localhost port 9090: Connection refused', c: 't-err' };
    if (MO.alert) return { t: 'curl: (7) Failed to connect to localhost port 9090: Connection refused', c: 't-dim' };
    MO.alert = true;
    return {
      t: 'success\n' +
        '\nПравило hallucination-high создано: галлюцинации > 0.10\n' +
        '    for 10m → алерт в Alertmanager → дежурный инженер.\n' +
        '\n(!) Порог взят выше текущих 0.07 намеренно: при 0.07 система\n' +
        '    работает, но сигнал должен срабатывать ДО того, как клиент\n' +
        '    заметит. Порог = сегодняшнее × 1,5.',
      c: 't-ok'
    };
  }

  if (/^mlflow\s+models\s+serve\s+-m\s+models:\/[a-z-]+\/\d+\s+-p\s+5001$/.test(t)) {
    if (!MO.stack) return { t: 'mlflow: не удалось подключиться к Tracking URI http://localhost:5000', c: 't-err' };
    if (MO.served) return { t: 'Модель уже обслуживается на порту ' + MO.served + '.', c: 't-dim' };
    var vm = t.match(/models:\/[a-z-]+\/(\d+)\s+-p\s+(\d+)/);
    MO.served = parseInt(vm[2], 10);
    return {
      t: 'Serving model "intent-class" version ' + vm[1] + ' on http://0.0.0.0:' + vm[2] + '\n' +
         'Press Ctrl+C to quit\n' +
         '\nМодель поднята как обычное HTTP-приложение: любой клиент\n' +
         'с умеющим POST /invocations работает одинаково.',
      c: 't-ok'
    };
  }

  /* ---------------------------------------------------------- неизвестное */
  return {
    t: 'bash: ' + t.split(' ')[0] + ': команда не найдена\n' +
       'В этом курсе: docker compose, python, mlflow, jq, sha256sum, curl, ls.\n' +
       'Полный список — help.',
    c: 't-err'
  };
}

/* ============================================================ МОДУЛИ/ЗАДАНИЯ */

var MO_MODS = [
  { id: 1, n: 'Стенд и обучение', c: 'var(--tr-cyan)' },
  { id: 2, n: 'Эксперименты и прогоны', c: 'var(--tr-accent)' },
  { id: 3, n: 'Поиск и артефакты', c: 'var(--tr-accent2)' },
  { id: 4, n: 'Трассировка LLM', c: 'var(--tr-orange)' },
  { id: 5, n: 'Метрики и алерты', c: 'var(--tr-red)' }
];

var MO_LS = [
  /* ---------------------------------------------------------- модуль 1 */
  {
    id: 1, m: 1, t: 'Поднимаем стенд',
    task: 'Запустите MLflow, Langfuse, Prometheus и Grafana: docker compose up -d',
    re: /^docker\s+compose\s+up\s+-d$/,
    th: 'MLOps начинается не с кода, а с сервисов: Tracking Server хранит ' +
        'прогоны, реестр моделей и артефакты. Langfuse — трейсы, ' +
        'Prometheus — метрики, Grafana — дашборды. Всё это поднимается ' +
        'одним файлом и живёт в docker compose. Пока стенд не поднят, ' +
        'обучение упадёт на попытке подключиться к Tracking URI.',
    h: ['Нужен docker compose с файлом docker-compose.yml.',
        'Флаг -d — отсоединить, работает в фоне.',
        'docker compose up -d'],
    xp: 25
  },
  {
    id: 2, m: 1, t: 'Обучаем с логированием',
    task: 'Запустите обучение: python train.py --lr 0.01 --epochs 5',
    re: /^python\s+train\.py\s+--lr\s+0\.01\s+--epochs\s+5$/,
    th: 'Скрипт обучения сам пишет в MLflow: параметры, метрики по каждому ' +
        'шагу и артефакты. Поэтому прогоны сравнимы между собой. Без ' +
        'этого каждый запуск — чёрный ящик: «вроде стало лучше, но чем ' +
        'докажешь». Длинные флаги читаются лучше, чем однобуквенные, ' +
        'и потом появляются в описании прогона как есть.',
    h: ['Скрипт называется train.py, параметры — длинными флагами.',
        'Сначала lr со значением, потом epochs.',
        'python train.py --lr 0.01 --epochs 5'],
    xp: 40
  },
  {
    id: 3, m: 1, t: 'Что осталось на диске',
    task: 'Посмотрите структуру хранилища: ls mlruns/',
    re: /^ls\s+mlruns\/$/,
    th: 'MLflow хранит каждый прогон обычным каталогом на диске: ' +
        '<code>mlruns/&lt;experiment_id&gt;/&lt;run_id&gt;/</code>, внутри ' +
        '<code>metrics/</code>, <code>tags/</code>, <code>artifacts/</code>. ' +
        'Это обычные файлы — их можно смотреть, копировать, шифровать и ' +
        'отправлять в git. Именно поэтому MLflow работает без ' +
        'отдельной базы.',
    h: ['Каталог создаётся в текущей директории после первого прогона.',
        'Внутри — подкаталоги по экспериментам и прогонам.',
        'ls mlruns/'],
    xp: 25
  },

  /* ---------------------------------------------------------- модуль 2 */
  {
    id: 4, m: 2, t: 'Какие есть эксперименты',
    task: 'Получите список экспериментов: mlflow experiments search',
    re: /^mlflow\s+experiments\s+search$/,
    th: 'Эксперимент — папка с общей целью: «подобрать классификатор ' +
        'интентов» или «подобрать порог для отказа». Метрики сравнимы ' +
        'только внутри одного эксперимента. Смешивать их в одну ' +
        'таблицу — классическая ошибка, из-за которой «лучшая» модель ' +
        'оказывается лучше лишь потому, что мерилась на других данных.',
    h: ['Подкоманда experiments, действие search.',
        'CLI mlflow, без флагов достаточно.',
        'mlflow experiments search'],
    xp: 30
  },
  {
    id: 5, m: 2, t: 'Прогоны эксперимента',
    task: 'Покажите прогоны эксперимента 1: mlflow runs list --experiment-id 1',
    re: /^mlflow\s+runs\s+list\s+--experiment-id\s+1$/,
    th: 'Команда печатает таблицу: идентификатор прогона, параметры и ' +
        'ключевые метрики. Обратите внимание на колонку ' +
        '<code>metrics.train_loss</code> — чем она ниже, тем лучше ' +
        'модель на этом наборе. Идентификатор прогона понадобится ' +
        'дальше: по нему достают подробности.',
    h: ['Подкоманда runs, действие list.',
        'Нужен флаг --experiment-id и номер эксперимента.',
        'mlflow runs list --experiment-id 1'],
    xp: 35
  },
  {
    id: 6, m: 2, t: 'Подробности прогона',
    task: 'Опишите прогон c3d4e5f6: mlflow runs describe --run-id c3d4e5f6',
    re: /^mlflow\s+runs\s+describe\s+--run-id\s+c3d4e5f6$/,
    th: 'Таблица из предыдущего задания показывает метрики, но не ' +
        'показывает параметры и артефакты. <code>mlflow runs describe</code> ' +
        'разворачивает прогон целиком: что запускали, с какими ' +
        'параметрами, что получилось и какие файлы остались. Именно этот ' +
        'снимок потом кладётся в карточку релиза.',
    h: ['Действие describe у подкоманды runs.',
        'Флаг --run-id и восемь символов идентификатора.',
        'mlflow runs describe --run-id c3d4e5f6'],
    xp: 40
  },

  /* ---------------------------------------------------------- модуль 3 */
  {
    id: 7, m: 3, t: 'Ищем прогон под контракт',
    task: 'Найдите прогоны с loss меньше 0.45: mlflow runs search --filter "metrics.train_loss < 0.45" --order_by "metrics.train_loss ASC"',
    re: /^mlflow\s+runs\s+search\s+--filter\s+"metrics\.train_loss\s*<\s*0\.45"\s+--order_by\s+"metrics\.train_loss\s+ASC"$/,
    th: 'Глазами по таблице выбирать нельзя: в проде их тысячи. ' +
        '<code>--filter</code> — это язык поиска по метрикам и параметрам, ' +
        'почти как в SQL: <code>metrics.train_loss &lt; 0.45</code>. ' +
        '<code>--order_by</code> сортирует результат. Так порог ' +
        'качества превращается из «посмотрим глазами» в проверку, ' +
        'которую можно запустить в CI и получить ноль или список.',
    h: ['Действие search, а не list — умеет фильтровать.',
        'Фильтр пишут в двойных кавычках, поле — metrics.train_loss.',
        'mlflow runs search --filter "metrics.train_loss < 0.45" --order_by "metrics.train_loss ASC"'],
    xp: 50
  },
  {
    id: 8, m: 3, t: 'Что в реестре моделей',
    task: 'Покажите зарегистрированные модели: mlflow models list',
    re: /^mlflow\s+models\s+list$/,
    th: 'Эксперимент — это черновик, реестр — это то, что можно ' +
        'использовать. Версия в реестре неизменяема: откат — это указать ' +
        'предыдущий номер, а не искать заново. Поэтому в реестр попадает ' +
        'только то, что прошло контракт качества. Именно поэтому ' +
        '«задеплоили и сломалось» обычно означает «задеплоили не из реестра».',
    h: ['Подкоманда models, действие list.',
        'Никаких флагов не нужно.',
        'mlflow models list'],
    xp: 35
  },
  {
    id: 9, m: 3, t: 'Хеш весов модели',
    task: 'Посчитайте контрольную сумму артефакта: sha256sum mlruns/1/c3d4e5f6/artifacts/model/weights.bin',
    re: /^sha256sum\s+mlruns\/1\/c3d4e5f6\/artifacts\/model\/weights\.bin$/,
    th: 'Веса модели — такой же артефакт, как бинарник сборки. Их тоже ' +
        'нужно проверять: файл мог переписаться, мог подмениться при ' +
        'копировании. Хеш отвечает на вопрос «те ли это веса, что ' +
        'мы аттестовали». Если хеш разошёлся — артефакт трогать нельзя, ' +
        'как и любой другой файл в репозитории.',
    h: ['Путь к артефакту внутри каталога прогона.',
        'Сначала mlruns, потом номер эксперимента, потом run id.',
        'sha256sum mlruns/1/c3d4e5f6/artifacts/model/weights.bin'],
    xp: 35
  },

  /* ---------------------------------------------------------- модуль 4 */
  {
    id: 10, m: 4, t: 'Смотрим трассы',
    task: 'Заберите трассы из Langfuse: curl -s \'http://localhost:3000/api/public/traces\' -H \'Authorization: Basic c2VjcmV0\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:3000\/api\/public\/traces'\s+-H\s+'Authorization:\s+Basic\s+\S+'$/,
    th: 'Метрики показывают «много», логи — «ошиблось». Трасса показывает ' +
        '<em>почему</em>. Langfuse хранит каждый вызов: имя операции, ' +
        'модель, задержку, токены, вход и выход. Доступ идёт через ' +
        'публичный API с basic-аутентификацией, где логин — публичный ' +
        'ключ, а пароль — секретный. Именно поэтому оба ключа хранят ' +
        'в секретах, а не в коде.',
    h: ['Это обычный REST-запрос к порту 3000.',
        'Путь /api/public/traces, заголовок Authorization: Basic <ключи>.',
        "curl -s 'http://localhost:3000/api/public/traces' -H 'Authorization: Basic c2VjcmV0'"],
    xp: 40
  },
  {
    id: 11, m: 4, t: 'Разбираем трассы по шагам',
    task: 'Соберите имена операций: curl -s \'http://localhost:3000/api/public/traces\' | jq \'.[].data[].name\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:3000\/api\/public\/traces'\s*\|\s*jq\s+'\.\[\]\.data\[\]\.name'$/,
    th: 'Один запрос пользователя — это цепочка операций: сначала ' +
        'поиск по базе знаний, потом генерация ответа. Если смотреть ' +
        'только на «ответ», потеряется и вклад поиска. <code>jq</code> ' +
        'разворачивает вложенный JSON и показывает имена операций, ' +
        'по которым сразу видно структуру запроса.',
    h: ['Тот же curl, что в прошлом задании, но без заголовка — попробуйте.',
        'JSON двухуровневый: массив, в каждом поле data, в data массив.',
        "curl -s 'http://localhost:3000/api/public/traces' | jq '.[].data[].name'"],
    xp: 45
  },
  {
    id: 12, m: 4, t: 'Ищем ПДн в трассах',
    task: 'Найдите трассы с номером документа: curl -s \'http://localhost:3000/api/public/traces\' -H \'Authorization: Basic c2VjcmV0\' | jq \'.data[] | select(.input | test("\\d{3}-\\d{2}-\\d{2}"))\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:3000\/api\/public\/traces'\s+-H\s+'Authorization:\s+Basic\s+\S+'\s*\|\s*jq\s+'\.data\[\]\s*\|\s*select\(\.input\s*\|\s*test\("\\d\{3\}-\\d\{2\}-\\d\{2\}"\)\)'$/,
    th: 'Трейсинг без маскирования — это утечка, просто отложенная. ' +
        'Всё, что уходит в Langfuse, уходит и в ваш бэкенд, а потом ' +
        'к кому-то ещё. Искать ПДн в трассах стоит регулярно: ' +
        '<code>jq</code> с функцией <code>select</code> и проверкой ' +
        '<code>test</code> находит вхождения прямо в поле input. ' +
        'Найдено — значит маскировать нужно до отправки.',
    h: ['Тот же curl с заголовком авторизации.',
        'jq: пройти по data, оставить те, где input содержит \\d{3}-\\d{2}-\\d{2}.',
        'curl -s \'http://localhost:3000/api/public/traces\' -H \'Authorization: Basic c2VjcmV0\' | jq \'.data[] | select(.input | test("\\d{3}-\\d{2}-\\d{2}"))\''],
    xp: 50
  },

  /* ---------------------------------------------------------- модуль 5 */
  {
    id: 13, m: 5, t: 'Метрика из Prometheus',
    task: 'Узнайте долю галлюцинаций: curl -s \'http://localhost:9090/api/v1/query?query=llm_hallucination_rate\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_hallucination_rate'$/,
    th: 'Prometheus отдаёт метрики через HTTP API, а не через ' +
        'промпт. Запрос <code>/api/v1/query?query=&lt;имя&gt;</code> ' +
        'возвращает JSON с текущим значением. Тот же запрос из ' +
        'браузера, из скрипта и из Grafana даёт одно и то же — ' +
        'поэтому метрику можно проверять автоматически, а не только ' +
        'смотреть на график.',
    h: ['Prometheus слушает порт 9090.',
        'Путь /api/v1/query и параметр query с именем метрики.',
        "curl -s 'http://localhost:9090/api/v1/query?query=llm_hallucination_rate'"],
    xp: 35
  },
  {
    id: 14, m: 5, t: 'Достаём значение для скрипта',
    task: 'Вытащите только число: curl -s \'http://localhost:9090/api/v1/query?query=llm_hallucination_rate\' | jq -r \'.data.result[0].value[1]\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_hallucination_rate'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/,
    th: 'Ответ Prometheus — глубоко вложенный JSON, а скрипту нужно ' +
        'одно число. <code>jq -r</code> с путём ' +
        '<code>.data.result[0].value[1]</code> достаёт ровно его. ' +
        'Дальше сравнение в шелле выглядит тривиально: ' +
        '<code>V=$(curl …); [ "$(echo "$V > 0.1" | bc)" = 1 ]</code>. ' +
        'Так метрика превращается из картинки в условие деплоя.',
    h: ['Тот же curl, что в прошлом задании.',
        'Нужен jq -r и путь вложенности до value.',
        "curl -s 'http://localhost:9090/api/v1/query?query=llm_hallucination_rate' | jq -r '.data.result[0].value[1]'"],
    xp: 45
  },
  {
    id: 15, m: 5, t: 'Вешаем алерт',
    task: 'Создайте правило: curl -s -X POST \'http://localhost:9090/api/v1/rules\'',
    re: /^curl\s+-s\s+-X\s+POST\s+'http:\/\/localhost:9090\/api\/v1\/rules'$/,
    th: 'Метрика без порога — просто число. Порог превращает её в ' +
        'сигнал. Правило в Prometheus читается как условие: ' +
        '«больше 0.10 дольше десяти минут». Важна вторая часть: если ' +
        'метрика скакнула на минуту, это шум, а если держится десять ' +
        'минут — вероятно, что-то сломалось на самом деле.',
    h: ['Нужно создать правило, значит метод POST.',
        'Endpoint правил Prometheus — /api/v1/rules на порту 9090.',
        "curl -s -X POST 'http://localhost:9090/api/v1/rules'"],
    xp: 35
  },
  {
    id: 16, m: 5, t: 'Отдаём модель наружу',
    task: 'Поднимите модель из реестра: mlflow models serve -m models:/intent-class/2 -p 5001',
    re: /^mlflow\s+models\s+serve\s+-m\s+models:\/intent-class\/2\s+-p\s+5001$/,
    th: 'Модель из реестра поднимается одной командой и сразу ' +
        'обслуживает HTTP-запросы. Это и есть мост между MLOps и ' +
        'обычным эксплуатационным контуром: дальше работают systemd, ' +
        'nginx, балансировщики и мониторинг — всё, что вы и так знаете. ' +
        'Указывайте конкретную версию, а не <code>latest</code>: ' +
        'иначе откат перестанет работать.',
    h: ['Подкоманда models, действие serve.',
        'Флаг -m со строкой models:/имя/версия, затем -p с портом.',
        'mlflow models serve -m models:/intent-class/2 -p 5001'],
    xp: 45
  },
  {
    id: 17, m: 5, t: 'Собираем конвейер целиком',
    task: 'Проверьте, что метрика в норме, прежде чем катить: curl -s \'http://localhost:9090/api/v1/query?query=llm_p95_latency_seconds\' | jq -r \'.data.result[0].value[1]\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_p95_latency_seconds'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/,
    th: 'Перед раскаткой проверяют ровно то, что сломается у клиента. ' +
        '95-й перцентиль задержки важнее среднего: среднее «прячется» ' +
        'длинным хвостом, а перцентиль показывает, что ' +
        'половина пользователей ждёт дольше нормы. Проверка ' +
        'значения перед деплоем — самая дешёвая страховка: ' +
        'дешевле проверить, чем откатывать.',
    h: ['Тот же jq-конвейер, но другая метрика.',
        'Интересует задержка — 95-й перцентиль, в секундах.',
        "curl -s 'http://localhost:9090/api/v1/query?query=llm_p95_latency_seconds' | jq -r '.data.result[0].value[1]'"],
    xp: 35
  }
];

MO.reset();

/* ============================================================ РЕГИСТРАЦИЯ */

COURSES.mlops = {
  i: '📈', n: 'MLFLOW · ЛАНГФЮЗ', c: 'var(--tr-cyan)',
  pr: MO_PROMPT,
  ti: 'mlops@ai-lab — MLflow · Langfuse · Prometheus',
  note: 'Команды настоящие: mlflow (CLI), curl (API Prometheus и Langfuse), ' +
        'docker compose, jq, sha256sum, python. Сервисы не поднимаются — ' +
        'их ответы моделируются в курсе; HTTP-формы ответов повторяют ' +
        'настоящие API.',
  mods: MO_MODS, ls: MO_LS,
  run: function (raw) {
    var r = null;
    try { r = moRun(raw); } catch (e) {
      r = { t: 'bash: внутренняя ошибка обработки команды: ' + (e && e.message ? e.message : e), c: 't-err' };
    }
    if (typeof renderEnv === 'function') { try { renderEnv(); } catch (e2) {} }
    return r;
  },
  reset: function () { MO.reset(); },
  env: function () { return MO.env(); }
};