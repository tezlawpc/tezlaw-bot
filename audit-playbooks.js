// ============================================================
//  PCAOB AUDIT PORTAL — CORPORATE ACTION PLAYBOOKS
//  audit-playbooks.js
//  ─────────────────────────────────────────────────────────
//  A corporate action is not one filing. It is a chain of dated
//  obligations, most of which nobody is watching.
//
//  THE PROBLEM THIS EXISTS FOR
//  A company resolves to do a reverse split. Everyone attends
//  to the visible parts — the board consent, the charter
//  amendment, the FINRA notice. Then an exchange applies a
//  post-split seasoning or trading-measurement requirement that
//  nobody mentioned, the application sits, and months are lost.
//  The cost is not a penalty; it is delay, and delay on an
//  uplisting is expensive in a way no one invoices for.
//
//  That failure is structural. The obligations live across the
//  Exchange Act, FINRA rules, the exchange manual and state
//  corporate law, and no single adviser owns all four. Counsel
//  watches the securities filings. The transfer agent watches
//  the mechanics. The auditor watches the financial statements.
//  The gap between them is where the months go.
//
//  ── HOW TO READ THE `verified` FIELD ──
//  Every step carries `authority` and a `verified` flag.
//
//    verified: true   the citation has been checked against the
//                     rule text and the arithmetic is implemented
//    verified: false  the step is believed to apply but the
//                     citation, the trigger or the day count has
//                     NOT been confirmed against primary sources
//
//  Unverified steps are still generated, because a reminder to
//  go and check is worth more than silence. They are labelled as
//  unverified everywhere they appear, and they never carry a
//  computed date presented as authoritative.
//
//  This distinction is the product. A compliance tool that
//  states an unverified deadline with a confident date is worse
//  than no tool, because someone will rely on it. Nothing here
//  should ever assert more certainty than has been earned.
// ============================================================

const cal = require("./audit-calendar");

// Offsets are expressed as functions of the action's own dates, so a
// playbook reads as the rule reads rather than as arithmetic.
const D = {
  businessDaysAfter: (n) => ({ kind: "businessDaysAfter", n }),
  calendarDaysAfter: (n) => ({ kind: "calendarDaysAfter", n }),
  calendarDaysBefore: (n) => ({ kind: "calendarDaysBefore", n }),
  tradingDaysAfter: (n) => ({ kind: "tradingDaysAfter", n }),
  sameDay: () => ({ kind: "sameDay" }),
  none: () => ({ kind: "none" }),
};

function resolveOffset(anchorDate, offset) {
  const anchor = cal.parse(anchorDate);
  if (!anchor || !offset || offset.kind === "none") return null;
  switch (offset.kind) {
    case "sameDay":
      return cal.iso(anchor);
    case "calendarDaysAfter":
      return cal.iso(cal.addDays(anchor, offset.n));
    case "calendarDaysBefore":
      return cal.iso(cal.addDays(anchor, -offset.n));
    case "businessDaysAfter":
      return cal.iso(cal.addBusinessDays(cal.isBusinessDay(anchor) ? anchor : cal.rollForward(anchor), offset.n));
    case "tradingDaysAfter":
      // Trading days are business days less exchange holidays. The
      // federal holiday calendar is a close but imperfect proxy — the
      // exchanges observe Good Friday and do not observe Columbus Day
      // or Veterans Day — so anything measured in trading days is
      // treated as approximate and flagged as such on the item.
      return cal.iso(cal.addBusinessDays(cal.isBusinessDay(anchor) ? anchor : cal.rollForward(anchor), offset.n));
    default:
      return null;
  }
}

// ── Playbooks ───────────────────────────────────────────────

