// ============================================================
//  TEZ LAW P.C. — MULTI-JURISDICTION DEADLINE ENGINE
//  ─────────────────────────────────────────────────────────
//  The original deadline logic hard-coded California CCP. TEZ
//  is going multi-state, and a California day count applied to
//  a New Jersey matter is not a cosmetic error — it is a missed
//  deadline.
//
//  This module separates three things the old code conflated:
//
//    1. DAY MATH — calendar vs court days, weekend/holiday
//       roll, and the direction a backward-counted deadline
//       rolls when it lands on a holiday.
//    2. SERVICE-METHOD EXTENSIONS — which differ per
//       jurisdiction and, critically, whether e-service adds
//       days at all (it does in Georgia; it does not in
//       federal, New York, Texas, Florida or New Jersey).
//    3. RULE SETS — the per-jurisdiction deadline rules.
//
//  Every rule carries its citation so a paralegal can verify it,
//  and rules the jurisdiction does not fix by rule are marked
//  `courtOrder: true` rather than being invented.
//
//  IMPORTANT LIMITS, stated rather than hidden:
//   · Local rules govern in many places. Pennsylvania motion
//     practice is county-specific; Florida's 2025 rules push
//     nearly everything onto the case management order; Illinois
//     motion notice is Cook County practice. Rules marked
//     `courtOrder` must be entered by hand from the scheduling
//     order — the engine will not guess them.
//   · The holiday table is the federal set plus per-state
//     additions. Individual courts close on days not listed.
//   · This computes dates. It is not legal advice and does not
//     replace reading the rule.
// ============================================================

// ── Holidays ────────────────────────────────────────────────
// Generated rather than hard-coded, so the engine does not
// silently stop working at the end of a table of literals.

function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + (n - 1) * 7));
}
function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month + 1, 0 - shift));
}
const iso = d => d.toISOString().slice(0, 10);

// A fixed-date holiday is observed Friday when it falls on a
// Saturday and Monday when it falls on a Sunday.
function observed(year, month, day) {
  const d = new Date(Date.UTC(year, month, day));
  const dow = d.getUTCDay();
  if (dow === 6) return iso(new Date(Date.UTC(year, month, day - 1)));
  if (dow === 0) return iso(new Date(Date.UTC(year, month, day + 1)));
  return iso(d);
}

function federalHolidays(year) {
  return new Set([
    observed(year, 0, 1),                                  // New Year's Day
    iso(nthWeekdayOfMonth(year, 0, 1, 3)),                 // MLK Jr. Day
    iso(nthWeekdayOfMonth(year, 1, 1, 3)),                 // Washington's Birthday
    iso(lastWeekdayOfMonth(year, 4, 1)),                   // Memorial Day
    observed(year, 5, 19),                                 // Juneteenth
    observed(year, 6, 4),                                  // Independence Day
    iso(nthWeekdayOfMonth(year, 8, 1, 1)),                 // Labor Day
    iso(nthWeekdayOfMonth(year, 9, 1, 2)),                 // Columbus Day
    observed(year, 10, 11),                                // Veterans Day
    iso(nthWeekdayOfMonth(year, 10, 4, 4)),                // Thanksgiving
    observed(year, 11, 25),                                // Christmas Day
  ]);
}

// State court closures beyond the federal set. Not exhaustive —
// individual courts close for local reasons — but these are the
// statewide ones that move deadlines.
const STATE_EXTRA_HOLIDAYS = {
  CA: y => [
    iso(new Date(Date.UTC(y, 2, 31))),                     // Cesar Chavez Day
    iso(nthWeekdayOfMonth(y, 10, 4, 4) === null ? "" : new Date(Date.UTC(
      y, 10, nthWeekdayOfMonth(y, 10, 4, 4).getUTCDate() + 1)).toISOString().slice(0, 10)), // Day after Thanksgiving
  ],
  NY: y => [
    observed(y, 1, 12),                                    // Lincoln's Birthday
    iso(nthWeekdayOfMonth(y, 10, 2, 1)),                   // Election Day
  ],
  TX: y => [
    observed(y, 2, 2),                                     // Texas Independence Day (courts vary)
  ],
  NV: y => [
    iso(lastWeekdayOfMonth(y, 9, 5)),                      // Nevada Day (last Friday in October)
    iso(new Date(Date.UTC(y, 10, nthWeekdayOfMonth(y, 10, 4, 4).getUTCDate() + 1))), // Family Day
  ],
  WA: y => [
    iso(new Date(Date.UTC(y, 10, nthWeekdayOfMonth(y, 10, 4, 4).getUTCDate() + 1))), // Day after Thanksgiving
  ],
};

const _holidayCache = new Map();
function holidaysFor(jurKey, year) {
  const ck = jurKey + ":" + year;
  if (_holidayCache.has(ck)) return _holidayCache.get(ck);
  const set = federalHolidays(year);
  const extra = STATE_EXTRA_HOLIDAYS[jurKey];
  if (extra) {
    try { extra(year).filter(Boolean).forEach(d => set.add(d)); }
    catch (e) { /* a bad generator must not break date math */ }
  }
  _holidayCache.set(ck, set);
  return set;
}

function isHoliday(jurKey, date) {
  return holidaysFor(jurKey, date.getUTCFullYear()).has(iso(date));
}
function isWeekend(date) {
  const d = date.getUTCDay();
  return d === 0 || d === 6;
}
function isCourtDay(jurKey, date) {
  return !isWeekend(date) && !isHoliday(jurKey, date);
}

