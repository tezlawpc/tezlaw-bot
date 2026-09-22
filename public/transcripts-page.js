/* ────────────────────────────────────────────────────────────
 * transcripts-page.js — saved voice transcripts.
 *
 *   [data-transcripts="list"]    the Transcripts page: search, unassigned
 *   [data-transcripts="view"]    one transcript, speaker by speaker, with
 *                                names to correct, Word/text download,
 *                                Dropbox copy, assign to a client
 *   [data-transcripts="client"]  panel on a client's profile
 *   [data-transcripts="note"]    panel on a hearing note
 *
 * Talks to /admin/transcripts/api/*. Safe to include more than once.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  if (window.TezTranscripts) { window.TezTranscripts.mount(); return; }
  var API = "/admin/transcripts/api";
  var C = { walnut: "#3E2818", mid: "#5A3B22", gold: "#B8891E", ember: "#F07800", red: "#A02818",
    lit: "#FBF3DE", border: "#D4C4A0", muted: "#7B5330", green: "#166534" };
  var PALETTE = ["#1d4ed8", "#b45309", "#047857", "#7c3aed", "#be123c", "#0e7490", "#4d7c0f", "#9d174d"];

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
        if (!r.ok || d.ok === false) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  }
  function btn(label, fn, kind) {
    var dark = kind === "primary";
    return h("button", { type: "button", text: label, onclick: fn,
      style: "padding:6px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-family:Cinzel,Georgia,serif;letter-spacing:.5px;" +
             "background:" + (kind === "danger" ? "#fff" : dark ? C.mid : C.lit) + ";color:" + (kind === "danger" ? C.red : dark ? C.lit : C.walnut) +
             ";border:1px solid " + (kind === "danger" ? C.red : dark ? C.gold : C.border) + ";" });
  }
  function when(v) { try { return v ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : ""; } catch (e) { return ""; } }
  function clock(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0)), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return (hh ? hh + ":" + pad(m) : m) + ":" + pad(r);
  }
  function mins(sec) { var m = Math.round((Number(sec) || 0) / 60); return m ? m + " min" : (sec ? "<1 min" : ""); }
  function noteHref(t) { return t.note_id ? (t.note_type === "individual" ? "/admin/hearing/individual/" : "/admin/hearing/notes/") + t.note_id : null; }
  function note(msg, bad) { return h("div", { text: msg, style: "font-size:12.5px;color:" + (bad ? C.red : C.muted) + ";margin:6px 0;" }); }

  // One row in a list.
  function row(t, showClient) {
    var meta = [when(t.created_at), mins(t.duration_sec), t.parts > 1 ? t.parts + " parts" : null,
      t.diarized ? (t.speakers.length + " speaker" + (t.speakers.length === 1 ? "" : "s") + (t.speakers.length ? ": " + t.speakers.slice(0, 4).join(", ") + (t.speakers.length > 4 ? "…" : "") : "")) : "one voice track",
      t.created_by ? "by " + t.created_by : null].filter(Boolean).join(" · ");
    return h("a", { href: "/admin/transcripts/" + t.id,
      style: "display:block;text-decoration:none;color:inherit;border:1px solid " + C.border + ";border-radius:6px;padding:9px 12px;margin:6px 0;background:#fff;" }, [
      h("div", { style: "display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;" }, [
        h("strong", { text: t.title || ("Transcript #" + t.id), style: "color:" + C.walnut + ";font-size:13.5px;" }),
        showClient ? h("span", { text: t.client_name ? t.client_name + (t.a_number ? " · " + t.a_number : "") : "Not assigned to a client",
          style: "font-size:12px;color:" + (t.client_name ? C.mid : C.ember) + ";" }) : null,
      ]),
      h("div", { text: meta, style: "font-size:11.5px;color:" + C.muted + ";margin-top:2px;" }),
      t.preview ? h("div", { text: t.preview + (t.preview.length >= 220 ? "…" : ""), style: "font-size:12px;color:#444;margin-top:4px;white-space:pre-wrap;max-height:3.2em;overflow:hidden;" }) : null,
    ]);
  }

  // ── Panels (client profile, hearing note) ─────────────────
  function panel(host) {
    var kind = host.getAttribute("data-transcripts");
    var path = kind === "client" ? "/for-client/" + encodeURIComponent(host.getAttribute("data-client-key"))
      : "/for-note/" + encodeURIComponent(host.getAttribute("data-note-type")) + "/" + encodeURIComponent(host.getAttribute("data-note-id"));
    function draw() {
      api(path).then(function (d) {
        clear(host);
        var list = d.transcripts || [];
        if (kind === "note" && !list.length) return;   // nothing to show on a note with no recordings
        host.appendChild(h("h3", { text: "🎙️ Transcripts" + (list.length ? " (" + list.length + ")" : ""),
          style: "font-family:Cinzel,serif;color:" + C.walnut + ";margin:12px 0 4px;font-size:15px;" }));
        if (!list.length) host.appendChild(note("No voice recordings for this client yet. Dictations and hearing recordings are saved here automatically."));
        list.forEach(function (t) { host.appendChild(row(t, false)); });
      }).catch(function (e) { clear(host); if (kind !== "note") host.appendChild(note("Transcripts could not be loaded: " + e.message, true)); });
    }
    host._draw = draw;
    draw();
  }

  // ── The Transcripts page ──────────────────────────────────
  function listPage(host) {
    var q = h("input", { type: "search", placeholder: "Search client, A-number, or words said…",
      style: "flex:1;min-width:220px;padding:8px 10px;border:1px solid " + C.border + ";border-radius:5px;font-size:13px;" });
    var un = h("input", { type: "checkbox", id: "tx-unassigned" });
    var box = h("div");
    host.appendChild(h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;" }, [
      q, h("label", { for: "tx-unassigned", style: "font-size:12.5px;color:" + C.mid + ";display:flex;gap:4px;align-items:center;" }, [un, "Not assigned to a client"]),
    ]));
    host.appendChild(box);
    var timer = null;
    function load() {
      api("/list?q=" + encodeURIComponent(q.value.trim()) + (un.checked ? "&unassigned=1" : "")).then(function (d) {
        clear(box);
        if (!d.transcripts.length) box.appendChild(note(q.value || un.checked ? "Nothing matches." : "No transcripts yet. Every voice dictation and hearing recording will appear here."));
        d.transcripts.forEach(function (t) { box.appendChild(row(t, true)); });
      }).catch(function (e) { clear(box).appendChild(note(e.message, true)); });
    }
    q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(load, 300); });
    un.addEventListener("change", load);
    load();
  }

  // ── One transcript ────────────────────────────────────────
  function viewPage(host) {
    var id = host.getAttribute("data-id");
    var state = { t: null, canDelete: false, find: "" };
    var head = h("div"), tools = h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;" }),
      msg = h("div"), assignBox = h("div"), speakersBox = h("div"), findBox = h("div", { style: "margin:10px 0;" }), body = h("div");
    [head, tools, msg, assignBox, speakersBox, findBox, body].forEach(function (x) { host.appendChild(x); });

    function say(text, bad) { clear(msg); if (text) msg.appendChild(note(text, bad)); }
    function colorOf(name) {
      var names = state.t.speakers || [];
      var i = names.indexOf(name);
      return i < 0 ? "#555" : PALETTE[i % PALETTE.length];
    }
    function load() {
      return api("/" + id).then(function (d) { state.t = d.transcript; state.canDelete = !!d.can_delete; state.canEdit = !!d.can_edit; draw(); })
        .catch(function (e) { clear(host).appendChild(note(e.message, true)); });
    }
    function draw() {
      var t = state.t;
      clear(head);
      var title = h("h1", { text: t.title || ("Transcript #" + t.id), style: "font-family:Cinzel,serif;color:" + C.walnut + ";margin:0 0 4px;font-size:22px;" });
      var rename = h("a", { href: "#", text: "rename", style: "font-size:11.5px;color:" + C.muted + ";margin-left:8px;", onclick: function (ev) {
        ev.preventDefault();
        var v = window.prompt("Title for this transcript:", t.title || "");
        if (v && v.trim()) api("/" + id + "/title", { method: "POST", body: { title: v.trim() } }).then(function (d) { state.t = d.transcript; draw(); }).catch(function (e) { say(e.message, true); });
      } });
      head.appendChild(h("div", { style: "display:flex;align-items:baseline;flex-wrap:wrap;" }, [title, state.canEdit ? rename : null]));
      var nh = noteHref(t);
      head.appendChild(h("div", { style: "font-size:12.5px;color:" + C.mid + ";" }, [
        t.client_name ? h("span", {}, [h("strong", { text: t.client_name }), t.a_number ? " · A# " + t.a_number : ""]) : h("span", { text: "Not assigned to a client", style: "color:" + C.ember + ";font-weight:600;" }),
        " · " + when(t.created_at), t.duration_sec ? " · " + clock(t.duration_sec) : "", t.created_by ? " · recorded by " + t.created_by : "",
        nh ? h("span", {}, [" · ", h("a", { href: nh, text: "open the hearing note", style: "color:" + C.muted + ";" })]) : "",
      ]));
      head.appendChild(h("div", { style: "font-size:11.5px;color:" + C.muted + ";font-style:italic;margin-top:4px;" }, [
        t.diarized ? "Speakers were separated automatically and named by Zara — check the names before relying on them." : "This recording was transcribed as a single voice track (speakers not separated).",
        " Machine transcript: verify against the recording before quoting it.",
      ]));

      clear(tools);
      var word = h("a", { href: API + "/" + id + "/download.docx", text: "⬇ Word" });
      tools.appendChild(word);
      word.style.cssText = "padding:6px 12px;border-radius:5px;font-size:12px;font-family:Cinzel,Georgia,serif;background:" + C.mid + ";color:" + C.lit + ";border:1px solid " + C.gold + ";text-decoration:none;";
      var txt = h("a", { href: API + "/" + id + "/download.txt", text: "⬇ Text" });
      txt.style.cssText = "padding:6px 12px;border-radius:5px;font-size:12px;font-family:Cinzel,Georgia,serif;background:" + C.lit + ";color:" + C.walnut + ";border:1px solid " + C.border + ";text-decoration:none;";
      tools.appendChild(txt);
      if (state.canEdit && (t.client_key || t.client_name)) tools.appendChild(btn(t.dropbox_path ? "↻ Update Dropbox copy" : "Save to client's Dropbox", function () {
        say("Saving to Dropbox…");
        api("/" + id + "/dropbox", { method: "POST" }).then(function (d) { say("Saved: " + d.path); state.t.dropbox_path = d.path; state.t.dropbox_error = null; draw(); })
          .catch(function (e) { say(e.message, true); });
      }));
      if (state.canEdit && t.diarized) tools.appendChild(btn("✨ Zara: name speakers", function () {
        var all = t.speaker_keys.some(function (k) { return k.named; }) && window.confirm("Rename every speaker? OK = Zara names all of them again. Cancel = only the unnamed ones.");
        say("Zara is reading the transcript…");
        api("/" + id + "/name-speakers", { method: "POST", body: { all: !!all } }).then(function (d) { state.t = d.transcript; say(""); draw(); }).catch(function (e) { say(e.message, true); });
      }));
      if (state.canDelete) tools.appendChild(btn("Delete", function () {
        if (!window.confirm("Delete this transcript permanently? A Dropbox copy, if any, stays in Dropbox.")) return;
        api("/" + id, { method: "DELETE" }).then(function () { location.href = "/admin/transcripts"; }).catch(function (e) { say(e.message, true); });
      }, "danger"));
      if (t.dropbox_path) tools.appendChild(h("span", { text: "In Dropbox: " + t.dropbox_path, style: "font-size:11.5px;color:" + C.green + ";align-self:center;" }));
      else if (t.dropbox_error) tools.appendChild(h("span", { text: "Dropbox: " + t.dropbox_error, style: "font-size:11.5px;color:" + C.ember + ";align-self:center;" }));

      drawAssign();
      drawSpeakers();
      drawFind();
      drawBody();
    }

    function drawAssign() {
      var t = state.t;
      clear(assignBox);
      if (t.client_key || t.client_name || !state.canEdit) return;
      var inp = h("input", { type: "search", placeholder: "Assign to a client: type a name or A-number…",
        style: "width:100%;max-width:420px;padding:7px 9px;border:1px solid " + C.ember + ";border-radius:5px;font-size:13px;" });
      var hits = h("div");
      var tm = null;
      inp.addEventListener("input", function () {
        clearTimeout(tm);
        tm = setTimeout(function () {
          api("/clients?q=" + encodeURIComponent(inp.value.trim())).then(function (d) {
            clear(hits);
            d.clients.forEach(function (c) {
              hits.appendChild(btn(c.name + (c.a_number ? " · " + c.a_number : ""), function () {
                api("/" + id + "/client", { method: "POST", body: { client_key: c.key } }).then(function (r) { state.t = r.transcript; say("Assigned to " + c.name + ". A Word copy goes to the client's Dropbox Transcripts folder." + (r.note ? " " + r.note : "")); draw(); })
                  .catch(function (e) { say(e.message, true); });
              }));
            });
          }).catch(function () { /* typing */ });
        }, 250);
      });
      assignBox.appendChild(h("div", { style: "margin:8px 0;padding:10px;border:1px dashed " + C.ember + ";border-radius:6px;background:#fff8ef;" }, [inp, h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;" }, [hits])]));
    }

    function drawSpeakers() {
      var t = state.t;
      clear(speakersBox);
      if (!t.diarized || !t.speaker_keys.length) return;
      var inputs = {};
      var grid = h("div", { style: "display:flex;gap:8px;flex-wrap:wrap;" });
      // One box per distinct name; editing it renames every key that shares it.
      var groups = {};
      t.speaker_keys.forEach(function (k) { (groups[k.name] = groups[k.name] || []).push(k.key); });
      Object.keys(groups).forEach(function (name) {
        var inp = h("input", { type: "text", value: name, style: "width:190px;padding:5px 7px;border:1px solid " + C.border + ";border-left:5px solid " + colorOf(name) + ";border-radius:4px;font-size:12.5px;" });
        inputs[name] = inp;
        grid.appendChild(inp);
      });
      speakersBox.appendChild(h("details", { style: "margin:8px 0;background:" + C.lit + ";border:1px solid " + C.border + ";border-radius:6px;padding:8px 12px;" }, [
        h("summary", { text: "Speakers (" + Object.keys(groups).length + ") — correct a name here", style: "cursor:pointer;font-size:12.5px;color:" + C.walnut + ";font-weight:600;" }),
        h("div", { style: "margin-top:8px;" }, [grid]),
        h("div", { style: "font-size:11px;color:" + C.muted + ";margin:6px 0;" }, ["Type the same name in two boxes to merge them (the model sometimes hears one person as two). Clear a box to go back to \"Speaker N\"."]),
        !state.canEdit ? h("div", { text: "Only an attorney can change names.", style: "font-size:11.5px;color:" + C.muted + ";" }) : btn("Save names", function () {
          var map = {};
          Object.keys(groups).forEach(function (name) { groups[name].forEach(function (k) { map[k] = inputs[name].value.trim(); }); });
          api("/" + id + "/speakers", { method: "POST", body: { speakers: map } }).then(function (d) { state.t = d.transcript; say("Names saved."); draw(); }).catch(function (e) { say(e.message, true); });
        }, "primary"),
      ]));
    }

    function drawFind() {
      clear(findBox);
      var inp = h("input", { type: "search", value: state.find, placeholder: "Find in this transcript…",
        style: "width:100%;max-width:340px;padding:6px 9px;border:1px solid " + C.border + ";border-radius:5px;font-size:12.5px;" });
      var only = h("select", { style: "margin-left:6px;padding:5px;border:1px solid " + C.border + ";border-radius:5px;font-size:12.5px;" },
        [h("option", { value: "", text: "Everyone" })].concat((state.t.speakers || []).map(function (n) { return h("option", { value: n, text: n }); })));
      only.value = state.only || "";
      inp.addEventListener("input", function () { state.find = inp.value; drawBody(); });
      only.addEventListener("change", function () { state.only = only.value; drawBody(); });
      findBox.appendChild(h("div", {}, [inp, state.t.diarized ? only : null]));
    }

    function drawBody() {
      var t = state.t;
      clear(body);
      var term = (state.find || "").trim().toLowerCase();
      var shown = 0;
      t.blocks.forEach(function (b) {
        if (state.only && b.name !== state.only) return;
        if (term && String(b.text).toLowerCase().indexOf(term) < 0 && String(b.name || "").toLowerCase().indexOf(term) < 0) return;
        shown++;
        var textEl = h("div", { style: "white-space:pre-wrap;font-size:13.5px;line-height:1.5;color:#222;" });
        if (term) {
          var s = String(b.text), low = s.toLowerCase(), i = 0, j;
          while ((j = low.indexOf(term, i)) >= 0) {
            textEl.appendChild(document.createTextNode(s.slice(i, j)));
            textEl.appendChild(h("mark", { text: s.slice(j, j + term.length) }));
            i = j + term.length;
          }
          textEl.appendChild(document.createTextNode(s.slice(i)));
        } else textEl.textContent = b.text;
        var col = b.failed ? C.red : b.name ? colorOf(b.name) : "#999";
        body.appendChild(h("div", { style: "display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #eee;" }, [
          h("div", { style: "width:130px;flex-shrink:0;" }, [
            b.name ? h("div", { text: b.name, style: "font-weight:700;font-size:12.5px;color:" + col + ";" }) : null,
            h("div", { text: clock(b.start), style: "font-size:11px;color:#999;font-family:ui-monospace,Menlo,monospace;" }),
          ]),
          h("div", { style: "flex:1;border-left:3px solid " + col + ";padding-left:10px;" }, [textEl]),
        ]));
      });
      if (!shown) body.appendChild(note(term || state.only ? "Nothing matches." : "This transcript is empty."));
    }
    load();
  }

  function mount() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-transcripts]"), function (host) {
      if (host._mounted) return;
      host._mounted = true;
      var kind = host.getAttribute("data-transcripts");
      if (kind === "list") listPage(host);
      else if (kind === "view") viewPage(host);
      else if (kind === "client" || kind === "note") panel(host);
    });
  }
  window.TezTranscripts = {
    mount: mount,
    // Called by the dictation modal after a transcript is saved.
    refresh: function () {
      Array.prototype.forEach.call(document.querySelectorAll("[data-transcripts]"), function (host) { if (host._draw) host._draw(); });
    },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
