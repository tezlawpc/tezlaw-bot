// ============================================================
//  TEZ LAW P.C. — CIVIL DISCOVERY MODULE
//  ─────────────────────────────────────────────────────────
//  Tracks propounded and received discovery on civil cases:
//    · Interrogatories (Form + Special)
//    · Requests for Production of Documents (RFPs)
//    · Requests for Admission (RFAs)
//    · Depositions (party, third-party, PMK, expert)
//    · Subpoenas duces tecum
//    · Physical / mental examinations
//
//  Auto-calculates all California CCP deadlines:
//    · Response due:   +30 calendar days from service
//                     (+5 mail per CCP 1013(a), +2 e-serve per 1010.6(a)(3))
//    · Meet & confer:  informal attempt after deficient response
//    · Motion to Compel Further:  45 days from service of verified
//                     responses (CCP 2030.300(c), 2031.310(c),
//                     2033.290(c)) — HARD deadline, jurisdictional
//    · MTC Initial:    no time limit if no response served at all
//    · Depo notice:    10 days min (CCP 2025.270(a))
//    · Discovery cutoff:  30 days before trial (CCP 2024.020(a))
//    · MTC hearing cutoff: 15 days before trial
// ============================================================

const db = require("./db");

// ── Discovery kinds ─────────────────────────────────────────
const DISCOVERY_KINDS = [
  { key: "rogs_form",    label: "Form Interrogatories",     max: 35, ccp: "CCP § 2030.030(a)" },
  { key: "rogs_special", label: "Special Interrogatories",   max: 35, ccp: "CCP § 2030.030(a)(2)" },
  { key: "rfps",         label: "Requests for Production",   max: 35, ccp: "CCP § 2031.030" },
  { key: "rfas",         label: "Requests for Admission",    max: 35, ccp: "CCP § 2033.030(a)" },
  { key: "deposition",   label: "Deposition",                max: null, ccp: "CCP § 2025.270(a)" },
  { key: "subpoena",     label: "Subpoena Duces Tecum",     max: null, ccp: "CCP § 2020.410" },
  { key: "phys_exam",    label: "Physical Examination",     max: null, ccp: "CCP § 2032.220" },
  { key: "mental_exam",  label: "Mental Examination",       max: null, ccp: "CCP § 2032.310" },
];

const DIRECTIONS  = ["propounded", "received"];
const SERVE_METHODS = ["personal", "mail", "email", "efile", "overnight"];
const STATUSES = ["pending", "responded", "deficient", "in_meet_confer", "motion_filed", "resolved", "withdrawn"];

// ═══════════════════════════════════════════════════════════
//  SCHEMA
// ═══════════════════════════════════════════════════════════

