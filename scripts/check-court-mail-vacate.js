/**
 * check-court-mail-vacate.js
 *
 * Taking a hearing OFF the calendar when a notice says so.
 *
 * Court mail already put hearings and deadlines on the calendar by itself.
 * What it never did was take one away. The reading had one line about it —
 *
 *     "A hearing that was VACATED or taken off calendar is not a hearing:
 *      say so in the summary instead."
 *
 * — and cleanReading dropped the date with a note. So a continuance produced
 * exactly half an update: the new date went on, the old one stayed, and the
 * matter carried two hearings until somebody spotted it by hand. The stale
 * date then showed up in the calendar, in the board's "next due" chip and in
 * the reminder digests. A hearing nobody is going to is worse than no hearing
 * at all, because it hides the one that matters.
 *
 * THE ASYMMETRY THIS FILE IS BUILT AROUND
 * Being wrong about adding a hearing leaves a spare date on a calendar, which
 * somebody notices. Being wrong about removing one means nobody appears. So a
 * vacatur is held to the same evidence standard as an addition — the quote
 * must be in the document and must itself say that date — and nothing about it
 * is ever inferred.
 *
 * The specific trap guarded below: "continued to March 3" is evidence FOR the
 * March 3 hearing. Read as vacating language it would take the replacement
 * off the calendar the moment it was set.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const cm = require(path.join(ROOT, "court-mail.js"));
const { cleanReading, buildPrompt, eoirReading } = cm;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const src = fs.readFileSync(path.join(ROOT, "court-mail.js"), "utf8");

// A reading as the model returns it, with the source text it must be backed by.
function read(o, text) {
  return cleanReading({ is_court_mail: true, agency: "state_court", kind: "order", title: "t", summary: "s", ...o }, text);
}

console.log("\nCourt mail: hearings coming off the calendar\n");

// ── A plain vacatur ────────────────────────────────────────

const VACATE_TEXT =
  "NOTICE: The Case Management Conference set for March 3, 2027 at 8:30 AM in Department 52 " +
  "is hereby VACATED. No appearance is required.";

check("a vacated hearing is reported as vacated, not added", () => {
  const r = read({
    vacated: [{ date: "2027-03-03", type: "Case Management Conference", disposition: "vacated",
                evidence: "set for March 3, 2027 at 8:30 AM in Department 52 is hereby VACATED" }],
  }, VACATE_TEXT);
  assert.strictEqual(r.hearings.length, 0);
  assert.strictEqual(r.vacated.length, 1);
  assert.strictEqual(r.vacated[0].date, "2027-03-03");
  assert.strictEqual(r.vacated[0].disposition, "vacated");
  assert.strictEqual(r.vacated[0].replaced_by, null);
});

check("a hearing the model mislabels as upcoming, with vacating evidence, still comes off", () => {
  // The old code dropped this with a note and nothing happened. The model
  // does put vacated hearings in `hearings` sometimes, so the reroute stays.
  const r = read({
    hearings: [{ date: "2027-03-03", type: "CMC",
                 evidence: "set for March 3, 2027 at 8:30 AM in Department 52 is hereby VACATED" }],
  }, VACATE_TEXT);
  assert.strictEqual(r.hearings.length, 0, "it must not be put on the calendar");
  assert.strictEqual(r.vacated.length, 1, "and it must not be silently dropped either");
  assert.strictEqual(r.vacated[0].date, "2027-03-03");
});

check("cancelled, off calendar, stricken and struck all count", () => {
  for (const word of ["is CANCELLED", "is taken off calendar", "is hereby stricken", "is struck from the calendar"]) {
    const text = `The hearing set for March 3, 2027 ${word}.`;
    const r = read({ hearings: [{ date: "2027-03-03", type: "CMC", evidence: `set for March 3, 2027 ${word}` }] }, text);
    assert.strictEqual(r.hearings.length, 0, `"${word}" left the hearing on the calendar`);
    assert.strictEqual(r.vacated.length, 1, `"${word}" was not recorded as off calendar`);
  }
});

// ── The trap: a continuance ────────────────────────────────

const CONTINUE_TEXT =
  "The Case Management Conference previously set for March 3, 2027 is CONTINUED to " +
  "June 14, 2027 at 9:00 AM in Department 52.";

check("'continued to <date>' is evidence FOR that date, not against it", () => {
  // The one thing that must not happen: the replacement hearing being read as
  // a vacatur and taken off the calendar the moment it is set.
  const r = read({
    hearings: [{ date: "2027-06-14", time: "9:00 AM", type: "Case Management Conference", department: "52",
                 evidence: "is CONTINUED to June 14, 2027 at 9:00 AM in Department 52" }],
  }, CONTINUE_TEXT);
  assert.strictEqual(r.hearings.length, 1, "the new date must go on the calendar");
  assert.strictEqual(r.hearings[0].date, "2027-06-14");
  assert.strictEqual(r.vacated.length, 0, "and must not be treated as coming off it");
});

check("a continuance records both halves", () => {
  const r = read({
    hearings: [{ date: "2027-06-14", time: "9:00 AM", type: "Case Management Conference",
                 evidence: "is CONTINUED to June 14, 2027 at 9:00 AM in Department 52" }],
    vacated: [{ date: "2027-03-03", type: "Case Management Conference", disposition: "continued",
                replaced_by: "2027-06-14",
                evidence: "previously set for March 3, 2027 is CONTINUED to June 14, 2027" }],
  }, CONTINUE_TEXT);
  assert.strictEqual(r.hearings.length, 1);
  assert.strictEqual(r.vacated.length, 1);
  assert.strictEqual(r.vacated[0].disposition, "continued");
  assert.strictEqual(r.vacated[0].replaced_by, "2027-06-14");
});

check("a replacement date the document does not state is refused", () => {
  // A continuance carrying an invented new date would put a hearing on the
  // calendar nobody has been noticed for.
  const r = read({
    vacated: [{ date: "2027-03-03", type: "CMC", disposition: "continued",
                replaced_by: "2027-07-01",
                evidence: "previously set for March 3, 2027 is CONTINUED" }],
  }, "The CMC previously set for March 3, 2027 is CONTINUED. A new date will issue.");
  assert.strictEqual(r.vacated.length, 1, "the old date still comes off");
  assert.strictEqual(r.vacated[0].replaced_by, null, "but no unstated date is carried forward");
});

check("a replacement date is accepted when it is also a confirmed hearing", () => {
  const r = read({
    hearings: [{ date: "2027-06-14", type: "CMC",
                 evidence: "is CONTINUED to June 14, 2027 at 9:00 AM in Department 52" }],
    vacated: [{ date: "2027-03-03", type: "CMC", disposition: "continued", replaced_by: "2027-06-14",
                evidence: "previously set for March 3, 2027 is CONTINUED" }],
  }, CONTINUE_TEXT);
  assert.strictEqual(r.vacated[0].replaced_by, "2027-06-14");
});

// ── The evidence standard ──────────────────────────────────

check("a vacatur with no quote in the document is thrown away", () => {
  const r = read({
    vacated: [{ date: "2027-03-03", type: "CMC", disposition: "vacated",
                evidence: "the hearing is vacated per the court's own motion" }],
  }, "An unrelated notice of case reassignment.");
  assert.strictEqual(r.vacated.length, 0);
  assert.ok(r.dropped.some(d => /off calendar 2027-03-03/.test(d)), "and it says why it was thrown away");
});

check("a vacatur whose quote does not say that date is thrown away", () => {
  // The quote is in the document, but it is about a different hearing.
  const text = "The hearing set for March 3, 2027 is VACATED.";
  const r = read({
    vacated: [{ date: "2027-04-10", type: "CMC", disposition: "vacated",
                evidence: "The hearing set for March 3, 2027 is VACATED" }],
  }, text);
  assert.strictEqual(r.vacated.length, 0, "the quote must say the date it is being used for");
});

check("an impossible date is thrown away", () => {
  const r = read({
    vacated: [{ date: "2027-02-30", type: "CMC", disposition: "vacated", evidence: "February 30, 2027 is vacated" }],
  }, "February 30, 2027 is vacated");
  assert.strictEqual(r.vacated.length, 0);
});

check("an unrecognised disposition falls back to plain vacated, never to a move", () => {
  const r = read({
    vacated: [{ date: "2027-03-03", type: "CMC", disposition: "banana", replaced_by: "2027-06-14",
                evidence: "set for March 3, 2027 at 8:30 AM in Department 52 is hereby VACATED" }],
  }, VACATE_TEXT);
  assert.strictEqual(r.vacated.length, 1);
  assert.strictEqual(r.vacated[0].disposition, "vacated");
  assert.strictEqual(r.vacated[0].replaced_by, null,
    "an unrecognised disposition must not carry a replacement date forward");
});

check("the same date is not vacated twice", () => {
  const r = read({
    hearings: [{ date: "2027-03-03", type: "CMC", evidence: "set for March 3, 2027 at 8:30 AM in Department 52 is hereby VACATED" }],
    vacated: [{ date: "2027-03-03", type: "CMC", disposition: "vacated", evidence: "set for March 3, 2027 at 8:30 AM in Department 52 is hereby VACATED" }],
  }, VACATE_TEXT);
  assert.strictEqual(r.vacated.length, 1);
});

// ── The model is actually asked for it ─────────────────────

check("the prompt asks for a vacated list", () => {
  const prompt = buildPrompt({ from: "clerk@lacourt.org", subject: "Notice", text: VACATE_TEXT, date: new Date() }, []);
  assert.ok(/"vacated"/.test(prompt));
  assert.ok(/disposition/.test(prompt));
  assert.ok(/replaced_by/.test(prompt));
});

check("the prompt no longer says to put it in the summary and forget it", () => {
  const prompt = buildPrompt({ from: "x@uscourts.gov", subject: "s", text: "t", date: new Date() }, []);
  assert.ok(!/say so in the summary instead/.test(prompt));
  assert.ok(/A continuance is BOTH/.test(prompt), "the two-part nature has to be spelled out");
  assert.ok(/Taking a hearing off a calendar wrongly is worse/.test(prompt),
    "the model should be told which direction of error costs more");
});

// ── Acting on it ───────────────────────────────────────────

check("the vacatur pass runs before the add pass", () => {
  const i = src.indexOf("const offCalendar = [];");
  const j = src.indexOf("const haveH = (await db.query(");
  assert.ok(i > -1 && j > i,
    "a continuance must not leave the matter holding two conflicting dates, even briefly");
});

check("haveH is read after the vacatur, so a replacement is not duplicated", () => {
  const i = src.indexOf("const haveH = (await db.query(");
  const before = src.slice(0, i);
  assert.ok(before.includes("recordOutcome"),
    "recordOutcome creates the replacement hearing itself; reading haveH first would add it twice");
});

check("it uses the hearings module's own recordOutcome, not a raw UPDATE", () => {
  // recordOutcome writes the status, logs to the matter's history, re-points
  // the linked deadline, and carries department/judge/location onto the
  // replacement. A hand-written UPDATE would do none of that.
  assert.ok(/hearings\.recordOutcome\(h\.id, \{/.test(src));
  assert.ok(/status: moving \? "continued" : "vacated"/.test(src));
});

check("only a stated replacement date produces a continuance", () => {
  assert.ok(/const moving = MOVES\.has\(v\.disposition\) && v\.replaced_by;/.test(src),
    "recordOutcome refuses a continuance with no date; without this it would throw per hearing");
});

check("nothing scheduled on that date is reported, not silently ignored", () => {
  assert.ok(/nothing scheduled on \$\{v\.date\} to take off calendar/.test(src));
  const n = (src.match(/nothing scheduled on \$\{v\.date\} to take off calendar/g) || []).length;
  assert.strictEqual(n, 2, "both the civil and the immigration path should say so");
});

check("an immigration hearing notice is dismissed, not deleted", () => {
  assert.ok(/UPDATE client_hearing_notices\s*\n\s*SET dismissed_at = NOW\(\), dismiss_reason = \$3/.test(src),
    "the original notice has to stay in the record");
  assert.ok(/AND dismissed_at IS NULL/.test(src), "and one already dismissed is left alone");
});

check("the reason recorded says it came from a court email, with the words", () => {
  assert.ok(/by court email: \$\{v\.evidence\}/.test(src),
    "somebody checking this later needs the sentence the decision was made on");
  assert.ok(/From court email: "\$\{v\.evidence\}" \(\$\{VERIFY\}\)/.test(src),
    "and the civil note should carry the same, flagged for verification");
});

check("the matter's history names what came off the calendar", () => {
  assert.ok(/Taken off calendar: " \+ offCalendar\.join\(", "\)/.test(src));
});

// ── Undo ───────────────────────────────────────────────────

check("a vacatur can be undone on both paths", () => {
  assert.ok(/a\.type === "civil_hearing_off"/.test(src));
  assert.ok(/a\.type === "client_hearing_off"/.test(src));
  assert.ok(/UPDATE civil_hearings SET status = 'scheduled', continued_to = NULL/.test(src));
  assert.ok(/UPDATE client_hearing_notices SET dismissed_at = NULL, dismiss_reason = NULL/.test(src));
});

check("undoing a continuance does not guess about the replacement", () => {
  const i = src.indexOf('a.type === "civil_hearing_off"');
  const near = src.slice(Math.max(0, i - 500), i);
  assert.ok(/each with its own\s*\n\s*\/\/ Undo/.test(near),
    "the two halves are separate actions; the reason has to stay next to the code");
});

// ── Readings that predate the field ────────────────────────

check("an EOIR receipt carries an empty vacated list", () => {
  // eoirReading builds its reading by hand. Without the field, calendar()
  // iterates undefined on every receipt — and receipts are most of this mail.
  const r = eoirReading(
    { subject: "x", from: "erop@usdoj.gov", html: "", text: "", attachments: [] },
    { received_at: new Date() });
  if (r) assert.ok(Array.isArray(r.vacated));
  assert.ok(/hearings: \[\], deadlines: \[\], suggested: \[\], dropped: \[\], vacated: \[\]/.test(src),
    "the hand-built EOIR reading must declare the field");
});

check("a reading replayed from an older row cannot crash the calendar pass", () => {
  const n = (src.match(/for \(const v of \(reading\.vacated \|\| \[\]\)\)/g) || []).length;
  assert.strictEqual(n, 2, "both paths must tolerate a stored reading from before this field existed");
});

console.log(`\n${passed} checks passed\n`);
