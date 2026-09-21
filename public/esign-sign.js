/* ────────────────────────────────────────────────────────────
 * esign-sign.js — the page a client (or witness, or JJ) signs on.
 *
 * Opened from a private link: /sign/e/<token>. Shows the whole
 * document, the consent to sign electronically, a typed name and a
 * box to draw the signature in (finger, stylus or mouse). Works on a
 * phone, and on the office tablet for signing in person.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  var root = document.getElementById("esign");
  if (!root) return;
  var token = root.getAttribute("data-token") || "";
  var api = "/api/public/esign/" + encodeURIComponent(token);

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function show(nodes) {
    while (root.firstChild) root.removeChild(root.firstChild);
    nodes.forEach(function (n) { if (n) root.appendChild(n); });
    window.scrollTo(0, 0);
  }
  function card(title, text) {
    return h("div", { "class": "card" }, [h("h2", { text: title, style: "margin:0 0 6px;font-size:20px;" }), text ? h("div", { text: text }) : null]);
  }
  function json(r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); }

  function done(d, justSigned) {
    show([card(justSigned ? "Thank you — you have signed." : "You have already signed this document.",
      (d && d.completed) || (justSigned && justSigned.completed)
        ? "Everyone has now signed. Tez Law P.C. will send you a copy of the signed document."
        : "Tez Law P.C. will send you a copy once everyone has signed. You can close this page.")]);
  }

  // ── Drawing the signature ──────────────────────────────────
  function pad(canvas, onChange) {
    var ctx, drawing = false, last = null, dirty = false;
    function size() {
      var r = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(300, Math.round((r.width || 600) * ratio));
      canvas.height = Math.max(100, Math.round((r.height || 170) * ratio));
      ctx = canvas.getContext && canvas.getContext("2d");
      if (!ctx) return;
      ctx.lineWidth = 2.6 * ratio; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0B1F4B";
      dirty = false; onChange(false);
    }
    function point(e) {
      var r = canvas.getBoundingClientRect(), t = e.touches ? e.touches[0] : e;
      return { x: (t.clientX - r.left) * (canvas.width / (r.width || 1)), y: (t.clientY - r.top) * (canvas.height / (r.height || 1)) };
    }
    function down(e) { if (!ctx) return; e.preventDefault(); drawing = true; last = point(e); }
    function move(e) {
      if (!drawing || !ctx) return; e.preventDefault();
      var p = point(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p;
      if (!dirty) { dirty = true; onChange(true); }
    }
    function up() { drawing = false; }
    canvas.addEventListener("mousedown", down); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    canvas.addEventListener("touchstart", down, { passive: false }); canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", up);
    size();
    return {
      clear: function () { if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; onChange(false); },
      empty: function () { return !dirty; },
      png: function () { return canvas.toDataURL("image/png"); },
    };
  }

  function render(d) {
    var intro = card(d.title, null);
    intro.appendChild(h("div", { "class": "muted", text: "For: " + d.signer.name + (d.signer.label ? " (" + d.signer.label + ")" : "") }));
    if (d.message) intro.appendChild(h("div", { text: d.message, style: "margin-top:8px;white-space:pre-wrap;" }));
    var doc = h("div", { "class": "doc", html: d.document_html });

    if (!d.your_turn) {
      show([intro, card("Not your turn yet",
        "This document is waiting for " + (d.waiting_for || []).join(", ") + " to sign first. You will get a link when it is your turn."), doc]);
      return;
    }

    var nameIn = h("input", { type: "text", autocomplete: "name", placeholder: "Your full legal name", value: d.signer.name || "" });
    var consent = h("input", { type: "checkbox", id: "esign-consent" });
    var canvas = h("canvas", { "aria-label": "Draw your signature here" });
    var err = h("div", { "class": "err" });
    var signBtn = h("button", { "class": "primary", type: "button", text: "Sign" });
    var sig;

    function ready() { signBtn.disabled = !(consent.checked && nameIn.value.trim().length >= 2 && sig && !sig.empty()); }
    consent.addEventListener("change", ready);
    nameIn.addEventListener("input", ready);

    var form = h("div", { "class": "card" }, [
      h("h3", { text: "Sign", style: "margin:0 0 4px;" }),
      h("div", { "class": "muted", text: "Read the whole document above first. The highlighted spots show where your signature and the date will go." }),
      h("label", { style: "display:flex;gap:10px;align-items:flex-start;margin-top:14px;" }, [
        consent, h("span", { text: d.consent_text })]),
      h("label", { text: "Type your full name" }), nameIn,
      h("label", { text: "Draw your signature" }), canvas,
      h("div", { style: "display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;" }, [
        signBtn,
        h("button", { "class": "quiet", type: "button", text: "Clear signature", onclick: function () { sig.clear(); } }),
        h("button", { "class": "quiet", type: "button", text: "I do not want to sign", onclick: declineFlow }),
      ]),
      err,
    ]);
    show([intro, doc, form]);
    sig = pad(canvas, ready);
    ready();

    signBtn.addEventListener("click", function () {
      err.textContent = "";
      signBtn.disabled = true; signBtn.textContent = "Saving…";
      fetch(api + "/sign", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ typed_name: nameIn.value.trim(), signature: sig.png(), consent: consent.checked === true }),
      }).then(json).then(function (r) {
        if (!r.ok) throw new Error(r.error || "Could not save your signature");
        done(null, r);
      }).catch(function (e) {
        err.textContent = e.message; signBtn.textContent = "Sign"; ready();
      });
    });

    function declineFlow() {
      var why = h("textarea", { rows: "3", placeholder: "Optional: tell us why, or what needs to change", style: "width:100%;padding:8px;font-family:inherit;font-size:15px;border:1px solid #D4C4A0;border-radius:6px;" });
      var e2 = h("div", { "class": "err" });
      show([card("Decline to sign?", "Tez Law P.C. will be told you did not sign. If something in the document is wrong, say what, and we will correct it."),
        h("div", { "class": "card" }, [why,
          h("div", { style: "display:flex;gap:10px;margin-top:10px;" }, [
            h("button", { "class": "primary", type: "button", text: "Decline", onclick: function () {
              fetch(api + "/decline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: why.value }) })
                .then(json).then(function (r) {
                  if (!r.ok) throw new Error(r.error || "Could not record that");
                  show([card("Recorded.", "You did not sign. Tez Law P.C. will be in touch.")]);
                }).catch(function (x) { e2.textContent = x.message; });
            } }),
            h("button", { "class": "quiet", type: "button", text: "Go back", onclick: load }),
          ]), e2])]);
    }
  }

  function load() {
    fetch(api, { headers: { Accept: "application/json" } }).then(json).then(function (d) {
      if (d.ok && d.signed) return done(d);
      if (!d.ok) return show([card(d.title || "This link cannot be used", d.error || "Please contact Tez Law P.C. at 626-678-8677.")]);
      render(d);
    }).catch(function () {
      show([card("The document could not be loaded", "Check your connection and reload the page. If it keeps happening, call Tez Law P.C. at 626-678-8677.")]);
    });
  }

  window.EsignSign = { reload: load };
  load();
})();
