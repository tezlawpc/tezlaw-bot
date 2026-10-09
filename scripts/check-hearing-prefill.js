/**
 * check-hearing-prefill.js
 * ─────────────────────────────────────────────────────────
 * "when creating hearings from client's profile, automatically pull
 *  client's information." (JJ, 2026-10-08)
 *
 * The two buttons on a client profile carried ?prefill_a and ?prefill_name
 * for months and neither route read them, so the prefill looked done and
 * wasn't. Most of what follows is about the other half of the job: what a
 * prefill must NOT put in a box.
 *
 * A hearing note is read later as the record of what happened. A date or a
 * time that arrived by inference, not from the notice, is how a client is
 * told the wrong day — see the header of court-calendar.js.
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

const P = require(path.join(ROOT, "hearing-prefill.js"));

// A client as client-profiles.getClientByKey hands one over: contact
// details at the top, hearings newest-first.
const client = () => ({
  key: "a-a123456789",
  client_name: "Chen, Xifen",
  a_number: "A123-456-789",
  client_email: "xifen@example.com",
  client_phone: "626-555-0123",
  client_address: "1234 Garvey Ave, West Covina, CA 91790",
  client_language: "zh",
  case_types: ["Asylum (I-589)"],
  judges: ["Hom, Howard C."],
  hearings: [
    { id: 9, kind: "individual", hearing_date: "2026-08-14T00:00:00.000Z",
      case_type: "Asylum (I-589)", judge_name: "Hom, Howard C.",
      court_location: "Santa Ana Immigration Court",
      court_address: "1241 E. Dyer Road, Suite 200, Santa Ana, CA 92705" },
    { id: 4, kind: "master", hearing_date: "2026-02-03T00:00:00.000Z",
      case_type: "Asylum (I-589)", judge_name: "Riley, Kevin W.",
      court_location: null, court_address: null },
  ],
});

console.log("\nWhat a new hearing note already knows, and what it must ask\n");

// ── what gets pulled ────────────────────────────────────────

check("the client's own details come across", () => {
  const { prev } = P.prefillFromClient(client(), { form: "individual" });
  assert.strictEqual(prev.client_name, "Chen, Xifen");
  assert.strictEqual(prev.a_number, "A123-456-789");
  assert.strictEqual(prev.client_email, "xifen@example.com");
  assert.strictEqual(prev.client_phone, "626-555-0123");
  assert.ok(/Garvey/.test(prev.client_address), "the address did not come across");
  assert.strictEqual(prev.client_language, "zh",
    "the language did not come across, so the client summary would be written in English");
});

check("the judge and the court are the most recent ones, not the first", () => {
  // hearings is newest-first. Taking hearings[hearings.length - 1] would
  // put the judge from February on a hearing being created in October,
  // after the case had already moved to another.
  const { prev } = P.prefillFromClient(client(), { form: "individual" });
  assert.strictEqual(prev.judge_name, "Hom, Howard C.");
  assert.strictEqual(prev.court_location, "Santa Ana Immigration Court");
  assert.ok(/1241 E\. Dyer/.test(prev.court_address), "the court address did not come across");
});

check("a field only an older hearing recorded still comes across", () => {
  // The newest hearing has no court; an older one does. An empty box when
  // the answer is on file is the thing this was built to stop. This is the
  // ordinary case, not a contrived one: a master hearing row carries no
  // court at all, so for most clients the court is on an older row.
  const c = client();
  c.hearings.unshift({
    id: 11, kind: "master", hearing_date: "2026-09-30T00:00:00.000Z",
    case_type: "Asylum (I-589)", judge_name: "Hom, Howard C.",
    court_location: null, court_address: null,
  });
  const { prev } = P.prefillFromClient(c, { form: "individual" });
  assert.strictEqual(prev.court_location, "Santa Ana Immigration Court",
    "a value recorded on an earlier hearing was dropped");
});

check("each case field says which hearing it came from", () => {
  // Without this the banner cannot tell staff what to check, and a judge
  // nobody checked is worse than a blank.
  const { filled } = P.prefillFromClient(client(), { form: "individual" });
  const judge = filled.find((f) => f.field === "judge_name");
  assert.ok(judge, "the judge is not reported as filled");
  assert.strictEqual(judge.from, "2026-08-14", "the judge does not carry its hearing's date");
  // Pacific, not UTC: a hearing stored at midnight UTC is still the 13th in
  // California if this converts, and the banner would name the wrong day.
  const name = filled.find((f) => f.field === "client_name");
  assert.strictEqual(name.from, null, "a client detail was attributed to one hearing");
});

check("the master form is not handed fields it does not have", () => {
  // renderNoteForm has no court inputs. A court_location in its `prev` is
  // silently dropped, which is the kind of thing that reads as working.
  const { prev } = P.prefillFromClient(client(), { form: "master" });
  assert.ok(!("court_location" in prev), "the master form was handed a court");
  assert.ok(!("court_address" in prev), "the master form was handed a court address");
  assert.strictEqual(prev.judge_name, "Hom, Howard C.", "the master form lost the judge");
  assert.strictEqual(prev.case_type, "Asylum (I-589)", "the master form lost the case type");
});

// ── what must never be pulled ───────────────────────────────

check("no date, time or hearing type is ever prefilled", () => {
  // The one rule this file exists to hold. A hearing being created has no
  // notice yet, so there is no date to carry; a plausible one in the box is
  // how a client gets told the wrong day.
  const c = client();
  // Even if a caller hands over a client record carrying them.
  c.hearing_date = "2026-11-02";
  c.hearing_time = "09:00";
  c.next_hearing_date = "2027-01-05";
  c.hearing_type = "individual/merits";
  c.hearings[0].hearing_date = "2026-08-14T00:00:00.000Z";
  for (const form of ["master", "individual"]) {
    const { prev } = P.prefillFromClient(c, { form });
    for (const f of ["hearing_date", "hearing_time", "hearing_type",
                     "next_hearing_date", "next_hearing_type"]) {
      assert.ok(!(f in prev), `${f} was prefilled on the ${form} form`);
    }
  }
});

check("nothing about what happened at a hearing is carried forward", () => {
  const c = client();
  c.disposition = "continued";
  c.raw_notes = "IJ granted a continuance";
  c.applications = ["I-589"];
  c.removability_conceded = true;
  const { prev } = P.prefillFromClient(c, { form: "individual" });
  for (const f of ["disposition", "disposition_notes", "raw_notes", "applications",
                   "pleadings_method", "client_attendance", "removability_conceded",
                   "bond_amount", "bond_outcome"]) {
    assert.ok(!(f in prev), `${f} was carried into a new hearing`);
  }
});

check("the never-list and the pulled-list do not overlap", () => {
  // Otherwise a later edit adds a field to both and whichever runs last wins.
  const pulled = new Set([...P.CLIENT_FIELDS, ...P.CASE_FIELDS.master,
                          ...P.CASE_FIELDS.individual].map(([f]) => f));
  for (const f of P.NEVER) {
    assert.ok(!pulled.has(f), `${f} is both pulled and on the never-list`);
  }
});

check("an empty value is left empty rather than written as a blank", () => {
  const c = client();
  c.client_email = "";
  c.client_phone = null;
  c.client_address = "   ";
  const { prev, filled } = P.prefillFromClient(c, { form: "individual" });
  for (const f of ["client_email", "client_phone", "client_address"]) {
    assert.ok(!(f in prev), `${f} was prefilled with an empty value`);
    assert.ok(!filled.some((x) => x.field === f), `${f} is reported as filled but is empty`);
  }
});

check("no client means a blank form, not a crash", () => {
  const out = P.prefillFromClient(null, { form: "individual" });
  assert.deepStrictEqual(out.prev, {});
  assert.deepStrictEqual(out.filled, []);
  assert.strictEqual(out.source, null);
  assert.strictEqual(P.prefillBanner(out), "", "a banner was rendered for no client");
});

check("a client with no hearings yet still gets their contact details", () => {
  // Dropbox-imported clients and contacts have no hearings at all. They are
  // exactly the ones being given a first hearing.
  const c = { ...client(), hearings: [] };
  const { prev } = P.prefillFromClient(c, { form: "individual" });
  assert.strictEqual(prev.client_name, "Chen, Xifen");
  assert.ok(!("judge_name" in prev), "a judge appeared from a client with no hearings");
});

// ── the banner ──────────────────────────────────────────────

check("the banner says what was filled in and where the case fields came from", () => {
  const out = P.prefillFromClient(client(), { form: "individual" });
  const html = P.prefillBanner(out);
  assert.ok(/Filled in from Chen, Xifen/.test(html), "the banner does not name the client");
  assert.ok(/not filled in/.test(html), "the banner does not say the date is not filled in");
  assert.ok(/from the hearing of 2026-08-14/.test(html),
    "the banner does not say which hearing the judge came from");
  assert.ok(/a judge or a court can change/.test(html),
    "nothing tells staff to check the case fields against today's notice");
  assert.ok(/\/admin\/clients\/a-a123456789/.test(html), "no way back to the client file");
});

check("the banner carries no inline script and survives an apostrophe", () => {
  // notify-admin.js:11. An apostrophe inside an attribute took client
  // search down for five hours on 2026-09-28.
  const c = client();
  c.client_name = "O'Brien, Sean";
  c.client_address = `12 "Main" St & <b>Ave</b>`;
  const html = P.prefillBanner(P.prefillFromClient(c, { form: "individual" }));
  assert.ok(!/onclick|onchange|<script/i.test(html), "the banner carries script");
  assert.ok(!/O'Brien/.test(html) && /O&#39;Brien/.test(html), "an apostrophe is unescaped");
  assert.ok(!/<b>Ave<\/b>/.test(html), "the address is injected as markup");
  assert.ok(!/"Main"/.test(html), "a quote is unescaped");
});

check("a very long value is cut in the banner, not in the form", () => {
  const c = client();
  c.client_address = "A".repeat(300);
  const out = P.prefillFromClient(c, { form: "individual" });
  assert.strictEqual(out.prev.client_address.length, 300, "the form was given a truncated address");
  assert.ok(/…/.test(P.prefillBanner(out)), "the banner prints 300 characters of address");
});

// ── the wiring, which is what was missing before ────────────

check("both quick-create buttons send the client key", () => {
  const src = read("client-profiles.js");
  assert.ok(/client=\$\{encodeURIComponent\(client\.key\)\}/.test(src),
    "the buttons do not send the client key");
  assert.ok(/\/admin\/hearing\/notes\?\$\{createQuery\}/.test(src), "the master button is not wired");
  assert.ok(/\/admin\/hearing\/individual\?\$\{createQuery\}/.test(src), "the individual button is not wired");
});

check("both GET routes actually read it — the bug this started as", () => {
  const src = read("server.js");
  // The master route used to be `res.send(hn.renderNoteForm({}))`, which
  // ignored the query string the buttons had been sending all along.
  assert.ok(!/res\.send\(hn\.renderNoteForm\(\{\}\)\)/.test(src),
    "the master route still throws the prefill away");
  for (const route of ["master", "individual"]) {
    const re = new RegExp(`hearing-prefill[^]*?forRequest\\(req\\.query, \\{ form: "${route}" \\}\\)`);
    assert.ok(re.test(src), `the ${route} route does not resolve a prefill`);
  }
});

check("an older prefill_a / prefill_name link still works", () => {
  // Anything bookmarked or pasted into a message before today sends these.
  const CP = require(path.join(ROOT, "client-profiles.js"));
  assert.strictEqual(CP.clientKey({ aNumber: "A123-456-789" }), "a-a123456789");
  const src = read("hearing-prefill.js");
  assert.ok(/query\.prefill_a/.test(src) && /query\.prefill_name/.test(src),
    "the older link shape is no longer accepted");
});

check("a continuation still prefills from the hearing it continues", () => {
  // ?copy_from names one specific hearing, which is a narrower instruction
  // than "this client". It must win, and its own banner must be the one
  // shown.
  const src = read("server.js");
  const i = src.indexOf("req.query.copy_from");
  const block = src.slice(i, i + 1400);
  assert.ok(/prev = \{/.test(block), "copy_from no longer replaces the prefill");
  assert.ok(/prefillBanner = ""/.test(block), "both banners would show on a continuation");
});

check("the case fields the prefill reads are actually on each hearing row", () => {
  // prefillFromClient reads h.case_type and h.court_address. The aggregate
  // did not carry either until this went in, so the prefill would have been
  // silently empty.
  const src = read("client-profiles.js");
  assert.ok(/case_type: row\.case_type \|\| null/.test(src), "case_type is not on the hearing row");
  assert.ok(/court_address: row\.court_address \|\| null/.test(src), "court_address is not on the hearing row");
  assert.ok(/judge_name, court_location, court_address, disposition/.test(src),
    "court_address is not selected from individual_hearing_notes");
});

check("the app can fill its own form from the same module", () => {
  // "make sure the changes in the web is consistent and updated in the app
  // as well." (JJ) The app composes its own create-note body, so it needs
  // the field set, not a rendered page.
  const src = read("app-api.js");
  assert.ok(/clients\/:key\/hearing-prefill/.test(src), "the app has no prefill endpoint");
  assert.ok(/require\("\.\/hearing-prefill"\)\.prefillFromClient/.test(src),
    "the app endpoint does not use the same module as the web forms");
  assert.ok(/requireBearer, requireFirmUser/.test(src.slice(src.indexOf("hearing-prefill"), src.indexOf("hearing-prefill") + 400)) ||
            /hearing-prefill", requireBearer, requireFirmUser/.test(src),
    "the prefill endpoint is not behind the staff gate");
});

check("both forms have somewhere to put the banner", () => {
  assert.ok(/prefillBanner = ""/.test(read("hearing-notes.js")),
    "renderNoteForm does not accept a banner");
  assert.ok(/\$\{prefillBanner\}/.test(read("hearing-notes.js")),
    "renderNoteForm accepts a banner and never renders it");
  assert.ok(/prefillBanner = ""/.test(read("individual-hearing-notes.js")),
    "renderForm does not accept a banner");
  assert.ok(/\$\{prefillBanner\}/.test(read("individual-hearing-notes.js")),
    "renderForm accepts a banner and never renders it");
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:hearing-prefill"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-hearing-prefill.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-hearing-prefill.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
