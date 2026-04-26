// ============================================================
//  paralegal.js — Zara AI Paralegal Agent for JJ Private Mode
//  Integrates with existing JJ mode in askClaude-memory.js
//
//  CAPABILITIES:
//  - California CCP deadline calculator (state civil)
//  - EOIR Immigration Court deadline calculator
//  - Federal District Court (CACD/CAED/CACD) deadline calculator
//  - Case note entry → MyCase (via API)
//  - Team email notifications
//  - Document drafting (M&C letters, tasks, case summaries)
//  - Next step recommendations
//
//  USAGE (in JJ mode):
//  JJ types anything like:
//  "paralegal: Gloria Martinez CIVVS2507281 received FAC today need deadlines"
//  "paralegal: Hu v Mullin 5:26-cv-02057 NTA received set EOIR deadlines"
//  "paralegal: draft meet and confer for demurrer Smith v Jones"
// ============================================================

const axios = require("axios");
const nodemailer = require("nodemailer");

// ── Env vars ─────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MYCASE_API_KEY    = process.env.MYCASE_API_KEY;
const GMAIL_EMAIL       = process.env.GMAIL_EMAIL;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// ── Team email addresses ──────────────────────────────────────
const TEAM = {
  jj:      "jj@tezlawfirm.com",
  jue:     "jue.wang@tezlawfirm.com",       // immigration USCIS
  michael: "michael.liu@tezlawfirm.com",    // immigration court
  lin:     "lin.mei@tezlawfirm.com",        // personal injury
  chandler:"chandler.jin@tezlawfirm.com",   // associate
};

// ============================================================
//  TRIGGER DETECTION
//  Fires ONLY when message looks like a real case update:
//  Must have EITHER a case number OR a client name pattern
//  PLUS a legal action keyword — prevents false positives
//  on general legal questions.
// ============================================================
function isParalegalCommand(message) {
  const m = message.toLowerCase();

  // Explicit prefixes always trigger
  if (m.startsWith("paralegal:") || m.startsWith("para:") || m.startsWith("case:") || m.startsWith("p:")) {
    return true;
  }

  // ── Signal 1: Case number patterns ──────────────────────
  // CA state: CIVVS2507281, CIVSB123456, 23STCV12345
  // Federal:  5:26-cv-02057, 2:24-cr-00123, 8:25-bk-12345
  // EOIR A-number: A123-456-789 or A123456789
  const hasCaseNumber = (
    /\b(CIVVS|CIVSB|CIVRS|CIVBS|CIVFS)\d{5,}/i.test(message) ||   // SB county unlimited civil
    /\b\d{2}(STCV|STCP|STFL|SMCV)\d{5,}/i.test(message) ||        // LA county
    /\b\d:\d{2}-[a-z]{2,4}-\d{4,}/i.test(message) ||              // Federal (5:26-cv-02057)
    /\bA[\-\s]?\d{3}[\-\s]?\d{3}[\-\s]?\d{3}\b/i.test(message) || // EOIR A-number
    /\b[A-Z]{3}\d{10,13}\b/.test(message)                          // USCIS receipt (MSC2490012345)
  );

  // ── Signal 2: Client name pattern ───────────────────────
  // Two or more capitalized words (First Last) near a legal keyword
  const hasClientName = /\b[A-Z][a-z]{1,20}\s+[A-Z][a-z]{1,20}\b/.test(message);

  // ── Signal 3: Legal action keyword ──────────────────────
  const hasLegalAction = /\b(received|filed|served|issued|granted|denied|scheduled|set for|hearing|order|deadline|calendar|fac|nta|bia|eoir|demurrer|motion|discovery|judgment|removal|deportation|bond|appeal|reopen|reconsider|voluntary departure|in absentia|asylum|i-589|i-130|i-485|meet and confer|m&c|case note|notify team|draft)\b/i.test(message);

  // ── Signal 4: Explicit action phrases always trigger ────
  const hasExplicitAction = /\b(set deadlines|need deadlines|calendar this|create tasks|notify (the )?team|draft (a |the )?(m&c|meet and confer|case note|motion|letter)|add (to |a )?mycase|case update for)\b/i.test(m);

  // Fire if:
  // (case number OR client name) AND (legal action keyword OR explicit action)
  return (
    hasExplicitAction ||
    ((hasCaseNumber || hasClientName) && hasLegalAction)
  );
}

