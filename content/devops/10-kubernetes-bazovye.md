---
title: Kubernetes: ядро
track: devops
module: B. Контейнеры и оркестрация
order: 10
duration: 90 мин
level: middle
tags: [kubernetes, pod, deployment, service, configmap]
summary: Как control plane превращает твоё YAML-описание в работающие поды, зачем нужен Service, что живёт в ConfigMap и PVC, и как читать describe pod, когда под завис в Pending.
practice: Разверни приложение из Deployment, Service, ConfigMap и PersistentVolumeClaim в kind, проверь обновление через rollout и смоделируй Pending, сняв свободную память на ноде.
---

Compose научил тебя поднимать несколько контейнеров на одной машине. Следующая ступень реальности: у тебя не один сервер, а три, контейнеров сорок, обновления выходят каждую неделю, а в три часа ночи никто не должен вручную ехать перезапускать процесс. Оркестратор берёт на себя три задачи, которые Compose не решает: **куда поставить**, **как заменить упавшее**, **как обновить без простоя**. Разбираем ядро Kubernetes — а в следующей лекции [11](devops/11-kubernetes-prodvans.md) то, что превращает работающий стенд в продакшн.

## Зачем после Compose нужен оркестратор

| Задача | Compose | Kubernetes |
| --- | --- | --- |
| Где запустить контейнер | Там, где запустил | Планировщик выбирает подходящую ноду |
| Упал процесс | Перезапуск на той же машине | Новый под на любой свободной ноде |
| Обновление версии | Остановка и старт, простой | RollingUpdate, сервис не теряет трафик |
| Масштабирование | Руками | HPA по метрикам, кластер добавляет ноды |
| Сеть между сервисами | Bridge + DNS Compose | Service + сетевые политики |
| Переживание сбоя ноды | Нет | Под переезжает на другую ноду |
| Кто следит за состоянием | Никто | Контроллеры и kubelet |

Ключевая мысль: Kubernetes — это **декларативная** система. Ты не говоришь «запусти три контейнера», ты описываешь желаемое состояние, а контроллеры сами добираются до него.

## Архитектура: control plane и worker

Control plane — это «мозг», он принимает твои манифесты и принимает решения. Worker-нода — это «руки», на ней реально крутятся контейнеры.

| Компонент | Где | Что делает |
| --- | --- | --- |
| `kube-apiserver` | control plane | Единая точка входа для всех запросов. Всё остальное общается только с ней |
| `etcd` | control plane | Хранилище состояния кластера. Единственный источник правды |
| `kube-scheduler` | control plane | Смотрит на свободные ресурсы нод и решает, куда положить под |
| `kube-controller-manager` | control plane | Набор контроллеров: Deployment, ReplicaSet, Service, Node — они и приводят систему к описанию |
| `kubelet` | каждая нода | Скачивает образы, запускает контейнеры, следит за ними, репортует состояние |
| `kube-proxy` | каждая нода | Реализует Service: правила iptables/IPVS, по которым трафик идёт на поды |
| Container Runtime (CRI) | каждая нода | containerd или CRI-O — то, что реально запускает контейнеры |
| CNI | каждая нода | Сетевой плагин (Calico, Cilium, Flannel) — выдаёт подам IP и маршрутизацию |

Схема взаимодействия простая: ты пишешь `kubectl apply` → apiserver сохраняет объект в etcd → контроллеры замечают изменение и создают, например, новый под → scheduler выбирает ноду → kubelet на этой ноде запускает контейнер.

> [!IMPORTANT]
> Единственное, что переживает перезапуск control plane — это etcd. Всё остальное
> можно пересоздать из манифестов: apiserver stateless, контроллеры stateless,
> kubelet восстановит поды из своего состояния. Следовательно, **etcd — то, что
> бэкапится**. Именно поэтому single-node-кластеры на одной ВМ — это несерьёзно,
> как и хранение etcd на том же диске, что и ваша БД.

## Декларативность на пальцах

Представь описание: «у меня должно быть 3 экземпляра API, версия 1.4.2, у каждого 500 мегабайт памяти, доступ извне по имени `api` в пределах кластера». Это и есть спецификация. Дальше система сама:

