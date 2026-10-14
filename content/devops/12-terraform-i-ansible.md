---
title: Terraform и Ansible
track: devops
module: B. Контейнеры и оркестрация
order: 12
duration: 80 мин
level: senior
tags: [terraform, iac, ansible, idem-potency, provisioning]
summary: Почему ручная настройка сервера не воспроизводится, как Terraform описывает инфраструктуру и почему его state файл — секрет, и как написать идемпотентный playbook Ansible.
practice: Напиши playbook, который ставит node_exporter на Ubuntu через apt, раскладывает unit-файл systemd с шаблоном Jinja2 и добавляет port в ufw; запусти его дважды и сравни вывод второй версии — он должен быть без изменений.
---

Ты настраивал Linux вручную в [лекции 05](devops/05-bash-skripty.md): команды в терминале, конфиги через редактор, обновление через apt. Так работает один человек на одной машине. В момент, когда появляется вторая такая же машина, начинается новая жизнь — и жизнь эта состоит из вопроса «а как именно я настраивал тот первый сервер?». IaC превращает знание в файл. Разбираем два инструмента с разной философией: Terraform создаёт инфраструктуру, Ansible настраивает уже созданную.

## Зачем IaC и что он решает

Ручная настройка даёт три проблемы, и все три выходят на руководителя, а не на инженера.

**Невоспроизводимость.** Поднял стенд, потратил два часа, он работает. Через месяц нужен второй стенд — и ты повторяешь всё по памяти. Что-то забудешь, и второй стенд будет отличаться от первого. Отличия всплывают через неделю, в виде необъяснимых расхождений в поведении.

**Отсутствие истории.** `apt install` не версионируется. Что стояло на сервере год назад — неизвестно, если только ты не вёл заметки. Когда приходит аудит или нужно понять, почему фаервол настроен так, а не иначе, ответа нет.

**Дрейф.** Сервер меняется руками: кто-то поправил конфиг, чтобы побыстрее заработало, и забыл. Описание в репозитории говорит одно, реальность — другое. Никто этого не замечает, пока не приходит откат или повторное развёртывание.

Terraform и Ansible дают ответ: **состояние сервера описано в Git, значит, у него есть история, ревью и откат.**

| | Terraform | Ansible |
| --- | --- | --- |
| Философия | Декларативная | Императивная, но идемпотентная |
| Описание | «Хочу ресурс с такими-то свойствами» | «Сделай шаг 1, шаг 2, шаг 3» |
| Объект работы | Облачные ресурсы, VM, диски, сети | Существующие машины: файлы, пакеты, сервисы |
| Источник правды | Текущее состояние + state-файл | Состояние машины + проверка через модули |
| Ключевое слово | `plan` (покажет diff) | `idempotent` (можно повторять) |
| Идемпотентность | Встроенная в модель | Достигается дисциплиной и модулями |

## Terraform: модель

Terraform читает HCL — декларативный язык конфигурации. Файл `main.tf`:

```hcl
terraform {
  required_version = ">= 1.6"
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.55"
    }
  }
  backend "s3" {
    bucket       = "llmops-tfstate"
    key          = "production/terraform.tfstate"
    region       = "eu-central-1"
    encrypt      = true
    dynamodb_table = "llmops-tflock"
  }
}

provider "proxmox" {
  endpoint = "https://pve.example.com:8006/api2/json"
  api_token = var.proxmox_token
  insecure  = false
}

variable "proxmox_token" {
  type      = string
  sensitive = true
}

variable "node_name" {
  type    = string
  default = "pve"
}

resource "proxmox_virtual_environment_vm" "ubuntu" {
  node_name = var.node_name
  name      = "llmops-ubuntu-01"
  description = "Узел приложений, управляется Terraform"

  machine   = "q35"
  cores     = 8
  sockets   = 1
  memory    = 16384
  scsi_hardware = "virtio-scsi-single"

  disk {
    datastore_id = "local-lvm"
    file_id      = proxmox_virtual_environment_downloaded_iso.ubuntu.id
    interface    = "scsi0"
    size         = 32
  }

  network_device {
    bridge = "vmbr0"
    model  = "virtio"
  }

  operating_system {
    type = "l26"
  }

  start_after_creation = true
  agent_enabled        = true

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [disk[0].file_id]   # не трогать ISO при обновлении
  }
}

resource "proxmox_virtual_environment_downloaded_iso" "ubuntu" {
  content               = "local:iso/ubuntu-24.04.1-live-server-amd64.iso"
  datastore_id          = "local"
  node_name             = var.node_name
}

output "vm_ip" {
  value     = proxmox_virtual_environment_vm.ubuntu.ipv4_addresses[0].address
  sensitive = false
}
```

