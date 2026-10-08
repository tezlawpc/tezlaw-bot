// ============================================================
//  check-notice-page.js
//  ─────────────────────────────────────────────────────────
//  "when clicking on calender event in list form, i still get
//   error below:" — and what followed was the raw JSON of
//  /admin/clients/:key/hearing-notices.
//
//  That route is the JSON API the app reads. eventHref() sent a
//  BROWSER there, so the browser printed the response. The comment
//  above eventHref already lists three links that went nowhere and
//  were fixed; this was the fourth, and the worst of them, because
//  a wall of JSON reads like data loss rather than a dead link.
//
//  Also here: the time. Notice #3997 carried hearing_time_text
//  "13:00" and the reminder said "time not confirmed, please call
//  us at 626-678-8677". quotedTime() only accepted am/pm, so a
//  hearing whose time the firm had on file sent the client to the
//  office to ask for it.
// ============================================================

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok  " + name);
    passed++;
  } catch (err) {
    console.log("  FAIL  " + name);
    throw err;
  }
}

console.log("\nThe notice a calendar click opens\n");

const cal = require(path.join(ROOT, "eoir-calendar.js"));
const hn = require(path.join(ROOT, "hearing-notices.js"));
const { quotedTime } = require(path.join(ROOT, "hearing-when.js"));

// ── The link ────────────────────────────────────────────────

check("a notice on the calendar links to a page, not to the JSON API", () => {
  const href = cal.eventHref({
    source: "hearing_notice", source_id: "3997", client_key: "n-wang-xiang",
    source_refs: [{ source: "hearing_notice", id: "3997" }],
  });
  assert.ok(href, "the notice has no link at all");
  assert.ok(!/\/hearing-notices(\?|#|$)/.test(href),
    "the link still goes to the JSON API: " + href);
  assert.ok(href.startsWith("/admin/clients/n-wang-xiang/hearings"),
    "unexpected link: " + href);
  assert.ok(href.endsWith("#notice-3997"),
    "the link does not open on the notice that was clicked: " + href);
});

check("a notice with no client key is shown as text rather than a dead link", () => {
  assert.strictEqual(cal.eventHref({
    source: "hearing_notice", source_refs: [{ source: "hearing_notice", id: "1" }],
  }), null, "a link that cannot be built should be null, not a URL to nowhere");
});

check("a client key with a character that needs escaping survives the link", () => {
  const href = cal.eventHref({
    source: "hearing_notice", client_key: "n-o'brien & sons",
    source_refs: [{ source: "hearing_notice", id: "7" }],
  });
  const pathPart = href.split("#")[0];
  // An apostrophe is legal in a path and encodeURIComponent leaves it. What
  // must not survive raw is anything that ends the path or starts a query.
  for (const ch of ["&", "?", "#", " "]) {
    assert.ok(!pathPart.includes(ch), `a raw "${ch}" survived into the link: ` + href);
  }
});

// ── The page is mounted, and the API is still there ─────────

check("the page is mounted, and the app's JSON route still is too", () => {
  const srv = read("server.js");
  assert.ok(srv.includes('app.get("/admin/clients/:key/hearings"'),
    "nothing serves the page the calendar now links to");
  assert.ok(srv.includes('app.get("/admin/clients/:key/hearing-notices"'),
    "the JSON route the app reads was removed");
  // Different paths, so neither can shadow the other -- but the page must
  // come before /admin/clients/:key, which would otherwise match first.
  assert.ok(srv.indexOf('app.get("/admin/clients/:key/hearings"') <
            srv.indexOf('app.get("/admin/clients/:key"'),
    "the client record route is registered first and will swallow the page");
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:notice-page"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-notice-page.js"),
    "not in the chain, so nothing runs it");
  assert.ok(read(".github/workflows/ci.yml").includes("check-notice-page.js"),
    "not in CI, so a push can break it unnoticed");
});

// ── The page itself ─────────────────────────────────────────

