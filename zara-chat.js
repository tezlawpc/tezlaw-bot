/* ────────────────────────────────────────────────────────────
 * zara-chat.js — Zara, on every page of the web admin.
 *
 * The app has had a Zara chat since build 36. The web — where JJ, the
 * attorneys and the case managers actually do most of their work — had
 * none. If you were on a case page and wanted to ask her something, the
 * options were to pick up your phone or to go without.
 *
 * So: a docked panel, available everywhere, that knows what you are
 * looking at. Asking "what's the SOL on this one?" while a matter is
 * open works, because the widget sends the page it is on along with the
 * question. Re-typing the case name you are already staring at is the
 * kind of friction that quietly kills a feature.
 *
 * Talks to /admin/zara/api/chat, the admin-cookie twin of the same
 * /api/staff/chat handler the iOS app uses — so the two surfaces cannot
 * answer differently, and both compose from the charter.
 *
 * Served as a real static file. Inline JS inside a server-side template
 * literal loses its escapes before the browser sees it; that trap has
 * bitten this codebase three times.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  if (window.__zaraChatLoaded) return;   // one instance per page
  window.__zaraChatLoaded = true;

  var C = {
    walnut: "#3E2818", walnutMid: "#5A3B22",
    gold: "#B8891E", ember: "#F07800", waxRed: "#A02818",
    parchment: "#F5EBD3", parchmentLit: "#FBF3DE", border: "#D4C4A0",
    muted: "#7B5330",
  };

  var OPEN_KEY = "tez_zara_chat_open";
  var LOG_KEY = "tez_zara_chat_log";
  var MAX_KEPT = 40;

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "style") e.style.cssText = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }

  // ── What page are we on? ───────────────────────────────────
  //
  // Sent with every question. Built from what the page already shows
  // rather than from a lookup, so it costs nothing and stays accurate
  // even on pages this file has never heard of.
  function pageContext() {
    var bits = [];
    var h1 = document.querySelector("h1");
    if (h1) bits.push("The user is on the page: " + h1.textContent.trim().replace(/\s+/g, " "));
    bits.push("URL: " + location.pathname + location.search);

    // A case page carries its id on the panel host; the heading carries
    // the matter name. Both are worth naming explicitly.
    var host = document.querySelector("[data-case-id]");
    if (host) {
      var id = host.getAttribute("data-case-id");
      if (id) bits.push("They have civil matter #" + id + " open. If they say 'this case' or 'this matter', they mean that one.");
    }
    var stageHost = document.querySelector("[data-stage-key]");
    if (stageHost) bits.push("Lifecycle stage in view: " + stageHost.getAttribute("data-stage-key"));

    return bits.join("\n");
  }

  // ── State ──────────────────────────────────────────────────
  var log = [];
  try { log = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]"); } catch (e) { log = []; }
  function saveLog() {
    try { sessionStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-MAX_KEPT))); } catch (e) { /* private mode */ }
  }

  var panel, body, input, sendBtn, busy = false;

  function bubble(role, text) {
    var mine = role === "user";
    return h("div", {
      style: "max-width:88%;align-self:" + (mine ? "flex-end" : "flex-start") +
             ";background:" + (mine ? C.walnutMid : C.parchmentLit) +
             ";color:" + (mine ? C.parchmentLit : C.walnut) +
             ";border:1px solid " + (mine ? "transparent" : C.border) +
             ";border-radius:9px;padding:8px 11px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;",
      text: text,
    });
  }

  function draw() {
    while (body.firstChild) body.removeChild(body.firstChild);
    if (!log.length) {
      body.appendChild(h("div", {
        style: "color:" + C.muted + ";font-size:12.5px;font-style:italic;line-height:1.6;padding:6px 2px;",
        text: "Ask about a matter, a deadline, a client, or the law. Zara can see which page you have open, so “what’s the SOL on this one?” works.",
      }));
    }
    log.forEach(function (m) { body.appendChild(bubble(m.role, m.text)); });
    if (busy) {
      body.appendChild(h("div", {
        style: "align-self:flex-start;color:" + C.muted + ";font-size:12px;font-style:italic;padding:4px 2px;",
        text: "Zara is thinking…",
      }));
    }
    body.scrollTop = body.scrollHeight;
  }

  function send() {
    var q = input.value.trim();
    if (!q || busy) return;
    input.value = "";
    input.style.height = "auto";
    log.push({ role: "user", text: q });
    busy = true; draw(); saveLog();

    fetch("/admin/zara/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        message: q,
        context: pageContext(),
        // Only the last few turns: the endpoint trims anyway, and a long
        // tail of stale context makes her answers worse, not better.
        history: log.slice(-7, -1).map(function (m) {
          return { role: m.role, content: m.text };
        }),
      }),
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
      .then(function (d) {
        if (d.ok === false) throw new Error(d.error || "Request failed");
        var a = (d.reply && (d.reply.answer || d.reply.text)) || d.reply || "(no response)";
        log.push({ role: "assistant", text: typeof a === "string" ? a : JSON.stringify(a) });
      })
      .catch(function (e) {
        log.push({ role: "assistant", text: "Couldn't reach Zara: " + e.message });
      })
      .then(function () { busy = false; draw(); saveLog(); });
  }

  function setOpen(open) {
    panel.style.display = open ? "flex" : "none";
    launcher.style.display = open ? "none" : "flex";
    try { sessionStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch (e) {}
    if (open) { draw(); setTimeout(function () { input.focus(); }, 40); }
  }

  // ── Build ──────────────────────────────────────────────────
  var launcher = h("button", {
    title: "Ask Zara",
    onclick: function () { setOpen(true); },
    style: "position:fixed;right:20px;bottom:20px;z-index:9998;width:52px;height:52px;border-radius:26px;" +
           "background:" + C.walnut + ";color:" + C.parchmentLit + ";border:2px solid " + C.gold +
           ";font-size:21px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.28);align-items:center;justify-content:center;display:flex;",
  }, ["◎"]);

  body = h("div", {
    style: "flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:" + C.parchment + ";",
  });

  input = h("textarea", {
    rows: 1,
    placeholder: "Ask Zara…",
    style: "flex:1;resize:none;max-height:120px;padding:9px 11px;border:1px solid " + C.border +
           ";border-radius:6px;font-family:inherit;font-size:13px;line-height:1.45;color:" + C.walnut + ";background:#fff;",
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });
  input.addEventListener("keydown", function (e) {
    // Enter sends, Shift+Enter writes a new line — what people expect of a
    // chat box, and what makes it usable without reaching for the mouse.
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  sendBtn = h("button", {
    onclick: send,
    style: "flex-shrink:0;width:38px;height:38px;border-radius:19px;background:" + C.gold +
           ";color:#fff;border:none;font-size:16px;cursor:pointer;",
  }, ["➤"]);

  panel = h("div", {
    style: "position:fixed;right:20px;bottom:20px;z-index:9999;width:392px;max-width:calc(100vw - 32px);" +
           "height:540px;max-height:calc(100vh - 110px);background:" + C.parchmentLit +
           ";border:1px solid " + C.border + ";border-top:3px solid " + C.gold +
           ";border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;",
  }, [
    h("div", {
      style: "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;" +
             "background:" + C.walnut + ";color:" + C.parchmentLit + ";flex-shrink:0;",
    }, [
      h("div", { style: "display:flex;align-items:baseline;gap:8px;min-width:0;" }, [
        h("span", { text: "◎ Zara", style: "font-family:Cinzel,serif;font-size:13px;letter-spacing:1.4px;" }),
        h("span", {
          text: "sees this page",
          style: "font-size:10.5px;color:" + C.parchment + ";opacity:.75;font-style:italic;",
        }),
      ]),
      h("div", { style: "display:flex;gap:4px;flex-shrink:0;" }, [
        h("button", {
          title: "Clear this conversation",
          onclick: function () { log = []; saveLog(); draw(); },
          style: "background:none;border:none;color:" + C.parchment + ";font-size:12px;cursor:pointer;opacity:.75;padding:2px 6px;",
        }, ["clear"]),
        h("button", {
          title: "Close",
          onclick: function () { setOpen(false); },
          style: "background:none;border:none;color:" + C.parchmentLit + ";font-size:17px;cursor:pointer;line-height:1;padding:0 4px;",
        }, ["×"]),
      ]),
    ]),
    body,
    h("div", {
      style: "display:flex;gap:8px;align-items:flex-end;padding:10px;background:" + C.parchmentLit +
             ";border-top:1px solid " + C.border + ";flex-shrink:0;",
    }, [input, sendBtn]),
  ]);

  function mount() {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    var wasOpen = "0";
    try { wasOpen = sessionStorage.getItem(OPEN_KEY) || "0"; } catch (e) {}
    setOpen(wasOpen === "1");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  window.ZaraChat = { open: function () { setOpen(true); }, context: pageContext };
})();
