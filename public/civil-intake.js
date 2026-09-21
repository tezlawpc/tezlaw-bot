/* ────────────────────────────────────────────────────────────
 * civil-intake.js — open a matter from its own documents.
 *
 * Everything on the face of a complaint is already written down: the
 * parties, the court, the case number, the filing date. Typing it a
 * second time is slow, and it is where transcription errors enter a
 * case file — a digit dropped from a case number surfaces weeks later
 * at a filing window.
 *
 * So: drop the complaint and summons here, and Zara proposes the
 * fields. Drop the retainer too and she proposes the fee terms.
 *
 * She PROPOSES. Nothing is saved and nothing is filled in silently.
 * Each value is shown next to the exact phrase in the document it came
 * from, with a checkbox, and the attorney decides. A value Zara could
 * not quote is dropped server-side before it ever reaches this screen,
 * so an empty field means "not in the documents" rather than "she
 * didn't bother" — and an empty field gets filled in, where a wrong one
 * that looks plausible gets filed.
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var C = {
    walnut: "#3E2818", walnutMid: "#5A3B22", gold: "#B8891E",
    parchment: "#F5EBD3", parchmentLit: "#FBF3DE", border: "#D4C4A0",
    muted: "#7B5330", waxRed: "#A02818", green: "#166534",
  };

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
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // How an extracted field maps onto the form's own input names. Anything not
  // listed here is still shown to the attorney, but is not auto-filled,
  // because there is nowhere correct to put it.
  //
  // Deliberately absent:
  //   plaintiffs / defendants — the form has one "opposing party" box, and
  //     which caption side that is depends on who we act for. Guessing wrong
  //     puts our own client down as the opponent, so the names are shown and
  //     the attorney picks.
  //   jurisdiction, client_name — no field on this form.
  var MAP = {
    case_name: "case_name",
    case_number: "case_number",
    court: "court",
    county: "county",
    case_type: "case_type",
    amount_in_controversy: "amount_in_controversy",
    filed_date: "filed_date",
    hourly_rate: "hourly_rate",
    contingency_pct: "contingency_pct",
    retainer_amount: "retainer_amount",
    billing_type: "billing_type",
    fee_arrangement_notes: "internal_notes",
  };

  var LABELS = {
    case_name: "Case name", case_number: "Case number", court: "Court",
    county: "County", case_type: "Case type", filed_date: "Filed date",
    amount_in_controversy: "Amount in controversy", jurisdiction: "Jurisdiction",
    plaintiffs: "Plaintiff(s)", defendants: "Defendant(s)",
    billing_type: "Billing type", hourly_rate: "Hourly rate",
    contingency_pct: "Contingency %", retainer_amount: "Retainer amount",
    client_name: "Client name", fee_arrangement_notes: "Fee notes",
  };

  function fmt(v) {
    if (Array.isArray(v)) return v.join("; ");
    return String(v);
  }

  function mount(host) {
    var fileInput = h("input", {
      type: "file", multiple: "multiple",
      accept: ".pdf,.docx,.txt",
      style: "display:none;",
    });

    var status = h("div", { style: "font-size:12px;color:" + C.muted + ";margin-top:8px;" });
    var results = h("div");

    var drop = h("div", {
      style: "border:2px dashed " + C.border + ";border-radius:8px;padding:18px;text-align:center;" +
             "background:" + C.parchmentLit + ";cursor:pointer;transition:border-color .15s;",
      onclick: function () { fileInput.click(); },
    }, [
      h("div", {
        text: "☁ Drop the complaint, summons or retainer here",
        style: "font-family:Cinzel,serif;font-size:12.5px;letter-spacing:1px;color:" + C.walnut + ";",
      }),
      h("div", {
        text: "PDF, DOCX or TXT · up to 6 files · Zara reads them and proposes the fields below",
        style: "font-size:11px;color:" + C.muted + ";margin-top:5px;font-style:italic;",
      }),
    ]);

    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.style.borderColor = C.gold;
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        drop.style.borderColor = C.border;
      });
    });
    drop.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) upload(e.dataTransfer.files);
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files.length) upload(fileInput.files);
    });

    function upload(files) {
      var fd = new FormData();
      var names = [];
      for (var i = 0; i < Math.min(files.length, 6); i++) {
        fd.append("documents", files[i]);
        names.push(files[i].name);
      }
      clear(results);
      status.style.color = C.muted;
      status.textContent = "Reading " + names.join(", ") + "… this takes a few seconds.";

      fetch("/admin/civil/intake/extract", { method: "POST", body: fd })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; }); })
        .then(function (d) {
          if (!d.ok) {
            status.style.color = C.waxRed;
            status.textContent = d.error || "Could not read those documents.";
            if (d.warnings && d.warnings.length) render(d);   // still show why
            return;
          }
          status.textContent = "";
          render(d);
        })
        .catch(function (e) {
          status.style.color = C.waxRed;
          status.textContent = "Upload failed: " + e.message;
        });
    }

    function render(d) {
      clear(results);

      (d.warnings || []).forEach(function (w) {
        results.appendChild(h("div", {
          text: "⚠ " + w,
          style: "margin-top:8px;padding:9px 11px;border:1px solid " + C.waxRed +
                 ";border-left-width:3px;border-radius:5px;background:#FBF3DE;font-size:12px;color:" + C.walnut + ";line-height:1.5;",
        }));
      });

      var fields = d.fields || {};
      var found = Object.keys(fields).filter(function (k) { return fields[k] !== null && fields[k] !== undefined; });
      if (!found.length) {
        if (d.ok) {
          results.appendChild(h("div", {
            text: "Zara could not find any of the standard fields in those documents. Nothing was filled in — enter the matter by hand.",
            style: "margin-top:10px;font-size:12.5px;color:" + C.muted + ";font-style:italic;",
          }));
        }
        return;
      }

      var boxes = {};
      var rows = found.map(function (k) {
        var cb = h("input", { type: "checkbox", checked: "checked", style: "margin-top:3px;flex-shrink:0;" });
        boxes[k] = cb;
        var quote = (d.evidence || {})[k];
        var fillable = !!MAP[k];

        return h("label", {
          style: "display:flex;gap:9px;align-items:flex-start;padding:8px 2px;border-bottom:1px solid " + C.border + ";cursor:pointer;",
        }, [
          cb,
          h("div", { style: "flex:1;min-width:0;" }, [
            h("div", { style: "display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;" }, [
              h("span", {
                text: LABELS[k] || k,
                style: "font-family:Cinzel,serif;font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:" + C.muted + ";",
              }),
              h("span", {
                text: fmt(fields[k]),
                style: "font-size:13.5px;font-weight:600;color:" + C.walnut + ";",
              }),
              !fillable ? h("span", {
                text: "no matching field — for your reference",
                style: "font-size:10px;color:" + C.muted + ";font-style:italic;",
              }) : null,
            ]),
            quote ? h("div", {
              text: "“" + quote + "”",
              style: "margin-top:3px;font-size:11px;color:" + C.muted + ";font-style:italic;line-height:1.45;",
            }) : null,
          ]),
        ]);
      });

      var applied = h("div", { style: "font-size:12px;margin-top:8px;" });

      var panel = h("div", {
        style: "margin-top:12px;border:1px solid " + C.border + ";border-radius:7px;overflow:hidden;background:" + C.parchmentLit + ";",
      }, [
        h("div", {
          style: "padding:9px 12px;background:" + C.parchment + ";border-bottom:1px solid " + C.border + ";",
        }, [
          h("div", {
            text: "Zara proposes " + found.length + " field" + (found.length === 1 ? "" : "s"),
            style: "font-family:Cinzel,serif;font-size:11.5px;letter-spacing:1.1px;color:" + C.walnut + ";",
          }),
          h("div", {
            text: "Each one is quoted from the document it came from. Untick anything you do not want, then fill the form. Nothing is saved until you submit it yourself.",
            style: "font-size:11px;color:" + C.muted + ";font-style:italic;margin-top:3px;line-height:1.5;",
          }),
        ]),
        h("div", { style: "padding:4px 12px 10px 12px;" }, rows),
        h("div", { style: "padding:10px 12px;border-top:1px solid " + C.border + ";" }, [
          h("button", {
            type: "button",
            onclick: function () { apply(fields, boxes, applied); },
            style: "padding:9px 16px;border:none;border-radius:5px;background:" + C.walnutMid +
                   ";color:" + C.parchmentLit + ";font-family:Cinzel,serif;font-size:11px;letter-spacing:1.2px;cursor:pointer;",
          }, ["FILL THE FORM WITH THESE"]),
          applied,
        ]),
      ]);
      results.appendChild(panel);

      if (d.attorney_must_enter && d.attorney_must_enter.length) {
        results.appendChild(h("div", {
          style: "margin-top:10px;padding:10px 12px;border:1px solid " + C.gold +
                 ";border-left-width:3px;border-radius:5px;background:" + C.parchmentLit + ";",
        }, [
          h("div", {
            text: "Documents cannot tell you these — they are yours to enter:",
            style: "font-size:11.5px;color:" + C.walnut + ";font-weight:600;",
          }),
          h("div", {
            text: d.attorney_must_enter.join(" · "),
            style: "font-size:11.5px;color:" + C.muted + ";margin-top:3px;",
          }),
        ]));
      }
    }

    function apply(fields, boxes, out) {
      // The mount point sits inside the form, so closest() finds the right one
      // even on a page that grows a second form later.
      var form = (host.closest && host.closest("form")) || document.querySelector("form");
      if (!form) { out.textContent = "Could not find the form on this page."; return; }

      var filled = [], skipped = [];
      Object.keys(fields).forEach(function (k) {
        if (!boxes[k] || !boxes[k].checked) return;
        var v = fields[k];
        if (v === null || v === undefined) return;
        var name = MAP[k];
        if (!name) { skipped.push(LABELS[k] || k); return; }
        var el = form.querySelector('[name="' + name + '"]');
        if (!el) { skipped.push(LABELS[k] || k); return; }

        var val = Array.isArray(v) ? v.join("; ") : String(v);
        if (el.tagName === "SELECT") {
          // Only take a select value the form actually offers — a case type
          // the dropdown does not have would silently select nothing.
          var ok = Array.prototype.some.call(el.options, function (o) {
            return o.value.toLowerCase() === val.toLowerCase();
          });
          if (!ok) { skipped.push(LABELS[k] || k); return; }
          el.value = Array.prototype.filter.call(el.options, function (o) {
            return o.value.toLowerCase() === val.toLowerCase();
          })[0].value;
        } else if (el.tagName === "TEXTAREA") {
          // Notes are somewhere the attorney may already have typed. Adding to
          // what is there beats replacing it, and the line says where it came
          // from so nobody later mistakes Zara's reading for a human's note.
          var line = "From the retainer (" + (LABELS[k] || k) + "): " + val;
          if (el.value.indexOf(line) === -1) {
            el.value = el.value.trim() ? el.value.replace(/\s+$/, "") + "\n" + line : line;
          }
        } else {
          el.value = val;
        }
        // A brief highlight, so it is obvious which boxes the machine touched.
        el.style.transition = "background-color .4s";
        el.style.backgroundColor = "#EFE3BE";
        setTimeout(function () { el.style.backgroundColor = ""; }, 1400);
        filled.push(LABELS[k] || k);
      });

      out.style.color = filled.length ? C.green : C.waxRed;
      out.textContent = filled.length
        ? "Filled " + filled.length + " field" + (filled.length === 1 ? "" : "s") + ". Check each one against the document before you submit."
        : "Nothing was filled.";
      if (skipped.length) {
        out.textContent += " No field on this form for: " + skipped.join(", ") + ".";
      }
    }

    clear(host);
    host.appendChild(drop);
    host.appendChild(fileInput);
    host.appendChild(status);
    host.appendChild(results);
  }

  function boot() {
    var hosts = document.querySelectorAll("[data-civil-intake]");
    for (var i = 0; i < hosts.length; i++) {
      try { mount(hosts[i]); }
      catch (e) {
        hosts[i].textContent = "Document intake failed to load: " + e.message;
      }
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.CivilIntake = { boot: boot };
})();