// ============================================================
//  CALIFORNIA COURT HOLIDAY CHECKER
//  (Federal holidays + CA judicial holidays)
// ============================================================
function isCourtHoliday(date) {
  const d = new Date(date);
  const month = d.getMonth() + 1; // 1-indexed
  const day   = d.getDate();
  const dow   = d.getDay(); // 0=Sun, 6=Sat

  // Weekend
  if (dow === 0 || dow === 6) return true;

  // Fixed federal/CA judicial holidays
  const fixed = [
    [1,1],   // New Year's Day
    [7,4],   // Independence Day
    [11,11], // Veterans Day
    [12,25], // Christmas
  ];
  if (fixed.some(([m,d2]) => month === m && day === d2)) return true;

  // New Year's observed (if Jan 1 falls on weekend)
  // Martin Luther King Jr. Day — 3rd Monday in January
  if (month === 1 && dow === 1 && day >= 15 && day <= 21) return true;
  // Presidents Day — 3rd Monday in February
  if (month === 2 && dow === 1 && day >= 15 && day <= 21) return true;
  // Memorial Day — last Monday in May
  if (month === 5 && dow === 1 && day >= 25) return true;
  // Juneteenth — June 19
  if (month === 6 && day === 19) return true;
  // Labor Day — 1st Monday in September
  if (month === 9 && dow === 1 && day <= 7) return true;
  // Columbus Day — 2nd Monday in October (federal only, skip CA state)
  // Thanksgiving — 4th Thursday in November
  if (month === 11 && dow === 4 && day >= 22 && day <= 28) return true;
  // Day after Thanksgiving (CA judicial holiday)
  if (month === 11 && dow === 5 && day >= 23 && day <= 29) return true;
  // César Chávez Day — March 31 (CA state courts)
  if (month === 3 && day === 31) return true;

  return false;
}

// Add calendar days, skipping weekends and holidays for court-day counts
function addCalendarDays(startDate, days) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + days);
  // If the result falls on a weekend/holiday, roll forward to next court day
  while (isCourtHoliday(d)) d.setDate(d.getDate() + 1);
  return d;
}

function addCourtDays(startDate, courtDays) {
  const d = new Date(startDate);
  let count = 0;
  while (count < courtDays) {
    d.setDate(d.getDate() + 1);
    if (!isCourtHoliday(d)) count++;
  }
  return d;
}

function fmt(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    timeZone: "America/Los_Angeles"
  });
}

// ============================================================
//  DEADLINE CALCULATORS
// ============================================================

// ── California CCP — State Civil ─────────────────────────────
function calcCCPDeadlines(triggerEvent, serviceDate, serviceMethod = "email") {
  const svc = new Date(serviceDate);
  const deadlines = [];

  // Electronic/email service adds 2 COURT days (CCP §1010.6(a)(3)(B))
  // Mail within CA adds 5 calendar days (CCP §1013(a))
  // Personal service — no extension
  const emailExt    = 2; // court days
  const mailExtCA   = 5; // calendar days

  if (triggerEvent === "FAC" || triggerEvent === "complaint" || triggerEvent === "amended_complaint") {
    // CCP §471.5(a) — 30 calendar days to respond to FAC
    // CCP §430.40(a) — 30 days for demurrer
    // CCP §435(b)(1) — 30 days for motion to strike
    let base = addCalendarDays(svc, 30);
    if (serviceMethod === "email") base = addCourtDays(base, emailExt);
    if (serviceMethod === "mail_ca") base = addCalendarDays(base, mailExtCA);

    // Meet & confer must happen 5 days BEFORE response deadline (§430.41)
    const mc = new Date(base);
    mc.setDate(mc.getDate() - 5);

    // CIV-141 automatic 30-day extension window
    const ext = addCalendarDays(base, 30);

    deadlines.push(
      { label: "⚠️  M&C must be completed by",            date: fmt(mc),   priority: "HIGH",   note: "CCP §430.41 — live phone/video required, email alone insufficient" },
      { label: "📅 Response deadline (Demurrer/Answer/MTS)", date: fmt(base), priority: "HIGH",   note: `CCP §§471.5(a), 430.40(a), 435(b)(1) — service method: ${serviceMethod}` },
      { label: "📋 CIV-141 auto-extension deadline",        date: fmt(ext),  priority: "MEDIUM", note: "File CIV-141 declaration by original deadline to get automatic 30-day extension" },
    );

    // Demurrer hearing — must be scheduled at least 16 court days out (CCP §1005(b))
    // San Bernardino Local Rule 520 — reserve hearing BEFORE filing
    deadlines.push(
      { label: "🗓️  Reserve demurrer hearing date (SB Local Rule 520)", date: "Before filing", priority: "HIGH", note: "San Bernardino Superior Court requires hearing reservation BEFORE e-filing" },
    );

    // CMC Statement — 15 calendar days before CMC (CRC 3.725)
    deadlines.push(
      { label: "📝 CMC Statement due",  date: "15 days before CMC", priority: "MEDIUM", note: "CRC 3.725 — also check for Initial Disclosures under CCP §2016.090 (cases filed 1/1/24-1/1/27, 60-day deadline)" },
    );
  }

  if (triggerEvent === "complaint_served") {
    // Original complaint — CCP §412.20(a)(3): 30 days to respond
    let base = addCalendarDays(svc, 30);
    if (serviceMethod === "email") base = addCourtDays(base, emailExt);
    if (serviceMethod === "mail_ca") base = addCalendarDays(base, mailExtCA);
    const mc = new Date(base); mc.setDate(mc.getDate() - 5);

    deadlines.push(
      { label: "⚠️  M&C must be completed by",    date: fmt(mc),   priority: "HIGH",   note: "CCP §430.41" },
      { label: "📅 Response deadline (Answer/Demurrer)", date: fmt(base), priority: "HIGH", note: "CCP §412.20(a)(3)" },
    );
  }

  if (triggerEvent === "discovery_responses") {
    // CCP §§2030.260, 2031.260 — 30 days to respond to written discovery
    let base = addCalendarDays(svc, 30);
    if (serviceMethod === "email") base = addCourtDays(base, emailExt);
    if (serviceMethod === "mail_ca") base = addCalendarDays(base, mailExtCA);

    // 45 days after verified responses for MTC (CCP §2030.300(c))
    const mtc = addCalendarDays(base, 45);

    deadlines.push(
      { label: "📅 Discovery responses due", date: fmt(base), priority: "HIGH",   note: "CCP §§2030.260, 2031.260" },
      { label: "📅 Motion to Compel further deadline", date: fmt(mtc), priority: "MEDIUM", note: "CCP §2030.300(c) — 45 days after verified responses" },
    );
  }

  if (triggerEvent === "trial_date") {
    // Key pretrial deadlines
    const trial = new Date(serviceDate); // reuse as trial date
    deadlines.push(
      { label: "📅 Discovery cutoff",      date: fmt(addCalendarDays(trial, -30)),  priority: "HIGH",   note: "CCP §2024.020 — 30 days before trial" },
      { label: "📅 Expert exchange",       date: fmt(addCalendarDays(trial, -50)),  priority: "HIGH",   note: "CCP §2034.230 — 50 days before trial" },
      { label: "📅 MSJ filing deadline",   date: fmt(addCalendarDays(trial, -105)), priority: "HIGH",   note: "CCP §437c — 105 days before trial" },
      { label: "📅 Jury fee deposit",      date: fmt(addCalendarDays(trial, -25)),  priority: "MEDIUM", note: "CCP §631 — 25 days before trial (or by first CMC, whichever is earlier)" },
    );
  }

  return deadlines;
}