async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_discovery (
      id                              SERIAL PRIMARY KEY,
      case_id                         INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      kind                            TEXT NOT NULL,
      direction                       TEXT NOT NULL,
      set_number                      INTEGER DEFAULT 1,
      title                           TEXT,
      to_party                        TEXT,
      served_date                     DATE,
      served_method                   TEXT,
      response_due_date               DATE,
      responses_served_date           DATE,
      responses_verified              BOOLEAN DEFAULT FALSE,
      deficient                       BOOLEAN DEFAULT FALSE,
      deficiency_notes                TEXT,
      meet_confer_letter_sent_date    DATE,
      meet_confer_response_date       DATE,
      meet_confer_call_date           DATE,
      mtc_deadline                    DATE,
      mtc_filed_date                  DATE,
      mtc_hearing_date                DATE,
      mtc_outcome                     TEXT,
      status                          TEXT DEFAULT 'pending',
      total_requests                  INTEGER,
      notes                           TEXT,
      document_ids                    INTEGER[],
      created_by                      TEXT,
      attorney_id                     INTEGER,
      paralegal_id                    INTEGER,
      created_at                      TIMESTAMPTZ DEFAULT NOW(),
      updated_at                      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_discovery_case ON civil_discovery (case_id, kind, direction)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_discovery_due ON civil_discovery (response_due_date) WHERE status IN ('pending', 'deficient')`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_discovery_mtc ON civil_discovery (mtc_deadline) WHERE mtc_deadline IS NOT NULL AND mtc_filed_date IS NULL`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_discovery_items (
      id                   SERIAL PRIMARY KEY,
      discovery_id         INTEGER REFERENCES civil_discovery(id) ON DELETE CASCADE,
      item_number          INTEGER NOT NULL,
      request_text         TEXT NOT NULL,
      response_text        TEXT,
      response_type        TEXT,
      objection_grounds    JSONB,
      status               TEXT DEFAULT 'pending',
      disputed             BOOLEAN DEFAULT FALSE,
      dispute_notes        TEXT,
      notes                TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_discovery_items_disc ON civil_discovery_items (discovery_id, item_number)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_discovery_items_disputed ON civil_discovery_items (discovery_id) WHERE disputed = TRUE`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_depositions (
      id                       SERIAL PRIMARY KEY,
      case_id                  INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      deponent_name            TEXT NOT NULL,
      deponent_role            TEXT,
      deponent_party           TEXT,
      taking_party             TEXT,
      notice_served_date       DATE,
      scheduled_date           DATE,
      scheduled_time           TEXT,
      location                 TEXT,
      remote_platform          TEXT,
      court_reporter           TEXT,
      videographer             TEXT,
      interpreter_language     TEXT,
      pmk_topics               JSONB,
      documents_requested      TEXT,
      status                   TEXT DEFAULT 'noticed',
      transcript_url           TEXT,
      transcript_summary       TEXT,
      key_admissions           TEXT,
      billable_hours           NUMERIC,
      billable_amount          NUMERIC,
      attorney_id              INTEGER,
      paralegal_id             INTEGER,
      notes                    TEXT,
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_depos_case ON civil_depositions (case_id, scheduled_date)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_depos_upcoming ON civil_depositions (scheduled_date) WHERE status IN ('noticed','confirmed')`);
}

// ═══════════════════════════════════════════════════════════
//  DATE HELPERS (mirror civil-litigation.js's court-day math)
// ═══════════════════════════════════════════════════════════

// Reuse the same holiday set from civil-litigation module for consistency.
// We keep a local copy so this module is import-independent.
const COURT_HOLIDAYS = new Set([
  "2026-01-01","2026-01-19","2026-02-16","2026-05-25","2026-07-03","2026-09-07","2026-11-11","2026-11-26","2026-11-27","2026-12-24","2026-12-25","2026-12-31",
  "2027-01-01","2027-01-18","2027-02-15","2027-05-31","2027-07-05","2027-09-06","2027-11-11","2027-11-25","2027-11-26","2027-12-23","2027-12-24","2027-12-31",
  "2028-01-03","2028-01-17","2028-02-21","2028-05-29","2028-07-04","2028-09-04","2028-11-10","2028-11-23","2028-11-24","2028-12-25","2028-12-26",
  "2029-01-01","2029-01-15","2029-02-19","2029-05-28","2029-07-04","2029-09-03","2029-11-12","2029-11-22","2029-11-23","2029-12-24","2029-12-25","2029-12-31",
  "2030-01-01","2030-01-21","2030-02-18","2030-05-27","2030-07-04","2030-09-02","2030-11-11","2030-11-28","2030-11-29","2030-12-24","2030-12-25",
]);

