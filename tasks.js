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
  const task = r.rows[0];

  // Fire creation reminder (non-blocking) if due soon or urgent
  setImmediate(() => {
    sendCreationReminder(task).catch(e => console.warn("[tasks] creation reminder:", e.message));
  });

  return task;
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
      const daysLate = Math.abs(Math.floor((new Date(t.due_date) - new Date()) / 86400000));
      lines.push(`• #${t.id} [${daysLate}d late] ${escapeTelegram(t.title)}${t.client_name ? " — " + escapeTelegram(t.client_name) : ""}`);
    }
    if (overdue.length > 10) lines.push(`... and ${overdue.length - 10} more`);
    lines.push("");
  }

  if (dueTodayRows.length) {
    lines.push(`⚠️ <b>Due TODAY (${dueTodayRows.length})</b>`);
    for (const t of dueTodayRows.slice(0, 10)) {
      const priorityIcon = t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟠" : "🔵";
      lines.push(`${priorityIcon} #${t.id} ${escapeTelegram(t.title)}${t.client_name ? " — " + escapeTelegram(t.client_name) : ""}`);
    }
    lines.push("");
  }

  if (dueSoonRows.length) {
    lines.push(`📅 <b>Coming up (${dueSoonRows.length})</b>`);
    for (const t of dueSoonRows.slice(0, 10)) {
      const dt = new Date(t.due_date).toLocaleDateString();
      lines.push(`• #${t.id} ${dt} — ${escapeTelegram(t.title)}${t.client_name ? " (" + escapeTelegram(t.client_name) + ")" : ""}`);
    }
    lines.push("");
  }

  lines.push("<i>Commands: /tasks (list) · /done ID · /snooze ID days</i>");
  const tezBase = process.env.RENDER_EXTERNAL_URL || "https://tezlawfirm.com";
  lines.push(`<a href="${tezBase}/admin/tasks">Open task list →</a>`);
  const message = lines.join("\n");

  const chatId = process.env.JJ_TELEGRAM_ID;
  const result = await sendTelegramMessage(chatId, message);
  if (!result.ok) return result;

  // Mark reminders sent
  const allTaskIds = [...overdue, ...dueTodayRows, ...dueSoonRows].map(t => t.id);
  if (allTaskIds.length) {
    await db.query(
      `UPDATE tasks SET last_reminder_sent = NOW(), reminders_sent = reminders_sent + 1 WHERE id = ANY($1)`,
      [allTaskIds]
    );
  }
  return { sent: true, tasks_notified: allTaskIds.length };
}

// ─── Per-task reminders with inline buttons ─────────────
// Called hourly. Sends individual reminders for tasks that just entered
// their reminder window OR are overdue. Skips tasks already reminded in
// the last 20 hours to avoid spam.

async function sendPerTaskReminders() {
  await initTable();
  const chatId = process.env.JJ_TELEGRAM_ID;
  if (!chatId) return { sent: 0, reason: "no_chat_id" };

  // Find tasks that need a per-task ping right now:
  // - Due within their reminder_days_before window
  // - Not reminded in the last 20 hours
  // - Not completed/cancelled
  const candidates = await db.query(`
    SELECT * FROM tasks
    WHERE status NOT IN ('completed', 'cancelled')
      AND due_date IS NOT NULL
      AND (
        due_date < CURRENT_DATE
        OR due_date <= CURRENT_DATE + (COALESCE(reminder_days_before, 3) || ' days')::interval
      )
      AND (
        last_reminder_sent IS NULL
        OR last_reminder_sent < NOW() - INTERVAL '20 hours'
      )
    ORDER BY
      CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
      due_date ASC
    LIMIT 20
  `);

  let sent = 0;
  const errors = [];
  for (const t of candidates.rows) {
    try {
      await sendSingleTaskReminder(t, chatId);
      await db.query(
        `UPDATE tasks SET last_reminder_sent = NOW(), reminders_sent = reminders_sent + 1 WHERE id = $1`,
        [t.id]
      );
      sent++;
      await new Promise(r => setTimeout(r, 400));  // pace at 2.5/sec, well under Telegram limits
    } catch (e) {
      errors.push(`#${t.id}: ${e.message}`);
    }
  }
  return { sent, considered: candidates.rows.length, errors };
}