// ── EOIR Immigration Court Deadlines ─────────────────────────
function calcEOIRDeadlines(triggerEvent, eventDate) {
  const d = new Date(eventDate);
  const deadlines = [];

  if (triggerEvent === "NTA" || triggerEvent === "master_calendar") {
    // First MCH — filings due 15 days before (ICPM §3.1(b)(1))
    // EOIR-28 must be filed — if filed 15+ days before MCH, MCH may be vacated (PM 21-18)
    deadlines.push(
      { label: "📋 File EOIR-28 (Notice of Appearance)", date: "ASAP — as soon as retained", priority: "HIGH", note: "8 CFR §1292.1(f) — file immediately. If filed 15+ days before MCH, MCH may be vacated (PM 21-18)" },
      { label: "📅 Filings due before MCH",              date: fmt(addCalendarDays(d, -15)), priority: "HIGH", note: "ICPM §3.1(b)(1) — 15 days before MCH; responses due 10 days before" },
      { label: "📝 EOIR-33 (address confirmation)",       date: "File at EOIR-28",            priority: "MEDIUM", note: "8 CFR §1003.15(d)(2) — must update within 5 WORKING days of any address change" },
    );
  }

  if (triggerEvent === "individual_hearing_scheduled") {
    // PM 25-21 (Feb 14, 2025) — pre-hearing filings due 30 days before (changed from 15)
    const filingDue = addCalendarDays(d, -30);
    deadlines.push(
      { label: "📅 All pre-hearing filings due",   date: fmt(filingDue), priority: "HIGH",   note: "PM 25-21 (Feb 14, 2025) — 30 days before individual hearing" },
      { label: "📋 I-589 / EOIR-42A/42B deadline", date: fmt(filingDue), priority: "HIGH",   note: "File with judge at or before pre-hearing filing deadline" },
      { label: "📑 Evidence packets/declarations due", date: fmt(filingDue), priority: "HIGH", note: "Country conditions, expert reports, corroborating docs" },
    );
  }

  if (triggerEvent === "asylum_first_heard") {
    // I-589 must be filed within 1 year of entry (INA §208(a)(2)(B))
    // If in asylum-only proceedings, within 15 days of first hearing (8 CFR §1208.4(d)(1))
    deadlines.push(
      { label: "⚠️  I-589 HARD DEADLINE",        date: fmt(addCalendarDays(d, 365)), priority: "CRITICAL", note: "INA §208(a)(2)(B) — 1 year from last entry. JURISDICTIONAL — court loses power to grant if missed." },
      { label: "⏱️  I-589 (asylum-only proceedings)", date: fmt(addCalendarDays(d, 15)), priority: "HIGH",   note: "8 CFR §1208.4(d)(1) — 15 days from first hearing in asylum-only proceedings" },
    );
  }

  if (triggerEvent === "IJ_decision") {
    // BIA appeal — 30 days (8 CFR §1003.38)
    // Motion to reconsider — 30 days
    // Motion to reopen — 90 days
    const biaAppeal = addCalendarDays(d, 30);
    const mtr       = addCalendarDays(d, 90);
    const mtc       = addCalendarDays(d, 30);

    deadlines.push(
      { label: "⚠️  BIA Appeal (EOIR-26) deadline", date: fmt(biaAppeal), priority: "CRITICAL", note: "8 CFR §1003.38 — 30 days from IJ decision. Jurisdictional. File EOIR-26 + fee or EOIR-26A waiver. NOTE: Pending Feb 2026 IFR may shorten to 10 days — verify on eCFR." },
      { label: "📅 Motion to Reconsider deadline",  date: fmt(mtc),       priority: "HIGH",     note: "8 CFR §1003.23 — 30 days from IJ decision" },
      { label: "📅 Motion to Reopen deadline",       date: fmt(mtr),       priority: "HIGH",     note: "8 CFR §1003.23 — 90 days from IJ decision (no time limit for lack of notice MTR)" },
    );
  }

  if (triggerEvent === "BIA_decision") {
    // 9th Circuit Petition for Review — 30 days (INA §242(b)(1)) — JURISDICTIONAL
    const pfr  = addCalendarDays(d, 30);
    const mtr  = addCalendarDays(d, 90);
    const mtcb = addCalendarDays(d, 30);

    deadlines.push(
      { label: "⚠️  9th Circuit Petition for Review", date: fmt(pfr),  priority: "CRITICAL", note: "INA §242(b)(1) — 30 days from BIA decision. JURISDICTIONAL — no equitable tolling (Stone v. INS). File in CACD or circuit of residence." },
      { label: "📅 BIA Motion to Reconsider deadline", date: fmt(mtcb), priority: "HIGH",     note: "8 CFR §1003.2 — 30 days from BIA decision" },
      { label: "📅 BIA Motion to Reopen deadline",     date: fmt(mtr),  priority: "HIGH",     note: "8 CFR §1003.2 — 90 days from BIA decision" },
    );
  }

  if (triggerEvent === "bond_hearing") {
    deadlines.push(
      { label: "📅 BIA Bond Appeal deadline", date: fmt(addCalendarDays(d, 30)), priority: "HIGH", note: "8 CFR §1003.38 — 30 days from bond determination. If DHS files EOIR-43 within 1 business day, automatic stay if bond ≥$10K (8 CFR §1236.1(d)(3)(i))." },
      { label: "💰 Bond payment", date: "Immediately upon grant", priority: "HIGH", note: "ICE must receive bond payment and paperwork before release. Bring cashier's check or money order only." },
    );
  }

  if (triggerEvent === "voluntary_departure_pre") {
    deadlines.push(
      { label: "✈️  Voluntary Departure deadline", date: fmt(addCalendarDays(d, 120)), priority: "CRITICAL", note: "8 CFR §1240.26(b) — 120 days pre-conclusion VD. MUST depart by this date or face 10-year bar + $5,000 civil penalty." },
    );
  }

  if (triggerEvent === "voluntary_departure_post") {
    deadlines.push(
      { label: "✈️  Voluntary Departure deadline",        date: fmt(addCalendarDays(d, 60)), priority: "CRITICAL", note: "8 CFR §1240.26(c) — 60 days post-conclusion VD." },
      { label: "💰 VD Bond (minimum $500) payment deadline", date: fmt(addCalendarDays(d, 5)), priority: "HIGH",     note: "8 CFR §1240.26(e) — must post bond within 5 BUSINESS days of grant" },
    );
  }

  if (triggerEvent === "in_absentia_order") {
    deadlines.push(
      { label: "📅 MTR (exceptional circumstances)", date: fmt(addCalendarDays(d, 180)), priority: "HIGH",     note: "8 CFR §1003.23(b)(4)(ii) — 180 days from in absentia order" },
      { label: "📅 MTR (lack of notice)",             date: "No time limit",             priority: "HIGH",     note: "INA §240(b)(5)(C)(ii) — no time limit for lack of notice motions" },
    );
  }

  return deadlines;
}

