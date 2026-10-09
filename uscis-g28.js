// ============================================================
//  uscis-g28.js — the G-28, filled from the client record
//  ─────────────────────────────────────────────────────────
//  "Automatic prefill from clients info and onto any forms from USCIS."
//  "yes g28 first" (JJ, 2026-10-08)
//
//  The G-28 goes on every USCIS filing, so it is the form worth getting
//  right first, and it is the one where the field names lie.
//
//  WHY EVERY ENTRY CARRIES AN `expect`
//  A USCIS form's internal field names are left over from older editions
//  and do not match the printed item numbers, or in two places the printed
//  meaning:
//
//    the client's name    prints as items 6.a-6.c, fields Pt3Line5a/5b/5c
//    the client's address  prints as 13.a-13.h, fields Line12a-Line12h
//    appearance capacity   prints as item 5, five fields all called
//                          Line4_Checkbox, whose export values are /R for
//                          Requestor and /B for Respondent — so reading the
//                          letters puts a removal client in the wrong
//                          capacity on every filing
//    and worst            Line6_EMail is the MOBILE TELEPHONE box, while
//                          Line7_MobileTelephoneNumber is the EMAIL box.
//                          Trusting those names prints the attorney's email
//                          where the phone goes.
//
//  What does not lie is the /TU tooltip on each field: it holds the printed
//  label verbatim. So every entry below records the fragment of that label
//  it expects, scripts/check-uscis-g28.js asserts all of them against
//  forms/g-28.fields.json, and an edition that moves a box fails the build
//  instead of mailing a wrong form.
//
//  WHAT THIS WILL NOT FILL IN
//  Three kinds of box, on purpose:
//
//    1. Part 2, item 1.c — "I am / am not subject to any order suspending
//       or restraining me from practice". That is the attorney's own
//       attestation on the day they sign, not a stored field, and no script
//       should ever tick it.
//    2. Every signature and signature date, in Parts 4 and 5, and the
//       client's Part 4 elections about where USCIS sends notices. Those
//       are the client's choices and the signer's act.
//    3. Anything it had to guess. An address it cannot parse cleanly is
//       left entirely blank with the reason, rather than half-filled —
//       a street in the city box is harder to catch than an empty box.
//
//  AND IT IS NOT THE FORM FOR IMMIGRATION COURT
//  An appearance before an Immigration Judge or the BIA is Form EOIR-28.
//  The G-28 covers USCIS, ICE and CBP. The agency boxes here default to
//  USCIS and nothing picks ICE or CBP on its own.
// ============================================================

const fs = require("fs");
const path = require("path");

const FORM_ID = "g-28";

/**
 * The edition this map was built and checked against.
 *
 * Not decoration: check-uscis-g28.js refuses to pass if the vendored blank
 * is a different edition, because a new edition renumbers and renames boxes
 * and a stale map puts the right answer in the wrong one. When USCIS moves
 * the G-28, uscis-watch.js says so the day it happens; re-run
 * scripts/uscis-form-prep.js, read the new labels, fix the map, then change
 * this line.
 *
 * As of 2026-10-08 this is 09/17/18 and its OMB control number expired
 * 05/31/2021 — that is what USCIS serves at its own canonical URL.
 */
const EDITION = "09/17/18";
const BLANK = path.join(__dirname, "forms", `${FORM_ID}.pdf`);
const DUMP = path.join(__dirname, "forms", `${FORM_ID}.fields.json`);

const P1 = "form1[0].#subform[0].";
const P3 = "form1[0].#subform[1].";
const P6 = "form1[0].#subform[3].";

/**
 * The map. One entry per box we fill.
 *
 *   key     what the caller supplies
 *   field   the PDF field name
 *   expect  a fragment of the field's printed label (its /TU tooltip),
 *           asserted by the check — this is what pins the map to the form
 *   on      for a checkbox: the export value to set
 */
