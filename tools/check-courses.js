/* ==========================================================================
   Проверка курсов тренажёра.

   Запуск из корня проекта:
       node tools/check-courses.js            все курсы
       node tools/check-courses.js rag        один курс
       node tools/check-courses.js rag 7,8,9  один курс + показать вывод

   Что проверяем:
     1. каждое задание засчитывается после ввода ответа из подсказки;
     2. команда реально отработала, а не молча провалилась в обработчик;
     3. в выводе нет мусора (undefined / NaN / [object Object]).

   Пункт 2 — самый важный. Регулярка задания может совпасть с ответом,
   пока обработчик команды о нём не знает: задание зелёное, терминал пустой,
   студент ничему не научился. Так ломалось четыре раза подряд.
   ========================================================================== */

const fs = require("fs"), path = require("path"), vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const D = path.join(ROOT, "assets", "trainer");

/* --- минимальная имитация браузера: движку нужны только эти куски --- */
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: () => {}, removeItem: () => {},
};
const mkEl = () => ({
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
  style: {}, appendChild() {}, setAttribute() {}, addEventListener() {},
  querySelectorAll: () => [], closest() { return null },
  textContent: "", innerHTML: "", value: "", focus() {},
});
const els = {};
global.document = {
  getElementById: i => (els[i] ||= mkEl()),
  querySelector: () => mkEl(),
  querySelectorAll: () => [],
  createElement: () => mkEl(),
  addEventListener() {},
  documentElement: { setAttribute() {}, getAttribute: () => "dark" },
  body: mkEl(),
};
global.location = { search: "", href: "" };
global.window = global;
global.setInterval = () => 0;
global.btoa = s => s;

let queue = [];
global.setTimeout = f => { queue.push(f); return 0; };

/* --- загрузка: движок, потом курсы из course-*.js --- */
vm.runInThisContext(fs.readFileSync(path.join(D, "engine.js"), "utf8"), { filename: "engine.js" });
vm.runInThisContext(fs.readFileSync(path.join(D, "courses.js"), "utf8"), { filename: "courses.js" });
fs.readdirSync(D)
  .filter(f => f.startsWith("course-") && f.endsWith(".js")).sort()
  .forEach(f => vm.runInThisContext(fs.readFileSync(path.join(D, f), "utf8"), { filename: f }));

/* --- перехват вывода. Именно после загрузки: function out в движке
       иначе затрёт наши заглушки. --- */
let cap = [];
global.out = t => cap.push(String(t));
global.later = a => a.forEach(x => cap.push(String(x)));
global.toast = () => {};
global.renderEnv = () => {};

const only = process.argv[2];
const show = (process.argv[3] || "").split(",").filter(Boolean).map(Number);

const order = only ? [only] : Object.keys(COURSES).sort((a, b) => {
  if (a === "ansible" && b === "auto") return -1;
  if (b === "ansible" && a === "auto") return 1;
  return 0;
});

let total = 0, passed = 0;
const notCredited = [], deadHandlers = [], junk = [];

for (const K of order) {
  const C = COURSES[K];
  if (!C) { console.log(`  ! нет курса «${K}»`); process.exitCode = 1; continue; }
  C.reset();
  P[K] = { xp: 0, cur: 1, done: [] };
  course = K;
  let ok = 0;

  for (const l of C.ls) {
    P[K].cur = l.id;
    const before = P[K].done.length;
    cap = [];
    for (const cmd of String(l.h[2]).split(/\s+·\s+/).map(s => s.trim()).filter(Boolean)) {
      exec(cmd);
    }
    queue.splice(0).forEach(f => { try { f(); } catch (e) { /* отложенный вывод */ } });

    const got = P[K].done.length > before;
    const body = cap.join("\n");
    if (got) ok++;
    else notCredited.push(`${K} #${l.id} «${l.t}» — ответ: ${String(l.h[2]).slice(0, 70)}`);
    if (got && /команда не найдена/.test(body))
      deadHandlers.push(`${K} #${l.id} «${l.t}» — обработчик не узнал команду`);
    if (got && /внутренняя ошибка обработки/.test(body))
      deadHandlers.push(`${K} #${l.id} «${l.t}» — обработчик упал`);
    if (got && /undefined|NaN|\[object Object\]/.test(body))
      junk.push(`${K} #${l.id} «${l.t}» — в выводе мусор`);

    if (show.includes(l.id)) {
      console.log(`\n  ${got ? "OK " : "ХУЖЕ"} #${l.id} м${l.m} «${l.t}»`);
      console.log(`     $ ${String(l.h[2]).slice(0, 110)}`);
      cap.forEach(x => console.log("     | " + String(x).split("\n").slice(0, 22).join("\n     | ")));
    }
  }
  total += C.ls.length;
  passed += ok;
  if (!only) console.log(`  ${K.padEnd(11)} ${ok}/${C.ls.length}`);
}

console.log(`\n  ИТОГО ${passed}/${total}`);
if (notCredited.length) { console.log("\n  НЕ ЗАСЧИТЕНО:"); notCredited.forEach(x => console.log("    " + x)); }
if (deadHandlers.length) { console.log("\n  ЗАСЧИТАНО, НО КОМАНДА НЕ ОТРАБОТАЛА:"); deadHandlers.forEach(x => console.log("    " + x)); }
else console.log("  все команды курсов реально отработали");
if (junk.length) { console.log("\n  МУСОР В ВЫВОДЕ:"); junk.forEach(x => console.log("    " + x)); }

if (passed !== total || deadHandlers.length || junk.length) process.exitCode = 1;