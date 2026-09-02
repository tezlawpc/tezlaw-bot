// ============================================================
//  TEZ LAW P.C. — FEDERAL MATTERS & TRADEMARKS
//  ─────────────────────────────────────────────────────────
//  Unified tracking page for:
//   • Trademark applications (USPTO)
//   • TM oppositions / cancellations (TTAB)
//   • Trademark renewals
//   • Federal district court litigation
//   • Circuit court appeals (9th Cir, other circuits)
//   • Habeas corpus petitions
//   • Writs of mandamus
//   • Federal immigration appeals
//
//  Every matter tracks its next deadline so nothing falls through
//  the cracks. Deadlines auto-create task reminders.
// ============================================================

const db = require("./db");

// ─── Standard matter types (grouped) ────────────────────

const MATTER_TYPES = {
  trademarks: [
    { key: "tm_application",   label: "TM Application (USPTO)",       agency: "USPTO" },
    { key: "tm_office_action", label: "TM Office Action Response",    agency: "USPTO" },
    { key: "tm_sou",           label: "Statement of Use",             agency: "USPTO" },
    { key: "tm_renewal",       label: "TM Renewal (§8/§9)",           agency: "USPTO" },
    { key: "tm_opposition",    label: "TM Opposition (TTAB)",         agency: "TTAB"  },
    { key: "tm_cancellation",  label: "TM Cancellation (TTAB)",       agency: "TTAB"  },
    { key: "tm_appeal_ttab",   label: "TTAB Appeal",                  agency: "TTAB"  },
  ],
  federal_court: [
    { key: "fed_complaint",       label: "Federal District Court Complaint",  agency: "US District Court" },
    { key: "fed_answer",          label: "Federal Answer / Motion to Dismiss", agency: "US District Court" },
    { key: "fed_summary_judgment", label: "Federal Summary Judgment",         agency: "US District Court" },
    { key: "fed_trial",           label: "Federal Trial",                     agency: "US District Court" },
  ],
  federal_appeal: [
    { key: "circuit_appeal_bia", label: "9th Cir Petition for Review (BIA)", agency: "9th Circuit" },
    { key: "circuit_appeal",     label: "Circuit Court Appeal (general)",    agency: "US Court of Appeals" },
    { key: "supreme_court",      label: "Supreme Court Petition",            agency: "SCOTUS" },
  ],
  federal_writ: [
    { key: "habeas_corpus_2241",      label: "Habeas Corpus (§2241) — Detention",   agency: "US District Court" },
    { key: "habeas_corpus_2255",      label: "Habeas Corpus (§2255) — Post-Conv.",  agency: "US District Court" },
    { key: "writ_of_mandamus_uscis",  label: "Writ of Mandamus — USCIS Delay",       agency: "US District Court" },
    { key: "writ_of_mandamus_dos",    label: "Writ of Mandamus — DOS/Consular",      agency: "US District Court" },
    { key: "declaratory_judgment",    label: "Declaratory Judgment",                agency: "US District Court" },
  ],
};

const TYPE_LABELS = {};
const TYPE_GROUPS = {};
for (const [group, types] of Object.entries(MATTER_TYPES)) {
  for (const t of types) {
    TYPE_LABELS[t.key] = t.label;
    TYPE_GROUPS[t.key] = group;
  }
}

const STATUSES = [
  { key: "active",           label: "Active",           color: "#0061FF" },
  { key: "pending_response", label: "Pending Response", color: "#e65100" },
  { key: "briefing",         label: "Briefing",         color: "#7c4dff" },
  { key: "under_advisement", label: "Under Advisement", color: "#B79C62" },
  { key: "granted",          label: "Granted",          color: "#2e7d32" },
  { key: "denied",           label: "Denied",           color: "#c62828" },
  { key: "settled",          label: "Settled",          color: "#2e7d32" },
  { key: "abandoned",        label: "Abandoned",        color: "#999" },
  { key: "closed",           label: "Closed",           color: "#666" },
];
const STATUS_COLORS = Object.fromEntries(STATUSES.map(s => [s.key, s.color]));

// ─── Schema ─────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS federal_matters (
      id                  SERIAL PRIMARY KEY,
      matter_type         TEXT NOT NULL,        -- tm_application | habeas_corpus_2241 | etc
      matter_number       TEXT,                 -- USPTO serial #, court case #
      client_name         TEXT NOT NULL,
      client_key          TEXT,
      a_number            TEXT,                 -- for immigration-related federal cases
      agency              TEXT,                 -- USPTO, TTAB, US District Court, 9th Circuit, etc.
      -- Trademark-specific fields
      tm_mark             TEXT,                 -- the trademark itself (word mark or description)
      tm_class            TEXT,                 -- international class(es) e.g. "9, 42"
      tm_owner            TEXT,                 -- owner of the mark (may differ from client)
      -- Federal court-specific fields
      opposing_party      TEXT,
      cause_of_action     TEXT,
      -- Dates
      filing_date         DATE,
      next_deadline_date  DATE,
      next_deadline_desc  TEXT,
      last_activity_date  DATE,
      -- Status
      status              TEXT DEFAULT 'active',
      -- People / referral
      assigned_attorney   TEXT,
      referral_source     TEXT,
      -- Storage
      dropbox_folder_path TEXT,
      notes               TEXT,
      -- Meta
      created_by          INTEGER,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fed_matter_type ON federal_matters (matter_type)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fed_matter_status ON federal_matters (status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fed_matter_deadline ON federal_matters (next_deadline_date) WHERE status NOT IN ('closed', 'abandoned', 'granted', 'denied')`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fed_matter_client ON federal_matters (client_key)`);
}

