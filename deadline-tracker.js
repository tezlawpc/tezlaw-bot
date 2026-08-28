// deadline-tracker.js — Central deadline management for all case types
//
// Consolidates deadlines from multiple sources into one queryable table:
//   - Master hearing notes  (hearing_notes.deadlines JSONB)
//   - Individual hearing notes  (individual_hearing_notes.deadlines JSONB)
//   - Hearing notices  (upcoming hearing dates as pseudo-deadlines)
//   - Manual entries  (created directly by attorney)
//
// Provides:
//   - GET /admin/deadlines             — main triage view
//   - POST /admin/deadlines            — create manual deadline
//   - POST /admin/deadlines/:id/complete  — mark done
//   - POST /admin/deadlines/:id/edit
//   - POST /admin/deadlines/:id/snooze
//   - POST /admin/deadlines/:id/delete
//   - POST /admin/deadlines/sync-all   — resync from all hearing note sources
//
// Daily 7 AM Pacific cron sends WhatsApp/SMS/Telegram alerts at T-14, T-7,
// T-3, T-1, and post-due to the assigned attorney.

const db = require("./db");
const axios = require("axios");

const TIMEZONE_OFFSET_HOURS = -8;    // PST default; adjust for DST manually
const ALERT_DAYS = [14, 7, 3, 1, 0]; // alert schedule from due date

// ─── Schema ───────────────────────────────────────────

