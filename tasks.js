// ============================================================
//  TEZ LAW P.C. — TASK LIST & REMINDERS
//  ─────────────────────────────────────────────────────────
//  Track filing deadlines, motions, habeas corpus petitions,
//  writs of mandamus, appeals, RFE responses, client callbacks,
//  and any other action item.
//
//  Categories are practice-area-aware, so an immigration task
//  can be tagged "motion_to_reopen" while a PI task can be
//  tagged "demand_letter_deadline".
//
//  Reminder pipeline:
//   - Daily 8 AM Pacific cron scans tasks due today or overdue
//   - Sends Telegram notification to JJ with grouped list
//   - Auto-flags overdue tasks with red banner in UI
// ============================================================

const db = require("./db");

// ─── Standard task categories ──────────────────────────
// Grouped by practice area for filter dropdowns

const CATEGORIES = {
  immigration: [
    { key: "motion_to_reopen",       label: "Motion to Reopen" },
    { key: "motion_to_reconsider",   label: "Motion to Reconsider" },
    { key: "motion_to_terminate",    label: "Motion to Terminate" },
    { key: "motion_to_continue",     label: "Motion to Continue" },
    { key: "motion_to_administrative_closure", label: "Motion for Admin Closure" },
    { key: "notice_of_appeal_bia",   label: "Notice of Appeal (BIA)" },
    { key: "bia_appeal_brief",       label: "BIA Appeal Brief" },
    { key: "circuit_court_petition", label: "Circuit Court Petition for Review" },
    { key: "habeas_corpus",          label: "Habeas Corpus Petition" },
    { key: "writ_of_mandamus",       label: "Writ of Mandamus" },
    { key: "rfe_response",           label: "Response to RFE" },
    { key: "noid_response",          label: "Response to NOID" },
    { key: "uscis_filing",           label: "USCIS Filing" },
    { key: "eoir_filing",            label: "EOIR Court Filing" },
    { key: "master_calendar_prep",   label: "Master Calendar Hearing Prep" },
    { key: "individual_hearing_prep", label: "Individual Hearing Prep" },
    { key: "asylum_application",     label: "Asylum Application (I-589)" },
    { key: "adjustment_application", label: "Adjustment of Status (I-485)" },
    { key: "green_card_renewal",     label: "Green Card Renewal (I-90)" },
    { key: "naturalization",         label: "Naturalization (N-400)" },
    { key: "bond_hearing_prep",      label: "Bond Hearing Prep" },
    { key: "detained_check_in",      label: "Detention Facility Check-In" },
  ],
  pi: [
    { key: "demand_letter",          label: "Send Demand Letter" },
    { key: "demand_deadline",        label: "Demand Letter Deadline (CCP §999)" },
    { key: "sol_deadline",           label: "Statute of Limitations Deadline" },
    { key: "medical_records_request", label: "Request Medical Records" },
    { key: "medical_bills_request",  label: "Request Medical Bills" },
    { key: "settlement_offer_response", label: "Respond to Settlement Offer" },
    { key: "lien_negotiation",       label: "Negotiate Medical Lien" },
    { key: "disbursement",           label: "Client Disbursement" },
    { key: "file_complaint",         label: "File Complaint / Lawsuit" },
    { key: "discovery_response",     label: "Respond to Discovery" },
    { key: "deposition_prep",        label: "Deposition Prep" },
    { key: "mediation",              label: "Mediation" },
  ],
  business: [
    { key: "complaint_filing",       label: "File Complaint" },
    { key: "answer_filing",          label: "File Answer" },
    { key: "motion_to_dismiss",      label: "Motion to Dismiss" },
    { key: "discovery_response",     label: "Discovery Response" },
    { key: "deposition_prep",        label: "Deposition Prep" },
    { key: "trial_brief",            label: "Trial Brief" },
    { key: "settlement_conference",  label: "Settlement Conference" },
  ],
  ll_tenant: [
    { key: "3day_notice",            label: "Serve 3-Day Notice" },
    { key: "30day_notice",           label: "Serve 30-Day Notice" },
    { key: "60day_notice",           label: "Serve 60-Day Notice" },
    { key: "ud_complaint",           label: "File UD Complaint" },
    { key: "writ_of_possession",     label: "Writ of Possession" },
    { key: "trial_prep",             label: "UD Trial Prep" },
  ],
  estate: [
    { key: "will_drafting",          label: "Draft Will" },
    { key: "trust_drafting",         label: "Draft Trust" },
    { key: "trust_funding",          label: "Fund Trust" },
    { key: "probate_filing",         label: "File Probate Petition" },
    { key: "inventory_appraisal",    label: "Inventory & Appraisal" },
    { key: "final_accounting",       label: "Final Accounting" },
  ],
  tm: [
    { key: "tm_application",         label: "File TM Application" },
    { key: "office_action_response", label: "Response to Office Action" },
    { key: "statement_of_use",       label: "Statement of Use" },
    { key: "renewal_filing",         label: "TM Renewal" },
  ],
  real_estate: [
    { key: "purchase_contract",      label: "Purchase Contract Review" },
    { key: "escrow_close",           label: "Escrow Closing" },
    { key: "title_search",           label: "Title Search" },
    { key: "deed_recording",         label: "Deed Recording" },
  ],
  admin: [
    { key: "client_call",            label: "Client Call/Meeting" },
    { key: "retainer_replenishment", label: "Request Retainer Replenishment" },
    { key: "invoice_send",           label: "Send Invoice" },
    { key: "follow_up",              label: "Follow-Up Task" },
    { key: "cle_deadline",           label: "CLE Compliance Deadline" },
    { key: "bar_dues",               label: "Bar Dues Payment" },
    { key: "other",                  label: "Other" },
  ],
};