Ключевые блоки: `terraform` (версия и провайдеры), `provider` (куда подключаться), `resource` (что создать), `data` (прочитать существующее, ничего не создавая), `variable` с `sensitive = true` (значение не печатается в выводе), `output` (значения для других модулей и для людей).

`lifecycle` — то, что спасает нервы. `create_before_destroy` создаёт новую ВМ, переносит нагрузку и только потом удаляет старую. `ignore_changes` говорит Terraform'у не реагировать на дрейф отдельных атрибутов — например, на IP, который он же и не контролирует.

```bash
terraform init                    # скачать провайдеры, настроить backend
terraform fmt -recursive          # привести формат к канону — обязательно в CI
terraform validate                # проверить синтаксис и типы
terraform plan -out=tfplan        # посмотреть изменения, сохранить в файл
terraform show tfplan             # человекочитаемый diff
terraform apply tfplan            # применить ровно то, что ты увидел
terraform state list              # что сейчас в состоянии
```

> [!IMPORTANT]
> `apply` без файла плана — это `plan`, который никто не прочитал. Рабочая
> дисциплина: `plan -out=tfplan`, посмотрел глазами, `apply tfplan`. Тогда
> Terraform применяет именно то изменение, которое ты одобрил, а не то,
> что передумало за десять минут между командами.

## State: почему это главный секрет проекта

State-файл — не кэш, а **единственный источник правды** о том, что Terraform создал и как это называется. Из него Terraform знает, что ресурс с ID `vm-1042` уже существует, и не создаст второй.

Отсюда три правила, которые нарушают постоянно.

**Первое: state содержит секреты в открытом виде.** Terraform пишет туда значения всех атрибутов, включая пароли, токены и приватные ключи, которые он видел при создании ресурса. Особенно это касается тех, кто делает `user_data` с паролем или подставляет секреты в поля, которые потом читает провайдер. Поэтому `terraform.tfstate` — файл уровня «содержимое базы данных», и обращаться с ним нужно соответственно.

**Второе: state должен лежать в надёжном месте.** Локальный `terraform.tfstate` на рабочем ноутбуке — это потерянная инфраструктура. Если файл уехал с ноутбуком, удалён, или две машины сделали `apply` параллельно, следующий `plan` предложит «создать всё заново» поверх работающего. Классика: утренний инцидент из-за `terraform.tfstate`, который лежал в `/tmp`.

**Третье: state должен быть один на окружение.** Не на человека, не на ветку, не на модуль. Один state — один набор ресурсов. Два человека, работающие с одним state параллельно, без блокировки сделают две несовместимые операции.

```hcl
terraform {
  backend "s3" {
    bucket         = "llmops-tfstate"
    key            = "production/terraform.tfstate"
    region         = "eu-central-1"
    encrypt        = true
    dynamodb_table = "llmops-tflock"   # таблица блокировок, защита от параллельных apply
  }
}
```

Бэкенд S3 работает в два слоя: шифрование на стороне S3 (файл лежит зашифрованным) и DynamoDB-таблица как lock. Lock нужен, чтобы два `apply` не начали одновременно. Альтернативы: GCS (`-backend "gcs"`, блокировка через файл `.tflock`), Consul, PostgreSQL. Для self-hosted без облака есть смысл поднять MinIO и говорить с ним по S3-протоколу.

> [!CAUTION]
> Один разработчик положил state в репозиторий. Другой попросил доступ к
> репозиторию «почитать конфиги». Утром обновление соседнего стенда
> затёрло его VM. State не коммитится — он лежит в отдельном бакете с
> шифрованием и версионированием.

## Модули, workspaces, версионирование

