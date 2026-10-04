/**
 * client-record.js — what Zara is told about the signed-in client's own matter.
 *
 * One function, build(), keyed to ONE client account. It is the only case data
 * that reaches the model on the client surface (zara-app-chat gives a client
 * no database tools), so there is no path here to anyone else's record.
 *
 * WHY THIS IS ITS OWN FILE. The lookup used to sit inline in /api/client/chat
 * and failed on its first query for every client: a client token carries
 * uid "c<id>" (see issueClientToken), and that string was handed to
 * client_accounts.id, an integer column. Postgres refused it, the catch
 * swallowed the error, and Zara was told the client had no record — so she
 * answered "that's specific to your case" to a client whose appointment was
 * sitting in the database. Nothing tested it, because the route's tests stub
 * the database. Pulled out here it can be run against a real one
 * (scripts/check-client-record.js).
 *
 * Two more things were wrong in the inline version, each enough on its own:
 *   · it selected client_accounts.language, a column that does not exist
 *     (the column is preferred_lang), so the first query failed even with a
 *     good id;
 *   · it read "upcoming hearings" from the hearing-NOTES profile, where every
 *     entry is a hearing that has already happened and `deadlines` is always
 *     an empty array.
 *
 * Hearings now come from client_hearing_notices — the same table the My Case
 * screen reads, so Zara and the screen beside her agree — plus the "next
 * hearing" date the attorney recorded in the hearing notes.
 *
 * DEADLINES ARE DELIBERATELY NOT HERE. The deadlines table has no client_key
 * column (it is keyed by name and A-number), so neither this chat nor My Case
 * has ever shown a client a deadline. Its descriptions are written by staff
 * for staff. Whether clients should see them is JJ's call, not a side effect
 * of a bug fix — see deadlinesFor() below, exported but not used by build().
 *
 * Every lookup degrades to "nothing found" rather than failing the chat.
 */

