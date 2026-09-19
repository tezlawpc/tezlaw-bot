// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-checklists.js — CHECKLIST GENERATION ENGINE
//  ─────────────────────────────────────────────────────────
//  Builds three escalating checklists off the same taxonomy:
//
//    MONTHLY    — the close package. Keeps evidence contemporaneous
//                 so the quarterly 302 certification is supportable.
//                 ~36 document items + monthly sweep questions.
//
//    QUARTERLY  — everything monthly PLUS the AS 4105 interim review
//                 package. Gated: Reg S-X 10-01(d) requires the
//                 review to be COMPLETE before the 10-Q is filed,
//                 and AS 4105.34 makes the review incomplete without
//                 the management representation letter.
//
//    ANNUAL     — everything quarterly PLUS the full audit PBC list,
//                 legal letters, 404(a) ICFR assessment, tax returns,
//                 confirmations and the AS 2805 representation letter.
//
//  TWO KINDS OF ITEM, and the second kind is the point:
//
//    1. DOCUMENT ITEMS  — satisfied by uploading a file that the
//       classifier routes to that category. Auto-ticks.
//
//    2. SWEEP QUESTIONS — a yes/no the company answers. "Were any
//       bank accounts opened or closed this month?" A NO is signed
//       negative assurance and closes the item. A YES SPAWNS the
//       document requirements it implies, as new checklist items
//       with their own due dates.
//
//       This is how a document that nobody remembered to send gets
//       caught. A checklist of only "upload X" items can never
//       surface the thing you forgot existed; a sweep question can.
//       It also mirrors what the auditor is required to ASK under
//       AS 4105.18 — so answering it is not busywork, it is the
//       company pre-answering the interim review inquiries.
//
//  Due dates are computed BACKWARD from the statutory filing
//  deadline in audit-calendar.js, not forward from period end, so
//  the checklist automatically respects Rule 0-3 rolling and the
//  June-30 fiscal year.
// ============================================================

const tax = require("./audit-taxonomy");
const cal = require("./audit-calendar");

// ── Lead times (days BEFORE the statutory filing deadline) ──
// Tunable via env without touching code.
const LEAD = {
  quarterly_gate: Number(process.env.AUDIT_LEAD_Q_GATE || 25),
  quarterly_std: Number(process.env.AUDIT_LEAD_Q_STD || 18),
  annual_gate: Number(process.env.AUDIT_LEAD_A_GATE || 60),
  annual_std: Number(process.env.AUDIT_LEAD_A_STD || 45),
  // Monthly has no statutory deadline — it runs off close-day targets.
  monthly_close_day: Number(process.env.AUDIT_MONTHLY_CLOSE_DAY || 8),
  monthly_gate_day: Number(process.env.AUDIT_MONTHLY_GATE_DAY || 5),
  monthly_sweep_day: Number(process.env.AUDIT_MONTHLY_SWEEP_DAY || 10),
};

