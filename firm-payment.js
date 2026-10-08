// ============================================================
//  firm-payment.js — how the firm is paid, and where the
//                    account details live
//  ─────────────────────────────────────────────────────────
//  THE DETAILS ARE NOT IN THIS FILE, AND MUST NOT BE.
//
//  This repository is on GitHub. An account number committed here is in
//  the history for good, readable by anyone who ever gets the repo, and
//  not removable by editing the file later. So the values come from
//  outside: the environment first, then firm-payment.local.json, which
//  .gitignore keeps out of the repository.
//
//  Two ways to set them on Render:
//    • Environment: Settings → Environment, one TEZ_PAY_* variable each
//    • Secret File: Settings → Secret Files, upload firm-payment.local.json
//
//  TWO ACCOUNTS, AND WHICH ONE A CLIENT PAYS INTO
//  The firm's payment instruction carries both an operating account and
//  a client trust account. Which one a retainer goes to is not a matter
//  of taste:
//
//    Rule 1.15(a)  funds received for the benefit of a client go into
//                  the trust account
//    Rule 1.15(b)  a flat fee MAY go to the operating account, but only
//                  with the client's written agreement, and above $1,000
//                  that agreement must be signed
//
//  The agreement already collects that consent (`operating_account_consent`,
//  the box the drafter ticks and the client initials). So the account
//  printed on the payment page follows it: trust by default, operating
//  only where the client has agreed in the document they are signing.
//  Getting that backwards is a trust-accounting violation, which is why
//  it is decided here rather than by whoever fills in a template.
//
//  TWO ROUTING NUMBERS
//  Bank of America uses a different routing number for ACH than for
//  wires. Printing one where the other belongs bounces the payment, so
//  both are carried and both are labelled.
//
//  WHY THE WARNING ON THE PAGE EXISTS
//  Wire fraud against law firm trust accounts works like this: someone
//  reading the client's or the firm's email waits for the engagement and
//  sends the client revised instructions from an address one character
//  different from the real one. The client wires to the attacker. It is
//  common enough that several bars advise never sending wire details by
//  email at all.
//
//  JJ's instruction (2026-10-08): the details go in the agreement, with
//  a warning banner. The banner carries the one thing that defeats the
//  attack — telephone a number you already had, and confirm before
//  sending anything.
// ============================================================

const fs = require("fs");
const path = require("path");

// field -> environment variable. The JSON file uses the field names.
const FIELDS = {
  bank: "TEZ_PAY_BANK",
  trust_name: "TEZ_PAY_TRUST_NAME",
  trust_account: "TEZ_PAY_TRUST_ACCOUNT",
  operating_name: "TEZ_PAY_OPERATING_NAME",
  operating_account: "TEZ_PAY_OPERATING_ACCOUNT",
  routing_ach: "TEZ_PAY_ROUTING_ACH",
  routing_wire: "TEZ_PAY_ROUTING_WIRE",
  swift_usd: "TEZ_PAY_SWIFT_USD",
  swift_fx: "TEZ_PAY_SWIFT_FX",
  bank_address_usd: "TEZ_PAY_BANK_ADDRESS_USD",
  bank_address_fx: "TEZ_PAY_BANK_ADDRESS_FX",
  zelle: "TEZ_PAY_ZELLE",
  reference: "TEZ_PAY_REFERENCE",
};

const LOCAL_FILES = [
  path.join(__dirname, "firm-payment.local.json"),
  "/etc/secrets/firm-payment.local.json",   // Render puts Secret Files here
];

let cached = null;

function fromFile() {
  for (const f of LOCAL_FILES) {
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (err) {
      // A malformed file must not take the server down, and must not be
      // silently treated as "no details configured" either.
      console.warn(`[firm-payment] ${f} could not be read: ${err.message}`);
    }
  }
  return {};
}

/**
 * The details, or blanks.
 *
 * Never throws and never guesses: an unset field comes back as "", and
 * the page says so rather than printing something that looks like an
 * account number.
 */
function paymentDetails({ fresh = false } = {}) {
  if (!cached || fresh) {
    const file = fromFile();
    const out = {};
    for (const [key, env] of Object.entries(FIELDS)) {
      out[key] = String(process.env[env] || file[key] || "").trim();
    }
    cached = out;
  }
  return cached;
}

/** For tests, and for a settings screen that has just written the file. */
function reload() { cached = null; return paymentDetails({ fresh: true }); }

/**
 * The account a client should pay into for THIS agreement.
 *
 * Rule 1.15: trust, unless the client has agreed in writing that a flat
 * fee may go to the operating account. The agreement collects exactly
 * that consent, so the two cannot drift apart.
 */
function accountFor(a = {}, d = paymentDetails()) {
  const toOperating = !!a.operating_account_consent &&
    (a.structure === "flat" || a.structure === "hybrid");
  return toOperating
    ? { name: d.operating_name, number: d.operating_account, kind: "operating" }
    : { name: d.trust_name, number: d.trust_account, kind: "trust" };
}

/** True when enough is set to send a client to a bank with it. */
function isConfigured(d = paymentDetails()) {
  return !!(d.bank && d.trust_name && d.trust_account && d.routing_wire);
}

/** Which of them are missing, for the drafting screen to say so. */
function missingFields(d = paymentDetails()) {
  const optional = new Set(["swift_fx", "bank_address_fx", "zelle", "reference"]);
  return Object.entries(FIELDS)
    .filter(([key]) => !d[key] && !optional.has(key))
    .map(([, env]) => env);
}

/** The reference line, with the matter and client filled in. */
function referenceFor(a = {}, d = paymentDetails()) {
  // No dash: this prints on the payment page like everything else.
  const template = d.reference || "{client}, {matter}";
  return template
    .replace(/\{client\}/g, a.client_name || "")
    .replace(/\{matter\}/g, a.matter_label || "")
    .replace(/[\s,]+$/, "")
    .trim();
}

module.exports = {
  FIELDS, LOCAL_FILES, paymentDetails, reload, accountFor,
  isConfigured, missingFields, referenceFor,
};
