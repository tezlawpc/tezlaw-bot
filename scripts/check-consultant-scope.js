/**
 * check-consultant-scope.js
 *
 * JJ: "when a consultant is selected and the folder is selected, make sure
 * that consultant is only accessible to that files in the folder."
 *
 * Auditing that turned up something larger than the folder scoping. A
 * consultant is an outside referral broker who has a real admin_users row and
 * signs in through the SAME /admin/login form as the firm. server.js mounts
 * `app.use("/admin", auth.requireAdminAuth)` across the whole admin surface,
 * and requireAdminAuth sets req.user and calls next() for every role — it has
 * never checked one. So a consultant holding an ordinary session cookie could
 * type /admin/clients and be served the firm's entire client base.
 *
 * The login handler's own comment called the firm panel one consultants
 * "can't see anyway". That described where the UI links them. Navigation is
 * not access control, and this file exists so that distinction cannot quietly
 * lapse again.
 *
 * Three things are checked, in the order they matter:
 *   1. /admin refuses consultants at the door, and still lets them log in and
 *      out — a guard that locks someone out of /admin/logout is its own bug.
 *   2. What a consultant CAN see is resolved from client_consultants, the
 *      table their Dropbox folder populates — not from the first-name LIKE
 *      match that governs firm staff, which was wrong in both directions.
 *   3. A consultant cannot attach a work order to a client that is not theirs
 *      by typing that client's name.
 *
 * The middleware is exercised, not pattern-matched. Source assertions are used
 * only where behaviour cannot be reached without a database.
 */
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();   // auth.js → db.js → require("pg")
const auth = require("../auth");

const REPO = path.join(__dirname, "..");
const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const api = fs.readFileSync(path.join(REPO, "app-api.js"), "utf8");
const authSrc = fs.readFileSync(path.join(REPO, "auth.js"), "utf8");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

/** Run requireFirmUser against a fake request and report what it decided. */
function guard(user, { path: p = "/clients", method = "GET" } = {}) {
  const out = { next: false, redirect: null, status: null, json: null, body: null };
  const req = { user, path: p, method, originalUrl: "/admin" + p, url: "/admin" + p };
  const res = {
    redirect(u) { out.redirect = u; return res; },
    status(c) { out.status = c; return res; },
    json(o) { out.json = o; return res; },
    send(b) { out.body = b; return res; },
  };
  auth.requireFirmUser(req, res, () => { out.next = true; });
  return out;
}

const CONSULTANT = { uid: 7, u: "david.broker", n: "David Broker", r: "consultant" };

// ── 1. The door ────────────────────────────────────────────────────────
console.log("\n/admin is firm staff only");
{
  const got = guard(CONSULTANT);
  ok("a consultant is NOT let through to /admin/clients", got.next === false);
  ok("...and is sent to their own portal rather than a dead end", got.redirect === "/consultant");

  const posted = guard(CONSULTANT, { path: "/clients/wang/delete", method: "POST" });
  ok("a consultant write is refused", posted.next === false && posted.status === 403);
  ok("...as JSON, since a redirect would look like success to a fetch()",
    !!posted.json && posted.json.ok === false);

  for (const r of ["admin", "manager", "attorney", "paralegal", "viewer"]) {
    const g = guard({ uid: 1, u: r, n: r, r });
    ok(`a ${r} is let through`, g.next === true, JSON.stringify(g));
  }

  ok("consultant is not in the firm-role list", !auth.FIRM_ROLES.includes("consultant"));
  ok("the firm-role list is an allowlist, so a new role is denied until named",
    guard({ uid: 9, u: "x", n: "x", r: "bookkeeper" }).next === false);
  ok("...and an unknown role gets a denial, not a bounce to the consultant portal",
    guard({ uid: 9, u: "x", n: "x", r: "bookkeeper" }).status === 403);
}

