---
title: Тестирование инфраструктуры
track: devops
module: G. Зрелость эксплуатации
order: 28
duration: 80 мин
level: senior
tags: [тесты, policy as code, plan, check, дрейф, pre-commit]
summary: Четыре уровня проверки инфраструктурного кода — от terraform plan и политик как кода до дрейф-детектора — и честный ответ на вопрос, есть ли у Terraform юнит-тесты
practice: Собери пайплайн для своего инфраструктурного репозитория: fmt, validate, tflint, политика «у ресурса есть теги», plan с публикацией в комментарий PR, дрейф-детектор по расписанию и post-apply smoke-проверка, которая роняет пайплайн.
---

Ты уже умеешь описывать инфраструктуру кодом: [Terraform и Ansible](devops/12-terraform-i-ansible.md) дали тебе `plan` и `--check`, [пайплайны](devops/14-cicd-pipeliney.md) — сборку и раскатку, [сеть как код](net/18-set-kak-kod.md) — конфигурации в Git с историей. Но есть дыра, которую ни один из этих уроков не закрывает: **как проверить, что инфраструктурный код вообще правильный, до того, как он коснулся продакшена**. Код приложения проходит тесты. Terraform — нет. Это единственный класс кода, который ломает прод так же легко, как код приложения, и при этом **откатить его дороже**: откат приложения — это пуш предыдущего тега, откат удалённого тома, удалённой подсети или сгоревшего state — это поездка и объяснения.

Лекция — про четыре уровня проверки, от дешёвого к дорогому, и про то, что между ними не закрывается автоматически ничем.

## Порядок зрелости: восемь ступеней, которые нельзя перепрыгивать

Каждая следующая ступень имеет смысл только если предыдущая держится. Перепрыгивания не бывает: ревью без плана бесполезно, автоприменение без ревью — это автоматизация ошибки, а политики как код поверх ручных правок — декорация.

| Уровень | Что появилось | Что это даёт | Чего всё ещё не хватает |
| --- | --- | :---: | --- |
| 1 | Ручные изменения по SSH | инфраструктура существует | знания, история, воспроизводимость |
| 2 | Описание в Git, но правят руками | история есть, но она врёт | правда и репозиторий расходятся |
| 3 | Ревью PR на конфигурацию | второй глаз перед изменением | человек смотрит не на то, что применится |
| 4 | `plan` обязателен перед применением | видно, **что именно** изменится | после `apply` никто не проверяет результат |
| 5 | Автоприменение из `main` | изменения едут без «забыл применить» | регресс в проде обнаруживается пользователями |
| 6 | Проверка после применения (smoke, health) | пайплайн сам узнаёт, что сломалось | дешёвая проверка ловит не всё |
| 7 | Политики как код (OPA/Conftest) | запрещённое нельзя смержить даже по ошибке | политику можно обойти вне Git |
| 8 | Дрейф-детектор по расписанию | правда обнаруживается сама, без человека | — |

Обрати внимание на строку 2 — это состояние, в котором находится большинство команд: «у нас всё в Git» — и при этом state трёхлетней давности, а прод менялся руками десять раз.

| Что уже есть в курсе | Где | Чего не хватает |
| --- | --- | --- |
| `plan -out` / `apply tfplan` как дисциплина | devops/12 | чтения `-/+` и последствий пересоздания |
| `plan -detailed-exitcode` как детектор дрейфа | devops/12 | автоматического расписания, уведомления и разбора |
| `ansible --check --diff` | devops/12, net/18 | понимания слепого пятна check mode |
| pre-commit для кода приложения | devops/14 | pre-commit для HCL, YAML, Jinja2, сетевых конфигов |
| Smoke-тест в пайплайне | devops/14 | smoke **инфраструктуры**: служба, порт, TLS, репликация |
| CODEOWNERS | net/18 | обязательный статус CI перед merge + запрет force push |
| Политики как код | — | целиком, это ноль сегодня |

## Уровень 1. Проверка до применения

### `terraform plan` — единственный документ, который читает человек

План — это не «список ресурсов», а **список операций**. Четыре знака, которые нужно различать автоматически:

- `+` — ресурс будет создан;
- `-` — ресурс будет уничтожен;
- `~` — изменение на месте, ресурс продолжает жить (обычно без простоя);
- `-/+` — ресурс **пересоздаётся**: сначала уничтожается, потом создаётся заново.

Именно последний знак — главный. Он выглядит как замена одного значения другим, а означает новый ID, новый IP, новый диск и **окно недоступности**, равное времени создания ресурса. Если этот ресурс — база данных, вложенный диск, сетевой интерфейс единственной ВМ или сам контроллер домена, то `-/+` — это плановое окно обслуживания, о котором нужно предупредить бизнес.

```text
  # proxmox_virtual_environment_vm.ubuntu will be updated in-place
  ~ resource "proxmox_virtual_environment_vm" "ubuntu" {
        ~ cores     = 8    -> 12
        ~ memory    = 16384 -> 24576
        # (2 attributes hidden)
    }

  # aws_db_instance.postgres must be replaced
-/+ resource "aws_db_instance" "postgres" {
      ~ identifier      = "llmops-prod-pg" -> "llmops-prod-pg-2" # forces replacement
      ~ instance_class  = "db.t3.medium" -> "db.r6g.large"        # forces replacement
      ~ storage_encrypted = true -> true
    }

  # resource will be created
  + resource "random_password" "pg_admin" { ... }
```

> [!CAUTION]
> Строка `# forces replacement` в плане — это не комментарий, а **приговор**. Прокручивай план до конца всегда, даже если он на 3000 строк и начинается с `~`. Обычно `-/+` находится в самом низу, в разделе «must be replaced», уже после списка обновлений, который читается как рутина.

Единственная реальная страховка на этом шаге — не план, а **проверенный бэкап**: снимок, который вы восстановили хотя бы раз. Про `vzdump`, Proxmox Backup Server, `wbadmin` для контроллера домена и тест восстановления с замером RTO — в [лекции о бэкапах и аварийном восстановлении](devops/19-backup-i-dr.md).

Разбор `-/+` в понятный отчёт — машинно, без чтения глазами. План сохраняется в файл, дальше с ним работает код:

```bash
# порядок дисциплины: сохранить, разобрать, показать людям, применить ровно это
terraform plan -out=tfplan -no-color -lock-timeout=5m
terraform show -json tfplan > plan.json

# 1. всё, что будет пересоздано — отдельным списком, его и обсуждаем
jq -r '.resource_changes[]
       | select(.change.actions | (index("create") and index("delete")))
       | "ПЕРЕСОЗДАСТСЯ\t\(.address)\t\(.change.actions | join(" -> "))"' plan.json

# 2. всё, что будет удалено целиком
jq -r '.resource_changes[]
       | select(.change.actions == ["delete"]) | "УДАЛИТСЯ\t\(.address)"' plan.json

# 3. сводка счётчиком — одна строка в комментарий PR
jq -r '[.resource_changes[].change.actions | join("+")]
       | group_by(.) | map({(.[0]): length}) | add' plan.json

# 4. какие атрибуты помечены как причина замены
jq -r '.resource_changes[]
       | select(.change.actions | index("delete"))
       | .change.replace_paths | @json' plan.json
```