// ── Sweep questions ─────────────────────────────────────────
// `spawns` = taxonomy codes that become required if answered YES.
// `authority` = why the auditor is going to ask this anyway.
const SWEEP_QUESTIONS = [
  // ---------- monthly ----------
  {
    id: "SW-BANK-NEW",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Were any bank, brokerage, custodial, merchant-processor or payment-platform accounts " +
      "OPENED, CLOSED or re-titled during the period — including zero-balance accounts?",
    spawns: ["C-030", "C-010", "C-020"],
    authority: ["AS 2310.08", "AS 2805.06"],
    why:
      "Completeness of the cash population is an explicit management representation. A new " +
      "account nobody mentioned is the classic undisclosed-cash finding.",
    owner: "controller",
  },
  {
    id: "SW-CONTRACT",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Were any material agreements ENTERED INTO, amended or TERMINATED during the period — " +
      "customer, vendor, lease, debt, employment, franchise or management agreements?",
    spawns: ["D-040", "K-070", "G-020", "F-060", "I-030"],
    authority: ["AS 2805.06", "Form 8-K Item 1.01", "Form 8-K Item 1.02"],
    why:
      "Also a Form 8-K Item 1.01/1.02 trigger on a four-business-day clock — so a YES here " +
      "is a disclosure question, not only an audit-evidence question.",
    owner: "general_counsel",
  },
  {
    id: "SW-SIDELETTER",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Were there ANY side letters, verbal arrangements, non-standard terms, price concessions, " +
      "rebates or return rights granted to customers that are not in the signed contract?",
    spawns: ["D-040", "D-070", "D-050"],
    authority: ["AS 2401.66", "ASC 606", "AS 2805.06"],
    why:
      "Undisclosed side arrangements are the textbook revenue-fraud vector and are covered by " +
      "the representation letter. Answer this one personally, not by delegation.",
    owner: "cfo",
  },
  {
    id: "SW-RELPARTY",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Were there ANY transactions, balances, advances, expense reimbursements or guarantees " +
      "with officers, directors, 5%+ holders, or entities they control?",
    spawns: ["I-090", "G-080", "I-100", "A-080"],
    authority: ["AS 2410", "Reg S-K 404", "SOX 402", "Nasdaq 5630"],
    why:
      "AS 2410 requires the auditor to test related-party COMPLETENESS against minutes, " +
      "conflict statements and tax filings. Note that SOX 402 PROHIBITS personal loans to " +
      "executives outright — a YES involving an officer loan is a legal issue, not a " +
      "disclosure issue. Submit a NIL answer rather than leaving this blank.",
    owner: "cfo",
  },
  {
    id: "SW-EQUITY",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Were any shares, options, warrants, RSUs or convertible instruments ISSUED, EXERCISED, " +
      "CONVERTED, repriced, cancelled or forfeited during the period?",
    spawns: ["H-010", "H-020", "H-030", "H-040", "H-070", "G-040", "H-090"],
    authority: ["ASC 718", "ASC 470-20", "Form 8-K Item 3.02", "Nasdaq 5635"],
    why:
      "Share count went from 151.9M to 507.5M in seven months. Every movement has to tie to a " +
      "board approval and to the transfer agent report, and unregistered issuances are an " +
      "Item 3.02 8-K event.",
    owner: "cfo",
  },
  {
    id: "SW-LITIGATION",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Are you aware of any NEW or changed litigation, claim, demand letter, arbitration, " +
      "assessment, or any UNASSERTED CLAIM that is probable of being asserted?",
    spawns: ["K-010", "K-030", "K-020"],
    authority: ["AS 2505.05", "AS 2505.06", "ASC 450"],
    why:
      "AS 2505 requires management to identify unasserted claims probable of assertion — the " +
      "part that is invisible to the auditor unless management volunteers it, and the part no " +
      "auditor will waive.",
    owner: "general_counsel",
  },
  {
    id: "SW-REGULATORY",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Was any correspondence received from the SEC, FINRA, Nasdaq, OTC Markets, the IRS, a " +
      "state tax authority or any other regulator?",
    spawns: ["K-040", "K-050", "I-070"],
    authority: ["AS 2805.06", "AS 4105.18"],
    why:
      "Management represents that ALL regulatory communications have been made available. " +
      "Withheld correspondence is a representation breach.",
    owner: "general_counsel",
  },
  {
    id: "SW-FRAUD",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Are you aware of any fraud, suspected fraud, or ALLEGATION of fraud affecting the " +
      "company — from any source, including employees, former employees, customers, vendors, " +
      "short sellers, regulators or anonymous tips?",
    spawns: ["A-090"],
    authority: ["AS 2401", "AS 4105.18", "SOX 301"],
    why:
      "AS 4105 requires the auditor to inquire specifically about ALLEGATIONS, not just known " +
      "fraud, and the SOX 301 complaint procedure is what creates the record. A NIL answer " +
      "each period is itself the evidence.",
    owner: "cfo",
    sensitive: true,
  },
  {
    id: "SW-CONTROLS",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Were there any changes in internal control over financial reporting, any newly " +
      "identified control deficiency, or any change in accounting personnel or systems?",
    spawns: ["L-080", "L-060", "L-070"],
    authority: ["Rule 13a-15(d)", "Reg S-K 308(c)", "AS 1305"],
    why:
      "Rule 13a-15(d) requires a QUARTERLY evaluation of ICFR changes and Item 308(c) requires " +
      "disclosure of material changes. With a dual CEO/CFO role and a small finance team, " +
      "personnel changes move the segregation-of-duties conclusion.",
    owner: "cfo",
  },
  {
    id: "SW-COVENANT",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Was any debt covenant breached, waived, amended or at risk of breach; was any default " +
      "notice received; or did any debt become callable or accelerate?",
    spawns: ["G-030", "G-010", "G-020", "J-010"],
    authority: ["AS 2415.07", "ASC 470-10-45", "AS 2805.06"],
    why:
      "A breach not waived BEFORE the balance sheet date reclassifies long-term debt to current " +
      "and is a going-concern condition. This must be answered every month even where the " +
      "agreement certifies only quarterly.",
    owner: "cfo",
  },
  {
    id: "SW-SUBSEQUENT",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Have any events occurred AFTER period end that require adjustment to, or disclosure in, " +
      "the financial statements?",
    spawns: ["J-010", "L-190"],
    authority: ["ASC 855", "AS 2801", "AS 4105.18", "AS 4101"],
    why:
      "Runs through the filing date, and for a registration statement all the way through " +
      "EFFECTIVENESS under AS 4101 — which is why this question repeats at each S-1 amendment.",
    owner: "cfo",
  },
  {
    id: "SW-GOINGCONCERN",
    tiers: ["monthly", "quarterly", "annual"],
    prompt:
      "Has anything changed in the liquidity picture — cash runway, committed financing, " +
      "supplier terms, trade credit, payroll tax timeliness, or the probability of any planned raise?",
    spawns: ["J-010", "J-020", "J-030", "C-080"],
    authority: ["AS 2415", "ASC 205-40"],
    why:
      "Substantial doubt is already concluded, so the assessment refreshes every close. Note " +
      "that only plans PROBABLE of occurring and probable of being effective mitigate doubt — " +
      "a non-binding LOI generally does not.",
    owner: "cfo",
  },

  // ---------- quarterly-and-up ----------
  {
    id: "SW-ACQUISITION",
    tiers: ["quarterly", "annual"],
    prompt:
      "Was any business, real property, or equity interest ACQUIRED or DISPOSED of, or any " +
      "letter of intent or definitive agreement signed for one?",
    spawns: ["M-010", "M-020", "M-030", "M-040", "M-050", "F-040"],
    authority: ["Reg S-X 8-04", "Form 8-K Item 9.01(a)(4)", "ASC 805"],
    why:
      "Run the Rule 3-05/8-04 significance test AT SIGNING. If it clears 20%, audited target " +
      "financials and pro formas are due by 8-K/A within 71 days of when the initial 8-K was " +
      "required — a deadline the Victorville amendment missed by roughly two and a half months. " +
      "A target audit cannot be produced in 71 days if commissioned on day 60.",
    owner: "cfo",
  },
  {
    id: "SW-ESTIMATE-CHANGE",
    tiers: ["quarterly", "annual"],
    prompt:
      "Did any accounting estimate, method, assumption or accounting POLICY change, or was any " +
      "new accounting standard adopted?",
    spawns: ["J-060", "J-040", "B-110", "L-140"],
    authority: ["AS 2501", "AS 1301.10", "ASC 250"],
    why: "AS 1301 requires the auditor to communicate initial selection of, and changes in, significant policies to the audit committee.",
    owner: "controller",
  },
  {
    id: "SW-IMPAIRMENT",
    tiers: ["quarterly", "annual"],
    prompt:
      "Were there any triggering events for impairment — sustained market cap below book value, " +
      "loss of a major customer or supplier, adverse hotel performance, idle or redeployed " +
      "robot units, or a decision to exit a line of business?",
    spawns: ["J-040", "F-080", "B-130"],
    authority: ["ASC 350-20", "ASC 360-10-35", "AS 2501"],
    why:
      "Document the triggering-event ASSESSMENT every quarter even when the conclusion is that " +
      "no test is required. A going-concern conclusion is itself an indicator.",
    owner: "controller",
  },
  {
    id: "SW-MINUTES-COMPLETE",
    tiers: ["quarterly", "annual"],
    prompt:
      "Have ALL minutes and written consents of the board, every committee, and the " +
      "shareholders been provided for the period — including unapproved drafts and meetings " +
      "held without formal minutes?",
    spawns: ["A-010", "A-020", "A-030", "A-040"],
    authority: ["AS 4105.15", "AS 4105.24", "AS 2410.07"],
    why:
      "That all minutes were provided is an EXPLICIT required representation in the quarterly " +
      "rep letter. If minutes are not yet prepared, a management summary is acceptable — " +
      "silence is not.",
    owner: "corporate_secretary",
  },
  {
    id: "SW-CYBER",
    tiers: ["quarterly", "annual"],
    prompt: "Was there any cybersecurity incident, data breach, ransomware event or unauthorized system access?",
    spawns: ["K-060"],
    authority: ["Form 8-K Item 1.05", "Reg S-K 106"],
    why:
      "The Item 1.05 four-business-day clock runs from the MATERIALITY DETERMINATION, not from " +
      "discovery — and the determination must be made without unreasonable delay.",
    owner: "cfo",
  },
  {
    id: "SW-NONGAAP",
    tiers: ["quarterly", "annual"],
    prompt: "Was any earnings release, investor presentation, press release or non-GAAP measure issued during the period?",
    spawns: ["L-190", "B-060"],
    authority: ["Reg G", "Form 8-K Item 2.02", "AS 2110.11"],
    why:
      "Earnings releases are Item 2.02 8-K events and non-GAAP measures need Reg G " +
      "reconciliations. AS 2110.11 also makes press releases and investor presentations a " +
      "risk-assessment input — and my file notes an informal FINRA inquiry into 2025 press " +
      "releases, so route all IR material through securities counsel first.",
    owner: "cfo",
  },

  // ---------- annual only ----------
  {
    id: "SW-TAX-FILINGS",
    tiers: ["annual"],
    prompt:
      "Are ALL federal, state, local, payroll, sales/use, property and franchise tax returns " +
      "filed and current for every entity and every jurisdiction — and are there any unfiled " +
      "returns, delinquencies, payment plans or nexus exposures?",
    spawns: ["I-040", "I-020", "I-080", "I-070"],
    authority: ["AS 2410.07", "ASC 740", "AS 2415.07"],
    why:
      "Unfiled returns are unrecorded liabilities. Delinquent PAYROLL taxes in particular are " +
      "both a going-concern indicator and a source of personal officer liability. Multi-state " +
      "nexus is live here given packaging distribution plus hotels in several states.",
    owner: "cfo",
  },
  {
    id: "SW-382",
    tiers: ["annual"],
    prompt:
      "Has there been any ownership shift that could constitute an IRC Section 382 ownership " +
      "change — large issuances, a change of control, or a 5%-holder shift?",
    spawns: ["I-060", "I-050"],
    authority: ["IRC 382", "ASC 740-10-30"],
    why:
      "The 3.3x share-count increase and any change of control from the Taiwan transaction are " +
      "classic 382 triggers that can limit or wipe out the NOL carried against a $60.2M " +
      "accumulated deficit. Commission the 382 study BEFORE the next equity event, not after.",
    owner: "cfo",
  },
  {
    id: "SW-SPECIALIST",
    tiers: ["annual"],
    prompt: "Was any third-party valuation firm, appraiser, actuary or other specialist engaged whose work affects the financial statements?",
    spawns: ["J-050", "H-060", "M-050"],
    authority: ["AS 1210", "AS 2501.28"],
    why: "The auditor must evaluate the specialist's competence, capabilities and objectivity — which requires the engagement letter and credentials, not just the report.",
    owner: "cfo",
  },
  {
    id: "SW-AUDITOR-CHANGE",
    tiers: ["annual", "s1"],
    prompt:
      "Was there any change in, or consultation with, an accounting firm other than the " +
      "engaged auditor — including a second opinion on an accounting position?",
    spawns: ["L-160", "L-190"],
    authority: ["AS 2610", "AS 6105", "Reg S-K 304(a)(2)", "Form 8-K Item 4.01"],
    why:
      "AS 6105 requires a reporting accountant giving a second opinion to CONSULT the continuing " +
      "auditor — the anti-opinion-shopping mechanism — and Item 304(a)(2) may require disclosing " +
      "the consultation. NGTF has had four auditor changes since 2022 (TAAD succeeded Fruci on " +
      "Oct 28, 2025), which Nasdaq will ask about on the listing application.",
    owner: "cfo",
  },
  {
    id: "SW-UPLIST",
    tiers: ["annual", "s1"],
    prompt:
      "Any development in the Nasdaq uplisting — listing application, reverse split, " +
      "underwritten offering, round-lot holder analysis, or governance remediation?",
    spawns: ["L-210", "H-100", "L-230", "A-050", "A-100"],
    authority: ["Nasdaq 5505", "Nasdaq 5605", "Nasdaq 5810", "Nasdaq 5210(i)"],
    why:
      "Sequencing matters and some of it is counter-intuitive. A reverse split within the prior " +
      "one-year period is an immediate delisting trigger for a listed company; since March 2025 " +
      "the $15M unrestricted-public-shares test must be met SOLELY from offering proceeds, so " +
      "the resale S-1 on file does not help it; and Rule 5210(i) may impose $25M plus a " +
      "12-month seasoning period. Securities counsel owns this sequence.",
    owner: "general_counsel",
  },
];

