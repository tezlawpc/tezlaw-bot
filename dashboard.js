// ============================================================
//  TEZ LAW P.C. — TRIAGE DASHBOARD
//  ─────────────────────────────────────────────────────────
//  Monday-morning "what's happening this week" view.
//  Aggregates from hearing_notes, individual_hearing_notes,
//  client_hearing_notices, hearing_reminder_log.
// ============================================================

const db = require("./db");

async function getUpcomingHearings(daysAhead = 14) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const hearings = [];

  try {
    const master = await db.query(
      `SELECT id, client_name, a_number, client_language, client_phone, client_email,
              next_hearing_date AS hearing_date, next_hearing_type AS hearing_type,
              judge_name, case_type
       FROM hearing_notes
       WHERE next_hearing_date IS NOT NULL AND next_hearing_date >= $1 AND next_hearing_date <= $2
       ORDER BY next_hearing_date ASC`,
      [now.toISOString(), cutoff.toISOString()]
    );
    for (const row of master.rows) hearings.push({ ...row, source: "master" });
  } catch (e) { /* silent */ }

  try {
    const indiv = await db.query(
      `SELECT id, client_name, a_number, client_language, client_phone, client_email,
              next_hearing_date AS hearing_date, next_hearing_type AS hearing_type,
              judge_name, case_type
       FROM individual_hearing_notes
       WHERE next_hearing_date IS NOT NULL AND next_hearing_date >= $1 AND next_hearing_date <= $2
       ORDER BY next_hearing_date ASC`,
      [now.toISOString(), cutoff.toISOString()]
    );
    for (const row of indiv.rows) hearings.push({ ...row, source: "individual" });
  } catch (e) { /* silent */ }

  try {
    const notices = await db.query(
      `SELECT id, client_name, a_number, hearing_date, hearing_type, judge_name,
              court_name, court_address, client_key
       FROM client_hearing_notices
       WHERE is_hearing_notice = TRUE AND dismissed_at IS NULL
         AND hearing_date >= $1 AND hearing_date <= $2
       ORDER BY hearing_date ASC`,
      [now.toISOString(), cutoff.toISOString()]
    );
    for (const row of notices.rows) hearings.push({ ...row, source: "notice" });
  } catch (e) { /* silent */ }

  return hearings.sort((a, b) => new Date(a.hearing_date) - new Date(b.hearing_date));
}

async function getUnnotifiedNotices() {
  try {
    const r = await db.query(
      `SELECT n.id, n.client_name, n.a_number, n.client_key, n.hearing_date,
              n.hearing_type, n.court_name, n.judge_name, n.notified_at
       FROM client_hearing_notices n
       WHERE n.is_hearing_notice = TRUE
         AND n.dismissed_at IS NULL
         AND n.notified_at IS NULL
         AND n.hearing_date > NOW()
       ORDER BY n.hearing_date ASC
       LIMIT 20`
    );
    return r.rows;
  } catch (e) { return []; }
}

async function getRecentHearings(limit = 10) {
  const combined = [];
  try {
    const master = await db.query(
      `SELECT id, client_name, a_number, hearing_datetime, hearing_type, case_type,
              sent_to_paralegal_at, created_at, 'master' AS source
       FROM hearing_notes
       WHERE hearing_datetime IS NOT NULL AND hearing_datetime < NOW()
       ORDER BY hearing_datetime DESC LIMIT $1`,
      [limit]
    );
    for (const row of master.rows) combined.push(row);
    const indiv = await db.query(
      `SELECT id, client_name, a_number, hearing_datetime, hearing_type, case_type,
              sent_to_paralegal_at, created_at, 'individual' AS source
       FROM individual_hearing_notes
       WHERE hearing_datetime IS NOT NULL AND hearing_datetime < NOW()
       ORDER BY hearing_datetime DESC LIMIT $1`,
      [limit]
    );
    for (const row of indiv.rows) combined.push(row);
  } catch (e) { /* silent */ }
  return combined.sort((a, b) => new Date(b.hearing_datetime) - new Date(a.hearing_datetime)).slice(0, limit);
}

