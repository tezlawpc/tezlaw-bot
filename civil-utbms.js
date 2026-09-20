// ============================================================
//  TEZ LAW P.C. — UTBMS / LEDES BILLING CODE SETS
//  ─────────────────────────────────────────────────────────
//  The ABA/UTBMS Litigation Code Set is how every Am Law firm
//  and every corporate or insurance client codes litigation
//  time. Adopting it here buys three things at once:
//
//    1. Phase budgets that reconcile against what clients
//       expect to see (budget vs. actual by L-phase).
//    2. LEDES 1998B invoice export, which is what corporate
//       and insurance clients require in place of a PDF.
//    3. A vocabulary for the matter lifecycle that already
//       exists in the profession, rather than one we invent.
//
//  Structure: PHASE (L1..L6) > TASK (L140) > ACTIVITY (A103).
//  Expenses carry an E-code instead of a task/activity pair.
//
//  Sources: ABA Litigation Code Set; LEDES Oversight Committee
//  (utbms.com, ledes.org); DRI revised 2007 set; EDRM eDiscovery
//  code set. Phase-header codes (L100, L200, E100) are grouping
//  nodes and are NOT valid on an invoice line — only leaf codes.
// ============================================================

// ── Litigation task codes ───────────────────────────────────
// `phase` is the two-character grouping an e-billing platform
// buckets the line into. `stages` maps the code onto this app's
// own lifecycle stages, so a time entry logged from a stage
// workspace can default to a sensible code.

const TASK_PHASES = [
  {
    key: "L100", label: "Case Assessment, Development and Administration",
    short: "Case Assessment",
    // L100 is cross-cutting, not merely early: strategy, budgeting and
    // settlement recur through the whole matter, including during trial prep.
    crossCutting: true,
    stages: ["intake", "pre_filing"],
  },
  { key: "L200", label: "Pre-Trial Pleadings and Motions", short: "Pleadings & Motions",
    stages: ["pleadings", "motions"] },
  { key: "L300", label: "Discovery", short: "Discovery",
    stages: ["discovery"] },
  { key: "L400", label: "Trial Preparation and Trial", short: "Trial Prep & Trial",
    stages: ["trial_prep", "trial", "post_trial"] },
  { key: "L500", label: "Appeal", short: "Appeal",
    stages: ["post_trial"] },
  { key: "L600", label: "eDiscovery", short: "eDiscovery",
    // The L600 series is the EDRM/LOC eDiscovery set, NOT ADR. ADR lives at
    // L160 inside L100. This is the single most common misreading of UTBMS.
    stages: ["discovery"] },
];

