/* ────────────────────────────────────────────────────────────
 * esign-prepare.js — upload a document and send it for signature.
 * TEZ Law Firm · web admin
 *
 *   [data-esign-docs]           /admin/esign — everything out for
 *                               signature, and the upload box.
 *   [data-esign-prepare="ID"]   /admin/esign/prepare/ID — who signs,
 *                               and where: the document's pages with
 *                               the fields laid over them.
 *
 * Talks to /admin/esign/api/* (the cookie twins of /api/staff/esign/*).
 * A field's place is kept as fractions of the page as it is displayed
 * (0–1 from the left and from the top), the same numbers the signing
 * page and the server's PDF stamping use.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  if (window.__esignPrepareLoaded) return;
  window.__esignPrepareLoaded = true;

  var BASE = "/admin/esign/api";
  var PDFJS = "/static/vendor/pdfjs/";
  var PDFJS_V = "4.10.38";
  var C = { charcoal: "#2B2523", ink: "#1E1B1A", ember: "#A34C00", orange: "#FF7B00", stone: "#5E5854",
            travertine: "#E8E3DC", marble: "#FAF8F5", good: "#2F6B3F", bad: "#9C2B1E" };
  // One colour per signer, so it is plain whose field is whose. Each is dark
  // enough to carry white text and distinct from its neighbours.
  var SIGNER_COLORS = ["#C2410C", "#0F766E", "#6D28D9", "#1D4ED8", "#BE185D", "#2F6B3F", "#854D0E", "#0E7490", "#7F1D1D", "#4338CA"];
  // Sizes in PDF points (1/72 inch), turned into fractions of the page they land on.
  var TYPES = {
    signature: { label: "Signature", short: "Sign", w: 170, h: 38 },
    initials: { label: "Initials", short: "Init", w: 54, h: 32 },
    date: { label: "Date signed", short: "Date", w: 84, h: 18 },
    name: { label: "Full name", short: "Name", w: 160, h: 18 },
    text: { label: "Text box", short: "Text", w: 180, h: 18 },
    checkbox: { label: "Checkbox", short: "", w: 14, h: 14 },
  };
  var TYPE_ORDER = ["signature", "initials", "date", "name", "text", "checkbox"];

  // ── helpers ────────────────────────────────────────────────
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "style") e.style.cssText = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
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
    return fetch((opts.root || BASE) + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }
  function when(v) {
    if (!v) return "";
    try { return new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return String(v); }
  }
  function copy(text, el) {
    function ok() { if (el) { var t = el.textContent; el.textContent = "Copied"; setTimeout(function () { el.textContent = t; }, 1500); } }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () { window.prompt("Copy this link:", text); });
    else window.prompt("Copy this link:", text);
  }
  function btn(label, onclick, kind) {
    return h("button", { type: "button", "class": "ep-btn" + (kind ? " " + kind : ""), onclick: onclick, text: label });
  }
  function field(label, input, hint) {
    return h("label", { "class": "ep-field" }, [h("span", { "class": "ep-label", text: label }), input, hint ? h("span", { "class": "ep-hint", text: hint }) : null]);
  }
  function input(value, attrs) {
    var a = { type: "text", value: value == null ? "" : String(value), "class": "ep-input" };
    Object.keys(attrs || {}).forEach(function (k) { a[k] = attrs[k]; });
    return h("input", a);
  }

  var styled = false;
  function styles() {
    if (styled) return; styled = true;
    var css = [
      ".ep{font-family:Montserrat,-apple-system,'Segoe UI',Arial,sans-serif;color:" + C.charcoal + ";font-size:13.5px;line-height:1.5}",
      ".ep *{box-sizing:border-box}",
      ".ep label{font-weight:400;text-transform:none;letter-spacing:0;color:inherit}",
      ".ep h2{font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:24px;margin:0 0 8px;color:" + C.charcoal + "}",
      ".ep-card{background:#fff;border:1px solid " + C.travertine + ";border-radius:4px;padding:16px 18px;margin-bottom:14px}",
      ".ep-btn{font:600 11px Montserrat,Arial,sans-serif;letter-spacing:.09em;text-transform:uppercase;padding:9px 14px;border-radius:3px;cursor:pointer;background:#fff;color:" + C.charcoal + ";border:1px solid " + C.charcoal + ";line-height:1.2}",
      ".ep-btn:hover{background:" + C.marble + "}",
      ".ep-btn.primary{background:" + C.charcoal + ";color:" + C.marble + "}",
      ".ep-btn.primary:hover{background:" + C.ink + ";box-shadow:inset 0 -3px 0 " + C.orange + "}",
      ".ep-btn.go{background:" + C.orange + ";border-color:" + C.orange + ";color:" + C.ink + "}",
      ".ep-btn.go:hover{background:#FF8D1F}",
      ".ep-btn.danger{color:" + C.bad + ";border-color:" + C.bad + "}",
      ".ep-btn.small{padding:6px 10px;font-size:10.5px}",
      ".ep-btn:disabled{opacity:.5;cursor:default;box-shadow:none}",
      ".ep-btn:focus-visible,.ep-input:focus-visible,.ep-fld:focus-visible,.ep-tool:focus-visible{outline:2px solid " + C.orange + ";outline-offset:2px}",
      ".ep-link{color:" + C.ember + ";font-weight:600;font-size:12px;cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;font-family:inherit}",
      ".ep-field{display:block;margin:0 0 10px}",
      ".ep-label{display:block;font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:" + C.stone + ";margin-bottom:4px}",
      ".ep-hint{display:block;font-size:11.5px;color:" + C.stone + ";margin-top:3px}",
      ".ep-input{width:100%;padding:8px 10px;border:1px solid #CFC8BE;border-radius:3px;font:400 13.5px Montserrat,Arial,sans-serif;color:" + C.charcoal + ";background:#fff}",
      ".ep-input:focus{outline:none;border-color:" + C.charcoal + ";box-shadow:0 0 0 3px rgba(255,123,0,.22)}",
      ".ep-msg{font-size:12.5px;margin-top:8px;min-height:1px}",
      ".ep-tag{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}",
      ".ep-tag:before{content:'';width:8px;height:8px;border-radius:50%;background:var(--dot," + C.stone + ")}",
      // the list
      ".ep-drop{border:2px dashed " + C.ember + ";border-radius:4px;padding:26px 18px;text-align:center;cursor:pointer;background:#fff}",
      ".ep-drop.over{background:#FFF3E6;border-color:" + C.orange + "}",
      ".ep-drop strong{display:block;font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:600}",
      ".ep-tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid " + C.travertine + ";margin:18px 0 12px}",
      ".ep-tab{background:none;border:0;border-bottom:3px solid transparent;padding:9px 12px;font:600 11px Montserrat,Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:" + C.stone + ";cursor:pointer}",
      ".ep-tab.on{color:" + C.charcoal + ";border-bottom-color:" + C.orange + "}",
      ".ep-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:start}",
      ".ep-title{font-weight:600;font-size:14.5px;overflow-wrap:anywhere}",
      ".ep-meta{font-size:12px;color:" + C.stone + "}",
      ".ep-signer{font-size:12.5px;padding:2px 0}",
      ".ep-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}",
      ".ep-pick{position:relative}",
      ".ep-pick-list{position:absolute;z-index:20;left:0;right:0;top:100%;background:#fff;border:1px solid #CFC8BE;border-top:0;max-height:240px;overflow:auto;box-shadow:0 6px 16px rgba(30,27,26,.16)}",
      ".ep-pick-list button{display:block;width:100%;text-align:left;padding:8px 10px;background:#fff;border:0;border-top:1px solid " + C.travertine + ";font:400 13px Montserrat,Arial,sans-serif;cursor:pointer;color:" + C.charcoal + "}",
      ".ep-pick-list button:hover{background:" + C.marble + "}",
      // the prepare page
      ".ep-prep{display:grid;grid-template-columns:304px minmax(0,1fr);gap:16px;align-items:start}",
      ".ep-side{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto;padding-right:2px}",
      ".ep-side .ep-card{padding:13px 14px;margin-bottom:10px}",
      ".ep-step{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:" + C.ember + ";margin-bottom:8px}",
      ".ep-sg{border:1px solid " + C.travertine + ";border-left:5px solid var(--sc);border-radius:3px;padding:8px 9px;margin-bottom:8px;background:" + C.marble + "}",
      ".ep-sg.on{box-shadow:0 0 0 2px var(--sc)}",
      ".ep-sg-head{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}",
      ".ep-sg-head span{flex:1}",
      ".ep-sg .ep-input{margin-bottom:5px;padding:6px 8px;font-size:13px}",
      ".ep-tools{display:grid;grid-template-columns:1fr 1fr;gap:6px}",
      ".ep-tool{font:600 11.5px Montserrat,Arial,sans-serif;padding:9px 8px;border:1px solid #CFC8BE;border-radius:3px;background:#fff;cursor:pointer;color:" + C.charcoal + ";text-align:left}",
      ".ep-tool.on{background:var(--sc);border-color:var(--sc);color:#fff}",
      ".ep-pages{background:#E4DFD8;border:1px solid " + C.travertine + ";border-radius:4px;padding:14px 14px 4px;min-height:300px}",
      ".ep-pages.arm .ep-page{cursor:crosshair}",
      ".ep-page{position:relative;background:#fff;margin:0 auto;box-shadow:0 1px 4px rgba(30,27,26,.22);width:100%;max-width:920px;user-select:none;-webkit-user-select:none;touch-action:pan-y}",
      ".ep-page>canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}",
      ".ep-num{text-align:center;font-size:11px;color:" + C.stone + ";letter-spacing:.08em;padding:6px 0 12px}",
      ".ep-fld{position:absolute;border:1.5px solid var(--sc);background:color-mix(in srgb,var(--sc) 16%,transparent);color:var(--sc);border-radius:2px;display:flex;align-items:center;justify-content:center;font:700 10px Montserrat,Arial,sans-serif;letter-spacing:.04em;cursor:move;overflow:hidden;white-space:nowrap;touch-action:none;padding:0;container-type:size}",
      // The words inside shrink with the box (a checkbox or a date line is small).
      ".ep-fld>span:first-child{font-size:clamp(6px,56cqh,10.5px);line-height:1}",
      ".ep-fld.sel{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--sc);overflow:visible;z-index:3}",
      ".ep-fld .ep-grip{position:absolute;right:-6px;bottom:-6px;width:13px;height:13px;border-radius:50%;background:var(--sc);border:2px solid #fff;cursor:nwse-resize;display:none;touch-action:none}",
      ".ep-fld.sel .ep-grip{display:block}",
      ".ep-fld .ep-x{position:absolute;right:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:" + C.charcoal + ";color:#fff;border:2px solid #fff;font:700 11px/14px Arial,sans-serif;text-align:center;cursor:pointer;display:none;padding:0}",
      ".ep-fld.sel .ep-x{display:block}",
      ".ep-warn{background:#FBEDEA;border-left:3px solid " + C.bad + ";color:" + C.bad + ";padding:8px 10px;font-size:12.5px;font-weight:500;margin-bottom:8px}",
      ".ep-ok{background:#EEF5EF;border-left:3px solid " + C.good + ";color:" + C.good + ";padding:8px 10px;font-size:12.5px;font-weight:500;margin-bottom:8px}",
      "@media (max-width:900px){.ep-prep{grid-template-columns:1fr}.ep-side{position:static;max-height:none}}",
    ].join("\n");
    document.head.appendChild(h("style", { text: css }));
  }

  var STATUS = {
    draft: ["Draft", C.stone], sent: ["Out for signature", C.orange], completed: ["Signed", C.good],
    cancelled: ["Cancelled", "#8d8780"], declined: ["Declined", C.bad],
  };
  function statusTag(s) {
    var m = STATUS[s] || [s, C.stone];
    return h("span", { "class": "ep-tag", style: "--dot:" + m[1], text: m[0] });
  }

  // ═══════════════════════════════════════════════════════════
  //  THE LIST  ( /admin/esign )
  // ═══════════════════════════════════════════════════════════
  function docsPage(host) {
    styles();
    host.className = "ep";
    var forClient = host.getAttribute("data-client") || "";
    var forCase = host.getAttribute("data-case") || "";
    var meta = null, docs = [], filter = "open";
    var uploadBox = h("div"), tabs = h("div", { "class": "ep-tabs" }), list = h("div");
    clear(host).appendChild(uploadBox); host.appendChild(tabs); host.appendChild(list);

    // ── upload ──
    function drawUpload() {
      clear(uploadBox);
      if (meta && !meta.can_write) return;
      var chosen = forClient ? { key: forClient, name: "" } : null;
      var fileIn = h("input", { type: "file", accept: "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png", style: "display:none;" });
      var status = h("div", { "class": "ep-msg" });
      var drop = h("div", { "class": "ep-drop", role: "button", tabindex: "0" }, [
        h("strong", { text: "Upload a document to send for signature" }),
        h("div", { "class": "ep-meta", text: "A PDF, or a photo or scan (JPG, PNG) — up to " + ((meta && meta.upload && meta.upload.max_mb) || 25) + " MB. Drop it here, or click to choose." }),
        h("div", { "class": "ep-meta", text: "A Word file: save it as a PDF first (File → Save As → PDF)." }),
      ]);
      function go(f) {
        if (!f) return;
        status.style.color = C.stone; status.textContent = "Uploading " + f.name + " …";
        var fd = new FormData();
        fd.append("file", f);
        if (forCase) fd.append("case_id", forCase);
        else if (chosen && chosen.key) fd.append("client_key", chosen.key);
        api("/uploads", { method: "POST", form: fd }).then(function (d) {
          window.location.href = "/admin/esign/prepare/" + d.packet.id;
        }).catch(function (e) { status.style.color = C.bad; status.textContent = e.message; fileIn.value = ""; });
      }
      drop.addEventListener("click", function () { fileIn.click(); });
      drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } });
      fileIn.addEventListener("change", function () { go(fileIn.files && fileIn.files[0]); });
      ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
      ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
      drop.addEventListener("drop", function (e) { go(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); });

      // Whose document is it? Optional: it decides where the signed copy is filed.
      var who = h("div", { style: "margin-top:12px;max-width:520px;" });
      function drawWho() {
        clear(who);
        if (forCase) { who.appendChild(h("div", { "class": "ep-meta", text: "The signed copy will be filed in this civil matter's folder." })); return; }
        if (chosen && chosen.key) {
          who.appendChild(h("div", { "class": "ep-meta" }, [
            "For client: ", h("strong", { text: chosen.name || chosen.key }), " — the signed copy is filed in their Dropbox folder.  ",
            h("button", { type: "button", "class": "ep-link", text: "Change", onclick: function () { chosen = null; forClient = ""; drawWho(); } })]));
          if (!chosen.name) {
            api("/clients/search?q=" + encodeURIComponent(chosen.key) + "&limit=5", { root: "/admin/api" }).then(function (d) {
              var hit = (d.results || []).filter(function (c) { return c.key === chosen.key; })[0];
              if (hit && chosen) { chosen.name = hit.client_name; drawWho(); }
            }).catch(function () {});
          }
          return;
        }
        var q = input("", { placeholder: "Search a client by name, A-number, phone or email", autocomplete: "off" });
        var results = h("div", { "class": "ep-pick-list", hidden: "" });
        var timer = null;
        q.addEventListener("input", function () {
          clearTimeout(timer);
          var term = q.value.trim();
          if (term.length < 2) { results.hidden = true; return; }
          timer = setTimeout(function () {
            api("/clients/search?q=" + encodeURIComponent(term) + "&limit=12", { root: "/admin/api" }).then(function (d) {
              clear(results);
              (d.results || []).forEach(function (c) {
                results.appendChild(h("button", { type: "button", text: c.client_name + (c.a_number ? "  ·  A" + String(c.a_number).replace(/^A/i, "") : ""),
                  onclick: function () { chosen = { key: c.key, name: c.client_name }; drawWho(); } }));
              });
              if (!results.firstChild) results.appendChild(h("div", { "class": "ep-meta", style: "padding:8px 10px;", text: "No client matches." }));
              results.hidden = false;
            }).catch(function () { results.hidden = true; });
          }, 220);
        });
        who.appendChild(field("File it under a client (optional)", h("div", { "class": "ep-pick" }, [q, results]),
          "Leave it empty for a document that belongs to no client: the signed copy is kept here to download, and emailed to everyone."));
      }
      drawWho();
      uploadBox.appendChild(h("div", { "class": "ep-card" }, [drop, fileIn, who, status]));
    }

    // ── list ──
    var FILTERS = [
      ["open", "Waiting", function (p) { return p.status === "sent"; }],
      ["draft", "Drafts", function (p) { return p.status === "draft"; }],
      ["completed", "Signed", function (p) { return p.status === "completed"; }],
      ["closed", "Cancelled or declined", function (p) { return p.status === "cancelled" || p.status === "declined"; }],
      ["all", "All", function () { return true; }],
    ];
    function drawTabs() {
      clear(tabs);
      FILTERS.forEach(function (f) {
        var n = docs.filter(f[2]).length;
        tabs.appendChild(h("button", { type: "button", "class": "ep-tab" + (filter === f[0] ? " on" : ""), text: f[1] + " (" + n + ")",
          onclick: function () { filter = f[0]; drawTabs(); drawList(); } }));
      });
    }
    function drawList() {
      clear(list);
      var test = FILTERS.filter(function (f) { return f[0] === filter; })[0][2];
      var rows = docs.filter(test);
      if (!rows.length) { list.appendChild(h("div", { "class": "ep-card ep-meta", text: filter === "open" ? "Nothing is waiting for a signature." : "Nothing here." })); return; }
      rows.forEach(function (p) { list.appendChild(docCard(p)); });
    }
    function load(keepFilter) {
      api("/documents").then(function (d) {
        docs = d.documents || [];
        if (!keepFilter && !docs.some(function (p) { return p.status === "sent"; })) {
          filter = docs.some(function (p) { return p.status === "draft"; }) ? "draft" : "all";
        }
        drawTabs(); drawList();
      }).catch(function (e) { clear(list).appendChild(h("div", { "class": "ep-warn", text: "Unavailable: " + e.message })); });
    }

    function docCard(p) {
      var msg = h("div", { "class": "ep-msg" });
      function act(promise, okText) {
        msg.style.color = C.stone; msg.textContent = "Working…";
        promise.then(function (d) {
          var errs = [];
          (d && d.delivered ? [].concat(d.delivered) : []).forEach(function (x) { if (x && x.errors && x.errors.length) errs.push(x.name + ": " + x.errors.join("; ")); });
          msg.style.color = errs.length ? C.bad : C.good;
          msg.textContent = errs.length ? "Done, with problems — " + errs.join(" | ") + ". Use Copy link to send it yourself." : okText;
          setTimeout(function () { load(true); }, errs.length ? 6000 : 900);
        }).catch(function (e) { msg.style.color = C.bad; msg.textContent = e.message; });
      }
      var upload = p.kind === "upload";
      var signers = (p.signers || []).map(function (s) {
        var st = s.status === "signed" ? "signed " + when(s.signed_at)
          : s.status === "declined" ? "declined" + (s.decline_reason ? ": " + s.decline_reason : "")
          : s.status === "viewed" ? "opened " + when(s.viewed_at)
          : s.status === "sent" ? "sent " + when(s.sent_at) + (s.sent_via && s.sent_via !== "link" ? " by " + s.sent_via.replace("+", " and ") : " — link not emailed or texted")
          : p.status === "sent" ? "waiting for earlier signers" : "not sent yet";
        var linkBtn = h("button", { type: "button", "class": "ep-link", style: "margin-left:8px;", text: "Copy link" });
        linkBtn.addEventListener("click", function () {
          api("/packets/" + p.id + "/links").then(function (d) {
            var l = d.links.filter(function (x) { return x.signer_id === s.id; })[0];
            if (l) copy(l.url, linkBtn);
          }).catch(function (err) { msg.style.color = C.bad; msg.textContent = err.message; });
        });
        var canNudge = p.status === "sent" && s.status !== "signed" && s.status !== "declined" && s.sent_at && (s.email || s.phone);
        return h("div", { "class": "ep-signer" }, [
          h("strong", { text: s.name }), (s.email ? " <" + s.email + ">" : "") + (s.phone ? " " + s.phone : "") + " — ",
          h("span", { text: st, style: "color:" + (s.status === "signed" ? C.good : s.status === "declined" ? C.bad : C.stone) + ";" }),
          s.delivery_error && s.status !== "signed" ? h("span", { text: " (" + s.delivery_error + ")", style: "color:" + C.bad + ";" }) : null,
          p.status === "sent" && s.status !== "signed" ? linkBtn : null,
          canNudge ? h("button", { type: "button", "class": "ep-link", style: "margin-left:8px;", text: "Remind",
            onclick: function () { act(api("/signers/" + s.id + "/remind", { method: "POST", body: {} }).then(function (d) { return { delivered: d.delivered }; }), "Reminder sent."); } }) : null,
        ]);
      });
      var dl = function (which, label) { return h("a", { "class": "ep-btn small", href: BASE + "/packets/" + p.id + "/download/" + which, text: label, style: "text-decoration:none;" }); };
      var about = [];
      if (p.client_key) about.push(h("a", { href: "/admin/clients/" + encodeURIComponent(p.client_key), text: p.client_name || "client", style: "color:" + C.ember + ";" }));
      if (p.case_id) about.push(h("a", { href: "/admin/civil/case/" + p.case_id, text: "civil matter", style: "color:" + C.ember + ";" }));
      return h("div", { "class": "ep-card", "data-doc": String(p.id) }, [
        h("div", { "class": "ep-row" }, [
          h("div", {}, [
            h("div", { "class": "ep-title", text: p.title }),
            h("div", { "class": "ep-meta" }, [
              (upload ? "Uploaded" : "From template") + " " + when(p.created_at) + (p.created_by ? " by " + p.created_by : "") +
              (upload && p.page_count ? " · " + p.page_count + " page" + (p.page_count === 1 ? "" : "s") : "") + (about.length ? " · " : "")].concat(about)),
          ]),
          statusTag(p.status),
        ]),
        signers.length ? h("div", { style: "margin-top:8px;" }, signers) : null,
        p.finalize_error ? h("div", { "class": "ep-meta", style: "color:" + C.bad + ";margin-top:6px;", text: "Note: " + p.finalize_error }) : null,
        p.dropbox_pdf ? h("div", { "class": "ep-meta", style: "color:" + C.good + ";margin-top:6px;", text: "Filed in Dropbox: " + p.dropbox_pdf }) : null,
        h("div", { "class": "ep-actions" }, [
          p.status === "draft" && upload ? h("a", { "class": "ep-btn small go", href: "/admin/esign/prepare/" + p.id, text: "Continue", style: "text-decoration:none;" }) : null,
          p.status === "draft" && !upload ? btn("Send for signature", function () { act(api("/packets/" + p.id + "/send", { method: "POST", body: {} }), "Sent."); }, "small go") : null,
          p.status === "completed" && p.has_signed_pdf ? dl("signed-pdf", "Signed PDF") : null,
          p.status === "completed" && !upload ? dl("signed-docx", "Signed Word") : null,
          p.status !== "completed" ? dl("unsigned", upload ? "Original PDF" : "Word (unsigned)") : null,
          p.status === "completed" && (p.finalize_error || (!p.dropbox_pdf && (p.client_key || p.case_id))) ? btn("File again", function () {
            act(api("/packets/" + p.id + "/refile", { method: "POST", body: {} }), "Filed.");
          }, "small") : null,
          p.status === "sent" ? btn("Cancel", function () {
            if (window.confirm("Cancel this document? The signing links stop working.")) act(api("/packets/" + p.id + "/cancel", { method: "POST", body: {} }), "Cancelled.");
          }, "small danger") : null,
          p.status === "draft" && upload ? btn("Discard", function () {
            if (window.confirm("Discard this draft? The uploaded file is removed.")) act(api("/packets/" + p.id + "/discard", { method: "POST", body: {} }), "Discarded.");
          }, "small danger") : null,
          p.status === "draft" && !upload ? btn("Cancel", function () {
            if (window.confirm("Cancel this document?")) act(api("/packets/" + p.id + "/cancel", { method: "POST", body: {} }), "Cancelled.");
          }, "small danger") : null,
        ]),
        msg,
      ]);
    }

    api("/meta").then(function (m) { meta = m; drawUpload(); }).catch(function () { drawUpload(); });
    load();
    window.EsignPrepare.reloadDocs = load;
  }

  // ═══════════════════════════════════════════════════════════
  //  PREPARE  ( /admin/esign/prepare/:id )
  // ═══════════════════════════════════════════════════════════
  var pdfLib = null;
  function loadPdfJs() {
    if (pdfLib) return pdfLib;
    pdfLib = import(PDFJS + "pdf.min.mjs?v=" + PDFJS_V).then(function (lib) {
      lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs?v=" + PDFJS_V;
      return lib;
    });
    pdfLib.catch(function () { pdfLib = null; });
    return pdfLib;
  }

  function preparePage(host) {
    styles();
    host.className = "ep";
    var id = host.getAttribute("data-esign-prepare");
    clear(host).appendChild(h("div", { "class": "ep-card ep-meta", text: "Opening the document…" }));
    Promise.all([api("/packets/" + id + "/prepare"), api("/meta").catch(function () { return {}; })]).then(function (r) {
      editor(host, r[0].packet, r[0].suggest || {}, r[1] || {});
    }).catch(function (e) {
      clear(host).appendChild(h("div", { "class": "ep-warn", text: e.message }));
      host.appendChild(h("a", { href: "/admin/esign", text: "← Documents for signature", style: "color:" + C.ember + ";" }));
    });
  }

  function editor(host, packet, suggest, meta) {
    var pages = packet.pages || [];
    var locked = packet.status !== "draft";
    var uid = 0;
    var S = { signers: [], fields: [], active: null, tool: null, sel: null, inOrder: false, dirty: false };

    // What was saved before, if this draft was opened again.
    var byRole = {};
    (packet.signers || []).slice().sort(function (a, b) { return parseInt(String(a.role).slice(1), 10) - parseInt(String(b.role).slice(1), 10); })
      .forEach(function (s) {
        var o = { uid: ++uid, name: s.name || "", email: s.email || "", phone: s.phone || "", order: s.sign_order || 1 };
        byRole[s.role] = o; S.signers.push(o);
      });
    S.inOrder = S.signers.some(function (s) { return s.order > 1; });
    (packet.fields || []).forEach(function (f) {
      if (!byRole[f.role]) return;
      S.fields.push({ uid: ++uid, type: f.type, signer: byRole[f.role].uid, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label || "" });
    });
    if (!S.signers.length) {
      var c = suggest.client;
      S.signers.push({ uid: ++uid, name: c ? c.name : "", email: c ? c.email : "", phone: c ? c.phone : "", order: 1 });
    }
    S.active = S.signers[0].uid;

    function colorOf(signerUid) {
      var i = S.signers.map(function (s) { return s.uid; }).indexOf(signerUid);
      return SIGNER_COLORS[(i < 0 ? 0 : i) % SIGNER_COLORS.length];
    }
    function signerNo(signerUid) { return S.signers.map(function (s) { return s.uid; }).indexOf(signerUid) + 1; }
    function touch() { S.dirty = true; }

    // ── layout ──
    var title = input(packet.title, { maxlength: "200" });
    var message = h("textarea", { "class": "ep-input", rows: "3", maxlength: "1000", placeholder: "Optional note the signers see in the email and above the document" });
    message.value = packet.message || "";
    var copies = h("input", { type: "checkbox" });
    copies.checked = packet.email_copies !== false;
    var signersBox = h("div"), toolsBox = h("div"), selBox = h("div"), msg = h("div", { "class": "ep-msg" }), checks = h("div");
    var pagesBox = h("div", { "class": "ep-pages" });
    title.addEventListener("input", touch); message.addEventListener("input", touch); copies.addEventListener("change", touch);

    var side = h("div", { "class": "ep-side" }, [
      h("div", { "class": "ep-card" }, [
        h("a", { href: "/admin/esign", text: "← Documents for signature", style: "color:" + C.ember + ";font-size:12px;font-weight:600;text-decoration:none;" }),
        h("div", { style: "height:8px;" }),
        field("Document title (what the signers see)", title),
        h("div", { "class": "ep-meta", text: (packet.source_filename || "document") + " · " + pages.length + " page" + (pages.length === 1 ? "" : "s") }),
      ]),
      h("div", { "class": "ep-card" }, [h("div", { "class": "ep-step", text: "1 · Who signs" }), signersBox]),
      h("div", { "class": "ep-card" }, [h("div", { "class": "ep-step", text: "2 · Where they sign" }), toolsBox, selBox]),
      h("div", { "class": "ep-card" }, [
        h("div", { "class": "ep-step", text: "3 · Send" }),
        field("Message to the signers", message),
        h("label", { style: "display:flex;gap:8px;align-items:flex-start;font-size:12.5px;margin-bottom:10px;" }, [copies, h("span", { text: "Email the signed copy to every signer and to me when it is complete" })]),
        checks,
        h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;" }, [
          btn("Send for signature", function () { save(true); }, "go"),
          btn("Save draft", function () { save(false); }),
        ]),
        msg,
      ]),
    ]);
    clear(host).appendChild(h("div", { "class": "ep-prep" }, [side, h("div", {}, [pagesBox])]));
    if (locked) {
      clear(host).appendChild(h("div", { "class": "ep-warn", text: "This document has already been " + (packet.status === "sent" ? "sent" : packet.status) + ". To change it, cancel it and upload it again." }));
      host.appendChild(h("a", { href: "/admin/esign", text: "← Documents for signature", style: "color:" + C.ember + ";" }));
      return;
    }

    // ── signers ──
    function drawSigners() {
      clear(signersBox);
      S.signers.forEach(function (s, i) {
        var name = input(s.name, { placeholder: "Full name", autocomplete: "off", "aria-label": "Signer " + (i + 1) + " name" });
        var email = input(s.email, { type: "email", placeholder: "Email", autocomplete: "off", "aria-label": "Signer " + (i + 1) + " email" });
        var phone = input(s.phone, { type: "tel", placeholder: "Mobile, to text the link (optional)", autocomplete: "off", "aria-label": "Signer " + (i + 1) + " mobile" });
        name.addEventListener("input", function () { s.name = name.value; touch(); drawChecks(); });
        email.addEventListener("input", function () { s.email = email.value; touch(); drawChecks(); });
        phone.addEventListener("input", function () { s.phone = phone.value; touch(); drawChecks(); });
        var row = h("div", { "class": "ep-sg" + (S.active === s.uid ? " on" : ""), style: "--sc:" + colorOf(s.uid), "data-signer": String(i + 1) }, [
          h("div", { "class": "ep-sg-head" }, [
            h("span", { text: "Signer " + (i + 1) + (S.inOrder ? " · signs " + ordinal(i + 1) : "") }),
            S.inOrder && i > 0 ? h("button", { type: "button", "class": "ep-link", text: "Up", "aria-label": "Move signer " + (i + 1) + " earlier", onclick: function () {
              S.signers.splice(i - 1, 0, S.signers.splice(i, 1)[0]); touch(); drawAll(); } }) : null,
            S.signers.length > 1 ? h("button", { type: "button", "class": "ep-link", text: "Remove", onclick: function () {
              var n = S.fields.filter(function (f) { return f.signer === s.uid; }).length;
              if (n && !window.confirm("Remove this signer and their " + n + " field" + (n === 1 ? "" : "s") + "?")) return;
              S.fields = S.fields.filter(function (f) { return f.signer !== s.uid; });
              S.signers.splice(i, 1);
              if (S.active === s.uid) S.active = S.signers[0].uid;
              S.sel = null; touch(); drawAll();
            } }) : null,
          ]),
          name, email, phone,
        ]);
        row.addEventListener("focusin", function () { if (S.active !== s.uid) { S.active = s.uid; markActive(); drawTools(); } });
        signersBox.appendChild(row);
      });
      var max = (meta.upload && meta.upload.max_signers) || 10;
      var me = meta.me || {};
      var hasMe = me.name && S.signers.some(function (s) { return s.name.trim().toLowerCase() === String(me.name).trim().toLowerCase(); });
      signersBox.appendChild(h("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:2px 0 8px;" }, [
        S.signers.length < max ? h("button", { type: "button", "class": "ep-link", text: "+ Add a signer", onclick: function () {
          var s = { uid: ++uid, name: "", email: "", phone: "", order: 1 }; S.signers.push(s); S.active = s.uid; touch(); drawAll(); } }) : null,
        S.signers.length < max && me.name && !hasMe ? h("button", { type: "button", "class": "ep-link", text: "+ Add me", onclick: function () {
          var blank = S.signers.filter(function (x) { return !x.name.trim() && !x.email.trim(); })[0];
          var s = blank || { uid: ++uid, name: "", email: "", phone: "", order: 1 };
          s.name = me.name; s.email = me.email || "";
          if (!blank) S.signers.push(s);
          S.active = s.uid; touch(); drawAll(); } }) : null,
      ]));
      if (S.signers.length > 1) {
        var ord = h("input", { type: "checkbox" });
        ord.checked = S.inOrder;
        ord.addEventListener("change", function () { S.inOrder = ord.checked; touch(); drawSigners(); });
        signersBox.appendChild(h("label", { style: "display:flex;gap:8px;align-items:flex-start;font-size:12.5px;" }, [ord,
          h("span", { text: "Sign in this order — each person gets the link when the one before has signed" })]));
      }
    }
    function ordinal(n) { return n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"); }
    function markActive() {
      [].forEach.call(signersBox.querySelectorAll(".ep-sg"), function (el, i) {
        el.className = "ep-sg" + (S.signers[i] && S.signers[i].uid === S.active ? " on" : "");
      });
    }

    // ── tools ──
    function drawTools() {
      clear(toolsBox);
      var a = S.signers.filter(function (s) { return s.uid === S.active; })[0] || S.signers[0];
      toolsBox.appendChild(h("div", { "class": "ep-meta", style: "margin-bottom:8px;" }, [
        "Placing fields for ", h("strong", { text: a.name.trim() || "Signer " + signerNo(a.uid), style: "color:" + colorOf(a.uid) + ";" }),
        S.signers.length > 1 ? " — click a signer above to switch." : "."]));
      var grid = h("div", { "class": "ep-tools", style: "--sc:" + colorOf(a.uid) });
      TYPE_ORDER.forEach(function (type) {
        grid.appendChild(h("button", { type: "button", "class": "ep-tool" + (S.tool === type ? " on" : ""), "data-tool": type, text: TYPES[type].label,
          "aria-pressed": S.tool === type ? "true" : "false",
          onclick: function () { S.tool = S.tool === type ? null : type; drawTools(); } }));
      });
      toolsBox.appendChild(grid);
      toolsBox.appendChild(h("div", { "class": "ep-hint", style: "margin-top:8px;", text: S.tool
        ? "Click on the page where the " + TYPES[S.tool].label.toLowerCase() + " goes. Click again for another; press Esc when done."
        : "Choose a field, then click on the page. Drag a field to move it; drag its corner to resize." }));
      pagesBox.className = "ep-pages" + (S.tool ? " arm" : "");
    }

    // ── the selected field ──
    function drawSel() {
      clear(selBox);
      var f = S.fields.filter(function (x) { return x.uid === S.sel; })[0];
      if (!f) return;
      var whose = h("select", { "class": "ep-input", "aria-label": "Field belongs to" });
      S.signers.forEach(function (s, i) {
        var o = h("option", { value: String(s.uid), text: s.name.trim() || "Signer " + (i + 1) });
        if (s.uid === f.signer) o.selected = true;
        whose.appendChild(o);
      });
      whose.addEventListener("change", function () { f.signer = Number(whose.value); touch(); drawFields(); drawChecks(); });
      var kids = [h("div", { "class": "ep-step", style: "margin-top:14px;", text: "Selected: " + TYPES[f.type].label + " · page " + (f.page + 1) }), field("Belongs to", whose)];
      if (f.type === "text") {
        var label = input(f.label, { maxlength: "60", placeholder: "e.g. Address, Title, Date of birth" });
        label.addEventListener("input", function () { f.label = label.value; touch(); drawFields(); });
        kids.push(field("What to fill in (shown to the signer)", label));
      }
      if (f.type === "text" || f.type === "checkbox") {
        var req = h("input", { type: "checkbox" });
        req.checked = !!f.required;
        req.addEventListener("change", function () { f.required = req.checked; touch(); });
        kids.push(h("label", { style: "display:flex;gap:8px;align-items:center;font-size:12.5px;margin-bottom:10px;" }, [req, h("span", { text: f.type === "text" ? "Required" : "Must be ticked" })]));
      }
      kids.push(h("div", { style: "display:flex;gap:12px;flex-wrap:wrap;" }, [
        pages.length > 1 ? h("button", { type: "button", "class": "ep-link", text: "Copy to every page", onclick: function () {
          pages.forEach(function (_, i) {
            if (i === f.page) return;
            if (S.fields.some(function (x) { return x.page === i && x.type === f.type && x.signer === f.signer && Math.abs(x.x - f.x) < 0.01 && Math.abs(x.y - f.y) < 0.01; })) return;
            S.fields.push({ uid: ++uid, type: f.type, signer: f.signer, page: i, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label });
          });
          touch(); drawFields(); drawChecks();
        } }) : null,
        h("button", { type: "button", "class": "ep-link", style: "color:" + C.bad + ";", text: "Delete field", onclick: function () { remove(f.uid); } }),
      ]));
      kids.forEach(function (k) { selBox.appendChild(k); });
    }
    function remove(fieldUid) {
      S.fields = S.fields.filter(function (x) { return x.uid !== fieldUid; });
      if (S.sel === fieldUid) S.sel = null;
      touch(); drawFields(); drawSel(); drawChecks();
    }

    // ── what still stands in the way of sending ──
    function problems() {
      var out = [];
      S.signers.forEach(function (s, i) {
        var who = s.name.trim() || "Signer " + (i + 1);
        if (s.name.trim().length < 2) out.push("Signer " + (i + 1) + " needs a name.");
        if (s.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email.trim())) out.push(who + ": the email address does not look right.");
        if (!S.fields.some(function (f) { return f.signer === s.uid && f.type === "signature"; })) out.push(who + " has no signature field yet.");
      });
      return out;
    }
    function drawChecks() {
      clear(checks);
      var p = problems();
      p.forEach(function (t) { checks.appendChild(h("div", { "class": "ep-warn", text: t })); });
      if (!p.length) {
        S.signers.forEach(function (s) {
          if (!s.email.trim() && !s.phone.trim()) checks.appendChild(h("div", { "class": "ep-meta", style: "margin-bottom:8px;",
            text: s.name.trim() + " has no email or mobile: after sending, copy their link and hand it over yourself, or open it on the office tablet." }));
        });
      }
    }

    // ── pages and fields ──
    var pageEls = pages.map(function (pg, i) {
      var cv = h("canvas", { "aria-label": "Page " + (i + 1) });
      var el = h("div", { "class": "ep-page", "data-page": String(i), style: "aspect-ratio:" + pg.w + " / " + pg.h + ";" }, [cv]);
      pagesBox.appendChild(el);
      pagesBox.appendChild(h("div", { "class": "ep-num", text: "Page " + (i + 1) + " of " + pages.length }));
      el.addEventListener("click", function (e) {
        if (e.target !== el && e.target !== cv) return;       // a click on a field is that field's
        if (!S.tool) { if (S.sel) { S.sel = null; drawFields(); drawSel(); } return; }
        var r = el.getBoundingClientRect(), t = TYPES[S.tool];
        var w = Math.min(0.9, t.w / pg.w), hh = Math.min(0.5, t.h / pg.h);
        var x = (e.clientX - r.left) / r.width - w / 2, y = (e.clientY - r.top) / r.height - hh / 2;
        var f = { uid: ++uid, type: S.tool, signer: S.active, page: i, x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - hh), w: w, h: hh,
          required: S.tool !== "checkbox", label: "" };
        S.fields.push(f); S.sel = f.uid;
        touch(); drawFields(); drawSel(); drawChecks();
      });
      return { el: el, canvas: cv, drawn: false };
    });
    function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

    function drawFields() {
      pageEls.forEach(function (p) { [].slice.call(p.el.querySelectorAll(".ep-fld")).forEach(function (n) { p.el.removeChild(n); }); });
      S.fields.forEach(function (f) {
        var p = pageEls[f.page];
        if (!p) return;
        var t = TYPES[f.type];
        var el = h("div", { "class": "ep-fld" + (S.sel === f.uid ? " sel" : ""), tabindex: "0", role: "button", "data-field": String(f.uid), "data-type": f.type,
          "aria-label": t.label + " for signer " + signerNo(f.signer) + ", page " + (f.page + 1),
          style: "--sc:" + colorOf(f.signer) + ";left:" + (f.x * 100) + "%;top:" + (f.y * 100) + "%;width:" + (f.w * 100) + "%;height:" + (f.h * 100) + "%;" });
        el.appendChild(h("span", { text: f.type === "checkbox" ? "" : (f.type === "text" && f.label ? f.label : t.short) + (S.signers.length > 1 ? " · " + signerNo(f.signer) : "") }));
        var grip = h("span", { "class": "ep-grip", "aria-hidden": "true" });
        var x = h("button", { type: "button", "class": "ep-x", "aria-label": "Delete field", text: "×" });
        x.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
        x.addEventListener("click", function (e) { e.stopPropagation(); remove(f.uid); });
        el.appendChild(grip); el.appendChild(x);
        drag(el, grip, f, p.el);
        el.addEventListener("keydown", function (e) {
          var step = e.shiftKey ? 0.01 : 0.002;
          if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(f.uid); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); f.x = clamp(f.x - step, 0, 1 - f.w); place(el, f); touch(); }
          else if (e.key === "ArrowRight") { e.preventDefault(); f.x = clamp(f.x + step, 0, 1 - f.w); place(el, f); touch(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); f.y = clamp(f.y - step, 0, 1 - f.h); place(el, f); touch(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); f.y = clamp(f.y + step, 0, 1 - f.h); place(el, f); touch(); }
        });
        el.addEventListener("focus", function () { select(f.uid, el); });
        p.el.appendChild(el);
      });
    }
    function place(el, f) {
      el.style.left = (f.x * 100) + "%"; el.style.top = (f.y * 100) + "%";
      el.style.width = (f.w * 100) + "%"; el.style.height = (f.h * 100) + "%";
    }
    function select(fieldUid, el) {
      if (S.sel === fieldUid) return;
      S.sel = fieldUid;
      [].forEach.call(pagesBox.querySelectorAll(".ep-fld.sel"), function (n) { n.classList.remove("sel"); });
      if (el) el.classList.add("sel");
      drawSel();
    }
    // Move with the body, resize with the corner. Pointer events: mouse, pen and finger alike.
    function drag(el, grip, f, pageEl) {
      function start(e, resizing) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        select(f.uid, el);
        var r = pageEl.getBoundingClientRect();
        var sx = e.clientX, sy = e.clientY, ox = f.x, oy = f.y, ow = f.w, oh = f.h, moved = false;
        function move(ev) {
          var dx = (ev.clientX - sx) / r.width, dy = (ev.clientY - sy) / r.height;
          if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 2) moved = true;
          if (resizing) { f.w = clamp(ow + dx, 0.012, 1 - f.x); f.h = clamp(oh + dy, 0.008, 1 - f.y); }
          else { f.x = clamp(ox + dx, 0, 1 - f.w); f.y = clamp(oy + dy, 0, 1 - f.h); }
          place(el, f);
        }
        function end() {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
          if (moved) touch();
        }
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
      }
      el.addEventListener("pointerdown", function (e) { start(e, false); });
      grip.addEventListener("pointerdown", function (e) { start(e, true); });
      el.addEventListener("click", function (e) { e.stopPropagation(); });
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && S.tool) { S.tool = null; drawTools(); }
    });
    window.addEventListener("beforeunload", function (e) { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

    function drawAll() { drawSigners(); drawTools(); drawFields(); drawSel(); drawChecks(); }
    drawAll();
    S.dirty = false;

    // ── the document itself ──
    loadPdfJs().then(function (lib) {
      return lib.getDocument({ url: BASE + "/packets/" + packet.id + "/pdf", cMapUrl: PDFJS + "cmaps/", cMapPacked: true,
        standardFontDataUrl: PDFJS + "standard_fonts/", isEvalSupported: false }).promise;
    }).then(function (pdf) {
      function paint(i) {
        var p = pageEls[i];
        if (!p || p.drawn) return;
        p.drawn = true;
        pdf.getPage(i + 1).then(function (page) {
          var cssW = p.el.clientWidth || 800;
          var base = page.getViewport({ scale: 1 });
          var scale = Math.min(2400, cssW * Math.min(2, window.devicePixelRatio || 1)) / base.width;
          var vp = page.getViewport({ scale: scale });
          p.canvas.width = Math.round(vp.width); p.canvas.height = Math.round(vp.height);
          return page.render({ canvasContext: p.canvas.getContext("2d"), viewport: vp }).promise;
        }).catch(function () { p.drawn = false; });
      }
      if (window.IntersectionObserver) {
        var io = new window.IntersectionObserver(function (entries) {
          entries.forEach(function (en) { if (en.isIntersecting) paint(Number(en.target.getAttribute("data-page"))); });
        }, { rootMargin: "800px 0px" });
        pageEls.forEach(function (p) { io.observe(p.el); });
      } else pageEls.forEach(function (_, i) { paint(i); });
    }).catch(function (e) {
      pagesBox.insertBefore(h("div", { "class": "ep-warn", text: "The pages could not be drawn in this browser (" + (e && e.message ? e.message : "unknown error") + "). Use a current Chrome, Safari or Edge." }), pagesBox.firstChild);
    });

    // ── save / send ──
    function payload(send) {
      var index = {};
      S.signers.forEach(function (s, i) { index[s.uid] = i; });
      return {
        title: title.value.trim(), message: message.value.trim(), email_copies: copies.checked, send: !!send,
        signers: S.signers.map(function (s, i) { return { name: s.name.trim(), email: s.email.trim(), phone: s.phone.trim(), sign_order: S.inOrder ? i + 1 : 1 }; }),
        fields: S.fields.map(function (f) { return { type: f.type, signer: index[f.signer], page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label }; }),
      };
    }
    var busy = false;
    function save(send) {
      if (busy) return;
      var p = problems();
      if (send && p.length) { msg.style.color = C.bad; msg.textContent = p[0]; return; }
      if (!send && S.signers.some(function (s) { return s.name.trim().length < 2; })) { msg.style.color = C.bad; msg.textContent = "Give every signer a name before saving."; return; }
      busy = true;
      msg.style.color = C.stone; msg.textContent = send ? "Sending…" : "Saving…";
      api("/packets/" + packet.id + "/prepare", { method: "POST", body: payload(send) }).then(function (r) {
        busy = false; S.dirty = false;
        if (!send) { msg.style.color = C.good; msg.textContent = "Draft saved."; return; }
        sentView(r);
      }).catch(function (e) { busy = false; msg.style.color = C.bad; msg.textContent = e.message; });
    }
    function sentView(r) {
      var delivered = r.delivered || [];
      var later = (r.packet.signers || []).filter(function (s) { return !delivered.some(function (d) { return d.signer_id === s.id; }); });
      var box = h("div", { "class": "ep-card", style: "max-width:720px;" }, [
        h("h2", { text: "Sent for signature" }),
        h("div", { "class": "ep-meta", style: "margin-bottom:10px;", text: r.packet.title }),
      ]);
      delivered.forEach(function (x) {
        var bad = (x.errors && x.errors.length) || !x.via.length;
        var b = h("button", { type: "button", "class": "ep-link", style: "margin-left:8px;", text: "Copy link" });
        b.addEventListener("click", function () { copy(x.url, b); });
        box.appendChild(h("div", { "class": bad ? "ep-warn" : "ep-ok" }, [
          x.name + " — " + (x.via.length ? "link sent by " + x.via.join(" and ").replace("sms", "text") : "link not emailed or texted") +
          (x.errors && x.errors.length ? " (" + x.errors.join("; ") + ")" : ""), b]));
      });
      if (later.length) box.appendChild(h("div", { "class": "ep-meta", style: "margin-bottom:10px;",
        text: later.map(function (s) { return s.name; }).join(", ") + " will get the link when the earlier signer" + (delivered.length === 1 ? " has" : "s have") + " signed." }));
      box.appendChild(h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;" }, [
        h("a", { "class": "ep-btn primary", href: "/admin/esign", text: "Documents for signature", style: "text-decoration:none;" }),
        packet.client_key ? h("a", { "class": "ep-btn", href: "/admin/clients/" + encodeURIComponent(packet.client_key), text: "Back to the client", style: "text-decoration:none;" }) : null,
      ]));
      clear(host).appendChild(box);
      window.scrollTo(0, 0);
    }
    window.EsignPrepare.state = function () { return payload(false); };
  }

  function boot() {
    window.EsignPrepare = window.EsignPrepare || {};
    var d = document.querySelector("[data-esign-docs]");
    if (d) docsPage(d);
    var p = document.querySelector("[data-esign-prepare]");
    if (p) preparePage(p);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