- увидела, что подов два вместо трёх, — создала третий;
- увидела, что под не отвечает на `/healthz`, — перезапустила;
- увидела, что из-за `RollingUpdate` надо доехать до версии 1.4.3 — убила по одному старому и поднимала новые;
- потеряла ноду — её поды пересоздались на другой.

Поэтому в кластере **руками ничего не делают**. Если подравил ресурс через `kubectl edit`, изменение живёт до следующего `apply` из репозитория и исчезает бессильно. Все изменения — только через Git. Это то, что в любой крупной компании контролируется отдельно: `RBAC` не даёт обычному разработчику права на `patch`, а аудит ловит попытки. Вернуться к ней можно в [лекции 12](devops/12-terraform-i-ansible.md) — там та же логика с state-файлом Terraform.

## Pod — единица планирования

Pod — это обёртка над одним или несколькими контейнерами, которые должны жить вместе и делить сетевое пространство и тома. Но планирует Kubernetes **поды, а не контейнеры**: CPU, память, IP, том и время жизни запрашиваются на под целиком.

Ключевые свойства:

- **Одноразовый.** Упал — не воскреснет, `restartPolicy: Always` перезапустит контейнер внутри, но сам под — нет. Пересоздаёт его ReplicaSet.
- **У каждого пода свой IP.** Не фиксированный, и он меняется при пересоздании.
- **Контейнеры внутри пода делят localhost и тома.** Это позволяет sidecar-паттерн.
- **В одном поде не нужны два контейнера, если они не связаны по судьбе.** Ставить весь стек в один под — антипаттерн: он не масштабируется отдельно и переживает обновление только целиком.

```bash
kubectl run api --image=registry.example.com/llmops/api:1.4.2 \
  --port=8000 --restart=Never --dry-run=client -o yaml > pod.yaml
kubectl get pod api -o wide          # смотри колонку NODE и IP
kubectl describe pod api | head -40
kubectl delete pod api              # он одноразовый, удаляй руками
```

> [!CAUTION]
> `kubectl run` без `kubectl apply` — одноразовая операция. Созданный
> вручную под ничем не управляется: ни масштабируется, ни переживает ноду,
> ни виден для Deployment. Для всего, что должно жить, есть ReplicaSet.

## Манифест: четыре обязательных части

Каждый объект Kubernetes описывается одним YAML-документом, и структура всегда одна:

```yaml
apiVersion: apps/v1        # какая группа API, какая версия
kind: Deployment           # тип объекта
metadata:                  # кто это, как найти
  name: api
  namespace: production
  labels:
    app: api
    version: 1.4.2
spec:                      # что именно должно быть правдой (для Deployment — pod-шаблон)
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:                # шаблон пода
    metadata:
      labels:
        app: api           # должен совпадать с selector.matchLabels
    spec:
      containers:
        - name: api
          image: registry.example.com/llmops/api:1.4.2
          ports:
            - containerPort: 8000
```

Связка `spec.selector.matchLabels` и `metadata.labels` шаблона — самая частая причина ошибок в манифестах. Селектор **неизменяем**: если поменять лейблы в селекторе существующего Deployment, `apply` упадёт с ошибкой валидации. Лейбл — это ключ, по которому контроллер находит «свои» поды, и его можно менять только вместе с удалением объекта.

## Deployment и ReplicaSet

