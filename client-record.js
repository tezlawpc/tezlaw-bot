/**
 * client-record.js — what Zara is told about the signed-in client's own matter.
 *
 * One function, build(), keyed to ONE client account. It is the only case data
 * that reaches the model on the client surface (zara-app-chat gives a client
 * no database tools), so there is no path here to anyone else's record.
 *
 * HISTORY
 *   v1  The lookup sat inline in /api/client/chat and failed on its first
 *       query for every client: a client token carries uid "c<id>" and that
 *       string was handed to client_accounts.id, an integer column. Zara was
 *       told the client had no record and said "that's specific to your case".
 *   v2  (this) JJ: "when i ask about billing information, same error message
 *       appear. review all relevant information can be pertained to client and
 *       allow access." v1 carried hearings, appointments, documents and UNPAID
 *       invoices only — and an empty section was simply left out, so a client
 *       with nothing owing looked, to the model, like a client whose billing
 *       she could not see. Now the record covers everything the firm holds
 *       that is the client's own to know, and every section a client is likely
 *       to ask about is stated even when it is empty.
 *
 * WHAT IS IN  — the client's own facts
 *   who they are on file · their matters and where each stands · the team ·
 *   court dates · deadlines · appointments · billing (invoices paid and
 *   unpaid, trust balance and activity, fee terms, a finalized settlement
 *   statement) · documents and signature requests · unread messages.
 *
 * WHAT IS OUT — the firm's own working file, on purpose
 *   · staff notes (client_notes, matter notes, civil internal_notes)
 *   · task descriptions and completion notes (the TITLE is shown, not these)
 *   · time not yet billed (it is not a bill until it is on an invoice)
 *   · settlement offers and negotiations — an offer is the attorney's to
 *     communicate and explain (Rule 1.4.1), not a chatbot's to announce
 *   · liability and case assessments, lien and medical-bill negotiations
 *   · rulings and hearing notes as staff wrote them
 *   · other people on the case beyond name and relationship
 *   Each of these is a line to add below if JJ decides otherwise.
 *
 * Every lookup degrades to "nothing found" rather than failing the chat, and
 * every one is SELECT * with the fields picked in JS: naming a column a table
 * turned out not to have is what broke v1's first query.
 */

// A client token's uid is "c<id>" so a client can never be mistaken for the
// staff user with the same number. Every integer column wants the number.
function accountIdOf(uid) {
  const n = parseInt(String(uid == null ? "" : uid).replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const PT = "America/Los_Angeles";
const LONG = { weekday: "long", year: "numeric", month: "long", day: "numeric" };

// A true instant (TIMESTAMPTZ set by staff), shown in Pacific time WITH the
// time of day — "when is my appointment" is a question about the hour.
function instantPT(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return null;
  return `${d.toLocaleDateString("en-US", { timeZone: PT, ...LONG })} at ` +
    `${d.toLocaleTimeString("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit" })} Pacific time`;
}
const dayPT = (v) => { const s = instantPT(v); return s ? s.split(" at ")[0] : null; };

// A DATE column. node-pg builds it at local midnight, so read it back with
// local getters — never through UTC, which can land on the day before.
function calendarDay(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).length <= 10 ? `${v}T12:00:00` : v);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-US", LONG);
}

// A hearing notice's date. hearing-notices.js stores the wall-clock date and
// time read off the notice without a zone, so the DATE is read in UTC (what it
// was stored as) and the TIME comes from the notice's own text, not from a
// zone conversion that could shift it.
function hearingDay(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return null;
  return d.toLocaleDateString("en-US", { timeZone: "UTC", ...LONG });
}