const PLAYBOOKS = {
  reverse_split: {
    key: "reverse_split",
    label: "Reverse stock split",
    anchorLabel: "Board approval date",
    secondAnchorLabel: "Intended effective date",
    headline:
      "A reverse split touches state corporate law, the Exchange Act, FINRA's corporate action rules and, " +
      "if a listing is in view, the exchange's own price and seasoning requirements. The securities filings " +
      "are the part everyone remembers. The exchange mechanics are the part that costs months.",
    steps: [
      {
        id: "RS-010",
        label: "Board resolution approving the split and the ratio",
        offset: D.sameDay(),
        anchor: "approval",
        owner: "cfo",
        category: "A-010",
        authority: ["State corporate law", "Charter / bylaws"],
        verified: true,
        note: "The ratio and its effective date drive every other date in this sequence.",
      },
      {
        id: "RS-020",
        label: "Shareholder approval, or confirmation it is not required",
        offset: D.none(),
        anchor: "approval",
        owner: "cfo",
        category: "A-040",
        authority: ["State corporate law", "Exchange Act Rule 14c-2"],
        verified: false,
        note:
          "Whether holder approval is required turns on the state of incorporation and the charter. " +
          "Where it is obtained by written consent of a controlling holder, an information statement " +
          "under Regulation 14C is required and cannot be mailed until SEC review has run its course. " +
          "CONFIRM the requirement and the review timing for this registrant before relying on any date.",
      },
      {
        id: "RS-030",
        label: "FINRA corporate action notice (Rule 6490)",
        offset: D.calendarDaysBefore(25),
        anchor: "effective",
        owner: "cfo",
        category: "K-050",
        authority: ["FINRA Rule 6490", "SEA Rule 10b-17"],
        verified: false,
        note:
          "For a security quoted over the counter, FINRA must be notified in advance of the record or " +
          "effective date, with the notice period set by Rule 6490 and Rule 10b-17. Filing late, or " +
          "incompletely, delays the split itself. CONFIRM the current notice period and the completeness " +
          "requirements — this is the step most often discovered too late.",
      },
      {
        id: "RS-040",
        label: "Charter amendment filed with the state",
        offset: D.none(),
        anchor: "effective",
        owner: "cfo",
        category: "A-060",
        authority: ["State corporate law"],
        verified: true,
      },
      {
        id: "RS-050",
        label: "Form 8-K reporting the split and its effect",
        offset: D.businessDaysAfter(4),
        anchor: "effective",
        owner: "cfo",
        category: "L-190",
        authority: ["Form 8-K Item 5.03", "Form 8-K Gen. Instr. B.1"],
        verified: true,
        note: "Four business days from the triggering event.",
      },
      {
        id: "RS-060",
        label: "Transfer agent confirmation of shares outstanding after the split",
        offset: D.businessDaysAfter(5),
        anchor: "effective",
        owner: "cfo",
        category: "H-010",
        authority: ["Reg S-X 8-03"],
        verified: true,
        note:
          "The auditor will reconcile the cap table to this. Retroactive restatement of share and " +
          "per-share amounts for all periods presented follows from it.",
      },
      {
        id: "RS-070",
        label: "Retroactive restatement of share and per-share data in the next filing",
        offset: D.none(),
        anchor: "effective",
        owner: "cfo",
        category: "H-090",
        authority: ["ASC 260-10-55-12", "Reg S-X 8-03"],
        verified: true,
        note: "A split is applied retroactively to every period presented, including EPS.",
      },
      {
        id: "RS-080",
        label: "Post-split price and trading measurement period for an exchange application",
        offset: D.tradingDaysAfter(30),
        anchor: "effective",
        owner: "cfo",
        category: "L-210",
        approximate: true,
        authority: ["Nasdaq Rule 5505", "Nasdaq Rule 5510", "Nasdaq IM-5101-1"],
        verified: false,
        note:
          "THIS IS THE STEP THAT COSTS MONTHS. An exchange does not accept a price achieved on the day " +
          "of a split: it looks for the price to be maintained over a measurement period of trading days, " +
          "and an over-the-counter applicant faces an average-daily-volume test over a similar window. " +
          "The listing application cannot usefully be filed until that window has run. " +
          "CONFIRM the exact measurement period, the number of trading days and any offering-based waiver " +
          "against the current Nasdaq manual before treating this date as real.",
      },
      {
        id: "RS-090",
        label: "Round lot holder count re-verified after the split",
        offset: D.tradingDaysAfter(30),
        anchor: "effective",
        owner: "cfo",
        category: "H-020",
        approximate: true,
        authority: ["Nasdaq Rule 5505(a)", "Nasdaq Rule 5005(a)(38)"],
        verified: false,
        note:
          "A split sized to clear a price threshold can push the round lot holder count below the minimum, " +
          "because small holders are rounded out. The two requirements pull against each other and are " +
          "usually modelled separately, which is how a company clears the price and fails the holders. " +
          "CONFIRM current thresholds before relying on this.",
      },
      {
        id: "RS-100",
        label: "Reverse split disclosed in the listing application and in subsequent filings",
        offset: D.none(),
        anchor: "effective",
        owner: "cfo",
        category: "H-100",
        authority: ["Nasdaq Rule 5210", "Nasdaq Rule 5110"],
        verified: false,
        note:
          "For a company already listed, a split within a prior period can itself be a delisting trigger " +
          "under the 2024–2025 amendments. CONFIRM applicability to this registrant's current status.",
      },
    ],
  },

  uplisting_application: {
    key: "uplisting_application",
    label: "Exchange uplisting application",
    anchorLabel: "Target application date",
    headline:
      "The application is the last step, not the first. Everything that must be true on the day it is " +
      "filed has its own lead time, and the ones with the longest lead times are the ones least often " +
      "started early.",
    steps: [
      {
        id: "UP-010",
        label: "Round lot holder analysis commissioned",
        offset: D.calendarDaysBefore(90),
        anchor: "application",
        owner: "cfo",
        category: "H-020",
        authority: ["Nasdaq Rule 5505(a)", "Nasdaq Rule 5005(a)(38)"],
        verified: false,
        note:
          "Takes weeks to produce through the transfer agent and the depository, and frequently comes back " +
          "worse than expected. Start it before anything else. CONFIRM the current holder thresholds.",
      },
      {
        id: "UP-020",
        label: "Confidential staff consultation on any characterisation risk",
        offset: D.calendarDaysBefore(75),
        anchor: "application",
        owner: "cfo",
        category: "K-050",
        authority: ["Nasdaq IM-5101-1"],
        verified: true,
        note:
          "Where a recent combination could be characterised as a reverse merger, or where discretionary " +
          "authority might be exercised, that determination belongs to exchange staff and should be " +
          "obtained before a timeline is communicated to anyone.",
      },
      {
        id: "UP-030",
        label: "Shareholder-meeting and proxy practice brought into compliance",
        offset: D.calendarDaysBefore(60),
        anchor: "application",
        owner: "cfo",
        category: "A-040",
        authority: ["Nasdaq Rule 5620(b)"],
        verified: true,
        note:
          "A company that has been acting by written consent of a controlling holder must move to " +
          "solicited proxies. The change should be visible in the record before the application rather " +
          "than promised in it.",
      },
      {
        id: "UP-040",
        label: "Late-filing history closed out",
        offset: D.calendarDaysBefore(60),
        anchor: "application",
        owner: "cfo",
        category: "L-180",
        authority: ["Nasdaq Rule 5250(c)", "Exchange Act Rule 12b-25"],
        verified: true,
        note: "Timely filing is a continued listing condition. Staff will see the pattern and ask.",
      },
      {
        id: "UP-050",
        label: "Governance composition confirmed — independent directors and committees",
        offset: D.calendarDaysBefore(45),
        anchor: "application",
        owner: "cfo",
        category: "A-050",
        authority: ["Nasdaq Rule 5605"],
        verified: false,
        note:
          "Board independence, an audit committee of the required size and composition, and a compensation " +
          "committee. Recruiting an independent director takes longer than any other item here. " +
          "CONFIRM current composition requirements and any phase-in available to a new listing.",
      },
      {
        id: "UP-060",
        label: "Quantitative standards modelled against the offering",
        offset: D.calendarDaysBefore(30),
        anchor: "application",
        owner: "cfo",
        category: "L-210",
        authority: ["Nasdaq Rule 5505(b)"],
        verified: false,
        note:
          "Stockholders' equity, unrestricted publicly held shares and market value must be satisfied on " +
          "the facts as they will exist at listing, not as they are today. Where the float test must be " +
          "met from offering proceeds, the offering size is a listing input rather than a financing " +
          "decision. CONFIRM the current thresholds — they have moved recently.",
      },
      {
        id: "UP-070",
        label: "Auditor consents and currently dated reports assembled",
        offset: D.calendarDaysBefore(21),
        anchor: "application",
        owner: "cfo",
        category: "L-150",
        authority: ["AS 4101", "Securities Act § 7", "Reg S-K 601(b)(23)"],
        verified: true,
        note:
          "Where a predecessor auditor's reports still cover periods presented, a consent is needed from " +
          "each firm. Stale consents and stale financial statements are the two most common causes of delay.",
      },
    ],
  },

  auditor_change: {
    key: "auditor_change",
    label: "Change of auditor",
    anchorLabel: "Date of dismissal or resignation",
    headline:
      "The four-business-day clock is short and the letter requirement is the part that slips, because it " +
      "depends on a firm that has just been dismissed.",
    steps: [
      {
        id: "AC-010",
        label: "Form 8-K Item 4.01 reporting the change",
        offset: D.businessDaysAfter(4),
        anchor: "event",
        owner: "cfo",
        category: "L-190",
        authority: ["Form 8-K Item 4.01", "Reg S-K 304"],
        verified: true,
      },
      {
        id: "AC-020",
        label: "Former accountant's letter filed as Exhibit 16.1",
        offset: D.businessDaysAfter(4),
        anchor: "event",
        owner: "cfo",
        category: "L-160",
        authority: ["Reg S-K 304(a)(3)", "Reg S-K 601(b)(16)"],
        verified: true,
        note:
          "The former accountant must state whether it agrees with the disclosure. Obtaining it promptly " +
          "from a firm that has just been dismissed is the practical difficulty, and the deadline does not " +
          "move to accommodate it.",
      },
      {
        id: "AC-030",
        label: "Predecessor communications and workpaper access under AS 2610",
        offset: D.calendarDaysAfter(30),
        anchor: "event",
        owner: "auditor",
        category: "L-160",
        authority: ["AS 2610", "AS 2610.08"],
        verified: true,
        note:
          "Access is at the predecessor's discretion, not the successor's right. Where a registration " +
          "statement will carry the predecessor's reports, its consent will also be needed later.",
      },
    ],
  },
};

