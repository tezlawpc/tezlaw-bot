/* ────────────────────────────────────────────────────────────
 * esign-admin.js — templates and documents for signature, in the
 * web admin.
 *
 *   [data-esign="templates"]  the Templates page: upload a filed
 *                             document, review what Zara made of it,
 *                             activate it.
 *   [data-esign="case"]       on a civil case page, and
 *   [data-esign="client"]     on any client's profile (immigration and
 *                             every other client): prepare a document
 *                             from an active template, filled from the
 *                             matter or the client, send it, follow who
 *                             has signed, download it.
 *
 * Talks to /admin/esign/api/* (cookie twins of the app routes). Templates
 * are managed by an admin only.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  if (window.__esignAdminLoaded) return;
  window.__esignAdminLoaded = true;

  var C = {
    walnut: "#3E2818", walnutMid: "#5A3B22", gold: "#B8891E", ember: "#F07800", red: "#A02818",
    parch: "#F5EBD3", lit: "#FBF3DE", border: "#D4C4A0", muted: "#7B5330", green: "#166534",
  };
  var BASE = "/admin/esign/api";
  var META = null;

  // ── helpers ────────────────────────────────────────────────
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "style") e.style.cssText = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: { Accept: "application/json" } };
    if (opts.form) init.body = opts.form;
    else if (opts.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    return fetch(BASE + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }
  function meta() {
    if (META) return Promise.resolve(META);
    return api("/meta").then(function (m) { META = m; return m; });
  }
  function btn(label, onclick, kind) {
    var bg = kind === "primary" ? C.walnutMid : kind === "danger" ? C.red : kind === "go" ? C.ember : C.lit;
    var fg = kind === "primary" || kind === "danger" || kind === "go" ? C.lit : C.walnut;
    return h("button", { type: "button", onclick: onclick, text: label,
      style: "padding:7px 13px;background:" + bg + ";color:" + fg + ";border:1px solid " + (kind ? C.gold : C.border) +
             ";border-radius:5px;cursor:pointer;font-size:11.5px;font-family:Cinzel,Georgia,serif;letter-spacing:.8px;" });
  }
  function chip(text, color) {
    return h("span", { text: text, style: "display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;color:#fff;background:" + color + ";" });
  }
  function note(text, color) { return h("div", { text: text, style: "color:" + (color || C.muted) + ";font-size:12.5px;font-style:italic;padding:6px 0;" }); }
  function field(label, input, hint) {
    return h("label", { style: "display:block;margin:0 0 10px;font-size:12px;color:" + C.muted + ";" },
      [h("div", { text: label, style: "margin-bottom:3px;" }), input, hint ? h("div", { text: hint, style: "font-size:11px;margin-top:2px;" }) : null]);
  }
  var inputCss = "width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid " + C.border + ";border-radius:5px;font-size:13px;font-family:inherit;background:#fff;color:" + C.walnut + ";";
  function input(value, attrs) {
    var a = { type: "text", value: value == null ? "" : String(value), style: inputCss };
    Object.keys(attrs || {}).forEach(function (k) { a[k] = attrs[k]; });
    return h("input", a);
  }
  function select(options, value) {
    var s = h("select", { style: inputCss });
    options.forEach(function (o) {
      var opt = h("option", { value: o[0], text: o[1] });
      if (String(o[0]) === String(value)) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }
  function box(kids, extra) {
    return h("div", { style: "background:" + C.lit + ";border:1px solid " + C.border + ";border-radius:7px;padding:14px 16px;margin-bottom:14px;" + (extra || "") }, kids);
  }
  function when(v) {
    if (!v) return "";
    try { return new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return String(v); }
  }
  function statusChip(s) {
    var map = { draft: [C.muted, "draft"], active: [C.green, "active"], archived: ["#888", "archived"],
      sent: [C.ember, "out for signature"], completed: [C.green, "signed"], cancelled: ["#888", "cancelled"], declined: [C.red, "declined"] };
    var m = map[s] || [C.muted, s];
    return chip(m[1], m[0]);
  }
  function copy(text, el) {
    function ok() { if (el) { var t = el.textContent; el.textContent = "Copied ✓"; setTimeout(function () { el.textContent = t; }, 1500); } }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () { window.prompt("Copy this link:", text); });
    else window.prompt("Copy this link:", text);
  }
  var PREVIEW_CSS = "background:#fff;border:1px solid " + C.border + ";border-radius:6px;padding:22px 26px;max-height:520px;overflow:auto;font-family:'Times New Roman',serif;font-size:14px;line-height:1.45;color:#111;";
  function styleSpots(root) {
    root.querySelectorAll(".esign-spot").forEach(function (s) {
      s.style.cssText = "background:#F3E3B0;border:1px dashed " + C.gold + ";border-radius:3px;padding:0 5px;font-family:Arial,sans-serif;font-size:11.5px;color:" + C.walnut + ";";
      if (s.classList.contains("esign-sig")) s.style.background = "#FFE08A";
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  TEMPLATES PAGE
  // ═══════════════════════════════════════════════════════════
  function templatesPage(host) {
    var uploadArea = h("div");
    var list = h("div");
    var detail = h("div");
    clear(host).appendChild(uploadArea);
    host.appendChild(detail);
    host.appendChild(list);

    function drawUpload() {
      var fileIn = h("input", { type: "file", accept: ".docx,.pdf", style: "display:none;" });
      var status = h("div", { style: "font-size:12.5px;margin-top:8px;color:" + C.muted + ";" });
      var drop = h("div", {
        style: "border:2px dashed " + C.gold + ";border-radius:8px;padding:22px;text-align:center;cursor:pointer;background:#fff;",
        onclick: function () { fileIn.click(); },
      }, [
        h("div", { text: "⬆ Upload a filed document", style: "font-family:Cinzel,serif;letter-spacing:1px;color:" + C.walnut + ";font-size:14px;" }),
        h("div", { text: "Word (.docx) keeps the caption, pleading paper and fonts exactly. A PDF works too, but loses its formatting.", style: "font-size:12px;color:" + C.muted + ";margin-top:4px;" }),
      ]);
      function go(f) {
        if (!f) return;
        var fd = new FormData(); fd.append("file", f);
        status.style.color = C.muted;
        status.textContent = "Zara is reading " + f.name + " and marking the fields and signature lines… this takes up to a minute.";
        api("/templates", { method: "POST", form: fd })
          .then(function (d) { status.textContent = ""; loadList(); openTemplate(d.template.id); })
          .catch(function (e) { status.style.color = C.red; status.textContent = "Could not make a template: " + e.message; })
          .then(function () { fileIn.value = ""; });
      }
      fileIn.addEventListener("change", function () { go(fileIn.files[0]); });
      drop.addEventListener("dragover", function (e) { e.preventDefault(); });
      drop.addEventListener("drop", function (e) { e.preventDefault(); go(e.dataTransfer.files[0]); });
      clear(uploadArea).appendChild(box([drop, fileIn, status]));
    }

    function loadList() {
      clear(list).appendChild(note("Loading templates…"));
      api("/templates?all=1").then(function (d) {
        clear(list);
        list.appendChild(h("h3", { text: "Templates", style: "font-family:Cinzel,serif;color:" + C.walnut + ";letter-spacing:1px;margin:18px 0 8px;" }));
        if (!d.templates.length) { list.appendChild(note("No templates yet. Upload a document you have filed before to make the first one.")); return; }
        var table = h("table", { style: "width:100%;border-collapse:collapse;background:" + C.lit + ";border:1px solid " + C.border + ";" });
        table.appendChild(h("tr", { style: "background:" + C.walnut + ";color:" + C.lit + ";font-size:11px;letter-spacing:1px;text-align:left;" },
          ["NAME", "TYPE", "FIELDS", "SIGNERS", "STATUS"].map(function (t) { return h("th", { text: t, style: "padding:8px 10px;" }); })));
        d.templates.forEach(function (t) {
          table.appendChild(h("tr", { "data-template-row": t.id, style: "border-top:1px solid " + C.border + ";cursor:pointer;", onclick: function () { openTemplate(t.id); } }, [
            h("td", { style: "padding:8px 10px;" }, [h("div", { text: t.name, style: "font-weight:600;" }), t.description ? h("div", { text: t.description, style: "font-size:11.5px;color:" + C.muted + ";" }) : null]),
            h("td", { text: String(t.category || "").replace(/_/g, " "), style: "padding:8px 10px;font-size:12px;" }),
            h("td", { text: String((t.fields || []).length), style: "padding:8px 10px;font-size:12px;" }),
            h("td", { text: (t.signers || []).map(function (s) { return s.label; }).join(", ") || "—", style: "padding:8px 10px;font-size:12px;" }),
            h("td", { style: "padding:8px 10px;" }, [statusChip(t.status)]),
          ]));
        });
        list.appendChild(table);
      }).catch(function (e) { clear(list).appendChild(note("Templates unavailable: " + e.message, C.red)); });
    }

    function openTemplate(id) {
      clear(detail).appendChild(note("Opening…"));
      Promise.all([meta(), api("/templates/" + id), api("/templates/" + id + "/preview")]).then(function (r) {
        drawTemplate(r[0], r[1].template, r[2].html);
        detail.scrollIntoView({ behavior: "smooth", block: "start" });
      }).catch(function (e) { clear(detail).appendChild(note(e.message, C.red)); });
    }

    function drawTemplate(m, t, html) {
      var name = input(t.name);
      var cat = select(m.categories.map(function (c) { return [c, c.replace(/_/g, " ")]; }), t.category);
      var desc = input(t.description || "");
      var msg = h("div", { style: "font-size:12.5px;margin-top:8px;" });
      var sourceOpts = Object.keys(m.sources).map(function (k) { return [k, m.sources[k]]; });
      var typeOpts = m.types.map(function (x) { return [x, x]; });

      var rows = (t.fields || []).map(function (f) {
        var r = { key: f.key, label: input(f.label), source: select(sourceOpts, f.source), type: select(typeOpts, f.type),
          remove: h("input", { type: "checkbox", title: "Put the original wording back and stop asking for this" }) };
        r.tr = h("tr", { "data-field-row": f.key, style: "border-top:1px solid " + C.border + ";" }, [
          h("td", { style: "padding:6px;" }, [r.label, h("div", { text: "{{" + f.key + "}}" + (f.sample ? " · was: “" + f.sample + "”" : ""), style: "font-size:10.5px;color:" + C.muted + ";margin-top:2px;" })]),
          h("td", { style: "padding:6px;width:28%;" }, [r.source]),
          h("td", { style: "padding:6px;width:17%;" }, [r.type]),
          h("td", { style: "padding:6px;width:9%;text-align:center;" }, [r.remove]),
        ]);
        return r;
      });
      var sRows = (t.signers || []).map(function (s) { return { role: s.role, label: input(s.label) }; });

      function save() {
        msg.style.color = C.muted; msg.textContent = "Saving…";
        return api("/templates/" + t.id, { method: "PATCH", body: {
          name: name.value, category: cat.value, description: desc.value,
          fields: rows.map(function (r) { return { key: r.key, label: r.label.value, source: r.source.value, type: r.type.value, remove: r.remove.checked }; }),
          signers: sRows.map(function (s) { return { role: s.role, label: s.label.value }; }),
        } }).then(function () { msg.style.color = C.green; msg.textContent = "Saved."; loadList(); return openTemplate(t.id); })
          .catch(function (e) { msg.style.color = C.red; msg.textContent = e.message; throw e; });
      }
      function status(to) {
        save().then(function () { return api("/templates/" + t.id + "/status", { method: "POST", body: { status: to } }); })
          .then(function () { loadList(); openTemplate(t.id); })
          .catch(function (e) { msg.style.color = C.red; msg.textContent = e.message; });
      }
      var replaceIn = h("input", { type: "file", accept: ".docx", style: "display:none;" });
      replaceIn.addEventListener("change", function () {
        var f = replaceIn.files[0]; if (!f) return;
        var fd = new FormData(); fd.append("file", f);
        msg.style.color = C.muted; msg.textContent = "Uploading the edited template…";
        api("/templates/" + t.id + "/replace", { method: "POST", form: fd }).then(function () { loadList(); openTemplate(t.id); })
          .catch(function (e) { msg.style.color = C.red; msg.textContent = e.message; });
      });

      var preview = h("div", { html: html, style: PREVIEW_CSS });
      styleSpots(preview);

      var fieldsTable = h("table", { style: "width:100%;border-collapse:collapse;font-size:12.5px;" }, [
        h("tr", { style: "text-align:left;color:" + C.muted + ";font-size:11px;" },
          [h("th", { text: "Field (what the form asks)", style: "padding:4px 6px;" }), h("th", { text: "Filled from", style: "padding:4px 6px;" }),
           h("th", { text: "Type", style: "padding:4px 6px;" }), h("th", { text: "Fixed text", style: "padding:4px 6px;" })]),
      ].concat(rows.map(function (r) { return r.tr; })));

      clear(detail).appendChild(box([
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;" }, [
          h("div", {}, [h("span", { text: t.name, style: "font-family:Cinzel,serif;font-size:16px;color:" + C.walnut + ";margin-right:8px;" }), statusChip(t.status)]),
          btn("Close", function () { clear(detail); }),
        ]),
        (t.notes || []).length ? h("div", { style: "background:#FFF6DB;border:1px solid " + C.gold + ";border-radius:5px;padding:8px 10px;margin-bottom:12px;font-size:12.5px;" },
          [h("div", { text: "Zara's notes — check these:", style: "font-weight:600;margin-bottom:3px;" })].concat((t.notes || []).map(function (n) { return h("div", { text: "• " + n }); }))) : null,
        h("div", { style: "display:grid;grid-template-columns:2fr 1fr;gap:10px;" }, [field("Template name", name), field("Type", cat)]),
        field("What it is / when it is used", desc),
        h("div", { style: "display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px;align-items:start;" }, [
          h("div", {}, [
            h("div", { text: "FIELDS", style: "font-size:11px;letter-spacing:1.4px;color:" + C.muted + ";margin-bottom:4px;" }),
            rows.length ? fieldsTable : note("No fill-in fields."),
            h("div", { text: "SIGNERS", style: "font-size:11px;letter-spacing:1.4px;color:" + C.muted + ";margin:14px 0 4px;" }),
            sRows.length ? h("div", {}, sRows.map(function (s) { return field("Signs as " + s.role.replace(/_/g, " "), s.label); }))
              : note("No signature spot found. Download the template, type {{sig:client}} where the client signs (and {{date:client}} for the date), and upload it back.", C.red),
            h("div", { style: "font-size:11.5px;color:" + C.muted + ";margin-top:10px;line-height:1.5;" },
              ["To change the wording or layout: download the .docx, edit it in Word (keep the {{…}} markers), and upload it back. ",
               "Markers: {{field}}, {{field|upper}} for capitals, {{sig:client}}, {{date:client}}, {{name:client}}; roles are client, client_2, witness, attorney."]),
          ]),
          h("div", {}, [h("div", { text: "PREVIEW", style: "font-size:11px;letter-spacing:1.4px;color:" + C.muted + ";margin-bottom:4px;" }), preview]),
        ]),
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;" }, [
          btn("Save changes", function () { save().catch(function () {}); }, "primary"),
          t.status !== "active" ? btn("Activate", function () { status("active"); }, "go") : btn("Back to draft", function () { status("draft"); }),
          h("a", { href: BASE + "/templates/" + t.id + "/download", text: "Download .docx",
            style: "padding:7px 13px;border:1px solid " + C.border + ";border-radius:5px;font-size:11.5px;color:" + C.walnut + ";text-decoration:none;background:#fff;" }),
          btn("Upload edited .docx", function () { replaceIn.click(); }),
          t.status !== "archived" ? btn("Archive", function () { if (confirm("Archive this template? Documents already sent are not affected.")) status("archived"); }, "danger") : null,
          replaceIn,
        ]),
        msg,
      ]));
    }

    drawUpload();
    loadList();
    var m = location.hash.match(/^#template-(\d+)$/);
    if (m) openTemplate(m[1]);
  }

  // ═══════════════════════════════════════════════════════════
  //  CASE PAGE PANEL
  // ═══════════════════════════════════════════════════════════
  // `target` is { caseId } on a civil case page or { clientKey } on a
  // client's profile. Everything else is the same.
  function casePanel(host, target) {
    var caseId = target.caseId || null, clientKey = target.clientKey || null;
    var where = caseId ? "case_id=" + encodeURIComponent(caseId) : "client_key=" + encodeURIComponent(clientKey);
    var body = h("div");
    var form = h("div");
    var tplLink = h("span");
    clear(host).appendChild(h("div", { style: "display:flex;justify-content:space-between;align-items:center;margin:22px 0 8px;flex-wrap:wrap;gap:8px;" }, [
      h("h3", { text: "✍ DOCUMENTS FOR SIGNATURE", style: "margin:0;font-family:Cinzel,serif;font-size:14px;letter-spacing:1.5px;color:" + C.walnut + ";" }),
      h("div", { style: "display:flex;gap:8px;align-items:center;" }, [
        tplLink,
        btn("+ PREPARE DOCUMENT", function () { prepare(); }, "primary"),
      ]),
    ]));
    host.appendChild(form);
    host.appendChild(body);
    meta().then(function (m) {
      if (m.can_manage_templates) tplLink.appendChild(h("a", { href: "/admin/templates", text: "Templates →", style: "font-size:12px;color:" + C.gold + ";text-decoration:none;" }));
    }).catch(function () {});

    function load() {
      api("/packets?" + where).then(function (d) {
        clear(body);
        if (!d.packets.length) { body.appendChild(note(caseId ? "Nothing sent for signature on this matter yet." : "Nothing sent for signature for this client yet.")); return; }
        d.packets.forEach(function (p) { body.appendChild(packetCard(p)); });
      }).catch(function (e) { clear(body).appendChild(note("Unavailable: " + e.message, C.red)); });
    }

    function packetCard(p) {
      var msg = h("div", { style: "font-size:12px;margin-top:6px;" });
      function act(promise, okText) {
        msg.style.color = C.muted; msg.textContent = "Working…";
        promise.then(function (d) {
          var errs = [];
          (d.delivered ? [].concat(d.delivered) : []).forEach(function (x) { if (x && x.errors && x.errors.length) errs.push(x.name + ": " + x.errors.join("; ")); });
          msg.style.color = errs.length ? C.red : C.green;
          msg.textContent = errs.length ? "Sent, with problems — " + errs.join(" | ") + ". Use Copy link to send it yourself." : okText;
          setTimeout(load, errs.length ? 6000 : 900);
        }).catch(function (e) { msg.style.color = C.red; msg.textContent = e.message; });
      }
      var signers = p.signers.map(function (s) {
        var st = s.status === "signed" ? "✓ signed " + when(s.signed_at) + (s.typed_name && s.typed_name !== s.name ? " as “" + s.typed_name + "”" : "")
          : s.status === "declined" ? "✋ declined" + (s.decline_reason ? ": " + s.decline_reason : "")
          : s.status === "viewed" ? "opened " + when(s.viewed_at)
          : s.status === "sent" ? "sent " + when(s.sent_at) + (s.sent_via && s.sent_via !== "link" ? " by " + s.sent_via.replace("+", " & ") : " — link not emailed or texted")
          : p.status === "sent" ? "waiting for earlier signers" : "not sent yet";
        var linkBtn = h("a", { href: "#", text: "Copy link", style: "font-size:11.5px;color:" + C.gold + ";margin-left:8px;" });
        linkBtn.addEventListener("click", function (e) {
          e.preventDefault();
          api("/packets/" + p.id + "/links").then(function (d) {
            var l = d.links.filter(function (x) { return x.signer_id === s.id; })[0];
            if (l) copy(l.url, linkBtn);
          }).catch(function (err) { msg.style.color = C.red; msg.textContent = err.message; });
        });
        var canNudge = p.status === "sent" && s.status !== "signed" && s.status !== "declined" && s.sent_at;
        return h("div", { "data-signer": s.id, style: "font-size:12.5px;padding:3px 0;" }, [
          h("strong", { text: (s.label || s.role) + ": " }), s.name + (s.email ? " <" + s.email + ">" : "") + (s.phone ? " " + s.phone : "") + " — ",
          h("span", { text: st, style: "color:" + (s.status === "signed" ? C.green : s.status === "declined" ? C.red : C.muted) + ";" }),
          p.status === "sent" && s.status !== "signed" ? linkBtn : null,
          canNudge && (s.email || s.phone) ? h("a", { href: "#", text: "Remind", style: "font-size:11.5px;color:" + C.gold + ";margin-left:8px;",
            onclick: function (e) { e.preventDefault(); act(api("/signers/" + s.id + "/remind", { method: "POST", body: {} }).then(function (d) { return { delivered: d.delivered }; }), "Reminder sent."); } }) : null,
        ]);
      });
      var dl = function (which, label) {
        return h("a", { href: BASE + "/packets/" + p.id + "/download/" + which, text: label,
          style: "font-size:11.5px;padding:6px 11px;border:1px solid " + C.border + ";border-radius:5px;color:" + C.walnut + ";text-decoration:none;background:#fff;" });
      };
      return box([
        h("div", { style: "display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;" }, [
          h("div", {}, [h("span", { text: p.title, style: "font-weight:600;margin-right:8px;" }), statusChip(p.status)]),
          h("span", { text: "prepared " + when(p.created_at) + (p.created_by ? " by " + p.created_by : ""), style: "font-size:11px;color:" + C.muted + ";" }),
        ]),
        h("div", { style: "margin-top:6px;" }, signers),
        p.finalize_error ? note("Note: " + p.finalize_error, C.red) : null,
        p.dropbox_pdf ? note("Filed in Dropbox: " + p.dropbox_pdf, C.green) : null,
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center;" }, [
          p.status === "draft" ? btn("Send for signature", function () { act(api("/packets/" + p.id + "/send", { method: "POST", body: {} }), "Sent."); }, "go") : null,
          p.status === "completed" ? dl("signed-pdf", "⬇ Signed PDF") : null,
          p.status === "completed" && (p.finalize_error || !p.dropbox_pdf) ? btn("File to Dropbox again", function () {
            act(api("/packets/" + p.id + "/refile", { method: "POST", body: {} }), "Filed.");
          }) : null,
          p.status === "completed" ? dl("signed-docx", "⬇ Signed Word") : dl("unsigned", "⬇ Word (unsigned)"),
          p.status === "draft" || p.status === "sent" ? btn("Cancel", function () {
            if (confirm("Cancel this document? Signing links stop working.")) act(api("/packets/" + p.id + "/cancel", { method: "POST", body: {} }), "Cancelled.");
          }) : null,
        ]),
        msg,
      ], "padding:10px 14px;");
    }

    function prepare() {
      clear(form).appendChild(note("Loading templates…"));
      api("/templates").then(function (d) {
        var active = d.templates.filter(function (t) { return t.status === "active"; });
        clear(form);
        if (!active.length) {
          form.appendChild(box([note("No active templates yet."),
            META && META.can_manage_templates
              ? h("a", { href: "/admin/templates", text: "Make one from a filed document →", style: "color:" + C.gold + ";font-size:13px;" })
              : note("Ask an admin to add one under Admin → Document Templates.")]));
          return;
        }
        var pick = select([["", "Choose a template…"]].concat(active.map(function (t) { return [t.id, t.name + " (" + String(t.category).replace(/_/g, " ") + ")"]; })), "");
        var area = h("div");
        pick.addEventListener("change", function () { if (pick.value) fill(pick.value, area); else clear(area); });
        form.appendChild(box([
          h("div", { style: "display:flex;justify-content:space-between;align-items:center;" }, [
            h("strong", { text: "Prepare a document for signature" }), btn("Close", function () { clear(form); })]),
          h("div", { style: "margin-top:10px;" }, [field("Template", pick)]),
          area,
        ]));
      }).catch(function (e) { clear(form).appendChild(note(e.message, C.red)); });
    }

    function fill(templateId, area) {
      clear(area).appendChild(note(caseId ? "Filling it in from the matter…" : "Filling it in from the client's profile…"));
      api("/prefill?template_id=" + encodeURIComponent(templateId) + "&" + where).then(function (d) {
        var title = input(d.title);
        var inputs = d.fields.map(function (f) {
          var el = f.type === "multiline"
            ? h("textarea", { rows: "3", style: inputCss }, [f.value || ""])
            : input(f.value, { placeholder: f.type === "date" ? "e.g. October 14, 2026" : f.type === "money" ? "e.g. 5000" : "" });
          if (!f.value) el.style.borderColor = C.ember;
          return { key: f.key, el: el, label: f.label, source: f.source };
        });
        var signers = d.signers.map(function (s) {
          return { role: s.role, label: s.label, name: input(s.name), email: input(s.email, { type: "email" }), phone: input(s.phone, { type: "tel" }),
            order: select([[1, "1st"], [2, "2nd"], [3, "3rd"]], s.sign_order) };
        });
        var message = h("textarea", { rows: "2", style: inputCss, placeholder: "Optional note shown to the signers" });
        var msg = h("div", { style: "font-size:12.5px;margin-top:8px;" });

        function submit(send) {
          msg.style.color = C.muted; msg.textContent = send ? "Preparing and sending…" : "Saving…";
          var values = {};
          inputs.forEach(function (i) { values[i.key] = i.el.value; });
          api("/packets", { method: "POST", body: {
            template_id: templateId, case_id: caseId, client_key: clientKey, title: title.value, values: values, message: message.value, send: send,
            signers: signers.map(function (s) { return { role: s.role, label: s.label, name: s.name.value, email: s.email.value, phone: s.phone.value, sign_order: s.order.value }; }),
          } }).then(function (r) {
            clear(form);
            var problems = (r.delivered || []).filter(function (x) { return x.errors && x.errors.length || !x.via.length; });
            if (problems.length) {
              form.appendChild(box([
                h("strong", { text: "Sent — but some links were not emailed or texted:" }),
                h("div", {}, problems.map(function (x) {
                  var b = h("a", { href: "#", text: "Copy link", style: "color:" + C.gold + ";margin-left:8px;" });
                  b.addEventListener("click", function (e) { e.preventDefault(); copy(x.url, b); });
                  return h("div", { style: "font-size:12.5px;margin-top:4px;" }, [x.name + (x.errors.length ? " — " + x.errors.join("; ") : " — no email or phone"), b]);
                })),
                note("Send the link yourself, or open it on the office tablet to sign in person."),
                btn("OK", function () { clear(form); }),
              ]));
            }
            load();
          }).catch(function (e) { msg.style.color = C.red; msg.textContent = e.message; });
        }

        clear(area);
        area.appendChild(field("Document title (what the signers see)", title));
        if (inputs.length) {
          area.appendChild(h("div", { text: "FIELDS — filled from the " + (caseId ? "matter" : "client's profile") + " where it knows; orange ones need you", style: "font-size:11px;letter-spacing:1.2px;color:" + C.muted + ";margin:6px 0;" }));
          area.appendChild(h("div", { style: "display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0 14px;" },
            inputs.map(function (i) { return field(i.label, i.el, i.source && i.source !== "ask" ? "from: " + ((META && META.sources[i.source]) || i.source) : null); })));
        }
        area.appendChild(h("div", { text: "SIGNERS — each gets a private link. Order 1 signs first; the attorney (2nd) countersigns last.", style: "font-size:11px;letter-spacing:1.2px;color:" + C.muted + ";margin:10px 0 6px;" }));
        signers.forEach(function (s) {
          area.appendChild(h("div", { "data-prepare-signer": s.role, style: "display:grid;grid-template-columns:1.2fr 1.3fr 1fr .6fr;gap:8px;align-items:end;margin-bottom:6px;" }, [
            field(s.label + " — name", s.name), field("Email", s.email), field("Mobile (text)", s.phone), field("Order", s.order)]));
        });
        area.appendChild(note("No email or phone? Leave them blank: after sending, use Copy link, or open the link on the office tablet to sign in person."));
        area.appendChild(field("Message to signers", message));
        area.appendChild(h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;" }, [
          btn("Send for signature", function () { submit(true); }, "go"),
          btn("Save as draft", function () { submit(false); }),
        ]));
        area.appendChild(msg);
      }).catch(function (e) { clear(area).appendChild(note(e.message, C.red)); });
    }

    meta().catch(function () {});
    load();
    window.EsignAdmin.reloadCase = load;
  }

  function boot() {
    window.EsignAdmin = window.EsignAdmin || {};
    var t = document.querySelector('[data-esign="templates"]');
    if (t) templatesPage(t);
    var c = document.querySelector('[data-esign="case"]');
    if (c) casePanel(c, { caseId: c.getAttribute("data-esign-case") });
    var cl = document.querySelector('[data-esign="client"]');
    if (cl) casePanel(cl, { clientKey: cl.getAttribute("data-esign-client") });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