// Sends one individual task reminder with inline action buttons
async function sendSingleTaskReminder(task, chatId) {
  const daysUntil = Math.floor((new Date(task.due_date) - new Date()) / 86400000);
  let header;
  if (daysUntil < 0) header = `🚨 <b>OVERDUE ${Math.abs(daysUntil)} day${Math.abs(daysUntil) === 1 ? "" : "s"}</b>`;
  else if (daysUntil === 0) header = `⚠️ <b>DUE TODAY</b>`;
  else header = `📅 <b>Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}</b>`;

  const priorityEmoji = { urgent: "🔴", high: "🟠", normal: "🔵", low: "⚪" }[task.priority] || "🔵";
  const categoryLabel = task.category ? (CATEGORY_LABELS[task.category] || task.category) : "";

  const parts = [
    `${header} — <b>${escapeTelegram(task.title)}</b>`,
    "",
    `${priorityEmoji} Priority: ${task.priority}`,
  ];
  if (categoryLabel) parts.push(`📂 ${escapeTelegram(categoryLabel)}`);
  if (task.client_name) parts.push(`👤 ${escapeTelegram(task.client_name)}`);
  if (task.a_number) parts.push(`🆔 ${escapeTelegram(task.a_number)}`);
  if (task.case_number) parts.push(`📁 Case: ${escapeTelegram(task.case_number)}`);
  if (task.court) parts.push(`⚖️ ${escapeTelegram(task.court)}`);
  if (task.assigned_to) parts.push(`👥 Assigned: ${escapeTelegram(task.assigned_to)}`);
  parts.push(`📆 Due: ${new Date(task.due_date).toLocaleDateString()}${task.due_time ? " " + task.due_time : ""}`);
  if (task.description) {
    const desc = task.description.length > 200 ? task.description.substring(0, 200) + "…" : task.description;
    parts.push("");
    parts.push(escapeTelegram(desc));
  }

  const text = parts.join("\n");

  const buttons = {
    inline_keyboard: [
      [
        { text: "✓ Done", callback_data: `task_done_${task.id}` },
        { text: "⏰ +1d", callback_data: `task_snooze_${task.id}_1` },
        { text: "⏰ +7d", callback_data: `task_snooze_${task.id}_7` },
      ],
      [
        { text: "🔗 Open", url: `${process.env.RENDER_EXTERNAL_URL || "https://tezlawfirm.com"}/admin/tasks/${task.id}` },
      ],
    ],
  };

  return sendTelegramMessage(chatId, text, buttons);
}

// Immediate reminder when a task is created that's due soon
async function sendCreationReminder(task) {
  if (!task || !task.due_date) return;
  const chatId = process.env.JJ_TELEGRAM_ID;
  if (!chatId) return;
  const daysUntil = Math.floor((new Date(task.due_date) - new Date()) / 86400000);
  const window = task.reminder_days_before || 3;
  // Only send immediate if due within reminder window OR is urgent
  if (daysUntil > window && task.priority !== "urgent") return;
  try {
    await sendSingleTaskReminder(task, chatId);
    await db.query(
      `UPDATE tasks SET last_reminder_sent = NOW(), reminders_sent = reminders_sent + 1 WHERE id = $1`,
      [task.id]
    );
  } catch (e) { console.warn("[tasks] creation reminder failed:", e.message); }
}

