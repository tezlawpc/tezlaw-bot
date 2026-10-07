// ============================================================
//  conflicts-page.js — run a conflict check, and keep the record
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  "need to add button for conflict of interest for cases now
//   that we are accepting many cases."
//
//  The button is on each case and it leads here, with the case's
//  own names already filled in: our client, the opposing party,
//  and opposing counsel. One page, because a conflict check is a
//  document the firm may have to produce years later — to a
//  client, to successor counsel, or to the State Bar — and a
//  result that flashed up inside a case tab is not that.
//
//  Plain HTML forms, no script. notify-admin.js records why that
//  is the rule here: these pages are template literals, and an
//  apostrophe inside an onclick reaches the browser as a syntax
//  error that kills every script on the page. A form cannot
//  break that way, and this is a page nobody can afford to have
//  silently stop working.
//
//  The searching is conflicts.js. This file only asks and shows.
// ============================================================

const conflicts = require("./conflicts");

const PAGE = "/admin/conflicts";
const ROLES = ["admin", "manager", "attorney"];

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const nameOf = (u) => (u && (u.n || u.u || u.name || u.username)) || "the firm";

const when = (ts) => {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " PT";
};

// What each outcome means, in the words a lawyer would use. "Cleared" is
// deliberately the only one that says nothing was found, and it is only
// reachable when every source could be read.
const VERDICT = {
  conflict: {
    label: "The firm has been on the other side of this name",
    colour: "#A34C00", band: "#FFF4E8",
    says: "This is a rule 1.7 / 1.9 question before the case is opened. Read the matches below.",
  },
  possible: {
    label: "This name is already in the firm's records",
    colour: "#A34C00", band: "#FFF4E8",
    says: "As our client or a prospective client, not as an opposing party. Check it is the same person and that nothing in the earlier matter is adverse.",
  },
  cleared: {
    label: "No match in any of the firm's records",
    colour: "#2B2523", band: "#E8E3DC",
    says: "Every source was searched and none of them holds this name.",
  },
  incomplete: {
    label: "The check could not be completed",
    colour: "#A34C00", band: "#FFF4E8",
    says: "One or more sources could not be read, so this is not a clear. Run it again before relying on it.",
  },
};

const SIDE_LABEL = {
  client: "our client",
  "prospective client": "a prospective client",
  adverse: "THE OTHER SIDE",
  "opposing counsel": "opposing counsel",
};

