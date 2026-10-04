// ============================================================
//  notify-admin.js — FIRM-SIDE VIEW OF BROKER ALERTS
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  Two questions this page exists to answer, both of which were
//  unanswerable before it:
//
//    "Did the broker actually get told?"
//    "Why not?"
//
//  Everything here is plain HTML forms. No inline JavaScript at
//  all — these pages are JS template literals, and an apostrophe
//  inside an onclick handler is eaten by the literal and lands in
//  the browser as a syntax error that kills every script on the
//  page. That took client search down for five hours on
//  2026-09-28. A form cannot break that way.
// ============================================================

const db = require("./db");
const notify = require("./notify");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function ago(ts) {
  if (!ts) return "—";
  const ms = Date.now() - new Date(ts).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function loadConsultants() {
  await notify.initTables();
  const r = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.telegram_chat_id,
            u.notify_email, u.notify_sms, u.notify_telegram, u.notify_app, u.disabled, u.broker_folder,
            (SELECT COUNT(*)::int FROM client_consultants cc
              WHERE cc.consultant_id = u.id AND cc.removed_at IS NULL) AS client_count,
            EXISTS (SELECT 1 FROM push_tokens pt
                     WHERE pt.user_ref = u.id::text AND pt.user_kind IN ('consultant', 'firm')) AS has_app
       FROM admin_users u
      WHERE u.role = 'consultant'
      ORDER BY COALESCE(u.full_name, u.username)`
  );
  return r.rows;
}

/**
 * Every client who has a consultant, for the "send an alert" form: you can
 * only alert about a client somebody would actually be told about.
 * The name comes from a task row, or failing that from the Dropbox folder
 * mapping — a broker's client can be filed before any task exists.
 */
async function loadAlertableClients() {
  await notify.initTables();
  try {
    const r = await db.query(
      `SELECT cc.client_key,
              COALESCE((SELECT MAX(t.client_name) FROM tasks t WHERE t.client_key = cc.client_key),
                       (SELECT m.client_name FROM client_dropbox_mapping m WHERE m.client_key = cc.client_key)) AS client_name,
              string_agg(DISTINCT COALESCE(u.full_name, u.username), ', ') AS consultants
         FROM client_consultants cc
         JOIN admin_users u ON u.id = cc.consultant_id AND COALESCE(u.disabled, FALSE) = FALSE
        WHERE cc.removed_at IS NULL
        GROUP BY cc.client_key
        ORDER BY 2 NULLS LAST
        LIMIT 2000`);
    return r.rows;
  } catch (e) {
    console.warn("[notify-admin] clients:", e.message);
    return [];
  }
}

async function loadOutbox(limit = 60) {
  await notify.initTables();
  const r = await db.query(
    `SELECT o.*, COALESCE(u.full_name, u.username) AS who
       FROM notification_outbox o
       LEFT JOIN admin_users u ON u.id = o.user_id
      ORDER BY o.queued_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

async function counts() {
  await notify.initTables();
  const r = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM notification_outbox GROUP BY status`);
  const out = { pending: 0, sent: 0, failed: 0 };
  for (const row of r.rows) out[row.status] = row.n;
  return out;
}

const STATUS_COLOR = { sent: "#2e7d32", pending: "#B45309", failed: "#A02818" };

function renderPage({ consultants, outbox, totals, health, saved = false, clients = [], sent = null, problem = null }) {
  const chanCell = (on, addr, label) => {
    if (!on) return `<span style="color:#bbb;">off</span>`;
    if (!addr) return `<span style="color:#A02818;font-weight:600;" title="Turned on but nowhere to send">on — missing</span>`;
    return `<span style="color:#2e7d32;font-weight:600;">on</span>`;
  };

  const rows = consultants.map(c => {
    const reach = notify.channelsFor(c);
    const stuck = !reach.length;
    return `
    <tr style="border-bottom:1px solid #eee;${c.disabled ? "opacity:.5;" : ""}">
      <td style="padding:10px 8px;">
        <strong>${esc(c.full_name || c.username)}</strong>
        <div style="font-size:11px;color:#888;">@${esc(c.username)} · ${c.client_count} client${c.client_count === 1 ? "" : "s"}</div>
        ${c.broker_folder
          ? `<div style="font-size:11px;color:#555;margin-top:2px;">📁 ${esc(c.broker_folder)}</div>`
          : `<div style="font-size:11px;color:#B45309;margin-top:2px;">No Dropbox folder linked — their clients cannot be worked out automatically</div>`}
        ${c.broker_folder && c.client_count === 0
          ? `<div style="font-size:11px;color:#B45309;margin-top:2px;">Folder linked but no clients found in it yet</div>`
          : ""}
        ${stuck ? `<div style="font-size:11px;color:#A02818;font-weight:600;margin-top:3px;">Cannot be alerted — ${esc(notify.reasonUnreachable(c))}</div>` : ""}
      </td>
      <td style="padding:10px 8px;">
        <form method="POST" action="/admin/alerts/contact" style="display:flex;gap:6px;align-items:center;margin:0;">
          <input type="hidden" name="user_id" value="${c.id}">
          <input type="email" name="email" value="${esc(c.email || "")}" placeholder="email"
                 style="width:190px;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
          <input type="tel" name="phone" value="${esc(c.phone || "")}" placeholder="phone"
                 style="width:130px;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
          <button type="submit" style="padding:5px 12px;border:1px solid #B8891E;background:#FBF3DE;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">Save</button>
        </form>
      </td>
      <td style="padding:10px 8px;font-size:12px;">${chanCell(c.notify_email !== false, c.email)}</td>
      <td style="padding:10px 8px;font-size:12px;">${chanCell(c.notify_sms === true, c.phone)}</td>
      <td style="padding:10px 8px;font-size:12px;">${chanCell(c.notify_telegram === true, c.telegram_chat_id)}</td>
      <td style="padding:10px 8px;font-size:12px;">${c.notify_app === false
        ? `<span style="color:#bbb;">off</span>`
        : (c.has_app ? `<span style="color:#2e7d32;font-weight:600;">on</span>` : `<span style="color:#888;" title="They have not signed in to the Tara app on a phone">no phone</span>`)}</td>
    </tr>`;
  }).join("");

  const obRows = outbox.map(o => `
    <tr style="border-bottom:1px solid #f0f0f0;">
      <td style="padding:7px 8px;font-size:12px;white-space:nowrap;">${esc(ago(o.queued_at))}</td>
      <td style="padding:7px 8px;font-size:12px;">${esc(o.who || "user " + o.user_id)}</td>
      <td style="padding:7px 8px;font-size:12px;">${esc(notify.labelOf(o.kind))}</td>
      <td style="padding:7px 8px;font-size:12px;">${esc(o.channel)}</td>
      <td style="padding:7px 8px;font-size:12px;color:${STATUS_COLOR[o.status] || "#666"};font-weight:600;">
        ${esc(o.status)}${o.attempts > 1 ? ` <span style="color:#888;font-weight:400;">(${o.attempts} tries)</span>` : ""}
      </td>
      <td style="padding:7px 8px;font-size:11px;color:#A02818;max-width:340px;">${esc(o.last_error || "")}</td>
    </tr>`).join("");

  const down = [];
  if (!health.email) down.push("Email (set SMTP_HOST, or GMAIL_EMAIL + GMAIL_APP_PASSWORD)");
  if (!health.sms) down.push("SMS (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)");
  if (!health.telegram) down.push("Telegram (set TELEGRAM_TOKEN)");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Broker Alerts — Tez Law</title>
<style>
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#faf9f5; color:#0C1C36; margin:0; }
  main { max-width:1150px; margin:24px auto; padding:0 20px; }
  h1 { font-size:24px; margin:0 0 4px; }
  .sub { color:#666; font-size:13px; margin-bottom:20px; }
  .card { background:#fff; border:1px solid #eee; border-radius:8px; padding:18px; margin-bottom:18px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#888; padding:0 8px 8px; border-bottom:2px solid #eee; }
  .pill { display:inline-block; padding:3px 10px; border-radius:12px; font-size:12px; font-weight:600; margin-right:6px; }
</style></head><body><main>
  <h1>Broker Alerts</h1>
  <div class="sub">Who gets told when something happens on their client &mdash; and whether it actually went out.
    <a href="/admin/clients" style="margin-left:10px;">&larr; Clients</a></div>

  ${saved ? `<div class="card" style="border-left:4px solid #2e7d32;background:#f4faf5;">Saved.</div>` : ""}
  ${sent ? `<div class="card" style="border-left:4px solid #2e7d32;background:#f4faf5;">${esc(sent)}</div>` : ""}
  ${problem ? `<div class="card" style="border-left:4px solid #A02818;background:#fdf3f1;">${esc(problem)}</div>` : ""}

  <div class="card">
    <h3 style="margin:0 0 4px;font-size:16px;">Send an alert now</h3>
    <div style="font-size:12px;color:#888;margin-bottom:12px;">
      Tells the consultant(s) on a client that something happened. They get the headline you pick and a link to sign in &mdash;
      there is no message box, on purpose: the substance stays behind the login.
      Court mail, hearings and deadlines already send on their own; this is for everything else.
      <a href="/admin/consultant-tasks" style="margin-left:6px;">Consultant tasks waiting for approval &rarr;</a>
    </div>
    ${clients.length ? `
    <form method="POST" action="/admin/alerts/send" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0;">
      <select name="client_key" required style="flex:2;min-width:260px;padding:7px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;">
        <option value="">&mdash; client &mdash;</option>
        ${clients.map(c => `<option value="${esc(c.client_key)}">${esc(c.client_name || c.client_key)} &middot; ${esc(c.consultants || "")}</option>`).join("")}
      </select>
      <select name="kind" required style="flex:1;min-width:190px;padding:7px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;">
        <option value="">&mdash; what happened &mdash;</option>
        ${["update", "action", "document", "status", "court_mail", "hearing_set", "hearing_moved", "deadline"].filter(k => notify.KINDS[k])
          .map(k => `<option value="${k}">${esc(notify.KINDS[k].label)}</option>`).join("")}
      </select>
      <button type="submit" style="padding:8px 16px;border:1px solid #2B2523;background:#2B2523;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;">Send</button>
    </form>` : `<div style="font-size:13px;color:#888;">No client has a consultant assigned yet.</div>`}
  </div>

  ${down.length ? `<div class="card" style="border-left:4px solid #B45309;background:#fffaf3;">
    <strong>Not configured on the server</strong>
    <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;line-height:1.7;color:#555;">
      ${down.map(d => `<li>${esc(d)}</li>`).join("")}
    </ul>
    <div style="font-size:12px;color:#888;margin-top:8px;">Alerts on these channels are queued, not lost. They go out on the next sweep once the settings are in place.</div>
  </div>` : ""}

  <div class="card">
    <span class="pill" style="background:#e8f5e9;color:#2e7d32;">${totals.sent} sent</span>
    <span class="pill" style="background:#fff4e5;color:#B45309;">${totals.pending} waiting</span>
    <span class="pill" style="background:#fdecea;color:#A02818;">${totals.failed} gave up</span>
    <form method="POST" action="/admin/alerts/flush" style="display:inline;margin-left:10px;">
      <button type="submit" style="padding:6px 14px;border:1px solid #ccc;background:#fff;border-radius:5px;cursor:pointer;font-size:12px;">Try the waiting ones now</button>
    </form>
    <form method="POST" action="/admin/alerts/relink" style="display:inline;margin-left:6px;">
      <button type="submit" style="padding:6px 14px;border:1px solid #ccc;background:#fff;border-radius:5px;cursor:pointer;font-size:12px;"
        title="Re-read the Dropbox folders and assign any new clients to their broker">Pick up newly filed clients</button>
    </form>
  </div>

  <div class="card">
    <h3 style="margin:0 0 4px;font-size:16px;">Consultants</h3>
    <div style="font-size:12px;color:#888;margin-bottom:12px;">
      A consultant is a broker folder in Dropbox, and their clients are the ones filed inside it.
      They turn their own channels on and off in the portal; only you can change the address those point at.
    </div>
    <table>
      <thead><tr><th>Who</th><th>Reach them at</th><th>Email</th><th>Text</th><th>Telegram</th><th>Tara app</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="padding:14px;color:#888;font-size:13px;">No consultant accounts yet.</td></tr>`}</tbody>
    </table>
  </div>

  <div class="card">
    <h3 style="margin:0 0 12px;font-size:16px;">Recent alerts</h3>
    <table>
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>Channel</th><th>Status</th><th>Problem</th></tr></thead>
      <tbody>${obRows || `<tr><td colspan="6" style="padding:14px;color:#888;font-size:13px;">Nothing sent yet.</td></tr>`}</tbody>
    </table>
  </div>
</main></body></html>`;
}

module.exports = { loadConsultants, loadAlertableClients, loadOutbox, counts, renderPage };