Коды возврата `terraform plan -detailed-exitcode`: `0` — изменений нет, `2` — изменения есть, `1` — ошибка. Это позволяет развести два сценария одним и тем же скриптом (детектор дрейфа ниже построен ровно на этом).

### `ansible --check --diff` и его слепое пятно

`--check` заставляет модуль пройти весь путь — прочитать текущее состояние, посчитать разницу — но не выполнить запись. `--diff` показывает, какие команды и строки ушли бы на устройство. Проблема в том, что этот механизм **молчит в четырёх случаях**, и все четыре встречаются в проде:

1. **Модуль не поддерживает check mode** — задача в выводе помечена `SKIPPED`, а на реальном прогоне делает всё. Чинить: `check_mode: no` на конкретной задаче запрещает и обычный прогон в check-режиме — это защита.
2. **Задача с `shell` или `command`.** Эти модули не умеют предсказывать результат, в check mode они просто пропускаются. Никакого diff, никакой защиты. Чинить: заменить на декларативный модуль или явно описать `changed_when`.
3. **Применение шаблона целиком.** Если конфиг целиком заливается модулем, который не читает текущее состояние, `--check` покажет «добавить весь шаблон» и **не покажет, что удалится всё, чего в шаблоне нет**. Это самый опасный случай, и он типичен для сети — см. [разбор в net/18](net/18-set-kak-kod.md).
4. **Задачи, которые уже выполняются с `check_mode: no`** — они выполняются по-настоящему даже в `--check`. Никто не ожидает этого, пока не меняет прод-данные «на проверку».

```yaml
# playbooks/site.yml — проверяемый прогон
- name: Свести узел к коду
  hosts: nodes
  become: true
  serial: 1
  any_errors_fatal: true
  tasks:
    - name: Проверить, что мы не потеряем связь с управляющим интерфейсом
      ansible.builtin.assert:
        that:
          - mgmt_ip is defined
          - mgmt_interface is defined
        fail_msg: "Заданы не все сетевые параметры — стоп, пока не потеряем доступ."

    - name: Обновить описания портов
      cisco.ios.ios_interfaces:
        config:
          - name: "{{ item.name }}"
            description: "{{ item.description }}"
            enabled: true
      loop: "{{ access_ports + uplinks }}"
      # если модуль не поддерживает check mode — пусть честно скажет об этом,
      # а не радостно отрапортует "changed" в CI
      check_mode: "{{ ansible_check_mode }}"

    - name: Залить конфиг целиком (слепое пятно -- обязательно --diff и ревью)
      ansible.netcommon.net_config:
        src: "rendered/{{ inventory_hostname } }.cfg"
        backup: true
      when: apply_full_config | default(false) | bool
```

Практическое правило: `--check` — это фильтр дешёвых ошибок (опечатка в YAML, несуществующий файл, незаданная переменная), а **не** доказательство безопасности. Доказательство безопасности — это прочитанный diff плюс одно устройство, на котором не жалко проверить.

### Линтеры и форматирование

Самая дешёвая категория проверок и та, которую чаще всего пропускают. Работает минуту, ловит опечатки, которые иначе видны только в проде.

```bash
# --- Terraform ---
terraform fmt -check -recursive            # формат: дёшево, обязательно в CI
terraform init -backend=false -input=false
terraform validate                        # синтаксис, типы, ссылки между ресурсами
tflint --init                             # сторонний линтер, правила в .tflint.hcl
tflint --recursive                        # ошибки в порядке -> exit code != 0

# --- Ansible ---
ansible-lint                             # точность имён модулей, FQCN, стиль
yamllint -c .yamllint.yml .
ansible-playbook --syntax-check -i inventory/prod site.yml

# --- Всё остальное, что попадает в репозиторий инфраструктуры ---
yamllint -d relaxed inventory/ group_vars/
jinja2 --version >/dev/null && python -c "import sys, pathlib; \
  from jinja2 import Environment; \
  [Environment().parse(pathlib.Path(f).read_text()) for f in __import__('glob').glob('templates/**/*.j2')]"
python -c "import yaml,glob,sys; [yaml.safe_load(open(f)) for f in glob.glob('**/*.yml', recursive=True)]"
```

> [!NOTE]
> У `tflint` набор правил и формат конфигурации менялись между мажорными версиями: в актуальных версиях правила подключаются блоком `plugin "terraform"` с блоком `rule`, старые `enabled = true` внутри блоков правил больше не читаются. **Сверься со своей версией** (`tflint --version` и документация к этой мажорной версии), иначе линтер молча проверит ноль правил и будет зелёным. Тот же принцип касается `ansible-lint`: профили и правила переезжали между версиями.

### Политики как код: правило, которое человек не может обойти

Линтер говорит «здесь неверно». Политика говорит «здесь нельзя». Разница в силе: линтер можно обойти комментом `// tflint-ignore`, политику — только изменив саму политику, и это попадёт в ревью отдельного PR.

Политика пишется на Rego и проверяет **план**, а не исходники: это принципиально, потому что план содержит итоговое состояние ресурсов, включая всё, что пришло из модулей и переменных.

```rego
# policy/terraform/tags.rego
# Вход: plan.json из `terraform show -json tfplan`
# Проверка: conftest test plan.json --policy policy/ --namespace terraform
package terraform.tags

required := {"Environment", "Owner", "Project", "CostCenter"}

deny[msg] {
    rc := input.resource_changes[_]
    startswith(rc.type, "data") == false
    rc.change.actions != ["delete"]
    rc.change.actions != ["no-op"]

    tags := object.get(rc.change.after, "tags", {})
    missing := {t | t := required[_]; not tags[t]}
    count(missing) > 0

    msg := sprintf("%s (%s): нет обязательных меток: %v", [rc.address, rc.type, missing])
}

# Смягчение: предупреждение, а не запрет. Так разбираются с легаси постепенно.
warn[msg] {
    rc := input.resource_changes[_]
    rc.change.actions != ["no-op"]
    object.get(rc.change.after, "tags", {})["Owner"] == "unknown"
    msg := sprintf("%s: владелец помечен как unknown — ресурс никому не принадлежит", [rc.address])
}
```

