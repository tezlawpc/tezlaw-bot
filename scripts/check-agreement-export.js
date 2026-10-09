/**
 * check-agreement-export.js
 * ─────────────────────────────────────────────────────────
 * What leaves the office: the Word file, the print view, and the page
 * that makes them.
 *
 * Six things came back on 2026-10-09 from one agreement sent to a client.
 * Four of them are here; each had the same shape, which is why they are
 * worth guarding rather than just fixing:
 *
 *   The DOCX and the HTML disagreed, quietly.
 *     - the firm profile printed FIRST in Word and last in the browser
 *     - the body was justified in the browser and left-aligned in Word:
 *       0 justified paragraphs out of 164 in the file JJ sent back
 *   Something printed three times because three places each printed it
 *     - the offices were on the letterhead, in the profile, and in a
 *       footer
 *   And a button that worked in one browser and not another
 *     - href="javascript:window.print()" gave Safari a blank page
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (err) { console.log("  FAIL  " + name); throw err; }
  console.log("  ok  " + name);
  passed++;
}

const DOC = require(path.join(ROOT, "retainer-doc.js"));
const DX = require(path.join(ROOT, "retainer-docx.js"));

const terms = () => ({
  client_name: "Kevin Truong",
  matter_type: "personal_injury",
  matter_label: "Agreement for Legal Services (Tort)",
  structure: "flat", flat_fee: 5000, total_fee: 5000,
  bilingual: true, agreement_date: "2026-10-09",
  scope: ["Represent you in your personal injury claim.", "Negotiate with the insurer."],
  operating_account_consent: true,
});

// The DOCX, read back the way a reader meets it: paragraphs in order.
function docxParas(a) {
  const zip = DX.build(a, DOC);
  // The document part, located by its own header rather than by offset.
  const xml = require("pizzip")(zip).file("word/document.xml").asText();
  const out = [];
  const re = /<w:p[ >][\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = (m[0].match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map((x) => x.replace(/<[^>]+>/g, "")).join("").trim();
    if (t) out.push({ text: t, jc: (m[0].match(/<w:jc w:val="(\w+)"/) || [])[1] || null });
  }
  return { xml, paras: out };
}

console.log("\nThe agreement as it leaves the office\n");

// ── order ───────────────────────────────────────────────────

check("the firm profile is at the back of the Word file, after the signatures", () => {
  // "the tez profile is still in the front. But it should be after the
  // signature page." It printed between the cover and the client's own
  // letter, because this builder adds the profile itself and added it
  // early.
  const { paras } = docxParas(terms());
  const at = (frag) => paras.findIndex((p) => p.text.includes(frag));
  const letter = at("Re:");
  const signed = at("Agreed");
  const profile = at("About the firm");
  assert.ok(letter > 0, "the letter is not in the file");
  assert.ok(signed > letter, "the signature block is not after the letter");
  assert.ok(profile > signed,
    `the firm profile is at paragraph ${profile}, before the signatures at ${signed}`);
  assert.ok(profile > paras.length * 0.7,
    "the profile is not near the back of the document");
});

check("the browser and the Word file put the profile in the same place", () => {
  // The two disagreed for a month because each decided for itself.
  const html = DOC.body(terms(), { forClient: true, withLetterhead: true });
  assert.ok(html.indexOf("About the firm") > html.indexOf("Agreed"),
    "the browser copy has the profile before the signatures");
});

// ── alignment ───────────────────────────────────────────────

check("the body of the Word file is justified, as the browser copy is", () => {
  // The file JJ sent back had 0 justified paragraphs out of 164: the
  // stylesheet says justify, the builder emitted no w:jc, and Word
  // defaults to left.
  const { paras } = docxParas(terms());
  const both = paras.filter((p) => p.jc === "both").length;
  const left = paras.filter((p) => p.jc === "left").length;
  assert.ok(both > 40, `only ${both} justified paragraphs — the body is not justified`);
  assert.strictEqual(left, 0, `${left} paragraphs are explicitly left-aligned`);
  const css = DOC.CSS;
  assert.ok(/p, li \{ text-align:justify/.test(css), "the browser copy stopped being justified");
});

check("a heading is not justified, which would track its words apart", () => {
  // Matched on the WHOLE title, not a prefix of it. /^Agreement for Legal
  // Services/ also matches the cover's MATTER field, which is exactly the
  // sort of near-miss that has cost this repo a day at a time.
  const { paras } = docxParas(terms());
  const title = paras.find((p) => p.text === "Agreement for Legal Services \u00b7 \u5f8b\u5e08\u4e0e\u5ba2\u6237\u59d4\u6258\u6536\u8d39\u534f\u8bae");
  assert.ok(title, "the document title is missing: " +
    paras.filter((x) => /Agreement for Legal/.test(x.text)).map((x) => x.text).join(" | "));
  assert.strictEqual(title.jc, "center", "the title is not centred");
});

// ── said once ───────────────────────────────────────────────

check("an office address is printed once, not three times", () => {
  // "office locations and phone numbers should just be in the firm's
  // profile." They were on the letterhead, in the profile and in a footer
  // of their own: three places to correct when an office moves.
  const { paras } = docxParas(terms());
  const hits = paras.filter((p) => p.text.includes("4141 S. Nogales")).length;
  assert.strictEqual(hits, 1, `the West Covina address appears ${hits} times`);
  assert.ok(!/<footer class="offices">/.test(read("retainer-doc.js")),
    "the offices footer is back");
  assert.ok(!/\.offices \{/.test(DOC.CSS), "the footer's styles outlived the footer");
});

// ── the print button ────────────────────────────────────────

check("no page prints through a javascript: URL", () => {
  // Safari treats following one as a navigation: it begins replacing the
  // document, and the dialog prints the replacement. The copy JJ sent on
  // 2026-10-09 was a single blank page, 901 bytes, Creator "Safari".
  for (const f of ["retainer-doc.js", "app-api.js", "audit-ui.js"]) {
    const src = read(f);
    const live = src.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
    assert.ok(!/href="javascript:/.test(live), `${f} still prints through a javascript: URL`);
  }
});

check("the print button is a button, wired by a file that exists", () => {
  const html = DOC.render(terms(), { forClient: true, id: "demo" });
  assert.ok(/<button[^>]+id="print-this"/.test(html), "the print control is not a button");
  assert.ok(/print-view\.js/.test(html), "nothing wires it");
  assert.ok(fs.existsSync(path.join(ROOT, "public", "print-view.js")),
    "public/print-view.js is missing, so the button would do nothing");
  const js = read("public/print-view.js");
  assert.ok(/getElementById\("print-this"\)/.test(js), "the script does not look for the button");
  assert.ok(/preventDefault/.test(js), "the click is not stopped from navigating");
});

check("the print view carries no inline script", () => {
  // notify-admin.js:11.
  const html = DOC.render(terms(), { forClient: true, id: "demo" });
  assert.ok(!/onclick|onchange=/i.test(html), "the print view carries an inline handler");
  const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi);
  assert.ok(!inline, "the print view carries an inline <script> block");
});

check("the document itself has no action bar, so a client copy has no buttons", () => {
  const html = DOC.render(terms(), { forClient: true });   // no id
  assert.ok(!/print-this/.test(html), "a copy rendered without an id still has the buttons");
});

// ── the payment page says when it cannot say anything ───────

check("an agreement with no account details on file says so, loudly, to the firm", () => {
  // "wire instruction still does not show wire instruction. just
  // disclosures." The page was not broken: it degrades to "telephone the
  // office" when the details are not configured, and said nothing to the
  // person generating it. On Render they have never been configured.
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const real = PAY.paymentDetails;
  const P = require(path.join(ROOT, "retainer-page.js"));
  const draft = {
    id: "1", client_name: "Kevin Truong", created_at: new Date(),
    created_by: "JJ", status: "draft", terms: terms(),
  };
  try {
    PAY.paymentDetails = () => ({ bank: "", trust_name: "", trust_account: "", routing_wire: "" });
    const html = P.renderReview({ user: { r: "admin", uid: "1" }, draft });
    assert.ok(/no wire instructions/.test(html), "nothing warns that the details are missing");
    assert.ok(/TEZ_PAY_/.test(html), "the warning does not name what to set");
    assert.ok(/Secret File/i.test(html), "the warning does not say where to set it");
  } finally {
    PAY.paymentDetails = real;
  }
});

check("the warning goes away when the details are there, and prints no values", () => {
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const real = PAY.paymentDetails;
  const P = require(path.join(ROOT, "retainer-page.js"));
  const draft = {
    id: "1", client_name: "Kevin Truong", created_at: new Date(),
    created_by: "JJ", status: "draft", terms: terms(),
  };
  try {
    PAY.paymentDetails = () => ({
      bank: "Bank", trust_name: "T", trust_account: "000111222", routing_wire: "026009593",
    });
    const html = P.renderReview({ user: { r: "admin", uid: "1" }, draft });
    assert.ok(!/no wire instructions/.test(html), "the warning shows when nothing is missing");
    // And the warning path must never put an account number on a screen.
    assert.ok(!/000111222/.test(html), "an account number reached the review page");
  } finally {
    PAY.paymentDetails = real;
  }
});

check("the payment page prints the account details when they are configured", () => {
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const real = PAY.paymentDetails;
  try {
    PAY.paymentDetails = () => ({
      bank: "Bank of America", trust_name: "Tez Law P.C. Client Trust",
      trust_account: "000111222", operating_name: "Tez Law P.C.", operating_account: "999888777",
      routing_wire: "026009593", routing_ach: "121000358", swift_usd: "BOFAUS3N",
      bank_address_usd: "", swift_fx: "", bank_address_fx: "", zelle: "", reference: "",
    });
    const html = DOC.paymentPage({ ...terms(), operating_account_consent: false });
    assert.ok(/Routing number, wire/.test(html), "the wire routing number is not printed");
    assert.ok(/026009593/.test(html), "the wire routing number is missing its value");
    assert.ok(!/telephone the office on .* for the account details/.test(html),
      "it fell back to the telephone wording with details on file");
    // The fraud warning comes first, always.
    assert.ok(html.indexOf("Before you send money") < html.indexOf("Routing number"),
      "the account details are printed above the fraud warning");
  } finally {
    PAY.paymentDetails = real;
  }
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:agreement-export"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-agreement-export.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-agreement-export.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