**Модуль** — переиспользуемый кусок конфигурации со своим входом (`variables`) и выходом (`outputs`). Твоя стратегия «один вендор, одна схема сети» — это модуль.

```hcl
module "ubuntu_node" {
  source = "git::https://git.example.com/iac/modules//ubuntu-node?ref=v2.3.0"

  node_name = "llmops-node-${count.index + 1}"
  cores     = 8
  memory    = 16384
  tags      = ["prod", "apps"]

  ssh_public_key = file("~/.ssh/id_ed25519.pub")
}

resource "random_pet" "node" {
  length    = 2
  separator = "-"
}

output "nodes" {
  value = module.ubuntu_node
}
```

Тег `?ref=v2.3.0` — фиксация версии модуля. Без него следующий `init` подтянет main и у тебя поменяется инфраструктура без единого изменения в твоём коде. Это тот же класс ошибки, что `latest` в [лекции 08](devops/08-docker.md) и `latest` в Kubernetes.

**Workspaces** дают несколько state на одном наборе конфигурации: `terraform workspace new staging`, `terraform workspace select staging`. Удобно, но есть подвох: переменные окружения, хранящиеся в state, общие для всех воркспейсов. Если в `staging` и в `production` одна конфигурация, а различаются только значения переменных — эти значения обязаны быть в отдельных state, а не в `.tfvars` по умолчанию. Иначе switch воркспейса изменит продакшн.

**Версионирование** — тот же Git, тот же флоу: ветка, PR, ревью, теги. Terraform-код на 500 строк без ревью — это ручная работа с шаблоном, а не IaC.

## Дрейф и plan в CI

Самое недооценённое применение Terraform — не создание ресурсов, а **детектор изменений**. Регулярный `plan` в CI покажет, что кто-то изменил сервер руками, до того как это станет проблемой:

```bash
set -euo pipefail
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform plan -detailed-exitcode -no-color
```

Коды возврата `terraform plan -detailed-exitcode`: `0` — изменений нет, `2` — изменения есть, `1` — ошибка. В CI это читается так:

```bash
terraform plan -detailed-exitcode -no-color
code=$?
if [ "$code" -eq 0 ]; then
  echo "drift не обнаружен"
elif [ "$code" -eq 2 ]; then
  echo "Инфраструктура изменилась вне Terraform — разберись с причиной."
  exit 1
else
  exit "$code"
fi
```

Планирующий `plan` в CI не применяет изменения — он только сообщает. Это дешёвый способ узнать, что кто-то зашёл на сервер по SSH в обход процесса. Ещё дешевле и эффективнее — тот же `plan` по расписанию, раз в день, с уведомлением в чат.

## Ansible: модель

Ansible работает иначе. Он не создаёт инфраструктуру, а подключается к существующим машинам по SSH и приводит их к описанному состоянию. Ядро понятий:

- **Inventory** — список машин: адреса, группы, переменные. INI или YAML.
- **Playbook** — сценарий: последовательность play'ев (по группам) и задач (tasks).
- **Task** — одно действие, выполненное модулем.
- **Handler** — задача, которая срабатывает по событию, обычно `notify` при изменении конфига.
- **Role** — переиспользуемый набор задач, шаблонов, переменных, обработчиков и дефолтов. Стандартная сборка приложения.
- **Jinja2** — шаблонизация: переменные, условия, циклы.

`inventory/hosts.yml`:

```yaml
all:
  children:
    nodes:
      hosts:
        node1.example.com:
          ansible_user: ops
        node2.example.com:
          ansible_user: ops
    db:
      hosts:
        db1.example.com:
    monitoring:
      hosts:
        node1.example.com:
        node2.example.com:
    _meta:
      common:
        ansible_python_interpreter: /usr/bin/python3
```

Группы нужны, чтобы нацеливать play на подмножество: `ansible-playbook site.yml --limit monitoring`. Лимит — главный инструмент безопасности: сначала прогоняешь на одной машине, потом на остальных.

Плейбук ставит и настраивает node_exporter:

