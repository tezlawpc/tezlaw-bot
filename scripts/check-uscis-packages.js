/**
 * check-uscis-packages.js
 * ─────────────────────────────────────────────────────────
 * The combo filings.
 *
 * "There are certain combo filings. Make sure they are available as an
 *  option." (JJ, 2026-10-08)
 *
 * A package is a list of forms, not a decision about whether to file them,
 * and most of what follows guards that line. The error this was written
 * around is the one that looks most like helpfulness: multiplying a
 * package by the size of a family.
 *
 * THERE ARE NO DERIVATIVES IN THE IMMEDIATE RELATIVE CATEGORY. A U.S.
 * citizen's spouse's children do not ride along on the spouse's I-130 the
 * way they do in a preference category; each needs a petition of their
 * own. A package that printed three I-485s for a family of three would be
 * a package that cannot be filed, and the staff member assembling it has
 * no reason to doubt it.
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

const K = require(path.join(ROOT, "uscis-packages.js"));
const F = require(path.join(ROOT, "uscis-forms.js"));
const G = require(path.join(ROOT, "uscis-g28.js"));
const P = require(path.join(ROOT, "uscis-packages-page.js"));

const client = { key: "a-a123456789", client_name: "Chen, Xifen", case_types: ["Asylum (I-589)"] };

console.log("\nCombo filings: what goes in one envelope, and what does not\n");

// ── the catalogue ───────────────────────────────────────────

check("the combos this firm actually files are all there", () => {
  const ids = K.PACKAGES.map((p) => p.id);
  for (const must of ["aos_immediate_relative", "aos_preference_family", "asylum_affirmative",
                      "aos_employment", "eb5_regional_center", "remove_conditions",
                      "naturalization", "fiance_k1", "provisional_waiver"]) {
    assert.ok(ids.includes(must), `${must} is not a package`);
  }
  assert.strictEqual(new Set(ids).size, ids.length, "a package id is used twice");
});

check("every package names only forms the firm tracks", () => {
  // Otherwise the edition tracker and the Federal Register watch do not
  // cover a form that is going out of the office.
  const tracked = new Set(F.FORMS.map((f) => f.id));
  for (const p of K.PACKAGES) {
    for (const f of p.forms) {
      assert.ok(tracked.has(f.id), `${p.id} names ${f.id}, which uscis-forms.js does not track`);
    }
    for (const id of p.per_person) {
      assert.ok(p.forms.some((f) => f.id === id), `${p.id} repeats ${id} per person but never files it`);
    }
  }
});

check("every package says what must be true before it is the right one", () => {
  for (const p of K.PACKAGES) {
    assert.ok(p.conditions && p.conditions.length, `${p.id} has no conditions`);
    assert.ok(p.summary && p.summary.length > 20, `${p.id} has no usable summary`);
    for (const c of p.conditions) assert.ok(c.length > 25, `${p.id} has a condition too short to mean anything`);
  }
});

check("an optional form says when it applies", () => {
  for (const p of K.PACKAGES) {
    for (const f of p.forms.filter((x) => !x.required)) {
      assert.ok(f.when && f.when.length > 8, `${p.id}: ${f.id} is optional with no condition`);
    }
  }
});

check("every form names who signs it", () => {
  // Two people are in the room and only one is on the retainer. A
  // checklist that does not say which of them signs the I-864 is the one
  // that comes back.
  for (const p of K.PACKAGES) {
    for (const f of p.forms) {
      assert.ok(K.ROLES[f.who], `${p.id}: ${f.id} has an unknown signer "${f.who}"`);
    }
  }
});

check("no fee amount appears anywhere in the catalogue", () => {
  // USCIS changes them, uscis-watch.js reports the change the day it
  // publishes, and a stale number in a checklist is worse than no number.
  const src = read("uscis-packages.js");
  const money = src.match(/\$\s?\d/g);
  assert.ok(!money, "a dollar amount is hard-coded: " + (money || []).join(", "));
});

// ── the derivative rule, which is the dangerous one ─────────

check("the immediate relative package refuses to multiply by family size", () => {
  const plan = K.planFor("aos_immediate_relative", { include: ["i-130a", "i-765", "i-131"], derivatives: 2 });
  for (const f of plan.forms) {
    assert.strictEqual(f.copies, 1, `${f.label} was multiplied in a category that has no derivatives`);
  }
  assert.strictEqual(plan.derivatives.refused, true, "the refusal is not reported");
  assert.strictEqual(plan.derivative_g28s, 0, "extra G-28s were counted for derivatives that do not exist");
  assert.ok(/no derivatives in the immediate relative category/i.test(plan.derivatives.note),
    "the note does not say why");
  assert.ok(/own I-130/.test(plan.derivatives.note), "the note does not say what to do instead");
});

check("a preference package does multiply, and adds a G-28 for each", () => {
  const plan = K.planFor("aos_preference_family", { include: ["i-485", "i-864", "i-765", "i-131"], derivatives: 2 });
  assert.strictEqual(plan.forms.find((f) => f.id === "i-485").copies, 3, "the I-485 was not multiplied");
  assert.strictEqual(plan.forms.find((f) => f.id === "i-130").copies, 1, "the petition was multiplied");
  assert.strictEqual(plan.forms.find((f) => f.id === "i-864").copies, 1, "the affidavit was multiplied");
  assert.strictEqual(plan.derivative_g28s, 2, "each derivative does not get their own G-28");
  assert.strictEqual(plan.derivatives.refused, false);
});

check("a negative or absurd derivative count does not reach the form list", () => {
  for (const n of [-3, "abc", null, undefined]) {
    const plan = K.planFor("aos_preference_family", { include: ["i-485"], derivatives: n });
    assert.strictEqual(plan.forms.find((f) => f.id === "i-485").copies, 1, `${n} produced a bad count`);
  }
});

// ── the sequence, which is the other dangerous one ──────────

check("the asylum work permit is a later filing, never in the envelope", () => {
  // Filed before day 150 the I-765 is rejected, and a rejected one filed
  // again is months of work authorization lost.
  const plan = K.planFor("asylum_affirmative", { include: ["i-765"] });
  assert.ok(!plan.forms.some((f) => f.id === "i-765"), "the I-765 went in with the I-589");
  assert.strictEqual(plan.form_numbers, "I-589", "item 1.b claims more than is being filed");
  const later = plan.later.find((l) => /I-765/.test(l.what));
  assert.ok(later, "nothing says the work permit comes later");
  assert.ok(/150 days/.test(later.when), "the 150-day wait is not stated");
  assert.ok(/rejected/i.test(later.note || ""), "nothing says what happens if it goes early");
});

check("a package that waits on a visa number says so first", () => {
  for (const id of ["aos_preference_family", "aos_employment"]) {
    const p = K.get(id);
    assert.ok(p.conditions.some((c) => /visa bulletin/i.test(c)),
      `${id} does not tell anyone to check the Visa Bulletin`);
    assert.ok(p.conditions.some((c) => /chart/i.test(c)),
      `${id} does not mention that USCIS picks which chart applies that month`);
    assert.ok(p.later.length, `${id} has nothing queued for when the date becomes current`);
  }
});

check("immigration court is not offered a G-28 package", () => {
  // An appearance before an Immigration Judge is an EOIR-28. The asylum
  // package is the one that could be mistaken for a court filing.
  const p = K.get("asylum_affirmative");
  assert.ok(p.conditions.some((c) => /EOIR-28/.test(c)),
    "nothing says a respondent files with the court, on a different form");
  for (const pkg of K.PACKAGES) {
    assert.ok(!pkg.before || pkg.before === "USCIS", `${pkg.id} claims to be filed somewhere other than USCIS`);
  }
});

// ── what it hands the G-28 ──────────────────────────────────

check("item 1.b lists what is being filed, and nothing else", () => {
  // A G-28 that claims to cover a form not in the envelope is wrong on the
  // face of it.
  const required = K.formNumbersFor("aos_immediate_relative");
  assert.strictEqual(required, "I-130, I-485, I-864", "the required-only list is wrong: " + required);
  const withOptions = K.formNumbersFor("aos_immediate_relative", { include: ["i-130a", "i-765"] });
  assert.ok(withOptions.includes("I-130A") && withOptions.includes("I-765"));
  assert.ok(!withOptions.includes("I-131"), "a form nobody asked for is on the G-28");
});

check("each package's capacity is one the G-28 actually has", () => {
  for (const p of K.PACKAGES) {
    if (!p.capacity) continue;
    assert.ok(G.CAPACITIES[p.capacity], `${p.id} wants capacity "${p.capacity}", which is not a box on the G-28`);
  }
  assert.strictEqual(K.get("aos_immediate_relative").capacity, "applicant");
  assert.strictEqual(K.get("eb5_regional_center").capacity, "petitioner",
    "an EB-5 investor petitions for themselves");
});

check("the package fills the G-28 but anything typed wins", () => {
  const src = read("server.js");
  const i = src.indexOf("async function g28Context");
  const block = src.slice(i, i + 1600);
  assert.ok(/src\.form_numbers \|\| ""\)\.trim\(\) \|\| \(pkg/.test(block),
    "the package overrides what a person typed into item 1.b");
  assert.ok(/src\.capacity \|\| ""\)\.trim\(\) \|\| \(pkg/.test(block),
    "the package overrides a capacity a person chose");
});

check("a G-28 opened from a package keeps the package across a re-render", () => {
  // Otherwise pressing "Update this page" drops item 1.b back to whatever
  // the client record suggested, silently.
  const pkg = K.get("aos_immediate_relative");
  const proposal = G.proposeG28({ client, attorney: "jj", matter: { form_numbers: "I-130, I-485, I-864" } });
  const html = require(path.join(ROOT, "uscis-g28-page.js"))
    .renderG28Page(client, proposal, { attorneyKey: "jj", matter: {}, pkg });
  assert.ok(/name="package" value="aos_immediate_relative"/.test(html),
    "the package is not carried on the form");
  assert.ok(/For the <b>.*immediate relative/.test(html), "the page does not say which package it is for");
});

// ── the pages ───────────────────────────────────────────────

check("the picker lists every package and carries no inline script", () => {
  const html = P.renderPicker(client);
  for (const p of K.list({ includeAddons: false })) {
    assert.ok(html.includes(`package=${encodeURIComponent(p.id)}`), `${p.id} is not on the picker`);
  }
  assert.ok(!/onclick|onchange=|<script/i.test(html), "the picker carries inline script");
});

check("the package page shows the conditions above the forms", () => {
  // A list of forms read first is a list assembled first.
  const plan = K.planFor("aos_preference_family", { include: ["i-485"], derivatives: 1 });
  const html = P.renderPackagePage(client, plan, { derivatives: 1, include: ["i-485"] });
  assert.ok(html.indexOf("Before this is the right package") < html.indexOf("What is being filed"),
    "the forms are listed before the conditions");
  assert.ok(/Visa Bulletin/i.test(html), "the bulletin warning does not reach the page");
  assert.ok(/one G-28 per person/i.test(html), "nothing says a G-28 covers one person");
  assert.ok(/fee schedule on the day of filing/i.test(html), "the page does not say where fees come from");
  assert.ok(!/onclick|onchange=|<script/i.test(html), "the page carries inline script");
});

check("the refusal is loud on the page, not a footnote", () => {
  const plan = K.planFor("aos_immediate_relative", { derivatives: 3 });
  const html = P.renderPackagePage(client, plan, { derivatives: 3 });
  assert.ok(/#9C2B1E/.test(html), "the refusal is not shown in the warning colour");
  assert.ok(/not counted/.test(html), "the page does not say the extra people were not counted");
});

check("an apostrophe in a client name does not break either page", () => {
  const c = { ...client, client_name: "O'Brien, Sean" };
  for (const html of [P.renderPicker(c),
                      P.renderPackagePage(c, K.planFor("naturalization", {}), {})]) {
    assert.ok(/O&#39;Brien/.test(html) && !/O'Brien/.test(html), "an apostrophe is unescaped");
  }
});

check("the client profile has a way in", () => {
  assert.ok(/filing-package/.test(read("client-profiles.js")), "no link from a client file");
  assert.ok(/app\.get\("\/admin\/clients\/:key\/filing-package"/.test(read("server.js")), "no route");
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:uscis-packages"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-uscis-packages.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-uscis-packages.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
