/* ==========================================================================
   Курс «PYTHON · ML»
   Месяц 1 плана: Python для архитектора и математика без формул.

   Не «упражнения по программированию», а то, что нужно, чтобы читать код
   ML-инженера и принимать решения: изолированное окружение, заморозка
   зависимостей, асинхронность, тензоры на numpy, типы и тесты.

   Команды настоящие: python, python3 -m venv, pip, pytest, mypy, curl.
   ========================================================================== */

var PY_PROMPT = 'ml@work:~/proj$';

/* ------------------------------------------------------------ состояние */

var PY = {
  venv: false,
  active: false,
  installed: [],
  frozen: false,
  tested: false,
  typed: false,

  reset: function () {
    this.venv = false; this.active = false; this.installed = [];
    this.frozen = false; this.tested = false; this.typed = false;
  },

  pipList: function () {
    var base = ['numpy==2.1.3', 'pandas==2.2.3', 'requests==2.32.3'];
    return base.concat(this.installed);
  },

  env: function () {
    return envBlock('ОКРУЖЕНИЕ',
        erow('venv создан', this.venv ? '.venv' : '—', this.venv ? 'var(--tr-ok)' : 'var(--tr-dim)') +
        erow('venv активен', this.active ? 'да' : 'нет', this.active ? 'var(--tr-ok)' : 'var(--tr-err)') +
        erow('пакетов в pip', this.pipList().length))
      + envBlock('ФАЙЛЫ',
        erow('train.py', 'есть') +
        erow('fetch_sync.py', 'есть') +
        erow('fetch_async.py', 'есть') +
        erow('requirements.txt', this.frozen ? 'есть' : '—', this.frozen ? 'var(--tr-ok)' : 'var(--tr-dim)'))
      + envBlock('ПРОВЕРКИ',
        erow('pytest', this.tested ? 'зелёный' : 'не запускался', this.tested ? 'var(--tr-ok)' : 'var(--tr-dim)') +
        erow('mypy', this.typed ? 'ошибок нет' : 'не запускался', this.typed ? 'var(--tr-ok)' : 'var(--tr-dim)'));
  },

  run: function (raw) { return pyRun(raw); }
};

/* =========================================================== обработчик == */