const MAP = [
  // ── Part 1: the attorney ─────────────────────────────────
  { key: "attorney.uscis_online_account", field: P1 + "#area[0].Pt1Line1_USCISOnlineAcctNumber[0]", expect: "1. Enter U S C I S Online Account Number" },
  { key: "attorney.family_name",   field: P1 + "Pt1Line2a_FamilyName[0]", expect: "2. A. Enter Family Name" },
  { key: "attorney.given_name",    field: P1 + "Pt1Line2b_GivenName[0]",  expect: "2. B. Enter Given Name" },
  { key: "attorney.middle_name",   field: P1 + "Pt1Line2c_MiddleName[0]", expect: "2. C. Enter Middle Name" },
  { key: "attorney.street",        field: P1 + "Line3a_StreetNumber[0]",  expect: "3. A. Enter Street Number and Name" },
  { key: "attorney.unit_number",   field: P1 + "Line3b_AptSteFlrNumber[0]", expect: "3. B. Enter Apartment, Suite or Floor Number" },
  { key: "attorney.unit_apartment", field: P1 + "Line3b_Unit[2]", expect: "3. B. Select Apartment", checkbox: true },
  { key: "attorney.unit_suite",    field: P1 + "Line3b_Unit[0]", expect: "3. B. Select Suite", checkbox: true },
  { key: "attorney.unit_floor",    field: P1 + "Line3b_Unit[1]", expect: "3. B. Select Floor", checkbox: true },
  { key: "attorney.city",          field: P1 + "Line3c_CityOrTown[0]", expect: "3.C. Enter City or Town" },
  { key: "attorney.state",         field: P1 + "Line3d_State[0]", expect: "3. D. Select State", dropdown: true },
  { key: "attorney.zip",           field: P1 + "Line3e_ZipCode[0]", expect: "3. E. Enter Zip Code" },
  { key: "attorney.daytime_phone", field: P1 + "Line4_DaytimeTelephoneNumber[0]", expect: "4. Enter Daytime Telephone Number" },
  // The two swapped ones. The names are backwards; the labels are not.
  { key: "attorney.mobile_phone",  field: P1 + "Line6_EMail[0]", expect: "5. Enter Mobile Telephone Number" },
  { key: "attorney.email",         field: P1 + "Line7_MobileTelephoneNumber[0]", expect: "6. Enter Email Address" },
  { key: "attorney.fax",           field: P1 + "Pt1ItemNumber7_FaxNumber[0]", expect: "7. Enter Fax Number" },

  // ── Part 2: eligibility ──────────────────────────────────
  // 1.a is the attorney's standing: the bar that admitted them, their
  // number and their firm. Stable facts the firm configures once.
  { key: "attorney.is_attorney",        field: P1 + "CheckBox1[0]", expect: "1. A. Select I am an attorney eligible to practice law in", checkbox: true },
  { key: "attorney.licensing_authority", field: P1 + "Pt2Line1a_LicensingAuthority[0]", expect: "1. A. Enter Licensing Authority" },
  { key: "attorney.bar_number",         field: P1 + "Pt2Line1b_BarNumber[0]", expect: "1. B. Enter Bar Number" },
  { key: "attorney.firm_name",          field: P1 + "Pt2Line1d_NameofFirmOrOrganization[0]", expect: "1. D. Enter Name of Law Firm or Organization" },

  // ── Part 3: before whom, in what capacity, for whom ──────
  { key: "matter.before_uscis",   field: P3 + "Line1a_USCIS[0]", expect: "Select U.S. Citizenship and Immigration Services", checkbox: true },
  { key: "matter.form_numbers",   field: P3 + "Line1b_ListFormNumber[0]", expect: "1. B. List the form numbers" },
  { key: "matter.receipt_number", field: P3 + "Pt3Line4_ReceiptNumber[0]", expect: "4. Enter Receipt Number" },

  { key: "matter.as_applicant",   field: P3 + "Line4_Checkbox[1]", expect: "Select Applicant", checkbox: true },
  { key: "matter.as_petitioner",  field: P3 + "Line4_Checkbox[3]", expect: "Select Petitioner", checkbox: true },
  { key: "matter.as_requestor",   field: P3 + "Line4_Checkbox[0]", expect: "Select Requestor", checkbox: true },
  { key: "matter.as_beneficiary", field: P3 + "Line4_Checkbox[4]", expect: "Select Beneficiary / Derivative", checkbox: true },
  { key: "matter.as_respondent",  field: P3 + "Line4_Checkbox[2]", expect: "Select Respondent", checkbox: true },

  { key: "client.family_name",  field: P3 + "Pt3Line5a_FamilyName[0]", expect: "6. A. Enter Family Name" },
  { key: "client.given_name",   field: P3 + "Pt3Line5b_GivenName[0]",  expect: "6. B. Enter Given Name" },
  { key: "client.middle_name",  field: P3 + "Pt3Line5c_MiddleName[0]", expect: "6. C. Enter Middle Name" },
  { key: "client.entity_name",  field: P3 + "Pt3Line7a_NameOfEntity[0]", expect: "7. A. Enter Name of Entity" },
  { key: "client.entity_title", field: P3 + "Pt3Line7b_TitleofEntity[0]", expect: "7. B. Enter Title of Authorized Signatory" },
  { key: "client.uscis_online_account", field: P3 + "#area[1].Pt3Line8_USCISOnlineAcctNumber[0]", expect: "8. Enter" },
  { key: "client.a_number",     field: P3 + "Pt3Line9_ANumber[0]", expect: "9. Enter" },
  { key: "client.daytime_phone", field: P3 + "Line9_DaytimeTelephoneNumber[0]", expect: "10. Enter Daytime Telephone Number" },
  { key: "client.mobile_phone", field: P3 + "Line10_MobileTelephoneNumber[0]", expect: "11. Enter Mobile Telephone Number" },
  { key: "client.email",        field: P3 + "Line11_EMail[0]", expect: "12. Enter Email Address" },
  { key: "client.street",       field: P3 + "Line12a_StreetNumberName[0]", expect: "Provide the client's mailing address" },
  { key: "client.unit_number",  field: P3 + "Line12b_AptSteFlrNumber[0]", expect: "13. B. Enter Apartment, Suite or Floor Number" },
  { key: "client.unit_apartment", field: P3 + "Line12b_Unit[2]", expect: "13. B. Select Apartment", checkbox: true },
  { key: "client.unit_suite",   field: P3 + "Line12b_Unit[0]", expect: "13. B. Select Suite", checkbox: true },
  { key: "client.unit_floor",   field: P3 + "Line12b_Unit[1]", expect: "13. B. Select Floor", checkbox: true },
  { key: "client.city",         field: P3 + "Line12c_CityOrTown[0]", expect: "13. C. Enter City or Town" },
  { key: "client.state",        field: P3 + "Line12d_State[0]", expect: "13. D. Select State", dropdown: true },
  { key: "client.zip",          field: P3 + "Line12e_ZipCode[0]", expect: "13. E. Enter Zip Code" },

  // ── Part 6: the header USCIS asks to be repeated ─────────
  { key: "client.family_name",  field: P6 + "Pt3Line5a_FamilyName[1]", expect: "pre-populated from Part 3" },
  { key: "client.given_name",   field: P6 + "Pt3Line5b_GivenName[1]",  expect: "pre-populated from Part 3" },
  { key: "client.middle_name",  field: P6 + "Pt3Line5c_MiddleName[1]", expect: "pre-populated from Part 3" },
];

