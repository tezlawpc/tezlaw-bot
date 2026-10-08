/**
 * check-uscis-forms.js
 * ─────────────────────────────────────────────────────────
 * The form edition tracker and the daily Federal Register watch.
 *
 * Most of this is about the MATCHER, because I got it wrong twice while
 * building it and both failures were the same shape: matching words
 * instead of meaning.
 *
 *   First try  matched only the form NUMBER. The Register titles its
 *              notices with the form's NAME, so it found nothing.
 *   Second try matched any title CONTAINING the name's words. "Petition
 *              for CNMI-Only Nonimmigrant Transitional Worker" contains
 *              every word of I-129's "Petition for a Nonimmigrant Worker"
 *              and is a different form.
 *   Third try  allowed one extra word, so "Application by Refugee for
 *              Waiver of Inadmissibility Grounds" (the I-602) matched the
 *              I-601, which differs by the single word "Refugee".
 *
 * A wrong match here tells the firm a form changed when it did not, or
 * worse, stays quiet about one that did. The fixtures below are the real
 * titles those three attempts got wrong.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0;
function check(name, fn) {
  const done = (err) => { if (err) { console.log("  FAIL  " + name); throw err; } console.log("  ok  " + name); passed++; };
  const out = fn();
  if (out && typeof out.then === "function") return out.then(() => done(), done);
  return Promise.resolve().then(() => done());
}

const F = require(path.join(ROOT, "uscis-forms.js"));
const W = require(path.join(ROOT, "uscis-watch.js"));

const named = (title) => W.formsNamedIn(title, F.FORMS);
const COLLECTION = "Agency Information Collection Activities; Revision of a Currently Approved Collection: ";

async function run() {
  console.log("\nUSCIS forms: which edition is current, and when to look\n");

  // ── the registry ──────────────────────────────────────────

  await check("every tracked form has an id, a name and a practice area", () => {
    for (const f of F.FORMS) {
      assert.ok(/^[a-z]+-\d+[a-z]?$/.test(f.id), `bad id: ${f.id}`);
      assert.ok(f.name && f.name.length > 8, `${f.id} has no usable name`);
      assert.ok(f.area, `${f.id} has no practice area`);
    }
    const ids = F.FORMS.map((f) => f.id);
    assert.strictEqual(new Set(ids).size, ids.length, "a form is listed twice");
  });

  await check("the forms we actually file are on the list", () => {
    const ids = F.FORMS.map((f) => f.id);
    // The ones this firm cannot do without: asylum, adjustment, the
    // appearance form that goes on every filing.
    for (const must of ["i-589", "i-485", "i-130", "g-28", "n-400", "i-765"]) {
      assert.ok(ids.includes(must), `${must} is not tracked`);
    }
  });

  // ── reading the edition off a PDF ─────────────────────────

  await check("both footer shapes are understood", () => {
    // "Form I-130   Edition 04/01/24"          most forms
    // "Form G-28   09/17/18   Page 1 of 4"     no "Edition" word
    assert.ok(F.EDITION.test("Form I-130   Edition   04/01/24"), "the Edition shape is not matched");
    assert.ok(F.EDITION_BARE.test("Form G-28   09/17/18   Page 1 of 4"), "the bare shape is not matched");
    // And the bare shape must not swallow a page number as a date.
    assert.ok(!F.EDITION_BARE.test("Form I-130   Page 1 of 12"), "a page line reads as an edition");
  });

  await check("a file that is not a PDF is refused, not guessed at", async () => {
    const r = await F.readEdition(Buffer.from("this is not a pdf"));
    assert.strictEqual(r.ok, false, "a non-PDF was read as a form");
    assert.ok(/could not be read/.test(r.reason), "the reason does not say what went wrong");
  });

  await check("the stored editions were read from the forms, not typed in", () => {
    let j;
    try { j = require(path.join(ROOT, "uscis-forms.json")); } catch { return; }  // not fetched yet
    for (const [id, v] of Object.entries(j.forms)) {
      assert.ok(/^\d{2}\/\d{2}\/\d{2,4}$/.test(v.edition), `${id} has an edition in an odd shape: ${v.edition}`);
      assert.ok(v.url && v.url.includes("uscis.gov"), `${id} has no USCIS URL`);
    }
    // The registry and the fetched file must not drift apart.
    const tracked = new Set(F.FORMS.map((f) => f.id));
    for (const id of Object.keys(j.forms)) {
      assert.ok(tracked.has(id), `${id} is in the JSON but no longer tracked`);
    }
  });

  // ── the matcher, where the mistakes were ──────────────────

  await check("a notice titled with the form's NAME is matched", () => {
    // The Register does not put the number in the title.
    assert.deepStrictEqual(named(COLLECTION + "Application for Waiver of Grounds of Inadmissibility"), ["i-601"]);
    assert.deepStrictEqual(named(COLLECTION + "Petition To Remove the Conditions on Residence"), ["i-751"]);
    assert.deepStrictEqual(named(COLLECTION + "Application for Certificate of Citizenship"), ["n-600"]);
  });

  await check("a longer name that contains a shorter one is NOT matched", () => {
    // I-129CW. Contains every word of I-129's "Petition for a
    // Nonimmigrant Worker".
    assert.deepStrictEqual(named(COLLECTION + "Petition for CNMI-Only Nonimmigrant Transitional Worker"), [],
      "a different form matched because its name is a superset");
  });

  await check("a name differing by one word is NOT matched", () => {
    // The I-602. One word apart from the I-601.
    assert.deepStrictEqual(named(COLLECTION + "Application by Refugee for Waiver of Inadmissibility Grounds"), [],
      "the I-602 matched the I-601");
  });

  await check("a trailing Correction does not break the match", () => {
    assert.deepStrictEqual(
      named(COLLECTION + "Application for Provisional Unlawful Presence Waiver; Correction"), ["i-601a"]);
  });

  await check("a notice listing two forms matches the one we file", () => {
    assert.deepStrictEqual(
      named(COLLECTION + "Immigrant Petition by Standalone Investor, Immigrant Petition by Regional Center Investor"),
      ["i-526e"]);
  });

  await check("the form number still matches when it is given", () => {
    assert.deepStrictEqual(named("Fee Schedule for Form I-765 and related benefit requests"), ["i-765"]);
  });

  // ── what counts as a signal ───────────────────────────────

  await check("a routine extension without change is not a signal", () => {
    // These are the bulk of USCIS's Register traffic. Treating them as
    // changes would mean a message most weeks, which is how a watcher
    // stops being read.
    const title = "Agency Information Collection Activities; Extension, Without Change, of a Currently Approved Collection: Biographic Information";
    assert.ok(W.NO_CHANGE.test(title), "the without-change wording is not recognised");
    assert.deepStrictEqual(named(title), [], "a without-change extension named a form");
  });

  await check("a fee change is a signal even with no form named", () => {
    for (const t of ["U.S. Citizenship and Immigration Services Fee Schedule",
                     "Adjustment of Fees for Certain Immigration Benefit Requests"]) {
      assert.ok(W.ABOUT_FEES.test(t), `not recognised as a fee change: ${t}`);
    }
  });

  // ── how it runs ───────────────────────────────────────────

  await check("the daily watch rides the digest that already runs", () => {
    const src = read("legal-digest.js");
    assert.ok(/uscis-watch/.test(src), "nothing runs the watch daily");
    // And it must not be able to take the digest down with it.
    const i = src.indexOf("uscis-watch");
    const around = src.slice(Math.max(0, i - 400), i + 400);
    assert.ok(/try\s*\{/.test(around) && /catch/.test(around),
      "a failure in the watch would stop the legal digest");
  });

  await check("the weekly backstop is a workflow, and runs a file not an inline script", () => {
    const yml = read(".github/workflows/update-uscis-forms.yml");
    assert.ok(/cron:/.test(yml), "it is not scheduled");
    assert.ok(/scripts\/uscis-form-editions\.js/.test(yml), "it does not call the runner");
    // An inline `node -e` inside a YAML scalar is how check-ci-file.js's
    // three previous incidents started.
    assert.ok(!/node -e/.test(yml), "the workflow carries an inline node script");
    assert.ok(fs.existsSync(path.join(ROOT, "scripts", "uscis-form-editions.js")), "the runner is missing");
  });

  await check("a form that cannot be read keeps its last known edition", () => {
    // Otherwise a fetch failure looks exactly like "nothing changed",
    // which is the one thing this must never say wrongly.
    const src = read("uscis-forms.js");
    assert.ok(/if \(previous\.forms && previous\.forms\[f\.id\]\) out\.forms\[f\.id\] = previous\.forms\[f\.id\]/.test(src),
      "a failed read drops the form from the record");
    assert.ok(/failed\.push/.test(src), "a failed read is not reported");
  });

  await check("an expired OMB number is called out", () => {
    // The G-28 at the USCIS URL expired 05/31/2021. Filing on a form with
    // a lapsed OMB control number invites a rejection.
    const r = F.report({
      checked_on: "2026-10-08", changed: [], failed: [],
      forms: { "g-28": { name: "Notice of Entry of Appearance", edition: "09/17/18",
                         expires: "05/31/2021", omb_expired: true } },
    });
    assert.ok(/OMB CONTROL NUMBER ALREADY EXPIRED/.test(r), "an expired OMB number is not reported");
    assert.ok(/G-28/.test(r), "the form is not named");
  });

  await check("an edition change says to re-check the field map", () => {
    // A new edition moves fields. A map built for the old one puts the
    // right answer in the wrong box, which is worse than no prefill.
    const r = F.report({
      checked_on: "2026-10-08", failed: [], forms: {},
      changed: [{ id: "i-589", name: "Asylum", from: "07/28/26", to: "01/15/27" }],
    });
    assert.ok(/re-check the field map/i.test(r), "nothing warns that the field map is now stale");
    assert.ok(/07\/28\/26 -> 01\/15\/27/.test(r), "the change is not shown");
  });

  await check("the check is registered the way every check here is", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.scripts["check:uscis-forms"], "no npm script");
    assert.ok(pkg.scripts["test:chain"].includes("check-uscis-forms.js"), "not in the chain");
    assert.ok(read(".github/workflows/ci.yml").includes("check-uscis-forms.js"), "not in CI");
  });

  console.log(`\n${passed} checks passed\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });
