/**
 * check-esign-copies.js
 *
 * Who gets a copy of a signed document, and what each of them is told.
 *
 * Two things were wrong, and both of them were one shared recipient list:
 *
 * 1. The firm's copy went to `admin_users.email` for whoever created the
 *    packet. JJ's admin record carries a personal Hotmail address, so every
 *    signed fee agreement, retainer and release the firm produced was being
 *    delivered into consumer webmail.
 *
 * 2. Because signers and the firm shared one list, they shared one letter —
 *    headed "Everyone has signed". A signer does not need to be told how the
 *    other parties behaved. On a document with an opposing party on it,
 *    telling one side that the other has signed is a disclosure about someone
 *    else that the firm never decided to make.
 *
 * There are now two letters to two audiences. These checks hold that apart,
 * and hold the firm copy at a firm address.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const P = require(path.join(ROOT, "esign-pdf.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const src = fs.readFileSync(path.join(ROOT, "esign-pdf.js"), "utf8");
const esign = fs.readFileSync(path.join(ROOT, "esign.js"), "utf8");

console.log("\nSigned-copy delivery\n");

// ── Where the firm's copy goes ─────────────────────────────

check("the firm copy defaults to a firm address, not a personal one", () => {
  const a = P.firmCopyAddress();
  assert.ok(a.endsWith("@" + P.FIRM_DOMAIN), `firm copy goes to ${a}`);
  assert.ok(!/hotmail|gmail|yahoo|outlook\.com|icloud|aol/i.test(a),
    "signed client documents must not be delivered to consumer webmail");
});

check("it is a setting, not a name baked into the code", () => {
  const before = process.env.ESIGN_FIRM_COPY_EMAIL;
  try {
    process.env.ESIGN_FIRM_COPY_EMAIL = "docket@tezlawfirm.com";
    assert.strictEqual(P.firmCopyAddress(), "docket@tezlawfirm.com");
  } finally {
    if (before === undefined) delete process.env.ESIGN_FIRM_COPY_EMAIL;
    else process.env.ESIGN_FIRM_COPY_EMAIL = before;
  }
});

check("a malformed setting falls back rather than handing junk to the mail server", () => {
  const before = process.env.ESIGN_FIRM_COPY_EMAIL;
  try {
    for (const bad of ["a@x.com, b@y.com", "not an address", "a@x.com\nbcc: c@z.com", ""]) {
      process.env.ESIGN_FIRM_COPY_EMAIL = bad;
      const a = P.firmCopyAddress();
      assert.ok(a.endsWith("@" + P.FIRM_DOMAIN), `${JSON.stringify(bad)} produced ${a}`);
      assert.ok(!/[\n,]/.test(a), "a header injection must not survive");
    }
  } finally {
    if (before === undefined) delete process.env.ESIGN_FIRM_COPY_EMAIL;
    else process.env.ESIGN_FIRM_COPY_EMAIL = before;
  }
});

check("the creator's address is used only when it is a firm address", () => {
  assert.ok(/endsWith\("@" \+ FIRM_DOMAIN\)/.test(src),
    "admin_users.email must be filtered by domain before it receives a client document");
});

// ── What each audience is told ─────────────────────────────

check("there are two letters, not one", () => {
  const signerLetter = src.indexOf("Your signed copy:");
  const firmLetter = src.indexOf("heading: \"Fully signed\"");
  assert.ok(signerLetter > -1, "no signer letter");
  assert.ok(firmLetter > -1, "no firm letter");
  assert.notStrictEqual(signerLetter, firmLetter);
});

check("a signer is never told that everyone has signed", () => {
  // The exact wording that was going out. It belongs in the firm letter or
  // nowhere.
  const signerBlock = src.slice(src.indexOf("for (const [address, name] of signers)"),
                                src.indexOf("const roll = p.signers"));
  assert.ok(signerBlock.length > 100, "the signer loop moved; this check needs updating");
  assert.ok(!/Everyone has signed/i.test(signerBlock));
  assert.ok(!/fully signed/i.test(signerBlock));
  assert.ok(!/all signature/i.test(signerBlock));
});

check("the signer letter still delivers the document and says what it is", () => {
  assert.ok(/Attached is your signed copy/.test(src));
  assert.ok(/certificate of signature on its last page/.test(src));
});

check("the signer letter does not name the other signers", () => {
  const signerBlock = src.slice(src.indexOf("for (const [address, name] of signers)"),
                                src.indexOf("const roll = p.signers"));
  assert.ok(!/p\.signers/.test(signerBlock),
    "the roll of signers belongs in the firm letter only");
});

check("the firm letter carries the roll of who signed and when", () => {
  assert.ok(/const roll = p\.signers/.test(src));
  assert.ok(/stampPT\(s\.signed_at\)/.test(src));
});

check("nobody receives both letters", () => {
  assert.ok(/for \(const a of firmTo\) signers\.delete\(a\)/.test(src),
    "a firm address that is also a signer would get two emails about one document");
});

// ── Both kinds of document send a copy ─────────────────────
// Uploaded PDFs went through esign-pdf's finalize and emailed copies.
// Documents generated from a template went through esign.js's own finalize,
// which never called emailCopies at all — so the one kind of document the
// firm drafts itself (the fee agreement) was the one the client never
// received a copy of.

check("a template-generated document emails copies too", () => {
  assert.ok(/emailCopies\(done, pdf\)/.test(esign),
    "esign.js finalize does not email the signed copy");
  assert.ok(/p\.email_copies !== false/.test(esign),
    "and it must honour the per-packet email_copies flag");
});

check("a mail failure does not lose the signed document", () => {
  // The PDF is written to the packet after the copies are attempted, and the
  // attempt is wrapped: a bounced client address must not leave the firm
  // without the signed file.
  const i = esign.indexOf("copies = await require(\"./esign-pdf\").emailCopies");
  assert.ok(i > -1);
  const after = esign.slice(i);
  assert.ok(/catch \(e\) \{ errors\.push\("signed copies were not emailed/.test(after));
  assert.ok(after.indexOf("UPDATE esign_packets SET signed_pdf") > -1,
    "the signed PDF is still saved after the copies are attempted");
});

check("a failure to email is recorded on the packet, not swallowed", () => {
  assert.ok(/finalize_error/.test(esign));
  assert.ok(/copies_sent/.test(esign), "and a success is logged as an event");
});

// ── Addresses are not interpolated blindly ─────────────────

check("the title is escaped in both letters", () => {
  const n = (src.match(/mail\.esc\(p\.title\)/g) || []).length;
  assert.ok(n >= 2, `the document title is escaped in ${n} of the two letters`);
});

check("the signer's name is escaped", () => {
  assert.ok(/mail\.esc\(name\)/.test(src));
});

console.log(`\n${passed} checks passed\n`);
