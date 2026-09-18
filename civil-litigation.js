// ============================================================
//  TEZ LAW P.C. — CIVIL LITIGATION MODULE
//  ─────────────────────────────────────────────────────────
//  Case management for civil litigation matters:
//    · 8-stage kanban lifecycle (intake → post-trial)
//    · Auto-calculated deadlines from California CCP rules
//    · Event log per case (filings, hearings, motions, communications)
//    · Billable time tracking per event
//    · Client + opposing counsel contact info
//    · Integration with existing tasks / deadlines / documents
//
//  Design based on Am Law 100 workflow research + California
//  Code of Civil Procedure. Every auto-generated deadline
//  cites its statutory authority so paralegals can verify.
// ============================================================

const db = require("./db");

const STAGES = [
  { key: "intake",      label: "Intake / Assessment",  color: "#7B5330", order: 1 },
  { key: "pre_filing",  label: "Pre-Filing",           color: "#B8891E", order: 2 },
  { key: "pleadings",   label: "Pleadings",            color: "#D97706", order: 3 },
  { key: "discovery",   label: "Discovery",            color: "#0284C7", order: 4 },
  { key: "motions",     label: "Motion Practice",      color: "#7C3AED", order: 5 },
  { key: "trial_prep",  label: "Trial Prep",           color: "#DC2626", order: 6 },
  { key: "trial",       label: "Trial",                color: "#991B1B", order: 7 },
  { key: "post_trial",  label: "Post-Trial",           color: "#4B5563", order: 8 },
  { key: "closed",      label: "Closed",               color: "#166534", order: 9 },
];

const STAGE_KEYS = new Set(STAGES.map(s => s.key));

const CASE_TYPES = [
  "breach of contract", "business tort", "personal injury",
  "employment", "landlord/tenant — unlawful detainer",
  "landlord/tenant — general", "real estate", "collections",
  "declaratory relief", "quiet title", "partnership dispute",
  "trust / estate contest", "family law", "civil rights",
  "insurance bad faith", "professional malpractice",
  "consumer / class action", "intellectual property",
  "wage & hour", "other",
];

const OUR_ROLES = [
  "plaintiff", "defendant", "cross-defendant", "cross-complainant",
  "petitioner", "respondent", "intervenor",
];