// ── Item due-date computation ───────────────────────────────

function monthlyDueDate(monthEnd, kind) {
  const day =
    kind === "gate" ? LEAD.monthly_gate_day : kind === "sweep" ? LEAD.monthly_sweep_day : LEAD.monthly_close_day;
  return cal.iso(cal.rollForward(cal.addBusinessDays(cal.parse(monthEnd), day)));
}

function backFrom(filingDue, days) {
  return cal.iso(cal.rollForward(cal.addDays(cal.parse(filingDue), -days)));
}

// ── Checklist builders ──────────────────────────────────────

/**
 * Monthly close checklist.
 * @param {number} fy   fiscal year (e.g. 2027)
 * @param {number} fm   fiscal month 1..12 (1 = July)
 */
function buildMonthly(fy, fm) {
  const months = cal.fiscalMonths(fy);
  const month = months.find((m) => m.fiscalMonth === fm);
  if (!month) throw new Error(`Invalid fiscal month ${fm} for FY${fy}`);
  const end = cal.iso(month.end);

  const docItems = tax.categoriesForTier("monthly").map((c) => ({
    kind: "document",
    categoryCode: c.code,
    bracketCode: c.bracket,
    label: c.label,
    authority: c.authority,
    isGate: !!c.gate,
    owner: c.owner || "controller",
    dueDate: monthlyDueDate(end, c.gate ? "gate" : "standard"),
    folderPath: tax.folderPath(c.code, { fiscalYear: fy, periodLabel: month.label }),
    note: c.note || null,
  }));

  const sweepItems = SWEEP_QUESTIONS.filter((q) => q.tiers.includes("monthly")).map((q) => ({
    kind: "sweep",
    sweepId: q.id,
    label: q.prompt,
    authority: q.authority,
    why: q.why,
    spawns: q.spawns,
    owner: q.owner,
    sensitive: !!q.sensitive,
    isGate: false,
    dueDate: monthlyDueDate(end, "sweep"),
  }));

  return {
    tier: "monthly",
    fiscalYear: fy,
    fiscalMonth: fm,
    periodLabel: month.label,
    periodName: month.name,
    periodEnd: end,
    isQuarterEnd: month.isQuarterEnd,
    isFiscalYearEnd: month.isFiscalYearEnd,
    filingDeadline: null,
    targetCompleteBy: monthlyDueDate(end, "sweep"),
    items: [...docItems, ...sweepItems],
    counts: { documents: docItems.length, sweeps: sweepItems.length, gates: docItems.filter((i) => i.isGate).length },
    headline:
      month.isFiscalYearEnd
        ? "Month 12 is also fiscal year end — the ANNUAL checklist supersedes this one."
        : month.isQuarterEnd
        ? `Month ${fm} is also ${month.quarter === 4 ? "FY" : "Q" + month.quarter} end — the QUARTERLY checklist supersedes this one.`
        : "Standard monthly close. Keeps the evidence contemporaneous so the quarterly 302 certification is supportable.",
  };
}

