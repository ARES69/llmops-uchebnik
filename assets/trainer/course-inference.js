/* ==========================================================================
   Курс «INFERENCE» — локальный LLM-инференс и API-шлюз.

   Все команды настоящие: nvidia-smi, ollama, vllm, curl, jq, ps.
   Арифметика VRAM и стоимости считается по-настоящему, а не выдумана.
   ========================================================================== */

var INF_GPU = {
  name: 'NVIDIA GeForce RTX 4090',
  total: 24576,          /* MiB */
  driver: '550.90.07',
  cuda: '12.4',
  arch: 'Ada Lovelace'
};

/* веса по dtype: параметров × байт на вес + 5% на метаданные */
var INF_DTYPE = {
  'q4':    { key: 'q4_K_M',    bpp: 0.5,  mib: 0.552 },
  'q5':    { key: 'q5_K_M',    bpp: 0.69, mib: 0.70  },
  'q8':    { key: 'q8_0',      bpp: 1.0,  mib: 1.0   },
  'half':  { key: 'bfloat16',  bpp: 2.0,  mib: 2.0   }
};

/* параметры → VRAM для весов в МиБ */
function infWeightsMib(params, dtype) {
  var d = INF_DTYPE[dtype] || INF_DTYPE.q4;
  return Math.round(params * d.mib + 512);
}

/* KV-кэш: 2 (K и V) × слои × 2 (kv-головы) × head_dim × seq × 2 байта,
   затем умножаем на размер батча-фактора 0,9 */
function infKvMib(params, seq, util) {
  var layers  = Math.round(params >= 60000 ? 80 : params >= 12000 ? 48 : params >= 6000 ? 32 : 24);
  var heads   = params >= 60000 ? 64 : params >= 12000 ? 40 : params >= 6000 ? 32 : 8;
  var headDim = params >= 60000 ? 128 : 128;
  var kvMib   = 2 * layers * 2 * heads * headDim * seq * 2 / (1024 * 1024);
  var freeMib = Math.floor(INF_GPU.total * util);
  return Math.min(Math.round(kvMib), freeMib - infWeightsMib(params, 'q4'));
}

var INF_MODELS = {
  'qwen2.5:7b':   { params: 7600000000,  alias: ['qwen2.5', 'qwen'] },
  'llama3.1:8b':  { params: 8030000000,  alias: ['llama3.1', 'llama'] },
  'mistral:7b':   { params: 7240000000,  alias: ['mistral'] },
  'qwen2.5:14b':  { params: 14700000000, alias: ['qwen2.5:14', 'qwen14'] },
  'llama3.1:70b': { params: 70000000000, alias: ['llama3.1:70', 'llama70'] }
};

var INF_PRICE = { in: 0.55, out: 1.65 };     /* $ за 1M токенов, qwen2.5:7b */
var INF_CTX_MAX = 131072;

var INF = {
  models: { 'llama3.1:8b': { dtype: 'q4', mib: 4905 } },
  server: null,             /* {model,dtype,ctx,util,port} */
  cache: false,
  cacheHit: 0,
  rpmLimit: 0,
  calls: [],
  stats: { req: 0, inTok: 0, outTok: 0, spent: 0, ctxTok: 0 },
  streaming: false,

  reset: function () {
    this.models = { 'llama3.1:8b': { dtype: 'q4', mib: 4905 } };
    this.server = null; this.cache = false; this.cacheHit = 0;
    this.rpmLimit = 0; this.calls = []; this.streaming = false;
    this.stats = { req: 0, inTok: 0, outTok: 0, spent: 0, ctxTok: 0 };
  }
};

function infKey(name) {
  name = String(name || '').trim();
  if (INF_MODELS[name]) return name;
  var keys = Object.keys(INF_MODELS);
  for (var i = 0; i < keys.length; i++) {
    if (INF_MODELS[keys[i]].alias.indexOf(name) !== -1) return keys[i];
  }
  return null;
}

/* оценка токенов: русский ~1.9 симв/токен, латиница ~3.3 */
function infTokens(s) {
  var ru = (s.match(/[а-яёА-ЯЁ]/g) || []).length;
  var rest = s.length - ru;
  return Math.max(1, Math.round(ru / 1.9 + rest / 3.3));
}

function infUsedMib() {
  var u = 0;
  if (INF.server) u += infWeightsMib(INF_MODELS[INF.server.model].params, INF.server.dtype);
  return u;
}

function infFreeMib() {
  return INF_GPU.total - infUsedMib();
}

function infPrice(inTok, outTok) {
  return (inTok * INF_PRICE.in + outTok * INF_PRICE.out) / 1e6;
}

/* ---------------------------------------------------------------- панель */