/**
 * Build the dated obligation list for an action.
 *
 * @param {string} key      playbook key
 * @param {object} anchors  { approval, effective, application, event } as ISO dates
 */
function build(key, anchors = {}) {
  const pb = PLAYBOOKS[key];
  if (!pb) throw new Error(`Unknown corporate action "${key}".`);

  const items = pb.steps.map((step) => {
    const anchorDate =
      anchors[step.anchor] || anchors.effective || anchors.event || anchors.application || anchors.approval || null;
    const due = anchorDate ? resolveOffset(anchorDate, step.offset) : null;
    return {
      ...step,
      anchorDate: anchorDate || null,
      dueDate: due,
      // An unverified step never presents its date as settled, and an
      // approximate one says so. The whole value of this feature is
      // that a reader can tell which dates to trust.
      dateConfidence: !step.verified ? "unconfirmed" : step.approximate ? "approximate" : "computed",
    };
  });

  return {
    key: pb.key,
    label: pb.label,
    headline: pb.headline,
    anchors,
    items,
    counts: {
      total: items.length,
      verified: items.filter((i) => i.verified).length,
      needsVerification: items.filter((i) => !i.verified).length,
    },
  };
}

// The dates a playbook actually measures from, in the order a person
// would be asked for them. Derived from the steps rather than restated
// beside them, so a new step cannot introduce an anchor that the form
// never collects — which would silently leave that step undated.
const ANCHOR_LABELS = {
  approval: "Board approval date",
  effective: "Effective date",
  application: "Application date",
  event: "Date of the event",
};