/**
 * Quarterly interim-review checklist (Q1–Q3).
 * Q4 has no 10-Q — call buildAnnual instead.
 */
function buildQuarterly(fy, quarter) {
  if (![1, 2, 3].includes(quarter)) {
    throw new Error(`Quarter ${quarter} has no 10-Q for a June-30 FYE issuer — use buildAnnual(${fy})`);
  }
  const dl = cal.tenQDeadline(fy, quarter);

  const docItems = tax.categoriesForTier("quarterly").map((c) => ({
    kind: "document",
    categoryCode: c.code,
    bracketCode: c.bracket,
    label: c.label,
    authority: c.authority,
    isGate: !!c.gate,
    owner: c.owner || "controller",
    dueDate: backFrom(dl.dueDate, c.gate ? LEAD.quarterly_gate : LEAD.quarterly_std),
    folderPath: tax.folderPath(c.code, { fiscalYear: fy, periodLabel: dl.periodLabel }),
    note: c.note || null,
  }));

  const sweepItems = SWEEP_QUESTIONS.filter((q) => q.tiers.includes("quarterly")).map((q) => ({
    kind: "sweep",
    sweepId: q.id,
    label: q.prompt,
    authority: q.authority,
    why: q.why,
    spawns: q.spawns,
    owner: q.owner,
    sensitive: !!q.sensitive,
    isGate: false,
    dueDate: backFrom(dl.dueDate, LEAD.quarterly_gate),
  }));

  return {
    tier: "quarterly",
    fiscalYear: fy,
    quarter,
    periodLabel: dl.periodLabel,
    periodName: `Q${quarter} FY${fy} (quarter ended ${dl.periodEnd})`,
    periodEnd: dl.periodEnd,
    filingDeadline: dl,
    targetCompleteBy: backFrom(dl.dueDate, LEAD.quarterly_std),
    items: [...docItems, ...sweepItems],
    counts: { documents: docItems.length, sweeps: sweepItems.length, gates: docItems.filter((i) => i.isGate).length },
    headline:
      `Form 10-Q due ${dl.dueDate} (45 days, non-accelerated). Reg S-X 10-01(d) requires the ` +
      `AS 4105 interim review to be COMPLETE BEFORE FILING — the review gates the filing, and ` +
      `AS 4105.34 makes the review incomplete without the signed quarterly representation ` +
      `letter. AS 1220 also requires an engagement quality review with concurring approval of ` +
      `issuance for interim reviews, so build the reviewer's turnaround into this window. ` +
      `If the filing will be late, Form 12b-25 must be filed by ${dl.ntDueBy} (one business ` +
      `day after the due date) and the report itself by ${dl.extendedDueDate}.`,
  };
}

