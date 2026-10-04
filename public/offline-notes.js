/**
 * offline-notes.js — a hearing survives the courthouse having no signal.
 *
 * JJ: "i want to laptop app version to be able to do the same thing for master
 * and individual hearings in app and web version. the purpose is so that i can
 * save and do hearing dictation and notes even without internet."
 *
 * Immigration court is in a basement and the wifi is a rumour. Three things
 * used to be lost there, and this file is the three of them:
 *
 *   1. AUDIO. Dictation slices went straight to the network. No network meant
 *      the slice sat in a page variable until the tab died. Slices now land in
 *      IndexedDB the instant the recorder produces them, and are deleted only
 *      once the server has acknowledged them. IndexedDB because a Blob cannot
 *      go in localStorage.
 *   2. TYPING. A master or individual note is a long form filled in over an
 *      hour. Closing the lid, a crash, or an accidental back button took the
 *      lot. Fields are mirrored to localStorage as they are typed and offered
 *      back on return.
 *   3. SUBMISSION. Pressing Save with no signal failed and the page said so,
 *      which is no use to somebody walking out of a courtroom. A failed submit
 *      is queued and sent when the signal returns.
 *
 * A REAL STATIC FILE, on purpose. The admin pages are server-rendered template
 * literals, where a backslash-escaped quote is eaten by the literal and reaches
 * the browser as a syntax error that kills every script on the page — that took
 * client search down for five hours. Code here is ordinary JavaScript in an
 * ordinary file, and it is shared by three pages instead of copied into them.
 *
 * Served as /static/offline-notes.js via clientScriptTag(), which versions it
 * by mtime so a deploy cannot leave a stale copy cached.
 */