```rego
# policy/terraform/public_ip.rego
package terraform.public_ip

# Публичный IP в проде допустим только с записанным обоснованием.
# Поле-флаг делает исключение явным: его видно в плане и в ревью.
deny[msg] {
    rc := input.resource_changes[_]
    env := object.get(rc.change.after, "tags", {})["Environment"]

    env == "prod"
    has_public_ip(rc.change.after)

    reason := object.get(rc.change.after, "tags", {})["PublicIPReason"]
    not reason
    reason != ""

    msg := sprintf(
        "%s: публичный IP в проде без tags.PublicIPReason. Добавь обоснование и номер тикета.",
        [rc.address],
    )
}

has_public_ip(attrs) {
    is_string(attrs.public_ip)
    attrs.public_ip != ""
    attrs.public_ip != "0.0.0.0"
}

has_public_ip(attrs) {
    is_number(attrs.associate_public_ip_address)
    attrs.associate_public_ip_address > 0
}
```

> [!WARNING]
> Синтаксис Rego менялся принципиально. Начиная с OPA 1.0 модулем `rego.v1` язык Rego считается основным: условие требует явного `if`, а правила, порождающие несколько значений, объявляются через `contains`. То есть `deny[msg] { ... }` нужно читать как устаревшую форму. Перед копированием правил проверь `opa version` и `conftest --version` и сверься с документацией своей версии: **политика, написанная под старый синтаксис и молча не скомпилировавшаяся под новым, возвращает «нет нарушений»**, а не ошибку. Это худший вид тихого сбоя.
>
> Если менять Rego не хочется, проверку тех же инвариантов можно написать в пять строк на `jq` и положить в пайплайн рядом. Это хуже по выразительности, но заведомо работает:

```bash
# политика без OPA: те же инварианты, весь код виден целиком
set -euo pipefail

# 1. каждый создаваемый/изменяемый ресурс имеет метки
jq -r '
  .resource_changes[]
  | select(.change.actions != ["delete"] and .change.actions != ["no-op"])
  | select((.change.after.tags // {} | has("Environment") and has("Owner")
            and has("Project") and has("CostCenter")) | not)
  | "нет обязательных меток: \(.address)"' plan.json | tee -a violations.txt

# 2. публичный IP в проде только с обоснованием
jq -r '
  .resource_changes[]
  | select((.change.after.tags.Environment // "") == "prod")
  | select((.change.after.public_ip // "") != "" and (.change.after.public_ip // "") != "0.0.0.0")
  | select((.change.after.tags.PublicIPReason // "") == "")
  | "публичный IP без обоснования: \(.address)"' plan.json | tee -a violations.txt

# 3. пересоздание чего-либо слышного — отдельный вопрос ревьюеру
jq -r '
  .resource_changes[]
  | select(.change.actions | (index("create") and index("delete")))
  | "пересоздаётся: \(.address)"' plan.json | tee -a replacements.txt

# 4. удаление state-файла или бакета с ним — жёсткий отказ
jq -r '
  .resource_changes[]
  | select(.type | test("^aws_s3_bucket$|^google_storage_bucket$"))
  | select((.change.actions | index("delete")) and (.address | test("tfstate")))
  | "попытка удалить бакет с state: \(.address)"' plan.json

test ! -s violations.txt || { cat violations.txt; exit 1; }
```

### Прогноз стоимости до применения

Последний штрих уровня 1: план не показывает деньги. Денежная оценка изменения — это то, что превращает разговор с руководством из технического в управленческий. Рабочий инструмент — Infracost, он читает `plan.json` и печатает стоимость по ресурсам и итог по периоду.

```bash
# Infracost: сначала разбор, потом расчёт. CLI у него менялся — сверься со своей версией.
infracost breakdown --path plan.json --format json > cost.json
infracost breakdown --path plan.json --format table --no-color

# итог: дельта по месяцу и по году, ключевые цифры для комментария в PR
jq -r '.projects[].breakdown.totalMonthlyCost // .totalMonthlyCost' cost.json

# какие ресурсы дают наибольшую дельту — сюда и идёт вопрос «зачем нам это»
jq -r '.projects[].breakdown.resources[]
       | select((.monthlyCost | sub("\\\\$";"") | tonumber) > 0)
       | "\(.name)\t\(.monthlyCost)"' cost.json | sort -k2 -hr | head -15
```

Для on-prem контура аналог — считать вручную по статьям (амортизация, электричество, место, труд), и это разбирается в [FinOps](devops/30-finops.md). Здесь важно другое: **стоимость обязана быть частью PR**. Изменение, которое добавляет ВМ без тегов и без обоснования, увеличивает статью расходов, о которой узнаёшь из счёта через месяц.

## Уровень 2. Проверка после применения

`plan` отвечает на вопрос «что изменится». Он не отвечает на вопрос «стало ли лучше». Разница между ними — ровно то время, в которое живёт сломанный прод, если никто не проверил.

### Что именно проверять

| Класс проверки | Вопрос | Инструмент | Критерий |
| --- | --- | --- | :---: |
| Процесс жив | служба запущена | `systemctl is-active` | `active` |
| Порт слушает | приложение повесило сокет | `ss -ltnp` | порт в списке |
| Эндпоинт отвечает | сервис проходит запрос | `curl -fsS /healthz` | HTTP 200 + верный JSON |
| TLS работает | цепочка доверия валидна для клиента | `openssl s_client` | `Verify return code: 0` |
| Репликация жива | изменения доходят до второго узла | `dcdiag` / `repadmin` | нет ошибок репликации |
| Кластер цел | нужное число нод готово | `kubectl get nodes` | `Ready`, ожидаемое количество |
| Данные на месте | база отвечает на реальный запрос | простой `SELECT 1` + латентность | < порога |
| Сертификат свежий | срок действия | `openssl x509 -checkend` | > 30 дней |

Три строки, которые ловят больше половины проблем «сервис поднялся, но не работает»:

```bash
set -euo pipefail
TARGET="${TARGET:-https://api.internal}"

# 1. служба, а не процесс. Процесс может быть живым, а служба — в failed.
systemctl is-active --quiet nginx || { echo "FAIL: nginx не active"; exit 1; }

# 2. ходят ли запросы. -f = падать на 4xx/5xx, -s = молча, -o /dev/null = без тела.
code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "${TARGET}/healthz")
[ "$code" = "200" ] || { echo "FAIL: /healthz вернул $code"; exit 1; }

# 3. цепочка доверия глазами клиента, а не серверного сертификата
echo | openssl s_client -connect api.internal:443 -servername api.internal 2>/dev/null \
  | openssl x509 -noout -checkend $((30*24*3600)) -subject -issuer \
  || { echo "FAIL: сертификат истёк или цепочка невалидна"; exit 1; }
```

### Проверка ожидаемого состояния, а не «процесса запустился»

Разница формулировок звучит мелко, но в эксплуатации это разница между «система работает» и «система работает не так».