Deployment — это контроллер верхнего уровня: он хранит `replicas`, применяет стратегию обновления и управляет ReplicaSet'ами. ReplicaSet — простой контроллер, который следит, чтобы подов с нужными лейблами было ровно `replicas`. Всё вместе это автоматический «сторож»: упал под — ReplicaSet создаст новый.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1          # сколько новых подов разрешено сверх replicas
      maxUnavailable: 0    # сколько старых можно убить одновременно (0 = без простоя)
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: registry.example.com/llmops/api:1.4.3
          ports:
            - containerPort: 8000
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              memory: 512Mi
```

`maxSurge: 1, maxUnavailable: 0` — стандартная боевая настройка: сначала поднимается один новый под и только убеждается, что он готов, потом убивается один старый. Если у тебя кластер тесный и поды большие, временный +1 под может не поместиться — тогда `maxUnavailable: 1, maxSurge: 0` обменивает скорость на место. Подробно про обновление и его последствия — в [лекции 11](devops/11-kubernetes-prodvans.md).

## Service — стабильный адрес для нестабильных подов

Под меняет IP при каждом пересоздании. Если приложение ходит в БД по IP, то после деплоя у него новая жертва. Service решает это: у него есть стабильный виртуальный IP и DNS-имя, а `kube-proxy` на каждой ноде держит правила, перебрасывающие трафик на «живые» поды. Получается простой балансировщик без единого состояния внутри сервисов.

| Тип | Как работает | Когда применять |
| --- | --- | --- |
| `ClusterIP` | Виртуальный IP только внутри кластера | Обращение из других подов — 95% случаев |
| `NodePort` | Порт на каждой ноде кластера (30000-32767) | Отладка, доступ с ВМ без ingress |
| `LoadBalancer` | Провайдер выдаёт внешний IP | Публичные сервисы в облаке |
| `Headless` (`ClusterIP: None`) | DNS отдаёт IP подов напрямую | StatefulSet, клиент сам балансирует и знает «лидера» |

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: ClusterIP
  selector:
    app: api                # трафик пойдёт во все поды с этим лейблом
  ports:
    - name: http
      port: 80              # порт, по которому обращаются (db:80)
      targetPort: 8000      # порт контейнера, куда реально пересылать
      protocol: TCP
```

Разница между `port` и `targetPort` — источник получаса: обращаясь к `api:80`, клиент не попадёт в `8000`. Для внешнего доступа нужен Ingress, [это в лекции 11](devops/11-kubernetes-prodvans.md).

> [!IMPORTANT]
> Service не поднимает ничего. Он направляет трафик на **готовые** поды. Если
> под не проходит readiness, он исключается из endpoint'ов — и вот это
> поведение, вместе с неправильно настроенными probe'ами, — источник
> половины «мистических» отказов, о которых пойдёт речь в следующей лекции.

## ConfigMap: конфигурация отдельно от образа

ConfigMap — объект с ключами и значениями. Подключается в под двумя способами: как переменные окружения или как файлы.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  LOG_LEVEL: "INFO"
  DATABASE_URL: "postgresql://app:pass@db:5432/appdb"
  app.properties: |
    retries=5
    timeout=30
```

```yaml
    spec:
      containers:
        - name: api
          envFrom:
            - configMapRef:
                name: api-config      # все ключи как переменные окружения
          env:
            - name: FEATURE_FLAGS
              valueFrom:
                configMapKeyRef:
                  name: api-config
                  key: FEATURE_FLAGS # точечно
          volumeMounts:
            - name: cfg
              mountPath: /etc/app    # все ключи как файлы
      volumes:
        - name: cfg
          configMap:
            name: api-config
```

`envFrom` удобен, когда ключей много и имена совпадают с ожидаемыми переменными. `volumeMounts` нужен, когда приложение умеет читать конфиг из файла (Java, nginx, многие SDK). Помни: обновление ConfigMap **не** перезапускает под. Нужен рестарт деплоя, а в приложении может быть свой механизм — следи за этим в коде.

## Volume и PersistentVolumeClaim

`emptyDir` — временный каталог в памяти или на диске пода, живёт вместе с подом. Подходит для кэша между двумя контейнерами.

`PersistentVolume` — кусок хранилища в кластере, а `PersistentVolumeClaim` (PVC) — **заявка** на него. Логика ровно как с ресурсами: контроллер StorageClass и провизионер берут заявку и дают поду то, что он попросил. Почему раздельно: PV — про инфраструктуру (диск, сетевое хранилище, CSI-драйвер), PVC — про приложение (хочу 10 Гигабайт).

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: api-data
spec:
  accessModes:
    - ReadWriteOnce       # монтируется в один под за раз
  storageClassName: standard   # "" означало бы отказ от диска
  resources:
    requests:
      storage: 10Gi
```

