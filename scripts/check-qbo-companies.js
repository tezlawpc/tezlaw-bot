/**
 * check-qbo-companies.js
 *
 * JJ: "i have synced quickbook in the web. but its not syncing with one of my
 * quickbook account." Then, asked what he wanted: "Both, syncing at the same
 * time", on "a separate business, separate books".
 *
 * THE CAUSE OF THE ORIGINAL SYMPTOM. getConfig() was
 * `ORDER BY id DESC LIMIT 1` — one global connection, newest wins. After the
 * second QuickBooks company was connected, every read returned the newer row
 * and the first connection became unreachable without ever being
 * disconnected. One company silently stopped syncing and nothing reported an
 * error, which is exactly what he described.
 *
 * WHAT THIS FILE GUARDS, and why each one is worth a test:
 *
 *   1. Every read and write of the config is scoped to a company. A single
 *      unscoped getConfig() anywhere reintroduces the original bug.
 *   2. disconnect() was an unqualified `DELETE FROM accounting_qb_config`.
 *      With two connections that signs BOTH companies out of QuickBooks
 *      because somebody disconnected one — and the symptom is again "one
 *      company stopped syncing".
 *   3. pushJournalEntry takes its company from the ENTRY, never an argument.
 *      This is the one that cannot be allowed to fail: an entry pushed to the
 *      wrong QuickBooks file is the other business's revenue landing in the
 *      law firm's books, in the system the tax return is built from.
 *   4. The scheduler runs every due company, not one, and one company's
 *      failure does not stop the next. "Both syncing at the same time" is the
 *      requirement; a single try/catch around the loop would mean an expired
 *      token on one connection silently skipped the other.
 *   5. One QuickBooks file cannot be attached to two companies.
 *
 * Nothing here reaches Intuit or Postgres.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
require("./lib/stub-missing").install();

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const src = fs.readFileSync(path.join(ROOT, "qbo-sync.js"), "utf8");
const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// ── The module's public surface, and its callers' ─────────────────────
// Added after accounting.js shipped companyIdOf without exporting it, which
// made every QuickBooks page throw. Source text showed the function defined
// and looked fine.
console.log("the module's public surface");
{
  const qbo = require("../qbo-sync");
  for (const name of ["getConfig", "connectedConfigs", "companyFromState", "companyIdOf",
                      "disconnect", "getAuthorizeUrl", "exchangeCodeForTokens",
                      "pushJournalEntry", "pushAllUnsyncedEntries", "getSyncStatus",
                      "autoMapAccounts", "getAccountMappings", "saveAccountMapping",
                      "runScheduledSyncIfDue"]) {
    ok("exports " + name, typeof qbo[name] === "function", "callers get " + typeof qbo[name]);
  }
  const wanted = new Set();
  for (const m of srv.matchAll(/\bqbo\.([A-Za-z_$][\w$]*)/g)) wanted.add(m[1]);
  const unexported = [...wanted].filter(n => qbo[n] === undefined);
  ok("every qbo.<fn> server.js calls is exported",
     unexported.length === 0, "missing: " + unexported.join(", "));

  // qbo-sync reaches into accounting at runtime; that edge is what broke.
  const acct = require("../accounting");
  const reached = new Set();
  for (const m of src.matchAll(/require\("\.\/accounting"\)\.([A-Za-z_$][\w$]*)/g)) reached.add(m[1]);
  const missingAcct = [...reached].filter(n => acct[n] === undefined);
  ok("every accounting.<fn> qbo-sync reaches for is exported",
     missingAcct.length === 0, "missing: " + missingAcct.join(", "));
}

// ── 1. Nothing reads or writes the config unscoped ─────────────────────
console.log("the config is per company");
{
  ok("getConfig takes a company", /async function getConfig\(company_id/.test(src));
  ok("…and filters on it rather than taking the newest row",
     /FROM accounting_qb_config WHERE company_id = \$1/.test(src));
  ok("…and the old newest-wins query is gone",
     !/FROM accounting_qb_config ORDER BY id DESC/.test(src));

  // A bare getConfig() or saveConfig(x) left anywhere puts the original bug
  // back, so this looks at the whole module rather than named functions.
  const bare = (src.match(/\bgetConfig\(\)/g) || []);
  ok("no call site reads the config unscoped", bare.length === 0, bare.length + " found");
  const bareSave = (src.match(/saveConfig\(\{[^;]*\}\)\s*;/g) || []);
  ok("no call site writes the config unscoped", bareSave.length === 0,
     bareSave.map(x => x.replace(/\s+/g, " ").slice(0, 60)).join(" | "));
}

// ── 2. Disconnecting one company must not sign the other out ───────────
console.log("disconnect is surgical");
{
  ok("the unqualified DELETE is gone",
     !/DELETE FROM accounting_qb_config`\)/.test(src));
  ok("…and it deletes only this company's row",
     /DELETE FROM accounting_qb_config WHERE company_id = \$1/.test(src));
  ok("disconnect takes a company", /async function disconnect\(company_id/.test(src));
}

// ── 3. An entry goes to ITS OWN company's QuickBooks file ──────────────
console.log("entries reach the right books");
{
  const push = src.slice(src.indexOf("async function pushJournalEntry"),
                         src.indexOf("async function pushAllUnsyncedEntries"));
  ok("the company comes off the entry row", /const cid = entry\.company_id/.test(push));
  ok("…and an entry with no company is refused rather than guessed at",
     /if \(!cid\) throw new Error/.test(push));
  ok("…the mappings used are that company's", /getAccountMappings\(cid\)/.test(push));
  ok("…and the request goes out on that company's connection",
     /path: "\/journalentry"[\s\S]{0,120}company_id: cid/.test(push));
  // pushJournalEntry must NOT accept a company argument — if it did, a caller
  // could override the entry's own books, which is the whole risk.
  ok("it takes no company argument that could override the entry",
     /async function pushJournalEntry\(entryId\)/.test(src));

  const all = src.slice(src.indexOf("async function pushAllUnsyncedEntries"),
                        src.indexOf("async function getSyncStatus"));
  ok("a batch push only sweeps up its own company's entries",
     /company_id = \$1/.test(all));
}

// ── 4. Both companies sync, and one failing does not stop the rest ─────
console.log("both companies sync");
{
  const sched = src.slice(src.indexOf("async function runScheduledSyncIfDue"),
                          src.indexOf("// Start the interval-based worker"));
  ok("the scheduler looks at every connected company",
     /connectedConfigs\(\)/.test(sched));
  ok("…and iterates the ones that are due", /for \(const cfg of due\)/.test(sched));
  ok("…each with its own interval and last-run time",
     /cfg\.sync_interval_minutes/.test(sched) && /cfg\.last_scheduled_sync_at/.test(sched));
  // The try/catch must be INSIDE the loop. Outside it, the first company to
  // fail would skip every company after it.
  const loopStart = sched.indexOf("for (const cfg of due)");
  const loopCatch = sched.indexOf("catch (e)", loopStart);
  const loopEnd = sched.indexOf("return { skipped: false", loopStart);
  ok("one company failing does not stop the others",
     loopCatch > loopStart && loopCatch < loopEnd,
     "the catch must sit inside the per-company loop");
  ok("…and each result says which company it was for",
     /company_id: cfg\.company_id/.test(sched));
}

// ── 5. One QuickBooks file, one set of books ───────────────────────────
console.log("a QuickBooks file cannot be shared");
{
  const ex = src.slice(src.indexOf("async function exchangeCodeForTokens"),
                       src.indexOf("async function refreshAccessToken"));
  ok("connecting checks whether that realm is already attached elsewhere",
     /realm_id = \$1 AND c\.company_id <> \$2/.test(ex));
  ok("…and refuses rather than overwriting", /throw new Error\(\s*\n?\s*`That QuickBooks company is already connected/.test(ex));
}

// ── The OAuth round trip has to carry the company ──────────────────────
console.log("the OAuth state");
{
  ok("the consent URL resolves the company before building state",
     /async function getAuthorizeUrl[\s\S]{0,400}await companyIdOf/.test(src));
  // The shape of the state is now asserted in the CSRF section below, which
  // checks the nonce too. This line pinned the old company-id-only pattern
  // and went stale the moment the state became a real CSRF token.
  ok("the callback reads it back", /qbo\.companyFromState\(state\)/.test(srv));
  ok("the connect route awaits the URL now that it is async",
     /await qbo\.getAuthorizeUrl\(/.test(srv));
}

// ── Routes ─────────────────────────────────────────────────────────────
console.log("the routes");
{
  ok("there is one helper for reading the company off a request",
     /function qboCompany\(req\)/.test(srv));
  ok("…and it treats a missing value as the law firm, not as company 0",
     /Number\.isFinite\(n\) && n > 0 \? n : null/.test(srv));
  // Asserted as "never called with no arguments" rather than "called with the
  // literal qboCompany(req)". Several routes read the company into a local
  // first, and matching the spelling instead of the property failed on one of
  // them — the fifth time in this session a fixed-text assertion of mine has
  // flagged correct code.
  for (const call of ["autoMapAccounts", "setAutoPush", "setScheduledSync",
                      "saveAccountMapping", "isConnected", "getSyncStatus",
                      "getAccountMappings", "fetchQBOAccounts", "getConfig"]) {
    const empty = new RegExp("qbo\\." + call + "\\(\\s*\\)", "g");
    const found = srv.match(empty) || [];
    ok(call + " is never called without a company", found.length === 0,
       found.length + " unscoped call(s)");
  }
  ok("the status page reads the company from the request",
     /const cid = qboCompany\(req\);\s*\n\s*const status = await qbo\.getSyncStatus\(cid\)/.test(srv));
  ok("disconnect is given the company", /qbo\.disconnect\(cid\)/.test(srv));
}

// ── OAuth CSRF, revoked grants, and intuit_tid ────────────────────────
// All three were "No" answers on Intuit's app assessment. The CSRF one is
// the only one that was also a real hole: the state carried "tez-<id>",
// which is guessable and was never compared against anything, so the
// callback would exchange an authorization code handed to it by anyone and
// store the resulting tokens against the firm's books.
console.log("OAuth state is a CSRF token");
{
  const auth = src.slice(src.indexOf("async function getAuthorizeUrl"),
                         src.indexOf("async function exchangeCodeForTokens"));
  ok("the state carries a random nonce, not just the company id",
     /crypto\.randomBytes\(\d+\)/.test(auth));
  ok("…and it is stored server-side when issued",
     /saveConfig\(\{ oauth_state: state/.test(auth));
  ok("a bare \"tez-<id>\" no longer parses as a valid state",
     /\^tez-\(\[1-9\]\\d\*\)-\[\\w-\]\{16,\}\$/.test(src));

  const consume = src.slice(src.indexOf("async function consumeState"),
                            src.indexOf("async function exchangeCodeForTokens"));
  ok("the returned state is compared in constant time",
     /timingSafeEqual/.test(consume));
  ok("…and cleared on use, so it cannot be replayed",
     /saveConfig\(\{ oauth_state: null/.test(consume));
  ok("…and rejected once stale", /15 \* 60 \* 1000/.test(consume));
  ok("the callback actually calls it", /await qbo\.consumeState\(state/.test(srv));
  ok("…and refuses a state that is not ours before doing anything else",
     /if \(!claimed\)[\s\S]{0,160}return res\.status\(400\)/.test(srv));
}

console.log("a revoked grant stops the screen lying");
{
  const refresh = src.slice(src.indexOf("async function refreshAccessToken"),
                            src.indexOf("async function getValidAccessToken"));
  ok("invalid_grant is recognised", /invalid_grant/.test(refresh));
  ok("…the dead tokens are cleared", /access_token: null[\s\S]{0,80}refresh_token: null/.test(refresh));
  ok("…and it is recorded as revoked", /revoked_at: new Date\(\)/.test(refresh));
  ok("a successful refresh clears the flag again", /revoked_at: null/.test(refresh));
  ok("isConnected reports false once revoked",
     /async function isConnected[\s\S]{0,400}cfg\.revoked_at\) return false/.test(src));
  ok("…and the status says so rather than going quiet",
     /revoked: true/.test(src));
}

console.log("intuit_tid is captured");
{
  const req = src.slice(src.indexOf("async function qboRequest"),
                        src.indexOf("async function fetchQBOAccounts"));
  ok("it is read from successful responses", /resp\.headers && resp\.headers\["intuit_tid"\]/.test(req));
  // The failing call is the only one anyone ever looks up.
  ok("…and from failures, which is the case that matters",
     /e\.response\.headers\["intuit_tid"\]/.test(req));
  ok("…and it reaches the error message a human sees",
     /intuit_tid \$\{tid\}/.test(req));
}

const note = require("./lib/stub-missing").note();
if (note) console.log(note);
console.log(failures ? "\n" + failures + " failed" : "\nall good");
process.exit(failures ? 1 : 0);
