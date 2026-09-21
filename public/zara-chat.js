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

  // ── Teaching her ───────────────────────────────────────────
  //
  // Under every answer: "Teach Zara". Type a better answer, or paste the one
  // Claude gave, or just say what she got wrong. The server turns that into
  // ONE general rule (a lesson) rather than storing the text, because a
  // lesson is injected into every future prompt and a pasted memo would
  // crowd out everything else. When JJ teaches, the lesson is live at once;
  // anyone else's waits for his review.
  function questionFor(i) {
    for (var j = i - 1; j >= 0; j--) if (log[j].role === "user") return log[j].text;
    return "";
  }

  function teachControls(i) {
    var m = log[i];
    var wrap = h("div", { style: "align-self:flex-start;max-width:88%;margin:-3px 0 2px 4px;font-size:11px;" });

    if (m.taught) {
      wrap.appendChild(h("div", {
        text: m.taught.live
          ? "✓ Learned: “" + m.taught.lesson + "” — she uses it from the next answer."
          : m.taught.lesson
            ? "✓ Saved for review: “" + m.taught.lesson + "”"
            : "✓ " + (m.taught.note || "Saved."),
        style: "color:#166534;line-height:1.45;",
      }));
      if (m.taught.live && m.taught.id && !m.taught.undone) {
        wrap.appendChild(h("a", {
          href: "#", text: "undo",
          style: "color:" + C.muted + ";margin-left:2px;",
          onclick: function (e) {
            e.preventDefault();
            fetch("/admin/zara/api/teach/" + m.taught.id + "/undo", { method: "POST", headers: { Accept: "application/json" } })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (d.ok) { m.taught = { note: "Lesson removed." }; saveLog(); draw(); }
              });
          },
        }));
      }
      return wrap;
    }

    var open = false;
    var link = h("a", {
      href: "#", text: "✎ Teach Zara",
      title: "Give her a better answer — typed, or pasted from Claude — and she learns the lesson in it",
      style: "color:" + C.muted + ";text-decoration:none;",
    });
    var form = h("div", { style: "display:none;margin-top:5px;" });
    var ta = h("textarea", {
      rows: 4,
      placeholder: "What would a better answer have been? Paste Claude's answer here, or say what she got wrong and why.",
      style: "width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid " + C.border +
             ";border-radius:5px;font-family:inherit;font-size:12px;line-height:1.45;resize:vertical;background:#fff;color:" + C.walnut + ";",
    });
    var own = h("input", {
      type: "text",
      placeholder: "…or write the rule yourself, e.g. “Always check local rules before quoting a hearing deadline.”",
      style: "width:100%;box-sizing:border-box;margin-top:5px;padding:6px 9px;border:1px solid " + C.border +
             ";border-radius:5px;font-family:inherit;font-size:12px;background:#fff;color:" + C.walnut + ";",
    });
    var status = h("div", { style: "margin-top:4px;color:" + C.muted + ";" });
    var send = h("button", {
      type: "button", text: "Teach",
      style: "margin-top:5px;padding:5px 12px;border:none;border-radius:4px;background:" + C.walnutMid +
             ";color:" + C.parchmentLit + ";font-size:11.5px;cursor:pointer;",
    });

    link.addEventListener("click", function (e) {
      e.preventDefault();
      open = !open;
      form.style.display = open ? "block" : "none";
      if (open) setTimeout(function () { ta.focus(); }, 30);
    });

    send.addEventListener("click", function () {
      var better = ta.value.trim(), lesson = own.value.trim();
      if (!better && !lesson) { status.textContent = "Type or paste a better answer first."; return; }
      send.disabled = true; status.style.color = C.muted;
      status.textContent = lesson ? "Saving the rule…" : "Zara is working out what to learn from that…";
      fetch("/admin/zara/api/teach", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ question: questionFor(i), answer: m.text, better: better, lesson: lesson }),
      })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
        .then(function (d) {
          send.disabled = false;
          if (!d.ok) { status.style.color = C.waxRed; status.textContent = d.error || "Could not save that."; return; }
          if (!d.saved) {
            status.style.color = C.waxRed;
            status.textContent = "That looks like a one-off fact rather than a rule for next time, so nothing was saved. " +
              "If there is a rule in it, write it in the second box.";
            return;
          }
          m.taught = { id: d.lesson && d.lesson.id, lesson: d.lesson && d.lesson.lesson, live: !!d.live };
          saveLog(); draw();
        })
        .catch(function (e) { send.disabled = false; status.style.color = C.waxRed; status.textContent = e.message; });
    });

    form.appendChild(ta); form.appendChild(own); form.appendChild(send); form.appendChild(status);
    wrap.appendChild(link); wrap.appendChild(form);
    return wrap;
  }

  // ── Proposals: Zara suggests, you apply ────────────────────
  //
  // Zara never writes to a matter. When she wants to change the file —
  // a date, a new deadline, a hearing, a memo for the Dropbox folder —
  // her answer carries a card per change. Nothing happens until someone
  // presses Apply; Discard throws it away.
  function proposalCard(m, p) {
    var done = p.state === "applied" || p.state === "discarded";
    var card = h("div", {
      "data-zara-proposal": p.id,
      style: "align-self:flex-start;max-width:88%;width:88%;box-sizing:border-box;background:#fff;border:1px solid " +
             (p.state === "applied" ? "#86C29A" : C.gold) + ";border-left:4px solid " +
             (p.state === "applied" ? "#166534" : p.state === "discarded" ? C.border : C.gold) +
             ";border-radius:7px;padding:8px 10px;font-size:12px;line-height:1.45;color:" + C.walnut +
             (p.state === "discarded" ? ";opacity:.6" : "") + ";",
    });
    card.appendChild(h("div", { text: "Proposed: " + (p.summary || "change"), style: "font-weight:600;margin-bottom:3px;" }));
    (p.lines || []).forEach(function (l) {
      card.appendChild(h("div", { text: "• " + l, style: "white-space:pre-wrap;word-break:break-word;" }));
    });
    if (p.reason) card.appendChild(h("div", { text: "Why: " + p.reason, style: "color:" + C.muted + ";margin-top:3px;font-style:italic;" }));
    var status = h("div", { style: "margin-top:5px;" });
    if (p.state === "applied") {
      status.textContent = "✓ Applied" + (p.note ? " — " + p.note : "") + ".";
      status.style.color = "#166534";
      if (document.querySelector("[data-case-id]")) {
        status.appendChild(document.createTextNode(" "));
        status.appendChild(h("a", { href: "#", text: "Reload page to see it", style: "color:" + C.muted + ";",
          onclick: function (e) { e.preventDefault(); location.reload(); } }));
      }
    } else if (p.state === "discarded") {
      status.textContent = "Discarded.";
      status.style.color = C.muted;
    } else {
      if (p.error) { status.textContent = p.error; status.style.color = C.waxRed; }
      var btnStyle = "margin-right:6px;padding:5px 12px;border-radius:4px;font-size:11.5px;cursor:pointer;";
      var apply = h("button", { type: "button", text: "Apply", "data-zara-apply": p.id,
        style: btnStyle + "background:" + C.walnutMid + ";color:" + C.parchmentLit + ";border:1px solid " + C.gold + ";" });
      var discard = h("button", { type: "button", text: "Discard", "data-zara-discard": p.id,
        style: btnStyle + "background:none;color:" + C.muted + ";border:1px solid " + C.border + ";" });
      function decide(action) {
        apply.disabled = discard.disabled = true;
        status.style.color = C.muted; status.textContent = action === "apply" ? "Applying…" : "Discarding…";
        fetch("/admin/zara/api/proposals/" + encodeURIComponent(p.id) + "/" + action, {
          method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}",
        })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
          .then(function (d) {
            if (!d.ok) { p.error = d.error || "Could not " + action + " this."; }
            else {
              p.error = null;
              p.state = action === "apply" ? "applied" : "discarded";
              var res = d.result || {};
              if (res.skipped_changed_since && res.skipped_changed_since.length) {
                p.note = "not changed because someone edited them since: " + res.skipped_changed_since.join(", ");
              } else if (res.saved_as) {
                p.note = "saved as " + res.saved_as + " in " + (res.folder_label || "the case folder");
              }
            }
            saveLog(); draw();
          })
          .catch(function (e) { p.error = e.message; saveLog(); draw(); });
      }
      apply.addEventListener("click", function () { decide("apply"); });
      discard.addEventListener("click", function () { decide("discard"); });
      var row = h("div", { style: "margin-top:6px;" }, [apply, discard]);
      card.appendChild(row);
    }
    card.appendChild(status);
    return card;
  }

  function applyAll(m) {
    var open = (m.proposals || []).filter(function (p) { return !p.state; });
    if (open.length < 2) return null;
    return h("button", {
      type: "button", text: "Apply all " + open.length,
      style: "align-self:flex-start;padding:5px 12px;border-radius:4px;font-size:11.5px;cursor:pointer;background:" +
             C.walnut + ";color:" + C.parchmentLit + ";border:1px solid " + C.gold + ";",
      onclick: function () {
        // One after another, so the history reads in order and a failure stops nothing else.
        var i = 0;
        (function next() {
          if (i >= open.length) return;
          var btn = body.querySelector('[data-zara-apply="' + open[i++].id + '"]');
          if (btn && !btn.disabled) btn.click();
          setTimeout(next, 700);
        })();
      },
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
    log.forEach(function (m, i) {
      body.appendChild(bubble(m.role, m.text));
      // Not under an error — there is nothing to teach about a failed request.
      if (m.role === "assistant" && m.proposals && m.proposals.length) {
        m.proposals.forEach(function (p) { body.appendChild(proposalCard(m, p)); });
        var all = applyAll(m);
        if (all) body.appendChild(all);
      }
      if (m.role === "assistant" && !m.error) body.appendChild(teachControls(i));
    });
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
    if (uploading) return;
    if (!q && pending.length) q = "Please analyze the attached document" + (pending.length > 1 ? "s" : "") +
      " and propose any updates to the case file.";
    if (!q || busy) return;
    input.value = "";
    input.style.height = "auto";
    var sending = pending.filter(function (d) { return !d.failed; });
    pending = []; drawAttachments();
    log.push({ role: "user", text: q + (sending.length ? "\n📎 " + sending.map(function (d) { return d.name; }).join(", ") : "") });
    busy = true; draw(); saveLog();

    // Never leave "Zara is thinking…" up indefinitely. A tool-using answer
    // takes a few seconds, occasionally twenty; past ninety something is
    // wrong, and the person deserves to be told rather than left waiting.
    // Three minutes, because a full strategy answer can take over a minute.
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 180000);

    fetch("/admin/zara/api/chat", {
      signal: ctrl ? ctrl.signal : undefined,
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        message: q,
        context: pageContext(),
        // Only the last few turns: the endpoint trims anyway, and a long
        // tail of stale context makes her answers worse, not better.
        history: log.slice(-7, -1).filter(function (m) { return !m.error; }).map(function (m) {
          return { role: m.role, content: m.text };
        }),
        attachments: sending.map(function (d) { return { name: d.name, text: d.text || "", filed_to: d.filed_to || null }; }),
      }),
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
      .then(function (d) {
        if (d.ok === false) throw new Error(d.error || "Request failed");
        var a = (d.reply && (d.reply.answer || d.reply.text)) || d.reply || "(no response)";
        log.push({
          role: "assistant", text: typeof a === "string" ? a : JSON.stringify(a),
          proposals: (d.reply && d.reply.proposals) || [],
        });
      })
      .catch(function (e) {
        var msg = e && e.name === "AbortError"
          ? "Zara took more than 3 minutes and the request was stopped. Please ask again."
          : "Couldn't reach Zara: " + e.message;
        log.push({ role: "assistant", text: msg, error: true });
      })
      .then(function () { clearTimeout(timer); busy = false; draw(); saveLog(); });
  }

  // ── Attaching documents ────────────────────────────────────
  //
  // 📎 uploads straight away. On a case page the files are filed into
  // that matter's Dropbox folder, sorted like any other upload; the text
  // comes back and goes to Zara with the next message.
  var pending = [], uploading = false, attachBar, fileInput;

  function drawAttachments() {
    if (!attachBar) return;
    while (attachBar.firstChild) attachBar.removeChild(attachBar.firstChild);
    attachBar.style.display = pending.length || uploading ? "flex" : "none";
    if (uploading) attachBar.appendChild(h("span", { text: "Uploading…", style: "color:" + C.muted + ";font-style:italic;" }));
    pending.forEach(function (d, i) {
      var label = "📎 " + d.name + (d.failed ? " — " + d.failed : d.filed_to ? " → " + d.filed_to : d.caseless ? " (not filed — no case open)" : "");
      attachBar.appendChild(h("span", {
        title: d.error || label,
        style: "display:inline-flex;align-items:center;gap:4px;max-width:100%;background:#fff;border:1px solid " +
               (d.failed ? C.waxRed : C.border) + ";border-radius:10px;padding:2px 8px;color:" + (d.failed ? C.waxRed : C.walnut) + ";",
      }, [
        h("span", { text: label, style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;" }),
        h("a", { href: "#", text: "×", title: "Don't send this one", style: "color:" + C.muted + ";text-decoration:none;",
          onclick: function (e) { e.preventDefault(); pending.splice(i, 1); drawAttachments(); } }),
      ]));
    });
  }

  function attach(files) {
    if (!files || !files.length || uploading) return;
    var host = document.querySelector("[data-case-id]");
    var caseId = host ? host.getAttribute("data-case-id") : "";
    var fd = new FormData();
    for (var i = 0; i < files.length && i < 5; i++) fd.append("files", files[i]);
    if (caseId) fd.append("case_id", caseId);
    uploading = true; drawAttachments();
    fetch("/admin/zara/api/attach", { method: "POST", body: fd, headers: { Accept: "application/json" } })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || "Upload failed");
        var fileErr = d.filed && d.filed.ok === false && d.filed.error;
        (d.docs || []).forEach(function (doc) {
          pending.push({
            name: doc.name, text: doc.text, filed_to: doc.filed_to, error: doc.error,
            caseless: !caseId,
            failed: doc.file_error || fileErr ? "not filed: " + (doc.file_error || fileErr) : null,
          });
          // An unfiled doc can still be read; only mark it failed if there is nothing to send.
          var last = pending[pending.length - 1];
          if (last.failed && last.text) { last.error = last.failed; last.failed = null; last.caseless = true; }
        });
      })
      .catch(function (e) { pending.push({ name: files[0].name, failed: e.message }); })
      .then(function () { uploading = false; drawAttachments(); if (fileInput) fileInput.value = ""; });
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

  fileInput = h("input", { type: "file", multiple: "multiple", accept: ".pdf,.docx,.txt,.md,.doc,.jpg,.jpeg,.png", style: "display:none;" });
  fileInput.addEventListener("change", function () { attach(fileInput.files); });
  var clipBtn = h("button", {
    title: "Attach documents — on a case page they are filed to the case's Dropbox folder",
    onclick: function () { fileInput.click(); },
    style: "flex-shrink:0;width:34px;height:38px;border-radius:6px;background:none;border:1px solid " + C.border +
           ";color:" + C.walnutMid + ";font-size:16px;cursor:pointer;",
  }, ["📎"]);
  attachBar = h("div", {
    style: "display:none;flex-wrap:wrap;gap:5px;padding:6px 10px 0;background:" + C.parchmentLit + ";font-size:11px;flex-shrink:0;",
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
    attachBar,
    h("div", {
      style: "display:flex;gap:8px;align-items:flex-end;padding:10px;background:" + C.parchmentLit +
             ";border-top:1px solid " + C.border + ";flex-shrink:0;",
    }, [fileInput, clipBtn, input, sendBtn]),
  ]);

  panel.addEventListener("dragover", function (e) { e.preventDefault(); });
  panel.addEventListener("drop", function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) attach(e.dataTransfer.files);
  });

  function mount() {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    var wasOpen = "0";
    try { wasOpen = sessionStorage.getItem(OPEN_KEY) || "0"; } catch (e) {}
    setOpen(wasOpen === "1");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  window.ZaraChat = { open: function () { setOpen(true); }, context: pageContext, attach: attach };
})();