/** Annual audit checklist (FYE June 30). */
function buildAnnual(fy) {
  const dl = cal.tenKDeadline(fy);

  const docItems = tax.categoriesForTier("annual").map((c) => ({
    kind: "document",
    categoryCode: c.code,
    bracketCode: c.bracket,
    label: c.label,
    authority: c.authority,
    isGate: !!c.gate,
    owner: c.owner || "controller",
    dueDate: backFrom(dl.dueDate, c.gate ? LEAD.annual_gate : LEAD.annual_std),
    folderPath: tax.folderPath(c.code, { fiscalYear: fy, periodLabel: dl.periodLabel }),
    note: c.note || null,
  }));

  const sweepItems = SWEEP_QUESTIONS.filter((q) => q.tiers.includes("annual")).map((q) => ({
    kind: "sweep",
    sweepId: q.id,
    label: q.prompt,
    authority: q.authority,
    why: q.why,
    spawns: q.spawns,
    owner: q.owner,
    sensitive: !!q.sensitive,
    isGate: false,
    dueDate: backFrom(dl.dueDate, LEAD.annual_gate),
  }));

  return {
    tier: "annual",
    fiscalYear: fy,
    quarter: 4,
    periodLabel: dl.periodLabel,
    periodName: `FY${fy} (year ended ${dl.periodEnd})`,
    periodEnd: dl.periodEnd,
    filingDeadline: dl,
    targetCompleteBy: backFrom(dl.dueDate, LEAD.annual_std),
    items: [...docItems, ...sweepItems],
    counts: { documents: docItems.length, sweeps: sweepItems.length, gates: docItems.filter((i) => i.isGate).length },
    headline:
      `Form 10-K due ${dl.dueDate} (90 days, non-accelerated); Part III incorporation by ` +
      `reference requires a proxy or information statement by ${dl.partIIIDeadline} (120 days). ` +
      `Reg S-X 8-02 scaling applies — TWO audited balance sheets and two years of income, cash ` +
      `flow and equity statements, not three. NGTF is NOT an emerging growth company, so the ` +
      `auditor's report MUST include critical audit matters under AS 3101; expect the ASC 815 ` +
      `derivative/warrant classification and the going-concern assessment to be the CAMs. No ` +
      `SOX 404(b) auditor attestation is required (non-accelerated filer), but management's own ` +
      `404(a) COSO-based ICFR report is mandatory. If the filing will be late, Form 12b-25 is ` +
      `due ${dl.ntDueBy} and the report by ${dl.extendedDueDate} — and note that a 12b-25 ` +
      `blaming the auditor requires a SIGNED STATEMENT FROM THE AUDITOR attached.`,
  };
}