// Flatten for lookup
const CATEGORY_LABELS = {};
for (const [area, cats] of Object.entries(CATEGORIES)) {
  for (const c of cats) CATEGORY_LABELS[c.key] = c.label;
}

const PRIORITIES = [
  { key: "low",     label: "Low",     color: "#888" },
  { key: "normal",  label: "Normal",  color: "#0061FF" },
  { key: "high",    label: "High",    color: "#e65100" },
  { key: "urgent",  label: "Urgent",  color: "#c62828" },
];
const PRIORITY_COLORS = Object.fromEntries(PRIORITIES.map(p => [p.key, p.color]));

// ─── Schema ─────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                  SERIAL PRIMARY KEY,
      title               TEXT NOT NULL,
      description         TEXT,
      category            TEXT,                       -- motion_to_reopen | habeas_corpus | etc
      matter_type         TEXT,                       -- immigration | pi | business | ll_tenant | estate | tm | real_estate | admin
      priority            TEXT DEFAULT 'normal',      -- low | normal | high | urgent
      status              TEXT DEFAULT 'pending',     -- pending | in_progress | completed | cancelled
      due_date            DATE,
      due_time            TIME,                       -- optional specific time
      reminder_days_before INTEGER DEFAULT 3,         -- how many days before due to remind
      client_name         TEXT,
      client_key          TEXT,
      a_number            TEXT,                       -- for immigration
      case_id             INTEGER,                    -- for PI cases (pi_cases.id)
      case_number         TEXT,                       -- court case number
      court               TEXT,
      assigned_to         TEXT,                       -- staff member name
      created_by          INTEGER,                    -- admin_users.id
      completed_by        INTEGER,
      completed_at        TIMESTAMPTZ,
      completion_notes    TEXT,
      -- Recurring tasks
      is_recurring        BOOLEAN DEFAULT FALSE,
      recurrence_pattern  TEXT,                       -- weekly | monthly | quarterly | yearly
      recurrence_until    DATE,
      parent_task_id      INTEGER,                    -- if this task was auto-created from a recurring parent
      -- Reminder tracking
      last_reminder_sent  TIMESTAMPTZ,
      reminders_sent      INTEGER DEFAULT 0,
      -- Timestamps
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Auto-migrate for older installations
  const alters = [
    "ADD COLUMN IF NOT EXISTS due_time TIME",
    "ADD COLUMN IF NOT EXISTS reminder_days_before INTEGER DEFAULT 3",
    "ADD COLUMN IF NOT EXISTS case_id INTEGER",
    "ADD COLUMN IF NOT EXISTS case_number TEXT",
    "ADD COLUMN IF NOT EXISTS court TEXT",
    "ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE",
    "ADD COLUMN IF NOT EXISTS recurrence_pattern TEXT",
    "ADD COLUMN IF NOT EXISTS recurrence_until DATE",
    "ADD COLUMN IF NOT EXISTS parent_task_id INTEGER",
    "ADD COLUMN IF NOT EXISTS last_reminder_sent TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS reminders_sent INTEGER DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS completion_notes TEXT",
  ];
  for (const alter of alters) {
    try { await db.query(`ALTER TABLE tasks ${alter}`); } catch {}
  }

  await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (due_date) WHERE status != 'completed' AND status != 'cancelled'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_matter ON tasks (matter_type)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assigned_to)`);
}

// ─── CRUD ───────────────────────────────────────────────

async function createTask(data) {
  await initTable();
  const r = await db.query(
    `INSERT INTO tasks
       (title, description, category, matter_type, priority, status,
        due_date, due_time, reminder_days_before,
        client_name, client_key, a_number, case_id, case_number, court,
        assigned_to, created_by,
        is_recurring, recurrence_pattern, recurrence_until, parent_task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [
      data.title, data.description || null, data.category || null, data.matter_type || null,
      data.priority || "normal", data.status || "pending",
      data.due_date || null, data.due_time || null, data.reminder_days_before || 3,
      data.client_name || null, data.client_key || null, data.a_number || null,
      data.case_id || null, data.case_number || null, data.court || null,
      data.assigned_to || null, data.created_by || null,
      !!data.is_recurring, data.recurrence_pattern || null, data.recurrence_until || null, data.parent_task_id || null,
    ]
  );
  return r.rows[0];
}

