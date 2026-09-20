// ============================================================
//  PCAOB AUDIT PORTAL — ISSUER PROFILE
//  audit-issuer.js
//  ─────────────────────────────────────────────────────────
//  The root configuration. Every deadline, every applicable
//  rule and every checklist in the system derives from these
//  facts about the registrant, rather than from constants.
//
//  WHY THIS FILE EXISTS
//  The portal was built for one company and hardcoded its
//  answers: a June-30 year end, non-accelerated, not an EGC.
//  Those are not properties of audits, they are properties of
//  Nightfood. A December-31 accelerated filer that IS an EGC
//  has different deadlines, a different measurement date, no
//  critical audit matters and no auditor ICFR attestation —
//  and none of that should require touching code.
//
//  It is also the part of the system that is genuinely hard to
//  copy. A list of document categories can be read off a
//  screen. The conditional logic of WHICH obligations bind
//  WHICH registrant is the actual expertise, and it lives here.
//
//  NOTHING IN THIS FILE IS A JUDGMENT CALL BY THE SOFTWARE.
//  Filer status, EGC status and SRC status are determinations
//  the registrant makes and states on its own cover pages. The
//  portal records what was determined and computes from it; it
//  does not decide it. Where a value drives a legal deadline,
//  the authority is cited beside it.
// ============================================================

const db = require("./db");

// ── Vocabulary ──────────────────────────────────────────────

// Exchange Act Rule 12b-2 definitions. The deadlines are from
// the General Instructions to Forms 10-K and 10-Q.
const FILER_STATUSES = {
  large_accelerated: {
    label: "Large accelerated filer",
    annualDays: 60,
    quarterlyDays: 40,
    authority: ["Exchange Act Rule 12b-2", "Form 10-K Gen. Instr. A.2", "Form 10-Q Gen. Instr. A.1"],
  },
  accelerated: {
    label: "Accelerated filer",
    annualDays: 75,
    quarterlyDays: 40,
    authority: ["Exchange Act Rule 12b-2", "Form 10-K Gen. Instr. A.2", "Form 10-Q Gen. Instr. A.1"],
  },
  non_accelerated: {
    label: "Non-accelerated filer",
    annualDays: 90,
    quarterlyDays: 45,
    authority: ["Exchange Act Rule 12b-2", "Form 10-K Gen. Instr. A.2", "Form 10-Q Gen. Instr. A.1"],
  },
};

const EXCHANGES = {
  nasdaq_global_select: { label: "Nasdaq Global Select Market", listed: true, family: "nasdaq" },
  nasdaq_global: { label: "Nasdaq Global Market", listed: true, family: "nasdaq" },
  nasdaq_capital: { label: "Nasdaq Capital Market", listed: true, family: "nasdaq" },
  nyse: { label: "New York Stock Exchange", listed: true, family: "nyse" },
  nyse_american: { label: "NYSE American", listed: true, family: "nyse" },
  otcqx: { label: "OTCQX", listed: false, family: "otc" },
  otcqb: { label: "OTCQB", listed: false, family: "otc" },
  pink: { label: "Pink / Expert Market", listed: false, family: "otc" },
  none: { label: "Not quoted", listed: false, family: "none" },
};

const DEFAULT_PROFILE = {
  // Identity
  name: "",
  cik: "",
  ticker: "",
  stateOfIncorporation: "",
  principalOffice: "",

  // The fiscal calendar. Everything periodic derives from these two.
  fiscalYearEndMonth: 12,
  fiscalYearEndDay: 31,

  // Reporting posture — each is the registrant's own determination,
  // taken from its most recent cover page.
  filerStatus: "non_accelerated",
  smallerReportingCompany: true,
  emergingGrowthCompany: false,
  // An EGC's runway ends; the portal should warn before it does.
  egcFirstSaleDate: null,

  // Internal control over financial reporting. Management's report
  // under Rule 13a-15 is required of every filer; the AUDITOR's
  // attestation under Section 404(b) is not required of a
  // non-accelerated filer or, per the 2020 amendments, of an SRC
  // meeting the revenue test.
  icfrAuditorAttestation: false,

  // Where the stock trades, which decides whose listing rules bind.
  exchange: "otcqb",

  // Audit posture
  goingConcernDoubt: false,
  auditor: "",
  predecessorAuditor: "",

  // Reporting timezone. SEC deadlines run on Eastern time.
  timezone: "America/New_York",
};

