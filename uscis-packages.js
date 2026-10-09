// ============================================================
//  uscis-packages.js — the filings that go in one envelope
//  ─────────────────────────────────────────────────────────
//  "There are certain combo filings. Make sure they are available as an
//   option." (JJ, 2026-10-08)
//
//  Most of what this firm files is not one form. A marriage case is an
//  I-130 and an I-130A and an I-485 and an I-765 and an I-131 and an I-864,
//  signed by two different people, with a G-28 for each of them, and the
//  work-permit form in an asylum case is the same form filed five months
//  later for a different reason. Typing that list out of memory each time
//  is how a package goes out missing the I-130A.
//
//  SO THIS IS A LIST, NOT A DECISION
//  Each package names the forms, says who signs each one, and says what has
//  to be TRUE before the package is the right one. It does not decide
//  whether it is. Three things in particular are judgment and are carried
//  as `conditions`, never as assumptions:
//
//    - whether a visa number is available. An immediate relative always
//      has one; everybody else depends on the Visa Bulletin on the day of
//      filing, and the chart USCIS accepts that month.
//    - whether a form applies at all. The I-864A only exists when a
//      household member's income is being used; the I-130A only when the
//      beneficiary is a spouse.
//    - anything with a waiting period. The asylum work permit cannot be
//      filed on the day the asylum application is — see `later` below.
//
//  NO FEES ANYWHERE IN THIS FILE
//  USCIS changes them, a stale number in a checklist is worse than no
//  number, and uscis-watch.js already reports a fee notice the day it
//  publishes. The fee for each form comes from USCIS's own fee schedule on
//  the day of filing, which is also the only version that is correct.
//
//  FORM EDITIONS
//  The forms named here are ids in uscis-forms.js, so the edition tracker
//  and the Federal Register watch already cover every form in every
//  package. A package cannot name a form the firm does not track —
//  check-uscis-packages.js enforces that.
// ============================================================

const F = () => require("./uscis-forms");

/**
 * Who signs a form. This is the part a checklist usually gets wrong,
 * because two people are in the room and only one of them is the client
 * on the retainer.
 */
const ROLES = {
  petitioner:  "the petitioner",
  principal:   "the principal applicant",
  derivative:  "each derivative",
  sponsor:     "the sponsor",
  household:   "the household member whose income is used",
  beneficiary: "the beneficiary",
};

/**
 * The packages.
 *
 *   forms      what goes in the envelope now
 *   later      what is filed afterwards, and what has to happen first
 *   conditions what must be true for this package to be the right one
 *   capacity   the G-28 item 5 box for the person on the retainer
 *   per_person forms that repeat once for each derivative
 */