// ── Federal Court (9th Circuit / CACD / CAED) Deadlines ──────
function calcFederalDeadlines(triggerEvent, serviceDate, serviceMethod = "ecf") {
  const svc = new Date(serviceDate);
  const deadlines = [];

  // FRCP Rule 6(d) — 3 additional days for electronic service (same as mail)
  const ecfExt = 3;

  if (triggerEvent === "complaint_served") {
    // FRCP Rule 12(a)(1)(A)(i) — 21 days to answer
    let base = addCalendarDays(svc, 21);
    if (serviceMethod === "ecf") base = addCalendarDays(base, ecfExt);
    deadlines.push(
      { label: "📅 Answer / Rule 12 motion deadline", date: fmt(base), priority: "HIGH", note: "FRCP Rule 12(a)(1)(A)(i) — 21 days from service (+3 for ECF service)" },
    );
  }

  if (triggerEvent === "motion_filed") {
    // CACD Local Rule 7-9 — opposition due 21 days after service
    let opp = addCalendarDays(svc, 21);
    let reply = addCalendarDays(opp, 14);
    deadlines.push(
      { label: "📅 Opposition due (CACD)",   date: fmt(opp),   priority: "HIGH",   note: "CACD Local Rule 7-9 — 21 days from service of motion" },
      { label: "📅 Reply due (CACD)",        date: fmt(reply), priority: "HIGH",   note: "CACD Local Rule 7-10 — 14 days from opposition" },
    );
  }

  if (triggerEvent === "habeas_petition") {
    // 28 U.S.C. §2244(d) — 1-year AEDPA statute of limitations from final judgment
    deadlines.push(
      { label: "⚠️  AEDPA 1-year SOL", date: fmt(addCalendarDays(svc, 365)), priority: "CRITICAL", note: "28 U.S.C. §2244(d) — 1 year from final judgment (tolled during state post-conviction)" },
    );
  }

  if (triggerEvent === "judgment_entered") {
    // FRAP Rule 4(a)(1)(A) — 30 days to file NOA (60 if U.S. is party)
    deadlines.push(
      { label: "📅 Notice of Appeal (9th Cir.)", date: fmt(addCalendarDays(svc, 30)), priority: "CRITICAL", note: "FRAP Rule 4(a)(1)(A) — 30 days from judgment. JURISDICTIONAL." },
      { label: "📅 Rule 59 motion deadline",     date: fmt(addCalendarDays(svc, 28)), priority: "HIGH",     note: "FRCP Rule 59 — 28 days from judgment entry. Tolls appeal deadline." },
    );
  }

  if (triggerEvent === "discovery_served") {
    // FRCP Rule 33/34 — 30 days to respond
    let resp = addCalendarDays(svc, 30);
    if (serviceMethod === "ecf") resp = addCalendarDays(resp, ecfExt);
    deadlines.push(
      { label: "📅 Discovery responses due", date: fmt(resp), priority: "HIGH", note: "FRCP Rules 33/34 — 30 days (+3 for ECF)" },
    );
  }

  return deadlines;
}

