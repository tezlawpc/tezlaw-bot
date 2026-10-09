// ============================================================
//  uscis-packages-page.js — the combo filing, laid out
//  ─────────────────────────────────────────────────────────
//  A checklist, not a decision. It shows the forms, how many of each,
//  who signs them, which G-28s are needed, what has to be true first, and
//  what gets filed later — and then hands off to the G-28 page with item
//  1.b already written.
//
//  Conditions sit ABOVE the form list on purpose. A package is only the
//  right package if they hold, and a list of forms read first is a list
//  that gets assembled first.
//
//  No inline script, no onclick (notify-admin.js:11).
// ============================================================

const K = require("./uscis-packages");

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CARD = "background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:18px 20px; margin-bottom:14px;";
const LABEL = "font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#A34C00; font-weight:700; margin:0 0 12px;";
const INPUT = "padding:8px 10px; border:1px solid #CFC8BE; border-radius:4px; font-size:14px; box-sizing:border-box;";

/** The picker, shown when no package has been chosen. */
function renderPicker(client) {
  const groups = {};
  for (const p of K.list({ includeAddons: false })) {
    (groups[p.matter_type] = groups[p.matter_type] || []).push(p);
  }
  let labels = {};
  try { labels = require("./retainer").MATTER_LABELS || {}; } catch { /* optional */ }

  const sections = Object.entries(groups).map(([matter, pkgs]) => `
    <div style="${CARD}">
      <p style="${LABEL}">${esc(labels[matter] || matter)}</p>
      ${pkgs.map((p) => `
        <a href="/admin/clients/${encodeURIComponent(client.key)}/filing-package?package=${encodeURIComponent(p.id)}"
           style="display:block; padding:12px 14px; margin-bottom:8px; border:1px solid #E8E3DC; border-radius:6px;
                  text-decoration:none; color:#2B2523;">
          <div style="font-weight:600; font-size:14px;">${esc(p.name)}</div>
          <div style="font-size:12px; color:#A34C00; margin-top:2px;">${esc(p.short)}</div>
          <div style="font-size:12px; color:#5E5854; margin-top:4px; line-height:1.5;">${esc(p.summary)}</div>
        </a>`).join("")}
    </div>`).join("");

  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
    <div>
      <h1 style="margin:0;">Filing package</h1>
      <div style="font-size:13px; color:#5E5854; margin-top:4px;">${esc(client.client_name || client.key)}</div>
    </div>
    <a href="/admin/clients/${encodeURIComponent(client.key)}" style="background:#2B2523; color:#FFFFFF;
      padding:8px 14px; border-radius:6px; text-decoration:none; font-size:12px; font-weight:600;">Client record</a>
  </div>
  <div style="font-size:12px; color:#5E5854; margin:0 0 16px; line-height:1.6;">
    What goes in one envelope, who signs each form, and what has to be true first.
    Nothing here decides whether a package is the right one — that is the point of the conditions on each.
    No fee amounts: USCIS changes them, and a stale number in a checklist is worse than no number.
  </div>
  ${sections}`;
}

function conditionList(items, { tone = "check" } = {}) {
  const style = tone === "check"
    ? "background:#FAF8F5; border-left:4px solid #FF7B00;"
    : "background:#F3EFE9; border-left:4px solid #E8E3DC;";
  return items.map((t) => `
    <div style="${style} padding:10px 14px; border-radius:4px; margin-bottom:7px; font-size:13px; color:#2B2523; line-height:1.55;">
      ${esc(t)}
    </div>`).join("");
}

/** One package, planned for this client. */
function renderPackagePage(client, plan, { derivatives = 0, include = [] } = {}) {
  const p = K.get(plan.package.id);

  const formRows = plan.forms.map((f) => `
    <tr>
      <td style="padding:7px 14px 7px 0; font-weight:700; font-size:13px; color:#2B2523; white-space:nowrap;">${esc(f.label)}</td>
      <td style="padding:7px 14px 7px 0; font-size:12px; color:#5E5854;">${esc(f.title || "")}</td>
      <td style="padding:7px 14px 7px 0; font-size:12px; color:#2B2523; white-space:nowrap;">${esc(f.who)}</td>
      <td style="padding:7px 0; font-size:12px; color:${f.copies > 1 ? "#A34C00" : "#5E5854"}; white-space:nowrap;">
        ${f.copies > 1 ? `&times;${f.copies}` : "1"}${f.per_person ? " <span style=\"color:#5E5854;\">(one each)</span>" : ""}
      </td>
    </tr>`).join("");

  const optional = p.forms.filter((f) => !f.required).map((f) => {
    const on = include.includes(f.id);
    return `
      <label style="display:flex; align-items:flex-start; gap:8px; margin-bottom:7px; font-size:13px; color:#2B2523; line-height:1.5;">
        <input type="checkbox" name="include" value="${esc(f.id)}" ${on ? "checked" : ""} style="margin-top:3px;">
        <span><b>${esc(f.id.toUpperCase())}</b>${f.when ? ` — ${esc(f.when)}` : ""}</span>
      </label>`;
  }).join("");

  const g28Rows = plan.g28s.map((g) => `
    <li style="margin-bottom:6px;">
      <b>${esc(g.who)}</b>, as <b>${esc(g.capacity)}</b> — covering ${esc(g.covers.join(", "))}
    </li>`).join("");

  const derivNote = plan.derivatives.refused
    ? `<div style="background:#FBEDEA; border-left:4px solid #9C2B1E; padding:11px 14px; border-radius:4px; margin:10px 0; font-size:13px; line-height:1.55; color:#2B2523;">
         <b>${esc(String(plan.derivatives.asked))} extra ${plan.derivatives.asked === 1 ? "person was" : "people were"} asked for and not counted.</b>
         ${esc(plan.derivatives.note || "")}
       </div>`
    : plan.derivatives.counted
      ? `<div style="font-size:12px; color:#5E5854; margin:10px 0; line-height:1.55;">
           ${esc(String(plan.derivatives.counted))} ${plan.derivatives.counted === 1 ? "derivative" : "derivatives"} counted,
           each with their own copy of the per-person forms and their own G-28.
           ${esc(plan.derivatives.note || "")}
         </div>`
      : "";

  const laterRows = plan.later.length ? `
    <div style="${CARD}">
      <p style="${LABEL}">Not in this envelope — filed later</p>
      ${plan.later.map((l) => `
        <div style="margin-bottom:10px; font-size:13px; color:#2B2523; line-height:1.55;">
          <b>${esc(l.what)}</b> — ${esc(l.when)}
          ${l.note ? `<div style="font-size:12px; color:#9C2B1E; margin-top:2px;">${esc(l.note)}</div>` : ""}
        </div>`).join("")}
    </div>` : "";

  const alsoRows = plan.also.length ? `
    <div style="${CARD}">
      <p style="${LABEL}">Goes in the envelope, but is not a tracked form</p>
      <ul style="margin:0; padding-left:20px; font-size:13px; color:#2B2523; line-height:1.8;">
        ${plan.also.map((a) => `<li>${esc(a)}</li>`).join("")}
      </ul>
    </div>` : "";

  const g28Link = `/admin/clients/${encodeURIComponent(client.key)}/g28` +
    `?package=${encodeURIComponent(plan.package.id)}` +
    `&form_numbers=${encodeURIComponent(plan.form_numbers)}` +
    (plan.package.capacity ? `&capacity=${encodeURIComponent(plan.package.capacity)}` : "");

  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
    <div>
      <h1 style="margin:0;">${esc(plan.package.name)}</h1>
      <div style="font-size:13px; color:#5E5854; margin-top:4px;">${esc(client.client_name || client.key)} · ${esc(plan.package.short)}</div>
    </div>
    <div style="display:flex; gap:8px;">
      <a href="/admin/clients/${encodeURIComponent(client.key)}/filing-package" style="background:#F3EFE9; color:#2B2523;
        border:1px solid #E8E3DC; padding:8px 14px; border-radius:6px; text-decoration:none; font-size:12px; font-weight:600;">All packages</a>
      <a href="/admin/clients/${encodeURIComponent(client.key)}" style="background:#2B2523; color:#FFFFFF;
        padding:8px 14px; border-radius:6px; text-decoration:none; font-size:12px; font-weight:600;">Client record</a>
    </div>
  </div>

  <div style="font-size:13px; color:#2B2523; margin:0 0 16px; line-height:1.6;">${esc(plan.package.summary)}</div>

  <div style="${CARD}">
    <p style="${LABEL}">Before this is the right package</p>
    ${conditionList(plan.conditions)}
  </div>

  <form method="GET" action="/admin/clients/${encodeURIComponent(client.key)}/filing-package">
    <input type="hidden" name="package" value="${esc(plan.package.id)}">
    <div style="${CARD}">
      <p style="${LABEL}">What is being filed</p>
      ${optional ? `<div style="margin-bottom:14px;">${optional}</div>` : ""}
      <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:14px;">
        <div>
          <label style="font-size:12px; color:#5E5854; display:block; margin-bottom:4px;">Derivatives filing alongside</label>
          <input type="number" name="derivatives" min="0" max="12" value="${esc(String(derivatives))}" style="${INPUT} width:90px;">
        </div>
        <button type="submit" style="background:#F3EFE9; color:#2B2523; border:1px solid #E8E3DC;
          padding:9px 16px; border-radius:6px; font-size:13px; cursor:pointer;">Update the list</button>
      </div>
      ${derivNote}
      <table style="width:100%; border-collapse:collapse;">${formRows}</table>
      <div style="margin-top:12px; font-size:12px; color:#5E5854;">
        ${esc(String(plan.total_forms))} forms in all. Filing fees come from USCIS's fee schedule on the day of filing.
      </div>
    </div>
  </form>

  <div style="${CARD}">
    <p style="${LABEL}">Appearances — one G-28 per person, not one per family</p>
    <ul style="margin:0; padding-left:20px; font-size:13px; color:#2B2523; line-height:1.7;">
      ${g28Rows}
      ${plan.derivative_g28s ? `<li style="margin-bottom:6px;">plus <b>${esc(String(plan.derivative_g28s))}</b> more, one for each derivative filing their own forms</li>` : ""}
    </ul>
    <div style="margin-top:12px;">
      <a href="${g28Link}" style="background:#A34C00; color:#FFFFFF; padding:10px 18px; border-radius:6px;
        text-decoration:none; font-size:13px; font-weight:600; display:inline-block;">Fill the G-28 for this package</a>
    </div>
    <div style="margin-top:8px; font-size:12px; color:#5E5854;">
      Item 1.b will read: <b>${esc(plan.form_numbers)}</b>
    </div>
  </div>

  ${alsoRows}
  ${laterRows}

  <div style="margin-bottom:28px;"></div>`;
}

module.exports = { renderPicker, renderPackagePage };