function toDate(v) { if (!v) return null; if (v instanceof Date) return v; const d = new Date(v); return isNaN(d) ? null : d; }
function fmtDate(d) {
  if (!d) return null;
  const dt = toDate(d);
  if (!dt) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
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

// ═══════════════════════════════════════════════════════════
//  RESPONSE DUE DATE CALCULATOR
//  30 days baseline + method-based extensions per CCP 1013 / 1010.6
// ═══════════════════════════════════════════════════════════

function calcResponseDueDate(servedDate, method) {
  if (!servedDate) return null;
  let extra = 0;
  switch (method) {
    case "mail":      extra = 5; break;   // CCP 1013(a)
    case "email":     extra = 2; break;   // CCP 1010.6(a)(3)(B)
    case "efile":     extra = 2; break;
    case "overnight": extra = 2; break;   // CCP 1013(c)
    case "personal":
    default:          extra = 0; break;
  }
  return addCalendarDays(servedDate, 30 + extra);
}

// MTC deadline = 45 days from service of verified responses
// (CCP 2030.300(c) for rogs, 2031.310(c) for RFPs, 2033.290(c) for RFAs)
// PLUS the service-method extension for the responses themselves.
function calcMtcDeadline(responsesServedDate, method) {
  if (!responsesServedDate) return null;
  let extra = 0;
  switch (method) {
    case "mail":      extra = 5; break;
    case "email":     extra = 2; break;
    case "efile":     extra = 2; break;
    case "overnight": extra = 2; break;
    default:          extra = 0;
  }
  return addCalendarDays(responsesServedDate, 45 + extra);
}

// ═══════════════════════════════════════════════════════════
//  CRUD — DISCOVERY SETS
// ═══════════════════════════════════════════════════════════

async function createDiscovery(caseId, data) {
  const {
    kind, direction, set_number, title, to_party,
    served_date, served_method,
    total_requests, notes, attorney_id, paralegal_id, created_by,
  } = data;
  if (!kind || !direction) throw new Error("kind and direction are required");
  const response_due_date = calcResponseDueDate(served_date, served_method);
  const r = await db.query(
    `INSERT INTO civil_discovery
       (case_id, kind, direction, set_number, title, to_party,
        served_date, served_method, response_due_date,
        total_requests, notes, attorney_id, paralegal_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      caseId, kind, direction, set_number || 1, title || null, to_party || null,
      served_date || null, served_method || null, response_due_date,
      total_requests || null, notes || null,
      attorney_id || null, paralegal_id || null, created_by || null,
    ]
  );
  return r.rows[0];
}

async function listDiscovery(caseId, filter = {}) {
  const where = ["case_id = $1"];
  const vals = [caseId];
  let i = 2;
  if (filter.kind)      { where.push(`kind = $${i++}`);      vals.push(filter.kind); }
  if (filter.direction) { where.push(`direction = $${i++}`); vals.push(filter.direction); }
  if (filter.status)    { where.push(`status = $${i++}`);    vals.push(filter.status); }
  const r = await db.query(
    `SELECT * FROM civil_discovery WHERE ${where.join(" AND ")}
     ORDER BY served_date DESC NULLS LAST, created_at DESC LIMIT 200`,
    vals
  );
  return r.rows;
}

async function getDiscovery(id) {
  const r = await db.query(`SELECT * FROM civil_discovery WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// Record that responses were served. Recomputes MTC deadline.
async function markResponsesReceived(discoveryId, data) {
  const {
    responses_served_date, method, responses_verified,
    deficient, deficiency_notes,
  } = data;
  const mtc_deadline = calcMtcDeadline(responses_served_date, method);
  const status = deficient ? "deficient" : "responded";
  const r = await db.query(
    `UPDATE civil_discovery SET
       responses_served_date = $1,
       responses_verified    = $2,
       mtc_deadline          = $3,
       deficient             = $4,
       deficiency_notes      = $5,
       status                = $6,
       updated_at            = NOW()
     WHERE id = $7 RETURNING *`,
    [
      responses_served_date || null,
      !!responses_verified,
      mtc_deadline,
      !!deficient,
      deficiency_notes || null,
      status,
      discoveryId,
    ]
  );
  return r.rows[0];
}

// Log meet-and-confer attempts and eventual MTC filing.
async function updateMeetConfer(discoveryId, data) {
  const {
    meet_confer_letter_sent_date, meet_confer_response_date, meet_confer_call_date,
    mtc_filed_date, mtc_hearing_date, mtc_outcome,
  } = data;
  const sets = [];
  const vals = [];
  let i = 1;
  const map = { meet_confer_letter_sent_date, meet_confer_response_date, meet_confer_call_date,
                mtc_filed_date, mtc_hearing_date, mtc_outcome };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined) { sets.push(`${k} = $${i++}`); vals.push(v || null); }
  }
  if (mtc_filed_date !== undefined) { sets.push(`status = $${i++}`); vals.push("motion_filed"); }
  if (mtc_outcome && (mtc_outcome === "granted" || mtc_outcome === "denied" || mtc_outcome === "settled")) {
    sets.push(`status = $${i++}`); vals.push("resolved");
  }
  if (!sets.length) throw new Error("no fields provided");
  sets.push("updated_at = NOW()");
  vals.push(discoveryId);
  const r = await db.query(
    `UPDATE civil_discovery SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function updateDiscovery(id, data) {
  const allowed = new Set([
    "kind","direction","set_number","title","to_party",
    "served_date","served_method","response_due_date",
    "total_requests","status","notes","attorney_id","paralegal_id","document_ids",
  ]);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(data)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(v === "" ? null : v);
  }
  if (!sets.length) throw new Error("no editable fields provided");
  // If served_date or served_method changed, recompute response_due_date
  if ("served_date" in data || "served_method" in data) {
    const cur = await getDiscovery(id);
    const sd = "served_date" in data ? data.served_date : cur.served_date;
    const sm = "served_method" in data ? data.served_method : cur.served_method;
    sets.push(`response_due_date = $${i++}`);
    vals.push(calcResponseDueDate(sd, sm));
  }
  sets.push("updated_at = NOW()");
  vals.push(id);
  const r = await db.query(
    `UPDATE civil_discovery SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function deleteDiscovery(id) {
  const r = await db.query(`DELETE FROM civil_discovery WHERE id = $1 RETURNING id`, [id]);
  return r.rows[0] || null;
}

// ═══════════════════════════════════════════════════════════
//  DISCOVERY ITEMS (individual interrogatories / RFPs / RFAs)
// ═══════════════════════════════════════════════════════════

async function addItems(discoveryId, items) {
  if (!Array.isArray(items) || !items.length) throw new Error("items array required");
  const rows = [];
  for (const item of items) {
    const r = await db.query(
      `INSERT INTO civil_discovery_items
         (discovery_id, item_number, request_text, response_text,
          response_type, objection_grounds, status, disputed, dispute_notes, notes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       RETURNING *`,
      [
        discoveryId, item.item_number, item.request_text || "",
        item.response_text || null,
        item.response_type || null,
        JSON.stringify(item.objection_grounds || []),
        item.status || "pending",
        !!item.disputed, item.dispute_notes || null, item.notes || null,
      ]
    );
    rows.push(r.rows[0]);
  }
  // Update total_requests on the parent set if not already set
  await db.query(
    `UPDATE civil_discovery SET total_requests = GREATEST(COALESCE(total_requests, 0),
       (SELECT COUNT(*)::int FROM civil_discovery_items WHERE discovery_id = $1)),
       updated_at = NOW() WHERE id = $1`,
    [discoveryId]
  );
  return rows;
}

async function listItems(discoveryId) {
  const r = await db.query(
    `SELECT * FROM civil_discovery_items WHERE discovery_id = $1
     ORDER BY item_number ASC`,
    [discoveryId]
  );
  return r.rows;
}

async function updateItem(itemId, data) {
  const allowed = new Set([
    "request_text","response_text","response_type","objection_grounds",
    "status","disputed","dispute_notes","notes","item_number",
  ]);
  const jsonbFields = new Set(["objection_grounds"]);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(data)) {
    if (!allowed.has(k)) continue;
    if (jsonbFields.has(k)) {
      sets.push(`${k} = $${i++}::jsonb`);
      vals.push(JSON.stringify(v || []));
    } else {
      sets.push(`${k} = $${i++}`);
      vals.push(v === "" ? null : v);
    }
  }
  if (!sets.length) throw new Error("no editable fields");
  sets.push("updated_at = NOW()");
  vals.push(itemId);
  const r = await db.query(
    `UPDATE civil_discovery_items SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function deleteItem(itemId) {
  const r = await db.query(`DELETE FROM civil_discovery_items WHERE id = $1 RETURNING id`, [itemId]);
  return r.rows[0] || null;
}

// ═══════════════════════════════════════════════════════════
//  DEPOSITIONS
// ═══════════════════════════════════════════════════════════

async function createDeposition(caseId, data) {
  const {
    deponent_name, deponent_role, deponent_party, taking_party,
    notice_served_date, scheduled_date, scheduled_time, location, remote_platform,
    court_reporter, videographer, interpreter_language,
    pmk_topics, documents_requested, notes, attorney_id, paralegal_id,
  } = data;
  if (!deponent_name) throw new Error("deponent_name is required");
  const r = await db.query(
    `INSERT INTO civil_depositions
       (case_id, deponent_name, deponent_role, deponent_party, taking_party,
        notice_served_date, scheduled_date, scheduled_time, location, remote_platform,
        court_reporter, videographer, interpreter_language,
        pmk_topics, documents_requested, notes, attorney_id, paralegal_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18)
     RETURNING *`,
    [
      caseId, deponent_name, deponent_role || null, deponent_party || null, taking_party || null,
      notice_served_date || null, scheduled_date || null, scheduled_time || null,
      location || null, remote_platform || null,
      court_reporter || null, videographer || null, interpreter_language || null,
      JSON.stringify(pmk_topics || []),
      documents_requested || null, notes || null,
      attorney_id || null, paralegal_id || null,
    ]
  );
  return r.rows[0];
}

async function listDepositions(caseId) {
  const r = await db.query(
    `SELECT * FROM civil_depositions WHERE case_id = $1
     ORDER BY COALESCE(scheduled_date, created_at::date) DESC LIMIT 200`,
    [caseId]
  );
  return r.rows;
}

async function updateDeposition(id, data) {
  const allowed = new Set([
    "deponent_name","deponent_role","deponent_party","taking_party",
    "notice_served_date","scheduled_date","scheduled_time","location","remote_platform",
    "court_reporter","videographer","interpreter_language",
    "pmk_topics","documents_requested",
    "status","transcript_url","transcript_summary","key_admissions",
    "billable_hours","billable_amount","attorney_id","paralegal_id","notes",
  ]);
  const jsonbFields = new Set(["pmk_topics"]);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(data)) {
    if (!allowed.has(k)) continue;
    if (jsonbFields.has(k)) {
      sets.push(`${k} = $${i++}::jsonb`);
      vals.push(JSON.stringify(v || []));
    } else {
      sets.push(`${k} = $${i++}`);
      vals.push(v === "" ? null : v);
    }
  }
  if (!sets.length) throw new Error("no editable fields");
  sets.push("updated_at = NOW()");
  vals.push(id);
  const r = await db.query(
    `UPDATE civil_depositions SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return r.rows[0];
}

// ═══════════════════════════════════════════════════════════
//  SUMMARY / DASHBOARD
// ═══════════════════════════════════════════════════════════

// Discovery summary for a case: counts by kind × direction, overdue count,
// upcoming MTC deadlines, upcoming depositions.
async function getDiscoverySummary(caseId) {
  const [byKindR, overdueR, upcomingMtcR, upcomingDepoR] = await Promise.all([
    db.query(
      `SELECT kind, direction, status, COUNT(*)::int AS n
       FROM civil_discovery WHERE case_id = $1
       GROUP BY kind, direction, status`,
      [caseId]
    ),
    db.query(
      `SELECT * FROM civil_discovery
       WHERE case_id = $1 AND response_due_date < CURRENT_DATE
         AND status IN ('pending', 'deficient')
       ORDER BY response_due_date ASC LIMIT 20`,
      [caseId]
    ),
    db.query(
      `SELECT * FROM civil_discovery
       WHERE case_id = $1 AND mtc_deadline IS NOT NULL
         AND mtc_deadline <= CURRENT_DATE + INTERVAL '30 days'
         AND mtc_filed_date IS NULL
       ORDER BY mtc_deadline ASC LIMIT 10`,
      [caseId]
    ),
    db.query(
      `SELECT * FROM civil_depositions
       WHERE case_id = $1 AND scheduled_date IS NOT NULL
         AND scheduled_date >= CURRENT_DATE
         AND status IN ('noticed', 'confirmed')
       ORDER BY scheduled_date ASC LIMIT 10`,
      [caseId]
    ),
  ]);
  return {
    counts_by_kind: byKindR.rows,
    overdue: overdueR.rows,
    upcoming_mtc: upcomingMtcR.rows,
    upcoming_depositions: upcomingDepoR.rows,
  };
}

module.exports = {
  initTables,
  DISCOVERY_KINDS, DIRECTIONS, SERVE_METHODS, STATUSES,
  createDiscovery, listDiscovery, getDiscovery, updateDiscovery, deleteDiscovery,
  markResponsesReceived, updateMeetConfer,
  addItems, listItems, updateItem, deleteItem,
  createDeposition, listDepositions, updateDeposition,
  getDiscoverySummary,
  calcResponseDueDate, calcMtcDeadline, addCalendarDays, fmtDate,
};