/**
 * Boxes this never touches, and why. Asserted by the check, so a later
 * edit cannot quietly add one of them to MAP.
 */
const NEVER_FILL = [
  { field: P1 + "Checkbox1dAmNot[0]", why: "the attorney attests to this when they sign, on the day they sign" },
  { field: P1 + "Checkbox1dAm[0]",    why: "the attorney attests to this when they sign, on the day they sign" },
  { field: P1 + "CheckBox2[0]",       why: "accredited-representative status — not an attorney's box" },
  { field: P1 + "CheckBox3[0]",       why: "association with another representative is a case-by-case fact" },
  { field: P1 + "CheckBox4[0]",       why: "law student or law graduate supervision — not an attorney's box" },
  { field: "form1[0].#subform[2].Line1_Signature[0]",            why: "the attorney signs this themselves, in Part 5" },
  { field: "form1[0].#subform[2].Line2_SignatureStudent[0]",     why: "a law student signs this themselves" },
  { field: "form1[0].#subform[2].Line3_Date[0]",                 why: "the date a person signed, which is the day they sign" },
  { field: "form1[0].#subform[2].Pt5Line2b_DateofSignature[0]",  why: "the date a person signed, which is the day they sign" },
  { field: "form1[0].#subform[2].Pt4Line2b_DateofSignature[0]",  why: "the date a person signed, which is the day they sign" },
  { field: "form1[0].#subform[2].P5_Line6a_SignatureofApplicant[0]", why: "the client signs their own consent, in Part 4" },
  { field: "form1[0].#subform[2].Pt4Line2a_CheckBox2a[0]", why: "the client chooses where USCIS sends their notices" },
  { field: "form1[0].#subform[2].Pt4Line2b_CheckBox2b[0]", why: "the client chooses where USCIS sends their notices" },
  { field: "form1[0].#subform[2].Pt4Line2c_CheckBox2c[0]", why: "the client chooses where USCIS sends their notices" },
  { field: P3 + "Line2a_ICE[0]",  why: "appearing before ICE is a deliberate choice, never a default" },
  { field: P3 + "Line3a_CBP[0]",  why: "appearing before CBP is a deliberate choice, never a default" },
];