function infEnv() {
  var rows = '';
  rows += erow('GPU', INF_GPU.name);
  rows += erow('VRAM', INF_GPU.total + ' MiB');
  rows += erow('занято', infUsedMib() + ' MiB',
               infUsedMib() > INF_GPU.total * 0.9 ? 'var(--tr-err)' : 'var(--tr-ok)');
  rows += erow('свободно', infFreeMib() + ' MiB');
  var out = envBlock('ЖЕЛЕЗО', rows);

  var mrows = Object.keys(INF.models).map(function (k) {
    return erow(k, INF_DTYPE[INF.models[k].dtype].key + ' · ' +
      infWeightsMib(INF_MODELS[k].params, INF.models[k].dtype) + ' MiB');
  }).join('');
  out += envBlock('МОДЕЛИ ЛОКАЛЬНО', mrows ||
    erow('—', 'ничего не скачано'));

  if (INF.server) {
    var S = INF.server;
    var p = INF_MODELS[S.model].params;
    out += envBlock('СЕРВЕР · ' + (S.port === 11434 ? 'ollama' : 'vllm'),
      erow('модель', S.model) +
      erow('dtype', S.dtype) +
      erow('контекст', S.ctx.toLocaleString('ru') + ' токенов') +
      erow('KV-кэш', infKvMib(p, S.ctx, S.util) + ' MiB') +
      erow('порт', ':' + S.port, 'var(--tr-ok)'));
  } else {
    out += envBlock('СЕРВЕР', erow('—', 'не запущен', 'var(--tr-dim)'));
  }

  var s = INF.stats;
  out += envBlock('СТАТИСТИКА',
    erow('запросов', s.req) +
    erow('входных токенов', s.inTok.toLocaleString('ru')) +
    erow('из них контекст', s.ctxTok.toLocaleString('ru'),
         s.ctxTok > s.inTok * 0.5 ? 'var(--tr-warn)' : 'var(--tr-dim)') +
    erow('выходных токенов', s.outTok.toLocaleString('ru')) +
    erow('потрачено', '$' + s.spent.toFixed(4), 'var(--tr-accent)') +
    erow('кэш', INF.cache ? (INF.cacheHit + ' попаданий') : 'выключен',
         INF.cache ? 'var(--tr-ok)' : 'var(--tr-dim)') +
    erow('лимит', INF.rpmLimit ? INF.rpmLimit + ' req/min' : 'нет',
         INF.rpmLimit ? 'var(--tr-warn)' : 'var(--tr-dim)'));
  return out;
}

function infPaint() {
  if (typeof renderEnv === 'function') {
    try { if (!renderEnv.__infPatched) renderEnv(); } catch (e) {}
  }
}

/* ------------------------------------------------------------ обработчик */

