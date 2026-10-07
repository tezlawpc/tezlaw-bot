/**
 * e2e.js — ask Zara the questions staff ask, against the REAL server.
 *
 * Why this exists. On October 5, 2026 Zara answered "no hearings this week"
 * on a week with hearings on the calendar. Every check in scripts/ passed:
 * each one tests a piece with the database stubbed. Nothing asked the whole
 * thing a question and read the answer. This does.
 *
 * What it does:
 *   1. empties a scratch database (same rule as dbcheck.js: only one on this
 *      machine whose name ends in _dbcheck; it cannot be pointed at production);
 *   2. boots server.js with scripts/e2e-hook.js, which records Telegram
 *      instead of sending, stands in for the model, and refuses every
 *      connection that is not to this machine;
 *   3. puts a calendar in the database: EOIR notices, a hearing note, an
 *      Outlook and a Google calendar, a civil hearing, deadlines, tasks;
 *   4. asks in the ops group (a Telegram update) and in the Tara app
 *      (/api/staff/chat, signed in as an admin, a manager and two
 *      paralegals), and reads what Zara's look-up was given.
 *
 * It fails (exit 1) when an answer is wrong. If it cannot run at all (no
 * database, the server will not start) it says so and exits 0, so trouble
 * with the test machine never blocks a deploy. --strict makes that a failure.
 *
 *   node scripts/e2e.js            run
 *   node scripts/e2e.js --verbose  print what each look-up returned
 *
 * Database: E2E_DATABASE_URL, default postgres://tez:tez@127.0.0.1:5432/tez_dbcheck
 */
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STRICT = process.argv.includes("--strict");
const VERBOSE = process.argv.includes("--verbose");
const DB_URL = process.env.E2E_DATABASE_URL || process.env.DBCHECK_DATABASE_URL || "postgres://tez:tez@127.0.0.1:5432/tez_dbcheck";
const PORT = Number(process.env.E2E_PORT || 3986);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tez-e2e-"));
const TG_LOG = path.join(TMP, "telegram.log"), MODEL_LOG = path.join(TMP, "model.log"), NET_LOG = path.join(TMP, "net.log"), SERVER_LOG = path.join(TMP, "server.log");
for (const f of [TG_LOG, MODEL_LOG, NET_LOG]) fs.writeFileSync(f, "");

