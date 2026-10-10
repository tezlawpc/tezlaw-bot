// ============================================================
//  uscis-questions.js — a USCIS form as questions a person can answer
//  ─────────────────────────────────────────────────────────
//  "when filling out the form, it should be questionaire format with
//   explanation on the side to assist client to fill out the form."
//  (JJ, 2026-10-09)
//
//  WHY THIS IS NOT JUST THE FIELD LIST
//  A USCIS PDF's own field names are useless to a person
//  ("form1[0].#subform[0].Line6_EMail[0]" is the MOBILE number on the
//  G-28 -- see uscis-g28.js). The printed labels are better but they are
//  written for a filer who already knows the form: "9. Enter" is a real
//  label, and it means the A-Number.
//
//  So each question carries three things:
//    label    what to call it, in words a client reads
//    printed  where it sits on the paper, so the office can check it
//    help     what to actually put, and the mistake people make
//
//  The help text explains the FORM. It does not advise. "Put the number
//  from the top of your notice" is explaining a box; "you should file
//  this" is not, and does not belong in a questionnaire a client fills in
//  without a lawyer in the room.
//
//  AUDIENCE. A section is for the firm, the client, or both. The attorney
//  and firm details are the firm's own record and a client should see them
//  filled in and not be asked to type them. The capacity question and the
//  list of forms are the office's call, not the client's. Everything about
//  the client is the client's.
//
//  ONE SOURCE OF TRUTH. The keys, the field names and the printed labels
//  come from uscis-g28.js MAP, which is pinned to the PDF's own /TU
//  tooltips by check-uscis-g28.js. This file adds wording, never fields:
//  if a question here names a key the MAP does not have, the check fails.
// ============================================================

const G = require("./uscis-g28");

// ── Section order and wording ───────────────────────────────

const SECTIONS = [
  {
    id: "attorney",
    prefix: "attorney.",
    title: "Your attorney and the firm",
    audience: "firm",
    note: "Filled in from the firm's own record. Nothing here is for the client to type.",
  },
  {
    id: "matter",
    prefix: "matter.",
    title: "What this appearance covers",
    audience: "firm",
    note: "The two things the client record cannot answer: which forms this G-28 covers, "
        + "and the capacity the client appears in. Both are the office's call.",
  },
  {
    id: "client",
    prefix: "client.",
    title: "About you",
    audience: "client",
    note: "Your own details, as they appear on your immigration documents. "
        + "Where a box is already filled in, check it and correct it if it is wrong.",
  },
];

// ── What each box actually wants ────────────────────────────
//
// Keyed by the same keys as uscis-g28.js MAP. A key with no entry here
// still becomes a question; it just has no help beside it, which
// check-uscis-questions.js refuses for anything a client is asked.

