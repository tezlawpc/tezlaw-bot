/**
 * form-draft.js — every answer saved as it is given
 * ─────────────────────────────────────────────────────────
 * "each question should be saved after client fills them out in case if
 *  its closed or crashed accidently." (JJ, 2026-10-09)
 *
 * One field per request. The server writes that single key with
 * jsonb_set and leaves every other answer alone, so a half-loaded page
 * can never post a blank object over a filled form. See the header of
 * uscis-drafts.js.
 *
 * WHEN IT SAVES
 *   - on blur, which is the normal case: the person has finished the box
 *   - on change for a checkbox or a dropdown, where there is no typing
 *   - after two seconds of not typing, so a long answer is not lost to a
 *     crash mid-sentence
 *   - on pagehide, for the field still focused when the tab closes. This
 *     uses sendBeacon, which the browser delivers after the page is gone;
 *     a normal fetch is cancelled on unload and loses exactly the field
 *     the person was in the middle of, which is the one case this whole
 *     file exists for.
 *
 * No inline handlers anywhere: see notify-admin.js:11 on what an
 * apostrophe in an onclick does to pages built as template literals.
 *
 * It wires itself from data attributes and does nothing on a page that
 * has none, so it is safe to include anywhere.
 */
(function () {
  "use strict";

  var IDLE_MS = 2000;
  var root = null;        // the <form data-draft-url="...">
  var url = "";
  var pending = {};       // key -> value not yet acknowledged
  var timers = {};
  var inflight = 0;

  function statusEl() { return document.getElementById("draft-status"); }

  function say(text, tone) {
    var el = statusEl();
    if (!el) return;
    el.textContent = text;
    el.style.color = tone === "bad" ? "#9C2B1E" : (tone === "good" ? "#2F6B3F" : "#5E5854");
  }

  function valueOf(input) {
    if (input.type === "checkbox") return input.checked ? "yes" : "";
    return input.value;
  }

  // What was last saved, kept on the element, so leaving a box untouched
  // does not send a request and a retry is not mistaken for a new answer.
  function unchanged(input) {
    return input.getAttribute("data-saved") === valueOf(input);
  }

  function send(input) {
    var key = input.getAttribute("data-draft-field");
    if (!key || !url) return;
    if (unchanged(input)) return;
    var value = valueOf(input);
    pending[key] = value;
    inflight++;
    say("Saving…");

    var body = new URLSearchParams();
    body.set("key", key);
    body.set("value", value);

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      credentials: "same-origin",
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || "not saved");
      // Only clear the mark if the value has not changed again since.
      if (pending[key] === value) {
        input.setAttribute("data-saved", value);
        delete pending[key];
      }
      mark(input, true);
      if (--inflight <= 0) { inflight = 0; say(Object.keys(pending).length ? "Not all saved" : "Saved", "good"); }
      if (d.progress) progress(d.progress);
    }).catch(function (e) {
      if (--inflight < 0) inflight = 0;
      mark(input, false);
      // Say so rather than failing quietly. A questionnaire that looks
      // saved and is not is worse than one that never claimed to be.
      say("Not saved — " + e.message + ". Your answers stay on screen; try again.", "bad");
    });
  }

  function mark(input, ok) {
    var row = input.closest("[data-draft-row]");
    if (!row) return;
    row.style.borderLeftColor = ok ? "#2F6B3F" : "#9C2B1E";
    row.style.borderLeftWidth = "3px";
    row.style.borderLeftStyle = "solid";
  }

  function progress(p) {
    var bar = document.getElementById("draft-progress-bar");
    var txt = document.getElementById("draft-progress-text");
    if (bar && typeof p.pct === "number") bar.style.width = p.pct + "%";
    if (txt) txt.textContent = p.done + " of " + p.total + " answered";
  }

  function onInput(e) {
    var input = e.target;
    if (!input.getAttribute || !input.getAttribute("data-draft-field")) return;
    var key = input.getAttribute("data-draft-field");
    window.clearTimeout(timers[key]);
    timers[key] = window.setTimeout(function () { send(input); }, IDLE_MS);
  }

  function onBlurOrChange(e) {
    var input = e.target;
    if (!input.getAttribute || !input.getAttribute("data-draft-field")) return;
    window.clearTimeout(timers[input.getAttribute("data-draft-field")]);
    send(input);
  }

  // The tab is closing. fetch() would be cancelled; sendBeacon is not.
  function onLeave() {
    if (!url) return;
    var active = document.activeElement;
    var list = [];
    if (active && active.getAttribute && active.getAttribute("data-draft-field") && !unchanged(active)) {
      list.push(active);
    }
    // Anything a request has not come back for yet, re-sent. A duplicate
    // write of the same value is harmless; a lost one is not.
    var inputs = root ? root.querySelectorAll("[data-draft-field]") : [];
    for (var i = 0; i < inputs.length; i++) {
      if (!unchanged(inputs[i]) && list.indexOf(inputs[i]) === -1) list.push(inputs[i]);
    }
    for (var j = 0; j < list.length; j++) {
      var b = new URLSearchParams();
      b.set("key", list[j].getAttribute("data-draft-field"));
      b.set("value", valueOf(list[j]));
      try {
        navigator.sendBeacon(url, new Blob([b.toString()],
          { type: "application/x-www-form-urlencoded" }));
      } catch (err) { /* nothing more to try at this point */ }
    }
  }

  function wire() {
    root = document.querySelector("[data-draft-url]");
    if (!root) return;
    url = root.getAttribute("data-draft-url");
    // What is on screen now is what is stored, until somebody types.
    var inputs = root.querySelectorAll("[data-draft-field]");
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].setAttribute("data-saved", valueOf(inputs[i]));
    }
    root.addEventListener("input", onInput, true);
    root.addEventListener("blur", onBlurOrChange, true);
    root.addEventListener("change", onBlurOrChange, true);
    window.addEventListener("pagehide", onLeave);
    say("Every answer is saved as you give it.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