const ANCHOR_HELP = {
  approval: "The date the board resolved to do it.",
  effective: "The date it takes effect, which is what most of the sequence is measured from.",
  application: "The date the application is intended to be filed. Everything else works backwards from it.",
  event: "The date of dismissal, resignation or engagement, which starts the four business day clock.",
};

function anchorsUsed(key) {
  const pb = PLAYBOOKS[key];
  if (!pb) return [];
  const seen = [];
  for (const s of pb.steps) {
    if (s.anchor && !seen.includes(s.anchor)) seen.push(s.anchor);
  }
  // Ask for the approval date before the effective date, and the event
  // date before anything else, matching the order they occur.
  const order = ["approval", "event", "effective", "application"];
  return seen
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((a) => ({
      key: a,
      label: ANCHOR_LABELS[a] || a,
      help: ANCHOR_HELP[a] || "",
      steps: pb.steps.filter((s) => s.anchor === a).length,
    }));
}

function list() {
  return Object.values(PLAYBOOKS).map((p) => ({
    key: p.key,
    label: p.label,
    headline: p.headline,
    anchorLabel: p.anchorLabel,
    secondAnchorLabel: p.secondAnchorLabel || null,
    anchors: anchorsUsed(p.key),
    steps: p.steps.length,
    verified: p.steps.filter((s) => s.verified).length,
    needsVerification: p.steps.filter((s) => !s.verified).length,
  }));
}

module.exports = { PLAYBOOKS, build, list, anchorsUsed, ANCHOR_LABELS, resolveOffset, D };