// ── Derivations ─────────────────────────────────────────────
//
// These are the conditional rules — the part worth building.

/**
 * What the profile implies, with the authority for each conclusion.
 * Everything here is derived; nothing is stored, so it cannot drift
 * out of step with the facts it comes from.
 */
function derive(p) {
  const profile = { ...DEFAULT_PROFILE, ...(p || {}) };
  const fs = FILER_STATUSES[profile.filerStatus] || FILER_STATUSES.non_accelerated;
  const ex = EXCHANGES[profile.exchange] || EXCHANGES.none;

  const out = {
    filerStatusLabel: fs.label,
    annualDays: fs.annualDays,
    quarterlyDays: fs.quarterlyDays,
    exchangeLabel: ex.label,
    isListed: ex.listed,
    exchangeFamily: ex.family,
    conclusions: [],
  };

  const say = (key, value, why, authority) =>
    out.conclusions.push({ key, value, why, authority });

  // Critical audit matters. AS 3101 requires them in the auditor's
  // report, but an EGC is exempt — Securities Act Section 7(a)(2)(B)
  // and Exchange Act Section 13(a) carve EGCs out of new PCAOB
  // standards unless the Commission determines otherwise, and the
  // Commission's CAM approval order applied that carve-out.
  out.camsApply = !profile.emergingGrowthCompany;
  say(
    "cams",
    out.camsApply,
    out.camsApply
      ? "Not an emerging growth company, so critical audit matters appear in the auditor's report."
      : "Emerging growth company, so the auditor's report omits critical audit matters.",
    ["AS 3101.11", "Securities Act § 7(a)(2)(B)"]
  );

  // ICFR. Management's report is required of every reporting company
  // after its first annual report; the auditor attestation is the
  // part that turns on status.
  out.icfrManagementReport = true;
  out.icfrAttestation = !!profile.icfrAuditorAttestation;
  say(
    "icfr_attestation",
    out.icfrAttestation,
    out.icfrAttestation
      ? "Auditor attestation on ICFR is required and must be planned into the engagement."
      : "No auditor attestation on ICFR. Management's own report under Rule 13a-15 is still required.",
    ["SOX § 404(a)", "SOX § 404(b)", "Exchange Act Rule 13a-15"]
  );

  // Reduced disclosure available to an SRC.
  out.scaledDisclosure = !!profile.smallerReportingCompany;
  say(
    "src",
    out.scaledDisclosure,
    out.scaledDisclosure
      ? "Smaller reporting company: scaled disclosure, and financial statements under Reg S-X Article 8."
      : "Not a smaller reporting company: full Reg S-X disclosure applies.",
    ["Exchange Act Rule 12b-2", "Reg S-X Article 8"]
  );

  // Which listing rules bind at all.
  out.listingRulesApply = ex.listed;
  say(
    "listing_rules",
    ex.family,
    ex.listed
      ? `Listed on ${ex.label}, so that exchange's continued listing standards apply.`
      : `Quoted on ${ex.label}, so exchange listing standards do not yet apply. Initial listing standards matter only on an application.`,
    ex.family === "nasdaq" ? ["Nasdaq Rule 5250", "Nasdaq Rule 5550"] : []
  );

  // Acquired-business financial statements are scaled for an SRC.
  out.acquiredBusinessRule = profile.smallerReportingCompany ? "8-04" : "3-05";
  say(
    "acquired_business",
    out.acquiredBusinessRule,
    profile.smallerReportingCompany
      ? "Acquired business financial statements follow Reg S-X 8-04 (SRC scale)."
      : "Acquired business financial statements follow Reg S-X 3-05.",
    ["Reg S-X 3-05", "Reg S-X 8-04", "Rule 1-02(w)"]
  );

  return { profile, ...out };
}

/**
 * Quarter end dates for a fiscal year, for ANY fiscal year end.
 *
 * Convention, matching the SEC's: a fiscal year is named for the
 * calendar year in which it ENDS. FY2027 for a June-30 issuer runs
 * 1 July 2026 to 30 June 2027; FY2027 for a December-31 issuer is
 * simply calendar 2027.
 */
