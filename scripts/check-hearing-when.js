/**
 * check-hearing-when.js
 *
 * A reminder for a custody redetermination at Imperial said "Tuesday,
 * October 6, 2026 at 12:00 PM". The notice said 9:00 AM. The hearing was the
 * next day and the client was detained.
 *
 * Two faults made that one sentence:
 *   · hearing_time_text held "9:00 AM", parsed correctly from the PDF, and
 *     neither message builder ever read it
 *   · both formatted hearing_date — 12:00:00Z, a date-only placeholder at
 *     noon UTC — with toLocaleString and no timeZone, and Render runs UTC,
 *     so noon UTC printed as "12:00 PM" and read like a real time
 *
 * So the number a client was given was not a mis-converted time. It was a
 * time that never existed, invented from a placeholder, while the real one
 * sat unread in the next column.
 *
 * Most of this file is behavioural, because hearing-when.js is pure and
 * there is no excuse for testing a pure function by grepping it. The last
 * few cases are source assertions, and they guard the one invariant that
 * keeps this from coming back: in a client-facing message a time is QUOTED,
 * never formatted from a timestamp.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const { hearingWhen, hearingKind, quotedTime } = require(path.join(ROOT, "hearing-when.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The row that caused this, exactly as it came out of the database.
const WANG = {
  hearing_date: "2026-10-06T12:00:00.000Z",
  hearing_time_text: "9:00 AM",
  hearing_type: "Custody Redetermination Hearing",
};

console.log("\nHearing date and time: quoted, never computed\n");

// ── The bug itself ─────────────────────────────────────────

check("the notice's own time is what the client is told", () => {
  const out = hearingWhen(WANG, "en");
  assert.ok(out.includes("9:00 AM"), out);
  assert.ok(out.includes("Tuesday, October 6, 2026"), out);
});

check("the time that was never real does not appear", () => {
  // Noon UTC must never surface as a clock time, in any language.
  for (const lang of ["en", "zh", "es"]) {
    const out = hearingWhen(WANG, lang);
    assert.ok(!/12:00/.test(out), `${lang}: ${out}`);
  }
});

check("a date-only value at midnight UTC does not slip to the day before", () => {
  // The other half of the same mistake: formatting a date-only value in a
  // zone behind UTC prints yesterday. Imperial is UTC-7 in October.
  const out = hearingWhen({ hearing_date: "2026-10-06T00:00:00.000Z", hearing_time_text: "9:00 AM" }, "en");
  assert.ok(out.includes("October 6"), out);
  assert.ok(!out.includes("October 5"), out);
});

// ── Refusing to state a time it does not have ──────────────

check("no time text means no time, and the firm's number instead", () => {
  // A master hearing from next_hearing_date has no time column at all. The
  // honest output is not a guess.
  const out = hearingWhen({ hearing_date: WANG.hearing_date }, "en");
  assert.ok(/time not confirmed/i.test(out), out);
  assert.ok(out.includes("626-678-8677"), "a client told 'unconfirmed' needs somewhere to call");
  assert.ok(!/\d{1,2}:\d{2}\s*(AM|PM)/i.test(out), `a time was invented: ${out}`);
});

check("every language says so, and carries the number", () => {
  for (const lang of ["en", "zh", "es"]) {
    const out = hearingWhen({ hearing_date: WANG.hearing_date }, lang);
    assert.ok(out.includes("626-678-8677"), `${lang}: ${out}`);
  }
});

check("a time the parser mangled is dropped, not repeated to a client", () => {
  for (const bad of ["see notice", "TBD", "9:00", "morning", "99:99 AM",
                     "0:15 PM", "13:00 PM", "9:75 AM", "   "]) {
    assert.strictEqual(quotedTime(bad), null, `${JSON.stringify(bad)} was passed through`);
  }
});

check("the shapes a notice really uses are kept", () => {
  assert.strictEqual(quotedTime("9:00 AM"), "9:00 AM");
  assert.strictEqual(quotedTime("9 AM"), "9 AM");
  assert.strictEqual(quotedTime("  9:00am "), "9:00 AM");   // normalised
  assert.strictEqual(quotedTime("1:30 p.m."), "1:30 PM");
});

check("a missing date is admitted, not rendered as the epoch", () => {
  for (const lang of ["en", "zh", "es"]) {
    const out = hearingWhen({ hearing_date: null }, lang);
    assert.ok(!/1970/.test(out), out);
    assert.ok(out.includes("626-678-8677"), out);
  }
  assert.ok(!/Invalid/.test(hearingWhen({ hearing_date: "not a date" }, "en")));
});

check("a row that is missing entirely does not throw", () => {
  // This runs inside an unattended cron; an exception there is a silent
  // skipped reminder.
  for (const row of [undefined, null, {}]) {
    assert.strictEqual(typeof hearingWhen(row, "en"), "string");
  }
});

// ── "your upcoming hearing hearing" ────────────────────────

check("a notice's own hearing type is kept, and not doubled", () => {
  // The templates supply the word "hearing" themselves.
  assert.strictEqual(hearingKind("Custody Redetermination Hearing", "en"), "Custody Redetermination");
  assert.strictEqual(hearingKind("Master Calendar Hearings", "en"), "Master Calendar");
});

check("the short keys still read as they did", () => {
  assert.strictEqual(hearingKind("bond", "en"), "Bond");
  assert.strictEqual(hearingKind("individual", "en"), "Individual/Merits");
  assert.strictEqual(hearingKind("bond", "es"), "Fianza");
});

check("an empty type falls back without inventing a kind", () => {
  assert.strictEqual(hearingKind("", "en"), "hearing");
  assert.strictEqual(hearingKind(null, "es"), "audiencia");
});

// ── Both senders come through here ─────────────────────────

const notices = fs.readFileSync(path.join(ROOT, "hearing-notices.js"), "utf8");
const reminders = fs.readFileSync(path.join(ROOT, "hearing-reminders.js"), "utf8");

check("both message builders use the shared module", () => {
  for (const [name, src] of [["hearing-notices.js", notices], ["hearing-reminders.js", reminders]]) {
    assert.ok(/require\("\.\/hearing-when"\)/.test(src), `${name} does not use it`);
    assert.ok(/hearingWhen\(/.test(src), `${name} does not call hearingWhen`);
  }
});

check("neither keeps its own copy of the formatter", () => {
  // Two copies of this code is how one bug became two.
  assert.ok(!/function formatDate\(dt, lang\)/.test(notices));
  assert.ok(!/function formatDateForLang\(dt, lang\)/.test(reminders));
});

check("NO client-facing clock time is formatted from a timestamp", () => {
  // The invariant. toLocaleString with hour/minute over a date-only value is
  // precisely what printed 12:00 PM, and it is unsafe even over a real
  // instant unless the court's zone is known. Times are quoted here.
  for (const [name, src] of [["hearing-notices.js", notices], ["hearing-reminders.js", reminders]]) {
    const calls = src.match(/toLocale(String|TimeString)\([^)]*\)/g) || [];
    assert.deepStrictEqual(calls, [], `${name} formats a time: ${calls.join(", ")}`);
    assert.ok(!/hour: "numeric"/.test(src), `${name} still asks for an hour`);
  }
});

check("the reminder query carries the notice's time text", () => {
  // Without this column in the SELECT, hearingWhen would correctly but
  // uselessly report every automated reminder as "time not confirmed".
  assert.ok(/n\.hearing_time_text/.test(reminders),
    "the one source that has a parsed time must select it");
});

check("the unattended path is the one that matters most", () => {
  // Kept as a note in the file, because the next person to touch these
  // templates should know nobody reads them before they are sent.
  assert.ok(/startCron|7 AM Pacific/.test(reminders));
  const mod = fs.readFileSync(path.join(ROOT, "hearing-when.js"), "utf8");
  assert.ok(/unattended|cron/.test(mod), "hearing-when.js does not say why this is load-bearing");
  assert.ok(/9:00 AM/.test(mod) && /12:00 PM/.test(mod),
    "the concrete case belongs in the file, not only in a commit message");
});

console.log(`\n${passed} checks passed\n`);