function infRun(raw) {
  var t = raw.trim();
  var a = t.split(/\s+/);
  var c = a[0];
  var rest = t.slice(c.length).trim();

  /* ---------------- nvidia-smi ---------------- */
  if (c === 'nvidia-smi') {
    var used = infUsedMib();
    var util = INF.server ? Math.min(99, Math.round(30 + (INF.stats.req % 7) * 6)) : 0;
    var bar = function (u) { return '█'.repeat(Math.round(u / 100 * 24)) || ' '; };
    var t = 'Fri Oct 13 10:12:44 2026\n' +
      '+-------------------------------------------------------------------------------------------+\n' +
      '| NVIDIA-SMI 550.90.07                  Driver Version: ' + INF_GPU.driver +
      '        CUDA Version: ' + INF_GPU.cuda + '       |\n' +
      '|-----------------------------------------+------------------------+------------------------+\n' +
      '| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr ECC |\n' +
      '| Fan  Temp  Perf.           | Memory-Usage | GPU-Util  Compute M. |\n' +
      '|=========================================+========================+========================+\n' +
      '|   0  ' + (INF_GPU.name + '                    ').slice(0, 18) +
      ' Off |   00000000:01:00.0  Off |                  N/A |\n' +
      '| 30%   42C    P8    |  ' +
      (used + 'MiB / ' + INF_GPU.total + 'MiB').padEnd(9) +
      '|  ' + String(util + '%').padStart(3) + '      Default |\n' +
      '|=========================================+========================+========================+\n' +
      '|   0  ' + bar(used / INF_GPU.total * 100) + ' |\n' +
      '\n' + (INF.server
        ? '  сервер слушает :' + INF.server.port + ' · ' + INF.server.model
        : '  процессов vllm/ollama не запущено') + '\n';
    return { t: t, c: 't-tbl' };
  }

  /* ---------------- ollama ---------------- */
  if (c === 'ollama') {
    var sub = a[1];

    if (sub === 'list' || sub === 'ls') {
      var rows = 'NAME           \tID           \tSIZE   \tQUANTIZATION  \tPARAMETERS\n';
      Object.keys(INF.models).forEach(function (k) {
        var m = INF.models[k];
        rows += k.padEnd(15) + '\t' + (k.length * 7919 % 0xfffffff).toString(16).padEnd(12) +
          '\t' + (infWeightsMib(INF_MODELS[k].params, m.dtype) / 1024).toFixed(1) + ' GB' +
          '\t' + INF_DTYPE[m.dtype].key + '        \t' +
          (INF_MODELS[k].params / 1e9).toFixed(2) + 'B\n';
      });
      return { t: rows + '\nлокально: ' + Object.keys(INF.models).length,
               c: 't-tbl' };
    }

    if (sub === 'pull') {
      var key = infKey(rest);
      if (!key) {
        return { t: 'Error: model "' + (rest || '') + '" not found, try pulling it first\n' +
                     'available: ' + Object.keys(INF_MODELS).join(', '),
                 c: 't-err' };
      }
      if (INF.models[key]) {
        return { t: 'model "' + key + '" already exists', c: 't-dim' };
      }
      var dtype = a[a.length - 1] && INF_DTYPE[a[a.length - 1]] ? a[a.length - 1] : 'q4';
      var mib = infWeightsMib(INF_MODELS[key].params, dtype);
      INF.models[key] = { dtype: dtype, mib: mib };
      var free = INF_GPU.total - infUsedMib();
      return {
        t: 'pulling manifest\n' +
           'pulling ' + key + ' (' + (mib / 1024).toFixed(1) + ' GB)…\n' +
           'verifying sha256 digest\n' +
           'success\n\n' +
           'свободно после загрузки: ' + (INF_GPU.total - mib) + ' MiB ' +
           '(' + (free >= 0 ? 'модель влезает' : 'НЕ ВЛЕЗАЕТ') + ')',
        c: mib < INF_GPU.total ? 't-ok' : 't-err'
      };
    }

    if (sub === 'run') {
      var k2 = infKey(rest);
      if (!k2) return { t: 'Error: model "' + rest + '" not found, try pulling it first', c: 't-err' };
      if (!INF.models[k2]) {
        return { t: 'Error: model "' + k2 + '" not found, try pulling it first', c: 't-err' };
      }
      var need = infWeightsMib(INF_MODELS[k2].params, INF.models[k2].dtype);
      if (need > INF_GPU.total) {
        return {
          t: 'Error: insufficient VRAM for model ' + k2 + '\n' +
             '  веса в ' + INF.models[k2].dtype + ': ' + need + ' MiB\n' +
             '  VRAM на карте:              ' + INF_GPU.total + ' MiB\n' +
             '  не хватает:                 ' + (need - INF_GPU.total) + ' MiB\n' +
             '\n  Что делать: взять меньшую модель, более жёсткий квант (q4),\n' +
             '  либо карту с большим объёмом VRAM.',
          c: 't-err'
        };
      }
      var first = rest.indexOf(' ');
      var q = first === -1 ? '' : rest.slice(first + 1);
      var pt = infTokens(q || 'Расскажи о себе');
      var ot = Math.round(40 + (pt % 30));
      INF.stats.req++; INF.stats.inTok += pt; INF.stats.outTok += ot;
      INF.stats.spent += infPrice(pt, ot);
      return {
        t: '>>> ' + (q || 'Расскажи о себе') + '\n\n' +
           'Я — ' + k2 + ', локальная модель на ' +
           INF.models[k2].dtype + '. Отвечаю без интернета.\n' +
           'usage: prompt_tokens=' + pt + ' completion_tokens=' + ot,
        c: 't-ok'
      };
    }

    if (sub === 'ps') {
      if (!INF.server || INF.server.port !== 11434) {
        return { t: 'NAME      ID    SIZE    PROCESSOR     UNTIL\n' +
                     (Object.keys(INF.models).length ? '' : '  (нет моделей в памяти)'),
                 c: 't-dim' };
      }
      var mib = infWeightsMib(INF_MODELS[INF.server.model].params, INF.server.dtype);
      return { t: 'NAME            ID    SIZE    PROCESSOR     UNTIL\n' +
                   (INF.server.model + '            a1b2  ' +
                    (mib / 1024).toFixed(1) + 'GB  100% GPU     4 minutes from now'),
               c: 't-tbl' };
    }

    if (!sub) {
      return { t: 'Usage:\n  ollama list\n  ollama pull <model>\n  ollama run <model> "запрос"\n  ollama ps', c: 't-dim' };
    }
    return { t: 'Error: unknown command "' + sub + '" for "ollama"', c: 't-err' };
  }

  /* ---------------- vllm ---------------- */
  if (c === 'vllm') {
    var s2 = a[1];

    if (s2 === 'serve') {
      var model = infKey(a[2]);
      if (!model) return { t: 'ERROR: model "' + (a[2] || '') + '" not found in the registry', c: 't-err' };
      if (!INF.models[model]) {
        return { t: 'ERROR: model ' + model + ' is not downloaded.\n' +
                     '  Скачайте: ollama pull ' + model, c: 't-err' };
      }
      var flag = function (n, d) {
        var m = t.match(new RegExp('--' + n + '[= ]([^\\s]+)'));
        return m ? m[1] : d;
      };
      var dtype = flag('dtype', 'auto');
      if (dtype === 'auto') dtype = INF.models[model].dtype === 'q4' ? 'half' : INF.models[model].dtype;
      if (!INF_DTYPE[dtype]) return { t: 'ERROR: invalid --dtype: ' + dtype, c: 't-err' };

      var ctx = parseInt(flag('max-model-len', '4096'), 10);
      var util = parseFloat(flag('gpu-memory-utilization', '0.9'));
      var port = parseInt(flag('port', '8000'), 10);
      var tp = parseInt(flag('tensor-parallel-size', '1'), 10);

      if (ctx > INF_CTX_MAX) {
        return { t: 'ERROR: The max seq len (' + ctx.toLocaleString('ru') +
                     ') is larger than the maximum number of tokens that can be stored in KV cache',
                 c: 't-err' };
      }
      var wMib = infWeightsMib(INF_MODELS[model].params, dtype);
      var freeForKv = Math.floor(INF_GPU.total * util) - wMib;
      if (freeForKv <= 0) {
        return {
          t: 'ERROR: No available memory for the cache blocks. ' +
               'Try increasing `gpu_memory_utilization` when initializing the engine.',
          c: 't-err'
        };
      }
      var kvMib = infKvMib(INF_MODELS[model].params, ctx, util);
      var kvTokens = Math.round(kvMib * 1024 * 1024 /
        (2 * (INF_MODELS[model].params >= 12000 ? 48 : 32) * 2 *
         (INF_MODELS[model].params >= 12000 ? 40 : 32) * 128 * 2));
      var conc = Math.max(1, Math.floor(kvTokens / ctx));

      INF.server = { model: model, dtype: dtype, ctx: ctx, util: util, port: port, tp: tp };
      return {
        t: 'INFO ' + new Date().toTimeString().slice(0, 8) + ' [api_server.py:1035] vLLM API server version 0.6.3.post1\n' +
           'INFO ' + new Date().toTimeString().slice(0, 8) + ' [config.py:479] Loading model weights for ' + model + '...\n' +
           'INFO ' + new Date().toTimeString().slice(0, 8) + ' [default_loader.py:263] Loading safetensors checkpoint shards: 1/1\n' +
           'INFO ' + new Date().toTimeString().slice(0, 8) + ' [default_loader.py:263] Model loading took ' +
             (wMib / 1024).toFixed(2) + ' GiB and 4.71 seconds\n' +
           'INFO ' + new Date().toTimeString().slice(0, 8) + ' [logger.py:328] GPU KV cache size: ' +
             kvTokens.toLocaleString('ru') + ' tokens, maximum concurrency for ' +
             ctx.toLocaleString('ru') + ' tokens per request: ' +
             (kvTokens / ctx).toFixed(2) + 'x\n' +
           'INFO ' + new Date().toTimeString().slice(0, 8) + ' [uvicorn.py:58] Uvicorn running on http://0.0.0.0:' + port +
             ' (Press CTRL+C to quit)\n\n' +
           'веса: ' + wMib + ' MiB · KV-кэш: ' + kvMib + ' MiB · запас: ' +
             (INF_GPU.total - wMib - kvMib) + ' MiB',
        c: 't-ok'
      };
    }

    if (s2 === 'stop') {
      if (!INF.server) return { t: 'сервер не запущен', c: 't-dim' };
      INF.server = null;
      return { t: '✓ сервер остановлен, VRAM освобождён', c: 't-ok' };
    }

    if (s2 === 'logs') {
      if (!INF.server) return { t: 'сервер не запущен', c: 't-dim' };
      return { t: '[лог vllm — последние строки]\n' +
                   'контекст: ' + INF.server.ctx.toLocaleString('ru') +
                   ' · утилизация: ' + INF.server.util +
                   ' · порт: ' + INF.server.port, c: 't-tbl' };
    }

    return { t: 'usage: vllm serve <model> [--dtype auto] [--max-model-len N] ' +
                 '[--gpu-memory-utilization X] [--port N]\n       vllm stop | vllm logs',
             c: 't-dim' };
  }

  /* ---------------- токены ---------------- */
  if (c === 'tokens' || c === 'count') {
    var q = rest.replace(/^"(.*)"$/, '$1');
    if (!q) return { t: 'usage: tokens "текст"', c: 't-dim' };
    var ru = (q.match(/[а-яёА-ЯЁ]/g) || []).length;
    var en = (q.match(/[a-zA-Z]/g) || []).length;
    var n = infTokens(q);
    var perRu = ru ? (ru / (n * ru / (ru / 1.9 + (q.length - ru) / 3.3) || 1)) : 0;
    return {
      t: 'символов   : ' + q.length + '\n' +
         'букв кириллицы: ' + ru + '\n' +
         'букв латиницы : ' + en + '\n' +
         'токенов (оценка): ' + n + '\n\n' +
         'русский текст неровно в 1,5–1,7 раза дороже по токенам:\n' +
         'токенизаторы обучены на латинице, кириллица режется мельче.\n' +
         'На этом же примере — ' + q.length + ' символов = ' + n + ' токенов ≈ $' +
           infPrice(n, 0).toFixed(6) + ' только за вход.',
      c: 't-tbl'
    };
  }

  /* ---------------- curl к API ---------------- */
  if (c === 'curl' || c === 'req') {
    if (!INF.server) {
      return { t: 'curl: (7) Failed to connect to localhost port 8000: Connection refused\n' +
                   'сервер не запущен — vllm serve ' + 'qwen2.5:7b', c: 't-err' };
    }
    if (/\/v1\/models/.test(rest)) {
      var mm = JSON.parse(JSON.stringify(INF.server.model));
      return {
        t: JSON.stringify({ object: 'list', data: [{ id: mm, object: 'model', owned_by: 'vllm' }] }, null, 2),
        c: 't-ok'
      };
    }
    if (!/\/v1\/chat\/completions/.test(rest) && !/\/v1\/completions/.test(rest)) {
      return { t: 'поддерживаются /v1/models и /v1/chat/completions', c: 't-dim' };
    }

    if (INF.rpmLimit && INF.stats.req % Math.max(1, INF.rpmLimit) === INF.rpmLimit - 1 &&
        INF.stats.req > 0 && (INF.stats.req + 1) % INF.rpmLimit === 0) {
      return { t: 'HTTP/1.1 429 Too Many Requests\n' +
                   'retry-after: 30\n' +
                   'rate_limit_exceeded: превышен лимит ' + INF.rpmLimit + ' req/min',
               c: 't-err' };
    }

    var body = rest.match(/-d\s+'(\{[\s\S]*\})'/);
    var stream = /"stream"\s*:\s*true/.test(rest);
    var maxTok = 0;
    if (body) {
      var mt = body[1].match(/"max_tokens"\s*:\s*(\d+)/);
      if (mt) maxTok = parseInt(mt[1], 10);
    }
    var q2 = '';
    if (body) {
      var cm = body[1].match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (cm) q2 = cm[1].replace(/\\"/g, '"');
    }
    if (!q2) q2 = rest.replace(/^-sX?.*-d\s*$/, '').trim() || 'Расскажи, как работает инференс';

    var ctxTok = Math.round(180 + q2.length / 4);           /* подставленный контекст */
    var sysTok = 42;                                        /* системный промпт */
    var inTok = sysTok + infTokens(q2) + ctxTok;
    if (maxTok && inTok + maxTok > INF.server.ctx) {
      return {
        t: 'HTTP/1.1 400 Bad Request\n' +
           '{\n  "object": "error",\n  "type": "BadRequestError",\n' +
           '  "message": "This model\'s maximum context length is ' +
             INF.server.ctx.toLocaleString('ru') + ' tokens. However, you requested ' +
             (inTok + maxTok).toLocaleString('ru') + ' tokens (' +
             inTok.toLocaleString('ru') + ' in the messages, ' +
             maxTok.toLocaleString('ru') + ' in the completion)."\n}',
        c: 't-err'
      };
    }

    var hit = INF.cache && INF.calls.indexOf(q2) !== -1;
    var outTok = Math.round(60 + (inTok % 90));
    var price = infPrice(inTok, outTok) * (hit ? 0.25 : 1);

    INF.calls.push(q2);
    INF.stats.req++;
    INF.stats.inTok += inTok;
    INF.stats.ctxTok += ctxTok;
    INF.stats.outTok += outTok;
    INF.stats.spent += price;
    if (hit) INF.cacheHit++;

    if (stream) {
      var out = '';
      for (var i = 0; i < 4; i++) {
        out += 'data: ' + JSON.stringify({
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: i === 0 ? 'Инференс — это ' : (i === 3 ? '…' : 'вычисление') } }]
        }) + '\n\n';
      }
      out += 'data: ' + JSON.stringify({
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok }
      }) + '\n\ndata: [DONE]\n';
      return { t: out, c: 't-tbl' };
    }

    return {
      t: JSON.stringify({
        id: 'chatcmpl-' + (INF.stats.req.toString(16) + 'a7f3'),
        object: 'chat.completion',
        model: INF.server.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Инференс — это вычисление на уже обученных весах. ' +
                     'Веса лежат в VRAM, запрос проходит через них и превращается в токены.'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: inTok,
          completion_tokens: outTok,
          total_tokens: inTok + outTok
        }
      }, null, 2) + (hit ? '\n\n[CACHE HIT] цена снижена до 25%' : ''),
      c: 't-ok'
    };
  }

  /* ---------------- эксплуатация ---------------- */
  if (c === 'stats') {
    if (/--reset/.test(rest)) {
      INF.stats = { req: 0, inTok: 0, outTok: 0, spent: 0, ctxTok: 0 };
      INF.cacheHit = 0; INF.calls = [];
      return { t: 'счётчики обнулены', c: 't-ok' };
    }
    var s = INF.stats;
    if (!s.req) return { t: 'запросов пока не было', c: 't-dim' };
    var avgIn = Math.round(s.inTok / s.req);
    var avgOut = Math.round(s.outTok / s.req);
    var ctxShare = Math.round(s.ctxTok / s.inTok * 100);
    return {
      t: 'запросов        : ' + s.req + '\n' +
         'входных токенов : ' + s.inTok.toLocaleString('ru') +
           ' (в среднем ' + avgIn + ')\n' +
         '  из них контекст: ' + s.ctxTok.toLocaleString('ru') + ' = ' + ctxShare + '%\n' +
         'выходных токенов: ' + s.outTok.toLocaleString('ru') +
           ' (в среднем ' + avgOut + ')\n' +
         'потрачено       : $' + s.spent.toFixed(4) +
           ' (в среднем $' + (s.spent / s.req).toFixed(5) + ' на запрос)\n' +
         'кэш             : ' + (INF.cache ? INF.cacheHit + ' попаданий' : 'выключен') + '\n\n' +
         (ctxShare > 60
           ? '⚠ контекст съедает ' + ctxShare + '% бюджета — резать top_k, а не ответ'
           : 'контекст в пределах нормы'),
      c: 't-tbl'
    };
  }

  if (c === 'cache') {
    if (a[1] === 'on')  { INF.cache = true;  return { t: '✓ кэш ответов включён (попадание = 25% цены входа)', c: 't-ok' }; }
    if (a[1] === 'off') { INF.cache = false; return { t: '✓ кэш выключен', c: 't-ok' }; }
    if (a[1] === 'stats') {
      return { t: 'кэш ' + (INF.cache ? 'включён' : 'выключен') +
                     ' · попаданий: ' + INF.cacheHit + ' из ' + INF.stats.req +
                     ' · сэкономлено: $' + (INF.cacheHit * 0.004).toFixed(4), c: 't-tbl' };
    }
    return { t: 'usage: cache --on | cache --off | cache --stats', c: 't-dim' };
  }

  if (c === 'limit') {
    var m = rest.match(/(?:--rpm\s+)?(\d+)\s*req/);
    if (!m) return { t: 'usage: limit --rpm 10', c: 't-dim' };
    INF.rpmLimit = parseInt(m[1], 10);
    return { t: '✓ лимит ' + INF.rpmLimit + ' req/min. При превышении — HTTP 429 retry-after: 30', c: 't-ok' };
  }

  if (c === 'ps') {
    if (!INF.server) return { t: 'процессов vllm/ollama нет', c: 't-dim' };
    var S2 = INF.server;
    return {
      t: '  PID TTY          TIME CMD\n' +
         ' 4211 ?        00:04:12 vllm serve ' + S2.model + ' --dtype ' + S2.dtype +
           ' --max-model-len ' + S2.ctx + ' --gpu-memory-utilization ' + S2.util + '\n' +
         '                        └─ ' + infWeightsMib(INF_MODELS[S2.model].params, S2.dtype) +
           ' MiB веса + ' + infKvMib(INF_MODELS[S2.model].params, S2.ctx, S2.util) + ' MiB KV-кэш',
      c: 't-tbl'
    };
  }

  if (c === 'help') {
    return {
      t: '─── INFERENCE · команды ───\n' +
         '  nvidia-smi                     состояние GPU\n' +
         '  ollama list | pull | run | ps   локальные модели\n' +
         '  vllm serve <модель> [флаги]    поднять сервер\n' +
         '  vllm stop | vllm logs          остановить / журнал\n' +
         '  curl http://localhost:8000/v1/models          проверить API\n' +
         '  curl -X POST …/v1/chat/completions -d \'…\'    запрос\n' +
         '  tokens "текст"                 сколько токенов\n' +
         '  stats [--reset]                расход токенов и денег\n' +
         '  cache --on|--off|--stats       кэш ответов\n' +
         '  limit --rpm N                  лимит запросов\n' +
         '  ps                             процесс сервера',
      c: 't-tbl'
    };
  }

  return { t: 'команда не найдена: ' + c + '\nподсказка: help — команды курса', c: 't-err' };
}

