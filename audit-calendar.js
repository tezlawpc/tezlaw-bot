// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-calendar.js — FISCAL CALENDAR & STATUTORY DEADLINES
//  ─────────────────────────────────────────────────────────
//  Everything date-related lives here so no other module has to
//  know that Nightfood's fiscal year ends JUNE 30.
//
//  What this computes:
//    · Fiscal years, quarters and months for a June-30 FYE
//    · Form 10-K / 10-Q due dates for a NON-ACCELERATED filer
//      (90 / 45 days) with Rule 0-3 business-day rolling
//    · Rule 12b-25 extended dates (15 calendar days annual,
//      5 calendar days quarterly) and the 1-business-day NT window
//    · Form 10-K General Instruction G(3) 120-day Part III date
//    · Rule 12b-2 filer-status measurement date (last business
//      day of the second fiscal quarter = last business day of Dec)
//    · The AS 1215.15 documentation completion date — 14 DAYS
//      after report release, not the old 45
//    · The AS 1215.14 seven-year retention expiry
//    · Form 8-K / 8-K/A four-business-day and 71-calendar-day clocks
//    · US federal holidays, computed not tabled, so this keeps
//      working after 2030 without maintenance
//
//  VERIFY-BEFORE-RELYING: deadline computations here are derived
//  from the rules cited, not quoted from a filing. Treat them as
//  a working calendar, not legal advice. Securities counsel
//  (Sichenzia Ross Ference Carmel) owns the filing calendar.
// ============================================================

// ── The fiscal calendar comes from the issuer profile ───────
//
// These were constants describing one company. They are now read
// from the saved issuer profile, so a December-31 accelerated filer
// gets correct dates without a code change. The fallbacks are
// Nightfood's own values, which keeps every existing call site
// behaving identically until a profile is saved.
//
// Read through functions rather than captured at load: the profile
// can be edited while the process is running, and a stale fiscal
// year end would silently misdate an entire engagement.
const issuer = require("./audit-issuer");

function activeProfile() {
  try {
    return issuer.current();
  } catch (err) {
    return null;
  }
}
function FYE_MONTH_OF(profile) {
  const p = profile || activeProfile();
  return (p && Number(p.fiscalYearEndMonth)) || 6;
}
function FYE_DAY_OF(profile) {
  const p = profile || activeProfile();
  return (p && Number(p.fiscalYearEndDay)) || 30;
}
function FILER_STATUS_OF(profile) {
  const p = profile || activeProfile();
  return (p && p.filerStatus) || "non_accelerated";
}

const DEADLINE_DAYS = {
  non_accelerated: { annual: 90, quarterly: 45 },
  accelerated: { annual: 75, quarterly: 40 },
  large_accelerated: { annual: 60, quarterly: 40 },
};

// ── Date primitives (all UTC-normalized to avoid TZ drift) ──

function d(y, m, day) {
  return new Date(Date.UTC(y, m - 1, day));
}
function iso(dt) {
  return dt.toISOString().slice(0, 10);
}

/**
 * Normalize ANY date-ish value to a 'YYYY-MM-DD' string.
 *
 * node-postgres returns SQL DATE columns as JavaScript Date objects,
 * so String(row.filing_due_date).slice(0,10) yields "Mon Nov 16" —
 * not a date. Every place a DB date is rendered or compared as text
 * must go through here instead.
 */
function dstr(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) {
    if (isNaN(v)) return "";
    // node-postgres builds a LOCAL-midnight Date for a DATE column, not
    // a UTC-midnight one. Reading the UTC parts therefore shifts the
    // date back a day on any server east of Greenwich: a stored
    // 2026-10-29 comes back as 2026-10-28 in Asia/Tokyo. Because every
    // date in this module funnels through here, that one line would
    // have moved filing deadlines, the AS 1215.15 completion date and
    // the AS 1215.14 retention expiry silently and all at once.
    // Local getters read back exactly what was stored, in every zone.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d2 = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d2}`;
  }
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const parsed = new Date(s);
  if (isNaN(parsed)) return "";
  const y = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}
