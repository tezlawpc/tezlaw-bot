// ============================================================
//  hearing-prefill.js — what a new hearing note already knows
//                       about the client
//  ─────────────────────────────────────────────────────────
//  "when creating hearings from client's profile, automatically pull
//   client's information." (JJ, 2026-10-08)
//
//  The two "+ New Hearing" buttons on a client profile already carried
//  ?prefill_a and ?prefill_name, and neither route read them, so staff
//  retyped the name, the A-Number, the email, the phone, the address, the
//  language, the case type and the judge for a client already on file.
//
//  WHAT IS PULLED, AND WHAT IS NOT
//  Two different kinds of fact live on a hearing note:
//
//    about the CLIENT      name, A-Number, contact details, language
//                          — these do not change between hearings, and
//                            come from the client record
//    about THIS HEARING    the date, the time, the type, what happened
//                          — these come from the notice and the hearing
//                            itself, and are never guessed
//
//  Everything prefilled here is in the first group, plus three that sit
//  between the two: the case type, the judge and the court. Those belong
//  to the case rather than to the sitting, but they do move — a venue
//  change, a reassignment — so they are taken from the most recent hearing
//  that recorded one and the banner says which hearing that was, by date.
//  A prefilled judge nobody checked is worse than an empty box.
//
//  THE DATE IS NEVER PREFILLED
//  Not the hearing date, not the next hearing date, not a time. See the
//  header of court-calendar.js: a date with no zone is the date on the
//  paper. There is no paper yet for a hearing being created, so there is
//  no date to carry over, and a plausible one in the box is how a client
//  gets told the wrong day.
// ============================================================

// Straight across from the client record. These are the client, not the
// hearing, and the aggregate has already overlaid stored contact details
// on top of whatever a note happened to say.
const CLIENT_FIELDS = [
  ["client_name",     "Name"],
  ["a_number",        "A-Number"],
  ["client_email",    "Email"],
  ["client_phone",    "Phone"],
  ["client_address",  "Address"],
  ["client_language", "Language"],
];

// Belong to the case, but can move. Taken from the most recent hearing
// that recorded one, and shown in the banner with that hearing's date.
// `court_location` and `court_address` exist only on the individual form.
const CASE_FIELDS = {
  master:     [["case_type", "Case type"], ["judge_name", "Judge"]],
  individual: [["case_type", "Case type"], ["judge_name", "Judge"],
               ["court_location", "Court"], ["court_address", "Court address"]],
};

// Never carried over, whatever the client record holds. Listed so the
// intent survives a later edit to this file.
const NEVER = [
  "hearing_date", "hearing_time", "hearing_type",
  "next_hearing_date", "next_hearing_type",
  "disposition", "disposition_notes", "raw_notes",
  "applications", "pleadings_method", "client_attendance",
  "removability_conceded", "bond_amount", "bond_outcome",
];

const isSet = (v) => v !== null && v !== undefined && String(v).trim() !== "";

/**
 * The date a hearing row is filed under, for the banner. Display only.
 *
 * Two different kinds of value can arrive here and they are read
 * differently — see the header of court-calendar.js, and storedDay() there,
 * which this follows:
 *
 *   hearing_date  the date on the notice, stored at midnight UTC. It is a
 *                 date on paper, not an instant, so it is read in UTC and
 *                 NEVER converted. Converting it to Pacific names the day
 *                 before, every time.
 *   created_at    a real instant, when someone opened the note. Read in the
 *                 firm's zone, because UTC names tomorrow from 5pm Pacific.
 */
