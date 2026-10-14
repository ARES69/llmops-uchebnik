/* Курс СЕТЬ — office-gw. Симулятор сборки конфигурации сетевого устройства.
   Синтаксис настоящий: RouterOS (/interface/…, /ip/…) и Cisco IOS (conf t,
   interface, switchport, ip address). Конфигурация живёт как черновик:
   check сверяет сборку с эталоном, apply переносит её в running-config,
   rollback возвращает последнюю рабочую точку — лекция «Сеть как код».
   Формат курса — assets/trainer/_HOWTO.md. */

(function () {

var NOTE = 'check, apply, rollback и device — команды тренажёра: они моделируют конфигурацию-как-код ' +
           '(черновик → проверка → применение → откат), как Ansible в check-режиме, шаблон Jinja или git rollback. ' +
           'Все команды устройств — настоящие: RouterOS и Cisco IOS. На живой сети RouterOS применяет сразу, ' +
           'здесь вы работаете с черновиком — поэтому трафик появляется только после apply.';

var NDMODS = [
  { id: 1, n: 'Порты', c: 'var(--tr-cyan)' },
  { id: 2, n: 'VLAN', c: 'var(--tr-accent)' },
  { id: 3, n: 'Адреса и маршрутизация', c: 'var(--tr-accent2)' },
  { id: 4, n: 'Проверка и применение', c: 'var(--tr-ok)' },
  { id: 5, n: 'Второй синтаксис', c: 'var(--tr-warn)' }
];

var NDLS = [
  { id: 1, m: 1, t: 'Список портов',
    task: 'Что есть на устройстве? Выведите список интерфейсов: /interface/print',
    re: /^\/?interface\/print$/, xp: 25,
    th: 'Оговорка: check, apply, rollback и device — команды тренажёра, они моделируют конфигурацию-как-код. Всё остальное — настоящий синтаксис. RouterOS: путь к меню и действие; R — running, RS — порт в составе bridge.',
    h: ['Путь к меню интерфейсов и print', '/interface/print', '/interface/print'] },

  { id: 2, m: 1, t: 'Детали портов',
    task: 'Посмотрите MAC-адреса, комментарии и состояние линков: /interface/ethernet/print detail',
    re: /^\/?interface\/ethernet\/print detail$/, xp: 30,
    th: 'print detail раскрывает то, что скрыто в обычном print: comment, link-downs, дату последнего подъёма линка. Именно comment потом видно в чужом инциденте.',
    h: ['Тот же print, но с флагом detail', '/interface/ethernet/print detail', '/interface/ethernet/print detail'] },

  { id: 3, m: 1, t: 'Описание порта',
    task: 'Подпишите порт ether2: «uplink to switch». Подсказка — имя ищется через [find where name=…]',
    v: function (r) { return /\/interface\/ethernet\/set/.test(r) && !!ND.comments.ether2; }, xp: 30,
    th: '[find where name=ether2] — поиск объекта по свойству, стандартный приём RouterOS. Поле comment потом видно в /interface/ethernet/print detail и в отчётах.',
    h: ['set + [find where name=ether2] + comment=', '/interface/ethernet/set [find where name=ether2] comment=uplink to switch',
        '/interface/ethernet/set [find where name=ether2] comment=uplink to switch'] },

  { id: 4, m: 1, t: 'Мост и uplink-порты',
    task: 'Создайте bridge1 и добавьте в него ether1 (WAN) и ether2 (trunk к коммутатору). Это три команды — нужны все.',
    v: function (r) { return ND.bridge && !!ndPort('ether1') && !!ndPort('ether2'); }, xp: 45,
    th: 'Мост — программный коммутатор. Порт сначала создают, потом добавляют в bridge: /interface/bridge/port/add. Пока порт не в мосте, он работает как отдельный интерфейс и не участвует в VLAN.',
    h: ['Сначала сам мост, потом оба порта в него',
        '/interface/bridge/add name=bridge1 · /interface/bridge/port/add bridge=bridge1 interface=ether1 · /interface/bridge/port/add bridge=bridge1 interface=ether2',
        '/interface/bridge/add name=bridge1 · /interface/bridge/port/add bridge=bridge1 interface=ether1 · /interface/bridge/port/add bridge=bridge1 interface=ether2'] },

  { id: 5, m: 2, t: 'Создание VLAN',
    task: 'Создайте на bridge1 два VLAN: vlan10 (id 10) и vlan20 (id 20).',
    v: function (r) { return !!ndVlan(10) && !!ndVlan(20); }, xp: 40,
    th: 'VLAN в RouterOS — это интерфейс-«сегмент» поверх моста. /interface/vlan/add создаёт его на bridge1; позже именно на vlan10 и vlan20 повесят адреса.',
    h: ['Два раза add: vlan-id=10 и vlan-id=20',
        '/interface/vlan/add name=vlan10 interface=bridge1 vlan-id=10 · /interface/vlan/add name=vlan20 interface=bridge1 vlan-id=20',
        '/interface/vlan/add name=vlan10 interface=bridge1 vlan-id=10 · /interface/vlan/add name=vlan20 interface=bridge1 vlan-id=20'] },

  { id: 6, m: 2, t: 'Access-порт для пользователей',
    task: 'Переведите ether3 в access VLAN 10: pvid=10 и frame-types=admit-only-untagged-and-priority-tagged.',
    v: function (r) { var p = ndPort('ether3'); return !!(p && p.pvid === 10 && /admit-only-untagged/.test(p.ft)); }, xp: 45,
    th: 'pvid — тег, который порт подставит «за пользователя». frame-types=admit-only-untagged-and-priority-tagged запрещает пропускать в сеть чужие теги: пользователь не сможет подделать VLAN 20. Порт должен уже быть в bridge1.',
    h: ['bridge/port/add с pvid и frame-types',
        '/interface/bridge/port/add bridge=bridge1 interface=ether3 pvid=10 frame-types=admit-only-untagged-and-priority-tagged',
        '/interface/bridge/port/add bridge=bridge1 interface=ether3 pvid=10 frame-types=admit-only-untagged-and-priority-tagged'] },

  { id: 7, m: 2, t: 'Trunk к коммутатору',
    task: 'Соберите trunk на ether2 для VLAN 10 и 20. Нужны ДВЕ команды: запись в bridge/vlan с tagged=ether2,bridge1 и включение vlan-filtering=yes на самом мосту.',
    v: function (r) { var b = ND.bvlans[0]; return !!(b && /ether2/.test(b.tagged) && ND.vfiltering); }, xp: 50,
    th: 'Главная ошибка trunk — забыть /interface/bridge/set bridge1 vlan-filtering=yes. Без неё таблица bridge/vlan есть, но теги в трафик не уходят: порт молча не работает. Сначала запись в bridge/vlan (что тегируется), потом включение фильтрации (чтобы это заработало).',
    h: ['Добавить tagged в bridge/vlan И включить vlan-filtering',
        '/interface/bridge/vlan/add bridge=bridge1 vlan-ids=10,20 tagged=ether2,bridge1 · /interface/bridge/set bridge1 vlan-filtering=yes',
        '/interface/bridge/vlan/add bridge=bridge1 vlan-ids=10,20 tagged=ether2,bridge1 · /interface/bridge/set bridge1 vlan-filtering=yes'] },

  { id: 8, m: 2, t: 'Таблица VLAN',
    task: 'Проверьте, что получилось: /interface/bridge/vlan/print',
    re: /^\/?interface\/bridge\/vlan\/print$/, xp: 25,
    th: 'Здесь видно и VLAN-IDS, и CURRENT-TAGGED. Если внизу есть строка про vlan-filtering=no — теги записаны, но не применяются.',
    h: ['bridge/vlan + print', '/interface/bridge/vlan/print', '/interface/bridge/vlan/print'] },

  { id: 9, m: 3, t: 'Адреса VLAN',
    task: 'Назначьте адреса: 10.10.10.1/24 на vlan10 и 10.10.20.1/24 на vlan20. Две команды.',
    v: function (r) { return !!ndAddr('10.10.10.1/24', 'vlan10') && !!ndAddr('10.10.20.1/24', 'vlan20'); }, xp: 40,
    th: 'Адрес висит на интерфейсе vlan10 (SVI), а не на физическом порту: порт в bridge адресов не имеет. RouterOS сам посчитает сеть и broadcast из префикса.',
    h: ['ip/address/add с interface=vlan…',
        '/ip/address/add address=10.10.10.1/24 interface=vlan10 · /ip/address/add address=10.10.20.1/24 interface=vlan20',
        '/ip/address/add address=10.10.10.1/24 interface=vlan10 · /ip/address/add address=10.10.20.1/24 interface=vlan20'] },

  { id: 10, m: 3, t: 'Маршрут по умолчанию',
    task: 'Отправьте весь остальной трафик провайдеру: /ip/route/add dst-address=0.0.0.0/0 gateway=203.0.113.1',
    re: /^\/?ip\/route\/add (dst-address=0\.0\.0\.0\/0 gateway=\S+|gateway=\S+ dst-address=0\.0\.0\.0\/0)$/, xp: 35,
    th: 'Маршрут по умолчанию — это «куда всё, что не наше». dst-address=0.0.0.0/0 означает любой адрес, gateway — следующий узел.',
    h: ['dst-address=0.0.0.0/0 и gateway=',
        '/ip/route/add dst-address=0.0.0.0/0 gateway=203.0.113.1',
        '/ip/route/add dst-address=0.0.0.0/0 gateway=203.0.113.1'] },

  { id: 11, m: 3, t: 'Таблица маршрутов',
    task: 'Проверьте маршруты: /ip/route/print',
    re: /^\/?ip\/route\/print$/, xp: 25,
    th: 'Флаг A — маршрут активен, S — статический. Пустая таблица означает, что маршрут не добавился: у команды сработал failure.',
    h: ['ip/route/print', '/ip/route/print', '/ip/route/print'] },

  { id: 12, m: 3, t: 'Пинг до apply',
    task: 'Проверьте связь с сетью 10.10.20.0/24: ping 10.10.20.1',
    v: function (r) { return /^\/?ping\s+10\.10\.20\.1/.test(r); }, xp: 35,
    th: 'Таймаут — и это правильный ответ. Конфигурация ещё черновик: apply будет в следующем модуле. Вот зачем конфигурацию пишут как код — она не может молча сломать сеть, пока не проверена и не применена.',
    h: ['RouterOS: /ping <адрес>',
        'Адрес в вашей сети: 10.10.20.1 — шлюз VLAN 20',
        '/ping 10.10.20.1'] },

  { id: 13, m: 4, t: 'Проверка сборки',
    task: 'Сверьте черновик с эталоном: check. Пока не пройдёт — apply не пропустит.',
    v: function (r) { return /^\s*check\s*$/i.test(r) && ND.checked; }, xp: 40,
    th: 'check — это валидатор конфигурации, аналог ansible --check или CI-линтера: читает черновик, сравнивает с эталоном и перечисляет расхождения. Ошибки видны до применения.',
    h: ['Одна команда: check', 'check', 'check'] },

  { id: 14, m: 4, t: 'Применение',
    task: 'Перенесите проверенный черновик в running-config: apply',
    v: function (r) { return /^\s*apply\s*$/i.test(r) && ND.applied; }, xp: 45,
    th: 'apply без check отклоняется: если конфигурация кривая, единственный путь назад — /system/reset-configuration, а это сброс к заводским настройкам с потерей доступа. Порядок check → apply и есть смысл всей затеи.',
    h: ['Одна команда: apply', 'apply', 'apply'] },

  { id: 15, m: 4, t: 'Откат',
    task: 'Верните последнюю рабочую конфигурацию: rollback',
    re: /^\s*rollback\s*$/i, xp: 35,
    th: 'Любая правка после apply считается неприменённой. rollback снимает её и возвращает устройство на последнюю сохранённую точку — дешёвый способ отменить неудачную правку, когда бежать к устройству некогда.',
    h: ['Одна команда: rollback', 'rollback', 'rollback'] },

  { id: 16, m: 4, t: 'Паспорт устройства',
    task: 'Посмотрите модель и версию прошивки: /system/routerboard/print',
    re: /^\/?system\/routerboard\/print$/, xp: 25,
    th: 'Модель и firmware — первые строки любого тикета и первые строки отчёта после аварии: прежде чем чинить, надо знать, что именно стоит.',
    h: ['system/routerboard/print', '/system/routerboard/print', '/system/routerboard/print'] },

  { id: 17, m: 5, t: 'Второй синтаксис',
    task: 'В стойке есть коммутатор Cisco. Переключитесь на него: device cisco',
    re: /^\s*device\s+cisco\s*$/i, xp: 25,
    th: 'Одно и то же по смыслу, два синтаксиса. RouterOS: /interface/bridge/add name=bridge1. Cisco: interface Port-channel1. Дальше те же порты, те же VLAN и тот же адрес — только команды другие.',
    h: ['Ключ устройства и его платформа: device cisco', 'device cisco', 'device cisco'] },

  { id: 18, m: 5, t: 'Та же сборка в IOS',
    task: 'Соберите на Cisco то же, что собирали в RouterOS: VLAN 10 (users), access-порт Gi0/3 в VLAN 10, SVI Vlan10 с адресом 10.10.10.1 255.255.255.0 и trunk на Gi0/2 с разрешённым VLAN 10.',
    v: function (r) {
      var vl = ND.cvlans.filter(function (x) { return x.id === 10; })[0];
      var p3 = ndCPort('Gi0/3'), p2 = ndCPort('Gi0/2');
      var ip = ND.cif.filter(function (x) { return x.if === 'Vlan10'; })[0];
      return !!(vl && vl.name === 'users' && p3 && p3.mode === 'access' && String(p3.vlan) === '10' &&
                p2 && p2.mode === 'trunk' && /(^|,\s*)10\s*(,|$)/.test(p2.allowed) &&
                ip && ip.ip === '10.10.10.1');
    }, xp: 50,
    th: 'conf t открывает режим конфигурации, end возвращает в exec. В контексте vlan доступна только name, в контексте interface — switchport и ip address, поэтому между блоками нужен exit. Порядок важен: сначала VLAN в базе, потом порт в него.',
    h: ['conf t → vlan 10 → name users → exit → interface Gi0/3 → switchport mode access → switchport access vlan 10',
        'conf t · vlan 10 · name users · exit · interface Gi0/3 · switchport mode access · switchport access vlan 10 · exit · interface Vlan10 · ip address 10.10.10.1 255.255.255.0 · exit · interface Gi0/2 · switchport mode trunk · switchport trunk allowed vlan 10 · end',
        'conf t · vlan 10 · name users · exit · interface Gi0/3 · switchport mode access · switchport access vlan 10 · exit · interface Vlan10 · ip address 10.10.10.1 255.255.255.0 · exit · interface Gi0/2 · switchport mode trunk · switchport trunk allowed vlan 10 · end'] }
];

/* ================= состояние ================= */

function ndFresh() {
  return {
    device: 'mikrotik', bridge: false,
    ports: [], vlans: [], bvlans: [], vfiltering: false,
    addresses: [], routes: [], comments: {}, draft: [], pending: [],
    applied: false, checked: false, lastGood: null,
    cmode: false, cctx: '', cvid: 0, cvlans: [], cports: [], cif: [], crun: [], cpen: false,
    stash: null
  };
}
var ND = ndFresh();

function ndSnap() { var s = JSON.parse(JSON.stringify(ND)); delete s.stash; return s; }
function ndRestore(s) {
  var st = ND.stash, k;
  for (k in ND) if (Object.prototype.hasOwnProperty.call(ND, k)) delete ND[k];
  for (k in s) ND[k] = s[k];
  ND.stash = st;
}
function ndPort(n) { var i; for (i = 0; i < ND.ports.length; i++) if (ND.ports[i].if === n) return ND.ports[i]; return null; }
function ndVlan(id) { var i; for (i = 0; i < ND.vlans.length; i++) if (ND.vlans[i].id === id) return ND.vlans[i]; return null; }
function ndAddr(a, ifn) { var i; for (i = 0; i < ND.addresses.length; i++) if (ND.addresses[i].a === a && ND.addresses[i].if === ifn) return ND.addresses[i]; return null; }
function ndCvlans(id) { var i; for (i = 0; i < ND.cvlans.length; i++) if (ND.cvlans[i].id === id) return ND.cvlans[i]; return null; }
function ndCifIp(n) { var i; for (i = 0; i < ND.cif.length; i++) if (ND.cif[i].if === n) return ND.cif[i]; return null; }
function ndCPort(n) { var i; for (i = 0; i < ND.cports.length; i++) if (ND.cports[i].if === n) return ND.cports[i]; return null; }

function ndTouch(line) {
  ND.draft.push(line);
  ND.checked = false;
  if (ND.applied) ND.pending.push(line);
}
function ndErr(m) { return { t: m, c: 't-err' }; }

/* ================= мелкие помощники ================= */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function padl(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function mac(n) { return '48:A9:8A:11:22:0' + n; }
function ipToInt(a) { var p = a.split('.'), v = 0; for (var i = 0; i < 4; i++) v = v * 256 + parseInt(p[i], 10); return v; }
function intToIp(v) { return [Math.floor(v / 16777216) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 256) % 256, v % 256].join('.'); }
function netBroadcast(a) {
  var p = a.split('/'), bits = parseInt(p[1], 10), v = ipToInt(p[0]);
  if (bits >= 32) return [p[0], p[0]];
  if (bits <= 0) return ['0.0.0.0', '0.0.0.0'];
  var sz = Math.pow(2, 32 - bits);
  var nv = v - (v % sz);
  return [intToIp(nv), intToIp(nv + sz - 1)];
}
function validAddr(a) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(a);
  if (!m) return false;
  for (var i = 1; i <= 4; i++) if (parseInt(m[i], 10) > 255) return false;
  return parseInt(m[5], 10) <= 32;
}
function ndArgs(tail) {
  var raw = tail || '', cm = null, m = raw.match(/comment=("[^"]*"|'[^']*'|\S+)/);
  if (m) { cm = m[1].replace(/^["']|["']$/g, ''); raw = raw.replace(m[0], 'comment=x'); }
  var parts = raw.split(/\s+/).filter(Boolean), o = {}, i, e;
  for (i = 0; i < parts.length; i++) { e = parts[i].indexOf('='); if (e > 0) o[parts[i].slice(0, e)] = parts[i].slice(e + 1); }
  if (cm !== null) o.comment = cm;
  return o;
}
function ndBanner() {
  if (!ND.applied && ND.draft.length) return '(черновик: ' + ND.draft.length + ' строк — ещё не применён)\n';
  if (ND.applied && ND.pending.length) return '(running-config + ' + ND.pending.length + ' неприменённых правок)\n';
  return '';
}

/* ================= RouterOS ================= */

function ndIfRows() {
  var a = [], i, vs;
  for (i = 1; i <= 4; i++) a.push({ n: 'ether' + i, ty: 'ether', m: mac(i), f: ndPort('ether' + i) ? 'RS' : 'R' });
  if (ND.bridge) a.push({ n: 'bridge1', ty: 'bridge', m: mac(5), f: 'RS' });
  vs = ND.vlans.slice().sort(function (x, y) { return x.id - y.id; });
  for (i = 0; i < vs.length; i++) a.push({ n: vs[i].name, ty: 'vlan', m: mac(6 + i), f: 'RS' });
  return a;
}
function ndIfPrint() {
  var a = ndIfRows(), L = ['Flags: D - dynamic, X - disabled, R - running, S - slave ',
    ' #     NAME                        TYPE               ACTUAL-MTU     L2MTU  MAC-ADDRESS       '], i;
  for (i = 0; i < a.length; i++)
    L.push(' ' + pad(i, 2) + ' ' + padl(a[i].f, 2) + ' ' + pad(a[i].n, 29) + pad(a[i].ty, 19) + pad('1500', 16) + pad('1598', 8) + a[i].m);
  if (a.length === 4) L.push('(bridge и VLAN появятся, когда вы их создадите — и работать начнут только после apply)');
  return ndBanner() + L.join('\n');
}
function ndEthDetail() {
  var L = ['Flags: X - disabled, R - running, S - slave '], i, nm, cm, p, ind;
  for (i = 1; i <= 4; i++) {
    nm = 'ether' + i; p = ndPort(nm); cm = ND.comments[nm] || '';
    L.push(' ' + i + ' ' + padl(p ? 'RS' : 'R', 2) + ' name="' + nm + '" mtu=1500 actual-mtu=1500 l2mtu=1598 mac-address=' + mac(i) +
      (cm ? ' comment="' + cm + '"' : '') + ' last-link-up-time=jan/02/2026 09:1' + i + ':0' + i +
      ' link-downs=0 ' + (p ? 'bridge=' + p.bridge : ''));
  }
  ind = 4;
  if (ND.bridge) { L.push(' ' + ind + ' RS name="bridge1" mtu=1500 actual-mtu=1500 l2mtu=1598 mac-address=' + mac(5) + ' link-downs=0 '); ind++; }
  ND.vlans.slice().sort(function (a, b) { return a.id - b.id; }).forEach(function (v) {
    L.push(' ' + ind + ' RS name="' + v.name + '" mtu=1500 actual-mtu=1500 l2mtu=1598 mac-address=' + mac(6 + v.id % 10) + ' last-link-up-time=jan/02/2026 09:20:11 link-downs=0 interface=' + v.iface);
    ind++;
  });
  return ndBanner() + L.join('\n');
}
function ndPortPrint() {
  var L = ['Flags: X - disabled, I - inactive, R - running, P - port-channel ',
    ' #     ' + pad('BRIDGE', 13) + pad('INTERFACE', 31) + pad('PVID', 10) + pad('PVID-STRICT', 15) + pad('FRAME-TYPES', 50) + 'HW/PINCH/LANE'], i;
  if (!ND.ports.length) return ndBanner() + L.join('\n') + '\n(в bridge нет ни одного порта)';
  for (i = 0; i < ND.ports.length; i++) {
    var p = ND.ports[i];
    L.push(' ' + pad(i, 2) + ' ' + padl('RI', 3) + pad(p.bridge, 13) + pad(p.if, 31) + pad(String(p.pvid), 10) +
      pad(p.pvid === 1 ? 'no' : 'yes', 15) + pad(p.ft, 50) + 'yes/1/' + (i + 1));
  }
  return ndBanner() + L.join('\n');
}
function ndBvlanPrint() {
  var L = ['Flags: X - disabled, D - dynamic ',
    ' #    ' + pad('BRIDGE', 13) + pad('VLAN-IDS', 14) + pad('CURRENT-STRICT', 19) + pad('CURRENT-TAGGED', 23) + 'INACTIVE-TAGGED    '];
  if (!ND.bvlans.length) return ndBanner() + L.join('\n') + '\n(таблица пуста — trunk не собран)';
  ND.bvlans.forEach(function (b, i) {
    L.push(' ' + pad(i, 5) + pad(b.bridge, 13) + pad(b.ids, 14) + pad('yes', 19) + pad(b.tagged, 23));
  });
  L.push('');
  L.push(ND.vfiltering
    ? 'vlan-filtering=yes — теги VLAN 10,20 идут в трафик на ether2'
    : '⚠ vlan-filtering=no — записи есть, но теги VLAN не уходят в трафик: /interface/bridge/set bridge1 vlan-filtering=yes');
  return ndBanner() + L.join('\n');
}
function ndVlanPrint() {
  var L = [' #     NAME        VLAN-ID  INTERFACE                       CURRENT-CPU'], i;
  if (!ND.vlans.length) return ndBanner() + L.join('\n') + '\n(ни одного VLAN — /interface/vlan/add name=vlan10 interface=bridge1 vlan-id=10)';
  for (i = 0; i < ND.vlans.length; i++) L.push(' ' + pad(i, 5) + pad(ND.vlans[i].name, 12) + pad(ND.vlans[i].id, 10) + pad(ND.vlans[i].iface, 33) + '0');
  return ndBanner() + L.join('\n');
}
function ndAddrPrint() {
  var L = [' #   ADDRESS            INTERFACE     NETWORK       BROADCAST       STATUS'], i;
  if (!ND.addresses.length) return ndBanner() + L.join('\n') + '\n(адресов нет)';
  for (i = 0; i < ND.addresses.length; i++) {
    var nb = netBroadcast(ND.addresses[i].a);
    L.push(' ' + pad(i, 3) + pad(ND.addresses[i].a, 20) + pad(ND.addresses[i].if, 15) + pad(nb[0], 14) + pad(nb[1], 16) + 'bound');
  }
  return ndBanner() + L.join('\n');
}
function ndRoutePrint() {
  var L = ['Flags: X - disabled, A - active, D - dynamic ',
    ' #   DST-ADDRESS        GATEWAY            DISTANCE     ROUTER-TABLE'], i;
  if (!ND.routes.length) return ndBanner() + L.join('\n') + '\n(маршрутов нет — /ip/route/add dst-address=0.0.0.0/0 gateway=…)';
  for (i = 0; i < ND.routes.length; i++)
    L.push(' ' + pad(i, 3) + ' A S ' + pad(ND.routes[i].dst, 21) + pad(ND.routes[i].gw, 20) + pad('1', 14) + 'main');
  return ndBanner() + L.join('\n');
}
function ndRB() {
  return '       RouterBoard: 750G r3\n         Model: RB750Gr3\n     Serial Number: HED2009ABCDEF\n' +
    '     Firmware Version: 7.14.3 (stable)\n  Current Firmware: 7.14.3 (stable)\n   Upgrade Firmware: 7.15.3 (stable)\n' +
    '  Current Bootloader: 7.14.3\n\nвремя работы: 11d 04:22:31 · нагрузка: 6%';
}

function ndMicro(t) {
  if (t.indexOf('/') !== 0) return ndErr('invalid command name ' + (t.split(/\s+/)[0] || '') + ' (line 1 column 1)');
  var sp = t.indexOf(' ');
  var head = sp < 0 ? t : t.slice(0, sp);
  var tail = sp < 0 ? '' : t.slice(sp + 1);
  var k = ndArgs(tail), m, i, p, b;

  /* ---- списки ---- */
  if (head === '/interface/print') return ndIfPrint();
  if (head === '/interface/ethernet/print') return /detail/.test(tail) ? ndEthDetail() : ndIfPrint();
  if (head === '/interface/bridge/print') return ndBanner() + (ND.bridge ? ndPortPrint() : 'nothing to print — bridge не создан');
  if (head === '/interface/bridge/port/print') return ndPortPrint();
  if (head === '/interface/bridge/vlan/print') return ndBvlanPrint();
  if (head === '/interface/vlan/print') return ndVlanPrint();
  if (head === '/ip/address/print') return ndAddrPrint();
  if (head === '/ip/route/print') return ndRoutePrint();
  if (head === '/system/routerboard/print') return ndRB();

  /* ---- описание порта ---- */
  if (head === '/interface/ethernet/set') {
    m = t.match(/ether[1-4]/);
    if (!m) return ndErr('failure: no such interface (проверьте имя: [find where name=ether1])');
    if (/^ether[1-4]$/.test(m[0]) === false) return ndErr('failure: no such item (' + m[0] + ')');
    if (k.comment === undefined) return ndErr('failure: nothing to set — нужно comment=текст');
    ND.comments[m[0]] = k.comment;
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }

  /* ---- мост ---- */
  if (head === '/interface/bridge/add') {
    if (ND.bridge) return ndErr('failure: name=bridge1 already exists');
    if (!k.name) return ndErr('failure: name is required — /interface/bridge/add name=bridge1');
    ND.bridge = true;
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }
  if (head === '/interface/bridge/set') {
    if (!ND.bridge) return ndErr('no such item (bridge1)');
    if (k['vlan-filtering'] === undefined) return ndErr('failure: nothing to set — нужно vlan-filtering=yes');
    ND.vfiltering = (k['vlan-filtering'] === 'yes');
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }
  if (head === '/interface/bridge/port/add') {
    var ifn = k.interface, br = k.bridge || 'bridge1';
    if (!ifn) return ndErr('failure: interface is required — … interface=ether1');
    if (!/^ether[1-4]$/.test(ifn)) return ndErr('failure: interface ' + ifn + ' not found');
    if (!ND.bridge) return ndErr('no such item (bridge1) — сначала /interface/bridge/add name=bridge1');
    if (ndPort(ifn)) return ndErr('failure: port ' + ifn + ' is already a member of ' + ndPort(ifn).bridge);
    p = { if: ifn, bridge: br, pvid: k.pvid ? parseInt(k.pvid, 10) : 1, ft: k['frame-types'] || 'admit-only-untagged-and-priority-tagged' };
    if (!(p.pvid >= 1 && p.pvid <= 4094)) return ndErr('failure: bad value for pvid: ' + k.pvid);
    ND.ports.push(p);
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }
  if (head === '/interface/bridge/port/set') {
    var pn = (t.match(/ether[1-4]/) || [])[0];
    p = ndPort(pn);
    if (!p) return ndErr('failure: port not found — добавьте его через /interface/bridge/port/add');
    if (k.pvid) p.pvid = parseInt(k.pvid, 10);
    if (k['frame-types']) p.ft = k['frame-types'];
    if (k['pvid-foreground']) { }
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }

  /* ---- VLAN ---- */
  if (head === '/interface/vlan/add') {
    var vid = k['vlan-id'] ? parseInt(k['vlan-id'], 10) : NaN;
    var vi = k.interface || 'bridge1';
    if (isNaN(vid) || vid < 1 || vid > 4094) return ndErr('failure: bad value for vlan-id: ' + (k['vlan-id'] || '(нет)'));
    if (ndVlan(vid)) return ndErr('failure: already have vlan with vlan-id ' + vid);
    if (!ND.bridge) return ndErr('failure: interface ' + vi + ' not found');
    if (vi !== 'bridge1') return ndErr('failure: interface ' + vi + ' not found — VLAN создаётся только на bridge1');
    ND.vlans.push({ id: vid, name: k.name || ('vlan' + vid), iface: vi });
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }
  if (head === '/interface/bridge/vlan/add') {
    var bid = k.bridge || 'bridge1', ids = k['vlan-ids'] || '', tg = k.tagged;
    if (!ND.bridge) return ndErr('no such item (bridge1)');
    if (!ids) return ndErr('failure: vlan-ids is required');
    if (!tg) return ndErr('failure: tagged is required — tagged=ether2,bridge1');
    for (i = 0; i < tg.split(',').length; i++) {
      var tg1 = tg.split(',')[i].trim();
      if (/^bridge1$/.test(tg1)) continue;
      if (!ndPort(tg1)) return ndErr('failure: ' + tg1 + ' is not a member of ' + bid + ' — добавьте порт в bridge');
    }
    ND.bvlans.push({ bridge: bid, ids: ids, tagged: tg });
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }

  /* ---- адреса и маршруты ---- */
  if (head === '/ip/address/add') {
    var ad = k.address, ai = k.interface;
    if (!ad) return ndErr('failure: address is required — address=10.10.10.1/24');
    if (!validAddr(ad)) return ndErr('failure: address=' + ad + ' is not a valid IP address/mask');
    if (!ai) return ndErr('failure: interface is required — interface=vlan10');
    var am = ai.match(/^vlan(\d+)$/);
    if (/^ether[1-4]$/.test(ai)) return ndErr('failure: interface ' + ai + ' is a bridge port — адрес назначается на vlan… (SVI), а не на порт');
    if (am) { if (!ndVlan(parseInt(am[1], 10))) return ndErr('failure: interface ' + ai + ' not found'); }
    else if (!(ai === 'bridge1' && ND.bridge)) return ndErr('failure: interface ' + ai + ' not found');
    for (i = 0; i < ND.addresses.length; i++) if (ND.addresses[i].a === ad && ND.addresses[i].if === ai) return ndErr('failure: already have such address');
    ND.addresses.push({ a: ad, if: ai });
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }
  if (head === '/ip/route/add') {
    var dst = k['dst-address'] || k.dst, gw = k.gateway;
    if (!dst || !gw) return ndErr('failure: dst-address and gateway are required');
    if (!validAddr(dst)) return ndErr('failure: address=' + dst + ' is not a valid IP address/mask');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(gw)) return ndErr('failure: bad gateway address=' + gw);
    ND.routes.push({ dst: dst, gw: gw });
    ndTouch(t);
    return { t: '', c: 't-ok' };
  }

  /* ---- прочее ---- */
  if (head === '/ping') return ndPing((tail.split(/\s+/)[0] || ''));
  if (head === '/system/configuration/save') {
    if (!ND.applied) return ndErr('failure: нечего сохранять — конфигурация не применена (apply)');
    return { t: 'system configuration saved', c: 't-ok' };
  }
  if (head === '/system/reset-configuration') {
    return ndErr('failure: reset отключён на учебном стенде.\n  Без точки отката единственный путь — /system/reset-configuration, и это сброс\n  к заводским настройкам: сеть пропадёт, доступ к устройству потеряется.\n  Правильный порядок: check → apply, а откат делает rollback.');
  }
  return ndErr('invalid command name ' + head.split('/').pop() + ' (line 1 column 1)');
}

/* ================= проверка / применение / откат ================= */

function ndAudit() {
  var b = ND.bvlans[0], p1 = ndPort('ether1'), p2 = ndPort('ether2'), p3 = ndPort('ether3');
  var okIds = !!b && /(^|[\s,])10([\s,]|$)/.test(b.ids) && /(^|[\s,])20([\s,]|$)/.test(b.ids);
  return [
    [ND.bridge, 'bridge1 создан', 'bridge1 не создан — /interface/bridge/add name=bridge1'],
    [!!p1, 'ether1 в составе bridge1', 'ether1 не в bridge — /interface/bridge/port/add bridge=bridge1 interface=ether1'],
    [!!p2, 'ether2 в составе bridge1', 'ether2 (trunk) не в bridge — /interface/bridge/port/add bridge=bridge1 interface=ether2'],
    [!!p3, 'ether3 в составе bridge1', 'ether3 (access) не в bridge — /interface/bridge/port/add bridge=bridge1 interface=ether3'],
    [!!p3 && p3.pvid === 10 && /admit-only-untagged/.test(p3.ft),
      'ether3 — access VLAN 10 (pvid=10, admit-only-untagged-and-priority-tagged)',
      'ether3 не в access VLAN 10 — pvid=10 frame-types=admit-only-untagged-and-priority-tagged'],
    [!!ndVlan(10), 'VLAN 10 создан на bridge1', 'VLAN 10 не создан — /interface/vlan/add name=vlan10 interface=bridge1 vlan-id=10'],
    [!!ndVlan(20), 'VLAN 20 создан на bridge1', 'VLAN 20 не создан — /interface/vlan/add name=vlan20 interface=bridge1 vlan-id=20'],
    [!!b && /ether2/.test(b.tagged), 'bridge/vlan: tagged=ether2,bridge1', 'ether2 не помечен tagged — /interface/bridge/vlan/add bridge=bridge1 vlan-ids=10,20 tagged=ether2,bridge1'],
    [okIds, 'bridge/vlan: vlan-ids=10,20', 'в bridge/vlan нет vlan-ids=10,20 — второй конец trunk не пропустит теги'],
    [ND.vfiltering, 'vlan-filtering=yes на bridge1', 'vlan-filtering=no — теги VLAN не уйдут в трафик, нужно /interface/bridge/set bridge1 vlan-filtering=yes'],
    [!!ndAddr('10.10.10.1/24', 'vlan10'), 'адрес 10.10.10.1/24 на vlan10', 'нет адреса 10.10.10.1/24 на vlan10'],
    [!!ndAddr('10.10.20.1/24', 'vlan20'), 'адрес 10.10.20.1/24 на vlan20', 'нет адреса 10.10.20.1/24 на vlan20'],
    [!!ND.routes.length, 'маршрут по умолчанию задан', 'нет маршрута по умолчанию — /ip/route/add dst-address=0.0.0.0/0 gateway=203.0.113.1']
  ];
}
function ndCheck() {
  var a = ndAudit(), L = ['сверка office-gw.rsc с эталоном…', ''], i, bad = 0;
  for (i = 0; i < a.length; i++) {
    if (a[i][0]) L.push('  ✔ ' + a[i][1]);
    else { bad++; L.push('  ✖ ' + a[i][1]); }
  }
  ND.checked = bad === 0;
  L.push('');
  L.push(bad ? 'ошибок: ' + bad + ' · apply заблокирован, исправьте и проверьте снова'
             : 'ошибок: 0 · конфигурация согласована, можно apply');
  return { t: L.join('\n'), c: bad ? 't-err' : 't-ok' };
}
function ndApply() {
  if (ND.device === 'cisco') return ndErr('failure: на Cisco IOS применение — это copy running-config startup-config');
  if (!ND.checked) {
    return ndErr('failure: apply refused — конфигурация не проверена\n\n' +
      '  сначала выполните check: apply без проверки может уронить доступ к устройству,\n' +
      '  и тогда единственный путь назад — /system/reset-configuration,\n' +
      '  то есть сброс к заводским настройкам. Порядок check → apply обязателен.');
  }
  if (ND.applied && !ND.pending.length) return { t: 'черновик совпадает с running-config — применять нечего', c: 't-dim' };
  var snap = ndSnap();
  ND.applied = true;
  ND.pending = [];
  ND.lastGood = { t: new Date().toISOString().slice(0, 16).replace('T', ' '), n: ND.draft.length, state: snap };
  later(['проверка целостности черновика… ок', 'перенос в running-config… ok',
         '/system/configuration/save → startup-config ✔', '', 'конфигурация применена: bridge1 · vlan10 · vlan20 · адреса · маршрут',
         'теперь /ping 10.10.20.1 ответит'], 260);
  return null;
}
function ndRollback() {
  if (!ND.lastGood) return ndErr('failure: точки отката нет — apply ещё ни разу не выполнялся.\n  Несохранённый черновик при сбое пришлось бы снимать через /system/reset-configuration.');
  var lg = ND.lastGood, n = ND.pending.length;
  if (lg.state) { ndRestore(lg.state); ND.lastGood = lg; ND.applied = true; }
  else ND.draft = lg.lines ? lg.lines.slice() : ND.draft;
  ND.pending = [];
  ND.checked = false;
  return { t: 'откат к последней рабочей конфигурации (' + lg.t + ')\n' +
    (n ? '● снято неприменённых правок: ' + n : '● неприменённых правок не было — устройство уже на рабочей точке') + '\n' +
    '● восстановлено строк конфигурации: ' + lg.n, c: 't-ok' };
}

/* ================= Cisco IOS ================= */

function ndCifName(s) {
  s = String(s).trim();
  if (/^port-?channel/i.test(s)) return 'Port-channel1';
  var mv = /^vlan(\d+)$/i.exec(s);
  if (mv) return 'Vlan' + mv[1];
  var mg = /^(?:gi|gigabitethernet|te|fastethernet)(\d+)\/(\d+)$/i.exec(s);
  if (mg) return 'Gi' + mg[1] + '/' + mg[2];
  return s;
}
function ndCifValid(n) {
  if (/^Gi0\/[1-4]$/.test(n)) return true;
  if (n === 'Port-channel1') return true;
  var m = /^Vlan(\d+)$/.exec(n);
  return !!m && !!ndCvlans(parseInt(m[1], 10));
}
function ndCrec(ifn) {
  var p = ndCPort(ifn);
  if (!p) { p = { if: ifn, mode: '', vlan: '', allowed: '', desc: '' }; ND.cports.push(p); }
  return p;
}
function ndBad() {
  return { t: "          ^\n% Invalid input detected at '^' marker.", c: 't-err' };
}
function ndCctxName() {
  if (!ND.cctx) return '(config)#';
  if (ND.cctx === 'vlan') return 'config-vlan#';
  return 'config-if#';
}
function ndCiscoRun(t) {
  var tk = t.split(/\s+/), c = tk[0].toLowerCase(), a = tk.slice(1), i;

  /* ---- exec mode ---- */
  if (!ND.cmode) {
    if (c === 'conf' || c === 'configure') {
      if (a[0] && !/^(t|term|terminal)$/i.test(a[0])) return ndBad();
      ND.cmode = true; ND.cctx = '';
      return 'Enter configuration commands, per one line.  End with CNTL/Z.';
    }
    if (c === 'show' || c === 'sh') {
      var s = a.join(' ');
      if (/^ip\s+int(erface)?\s+br(ief)?/.test(s)) return ndCIntBrief();
      if (/^ip\s+int(erface)?\s+\S+\s*$/.test(s) || /^int(erface)?\s+\S+\s*$/.test(s)) return ndCIntOne(ndCifName(a[a.length - 1]));
      if (/^vlan(\s|$)/.test(s)) return ndCVlanBrief();
      if (/^run(ning-config)?(\s|$)/.test(s) || /^run\s*$/.test(s)) return ndCShowRun();
      if (/^version$/.test(s)) return 'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.2(7)E10, RELEASE SOFTWARE (fc3)\n' +
        'cisco WS-C2960-24TT-L (PowerPC405) processor (revision R0) with 131072K bytes of memory.\n' +
        'Processor board ID FOC1234X1YZ\nBase ethernet MAC Address       : 00:1A:2B:3C:4D:5E\n';
      if (/^interfaces?(\s|$)/.test(s)) return ndCShowRun();
      return ndBad();
    }
    if (c === 'ping') return ndPing(a[0] || '');
    if (c === 'copy') {
      if (/running-config\s+startup-config/.test(t)) {
        if (!ND.checked) return ndErr('%WRAL: Configuration not verified — run check before saving to startup-config.\n' + ndCheckWhat());
        ND.cpen = true;
        later(['Destination filename [startup-config]?', '!! executing...', 'Building configuration...', '', '[OK]', '%SYS-5-CONFIG_I: Configurations from last 1 hour(s) backed up to NVRAM...'], 260);
        return null;
      }
      return ndBad();
    }
    if (c === 'exit' || c === 'quit') return { t: 'сессия закрыта (тренажёр продолжает работать)', c: 't-dim' };
    return ndBad();
  }

  /* ---- config mode ---- */
  var ctx = ND.cctx;
  if (c === 'end' || t === 'ctrl+z' || c === 'system:configuration') {
    ND.cmode = false; ND.cctx = '';
    return '%SYS-5-CONFIG_I: Configurations from last 1 hour(s) backed up to NVRAM...';
  }
  if (c === 'exit' || c === 'ex') {
    if (ctx) { ND.cctx = ''; return null; }
    ND.cmode = false;
    return '%SYS-5-CONFIG_I: Configurations from last 1 hour(s) backed up to NVRAM...';
  }
  if (ctx === 'vlan') {
    if (/^name\s+\S/i.test(t)) {
      var vl = ndCvlans(ND.cvid);
      vl.name = a.join(' ');
      ND.checked = false;
      return null;
    }
    return ndBad();
  }
  if (ctx.indexOf('if:') === 0) {
    var ifn = ctx.slice(3), p = ndCrec(ifn);
    if (/^description\s+/i.test(t)) {
      p.desc = a.join(' ');
      ND.checked = false;
      return null;
    }
    if (/^switchport\s+mode\s+access/i.test(t)) {
      p.mode = 'access'; p.allowed = '';
      ND.checked = false;
      return null;
    }
    if (/^switchport\s+mode\s+trunk/i.test(t)) {
      p.mode = 'trunk';
      ND.checked = false;
      return null;
    }
    if (/^switchport\s+access\s+vlan\s+(\d+)/i.test(t)) {
      var av = parseInt(RegExp.$1, 10);
      if (p.mode === 'trunk') return ndErr('%Command rejected: An interface cannot be a trunk and an access port at the same time.');
      p.mode = 'access'; p.vlan = av;
      ND.checked = false;
      return null;
    }
    if (/^switchport\s+trunk\s+allowed\s+vlan\s+(.+)/i.test(t)) {
      var list = a[a.length - 1], miss = [];
      list.split(',').forEach(function (x) { var id = parseInt(x.trim(), 10); if (id > 1 && !ndCvlans(id)) miss.push(id); });
      if (miss.length) {
        return ndErr('%VLAN ' + miss.join(', ') + ' not found in the vlan database.\nsome vlan(s) could not be tagged\n  сначала создайте VLAN: conf t → vlan ' + miss[0]);
      }
      p.mode = p.mode || 'trunk';
      p.allowed = list;
      ND.checked = false;
      return null;
    }
    if (/^ip\s+address\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i.test(t)) {
      var ip = RegExp.$1, mk = RegExp.$2;
      if (!ndMaskOk(mk))
        return ndErr('% Invalid mask: ' + mk + ' — маска должна быть непрерывной от старшего бита (255.255.255.0)');
      ND.cif = ND.cif.filter(function (x) { return x.if !== ifn; });
      ND.cif.push({ if: ifn, ip: ip, mask: mk });
      ND.checked = false;
      return null;
    }
    if (/^no\s+ip\s+address/i.test(t)) {
      ND.cif = ND.cif.filter(function (x) { return x.if !== ifn; });
      ND.checked = false;
      return null;
    }
    if (/^no\s+shutdown$/i.test(t)) { ndCput('interface ' + ifn, ' no shutdown'); return null; }
    if (/^shutdown$/i.test(t)) { ndCput('interface ' + ifn, ' shutdown'); return null; }
    return ndBad();
  }
  if (/^vlan\s+(\d+)/i.test(t)) {
    var vid = parseInt(RegExp.$1, 10);
    if (vid < 1 || vid > 4094) return ndErr('% VLAN ' + vid + ' out of range. Valid values are 1 to 4094.');
    var ex = ndCvlans(vid);
    if (!ex) { ND.cvlans.push({ id: vid, name: '' }); ND.checked = false; }
    ND.cctx = 'vlan'; ND.cvid = vid;
    return null;
  }
  if (/^interface\s+/i.test(t)) {
    var nm = ndCifName(a[0] || '');
    if (!ndCifValid(nm)) {
      if (/^Vlan/i.test(nm)) return ndErr('% VLAN ' + nm.replace(/^Vlan/i, '') + ' does not exist.\n  создайте её: conf t → vlan ' + nm.replace(/^Vlan/i, '') + ' → name …');
      return ndBad();
    }
    ndCrec(nm);
    ND.cctx = 'if:' + nm;
    return null;
  }
  if (/^ip\s+routing$/i.test(t)) { ndCput('', 'ip routing'); return null; }
  if (/^no\s+ip\s+routing$/i.test(t)) { return null; }
  if (/^interface\s+range/i.test(t)) return ndBad();
  return ndBad();
}
function ndCput(head, line) {
  ND.checked = false;
  var i;
  for (i = 0; i < ND.crun.length; i++) if (ND.crun[i] === head) { ND.crun[i] = head + '\n' + line; return; }
  if (ND.crun.length) ND.crun.push('');
  ND.crun.push(head + '\n' + line);
}
function ndCIntBrief() {
  var L = ['Interface                  IP-Address      OK? Method Status                Protocol'], i;
  var ports = ['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4'];
  for (i = 0; i < ports.length; i++) {
    var p = ndCPort(ports[i]);
    var st = ports[i] === 'Gi0/4' || (p && p.mode === 'access' && p.vlan && !ndCifIp('Vlan' + p.vlan)) ? 'down' : 'up';
    var pr = st === 'down' ? 'down' : 'up';
    L.push(pad(ports[i], 26) + pad('unassigned', 17) + pad('YES NVRAM ', 12) + pad(pr, 22) + pr);
  }
  L.push(pad('Port-channel1', 26) + pad('unassigned', 17) + pad('YES NVRAM ', 12) + pad('administratively down', 22) + 'down');
  ND.cvlans.forEach(function (v) {
    var ip = ndCifIp('Vlan' + v.id);
    L.push(pad('Vlan' + v.id, 26) + pad(ip ? ip.ip : 'unassigned', 17) + pad('YES ' + (ip ? 'manual ' : 'NVRAM '), 12) +
      pad(ip ? 'up' : 'down', 22) + (ip ? 'up' : 'down'));
  });
  return L.join('\n');
}
function ndCIntOne(nm) {
  var ip = ndCifIp(nm), p = ndCPort(nm);
  return nm + ' is ' + (nm === 'Gi0/4' ? 'down' : 'up, line protocol is up') + '\n' +
    '  Hardware is Fast Ethernet, address is 001a.2b3c.' + (4000 + nm.length) + ' (bia 001a.2b3c.' + (4000 + nm.length) + ')\n' +
    '  Internet address is ' + (ip ? ip.ip + '/' + ndMaskBits(ip.mask) : 'not set') + '\n' +
    (p && p.mode ? '  Mode: ' + p.mode + (p.vlan ? ', access vlan ' + p.vlan : '') + (p.allowed ? ', allowed ' + p.allowed : '') : '') + '\n' +
    '  Full Duplex, 1000Mb/s, media type is 10/100/1000BaseTX';
}
function ndMaskBits(m) {
  var p = m.split('.'), v = 0, i;
  for (i = 0; i < 4; i++) v = v * 256 + parseInt(p[i], 10);
  var b = 0, x = v;
  while (x & 0x80000000) { b++; x = (x << 1) >>> 0; }
  return b;
}
function ndMaskOk(mk) {
  var p = String(mk).split('.'), v = 0, i, n;
  if (p.length !== 4) return false;
  for (i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(p[i])) return false;
    n = parseInt(p[i], 10);
    if (n > 255) return false;
    v = v * 256 + n;
  }
  var b = ndMaskBits(mk);
  return v === (b === 0 ? 0 : 4294967296 - Math.pow(2, 32 - b));
}
function ndCVlanBrief() {
  var L = ['VLAN Name                             Status    Ports',
           '---- -------------------------------- --------- -------------------------------',
           '1    default                          active    Gi0/4'], i;
  ND.cvlans.forEach(function (v) {
    var ports = [];
    ND.cports.forEach(function (p) { if (p.mode === 'access' && String(p.vlan) === String(v.id)) ports.push(p.if); });
    L.push(pad(String(v.id), 5) + pad(v.name || '', 33) + pad('active', 10) + (ports.length ? ports.join(', ') : ''));
  });
  var trunks = [];
  ND.cports.forEach(function (p) { if (p.mode === 'trunk') trunks.push(p.if + '(' + (p.allowed || 'ALL') + ')'); });
  if (trunks.length) L.push('', 'trunk: ' + trunks.join('  '));
  return L.join('\n');
}
function ndCShowRun() {
  var L = ['Building configuration...', '', 'Current configuration : ' + (820 + ndCBody().length) + ' bytes', '!',
    'version 15.2', 'service timestamps debug datetime msec', '!', 'hostname office-sw', '!'], i, p, v, x;
  for (i = 0; i < ND.cvlans.length; i++) {
    v = ND.cvlans[i];
    L.push('vlan ' + v.id);
    if (v.name) L.push(' name ' + v.name);
    L.push('!');
  }
  for (i = 0; i < ND.cports.length; i++) {
    p = ND.cports[i];
    if (!p.mode && !p.desc) continue;
    L.push('interface ' + p.if);
    if (p.desc) L.push(' description ' + p.desc);
    if (p.mode === 'trunk') {
      L.push(' switchport mode trunk');
      if (p.allowed) L.push(' switchport trunk allowed vlan ' + p.allowed);
    } else {
      L.push(' switchport mode access');
      if (p.vlan) L.push(' switchport access vlan ' + p.vlan);
    }
    L.push('!');
  }
  for (i = 0; i < ND.cif.length; i++) {
    x = ND.cif[i];
    L.push('interface ' + x.if);
    L.push(' ip address ' + x.ip + ' ' + x.mask);
    L.push('!');
  }
  if (ND.crun.length) { L.push(ND.crun.join('\n'), '!'); }
  L.push('end');
  return L.join('\n');
}
function ndCBody() {
  var L = [], i, p, v, x;
  for (i = 0; i < ND.cvlans.length; i++) { v = ND.cvlans[i]; L.push('vlan ' + v.id, v.name ? ' name ' + v.name : ''); }
  for (i = 0; i < ND.cports.length; i++) {
    p = ND.cports[i];
    if (!p.mode && !p.desc) continue;
    L.push('interface ' + p.if, p.desc ? ' description ' + p.desc : '', p.mode === 'trunk' ? ' switchport mode trunk' : ' switchport mode access',
      p.allowed ? ' switchport trunk allowed vlan ' + p.allowed : '', p.vlan ? ' switchport access vlan ' + p.vlan : '');
  }
  for (i = 0; i < ND.cif.length; i++) { x = ND.cif[i]; L.push('interface ' + x.if, ' ip address ' + x.ip + ' ' + x.mask); }
  return L.join('\n');
}
function ndCheckWhat() {
  var a = ndAudit2(), out = ['  не хватает:'], i;
  for (i = 0; i < a.length; i++) if (!a[i][0]) out.push('   · ' + a[i][1]);
  return out.join('\n');
}
function ndAudit2() {
  var vl = ndCvlans(10), p3 = ndCPort('Gi0/3'), p2 = ndCPort('Gi0/2'), ip = ndCifIp('Vlan10');
  return [
    [!!vl, 'vlan 10 создан (conf t → vlan 10 → name users)'],
    [!!vl && vl.name === 'users', 'у VLAN 10 есть имя (name users)'],
    [!!p3 && p3.mode === 'access' && String(p3.vlan) === '10', 'Gi0/3 — switchport mode access + switchport access vlan 10'],
    [!!p2 && p2.mode === 'trunk' && /(^|,\s*)10\s*(,|$)/.test(p2.allowed), 'Gi0/2 — switchport trunk allowed vlan 10'],
    [!!ip && ip.ip === '10.10.10.1', 'interface Vlan10 — ip address 10.10.10.1 255.255.255.0']
  ];
}
function ndCheckC() {
  var a = ndAudit2(), L = ['сверка office-sw.cfg с эталоном…', ''], i, bad = 0;
  for (i = 0; i < a.length; i++) { if (a[i][0]) L.push('  ✔ ' + a[i][1]); else { bad++; L.push('  ✖ ' + a[i][1]); } }
  ND.checked = bad === 0;
  L.push('');
  L.push(bad ? 'ошибок: ' + bad + ' · сохранение в startup-config заблокировано'
             : 'ошибок: 0 · можно copy running-config startup-config');
  return { t: L.join('\n'), c: bad ? 't-err' : 't-ok' };
}

/* ================= ping ================= */

function ndInNet(ip) {
  var v = ipToInt(ip);
  return v >= ipToInt('10.10.10.0') && v <= ipToInt('10.10.10.255') ||
         v >= ipToInt('10.10.20.0') && v <= ipToInt('10.10.20.255');
}
function ndCPingOk(ip) {
  if (!ND.cpen) return false;
  var vl = ND.cvlans.some(function (v) { return ndCifIp('Vlan' + v.id) && ndCifIp('Vlan' + v.id).ip === ip; });
  return vl || ndCPort('Gi0/3') && ndCPort('Gi0/3').mode === 'access' && ndInNet(ip);
}
function ndPing(ip) {
  if (!ip) return ndErr('ping: bad address');
  if (ND.device === 'cisco') {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ndErr('% Unrecognized host or address');
    later(['Type escape sequence to abort.',
           'Sending 5, 100-byte ICMP Echos to ' + ip + ', timeout is 2 seconds:',
           ndCPingOk(ip) ? '!!!!!' : '.....',
           ndCPingOk(ip) ? 'Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms'
                         : 'Success rate is 0 percent (0/5)'], 220);
    return null;
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ndErr('ping: ' + ip + ': bad address');
  var ok = ND.applied && ndInNet(ip);
  var lines = ['  SEQ HOST                      STATUS                                     SIZE    TIME TTL'], i;
  for (i = 0; i < 3; i++)
    lines.push('    ' + i + ' ' + pad(ip, 27) + (ok ? pad('56', 42) + pad('1500', 8) + pad('0ms', 7)
                                                  : pad('timeout', 51)));
  lines.push(ok ? '    sent=3 received=3 packet-loss=0%' : '    sent=3 received=0 packet-loss=100% timeout=3000ms');
  if (ok) lines.push('    конфигурация применена — трафик по этой схеме ходит');
  else if (ND.applied) lines.push('    сеть не отвечает — проверьте адрес и VLAN');
  else lines.push('    конфигурация ещё не применена: apply — в модуле 4');
  later(lines, 200);
  return null;
}

/* ================= диспетчер ================= */

function ndRun(raw) {
  var t = String(raw || '').trim();
  if (!t) return null;
  if (/^\s*device\s+(mikrotik|cisco)\s*$/i.test(t)) return ndDevice(t.split(/\s+/)[1].toLowerCase());
  if (/^\s*check\s*$/i.test(t)) return ND.device === 'cisco' ? ndCheckC() : ndCheck();
  if (/^\s*apply\s*$/i.test(t)) return ND.device === 'cisco'
    ? ndErr('на Cisco IOS применение — это copy running-config startup-config') : ndApply();
  if (/^\s*rollback\s*$/i.test(t)) return ndRollback();
  return ND.device === 'cisco' ? ndCiscoRun(t) : ndMicro(t);
}
function ndDevice(d) {
  if (ND.device === d) return { t: 'уже на этом устройстве (' + (d === 'cisco' ? 'Cisco IOS' : 'RouterOS') + ')', c: 't-dim' };
  ND.stash = ND.stash || {};
  ND.stash[ND.device] = ndSnap();
  if (ND.stash[d]) { var s = ND.stash[d]; delete ND.stash[d]; ndRestore(s); }
  else {
    var keep = ND.stash, fresh = ndFresh(), i;
    for (i in ND) if (Object.prototype.hasOwnProperty.call(ND, i)) delete ND[i];
    for (i in fresh) ND[i] = fresh[i];
    ND.device = d;
    ND.stash = keep;
  }
  var s2 = ND.stash;
  delete s2[d];
  if (d === 'cisco') {
    return { t: 'подключение к office-sw (Cisco Catalyst 2960, IOS 15.2)\n' +
      'приглашение изменилось: RouterOS /… заменён на IOS conf t / show / interface.\n' +
      'прежняя конфигурация MikroTik сохранена — вернуться: device mikrotik', c: 't-ok' };
  }
  return { t: 'подключение к office-gw (MikroTik RB750Gr3, RouterOS 7.14.3)\n' +
    'приглашение изменилось: IOS заменён на RouterOS /interface/…, /ip/…', c: 't-ok' };
}

/* ================= правая панель ================= */

function ndRole(n) {
  var p = ndPort(n), i;
  if (!p) return 'не в bridge';
  for (i = 0; i < ND.bvlans.length; i++) if (new RegExp('(^|,)' + n + '(,|$)').test(ND.bvlans[i].tagged)) return 'trunk · vlan-ids ' + ND.bvlans[i].ids;
  if (p.pvid > 1) return 'access vlan ' + p.pvid;
  return 'bridge1 · untagged';
}
function ndEnv() {
  var h = '', i;
  if (ND.device === 'cisco') {
    h += envBlock('УСТРОЙСТВО · office-sw',
      erow('платформа', 'Cisco IOS 15.2 · WS-C2960-24TT-L', 'var(--tr-warn)') +
      erow('режим', ND.cmode ? 'config ' + ndCctxName() : 'exec #', ND.cmode ? 'var(--tr-accent)' : 'var(--tr-cyan)') +
      erow('в startup-config', ND.cpen ? 'да ✔' : 'нет', ND.cpen ? 'var(--tr-ok)' : 'var(--tr-warn)'));
    h += envBlock('VLAN', ND.cvlans.length ? ND.cvlans.map(function (v) {
      return erow('vlan ' + v.id, esc(v.name) || '— (нужно name …)', v.name ? 'var(--tr-ok)' : 'var(--tr-dim)');
    }).join('') : '<div class="text-xs" style="color:var(--tr-dim)">conf t → vlan 10</div>');
    h += envBlock('ПОРТЫ', ['Gi0/1', 'Gi0/2', 'Gi0/3', 'Gi0/4', 'Port-channel1'].map(function (n) {
      var p = ndCPort(n);
      return erow(n, p && p.mode ? esc(p.mode) + (p.vlan ? ' vlan ' + p.vlan : '') + (p.allowed ? ' allow ' + esc(p.allowed) : '') + (p.desc ? ' · ' + esc(p.desc) : '') : '—',
        p && p.mode ? 'var(--tr-ok)' : 'var(--tr-dim)');
    }).join(''));
    h += envBlock('SVI / IP', ND.cif.length ? ND.cif.map(function (x) {
      return erow(x.if, x.ip + ' ' + x.mask, 'var(--tr-accent2)');
    }).join('') : '<div class="text-xs" style="color:var(--tr-dim)">interface Vlan10 → ip address …</div>');
    h += envBlock('ПРОВЕРКА',
      erow('check', ND.checked ? 'пройдена ✔' : 'не пройдена', ND.checked ? 'var(--tr-ok)' : 'var(--tr-warn)') +
      erow('copy run start', ND.cpen ? 'выполнен ✔' : 'не выполнен', ND.cpen ? 'var(--tr-ok)' : 'var(--tr-warn)'));
    h += envBlock('RUNNING-CONFIG', '<div class="text-xs whitespace-pre" style="color:var(--tr-ok-dim)">' +
      esc(ndCShowRun()) + '</div>');
    return h + '<div class="text-xs" style="color:var(--tr-dim)">' + esc(NOTE) + '</div>';
  }
  h += envBlock('УСТРОЙСТВО · office-gw',
    erow('платформа', 'RouterOS 7.14.3 · RB750Gr3', 'var(--tr-cyan)') +
    erow('bridge1', ND.bridge ? 'создан' : 'не создан', ND.bridge ? 'var(--tr-ok)' : 'var(--tr-dim)') +
    erow('vlan-filtering', ND.vfiltering ? 'yes' : 'no', ND.vfiltering ? 'var(--tr-ok)' : 'var(--tr-err)') +
    erow('VLAN', ND.vlans.length ? ND.vlans.map(function (v) { return v.id; }).join(', ') : '—', ND.vlans.length ? 'var(--tr-ok)' : 'var(--tr-dim)'));
  h += envBlock('ПОРТЫ', ['ether1', 'ether2', 'ether3', 'ether4'].map(function (n) {
    var cm = ND.comments[n];
    return erow(n, cm ? esc(ndRole(n)) + ' · ' + esc(cm) : esc(ndRole(n)), ndPort(n) ? 'var(--tr-ok)' : 'var(--tr-dim)');
  }).join(''));
  h += envBlock('АДРЕСА И МАРШРУТЫ',
    (ND.addresses.length ? ND.addresses.map(function (a) { return erow(a.if, a.a, 'var(--tr-accent2)'); }).join('')
                         : '<div class="text-xs" style="color:var(--tr-dim)">/ip/address/add …</div>') +
    (ND.routes.length ? ND.routes.map(function (r) { return erow('route', r.dst + ' → ' + r.gw, 'var(--tr-cyan)'); }).join('')
                      : '<div class="text-xs" style="color:var(--tr-dim)">/ip/route/add …</div>'));
  h += envBlock('СЕТЬ КАК КОД',
    erow('check', ND.checked ? 'пройден ✔' : 'не пройден', ND.checked ? 'var(--tr-ok)' : 'var(--tr-warn)') +
    erow('apply', ND.applied ? 'применён ✔' : 'не применён', ND.applied ? 'var(--tr-ok)' : 'var(--tr-warn)') +
    erow('неприменённых правок', String(ND.pending.length), ND.pending.length ? 'var(--tr-orange)' : 'var(--tr-dim)') +
    erow('точка отката', ND.lastGood ? ND.lastGood.t : 'нет', ND.lastGood ? 'var(--tr-ok)' : 'var(--tr-dim)'));
  h += envBlock('ЧЕРНОВИК · office-gw.rsc', ND.draft.length
    ? '<div class="text-xs whitespace-pre" style="color:var(--tr-ok-dim)">' + esc(ND.draft.join('\n')) + '</div>'
    : '<div class="text-xs" style="color:var(--tr-dim)">(пусто — начните с /interface/print)</div>');
  return h + '<div class="text-xs" style="color:var(--tr-dim)">' + esc(NOTE) + '</div>';
}

/* ================= регистрация курса ================= */

COURSES.netdev = {
  i: '🔌', n: 'СЕТЬ · ОБОРУДОВАНИЕ', c: 'var(--tr-orange)',
  pr: 'admin@office-gw:~$', ti: 'office-gw — RouterOS / IOS',
  note: NOTE,
  mods: NDMODS, ls: NDLS,
  run: function (raw) { var r = ndRun(raw); ndRender(); return r; },
  reset: function () { ND = ndFresh(); ndRender(); },
  env: function () { return ndEnv(); }
};

function ndRender() {
  try {
    var C = COURSES.netdev;
    $('genT').textContent = C.i + ' ' + C.n + ' · СРЕДА';
    $('genC').style.color = C.c;
    $('genC').innerHTML = '<span class="dot" style="background:' + C.c + ';box-shadow:0 0 8px ' + C.c + '"></span>online';
    $('genB').innerHTML = ndEnv();
  } catch (e) { /* панель ещё не в DOM — не страшно */ }
}

if (!P.netdev) P.netdev = { xp: 0, cur: 1, done: [] };
if (typeof buildTabs === 'function') buildTabs();

if (typeof renderEnv === 'function' && !renderEnv.__netdev) {
  var ndBaseRenderEnv = renderEnv;
  renderEnv = function () {
    if (typeof course === 'string' && course === 'netdev') { ndRender(); return; }
    ndBaseRenderEnv.apply(null, arguments);
  };
  renderEnv.__netdev = true;
}
ndRender();

})();