// ============================================================
//  firm-attorneys.js — who signs, and what their bar line says
//  ─────────────────────────────────────────────────────────
//  The firm's own attorney details, in one place, because they go on
//  government forms where a wrong bar number or a wrong licensing
//  authority is a rejected filing.
//
//  Until this file existed the bar number was typed into six other files
//  (hearing-forms.js four times, motion-generator.js twice,
//  matter-manager.js twice). Those are prompt strings and still carry their
//  own copies; anything that FILLS A FORM reads this.
//
//  WHAT IS NOT HERE
//  Nothing that changes. "Am I subject to an order suspending or
//  restraining me from practice" is a question the attorney answers on the
//  day they sign, not a stored field — see the header of uscis-g28.js.
// ============================================================

const ATTORNEYS = {
  jj: {
    key: "jj",
    family_name: "Zhang",
    given_name: "JJ",
    middle_name: "",
    title: "Founding Attorney",
    // Part 2, item 1.a of the G-28: the state whose bar admitted them. Not
    // "California State Bar" — the form asks for the licensing authority of
    // the highest court of the state.
    licensing_authority: "California",
    bar_number: "326666",
    firm_name: "Tez Law P.C.",
    email: "jj@tezlawfirm.com",
    daytime_phone: "6266788677",
    mobile_phone: "",
    fax: "",
    uscis_online_account: "",
    eoir_id: "",
    // Mailing address as it goes on a federal form: the office of record.
    address: {
      street: "4141 S. Nogales Street",
      unit_kind: "suite",            // "apartment" | "suite" | "floor" | null
      unit_number: "C102",
      city: "West Covina",
      state: "CA",
      zip: "91792",
      country: "",
    },
  },

  chandler: {
    key: "chandler",
    family_name: "Jin",
    given_name: "Chujun",
    middle_name: "",
    title: "Attorney",
    // Admitted in New York, not California. A G-28 signed by Chandler says
    // New York; putting California on it would be a false statement about
    // his admission.
    licensing_authority: "New York",
    bar_number: "6238398",
    firm_name: "Tez Law P.C.",
    email: "chandler.jin@tezlawfirm.com",
    daytime_phone: "6266788677",
    mobile_phone: "",
    fax: "",
    uscis_online_account: "",
    eoir_id: "",
    address: {
      street: "4141 S. Nogales Street",
      unit_kind: "suite",
      unit_number: "C102",
      city: "West Covina",
      state: "CA",
      zip: "91792",
      country: "",
    },
  },
};

const DEFAULT_ATTORNEY = "jj";

/** One attorney by key. Unknown key returns null rather than a default: a
 *  form filled for the wrong attorney is worse than a form not filled. */
function attorney(key) {
  if (!key) return ATTORNEYS[DEFAULT_ATTORNEY];
  return ATTORNEYS[String(key).toLowerCase()] || null;
}

/** For a picker. */
function list() {
  return Object.values(ATTORNEYS).map((a) => ({
    key: a.key,
    name: `${a.given_name} ${a.family_name}`,
    bar: `${a.licensing_authority} Bar #${a.bar_number}`,
  }));
}

module.exports = { ATTORNEYS, DEFAULT_ATTORNEY, attorney, list };
