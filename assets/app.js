/* ==========================================================================
   Учебник DevOps & MLOps — клиентская логика
   ========================================================================== */
(function () {
  "use strict";

  var CURRICULUM = window.CURRICULUM || [];
  var INDEX = window.SEARCH_INDEX || [];
  var BASE = window.BASE || "";
  var SLUG = window.SLUG || "";

  var KEY = "devops-mlops-progress";
  var THEME_KEY = "devops-mlops-theme";

  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  // localStorage недоступен при открытии по file:// в части браузеров — не падаем
  function lsGet(k, dflt) {
    try { var v = localStorage.getItem(k); return v === null ? dflt : v; }
    catch (e) { return dflt; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }

  function getDone() {
    try { return JSON.parse(lsGet(KEY, "[]")) || []; }
    catch (e) { return []; }
  }
  function setDone(list) {
    lsSet(KEY, JSON.stringify(list));
  }
  function isDone(slug) { return getDone().indexOf(slug) !== -1; }
  function toggleDone(slug) {
    var list = getDone(), i = list.indexOf(slug);
    if (i === -1) list.push(slug); else list.splice(i, 1);
    setDone(list);
    return i === -1;
  }

  function href(url) { return BASE + url; }

  /* --------------------------------------------------------- Sidebar --- */

  function slugOf(url) {
    return url.replace(/^lectures\//, "").replace(/\.html$/, "");
  }

  function renderSidebar() {
    var host = $("#curriculum");
    if (!host) return;
    var html = "";

    CURRICULUM.forEach(function (t) {
      var openState = lsGet("trk-" + t.id, "true") !== "false";
      html += '<div class="c-track" data-open="' + openState + '" data-track="' + t.id + '">';
      html += '<button class="c-track-head" type="button">';
      html += '<span class="c-icon" style="color:' + t.color + '">' + t.icon + "</span>";
      html += "<span>" + t.name + "</span>";
      html += '<span class="c-count">' + t.count + "</span>";
      html += '<svg class="caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
      html += "</button><div class=\"c-body\">";

      t.modules.forEach(function (m) {
        if (m.name) html += '<div class="c-mod-head">' + m.name + "</div>";
        m.lessons.forEach(function (l) {
          var slug = l.track + "/" + l.slug;
          html += '<a class="c-lesson" data-slug="' + slug + '" href="' + href(l.out) + '">';
          html += '<span class="cbox" data-check="' + slug + '" role="checkbox" aria-label="Отметить"></span>';
          html += '<span class="c-title">' + l.title + "</span>";
          html += "</a>";
        });
      });

      html += "</div></div>";
    });

    host.innerHTML = html;

    $all(".c-track-head", host).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tr = btn.parentElement;
        var open = tr.getAttribute("data-open") === "true";
        tr.setAttribute("data-open", String(!open));
        lsSet("trk-" + tr.getAttribute("data-track"), String(!open));
      });
    });

    $all("[data-check]", host).forEach(function (box) {
      box.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleDone(box.getAttribute("data-check"));
        refreshProgress();
      });
    });

    markCurrent();
  }

  function markCurrent() {
    if (!SLUG) return;
    $all(".c-lesson").forEach(function (a) {
      if (a.getAttribute("data-slug") === SLUG) {
        a.classList.add("current");
        var tr = a.closest(".c-track");
        if (tr) {
          tr.setAttribute("data-open", "true");
          lsSet("trk-" + tr.getAttribute("data-track"), "true");
        }
      }
    });
  }

  function refreshProgress() {
    var done = getDone();
    var total = INDEX.length || 1;
    var pct = Math.round((done.length / total) * 100);

    $all(".c-lesson").forEach(function (a) {
      a.classList.toggle("is-done", isDone(a.getAttribute("data-slug")));
    });

    var fill = $("#progFill");
    if (fill) fill.style.width = pct + "%";
    var txt = $("#progText");
    if (txt) txt.textContent = done.length + " из " + total + " пройдено";

    var fg = $("#pmFg");
    if (fg) {
      var C = 2 * Math.PI * 15.5;
      fg.setAttribute("stroke-dasharray", C.toFixed(1));
      fg.setAttribute("stroke-dashoffset", (C * (1 - done.length / total)).toFixed(1));
    }
    var p = $("#pmPct");
    if (p) p.textContent = pct + "%";

    var btn = $("#doneBtn");
    if (btn && SLUG) {
      var d = isDone(SLUG);
      btn.classList.toggle("done", d);
      $(".db-text", btn).textContent = d ? "Пройдена" : "Отметить пройденной";
    }
  }

  /* ---------------------------------------------------------- Search --- */

  function norm(s) {
    return s.toLowerCase().replace(/ё/g, "е");
  }

  function search(q) {
    q = norm(q.trim());
    if (q.length < 2) return [];
    var words = q.split(/\s+/);
    var out = [];
    for (var i = 0; i < INDEX.length; i++) {
      var it = INDEX[i];
      var hay = norm(it.t + " " + it.s + " " + (it.g || []).join(" ") + " " + it.m);
      var score = 0, all = true;
      for (var w = 0; w < words.length; w++) {
        if (hay.indexOf(words[w]) === -1) { all = false; break; }
        score += norm(it.t).indexOf(words[w]) === 0 ? 10 : 1;
      }
      if (all) out.push({ it: it, score: score });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, 20).map(function (x) { return x.it; });
  }

  function hl(text, q) {
    var i = norm(text).indexOf(norm(q.split(/\s+/)[0]));
    if (i === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, i)) + "<mark>" + escapeHtml(text.slice(i, i + q.length)) +
           "</mark>" + escapeHtml(text.slice(i + q.length));
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function initSearch() {
    var input = $("#search"), box = $("#searchResults");
    if (!input || !box) return;
    var sel = 0, items = [];

    function close() { box.hidden = true; box.innerHTML = ""; }

    function render(q) {
      items = search(q);
      if (!items.length) {
        box.innerHTML = '<div class="sr-empty">Ничего не найдено</div>';
        box.hidden = false;
        return;
      }
      var h = "";
      items.forEach(function (it, i) {
        h += '<a class="sr-item' + (i === sel ? " sel" : "") + '" href="' + href(it.u) + '">';
        h += "<b>" + hl(it.t, q) + "</b>";
        h += "<small>" + escapeHtml(it.m) + " · #" + it.n + "</small></a>";
      });
      box.innerHTML = h;
      box.hidden = false;
    }

    input.addEventListener("input", function () {
      sel = 0;
      if (input.value.trim().length < 2) close(); else render(input.value);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { input.value = ""; close(); input.blur(); return; }
      if (!items.length) return;
      if (e.key === "ArrowDown") { sel = (sel + 1) % items.length; e.preventDefault(); render(input.value); scrollSel(); }
      else if (e.key === "ArrowUp") { sel = (sel - 1 + items.length) % items.length; e.preventDefault(); render(input.value); scrollSel(); }
      else if (e.key === "Enter") { e.preventDefault(); var a = box.querySelector(".sr-item.sel") || box.querySelector(".sr-item"); if (a) location.href = a.getAttribute("href"); }
    });

    function scrollSel() {
      var a = box.querySelector(".sr-item.sel");
      if (a) a.scrollIntoView({ block: "nearest" });
    }

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search-wrap")) close();
    });
    input.addEventListener("focus", function () {
      if (input.value.trim().length >= 2) render(input.value);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== input &&
          !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); input.focus();
      }
    });
  }

  /* ----------------------------------------------------------- Theme --- */

  function initTheme() {
    var saved = lsGet(THEME_KEY, null);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    var btn = $("#themeBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      lsSet(THEME_KEY, next);
    });
  }

  /* ------------------------------------------------------ Copy buttons -- */

  function initCopy() {
    $all("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var block = btn.closest(".codeblock");
        var text = Array.prototype.map.call(block.querySelectorAll(".ln"), function (ln) {
          return ln.textContent.replace(/^\s*\d+\s/, "");
        }).join("\n");
        navigator.clipboard.writeText(text).then(function () {
          var old = btn.textContent;
          btn.textContent = "Скопировано";
          btn.classList.add("ok");
          setTimeout(function () { btn.textContent = old; btn.classList.remove("ok"); }, 1600);
        }).catch(function () {
          btn.textContent = "Не вышло";
          setTimeout(function () { btn.textContent = "Копировать"; }, 1600);
        });
      });
    });
  }

  /* ------------------------------------------------------- TOC scroll --- */

  function initSpy() {
    var links = $all(".toc a");
    if (!links.length) return;
    var targets = links.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); });
    function update() {
      var y = window.scrollY + 120, best = 0;
      targets.forEach(function (t, i) { if (t && t.offsetTop <= y) best = i; });
      links.forEach(function (a, i) { a.classList.toggle("active", i === best); });
    }
    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  /* -------------------------------------------------------- Mobile UI -- */

  function initShell() {
    var sb = $("#sidebar"), sc = $("#scrim"), mb = $("#menuBtn");
    function close() { sb.classList.remove("open"); sc.classList.remove("show"); }
    if (mb) mb.addEventListener("click", function () {
      sb.classList.toggle("open");
      sc.classList.toggle("show");
    });
    if (sc) sc.addEventListener("click", close);
    $all(".c-lesson").forEach(function (a) { a.addEventListener("click", close); });

    var reset = $("#resetProgress");
    if (reset) reset.addEventListener("click", function () {
      if (confirm("Сбросить прогресс по всем лекциям?")) { setDone([]); refreshProgress(); }
    });

    var db = $("#doneBtn");
    if (db) db.addEventListener("click", function () {
      toggleDone(SLUG);
      refreshProgress();
    });

    var tt = $("#toTop");
    if (tt) {
      window.addEventListener("scroll", function () {
        tt.classList.toggle("show", window.scrollY > 600);
      }, { passive: true });
      tt.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    }
  }

  /* ------------------------------------------------------------- Init -- */

  document.addEventListener("DOMContentLoaded", function () {
    renderSidebar();
    refreshProgress();
    initSearch();
    initTheme();
    initCopy();
    initSpy();
    initShell();
  });
})();