```yaml
- name: Настройка мониторинга узлов
  hosts: nodes
  become: true
  vars:
    node_exporter_version: "1.8.2"
    node_exporter_user: node_exporter
  handlers:
    - name: restart node_exporter
      ansible.builtin.systemd:
        name: node_exporter
        state: restarted
        daemon_reload: true
  tasks:
    - name: Создать пользователя node_exporter
      ansible.builtin.user:
        name: "{{ node_exporter_user }}"
        system: true
        shell: /usr/sbin/nologin
        create_home: false
        state: present

    - name: Установить node_exporter
      ansible.builtin.unarchive:
        src: "node_exporter-{{ node_exporter_version }}.linux-amd64.tar.gz"
        dest: /opt
        remote_src: true
        owner: root
        group: root
        mode: "0755"
      notify: restart node_exporter

    - name: Создать пользователя для systemd-сервиса
      ansible.builtin.user:
        name: "{{ node_exporter_user }}"
        system: true
        shell: /usr/sbin/nologin
        create_home: false
        state: present

    - name: Разложить unit-файл systemd
      ansible.builtin.template:
        src: node_exporter.service.j2
        dest: /etc/systemd/system/node_exporter.service
        owner: root
        group: root
        mode: "0644"
      notify:
        - restart node_exporter
        - reload systemd

    - name: Перезагрузить systemd и включить сервис
      ansible.builtin.systemd:
        name: node_exporter
        enabled: true
        state: started
        daemon_reload: true

    - name: Открыть порт в фаерволе
      community.general.ufw:
        rule: allow
        port: "9100"
        proto: tcp
        comment: "node_exporter"
        state: enabled

    - name: Проверить, что метрики отдаются
      ansible.builtin.uri:
        url: "http://127.0.0.1:9100/metrics"
        method: GET
        return_content: true
      register: metrics
      failed_when: metrics.status != 200

    - name: Сообщить, сколько метрик отдаётся
      ansible.builtin.debug:
        msg: "Строк метрик: {{ metrics.content | length }}"
```

`node_exporter.service.j2`:

```ini
[Unit]
Description=Prometheus Node Exporter
After=network-online.target

[Service]
User={{ node_exporter_user }}
ExecStart=/opt/node_exporter-{{ node_exporter_version }}.linux-amd64/node_exporter \
  --web.listen-address=:9100 \
  --collector.textfile.directory=/var/lib/node_exporter/textfile_collector
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> [!TIP]
> Порядок в playбуке — это порядок зависимостей, а не случайный набор.
> Сначала пользователь, потом файлы, потом `daemon_reload`, потом `state: started`,
> в конце — проверка через `uri`. Именно последняя строка отличает playбук,
> который «отработал», от playбука, который «сломался, но Ansible не заметил».
> Всё, что после `template` и меняет его результат, вешается на `notify`.

**Условия и циклы** — то, что превращает копипаст в поддерживаемую конфигурацию:

```yaml
- name: Создать пользователей приложения
  ansible.builtin.user:
    name: "{{ item.name }}"
    group: "{{ item.group }}"
    shell: "{{ item.shell }}"
    state: present
  loop:
    - { name: llmops-api, group: llmops, shell: /usr/sbin/nologin }
    - { name: llmops-worker, group: llmops, shell: /usr/sbin/nologin }

- name: Не ставить TLS, если переменная не задана
  ansible.builtin.copy:
    src: "certs/{{ item }}.pem"
    dest: "/etc/llmops/{{ item }}.pem"
    mode: "0600"
  loop: "{{ tls_certificates }}"
  when: tls_certificates is defined and tls_certificates | length > 0
```

## Идемпотентность: почему playbook можно запускать сто раз

Идемпотентность — это свойство операции давать **одинаковый результат** при повторном применении. Модуль `user` проверяет, существует ли пользователь, и если да — ничего не делает. Модуль `template` сравнивает контент и правит файл, только если он отличается. Модуль `systemd` сверяет состояние. Это позволяет прогнать плейбук десять раз подряд и получить одинаковый результат — а значит, безопасно запускать его в `cron` или в пайплайне каждую ночь.

Проблема в том, что **не все задачи идемпотентны по своей природе**, и именно на этом ломаются автоматизации.

```yaml
# НЕ идемпотентно. Каждый запуск дописывает строку в конец файла.
- name: Дописать host в known_hosts
  ansible.builtin.shell: "echo '{{ item }} {{ host_key }}' >> /home/ops/.ssh/known_hosts"
  loop: "{{ hosts_list }}"

