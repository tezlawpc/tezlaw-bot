/**
 * check-hearing-dedup.js
 *
 * "double check the function to add and delete hearings. right now there
 *  are alot of duplicate hearings in the calender."
 *
 * A row in client_hearing_notices does two jobs: it records that a FILE has
 * been read, and that a HEARING exists. Only the first was deduplicated, so
 * the same notice in two Dropbox folders became two hearings and two
 * reminders to the client.
 *
 * What these checks defend:
 *   1. a second copy of a hearing never becomes a second hearing;
 *   2. and never becomes a second message to a client;
 *   3. nothing is deleted to achieve that — these are client records;
 *   4. a merge is reversible, and refuses to merge rows that are not in fact
 *      the same client and date;
 *   5. the firm's crons run on the firm's clock, in both halves of the year.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const notices = read("hearing-notices.js");
const calendar = read("court-calendar.js");
const reminders = read("hearing-reminders.js");
const deadlines = read("deadline-tracker.js");
const backup = read("backup-system.js");
const server = read("server.js");
const mail = read("court-mail.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// The body of scanClientFolder's "this file is a hearing notice" branch.
const scanStart = notices.indexOf("if (extraction.is_hearing_notice && extraction.hearing_date) {");
const scanEnd = notices.indexOf("// Record the non-hearing-notice files too", scanStart);
assert.ok(scanStart > -1 && scanEnd > scanStart, "the scanner's hearing branch moved — fix this check");
const scanBranch = notices.slice(scanStart, scanEnd);

console.log("\nOne hearing, one row\n");

// ── The hearing is deduplicated, not just the file ─────────

check("the scanner asks whether the HEARING is already on file", () => {
  // The old code asked only whether the FILE had been seen, which is a
  // different question and the reason for the duplicates.
  assert.ok(/hearing_date::date = \$2::date/.test(scanBranch),
    "no client-plus-date lookup before the insert");
  assert.ok(/is_hearing_notice = TRUE/.test(scanBranch) && /dismissed_at IS NULL/.test(scanBranch),
    "the lookup has to ignore dismissed rows and non-hearing files");
  assert.ok(/duplicate_of IS NULL/.test(scanBranch),
    "and has to ignore rows already merged, or it chains duplicates");
});

check("it groups by the day, not the timestamp", () => {
  // Two copies of one notice often disagree about the time — one read as
  // midnight because no time was printed. Grouping on the timestamp files
  // them as two hearings, which is the bug rather than the fix.
  assert.ok(!/hearing_date = \$2(?!::date)/.test(scanBranch),
    "an exact timestamp match would miss the copies that disagree about the time");
});

check("a duplicate is filed as a read file, never as a hearing", () => {
  const dup = scanBranch.slice(scanBranch.indexOf("if (already.rows.length)"));
  assert.ok(/is_hearing_notice,?\s*raw_extraction,\s*duplicate_of/.test(dup.replace(/\s+/g, " "))
    || /duplicate_of/.test(dup), "the duplicate row has to say what it is a duplicate of");
  assert.ok(/FALSE/.test(dup), "it must not be stored as a hearing notice");
  assert.ok(/dismissed_at/.test(dup),
    "every reader in the app filters on dismissed_at — that is what keeps it off the calendar");
});

check("and no client is told about it", () => {
  const dup = scanBranch.slice(scanBranch.indexOf("if (already.rows.length)"));
  assert.ok(/continue;/.test(dup),
    "without the continue it falls through and the client gets a second reminder");
  const beforeContinue = dup.slice(0, dup.indexOf("continue;"));
  assert.ok(!/notices\.push/.test(beforeContinue),
    "a duplicate must not go into the list the notifier reads");
});

check("the copy is allowed to fill a gap, never to overwrite", () => {
  // The second copy may carry a time, a courtroom or a judge the first
  // lacked. It may not replace a value that is already there.
  const dup = scanBranch.slice(scanBranch.indexOf("if (already.rows.length)"));
  assert.ok(/COALESCE\(hearing_time_text, \$2\)/.test(dup),
    "enrichment has to be COALESCE(existing, new), not the other way round");
  assert.ok(!/SET\s+hearing_time_text = \$2/.test(dup));
});

check("the file is still recorded, so it is not read and paid for twice", () => {
  const dup = scanBranch.slice(scanBranch.indexOf("if (already.rows.length)"));
  assert.ok(/INSERT INTO client_hearing_notices/.test(dup),
    "skipping the row entirely means re-extracting this file on every scan");
});

check("the column the whole thing hangs on is actually created", () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS duplicate_of/.test(notices),
    "duplicate_of is queried; without the migration every query throws");
  assert.ok(/idx_hearing_notices_hearing\b/.test(notices)
    || /client_hearing_notices \(client_key, hearing_date\)/.test(notices),
    "the client+date lookup runs on every scanned file and wants an index");
});

check("the email path still checks too, and the two now agree", () => {
  assert.ok(/hearing_date::date = \$2::date/.test(mail),
    "court-mail.js had the only correct check — it must not have been lost");
});

// ── The cleanup is safe ────────────────────────────────────

check("merging keeps the rows; it does not delete client records", () => {
  const i = notices.indexOf("async function mergeDuplicateHearings");
  const body = notices.slice(i, notices.indexOf("async function unmergeDuplicateHearing"));
  assert.ok(i > -1, "mergeDuplicateHearings is missing");
  assert.ok(!/DELETE FROM/.test(body),
    "a duplicate notice is still the record of a document that arrived");
  assert.ok(/duplicate_of\s*=\s*\$1/.test(body), "the losing rows have to point at the keeper");
});

check("it refuses rows that are not the same client and date", () => {
  const i = notices.indexOf("async function mergeDuplicateHearings");
  const body = notices.slice(i, notices.indexOf("async function unmergeDuplicateHearing"));
  assert.ok(/refusing to merge/.test(body),
    "the page can be stale; merging two unrelated hearings is far worse than a stale page");
  assert.ok(/client_key !== keep\.client_key/.test(body));
});

check("a merge can be undone", () => {
  assert.ok(/async function unmergeDuplicateHearing/.test(notices));
  const i = notices.indexOf("async function unmergeDuplicateHearing");
  const body = notices.slice(i, i + 700);
  assert.ok(/duplicate_of = NULL/.test(body) && /is_hearing_notice = TRUE/.test(body));
  assert.ok(/hearing_date IS NOT NULL/.test(body),
    "a merged row keeps its date precisely so it can come back");
});

check("the fullest copy is the one kept, and a sent one wins a tie", () => {
  const hn = require(path.join(ROOT, "hearing-notices.js"));
  assert.strictEqual(typeof hn.noticeCompleteness, "function", "not exported, so not testable");
  const bare = { id: 1 };
  const timed = { id: 2, hearing_time_text: "9:00 AM" };
  const full = { id: 3, hearing_time_text: "9:00 AM", court_name: "Imperial", judge_name: "X" };
  const sent = { id: 4, notified_at: new Date() };
  assert.ok(hn.noticeCompleteness(timed) > hn.noticeCompleteness(bare), "a time beats no time");
  assert.ok(hn.noticeCompleteness(full) > hn.noticeCompleteness(timed), "more detail beats less");
  assert.ok(hn.noticeCompleteness(sent) > hn.noticeCompleteness(full),
    "the copy the client was already told about is the one their records point at");
});

check("the page states that it has changed nothing", () => {
  const i = notices.indexOf("function renderDuplicateHearingsPage");
  const body = notices.slice(i);
  assert.ok(/Nothing here has been changed/.test(body),
    "somebody opening this page needs to know it is a preview");
  assert.ok(/can be undone/.test(body));
  assert.ok(/window\.confirm/.test(body), "a merge needs a deliberate click");
});

check("the page warns where the copies disagree", () => {
  // Disagreeing copies are exactly the ones a person must read, because the
  // merge has to pick one time to tell a client to show up at.
  assert.ok(/disagree about the time/.test(notices));
  assert.ok(/already been sent to the client/.test(notices));
  assert.ok(/Read this one before merging/.test(notices));
});

check("it is reachable: both routes, and a way in from the nav", () => {
  assert.ok(/\/admin\/hearing\/notices\/duplicates/.test(server), "no page route");
  assert.ok(/\/admin\/hearing\/notices\/merge-duplicates/.test(server), "no merge route");
  const hn = read("hearing-notes.js");
  assert.ok(/\/admin\/hearing\/notices\/duplicates/.test(hn),
    "a page nobody can find does not get used");
});

check("the merge route will not take a client's word for the ids", () => {
  const i = server.indexOf('/admin/hearing/notices/merge-duplicates');
  const body = server.slice(i, i + 900);
  assert.ok(/parseInt/.test(body), "ids arrive as text from the browser");
});

// ── The firm's clock ───────────────────────────────────────

check("no cron adds a fixed offset to guess at Pacific time any more", () => {
  // -8 is right from November to March and wrong the rest of the year, so
  // every "7 AM Pacific" job ran at 8 AM for eight months.
  for (const [name, src] of [["hearing-reminders", reminders], ["deadline-tracker", deadlines], ["backup-system", backup]]) {
    assert.ok(!/TIMEZONE_OFFSET_HOURS/.test(src), `${name}.js still hard-codes the offset`);
  }
});

check("they ask the calendar instead, through one shared function", () => {
  assert.ok(/function firmHour|const firmHour/.test(calendar), "court-calendar.js has no firmHour");
  assert.ok(/firmHour/.test(calendar.slice(calendar.indexOf("module.exports"))), "firmHour is not exported");
  assert.ok(/timeZone: PT/.test(calendar));
  for (const [name, src] of [["hearing-reminders", reminders], ["deadline-tracker", deadlines], ["backup-system", backup]]) {
    assert.ok(/firmHour/.test(src), `${name}.js does not use it`);
    assert.ok(/court-calendar/.test(src), `${name}.js does not require it`);
  }
});

check("firmHour reads midnight as 0, not 24", () => {
  const cc = require(path.join(ROOT, "court-calendar.js"));
  assert.strictEqual(typeof cc.firmHour, "function");
  // en-US with hour12:false returns "24" for midnight in some ICU builds,
  // which would make the 3 AM backup never fire and a 0-hour job never match.
  assert.strictEqual(cc.firmHour(new Date("2026-07-15T07:00:00Z")), 0);   // PDT midnight
  assert.strictEqual(cc.firmHour(new Date("2026-12-15T08:00:00Z")), 0);   // PST midnight
  assert.ok(cc.firmHour(new Date("2026-07-15T07:00:00Z")) < 24);
});

check("7 AM Pacific is 7 in July and 7 in December", () => {
  const cc = require(path.join(ROOT, "court-calendar.js"));
  assert.strictEqual(cc.firmHour(new Date("2026-07-15T14:00:00Z")), 7);   // PDT, UTC-7
  assert.strictEqual(cc.firmHour(new Date("2026-12-15T15:00:00Z")), 7);   // PST, UTC-8
  // And the old arithmetic really was wrong: -8 applied in July gives 6.
  assert.notStrictEqual((14 - 8 + 24) % 24, 7);
});

check("the once-a-day guard turns over on the firm's day", () => {
  // Keyed on a UTC date the guard flips at 5pm Pacific, which can let a job
  // run twice in one working afternoon.
  for (const [name, src] of [["hearing-reminders", reminders], ["backup-system", backup]]) {
    assert.ok(!/const dateKey = now\.toISOString\(\)/.test(src),
      `${name}.js still keys its daily guard on the UTC date`);
    assert.ok(/todayPT\(now\)|firmDay\(now\)/.test(src), `${name}.js does not use the firm's date`);
  }
});

// ── "need a button to click and merge all" ────────────────

check("one button merges every group on the page", () => {
  assert.ok(/async function mergeAllDuplicateHearings/.test(notices),
    "there is no merge-all");
  assert.ok(/mergeAllDuplicateHearings/.test(server), "it is not reachable");
  assert.ok(/merge-all-duplicates/.test(server), "no route for it");
});

check("it goes through mergeDuplicateHearings, so every guard still applies", () => {
  const i = notices.indexOf("async function mergeAllDuplicateHearings");
  const body = notices.slice(i, notices.indexOf("/** Put a merged row back", i));
  assert.ok(/await mergeDuplicateHearings\(g\.keep_id, g\.collapse_ids\)/.test(body),
    "merge-all writes its own SQL instead of reusing the one that re-checks client and date");
  assert.ok(!/DELETE/i.test(body), "merge-all deletes something");
});

check("a group that fails does not stop the rest, and is named", () => {
  const i = notices.indexOf("async function mergeAllDuplicateHearings");
  const body = notices.slice(i, notices.indexOf("/** Put a merged row back", i));
  assert.ok(/try \{/.test(body) && /catch/.test(body), "one bad group would abort the loop");
  assert.ok(/failed\.push/.test(body), "a failure is swallowed");
  assert.ok(/error: e\.message/.test(body), "the reason is thrown away");
});

check("it asks before it writes, and the asking is a plain form", () => {
  assert.ok(/function renderMergeAllConfirmPage/.test(notices),
    "merge-all writes on one click with no confirmation");
  const i = notices.indexOf("function renderMergeAllConfirmPage");
  const page = notices.slice(i, notices.indexOf("/** What happened, once it has. */", i));
  assert.ok(/<form method="POST" action="\/admin\/hearing\/notices\/merge-all-duplicates"/.test(page),
    "the confirmation is not a real form");
  assert.ok(!/<script/i.test(page), "a script tag here means an apostrophe in a client name can kill the page");
  assert.ok(/Cancel/.test(page), "no way out of the confirmation screen");
});

check("the confirmation repeats the warnings rather than hiding them", () => {
  const i = notices.indexOf("function renderMergeAllConfirmPage");
  const page = notices.slice(i, notices.indexOf("/** What happened, once it has. */", i));
  assert.ok(/g\.warnings/.test(page),
    "copies that disagree about the time, or were already sent, would merge unseen");
  assert.ok(/esc\(g\.client_name\)/.test(page), "a client name reaches the page unescaped");
});

check("merge-all is behind the same permission as the page", () => {
  const route = server.slice(server.indexOf('app.post("/admin/hearing/notices/merge-all-duplicates"'));
  assert.ok(/gateByPerm\("notes\.master"\)/.test(route.slice(0, 200)),
    "anybody signed in could collapse every duplicate in the firm");
});

check("the reason is written down next to the code", () => {
  assert.ok(/two things at once/.test(notices),
    "the next person has to understand why this table needed two kinds of dedup");
  assert.ok(/eight months/.test(calendar) || /PDT/.test(calendar));
});

console.log(`\n${passed} checks passed\n`);