// ============================================================
//  TEAM EMAIL NOTIFICATION
// ============================================================
async function notifyTeam(subject, body, recipients = []) {
  if (!GMAIL_EMAIL || !GMAIL_APP_PASSWORD) {
    console.warn("[paralegal] Email credentials not set — skipping team notification");
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_EMAIL, pass: GMAIL_APP_PASSWORD },
  });

  const to = recipients.length > 0
    ? recipients.map(r => TEAM[r] || r).filter(Boolean).join(", ")
    : TEAM.jj;

  try {
    await transporter.sendMail({
      from:    `"Zara – Tez Law" <${GMAIL_EMAIL}>`,
      to,
      subject: `[Zara Paralegal] ${subject}`,
      text:    body,
      html:    `<pre style="font-family:Arial,sans-serif;font-size:14px;">${body}</pre>`,
    });
    console.log(`[paralegal] ✅ Team email sent → ${to}`);
    return true;
  } catch (err) {
    console.error("[paralegal] Email error:", err.message);
    return false;
  }
}

// ============================================================
//  MYCASE INTEGRATION
//  Creates tasks and case notes via MyCase API
// ============================================================
async function createMyCaseTask(caseName, taskTitle, dueDate, description = "") {
  if (!MYCASE_API_KEY) {
    return { success: false, error: "MYCASE_API_KEY not set" };
  }
  try {
    // First — search for the case
    const searchResp = await axios.get(
      `https://app.mycase.com/api/v1/cases?q=${encodeURIComponent(caseName)}`,
      {
        headers: {
          "X-Auth-Token": MYCASE_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      }
    );
    const cases = searchResp.data?.cases || searchResp.data || [];
    if (!cases.length) return { success: false, error: `No MyCase case found for: ${caseName}` };

    const caseId = cases[0].id;

    // Create the task
    const taskResp = await axios.post(
      "https://app.mycase.com/api/v1/tasks",
      {
        task: {
          case_id:     caseId,
          name:        taskTitle,
          due_date:    dueDate, // YYYY-MM-DD
          description: `${description}\n\n[Auto-created by Zara Paralegal Agent]`,
          status:      "open",
          priority:    "high",
        }
      },
      {
        headers: {
          "X-Auth-Token": MYCASE_API_KEY,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      }
    );
    return { success: true, taskId: taskResp.data?.task?.id };
  } catch (err) {
    console.error("[paralegal] MyCase error:", err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

async function createMyCaseNote(caseName, noteBody) {
  if (!MYCASE_API_KEY) return { success: false, error: "MYCASE_API_KEY not set" };
  try {
    const searchResp = await axios.get(
      `https://app.mycase.com/api/v1/cases?q=${encodeURIComponent(caseName)}`,
      { headers: { "X-Auth-Token": MYCASE_API_KEY, "Content-Type": "application/json" }, timeout: 8000 }
    );
    const cases = searchResp.data?.cases || searchResp.data || [];
    if (!cases.length) return { success: false, error: `No MyCase case found for: ${caseName}` };

    const caseId = cases[0].id;
    await axios.post(
      "https://app.mycase.com/api/v1/case_notes",
      {
        case_note: {
          case_id: caseId,
          body:    `${noteBody}\n\n[Auto-created by Zara Paralegal Agent ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT]`,
        }
      },
      { headers: { "X-Auth-Token": MYCASE_API_KEY, "Content-Type": "application/json" }, timeout: 8000 }
    );
    return { success: true };
  } catch (err) {
    console.error("[paralegal] MyCase note error:", err.response?.data || err.message);
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ============================================================
//  CLAUDE PARALEGAL BRAIN
//  Processes JJ's instruction and returns structured action plan
// ============================================================
const PARALEGAL_SYSTEM_PROMPT = `You are Zara, the AI paralegal for Tez Law P.C. in West Covina, California.
You are in JJ PRIVATE MODE — you are speaking directly with JJ Zhang, Managing Attorney (CA Bar #326666).

Your role is to act as an expert California litigation and immigration paralegal.

============================
TEAM
============================
- JJ Zhang — Managing Attorney: jj@tezlawfirm.com
- Jue Wang — Immigration USCIS: jue.wang@tezlawfirm.com
- Michael Liu — Immigration Court: michael.liu@tezlawfirm.com
- Lin Mei — Personal Injury: lin.mei@tezlawfirm.com
- Chandler Jin — Associate Attorney: chandler.jin@tezlawfirm.com

============================
WHEN JJ GIVES YOU A CASE UPDATE, DO ALL OF:
============================
1. Identify: case name, case number, court type (CA state / EOIR / federal), event type
2. Calculate ALL relevant deadlines (deadlines are pre-computed by the system and injected below)
3. Identify which team members to notify based on practice area
4. Recommend next 3-5 specific action steps
5. Draft any requested documents (M&C letters, case notes, task lists)
6. Format everything clearly for JJ to review and approve

============================
DEADLINE RULES YOU MUST KNOW
============================

CALIFORNIA STATE COURTS (CCP):
- FAC/Amended Complaint response: 30 calendar days + 2 court days for email service (CCP §§471.5, 430.40, 1010.6)
- Meet & Confer: MUST occur 5 days before response deadline via live phone/video (CCP §430.41) — email alone is INSUFFICIENT
- CIV-141 automatic 30-day extension: available if M&C fails, file by original deadline
- San Bernardino (CIVVS): reserve hearing BEFORE filing (Local Rule 520)
- Discovery responses: 30 days + 2 court days email service (CCP §§2030.260, 2031.260)
- Motion to Compel: 45 days from verified responses

EOIR IMMIGRATION COURT:
- BIA appeal: 30 days from IJ decision (EOIR-26) — JURISDICTIONAL — NOTE: pending Feb 2026 IFR may change to 10 days
- 9th Circuit PFR: 30 days from BIA decision — JURISDICTIONAL, no equitable tolling
- Pre-hearing filings: 30 days before individual hearing (PM 25-21, Feb 2025) — changed from 15 days
- I-589 asylum: within 1 year of last entry — JURISDICTIONAL
- VD pre-conclusion: 120 days; post-conclusion: 60 days + bond within 5 business days
- In absentia MTR: 180 days (exceptional circumstances); no limit (lack of notice)

FEDERAL COURTS (FRCP):
- Answer/Rule 12: 21 days + 3 days ECF service (FRCP 12(a))
- CACD opposition: 21 days (Local Rule 7-9)
- NOA to 9th Circuit: 30 days from judgment — JURISDICTIONAL
- AEDPA habeas: 1-year from final judgment

============================
PRACTICE AREA → TEAM ROUTING
============================
- EOIR / removal / immigration court → Michael Liu + JJ
- USCIS / visa / green card → Jue Wang + JJ
- Litigation / civil / eviction / real estate → JJ + Chandler
- Personal injury → Lin Mei + JJ

============================
OUTPUT FORMAT
============================
Always respond with:
1. 📋 CASE SUMMARY (1-2 sentences)
2. ⚖️  DEADLINES (bullet list with dates and code citations)
3. 👥 NOTIFY (who to email and why)
4. ✅ NEXT STEPS (numbered action list)
5. 📄 DRAFT (if JJ requested a document)

Be precise, cite statutes, and flag any CRITICAL jurisdictional deadlines clearly.
Always note if a deadline is JURISDICTIONAL (court loses power if missed).`;

// ============================================================
//  MAIN PARALEGAL HANDLER
//  Called from jj-mode.js when JJ sends a paralegal command
// ============================================================
async function handleParalegalCommand(message, options = {}) {
  const { platform, platformId } = options;

  try {
    // ── Step 1: Detect court type and event from message ────
    const m = message.toLowerCase();

    // Determine court type
    let courtType = "state";
    if (/eoir|immigration court|bia|nta|notice to appear|i-589|removal|deportation|asylum|bond hearing|master calendar|individual hearing/.test(m)) {
      courtType = "eoir";
    } else if (/\d:\d{2}-cv-|\d:\d{2}-cr-|pacer|cm\/ecf|federal|cacd|caed|district court|habeas|petition for review|9th circuit/.test(m)) {
      courtType = "federal";
    }

    // Detect trigger event
    let triggerEvent = null;
    let deadlines    = [];
    const today      = new Date().toISOString().split("T")[0];

    // Extract date if mentioned, otherwise use today
    const dateMatch = message.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/) ||
                      message.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i);
    const eventDate = dateMatch ? new Date(dateMatch[0]).toISOString().split("T")[0] : today;

    // ── California State Court events ───────────────────────
    if (courtType === "state") {
      if (/fac|first amended complaint|amended complaint/.test(m)) {
        triggerEvent = "FAC";
        const svcMethod = /personal/.test(m) ? "personal" : /mail/.test(m) ? "mail_ca" : "email";
        deadlines = calcCCPDeadlines("FAC", eventDate, svcMethod);
      } else if (/complaint served|served with complaint|original complaint/.test(m)) {
        triggerEvent = "complaint_served";
        deadlines = calcCCPDeadlines("complaint_served", eventDate);
      } else if (/discovery|interrogator|rfa|rfp|request for production|request for admission/.test(m)) {
        triggerEvent = "discovery_responses";
        deadlines = calcCCPDeadlines("discovery_responses", eventDate);
      } else if (/trial date|trial set|set for trial/.test(m)) {
        triggerEvent = "trial_date";
        deadlines = calcCCPDeadlines("trial_date", eventDate);
      }
    }

    // ── EOIR events ─────────────────────────────────────────
    if (courtType === "eoir") {
      if (/nta|notice to appear|master calendar|first hearing/.test(m)) {
        triggerEvent = "NTA";
        deadlines = calcEOIRDeadlines("NTA", eventDate);
      } else if (/individual hearing|merits hearing/.test(m)) {
        triggerEvent = "individual_hearing_scheduled";
        deadlines = calcEOIRDeadlines("individual_hearing_scheduled", eventDate);
      } else if (/ij decision|judge decision|immigration judge order|order of removal/.test(m)) {
        triggerEvent = "IJ_decision";
        deadlines = calcEOIRDeadlines("IJ_decision", eventDate);
      } else if (/bia decision|board of immigration appeals/.test(m)) {
        triggerEvent = "BIA_decision";
        deadlines = calcEOIRDeadlines("BIA_decision", eventDate);
      } else if (/bond hearing|bond set|bond amount/.test(m)) {
        triggerEvent = "bond_hearing";
        deadlines = calcEOIRDeadlines("bond_hearing", eventDate);
      } else if (/i-589|asylum application|asylum filed/.test(m)) {
        triggerEvent = "asylum_first_heard";
        deadlines = calcEOIRDeadlines("asylum_first_heard", eventDate);
      } else if (/voluntary departure|vol dep|vd/.test(m)) {
        const isPost = /post.conclusion|post-conclusion|after order/.test(m);
        triggerEvent = isPost ? "voluntary_departure_post" : "voluntary_departure_pre";
        deadlines = calcEOIRDeadlines(triggerEvent, eventDate);
      } else if (/in absentia|missed hearing|failed to appear/.test(m)) {
        triggerEvent = "in_absentia_order";
        deadlines = calcEOIRDeadlines("in_absentia_order", eventDate);
      }
    }

    // ── Federal Court events ─────────────────────────────────
    if (courtType === "federal") {
      if (/complaint served|served with complaint/.test(m)) {
        triggerEvent = "complaint_served";
        deadlines = calcFederalDeadlines("complaint_served", eventDate);
      } else if (/motion filed|motion served/.test(m)) {
        triggerEvent = "motion_filed";
        deadlines = calcFederalDeadlines("motion_filed", eventDate);
      } else if (/judgment|order entered/.test(m)) {
        triggerEvent = "judgment_entered";
        deadlines = calcFederalDeadlines("judgment_entered", eventDate);
      } else if (/habeas|2254|2255/.test(m)) {
        triggerEvent = "habeas_petition";
        deadlines = calcFederalDeadlines("habeas_petition", eventDate);
      } else if (/discovery served/.test(m)) {
        triggerEvent = "discovery_served";
        deadlines = calcFederalDeadlines("discovery_served", eventDate);
      }
    }

    // ── Step 2: Build deadline block for Claude ──────────────
    let deadlineBlock = "";
    if (deadlines.length > 0) {
      deadlineBlock = `\n\n── PRE-COMPUTED DEADLINES (inject these into your response) ──\n`;
      for (const dl of deadlines) {
        deadlineBlock += `[${dl.priority}] ${dl.label}: ${dl.date}\n   → ${dl.note}\n`;
      }
      deadlineBlock += `── END DEADLINES ──`;
    } else {
      deadlineBlock = `\n\n── NOTE: No specific trigger event auto-detected. Calculate deadlines from the information JJ provided and apply the relevant rules above. ──`;
    }

    // ── Step 3: Determine team routing ──────────────────────
    // Immigration (USCIS + EOIR) → Jue Wang
    // Personal Injury             → Lin Mei
    // Litigation/Eviction/RE      → Chandler Jin
    let teamToNotify = ["jj"];
    const isImmigration = (
      courtType === "eoir" ||
      /uscis|i-130|i-485|i-765|i-589|i-131|i-90|green card|visa|naturalization|citizenship|daca|asylum|removal|deportation|nta|bia|eoir|immigration court|a-number/i.test(m)
    );
    const isPI = /accident|injury|personal injury|car crash|slip and fall|hospital|medical bill|bodily injury/.test(m);
    const isLitigation = /litigation|eviction|unlawful detainer|real estate|business dispute|contract|breach|lawsuit|civil case|demurrer|estate plan|trust|probate/.test(m);

    if (isImmigration)              teamToNotify = ["jj", "jue"];
    else if (isPI || isLitigation)  teamToNotify = ["jj", "lin"];
    else                            teamToNotify = ["jj", "chandler"];

    // ── Step 4: Call Claude with full context ────────────────
    const systemWithDeadlines = PARALEGAL_SYSTEM_PROMPT + deadlineBlock;

    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-20250514",
        max_tokens: 2000,
        system:     systemWithDeadlines,
        messages:   [{ role: "user", content: message }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 30000,
      }
    );

    const claudeReply = resp.data.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();

    // ── Step 5: Auto-create MyCase tasks for CRITICAL deadlines ──
    const criticalDeadlines = deadlines.filter(d => d.priority === "CRITICAL" || d.priority === "HIGH");
    const mycaseResults = [];

    if (MYCASE_API_KEY && criticalDeadlines.length > 0) {
      // Extract case name from message (best effort)
      const caseNameMatch = message.match(/([A-Z][a-z]+ (?:v\.?|vs\.?) [A-Z][a-z]+)/i) ||
                            message.match(/([A-Z][a-z]+(?: [A-Z][a-z]+)+)/);
      const caseName = caseNameMatch ? caseNameMatch[1] : null;

      if (caseName) {
        for (const dl of criticalDeadlines.slice(0, 3)) { // max 3 tasks auto-created
          if (dl.date && dl.date !== "ASAP — as soon as retained" && dl.date !== "Before filing" && !dl.date.includes("days before")) {
            const dueDateRaw = new Date(dl.date);
            if (!isNaN(dueDateRaw)) {
              const dueDate = dueDateRaw.toISOString().split("T")[0];
              const result = await createMyCaseTask(
                caseName,
                dl.label.replace(/[⚠️📅📋💰✈️⏱️]/u, "").trim(),
                dueDate,
                dl.note
              );
              mycaseResults.push({ label: dl.label, ...result });
            }
          }
        }
      }
    }

    // ── Step 6: Send team notification email ─────────────────
    let emailSent = false;
    if (teamToNotify.length > 1) { // Only notify if someone besides JJ
      const emailBody = `
Zara Paralegal Alert — ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT

JJ's instruction: "${message}"

${claudeReply}

${criticalDeadlines.length > 0 ? `\nCRITICAL DEADLINES:\n${criticalDeadlines.map(d => `• ${d.label}: ${d.date}\n  ${d.note}`).join("\n")}` : ""}

${mycaseResults.length > 0 ? `\nMyCase tasks created:\n${mycaseResults.map(r => `• ${r.label}: ${r.success ? "✅ Created" : "❌ " + r.error}`).join("\n")}` : ""}

---
This notification was sent automatically by Zara.
Reply to JJ Zhang at jj@tezlawfirm.com with any questions.
`.trim();

      // Extract case name/number for subject
      const caseRef = message.match(/[A-Z]{2,}[\w\d]+/) || message.match(/\d+:\d{2}-\w+-\d+/);
      const subject = caseRef ? `Case Update: ${caseRef[0]}` : "New Case Update";

      emailSent = await notifyTeam(subject, emailBody, teamToNotify);
    }

    // ── Step 7: Build final response for JJ ─────────────────
    let finalReply = claudeReply;

    if (mycaseResults.length > 0) {
      const mcSummary = mycaseResults.map(r =>
        `${r.success ? "✅" : "❌"} MyCase: ${r.label.replace(/[⚠️📅📋💰✈️⏱️]/u, "").trim()} ${r.success ? "(task created)" : "— " + r.error}`
      ).join("\n");
      finalReply += `\n\n──────────────\n${mcSummary}`;
    }

    if (teamToNotify.length > 1) {
      const notified = teamToNotify
        .filter(t => t !== "jj")
        .map(t => ({ jue: "Jue Wang", michael: "Michael Liu", lin: "Lin Mei", chandler: "Chandler Jin" }[t] || t))
        .join(", ");
      finalReply += emailSent
        ? `\n📧 Team notified: ${notified}`
        : `\n⚠️ Team notification failed — please email ${notified} manually`;
    }

    return finalReply;

  } catch (err) {
    console.error("[paralegal] Handler error:", err.response?.data || err.message);
    return `❌ Paralegal error: ${err.message}\n\nPlease check your input and try again, or call the team directly.`;
  }
}

// ============================================================
//  EXPORTS
// ============================================================
module.exports = {
  isParalegalCommand,
  handleParalegalCommand,
  calcCCPDeadlines,
  calcEOIRDeadlines,
  calcFederalDeadlines,
  notifyTeam,
  createMyCaseTask,
  createMyCaseNote,
};
