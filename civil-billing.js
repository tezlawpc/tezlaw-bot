// ============================================================
//  TEZ LAW P.C. — CIVIL BILLING & MATTER BUDGETS  (build 38)
//  ─────────────────────────────────────────────────────────
//  Two things this module owns:
//
//   1. Multi-rate timekeepers — when a team member logs
//      billable time on a case, their OWN rate is used
//      (partner $500, associate $350, paralegal $150), not
//      whatever the case's hourly_rate happens to be. The
//      rate flows from admin_users.billing_rate → optionally
//      overridden by civil_case_team.billing_rate for that
//      specific case → optionally overridden per event.
//
//   2. Matter budgets — set a $ cap when the engagement
//      begins, get warned as you cross 75% (configurable)
//      of the budget. Prevents scope-creep write-offs.
//
//  Everything here is a THIN LAYER over the existing
//  civil_cases + civil_case_events + civil_case_team +
//  admin_users tables. No new tables — just adds a few
//  columns and endpoints.
// ============================================================

const db = require("./db");

// ═══════════════════════════════════════════════════════════
//  SCHEMA — add matter budget columns to civil_cases
// ═══════════════════════════════════════════════════════════

async function initTables() {
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS matter_budget NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS budget_alert_pct NUMERIC DEFAULT 75`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS fee_arrangement_notes TEXT`).catch(() => {});
  // Track when we last sent a budget alert so we don't spam JJ once per event.
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS last_budget_alert_at TIMESTAMPTZ`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS last_budget_alert_pct NUMERIC`).catch(() => {});
}

// ═══════════════════════════════════════════════════════════
//  RATE RESOLUTION
//  Given a user + case, returns the effective billing rate.
//  Precedence: case-team override > user default > case hourly_rate > null
// ═══════════════════════════════════════════════════════════

async function resolveRate(userId, caseId) {
  if (!userId) {
    // No specific user — fall back to case hourly_rate
    if (!caseId) return null;
    const r = await db.query(`SELECT hourly_rate FROM civil_cases WHERE id = $1`, [caseId]);
    return r.rows[0]?.hourly_rate ? Number(r.rows[0].hourly_rate) : null;
  }
  // 1. Case-team override (this specific person, this specific case)
  const teamR = await db.query(
    `SELECT billing_rate FROM civil_case_team
     WHERE case_id = $1 AND user_id = $2 AND active = TRUE AND billing_rate IS NOT NULL
     ORDER BY assigned_at DESC LIMIT 1`,
    [caseId, userId]
  );
  if (teamR.rows[0]?.billing_rate) return Number(teamR.rows[0].billing_rate);

  // 2. User's default rate (admin_users.billing_rate — set once, applies firm-wide)
  const userR = await db.query(`SELECT billing_rate FROM admin_users WHERE id = $1`, [userId]);
  if (userR.rows[0]?.billing_rate) return Number(userR.rows[0].billing_rate);

  // 3. Case-level fallback rate
  const caseR = await db.query(`SELECT hourly_rate FROM civil_cases WHERE id = $1`, [caseId]);
  return caseR.rows[0]?.hourly_rate ? Number(caseR.rows[0].hourly_rate) : null;
}

// ═══════════════════════════════════════════════════════════
//  BILLING SUMMARY (per case)
//  Groups events by timekeeper, computes running totals, and
//  reports budget-vs-actual with alert status.
// ═══════════════════════════════════════════════════════════