const TASK_CODES = [
  // ── L100 ──
  { code: "L110", phase: "L100", label: "Fact Investigation/Development" },
  { code: "L120", phase: "L100", label: "Analysis/Strategy" },
  { code: "L130", phase: "L100", label: "Experts/Consultants" },
  { code: "L140", phase: "L100", label: "Document/File Management" },
  { code: "L150", phase: "L100", label: "Budgeting" },
  { code: "L160", phase: "L100", label: "Settlement/Non-Binding ADR" },
  { code: "L190", phase: "L100", label: "Other Case Assessment, Development and Administration" },

  // ── L200 ──
  { code: "L210", phase: "L200", label: "Pleadings" },
  { code: "L220", phase: "L200", label: "Preliminary Injunctions/Provisional Remedies" },
  { code: "L230", phase: "L200", label: "Court Mandated Conferences" },
  { code: "L240", phase: "L200", label: "Dispositive Motions" },
  { code: "L250", phase: "L200", label: "Other Written Motions and Submissions" },
  { code: "L260", phase: "L200", label: "Class Action Certification and Notice" },

  // ── L300 ──
  { code: "L310", phase: "L300", label: "Written Discovery" },
  { code: "L320", phase: "L300", label: "Document Production" },
  { code: "L330", phase: "L300", label: "Depositions" },
  { code: "L340", phase: "L300", label: "Expert Discovery" },
  { code: "L350", phase: "L300", label: "Discovery Motions" },
  // L360 is in the DRI-revised set and most vendor sets; kept as optional.
  { code: "L360", phase: "L300", label: "Discovery On-Site Inspections", optional: true },
  { code: "L390", phase: "L300", label: "Other Discovery" },

  // ── L400 ──
  { code: "L410", phase: "L400", label: "Fact Witnesses" },
  { code: "L420", phase: "L400", label: "Expert Witnesses" },
  { code: "L430", phase: "L400", label: "Written Motions and Submissions" },
  { code: "L440", phase: "L400", label: "Other Trial Preparation and Support" },
  { code: "L450", phase: "L400", label: "Trial and Hearing Attendance" },
  { code: "L460", phase: "L400", label: "Post-Trial Motions and Submissions" },
  { code: "L470", phase: "L400", label: "Enforcement" },

  // ── L500 ──
  { code: "L510", phase: "L500", label: "Appellate Motions and Submissions" },
  { code: "L520", phase: "L500", label: "Appellate Briefs" },
  { code: "L530", phase: "L500", label: "Oral Argument" },

  // ── L600 eDiscovery (EDRM lifecycle) ──
  { code: "L601", phase: "L600", label: "Discovery planning" },
  { code: "L602", phase: "L600", label: "Interviews" },
  { code: "L610", phase: "L600", label: "Preservation" },
  { code: "L611", phase: "L600", label: "Preservation order" },
  { code: "L612", phase: "L600", label: "Legal hold" },
  { code: "L620", phase: "L600", label: "Collection" },
  { code: "L621", phase: "L600", label: "Collection/Recovery" },
  { code: "L622", phase: "L600", label: "Media costs" },
  { code: "L623", phase: "L600", label: "Media/ESI Transfer, Receipt, Inventory" },
  { code: "L630", phase: "L600", label: "Processing" },
  { code: "L631", phase: "L600", label: "ESI stage, preparation and process" },
  { code: "L632", phase: "L600", label: "Scanning – Hard Copy" },
  { code: "L633", phase: "L600", label: "Foreign language translation" },
  { code: "L634", phase: "L600", label: "Exception handling" },
  { code: "L650", phase: "L600", label: "Review" },
  { code: "L651", phase: "L600", label: "Hosting costs" },
  { code: "L652", phase: "L600", label: "Objective and Subjective coding" },
  { code: "L653", phase: "L600", label: "First pass document review" },
  { code: "L654", phase: "L600", label: "Second pass document review" },
  { code: "L655", phase: "L600", label: "Privilege review" },
  { code: "L656", phase: "L600", label: "Redaction" },
  { code: "L660", phase: "L600", label: "Analysis" },
  { code: "L670", phase: "L600", label: "Production" },
  { code: "L671", phase: "L600", label: "Conversion of ESI to production format" },
  { code: "L680", phase: "L600", label: "Presentation" },
  { code: "L690", phase: "L600", label: "Project Management" },
];

// ── Activity codes ──────────────────────────────────────────
// A101-A111 is the ABA set most US e-billing systems validate
// against. A112+ come from the LOC 2013 revision; a client's
// billing guidelines decide which set is in play, so both are
// here and the extended ones are flagged.
const ACTIVITY_CODES = [
  { code: "A101", label: "Plan and prepare for" },
  { code: "A102", label: "Research" },
  { code: "A103", label: "Draft/revise" },
  { code: "A104", label: "Review/analyze" },
  { code: "A105", label: "Communicate (in firm)" },
  { code: "A106", label: "Communicate (with client)" },
  { code: "A107", label: "Communicate (other outside counsel)" },
  { code: "A108", label: "Communicate (other external)" },
  { code: "A109", label: "Appear for/attend" },
  { code: "A110", label: "Manage data/files" },
  { code: "A111", label: "Other" },
  { code: "A112", label: "Billable Travel Time", extended: true },
  { code: "A113", label: "Communicate (witnesses)", extended: true },
  { code: "A114", label: "Communicate (experts)", extended: true },
  { code: "A115", label: "Medical Record and Medical Bill Management", extended: true },
  { code: "A116", label: "Training", extended: true },
  { code: "A117", label: "Special Handling Copying/Scanning/Imaging (Internal)", extended: true },
  { code: "A118", label: "Collection-Forensic", extended: true },
  { code: "A119", label: "Culling & Filtering", extended: true },
  { code: "A120", label: "Processing", extended: true },
  { code: "A121", label: "Review and Analysis", extended: true },
  { code: "A122", label: "Quality Assurance and Control", extended: true },
  { code: "A123", label: "Search Creation and Execution", extended: true },
  { code: "A124", label: "Privilege Review Culling and Log Creation", extended: true },
  { code: "A125", label: "Document Production Creation and Preparation", extended: true },
  { code: "A126", label: "Evidence/Exhibit Creation and Preparation", extended: true },
  { code: "A127", label: "Project Management", extended: true },
  { code: "A128", label: "Collection Closing Activities", extended: true },
];

