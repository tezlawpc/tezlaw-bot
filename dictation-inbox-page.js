// ============================================================
//  dictation-inbox-page.js — WHAT HAS BEEN RECORDED
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  Plain forms, no inline JavaScript: these pages are template
//  literals, and an apostrophe in an onclick handler reaches the
//  browser as a syntax error that kills every script on the page.
// ============================================================

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function ago(ts) {
  if (!ts) return "";
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  return h < 24 ? h + "h ago" : Math.round(h / 24) + "d ago";
}

const mb = b => b ? (b / 1048576).toFixed(1) + " MB" : "";

const STATE = {
  saved:   { label: "waiting to be transcribed", color: "#B45309" },
  working: { label: "transcribing now",          color: "#0061FF" },
  done:    { label: "transcribed",               color: "#2e7d32" },
  failed:  { label: "did not transcribe",        color: "#A02818" },
};

function row(r) {
  const st = STATE[r.status] || { label: r.status, color: "#666" };
  const who = [r.client_name, r.a_number].filter(Boolean).join(" · ");
  return `
  <tr style="border-bottom:1px solid #eee;">
    <td style="padding:10px 8px; vertical-align:top;">
      <strong>${esc(who || "(no client given)")}</strong>
      <div style="font-size:11px; color:#888;">
        ${esc(ago(r.created_at))}${r.recorded_by ? " · " + esc(r.recorded_by) : ""}${r.bytes ? " · " + mb(r.bytes) : ""}
      </div>
      ${r.hearing_type ? `<div style="font-size:11px; color:#888;">${esc(r.hearing_type)}</div>` : ""}
    </td>
    <td style="padding:10px 8px; vertical-align:top;">
      <span style="color:${st.color}; font-weight:600; font-size:12px;">${st.label}</span>
      ${r.attempts > 1 ? `<span style="color:#888; font-size:11px;"> (${r.attempts} tries)</span>` : ""}
      ${r.error ? `<div style="font-size:11px; color:#A02818; margin-top:3px;">${esc(r.error)}</div>` : ""}
      ${r.status === "done" && r.note_id
        ? `<div style="font-size:12px; margin-top:4px;"><a href="/admin/hearing/notes/${r.note_id}">Open the draft note &rarr;</a></div>` : ""}
      ${r.transcript_id
        ? `<div style="font-size:11px; margin-top:2px;"><a href="/admin/transcripts#t-${r.transcript_id}">Transcript #${r.transcript_id}</a></div>` : ""}
    </td>
    <td style="padding:10px 8px; vertical-align:top; text-align:right;">
      ${r.status === "saved" || r.status === "failed"
        ? `<form method="POST" action="/admin/hearing/notes/dictate/inbox/${r.id}/transcribe" style="margin:0;">
             <button type="submit" style="padding:6px 14px; background:#0C1C36; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:12px;">
               ${r.status === "failed" ? "Try again" : "Transcribe now"}</button>
           </form>`
        : r.status === "working"
          ? `<span style="font-size:12px; color:#888;">in progress</span>`
          : `<span style="font-size:12px; color:#888;">&#10003;</span>`}
    </td>
  </tr>`;
}

function render({ rows, counts, done, failed }) {
  const pill = (n, label, bg, fg) =>
    `<span style="display:inline-block; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:600; margin-right:6px; background:${bg}; color:${fg};">${n || 0} ${label}</span>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Recordings — Tez Law</title>
<style>
 body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf9f5;color:#0C1C36;margin:0;}
 main{max-width:960px;margin:24px auto;padding:0 20px;}
 h1{font-size:24px;margin:0 0 4px;} .sub{color:#666;font-size:13px;margin-bottom:18px;}
 .card{background:#fff;border:1px solid #eee;border-radius:8px;padding:18px;margin-bottom:18px;}
 table{width:100%;border-collapse:collapse;}
 th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888;padding:0 8px 8px;border-bottom:2px solid #eee;}
</style></head><body><main>
  <h1>Recordings</h1>
  <div class="sub">Every dictation is saved here the moment it is uploaded, before any transcribing.
    You can close the laptop as soon as it says saved.
    <a href="/admin/hearing/notes/dictate" style="margin-left:10px;">&larr; Record</a></div>

  ${done ? `<div class="card" style="border-left:4px solid #2e7d32;background:#f4faf5;">Transcribed. <a href="/admin/hearing/notes/${esc(done)}">Open the draft note &rarr;</a></div>` : ""}
  ${failed ? `<div class="card" style="border-left:4px solid #A02818;background:#fdf3f2;">That one did not transcribe — the reason is on the row. The recording is still here and can be tried again.</div>` : ""}

  <div class="card">
    ${pill(counts.saved, "waiting", "#fff4e5", "#B45309")}
    ${pill(counts.working, "in progress", "#e7f0ff", "#0061FF")}
    ${pill(counts.done, "transcribed", "#e8f5e9", "#2e7d32")}
    ${pill(counts.failed, "failed", "#fdecea", "#A02818")}
    <div style="font-size:12px; color:#888; margin-top:8px;">
      Waiting recordings are transcribed automatically every few minutes. The button is for when you want one now.
    </div>
  </div>

  <div class="card">
    <table>
      <thead><tr><th>Recording</th><th>State</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map(row).join("") :
        `<tr><td colspan="3" style="padding:14px; color:#888; font-size:13px;">Nothing recorded yet.</td></tr>`}</tbody>
    </table>
  </div>
</main></body></html>`;
}

module.exports = { render, row, STATE };