async function getBillingSummary(caseId) {
  const [caseR, byUserR, allEventsR, commsR, discoveryR] = await Promise.all([
    db.query(`SELECT id, case_name, matter_budget, budget_alert_pct, hourly_rate,
                     billing_type, contingency_pct, retainer_amount, retainer_balance,
                     last_budget_alert_at, last_budget_alert_pct
              FROM civil_cases WHERE id = $1`, [caseId]),
    db.query(
      // Group by attorney_id first; fall back to paralegal_id if attorney is null.
      // Join admin_users to get names + system roles for the display.
      `SELECT
         COALESCE(e.attorney_id, e.paralegal_id) AS user_id,
         u.full_name, u.username, u.role AS system_role,
         COUNT(*)::int                            AS entry_count,
         COALESCE(SUM(e.billable_hours), 0)::float  AS total_hours,
         COALESCE(SUM(e.billable_amount), 0)::float AS total_amount,
         MIN(e.event_date)                        AS first_entry_date,
         MAX(e.event_date)                        AS last_entry_date
       FROM civil_case_events e
       LEFT JOIN admin_users u
         ON u.id = COALESCE(e.attorney_id, e.paralegal_id)
       WHERE e.case_id = $1 AND e.billable_hours IS NOT NULL
       GROUP BY user_id, u.full_name, u.username, u.role
       ORDER BY total_amount DESC NULLS LAST`,
      [caseId]
    ),
    // Case totals across events + comms + discovery-related work
    db.query(
      `SELECT COALESCE(SUM(billable_hours), 0)::float AS h,
              COALESCE(SUM(billable_amount), 0)::float AS a
       FROM civil_case_events WHERE case_id = $1`,
      [caseId]
    ),
    db.query(
      `SELECT COALESCE(SUM(billable_hours), 0)::float AS h
       FROM civil_case_communications WHERE case_id = $1`,
      [caseId]
    ),
    // Depos (billable_hours + billable_amount live on civil_depositions)
    db.query(
      `SELECT COALESCE(SUM(billable_hours), 0)::float AS h,
              COALESCE(SUM(billable_amount), 0)::float AS a
       FROM civil_depositions WHERE case_id = $1`,
      [caseId]
    ),
  ]);
  const c = caseR.rows[0];
  if (!c) return null;

  const eventTotalHours  = allEventsR.rows[0]?.h || 0;
  const eventTotalAmount = allEventsR.rows[0]?.a || 0;
  const commHours        = commsR.rows[0]?.h || 0;
  const depoHours        = discoveryR.rows[0]?.h || 0;
  const depoAmount       = discoveryR.rows[0]?.a || 0;

  const totalHours  = eventTotalHours + commHours + depoHours;
  const totalAmount = eventTotalAmount + depoAmount;

  const budget = c.matter_budget ? Number(c.matter_budget) : null;
  const alertPct = c.budget_alert_pct != null ? Number(c.budget_alert_pct) : 75;
  const pctUsed = budget ? (totalAmount / budget) * 100 : null;
  const overBudget = budget != null && totalAmount > budget;
  const nearingBudget = budget != null && pctUsed >= alertPct && !overBudget;
  const remaining = budget != null ? Math.max(0, budget - totalAmount) : null;

  return {
    case_id: caseId,
    case_name: c.case_name,
    matter_budget: budget,
    budget_alert_pct: alertPct,
    billing_type: c.billing_type,
    hourly_rate: c.hourly_rate ? Number(c.hourly_rate) : null,
    contingency_pct: c.contingency_pct ? Number(c.contingency_pct) : null,
    retainer_amount: c.retainer_amount ? Number(c.retainer_amount) : null,
    retainer_balance: c.retainer_balance ? Number(c.retainer_balance) : null,
    total_hours: Number(totalHours.toFixed(2)),
    total_amount: Number(totalAmount.toFixed(2)),
    event_hours: Number(eventTotalHours.toFixed(2)),
    event_amount: Number(eventTotalAmount.toFixed(2)),
    communication_hours: Number(commHours.toFixed(2)),
    deposition_hours: Number(depoHours.toFixed(2)),
    deposition_amount: Number(depoAmount.toFixed(2)),
    pct_of_budget: pctUsed != null ? Number(pctUsed.toFixed(1)) : null,
    remaining_budget: remaining,
    over_budget: overBudget,
    nearing_budget: nearingBudget,
    by_timekeeper: byUserR.rows.map(r => ({
      user_id: r.user_id,
      name: r.full_name || r.username || (r.user_id ? `user #${r.user_id}` : "Unassigned"),
      system_role: r.system_role,
      entry_count: r.entry_count,
      total_hours: Number((r.total_hours || 0).toFixed(2)),
      total_amount: Number((r.total_amount || 0).toFixed(2)),
      first_entry_date: r.first_entry_date,
      last_entry_date: r.last_entry_date,
    })),
    last_budget_alert_at: c.last_budget_alert_at,
    last_budget_alert_pct: c.last_budget_alert_pct ? Number(c.last_budget_alert_pct) : null,
  };
}