// ─── CRUD ───────────────────────────────────────────────

async function createMatter(data) {
  await initTable();
  const r = await db.query(
    `INSERT INTO federal_matters
       (matter_type, matter_number, client_name, client_key, a_number, agency,
        tm_mark, tm_class, tm_owner, opposing_party, cause_of_action,
        filing_date, next_deadline_date, next_deadline_desc, last_activity_date,
        status, assigned_attorney, referral_source, dropbox_folder_path, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      data.matter_type, data.matter_number || null,
      data.client_name, data.client_key || null, data.a_number || null,
      data.agency || null,
      data.tm_mark || null, data.tm_class || null, data.tm_owner || null,
      data.opposing_party || null, data.cause_of_action || null,
      data.filing_date || null, data.next_deadline_date || null, data.next_deadline_desc || null,
      data.last_activity_date || null,
      data.status || "active",
      data.assigned_attorney || null, data.referral_source || null,
      data.dropbox_folder_path || null, data.notes || null, data.created_by || null,
    ]
  );
  return r.rows[0];
}

async function updateMatter(id, fields) {
  await initTable();
  const allowed = [
    "matter_type", "matter_number", "client_name", "client_key", "a_number", "agency",
    "tm_mark", "tm_class", "tm_owner", "opposing_party", "cause_of_action",
    "filing_date", "next_deadline_date", "next_deadline_desc", "last_activity_date",
    "status", "assigned_attorney", "referral_source", "dropbox_folder_path", "notes",
  ];
  const sets = []; const values = []; let i = 1;
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = $${i++}`);
      values.push(fields[k] === "" ? null : fields[k]);
    }
  }
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  values.push(id);
  const r = await db.query(
    `UPDATE federal_matters SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return r.rows[0];
}

async function deleteMatter(id) {
  await initTable();
  await db.query(`DELETE FROM federal_matters WHERE id = $1`, [id]);
}

async function getMatter(id) {
  await initTable();
  const r = await db.query(`SELECT * FROM federal_matters WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function listMatters({
  matter_type = null, group = null, status = null, agency = null,
  client_key = null, deadline_within_days = null, overdue_only = false,
  limit = 500,
} = {}) {
  await initTable();
  const conds = []; const params = []; let i = 1;
  if (matter_type) { conds.push(`matter_type = $${i++}`); params.push(matter_type); }
  if (group) {
    // Filter by group of types (trademarks, federal_court, federal_appeal, federal_writ)
    const groupKeys = MATTER_TYPES[group] ? MATTER_TYPES[group].map(t => t.key) : [];
    if (groupKeys.length) {
      conds.push(`matter_type = ANY($${i++})`);
      params.push(groupKeys);
    }
  }
  if (status) { conds.push(`status = $${i++}`); params.push(status); }
  if (agency) { conds.push(`agency ILIKE $${i++}`); params.push("%" + agency + "%"); }
  if (client_key) { conds.push(`client_key = $${i++}`); params.push(client_key); }
  if (overdue_only) {
    conds.push(`next_deadline_date IS NOT NULL AND next_deadline_date < CURRENT_DATE AND status NOT IN ('closed','abandoned','granted','denied','settled')`);
  } else if (deadline_within_days != null) {
    conds.push(`next_deadline_date IS NOT NULL AND next_deadline_date <= CURRENT_DATE + ($${i++} || ' days')::interval AND status NOT IN ('closed','abandoned')`);
    params.push(deadline_within_days);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(limit);
  const r = await db.query(
    `SELECT *,
       CASE WHEN next_deadline_date IS NULL THEN NULL
            ELSE (next_deadline_date - CURRENT_DATE)::integer
       END as days_until_deadline
     FROM federal_matters
     ${where}
     ORDER BY
       COALESCE(next_deadline_date, '9999-12-31') ASC,
       created_at DESC
     LIMIT $${i}`,
    params
  );
  return r.rows;
}

async function getStats() {
  await initTable();
  const r = await db.query(`
    SELECT
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE status NOT IN ('closed','abandoned','granted','denied','settled'))::int as active,
      COUNT(*) FILTER (WHERE next_deadline_date IS NOT NULL AND next_deadline_date < CURRENT_DATE AND status NOT IN ('closed','abandoned','granted','denied','settled'))::int as overdue,
      COUNT(*) FILTER (WHERE next_deadline_date = CURRENT_DATE)::int as due_today,
      COUNT(*) FILTER (WHERE next_deadline_date > CURRENT_DATE AND next_deadline_date <= CURRENT_DATE + INTERVAL '30 days')::int as due_this_month,
      COUNT(*) FILTER (WHERE matter_type LIKE 'tm_%')::int as tm_count,
      COUNT(*) FILTER (WHERE matter_type LIKE 'fed_%' OR matter_type LIKE 'circuit_%' OR matter_type LIKE 'habeas_%' OR matter_type LIKE 'writ_%' OR matter_type = 'supreme_court' OR matter_type = 'declaratory_judgment')::int as federal_count
    FROM federal_matters
  `);
  return r.rows[0] || {};
}

module.exports = {
  initTable,
  MATTER_TYPES, TYPE_LABELS, TYPE_GROUPS, STATUSES, STATUS_COLORS,
  createMatter, updateMatter, deleteMatter, getMatter, listMatters, getStats,
};