// ── Jurisdictions ───────────────────────────────────────────
// `shortPeriodExcludesWeekends`: below this many days, the
// jurisdiction counts business days instead of calendar days.
// 0 means it never does.
// `backwardRoll`: where a backward-counted deadline goes when it
// lands on a non-court day. "earlier" is the near-universal
// practice; Washington CR 56(c) expressly rolls toward the
// hearing instead.

const JURISDICTIONS = [
  { key: "FED", label: "Federal (FRCP)", type: "federal", shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "CA",  label: "California",     type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "NY",  label: "New York",       type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "TX",  label: "Texas",          type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "FL",  label: "Florida",        type: "state",   shortPeriodExcludesWeekends: 7, backwardRoll: "earlier" },
  { key: "IL",  label: "Illinois",       type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "NJ",  label: "New Jersey",     type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "GA",  label: "Georgia",        type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "PA",  label: "Pennsylvania",   type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "AZ",  label: "Arizona",        type: "state",   shortPeriodExcludesWeekends: 11, backwardRoll: "earlier" },
  { key: "NV",  label: "Nevada",         type: "state",   shortPeriodExcludesWeekends: 0, backwardRoll: "earlier" },
  { key: "WA",  label: "Washington",     type: "state",   shortPeriodExcludesWeekends: 7, backwardRoll: "nearer_hearing" },
];
const JURISDICTION_KEYS = new Set(JURISDICTIONS.map(j => j.key));
const JUR_BY_KEY = new Map(JURISDICTIONS.map(j => [j.key, j]));
const DEFAULT_JURISDICTION = "CA";

function getJurisdiction(key) {
  return JUR_BY_KEY.get(String(key || "").toUpperCase()) || JUR_BY_KEY.get(DEFAULT_JURISDICTION);
}

// ── Service-method extensions ───────────────────────────────
// { days, unit } where unit is "calendar" or "court". The
// e-service row is the one that catches people out: most
// jurisdictions add nothing, California adds 2 COURT days, and
// Georgia adds 3 calendar days.
const SERVICE_METHODS = ["personal", "mail", "email", "efile", "overnight", "fax"];

const SERVICE_EXTENSIONS = {
  FED: { personal: 0, mail: { days: 3 }, email: 0, efile: 0, overnight: { days: 3 }, fax: { days: 3 },
         cite: "FRCP 6(d)", note: "Electronic service under Rule 5(b)(2)(E) gets no extra days (2016 amendment)." },
  CA:  { personal: 0, mail: { days: 5 }, email: { days: 2, unit: "court" }, efile: { days: 2, unit: "court" },
         overnight: { days: 2, unit: "court" }, fax: { days: 2, unit: "court" },
         cite: "CCP 1013; CCP 1010.6(a)(3)(B)",
         note: "Mail is +10 if served out of state within the U.S., +20 outside it. CCP 1005(b) adds 2 CALENDAR days for overnight/fax on noticed motions — a genuine statutory inconsistency with CCP 1013's 2 court days." },
  NY:  { personal: 0, mail: { days: 5 }, email: 0, efile: 0, overnight: { days: 1, unit: "court" }, fax: 0,
         cite: "CPLR 2103(b)", note: "+6 if mailed from outside NY but within the U.S. NYSCEF e-filing adds nothing." },
  TX:  { personal: 0, mail: { days: 3 }, email: 0, efile: 0, overnight: 0, fax: 0,
         cite: "TRCP 21a(c)", note: "Mail only. Electronic service, fax and commercial delivery add nothing." },
  FL:  { personal: 0, mail: { days: 5 }, email: 0, efile: 0, overnight: 0, fax: 0,
         cite: "Fla. R. Gen. Prac. & Jud. Admin. 2.514(b)", note: "Mail only. E-service adds nothing." },
  IL:  { personal: 0, mail: { days: 4 }, email: 0, efile: 0, overnight: { days: 3, unit: "court" }, fax: 0,
         cite: "Ill. S. Ct. R. 12(c)",
         note: "Illinois uses completion-of-service dates rather than added days: mail is complete 4 days after mailing, a commercial carrier on the 3rd court day." },
  NJ:  { personal: 0, mail: { days: 5 }, email: 0, efile: 0, overnight: 0, fax: 0,
         cite: "R. 1:3-3", note: "Raised from 3 to 5 days effective 4/1/2022. eCourts service adds nothing." },
  GA:  { personal: 0, mail: { days: 3 }, email: { days: 3 }, efile: { days: 3 }, overnight: 0, fax: 0,
         cite: "OCGA 9-11-6(e)", note: "Georgia is the outlier: it DOES add 3 days for e-mail service." },
  PA:  { personal: 0, mail: 0, email: 0, efile: 0, overnight: 0, fax: 0,
         cite: "Pa.R.C.P. 440(b)", note: "Pennsylvania adds NO days for any method; mail service is complete on mailing." },
  AZ:  { personal: 0, mail: { days: 5 }, email: { days: 5 }, efile: { days: 5 }, overnight: 0, fax: 0,
         cite: "Ariz. R. Civ. P. 6(c)", note: "+5 for mail, other consented means including electronic, and e-filing service providers." },
  NV:  { personal: 0, mail: { days: 3 }, email: 0, efile: 0, overnight: 0, fax: 0,
         cite: "NRCP 6(d)", note: "Electronic service adds nothing." },
  WA:  { personal: 0, mail: { days: 3 }, email: 0, efile: 0, overnight: 0, fax: 0,
         cite: "CR 6(e)", note: "Mail only. Electronic service is complete on transmission before 5 p.m. on a judicial day." },
};

