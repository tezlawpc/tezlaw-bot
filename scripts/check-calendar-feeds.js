// check-calendar-feeds.js — more than one calendar, without losing the first.
//
// The Outlook sync could already subscribe to an iCal URL. Making it plural
// touched three things that fail quietly rather than loudly:
//
//   · the unique constraint moved from (ical_uid) to (feed_id, ical_uid). If
//     the INSERT's ON CONFLICT target does not match that index, every sync
//     inserts a fresh copy of every event instead of updating it, and the
//     calendar fills with duplicates over hours.
//   · feed_id has to be set. NULLs are distinct in a unique index, so an unset
//     feed matches nothing on conflict — same duplication, from the other end.
//   · the settings page posts to routes that have to exist. A typo there is a
//     button that looks fine and does nothing.
//
// None of this needs a database: the SQL and the routes are text, and the
// validation is pure.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const feeds = require(path.join(ROOT, "calendar-feeds.js"));
const clientScript = require(path.join(ROOT, "client-script.js"));

const FEEDS_SRC = fs.readFileSync(path.join(ROOT, "calendar-feeds.js"), "utf8");
const OUTLOOK_SRC = fs.readFileSync(path.join(ROOT, "outlook-sync.js"), "utf8");
const SERVER_SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const BUNDLE_SRC = fs.readFileSync(path.join(ROOT, "public", "calendar-feeds.js"), "utf8");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Routes registered in server.js, as regexes, so a concrete path can be tested.
function routesFor(method) {
  const re = new RegExp(`app\\.(?:${method}|all)\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  const out = [];
  let m;
  while ((m = re.exec(SERVER_SRC)) !== null) out.push(m[1]);
  return out.map(p => new RegExp("^" + p
    .replace(/(:[A-Za-z_]\w*)\([^)]*\)/g, "$1")   // ":id(\\d+)" is just ":id"
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z_]\w*/g, "[^/]+")
    .replace(/\*/g, ".*") + "$"));
}
const ROUTES = {
  get: routesFor("get"), post: routesFor("post"),
  patch: routesFor("patch"), delete: routesFor("delete"),
};
function routeExists(method, p) {
  return (ROUTES[method] || []).some(re => re.test(p));
}

console.log("\ncalendar feeds\n");

// ── The thing that silently duplicates everything ──────────

check("the unique index is on the feed and the UID together", () => {
  assert.ok(/CREATE UNIQUE INDEX[\s\S]{0,120}?ON outlook_synced_events\(feed_id, ical_uid\)/.test(FEEDS_SRC),
    "the migration must index (feed_id, ical_uid) — two calendars can carry the same event");
});

check("the insert's conflict target matches that index", () => {
  assert.ok(/ON CONFLICT \(feed_id, ical_uid\) DO UPDATE/.test(OUTLOOK_SRC),
    "ON CONFLICT must name exactly the unique index, or every sync re-inserts every event");
  assert.ok(!/ON CONFLICT \(ical_uid\)/.test(OUTLOOK_SRC),
    "the old single-column conflict target is still there — it no longer matches any index");
});

check("the old single-column constraint is dropped by lookup, not by guessed name", () => {
  assert.ok(/pg_constraint/.test(FEEDS_SRC),
    "the constraint name is assigned by Postgres; find it rather than assuming the default");
  assert.ok(/DROP CONSTRAINT/.test(FEEDS_SRC));
});

check("events are never written without a feed", () => {
  assert.ok(/async function resolveFeedId/.test(OUTLOOK_SRC),
    "an unset feed_id makes the unique index match nothing — resolve it instead");
  assert.ok(/const feed_id = await resolveFeedId\(feedId\)/.test(OUTLOOK_SRC),
    "upsertEvents must resolve a feed before writing");
  assert.ok(/No calendar feed exists/.test(OUTLOOK_SRC),
    "if no feed can be resolved it must say so, not write NULLs");
});

check("existing events are backfilled before the index is built", () => {
  const backfill = FEEDS_SRC.indexOf("UPDATE outlook_synced_events SET feed_id");
  const index = FEEDS_SRC.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_outlook_feed_uid");
  assert.ok(backfill > -1, "rows that predate feeds must be given one");
  assert.ok(index > -1);
  assert.ok(backfill < index,
    "the backfill has to run before the unique index, or rows with a NULL feed survive it");
});

// ── Not changing what the calendar shows ───────────────────

check("the migrated Outlook feed keeps its keyword filter", () => {
  assert.ok(/VALUES \(\$1, \$2, \$3, \$4, 'keywords', \$5, 0\)/.test(FEEDS_SRC),
    "the migrated feed must stay keyword-filtered — switching it to 'all' would " +
    "start showing every meeting in the firm calendar without anyone asking");
});

check("only a feed set to 'all' bypasses the keyword filter", () => {
  assert.ok(/if \(config\?\.filter_mode === "all"\) return true;/.test(OUTLOOK_SRC));
});

// ── Validation ─────────────────────────────────────────────

check("webcal:// is accepted and normalised", () => {
  assert.strictEqual(feeds.normaliseUrl("webcal://example.com/a.ics"), "https://example.com/a.ics");
  assert.strictEqual(feeds.normaliseUrl("WEBCAL://example.com/a.ics"), "https://example.com/a.ics");
});

check("a URL that is not a URL is refused", () => {
  for (const bad of ["example.com/a.ics", "ftp://example.com/a.ics", "javascript:alert(1)", "/etc/passwd"]) {
    assert.throws(() => feeds.normaliseUrl(bad), /must start with https/, `${bad} should be refused`);
  }
});

check("an empty URL is allowed, as a calendar not set up yet", () => {
  assert.strictEqual(feeds.normaliseUrl(""), null);
  assert.strictEqual(feeds.normaliseUrl("   "), null);
  assert.strictEqual(feeds.normaliseUrl(null), null);
});

check("https passes through untouched", () => {
  assert.strictEqual(feeds.normaliseUrl("  https://outlook.office365.com/x/calendar.ics  "),
    "https://outlook.office365.com/x/calendar.ics");
});

check("a colour is a colour, or it falls back to the palette", () => {
  assert.strictEqual(feeds.normaliseColor("#00897B"), "#00897B");
  assert.strictEqual(feeds.normaliseColor("teal"), feeds.FEED_COLORS[0]);
  assert.strictEqual(feeds.normaliseColor(""), feeds.FEED_COLORS[0]);
  assert.strictEqual(feeds.normaliseColor("#fff"), feeds.FEED_COLORS[0], "three-digit hex is not accepted");
  // Successive feeds take successive colours rather than all arriving the same.
  assert.strictEqual(feeds.normaliseColor(null, 1), feeds.FEED_COLORS[1]);
  assert.strictEqual(feeds.normaliseColor(null, feeds.FEED_COLORS.length), feeds.FEED_COLORS[0], "the palette wraps");
});

check("the palette is distinct", () => {
  assert.strictEqual(new Set(feeds.FEED_COLORS).size, feeds.FEED_COLORS.length,
    "two calendars sharing a colour cannot be told apart on the grid");
  for (const c of feeds.FEED_COLORS) assert.ok(/^#[0-9a-f]{6}$/i.test(c), `${c} is not a hex colour`);
});

// ── The page ───────────────────────────────────────────────

check("the page renders a row per calendar", () => {
  const html = feeds.renderFeedsPage([
    { id: 1, name: "Firm calendar (Outlook)", ical_url: "https://a/b.ics", color: "#0078d4",
      enabled: true, filter_mode: "keywords", keyword_filter: "hearing", event_count: 42 },
    { id: 2, name: "MyCase", ical_url: "https://c/d.ics", color: "#00897b",
      enabled: true, filter_mode: "all", keyword_filter: "", event_count: 7 },
  ]);
  assert.ok(html.includes("Firm calendar (Outlook)"));
  assert.ok(html.includes("MyCase"));
  assert.ok(html.includes('data-id="1"') && html.includes('data-id="2"'));
  assert.ok(html.includes("42 event(s) stored"));
});

check("a name with a quote in it cannot break the page", () => {
  const html = feeds.renderFeedsPage([
    { id: 1, name: 'O"Brien\'s <script>alert(1)</script>', ical_url: "", color: "#0078d4",
      enabled: true, filter_mode: "all", keyword_filter: "", event_count: 0 },
  ]);
  assert.ok(!html.includes("<script>alert(1)</script>"), "a feed name is rendered, not executed");
  assert.ok(html.includes("&lt;script&gt;"));
});

check("no calendars yet says so", () => {
  const html = feeds.renderFeedsPage([]);
  assert.ok(/No calendars yet/i.test(html));
});

check("the page loads its client bundle the blessed way", () => {
  assert.ok(/clientScriptTag\("calendar-feeds\.js"\)/.test(FEEDS_SRC),
    "inline script in a server template literal is the escaping trap client-script.js exists to avoid");
  assert.ok(clientScript.CLIENT_BUNDLES.includes("calendar-feeds.js"),
    "the bundle must be registered, or a stray copy at the repo root is never rescued");
  assert.ok(fs.existsSync(path.join(ROOT, "public", "calendar-feeds.js")),
    "public/calendar-feeds.js is missing — the page would render with dead buttons");
});

check("the client bundle parses", () => {
  new Function(BUNDLE_SRC);   // throws on a syntax error
});

// ── Page and server agree ──────────────────────────────────

check("every route the page calls exists on the server", () => {
  const expected = [
    ["get", "/admin/calendars"],
    ["post", "/admin/calendars"],
    ["post", "/admin/calendars/sync-all"],
    ["post", "/admin/calendars/7/sync"],
    ["patch", "/admin/calendars/7"],
    ["delete", "/admin/calendars/7"],
  ];
  for (const [method, p] of expected) {
    assert.ok(routeExists(method, p), `${method.toUpperCase()} ${p} is not registered in server.js`);
  }
});

check("the bundle asks for exactly those paths", () => {
  for (const needle of ['"/admin/calendars/" + id', '"/admin/calendars"', '"/admin/calendars/sync-all"']) {
    assert.ok(BUNDLE_SRC.includes(needle), `the page should call ${needle}`);
  }
  // Catch a path typed somewhere else by hand.
  const stray = BUNDLE_SRC.match(/["'](\/admin\/[^"']*)["']/g) || [];
  for (const raw of stray) {
    const p = raw.slice(1, -1);
    if (p.startsWith("/admin/calendars")) continue;
    assert.fail(`the bundle references ${p}, which is not a calendars route`);
  }
});

check("the old single-feed page no longer offers a form that does nothing", () => {
  assert.ok(/app\.get\("\/admin\/outlook-sync",\s*\(req, res\) => res\.redirect\("\/admin\/calendars"\)\)/.test(SERVER_SRC),
    "/admin/outlook-sync edited outlook_config, which the sync no longer reads — it must redirect");
});

// ── One flooded feed must not take the others down ─────────

check("syncAll isolates each calendar", () => {
  const body = FEEDS_SRC.slice(FEEDS_SRC.indexOf("async function syncAll"));
  assert.ok(/for \(const feed of feeds\)/.test(body), "feeds are synced one at a time");
  assert.ok(/try \{[\s\S]*?catch \(e\)/.test(body),
    "each feed needs its own try — one unreachable calendar must not stop the rest");
});

check("a disabled calendar contributes nothing", () => {
  const cal = fs.readFileSync(path.join(ROOT, "eoir-calendar.js"), "utf8");
  assert.ok(/if \(feed && feed\.enabled === false\) continue;/.test(cal),
    "switching a calendar off must remove its events from the grid");
});

check("the feed lookup cannot take the calendar down with it", () => {
  const cal = fs.readFileSync(path.join(ROOT, "eoir-calendar.js"), "utf8");
  const block = cal.slice(cal.indexOf("let feedsById"), cal.indexOf("// Post-filter for judge/court"));
  assert.ok(/catch \(e\)/.test(block),
    "on a database without the feeds table, events must still render — not vanish");
});

console.log(`\n${passed} checks passed\n`);
