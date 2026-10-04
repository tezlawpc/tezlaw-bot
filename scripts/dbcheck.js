/**
 * dbcheck.js — run the REAL server against a REAL (scratch) Postgres and
 * fail on any query the database rejects.
 *
 * Why this exists. Every other check in scripts/ stubs the database. That is
 * what makes them fast, and it is also why "column t.completed does not
 * exist" reached a consultant's screen in production: the query had never
 * once been sent to a database before it shipped. A stub cannot know that a
 * column was renamed. Postgres can.
 *
 * What it does:
 *   1. empties a scratch database (it refuses anything that is not on this
 *      machine and not named *_dbcheck — it cannot be pointed at production);
 *   2. boots server.js twice, the way a new deploy and then a restart would,
 *      with scripts/dbcheck-hook.js watching every query from every pool;
 *   3. seeds a handful of users, clients, tasks, hearings and deadlines
 *      through the repo's own modules;
 *   4. signs in as an administrator, an attorney, a consultant and a client
 *      and walks the site: every admin page it can find a link to, the
 *      consultant portal, and every parameter-free GET under /api;
 *   5. exercises the write paths that have broken before: a consultant sends
 *      a task with a document, an attorney approves it, a message, an alert.
 *
 * It fails (exit 1) on a schema error that is not in dbcheck-known.json.
 * That file is a ratchet: it lists the errors that already existed when the
 * check was introduced, so the check can block new ones from day one. When a
 * known one stops happening the run says so; delete it from the file (or run
 * with --update) and it can never quietly come back.
 *
 * If the check cannot run at all — no database, the server will not start —
 * it says so loudly and exits 0, so that trouble with the test machine never
 * blocks a deploy. Pass --strict to make that a failure too.
 *
 *   node scripts/dbcheck.js            run
 *   node scripts/dbcheck.js --update   rewrite dbcheck-known.json from this run
 *   node scripts/dbcheck.js --verbose  print every page visited
 *
 * Database: DBCHECK_DATABASE_URL, default postgres://tez:tez@127.0.0.1:5432/tez_dbcheck
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ARGS = new Set(process.argv.slice(2));
const UPDATE = ARGS.has("--update"), VERBOSE = ARGS.has("--verbose"), STRICT = ARGS.has("--strict");
const KNOWN_FILE = path.join(__dirname, "dbcheck-known.json");
const DB_URL = process.env.DBCHECK_DATABASE_URL || "postgres://tez:tez@127.0.0.1:5432/tez_dbcheck";
const PORT = Number(process.env.DBCHECK_PORT || 3987);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dbcheck-"));
const HOOK_LOG = path.join(TMP, "schema-errors.jsonl");
const SERVER_LOG = path.join(TMP, "server.log");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(...a);

let child = null;
function couldNotRun(why) {
  if (child) try { child.kill("SIGKILL"); } catch (_) {}
  say("\n============================================================");
  say("DATABASE CHECK DID NOT RUN");
  say("  " + why);
  say("  Nothing was tested. This is not a pass.");
  say("============================================================");
  if (process.env.GITHUB_ACTIONS) say(`::warning title=Database check did not run::${why.replace(/\n/g, " ")}`);
  process.exit(STRICT ? 1 : 0);
}

// ── 1. The scratch database, and nothing else ────────────────
let dbName, dbHost;
try { const u = new URL(DB_URL); dbName = u.pathname.replace(/^\//, ""); dbHost = u.hostname; } catch (_) { couldNotRun("DBCHECK_DATABASE_URL is not a database address."); }
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(dbHost) || !/_dbcheck$/.test(dbName)) {
  couldNotRun(`Refusing "${dbName}" on ${dbHost}. This check empties its database, so it only runs against one on this machine whose name ends in _dbcheck.`);
}
process.env.DATABASE_URL = DB_URL;           // for the repo modules this file loads to seed
if (!process.env.NODE_ENV) process.env.NODE_ENV = "development";

async function emptyDatabase() {
  const { Client } = require("pg");
  let lastErr;
  for (const ssl of [{ rejectUnauthorized: false }, false]) {
    const c = new Client({ connectionString: DB_URL, ssl });
    try {
      await c.connect();
      if (ssl === false) { await c.end(); throw new Error("the database accepts connections only without SSL; the server always asks for SSL, so it could not connect"); }
      await c.query("DROP SCHEMA IF EXISTS public CASCADE");
      await c.query("CREATE SCHEMA public");
      await c.end();
      return;
    } catch (e) { lastErr = e; try { await c.end(); } catch (_) {} if (/only without SSL/.test(e.message)) break; }
  }
  throw lastErr;
}

// ── 2. The server, watched ──────────────────────────────────
function startServer() {
  const out = fs.openSync(SERVER_LOG, "a");
  // A clean environment: no API keys, no tokens, no webhooks. The server can
  // read its scratch database and nothing it does can leave this machine
  // with the firm's name on it.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TZ: process.env.TZ || "America/Los_Angeles",
    NODE_ENV: "development", PORT: String(PORT), DATABASE_URL: DB_URL, PUBLIC_BASE_URL: BASE,
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "dbcheck-hook.js"))}`,
    DBCHECK_LOG: HOOK_LOG,
  };
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", out, out] });
  child.on("exit", () => { child = null; });
}
async function stopServer() {
  if (!child) return;
  const c = child;
  c.kill("SIGTERM");
  for (let i = 0; i < 30 && child; i++) await sleep(100);
  if (child) { try { c.kill("SIGKILL"); } catch (_) {} await sleep(300); }
}
const size = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
async function waitReady(label) {
  const t0 = Date.now();
  for (;;) {
    if (!child) throw new Error(`the server stopped while ${label}. Last lines:\n` + tail(SERVER_LOG, 12));
    // Any answer will do: with no users yet the sign-in page redirects to first-time setup.
    try { const r = await fetch(BASE + "/admin/login", { redirect: "manual" }); if (r.status < 500) break; } catch (_) {}
    if (Date.now() - t0 > 120000) throw new Error(`the server did not answer within two minutes while ${label}. Last lines:\n` + tail(SERVER_LOG, 12));
    await sleep(500);
  }
  // Start-up work carries on after the port opens (tables, backfills,
  // schedulers). Wait until it has been quiet for a few seconds.
  let last = -1, quiet = 0;
  for (let i = 0; i < 60 && quiet < 4; i++) {
    await sleep(1000);
    const now = size(SERVER_LOG) + size(HOOK_LOG);
    quiet = now === last ? quiet + 1 : 0; last = now;
  }
}
const tail = (f, n) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").slice(-n).map(l => "    " + l.slice(0, 200)).join("\n"); } catch (_) { return "    (no log)"; } };
const readHook = () => { try { return fs.readFileSync(HOOK_LOG, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };

// ── 3. Seed, through the repo's own modules ─────────────────
async function seed() {
  const db = require("../db"), auth = require("../auth");
  const q = (s, v) => db.query(s, v);
  const mk = async (username, fullName, role, extra = {}) => {
    try { await auth.createUser({ username, password: "Dbcheck-Pass-1234", fullName, role, phone: extra.phone || null, email: extra.email || null }); }
    catch (e) { if (!/exist|duplicate/i.test(e.message)) throw e; }
    if (extra.broker) await q(`UPDATE admin_users SET broker_folder = $2 WHERE username = $1`, [username, extra.broker]);
  };
  await require("../broker-accounts").ensureColumn();
  await mk("dbc.admin", "Dana Admin", "admin");
  await mk("dbc.attorney", "Avery Attorney", "attorney", { phone: "626-555-0142" });
  await mk("dbc.paralegal", "Pat Paralegal", "paralegal");
  await mk("dbc.consultant", "Casey Consultant", "consultant", { broker: "Casey Consultant" });
  await q(`INSERT INTO tasks (title, description, matter_type, status, client_name, client_key, a_number, assigned_to, due_date) VALUES
    ('I-589 asylum application','internal','immigration','in_progress','Wang, Li','a-111222333','111-222-333','Avery Attorney', CURRENT_DATE + 58),
    ('I-765 work permit','internal','immigration','completed','Wang, Li','a-111222333','111-222-333','Avery Attorney', NULL),
    ('Demand letter','internal','pi','pending','Stranger, Sam','n-stranger-sam',NULL,'Pat Paralegal', CURRENT_DATE + 3)`);
  await q(`INSERT INTO client_dropbox_mapping (client_key, client_name, a_number, dropbox_path) VALUES
    ('a-111222333','Wang, Li','111-222-333','/Immigration/Casey Consultant/Wang, Li'),
    ('a-444555666','Chen, Mei','444-555-666','/Immigration/Casey Consultant/Chen, Mei'),
    ('n-stranger-sam','Stranger, Sam',NULL,'/Immigration/Someone Else/Stranger, Sam') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO client_hearing_notices (client_key, client_name, a_number, dropbox_path, hearing_date, hearing_time_text, hearing_type, court_name) VALUES
    ('a-111222333','Wang, Li','111-222-333','/x/a.pdf', (CURRENT_DATE + 30) + TIME '08:30','8:30 AM','Master Calendar','Los Angeles Immigration Court'),
    ('a-111222333','Wang, Li','111-222-333','/x/b.pdf', (CURRENT_DATE + 75)::timestamp, NULL,'Individual','Los Angeles Immigration Court')`);
  await q(`INSERT INTO deadlines (source_type, client_name, a_number, due_date, description) VALUES ('manual','Wang, Li','111-222-333', CURRENT_DATE + 20, 'File I-589 supplement')`);
  await q(`INSERT INTO client_accounts (phone, client_key, full_name, preferred_lang) VALUES ('+16265550001','a-111222333','Li Wang','en') ON CONFLICT DO NOTHING`);
  await require("../broker-accounts").relinkAll({ by: 1 });

  const users = (await q(`SELECT id, username, full_name, role FROM admin_users WHERE username LIKE 'dbc.%' ORDER BY id`)).rows;
  const tok = {};
  for (const u of users) tok[u.role] = await auth.makeToken({ uid: u.id, u: u.username, n: u.full_name, r: u.role, exp: Date.now() + 3600e3 });
  const acct = (await q(`SELECT * FROM client_accounts WHERE phone = '+16265550001'`)).rows[0];
  tok.client = await auth.makeToken({ uid: "c" + acct.id, u: acct.phone, n: acct.full_name, r: "client", ck: acct.client_key, exp: Date.now() + 3600e3 });
  return { tok, cookie: auth.COOKIE_NAME };
}

// ── 4. Walk the site ────────────────────────────────────────
// Links that do something rather than show something, or that hand back a
// file: not followed.
const NO_FOLLOW = /logout|\/delete|\/remove|download|export|\.csv|\.pdf|\.zip|\.docx|\/backup|oauth|\/connect|callback|webhook|\/stream|\/sse|\/print|\/audio|\/file\b|unsubscribe|\/run\b|\/sync\b|\/send\b|\/login/i;
const visited = new Map();     // url → status
const trouble = [];            // 5xx responses, for the report
async function get(url, { cookie, bearer } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = "Bearer " + bearer;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(BASE + url, { headers, redirect: "manual", signal: ctl.signal });
    const type = r.headers.get("content-type") || "";
    const text = /html|json|text/.test(type) ? await r.text() : (await r.arrayBuffer(), "");
    return { status: r.status, text, type };
  } catch (e) { return { status: 0, text: "", type: "", error: e.name === "AbortError" ? "timed out" : e.message }; }
  finally { clearTimeout(timer); }
}
async function crawl(start, prefix, auth, limit) {
  const queue = [...start]; let n = 0;
  while (queue.length && n < limit) {
    const url = queue.shift(); const key = url.split("#")[0];
    if (visited.has(prefix + key) || NO_FOLLOW.test(key)) continue;
    const r = await get(key, auth); visited.set(prefix + key, r.status || r.error); n++;
    if (VERBOSE) say("   ", r.status || r.error, key);
    if (r.status >= 500) trouble.push(`${r.status} ${key}`);
    if (r.status !== 200 || !/html/.test(r.type)) continue;
    for (const m of r.text.matchAll(/href="(\/(?:admin|consultant)[^"#]*)/g)) {
      const next = m[1].replace(/&amp;/g, "&");
      if (/['+${}<>\s]/.test(next)) continue;      // a link a script assembles, not a link
      if (!visited.has(prefix + next)) queue.push(next);
    }
  }
  return n;
}
// Every GET the server declares under /api that needs no made-up id.
function apiRoutes() {
  const found = new Set();
  for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/\.get\(\s*["'`](\/api\/[^"'`$]+)["'`]/g)) found.add(m[1]);
  }
  return [...found].filter(p => !NO_FOLLOW.test(p)).map(p => p
    .replace(/:(clientKey|client_key|key|ck)\b/g, "a-111222333")
    .replace(/:[A-Za-z_]+\??/g, "1")).sort();
}

// ── 5. The write paths that have broken before ──────────────
async function exercises({ tok, cookie }) {
  const results = [];
  const note = (name, ok, detail) => { results.push({ name, ok, detail }); if (VERBOSE || !ok) say(`    ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  → " + String(detail).slice(0, 200)}`); };
  const send = async (who, method, url, body, kind) => {
    const headers = { cookie: `${cookie}=${tok[who]}` }; let payload = body;
    if (kind === "form") { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body).toString(); }
    else if (kind === "json") { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: "manual" });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, text, json, location: r.headers.get("location") };
  };
  const db = require("../db");

  let r = await send("client", "GET", "/api/client/overview");
  note("a client's My Case loads with its hearing and its deadline", r.status === 200 && r.json && (r.json.upcoming_hearings || []).length === 2 && (r.json.deadlines || []).length === 1, r.text);
  const h0 = r.json && (r.json.upcoming_hearings || [])[0];
  note("…with each hearing as a calendar day and the time printed on the notice",
    !!h0 && /^\d{4}-\d{2}-\d{2}$/.test(h0.hearing_ymd || "") && /T12:00:00$/.test(h0.hearing_date || "") && h0.hearing_time === "8:30 AM", JSON.stringify(h0));

  // Two kinds of document, two tables. What the firm files under a client's
  // Documents tab must never be something the client's app can list or open.
  {
    const firmDocs = require("../client-documents");
    const b64 = Buffer.from("%PDF-1.4 the client's own passport scan").toString("base64");
    r = await send("client", "POST", "/api/client/documents", { filename: "client-passport.pdf", mime_type: "application/pdf", category: "passport", content_base64: b64 }, "json");
    note("a client can upload a document from the app", r.status === 200 && r.json && r.json.document && r.json.document.filename === "client-passport.pdf", r.text);
    let filed = null, filedErr = null;
    try {
      filed = await firmDocs.uploadDocument({ clientKey: "a-111222333", clientName: "Wang, Li", aNumber: "111-222-333",
        filename: "firm-strategy-memo.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 INTERNAL strategy"), category: "work product" });
    } catch (e) { filedErr = e.message; }
    note("the firm can file a document under the same client", !!(filed && filed.id), filedErr);
    r = await send("client", "GET", "/api/client/documents");
    const mine = (r.json && r.json.documents || []).map(d => d.filename);
    note("the client's app lists their upload and not the firm's file", r.status === 200 && mine.includes("client-passport.pdf") && !mine.includes("firm-strategy-memo.pdf"), mine);
    if (filed) {
      r = await send("client", "GET", `/api/documents/${filed.id}`);
      note("the firm's file cannot be opened from the client's app by its id", !/INTERNAL strategy/.test(r.text), r.status);
      const theirs = (await firmDocs.listDocuments("a-111222333", "111-222-333")).map(d => d.filename);
      note("the firm's Documents tab lists the firm's file and not the client's upload", theirs.includes("firm-strategy-memo.pdf") && !theirs.includes("client-passport.pdf"), theirs);
    }
    r = await send("admin", "GET", "/api/staff/clients/a-111222333/documents");
    note("staff see the client's upload in the app", r.status === 200 && (r.json.documents || []).some(d => d.filename === "client-passport.pdf"), r.text);
    r = await send("admin", "GET", "/api/staff/clients/a-111222333/timeline");
    note("…and on the client's timeline", r.status === 200, r.status);
  }

  r = await send("consultant", "GET", "/api/consultant/clients");
  note("a consultant's client list loads", r.status === 200 && r.json && Array.isArray(r.json.clients) && r.json.clients.length >= 1, r.text);
  r = await send("consultant", "GET", "/api/consultant/clients/a-111222333/updates");
  note("a consultant's view of one client loads", r.status === 200, r.text);

  r = await send("consultant", "POST", "/consultant/tasks", { title: "New matter for Chen, Mei", description: "Please open.", matter_type: "immigration", client_name: "Chen, Mei", priority: "normal" }, "form");
  const sent = (await db.query(`SELECT id, status FROM tasks WHERE title = 'New matter for Chen, Mei' ORDER BY id DESC LIMIT 1`)).rows[0];
  note("a consultant can send the firm a task, and it waits for approval", r.status < 400 && sent && sent.status === "pending_approval", `${r.status} ${JSON.stringify(sent)}`);
  if (sent) {
    const fd = new FormData(); fd.append("file", new Blob([Buffer.from("%PDF-1.4 dbcheck")], { type: "application/pdf" }), "passport.pdf");
    r = await send("consultant", "POST", `/api/consultant/tasks/${sent.id}/attachments`, fd);
    note("a document can be attached to it", r.status === 200 && r.json && r.json.ok, r.text);
    r = await send("attorney", "GET", "/admin/consultant-tasks");
    note("the attorney's approval page lists it", r.status === 200 && r.text.includes("New matter for Chen, Mei"), r.status);
    r = await send("attorney", "POST", `/admin/consultant-tasks/${sent.id}/approve`, { assigned_to: "Pat Paralegal" }, "form");
    const after = (await db.query(`SELECT status FROM tasks WHERE id = $1`, [sent.id])).rows[0];
    note("an attorney can approve it", r.status < 400 && after && after.status !== "pending_approval", `${r.status} ${JSON.stringify(after)}`);
    r = await send("consultant", "GET", `/consultant/task/${sent.id}`);
    note("the consultant sees their task afterwards", r.status === 200, r.status);
    r = await send("admin", "GET", `/admin/tasks/${sent.id}`);
    note("the firm's task page shows it", r.status === 200, r.status);
  }
  r = await send("attorney", "POST", "/admin/consultant-tasks/alert", { client_key: "a-111222333", kind: "hearing_scheduled" }, "form");
  note("an attorney can send a case alert by hand", r.status < 500, r.status);
  const form = (url, body) => fetch(BASE + url, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const session = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : []).some(k => k.startsWith(cookie + "=") && k.length > cookie.length + 20);
  r = await form("/admin/login", { username: "dbc.admin", password: "Dbcheck-Pass-1234" });
  note("an account with no phone or email signs in on the password alone", r.status === 302 && session(r), r.status);

  // The sign-in code, start to finish. A development server prints the code
  // to its own log instead of sending it; the live one never does.
  r = await form("/admin/login", { username: "dbc.attorney", password: "Dbcheck-Pass-1234" });
  const page = await r.text();
  const pending = (page.match(/name="pending" value="([^"]+)"/) || [])[1];
  note("an account with a phone is asked for a code after the password, and is not yet signed in",
    r.status === 200 && !!pending && !session(r) && /phone ending 0142/.test(page) && !/6265550142/.test(page), r.status);
  await sleep(300);
  const printed = [...fs.readFileSync(SERVER_LOG, "utf8").matchAll(/sign-in code for user \d+: (\d{6})/g)].map(m => m[1]).pop();
  if (pending && printed) {
    r = await form("/admin/login/code", { pending, code: printed === "000000" ? "111111" : "000000" });
    note("a wrong code does not sign anyone in", r.status === 200 && !session(r), r.status);
    r = await form("/admin/login/code", { pending, code: printed });
    note("the right code does", r.status === 302 && session(r), r.status);
  } else {
    note("the code step could be exercised", false, "no pending token or no code in the server log");
  }
  r = await fetch(BASE + "/api/auth/staff/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "dbc.attorney", password: "Dbcheck-Pass-1234", supports_code: true }) });
  const j = await r.json().catch(() => ({}));
  note("the phone app is asked for a code too, and gets no token until it has one", r.status === 200 && j.needs_code === true && !!j.pending && !j.token, JSON.stringify(j).slice(0, 160));
  return results;
}

// ── Run ─────────────────────────────────────────────────────
// A check that hangs is a deploy that never happens. Give up, loudly.
setTimeout(() => couldNotRun("It was still going after eight minutes and was stopped."), 8 * 60e3).unref();
(async () => {
  say("Database check — the real server, a real Postgres\n");
  try { await emptyDatabase(); } catch (e) { couldNotRun(`Could not open the scratch database (${DB_URL.replace(/:[^:@/]+@/, ":…@")}): ${e.message}`); }

  try {
    say("  starting the server on an empty database (what a first deploy does) …");
    startServer(); await waitReady("starting on an empty database"); await stopServer();
    const firstBoot = readHook().length;
    fs.writeFileSync(HOOK_LOG, "");            // an empty database is not production: reported, not judged
    say(`    ${firstBoot} schema error(s) on the very first start — tables created in an order that only works the second time. Not counted.`);
    say("  starting it again (what every later deploy does) …");
    startServer(); await waitReady("starting the second time");
  } catch (e) { couldNotRun(e.message); }

  let ctx;
  try { ctx = await seed(); } catch (e) { await stopServer(); couldNotRun("Could not seed the scratch database: " + e.message); }

  say("  walking the site …");
  const c = (who) => ({ cookie: `${ctx.cookie}=${ctx.tok[who]}` });
  const pages = await crawl(["/admin/dashboard", "/admin/", "/admin/tasks", "/admin/users", "/admin/consultant-tasks"], "admin ", c("admin"), 320);
  const cons = await crawl(["/consultant", "/consultant/clients", "/consultant/new", "/consultant/alerts"], "consultant ", c("consultant"), 60);
  let apis = 0;
  for (const route of apiRoutes()) {
    const who = route.startsWith("/api/client/") ? "client" : route.startsWith("/api/consultant/") ? "consultant" : "admin";
    const r = await get(route, { bearer: ctx.tok[who] }); visited.set("api " + route, r.status || r.error); apis++;
    if (VERBOSE) say("   ", r.status || r.error, route);
    if (r.status >= 500) trouble.push(`${r.status} ${route}`);
  }
  say(`    ${pages} firm pages, ${cons} consultant pages, ${apis} API routes`);

  say("  exercising the write paths …");
  let ex = [];
  try { ex = await exercises(ctx); } catch (e) { ex = [{ name: "the write paths ran to the end", ok: false, detail: e.message }]; say("    FAIL " + e.message); }
  await sleep(1500);
  await stopServer();
  try { await require("../db").getPool().end(); } catch (_) {}

  // ── Judge ──
  const seen = new Map();
  for (const e of readHook()) {
    const key = `${e.code}|${e.message}|${e.file}`;
    if (!seen.has(key)) seen.set(key, { code: e.code, message: e.message, file: e.file, line: e.line, sql: e.sql, times: 0 });
    seen.get(key).times++;
  }
  let known = [];
  try { known = JSON.parse(fs.readFileSync(KNOWN_FILE, "utf8")).known || []; } catch (_) {}
  const knownKeys = new Set(known.map(k => `${k.code}|${k.message}|${k.file}`));
  const fresh = [...seen.entries()].filter(([k]) => !knownKeys.has(k)).map(([, v]) => v);
  const gone = known.filter(k => !seen.has(`${k.code}|${k.message}|${k.file}`));
  const failedEx = ex.filter(x => !x.ok);

  if (UPDATE) {
    const why = new Map(known.map(k => [`${k.code}|${k.message}|${k.file}`, k.why]));
    const list = [...seen.entries()].map(([k, v]) => ({ code: v.code, message: v.message, file: v.file, sql: v.sql.slice(0, 160), ...(why.get(k) ? { why: why.get(k) } : {}) }))
      .sort((a, b) => (a.file + a.message).localeCompare(b.file + b.message));
    fs.writeFileSync(KNOWN_FILE, JSON.stringify({
      about: "Schema errors that already existed when scripts/dbcheck.js was introduced. The check fails on any error NOT listed here. Fix one, delete its entry, and it can never come back unnoticed. Do not add to this list to make the check pass.",
      known: list,
    }, null, 2) + "\n");
    say(`\n  dbcheck-known.json rewritten: ${list.length} known error(s).`);
  }

  say("\n============================================================");
  say(`${visited.size} requests · ${ex.length - failedEx.length}/${ex.length} write paths · ${seen.size} distinct schema error(s): ${fresh.length} new, ${seen.size - fresh.length} already known`);
  if (trouble.length) { say(`\n${trouble.length} request(s) answered with a server error (reported, not judged — most need a service this machine has no key for):`); for (const t of trouble.slice(0, 25)) say("  · " + t); if (trouble.length > 25) say(`  · … and ${trouble.length - 25} more`); }
  if (gone.length) { say(`\n${gone.length} known error(s) did not happen this time — fixed, or no longer reached. Remove from scripts/dbcheck-known.json:`); for (const g of gone) say(`  · ${g.file}: ${g.message}`); }
  if (fresh.length) {
    say(UPDATE ? `\nRecorded as known from now on:` : `\nNEW SCHEMA ERRORS — the database rejected these queries:`);
    for (const f of fresh) { say(`  ✗ ${f.file}:${f.line}  [${f.code}] ${f.message}  (${f.times}×)`); say(`      ${f.sql.slice(0, 220)}`); }
  }
  if (failedEx.length) { say(`\nWRITE PATHS THAT FAILED:`); for (const x of failedEx) say(`  ✗ ${x.name}  → ${String(x.detail).slice(0, 220)}`); }
  say("============================================================");
  const failed = (fresh.length && !UPDATE) || failedEx.length;
  say(failed ? "FAILED" : "passed");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { await stopServer(); couldNotRun("The check itself broke: " + (e && e.stack || e)); });
