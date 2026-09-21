// ============================================================
//  civil-snapshot.js — one civil matter, in a form Zara can read
//  ─────────────────────────────────────────────────────────
//  Everything an attorney means by "where are we on this one?":
//  the matter itself, what is due, what is on calendar, what the
//  court last did, what has been billed and what has not, and the
//  latest activity. Compact on purpose — it goes into a prompt.
//
//  Used two ways by the staff chat:
//    · Pre-loaded when the user is ON a case page, so "this case"
//      is answerable in the first reply without a lookup at all.
//    · As the get_civil_matter tool, for any other matter by id.
//
//  Every section is fetched independently and a failure in one is
//  reported inside the snapshot rather than sinking the rest — a
//  missing hearings table must not stop Zara reporting deadlines.
// ============================================================

const db = require("./db");

function day(d) {
  if (!d) return null;
  const t = new Date(d);
  return isNaN(t) ? String(d) : t.toISOString().slice(0, 10);
}
function trim(s, n) {
  const v = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n - 1) + "…" : v || null;
}
async function section(fn) {
  try { return await fn(); } catch (e) { return { unavailable: e.message }; }
}

async function snapshot(caseId) {
  const id = parseInt(caseId, 10);
  if (!id) throw new Error("A civil matter id is required");
  const c = (await db.query(`SELECT * FROM civil_cases WHERE id = $1`, [id])).rows[0];
  if (!c) throw new Error(`No civil matter #${id}`);

  const matter = {
    id: c.id, case_name: c.case_name, case_number: c.case_number, client_key: c.client_key,
    court: c.court, county: c.county, case_type: c.case_type, our_role: c.our_role, stage: c.stage,
    jurisdiction: c.jurisdiction || null, opposing_party: c.opposing_party,
    filed_date: day(c.filed_date), service_date: day(c.service_date),
    statute_of_limitations: day(c.statute_of_limitations), cmc_date: day(c.cmc_date), trial_date: day(c.trial_date),
    billing_type: c.billing_type, hourly_rate: c.hourly_rate != null ? Number(c.hourly_rate) : null,
    retainer_amount: c.retainer_amount != null ? Number(c.retainer_amount) : null,
    retainer_balance: c.retainer_balance != null ? Number(c.retainer_balance) : null,
    dropbox_folder: c.dropbox_path || null, files_archived: !!c.files_archived_at,
    internal_notes: trim(c.internal_notes, 600),
  };

  const [deadlines, hearings, time, invoices, events] = await Promise.all([
    section(async () => (await db.query(
      `SELECT due_date, description, ccp_rule, priority, auto_generated FROM civil_case_deadlines
        WHERE case_id = $1 AND status = 'pending' ORDER BY due_date ASC LIMIT 15`, [id])).rows
      .map(d => ({ due: day(d.due_date), what: d.description, rule: d.ccp_rule || undefined,
                   priority: d.priority, auto: d.auto_generated || undefined }))),

    section(async () => {
      const rows = (await db.query(
        `SELECT hearing_date, hearing_time, hearing_type, department, judge, appearance, status,
                purpose, ruling, notes, next_steps, continued_to
           FROM civil_hearings WHERE case_id = $1 ORDER BY hearing_date DESC LIMIT 12`, [id])).rows;
      return {
        upcoming: rows.filter(h => h.status === "scheduled").reverse().map(h => ({
          date: day(h.hearing_date), time: h.hearing_time, type: h.hearing_type, dept: h.department,
          judge: h.judge, appearance: h.appearance, purpose: trim(h.purpose, 200),
          prep_notes: trim(h.notes, 400) })),
        past: rows.filter(h => h.status !== "scheduled").slice(0, 5).map(h => ({
          date: day(h.hearing_date), type: h.hearing_type, result: h.status,
          ruling: trim(h.ruling, 300), notes: trim(h.notes, 500), next_steps: trim(h.next_steps, 200),
          continued_to: day(h.continued_to) || undefined })),
      };
    }),

    section(async () => {
      const r = await db.query(
        `WITH t AS (
           SELECT event_date AS d, COALESCE(NULLIF(description,''), title) AS what, billable_hours AS h,
                  CASE WHEN no_charge THEN 0 ELSE billable_amount END AS amt, invoice_id
             FROM civil_case_events WHERE case_id = $1 AND billable_hours IS NOT NULL
           UNION ALL
           SELECT created_at::date, COALESCE(NULLIF(subject,''), kind), billable_hours,
                  CASE WHEN no_charge THEN 0 ELSE billable_amount END, invoice_id
             FROM civil_case_communications WHERE case_id = $1 AND billable_hours IS NOT NULL
         ) SELECT * FROM t ORDER BY d DESC NULLS LAST`, [id]);
      const all = r.rows;
      const sum = rows => ({
        entries: rows.length,
        hours: Math.round(rows.reduce((s, x) => s + Number(x.h || 0), 0) * 100) / 100,
        amount: Math.round(rows.reduce((s, x) => s + Number(x.amt || 0), 0) * 100) / 100,
        unpriced: rows.filter(x => x.amt == null).length || undefined,
      });
      const unbilled = all.filter(x => !x.invoice_id);
      return {
        unbilled: sum(unbilled),
        billed: sum(all.filter(x => x.invoice_id)),
        all_time: sum(all),
        recent_unbilled: unbilled.slice(0, 8).map(x => ({ date: day(x.d), hours: Number(x.h), what: trim(x.what, 120) })),
      };
    }),

    section(async () => (await db.query(
      `SELECT invoice_number, invoice_date, total_hours, total_amount, status FROM civil_invoices
        WHERE case_id = $1 ORDER BY created_at DESC LIMIT 6`, [id])).rows
      .map(i => ({ number: i.invoice_number, date: day(i.invoice_date), hours: Number(i.total_hours),
                   amount: Number(i.total_amount), status: i.status }))),

    section(async () => (await db.query(
      `SELECT event_date, event_kind, title FROM civil_case_events
        WHERE case_id = $1 AND event_kind <> 'time'
        ORDER BY COALESCE(event_date, created_at::date) DESC, created_at DESC LIMIT 10`, [id])).rows
      .map(e => ({ date: day(e.event_date), kind: e.event_kind, what: trim(e.title, 140) }))),
  ]);

  return {
    matter, pending_deadlines: deadlines, hearings, time, invoices, recent_activity: events,
    as_of: new Date().toISOString().slice(0, 10),
  };
}

/** Find civil matters by caption, case number or client key. */
async function findMatters(query, limit = 8) {
  const q = String(query || "").trim();
  if (q.length < 2) throw new Error("Give at least two characters of the case name or number");
  const r = await db.query(
    `SELECT id, case_name, case_number, stage, court, trial_date FROM civil_cases
      WHERE case_name ILIKE $1 OR case_number ILIKE $1 OR client_key ILIKE $1 OR opposing_party ILIKE $1
      ORDER BY updated_at DESC NULLS LAST LIMIT $2`,
    [`%${q}%`, Math.min(20, limit)]
  );
  return r.rows.map(c => ({ id: c.id, case_name: c.case_name, case_number: c.case_number,
                            stage: c.stage, court: c.court, trial_date: day(c.trial_date) }));
}

/** The case id a web page context names, if it names one. */
function caseIdFromContext(context) {
  const m = String(context || "").match(/civil matter #(\d+)/i) ||
            String(context || "").match(/\/admin\/civil\/case\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { snapshot, findMatters, caseIdFromContext };