function parse(s) {
  // A Date from node-postgres is LOCAL midnight — read local parts, then
  // re-anchor to UTC midnight so all internal arithmetic stays TZ-free.
  if (s instanceof Date) {
    if (isNaN(s)) return null;
    return new Date(Date.UTC(s.getFullYear(), s.getMonth(), s.getDate()));
  }
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return d(+m[1], +m[2], +m[3]);
}
function addDays(dt, n) {
  const x = new Date(dt.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function lastDayOfMonth(y, m) {
  return d(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}
function nthWeekdayOfMonth(y, m, weekday, n) {
  // weekday: 0=Sun..6=Sat
  const first = d(y, m, 1);
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return addDays(first, shift + (n - 1) * 7);
}
function lastWeekdayOfMonth(y, m, weekday) {
  const last = lastDayOfMonth(y, m);
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -shift);
}

// ── US federal holidays, computed ───────────────────────────
// Observance rule: a holiday on Saturday is observed Friday, on
// Sunday observed Monday (5 U.S.C. 6103).
function federalHolidays(year) {
  const fixed = [
    d(year, 1, 1),   // New Year's Day
    d(year, 6, 19),  // Juneteenth
    d(year, 7, 4),   // Independence Day
    d(year, 11, 11), // Veterans Day
    d(year, 12, 25), // Christmas
  ].map(observed);

  const floating = [
    nthWeekdayOfMonth(year, 1, 1, 3),   // MLK — 3rd Monday Jan
    nthWeekdayOfMonth(year, 2, 1, 3),   // Washington's Birthday — 3rd Monday Feb
    lastWeekdayOfMonth(year, 5, 1),     // Memorial Day — last Monday May
    nthWeekdayOfMonth(year, 9, 1, 1),   // Labor Day — 1st Monday Sep
    nthWeekdayOfMonth(year, 10, 1, 2),  // Columbus Day — 2nd Monday Oct
    nthWeekdayOfMonth(year, 11, 4, 4),  // Thanksgiving — 4th Thursday Nov
  ];

  // Dec 31 observance of a Jan 1 that falls on Saturday belongs to
  // the prior year's calendar — include it so year-end rolls work.
  const prevNewYear = observed(d(year + 1, 1, 1));
  const extra = prevNewYear.getUTCFullYear() === year ? [prevNewYear] : [];

  return new Set([...fixed, ...floating, ...extra].map(iso));

  function observed(dt) {
    const dow = dt.getUTCDay();
    if (dow === 6) return addDays(dt, -1);
    if (dow === 0) return addDays(dt, 1);
    return dt;
  }
}

const _holidayCache = {};
function holidaySet(year) {
  if (!_holidayCache[year]) _holidayCache[year] = federalHolidays(year);
  return _holidayCache[year];
}

function isBusinessDay(dt) {
  const dow = dt.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !holidaySet(dt.getUTCFullYear()).has(iso(dt));
}

// Rule 0-3: a due date on a Saturday, Sunday or federal holiday
// rolls FORWARD to the next business day.
function rollForward(dt) {
  let x = dt;
  let guard = 0;
  while (!isBusinessDay(x) && guard++ < 30) x = addDays(x, 1);
  return x;
}
function addBusinessDays(dt, n) {
  let x = dt;
  let left = n;
  let guard = 0;
  while (left > 0 && guard++ < 400) {
    x = addDays(x, 1);
    if (isBusinessDay(x)) left--;
  }
  return x;
}
function businessDaysBetween(a, b) {
  let x = a;
  let n = 0;
  let guard = 0;
  while (iso(x) < iso(b) && guard++ < 4000) {
    x = addDays(x, 1);
    if (isBusinessDay(x)) n++;
  }
  return n;
}

// ── Fiscal year / period math for a June-30 FYE ─────────────
// Convention: FY2027 = July 1, 2026 → June 30, 2027.
// So a date's fiscal year is calendar year + 1 for Jul–Dec.

function fiscalYearOf(dateLike) {
  const dt = parse(dateLike);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  return m > FYE_MONTH_OF() ? y + 1 : y;
}

function fiscalYearBounds(fy) {
  const m = FYE_MONTH_OF();
  // A December year end wraps: FY2027 starts 1 January 2027, not
  // month 13 of 2026.
  const startMonth = m === 12 ? 1 : m + 1;
  const startYear = m === 12 ? fy : fy - 1;
  return { start: d(startYear, startMonth, 1), end: d(fy, m, FYE_DAY_OF()) };
}

// Quarter ends for a June-30 FYE:
//   Q1 = Sep 30 (FY-1)   Q2 = Dec 31 (FY-1)
//   Q3 = Mar 31 (FY)     Q4/FY = Jun 30 (FY)
function quarterEnds(fy) {
  // Derived from the profile's fiscal year end rather than fixed to
  // June: Q4 ends on the year end, and each earlier quarter three
  // months before the next.
  return issuer.quarterEndsFor(activeProfile(), fy);
}

function quarterOf(dateLike) {
  const dt = parse(dateLike);
  const fy = fiscalYearOf(dt);
  const qs = quarterEnds(fy);
  for (const q of qs) if (iso(dt) <= iso(q.end)) return { fiscalYear: fy, quarter: q.q, end: q.end };
  return { fiscalYear: fy, quarter: 4, end: qs[3].end };
}

// The 12 fiscal months of a fiscal year, in order (Jul → Jun).
function fiscalMonths(fy) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const cal = FYE_MONTH_OF() + 1 + i;
    const y = cal > 12 ? fy : fy - 1;
    const m = cal > 12 ? cal - 12 : cal;
    const end = lastDayOfMonth(y, m);
    out.push({
      fiscalYear: fy,
      fiscalMonth: i + 1,
      calendarYear: y,
      calendarMonth: m,
      end,
      label: `M${String(i + 1).padStart(2, "0")}-${iso(end)}`,
      name: end.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      quarter: quarterOf(end).quarter,
      isQuarterEnd: [3, 6, 9, 12].includes(i + 1),
      isFiscalYearEnd: i + 1 === 12,
    });
  }
  return out;
}

