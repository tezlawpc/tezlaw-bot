/**
 * check-uscis-questionnaire.js
 * ─────────────────────────────────────────────────────────
 * A single form, picked on its own and answered as questions.
 *
 * Three of JJ's complaints on 2026-10-09, and what each one pins:
 *
 *   "in each client profile, it should be able to pick forms to file, not
 *    just filing combo"
 *   "its very weird how each form is being created with each client. So
 *    each client portal should be able to pick its own forms
 *    individually, not just combo."
 *      -> there is a picker, it lists every tracked form, and the client
 *         profile links to it.
 *
 *   "when filling out the form, it should be questionaire format with
 *    explanation on the side to assist client to fill out the form. each
 *    question should be saved after client fills them out in case if its
 *    closed or crashed accidently."
 *      -> every question a client is asked carries help text, and the
 *         answers are saved one field at a time.
 *
 * The autosave is the part worth guarding hardest, because the failure is
 * silent: a questionnaire that looks saved and is not costs a client an
 * evening and tells them nothing. So this file checks the mechanism --
 * one key per write, a beacon on unload, a refusal to write a key the
 * form does not ask about -- rather than just that a function exists.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const Q = require(path.join(ROOT, "uscis-questions.js"));
const D = require(path.join(ROOT, "uscis-drafts.js"));
const P = require(path.join(ROOT, "uscis-form-page.js"));
const G = require(path.join(ROOT, "uscis-g28.js"));
const F = require(path.join(ROOT, "uscis-forms.js"));
const CP = require(path.join(ROOT, "client-profiles.js"));

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (err) { console.log("  FAIL  " + name); throw err; }
  console.log("  ok  " + name);
  passed++;
}

console.log("\nOne form, picked on its own and answered as questions\n");

const client = {
  key: "a-201555444", client_name: "Chen, Peng", a_number: "A201555444",
  client_email: "chen@example.com", client_phone: "6265550100",
  client_address: "1 Main St, West Covina, CA 91792", client_language: "zh",
  case_types: ["asylum"], judges: [], hearings: [], upcoming: [], deadlines: [],
  sent_count: 0, hearing_count: 0, most_recent_date: null, most_recent_disposition: null,
};

// ── the question set ────────────────────────────────────────

check("the G-28 comes back as questions in sections", () => {
  const m = Q.questionsFor("g-28");
  assert.ok(m, "the G-28 has no question set");
  assert.deepStrictEqual(m.sections.map((s) => s.id), ["attorney", "matter", "client"]);
  assert.strictEqual(m.edition, G.EDITION, "the questions and the blank disagree about the edition");
  assert.ok(Q.flatten(m).length >= 40, "too few questions to be the whole form");
});

check("every question names a box the field map actually has", () => {
  // The wording lives in uscis-questions.js and the fields live in
  // uscis-g28.js MAP, which check-uscis-g28.js pins to the PDF's own /TU
  // tooltips. A question for a key the MAP does not have is a question
  // whose answer goes nowhere.
  const keys = new Set(G.MAP.map((m) => m.key));
  for (const q of Q.flatten(Q.questionsFor("g-28"))) {
    assert.ok(keys.has(q.key), `asked about a box the form does not have: ${q.key}`);
  }
});

check("a box the form refuses to fill is never asked about", () => {
  // Signatures, dates, the accredited-representative boxes, ICE and CBP.
  // uscis-g28.js NEVER_FILL is the authority and each entry says why.
  const never = new Set(G.NEVER_FILL.map((n) => n.key || n.field || String(n)));
  for (const q of Q.flatten(Q.questionsFor("g-28"))) {
    assert.ok(!never.has(q.key), `asked a question about a box that must stay blank: ${q.key}`);
  }
});

check("nothing is asked twice", () => {
  // The MAP carries the client's name twice: once in Part 3 and again
  // where a later part is pre-populated from it. One question, or the
  // person types their surname, scrolls, and is asked for it again.
  const keys = Q.flatten(Q.questionsFor("g-28")).map((q) => q.key);
  assert.strictEqual(new Set(keys).size, keys.length,
    "the same box is asked about more than once");
});

check("every question has an explanation beside it", () => {
  // The whole of JJ's item 3. A question with no explanation is a USCIS
  // field name in a box, which is what this replaced.
  //
  // No minimum length. "Your city or town." is the entire truth about
  // that box, and a check that demanded twenty characters would be
  // satisfied by padding it -- which makes the help text worse, not
  // better. Length is checked only where the form actively misleads,
  // below.
  for (const q of Q.flatten(Q.questionsFor("g-28"))) {
    assert.ok(q.help && q.help.trim(), `no explanation for ${q.key}`);
  }
});

check("the boxes people get wrong are actually explained", () => {
  // Each of these has a specific trap, and an explanation that only
  // renamed the field would not help anybody:
  //   a_number        the form prints "9. Enter" and wants digits, no A
  //   receipt_number  three letters and ten digits, or empty for a new filing
  //   form_numbers    listing a form you do not file puts the firm on the
  //                   record for something that is not in the envelope
  //   street          USCIS posts the decision here for the next year
  //   the capacities  five boxes, exactly one of which is right
  const help = Object.fromEntries(
    Q.flatten(Q.questionsFor("g-28")).map((q) => [q.key, q.help]));
  const musts = {
    "client.a_number": /without the A/i,
    "client.street": /mail|post/i,
    "client.email": /sign|check/i,
    "matter.receipt_number": /ten digits|new filing/i,
    "matter.form_numbers": /going in the envelope|comma/i,
    "matter.as_applicant": /ONE capacity|only one/i,
    "matter.as_petitioner": /petition|sponsor|employer/i,
    "matter.as_beneficiary": /petition is FOR|derivative/i,
    "matter.as_respondent": /EOIR-28|removal/i,
    "matter.before_uscis": /EOIR-28/,
    "attorney.mobile_phone": /wrong way round|before the email/i,
  };
  for (const [key, pattern] of Object.entries(musts)) {
    assert.ok(help[key], `no question for ${key}`);
    assert.ok(pattern.test(help[key]),
      `the explanation for ${key} does not say what people get wrong: ${JSON.stringify(help[key])}`);
  }
});

check("a question is labelled in words, not by its PDF field name", () => {
  const m = Q.questionsFor("g-28");
  for (const q of Q.flatten(m)) {
    assert.ok(!/form1\[|\]|#subform/.test(q.label), `a PDF field name leaked into a label: ${q.label}`);
    assert.ok(q.label && q.label.length > 2, `no label for ${q.key}`);
  }
  // "9. Enter" is a real printed label on this form and it means the
  // A-Number. The label has to say so.
  const a = Q.flatten(m).find((q) => q.key === "client.a_number");
  assert.ok(/A-Number/i.test(a.label), "the A-Number question is labelled by its useless printed label");
});

check("the state dropdown carries the blank's own options", () => {
  // Read off forms/g-28.fields.json, not typed here. The first version
  // resolved the dump by a relative require and silently got none, which
  // is a state dropdown with no states in it and no error to say so.
  for (const q of Q.flatten(Q.questionsFor("g-28")).filter((x) => x.kind === "select")) {
    assert.ok(q.options && q.options.length > 50,
      `${q.key} is a dropdown with ${q.options ? q.options.length : 0} options`);
    assert.ok(q.options.includes("CA"), `${q.key} has no California in it`);
  }
});

check("a form with no blank on file has no question set, and says so", () => {
  // Nineteen of the twenty. Opening a questionnaire for one would collect
  // forty answers and then have nothing to print them onto.
  assert.strictEqual(Q.questionsFor("i-130"), null);
  assert.strictEqual(P.fillable("i-130"), false);
  assert.strictEqual(P.fillable("g-28"), true);
});

// ── picking one ─────────────────────────────────────────────

check("the picker lists every tracked form", () => {
  const html = P.renderPicker(client, []);
  for (const f of F.FORMS) {
    // The number is the id uppercased. uscis-forms.js has no `number`
    // field, and reading one put "undefined" on every row.
    assert.ok(html.includes(f.id.toUpperCase()), `the picker does not list ${f.id}`);
    assert.ok(html.includes(f.name), `the picker does not name ${f.id}`);
  }
  assert.ok(!/undefined/.test(html), "something on the picker renders as undefined");
  assert.ok(/Start this form/.test(html), "nothing on the picker starts a form");
  assert.ok(/blank not on file yet/.test(html),
    "a form that cannot be filled is offered as though it can");
});

check("the client profile reaches the picker", () => {
  const html = CP.renderClientDetail(client, { documents: [] });
  assert.ok(html.includes(`/admin/clients/${encodeURIComponent(client.key)}/forms`),
    "a client profile has no way to pick a form");
  // The single hardcoded G-28 button is gone: it is reached through the
  // picker like any other form.
  assert.ok(!/>Form G-28</.test(html), "the one-form button is still there");
});

check("the picker shows what is already started, with its progress", () => {
  const draft = {
    id: 7, client_key: client.key, form_id: "g-28", status: "draft",
    label: null, matter_id: null,
    answers: { "client.family_name": "Chen", "client.given_name": "Peng" },
  };
  const html = P.renderPicker(client, [draft]);
  assert.ok(/of \d+ answered/.test(html), "no progress on a started form");
  assert.ok(html.includes("/forms/7"), "no way to reopen a started form");
});

// ── answering it ────────────────────────────────────────────

const model = Q.questionsFor("g-28");
const draft = {
  id: 7, client_key: client.key, form_id: "g-28", status: "draft",
  label: null, matter_id: null,
  answers: { "client.family_name": "Chen", "client.state": "CA", "matter.as_applicant": "yes" },
};

check("each question is drawn with its help text beside it", () => {
  const html = P.renderQuestionnaire(client, draft, model, { section: "client" });
  const q = model.sections.find((s) => s.id === "client").questions
    .find((x) => x.key === "client.a_number");
  assert.ok(html.includes(q.label), "the question is not on the page");
  assert.ok(html.includes("Type the digits without the A"),
    "the explanation is not rendered next to the question");
  assert.ok(/data-draft-row/.test(html), "the rows the autosave marks are not there");
});

check("the answers already given come back in the boxes", () => {
  const html = P.renderQuestionnaire(client, draft, model, { section: "client" });
  assert.ok(html.includes('value="Chen"'), "a saved answer did not come back");
  assert.ok(/<option value="CA" selected>/.test(html), "a saved dropdown did not come back");
  const mh = P.renderQuestionnaire(client, draft, model, { section: "matter" });
  assert.ok(/data-draft-field="matter\.as_applicant" checked/.test(mh),
    "a saved tickbox did not come back ticked");
});

check("every input is wired to the autosave", () => {
  for (const sec of model.sections) {
    const html = P.renderQuestionnaire(client, draft, model, { section: sec.id });
    for (const q of sec.questions) {
      assert.ok(html.includes(`data-draft-field="${q.key}"`),
        `${q.key} is drawn without being wired to the autosave`);
    }
  }
});

check("the page carries no inline script and no onclick", () => {
  // These pages are JavaScript template literals. An apostrophe in an
  // attribute took client search down for five hours on 2026-09-28.
  const html = P.renderQuestionnaire(client, draft, model, {})
    + P.renderPicker(client, [draft]);
  assert.ok(!/onclick=/.test(html), "an onclick is back on one of these pages");
  assert.ok(!/<script>/.test(html), "an inline script is back on one of these pages");
  assert.ok(/<script src="\/static\/form-draft\.js">/.test(
    P.renderQuestionnaire(client, draft, model, {})),
    "the questionnaire does not load the autosave");
});

check("the questionnaire produces nothing by itself", () => {
  // Fill-and-review, like the G-28 page it feeds. The only thing that
  // makes a PDF is the review screen, where every value and its source is
  // shown first.
  const html = P.renderQuestionnaire(client, draft, model, {});
  assert.ok(/Nothing is produced from this page/.test(html),
    "the questionnaire does not say that it produces nothing");
  assert.ok(!/action="[^"]*download/.test(html), "the questionnaire can produce a form directly");
});

// ── saving ──────────────────────────────────────────────────

check("an answer is written one key at a time", () => {
  // Not the whole object. A half-loaded page posting {} would otherwise
  // blank a filled form, and the field being typed when a tab closes is
  // the one case this exists for.
  const src = read("uscis-drafts.js");
  assert.ok(/jsonb_set\(COALESCE\(answers, '\{\}'::jsonb\), ARRAY\[\$2::text\]/.test(src),
    "saveAnswer does not write a single key");
  assert.ok(!/SET answers\s*=\s*\$2::jsonb/.test(src),
    "something replaces the whole answers object");
  // saveAnswers merges rather than replacing, so it cannot blank a field
  // the caller did not mention either.
  assert.ok(/answers\s*=\s*COALESCE\(answers, '\{\}'::jsonb\) \|\| \$2::jsonb/.test(src),
    "saveAnswers replaces instead of merging");
});

check("an emptied box stays empty", () => {
  // A client who clears a prefilled address is telling us the record is
  // wrong. A prefill that creeps back on the next page load is how a form
  // gets filed with a stale address on it.
  const src = read("uscis-drafts.js");
  assert.ok(/to_jsonb\(\$3::text\)/.test(src), "an answer is not stored as given");
  assert.ok(/An empty answer is an answer|AN EMPTY ANSWER IS AN ANSWER/i.test(src),
    "nothing records why an empty answer is kept");
  const server = read("server.js");
  const i = server.indexOf('app.post("/admin/clients/:key/forms"');
  const route = server.slice(i, i + 2600);
  assert.ok(/Seed it|seeded at creation/.test(route),
    "the prefill is not seeded once at creation");
});

check("only a key this form asks about can be written", () => {
  // Otherwise a stale page could write arbitrary keys into the answers and
  // they would ride along into the filled PDF.
  const server = read("server.js");
  const i = server.indexOf('/forms/:id/answer"');
  assert.ok(i > -1, "the answer endpoint is gone");
  const route = server.slice(i, i + 1800);
  assert.ok(/questions\.find\(\(x\) => x\.key === key\)/.test(route),
    "the answer endpoint does not check the key against the form's questions");
  assert.ok(/not a question on this form/.test(route),
    "an unknown key is accepted silently");
});

check("a draft from another client's file is not shown or written", () => {
  const server = read("server.js");
  for (const marker of ['app.get("/admin/clients/:key/forms/:id"', '/forms/:id/answer"']) {
    const i = server.indexOf(marker);
    assert.ok(i > -1, `missing route: ${marker}`);
    const route = server.slice(i, i + 1800);
    assert.ok(/draft\.client_key !== client\.key/.test(route),
      `${marker} does not check the draft belongs to this client`);
  }
});

check("the field being typed when the tab closes is still saved", () => {
  // fetch() is cancelled on unload. sendBeacon is delivered after the page
  // is gone, and it is the only thing that saves the box the person was in
  // the middle of -- the exact case JJ asked about.
  const js = read("public/form-draft.js");
  assert.ok(/navigator\.sendBeacon/.test(js), "nothing saves on unload");
  assert.ok(/pagehide/.test(js), "the unload save is not wired to pagehide");
  assert.ok(/blur/.test(js) && /change/.test(js), "it does not save on leaving a box");
  assert.ok(/setTimeout/.test(js), "a long answer is not saved while it is being typed");
  // And it says so when a save fails, rather than looking saved.
  assert.ok(/Not saved/.test(js), "a failed save is silent");
});

check("progress counts what is answered, not what exists", () => {
  const questions = Q.flatten(model);
  const none = D.progress({ answers: {} }, questions);
  assert.strictEqual(none.done, 0);
  assert.strictEqual(none.total, questions.length);
  const some = D.progress({ answers: { "client.family_name": "Chen", "client.given_name": " " } }, questions);
  assert.strictEqual(some.done, 1, "whitespace counted as an answer");
  assert.ok(some.pct > 0 && some.pct < 100);
});

check("a form can be attached to a matter and billed against it", () => {
  // "also let you attach it to a client and a matter, so it shows on that
  // client's file too and the time can be billed against the matter" (JJ)
  const src = read("uscis-drafts.js");
  assert.ok(/matter_id/.test(src), "a form cannot be attached to a matter");
  assert.strictEqual(typeof D.attachToMatter, "function", "nothing attaches a form to a matter");
  assert.strictEqual(typeof D.listForMatter, "function", "a matter cannot list its forms");
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:uscis-questionnaire"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-uscis-questionnaire.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-uscis-questionnaire.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
