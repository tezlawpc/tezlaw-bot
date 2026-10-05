// check-lead-sources.js — "How did you hear about us?", end to end without a database.
//
// The question is asked in two places, the website form and the close of
// Zara's chat intake, and counted on one page. Three things would make the
// numbers worthless, and each is checked here:
//
//   1. an answer is lost: the form sends it and nothing stores it, or the
//      page that counts it is not mounted or not linked;
//   2. an answer is invented: a person asks Zara a new question after the
//      intake and it is filed as "how they heard about us";
//   3. the question costs the firm something: an intake is refused over it,
//      or an urgent caller is asked a marketing question.
//
// Runs with no installed packages: the database, Telegram and mail are
// stand-ins, so it can run on the laptop as well as in CI.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");

// ── Stand-ins ────────────────────────────────────────────────
const captured = [];          // rows written to lead_sources
let session = null;           // the one chat session the fake database holds
const fakeDb = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^CREATE (TABLE|INDEX)/i.test(s)) return { rows: [] };
    if (/INSERT INTO lead_sources/.test(s)) {
      captured.push({ platform: params[0], platformId: params[1], channel: params[2], area: params[3], key: params[4], text: params[5] });
      return { rows: [] };
    }
    if (/^SELECT state FROM intake_agent_sessions/.test(s)) return { rows: session && session.state !== "completed" ? [{ state: session.state }] : [] };
    if (/^SELECT \* FROM intake_agent_sessions/.test(s)) return { rows: session ? [session] : [] };
    if (/^INSERT INTO intake_agent_sessions/.test(s)) {
      session = { id: 1, platform: params[0], platform_id: params[1], state: "greeting", language: "en", collected: {}, transcript: [] };
      return { rows: [session] };
    }
    if (/^UPDATE intake_agent_sessions SET transcript = \$1::jsonb/.test(s)) { session.transcript = JSON.parse(params[0]); return { rows: [] }; }
    const m = s.match(/^UPDATE intake_agent_sessions SET (.*) WHERE id = \$\d+$/);
    if (m) {
      for (const part of m[1].split(", ")) {
        const a = part.match(/^(\w+) = \$(\d+)(::jsonb)?$/);
        if (a) session[a[1]] = a[3] ? JSON.parse(params[a[2] - 1]) : params[a[2] - 1];
      }
      return { rows: [] };
    }
    if (/^INSERT INTO intake_agent_records/.test(s)) return { rows: [{ id: 7 }] };
    if (/^UPDATE intake_agent_records/.test(s)) return { rows: [] };
    if (/to_regclass/.test(s)) return { rows: [{ intakes: false, agent: false }] };
    if (/FROM lead_sources/.test(s)) return { rows: fakeDb.reportRows(s) };
    throw new Error("check-lead-sources: unexpected query: " + s.slice(0, 90));
  },
  reportRows() { return []; },
};
const sentToTeam = [];
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "./db") return fakeDb;
  if (request === "axios") return { post: async () => ({ data: {} }), get: async () => ({ data: {} }) };
  if (request === "nodemailer") return { createTransport: () => ({ sendMail: async () => ({}) }) };
  if (request === "./tg-route") return { send: async (route, text) => { sentToTeam.push(text); return true; } };
  return origLoad.call(this, request, ...rest);
};

const ls = require(path.join(ROOT, "lead-sources.js"));
const wi = require(path.join(ROOT, "web-intake.js"));
const agent = require(path.join(ROOT, "intake-agent.js"));

let passed = 0;
const queue = [];
function check(name, fn) { queue.push([name, fn]); }

console.log("\nlead sources\n");