// ── Expense codes ───────────────────────────────────────────
const EXPENSE_CODES = [
  { code: "E101", label: "Copying" },
  { code: "E102", label: "Outside printing" },
  { code: "E103", label: "Word processing" },
  { code: "E104", label: "Facsimile" },
  { code: "E105", label: "Telephone" },
  { code: "E106", label: "Online research" },
  { code: "E107", label: "Delivery services/messengers" },
  { code: "E108", label: "Postage" },
  { code: "E109", label: "Local travel" },
  { code: "E110", label: "Out-of-town travel" },
  { code: "E111", label: "Meals" },
  { code: "E112", label: "Court fees" },
  { code: "E113", label: "Subpoena fees" },
  { code: "E114", label: "Witness fees" },
  { code: "E115", label: "Deposition transcripts" },
  { code: "E116", label: "Trial transcripts" },
  { code: "E117", label: "Trial exhibits" },
  { code: "E118", label: "Litigation support vendors" },
  { code: "E119", label: "Experts" },
  { code: "E120", label: "Private investigators" },
  { code: "E121", label: "Arbitrators/mediators" },
  { code: "E122", label: "Local counsel" },
  { code: "E123", label: "Other professionals" },
  { code: "E124", label: "Other" },
];

// ── Lookups ─────────────────────────────────────────────────
const TASK_BY_CODE = new Map(TASK_CODES.map(t => [t.code, t]));
const PHASE_BY_KEY = new Map(TASK_PHASES.map(p => [p.key, p]));
const ACTIVITY_BY_CODE = new Map(ACTIVITY_CODES.map(a => [a.code, a]));
const EXPENSE_BY_CODE = new Map(EXPENSE_CODES.map(e => [e.code, e]));

function isValidTaskCode(c) { return TASK_BY_CODE.has(String(c || "").toUpperCase()); }
function isValidActivityCode(c) { return ACTIVITY_BY_CODE.has(String(c || "").toUpperCase()); }
function isValidExpenseCode(c) { return EXPENSE_BY_CODE.has(String(c || "").toUpperCase()); }

// The phase a task code rolls up to, e.g. "L320" -> "L300".
function phaseOf(taskCode) {
  const t = TASK_BY_CODE.get(String(taskCode || "").toUpperCase());
  return t ? t.phase : null;
}

function taskLabel(code) {
  const t = TASK_BY_CODE.get(String(code || "").toUpperCase());
  return t ? t.label : String(code || "");
}
function phaseLabel(key) {
  const p = PHASE_BY_KEY.get(String(key || "").toUpperCase());
  return p ? p.label : String(key || "");
}

// Task codes that make sense to offer from a given lifecycle stage. The stage
// workspaces use this to put a short, relevant picker in front of a timekeeper
// instead of the full 50-code list.
function codesForStage(stageKey) {
  const phases = TASK_PHASES.filter(p => (p.stages || []).includes(stageKey)).map(p => p.key);
  const inPhase = TASK_CODES.filter(t => phases.includes(t.phase));
  // L120 Analysis/Strategy, L150 Budgeting and L160 Settlement recur at every
  // stage of a matter, so they are always offered.
  const always = ["L120", "L150", "L160"];
  const extra = TASK_CODES.filter(t => always.includes(t.code) && !inPhase.includes(t));
  return [...inPhase, ...extra];
}

// The code a stage should default to when someone logs time from it.
const STAGE_DEFAULT_TASK = {
  intake:     "L120",  // Analysis/Strategy
  pre_filing: "L110",  // Fact Investigation/Development
  pleadings:  "L210",  // Pleadings
  discovery:  "L310",  // Written Discovery
  motions:    "L250",  // Other Written Motions and Submissions
  trial_prep: "L440",  // Other Trial Preparation and Support
  trial:      "L450",  // Trial and Hearing Attendance
  post_trial: "L460",  // Post-Trial Motions and Submissions
  closed:     "L140",  // Document/File Management
};

// ═══════════════════════════════════════════════════════════
//  LEDES 1998B EXPORT
//  ─────────────────────────────────────────────────────────
//  Pipe-delimited, 24 fields, one header row naming the fields
//  then one row per line item. A fee line carries a task code
//  and an activity code with a blank expense code; an expense
//  line carries an expense code with the other two blank.
// ═══════════════════════════════════════════════════════════

const LEDES_1998B_FIELDS = [
  "INVOICE_DATE", "INVOICE_NUMBER", "CLIENT_ID", "LAW_FIRM_MATTER_ID", "INVOICE_TOTAL",
  "BILLING_START_DATE", "BILLING_END_DATE", "INVOICE_DESCRIPTION", "LINE_ITEM_NUMBER",
  "EXP/FEE/INV_ADJ_TYPE", "LINE_ITEM_NUMBER_OF_UNITS", "LINE_ITEM_ADJUSTMENT_AMOUNT",
  "LINE_ITEM_TOTAL", "LINE_ITEM_DATE", "LINE_ITEM_TASK_CODE", "LINE_ITEM_EXPENSE_CODE",
  "LINE_ITEM_ACTIVITY_CODE", "TIMEKEEPER_ID", "LINE_ITEM_DESCRIPTION", "LAW_FIRM_ID",
  "LINE_ITEM_UNIT_COST", "TIMEKEEPER_NAME", "TIMEKEEPER_CLASSIFICATION", "CLIENT_MATTER_ID",
];

