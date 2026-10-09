/**
 * check-uscis-g28.js
 * ─────────────────────────────────────────────────────────
 * The G-28 field map, and the fill that uses it.
 *
 * This form goes on every USCIS filing the firm makes, and its internal
 * field names do not match what is printed on the page. Two of them are
 * outright backwards: Line6_EMail is the MOBILE TELEPHONE box and
 * Line7_MobileTelephoneNumber is the EMAIL box. The five appearance
 * checkboxes are all called Line4_Checkbox and print as item 5, and their
 * export values are /R for Requestor and /B for Respondent — so a map built
 * by reading names or letters puts a removal client in the wrong capacity
 * and the attorney's email in the phone box.
 *
 * What does not lie is each field's /TU tooltip, which carries the printed
 * label verbatim. Every entry in the map records the fragment it expects,
 * and the checks below assert all of them against the real form. That is
 * what turns a new edition from a silent mis-fill into a red build.
 *
 * The rest is about what the fill must refuse to do.
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

const G = require(path.join(ROOT, "uscis-g28.js"));
const A = require(path.join(ROOT, "firm-attorneys.js"));

const client = () => ({
  key: "a-a123456789",
  client_name: "Chen, Xifen",
  a_number: "A123-456-789",
  client_email: "xifen@example.com",
  client_phone: "(626) 555-0123",
  client_address: "1234 Garvey Ave, Apt 5B, West Covina, CA 91790",
  case_types: ["Asylum (I-589)"],
});
const matter = () => ({ form_numbers: "I-589", capacity: "applicant", case_type: "Asylum (I-589)" });

async function run() {
  console.log("\nThe G-28: which box is which, and which ones nobody fills but you\n");

  // ── the blank we ship ───────────────────────────────────

  await check("the blank form is in the repo, at the edition the map was built for", () => {
    assert.ok(fs.existsSync(G.BLANK), "forms/g-28.pdf is missing — run scripts/uscis-form-prep.js g-28");
    assert.ok(fs.existsSync(G.DUMP), "forms/g-28.fields.json is missing");
    const info = G.blankInfo();
    assert.strictEqual(info.edition, G.EDITION,
      `the vendored blank is edition ${info.edition} but the map was built for ${G.EDITION} — re-read the labels before changing the constant`);
    assert.ok(info.fields.length > 80, "the dump has suspiciously few fields");
  });

  const dump = G.blankInfo();
  const byName = new Map(dump.fields.map((f) => [f.name, f]));

  // ── the anchor ──────────────────────────────────────────

  await check("every mapped box exists on the form", () => {
    for (const e of G.MAP) {
      assert.ok(byName.has(e.field), `${e.key} points at ${e.field}, which is not on this edition`);
    }
  });

  await check("every mapped box's printed label still says what the map expects", () => {
    // The whole point. A field that moved, was renamed, or had its meaning
    // changed fails here rather than on a filing.
    for (const e of G.MAP) {
      const f = byName.get(e.field);
      assert.ok(f.label, `${e.field} has no tooltip to check against`);
      assert.ok(f.label.includes(e.expect),
        `${e.key} expects a label containing "${e.expect}"\n    but ${e.field} is labelled "${f.label}"`);
    }
  });

  await check("the two fields whose NAMES are backwards are mapped by their LABEL", () => {
    // Line6_EMail is the mobile telephone box. Line7_MobileTelephoneNumber
    // is the email box. Getting this wrong prints the attorney's email
    // address where USCIS reads a phone number.
    const email = G.MAP.find((e) => e.key === "attorney.email");
    const mobile = G.MAP.find((e) => e.key === "attorney.mobile_phone");
    assert.ok(/Line7_MobileTelephoneNumber/.test(email.field),
      "attorney.email was mapped to the field whose name says email, which is the phone box");
    assert.ok(/Line6_EMail/.test(mobile.field),
      "attorney.mobile_phone was mapped to the field whose name says phone, which is the email box");
    assert.ok(byName.get(email.field).label.includes("Enter Email Address"));
    assert.ok(byName.get(mobile.field).label.includes("Enter Mobile Telephone Number"));
  });

  await check("each appearance capacity is the box whose label names it", () => {
    // Five boxes all called Line4_Checkbox, export values /R /A /B /P /BD.
    // /R is Requestor and /B is Respondent, which is the opposite of what
    // the letters suggest.
    const want = {
      applicant: "Select Applicant",
      petitioner: "Select Petitioner",
      requestor: "Select Requestor",
      beneficiary: "Select Beneficiary / Derivative",
      respondent: "Select Respondent",
    };
    for (const [cap, key] of Object.entries(G.CAPACITIES)) {
      const e = G.MAP.find((x) => x.key === key);
      assert.ok(e, `no map entry for ${cap}`);
      assert.ok(byName.get(e.field).label.includes(want[cap]),
        `${cap} points at a box labelled "${byName.get(e.field).label.slice(-60)}"`);
    }
    const fields = Object.values(G.CAPACITIES).map((k) => G.MAP.find((x) => x.key === k).field);
    assert.strictEqual(new Set(fields).size, 5, "two capacities share a box");
  });

  await check("the client's name and address boxes are the printed items, not the field numbers", () => {
    // They print as 6.a-6.c and 13.a-13.h; the fields are called
    // Pt3Line5a-5c and Line12a-12h.
    const fam = G.MAP.find((e) => e.key === "client.family_name");
    assert.ok(/Pt3Line5a/.test(fam.field) && byName.get(fam.field).label.includes("6. A."),
      "the client's family name is not on printed item 6.a");
    const city = G.MAP.find((e) => e.key === "client.city");
    assert.ok(/Line12c/.test(city.field) && byName.get(city.field).label.includes("13. C."),
      "the client's city is not on printed item 13.c");
  });

  // ── what it refuses to touch ────────────────────────────

  await check("the attestation about suspension or restraint is never filled", () => {
    // Part 2, item 1.c. The attorney answers it when they sign.
    for (const n of G.NEVER_FILL) {
      assert.ok(!G.MAP.some((e) => e.field === n.field),
        `${n.field} is on the never-fill list and also in the map — ${n.why}`);
    }
    const amNot = G.NEVER_FILL.find((n) => /Checkbox1dAmNot/.test(n.field));
    const am = G.NEVER_FILL.find((n) => /Checkbox1dAm\[/.test(n.field));
    assert.ok(amNot && am, "item 1.c is not on the never-fill list");
    const p = G.proposeG28({ client: client(), attorney: "jj", matter: matter() });
    assert.ok(p.notes.some((n) => n.level === "yours" && /1\.c/.test(n.text)),
      "nothing tells the signer that 1.c is theirs to answer");
  });

  await check("no signature, signature date, or client notice election is filled", () => {
    for (const re of [/Line1_Signature/, /Line2_SignatureStudent/, /SignatureofApplicant/,
                      /DateofSignature/, /Line3_Date/, /Pt4Line2[abc]_CheckBox/]) {
      assert.ok(!G.MAP.some((e) => re.test(e.field)), `a field matching ${re} is filled in`);
      assert.ok(G.NEVER_FILL.some((n) => re.test(n.field)), `${re} is not on the never-fill list`);
    }
  });

  await check("nothing ever ticks ICE or CBP on its own", () => {
    // An appearance before an Immigration Judge is an EOIR-28, not this
    // form, and ICE or CBP is a deliberate choice.
    assert.ok(!G.MAP.some((e) => /Line2a_ICE|Line3a_CBP/.test(e.field)), "ICE or CBP is mapped");
    const p = G.proposeG28({ client: client(), attorney: "jj",
      matter: { ...matter(), case_type: "Removal defense" } });
    // Assert on the FIELD, not on a substring of the key: "licensing" and
    // "service" both contain "ice", which is how this check first passed
    // itself a false failure.
    const agencyFields = [/Line2a_ICE/, /Line3a_CBP/];
    for (const k of Object.keys(p.values)) {
      const e = G.MAP.find((x) => x.key === k);
      if (!e) continue;
      assert.ok(!agencyFields.some((re) => re.test(e.field)),
        `a removal case ticked ${e.field}`);
    }
    assert.strictEqual(p.values["matter.before_uscis"], "on", "USCIS is not ticked by default");
  });

  await check("the never-fill list names a reason for each box", () => {
    for (const n of G.NEVER_FILL) {
      assert.ok(n.why && n.why.length > 12, `${n.field} is excluded with no reason given`);
      assert.ok(byName.has(n.field), `${n.field} is not on this edition of the form`);
    }
  });

  // ── reading the client record ───────────────────────────

  await check("a phone becomes ten digits, or nothing", () => {
    assert.strictEqual(G.phone("(626) 555-0123"), "6265550123");
    assert.strictEqual(G.phone("+1 626-555-0123"), "6265550123");
    assert.strictEqual(G.phone("626-555-012"), "", "a short number was written to the form anyway");
    assert.strictEqual(G.phone("+86 21 5050 1234"), "", "a foreign number was forced into a US box");
  });

  await check("the A-Number loses its A, because the form prints one", () => {
    assert.strictEqual(G.aNumber("A123-456-789"), "123456789");
    assert.strictEqual(G.aNumber("a 12 345 678"), "12345678");
    assert.strictEqual(G.aNumber("pending"), "", "a non-number was written into the A-Number box");
    assert.strictEqual(G.aNumber("A1234"), "", "a four-digit A-Number was accepted");
  });

  await check("a name with a comma is split, and one without is flagged", () => {
    const a = G.splitName("Chen, Xifen Mei");
    assert.deepStrictEqual([a.family, a.given, a.middle, a.sure], ["Chen", "Xifen", "Mei", true]);
    // "Michael Liu" and a family-first Chinese name look identical. The
    // guess is made but must not be presented as known.
    const b = G.splitName("Michael Liu");
    assert.strictEqual(b.family, "Liu");
    assert.strictEqual(b.sure, false, "a name without a comma was treated as certain");
    const p = G.proposeG28({ client: { ...client(), client_name: "Michael Liu" }, attorney: "jj", matter: matter() });
    assert.ok(p.notes.some((n) => /no comma/.test(n.text)), "the review page does not flag the guess");
  });

  await check("an address is parsed whole or not at all", () => {
    const ok = G.splitAddress("1234 Garvey Ave, Apt 5B, West Covina, CA 91790");
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.street, "1234 Garvey Ave");
    assert.strictEqual(ok.unit_kind, "apartment");
    assert.strictEqual(ok.unit_number, "5B");
    assert.strictEqual(ok.city, "West Covina");
    assert.strictEqual(ok.state, "CA");
    assert.strictEqual(ok.zip, "91790");

    // A street name in the city box reads as filled in and gets signed. An
    // empty box does not.
    for (const bad of ["West Covina CA", "1234 Garvey Ave", "Shanghai, China", ""]) {
      assert.strictEqual(G.splitAddress(bad).ok, false, `"${bad}" was parsed into form boxes`);
    }
    const p = G.proposeG28({ client: { ...client(), client_address: "somewhere in Shanghai" },
      attorney: "jj", matter: matter() });
    for (const k of ["client.street", "client.city", "client.state", "client.zip"]) {
      assert.ok(!(k in p.values), `${k} was filled from an address that could not be read`);
    }
    assert.ok(p.notes.some((n) => /address \(item 13\) is blank/.test(n.text)), "nothing says why the address is blank");
  });

  await check("the capacity is never set from the case type alone", () => {
    // A relative petition has a petitioner and a beneficiary, and only the
    // file says which one is ours.
    const p = G.proposeG28({ client: client(), attorney: "jj",
      matter: { form_numbers: "I-130", case_type: "I-130 family petition" } });
    assert.ok(!Object.values(G.CAPACITIES).some((k) => k in p.values),
      "a capacity box was ticked without anyone choosing it");
    assert.strictEqual(p.suggested_capacity, "petitioner", "no suggestion is offered either");
    assert.ok(p.notes.some((n) => /Item 5/.test(n.text)), "the review page does not ask for it");
  });

  // ── the attorney record ─────────────────────────────────

  await check("each attorney's licensing authority is their own", () => {
    // Chandler is admitted in New York, not California. A G-28 saying
    // California would be a false statement about his admission.
    const jj = G.proposeG28({ client: client(), attorney: "jj", matter: matter() });
    assert.strictEqual(jj.values["attorney.licensing_authority"], "California");
    assert.strictEqual(jj.values["attorney.bar_number"], "326666");
    const cj = G.proposeG28({ client: client(), attorney: "chandler", matter: matter() });
    assert.strictEqual(cj.values["attorney.licensing_authority"], "New York");
    assert.strictEqual(cj.values["attorney.bar_number"], "6238398");
  });

  await check("an unknown attorney fills nothing", () => {
    const p = G.proposeG28({ client: client(), attorney: "nobody", matter: matter() });
    assert.deepStrictEqual(p.values, {}, "a form was filled for an attorney not on file");
    assert.ok(p.notes.some((n) => n.level === "stop"), "nothing says the form cannot be filled");
  });

  // ── the filled form ─────────────────────────────────────

  await check("every value lands in the box whose printed label matches it", async () => {
    // End to end, read back off the produced PDF. This is the check that
    // would have caught the swapped email and phone fields on its own.
    const p = G.proposeG28({ client: client(), attorney: "jj", matter: matter() });
    const out = await G.fillG28(p);
    assert.ok(out.bytes.length > 100000, "the produced file is too small to be the form");
    assert.deepStrictEqual(out.warnings, [], "the fill reported warnings");

    const { PDFDocument, PDFName } = require("pdf-lib");
    const doc = await PDFDocument.load(out.bytes, { ignoreEncryption: true, updateMetadata: false });
    const form = doc.getForm();
    const labelOf = (name) => {
      const f = form.getField(name);
      let tu = f.acroField.dict.get(PDFName.of("TU"));
      if (!tu) { const w = f.acroField.getWidgets()[0]; if (w) tu = w.dict.get(PDFName.of("TU")); }
      return tu && tu.decodeText ? tu.decodeText().replace(/\s+/g, " ") : "";
    };
    const valueOf = (name) => form.getTextField(name).getText() || "";

    const email = G.MAP.find((e) => e.key === "attorney.email").field;
    assert.strictEqual(valueOf(email), "jj@tezlawfirm.com");
    assert.ok(labelOf(email).includes("Enter Email Address"), "the email printed in a box not labelled email");

    const phoneField = G.MAP.find((e) => e.key === "client.daytime_phone").field;
    assert.strictEqual(valueOf(phoneField), "6265550123");
    assert.ok(labelOf(phoneField).includes("Daytime Telephone Number"));

    const fam = G.MAP.find((e) => e.key === "client.family_name").field;
    assert.strictEqual(valueOf(fam), "Chen");
    assert.ok(labelOf(fam).includes("Family Name"), "the family name printed somewhere else");

    const aNum = G.MAP.find((e) => e.key === "client.a_number").field;
    assert.strictEqual(valueOf(aNum), "123456789", "the A-Number kept its A, which the form prints");

    // The capacity: Applicant ticked, and nothing else in item 5.
    const ticked = Object.entries(G.CAPACITIES)
      .filter(([, k]) => form.getCheckBox(G.MAP.find((e) => e.key === k).field).isChecked())
      .map(([cap]) => cap);
    assert.deepStrictEqual(ticked, ["applicant"], "item 5 has the wrong number of boxes ticked: " + ticked.join(", "));

    // And the boxes nobody may tick are still empty.
    for (const n of G.NEVER_FILL) {
      let f;
      try { f = form.getCheckBox(n.field); } catch { continue; }   // text fields handled below
      assert.ok(!f.isChecked(), `${n.field} came back ticked — ${n.why}`);
    }
    for (const n of G.NEVER_FILL) {
      let f;
      try { f = form.getTextField(n.field); } catch { continue; }
      assert.ok(!f.getText(), `${n.field} came back filled — ${n.why}`);
    }
  });

  await check("a long email is written rather than truncated to the box's stated length", async () => {
    // This form's MaxLength values are leftovers from the stripped XFA
    // layer: the email box claims 10 characters. pdf-lib would refuse a
    // real address, and truncating one is worse than refusing.
    const long = "a.very.long.address@tezlawfirm.com";
    const p = G.proposeG28({ client: { ...client(), client_email: long }, attorney: "jj", matter: matter() });
    const out = await G.fillG28(p);
    const { PDFDocument } = require("pdf-lib");
    const doc = await PDFDocument.load(out.bytes, { ignoreEncryption: true, updateMetadata: false });
    const field = G.MAP.find((e) => e.key === "client.email").field;
    assert.strictEqual(doc.getForm().getTextField(field).getText(), long, "the email was cut to fit");
  });

  await check("a form filled for a client with nothing on file is still a valid form", async () => {
    // The usual first G-28: a new client with a name and nothing else.
    const p = G.proposeG28({ client: { client_name: "Wang, Lei" }, attorney: "jj", matter: {} });
    const out = await G.fillG28(p);
    assert.ok(out.bytes.length > 100000);
    assert.ok(out.filled.some((f) => f.key === "client.family_name"));
    assert.ok(p.notes.some((n) => /1\.b/.test(n.text)), "nothing asks for the form numbers");
  });

  await check("every filled value says where it came from", () => {
    const p = G.proposeG28({ client: client(), attorney: "jj", matter: matter() });
    for (const k of Object.keys(p.values)) {
      assert.ok(p.sources[k], `${k} was filled in with no source — the review page cannot show it`);
    }
  });

  // ── the page, and the two routes ────────────────────────

  await check("nothing is produced by looking at the page", () => {
    // The GET must not make a PDF. Only the POST, and only when the button
    // that says so was pressed.
    const src = read("server.js");
    const get = src.slice(src.indexOf('app.get("/admin/clients/:key/g28"'),
                          src.indexOf('app.post("/admin/clients/:key/g28"'));
    assert.ok(!/fillG28/.test(get), "the review page produces the form just by being opened");
    const post = src.slice(src.indexOf('app.post("/admin/clients/:key/g28"'));
    assert.ok(/fillG28/.test(post.slice(0, 2500)), "the POST never produces anything");
    assert.ok(/!== "download" && .*!== "download_flat"/.test(post.slice(0, 2500)),
      "any POST produces a form, including the one that only updates the page");
  });

  await check("the review page shows every value with its source, and no inline script", () => {
    const P = require(path.join(ROOT, "uscis-g28-page.js"));
    const c = { ...client(), key: "a-a123456789" };
    const p = G.proposeG28({ client: c, attorney: "jj", matter: matter() });
    const html = P.renderG28Page(c, p, { attorneyKey: "jj", matter: matter() });

    assert.ok(/jj@tezlawfirm\.com/.test(html), "the page does not show the email that will be printed");
    assert.ok(/326666/.test(html), "the page does not show the bar number");
    assert.ok(/attorney record/.test(html) && /client file/.test(html),
      "the page does not say where values came from");
    assert.ok(/1\.c/.test(html), "the page does not say 1.c is left to the signer");
    assert.ok(/EOIR-28/.test(html), "nothing says Immigration Court uses a different form");
    assert.ok(/09\/17\/18/.test(html), "the page does not state which edition it will produce");

    // notify-admin.js:11.
    assert.ok(!/onclick|onchange=|<script/i.test(html), "the page carries inline script");
    const quoted = { ...c, client_name: "O'Brien, Se\u00e1n" };
    const html2 = P.renderG28Page(quoted, G.proposeG28({ client: quoted, attorney: "jj", matter: matter() }),
      { attorneyKey: "jj", matter: matter() });
    assert.ok(/O&#39;Brien/.test(html2) && !/O'Brien/.test(html2), "an apostrophe is unescaped");
  });

  await check("the client profile has a way in", () => {
    const src = read("client-profiles.js");
    assert.ok(/\/g28"/.test(src), "there is no link to the G-28 from a client file");
  });

  await check("the check is registered the way every check here is", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.scripts["check:uscis-g28"], "no npm script");
    assert.ok(pkg.scripts["test:chain"].includes("check-uscis-g28.js"), "not in the chain");
    assert.ok(read(".github/workflows/ci.yml").includes("check-uscis-g28.js"), "not in CI");
  });

  console.log(`\n${passed} checks passed\n`);
}

run().catch((err) => { console.error(err); process.exit(1); });