// ── Statutory filing deadlines ──────────────────────────────

function periodLabel(kind, fy, n, endDt) {
  if (kind === "annual") return `FY-${iso(endDt)}`;
  if (kind === "quarterly") return `Q${n}-${iso(endDt)}`;
  return `M${String(n).padStart(2, "0")}-${iso(endDt)}`;
}

// 10-Q due date: 45 days after quarter end for a non-accelerated
// filer, rolled per Rule 0-3. Rule 12b-25 grace: 5 calendar days.
function tenQDeadline(fy, quarter, status) {
  status = status || FILER_STATUS_OF();
  const q = quarterEnds(fy).find((x) => x.q === quarter);
  if (!q || quarter === 4) return null;
  const days = DEADLINE_DAYS[status].quarterly;
  const due = rollForward(addDays(q.end, days));
  return {
    form: "10-Q",
    fiscalYear: fy,
    quarter,
    periodEnd: iso(q.end),
    periodLabel: periodLabel("quarterly", fy, quarter, q.end),
    daysAllowed: days,
    dueDate: iso(due),
    ntDueBy: iso(rollForward(addBusinessDays(due, 1))),
    extendedDueDate: iso(rollForward(addDays(due, 5))),
    graceDays: 5,
    authority: ["Rule 13a-13", "Form 10-Q Gen. Instr. A.1", "Rule 0-3", "Rule 12b-25"],
  };
}

// 10-K due date: 90 days after FYE for a non-accelerated filer.
// Rule 12b-25 grace: 15 calendar days.
function tenKDeadline(fy, status) {
  status = status || FILER_STATUS_OF();
  const { end } = fiscalYearBounds(fy);
  const days = DEADLINE_DAYS[status].annual;
  const due = rollForward(addDays(end, days));
  return {
    form: "10-K",
    fiscalYear: fy,
    quarter: 4,
    periodEnd: iso(end),
    periodLabel: periodLabel("annual", fy, 4, end),
    daysAllowed: days,
    dueDate: iso(due),
    ntDueBy: iso(rollForward(addBusinessDays(due, 1))),
    extendedDueDate: iso(rollForward(addDays(due, 15))),
    graceDays: 15,
    // Form 10-K Gen. Instr. G(3): Part III may be incorporated by
    // reference from a proxy/information statement filed within 120
    // days of FYE; otherwise Part III must be furnished by amendment
    // within that same 120 days.
    partIIIDeadline: iso(rollForward(addDays(end, 120))),
    authority: ["Rule 13a-1", "Form 10-K Gen. Instr. A + G(3)", "Rule 0-3", "Rule 12b-25"],
  };
}

// Rule 12b-2: filer status is measured on the last business day of
// the most recently completed SECOND fiscal quarter. For a June-30
// FYE that is the last business day of December.
function filerStatusMeasurementDate(fy) {
  let dt = d(fy - 1, 12, 31);
  let guard = 0;
  while (!isBusinessDay(dt) && guard++ < 10) dt = addDays(dt, -1);
  return {
    date: iso(dt),
    forFiscalYear: fy,
    note:
      "Public float measured here determines accelerated-filer status for FY" +
      fy +
      ". NGTF stays non-accelerated under the 2020 SRC revenue carve-out (revenue " +
      "under $100M, float under $700M), which is also what keeps it out of SOX 404(b).",
    authority: ["Rule 12b-2", "Release 34-88365"],
  };
}

// Full statutory calendar for one fiscal year.
function filingCalendar(fy, status) {
  status = status || FILER_STATUS_OF();
  const rows = [];
  for (const q of [1, 2, 3]) rows.push(tenQDeadline(fy, q, status));
  rows.push(tenKDeadline(fy, status));
  return rows;
}