// Snooze a task by pushing its due date forward N days
async function snoozeTask(id, days) {
  await initTable();
  const r = await db.query(
    `UPDATE tasks SET
       due_date = COALESCE(due_date, CURRENT_DATE) + ($2 || ' days')::interval,
       last_reminder_sent = NULL,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, days]
  );
  return r.rows[0];
}

// ─── Telegram helpers ───────────────────────────────────

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
  if (!token || !chatId) return { ok: false, reason: "no_telegram_config" };
  try {
    const axios = require("axios");
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      payload,
      { timeout: 15000 }
    );
    return { ok: true };
  } catch (e) {
    console.warn("[tasks] Telegram send failed:", e.message);
    return { ok: false, reason: e.message };
  }
}

// ─── Telegram command router (called from server.js webhook) ────
// Returns true if the message was handled (so server.js knows not to
// pass it to Claude).

async function handleTelegramCommand(text, chatId) {
  const trimmed = (text || "").trim();

  // /tasks — list open tasks
  if (/^\/tasks(@\w+)?\s*$/i.test(trimmed)) {
    const rows = await listTasks({ limit: 20 });
    if (!rows.length) {
      await sendTelegramMessage(chatId, "📋 No open tasks. 🎉");
      return true;
    }
    const lines = [`📋 <b>Open tasks (${rows.length})</b>`, ""];
    for (const t of rows) {
      const days = t.days_until_due;
      let dueTag = "";
      if (days == null) dueTag = "";
      else if (days < 0) dueTag = ` 🚨 ${Math.abs(days)}d late`;
      else if (days === 0) dueTag = " ⚠️ TODAY";
      else if (days <= 3) dueTag = ` 🟠 ${days}d`;
      else dueTag = ` (${days}d)`;
      const pIcon = { urgent: "🔴", high: "🟠", normal: "🔵", low: "⚪" }[t.priority] || "🔵";
      lines.push(`${pIcon} #${t.id} ${escapeTelegram(t.title)}${dueTag}${t.client_name ? " — " + escapeTelegram(t.client_name) : ""}`);
    }
    lines.push("");
    lines.push("<i>/done ID · /snooze ID days</i>");
    await sendTelegramMessage(chatId, lines.join("\n"));
    return true;
  }

  // /done <id> — mark task complete
  const doneMatch = trimmed.match(/^\/done(@\w+)?\s+#?(\d+)/i);
  if (doneMatch) {
    const id = parseInt(doneMatch[2], 10);
    const t = await getTask(id);
    if (!t) {
      await sendTelegramMessage(chatId, `❌ Task #${id} not found`);
      return true;
    }
    if (t.status === "completed") {
      await sendTelegramMessage(chatId, `✅ Task #${id} was already completed`);
      return true;
    }
    await completeTask(id, { userId: null, notes: "Marked done via Telegram" });
    await sendTelegramMessage(chatId, `✓ Completed #${id}: <b>${escapeTelegram(t.title)}</b>`);
    return true;
  }

  // /snooze <id> <days> — push due date forward
  const snoozeMatch = trimmed.match(/^\/snooze(@\w+)?\s+#?(\d+)\s+(\d+)/i);
  if (snoozeMatch) {
    const id = parseInt(snoozeMatch[2], 10);
    const days = parseInt(snoozeMatch[3], 10);
    if (days < 1 || days > 365) {
      await sendTelegramMessage(chatId, "❌ Snooze days must be 1-365");
      return true;
    }
    const updated = await snoozeTask(id, days);
    if (!updated) {
      await sendTelegramMessage(chatId, `❌ Task #${id} not found`);
      return true;
    }
    const newDue = new Date(updated.due_date).toLocaleDateString();
    await sendTelegramMessage(chatId, `⏰ Snoozed #${id} to <b>${newDue}</b>: ${escapeTelegram(updated.title)}`);
    return true;
  }

  // /newtask <title> — quick add
  const newTaskMatch = trimmed.match(/^\/newtask(@\w+)?\s+(.+)/is);
  if (newTaskMatch) {
    const title = newTaskMatch[2].trim();
    const t = await createTask({ title, priority: "normal" });
    await sendTelegramMessage(chatId, `✓ Created task #${t.id}: <b>${escapeTelegram(title)}</b>\n\nOpen to add due date, category, client: ${process.env.RENDER_EXTERNAL_URL || "https://tezlawfirm.com"}/admin/tasks/${t.id}`);
    return true;
  }

  return false;
}

// Handle inline button callbacks (task_done_ID, task_snooze_ID_DAYS)
async function handleTelegramCallback(callbackData, chatId, callbackQueryId) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;

  const doneMatch = callbackData.match(/^task_done_(\d+)$/);
  if (doneMatch) {
    const id = parseInt(doneMatch[1], 10);
    const t = await getTask(id);
    if (!t) return { answer: `Task #${id} not found` };
    if (t.status === "completed") return { answer: `Already completed` };
    await completeTask(id, { userId: null, notes: "Done via Telegram" });
    await sendTelegramMessage(chatId, `✓ Completed #${id}: <b>${escapeTelegram(t.title)}</b>`);
    return { answer: `✓ Marked done` };
  }

  const snoozeMatch = callbackData.match(/^task_snooze_(\d+)_(\d+)$/);
  if (snoozeMatch) {
    const id = parseInt(snoozeMatch[1], 10);
    const days = parseInt(snoozeMatch[2], 10);
    const updated = await snoozeTask(id, days);
    if (!updated) return { answer: `Task #${id} not found` };
    const newDue = new Date(updated.due_date).toLocaleDateString();
    await sendTelegramMessage(chatId, `⏰ Snoozed #${id} to <b>${newDue}</b>: ${escapeTelegram(updated.title)}`);
    return { answer: `⏰ Snoozed ${days}d → ${newDue}` };
  }

  return null;
}

