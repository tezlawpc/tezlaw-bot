/**
 * check-retainer-handoff.js
 * ─────────────────────────────────────────────────────────
 * "when picking the client and it matches an existing client in the
 *  system, the retainer will be stored to client's profile and case is
 *  created. invoice should be created as well according to the
 *  agreement." (JJ, 2026-10-08)
 *
 * And the scope writer, which is the riskier of the two: the scope is the
 * firm's operative promise under § 6148(a)(2), and the clause after it
 * says anything not listed is outside the Agreement. A model asked to
 * "elaborate" will happily turn "prepare the petition" into "prepare the
 * petition and respond to any Request for Evidence" — a second filing,
 * often a second fee, now contractually owed. These checks are mostly
 * about that not happening.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0;
function check(name, fn) {
  const done = (err) => {
    if (err) { console.log("  FAIL  " + name); throw err; }
    console.log("  ok  " + name);
    passed++;
  };
  const out = fn();
  if (out && typeof out.then === "function") return out.then(() => done(), done);
  return Promise.resolve().then(() => done());
}

const HO = require(path.join(ROOT, "retainer-handoff.js"));
const SW = require(path.join(ROOT, "scope-writer.js"));
const R = require(path.join(ROOT, "retainer.js"));

async function run() {
  console.log("\nWhat happens when an agreement goes out\n");

  // ── what is invoiced ──────────────────────────────────────

  await check("a flat fee is invoiced in full on signing, into trust", () => {
    const due = HO.amountDue({ structure: "flat", total_fee: 25000 });
    assert.ok(due, "a flat fee raises no invoice");
    assert.strictEqual(due.amount, 25000);
    assert.ok(/client trust account/.test(due.description),
      "the invoice does not say the money is held in trust");
    assert.ok(/earned as the work is performed/.test(due.description),
      "the invoice reads as if the fee is earned on receipt, which Rule 1.5(d) forbids");
  });

  await check("an hourly matter is invoiced for the deposit, not for an estimate", () => {
    const due = HO.amountDue({ structure: "hourly", deposit: 5000, total_fee: 5000 });
    assert.strictEqual(due.amount, 5000);
    assert.ok(/[Dd]eposit/.test(due.description), "it is not described as a deposit");
  });

  await check("a contingency client is invoiced nothing at signature", () => {
    // They owe no fee until there is a recovery. An invoice here is a
    // demand for money that is not owed.
    assert.strictEqual(HO.amountDue({ structure: "contingency", contingency_pct: 33 }), null);
    assert.strictEqual(HO.amountDue({ structure: "contingency", total_fee: 10000 }), null,
      "a contingency matter carrying a figure still raises an invoice");
  });

  await check("a flat fee of nothing raises no invoice", () => {
    assert.strictEqual(HO.amountDue({ structure: "flat", total_fee: 0 }), null);
    assert.strictEqual(HO.amountDue({ structure: "hourly", deposit: null }), null);
  });

  // ── where a case goes ─────────────────────────────────────

  await check("every matter type the form can emit knows where its case goes", () => {
    const real = Object.keys(R.MATTER_LABELS);
    const unrouted = real.filter((k) => !(k in HO.ROUTING));
    assert.deepStrictEqual(unrouted, [],
      "a matter type the form offers has no routing: " + unrouted.join(", "));
    const invented = Object.keys(HO.ROUTING).filter((k) => !real.includes(k));
    assert.deepStrictEqual(invented, [],
      "the routing table names matter types the form cannot emit: " + invented.join(", "));
    for (const [k, v] of Object.entries(HO.ROUTING)) {
      assert.ok(["pi", "civil", "federal", "none"].includes(v), `${k} routes to an unknown table: ${v}`);
    }
  });

  await check("immigration and estate planning say so rather than inventing a row", () => {
    for (const k of ["immigration_removal", "immigration_family", "estate_planning"]) {
      assert.strictEqual(HO.ROUTING[k], "none",
        `${k} is being written into a case table that was built for something else`);
    }
  });

  // ── the scope writer's guards ─────────────────────────────

  await check("an expansion that adds a filing is refused and the drafter's line kept", async () => {
    const original = "Prepare and file Form I-130";
    const out = await SW.elaborate([original], {
      think: async () => ({ text: "We will prepare and file Form I-130 for you and respond to any Request for Evidence that USCIS issues on it." }),
    });
    assert.strictEqual(out.lines[0], original,
      "an expansion that promised a second filing was accepted into the scope");
    assert.ok(out.notes.some((n) => /added work/.test(n)), "nothing told the drafter why");
  });

  await check("an expansion that promises a result is refused", async () => {
    const original = "Prepare the naturalization application";
    const out = await SW.elaborate([original], {
      think: async () => ({ text: "We will prepare your naturalization application thoroughly, ensuring your application is approved." }),
    });
    assert.strictEqual(out.lines[0], original);
    assert.ok(out.notes.some((n) => /promised a result/.test(n)));
  });

  await check("a clean expansion is used", async () => {
    const better = "We will prepare your Form I-526E petition and file it with USCIS, including the forms, the supporting exhibits and the cover letter that goes with it.";
    const out = await SW.elaborate(["File the I-526E"], { think: async () => ({ text: better }) });
    assert.strictEqual(out.lines[0], better, "a clean expansion was thrown away");
  });

  await check("a reply with the wrong number of lines is discarded whole", async () => {
    const input = ["File the I-130", "File the I-485"];
    const out = await SW.elaborate(input, { think: async () => ({ text: "One line only." }) });
    assert.deepStrictEqual(out.lines, input,
      "lines were taken from a reply that did not line up with the input");
    assert.ok(out.notes.some((n) => /did not guess|not worth guessing/.test(n) || /returned 1 lines/.test(n)));
  });

  await check("Zara being down leaves the scope exactly as it was", async () => {
    const input = ["File the I-130"];
    const out = await SW.elaborate(input, {
      think: async () => { throw new Error("upstream timeout"); },
    });
    assert.deepStrictEqual(out.lines, input);
    assert.ok(out.notes.some((n) => /could not be reached/.test(n)));
    // A fee agreement must not depend on a model being up.
  });

  await check("the drafter is told to read the result even when nothing was refused", async () => {
    const out = await SW.elaborate(["File the I-130"], {
      think: async () => ({ text: "We will prepare and file your Form I-130 petition with USCIS, together with the supporting documents and the cover letter that accompanies it." }),
    });
    assert.ok(out.notes.some((n) => /Read them before saving/.test(n)),
      "nothing reminds the drafter that this is what the firm is promising");
  });

  // ── how it is wired ───────────────────────────────────────

  await check("the handoff runs on send, not on save", () => {
    const page = read("retainer-page.js");
    const send = page.indexOf('app.post(PAGE + "/:id/send"');
    const save = page.indexOf('app.post(PAGE + "/new"');
    assert.ok(send > -1 && save > -1, "the routes moved");
    const inSend = page.slice(send, send + 2600);
    assert.ok(/retainer-handoff/.test(inSend), "sending does not file anything");
    const inSave = page.slice(save, save + 1200);
    assert.ok(!/retainer-handoff/.test(inSave),
      "saving a draft creates a case and an invoice; a discarded draft would leave both behind");
  });

  await check("a handoff failure cannot stop an agreement going out", () => {
    const page = read("retainer-page.js");
    const i = page.indexOf('app.post(PAGE + "/:id/send"');
    const block = page.slice(i, i + 2600);
    assert.ok(/try\s*\{[\s\S]*retainer-handoff[\s\S]*\}\s*catch/.test(block),
      "the handoff is not wrapped, so an accounting error would block a client from signing");
  });

  await check("the scope button carries the live form, and adds no script", () => {
    const page = read("retainer-page.js");
    assert.ok(/formaction="\$\{PAGE\}\/scope\/elaborate"/.test(page),
      "the button does not submit the form it is in, so it cannot see what was typed");
    assert.ok(page.includes('app.post(PAGE + "/scope/elaborate"'), "the route is not mounted");
    // notify-admin.js's rule.
    const body = page.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    assert.ok(!/<script/i.test(body), "the page carries a script tag");
    assert.ok(!/\son(click|change|submit)=/i.test(body), "the page carries an inline handler");
  });

  await check("the scope route saves nothing", () => {
    const page = read("retainer-page.js");
    const i = page.indexOf('app.post(PAGE + "/scope/elaborate"');
    const block = page.slice(i, page.indexOf('app.post(PAGE + "/new"', i));
    assert.ok(!/saveDraft|INSERT|UPDATE/i.test(block),
      "an expansion is written to the database instead of being shown for approval");
  });

  await check("the check is registered the way every check here is", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.scripts["check:retainer-handoff"], "no npm script");
    assert.ok(pkg.scripts["test:chain"].includes("check-retainer-handoff.js"), "not in the chain");
    assert.ok(read(".github/workflows/ci.yml").includes("check-retainer-handoff.js"), "not in CI");
  });

  console.log(`\n${passed} checks passed\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });
