/**
 * check-admin-404.js
 *
 * "/admin/accounting/trust i get Cannot GET /admin/trust" — reported twice,
 * because the first answer ("nothing links there") was true and useless.
 *
 * WHAT IT ACTUALLY WAS
 * /admin/trust is the Tara app's path, not this server's. The app's screen is
 * app/(firm)/admin/trust.tsx; Expo Router drops the (firm) group from the URL,
 * so the app's route for trust accounting is /admin/trust while this server's
 * is /admin/accounting/trust. Two surfaces of one firm, one hostname in
 * everybody's head, two names for the same page. The path got tried against
 * the wrong one and express answered "Cannot GET".
 *
 * That bare string is the part worth fixing. It does not say whether you are
 * signed in, whether the page moved, or how to get back — so a 404 that any
 * paralegal could have read in two seconds cost a diagnosis round trip
 * instead, twice over.
 *
 * WHAT THIS FILE GUARDS
 * Most of it is about the handler not doing damage, because a middleware
 * registered with no path matches EVERY request that falls through:
 *
 *   · it must let anything that is not /admin past untouched
 *   · it must sit below the auth mount, so a stranger gets the login page and
 *     never learns from a 404 which admin pages exist
 *   · it must answer JSON to the app's API paths, never markup
 *   · it must escape the path it echoes back
 *   · its aliases must point at routes that really exist, or it hands someone
 *     a redirect into a second 404
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("\nAdmin 404: a dead end that is not dead\n");

// The handler's source, isolated once so every case below reads the same text.
const AT = srv.indexOf("const ADMIN_ALIASES = {");
const LISTEN = srv.indexOf("app.listen(PORT, async () => {");
const HANDLER = AT > -1 && LISTEN > AT ? srv.slice(AT, LISTEN) : "";

// ── It exists, and in the one place it can safely live ─────

check("the handler is present", () => {
  assert.ok(AT > -1, "ADMIN_ALIASES not found");
  assert.ok(HANDLER.length > 400, "the handler body did not slice out; the cases below would pass vacuously");
});

check("it is registered last, after every admin route", () => {
  const adminRouter = srv.indexOf('app.use("/admin", adminRouter)');
  assert.ok(adminRouter > -1, "the admin router mount moved");
  assert.ok(AT > adminRouter,
    "registered above the admin router, so it would swallow every router route");
  assert.ok(LISTEN > AT, "registered after app.listen, where it never runs");
});

check("it sits below the auth mount, so a 404 cannot enumerate the admin", () => {
  // A stranger must be bounced to /admin/login. If this handler ran first, the
  // 404 page itself would tell them which paths are real and which are not.
  const auth = srv.indexOf('app.use("/admin", auth.requireAdminAuth)');
  assert.ok(auth > -1, "the blanket admin auth mount moved");
  assert.ok(AT > auth, "the 404 handler is above the auth gate");
});

// ── It cannot hurt anything outside the admin ──────────────

check("anything that is not /admin passes straight through", () => {
  // This is an app.use() with no path: it sees every unmatched request in the
  // server, including the public site, the signing links and the app's APIs.
  assert.ok(/if \(!req\.path\.startsWith\("\/admin"\)\) return next\(\);/.test(HANDLER),
    "without this bail-out the handler answers for the whole site");
  const bail = HANDLER.indexOf('startsWith("/admin")) return next()');
  assert.ok(bail > -1 && bail < HANDLER.indexOf("ADMIN_ALIASES[want]"),
    "the bail-out must come before any work");
});

check("only GET and HEAD get a page", () => {
  // A mistyped POST should fail as a failed POST. Rendering a page for it
  // would dress a write that never happened up as somewhere somebody visited.
  assert.ok(/req\.method !== "GET" && req\.method !== "HEAD"\) return next\(\);/.test(HANDLER));
});

check("the app's API paths get JSON, not markup", () => {
  // fetch() handed "<" reports a JSON syntax error, which is a worse bug
  // report than "no such endpoint".
  assert.ok(/req\.path\.startsWith\("\/admin\/api"\) \|\| !req\.accepts\("html"\)/.test(HANDLER));
  assert.ok(/res\.status\(404\)\.json\(\{ ok: false, error:/.test(HANDLER));
});

// ── The aliases go somewhere real ──────────────────────────

// Pull the table out of the source and evaluate just that literal, so a typo
// in a target is caught here rather than by a person following a redirect
// into a second 404.
const TABLE = (() => {
  const open = srv.indexOf("{", AT);
  const close = srv.indexOf("};", open);
  // eslint-disable-next-line no-eval
  return eval("(" + srv.slice(open, close + 1) + ")");
})();

check("the table parses, and holds the path that was reported", () => {
  assert.strictEqual(typeof TABLE, "object");
  assert.strictEqual(TABLE["/admin/trust"], "/admin/accounting/trust",
    "the Tara app's own path for this page");
});

check("every alias points at a route this server actually registers", () => {
  const missing = [];
  for (const [from, to] of Object.entries(TABLE)) {
    if (!srv.includes(`app.get("${to}"`)) missing.push(`${from} -> ${to}`);
  }
  assert.deepStrictEqual(missing, [],
    "these redirect into a second 404, which is worse than the first");
});

check("no alias redirects to another alias", () => {
  // A chain costs an extra round trip and, if it ever loops, the browser gives
  // up with an error that names neither path.
  for (const to of Object.values(TABLE)) {
    assert.ok(!(to in TABLE), `${to} is both a target and an alias`);
  }
});

check("no alias shadows a real page", () => {
  // If a path both routes and aliases, the route wins (this runs last) — so
  // the alias is dead code, and someone will later 'fix' the live page away.
  for (const from of Object.keys(TABLE)) {
    assert.ok(!srv.includes(`app.get("${from}"`), `${from} is already a real route`);
  }
});

check("the redirect is temporary, never permanent", () => {
  // A 301 is cached by the browser past any later change to where the page
  // lives, and nothing server-side can clear it.
  assert.ok(/res\.redirect\(302,/.test(HANDLER));
  assert.ok(!/res\.redirect\(301/.test(HANDLER));
});

check("a query string survives the redirect", () => {
  // The trust page takes an as-of date; dropping it would silently show today.
  assert.ok(/req\.originalUrl\.slice\(q\)/.test(HANDLER));
});

// ── The page itself ────────────────────────────────────────

check("the echoed path is escaped and bounded", () => {
  // req.path comes off the wire and goes into HTML.
  assert.ok(/want\.replace\(\/\[<>&"'\]\/g, ""\)\.slice\(0, 200\)/.test(HANDLER));
  assert.ok(!/\$\{want\}/.test(HANDLER.slice(HANDLER.indexOf("renderAdminChrome"))),
    "the raw path is interpolated into the page");
});

check("it renders inside the admin chrome, with the nav", () => {
  // The whole point: a page you can navigate out of, not a string.
  assert.ok(/hearingNotes\.renderAdminChrome\(\{/.test(HANDLER));
  assert.ok(/status\(404\)\.send\(/.test(HANDLER), "and still a 404 to anything reading the status");
});

check("it says you are signed in", () => {
  // The first thing anyone assumes about a blank admin error is a permissions
  // problem, and that assumption sends them to JJ.
  assert.ok(/not a permissions problem/.test(HANDLER));
});

check("it points at the real trust page and names the app's path", () => {
  // So the next person to hit this does not repeat the hunt.
  assert.ok(/href="\/admin\/accounting\/trust"/.test(HANDLER));
  assert.ok(/Tara app/.test(HANDLER));
});

check("it offers a way out", () => {
  assert.ok(/href="\/admin\/hearing\/notes"/.test(HANDLER));
  assert.ok(/href="\/admin\/accounting"/.test(HANDLER));
});

// ── The reason, kept next to the code ──────────────────────

check("the divergence is written down where the handler is", () => {
  // Two surfaces naming one page differently is the actual defect; the alias
  // only hides it. Whoever unifies them later needs to find this note.
  const note = srv.slice(Math.max(0, AT - 2600), AT);
  assert.ok(/Expo Router/.test(note) && /\(firm\)/.test(note),
    "nothing explains why /admin/trust is a name worth aliasing");
  assert.ok(/NOT a fuzzy search/.test(note),
    "the next person will want to make this guess at the nearest page");
});

console.log(`\n${passed} checks passed\n`);
