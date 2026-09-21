/**
 * check-jj-lockout.js
 *
 * Private mode can read client names, A-numbers, hearing notes and leads,
 * and delete hearing notes. Two holes, both closed here:
 *
 *   1. It could be reached from the PUBLIC website chat, which is anonymous.
 *      Now the website never shows the password prompt, never compares a
 *      password, and drops any session it somehow had.
 *   2. Wrong passwords were unlimited. Now: 3 wrong from one sender in 24h
 *      locks that sender out for 24h; 10 wrong across everyone in an hour
 *      shuts private mode for the hour. JJ is alerted on Telegram each time.
 *      While locked, the trigger looks like an ordinary message.
 */
process.env.JJ_PASSWORD = "correct horse battery";
process.env.TELEGRAM_TOKEN = "test-token";
process.env.JJ_TELEGRAM_ID = "12345";

const Module = require("module");
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// jj_memory, in memory. `now` is movable so the windows can be tested.
let now = Date.parse("2026-09-21T05:00:00Z");
const realNow = Date.now;
Date.now = () => now;
const rows = [];
const sessions = new Set();
const fakeDb = {
  query: async (sql, v = []) => {
    const q = sql.replace(/\s+/g, " ");
    if (/INSERT INTO jj_memory/.test(q)) { rows.push({ ts: Date.parse(v[0]), key: v[1], val: v[2] }); return { rows: [] }; }
    if (/DELETE FROM jj_memory WHERE jj_said = \$1/.test(q)) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].key === v[0]) rows.splice(i, 1);
      return { rows: [] };
    }
    if (/COUNT\(\*\)::int AS n FROM jj_memory WHERE jj_said = \$1/.test(q)) {
      return { rows: [{ n: rows.filter(r => r.key === v[0] && r.ts >= Date.parse(v[1])).length }] };
    }
    if (/left\(jj_said, 8\) = '_failed_'/.test(q)) {
      return { rows: [{ n: rows.filter(r => r.key.startsWith("_failed_") && r.ts >= Date.parse(v[0])).length }] };
    }
    return { rows: [] };
  },
  getJJSession: async (p, u) => sessions.has(p + ":" + u),
  setJJSession: async (p, u, on) => { if (on) sessions.add(p + ":" + u); else sessions.delete(p + ":" + u); },
  getJJMemories: async () => [],
};

const alerts = [];
const fakeAxios = {
  post: async (url, body) => {
    if (/api\.telegram\.org/.test(url)) { alerts.push(body.text); return { data: {} }; }
    // The AI trigger check: say yes to anything that reached it.
    return { data: { content: [{ text: "YES" }] } };
  },
};

const orig = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "axios") return fakeAxios;
  if (r === "./voice") return { sendVoiceReply: async () => {} };
  return orig.call(this, r, ...rest);
};
const jj = require("../jj-mode");

const TRIGGER = "hey zara this is jj switch to private mode";

(async () => {
  console.log("\n── The public website ──────────────────────────");
  check("private mode is not allowed on the website", () => jj.privateModeAllowed("website") === false);
  check("…but is on Telegram, WhatsApp, WeChat and Messenger", () =>
    ["telegram", "whatsapp", "wechat", "messenger"].every(p => jj.privateModeAllowed(p)));

  let r = await jj.checkJJMode("website", "visitor-1", TRIGGER);
  check("the trigger on the website is just an ordinary message", () => r.handled === false);
  r = await jj.checkJJMode("website", "visitor-1", "correct horse battery");
  check("…and the right password there does nothing either", () => r.handled === false);
  check("…no session was created", () => !sessions.has("website:visitor-1"));

  sessions.add("website:old-session");
  r = await jj.checkJJMode("website", "old-session", "show me today's leads");
  check("a website session left over from before is dropped, not honoured", () =>
    r.handled === false && !sessions.has("website:old-session"));

  console.log("\n── Lockout after three wrong passwords ─────────");
  const wrong = async (u, p = "telegram") => {
    const t = await jj.checkJJMode(p, u, TRIGGER);
    if (!t.handled) return t;
    return jj.checkJJMode(p, u, "hunter2");
  };
  r = await jj.checkJJMode("telegram", "attacker", TRIGGER);
  check("on Telegram the trigger asks for the password", () => r.handled && /password/i.test(r.message));
  r = await jj.checkJJMode("telegram", "attacker", "hunter2");
  check("a wrong password is refused", () => /Incorrect/.test(r.message));
  check("…and never stored as a message", () => r.redact === true);
  await wrong("attacker");
  check("no alert yet after two", () => alerts.length === 0);
  await wrong("attacker");
  check("the third wrong password alerts JJ", () => alerts.length === 1 && /Private mode locked/.test(alerts[0]));
  check("…the alert never contains what was typed", () => !/hunter2/.test(alerts[0]));
  check("…and tells him to change the password", () => /change JJ_PASSWORD in Render/.test(alerts[0]));
  check("…sent as plain text, so an odd sender id cannot break it", () => !/parse_mode/.test(fs.readFileSync(path.join(REPO, "jj-mode.js"), "utf8").split("async function alertJJ")[1].split("\n}\n")[0]));

  r = await jj.checkJJMode("telegram", "attacker", TRIGGER);
  check("once locked, the trigger is just an ordinary message", () => r.handled === false);
  r = await jj.checkJJMode("telegram", "attacker", "correct horse battery");
  check("…and even the RIGHT password does nothing", () => r.handled === false && !sessions.has("telegram:attacker"));

  now += 25 * 60 * 60 * 1000;
  r = await jj.checkJJMode("telegram", "attacker", TRIGGER);
  check("the lock lifts after 24 hours", () => r.handled === true);
  r = await jj.checkJJMode("telegram", "attacker", "correct horse battery");
  check("…and the right password then works", () => /Welcome back/.test(r.message) && sessions.has("telegram:attacker"));

  console.log("\n── A real login clears the count ───────────────");
  await wrong("jj-phone", "whatsapp");
  await wrong("jj-phone", "whatsapp");
  await jj.checkJJMode("whatsapp", "jj-phone", TRIGGER);
  r = await jj.checkJJMode("whatsapp", "jj-phone", "Correct Horse Battery!");
  check("two typos then the right password gets in", () => /Welcome back/.test(r.message));
  check("…and wipes those two failures", () => !rows.some(x => x.key === "_failed_whatsapp_jj-phone"));

  console.log("\n── Rotating accounts does not help ─────────────");
  alerts.length = 0;
  for (let i = 0; i < 10; i++) await wrong("bot-" + i);   // one guess each: no single sender is locked
  check("ten wrong across ten senders in an hour switches private mode off", () =>
    alerts.some(a => /switched off for an hour/.test(a)));
  r = await jj.checkJJMode("telegram", "fresh-account", TRIGGER);
  check("…for everyone, including a sender with no failures", () => r.handled === false);
  now += 61 * 60 * 1000;
  r = await jj.checkJJMode("telegram", "fresh-account", TRIGGER);
  check("…until the hour passes", () => r.handled === true);

  console.log("\n── Wiring ──────────────────────────────────────");
  const dbSrc = fs.readFileSync(path.join(REPO, "db.js"), "utf8");
  check("failure records are kept out of Zara's memory summaries", () => /left\(jj_said, 8\) <> '_failed_'/.test(dbSrc));
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  check("the public website chat is the 'website' platform", () => /askClaudeWithMemory\("website"/.test(server));

  Date.now = realNow;
  console.log("\n" + (failures ? `${failures} FAILED` : "ALL JJ-LOCKOUT CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