// The capacity a client appears in. Printed as item 5; one box only.
const CAPACITIES = {
  applicant:   "matter.as_applicant",
  petitioner:  "matter.as_petitioner",
  requestor:   "matter.as_requestor",
  beneficiary: "matter.as_beneficiary",
  respondent:  "matter.as_respondent",
};

// ── reading the client record into form shapes ──────────────

const trim = (v) => (v == null ? "" : String(v).trim());

/** Digits only, which is what every USCIS phone box wants. */
function phone(v) {
  const d = trim(v).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

/** The A-Number without its "A" — the form prints that itself. */
function aNumber(v) {
  const d = trim(v).replace(/\D/g, "");
  return d.length >= 8 && d.length <= 9 ? d : "";
}

/**
 * Split a stored name into the form's three boxes.
 *
 * The firm records names as the courts write them, "Chen, Xifen". Without a
 * comma there is no way to know which part is the family name — "Michael
 * Liu" and a Chinese name written family-first look identical — so the
 * guess is made but flagged, and the review page says so. A G-28 with the
 * names swapped is filed under the wrong person.
 */
function splitName(v) {
  const s = trim(v);
  if (!s) return { family: "", given: "", middle: "", sure: true };
  if (s.includes(",")) {
    const [fam, rest = ""] = s.split(",");
    const parts = trim(rest).split(/\s+/).filter(Boolean);
    return { family: trim(fam), given: parts[0] || "", middle: parts.slice(1).join(" "), sure: true };
  }
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { family: parts[0], given: "", middle: "", sure: false };
  return {
    family: parts[parts.length - 1],
    given: parts[0],
    middle: parts.slice(1, -1).join(" "),
    sure: false,
  };
}

const UNIT = /\b(apt\.?|apartment|ste\.?|suite|fl\.?|flr\.?|floor|unit|#)\s*([A-Za-z0-9-]+)\b/i;
const US_TAIL = /^(.*?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;

/**
 * Pull a one-line address apart into the form's boxes.
 *
 * Only a clean "street, city, ST 12345" is accepted. Anything else returns
 * nothing at all, with the reason: a street name sitting in the city box
 * reads as filled-in and gets signed, where an empty address does not.
 */
function splitAddress(v) {
  const s = trim(v).replace(/\s+/g, " ");
  if (!s) return { ok: false, why: "no address on file" };
  const m = US_TAIL.exec(s);
  if (!m) {
    return { ok: false, why: `could not read "${s}" as street, city, ST ZIP — fill the address in by hand` };
  }
  let street = trim(m[1]);
  let unit_kind = null, unit_number = "";
  const u = UNIT.exec(street);
  if (u) {
    const w = u[1].toLowerCase();
    unit_kind = /^a/.test(w) ? "apartment" : /^s/.test(w) ? "suite" : /^(f|#)/.test(w) ? "floor" : null;
    if (w === "#") unit_kind = null;            // "#4" does not say which
    unit_number = u[2];
    street = trim(street.slice(0, u.index) + street.slice(u.index + u[0].length)).replace(/,\s*$/, "");
  }
  return { ok: true, street, unit_kind, unit_number, city: trim(m[2]), state: m[3].toUpperCase(), zip: m[4] };
}

/**
 * Which capacity a matter puts the client in, as a SUGGESTION.
 *
 * Returned for the review page to show; never applied without the caller
 * passing it back. A petition filed by a relative has a petitioner and a
 * beneficiary and only the file says which one is ours.
 */
function suggestCapacity(caseType) {
  const t = trim(caseType).toLowerCase();
  if (!t) return null;
  if (/i-130|i-140|i-129f|i-129|petition/.test(t)) return "petitioner";
  if (/asylum|i-589|adjust|i-485|i-765|i-131|natural|n-400|n-600|i-751|waiver|i-601/.test(t)) return "applicant";
  if (/bond|custody|detain|removal|deportation/.test(t)) return "respondent";
  return null;
}

// ── the proposal ────────────────────────────────────────────

/**
 * Everything the form would be filled with, and where each value came from.
 * No PDF yet: this is the page a person reads before anything is produced.
 *
 * `client` is a client-profiles aggregate. `attorney` is a key into
 * firm-attorneys.js. `matter` carries the case-specific answers a client
 * record cannot supply: the form numbers, the receipt number, the capacity.
 */
function proposeG28({ client = {}, attorney: attorneyKey = null, matter = {} } = {}) {
  const A = require("./firm-attorneys").attorney(attorneyKey);
  const values = {};
  const sources = {};
  const notes = [];
  const put = (key, value, from) => {
    const v = trim(value);
    if (!v) return;
    values[key] = v;
    sources[key] = from;
  };

  if (!A) {
    notes.push({ level: "stop", text: `no attorney on file for "${attorneyKey}" — pick one before filling the form` });
    return { form: "G-28", values, sources, notes, capacity: null, attorney: null };
  }

  // ── the attorney ──
  const ad = A.address || {};
  put("attorney.family_name", A.family_name, "attorney record");
  put("attorney.given_name", A.given_name, "attorney record");
  put("attorney.middle_name", A.middle_name, "attorney record");
  put("attorney.street", ad.street, "attorney record");
  put("attorney.unit_number", ad.unit_number, "attorney record");
  if (ad.unit_number && ad.unit_kind) put(`attorney.unit_${ad.unit_kind}`, "on", "attorney record");
  put("attorney.city", ad.city, "attorney record");
  put("attorney.state", ad.state, "attorney record");
  put("attorney.zip", ad.zip, "attorney record");
  put("attorney.daytime_phone", phone(A.daytime_phone), "attorney record");
  put("attorney.mobile_phone", phone(A.mobile_phone), "attorney record");
  put("attorney.email", A.email, "attorney record");
  put("attorney.fax", phone(A.fax), "attorney record");
  put("attorney.uscis_online_account", A.uscis_online_account, "attorney record");
  put("attorney.is_attorney", "on", "attorney record");
  put("attorney.licensing_authority", A.licensing_authority, "attorney record");
  put("attorney.bar_number", A.bar_number, "attorney record");
  put("attorney.firm_name", A.firm_name, "attorney record");

  notes.push({
    level: "yours",
    text: "Part 2, item 1.c — whether you are subject to an order suspending or restraining you from practice — is left blank. That is yours to answer when you sign.",
  });

  // ── the client ──
  const name = splitName(client.client_name);
  put("client.family_name", name.family, "client file");
  put("client.given_name", name.given, "client file");
  put("client.middle_name", name.middle, "client file");
  if (!name.sure && (name.family || name.given)) {
    notes.push({
      level: "check",
      text: `"${trim(client.client_name)}" has no comma, so which part is the family name is a guess: read as family "${name.family}", given "${name.given}".`,
    });
  }

  const an = aNumber(client.a_number);
  put("client.a_number", an, "client file");
  if (trim(client.a_number) && !an) {
    notes.push({ level: "check", text: `"${trim(client.a_number)}" is not 8 or 9 digits, so the A-Number box is blank.` });
  }

  put("client.daytime_phone", phone(client.client_phone), "client file");
  put("client.email", client.client_email, "client file");

  const addr = splitAddress(client.client_address);
  if (addr.ok) {
    put("client.street", addr.street, "client file");
    put("client.city", addr.city, "client file");
    put("client.state", addr.state, "client file");
    put("client.zip", addr.zip, "client file");
    if (addr.unit_number) {
      put("client.unit_number", addr.unit_number, "client file");
      if (addr.unit_kind) put(`client.unit_${addr.unit_kind}`, "on", "client file");
      else notes.push({ level: "check", text: `the address says unit "${addr.unit_number}" but not whether it is an apartment, a suite or a floor — tick the right box.` });
    }
  } else {
    notes.push({ level: "check", text: `Client's mailing address (item 13) is blank: ${addr.why}` });
  }
  notes.push({
    level: "note",
    text: "Item 13 must be the client's own mailing address, not the office — USCIS says so on the form.",
  });

  // ── the matter ──
  // USCIS is the default and the only agency filled in. ICE and CBP are
  // deliberate choices; an appearance before an Immigration Judge is an
  // EOIR-28, not this form.
  put("matter.before_uscis", "on", "USCIS is the default for this form");
  put("matter.form_numbers", matter.form_numbers, "you typed it");
  put("matter.receipt_number", matter.receipt_number, "you typed it");
  if (!trim(matter.form_numbers)) {
    notes.push({ level: "check", text: "Item 1.b (which forms this appearance covers) is blank — USCIS needs it." });
  }

  const suggested = suggestCapacity(matter.case_type || (client.case_types || [])[0]);
  const chosen = trim(matter.capacity).toLowerCase();
  if (chosen && CAPACITIES[chosen]) {
    put(CAPACITIES[chosen], "on", "you chose it");
  } else {
    notes.push({
      level: "check",
      text: suggested
        ? `Item 5 (the capacity the client appears in) is not set. From the case type it looks like "${suggested}" — confirm it.`
        : "Item 5 (the capacity the client appears in) is not set, and the case type does not say.",
    });
  }

  return {
    form: "G-28",
    attorney: { key: A.key, name: `${A.given_name} ${A.family_name}`, bar: `${A.licensing_authority} Bar #${A.bar_number}` },
    capacity: chosen && CAPACITIES[chosen] ? chosen : null,
    suggested_capacity: suggested,
    values, sources, notes,
  };
}

/**
 * What a person typed, over what the record proposed.
 *
 * "there are no places to edit information after it pulls data." (JJ,
 * 2026-10-09) The first version of the review page showed every value and
 * let four of them be changed, which is a review screen pretending to be
 * a form: an address that did not parse, or a name that came across
 * backwards, had nowhere to be corrected.
 *
 * `body` is the posted form, with one entry per mapped key under the "f:"
 * prefix. Every key present is taken from the person, including the ones
 * they cleared: an empty box means "leave this blank on the form", not
 * "fall back to the client record", or a value they deleted would come
 * straight back.
 *
 * A checkbox posts nothing when it is off, so the form also carries a
 * hidden list of which boxes were on the page. Without it, an unticked box
 * is indistinguishable from a field the page never showed.
 */
function applyEdits(proposal, body = {}) {
  const shown = String(body.__shown || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!shown.length) return proposal;

  const values = { ...proposal.values };
  const sources = { ...proposal.sources };

  for (const key of shown) {
    const raw = body["f:" + key];
    const was = proposal.values[key];
    const now = raw == null ? "" : String(raw).trim();

    if (!now) {
      delete values[key];
      delete sources[key];
      // Only say a person cleared it if there was something to clear.
      if (was) sources[key] = undefined;
      continue;
    }
    values[key] = now;
    sources[key] = now === was ? (proposal.sources[key] || null) : "you typed it";
  }
  for (const k of Object.keys(sources)) if (sources[k] === undefined) delete sources[k];

  // One box only in item 5. A person who ticks a second capacity gets the
  // one they just chose, not both, because the form says "select only one".
  const caps = Object.values(CAPACITIES).filter((k) => values[k]);
  if (caps.length > 1) {
    const chosen = String(body.capacity || "").toLowerCase();
    const keep = CAPACITIES[chosen] || caps[caps.length - 1];
    for (const k of caps) if (k !== keep) { delete values[k]; delete sources[k]; }
  }

  const capKey = Object.entries(CAPACITIES).find(([, k]) => values[k]);
  return {
    ...proposal,
    values, sources,
    capacity: capKey ? capKey[0] : null,
    edited: true,
  };
}

// ── filling the PDF ─────────────────────────────────────────

/** What the vendored blank says about itself. */
function blankInfo() {
  const j = JSON.parse(fs.readFileSync(DUMP, "utf8"));
  return { edition: j.edition, omb: j.omb, omb_expires: j.omb_expires, prepared_on: j.prepared_on, fields: j.fields };
}

/**
 * Fill the form from a proposal.
 *
 * Returns the PDF bytes and an account of what went where, so the review
 * page and the filled form cannot disagree.
 *
 * MaxLength is cleared on every box written. The lengths left in this
 * form's AcroForm are leftovers from the stripped XFA layer and are wrong
 * in places — the email box says 10 characters — so pdf-lib would refuse a
 * real email address. A value longer than the printed box is likely to hold
 * comes back as a warning instead.
 */
async function fillG28(proposal, { flatten = false } = {}) {
  const { PDFDocument } = require("pdf-lib");
  const bytes = fs.readFileSync(BLANK);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const form = doc.getForm();

  const filled = [];
  const warnings = [];
  const info = blankInfo();
  const maxOf = new Map(info.fields.map((f) => [f.name, f.max || null]));

  for (const entry of MAP) {
    const v = proposal.values[entry.key];
    if (v == null || v === "") continue;
    let f;
    try { f = form.getField(entry.field); } catch {
      warnings.push(`${entry.field} is not on this edition of the form — the field map needs re-checking`);
      continue;
    }
    try {
      if (entry.checkbox) {
        f.check();
      } else if (entry.dropdown) {
        const opts = f.getOptions();
        if (!opts.includes(v)) {
          warnings.push(`"${v}" is not one of the choices for ${entry.key} — left blank`);
          continue;
        }
        f.select(v);
      } else {
        const max = maxOf.get(entry.field);
        if (max && v.length > max) {
          warnings.push(`${entry.key} is ${v.length} characters and the box is drawn for about ${max} — check it prints`);
        }
        if (typeof f.setMaxLength === "function") f.setMaxLength(undefined);
        f.setText(v);
      }
      filled.push({ key: entry.key, field: entry.field, value: v, from: proposal.sources[entry.key] || null });
    } catch (err) {
      warnings.push(`could not write ${entry.key}: ${err.message}`);
    }
  }

  if (flatten) form.flatten();
  const out = await doc.save({ updateFieldAppearances: true });
  return { bytes: Buffer.from(out), filled, warnings, edition: info.edition, flattened: !!flatten };
}

module.exports = {
  FORM_ID, EDITION, BLANK, DUMP, MAP, NEVER_FILL, CAPACITIES,
  proposeG28, applyEdits, fillG28, blankInfo,
  phone, aNumber, splitName, splitAddress, suggestCapacity,
};
