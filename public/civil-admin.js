/* ────────────────────────────────────────────────────────────
 * civil-admin.js — web admin client for the civil litigation module
 *
 * Served as a real static file from /static/civil-admin.js rather than
 * inlined into a page. Everything on the civil pages used to be written
 * inside server-side template literals, where \n and \' are consumed by the
 * server before the browser ever sees them — a bug that shipped three times
 * and each time killed the whole script block, not just one line. A separate
 * file retires that class of bug permanently.
 *
 * Talks to /admin/civil/api/*, which app-api.js mirrors from
 * /api/staff/civil/* — the exact handlers the iOS app uses, so the two
 * surfaces cannot drift again.
 *
 * Mount points: any element with data-civil-panel="<name>" on a page that
 * also carries data-case-id on <body> (or on the panel itself).
 * ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var C = {
    walnut: "#3E2818", walnutMid: "#5A3B22", walnutLight: "#8B7355",
    gold: "#B8891E", goldBright: "#E0B44E",
    ember: "#F07800", emberDeep: "#B84200", waxRed: "#A02818",
    parchment: "#F5EBD3", parchmentLit: "#FBF3DE", border: "#D4C4A0",
    green: "#166534", ink: "#3E2818", muted: "#7B5330",
  };

  // ── HTTP ───────────────────────────────────────────────────
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || "GET", headers: { Accept: "application/json" } };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch("/admin/civil/api" + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: "HTTP " + r.status }; })
        .then(function (d) {
          if (!r.ok || d.ok === false) throw new Error(d.error || ("HTTP " + r.status));
          return d;
        });
    });
  }

  // ── DOM ────────────────────────────────────────────────────
  function h(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "style") e.style.cssText = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }

  function card(children, extra) {
    return h("div", {
      style: "background:" + C.parchmentLit + ";border:1px solid " + C.border +
             ";border-radius:6px;padding:14px;margin-bottom:10px;" + (extra || ""),
    }, children);
  }
  function heading(txt, right) {
    var row = h("div", { style: "display:flex;justify-content:space-between;align-items:center;margin:24px 0 12px 0;gap:10px;flex-wrap:wrap;" }, [
      h("h2", {
        text: txt,
        style: "margin:0;font-family:Cinzel,serif;color:" + C.ink + ";font-size:16px;letter-spacing:1.5px;",
      }),
    ]);
    if (right) row.appendChild(right);
    return row;
  }
  function btn(label, onClick, kind) {
    var bg = kind === "danger" ? C.waxRed : kind === "quiet" ? C.parchment : C.walnutMid;
    var fg = kind === "quiet" ? C.walnut : C.parchmentLit;
    return h("button", {
      type: "button", text: label, onclick: onClick,
      style: "padding:7px 13px;background:" + bg + ";color:" + fg + ";border:1px solid " +
             (kind === "quiet" ? C.border : C.gold) +
             ";border-radius:5px;cursor:pointer;font-size:11px;font-family:Cinzel,serif;letter-spacing:1px;",
    });
  }
  function chip(label, color, title) {
    return h("span", {
      text: label, title: title || label,
      style: "display:inline-block;padding:2px 6px;border-radius:3px;background:" + color +
             ";color:" + C.parchmentLit + ";font-size:10px;font-weight:700;white-space:nowrap;",
    });
  }
  function kv(label, value) {
    return h("div", { style: "font-size:12px;color:" + C.muted + ";" }, [
      h("strong", { text: label + ": ", style: "color:" + C.walnut + ";" }),
      String(value === null || value === undefined || value === "" ? "—" : value),
    ]);
  }
  function note(txt) {
    return h("div", {
      text: txt,
      style: "padding:16px;text-align:center;font-style:italic;color:" + C.muted +
             ";background:" + C.parchmentLit + ";border:1px solid " + C.border + ";border-radius:6px;",
    });
  }
  function fmtDate(d) {
    if (!d) return "";
    var t = new Date(d);
    if (isNaN(t)) return String(d);
    return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function money(n) {
    if (n === null || n === undefined || n === "") return "—";
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function daysUntil(d) {
    if (!d) return null;
    var ms = new Date(d).getTime() - Date.now();
    return isNaN(ms) ? null : Math.ceil(ms / 86400000);
  }
  function toast(msg, bad) {
    var t = document.getElementById("civilToast");
    if (!t) {
      t = h("div", { id: "civilToast" });
      t.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
        "padding:9px 16px;background:" + C.walnut + ";color:" + C.parchmentLit +
        ";border:1px solid " + C.gold + ";border-radius:6px;font-size:12px;z-index:9999;";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.borderColor = bad ? C.waxRed : C.gold;
    t.style.display = "block";
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.display = "none"; }, 3000);
  }

  // ── Generic form modal ─────────────────────────────────────
  // fields: [{ name, label, type, options?, value?, required?, hint?, half? }]
  // type: text | textarea | number | date | select | checkbox
  // onSubmit(values) must return a promise; the modal closes on resolve.
  function formModal(title, fields, onSubmit, submitLabel) {
    var back = h("div", {
      style: "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;display:flex;" +
             "align-items:flex-start;justify-content:center;padding:32px 16px;overflow:auto;",
    });
    var inputs = {};
    var errBox = h("div", { style: "color:" + C.waxRed + ";font-size:12px;min-height:16px;" });

    var grid = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px;" });
    fields.forEach(function (f) {
      var ctl;
      var base = "width:100%;box-sizing:border-box;padding:8px;border:1px solid " + C.border +
                 ";border-radius:4px;background:" + C.parchmentLit + ";color:" + C.ink +
                 ";font-size:13px;font-family:inherit;";
      if (f.type === "textarea") {
        ctl = h("textarea", { rows: f.rows || 3, style: base + "resize:vertical;" });
        ctl.value = f.value || "";
      } else if (f.type === "select") {
        ctl = h("select", { style: base });
        (f.options || []).forEach(function (o) {
          var val = typeof o === "string" ? o : o.value;
          var lab = typeof o === "string" ? o : o.label;
          var op = h("option", { value: val, text: lab });
          if (String(f.value || "") === String(val)) op.selected = true;
          ctl.appendChild(op);
        });
      } else if (f.type === "checkbox") {
        ctl = h("input", { type: "checkbox" });
        ctl.checked = !!f.value;
      } else {
        ctl = h("input", { type: f.type || "text", style: base });
        ctl.value = f.value === null || f.value === undefined ? "" : String(f.value);
        if (f.step) ctl.step = f.step;
      }
      inputs[f.name] = ctl;
      var wrap = h("div", { style: f.half ? "" : "grid-column:1 / -1;" }, [
        h("label", {
          text: f.label + (f.required ? " *" : ""),
          style: "display:block;font-size:10px;letter-spacing:1px;text-transform:uppercase;" +
                 "color:" + C.muted + ";font-family:Cinzel,serif;margin-bottom:4px;",
        }),
        ctl,
        f.hint ? h("div", { text: f.hint, style: "font-size:11px;font-style:italic;color:" + C.walnutLight + ";margin-top:3px;" }) : null,
      ]);
      grid.appendChild(wrap);
    });

    function close() { document.body.removeChild(back); }
    function submit() {
      var vals = {};
      var missing = null;
      fields.forEach(function (f) {
        var el = inputs[f.name];
        var v = f.type === "checkbox" ? el.checked : el.value;
        if (f.required && (v === "" || v === null || v === undefined)) missing = missing || f.label;
        vals[f.name] = v;
      });
      if (missing) { errBox.textContent = missing + " is required."; return; }
      errBox.textContent = "";
      saveBtn.disabled = true;
      saveBtn.textContent = "SAVING...";
      Promise.resolve(onSubmit(vals)).then(function () {
        close();
      }).catch(function (e) {
        errBox.textContent = e.message || "Save failed";
        saveBtn.disabled = false;
        saveBtn.textContent = submitLabel || "SAVE";
      });
    }

    var saveBtn = btn(submitLabel || "SAVE", submit);
    var box = h("div", {
      style: "background:" + C.parchment + ";border:1px solid " + C.gold + ";border-radius:8px;" +
             "padding:18px;max-width:640px;width:100%;",
    }, [
      h("div", {
        text: title,
        style: "font-family:Cinzel,serif;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;" +
               "color:" + C.walnut + ";margin-bottom:14px;",
      }),
      grid,
      errBox,
      h("div", { style: "display:flex;gap:8px;justify-content:flex-end;margin-top:14px;" }, [
        btn("CANCEL", close, "quiet"), saveBtn,
      ]),
    ]);
    back.appendChild(box);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    (grid.querySelector("input,textarea,select") || {}).focus && grid.querySelector("input,textarea,select").focus();
  }

  // Strip blanks so an untouched field does not overwrite a stored value with
  // NULL — every civil module except logEvent/logCommunication/addManualDeadline
  // turns "" into NULL.
  function pruneBlank(o) {
    var out = {};
    Object.keys(o).forEach(function (k) {
      if (o[k] !== "" && o[k] !== null && o[k] !== undefined) out[k] = o[k];
    });
    return out;
  }
  function num(v) { return v === "" || v === null || v === undefined ? null : Number(v); }

  // ═══════════════════════════════════════════════════════════
  //  PANELS
  // ═══════════════════════════════════════════════════════════
  var CASE_ID = null;
  var META = { stages: [], case_types: [], our_roles: [] };
  var TEAM_ROLES = [];
  var DISCOVERY_META = null;
  var CASE_ROW = null;
  var JURISDICTIONS = [];
  var SERVICE_METHODS = [];
  var UTBMS = null;

  var SERVE_METHODS = ["personal", "mail", "email", "efile", "overnight"];
  var DEPO_STATUSES = ["noticed", "confirmed", "held", "continued", "cancelled"];

  function panel(name) { return document.querySelector('[data-civil-panel="' + name + '"]'); }

  function mountAll() {
    return Promise.all([
      panel("team") ? renderTeam() : null,
      panel("discovery") ? renderDiscovery() : null,
      panel("depos") ? renderDepos() : null,
      panel("docket") ? renderDocket() : null,
      panel("financials") ? renderFinancials() : null,
    ]);
  }
  function reload() { return mountAll(); }

  // ── Team ───────────────────────────────────────────────────
  function renderTeam() {
    var root = clear(panel("team"));
    return api("/cases/" + CASE_ID + "/team").then(function (d) {
      var members = d.team || [];
      root.appendChild(heading("👥 CASE TEAM (" + members.length + ")",
        btn("+ ASSIGN MEMBER", openAddTeam)));
      if (!members.length) {
        root.appendChild(note("Nobody assigned yet. Assign a lead attorney so time entries resolve to the right rate."));
        return;
      }
      var byRole = {};
      members.forEach(function (m) { (byRole[m.role] = byRole[m.role] || []).push(m); });
      TEAM_ROLES.forEach(function (r) {
        (byRole[r.key] || []).forEach(function (m) {
          root.appendChild(card([
            h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:10px;" }, [
              h("div", {}, [
                h("div", { style: "display:flex;align-items:center;gap:7px;flex-wrap:wrap;" }, [
                  chip(r.label, r.color || C.walnutMid),
                  h("strong", { text: (m.is_primary ? "★ " : "") + (m.full_name || m.user_name || "—"), style: "color:" + C.ink + ";" }),
                ]),
                m.email ? kv("Email", m.email) : null,
                kv("Rate", m.billing_rate ? "$" + m.billing_rate + "/hr" : "firm default"),
                m.notes ? kv("Notes", m.notes) : null,
              ]),
              h("div", { style: "display:flex;gap:6px;flex-shrink:0;" }, [
                btn("EDIT", function () { openEditTeam(m); }, "quiet"),
                btn("REMOVE", function () { removeTeam(m); }, "danger"),
              ]),
            ]),
          ], "border-left:3px solid " + (r.color || C.walnutMid) + ";"));
        });
      });
    }).catch(function (e) { root.appendChild(note("Team unavailable: " + e.message)); });
  }

  function teamFields(m) {
    return [
      { name: "role", label: "Role", type: "select", required: true, half: true,
        options: TEAM_ROLES.map(function (r) { return { value: r.key, label: r.label }; }),
        value: m && m.role },
      { name: "billing_rate", label: "Billing rate ($/hr)", type: "number", step: "0.01", half: true,
        value: m && m.billing_rate, hint: "Blank uses the person's firm default, then the case rate." },
      { name: "is_primary", label: "Primary contact for this role", type: "checkbox", value: m && m.is_primary },
      { name: "notes", label: "Notes", type: "textarea", value: m && m.notes },
    ];
  }

  function openAddTeam() {
    api("/users").catch(function () { return { users: [] }; }).then(function (u) {
      var users = u.users || [];
      var fields = [
        { name: "user_id", label: "Firm user", type: "select", half: true,
          options: [{ value: "", label: "— external person —" }].concat(users.map(function (x) {
            return { value: x.id, label: (x.full_name || x.username) + (x.billing_rate ? " ($" + x.billing_rate + "/hr)" : "") };
          })) },
        { name: "user_name", label: "…or a name", type: "text", half: true,
          hint: "For experts, investigators, contract attorneys with no login." },
      ].concat(teamFields(null));
      formModal("Assign team member", fields, function (v) {
        if (!v.user_id && !v.user_name) return Promise.reject(new Error("Pick a firm user or type a name."));
        return api("/cases/" + CASE_ID + "/team", {
          method: "POST",
          body: {
            role: v.role,
            user_id: v.user_id ? Number(v.user_id) : null,
            user_name: v.user_name || null,
            billing_rate: num(v.billing_rate),
            is_primary: v.is_primary,
            notes: v.notes || null,
          },
        }).then(function () { toast("Assigned"); return renderTeam(); });
      }, "ASSIGN");
    });
  }

  function openEditTeam(m) {
    formModal("Edit assignment", teamFields(m), function (v) {
      return api("/team/" + m.id, {
        method: "PATCH",
        body: { role: v.role, billing_rate: num(v.billing_rate), is_primary: v.is_primary, notes: v.notes || null },
      }).then(function () { toast("Updated"); return renderTeam(); });
    });
  }

  function removeTeam(m) {
    if (!confirm("Remove " + (m.full_name || m.user_name) + " from this case team?")) return;
    api("/team/" + m.id, { method: "DELETE" })
      .then(function () { toast("Removed"); return renderTeam(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ── Discovery ──────────────────────────────────────────────
  var DISCOVERY_STATUS_COLOR = {
    pending: C.walnutLight, responded: C.green, deficient: C.waxRed,
    in_meet_confer: C.ember, motion_filed: C.emberDeep, resolved: C.green, withdrawn: C.walnutLight,
  };

  function renderDiscovery() {
    var root = clear(panel("discovery"));
    return api("/cases/" + CASE_ID + "/discovery").then(function (d) {
      var rows = d.discovery || [];
      var sum = d.summary || {};
      root.appendChild(heading("🔍 DISCOVERY (" + rows.length + ")", btn("+ NEW SET", openAddDiscovery)));

      if ((sum.overdue || []).length) {
        root.appendChild(card([h("strong", {
          text: "⚠️ " + sum.overdue.length + " overdue response" + (sum.overdue.length === 1 ? "" : "s"),
          style: "color:" + C.waxRed + ";",
        })], "border-left:4px solid " + C.waxRed + ";"));
      }
      if ((sum.upcoming_mtc || []).length) {
        root.appendChild(card([h("strong", {
          text: "🚨 " + sum.upcoming_mtc.length + " motion-to-compel deadline" +
                (sum.upcoming_mtc.length === 1 ? "" : "s") + " within 30 days",
          style: "color:" + C.emberDeep + ";",
        })], "border-left:4px solid " + C.ember + ";"));
      }
      if (!rows.length) {
        root.appendChild(note("No discovery yet. Response dates and the 45-day motion-to-compel clock are computed from the service date and method."));
        return;
      }

      [["propounded", "PROPOUNDED BY US"], ["received", "RECEIVED FROM OPPOSING"]].forEach(function (pair) {
        var group = rows.filter(function (r) { return r.direction === pair[0]; });
        if (!group.length) return;
        root.appendChild(h("div", {
          text: pair[1] + " (" + group.length + ")",
          style: "font-family:Cinzel,serif;font-size:11px;letter-spacing:1.5px;color:" + C.muted + ";margin:14px 0 8px 0;",
        }));
        group.forEach(function (r) { root.appendChild(discoveryCard(r)); });
      });
    }).catch(function (e) { root.appendChild(note("Discovery unavailable: " + e.message)); });
  }

  function kindLabel(k) {
    var found = (DISCOVERY_META && DISCOVERY_META.kinds || []).filter(function (x) { return x.key === k; })[0];
    return found ? found.label : k;
  }

  function discoveryCard(r) {
    var dueIn = daysUntil(r.response_due_date);
    var mtcIn = daysUntil(r.mtc_deadline);
    var overdue = dueIn !== null && dueIn < 0 && (r.status === "pending" || r.status === "deficient");
    return card([
      h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;" }, [
        h("div", {}, [
          h("div", { style: "font-family:Cinzel,serif;font-weight:600;color:" + C.ink + ";" },
            [kindLabel(r.kind) + (r.set_number ? " — Set " + r.set_number : "")]),
          r.title ? kv("Title", r.title) : null,
          r.to_party ? kv("Party", r.to_party) : null,
          kv("Served", (r.served_date ? fmtDate(r.served_date) : "—") + (r.served_method ? " by " + r.served_method : "")),
          r.total_requests ? kv("Requests", r.total_requests) : null,
        ]),
        h("div", { style: "display:flex;flex-direction:column;gap:5px;align-items:flex-end;" }, [
          chip(String(r.status || "pending").replace(/_/g, " ").toUpperCase(),
               DISCOVERY_STATUS_COLOR[r.status] || C.walnutLight),
          r.response_due_date ? chip(
            (overdue ? "OVERDUE " + Math.abs(dueIn) + "d" : "DUE " + fmtDate(r.response_due_date)),
            overdue ? C.waxRed : dueIn !== null && dueIn <= 7 ? C.ember : C.walnutLight) : null,
          r.mtc_deadline && !r.mtc_filed_date ? chip(
            "MTC " + fmtDate(r.mtc_deadline), mtcIn !== null && mtcIn <= 30 ? C.emberDeep : C.gold,
            "45-day hard deadline — CCP 2030.300(c)") : null,
        ]),
      ]),
      r.deficiency_notes ? h("div", {
        text: r.deficiency_notes,
        style: "margin-top:8px;font-size:12px;color:" + C.muted + ";font-style:italic;",
      }) : null,
      h("div", { style: "display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;" }, [
        btn("RESPONSES RECEIVED", function () { openResponses(r); }, "quiet"),
        btn("MEET & CONFER", function () { openMeetConfer(r); }, "quiet"),
        btn("DELETE", function () { deleteDiscovery(r); }, "danger"),
      ]),
    ], overdue ? "border-left:4px solid " + C.waxRed + ";" : "");
  }

  function openAddDiscovery() {
    var kinds = (DISCOVERY_META && DISCOVERY_META.kinds || []).map(function (k) {
      return { value: k.key, label: k.label + (k.ccp ? " — " + k.ccp : "") };
    });
    formModal("New discovery set", [
      { name: "kind", label: "Kind", type: "select", required: true, half: true, options: kinds },
      { name: "direction", label: "Direction", type: "select", required: true, half: true,
        options: [{ value: "propounded", label: "Propounded by us" }, { value: "received", label: "Received from opposing" }] },
      { name: "set_number", label: "Set number", type: "number", half: true, value: 1 },
      { name: "total_requests", label: "Total requests", type: "number", half: true },
      { name: "title", label: "Title", type: "text" },
      { name: "to_party", label: "To / from party", type: "text", half: true },
      { name: "served_date", label: "Served date", type: "date", half: true },
      { name: "served_method", label: "Service method", type: "select", half: true, options: SERVE_METHODS,
        hint: "Drives the response due date: +30 days, plus 5 for mail, 2 for email/e-file/overnight, 0 for personal." },
      { name: "notes", label: "Notes", type: "textarea" },
    ], function (v) {
      return api("/cases/" + CASE_ID + "/discovery", {
        method: "POST",
        body: pruneBlank({
          kind: v.kind, direction: v.direction,
          set_number: num(v.set_number), total_requests: num(v.total_requests),
          title: v.title, to_party: v.to_party,
          served_date: v.served_date, served_method: v.served_method, notes: v.notes,
        }),
      }).then(function () { toast("Discovery set added"); return renderDiscovery(); });
    }, "ADD");
  }

  function openResponses(r) {
    // markResponsesReceived overwrites all six columns unconditionally, so the
    // form has to carry the current values rather than only the changed ones.
    formModal("Responses received — " + kindLabel(r.kind), [
      { name: "responses_served_date", label: "Responses served", type: "date", half: true, required: true,
        value: r.responses_served_date ? String(r.responses_served_date).slice(0, 10) : "" },
      { name: "method", label: "Service method", type: "select", half: true, options: SERVE_METHODS,
        hint: "Sets the 45-day motion-to-compel deadline." },
      { name: "responses_verified", label: "Verified responses", type: "checkbox", value: r.responses_verified },
      { name: "deficient", label: "Deficient", type: "checkbox", value: r.deficient },
      { name: "deficiency_notes", label: "Deficiency notes", type: "textarea", value: r.deficiency_notes || "" },
    ], function (v) {
      return api("/discovery/" + r.id + "/responses", {
        method: "POST",
        body: {
          responses_served_date: v.responses_served_date,
          method: v.method,
          responses_verified: v.responses_verified,
          deficient: v.deficient,
          deficiency_notes: v.deficiency_notes || null,
        },
      }).then(function () { toast("Responses recorded"); return renderDiscovery(); });
    }, "RECORD");
  }

  function openMeetConfer(r) {
    formModal("Meet and confer — " + kindLabel(r.kind), [
      { name: "meet_confer_letter_sent_date", label: "M&C letter sent", type: "date", half: true,
        value: r.meet_confer_letter_sent_date ? String(r.meet_confer_letter_sent_date).slice(0, 10) : "" },
      { name: "meet_confer_response_date", label: "Their response", type: "date", half: true,
        value: r.meet_confer_response_date ? String(r.meet_confer_response_date).slice(0, 10) : "" },
      { name: "meet_confer_call_date", label: "M&C call", type: "date", half: true,
        value: r.meet_confer_call_date ? String(r.meet_confer_call_date).slice(0, 10) : "" },
      { name: "mtc_filed_date", label: "Motion to compel FILED", type: "date", half: true,
        value: r.mtc_filed_date ? String(r.mtc_filed_date).slice(0, 10) : "",
        hint: "Only fill this once the motion is actually filed — it flips the set to Motion Filed." },
      { name: "mtc_hearing_date", label: "MTC hearing", type: "date", half: true,
        value: r.mtc_hearing_date ? String(r.mtc_hearing_date).slice(0, 10) : "" },
      { name: "mtc_outcome", label: "Outcome", type: "select", half: true,
        options: ["", "granted", "denied", "settled"], value: r.mtc_outcome || "" },
    ], function (v) {
      // updateMeetConfer applies a field whenever the KEY is present, not when
      // it has a value — a blank mtc_filed_date that is sent anyway would flip
      // the set to Motion Filed. Send only what was actually filled in.
      var body = pruneBlank(v);
      if (!Object.keys(body).length) return Promise.reject(new Error("Fill in at least one date."));
      return api("/discovery/" + r.id + "/meet-confer", { method: "POST", body: body })
        .then(function () { toast("Meet and confer updated"); return renderDiscovery(); });
    }, "SAVE");
  }

  function deleteDiscovery(r) {
    if (!confirm("Delete this discovery set and its items? This cannot be undone.")) return;
    api("/discovery/" + r.id, { method: "DELETE" })
      .then(function () { toast("Deleted"); return renderDiscovery(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ── Depositions ────────────────────────────────────────────
  function renderDepos() {
    var root = clear(panel("depos"));
    return api("/cases/" + CASE_ID + "/depositions").then(function (d) {
      var rows = d.depositions || [];
      root.appendChild(heading("🎙 DEPOSITIONS (" + rows.length + ")", btn("+ NEW DEPOSITION", openAddDepo)));
      if (!rows.length) {
        root.appendChild(note("No depositions noticed yet."));
        return;
      }
      rows.forEach(function (r) {
        root.appendChild(card([
          h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;" }, [
            h("div", {}, [
              h("div", { style: "font-family:Cinzel,serif;font-weight:600;color:" + C.ink + ";" },
                [r.deponent_name + (r.deponent_role ? " — " + r.deponent_role : "")]),
              r.scheduled_date ? kv("Scheduled", fmtDate(r.scheduled_date) + (r.scheduled_time ? " at " + r.scheduled_time : "")) : null,
              r.location ? kv("Location", r.location + (r.remote_platform ? " (" + r.remote_platform + ")" : "")) : null,
              r.taking_party ? kv("Taking", r.taking_party) : null,
              r.court_reporter ? kv("Reporter", r.court_reporter) : null,
              r.billable_hours ? kv("Billed", Number(r.billable_hours).toFixed(2) + "h · " + money(r.billable_amount)) : null,
            ]),
            chip(String(r.status || "noticed").toUpperCase(),
                 r.status === "held" ? C.green : r.status === "confirmed" ? C.gold : C.walnutLight),
          ]),
          r.transcript_summary ? h("div", {
            text: r.transcript_summary,
            style: "margin-top:8px;font-size:12px;color:" + C.muted + ";",
          }) : null,
          h("div", { style: "display:flex;gap:6px;margin-top:10px;" }, [btn("EDIT", function () { openEditDepo(r); }, "quiet")]),
        ]));
      });
    }).catch(function (e) { root.appendChild(note("Depositions unavailable: " + e.message)); });
  }

  function depoFields(r) {
    r = r || {};
    return [
      { name: "deponent_name", label: "Deponent", type: "text", required: true, half: true, value: r.deponent_name },
      { name: "deponent_role", label: "Role", type: "select", half: true, value: r.deponent_role,
        options: ["", "party", "witness", "expert", "PMK", "custodian of records"] },
      { name: "deponent_party", label: "Party", type: "text", half: true, value: r.deponent_party },
      { name: "taking_party", label: "Taking party", type: "select", half: true, value: r.taking_party,
        options: ["", "us", "opposing"] },
      { name: "notice_served_date", label: "Notice served", type: "date", half: true,
        value: r.notice_served_date ? String(r.notice_served_date).slice(0, 10) : "" },
      { name: "scheduled_date", label: "Scheduled date", type: "date", half: true,
        value: r.scheduled_date ? String(r.scheduled_date).slice(0, 10) : "" },
      { name: "scheduled_time", label: "Time", type: "text", half: true, value: r.scheduled_time, hint: "e.g. 10:00 AM" },
      { name: "location", label: "Location", type: "text", half: true, value: r.location },
      { name: "remote_platform", label: "Remote platform", type: "text", half: true, value: r.remote_platform },
      { name: "court_reporter", label: "Court reporter", type: "text", half: true, value: r.court_reporter },
      { name: "notes", label: "Notes", type: "textarea", value: r.notes },
    ];
  }

  function openAddDepo() {
    formModal("New deposition", depoFields(null), function (v) {
      return api("/cases/" + CASE_ID + "/depositions", { method: "POST", body: pruneBlank(v) })
        .then(function () { toast("Deposition noticed"); return renderDepos(); });
    }, "ADD");
  }

  function openEditDepo(r) {
    var rate = CASE_ROW && CASE_ROW.hourly_rate ? Number(CASE_ROW.hourly_rate) : null;
    var fields = depoFields(r).concat([
      { name: "status", label: "Status", type: "select", half: true, options: DEPO_STATUSES, value: r.status },
      { name: "billable_hours", label: "Billable hours", type: "number", step: "0.25", half: true, value: r.billable_hours },
      { name: "billable_amount", label: "Billable amount ($)", type: "number", step: "0.01", half: true,
        value: r.billable_amount,
        hint: rate ? "Left blank, hours are priced at the case rate of $" + rate + "/hr."
                   : "Depositions carry no automatic rate resolution — set an amount or the matter's dollar total understates." },
      { name: "transcript_url", label: "Transcript URL", type: "text" },
      { name: "transcript_summary", label: "Transcript summary", type: "textarea", value: r.transcript_summary },
      { name: "key_admissions", label: "Key admissions", type: "textarea", value: r.key_admissions },
    ]);
    formModal("Edit deposition", fields, function (v) {
      var body = pruneBlank(v);
      // Unlike events and communications, depositions get no server-side rate
      // resolution: hours without an amount would silently under-report WIP.
      if (body.billable_hours && !body.billable_amount && rate) {
        body.billable_amount = (Number(body.billable_hours) * rate).toFixed(2);
      }
      return api("/depositions/" + r.id, { method: "PATCH", body: body })
        .then(function () { toast("Deposition updated"); return renderDepos(); });
    });
  }

  // ── Court docket ───────────────────────────────────────────
  function renderDocket() {
    var root = clear(panel("docket"));
    var c = CASE_ROW || {};
    root.appendChild(heading("🔎 COURT DOCKET", h("div", { style: "display:flex;gap:6px;" }, [
      btn(c.court_docket_url ? "CHANGE URL" : "SET URL", openDocketUrl, "quiet"),
      c.court_docket_url ? btn("CHECK NOW", checkDocket) : null,
    ])));

    if (!c.court_docket_url) {
      root.appendChild(note("No court portal URL set. Paste the case's docket page and the checker will pull hearings, filings, and orders, and sync trial and CMC dates back onto the case."));
      return Promise.resolve();
    }

    var snap = c.docket_snapshot || {};
    root.appendChild(card([
      h("a", { href: c.court_docket_url, target: "_blank", rel: "noopener",
               text: c.court_docket_url, style: "color:" + C.gold + ";font-size:12px;word-break:break-all;" }),
      kv("Last checked", c.last_docket_check_at ? fmtDate(c.last_docket_check_at) : "never"),
      c.last_docket_change_at ? kv("Last change", fmtDate(c.last_docket_change_at)) : null,
      c.docket_last_error ? h("div", {
        text: "⚠️ " + c.docket_last_error,
        style: "color:" + C.waxRed + ";font-size:12px;margin-top:6px;",
      }) : null,
      snap.judge ? kv("Judge", snap.judge + (snap.department ? " · Dept " + snap.department : "")) : null,
      snap.current_status ? kv("Status", snap.current_status) : null,
      snap.next_hearing && snap.next_hearing.date
        ? kv("Next hearing", fmtDate(snap.next_hearing.date) +
             (snap.next_hearing.time ? " at " + snap.next_hearing.time : "") +
             (snap.next_hearing.type ? " — " + snap.next_hearing.type : ""))
        : null,
    ]));

    var hist = h("div", {});
    root.appendChild(hist);
    return api("/cases/" + CASE_ID + "/docket-checks?limit=10").then(function (d) {
      var checks = d.checks || [];
      if (!checks.length) return;
      hist.appendChild(h("div", {
        text: "CHECK HISTORY",
        style: "font-family:Cinzel,serif;font-size:11px;letter-spacing:1.5px;color:" + C.muted + ";margin:14px 0 8px 0;",
      }));
      checks.forEach(function (k) {
        hist.appendChild(card([
          h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;" }, [
            h("span", { text: fmtDate(k.checked_at) + " · " + (k.checked_by || "—"), style: "font-size:12px;color:" + C.muted + ";" }),
            chip(k.success ? (k.changes_detected ? "CHANGED" : "NO CHANGE") : "FAILED",
                 k.success ? (k.changes_detected ? C.ember : C.green) : C.waxRed),
          ]),
          k.changes_summary ? h("div", { text: k.changes_summary, style: "font-size:12px;color:" + C.ink + ";margin-top:6px;white-space:pre-wrap;" }) : null,
          k.error_message ? h("div", { text: k.error_message, style: "font-size:12px;color:" + C.waxRed + ";margin-top:6px;" }) : null,
        ]));
      });
    }).catch(function () { /* history is a nicety, not a requirement */ });
  }

  function openDocketUrl() {
    formModal("Court docket URL", [
      { name: "court_docket_url", label: "Case docket page", type: "text",
        value: (CASE_ROW || {}).court_docket_url || "",
        hint: "The court's public case-summary page for this matter." },
    ], function (v) {
      return api("/cases/" + CASE_ID, { method: "PATCH", body: { court_docket_url: v.court_docket_url } })
        .then(function () { toast("Saved"); return refreshCase().then(renderDocket); });
    });
  }

  function checkDocket() {
    toast("Checking the court docket — this can take up to 35 seconds…");
    api("/cases/" + CASE_ID + "/check-docket", { method: "POST" }).then(function (d) {
      if (!d.success) { toast(d.error || "Docket check failed", true); return refreshCase().then(renderDocket); }
      toast(d.changes ? "Changes detected" : "Docket up to date");
      return refreshCase().then(renderDocket);
    }).catch(function (e) { toast(e.message, true); });
  }

  // ── Financials / budget ────────────────────────────────────
  function renderFinancials() {
    var root = clear(panel("financials"));
    return api("/cases/" + CASE_ID + "/billing-summary").then(function (d) {
      var s = d.summary;
      root.appendChild(heading("💰 FINANCIALS", btn(s && s.matter_budget ? "EDIT BUDGET" : "SET BUDGET",
        function () { openBudget(s); })));
      if (!s) { root.appendChild(note("No billing data yet.")); return; }

      root.appendChild(h("div", {
        style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px;",
      }, [
        statCard("Hours Billed", Number(s.total_hours || 0).toFixed(2) + "h"),
        statCard("Amount Billed", money(s.total_amount)),
        statCard("Retainer", money(s.retainer_amount), "Balance " + money(s.retainer_balance)),
        statCard("Rate", s.hourly_rate ? "$" + s.hourly_rate + "/hr" : "—", s.billing_type || ""),
      ]));

      if (s.matter_budget) {
        var pct = Number(s.pct_of_budget || 0);
        var barColor = s.over_budget ? C.waxRed : s.nearing_budget ? C.ember : C.gold;
        root.appendChild(card([
          h("div", { style: "display:flex;justify-content:space-between;font-size:12px;color:" + C.walnut + ";margin-bottom:6px;" }, [
            h("span", { text: money(s.total_amount) + " of " + money(s.matter_budget) }),
            h("span", { text: pct.toFixed(1) + "%" }),
          ]),
          h("div", { style: "height:10px;border-radius:5px;background:" + C.parchment + ";border:1px solid " + C.border + ";overflow:hidden;" }, [
            h("div", { style: "height:100%;width:" + Math.min(100, pct) + "%;background:" + barColor + ";" }),
          ]),
          h("div", {
            text: s.over_budget
              ? "Over by " + money(Number(s.total_amount) - Number(s.matter_budget))
              : money(s.remaining_budget) + " remaining · alerts at " + s.budget_alert_pct + "%",
            style: "font-size:11px;color:" + (s.over_budget ? C.waxRed : C.muted) + ";margin-top:6px;",
          }),
        ]));
      }

      var rows = s.by_timekeeper || [];
      if (rows.length) {
        root.appendChild(h("div", {
          text: "BY TIMEKEEPER",
          style: "font-family:Cinzel,serif;font-size:11px;letter-spacing:1.5px;color:" + C.muted + ";margin:14px 0 8px 0;",
        }));
        var max = Math.max.apply(null, rows.map(function (r) { return Number(r.total_amount) || 0; })) || 1;
        rows.forEach(function (r) {
          root.appendChild(card([
            h("div", { style: "display:flex;justify-content:space-between;gap:10px;" }, [
              h("strong", { text: r.name, style: "color:" + C.ink + ";" }),
              h("span", { text: money(r.total_amount), style: "color:" + C.emberDeep + ";font-weight:700;" }),
            ]),
            h("div", { style: "height:4px;border-radius:2px;background:" + C.parchment + ";margin:6px 0;overflow:hidden;" }, [
              h("div", { style: "height:100%;width:" + ((Number(r.total_amount) || 0) / max * 100) + "%;background:" + C.gold + ";" }),
            ]),
            h("div", {
              text: Number(r.total_hours || 0).toFixed(2) + "h · " + r.entry_count + " entries · " +
                    (Number(r.total_hours) ? "$" + (Number(r.total_amount) / Number(r.total_hours)).toFixed(0) + "/hr effective" : "—"),
              style: "font-size:11px;color:" + C.muted + ";",
            }),
          ]));
        });
      }

      root.appendChild(card([
        h("div", { text: "WHERE THE HOURS CAME FROM", style: "font-family:Cinzel,serif;font-size:11px;letter-spacing:1.5px;color:" + C.muted + ";margin-bottom:6px;" }),
        kv("Events", Number(s.event_hours || 0).toFixed(2) + "h · " + money(s.event_amount)),
        kv("Communications", Number(s.communication_hours || 0).toFixed(2) + "h · " + money(s.communication_amount)),
        kv("Depositions", Number(s.deposition_hours || 0).toFixed(2) + "h · " + money(s.deposition_amount)),
      ]));
    }).catch(function (e) { root.appendChild(note("Financials unavailable: " + e.message)); });
  }

  function statCard(label, value, sub) {
    return h("div", {
      style: "background:" + C.parchmentLit + ";border:1px solid " + C.border + ";border-radius:6px;padding:14px;",
    }, [
      h("div", { text: label, style: "font-size:10px;color:" + C.muted + ";letter-spacing:1.5px;text-transform:uppercase;font-family:Cinzel,serif;" }),
      h("div", { text: value, style: "font-size:22px;font-weight:700;color:" + C.ink + ";margin-top:4px;" }),
      sub ? h("div", { text: sub, style: "font-size:11px;font-style:italic;color:" + C.walnutLight + ";margin-top:4px;" }) : null,
    ]);
  }

  function openBudget(s) {
    s = s || {};
    formModal("Matter budget", [
      { name: "matter_budget", label: "Budget ($)", type: "number", step: "0.01", half: true,
        value: s.matter_budget, hint: "Clear it to remove the budget and stop burn alerts." },
      { name: "budget_alert_pct", label: "Alert at (%)", type: "number", half: true, value: s.budget_alert_pct || 75 },
      { name: "fee_arrangement_notes", label: "Fee arrangement notes", type: "textarea" },
    ], function (v) {
      return api("/cases/" + CASE_ID + "/budget", {
        method: "PATCH",
        body: {
          matter_budget: v.matter_budget === "" ? null : Number(v.matter_budget),
          budget_alert_pct: num(v.budget_alert_pct),
          fee_arrangement_notes: v.fee_arrangement_notes || null,
        },
      }).then(function () { toast("Budget saved"); return renderFinancials(); });
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  CASE-LEVEL ACTIONS (buttons rendered by the server)
  // ═══════════════════════════════════════════════════════════
  function refreshCase() {
    return api("/cases/" + CASE_ID).then(function (d) { CASE_ROW = d.case; return d.case; });
  }

  function openEditCase() {
    var c = CASE_ROW || {};
    var oc = c.opposing_counsel || {};
    formModal("Edit case", [
      { name: "case_name", label: "Case name", type: "text", required: true, value: c.case_name },
      { name: "jurisdiction", label: "Jurisdiction", type: "select", required: true, half: true,
        value: c.jurisdiction || "CA",
        // A failed catalogue fetch must not make the case uneditable, so fall
        // back to whatever the matter already has rather than an empty select.
        options: (JURISDICTIONS.length
          ? JURISDICTIONS
          : [{ key: c.jurisdiction || "CA", label: c.jurisdiction || "CA" }]
        ).map(function (j) { return { value: j.key, label: j.label }; }),
        hint: "Decides which rule set computes every deadline on this matter." },
      { name: "service_method", label: "How we were served", type: "select", half: true,
        value: c.service_method || "personal",
        options: (SERVICE_METHODS.length ? SERVICE_METHODS
          : ["personal", "mail", "email", "efile", "overnight", "fax"]
        ).map(function (m) { return { value: m, label: m }; }),
        hint: "Drives the service extension. Federal e-service adds nothing; Georgia adds three days." },
      { name: "case_type", label: "Case type", type: "select", half: true, value: c.case_type,
        options: [""].concat(META.case_types || []) },
      { name: "our_role", label: "Our role", type: "select", half: true, value: c.our_role,
        options: [""].concat(META.our_roles || []) },
      { name: "court", label: "Court", type: "text", half: true, value: c.court },
      { name: "county", label: "County", type: "text", half: true, value: c.county },
      { name: "case_number", label: "Case number", type: "text", half: true, value: c.case_number },
      { name: "opposing_party", label: "Opposing party", type: "text", half: true, value: c.opposing_party },
      { name: "filed_date", label: "Filed", type: "date", half: true, value: dateVal(c.filed_date) },
      { name: "service_date", label: "Served", type: "date", half: true, value: dateVal(c.service_date) },
      { name: "statute_of_limitations", label: "Statute of limitations", type: "date", half: true, value: dateVal(c.statute_of_limitations) },
      { name: "cmc_date", label: "CMC", type: "date", half: true, value: dateVal(c.cmc_date) },
      { name: "trial_date", label: "Trial", type: "date", half: true, value: dateVal(c.trial_date),
        hint: "Changing any trigger date regenerates the CCP deadline chain." },
      { name: "answered_date", label: "Answer filed", type: "date", half: true, value: dateVal(c.answered_date) },
      { name: "discovery_cutoff_date", label: "Discovery cutoff (from the order)", type: "date", half: true, value: dateVal(c.discovery_cutoff_date) },
      { name: "judgment_date", label: "Judgment entered / signed", type: "date", half: true, value: dateVal(c.judgment_date),
        hint: "Every post-trial and appellate clock runs from this date." },
      { name: "judgment_notice_date", label: "Notice of entry served", type: "date", half: true, value: dateVal(c.judgment_notice_date),
        hint: "California and Nevada run their clocks from service of notice, not from entry." },
      { name: "verdict_date", label: "Verdict / decision", type: "date", half: true, value: dateVal(c.verdict_date) },
      { name: "amount_in_controversy", label: "Amount in controversy ($)", type: "number", step: "0.01", half: true, value: c.amount_in_controversy },
      { name: "billing_type", label: "Billing", type: "select", half: true, value: c.billing_type,
        options: ["", "hourly", "contingency", "flat", "hybrid", "pro bono"] },
      { name: "hourly_rate", label: "Hourly rate ($)", type: "number", step: "0.01", half: true, value: c.hourly_rate },
      { name: "contingency_pct", label: "Contingency (%)", type: "number", step: "0.1", half: true, value: c.contingency_pct },
      { name: "retainer_amount", label: "Retainer ($)", type: "number", step: "0.01", half: true, value: c.retainer_amount },
      { name: "retainer_balance", label: "Retainer balance ($)", type: "number", step: "0.01", half: true, value: c.retainer_balance },
      { name: "oc_name", label: "Opposing counsel", type: "text", half: true, value: oc.name },
      { name: "oc_firm", label: "…firm", type: "text", half: true, value: oc.firm },
      { name: "oc_email", label: "…email", type: "text", half: true, value: oc.email },
      { name: "oc_phone", label: "…phone", type: "text", half: true, value: oc.phone },
      { name: "internal_notes", label: "Internal notes", type: "textarea", rows: 4, value: c.internal_notes },
    ], function (v) {
      var body = {
        case_name: v.case_name, case_type: v.case_type, our_role: v.our_role,
        jurisdiction: v.jurisdiction, service_method: v.service_method,
        answered_date: v.answered_date, discovery_cutoff_date: v.discovery_cutoff_date,
        judgment_date: v.judgment_date, judgment_notice_date: v.judgment_notice_date,
        verdict_date: v.verdict_date,
        court: v.court, county: v.county, case_number: v.case_number,
        opposing_party: v.opposing_party,
        filed_date: v.filed_date, service_date: v.service_date,
        statute_of_limitations: v.statute_of_limitations,
        cmc_date: v.cmc_date, trial_date: v.trial_date,
        amount_in_controversy: v.amount_in_controversy,
        billing_type: v.billing_type, hourly_rate: v.hourly_rate,
        contingency_pct: v.contingency_pct,
        retainer_amount: v.retainer_amount, retainer_balance: v.retainer_balance,
        internal_notes: v.internal_notes,
        opposing_counsel: {
          name: v.oc_name || "", firm: v.oc_firm || "",
          email: v.oc_email || "", phone: v.oc_phone || "",
        },
      };
      return api("/cases/" + CASE_ID, { method: "PATCH", body: body })
        .then(function () { location.reload(); });
    });
  }
  function dateVal(d) { return d ? String(d).slice(0, 10) : ""; }

  function timekeeperOptions() {
    return api("/cases/" + CASE_ID + "/team").catch(function () { return { team: [] }; })
      .then(function (d) {
        return (d.team || []).filter(function (m) { return m.user_id; }).map(function (m) {
          return {
            value: m.user_id,
            label: (m.full_name || m.user_name) + " — " + m.role.replace(/_/g, " ") +
                   (m.billing_rate ? " ($" + m.billing_rate + "/hr)" : ""),
            role: m.role,
          };
        });
      });
  }
  // Which team roles bill as attorney time vs paralegal time — the server
  // resolves a rate from whichever id it is given.
  var ATTORNEY_ROLES = ["lead_attorney", "second_chair", "of_counsel", "associate", "contract_attorney"];
  function splitTimekeeper(opts, userId, out) {
    if (!userId) return;
    var picked = opts.filter(function (o) { return String(o.value) === String(userId); })[0];
    if (!picked) return;
    if (ATTORNEY_ROLES.indexOf(picked.role) >= 0) out.attorney_id = Number(userId);
    else out.paralegal_id = Number(userId);
  }

  function openLogEvent() {
    timekeeperOptions().then(function (opts) {
      formModal("Log event", [
        { name: "event_kind", label: "Kind", type: "select", required: true, half: true,
          options: ["filing", "service", "motion", "hearing", "deposition", "order", "discovery", "note", "communication", "settlement"] },
        { name: "event_date", label: "Date", type: "date", half: true, value: new Date().toISOString().slice(0, 10) },
        { name: "title", label: "Title", type: "text", required: true },
        { name: "description", label: "Description", type: "textarea" },
        { name: "ccp_rule", label: "Rule cite", type: "text", half: true },
        { name: "outcome", label: "Outcome", type: "text", half: true },
        { name: "utbms_code", label: "UTBMS task code", type: "select", half: true,
          value: (UTBMS && UTBMS.stage_default && CASE_ROW) ? UTBMS.stage_default[CASE_ROW.stage] : "",
          options: [{ value: "", label: "— none —" }].concat(
            ((UTBMS && UTBMS.tasks) || []).map(function (t) { return { value: t.code, label: t.code + " " + t.label }; })),
          hint: "Buckets this time into a phase budget and onto a LEDES invoice line." },
        { name: "utbms_activity", label: "UTBMS activity", type: "select", half: true, value: "A103",
          options: [{ value: "", label: "— none —" }].concat(
            ((UTBMS && UTBMS.activities) || []).filter(function (a) { return !a.extended; })
              .map(function (a) { return { value: a.code, label: a.code + " " + a.label }; })) },
        { name: "timekeeper", label: "Timekeeper", type: "select", half: true,
          options: [{ value: "", label: "— none —" }].concat(opts),
          hint: "Their own rate applies: team override, then firm default, then the case rate." },
        { name: "billable_hours", label: "Billable hours", type: "number", step: "0.25", half: true },
        { name: "billable_rate", label: "Rate override ($/hr)", type: "number", step: "0.01", half: true,
          hint: "Leave blank to let the server resolve it." },
      ], function (v) {
        var body = {
          event_kind: v.event_kind, event_date: v.event_date || null,
          title: v.title, description: v.description || null,
          ccp_rule: v.ccp_rule || null, outcome: v.outcome || null,
          utbms_code: v.utbms_code || null, utbms_activity: v.utbms_activity || null,
          billable_hours: num(v.billable_hours), billable_rate: num(v.billable_rate),
        };
        splitTimekeeper(opts, v.timekeeper, body);
        return api("/cases/" + CASE_ID + "/events", { method: "POST", body: body }).then(function (d) {
          if (d.budget_alert && d.budget_alert.should_alert) {
            alert("Budget alert: this matter is now at " + d.budget_alert.current_pct + "% of its budget.");
          }
          location.reload();
        });
      }, "LOG");
    });
  }

  function openLogComm() {
    timekeeperOptions().then(function (opts) {
      formModal("Log communication", [
        { name: "kind", label: "With", type: "select", half: true,
          options: ["opposing_counsel", "court", "expert", "witness", "client_update", "other"] },
        { name: "direction", label: "Direction", type: "select", half: true, options: ["outbound", "inbound"] },
        { name: "channel", label: "Channel", type: "select", half: true,
          options: ["email", "phone", "letter", "in-person", "sms"] },
        { name: "contact_name", label: "Contact name", type: "text", half: true },
        { name: "contact_email", label: "Contact email", type: "text", half: true },
        { name: "contact_phone", label: "Contact phone", type: "text", half: true },
        { name: "subject", label: "Subject", type: "text" },
        { name: "body", label: "Body", type: "textarea", rows: 5 },
        { name: "timekeeper", label: "Timekeeper", type: "select", half: true,
          options: [{ value: "", label: "— none —" }].concat(opts) },
        { name: "billable_hours", label: "Billable hours", type: "number", step: "0.25", half: true },
        { name: "utbms_code", label: "UTBMS task code", type: "select", half: true,
          value: (UTBMS && UTBMS.stage_default && CASE_ROW) ? UTBMS.stage_default[CASE_ROW.stage] : "",
          options: [{ value: "", label: "— none —" }].concat(
            ((UTBMS && UTBMS.tasks) || []).map(function (t) { return { value: t.code, label: t.code + " " + t.label }; })) },
        { name: "utbms_activity", label: "UTBMS activity", type: "select", half: true, value: "A106",
          options: [{ value: "", label: "— none —" }].concat(
            ((UTBMS && UTBMS.activities) || []).filter(function (a) { return !a.extended; })
              .map(function (a) { return { value: a.code, label: a.code + " " + a.label }; })) },
      ], function (v) {
        var body = {
          kind: v.kind, direction: v.direction, channel: v.channel,
          utbms_code: v.utbms_code || null, utbms_activity: v.utbms_activity || null,
          subject: v.subject || null, body: v.body || null,
          contact_name: v.contact_name || null, contact_email: v.contact_email || null,
          contact_phone: v.contact_phone || null,
          billable_hours: num(v.billable_hours),
        };
        splitTimekeeper(opts, v.timekeeper, body);
        return api("/cases/" + CASE_ID + "/communications", { method: "POST", body: body })
          .then(function () { location.reload(); });
      }, "LOG");
    });
  }

  function openAddDeadline() {
    formModal("Add deadline", [
      { name: "due_date", label: "Due date", type: "date", required: true, half: true },
      { name: "priority", label: "Priority", type: "select", half: true, options: ["high", "medium", "low"], value: "medium" },
      { name: "description", label: "Description", type: "text", required: true },
      { name: "ccp_rule", label: "CCP rule", type: "text", half: true },
      { name: "reminder_days_before", label: "Remind days before", type: "number", half: true, value: 3 },
    ], function (v) {
      return api("/cases/" + CASE_ID + "/deadlines", {
        method: "POST",
        body: {
          due_date: v.due_date, description: v.description,
          ccp_rule: v.ccp_rule || null, priority: v.priority,
          reminder_days_before: num(v.reminder_days_before),
        },
      }).then(function () { location.reload(); });
    }, "ADD");
  }

  function completeDeadline(id) {
    api("/deadlines/" + id + "/complete", { method: "PATCH" })
      .then(function () { location.reload(); })
      .catch(function (e) { toast(e.message, true); });
  }

  function regenerateDeadlines() {
    if (!confirm("Regenerate the automatic CCP deadline chain from this case's trigger dates? Manually added deadlines are left alone.")) return;
    api("/cases/" + CASE_ID + "/regenerate-deadlines", { method: "POST" })
      .then(function (d) { toast((d.upserted || 0) + " deadlines refreshed"); setTimeout(function () { location.reload(); }, 700); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE WORKSPACE (one screen per lifecycle phase)
  //  ─────────────────────────────────────────────────────────
  //  Four views over the same phase:
  //    Matters   — the queue, triaged, with gates and progress
  //    Checklist — this phase's tasks across every matter,
  //                filterable by role (the case manager's screen)
  //    Documents — the Dropbox files this phase produced
  //    Budget    — UTBMS phase budget vs actual
  // ═══════════════════════════════════════════════════════════
  var ALERT_COLOR = { danger: C.waxRed, warn: C.ember, info: C.walnutLight };
  var ROLE_COLOR = {
    sales: "#0284C7", attorney: "#3E2818", case_manager: "#E0B44E",
    docketing: "#7C3AED", billing: "#166534",
  };
  var ROLE_LABEL = {
    sales: "Sales / Intake", attorney: "Attorney", case_manager: "Case Manager",
    docketing: "Docketing", billing: "Billing",
  };
  var STAGE_VIEW = "matters";
  var STAGE_ROLE = null;
  var STAGE_DATA = null;

  function renderStage() {
    var host = panel("stage");
    var key = host.getAttribute("data-stage-key");
    var root = clear(host);
    root.appendChild(note("Loading " + key.replace(/_/g, " ") + "…"));

    return api("/stage/" + encodeURIComponent(key)).then(function (d) {
      STAGE_DATA = d;
      drawStage(host, key, d);
    }).catch(function (e) {
      clear(root).appendChild(note("Stage workspace unavailable: " + e.message));
    });
  }

  function drawStage(host, key, d) {
    var root = clear(host);
    var st = d.stage || {};
    var pb = d.playbook || {};
    var roll = d.rollup || {};

    // ── What this phase is for ──
    root.appendChild(h("div", {
      style: "border-left:4px solid " + (st.color || C.walnut) + ";background:" + C.parchmentLit +
             ";border:1px solid " + C.border + ";border-left-width:4px;border-radius:6px;padding:14px;margin-bottom:12px;",
    }, [
      h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline;" }, [
        h("div", { text: pb.headline || "", style: "font-family:Cinzel,serif;font-size:14px;color:" + C.ink + ";" }),
        pb.utbms_phase ? chip("UTBMS " + pb.utbms_phase, C.walnutMid, "Time logged here bills to this UTBMS phase") : null,
      ]),
      pb.caution ? h("div", {
        text: pb.caution,
        style: "margin-top:8px;font-size:12px;color:" + C.muted + ";font-style:italic;line-height:1.5;",
      }) : null,
      h("div", { style: "margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:" + C.muted + ";" }, [
        pb.task_count ? h("span", { text: pb.task_count + " standard tasks" }) : null,
        pb.gate_count ? h("span", { text: "· " + pb.gate_count + " gate criteria" }) : null,
        pb.folder ? h("span", { text: "· " + pb.folder + "/" }) : null,
        (pb.kpis || []).length ? h("span", { text: "· tracks: " + pb.kpis.join(", ") }) : null,
      ]),
    ]));

    // ── Rollup ──
    root.appendChild(h("div", {
      style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px;",
    }, [
      statCard("Matters", String(roll.count || 0)),
      statCard("Need Attention", String(roll.at_risk || 0), roll.at_risk ? "danger alerts" : "all clear"),
      statCard("Gate Ready", String(roll.gate_ready || 0), "of " + (roll.count || 0) + " can advance"),
      statCard("Open Tasks", String(roll.tasks_open || 0), roll.tasks_overdue ? roll.tasks_overdue + " overdue" : ""),
      statCard("At Stake", roll.amount_at_stake ? money(roll.amount_at_stake) : "—"),
    ]));

    // ── View switcher ──
    var views = [["matters", "Matters"], ["checklist", "Checklist"], ["documents", "Documents"], ["budget", "Budget"]];
    root.appendChild(h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;" },
      views.map(function (v) {
        var active = STAGE_VIEW === v[0];
        return h("button", {
          type: "button", text: v[1],
          onclick: function () { STAGE_VIEW = v[0]; drawStage(host, key, STAGE_DATA); },
          style: "padding:7px 14px;border-radius:14px;cursor:pointer;font-size:11px;font-family:Cinzel,serif;letter-spacing:1px;" +
                 "border:1px solid " + (active ? C.gold : C.border) + ";background:" + (active ? C.walnut : C.parchmentLit) +
                 ";color:" + (active ? C.goldBright : C.walnut) + ";",
        });
      })));

    var body = h("div", {});
    root.appendChild(body);

    if (STAGE_VIEW === "matters")   return drawMatters(body, key, d);
    if (STAGE_VIEW === "checklist") return drawChecklist(body, key, d);
    if (STAGE_VIEW === "documents") return drawStageDocs(body, key, d);
    if (STAGE_VIEW === "budget")    return drawStageBudget(body, key, d);
  }

  // ── View: matters ──────────────────────────────────────────
  function drawMatters(root, key, d) {
    var st = d.stage || {};
    var roll = d.rollup || {};

    if (roll.next_deadline) {
      var nd = roll.next_deadline;
      var ndDays = daysUntil(nd.due_date);
      root.appendChild(card([
        h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;" }, [
          h("div", {}, [
            h("div", { text: "NEXT UP IN THIS STAGE", style: "font-family:Cinzel,serif;font-size:10px;letter-spacing:1.5px;color:" + C.muted + ";" }),
            h("div", { text: nd.description, style: "font-size:13px;color:" + C.ink + ";margin-top:3px;" }),
            h("div", { text: nd.case_name + (nd.ccp_rule ? " · " + nd.ccp_rule : ""), style: "font-size:11px;color:" + C.muted + ";font-style:italic;" }),
          ]),
          chip(fmtDate(nd.due_date) + (ndDays !== null ? (ndDays < 0 ? " · " + Math.abs(ndDays) + "d LATE" : " · " + ndDays + "d") : ""),
               ndDays !== null && ndDays < 0 ? C.waxRed : ndDays !== null && ndDays <= 14 ? C.ember : C.gold),
        ]),
      ], "border-left:4px solid " + C.gold + ";"));
    }

    var cases = d.cases || [];
    root.appendChild(heading("MATTERS IN " + String(st.label || key).toUpperCase() + " (" + cases.length + ")",
      btn("+ NEW CASE", function () { location.href = "/admin/civil/new"; })));
    if (!cases.length) {
      root.appendChild(note("No active matters in this stage."));
      return;
    }
    cases.forEach(function (c) { root.appendChild(stageCaseCard(c, st, key)); });
  }

  function stageCaseCard(c, st, phaseKey) {
    var worst = c.alerts.some(function (a) { return a.level === "danger"; }) ? "danger"
              : c.alerts.some(function (a) { return a.level === "warn"; }) ? "warn" : null;
    var edge = worst ? ALERT_COLOR[worst] : (st.color || C.border);

    var focusChip = null;
    if (c.focus && c.focus.date) {
      var dd = c.focus.days;
      focusChip = chip(
        c.focus.label + " " + fmtDate(c.focus.date) + (dd !== null ? (dd < 0 ? " · " + Math.abs(dd) + "d ago" : " · " + dd + "d") : ""),
        dd === null ? C.walnutLight : dd < 0 ? C.waxRed : dd <= 30 ? C.waxRed : dd <= 90 ? C.ember : C.gold);
    }

    var prog = c.task_progress;
    return card([
      h("div", { style: "display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;" }, [
        h("div", { style: "min-width:220px;" }, [
          h("a", {
            href: "/admin/civil/case/" + c.id, text: c.case_name,
            style: "font-family:Cinzel,serif;font-size:14px;font-weight:600;color:" + C.ink + ";text-decoration:none;",
          }),
          h("div", {
            text: [c.client_key, c.case_type, c.case_number ? "#" + c.case_number : "", (c.our_role || "").toUpperCase()]
              .filter(Boolean).join(" · "),
            style: "font-size:11px;color:" + C.muted + ";margin-top:3px;",
          }),
        ]),
        h("div", { style: "display:flex;gap:5px;flex-wrap:wrap;align-items:flex-start;" }, [
          c.jurisdiction ? chip(c.jurisdiction, C.walnutMid, "Deadlines computed under this jurisdiction's rules") : null,
          focusChip,
          c.amount_in_controversy ? chip(money(c.amount_in_controversy), C.walnutMid) : null,
          c.files_archived_at ? chip("ARCHIVED", C.walnutLight) : null,
        ]),
      ]),

      // Checklist progress
      prog && prog.total ? h("div", { style: "margin-top:10px;" }, [
        h("div", { style: "display:flex;justify-content:space-between;font-size:11px;color:" + C.muted + ";margin-bottom:3px;" }, [
          h("span", { text: "Checklist " + prog.done + " / " + prog.total +
                            (prog.critical_open ? " · " + prog.critical_open + " critical open" : "") }),
          h("span", { text: prog.pct + "%" }),
        ]),
        h("div", { style: "height:6px;border-radius:3px;background:" + C.parchment + ";overflow:hidden;border:1px solid " + C.border + ";" }, [
          h("div", { style: "height:100%;width:" + prog.pct + "%;background:" +
                     (prog.critical_open ? C.ember : prog.pct === 100 ? C.green : C.gold) + ";" }),
        ]),
      ]) : null,

      c.alerts.length ? h("div", { style: "margin-top:9px;display:flex;flex-direction:column;gap:4px;" },
        c.alerts.map(function (a) {
          return h("div", {
            text: (a.level === "danger" ? "⚠ " : a.level === "warn" ? "• " : "· ") + a.text,
            style: "font-size:12px;color:" + ALERT_COLOR[a.level] + ";" + (a.level === "danger" ? "font-weight:600;" : ""),
          });
        })) : null,

      // Gates
      c.gates && c.gates.length ? h("div", { style: "margin-top:10px;" }, [
        h("div", {
          text: c.gate_ready ? "✓ GATE READY — all criteria met" : "GATE: " + c.gates_open + " of " + c.gates.length + " criteria outstanding",
          style: "font-family:Cinzel,serif;font-size:10px;letter-spacing:1.2px;color:" +
                 (c.gate_ready ? C.green : C.ember) + ";margin-bottom:5px;",
        }),
        h("div", { style: "display:flex;flex-wrap:wrap;gap:4px;" },
          c.gates.map(function (gt) {
            return h("span", {
              text: (gt.ok ? "✓ " : "○ ") + gt.label, title: gt.label,
              style: "font-size:10px;padding:2px 7px;border-radius:9px;max-width:100%;" +
                     "background:" + (gt.ok ? "#E7F0E7" : C.parchment) + ";color:" + (gt.ok ? C.green : C.muted) +
                     ";border:1px solid " + (gt.ok ? C.green : C.border) + ";",
            });
          })),
      ]) : null,

      c.discovery ? h("div", {
        text: c.discovery.total + " discovery set" + (c.discovery.total === 1 ? "" : "s") +
              " · " + c.discovery.overdue + " overdue · " + c.discovery.mtc_soon + " MTC within 30d",
        style: "margin-top:8px;font-size:11px;color:" + C.muted + ";",
      }) : null,

      c.deadlines.length ? h("div", { style: "margin-top:10px;border-top:1px solid " + C.border + ";padding-top:8px;" },
        c.deadlines.slice(0, 5).map(function (dl) {
          var dd2 = daysUntil(dl.due_date);
          return h("div", { style: "display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px;" }, [
            h("span", { text: dl.description, style: "color:" + C.ink + ";flex:1;" }),
            h("span", {
              text: fmtDate(dl.due_date) + (dd2 !== null ? (dd2 < 0 ? " (" + Math.abs(dd2) + "d late)" : " (" + dd2 + "d)") : ""),
              style: "white-space:nowrap;color:" + (dd2 !== null && dd2 < 0 ? C.waxRed : dd2 !== null && dd2 <= 14 ? C.emberDeep : C.muted) + ";",
            }),
          ]);
        }).concat(c.deadlines.length > 5
          ? [h("div", { text: "+" + (c.deadlines.length - 5) + " more", style: "font-size:11px;color:" + C.muted + ";font-style:italic;padding-top:3px;" })]
          : [])) : null,

      // Deadlines the jurisdiction cannot compute — surfaced as work, not hidden.
      (c.unresolved_deadlines || []).length ? h("div", {
        style: "margin-top:8px;padding:7px 9px;background:" + C.parchment + ";border-radius:4px;border-left:3px solid " + C.ember + ";",
      }, [
        h("div", { text: "NEEDS A DATE", style: "font-family:Cinzel,serif;font-size:9px;letter-spacing:1.2px;color:" + C.emberDeep + ";" }),
      ].concat(c.unresolved_deadlines.slice(0, 3).map(function (u) {
        return h("div", { text: u.label + " — " + u.reason, style: "font-size:11px;color:" + C.muted + ";margin-top:2px;" });
      }))) : null,

      h("div", { style: "margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;" }, [
        btn("OPEN MATTER", function () { location.href = "/admin/civil/case/" + c.id; }, "quiet"),
        (!prog || !prog.total)
          ? btn("APPLY CHECKLIST", function () { applyTemplate(c.id, phaseKey); })
          : btn("CHECKLIST", function () { openMatterChecklist(c, phaseKey); }, "quiet"),
        btn("ADVANCE STAGE", function () { openAdvance(c); }),
      ]),
    ], "border-left:4px solid " + edge + ";");
  }

  function applyTemplate(caseId, phase) {
    api("/cases/" + caseId + "/phase-tasks", { method: "POST", body: { phase: phase } })
      .then(function (d) { toast(d.created + " tasks added"); return renderStage(); })
      .catch(function (e) { toast(e.message, true); });
  }

  // ── View: checklist across the phase ───────────────────────
  function drawChecklist(root, key, d) {
    var roles = [null, "attorney", "case_manager", "sales", "docketing", "billing"];
    root.appendChild(h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center;" },
      [h("span", { text: "WHOSE WORK:", style: "font-family:Cinzel,serif;font-size:10px;letter-spacing:1.2px;color:" + C.muted + ";" })]
      .concat(roles.map(function (r2) {
        var active = STAGE_ROLE === r2;
        return h("button", {
          type: "button", text: r2 ? ROLE_LABEL[r2] : "Everyone",
          onclick: function () { STAGE_ROLE = r2; drawStage(panel("stage"), key, STAGE_DATA); },
          style: "padding:5px 11px;border-radius:12px;cursor:pointer;font-size:11px;" +
                 "border:1px solid " + (active ? (r2 ? ROLE_COLOR[r2] : C.gold) : C.border) +
                 ";background:" + (active ? (r2 ? ROLE_COLOR[r2] : C.walnut) : C.parchmentLit) +
                 ";color:" + (active ? C.parchmentLit : C.walnut) + ";",
        });
      }))));

    var holder = h("div", {});
    root.appendChild(holder);
    holder.appendChild(note("Loading the checklist…"));

    var qs = "?phase=" + encodeURIComponent(key) + (STAGE_ROLE ? "&role=" + STAGE_ROLE : "");
    api("/queue" + qs).then(function (q) {
      clear(holder);
      var tasks = q.tasks || [];
      if (!tasks.length) {
        holder.appendChild(note(STAGE_ROLE
          ? "Nothing open for " + ROLE_LABEL[STAGE_ROLE] + " in this phase."
          : "No open tasks in this phase. Apply the checklist to a matter from the Matters view."));
        return;
      }
      // Grouped by matter, because that is how the work is actually done.
      var byCase = {};
      tasks.forEach(function (t2) { (byCase[t2.case_id] = byCase[t2.case_id] || []).push(t2); });
      Object.keys(byCase).forEach(function (cid) {
        var list = byCase[cid];
        var first = list[0];
        holder.appendChild(card([
          h("a", {
            href: "/admin/civil/case/" + cid, text: first.case_name,
            style: "font-family:Cinzel,serif;font-size:13px;font-weight:600;color:" + C.ink + ";text-decoration:none;",
          }),
          h("div", { style: "margin-top:8px;display:flex;flex-direction:column;gap:5px;" },
            list.map(function (t2) { return taskRow(t2, key); })),
        ]));
      });
    }).catch(function (e) { clear(holder).appendChild(note("Checklist unavailable: " + e.message)); });
  }

  function taskRow(t2, phaseKey) {
    var dd = daysUntil(t2.due_date);
    var row = h("div", {
      style: "display:flex;align-items:flex-start;gap:9px;padding:6px 8px;border-radius:4px;background:" +
             C.parchment + ";border-left:3px solid " + (ROLE_COLOR[t2.role] || C.border) + ";",
    }, [
      h("input", {
        type: "checkbox", title: "Mark done",
        onchange: function (e) {
          var done = e.target.checked;
          api("/phase-tasks/" + t2.id, { method: "PATCH", body: { status: done ? "done" : "open" } })
            .then(function () { toast(done ? "Done" : "Reopened"); return renderStage(); })
            .catch(function (err) { toast(err.message, true); e.target.checked = !done; });
        },
        style: "margin-top:3px;flex-shrink:0;",
      }),
      h("div", { style: "flex:1;min-width:0;" }, [
        h("div", { text: t2.label, style: "font-size:12px;color:" + C.ink + ";line-height:1.4;" }),
        h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:3px;font-size:10px;color:" + C.muted + ";" }, [
          h("span", { text: ROLE_LABEL[t2.role] || t2.role }),
          t2.utbms_code ? h("span", { text: "· " + t2.utbms_code }) : null,
          t2.assignee_name ? h("span", { text: "· " + t2.assignee_name }) : null,
          t2.due_date ? h("span", {
            text: "· due " + fmtDate(t2.due_date) + (dd !== null && dd < 0 ? " (" + Math.abs(dd) + "d late)" : ""),
            style: dd !== null && dd < 0 ? "color:" + C.waxRed + ";font-weight:600;" : "",
          }) : null,
        ]),
      ]),
      t2.critical ? chip("CRITICAL", C.waxRed, "Omitting this is a malpractice exposure") : null,
      btn("EDIT", function () { openEditTask(t2); }, "quiet"),
    ]);
    return row;
  }

  function openEditTask(t2) {
    formModal("Task", [
      { name: "label", label: "Task", type: "textarea", value: t2.label, required: true },
      { name: "role", label: "Owner role", type: "select", half: true, value: t2.role,
        options: Object.keys(ROLE_LABEL).map(function (k2) { return { value: k2, label: ROLE_LABEL[k2] }; }) },
      { name: "due_date", label: "Due", type: "date", half: true, value: t2.due_date ? String(t2.due_date).slice(0, 10) : "" },
      { name: "assignee_name", label: "Assigned to", type: "text", half: true, value: t2.assignee_name },
      { name: "utbms_code", label: "UTBMS code", type: "text", half: true, value: t2.utbms_code },
      { name: "status", label: "Status", type: "select", half: true, value: t2.status,
        options: [{ value: "open", label: "Open" }, { value: "in_progress", label: "In progress" },
                  { value: "done", label: "Done" }, { value: "na", label: "Not applicable" }] },
      { name: "notes", label: "Notes", type: "textarea", value: t2.notes },
    ], function (v) {
      return api("/phase-tasks/" + t2.id, { method: "PATCH", body: v })
        .then(function () { toast("Saved"); return renderStage(); });
    });
  }

  function openMatterChecklist(c, phaseKey) {
    var back = h("div", {
      style: "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;display:flex;" +
             "align-items:flex-start;justify-content:center;padding:32px 16px;overflow:auto;",
    });
    var box = h("div", {
      style: "background:" + C.parchment + ";border:1px solid " + C.gold + ";border-radius:8px;padding:18px;max-width:820px;width:100%;",
    }, [
      h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;" }, [
        h("div", { text: c.case_name, style: "font-family:Cinzel,serif;font-size:14px;color:" + C.walnut + ";" }),
        btn("CLOSE", function () { document.body.removeChild(back); }, "quiet"),
      ]),
    ]);
    var list = h("div", { style: "display:flex;flex-direction:column;gap:5px;" });
    box.appendChild(list);
    list.appendChild(note("Loading…"));
    back.appendChild(box);
    back.addEventListener("click", function (e) { if (e.target === back) document.body.removeChild(back); });
    document.body.appendChild(back);

    api("/cases/" + c.id + "/phase-tasks?phase=" + encodeURIComponent(phaseKey)).then(function (d) {
      clear(list);
      (d.tasks || []).forEach(function (t2) {
        var row = taskRow(t2, phaseKey);
        if (t2.status === "done") row.style.opacity = ".55";
        var cb = row.querySelector("input[type=checkbox]");
        if (cb) cb.checked = t2.status === "done";
        list.appendChild(row);
      });
      if (!(d.tasks || []).length) {
        list.appendChild(note("No checklist yet."));
        list.appendChild(btn("APPLY THE " + phaseKey.replace(/_/g, " ").toUpperCase() + " CHECKLIST",
          function () { applyTemplate(c.id, phaseKey); document.body.removeChild(back); }));
      }
    }).catch(function (e) { clear(list).appendChild(note(e.message)); });
  }

  // ── View: documents for this phase ─────────────────────────
  function drawStageDocs(root, key, d) {
    var cases = d.cases || [];
    root.appendChild(heading("DOCUMENTS PRODUCED IN THIS PHASE",
      h("span", { text: (d.playbook && d.playbook.folder) ? d.playbook.folder + "/" : "",
                  style: "font-size:11px;color:" + C.muted + ";font-family:monospace;" })));
    if (!cases.length) { root.appendChild(note("No matters in this stage.")); return; }

    var linked = cases.filter(function (c) { return c.dropbox_path; });
    if (!linked.length) {
      root.appendChild(note("None of these matters has a Dropbox folder linked. Link one from the matter's Documents panel."));
      return;
    }
    linked.forEach(function (c) {
      var box = card([
        h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;" }, [
          h("a", { href: "/admin/civil/case/" + c.id, text: c.case_name,
                   style: "font-family:Cinzel,serif;font-size:13px;font-weight:600;color:" + C.ink + ";text-decoration:none;" }),
          btn("RE-SORT FILES", function () {
            api("/cases/" + c.id + "/files/rephase", { method: "POST" })
              .then(function (r2) { toast(r2.phased + " of " + r2.files + " files sorted into phases"); return renderStage(); })
              .catch(function (e) { toast(e.message, true); });
          }, "quiet"),
        ]),
      ]);
      var filesBox = h("div", { style: "margin-top:8px;" }, [note("Loading files…")]);
      box.appendChild(filesBox);
      root.appendChild(box);

      api("/cases/" + c.id + "/files?phase=" + encodeURIComponent(key)).then(function (f) {
        clear(filesBox);
        var files = (f.files || []).filter(function (x) { return !x.removed_at; });
        if (!files.length) {
          var other = (f.phases || []).reduce(function (n, p) { return n + p.count; }, 0);
          filesBox.appendChild(h("div", {
            text: other
              ? "No files filed to this phase yet (" + other + " in the matter overall). Try RE-SORT FILES."
              : "No files mirrored yet.",
            style: "font-size:12px;color:" + C.muted + ";font-style:italic;",
          }));
          return;
        }
        files.forEach(function (fl) {
          filesBox.appendChild(h("div", {
            style: "display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid " + C.border + ";",
          }, [
            h("a", {
              href: "#", text: fl.name,
              onclick: function (e) {
                e.preventDefault();
                api("/files/" + fl.id + "/link").then(function (r2) {
                  if (r2.url) window.open(r2.url, "_blank", "noopener");
                }).catch(function (err) { toast(err.message, true); });
              },
              style: "flex:1;font-size:12px;color:" + C.ink + ";text-decoration:none;",
            }),
            h("span", { text: fl.relative_folder || "", style: "font-size:10px;color:" + C.muted + ";" }),
            h("span", { text: fl.server_modified ? fmtDate(fl.server_modified) : "", style: "font-size:10px;color:" + C.muted + ";" }),
          ]));
        });
      }).catch(function (e) { clear(filesBox).appendChild(note(e.message)); });
    });
  }

  // ── View: phase budget ─────────────────────────────────────
  function drawStageBudget(root, key, d) {
    var cases = d.cases || [];
    root.appendChild(heading("UTBMS PHASE BUDGET vs ACTUAL",
      h("span", { text: "The report corporate and insurance clients ask for",
                  style: "font-size:11px;font-style:italic;color:" + C.muted + ";" })));
    if (!cases.length) { root.appendChild(note("No matters in this stage.")); return; }

    cases.forEach(function (c) {
      var box = card([
        h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;" }, [
          h("a", { href: "/admin/civil/case/" + c.id, text: c.case_name,
                   style: "font-family:Cinzel,serif;font-size:13px;font-weight:600;color:" + C.ink + ";text-decoration:none;" }),
          h("div", { style: "display:flex;gap:6px;" }, [
            btn("SET PHASE BUDGET", function () { openPhaseBudget(c, d.playbook && d.playbook.utbms_phase); }, "quiet"),
            btn("LEDES", function () { openLedes(c); }, "quiet"),
          ]),
        ]),
      ]);
      var rowsBox = h("div", { style: "margin-top:8px;" }, [note("Loading…")]);
      box.appendChild(rowsBox);
      root.appendChild(box);

      api("/cases/" + c.id + "/phase-budget").then(function (b) {
        clear(rowsBox);
        var rows = (b.rows || []).filter(function (r2) { return r2.budget_amount || r2.actual_amount; });
        if (!rows.length) {
          rowsBox.appendChild(h("div", {
            text: "No phase budget set and no coded time yet.",
            style: "font-size:12px;color:" + C.muted + ";font-style:italic;",
          }));
          return;
        }
        rows.forEach(function (r2) {
          var pct = r2.pct_consumed;
          var barColor = r2.over_budget ? C.waxRed : (pct != null && pct >= 75) ? C.ember : C.gold;
          rowsBox.appendChild(h("div", { style: "padding:6px 0;border-bottom:1px solid " + C.border + ";" }, [
            h("div", { style: "display:flex;justify-content:space-between;gap:10px;font-size:12px;" }, [
              h("span", { text: r2.utbms_phase + " " + r2.short, style: "color:" + C.ink + ";" }),
              h("span", {
                text: money(r2.actual_amount) + (r2.budget_amount ? " of " + money(r2.budget_amount) : " (no budget)"),
                style: "color:" + (r2.over_budget ? C.waxRed : C.muted) + ";font-weight:600;",
              }),
            ]),
            pct != null ? h("div", { style: "height:5px;border-radius:3px;background:" + C.parchment + ";margin-top:4px;overflow:hidden;" }, [
              h("div", { style: "height:100%;width:" + Math.min(100, pct) + "%;background:" + barColor + ";" }),
            ]) : null,
            h("div", {
              text: Number(r2.actual_hours || 0).toFixed(2) + "h" +
                    (pct != null ? " · " + pct + "% consumed" : "") +
                    (r2.variance != null ? " · variance " + money(r2.variance) : ""),
              style: "font-size:10px;color:" + C.muted + ";margin-top:2px;",
            }),
          ]));
        });
        var tot = b.totals || {};
        rowsBox.appendChild(h("div", {
          text: "TOTAL " + money(tot.actual_amount) + (tot.budget_amount ? " of " + money(tot.budget_amount) : "") +
                (tot.pct_consumed != null ? " · " + tot.pct_consumed + "%" : "") +
                (tot.over_phases ? " · " + tot.over_phases + " phase(s) over budget" : ""),
          style: "margin-top:8px;font-family:Cinzel,serif;font-size:12px;color:" +
                 (tot.over_phases ? C.waxRed : C.ink) + ";",
        }));
      }).catch(function (e) { clear(rowsBox).appendChild(note(e.message)); });
    });
  }

  function openPhaseBudget(c, defaultPhase) {
    api("/utbms").then(function (u) {
      formModal("Phase budget — " + c.case_name, [
        { name: "utbms_phase", label: "UTBMS phase", type: "select", required: true, half: true,
          value: defaultPhase || "L100",
          options: (u.phases || []).map(function (p) { return { value: p.key, label: p.key + " " + p.label }; }) },
        { name: "budget_amount", label: "Budget ($)", type: "number", step: "0.01", half: true },
        { name: "budget_hours", label: "Budget hours", type: "number", step: "0.25", half: true },
        { name: "notes", label: "Assumptions", type: "textarea",
          hint: "e.g. assumes no class certification, one round of summary judgment, 250 GB of ESI." },
      ], function (v) {
        return api("/cases/" + c.id + "/phase-budget", { method: "PATCH", body: v })
          .then(function () { toast("Phase budget saved"); return renderStage(); });
      });
    });
  }

  function openLedes(c) {
    api("/cases/" + c.id + "/ledes").then(function (d) {
      var probs = d.problems || [];
      var back = h("div", {
        style: "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;display:flex;" +
               "align-items:flex-start;justify-content:center;padding:32px 16px;overflow:auto;",
      });
      var box = h("div", {
        style: "background:" + C.parchment + ";border:1px solid " + C.gold + ";border-radius:8px;padding:18px;max-width:820px;width:100%;",
      }, [
        h("div", { text: "LEDES 1998B — " + c.case_name,
                   style: "font-family:Cinzel,serif;font-size:14px;letter-spacing:1.2px;text-transform:uppercase;color:" + C.walnut + ";margin-bottom:10px;" }),
        h("div", { text: d.line_count + " billable line(s) · invoice " + (d.invoice || {}).invoice_number,
                   style: "font-size:12px;color:" + C.muted + ";margin-bottom:10px;" }),
        probs.length
          ? h("div", { style: "background:" + C.parchmentLit + ";border-left:3px solid " + C.waxRed + ";padding:9px;border-radius:4px;margin-bottom:10px;" },
              [h("div", { text: probs.length + " line(s) would be rejected by a client e-billing platform:",
                          style: "font-size:12px;color:" + C.waxRed + ";font-weight:600;margin-bottom:5px;" })]
              .concat(probs.slice(0, 8).map(function (p) {
                return h("div", { text: "Line " + p.line + ": " + p.errors.join("; "),
                                  style: "font-size:11px;color:" + C.muted + ";" });
              })))
          : h("div", { text: "✓ Every line passes UTBMS validation.",
                       style: "font-size:12px;color:" + C.green + ";margin-bottom:10px;" }),
        h("textarea", { rows: 10, readonly: "readonly",
          style: "width:100%;box-sizing:border-box;font-family:monospace;font-size:10px;padding:8px;border:1px solid " +
                 C.border + ";border-radius:4px;background:" + C.parchmentLit + ";color:" + C.ink + ";" }),
        h("div", { style: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;" }, [
          btn("CLOSE", function () { document.body.removeChild(back); }, "quiet"),
          btn("DOWNLOAD", function () {
            window.open("/admin/civil/api/cases/" + c.id + "/ledes?download=1", "_blank", "noopener");
          }),
        ]),
      ]);
      box.querySelector("textarea").value = d.file || "";
      back.appendChild(box);
      back.addEventListener("click", function (e) { if (e.target === back) document.body.removeChild(back); });
      document.body.appendChild(back);
    }).catch(function (e) { toast(e.message, true); });
  }

  // Moving a matter on from a stage workspace is the whole point of the screen:
  // you work the phase, then push it forward. The gate criteria are shown
  // first, because advancing past an unmet gate is the thing to think twice about.
  function openAdvance(c) {
    var stages = META.stages || [];
    var here = stages.map(function (s) { return s.key; }).indexOf(c.stage);
    var suggested = here >= 0 && here + 1 < stages.length ? stages[here + 1].key : c.stage;
    var openGates = (c.gates || []).filter(function (gt) { return !gt.ok; });
    formModal("Advance " + c.case_name, [
      { name: "stage", label: "Move to stage", type: "select", required: true, value: suggested,
        options: stages.map(function (s) { return { value: s.key, label: s.label }; }),
        hint: openGates.length
          ? "⚠ " + openGates.length + " gate criterion/criteria not met: " + openGates.map(function (gt) { return gt.label; }).join("; ")
          : "All gate criteria met. Writes a Stage → entry on the matter's timeline and applies the next phase's checklist." },
      { name: "apply_template", label: "Apply the next phase's standard checklist", type: "checkbox", value: true },
    ], function (v) {
      return fetch("/admin/civil/case/" + c.id + "/move-stage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: v.stage }),
      }).then(function (r2) { return r2.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error || "Move failed");
        if (!v.apply_template) { toast("Moved to " + (d.label || v.stage)); return renderStage(); }
        return api("/cases/" + c.id + "/phase-tasks", { method: "POST", body: { phase: v.stage } })
          .catch(function () { return null; })
          .then(function () { toast("Moved to " + (d.label || v.stage) + " and checklist applied"); return renderStage(); });
      });
    }, "MOVE");
  }

  // ═══════════════════════════════════════════════════════════
  //  STAGE TRIAGE
  //  ─────────────────────────────────────────────────────────
  //  A Dropbox import lands every matter in Intake, which is
  //  true of none of them. This proposes where each one actually
  //  belongs, from its own dates and the phases of its documents,
  //  with the reasoning shown. Nothing moves until it is applied.
  // ═══════════════════════════════════════════════════════════
  function renderTriage() {
    var root = clear(panel("triage"));
    root.appendChild(h("div", {
      style: "background:" + C.parchmentLit + ";border:1px solid " + C.border +
             ";border-left:4px solid " + C.gold + ";border-radius:6px;padding:14px;margin-bottom:14px;",
    }, [
      h("div", { text: "Where does each matter actually belong?", style: "font-family:Cinzel,serif;font-size:14px;color:" + C.ink + ";" }),
      h("div", {
        text: "A folder import files every matter as Intake. This reads the matter's own dates — filed, served, answered, trial, judgment — " +
              "and the lifecycle phase of its mirrored documents, and proposes a stage for each. High confidence means two or more " +
              "independent signals agree. Nothing moves until you apply it.",
        style: "margin-top:7px;font-size:12px;color:" + C.muted + ";line-height:1.55;",
      }),
      h("div", { style: "margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;" }, [
        h("label", { text: "Only matters currently in:", style: "font-size:11px;color:" + C.muted + ";" }),
        (function () {
          var sel = h("select", { id: "triageFrom", style: "padding:6px 9px;border:1px solid " + C.border + ";border-radius:4px;background:" + C.parchmentLit + ";font-size:12px;" });
          [{ value: "", label: "Any stage" }].concat((META.stages || []).map(function (s) { return { value: s.key, label: s.label }; }))
            .forEach(function (o) {
              var op = h("option", { value: o.value, text: o.label });
              if (o.value === "intake") op.selected = true;
              sel.appendChild(op);
            });
          return sel;
        })(),
        h("label", { text: "Minimum confidence:", style: "font-size:11px;color:" + C.muted + ";" }),
        (function () {
          var sel = h("select", { id: "triageConf", style: "padding:6px 9px;border:1px solid " + C.border + ";border-radius:4px;background:" + C.parchmentLit + ";font-size:12px;" });
          [["high", "High only"], ["medium", "Medium and up"], ["low", "Anything"]].forEach(function (o) {
            var op = h("option", { value: o[0], text: o[1] });
            if (o[0] === "medium") op.selected = true;
            sel.appendChild(op);
          });
          return sel;
        })(),
        btn("PREVIEW", runTriage),
      ]),
    ]));

    var out = h("div", { id: "triageOut" });
    root.appendChild(out);
    return Promise.resolve();
  }

  function runTriage(apply) {
    var out = clear(document.getElementById("triageOut"));
    var from = (document.getElementById("triageFrom") || {}).value || null;
    var conf = (document.getElementById("triageConf") || {}).value || "medium";
    out.appendChild(note(apply === true ? "Applying…" : "Reading every matter…"));

    return api("/stage-triage", {
      method: "POST",
      body: { apply: apply === true, from_stage: from, min_confidence: conf },
    }).then(function (d) {
      clear(out);
      if (apply === true) {
        toast(d.moved + " matter(s) moved");
      }
      var props = d.proposals || [];
      out.appendChild(h("div", {
        style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px;",
      }, [
        statCard("Considered", String(d.considered || 0)),
        statCard("Would Move", String(props.length)),
        statCard("Eligible", String(d.eligible || 0), "at this confidence"),
        statCard("Moved", String(d.moved || 0), d.dry_run ? "dry run" : "applied"),
      ]));

      if (!props.length) {
        out.appendChild(note("Every matter is already in a stage consistent with its dates and documents."));
        return;
      }

      // Grouped by destination, because that is the decision being made.
      var byTo = {};
      props.forEach(function (p) { (byTo[p.to] = byTo[p.to] || []).push(p); });
      Object.keys(byTo).forEach(function (to) {
        var list = byTo[to];
        var stage = (META.stages || []).filter(function (s) { return s.key === to; })[0] || { label: to, color: C.walnutMid };
        out.appendChild(h("div", {
          style: "margin:16px 0 8px 0;display:flex;align-items:center;gap:8px;",
        }, [
          chip("→ " + stage.label, stage.color || C.walnutMid),
          h("span", { text: list.length + " matter" + (list.length === 1 ? "" : "s"), style: "font-size:12px;color:" + C.muted + ";" }),
        ]));
        list.forEach(function (p) {
          out.appendChild(card([
            h("div", { style: "display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start;" }, [
              h("div", { style: "flex:1;min-width:200px;" }, [
                h("a", { href: "/admin/civil/case/" + p.case_id, text: p.case_name,
                         style: "font-family:Cinzel,serif;font-size:13px;font-weight:600;color:" + C.ink + ";text-decoration:none;" }),
                h("div", { text: p.reasons.join(" · "), style: "font-size:11px;color:" + C.muted + ";margin-top:3px;" }),
                p.error ? h("div", { text: "⚠ " + p.error, style: "font-size:11px;color:" + C.waxRed + ";" }) : null,
              ]),
              h("div", { style: "display:flex;gap:5px;align-items:center;" }, [
                h("span", { text: p.from.replace(/_/g, " "), style: "font-size:11px;color:" + C.muted + ";" }),
                h("span", { text: "→", style: "color:" + C.gold + ";" }),
                chip(p.confidence.toUpperCase(),
                     p.confidence === "high" ? C.green : p.confidence === "medium" ? C.gold : C.walnutLight),
                p.eligible ? null : chip("BELOW FLOOR", C.walnutLight, "Will not move at the selected confidence"),
              ]),
            ]),
          ], p.eligible ? "" : "opacity:.6;"));
        });
      });

      if (d.dry_run && d.eligible) {
        out.appendChild(h("div", { style: "margin-top:18px;display:flex;gap:8px;justify-content:flex-end;" }, [
          btn("APPLY " + d.eligible + " MOVE" + (d.eligible === 1 ? "" : "S"), function () {
            if (!confirm("Move " + d.eligible + " matters to their proposed stages? Each move is logged on the matter's timeline and applies that phase's checklist.")) return;
            runTriage(true);
          }),
        ]));
      }
    }).catch(function (e) {
      clear(out).appendChild(note("Triage failed: " + e.message));
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  WIP REPORT (firm-wide page)
  // ═══════════════════════════════════════════════════════════
  function renderWip() {
    var root = clear(panel("wip"));
    root.appendChild(note("Loading firm work-in-progress…"));
    return api("/wip-report").then(function (d) {
      clear(root);
      var rows = d.cases || [];
      if (!rows.length) { root.appendChild(note("No active matters with recorded time.")); return; }
      var totalAmt = rows.reduce(function (a, r) { return a + (Number(r.total_amount) || 0); }, 0);
      var totalHrs = rows.reduce(function (a, r) { return a + (Number(r.total_hours) || 0); }, 0);
      var over = rows.filter(function (r) { return r.over_budget; });

      root.appendChild(h("div", {
        style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:16px;",
      }, [
        statCard("Matters", String(rows.length)),
        statCard("Unbilled Hours", totalHrs.toFixed(2) + "h"),
        statCard("Work in Progress", money(totalAmt)),
        statCard("Over Budget", String(over.length), over.length ? "needs attention" : ""),
      ]));

      var table = h("table", { style: "width:100%;background:" + C.parchmentLit + ";border:1px solid " + C.border + ";border-radius:6px;border-collapse:collapse;" });
      var head = h("tr", {});
      ["MATTER", "CLIENT", "STAGE", "LEAD", "HOURS", "WIP", "BUDGET", "LAST ACTIVITY"].forEach(function (t, i) {
        head.appendChild(h("th", {
          text: t,
          style: "padding:10px;text-align:" + (i >= 4 && i <= 6 ? "right" : "left") +
                 ";font-size:11px;letter-spacing:1px;color:" + C.parchmentLit + ";",
        }));
      });
      table.appendChild(h("thead", { style: "background:" + C.walnut + ";" }, [head]));
      var tbody = h("tbody", {});
      rows.forEach(function (r) {
        tbody.appendChild(h("tr", { style: "border-bottom:1px solid #E5D5B8;" }, [
          h("td", { style: "padding:10px;" }, [
            h("a", { href: "/admin/civil/case/" + r.case_id, text: r.case_name, style: "color:" + C.ink + ";font-weight:600;text-decoration:none;" }),
          ]),
          h("td", { style: "padding:10px;font-size:12px;color:" + C.muted + ";", text: r.client_key || "—" }),
          h("td", { style: "padding:10px;font-size:12px;", text: String(r.stage || "").replace(/_/g, " ") }),
          h("td", { style: "padding:10px;font-size:12px;", text: r.lead_attorney_name || "—" }),
          h("td", { style: "padding:10px;text-align:right;", text: Number(r.total_hours || 0).toFixed(2) }),
          h("td", { style: "padding:10px;text-align:right;font-weight:600;", text: money(r.total_amount) }),
          h("td", { style: "padding:10px;text-align:right;" }, [
            r.matter_budget
              ? chip(Number(r.pct_of_budget || 0).toFixed(0) + "%", r.over_budget ? C.waxRed : Number(r.pct_of_budget) >= 75 ? C.ember : C.gold)
              : document.createTextNode("—"),
          ]),
          h("td", { style: "padding:10px;font-size:12px;color:" + C.muted + ";", text: r.last_activity_date ? fmtDate(r.last_activity_date) : "—" }),
        ]));
      });
      table.appendChild(tbody);
      root.appendChild(table);
    }).catch(function (e) { clear(root).appendChild(note("WIP report unavailable: " + e.message)); });
  }

  // ═══════════════════════════════════════════════════════════
  //  BOOT
  // ═══════════════════════════════════════════════════════════
  function wireButtons() {
    var map = {
      "edit-case": openEditCase,
      "log-event": openLogEvent,
      "log-comm": openLogComm,
      "add-deadline": openAddDeadline,
      "regenerate-deadlines": regenerateDeadlines,
    };
    document.querySelectorAll("[data-civil-action]").forEach(function (el) {
      var fn = map[el.getAttribute("data-civil-action")];
      if (fn) el.addEventListener("click", fn);
    });
    document.querySelectorAll("[data-civil-complete-deadline]").forEach(function (el) {
      el.addEventListener("click", function () {
        completeDeadline(el.getAttribute("data-civil-complete-deadline"));
      });
    });
  }

  function boot() {
    var host = document.querySelector("[data-case-id]");
    CASE_ID = host ? parseInt(host.getAttribute("data-case-id"), 10) : null;

    if (panel("wip")) { renderWip(); return; }

    // Stage triage needs the stage list for its labels, but no case.
    if (panel("triage")) {
      api("/meta").catch(function () { return {}; }).then(function (m) {
        META = { stages: m.stages || [], case_types: m.case_types || [], our_roles: m.our_roles || [] };
        return renderTriage();
      });
      return;
    }

    // Stage workspaces need the stage list (for the advance picker) but no case.
    if (panel("stage")) {
      api("/meta").catch(function () { return {}; }).then(function (m) {
        META = { stages: m.stages || [], case_types: m.case_types || [], our_roles: m.our_roles || [] };
        return renderStage();
      });
      return;
    }

    if (!CASE_ID) return;

    wireButtons();
    Promise.all([
      api("/meta").catch(function () { return {}; }),
      api("/team/meta").catch(function () { return { roles: [] }; }),
      api("/discovery/meta").catch(function () { return { kinds: [] }; }),
      refreshCase().catch(function () { return null; }),
      api("/jurisdictions").catch(function () { return { jurisdictions: [], service_methods: [] }; }),
      api("/utbms").catch(function () { return null; }),
    ]).then(function (r) {
      META = { stages: r[0].stages || [], case_types: r[0].case_types || [], our_roles: r[0].our_roles || [] };
      TEAM_ROLES = r[1].roles || [];
      DISCOVERY_META = r[2];
      JURISDICTIONS = (r[4] && r[4].jurisdictions) || [];
      SERVICE_METHODS = (r[4] && r[4].service_methods) || [];
      UTBMS = r[5];
      return mountAll();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Exposed for the console and for pages that want to re-render after their
  // own actions (the Dropbox console reloads the board, for instance).
  window.CivilAdmin = { reload: reload, api: api, toast: toast };
})();