const HELP = {
  // Part 1 and 2 — the attorney. The client never types these.
  "attorney.uscis_online_account": "The firm's USCIS online account number, if the firm has one. Twelve digits. Not the same as a receipt number.",
  "attorney.family_name": "The attorney's surname, spelled as it is with the State Bar.",
  "attorney.given_name": "The attorney's first name.",
  "attorney.middle_name": "Middle name, or leave empty.",
  "attorney.street": "The office street address. No suite number here, that goes in the next box.",
  "attorney.unit_number": "The suite or floor number on its own, without the word Suite.",
  "attorney.unit_apartment": "Tick only if the number above is an apartment.",
  "attorney.unit_suite": "Tick only if the number above is a suite.",
  "attorney.unit_floor": "Tick only if the number above is a floor.",
  "attorney.city": "The office city.",
  "attorney.state": "The office state, as a two-letter code.",
  "attorney.zip": "Five digits.",
  "attorney.daytime_phone": "Ten digits, no brackets or dashes. USCIS reads this box as digits.",
  "attorney.mobile_phone": "Ten digits, or leave empty. On this form the mobile box sits BEFORE the email box, "
    + "and the PDF's own field names for the two are the wrong way round, which is why this is filled by label and not by name.",
  "attorney.email": "The attorney's email. This is where USCIS sends notices, so a typo here loses correspondence.",
  "attorney.fax": "Ten digits, or leave empty.",
  "attorney.is_attorney": "Item 1.a. Ticked for an attorney. An accredited representative ticks 1.b instead, and this form will not do that for you.",
  "attorney.licensing_authority": "The state bar the attorney is admitted to, written out. Not an abbreviation.",
  "attorney.bar_number": "The bar number in that state.",
  "attorney.firm_name": "The firm as it is registered, not the trading name.",

  // Part 3 — the appearance. Office questions.
  "matter.before_uscis": "Ticked when the appearance is before USCIS. An appearance before the immigration court "
    + "or the BIA is a different form, the EOIR-28, and this one will not stand in for it.",
  "matter.form_numbers": "Item 1.b. The form numbers this appearance covers, separated by commas, for example "
    + "\"I-130, I-485\". Only what is actually going in the envelope: a G-28 that lists a form you do not file "
    + "puts the firm on the record for something that is not there.",
  "matter.receipt_number": "Item 4. The receipt number of the case already with USCIS, if there is one. "
    + "Three letters then ten digits, from the top of a notice. Leave empty for a new filing.",
  "matter.as_applicant": "Tick ONE capacity. Applicant is the person asking for the benefit, which is most "
    + "I-485, I-765, I-131 and N-400 filings.",
  "matter.as_petitioner": "Petitioner is the person or company asking on someone else's behalf, which is the "
    + "sponsor on an I-130 or the employer on an I-140.",
  "matter.as_requestor": "Requestor covers a request that is not an application or a petition, such as a "
    + "fee waiver on its own.",
  "matter.as_beneficiary": "Beneficiary is the person the petition is FOR. On the form this box reads "
    + "\"Beneficiary / Derivative\".",
  "matter.as_respondent": "Respondent is a person answering something brought against them. Rare on a USCIS "
    + "filing, and if you are in removal proceedings the court appearance is an EOIR-28, not this.",

  // Part 3 items 6 to 13 — the client. These are the ones a client answers.
  "client.family_name": "Your surname, exactly as it is on your passport or your notice from USCIS. "
    + "If your documents disagree with each other, use the one USCIS has been writing to you by, and tell the office.",
  "client.given_name": "Your first name, as on the same document.",
  "client.middle_name": "Your middle name if you have one on your documents. Leave empty if not.",
  "client.entity_name": "Only if the client is a company rather than a person. Leave empty for a person.",
  "client.entity_title": "Only for a company: the job title of the person signing for it.",
  "client.uscis_online_account": "Your own USCIS online account number, if you have one. Leave empty if not. "
    + "It is not your A-Number and not a receipt number.",
  "client.a_number": "Your A-Number, digits only. It is on your notice from USCIS or your work permit, "
    + "written as A- and then eight or nine digits. Type the digits without the A.",
  "client.daytime_phone": "A number we can reach you on during the day. Ten digits, no brackets or dashes.",
  "client.mobile_phone": "Your mobile, if it is different from the number above.",
  "client.email": "Your email. This is where the office will send things to sign, so use one you check.",
  "client.street": "Your street number and street name. Where you actually live or collect post. "
    + "USCIS sends decisions here, so it has to be somewhere you will get mail for the next year.",
  "client.unit_number": "Your apartment, suite or floor number on its own, without the word Apartment.",
  "client.unit_apartment": "Tick if the number above is an apartment.",
  "client.unit_suite": "Tick if the number above is a suite.",
  "client.unit_floor": "Tick if the number above is a floor.",
  "client.city": "Your city or town.",
  "client.state": "Your state, as a two-letter code.",
  "client.zip": "Five digits.",
};

// A box no questionnaire asks about, because nobody can answer it by
// typing. uscis-g28.js NEVER_FILL is the authority; these are the ones
// that would otherwise appear as questions.
function neverAsked() {
  const out = new Set();
  for (const n of G.NEVER_FILL) out.add(n.key || n.field || String(n));
  return out;
}