const PACKAGES = [
  {
    id: "aos_immediate_relative",
    name: "Adjustment of status — immediate relative of a U.S. citizen",
    short: "I-130 + I-485 concurrent",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: "applicant",
    summary: "The whole package in one envelope. An immediate relative always has a visa number, so the I-130 and the I-485 go together.",
    conditions: [
      "The petitioner is a U.S. citizen and the beneficiary is a spouse, a parent (petitioner 21 or over), or an unmarried child under 21.",
      "The beneficiary was inspected and admitted or paroled, or qualifies under INA 245(i).",
      "No bar applies that adjustment cannot cure — check before filing, not after.",
    ],
    forms: [
      { id: "i-130",  who: "petitioner", required: true },
      { id: "i-130a", who: "beneficiary", required: false, when: "the beneficiary is a spouse" },
      { id: "i-485",  who: "principal", required: true },
      { id: "i-864",  who: "sponsor", required: true },
      { id: "i-864a", who: "household", required: false, when: "a household member's income is being counted" },
      { id: "i-765",  who: "principal", required: false, when: "work authorization is wanted while it is pending" },
      { id: "i-131",  who: "principal", required: false, when: "the applicant may need to travel while it is pending" },
    ],
    also: [
      "I-693 medical, sealed by the civil surgeon. Not tracked here because USCIS does not publish it as a fillable form.",
      "Two passport photos for each applicant, and the filing fee for each form.",
    ],
    later: [],
    g28s: [
      { who: "petitioner", capacity: "petitioner", covers: ["i-130"] },
      { who: "principal", capacity: "applicant", covers: ["i-485", "i-765", "i-131"] },
    ],
    // THE IMMEDIATE RELATIVE CATEGORY HAS NO DERIVATIVES. A spouse's
    // children do not ride along on the spouse's petition the way they do
    // in a preference category; each of them needs an I-130 of their own,
    // and each petition stands or falls separately. Multiplying the I-485
    // by a family size here would quietly produce a package that cannot be
    // filed.
    derivatives: false,
    derivatives_note: "There are no derivatives in the immediate relative category. Every family member needs their own I-130 as well as their own I-485 \u2014 and a stepchild relationship has to have begun before the child turned 18.",
    per_person: [],
  },

  {
    id: "aos_preference_family",
    name: "Adjustment of status — family preference category",
    short: "I-130 + I-485 when the date is current",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: "applicant",
    summary: "The same package as an immediate relative, but only when a visa number is available. Otherwise the I-130 goes alone and the I-485 waits.",
    conditions: [
      "CHECK THE VISA BULLETIN FOR THE MONTH OF FILING. A preference beneficiary can file the I-485 only when their priority date is current under the chart USCIS accepts that month — and USCIS says which chart each month, which is not always the same one.",
      "If the date is not current, file the I-130 alone and calendar the bulletin.",
    ],
    forms: [
      { id: "i-130",  who: "petitioner", required: true },
      { id: "i-130a", who: "beneficiary", required: false, when: "the beneficiary is a spouse" },
      { id: "i-485",  who: "principal", required: false, when: "the priority date is current for filing" },
      { id: "i-864",  who: "sponsor", required: false, when: "the I-485 is being filed" },
      { id: "i-864a", who: "household", required: false, when: "a household member's income is being counted" },
      { id: "i-765",  who: "principal", required: false, when: "the I-485 is being filed and work authorization is wanted" },
      { id: "i-131",  who: "principal", required: false, when: "the I-485 is being filed and travel may be needed" },
    ],
    also: ["I-693 medical with the I-485.", "Derivatives file their own I-485 under the same priority date."],
    later: [
      { what: "I-485 and the rest", when: "the priority date becomes current", note: "Calendar the Visa Bulletin monthly." },
    ],
    g28s: [
      { who: "petitioner", capacity: "petitioner", covers: ["i-130"] },
      { who: "principal", capacity: "applicant", covers: ["i-485", "i-765", "i-131"] },
    ],
    derivatives: true,
    derivatives_note: "Derivative spouse and unmarried children under 21 adjust on the principal\"s priority date, each on their own I-485. Watch the Child Status Protection Act age for anyone near 21.",
    per_person: ["i-485", "i-765", "i-131"],
  },

  {
    id: "asylum_affirmative",
    name: "Affirmative asylum",
    short: "I-589 now, I-765 at 150 days",
    matter_type: "immigration_removal",
    before: "USCIS",
    capacity: "applicant",
    summary: "The asylum application goes alone. The work permit is a separate filing months later, and filing it early gets it rejected.",
    conditions: [
      "Filed within one year of the last arrival, or an exception applies and is documented.",
      "Not already in removal proceedings — a respondent files the I-589 with the Immigration Court, not USCIS, and appears on an EOIR-28 rather than a G-28.",
    ],
    forms: [
      { id: "i-589", who: "principal", required: true },
    ],
    also: [
      "Derivative spouse and unmarried children under 21 go on the principal's I-589; they do not file their own.",
      "One original and one copy for each applicant, with the supporting documents.",
    ],
    later: [
      {
        what: "I-765, category (c)(8)",
        when: "150 days after a complete I-589 is received, excluding any delay the applicant caused",
        note: "Filed before day 150 it is rejected. The permit itself cannot be granted before day 180.",
      },
    ],
    g28s: [{ who: "principal", capacity: "applicant", covers: ["i-589"] }],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },

  {
    id: "aos_employment",
    name: "Adjustment of status — employment based",
    short: "I-140 + I-485 when the date is current",
    matter_type: "immigration_business",
    before: "USCIS",
    capacity: "applicant",
    summary: "Concurrent filing where the category is current; otherwise the I-140 alone.",
    conditions: [
      "CHECK THE VISA BULLETIN FOR THE MONTH OF FILING, and which chart USCIS accepts that month.",
      "The petitioner is the employer unless the category is one that allows self-petition.",
      "A PERM labor certification, where the category needs one, is approved and still valid.",
    ],
    forms: [
      { id: "i-140", who: "petitioner", required: true },
      { id: "i-485", who: "principal", required: false, when: "the priority date is current for filing" },
      { id: "i-765", who: "principal", required: false, when: "the I-485 is being filed" },
      { id: "i-131", who: "principal", required: false, when: "the I-485 is being filed" },
    ],
    also: ["I-907 for premium processing of the I-140, if it is wanted — not tracked here."],
    later: [{ what: "I-485 and the rest", when: "the priority date becomes current" }],
    g28s: [
      { who: "petitioner", capacity: "petitioner", covers: ["i-140"] },
      { who: "principal", capacity: "applicant", covers: ["i-485", "i-765", "i-131"] },
    ],
    derivatives: true,
    derivatives_note: "Derivative spouse and unmarried children under 21 adjust on the principal\"s priority date, each on their own I-485.",
    per_person: ["i-485", "i-765", "i-131"],
  },

  {
    id: "eb5_regional_center",
    name: "EB-5 — regional center investor",
    short: "I-526E, then adjustment",
    matter_type: "immigration_business",
    before: "USCIS",
    capacity: "petitioner",
    summary: "The investor petitions for themselves, so the same person is petitioner on the I-526E and applicant on any later I-485.",
    conditions: [
      "The investment is made or in the process of being made, and the source of funds is documented.",
      "Concurrent I-485 only where the category is current for the investor's country.",
    ],
    forms: [
      { id: "i-526e", who: "principal", required: true },
      { id: "i-485",  who: "principal", required: false, when: "the category is current and the investor is in the United States in a status that allows adjustment" },
      { id: "i-765",  who: "principal", required: false, when: "the I-485 is being filed" },
      { id: "i-131",  who: "principal", required: false, when: "the I-485 is being filed" },
    ],
    also: ["Spouse and unmarried children under 21 may adjust as derivatives, each on their own I-485."],
    later: [
      { what: "I-485 and the rest", when: "the category is current" },
      { what: "I-829", when: "within the 90 days before the two-year conditional residence ends", note: "Not tracked here yet." },
    ],
    g28s: [{ who: "principal", capacity: "petitioner", covers: ["i-526e"] }],
    derivatives: true,
    derivatives_note: "Derivative spouse and unmarried children under 21 adjust on the investor\"s petition, each on their own I-485.",
    per_person: ["i-485", "i-765", "i-131"],
  },

  {
    id: "remove_conditions",
    name: "Removing conditions on residence",
    short: "I-751",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: "petitioner",
    summary: "Joint with the spouse, or alone with a waiver. The receipt notice extends the green card, so a work permit is usually not needed.",
    conditions: [
      "Joint filing goes in during the 90 days before the two-year card expires. A waiver filing can go in at any time.",
      "A waiver needs its ground established on the form and in the evidence: good-faith marriage ended, abuse, or extreme hardship.",
    ],
    forms: [
      { id: "i-751", who: "principal", required: true },
      { id: "i-765", who: "principal", required: false, when: "the receipt notice's extension is not enough for the applicant's situation" },
    ],
    also: ["Evidence of the bona fides of the marriage across the whole two years, not only at the start."],
    later: [],
    g28s: [{ who: "principal", capacity: "petitioner", covers: ["i-751"] }],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },

  {
    id: "naturalization",
    name: "Naturalization",
    short: "N-400",
    matter_type: "immigration_naturalization",
    before: "USCIS",
    capacity: "applicant",
    summary: "One form. The work is in the eligibility date and the record, not the package.",
    conditions: [
      "Five years as a permanent resident, or three if filing on a marriage to a U.S. citizen and still married to and living with that citizen.",
      "The 90-day early-filing rule applies to the residence period, not to every requirement.",
      "Check the whole record first: any trip of six months or more, any arrest, any tax or selective-service problem.",
    ],
    forms: [{ id: "n-400", who: "principal", required: true }],
    also: ["N-648 where a disability exception to the English or civics requirement applies — not tracked here."],
    later: [],
    g28s: [{ who: "principal", capacity: "applicant", covers: ["n-400"] }],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },

  {
    id: "fiance_k1",
    name: "Fiancé(e) petition",
    short: "I-129F, then adjustment after the marriage",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: "petitioner",
    summary: "The petition now; the adjustment package only after the marriage, and within the 90 days of K-1 admission.",
    conditions: [
      "Both parties are free to marry and have met in person within the two years before filing, or a waiver ground applies.",
      "The marriage must take place within 90 days of the K-1 entry.",
    ],
    forms: [{ id: "i-129f", who: "petitioner", required: true }],
    also: ["Consular processing follows approval; the beneficiary is interviewed abroad."],
    later: [
      { what: "I-485 with I-765 and I-131", when: "after the marriage, once the K-1 has entered",
        note: "A K-1 who married the petitioner adjusts without a new I-130." },
    ],
    g28s: [{ who: "petitioner", capacity: "petitioner", covers: ["i-129f"] }],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },

  {
    id: "provisional_waiver",
    name: "Provisional unlawful presence waiver",
    short: "I-601A, after the I-130 is approved",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: "applicant",
    summary: "Not a package so much as a sequence: the petition, then the waiver, then the consular interview.",
    conditions: [
      "An approved immigrant visa petition and a DOS immigrant visa case with the processing fee paid.",
      "Unlawful presence is the ONLY ground of inadmissibility in play — the I-601A waives nothing else.",
      "Extreme hardship to a qualifying relative, who is not the same set of people as the beneficiary's relatives generally.",
    ],
    forms: [{ id: "i-601a", who: "principal", required: true }],
    also: ["The hardship evidence is the case. The form is the smallest part of this filing."],
    later: [{ what: "Consular interview abroad", when: "after the provisional waiver is approved" }],
    g28s: [{ who: "principal", capacity: "applicant", covers: ["i-601a"] }],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },

  {
    id: "waiver_i601",
    name: "Waiver of inadmissibility",
    short: "I-601",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: "applicant",
    summary: "The general waiver, for grounds the provisional waiver does not reach.",
    conditions: [
      "Identify every ground of inadmissibility that applies — the I-601 does not waive all of them, and some are not waivable at all.",
      "A qualifying relative is needed for most grounds, and who qualifies differs by ground.",
    ],
    forms: [{ id: "i-601", who: "principal", required: true }],
    also: [],
    later: [],
    g28s: [{ who: "principal", capacity: "applicant", covers: ["i-601"] }],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },

  {
    id: "replace_green_card",
    name: "Replacing a permanent resident card",
    short: "I-90",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: "applicant",
    summary: "One form. A conditional card nearing its end is an I-751, not this.",
    conditions: [
      "A card expiring at the end of a two-year conditional residence is removed with an I-751, not replaced with an I-90.",
    ],
    forms: [{ id: "i-90", who: "principal", required: true }],
    also: [],
    later: [],
    g28s: [{ who: "principal", capacity: "applicant", covers: ["i-90"] }],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },

  {
    id: "fee_waiver",
    name: "Fee waiver (added to another package)",
    short: "I-912",
    matter_type: "immigration_family",
    before: "USCIS",
    capacity: null,
    addon: true,
    summary: "Not a package of its own. It rides along with whichever filing it covers.",
    conditions: [
      "Not every form is fee-waivable. Check the form against USCIS's list before relying on it.",
      "One I-912 can cover several forms filed together, listed on the form.",
    ],
    forms: [{ id: "i-912", who: "principal", required: true }],
    also: [],
    later: [],
    g28s: [],
    derivatives: false,
    derivatives_note: "No derivatives on this filing.",
    per_person: [],
  },
];