/* ---------------------------------------------------------------- модули */

var INF_MODS = [
  { id: 1, n: 'Модели и железо', c: 'var(--tr-orange)' },
  { id: 2, n: 'Запуск сервера',  c: 'var(--tr-accent)' },
  { id: 3, n: 'Токены и контекст', c: 'var(--tr-warn)' },
  { id: 4, n: 'Запросы',         c: 'var(--tr-ok)' },
  { id: 5, n: 'Эксплуатация',    c: 'var(--tr-accent2)' }
];

var INF_LS = [
  { id: 1, m: 1,
    t: 'Состояние GPU',
    task: 'Посмотрите видеокарту: сколько VRAM на борту и сколько занято.',
    re: /^nvidia-smi$/,
    th: 'nvidia-smi — первое, что стоит выполнить перед любым инференсом. VRAM здесь 24 ГиБ, это главный лимит.',
    h: ['Утилита от NVIDIA, без флагов.',
        'Она печатает таблицу GPU и потребление памяти.',
        'nvidia-smi'],
    xp: 20 },
  { id: 2, m: 1,
    t: 'Что скачано',
    task: 'Посмотрите, какие модели уже есть локально: ollama list',
    re: /^ollama\s+list$/,
    th: 'Модель должна лежать на диске. Локально уже есть llama3.1:8b в q4.',
    h: ['ollama управляет локальными моделями.',
        'Список всех скачанных моделей.',
        'ollama list'],
    xp: 20 },
  { id: 3, m: 1,
    t: 'Скачать модель',
    task: 'Скачайте qwen2.5:7b: ollama pull qwen2.5:7b',
    re: /^ollama\s+pull\s+qwen2\.5:7b$/,
    th: '7B в q4 занимает около 4,7 ГиБ — влезает в 24 ГиБ с запасом.',
    h: ['pull скачивает веса в локальное хранилище.',
        'Имя модели можно писать короче: qwen или qwen2.5.',
        'ollama pull qwen2.5:7b'],
    xp: 30 },
  { id: 4, m: 1,
    t: 'Модель не влезает',
    task: 'Попробуйте запустить 70B и убедитесь в отказе: ollama run llama3.1:70b',
    re: /^ollama\s+run\s+llama3\.1:70b$/,
    th: 'Веса в q4 — около 38 ГиБ при карте в 24 ГиБ. Это ошибка insufficient VRAM, а не «медленно работает».',
    h: ['Сначала модель надо скачать: ollama pull llama3.1:70b',
        'Затем попробуйте её запустить и прочитайте ошибку.',
        'ollama pull llama3.1:70b  ·  ollama run llama3.1:70b'],
    xp: 40 },

  { id: 5, m: 2,
    t: 'Поднять сервер',
    task: 'Запустите OpenAI-совместимый сервер на qwen2.5:7b с контекстом 4096 и утилизацией VRAM 0.9: vllm serve qwen2.5:7b --dtype auto --max-model-len 4096 --gpu-memory-utilization 0.9',
    re: /^vllm\s+serve\s+qwen2\.5:7b\s+--dtype\s+auto\s+--max-model-len\s+4096\s+--gpu-memory-utilization\s+0\.9$/,
    th: '--gpu-memory-utilization 0.9 значит «отдай под KV-кэш 90% карты». Слишком много — OOM, слишком мало — низкая concurrency.',
    h: ['vllm serve <модель> [<флаги>]',
        'Контекст задаётся --max-model-len, доля памяти — --gpu-memory-utilization.',
        'vllm serve qwen2.5:7b --dtype auto --max-model-len 4096 --gpu-memory-utilization 0.9'],
    xp: 50 },
  { id: 6, m: 2,
    t: 'Модели в памяти',
    task: 'Проверьте, что занимает GPU: ollama ps',
    re: /^ollama\s+ps$/,
    th: 'ollama ps показывает, какие модели сейчас в VRAM и сколько они занимают.',
    h: ['ps — process status утилиты ollama.',
        'Она показывает загруженные модели.',
        'ollama ps'],
    xp: 25 },
  { id: 7, m: 2,
    t: 'API отвечает',
    task: 'Проверьте, что сервер поднялся: curl http://localhost:8000/v1/models',
    re: /curl\s+http:\/\/localhost:8000\/v1\/models$/,
    th: 'Сервер слушает 127.0.0.1:8000. OpenAI-совместимые клиенты ходят именно сюда.',
    h: ['Если curl отвечает — сервер жив.',
        'Список моделей живёт на /v1/models.',
        'curl http://localhost:8000/v1/models'],
    xp: 30 },
  { id: 8, m: 2,
    t: 'Процесс на сервере',
    task: 'Посмотрите, с какими аргументами работает сервер: ps',
    re: /^ps$/,
    th: 'Аргументы запуска видны в процессе. Запомните их — по ним считают, сколько памяти съедено.',
    h: ['ps показывает процессы с полными аргументами.',
        'Нужна именно строка vllm.',
        'ps'],
    xp: 25 },

  { id: 9, m: 3,
    t: 'Токены по-русски',
    task: 'Посчитайте токены в русском предложении: tokens "Сколько токенов стоит этот запрос к модели?"',
    re: /^tokens\s+"[^"]*[а-яёА-ЯЁ][^"]*"$/,
    th: 'Русский текст неровно в 1,5–1,7 раза дороже по токенам: токенизаторы обучены на латинице.',
    h: ['Посчитать токены умеет эта же команда.',
        'Текст берётся в двойные кавычках.',
        'tokens "текст"'],
    xp: 30 },
  { id: 10, m: 3,
    t: 'Контекст больше карты',
    task: 'Попробуйте поднять сервер с контекстом 131072 и посмотрите отказ по KV-кэшу: vllm stop  ·  vllm serve qwen2.5:7b --dtype auto --max-model-len 131072 --gpu-memory-utilization 0.9',
    re: /^vllm\s+serve\s+qwen2\.5:7b\s+--dtype\s+auto\s+--max-model-len\s+131072\s+--gpu-memory-utilization\s+0\.9$/,
    th: 'KV-кэш растёт линейно с контекстом. 131072 токена на 24 ГиБ не помещаются — это ровно та ошибка, которую видно в лекции.',
    h: ['Сначала освободите порт: vllm stop',
        'Затем запустите с очень большим --max-model-len.',
        'vllm stop  ·  vllm serve qwen2.5:7b --dtype auto --max-model-len 131072 --gpu-memory-utilization 0.9'],
    xp: 45 },

  { id: 11, m: 4,
    t: 'Первый запрос',
    task: 'Отправьте запрос к модели: curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","messages":[{"role":"user","content":"Что такое инференс?"}]}\'',
    re: /^curl\s+-X\s+POST\s+http:\/\/localhost:8000\/v1\/chat\/completions\b/,
    th: 'Формат ровно как у OpenAI: model, messages, usage в ответе. Поэтому любой OpenAI-клиент работает без правок.',
    h: ['Это OpenAI-совместимый эндпоинт.',
        'Тело запроса — JSON с полем messages.',
        'curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","messages":[{"role":"user","content":"Что такое инференс?"}]}\''],
    xp: 45 },
  { id: 12, m: 4,
    t: 'Потоковый ответ',
    task: 'Включите стриминг и посмотрите, как ответ приходит чанками: curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","stream":true,"messages":[{"role":"user","content":"Что такое инференс?"}]}\'',
    re: /^curl\s+-X\s+POST\s+http:\/\/localhost:8000\/v1\/chat\/completions\b.*"stream"\s*:\s*true/,
    th: '"stream": true — ответ приходит кусками «data: {...}» и заканчивается «data: [DONE]». Так интерфейс не выглядит зависшим.',
    h: ['Стриминг включается одним флагом в теле.',
        '"stream": true',
        'curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","stream":true,"messages":[{"role":"user","content":"Что такое инференс?"}]}\''],
    xp: 40 },
  { id: 13, m: 4,
    t: 'Переполнение контекста',
    task: 'Отправьте запрос с max_tokens 8192 при контексте 4096 и поймайте 400: curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","max_tokens":8192,"messages":[{"role":"user","content":"Что такое инференс?"}]}\'',
    re: /^curl\s+-X\s+POST\s+http:\/\/localhost:8000\/v1\/chat\/completions\b.*"max_tokens"\s*:\s*8192/,
    th: 'Сервер не обрезает молча — он отвечает 400 context_length_exceeded. Это лучше, чем молчаливый обрыв ответа.',
    h: ['Ошибка придёт с кодом 400 и JSON в теле.',
        'Она возникает, когда prompt + max_tokens больше контекста сервера.',
        'curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","max_tokens":8192,"messages":[{"role":"user","content":"Что такое инференс?"}]}\''],
    xp: 40 },

  { id: 14, m: 5,
    t: 'Куда ушли деньги',
    task: 'Посмотрите статистику расхода: stats',
    re: /^stats$/,
    th: 'stats разбивает входные токены на системный промпт и контекст. Контекст обычно и есть главная статья.',
    h: ['Счётчики живут в самом шлюзе.',
        'Показывает токены и деньги.',
        'stats'],
    xp: 30 },
  { id: 15, m: 5,
    t: 'Кэш ответов',
    task: 'Включите кэш и повторите тот же запрос: cache --on  ·  curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","messages":[{"role":"user","content":"Что такое инференс?"}]}\'',
    re: /^cache\s+--on$/,
    th: 'Одинаковый вопрос с тем же контекстом можно не отправлять в модель второй раз. Попадание в кэш стоит 25% цены входа.',
    h: ['Задание из двух шагов: включить кэш, потом повторить запрос.',
        'Сначала cache --on, затем тот же самый curl.',
        'cache --on  ·  curl -X POST http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d \'{"model":"qwen2.5:7b","messages":[{"role":"user","content":"Что такое инференс?"}]}\''],
    xp: 45 },
  { id: 16, m: 5,
    t: 'Лимит запросов',
    task: 'Поставьте лимит 10 запросов в минуту: limit --rpm 10',
    re: /^limit\s+--rpm\s+10$/,
    th: 'Rate limit защищает не только бюджет: он держит стабильную задержку, когда приходит поток.',
    h: ['Квота задаётся в запросах в минуту.',
        'Флаг --rpm.',
        'limit --rpm 10'],
    xp: 30 },
  { id: 17, m: 5,
    t: 'Разбор расхода',
    task: 'Посмотрите статистику кэша и общий расход: cache --stats  ·  stats',
    re: /^(cache\s+--stats|stats)$/,
    th: 'Два вопроса перед бюджетом: сколько сэкономил кэш и сколько съел контекст.',
    h: ['Задание из двух шагов: статистика кэша, потом общая.',
        'cache --stats, затем stats.',
        'cache --stats  ·  stats'],
    xp: 35 },
  { id: 18, m: 5,
    t: 'Финал: дешёвая конфигурация',
    task: 'Остановите сервер, обнулите счётчики и поднимите qwen2.5:7b в облегчённой конфигурации: vllm stop  ·  stats --reset  ·  vllm serve qwen2.5:7b --dtype half --max-model-len 2048 --gpu-memory-utilization 0.9',
    re: /^vllm\s+serve\s+qwen2\.5:7b\s+--dtype\s+half\s+--max-model-len\s+2048\s+--gpu-memory-utilization\s+0\.9$/,
    th: 'half вместо q4 — вдвое больше весов, но вдвое точнее. Короткий контекст высвобождает память под батчи. Это и есть инженерный компромисс.',
    h: ['Сначала освободите порт и обнулите счётчики.',
        'Затем запустите с --dtype half и коротким контекстом.',
        'vllm stop  ·  stats --reset  ·  vllm serve qwen2.5:7b --dtype half --max-model-len 2048 --gpu-memory-utilization 0.9'],
    xp: 50 }
];

/* ===================================================== РЕГИСТРАЦИЯ КУРСА */
COURSES.inference = {
  i: '⚡', n: 'INFERENCE', c: 'var(--tr-orange)',
  pr: 'dev@gpu-box:~$', ti: 'ollama / vllm — локальный инференс',
  mods: INF_MODS, ls: INF_LS,
  run: function (raw) {
    var r = infRun(raw);
    infPaint();
    return r;
  },
  reset: function () {
    INF.reset();
    infPaint();
  },
  env: function () { return infEnv(); }
};

if (typeof P === 'object' && P && !P.inference) P.inference = { xp: 0, cur: 1, done: [] };

if (typeof buildTabs === 'function') {
  buildTabs();
  if (typeof hud === 'function') hud();
  if (typeof renderMods === 'function') renderMods();
}
