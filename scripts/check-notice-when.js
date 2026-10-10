/**
 * check-notice-when.js
 * ─────────────────────────────────────────────────────────
 * The hearing notices panel on a client's profile, and the one rule it
 * kept breaking.
 *
 * WHAT HAPPENED. JJ opened Pan, Ping's profile on 2026-10-09 and found an
 * individual hearing listed on 10/12/2026 that should not have been there.
 * Tracing it turned up two separate things, and only one of them was a
 * data problem:
 *
 *   The DATA. Two EOIR notices for the same client, read out of two
 *   different supporting PDFs in the same Dropbox folder in the same scan:
 *   notice 5125, 10/12/2026 at North Los Angeles, and notice 5126,
 *   10/22/2029 at the downtown Los Angeles court. The hearing had been
 *   moved. Nothing in the system knows that a later notice supersedes an
 *   earlier one, so both were shown as live.
 *
 *   The CODE. This panel printed every one of them in the wrong zone and
 *   at a computed time. 10:00 showed as "3:00 AM", 13:00 as "6:00 AM",
 *   08:30 as "1:30 AM" -- seven hours early, every hearing in the firm.
 *
 * THE RULE, which this file exists to hold:
 *
 *   A notice's hearing_date is the date and time printed on the notice,
 *   stored with no zone. It is read back in UTC and NEVER converted.
 *   court-calendar.js storedDay(), hearing-when.js and client-record.js
 *   all do this. This panel did not, and it was the only reader that did
 *   not.
 *
 *   A hearing's TIME is quoted from hearing_time_text, never computed.
 *   hearing-when.js carries the long version: a client told the wrong
 *   hour misses the hearing, and for a detained client that is not a
 *   usability problem.
 *
 * The helpers are pulled out of the SERVED page rather than read off the
 * source, because a correct function that never reaches the browser fixes
 * nothing.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const CP = require(path.join(ROOT, "client-profiles.js"));

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (err) { console.log("  FAIL  " + name); throw err; }
  console.log("  ok  " + name);
  passed++;
}

console.log("\nHearing notices, as a client's profile states them\n");

// A client with nothing in it: the panel's script is on the page either way,
// because the notices arrive by fetch after the page loads.
const sample = {
  key: "n-pan-ping", client_name: "Pan, Ping", a_number: null,
  client_email: null, client_phone: null, client_address: null,
  client_language: null, case_types: [], judges: [],
  hearings: [], upcoming: [], deadlines: [], sent_count: 0,
  hearing_count: 0, most_recent_date: null, most_recent_disposition: null,
};
const page = CP.renderClientDetail(sample, { documents: [] });

// The three helpers, lifted from the page and evaluated as the browser would.
function helpers() {
  const from = page.indexOf("function noticeDay(");
  const to = page.indexOf("function renderNotices(");
  assert.ok(from > -1, "noticeDay is not on the served page");
  assert.ok(to > from, "renderNotices no longer follows the helpers");
  const src = page.slice(from, to);
  // eslint-disable-next-line no-new-func
  return new Function(src + "; return { noticeDay, noticeTime, noticeWhen };")();
}

check("the date is read in UTC, so it is the date on the notice", () => {
  const { noticeWhen } = helpers();
  // Midnight is the hard case: read in any zone behind UTC it is the day
  // before, which is how a hearing with no stated time landed on the wrong
  // day on this panel.
  assert.strictEqual(
    noticeWhen({ hearing_date: "2026-10-12T00:00:00.000Z", hearing_time_text: null }),
    "Mon, Oct 12, 2026 — time not confirmed",
    "a notice with no time is shown on the wrong day, or invents a time");
});

check("Pan, Ping's three real notices read back as the notices stated them", () => {
  const { noticeWhen } = helpers();
  // The rows as they actually are in the database, ids 5533, 5125 and 5126.
  // This panel showed these as 1:30 AM, 3:00 AM and 6:00 AM.
  assert.strictEqual(
    noticeWhen({ hearing_date: "2026-06-16T08:30:00.000Z", hearing_time_text: "08:30" }),
    "Tue, Jun 16, 2026 at 8:30 AM");
  assert.strictEqual(
    noticeWhen({ hearing_date: "2026-10-12T10:00:00.000Z", hearing_time_text: "10:00" }),
    "Mon, Oct 12, 2026 at 10:00 AM");
  assert.strictEqual(
    noticeWhen({ hearing_date: "2029-10-22T13:00:00.000Z", hearing_time_text: "13:00" }),
    "Mon, Oct 22, 2029 at 1:00 PM");
});

check("the time is quoted from the notice, not computed from the timestamp", () => {
  const { noticeTime } = helpers();
  // The text wins even where the two disagree. The text is what the notice
  // said; the timestamp is a stored copy of it, and the text is the one a
  // human read off the page.
  assert.strictEqual(
    noticeTime({ hearing_date: "2026-10-12T10:00:00.000Z", hearing_time_text: "9:00 AM" }),
    "9:00 AM", "the panel preferred the timestamp over the notice's own words");
  assert.strictEqual(noticeTime({ hearing_date: null, hearing_time_text: "1:30 PM" }), "1:30 PM");
});

check("an ambiguous one-digit 24-hour time is refused, not guessed", () => {
  const { noticeTime } = helpers();
  // "9:00" is 9 AM or 9 PM depending on the notice. Guessing it is the bug
  // that told a client noon for a 9:00 AM custody hearing. With no
  // timestamp to fall back on there is no time, and the panel says so.
  assert.strictEqual(
    noticeTime({ hearing_date: null, hearing_time_text: "9:00" }), null,
    "a one-digit 24-hour time was guessed at");
  // And a parser artefact is not repeated as a hearing time.
  assert.strictEqual(noticeTime({ hearing_date: null, hearing_time_text: "99:99 AM" }), null);
  assert.strictEqual(noticeTime({ hearing_date: null, hearing_time_text: "25:00" }), null);
});

check("midnight means no time was given, not twelve at night", () => {
  const { noticeTime } = helpers();
  assert.strictEqual(
    noticeTime({ hearing_date: "2026-10-12T00:00:00.000Z", hearing_time_text: null }), null,
    "a date-only notice is being shown as a midnight hearing");
});

check("nothing on the page formats a hearing in whatever zone it is read in", () => {
  // The two calls that caused this: toLocaleString(undefined, ...) in the
  // browser, and a bare toLocaleString()/toLocaleDateString() on the
  // server. Both read a zoneless stored date in the ambient zone -- right
  // on Render, which runs UTC, wrong on a laptop in Los Angeles.
  //
  // Comments are stripped first. The explanation above noticeDay names the
  // bad call in order to describe it, and a check that a comment can
  // satisfy, or break, is not checking the code.
  const code = page.replace(/^\s*\/\/.*$/gm, "");
  const bad = code.match(/toLocaleString\(\s*(undefined|\))/g) || [];
  assert.deepStrictEqual(bad, [],
    `a hearing date is formatted without naming a zone: ${bad.join(", ")}`);
  // Every remaining date formatter on a stored hearing date names UTC.
  const from = page.indexOf("function noticeDay(");
  const to = page.indexOf("function renderNotices(");
  assert.ok(/timeZone: "UTC"/.test(page.slice(from, to)), "noticeDay does not name UTC");
  const src = read("client-profiles.js");
  assert.ok(/function storedDayText/.test(src) && /function storedWhenText/.test(src),
    "the server-side pair that reads a stored date in UTC is gone");
});

check("the dates the server prints are read in UTC too", () => {
  // The All Hearings table and the upcoming list used a bare
  // toLocaleString(). Same stored value, same rule.
  const withHearing = CP.renderClientDetail({
    ...sample,
    hearings: [{
      id: 1, kind: "individual", type_label: "individual",
      hearing_date: "2026-10-12T10:00:00.000Z", judge_name: "Ruane, Rachel Ann",
      case_type: null, court_location: null, court_address: null,
      disposition: null, sent: false, created_at: "2026-08-30T10:43:26.082Z",
      edit_url: "/admin/hearing/individual/1",
    }],
    upcoming: [{ date: "2029-10-22T13:00:00.000Z", type: "individual", from_id: 1, from_kind: "individual" }],
    hearing_count: 1, most_recent_date: "2026-10-12T10:00:00.000Z",
  }, { documents: [] });
  assert.ok(withHearing.includes("Oct 12, 2026 at 10:00 AM"),
    "the hearings table is not stating the stored date and time");
  assert.ok(withHearing.includes("Oct 22, 2029 at 1:00 PM"),
    "the upcoming list is not stating the stored date and time");
  // And not the seven-hours-early version of either. Comments stripped:
  // the explanation in the panel's own source quotes "3:00 AM" as the
  // wrong answer it was giving, and a check a comment can fail is not
  // checking the code.
  const shipped = withHearing.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/3:00 AM/.test(shipped) && !/6:00 AM/.test(shipped),
    "a hearing is still being shifted out of the zone it was stored in");
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:notice-when"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-notice-when.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-notice-when.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