function quarterEndsFor(profile, fy) {
  const p = { ...DEFAULT_PROFILE, ...(profile || {}) };
  const m = p.fiscalYearEndMonth;
  const dayOf = (year, month) => new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day
  const out = [];
  for (let q = 1; q <= 4; q++) {
    // Q4 ends on the fiscal year end; each earlier quarter is three
    // months before the next.
    const monthsBack = (4 - q) * 3;
    let month = m - monthsBack;
    let year = fy;
    while (month <= 0) {
      month += 12;
      year -= 1;
    }
    // The fiscal year end may be a stated day rather than month end
    // (a 52/53-week year is not supported and is rejected on save).
    const end =
      q === 4 && p.fiscalYearEndDay
        ? new Date(Date.UTC(fy, m - 1, p.fiscalYearEndDay))
        : dayOf(year, month);
    out.push({ q, end });
  }
  return out;
}

/** First day of the fiscal year. */
function fiscalYearStart(profile, fy) {
  const p = { ...DEFAULT_PROFILE, ...(profile || {}) };
  const end = new Date(Date.UTC(fy, p.fiscalYearEndMonth - 1, p.fiscalYearEndDay));
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCDate(start.getUTCDate() + 1);
  return start;
}

/**
 * The Rule 12b-2 measurement date: the last business day of the
 * registrant's most recently completed SECOND fiscal quarter. Public
 * float is measured then, and it is what moves a company between
 * filer statuses — so the portal should be reminding people about it
 * rather than letting it pass unnoticed.
 */
function filerStatusMeasurementDateFor(profile, fy) {
  const qs = quarterEndsFor(profile, fy);
  return qs.find((q) => q.q === 2).end;
}

// ── Validation ──────────────────────────────────────────────

function validate(input) {
  const p = { ...DEFAULT_PROFILE, ...(input || {}) };
  const errors = [];

  const m = Number(p.fiscalYearEndMonth);
  const day = Number(p.fiscalYearEndDay);
  if (!(m >= 1 && m <= 12)) errors.push("Fiscal year end month must be 1 to 12.");
  if (!(day >= 1 && day <= 31)) errors.push("Fiscal year end day must be 1 to 31.");
  if (m && day) {
    // Reject a day that does not exist in that month in a common year,
    // which would silently shift every period end.
    const probe = new Date(Date.UTC(2027, m - 1, day));
    if (probe.getUTCMonth() !== m - 1) {
      errors.push(`There is no day ${day} in month ${m}. A 52/53-week fiscal year is not supported.`);
    }
  }
  if (!FILER_STATUSES[p.filerStatus]) errors.push(`Unknown filer status "${p.filerStatus}".`);
  if (!EXCHANGES[p.exchange]) errors.push(`Unknown exchange "${p.exchange}".`);
  if (p.cik && !/^\d{1,10}$/.test(String(p.cik).replace(/^0+/, "") || "0")) {
    errors.push("CIK should be digits only.");
  }

  // A contradiction worth catching: a large accelerated filer cannot
  // be a smaller reporting company under the Rule 12b-2 thresholds.
  if (p.filerStatus === "large_accelerated" && p.smallerReportingCompany) {
    errors.push(
      "A large accelerated filer cannot also be a smaller reporting company under Rule 12b-2. Check the cover page."
    );
  }
  // 404(b) attestation is not required of a non-accelerated filer;
  // flag rather than block, since a company may elect to obtain one.
  const warnings = [];
  if (p.filerStatus === "non_accelerated" && p.icfrAuditorAttestation) {
    warnings.push(
      "A non-accelerated filer is not required to obtain an auditor attestation on ICFR under Section 404(b). " +
        "Keep this on only if the company has elected one."
    );
  }
  if (p.emergingGrowthCompany && p.icfrAuditorAttestation) {
    warnings.push("An emerging growth company is exempt from Section 404(b) attestation.");
  }

  return { ok: errors.length === 0, errors, warnings, profile: p };
}

// ── Persistence ─────────────────────────────────────────────

let cached = null;