Плохая проверка: `systemctl is-active app` — она зелёная, когда приложение поднялось и тут же падает в бесконечный рестарт, потому что не может подключиться к базе.

Хорошая проверка — та, что повторяет путь пользователя и ждёт **устойчивости**, а не первого успеха:

```bash
#!/usr/bin/env bash
# scripts/smoke.sh — запускается в пайплайне сразу после apply.
# Аргумент: сколько секунд наблюдать, прежде чем признать деплой успешным.
set -euo pipefail
SETTLE="${SETTLE:-60}"
SAMPLE="${SAMPLE:-10}"
URL="${URL:-https://api.internal}"
START=$(date +%s)
DEADLINE=$((START + SETTLE))
CHECKS=0

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    CHECKS=$((CHECKS + 1))
    if ! out=$(curl -fsS --max-time 5 -w '\n%{http_code} %{time_total}' "${URL}/healthz" 2>&1); then
        echo "попытка ${CHECKS}: /healthz недоступен"
        sleep "$SAMPLE"; continue
    fi
    code=$(tail -n1 <<<"$out" | cut -d' ' -f1)
    ttime=$(tail -n1 <<<"$out" | cut -d' ' -f2)
    body=$(sed '$d' <<<"$out")

    # проверяем содержимое ответа, а не только код:
    # сервис может отдавать 200 с деградацией внутри
    grep -q '"status":"ok"' <<<"$body" || { echo "попытка ${CHECKS}: status не ok: $body"; sleep "$SAMPLE"; continue; }
    grep -q '"db":"reachable"' <<<"$body" || { echo "попытка ${CHECKS}: БД недоступна"; sleep "$SAMPLE"; continue; }

    awk -v t="$ttime" 'BEGIN{exit !(t < 1.0)}' || {
        echo "попытка ${CHECKS}: ответ ${ttime}s — медленнее порога"; sleep "$SAMPLE"; continue; }

    echo "OK: ${CHECKS}-я проверка, ${code} за ${ttime}s"
    exit 0
done

echo "FAIL: за ${SETTLE}s (${CHECKS} попыток) сервис не пришёл в рабочее состояние" >&2
exit 1
```

Пятьдесят-шестьдесят секунд наблюдения вместо одной проверки — это то, что отличает smoke-тест от «проверь, что процесс есть». Воркеры и кэши прогреваются, TLS-сессии прогреваются, фоновые задачи стартуют. Деплой, который «упал» на второй минуте, — это нормальный деплой, а не инцидент, если его вовремя остановили.

### Как это выглядит в пайплайне

Один джоб после деплоя, который имеет право завалить пайплайн. Важно: у него есть **таймаут**, иначе зависший curl будет висеть до следующего инцидента.

```yaml
  smoke:
    needs: deploy
    runs-on: [self-hosted, prod-access]
    timeout-minutes: 10
    steps:
      - name: Скопировать скрипт
        run: curl -fsS "$REPO_RAW/scripts/smoke.sh" | bash -s -- --settle 90
        env:
          URL: https://api.internal
          REPO_RAW: https://raw.githubusercontent.com/acme/infra/main

      - name: Расширенная проверка: домен логинится
        run: |
          set -euo pipefail
          # здесь живёт проверка, для которой нужен Windows: читаем dcdiag наружу
          timeout 120 dcdiag /e /c /v 2>&1 | tee /tmp/dcdiag.txt
          grep -qiE 'no problems|не выявлено' /tmp/dcdiag.txt \
            || { echo "FAIL: контроллер домена сообщил о проблемах"; exit 1; }
```

> [!IMPORTANT]
> Smoke-тест после применения **обязан иметь право провалить пайплайн**, и это право нельзя терять из-за «нас же это и так видно на графике». График показывает, что стало плохо, но он не останавливает раскатку: если в blue-green второй слот занял нагрузку и начал отдавать 500, текущая версия уже не вернётся сама. Именно smoke-тест — та точка, где деплой дешёвый ещё не стал необратимым.

## Уровень 3. Защита от человеческой ошибки

Человек ошибается не потому, что плохой, а потому, что устал, отвлёкся, поверил не тому и спешил. Система проверок существует не чтобы наказать, а чтобы **перехватить ошибку раньше, чем она станет инцидентом**.

### Кто именно может менять прод — и как это обеспечить технически

Ручные изменения в проде — главный источник дрейфа. Не потому что они запрещены, а потому что они **невидимы**: они не оставляют следов в репозитории, и через месяц никто не может объяснить, почему конфигурация такая.

| Уровень доступа | Кто | Что может | Как обеспечивается |
| --- | :---: | --- | --- |
| Просмотр | вся команда | читать state, план, логи | доступ на чтение к бакету со state |
| Применение из кода | CI-раннер | `apply` по модулю | короткоживущие креды, state в удалённом бакете с блокировкой |
| Ручное изменение с записью | дежурный, только при аварии | любые команды под `sudo` | учётка без общего пароля, все команды пишутся в аудит |
| Разрушающие операции (удаление тома, снос БД) | никто в одиночку | — | требуется второй человек, изменения только через код |

Ключевая мысль: ручной доступ не запрещают, его **делают видимым и дорогим по времени, но не по результату**. Разница между «так не делают» и «делают, но это оставляет след и требует вчера внести в Git» — огромная.

```bash
# 1. на проде нет входа root по SSH — ни для кого, включая тебя
#    /etc/ssh/sshd_config.d/10-hardening.conf
PermitRootLogin no
PasswordAuthentication no
AllowGroups deploy sshusers
MaxAuthTries 3

# 2. у дежурного нет NOPASSWD: ALL — только конкретные операции,
#    каждая из которых пишется в журнал с точностью до команды
#    /etc/sudoers.d/deploy-ops
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx
deploy ALL=(root) NOPASSWD: /usr/bin/vzdump * --storage backup --mode snapshot
deploy ALL=(root) NOPASSWD: /usr/sbin/ipmon --watch 5

# 3. каждая ручная сессия записывается — это и есть техническое требование
#    «внести в Git сегодня»
mkdir -p /var/log/sessions
cat >/etc/cron.hourly/session-tape <<'EOF'
#!/bin/bash
ts=$(date +%Y%m%d-%H%M)
for pid in $(pgrep -u deploy bash); do
  out=$(cat /proc/$pid/stat 2>/dev/null) || continue
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
  echo "$(date -Is) pid=$pid tty=$(ps -o tty= -p $pid) cmd=$cmd" >> /var/log/sessions/$ts.log
done
EOF
chmod 0755 /etc/cron.hourly/session-tape

# 4. сеть: устройство не примет конфигурацию, если она не из репозитория
#    Контроль — на уровне доступа к устройству и алерта на конфиг,
#    а не на уровне «мы договорились». Подробности в net/18-set-kak-kod.md
```