async function getReminderStats() {
  try {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days' AND success = TRUE)::int AS sent_this_week,
         COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days' AND success = FALSE AND channel != 'skipped')::int AS failed_this_week,
         COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days' AND channel = 'skipped')::int AS skipped_this_week
       FROM hearing_reminder_log`
    );
    return r.rows[0] || { sent_this_week: 0, failed_this_week: 0, skipped_this_week: 0 };
  } catch (e) {
    return { sent_this_week: 0, failed_this_week: 0, skipped_this_week: 0 };
  }
}

async function getClientStats() {
  try {
    const r = await db.query(
      `SELECT
         (SELECT COUNT(DISTINCT client_name) FROM hearing_notes WHERE client_name IS NOT NULL)::int AS master_clients,
         (SELECT COUNT(DISTINCT client_name) FROM individual_hearing_notes WHERE client_name IS NOT NULL)::int AS indiv_clients,
         (SELECT COUNT(*) FROM client_dropbox_mapping WHERE resolved_by = 'bulk_import')::int AS dropbox_imported`
    );
    return r.rows[0] || { master_clients: 0, indiv_clients: 0, dropbox_imported: 0 };
  } catch (e) {
    return { master_clients: 0, indiv_clients: 0, dropbox_imported: 0 };
  }
}

function renderDashboard(data) {
  const hearingNotes = require("./hearing-notes");
  const { upcoming, unnotified, recent, reminderStats, clientStats } = data;

  const bucketize = (hearings) => {
    const now = new Date();
    const today = { label: "Today", entries: [] };
    const tomorrow = { label: "Tomorrow", entries: [] };
    const thisWeek = { label: "This Week", entries: [] };
    const nextWeek = { label: "Next Week", entries: [] };
    const later = { label: "Later", entries: [] };
    for (const h of hearings) {
      const d = new Date(h.hearing_date);
      const diffDays = Math.floor((d - now) / (24 * 60 * 60 * 1000));
      if (diffDays < 0) continue;
      if (diffDays < 1) today.entries.push(h);
      else if (diffDays < 2) tomorrow.entries.push(h);
      else if (diffDays < 7) thisWeek.entries.push(h);
      else if (diffDays < 14) nextWeek.entries.push(h);
      else later.entries.push(h);
    }
    return [today, tomorrow, thisWeek, nextWeek, later].filter(b => b.entries.length);
  };

  const buckets = bucketize(upcoming);

  const renderHearingRow = (h) => {
    const dt = new Date(h.hearing_date);
    const timeStr = dt.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const clientKey = h.client_key || (h.a_number ? "a-" + String(h.a_number).toLowerCase().replace(/[^\w]/g, "") : "n-" + String(h.client_name || "").toLowerCase().replace(/[^\w]+/g, "-"));
    const sourceIcon = { master: "📝", individual: "⚖️", notice: "📄" }[h.source] || "";
    const sourceLink = h.source === "master" ? `/admin/hearing/notes/${h.id}` :
                       h.source === "individual" ? `/admin/hearing/individual/${h.id}` :
                       `/admin/clients/${clientKey}`;
    return `
      <div style="border-left:3px solid #B79C62; padding:8px 12px; margin-bottom:6px; background:#fdf7f0; border-radius:4px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:600; color:#0C1C36; font-size:13px;">
            <a href="/admin/clients/${clientKey}" style="color:#0C1C36; text-decoration:none;">${escapeHtml(h.client_name || "(unnamed)")}</a>
            ${h.a_number ? `<span style="color:#888; font-weight:normal; font-size:11px; margin-left:4px;">${escapeHtml(h.a_number)}</span>` : ""}
          </div>
          <div style="font-size:11px; color:#666;">
            ${sourceIcon} ${escapeHtml(h.hearing_type || "hearing")} · ${timeStr}
            ${h.judge_name ? ` · Judge ${escapeHtml(h.judge_name)}` : ""}
          </div>
        </div>
        <div style="display:flex; gap:4px;">
          <a href="${sourceLink}" style="background:#0C1C36; color:white; padding:4px 10px; border-radius:3px; text-decoration:none; font-size:11px;">Open →</a>
        </div>
      </div>`;
  };

  const upcomingHtml = buckets.length ? buckets.map(b => `
    <div style="margin-bottom:16px;">
      <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; font-weight:600;">${escapeHtml(b.label)} (${b.entries.length})</div>
      ${b.entries.map(renderHearingRow).join("")}
    </div>
  `).join("") : `<div style="text-align:center; padding:30px; color:#888;">No upcoming hearings in the next 14 days.</div>`;

  const unnotifiedHtml = unnotified.length ? unnotified.map(n => {
    const dt = new Date(n.hearing_date);
    const clientKey = n.client_key || (n.a_number ? "a-" + String(n.a_number).toLowerCase().replace(/[^\w]/g, "") : "n-" + String(n.client_name || "").toLowerCase().replace(/[^\w]+/g, "-"));
    return `
      <div style="padding:8px 12px; background:#fef3f0; border-left:3px solid #c62828; border-radius:4px; margin-bottom:6px;">
        <div style="font-weight:600; font-size:13px;">
          <a href="/admin/clients/${clientKey}" style="color:#0C1C36; text-decoration:none;">${escapeHtml(n.client_name || "(unnamed)")}</a>
        </div>
        <div style="font-size:11px; color:#666;">${escapeHtml(n.hearing_type || "hearing")} · ${dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
      </div>`;
  }).join("") : `<div style="color:#888; font-size:12px; font-style:italic; padding:10px 0;">All detected notices have been sent to clients ✓</div>`;

  const recentHtml = recent.length ? recent.map(r => {
    const dt = new Date(r.hearing_datetime);
    const link = r.source === "master" ? `/admin/hearing/notes/${r.id}` : `/admin/hearing/individual/${r.id}`;
    return `
      <div style="padding:6px 0; border-bottom:1px solid #eee; font-size:12px; display:flex; justify-content:space-between; gap:8px;">
        <div>
          <strong>${escapeHtml(r.client_name)}</strong>
          <span style="color:#888; margin-left:4px;">${escapeHtml(r.hearing_type || "")}</span>
        </div>
        <div style="text-align:right;">
          <span style="color:#666; font-size:11px;">${dt.toLocaleDateString()}</span>
          <a href="${link}" style="color:#B79C62; margin-left:8px; text-decoration:none; font-size:11px;">view →</a>
        </div>
      </div>`;
  }).join("") : `<div style="color:#888; font-size:12px; font-style:italic; padding:10px 0;">No recent hearings</div>`;

  const body = `
    <div class="page-header">
      <h1>📊 Triage Dashboard</h1>
      <div style="font-size:13px; color:#666;">Monday morning: everything that needs your attention this week.</div>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin-bottom:20px;">
      <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee; border-top:3px solid #B79C62;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600;">Upcoming Hearings (14d)</div>
        <div style="font-size:26px; font-weight:600; color:#0C1C36; margin-top:4px;">${upcoming.length}</div>
      </div>
      <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee; border-top:3px solid #c62828;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600;">Unnotified Notices</div>
        <div style="font-size:26px; font-weight:600; color:${unnotified.length ? "#c62828" : "#0C1C36"}; margin-top:4px;">${unnotified.length}</div>
      </div>
      <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee; border-top:3px solid #2e7d32;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600;">Reminders Sent (7d)</div>
        <div style="font-size:26px; font-weight:600; color:#0C1C36; margin-top:4px;">${reminderStats.sent_this_week}</div>
        ${reminderStats.failed_this_week ? `<div style="font-size:10px; color:#c62828; margin-top:2px;">${reminderStats.failed_this_week} failed</div>` : ""}
      </div>
      <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee; border-top:3px solid #0061FF;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600;">Total Clients</div>
        <div style="font-size:26px; font-weight:600; color:#0C1C36; margin-top:4px;">${(clientStats.master_clients + clientStats.indiv_clients + clientStats.dropbox_imported)}</div>
        <div style="font-size:10px; color:#888; margin-top:2px;">${clientStats.dropbox_imported} from Dropbox</div>
      </div>
    </div>

    <div style="display:grid; grid-template-columns:2fr 1fr; gap:15px;">
      <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee;">
        <h2 style="margin:0 0 15px 0; font-size:16px; color:#0C1C36;">📅 Upcoming Hearings</h2>
        ${upcomingHtml}
      </div>

      <div>
        <div style="background:white; padding:15px 20px; border-radius:6px; border:1px solid #eee; margin-bottom:12px;">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:#c62828;">⚠️ Needs Client Notification</h3>
          ${unnotifiedHtml}
        </div>

        <div style="background:white; padding:15px 20px; border-radius:6px; border:1px solid #eee;">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:#0C1C36;">📚 Recent Hearings</h3>
          ${recentHtml}
        </div>
      </div>
    </div>`;

  return hearingNotes.renderAdminChrome({ title: "Dashboard", body, activeItem: "dashboard" });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = {
  getUpcomingHearings,
  getUnnotifiedNotices,
  getRecentHearings,
  getReminderStats,
  getClientStats,
  renderDashboard,
};