function pyRun(raw) {
  var t = raw.trim();
  if (!t) return null;

  if (/^(help|\?|--help)$/.test(t)) {
    return {
      t: '─── ' + COURSES.python.i + ' PYTHON · ML · команды ───\n\n' +
         '  python3 --version                       версия интерпретатора\n' +
         '  python3 -m venv .venv                   виртуальное окружение\n' +
         '  . .venv/bin/activate                    войти в окружение\n' +
         '  pip install <пакет>                     поставить пакет\n' +
         '  pip freeze > requirements.txt           заморозить зависимости\n' +
         '  pip check                               проверить согласованность\n' +
         '  python <скрипт>.py [аргументы]          запустить скрипт\n' +
         '  python -c \'<код>\'                       однострочник\n' +
         '  python -m pytest -q                     тесты\n' +
         '  python -m mypy <файл>.py                проверка типов\n' +
         '  grep -n \'<шаблон>\' <файл>               поиск по коду\n\n' +
         '  help — эта справка · Ctrl+L — очистка · ↑/↓ — история',
      c: 't-tbl'
    };
  }

  /* ================================================= модуль 1: окружение */

  if (/^python3?\s+--version$/.test(t)) {
    return { t: 'Python 3.12.7', c: 't-tbl' };
  }

  if (/^python3?\s+-m\s+venv\s+\.venv$/.test(t)) {
    if (PY.venv) return { t: ' создавать .venv … уже есть, ничего не делаем.', c: 't-dim' };
    PY.venv = true;
    return {
      t: ' создание виртуального окружения в .venv …done\n' +
         ' (venv)  жесткие ссылки не поддерживаются → копируются\n' +
         ' инициализация сделана. Активируйте: . .venv/bin/activate',
      c: 't-ok'
    };
  }

  if (/^\.\s+\.venv\/bin\/activate$/.test(t)) {
    if (!PY.venv) return { t: 'bash: .venv/bin/activate: No such file or directory', c: 't-err' };
    PY.active = true;
    return {
      t: '(ml@work:~/proj$) PATH=/home/ml/proj/.venv/bin:$PATH\n' +
         'VIRTUAL_ENV=/home/ml/proj/.venv\n\n' +
         'Приглашение теперь начинается с (venv). Это значит, что pip\n' +
         'ставит пакеты в проект, а не в системный Python.',
      c: 't-ok'
    };
  }

  if (/^pip\s+install\s+[a-z][a-z0-9-]*$/.test(t)) {
    if (!PY.active) {
      return {
        t: 'WARNING: You are using pip version 24.0; however, it is not installed in\n' +
           "virtualenv created by this app.\n" +
           'defaulting to user installation\n' +
           'Successfully installed ' + t.split(' ')[2] + '-1.0.0\n' +
           '\n(!) Пакет ушёл в ~/.local, а не в проект. Через месяц вы\n' +
           '    не вспомните, откуда он взялся. Сначала активируйте venv.',
        c: 't-err'
      };
    }
    var pkg = t.split(' ')[2];
    if (PY.installed.indexOf(pkg) > -1) {
      return { t: 'Requirement already satisfied: ' + pkg + '\n' + pkg + '-1.0.0 уже установлен', c: 't-dim' };
    }
    PY.installed.push(pkg);
    return {
      t: 'Collecting ' + pkg + '\n' +
         '  Downloading ' + pkg + '-1.0.0-py3-none-any.whl (48 kB)\n' +
         'Installing collected packages: ' + pkg + '\n' +
         'Successfully installed ' + pkg + '-1.0.0\n' +
         '\nЗафиксируйте зависимости: pip freeze > requirements.txt',
      c: 't-ok'
    };
  }

  if (/^pip\s+freeze\s*>\s*requirements\.txt$/.test(t)) {
    if (!PY.active) return { t: 'bash: .venv/bin/activate: No such file or directory', c: 't-err' };
    PY.frozen = true;
    return {
      t: '(pip freeze не печатает ничего — он пишет в файл)\n' +
         'В requirements.txt ' + PY.pipList().length + ' строк.\n' +
         '\nЭтот файл — то, что делает чужой запуск воспроизводимым.',
      c: 't-ok'
    };
  }

  if (/^cat\s+requirements\.txt$/.test(t)) {
    if (!PY.frozen) return { t: "cat: requirements.txt: No such file or directory", c: 't-err' };
    return { t: PY.pipList().join('\n'), c: 't-tbl' };
  }

  if (/^pip\s+check$/.test(t)) {
    if (!PY.frozen) return { t: 'WARNING: You are using pip version 24.0; however, it is not installed in a virtualenv.', c: 't-err' };
    return { t: 'No broken requirements found.', c: 't-ok' };
  }

  /* ================================================ модуль 2: чужой код */

  if (/^cat\s+-n\s+train\.py$/.test(t)) {
    return {
      t: '     1  """Обучение классификатора интентов."""\n' +
         '     2  import argparse\n' +
         '     3  import numpy as np\n' +
         '     4\n' +
         '     5  def load(path: str) -> np.ndarray:\n' +
         '     6      return np.loadtxt(path, delimiter=",")\n' +
         '     7\n' +
         '     8  def train(x: np.ndarray, y: np.ndarray, lr: float = 0.01) -> float:\n' +
         '     9      w = np.zeros(x.shape[1])\n' +
         '    10      for _ in range(200):\n' +
         '    11          err = y - x.dot(w)\n' +
         '    12          w += lr * x.T.dot(err) / len(x)\n' +
         '    13      return float(np.sqrt((err ** 2).mean()))\n' +
         '\n' +
         'Читать такой код — и есть работа архитектора: типы в аннотациях\n' +
         'говорят о форме данных, а тело показывает, где живёт обучение.',
      c: 't-tbl'
    };
  }

  if (/^python\s+train\.py\s+--epochs\s+\d+$/.test(t)) {
    if (!PY.active) return { t: 'ModuleNotFoundError: No module named \'numpy\' — окружение не активировано', c: 't-err' };
    var ep = parseInt(t.match(/--epochs\s+(\d+)/)[1], 10);
    var loss = Math.max(0.08, 1.2 / Math.sqrt(ep)).toFixed(4);
    return {
      t: 'эпох: ' + ep + ', learning rate: 0.01\n' +
         'loss: ' + loss + '\n' +
         'features: 128, samples: 4096\n' +
         '\nСкрипт отработал и напечатал метрику. Теперь её можно\n' +
         'сравнить с прошлым прогоном — прогон должен быть воспроизводим.',
      c: 't-ok'
    };
  }

  if (/^python\s+-c\s+'import sys; print\(sys\.version\)'$/.test(t)) {
    return {
      t: '3.12.7 (main, Sep  4 2026, 09:31:22) [GCC 12.2.0]',
      c: 't-tbl'
    };
  }

  if (/^python\s+-c\s+'import numpy; print\(numpy\.__version__\)'$/.test(t)) {
    if (!PY.active) return { t: 'ModuleNotFoundError: No module named \'numpy\'', c: 't-err' };
    return {
      t: '2.1.3\n\n' +
        'Версия читается одной командой. Спор «у нас numpy 1.x, а тут\n' +
        'считает иначе» решается выводом, а не переустановкой.',
      c: 't-tbl'
    };
  }

  /* ============================================== модуль 3: асинхронность */

  if (/^grep\s+-n\s+'async def'\s+fetch_async\.py$/.test(t)) {
    return {
      t: '7:async def fetch_one(session, url):\n' +
         '8:    async with session.get(url) as r:\n' +
         '        return await r.text()\n' +
         '19:async def main():\n' +
         '\n' +
         'async/await идут парами: где await, там обязателен async.\n' +
         'Это первое, на что стоит смотреть в чужом асинхронном коде.',
      c: 't-tbl'
    };
  }

  if (/^python\s+fetch_sync\.py$/.test(t)) {
    return {
      t: 'GET  /pricing  … 200  0.9s\n' +
         'GET  /docs     … 200  1.1s\n' +
         'GET  /status   … 200  1.2s\n' +
         'итого 3.2s\n' +
         '\nТри запроса подряд, каждый ждёт предыдущий. Суммируем\n' +
         'время — получаем 3.2 секунды, хотя сеть была свободна.',
      c: 't-tbl'
    };
  }

  if (/^python\s+fetch_async\.py$/.test(t)) {
    return {
      t: 'GET  /pricing  … 200  0.6s\n' +
         'GET  /docs     … 200  0.6s\n' +
         'GET  /status   … 200  0.6s\n' +
         'итого 0.6s\n' +
         '\nТе же три запроса ушли одновременно и ждали вместе.\n' +
         'Ускорение в 5 раз при той же нагрузке на сеть.',
      c: 't-ok'
    };
  }

  if (/^curl\s+-s\s+-o\s+\/dev\/null\s+-w\s+'%\{time_total\}'\s+https:\/\/kb\.corp\.local\/pricing$/.test(t)) {
    return {
      t: '0.894213\n\nЗамер одной операции настоящей командой. Когда\n' +
        'обсуждаете бюджет на инференс, считайте так, а не «на глаз».',
      c: 't-tbl'
    };
  }

  /* ================================================== модуль 4: numpy */

  if (/^python\s+-c\s+'import numpy as np; a=np\.zeros\(\(4096,128\)\); print\(a\.shape\)'$/.test(t)) {
    return {
      t: '(4096, 128)\n\n' +
        'zeros не создаёт 4096*128 = 524288 чисел в памяти — это\n' +
        'почти нули, которые выделяются лениво. Форма (кортеж) —\n' +
        'главный размер, который стоит проверять при отладке.',
      c: 't-tbl'
    };
  }

  if (/^python\s+-c\s+'import numpy as np; a=np\.array\(\[\[1,2\],\[3,4\]\]\); print\(a\.T\)'$/.test(t)) {
    return {
      t: '[[1 3]\n [2 4]]\n\n' +
        'Транспонирование — это перестановка осей, а не копирование\n' +
        'чисел. Ошибка размерности в машинном обучении чаще всего\n' +
        'живёт именно здесь.',
      c: 't-tbl'
    };
  }

  if (/^python\s+-c\s+'import numpy as np; a=np\.array\(\[1,2,3,4\]\); print\(a\[\[0,2\]\]\)'$/.test(t)) {
    return {
      t: '[1 3]\n\n' +
        'Индексация создаёт новый массив — копию элементов.\n' +
        'Для больших тензоров это дорого: берите срез, а не список\n' +
        'произвольных индексов, если он не нужен целиком.',
      c: 't-tbl'
    };
  }

 if (/^python\s+-c\s+'import numpy as np; a=np\.array\(\[\[1,2\],\[3,4\]\]\); print\(float\(np\.dot\(a,a\.T\)\)\)'$/.test(t)) {
    return {
      t: '30.0\n\n' +
        'Матричное умножение — это ядро линейной регрессии и\n' +
        'градиентного спуска. Не считайте его руками на реальных\n' +
        'данных: используйте np.dot, он считает в разы быстрее.',
      c: 't-tbl'
    };
  }

  /* =========================================== модуль 5: типы и тесты */

  if (/^python\s+-m\s+pytest\s+-q$/.test(t)) {
    PY.tested = true;
    return {
      t: '................................                     [100%]\n' +
         '32 passed in 1.84s\n' +
         '\nТесты зелёные — но это ещё не значит, что модель права.\n' +
         'Тесты проверяют код, качество проверяют на золотом наборе.',
      c: 't-ok'
    };
  }

  if (/^python\s+-m\s+mypy\s+train\.py$/.test(t)) {
    PY.typed = true;
    return {
      t: 'train.py:14: error: Argument 1 to "train" has incompatible type "list[Any]"; expected "ndarray"  [arg-type]\n' +
         'train.py:22: error: Returning Any from function declared to return "float"  [no-any-return]\n' +
         'Found 2 errors in 1 file (checked 1 source file)\n' +
         '\n(!) Обе ошибки — про типы, не про логику. Именно их\n' +
         '    ловит mypy и пропускает обычный запуск.',
      c: 't-err'
    };
  }

  if (/^python\s+-m\s+mypy\s+train\.py\s+--ignore-errors$/.test(t)) {
    return {
      t: 'Success: no issues found in 1 source file\n\n' +
        'Ошибки просто скрыты, а не исправлены. Для пилота это\n' +
        'нормально, для продакшена — нет.',
      c: 't-dim'
    };
  }

  /* ---------------------------------------------------------- неизвестное */
  return {
    t: 'bash: ' + t.split(' ')[0] + ': command not found\n' +
       'В этом курсе: python, python3, pip, pytest, mypy, grep, cat, curl.\n' +
       'Полный список — help.',
    c: 't-err'
  };
}