На уровне Proxmox конкретно: рабочие учётки с минимальными правами, отдельный токен для PBS, которого нет ни на одной машине администратора, и запрет выполнять `apply` с рабочего ноутбука — потому что state на ноутбуке это не state.

### CODEOWNERS и обязательные статусы CI

```text
# CODEOWNERS в корне репозитория инфраструктуры
# Формат: путь — владельцы. Порядок важен: первое совпадение выигрывает.

# Всё, что может создать или удалить ресурс, требует ревью инфраструктурного лида
/prod/            @acme/platform-leads
/state/           @acme/platform-leads

# Всё, что прикасается к сети, — отдельный владелец
/network/         @acme/network-team @ruslan
/modules/vpc/     @acme/network-team
/modules/peering/ @acme/network-team @ruslan

# Политики могут менять только двое: их обход обесценивает всю систему
/policy/          @acme/security @platform-leads

# Шаблоны применяются на весь парк — цена ошибки кратна размеру парка
/templates/       @acme/network-team @platform-leads

# Остальное
/observability/   @acme/sre
*.md              @acme/platform-leads
```

Настройки ветки, которые работают в GitHub и GitLab и окупаются за один инцидент:

| Правило ветки | Что даёт | Что будет без него |
| --- | --- | --- |
| Обязательные статус-чеки (`plan`, `policy`) перед merge | нельзя смержить код, который не прошёл проверки | «у меня локально работало» |
| Требуется хотя бы одно одобрение, не от автора | второй глаз | merge своей ветки без чтения |
| Требуется одобрение владельца по CODEOWNERS | инфраструктурный лид видит рискованные PR | сеть меняет человек, который в сети не разбирается |
| Запрет force push в `main` | история `main` достоверна | нельзя понять, что и когда поменяли |
| Запрет удаления ветки `main` | — | «случайно удалил, восстановил, потерялось два дня» |
| Запрет bypass для роли `admin` | правила одинаковы для всех | исключение, которым пользуются один раз и навсегда |

Последняя строка важнее, чем кажется. Как только у кого-то появляется возможность обойти проверки, она используется в первый же напряжённый день — обычно ровно тогда, когда проверки нужнее всего.

### Pre-commit: что ловится локально, что в CI, что только на ревью

Три линии обороны, и они не взаимозаменяемы. Локальная проверка экономит **время** (минута вместо пяти), CI экономит **деньжь** (отказ до ревью), ревью экономит **риск** (ошибки, не выражаемые синтаксисом).

| Ошибка | Локально (pre-commit) | В CI | Только ревью |
| --- | :---: | :---: | :---: |
| Пробелы, CRLF, табы в YAML | ✓ | ✓ | |
| Невалидный YAML / HCL | ✓ | ✓ | |
| `terraform fmt` | ✓ | ✓ | |
| Незакрытый `{{ }}` в шаблоне | ✓ | ✓ | |
| Приватный ключ или пароль в коммите | ✓ | ✓ | |
| Забытый `terraform.tfstate` в репозитории | ✓ | ✓ | |
| `terraform validate` | | ✓ | |
| Политика: нет тегов, публичный IP без причины | | ✓ | |
| План содержит `-/+` на ресурсе с данными | | ✓ (в предупреждение) | ✓ (решение) |
| План удаляет бакет со state | | ✓ (жёсткий отказ) | |
| Порядок применения: ресурс до зависимости | | частично | ✓ |
| **Нужно ли это вообще делать** | | | ✓ |
| **Правильная ли это архитектура** | | | ✓ |
| **Не сломаем ли мы этим соседний сервис** | | | ✓ |
| Оценка стоимости изменения | | ✓ (цифра) | ✓ (решение) |

```yaml
# .pre-commit-config.yaml — инфраструктурный репозиторий
default_stages: [pre-commit]
fail_fast: false
minimum_pre_commit_version: "3.0.0"

repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: mixed-line-ending          # CRLF в .tf и .j2 ломает diff
        args: [--fix=lf]
      - id: check-merge-conflict
      - id: detect-private-key         # ловит приватный ключ в конфиге устройства
      - id: check-added-large-files
        args: ["--maxkb=512"]

  - repo: https://github.com/antonbabenko/pre-commit-terraform
    rev: v1.92.0
    hooks:
      - id: terraform_fmt
      - id: terraform_validate          # требует terraform в PATH, init делается с backend=false
      - id: terraform_tflint
        args: ["--args=--only=terraform_deprecated_interpolation"]
      # terraform_docs и terraform providers lock — включай, когда дошёл до этого уровня

  - repo: https://github.com/ansible/ansible-lint
    rev: v24.8.0
    hooks:
      - id: ansible-lint
        args: ["--offline"]             # без сети на первом прогоне; galaxy-коллекции ставь заранее

  - repo: https://github.com/adrienverge/yamllint
    rev: v1.35.1
    hooks:
      - id: yamllint
        args: ["--strict", "-c", ".yamllint.yml"]

  - repo: local
    hooks:
      - id: jinja2-syntax
        name: шаблоны Jinja2 разбираются
        entry: python scripts/check_templates.py
        language: system
        pass_filenames: false
        types: [python]

      - id: no-raw-state
        name: state никогда не попадает в репозиторий
        entry: bash -c '! git ls-files --error-unmatch "*.tfstate*" 2>/dev/null'
        language: system
        pass_filenames: false
        types: [file]
```

```bash
pip install pre-commit && pre-commit install
pre-commit run --all-files --show-diff-on-failure

# линтер в CI дублируется обязательно: pre-commit обходится флагом --no-verify
```

> [!CAUTION]
> Хук `no-raw-state` выше написан через `bash -c` и работает только если репозиторий уже инициализирован. Надёжнее проверять в CI, до `init`, обычным `git ls-files | grep -E '\.tfstate'` с ненулевым кодом возврата как ошибкой — молчаливая проверка в pre-commit хуже отсутствующей, потому что создаёт ложное чувство защищённости.

## Уровень 4. Тесты как код

Здесь нужна честность, потому что слово «тест» вызывает ложные ожидания.

> [!IMPORTANT]
> **У Terraform нет юнит-тестов в смысле, в каком они есть у приложения.** Нет функции, которую можно вызвать и проверить без внешнего мира: конфигурация — это не код с входами и выходами, а описание желаемого состояния, которое проверяется сравнением с реальным. Тесты для инфраструктуры существуют, но они **интеграционные по своей природе**: нужно развернуть, посмотреть и сравнить. Что из этого реально работает — в таблице ниже.

