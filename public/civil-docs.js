/* ────────────────────────────────────────────────────────────
 * civil-docs.js — upload a document to the matter, from the case page.
 *
 * Drop a file here and it is written into the case's Dropbox folder,
 * in the subfolder it belongs in — Pleadings, Discovery, Billing &
 * Trust — and the case page picks it up. Dropbox stays the matter
 * file; this is just a faster way in than opening Dropbox.
 *
 * "Auto-sort" files by name, using the same rules the Dropbox sync
 * uses. Pick a category instead to force one: useful for a file
 * called scan0007.pdf that is plainly a deposition transcript.
 *
 * Nothing is ever overwritten. A second "Complaint.pdf" is saved as
 * "Complaint (1).pdf", and the result line says so.
 *
 * Served as a real static file — inline JS inside a server-side
 * template literal loses its escapes before the browser sees it.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var C = {
    walnut: "#3E2818", walnutMid: "#5A3B22", gold: "#B8891E",
    parchment: "#F5EBD3", parchmentLit: "#FBF3DE", border: "#D4C4A0",
    muted: "#7B5330", waxRed: "#A02818", green: "#166534",
  };
  var MAX = 20;

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

  /**
   * Post files to a case. Shared with the new-case intake, which calls it
   * once the case exists. Resolves with the server's JSON; never rejects.
   */
  function uploadFiles(caseId, files, opts) {
    opts = opts || {};
    var fd = new FormData();
    for (var i = 0; i < Math.min(files.length, MAX); i++) fd.append("files", files[i]);
    if (opts.category) fd.append("category", opts.category);
    if (opts.source) fd.append("source", opts.source);
    return fetch("/admin/civil/api/cases/" + encodeURIComponent(caseId) + "/upload", { method: "POST", body: fd })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; });
      })
      .catch(function (e) { return { ok: false, error: e.message }; });
  }

  /** One line per file: where it went, or why it did not. */
  function describe(d) {
    var lines = [];
    (d.uploaded || []).forEach(function (u) {
      lines.push({ ok: true, text: "✓ " + u.saved_as + " → " + u.folder_label + (u.renamed ? "  (renamed — that name was taken)" : "") });
    });
    (d.failed || []).forEach(function (f) {
      lines.push({ ok: false, text: "✗ " + f.name + " — " + f.error });
    });
    if (!lines.length && d.error) lines.push({ ok: false, text: d.error });
    return lines;
  }

  function mount(host) {
    var caseId = host.getAttribute("data-case-id");
    var cats = [];
    try { cats = JSON.parse(host.getAttribute("data-categories") || "[]"); } catch (e) { cats = []; }

    var fileInput = h("input", { type: "file", multiple: "multiple", style: "display:none;" });

    var select = h("select", {
      title: "Where to file these",
      style: "padding:6px 8px;border:1px solid " + C.border + ";border-radius:5px;background:" + C.parchmentLit +
             ";color:" + C.walnut + ";font-size:12px;",
    }, [h("option", { value: "", text: "Auto-sort by file name" })].concat(
      cats.map(function (c) { return h("option", { value: c.key, text: "File under: " + c.label }); })
    ));

    var status = h("div", { style: "margin-top:8px;font-size:12px;line-height:1.6;" });

    var drop = h("div", {
      onclick: function () { fileInput.click(); },
      style: "flex:1;min-width:240px;border:2px dashed " + C.border + ";border-radius:7px;padding:12px 14px;" +
             "background:" + C.parchmentLit + ";cursor:pointer;text-align:center;transition:border-color .15s;",
    }, [
      h("div", {
        text: "⇪ Drop documents here to file them in Dropbox",
        style: "font-family:Cinzel,serif;font-size:12px;letter-spacing:1px;color:" + C.walnut + ";",
      }),
      h("div", {
        text: "Sorted into the matter's subfolders · up to " + MAX + " at a time · nothing is overwritten",
        style: "font-size:10.5px;color:" + C.muted + ";margin-top:3px;font-style:italic;",
      }),
    ]);

    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.style.borderColor = C.gold; });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); drop.style.borderColor = C.border; });
    });
    drop.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) go(e.dataTransfer.files);
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files.length) go(fileInput.files);
    });

    function go(files) {
      var names = [];
      for (var i = 0; i < Math.min(files.length, MAX); i++) names.push(files[i].name);
      status.style.color = C.muted;
      status.textContent = "Filing " + names.length + " document" + (names.length === 1 ? "" : "s") + " to Dropbox…";

      uploadFiles(caseId, files, { category: select.value || null }).then(function (d) {
        while (status.firstChild) status.removeChild(status.firstChild);
        describe(d).forEach(function (l) {
          status.appendChild(h("div", { text: l.text, style: "color:" + (l.ok ? C.green : C.waxRed) + ";" }));
        });
        if (files.length > MAX) {
          status.appendChild(h("div", {
            text: "Only the first " + MAX + " were sent — drop the rest again.",
            style: "color:" + C.waxRed + ";",
          }));
        }
        fileInput.value = "";
        if (d.uploaded && d.uploaded.length) {
          status.appendChild(h("div", { text: "Refreshing the document list…", style: "color:" + C.muted + ";font-style:italic;" }));
          setTimeout(function () { location.reload(); }, 1800);
        }
      });
    }

    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap;" }, [drop, select]));
    host.appendChild(fileInput);
    host.appendChild(status);
  }

  function boot() {
    var hosts = document.querySelectorAll("[data-civil-upload]");
    for (var i = 0; i < hosts.length; i++) {
      try { mount(hosts[i]); }
      catch (e) { hosts[i].textContent = "Document upload failed to load: " + e.message; }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.CivilDocs = { boot: boot, uploadFiles: uploadFiles, describe: describe };
})();
