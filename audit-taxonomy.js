// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-taxonomy.js — DOCUMENT BRACKET / CATEGORY MASTER
//  ─────────────────────────────────────────────────────────
//  This file is the single source of truth for:
//    1. The 13 document "brackets" (top-level sections)
//    2. The ~150 document categories inside them
//    3. The designated folder path each category files into
//    4. Which checklist tier each category belongs to
//       (monthly / quarterly / annual / event-driven / S-1)
//    5. The PCAOB / SEC authority that makes the document
//       necessary — shown to the auditor and to management so
//       neither side has to argue about why an item is on the list
//    6. The keyword weights the classifier uses to auto-route
//       an uploaded file without anybody picking a folder
//
//  Issuer profile this taxonomy is tuned to (verified on EDGAR,
//  Sept 2026 — see NIGHTFOOD_AUDIT_README.md for citations):
//    CIK 0001593001 · NGTF · Nevada · FYE JUNE 30
//    Non-accelerated filer · Smaller reporting company
//    NOT an emerging growth company  → AS 3101 CAMs DO apply
//    No SOX 404(b) auditor attestation (Dodd-Frank 989G)
//    Going-concern substantial doubt (FY2024 + FY2025)
//    Auditor: TAAD LLP (from Oct 28 2025) · Predecessor: Fruci
//    Segments: Foodservice Packaging (SWC/CarryOutSupplies),
//      Robotics-as-a-Service (TechForce/RoboOp365), Hospitality
//      Asset Ownership (hotels), Snack & Bev (discontinued 6/30/25)
//
//  CHANGING THIS FILE changes the checklists, the folders and the
//  classifier all at once. Nothing else needs editing.
// ============================================================

// ── Checklist tiers ─────────────────────────────────────────
// monthly   = every monthly close (12x/yr)
// quarterly = Q1/Q2/Q3 AS 4105 interim review package
// annual    = FY audit PBC package
// event     = triggered by a transaction, not a calendar date
// s1        = registration-statement / bring-down package (AS 4101)
const TIERS = ["monthly", "quarterly", "annual", "event", "s1"];

// ── Brackets ────────────────────────────────────────────────
const BRACKETS = [
  {
    code: "A",
    key: "governance",
    label: "Governance & Entity Records",
    folder: "A-Governance",
    color: "#1F3A5F",
    blurb:
      "Minutes, charters, organizational documents and the conflict/ethics record. " +
      "AS 4105 and AS 2410 both require the auditor to READ minutes every period — " +
      "missing minutes is the single most common cause of an incomplete interim review.",
  },
  {
    code: "B",
    key: "close",
    label: "Financial Close & General Ledger",
    folder: "B-Close-and-GL",
    color: "#2C5F8A",
    blurb:
      "Trial balance, full GL and journal-entry detail, account reconciliations, " +
      "flux analysis and the close binder. AS 2401 requires the auditor to examine " +
      "journal entries and other adjustments; AS 4105 requires evidence that the " +
      "interim figures reconcile to the accounting records.",
  },
  {
    code: "C",
    key: "cash",
    label: "Cash & Treasury",
    folder: "C-Cash-and-Treasury",
    color: "#17706E",
    blurb:
      "Bank statements, reconciliations, the complete account listing and confirmation " +
      "authorizations. Under AS 2310 (effective FY ending on/after 6/15/2025) cash held " +
      "by third parties must be confirmed or obtained directly from the external source.",
  },
  {
    code: "D",
    key: "revenue",
    label: "Revenue, Receivables & Customer Contracts",
    folder: "D-Revenue-and-AR",
    color: "#1C7C54",
    blurb:
      "AR aging and CECL, revenue contracts and side letters, ASC 606 analyses and " +
      "deferred revenue. AS 2401 presumes a fraud risk in revenue recognition; AS 2310 " +
      "requires receivable confirmation unless non-feasibility is documented.",
  },
  {
    code: "E",
    key: "inventory",
    label: "Inventory & Cost of Sales",
    folder: "E-Inventory",
    color: "#6B8E23",
    blurb:
      "Priced listings, physical count evidence, standard-cost build-ups and the " +
      "excess-and-obsolete reserve. Primary relevance: the Foodservice Packaging " +
      "Distribution segment (SWC Group / CarryOutSupplies.com).",
  },
  {
    code: "F",
    key: "assets",
    label: "Fixed Assets, Leases & Hospitality Real Estate",
    folder: "F-Fixed-Assets-and-Leases",
    color: "#8A6D1F",
    blurb:
      "PP&E and CIP rollforwards, ASC 842 lease schedules, and the hotel property " +
      "files (title, appraisals, mortgage, PIP/capex, STR reports, franchise agreements). " +
      "Tuned to the Hospitality Asset Ownership segment and the RaaS robot fleet.",
  },
  {
    code: "G",
    key: "debt",
    label: "Debt, Convertibles & Derivatives",
    folder: "G-Debt-and-Derivatives",
    color: "#9C4221",
    blurb:
      "Debt agreements, amortization and covenant compliance, convertible notes, " +
      "bifurcation analyses and warrant valuations. Highest-risk bracket for this " +
      "issuer: ASC 815-40/480 classification errors are the most frequent restatement " +
      "cause at micro-cap issuers and feed directly into the going-concern conclusion.",
  },
  {
    code: "H",
    key: "equity",
    label: "Equity & Share-Based Compensation",
    folder: "H-Equity-and-SBC",
    color: "#6B21A8",
    blurb:
      "Cap table and transfer-agent reports, option/warrant/RSU registers, board grant " +
      "approvals, ASC 718 valuation inputs and 409A reports. Share count moved from " +
      "151.9M (Oct 2025) to 507.5M (May 2026) — the share-count proof to the transfer " +
      "agent is a required tie-out every single close, not annually.",
  },
  {
    code: "I",
    key: "payroll_tax",
    label: "Payroll, Tax & Related Parties",
    folder: "I-Payroll-Tax-Related-Parties",
    color: "#B45309",
    blurb:
      "Payroll registers and filings, income/sales/franchise tax, the ASC 740 provision, " +
      "and the AS 2410 related-party population including insider loans. Related-party " +
      "completeness is a leading uplisting restatement trigger; SOX 402 prohibits " +
      "personal loans to executives outright.",
  },
  {
    code: "J",
    key: "estimates",
    label: "Estimates, Valuations & Going Concern",
    folder: "J-Estimates-and-Going-Concern",
    color: "#A21CAF",
    blurb:
      "Every AS 2501 estimate with its method, data and significant assumptions, plus " +
      "impairment analyses, specialist reports and the going-concern package. Because " +
      "the FY2024 and FY2025 opinions carried a substantial-doubt paragraph, the ASC " +
      "205-40 assessment and cash-runway forecast refresh EVERY close, not annually.",
  },
  {
    code: "K",
    key: "legal",
    label: "Legal, Regulatory & Litigation",
    folder: "K-Legal-and-Regulatory",
    color: "#991B1B",
    blurb:
      "Management's litigation evaluation, AS 2505 audit inquiry letters and counsel " +
      "responses, settlements, demand letters and SEC/regulatory correspondence. A " +
      "lawyer's refusal to respond is a scope limitation that precludes an unqualified " +
      "opinion, so these are gating items, not supporting ones.",
  },
  {
    code: "L",
    key: "reporting",
    label: "SEC Reporting, Controls & Audit Deliverables",
    folder: "L-SEC-Reporting-and-Controls",
    color: "#374151",
    blurb:
      "Draft 10-K/10-Q and XBRL, Section 302/906 certifications and sub-certifications, " +
      "management's 404(a) ICFR assessment, the engagement letter, representation " +
      "letters, audit committee communications and consents. The AS 2805 rep letter and " +
      "the AS 4105 quarterly rep letter are hard gates: without them the review is " +
      "incomplete and the filing cannot go out.",
  },
  {
    code: "M",
    key: "mna",
    label: "Business Combinations & Acquired Businesses",
    folder: "M-Business-Combinations",
    color: "#0E7490",
    blurb:
      "Purchase agreements, ASC 805 purchase-price allocations, and the Rule 3-05/8-04 " +
      "audited financial statements and Article 11 pro formas that must be filed by " +
      "Form 8-K/A within 71 days. Live matters: Victorville Treasure Holdings, Skytech/" +
      "Future Hospitality, and the June 2026 Jiun Jiang (Taiwan) LOI.",
  },
];

const BRACKET_BY_CODE = {};
BRACKETS.forEach((b) => (BRACKET_BY_CODE[b.code] = b));