/** Registration-statement bring-down checklist (AS 4101). */
function buildS1BringDown(fy, amendmentLabel = "S-1/A") {
  const codes = tax.categoriesForTier("s1");
  const items = codes.map((c) => ({
    kind: "document",
    categoryCode: c.code,
    bracketCode: c.bracket,
    label: c.label,
    authority: c.authority,
    isGate: !!c.gate,
    owner: c.owner || "cfo",
    dueDate: null,
    folderPath: tax.folderPath(c.code, { fiscalYear: fy, periodLabel: `S1-${amendmentLabel}` }),
    note: c.note || null,
  }));
  const sweeps = SWEEP_QUESTIONS.filter((q) => q.tiers.includes("s1")).map((q) => ({
    kind: "sweep",
    sweepId: q.id,
    label: q.prompt,
    authority: q.authority,
    why: q.why,
    spawns: q.spawns,
    owner: q.owner,
    isGate: false,
    dueDate: null,
  }));
  return {
    tier: "s1",
    fiscalYear: fy,
    periodLabel: `S1-${amendmentLabel}`,
    periodName: `Registration statement bring-down — ${amendmentLabel}`,
    periodEnd: null,
    filingDeadline: null,
    targetCompleteBy: null,
    items: [...items, ...sweeps],
    counts: { documents: items.length, sweeps: sweeps.length, gates: items.filter((i) => i.isGate).length },
    headline:
      `Securities Act Section 11 liability attaches at EFFECTIVENESS, not at the audit report ` +
      `date. AS 4101 therefore requires the auditor to extend subsequent-events procedures from ` +
      `report date through effectiveness and to REPEAT them at each amendment: read the ` +
      `prospectus, review the latest interim information, inquire of management, read minutes, ` +
      `obtain an updated legal letter and updated management representations. Consents must be ` +
      `CURRENTLY DATED — and TWO are needed while Fruci's reports still cover FY2024/FY2025: ` +
      `one from TAAD and one from Fruci. Reg S-X 8-08: financial statements older than 135 days ` +
      `at effectiveness must be updated. Stale consents and stale financials are the two most ` +
      `common causes of S-1 delay.`,
  };
}

