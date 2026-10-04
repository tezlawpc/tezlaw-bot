// check-calendar-links.js — every link the calendar emits must go somewhere.
//
// The calendar built its hrefs by hand, in two places, from route paths typed
// from memory. Three of the five were wrong: /admin/individual-hearings/:id and
// /admin/notices had never been routes, and an Outlook event pointed at the iCal
// sync settings page. Clicking a merits hearing or an EOIR notice produced
// "Cannot GET". Nothing caught it because nothing compared the links against the
// routes that actually exist.
//
// So that is what this does: it reads the route table out of server.js and
// asserts that every path eventHref() can return matches a real GET route. It
// also holds the month grid to being clickable at all, since its events were
// plain divs and a day with more than four events hid the rest with no way in.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();        // eoir-calendar.js → db.js → require("pg")

const ROOT = path.join(__dirname, "..");
const cal = require(path.join(ROOT, "eoir-calendar.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── The route table, read out of server.js ─────────────────
// Express matches a concrete path against patterns, so the patterns become
// regexes: ":id" and ":id(\\d+)" both stand for one path segment.

function routePatterns(method) {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const re = new RegExp(`app\\.(?:${method}|all)\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function toRegExp(pattern) {
  const body = pattern
    .replace(/(:[A-Za-z_]\w*)\([^)]*\)/g, "$1")   // ":id(\\d+)" is just ":id"
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")   // escape regex metacharacters
    .replace(/:[A-Za-z_][\w]*/g, "[^/]+")   // a named param is one segment
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

const GET_ROUTES = routePatterns("get");
const GET_REGEXPS = GET_ROUTES.map(toRegExp);

function routeExists(href) {
  const pathOnly = String(href).split("?")[0].split("#")[0];
  return GET_REGEXPS.some(re => re.test(decodeURI(pathOnly)));
}

console.log("\ncalendar links\n");

check("server.js's route table was readable", () => {
  assert.ok(GET_ROUTES.length > 100,
    `only found ${GET_ROUTES.length} GET routes in server.js — the extraction regex is probably broken, ` +
    "which would make every assertion below vacuously true");
  assert.ok(GET_ROUTES.includes("/admin/calendar"), "/admin/calendar itself was not found");
});

// ── Every destination eventHref can produce ────────────────
// One sample event per source. If a source is added to the calendar without
// being added here, the coverage assertion at the end fails.

const SAMPLES = {
  hearing_note_upcoming: { source: "hearing_note_upcoming", source_id: "41" },
  hearing_note_past:     { source: "hearing_note_past",     source_id: "42" },
  individual_hearing:    { source: "individual_hearing",    source_id: "7"  },
  individual_upcoming:   { source: "individual_upcoming",   source_id: "8"  },
  hearing_notice:        { source: "hearing_notice",        source_id: "3", client_key: "chen, mei" },
  deadline:              { source: "deadline",              source_id: "9"  },
  outlook_event:         { source: "outlook_event",         source_id: "x"  },
};

// Sources with no record page of their own. A null here is correct; a link
// would send the reader to something unrelated.
const NO_PAGE = new Set(["outlook_event"]);

check("every link the calendar can emit resolves to a real route", () => {
  for (const [source, event] of Object.entries(SAMPLES)) {
    const href = cal.eventHref(event);
    if (NO_PAGE.has(source)) {
      assert.strictEqual(href, null, `${source} has no page of its own, so it must not be a link`);
      continue;
    }
    assert.ok(href, `${source} produced no link at all`);
    assert.ok(routeExists(href),
      `${source} links to ${href}, which matches no GET route in server.js`);
  }
});

check("the specific routes that were wrong are right", () => {
  // Named individually so a regression names itself rather than failing in bulk.
  assert.strictEqual(cal.eventHref(SAMPLES.individual_hearing), "/admin/hearing/individual/7");
  assert.strictEqual(cal.eventHref(SAMPLES.hearing_notice), "/admin/clients/chen%2C%20mei/hearing-notices");
  assert.strictEqual(cal.eventHref(SAMPLES.outlook_event), null);
});

check("the routes that were never routes stay gone", () => {
  for (const dead of ["/admin/notices", "/admin/individual-hearings/7"]) {
    assert.ok(!routeExists(dead), `${dead} now exists as a route — update this check`);
    for (const event of Object.values(SAMPLES)) {
      assert.notStrictEqual(cal.eventHref(event), dead, `something still links to ${dead}`);
    }
  }
});

check("a missing id does not produce a link to nowhere", () => {
  assert.strictEqual(cal.eventHref({ source: "hearing_note_upcoming" }), null);
  assert.strictEqual(cal.eventHref({ source: "individual_hearing", source_id: "" }), null);
  // A notice whose client key never got extracted has no page to open.
  assert.strictEqual(cal.eventHref({ source: "hearing_notice", source_id: "3" }), null);
});

check("an unrecognised source is inert, not broken", () => {
  assert.strictEqual(cal.eventHref({ source: "some_future_source", source_id: "1" }), null);
  assert.strictEqual(cal.eventHref({}), null);
});

check("a merged event follows its own source_refs", () => {
  // Dedup collapses several records into one; the link must follow the record
  // the row is actually showing, not the bucket's original source.
  const merged = { source: "deadline", source_id: "9", source_refs: [{ source: "hearing_note_past", id: "88" }] };
  assert.strictEqual(cal.eventHref(merged), "/admin/hearing/notes/88");
});

check("every source the calendar labels has a sample here", () => {
  for (const source of Object.keys(cal.SOURCE_LABELS)) {
    assert.ok(source in SAMPLES,
      `${source} appears in SOURCE_LABELS but has no sample in this check — ` +
      "add one so its link is verified against the route table");
  }
});

// ── The rendered views ─────────────────────────────────────

function sampleEvents(day) {
  const at = h => new Date(2026, 9, day, h, 30).toISOString();
  return [
    { ...SAMPLES.hearing_note_upcoming, event_date: at(9),  client_name: "Chen, Mei",  a_number: "A100" },
    { ...SAMPLES.individual_hearing,    event_date: at(10), client_name: "Lopez, Ana", a_number: "A200" },
    { ...SAMPLES.deadline,              event_date: at(11), client_name: "Ng, Victor" },
    { ...SAMPLES.outlook_event,         event_date: at(13), client_name: "Firm meeting" },
    { ...SAMPLES.hearing_notice,        event_date: at(14), client_name: "Chen, Mei" },
    { ...SAMPLES.hearing_note_past,     event_date: at(15), client_name: "Wang, Li" },
  ];
}

function hrefsIn(html) {
  return [...new Set((html.match(/href="([^"]*)"/g) || []).map(h => h.slice(6, -1)))];
}

check("the list view emits no dead links", () => {
  const html = cal.renderListView(cal.groupByDate(sampleEvents(15)));
  const hrefs = hrefsIn(html);
  assert.ok(hrefs.length > 0, "the list view rendered no links at all");
  assert.ok(!hrefs.includes("#"), 'the list view still emits href="#", which looks clickable and is not');
  for (const h of hrefs) {
    assert.ok(routeExists(h), `the list view links to ${h}, which matches no GET route`);
  }
});

check("an event with no page is not dressed up as a link", () => {
  const html = cal.renderListView(cal.groupByDate([sampleEvents(15)[3]]));  // the Outlook event
  assert.ok(!/<a\s/.test(html), "an Outlook event is still wrapped in an anchor");
  assert.ok(html.includes("Firm meeting"), "...and its text went missing too");
});

check("month grid events are clickable", () => {
  const html = cal.renderMonthView(sampleEvents(15), { month: 10, year: 2026 });
  const hrefs = hrefsIn(html);
  assert.ok(hrefs.some(h => h.startsWith("/admin/hearing/notes/")),
    "no event in the month grid is a link — this is the bug where chips were plain divs");
  for (const h of hrefs) {
    assert.ok(routeExists(h), `the month grid links to ${h}, which matches no GET route`);
  }
});

check("a clipped day can still be opened", () => {
  // Six events, four chips. The other two are only reachable through the day.
  const html = cal.renderMonthView(sampleEvents(15), { month: 10, year: 2026 });
  assert.ok(/\+2 more/.test(html), "the overflow count is missing");
  const dayHref = cal.dayListHref(2026, 10, 15);
  assert.ok(html.includes(`href="${dayHref}"`),
    "the day's events are clipped with no link to see the rest");
  assert.ok(routeExists(dayHref), `the day link ${dayHref} matches no GET route`);
  assert.ok(/view=list/.test(dayHref) && /from=2026-10-15/.test(dayHref) && /to=2026-10-15/.test(dayHref),
    "the day link must open the list view filtered to that one day");
});

check("a day with no events gets no pointless link", () => {
  const html = cal.renderMonthView([], { month: 10, year: 2026 });
  assert.ok(!/view=list/.test(html), "empty days are linking to an empty list");
});

console.log(`\n${passed} checks passed, against ${GET_ROUTES.length} GET routes in server.js\n`);
