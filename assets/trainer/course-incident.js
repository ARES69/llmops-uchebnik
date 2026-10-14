/* ==========================================================================
   Курс «ИНЦИДЕНТ · ПОСТМОРТЕМ» — дипломный сквозной сценарий.

   Одна ночь, один сбой, от алерта до постмортема. Сценарий специально
   проходит через инструменты остальных курсов (журналы, метрики, git,
   реестр моделей), но в одном связном кейсе: учиться на отдельных курсах
   проще, чем довести дело до конца.

   Команды настоящие: systemctl, journalctl, curl, jq, grep, sort, git,
   sha256sum, cp, sed, mlflow.
   ========================================================================== */

var IC_PROMPT = 'sre@prod-llm:~$';

/* ------------------------------------------------------------ сюжет */

var IC_TIMELINE = [
  /* нормальная работа */
  { ts: '02:09:41', status: 200, ms: 812,  tok: 1420, path: '/v1/chat/completions' },
  { ts: '02:10:12', status: 200, ms: 690,  tok: 1180, path: '/v1/chat/completions' },
  { ts: '02:11:03', status: 200, ms: 744,  tok: 1290, path: '/v1/chat/completions' },
  /* деградация начинается после правки конфига в 01:58 */
  { ts: '02:14:22', status: 504, ms: 30004, tok: 0, path: '/v1/chat/completions' },
  { ts: '02:14:51', status: 504, ms: 30001, tok: 0, path: '/v1/chat/completions' },
  { ts: '02:15:09', status: 502, ms: 14210, tok: 0, path: '/v1/chat/completions' },
  { ts: '02:16:33', status: 504, ms: 30002, tok: 0, path: '/v1/chat/completions' },
  { ts: '02:18:04', status: 504, ms: 30000, tok: 0, path: '/v1/chat/completions' },
  { ts: '02:21:47', status: 502, ms: 15880, tok: 0, path: '/v1/chat/completions' },
  { ts: '02:24:12', status: 504, ms: 30003, tok: 0, path: '/v1/chat/completions' },
  { ts: '02:27:55', status: 504, ms: 30001, tok: 0, path: '/v1/chat/completions' }
];

var IC_STATE = {
  logs: IC_TIMELINE,
  errCount: 8,
  p95: 14.207,
  tokens: 9841200,
  cfgTokens: 65536,
  restored: false,
  restarted: false,
  pmMade: false,
  pmFilled: false,

  reset: function () {
    this.logs = IC_TIMELINE.slice();
    this.errCount = this.logs.filter(function (l) { return l.status >= 500; }).length;
    this.p95 = 14.207;
    this.tokens = 9841200;
    this.cfgTokens = 65536;
    this.restored = false;
    this.restarted = false;
    this.pmMade = false;
    this.pmFilled = false;
  },

  jsonl: function () {
    return this.logs.map(function (l) {
      return JSON.stringify({ ts: '2026-10-16T' + l.ts, status: l.status, ms: l.ms,
                              tokens: l.tok, path: l.path });
    });
  },

  env: function () {
    return envBlock('ИНЦИДЕНТ',
        erow('номер', 'INC-4417') +
        erow('окно', '02:14 — 02:41') +
        erow('ошибок 5xx', this.errCount, this.errCount ? 'var(--tr-err)' : 'var(--tr-ok)'))
      + envBlock('СЕРВИС',
        erow('p95, с', this.p95.toFixed(2), this.p95 > 1 ? 'var(--tr-err)' : 'var(--tr-ok)') +
        erow('конфиг восстановлен', this.restored ? 'да' : 'нет', this.restored ? 'var(--tr-ok)' : 'var(--tr-err)') +
        erow('LLM_MAX_TOKENS', this.cfgTokens))
      + envBlock('ПОСТМОРТЕМ',
        erow('черновик создан', this.pmMade ? 'да' : 'нет') +
        erow('номер проставлен', this.pmFilled ? 'да' : 'нет', this.pmFilled ? 'var(--tr-ok)' : 'var(--tr-dim)'));
  },

  run: function (raw) { return icRun(raw); }
};

/* =========================================================== обработчик == */

function icLogLine(l) {
  return '{"ts":"2026-10-16T' + l.ts + '","level":"' +
         (l.status >= 500 ? 'error' : 'info') + '","status":' + l.status +
         ',"ms":' + l.ms + ',"tokens":' + l.tok + ',"path":"' + l.path + '"}';
}