| Подход | Что проверяем | Стоимость на прогон | Ловит | Ограничения |
| --- | --- | :---: | --- | --- |
| **Песок / тестовое облако** | `apply` изолированными кредами в отдельный аккаунт или namespace, затем `destroy` | минуты–часы | ошибки провайдера, невалидные параметры, отсутствующие квоты | деньги, реальные лимиты, риск применения не в тот аккаунт |
| **Применить и проверить (converge)** | `ansible-playbook` на одноразовой ВМ, потом проверки ожидаемого состояния | 5–15 мин | всё, что делает модуль: пакеты, файлы, службы, права | нужен стенд; «проверка» = это сам код проверок, его тоже надо писать |
| **Проверить конфигурацию без применения** | парсинг файлов и CLI, `plan`, `validate`, `--check` | секунды | опечатки, синтаксис, отсутствующие переменные, дрейф конфигурации | **не ловит** то, что зависит от реального состояния |
| **Эталонная конфигурация** | снять фактическое состояние устройства и сравнить с эталоном в Git | секунды | любой дрейф, включая чужой | эталон надо поддерживать, нормализация вывода критична |

Два механизма, которые стоит знать, но не стоит переоценивать:

- **`terraform test`** — появился в Terraform 1.6 и развивался в 1.7–1.9: файлы `.tftest.hcl` с блоками `run` и `assert`. Это проверки поведения модулей на реальных ресурсах в реальном API. Полезно для модулей с логикой (выбор региона, расчёт размера), бесполезно для «проверить, что ресурс создаётся» — для этого есть `plan`. **Возможности зависят от версии: сверься со своей и не рассчитывай на экспериментальные блоки.**
- **Terratest** — библиотека на Go: поднимает инфраструктуру настоящим Terraform, затем проверяет её обычными ассертами. Мощно, но это Go-код в репозитории на Go, и для команды без Go это дороже, чем кажется.

Что реально работает в твоём контуре и приносит 80% пользы при 20% усилий: **проверка конфигурации без применения + эталон для сети + drift-детектор**. Остальное — когда команда вырастет.

### Проверка сетевой конфигурации: применил → снял → сравнил

Полный цикл проверки сетевого устройства в лаборатории. Это ровно тот случай, где «проверить без применения» не работает: опечатку в ACL можно увидеть только тем, что отправил её устройству и посмотрел на результат. Поэтому стенд обязателен.

```bash
#!/usr/bin/env bash
# tests/check_lab_switch.sh — сравнить фактическую конфигурацию с эталоном.
# Запускается в CI только против лабораторного устройства. Никогда — против единственного.
set -euo pipefail

DEV="${DEV:-lab-sw-01}"
GOLDEN="tests/golden/${DEV}.cfg"
ACTUAL="/tmp/${DEV}.actual.cfg"
LOG="/tmp/${DEV}.read.log"

[ -f "$GOLDEN" ] || { echo "FAIL: нет эталона $GOLDEN"; exit 1; }

# 1. снять фактическое состояние (только чтение)
timeout 60 ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
      netops@"${DEV}" 'show running-config' > "$ACTUAL" 2>"$LOG" || {
  echo "FAIL: не смог прочитать конфигурацию $DEV"; cat "$LOG"; exit 1; }

# 2. нормализация: вывод устройства содержит то, что не является конфигурацией,
#    и CRLF, из-за которого diff показывает изменения на каждой строке
normalize() {
  tr -d '\r' < "$1" \
    | sed -e '/^Building configuration/d' \
          -e '/^Current configuration/d' \
          -e '/^!Last configuration change/d' \
          -e '/^!Time:/d' \
          -e '/^ version /d' \
          -e '/^ boot system/d' \
          -e '/^ ntp clock-period/d' \
          -e '/^ logging event link-status use-global-configuration/d' \
          -e '/^ ip domain lookup/d' \
    | sed -e '/^$/d' \
          -e 's/[[:space:]]\+/ /g' \
          -e 's/^ //' \
          -e 's/ $//' \
    | LC_ALL=C sort
}

normalize "$GOLDEN" > /tmp/golden.norm
normalize "$ACTUAL" > /tmp/actual.norm

# 3. сравнение. Строки, начинающиеся с '+', — правила, которых нет в коде.
#    Это и есть дрейф, и именно он здесь и ловится.
if diff -u /tmp/golden.norm /tmp/actual.norm > /tmp/${DEV}.diff; then
  echo "OK: $DEV соответствует эталону ($(wc -l < /tmp/actual.norm) строк)"
  exit 0
fi

echo "FAIL: $DEV разошёлся с эталоном:" >&2
grep -E '^[+-][^+-]' /tmp/${DEV}.diff | head -40 >&2
echo "" >&2
echo "Если расхождение ожидаемое: внеси фактическое состояние в эталон через PR" >&2
echo "и опиши в описании, почему изменение не попало в код." >&2
exit 1
```

Ключевая деталь — **нормализация до сравнения**. Без неё diff будет показывать сотни строк из-за порядка вывода и пробелов, и через неделю проверку начнут игнорировать как шумную. Проверка, которая всегда красная, хуже отсутствующей: её отключают.

Более глубокий вариант — не сравнивать тексты, а разбирать факт в структуру и проверять свойства. Это то, о чём подробно в [net/18](net/18-set-kak-kod.md) (TextFSM, NAPALM, NTC-templates). Здесь только принцип: **сравнивать надо не строки, а смысл**.

```python
# tests/test_backbone.py — проверка смысла, а не текста.
# netmiko снимает факт, ntc_templates разбирает, дальше обычные assert.
from netmiko import ConnectHandler
from ntc_templates.parse import parse_output
import os

def with_device(fn, dev_type="cisco_ios"):
    conn = ConnectHandler(
        device_type=dev_type,
        host=os.environ["LAB_SW"],
        username=os.environ["NETOPS_USER"],
        password=os.environ["NETOPS_PASS"],
    )
    try:
        return fn(conn)
    finally:
        conn.disconnect()

def test_uplink_is_in_trunk_vlans():
    """Не «содержит ли строка uplinks.trunk», а «разрешён ли нужный VLAN на аплинке»."""
    def body(conn):
        raw = conn.send_command("show interfaces trunk")
        parsed = parse_output(platform="cisco_ios", command="show interfaces trunk", data=raw)
        trunk = next(p for p in parsed if "0/24" in p["interface"])
        allowed = {int(v) for v in trunk["vlans"].split(",") if v.isdigit()}
        assert {10, 20, 99}.issubset(allowed), f"на аплинке нет служебных VLAN: {trunk['vlans']}"
        assert trunk.get("native_vlan") == "99", f"native={trunk.get('native_vlan')}, ожидался 99"
    with_device(body)

def test_management_acl_blocks_everything_but_peers():
    """Политика в тесте: у vty есть access-class, и он не применим ко всем."""
    def body(conn):
        raw = conn.send_command("show running-config | section line vty")
        assert "access-class MGMT-PEERS in" in raw, "на vty нет access-class — доступ открыт всему миру"
        assert "transport input ssh" in raw, "на vty разрешён telnet"
    with_device(body)
```