// ── Categories ──────────────────────────────────────────────
// Field guide:
//   code        stable ID — NEVER renumber, checklists key off it
//   bracket     parent bracket code
//   label       human label, used as the folder leaf name
//   tiers       which checklists this appears on
//   authority   PCAOB/SEC citations shown in the UI
//   strong      near-decisive classifier tokens (weight 10)
//   kw          supporting classifier tokens (weight 3)
//   neg         tokens that disqualify this category (weight -8)
//   gate        true = filing/report cannot issue without it
//   conf        true = restricted visibility (privileged / PII)
//   owner       default responsible role at the company
//   assertions  audit assertions the document supports
const CATEGORIES = [
  // ══════════════════ A — GOVERNANCE ══════════════════
  {
    code: "A-010",
    bracket: "A",
    label: "Board of Directors Minutes & Written Consents",
    tiers: ["monthly", "quarterly", "annual", "s1"],
    authority: ["AS 4105.15", "AS 2410.07", "AS 2401", "AS 4101.10"],
    strong: ["board minutes", "minutes of the board", "board of directors minutes", "unanimous written consent", "board resolution"],
    kw: ["board", "minutes", "consent", "resolution", "directors", "bod"],
    neg: ["audit committee", "compensation committee", "shareholder", "stockholder", "equity grant", "approving equity", "approving grants", "option grant"],
    gate: true,
    owner: "corporate_secretary",
    assertions: ["completeness", "presentation"],
    note:
      "The auditor must READ minutes every interim period and through the report date. " +
      "If minutes are not yet approved, upload the draft or a management summary — an " +
      "unapproved draft is acceptable evidence; a missing period is not.",
  },
  {
    code: "A-020",
    bracket: "A",
    label: "Audit Committee Minutes & Written Consents",
    tiers: ["monthly", "quarterly", "annual", "s1"],
    authority: ["AS 1301", "AS 2410.07", "Rule 10A-3", "Nasdaq 5605(c)"],
    strong: ["audit committee minutes", "audit committee meeting", "audit committee consent"],
    kw: ["audit committee", "ac minutes", "committee minutes"],
    neg: ["compensation committee", "nominating"],
    gate: true,
    owner: "corporate_secretary",
    assertions: ["completeness", "presentation"],
    note:
      "AS 1301 requires all audit committee communications BEFORE report issuance, and " +
      "AS 3101 draws critical audit matters from that same population — so this record " +
      "is the source evidence for CAMs. CAMs apply to NGTF because it is not an EGC.",
  },
  {
    code: "A-030",
    bracket: "A",
    label: "Compensation & Nominating Committee Minutes",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2110.10A", "AS 2410.07", "Nasdaq 5605(d)", "Nasdaq 5605(e)"],
    strong: ["compensation committee", "nominating committee", "nominating and corporate governance"],
    kw: ["comp committee", "governance committee", "nominating"],
    neg: [],
    owner: "corporate_secretary",
    assertions: ["completeness"],
    note: "Feeds the AS 2110.10A assessment of compensation arrangements that create incentives.",
  },
  {
    code: "A-040",
    bracket: "A",
    label: "Shareholder Meeting Minutes, Consents & Information Statements",
    tiers: ["quarterly", "annual", "event"],
    authority: ["AS 4105.15", "Nasdaq 5620(b)", "Nasdaq 5635"],
    strong: ["shareholder meeting", "stockholder meeting", "annual meeting of stockholders", "def 14c", "pre 14c", "information statement", "written consent of stockholders"],
    kw: ["shareholder", "stockholder", "14c", "14a", "proxy statement"],
    neg: [],
    owner: "corporate_secretary",
    assertions: ["completeness", "presentation"],
    note:
      "UPLISTING FLAG: NGTF has been acting by written consent of a controlling holder " +
      "(PRE 14C 10/10/2025, DEF 14C 10/24/2025). Nasdaq Rule 5620(b) requires proxy " +
      "SOLICITATION for shareholder meetings, so the 14C-by-consent practice has to " +
      "change at listing. Track this as a governance remediation item.",
  },
  {
    code: "A-050",
    bracket: "A",
    label: "Charters — Audit, Compensation, Nominating Committees",
    tiers: ["annual", "s1"],
    authority: ["AS 1301.04", "Rule 10A-3", "Nasdaq 5605(c)(1)"],
    strong: ["audit committee charter", "committee charter", "compensation committee charter"],
    kw: ["charter"],
    neg: ["articles", "certificate of incorporation"],
    owner: "corporate_secretary",
    assertions: ["presentation"],
    note: "Nasdaq 5605(c)(1) requires a written audit committee charter reviewed annually.",
  },
  {
    code: "A-060",
    bracket: "A",
    label: "Articles, Bylaws, Certificates of Designation & Amendments",
    tiers: ["annual", "event", "s1"],
    authority: ["Reg S-K 601(b)(3)", "AS 2110"],
    strong: ["articles of incorporation", "certificate of incorporation", "certificate of designation", "bylaws", "articles of amendment", "certificate of amendment"],
    kw: ["articles", "bylaws", "designation", "charter document", "nevada secretary of state"],
    neg: ["committee charter"],
    owner: "corporate_secretary",
    assertions: ["presentation", "rights_obligations"],
    note:
      "Certificates of designation for each preferred series are required to test equity " +
      "classification and any reverse-split mechanics contemplated for the uplisting.",
  },
  {
    code: "A-070",
    bracket: "A",
    label: "Organization Chart, Legal Entity Chart & Subsidiary List",
    tiers: ["annual", "s1"],
    authority: ["AS 2110.07", "AS 1201 App B", "Reg S-K 601(b)(21)"],
    strong: ["organization chart", "org chart", "legal entity chart", "subsidiary list", "list of subsidiaries"],
    kw: ["entity structure", "corporate structure", "subsidiaries", "org structure"],
    neg: [],
    owner: "cfo",
    assertions: ["completeness", "presentation"],
    note:
      "Drives scoping and the AS 1201 Appendix B / AS 1206 analysis if any component is " +
      "audited by another firm — relevant to the Taiwan (Jiun Jiang) LOI.",
  },
  {
    code: "A-080",
    bracket: "A",
    label: "D&O Questionnaires & Annual Conflict-of-Interest Certifications",
    tiers: ["annual", "s1"],
    authority: ["AS 2410.05", "AS 2410.07", "Reg S-K 404", "Nasdaq 5630"],
    strong: ["d&o questionnaire", "director and officer questionnaire", "conflict of interest questionnaire", "conflict of interest certification"],
    kw: ["questionnaire", "conflict of interest", "d&o", "independence questionnaire"],
    neg: ["d&o insurance", "policy"],
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness", "presentation"],
    note:
      "AS 2410 names conflict-of-interest statements as a document the auditor must read " +
      "to test related-party COMPLETENESS. Also the primary source for Item 404 and " +
      "Nasdaq 5605(a)(2) independence determinations.",
  },
  {
    code: "A-090",
    bracket: "A",
    label: "Code of Conduct, Whistleblower Policy & Hotline Log",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2401.24", "AS 4105.18", "SOX 301", "Nasdaq 5610"],
    strong: ["code of conduct", "code of ethics", "whistleblower policy", "hotline log", "ethics complaint log"],
    kw: ["whistleblower", "hotline", "ethics", "code of business conduct", "complaint log"],
    neg: [],
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness"],
    note:
      "AS 4105 requires a quarterly inquiry about ALLEGATIONS of fraud, and the SOX 301 " +
      "complaint procedure is what generates the record. Upload a NIL return each quarter " +
      "if there were no complaints — silence is not evidence.",
  },
  {
    code: "A-100",
    bracket: "A",
    label: "Insider Trading Policy, Clawback Policy & Reg BTR Records",
    tiers: ["annual", "event"],
    authority: ["Reg S-K 408(b)", "Rule 10D-1", "Nasdaq 5608", "SOX 306 / Reg BTR"],
    strong: ["insider trading policy", "clawback policy", "compensation recovery policy", "blackout notice"],
    kw: ["clawback", "insider trading", "10d-1", "recoupment", "blackout"],
    neg: [],
    owner: "general_counsel",
    assertions: ["presentation"],
    note: "Nasdaq 5608 requires a compliant clawback policy — a listing-application document.",
  },
  {
    code: "A-110",
    bracket: "A",
    label: "Delegation of Authority & Signature Authority Matrix",
    tiers: ["annual"],
    authority: ["AS 2110.28", "AS 2401.65", "COSO 2013 Principle 3"],
    strong: ["delegation of authority", "signature authority", "approval matrix", "authorization matrix"],
    kw: ["doa", "signing authority", "spend authority"],
    neg: [],
    owner: "cfo",
    assertions: ["existence", "authorization"],
  },

  // ══════════════════ B — CLOSE & GL ══════════════════
  {
    code: "B-010",
    bracket: "B",
    label: "Trial Balance (Pre-Close, Adjusted & Final)",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 4105.15", "AS 1215.06", "Reg S-X 8-03"],
    strong: ["trial balance", "adjusted trial balance", "final trial balance", "tb "],
    kw: ["trial", "balance", "atb", "tb", "general ledger balances"],
    neg: ["bank", "aging"],
    gate: true,
    owner: "controller",
    assertions: ["accuracy", "completeness"],
    note:
      "AS 4105 requires evidence that the interim financial information RECONCILES to the " +
      "accounting records. The TB-to-10-Q tie-out is that evidence.",
  },
  {
    code: "B-020",
    bracket: "B",
    label: "General Ledger Detail (Full Period Download)",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2401.58", "AS 2401.61", "AS 1215.06"],
    strong: ["general ledger detail", "gl detail", "ledger detail", "gl download", "general ledger download"],
    kw: ["general ledger", "gl", "ledger", "account detail", "transaction detail"],
    neg: ["trial balance"],
    owner: "controller",
    assertions: ["completeness", "accuracy"],
    note:
      "Must be the COMPLETE population, not a sample. Export with account, date, amount, " +
      "source, description, user ID and reference so the auditor can run journal-entry " +
      "testing under AS 2401.58.",
  },
  {
    code: "B-030",
    bracket: "B",
    label: "Journal Entry Register with User ID, Dates & Approver",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2401.58", "AS 2401.61", "AS 2110.32"],
    strong: ["journal entry register", "journal entry listing", "je register", "je listing", "journal entries"],
    kw: ["journal", "entry", "je", "entries", "manual entries"],
    neg: [],
    owner: "controller",
    assertions: ["occurrence", "authorization", "cutoff"],
    note:
      "AS 2401 requires examination of journal entries with emphasis on entries made AT " +
      "or AFTER period end. The export must carry BOTH the entry date and the effective/" +
      "posting date plus the preparer and approver user IDs — an export without user IDs " +
      "does not satisfy the standard and will be rejected back to the company.",
  },
  {
    code: "B-040",
    bracket: "B",
    label: "Top-Side, Manual & Consolidating Entries with Support",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2401.58", "AS 2110.32", "AS 2401.65"],
    strong: ["top side", "topside", "topsided", "consolidating entries", "elimination entries", "manual journal"],
    kw: ["top-side", "adjusting entries", "eliminations", "consolidation entries", "post close"],
    neg: [],
    owner: "controller",
    assertions: ["occurrence", "authorization"],
    note: "Management-override risk concentrates here. Each entry needs a written rationale and an approver.",
  },
  {
    code: "B-050",
    bracket: "B",
    label: "Balance Sheet Account Reconciliations (All Accounts)",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.32", "AS 4105.15", "Rule 13a-15"],
    strong: ["account reconciliation", "balance sheet reconciliation", "account recs", "reconciliation package", "bs rec"],
    kw: ["reconciliation", "recon", "rec ", "tie out", "tieout"],
    neg: ["bank reconciliation", "intercompany"],
    owner: "controller",
    assertions: ["accuracy", "existence", "completeness"],
    note:
      "Every account, with a NAMED preparer and a NAMED reviewer and a documented " +
      "precision of review. An initial without evidence of what was examined does not " +
      "support the 302 certification.",
  },
  {
    code: "B-060",
    bracket: "B",
    label: "Flux / Variance Analysis with Written Driver Explanations",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 4105.15", "AS 2110.46", "Reg S-K 303"],
    strong: ["flux analysis", "variance analysis", "flux", "budget to actual", "variance report"],
    kw: ["variance", "flux", "vs prior", "month over month", "qoq", "yoy", "bridge"],
    neg: [],
    owner: "controller",
    assertions: ["accuracy", "presentation"],
    note:
      "The most-requested single item in an interim review and the raw material for MD&A. " +
      "Needs BOTH a dollar and a percentage threshold, and a business-driver explanation " +
      "for every flux over it — not a restatement of the number.",
  },
  {
    code: "B-070",
    bracket: "B",
    label: "Post-Close Adjustment Log & SAB 99 Materiality Analysis",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 1301.13", "SAB 99", "AS 2810.17"],
    strong: ["adjustment log", "audit adjustments", "passed adjustments", "sab 99", "materiality analysis", "summary of unadjusted differences", "sud schedule", "sad schedule"],
    kw: ["adjustment", "misstatement", "uncorrected", "waived", "materiality"],
    neg: [],
    owner: "controller",
    assertions: ["accuracy", "presentation"],
    note:
      "AS 1301 requires the auditor to give the audit committee the schedule of UNCORRECTED " +
      "misstatements with the basis for concluding they are immaterial. Management's own " +
      "log is the starting point.",
  },
  {
    code: "B-080",
    bracket: "B",
    label: "Monthly Close Checklist with Sign-Offs & Close Binder",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["Rule 13a-15(b)", "AS 2110.32", "COSO 2013"],
    strong: ["close checklist", "close calendar", "close binder", "month end close", "monthly close package"],
    kw: ["close", "checklist", "sign off", "signoff", "close package"],
    neg: [],
    owner: "controller",
    assertions: ["completeness"],
    note:
      "The period-end financial reporting process is an entity-level control the auditor " +
      "must understand under AS 2110.32 even with no ICFR audit. This IS that evidence.",
  },
  {
    code: "B-090",
    bracket: "B",
    label: "Consolidation Worksheet, Intercompany Matching & FX Translation",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.32", "ASC 830", "AS 1201 App B"],
    strong: ["consolidation worksheet", "consolidating schedule", "intercompany reconciliation", "intercompany matching", "cta proof", "currency translation"],
    kw: ["consolidation", "intercompany", "ic recon", "translation", "cta", "elimination"],
    neg: [],
    owner: "controller",
    assertions: ["accuracy", "completeness"],
    note: "Becomes materially more complex if the Jiun Jiang (Taiwan) transaction closes — TWD functional currency.",
  },
  {
    code: "B-100",
    bracket: "B",
    label: "Financial Statement Package (IS / BS / CF / Equity Rollforward)",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["Reg S-X 8-02", "Reg S-X 8-03", "AS 4105.15"],
    strong: ["financial statement package", "reporting package", "financial statements", "income statement", "balance sheet", "statement of cash flows"],
    kw: ["p&l", "profit and loss", "financials", "cash flow statement", "equity rollforward"],
    neg: ["draft 10-q", "draft 10-k", "audited"],
    owner: "controller",
    assertions: ["presentation", "accuracy"],
    note: "Include the indirect-method cash-flow proof tying to balance-sheet movements.",
  },
  {
    code: "B-110",
    bracket: "B",
    label: "Chart of Accounts & Accounting Policies Manual",
    tiers: ["annual"],
    authority: ["AS 2110.12", "AS 1301.10"],
    strong: ["chart of accounts", "accounting policies manual", "accounting manual", "policy manual"],
    kw: ["coa", "accounting policy", "policies and procedures"],
    neg: [],
    owner: "controller",
    assertions: ["presentation"],
  },
  {
    code: "B-120",
    bracket: "B",
    label: "Segment Reporting Schedules (ASC 280)",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 280", "Reg S-K 303", "AS 2110.46"],
    strong: ["segment reporting", "segment schedule", "segment disclosure", "asc 280", "segment footnote"],
    kw: ["segment", "reportable segment", "by segment", "cody", "chief operating decision"],
    neg: [],
    owner: "controller",
    assertions: ["presentation", "completeness"],
    note:
      "NGTF reports Foodservice Packaging Distribution and Robotics-as-a-Service, and the " +
      "Q3 FY2026 10-Q describes four business lines including Hospitality Asset Ownership " +
      "and the discontinued Snack & Beverage line. Segment composition changed mid-year, " +
      "so the prior-period recast must be documented.",
  },
  {
    code: "B-130",
    bracket: "B",
    label: "Discontinued Operations Analysis (ASC 205-20)",
    tiers: ["quarterly", "annual", "event"],
    authority: ["ASC 205-20", "Reg S-X 8-03", "AS 2110"],
    strong: ["discontinued operations", "asc 205-20", "held for sale", "disposal group"],
    kw: ["discontinued", "disposal", "exit", "wind down", "held-for-sale"],
    neg: [],
    owner: "controller",
    assertions: ["presentation", "classification"],
    note:
      "The Snack and Beverage line was discontinued as of June 30, 2025. Every interim " +
      "period through FY2027 needs the comparative recast and the ASC 205-20 classification memo.",
  },

  // ══════════════════ C — CASH & TREASURY ══════════════════
  {
    code: "C-010",
    bracket: "C",
    label: "Bank & Brokerage Statements (All Accounts, All Months)",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2310", "AS 2110.32", "AS 4105.15"],
    strong: ["bank statement", "account statement", "brokerage statement", "monthly statement"],
    kw: ["bank", "statement", "chase", "wells fargo", "bofa", "bank of america", "citi", "pnc", "mercury", "us bank"],
    neg: ["reconciliation", "confirmation"],
    owner: "controller",
    assertions: ["existence", "accuracy"],
    note: "Every account for every month, including zero-balance and closed accounts. Also the month AFTER period end.",
  },
  {
    code: "C-020",
    bracket: "C",
    label: "Bank Reconciliations with Outstanding Items Aging",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.32", "AS 4105.15", "Rule 13a-15"],
    strong: ["bank reconciliation", "bank rec", "cash reconciliation"],
    kw: ["reconciliation", "outstanding checks", "deposits in transit", "dit", "stale check"],
    neg: [],
    gate: true,
    owner: "controller",
    assertions: ["existence", "accuracy", "cutoff"],
    note: "Include the outstanding-check and deposit-in-transit aging with a stale-item review.",
  },
  {
    code: "C-030",
    bracket: "C",
    label: "Complete Bank / Brokerage / Custodial Account Listing",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2310.08", "AS 2310.14", "AS 2805.06"],
    strong: ["bank account listing", "list of bank accounts", "listing of all bank accounts", "listing of bank accounts", "all bank accounts", "bank account list", "account listing", "banking relationships"],
    kw: ["account list", "all accounts", "bank relationships", "signatories"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["completeness"],
    note:
      "Must include accounts OPENED and CLOSED during the period and zero-balance accounts, " +
      "with institution, account number (last 4), signatories and a contact for confirmation. " +
      "Completeness of the cash population is a management representation under AS 2805.",
  },
  {
    code: "C-040",
    bracket: "C",
    label: "Signed Bank Confirmation Authorizations",
    tiers: ["annual"],
    authority: ["AS 2310.08", "AS 2310.20", "AS 2310.31"],
    strong: ["bank confirmation", "confirmation authorization", "standard form to confirm", "audit confirmation request"],
    kw: ["confirmation", "confirm", "authorization to release"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["existence", "rights_obligations"],
    note:
      "AS 2310 requires the AUDITOR to maintain control over the confirmation process and " +
      "to evaluate whether requests or responses may have been altered. Upload the SIGNED " +
      "AUTHORIZATION only — completed confirmations must travel auditor-to-bank directly " +
      "and must never be routed back through a company-controlled channel.",
  },
  {
    code: "C-050",
    bracket: "C",
    label: "Restricted Cash, Liens, Collateral & Compensating Balances",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2310", "ASC 230-10-50-8", "AS 2415.07"],
    strong: ["restricted cash", "compensating balance", "cash collateral", "escrow account", "lockbox agreement"],
    kw: ["restricted", "collateral", "lien", "escrow", "pledged"],
    neg: [],
    owner: "cfo",
    assertions: ["classification", "rights_obligations"],
    note: "Feeds the going-concern analysis — restricted cash is not available runway.",
  },
  {
    code: "C-060",
    bracket: "C",
    label: "Merchant Processor & Payment Platform Reconciliations",
    tiers: ["monthly", "quarterly"],
    authority: ["AS 2110.32", "AS 2310.09"],
    strong: ["merchant reconciliation", "stripe reconciliation", "square reconciliation", "paypal reconciliation", "processor settlement"],
    kw: ["stripe", "square", "paypal", "merchant", "settlement report", "payment processor"],
    neg: [],
    owner: "controller",
    assertions: ["accuracy", "cutoff"],
    note: "Relevant to CarryOutSupplies.com e-commerce receipts.",
  },
  {
    code: "C-070",
    bracket: "C",
    label: "Wire Log, Cash Disbursement & Check Registers",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2401.58", "AS 2110.32"],
    strong: ["wire log", "check register", "disbursement register", "cash disbursements journal"],
    kw: ["wire", "disbursement", "check run", "ach batch", "payment register"],
    neg: [],
    owner: "controller",
    assertions: ["occurrence", "authorization", "cutoff"],
    note: "Also the population for the annual search for unrecorded liabilities.",
  },
  {
    code: "C-080",
    bracket: "C",
    label: "13-Week Rolling Cash Flow / Treasury Forecast",
    tiers: ["monthly", "quarterly"],
    authority: ["AS 2415.10", "ASC 205-40"],
    strong: ["13 week cash flow", "thirteen week", "rolling cash forecast", "cash forecast", "treasury forecast"],
    kw: ["cash flow forecast", "runway", "burn rate", "weekly cash"],
    neg: [],
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "With substantial doubt already concluded, the auditor will want the short-horizon " +
      "forecast refreshed every close, reconciled to the prior version with variances explained.",
  },

  // ══════════════════ D — REVENUE & AR ══════════════════
  {
    code: "D-010",
    bracket: "D",
    label: "Accounts Receivable Aging Reconciled to GL",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2310.09", "AS 2310.14", "AS 2110.46"],
    strong: ["ar aging", "accounts receivable aging", "receivable aging", "aged receivables", "ar trial balance"],
    kw: ["aging", "receivable", "ar detail", "customer balances"],
    neg: ["accounts payable", "ap aging"],
    owner: "controller",
    assertions: ["existence", "valuation", "completeness"],
    note: "Include customer contacts and addresses — the auditor needs them to build the AS 2310 confirmation population.",
  },
  {
    code: "D-020",
    bracket: "D",
    label: "Allowance for Credit Losses / CECL Rollforward & Loss-Rate History",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2501", "ASC 326", "AS 2110.46"],
    strong: ["cecl", "allowance for credit losses", "allowance for doubtful", "bad debt reserve", "credit loss model"],
    kw: ["allowance", "reserve", "doubtful", "write off", "loss rate"],
    neg: ["inventory reserve"],
    owner: "controller",
    assertions: ["valuation"],
    note: "AS 2501 estimate — needs the method, the underlying loss data, and the significant assumptions documented.",
  },
  {
    code: "D-030",
    bracket: "D",
    label: "Revenue by Customer / Product / Segment / Geography",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.46", "AS 2401.15", "ASC 606-10-50", "Reg S-K 303"],
    strong: ["revenue by customer", "revenue by product", "sales by customer", "revenue detail", "disaggregated revenue"],
    kw: ["revenue", "sales detail", "top customers", "concentration"],
    neg: ["deferred revenue"],
    owner: "controller",
    assertions: ["occurrence", "accuracy", "presentation"],
    note: "Also supports the customer-concentration risk factor and the ASC 606 disaggregation footnote.",
  },
  {
    code: "D-040",
    bracket: "D",
    label: "Significant Revenue Contracts, Amendments & Side Letters",
    tiers: ["quarterly", "annual", "event"],
    authority: ["AS 2401.66", "ASC 606", "Reg S-K 601(b)(10)"],
    strong: ["revenue contract", "master service agreement", "customer agreement", "side letter", "purchase order terms", "raas agreement", "robot lease agreement"],
    kw: ["contract", "agreement", "msa", "sow", "statement of work", "side letter"],
    neg: ["employment agreement", "loan agreement", "lease agreement"],
    owner: "general_counsel",
    assertions: ["rights_obligations", "occurrence"],
    note:
      "SIDE LETTERS ARE THE POINT. AS 2401 treats undisclosed side arrangements as a classic " +
      "revenue-fraud vector, and the AS 2805 rep letter covers their absence. RaaS contracts " +
      "also drive the ASC 842 vs. ASC 606 lease-versus-service determination.",
  },
  {
    code: "D-050",
    bracket: "D",
    label: "ASC 606 Five-Step Analysis per Revenue Stream",
    tiers: ["annual", "event"],
    authority: ["ASC 606", "AS 2401.15", "AS 1301.10"],
    strong: ["asc 606", "revenue recognition memo", "five step", "606 analysis", "revenue policy memo"],
    kw: ["revenue recognition", "performance obligation", "transaction price", "606"],
    neg: [],
    owner: "controller",
    assertions: ["presentation", "occurrence"],
    note:
      "One memo per revenue stream: packaging distribution (point-in-time product sales), " +
      "RaaS (service vs. embedded lease), hospitality room revenue (ASC 606 daily performance " +
      "obligation). Gross-vs-net and principal-vs-agent conclusions must be explicit.",
  },
  {
    code: "D-060",
    bracket: "D",
    label: "Deferred Revenue / Contract Liability Rollforward",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 606-10-50-8", "AS 2110.46"],
    strong: ["deferred revenue", "contract liability", "unearned revenue", "deferred revenue rollforward"],
    kw: ["deferred", "unearned", "contract liability", "backlog"],
    neg: [],
    owner: "controller",
    assertions: ["completeness", "valuation", "cutoff"],
  },
  {
    code: "D-070",
    bracket: "D",
    label: "Subsequent Cash Receipts & Credit Memo / Returns Activity",
    tiers: ["annual"],
    authority: ["AS 2310.24", "AS 2310.27", "AS 2401"],
    strong: ["subsequent receipts", "subsequent cash receipts", "credit memo", "sales returns", "cash receipts after year end"],
    kw: ["subsequent", "credit memos", "returns", "rebates", "chargebacks"],
    neg: [],
    owner: "controller",
    assertions: ["existence", "valuation", "cutoff"],
    note:
      "AS 2310 requires ALTERNATIVE PROCEDURES for confirmation nonresponses — subsequent " +
      "receipts, shipping documents and contracts. Post-year-end credit memos also test " +
      "whether revenue was recognized prematurely.",
  },
  {
    code: "D-080",
    bracket: "D",
    label: "Shipping Documents & Cut-Off Evidence",
    tiers: ["annual"],
    authority: ["AS 2310.27", "AS 2110.46"],
    strong: ["shipping documents", "bill of lading", "proof of delivery", "shipping log", "cut off testing"],
    kw: ["shipping", "bol", "delivery", "cutoff", "cut-off", "freight"],
    neg: [],
    owner: "operations",
    assertions: ["cutoff", "occurrence"],
  },
  {
    code: "D-090",
    bracket: "D",
    label: "Hospitality Revenue — STR / PMS Reports & Daily Revenue Reports",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["ASC 606", "AS 2110.46", "AS 2310.09"],
    strong: ["str report", "smith travel", "pms report", "night audit", "daily revenue report", "occupancy report", "revpar"],
    kw: ["occupancy", "adr", "revpar", "room revenue", "hotel revenue", "folio"],
    neg: [],
    owner: "operations",
    assertions: ["occurrence", "accuracy", "completeness"],
    note:
      "Hospitality Asset Ownership segment. The night-audit / PMS report is the primary " +
      "record supporting room revenue; the STR report supports the impairment and " +
      "going-concern forecast assumptions.",
  },

  // ══════════════════ E — INVENTORY ══════════════════
  {
    code: "E-010",
    bracket: "E",
    label: "Priced Inventory Listing Reconciled to GL",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.46", "ASC 330", "AS 1215.06"],
    strong: ["inventory listing", "priced inventory", "inventory valuation report", "stock listing", "inventory detail"],
    kw: ["inventory", "sku", "on hand", "stock report"],
    neg: ["reserve", "count sheet"],
    owner: "controller",
    assertions: ["existence", "valuation", "completeness"],
  },
  {
    code: "E-020",
    bracket: "E",
    label: "Physical Count Instructions, Count Sheets & Count-to-Book Reconciliation",
    tiers: ["annual"],
    authority: ["AS 2510", "AS 1105", "AS 2110.46"],
    strong: ["physical inventory", "count sheet", "inventory count", "cycle count", "count to book", "inventory observation"],
    kw: ["physical count", "count tags", "test count", "stocktake"],
    neg: [],
    gate: true,
    owner: "operations",
    assertions: ["existence", "completeness"],
    note:
      "AS 2510 requires the auditor to OBSERVE the physical count. Count date and instructions " +
      "must be given to the auditor in advance — an unobserved count cannot be remediated after " +
      "the fact and becomes a scope limitation.",
  },
  {
    code: "E-030",
    bracket: "E",
    label: "Excess, Obsolete & Slow-Moving Reserve Analysis",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2501", "ASC 330-10-35", "AS 2110.46"],
    strong: ["obsolescence reserve", "e&o reserve", "excess and obsolete", "slow moving", "inventory reserve", "lower of cost or net realizable"],
    kw: ["obsolete", "reserve", "shrink", "nrv", "write down"],
    neg: ["credit loss", "doubtful"],
    owner: "controller",
    assertions: ["valuation"],
  },
  {
    code: "E-040",
    bracket: "E",
    label: "Standard Cost Build-Ups, Variance & Landed-Cost Analysis",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 330", "AS 2501", "AS 2110.46"],
    strong: ["standard cost", "cost build up", "landed cost", "purchase price variance", "cost roll"],
    kw: ["standard", "variance", "costing", "ppv", "absorption", "freight in"],
    neg: [],
    owner: "controller",
    assertions: ["valuation", "accuracy"],
    note: "Import/landed cost is material for packaging distribution — include duty and tariff treatment.",
  },
  {
    code: "E-050",
    bracket: "E",
    label: "Consignment & Third-Party Warehouse Confirmations",
    tiers: ["annual"],
    authority: ["AS 2310.09", "AS 2510", "ASC 330"],
    strong: ["consignment", "third party warehouse", "3pl", "warehouse confirmation", "bailee"],
    kw: ["consigned", "warehouse", "3pl", "fulfillment center", "off site inventory"],
    neg: [],
    owner: "operations",
    assertions: ["existence", "rights_obligations"],
  },

  // ══════════════════ F — FIXED ASSETS & LEASES ══════════════════
  {
    code: "F-010",
    bracket: "F",
    label: "PP&E Rollforward with Additions, Disposals & Transfers",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2110.46", "ASC 360", "AS 1215.06"],
    strong: ["ppe rollforward", "fixed asset rollforward", "property and equipment rollforward", "fixed asset register", "asset schedule"],
    kw: ["ppe", "fixed asset", "property and equipment", "rollforward", "additions", "disposals"],
    neg: ["intangible", "lease"],
    owner: "controller",
    assertions: ["existence", "completeness", "valuation"],
    note: "Beginning + additions − disposals ± transfers = ending, tied to the GL, with invoice support for additions over the capitalization threshold.",
  },
  {
    code: "F-020",
    bracket: "F",
    label: "Accumulated Depreciation Rollforward & Expense Recalculation",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2110.46", "ASC 360-10-35"],
    strong: ["accumulated depreciation", "depreciation schedule", "depreciation rollforward", "depreciation expense"],
    kw: ["depreciation", "accumulated", "useful life", "salvage"],
    neg: ["amortization of debt"],
    owner: "controller",
    assertions: ["accuracy", "valuation"],
  },
  {
    code: "F-030",
    bracket: "F",
    label: "Capitalization Policy, CIP Detail & Capitalized Interest",
    tiers: ["annual"],
    authority: ["ASC 835-20", "AS 2110.46", "AS 2501"],
    strong: ["construction in progress", "cip detail", "capitalization policy", "capitalized interest"],
    kw: ["cip", "wip", "construction", "capitalize", "placed in service"],
    neg: [],
    owner: "controller",
    assertions: ["existence", "valuation", "classification"],
    note: "Hotel PIP/renovation spend runs through CIP — the placed-in-service date drives when depreciation starts.",
  },
  {
    code: "F-040",
    bracket: "F",
    label: "Hotel Property Files — Deeds, Title, Appraisals & Closing Statements",
    tiers: ["annual", "event"],
    authority: ["AS 2501", "Reg S-X 8-06", "AS 2110", "ASC 805"],
    strong: ["deed", "title policy", "appraisal", "closing statement", "settlement statement", "alta statement", "property survey", "grant deed"],
    kw: ["title", "appraisal", "escrow closing", "property purchase", "hotel property", "real property"],
    neg: [],
    owner: "cfo",
    assertions: ["existence", "rights_obligations", "valuation"],
    note:
      "Hospitality Asset Ownership segment (hotel properties acquired Aug–Sept 2025, incl. " +
      "Victorville Treasure Holdings LLC). Reg S-X 8-06 is the SRC analogue of Rule 3-14 for " +
      "acquired real estate operations — check whether it is triggered before assuming 8-04 applies.",
  },
  {
    code: "F-050",
    bracket: "F",
    label: "Franchise, Management & PIP Agreements (Hospitality)",
    tiers: ["annual", "event"],
    authority: ["ASC 842", "ASC 720-15", "Reg S-K 601(b)(10)", "AS 2110"],
    strong: ["franchise agreement", "hotel management agreement", "property improvement plan", "pip agreement", "brand standards"],
    kw: ["franchise", "flag", "management agreement", "pip", "brand"],
    neg: [],
    owner: "general_counsel",
    assertions: ["rights_obligations", "completeness"],
    note: "PIP obligations are commitments requiring disclosure and can be onerous enough to affect impairment and going concern.",
  },
  {
    code: "F-060",
    bracket: "F",
    label: "ASC 842 Lease Schedule, Agreements & ROU/Liability Rollforward",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 842", "AS 2501", "AS 2110.46"],
    strong: ["lease schedule", "asc 842", "rou asset", "right of use", "lease liability", "lease rollforward", "lease agreement"],
    kw: ["lease", "842", "rou", "incremental borrowing rate", "ibr", "operating lease", "finance lease"],
    neg: ["robot lease revenue"],
    owner: "controller",
    assertions: ["completeness", "valuation", "classification"],
    note:
      "Include the discount-rate support. Lessor accounting also applies on the RaaS side if " +
      "robot placements convey the right to control an identified asset.",
  },
  {
    code: "F-070",
    bracket: "F",
    label: "Robot Fleet Register & RaaS Asset Deployment Schedule",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 360", "ASC 842", "AS 2110.46", "AS 2501"],
    strong: ["robot fleet", "fleet register", "robot deployment", "raas fleet", "roboop", "unit deployment schedule"],
    kw: ["robot", "fleet", "deployment", "units deployed", "raas", "skytech"],
    neg: ["master service agreement", "service agreement", "lease agreement", "contract"],
    owner: "operations",
    assertions: ["existence", "valuation", "completeness"],
    note:
      "TechForce Robotics / RoboOp365. Physical existence of deployed units at customer sites " +
      "is an existence assertion the auditor will test — maintain unit-level serial, location, " +
      "customer, deployment date and status.",
  },
  {
    code: "F-080",
    bracket: "F",
    label: "Intangibles & Goodwill Rollforward",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 350", "AS 2501", "AS 2110.46"],
    strong: ["goodwill rollforward", "intangible rollforward", "intangible assets schedule", "goodwill schedule"],
    kw: ["goodwill", "intangible", "trademark", "customer list", "developed technology"],
    neg: [],
    owner: "controller",
    assertions: ["existence", "valuation"],
  },
  {
    code: "F-090",
    bracket: "F",
    label: "Insurance Policy Schedule & Certificates",
    tiers: ["annual"],
    authority: ["AS 2110.07", "AS 2505.08", "AS 2415"],
    strong: ["insurance schedule", "certificate of insurance", "insurance policy", "d&o insurance", "property insurance"],
    kw: ["insurance", "coverage", "policy limits", "coi", "carrier"],
    neg: ["insider trading policy", "clawback"],
    owner: "cfo",
    assertions: ["completeness", "valuation"],
    note: "Coverage adequacy bears on contingencies (AS 2505) and on uninsured-catastrophe going-concern risk.",
  },

  // ══════════════════ G — DEBT & DERIVATIVES ══════════════════
  {
    code: "G-010",
    bracket: "G",
    label: "Debt Schedule & Amortization Schedules",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.46", "ASC 470", "AS 2415.07"],
    strong: ["debt schedule", "loan schedule", "amortization schedule", "note payable schedule", "debt rollforward"],
    kw: ["debt", "loan", "note payable", "amortization", "principal", "accrued interest"],
    neg: ["lease", "depreciation"],
    owner: "cfo",
    assertions: ["completeness", "valuation", "classification"],
  },
  {
    code: "G-020",
    bracket: "G",
    label: "Debt Agreements, Notes, Indentures & Amendments",
    tiers: ["quarterly", "annual", "event"],
    authority: ["Reg S-K 601(b)(4)", "Reg S-K 601(b)(10)", "AS 2110", "Form 8-K Item 2.03"],
    strong: ["promissory note", "loan agreement", "credit agreement", "indenture", "note purchase agreement", "security agreement", "forbearance agreement"],
    kw: ["note", "loan", "credit facility", "indenture", "amendment", "guaranty"],
    neg: ["convertible"],
    owner: "general_counsel",
    assertions: ["rights_obligations", "completeness"],
    note: "New debt is also a Form 8-K Item 2.03 event on a 4-business-day clock.",
  },
  {
    code: "G-030",
    bracket: "G",
    label: "Covenant Compliance Calculations, Waivers & Default Notices",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2415.07", "ASC 470-10-45", "AS 2805.06"],
    strong: ["covenant compliance", "covenant calculation", "compliance certificate", "waiver letter", "default notice", "notice of default", "forbearance"],
    kw: ["covenant", "compliance", "waiver", "default", "cure period", "acceleration"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["classification", "presentation"],
    note:
      "A covenant breach without a waiver obtained before the balance sheet date reclassifies " +
      "long-term debt to CURRENT and is an AS 2415 going-concern condition. Calculate every " +
      "covenant every month, even when the agreement only requires quarterly certification.",
  },
  {
    code: "G-040",
    bracket: "G",
    label: "Convertible Note Agreements & Conversion Activity",
    tiers: ["monthly", "quarterly", "annual", "event"],
    authority: ["ASC 470-20", "ASC 815-15", "AS 2501", "Form 8-K Item 3.02"],
    strong: ["convertible note", "convertible promissory note", "conversion notice", "convertible debenture", "conversion schedule"],
    kw: ["convertible", "conversion", "conversion price", "discount to market", "toxic note", "variable conversion"],
    neg: [],
    owner: "cfo",
    assertions: ["completeness", "valuation", "classification"],
    note:
      "HIGHEST-RISK CATEGORY FOR THIS ISSUER. Variable-conversion-price notes generate " +
      "derivative liabilities under ASC 815-15/815-40 and drive the share-count dilution " +
      "(151.9M → 507.5M shares in seven months). Every conversion needs the notice, the " +
      "price calculation, the shares issued and the loss-on-conversion computation.",
  },
  {
    code: "G-050",
    bracket: "G",
    label: "Derivative & Embedded-Feature Bifurcation Analyses",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 815-15", "ASC 815-40", "AS 2501", "AS 1301.10"],
    strong: ["bifurcation analysis", "embedded derivative", "derivative analysis", "asc 815-40", "asc 815-15", "815-40 analysis"],
    kw: ["derivative", "bifurcation", "embedded", "815", "host instrument", "clearly and closely related"],
    neg: [],
    owner: "controller",
    assertions: ["classification", "valuation", "presentation"],
    note:
      "The single most common micro-cap restatement cause. Needs an instrument-by-instrument " +
      "written conclusion on (a) is it indexed to the company's own stock, (b) is it equity-" +
      "classified under 815-40, (c) is there a fixed share cap. Expect this to be a CAM.",
  },
  {
    code: "G-060",
    bracket: "G",
    label: "Derivative & Warrant Fair-Value Remeasurement Schedules and Models",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 820", "ASC 815-40", "AS 2501", "AS 2501.28"],
    strong: ["derivative liability", "warrant liability", "fair value remeasurement", "mark to market", "monte carlo", "binomial lattice", "black scholes"],
    kw: ["fair value", "remeasurement", "valuation model", "level 3", "volatility", "mtm"],
    neg: ["409a"],
    owner: "controller",
    assertions: ["valuation", "presentation"],
    note:
      "Upload the LIVE MODEL (working spreadsheet with formulas), not a PDF of the output. " +
      "AS 2501 requires the auditor to test the accuracy and completeness of the data and to " +
      "evaluate each significant assumption — that is not possible from a printed result.",
  },
  {
    code: "G-070",
    bracket: "G",
    label: "Debt Confirmation Authorizations",
    tiers: ["annual"],
    authority: ["AS 2310.09", "AS 2310.20"],
    strong: ["debt confirmation", "loan confirmation", "lender confirmation"],
    kw: ["confirmation", "confirm balance", "lender"],
    neg: ["bank confirmation"],
    owner: "cfo",
    assertions: ["existence", "completeness"],
  },
  {
    code: "G-080",
    bracket: "G",
    label: "Related-Party Notes, Advances & Officer Loans",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2410.10", "Reg S-K 404", "SOX 402", "Nasdaq 5630"],
    strong: ["officer loan", "shareholder loan", "related party note", "due to officer", "due from officer", "insider advance", "affiliate note"],
    kw: ["related party", "officer", "shareholder", "affiliate", "due to", "due from", "advance"],
    neg: [],
    conf: true,
    gate: true,
    owner: "cfo",
    assertions: ["completeness", "presentation", "authorization"],
    note:
      "SOX 402 / Exchange Act 13(k) PROHIBITS personal loans to executives outright — this is " +
      "not merely a disclosure item. AS 2410 requires the auditor to evaluate the related " +
      "party's FINANCIAL CAPABILITY to perform. Flag every balance for legal review.",
  },

  // ══════════════════ H — EQUITY & SBC ══════════════════
  {
    code: "H-010",
    bracket: "H",
    label: "Capitalization Table & Rollforward",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.46", "ASC 505", "Reg S-K 201(d)"],
    strong: ["cap table", "capitalization table", "capitalization rollforward", "share rollforward", "shares outstanding schedule"],
    kw: ["cap table", "capitalization", "shares outstanding", "fully diluted", "ownership"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["accuracy", "completeness"],
    note:
      "Must FOOT to the transfer agent report every close. Share count went 151.9M (10/14/25) " +
      "→ 507.5M (5/20/26); an unreconciled cap table at this dilution rate is a material-" +
      "weakness indicator and misstates EPS.",
  },
  {
    code: "H-020",
    bracket: "H",
    label: "Transfer Agent Report / Shareholder of Record List",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2310.09", "AS 2110.46", "Nasdaq 5505(a)(3)"],
    strong: ["transfer agent report", "transfer agent", "shareholder list", "shareholders of record", "dtc position", "cede"],
    kw: ["transfer agent", "registrar", "record holders", "round lot"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["existence", "accuracy", "completeness"],
    note:
      "The independent third-party corroboration of share count. Also the evidence for the " +
      "Nasdaq 5505(a)(3) round-lot-holder test (300 holders, 50% holding $2,500+) — start " +
      "collecting a NOBO/round-lot analysis well before the listing application.",
  },
  {
    code: "H-030",
    bracket: "H",
    label: "Stock Option / Warrant / RSU Grant Register",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["ASC 718", "AS 2501", "AS 2110.10A", "Reg S-K 201(d)"],
    strong: ["option register", "grant register", "warrant register", "rsu register", "option ledger", "warrant ledger", "equity award schedule"],
    kw: ["option", "warrant", "rsu", "grant", "vesting", "exercise", "forfeiture"],
    neg: ["warrant liability", "warrant valuation"],
    owner: "cfo",
    assertions: ["completeness", "accuracy"],
    note: "Full activity: grants, exercises, cancellations, forfeitures and expirations, each traced to a board approval.",
  },
  {
    code: "H-040",
    bracket: "H",
    label: "Board / Committee Approvals for Equity Grants & Issuances",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["ASC 718-10-25", "AS 2401.65", "Nasdaq 5635(c)"],
    strong: ["grant approval", "board approval of grant", "equity grant resolution", "issuance resolution", "resolution approving equity", "approving equity grants", "resolution approving grant", "board consent approving grant"],
    kw: ["approval", "resolution", "authorized issuance", "grant date", "approving equity", "approving grants"],
    neg: [],
    gate: true,
    owner: "corporate_secretary",
    assertions: ["authorization", "occurrence"],
    note:
      "No approval means no ASC 718 grant date, which means the expense is in the wrong period. " +
      "Nasdaq 5635(c) will also require shareholder approval for equity compensation once listed.",
  },
  {
    code: "H-050",
    bracket: "H",
    label: "ASC 718 Share-Based Compensation Expense Calculation & Inputs",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 718", "AS 2501", "AS 2501.28"],
    strong: ["stock compensation calculation", "asc 718", "sbc expense", "black scholes input", "volatility study", "expected term analysis"],
    kw: ["share based", "stock comp", "718", "volatility", "risk free", "expected term", "forfeiture rate"],
    neg: [],
    owner: "controller",
    assertions: ["valuation", "accuracy"],
    note: "Each significant assumption needs its own support: the volatility study, the expected-term derivation, the risk-free source and date.",
  },
  {
    code: "H-060",
    bracket: "H",
    label: "409A / Third-Party Equity Valuation Reports",
    tiers: ["annual", "event"],
    authority: ["AS 2501", "AS 1210", "ASC 718-10-30"],
    strong: ["409a", "409a valuation", "valuation report", "equity valuation", "fair market value opinion"],
    kw: ["409a", "valuation", "appraisal of equity", "fmv determination"],
    neg: ["property appraisal", "real estate appraisal"],
    owner: "cfo",
    assertions: ["valuation"],
    note: "Include the specialist's credentials — AS 1210 requires the auditor to evaluate the specialist's competence and objectivity.",
  },
  {
    code: "H-070",
    bracket: "H",
    label: "Subscription Agreements, PIPEs, Private Placements & ATM/ELOC Activity",
    tiers: ["monthly", "quarterly", "annual", "event"],
    authority: ["Form 8-K Item 3.02", "Reg S-K 701", "ASC 505", "Nasdaq 5635(d)"],
    strong: ["subscription agreement", "securities purchase agreement", "pipe", "equity line", "eloc", "at the market", "atm agreement", "private placement memorandum"],
    kw: ["subscription", "spa", "placement", "purchase agreement", "reg d", "reg a", "investor"],
    neg: ["asset purchase agreement", "stock purchase agreement for acquisition"],
    owner: "general_counsel",
    assertions: ["occurrence", "completeness", "authorization"],
    note:
      "Unregistered sales are a Form 8-K Item 3.02 event (4 business days). The S-1/A on file " +
      "registers 150,000,000 resale shares (144M under a Purchase Agreement + 6M warrant), so " +
      "the Purchase Agreement mechanics need to be tracked draw by draw. Nasdaq 5635(d) " +
      "(20% rule) will require shareholder approval for discounted issuances once listed.",
  },
  {
    code: "H-080",
    bracket: "H",
    label: "Beneficial Ownership Schedule, Forms 3/4/5 & Schedules 13D/G",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2110.11", "AS 2410.07", "Reg S-K 403", "Section 16"],
    strong: ["form 3", "form 4", "form 5", "schedule 13d", "schedule 13g", "beneficial ownership", "section 16 filing"],
    kw: ["beneficial", "13d", "13g", "insider filing", "section 16", "ownership table"],
    neg: [],
    owner: "general_counsel",
    assertions: ["completeness", "presentation"],
    note: "AS 2110.11 names insider trading filings specifically as a risk-assessment source; also tests related-party completeness.",
  },
  {
    code: "H-090",
    bracket: "H",
    label: "EPS Calculation & Anti-Dilution / Diluted Share Reconciliation",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 260", "AS 2110.46", "Reg S-X 8-03"],
    strong: ["eps calculation", "earnings per share", "diluted eps", "weighted average shares"],
    kw: ["eps", "per share", "weighted average", "antidilutive", "dilution"],
    neg: [],
    owner: "controller",
    assertions: ["accuracy", "presentation"],
    note: "With this dilution rate the weighted-average computation is error-prone; show the daily or monthly weighting.",
  },
  {
    code: "H-100",
    bracket: "H",
    label: "Reverse Stock Split Documentation",
    tiers: ["event", "s1"],
    authority: ["Nasdaq 5810(c)(3)(A)", "Nasdaq IM-5810-2", "ASC 260-10-55", "Reg S-K 601(b)(3)"],
    strong: ["reverse stock split", "reverse split", "share consolidation", "certificate of change"],
    kw: ["reverse split", "split ratio", "recapitalization", "finra corporate action"],
    neg: [],
    owner: "general_counsel",
    assertions: ["presentation", "authorization"],
    note:
      "UPLISTING TRAP: under the Oct 2024 and Jan 2025 Nasdaq amendments, a reverse split " +
      "within the PRIOR ONE-YEAR PERIOD triggers an immediate Staff Delisting Determination " +
      "for a LISTED company, and a split that causes non-compliance with another standard " +
      "(round lots, publicly held shares) accelerates delisting. Sequencing the split against " +
      "the listing application is a securities-counsel decision, not an accounting one. " +
      "Retroactive EPS restatement is required for all periods presented.",
  },

  // ══════════════════ I — PAYROLL, TAX & RELATED PARTIES ══════════════════
  {
    code: "I-010",
    bracket: "I",
    label: "Payroll Registers & Accrual Support",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.46", "AS 2401", "ASC 710"],
    strong: ["payroll register", "payroll journal", "payroll report", "payroll summary"],
    kw: ["payroll", "wages", "gusto", "adp", "paychex", "salaries"],
    neg: ["941", "w-2", "tax return"],
    conf: true,
    owner: "controller",
    assertions: ["occurrence", "accuracy", "completeness"],
  },
  {
    code: "I-020",
    bracket: "I",
    label: "Payroll Tax Filings — 941, W-2/W-3, State Returns",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2110.46", "AS 2405", "AS 2110.07"],
    strong: ["form 941", "941", "w-2", "w-3", "de 9", "de9c", "unemployment return", "payroll tax return"],
    kw: ["941", "w2", "w3", "suta", "futa", "payroll tax", "withholding"],
    neg: [],
    conf: true,
    owner: "controller",
    assertions: ["completeness", "accuracy"],
    note: "Reconcile to the payroll registers and the GL. Delinquent payroll taxes are a going-concern and personal-liability indicator.",
  },
  {
    code: "I-030",
    bracket: "I",
    label: "Officer Compensation Detail & Employment Agreements",
    tiers: ["annual"],
    authority: ["AS 2110.10A", "AS 2110.11", "AS 2410.07", "Reg S-K 402"],
    strong: ["employment agreement", "officer compensation", "executive compensation", "severance agreement", "offer letter", "consulting agreement with officer"],
    kw: ["employment", "compensation", "bonus plan", "severance", "incentive plan", "executive"],
    neg: [],
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness", "presentation", "authorization"],
    note:
      "AS 2110.10A/.11 require the auditor to read compensation contracts and arrangements " +
      "that CREATE INCENTIVES to meet targets — a fraud-risk input, not just an Item 402 " +
      "disclosure input. NOTE: Jimmy Chan holds a dual CEO/CFO role, which is itself a " +
      "segregation-of-duties and management-override risk factor and a governance item " +
      "Nasdaq and the audit committee will focus on.",
  },
  {
    code: "I-040",
    bracket: "I",
    label: "Federal & State Income Tax Returns (All Open Years)",
    tiers: ["annual"],
    authority: ["AS 2410.07", "ASC 740", "AS 2110.07"],
    strong: ["form 1120", "1120", "tax return", "federal income tax return", "state income tax return", "franchise tax return"],
    kw: ["tax return", "1120", "schedule k", "extension 7004", "state return"],
    neg: ["941", "payroll tax", "sales tax"],
    conf: true,
    owner: "cfo",
    assertions: ["completeness", "accuracy"],
    note: "AS 2410 names TAX FILINGS as a document the auditor must read to identify undisclosed related parties.",
  },
  {
    code: "I-050",
    bracket: "I",
    label: "Income Tax Provision Workpapers & Deferred Tax Rollforward",
    tiers: ["quarterly", "annual"],
    authority: ["ASC 740", "AS 2501", "AS 2110.46"],
    strong: ["tax provision", "asc 740", "deferred tax rollforward", "tax provision workpaper", "rate reconciliation", "annual effective tax rate"],
    kw: ["provision", "deferred tax", "740", "etr", "temporary difference", "book tax difference"],
    neg: [],
    owner: "cfo",
    assertions: ["valuation", "accuracy", "presentation"],
    note: "Interim provisions use the ASC 740-270 estimated annual effective rate — document the computation each quarter.",
  },
  {
    code: "I-060",
    bracket: "I",
    label: "NOL Carryforward Schedule, Section 382 Study & Valuation Allowance",
    tiers: ["annual", "event"],
    authority: ["ASC 740-10-30", "IRC 382", "AS 2501"],
    strong: ["nol schedule", "net operating loss", "section 382", "382 study", "valuation allowance analysis", "ownership change study"],
    kw: ["nol", "382", "valuation allowance", "carryforward", "ownership change"],
    neg: [],
    owner: "cfo",
    assertions: ["valuation", "presentation"],
    note:
      "CRITICAL: the 3.3x share-count increase and any change-of-control from the Jiun Jiang " +
      "transaction are classic IRC 382 ownership-change triggers that can limit or eliminate " +
      "the NOL carryforward against a $60.2M accumulated deficit. A 382 study should be " +
      "commissioned before, not after, the next equity event.",
  },
  {
    code: "I-070",
    bracket: "I",
    label: "Uncertain Tax Positions (ASC 740-10) & Tax Notices",
    tiers: ["annual", "event"],
    authority: ["ASC 740-10", "AS 2501", "AS 2505.05"],
    strong: ["uncertain tax position", "utp analysis", "fin 48", "irs notice", "tax audit correspondence", "notice of deficiency"],
    kw: ["utp", "fin 48", "irs", "franchise tax board", "cdtfa", "tax notice", "tax examination"],
    neg: [],
    conf: true,
    owner: "cfo",
    assertions: ["completeness", "valuation"],
  },
  {
    code: "I-080",
    bracket: "I",
    label: "Sales/Use, Property & Franchise Tax Filings and Delinquencies",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2110.46", "AS 2405", "ASC 450"],
    strong: ["sales tax return", "use tax", "cdtfa", "property tax bill", "franchise tax", "business license tax"],
    kw: ["sales tax", "use tax", "property tax", "franchise", "nexus", "delinquent"],
    neg: [],
    owner: "controller",
    assertions: ["completeness", "valuation"],
    note: "Multi-state nexus from packaging distribution + hotel properties in multiple states; unfiled returns are unrecorded liabilities.",
  },
  {
    code: "I-090",
    bracket: "I",
    label: "Related-Party Listing & Transaction Detail",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2410", "Reg S-K 404", "ASC 850", "Nasdaq 5630"],
    strong: ["related party listing", "related party transactions", "related party schedule", "affiliate transactions"],
    kw: ["related party", "affiliate", "insider transaction", "850"],
    neg: [],
    gate: true,
    conf: true,
    owner: "cfo",
    assertions: ["completeness", "presentation", "authorization"],
    note:
      "AS 2410 requires the auditor to evaluate, for each significant related-party transaction: " +
      "whether documentation is consistent with management's explanations, whether it was " +
      "PROPERLY AUTHORIZED, whether policy exceptions were made, and whether the related party " +
      "had the financial capability to perform. Undisclosed related parties are among the most " +
      "common uplisting restatement triggers — submit a NIL return rather than nothing.",
  },
  {
    code: "I-100",
    bracket: "I",
    label: "Shared-Services, Expense Allocation & Affiliate Consulting Agreements",
    tiers: ["annual", "event"],
    authority: ["AS 2410.07", "ASC 850", "Reg S-K 404"],
    strong: ["shared services agreement", "expense allocation", "cost sharing agreement", "management fee agreement", "affiliate consulting"],
    kw: ["allocation", "shared services", "management fee", "cost sharing", "intercompany agreement"],
    neg: [],
    conf: true,
    owner: "cfo",
    assertions: ["accuracy", "presentation"],
  },

  // ══════════════════ J — ESTIMATES & GOING CONCERN ══════════════════
  {
    code: "J-010",
    bracket: "J",
    label: "Going-Concern Assessment Memo (ASC 205-40)",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2415", "ASC 205-40", "AS 1301.10", "AS 2805"],
    strong: ["going concern", "going concern memo", "asc 205-40", "substantial doubt", "205-40 assessment"],
    kw: ["going concern", "substantial doubt", "liquidity assessment", "ability to continue"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["presentation", "completeness"],
    note:
      "GATING ITEM FOR THIS ISSUER. Fruci's FY2024 and FY2025 opinions both carried a " +
      "substantial-doubt paragraph, and Q3 FY2026 showed a $23.5M working-capital deficit, " +
      "$60.2M accumulated deficit and $732,691 of cash. Note the period mismatch: AS 2415 runs " +
      "one year from the BALANCE SHEET date while ASC 205-40 runs one year from the ISSUANCE " +
      "date — address both. Must be refreshed every close, and must distinguish PROBABLE from " +
      "merely possible financing in management's plans.",
  },
  {
    code: "J-020",
    bracket: "J",
    label: "12–24 Month Cash Flow Forecast with Assumption Support",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2415.10", "AS 2415.12", "ASC 205-40", "AS 2501"],
    strong: ["cash flow forecast", "24 month forecast", "12 month forecast", "liquidity forecast", "financial projection", "forecast model"],
    kw: ["forecast", "projection", "budget", "runway", "burn", "model"],
    neg: ["13 week"],
    gate: true,
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "AS 2415.12: where prospective information is particularly significant the auditor " +
      "EXAMINES THE UNDERLYING ASSUMPTIONS, focusing on those that are material, especially " +
      "sensitive or volatile, or inconsistent with historical trends. Upload the working model " +
      "with formulas plus a written assumption memo and a variance analysis against the prior " +
      "forecast — a PDF of outputs is not auditable.",
  },
  {
    code: "J-030",
    bracket: "J",
    label: "Financing Term Sheets, LOIs, Commitment & Shareholder Support Letters",
    tiers: ["quarterly", "annual", "event"],
    authority: ["AS 2415.10", "ASC 205-40-50", "AS 2805.06"],
    strong: ["term sheet", "letter of intent", "commitment letter", "support letter", "letter of support", "financing commitment"],
    kw: ["term sheet", "loi", "commitment", "standby", "backstop", "financing"],
    neg: [],
    owner: "cfo",
    assertions: ["presentation", "rights_obligations"],
    note: "Management's plans only mitigate substantial doubt to the extent they are PROBABLE of occurring and probable of being effective. Non-binding LOIs generally are not.",
  },
  {
    code: "J-040",
    bracket: "J",
    label: "Goodwill & Long-Lived Asset Impairment Analyses",
    tiers: ["quarterly", "annual", "event"],
    authority: ["ASC 350-20", "ASC 360-10-35", "AS 2501"],
    strong: ["impairment analysis", "impairment test", "goodwill impairment", "step 1 test", "recoverability test", "triggering event analysis"],
    kw: ["impairment", "triggering event", "undiscounted cash flows", "reporting unit", "carrying value"],
    neg: [],
    owner: "controller",
    assertions: ["valuation"],
    note:
      "A going-concern conclusion and a sustained market-cap shortfall below book value are " +
      "themselves triggering events. Document the triggering-event assessment EVERY quarter " +
      "even when the conclusion is that no test is required.",
  },
  {
    code: "J-050",
    bracket: "J",
    label: "Third-Party Specialist & Valuation Reports with Credentials",
    tiers: ["annual", "event"],
    authority: ["AS 1210", "AS 2501.28", "AS 1105.23"],
    strong: ["valuation report", "specialist report", "appraisal report", "fairness opinion", "actuarial report"],
    kw: ["specialist", "valuation firm", "appraiser", "expert report", "engagement scope"],
    neg: ["409a"],
    owner: "cfo",
    assertions: ["valuation"],
    note: "Include the specialist's engagement letter, scope, credentials and independence — AS 1210 requires the auditor to evaluate all of these.",
  },
  {
    code: "J-060",
    bracket: "J",
    label: "Estimate Register — Method, Data Source & Significant Assumptions",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2501", "AS 2501.13", "AS 1301.10"],
    strong: ["estimate register", "critical estimates", "critical accounting estimates", "estimate summary", "significant assumptions"],
    kw: ["estimate", "assumption", "judgment", "critical accounting"],
    neg: [],
    owner: "controller",
    assertions: ["valuation", "presentation"],
    note:
      "One register listing every estimate with its method, data sources, significant " +
      "assumptions and sensitivity. This is both an AS 2501 requirement and the source of " +
      "the Item 303 critical-accounting-estimates disclosure and the AS 1301 communication.",
  },
  {
    code: "J-070",
    bracket: "J",
    label: "Prior-Year Estimate vs. Actual Retrospective Review",
    tiers: ["annual"],
    authority: ["AS 2401.63", "AS 2501.34"],
    strong: ["retrospective review", "estimate vs actual", "look back analysis", "prior year estimate comparison"],
    kw: ["retrospective", "look back", "hindsight", "estimate accuracy"],
    neg: [],
    owner: "controller",
    assertions: ["valuation"],
    note: "AS 2401.63 requires a retrospective review of prior-year estimates specifically to detect MANAGEMENT BIAS. Expect it every year.",
  },
  {
    code: "J-080",
    bracket: "J",
    label: "Accrued Liabilities Schedules & Search for Unrecorded Liabilities",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.46", "ASC 450", "AS 2401"],
    strong: ["accrued liabilities", "accrual schedule", "unrecorded liabilities", "search for unrecorded", "grni", "goods received not invoiced"],
    kw: ["accrued", "accrual", "accrued expenses", "professional fees accrual", "unrecorded"],
    neg: [],
    owner: "controller",
    assertions: ["completeness", "valuation"],
    note:
      "Accrued professional fees are chronically understated at micro-caps — with four auditor " +
      "changes since 2022, active securities counsel, an S-1 and a State-Bar-level volume of " +
      "legal work, accrue audit, legal and transaction fees from engagement letters and fee " +
      "estimates, not from invoices received.",
  },
  {
    code: "J-090",
    bracket: "J",
    label: "Accounts Payable Aging & Vendor Statements",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 2110.46", "AS 2310.09"],
    strong: ["ap aging", "accounts payable aging", "aged payables", "vendor statement", "ap detail"],
    kw: ["payable", "ap aging", "vendor", "creditor"],
    neg: ["receivable", "ar aging"],
    owner: "controller",
    assertions: ["completeness", "existence"],
    note: "Aged payables beyond terms are a going-concern indicator (denial of trade credit) as well as a completeness population.",
  },

  // ══════════════════ K — LEGAL & REGULATORY ══════════════════
  {
    code: "K-010",
    bracket: "K",
    label: "Management's Written Litigation Evaluation & Unasserted Claims List",
    tiers: ["quarterly", "annual"],
    authority: ["AS 2505.05", "AS 2505.06", "ASC 450", "AS 2805.06"],
    strong: ["litigation evaluation", "litigation schedule", "legal matters schedule", "unasserted claims", "contingency schedule", "litigation summary"],
    kw: ["litigation", "legal matters", "claims", "contingency", "lawsuit", "dispute"],
    neg: ["audit inquiry letter"],
    gate: true,
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness", "valuation", "presentation"],
    note:
      "AS 2505 requires management to give the auditor a WRITTEN evaluation of all pending and " +
      "threatened litigation at the balance sheet date PLUS an identification of unasserted " +
      "claims probable of assertion. The unasserted-claims list is the part companies skip and " +
      "the part auditors will not waive. For each matter: nature, progress, intended response, " +
      "likelihood of unfavorable outcome, and estimated loss or range.",
  },
  {
    code: "K-020",
    bracket: "K",
    label: "AS 2505 Audit Inquiry Letters to Counsel & Lawyers' Responses",
    tiers: ["annual", "s1"],
    authority: ["AS 2505.08", "AS 2505.09", "AS 2505.10", "AS 4101.10"],
    strong: ["audit inquiry letter", "letter of audit inquiry", "legal representation letter", "attorney response letter", "lawyer response"],
    kw: ["audit inquiry", "legal letter", "counsel response", "aba statement"],
    neg: [],
    gate: true,
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness", "valuation"],
    note:
      "Goes to EVERY lawyer who devoted substantive attention to litigation — including " +
      "securities counsel (Sichenzia Ross Ference Carmel) and any litigation counsel, not just " +
      "one firm. Must state the agreed materiality limit and cover through a date AS CLOSE AS " +
      "PRACTICABLE to the report date. A refusal to respond is a scope limitation precluding an " +
      "unqualified opinion. Expect a fresh letter at each S-1 amendment and at effectiveness.",
  },
  {
    code: "K-030",
    bracket: "K",
    label: "Settlement Agreements, Demand Letters & Docket Reports",
    tiers: ["quarterly", "annual", "event"],
    authority: ["AS 2505", "ASC 450-20", "Form 8-K Item 1.01"],
    strong: ["settlement agreement", "demand letter", "docket report", "complaint filed", "notice of claim", "cease and desist"],
    kw: ["settlement", "demand", "docket", "complaint", "summons", "judgment", "arbitration"],
    neg: [],
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness", "valuation"],
  },
  {
    code: "K-040",
    bracket: "K",
    label: "SEC Comment Letters, Correspondence & Staff Inquiries",
    tiers: ["quarterly", "annual", "s1"],
    authority: ["AS 2110.07", "AS 4105.18", "AS 2805.06", "AS 1301.15"],
    strong: ["sec comment letter", "upload letter", "sec correspondence", "corresp", "staff comment", "division of corporation finance"],
    kw: ["sec", "comment letter", "staff", "corresp", "response letter"],
    neg: [],
    gate: true,
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness", "presentation"],
    note:
      "AS 2805 requires management to represent that it has made ALL regulatory communications " +
      "available. Unshared SEC correspondence is a representation breach, not an oversight.",
  },
  {
    code: "K-050",
    bracket: "K",
    label: "FINRA, Exchange & Other Regulatory Correspondence",
    tiers: ["quarterly", "annual", "event"],
    authority: ["AS 4105.18", "AS 2805.06", "Nasdaq 5800 series"],
    strong: ["finra inquiry", "finra letter", "nasdaq letter", "listing qualifications", "deficiency notice", "otc markets notice"],
    kw: ["finra", "nasdaq", "listing", "deficiency", "regulatory inquiry", "otc markets"],
    neg: [],
    gate: true,
    conf: true,
    owner: "general_counsel",
    assertions: ["completeness", "presentation"],
    note:
      "My notes record an informal FINRA inquiry into 2025 press releases. Any such inquiry is " +
      "both an AS 4105 quarterly inquiry topic and a disclosure consideration, and Nasdaq will " +
      "ask about it on the listing application.",
  },
  {
    code: "K-060",
    bracket: "K",
    label: "Cybersecurity Risk Management, Incident & ITGC Documentation",
    tiers: ["annual", "event"],
    authority: ["Reg S-K 106", "Form 8-K Item 1.05", "AS 2110.20"],
    strong: ["cybersecurity policy", "cyber incident report", "incident response plan", "penetration test", "itgc", "soc 2"],
    kw: ["cybersecurity", "cyber", "incident", "breach", "information security", "itgc"],
    neg: [],
    conf: true,
    owner: "cfo",
    assertions: ["presentation", "completeness"],
    note: "Item 106 requires annual disclosure of processes and governance; Item 1.05 requires an 8-K within 4 business days of the MATERIALITY DETERMINATION, not discovery.",
  },
  {
    code: "K-070",
    bracket: "K",
    label: "Significant Vendor, Supplier & Consulting Agreements",
    tiers: ["annual", "event"],
    authority: ["Reg S-K 601(b)(10)", "AS 2110", "AS 2415.07"],
    strong: ["vendor agreement", "supply agreement", "distribution agreement", "consulting agreement", "master purchase agreement"],
    kw: ["vendor", "supplier", "distribution", "consulting", "service agreement"],
    neg: ["employment agreement", "revenue contract"],
    owner: "general_counsel",
    assertions: ["rights_obligations", "completeness"],
    note: "Loss of a principal supplier is an AS 2415 going-concern condition; exclusivity and minimum-purchase terms are commitments requiring disclosure.",
  },

  // ══════════════════ L — SEC REPORTING & CONTROLS ══════════════════
  {
    code: "L-010",
    bracket: "L",
    label: "Draft Form 10-Q (Financials, Footnotes, MD&A)",
    tiers: ["quarterly"],
    authority: ["Reg S-X 8-03", "Reg S-X 10-01(d)", "Reg S-K 303", "AS 4105.15"],
    strong: ["draft 10-q", "10-q draft", "form 10-q", "10q draft", "quarterly report draft"],
    kw: ["10-q", "10q", "quarterly report", "interim report"],
    neg: ["10-k", "nt 10-q"],
    gate: true,
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "Reg S-X 10-01(d) requires the interim financials to be REVIEWED BEFORE FILING. The " +
      "review gates the filing — the SEC has brought enforcement for filing ahead of review " +
      "completion. Circulate the draft early enough for the AS 4105 review AND the AS 1220 " +
      "engagement quality review, which also applies to interim reviews.",
  },
  {
    code: "L-020",
    bracket: "L",
    label: "Draft Form 10-K (Financials, Footnotes, MD&A, Exhibit Index)",
    tiers: ["annual"],
    authority: ["Reg S-X 8-02", "Reg S-K 303", "Reg S-K 601", "AS 3101"],
    strong: ["draft 10-k", "10-k draft", "form 10-k", "10k draft", "annual report draft"],
    kw: ["10-k", "10k", "annual report", "exhibit index"],
    neg: ["10-q", "nt 10-k"],
    gate: true,
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "Two audited balance sheets and two years of income/cash-flow/equity statements under " +
      "Reg S-X 8-02 (SRC scaling — not three). Because NGTF is NOT an EGC, the auditor's " +
      "report must include CRITICAL AUDIT MATTERS under AS 3101.",
  },
  {
    code: "L-030",
    bracket: "L",
    label: "XBRL / Inline XBRL Tagging Files & Validation Report",
    tiers: ["quarterly", "annual"],
    authority: ["Reg S-T Rule 405", "Reg S-K 601(b)(101)"],
    strong: ["xbrl", "inline xbrl", "ixbrl", "taxonomy", "xbrl validation"],
    kw: ["xbrl", "tagging", "edgar validation", "efm"],
    neg: [],
    owner: "cfo",
    assertions: ["presentation", "accuracy"],
  },
  {
    code: "L-040",
    bracket: "L",
    label: "Section 302 Certifications & Disclosure Controls Evaluation Memo",
    tiers: ["quarterly", "annual"],
    authority: ["Rule 13a-14", "Rule 13a-15(b)", "Reg S-K 307", "Reg S-K 601(b)(31)", "AS 4105.15"],
    strong: ["302 certification", "section 302", "disclosure controls evaluation", "dcp evaluation", "certification of principal executive"],
    kw: ["302", "certification", "disclosure controls", "exhibit 31"],
    neg: ["906", "404"],
    gate: true,
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "AS 4105 requires the auditor to EVALUATE MANAGEMENT'S 302 PROCESS each quarter. The " +
      "evaluation memo must be DATED BEFORE the filing — a memo written after the 10-Q went " +
      "out does not support the certification. Jimmy Chan signs as both PEO and PFO, so both " +
      "certifications carry one signature; note that in the controls discussion.",
  },
  {
    code: "L-050",
    bracket: "L",
    label: "Section 906 Certifications",
    tiers: ["quarterly", "annual"],
    authority: ["18 U.S.C. 1350", "Reg S-K 601(b)(32)"],
    strong: ["906 certification", "section 906", "1350 certification"],
    kw: ["906", "exhibit 32", "criminal certification"],
    neg: ["302"],
    gate: true,
    owner: "cfo",
    assertions: ["presentation"],
  },
  {
    code: "L-060",
    bracket: "L",
    label: "Sub-Certification Packets from Process & Business-Unit Owners",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["Rule 13a-15(b)", "AS 2110.32", "COSO 2013"],
    strong: ["sub certification", "subcertification", "sub-cert", "representation from business unit"],
    kw: ["sub cert", "subcert", "process owner certification", "unit certification"],
    neg: [],
    owner: "controller",
    assertions: ["completeness"],
    note:
      "One per business line (Foodservice Packaging, RaaS, Hospitality) plus functional owners " +
      "(legal, HR/payroll, IT, treasury). Each covers completeness of information provided, all " +
      "contracts entered or terminated, all related-party transactions, all litigation, all " +
      "known errors or fraud, all control changes, all side agreements and all subsequent events.",
  },
  {
    code: "L-070",
    bracket: "L",
    label: "Management's 404(a) ICFR Assessment — RCM, Narratives, Test Results",
    tiers: ["annual"],
    authority: ["SOX 404(a)", "Reg S-K 308(a)", "Rule 13a-15(c)", "COSO 2013"],
    strong: ["icfr assessment", "404 assessment", "risk control matrix", "rcm", "process narrative", "control testing results", "coso mapping"],
    kw: ["icfr", "internal control", "404", "coso", "walkthrough", "control matrix", "test of controls"],
    neg: ["404(b)", "attestation"],
    gate: true,
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "NGTF is a non-accelerated filer, so there is NO auditor attestation under SOX 404(b) " +
      "(Dodd-Frank 989G; the 2020 SRC revenue carve-out keeps it permanently non-accelerated at " +
      "this revenue level). Management's OWN 404(a) report is still mandatory in the 10-K and " +
      "must be against a suitable recognized framework, i.e. COSO 2013. Segregation of duties " +
      "with a dual CEO/CFO and a small finance team is the most likely material weakness — " +
      "document the compensating-control analysis explicitly.",
  },
  {
    code: "L-080",
    bracket: "L",
    label: "ICFR Deficiency Log, Material Weakness & Remediation Tracker",
    tiers: ["quarterly", "annual"],
    authority: ["AS 1305", "Reg S-K 308(a)", "Rule 13a-15(d)", "AS 4105.18"],
    strong: ["deficiency log", "material weakness", "significant deficiency", "remediation plan", "remediation tracker", "control deficiency"],
    kw: ["deficiency", "material weakness", "remediation", "control gap"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["presentation", "completeness"],
    note:
      "AS 1305 applies to a financial-statement-only audit: the auditor must communicate " +
      "significant deficiencies and material weaknesses IN WRITING to management and the audit " +
      "committee BEFORE issuing the report. Rule 13a-15(d) requires a quarterly evaluation of " +
      "ICFR CHANGES and Item 308(c) disclosure of material changes.",
  },
  {
    code: "L-090",
    bracket: "L",
    label: "IT General Controls Documentation & SOC 1 Reports",
    tiers: ["annual"],
    authority: ["AS 2110.20", "AS 2601", "COSO 2013 Principle 11"],
    strong: ["itgc documentation", "soc 1", "soc report", "ssae 18", "access review", "change management log", "user access listing"],
    kw: ["itgc", "soc", "access control", "change management", "backup", "service organization"],
    neg: ["soc 2"],
    owner: "cfo",
    assertions: ["completeness", "accuracy"],
    note: "Get a SOC 1 for every service organization in the financial reporting flow — payroll processor, PMS, ERP host, transfer agent.",
  },
  {
    code: "L-100",
    bracket: "L",
    label: "Segregation-of-Duties Matrix & Compensating Control Analysis",
    tiers: ["annual"],
    authority: ["AS 2110.32", "COSO 2013", "Reg S-K 308(a)"],
    strong: ["segregation of duties", "sod matrix", "sod analysis", "compensating controls"],
    kw: ["segregation", "sod", "incompatible duties", "compensating"],
    neg: [],
    owner: "cfo",
    assertions: ["presentation"],
  },
  {
    code: "L-110",
    bracket: "L",
    label: "Audit Engagement Letter (Annual & Interim)",
    tiers: ["annual"],
    authority: ["AS 1301.05", "AS 1301.06", "AS 1000"],
    strong: ["engagement letter", "audit engagement letter", "interim review engagement letter", "terms of engagement"],
    kw: ["engagement", "terms of engagement", "arrangement letter"],
    neg: ["specialist engagement"],
    gate: true,
    owner: "audit_committee",
    assertions: ["presentation"],
    note: "AS 1301 requires the understanding of engagement terms to be established ANNUALLY and acknowledged by the audit committee.",
  },
  {
    code: "L-120",
    bracket: "L",
    label: "Management Representation Letter — Annual (AS 2805)",
    tiers: ["annual"],
    authority: ["AS 2805", "AS 2805.06", "AS 2805.10"],
    strong: ["annual management representation letter", "management representation letter", "representation letter", "as 2805"],
    kw: ["representation", "rep letter", "management letter of representation", "audit rep letter"],
    neg: ["legal representation", "quarterly representation", "quarterly rep", "interim rep", "review rep", "as 4105"],
    gate: true,
    owner: "cfo",
    assertions: ["completeness", "presentation"],
    note:
      "DATED AS OF THE AUDIT REPORT DATE — not the balance sheet date, not fieldwork " +
      "completion. Signed by CEO and CFO. Materiality thresholds may apply to amounts but NOT " +
      "to representations about management fraud or about availability of records. Refusal to " +
      "furnish it is a scope limitation that precludes an unqualified opinion.",
  },
  {
    code: "L-130",
    bracket: "L",
    label: "Management Representation Letter — Quarterly (AS 4105)",
    tiers: ["quarterly"],
    authority: ["AS 4105.24", "AS 4105.34", "Reg S-X 10-01(d)"],
    strong: ["quarterly representation letter", "interim representation letter", "review rep letter", "quarterly rep letter", "interim rep letter", "10-q representation"],
    kw: ["representation", "rep letter", "interim rep", "quarterly rep", "as 4105", "review letter"],
    neg: ["annual representation", "as 2805", "audit report date"],
    gate: true,
    owner: "cfo",
    assertions: ["completeness", "presentation"],
    note:
      "HARD GATE: if the required written representations are not obtained, the review is " +
      "INCOMPLETE, no review report can issue, and the 10-Q cannot be filed compliantly. Must " +
      "cover fair presentation, availability of all records and related-party information, " +
      "THAT ALL MINUTES WERE PROVIDED, control deficiencies, fraud and fraud ALLEGATIONS, " +
      "immateriality of uncorrected misstatements, ICFR changes and subsequent events.",
  },
  {
    code: "L-140",
    bracket: "L",
    label: "Audit Committee Communication Package (AS 1301 / AS 1305)",
    tiers: ["quarterly", "annual"],
    authority: ["AS 1301", "AS 1305", "AS 3101.11"],
    strong: ["audit committee communication", "required communications", "as 1301 communication", "audit committee presentation", "audit planning memo"],
    kw: ["audit committee package", "required communication", "planning presentation", "results presentation"],
    neg: ["audit committee minutes"],
    gate: true,
    owner: "auditor",
    assertions: ["presentation"],
    note:
      "All AS 1301 communications must occur BEFORE report issuance and must be documented in " +
      "the workpapers whether oral or written. This population is also where AS 3101 critical " +
      "audit matters come from — and CAMs apply here because NGTF is not an EGC.",
  },
  {
    code: "L-150",
    bracket: "L",
    label: "Auditor Consent (Exhibit 23.1) — Current & Predecessor",
    tiers: ["s1", "event"],
    authority: ["AS 4101", "Securities Act Section 7", "Reg S-K 601(b)(23)"],
    strong: ["exhibit 23.1", "consent of independent registered", "auditor consent", "accountants consent"],
    kw: ["consent", "23.1", "ex-23"],
    neg: [],
    gate: true,
    owner: "auditor",
    assertions: ["presentation"],
    note:
      "TWO consents are needed while Fruci's reports still cover FY2024/FY2025 in the " +
      "registration statement: one from TAAD and one from Fruci. Consents must be CURRENTLY " +
      "DATED at each amendment and at effectiveness — stale consents are a leading cause of " +
      "S-1 delay.",
  },
  {
    code: "L-160",
    bracket: "L",
    label: "Predecessor/Successor Auditor Communications & Workpaper Access",
    tiers: ["annual", "event", "s1"],
    authority: ["AS 2610", "AS 2610.08", "Form 8-K Item 4.01", "Reg S-K 304"],
    strong: ["predecessor auditor", "successor auditor", "workpaper access letter", "item 4.01", "exhibit 16.1", "change in certifying accountant", "auditor transition"],
    kw: ["predecessor", "successor", "workpaper access", "4.01", "16.1", "auditor change"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["completeness"],
    note:
      "TAAD succeeded Fruci on Oct 28, 2025 — the SIXTH Item 4.01 filing since 2014 and the " +
      "FOURTH auditor change since 2022. AS 2610 requires the company's EXPLICIT PERMISSION " +
      "for the predecessor to respond fully, and the successor must inquire about management " +
      "integrity, disagreements, fraud/illegal-act communications, the reasons for the change " +
      "and the predecessor's understanding of related parties. Predecessor workpaper access is " +
      "at Fruci's DISCRETION, not TAAD's right — a real scheduling risk. Frequent auditor " +
      "turnover is also a documented Nasdaq listing-review question.",
  },
  {
    code: "L-170",
    bracket: "L",
    label: "PBC Request List & Open-Items / Status Tracker",
    tiers: ["monthly", "quarterly", "annual"],
    authority: ["AS 1215.06", "AS 1301.25", "AS 1000"],
    strong: ["pbc list", "prepared by client", "request list", "open items list", "pbc tracker"],
    kw: ["pbc", "request list", "open items", "outstanding items"],
    neg: [],
    owner: "auditor",
    assertions: ["completeness"],
    note: "AS 1301 requires the auditor to report DIFFICULTIES ENCOUNTERED — including management delays and unavailability — to the audit committee. This tracker is that record.",
  },
  {
    code: "L-180",
    bracket: "L",
    label: "Form 12b-25 (NT 10-K / NT 10-Q) & Third-Party Statement",
    tiers: ["event"],
    authority: ["Rule 12b-25", "Rule 12b-25(c)"],
    strong: ["nt 10-k", "nt 10-q", "form 12b-25", "12b-25", "notification of late filing"],
    kw: ["12b-25", "nt 10", "late filing", "extension"],
    neg: [],
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "PATTERN FLAG: NGTF filed NT 10-K for FYE 6/30/2025 and NT 10-Q for Q1 and Q3 FY2026, and " +
      "the Q2 FY2026 10-Q appears to have been filed after its due date with no NT on file. " +
      "Rule 12b-25 requires the NT within ONE BUSINESS DAY of the due date, reasons in " +
      "reasonable detail, a representation that the reason could not be eliminated without " +
      "unreasonable effort or expense, and — where the delay is the auditor's — A SIGNED " +
      "STATEMENT FROM THE AUDITOR. Grace is 15 calendar days (annual) / 5 (quarterly). " +
      "Nasdaq 5250(c) requires timely filing as a continued-listing condition, so this pattern " +
      "must be fixed before a listing application, not after.",
  },
  {
    code: "L-190",
    bracket: "L",
    label: "Form 8-K Filings & Supporting Documentation",
    tiers: ["event"],
    authority: ["Form 8-K Gen. Instr. B.1", "Reg S-K 601"],
    strong: ["form 8-k", "8-k filing", "current report"],
    kw: ["8-k", "8k", "current report", "item 1.01", "item 4.01", "item 4.02", "item 5.02"],
    neg: ["8-k/a"],
    owner: "general_counsel",
    assertions: ["presentation", "completeness"],
    note: "4 business days from the event. Audit-relevant items: 1.01, 1.02, 1.05, 2.02, 2.03, 3.02, 4.01, 4.02, 5.02.",
  },
  {
    code: "L-200",
    bracket: "L",
    label: "Non-Reliance / Restatement Analysis (Item 4.02)",
    tiers: ["event"],
    authority: ["Form 8-K Item 4.02", "ASC 250", "AS 2905", "SAB 99"],
    strong: ["item 4.02", "non-reliance", "nonreliance", "restatement", "big r", "little r", "asc 250 analysis"],
    kw: ["restatement", "4.02", "non-reliance", "error correction", "revision"],
    neg: [],
    gate: true,
    conf: true,
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "None on file for NGTF as of Sept 2026 (EDGAR full-text search returned zero Item 4.02 " +
      "hits) — a genuinely good fact worth protecting. AS 2905 governs the auditor's duty when " +
      "previously issued statements can no longer be relied upon.",
  },
  {
    code: "L-210",
    bracket: "L",
    label: "Nasdaq Listing Application & Supporting Governance Package",
    tiers: ["event", "s1"],
    authority: ["Nasdaq 5505", "Nasdaq 5605", "Nasdaq 5250", "Form 8-A"],
    strong: ["listing application", "nasdaq application", "form 8-a", "listing agreement", "round lot analysis"],
    kw: ["listing", "nasdaq", "uplisting", "8-a", "market maker"],
    neg: ["deficiency notice"],
    owner: "general_counsel",
    assertions: ["presentation"],
    note:
      "Rule 5505 as amended Dec 18 2025 (operative May 15 2026) requires $15,000,000 Market " +
      "Value of Unrestricted Publicly Held Shares under ALL THREE standards, plus stockholders' " +
      "equity of $5M (Equity), $4M (MVLS, with $50M MVLS) or $4M (Net Income, with $750K net " +
      "income), 1,000,000 unrestricted publicly held shares, 300 round lot holders (50% holding " +
      "$2,500+), 3 market makers, and a $4.00 bid price (or the $2/$3 alternatives with net " +
      "tangible assets or revenue conditions) for 5 consecutive business days. An OTC uplisting " +
      "also needs 2,000 shares average daily volume over 30 trading days, waived for a firm-" +
      "commitment underwritten offering of $5M+. Since March 2025, a company listing in " +
      "connection with an offering must meet the unrestricted-public-shares test SOLELY from " +
      "offering proceeds — resale-registered shares no longer count, which matters because the " +
      "S-1 on file is a RESALE registration. Also check Rule 5210(i) (China-based companies: " +
      "$25M and a 12-month seasoning period for OTC uplistings) against the Taiwan target.",
  },
  {
    code: "L-220",
    bracket: "L",
    label: "Registration Statement (S-1) Drafts, Amendments & Bring-Down Package",
    tiers: ["s1", "event"],
    authority: ["AS 4101", "Securities Act Section 11", "Reg S-X 8-08"],
    strong: ["form s-1", "s-1/a", "registration statement", "prospectus", "bring down", "keeping current memo"],
    kw: ["s-1", "s1", "prospectus", "registration", "effectiveness", "amendment no"],
    neg: [],
    owner: "general_counsel",
    assertions: ["presentation"],
    note:
      "Section 11 liability attaches at EFFECTIVENESS, not the report date, so AS 4101 requires " +
      "the auditor to extend subsequent-events procedures from report date THROUGH effectiveness " +
      "and to repeat them at EACH amendment: read the prospectus, review the latest interim " +
      "information, inquire of management, read minutes, obtain an UPDATED LEGAL LETTER and " +
      "UPDATED MANAGEMENT REPRESENTATIONS. Reg S-X 8-08: statements older than 135 days at " +
      "effectiveness must be updated.",
  },
  {
    code: "L-230",
    bracket: "L",
    label: "Comfort Letter Package & Circled Prospectus (Underwritten Offering)",
    tiers: ["s1", "event"],
    authority: ["AS 6101", "AS 4105"],
    strong: ["comfort letter", "circle up", "circled prospectus", "underwriting agreement", "specified procedures request"],
    kw: ["comfort", "circle", "underwriter", "negative assurance", "cutoff date"],
    neg: [],
    owner: "cfo",
    assertions: ["accuracy"],
    note:
      "Only if the uplisting is paired with a firm-commitment underwritten raise — which it " +
      "likely must be, both to satisfy the $15M unrestricted-public-shares test from offering " +
      "proceeds and to obtain the 2,000-share ADV waiver. Requires a circle-up tying every " +
      "circled prospectus number to the accounting records, and minutes read through a cutoff " +
      "date roughly five days before the letter. Underwriter of record: Alliance Global Partners.",
  },

  // ══════════════════ M — BUSINESS COMBINATIONS ══════════════════
  {
    code: "M-010",
    bracket: "M",
    label: "Purchase / Merger / Share Exchange Agreements & LOIs",
    tiers: ["event", "s1"],
    authority: ["Form 8-K Item 1.01", "Reg S-K 601(b)(2)", "ASC 805"],
    strong: ["asset purchase agreement", "stock purchase agreement", "merger agreement", "share exchange agreement", "membership interest purchase", "letter of intent to acquire"],
    kw: ["acquisition", "apa", "spa", "merger", "share exchange", "purchase agreement", "loi"],
    neg: ["securities purchase agreement", "subscription"],
    gate: true,
    owner: "general_counsel",
    assertions: ["rights_obligations", "occurrence"],
    note:
      "Live matters: Victorville Treasure Holdings LLC (8-K filed 9/3/2025), Skytech / Future " +
      "Hospitality, and the June 2026 non-binding LOI for 51% of Jiun Jiang Enterprise Co., Ltd. " +
      "(Taiwan, share-exchange consideration). A share-exchange for 51% of a foreign operating " +
      "company raises, at once: ASC 805 vs. reverse-merger accounting, AS 1201 App B / AS 1206 " +
      "other-auditor scoping, Nasdaq 5635(a)/(b) shareholder approval and change-of-control, " +
      "IRC 382 NOL limitation, and possibly Nasdaq Rule 5210(i). Escalate to securities counsel " +
      "before signing, not after.",
  },
  {
    code: "M-020",
    bracket: "M",
    label: "Rule 3-05 / 8-04 Significance Test Computation",
    tiers: ["event"],
    authority: ["Reg S-X 8-04", "Reg S-X 3-05", "Rule 1-02(w)"],
    strong: ["significance test", "3-05 significance", "rule 3-05 test", "investment test", "asset test", "income test"],
    kw: ["significance", "3-05", "8-04", "1-02(w)", "20%", "40%"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["presentation"],
    note:
      "Rule 8-04 has no thresholds of its own — it points to Rule 3-05 with Articles 8-02/8-03 " +
      "substituted, so an SRC never needs more than TWO years. Thresholds: ≤20% none; >20–40% " +
      "one year plus interim; >40% two years plus interim. Individually insignificant " +
      "acquisitions AGGREGATING over 50% require pro formas plus audited statements for the " +
      "mathematical majority. Statements may be omitted once results have been in the " +
      "registrant's audited consolidated statements for nine months (≤40%) or a full year (>40%). " +
      "RUN THIS TEST AT SIGNING — it determines the 71-day deliverable and whether an audit of " +
      "the target must be commissioned immediately.",
  },
  {
    code: "M-030",
    bracket: "M",
    label: "Acquired Business Audited Financial Statements & Auditor Consent",
    tiers: ["event"],
    authority: ["Reg S-X 8-04", "Form 8-K Item 9.01(a)", "Reg S-X 2-02"],
    strong: ["acquired business financial statements", "target audited financials", "audited financial statements of", "audited financial statements", "8-k/a item 9.01", "financial statements of business acquired"],
    kw: ["acquired", "target financials", "9.01", "8-k/a", "audited statements of acquiree", "audited", "acquiree", "victorville", "skytech", "jiun jiang"],
    neg: [],
    gate: true,
    owner: "cfo",
    assertions: ["presentation", "completeness"],
    note:
      "DUE BY FORM 8-K/A WITHIN 71 CALENDAR DAYS of the date the initial 8-K was required. " +
      "TIMELINESS FLAG: the Victorville 8-K was filed 9/3/2025 and the Item 9.01 amendment came " +
      "2/3/2026 — roughly two and a half months past a 71-day deadline computed from the filing " +
      "dates. Two later 8-K/As (1/16/2026, 10/3/2025) also supplied Item 9.01 content. Build the " +
      "71-day clock into the deal calendar from signing; a target audit cannot be produced in " +
      "71 days if it is commissioned on day 60.",
  },
  {
    code: "M-040",
    bracket: "M",
    label: "Article 11 Pro Forma Condensed Combined Financial Information",
    tiers: ["event"],
    authority: ["Reg S-X 8-05", "Reg S-X 11-01", "Reg S-X 11-02"],
    strong: ["pro forma", "pro forma condensed combined", "article 11", "8-05 pro forma"],
    kw: ["pro forma", "proforma", "11-02", "transaction accounting adjustments", "autonomous entity"],
    neg: [],
    owner: "cfo",
    assertions: ["presentation", "accuracy"],
    note: "Prepared under Article 11 but may be condensed per Rule 8-03(a). Post-2020: transaction accounting adjustments, autonomous entity adjustments, and optional management's adjustments.",
  },
  {
    code: "M-050",
    bracket: "M",
    label: "ASC 805 Purchase Price Allocation & Valuation of Acquired Assets",
    tiers: ["event", "annual"],
    authority: ["ASC 805", "AS 2501", "AS 1210"],
    strong: ["purchase price allocation", "ppa", "asc 805", "opening balance sheet", "acquisition accounting", "fair value of acquired assets"],
    kw: ["ppa", "805", "allocation", "bargain purchase", "measurement period", "contingent consideration"],
    neg: [],
    owner: "cfo",
    assertions: ["valuation", "completeness", "presentation"],
    note: "Include the measurement-period adjustment tracking and any contingent-consideration/earnout model. Real-property PPAs need the appraisal supporting the land/building/FF&E split.",
  },
  {
    code: "M-060",
    bracket: "M",
    label: "Other Auditor / Component Auditor Package (AS 1201 App B, AS 1206)",
    tiers: ["event", "annual"],
    authority: ["AS 1201 App B", "AS 2101 App B", "AS 1206", "AS 1215.19"],
    strong: ["component auditor", "other auditor", "referred to auditor", "component materiality", "other auditor independence confirmation"],
    kw: ["component", "other auditor", "1206", "pcaob registration", "divided responsibility"],
    neg: [],
    owner: "auditor",
    assertions: ["completeness"],
    note:
      "AS 1205 is RESCINDED (FY ending on/after 12/15/2024); supervision now sits in AS 1201 " +
      "Appendix B with planning in AS 2101 Appendix B, and AS 1206 governs DIVIDING " +
      "responsibility. If a Taiwan component is audited by another firm: written confirmation of " +
      "PCAOB registration, independence under PCAOB AND SEC rules, and licensure; a component " +
      "materiality memo; and — if responsibility is divided — the report must NAME the other firm " +
      "and DISCLOSE THE MAGNITUDE of the portion it audited. AS 1215.19 requires the lead " +
      "auditor to obtain, review and retain specified documentation BEFORE report release.",
  },
];

// ── Derived indexes ─────────────────────────────────────────
const CATEGORY_BY_CODE = {};
CATEGORIES.forEach((c) => (CATEGORY_BY_CODE[c.code] = c));

function bracketOf(code) {
  return BRACKET_BY_CODE[String(code || "").charAt(0)] || null;
}

// Designated folder path for a category within a period.
//   /FY2027/Q1-2026-09-30/C-Cash-and-Treasury/C-030 Complete Bank Account Listing
function folderPath(categoryCode, { fiscalYear, periodLabel } = {}) {
  const cat = CATEGORY_BY_CODE[categoryCode];
  if (!cat) return null;
  const br = bracketOf(categoryCode);
  const fy = fiscalYear ? `FY${fiscalYear}` : "FY-UNASSIGNED";
  const per = periodLabel || "PERIOD-UNASSIGNED";
  const leaf = `${cat.code} ${cat.label}`.replace(/[\\/:*?"<>|]/g, "-");
  return `/${fy}/${per}/${br.folder}/${leaf}`;
}

function categoriesForTier(tier) {
  return CATEGORIES.filter((c) => c.tiers.includes(tier));
}

function categoriesForBracket(bracketCode) {
  return CATEGORIES.filter((c) => c.bracket === bracketCode);
}

function gateItems(tier) {
  return categoriesForTier(tier).filter((c) => c.gate);
}

function isConfidential(categoryCode) {
  const c = CATEGORY_BY_CODE[categoryCode];
  return !!(c && c.conf);
}

// Flat list for classifier consumption — precomputed lowercase tokens.
const CLASSIFIER_INDEX = CATEGORIES.map((c) => ({
  code: c.code,
  bracket: c.bracket,
  label: c.label,
  strong: (c.strong || []).map((s) => s.toLowerCase()),
  kw: (c.kw || []).map((s) => s.toLowerCase()),
  neg: (c.neg || []).map((s) => s.toLowerCase()),
  labelTokens: c.label
    .toLowerCase()
    .replace(/[^a-z0-9 &/-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3),
}));

// Counts used by the README and the UI header.
const STATS = {
  brackets: BRACKETS.length,
  categories: CATEGORIES.length,
  monthly: categoriesForTier("monthly").length,
  quarterly: categoriesForTier("quarterly").length,
  annual: categoriesForTier("annual").length,
  event: categoriesForTier("event").length,
  s1: categoriesForTier("s1").length,
  gates: CATEGORIES.filter((c) => c.gate).length,
};

module.exports = {
  TIERS,
  BRACKETS,
  BRACKET_BY_CODE,
  CATEGORIES,
  CATEGORY_BY_CODE,
  CLASSIFIER_INDEX,
  STATS,
  bracketOf,
  folderPath,
  categoriesForTier,
  categoriesForBracket,
  gateItems,
  isConfidential,
};