// ── AS 1215 documentation clocks ────────────────────────────

// AS 1215.15 — as amended by PCAOB Release 2024-004, the complete
// and final documentation set must be assembled within 14 DAYS of
// the report release date. The old 45-day window is gone. For a
// firm auditing 100 or fewer issuers the 14-day rule applies to
// fiscal years beginning on or after Dec 15, 2025 — so for a
// June-30 FYE issuer audited by TAAD, FY2027 (beginning July 1,
// 2026) is squarely inside it.
function documentationCompletionDate(reportReleaseDate) {
  const rr = parse(reportReleaseDate);
  if (!rr) return null;
  const due = addDays(rr, 14);
  return {
    reportReleaseDate: iso(rr),
    completionDate: iso(due),
    days: 14,
    // Calendar years, not 2,555 days — a 7-year span contains one or
    // two leap days, so day arithmetic expired retention early.
    retentionExpiry: iso(d(rr.getUTCFullYear() + 7, rr.getUTCMonth() + 1, rr.getUTCDate())), // AS 1215.14
    authority: ["AS 1215.15 (as amended, Release 2024-004)", "AS 1215.14"],
    note:
      "After the completion date AS 1215.16 permits ADDITIONS ONLY — nothing may be " +
      "deleted or discarded, and each addition must record the date added, the preparer " +
      "and the reason. The portal enforces this by locking the engagement to append-only.",
  };
}

// Practical effect of the 14-day rule for management: because the
// archive window is two weeks rather than six, PBC items have to be
// final AT report date. This returns the internal target dates the
// portal drives notifications against.
function archiveCountdown(reportReleaseDate, today = new Date()) {
  const info = documentationCompletionDate(reportReleaseDate);
  if (!info) return null;
  const now = parse(iso(parse(today)));
  const end = parse(info.completionDate);
  const daysLeft = Math.round((end - now) / 86400000);
  return {
    ...info,
    daysRemaining: daysLeft,
    status: daysLeft < 0 ? "locked_overdue" : daysLeft <= 3 ? "critical" : daysLeft <= 7 ? "urgent" : "open",
  };
}

// ── Form 8-K clocks ─────────────────────────────────────────

// Gen. Instr. B.1 — four business days after the event. If the event
// falls on a weekend or federal holiday the period starts the next
// business day.
function eightKDeadline(eventDate) {
  const ev = parse(eventDate);
  if (!ev) return null;
  const start = isBusinessDay(ev) ? ev : rollForward(ev);
  return {
    eventDate: iso(ev),
    dueDate: iso(addBusinessDays(start, 4)),
    businessDays: 4,
    authority: ["Form 8-K Gen. Instr. B.1"],
  };
}

// Item 9.01(a)(4) — acquired-business financial statements and pro
// formas may be filed by amendment no later than 71 CALENDAR days
// after the date the initial 8-K was REQUIRED to be filed.
function eightKAFinancialsDeadline(eventDate) {
  const base = eightKDeadline(eventDate);
  if (!base) return null;
  const due = addDays(parse(base.dueDate), 71);
  return {
    eventDate: base.eventDate,
    initial8KDue: base.dueDate,
    amendmentDueDate: iso(due),
    calendarDays: 71,
    authority: ["Form 8-K Item 9.01(a)(4)", "Reg S-X 8-04", "Reg S-X 3-05"],
    note:
      "Commission the target audit AT SIGNING. A Rule 3-05/8-04 audit cannot be produced " +
      "inside 71 days if it is started on day 60 — which is how the Victorville Item 9.01 " +
      "amendment ended up filed well past this window.",
  };
}

// Reg S-X 8-08 — financial statements in a registration statement
// go stale at 135 days.
function staleDateFromBalanceSheet(balanceSheetDate) {
  const bs = parse(balanceSheetDate);
  if (!bs) return null;
  return {
    balanceSheetDate: iso(bs),
    staleAfter: iso(addDays(bs, 135)),
    days: 135,
    authority: ["Reg S-X 8-08"],
  };
}

// ── Period resolution for uploads ───────────────────────────
// Given an arbitrary "as of" date, return the monthly, quarterly
// and annual periods an uploaded document most likely belongs to.
function resolvePeriods(dateLike) {
  const dt = parse(dateLike) || parse(new Date());
  const fy = fiscalYearOf(dt);
  const q = quarterOf(dt);
  const months = fiscalMonths(fy);
  const month = months.find((m) => iso(dt) <= iso(m.end)) || months[11];
  const { end: fyEnd } = fiscalYearBounds(fy);
  return {
    fiscalYear: fy,
    month: { label: month.label, end: iso(month.end), name: month.name, fiscalMonth: month.fiscalMonth },
    quarter: { label: periodLabel("quarterly", fy, q.quarter, q.end), end: iso(q.end), quarter: q.quarter },
    annual: { label: periodLabel("annual", fy, 4, fyEnd), end: iso(fyEnd) },
  };
}