// ── 1. Nothing is lost ───────────────────────────────────────
check("server.js mounts the report page", () => {
  const mounted = read("server.js").split("\n").filter(l => !l.trim().startsWith("//"))
    .some(l => /require\(\s*["']\.\/lead-sources["']\s*\)\s*\.mount\(\s*app\s*\)/.test(l));
  assert.ok(mounted, 'server.js does not mount lead-sources. Add require("./lead-sources").mount(app); after the web-intake mount.');
});

check("the sidebar links to it, for people who can see the pipeline", () => {
  const nav = read("hearing-notes.js");
  assert.ok(/<a href="\/admin\/lead-sources" class="nav-link" data-perm="matters\.access">/.test(nav),
    "hearing-notes.js has no sidebar link to /admin/lead-sources; the page exists but nobody can find it.");
});

check("the page is behind the same permission as the pipeline", () => {
  assert.ok(/requirePermission\(\s*"matters\.access"\s*\)/.test(read("lead-sources.js")));
});

check("the website form's answer reaches storage", async () => {
  const handlers = {};
  const app = { get: (p, ...h) => { handlers["GET " + p] = h; }, post: (p, ...h) => { handlers["POST " + p] = h; }, options: () => {} };
  const recorded = [];
  wi.mount(app, {
    db: { getOrCreateClient: async () => {}, updateClient: async () => {}, saveMessage: async () => {}, saveIntake: async () => {}, createLead: async () => null },
    nodemailer: { createTransport: () => ({ sendMail: async () => ({}) }) },
    leadSources: Object.assign({}, ls, { record: async (r) => { recorded.push(r); return true; } }),
  });
  process.env.GMAIL_EMAIL = "x@example.com"; process.env.GMAIL_APP_PASSWORD = "x";
  const res = { body: null, code: 200, header() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, sendStatus() {} };
  await handlers["POST /intake/web"][0]({ headers: {}, ip: "203.0.113.9", body: {
    name: "Mei Chen", phone: "(626) 555-0142", service: "immigration",
    message: "I received a notice to appear and do not know what to do next.", heard: "xhs" } }, res);
  assert.deepStrictEqual(res.body, { ok: true });
  assert.strictEqual(recorded.length, 1, "the form's answer was not recorded");
  assert.strictEqual(recorded[0].heard, "xhs");
  assert.strictEqual(recorded[0].channel, "website form");
  assert.ok(sentToTeam.some(t => /Heard about us: Xiaohongshu/.test(t)), "the team message does not show the answer");
});

check("the form is told which choices to offer, and nothing else", async () => {
  const handlers = {};
  wi.mount({ get: (p, ...h) => { handlers[p] = h; }, post: () => {}, options: () => {} }, {});
  const res = { body: null, header() {}, json(b) { this.body = b; } };
  handlers["/intake/web"][0]({ headers: {} }, res);
  assert.strictEqual(res.body.version, 2);
  assert.strictEqual(res.body.heard.length, ls.OPTIONS.length);
  for (const o of res.body.heard) assert.deepStrictEqual(Object.keys(o).sort(), ["en", "key", "zh"]);
});

check("one person is counted once per channel", () => {
  const src = read("lead-sources.js");
  assert.ok(/UNIQUE \(platform, platform_id\)/.test(src) && /ON CONFLICT \(platform, platform_id\) DO UPDATE/.test(src));
});

check("no name, phone number or message is stored", () => {
  const table = read("lead-sources.js").match(/CREATE TABLE IF NOT EXISTS lead_sources \(([\s\S]*?)\n      \)/)[1];
  assert.ok(!/name|phone|email|contact|message|issue/i.test(table), "lead_sources must hold only the channel, the kind of matter and the answer");
});

// ── 2. Nothing is invented ───────────────────────────────────
check("free-text answers land in the right category", () => {
  const cases = {
    "a friend told me": "friend", "my cousin": "friend", "朋友介绍的": "friend",
    "Google": "search", "I searched online, google I think": "search", "谷歌搜到的": "search",
    "google maps": "maps", "ChatGPT recommended you": "ai", "asked an AI": "ai",
    "WeChat": "wechat", "微信公众号": "wechat", "小红书": "xhs", "rednote": "xhs",
    "Instagram": "social", "youtube video": "video", "your newsletter": "article",
    "saw your sign on Nogales": "print", "my accountant": "partner", "另一位律师介绍": "partner",
    "I was a client before": "client", "radio": "other",
  };
  for (const [text, key] of Object.entries(cases)) assert.strictEqual(ls.parseAnswer(text).key, key, `"${text}" should be ${key}`);
});

check("a question or a long message is not taken as an answer", () => {
  for (const t of ["How much does it cost?", "what are your hours", "请问收费多少？", "ok", "thanks",
                   "I also wanted to ask about my brother who has a hearing next month in San Francisco and needs someone"]) {
    assert.strictEqual(ls.looksLikeAnswer(t), false, `"${t}" was read as an answer`);
  }
  for (const t of ["Google", "a friend", "小红书", "my accountant told me"]) assert.strictEqual(ls.looksLikeAnswer(t), true, `"${t}" was not read as an answer`);
});

async function runIntake(platformId, messages) {
  session = null;
  const replies = [];
  for (const m of messages) replies.push(await agent.processIntakeMessage("whatsapp", platformId, m, {}));
  return replies;
}
const WARM = ["I want to register a trademark", "Mei Chen", "6", "I want to register my shop name before a competitor does.", "626-555-0142", "4"];

check("Zara asks at the close, records the answer, and thanks the person", async () => {
  captured.length = 0;
  const r = await runIntake("16265550142", WARM.concat(["A friend told me about you"]));
  const close = r[5], after = r[6];
  assert.ok(close.handled && /how did you hear about us\?/i.test(close.message), "the close does not ask the question");
  assert.strictEqual(session.state, "completed", "the intake must still complete, so the team is told before the question is answered");
  assert.ok(after.handled && /thank you/i.test(after.message));
  assert.strictEqual(captured.length, 1);
  assert.deepStrictEqual([captured[0].key, captured[0].channel, captured[0].area], ["friend", "whatsapp", "Trademark/Patent"]);
  assert.strictEqual(captured[0].text, null, "a categorized answer must not keep the person's words; they may name someone");
});

check("a new question after the close is not filed as an answer", async () => {
  captured.length = 0;
  const r = await runIntake("16265550143", WARM.concat(["How much does it cost?", "Google"]));
  assert.strictEqual(r[6].handled, false, "Zara swallowed a real question");
  assert.strictEqual(r[7].handled, false, "the question was asked once; a later message must not be read as the answer");
  assert.strictEqual(captured.length, 0);
});

check("the question is asked once, not on every later message", async () => {
  captured.length = 0;
  const r = await runIntake("16265550144", WARM.concat(["WeChat", "Instagram"]));
  assert.strictEqual(r[6].handled, true);
  assert.strictEqual(r[7].handled, false);
  assert.deepStrictEqual(captured.map(c => c.key), ["wechat"]);
});

check("in Chinese, the question and the thanks are in Chinese", async () => {
  captured.length = 0;
  const r = await runIntake("16265550145", ["我想咨询商标注册", "陈梅", "6", "我想在竞争对手之前注册我的店名。", "626-555-0142", "4", "小红书"]);
  assert.ok(/您是怎么知道我们的/.test(r[5].message), "the Chinese close does not ask in Chinese");
  assert.ok(/谢谢/.test(r[6].message));
  assert.strictEqual(captured[0].key, "xhs");
});

// ── 3. The question costs nothing ────────────────────────────
check("an urgent lead is not asked", async () => {
  captured.length = 0;
  const r = await runIntake("16265550146", ["My husband was detained by ICE this morning", "Mei Chen", "1",
    "My husband was detained by ICE this morning and he has court tomorrow.", "626-555-0142", "4", "Google"]);
  assert.strictEqual(session.classification, "hot", "this test needs a lead the agent classifies as hot");
  assert.ok(!/how did you hear/i.test(r[5].message), "an urgent caller was asked how they heard about the firm");
  assert.strictEqual(r[6].handled, false);
  assert.strictEqual(captured.length, 0);
});

check("the form never refuses an intake over this field", () => {
  const { validate } = wi._internal;
  const base = { name: "Mei Chen", phone: "(626) 555-0142", service: "immigration", message: "I received a notice to appear and need help." };
  assert.strictEqual(validate(base).ok, true, "the question must be optional");
  assert.strictEqual(validate(base).intake.heard, "");
  const odd = validate(Object.assign({}, base, { heard: "__proto__" }));
  assert.strictEqual(odd.ok, true);
  assert.strictEqual(odd.intake.heard, "", "an unknown value must be dropped, not stored and not refused");
  assert.strictEqual(validate(Object.assign({}, base, { heard: "WeChat" })).intake.heard, "wechat");
});

check("an answer that fits no category keeps the person's words", async () => {
  captured.length = 0;
  await ls.record({ platform: "website", platformId: "web-2", heard: "other", heardText: "heard you on the radio" });
  assert.strictEqual(captured[0].text, "heard you on the radio");
});

check("a failed write does not throw into the intake", async () => {
  const q = fakeDb.query;
  fakeDb.query = async () => { throw new Error("database is down"); };
  const err = console.error; console.error = () => {};
  try { assert.strictEqual(await ls.record({ platform: "website", platformId: "web-1", heard: "search" }), false); }
  finally { fakeDb.query = q; console.error = err; }
});

// ── The page ─────────────────────────────────────────────────
check("the report counts by month and reads back as a page", async () => {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  fakeDb.reportRows = (s) => {
    if (/GROUP BY 1, 2/.test(s) && /SELECT to_char/.test(s)) return [{ month, heard_key: "friend", n: 3 }, { month, heard_key: "xhs", n: 2 }];
    if (/SELECT case_area/.test(s)) return [{ case_area: "Immigration", heard_key: "friend", n: 3 }, { case_area: "Immigration", heard_key: "xhs", n: 2 }];
    if (/heard_text/.test(s)) return [{ heard_text: "radio <ad>", n: 1 }];
    return [];
  };
  const r = await ls.report(6);
  assert.strictEqual(r.months.length, 6);
  assert.strictEqual(r.months[5], month);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.sources.find(s => s.key === "friend").total, 3);
  const html = ls._internal.renderPage(r);
  assert.ok(/A friend or family member \(3\)/.test(html), "the most named source is not shown");
  assert.ok(html.includes("radio &lt;ad&gt;"), "free-text answers must be escaped");
  assert.ok(!/undefined|NaN/.test(html));
});

(async () => {
  for (const [name, fn] of queue) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  }
  console.log(`\n${passed} checks passed\n`);
  process.exit(0);
})().catch(err => { console.error("\n  FAIL  " + (err && err.message || err)); process.exit(1); });