# Идемпотентно. Модуль сам разберётся.
- name: Дописать host в known_hosts
  ansible.builtin.lineinfile:
    path: /home/ops/.ssh/known_hosts
    line: "{{ item }}"
    state: present
    create: true
  loop: "{{ hosts_list }}"
```

Почему это опасно именно тихо. Первый запуск работает. Второй — тоже работает, просто файл стал длиннее. Однажды этот файл скормили `ssh-keygen -F` или проверке strict host key, и сломалось что-то совсем в другом месте. Диагностика: «когда это сломалось, я ничего не менял», потому что менял — месяц назад, в плейбуке, который все прогоняли.

Три правила, которые стоит зафиксировать:

1. **Модуль вместо shell.** Прежде чем писать `ansible.builtin.shell`, проверь, нет ли готового модуля. Модуль почти всегда идемпотентен.
2. **Если shell неизбежен** — делай его идемпотентным вручную. `grep -q` перед добавлением, `rm -f` перед `ln -sf`, `create: true` на декоративных файлах:

```yaml
- name: Обновить timezone
  ansible.builtin.command: timedatectl set-timezone Europe/Moscow
  changed_when: false        # сервис всегда рапортует "changed", но фактически меняет только при отличии
```

`changed_when: false` — честная аннотация для модулей, которые всегда возвращают `changed`. Её нельзя ставить везде: иначе отчёт о том, что изменилось, станет бесполезным, и ты потеряешь главную ценность Ansible — точный отчёт `changed: [x]`.

3. **`check mode` в CI.** `ansible-playbook --check --diff` покажет, что изменится, ничего не применяя. Это прямой аналог `terraform plan`, и в пайплайне ему место такое же.

## Сравнение: когда что применять

| Критерий | Terraform | Ansible | Руками |
| --- | --- | --- | --- |
| Тип работы | Декларативный | Императивный, идемпотентный | — |
| Создаёт ресурсы | Да | Нет | Да |
| Настраивает существующее | Ограниченно (provisioner-ы) | Да | Да |
| Показывает изменения до применения | `plan` | `--check --diff` | Нет |
| Работает с приватным реестром приложений | Косвенно | Да (шаблоны, copy) | Да |
| Порог входа | Высокий | Средний | Нулевой |
| Годится для одноразовых ручных операций | Нет | Да | Да |
| Технический долг при неправильном использовании | State в Git, `latest`-модули | Неидемпотентный shell | Всегда |

Практический расклад, который работает в контуре Proxmox: Terraform создаёт и пересоздаёт ВМ, диски, сетевые бриджи; Ansible настраивает созданное — пакеты, сервисы, файлы конфигурации, пользователей. Связка работает так: Terraform создаёт машину и кладёт ей DNS-имя, Ansible подключается по этому имени и доводит до нужного состояния. Мост между ними — инвентарь, который тоже можно генерировать из Terraform через `output`.

## Секреты в Ansible

Ansible Vault — встроенное шифрование: `ansible-vault encrypt deploy/vault.yml`. Файл в репозитории становится нечитаемым, пароль передаётся через `~/.ansible/galaxy` или переменную `VAULT_PASSWORD_FILE`. Лучше — CI-секрет, а не файл на ноутбуке.

Vault-файлы не должны содержать значений по умолчанию: если в них лежит пароль, а в `group_vars/all.yml` стоит запасной, ты не понимаешь, какой из них применяется. Правило: секрет либо задан, либо задача падает с понятной ошибкой.

## Практика: node_exporter на Ubuntu

1. Создай структуру роли:

```text
ansible/
  inventory/hosts.yml
  site.yml
  roles/node_exporter/
    defaults/main.yml
    tasks/main.yml
    handlers/main.yml
    templates/node_exporter.service.j2
```

2. `roles/node_exporter/defaults/main.yml`:

```yaml
node_exporter_version: "1.8.2"
node_exporter_user: node_exporter
node_exporter_port: 9100
node_exporter_archive: "node_exporter-{{ node_exporter_version }}.linux-amd64.tar.gz"
```

3. `roles/node_exporter/handlers/main.yml`:

```yaml
- name: restart node_exporter
  ansible.builtin.systemd:
    name: node_exporter
    state: restarted
    daemon_reload: true