function serviceExtension(jurKey, method) {
  const table = SERVICE_EXTENSIONS[String(jurKey || "").toUpperCase()] || SERVICE_EXTENSIONS[DEFAULT_JURISDICTION];
  const v = table[String(method || "personal").toLowerCase()];
  if (!v) return { days: 0, unit: "calendar" };
  if (typeof v === "number") return { days: v, unit: "calendar" };
  return { days: v.days || 0, unit: v.unit || "calendar" };
}

// ── Day math ────────────────────────────────────────────────

function parseDate(d) {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const s = String(d).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const t = new Date(d);
  return isNaN(t) ? null : new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

function addCalendar(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n));
}

// Step n court days in `dir` (+1 forward, -1 backward), skipping
// weekends and holidays as it counts.
function stepCourtDays(jurKey, date, n, dir) {
  let cur = date, left = Math.abs(n);
  while (left > 0) {
    cur = addCalendar(cur, dir);
    if (isCourtDay(jurKey, cur)) left--;
  }
  return cur;
}

// Roll a landing date off a weekend or holiday.
//  · forward-counted deadlines always roll forward
//  · backward-counted deadlines roll per the jurisdiction:
//    earlier (the norm) or toward the hearing (Washington)
function roll(jurKey, date, direction) {
  const jur = getJurisdiction(jurKey);
  const step = direction === "backward"
    ? (jur.backwardRoll === "nearer_hearing" ? 1 : -1)
    : 1;
  let cur = date;
  let guard = 0;
  while (!isCourtDay(jur.key, cur) && guard++ < 30) cur = addCalendar(cur, step);
  return cur;
}

/**
 * The core computation.
 *
 * from       — anchor date
 * n          — number of days
 * opts.unit  — "calendar" | "court"
 * opts.direction — "forward" | "backward"
 * opts.jurisdiction — jurisdiction key
 *
 * Applies the jurisdiction's short-period business-day rule
 * automatically: Arizona counts business days for anything under
 * 11 days, Florida and Washington for anything under 7.
 */
function computeDate(from, n, opts = {}) {
  const start = parseDate(from);
  if (!start) return null;
  const jurKey = getJurisdiction(opts.jurisdiction).key;
  const direction = opts.direction === "backward" ? "backward" : "forward";
  const dir = direction === "backward" ? -1 : 1;
  const jur = getJurisdiction(jurKey);

  let unit = opts.unit === "court" ? "court" : "calendar";
  // e.g. Ariz. R. Civ. P. 6(a)(1): periods of less than 11 days
  // exclude intermediate Saturdays, Sundays and legal holidays.
  if (unit === "calendar" && jur.shortPeriodExcludesWeekends &&
      Math.abs(n) > 0 && Math.abs(n) < jur.shortPeriodExcludesWeekends) {
    unit = "court";
  }

  if (unit === "court") return stepCourtDays(jurKey, start, n, dir);
  const landed = addCalendar(start, n * dir);
  // Texas's "Monday next after 20 days" IS the roll; rolling first to the next
  // court day and then snapping would push the answer a whole week late.
  return opts.noRoll ? landed : roll(jurKey, landed, direction);
}

/** Apply a service-method extension on top of a computed date. */
function applyServiceExtension(date, jurKey, method, direction = "forward") {
  const ext = serviceExtension(jurKey, method);
  if (!ext.days) return parseDate(date);
  return computeDate(date, ext.days, { unit: ext.unit, direction, jurisdiction: jurKey });
}

// ── Rule sets ───────────────────────────────────────────────
// Each rule: { key, label, cite, priority, stage, anchor, days,
//              unit, direction, appliesTo, reminder, courtOrder }
//
//  anchor      — the civil_cases column the count runs from
//  appliesTo   — "plaintiff" | "defendant" | undefined (both)
//  courtOrder  — true where the jurisdiction fixes no day count
//                and the date must come from the scheduling
//                order. These produce a REMINDER TO CALENDAR,
//                never an invented date.

const UNIVERSAL_RULES = [
  { key: "sol", label: "Statute of limitations expires — must file by this date",
    cite: "See limitations chapter for the cause of action", priority: "high",
    stage: "pre_filing", anchor: "statute_of_limitations", days: 0, reminder: 30 },
];

function r(o) { return Object.assign({ unit: "calendar", direction: "forward", reminder: 7, priority: "medium" }, o); }