const say = (s) => console.log(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let child = null;
function stopServer() { if (child) { try { child.kill("SIGTERM"); } catch (_) {} setTimeout(() => { try { child && child.kill("SIGKILL"); } catch (_) {} }, 1500).unref(); } }
function couldNotRun(why) {
  stopServer();
  say(`\nZara end to end: DID NOT RUN\n  ${why}\n`);
  if (process.env.GITHUB_ACTIONS) say(`::warning title=Zara end-to-end did not run::${String(why).replace(/\n/g, " ")}`);
  process.exit(STRICT ? 1 : 0);
}

// ── 0. only ever a scratch database on this machine ────────────────────────
let dbHost = "", dbName = "";
try { const u = new URL(DB_URL); dbHost = u.hostname; dbName = u.pathname.replace(/^\//, ""); } catch (_) {}
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(dbHost) || !/_dbcheck$/.test(dbName)) {
  couldNotRun(`Refusing "${dbName}" on ${dbHost}. This empties its database, so it only runs against one on this machine whose name ends in _dbcheck.`);
}
let pg;
try { pg = require("pg"); } catch (_) { couldNotRun("The pg module is not installed (run npm install)."); }

const client = () => new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
async function sql(text) {
  const c = client(); await c.connect();
  try { return await c.query(text); } finally { await c.end(); }
}
const one = async (text) => { const r = await sql(text); const row = r.rows[0]; return row ? Object.values(row)[0] : null; };

// ── 1. the calendar ────────────────────────────────────────────────────────
// Every date is counted from today in the office's time zone, the way the firm counts them.
const PT = "America/Los_Angeles";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const D = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ical = (n, hhmmss, z) => `${D(n).replace(/-/g, "")}T${hhmmss}${z ? "Z" : ""}`;
// Client keys in the form the app uses everywhere: "a-" + the A-number, or "n-" + the name.
const SEED = `
INSERT INTO admin_users (username, password_hash, full_name, role) VALUES ('jj', 'x', 'JJ Zhang', 'admin') ON CONFLICT (username) DO NOTHING;
INSERT INTO admin_users (username, password_hash, full_name, role) VALUES
  ('mliu', 'x', 'Michael Liu', 'paralegal'), ('ops', 'x', 'Olive Park', 'manager'), ('newhire', 'x', 'Nora Vale', 'paralegal'), ('partner1', 'x', 'Outside Partner', 'consultant');
-- EOIR notices, stored the way hearing-notices.js stores them: the printed date and time, no zone.
INSERT INTO client_hearing_notices (client_key, client_name, a_number, dropbox_path, dropbox_hash, hearing_date, hearing_time_text, hearing_type, court_name, judge_name, is_hearing_notice) VALUES
  ('a-a216866111', 'Lu, Guang',     'A216-866-111', '/x/lu.pdf',    'h1', '${D(1)}T09:00:00',  '9:00 AM', 'master',     'Los Angeles Immigration Court', 'Hon. A. Reyes', TRUE),
  ('a-a200000222', 'Ortiz, Maria',  'A200-000-222', '/x/ortiz.pdf', 'h2', '${D(0)}T00:00:00',  NULL,      'individual', 'Santa Ana Immigration Court',   NULL,            TRUE),
  ('a-a200000333', 'Chen, Wei',     'A200-000-333', '/x/chen.pdf',  'h3', '${D(3)}T13:00:00',  '1:00 PM', 'master',     'Los Angeles Immigration Court', NULL,            FALSE),
  ('a-a200000444', 'Faraway, Fay',  'A200-000-444', '/x/far.pdf',   'h4', '${D(30)}T08:30:00', '8:30 AM', 'individual', 'Adelanto Immigration Court',    NULL,            TRUE),
  ('a-a200000555', 'Dismissed, Dan','A200-000-555', '/x/gone.pdf',  'h5', '${D(2)}T09:00:00',  '9:00 AM', 'master',     'Los Angeles Immigration Court', NULL,            TRUE);
UPDATE client_hearing_notices SET dismissed_at = NOW() WHERE client_key = 'a-a200000555';
INSERT INTO hearing_notes (client_name, a_number, next_hearing_date, next_hearing_type) VALUES ('Park, Min', 'A200-000-666', '${D(4)}T13:30:00', 'Individual');
-- Two synced calendars: Outlook publishes local times, Google publishes true instants.
INSERT INTO calendar_feeds (name, ical_url, enabled) VALUES ('JJ Outlook', 'https://example.invalid/a.ics', TRUE), ('Court Google', 'https://example.invalid/b.ics', TRUE), ('Switched off', 'https://example.invalid/c.ics', FALSE);
INSERT INTO outlook_synced_events (ical_uid, feed_id, subject, start_datetime, all_day, location, matched_client_name, matched_a_number, matched_hearing_type, is_hearing_related, raw_ical)
SELECT v.uid, f.id, v.subject, v.start::timestamptz, FALSE, v.loc, v.client, v.anum, v.htype, v.rel, v.raw
FROM (VALUES
  ('u1', 'JJ Outlook',   'MCH - Zhou Lin',            '${D(2)}T10:30:00',  'LA Immigration Court, Courtroom 5', 'Zhou, Lin',   'A200-000-777', 'master',     TRUE,  E'SUMMARY:MCH - Zhou Lin\\nDTSTART;TZID=Pacific Standard Time:${ical(2, "103000")}'),
  ('u2', 'Court Google', 'Individual hearing - Tran', '${D(5)}T16:00:00Z', 'Santa Ana',                         'Tran, Bao',   NULL,           'individual', TRUE,  E'SUMMARY:Individual hearing - Tran\\nDTSTART:${ical(5, "160000", true)}'),
  ('u3', 'JJ Outlook',   'MCH Lu Guang',              '${D(1)}T09:00:00',  'LA Immigration Court',              'Lu, Guang',   'A216-866-111', 'master',     TRUE,  E'DTSTART;TZID=Pacific Standard Time:${ical(1, "090000")}'),
  ('u4', 'JJ Outlook',   'Dentist',                   '${D(2)}T15:00:00',  NULL,                                NULL,          NULL,           NULL,         FALSE, E'DTSTART;TZID=Pacific Standard Time:${ical(2, "150000")}'),
  ('u5', 'Switched off', 'Hearing - Hidden',          '${D(2)}T11:00:00',  NULL,                                'Hidden, Hal', NULL,           'master',     TRUE,  E'DTSTART;TZID=Pacific Standard Time:${ical(2, "110000")}')
) AS v(uid, feed, subject, start, loc, client, anum, htype, rel, raw) JOIN calendar_feeds f ON f.name = v.feed;
INSERT INTO deadlines (source_type, client_name, a_number, due_date, description, status, priority) VALUES
  ('manual', 'Lu, Guang', 'A216-866-111', '${D(-10)}', 'File change of venue motion', 'pending',   'high'),
  ('manual', 'Park, Min', 'A200-000-666', '${D(6)}',   'Submit I-589 supplement',     'pending',   'normal'),
  ('manual', 'Park, Min', 'A200-000-666', '${D(20)}',  'Pre-hearing brief',           'pending',   'normal'),
  ('manual', 'Park, Min', 'A200-000-666', '${D(2)}',   'Already done',                'completed', 'normal');
-- Michael works on Lu (a task assigned to him). Nobody has assigned Nora anything.
INSERT INTO tasks (title, client_key, client_name, a_number, matter_type, description, due_date, status, assigned_to) VALUES
  ('Prepare Lu master hearing', 'a-a216866111', 'Lu, Guang',   'A216-866-111', 'Removal',        'pleadings',          '${D(1)}', 'open',      'Michael Liu'),
  ('USCIS interview',           'n-nguyen-thi', 'Nguyen, Thi', NULL,           'Naturalization', 'LA field office',    '${D(3)}', 'open',      'JJ Zhang'),
  ('Court hearing prep',        'n-done-dee',   'Done, Dee',   NULL,           'Removal',        NULL,                 '${D(3)}', 'completed', 'JJ Zhang'),
  ('Order business cards',      NULL,           NULL,          NULL,           NULL,             'for the front desk', '${D(3)}', 'open',      'JJ Zhang'),
  ('Renew the notary bond',     NULL,           NULL,          NULL,           NULL,             'due today',          '${D(0)}', 'open',      'JJ Zhang');`;
const SEED_CIVIL = `
WITH c AS (INSERT INTO civil_cases (client_key, case_name, court, case_number, status) VALUES ('n-cedar-llc', 'Cedar v. Dunmore', 'LASC Stanley Mosk', '25STCV01234', 'active') RETURNING id)
INSERT INTO civil_hearings (case_id, hearing_date, hearing_time, hearing_type, department, judge, status)
SELECT c.id, v.d::date, '8:30 AM', v.ty, '12', 'Hon. B. Okafor', v.st FROM c, (VALUES ('${D(1)}', 'case_management_conference', 'scheduled'), ('${D(2)}', 'motion', 'vacated')) AS v(d, ty, st);`;

// ── 2. the server ──────────────────────────────────────────────────────────
function startServer() {
  const out = fs.openSync(SERVER_LOG, "a");
  // A clean environment: no keys, no tokens. With the hook, nothing it does can leave this machine.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME || os.homedir(), TZ: process.env.TZ || "UTC",
    NODE_ENV: "development", PORT: String(PORT), DATABASE_URL: DB_URL, PUBLIC_BASE_URL: BASE,
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "e2e-hook.js"))}`,
    E2E_TG_LOG: TG_LOG, E2E_MODEL_LOG: MODEL_LOG, E2E_NET_LOG: NET_LOG,
    TELEGRAM_TOKEN: "1:fake", TELEGRAM_BOT_USERNAME: "TEZJJBot", JJ_TELEGRAM_ID: "555", ANTHROPIC_API_KEY: "fake", ZARA_PROVIDER_ORDER: "anthropic",
    TG_OPS_CHAT_ID: "-1009", TG_TOPIC_COURT: "11", TG_TOPIC_OPS: "14",
  };
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", out, out] });
  child.on("exit", () => { child = null; });
}
const lines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
const telegram = () => lines(TG_LOG), models = () => lines(MODEL_LOG);
async function until(fn, ms, step = 250) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}
// The look-up's own result, as the stand-in model received it.
function toolResult(fromModelIndex) {
  let tool = null;
  for (const m of models().slice(fromModelIndex)) for (const x of m.messages || []) if (Array.isArray(x.content)) for (const b of x.content) {
    if (b.type === "tool_result") { try { tool = JSON.parse(typeof b.content === "string" ? b.content : JSON.stringify(b.content)); } catch (_) { tool = { raw: String(b.content) }; } }
  }
  return tool;
}

let updateId = 1;
async function askGroup(text, from = 555, thread = 11) {
  const tg0 = telegram().length, m0 = models().length;
  const r = await fetch(BASE + "/telegram", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ update_id: updateId++, message: { message_id: 100 + updateId, date: 1, chat: { id: -1009, type: "supergroup", title: "Tez Law Ops" },
      from: { id: from, first_name: from === 555 ? "JJ" : "Mike" }, text, message_thread_id: thread, is_topic_message: true } }) });
  if (r.status !== 200) throw new Error("the Telegram webhook answered " + r.status);
  const sent = await until(() => { const s = telegram().slice(tg0).filter(x => x.call === "sendMessage"); return s.length ? s : null; }, 30000);
  await sleep(300);
  return { sent: sent || [], tool: toolResult(m0) || {}, tools: (models().slice(m0)[0] || {}).tools || [], system: (models().slice(m0)[0] || {}).system, calls: telegram().slice(tg0) };
}
let secret = null;
async function token(username) {
  const row = (await sql(`SELECT id, full_name, role FROM admin_users WHERE username = '${username}'`)).rows[0];
  const data = Buffer.from(JSON.stringify({ uid: Number(row.id), u: username, n: row.full_name, r: row.role, exp: Date.now() + 3600e3 })).toString("base64url");
  return `${data}.${crypto.createHmac("sha256", secret).update(data).digest("base64url")}`;
}
async function askApp(username, message) {
  const m0 = models().length;
  const r = await fetch(BASE + "/api/staff/chat", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + await token(username) }, body: JSON.stringify({ message, history: [] }) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body, tool: toolResult(m0) || {}, tools: (models().slice(m0)[0] || {}).tools || [] };
}
// What a person's Calendar screen shows, from the app's own endpoint: the yardstick.
async function screen(username) {
  const r = await fetch(BASE + "/api/staff/calendar?days=7", { headers: { authorization: "Bearer " + await token(username) } });
  const j = await r.json();
  return { hearings: (j.hearings || []).map(h => h.client_name).sort(), deadlines: (j.deadlines || []).map(d => d.client_name).sort() };
}

// ── 3. the questions ───────────────────────────────────────────────────────
const results = [];
let asking = false;
function check(name, ok, detail) {
  results.push(!!ok);
  say(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n        " + String(detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1200)}`);
}
const names = (t) => (t.hearings || []).map(h => h.client).sort();
const J = JSON.stringify;

