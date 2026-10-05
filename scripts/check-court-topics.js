// check-court-topics.js — court notices land in the right court's topic.
//
// The Court & deadlines topic is divided into State court, EOIR immigration
// court, Federal court and USPTO. Three things have to hold:
//   1. a notice is sorted by the court it names, and one that names no court
//      is not guessed at: it stays in Court & deadlines;
//   2. a court topic that has not been created yet posts in Court &
//      deadlines, so nothing is lost while the topics are being set up;
//   3. a sender that posted one message still posts one until then.
//
// Runs with no network, no database and no node_modules.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");

const posts = [];
const fakeAxios = { post: async (url, body) => { posts.push({ url, ...body }); return { data: { ok: true } }; }, get: async () => ({ data: {} }) };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "axios") return fakeAxios;
  if (request === "./db") return { query: async () => ({ rows: [], rowCount: 0 }) };
  return origLoad.call(this, request, ...rest);
};
const route = require(path.join(ROOT, "tg-route.js"));

const KEYS = ["TG_OPS_CHAT_ID", "TG_TOPIC_COURT", "TG_TOPIC_STATE", "TG_TOPIC_EOIR", "TG_TOPIC_FEDERAL", "TG_TOPIC_USPTO",
              "TG_TOPIC_SOCIAL", "TG_TOPIC_LEADS", "TG_TOPIC_OPS", "JJ_TELEGRAM_ID", "RECIPIENT_JJ_TELEGRAM_ID",
              "RECIPIENT_JUE_TELEGRAM_ID", "TELEGRAM_TOKEN", "TELEGRAM_BOT_TOKEN"];
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { TELEGRAM_TOKEN: "t" }, vars);
  posts.length = 0;
  try { return await fn(); }
  finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const ONE   = { TG_OPS_CHAT_ID: "-1009", TG_TOPIC_COURT: "11", JJ_TELEGRAM_ID: "555" };
const SPLIT = { ...ONE, TG_TOPIC_STATE: "21", TG_TOPIC_EOIR: "22", TG_TOPIC_FEDERAL: "23", TG_TOPIC_USPTO: "24" };

const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ── 1. sorting ──────────────────────────────────────────────────────────
const TABLE = [
  // the court named on the matter
  [{ court: "LASC — Stanley Mosk" }, "state"],
  [{ court: "Superior Court of California, County of Los Angeles" }, "state"],
  [{ court: "OCSC" }, "state"],
  [{ court: "Court of Appeal, Second Appellate District" }, "state"],
  [{ court: "Second District Court of Appeal" }, "state"],
  [{ court: "Supreme Court, Queens County" }, "state"],
  [{ court: "Civil Court of the City of New York" }, "state"],
  [{ court: "New York Court of Appeals" }, "state"],
  [{ court: "LA Immigration Court" }, "eoir"],
  [{ court: "EOIR - New York Broadway" }, "eoir"],
  [{ court: "BIA" }, "eoir"],
  [{ court: "9th Cir." }, "federal"],
  [{ court: "U.S. Court of Appeals for the Ninth Circuit" }, "federal"],
  [{ court: "C.D. Cal." }, "federal"],
  [{ court: "United States District Court, Central District of California" }, "federal"],
  [{ court: "District Court" }, "federal"],
  [{ court: "SDNY" }, "federal"],
  [{ court: "U.S. Bankruptcy Court" }, "federal"],
  [{ court: "USPTO" }, "uspto"],
  [{ court: "TTAB" }, "uspto"],
  [{ court: "USCO" }, "uspto"],
  // the court wins over the matter type
  [{ case_type: "Trademark" }, "uspto"],
  [{ case_type: "Trademark", court: "C.D. Cal." }, "federal"],
  [{ case_type: "Removal" }, "eoir"],
  [{ case_type: "Removal", court: "9th Cir." }, "federal"],
  [{ case_type: "landlord/tenant — unlawful detainer" }, "state"],
  // what a court email was read as
  [{ agency: "state_court", court: "" }, "state"],
  [{ agency: "federal_court" }, "federal"],
  [{ agency: "eoir" }, "eoir"],
  [{ agency: "uspto" }, "uspto"],
  [{ agency: "eservice", court: "Los Angeles Superior Court" }, "state"],
  // wording, when nothing else is known
  [{ title: "Master calendar hearing" }, "eoir"],
  [{ title: "Petition for review of BIA decision, 9th Cir." }, "federal"],
  [{ text: "ecf_notice@cacd.uscourts.gov Activity in Case 2:25-cv-01234" }, "federal"],
  // not guessed at
  [{}, "court"],
  [null, "court"],
  [{ agency: "uscis", court: "USCIS Nebraska Service Center" }, "court"],
  [{ agency: "ice" }, "court"],
  [{ case_type: "breach of contract" }, "court"],
  [{ title: "Opposition to MSJ due" }, "court"],
];
check(`${TABLE.length} courts, matter types and notices sort where a person would put them`, () => {
  for (const [hint, want] of TABLE) {
    assert.strictEqual(route.courtTopic(hint), want, `${JSON.stringify(hint)} -> ${route.courtTopic(hint)}, expected ${want}`);
  }
});
check("every answer is a topic that exists", () => {
  for (const [hint] of TABLE) assert.ok(route.TOPICS[route.courtTopic(hint)]);
});