// ═══════════════════════════════════════════════════════════
//  FIRM-WIDE WIP (work in progress) REPORT
//  Every active civil case with unbilled time, aging by month.
// ═══════════════════════════════════════════════════════════

async function getFirmWip() {
  const r = await db.query(`
    WITH case_totals AS (
      SELECT c.id AS case_id, c.case_name, c.client_key, c.stage,
             c.matter_budget, c.hourly_rate,
             c.lead_attorney_id,
             COALESCE(SUM(e.billable_hours), 0)::float  AS total_hours,
             COALESCE(SUM(e.billable_amount), 0)::float AS total_amount,
             MAX(e.event_date)                          AS last_activity_date
      FROM civil_cases c
      LEFT JOIN civil_case_events e ON e.case_id = c.id AND e.billable_hours IS NOT NULL
      WHERE c.status = 'active'
      GROUP BY c.id
    )
    SELECT ct.*,
           u.full_name AS lead_attorney_name,
           CASE
             WHEN ct.matter_budget IS NULL OR ct.matter_budget = 0 THEN NULL
             ELSE ROUND((ct.total_amount / ct.matter_budget * 100)::numeric, 1)
           END AS pct_of_budget,
           (ct.matter_budget IS NOT NULL AND ct.total_amount > ct.matter_budget) AS over_budget
    FROM case_totals ct
    LEFT JOIN admin_users u ON u.id = ct.lead_attorney_id
    ORDER BY total_amount DESC NULLS LAST
    LIMIT 500
  `);
  return r.rows;
}

// ═══════════════════════════════════════════════════════════
//  BUDGET UPDATE — bulk fields on civil_cases
// ═══════════════════════════════════════════════════════════

async function updateBudget(caseId, data) {
  const allowed = new Set(["matter_budget", "budget_alert_pct", "fee_arrangement_notes"]);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(data)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(v === "" ? null : v);
  }
  if (!sets.length) throw new Error("no editable budget fields");
  // Reset alert tracking on budget change so JJ gets re-notified at the new threshold
  sets.push(`last_budget_alert_at = NULL`, `last_budget_alert_pct = NULL`);
  sets.push(`updated_at = NOW()`);
  vals.push(caseId);
  const r = await db.query(
    `UPDATE civil_cases SET ${sets.join(", ")} WHERE id = $${i} RETURNING id, matter_budget, budget_alert_pct, fee_arrangement_notes`,
    vals
  );
  return r.rows[0];
}

// ═══════════════════════════════════════════════════════════
//  BUDGET-ALERT CHECK
//  Called after each time entry to see if a threshold was
//  just crossed. Returns { should_alert, current_pct, ... }
//  so the caller can push-notify JJ or the lead attorney.
// ═══════════════════════════════════════════════════════════

async function checkBudgetAlert(caseId) {
  const summary = await getBillingSummary(caseId);
  if (!summary || !summary.matter_budget) return { should_alert: false };
  const currentPct = summary.pct_of_budget || 0;
  const lastAlertPct = summary.last_budget_alert_pct || 0;
  const alertPct = summary.budget_alert_pct;

  // Alert when crossing a new threshold — 75, 90, 100, 110% etc.
  // We check bands of 15 so back-to-back small increments don't re-fire.
  const thresholdBands = [alertPct, 90, 100, 110, 125, 150];
  const crossed = thresholdBands.filter(t => currentPct >= t && lastAlertPct < t);

  if (!crossed.length) return { should_alert: false, current_pct: currentPct };

  const highestCrossed = Math.max(...crossed);
  // Record the alert threshold so we don't re-fire this band on the next entry
  await db.query(
    `UPDATE civil_cases SET last_budget_alert_at = NOW(), last_budget_alert_pct = $1 WHERE id = $2`,
    [highestCrossed, caseId]
  );

  return {
    should_alert: true,
    current_pct: currentPct,
    threshold_crossed: highestCrossed,
    total_amount: summary.total_amount,
    matter_budget: summary.matter_budget,
    over_budget: summary.over_budget,
    case_name: summary.case_name,
  };
}

module.exports = {
  initTables,
  resolveRate,
  getBillingSummary,
  getFirmWip,
  updateBudget,
  checkBudgetAlert,
};