const RULES = {
  FED: [
    r({ key: "responsive_pleading", label: "Answer or Rule 12 motion due (21 days after service)",
        cite: "FRCP 12(a)(1)(A)(i)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 21, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "service_deadline", label: "Serve the summons and complaint (90 days after filing)",
        cite: "FRCP 4(m)", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 90, appliesTo: "plaintiff", reminder: 15 }),
    r({ key: "initial_disclosures", label: "Initial disclosures due (14 days after the Rule 26(f) conference)",
        cite: "FRCP 26(a)(1)(C)", priority: "high", stage: "discovery",
        anchor: "rule26f_date", days: 14 }),
    r({ key: "expert_disclosure", label: "Expert disclosures due (90 days before trial, absent a scheduling order)",
        cite: "FRCP 26(a)(2)(D)(i)", priority: "high", stage: "trial_prep",
        anchor: "trial_date", days: 90, direction: "backward", reminder: 21 }),
    r({ key: "pretrial_disclosures", label: "Pretrial disclosures due (30 days before trial)",
        cite: "FRCP 26(a)(3)(B)", priority: "high", stage: "trial_prep",
        anchor: "trial_date", days: 30, direction: "backward", reminder: 10 }),
    r({ key: "msj_deadline", label: "Summary judgment due (30 days after the close of all discovery)",
        cite: "FRCP 56(b)", priority: "high", stage: "motions",
        anchor: "discovery_cutoff_date", days: 30 }),
    r({ key: "post_trial_motions", label: "New trial, renewed JML or alter/amend due (28 days after entry of judgment) — NOT extendable",
        cite: "FRCP 50(b), 52(b), 59(b), 59(e); 6(b)(2)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 28, reminder: 7 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after entry of judgment; 60 if the United States is a party)",
        cite: "FRAP 4(a)(1)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
    r({ key: "discovery_cutoff", label: "Discovery cutoff — set by the scheduling order, no default in the rules",
        cite: "FRCP 16(b)(3)(A)", priority: "high", stage: "discovery", courtOrder: true }),
  ],

  CA: [
    r({ key: "responsive_pleading", label: "Answer, demurrer or motion to strike due (30 days from service)",
        cite: "CCP 412.20(a)(3)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 30, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "service_deadline", label: "Serve the complaint and file proof of service (60 days after filing)",
        cite: "CRC 3.110(b)", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 60, appliesTo: "plaintiff", reminder: 10 }),
    r({ key: "service_outer_limit", label: "Three-year outer limit to serve — dismissal is MANDATORY",
        cite: "CCP 583.210, 583.250", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 1095, appliesTo: "plaintiff", reminder: 60 }),
    r({ key: "request_default", label: "Request entry of default (10 days after the response time ran)",
        cite: "CRC 3.110(g)", priority: "medium", stage: "pleadings",
        anchor: "service_date", days: 40, appliesTo: "plaintiff" }),
    r({ key: "discovery_opens_plaintiff", label: "Plaintiff may now propound written discovery (10 days after service)",
        cite: "CCP 2030.020(b), 2031.020(b), 2033.020(b)", priority: "low", stage: "discovery",
        anchor: "service_date", days: 10, appliesTo: "plaintiff", reminder: 0 }),
    r({ key: "deposition_notices_plaintiff", label: "Plaintiff may now serve deposition notices (20 days after service)",
        cite: "CCP 2025.210", priority: "low", stage: "discovery",
        anchor: "service_date", days: 20, appliesTo: "plaintiff", reminder: 0 }),
    r({ key: "cmc_meet_and_confer", label: "Meet and confer on CMC issues (30 calendar days before the CMC)",
        cite: "CRC 3.724", priority: "medium", stage: "pleadings",
        anchor: "cmc_date", days: 30, direction: "backward", reminder: 5 }),
    r({ key: "cmc_statement", label: "Case Management Statement due (15 court days before the CMC)",
        cite: "CRC 3.725", priority: "high", stage: "pleadings",
        anchor: "cmc_date", days: 15, unit: "court", direction: "backward", reminder: 5 }),
    r({ key: "expert_witness_exchange", label: "Expert witness exchange (50 days before the initial trial date)",
        cite: "CCP 2034.230(b)", priority: "high", stage: "trial_prep",
        anchor: "trial_date", days: 50, direction: "backward", reminder: 14 }),
    r({ key: "discovery_cutoff", label: "Discovery cutoff — no new discovery (30 days before the initial trial date)",
        cite: "CCP 2024.020(a)", priority: "high", stage: "discovery",
        anchor: "trial_date", days: 30, direction: "backward", reminder: 30 }),
    r({ key: "discovery_motions_cutoff", label: "Last day to HEAR discovery motions (15 days before trial)",
        cite: "CCP 2024.020(a)", priority: "high", stage: "discovery",
        anchor: "trial_date", days: 15, direction: "backward", reminder: 21 }),
    r({ key: "expert_discovery_cutoff", label: "Expert discovery cutoff (15 days before the initial trial date)",
        cite: "CCP 2024.030", priority: "high", stage: "trial_prep",
        anchor: "trial_date", days: 15, direction: "backward", reminder: 14 }),
    r({ key: "msj_hearing_deadline", label: "MSJ must be HEARD by this date (30 days before trial)",
        cite: "CCP 437c(a)(3)", priority: "high", stage: "motions",
        anchor: "trial_date", days: 30, direction: "backward", reminder: 30 }),
    r({ key: "msj_filing_deadline", label: "MSJ must be SERVED by this date (81 days' notice, heard 30 days before trial)",
        cite: "CCP 437c(a)(2)-(3) as amended 1/1/2025 (AB 2049)", priority: "high", stage: "motions",
        anchor: "trial_date", days: 111, direction: "backward", reminder: 30 }),
    r({ key: "section_998_offer_cutoff", label: "Last day to serve a CCP 998 offer to compromise",
        cite: "CCP 998(b)", priority: "medium", stage: "trial_prep",
        anchor: "trial_date", days: 10, direction: "backward", reminder: 14 }),
    r({ key: "motions_in_limine", label: "Motions in limine due (check the local rules)",
        cite: "Local rules; CCP 128(a)(8)", priority: "medium", stage: "trial_prep",
        anchor: "trial_date", days: 10, direction: "backward", reminder: 7 }),
    r({ key: "trial_brief", label: "Trial brief, jury instructions and verdict forms due (typical)",
        cite: "CRC 3.1548 and local rules", priority: "medium", stage: "trial_prep",
        anchor: "trial_date", days: 5, direction: "backward", reminder: 7 }),
    r({ key: "post_trial_motions", label: "Notice of intention to move for new trial / JNOV (15 days after notice of entry) — NOT extendable, and CCP 1013 does NOT apply",
        cite: "CCP 659(a),(b); 629(b)", priority: "high", stage: "post_trial",
        anchor: "judgment_notice_date", days: 15, reminder: 5 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (60 days after service of notice of entry)",
        cite: "CRC 8.104(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_notice_date", days: 60, reminder: 14 }),
  ],

  NY: [
    r({ key: "responsive_pleading", label: "Answer due (20 days if personally delivered in NY; 30 days for other methods)",
        cite: "CPLR 3012(a),(c); 320(a)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 30, appliesTo: "defendant" }),
    r({ key: "service_deadline", label: "Serve the summons and complaint (120 days after commencement)",
        cite: "CPLR 306-b", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 120, appliesTo: "plaintiff", reminder: 20 }),
    r({ key: "vacate_note_of_issue", label: "Move to vacate the note of issue (20 days after service)",
        cite: "22 NYCRR 202.21(e)", priority: "high", stage: "discovery",
        anchor: "note_of_issue_date", days: 20 }),
    r({ key: "msj_deadline", label: "Summary judgment due (no later than 120 days after the note of issue)",
        cite: "CPLR 3212(a); Brill v. City of New York", priority: "high", stage: "motions",
        anchor: "note_of_issue_date", days: 120, reminder: 21 }),
    r({ key: "post_trial_motions", label: "Post-trial motion due (15 days after the decision, verdict or discharge of the jury)",
        cite: "CPLR 4405", priority: "high", stage: "post_trial",
        anchor: "verdict_date", days: 15, reminder: 5 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after service of notice of entry, +5 if that was mailed)",
        cite: "CPLR 5513(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_notice_date", days: 30, reminder: 10 }),
    r({ key: "expert_disclosure", label: "Expert disclosure — NY fixes no date by rule; drive it off the PC or compliance order",
        cite: "CPLR 3101(d)(1)(i)", priority: "high", stage: "trial_prep", courtOrder: true }),
    r({ key: "discovery_cutoff", label: "Discovery closes on the note of issue, per the preliminary conference order",
        cite: "22 NYCRR 202.21", priority: "high", stage: "discovery", courtOrder: true }),
  ],

  TX: [
    r({ key: "responsive_pleading", label: "Answer due by 10:00 a.m. on the Monday after 20 days from service",
        cite: "TRCP 99(b),(c)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 20, appliesTo: "defendant", snapToMonday: true, serviceExtended: true }),
    r({ key: "initial_disclosures", label: "Initial disclosures due (30 days after the first answer or general appearance)",
        cite: "TRCP 194.2(a)", priority: "high", stage: "discovery",
        anchor: "answered_date", days: 30 }),
    r({ key: "discovery_period_l2", label: "Level 2 discovery period ends (earlier of 30 days before trial or 9 months after disclosures were due)",
        cite: "TRCP 190.3(b)(1)", priority: "high", stage: "discovery",
        anchor: "trial_date", days: 30, direction: "backward", reminder: 30 }),
    r({ key: "expert_designation_affirmative", label: "Expert designation — party seeking affirmative relief (90 days before the end of the discovery period)",
        cite: "TRCP 195.2(a)", priority: "high", stage: "trial_prep",
        anchor: "discovery_cutoff_date", days: 90, direction: "backward", reminder: 21 }),
    r({ key: "expert_designation_other", label: "Expert designation — all other parties (60 days before the end of the discovery period)",
        cite: "TRCP 195.2(b)", priority: "high", stage: "trial_prep",
        anchor: "discovery_cutoff_date", days: 60, direction: "backward", reminder: 21 }),
    r({ key: "post_trial_motions", label: "Motion for new trial due (30 days after the judgment is SIGNED, not entered)",
        cite: "TRCP 329b(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 7 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after the judgment is signed; 90 if a new-trial motion or findings request was filed)",
        cite: "TRAP 26.1", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
    r({ key: "service_deadline", label: "No fixed service deadline — but due diligence in service is required to relate back to the SOL",
        cite: "TRCP 99(a); Gant v. DeLeon", priority: "high", stage: "pleadings", courtOrder: true, appliesTo: "plaintiff" }),
  ],

  FL: [
    r({ key: "responsive_pleading", label: "Answer or Rule 1.140 motion due (20 days after service)",
        cite: "Fla. R. Civ. P. 1.140(a)(1)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 20, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "service_deadline", label: "Serve the complaint (120 days after filing) — dismissal is mandatory absent good cause",
        cite: "Fla. R. Civ. P. 1.070(j)", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 120, appliesTo: "plaintiff", reminder: 20 }),
    r({ key: "initial_disclosures", label: "Initial disclosures due (60 days after service of the complaint)",
        cite: "Fla. R. Civ. P. 1.280(a)(1), eff. 1/1/2025", priority: "high", stage: "discovery",
        anchor: "service_date", days: 60 }),
    r({ key: "case_management_order", label: "Case management order due (120 days after commencement or 30 days after service on the last defendant, whichever is first)",
        cite: "Fla. R. Civ. P. 1.200(d)(4)", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 120, reminder: 15 }),
    r({ key: "post_trial_motions", label: "Motion for new trial or rehearing due (15 days after the verdict or the filing of the judgment)",
        cite: "Fla. R. Civ. P. 1.530(b)", priority: "high", stage: "post_trial",
        anchor: "verdict_date", days: 15, reminder: 5 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after rendition)",
        cite: "Fla. R. App. P. 9.110(b), 9.020(i)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
    r({ key: "discovery_cutoff", label: "Discovery cutoff, expert disclosure and the MSJ deadline all come from the case management order",
        cite: "Fla. R. Civ. P. 1.200(d)(4), 1.510", priority: "high", stage: "discovery", courtOrder: true }),
  ],

  IL: [
    r({ key: "responsive_pleading", label: "Appearance and answer due (30 days after service)",
        cite: "Ill. S. Ct. R. 181(a), 101(d)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 30, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "discovery_cutoff", label: "Discovery closes (60 days before the anticipated trial date)",
        cite: "Ill. S. Ct. R. 218(c)", priority: "high", stage: "discovery",
        anchor: "trial_date", days: 60, direction: "backward", reminder: 30 }),
    r({ key: "post_trial_motions", label: "Post-trial motion due (30 days after entry of judgment) — must raise ALL grounds or they are waived",
        cite: "735 ILCS 5/2-1202(b),(c); 5/2-1203(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 7 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after final judgment, or after the last post-judgment motion is decided)",
        cite: "Ill. S. Ct. R. 303(a)(1)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
    r({ key: "service_deadline", label: "No fixed service deadline — Rule 103(b) requires REASONABLE DILIGENCE; dismissal is with prejudice if the lapse ran past the SOL",
        cite: "Ill. S. Ct. R. 103(b)", priority: "high", stage: "pleadings", courtOrder: true, appliesTo: "plaintiff" }),
  ],

  NJ: [
    r({ key: "responsive_pleading", label: "Answer due (35 days after service)",
        cite: "R. 4:6-1(a)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 35, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "issue_summons", label: "Summons must issue within 15 days of the Track Assignment Notice",
        cite: "R. 4:4-1", priority: "high", stage: "pleadings",
        anchor: "track_notice_date", days: 15, reminder: 5 }),
    r({ key: "discovery_end_track2", label: "Track II discovery period ends (300 days) — no extension once a trial or arbitration date is fixed",
        cite: "R. 4:24-1(a),(c)", priority: "high", stage: "discovery",
        anchor: "answered_date", days: 300, reminder: 45 }),
    r({ key: "msj_return", label: "Summary judgment must be returnable 30 days before trial; motion served 28 days before the return date",
        cite: "R. 4:46-1", priority: "high", stage: "motions",
        anchor: "trial_date", days: 58, direction: "backward", reminder: 21 }),
    r({ key: "post_trial_motions", label: "Motion for new trial or JNOV due (20 days after the verdict or announcement of conclusions)",
        cite: "R. 4:49-1(b); 4:40-2(b)", priority: "high", stage: "post_trial",
        anchor: "verdict_date", days: 20, reminder: 5 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (45 days after entry of final judgment)",
        cite: "R. 2:4-1(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 45, reminder: 14 }),
  ],

  GA: [
    r({ key: "responsive_pleading", label: "Answer due (30 days after service; 15 days after denial of a 12(b) motion)",
        cite: "OCGA 9-11-12(a)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 30, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "discovery_period", label: "Six-month discovery period ends (runs from the filing of the answer)",
        cite: "Unif. Super. Ct. R. 5.1", priority: "high", stage: "discovery",
        anchor: "answered_date", days: 180, reminder: 30 }),
    r({ key: "msj_service", label: "MSJ must be served 30 days before the hearing; response brief due 30 days after service",
        cite: "OCGA 9-11-56(c); USCR 6.2", priority: "high", stage: "motions",
        anchor: "trial_date", days: 60, direction: "backward", reminder: 21 }),
    r({ key: "post_trial_motions", label: "Motion for new trial or JNOV due (30 days after entry of judgment)",
        cite: "OCGA 5-5-40(a); 9-11-50(b)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 7 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after entry of the appealable judgment)",
        cite: "OCGA 5-6-38(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
  ],

  PA: [
    r({ key: "responsive_pleading", label: "Responsive pleading due (20 days after service, if endorsed with a Notice to Defend)",
        cite: "Pa.R.C.P. 1026(a)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 20, appliesTo: "defendant" }),
    r({ key: "service_deadline", label: "Serve original process (30 days after issuance of the writ or filing of the complaint)",
        cite: "Pa.R.C.P. 401(a)", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 30, appliesTo: "plaintiff", reminder: 7 }),
    r({ key: "post_trial_motions", label: "Post-trial motions due (10 days after the verdict, nonsuit or decision) — a SHORT window",
        cite: "Pa.R.C.P. 227.1(c)", priority: "high", stage: "post_trial",
        anchor: "verdict_date", days: 10, reminder: 3 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after entry of the order)",
        cite: "Pa.R.A.P. 903(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
    r({ key: "motion_practice", label: "Motion notice, briefing and the discovery cutoff are COUNTY-specific — calendar them from the local rule",
        cite: "Pa.R.C.P. 208.2, 208.3(a); 212.1-212.3", priority: "high", stage: "motions", courtOrder: true }),
  ],

  AZ: [
    r({ key: "responsive_pleading", label: "Answer due (20 days after service in Arizona; 30 days if served out of state)",
        cite: "Ariz. R. Civ. P. 12(a)(1)(A)(i); 4.2", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 20, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "service_deadline", label: "Serve the complaint (90 days after filing) — the court MUST dismiss without prejudice otherwise",
        cite: "Ariz. R. Civ. P. 4(i)", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 90, appliesTo: "plaintiff", reminder: 15 }),
    r({ key: "discovery_cutoff_tier2", label: "Tier 2 discovery deadline (180 days from the Early Meeting)",
        cite: "Ariz. R. Civ. P. 26.2(f)", priority: "high", stage: "discovery",
        anchor: "early_meeting_date", days: 180, reminder: 30 }),
    r({ key: "supplemental_disclosure_cutoff", label: "Disclosure later than 60 days before trial requires leave of court",
        cite: "Ariz. R. Civ. P. 26.1(f)(2)", priority: "high", stage: "trial_prep",
        anchor: "trial_date", days: 60, direction: "backward", reminder: 14 }),
    r({ key: "msj_deadline", label: "Summary judgment due (90 days before trial, absent a dispositive-motion deadline)",
        cite: "Ariz. R. Civ. P. 56(b)", priority: "high", stage: "motions",
        anchor: "trial_date", days: 90, direction: "backward", reminder: 21 }),
    r({ key: "post_trial_motions", label: "New trial, alter/amend or renewed JML due (15 days after entry of judgment) — NOT extendable",
        cite: "Ariz. R. Civ. P. 59(b)(1), 59(d), 50(b)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 15, reminder: 5 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after entry of the judgment)",
        cite: "ARCAP 9(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
  ],

  NV: [
    r({ key: "responsive_pleading", label: "Answer due (21 days after service)",
        cite: "NRCP 12(a)(1)(A)(i)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 21, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "service_deadline", label: "Serve the complaint (120 days after filing)",
        cite: "NRCP 4(e)(1)", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 120, appliesTo: "plaintiff", reminder: 20 }),
    r({ key: "early_case_conference", label: "Early case conference due (30 days after the first defendant answers)",
        cite: "NRCP 16.1(b)", priority: "high", stage: "discovery",
        anchor: "answered_date", days: 30, reminder: 7 }),
    r({ key: "expert_disclosure", label: "Expert disclosures due (90 days before the DISCOVERY CUTOFF, not before trial)",
        cite: "NRCP 16.1(a)(2)", priority: "high", stage: "trial_prep",
        anchor: "discovery_cutoff_date", days: 90, direction: "backward", reminder: 21 }),
    r({ key: "post_trial_motions", label: "New trial, alter/amend or renewed JML due (28 days after SERVICE OF WRITTEN NOTICE OF ENTRY)",
        cite: "NRCP 50(b), 59(b), 59(e)", priority: "high", stage: "post_trial",
        anchor: "judgment_notice_date", days: 28, reminder: 7 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after service of written notice of entry)",
        cite: "NRAP 4(a)(1)", priority: "high", stage: "post_trial",
        anchor: "judgment_notice_date", days: 30, reminder: 10 }),
  ],

  WA: [
    r({ key: "responsive_pleading", label: "Answer due (20 days after service; 60 days if served personally out of state or by publication)",
        cite: "CR 12(a)(1),(2)", priority: "high", stage: "pleadings",
        anchor: "service_date", days: 20, appliesTo: "defendant", serviceExtended: true }),
    r({ key: "service_filing_deadline", label: "File within 90 days of service, or serve within 90 days of filing",
        cite: "RCW 4.16.170", priority: "high", stage: "pleadings",
        anchor: "filed_date", days: 90, appliesTo: "plaintiff", reminder: 15 }),
    r({ key: "msj_motion", label: "Summary judgment filed and served (28 calendar days before the hearing)",
        cite: "CR 56(c)", priority: "high", stage: "motions",
        anchor: "msj_hearing_date", days: 28, direction: "backward", reminder: 14 }),
    r({ key: "msj_heard_by", label: "MSJ must be heard more than 14 days before trial, absent leave",
        cite: "CR 56(c)", priority: "high", stage: "motions",
        anchor: "trial_date", days: 14, direction: "backward", reminder: 21 }),
    r({ key: "post_trial_motions", label: "New trial, reconsideration, alter/amend or renewed JML due (10 days after entry) — a SHORT window",
        cite: "CR 59(b), 59(h), 50(b)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 10, reminder: 3 }),
    r({ key: "notice_of_appeal", label: "Notice of appeal due (30 days after entry of the decision)",
        cite: "RAP 5.2(a)", priority: "high", stage: "post_trial",
        anchor: "judgment_date", days: 30, reminder: 10 }),
    r({ key: "discovery_cutoff", label: "Discovery cutoff comes from the county case schedule (King County: 49 days before trial)",
        cite: "CR 16; KCLCR 26(b)", priority: "high", stage: "discovery", courtOrder: true }),
  ],
};

// Texas answers are due at 10:00 a.m. on the Monday after the
// 20th day, which is not a plain day count.
function snapToNextMonday(date) {
  const d = parseDate(date);
  if (!d) return null;
  const dow = d.getUTCDay();          // 0 Sun .. 6 Sat
  const shift = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  return addCalendar(d, shift);
}

/**
 * Compute every deadline a matter's jurisdiction generates.
 *
 * Returns { deadlines: [...], unresolved: [...] } where
 * `unresolved` lists rules that could not be computed — either
 * the anchor date is missing or the jurisdiction leaves the date
 * to the scheduling order. Those are surfaced to the user as
 * work to do, not silently dropped.
 */
function computeDeadlines(caseRow) {
  const c = caseRow || {};
  const jurKey = getJurisdiction(c.jurisdiction).key;
  const rules = [...UNIVERSAL_RULES.map(r => Object.assign({ unit: "calendar", direction: "forward", reminder: 7 }, r)),
                 ...(RULES[jurKey] || [])];
  const method = String(c.service_method || "personal").toLowerCase();

  const deadlines = [];
  const unresolved = [];

  for (const rule of rules) {
    if (rule.appliesTo && c.our_role && c.our_role !== rule.appliesTo) continue;

    if (rule.courtOrder) {
      unresolved.push({
        key: rule.key, label: rule.label, cite: rule.cite, stage: rule.stage,
        reason: "This jurisdiction sets no day count — calendar it from the scheduling or case management order.",
      });
      continue;
    }

    const anchorValue = c[rule.anchor];
    if (!anchorValue) {
      unresolved.push({
        key: rule.key, label: rule.label, cite: rule.cite, stage: rule.stage,
        reason: `Needs ${String(rule.anchor).replace(/_/g, " ")} on the matter.`,
        missingField: rule.anchor,
      });
      continue;
    }

    let due = computeDate(anchorValue, rule.days, {
      unit: rule.unit, direction: rule.direction, jurisdiction: jurKey,
      noRoll: !!rule.snapToMonday,
    });
    if (!due) continue;

    // Service-method extension, where the rule runs from service.
    if (rule.serviceExtended && method !== "personal") {
      due = applyServiceExtension(due, jurKey, method, rule.direction);
    }
    if (rule.snapToMonday) {
      due = snapToNextMonday(due);
      // If the Monday itself is a court holiday, TRCP 4 rolls forward.
      due = roll(jurKey, due, "forward");
    }

    deadlines.push({
      source_trigger: rule.key,
      due_date: iso(due),
      description: rule.label,
      ccp_rule: rule.cite,
      priority: rule.priority || "medium",
      reminder_days_before: rule.reminder != null ? rule.reminder : 7,
      stage: rule.stage,
      jurisdiction: jurKey,
    });
  }

  return { jurisdiction: jurKey, deadlines, unresolved };
}

// Anchor fields a matter can carry, beyond the ones the original
// schema had. Surfaced so the UI can prompt for exactly the date
// a jurisdiction needs rather than showing every field to everyone.
const ANCHOR_FIELDS = [
  { field: "filed_date",           label: "Filed" },
  { field: "service_date",         label: "Served" },
  { field: "answered_date",        label: "Answer filed" },
  { field: "statute_of_limitations", label: "Statute of limitations" },
  { field: "cmc_date",             label: "Case management conference" },
  { field: "trial_date",           label: "Trial" },
  { field: "judgment_date",        label: "Judgment entered / signed" },
  { field: "judgment_notice_date", label: "Notice of entry served" },
  { field: "verdict_date",         label: "Verdict / decision" },
  { field: "discovery_cutoff_date", label: "Discovery cutoff (from the scheduling order)" },
  { field: "rule26f_date",         label: "Rule 26(f) conference" },
  { field: "note_of_issue_date",   label: "Note of issue filed" },
  { field: "track_notice_date",    label: "Track assignment notice" },
  { field: "early_meeting_date",   label: "Early meeting / case conference" },
  { field: "msj_hearing_date",     label: "MSJ hearing" },
];

/**
 * Which lifecycle stage a stored deadline belongs to.
 *
 * The stage workspaces used to filter deadlines against a hard-coded list of
 * California rule keys, which would have hidden every federal or out-of-state
 * deadline the moment the firm took a matter outside California. Ask the
 * jurisdiction's own rule set instead.
 */
function stageForRule(jurKey, ruleKey) {
  const key = String(ruleKey || "");
  const all = [...UNIVERSAL_RULES, ...(RULES[getJurisdiction(jurKey).key] || [])];
  const found = all.find(r2 => r2.key === key);
  return found ? (found.stage || null) : null;
}

/** Every rule key this jurisdiction can generate for a given stage. */
function ruleKeysForStage(jurKey, stage) {
  const all = [...UNIVERSAL_RULES, ...(RULES[getJurisdiction(jurKey).key] || [])];
  return all.filter(r2 => r2.stage === stage).map(r2 => r2.key);
}

module.exports = {
  JURISDICTIONS, JURISDICTION_KEYS, DEFAULT_JURISDICTION, getJurisdiction,
  stageForRule, ruleKeysForStage,
  SERVICE_METHODS, SERVICE_EXTENSIONS, serviceExtension,
  RULES, UNIVERSAL_RULES, ANCHOR_FIELDS,
  computeDeadlines, computeDate, applyServiceExtension,
  isCourtDay, holidaysFor, federalHolidays, parseDate, snapToNextMonday,
};
