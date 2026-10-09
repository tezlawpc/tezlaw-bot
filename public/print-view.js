/**
 * print-view.js — the Print button, without a javascript: URL
 * ─────────────────────────────────────────────────────────
 * "exporting to PDF or print it is a blank page." (JJ, 2026-10-09)
 *
 * The button was <a href="javascript:window.print()">. In Chrome that is
 * harmless. In Safari, following a javascript: URL is a NAVIGATION: the
 * browser begins replacing the document, and the print dialog that opens
 * a moment later can read the replacement rather than the agreement. The
 * file JJ sent back is one letter-sized page with an empty content
 * stream, 901 bytes, Creator "Safari" — a print of nothing at all.
 *
 * So the button is a button, and this wires it. No inline handler: see
 * notify-admin.js:11 on what an apostrophe in an onclick does to pages
 * that are JavaScript template literals.
 *
 * It wires itself by id and does nothing if the button is absent, so it
 * is safe on any page that includes it.
 */
(function () {
  "use strict";
  function wire() {
    var b = document.getElementById("print-this");
    if (!b || b.getAttribute("data-wired") === "1") return;
    b.setAttribute("data-wired", "1");
    b.addEventListener("click", function (e) {
      e.preventDefault();
      // A tick, so the click's own event handling is finished before the
      // dialog takes the thread. Safari prints a half-torn-down page if
      // print() runs inside the handler on some versions.
      window.setTimeout(function () { window.print(); }, 0);
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