// ── Full-year plan (used to seed a fiscal year at once) ─────
function buildFiscalYearPlan(fy) {
  const out = [];
  for (let fm = 1; fm <= 12; fm++) {
    const m = cal.fiscalMonths(fy).find((x) => x.fiscalMonth === fm);
    if (m.isFiscalYearEnd) continue; // annual supersedes
    if (m.isQuarterEnd) continue; // quarterly supersedes
    out.push(buildMonthly(fy, fm));
  }
  out.push(buildQuarterly(fy, 1));
  out.push(buildQuarterly(fy, 2));
  out.push(buildQuarterly(fy, 3));
  out.push(buildAnnual(fy));
  return out.sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
}

// ── Event engagements ───────────────────────────────────────
//
// An event engagement is not a period. It is one transaction — an
// acquisition, a disposition, an auditor change, a non-reliance
// determination — and its clock starts on the day the event happened
// rather than on a fiscal boundary.
//
// Two deadlines drive it, and they are the reason this tier exists
// separately from the quarterly checklist that merely ASKS whether an
// event occurred:
//
//   Form 8-K Gen. Instr. B.1   four business days from the event
//   Form 8-K Item 9.01(a)(4)   71 calendar days from that 8-K due date
//                              for acquired-business financials
//
// The 71-day clock is the one that gets missed. It is why M-020 (the
// significance test) and M-030 (the target's audited financials) carry
// the amendment date rather than the 8-K date: the significance test
// has to be run AT SIGNING, because if it clears 20% a full audit of
// the target has to be produced inside 71 days, and that cannot be
// commissioned on day 60. Nightfood's Victorville Item 9.01 amendment
// missed this window by roughly two and a half months.