```yaml
    spec:
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: api-data
      containers:
        - name: api
          volumeMounts:
            - name: data
              mountPath: /var/lib/api
```

`ReadWriteOnce` — почти всегда то, что нужно. `ReadWriteMany` требует сетевой файловой системы (CephFS, NFS, Azure Files) и стоит заметно дороже. Если ты планируешь файловые шары для LLM-моделей между подами, считай бюджет: сетевое хранилище с высокой пропускной способностью — это отдельная строка в счёте, и об этом стоит подумать до, а не после.

## kubectl: must-have

```bash
kubectl get pods -o wide
kubectl get deploy,svc,ingress,pvc
kubectl get events --sort-by=.lastTimestamp | tail -30

kubectl describe pod api-7d9f8c6b5-x2k4p    # почему именно этот под
kubectl logs -f api-7d9f8c6b5-x2k4p            # логи контейнера
kubectl logs --previous api-7d9f8c6b5-x2k4p   # логи предыдущего контейнера, до краша
kubectl exec -it api-7d9f8c6b5-x2k4p -- sh   # внутрь (в distroless не сработает)

kubectl port-forward svc/api 8000:80           # локальный доступ без ingress
kubectl apply -f manifests/                    # идемпотентно: повторно безопасно
kubectl delete -f manifests/ --wait=false
kubectl scale deploy/api --replicas=5
kubectl rollout status deploy/api
kubectl rollout history deploy/api
kubectl rollout undo deploy/api
kubectl diff -f manifests/                     # что изменится — до apply
```

> [!TIP]
> `kubectl apply -f manifests/` безопасно запускать хоть сто раз: он вычисляет
> патч между тем, что описано в YAML, и тем, что в кластере, и применяет только
> разницу. Аналог этому есть в Terraform, и мы разберём его в
> [лекции 12](devops/12-terraform-i-ansible.md). Прямое ручное редактирование
> в кластере — это всегда расхождение с Git, которое кто-то обнаружит в
> неподходящий момент.

## Pending: самая частая проблема и как её читать

`Pending` означает одно: под создан, но ни на одной ноде он не может быть запущен. Причин ровно три:

1. **Нет места.** Scheduler не нашёл ноду, где хватит CPU и памяти под requests.
2. **Нет пода, который должен был бы запуститься.** Например, PVC в `Pending`, потому что StorageClass не создался.
3. **Нода не готова.** Она в состоянии `NotReady` — сеть, kubelet, диск.

В `kubectl describe pod` смотри в секцию **Events** в самом низу, это самый полезный вывод:

```text
Events:
  Type     Reason     Message
  ----     ------     -------
  Warning  FailedScheduling  0/3 nodes are available: 3 Insufficient cpu.
```

Формулировка `Insufficient cpu` переводится на язык людей: суммарно свободного CPU на кластере меньше, чем сумма requests всех подов. Это не «не хватает процессора прямо сейчас», это «нет места по заявке». Отсюда практическое правило: **requests — это не оптимизация, а контракт с планировщиком**. Без них он почти не может планировать, и поды копятся в Pending.

Быстрый разбор в порядке частоты:

```bash
kubectl get nodes
kubectl describe node <node> | grep -A3 "Allocated resources"   # сколько реально занято
kubectl get pvc                                  # PVC в Pending = StorageClass
kubectl describe pod <pod> | grep -A10 Events
```

## Практика: приложение целиком

Подними локальный кластер в `kind` (или `minikube`) и положи в каталог `manifests/`:

`manifests/00-config.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  LOG_LEVEL: "INFO"
  APP_NAME: "llmops-api"
```

`manifests/10-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: registry.example.com/llmops/api:1.4.3
          ports:
            - containerPort: 8000
          envFrom:
            - configMapRef:
                name: api-config
          env:
            - name: DATABASE_URL
              value: "postgresql://app:pass@db.svc.cluster.local:5432/appdb"
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8000
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8000
            initialDelaySeconds: 15
            periodSeconds: 10
          volumeMounts:
            - name: data
              mountPath: /var/lib/api
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: api-data
```