// Find the period a filename or text most plausibly refers to.
// Recognizes: 2026-09-30, 09/30/2026, Sep 30 2026, Q1 FY27, FY2026,
// "September 2026", "6/30/26".
const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function sniffPeriod(text) {
  const s = String(text || "").toLowerCase();

  // ISO 2026-09-30 / 2026_09_30
  let m = s.match(/(20\d{2})[-_.\/](\d{1,2})[-_.\/](\d{1,2})/);
  if (m) return finish(+m[1], +m[2], +m[3]);

  // US 09/30/2026 or 9-30-26
  m = s.match(/\b(\d{1,2})[-_.\/](\d{1,2})[-_.\/](20\d{2}|\d{2})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return finish(y, +m[1], +m[2]);
  }

  // "September 30, 2026" / "sep 2026"
  m = s.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})?,?\s*(20\d{2})\b/);
  if (m && MONTH_NAMES[m[1]]) {
    const mo = MONTH_NAMES[m[1]];
    const y = +m[3];
    const day = m[2] ? +m[2] : new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return finish(y, mo, day);
  }

  // Q1 FY2027 / Q3FY26 / fy2027q2
  m = s.match(/q([1-4])\s*[- ]?\s*fy\s*(20\d{2}|\d{2})/) || s.match(/fy\s*(20\d{2}|\d{2})\s*[- ]?q([1-4])/);
  if (m) {
    const isQFirst = /^q/.test(m[0]);
    const q = isQFirst ? +m[1] : +m[2];
    const raw = isQFirst ? m[2] : m[1];
    const fy = raw.length === 2 ? 2000 + +raw : +raw;
    const qe = quarterEnds(fy).find((x) => x.q === q);
    return { matched: m[0], ...resolvePeriods(qe.end), inferredTier: q === 4 ? "annual" : "quarterly" };
  }

  // FY2027 alone
  m = s.match(/\bfy\s*(20\d{2}|\d{2})\b/);
  if (m) {
    const raw = m[1];
    const fy = raw.length === 2 ? 2000 + +raw : +raw;
    return { matched: m[0], ...resolvePeriods(fiscalYearBounds(fy).end), inferredTier: "annual" };
  }

  return null;

  function finish(y, mo, day) {
    if (!(mo >= 1 && mo <= 12) || !(day >= 1 && day <= 31)) return null;
    const dt = d(y, mo, day);
    const per = resolvePeriods(dt);
    const isME = iso(dt) === iso(lastDayOfMonth(y, mo));
    const isQE = iso(dt) === per.quarter.end;
    const isFYE = iso(dt) === per.annual.end;
    return {
      matched: m[0],
      asOf: iso(dt),
      ...per,
      inferredTier: isFYE ? "annual" : isQE ? "quarterly" : isME ? "monthly" : null,
    };
  }
}

module.exports = {
  DEADLINE_DAYS,
  // date utils
  iso,
  dstr,
  parse,
  addDays,
  addBusinessDays,
  businessDaysBetween,
  isBusinessDay,
  rollForward,
  federalHolidays,
  // fiscal math
  fiscalYearOf,
  fiscalYearBounds,
  quarterEnds,
  quarterOf,
  fiscalMonths,
  periodLabel,
  resolvePeriods,
  sniffPeriod,
  // statutory
  tenQDeadline,
  tenKDeadline,
  filingCalendar,
  filerStatusMeasurementDate,
  eightKDeadline,
  eightKAFinancialsDeadline,
  staleDateFromBalanceSheet,
  // AS 1215
  documentationCompletionDate,
  archiveCountdown,
};

// Defined after the export object exists, because assigning
// module.exports wholesale would discard properties attached before
// it. Getters rather than values so a profile edited at runtime is
// reflected immediately — a stale fiscal year end would misdate an
// entire engagement silently.
Object.defineProperty(module.exports, "FYE_MONTH", { get: () => FYE_MONTH_OF(), enumerable: true });
Object.defineProperty(module.exports, "FYE_DAY", { get: () => FYE_DAY_OF(), enumerable: true });
Object.defineProperty(module.exports, "FILER_STATUS", { get: () => FILER_STATUS_OF(), enumerable: true });
module.exports.profileAccessors = { FYE_MONTH_OF, FYE_DAY_OF, FILER_STATUS_OF };