/**
 * The questions for a form, in sections.
 *
 * Returns null for a form whose blank is not vendored yet: there is no
 * field map to build questions from, and guessing one would produce a
 * questionnaire whose answers go nowhere.
 */
function questionsFor(formId) {
  const id = String(formId || "").toLowerCase();
  if (id !== "g-28") return null;

  const skip = neverAsked();
  const seen = new Set();
  const sections = [];

  for (const def of SECTIONS) {
    const questions = [];
    for (const m of G.MAP) {
      if (!m.key.startsWith(def.prefix)) continue;
      // The MAP carries the client's name twice -- once in Part 3 and
      // again where the later part is pre-populated from it. One question.
      if (seen.has(m.key)) continue;
      if (skip.has(m.key)) continue;
      seen.add(m.key);
      questions.push({
        key: m.key,
        section: def.id,
        audience: def.audience,
        label: labelFor(m),
        printed: String(m.expect || "").trim(),
        kind: m.checkbox ? "checkbox" : (m.dropdown ? "select" : "text"),
        help: HELP[m.key] || "",
        options: m.dropdown ? optionsFor(m) : null,
      });
    }
    if (questions.length) sections.push({ ...def, questions });
  }
  return { form_id: id, edition: G.EDITION, sections };
}

/** Every question, flat, in the order they are asked. */
function flatten(model) {
  if (!model) return [];
  return model.sections.reduce((all, s) => all.concat(s.questions), []);
}

/**
 * A short name for a box.
 *
 * Built from the key rather than the printed label, because the printed
 * labels are the form's own wording and some of them say nothing at all
 * ("9. Enter" is the A-Number). The printed label still rides along, so
 * the office can find the box on the paper.
 */
function labelFor(m) {
  const tail = m.key.split(".").slice(1).join(".");
  const words = {
    uscis_online_account: "USCIS online account number",
    family_name: "Family name (surname)",
    given_name: "Given name (first name)",
    middle_name: "Middle name",
    street: "Street address",
    unit_number: "Apartment, suite or floor number",
    unit_apartment: "That number is an apartment",
    unit_suite: "That number is a suite",
    unit_floor: "That number is a floor",
    city: "City or town",
    state: "State",
    zip: "ZIP code",
    daytime_phone: "Daytime telephone",
    mobile_phone: "Mobile telephone",
    email: "Email address",
    fax: "Fax number",
    is_attorney: "An attorney eligible to practice",
    licensing_authority: "Licensing authority (state bar)",
    bar_number: "Bar number",
    firm_name: "Law firm",
    before_uscis: "This appearance is before USCIS",
    form_numbers: "Forms this G-28 covers",
    receipt_number: "Receipt number",
    as_applicant: "Appearing as the Applicant",
    as_petitioner: "Appearing as the Petitioner",
    as_requestor: "Appearing as the Requestor",
    as_beneficiary: "Appearing as the Beneficiary or Derivative",
    as_respondent: "Appearing as the Respondent",
    entity_name: "Company name, if the client is a company",
    entity_title: "Title of the person signing for the company",
    a_number: "A-Number",
  };
  return words[tail] || tail.replace(/_/g, " ");
}

/**
 * The dropdown's own options, read off the blank rather than typed here.
 *
 * G.DUMP is an ABSOLUTE path, so it is read, not require()d by a relative
 * name. The first version did `require("./" + G.DUMP)`, which resolved to
 * nothing and silently returned no options -- a state dropdown with no
 * states in it, and no error to say so. Hence the check that the state
 * question has its fifty-odd options.
 */
let dumpCache = null;
function dump() {
  if (dumpCache === null) {
    try {
      dumpCache = JSON.parse(require("fs").readFileSync(G.DUMP, "utf8"));
    } catch {
      dumpCache = { fields: [] };
    }
  }
  return dumpCache;
}
function optionsFor(m) {
  const f = (dump().fields || []).find((x) => x.name === m.field);
  return f && Array.isArray(f.options) && f.options.length ? f.options : null;
}

module.exports = { SECTIONS, HELP, questionsFor, flatten, labelFor };