// ── 2. the fallback while a topic does not exist ─────────────────────────
check("a court topic with its own thread posts there", () => withEnv(SPLIT, () => {
  assert.deepStrictEqual(["state", "eoir", "federal", "uspto"].map(t => route.routeFor(t).message_thread_id), [21, 22, 23, 24]);
  assert.ok(["state", "eoir", "federal", "uspto"].every(t => route.routeFor(t).via === "topic"));
}));
check("a court topic not created yet posts in Court & deadlines, and says so", () => withEnv({ ...ONE, TG_TOPIC_EOIR: "22" }, () => {
  const r = route.routeFor("state");
  assert.strictEqual(r.chat_id, "-1009");
  assert.strictEqual(r.message_thread_id, 11);
  assert.strictEqual(r.via, "parent");
  assert.strictEqual(route.routeFor("eoir").message_thread_id, 22);
  assert.strictEqual(route.routeFor("social").via, "group");           // the other topics do not inherit
}));
check("a topic NAME pasted in as the id falls back the same way", () => withEnv({ ...ONE, TG_TOPIC_STATE: "State court" }, () => {
  assert.strictEqual(route.routeFor("state").message_thread_id, 11);
}));
check("no Court & deadlines topic either: the group itself, not nowhere", () => withEnv({ TG_OPS_CHAT_ID: "-1009" }, () => {
  const r = route.routeFor("federal");
  assert.strictEqual(r.chat_id, "-1009");
  assert.strictEqual(r.message_thread_id, undefined);
  assert.strictEqual(r.via, "group");
}));
check("no group at all: JJ's direct message, as before", () => withEnv({ JJ_TELEGRAM_ID: "555" }, () => {
  assert.strictEqual(route.routeFor("uspto").chat_id, "555");
  assert.strictEqual(route.routeFor("uspto").via, "dm");
}));
check("send() really posts to the inherited thread", () => withEnv(ONE, async () => {
  assert.strictEqual(await route.send("federal", "x"), true);
  assert.strictEqual(posts[0].message_thread_id, 11);
}));

// ── 3. one message until the topics exist ────────────────────────────────
const ITEMS = [{ c: "LASC" }, { c: "9th Cir." }, { c: "LA Immigration Court" }, { c: "USPTO" }, { c: "" }, { c: "OCSC" }];
const kind = x => route.courtTopic({ court: x.c });
check("nothing split: one group, unlabelled, everything in it", () => withEnv(ONE, () => {
  const g = route.groupByDestination(ITEMS, kind);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].topic, "court");
  assert.strictEqual(g[0].label, "");
  assert.strictEqual(g[0].items.length, ITEMS.length);
}));
check("no group configured: still one group", () => withEnv({ JJ_TELEGRAM_ID: "555" }, () => {
  assert.strictEqual(route.groupByDestination(ITEMS, kind).length, 1);
}));
check("all four set: five groups, each labelled, the unsorted one in Court & deadlines", () => withEnv(SPLIT, () => {
  const g = route.groupByDestination(ITEMS, kind);
  const by = Object.fromEntries(g.map(x => [x.topic, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), ["court", "eoir", "federal", "state", "uspto"]);
  assert.strictEqual(by.state.items.length, 2);
  assert.strictEqual(by.state.label, "State court");
  assert.strictEqual(by.eoir.label, "EOIR immigration court");
  assert.strictEqual(by.court.label, "");
  assert.deepStrictEqual(by.court.items, [{ c: "" }]);
}));
check("half set up: the unset ones join Court & deadlines in one group", () => withEnv({ ...ONE, TG_TOPIC_EOIR: "22" }, () => {
  const g = route.groupByDestination(ITEMS, kind);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g.find(x => x.topic === "court").items.length, 5);
}));
check("two court topics pointed at one thread are one labelled group", () => withEnv({ ...SPLIT, TG_TOPIC_FEDERAL: "21" }, () => {
  const g = route.groupByDestination(ITEMS, kind).find(x => x.items.some(i => i.c === "9th Cir."));
  assert.strictEqual(g.label, "State court + Federal court");
}));