(async () => {
  // the database
  try {
    await sql("DROP SCHEMA IF EXISTS public CASCADE");
    await sql("CREATE SCHEMA public");
  } catch (e) { couldNotRun(`The scratch database is not reachable over SSL (${e.message}).`); }

  startServer();
  const up = await until(async () => { try { const r = await fetch(BASE + "/version"); return r.status === 200; } catch (_) { return false; } }, 120000, 500);
  if (!up) couldNotRun(`The server did not start. Last lines of its log:\n  ${fs.readFileSync(SERVER_LOG, "utf8").split("\n").slice(-8).join("\n  ")}`);
  // It creates its tables after it starts listening; wait for the ones the seed needs.
  const NEED = ["admin_users", "client_hearing_notices", "hearing_notes", "calendar_feeds", "outlook_synced_events", "deadlines", "tasks", "civil_cases", "session_settings"];
  const ready = await until(async () => {
    const r = await sql(`SELECT ${NEED.map(t => `to_regclass('public.${t}') IS NOT NULL AS ${t}`).join(", ")}`);
    return Object.values(r.rows[0]).every(Boolean);
  }, 120000, 1000);
  if (!ready) couldNotRun("The server started but did not create its tables in two minutes.");
  await sleep(3000);

  try {
    await sql(SEED);
  } catch (e) { couldNotRun(`The test calendar could not be put in the database (${e.message}). A table changed shape; update the seed in scripts/e2e.js.`); }
  secret = await one("SELECT secret FROM session_settings WHERE id = 1");
  if (!secret) { await fetch(BASE + "/api/staff/calendar", { headers: { authorization: "Bearer x.y" } }).catch(() => {}); secret = await one("SELECT secret FROM session_settings WHERE id = 1"); }
  if (!secret) couldNotRun("The server did not create its sign-in secret.");

  asking = true;
  say("\nZara, end to end\n");
  say("── In the ops group ───────────────────────────");
  let r = await askGroup("can someone call the clerk back about the Lu hearing?", 777);
  check("staff talking to each other get no reply, and the model is not called", r.sent.length === 0 && !r.tools.length, r.sent);
  r = await askGroup("@TEZJJBot any hearings this week?", 777);
  check("someone JJ has not linked is told so, and gets nothing from the calendar", r.sent.length === 1 && /linked to your staff login/.test(r.sent[0].text) && !r.tool.hearings, r.sent);

  const hadCivil = await one("SELECT to_regclass('public.civil_hearings') IS NOT NULL");
  r = await askGroup("@TEZJJBot any hearings this week? first");
  check("before the civil hearings table has ever been created, that is an empty list, not an unreadable calendar", hadCivil === false && !r.tool.could_not_read && (r.tool.hearings || []).some(h => h.client === "Lu, Guang"), { hadCivil, tool: r.tool });

  // The civil module creates its table on first use; do that, then add a civil hearing.
  process.env.DATABASE_URL = DB_URL;
  try { await require(path.join(ROOT, "civil-hearings.js")).initTables(); await sql(SEED_CIVIL); }
  catch (e) { couldNotRun(`The civil hearing could not be added (${e.message}).`); }

  r = await askGroup("@TEZJJBot any hearings this week?");
  let t = r.tool, hs = t.hearings || [], who = hs.map(h => h.client);
  if (VERBOSE) say("      " + hs.map(h => `${h.day} ${h.time || "(no time)"} ${h.client} [${h.on_calendar_as}]`).join("\n      "));
  check("JJ asks: the calendar look-up is offered and is the one run", r.tools.includes("court_calendar") && Array.isArray(t.hearings) && !r.tools.includes("list_upcoming_hearings"), r.tools);
  check("the group's look-ups still include nothing that writes, no trust money, no hours", !r.tools.some(n => /^propose_|trust|insight|time/.test(n)), r.tools);
  check("she is told the calendar and the Matter Manager are separate lists", /run court_calendar AND matter_deadlines/.test(typeof r.system === "string" ? r.system : J(r.system)), "");
  check("a hearing from an EOIR notice: the right day, the time printed on the notice, the court and judge", hs.some(h => h.client === "Lu, Guang" && h.day === D(1) && h.time === "9:00 AM" && /Los Angeles Immigration Court/.test(h.court) && h.judge === "Hon. A. Reyes"), hs);
  check("…listed once, though it is also on the synced Outlook calendar", who.filter(w => w === "Lu, Guang").length === 1 && /EOIR notice/.test((hs.find(h => h.client === "Lu, Guang") || {}).on_calendar_as) && /JJ Outlook/.test((hs.find(h => h.client === "Lu, Guang") || {}).on_calendar_as), hs.filter(h => h.client === "Lu, Guang"));
  check("a hearing TODAY with no time on the notice is listed today, with no invented time", hs.some(h => h.client === "Ortiz, Maria" && h.day === D(0) && h.time === null), hs.filter(h => /Ortiz/.test(h.client)));
  check("a notice the Tara app lists but the Calendar page leaves out is still reported", hs.some(h => h.client === "Chen, Wei" && h.day === D(3) && h.time === "1:00 PM" && h.on_calendar_as === "notice on file"), hs.filter(h => /Chen/.test(h.client)));
  check("a next hearing from a hearing note, with its time as typed", hs.some(h => h.client === "Park, Min" && h.day === D(4) && h.time === "1:30 PM" && /hearing note/.test(h.on_calendar_as)), hs.filter(h => /Park/.test(h.client)));
  check("an Outlook entry keeps the local time it was typed with", hs.some(h => h.client === "Zhou, Lin" && h.day === D(2) && h.time === "10:30 AM" && /Courtroom 5/.test(h.court)), hs.filter(h => /Zhou/.test(h.client)));
  check("a Google entry published as a UTC instant reads in Pacific time, not seven hours late", hs.some(h => h.client === "Tran, Bao" && h.day === D(5) && /^(9|8):00 AM$/.test(h.time)), hs.filter(h => /Tran/.test(h.client)));
  check("a civil hearing with its department and case number; a vacated one is not listed", hs.some(h => h.client === "Cedar v. Dunmore" && h.day === D(1) && h.time === "8:30 AM" && /Dept\. 12/.test(h.court) && /25STCV01234/.test(h.entry)) && who.filter(w => w === "Cedar v. Dunmore").length === 1, hs.filter(h => /Cedar/.test(h.client)));
  check("not listed: a dismissed notice, a switched-off calendar, a personal entry, next month's hearing", !who.some(w => /Dismissed|Hidden|Faraway/.test(w)) && !J(hs).includes("Dentist"), who);
  check("in date order, earliest first within a day", J(hs.map(h => h.day)) === J(hs.map(h => h.day).slice().sort()) && hs.findIndex(h => h.client === "Cedar v. Dunmore") < hs.findIndex(h => h.client === "Lu, Guang"), hs.map(h => [h.day, h.time, h.client]));
  const ds = t.deadlines || [];
  check("open deadlines: the overdue one flagged, this week's one, not the later or completed ones", ds.length === 2 && ds[0].overdue === true && /change of venue/.test(ds[0].what) && ds[0].priority === "high" && /I-589 supplement/.test(ds[1].what) && ds[1].overdue === false, ds);
  check("hearings that exist only as a task are reported as tasks, found by title; a completed one is not", (t.hearing_tasks || []).length === 2 && t.hearing_tasks.some(x => /USCIS interview/.test(x.what)) && !J(t.hearing_tasks).includes("business cards") && !who.includes("Nguyen, Thi"), t.hearing_tasks);
  check("nothing was marked unreadable", !t.could_not_read && !t.warning, t.could_not_read);
  const reply = r.sent[0] || {};
  check("her answer goes back to the same topic, as a reply to the question", r.sent.length >= 1 && reply.chat_id == "-1009" && reply.message_thread_id === 11 && reply.reply_parameters && reply.reply_parameters.message_id > 0, r.sent);
  check("…with a Social Security number taken out and the Markdown gone", /\[SSN withheld\]/.test(reply.text || "") && !/123-45-6789/.test(reply.text || "") && !/\*\*/.test(reply.text || ""), reply.text);

  r = await askGroup("/ask what is on the calendar for the next sixty days", 555, 14);
  check("a longer window reaches next month's hearing and the later deadline", (r.tool.hearings || []).some(h => h.client === "Faraway, Fay" && h.day === D(30) && h.time === "8:30 AM") && (r.tool.deadlines || []).some(d => /Pre-hearing brief/.test(d.what)) && r.tool.days === 60, r.tool);
  r = await askGroup("@TEZJJBot what is coming up for Lu", 555, 14);
  check("one client by name: only that client's hearing and deadline", (r.tool.hearings || []).length === 1 && r.tool.hearings[0].client === "Lu, Guang" && (r.tool.deadlines || []).length === 1 && r.tool.client_filter === "Lu", r.tool);
  r = await askGroup("@TEZJJBot how much is in trust for Lu?", 555, 14);
  check("a trust balance asked for in the group is refused in code", /not available in the group chat/.test((r.sent[0] || {}).text || "") && !/balance/i.test(J(r.tool).replace(/not available[^"]*/, "")), r.sent);
  r = await askGroup("@TEZJJBot update the Lu file with a new deadline", 555, 14);
  check("a change asked for in the group is refused in code", /not available in the group chat/.test((r.sent[0] || {}).text || ""), r.sent);

  await sql("ALTER TABLE civil_hearings RENAME COLUMN hearing_time TO hearing_time_x");
  r = await askGroup("@TEZJJBot any hearings this week? again");
  check("if one source cannot be read she is told the answer may be incomplete, and still gets the rest", Array.isArray(r.tool.could_not_read) && r.tool.could_not_read.includes("civil hearings") && /incomplete/.test(r.tool.warning) && (r.tool.hearings || []).some(h => h.client === "Lu, Guang"), r.tool);
  await sql("ALTER TABLE civil_hearings RENAME COLUMN hearing_time_x TO hearing_time");

  say("\n── In the Tara app ────────────────────────────");
  r = await askApp("jj", "any hearings this week?");
  check("the app chat answers and ran the hearing look-up", r.status === 200 && r.body.ok === true && Array.isArray(r.tool.hearings), r.body);
  check("JJ (admin) gets the whole calendar, the same seven hearings as the group", J(names(r.tool)) === J(["Cedar v. Dunmore", "Chen, Wei", "Lu, Guang", "Ortiz, Maria", "Park, Min", "Tran, Bao", "Zhou, Lin"]) && !r.tool.limited_to_own_clients, names(r.tool));
  check("the app still has its own tools (nothing else about the chat changed)", r.tools.includes("list_upcoming_hearings") && r.tools.includes("propose_matter_update"), r.tools);
  // The screens themselves. These two fail from 5 PM Pacific to midnight if "today" is taken from UTC.
  const jjScreen = await screen("jj");
  check("the Calendar screen lists today's hearing at any hour of the office's day", jjScreen.hearings.includes("Ortiz, Maria"), jjScreen.hearings);
  const home = await (await fetch(BASE + "/api/staff/dashboard", { headers: { authorization: "Bearer " + await token("jj") } })).json();
  check("the Home screen counts a task due today as due today, not overdue, and shows today's hearing", home.ok === true && home.stats.due_today === 1 && home.stats.overdue === 0 && (home.upcoming_hearings || []).some(h => h.client_name === "Ortiz, Maria"), home.stats);
  r = await askApp("ops", "any hearings this week?");
  check("a manager gets the whole calendar too", names(r.tool).length === 7 && !r.tool.limited_to_own_clients, names(r.tool));
  r = await askApp("mliu", "any hearings this week?");
  const scr = await screen("mliu");
  check("a paralegal gets only his own client's hearing", J(names(r.tool)) === J(["Lu, Guang"]) && r.tool.limited_to_own_clients === true, r.tool);
  check("…exactly the hearings his Calendar screen shows", J(names(r.tool)) === J(scr.hearings), [names(r.tool), scr.hearings]);
  check("…and exactly the deadlines his Calendar screen shows", J((r.tool.deadlines || []).map(d => d.client).sort()) === J(scr.deadlines) && scr.deadlines.length === 1, [r.tool.deadlines, scr.deadlines]);
  check("…his own hearing task, and not the one on another client", (r.tool.hearing_tasks || []).length === 1 && /Prepare Lu/.test(r.tool.hearing_tasks[0].what), r.tool.hearing_tasks);
  check("…nothing of another client's anywhere in what she was given", !/Ortiz|Park, Min|Cedar|Chen|Zhou|Tran|Nguyen/.test(J({ h: r.tool.hearings, d: r.tool.deadlines, t: r.tool.hearing_tasks })), r.tool);
  r = await askApp("newhire", "any hearings this week?");
  check("a paralegal with no clients assigned sees nothing from the calendar, not everyone's", r.status === 200 && names(r.tool).length === 0 && (r.tool.deadlines || []).length === 0 && (r.tool.hearing_tasks || []).length === 0 && r.tool.limited_to_own_clients === true, r.tool);
  const bad = await fetch(BASE + "/api/staff/chat", { method: "POST", headers: { "content-type": "application/json" }, body: J({ message: "any hearings this week?" }) });
  check("without a sign-in the chat is refused", bad.status === 401, bad.status);
  const cons = await fetch(BASE + "/api/staff/chat", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + await token("partner1") }, body: J({ message: "any hearings this week?" }) });
  check("a consultant login is refused by the staff chat", cons.status === 403, cons.status);

  say("\n── On the record, and nothing left the machine ─");
  const log = (await sql("SELECT outcome, COALESCE(tools, '') AS tools FROM staff_ask_log ORDER BY id")).rows;
  check("every question in the group is logged with who was answered and which look-up ran", log.length >= 8 && log[0].outcome.startsWith("not linked") && log.filter(l => /court_calendar/.test(l.tools)).length >= 5, log);
  const blocked = lines(NET_LOG).map(x => x.blocked);
  check("Telegram was recorded, not sent; no connection left this machine", telegram().length > 0, "");
  if (VERBOSE && blocked.length) say("      refused connections: " + [...new Set(blocked)].join(", "));

  stopServer();
  const passed = results.filter(Boolean).length;
  say(`\n${passed} of ${results.length} passed\n`);
  if (passed !== results.length) {
    const tail = fs.readFileSync(SERVER_LOG, "utf8").split("\n").filter(l => /tg-ask|court-calendar|api chat staff|Unhandled|ReferenceError|TypeError|SyntaxError/i.test(l)).slice(-8).join("\n  ");
    if (tail) say("server log:\n  " + tail + "\n");
  }
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  const what = e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e);
  // Trouble before the first question is the test machine's; after it, it is a result.
  if (!asking) couldNotRun(`The test stopped while setting up: ${what}`);
  stopServer();
  say(`\n  FAIL the run stopped part-way: ${what}\n`);
  process.exit(1);
});