console.log("\nsigning in and out still works");
{
  for (const p of ["/login", "/logout", "/setup", "/whoami", "/whoami-early"]) {
    ok(`${p} is reachable with no session at all`, guard(null, { path: p }).next === true);
  }
  ok("a consultant can still sign OUT", guard(CONSULTANT, { path: "/logout" }).next === true);
  ok("a consultant can still reach the login form", guard(CONSULTANT, { path: "/login" }).next === true);

  const anon = guard(null, { path: "/clients" });
  ok("no session on a real page goes to login", anon.next === false && /\/admin\/login/.test(anon.redirect || ""));

  // The two guards must agree on what is public. A copied list would drift.
  ok("both guards read ONE whitelist", (authSrc.match(/ADMIN_WHITELIST = new Set/g) || []).length === 1);
  ok("requireAdminAuth uses it", /ADMIN_WHITELIST\.has\(path\)/.test(authSrc));
  ok("requireFirmUser uses it", /ADMIN_WHITELIST\.has\(req\.path\)/.test(authSrc));
}

console.log("\nthe guard is actually mounted, and in the right order");
{
  const adminAuth = srv.indexOf('app.use("/admin", auth.requireAdminAuth)');
  const firmUser = srv.indexOf('app.use("/admin", auth.requireFirmUser)');
  ok("requireAdminAuth is mounted", adminAuth > -1);
  ok("requireFirmUser is mounted", firmUser > -1);
  ok("...after it, so req.user exists when the role is read", firmUser > adminAuth);

  // Everything else under /admin registers later, so a blanket mount covers it.
  const firstRoute = srv.indexOf('app.get("/admin/clients"');
  ok("it is mounted before the admin routes it protects",
    firstRoute === -1 || firmUser < firstRoute);
}

// ── 2. What a consultant may see ───────────────────────────────────────
console.log("\nvisibility comes from the folder link, not a name match");
{
  const fn = api.slice(api.indexOf("async function getVisibleClientKeys"),
                       api.indexOf("// True if the user can access rows for this client_key."));
  ok("there is a consultant branch", /user\?\.r === "consultant"/.test(fn));
  ok("it reads client_consultants", /FROM client_consultants/.test(fn));
  ok("...only live links count", /removed_at IS NULL/.test(fn));

  const branch = fn.slice(fn.indexOf('user?.r === "consultant"'), fn.indexOf("const terms ="));
  ok("the branch RETURNS, so a consultant never reaches the assigned_to LIKE match",
    /return new Set\(/.test(branch) && !/LOWER\(assigned_to\)/.test(branch));
  ok("a database error fails closed, returning an empty set",
    /catch[\s\S]{0,200}return new Set\(\);/.test(branch));

  ok("the consultant branch is above the name-match rule, not below it",
    fn.indexOf('user?.r === "consultant"') < fn.indexOf("userAssignmentTerms(user)"));

  // canUserAccessClient is the one gate /api/documents/:id uses, and it routes
  // through getVisibleClientKeys — so fixing that function fixed the document
  // route too, rather than each caller needing its own consultant special case.
  const can = api.slice(api.indexOf("async function canUserAccessClient"),
                        api.indexOf("// Filters items by client_key membership"));
  ok("document access still routes through the one visibility function",
    /getVisibleClientKeys\(user\)/.test(can));
  ok("...and an admin/manager short-circuit does not catch consultants",
    /isManager\(user\)/.test(can) && !/consultant/.test(can));
}

// ── 3. A consultant cannot claim someone else's client ─────────────────
console.log("\na typed client name cannot attach to someone else's client");
{
  const route = api.slice(api.indexOf('app.post("/api/consultant/tasks"'),
                          api.indexOf('app.get("/api/consultant/tasks/:id"'));
  ok("the derived key is not assigned unconditionally",
    !/cleaned\.client_key = cleaned\.client_name\.toLowerCase\(\)/.test(route));
  ok("a key that is already one of theirs is allowed", /mine\.has\(derived\)/.test(route));
  ok("...and the consultant's own set comes from the link table",
    /getConsultantClientKeys\(userId\)/.test(route));
  ok("an existing client that is NOT theirs is checked for", /FROM tasks WHERE client_key = \$1/.test(route));
  ok("...and in that case no key is attached at all",
    /if \(!taken\.rows\.length\) cleaned\.client_key = derived;/.test(route));
  ok("the submission still needs approval before it enters the firm's queue",
    /status: "pending_approval"/.test(route));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CONSULTANT SCOPE CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