// ── /whereami: the exact setting for the topic it is typed in ────────────
check("a topic's name gives the setting its thread id belongs in", () => {
  const want = { "State court": "TG_TOPIC_STATE", "EOIR immigration court": "TG_TOPIC_EOIR", "Federal court": "TG_TOPIC_FEDERAL",
                 "District court": "TG_TOPIC_FEDERAL", "USPTO": "TG_TOPIC_USPTO", "Court & deadlines": "TG_TOPIC_COURT",
                 "Social & content": "TG_TOPIC_SOCIAL", "Leads & intake": "TG_TOPIC_LEADS", "Ops & system": "TG_TOPIC_OPS" };
  for (const [name, env] of Object.entries(want)) assert.strictEqual(route.envForTopicName(name), env, name);
  assert.strictEqual(route.envForTopicName("General"), null);
  assert.strictEqual(route.envForTopicName(""), null);
});

// ── the senders ─────────────────────────────────────────────────────────
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
check("deadline tracker: hearing-note deadlines are EOIR, typed-in ones are read", () => {
  const dt = read("deadline-tracker.js");
  const a = dt.indexOf("function courtTopicOf(d)");
  assert.ok(a >= 0, "courtTopicOf not found");
  const courtTopicOf = new Function("require", dt.slice(a, dt.indexOf("\n}\n", a) + 2) + "\nreturn courtTopicOf;")(() => route);
  assert.strictEqual(courtTopicOf({ source_type: "hearing_note", description: "File I-589 supplement" }), "eoir");
  assert.strictEqual(courtTopicOf({ source_type: "merits_evidence", description: "Evidence due" }), "eoir");
  assert.strictEqual(courtTopicOf({ source_type: "manual", description: "Reply brief, 9th Cir." }), "federal");
  assert.strictEqual(courtTopicOf({ source_type: "manual", description: "Call client" }), "court");
  assert.ok(/await sendTelegramAlert\(msg, topic\);/.test(dt));
});
check("server.js: the morning summary is sorted, and the trademark check goes to USPTO", () => {
  const s = read("server.js");
  assert.ok(s.includes("tgr.groupByDestination("));
  assert.ok(s.includes("for (const B of courtGroups) {"));
  assert.strictEqual(s.split("await tgSendTopic(B.topic, text);").length - 1, 2);
  assert.ok(s.includes('await tgSendTopic("uspto", text);'));
  assert.ok(!s.includes('await tgSendTopic("court", text);'), "something still posts a court notice unsorted");
  assert.ok(s.includes("m.client_name, m.matter_ref, m.case_type, m.court, m.id AS matter_id\n"));
});
check("court email, hearing notes, reminders, limitation dates and clerk calls are sorted", () => {
  const cm = read("court-mail.js");
  assert.strictEqual(cm.split("courtHint(reading));").length - 1, 2);
  assert.ok(cm.includes("tgr.send(hint ? tgr.courtTopic(hint) : \"court\", text)"));
  assert.ok(read("hearing-notes.js").includes('target("eoir")'));
  assert.ok(read("individual-hearing-notes.js").includes('target("eoir")'));
  assert.ok(read("hearing-reminders.js").includes('send("eoir", message)'));
  assert.ok(read("sol.js").includes('send("state", text'));
  assert.ok(read("voice-call.js").includes("courtTopic({ court: intake.courtName })"));
});

(async () => {
  console.log("\ncourt topics\n");
  let ok = 0;
  for (const [name, fn] of queue) {
    try { await fn(); ok++; console.log(`  ok  ${name}`); }
    catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 4).join("\n        ")}`); }
  }
  console.log(`\n${ok} of ${queue.length} checks passed\n`);
  process.exit(ok === queue.length ? 0 : 1);
})();