const client = { key: "n-wang-xiang", client_name: "O'Brien & Sons" };
const notices = [{
  id: 3997,
  dropbox_path: "/USCIS/ASYLUM_EOIR/WANG, XIANG/motion to substitute.pdf",
  hearing_date: "2026-10-08T13:00:00.000Z",
  hearing_time_text: "13:00",
  hearing_type: "individual",
  court_name: "IMMIGRATION COURT, SANTA ANA, CALIFORNIA",
  court_address: "Santa Ana, California",
  judge_name: "Hom, Howard C.",
  notice_type: "EOIR individual",
  confidence: "high",
  notified_at: null,
  notification_channel: null,
}, {
  id: 3995,
  hearing_date: "2026-12-10T08:30:00.000Z",
  hearing_time_text: null,
  hearing_type: "master",
  court_name: "Santa Ana Immigration Court",
  confidence: "high",
  notified_at: null,
}];

check("the page contributes no script of its own", () => {
  // notify-admin.js's rule. A client name with an apostrophe inside an
  // onclick took client search down for five hours on 2026-09-28, and this
  // page renders client names, court names and judges.
  const html = hn.renderNoticesPage(client, notices);
  assert.ok(!/<script/i.test(html), "the page carries a script tag");
  assert.ok(!/\son[a-z]+=/i.test(html), "the page carries an inline handler");
});

check("an apostrophe and an ampersand in a client name survive the page", () => {
  const html = hn.renderNoticesPage(client, notices);
  assert.ok(html.includes("O&#39;Brien &amp; Sons"),
    "the client name was not escaped, so the page can be broken by a name");
  assert.ok(!html.includes("O'Brien & Sons"), "an unescaped copy is also on the page");
});

check("the date printed is the date on the notice, not the day before", () => {
  // hearing-notices.js stores the wall-clock date off the paper with no
  // zone, so UTC is the calendar date it was stored as. Rendering it in a
  // zone behind UTC prints the day before -- this codebase's oldest bug.
  const html = hn.renderNoticesPage(client, notices);
  assert.ok(html.includes("October 8, 2026"), "the October notice slipped a day");
  assert.ok(!html.includes("October 7, 2026"), "the date was converted out of UTC");
  assert.ok(html.includes("December 10, 2026"), "the December notice slipped a day");
});

check("a time on the notice is quoted; a missing one is said to be missing", () => {
  const html = hn.renderNoticesPage(client, notices);
  assert.ok(html.includes("1:00 PM"), "the notice's own time is not on the page");
  assert.ok(/Time not stated on the notice/.test(html),
    "a notice with no time says nothing instead of saying so");
  assert.ok(!/12:00 PM/.test(html),
    "a date-only value was rendered as a time, which is the Imperial bug");
});

check("the notice clicked is the one the page marks", () => {
  const html = hn.renderNoticesPage(client, notices, { focusId: "3997" });
  assert.ok(/id="notice-3997"[^>]*#FF7B00/.test(html.replace(/\n\s*/g, " ")),
    "the notice that was clicked is not picked out");
});

check("a client with no notices is told what to do, not shown a blank page", () => {
  const html = hn.renderNoticesPage(client, []);
  assert.ok(/Update from Dropbox/.test(html), "no way forward from an empty page");
});

// ── The time itself ─────────────────────────────────────────

check("a 24-hour time off a notice is a time, not an unknown", () => {
  // Notice #3997: hearing_time_text "13:00", and the client was told
  // "time not confirmed, please call us".
  assert.strictEqual(quotedTime("13:00"), "1:00 PM");
  assert.strictEqual(quotedTime("08:30"), "8:30 AM");
  assert.strictEqual(quotedTime("00:15"), "12:15 AM");
  assert.strictEqual(quotedTime("12:00"), "12:00 PM");
  assert.strictEqual(quotedTime("23:59"), "11:59 PM");
});

check("the am/pm forms still work, and junk is still refused", () => {
  assert.strictEqual(quotedTime("9:00 AM"), "9:00 AM");
  assert.strictEqual(quotedTime("1:30 p.m."), "1:30 PM");
  assert.strictEqual(quotedTime("9 AM"), "9 AM");
  // The whole reason this file exists: a parser artefact must never be
  // repeated to a client as a hearing time.
  // "9:00" is NOT junk, it is AMBIGUOUS: 9 AM or 9 PM depending on the
  // notice. Converting it would be the Imperial bug again, one digit over,
  // so it is refused with the rest. A two-digit hour is unambiguous.
  for (const junk of ["24:00", "99:99 AM", "25:61", "0:15 PM", "9:00", "1:30", "", null, "soon"]) {
    assert.strictEqual(quotedTime(junk), null, `"${junk}" was quoted as a time`);
  }
});

console.log(`\n${passed} checks passed\n`);