async function load({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  try {
    const r = await db.query(`SELECT value FROM ngtf_audit_settings WHERE key='issuer_profile'`);
    cached = { ...DEFAULT_PROFILE, ...((r.rows[0] && r.rows[0].value) || {}) };
  } catch (err) {
    console.error("[audit-issuer] could not load profile, using defaults:", err.message);
    cached = { ...DEFAULT_PROFILE };
  }
  return cached;
}

async function save(input, actor) {
  const v = validate(input);
  if (!v.ok) throw new Error(v.errors.join(" "));
  await db.query(
    `INSERT INTO ngtf_audit_settings (key, value) VALUES ('issuer_profile', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(v.profile)]
  );
  cached = v.profile;

  try {
    const schema = require("./audit-schema");
    await schema.logEvent({
      event: "issuer_profile_updated",
      actor,
      detail: {
        fiscalYearEnd: `${v.profile.fiscalYearEndMonth}/${v.profile.fiscalYearEndDay}`,
        filerStatus: v.profile.filerStatus,
        egc: v.profile.emergingGrowthCompany,
        exchange: v.profile.exchange,
      },
    });
  } catch (err) {
    /* the profile is saved; the log line is not worth failing over */
  }
  return { profile: v.profile, warnings: v.warnings };
}

/**
 * Establish a profile on boot.
 *
 * A database that already holds engagements predates this file: it was
 * created by the build that hardcoded a June-30 year end, and every
 * period label and deadline in it assumes that. Adopting the generic
 * December-31 default would silently re-date the entire history, so an
 * existing installation is seeded with the profile it was built around.
 *
 * A genuinely empty database gets the defaults and expects someone to
 * fill in the profile before opening any period — which is the correct
 * behaviour for the second customer onwards.
 */
async function ensureProfile() {
  try {
    const existing = await db.query(`SELECT value FROM ngtf_audit_settings WHERE key='issuer_profile'`);
    if (existing.rows[0] && existing.rows[0].value) {
      cached = { ...DEFAULT_PROFILE, ...existing.rows[0].value };
      return { created: false, profile: cached };
    }

    const prior = await db.query(`SELECT COUNT(*)::int AS n FROM ngtf_audit_engagements`);
    const hasHistory = prior.rows[0] && prior.rows[0].n > 0;

    const seed = hasHistory ? { ...DEFAULT_PROFILE, ...NIGHTFOOD } : { ...DEFAULT_PROFILE };
    await db.query(
      `INSERT INTO ngtf_audit_settings (key, value) VALUES ('issuer_profile', $1)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(seed)]
    );
    cached = seed;
    console.log(
      hasHistory
        ? "[audit-issuer] seeded the issuer profile from the original June-30 configuration, preserving existing dates"
        : "[audit-issuer] no issuer profile yet — using defaults until one is saved"
    );
    return { created: true, profile: cached, seededFromHistory: hasHistory };
  } catch (err) {
    console.error("[audit-issuer] could not establish a profile:", err.message);
    cached = { ...DEFAULT_PROFILE };
    return { created: false, profile: cached, error: err.message };
  }
}

/** Synchronous access for code paths already holding the profile. */
function current() {
  return cached || { ...DEFAULT_PROFILE };
}

/** Seed the profile from what the portal was originally built around. */
const NIGHTFOOD = {
  name: "NightFood Holdings, Inc.",
  cik: "0001593001",
  ticker: "NGTF",
  stateOfIncorporation: "Nevada",
  principalOffice: "Tarrytown, NY",
  fiscalYearEndMonth: 6,
  fiscalYearEndDay: 30,
  filerStatus: "non_accelerated",
  smallerReportingCompany: true,
  emergingGrowthCompany: false,
  icfrAuditorAttestation: false,
  exchange: "otcqb",
  goingConcernDoubt: true,
  auditor: "TAAD, LLP",
  predecessorAuditor: "Fruci & Associates II, PLLC",
  timezone: "America/New_York",
};

module.exports = {
  DEFAULT_PROFILE,
  FILER_STATUSES,
  EXCHANGES,
  NIGHTFOOD,
  derive,
  validate,
  load,
  save,
  ensureProfile,
  current,
  quarterEndsFor,
  fiscalYearStart,
  filerStatusMeasurementDateFor,
};