async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_cases (
      id                     SERIAL PRIMARY KEY,
      client_key             TEXT NOT NULL,
      case_name              TEXT NOT NULL,
      case_type              TEXT,
      court                  TEXT,
      county                 TEXT,
      case_number            TEXT,
      our_role               TEXT,
      filed_date             DATE,
      service_date           DATE,
      answered_date          DATE,
      statute_of_limitations DATE,
      opposing_party         TEXT,
      opposing_counsel       JSONB,
      lead_attorney_id       INTEGER,
      case_manager_id        INTEGER,
      stage                  TEXT DEFAULT 'intake',
      trial_date             DATE,
      cmc_date               DATE,
      amount_in_controversy  NUMERIC,
      billing_type           TEXT DEFAULT 'hourly',
      hourly_rate            NUMERIC,
      contingency_pct        NUMERIC,
      retainer_amount        NUMERIC,
      retainer_balance       NUMERIC,
      status                 TEXT DEFAULT 'active',
      outcome_notes          TEXT,
      internal_notes         TEXT,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_cases_client_key ON civil_cases (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_cases_stage ON civil_cases (stage) WHERE status = 'active'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_cases_lead_attorney ON civil_cases (lead_attorney_id) WHERE status = 'active'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_cases_case_number ON civil_cases (case_number) WHERE case_number IS NOT NULL`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_case_events (
      id                SERIAL PRIMARY KEY,
      case_id           INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      event_kind        TEXT NOT NULL,
      event_date        DATE,
      title             TEXT NOT NULL,
      description       TEXT,
      billable_hours    NUMERIC,
      billable_rate     NUMERIC,
      billable_amount   NUMERIC,
      attorney_id       INTEGER,
      paralegal_id      INTEGER,
      document_ids      INTEGER[],
      ccp_rule          TEXT,
      outcome           TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      created_by        TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_events_case ON civil_case_events (case_id, event_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_events_kind ON civil_case_events (event_kind)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_case_deadlines (
      id                    SERIAL PRIMARY KEY,
      case_id               INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      due_date              DATE NOT NULL,
      description           TEXT NOT NULL,
      ccp_rule              TEXT,
      priority              TEXT DEFAULT 'medium',
      status                TEXT DEFAULT 'pending',
      auto_generated        BOOLEAN DEFAULT FALSE,
      source_trigger        TEXT,
      attorney_id           INTEGER,
      paralegal_id          INTEGER,
      completed_at          TIMESTAMPTZ,
      completed_by          TEXT,
      reminder_days_before  INTEGER DEFAULT 3,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_deadlines_case ON civil_case_deadlines (case_id, due_date)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_deadlines_pending ON civil_case_deadlines (due_date) WHERE status = 'pending'`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_civil_deadlines_auto
    ON civil_case_deadlines (case_id, source_trigger)
    WHERE auto_generated = TRUE
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_case_communications (
      id             SERIAL PRIMARY KEY,
      case_id        INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      kind           TEXT,
      direction      TEXT,
      channel        TEXT,
      subject        TEXT,
      body           TEXT,
      contact_name   TEXT,
      contact_email  TEXT,
      contact_phone  TEXT,
      billable_hours NUMERIC,
      attorney_id    INTEGER,
      paralegal_id   INTEGER,
      document_ids   INTEGER[],
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      created_by     TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_comms_case ON civil_case_communications (case_id, created_at DESC)`);
}

// California court holidays for date arithmetic. Simplified list — the
// production version should sync from the JC's official calendar yearly.
const COURT_HOLIDAYS = new Set([
  "2026-01-01","2026-01-19","2026-02-16","2026-05-25","2026-07-03","2026-09-07","2026-11-11","2026-11-26","2026-11-27","2026-12-24","2026-12-25","2026-12-31",
  "2027-01-01","2027-01-18","2027-02-15","2027-05-31","2027-07-05","2027-09-06","2027-11-11","2027-11-25","2027-11-26","2027-12-23","2027-12-24","2027-12-31",
  "2028-01-03","2028-01-17","2028-02-21","2028-05-29","2028-07-04","2028-09-04","2028-11-10","2028-11-23","2028-11-24","2028-12-25","2028-12-26",
  "2029-01-01","2029-01-15","2029-02-19","2029-05-28","2029-07-04","2029-09-03","2029-11-12","2029-11-22","2029-11-23","2029-12-24","2029-12-25","2029-12-31",
  "2030-01-01","2030-01-21","2030-02-18","2030-05-27","2030-07-04","2030-09-02","2030-11-11","2030-11-28","2030-11-29","2030-12-24","2030-12-25",
]);

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function fmtDate(d) {
  if (!d) return null;
  const dt = toDate(d);
  if (!dt) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function isWeekend(d) { const g = d.getDay(); return g === 0 || g === 6; }
function isCourtHoliday(d) { return COURT_HOLIDAYS.has(fmtDate(d)); }

function addCalendarDays(dateStr, n) {
  const d = toDate(dateStr);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  while (isWeekend(d) || isCourtHoliday(d)) d.setDate(d.getDate() + 1);
  return fmtDate(d);
}

function subCalendarDaysBackToCourtDay(dateStr, n) {
  const d = toDate(dateStr);
  if (!d) return null;
  d.setDate(d.getDate() - n);
  while (isWeekend(d) || isCourtHoliday(d)) d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

// CCP deadline rules. Each returns a candidate deadline record for the case.
const CCP_RULES = [
  {
    key: "sol", triggerField: "statute_of_limitations", priority: "high",
    build: (c) => c.statute_of_limitations ? {
      due_date: fmtDate(c.statute_of_limitations),
      description: "Statute of Limitations expires — must file by this date",
      ccp_rule: "CCP § 335 et seq.",
      reminder_days_before: 30,
    } : null,
  },
  {
    key: "proof_of_service", triggerField: "filed_date", priority: "high",
    build: (c) => c.filed_date && c.our_role === "plaintiff" ? {
      due_date: addCalendarDays(c.filed_date, 60),
      description: "File Proof of Service (must serve within 60 days of filing)",
      ccp_rule: "CCP § 583.210 / CRC 3.110(b)",
      reminder_days_before: 10,
    } : null,
  },
  {
    key: "answer_due", triggerField: "service_date", priority: "high",
    build: (c) => c.service_date && c.our_role === "defendant" ? {
      due_date: addCalendarDays(c.service_date, 30),
      description: "Answer / Demurrer / Motion to Strike due (30 days from personal service)",
      ccp_rule: "CCP § 412.20(a)(3)",
      reminder_days_before: 7,
    } : null,
  },
  {
    key: "discovery_opens_plaintiff", triggerField: "service_date", priority: "medium",
    build: (c) => c.service_date && c.our_role === "plaintiff" ? {
      due_date: addCalendarDays(c.service_date, 10),
      description: "Written discovery may now be propounded (10 days after service)",
      ccp_rule: "CCP § 2030.020",
      reminder_days_before: 0,
    } : null,
  },
  {
    key: "deposition_notices_plaintiff", triggerField: "service_date", priority: "low",
    build: (c) => c.service_date && c.our_role === "plaintiff" ? {
      due_date: addCalendarDays(c.service_date, 20),
      description: "Deposition notices may now be served (20 days after service)",
      ccp_rule: "CCP § 2025.210",
      reminder_days_before: 0,
    } : null,
  },
  {
    key: "cmc_statement", triggerField: "cmc_date", priority: "high",
    build: (c) => c.cmc_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.cmc_date, 15),
      description: "Case Management Statement due (15 court days before CMC)",
      ccp_rule: "CRC 3.725",
      reminder_days_before: 5,
    } : null,
  },
  {
    key: "cmc_meet_and_confer", triggerField: "cmc_date", priority: "medium",
    build: (c) => c.cmc_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.cmc_date, 30),
      description: "Meet and confer with opposing counsel re: CMC issues",
      ccp_rule: "CRC 3.724",
      reminder_days_before: 5,
    } : null,
  },
  {
    key: "expert_witness_exchange", triggerField: "trial_date", priority: "high",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 50),
      description: "Expert witness list exchange (50 days before trial or 20 days after demand)",
      ccp_rule: "CCP § 2034.230(b)",
      reminder_days_before: 14,
    } : null,
  },
  {
    key: "discovery_cutoff", triggerField: "trial_date", priority: "high",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 30),
      description: "Discovery cutoff — no new discovery may be conducted",
      ccp_rule: "CCP § 2024.020(a)",
      reminder_days_before: 30,
    } : null,
  },
  {
    key: "discovery_motions_cutoff", triggerField: "trial_date", priority: "high",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 15),
      description: "Last day to hear discovery motions",
      ccp_rule: "CCP § 2024.020(a)",
      reminder_days_before: 21,
    } : null,
  },
  {
    key: "msj_hearing_deadline", triggerField: "trial_date", priority: "high",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 30),
      description: "MSJ must be heard by this date (30 days before trial)",
      ccp_rule: "CCP § 437c(a)(3)",
      reminder_days_before: 75,
    } : null,
  },
  {
    key: "msj_filing_deadline", triggerField: "trial_date", priority: "high",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 105),
      description: "Motion for Summary Judgment must be filed (75-day notice + heard 30 days before trial)",
      ccp_rule: "CCP § 437c(a)(2)-(3)",
      reminder_days_before: 21,
    } : null,
  },
  {
    key: "motions_in_limine", triggerField: "trial_date", priority: "medium",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 14),
      description: "Motions in limine due (typical — check local rules)",
      ccp_rule: "Local rules; CCP § 128(a)(8)",
      reminder_days_before: 14,
    } : null,
  },
  {
    key: "trial_brief", triggerField: "trial_date", priority: "medium",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 5),
      description: "Trial brief, jury instructions, verdict forms due (typical)",
      ccp_rule: "CRC 3.1548 / local rules",
      reminder_days_before: 14,
    } : null,
  },
  {
    key: "section_998_offer_cutoff", triggerField: "trial_date", priority: "medium",
    build: (c) => c.trial_date ? {
      due_date: subCalendarDaysBackToCourtDay(c.trial_date, 10),
      description: "Last day to serve CCP § 998 offer to compromise",
      ccp_rule: "CCP § 998(b)",
      reminder_days_before: 21,
    } : null,
  },
];

async function createCase(data) {
  const {
    client_key, case_name, case_type, court, county, case_number, our_role,
    filed_date, service_date, answered_date, statute_of_limitations,
    opposing_party, opposing_counsel, lead_attorney_id, case_manager_id,
    stage, trial_date, cmc_date, amount_in_controversy,
    billing_type, hourly_rate, contingency_pct, retainer_amount,
    internal_notes, created_by,
  } = data;
  if (!client_key || !case_name) throw new Error("client_key and case_name are required");
  const s = stage && STAGE_KEYS.has(stage) ? stage : "intake";
  const r = await db.query(
    `INSERT INTO civil_cases
       (client_key, case_name, case_type, court, county, case_number, our_role,
        filed_date, service_date, answered_date, statute_of_limitations,
        opposing_party, opposing_counsel,
        lead_attorney_id, case_manager_id,
        stage, trial_date, cmc_date, amount_in_controversy,
        billing_type, hourly_rate, contingency_pct, retainer_amount, retainer_balance,
        internal_notes, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,
             $8,$9,$10,$11,
             $12,$13::jsonb,
             $14,$15,
             $16,$17,$18,$19,
             $20,$21,$22,$23,$23,
             $24, NOW(), NOW())
     RETURNING *`,
    [
      client_key, case_name, case_type || null, court || null, county || null,
      case_number || null, our_role || null,
      filed_date || null, service_date || null, answered_date || null,
      statute_of_limitations || null,
      opposing_party || null,
      JSON.stringify(opposing_counsel || {}),
      lead_attorney_id || null, case_manager_id || null,
      s, trial_date || null, cmc_date || null,
      amount_in_controversy || null,
      billing_type || "hourly", hourly_rate || null,
      contingency_pct || null, retainer_amount || null,
      internal_notes || null,
    ]
  );
  const caseId = r.rows[0].id;
  await logEvent(caseId, {
    event_kind: "note",
    event_date: fmtDate(new Date()),
    title: `Case opened: ${case_name}`,
    description: `Initial intake — stage: ${s}`,
    created_by,
  });
  await autoGenerateDeadlines(caseId);
  return r.rows[0];
}

async function updateCase(id, data) {
  const allowed = new Set([
    "client_key","case_name","case_type","court","county","case_number","our_role",
    "filed_date","service_date","answered_date","statute_of_limitations",
    "opposing_party","opposing_counsel","lead_attorney_id","case_manager_id",
    "stage","trial_date","cmc_date","amount_in_controversy",
    "billing_type","hourly_rate","contingency_pct","retainer_amount","retainer_balance",
    "status","outcome_notes","internal_notes",
    "court_docket_url",  // build 37 court-docket checker
  ]);
  const jsonbFields = new Set(["opposing_counsel"]);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) continue;
    if (jsonbFields.has(key)) {
      sets.push(`${key} = $${i++}::jsonb`);
      vals.push(JSON.stringify(data[key] || {}));
    } else {
      sets.push(`${key} = $${i++}`);
      vals.push(data[key] === "" ? null : data[key]);
    }
  }
  if (!sets.length) throw new Error("No editable fields provided");
  sets.push("updated_at = NOW()");
  vals.push(id);
  const r = await db.query(
    `UPDATE civil_cases SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  if (!r.rows.length) throw new Error("Case not found");
  const dateFields = ["filed_date","service_date","statute_of_limitations","cmc_date","trial_date"];
  if (dateFields.some(f => f in data)) {
    await autoGenerateDeadlines(id);
  }
  return r.rows[0];
}

async function getCase(id) {
  const r = await db.query(`SELECT * FROM civil_cases WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function listCases(filter = {}) {
  const where = ["1=1"];
  const vals = [];
  let i = 1;
  if (filter.client_key) { where.push(`client_key = $${i++}`); vals.push(filter.client_key); }
  if (filter.stage) { where.push(`stage = $${i++}`); vals.push(filter.stage); }
  if (filter.status) { where.push(`status = $${i++}`); vals.push(filter.status); }
  if (filter.lead_attorney_id) { where.push(`lead_attorney_id = $${i++}`); vals.push(filter.lead_attorney_id); }
  const limit = Math.min(parseInt(filter.limit || "200", 10), 500);
  const r = await db.query(
    `SELECT * FROM civil_cases WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC LIMIT $${i}`,
    [...vals, limit]
  );
  return r.rows;
}

async function deleteCase(id) {
  const r = await db.query(`DELETE FROM civil_cases WHERE id = $1 RETURNING id, case_name`, [id]);
  if (!r.rows.length) throw new Error("Case not found");
  return r.rows[0];
}

async function logEvent(caseId, data) {
  const {
    event_kind, event_date, title, description,
    billable_hours, billable_rate,
    attorney_id, paralegal_id, document_ids, ccp_rule, outcome, created_by,
  } = data;
  if (!event_kind || !title) throw new Error("event_kind and title are required");
  const bh = billable_hours ? Number(billable_hours) : null;

  // ── Build 38: multi-rate timekeepers ──────────────────────
  // An explicit billable_rate from the caller always wins. If the caller gave
  // us hours but NO rate, resolve the rate for whoever actually logged the
  // time: case-team override → that user's default (admin_users.billing_rate)
  // → the case's hourly_rate. If resolution fails for any reason we fall
  // through with a null rate rather than blocking the time entry.
  let br = billable_rate != null && billable_rate !== "" ? Number(billable_rate) : null;
  if (!Number.isFinite(br)) br = null;
  if (br == null && bh != null) {
    try {
      const billing = require("./civil-billing");
      const timekeeper = attorney_id || paralegal_id || null;
      br = await billing.resolveRate(timekeeper, caseId);
    } catch (e) {
      console.warn("[civil-litigation] rate resolution failed:", e.message);
    }
  }
  if (!Number.isFinite(br)) br = null;

  const ba = bh != null && br != null ? Number((bh * br).toFixed(2)) : null;
  const r = await db.query(
    `INSERT INTO civil_case_events
       (case_id, event_kind, event_date, title, description,
        billable_hours, billable_rate, billable_amount,
        attorney_id, paralegal_id, document_ids,
        ccp_rule, outcome, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      caseId, event_kind, event_date || null, title, description || null,
      bh, br, ba,
      attorney_id || null, paralegal_id || null, document_ids || null,
      ccp_rule || null, outcome || null, created_by || null,
    ]
  );
  await db.query(`UPDATE civil_cases SET updated_at = NOW() WHERE id = $1`, [caseId]);
  return r.rows[0];
}

async function listEvents(caseId, filter = {}) {
  const where = ["case_id = $1"];
  const vals = [caseId];
  let i = 2;
  if (filter.event_kind) { where.push(`event_kind = $${i++}`); vals.push(filter.event_kind); }
  const limit = Math.min(parseInt(filter.limit || "500", 10), 1000);
  const r = await db.query(
    `SELECT * FROM civil_case_events WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(event_date, created_at::date) DESC, created_at DESC
     LIMIT $${i}`,
    [...vals, limit]
  );
  return r.rows;
}

async function autoGenerateDeadlines(caseId) {
  const c = await getCase(caseId);
  if (!c) return { upserted: 0 };
  let n = 0;
  for (const rule of CCP_RULES) {
    const built = rule.build(c);
    if (!built || !built.due_date) continue;
    await db.query(
      `INSERT INTO civil_case_deadlines
         (case_id, due_date, description, ccp_rule, priority,
          auto_generated, source_trigger, reminder_days_before,
          attorney_id, paralegal_id)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8,$9)
       ON CONFLICT (case_id, source_trigger) WHERE auto_generated = TRUE
       DO UPDATE SET
         due_date = EXCLUDED.due_date,
         description = EXCLUDED.description,
         ccp_rule = EXCLUDED.ccp_rule,
         priority = EXCLUDED.priority,
         reminder_days_before = EXCLUDED.reminder_days_before`,
      [
        caseId, built.due_date, built.description, built.ccp_rule || null,
        built.priority || "medium", rule.key,
        built.reminder_days_before != null ? built.reminder_days_before : 3,
        c.lead_attorney_id || null, c.case_manager_id || null,
      ]
    );
    n++;
  }
  return { upserted: n };
}

async function addManualDeadline(caseId, data) {
  const { due_date, description, ccp_rule, priority,
          attorney_id, paralegal_id, reminder_days_before } = data;
  if (!due_date || !description) throw new Error("due_date and description are required");
  const r = await db.query(
    `INSERT INTO civil_case_deadlines
       (case_id, due_date, description, ccp_rule, priority,
        auto_generated, source_trigger, reminder_days_before,
        attorney_id, paralegal_id)
     VALUES ($1,$2,$3,$4,$5,FALSE,NULL,$6,$7,$8)
     RETURNING *`,
    [
      caseId, due_date, description, ccp_rule || null,
      priority || "medium",
      reminder_days_before != null ? reminder_days_before : 3,
      attorney_id || null, paralegal_id || null,
    ]
  );
  return r.rows[0];
}

async function completeDeadline(id, user) {
  const r = await db.query(
    `UPDATE civil_case_deadlines SET status = 'completed',
       completed_at = NOW(), completed_by = $2
     WHERE id = $1 RETURNING *`,
    [id, user || null]
  );
  return r.rows[0];
}

async function listDeadlines(caseId, filter = {}) {
  const where = ["case_id = $1"];
  const vals = [caseId];
  let i = 2;
  if (filter.status) { where.push(`status = $${i++}`); vals.push(filter.status); }
  const r = await db.query(
    `SELECT * FROM civil_case_deadlines WHERE ${where.join(" AND ")}
     ORDER BY due_date ASC LIMIT 200`,
    vals
  );
  return r.rows;
}

async function logCommunication(caseId, data) {
  const { kind, direction, channel, subject, body,
          contact_name, contact_email, contact_phone,
          billable_hours, attorney_id, paralegal_id, document_ids, created_by } = data;
  const r = await db.query(
    `INSERT INTO civil_case_communications
       (case_id, kind, direction, channel, subject, body,
        contact_name, contact_email, contact_phone,
        billable_hours, attorney_id, paralegal_id, document_ids, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      caseId, kind || null, direction || null, channel || null,
      subject || null, body || null,
      contact_name || null, contact_email || null, contact_phone || null,
      billable_hours ? Number(billable_hours) : null,
      attorney_id || null, paralegal_id || null, document_ids || null,
      created_by || null,
    ]
  );
  await db.query(`UPDATE civil_cases SET updated_at = NOW() WHERE id = $1`, [caseId]);
  return r.rows[0];
}

async function listCommunications(caseId) {
  const r = await db.query(
    `SELECT * FROM civil_case_communications WHERE case_id = $1
     ORDER BY created_at DESC LIMIT 500`,
    [caseId]
  );
  return r.rows;
}

async function kanban(filter = {}) {
  const cases = await listCases({ status: "active", ...filter });
  const grouped = {};
  for (const s of STAGES) grouped[s.key] = [];
  for (const c of cases) {
    if (grouped[c.stage]) grouped[c.stage].push(c);
    else grouped.intake.push(c);
  }
  return {
    stages: STAGES,
    counts: Object.fromEntries(STAGES.map(s => [s.key, grouped[s.key].length])),
    cases_by_stage: grouped,
  };
}

async function getCaseSummary(caseId) {
  const c = await getCase(caseId);
  if (!c) return null;
  const [nextDeadlineR, billableR, eventCountR, commCountR] = await Promise.all([
    db.query(
      `SELECT * FROM civil_case_deadlines
       WHERE case_id = $1 AND status = 'pending'
       ORDER BY due_date ASC LIMIT 1`,
      [caseId]
    ),
    db.query(
      `SELECT COALESCE(SUM(billable_hours), 0)::float AS total_hours,
              COALESCE(SUM(billable_amount), 0)::float AS total_amount
       FROM civil_case_events WHERE case_id = $1`,
      [caseId]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM civil_case_events WHERE case_id = $1`, [caseId]),
    db.query(`SELECT COUNT(*)::int AS n FROM civil_case_communications WHERE case_id = $1`, [caseId]),
  ]);
  return {
    ...c,
    next_deadline: nextDeadlineR.rows[0] || null,
    billable_total_hours: billableR.rows[0] ? billableR.rows[0].total_hours : 0,
    billable_total_amount: billableR.rows[0] ? billableR.rows[0].total_amount : 0,
    event_count: eventCountR.rows[0] ? eventCountR.rows[0].n : 0,
    communication_count: commCountR.rows[0] ? commCountR.rows[0].n : 0,
  };
}

module.exports = {
  initTables,
  STAGES, STAGE_KEYS, CASE_TYPES, OUR_ROLES, CCP_RULES,
  createCase, updateCase, getCase, listCases, deleteCase,
  logEvent, listEvents,
  autoGenerateDeadlines, addManualDeadline, completeDeadline, listDeadlines,
  logCommunication, listCommunications,
  kanban, getCaseSummary,
  addCalendarDays, subCalendarDaysBackToCourtDay, fmtDate,
};