(function () {
  "use strict";

  var DB_NAME = "tez-hearing-offline";
  var DB_VERSION = 1;
  var SLICES = "slices";

  var DRAFT_PREFIX = "tez.draft.";
  var QUEUE_KEY = "tez.submitQueue";

  // ── IndexedDB, wrapped thinly ─────────────────────────────
  // Every accessor is wrapped: in a private window, or with site data blocked,
  // indexedDB either throws or returns a database that cannot be written. The
  // page must still work — degraded, and saying so — rather than failing to
  // record a hearing because storage was unavailable.
  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(SLICES)) d.createObjectStore(SLICES);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("indexedDB refused to open")); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode);
        var s = t.objectStore(store);
        var out = fn(s);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("transaction aborted")); };
      });
    });
  }

  // Keys sort lexicographically, and slices must come back in the order they
  // were recorded — a webm stream reassembled out of order is not audio. Hence
  // the zero padding rather than plain concatenation.
  function sliceKey(sessionId, idx) {
    return String(sessionId) + ":" + String(idx).padStart(6, "0");
  }

  // ── Audio slices ──────────────────────────────────────────

  function putSlice(sessionId, idx, blob, meta) {
    return tx(SLICES, "readwrite", function (s) {
      s.put({
        sessionId: String(sessionId),
        idx: Number(idx),
        blob: blob,
        mime: (meta && meta.mime) || "audio/webm",
        ext: (meta && meta.ext) || "webm",
        hints: (meta && meta.hints) || {},
        at: Date.now(),
      }, sliceKey(sessionId, idx));
    });
  }

  function dropSlice(sessionId, idx) {
    return tx(SLICES, "readwrite", function (s) { s.delete(sliceKey(sessionId, idx)); });
  }

  /** Everything still waiting, oldest recording first, in recorded order. */
  function pendingSlices() {
    return tx(SLICES, "readonly", function (s) {
      var rows = [];
      var req = s.openCursor();
      req.onsuccess = function () {
        var c = req.result;
        if (!c) return;
        rows.push({ key: c.key, value: c.value });
        c.continue();
      };
      return { get result() { return rows; } };
    }).then(function (rows) {
      return (rows || []).sort(function (a, b) {
        return a.value.at - b.value.at || a.value.idx - b.value.idx;
      });
    });
  }

  function pendingCount() {
    return pendingSlices().then(function (r) { return r.length; }).catch(function () { return 0; });
  }

  // ── Form drafts ───────────────────────────────────────────

  function fieldsOf(form) {
    var out = {};
    var els = form.querySelectorAll("input[name], textarea[name], select[name]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.type === "file" || el.type === "password") continue;      // never mirror these
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) out[el.name] = el.value;
      } else {
        out[el.name] = el.value;
      }
    }
    return out;
  }

  function saveDraft(key, data) {
    try { localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ at: Date.now(), data: data })); }
    catch (e) { /* quota or blocked storage — the page must not break over it */ }
  }

  function readDraft(key) {
    try {
      var raw = localStorage.getItem(DRAFT_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearDraft(key) {
    try { localStorage.removeItem(DRAFT_PREFIX + key); } catch (e) {}
  }

  /**
   * Mirror a form to local storage as it is typed, and offer the draft back.
   *
   * Deliberately an OFFER rather than an automatic restore: silently filling a
   * blank form with yesterday's hearing is how the wrong client's details end
   * up in a note. The attorney says yes.
   */
  function watchForm(form, key, opts) {
    if (!form || !key) return;
    opts = opts || {};
    var saveAfterMs = opts.debounceMs || 1200;
    var timer = null;

    form.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () { saveDraft(key, fieldsOf(form)); }, saveAfterMs);
    });
    form.addEventListener("change", function () {
      clearTimeout(timer);
      saveDraft(key, fieldsOf(form));
    });
    // The lid closing is the case this exists for, and a debounce timer does
    // not survive it.
    window.addEventListener("pagehide", function () { saveDraft(key, fieldsOf(form)); });

    var draft = readDraft(key);
    if (draft && draft.data && Object.keys(draft.data).some(function (k) {
      return String(draft.data[k] || "").trim() !== "";
    })) {
      offerDraft(form, key, draft);
    }
  }

  function applyDraft(form, data) {
    Object.keys(data || {}).forEach(function (name) {
      var els = form.querySelectorAll("[name=" + JSON.stringify(name) + "]");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.type === "checkbox" || el.type === "radio") el.checked = (el.value === data[name]);
        else el.value = data[name];
      }
    });
  }

  function offerDraft(form, key, draft) {
    var when = new Date(draft.at);
    var bar = document.createElement("div");
    bar.style.cssText = "margin:0 0 16px;padding:12px 14px;border:1px solid #B45309;border-left:4px solid #B45309;"
      + "background:#fffaf3;border-radius:6px;font-size:13px;color:#2B2523;line-height:1.6;";
    var msg = document.createElement("div");
    msg.textContent = "There is an unsent draft of this form from "
      + when.toLocaleString() + ", saved on this computer.";
    var row = document.createElement("div");
    row.style.cssText = "margin-top:8px;display:flex;gap:8px;";

    var use = document.createElement("button");
    use.type = "button";
    use.textContent = "Restore it";
    use.style.cssText = "padding:6px 14px;background:#2B2523;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;";
    use.onclick = function () { applyDraft(form, draft.data); bar.remove(); };

    var drop = document.createElement("button");
    drop.type = "button";
    drop.textContent = "Discard it";
    drop.style.cssText = "padding:6px 14px;background:#fff;color:#9C2B1E;border:1px solid #9C2B1E;border-radius:4px;cursor:pointer;font-size:13px;";
    drop.onclick = function () { clearDraft(key); bar.remove(); };

    row.appendChild(use);
    row.appendChild(drop);
    bar.appendChild(msg);
    bar.appendChild(row);
    form.parentNode.insertBefore(bar, form);
  }

  // ── Queued submissions ────────────────────────────────────

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function writeQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  }

  function queueSubmit(url, fields, label) {
    var q = readQueue();
    q.push({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 8),
      url: url, fields: fields, label: label || "hearing note", at: Date.now(),
    });
    writeQueue(q);
    paint();
    return q.length;
  }

  function encode(fields) {
    return Object.keys(fields).map(function (k) {
      return encodeURIComponent(k) + "=" + encodeURIComponent(fields[k] == null ? "" : fields[k]);
    }).join("&");
  }

  /**
   * Try to send everything queued.
   *
   * An item is removed only on a response the server actually produced. A
   * network failure leaves it queued; a 4xx means the server saw it and
   * refused, so retrying forever would be pointless — it is kept but marked,
   * because throwing away an attorney's note on a validation error would be
   * worse than a stuck queue somebody has to look at.
   */
  function flushQueue() {
    var q = readQueue();
    if (!q.length) return Promise.resolve({ sent: 0, left: 0 });
    var sent = 0;

    return q.reduce(function (chain, item) {
      return chain.then(function () {
        if (item.failedPermanently) return;
        return fetch(item.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          credentials: "same-origin",
          body: encode(item.fields),
        }).then(function (resp) {
          if (resp.ok || resp.status === 302) { item.done = true; sent++; return; }
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 401 && resp.status !== 408) {
            item.failedPermanently = true;
            item.error = "the server refused it (HTTP " + resp.status + ")";
          }
        }).catch(function () { /* still offline; keep it */ });
      });
    }, Promise.resolve()).then(function () {
      var left = q.filter(function (i) { return !i.done; });
      writeQueue(left);
      paint();
      return { sent: sent, left: left.length };
    });
  }

  // ── The status bar ────────────────────────────────────────
  // People will not trust this unless it tells them where their work is.

  var bar = null;
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = "offline-status";
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:8px 14px;"
      + "font-size:13px;font-weight:600;text-align:center;display:none;";
    document.body.appendChild(bar);
    return bar;
  }

  function paint() {
    var el = ensureBar();
    var queued = readQueue().filter(function (i) { return !i.done; });
    var stuck = queued.filter(function (i) { return i.failedPermanently; });

    pendingCount().then(function (slices) {
      if (!navigator.onLine) {
        el.style.display = "block";
        el.style.background = "#9C2B1E";
        el.style.color = "#FAF8F5";
        el.textContent = "No internet — still recording and saving on this computer."
          + (slices ? " " + slices + " audio piece(s) held." : "")
          + (queued.length ? " " + queued.length + " note(s) waiting to file." : "");
        return;
      }
      if (stuck.length) {
        el.style.display = "block";
        el.style.background = "#B45309";
        el.style.color = "#FAF8F5";
        el.textContent = stuck.length + " note(s) were refused by the server and need looking at: "
          + (stuck[0].error || "unknown reason");
        return;
      }
      if (queued.length || slices) {
        el.style.display = "block";
        el.style.background = "#B45309";
        el.style.color = "#FAF8F5";
        el.textContent = "Back online — sending "
          + (slices ? slices + " audio piece(s) " : "")
          + (queued.length ? queued.length + " note(s) " : "") + "now.";
        return;
      }
      el.style.display = "none";
    }).catch(function () { el.style.display = "none"; });
  }

  // ── The two hearing forms ─────────────────────────────────
  //
  // Wired here by id rather than by a call on each page, because a call on
  // each page means more JavaScript inside a server-rendered template
  // literal, which is the thing this file exists to avoid. The pages need the
  // script tag and nothing else.
  var KNOWN_FORMS = [
    { id: "hearing-form", key: "master-hearing",     label: "master hearing note" },
    { id: "ih-form",      key: "individual-hearing", label: "individual hearing note" },
  ];

  /**
   * Keep a note form safe without changing what it does online.
   *
   * When there is a connection the submit is left completely alone — same
   * POST, same navigation, same server handling as before. The offline branch
   * only runs when the browser says there is no network, so nothing about the
   * normal path is at risk.
   */
  function guardNoteForm(form, key, label) {
    // An edit page has the note id in its action, and restoring one hearing
    // into another would be worse than losing a draft.
    var scoped = key + ":" + (form.getAttribute("action") || "");
    watchForm(form, scoped);

    form.addEventListener("submit", function (e) {
      if (navigator.onLine) return;    // behave exactly as it always has
      e.preventDefault();
      var fields = fieldsOf(form);
      queueSubmit(form.getAttribute("action") || location.pathname, fields, label);
      clearDraft(scoped);
      saidQueued(form, label);
    });
  }

  function saidQueued(form, label) {
    var box = document.createElement("div");
    box.style.cssText = "margin:16px 0;padding:16px 18px;border:1px solid #2e7d32;border-left:4px solid #2e7d32;"
      + "background:#f4faf5;border-radius:6px;font-size:14px;color:#2B2523;line-height:1.7;";
    box.innerHTML = "<strong>Saved on this computer.</strong>";
    var p = document.createElement("div");
    p.style.cssText = "margin-top:6px;font-size:13px;color:#2B2523;";
    p.textContent = "There is no internet right now, so this " + label
      + " has not reached the firm yet. It will file itself as soon as you are back online"
      + " — leave this tab open if you can, and do not retype it.";
    box.appendChild(p);
    form.parentNode.insertBefore(box, form);
    form.style.display = "none";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── Wake up when the signal comes back ────────────────────
  var onReconnect = [];
  function whenOnline(fn) { onReconnect.push(fn); }

  window.addEventListener("online", function () {
    paint();
    flushQueue();
    onReconnect.forEach(function (fn) { try { fn(); } catch (e) {} });
  });
  window.addEventListener("offline", paint);

  window.addEventListener("load", function () {
    KNOWN_FORMS.forEach(function (f) {
      var el = document.getElementById(f.id);
      if (el) guardNoteForm(el, f.key, f.label);
    });
    paint();
    if (navigator.onLine) {
      flushQueue();
      onReconnect.forEach(function (fn) { try { fn(); } catch (e) {} });
    }
  });

  window.offlineNotes = {
    putSlice: putSlice, dropSlice: dropSlice, pendingSlices: pendingSlices, pendingCount: pendingCount,
    watchForm: watchForm, readDraft: readDraft, clearDraft: clearDraft,
    queueSubmit: queueSubmit, flushQueue: flushQueue, fieldsOf: fieldsOf,
    whenOnline: whenOnline, refreshStatus: paint, guardNoteForm: guardNoteForm,
  };
})();