const byId = new Map(PACKAGES.map((p) => [p.id, p]));

/** Every package, or the ones for a matter type. */
function list({ matterType = null, includeAddons = true } = {}) {
  return PACKAGES.filter((p) =>
    (includeAddons || !p.addon) &&
    (!matterType || p.matter_type === matterType));
}

function get(id) {
  return byId.get(String(id || "")) || null;
}

/** A form's registry entry, for its proper name. */
function formInfo(id) {
  return F().FORMS.find((f) => f.id === id) || null;
}

/**
 * What goes on the G-28's item 1.b for a package.
 *
 * `include` names the optional forms being filed; without it only the
 * required ones are listed, because a G-28 should not claim to cover a form
 * that is not in the envelope.
 */
function formNumbersFor(id, { include = [] } = {}) {
  const p = get(id);
  if (!p) return "";
  const chosen = p.forms.filter((f) => f.required || include.includes(f.id));
  return chosen.map((f) => f.id.toUpperCase()).join(", ");
}

/**
 * The plan: who files what, how many of each, and which G-28s are needed.
 *
 * `derivatives` is how many people are adjusting alongside the principal.
 * Each of them needs their own copy of the per-person forms AND their own
 * G-28 — a single G-28 covers one client, not a family.
 */
function planFor(id, { include = [], derivatives = 0, names = {} } = {}) {
  const p = get(id);
  if (!p) return null;

  const chosen = p.forms.filter((f) => f.required || include.includes(f.id));

  // A package where the category has no derivatives does not get its forms
  // multiplied, however many people are in the family. The immediate
  // relative category is the one that catches people out: a spouse's
  // children do not ride along, they need petitions of their own, and
  // printing three I-485s here would produce a package that cannot be
  // filed. The count asked for is reported back so the page can say so.
  const asked = Math.max(0, Number(derivatives) || 0);
  const extra = p.derivatives ? asked : 0;
  const refusedDerivatives = !p.derivatives && asked > 0;

  const rows = chosen.map((f) => {
    const info = formInfo(f.id);
    const copies = p.per_person.includes(f.id) ? 1 + extra : 1;
    return {
      id: f.id,
      label: f.id.toUpperCase(),
      title: info ? info.name : null,
      who: ROLES[f.who] || f.who,
      who_key: f.who,
      required: !!f.required,
      when: f.when || null,
      copies,
      per_person: p.per_person.includes(f.id),
    };
  });

  const skipped = p.forms
    .filter((f) => !f.required && !include.includes(f.id))
    .map((f) => ({ id: f.id, label: f.id.toUpperCase(), when: f.when || null }));

  // One G-28 per person appearing, plus one for each derivative who is
  // filing their own forms.
  const g28s = p.g28s.map((g) => ({
    who: ROLES[g.who] || g.who,
    who_key: g.who,
    capacity: g.capacity,
    covers: g.covers.filter((c) => chosen.some((f) => f.id === c)).map((c) => c.toUpperCase()),
    name: names[g.who] || null,
  })).filter((g) => g.covers.length);

  const derivativeG28s = extra > 0 && p.per_person.length ? extra : 0;

  return {
    package: { id: p.id, name: p.name, short: p.short, summary: p.summary, before: p.before, capacity: p.capacity },
    forms: rows,
    skipped,
    also: p.also || [],
    conditions: p.conditions || [],
    later: p.later || [],
    g28s,
    derivative_g28s: derivativeG28s,
    derivatives: {
      allowed: !!p.derivatives,
      counted: extra,
      asked,
      refused: refusedDerivatives,
      note: p.derivatives_note || null,
    },
    total_forms: rows.reduce((n, r) => n + r.copies, 0),
    form_numbers: chosen.map((f) => f.id.toUpperCase()).join(", "),
  };
}

/** Packages that use a form, for "what else does this go with". */
function packagesUsing(formId) {
  return PACKAGES.filter((p) => p.forms.some((f) => f.id === formId)).map((p) => p.id);
}

module.exports = { PACKAGES, ROLES, list, get, formNumbersFor, planFor, packagesUsing, formInfo };
