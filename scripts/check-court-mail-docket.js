/**
 * check-court-mail-docket.js
 *
 * One address holding every court notice the firm receives, with the deadline
 * reading attached to each — state, immigration, district, appellate. JJ
 * registers it with the courts and the e-filing services and it becomes the
 * firm's docket of record.
 *
 * THE ONE THING THAT COULD GO BADLY WRONG
 * If the address being copied to is also the mailbox being read, every message
 * forwards itself, gets collected again, and forwards again. That is not a
 * slow leak — it is an unbounded loop that fills the mailbox, burns the
 * provider's send quota and buries the real notices inside hours. And it is
 * the most likely misconfiguration of all, because the obvious way to set
 * this up is to point both settings at the docket address.
 *
 * So most of this file is about refusing to send: the loop, a mangled
 * address, a header injection, a second copy of a row somebody re-read.
 *
 * The rest holds that a notice from each kind of court is actually recognised
 * as court mail in the first place. A sender the firm does not recognise is
 * never acted on at all, so "all court notices reach the docket" depends
 * entirely on that list.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const cm = require(path.join(ROOT, "court-mail.js"));
const { docketAddress, docketRefusal, isCourtSender } = cm;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const src = fs.readFileSync(path.join(ROOT, "court-mail.js"), "utf8");

// Each case sets the environment it needs and puts it back.
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log("\nCourt mail: the docket mailbox\n");

// ── Refusing to loop ───────────────────────────────────────

check("copying to the mailbox being read is refused", () => {
  const r = withEnv({
    COURT_MAIL_COPY_TO: "tezlawdocket@gmail.com",
    COURT_MAIL_USER: "tezlawdocket@gmail.com",
    COURT_MAIL_PASS: "x",
  }, () => docketRefusal(null));
  assert.ok(r, "this must be refused");
  assert.ok(/loop/i.test(r), "and the reason must say why, or somebody will 'fix' it back");
});

check("the loop check ignores case and surrounding spaces", () => {
  const r = withEnv({
    COURT_MAIL_COPY_TO: "  TezLawDocket@Gmail.com  ",
    COURT_MAIL_USER: "tezlawdocket@gmail.com",
    COURT_MAIL_PASS: "x",
  }, () => docketRefusal(null));
  assert.ok(r && /loop/i.test(r), "a capitalised address is the same mailbox");
});

check("a different address is allowed", () => {
  const r = withEnv({
    COURT_MAIL_COPY_TO: "tezlawdocket@gmail.com",
    COURT_MAIL_USER: "courtmail@tezlawfirm.com",
    COURT_MAIL_PASS: "x",
  }, () => docketRefusal(null));
  assert.strictEqual(r, null);
});

// ── Refusing a bad address ─────────────────────────────────

check("unset means off, and says so", () => {
  const r = withEnv({ COURT_MAIL_COPY_TO: undefined }, () => docketRefusal(null));
  assert.ok(/not set/i.test(r));
  assert.strictEqual(withEnv({ COURT_MAIL_COPY_TO: undefined }, () => docketAddress()), null);
});

check("a list of addresses is refused, not handed to the mail server", () => {
  for (const bad of ["a@x.com, b@y.com", "a@x.com; b@y.com", "Docket <a@x.com>"]) {
    const r = withEnv({ COURT_MAIL_COPY_TO: bad, COURT_MAIL_USER: "u@v.com", COURT_MAIL_PASS: "x" },
      () => docketRefusal(null));
    assert.ok(r && /one email address/i.test(r), `${JSON.stringify(bad)} was accepted`);
  }
});

check("a header injection cannot get through", () => {
  for (const bad of ["a@x.com\nbcc: c@z.com", "a@x.com\r\nSubject: x", "a@x.com\tb"]) {
    assert.strictEqual(
      withEnv({ COURT_MAIL_COPY_TO: bad }, () => docketAddress()), null,
      `${JSON.stringify(bad)} produced an address`);
  }
});

check("nonsense is refused", () => {
  for (const bad of ["not an address", "@x.com", "a@", "a@x", "   "]) {
    assert.strictEqual(withEnv({ COURT_MAIL_COPY_TO: bad }, () => docketAddress()), null, bad);
  }
});

// ── Refusing a second copy ─────────────────────────────────

check("a row already copied is not copied again", () => {
  const r = withEnv({ COURT_MAIL_COPY_TO: "d@tezlawfirm.com", COURT_MAIL_USER: "u@v.com", COURT_MAIL_PASS: "x" },
    () => docketRefusal({ id: 1, forwarded_at: new Date() }));
  assert.ok(r && /already copied/i.test(r),
    "a re-read or a hand re-assignment must not send a duplicate");
});

check("the row records when it was copied, and any failure", () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ/.test(src));
  assert.ok(/ADD COLUMN IF NOT EXISTS forward_error TEXT/.test(src));
  assert.ok(/UPDATE court_mail SET forwarded_at = NOW\(\), forward_error = NULL/.test(src));
  assert.ok(/UPDATE court_mail SET forward_error = \$2/.test(src),
    "a failure has to be visible on the row, not only in the log");
});

// ── The copy itself ────────────────────────────────────────

check("the original is attached, not retyped", () => {
  // A docket copy is only worth something if it is the document as sent.
  assert.ok(/contentType: "message\/rfc822"/.test(src));
  assert.ok(/content: row\.raw/.test(src));
});

check("the reading travels with it", () => {
  for (const heading of ["HEARINGS", "OFF CALENDAR", "DEADLINES", "TO DO"]) {
    assert.ok(src.includes(heading), `the docket copy does not carry ${heading}`);
  }
});

check("calculated dates are labelled as not calendared", () => {
  // The distinction the whole reading turns on. A docket copy that blurred
  // "the court said this" with "we worked this out" would be worse than one
  // that showed neither.
  assert.ok(/SUGGESTED, NOT CALENDARED/.test(src));
  assert.ok(/calculated, or not stated in the document/.test(src));
});

check("it tells the reader to check the dates against the document", () => {
  assert.ok(/Verify every date against the document/.test(src));
});

check("replies go to the court, not to the firm's own sender", () => {
  assert.ok(/replyTo: row\.original_from \|\| row\.from_addr/.test(src),
    "a forwarded notice is usually replied to; it should reach the court");
});

// ── It cannot break the pipeline ───────────────────────────

check("the copy runs after the email is filed and recorded", () => {
  const done = src.indexOf("UPDATE court_mail SET status = 'done'");
  const fwd = src.indexOf("await forwardToDocket(fresh, reading);");
  assert.ok(done > -1 && fwd > done,
    "the filing and the calendar entries are what matter; a mail outage must not undo them");
});

check("the copy never throws into the pipeline", () => {
  const i = src.indexOf("await forwardToDocket(fresh, reading);");
  const around = src.slice(i - 300, i + 200);
  assert.ok(/try \{/.test(around) && /catch \(e\) \{ console\.warn\("\[court-mail\] docket copy/.test(around));
  const fn = src.slice(src.indexOf("async function forwardToDocket"), src.indexOf("async function tellJJ"));
  assert.ok(/return \{ sent: false, reason:/.test(fn),
    "it reports rather than throws");
  assert.ok(!/\n  throw /.test(fn), "forwardToDocket must not throw");
});

check("no mail server configured is reported, not crashed on", () => {
  const fn = src.slice(src.indexOf("async function forwardToDocket"), src.indexOf("async function tellJJ"));
  assert.ok(/if \(!m\) return \{ sent: false, reason: "email is not set up/.test(fn));
});

// ── Diagnosable without the server log ─────────────────────

check("the status page says whether the copy is on, and why not", () => {
  assert.ok(/docket_to: docketAddress\(\)/.test(src));
  assert.ok(/docket_refusal: docketRefusal\(null\)/.test(src),
    "a misconfigured docket address should be visible on the admin page");
});

// ── Every kind of court is recognised at all ───────────────
// A sender the firm does not recognise is never acted on, so the whole of
// "all court notices reach the docket" rests on this list.

check("federal district and bankruptcy courts", () => {
  for (const a of ["cmecf@cacd.uscourts.gov", "ecf_notice@casd.uscourts.gov", "noreply@cacb.uscourts.gov"]) {
    assert.ok(isCourtSender(a), a);
  }
});

check("federal appellate courts and the Supreme Court", () => {
  for (const a of ["ecf-reply@ca9.uscourts.gov", "clerk@supremecourt.gov"]) {
    assert.ok(isCourtSender(a), a);
  }
});

check("PACER, which is not a uscourts.gov subdomain", () => {
  assert.ok(isCourtSender("pacer@pacer.gov"));
});

check("immigration — EOIR, the BIA, and USCIS on its own domain", () => {
  for (const a of ["erop@usdoj.gov", "no-reply@eoir.justice.gov", "no-reply@uscis.gov", "x@uscis.dhs.gov"]) {
    assert.ok(isCourtSender(a), `${a} would not be treated as court mail`);
  }
});

check("California trial courts and the Courts of Appeal", () => {
  for (const a of ["notice@lacourt.org", "x@occourts.org", "x@sb-court.org",
                   "x@riverside.courts.ca.gov", "x@appellatecases.courtinfo.ca.gov", "x@jud.ca.gov"]) {
    assert.ok(isCourtSender(a), a);
  }
});

check("e-filing and e-service, which is how most state documents arrive", () => {
  for (const a of ["noreply@onelegal.com", "x@tylerhost.net", "x@odysseyefileca.com", "x@proofserve.com"]) {
    assert.ok(isCourtSender(a), a);
  }
});

check("a look-alike domain is still not a court", () => {
  // The reason this is an allow-list of exact domains and their subdomains
  // rather than a pattern.
  for (const a of ["clerk@mycourtnotice.xyz", "x@uscourts.gov.phish.com", "x@lacourt.org.evil.net",
                   "friend@gmail.com", "x@not-uscourts.gov"]) {
    assert.ok(!isCourtSender(a), `${a} was treated as a court`);
  }
});

check("more domains can be added without a deploy", () => {
  assert.ok(withEnv({ COURT_MAIL_EXTRA_DOMAINS: "newcourt.example" },
    () => isCourtSender("clerk@newcourt.example")));
  assert.ok(!isCourtSender("clerk@newcourt.example"), "and only while it is set");
});

console.log(`\n${passed} checks passed\n`);