const usd = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (c) => usd((Number(c) || 0) / 100);
const clip = (s, n = 160) => { const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const words = (s) => String(s || "").replace(/_/g, " ").trim();
const uniq = (a) => [...new Set(a.filter(Boolean))];
const future = (v, t) => v && new Date(v).getTime() >= t;

// client_key as SQL, from a row's a_number and client_name — the same rule as
// client-profiles.clientKey(), so rows in tables that carry no client_key
// (hearing notes, deadlines) can be matched to one client.
const KEY_SQL = `CASE WHEN COALESCE(a_number, '') <> ''
       THEN 'a-' || regexp_replace(lower(a_number), '[^a-z0-9_]', '', 'g')
       ELSE 'n-' || trim(both '-' from regexp_replace(lower(trim(COALESCE(client_name, ''))), '[^a-z0-9_]+', '-', 'g'))
  END`;

const APPT_STATUS = {
  awaiting_payment: "requested — consultation fee not yet paid, so no time has been set",
  paid_pending: "requested and paid — the office has not set the time yet",
  confirmed: "confirmed",
};
const CLOSED_TASK = new Set(["completed", "cancelled", "canceled", "closed", "done"]);
const DEAD_INVOICE = new Set(["void", "voided", "cancelled", "canceled", "draft"]);

// This client's pending immigration / general deadlines. The deadlines table
// has no client_key, so the match is by A-number or name (KEY_SQL).
async function deadlinesFor(db, clientKey) {
  if (!clientKey) return [];
  const r = await db.query(
    `SELECT description, due_date, priority FROM deadlines
      WHERE status = 'pending' AND ${KEY_SQL} = $1
      ORDER BY due_date ASC LIMIT 8`, [clientKey]).catch(() => ({ rows: [] }));
  return r.rows.map(d => `${clip(d.description)}${d.due_date ? ` — due ${calendarDay(d.due_date)}` : ""}`);
}

/**
 * @param {object} db            pg pool / client with query()
 * @param {object} who
 * @param {*}      who.uid       req.user.uid from the client token ("c12")
 * @param {string} [who.clientKey]  req.user.ck from the token, used if the account row is unreadable
 * @param {string} [who.name]    req.user.n
 * @param {string} [who.lang]
 * @param {Date}   [who.now]     injectable clock for tests
 * @returns {Promise<object|null>} the caseContext CLIENT_OPS expects
 */
async function build(db, { uid, clientKey = null, name = null, lang = "en", now = new Date() } = {}) {
  const accountId = accountIdOf(uid);
  const rows = (sql, params) => db.query(sql, params).then(r => r.rows || []).catch(e => {
    console.warn("[client-record]", e.message);
    return [];
  });

  let acct = null;
  if (accountId) {
    acct = (await rows(`SELECT * FROM client_accounts WHERE id = $1 LIMIT 1`, [accountId]))[0] || null;
  }

  const ck = (acct && acct.client_key) || clientKey || null;
  const displayName = (acct && acct.full_name) || name || null;
  const language = (acct && (acct.preferred_lang || acct.language)) || lang || "en";

  if (!ck) {
    // Signed in, no matter linked. linked:false tells CLIENT_OPS to say so
    // rather than imply an empty case file.
    return { linked: false, name: displayName, language };
  }

  // ── Round 1: everything keyed straight to this client ──────────────────
  const [
    notices, noted, appts, docs, invs, acctInvs, trust, ledger, tasks, civil, federal, pi,
    members, contact, consultant, sigs, packets, msgs, ident, generalDeadlines,
  ] = await Promise.all([
    rows(`SELECT * FROM client_hearing_notices
           WHERE client_key = $1 AND dismissed_at IS NULL AND hearing_date >= CURRENT_DATE
           ORDER BY hearing_date ASC LIMIT 6`, [ck]),
    // "Next hearing" as the attorney wrote it down after the last one.
    rows(`SELECT next_hearing_date, next_hearing_type FROM (
            SELECT next_hearing_date, next_hearing_type, a_number, client_name FROM hearing_notes
            UNION ALL
            SELECT next_hearing_date, next_hearing_type, a_number, client_name FROM individual_hearing_notes
          ) n
           WHERE next_hearing_date >= CURRENT_DATE AND ${KEY_SQL} = $1
           ORDER BY next_hearing_date ASC LIMIT 5`, [ck]),
    rows(`SELECT * FROM appointments
           WHERE client_key = $1 AND cancelled_at IS NULL AND status <> 'cancelled'
           ORDER BY COALESCE(scheduled_time, created_at) DESC LIMIT 20`, [ck]),
    // Never SELECT * here: client_documents.content is the file itself.
    rows(`SELECT filename, category, uploaded_by, uploaded_at FROM client_documents
           WHERE client_key = $1 ORDER BY uploaded_at DESC LIMIT 10`, [ck]),
    rows(`SELECT * FROM client_invoices WHERE client_key = $1 ORDER BY created_at DESC LIMIT 30`, [ck]),
    rows(`SELECT * FROM accounting_invoices WHERE client_key = $1 ORDER BY invoice_date DESC NULLS LAST LIMIT 12`, [ck]),
    rows(`SELECT * FROM trust_transactions WHERE client_key = $1 ORDER BY id DESC LIMIT 6`, [ck]),
    rows(`SELECT * FROM accounting_trust_ledger WHERE client_key = $1 ORDER BY id DESC LIMIT 1`, [ck]),
    rows(`SELECT * FROM tasks WHERE client_key = $1 ORDER BY created_at DESC LIMIT 40`, [ck]),
    rows(`SELECT * FROM civil_cases WHERE client_key = $1 ORDER BY created_at DESC LIMIT 6`, [ck]),
    rows(`SELECT * FROM federal_matters WHERE client_key = $1 ORDER BY created_at DESC LIMIT 6`, [ck]),
    rows(`SELECT * FROM pi_cases WHERE client_key = $1 ORDER BY created_at DESC LIMIT 4`, [ck]),
    rows(`SELECT full_name, relationship, is_primary FROM case_members WHERE client_key = $1 ORDER BY is_primary DESC, id ASC LIMIT 12`, [ck]),
    rows(`SELECT * FROM client_contacts WHERE client_key = $1 LIMIT 1`, [ck]),
    rows(`SELECT a.full_name, a.phone, a.email
            FROM client_consultants cc JOIN admin_users a ON a.id = cc.consultant_id
           WHERE cc.client_key = $1 AND cc.removed_at IS NULL AND a.disabled IS NOT TRUE
           ORDER BY cc.assigned_at ASC LIMIT 1`, [ck]),
    // Not SELECT *: body_snapshot is the whole document.
    rows(`SELECT title, status, created_at, signed_at FROM signature_requests
           WHERE client_key = $1 ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 10`, [ck]),
    // Not SELECT *: docx / signed_pdf are the files.
    rows(`SELECT title, status, sent_at, completed_at FROM esign_packets
           WHERE client_key = $1 AND status <> 'draft' ORDER BY created_at DESC LIMIT 10`, [ck]),
    rows(`SELECT sender_kind, read_at, created_at FROM client_messages
           WHERE client_key = $1 ORDER BY created_at DESC LIMIT 50`, [ck]),
    rows(`SELECT client_name, a_number FROM client_hearing_notices
           WHERE client_key = $1 ORDER BY created_at DESC LIMIT 1`, [ck]),
    deadlinesFor(db, ck),
  ]);

  // ── Round 2: rows that hang off this client's own cases ────────────────
  const civilIds = civil.map(c => c.id).filter(Number.isFinite);
  const piIds = pi.map(c => c.id).filter(Number.isFinite);
  const taskIds = tasks.map(t => t.id).filter(Number.isFinite);
  const staffIds = uniq(civil.flatMap(c => [c.lead_attorney_id, c.case_manager_id])).filter(Number.isFinite);
  const none = Promise.resolve([]);

  const [civilHearings, civilDeadlines, civilInvoices, civilTeam, staff, disbursements, milestones] = await Promise.all([
    civilIds.length ? rows(`SELECT * FROM civil_hearings
        WHERE case_id = ANY($1::int[]) AND status = 'scheduled' AND hearing_date >= CURRENT_DATE
        ORDER BY hearing_date ASC LIMIT 8`, [civilIds]) : none,
    civilIds.length ? rows(`SELECT * FROM civil_case_deadlines
        WHERE case_id = ANY($1::int[]) AND status = 'pending'
        ORDER BY due_date ASC LIMIT 8`, [civilIds]) : none,
    civilIds.length ? rows(`SELECT * FROM civil_invoices
        WHERE case_id = ANY($1::int[]) AND voided_at IS NULL
        ORDER BY invoice_date DESC NULLS LAST LIMIT 10`, [civilIds]) : none,
    civilIds.length ? rows(`SELECT case_id, user_name, role FROM civil_case_team
        WHERE case_id = ANY($1::int[]) AND active IS NOT FALSE AND removed_at IS NULL LIMIT 20`, [civilIds]) : none,
    staffIds.length ? rows(`SELECT id, full_name FROM admin_users WHERE id = ANY($1::int[])`, [staffIds]) : none,
    // Only a FINALIZED settlement statement: that is the document the client
    // signs. Offers and drafts stay with the attorney.
    piIds.length ? rows(`SELECT * FROM pi_disbursements
        WHERE case_id = ANY($1::int[]) AND finalized = TRUE ORDER BY id DESC LIMIT 2`, [piIds]) : none,
    taskIds.length ? rows(`SELECT task_id, title, status, due_date, completed_at FROM task_milestones
        WHERE task_id = ANY($1::int[]) ORDER BY task_id, order_num LIMIT 40`, [taskIds]) : none,
  ]);

  const t = now.getTime();
  const staffName = (id) => (staff.find(s => s.id === id) || {}).full_name || null;
  const caseName = (id) => (civil.find(c => c.id === id) || {}).case_name || null;

  // ── Matters ────────────────────────────────────────────────────────────
  const openTasks = tasks.filter(x => !CLOSED_TASK.has(String(x.status || "").toLowerCase()) && !x.completed_at);
  const doneTasks = tasks.filter(x => x.completed_at || String(x.status || "").toLowerCase() === "completed")
    .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0)).slice(0, 4);
  const taskLine = (x) => {
    const steps = milestones.filter(m => m.task_id === x.id);
    const done = steps.filter(m => m.completed_at || String(m.status || "").toLowerCase() === "completed");
    const next = steps.find(m => !done.includes(m));
    return clip(x.title || words(x.category) || "Matter", 120) +
      (x.matter_type ? ` (${words(x.matter_type)})` : "") +
      (x.completed_at ? ` — completed ${dayPT(x.completed_at)}` : ` — ${words(x.status) || "open"}`) +
      (x.pi_stage ? `, stage: ${words(x.pi_stage)}` : "") +
      (!x.completed_at && x.due_date ? `, target date ${calendarDay(x.due_date)}` : "") +
      (x.case_number ? `, case no. ${x.case_number}` : "") + (x.court ? `, ${clip(x.court, 60)}` : "") +
      (steps.length ? `; steps done ${done.length} of ${steps.length}${next ? `, next: ${clip(next.title, 60)}` : ""}` : "");
  };

  const civilLine = (c) => [
    clip(c.case_name || "Civil matter", 120),
    c.case_number ? `case no. ${c.case_number}` : null,
    c.court ? clip(c.court, 80) : null,
    c.our_role ? `the firm represents the ${words(c.our_role)}` : null,
    c.stage ? `stage: ${words(c.stage)}` : null,
    c.status && c.status !== "active" ? `status: ${words(c.status)}` : null,
    c.filed_date ? `filed ${calendarDay(c.filed_date)}` : null,
    c.cmc_date && future(c.cmc_date, t - 864e5) ? `case management conference ${calendarDay(c.cmc_date)}` : null,
    c.trial_date ? `trial date ${calendarDay(c.trial_date)}` : null,
    staffName(c.lead_attorney_id) ? `lead attorney ${staffName(c.lead_attorney_id)}` : null,
    staffName(c.case_manager_id) ? `case manager ${staffName(c.case_manager_id)}` : null,
  ].filter(Boolean).join("; ");

  const federalLine = (f) => [
    clip(words(f.matter_type) || "Federal matter", 60) + (f.tm_mark ? ` — mark "${clip(f.tm_mark, 60)}"` : ""),
    f.matter_number ? `no. ${f.matter_number}` : null,
    f.agency ? clip(f.agency, 60) : null,
    f.status ? `status: ${words(f.status)}` : null,
    f.filing_date ? `filed ${calendarDay(f.filing_date)}` : null,
    f.assigned_attorney ? `attorney ${f.assigned_attorney}` : null,
  ].filter(Boolean).join("; ");

  const piLine = (p) => [
    `Personal injury${p.incident_type ? ` (${words(p.incident_type)})` : ""}`,
    p.incident_date ? `incident on ${calendarDay(p.incident_date)}` : null,
  ].filter(Boolean).join("; ");

  // ── Team ───────────────────────────────────────────────────────────────
  // One line per person: the first role found for a name wins.
  const people = new Map();
  const person = (who, role) => { const k = String(who || "").trim(); if (k && !people.has(k.toLowerCase())) people.set(k.toLowerCase(), `${k}${role ? ` (${role})` : ""}`); };
  civil.forEach(c => { person(staffName(c.lead_attorney_id), "lead attorney"); person(staffName(c.case_manager_id), "case manager"); });
  openTasks.forEach(x => person(x.attorney, "attorney"));
  federal.forEach(f => person(f.assigned_attorney, "attorney"));
  civilTeam.forEach(m => person(m.user_name, words(m.role)));
  openTasks.forEach(x => person(x.assigned_to, "handling your matter day to day"));
  const team = [...people.values()].slice(0, 8);
  const cons = consultant[0];

  // ── Court dates ────────────────────────────────────────────────────────
  const hearings = [
    ...notices.map(h => ({ at: new Date(h.hearing_date).getTime(), line:
      `${hearingDay(h.hearing_date)}${h.hearing_time_text ? ` at ${h.hearing_time_text}` : ""}` +
      `${h.hearing_type ? ` — ${h.hearing_type}` : ""}${h.court_name ? `, ${h.court_name}` : ""}` +
      `${h.court_address ? ` (${clip(h.court_address, 100)})` : ""}${h.judge_name ? `, before ${h.judge_name}` : ""}` })),
    ...civilHearings.map(h => ({ at: new Date(h.hearing_date).getTime(), line:
      `${calendarDay(h.hearing_date)}${h.hearing_time ? ` at ${h.hearing_time}` : ""}` +
      `${h.hearing_type ? ` — ${words(h.hearing_type)}` : ""}${h.department ? `, Dept. ${h.department}` : ""}` +
      `${h.location ? `, ${clip(h.location, 80)}` : ""}${h.judge ? `, before ${h.judge}` : ""}` +
      `${caseName(h.case_id) ? ` [${clip(caseName(h.case_id), 60)}]` : ""}` +
      `${h.appearance ? ` (${words(h.appearance)})` : ""}` })),
  ].sort((a, b) => a.at - b.at).slice(0, 8).map(x => x.line);

  // ── Deadlines ──────────────────────────────────────────────────────────
  const deadlines = uniq([
    ...generalDeadlines,
    ...civilDeadlines.map(d => `${clip(d.description)} — due ${calendarDay(d.due_date)}` +
      `${d.ccp_rule ? ` (${d.ccp_rule})` : ""}${caseName(d.case_id) ? ` [${clip(caseName(d.case_id), 60)}]` : ""}`),
    ...federal.filter(f => f.next_deadline_date && future(f.next_deadline_date, t - 864e5))
      .map(f => `${clip(f.next_deadline_desc || "Next deadline")} — due ${calendarDay(f.next_deadline_date)}${f.matter_number ? ` [no. ${f.matter_number}]` : ""}`),
  ]).slice(0, 12);

  // ── Appointments ───────────────────────────────────────────────────────
  const scheduled = appts.filter(a => a.scheduled_time && !isNaN(new Date(a.scheduled_time)));
  const apptLine = (a) => `${instantPT(a.scheduled_time)} — ${clip(a.purpose, 100)}` +
    `${a.scheduled_location ? `, at ${clip(a.scheduled_location, 100)}` : ""} [${APPT_STATUS[a.status] || words(a.status)}]`;

  // ── Billing ────────────────────────────────────────────────────────────
  const live = invs.filter(x => !DEAD_INVOICE.has(String(x.status || "").toLowerCase()));
  const isPaid = (x) => !!x.paid_at || String(x.status || "").toLowerCase() === "paid";
  const owing = live.filter(x => !isPaid(x)).sort((a, b) => new Date(a.due_date || a.created_at) - new Date(b.due_date || b.created_at));
  const paid = live.filter(isPaid).sort((a, b) => new Date(b.paid_at || 0) - new Date(a.paid_at || 0));
  const invLine = (x) => `${clip(x.description, 100)} — ${cents(x.amount_cents)}` +
    `${x.created_at ? `, issued ${dayPT(x.created_at)}` : ""}` +
    (isPaid(x)
      ? `, PAID${x.paid_at ? ` ${dayPT(x.paid_at)}` : ""}${x.paid_method ? ` by ${words(x.paid_method)}` : ""}`
      : `${x.due_date ? `, due ${calendarDay(x.due_date)}` : ", no due date set"}` +
        `${x.due_date && new Date(x.due_date).getTime() < t - 864e5 ? " (PAST DUE)" : ""}` +
        `${x.client_claim_paid_at ? `; the client reported paying it on ${dayPT(x.client_claim_paid_at)} — the firm has not confirmed receipt yet` : ""}`);

  const otherInvoices = [
    ...acctInvs.filter(x => !DEAD_INVOICE.has(String(x.status || "").toLowerCase())).map(x => {
      const bal = (Number(x.total_amount) || 0) - (Number(x.amount_paid) || 0);
      return `Invoice ${x.invoice_number || "(no number)"}${x.invoice_date ? ` dated ${calendarDay(x.invoice_date)}` : ""} — total ${usd(x.total_amount)}, ` +
        `paid ${usd(x.amount_paid)}, balance ${usd(bal)}${x.due_date && bal > 0 ? `, due ${calendarDay(x.due_date)}` : ""}${x.status ? ` [${words(x.status)}]` : ""}`;
    }),
    ...civilInvoices.map(x =>
      `Invoice ${x.invoice_number || "(no number)"}${x.invoice_date ? ` dated ${calendarDay(x.invoice_date)}` : ""}` +
      `${x.period_from && x.period_to ? `, for ${calendarDay(x.period_from)} to ${calendarDay(x.period_to)}` : ""} — ${usd(x.total_amount)}` +
      `${x.total_hours != null ? ` for ${Number(x.total_hours)} hours` : ""}${x.status ? ` [${words(x.status)}]` : ""}` +
      `${caseName(x.case_id) ? ` [${clip(caseName(x.case_id), 60)}]` : ""}`),
  ].slice(0, 12);

  const trustLine = (x) => `${calendarDay(x.transaction_date) || dayPT(x.created_at)} — ${x.txn_type === "deposit" ? "deposit" : "payment out"} of ${cents(x.amount_cents)}` +
    `${x.description ? `: ${clip(x.description, 90)}` : ""}`;
  const trustBalance = trust.length
    ? `${cents(trust[0].running_balance_cents)} as of the last entry on ${calendarDay(trust[0].transaction_date) || dayPT(trust[0].created_at)}`
    : (ledger.length ? `${usd(ledger[0].running_balance)} as of ${calendarDay(ledger[0].transaction_date)}` : null);

  const feeTerms = civil.map(c => {
    const bits = [
      c.billing_type ? `billing: ${words(c.billing_type)}` : null,
      c.hourly_rate != null ? `hourly rate ${usd(c.hourly_rate)}` : null,
      c.contingency_pct != null ? `contingency ${Number(c.contingency_pct)}%` : null,
      c.retainer_amount != null ? `retainer ${usd(c.retainer_amount)}` : null,
      c.retainer_balance != null ? `retainer balance ${usd(c.retainer_balance)}` : null,
    ].filter(Boolean);
    return bits.length ? `${clip(c.case_name || "Civil matter", 60)} — ${bits.join(", ")}` : null;
  }).filter(Boolean);

  const settlement = disbursements.map(d => [
    `Settlement statement${d.finalized_date ? ` finalized ${calendarDay(d.finalized_date)}` : ""}: gross ${usd(d.gross_settlement)}`,
    d.attorney_fee_amount != null ? `attorney fee ${usd(d.attorney_fee_amount)}${d.attorney_fee_pct != null ? ` (${Number(d.attorney_fee_pct)}%)` : ""}` : null,
    d.case_costs_total != null ? `case costs ${usd(d.case_costs_total)}` : null,
    d.medical_bills_total != null ? `medical bills ${usd(d.medical_bills_total)}` : null,
    d.liens_total != null ? `liens ${usd(d.liens_total)}` : null,
    d.other_deductions ? `other deductions ${usd(d.other_deductions)}` : null,
    `net to client ${usd(d.client_net_amount)}`,
    d.client_check_date ? `check dated ${calendarDay(d.client_check_date)}` : null,
  ].filter(Boolean).join("; "));

  // ── Documents and signatures ───────────────────────────────────────────
  const sigLine = (title, status, when) => `${clip(title, 100)} [${words(status)}${when ? ` ${dayPT(when)}` : ""}]`;
  const allSigs = [
    ...sigs.map(s => ({ pending: s.status === "pending", line: sigLine(s.title, s.status, s.signed_at) })),
    ...packets.map(p => ({ pending: p.status === "sent", line: sigLine(p.title, p.status === "sent" ? "waiting for signature" : p.status, p.completed_at || p.sent_at) })),
  ];

  // ── Messages ───────────────────────────────────────────────────────────
  const fromFirm = msgs.filter(m => m.sender_kind === "firm");
  const unread = fromFirm.filter(m => !m.read_at).length;

  const c0 = contact[0] || {};
  return {
    linked: true,
    name: displayName || (ident[0] && ident[0].client_name) || (tasks[0] && tasks[0].client_name) || null,
    a_number: (ident[0] && ident[0].a_number) || (tasks.find(x => x.a_number) || {}).a_number || null,
    case_types: uniq([...tasks.map(x => words(x.matter_type)), ...civil.map(() => "civil litigation"), ...pi.map(() => "personal injury"), ...federal.map(f => words(f.matter_type))]),

    contact_on_file: [
      (c0.phone || (acct && acct.phone)) ? `Phone: ${c0.phone || acct.phone}` : null,
      (c0.email || (acct && acct.email)) ? `Email: ${c0.email || acct.email}` : null,
      c0.address ? `Address: ${clip(c0.address, 140)}` : null,
    ].filter(Boolean),
    family_on_case: members.map(m => `${m.full_name}${m.relationship ? ` (${words(m.relationship)})` : ""}`),

    matters: [...civil.map(civilLine), ...federal.map(federalLine), ...pi.map(piLine), ...openTasks.slice(0, 10).map(taskLine)],
    completed_work: doneTasks.map(taskLine),
    team,
    consultant: cons ? `${cons.full_name}${cons.phone ? `, ${cons.phone}` : ""}${cons.email ? `, ${cons.email}` : ""}` : null,

    upcoming_hearings: hearings,
    noted_next_hearings: noted.map(n => `${hearingDay(n.next_hearing_date)}${n.next_hearing_type ? ` — ${n.next_hearing_type}` : ""}`),
    open_deadlines: deadlines,

    upcoming_appointments: scheduled.filter(a => future(a.scheduled_time, t)).sort((a, b) => new Date(a.scheduled_time) - new Date(b.scheduled_time)).map(apptLine),
    requested_appointments: appts.filter(a => !a.scheduled_time).map(a =>
      `${clip(a.purpose, 100)}${a.preferred_dates ? ` (they asked for: ${clip(a.preferred_dates, 80)})` : ""}` +
      `${a.fee_cents ? `, consultation fee ${cents(a.fee_cents)}${a.paid_at ? " paid" : " not yet paid"}` : ""} [${APPT_STATUS[a.status] || words(a.status)}]`),
    past_appointments: scheduled.filter(a => !future(a.scheduled_time, t)).sort((a, b) => new Date(b.scheduled_time) - new Date(a.scheduled_time)).slice(0, 3).map(apptLine),

    billing: {
      owing: owing.map(invLine),
      owing_total: owing.length ? cents(owing.reduce((s, x) => s + (Number(x.amount_cents) || 0), 0)) : null,
      paid: paid.slice(0, 8).map(invLine),
      paid_total: paid.length ? cents(paid.reduce((s, x) => s + (Number(x.amount_cents) || 0), 0)) : null,
      other_invoices: otherInvoices,
      trust_balance: trustBalance,
      trust_recent: trust.slice(0, 5).map(trustLine),
      fee_terms: feeTerms,
      settlement,
    },

    documents: docs.map(x => `${clip(x.filename, 100)}${x.category && x.category !== "other" ? ` (${words(x.category)})` : ""}` +
      `${x.uploaded_at ? ` — uploaded ${dayPT(x.uploaded_at)}` : ""}${x.uploaded_by && x.uploaded_by !== "client" ? " by the firm" : ""}`),
    signatures_pending: allSigs.filter(s => s.pending).map(s => s.line),
    signatures_done: allSigs.filter(s => !s.pending).slice(0, 6).map(s => s.line),

    messages: {
      unread,
      last_from_firm: fromFirm[0] ? dayPT(fromFirm[0].created_at) : null,
    },

    // Sections a client is likely to ask about are always reported, even when
    // empty, so Zara can say "nothing is owing" or "nothing is scheduled"
    // instead of sounding as if she cannot see.
    complete: true,
    today: now.toLocaleDateString("en-US", { timeZone: PT, ...LONG }),
    as_of: now.toLocaleString("en-US", { timeZone: PT }) + " PT",
    language,
  };
}

module.exports = { build, deadlinesFor, accountIdOf, instantPT, calendarDay, hearingDay, KEY_SQL };