/** Filesystem- and URL-safe fragment of an event name. */
function eventSlug(label) {
  return (
    String(label || "event")
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .toUpperCase() || "EVENT"
  );
}

/**
 * Build the checklist for a single transaction.
 *
 * @param {number} fy      fiscal year the event falls in
 * @param {object|string} spec  { label, eventDate } — a bare string is
 *                              treated as the label with today's date.
 */
function buildEvent(fy, spec) {
  const s = typeof spec === "string" ? { label: spec } : spec || {};
  const label = s.label || "Unnamed event";
  const eventDate = cal.dstr(s.eventDate) || cal.dstr(new Date());

  const eightK = cal.eightKDeadline(eventDate);
  const amendment = cal.eightKAFinancialsDeadline(eventDate);
  const periodLabel = `EVT-${eventDate}-${eventSlug(label)}`;

  // Rule 3-05/8-04 items run on the 71-day amendment clock; every other
  // gating item is needed for the initial 8-K itself.
  const AMENDMENT_ITEMS = new Set(["M-020", "M-030"]);

  const codes = tax.categoriesForTier("event");
  const items = codes.map((c) => ({
    kind: "document",
    categoryCode: c.code,
    bracketCode: c.bracket,
    label: c.label,
    authority: c.authority,
    isGate: !!c.gate,
    owner: c.owner || "cfo",
    dueDate: AMENDMENT_ITEMS.has(c.code)
      ? amendment && amendment.amendmentDueDate
      : c.gate
      ? eightK && eightK.dueDate
      : null,
    folderPath: tax.folderPath(c.code, { fiscalYear: fy, periodLabel }),
    note: c.note || null,
  }));

  const sweeps = SWEEP_QUESTIONS.filter((q) => q.tiers.includes("event")).map((q) => ({
    kind: "sweep",
    sweepId: q.id,
    label: q.prompt,
    authority: q.authority,
    why: q.why,
    spawns: q.spawns,
    owner: q.owner,
    isGate: false,
    dueDate: null,
  }));

  return {
    tier: "event",
    fiscalYear: fy,
    periodLabel,
    periodName: `Event — ${label} (${eventDate})`,
    periodEnd: eventDate,
    eventDate,
    eventLabel: label,
    filingDeadline: eightK
      ? {
          form: "8-K",
          dueDate: eightK.dueDate,
          ntDueBy: null,
          extendedDueDate: amendment ? amendment.amendmentDueDate : null,
        }
      : null,
    targetCompleteBy: eightK ? eightK.dueDate : null,
    items: [...items, ...sweeps],
    counts: {
      documents: items.length,
      sweeps: sweeps.length,
      gates: items.filter((i) => i.isGate).length,
    },
    headline:
      `Event of ${eventDate}: "${label}". The initial Form 8-K is due ` +
      `${eightK ? eightK.dueDate : "—"} (four business days, Gen. Instr. B.1). If this is a ` +
      `business acquisition, run the Rule 3-05/8-04 significance test NOW, not at quarter end: ` +
      `should it clear 20%, audited financial statements of the acquired business and pro forma ` +
      `information are due by amendment on ${amendment ? amendment.amendmentDueDate : "—"} ` +
      `(71 calendar days). Commission the target audit at signing — it cannot be produced inside ` +
      `71 days if it is started on day 60, which is how the Victorville Item 9.01 amendment came ` +
      `to be filed well past its window.`,
  };
}

function build(tier, fy, n) {
  if (tier === "monthly") return buildMonthly(fy, n);
  if (tier === "quarterly") return buildQuarterly(fy, n);
  if (tier === "annual") return buildAnnual(fy);
  if (tier === "s1") return buildS1BringDown(fy, n || "S-1/A");
  if (tier === "event") return buildEvent(fy, n);
  throw new Error(`Unknown tier "${tier}"`);
}

module.exports = {
  LEAD,
  SWEEP_QUESTIONS,
  build,
  buildMonthly,
  buildQuarterly,
  buildAnnual,
  buildS1BringDown,
  buildEvent,
  eventSlug,
  buildFiscalYearPlan,
  monthlyDueDate,
  backFrom,
};