> [!CAUTION]
> Один Deployment с тремя подами и одним PVC в режиме `ReadWriteOnce` — это
> **нерабочая конфигурация**. Третий под не сможет смонтировать том, который
> держит первый. Kubernetes повесит его в `ContainerCreating` намертво. Для
> конфигурации без состояния PVC здесь не нужен вовсе; для состояния нужен
> `StatefulSet` — [лекция 11](devops/11-kubernetes-prodvans.md). В манифесте
> ниже оставлен PVC специально, чтобы это увидеть своими глазами: запусти и
> прочитай Events.

`manifests/20-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: ClusterIP
  selector:
    app: api
  ports:
    - name: http
      port: 80
      targetPort: 8000
```

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: api-data
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: standard
  resources:
    requests:
      storage: 1Gi
```

Применение и проверка:

```bash
kubectl apply -f manifests/
kubectl get pods -o wide -w
kubectl get svc api
kubectl get endpoints api          # сколько подов реально за сервисом
kubectl port-forward svc/api 8000:80 &
curl -s localhost:8000/api/healthz

# обновление: меняем тег образа в yaml и смотрим rollout
kubectl set image deploy/api api=registry.example.com/llmops/api:1.4.4
kubectl rollout status deploy/api
kubectl rollout history deploy/api
kubectl rollout undo deploy/api
```

## Где это ломается

1. **Без `requests` планировщик не знает, что влезает.** Поды копятся в `Pending` с `Insufficient cpu`, хотя на нодах свободно 60% ресурсов — свободное место не равно свободной *заявке*.
2. **Service без `selector` или с чужим лейблом.** Сервис есть, эндпоинтов ноль: `kubectl get endpoints` пуст, а обращения дают connection refused на ровном месте работающему приложению.
3. **`targetPort` забыли.** `port: 80, targetPort: 8000` — без второго поля трафик уходит в 80-й порт контейнера, где никого нет.
4. **Лейблы в `selector` и в `template.labels` разошлись.** `apply` падает с валидацией, а если разошлись не те поля — ReplicaSet не видит своих подов и плодит новые без ограничения.
5. **Один PVC на несколько реплик.** Первый под занял том, остальные висят в `ContainerCreating` с `Multi-Attach error for volume`. Для БД нужен StatefulSet с PVC на под.
6. **Правка через `kubectl edit`.** Работает до следующего `apply` из Git, потом тихо перетирается. Деплой чужого разработчика возвращает старый конфиг, и все гадают, почему.
7. **Pod Pending из-за PVC в Pending.** Забыли `storageClassName` или StorageClass не создался — под висит молча, `describe pod` это показывает.
8. **Забыли `kubectl delete pod`.** В `kubectl run` без Deployment под живёт, пока не выйдет из строя — но следующий деплой его не увидит, и у тебя две версии приложения в кластере.

## Чек-лист понимания

- [ ] Я могу назвать компоненты control plane и worker-ноды и объяснить, зачем нужен apiserver как единая точка входа.
- [ ] Я понимаю декларативность: описываю «хочу», контроллеры делают, и почему руками в кластере ничего не делают.
- [ ] Я знаю, что pod одноразовый, что у него есть IP, и чем планирование пода отличается от планирования контейнера.
- [ ] Я различаю `apiVersion`, `kind`, `metadata`, `spec` и понимаю, почему `selector` неизменяем.
- [ ] Я объясняю, зачем нужен Service, чем `port` отличается от `targetPort`, и помню разницу между ClusterIP, NodePort, LoadBalancer и Headless.
- [ ] Я умею подключить ConfigMap через `envFrom` и через `volumeMounts` и знаю, что под не перезапустится сам.
- [ ] Я понимаю, зачем разделены PV и PVC, и знаю, когда `ReadWriteOnce` перестаёт работать.
- [ ] Я умею читать `kubectl describe pod` в секции Events и распознаю `Insufficient cpu` как проблему requests, а не физическую нехватку.