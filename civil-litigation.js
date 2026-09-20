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
// Multi-state deadline rules and the phase playbooks. Both are required
// lazily inside functions where a load failure must not take the module
// down, but the deadline engine is core enough to require up front.
const jurisdictions = require("./civil-jurisdictions");

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
      utbms_code        TEXT,
      utbms_activity    TEXT,
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

  // UTBMS coding on every billable row. Existing installs get the columns
  // added rather than recreated, and legacy rows simply carry NULL.
  for (const tbl of ["civil_case_events", "civil_case_communications"]) {
    await db.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS utbms_code TEXT`).catch(() => {});
    await db.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS utbms_activity TEXT`).catch(() => {});
  }
  // Jurisdiction drives which rule set computes this matter's deadlines.
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS jurisdiction TEXT`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS service_method TEXT`).catch(() => {});
  await db.query(`UPDATE civil_cases SET jurisdiction = 'CA' WHERE jurisdiction IS NULL`).catch(() => {});

  // The phase playbooks own their own tables; initialising them here keeps
  // the civil module a single entry point.
  try { await require("./civil-phases").initTables(); }
  catch (e) { console.warn("[civil-phases] init:", e.message); }
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
  if (!c) return { upserted: 0, unresolved: [] };

  // The rule set now comes from the matter's jurisdiction rather than being
  // hard-coded to California. A matter with no jurisdiction recorded is
  // treated as California, which is where the firm started — but the
  // unresolved list says so, so it can be corrected.
  const { jurisdiction, deadlines, unresolved } = jurisdictions.computeDeadlines(c);

  // Deadlines auto-generated for a DIFFERENT jurisdiction are stale the
  // moment the jurisdiction changes. Clear those rather than leaving a
  // California expert-exchange date on a New York matter.
  await db.query(
    `DELETE FROM civil_case_deadlines
      WHERE case_id = $1 AND auto_generated = TRUE AND status = 'pending'
        AND source_trigger <> ALL($2::text[])`,
    [caseId, deadlines.map(d => d.source_trigger)]
  ).catch(() => {});

  let n = 0;
  for (const d of deadlines) {
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
        caseId, d.due_date, d.description, d.ccp_rule || null,
        d.priority || "medium", d.source_trigger,
        d.reminder_days_before != null ? d.reminder_days_before : 3,
        c.lead_attorney_id || null, c.case_manager_id || null,
      ]
    );
    n++;
  }
  return { upserted: n, jurisdiction, unresolved };
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
          billable_hours, billable_rate,
          attorney_id, paralegal_id, document_ids, created_by } = data;

  // Build 38: same rate resolution as logEvent, so phone and email time
  // lands in the matter budget instead of silently billing at $0.
  const bh = billable_hours ? Number(billable_hours) : null;
  let br = billable_rate != null && billable_rate !== "" ? Number(billable_rate) : null;
  if (!Number.isFinite(br)) br = null;
  if (br == null && bh != null) {
    try {
      const billing = require("./civil-billing");
      br = await billing.resolveRate(attorney_id || paralegal_id || null, caseId);
    } catch (e) {
      console.warn("[civil-litigation] comm rate resolution failed:", e.message);
    }
  }
  if (!Number.isFinite(br)) br = null;
  const ba = bh != null && br != null ? Number((bh * br).toFixed(2)) : null;

  const r = await db.query(
    `INSERT INTO civil_case_communications
       (case_id, kind, direction, channel, subject, body,
        contact_name, contact_email, contact_phone,
        billable_hours, billable_rate, billable_amount,
        attorney_id, paralegal_id, document_ids, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      caseId, kind || null, direction || null, channel || null,
      subject || null, body || null,
      contact_name || null, contact_email || null, contact_phone || null,
      bh, br, ba,
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
    // Same three sources as civil-billing.getBillingSummary, so the web
    // admin case page and the app's Financials tab can't disagree about
    // what a matter has billed.
    db.query(
      `SELECT COALESCE(SUM(billable_hours), 0)::float AS total_hours,
              COALESCE(SUM(billable_amount), 0)::float AS total_amount
       FROM (
         SELECT billable_hours, billable_amount FROM civil_case_events        WHERE case_id = $1
         UNION ALL
         SELECT billable_hours, billable_amount FROM civil_case_communications WHERE case_id = $1
         UNION ALL
         SELECT billable_hours, billable_amount FROM civil_depositions         WHERE case_id = $1
       ) all_time`,
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


// ═══════════════════════════════════════════════════════════
//  STAGE WORKSPACES
//  ────────────────────────────────────────────────────────
//  The nav used to point every stage link at the same kanban board with a
//  ?stage= filter, so "Discovery" and "Trial Prep" were the same screen with
//  fewer cards. A litigator does different work at each phase, and the thing
//  that matters is different too: in intake it is the SOL, in pleadings it is
//  service and the responsive pleading, in trial prep it is the cutoffs
//  counting backwards from the trial date.
//
//  STAGE_PLAYBOOK says, per stage: which date drives it, which of the 15 CCP
//  rules belong to it, and what to warn about. getStageWorkspace() assembles
//  that into one payload both the web workspace and the app can render.
// ═══════════════════════════════════════════════════════════

const STAGE_PLAYBOOK = {
  intake: {
    headline: "Assess the matter, clear conflicts, and sign the client.",
    focusField: "statute_of_limitations",
    focusLabel: "SOL",
    rules: ["sol"],
    caution: "The statute of limitations is jurisdictional and cannot be extended. An intake that sits is the one that becomes a malpractice claim.",
    verbs: ["Record the SOL", "Run the conflict check", "Send the engagement letter", "Advance to Pre-Filing"],
  },
  pre_filing: {
    headline: "Demand, toll, and draft. Only filing stops the clock.",
    focusField: "statute_of_limitations",
    focusLabel: "SOL",
    rules: ["sol"],
    caution: "A tolling agreement must be signed before the SOL runs — it cannot revive a lapsed claim.",
    verbs: ["Send the demand letter", "Paper a tolling agreement", "Draft the complaint", "File and advance to Pleadings"],
  },
  pleadings: {
    headline: "Get it filed, get it served, get the pleadings settled.",
    focusField: "filed_date",
    focusLabel: "Filed",
    rules: ["proof_of_service", "answer_due", "cmc_statement", "cmc_meet_and_confer"],
    caution: "Service must be accomplished within 60 days of filing (CRC 3.110(b)) and the action dismissed if not served within 3 years (CCP § 583.210).",
    verbs: ["File proof of service", "Answer or demur", "File the CMC statement", "Meet and confer re: CMC"],
  },
  discovery: {
    headline: "Propound, respond, and protect the motion-to-compel window.",
    focusField: "trial_date",
    focusLabel: "Trial",
    rules: ["discovery_opens_plaintiff", "deposition_notices_plaintiff", "discovery_cutoff", "discovery_motions_cutoff"],
    caution: "The 45-day motion-to-compel deadline is a hard one — blow it and the objections stand, however meritless.",
    verbs: ["Propound a set", "Record responses received", "Meet and confer", "Notice a deposition"],
    withDiscovery: true,
  },
  motions: {
    headline: "Law and motion — summary judgment, demurrers, and the notice math.",
    focusField: "trial_date",
    focusLabel: "Trial",
    rules: ["msj_filing_deadline", "msj_hearing_deadline", "discovery_motions_cutoff"],
    caution: "An MSJ needs 75 days' notice and must be HEARD at least 30 days before trial (CCP § 437c) — the filing date is driven backwards from the trial date, not from today.",
    verbs: ["Log a motion filed", "Calendar the hearing", "Track opposition and reply"],
  },
  trial_prep: {
    headline: "Everything counts backwards from the trial date.",
    focusField: "trial_date",
    focusLabel: "Trial",
    rules: ["expert_witness_exchange", "discovery_cutoff", "discovery_motions_cutoff",
            "motions_in_limine", "trial_brief", "section_998_offer_cutoff"],
    caution: "Expert exchange is 50 days out and discovery closes 30 days out. A matter here without a trial date has no deadlines at all — that is the dangerous state.",
    verbs: ["Exchange expert lists", "File motions in limine", "Serve a 998 offer", "Prepare the trial brief"],
  },
  trial: {
    headline: "In trial. Log what happens, day by day.",
    focusField: "trial_date",
    focusLabel: "Trial",
    rules: [],
    caution: "Log rulings and admissions as they happen — reconstructing them afterwards from memory is how appellate issues get lost.",
    verbs: ["Log a hearing", "Log an order", "Record the verdict"],
  },
  post_trial: {
    headline: "Judgment, post-trial motions, and the appeal clock.",
    focusField: "trial_date",
    focusLabel: "Trial ended",
    rules: [],
    caution: "New trial and JNOV motions run 15 days from the notice of entry of judgment; the notice of appeal runs 60 days (CRC 8.104). Neither is auto-generated — add them by hand the day judgment is entered.",
    verbs: ["Add the post-trial motion deadline", "Add the appeal deadline", "Record the judgment"],
  },
  closed: {
    headline: "Closed matters. Bill it out and archive the file.",
    focusField: "updated_at",
    focusLabel: "Last touched",
    rules: [],
    caution: "Archive the Dropbox mirror once the matter is done — it freezes the file list and stops the hourly sync from churning on dead matters.",
    verbs: ["Final invoice", "Archive the case file", "Reopen if needed"],
  },
};

function daysFromToday(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

// Warnings a litigator would want raised without having to open the matter.
function stageAlerts(stageKey, c, deadlines, extra) {
  const out = [];
  const sol = daysFromToday(c.statute_of_limitations);
  const trial = daysFromToday(c.trial_date);
  const filed = daysFromToday(c.filed_date);

  if (stageKey === "intake" || stageKey === "pre_filing") {
    if (!c.statute_of_limitations) out.push({ level: "warn", text: "No statute of limitations recorded" });
    else if (sol !== null && sol < 0) out.push({ level: "danger", text: `SOL expired ${Math.abs(sol)} days ago` });
    else if (sol !== null && sol <= 90) out.push({ level: "danger", text: `SOL in ${sol} days` });
    else if (sol !== null && sol <= 180) out.push({ level: "warn", text: `SOL in ${sol} days` });
    if (!c.retainer_amount && stageKey === "intake") out.push({ level: "info", text: "No retainer recorded" });
  }

  if (stageKey === "pleadings") {
    if (!c.filed_date) out.push({ level: "warn", text: "Not filed yet — should this be in Pre-Filing?" });
    if (c.filed_date && !c.service_date) {
      const since = filed === null ? null : Math.abs(filed);
      if (since !== null && since > 60) out.push({ level: "danger", text: `Filed ${since} days ago, still no service date` });
      else if (since !== null && since > 45) out.push({ level: "warn", text: `Filed ${since} days ago — 60-day service deadline approaching` });
    }
    if (c.our_role === "defendant" && c.service_date && !c.answered_date) {
      out.push({ level: "warn", text: "Served but no responsive pleading recorded" });
    }
  }

  if (stageKey === "discovery" && extra) {
    if (extra.overdue) out.push({ level: "danger", text: `${extra.overdue} overdue response${extra.overdue === 1 ? "" : "s"}` });
    if (extra.mtc_soon) out.push({ level: "danger", text: `${extra.mtc_soon} motion-to-compel deadline${extra.mtc_soon === 1 ? "" : "s"} within 30 days` });
    if (!extra.total) out.push({ level: "info", text: "No discovery propounded or received yet" });
  }

  if (stageKey === "motions" || stageKey === "trial_prep") {
    if (!c.trial_date) out.push({ level: "danger", text: "No trial date — none of this stage's deadlines can be computed" });
  }

  if (stageKey === "trial_prep" && trial !== null) {
    if (trial < 0) out.push({ level: "warn", text: `Trial date passed ${Math.abs(trial)} days ago` });
    else if (trial <= 30) out.push({ level: "danger", text: `Trial in ${trial} days — discovery is closed` });
    else if (trial <= 50) out.push({ level: "warn", text: `Trial in ${trial} days — expert exchange is due` });
  }

  if (stageKey === "post_trial" && !deadlines.length) {
    out.push({ level: "warn", text: "No post-trial deadlines — add the 15-day motion and 60-day appeal dates by hand" });
  }

  if (stageKey === "closed" && !c.files_archived_at && c.dropbox_path) {
    out.push({ level: "info", text: "Case file not archived — sync is still running on a closed matter" });
  }

  const overdue = deadlines.filter(d => daysFromToday(d.due_date) < 0);
  if (overdue.length) out.push({ level: "danger", text: `${overdue.length} deadline${overdue.length === 1 ? "" : "s"} past due` });

  return out;
}

async function getStageWorkspace(stageKey) {
  const stage = STAGES.find(s => s.key === stageKey);
  if (!stage) throw new Error("Unknown stage: " + stageKey);
  const playbook = STAGE_PLAYBOOK[stageKey] || { rules: [], verbs: [] };

  const cases = await listCases({ stage: stageKey, status: "active" });
  const ids = cases.map(c => c.id);

  // One query for every pending deadline in the stage, not one per case.
  let deadlinesByCase = {};
  if (ids.length) {
    const r = await db.query(
      `SELECT * FROM civil_case_deadlines
        WHERE case_id = ANY($1::int[]) AND status = 'pending'
        ORDER BY due_date ASC`,
      [ids]
    );
    for (const d of r.rows) (deadlinesByCase[d.case_id] = deadlinesByCase[d.case_id] || []).push(d);
  }

  // Discovery counts, but only for the stage that shows them, and never fatal:
  // civil-discovery is an optional module like the rest.
  let discoveryByCase = {};
  if (playbook.withDiscovery && ids.length) {
    try {
      const r = await db.query(
        `SELECT case_id,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (
                  WHERE response_due_date < CURRENT_DATE
                    AND status IN ('pending','deficient')
                )::int AS overdue,
                COUNT(*) FILTER (
                  WHERE mtc_deadline IS NOT NULL
                    AND mtc_filed_date IS NULL
                    AND mtc_deadline <= CURRENT_DATE + INTERVAL '30 days'
                )::int AS mtc_soon
           FROM civil_discovery
          WHERE case_id = ANY($1::int[])
          GROUP BY case_id`,
        [ids]
      );
      for (const row of r.rows) discoveryByCase[row.case_id] = row;
    } catch (e) { /* module not installed — the stage still renders */ }
  }

  const enriched = cases.map(c => {
    const all = deadlinesByCase[c.id] || [];
    // A deadline belongs to this stage when the MATTER'S OWN jurisdiction
    // says its rule does. A hard-coded list of California rule keys would
    // have hidden every federal and out-of-state deadline. Manually added
    // deadlines carry no source_trigger and belong to whoever is looking.
    const mine = all.filter(d =>
      !d.source_trigger ||
      jurisdictions.stageForRule(c.jurisdiction, d.source_trigger) === stageKey);
    const extra = discoveryByCase[c.id] || null;
    const focusDate = playbook.focusField ? c[playbook.focusField] : null;
    return {
      ...c,
      deadlines: mine,
      deadline_count_all: all.length,
      discovery: extra,
      focus: playbook.focusField
        ? { label: playbook.focusLabel, field: playbook.focusField, date: focusDate, days: daysFromToday(focusDate) }
        : null,
      alerts: stageAlerts(stageKey, c, mine, extra),
    };
  });

  // Most exposed first: anything with a danger alert, then by how soon the
  // stage's focus date lands, then by the soonest deadline.
  const score = x => {
    if (x.alerts.some(a => a.level === "danger")) return 0;
    if (x.alerts.some(a => a.level === "warn")) return 1;
    return 2;
  };
  enriched.sort((a, b) => {
    const sa = score(a), sb = score(b);
    if (sa !== sb) return sa - sb;
    const da = a.focus && a.focus.days !== null ? a.focus.days : Infinity;
    const db_ = b.focus && b.focus.days !== null ? b.focus.days : Infinity;
    if (da !== db_) return da - db_;
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });

  // ── Phase playbook state ──
  // The task template, the gate criteria and the deadlines this jurisdiction
  // cannot compute, per matter. All of it is best-effort: a phase module that
  // fails to load must leave the stage workspace usable.
  let phases = null;
  try { phases = require("./civil-phases"); } catch (e) { /* optional */ }

  if (phases && ids.length) {
    const [taskRows, gateRows] = await Promise.all([
      db.query(
        `SELECT case_id, task_key, label, role, utbms_code, due_date, status, critical, sort_order,
                assignee_name, notes
           FROM civil_phase_tasks
          WHERE case_id = ANY($1::int[]) AND phase = $2
          ORDER BY sort_order, id`,
        [ids, stageKey]
      ).catch(() => ({ rows: [] })),
      db.query(
        `SELECT case_id, gate_key, satisfied FROM civil_phase_gates
          WHERE case_id = ANY($1::int[]) AND phase = $2`,
        [ids, stageKey]
      ).catch(() => ({ rows: [] })),
    ]);

    const tasksByCase = {};
    for (const t of taskRows.rows) (tasksByCase[t.case_id] = tasksByCase[t.case_id] || []).push(t);
    const attestedByCase = {};
    for (const gRow of gateRows.rows) {
      (attestedByCase[gRow.case_id] = attestedByCase[gRow.case_id] || new Set());
      if (gRow.satisfied) attestedByCase[gRow.case_id].add(gRow.gate_key);
    }

    const spec = phases.PHASES[stageKey];
    for (const x of enriched) {
      const list = tasksByCase[x.id] || [];
      const done = list.filter(t => t.status === "done").length;
      x.tasks = list;
      x.task_progress = {
        total: list.length, done,
        pct: list.length ? Math.round((done / list.length) * 100) : 0,
        overdue: list.filter(t => t.status !== "done" && t.due_date && new Date(t.due_date) < new Date()).length,
        critical_open: list.filter(t => t.status !== "done" && t.critical).length,
      };
      if (!list.length) {
        x.alerts.push({ level: "info", text: "Phase checklist not started — apply the template" });
      } else if (x.task_progress.critical_open) {
        x.alerts.push({
          level: "warn",
          text: `${x.task_progress.critical_open} critical task${x.task_progress.critical_open === 1 ? "" : "s"} still open`,
        });
      }

      // Gates, evaluated from the same data the dedicated endpoint uses so
      // the board and the matter page cannot disagree.
      if (spec) {
        const doneKeys = new Set(list.filter(t => t.status === "done").map(t => t.task_key));
        const attested = attestedByCase[x.id] || new Set();
        const gates = spec.gates.map(gt => {
          let ok = false;
          if (gt.task) ok = doneKeys.has(gt.task);
          else if (gt.field) ok = !!x[gt.field];
          if (!ok && attested.has(gt.key)) ok = true;
          return { key: gt.key, label: gt.label, ok };
        });
        x.gates = gates;
        x.gates_open = gates.filter(gt => !gt.ok).length;
        x.gate_ready = x.gates_open === 0;
      }

      // Deadlines this jurisdiction cannot compute for this matter.
      try {
        const { unresolved } = jurisdictions.computeDeadlines(x);
        x.unresolved_deadlines = (unresolved || []).filter(u => u.stage === stageKey);
        if (x.unresolved_deadlines.length) {
          x.alerts.push({
            level: "warn",
            text: `${x.unresolved_deadlines.length} deadline${x.unresolved_deadlines.length === 1 ? "" : "s"} cannot be computed yet`,
          });
        }
      } catch (e) { x.unresolved_deadlines = []; }
    }
  }

  const atRisk = enriched.filter(x => x.alerts.some(a => a.level === "danger")).length;
  const atStake = enriched.reduce((sum, x) => sum + (Number(x.amount_in_controversy) || 0), 0);
  const nextDeadline = enriched
    .flatMap(x => x.deadlines.map(d => ({ ...d, case_name: x.case_name })))
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0] || null;

  return {
    stage,
    playbook: (() => {
      // The phase module is the richer source; fall back to the terse
      // STAGE_PLAYBOOK when it is unavailable.
      let ph = null;
      try { ph = require("./civil-phases").PHASES[stageKey]; } catch (e) { /* optional */ }
      return {
        headline: (ph && ph.headline) || playbook.headline || "",
        caution: (ph && ph.caution) || playbook.caution || "",
        verbs: playbook.verbs || [],
        utbms_phase: ph ? ph.utbmsPhase : null,
        folder: ph ? ph.folder : null,
        kpis: (ph && ph.kpis) || [],
        task_count: ph ? ph.tasks.length : 0,
        gate_count: ph ? ph.gates.length : 0,
      };
    })(),
    cases: enriched,
    rollup: {
      count: enriched.length,
      at_risk: atRisk,
      gate_ready: enriched.filter(x => x.gate_ready).length,
      tasks_open: enriched.reduce((n, x) => n + (x.task_progress ? x.task_progress.total - x.task_progress.done : 0), 0),
      tasks_overdue: enriched.reduce((n, x) => n + (x.task_progress ? x.task_progress.overdue : 0), 0),
      amount_at_stake: atStake,
      open_deadlines: enriched.reduce((n, x) => n + x.deadlines.length, 0),
      next_deadline: nextDeadline,
    },
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
  STAGE_PLAYBOOK, getStageWorkspace,
  addCalendarDays, subCalendarDaysBackToCourtDay, fmtDate,
};