function ledesDate(d) {
  if (!d) return "";
  const t = new Date(d);
  if (isNaN(t)) return "";
  return t.toISOString().slice(0, 10).replace(/-/g, "");   // YYYYMMDD
}
// Pipes and newlines are the record separators; a stray one in a narrative
// would corrupt the file, so they are flattened rather than escaped.
function ledesText(s) {
  return String(s == null ? "" : s).replace(/[|\r\n]+/g, " ").trim();
}
function ledesNum(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

/**
 * Build a LEDES 1998B file.
 *
 * invoice: { invoice_number, invoice_date, client_id, client_matter_id,
 *            law_firm_matter_id, law_firm_id, billing_start, billing_end,
 *            description }
 * lines:   [{ kind:'F'|'E', date, units, adjustment, total, unit_cost,
 *             task_code, activity_code, expense_code, description,
 *             timekeeper_id, timekeeper_name, timekeeper_classification }]
 */
function buildLedes1998B(invoice, lines) {
  const inv = invoice || {};
  const rows = [];
  rows.push(LEDES_1998B_FIELDS.join("|"));

  const total = (lines || []).reduce((sum, l) => sum + (Number(l.total) || 0), 0);

  (lines || []).forEach((l, idx) => {
    const isExpense = l.kind === "E";
    rows.push([
      ledesDate(inv.invoice_date),
      ledesText(inv.invoice_number),
      ledesText(inv.client_id),
      ledesText(inv.law_firm_matter_id),
      ledesNum(inv.invoice_total != null ? inv.invoice_total : total),
      ledesDate(inv.billing_start),
      ledesDate(inv.billing_end),
      ledesText(inv.description),
      String(idx + 1),
      isExpense ? "E" : "F",
      ledesNum(l.units),
      ledesNum(l.adjustment || 0),
      ledesNum(l.total),
      ledesDate(l.date),
      isExpense ? "" : ledesText(l.task_code),
      isExpense ? ledesText(l.expense_code) : "",
      isExpense ? "" : ledesText(l.activity_code),
      ledesText(l.timekeeper_id),
      ledesText(l.description),
      ledesText(inv.law_firm_id),
      ledesNum(l.unit_cost),
      ledesText(l.timekeeper_name),
      ledesText(l.timekeeper_classification),
      ledesText(inv.client_matter_id),
    ].join("|"));
  });

  // 1998B files are terminated with a trailing newline.
  return rows.join("\n") + "\n";
}

/**
 * Validate a would-be invoice line against the code sets, the way a client's
 * e-billing platform would before accepting it. Returns a list of problems.
 */
function validateLine(line) {
  const out = [];
  const l = line || {};
  if (l.kind === "E") {
    if (!l.expense_code) out.push("Expense line has no expense code");
    else if (!isValidExpenseCode(l.expense_code)) out.push(`Unknown expense code ${l.expense_code}`);
    if (l.task_code || l.activity_code) out.push("Expense line must not carry a task or activity code");
  } else {
    const tc = String(l.task_code || "").toUpperCase();
    // Phase headers are grouping nodes, so they are deliberately absent from
    // TASK_CODES. Name that explicitly rather than calling L300 "unknown".
    if (!l.task_code) out.push("Fee line has no task code");
    else if (PHASE_BY_KEY.has(tc)) out.push(`${tc} is a phase header, not a billable task code`);
    else if (!isValidTaskCode(tc)) out.push(`Unknown task code ${l.task_code}`);
    if (!l.activity_code) out.push("Fee line has no activity code");
    else if (!isValidActivityCode(l.activity_code)) out.push(`Unknown activity code ${l.activity_code}`);
    if (l.expense_code) out.push("Fee line must not carry an expense code");
  }
  if (!l.date) out.push("Line has no date");
  if (!(Number(l.total) > 0)) out.push("Line has no positive total");
  if (!String(l.description || "").trim()) out.push("Line has no narrative");
  return out;
}

module.exports = {
  TASK_PHASES, TASK_CODES, ACTIVITY_CODES, EXPENSE_CODES,
  STAGE_DEFAULT_TASK,
  isValidTaskCode, isValidActivityCode, isValidExpenseCode,
  phaseOf, taskLabel, phaseLabel, codesForStage,
  LEDES_1998B_FIELDS, buildLedes1998B, validateLine,
};