async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS deadlines (
      id            SERIAL PRIMARY KEY,
      source_type   TEXT NOT NULL,           -- hearing_note | individual_hearing | notice | manual
      source_id     INTEGER,                 -- FK to source row (null for manual)
      source_ref    TEXT UNIQUE,             -- e.g. "hearing_note:47:0" for dedup
      client_name   TEXT,
      a_number      TEXT,
      due_date      DATE NOT NULL,
      description   TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',  -- pending | completed | cancelled | missed
      priority      TEXT DEFAULT 'normal',   -- low | normal | high
      assigned_to   INTEGER,                 -- FK to users.id
      notes         TEXT DEFAULT '',
      alert_history JSONB DEFAULT '[]'::jsonb,
      completed_at  TIMESTAMP,
      completed_by  INTEGER,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_deadlines_due ON deadlines(due_date, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_deadlines_source ON deadlines(source_type, source_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_deadlines_client ON deadlines(client_name, a_number)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_deadlines_assigned ON deadlines(assigned_to, status, due_date)`);

  console.log("[deadline-tracker] Schema initialized");
}

// ─── Sync from hearing notes ─────────────────────────

// Sync deadlines from a specific master hearing note. Called after saveNote().
async function syncFromHearingNote(noteId) {
  try {
    const { rows } = await db.query(
      `SELECT id, client_name, a_number, deadlines FROM hearing_notes WHERE id = $1`,
      [noteId]
    );
    if (!rows.length) return { synced: 0 };

    const note = rows[0];
    const noteDeadlines = Array.isArray(note.deadlines) ? note.deadlines : [];

    // Delete existing PENDING deadlines from this note (preserve completed ones)
    await db.query(
      `DELETE FROM deadlines WHERE source_type = 'hearing_note' AND source_id = $1 AND status = 'pending'`,
      [noteId]
    );

    let synced = 0;
    for (let i = 0; i < noteDeadlines.length; i++) {
      const d = noteDeadlines[i];
      if (!d || !d.date || !d.description) continue;

      const sourceRef = `hearing_note:${noteId}:${i}`;

      // Skip if this exact deadline was already completed (don't re-create)
      const existing = await db.query(
        `SELECT id, status FROM deadlines WHERE source_type = 'hearing_note' AND source_id = $1 AND due_date = $2 AND description = $3`,
        [noteId, d.date, d.description]
      );
      if (existing.rows.length && existing.rows[0].status !== 'pending') continue;

      await db.query(
        `INSERT INTO deadlines (source_type, source_id, source_ref, client_name, a_number, due_date, description, status)
         VALUES ('hearing_note', $1, $2, $3, $4, $5, $6, 'pending')
         ON CONFLICT (source_ref) DO UPDATE SET
           client_name = EXCLUDED.client_name,
           a_number = EXCLUDED.a_number,
           due_date = EXCLUDED.due_date,
           description = EXCLUDED.description,
           updated_at = NOW()`,
        [noteId, sourceRef, note.client_name, note.a_number, d.date, d.description]
      );
      synced++;
    }
    return { synced };
  } catch (e) {
    console.error("[deadline-tracker] syncFromHearingNote error:", e.message);
    return { synced: 0, error: e.message };
  }
}

// Sync deadlines from a specific individual hearing note. Individual notes
// use a single `next_action_deadline` DATE column rather than a JSONB array.
async function syncFromIndividualHearing(noteId) {
  try {
    const { rows } = await db.query(
      `SELECT id, client_name, a_number, next_action_deadline, disposition_notes
       FROM individual_hearing_notes WHERE id = $1`,
      [noteId]
    );
    if (!rows.length) return { synced: 0 };

    const note = rows[0];

    // Delete existing PENDING deadlines from this note (preserve completed ones)
    await db.query(
      `DELETE FROM deadlines WHERE source_type = 'individual_hearing' AND source_id = $1 AND status = 'pending'`,
      [noteId]
    );

    if (!note.next_action_deadline) return { synced: 0 };

    const description = "Next action following individual hearing";
    const sourceRef = `individual_hearing:${noteId}:next_action`;
    const dueDate = note.next_action_deadline;

    const existing = await db.query(
      `SELECT id, status FROM deadlines WHERE source_type = 'individual_hearing' AND source_id = $1 AND due_date = $2`,
      [noteId, dueDate]
    );
    if (existing.rows.length && existing.rows[0].status !== 'pending') return { synced: 0 };

    await db.query(
      `INSERT INTO deadlines (source_type, source_id, source_ref, client_name, a_number, due_date, description, status)
       VALUES ('individual_hearing', $1, $2, $3, $4, $5, $6, 'pending')
       ON CONFLICT (source_ref) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         a_number = EXCLUDED.a_number,
         due_date = EXCLUDED.due_date,
         updated_at = NOW()`,
      [noteId, sourceRef, note.client_name, note.a_number, dueDate, description]
    );
    return { synced: 1 };
  } catch (e) {
    console.error("[deadline-tracker] syncFromIndividualHearing error:", e.message);
    return { synced: 0, error: e.message };
  }
}

// Auto-create supplemental evidence + brief deadline for a merits hearing.
// EOIR requires all supplemental evidence and briefs to be filed 30 days
// before the merits hearing. This function creates a single deadline at
// hearing_date - 30 days. The daily alert cron will fire at T-30/15/7/3/1/0
// relative to that deadline (which is 60/45/37/33/31/30 days before the
// actual hearing).
//
// Only creates the deadline for FUTURE merits hearings. If the hearing has
// already passed, no deadline is created (and any pending one is cleaned up).
async function syncMeritsEvidenceDeadline(noteId) {
  try {
    const { rows } = await db.query(
      `SELECT id, client_name, a_number, hearing_date
       FROM individual_hearing_notes WHERE id = $1`,
      [noteId]
    );
    if (!rows.length) return { synced: 0 };

    const note = rows[0];
    const sourceRef = `merits_evidence:${noteId}`;

    // Clean up any existing pending deadline for this note
    await db.query(
      `DELETE FROM deadlines
       WHERE source_type = 'merits_evidence' AND source_id = $1 AND status = 'pending'`,
      [noteId]
    );

    // Only create if hearing is in the future
    if (!note.hearing_date) return { synced: 0, reason: "no hearing_date" };
    const hearingDate = new Date(note.hearing_date);
    if (hearingDate <= new Date()) return { synced: 0, reason: "hearing in past" };

    // Due date is 30 days before hearing
    const dueDate = new Date(hearingDate.getTime() - 30 * 86400000);
    const dueDateStr = dueDate.toISOString().split("T")[0];
    const hearingStr = hearingDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

    const description = `Supplemental evidence + briefs due (merits hearing ${hearingStr})`;

    await db.query(
      `INSERT INTO deadlines (source_type, source_id, source_ref, client_name, a_number, due_date, description, priority, status)
       VALUES ('merits_evidence', $1, $2, $3, $4, $5, $6, 'high', 'pending')
       ON CONFLICT (source_ref) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         a_number = EXCLUDED.a_number,
         due_date = EXCLUDED.due_date,
         description = EXCLUDED.description,
         status = 'pending',
         updated_at = NOW()`,
      [noteId, sourceRef, note.client_name, note.a_number, dueDateStr, description]
    );
    return { synced: 1, due_date: dueDateStr };
  } catch (e) {
    console.error("[deadline-tracker] syncMeritsEvidenceDeadline error:", e.message);
    return { synced: 0, error: e.message };
  }
}

// Backfill: run merits evidence sync for ALL individual hearing notes with
// future hearing dates. Called on-demand from /admin/deadlines/sync-all or
// via a one-time boot migration.
async function backfillMeritsEvidenceDeadlines() {
  const { rows } = await db.query(
    `SELECT id FROM individual_hearing_notes
     WHERE hearing_date IS NOT NULL AND hearing_date > NOW()`
  );
  const results = { synced: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    try {
      const r = await syncMeritsEvidenceDeadline(row.id);
      if (r.synced) results.synced++; else results.skipped++;
    } catch (e) {
      results.errors.push(`hearing ${row.id}: ${e.message}`);
    }
  }
  console.log(`[deadline-tracker] Backfilled merits evidence: ${results.synced} synced, ${results.skipped} skipped, ${results.errors.length} errors`);
  return results;
}

// Bulk resync from ALL hearing notes and individual hearing notes. Useful
// for initial backfill or when the deadline table gets out of sync.
async function syncAll() {
  const results = { hearing_notes: 0, individual_hearings: 0, errors: [] };

  try {
    const master = await db.query(`SELECT id FROM hearing_notes`);
    for (const row of master.rows) {
      const r = await syncFromHearingNote(row.id);
      results.hearing_notes += r.synced;
      if (r.error) results.errors.push(`master ${row.id}: ${r.error}`);
    }
  } catch (e) {
    results.errors.push(`master query: ${e.message}`);
  }

  try {
    const tableCheck = await db.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'individual_hearing_notes' LIMIT 1
    `);
    if (tableCheck.rows.length) {
      const individual = await db.query(`SELECT id FROM individual_hearing_notes WHERE next_action_deadline IS NOT NULL`);
      for (const row of individual.rows) {
        const r = await syncFromIndividualHearing(row.id);
        results.individual_hearings += r.synced;
        if (r.error) results.errors.push(`individual ${row.id}: ${r.error}`);
      }
      // Also sync merits evidence deadlines for ALL individual hearings with future dates
      const merits = await db.query(
        `SELECT id FROM individual_hearing_notes WHERE hearing_date IS NOT NULL AND hearing_date > NOW()`
      );
      results.merits_evidence = 0;
      for (const row of merits.rows) {
        const r = await syncMeritsEvidenceDeadline(row.id);
        if (r.synced) results.merits_evidence++;
        if (r.error) results.errors.push(`merits ${row.id}: ${r.error}`);
      }
    }
  } catch (e) {
    results.errors.push(`individual query: ${e.message}`);
  }

  return results;
}

