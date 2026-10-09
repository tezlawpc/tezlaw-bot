// ============================================================
//  uscis-page.js — the USCIS section, where a person can find it
//  ─────────────────────────────────────────────────────────
//  "i don't see the UCSIS form in the web." (JJ, 2026-10-09)
//
//  It was all there and all of it was reachable only from inside a client
//  profile: the G-28, the twelve combo packages, the edition tracker. None
//  of it was in the sidebar, so from the front of the app the work did not
//  exist. A feature nobody can find is a feature nobody has.
//
//  This is the index. It shows what the firm files, which edition of each
//  form is current, which ones are a problem, and what the combo packages
//  are. Filling a form still starts from a client -- a G-28 is about a
//  particular person -- so every route out of here goes through the client
//  list rather than pretending a form can be filled from nowhere.
//
//  No inline script (notify-admin.js:11).
// ============================================================

const F = require("./uscis-forms");
const K = require("./uscis-packages");

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CARD = "background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:18px 20px; margin-bottom:14px;";
const LABEL = "font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#A34C00; font-weight:700; margin:0 0 12px;";

const AREAS = {
  family: "Family", work: "Work and travel", business: "Business and investor",
  removal: "Asylum and removal", naturalization: "Naturalization", all: "Every filing",
};

/** What the last edition check found, if it has ever run. */
function editions() {
  try { return require("./uscis-forms.json"); } catch { return null; }
}

function renderUscisPage() {
  const checked = editions();
  const seen = (checked && checked.forms) || {};

  // Anything the firm should know before it files: an edition that moved
  // since the field map was built, or an OMB number that has lapsed.
  const trouble = [];
  for (const f of F.FORMS) {
    const row = seen[f.id];
    if (!row) continue;
    if (row.omb_expired || (row.expires && new Date(row.expires) < new Date())) {
      trouble.push({ id: f.id, name: f.name, why: `OMB ${row.omb || ""} expired ${row.expires || ""}`.trim() });
    }
  }

  const groups = {};
  for (const f of F.FORMS) (groups[f.area] = groups[f.area] || []).push(f);

  const formRows = Object.entries(groups).map(([area, forms]) => `
    <div style="margin-bottom:16px;">
      <div style="font-size:12px; font-weight:700; color:#2B2523; margin-bottom:6px;">${esc(AREAS[area] || area)}</div>
      <table style="width:100%; border-collapse:collapse;">
        ${forms.map((f) => {
          const row = seen[f.id] || {};
          return `
        <tr>
          <td style="padding:5px 14px 5px 0; font-weight:700; font-size:13px; white-space:nowrap;">
            <a href="${esc(F.urlFor(f.id))}" style="color:#A34C00;" target="_blank" rel="noopener">${esc(f.id.toUpperCase())}</a>
          </td>
          <td style="padding:5px 14px 5px 0; font-size:12px; color:#5E5854;">${esc(f.name)}</td>
          <td style="padding:5px 14px 5px 0; font-size:12px; color:#2B2523; white-space:nowrap;">${
            row.edition ? "Edition " + esc(row.edition) : '<span style="color:#5E5854;">not checked yet</span>'}</td>
          <td style="padding:5px 0; font-size:12px; white-space:nowrap; color:${row.omb_expired ? "#9C2B1E" : "#5E5854"};">${
            row.omb_expired ? "OMB expired" : row.expires ? "OMB to " + esc(row.expires) : ""}</td>
        </tr>`;
        }).join("")}
      </table>
    </div>`).join("");

  const troubleCard = trouble.length ? `
    <div style="background:#FBEDEA; border-left:4px solid #9C2B1E; padding:14px 18px; border-radius:4px; margin-bottom:14px;">
      <strong style="color:#9C2B1E;">${esc(String(trouble.length))} form${trouble.length === 1 ? "" : "s"} to look at before filing</strong>
      <ul style="margin:8px 0 0; padding-left:20px; font-size:13px; line-height:1.7;">
        ${trouble.map((t) => `<li><b>${esc(t.id.toUpperCase())}</b> — ${esc(t.why)}</li>`).join("")}
      </ul>
      <div style="font-size:12px; color:#5E5854; margin-top:8px;">
        This is what USCIS serves at its own address. A lapsed OMB control number is a reason to check
        before filing, not on its own a reason not to.
      </div>
    </div>` : "";

  const packages = K.list({ includeAddons: false }).map((p) => `
    <div style="padding:10px 0; border-bottom:1px solid #F3EFE9;">
      <div style="font-size:13px; font-weight:600; color:#2B2523;">${esc(p.name)}</div>
      <div style="font-size:12px; color:#A34C00;">${esc(p.short)}</div>
    </div>`).join("");

  const when = checked && checked.checked_on
    ? `Editions last read from USCIS on ${esc(checked.checked_on)}.`
    : "The editions have not been read yet — run the USCIS form editions workflow, or wait for Sunday's.";

  return `
  <div class="page-header">
    <h1>USCIS</h1>
  </div>
  <div style="font-size:12px; color:#5E5854; margin:0 0 16px; line-height:1.6;">
    ${when} The daily Federal Register watch reports a form or fee notice the day it publishes;
    the weekly job confirms the silence was real.
  </div>

  ${troubleCard}

  <div style="${CARD}">
    <p style="${LABEL}">Filling a form</p>
    <div style="font-size:13px; color:#2B2523; line-height:1.7;">
      A form is filled for a particular client, so it starts from their file:
      open <a href="/admin/clients" style="color:#A34C00; font-weight:600;">Clients</a>,
      pick the person, then <b>Filing package</b> for a combo or <b>Form G-28</b> on its own.
      Every value comes up for review with where it came from before anything is produced.
    </div>
  </div>

  <div style="${CARD}">
    <p style="${LABEL}">Combo filings — what goes in one envelope</p>
    ${packages}
    <div style="font-size:12px; color:#5E5854; margin-top:10px;">
      Each one lists its forms, who signs each, how many copies, and what has to be true first.
      No fee amounts: those come from USCIS's fee schedule on the day of filing.
    </div>
  </div>

  <div style="${CARD}">
    <p style="${LABEL}">The forms this firm files — ${esc(String(F.FORMS.length))} tracked</p>
    ${formRows}
    <div style="font-size:12px; color:#5E5854; margin-top:6px;">
      Each form number links to USCIS's own copy. The edition shown is what was read off that PDF,
      not typed in here.
    </div>
  </div>

  <div style="margin-bottom:28px;"></div>`;
}

module.exports = { renderUscisPage };
