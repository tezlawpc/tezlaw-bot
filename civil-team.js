// ============================================================
//  TEZ LAW P.C. — CIVIL CASE TEAM ASSIGNMENTS
//  ─────────────────────────────────────────────────────────
//  Multi-role team per case. Each civil_cases row can have any
//  number of admin_users assigned with a specific role:
//
//    · lead_attorney      — case owner, primary decision-maker
//    · second_chair       — co-counsel
//    · case_manager       — client-facing project manager
//    · paralegal          — drafts, calendars, files
//    · sales_intake       — origination / referral tracking
//    · associate          — junior attorney
//    · of_counsel         — outside affiliated attorney
//    · contract_attorney  — hired-help attorney
//    · expert             — expert witness (paid consultant)
//    · investigator       — private investigator
//
//  A single person can hold MULTIPLE roles on the same case
//  (rare — e.g. JJ is often both lead_attorney and case_manager on
//   small matters). Uniqueness is on (case_id, user_id, role).
//
//  Billing rates: default rate comes from admin_users.billing_rate
//  (added by this module). Case-level override supported via
//  civil_case_team.billing_rate for special engagements.
// ============================================================

const db = require("./db");

const TEAM_ROLES = [
  { key: "lead_attorney",     label: "Lead Attorney",     color: "#3E2818", access: "full" },
  { key: "second_chair",      label: "Second Chair",      color: "#7B5330", access: "full" },
  { key: "of_counsel",        label: "Of Counsel",        color: "#8B7355", access: "full" },
  { key: "associate",         label: "Associate",         color: "#B8891E", access: "write" },
  { key: "contract_attorney", label: "Contract Attorney", color: "#A0803A", access: "write" },
  { key: "case_manager",      label: "Case Manager",      color: "#D97706", access: "write" },
  { key: "paralegal",         label: "Paralegal",         color: "#E0B44E", access: "write" },
  { key: "sales_intake",      label: "Sales / Intake",    color: "#0284C7", access: "read" },
  { key: "expert",            label: "Expert Witness",    color: "#7C3AED", access: "read" },
  { key: "investigator",      label: "Investigator",      color: "#4B5563", access: "read" },
];

const ROLE_KEYS = new Set(TEAM_ROLES.map(r => r.key));

async function initTables() {
  // Add billing_rate column to admin_users (nullable — not everyone bills)
  await db.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS billing_rate NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS default_role TEXT`).catch(() => {});
  await db.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email TEXT`).catch(() => {});
  await db.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS phone TEXT`).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_case_team (
      id             SERIAL PRIMARY KEY,
      case_id        INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      user_id        INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,
      user_name      TEXT,
      role           TEXT NOT NULL,
      billing_rate   NUMERIC,
      active         BOOLEAN DEFAULT TRUE,
      is_primary     BOOLEAN DEFAULT FALSE,
      notes          TEXT,
      assigned_at    TIMESTAMPTZ DEFAULT NOW(),
      assigned_by    TEXT,
      removed_at     TIMESTAMPTZ,
      removed_by     TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_team_case ON civil_case_team (case_id) WHERE active = TRUE`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_team_user ON civil_case_team (user_id) WHERE active = TRUE`);
  // Prevent duplicate active assignments of the same user+role on the same case.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_civil_team_active
    ON civil_case_team (case_id, user_id, role)
    WHERE active = TRUE
  `);
}

// ═══════════════════════════════════════════════════════════
//  USER DIRECTORY (for the assignment picker)
// ═══════════════════════════════════════════════════════════

// Returns all firm users that can be assigned to cases, sorted by role
// then name. Excludes disabled accounts.
async function listAssignableUsers() {
  const r = await db.query(
    `SELECT id, username, full_name, role, email, phone, billing_rate, default_role
     FROM admin_users WHERE disabled IS NOT TRUE
     ORDER BY
       CASE role WHEN 'admin' THEN 0 WHEN 'manager' THEN 1 WHEN 'attorney' THEN 2
                 WHEN 'paralegal' THEN 3 ELSE 4 END,
       full_name ASC NULLS LAST, username ASC`
  );
  return r.rows;
}

// ═══════════════════════════════════════════════════════════
//  TEAM ASSIGNMENTS — CRUD
// ═══════════════════════════════════════════════════════════

async function listTeam(caseId, opts = {}) {
  const where = ["t.case_id = $1"];
  const vals = [caseId];
  if (!opts.include_inactive) where.push("t.active = TRUE");
  const r = await db.query(
    `SELECT
       t.*,
       u.username, u.full_name AS user_full_name, u.role AS user_system_role,
       u.email AS user_email, u.phone AS user_phone,
       u.billing_rate AS user_default_rate
     FROM civil_case_team t
     LEFT JOIN admin_users u ON u.id = t.user_id
     WHERE ${where.join(" AND ")}
     ORDER BY
       CASE t.role
         WHEN 'lead_attorney' THEN 0 WHEN 'second_chair' THEN 1
         WHEN 'of_counsel' THEN 2 WHEN 'associate' THEN 3
         WHEN 'contract_attorney' THEN 4 WHEN 'case_manager' THEN 5
         WHEN 'paralegal' THEN 6 WHEN 'sales_intake' THEN 7
         WHEN 'expert' THEN 8 WHEN 'investigator' THEN 9 ELSE 10 END,
       t.assigned_at ASC`,
    vals
  );
  return r.rows;
}