// ─── Manual deadline operations ───────────────────────

async function createManual({ client_name, a_number, due_date, description, priority, assigned_to, notes }) {
  const { rows } = await db.query(
    `INSERT INTO deadlines
      (source_type, source_ref, client_name, a_number, due_date, description, priority, assigned_to, notes, status)
     VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING id`,
    [`manual:${Date.now()}`, client_name, a_number, due_date, description, priority || 'normal', assigned_to || null, notes || '']
  );
  return rows[0].id;
}

async function markComplete(id, userId) {
  await db.query(
    `UPDATE deadlines
     SET status = 'completed', completed_at = NOW(), completed_by = $1, updated_at = NOW()
     WHERE id = $2`,
    [userId, id]
  );
}

async function markCancelled(id) {
  await db.query(
    `UPDATE deadlines SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [id]
  );
}

async function reopen(id) {
  await db.query(
    `UPDATE deadlines
     SET status = 'pending', completed_at = NULL, completed_by = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

async function updateDeadline(id, updates) {
  const allowed = ['client_name', 'a_number', 'due_date', 'description', 'priority', 'assigned_to', 'notes'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(updates[key]);
    }
  }
  if (!sets.length) return;
  sets.push(`updated_at = NOW()`);
  values.push(id);
  await db.query(`UPDATE deadlines SET ${sets.join(', ')} WHERE id = $${i}`, values);
}

async function snooze(id, days) {
  await db.query(
    `UPDATE deadlines
     SET due_date = due_date + INTERVAL '${parseInt(days, 10)} days', updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

async function remove(id) {
  await db.query(`DELETE FROM deadlines WHERE id = $1`, [id]);
}

// ─── Query helpers ────────────────────────────────────

async function listDeadlines({ status, assigned_to, client_name, source_type, from_date, to_date, limit = 500 } = {}) {
  const where = [];
  const params = [];
  let i = 1;

  if (status) { where.push(`status = $${i++}`); params.push(status); }
  if (assigned_to !== undefined && assigned_to !== null && assigned_to !== '') {
    if (assigned_to === 'unassigned') where.push(`assigned_to IS NULL`);
    else { where.push(`assigned_to = $${i++}`); params.push(parseInt(assigned_to, 10)); }
  }
  if (client_name) { where.push(`(client_name ILIKE $${i} OR a_number ILIKE $${i})`); params.push(`%${client_name}%`); i++; }
  if (source_type) { where.push(`source_type = $${i++}`); params.push(source_type); }
  if (from_date) { where.push(`due_date >= $${i++}`); params.push(from_date); }
  if (to_date) { where.push(`due_date <= $${i++}`); params.push(to_date); }

  const sql = `
    SELECT d.*, u.full_name AS assigned_name
    FROM deadlines d
    LEFT JOIN admin_users u ON u.id = d.assigned_to
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
      due_date ASC
    LIMIT ${parseInt(limit, 10)}
  `;
  const { rows } = await db.query(sql, params);
  return rows;
}

async function getDeadline(id) {
  const { rows } = await db.query(
    `SELECT d.*, u.full_name AS assigned_name FROM deadlines d LEFT JOIN admin_users u ON u.id = d.assigned_to WHERE d.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Bucket deadlines for triage view
function bucketDeadlines(deadlines) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets = {
    overdue: [],
    today: [],
    tomorrow: [],
    this_week: [],
    next_two_weeks: [],
    later: [],
    completed: [],
  };

  for (const d of deadlines) {
    if (d.status === 'completed') { buckets.completed.push(d); continue; }
    if (d.status !== 'pending') continue;

    const due = new Date(d.due_date);
    due.setHours(0, 0, 0, 0);
    const daysUntil = Math.floor((due - today) / 86400000);

    if (daysUntil < 0) buckets.overdue.push(d);
    else if (daysUntil === 0) buckets.today.push(d);
    else if (daysUntil === 1) buckets.tomorrow.push(d);
    else if (daysUntil <= 7) buckets.this_week.push(d);
    else if (daysUntil <= 14) buckets.next_two_weeks.push(d);
    else buckets.later.push(d);
  }
  return buckets;
}

// ─── Alert cron ──────────────────────────────────────

async function runDailyAlerts() {
  console.log("[deadline-tracker] Running daily alerts…");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const results = { alerted: 0, skipped: 0, errors: [] };

  // Widen range to catch merits_evidence at T-30/T-15 (which is 60 and 45
  // days before the merits hearing). Other deadlines only fire T-14 and later.
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
  const thirtyDaysOut = new Date(today.getTime() + 30 * 86400000);

  const { rows } = await db.query(
    `SELECT * FROM deadlines
     WHERE status = 'pending' AND due_date BETWEEN $1 AND $2
     ORDER BY due_date ASC`,
    [thirtyDaysAgo.toISOString().split('T')[0], thirtyDaysOut.toISOString().split('T')[0]]
  );

  // Bucket by attorney
  const byAttorney = new Map();
  for (const d of rows) {
    const key = d.assigned_to || 'unassigned';
    if (!byAttorney.has(key)) byAttorney.set(key, []);
    byAttorney.get(key).push(d);
  }

  for (const [attorneyId, deadlines] of byAttorney) {
    try {
      const buckets = bucketDeadlines(deadlines);

      const overdue = buckets.overdue;
      const dueToday = buckets.today;
      const dueTomorrow = buckets.tomorrow;
      const t3 = deadlines.filter(d => daysUntil(d.due_date) === 3);
      const t7 = deadlines.filter(d => daysUntil(d.due_date) === 7);
      const t14 = deadlines.filter(d => daysUntil(d.due_date) === 14);
      // Merits-only extended lead time: fire at T-30 (60 days before hearing)
      // and T-15 (45 days before hearing). Only for merits_evidence source
      // type so we don't spam every long-lead deadline.
      const t30_merits = deadlines.filter(d => daysUntil(d.due_date) === 30 && d.source_type === 'merits_evidence');
      const t15_merits = deadlines.filter(d => daysUntil(d.due_date) === 15 && d.source_type === 'merits_evidence');

      // Only send if there's something to say
      const alertCount = overdue.length + dueToday.length + dueTomorrow.length + t3.length + t7.length + t14.length + t30_merits.length + t15_merits.length;
      if (alertCount === 0) { results.skipped++; continue; }

      const msg = buildAlertMessage({ overdue, dueToday, dueTomorrow, t3, t7, t14, t15_merits, t30_merits });
      await sendTelegramAlert(msg);

      // Log alert to each deadline's history
      const allAlerted = [...overdue, ...dueToday, ...dueTomorrow, ...t3, ...t7, ...t14, ...t15_merits, ...t30_merits];
      for (const d of allAlerted) {
        await db.query(
          `UPDATE deadlines
           SET alert_history = alert_history || $1::jsonb, updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify([{ date: new Date().toISOString(), channel: 'telegram' }]), d.id]
        );
      }
      results.alerted += allAlerted.length;
    } catch (e) {
      console.error(`[deadline-tracker] alert error for attorney ${attorneyId}:`, e.message);
      results.errors.push(`${attorneyId}: ${e.message}`);
    }
  }

  console.log(`[deadline-tracker] Alerts done: ${results.alerted} deadlines alerted, ${results.skipped} skipped`);
  return results;
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.floor((target - today) / 86400000);
}

function buildAlertMessage({ overdue, dueToday, dueTomorrow, t3, t7, t14, t15_merits, t30_merits }) {
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  let msg = `⏰ *Deadline alerts — ${dateStr}*\n\n`;

  const formatDeadline = (d) => {
    const client = d.client_name || 'Unknown';
    const anum = d.a_number ? ` (${d.a_number})` : '';
    return `  • ${d.description}\n    ${client}${anum}`;
  };

  if (overdue.length) {
    msg += `🚨 *OVERDUE (${overdue.length}):*\n`;
    for (const d of overdue) {
      const days = Math.abs(daysUntil(d.due_date));
      msg += `  • *${d.description}* — ${days}d overdue\n    ${d.client_name || 'Unknown'}${d.a_number ? ` (${d.a_number})` : ''}\n`;
    }
    msg += '\n';
  }

  if (dueToday.length) {
    msg += `📍 *DUE TODAY (${dueToday.length}):*\n`;
    for (const d of dueToday) msg += formatDeadline(d) + '\n';
    msg += '\n';
  }

  if (dueTomorrow.length) {
    msg += `⚠️ *DUE TOMORROW (${dueTomorrow.length}):*\n`;
    for (const d of dueTomorrow) msg += formatDeadline(d) + '\n';
    msg += '\n';
  }

  if (t3.length) {
    msg += `🟠 *In 3 days (${t3.length}):*\n`;
    for (const d of t3) msg += formatDeadline(d) + '\n';
    msg += '\n';
  }

  if (t7.length) {
    msg += `🟡 *In 7 days (${t7.length}):*\n`;
    for (const d of t7) msg += formatDeadline(d) + '\n';
    msg += '\n';
  }

  if (t14.length) {
    msg += `📅 *In 14 days (${t14.length}):*\n`;
    for (const d of t14) msg += formatDeadline(d) + '\n';
    msg += '\n';
  }

  // Merits evidence early-warning alerts (fired at 60/45 days before hearing)
  if (t15_merits && t15_merits.length) {
    msg += `⚖️ *45 days to merits hearing — evidence due in 15 days (${t15_merits.length}):*\n`;
    for (const d of t15_merits) msg += formatDeadline(d) + '\n';
    msg += '\n';
  }

  if (t30_merits && t30_merits.length) {
    msg += `⚖️ *60 days to merits hearing — evidence due in 30 days (${t30_merits.length}):*\n`;
    for (const d of t30_merits) msg += formatDeadline(d) + '\n';
    msg += '\n';
  }

  msg += `\n🔗 View all: /admin/deadlines`;
  return msg;
}

async function sendTelegramAlert(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.RECIPIENT_JJ_TELEGRAM_ID || process.env.RECIPIENT_JUE_TELEGRAM_ID;
  if (!botToken || !chatId) {
    console.warn("[deadline-tracker] Telegram not configured, skipping alert");
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "Markdown" },
      { timeout: 15000 }
    );
  } catch (e) {
    console.error("[deadline-tracker] Telegram send failed:", e.response?.data || e.message);
  }
}

// ─── Cron scheduler ──────────────────────────────────

function scheduleDailyAlerts() {
  // Run daily at 7 AM Pacific.  Pacific = UTC-8 (PST) or UTC-7 (PDT).
  // Schedule based on TIMEZONE_OFFSET_HOURS.
  const targetHourPacific = 7;
  const targetHourUTC = (targetHourPacific - TIMEZONE_OFFSET_HOURS + 24) % 24;

  function msUntilTarget() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(targetHourUTC, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  }

  function scheduleNext() {
    const ms = msUntilTarget();
    console.log(`[deadline-tracker] Next alert run in ${Math.round(ms / 60000)} min`);
    setTimeout(async () => {
      try { await runDailyAlerts(); }
      catch (e) { console.error("[deadline-tracker] Daily run failed:", e); }
      scheduleNext();
    }, ms);
  }
  scheduleNext();
}

// ─── UI rendering ────────────────────────────────────

function renderDeadlinesPage(user, filters = {}) {
  const brand = { gold: '#B79C62', navy: '#0C1C36' };
  return async function(deadlines, allUsers) {
    const buckets = bucketDeadlines(deadlines);

    const overdueCount = buckets.overdue.length;
    const todayCount = buckets.today.length;
    const weekCount = buckets.tomorrow.length + buckets.this_week.length;
    const laterCount = buckets.next_two_weeks.length + buckets.later.length;
    const completedCount = buckets.completed.length;

    const bucketHtml = (title, items, color, hint) => {
      if (!items.length) return "";
      const rows = items.map(d => renderDeadlineRow(d, allUsers)).join("");
      return `
        <div style="margin-bottom:24px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
            <div style="width:12px; height:12px; border-radius:50%; background:${color};"></div>
            <h3 style="margin:0; color:${brand.navy};">${title} <span style="color:#888; font-weight:normal;">(${items.length})</span></h3>
            ${hint ? `<span style="font-size:11px; color:#888;">${hint}</span>` : ""}
          </div>
          <div style="background:white; border:1px solid #e0e0e0; border-radius:6px; overflow:hidden;">
            ${rows}
          </div>
        </div>`;
    };

    return `
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <h1 style="margin:0;">⏰ Deadline Tracker</h1>
      <div style="display:flex; gap:8px;">
        <button type="button" onclick="openManualDeadlineModal()" style="background:${brand.gold}; color:white; padding:9px 16px; border:none; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600;">+ Add deadline</button>
        <button type="button" onclick="resyncAll()" style="background:#eee; color:#333; padding:9px 16px; border:none; border-radius:6px; cursor:pointer; font-size:13px;">🔄 Re-sync from hearing notes</button>
      </div>
    </div>

    <!-- Stat cards -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin:20px 0;">
      <div style="background:#c62828; color:white; padding:14px 16px; border-radius:8px;">
        <div style="font-size:11px; opacity:.9;">Overdue</div>
        <div style="font-size:26px; font-weight:600; margin-top:2px;">${overdueCount}</div>
      </div>
      <div style="background:#ef6c00; color:white; padding:14px 16px; border-radius:8px;">
        <div style="font-size:11px; opacity:.9;">Due today</div>
        <div style="font-size:26px; font-weight:600; margin-top:2px;">${todayCount}</div>
      </div>
      <div style="background:#f9a825; color:white; padding:14px 16px; border-radius:8px;">
        <div style="font-size:11px; opacity:.9;">This week</div>
        <div style="font-size:26px; font-weight:600; margin-top:2px;">${weekCount}</div>
      </div>
      <div style="background:#546e7a; color:white; padding:14px 16px; border-radius:8px;">
        <div style="font-size:11px; opacity:.9;">Later</div>
        <div style="font-size:26px; font-weight:600; margin-top:2px;">${laterCount}</div>
      </div>
      <div style="background:#2e7d32; color:white; padding:14px 16px; border-radius:8px;">
        <div style="font-size:11px; opacity:.9;">Completed</div>
        <div style="font-size:26px; font-weight:600; margin-top:2px;">${completedCount}</div>
      </div>
    </div>

    <!-- Filters -->
    <form method="GET" style="background:#f8f8f8; padding:12px; border-radius:6px; margin-bottom:20px; display:flex; gap:8px; flex-wrap:wrap; align-items:end;">
      <div>
        <label style="display:block; font-size:11px; color:#666;">Client / A-number</label>
        <input type="text" name="client" value="${escapeHtml(filters.client_name || '')}" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px; width:200px;">
      </div>
      <div>
        <label style="display:block; font-size:11px; color:#666;">Assigned to</label>
        <select name="assigned" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px;">
          <option value="">All</option>
          <option value="unassigned" ${filters.assigned_to === 'unassigned' ? 'selected' : ''}>Unassigned</option>
          ${allUsers.map(u => `<option value="${u.id}" ${String(filters.assigned_to) === String(u.id) ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
        </select>
      </div>
      <div>
        <label style="display:block; font-size:11px; color:#666;">Source</label>
        <select name="source" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px;">
          <option value="">All</option>
          <option value="hearing_note" ${filters.source_type === 'hearing_note' ? 'selected' : ''}>Master hearing</option>
          <option value="individual_hearing" ${filters.source_type === 'individual_hearing' ? 'selected' : ''}>Individual hearing</option>
          <option value="manual" ${filters.source_type === 'manual' ? 'selected' : ''}>Manual</option>
        </select>
      </div>
      <div>
        <label style="display:block; font-size:11px; color:#666;">Status</label>
        <select name="status" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px;">
          <option value="">Pending + Completed</option>
          <option value="pending" ${filters.status === 'pending' ? 'selected' : ''}>Pending only</option>
          <option value="completed" ${filters.status === 'completed' ? 'selected' : ''}>Completed only</option>
        </select>
      </div>
      <button type="submit" style="background:${brand.navy}; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Filter</button>
      <a href="/admin/deadlines" style="padding:8px 16px; color:#666; text-decoration:none; font-size:13px;">Reset</a>
    </form>

    <!-- Buckets -->
    ${bucketHtml("Overdue", buckets.overdue, "#c62828", "⚠️ Action required immediately")}
    ${bucketHtml("Due today", buckets.today, "#ef6c00")}
    ${bucketHtml("Due tomorrow", buckets.tomorrow, "#f9a825")}
    ${bucketHtml("This week", buckets.this_week, "#fbc02d")}
    ${bucketHtml("Next 2 weeks", buckets.next_two_weeks, "#546e7a")}
    ${bucketHtml("Later", buckets.later, "#455a64")}

    ${buckets.completed.length ? `
    <details style="margin-top:24px;">
      <summary style="cursor:pointer; padding:10px; background:#e8f5e9; border-radius:6px; font-weight:600; color:#2e7d32;">
        ✅ Completed (${buckets.completed.length})
      </summary>
      <div style="background:white; border:1px solid #e0e0e0; border-radius:6px; overflow:hidden; margin-top:8px;">
        ${buckets.completed.slice(0, 100).map(d => renderDeadlineRow(d, allUsers)).join("")}
      </div>
    </details>
    ` : ""}

    ${!deadlines.length ? `<div style="text-align:center; padding:40px; color:#888;">No deadlines yet. Deadlines added to hearing notes appear here automatically.</div>` : ""}

    <!-- Manual deadline modal -->
    <div id="manual-deadline-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:10000; align-items:center; justify-content:center; padding:20px;">
      <div style="background:white; padding:24px; border-radius:10px; max-width:520px; width:100%;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
          <h2 style="margin:0; color:${brand.navy};">+ Add deadline</h2>
          <button type="button" onclick="closeManualDeadlineModal()" style="background:transparent; border:none; font-size:20px; cursor:pointer; color:#888;">✕</button>
        </div>
        <form id="manual-deadline-form" onsubmit="submitManualDeadline(event)">
          <div style="margin-bottom:12px;">
            <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Client name *</label>
            <input type="text" name="client_name" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">A-number</label>
            <input type="text" name="a_number" placeholder="A123-456-789" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Due date *</label>
            <input type="date" name="due_date" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Description *</label>
            <input type="text" name="description" required placeholder="e.g. File I-589, biometrics, motion to reopen" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px;">
            <div>
              <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Priority</label>
              <select name="priority" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div>
              <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Assign to</label>
              <select name="assigned_to" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
                <option value="">Unassigned</option>
                ${allUsers.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="margin-bottom:16px;">
            <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Notes</label>
            <textarea name="notes" rows="3" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;"></textarea>
          </div>
          <div style="display:flex; gap:8px;">
            <button type="button" onclick="closeManualDeadlineModal()" style="flex:1; padding:10px; background:#eee; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
            <button type="submit" style="flex:1; padding:10px; background:${brand.navy}; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600;">Create deadline</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      function openManualDeadlineModal() { document.getElementById("manual-deadline-modal").style.display = "flex"; }
      function closeManualDeadlineModal() { document.getElementById("manual-deadline-modal").style.display = "none"; }

      async function submitManualDeadline(e) {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {};
        for (const [k, v] of fd.entries()) body[k] = v;
        try {
          const r = await fetch("/admin/deadlines", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body) });
          const d = await r.json();
          if (d.ok) location.reload();
          else alert("Error: " + (d.error || "unknown"));
        } catch (err) { alert("Failed: " + err.message); }
      }

      async function markComplete(id) {
        if (!confirm("Mark this deadline complete?")) return;
        try {
          const r = await fetch("/admin/deadlines/" + id + "/complete", { method: "POST" });
          if ((await r.json()).ok) location.reload();
        } catch (e) { alert("Failed: " + e.message); }
      }
      async function reopenDeadline(id) {
        try {
          const r = await fetch("/admin/deadlines/" + id + "/reopen", { method: "POST" });
          if ((await r.json()).ok) location.reload();
        } catch (e) { alert("Failed: " + e.message); }
      }
      async function snoozeDeadline(id) {
        const days = prompt("Snooze how many days?", "7");
        if (!days) return;
        try {
          const r = await fetch("/admin/deadlines/" + id + "/snooze", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({days: parseInt(days,10)}) });
          if ((await r.json()).ok) location.reload();
        } catch (e) { alert("Failed: " + e.message); }
      }
      async function deleteDeadline(id) {
        if (!confirm("Delete this deadline permanently? (For notes-sourced deadlines, this only removes it from the tracker — the underlying hearing note is unchanged.)")) return;
        try {
          const r = await fetch("/admin/deadlines/" + id + "/delete", { method: "POST" });
          if ((await r.json()).ok) location.reload();
        } catch (e) { alert("Failed: " + e.message); }
      }
      async function resyncAll() {
        if (!confirm("Re-sync deadlines from all hearing notes? Pending deadlines will be rebuilt from the underlying notes. Completed and manual deadlines are preserved.")) return;
        try {
          const r = await fetch("/admin/deadlines/sync-all", { method: "POST" });
          const d = await r.json();
          if (d.ok) alert("Synced: " + d.results.hearing_notes + " from master notes, " + d.results.individual_hearings + " from individual notes");
          location.reload();
        } catch (e) { alert("Failed: " + e.message); }
      }
      async function editDeadline(id) {
        const desc = prompt("New description?");
        if (!desc) return;
        try {
          const r = await fetch("/admin/deadlines/" + id + "/edit", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({description: desc}) });
          if ((await r.json()).ok) location.reload();
        } catch (e) { alert("Failed: " + e.message); }
      }
    </script>`;
  };
}

function renderDeadlineRow(d, allUsers) {
  const daysUntilDue = daysUntil(d.due_date);
  const isOverdue = daysUntilDue < 0 && d.status === 'pending';
  const isDueToday = daysUntilDue === 0 && d.status === 'pending';
  const isCompleted = d.status === 'completed';

  const dueText = isOverdue ? `${Math.abs(daysUntilDue)}d overdue`
                : isDueToday ? "Today"
                : daysUntilDue === 1 ? "Tomorrow"
                : daysUntilDue < 0 ? new Date(d.due_date).toLocaleDateString()
                : `In ${daysUntilDue}d`;

  const dueColor = isOverdue ? '#c62828'
                 : isDueToday ? '#ef6c00'
                 : daysUntilDue <= 3 ? '#f9a825'
                 : '#666';

  const sourceIcon = d.source_type === 'hearing_note' ? '📝'
                    : d.source_type === 'individual_hearing' ? '⚖️'
                    : d.source_type === 'notice' ? '📬'
                    : '➕';

  const sourceLink = d.source_type === 'hearing_note' ? `/admin/hearing/notes/${d.source_id}`
                    : d.source_type === 'individual_hearing' ? `/admin/hearing/individual/${d.source_id}`
                    : "";

  const strike = isCompleted ? "text-decoration:line-through; opacity:0.6;" : "";

  const clientDisplay = d.client_name || 'Unknown';
  const anum = d.a_number ? ` <span style="color:#888; font-size:11px;">(${escapeHtml(d.a_number)})</span>` : '';

  const assignedDisplay = d.assigned_name ? escapeHtml(d.assigned_name) : (d.assigned_to ? 'Unknown' : '<em style="color:#888;">Unassigned</em>');

  const actions = isCompleted
    ? `<button onclick="reopenDeadline(${d.id})" style="background:#e3f2fd; color:#0d47a1; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;">↩️ Reopen</button>
       <button onclick="deleteDeadline(${d.id})" style="background:transparent; color:#c00; border:none; padding:5px 8px; cursor:pointer; font-size:11px;">🗑</button>`
    : `<button onclick="markComplete(${d.id})" style="background:#2e7d32; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:600;">✓ Complete</button>
       <button onclick="snoozeDeadline(${d.id})" style="background:#fff3e0; color:#e65100; border:none; padding:5px 8px; border-radius:4px; cursor:pointer; font-size:11px;">🔕 Snooze</button>
       <button onclick="editDeadline(${d.id})" style="background:transparent; color:#666; border:none; padding:5px 8px; cursor:pointer; font-size:11px;">✏️</button>
       <button onclick="deleteDeadline(${d.id})" style="background:transparent; color:#c00; border:none; padding:5px 8px; cursor:pointer; font-size:11px;">🗑</button>`;

  return `
    <div style="display:flex; padding:12px 16px; border-bottom:1px solid #f0f0f0; gap:16px; align-items:center; ${strike}">
      <div style="flex:0 0 auto; font-size:20px;" title="${d.source_type}">${sourceIcon}</div>
      <div style="flex:1;">
        <div style="font-weight:600; color:#0C1C36; margin-bottom:2px;">${escapeHtml(d.description)}</div>
        <div style="font-size:12px; color:#666;">
          ${sourceLink ? `<a href="${sourceLink}" style="color:#B79C62; text-decoration:none;">${escapeHtml(clientDisplay)}</a>` : escapeHtml(clientDisplay)}${anum}
        </div>
      </div>
      <div style="flex:0 0 100px; text-align:center;">
        <div style="font-weight:600; color:${dueColor}; font-size:13px;">${dueText}</div>
        <div style="font-size:10px; color:#888;">${new Date(d.due_date).toLocaleDateString()}</div>
      </div>
      <div style="flex:0 0 120px; font-size:12px; color:#666;">${assignedDisplay}</div>
      <div style="flex:0 0 auto; display:flex; gap:4px;">${actions}</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = {
  init,
  syncFromHearingNote,
  syncFromIndividualHearing,
  syncMeritsEvidenceDeadline,
  backfillMeritsEvidenceDeadlines,
  syncAll,
  createManual,
  markComplete,
  markCancelled,
  reopen,
  updateDeadline,
  snooze,
  remove,
  listDeadlines,
  getDeadline,
  bucketDeadlines,
  runDailyAlerts,
  scheduleDailyAlerts,
  renderDeadlinesPage,
  renderDeadlineRow,
};
