/* ────────────────────────────────────────────────────────────
 * court-mail-page.js — the Court Mail page.
 *
 * Shows whether the court mailbox is being checked, and every email it
 * has read: what it was, what was done (with Undo), and the ones that
 * need a person — assign them to a case or client in one click.
 * Talks to /admin/court-mail/api/*.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  var host = document.querySelector("[data-court-mail]");
  if (!host) return;
  var API = "/admin/court-mail/api";
  var C = { walnut: "#3E2818", mid: "#5A3B22", gold: "#B8891E", ember: "#F07800", red: "#A02818",
    lit: "#FBF3DE", border: "#D4C4A0", muted: "#7B5330", green: "#166534" };

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "style") e.style.cssText = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: { Accept: "application/json" } };
    if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    return fetch(API + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }
  function btn(label, fn, kind) {
    var dark = kind === "primary" || kind === "go";
    return h("button", { type: "button", text: label, onclick: fn,
      style: "padding:6px 12px;border-radius:5px;cursor:pointer;font-size:11.5px;font-family:Cinzel,Georgia,serif;letter-spacing:.6px;" +
             "background:" + (kind === "go" ? C.ember : dark ? C.mid : C.lit) + ";color:" + (dark ? C.lit : C.walnut) + ";border:1px solid " + (dark ? C.gold : C.border) + ";" });
  }
  function chip(text, color) { return h("span", { text: text, style: "display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;color:#fff;background:" + color + ";" }); }
  function when(v) { try { return v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; } catch (e) { return ""; } }
  var STATUS = { done: [C.green, "done"], needs_review: [C.ember, "needs you"], error: [C.red, "error"], ignored: ["#999", "not court mail"],
    handled: ["#777", "handled"], "new": [C.muted, "queued"], working: [C.muted, "reading…"] };

  var statusBox = h("div"), filterBar = h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin:12px 0;" }), listBox = h("div");
  host.appendChild(statusBox); host.appendChild(filterBar); host.appendChild(listBox);
  var filter = location.hash === "#all" ? "" : "needs_review";

  function drawStatus() {
    api("/status").then(function (s) {
      clear(statusBox);
      var box = h("div", { style: "background:" + C.lit + ";border:1px solid " + C.border + ";border-radius:7px;padding:12px 16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;" });
      if (!s.configured) {
        box.appendChild(h("div", { style: "color:" + C.red + ";font-size:13px;" }, [
          h("strong", { text: "The court mailbox is not set up yet. " }),
          "Add COURT_MAIL_USER and COURT_MAIL_PASS in Render (or GMAIL_EMAIL and GMAIL_APP_PASSWORD, already used for sending), then redeploy."]));
      } else {
        box.appendChild(h("div", { style: "font-size:13px;color:" + C.walnut + ";" }, [
          h("strong", { text: "Forward court emails to " + s.mailbox }),
          h("div", { style: "font-size:12px;color:" + C.muted + ";margin-top:2px;", text:
            "Checked every " + s.every_minutes + " min · last check " + (when(s.last_check_at) || "not yet") +
            " · acts on mail forwarded from " + (s.forwarders || []).join(", ") + " or sent by a court/agency" }),
          s.last_error ? h("div", { style: "font-size:12px;color:" + C.red + ";margin-top:2px;", text: "Last problem: " + s.last_error }) : null,
        ]));
      }
      var msg = h("span", { style: "font-size:12px;color:" + C.muted + ";" });
      box.appendChild(h("div", { style: "display:flex;gap:8px;align-items:center;" }, [msg, s.configured ? btn("Check now", function () {
        msg.textContent = "Checking…";
        api("/check", { method: "POST", body: {} }).then(function () {
          msg.textContent = "Checking the mailbox — this page will refresh.";
          setTimeout(function () { drawStatus(); drawList(); }, 8000);
          setTimeout(function () { drawStatus(); drawList(); }, 30000);
        }).catch(function (e) { msg.textContent = e.message; });
      }, "primary") : null]));
      statusBox.appendChild(box);

      clear(filterBar);
      var counts = s.counts || {};
      [["needs_review", "Needs you"], ["done", "Done"], ["error", "Errors"], ["ignored", "Not court mail"], ["", "All"]].forEach(function (f) {
        var n = f[0] ? (counts[f[0]] || 0) : Object.keys(counts).reduce(function (a, k) { return a + counts[k]; }, 0);
        var on = filter === f[0];
        filterBar.appendChild(h("button", { type: "button", text: f[1] + " (" + n + ")", "data-filter": f[0] || "all",
          onclick: function () { filter = f[0]; drawStatus(); drawList(); },
          style: "padding:5px 12px;border-radius:14px;cursor:pointer;font-size:12px;border:1px solid " + (on ? C.gold : C.border) +
                 ";background:" + (on ? C.mid : "#fff") + ";color:" + (on ? C.lit : C.walnut) + ";" }));
      });
    }).catch(function (e) { clear(statusBox).appendChild(h("div", { text: "Status unavailable: " + e.message, style: "color:" + C.red })); });
  }

  function assignBox(m, done) {
    var q = h("input", { type: "text", placeholder: "Search a case (name or number) or a client (name or A-number)…",
      style: "width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid " + C.border + ";border-radius:5px;font-size:13px;" });
    var results = h("div", { style: "margin-top:6px;" });
    var t = null;
    q.addEventListener("input", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        if (q.value.trim().length < 2) { clear(results); return; }
        api("/search?q=" + encodeURIComponent(q.value.trim())).then(function (d) {
          clear(results);
          d.matters.forEach(function (x) {
            results.appendChild(btn("⚖ " + x.case_name + (x.case_number ? " · " + x.case_number : ""), function () { done({ case_id: x.id, label: x.case_name }); }));
          });
          d.clients.forEach(function (x) {
            results.appendChild(btn("👤 " + x.name + (x.a_number ? " · A" + String(x.a_number).replace(/^A/i, "") : ""), function () { done({ client_key: x.key, label: x.name }); }));
          });
          if (!d.matters.length && !d.clients.length) results.appendChild(h("div", { text: "No match.", style: "font-size:12px;color:" + C.muted }));
          Array.prototype.forEach.call(results.children, function (b) { b.style.margin = "0 6px 6px 0"; });
        });
      }, 250);
    });
    return h("div", { style: "margin-top:8px;padding:10px;background:#fff;border:1px dashed " + C.gold + ";border-radius:6px;" }, [
      h("div", { text: "Which case or client is this for? It will then be filed and calendared.", style: "font-size:12px;color:" + C.muted + ";margin-bottom:6px;" }), q, results]);
  }

  function card(m) {
    var r = m.reading || {};
    var st = STATUS[m.status] || [C.muted, m.status];
    var msg = h("div", { style: "font-size:12px;margin-top:6px;" });
    function act(p, ok) {
      msg.style.color = C.muted; msg.textContent = "Working…";
      p.then(function () { msg.style.color = C.green; msg.textContent = ok; setTimeout(function () { drawStatus(); drawList(); }, 600); })
        .catch(function (e) { msg.style.color = C.red; msg.textContent = e.message; });
    }
    var actions = (m.actions || []).map(function (a, i) {
      return h("div", { "data-action": i, style: "font-size:12.5px;padding:2px 0;" + (a.undone ? "text-decoration:line-through;color:#999;" : "") }, [
        "• " + a.label + (a.undone ? " (undone)" : ""),
        !a.undone && a.type !== "file" ? h("a", { href: "#", text: "Undo", style: "margin-left:8px;font-size:11.5px;color:" + C.gold + ";",
          onclick: function (e) { e.preventDefault(); act(api("/" + m.id + "/undo/" + i, { method: "POST", body: {} }), "Undone."); } }) : null,
      ]);
    });
    var assignArea = h("div");
    var box = h("div", { id: "mail-" + m.id, "data-mail": m.id,
      style: "background:" + C.lit + ";border:1px solid " + C.border + ";border-left:4px solid " + st[0] + ";border-radius:7px;padding:10px 14px;margin-bottom:10px;" }, [
      h("div", { style: "display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;" }, [
        h("div", {}, [r.urgent ? chip("urgent", C.red) : null, r.urgent ? " " : null,
          h("strong", { text: r.title || m.subject || "(no subject)", style: "margin-right:8px;" }), chip(st[1], st[0])]),
        h("span", { text: when(m.received_at) + " · " + (m.original_from || m.from_addr || ""), style: "font-size:11px;color:" + C.muted + ";" }),
      ]),
      r.summary ? h("div", { text: r.summary, style: "font-size:13px;margin-top:5px;" }) : null,
      m.matched_by ? h("div", { style: "font-size:12px;color:" + C.green + ";margin-top:4px;" }, [
        "Matched by " + m.matched_by + " → ",
        m.case_id ? h("a", { href: "/admin/civil/case/" + m.case_id, text: "open the case", style: "color:" + C.gold }) : null,
        m.client_key ? h("a", { href: "/admin/clients/" + encodeURIComponent(m.client_key), text: "open the client", style: "color:" + C.gold }) : null]) : null,
      actions.length ? h("div", { style: "margin-top:6px;" }, actions) : null,
      (r.action_items || []).length ? h("div", { style: "font-size:12.5px;margin-top:6px;" }, [h("strong", { text: "To do: " }), r.action_items.join("; ")]) : null,
      m.note ? h("div", { text: m.note, style: "font-size:12px;color:" + (m.status === "needs_review" ? C.ember : C.muted) + ";margin-top:6px;white-space:pre-wrap;" }) : null,
      m.error ? h("div", { text: "Error: " + m.error, style: "font-size:12px;color:" + C.red + ";margin-top:6px;" }) : null,
      assignArea,
      h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center;" }, [
        m.has_raw !== false && (m.status === "needs_review" || m.status === "error" || m.status === "ignored") ? btn("Assign to a case or client", function () {
          clear(assignArea).appendChild(assignBox(m, function (t) { act(api("/" + m.id + "/assign", { method: "POST", body: t }), "Filed and calendared."); }));
        }, "go") : null,
        m.status === "error" || m.status === "needs_review" ? btn("Read again", function () { act(api("/" + m.id + "/reread", { method: "POST", body: {} }), "Read again."); }) : null,
        m.status === "needs_review" || m.status === "error" ? btn("Mark handled", function () { act(api("/" + m.id + "/handled", { method: "POST", body: {} }), "Marked handled."); }) : null,
        m.has_raw !== false ? h("a", { href: API + "/" + m.id + "/eml", text: "Original email", style: "font-size:11.5px;color:" + C.gold + ";" }) : null,
      ]),
      msg,
    ]);
    return box;
  }

  function drawList() {
    clear(listBox).appendChild(h("div", { text: "Loading…", style: "font-size:12px;color:" + C.muted }));
    api("/list" + (filter ? "?status=" + filter : "")).then(function (d) {
      clear(listBox);
      if (!d.mail.length) {
        listBox.appendChild(h("div", { text: filter === "needs_review" ? "Nothing needs you. 👍" : "No court mail yet.", style: "font-size:13px;color:" + C.muted + ";font-style:italic;padding:8px 0;" }));
        return;
      }
      d.mail.forEach(function (m) { listBox.appendChild(card(m)); });
      var target = location.hash && document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView({ block: "center" });
    }).catch(function (e) { clear(listBox).appendChild(h("div", { text: e.message, style: "color:" + C.red })); });
  }

  if (/^#mail-\d+$/.test(location.hash)) filter = "";
  drawStatus();
  drawList();
  window.CourtMail = { reload: function () { drawStatus(); drawList(); } };
})();
