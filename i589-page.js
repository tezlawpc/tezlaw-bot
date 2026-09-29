// ============================================================
//  i589-page.js — THE REVIEW SCREEN
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  Plain forms, no inline JavaScript. These pages are template
//  literals, and an apostrophe inside an onclick handler is
//  eaten by the literal and reaches the browser as a syntax
//  error that kills every script on the page — which took
//  client search down for five hours on 2026-09-28.
//
//  Each row shows what the form said, what the record says, and
//  the file it came from. Nothing changes until Apply is pressed
//  on that row.
// ============================================================

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STATUS = {
  found:      { label: "read",       color: "#2e7d32" },
  unreadable: { label: "unreadable", color: "#B45309" },
  no_form:    { label: "no I-589",   color: "#888"    },
  error:      { label: "error",      color: "#A02818" },
};

function row(p) {
  const st = STATUS[p.status] || { label: p.status, color: "#666" };
  const action = p.action || {};
  const conflicts = action.conflicts || [];
  const applied = !!p.applied_at;
  const notes = Array.isArray(p.notes) ? p.notes : [];

  const cell = (label, onFile, onForm, take, isConflict) => {
    if (!onForm) return `<div style="font-size:12px;color:#aaa;">${label}: nothing on the form</div>`;
    const same = String(onFile || "").replace(/\W+/g, "").toLowerCase()
              === String(onForm).replace(/\W+/g, "").toLowerCase();
    if (same) return `<div style="font-size:12px;color:#888;">${label}: already matches</div>`;
    return `
      <div style="font-size:12px; margin:3px 0;">
        <label style="display:flex; gap:6px; align-items:flex-start; cursor:pointer;">
          <input type="checkbox" name="${take}" value="1" ${applied ? "disabled" : (isConflict ? "" : "checked")} style="margin-top:3px;">
          <span>
            <strong>${label}:</strong> ${esc(onForm)}
            ${onFile ? `<div style="color:${isConflict ? "#B45309" : "#888"};">
              ${isConflict ? "differs from" : "replaces"} what is on file: ${esc(onFile)}</div>` : ""}
          </span>
        </label>
      </div>`;
  };

  const phoneConflict = conflicts.some(c => c.field === "phone");
  const addrConflict = conflicts.some(c => c.field === "address");

  return `
  <tr style="border-bottom:1px solid #eee; ${applied ? "opacity:.55;" : ""}">
    <td style="padding:10px 8px; vertical-align:top;">
      <strong>${esc(p.client_name || p.client_key)}</strong>
      <div style="font-size:11px;">
        <span style="color:${st.color}; font-weight:600;">${st.label}</span>
        ${p.method ? `<span style="color:#888;"> · read from ${p.method === "fields" ? "the form's own fields" : "the page text"}</span>` : ""}
      </div>
      ${p.form_path ? `<div style="font-size:11px; color:#888; word-break:break-all;">${esc(p.form_path)}</div>` : ""}
      ${p.form_modified ? `<div style="font-size:11px; color:#888;">dated ${esc(String(p.form_modified).slice(0, 10))}</div>` : ""}
    </td>
    <td style="padding:10px 8px; vertical-align:top;">
      ${p.status === "found" ? `
        <form method="POST" action="/admin/clients/i589/apply" style="margin:0;">
          <input type="hidden" name="client_key" value="${esc(p.client_key)}">
          ${cell("Phone", p.current_phone, p.found_phone, "take_phone", phoneConflict)}
          ${cell("Address", p.current_address, p.found_address, "take_address", addrConflict)}
          ${applied
            ? `<div style="font-size:11px; color:#2e7d32; margin-top:4px;">Applied ${esc(String(p.applied_at).slice(0, 10))}${p.applied_by ? " by " + esc(p.applied_by) : ""}</div>`
            : `<button type="submit" style="margin-top:6px; padding:5px 12px; background:#F07800; color:#FFF7E4; border:1px solid #A02818; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">Apply to profile</button>`}
        </form>`
        : `<div style="font-size:12px; color:#888;">
             ${p.partial ? `Partly read: ${esc(p.partial)}<br>` : ""}
             ${notes.length ? esc(notes.join("; ")) : "—"}
           </div>`}
    </td>
  </tr>`;
}

function render({ prog, rows, ran }) {
  const s = prog.byStatus || {};
  const pill = (n, label, bg, fg) =>
    `<span style="display:inline-block; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:600; margin-right:6px; background:${bg}; color:${fg};">${n || 0} ${label}</span>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>I-589 addresses — Tez Law</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf9f5;color:#0C1C36;margin:0;}
 main{max-width:1100px;margin:24px auto;padding:0 20px;}
 h1{font-size:24px;margin:0 0 4px;} .sub{color:#666;font-size:13px;margin-bottom:18px;}
 .card{background:#fff;border:1px solid #eee;border-radius:8px;padding:18px;margin-bottom:18px;}
 table{width:100%;border-collapse:collapse;}
 th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888;padding:0 8px 8px;border-bottom:2px solid #eee;}
</style></head><body><main>
  <h1>I-589 addresses</h1>
  <div class="sub">Item 8 (where the client lives) from each client's most recent I-589.
    Item 9, the mailing address, is never used — it is often this firm's own office.
    <a href="/admin/clients" style="margin-left:10px;">&larr; Clients</a></div>

  ${ran ? `<div class="card" style="border-left:4px solid #2e7d32;background:#f4faf5;">Looked at ${esc(ran)} client folder(s).</div>` : ""}

  <div class="card">
    <div style="margin-bottom:10px;">
      ${pill(prog.mapped, "clients with a folder", "#eef2f7", "#0C1C36")}
      ${pill(prog.scanned, "looked at", "#e8f5e9", "#2e7d32")}
      ${pill(prog.remaining, "not yet", "#fff4e5", "#B45309")}
    </div>
    <div style="margin-bottom:12px;">
      ${pill(s.found, "read", "#e8f5e9", "#2e7d32")}
      ${pill(s.unreadable, "unreadable", "#fff4e5", "#B45309")}
      ${pill(s.no_form, "no I-589", "#f4f4f4", "#666")}
      ${pill(s.error, "errors", "#fdecea", "#A02818")}
    </div>
    <form method="POST" action="/admin/clients/i589/scan" style="display:flex; gap:8px; align-items:center;">
      <label style="font-size:13px;">Look at
        <select name="limit" style="padding:5px 8px; border:1px solid #ccc; border-radius:4px;">
          <option value="20">20</option><option value="50">50</option><option value="100">100</option>
        </select>
        more client folders</label>
      <button type="submit" style="padding:6px 14px; background:#0C1C36; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:13px;">Scan</button>
      <span style="font-size:12px; color:#888;">Reads only. Nothing changes on a client record until you press Apply on a row.</span>
    </form>
  </div>

  <div class="card">
    <table>
      <thead><tr><th>Client and form</th><th>What item 8 says</th></tr></thead>
      <tbody>${rows.length ? rows.map(row).join("") :
        `<tr><td colspan="2" style="padding:14px; color:#888; font-size:13px;">Nothing scanned yet. Press Scan above to look at the first batch.</td></tr>`}</tbody>
    </table>
  </div>
</main></body></html>`;
}

module.exports = { render, row, STATUS };