function hearingDay(h) {
  if (!h) return null;
  if (h.hearing_date) {
    const d = new Date(h.hearing_date);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  if (!h.created_at) return null;
  const d = new Date(h.created_at);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/**
 * Build the `prev` a hearing form wants from a client profile aggregate.
 *
 * `client` is what client-profiles.getClientByKey returns, or null. A null
 * client gives an empty prefill and no banner: the form opens blank, which
 * is what it did before this existed.
 *
 * Returns { prev, filled, source }:
 *   prev    what to hand renderNoteForm / renderForm
 *   filled  [{ field, label, value, from }] — what was put in, and from
 *           which hearing, so the banner can say so
 *   source  { key, name, hearing_count } or null
 */
function prefillFromClient(client, { form = "individual" } = {}) {
  if (!client) return { prev: {}, filled: [], source: null };

  const prev = {};
  const filled = [];

  for (const [field, label] of CLIENT_FIELDS) {
    if (!isSet(client[field])) continue;
    prev[field] = client[field];
    filled.push({ field, label, value: String(client[field]), from: null });
  }

  // The case fields: the most recent hearing that recorded one. hearings is
  // already sorted newest first by the aggregate.
  const hearings = Array.isArray(client.hearings) ? client.hearings : [];
  for (const [field, label] of (CASE_FIELDS[form] || CASE_FIELDS.individual)) {
    const hit = hearings.find((h) => isSet(h[field]));
    if (!hit) continue;
    prev[field] = hit[field];
    filled.push({ field, label, value: String(hit[field]), from: hearingDay(hit) });
  }

  for (const f of NEVER) delete prev[f];

  return {
    prev,
    filled,
    source: { key: client.key, name: client.client_name || null, hearing_count: hearings.length },
  };
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The banner above a prefilled form.
 *
 * Says what was filled in and where it came from, because a form that
 * quietly fills itself gets signed off unread. Plain HTML: no inline
 * script, no onclick — see notify-admin.js:11 on what an apostrophe in an
 * attribute does to these pages.
 */
function prefillBanner({ filled = [], source = null } = {}) {
  if (!source || !filled.length) return "";

  const fromCase = filled.filter((f) => f.from);
  const rows = filled.map((f) => `
        <div style="font-size:12px; color:#2B2523;">
          <span style="color:#5E5854;">${escapeHtml(f.label)}:</span>
          ${escapeHtml(f.value.length > 70 ? f.value.slice(0, 70) + "…" : f.value)}${
    f.from ? ` <span style="color:#5E5854;">(from the hearing of ${escapeHtml(f.from)})</span>` : ""}
        </div>`).join("");

  return `
    <div style="background:#FAF8F5; border-left:4px solid #FF7B00; padding:15px 20px; margin:15px 0; border-radius:4px;">
      <div style="font-weight:600; color:#2B2523; margin-bottom:4px;">
        Filled in from ${escapeHtml(source.name || "the client record")}
      </div>
      <div style="font-size:12px; color:#5E5854; margin-bottom:10px;">
        The hearing date, time and type are not filled in: those come from the notice.${
    fromCase.length
      ? " Check the case fields below against today's notice — a judge or a court can change between hearings."
      : ""}
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:4px 20px;">${rows}
      </div>
      <div style="margin-top:10px; font-size:12px;">
        <a href="/admin/clients/${encodeURIComponent(source.key)}" style="color:#A34C00;">← back to the client file</a>
      </div>
    </div>`;
}

/**
 * Resolve the client a hearing-form request is for.
 *
 * `?client=<key>` is what the profile buttons send. `?prefill_a` and
 * `?prefill_name` are what older links send, and are kept working: they
 * are turned into the same key the profile page uses.
 */
async function clientFromQuery(query = {}) {
  const CP = require("./client-profiles");
  const key = query.client
    || CP.clientKey({ aNumber: query.prefill_a, clientName: query.prefill_name });
  if (!key) return null;
  try {
    return await CP.getClientByKey(key);
  } catch (err) {
    // A failure here must leave a usable blank form, not a 500. Staff at a
    // courthouse opening this on a phone need the form more than they need
    // the prefill.
    console.warn("[hearing-prefill] could not load", key, err.message);
    return null;
  }
}

/** Both halves at once: what a GET route needs. */
async function forRequest(query = {}, { form = "individual" } = {}) {
  const client = await clientFromQuery(query);
  const out = prefillFromClient(client, { form });
  return { ...out, banner: prefillBanner(out) };
}

module.exports = {
  prefillFromClient, prefillBanner, clientFromQuery, forRequest,
  CLIENT_FIELDS, CASE_FIELDS, NEVER,
};
