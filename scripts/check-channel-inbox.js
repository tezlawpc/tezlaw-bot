/**
 * check-channel-inbox.js
 *
 * Phase 1 of the unified inbox: Zara's channel conversations become
 * threads Tara can list. The rule that matters most is the negative one:
 * JJ's private-mode conversations must never show up in a staff inbox.
 *
 * db and auth are stubbed; these test the rules, not Postgres.
 *   node scripts/check-channel-inbox.js
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");

let failures = 0;
function ok(name, cond, detail = "") {
  if (!cond) failures++;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || !detail ? "" : `\n         ${detail}`));
}

// ── stubs ────────────────────────────────────────────────
const calls = [];
let jjSessions = new Set();
const fakeDb = {
  async query(sql, params = []) {
    calls.push({ sql, params });
    if (/FROM jj_memory WHERE jj_said = \$1/.test(sql)) {
      return { rows: jjSessions.has(params[0]) ? [{ "?column?": 1 }] : [] };
    }
    if (/SUM\(t\.unread_count\)/.test(sql)) return { rows: [{ n: 3 }] };
    return { rows: [] };
  },
};
const fakeAuth = {
  parseCookies: () => ({}),
  COOKIE_NAME: "tez",
  async verifyToken(t) {
    return { viewer: { uid: 9, r: "viewer" }, para: { uid: 4, r: "paralegal" } }[t] || null;
  },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./db") return fakeDb;
  if (request === "./auth") return fakeAuth;
  return origLoad.apply(this, arguments);
};
const root = path.join(__dirname, "..");
const inbox = require(path.join(root, "channel-inbox.js"));
const { _internal: I } = inbox;

(async () => {
  console.log("Recording threads");

  calls.length = 0;
  await inbox.touchThread("whatsapp", "16265550101", "user");
  const ins = calls.find(c => /INSERT INTO channel_threads/.test(c.sql));
  ok("a client message creates or bumps a thread", !!ins);
  ok("it counts as one unread, inbound", ins && ins.params[2] === 1 && ins.params[3] === true);

  calls.length = 0;
  await inbox.touchThread("whatsapp", "16265550101", "assistant");
  const ins2 = calls.find(c => /INSERT INTO channel_threads/.test(c.sql));
  ok("Zara's reply updates the thread without adding unread", ins2 && ins2.params[2] === 0 && ins2.params[3] === false);

  calls.length = 0;
  jjSessions = new Set(["_session_telegram_777"]);
  await inbox.touchThread("telegram", "777", "user");
  ok("a sender with a JJ session never becomes a thread", !calls.some(c => /INSERT INTO channel_threads/.test(c.sql)));

  calls.length = 0;
  process.env.JJ_TELEGRAM_ID = "555";
  await inbox.touchThread("telegram", "555", "user");
  ok("JJ_TELEGRAM_ID is skipped even without a session", !calls.some(c => /INSERT INTO channel_threads/.test(c.sql)));

  calls.length = 0;
  process.env.INBOX_EXCLUDE = "whatsapp:16260000000, wechat:oABC";
  await inbox.touchThread("wechat", "oABC", "user");
  ok("INBOX_EXCLUDE ids are skipped", !calls.some(c => /INSERT INTO channel_threads/.test(c.sql)));

  calls.length = 0;
  await inbox.touchThread("app", "42", "user");
  ok("platforms outside the inbox (in-app assistant) are skipped", calls.length === 0);

  console.log("Listing");

  calls.length = 0;
  const out = await inbox.listThreads({ filter: "unread" });
  const list = calls.find(c => /FROM channel_threads t/.test(c.sql) && /LATERAL/.test(c.sql));
  ok("the list query filters JJ sessions", list && /_session_' \|\| t\.platform/.test(list.sql));
  ok("the list query applies every exclusion pair", list && /t\.platform = \$3 AND t\.platform_id = \$4/.test(list.sql)
     && /t\.platform = \$7 AND t\.platform_id = \$8/.test(list.sql) && list.params.length === 8);
  const tot = calls.find(c => /SUM\(t\.unread_count\)/.test(c.sql));
  ok("the unread total renumbers its placeholders", tot && /t\.platform = \$2 AND t\.platform_id = \$3/.test(tot.sql) && tot.params.length === 7);
  ok("unread filter narrows to unread threads", list && /t\.unread_count > 0/.test(list.sql));
  ok("total unread comes back", out.total_unread === 3);

  const pt = I.publicThread({ id: 1, platform: "messenger", unread_count: 0, last_message_at: "2026-09-27", last_content: null });
  ok("an unnamed sender shows as '<channel> visitor'", pt.display_name === "Messenger visitor" && pt.channel_label === "Messenger");
  const pt2 = I.publicThread({ id: 2, platform: "website", contact_name: "Li Wei", unread_count: 1, last_content: "x".repeat(300), last_role: "user" });
  ok("a known name is used and the preview is trimmed", pt2.display_name === "Li Wei" && pt2.last_msg.body.length === 140 && pt2.last_msg.sender_kind === "client");

  console.log("Access");
  const routes = {};
  inbox.registerRoutes({ get: (p, ...h) => (routes["GET " + p] = h), post: (p, ...h) => (routes["POST " + p] = h) });
  const run = async (token) => {
    let status = 200, passed = false;
    const req = { get: (h) => (h.toLowerCase() === "authorization" && token ? "Bearer " + token : ""), query: {}, params: {} };
    const res = { status(s) { status = s; return this; }, json() { return this; } };
    await routes["GET /api/staff/threads"][0](req, res, () => { passed = true; });
    return { status, passed };
  };
  const v = await run("viewer");
  ok("a viewer-role account is refused", v.status === 403 && !v.passed);
  const p = await run("para");
  ok("a paralegal gets through", p.passed);
  const n = await run(null);
  ok("no token is refused", n.status === 401);

  console.log("Wiring");
  const ask = fs.readFileSync(path.join(root, "askClaude-memory.js"), "utf8");
  ok("the JJ-mode path saves with { thread: false }",
     /saveMessage\(platform, platformId, "user", inbound, \{ thread: false \}\)/.test(ask) &&
     /saveMessage\(platform, platformId, "assistant", jj\.message, \{ thread: false \}\)/.test(ask));
  const dbSrc = fs.readFileSync(path.join(root, "db.js"), "utf8");
  ok("db.saveMessage hands off to touchThread", /channel-inbox"\)\.touchThread\(platform, platformId, role\)/.test(dbSrc));
  ok("db.saveMessage still inserts only the original columns",
     /INSERT INTO messages \(platform, platform_id, role, content\) VALUES \(\$1, \$2, \$3, \$4\)/.test(dbSrc));
  const srv = fs.readFileSync(path.join(root, "server.js"), "utf8");
  ok("server.js registers the inbox routes", /require\("\.\/channel-inbox"\)/.test(srv) && /channelInbox\.registerRoutes\(app\)/.test(srv));

  console.log(failures ? `\n${failures} CHANNEL INBOX CHECK(S) FAILED` : "\nALL CHANNEL INBOX CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