async function addAssignment(caseId, data) {
  const { user_id, user_name, role, billing_rate, is_primary, notes, assigned_by } = data;
  if (!role || !ROLE_KEYS.has(role)) throw new Error(`Invalid role. Must be one of: ${Array.from(ROLE_KEYS).join(", ")}`);
  if (!user_id && !user_name) throw new Error("Either user_id (existing admin_user) or user_name (free-text external) is required");

  // If user_id given, look up their default billing rate as fallback
  let rate = billing_rate ? Number(billing_rate) : null;
  if (user_id && !rate) {
    try {
      const u = await db.query(`SELECT billing_rate FROM admin_users WHERE id = $1`, [user_id]);
      if (u.rows[0]?.billing_rate) rate = Number(u.rows[0].billing_rate);
    } catch {}
  }

  try {
    const r = await db.query(
      `INSERT INTO civil_case_team
         (case_id, user_id, user_name, role, billing_rate, is_primary, notes, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [caseId, user_id || null, user_name || null, role, rate,
       !!is_primary, notes || null, assigned_by || null]
    );

    // If a lead_attorney or case_manager is being assigned, mirror to
    // civil_cases.lead_attorney_id / case_manager_id so downstream deadline
    // rules and rollups pick them up without re-querying the team table.
    if (user_id) {
      if (role === "lead_attorney") {
        await db.query(`UPDATE civil_cases SET lead_attorney_id = $1 WHERE id = $2`, [user_id, caseId]);
      } else if (role === "case_manager") {
        await db.query(`UPDATE civil_cases SET case_manager_id = $1 WHERE id = $2`, [user_id, caseId]);
      }
    }

    return r.rows[0];
  } catch (err) {
    if (err.code === "23505") {
      throw new Error("This person is already assigned to this case with that role. Use PATCH to update or remove first.");
    }
    throw err;
  }
}

async function updateAssignment(id, data) {
  const allowed = new Set(["role", "billing_rate", "is_primary", "notes"]);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(data)) {
    if (!allowed.has(k)) continue;
    if (k === "role" && !ROLE_KEYS.has(v)) throw new Error(`Invalid role: ${v}`);
    sets.push(`${k} = $${i++}`);
    vals.push(v === "" ? null : v);
  }
  if (!sets.length) throw new Error("No editable fields");
  vals.push(id);
  const r = await db.query(
    `UPDATE civil_case_team SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return r.rows[0];
}

async function removeAssignment(id, removedBy) {
  const r = await db.query(
    `UPDATE civil_case_team
     SET active = FALSE, removed_at = NOW(), removed_by = $2
     WHERE id = $1 RETURNING *`,
    [id, removedBy || null]
  );
  return r.rows[0];
}

// ═══════════════════════════════════════════════════════════
//  MY CASES — for a specific user
// ═══════════════════════════════════════════════════════════

// Returns all civil cases where a given user is on the active team,
// optionally filtered by role. Powers the "My Civil Cases" view
// on the app home screen.
async function listCasesForUser(userId, filter = {}) {
  const where = ["t.user_id = $1", "t.active = TRUE", "c.status = 'active'"];
  const vals = [userId];
  let i = 2;
  if (filter.role)  { where.push(`t.role = $${i++}`);  vals.push(filter.role); }
  if (filter.stage) { where.push(`c.stage = $${i++}`); vals.push(filter.stage); }
  const r = await db.query(
    `SELECT DISTINCT c.*, t.role AS my_role, t.is_primary
     FROM civil_case_team t
     JOIN civil_cases c ON c.id = t.case_id
     WHERE ${where.join(" AND ")}
     ORDER BY c.updated_at DESC LIMIT 200`,
    vals
  );
  return r.rows;
}

// Team workload — for capacity planning. Groups active cases per user,
// counts pending deadlines, and shows next 30-day deadline load.
async function getTeamWorkload() {
  const r = await db.query(`
    WITH active_team AS (
      SELECT t.user_id, u.full_name, u.username, u.role AS system_role,
             t.role AS case_role, c.id AS case_id, c.case_name, c.stage
      FROM civil_case_team t
      JOIN admin_users u ON u.id = t.user_id
      JOIN civil_cases c ON c.id = t.case_id
      WHERE t.active = TRUE AND c.status = 'active'
    ),
    user_agg AS (
      SELECT user_id, full_name, username, system_role,
             COUNT(DISTINCT case_id)::int AS active_case_count,
             array_agg(DISTINCT case_role) AS roles_held
      FROM active_team
      GROUP BY user_id, full_name, username, system_role
    ),
    deadline_load AS (
      SELECT c.lead_attorney_id AS user_id,
             COUNT(*) FILTER (WHERE d.due_date <= CURRENT_DATE + INTERVAL '30 days')::int AS deadlines_next_30d,
             COUNT(*) FILTER (WHERE d.due_date < CURRENT_DATE)::int AS overdue_count
      FROM civil_case_deadlines d
      JOIN civil_cases c ON c.id = d.case_id
      WHERE d.status = 'pending'
      GROUP BY c.lead_attorney_id
    )
    SELECT ua.*,
           COALESCE(dl.deadlines_next_30d, 0) AS deadlines_next_30d,
           COALESCE(dl.overdue_count, 0) AS overdue_count
    FROM user_agg ua
    LEFT JOIN deadline_load dl ON dl.user_id = ua.user_id
    ORDER BY active_case_count DESC, full_name ASC
  `);
  return r.rows;
}

module.exports = {
  initTables,
  TEAM_ROLES, ROLE_KEYS,
  listAssignableUsers,
  listTeam, addAssignment, updateAssignment, removeAssignment,
  listCasesForUser, getTeamWorkload,
};
