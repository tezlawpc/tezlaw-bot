// ============================================================
//  PCAOB AUDIT PORTAL — OPERATING EVENT CATALOG
//  audit-events.js
//  ─────────────────────────────────────────────────────────
//  WHAT THIS IS FOR
//
//  The rest of this portal asks "what happened?" at the close.
//  By then the four business days are gone. This file runs the
//  other direction: somebody at the company does an ordinary
//  thing — signs a lease, pays an advisor in stock, hires a
//  CFO — and the portal tells them, that day, what it started.
//
//  The gap is not laziness. A warehouse lease is TWO Form 8-K
//  events, each due four business days from SIGNATURE and not
//  from closing: Item 1.01, because Reg S-K 601(b)(10)(ii)(D)
//  deems "any material lease" to be outside the ordinary course
//  however ordinary leasing is for the business, and Item 2.03,
//  because the Form expressly enumerates an operating lease
//  obligation under ASC 842 as a direct financial obligation.
//  No operations lead knows that. No small company has anyone
//  whose job it is to know it.
//
//  THE PRODUCT CLAIM, AND ITS LIMIT
//  Exchange Act Rule 13a-15(e) defines disclosure controls and
//  procedures as controls "designed to ensure that information
//  required to be disclosed ... is accumulated and communicated
//  to the issuer's management ... as appropriate to allow timely
//  decisions regarding required disclosure." That is a
//  description of an information-routing system, which is what
//  this is. In the SEC's own settled orders against Blackbaud
//  and First American the violation WAS the missing upward
//  channel: operational staff knew, the certifying officers did
//  not, and there were no procedures designed to carry it.
//
//  So this is built as a control and not a reminder app, which
//  imposes real constraints, each honoured below:
//    - the record is append-only; nothing can be backdated
//    - "nothing to report" is captured affirmatively, because
//      silence is not evidence of completeness
//    - the knowledge timeline is separated: when it happened,
//      when the operator learned, when they reported, when the
//      decision-maker was notified, when it was determined
//    - the catalog is VERSIONED, so an issuer can show which
//      control was in force in a given period
//    - every event needs a recorded disposition, including the
//      "not reportable" ones, which otherwise leave no trace
//
//  AND THE HARD LIMIT: this file never decides materiality.
//  SAB 99 says exclusive reliance on a numerical threshold "has
//  no basis in the accounting literature or the law," and
//  Item 307 requires management's own conclusion. The software
//  computes dates, names the rule and demands an answer. A
//  human decides, on the record, and is named.
//
//  REGIME GATING — THE LARGEST FALSE-POSITIVE RISK
//  Three independent facts decide which obligations exist, and
//  they are NOT the same question:
//    1. listed on an exchange  → the Nasdaq/NYSE rulebook
//    2. registered under Section 12 → Section 16 and 13D/13G
//    3. reporting at all → Form 8-K
//  A Section 15(d)-only filer looks exactly like a reporting
//  company to an operator: it files 10-Ks, 10-Qs and 8-Ks. But
//  its insiders file no Forms 3, 4 or 5 and its 5% holders file
//  no Schedule 13D. Showing an OTC issuer a Nasdaq notice, or a
//  15(d) filer a Form 4 deadline, destroys trust in everything
//  else on the page.
//
//  EVERY day count here is marked verified or not. Verified
//  means it was read in the rule text or the Form itself, not
//  recalled. An unverified clock still generates its reminder,
//  labelled, because a prompt to go and check beats silence.
// ============================================================

const cal = require("./audit-calendar");
const playbooks = require("./audit-playbooks");

// Bumping this is how an issuer can later show which version of
// the control was operating in a given period. Every event report
// stores the version in force when it was taken.
const CATALOG_VERSION = "2026.10.1";

const D = playbooks.D;

// ── Anchors ─────────────────────────────────────────────────
//
// Which date a clock runs from. Getting this wrong is the single
// most common failure, and every published 8-K checklist omits
// it: they say what is reportable, never when the clock starts.
const ANCHORS = {
  signed: {
    label: "Date it was signed",
    help:
      "The date of signature, even if closing or funding comes later. Item 1.01 defines a material " +
      "definitive agreement as one providing material enforceable obligations or rights “whether or " +
      "not subject to conditions”, so a signed agreement waiting on a condition already counts.",
  },
  closed: {
    label: "Date it closed or funded",
    help: "Used only where there was no binding agreement beforehand.",
  },
  occurred: { label: "Date it happened", help: "The date of the event itself." },
  learned: {
    label: "Date someone here first knew",
    help:
      "The date any officer or employee first became aware. A few obligations run from knowledge " +
      "rather than from the event, and the SEC reconstructs this timeline in an investigation.",
  },
  notice: {
    label: "Date notice was given or received",
    help:
      "For a departure this is the date the person told the company, not their last day. A CFO who " +
      "says in March that she is leaving in June starts the clock in March.",
  },
  determined: {
    label: "Date the company determined it was material",
    help:
      "For a cybersecurity incident the clock runs from the determination, not the breach — but " +
      "Instruction 1 to Item 1.05 requires that determination to be made “without unreasonable " +
      "delay after discovery”, so the determination itself cannot be parked.",
  },
  declared: { label: "Date the board declared or approved it", help: "The board action date." },
  effective: { label: "Intended effective date", help: "When it takes effect in the market." },
};

// ── Form S-3 eligibility ────────────────────────────────────
//
// The consequence an operator could not possibly anticipate, and
// the one that converts: a late 8-K under an item OUTSIDE this
// list breaks Form S-3 eligibility for twelve months, which for a
// small issuer financing itself off a shelf or an ATM is a
// capital-markets shutdown caused by a four-day paperwork miss.
// Curing it late does not restore eligibility.
//
// The list is Form S-3 General Instruction I.A.3(b) as published
// by the SEC. NOTE: a secondary rendering of 17 CFR 239.13 gives
// a materially different list. The SEC-published Form controls,
// but this list should be re-read against the live Form and the
// current eCFR before anyone relies on it commercially, which is
// why the warning it drives is marked unverified.
const S3_SAFE_HARBOR_ITEMS = ["1.01", "1.02", "1.04", "1.05", "2.03", "2.04", "2.05", "2.06", "4.02(a)", "5.02(e)"];

function breaksS3IfLate(item) {
  if (!item) return false;
  return !S3_SAFE_HARBOR_ITEMS.includes(String(item));
}

// ── Regime ──────────────────────────────────────────────────

/**
 * The three independent flags, derived from the issuer profile.
 * Defaults are deliberately conservative in the direction that
 * SHOWS fewer obligations: an unconfigured profile is treated as
 * an unlisted, non-Section-12 reporting company, so the portal
 * under-promises rather than inventing Nasdaq duties.
 */
function regimeOf(profile) {
  const p = profile || {};
  let family = "none";
  try {
    const issuer = require("./audit-issuer");
    const ex = issuer.EXCHANGES[p.exchange];
    if (ex) family = ex.listed ? ex.family : "otc";
  } catch {
    /* fall through to none */
  }
  return {
    listed: family === "nasdaq" || family === "nyse",
    exchangeFamily: family,
    // Section 12 registration is its own fact and cannot be inferred
    // from being listed or from filing reports.
    section12: p.section12Registered === true,
    reporting: p.reportingCompany !== false,
    smallerReportingCompany: p.smallerReportingCompany !== false,
  };
}

function obligationApplies(ob, regime) {
  const req = ob.requires || {};
  if (req.listed && !regime.listed) return false;
  if (req.exchangeFamily && req.exchangeFamily !== regime.exchangeFamily) return false;
  if (req.section12 && !regime.section12) return false;
  if (req.reporting && !regime.reporting) return false;
  return true;
}

// ── Question types ──────────────────────────────────────────
const Q = {
  yesno: (id, prompt, help) => ({ id, type: "yesno", prompt, help: help || "" }),
  date: (id, prompt, help) => ({ id, type: "date", prompt, help: help || "" }),
  amount: (id, prompt, help) => ({ id, type: "amount", prompt, help: help || "" }),
  text: (id, prompt, help) => ({ id, type: "text", prompt, help: help || "" }),
};

const yes = (a, k) => a && (a[k] === true || a[k] === "yes" || a[k] === "true");

// ── The catalog ─────────────────────────────────────────────
//
// `label` is written the way an operator would say it out loud,
// not the way the rule says it. That is the whole point: a person
// who knew to search for "material definitive agreement" would
// not have needed this.