// A client token's uid is "c<id>" so a client can never be mistaken for the
// staff user with the same number. Every integer column wants the number.
function accountIdOf(uid) {
  const n = parseInt(String(uid == null ? "" : uid).replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const PT = "America/Los_Angeles";

// A true instant (TIMESTAMPTZ set by staff), shown in Pacific time WITH the
// time of day — "when is my appointment" is a question about the hour.
function instantPT(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return null;
  const day = d.toLocaleDateString("en-US", { timeZone: PT, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit" });
  return `${day} at ${time} Pacific time`;
}

// A DATE column. node-pg builds it at local midnight, so read it back with
// local getters — never through UTC, which can land on the day before.
function calendarDay(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).length <= 10 ? `${v}T12:00:00` : v);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

// A hearing notice's date. hearing-notices.js stores the wall-clock date and
// time read off the notice without a zone, so the DATE is read in UTC (what it
// was stored as) and the TIME comes from the notice's own text, not from a
// zone conversion that could shift it.
function hearingDay(v) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return null;
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

// client_key as SQL, from a row's a_number and client_name — the same rule as
// client-profiles.clientKey(), so rows in tables that carry no client_key
// (hearing notes, deadlines) can be matched to one client.
const KEY_SQL = `CASE WHEN COALESCE(a_number, '') <> ''
       THEN 'a-' || regexp_replace(lower(a_number), '[^a-z0-9_]', '', 'g')
       ELSE 'n-' || trim(both '-' from regexp_replace(lower(trim(COALESCE(client_name, ''))), '[^a-z0-9_]+', '-', 'g'))
  END`;

const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

const APPT_STATUS = {
  awaiting_payment: "requested — consultation fee not yet paid, so no time has been set",
  paid_pending: "requested and paid — the office has not set the time yet",
  confirmed: "confirmed",
};

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
  const rows = (sql, params) => db.query(sql, params).then(r => r.rows).catch(e => {
    console.warn("[client-record]", e.message);
    return [];
  });

  let acct = null;
  if (accountId) {
    // SELECT * on purpose: naming a column this table does not have is what
    // broke the lookup before.
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

  const [hearings, noted, appts, docs, invs, ident, matters] = await Promise.all([
    rows(
      `SELECT hearing_date, hearing_time_text, hearing_type, court_name, court_address, judge_name
         FROM client_hearing_notices
        WHERE client_key = $1 AND dismissed_at IS NULL AND hearing_date >= CURRENT_DATE
        ORDER BY hearing_date ASC LIMIT 5`, [ck]),
    // "Next hearing" as the attorney wrote it down after the last one.
    rows(
      `SELECT next_hearing_date, next_hearing_type FROM (
         SELECT next_hearing_date, next_hearing_type, a_number, client_name FROM hearing_notes
         UNION ALL
         SELECT next_hearing_date, next_hearing_type, a_number, client_name FROM individual_hearing_notes
       ) n
        WHERE next_hearing_date >= CURRENT_DATE AND ${KEY_SQL} = $1
        ORDER BY next_hearing_date ASC LIMIT 5`, [ck]),
    rows(
      `SELECT purpose, status, scheduled_time, scheduled_location, preferred_dates, created_at
         FROM appointments
        WHERE client_key = $1 AND cancelled_at IS NULL AND status <> 'cancelled'
        ORDER BY COALESCE(scheduled_time, created_at) DESC LIMIT 20`, [ck]),
    rows(
      `SELECT filename, category, uploaded_at
         FROM client_documents
        WHERE client_key = $1
        ORDER BY uploaded_at DESC LIMIT 8`, [ck]),
    rows(
      `SELECT description, amount_cents, due_date, status
         FROM client_invoices
        WHERE client_key = $1 AND paid_at IS NULL
          AND status NOT IN ('paid', 'void', 'voided', 'cancelled')
        ORDER BY COALESCE(due_date, created_at::date) ASC LIMIT 8`, [ck]),
    rows(
      `SELECT client_name, a_number FROM client_hearing_notices
        WHERE client_key = $1 ORDER BY created_at DESC LIMIT 1`, [ck]),
    rows(
      `SELECT DISTINCT matter_type, client_name FROM tasks
        WHERE client_key = $1 AND matter_type IS NOT NULL LIMIT 6`, [ck]),
  ]);

  const t = now.getTime();
  const scheduled = appts.filter(a => a.scheduled_time && !isNaN(new Date(a.scheduled_time)));
  const upcoming = scheduled
    .filter(a => new Date(a.scheduled_time).getTime() >= t)
    .sort((a, b) => new Date(a.scheduled_time) - new Date(b.scheduled_time));
  const past = scheduled
    .filter(a => new Date(a.scheduled_time).getTime() < t)
    .sort((a, b) => new Date(b.scheduled_time) - new Date(a.scheduled_time))
    .slice(0, 3);
  const requested = appts.filter(a => !a.scheduled_time);

  const apptLine = (a) =>
    `${instantPT(a.scheduled_time)} — ${a.purpose}` +
    `${a.scheduled_location ? `, at ${a.scheduled_location}` : ""}` +
    ` [${APPT_STATUS[a.status] || a.status}]`;

  return {
    linked: true,
    name: displayName || (ident[0] && ident[0].client_name) || (matters[0] && matters[0].client_name) || null,
    a_number: (ident[0] && ident[0].a_number) || null,
    case_types: [...new Set(matters.map(m => m.matter_type).filter(Boolean))],

    upcoming_hearings: hearings.map(h =>
      `${hearingDay(h.hearing_date)}` +
      `${h.hearing_time_text ? ` at ${h.hearing_time_text}` : ""}` +
      `${h.hearing_type ? ` — ${h.hearing_type}` : ""}` +
      `${h.court_name ? `, ${h.court_name}` : ""}` +
      `${h.court_address ? ` (${h.court_address})` : ""}` +
      `${h.judge_name ? `, before ${h.judge_name}` : ""}`),

    noted_next_hearings: noted.map(n =>
      `${hearingDay(n.next_hearing_date)}${n.next_hearing_type ? ` — ${n.next_hearing_type}` : ""}`),

    upcoming_appointments: upcoming.map(apptLine),
    requested_appointments: requested.map(a =>
      `${a.purpose}` +
      `${a.preferred_dates ? ` (they asked for: ${a.preferred_dates})` : ""}` +
      ` [${APPT_STATUS[a.status] || a.status}]`),
    past_appointments: past.map(apptLine),

    documents: docs.map(x =>
      `${x.filename}${x.category ? ` (${x.category})` : ""}` +
      `${x.uploaded_at ? ` — uploaded ${instantPT(x.uploaded_at).split(" at ")[0]}` : ""}`),

    invoices: invs.map(x =>
      `${x.description} — ${money(x.amount_cents)}` +
      `${x.due_date ? `, due ${calendarDay(x.due_date)}` : ""}${x.status ? ` [${x.status}]` : ""}`),

    // The three things a client asks "when is my next…" about are always
    // reported, even when empty, so Zara can say "nothing is scheduled"
    // instead of sounding as if she cannot see.
    complete: true,
    today: now.toLocaleDateString("en-US", { timeZone: PT, weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    as_of: now.toLocaleString("en-US", { timeZone: PT }) + " PT",
    language,
  };
}

// This client's pending deadlines. NOT called by build() — see the note at
// the top. Here so that turning it on later is one line, with the matching
// already right.
async function deadlinesFor(db, clientKey) {
  if (!clientKey) return [];
  const r = await db.query(
    `SELECT description, due_date, priority FROM deadlines
      WHERE status = 'pending' AND ${KEY_SQL} = $1
      ORDER BY due_date ASC LIMIT 8`, [clientKey]).catch(() => ({ rows: [] }));
  return r.rows.map(d => `${d.description}${d.due_date ? ` — due ${calendarDay(d.due_date)}` : ""}`);
}

module.exports = { build, deadlinesFor, accountIdOf, instantPT, calendarDay, hearingDay, KEY_SQL };
