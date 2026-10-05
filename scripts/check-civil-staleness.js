/**
 * check-civil-staleness.js
 *
 * Two questions the civil board never answered: how long has this matter sat,
 * and what is due next.
 *
 * Neither was findable without opening the case, which on a board carrying
 * every active matter — a couple of hundred for this firm — means neither was
 * findable. A stalled case does not announce itself. It simply stops appearing
 * in anybody's day, and the first anybody hears of it is a sanction, a
 * dismissal for failure to prosecute, or a bar complaint.
 *
 * The board did show "last updated", which is why this looked solved. But
 * updated_at moves when any field on the case changes — correcting a case
 * number counts as movement — so it answered a different question from the one
 * being asked.
 *
 * What these checks hold:
 *   - quiet days are counted from real work, not from any edit
 *   - a hearing logged for next March does not make a quiet matter look busy
 *   - a matter with nothing logged at all still reports a number
 *   - an overdue deadline reaches the top of the board
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const civil = require(path.join(ROOT, "civil-litigation.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const lit = fs.readFileSync(path.join(ROOT, "civil-litigation.js"), "utf8");
const ui = fs.readFileSync(path.join(ROOT, "civil-litigation-ui.js"), "utf8");

console.log("\nCivil board: staleness and what is due next\n");

// ── What counts as movement ────────────────────────────────

check("movement is measured from the case log, not from updated_at", () => {
  const i = lit.indexOf("async function caseActivity");
  const body = lit.slice(i, lit.indexOf("async function kanban", i));
  assert.ok(body.length > 400, "caseActivity moved; this check needs updating");
  assert.ok(/MAX\(created_at\) AS at FROM civil_case_events/.test(body));
  assert.ok(!/updated_at/.test(body),
    "updated_at moves on any field edit and must not be what 'quiet' is measured from");
});

check("created_at, not event_date — a future hearing is not movement", () => {
  const i = lit.indexOf("async function caseActivity");
  const body = lit.slice(i, lit.indexOf("async function kanban", i));
  assert.ok(!/MAX\(event_date\)/.test(body),
    "a hearing logged for next March would make an untouched matter look busy");
});

check("a completed deadline also counts as movement", () => {
  assert.ok(/MAX\(completed_at\) AS at FROM civil_case_deadlines/.test(lit));
});

check("a matter with nothing logged reports days since it was opened", () => {
  const i = lit.indexOf("async function kanban");
  const body = lit.slice(i, lit.indexOf("async function getCaseSummary", i));
  assert.ok(/c\.last_activity_at = c\.created_at/.test(body),
    "a case untouched since intake is the most important one to surface, not a blank");
  assert.ok(/"case opened"/.test(body), "and the chip should say that is what it is counting from");
});

check("the source of the last activity travels with it", () => {
  // So the tooltip can distinguish "nobody has touched this" from "nothing
  // has ever been logged on this".
  assert.ok(/last_activity_source/.test(lit));
  assert.ok(/last_activity_source/.test(ui));
});

// ── One query per source, not one per case ─────────────────

check("the board does not issue a query per case", () => {
  const i = lit.indexOf("async function caseActivity");
  const body = lit.slice(i, lit.indexOf("async function kanban", i));
  const queries = (body.match(/q\(`/g) || []).length;
  assert.ok(queries <= 4, `${queries} queries — this runs for every active matter at once`);
  assert.ok(/case_id = ANY\(\$1\)/.test(body), "ids are passed as one array");
  assert.ok(/Promise\.all/.test(body));
});

// An async check has to be awaited or it passes without running. Collected
// here and run at the end rather than silently resolving after the summary.
const deferred = [];
function checkAsync(name, fn) { deferred.push([name, fn]); }

checkAsync("caseActivity returns an empty map for no cases rather than querying", async () => {
  // Called on an empty board; must not send `ANY('{}')` four times.
  const m = await civil.caseActivity([]);
  assert.ok(m instanceof Map);
  assert.strictEqual(m.size, 0);
});

check("a missing table leaves the chip quiet instead of breaking the board", () => {
  const i = lit.indexOf("async function caseActivity");
  const body = lit.slice(i, lit.indexOf("async function kanban", i));
  assert.ok(/\.catch\(e =>/.test(body), "each query is caught on its own");
  assert.ok(/rows: \[\]/.test(body));
  const k = lit.indexOf("async function kanban");
  const kbody = lit.slice(k, lit.indexOf("async function getCaseSummary", k));
  assert.ok(/catch \(e\) \{ console\.warn\("\[civil-litigation\] kanban activity/.test(kbody),
    "and the whole decoration is caught: the board must render without it");
});

// ── What is due next ───────────────────────────────────────

check("the next due date is the sooner of a deadline and a hearing", () => {
  const i = lit.indexOf("async function caseActivity");
  const body = lit.slice(i, lit.indexOf("async function kanban", i));
  assert.ok(/FROM civil_case_deadlines/.test(body));
  assert.ok(/FROM civil_hearings/.test(body));
  assert.ok(/options\.sort/.test(body), "whichever comes first is the one shown");
  assert.ok(/kind: "deadline"/.test(body) && /kind: "hearing"/.test(body),
    "which of the two it is has to reach the page — they mean different things");
});

check("an overdue deadline is kept, not filtered out as past", () => {
  const i = lit.indexOf("async function caseActivity");
  const body = lit.slice(i, lit.indexOf("async function kanban", i));
  const dl = body.slice(body.indexOf("FROM civil_case_deadlines"));
  assert.ok(!/due_date >= /.test(dl),
    "a missed deadline is more urgent than a future one and must not be hidden");
});

check("only pending deadlines and scheduled hearings count", () => {
  const i = lit.indexOf("async function caseActivity");
  const body = lit.slice(i, lit.indexOf("async function kanban", i));
  assert.ok(/status = 'pending'/.test(body));
  assert.ok(/status = 'scheduled'/.test(body),
    "a continued or vacated hearing is not what is due next");
});

// ── The chips ──────────────────────────────────────────────

check("a quiet matter is flagged, and the colour escalates", () => {
  assert.ok(/QUIET " \+ quiet \+ "d"/.test(ui));
  assert.ok(/QUIET_WARN = 14, QUIET_BAD = 30, QUIET_SEVERE = 90/.test(ui),
    "a fortnight is a reminder; a quarter on an active matter is not");
  assert.ok(/d >= QUIET_SEVERE \? "#9C2B1E"/.test(ui), "the worst case should be the alarm colour");
});

check("a busy matter gets no quiet chip at all", () => {
  assert.ok(/quiet !== null && quiet >= QUIET_WARN/.test(ui),
    "a chip on every card is a chip nobody reads");
});

check("an overdue item says overdue, in red", () => {
  assert.ok(/OVERDUE " \+ Math\.abs\(dueIn\)/.test(ui));
  assert.ok(/dueIn !== null && dueIn < 0 \? "#9C2B1E"/.test(ui));
});

check("the due chip names what it is and what it is for", () => {
  assert.ok(/due\.kind === "hearing" \? "Hearing" : "Deadline"/.test(ui));
  assert.ok(/due\.label/.test(ui), "a date with no description is not actionable");
});

// ── Triage order ───────────────────────────────────────────

check("an overdue item reaches the top band", () => {
  assert.ok(/\(due !== null && due < 0\)\) return 2;/.test(ui),
    "most matters have no trial date, so without this the triage ranked almost nothing");
});

check("something due within a week is raised too", () => {
  assert.ok(/\(due !== null && due <= 7\)\) return 1;/.test(ui));
});

check("the next due date joins the soonest-first sort", () => {
  const i = ui.indexOf("const soonestOf");
  const body = ui.slice(i, i + 400);
  assert.ok(/c\.next_due \? daysUntil\(c\.next_due\.date\) : null/.test(body));
});

check("ties break to the quietest, not the most recently touched", () => {
  assert.ok(/return qa - qb;/.test(ui));
  assert.ok(/buries exactly the matters that need/.test(ui),
    "the reason has to stay next to the comparator or it will be 'tidied' back");
  const sortRegion = ui.slice(ui.indexOf(".slice().sort((a, b) =>"), ui.indexOf("const cards ="));
  assert.ok(!/new Date\(b\.updated_at \|\| 0\) - new Date\(a\.updated_at \|\| 0\)/.test(sortRegion),
    "sorting by updated_at puts the stalled matters at the bottom of every column");
});

// ── It is actually on the board ────────────────────────────

check("kanban decorates every case it returns", () => {
  const k = lit.indexOf("async function kanban");
  const body = lit.slice(k, lit.indexOf("async function getCaseSummary", k));
  assert.ok(/caseActivity\(cases\.map\(c => c\.id\)\)/.test(body));
  assert.ok(/c\.next_due = /.test(body));
});

check("caseActivity is exported, so the app and the board can agree", () => {
  assert.strictEqual(typeof civil.caseActivity, "function");
});

(async () => {
  for (const [name, fn] of deferred) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  }
  console.log(`\n${passed} checks passed\n`);
})().catch(e => { console.error(e); process.exit(1); });