const EVENTS = {
  // ════════════════ CONTRACTS ════════════════
  contract_signed: {
    key: "contract_signed",
    group: "Contracts",
    label: "We signed a contract, or changed one we already had",
    aliases: ["agreement", "contract", "deal", "mou", "loi", "amendment", "signed", "supply", "distribution", "license"],
    headline:
      "Most contracts are nobody's business but yours. Four kinds are not, and the test is not how big the " +
      "contract is. Reg S-K 601(b)(10)(ii) pulls an agreement out of the ordinary course if an insider is a " +
      "party, if the business substantially depends on it, if it moves property worth more than 15% of fixed " +
      "assets, or if it is a material lease. Answer the four questions and the portal will tell you which.",
    anchors: ["signed"],
    questions: [
      Q.text("counterparty", "Who is it with?", "Just the name, so the file is findable later."),
      Q.yesno(
        "insider_party",
        "Is a director, officer, promoter or large shareholder a party to it, or do they have an interest in it?",
        "Includes a company they own or control. Buying and selling current assets at market price does not count."
      ),
      Q.yesno(
        "depends_on",
        "Would losing this contract seriously hurt the business?",
        "The rule's test is substantial dependence: a contract to sell the major part of your products, to buy " +
          "the major part of your requirements, or a licence, patent, formula or trade secret the business " +
          "depends on. For a company with one or two key customers or a single co-packer, this is usually yes."
      ),
      Q.yesno(
        "is_lease",
        "Is it a lease of property or equipment?",
        "Any material lease counts, however ordinary leasing is for your business."
      ),
      Q.yesno(
        "big_ppe",
        "Does it buy or sell property, plant or equipment worth more than 15% of the company's fixed assets?",
        "Consolidated fixed assets. An equipment purchase nobody thinks of as an SEC event can cross this."
      ),
      Q.yesno(
        "is_comp",
        "Is it an employment, pay, bonus, severance or consulting arrangement with an officer or director?",
        "If so this is NOT an Item 1.01 event. Compensatory and management arrangements are carved out and go " +
          "to Item 5.02(e) instead. Report it under “Someone joined or left” so you get the right clock."
      ),
    ],
    obligations: [
      {
        id: "CT-8K-101",
        kind: "filing",
        label: "File Form 8-K Item 1.01 — entry into a material definitive agreement",
        onlyIf: (a) =>
          !yes(a, "is_comp") && (yes(a, "insider_party") || yes(a, "depends_on") || yes(a, "is_lease") || yes(a, "big_ppe")),
        due: D.businessDaysAfter(4),
        anchor: "signed",
        item8k: "1.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 1.01", "Form 8-K Instruction 1 to Item 1.01", "Reg S-K 601(b)(10)(ii)", "Form 8-K Gen. Instr. B.1"],
        docCategory: "L-190",
        consequence:
          "Four business days from SIGNATURE, not from closing. There is no Rule 12b-25 extension for a " +
          "Form 8-K, so a late one is simply late, and a late filing is a Section 13(a) violation.",
        note:
          "The material terms have to be summarised in the body of the 8-K. Attaching the agreement or " +
          "incorporating it by reference is not enough.",
      },
      {
        id: "CT-EXH",
        kind: "document",
        label: "Add the agreement to the exhibit list for the next periodic report",
        onlyIf: (a) =>
          !yes(a, "is_comp") && (yes(a, "insider_party") || yes(a, "depends_on") || yes(a, "is_lease") || yes(a, "big_ppe")),
        due: D.none(),
        anchor: "signed",
        requires: { reporting: true },
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["Reg S-K 601(b)(10)"],
        docCategory: "D-040",
        consequence: "A material contract that belongs on the exhibit index and is not there is a staff comment waiting to happen.",
        note: "Immaterial commercially sensitive terms may be redacted, but the unredacted copy and the materiality analysis have to be available to the staff on request.",
      },
      {
        id: "CT-606",
        kind: "analysis",
        label: "Revenue analysis for the new contract (ASC 606 five steps)",
        onlyIf: (a) => !yes(a, "is_comp") && !yes(a, "is_lease"),
        due: D.none(),
        anchor: "signed",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 606-10-05-4", "ASC 606-10-32"],
        docCategory: "D-050",
        consequence:
          "No external deadline, but the facts get harder to reconstruct every week. Performance obligations, " +
          "variable consideration and any financing component are far easier to document now than in the audit.",
      },
      {
        id: "CT-SIDE",
        kind: "document",
        label: "Confirm there is no side letter, verbal understanding or concession outside the signed document",
        onlyIf: (a) => !yes(a, "is_comp"),
        due: D.none(),
        anchor: "signed",
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["ASC 606-10-25-1", "AS 2110.65"],
        docCategory: "D-040",
        consequence: "An unwritten concession changes the accounting and is the classic audit finding. Record it now or it surfaces as a misstatement later.",
      },
    ],
  },

  lease_signed: {
    key: "lease_signed",
    group: "Contracts",
    label: "We signed a lease — a building, a warehouse, vehicles or equipment",
    aliases: ["lease", "rent", "premises", "warehouse", "office", "equipment lease", "landlord"],
    headline:
      "This is the example the whole feature exists for. A material lease is usually TWO Form 8-K events, " +
      "both running four business days from signature: Item 1.01, because 601(b)(10)(ii)(D) deems any " +
      "material lease to be outside the ordinary course, and Item 2.03, because the Form enumerates an " +
      "operating lease obligation under ASC 842 as a direct financial obligation. Older checklists miss the " +
      "second one because they were written against a disclosure table the SEC has since deleted.",
    anchors: ["signed"],
    questions: [
      Q.text("what", "What is the lease for?", "A building, a warehouse, vehicles, equipment."),
      Q.yesno(
        "material",
        "Is this lease material to the company?",
        "A judgment, and it is yours to make, not the software's. Think about the total payments over the " +
          "term against the size of the business, and whether an investor would want to know."
      ),
      Q.date("commencement", "When do you get access to the asset?", "The ASC 842 commencement date, which is when the lessor makes the asset available. It is often later than signature, and it is the date the accounting starts."),
      Q.yesno("related_party", "Is the landlord or lessor a related party?", "An officer, director, shareholder, or an entity any of them control."),
      Q.yesno("short_term", "Is the term twelve months or less with no purchase option?", "If so a short-term election may be available and the accounting is much simpler."),
    ],
    obligations: [
      {
        id: "LS-8K-101",
        kind: "filing",
        label: "File Form 8-K Item 1.01 — the lease is a material definitive agreement",
        onlyIf: (a) => yes(a, "material"),
        due: D.businessDaysAfter(4),
        anchor: "signed",
        item8k: "1.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 1.01", "Reg S-K 601(b)(10)(ii)(D)", "Form 8-K Gen. Instr. B.1"],
        docCategory: "L-190",
        consequence: "Four business days from signature. Leasing premises is ordinary for almost every business, and the rule overrides that for a material lease.",
      },
      {
        id: "LS-8K-203",
        kind: "filing",
        label: "File Form 8-K Item 2.03 — the lease creates a direct financial obligation",
        onlyIf: (a) => yes(a, "material"),
        due: D.businessDaysAfter(4),
        anchor: "signed",
        item8k: "2.03",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 2.03(a)", "Form 8-K Instruction 1 to Item 2.03", "ASC 842"],
        docCategory: "L-190",
        consequence:
          "The Form enumerates BOTH operating and finance lease obligations under ASC 842. There is no numeric " +
          "threshold in Item 2.03 at all — the only gate is materiality. This can usually be combined with " +
          "the Item 1.01 disclosure in one filing.",
        note: "The clock runs from the enforceable agreement, conditional or not. If there is no binding agreement, it runs from closing instead.",
      },
      {
        id: "LS-842",
        kind: "analysis",
        label: "Lease accounting file: classification, discount rate, and the ROU asset and liability at commencement",
        due: D.none(),
        anchor: "signed",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 842-10-25-2", "ASC 842-20-30-1", "ASC 842-10-30-3"],
        docCategory: "F-060",
        consequence:
          "Measured at the commencement date, which is when you get access, not when you signed. The " +
          "incremental borrowing rate has to be supported with something, and reconstructing a rate as at a " +
          "date eight months ago is exactly the workpaper auditors reject.",
      },
      {
        id: "LS-REL",
        kind: "document",
        label: "Related-party lease: terms, approval and disclosure",
        onlyIf: (a) => yes(a, "related_party"),
        due: D.none(),
        anchor: "signed",
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["ASC 842-10-55-12", "ASC 850-10-50", "Reg S-K Item 404"],
        docCategory: "I-090",
        consequence:
          "A related-party lease is accounted for on its legally enforceable terms like any other, but it is " +
          "disclosed as a related-party transaction and it needs documented approval by someone disinterested.",
      },
    ],
  },

  agreement_ended: {
    key: "agreement_ended",
    group: "Contracts",
    label: "A contract was terminated, cancelled or walked away from",
    aliases: ["terminated", "cancelled", "ended", "walked away", "breach", "notice of termination"],
    headline:
      "Termination of a material agreement is its own Form 8-K item. The trap is that the clock starts when " +
      "notice is given under the agreement's terms, even while you are still trying to negotiate your way out " +
      "of it. Expiry at the end of its stated term is not a termination and is not reportable.",
    anchors: ["notice"],
    questions: [
      Q.text("which", "Which agreement?", ""),
      Q.yesno("was_material", "Was it a material agreement outside the ordinary course?", "The same test as when it was signed. If filing an Item 1.01 was required then, this is the other end of it."),
      Q.yesno("expired", "Did it simply reach the end of its term?", "Expiry on its own terms is not a termination and does not trigger the item."),
    ],
    obligations: [
      {
        id: "AE-8K-102",
        kind: "filing",
        label: "File Form 8-K Item 1.02 — termination of a material definitive agreement",
        onlyIf: (a) => yes(a, "was_material") && !yes(a, "expired"),
        due: D.businessDaysAfter(4),
        anchor: "notice",
        item8k: "1.02",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 1.02", "Form 8-K Gen. Instr. B.1"],
        docCategory: "L-190",
        consequence:
          "Once notice of termination has been given or received under the agreement's terms, the filing is " +
          "due even if both sides are still talking. Continuing negotiations do not pause the clock.",
      },
      {
        id: "AE-ACCT",
        kind: "analysis",
        label: "Accounting consequences of the termination",
        onlyIf: (a) => yes(a, "was_material"),
        due: D.none(),
        anchor: "notice",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 606-10-25-13", "ASC 420", "ASC 842-20-40"],
        docCategory: "D-050",
        consequence: "Termination penalties, unamortised costs, remaining performance obligations and any exit cost all change on this date.",
      },
    ],
  },

  // ════════════════ MONEY IN AND OUT ════════════════
  debt_incurred: {
    key: "debt_incurred",
    group: "Money",
    label: "We borrowed money, drew on a facility, or issued a note",
    aliases: ["loan", "note", "borrow", "credit facility", "line of credit", "debt", "financing", "promissory"],
    headline:
      "Long-term debt is a direct financial obligation and reportable on materiality alone, with no numeric " +
      "threshold. Short-term debt counts only if it arises outside the ordinary course, so a routine revolver " +
      "draw is out. The aggregation rule catches people: a series of individually immaterial draws under one " +
      "facility becomes reportable once they are material together.",
    anchors: ["signed", "closed"],
    questions: [
      Q.text("lender", "Who is the lender?", ""),
      Q.amount("amount", "How much?", ""),
      Q.yesno("long_term", "Is any of it due more than a year out?", "If yes it is long-term debt and the ordinary-course exception does not help."),
      Q.yesno("binding", "Is there a signed agreement?", "If yes the clock runs from signature. If no, it runs from closing or funding."),
      Q.yesno("covenants", "Does it have financial covenants or reporting requirements?", "Monthly statements, compliance certificates, borrowing-base certificates, minimum liquidity."),
      Q.yesno("insider_lender", "Is the lender an officer, director or shareholder?", ""),
      Q.yesno("convertible", "Can it convert into stock?", "A conversion feature changes the accounting substantially and may have to be separated out."),
    ],
    obligations: [
      {
        id: "DB-8K-203",
        kind: "filing",
        label: "File Form 8-K Item 2.03 — creation of a direct financial obligation",
        due: D.businessDaysAfter(4),
        anchor: "signed",
        item8k: "2.03",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 2.03(a)", "ASC 470-10-50-1", "Form 8-K Gen. Instr. B.1"],
        docCategory: "L-190",
        consequence: "Materiality is the only gate. Four business days from the enforceable agreement, or from closing if there was none.",
        note: "If this draws on a facility already disclosed, keep a running total: once previously immaterial draws are material in the aggregate, that is reportable too.",
      },
      {
        id: "DB-8K-101",
        kind: "filing",
        label: "Consider Form 8-K Item 1.01 as well — the loan agreement itself",
        onlyIf: (a) => yes(a, "insider_lender") || yes(a, "long_term"),
        due: D.businessDaysAfter(4),
        anchor: "signed",
        item8k: "1.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Form 8-K Item 1.01", "Reg S-K 601(b)(10)(ii)(A)"],
        docCategory: "L-190",
        consequence: "A loan from an insider is a contract with an insider, which 601(b)(10)(ii)(A) puts outside the ordinary course regardless of size.",
      },
      {
        id: "DB-DOCS",
        kind: "document",
        label: "File the note, the security agreement and any guarantee",
        due: D.businessDaysAfter(5),
        anchor: "signed",
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["ASC 470-10-50"],
        docCategory: "G-020",
        consequence: "The auditor reconciles the balance, the rate and the maturity to these. Collecting them now takes minutes.",
      },
      {
        id: "DB-COV",
        kind: "analysis",
        label: "Build the covenant and lender-reporting calendar",
        onlyIf: (a) => yes(a, "covenants"),
        due: D.calendarDaysAfter(14),
        anchor: "signed",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 470-10-45", "ASC 450-20"],
        docCategory: "G-030",
        consequence:
          "Lender deliverables are a real default risk in their own right. In one comparable filing the " +
          "specified defaults were pure delivery failures — monthly statements and compliance certificates " +
          "not delivered — after which the lender imposed escalating weekly reserves against availability.",
      },
      {
        id: "DB-CONV",
        kind: "analysis",
        label: "Conversion feature analysis, and whether it must be separated",
        onlyIf: (a) => yes(a, "convertible"),
        due: D.calendarDaysAfter(30),
        anchor: "signed",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 815-15-25-1", "ASC 815-40-15", "ASC 470-20"],
        docCategory: "G-050",
        consequence:
          "A conversion price set at a discount to a future market price is the single most common restatement " +
          "cause for companies this size. Decide it now, and check there are enough authorised shares to settle it.",
      },
    ],
  },

  equity_issued: {
    key: "equity_issued",
    group: "Money",
    label: "We issued stock, warrants or convertibles — or paid someone in shares",
    aliases: ["shares", "stock", "issued", "warrant", "convertible", "pipe", "placement", "consultant shares", "equity", "safe"],
    headline:
      "The most dangerous ordinary act on this list, because it has a PRE-ACT obligation. If the company is " +
      "listed, the Listing of Additional Shares notice is due fifteen calendar days BEFORE the shares go out, " +
      "and once they are issued that notice is already late and cannot be cured. A late Item 3.02 is worse " +
      "than it looks: it is outside the Form S-3 safe harbour, so it costs shelf eligibility for twelve months.",
    anchors: ["signed", "closed"],
    questions: [
      Q.text("to_whom", "Who is getting the securities?", "An investor, a consultant, a lender, an employee, a vendor."),
      Q.amount("shares", "How many shares, or how many underlie the warrants or notes?", ""),
      Q.yesno("registered", "Were they sold under an effective registration statement?", "If no, this is an unregistered sale and an exemption has to be identified."),
      Q.yesno("for_services", "Are they being issued for services rather than cash?", "Shares to a consultant, advisor, IR firm, landlord or vendor instead of a payment."),
      Q.yesno("over_threshold", "Do these, plus everything issued since the last 8-K or periodic report, come to 5% or more of the class outstanding?", "The de minimis threshold is 5% for a smaller reporting company and 1% otherwise. It is a RUNNING total since the later of the last Item 3.02 report or the last 10-Q or 10-K, not a per-deal test. The denominator is shares actually issued, not as-converted."),
      Q.yesno("over_ten_pct", "Could the issuance exceed 10% of shares or voting power outstanding before the deal?", "This is the Nasdaq notification threshold, and it is NOT the same as the 20% shareholder-approval test."),
      Q.yesno("below_market", "Is the price below the market price, and is this 20% or more of the company?", "If both, a shareholder vote may be required before you can issue, which takes a proxy and weeks."),
      Q.yesno("insider_recipient", "Is the recipient an officer, director or substantial shareholder?", ""),
      Q.yesno("equity_plan", "Is this under a new or materially amended equity compensation plan?", "Including a plan under which consultants can receive stock."),
    ],
    obligations: [
      {
        id: "EQ-LAS",
        kind: "notice",
        label: "Notify Nasdaq — Listing of Additional Shares, BEFORE the shares are issued",
        onlyIf: (a) => yes(a, "equity_plan") || yes(a, "over_ten_pct") || yes(a, "insider_recipient"),
        due: D.calendarDaysBefore(15),
        anchor: "closed",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        preAct: true,
        verified: true,
        authority: ["Nasdaq Rule 5250(e)(2)"],
        consequence:
          "Fifteen calendar days before issuance, and it cannot be cured afterwards. The rule expressly " +
          "covers plans under which CONSULTANTS may acquire stock, which is the version companies miss. " +
          "Nasdaq may issue a public reprimand letter or, in the alternative, a delisting determination.",
        note: "The four triggers are a new or materially amended equity compensation plan, a potential change of control, an issuance to acquire a company where an insider has a 5% interest, and an issuance potentially exceeding 10% of shares or voting power.",
      },
      {
        id: "EQ-5635",
        kind: "decision",
        label: "Check whether a shareholder vote is required before you can issue",
        onlyIf: (a) => yes(a, "below_market") || yes(a, "insider_recipient"),
        due: D.none(),
        anchor: "signed",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        preAct: true,
        verified: true,
        authority: ["Nasdaq Rule 5635(a)", "Nasdaq Rule 5635(b)", "Nasdaq Rule 5635(c)", "Nasdaq Rule 5635(d)"],
        consequence:
          "There is no day count here because the answer is a shareholder meeting: a proxy, possible SEC " +
          "review, and six to eleven weeks. An issuance made without a required vote may have to be " +
          "rescinded. Note the related-party prong triggers at 5%, not 20%.",
        note: "The Minimum Price is the lower of the official closing price immediately before signing the binding agreement, or the five-day average before signing. Signature fixes it, not closing.",
      },
      {
        id: "EQ-8K-302",
        kind: "filing",
        label: "File Form 8-K Item 3.02 — unregistered sale of equity securities",
        onlyIf: (a) => !yes(a, "registered") && yes(a, "over_threshold"),
        due: D.businessDaysAfter(4),
        anchor: "signed",
        item8k: "3.02",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 3.02(a)", "Form 8-K Item 3.02(b)", "Reg S-K Item 701"],
        docCategory: "L-190",
        consequence:
          "Item 3.02 is OUTSIDE the Form S-3 safe harbour, so filing late costs Form S-3 eligibility for " +
          "twelve months and curing it late does not restore it. If the company finances itself off a shelf " +
          "or an ATM, a four-day miss here shuts that down for a year. This is the exact item a group of " +
          "micro-cap issuers were penalised for missing in a 2014 SEC sweep, with no fraud charged.",
      },
      {
        id: "EQ-FORMD",
        kind: "filing",
        label: "File Form D",
        onlyIf: (a) => !yes(a, "registered"),
        due: D.calendarDaysAfter(15),
        anchor: "closed",
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Rule 503", "17 CFR 230.503"],
        consequence:
          "Fifteen calendar days after the FIRST sale, which is the date the first investor became " +
          "irrevocably committed — usually when the company countersigned, not when the money arrived " +
          "and not at the final closing of a rolling round. A late Form D does not by itself break the " +
          "exemption, but it breaks the state blue-sky notices that are keyed to it and it is the first " +
          "thing a diligence reviewer checks.",
        note: "The “first sale” definition comes from the Form D instructions rather than Rule 503 itself, and was not verified against the instructions. Confirm before relying on a computed date.",
      },
      {
        id: "EQ-EXEMPT",
        kind: "document",
        label: "Record which exemption you relied on, and the file that supports it",
        onlyIf: (a) => !yes(a, "registered"),
        due: D.calendarDaysAfter(15),
        anchor: "closed",
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Securities Act § 5", "Securities Act § 12(a)(1)", "Rule 506", "Rule 152"],
        docCategory: "H-070",
        consequence:
          "If the exemption fails, Section 12(a)(1) gives every purchaser a rescission right, which is an " +
          "unrecorded liability and a going-concern problem. Keep the accredited-investor verification, the " +
          "subscription documents and the integration analysis together.",
      },
      {
        id: "EQ-718",
        kind: "analysis",
        label: "Measure the share-based payment for services",
        onlyIf: (a) => yes(a, "for_services"),
        due: D.calendarDaysAfter(30),
        anchor: "closed",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 718-10-30-6", "ASC 718-10-25-2C", "ASC 606-10-32-21"],
        docCategory: "H-050",
        consequence: "Shares to a non-employee need their own grant-date and measurement-date determination, and if the recipient is a customer the consideration runs through revenue instead.",
      },
      {
        id: "EQ-CAP",
        kind: "document",
        label: "Update the cap table and confirm enough authorised shares remain",
        due: D.calendarDaysAfter(10),
        anchor: "closed",
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["ASC 815-40-25-1", "ASC 815-40-25-19"],
        docCategory: "H-010",
        consequence:
          "Count what is still needed to settle every convertible, warrant and preferred at today's price. " +
          "Running short is both an equity-classification failure and, under most note documents, an event of default.",
      },
    ],
  },

  default_or_demand: {
    key: "default_or_demand",
    group: "Money",
    label: "We missed a payment, broke a covenant, or got a default or demand notice",
    aliases: ["default", "covenant", "breach", "demand", "acceleration", "forbearance", "waiver"],
    headline:
      "An acceleration or an increase in an obligation is its own Form 8-K item, and the consequences run " +
      "further than the filing: debt may have to be reclassified as current, which can turn a balance sheet " +
      "and a going-concern conclusion around.",
    anchors: ["occurred", "learned"],
    questions: [
      Q.text("which", "Which obligation, and what happened?", ""),
      Q.yesno("accelerated", "Has the lender accelerated, increased the obligation, or imposed new conditions or reserves?", ""),
      Q.yesno("waived", "Has a waiver or forbearance been agreed?", ""),
      Q.yesno("delivery_only", "Was the failure a reporting or delivery failure rather than a financial covenant?", "Late monthly statements or compliance certificates are defaults under many facilities."),
    ],
    obligations: [
      {
        id: "DF-8K-204",
        kind: "filing",
        label: "File Form 8-K Item 2.04 — triggering event accelerating or increasing an obligation",
        onlyIf: (a) => yes(a, "accelerated"),
        due: D.businessDaysAfter(4),
        anchor: "occurred",
        item8k: "2.04",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 2.04", "Form 8-K Gen. Instr. B.1"],
        docCategory: "L-190",
        consequence: "Four business days.",
      },
      {
        id: "DF-CLASS",
        kind: "analysis",
        label: "Reclassification analysis — is the debt now current?",
        due: D.calendarDaysAfter(10),
        anchor: "occurred",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 470-10-45-1", "ASC 470-10-45-11", "ASC 205-40"],
        docCategory: "G-030",
        consequence: "A callable obligation is a current liability, which flows straight into working capital and the going-concern assessment.",
      },
      {
        id: "DF-FORB",
        kind: "document",
        label: "File the waiver or forbearance agreement, and test it for modification accounting",
        onlyIf: (a) => yes(a, "waived"),
        due: D.calendarDaysAfter(10),
        anchor: "occurred",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 470-50-40-10", "ASC 470-60"],
        docCategory: "G-020",
        consequence:
          "Every amendment needs its own modification-versus-extinguishment conclusion. Where the lender " +
          "granted the concession because of financial difficulty, it is a troubled-debt restructuring instead.",
      },
    ],
  },

  // ════════════════ PEOPLE ════════════════
  officer_change: {
    key: "officer_change",
    group: "People",
    label: "Someone joined, left, or changed role as an officer or director",
    aliases: ["resigned", "hired", "quit", "appointed", "cfo", "ceo", "director", "board", "terminated", "retired"],
    headline:
      "The most-missed clock in the whole Form. For a departure, the four business days run from the moment " +
      "the person TELLS you, not from their last day, and that holds even if the notice was oral and even if " +
      "it was conditional. A CFO who says in March that she is leaving in June starts the clock in March. " +
      "If the company is listed and the departure breaks a committee, there is also an immediate notice to " +
      "the exchange, and the cure period depends on having given it.",
    anchors: ["notice"],
    questions: [
      Q.text("who", "Who, and what role?", ""),
      Q.yesno("departing", "Are they leaving?", ""),
      Q.yesno("joining", "Are they joining or being appointed?", ""),
      Q.yesno(
        "senior",
        "Is the role CEO, president, CFO, chief accounting officer, chief operating officer, a named executive officer, or a director?",
        "Item 5.02 reaches these roles. A departure further down the organisation is generally not reportable."
      ),
      Q.yesno("disagreement", "Is a director leaving because of a disagreement with the company?", "This changes what has to be disclosed and adds a two-business-day amendment if they send a letter."),
      Q.yesno("comp_arrangement", "Was any pay, bonus, severance, retention or equity arrangement agreed or changed?", "Written or unwritten. A handshake counts."),
      Q.yesno("breaks_committee", "Does this leave the board without a majority of independent directors, or a committee short of members?", "An audit committee needs three members, a compensation committee two."),
    ],
    obligations: [
      {
        id: "OC-8K-502B",
        kind: "filing",
        label: "File Form 8-K Item 5.02(b) — departure",
        onlyIf: (a) => yes(a, "departing") && yes(a, "senior") && !yes(a, "disagreement"),
        due: D.businessDaysAfter(4),
        anchor: "notice",
        item8k: "5.02(b)",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 5.02(b)", "Form 8-K Gen. Instr. B.1"],
        docCategory: "L-190",
        consequence:
          "Four business days from NOTICE OF THE DECISION, not from the effective date. Oral notice counts. " +
          "Conditional notice counts. Item 5.02(b) is outside the Form S-3 safe harbour, so a late one also " +
          "costs shelf eligibility for twelve months.",
        note: "Stripping someone of a position while keeping them employed is a reportable termination of that position.",
      },
      {
        id: "OC-8K-502A",
        kind: "filing",
        label: "File Form 8-K Item 5.02(a) — director departing over a disagreement",
        onlyIf: (a) => yes(a, "disagreement"),
        due: D.businessDaysAfter(4),
        anchor: "notice",
        item8k: "5.02(a)",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 5.02(a)"],
        docCategory: "L-190",
        consequence: "Requires a description of the disagreement. The director must be given a copy of the disclosure no later than the day it is filed.",
        note: "If the director sends a letter in response, it has to be filed as an exhibit by amendment within two business days of receipt.",
      },
      {
        id: "OC-8K-502C",
        kind: "filing",
        label: "File Form 8-K Item 5.02(c) or (d) — appointment",
        onlyIf: (a) => yes(a, "joining") && yes(a, "senior"),
        due: D.businessDaysAfter(4),
        anchor: "notice",
        item8k: "5.02(c)",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 5.02(c)", "Form 8-K Item 5.02(d)", "Reg S-K Item 401", "Reg S-K Item 404(a)"],
        docCategory: "L-190",
        consequence:
          "Four business days, but if you intend to announce the appointment some other way you may delay " +
          "the filing until the day you announce it. Needs biography, any selection arrangement, and " +
          "related-party information.",
      },
      {
        id: "OC-8K-502E",
        kind: "filing",
        label: "File Form 8-K Item 5.02(e) — compensatory arrangement",
        onlyIf: (a) => yes(a, "comp_arrangement"),
        due: D.businessDaysAfter(4),
        anchor: "notice",
        item8k: "5.02(e)",
        requires: { reporting: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Form 8-K Item 5.02(e)"],
        docCategory: "L-190",
        consequence:
          "Unwritten arrangements count. Note there is NO public-announcement delay for a standalone 5.02(e), " +
          "unlike an appointment. Grants materially consistent with a previously disclosed plan are excused.",
      },
      {
        id: "OC-NASDAQ-CURE",
        kind: "notice",
        label: "Notify Nasdaq IMMEDIATELY — the cure period depends on it",
        onlyIf: (a) => yes(a, "breaks_committee"),
        due: D.sameDay(),
        anchor: "notice",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        preAct: false,
        verified: true,
        authority: ["Nasdaq Rule 5605(b)(1)(A)", "Nasdaq Rule 5605(c)(4)", "Nasdaq Rule 5625"],
        consequence:
          "The rule gives a cure period running to the earlier of the next annual meeting or one year, but " +
          "only to a company that gave notice immediately on learning of the event. Running a short committee " +
          "quietly for eleven months and fixing it at the annual meeting does not use the cure period — " +
          "it never qualified for it.",
      },
      {
        id: "OC-FORM3",
        kind: "filing",
        label: "The new officer or director files a Form 3",
        onlyIf: (a) => yes(a, "joining") && yes(a, "senior"),
        due: D.calendarDaysAfter(10),
        anchor: "notice",
        requires: { section12: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Exchange Act § 16(a)(2)", "Rule 16a-3"],
        consequence:
          "The duty is the INDIVIDUAL's, not the company's, but the company gets named in the proxy under " +
          "Item 405 for their delinquency and the SEC has penalised companies for contributing to these " +
          "failures. Get a power of attorney and EDGAR codes on day one.",
        note: "Applies only where the class is registered under Section 12. A Section 15(d)-only filer's insiders file nothing.",
      },
      {
        id: "OC-COMP-ACCT",
        kind: "analysis",
        label: "Accounting for the new or changed arrangement",
        onlyIf: (a) => yes(a, "comp_arrangement"),
        due: D.calendarDaysAfter(30),
        anchor: "notice",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 718-20-35-3", "ASC 710-10-25", "ASC 712"],
        docCategory: "I-030",
        consequence: "Severance, accelerated vesting and award modifications all have to be measured, and a modification is measured at the modification date.",
      },
    ],
  },

  // ════════════════ TECHNOLOGY ════════════════
  cyber_incident: {
    key: "cyber_incident",
    group: "Technology",
    label: "We had a security breach, ransomware, or found unauthorised access",
    aliases: ["breach", "hack", "ransomware", "cyber", "incident", "data loss", "phishing", "intrusion"],
    headline:
      "The clock does not run from the breach. It runs from the day the company DETERMINES the incident is " +
      "material — but Instruction 1 requires that determination to be made without unreasonable delay " +
      "after discovery, so the determination cannot be parked to buy time. Note what the SEC actually " +
      "charged in Blackbaud and First American: not the breach, and not fraud, but the absence of a process " +
      "for what technical staff knew to reach the people who decide what to disclose.",
    anchors: ["learned", "determined"],
    questions: [
      Q.text("what", "What happened, in your own words?", "Plain description. Do not include system detail that would help an attacker."),
      Q.date("discovered", "When was it discovered?", "The determination clock starts running from here."),
      Q.yesno("data_taken", "Was any data accessed or taken?", "Customer, employee, financial or payment data."),
      Q.yesno("ops_affected", "Did it affect operations, or is it likely to?", ""),
      Q.yesno("determined_material", "Has the company formally determined whether it is material?", "If not, that determination is itself the next obligation and it is dated."),
    ],
    obligations: [
      {
        id: "CY-DETERMINE",
        kind: "decision",
        label: "Make and date the materiality determination",
        onlyIf: (a) => !yes(a, "determined_material"),
        due: D.businessDaysAfter(5),
        anchor: "learned",
        owner: "cfo",
        severity: "critical",
        verified: false,
        authority: ["Form 8-K Instruction 1 to Item 1.05", "SAB 99"],
        consequence:
          "The rule says “without unreasonable delay after discovery” and gives no day count, so the " +
          "date here is the portal's own prompt and not a legal deadline. Deferring the determination to " +
          "delay the filing is precisely what the instruction forbids. Record who decided, when, and why, " +
          "including if the answer is no — a decision not to file leaves no other trace.",
        note: "Address the SAB 99 qualitative factors explicitly. A conclusion resting only on a percentage has, in the staff's words, no basis in the accounting literature or the law.",
      },
      {
        id: "CY-8K-105",
        kind: "filing",
        label: "File Form 8-K Item 1.05 — material cybersecurity incident",
        onlyIf: (a) => yes(a, "determined_material"),
        due: D.businessDaysAfter(4),
        anchor: "determined",
        item8k: "1.05",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 1.05(a)", "Form 8-K Gen. Instr. B.1", "Release 33-11216"],
        docCategory: "L-190",
        consequence:
          "Four business days from the determination. Describe the nature, scope and timing and the material " +
          "impact or reasonably likely impact. You need not disclose technical detail that would impede " +
          "your own response.",
        note: "If information is unavailable, say so and amend within four business days of obtaining it. Every registrant including smaller reporting companies has been subject to Item 1.05 since June 15, 2024.",
      },
      {
        id: "CY-FILE",
        kind: "document",
        label: "Incident file: timeline, who knew when, and the response record",
        due: D.calendarDaysAfter(14),
        anchor: "learned",
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Reg S-K Item 106", "Rule 13a-15(e)"],
        docCategory: "K-060",
        consequence:
          "The dated knowledge timeline is what an investigation reconstructs. Record when each person " +
          "learned each fact and from whom, because that sequence is what the SEC's disclosure-controls " +
          "theory of liability turns on.",
      },
    ],
  },

  // ════════════════ REGULATORY ════════════════
  exchange_or_regulator_letter: {
    key: "exchange_or_regulator_letter",
    group: "Regulatory",
    label: "We received a letter from the exchange, the SEC, or another regulator",
    aliases: ["notice", "deficiency", "nasdaq letter", "sec comment", "finra", "delisting", "non-compliance"],
    headline:
      "A deficiency notice from the exchange triggers two separate obligations with the same four-business-day " +
      "clock, and for a late-filing deficiency a press release is mandatory — a Form 8-K alone is not " +
      "enough. Missing the announcement layers a second violation on top of the first.",
    anchors: ["occurred"],
    questions: [
      Q.text("from_whom", "Who sent it?", "Nasdaq, NYSE American, the SEC, FINRA, OTC Markets, a state regulator."),
      Q.yesno("is_deficiency", "Does it say the company is not in compliance with something?", ""),
      Q.yesno("filing_related", "Is it about a late or missing periodic report?", ""),
      Q.date("received", "When was it received?", "The clock runs from receipt."),
      Q.yesno("response_due", "Does it set a date for a response or a compliance plan?", ""),
    ],
    obligations: [
      {
        id: "XL-8K-301",
        kind: "filing",
        label: "File Form 8-K Item 3.01 — notice of failure to satisfy a listing rule",
        onlyIf: (a) => yes(a, "is_deficiency"),
        due: D.businessDaysAfter(4),
        anchor: "occurred",
        item8k: "3.01",
        requires: { reporting: true, listed: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 3.01", "Form 8-K Gen. Instr. B.1"],
        docCategory: "L-190",
        consequence: "Four business days from receipt. Item 3.01 is outside the Form S-3 safe harbour.",
      },
      {
        id: "XL-PRESS",
        kind: "notice",
        label: "Issue the public announcement of the deficiency",
        onlyIf: (a) => yes(a, "is_deficiency"),
        due: D.businessDaysAfter(4),
        anchor: "occurred",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Nasdaq Rule 5250(b)(2)", "Nasdaq Rule 5810(b)"],
        consequence:
          "Four business days from receipt, naming each specific rule the deficiency rests on. For a " +
          "periodic-filing deficiency a PRESS RELEASE is mandatory and an 8-K does not satisfy it.",
      },
      {
        id: "XL-PLAN",
        kind: "document",
        label: "Track the cure clock: plan, extension, hearing request, decision",
        onlyIf: (a) => yes(a, "is_deficiency") || yes(a, "response_due"),
        due: D.none(),
        anchor: "occurred",
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Nasdaq Rule 5810(c)", "Nasdaq Rule 5250(c)(1)"],
        docCategory: "K-050",
        consequence:
          "Every date in the letter is a hard date. One comparable issuer had three days to request a " +
          "hearing against a trading suspension, with no compliance period available at all because its " +
          "cumulative reverse splits had crossed a threshold it did not know existed.",
      },
      {
        id: "XL-FILE",
        kind: "document",
        label: "File the letter itself",
        due: D.businessDaysAfter(2),
        anchor: "occurred",
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["AS 2110", "AS 2405"],
        docCategory: "K-050",
        consequence: "The auditor asks for all regulatory correspondence. Filing it on receipt means never reconstructing the sequence later.",
      },
    ],
  },

  legal_claim: {
    key: "legal_claim",
    group: "Regulatory",
    label: "We got a demand letter, were sued, or received a subpoena",
    aliases: ["lawsuit", "demand letter", "claim", "subpoena", "litigation", "sued", "arbitration", "wells notice"],
    headline:
      "No automatic filing clock, but the accounting assessment is dated and the auditor's legal letter " +
      "process depends on management having a complete list, including claims nobody has asserted yet.",
    anchors: ["occurred"],
    questions: [
      Q.text("matter", "What is it about, and who is the other side?", ""),
      Q.yesno("regulator", "Is it from a regulator or law enforcement?", "An SEC subpoena, a Wells notice, a state attorney general."),
      Q.yesno("material_amount", "Is the amount claimed, or the exposure, material to the company?", ""),
      Q.yesno("counsel_engaged", "Is outside counsel handling it?", ""),
    ],
    obligations: [
      {
        id: "LC-450",
        kind: "analysis",
        label: "Management's loss contingency evaluation",
        due: D.calendarDaysAfter(21),
        anchor: "occurred",
        owner: "general_counsel",
        severity: "high",
        verified: true,
        authority: ["ASC 450-20-25-2", "ASC 450-20-50", "AS 2505"],
        docCategory: "K-010",
        consequence:
          "Probable and estimable means accrue; reasonably possible means disclose. The evaluation has to " +
          "include UNASSERTED claims that are probable of assertion, which is the part companies leave out " +
          "and the auditor specifically asks about.",
      },
      {
        id: "LC-8K-801",
        kind: "decision",
        label: "Decide whether this needs disclosure now rather than at the next report",
        onlyIf: (a) => yes(a, "material_amount") || yes(a, "regulator"),
        due: D.businessDaysAfter(4),
        anchor: "occurred",
        item8k: "8.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Form 8-K Item 8.01", "Reg S-K Item 103"],
        docCategory: "L-190",
        consequence:
          "Item 8.01 is voluntary and has no deadline, so this is a decision rather than a filing. Record " +
          "the decision either way. One comparable issuer's four consecutive years of unreliable financial " +
          "statements began with an SEC complaint.",
      },
      {
        id: "LC-DOCS",
        kind: "document",
        label: "File the demand, complaint or subpoena",
        due: D.businessDaysAfter(3),
        anchor: "occurred",
        owner: "general_counsel",
        severity: "normal",
        verified: true,
        authority: ["AS 2505.09"],
        docCategory: "K-030",
        consequence: "Feeds the audit inquiry letter to counsel. A matter counsel never heard about is the classic incomplete legal letter.",
      },
    ],
  },

  // ════════════════ OPERATIONS ════════════════
  product_launch: {
    key: "product_launch",
    group: "Operations",
    label: "We launched a new product, service or line of business",
    aliases: ["launch", "new product", "new service", "sku", "release", "rollout", "new line"],
    headline:
      "Rarely a filing. Almost always an accounting change nobody documents until the audit: a new " +
      "performance obligation, a warranty, a return right, a new cost build-up. Cheap now, expensive in June.",
    anchors: ["occurred"],
    questions: [
      Q.text("what", "What did you launch?", ""),
      Q.yesno("new_terms", "Does it have different customer terms from your existing products?", "Different return rights, warranty, bundling, subscription or service component."),
      Q.yesno("warranty", "Does it come with a warranty or guarantee?", ""),
      Q.yesno("returns", "Can customers return it, or get a refund?", ""),
      Q.yesno("subscription", "Is any part of it sold over time rather than delivered at once?", "A subscription, a service plan, installation, or anything with a hosting component."),
      Q.yesno("new_supplier", "Did it require a new supplier, co-packer or manufacturer?", ""),
    ],
    obligations: [
      {
        id: "PL-606",
        kind: "analysis",
        label: "ASC 606 analysis for the new revenue stream",
        due: D.calendarDaysAfter(30),
        anchor: "occurred",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 606-10-05-4", "ASC 606-10-25-19", "ASC 606-10-32-31"],
        docCategory: "D-050",
        consequence:
          "Identify the performance obligations, decide whether they are satisfied over time or at a point " +
          "in time, and set the standalone selling prices if the product is bundled. This also usually adds " +
          "a new disaggregation category to the revenue footnote.",
      },
      {
        id: "PL-WARRANTY",
        kind: "analysis",
        label: "Warranty analysis — assurance or service type?",
        onlyIf: (a) => yes(a, "warranty"),
        due: D.calendarDaysAfter(30),
        anchor: "occurred",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 606-10-55-30", "ASC 460-10-25-5"],
        docCategory: "J-030",
        consequence: "An assurance warranty is a cost accrual. A service-type warranty is a separate performance obligation with revenue deferred against it. The two produce very different financial statements.",
      },
      {
        id: "PL-RETURNS",
        kind: "analysis",
        label: "Returns and refund liability estimate",
        onlyIf: (a) => yes(a, "returns"),
        due: D.calendarDaysAfter(30),
        anchor: "occurred",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 606-10-32-10", "ASC 606-10-55-22"],
        docCategory: "D-070",
        consequence: "A right of return is variable consideration, so revenue is constrained from the start. With no history for a new product, the basis for the estimate is the whole question.",
      },
      {
        id: "PL-COST",
        kind: "document",
        label: "Standard cost build-up for the new product",
        due: D.calendarDaysAfter(45),
        anchor: "occurred",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 330-10-30", "ASC 705-20"],
        docCategory: "E-040",
        consequence: "Inventory valuation and margin analysis both rest on this, and a new SKU has no history to fall back on.",
      },
      {
        id: "PL-SUPPLY",
        kind: "decision",
        label: "Check whether the new supply arrangement is itself reportable",
        onlyIf: (a) => yes(a, "new_supplier"),
        due: D.businessDaysAfter(4),
        anchor: "occurred",
        item8k: "1.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Form 8-K Item 1.01", "Reg S-K 601(b)(10)(ii)(B)"],
        docCategory: "L-190",
        consequence:
          "If the business is substantially dependent on the new supplier — a sole source, or the major " +
          "part of your requirements — that agreement is outside the ordinary course and reportable, " +
          "whatever its size. Report it under “We signed a contract” to get the full question set.",
      },
    ],
  },

  customer_or_supplier_loss: {
    key: "customer_or_supplier_loss",
    group: "Operations",
    label: "We lost a major customer or supplier, or one gave notice",
    aliases: ["lost customer", "supplier", "co-packer", "plant closure", "discontinued", "terminated supply", "allocation"],
    headline:
      "Usually not a filing on its own, but it is an impairment triggering event, a going-concern input and " +
      "an inventory-valuation question at the same time. One comparable issuer learned its primary co-packer, " +
      "around 80% of sales, would close its plant within six months.",
    anchors: ["learned"],
    questions: [
      Q.text("who", "Who, and what happened?", ""),
      Q.yesno("is_customer", "Was it a customer?", ""),
      Q.yesno("concentration", "Did they account for 10% or more of revenue or purchases?", ""),
      Q.yesno("alternate", "Is there a qualified alternative already in place?", ""),
      Q.yesno("contract_terminated", "Was a written contract terminated?", ""),
    ],
    obligations: [
      {
        id: "CL-IMPAIR",
        kind: "analysis",
        label: "Impairment triggering event assessment",
        due: D.calendarDaysAfter(21),
        anchor: "learned",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 360-10-35-21", "ASC 350-20-35-3C", "ASC 330-10-35-1"],
        docCategory: "J-040",
        consequence: "Long-lived assets, intangibles and inventory all have to be reconsidered, in that order, and the assessment is dated.",
      },
      {
        id: "CL-GC",
        kind: "analysis",
        label: "Update the going-concern and liquidity assessment",
        onlyIf: (a) => yes(a, "concentration"),
        due: D.calendarDaysAfter(21),
        anchor: "learned",
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["ASC 205-40-50-1"],
        docCategory: "J-010",
        consequence: "Losing a tenth of the business changes the cash runway, and the ASC 205-40 evaluation looks a year out from the issuance date.",
      },
      {
        id: "CL-CONC",
        kind: "document",
        label: "Update the concentration and vulnerability disclosure",
        onlyIf: (a) => yes(a, "concentration"),
        due: D.calendarDaysAfter(30),
        anchor: "learned",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["ASC 275-10-50-16", "ASC 275-10-50-20"],
        docCategory: "D-030",
        consequence: "A single-source dependence with no qualified alternative is the ASC 275 severe-impact disclosure.",
      },
      {
        id: "CL-8K",
        kind: "decision",
        label: "Decide whether this needs disclosing now",
        onlyIf: (a) => yes(a, "concentration"),
        due: D.businessDaysAfter(4),
        anchor: "learned",
        item8k: "8.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["Form 8-K Item 8.01", "Form 8-K Item 1.02"],
        docCategory: "L-190",
        consequence: "If a material written contract was terminated, Item 1.02 is mandatory rather than optional. Otherwise this is a judgment, and the judgment should be recorded.",
      },
    ],
  },

  asset_deal: {
    key: "asset_deal",
    group: "Operations",
    label: "We bought or sold a business, or significant assets",
    aliases: ["acquisition", "acquire", "merger", "bought", "sold", "disposition", "asset purchase", "loi"],
    headline:
      "Signature and closing are different events with different items, and the financial statements of an " +
      "acquired business are due by amendment 71 calendar days after the initial 8-K was due. A target audit " +
      "cannot be produced in 71 days if it is commissioned on day 60. Commission it at signing.",
    anchors: ["signed", "closed"],
    questions: [
      Q.text("target", "What is being bought or sold?", ""),
      Q.yesno("signed_yet", "Has a definitive agreement been signed?", ""),
      Q.yesno("closed_yet", "Has it closed?", ""),
      Q.yesno("is_business", "Is it a business, rather than just a collection of assets?", "A business has inputs and a substantive process that together produce outputs. The answer changes the accounting entirely — no goodwill on an asset acquisition."),
      Q.yesno("significant", "Is it significant relative to the company's size?", "The Rule 3-05 or 8-04 significance test uses asset, investment and income tests. If it clears 20%, audited financial statements of the target are required."),
      Q.yesno("stock_consideration", "Is any of the price being paid in stock?", ""),
    ],
    obligations: [
      {
        id: "AD-8K-101",
        kind: "filing",
        label: "File Form 8-K Item 1.01 — the acquisition agreement",
        onlyIf: (a) => yes(a, "signed_yet"),
        due: D.businessDaysAfter(4),
        anchor: "signed",
        item8k: "1.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 1.01"],
        docCategory: "L-190",
        consequence: "Four business days from signature, whether or not it has closed and whether or not it is conditional.",
      },
      {
        id: "AD-8K-201",
        kind: "filing",
        label: "File Form 8-K Item 2.01 — completion of the acquisition or disposition",
        onlyIf: (a) => yes(a, "closed_yet"),
        due: D.businessDaysAfter(4),
        anchor: "closed",
        item8k: "2.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 2.01"],
        docCategory: "L-190",
        consequence: "A separate filing from the signing one. Item 2.01 is outside the Form S-3 safe harbour, so a late one costs shelf eligibility for twelve months.",
      },
      {
        id: "AD-SIG",
        kind: "analysis",
        label: "Run the significance test NOW, not at quarter end",
        onlyIf: (a) => yes(a, "signed_yet") && yes(a, "is_business"),
        due: D.businessDaysAfter(10),
        anchor: "signed",
        owner: "controller",
        severity: "critical",
        verified: true,
        authority: ["Reg S-X 3-05", "Reg S-X 8-04", "Reg S-X 1-02(w)"],
        docCategory: "M-020",
        consequence:
          "This single computation decides whether you need an audit of the target. Running it at quarter " +
          "end instead of at signing is how companies end up needing audited financial statements they " +
          "cannot obtain inside the window.",
      },
      {
        id: "AD-FS",
        kind: "filing",
        label: "File the acquired business financial statements and pro formas by amendment",
        onlyIf: (a) => yes(a, "closed_yet") && yes(a, "is_business") && yes(a, "significant"),
        due: D.calendarDaysAfter(71),
        anchor: "closed",
        item8k: "9.01",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 9.01(a)(3)", "Reg S-X 3-05", "Reg S-X Article 11"],
        docCategory: "M-030",
        consequence:
          "Seventy-one calendar days after the date the initial 8-K was due — not 71 days after closing. " +
          "Commission the target audit at signing; it cannot be produced from a standing start in ten weeks.",
      },
      {
        id: "AD-SCREEN",
        kind: "analysis",
        label: "Asset acquisition or business combination? Run the screen",
        onlyIf: (a) => yes(a, "signed_yet"),
        due: D.calendarDaysAfter(30),
        anchor: "signed",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 805-10-55-5A", "ASC 805-50-30-1"],
        docCategory: "M-050",
        consequence:
          "If substantially all of the fair value is in a single identifiable asset, it is not a business. " +
          "That means no goodwill, relative-fair-value allocation and capitalised transaction costs — " +
          "a completely different answer, and the threshold question nobody documents.",
      },
    ],
  },

  exit_or_impairment: {
    key: "exit_or_impairment",
    group: "Operations",
    label: "We decided to shut something down, or write something off",
    aliases: ["impairment", "write-off", "write down", "exit", "restructuring", "discontinue", "shut down", "layoff"],
    headline:
      "Both of these items run from a DECISION rather than from a payment or a journal entry. The day the " +
      "board or management commits is the day the clock starts.",
    anchors: ["declared"],
    questions: [
      Q.text("what", "What is being shut down or written off?", ""),
      Q.yesno("committed", "Has management or the board actually committed to the plan?", "A commitment, not a discussion. This is the date the clock runs from."),
      Q.yesno("is_impairment", "Is this a write-down of an asset, goodwill or inventory?", ""),
      Q.yesno("is_exit", "Does it involve severance, contract termination costs or closing a facility?", ""),
      Q.yesno("material", "Is the charge material?", ""),
    ],
    obligations: [
      {
        id: "EI-8K-205",
        kind: "filing",
        label: "File Form 8-K Item 2.05 — costs associated with exit or disposal activities",
        onlyIf: (a) => yes(a, "is_exit") && yes(a, "committed") && yes(a, "material"),
        due: D.businessDaysAfter(4),
        anchor: "declared",
        item8k: "2.05",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 2.05", "ASC 420"],
        docCategory: "L-190",
        consequence: "Four business days from the commitment to the plan.",
      },
      {
        id: "EI-8K-206",
        kind: "filing",
        label: "File Form 8-K Item 2.06 — material impairment",
        onlyIf: (a) => yes(a, "is_impairment") && yes(a, "material"),
        due: D.businessDaysAfter(4),
        anchor: "declared",
        item8k: "2.06",
        requires: { reporting: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Form 8-K Item 2.06", "ASC 350", "ASC 360"],
        docCategory: "L-190",
        consequence: "Four business days from the conclusion that an impairment is required. If the conclusion is reached as part of closing the books, the filing may be deferred to the periodic report in some circumstances — check before relying on that.",
      },
      {
        id: "EI-CALC",
        kind: "analysis",
        label: "The impairment or exit cost calculation",
        due: D.calendarDaysAfter(30),
        anchor: "declared",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 350-20-35", "ASC 360-10-35", "ASC 420-10-25"],
        docCategory: "J-040",
        consequence: "With the assumptions, the discount rate and the basis for each, dated to the commitment.",
      },
    ],
  },

  // ════════════════ CORPORATE ════════════════
  insider_trade: {
    key: "insider_trade",
    group: "Corporate",
    label: "An officer or director bought or sold company stock, or exercised options",
    aliases: ["form 4", "insider", "bought stock", "sold stock", "option exercise", "rsu vest", "10b5-1", "gift"],
    headline:
      "Two business days, and the duty is the individual's rather than the company's — but the company " +
      "gets named in the proxy for their delinquency, and the SEC has penalised companies for contributing " +
      "to these failures. The clock runs from the trade date, not settlement.",
    anchors: ["occurred"],
    questions: [
      Q.text("who", "Who, and what did they do?", ""),
      Q.yesno("is_insider", "Are they a director, officer or 10% holder?", ""),
      Q.yesno("under_plan", "Was it under a Rule 10b5-1 plan where they did not pick the date?", "If so the clock runs from when the broker notified them, capped at the third business day after the trade."),
      Q.yesno("is_affiliate_sale", "Is it a sale by an affiliate of more than 5,000 shares or $50,000 in any three months?", "If so a Form 144 is also required, filed at the same time as the order is placed."),
      Q.yesno("plan_activity", "Did anyone adopt, change or cancel a trading plan this quarter?", "This is a quarterly disclosure item in its own right."),
    ],
    obligations: [
      {
        id: "IT-FORM4",
        kind: "filing",
        label: "Form 4 — before the end of the second business day after the trade",
        onlyIf: (a) => yes(a, "is_insider"),
        due: D.businessDaysAfter(2),
        anchor: "occurred",
        requires: { section12: true },
        owner: "cfo",
        severity: "critical",
        verified: true,
        authority: ["Exchange Act § 16(a)(2)(C)", "Rule 16a-3(g)"],
        consequence:
          "Two business days from the TRADE date, not settlement. Delinquency is disclosed in the proxy " +
          "under Item 405, and recent SEC sweeps have penalised both the individuals and the companies that " +
          "contributed to the failures.",
        note: "Only where the class is registered under Section 12. A Section 15(d)-only filer's insiders have no Section 16 duty at all.",
      },
      {
        id: "IT-FORM144",
        kind: "filing",
        label: "Form 144 — filed at the same moment the order is placed",
        onlyIf: (a) => yes(a, "is_affiliate_sale"),
        due: D.sameDay(),
        anchor: "occurred",
        requires: { section12: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Rule 144(h)"],
        consequence: "Concurrent with placing the order, not before and not after. Required only for affiliates above 5,000 shares or $50,000 in three months.",
      },
      {
        id: "IT-408",
        kind: "document",
        label: "Record it in the quarterly trading-arrangement register",
        onlyIf: (a) => yes(a, "plan_activity"),
        due: D.calendarDaysAfter(5),
        anchor: "occurred",
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["Reg S-K Item 408(a)"],
        docCategory: "A-100",
        consequence:
          "The company has to disclose plans adopted, modified or terminated each quarter, with the name, " +
          "title, dates, duration and share count. The company cannot disclose what nobody told it, so the " +
          "real obligation is the insider telling the company.",
      },
    ],
  },

  corporate_change: {
    key: "corporate_change",
    group: "Corporate",
    label: "We changed the company's name, state, charter, ticker or transfer agent",
    aliases: ["name change", "ticker", "reincorporate", "charter", "bylaws", "transfer agent", "holding company", "fiscal year"],
    headline:
      "Several of these are PRE-ACT notices for a listed company: a reincorporation or holding-company " +
      "reorganisation is a Substitution Listing Event needing fifteen calendar days' advance notice, and " +
      "once it is done the notice cannot be given late.",
    anchors: ["declared", "effective"],
    questions: [
      Q.text("what", "What is changing?", ""),
      Q.yesno("charter_amended", "Is the charter or are the bylaws being amended?", ""),
      Q.yesno("reincorporating", "Are you reincorporating, forming a holding company, or reclassifying the shares?", "Any of these is a Substitution Listing Event."),
      Q.yesno("name_or_ticker", "Is the company name or ticker changing?", ""),
      Q.yesno("transfer_agent", "Are you changing transfer agent or registrar?", ""),
      Q.yesno("fiscal_year", "Is the fiscal year end changing?", ""),
    ],
    obligations: [
      {
        id: "CC-SLE",
        kind: "notice",
        label: "Notify Nasdaq of the Substitution Listing Event, BEFORE it happens",
        onlyIf: (a) => yes(a, "reincorporating"),
        due: D.calendarDaysBefore(15),
        anchor: "effective",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        preAct: true,
        verified: true,
        authority: ["Nasdaq Rule 5250(e)(4)", "Nasdaq Rule 5005"],
        consequence:
          "Fifteen calendar days before implementation, and it cannot be cured. Late notice disrupts the " +
          "market effective date, the CUSIP and depository processing.",
        note: "The rule says fifteen days before implementation; Nasdaq's continued listing guide says before the record date. Those are different anchors, so work to whichever is earlier.",
      },
      {
        id: "CC-REC",
        kind: "notice",
        label: "Notify Nasdaq of the record-keeping change",
        onlyIf: (a) => yes(a, "name_or_ticker"),
        due: D.calendarDaysAfter(10),
        anchor: "effective",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Nasdaq Rule 5250(e)(3)"],
        consequence: "Ten days after the change. The rule does not say whether calendar or business days, so the portal treats it as calendar, which is the conservative reading.",
      },
      {
        id: "CC-TA",
        kind: "notice",
        label: "Notify Nasdaq of the transfer agent change, promptly and in writing",
        onlyIf: (a) => yes(a, "transfer_agent"),
        due: D.sameDay(),
        anchor: "effective",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["Nasdaq Rule 5250(e)(5)"],
        consequence: "The rule says promptly and in writing and sets no day count, so the portal shows same-day rather than inventing one.",
      },
      {
        id: "CC-8K-503",
        kind: "filing",
        label: "File Form 8-K Item 5.03 — charter or bylaw amendment, or fiscal year change",
        onlyIf: (a) => yes(a, "charter_amended") || yes(a, "fiscal_year"),
        due: D.businessDaysAfter(4),
        anchor: "effective",
        item8k: "5.03",
        requires: { reporting: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Form 8-K Item 5.03"],
        docCategory: "L-190",
        consequence: "Four business days, with the amendment as an exhibit. Item 5.03 is outside the Form S-3 safe harbour.",
      },
      {
        id: "CC-DOCS",
        kind: "document",
        label: "File the amended charter or bylaws",
        onlyIf: (a) => yes(a, "charter_amended"),
        due: D.businessDaysAfter(5),
        anchor: "effective",
        owner: "corporate_secretary",
        severity: "normal",
        verified: true,
        authority: ["Reg S-K 601(b)(3)"],
        docCategory: "A-060",
        consequence: "As filed with the state, with the stamped copy.",
      },
    ],
  },

  new_jurisdiction: {
    key: "new_jurisdiction",
    group: "Operations",
    label: "We started doing business in a new state or country",
    aliases: ["new state", "nexus", "foreign qualification", "expansion", "new office", "hired remote", "new country"],
    headline:
      "No filing clock, and no auditor asks about it until there is a liability. Economic nexus means a " +
      "company can owe sales tax in a state it has never set foot in, and a single remote employee creates " +
      "payroll and income tax obligations.",
    anchors: ["occurred"],
    questions: [
      Q.text("where", "Where?", ""),
      Q.yesno("employees", "Do you have employees or contractors there?", ""),
      Q.yesno("sales", "Are you selling to customers there?", ""),
      Q.yesno("property", "Do you have property, inventory or an office there?", ""),
    ],
    obligations: [
      {
        id: "NJ-NEXUS",
        kind: "analysis",
        label: "Nexus assessment — income, sales and use, payroll, franchise",
        due: D.calendarDaysAfter(45),
        anchor: "occurred",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 450-20-25-2", "ASC 740-10-25-6"],
        docCategory: "I-080",
        consequence:
          "Economic nexus does not need physical presence. Unregistered exposure accrues quietly and comes " +
          "out as an unrecorded liability, usually with penalties and interest attached, often years later.",
      },
      {
        id: "NJ-REG",
        kind: "document",
        label: "Registrations: foreign qualification, sales tax, payroll, franchise tax",
        due: D.calendarDaysAfter(60),
        anchor: "occurred",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["State law"],
        docCategory: "I-080",
        consequence: "No federal securities deadline. Each state sets its own, and they start running from the first activity.",
      },
    ],
  },

  bank_account: {
    key: "bank_account",
    group: "Money",
    label: "We opened or closed a bank, brokerage or merchant account",
    aliases: ["bank account", "merchant account", "stripe", "payment processor", "brokerage", "closed account"],
    headline:
      "Small, and the one sweep question that catches the most real problems. An account nobody told the " +
      "auditor about means the cash confirmation population is incomplete, which is a scope problem rather " +
      "than a disclosure one.",
    anchors: ["occurred"],
    questions: [
      Q.text("institution", "Which institution, and what kind of account?", ""),
      Q.yesno("opened", "Is this a new account?", ""),
      Q.yesno("zero_balance", "Is it a zero-balance or dormant account?", "These are the ones that get forgotten, and they still need confirming."),
      Q.yesno("signatories", "Have the authorised signatories been documented?", ""),
    ],
    obligations: [
      {
        id: "BA-LIST",
        kind: "document",
        label: "Update the bank account listing and the confirmation population",
        due: D.calendarDaysAfter(10),
        anchor: "occurred",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["AS 2310", "AS 2110.46"],
        docCategory: "C-010",
        consequence: "Every account, including zero-balance ones, has to be in the population the auditor confirms. A missing account is a completeness failure.",
      },
      {
        id: "BA-AUTH",
        kind: "document",
        label: "Record the signatories and approval limits",
        onlyIf: (a) => yes(a, "opened"),
        due: D.calendarDaysAfter(10),
        anchor: "occurred",
        owner: "controller",
        severity: "normal",
        verified: true,
        authority: ["AS 2110.46"],
        docCategory: "A-110",
        consequence: "Part of the segregation-of-duties record, and the first thing tested if anything goes wrong.",
      },
    ],
  },

  dividend_or_split: {
    key: "dividend_or_split",
    group: "Corporate",
    label: "We declared a dividend, or a stock split",
    aliases: ["dividend", "distribution", "split", "reverse split", "forward split", "record date"],
    headline:
      "Pre-act notices for a listed company, and a reverse split has TWO of them: notice to the exchange ten " +
      "calendar days before the market effective date by noon Eastern, and public disclosure at least two " +
      "business days before. Miss either and Nasdaq will not process the split on the date you wanted — " +
      "which, for a company inside a bid-price cure period, can be fatal.",
    anchors: ["declared", "effective"],
    questions: [
      Q.text("what", "What was declared?", ""),
      Q.yesno("is_reverse_split", "Is it a reverse split?", "If so there is a dedicated playbook with the full sequence."),
      Q.yesno("is_dividend", "Is it a cash or stock dividend or distribution?", ""),
      Q.date("record_date", "What is the record date?", ""),
    ],
    obligations: [
      {
        id: "DS-NASDAQ-DIV",
        kind: "notice",
        label: "Notify Nasdaq of the dividend or distribution, before the record date",
        onlyIf: (a) => yes(a, "is_dividend"),
        due: D.calendarDaysBefore(10),
        anchor: "effective",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        preAct: true,
        verified: true,
        authority: ["Nasdaq Rule 5250(e)(6)"],
        consequence:
          "Ten calendar days before the record date, and in any event no later than simultaneously with the " +
          "public announcement — so the real trigger is the board declaration, not the record date.",
      },
      {
        id: "DS-NASDAQ-RS",
        kind: "notice",
        label: "Notify Nasdaq of the reverse split by noon Eastern, ten calendar days ahead",
        onlyIf: (a) => yes(a, "is_reverse_split"),
        due: D.calendarDaysBefore(10),
        anchor: "effective",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        preAct: true,
        verified: true,
        authority: ["Nasdaq Rule 5250(e)(7)"],
        consequence: "Raised from five business days to ten calendar days with effect from January 2025. By 12:00 noon Eastern on the tenth day.",
      },
      {
        id: "DS-PUBLIC-RS",
        kind: "notice",
        label: "Publicly disclose the reverse split two business days ahead",
        onlyIf: (a) => yes(a, "is_reverse_split"),
        due: D.calendarDaysBefore(2),
        anchor: "effective",
        requires: { listed: true, exchangeFamily: "nasdaq" },
        owner: "cfo",
        severity: "critical",
        preAct: true,
        verified: false,
        authority: ["Nasdaq Rule 5250(b)(4)", "Nasdaq IM-5250-3"],
        consequence:
          "By noon Eastern at least two business days before the market effective date, with MarketWatch " +
          "notified at least ten minutes before the release goes out.",
        note: "Read in the interpretive material rather than in the text of Rule 5250(b)(4) itself, and the portal computes it in calendar days. Confirm against the live rulebook.",
      },
      {
        id: "DS-PLAYBOOK",
        kind: "decision",
        label: "Open the reverse split playbook for the full sequence",
        onlyIf: (a) => yes(a, "is_reverse_split"),
        due: D.sameDay(),
        anchor: "declared",
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["FINRA Rule 6490", "Form 8-K Item 5.03"],
        consequence:
          "A reverse split is ten obligations, not three, and the post-split price measurement period is the " +
          "one that costs months. Declare it under Corporate actions to get the whole chain.",
      },
      {
        id: "DS-8K-303",
        kind: "filing",
        label: "Consider Form 8-K Item 3.03 — material modification to the rights of security holders",
        onlyIf: (a) => yes(a, "is_reverse_split"),
        due: D.businessDaysAfter(4),
        anchor: "effective",
        item8k: "3.03",
        requires: { reporting: true },
        owner: "cfo",
        severity: "high",
        verified: true,
        authority: ["Form 8-K Item 3.03", "Form 8-K Item 5.03"],
        docCategory: "L-190",
        consequence: "Usually filed together with the Item 5.03 charter amendment.",
      },
    ],
  },

  subsidiary_formed: {
    key: "subsidiary_formed",
    group: "Corporate",
    label: "We formed, acquired or dissolved a subsidiary or joint venture",
    aliases: ["subsidiary", "llc", "joint venture", "jv", "entity", "dissolved", "new company"],
    headline:
      "Quiet at the time and expensive later. The consolidation conclusion, the intercompany arrangements " +
      "and the ownership documents are far easier to assemble now than two years on.",
    anchors: ["occurred"],
    questions: [
      Q.text("entity", "What entity, where, and what for?", ""),
      Q.yesno("wholly_owned", "Is it wholly owned?", ""),
      Q.yesno("other_investors", "Are there other investors or partners?", "If so, who controls it is a real question rather than a formality."),
      Q.yesno("funding_commitment", "Has the company committed to fund it, now or later?", "An unfunded capital commitment is a disclosable obligation."),
      Q.yesno("foreign", "Is it organised outside the United States?", ""),
    ],
    obligations: [
      {
        id: "SF-CONSOL",
        kind: "analysis",
        label: "Consolidation conclusion, including the variable interest analysis",
        due: D.calendarDaysAfter(30),
        anchor: "occurred",
        owner: "controller",
        severity: "high",
        verified: true,
        authority: ["ASC 810-10-15-14", "ASC 810-10-25-38", "ASC 323-10-15"],
        docCategory: "A-070",
        consequence:
          "Consolidate, equity method, or neither. With other investors involved, the answer turns on who " +
          "has power over the activities that matter, not on the percentage held.",
      },
      {
        id: "SF-DOCS",
        kind: "document",
        label: "Formation documents, ownership record and the updated entity chart",
        due: D.calendarDaysAfter(21),
        anchor: "occurred",
        owner: "corporate_secretary",
        severity: "normal",
        verified: true,
        authority: ["Reg S-K 601(b)(21)"],
        docCategory: "A-070",
        consequence: "The subsidiary list is a required exhibit, and the entity chart is the first thing a new auditor asks for.",
      },
      {
        id: "SF-COMMIT",
        kind: "document",
        label: "Record the funding commitment and any capital call schedule",
        onlyIf: (a) => yes(a, "funding_commitment"),
        due: D.calendarDaysAfter(21),
        anchor: "occurred",
        owner: "cfo",
        severity: "normal",
        verified: true,
        authority: ["ASC 440-10-50-1", "ASC 323-10-50"],
        docCategory: "J-080",
        consequence: "An unfunded commitment is disclosed, and one comparable issuer carried several million dollars of them with no line item anywhere.",
      },
    ],
  },
};

// ── Evaluation ──────────────────────────────────────────────

/**
 * Work out what a reported event actually triggers.
 *
 * @param {string} key      event key
 * @param {object} answers  { questionId: value }
 * @param {object} dates    { signed, closed, occurred, learned, notice, determined, declared, effective }
 * @param {object} profile  the issuer profile
 */
function evaluate(key, answers = {}, dates = {}, profile = null) {
  const ev = EVENTS[key];
  if (!ev) throw new Error(`Unknown event "${key}".`);
  const regime = regimeOf(profile);

  const obligations = [];
  const suppressed = [];

  for (const ob of ev.obligations) {
    if (!obligationApplies(ob, regime)) {
      suppressed.push({
        id: ob.id,
        label: ob.label,
        reason: ob.requires && ob.requires.listed
          ? "Applies only to companies listed on an exchange."
          : ob.requires && ob.requires.section12
          ? "Applies only where the class is registered under Section 12 of the Exchange Act."
          : "Does not apply to this issuer's reporting posture.",
      });
      continue;
    }
    if (typeof ob.onlyIf === "function" && !ob.onlyIf(answers, profile)) continue;

    const anchorKey = ob.anchor;
    const anchorDate =
      dates[anchorKey] || dates.occurred || dates.signed || dates.notice || dates.learned || dates.closed || null;
    const dueDate = anchorDate ? playbooks.resolveOffset(anchorDate, ob.due) : null;

    obligations.push({
      ...ob,
      // Set explicitly rather than inherited, so these keys are always
      // present in the JSON. JSON.stringify drops undefined, and an API
      // consumer that has to distinguish "false" from "missing key" will
      // eventually get it wrong.
      preAct: !!ob.preAct,
      verified: !!ob.verified,
      severity: ob.severity || "normal",
      anchorKey,
      anchorDate: anchorDate || null,
      anchorLabel: ANCHORS[anchorKey] ? ANCHORS[anchorKey].label : anchorKey,
      dueDate,
      dateConfidence: !ob.verified ? "unconfirmed" : "computed",
      // The consequence an operator cannot know. Only flagged for a
      // filing with an identified 8-K item.
      s3Risk: ob.kind === "filing" && !!ob.item8k && breaksS3IfLate(ob.item8k),
      overdue: dueDate ? cal.parse(dueDate) < cal.parse(cal.today()) : false,
    });
  }

  // Pre-act obligations first, then by date, then by severity. A notice
  // that was due before the act is the loudest thing on the page.
  const rank = { critical: 0, high: 1, normal: 2 };
  obligations.sort((a, b) => {
    if (!!b.preAct !== !!a.preAct) return b.preAct ? 1 : -1;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    return (rank[a.severity] || 2) - (rank[b.severity] || 2);
  });

  return {
    key: ev.key,
    label: ev.label,
    group: ev.group,
    headline: ev.headline,
    catalogVersion: CATALOG_VERSION,
    regime,
    obligations,
    suppressed,
    counts: {
      total: obligations.length,
      filings: obligations.filter((o) => o.kind === "filing").length,
      preAct: obligations.filter((o) => o.preAct).length,
      critical: obligations.filter((o) => o.severity === "critical").length,
      unverified: obligations.filter((o) => !o.verified).length,
      s3Risk: obligations.filter((o) => o.s3Risk).length,
    },
  };
}

/** The catalog as the intake page shows it, grouped. */
function list(profile) {
  const regime = regimeOf(profile);
  const groups = {};
  for (const ev of Object.values(EVENTS)) {
    const possible = ev.obligations.filter((ob) => obligationApplies(ob, regime));
    (groups[ev.group] = groups[ev.group] || []).push({
      key: ev.key,
      label: ev.label,
      group: ev.group,
      aliases: ev.aliases,
      headline: ev.headline,
      questions: ev.questions,
      anchors: ev.anchors.map((a) => ({ key: a, ...ANCHORS[a] })),
      maxObligations: possible.length,
      hasPreAct: possible.some((ob) => ob.preAct),
    });
  }
  return { groups, catalogVersion: CATALOG_VERSION, regime };
}

/** Every pre-act obligation across the catalog, for the standing warning. */
function preActObligations(profile) {
  const regime = regimeOf(profile);
  const out = [];
  for (const ev of Object.values(EVENTS)) {
    for (const ob of ev.obligations) {
      if (!ob.preAct || !obligationApplies(ob, regime)) continue;
      out.push({
        eventKey: ev.key,
        eventLabel: ev.label,
        id: ob.id,
        label: ob.label,
        authority: ob.authority,
        consequence: ob.consequence,
        lead: ob.due,
      });
    }
  }
  return out;
}

module.exports = {
  CATALOG_VERSION,
  EVENTS,
  ANCHORS,
  S3_SAFE_HARBOR_ITEMS,
  breaksS3IfLate,
  regimeOf,
  obligationApplies,
  evaluate,
  list,
  preActObligations,
};