### Drift-детектор в CI

Это самая полезная вещь из всей лекции, потому что она единственная ловит то, чего **никто не собирался делать**: изменения, произошедшие вне процесса. Механизм `plan -detailed-exitcode` разобран в [лекции 12](devops/12-terraform-i-ansible.md) — здесь он доводится до системы: по расписанию, по всем окружениям, с уведомлением, с разбором причины.

```yaml
# .github/workflows/drift.yml
name: drift
on:
  schedule:
    - cron: '17 6,14 * * *'        # дважды в сутки, минус от круглого часа
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  drift:
    strategy:
      fail-fast: false
      matrix:
        environment: [staging, prod]
    runs-on: [self-hosted, pve-access]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main                     # всегда актуальный main, не ветка PR

      - name: Подготовить Terraform
        working-directory: environments/${{ matrix.environment }}
        run: |
          set -euo pipefail
          terraform init -input=false -lock-timeout=5m

      - name: План без применения
        id: plan
        working-directory: environments/${{ matrix.environment }}
        run: |
          set +e
          terraform plan -input=false -no-color -lock-timeout=5m -out=tfplan
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
          terraform show -json tfplan > plan.json
          exit 0

      - name: Отчёт
        if: steps.plan.outputs.exit_code == '2'
        run: |
          {
            echo "### Дрейф: ${{ matrix.environment }}"
            echo ""
            echo '```'
            jq -r '.resource_changes[]
                   | "\(.change.actions | join(" -> "))\t\(.address)"' plan.json
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Приложить план как артефакт
        if: steps.plan.outputs.exit_code == '2'
        uses: actions/upload-artifact@v4
        with:
          name: drift-${{ matrix.environment }}
          path: environments/${{ matrix.environment }}/plan.json
          retention-days: 14

      - name: Уведомить
        if: steps.plan.outputs.exit_code == '2'
        run: |
          jq -r '"⚠️ Дрейф в ${{ matrix.environment }}: " +
                 ([.resource_changes[] | "\(.change.actions | join("->")) \(.address)"] | join("\n"))' \
             plan.json | ./scripts/notify.sh

      - name: Провалить прогон — есть расхождение
        if: steps.plan.outputs.exit_code == '2'
        run: |
          echo "Ресурсы в ${{ matrix.environment }} расходятся с кодом."
          echo "Варианты: (1) кто-то изменил руками — внеси в PR с описанием причины;"
          echo "(2) изменился сам провайдер/платформа — обнови код под новое поведение."
          exit 1
```

Три детали, которые делают drift-детектор полезным, а не шумным:

1. **План ничего не применяет.** Никогда. Ни флага «только посмотреть» не существует — пайплайн не содержит шага `apply` в принципе.
2. **Расписание со смещением** (`17 6,14`, а не `0 * * * *`) — иначе все детекторы разных команд придут в один момент и упрутся в API.
3. **Разбор причины, а не только факта.** Дрейф — это не «плохо», это **информация**. Иногда устройство изменилось само (провайдер добавил тег), иногда изменился человек, иногда разъехался state. Каждый случай требует своего ответа, и алерт должен это требовать, а не просто мигать.

## Практика: полный конвейер проверки

Структура репозитория, которая закрывает все четыре уровня:

```text
infra/
├── .github/
│   ├── CODEOWNERS                 # владельцы по путям
│   └── workflows/
│       ├── pr-checks.yml          # уровни 1-3: fmt, validate, policy, plan, комментарий
│       ├── apply.yml              # уровень 2: apply + smoke, только после merge
│       └── drift.yml              # уровень 4: plan по расписанию, никогда не apply
├── .pre-commit-config.yaml        # уровень 3: локально, до пуша
├── policy/
│   ├── terraform/tags.rego        # обязательные метки
│   └── terraform/public_ip.rego   # публичный IP только с обоснованием
├── environments/
│   ├── staging/{main.tf,variables.tf,terraform.tfvars}
│   └── prod/    {main.tf,variables.tf,terraform.tfvars}
├── modules/
│   ├── ubuntu-node/
│   └── vpc/
├── scripts/
│   ├── smoke.sh                   # проверка ожидаемого состояния после apply
│   ├── plan-comment.sh            # публикация плана в PR
│   ├── check_templates.py         # разбор Jinja2-шаблонов
│   └── notify.sh                  # отправка в чат/статус
└── tests/
    ├── golden/lab-sw-01.cfg       # эталон сетевой конфигурации
    └── check_lab_switch.sh