function renderResult(result) {
  if (!result) return "";
  const v = VERDICT[result.disposition] || VERDICT.incomplete;

  const row = (h) => `
    <tr style="border-bottom:1px solid #E8E3DC;">
      <td style="padding:9px 12px;">
        <strong style="color:${h.side === "adverse" || h.side === "opposing counsel" ? "#A34C00" : "#2B2523"};">${esc(SIDE_LABEL[h.side] || h.side)}</strong>
      </td>
      <td style="padding:9px 12px;">${esc(h.name)}</td>
      <td style="padding:9px 12px; font-size:13px; color:#5E5854;">${esc(h.matter || "—")}</td>
      <td style="padding:9px 12px; font-size:13px; color:#5E5854;">${esc(h.detail || "—")}</td>
      <td style="padding:9px 12px; font-size:12px; color:#8A827C;">${esc(h.source)}</td>
      <td style="padding:9px 12px; font-size:12px;">matched <em>${esc(h.searched)}</em></td>
    </tr>`;

  const real = result.hits.filter((h) => h.strength !== "weak");
  const weak = result.hits.filter((h) => h.strength === "weak");

  const realTable = real.length ? `
    <table style="width:100%; border-collapse:collapse; font-size:14px; margin:8px 0 22px;">
      <thead><tr style="text-align:left; color:#8A827C; font-size:11px; letter-spacing:.06em; text-transform:uppercase;">
        <th style="padding:6px 12px;">The firm was</th><th style="padding:6px 12px;">Name on file</th>
        <th style="padding:6px 12px;">Matter</th><th style="padding:6px 12px;">Detail</th>
        <th style="padding:6px 12px;">Found in</th><th style="padding:6px 12px;"></th>
      </tr></thead>
      <tbody>${real.map(row).join("")}</tbody>
    </table>` : "";

  const weakTable = weak.length ? `
    <details style="margin-bottom:22px;">
      <summary style="cursor:pointer; color:#5E5854; font-size:14px;">
        ${weak.length} near-miss${weak.length === 1 ? "" : "es"} — an initial, or one name in common. Not a finding; worth an eye.
      </summary>
      <table style="width:100%; border-collapse:collapse; font-size:14px; margin-top:10px;">
        <tbody>${weak.map(row).join("")}</tbody>
      </table>
    </details>` : "";

  const sources = result.unavailable && result.unavailable.length
    ? `<p style="margin:0; font-size:13px; color:#A34C00;">
         <strong>${result.sources_searched} of ${result.sources_total} sources were searched.</strong>
         These could not be read: ${result.unavailable.map(esc).join(", ")}.
         A check that could not look everywhere is not a clear.
       </p>`
    : `<p style="margin:0; font-size:13px; color:#5E5854;">
         All ${result.sources_total} sources searched · ${result.parties_compared.toLocaleString()} names compared.
       </p>`;

  return `
    <section style="border:1px solid #E8E3DC; border-radius:8px; overflow:hidden; margin-bottom:28px;">
      <div style="background:${v.band}; border-left:4px solid ${v.colour}; padding:16px 20px;">
        <div style="font-size:17px; font-weight:600; color:${v.colour};">${esc(v.label)}</div>
        <div style="font-size:14px; color:#1E1B1A; margin-top:4px;">${esc(v.says)}</div>
      </div>
      <div style="padding:20px; background:#FFFFFF;">
        <p style="margin:0 0 14px; font-size:14px; color:#1E1B1A;">
          Checked: ${result.searched.map((n) => `<strong>${esc(n)}</strong>`).join(" · ")}
          ${result.checked_at ? ` — ${esc(when(result.checked_at))}` : ""}
          ${result.id ? ` · record #${result.id}` : ""}
        </p>
        ${result.not_recorded ? `<p style="margin:0 0 14px; padding:10px 14px; background:#FFF4E8; border-left:3px solid #FF7B00; font-size:13px;">
          The check ran but could not be filed: ${esc(result.not_recorded)}. There is no record of it, so run it again.
        </p>` : ""}
        ${realTable || (result.disposition === "cleared" ? "" : "")}
        ${weakTable}
        ${sources}
      </div>
    </section>`;
}

function renderPage({ user, result = null, recent = [], prefill = {}, error = null } = {}) {
  const { renderAdminChrome } = require("./hearing-notes");

  const names = Array.isArray(prefill.names) ? prefill.names.join("\n") : (prefill.names || "");
  const recentRows = recent.map((r) => `
    <tr style="border-bottom:1px solid #E8E3DC;">
      <td style="padding:8px 12px; font-size:13px;">${esc(when(r.checked_at))}</td>
      <td style="padding:8px 12px;">${esc(r.search_name)}</td>
      <td style="padding:8px 12px; font-size:13px;">${esc(r.case_ref || "—")}</td>
      <td style="padding:8px 12px; font-size:13px;">
        <span style="color:${r.disposition === "cleared" ? "#5E5854" : "#A34C00"};">${esc(r.disposition)}</span>
        ${Number(r.hit_count) ? ` · ${r.hit_count} match${Number(r.hit_count) === 1 ? "" : "es"}` : ""}
      </td>
      <td style="padding:8px 12px; font-size:13px; color:#5E5854;">${esc(r.run_by || "—")}</td>
      <td style="padding:8px 12px;"><a href="${PAGE}?id=${r.id}" style="color:#A34C00;">open</a></td>
    </tr>`).join("");

  const body = `
    <div class="page-header"><h1>Conflict check</h1></div>

    <p style="max-width:66ch; color:#1E1B1A; font-size:14px; line-height:1.6;">
      Searches every place the firm records a party's name — our clients and intakes, and the
      <strong>other side</strong>: opposing parties and counsel in civil cases, the adverse insured and
      carrier in PI cases, and opposing parties in federal matters. Each check is filed with the date,
      who ran it and what it found, including when it found nothing.
    </p>

    ${error ? `<div style="margin:0 0 20px; padding:12px 16px; background:#FFF4E8; border-left:3px solid #FF7B00; font-size:14px;">${esc(error)}</div>` : ""}

    ${renderResult(result)}

    <section style="background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:20px; margin-bottom:28px;">
      <form method="POST" action="${PAGE}">
        <label for="cc-names" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:6px;">
          Names to check — one per line
        </label>
        <textarea id="cc-names" name="names" rows="5" required maxlength="4000"
          placeholder="Wei Chen&#10;Acme Holdings LLC&#10;张东升"
          style="width:100%; padding:11px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px; font-family:inherit;">${esc(names)}</textarea>
        <p style="margin:6px 0 16px; font-size:13px; color:#5E5854;">
          Put in every party, not only the client — the opposing party is the one that decides a 1.9 question.
          Name order does not matter, and a name written in Chinese is matched against its Chinese form.
        </p>

        <label for="cc-note" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:6px;">
          Why it is being run <span style="text-transform:none; letter-spacing:0;">(optional, kept with the record)</span>
        </label>
        <input id="cc-note" type="text" name="note" maxlength="500" value="${esc(prefill.note || "")}"
          placeholder="New PI intake, referred by Luna"
          style="width:100%; padding:10px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px; margin-bottom:18px;">

        <input type="hidden" name="kind" value="${esc(prefill.kind || "manual")}">
        <input type="hidden" name="ref" value="${esc(prefill.ref || "")}">
        <button type="submit" style="background:#A34C00; color:#FFFFFF; border:0; padding:11px 22px; border-radius:6px; font-size:15px; font-weight:600; cursor:pointer;">
          Run the check
        </button>
      </form>
    </section>

    ${recent.length ? `
      <h2 style="font-size:16px; color:#2B2523; margin:0 0 10px;">${prefill.ref ? `Checks already run on ${esc(prefill.ref)}` : "Recent checks"}</h2>
      <table style="width:100%; border-collapse:collapse; font-size:14px; background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px;">
        <thead><tr style="text-align:left; color:#8A827C; font-size:11px; letter-spacing:.06em; text-transform:uppercase;">
          <th style="padding:7px 12px;">When</th><th style="padding:7px 12px;">Names</th>
          <th style="padding:7px 12px;">Matter</th><th style="padding:7px 12px;">Outcome</th>
          <th style="padding:7px 12px;">Run by</th><th style="padding:7px 12px;"></th>
        </tr></thead>
        <tbody>${recentRows}</tbody>
      </table>` : ""}
  `;

  return renderAdminChrome({ title: "Conflict check", body, activeItem: "conflict-check" });
}

// Rebuild a stored check into the shape renderResult wants.
function resultFromRow(row) {
  if (!row) return null;
  const hits = Array.isArray(row.matches) ? row.matches : [];
  const unavailable = Array.isArray(row.sources_unavailable) ? row.sources_unavailable : [];
  return {
    id: row.id,
    checked_at: row.checked_at,
    searched: Array.isArray(row.searched_names) && row.searched_names.length
      ? row.searched_names : [row.search_name],
    hits,
    disposition: row.disposition,
    unavailable,
    sources_total: conflicts.SOURCES.length,
    sources_searched: conflicts.SOURCES.length - unavailable.length,
    parties_compared: 0,
  };
}

function mount(app, auth) {
  app.use(PAGE, auth.requireRole(...ROLES));

  app.get(PAGE, async (req, res) => {
    try {
      const q = req.query || {};
      let result = null;
      if (q.id) result = resultFromRow(await conflicts.getCheck(q.id));

      // A case page links here with its own names already in the box.
      const prefill = {
        names: [].concat(q.names || q.name || []).filter(Boolean).slice(0, 20),
        kind: q.kind || "manual",
        ref: q.ref || "",
        note: q.note || "",
      };
      if (result && !prefill.names.length) prefill.names = result.searched;

      const recent = prefill.ref
        ? await conflicts.checksFor(prefill.ref, 10)
        : await conflicts.checksFor(null, 0).catch(() => []);

      res.send(renderPage({ user: req.user, result, recent, prefill }));
    } catch (err) {
      console.error("[conflicts page]:", err.message);
      res.status(500).send(renderPage({ user: req.user, error: "The page could not be built. The reason is in the server log." }));
    }
  });

  app.post(PAGE, async (req, res) => {
    const b = req.body || {};
    const names = String(b.names || "").split(/[\n;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
    const ref = String(b.ref || "").slice(0, 80);
    try {
      if (!names.length) throw new Error("Put in at least one name to check.");
      const out = await conflicts.checkAndRecord({
        names,
        caseKind: String(b.kind || "manual").slice(0, 20),
        caseRef: ref || null,
        exclude: ref ? [ref] : [],
        runBy: nameOf(req.user),
        note: String(b.note || "").slice(0, 500) || null,
      });
      if (out.id) return res.redirect(`${PAGE}?id=${out.id}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`);
      // It ran but was not filed: show it rather than losing it.
      return res.send(renderPage({ user: req.user, result: out, recent: [], prefill: { names, ref, kind: b.kind } }));
    } catch (err) {
      console.error("[conflict check]:", err.message);
      res.status(400).send(renderPage({
        user: req.user, error: err.message,
        prefill: { names, ref, kind: b.kind, note: b.note },
      }));
    }
  });
}

/** The link a case page puts behind its button. */
function linkFor({ kind, ref, names = [] }) {
  const p = new URLSearchParams();
  for (const n of names.filter(Boolean)) p.append("names", n);
  if (kind) p.set("kind", kind);
  if (ref) p.set("ref", ref);
  return `${PAGE}?${p.toString()}`;
}

module.exports = { PAGE, ROLES, renderPage, renderResult, resultFromRow, linkFor, mount };