async function updateTask(id, fields) {
  await initTable();
  const allowed = [
    "title", "description", "category", "matter_type", "priority", "status",
    "due_date", "due_time", "reminder_days_before",
    "client_name", "client_key", "a_number", "case_id", "case_number", "court",
    "assigned_to", "completion_notes",
    "is_recurring", "recurrence_pattern", "recurrence_until",
  ];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(fields[key] === "" ? null : fields[key]);
    }
  }
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  values.push(id);
  const r = await db.query(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return r.rows[0];
}

async function completeTask(id, { userId, notes = null } = {}) {
  await initTable();
  const r = await db.query(
    `UPDATE tasks SET
       status = 'completed',
       completed_by = $1,
       completed_at = NOW(),
       completion_notes = COALESCE($2, completion_notes),
       updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [userId, notes, id]
  );
  const task = r.rows[0];

  // If recurring, spawn the next instance
  if (task && task.is_recurring && task.recurrence_pattern && task.due_date) {
    await spawnNextRecurrence(task);
  }

  return task;
}

async function spawnNextRecurrence(parent) {
  const patterns = {
    weekly: 7,
    monthly: 30,
    quarterly: 90,
    yearly: 365,
  };
  const daysToAdd = patterns[parent.recurrence_pattern];
  if (!daysToAdd) return;
  const nextDue = new Date(parent.due_date);
  nextDue.setDate(nextDue.getDate() + daysToAdd);
  const nextDueStr = nextDue.toISOString().split("T")[0];
  if (parent.recurrence_until && nextDueStr > parent.recurrence_until) return;

  await createTask({
    title: parent.title,
    description: parent.description,
    category: parent.category,
    matter_type: parent.matter_type,
    priority: parent.priority,
    due_date: nextDueStr,
    due_time: parent.due_time,
    reminder_days_before: parent.reminder_days_before,
    client_name: parent.client_name,
    client_key: parent.client_key,
    a_number: parent.a_number,
    case_id: parent.case_id,
    case_number: parent.case_number,
    court: parent.court,
    assigned_to: parent.assigned_to,
    created_by: parent.created_by,
    is_recurring: parent.is_recurring,
    recurrence_pattern: parent.recurrence_pattern,
    recurrence_until: parent.recurrence_until,
    parent_task_id: parent.parent_task_id || parent.id,
  });
}

async function deleteTask(id) {
  await initTable();
  await db.query(`DELETE FROM tasks WHERE id = $1`, [id]);
}

async function getTask(id) {
  await initTable();
  const r = await db.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// ─── Queries ────────────────────────────────────────────

async function listTasks({
  status = null, matter_type = null, category = null, priority = null,
  client_key = null, assigned_to = null,
  due_within_days = null,       // e.g., 7 = due within next 7 days
  overdue_only = false,
  completed_only = false,
  from_date = null, to_date = null,
  limit = 200, offset = 0,
} = {}) {
  await initTable();
  const conds = [];
  const params = [];
  let i = 1;
  if (completed_only) {
    conds.push(`status = 'completed'`);
  } else if (status) {
    conds.push(`status = $${i++}`); params.push(status);
  } else {
    conds.push(`status NOT IN ('completed', 'cancelled')`);
  }
  if (matter_type) { conds.push(`matter_type = $${i++}`); params.push(matter_type); }
  if (category) { conds.push(`category = $${i++}`); params.push(category); }
  if (priority) { conds.push(`priority = $${i++}`); params.push(priority); }
  if (client_key) { conds.push(`client_key = $${i++}`); params.push(client_key); }
  if (assigned_to) { conds.push(`assigned_to = $${i++}`); params.push(assigned_to); }
  if (due_within_days != null) {
    conds.push(`due_date IS NOT NULL AND due_date <= CURRENT_DATE + ($${i++} || ' days')::interval`);
    params.push(due_within_days);
  }
  if (overdue_only) {
    conds.push(`due_date IS NOT NULL AND due_date < CURRENT_DATE`);
  }
  if (from_date) { conds.push(`due_date >= $${i++}`); params.push(from_date); }
  if (to_date) { conds.push(`due_date <= $${i++}`); params.push(to_date); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(limit, offset);
  const r = await db.query(
    `SELECT *,
       CASE WHEN due_date IS NULL THEN NULL
            ELSE (due_date - CURRENT_DATE)::integer
       END as days_until_due
     FROM tasks
     ${where}
     ORDER BY
       CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
       COALESCE(due_date, '9999-12-31') ASC,
       created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    params
  );
  return r.rows;
}