function icRun(raw) {
  var t = raw.trim();
  if (!t) return null;

  /* --------------------------------------------------------------- help */
  if (/^(help|\?|--help)$/.test(t)) {
    return {
      t: '─── ' + COURSES.incident.i + ' ИНЦИДЕНТ · ПОСТМОРТЕМ · команды ───\n\n' +
         '  systemctl status <unit> --no-pager     состояние службы\n' +
         '  systemctl restart <unit>              перезапуск\n' +
         '  journalctl -u <unit> --since "ЧЧ:ММ" --no-pager\n' +
         '  journalctl … | tail -n N             последние строки\n' +
         '  journalctl … | grep -c \'<шаблон>\'    счётчик совпадений\n' +
         '  grep -o \'<шаблон>\' | sort | tail -1  самое долгое\n' +
         '  curl -s \'<prometheus>?query=<метрика>\' | jq -r \'<путь>\'\n' +
         '  stat -c \'%y\' <файл>                 время изменения файла\n' +
         '  git log --oneline -- <файл>          история файла\n' +
         '  git diff HEAD~1 -- <файл>            что изменилось\n' +
         '  git restore --source=HEAD~1 <файл>   откат файла\n' +
         '  mlflow models list                   реестр моделей\n\n' +
         '  help — эта справка · Ctrl+L — очистка · ↑/↓ — история',
      c: 't-tbl'
    };
  }

  /* =============================================== модуль 1: сбор данных */

  if (/^systemctl\s+status\s+llm-api\s+--no-pager$/.test(t)) {
    return {
      t: '● llm-api.service — llm-api gateway\n' +
         '     Loaded: loaded (/etc/systemd/system/llm-api.service; enabled)\n' +
         '     Active: active (running) since Fri 2026-10-16 01:57:04 MSK; 27min ago\n' +
         '   Process: 4128 ExecStart=/usr/local/bin/llm-api --config /etc/llm-api/config.yaml\n' +
         '     Tasks: 11 (threads: 9)\n' +
         '\n' +
         '(!) Служба активна — значит, она не упала. Проблема в том, что она\n' +
         '    отвечает. Процесс жив, а клиенты получают 502 и 504.',
      c: 't-tbl'
    };
  }

  if (/^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s*tail\s+-n\s+\d+$/.test(t)) {
    var n = parseInt(t.match(/tail\s+-n\s+(\d+)/)[1], 10);
    var tail = IC_STATE.logs.slice(-Math.min(n, IC_STATE.logs.length));
    return {
      t: tail.map(icLogLine).join('\n') +
         '\n\nПоследние строки журнала. Читать надо не с конца, а по времени:\n' +
         'в 02:11 всё было 200, в 02:14 уже 504. Значит, поломалось между.',
      c: 't-tbl'
    };
  }

  if (/^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s*grep\s+-c\s+'"status": 5'$/.test(t)) {
    return {
      t: String(IC_STATE.errCount),
      c: IC_STATE.errCount ? 't-err' : 't-ok'
    };
  }

  if (/^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s+grep\s+'"status": 5'\s*\|\s*head\s+-n\s+\d+$/.test(t)) {
    var errs = IC_STATE.logs.filter(function (l) { return l.status >= 500; }).slice(0, 3);
    if (!errs.length) return { t: '(ничего не найдено)', c: 't-dim' };
    return {
      t: errs.map(icLogLine).join('\n') +
         '\n\nТри первых отказа. Дальше ловить причину, а не следствие:\n' +
         'все три — это ожидание ответа, а не ошибка бизнес-логики.',
      c: 't-tbl'
    };
  }

  /* =========================================== модуль 2: локализация */

  if (/^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=[a-z0-9_]+'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/.test(t)) {
    var q = t.match(/query=([a-z0-9_]+)/)[1];
    var val = {
      llm_p95_latency_seconds: IC_STATE.p95.toFixed(3),
      llm_tokens_total: String(IC_STATE.tokens),
      llm_requests_total: '18412'
    };
    if (!Object.prototype.hasOwnProperty.call(val, q)) {
      return { t: 'curl: (22) The requested URL returned error: 400 — unknown metric "' + q + '"', c: 't-err' };
    }
    var tail = "";
    if (q === 'llm_p95_latency_seconds') {
      tail = IC_STATE.restarted
        ? 'Было 14.207, стало ' + val[q] + '. Восстановились за 31 минуту.'
        : 'Было 0.84 секунды, стало ' + val[q] + '. Превышение в 17 раз.'
    } else if (q === 'llm_tokens_total') {
      tail = 'Миллионы токенов при нуле полезных ответов — токены жеглись впустую.';
    } else {
      tail = 'Запросов всего 18412: нагрузка не выросла, сломалась обработка.';
    }
    return {
      t: val[q] + '\n\n' + tail,
      c: 't-tbl'
    };
  }

  if (/^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s*grep\s+-o\s+'"ms":\[0-9\]\+'\s*\|\s*sort\s+-t:\s+-k2\s+-n\s*\|\s+tail\s+-1$/.test(t)) {
    var mx = IC_STATE.logs.reduce(function (a, b) { return b.ms > a.ms ? b : a; });
    return {
      t: '"ms":' + mx.ms + '\n\nСамая долгая обработка — ' + (mx.ms / 1000).toFixed(0) +
         ' секунд. Ровно на этом рубеже отваливается дефолтный таймаут.\n' +
         'Значит, обработка не возвращается вовсе, а не «медленно считает».',
      c: 't-tbl'
    };
  }

  if (/^stat\s+-c\s+['"]%y['"]\s+\/etc\/llm-api\/config\.yaml$/.test(t)) {
    return {
      t: '2026-10-16 01:58:41.220318040 +0300 /etc/llm-api/config.yaml\n' +
         '\n(!) Конфиг меняли в 01:58, первые отказы — в 02:14.\n' +
         '    Между ними 16 минут: кто-то перезапустил службу в 01:57\n' +
         '    и не проверил, что после рестарта она отвечает.',
      c: 't-tbl'
    };
  }

  if (/^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_requests_total'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/.test(t)) {
    return {
      t: '18412\n\nНагрузка обычная. Значит, дело не в клиентах,\n' +
         'а в том, что изменилось на сервере. Следующий вопрос — что именно.',
      c: 't-tbl'
    };
  }

  /* ================================================ модуль 3: версия */

  if (/^git\s+log\s+--oneline\s+--\s+llm-api\/config\.yaml$/.test(t)) {
    return {
      t: '7c1a4b2 config(llm-api): LLM_MAX_TOKENS 4096 -> 65536, enable_reasoning\n' +
         '2f9e0d8 config(llm-api): таймаут апстрима 30s\n' +
         'a04b6c1 config(llm-api): стартовые параметры\n' +
         '\n(!) Последний коммит вышел в 01:58 от deploy-bot.\n' +
         '    Автор — бот, потому что человек на дежурстве в это время\n' +
         '    правил конфиг вручную и забыл про ветку.',
      c: 't-tbl'
    };
  }

  if (/^git\s+diff\s+HEAD~1\s+--\s+llm-api\/config\.yaml$/.test(t)) {
    return {
      t: 'diff --git a/llm-api/config.yaml b/llm-api/config.yaml\n' +
         'index 8f2a1c4..3b9d7e0 100644\n' +
         '--- a/llm-api/config.yaml\n' +
         '+++ b/llm-api/config.yaml\n' +
         '@@ -12,7 +12,8 @@ server:\n' +
         '   port: 8080\n' +
         '   upstream_timeout: 30s\n' +
         '-  llm:\n' +
         '-    max_tokens: 4096\n' +
         '+  llm:\n' +
         '+    max_tokens: 65536\n' +
         '+    enable_reasoning: true\n' +
         '\nПричина найдена. max_tokens — это потолок генерации, а не запас.\n' +
         'Задали 65536, апстрим теперь не укладывается в таймаут 30 секунд.',
      c: 't-tbl'
    };
  }

  if (/^sha256sum\s+\/etc\/llm-api\/config\.yaml$/.test(t)) {
    return {
      t: (IC_STATE.restored
        ? '1f8b3d5a7c9e2b4d6f0a8c2e5b7d9f1a3c6e8b0d2f5a7c9e1b4d6f8a0c3e5b7'
        : '9d3f1a7c5e2b8d4f6a0c9e3b7d1f5a2c8e6b0d4f7a3c9e1b5d8f2a6c0e4b7d9')
        + '  /etc/llm-api/config.yaml\n' +
        '\n(!) Хеш обязателен в постмортеме: он доказывает, какой именно\n' +
        '    файл стоял на сервере в момент инцидента.',
      c: 't-tbl'
    };
  }

  /* ================================================ модуль 4: откат */

  if (/^mlflow\s+models\s+list$/.test(t)) {
    return {
      t: 'Name           Version   Created                          Description\n' +
         '-------------  -------  -------------------------------  ---------------------------\n' +
         'intent-class   1        2026-10-11 14:02:11 +0300        baseline, acc 0.88\n' +
         'intent-class   2        2026-10-13 10:41:55 +0300        ручная правка порога\n' +
         '\nПоследняя версия от 13 октября. В ночь инцидента релизов не было,\n' +
         'модель ни при чём — откатывать не её. Это важная проверка:\n' +
         'откатывать наугад дороже, чем потратить пять минут на проверку.',
      c: 't-tbl'
    };
  }

  if (/^git\s+restore\s+--source=HEAD~1\s+llm-api\/config\.yaml$/.test(t)) {
    if (IC_STATE.restored) return { t: 'файл уже соответствует HEAD~1, изменений не было', c: 't-dim' };
    IC_STATE.restored = true;
    IC_STATE.cfgTokens = 4096;
    return {
      t: '(git restore не печатает ничего)\n' +
        'llm-api/config.yaml восстановлен из HEAD~1 (7c1a4b2 → 2f9e0d8).\n' +
        'max_tokens снова 4096.\n' +
        '\n(!) Файл на диске изменён, но служба ещё держит старые значения\n' +
         '    в памяти. Без рестарта отката не произойдёт.',
      c: 't-dim'
    };
  }

  if (/^systemctl\s+restart\s+llm-api$/.test(t)) {
    if (!IC_STATE.restored) {
      return {
        t: '(!) Конфиг всё ещё с max_tokens 65536. Рестарт зафиксирует\n' +
           '    сломанную версию. Сначала откатите файл: git restore --source=HEAD~1 llm-api/config.yaml',
        c: 't-err'
      };
    }
    IC_STATE.restarted = true;
    IC_STATE.p95 = 0.841;
    IC_STATE.errCount = 0;
    IC_STATE.logs = IC_STATE.logs.filter(function (l) { return l.status < 500; })
      .concat([
        { ts: '02:41:12', status: 200, ms: 812, tok: 1390, path: '/v1/chat/completions' },
        { ts: '02:41:44', status: 200, ms: 788, tok: 1265, path: '/v1/chat/completions' }
      ]);
    return {
      t: '(systemctl не печатает ничего)\n' +
        'llm-api перезапущен в 02:41. Первые запросы после рестарта — 200.',
      c: 't-ok'
    };
  }

  if (/^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_p95_latency_seconds'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/.test(t)) {
    return {
      t: IC_STATE.p95.toFixed(3) + '\n\n' +
         (IC_STATE.restarted
          ? 'Было 14.207, стало ' + IC_STATE.p95.toFixed(3) + '. Восстановились за 31 минуту.\n' +
            'Проверять откат надо метрикой, а не «вроде перезапустилось».'
          : 'Пока без изменений. Сначала откатите конфиг и перезапустите службу.'),
      c: IC_STATE.restarted ? 't-ok' : 't-err'
    };
  }

  /* ========================================== модуль 5: постмортем */

  if (/^cp\s+templates\/postmortem\.md\s+docs\/postmortem\.md$/.test(t)) {
    if (IC_STATE.pmMade) return { t: 'cp: невозможно создать обычный файл «docs/postmortem.md»: Файл существует', c: 't-err' };
    IC_STATE.pmMade = true;
    return {
      t: '(cp не печатает ничего)\n' +
        'docs/postmortem.md создан из шаблона. В шаблоне номер инцидента —\n' +
        'заглушка INC-XXXX: её надо заменить, иначе отчёт нельзя найти.',
      c: 't-ok'
    };
  }

  if (/^sed\s+-i\s+'s\/INC-XXXX\/INC-4417\/'\s+docs\/postmortem\.md$/.test(t)) {
    if (!IC_STATE.pmMade) return { t: "sed: не удалось открыть docs/postmortem.md: Нет такого файла или каталога", c: 't-err' };
    if (IC_STATE.pmFilled) return { t: 'sed: шаблон INC-XXXX уже заменён, совпадений нет', c: 't-dim' };
    IC_STATE.pmFilled = true;
    return {
      t: '(sed -i не печатает ничего)\n' +
        'Номер проставлен. Теперь документ можно коммитить: без номера\n' +
        'его не найти в общем трекере инцидентов.',
      c: 't-ok'
    };
  }

  if (/^git\s+commit\s+-am\s+"postmortem: INC-4417, деградация llm-api 02:14-02:41"$/.test(t)) {
    if (!IC_STATE.pmFilled) {
      return {
        t: 'On branch incident/2026-10-16\n' +
           'nothing to commit, working tree clean',
        c: 't-err'
      };
    }
    return {
      t: '[incident/2026-10-16 8f2b1d0] postmortem: INC-4417, деградация llm-api 02:14-02:41\n' +
         ' 1 file changed, 47 insertions(+)\n' +
         '\n(!) Постмортем без владельца и без action items — это не отчёт,\n' +
         '    а архив. Действия уходят отдельными задачами с датой.',
      c: 't-ok'
    };
  }

  /* ---------------------------------------------------------- неизвестное */
  return {
    t: 'bash: ' + t.split(' ')[0] + ': команда не найдена\n' +
       'В этом курсе: systemctl, journalctl, curl, jq, grep, stat, git, sha256sum, cp, sed, mlflow.\n' +
       'Полный список — help.',
    c: 't-err'
  };
}

/* ============================================================ МОДУЛИ/ЗАДАНИЯ */

var IC_MODS = [
  { id: 1, n: 'Сбор данных', c: 'var(--tr-cyan)' },
  { id: 2, n: 'Локализация', c: 'var(--tr-orange)' },
  { id: 3, n: 'Версия конфигурации', c: 'var(--tr-accent)' },
  { id: 4, n: 'Откат', c: 'var(--tr-accent2)' },
  { id: 5, n: 'Постмортем', c: 'var(--tr-red)' }
];

var IC_LS = [
  /* ---------------------------------------------------------- модуль 1 */
  {
    id: 1, m: 1, t: 'Состояние службы',
    task: 'Проверьте службу: systemctl status llm-api --no-pager',
    re: /^systemctl\s+status\s+llm-api\s+--no-pager$/,
    th: 'Первый вопрос на дежурстве: работает или нет. Здесь ответ ' +
        'неудобный — служба <em>активна</em>, но это ничего не значит. ' +
        'Процесс жив, а клиенты получают отказы. Поэтому « systemctl ' +
        'status» говорит не «всё хорошо», а «процесс существует». ' +
        'Дальше нужны логи и метрики.',
    h: ['Юнит называется llm-api.',
        'Флаг --no-pager, чтобы вывод не ушёл в пайп постраничника.',
        'systemctl status llm-api --no-pager'],
    xp: 25
  },
  {
    id: 2, m: 1, t: 'Журнал за окно инцидента',
    task: 'Посмотрите последние строки: journalctl -u llm-api --since "02:00" --no-pager | tail -n 20',
    re: /^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s*tail\s+-n\s+20$/,
    th: '<code>journalctl --since</code> отбирает журнал по времени, ' +
        '<code>-u</code> — по юниту. Без окна времени вы получите ' +
        'полсотни мегабайт за неделю. Читать журнал надо хронологически: ' +
        'именно так видно границу, где «200» превратились в «504».',
    h: ['Ключи: -u llm-api и --since с временем в кавычках.',
        'В конце — tail -n и число строк.',
        'journalctl -u llm-api --since "02:00" --no-pager | tail -n 20'],
    xp: 35
  },
  {
    id: 3, m: 1, t: 'Считаем отказы',
    task: 'Посчитайте 5xx: journalctl -u llm-api --since "02:00" --no-pager | grep -c \'"status": 5\'',
    re: /^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s*grep\s+-c\s+'"status": 5'$/,
    th: 'Одна цифра вместо двух экранов логов. <code>grep -c</code> ' +
        'считает строки, а не вхождения — для подсчёта отказов это то ' +
        'что нужно. Обратите внимание на шаблон: ищем <code>"status": 5</code>, ' +
        'то есть <em>начало</em> кода 5xx. Так сработает и на 502, и на 504, ' +
        'и на 500.',
    h: ['Ключи те же, что в прошлом задании.',
        'Нужен счётчик grep -c и шаблон в кавычках.',
        'journalctl -u llm-api --since "02:00" --no-pager | grep -c \'"status": 5\''],
    xp: 35
  },
  {
    id: 4, m: 1, t: 'Первые отказы',
    task: 'Возьмите три первых: journalctl -u llm-api --since "02:00" --no-pager | grep \'"status": 5\' | head -n 3',
    re: /^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s+grep\s+'"status": 5'\s*\|\s+head\s+-n\s+3$/,
    th: 'Количество отказов показывает масштаб, первые три — тип. ' +
        'Здесь видно, что все они про ожидание ответа, а не про бизнес-логику. ' +
        'Это важно: искать надо причину, из-за которой запрос не ' +
        'возвращается, а не следствие в виде отказов.',
    h: ['К предыдущей команде добавьте head -n 3.',
        'Шаблон остаётся тем же: "status": 5.',
        'journalctl -u llm-api --since "02:00" --no-pager | grep \'"status": 5\' | head -n 3'],
    xp: 30
  },

  /* ---------------------------------------------------------- модуль 2 */
  {
    id: 5, m: 2, t: 'Метрика задержки',
    task: 'Узнайте p95: curl -s \'http://localhost:9090/api/v1/query?query=llm_p95_latency_seconds\' | jq -r \'.data.result[0].value[1]\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_p95_latency_seconds'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/,
    th: 'Среднее время ответа в такие инциденты почти всегда выглядит ' +
        'нормально: несколько быстрых запросов тянут вниз длинный хвост. ' +
        'Поэтому смотрят на 95-й перцентиль — он показывает, что ' +
        'половина пользователей ждёт плохо. Плюс это готовая метрика ' +
        'для алерта, который надо настроить.',
    h: ['Prometheus на порту 9090, метрика llm_p95_latency_seconds.',
        'Значение достаётся jq -r по пути до .value.',
        "curl -s 'http://localhost:9090/api/v1/query?query=llm_p95_latency_seconds' | jq -r '.data.result[0].value[1]'"],
    xp: 40
  },
  {
    id: 6, m: 2, t: 'Самая долгая обработка',
    task: 'Найдите худший запрос: journalctl -u llm-api --since "02:00" --no-pager | grep -o \'"ms":[0-9]+\' | sort -t: -k2 -n | tail -1',
    re: /^journalctl\s+-u\s+llm-api\s+--since\s+"02:00"\s+--no-pager\s*\|\s*grep\s+-o\s+'"ms":\[0-9\]\+'\s*\|\s*sort\s+-t:\s+-k2\s+-n\s*\|\s+tail\s+-1$/,
    th: '<code>grep -o</code> вытаскивает только значение поля, ' +
        '<code>sort -t: -k2 -n</code> сортирует <em>численно</em> по ' +
        'второй части после двоеточия, <code>tail -1</code> берёт ' +
        'последнее — то есть максимум. Без <code>-n</code> sort ' +
        'разложит «9» после «100», и вы найдёте не худший запрос, ' +
        'а самый короткий из трёхзначных.',
    h: ['Тот же journalctl с окном времени.',
        'grep -o вытащит поле ms, sort -t: -k2 -n отсортирует числами.',
        'journalctl -u llm-api --since "02:00" --no-pager | grep -o \'"ms":[0-9]+\' | sort -t: -k2 -n | tail -1'],
    xp: 50
  },
  {
    id: 7, m: 2, t: 'Когда менялся конфиг',
    task: 'Проверьте время правки: stat -c \'%y\' /etc/llm-api/config.yaml',
    re: /^stat\s+-c\s+['"]%y['"]\s+\/etc\/llm-api\/config\.yaml$/,
    th: 'Дежурный ход, который экономит часы: сравнить время изменения ' +
        'конфигурации с временем деградации. <code>stat -c \'%y\'</code> ' +
        'печатает дату и время с точностью до наносекунд. Если файл ' +
        'правили за час до аварии — смотреть надо туда, а не в код.',
    h: ['Файл /etc/llm-api/config.yaml.',
        'stat с ключом -c и форматом %y — дата изменения.',
        "stat -c '%y' /etc/llm-api/config.yaml"],
    xp: 35
  },
  {
    id: 8, m: 2, t: 'Проверяем нагрузку',
    task: 'Сравните с числом запросов: curl -s \'http://localhost:9090/api/v1/query?query=llm_requests_total\' | jq -r \'.data.result[0].value[1]\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_requests_total'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/,
    th: 'Обязательный вопрос перед любыми выводами: выросла ли нагрузка? ' +
        'Если число запросов обычное, а отказы пошли — клиент не ' +
        'виноват, и искать надо на сервере. Если бы запросов стало ' +
        'втрое, разговор был бы другим: тогда дело в ' +
        'DDOS или в бесконечном ретрае клиента.',
    h: ['Та же схема, что в задании 5, но другая метрика.',
        'Интересует общее число запросов: llm_requests_total.',
        "curl -s 'http://localhost:9090/api/v1/query?query=llm_requests_total' | jq -r '.data.result[0].value[1]'"],
    xp: 35
  },

  /* ---------------------------------------------------------- модуль 3 */
  {
    id: 9, m: 3, t: 'История конфигурации',
    task: 'Кто менял: git log --oneline -- llm-api/config.yaml',
    re: /^git\s+log\s+--oneline\s+--\s+llm-api\/config\.yaml$/,
    th: 'Конфигурация в git — не формальность, а способ узнать, что ' +
        'изменилось и кто. <code>git log -- путь</code> показывает ' +
        'историю одного файла. Смотрите не только на сообщение ' +
        'коммита, но и на автора: если правку внёс бот, вопрос уже не ' +
        '«где ошибка», а «кто и почему разрешил боту это менять».',
    h: ['История одного файла: git log и путь после --.',
        'Формат покороче: --oneline.',
        'git log --oneline -- llm-api/config.yaml'],
    xp: 35
  },
  {
    id: 10, m: 3, t: 'Что именно поменяли',
    task: 'Покажите последнее изменение: git diff HEAD~1 -- llm-api/config.yaml',
    re: /^git\s+diff\s+HEAD~1\s+--\s+llm-api\/config\.yaml$/,
    th: '<code>HEAD~1</code> — предыдущий коммит. Дифф покажет ' +
        'две строчки: <code>max_tokens</code> вырос с 4096 до 65536. ' +
        'Здесь важна природа параметра: <code>max_tokens</code> — это ' +
        'потолок <em>генерации</em>, а не запас памяти. Значение 65536 ' +
        'не «даст больше качества», оно заставит модель генерировать ' +
        'дольше, чем апстрим готов ждать.',
    h: ['Сравнить с предыдущим коммитом: HEAD~1.',
        'Дальше -- и путь к файлу конфигурации.',
        'git diff HEAD~1 -- llm-api/config.yaml'],
    xp: 45
  },
  {
    id: 11, m: 3, t: 'Фиксируем состояние',
    task: 'Посчитайте хеш файла: sha256sum /etc/llm-api/config.yaml',
    re: /^sha256sum\s+\/etc\/llm-api\/config\.yaml$/,
    th: 'Перед любыми изменениями зафиксируйте, что стоит на сервере. ' +
        'Хеш попадает в протокол инцидента и потом доказывает, что ' +
        'разбирались именно с тем файлом, который упал. Это занимает ' +
        'секунду и экономит спор «а у нас конфиг был другой».',
    h: ['sha256sum и путь к файлу на сервере.',
        'Выведется хеш и имя файла.',
        'sha256sum /etc/llm-api/config.yaml'],
    xp: 25
  },

  /* ---------------------------------------------------------- модуль 4 */
  {
    id: 12, m: 4, t: 'Проверяем модель',
    task: 'Убедитесь, что релизов не было: mlflow models list',
    re: /^mlflow\s+models\s+list$/,
    th: 'Прежде чем откатывать, убедитесь, что откатывать. Здесь модель ' +
        'не трогали с 13 октября — значит, версия другая и откат модели ' +
        'не поможет. Проверка занимает десять секунд и снимает риск ' +
        '«откатили не то и стало только хуже».',
    h: ['Реестр моделей: mlflow models list.',
        'Флагов не требуется.',
        'mlflow models list'],
    xp: 30
  },
  {
    id: 13, m: 4, t: 'Откатываем конфиг',
    task: 'Верните файл к предыдущей версии: git restore --source=HEAD~1 llm-api/config.yaml',
    re: /^git\s+restore\s+--source=HEAD~1\s+llm-api\/config\.yaml$/,
    th: '<code>git restore --source=HEAD~1</code> берёт содержимое файла ' +
        'из указанного коммита и кладёт в рабочую копию. Это откат ' +
        'без создания нового коммита — именно то, что нужно на ' +
        'продакшне. Старый синтаксис ' +
        '<code>git checkout -- файл</code> делает то же самое, но новым ' +
        'командным словом.',
    h: ['git restore с указанием источника через --source.',
        'Источник — предыдущий коммит HEAD~1, затем путь к файлу.',
        'git restore --source=HEAD~1 llm-api/config.yaml'],
    xp: 45
  },
  {
    id: 14, m: 4, t: 'Перезапускаем службу',
    task: 'Примените изменения: systemctl restart llm-api',
    re: /^systemctl\s+restart\s+llm-api$/,
    th: 'Файл изменён — но процесс держит старое значение в памяти. ' +
        'Без перезапуска отката не происходит, и дежурный час будет ' +
        'убеждать, что «файл поправили, а не помогает». Поэтому ' +
        'откат — это всегда пара команд: изменить и перезапустить.',
    h: ['Подкоманда restart у systemctl, имя юнита.',
        'Вывода у systemctl нет — это нормально.',
        'systemctl restart llm-api'],
    xp: 25
  },
  {
    id: 15, m: 4, t: 'Проверяем результат',
    task: 'Убедитесь, что метрика в норме: curl -s \'http://localhost:9090/api/v1/query?query=llm_p95_latency_seconds\' | jq -r \'.data.result[0].value[1]\'',
    re: /^curl\s+-s\s+'http:\/\/localhost:9090\/api\/v1\/query\?query=llm_p95_latency_seconds'\s*\|\s*jq\s+-r\s+'\.data\.result\[0\]\.value\[1\]'$/,
    th: 'Откат не считается сделанным, пока это не подтверждено ' +
        'метрикой. Сравните с исходными 14.207 секунд. Именно эта цифра ' +
        'пойдёт в постмортем как «восстановлено за N минут», и именно ' +
        'она станет частью вывода: сколько минут бизнес был недоступен.',
    h: ['Та же метрика, что в задании 5.',
        'Проверяем после отката, значение должно упасть.',
        "curl -s 'http://localhost:9090/api/v1/query?query=llm_p95_latency_seconds' | jq -r '.data.result[0].value[1]'"],
    xp: 35
  },

  /* ---------------------------------------------------------- модуль 5 */
  {
    id: 16, m: 5, t: 'Черновик из шаблона',
    task: 'Создайте отчёт: cp templates/postmortem.md docs/postmortem.md',
    re: /^cp\s+templates\/postmortem\.md\s+docs\/postmortem\.md$/,
    th: 'Постмортем пишут не с нуля: в компании есть шаблон с ' +
        'проверенными разделами. <code>cp</code> копирует его в рабочий ' +
        'каталог, дальше останется заполнить. Плюс так все отчёты ' +
        'одинаковые, а разбираться в них потом можно за минуты — ' +
        'а не искать нужный раздел по чужому вольному стилю.',
    h: ['Копируем из templates в docs.',
        'cp источник назначение.',
        'cp templates/postmortem.md docs/postmortem.md'],
    xp: 25
  },
  {
    id: 17, m: 5, t: 'Проставляем номер',
    task: 'Замените заглушку номером инцидента: sed -i \'s/INC-XXXX/INC-4417/\' docs/postmortem.md',
    re: /^sed\s+-i\s+'s\/INC-XXXX\/INC-4417\/'\s+docs\/postmortem\.md$/,
    th: 'В шаблоне номер остаётся заглушкой <code>INC-XXXX</code>. ' +
        'Замена через <code>s/найти/заменить/</code> без флага <code>g</code> ' +
        'меняет только первое вхождение в строке — для номера в первой ' +
        'же строке этого достаточно. Проверьте потом: если номер не ' +
        'проставлен, отчёт физически не найдётся в трекере.',
    h: ['sed -i правит файл на месте.',
        'Замена: s/старое/новое/, имя файла в конце.',
        "sed -i 's/INC-XXXX/INC-4417/' docs/postmortem.md"],
    xp: 35
  },
  {
    id: 18, m: 5, t: 'Фиксируем отчёт',
    task: 'Закоммитьте постмортем: git commit -am "postmortem: INC-4417, деградация llm-api 02:14-02:41"',
    re: /^git\s+commit\s+-am\s+"postmortem: INC-4417, деградация llm-api 02:14-02:41"$/,
    th: 'Флаги <code>-a</code> (все изменённые) и <code>-m</code> ' +
        '(сообщение одной строкой). Сообщение должно содержать номер ' +
        'инцидента и окно сбоя — по нему отчёт потом найдёшь среди ' +
        'других коммитов. Сам постмортем без action items бесполезен: ' +
        'каждое действие уходит отдельной задачей со сроком и владельцем.',
    h: ['git commit с флагами -a и -m.',
        'Сообщение в двойных кавычках, начните с номера инцидента.',
        'git commit -am "postmortem: INC-4417, деградация llm-api 02:14-02:41"'],
    xp: 45
  }
];

IC_STATE.reset();

/* ============================================================ РЕГИСТРАЦИЯ */

COURSES.incident = {
  i: '🚨', n: 'ИНЦИДЕНТ · ПОСТМОРТЕМ', c: 'var(--tr-err)',
  pr: IC_PROMPT,
  ti: 'sre@prod-llm — INC-4417, 02:14—02:41',
  note: 'Сквозной сценарий диплома: один инцидент от алерта до ' +
        'постмортема. Команды настоящие (systemctl, journalctl, curl, jq, ' +
        'git, sha256sum, sed, mlflow), но сам сервис и его журналы ' +
        'живут внутри курса.',
  mods: IC_MODS, ls: IC_LS,
  run: function (raw) {
    var r = null;
    try { r = icRun(raw); } catch (e) {
      r = { t: 'bash: внутренняя ошибка обработки команды: ' + (e && e.message ? e.message : e), c: 't-err' };
    }
    if (typeof renderEnv === 'function') { try { renderEnv(); } catch (e2) {} }
    return r;
  },
  reset: function () { IC_STATE.reset(); },
  env: function () { return IC_STATE.env(); }
};