/* ============================================================ МОДУЛИ/ЗАДАНИЯ */

var PY_MODS = [
  { id: 1, n: 'Окружение и зависимости', c: 'var(--tr-cyan)' },
  { id: 2, n: 'Читаем чужой код', c: 'var(--tr-accent)' },
  { id: 3, n: 'Асинхронность', c: 'var(--tr-orange)' },
  { id: 4, n: 'Тензоры на numpy', c: 'var(--tr-accent2)' },
  { id: 5, n: 'Типы и тесты', c: 'var(--tr-red)' }
];

var PY_LS = [
  /* ---------------------------------------------------------- модуль 1 */
  {
    id: 1, m: 1, t: 'Версия интерпретатора',
    task: 'Узнайте версию: python3 --version',
    re: /^python3?\s+--version$/,
    th: 'Начинать всегда с версии. Разница между 3.9 и 3.12 — это ' +
        'не мелочь: меняются параметры по умолчанию, доступен ' +
        'новый синтаксис, сторонние пакеты ведут себя иначе. Когда ' +
        'чужой код «не работает у меня», первая проверка — версия.',
    h: ['python3 или python — обычно оба указывают на один бинарник.',
        'Нужен длинный флаг --version.',
        'python3 --version'],
    xp: 25
  },
  {
    id: 2, m: 1, t: 'Виртуальное окружение',
    task: 'Создайте окружение проекта: python3 -m venv .venv',
    re: /^python3?\s+-m\s+venv\s+\.venv$/,
    th: 'venv создаёт отдельный интерпретатор и библиотеки проекта. ' +
        'Без него одна установка на всю машину: утром работает, ' +
        'после чужого `pip install` — нет. Отдельное окружение — ' +
        'это то, что делает проект переносимым. Флаг <code>-m</code> ' +
        'не лишний: без него Python ищет одноимённый скрипт ' +
        'в PATH, и можно запустить не тот venv, что лежит в проекте.',
    h: ['Модуль venv запускается через python -m.',
        'Каталог по умолчанию называется .venv.',
        'python3 -m venv .venv'],
    xp: 35
  },
  {
    id: 3, m: 1, t: 'Вход в окружение',
    task: 'Активируйте его: . .venv/bin/activate',
    re: /^\.\s+\.venv\/bin\/activate$/,
    th: 'В точке входа командой ставится <code>source</code>, она же ' +
        'работает как <code>.</code>. Скрипт активации меняет ' +
        '<code>PATH</code> и <code>VIRTUAL_ENV</code> в текущей ' +
        'оболочке — поэтому каждая новая вкладка терминала требует ' +
        'повтора. Признак, что вы внутри, — префикс <code>(venv)</code> ' +
        'в приглашении.',
    h: ['Команда начинается с одной точки и пробела.',
        'Дальше путь к activate внутри .venv.',
        '. .venv/bin/activate'],
    xp: 30
  },
  {
    id: 4, m: 1, t: 'Ставим пакет',
    task: 'Установите scikit-learn: pip install scikit-learn',
    re: /^pip\s+install\s+scikit-learn$/,
    th: 'Внутри окружения <code>pip</code> ставит пакет в проект, ' +
        'а не в систему. Имя пакета на PyPI и имя, которое вы ' +
        'импортируете, часто различаются: ставится ' +
        '<code>scikit-learn</code>, а пишется ' +
        '<code>import sklearn</code>. Путаница между ними — ' +
        'причина половины вопросов «ModuleNotFoundError».',
    h: ['Просто pip install и имя пакета без версии.',
        'Обратите внимание: pip install scikit-learn, а не sklearn.',
        'pip install scikit-learn'],
    xp: 30
  },
  {
    id: 5, m: 1, t: 'Заморозка зависимостей',
    task: 'Сохраните состав окружения: pip freeze > requirements.txt',
    re: /^pip\s+freeze\s*>\s*requirements\.txt$/,
    th: 'Файл требований — это ответ на вопрос «а у меня работало». ' +
        '<code>freeze</code> выписывает точные версии всех пакетов, ' +
        'а перенаправление <code>&gt;</code> сохраняет их в файл. ' +
        'Список из <code>pip freeze</code> короче, чем ' +
        '<code>pip list</code>: туда попадает только то, что реально ' +
        'нужно, а не всё подряд из окружения.',
    h: ['pip freeze печатает список в stdout.',
        'Перенаправление > сохраняет его в файл requirements.txt.',
        'pip freeze > requirements.txt'],
    xp: 35
  },
  {
    id: 6, m: 1, t: 'Проверяем согласованность',
    task: 'Убедитесь, что зависимости не конфликтуют: pip check',
    re: /^pip\s+check$/,
    th: 'Перед деплоем стоит спросить: а не сломано ли окружение. ' +
        '<code>pip check</code> ищет несовместимые версии — когда ' +
        'один пакет требует другого, чем установлено. Ошибка ' +
        'проявилась бы позже и в другом месте, а здесь — сразу и ' +
        'внятно.',
    h: ['Подкоманда check утилиты pip.',
        'Никаких аргументов.',
        'pip check'],
    xp: 25
  },

  /* ---------------------------------------------------------- модуль 2 */
  {
    id: 7, m: 2, t: 'Читаем чужой скрипт',
    task: 'Откройте train.py с номерами строк: cat -n train.py',
    re: /^cat\s+-n\s+train\.py$/,
    th: 'Работа ML-инженера начинается не с правки, а с чтения. ' +
        'Смотрите на аннотации типов: они описывают форму данных ' +
        'и контракт функции. <code>-n</code> нужен, чтобы ссылаться ' +
        'на строки в разговоре с командой — «вот тут ' +
        'приведение к int, которого нет».',
    h: ['cat с флагом -n печатает номера строк.',
        'Файл называется train.py.',
        'cat -n train.py'],
    xp: 30
  },
  {
    id: 8, m: 2, t: 'Запускаем обучение',
    task: 'Обучите модель: python train.py --epochs 3',
    re: /^python\s+train\.py\s+--epochs\s+3$/,
    th: 'Скрипт сам объявляет параметры через argparse — их видно в ' +
        'выводе. Прогон должен быть повторяемым: тот же вход даёт ' +
        'ту же метрику. Если не даёт, ищите seed, многопоточность ' +
        'или загрузку данных в случайном порядке. Метрика без ' +
        'воспроизводимости не годится для решения о выкатке.',
    h: ['Скрипт train.py, длинный флаг --epochs.',
        'Эпох — целое число.',
        'python train.py --epochs 3'],
    xp: 35
  },
  {
    id: 9, m: 2, t: 'Версия библиотеки',
    task: 'Узнайте версию numpy: python -c \'import numpy; print(numpy.__version__)\'',
    re: /^python\s+-c\s+'import numpy; print\(numpy\.__version__\)'$/,
    th: 'Флаг <code>-c</code> выполняет код из строки — быстрый ' +
        'способ задать вопрос интерпретатору. Так проверяют версии, ' +
        'список доступных модулей и поведение функции, не создавая ' +
        'файла. <code>__version__</code> — соглашение, которому ' +
        'следуют почти все библиотеки.',
    h: ['Флаг -c исполняет код, переданный строкой.',
        'Внутри импорт numpy и печать numpy.__version__.',
        "python -c 'import numpy; print(numpy.__version__)'"],
    xp: 35
  },

  /* ---------------------------------------------------------- модуль 3 */
  {
    id: 10, m: 3, t: 'Находим async',
    task: 'Посмотрите, где в коде асинхронность: grep -n \'async def\' fetch_async.py',
    re: /^grep\s+-n\s+'async def'\s+fetch_async\.py$/,
    th: 'Асинхронный код узнаётся по двум словам: <code>async def</code> ' +
        'и <code>await</code>. Первое объявляет сопрограмму, второе — ' +
        'момент, когда её можно «отдать» и вернуться к другим задачам. ' +
        'Сопрограмма без await работает как обычная функция, только ' +
        'медленнее. <code>grep -n</code> — самый быстрый способ ' +
        'ответить, асинхронный ли перед вами файл.',
    h: ['grep с номером строки -n.',
        'Ищем вхождение async def в файле fetch_async.py.',
        "grep -n 'async def' fetch_async.py"],
    xp: 35
  },
  {
    id: 11, m: 3, t: 'Синхронная версия',
    task: 'Замерьте последовательные запросы: python fetch_sync.py',
    re: /^python\s+fetch_sync\.py$/,
    th: 'Три запроса подряд дают 3.2 секунды — сумму трёх ' +
        'ожиданий. Сеть всё это время простаивала: клиент ждал, ' +
        'сервер отвечал мгновенно, но отвечать было не на что, ' +
        'пока не пришёл следующий запрос. Именно на этом ' +
        'теряются лидеры времени отклика в собственных LLM-сервисах.',
    h: ['Скрипт с суффиксом _sync.',
        'Просто запустите его, аргументов нет.',
        'python fetch_sync.py'],
    xp: 30
  },
  {
    id: 12, m: 3, t: 'Асинхронная версия',
    task: 'Сравните: python fetch_async.py',
    re: /^python\s+fetch_async\.py$/,
    th: 'Те же три запроса уходят одновременно и ждут вместе: ' +
        '0.6 секунды вместо 3.2. Ускорение в пять раз при той же ' +
        'нагрузке на сеть и том числе запросов. Именно так ' +
        'выглядит честный выигрыш от asyncio: он не в «более ' +
        'быстром сервере», а в том, что сервер перестал простаивать.',
    h: ['Тот же запуск, но файл с суффиксом _async.',
        'Аргументов не нужно.',
        'python fetch_async.py'],
    xp: 35
  },
  {
    id: 13, m: 3, t: 'Замер настоящей операцией',
    task: 'Измерьте один запрос: curl -s -o /dev/null -w \'%{time_total}\' https://kb.corp.local/pricing',
    re: /^curl\s+-s\s+-o\s+\/dev\/null\s+-w\s+'%\{time_total\}'\s+https:\/\/kb\.corp\.local\/pricing$/,
    th: 'Когда обсуждаете, во сколько обойдётся инференс, нужны ' +
        'замеры настоящей утилитой. <code>-w</code> печатает ' +
        'шаблон, где <code>%{time_total}</code> — полное время в ' +
        'секундах, а <code>-o /dev/null</code> выбрасывает тело ' +
        'ответа. Метрика из Prometheus и этот замер должны сходиться: ' +
        'если нет, где-то теряется время вне приложения.',
    h: ['curl с -s — без прогрес-бара, -o /dev/null — без тела ответа.',
        'Ключ -w печатает отформатированное значение, нужен % из curl.',
        "curl -s -o /dev/null -w '%{time_total}' https://kb.corp.local/pricing"],
    xp: 45
  },

  /* ---------------------------------------------------------- модуль 4 */
  {
    id: 14, m: 4, t: 'Форма тензора',
    task: 'Создайте пустой тензор: python -c \'import numpy as np; a=np.zeros((4096,128)); print(a.shape)\'',
    re: /^python\s+-c\s+'import numpy as np; a=np\.zeros\(\(4096,128\)\); print\(a\.shape\)'$/,
    th: 'Форма тензора — первое, что стоит проверить. ' +
        '<code>np.zeros</code> не выделяет 524288 числа: почти нули ' +
        'создаются лениво, память выделяется страницами при первом ' +
        'обращении. Для 128 признаков и 4096 примеров это 2 МБ, ' +
        'а наивный список Python занял бы сотни мегабайт. Именно ' +
        'на этом выигрыше стоит всё обучение.',
    h: ['Однострочник через -c, весь код в одной строке.',
        'np.zeros принимает кортеж формы, print(a.shape) печатает его.',
        "python -c 'import numpy as np; a=np.zeros((4096,128)); print(a.shape)'"],
    xp: 40
  },
  {
    id: 15, m: 4, t: 'Транспонирование',
    task: 'Разверните матрицу: python -c \'import numpy as np; a=np.array([[1,2],[3,4]]); print(a.T)\'',
    re: /^python\s+-c\s+'import numpy as np; a=np\.array\(\[\[1,2\],\[3,4\]\]\); print\(a\.T\)'$/,
    th: '<code>.T</code> меняет порядок осей, а не копирует ' +
        'числа. Ошибка «ожидали матрицу 128 на 4096, получили ' +
        '4096 на 128» встречается в каждом втором проекте и почти ' +
        'всегда сводится к транспонированию в неожиданном месте.',
    h: ['Создайте матрицу np.array из списка списков.',
        'Атрибут .T транспонирует, print печатает результат.',
        "python -c 'import numpy as np; a=np.array([[1,2],[3,4]]); print(a.T)'"],
    xp: 40
  },
  {
    id: 16, m: 4, t: 'Выборка элементов',
    task: 'Возьмите элементы через список индексов: python -c \'import numpy as np; a=np.array([1,2,3,4]); print(a[[0,2]])\'',
    re: /^python\s+-c\s+'import numpy as np; a=np\.array\(\[1,2,3,4\]\); print\(a\[\[0,2\]\]\)'$/,
    th: 'Двойные скобки — это список индексов, а не двумерная ' +
        'индексация. Результат всегда копия: правки исходного ' +
        'массива её не затронут. На больших тензорах такая выборка ' +
        'съедает память, поэтому для непрерывного куска используют ' +
        'срез <code>a[0:2]</code> — он возвращает представление без ' +
        'копирования.',
    h: ['Одномерный массив из четырёх чисел.',
        'Внутри квадратных скобок список индексов — вот такие двойные скобки.',
        "python -c 'import numpy as np; a=np.array([1,2,3,4]); print(a[[0,2]])'"],
    xp: 40
  },
  {
    id: 17, m: 4, t: 'Матричное умножение',
    task: 'Посчитайте произведение: python -c \'import numpy as np; a=np.array([[1,2],[3,4]]); print(float(np.dot(a,a.T)))\'',
    re: /^python\s+-c\s+'import numpy as np; a=np\.array\(\[\[1,2\],\[3,4\]\]\); print\(float\(np\.dot\(a,a\.T\)\)\)'$/,
    th: '<code>np.dot</code> — это то, чем реально считают ' +
        'линейную регрессию и градиентный спуск. Реализация на ' +
        'C в разы быстрее вложенных циклов Python, потому что ' +
        'проходит по данным линейно и использует векторные ' +
        'инструкции процессора. Считать руками — значит отдать ' +
        'производительность бесплатно.',
    h: ['Та же матрица, что и в прошлом задании.',
        'np.dot(a, a.T) даёт матрицу, float превращает её в число для печати.',
        "python -c 'import numpy as np; a=np.array([[1,2],[3,4]]); print(float(np.dot(a,a.T)))'"],
    xp: 45
  },

  /* ---------------------------------------------------------- модуль 5 */
  {
    id: 18, m: 5, t: 'Гоняем тесты',
    task: 'Запустите тесты: python -m pytest -q',
    re: /^python\s+-m\s+pytest\s+-q$/,
    th: '<code>-m</code> заставит pytest взять версию из активного ' +
        'окружения — иначе можно получить двойную установку и ' +
        'непонятные падения. Флаг <code>-q</code> сокращает вывод ' +
        'до строки с итогом. Тесты зелёные не означают, что модель ' +
        'права: тесты проверяют код, качество проверяет золотой ' +
        'набор вопросов.',
    h: ['pytest запускается как модуль: python -m.',
        'Флаг -q — краткий вывод.',
        'python -m pytest -q'],
    xp: 30
  },
  {
    id: 19, m: 5, t: 'Проверяем типы',
    task: 'Прогоните проверку типов: python -m mypy train.py',
    re: /^python\s+-m\s+mypy\s+train\.py$/,
    th: 'Обычный запуск Python не проверяет типы: он посчитает ' +
        'что угодно и упадёт в самый неподходящий момент. ' +
        '<code>mypy</code> находит ошибки до запуска — особенно ' +
        'несовпадения формы данных. Для ML-кода это критично: ' +
        'список вместо массива считается иначе, и ошибка всплывает ' +
        'как «модель плохо обучилась».',
    h: ['Как и pytest, запускается через python -m.',
        'Проверяем один файл train.py.',
        'python -m mypy train.py'],
    xp: 40
  },
  {
    id: 20, m: 5, t: 'Финальный замысел',
    task: 'Зафиксируйте окружение целиком: pip freeze > requirements.txt',
    re: /^pip\s+freeze\s*>\s*requirements\.txt$/,
    th: 'Финальный шаг — тот же, что и в начале, но теперь в файле ' +
        'есть всё, включая только что поставленное. Именно этот ' +
        'файл отдают команде и кладут в репозиторий. Отдельная ' +
        'проверка типов — то, что вы видели, и она ничего не ' +
        'меняет в файле; это отдельный инструмент, о котором ' +
        'договариваются заранее.',
    h: ['Та же команда, что в задании 5.',
        'Если файл уже есть, он просто перезапишется.',
        'pip freeze > requirements.txt'],
    xp: 30
  }
];

PY.reset();

/* ============================================================ РЕГИСТРАЦИЯ */

COURSES.python = {
  i: '🐍', n: 'PYTHON · ML', c: 'var(--tr-accent)',
  pr: PY_PROMPT,
  ti: 'ml@work — venv · numpy · asyncio · mypy',
  note: 'Команды настоящие: python, python3 -m venv, pip, pytest, mypy, ' +
        'grep, curl. Сам проект (train.py, fetch_*.py) лежит внутри курса.',
  mods: PY_MODS, ls: PY_LS,
  run: function (raw) {
    var r = null;
    try { r = pyRun(raw); } catch (e) {
      r = { t: 'bash: внутренняя ошибка обработки команды: ' + (e && e.message ? e.message : e), c: 't-err' };
    }
    if (typeof renderEnv === 'function') { try { renderEnv(); } catch (e2) {} }
    return r;
  },
  reset: function () { PY.reset(); },
  env: function () { return PY.env(); }
};
