// ============================================================
//  TEZ LAW P.C. — TRIAGE DASHBOARD
//  ─────────────────────────────────────────────────────────
//  Monday-morning "what's happening this week" view.
//  Aggregates from every source of firm activity:
//   - hearing_notes / individual_hearing_notes / client_hearing_notices
//   - intake_agent_records (new leads via Zara AI)
//   - motions (drafts pending review)
//   - deadlines (overdue, due soon)
//   - outlook_synced_events (from JJ's Outlook calendar)
//   - hearing_reminder_log (reminder send status)
//   - backup_status / scan_status (system health)
// ============================================================

const db = require("./db");

// ─── Hearings ────────────────────────────────────────

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
    // NOTE: column is hearing_date (not hearing_datetime) on both tables
    const master = await db.query(
      `SELECT id, client_name, a_number, hearing_date AS hearing_datetime, hearing_type, case_type,
              sent_to_paralegal_at, created_at, 'master' AS source
       FROM hearing_notes
       WHERE hearing_date IS NOT NULL AND hearing_date < NOW()
       ORDER BY hearing_date DESC LIMIT $1`,
      [limit]
    );
    for (const row of master.rows) combined.push(row);
    const indiv = await db.query(
      `SELECT id, client_name, a_number, hearing_date AS hearing_datetime, hearing_type, case_type,
              sent_to_paralegal_at, created_at, 'individual' AS source
       FROM individual_hearing_notes
       WHERE hearing_date IS NOT NULL AND hearing_date < NOW()
       ORDER BY hearing_date DESC LIMIT $1`,
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

// ─── Intake ──────────────────────────────────────────

async function getRecentIntakes(limit = 10) {
  try {
    const r = await db.query(
      `SELECT id, client_name, client_phone, client_email, language, practice_area,
              case_description, urgency, classification, notified_jj, created_at
       FROM intake_agent_records
       WHERE created_at > NOW() - INTERVAL '30 days'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return r.rows;
  } catch (e) { return []; }
}

async function getIntakeStats() {
  try {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS this_week,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS this_month,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND urgency IN ('emergency', 'high'))::int AS urgent_this_week,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND notified_jj = FALSE)::int AS unreviewed_this_week
       FROM intake_agent_records`
    );
    return r.rows[0] || { this_week: 0, this_month: 0, urgent_this_week: 0, unreviewed_this_week: 0 };
  } catch (e) {
    return { this_week: 0, this_month: 0, urgent_this_week: 0, unreviewed_this_week: 0 };
  }
}

// ─── Motions ─────────────────────────────────────────

async function getPendingMotions(limit = 10) {
  try {
    const r = await db.query(
      `SELECT id, client_name, a_number, motion_type, title, filing_deadline, status,
              content_markdown IS NOT NULL AS has_content, created_at, updated_at
       FROM motions
       WHERE status IN ('draft', 'reviewed')
       ORDER BY
         CASE WHEN filing_deadline IS NOT NULL THEN filing_deadline ELSE '2099-01-01'::date END ASC,
         updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return r.rows;
  } catch (e) { return []; }
}

async function getMotionStats() {
  try {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'draft')::int AS drafts,
         COUNT(*) FILTER (WHERE status = 'reviewed')::int AS reviewed,
         COUNT(*) FILTER (WHERE status = 'filed' AND filed_at > NOW() - INTERVAL '30 days')::int AS filed_this_month,
         COUNT(*) FILTER (WHERE filing_deadline IS NOT NULL AND filing_deadline < NOW() AND status IN ('draft', 'reviewed'))::int AS past_due
       FROM motions`
    );
    return r.rows[0] || { drafts: 0, reviewed: 0, filed_this_month: 0, past_due: 0 };
  } catch (e) {
    return { drafts: 0, reviewed: 0, filed_this_month: 0, past_due: 0 };
  }
}

// ─── Deadlines ───────────────────────────────────────

async function getUrgentDeadlines(limit = 15) {
  try {
    const r = await db.query(
      `SELECT id, client_name, a_number, due_date, description, priority, source_type
       FROM deadlines
       WHERE status = 'pending'
         AND due_date <= NOW() + INTERVAL '14 days'
       ORDER BY due_date ASC
       LIMIT $1`,
      [limit]
    );
    return r.rows;
  } catch (e) { return []; }
}

async function getDeadlineStats() {
  try {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending' AND due_date < NOW())::int AS past_due,
         COUNT(*) FILTER (WHERE status = 'pending' AND due_date::date = CURRENT_DATE)::int AS due_today,
         COUNT(*) FILTER (WHERE status = 'pending' AND due_date > NOW() AND due_date <= NOW() + INTERVAL '7 days')::int AS due_this_week,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS total_pending
       FROM deadlines`
    );
    return r.rows[0] || { past_due: 0, due_today: 0, due_this_week: 0, total_pending: 0 };
  } catch (e) {
    return { past_due: 0, due_today: 0, due_this_week: 0, total_pending: 0 };
  }
}

// ─── System health ──────────────────────────────────

async function getSystemHealth() {
  const health = {
    last_backup: null,
    last_backup_status: null,
    last_scan: null,
    last_scan_status: null,
    outlook_last_sync: null,
    outlook_status: null,
  };
  try {
    const b = await db.query(
      `SELECT started_at, running, error FROM backup_status
       ORDER BY started_at DESC LIMIT 1`
    );
    if (b.rows[0]) {
      health.last_backup = b.rows[0].started_at;
      health.last_backup_status = b.rows[0].running ? "running" : (b.rows[0].error ? "error" : "ok");
    }
  } catch {}
  try {
    const s = await db.query(
      `SELECT started_at, running, error FROM scan_status
       WHERE scan_type = 'dropbox_notices' ORDER BY started_at DESC LIMIT 1`
    );
    if (s.rows[0]) {
      health.last_scan = s.rows[0].started_at;
      health.last_scan_status = s.rows[0].running ? "running" : (s.rows[0].error ? "error" : "ok");
    }
  } catch {}
  try {
    const o = await db.query(
      `SELECT last_synced_at, last_sync_status FROM outlook_config
       ORDER BY id ASC LIMIT 1`
    );
    if (o.rows[0]) {
      health.outlook_last_sync = o.rows[0].last_synced_at;
      health.outlook_status = o.rows[0].last_sync_status;
    }
  } catch {}
  return health;
}

// ─── Render ──────────────────────────────────────────

function renderDashboard(data) {
  const hearingNotes = require("./hearing-notes");
  const {
    upcoming, unnotified, recent, reminderStats, clientStats,
    intakes, intakeStats, motions, motionStats, deadlines, deadlineStats, health,
  } = data;

  const brand = { gold: "#B79C62", navy: "#0C1C36" };

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
      <div style="border-left:3px solid ${brand.gold}; padding:8px 12px; margin-bottom:6px; background:#fdf7f0; border-radius:4px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:600; color:${brand.navy}; font-size:13px;">
            <a href="/admin/clients/${clientKey}" style="color:${brand.navy}; text-decoration:none;">${escapeHtml(h.client_name || "(unnamed)")}</a>
            ${h.a_number ? `<span style="color:#888; font-weight:normal; font-size:11px; margin-left:4px;">${escapeHtml(h.a_number)}</span>` : ""}
          </div>
          <div style="font-size:11px; color:#666;">
            ${sourceIcon} ${escapeHtml(h.hearing_type || "hearing")} · ${timeStr}
            ${h.judge_name ? ` · Judge ${escapeHtml(h.judge_name)}` : ""}
          </div>
        </div>
        <a href="${sourceLink}" style="background:${brand.navy}; color:white; padding:4px 10px; border-radius:3px; text-decoration:none; font-size:11px;">Open →</a>
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
          <a href="/admin/clients/${clientKey}" style="color:${brand.navy}; text-decoration:none;">${escapeHtml(n.client_name || "(unnamed)")}</a>
        </div>
        <div style="font-size:11px; color:#666;">${escapeHtml(n.hearing_type || "hearing")} · ${dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
      </div>`;
  }).join("") : `<div style="color:#888; font-size:12px; font-style:italic; padding:10px 0;">All notices sent ✓</div>`;

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
          <a href="${link}" style="color:${brand.gold}; margin-left:8px; text-decoration:none; font-size:11px;">view →</a>
        </div>
      </div>`;
  }).join("") : `<div style="color:#888; font-size:12px; font-style:italic; padding:10px 0;">No recent hearings</div>`;

  // ── Intake block ──
  const urgencyColors = { emergency: "#c62828", high: "#f9a825", medium: "#0061FF", low: "#666" };
  const intakeHtml = intakes.length ? intakes.slice(0, 8).map(i => {
    const dt = new Date(i.created_at);
    const relTime = timeAgo(dt);
    const urgencyColor = urgencyColors[i.urgency] || "#666";
    return `
      <div style="padding:8px 12px; background:#f5f9ff; border-left:3px solid ${urgencyColor}; border-radius:4px; margin-bottom:6px;">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600; font-size:13px; color:${brand.navy};">
              ${escapeHtml(i.client_name || "(no name)")}
              ${!i.notified_jj ? '<span style="background:#f9a825; color:white; padding:1px 6px; border-radius:8px; font-size:9px; margin-left:6px;">NEW</span>' : ''}
            </div>
            <div style="font-size:11px; color:#666; margin-top:2px;">
              ${i.practice_area ? `<span style="background:${brand.gold}; color:white; padding:1px 6px; border-radius:8px; font-size:10px;">${escapeHtml(i.practice_area)}</span>` : ""}
              ${i.urgency ? `<span style="color:${urgencyColor}; font-weight:600; margin-left:4px;">${escapeHtml(i.urgency)}</span>` : ""}
              <span style="color:#999; margin-left:4px;">${escapeHtml(relTime)}</span>
            </div>
            ${i.case_description ? `<div style="font-size:11px; color:#555; margin-top:4px; font-style:italic; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(i.case_description.substring(0, 120))}${i.case_description.length > 120 ? "…" : ""}</div>` : ""}
          </div>
        </div>
        <div style="font-size:10px; color:#888; margin-top:4px;">
          ${i.client_phone ? `📞 ${escapeHtml(i.client_phone)}` : ""}
          ${i.client_email ? ` · ✉️ ${escapeHtml(i.client_email)}` : ""}
          ${i.language && i.language !== "en" ? ` · 🌐 ${escapeHtml(i.language)}` : ""}
        </div>
      </div>`;
  }).join("") : `<div style="color:#888; font-size:12px; font-style:italic; padding:10px 0;">No recent intakes.</div>`;

  // ── Motions block ──
  const motionsHtml = motions.length ? motions.slice(0, 8).map(m => {
    const isDue = m.filing_deadline && new Date(m.filing_deadline) < new Date(Date.now() + 7 * 86400000);
    const isOverdue = m.filing_deadline && new Date(m.filing_deadline) < new Date();
    const dueColor = isOverdue ? "#c62828" : isDue ? "#f9a825" : "#666";
    const statusBadge = m.status === "reviewed" ? '<span style="background:#0061FF; color:white; padding:1px 6px; border-radius:8px; font-size:9px;">REVIEWED</span>' : '<span style="background:#B79C62; color:white; padding:1px 6px; border-radius:8px; font-size:9px;">DRAFT</span>';
    return `
      <div style="padding:8px 12px; background:#fdfaf3; border-left:3px solid ${isOverdue ? '#c62828' : brand.gold}; border-radius:4px; margin-bottom:6px;">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
          <div style="flex:1;">
            <div style="font-weight:600; font-size:12px; color:${brand.navy};">
              <a href="/admin/motions/${m.id}" style="color:${brand.navy}; text-decoration:none;">${escapeHtml(m.title || m.motion_type)}</a>
              ${statusBadge}
            </div>
            <div style="font-size:11px; color:#666; margin-top:2px;">
              ${escapeHtml(m.client_name || "(no client)")}
              ${m.a_number ? `<span style="color:#999; font-family:monospace; font-size:10px; margin-left:4px;">${escapeHtml(m.a_number)}</span>` : ""}
              ${m.filing_deadline ? ` · <span style="color:${dueColor};">Due ${new Date(m.filing_deadline).toLocaleDateString()}</span>` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }).join("") : `<div style="color:#888; font-size:12px; font-style:italic; padding:10px 0;">No pending motions.</div>`;

  // ── Deadlines block ──
  const deadlineHtml = deadlines.length ? deadlines.slice(0, 10).map(d => {
    const dueDate = new Date(d.due_date);
    const now = new Date();
    const diffDays = Math.ceil((dueDate - now) / 86400000);
    const isOverdue = diffDays < 0;
    const isToday = diffDays === 0;
    const isTomorrow = diffDays === 1;
    const label = isOverdue ? `${Math.abs(diffDays)}d overdue`
                : isToday ? "Today"
                : isTomorrow ? "Tomorrow"
                : `${diffDays}d`;
    const color = isOverdue ? "#c62828" : isToday ? "#f9a825" : isTomorrow ? "#f9a825" : "#666";
    return `
      <div style="padding:6px 10px; border-left:3px solid ${color}; background:${isOverdue ? '#fef3f0' : '#f8f8f8'}; border-radius:4px; margin-bottom:4px; display:flex; justify-content:space-between; gap:8px; align-items:center;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:12px; font-weight:600; color:${brand.navy}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(d.description || "(no description)")}</div>
          <div style="font-size:11px; color:#666;">${escapeHtml(d.client_name || "")}</div>
        </div>
        <div style="font-size:11px; font-weight:600; color:${color}; white-space:nowrap;">${escapeHtml(label)}</div>
      </div>`;
  }).join("") : `<div style="color:#888; font-size:12px; font-style:italic; padding:10px 0;">No urgent deadlines ✓</div>`;

  // ── System health tiles ──
  const healthPill = (label, status, lastAt, url) => {
    const colors = { ok: "#2e7d32", running: "#0061FF", error: "#c62828" };
    const color = colors[status] || "#999";
    const rel = lastAt ? timeAgo(new Date(lastAt)) : "never";
    return `<a href="${url}" style="display:block; padding:8px 10px; background:white; border-left:3px solid ${color}; text-decoration:none; color:inherit; border-radius:4px; margin-bottom:4px; font-size:11px;">
      <div style="font-weight:600; color:${brand.navy};">${label}</div>
      <div style="color:#666;">${escapeHtml(status || "never")} · <span style="color:#999;">${rel}</span></div>
    </a>`;
  };

  const body = `
    <div class="page-header">
      <h1>Triage Dashboard</h1>
      <div style="font-size:13px; color:#666;">Everything demanding your attention across the firm.</div>
    </div>

    <!-- Top-line stats: color-coded urgency -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:20px;">
      ${statCard("Upcoming Hearings", upcoming.length, `${clientStats.master_clients + clientStats.indiv_clients} total clients`, brand.gold, "/admin/calendar")}
      ${statCard("New Intakes (7d)", intakeStats.this_week, `${intakeStats.urgent_this_week} urgent · ${intakeStats.unreviewed_this_week} unreviewed`, intakeStats.urgent_this_week ? "#c62828" : "#0061FF", "/admin/intakes")}
      ${statCard("Motions Pending", motionStats.drafts + motionStats.reviewed, `${motionStats.past_due} past due · ${motionStats.filed_this_month} filed 30d`, motionStats.past_due ? "#c62828" : brand.gold, "/admin/motions")}
      ${statCard("Deadlines", deadlineStats.total_pending, `${deadlineStats.past_due} past due · ${deadlineStats.due_this_week} this week`, deadlineStats.past_due ? "#c62828" : "#f9a825", "/admin/deadlines")}
      ${statCard("Unnotified Notices", unnotified.length, "Clients need to know", unnotified.length ? "#c62828" : "#2e7d32", "/admin/notices")}
      ${statCard("Reminders (7d)", reminderStats.sent_this_week, reminderStats.failed_this_week ? `${reminderStats.failed_this_week} failed` : "all delivered", reminderStats.failed_this_week ? "#c62828" : "#2e7d32", "/admin/reminders")}
    </div>

    <!-- Main content grid: 3 columns on wide screens -->
    <div class="dashboard-grid" style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:15px; margin-bottom:15px;">
      <!-- Column 1: Upcoming hearings + Notifications -->
      <div>
        <div style="background:white; padding:18px 20px; border-radius:8px; border:1px solid #eee; margin-bottom:12px;">
          <h2 style="margin:0 0 15px 0; font-size:15px; color:${brand.navy}; display:flex; justify-content:space-between; align-items:center;">
            <span>📅 Upcoming Hearings</span>
            <a href="/admin/calendar" style="font-size:11px; color:${brand.gold}; text-decoration:none; font-weight:normal;">Full calendar →</a>
          </h2>
          ${upcomingHtml}
        </div>

        <div style="background:white; padding:15px 20px; border-radius:8px; border:1px solid #eee;">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:#c62828; display:flex; justify-content:space-between; align-items:center;">
            <span>⚠️ Needs Client Notification (${unnotified.length})</span>
            <a href="/admin/notices" style="font-size:11px; color:${brand.gold}; text-decoration:none; font-weight:normal;">All notices →</a>
          </h3>
          ${unnotifiedHtml}
        </div>
      </div>

      <!-- Column 2: Intake + Motions -->
      <div>
        <div style="background:white; padding:15px 20px; border-radius:8px; border:1px solid #eee; margin-bottom:12px;">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:${brand.navy}; display:flex; justify-content:space-between; align-items:center;">
            <span>🆕 Recent Intakes</span>
            <a href="/admin/intakes" style="font-size:11px; color:${brand.gold}; text-decoration:none; font-weight:normal;">All →</a>
          </h3>
          ${intakeHtml}
        </div>

        <div style="background:white; padding:15px 20px; border-radius:8px; border:1px solid #eee;">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:${brand.navy}; display:flex; justify-content:space-between; align-items:center;">
            <span>📜 Pending Motions</span>
            <a href="/admin/motions" style="font-size:11px; color:${brand.gold}; text-decoration:none; font-weight:normal;">All →</a>
          </h3>
          ${motionsHtml}
        </div>
      </div>

      <!-- Column 3: Deadlines + Recent + System -->
      <div>
        <div style="background:white; padding:15px 20px; border-radius:8px; border:1px solid #eee; margin-bottom:12px;">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:${brand.navy}; display:flex; justify-content:space-between; align-items:center;">
            <span>⏰ Urgent Deadlines</span>
            <a href="/admin/deadlines" style="font-size:11px; color:${brand.gold}; text-decoration:none; font-weight:normal;">All →</a>
          </h3>
          ${deadlineHtml}
        </div>

        <div style="background:white; padding:15px 20px; border-radius:8px; border:1px solid #eee; margin-bottom:12px;">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:${brand.navy};">📚 Recent Hearings</h3>
          ${recentHtml}
        </div>

        <div style="background:white; padding:15px 20px; border-radius:8px; border:1px solid #eee;">
          <h3 style="margin:0 0 10px 0; font-size:13px; color:${brand.navy};">🩺 System</h3>
          ${healthPill("💾 Last backup", health.last_backup_status, health.last_backup, "/admin/backups")}
          ${healthPill("🔄 Dropbox scan", health.last_scan_status, health.last_scan, "/admin/calendar")}
          ${healthPill("📤 Outlook sync", health.outlook_status, health.outlook_last_sync, "/admin/outlook-sync")}
        </div>
      </div>
    </div>

    <style>
      @media (max-width: 1200px) {
        .dashboard-grid { grid-template-columns: 1fr 1fr !important; }
      }
      @media (max-width: 800px) {
        .dashboard-grid { grid-template-columns: 1fr !important; }
      }
    </style>`;

  return hearingNotes.renderAdminChrome({ title: "Dashboard", body, activeItem: "dashboard" });
}

// Helper: colored stat card
function statCard(label, value, sublabel, color, url) {
  return `<a href="${url}" style="display:block; background:white; padding:14px; border-radius:8px; border:1px solid #eee; border-top:3px solid ${color}; text-decoration:none; color:inherit; transition:transform .1s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
    <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600; letter-spacing:0.03em;">${label}</div>
    <div style="font-size:28px; font-weight:700; color:#0C1C36; margin-top:4px; line-height:1;">${value}</div>
    ${sublabel ? `<div style="font-size:10px; color:#666; margin-top:6px;">${sublabel}</div>` : ""}
  </a>`;
}

// Human-friendly relative time
function timeAgo(date) {
  if (!date || isNaN(date.getTime())) return "never";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return date.toLocaleDateString();
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
  getRecentIntakes,
  getIntakeStats,
  getPendingMotions,
  getMotionStats,
  getUrgentDeadlines,
  getDeadlineStats,
  getSystemHealth,
  renderDashboard,
};
