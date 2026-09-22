/* ────────────────────────────────────────────────────────────
 * consultant-clients.js — the consultant portal's client pages.
 *
 *   [data-consultant-clients="list"]  My Clients, with search
 *   [data-consultant-clients="new"]   Add a client
 *   [data-consultant-clients="view"]  One client: details (editable if
 *                                     they entered it), open work, messages
 *
 * JJ: consultants must be able to enter client info, search it, and see
 * it on their phone and computer. Same /api/consultant/* calls as the
 * phone app; the web sign-in cookie is accepted there.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  var host = document.querySelector("[data-consultant-clients]");
  if (!host) return;
  var API = "/api/consultant";
  var NAVY = "#0C1C36", GOLD = "#B79C62", MUTED = "#666", RED = "#c62828";

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
    var init = { method: opts.method || "GET", headers: { Accept: "application/json" }, credentials: "same-origin" };
    if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    return fetch(API + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }).then(function (d) {
        if (r.status === 401) { location.href = "/admin/login?next=" + encodeURIComponent(location.pathname + location.search); }
        if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }
  function note(msg, bad) { return h("div", { text: msg, style: "font-size:13px;color:" + (bad ? RED : MUTED) + ";margin:8px 0;" }); }
  function when(v) { try { return v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""; } catch (e) { return ""; } }
  function field(label, input) { return h("div", { style: "margin-bottom:12px;" }, [h("label", { text: label }), input]); }
  function input(name, value, attrs) {
    var a = { type: "text", name: name, value: value || "" };
    Object.keys(attrs || {}).forEach(function (k) { a[k] = attrs[k]; });
    return h("input", a);
  }
  var MATTERS = ["", "Immigration — asylum", "Immigration — family / green card", "Immigration — court / removal", "Immigration — other",
    "Personal injury", "Business", "Landlord / tenant", "Estate planning", "Real estate", "Trademark", "Other"];

  // ── List + search ─────────────────────────────────────────
  function list() {
    var q = h("input", { type: "search", placeholder: "Search name, phone, email or A-number…", style: "flex:1;min-width:220px;" });
    var box = h("div");
    host.appendChild(h("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px;" }, [
      q, h("a", { href: "/consultant/clients/new", class: "btn-primary", text: "＋ Add Client" }),
    ]));
    host.appendChild(box);
    var timer = null, seq = 0;
    function load() {
      var mine = ++seq;
      api("/clients?q=" + encodeURIComponent(q.value.trim())).then(function (d) {
        if (mine !== seq) return;
        clear(box);
        if (!d.clients.length) { box.appendChild(note(q.value.trim() ? "No client of yours matches." : "No clients yet. Add one, or the firm will assign clients to you.")); return; }
        d.clients.forEach(function (c) {
          var meta = [c.client_phone, c.client_email, c.a_number ? "A# " + c.a_number : null].filter(Boolean).join(" · ");
          box.appendChild(h("a", { href: "/consultant/client/" + encodeURIComponent(c.client_key), class: "card",
            style: "display:block;text-decoration:none;color:inherit;padding:14px 18px;" }, [
            h("div", { style: "display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;" }, [
              h("strong", { text: c.client_name || "(no name yet)", style: "color:" + NAVY + ";font-size:15px;" }),
              h("span", { text: c.entered_by_me ? "Entered by you" : (c.role_description || "Assigned by the firm"), style: "font-size:11px;color:" + GOLD + ";font-weight:600;" }),
            ]),
            meta ? h("div", { text: meta, style: "font-size:12.5px;color:" + MUTED + ";margin-top:3px;" }) : null,
            h("div", { text: (c.matter_type ? c.matter_type + " · " : "") + (Number(c.open_task_count) || 0) + " open item(s)", style: "font-size:12px;color:" + MUTED + ";margin-top:3px;" }),
          ]));
        });
      }).catch(function (e) { clear(box).appendChild(note(e.message, true)); });
    }
    q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 250); });
    load();
  }

  // ── Add a client ──────────────────────────────────────────
  function add() {
    var status = h("span", { style: "font-size:13px;margin-left:12px;color:" + MUTED + ";" });
    var matter = h("select", { name: "matter_interest" }, MATTERS.map(function (m) { return h("option", { value: m, text: m || "— choose —" }); }));
    var form = h("form", { class: "card" }, [
      h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 16px;" }, [
        field("Client name *", input("client_name", "", { required: "required", placeholder: "Last, First", maxlength: "200" })),
        field("Phone", input("client_phone", "", { type: "tel", placeholder: "(626) 555-0100", maxlength: "40" })),
        field("Email", input("client_email", "", { type: "email", maxlength: "200" })),
        field("A-number (if any)", input("a_number", "", { placeholder: "A123-456-789", maxlength: "30" })),
        field("Language", input("language", "", { placeholder: "English, 中文, Español…", maxlength: "40" })),
        field("What they need help with", matter),
      ]),
      field("Notes for the firm", h("textarea", { name: "notes", rows: "4", maxlength: "4000", placeholder: "Background, how you met them, deadlines they mentioned…" })),
      h("div", {}, [h("button", { type: "submit", class: "btn-primary", text: "Save client" }), status]),
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var data = {};
      new FormData(form).forEach(function (v, k) { if (String(v).trim()) data[k] = String(v).trim(); });
      if (!data.client_name) { status.textContent = "Client name is required."; status.style.color = RED; return; }
      var btn = form.querySelector("button"); btn.disabled = true; status.textContent = "Saving…"; status.style.color = MUTED;
      api("/clients", { method: "POST", body: data }).then(function (d) {
        location.href = "/consultant/client/" + encodeURIComponent(d.client.client_key) + "?saved=1";
      }).catch(function (e) { btn.disabled = false; status.textContent = e.message; status.style.color = RED; });
    });
    host.appendChild(form);
  }

  // ── One client ────────────────────────────────────────────
  function view() {
    var key = host.getAttribute("data-key");
    var top = h("div"), work = h("div"), msgs = h("div");
    host.appendChild(top); host.appendChild(work); host.appendChild(msgs);
    if (/saved=1/.test(location.search)) top.appendChild(h("div", { class: "card", style: "background:#e8f5e9;border-color:#a5d6a7;color:#2e7d32;padding:12px 16px;", text: "✅ Client saved. The firm has been notified." }));

    function drawInfo(c, assignment) {
      var box = h("div", { class: "card" });
      var title = document.querySelector(".page-header h1");
      if (title) title.textContent = c.client_name || "Client";
      var rows = [["Phone", c.client_phone], ["Email", c.client_email], ["A-number", c.a_number], ["Matter", c.matter_type === "Contact" ? "Not opened yet (contact only)" : c.matter_type],
        ["Your role", assignment && assignment.role_description]];
      box.appendChild(h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;" }, rows.filter(function (r) { return r[1]; }).map(function (r) {
        return h("div", {}, [h("label", { text: r[0] }), h("div", { text: r[1], style: "font-weight:600;color:" + NAVY + ";" })]);
      })));
      var actions = h("div", { style: "margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;" }, [
        h("a", { class: "btn-primary", href: "/consultant/new?client=" + encodeURIComponent(c.client_name || ""), text: "＋ Work order for this client" }),
      ]);
      if (c.editable) actions.appendChild(h("button", { type: "button", class: "btn-secondary", text: "✎ Edit details", onclick: function () { clear(box); box.appendChild(editForm(c)); } }));
      box.appendChild(actions);
      if (!c.editable) box.appendChild(note("This client's record belongs to the firm. To change their details, send a work order or a message."));
      return box;
    }

    function editForm(c) {
      var status = h("span", { style: "font-size:13px;margin-left:12px;color:" + MUTED + ";" });
      var form = h("form", {}, [
        h("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px;" }, [
          field("Client name *", input("client_name", c.client_name, { required: "required", maxlength: "200" })),
          field("Phone", input("client_phone", c.client_phone, { type: "tel", maxlength: "40" })),
          field("Email", input("client_email", c.client_email, { type: "email", maxlength: "200" })),
          field("A-number", input("a_number", c.a_number, { maxlength: "30" })),
        ]),
        h("button", { type: "submit", class: "btn-primary", text: "Save" }),
        h("button", { type: "button", class: "btn-secondary", text: "Cancel", style: "margin-left:8px;", onclick: function () { load(); } }),
        status,
      ]);
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var data = {};
        new FormData(form).forEach(function (v, k) { data[k] = String(v).trim(); });
        status.textContent = "Saving…";
        api("/clients/" + encodeURIComponent(key), { method: "PATCH", body: data }).then(function () { load(); })
          .catch(function (e) { status.textContent = e.message; status.style.color = RED; });
      });
      return form;
    }

    function drawWork(tasks) {
      clear(work);
      var open = tasks.filter(function (t) { return !t.completed && t.matter_type !== "Contact"; });
      var box = h("div", { class: "card" }, [h("h3", { text: "Open work (" + open.length + ")", style: "margin:0 0 8px;color:" + NAVY + ";font-size:16px;" })]);
      if (!open.length) box.appendChild(note("Nothing open for this client."));
      open.slice(0, 30).forEach(function (t) {
        box.appendChild(h("div", { style: "padding:8px 0;border-top:1px solid #f0f0f0;font-size:13.5px;" }, [
          h("div", { text: t.description || "(task)", style: "color:" + NAVY + ";white-space:pre-wrap;" }),
          h("div", { text: [t.status, t.due_date ? "due " + String(t.due_date).slice(0, 10) : null].filter(Boolean).join(" · "), style: "font-size:11.5px;color:" + MUTED + ";margin-top:2px;" }),
        ]));
      });
      work.appendChild(box);
    }

    function drawMsgs(list) {
      clear(msgs);
      var box = h("div", { class: "card" }, [h("h3", { text: "Messages with the client", style: "margin:0 0 8px;color:" + NAVY + ";font-size:16px;" })]);
      var thread = h("div", { style: "max-height:360px;overflow:auto;" });
      if (!list.length) thread.appendChild(note("No messages yet."));
      list.forEach(function (m) {
        var fromClient = m.sender_kind === "client";
        thread.appendChild(h("div", { style: "margin:6px 0;display:flex;justify-content:" + (fromClient ? "flex-start" : "flex-end") + ";" }, [
          h("div", { style: "max-width:75%;padding:8px 12px;border-radius:10px;font-size:13.5px;white-space:pre-wrap;background:" + (fromClient ? "#f1f1f1" : "#f5efe0") + ";" }, [
            h("div", { text: m.body }),
            h("div", { text: (m.sender_name || (fromClient ? "Client" : "Firm")) + " · " + when(m.created_at), style: "font-size:10.5px;color:" + MUTED + ";margin-top:3px;" }),
          ]),
        ]));
      });
      var ta = h("textarea", { rows: "2", placeholder: "Write to the client…", maxlength: "4000" });
      var status = h("span", { style: "font-size:12px;color:" + MUTED + ";margin-left:10px;" });
      var send = h("button", { type: "button", class: "btn-primary", text: "Send", onclick: function () {
        var body = ta.value.trim(); if (!body) return;
        send.disabled = true; status.textContent = "Sending…";
        api("/clients/" + encodeURIComponent(key) + "/messages", { method: "POST", body: { body: body } })
          .then(function () { return api("/clients/" + encodeURIComponent(key) + "/messages"); })
          .then(function (d) { drawMsgs(d.messages || []); })
          .catch(function (e) { send.disabled = false; status.textContent = e.message; status.style.color = RED; });
      } });
      box.appendChild(thread);
      box.appendChild(h("div", { style: "margin-top:10px;" }, [ta, h("div", { style: "margin-top:6px;" }, [send, status])]));
      msgs.appendChild(box);
      thread.scrollTop = thread.scrollHeight;
    }

    function load() {
      var enc = encodeURIComponent(key);
      api("/clients/" + enc).then(function (d) {
        var keep = top.firstChild && /saved/.test(top.firstChild.textContent) ? top.firstChild : null;
        clear(top); if (keep) top.appendChild(keep);
        top.appendChild(drawInfo(d.client, d.assignment));
        return Promise.all([
          api("/clients/" + enc + "/tasks").then(function (t) { drawWork(t.tasks || []); }).catch(function () { clear(work); }),
          api("/clients/" + enc + "/messages").then(function (m) { drawMsgs(m.messages || []); }).catch(function () { clear(msgs); }),
        ]);
      }).catch(function (e) { clear(top).appendChild(note(e.message, true)); });
    }
    load();
  }

  var mode = host.getAttribute("data-consultant-clients");
  if (mode === "new") add(); else if (mode === "view") view(); else list();
})();