```

4. Скопируй задачи из плейбука выше в `tasks/main.yml`, вынеси переменные в `defaults`.

5. Прогон:

```bash
cd ~/labs/ansible
ansible-galaxy init roles/node_exporter
ansible-inventory -i inventory/hosts.yml --graph
ansible-playbook -i inventory/hosts.yml site.yml --check --diff --limit node1
ansible-playbook -i inventory/hosts.yml site.yml --limit node1
ansible-playbook -i inventory/hosts.yml site.yml --limit node1   # второй прогон
```

Сравни вывод второго и третьего прогона: `changed=0` для всех задач, кроме тех, где есть `changed_when: false` в неправильном месте. Если третий прогон снова показывает `changed` — ищи неидемпотентную задачу, обычно это `shell` или `lineinfile` без `state: present`.

Проверь на самой машине:

```bash
systemctl status node_exporter
curl -s http://127.0.0.1:9100/metrics | head
curl -s http://127.0.0.1:9100/metrics | wc -l
```

Дальше этот экспортёр становится источником метрик для [наблюдаемости](devops/15-monitoring-concepts.md), а сам Ansible — частью пайплайна, который мы разбираем в [следующей лекции](devops/13-git-rabota-s-komandoy.md).

## Где это ломается

1. **State в Git.** Файл с паролями и токенами попадает в историю коммитов. Отсёчь его оттуда нельзя, только переписывать историю и ротировать все секреты.
2. **State потерян или рассинхронизирован.** `plan` предлагает пересоздать всё, а на самом деле половина ресурсов жива. Дублируются сетевые адреса, заканчиваются лимиты у провайдера, кто-то получает отказ в SLA.
3. **Два человека делают `apply` одновременно** без блокировки в бэкенде. Результат — часть ресурсов создана, часть удалена, state не соответствует реальности.
4. **Модуль без `?ref=` или с `latest`.** `terraform init` подтянул новую версию модуля, и на следующем `apply` пересоздалась группа безопасности, которая вам не нужна была трогать вообще.
5. **`apply` без `plan` в продакшне.** Разница в одну строку, и это удаление сетевого интерфейса у единственной ВМ с приложением.
6. **Неидемпотентный `shell` с `>>`.** Файл растёт при каждом прогоне, ломается что-то отдалённое, причина не находится неделями.
7. **Playbook без `check mode` в CI.** Изменение едет на все ноды сразу, ошибка тиражируется, чинить приходится вручную на каждой.
8. **`become: true` на весь плейбук.** Плеск воды через sudo там, где достаточно `become_user` на конкретной задаче. Ошибка в таком плейбуке опаснее, потому что выполняется от root.
9. **Playbook на 800 строк без ролей.** Любое изменение требует теста на всём стенде, и никто не рискует его вносить. Роли существуют ровно для этого.
10. **Vault-пароль в репозитории или в `~/.vault_pass`.** Зашифрованный файл бесполезен, если пароль лежит рядом.

## Чек-лист понимания

- [ ] Я объясняю, почему ручная настройка не воспроизводится, и знаю три проблемы, которые это создаёт.
- [ ] Я различаю `resource`, `data`, `variable`, `output`, `provider` и понимаю роль блока `lifecycle`.
- [ ] Я всегда делаю `plan -out=tfplan` перед `apply` и знаю, что именно показывает `terraform state list`.
- [ ] Я понимаю, что state содержит секреты в открытом виде, и знаю, где он должен лежать.
- [ ] Я знаю про блокировку в бэкенде и могу объяснить, что будет при параллельных `apply`.
- [ ] Я помню про `?ref=` на модулях и про `ignore_changes` для полей, которые не под контролем.
- [ ] Я умею читать `plan -detailed-exitcode` в CI как детектор дрейфа.
- [ ] Я различаю inventory, playbook, task, handler, role и умею использовать Jinja2 с `when` и `loop`.
- [ ] Я объясняю идемпотентность и умею переписать `shell` с `>>` на идемпотентный модуль.
- [ ] Я знаю, когда применять Terraform, когда Ansible, а когда достаточно рук — и почему `check mode` обязателен в пайплайне.