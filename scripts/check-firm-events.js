/**
 * check-firm-events.js
 * ─────────────────────────────────────────────────────────
 * Calendar entries a person types in, and the one thing that keeps
 * breaking about dates.
 *
 * "should be able to add or edit calender in tara and sync back to the
 *  calender, if that is possible." (JJ, 2026-10-09)
 * "i am stil unable to add or delete calenders and sync." (2026-10-10)
 *
 * Every other source on the Calendar page is DERIVED -- a hearing note, a
 * notice read out of Dropbox, a matter deadline, an Outlook feed -- so
 * there was nothing on it to add or delete. firm_events is the one source
 * the firm owns.
 *
 * THE DATE RULE, which most of this file is about. A hand-entered event is
 * a DATE plus the time somebody typed. Not an instant. The codebase has
 * fixed the same bug three times -- a reminder saying noon for a 9:00 AM
 * custody hearing, a client profile showing a 10:00 AM hearing as "3:00
 * AM" -- and every time the cause was a courtroom time stored or read as
 * though it were a moment on a world clock. So:
 *
 *   - the table stores DATE + TEXT, with no timestamptz for the event
 *   - the one conversion, for the Calendar page's union, stamps UTC
 *   - the .ics publishes a floating local time, because a 9:30
 *     appointment is at 9:30 where the office is
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const E = require(path.join(ROOT, "firm-events.js"));
const P = require(path.join(ROOT, "firm-events-page.js"));

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (err) { console.log("  FAIL  " + name); throw err; }
  console.log("  ok  " + name);
  passed++;
}

console.log("\nCalendar entries the firm types in\n");

// ── the date and the time ───────────────────────────────────

check("the table stores a date and a typed time, not a timestamp", () => {
  const src = read("firm-events.js");
  assert.ok(/event_day\s+DATE NOT NULL/.test(src), "the day is not a DATE");
  assert.ok(/start_time\s+TEXT/.test(src) && /end_time\s+TEXT/.test(src),
    "a time is not stored as the text that was typed");
  // No timestamptz for the event itself. created_at and friends are real
  // instants and are allowed to be.
  const eventCols = src.slice(src.indexOf("CREATE TABLE IF NOT EXISTS firm_events"),
                              src.indexOf("created_at"));
  assert.ok(!/TIMESTAMPTZ/i.test(eventCols),
    "the event's own date or time is stored as an instant");
});

check("a typed time is read the way a person meant it", () => {
  assert.strictEqual(E.cleanTime("9:30"), "09:30");
  assert.strictEqual(E.cleanTime("9:30 AM"), "09:30");
  assert.strictEqual(E.cleanTime("1:00 PM"), "13:00");
  assert.strictEqual(E.cleanTime("14:00"), "14:00");
  // Midnight and noon are the two that get flipped.
  assert.strictEqual(E.cleanTime("12:00 AM"), "00:00", "midnight came out as noon");
  assert.strictEqual(E.cleanTime("12:30 PM"), "12:30", "half past noon moved");
  // And nothing is invented out of nonsense.
  assert.strictEqual(E.cleanTime("25:00"), null);
  assert.strictEqual(E.cleanTime("99:99"), null);
  assert.strictEqual(E.cleanTime("tomorrow"), null);
  assert.strictEqual(E.cleanTime(""), null);
});

check("a day is a day, never a parsed Date", () => {
  assert.strictEqual(E.cleanDay("2026-10-20"), "2026-10-20");
  assert.strictEqual(E.cleanDay("2026-10-20T13:00:00Z"), "2026-10-20");
  assert.strictEqual(E.cleanDay("20/10/2026"), null, "an ambiguous date was accepted");
  assert.strictEqual(E.cleanDay("not a date"), null);
  // Off a DATE column, which arrives as midnight UTC, the box must offer
  // that day and not the one before.
  assert.strictEqual(P.dayValue(new Date("2026-10-20T00:00:00Z")), "2026-10-20",
    "the date box offers the day before");
});

check("the Calendar page's union stamps UTC, not Pacific", () => {
  // The other six sources hand that page a value carrying the printed
  // date and time with no zone. Converting with America/Los_Angeles here
  // would shift every hand-entered event by seven hours, which is the
  // 2026-10-09 bug one layer down.
  const sql = E.calendarSql();
  assert.ok(/AT TIME ZONE 'UTC'/.test(sql), "the union does not stamp UTC");
  assert.ok(!/America\/Los_Angeles/.test(sql), "the union converts to Pacific");
  assert.ok(/deleted_at IS NULL/.test(sql), "deleted entries are still on the calendar");
  // And it takes the page's own filters rather than returning everything.
  const filtered = E.calendarSql(["event_day >= $1"]);
  assert.ok(/event_day >= \$1/.test(filtered), "the union ignores the page's date range");
});

check("the .ics publishes a floating local time", () => {
  // A 9:30 appointment is at 9:30 where the office is. DTSTART with a Z,
  // or with the day stamped UTC, moves it in the subscriber's calendar.
  const src = read("matter-manager.js");
  const i = src.indexOf("Entries typed into the Calendar page");
  assert.ok(i > -1, "the feed does not carry hand-entered entries at all");
  const block = src.slice(i, i + 3000);
  assert.ok(/DTSTART:\$\{day\}T\$\{sh\}\$\{sm\}00/.test(block),
    "a timed entry is not published as a floating local time");
  assert.ok(!/DTSTART:\$\{day\}T\$\{sh\}\$\{sm\}00Z/.test(block),
    "the feed stamps appointment times UTC, which moves them");
  assert.ok(/VALUE=DATE/.test(block), "an all-day entry is not published as an all-day event");
});

check("a deleted entry is published as cancelled, not dropped", () => {
  // A subscriber that has already seen the appointment needs telling.
  // Silence leaves it on their calendar for good.
  const src = read("matter-manager.js");
  const i = src.indexOf("Entries typed into the Calendar page");
  const block = src.slice(i, i + 3000);
  assert.ok(/includeDeleted: true/.test(block), "deleted entries are not published at all");
  assert.ok(/STATUS:\$\{ev\.cancelled \? "CANCELLED" : "CONFIRMED"\}/.test(block),
    "a deleted entry is not published as CANCELLED");
  const rows = E.icsRows([{ id: 3, event_day: "2026-10-20", title: "Signing", deleted_at: new Date() }]);
  assert.strictEqual(rows[0].cancelled, true, "a deleted row does not come back cancelled");
  assert.ok(/^firm-event-3@/.test(rows[0].uid), "the UID is not stable per entry");
});

check("deleting is soft, so the record survives", () => {
  const src = read("firm-events.js");
  assert.ok(/SET deleted_at = NOW\(\)/.test(src), "delete removes the row");
  assert.ok(!/DELETE FROM firm_events/.test(src), "there is a hard delete in here");
  assert.strictEqual(typeof E.restore, "function", "a deleted entry cannot be put back");
});

// ── what the form accepts ───────────────────────────────────

check("an end before its start is dropped, not stored", () => {
  const f = E.fields({ title: "x", date: "2026-10-20", start: "2pm", end: "1pm" });
  assert.strictEqual(f.start_time, "14:00");
  assert.strictEqual(f.end_time, null, "an end before its start was stored");
});

check("billable time needs a matter, a start and an end", () => {
  // Otherwise there is nothing to bill against and no duration to bill.
  const src = read("firm-events.js");
  assert.ok(/Billable time has to be against a matter/.test(src),
    "billable time can be recorded with no matter");
  assert.ok(/Give the event a start and an end time before billing it/.test(src),
    "an event with no duration can be billed");
  assert.strictEqual(E.minutesOf({ start_time: "09:00", end_time: "10:30" }), 90);
  assert.strictEqual(E.minutesOf({ start_time: "09:00" }), null);
});

check("the same entry cannot be billed twice", () => {
  const src = read("firm-events.js");
  assert.ok(/time_entry_id/.test(src), "nothing records the time entry an event created");
  assert.ok(/if \(ev\.time_entry_id\) return \{ already: true/.test(src),
    "billing an already-billed entry writes a second time entry");
});

// ── the pages ───────────────────────────────────────────────

check("one form serves both adding and editing", () => {
  // Two forms drift, and a field ends up editable in one and not the other.
  const add = P.renderEventForm(null, {});
  const edit = P.renderEventForm({ id: 5, title: "Signing", event_day: "2026-10-20" }, {});
  for (const name of ["title", "event_day", "start_time", "end_time", "place", "note",
                      "kind", "client_name", "client_key", "a_number", "matter_id", "billable"]) {
    assert.ok(new RegExp(`name="${name}"`).test(add), `the add form has no ${name}`);
    assert.ok(new RegExp(`name="${name}"`).test(edit), `the edit form has no ${name}`);
  }
  assert.ok(/\/admin\/calendar\/event"/.test(add), "the add form posts nowhere sensible");
  assert.ok(/\/admin\/calendar\/event\/5"/.test(edit), "the edit form posts nowhere sensible");
  assert.ok(!/Delete this entry/.test(add), "a form for a new entry offers to delete it");
  assert.ok(/Delete this entry/.test(edit), "an existing entry cannot be deleted from its page");
});

check("a rejected entry comes back holding what was typed", () => {
  // Clearing the boxes is a worse outcome than the typo being complained
  // about.
  const html = P.renderEventForm(
    { title: "Signing", event_day: "", start_time: "09:00" },
    { error: "An event needs a date, as YYYY-MM-DD." });
  assert.ok(/An event needs a date/.test(html), "the reason is not shown");
  assert.ok(/value="Signing"/.test(html), "the title was thrown away");
  assert.ok(/value="09:00"/.test(html), "the start time was thrown away");
  const src = read("server.js");
  const i = src.indexOf('app.post("/admin/calendar/event"');
  const route = src.slice(i, i + 1600);
  assert.ok(/renderEventForm\(req\.body/.test(route),
    "the route does not hand the typed values back on a rejection");
});

check("the pages carry no inline script and escape what they print", () => {
  const html = P.renderEventForm({ id: 5, title: "O'Brien <signing>", event_day: "2026-10-20" }, {})
    + P.addButton();
  assert.ok(!/onclick=/.test(html), "an onclick is on one of these pages");
  assert.ok(!/<script/.test(html), "an inline script is on one of these pages");
  assert.ok(/O&#39;Brien/.test(html) && !/O'Brien/.test(html), "an apostrophe is unescaped");
  assert.ok(/&lt;signing&gt;/.test(html), "angle brackets are unescaped");
});

check("the Calendar page offers to add one, and links each one to its record", () => {
  const cal = require(path.join(ROOT, "eoir-calendar.js"));
  const html = cal.renderCalendarPage({
    events: [], stats: { hearings_today: 0 }, filters: {},
    view: "list", monthYear: { year: 2026, month: 10 }, feeds: [],
  });
  assert.ok(/\/admin\/calendar\/event/.test(html), "there is no way to add a calendar entry");
  const src = read("eoir-calendar.js");
  assert.ok(/case "firm_event":/.test(src), "a hand-entered entry opens nothing");
  assert.ok(/firm_event:\s+"#FF7B00"/.test(src), "a hand-entered entry has no colour of its own");
  // It must not be merged into a hearing on the same day: a person put it
  // on the calendar and it has to stay visible.
  const dedupe = src.slice(src.indexOf("const HEARING_SOURCES"), src.indexOf("const HEARING_SOURCES") + 400);
  assert.ok(!/"firm_event"/.test(dedupe), "a hand-entered entry can be deduped away");
});

check("the Calendar page names the zone it reads stored times in", () => {
  // Same fault the client profile had. An event_date here is a stored
  // wall-clock value; reading it in the ambient zone is right on Render,
  // which runs UTC, and seven hours out on a laptop in Los Angeles.
  //
  // Scanned occurrence by occurrence rather than with one clever regex.
  // The first version of this check used a negative lookahead after \s*,
  // which backtracks to zero width and so matched every call including
  // the ones that DO name a zone -- a check that fails on correct code.
  //
  // firstDay is the allowed exception: a Date this page builds from the
  // URL, not a value out of the database. Forcing UTC on it would be the
  // same mistake pointing the other way.
  const LOCAL_BY_DESIGN = new Set(["firstDay"]);
  const src = read("eoir-calendar.js");
  const re = /(\w+)\.toLocale(?:Time|Date)String\(/g;
  const bad = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const receiver = m[1];
    const tail = src.slice(m.index, m.index + 160);
    const namesZone = /timeZone\s*:/.test(tail.slice(0, tail.indexOf("}") + 1));
    if (!namesZone && !LOCAL_BY_DESIGN.has(receiver)) {
      bad.push(`${receiver} at offset ${m.index}`);
    }
  }
  assert.deepStrictEqual(bad, [],
    `a stored date on the Calendar page is formatted without naming a zone: ${bad.join(", ")}`);
  // And the exception is genuinely a locally built Date, with a note.
  assert.ok(/LOCAL ON PURPOSE/.test(src),
    "the one local formatter is not explained, so the next reader will 'fix' it");
});

check("an entry belongs on its client's file and its matter's", () => {
  // "also let you attach it to a client and a matter, so it shows on that
  // client's file too and the time can be billed against the matter" (JJ)
  assert.strictEqual(typeof E.listForClient, "function", "a client cannot list its entries");
  assert.strictEqual(typeof E.listForMatter, "function", "a matter cannot list its entries");
});

check("every route the pages post to exists", () => {
  const src = read("server.js");
  for (const route of [
    'app.get("/admin/calendar/event"',
    'app.post("/admin/calendar/event"',
    'app.get("/admin/calendar/event/:id',
    'app.post("/admin/calendar/event/:id',
  ]) {
    assert.ok(src.includes(route), `missing route: ${route}`);
  }
  for (const tail of ["/delete", "/restore", "/bill"]) {
    assert.ok(new RegExp(`app\\.post\\("/admin/calendar/event/:id[^"]*${tail}"`).test(src),
      `missing route: ${tail}`);
  }
  // Express matches in order: /admin/calendar/event must not be swallowed
  // by a parameter route registered earlier on /admin/calendar/:something.
  const evAt = src.indexOf('app.get("/admin/calendar/event"');
  const paramAt = src.search(/app\.get\("\/admin\/calendar\/:[a-z]/);
  if (paramAt > -1) {
    assert.ok(evAt < paramAt,
      "a parameter route on /admin/calendar swallows /admin/calendar/event");
  }
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:firm-events"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-firm-events.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-firm-events.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