```

```yaml
# .github/workflows/pr-checks.yml — уровни 1-3 для каждого PR
name: pr-checks
on:
  pull_request:
    paths: ['**/*.tf', '**/*.tfvars', 'policy/**', 'modules/**', 'templates/**']
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  static:
    name: lint · validate · policy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: 1.9.8 }
      - uses: terraform-linters/setup-tflint@v4
        with: { tflint_version: latest }

      - run: terraform fmt -check -recursive

      - name: validate по всем окружениям
        run: |
          for env in environments/*/; do
            echo "::group::$env"
            terraform -chdir="$env" init -backend=false -input=false
            terraform -chdir="$env" validate
            echo "::endgroup::"
          done

      - name: tflint
        run: |
          tflint --init
          tflint --recursive --config=.tflint.hcl --format=compact

      - name: политики как код
        run: |
          for env in environments/*/; do
            terraform -chdir="$env" plan -input=false -no-color -out=tfplan || true
            terraform -chdir="$env" show -json tfplan > "$env/plan.json"
            conftest test "$env/plan.json" --policy policy/ --namespace terraform
          done

  plan:
    name: план
    needs: static
    runs-on: [self-hosted, pve-access]     # нужен доступ к API Proxmox и к state
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: 1.9.8 }

      - name: init с доступом к state
        run: |
          for env in environments/*/; do
            terraform -chdir="$env" init -input=false -lock-timeout=5m
          done

      - name: plan
        run: |
          set -euo pipefail
          for env in environments/*/; do
            terraform -chdir="$env" plan -input=false -no-color \
              -lock-timeout=5m -out="$env/tfplan"
            terraform -chdir="$env" show -json "$env/tfplan" > "$env/plan.json"
            terraform -chdir="$env" show -no-color "$env/tfplan" > "$env/plan.txt"
          done

      - name: план в комментарий PR
        run: ./scripts/plan-comment.sh "${{ github.event.pull_request.number }}"

      - uses: actions/upload-artifact@v4
        with:
          name: terraform-plan
          path: environments/*/plan.txt
          retention-days: 14

      - name: упасть, если план меняет прод больше порога
        run: |
          set -euo pipefail
          changes=$(jq '[.resource_changes[] | select(.change.actions != ["no-op"])] | length' \
                    environments/prod/plan.json)
          replacements=$(jq '[.resource_changes[]
                             | select(.change.actions | (index("create") and index("delete")))]
                            | length' environments/prod/plan.json)
          cost=$(jq -r '[.resources[]? | select(.cost_monthly != null) | .cost_monthly] | add // 0' \
                    environments/prod/plan.json)
          {
            echo "### Что изменится в проде"
            echo ""
            echo "| Показатель | Значение |"
            echo "| --- | ---: |"
            echo "| Изменяемых ресурсов | ${changes} |"
            echo "| Пересоздаётся | ${replacements} |"
            echo "| Прирост месячных расходов, USD | ${cost} |"
          } >> "$GITHUB_STEP_SUMMARY"
          [ "$changes" -lt 30 ] || { echo "Слишком много изменений — разбей PR"; exit 1; }
          [ "$replacements" -eq 0 ] || { echo "Есть пересоздание — требуется явное решение ревьюера"; exit 1; }
```

```bash
#!/usr/bin/env bash
# scripts/plan-comment.sh — план в комментарий PR, а не в лог, который никто не читает
set -euo pipefail
PR="$1"
MARK="<!-- tf-plan -->"
BODY="$(jq -n --arg body "$MARK" '{body: $body}')"

# обновить существующий комментарий, а не плодить новые
existing=$(gh api "repos/{owner}/{repo}/issues/${PR}/comments" \
           --jq '[.[] | select(.body | contains("<!-- tf-plan -->"))] | first | .id' || true)

summary=$(jq -r '
  [.resource_changes[] | select(.change.actions != ["no-op"])]
  | map(.change.actions | join("+")) | group_by(.) | map({(.[0]): length}) | add
  | to_entries | map("\(.key): \(.value)") | join("  ")' environments/prod/plan.json)

if [ -n "$existing" ] && [ "$existing" != "null" ]; then
  gh api --method PATCH "repos/{owner}/{repo}/issues/comments/${existing}" \
     --field body="$(cat <<EOF
${MARK}
## План изменений в проде

Операции: \`${summary}\`

Полный вывод \`terraform show\` — в артефакте \`terraform-plan\`.
Полный JSON плана прикреплён: без него нельзя проверить ни одну политику вручную.

> План не применяется этим пайплайном. Применение — отдельный workflow после merge.
EOF
)"
else
  gh api --method POST "repos/{owner}/{repo}/issues/${PR}/comments" \
     --field body="$(cat <<EOF
${MARK}
## План изменений в проде

Операции: \`${summary}\`
EOF
)"
fi
```

Обрати внимание на последний шаг `pr-checks`: **план не применяется этим пайплайном вообще**. Это не паранойя, а единственная структура, в которой невозможно случайно применить то, что не было проверено. Ручной merge, ручной запуск `apply.yml` с набором approval — ровно та последовательность, которая описана как «ручной merge → apply».

## Где это ломается

1. **План читают по диагонали.** Список `~` в начале выглядит как скучная рутина, и `-/+` в самом низу не читают. Автоматизируй извлечение пересозданий — это три строки на `jq` и единственная проверка, которая реально спасает прод.
2. **`-/+` на ресурсе с данными.** Самое дорогое, что можно сделать в пятницу. Никакой линтер это не поймает, если в модуле не задан `create_before_destroy` или нет `lifecycle` — политика тут бессильна, помогает только ревью и порог в пайплайне.
3. **`--check` в Ansible без `--diff`.** Показывает «будет изменено: 14 задач» и ни слова о том, какие строки удаляются. Это ощущение безопасности без содержания.
4. **Проверка через `shell` и `command`.** Эти модули в check mode просто пропускаются, и в отчёте стоит `SKIPPED`, который читают как «проверено, всё ок».
5. **Политика, которая молча не скомпилировалась.** Смена версии OPA и синтаксиса Rego — идеальный способ получить зелёную проверку, которая ничего не проверяет. После любого обновления инструмента прогоняй политику на заведомо плохом примере и убедись, что она краснеет.
6. **Теги навешиваются на уровне модуля и теряются при `for_each`/`count`.** Ресурс, созданный из вложенной инстанс-композиции, наследует не все теги. Проверка «у ресурса есть теги» начнёт ругаться на всё подряд, и её отключат.
7. **Pre-commit без CI.** `--no-verify` существует, и им пользуются не из злости, а по таймауту. Линтер в пайплайне обязателен, хук — приятен.
8. **Smoke-тест без таймаута и без окна наблюдения.** Один `curl` в момент применения ловит только совсем мёртвое. Проверка должна повторяться минуту и проверять содержимое ответа, а не только код.
9. **Дрейф-детектор, который никто не читает.** Он падает, рассылает уведомление в бота, бот постит в канал, канал не смотрят. Через месяц красный статус становится фоном. Отчёт должен попадать в утреннюю сводку или хотя бы раз в неделю обсуждаться.
10. **«Нет дрейфа — значит, всё в порядке».** Отсутствие расхождений не означает, что инфраструктура правильная. Оно означает только, что она совпадает с кодом. Ошибка, одинаково описанная в коде и в облаке, дрейфом не считается.
11. **Тестовый аккаунт в облаке, который никто не гасит.** Песочница стоит денег ровно так же, как прод, только её забывают закрывать. Тестовые стенды — это статья расходов, которую надо ставить на авто-гашение по тегу, см. [FinOps](devops/30-finops.md).
12. **Один человек в команде и «ревью» как формальность.** Если CODEOWNERS указывает на тебя самого, ревью превращается в самодиалог. В этом случае честнее вложиться в автоматизацию (политики, пороги, детекторы) — она работает и без второго человека.

## Чек-лист понимания

- [ ] Я умею прочитать `terraform plan` и могу написать команду, которая выведет **все** пересоздаваемые ресурсы (`-/+`)
- [ ] Я понимаю, чем `-/+` отличается от `~` для ресурса с данными, и знаю, что делать с `create_before_destroy`
- [ ] Я знаю четыре случая, когда `ansible --check --diff` молчит, и умею отличить `SKIPPED` от «проверено»
- [ ] Я могу написать политику Rego «у ресурса есть обязательные метки» и понимаю, почему она проверяет план, а не исходники
- [ ] Я знаю, что политика может молча ничего не проверять после смены версии OPA, и умею это проверить на заведомо плохом примере
- [ ] Я умею написать smoke-проверку, которая повторяется 60 секунд и проверяет содержимое ответа, а не только HTTP-код
- [ ] Я могу собрать репозиторий инфраструктуры так, чтобы в нём были pre-commit, обязательный статус CI, CODEOWNERS и дрейф-детектор по расписанию
- [ ] Я понимаю, почему отсутствие дрейфа не означает правильности инфраструктуры

Дальше — то, что происходит, когда проверки не помогли: [Инциденты, разборы и runbooks](devops/29-incidenty-i-postmortem.md).