async function getStats() {
  await initTable();
  const r = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled')) as open_count,
      COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled') AND due_date IS NOT NULL AND due_date < CURRENT_DATE) as overdue_count,
      COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled') AND due_date = CURRENT_DATE) as due_today,
      COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled') AND due_date > CURRENT_DATE AND due_date <= CURRENT_DATE + INTERVAL '7 days') as due_this_week,
      COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('completed', 'cancelled')) as urgent_count,
      COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > CURRENT_DATE - INTERVAL '7 days') as completed_this_week
    FROM tasks
  `);
  return r.rows[0] || {};
}

// ─── Daily reminders (Telegram) ─────────────────────────
// Called by cron at 8 AM Pacific. Sends a grouped list of tasks due today +
// overdue tasks to the JJ_TELEGRAM_ID chat.

async function sendDailyReminders() {
  await initTable();

  // Get tasks needing attention
  const [overdue, dueToday, dueSoon] = await Promise.all([
    listTasks({ overdue_only: true, limit: 50 }),
    db.query(`SELECT * FROM tasks WHERE status NOT IN ('completed', 'cancelled') AND due_date = CURRENT_DATE ORDER BY priority ASC, id`),
    db.query(`SELECT * FROM tasks WHERE status NOT IN ('completed', 'cancelled') AND due_date IS NOT NULL AND due_date > CURRENT_DATE AND due_date <= CURRENT_DATE + reminder_days_before ORDER BY due_date ASC, priority ASC`),
  ]);
  const dueTodayRows = dueToday.rows;
  const dueSoonRows = dueSoon.rows;

  if (!overdue.length && !dueTodayRows.length && !dueSoonRows.length) {
    return { sent: false, reason: "no_tasks" };
  }

  // Build message
  const lines = ["📋 <b>Daily Task Reminder</b>", ""];
  if (overdue.length) {
    lines.push(`🚨 <b>${overdue.length} OVERDUE</b>`);
    for (const t of overdue.slice(0, 10)) {
      const dt = new Date(t.due_date).toLocaleDateString();
      lines.push(`• [${Math.abs((new Date(t.due_date) - new Date()) / 86400000).toFixed(0)}d late] ${escapeTelegram(t.title)}${t.client_name ? " — " + escapeTelegram(t.client_name) : ""}`);
    }
    if (overdue.length > 10) lines.push(`... and ${overdue.length - 10} more`);
    lines.push("");
  }

  if (dueTodayRows.length) {
    lines.push(`⚠️ <b>Due TODAY (${dueTodayRows.length})</b>`);
    for (const t of dueTodayRows.slice(0, 10)) {
      const priorityIcon = t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟠" : "🔵";
      lines.push(`${priorityIcon} ${escapeTelegram(t.title)}${t.client_name ? " — " + escapeTelegram(t.client_name) : ""}`);
    }
    lines.push("");
  }

  if (dueSoonRows.length) {
    lines.push(`📅 <b>Coming up (${dueSoonRows.length})</b>`);
    for (const t of dueSoonRows.slice(0, 10)) {
      const dt = new Date(t.due_date).toLocaleDateString();
      lines.push(`• ${dt} — ${escapeTelegram(t.title)}${t.client_name ? " (" + escapeTelegram(t.client_name) + ")" : ""}`);
    }
    lines.push("");
  }

  const tezBase = process.env.RENDER_EXTERNAL_URL || "https://tezlawfirm.com";
  lines.push(`<a href="${tezBase}/admin/tasks">Open task list →</a>`);
  const message = lines.join("\n");

  // Send to Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.JJ_TELEGRAM_ID;
  if (!token || !chatId) return { sent: false, reason: "no_telegram_config" };

  try {
    const axios = require("axios");
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: message, parse_mode: "HTML", disable_web_page_preview: true },
      { timeout: 15000 }
    );

    // Mark reminders sent
    const allTaskIds = [...overdue, ...dueTodayRows, ...dueSoonRows].map(t => t.id);
    if (allTaskIds.length) {
      await db.query(
        `UPDATE tasks SET last_reminder_sent = NOW(), reminders_sent = reminders_sent + 1 WHERE id = ANY($1)`,
        [allTaskIds]
      );
    }
    return { sent: true, tasks_notified: allTaskIds.length };
  } catch (e) {
    console.warn("[tasks] Telegram send failed:", e.message);
    return { sent: false, reason: e.message };
  }
}

function escapeTelegram(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
  initTable,
  CATEGORIES, CATEGORY_LABELS, PRIORITIES, PRIORITY_COLORS,
  createTask, updateTask, completeTask, deleteTask, getTask, listTasks,
  getStats, sendDailyReminders,
};
