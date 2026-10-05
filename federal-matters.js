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
  { key: "under_advisement", label: "Under Advisement", color: "#A34C00" },
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

// ─── Trademarks live in Matter Manager ──────────────────
// Trademark matters are tracked in ONE place: Matter Manager
// (/admin/matters), which has the deadline rules, the reminders and
// the daily USPTO status check. This page no longer accepts new
// trademark rows; the helpers below move the existing ones across.

const MOVED_MARK = "[Moved to Matter Manager";
const TM_DONE_STATUSES = ["closed", "abandoned", "denied", "settled"];

function isTrademarkType(matterType) {
  return TYPE_GROUPS[matterType] === "trademarks";
}

async function listTrademarksToMove() {
  await initTable();
  const keys = MATTER_TYPES.trademarks.map(t => t.key);
  const r = await db.query(
    `SELECT id, matter_type, client_name, matter_number, tm_mark, status
       FROM federal_matters
      WHERE matter_type = ANY($1)
        AND status <> ALL($2)
        AND COALESCE(notes, '') NOT LIKE '%' || $3 || '%'
      ORDER BY id ASC`,
    [keys, TM_DONE_STATUSES, MOVED_MARK]
  );
  return r.rows;
}

// Copies one trademark row into Matter Manager, carries its next
// deadline across, then closes the row here with a note. Nothing is
// deleted. Returns { matterId, deadlineCarried }.
async function moveTrademarkToMatterManager(id) {
  await initTable();
  const r = await db.query(
    `SELECT *, to_char(filing_date, 'YYYY-MM-DD') AS filing_date_s,
               to_char(next_deadline_date, 'YYYY-MM-DD') AS next_deadline_s
       FROM federal_matters WHERE id = $1`,
    [id]
  );
  const row = r.rows[0];
  if (!row) throw new Error("Matter not found");
  if (!isTrademarkType(row.matter_type)) throw new Error("Only trademark rows move to Matter Manager");
  if ((row.notes || "").includes(MOVED_MARK)) throw new Error("This row was already moved to Matter Manager");

  // Matter Manager is single-owner: every matter belongs to the 'jj' user.
  const u = await db.query(`SELECT id FROM users WHERE username = 'jj' LIMIT 1`);
  const userId = u.rows[0] && u.rows[0].id;
  if (!userId) throw new Error("Matter Manager owner account ('jj') not found");

  const isTTAB = ["tm_opposition", "tm_cancellation", "tm_appeal_ttab"].includes(row.matter_type);
  // 8 digits = serial number, 7 digits = registration number: both are checked
  // daily against the USPTO. A TTAB row's number is a PROCEEDING number, not a
  // serial number, so it is kept as the reference only and is not checked.
  const digits = String(row.matter_number || "").replace(/\D/g, "");
  const serial = !isTTAB && (digits.length === 8 || digits.length === 7) ? digits : null;
  // "—", "TBD" and the like are placeholders, not numbers. Kept out of the
  // reference field (which must be unique) and preserved in the notes instead.
  const refAlnum = String(row.matter_number || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const isPlaceholder = !refAlnum || ["tbd", "na", "none", "pending", "unknown", "tba"].includes(refAlnum);
  // Kept in the form the Matter Manager keeps a trademark's number in
  // ("SN 97123456", "RN 5320233", "TTAB 91234567"), which no court docket
  // number can equal. Anything else is carried over as it was written.
  const matterRef = isPlaceholder ? null
    : serial ? (digits.length === 8 ? "SN " : "RN ") + digits
    : (isTTAB && /^9[1-4]\d{6}$/.test(digits)) ? "TTAB " + digits
    : String(row.matter_number).substring(0, 100);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  const noteLines = [
    `[Moved from the Federal & TM page on ${today}. Type there: ${TYPE_LABELS[row.matter_type] || row.matter_type}; status there: ${row.status}.]`,
    row.opposing_party ? `Opposing party: ${row.opposing_party}` : null,
    row.assigned_attorney ? `Attorney: ${row.assigned_attorney}` : null,
    row.referral_source ? `Referral: ${row.referral_source}` : null,
    row.dropbox_folder_path ? `Dropbox folder: ${row.dropbox_folder_path}` : null,
    row.matter_number && isPlaceholder ? `Number as entered there: ${row.matter_number}` : null,
    row.next_deadline_desc && !row.next_deadline_s ? `Next step noted there (no date was set): ${row.next_deadline_desc}` : null,
    row.notes ? row.notes : null,
  ].filter(Boolean);

  // One trademark matter to a number, however the number was written on the
  // matter that is already there ("97555123", "97/555,123", "SN 97555123").
  const already = `Matter Manager already has a matter numbered ${row.matter_number}. Open that matter there; this row was left as it is.`;
  if (matterRef && await require("./matter-manager").trademarkRefTaken(userId, matterRef, 0)) throw new Error(already);

  let matterId;
  try {
    const ins = await db.query(
      `INSERT INTO matters
         (user_id, client_name, matter_ref, court, case_type, status, notes,
          opened_date, serial_number, mark, intl_class, owner_name)
       VALUES ($1, $2, $3, $4, 'Trademark', 'active', $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [userId,
       String(row.client_name || "Unknown").substring(0, 200),
       matterRef,
       isTTAB ? "TTAB" : "USPTO",
       noteLines.join("\n"),
       row.filing_date_s || null,
       serial,
       row.tm_mark ? String(row.tm_mark).substring(0, 300) : null,
       row.tm_class ? String(row.tm_class).substring(0, 40) : null,
       row.tm_owner ? String(row.tm_owner).substring(0, 200) : null]
    );
    matterId = ins.rows[0].id;
  } catch (err) {
    if (err.code === "23505") {
      throw new Error(already);
    }
    throw err;
  }

  let deadlineCarried = false;
  if (row.next_deadline_s) {
    try {
      await db.query(
        `INSERT INTO matter_deadlines (matter_id, title, citation, due_date, party, note)
         VALUES ($1, $2, NULL, $3, 'us', $4)`,
        [matterId,
         String(row.next_deadline_desc || "Deadline carried over from the Federal & TM page").substring(0, 300),
         row.next_deadline_s,
         `Carried over from the Federal & TM page on ${today}. Confirm the date against the USPTO record.`]
      );
      deadlineCarried = true;
    } catch (err) {
      // Do not leave a matter behind without its deadline.
      await db.query(`DELETE FROM matters WHERE id = $1`, [matterId]).catch(() => {});
      throw new Error("Could not carry the deadline across, so nothing was moved: " + err.message);
    }
  }

  await db.query(
    `UPDATE federal_matters
        SET status = 'closed',
            notes = COALESCE(notes || E'\n', '') || $2,
            updated_at = NOW()
      WHERE id = $1`,
    [id, `${MOVED_MARK} as matter #${matterId} on ${today}. Track it there.]`]
  );
  return { matterId, deadlineCarried, tracked: !!serial, isTTAB };
}

module.exports = {
  initTable,
  MATTER_TYPES, TYPE_LABELS, TYPE_GROUPS, STATUSES, STATUS_COLORS,
  createMatter, updateMatter, deleteMatter, getMatter, listMatters, getStats,
  isTrademarkType, listTrademarksToMove, moveTrademarkToMatterManager,
};