function escapeTelegram(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── AI extraction — parse tasks from a description or document ─────────
// Sends the input (plain text OR PDF bytes) to Claude and asks it to
// return a JSON array of tasks. Each task is validated against our schema
// before being returned to the caller (which typically presents them for
// preview before actually creating them).

async function extractTasksFromContent({ textContent = null, pdfBuffer = null, mimeType = null, filename = null } = {}) {
  const axios = require("axios");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  // Build the list of legal categories for the prompt so Claude knows what to tag
  const catList = [];
  for (const [matter, cats] of Object.entries(CATEGORIES)) {
    catList.push(`  ${matter}: ${cats.map(c => c.key).join(", ")}`);
  }

  const today = new Date().toISOString().split("T")[0];

  const systemPrompt = `You are a legal task extractor for Tez Law P.C.

Your job: read the input (which may be a natural-language description from an attorney, OR text from a legal document like a court notice, RFE, NOID, motion, or hearing transcript) and extract a JSON array of one or more tasks the firm needs to complete.

Today's date is ${today}.

For EACH task, output an object with these fields:
{
  "title": string (required, imperative, ~5-10 words e.g. "File motion to reopen for Chen Wei")
  "description": string (optional, 1-3 sentences with the specific context — deadline citation, procedural stage, key facts)
  "category": string from this list of valid category keys:
${catList.join("\n")}
  "matter_type": one of: immigration, pi, business, ll_tenant, estate, tm, real_estate, admin
  "priority": one of: urgent (real deadline within 7 days, detained client, or imminent harm), high (deadline within 30 days), normal (default), low
  "due_date": ISO date string YYYY-MM-DD if a specific date is mentioned or clearly implied. Compute relative dates like "in 30 days" from today. Leave null if truly unknown — DO NOT invent dates.
  "reminder_days_before": integer, default 3. Set higher (7-14) for filings requiring prep, lower (1-2) for simple reminders.
  "client_name": string if a client is named or clearly implied
  "a_number": string in format "A###-###-###" if an A-Number appears
  "case_number": string if a court/case number appears
  "court": string if a specific court is mentioned (e.g. "LA Immigration Court", "9th Circuit", "LASC")
  "assigned_to": string only if a specific staff member is named (JJ, Michael, Chandler, Jue, Lin)
}

Rules:
- Extract MULTIPLE tasks when the input clearly describes multiple actions (e.g. an RFE requiring 3 different responses = 3 tasks).
- Prefer FEWER, better tasks over splitting hairs. Combine sub-steps into one task's description.
- NEVER invent facts, deadlines, A-numbers, or case numbers. If unclear, leave the field null.
- For deadline calculations, use exact statutory / rule-based dates when quoted in the document (e.g. "30 days from RFE issuance" — count from the issuance date in the doc).
- If the document is a court notice with a hearing date, create a "prep task" with due_date = hearing_date minus 7 days, and category = individual_hearing_prep or master_calendar_prep.
- Return ONLY a JSON array. No preamble, no markdown fences, no commentary.
- If the input describes zero actionable tasks, return an empty array [].`;

  const userContent = [];
  if (pdfBuffer) {
    userContent.push({
      type: "document",
      source: {
        type: "base64",
        media_type: mimeType || "application/pdf",
        data: pdfBuffer.toString("base64"),
      },
    });
    userContent.push({
      type: "text",
      text: `Extract tasks from this document${filename ? ` (${filename})` : ""}. Return JSON array only.`,
    });
  } else if (textContent) {
    userContent.push({
      type: "text",
      text: `Extract tasks from this input. Return JSON array only.\n\n---\n${textContent}\n---`,
    });
  } else {
    throw new Error("Either textContent or pdfBuffer required");
  }

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );

  const raw = resp.data.content?.[0]?.text?.trim() || "[]";
  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let arr;
  try {
    arr = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON: ${cleaned.substring(0, 200)}…`);
  }
  if (!Array.isArray(arr)) throw new Error("Expected a JSON array of tasks");

  // Validate + sanitize each extracted task against known enums
  const validMatters = ["immigration", "pi", "business", "ll_tenant", "estate", "tm", "real_estate", "admin"];
  const validPriorities = ["low", "normal", "high", "urgent"];
  const validCategoryKeys = new Set();
  for (const cats of Object.values(CATEGORIES)) for (const c of cats) validCategoryKeys.add(c.key);

  return arr.map(t => ({
    title: String(t.title || "").trim() || "Untitled task",
    description: t.description ? String(t.description).trim() : null,
    category: t.category && validCategoryKeys.has(t.category) ? t.category : null,
    matter_type: validMatters.includes(t.matter_type) ? t.matter_type : null,
    priority: validPriorities.includes(t.priority) ? t.priority : "normal",
    due_date: t.due_date && /^\d{4}-\d{2}-\d{2}$/.test(t.due_date) ? t.due_date : null,
    reminder_days_before: Number.isInteger(t.reminder_days_before) && t.reminder_days_before >= 0 && t.reminder_days_before <= 30
      ? t.reminder_days_before : 3,
    client_name: t.client_name ? String(t.client_name).trim() : null,
    a_number: t.a_number ? String(t.a_number).trim() : null,
    case_number: t.case_number ? String(t.case_number).trim() : null,
    court: t.court ? String(t.court).trim() : null,
    assigned_to: t.assigned_to ? String(t.assigned_to).trim() : null,
  }));
}

module.exports = {
  initTable,
  CATEGORIES, CATEGORY_LABELS, PRIORITIES, PRIORITY_COLORS,
  createTask, updateTask, completeTask, deleteTask, getTask, listTasks,
  getStats, snoozeTask,
  sendDailyReminders, sendPerTaskReminders, sendCreationReminder, sendSingleTaskReminder,
  handleTelegramCommand, handleTelegramCallback,
  extractTasksFromContent,
};
