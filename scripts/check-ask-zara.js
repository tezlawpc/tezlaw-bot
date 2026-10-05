// check-ask-zara.js — staff asking Zara in the ops group (tg-ask.js).
//
// An answer in a group is read by everyone in it, so the controls are in
// code and this checks the code:
//   1. she answers only when addressed, and only a linked staff login;
//   2. she can run only the look-ups on the group's list, and none that
//      change a record or show trust money, firm revenue or anyone's hours;
//   3. Social Security, card and bank numbers are taken out of what she sends;
//   4. only JJ can link a Telegram account, and never to a consultant login.
//
// Runs with no network, no database and no node_modules.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");

const posts = [];
const fakeAxios = {
  post: async (url, body) => { posts.push({ call: String(url).split("/").pop(), ...body }); return { data: { ok: true } }; },
  get: async () => ({ data: { result: { username: "TEZJJBot" } } }),
};

// A pretend database: the staff logins, who is linked, and the question log.
const state = { users: [], links: new Map(), log: [], matterSql: [] };
const fakeDb = {
  query: async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^CREATE TABLE/.test(s)) return { rows: [], rowCount: 0 };
    if (/FROM matters m WHERE m\.status = 'active'/.test(s)) { state.matterSql.push({ s, params }); return { rows: [{ id: 7, client_name: "Birch, Anna", matter_ref: "RM-1", court: "LA Immigration Court", case_type: "Removal", mark: null }] }; }
    if (/FROM matter_deadlines d/.test(s)) {
      state.matterSql.push({ s, params });
      return { rows: [{ matter_id: 7, client_name: "Birch, Anna", title: "Master calendar hearing", due_date: "2026-10-10", party: "court" }] };
    }
    if (/FROM staff_telegram s JOIN admin_users u/.test(s)) {
      const uid = state.links.get(String(params[0]));
      return { rows: state.users.filter(u => u.id === uid) };
    }
    if (/FROM admin_users WHERE role = 'admin'/.test(s)) return { rows: state.users.filter(u => u.role === "admin" && !u.disabled).slice(0, 1) };
    if (/^SELECT .*FROM admin_users WHERE LOWER\(username\)/.test(s)) return { rows: state.users.filter(u => u.username.toLowerCase() === String(params[0]).toLowerCase()) };
    if (/^INSERT INTO staff_telegram/.test(s)) { state.links.set(String(params[0]), params[1]); return { rows: [], rowCount: 1 }; }
    if (/^DELETE FROM staff_telegram WHERE telegram_id/.test(s)) { const had = state.links.delete(String(params[0])); return { rows: [], rowCount: had ? 1 : 0 }; }
    if (/^DELETE FROM staff_telegram WHERE user_id IN/.test(s)) {
      const u = state.users.find(x => x.username.toLowerCase() === String(params[0]).toLowerCase());
      let n = 0; for (const [k, v] of [...state.links]) if (u && v === u.id) { state.links.delete(k); n++; }
      return { rows: [], rowCount: n };
    }
    if (/^INSERT INTO staff_ask_log/.test(s)) { state.log.push({ telegram_id: params[0], user_id: params[1], question: params[4], tools: params[5], outcome: params[6] }); return { rows: [], rowCount: 1 }; }
    if (/FROM admin_users u WHERE COALESCE\(u\.disabled/.test(s)) {
      return { rows: state.users.filter(u => !u.disabled && !["consultant", "client"].includes(u.role)).map(u => ({
        username: u.username, full_name: u.full_name, role: u.role,
        linked: [...state.links].filter(([, v]) => v === u.id).map(([k]) => k).join(", ") || null })) };
    }
    return { rows: [], rowCount: 0 };
  },
};

// The app's look-ups, as the group sees them: the real names, a recording runner.
const APP_TOOLS = ["get_civil_matter", "find_civil_matter", "count_active_cases", "list_recent_clients", "search_client_by_name",
  "list_upcoming_hearings", "list_my_tasks", "list_recent_client_documents", "list_outstanding_invoices", "get_my_time_summary",
  "get_client_time_summary", "get_client_notes", "get_practice_insights", "get_client_trust_balance", "get_firm_trust_summary",
  "list_matter_templates", "list_case_documents", "read_case_document", "propose_matter_update", "propose_case_entry",
  "propose_memo", "reconstruct_time", "show_time_proposal", "import_time_ledger", "propose_time_entries", "a_tool_added_next_year"];
const ran = [];
const fakeAppChat = {
  STAFF_TOOLS: APP_TOOLS.map(name => ({ name, description: name, input_schema: { type: "object", properties: {} } })),
  executeTool: async (_db, user, name, input) => { ran.push({ name, user }); return { ok: true, name }; },
};
// The model, scripted: it asks for whatever `script.tools` says, then answers `script.text`.
const script = { tools: [], text: "ok", seen: null, fail: null };
const fakeCore = {
  think: async (opts) => {
    script.seen = opts;
    if (script.fail) throw new Error(script.fail);
    script.results = [];
    for (const t of script.tools) script.results.push(await opts.onToolUse(t, {}));
    return { text: script.text };
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "axios") return fakeAxios;
  if (request === "./db") return fakeDb;
  if (request === "./zara-app-chat") return fakeAppChat;
  if (request === "./zara-core") return fakeCore;
  return origLoad.call(this, request, ...rest);
};
const ask = require(path.join(ROOT, "tg-ask.js"));

const KEYS = ["TG_OPS_CHAT_ID", "JJ_TELEGRAM_ID", "RECIPIENT_JJ_TELEGRAM_ID", "TG_APPROVER_IDS", "TELEGRAM_TOKEN",
              "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TG_ASK_HOURLY"];
let nextUser = 1000;
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { TELEGRAM_TOKEN: "t", TG_OPS_CHAT_ID: "-1009", JJ_TELEGRAM_ID: "555", TELEGRAM_BOT_USERNAME: "TEZJJBot" }, vars);
  posts.length = 0; ran.length = 0; state.log.length = 0; state.links.clear();
  state.users = [
    { id: 1, username: "jj", full_name: "JJ Zhang", role: "admin", disabled: false },
    { id: 2, username: "mliu", full_name: "Michael Liu", role: "paralegal", disabled: false },
    { id: 3, username: "partner1", full_name: "Outside Partner", role: "consultant", disabled: false },
    { id: 4, username: "former", full_name: "Former Staff", role: "paralegal", disabled: true },
  ];
  Object.assign(script, { tools: [], text: "ok", seen: null, fail: null });
  try { return await fn(); }
  finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
// Each check uses a fresh Telegram id so one check's short memory or hourly count cannot reach the next.
const fresh = () => ++nextUser;
const inGroup = (text, from, extra = {}) => ({ message_id: 42, text, chat: { id: -1009, type: "supergroup" }, from: { id: from, first_name: "Staff" }, message_thread_id: 14, ...extra });
const said = () => posts.filter(p => p.call === "sendMessage");

const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ── when she is being spoken to ─────────────────────────────────────────
check("she is addressed by @mention or /ask, and by nothing else", () => {
  const q = (t) => ask.questionIn(t, "TEZJJBot");
  assert.strictEqual(q("@TEZJJBot when is the Birch hearing?"), "when is the Birch hearing?");
  assert.strictEqual(q("when is the Birch hearing @tezjjbot"), "when is the Birch hearing");
  assert.strictEqual(q("@TEZJJBot, what is due this week"), "what is due this week");
  assert.strictEqual(q("/ask what is due this week"), "what is due this week");
  assert.strictEqual(q("/ask@TEZJJBot what is due"), "what is due");
  assert.strictEqual(q("@TEZJJBot"), "");
  assert.strictEqual(q("/ask"), "");
  for (const t of ["can someone call the clerk back about the Lu hearing?", "email jj@tezlawfirm.com", "ask @TEZJJBot2 instead",
                   "/tasks@TEZJJBot", "/ask@OtherBot hello", "/asking for a friend", "x@TEZJJBot", "", null]) {
    assert.strictEqual(q(t), null, JSON.stringify(t));
  }
});
check("staff talking to each other get no reply at all", () => withEnv({}, async () => {
  for (const t of ["the Lu hearing moved to the 14th", "who has the Chen file?", "ok thanks @michael"]) {
    assert.strictEqual(await ask.handle(inGroup(t, fresh())), false, t);
  }
  assert.strictEqual(posts.length, 0);
  assert.strictEqual(script.seen, null);
}));
check("outside the ops group she is not this Zara", () => withEnv({}, async () => {
  const m = { message_id: 1, text: "@TEZJJBot what is due this week", chat: { id: 999, type: "private" }, from: { id: 555 } };
  assert.strictEqual(await ask.handle(m), false);
  assert.strictEqual(posts.length, 0);
}));

// ── who is answered ─────────────────────────────────────────────────────
check("someone in the group who is not linked is told how, and nothing is looked up", () => withEnv({}, async () => {
  assert.strictEqual(await ask.handle(inGroup("@TEZJJBot what is the status of the Chen case", fresh())), true);
  assert.strictEqual(script.seen, null, "the model was called for someone who is not linked");
  assert.strictEqual(ran.length, 0);
  assert.ok(/linked to your staff login/.test(said()[0].text));
  assert.strictEqual(state.log[0].outcome, "not linked");
}));
check("a linked staff member is answered, in the topic, as a reply to the question", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  script.text = "Master calendar hearing is October 10 at 8:30 AM.";
  assert.strictEqual(await ask.handle(inGroup("@TEZJJBot when is the Birch hearing?", id)), true);
  const m = said()[0];
  assert.strictEqual(m.text, "Master calendar hearing is October 10 at 8:30 AM.");
  assert.strictEqual(m.chat_id, "-1009");
  assert.strictEqual(m.message_thread_id, 14);
  assert.strictEqual(m.reply_parameters.message_id, 42);
  assert.strictEqual(script.seen.message, "when is the Birch hearing?");
  assert.ok(/Asked by Michael Liu \(paralegal\)/.test(script.seen.context));
  assert.strictEqual(script.seen.surface, "staff");
  assert.strictEqual(state.log[0].outcome, "answered");
  assert.strictEqual(state.log[0].user_id, 2);
}));
check("JJ is recognised by his own Telegram id without linking", () => withEnv({}, async () => {
  assert.strictEqual(await ask.handle(inGroup("/ask what is due this week", 555)), true);
  assert.ok(/Asked by JJ Zhang \(admin\)/.test(script.seen.context));
}));
check("a consultant login and a disabled login are never answered, even when linked", () => withEnv({}, async () => {
  const a = fresh(), b = fresh(); state.links.set(String(a), 3); state.links.set(String(b), 4);
  await ask.handle(inGroup("@TEZJJBot list recent clients", a));
  await ask.handle(inGroup("@TEZJJBot list recent clients", b));
  assert.strictEqual(script.seen, null);
  assert.strictEqual(said().length, 2);
  assert.ok(said().every(m => /linked to your staff login/.test(m.text)));
  assert.strictEqual(ask.mayAnswer({ role: "consultant", disabled: false }), false);
  assert.strictEqual(ask.mayAnswer({ role: "client", disabled: false }), false);
  assert.strictEqual(ask.mayAnswer({ role: "paralegal", disabled: true }), false);
  assert.strictEqual(ask.mayAnswer({ role: null, disabled: false }), false);
  assert.strictEqual(ask.mayAnswer({ role: "attorney", disabled: false }), true);
}));

// ── what she may look up ────────────────────────────────────────────────
const FORBIDDEN = ["get_client_trust_balance", "get_firm_trust_summary", "get_practice_insights", "get_my_time_summary",
  "get_client_time_summary", "propose_matter_update", "propose_case_entry", "propose_memo", "reconstruct_time",
  "show_time_proposal", "import_time_ledger", "propose_time_entries"];
check("the group's look-ups: nothing that writes, no trust money, no revenue, nobody's hours", () => {
  const names = ask.groupTools().map(t => t.name);
  for (const f of FORBIDDEN) assert.ok(!names.includes(f), `${f} is offered in the group`);
  assert.ok(!names.some(n => /^propose_|trust|insight|time/.test(n)), names.join());
  assert.ok(names.includes("matter_deadlines") && names.includes("search_client_by_name") && names.includes("get_civil_matter"));
});
check("Matter Manager: a named client gets every open deadline; no name gets the next two weeks", async () => {
  state.matterSql.length = 0;
  let r = await ask.matterDeadlines({ query: "Birch" });
  assert.strictEqual(state.matterSql[1].params[1], null, "a named client's deadlines were cut to a number of days nobody asked for");
  assert.deepStrictEqual(r.matters[0].open_deadlines.map(d => d.title), ["Master calendar hearing"]);
  r = await ask.matterDeadlines({ query: "Birch", days: 30 });
  assert.strictEqual(state.matterSql[3].params[1], 30);
  state.matterSql.length = 0;
  r = await ask.matterDeadlines({});
  assert.strictEqual(state.matterSql[0].params[0], 14);
  assert.strictEqual(r.days_ahead, 14);
  r = await ask.matterDeadlines({ days: 7 });
  assert.strictEqual(state.matterSql[1].params[0], 7);
  assert.ok(/m\.status = 'active'/.test(state.matterSql[1].s) && /d\.completed = FALSE/.test(state.matterSql[1].s));
});
check("it is a list of what is allowed: a tool added to the app later is not offered here", () => {
  assert.ok(!ask.groupTools().map(t => t.name).includes("a_tool_added_next_year"));
});
check("a look-up that is not on the list is refused in code, whatever the model asks for", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  script.tools = ["search_client_by_name", "get_client_trust_balance", "propose_matter_update", "a_tool_added_next_year"];
  await ask.handle(inGroup("@TEZJJBot how much is in trust for Chen and update the file", id));
  assert.deepStrictEqual(ran.map(r => r.name), ["search_client_by_name"]);
  assert.ok(script.results.slice(1).every(r => /not available in the group/.test(r.error)));
  assert.deepStrictEqual(ran[0].user, { uid: 2, u: "mliu", n: "Michael Liu", r: "paralegal" });
  assert.strictEqual(state.log[0].tools, script.tools.join(","));      // what was attempted is on the record
}));
check("she is told she can only look, and that everyone reads the answer", () => {
  assert.ok(/EVERYONE IN THE GROUP READS YOUR ANSWER/.test(ask.GROUP_OPS));
  assert.ok(/YOU CANNOT CHANGE ANYTHING FROM HERE/.test(ask.GROUP_OPS));
  assert.ok(!/propose_|Apply button/.test(ask.GROUP_OPS), "the group instructions mention the app's write tools");
});

// ── what never leaves ───────────────────────────────────────────────────
check("Social Security, card and bank numbers are taken out of the answer", () => {
  const w = ask.withhold;
  assert.strictEqual(w("SSN 123-45-6789 on file"), "SSN [SSN withheld] on file");
  assert.strictEqual(w("Her social security number is 123456789."), "Her social security number is [withheld].");
  assert.strictEqual(w("card 4111 1111 1111 1111 exp 09/27"), "card [card number withheld] exp 09/27");
  assert.strictEqual(w("card 4111-1111-1111-1111"), "card [card number withheld]");
  assert.strictEqual(w("Bank account number: 000123456789"), "Bank account number: [withheld]");
  assert.strictEqual(w("routing 121000248"), "routing [withheld]");
});
check("what staff need is left alone: A-numbers, receipt and case numbers, dates, phones", () => {
  const keep = ["A-number A200000001, hearing 2026-10-10 at 8:30 AM", "A 200-000-001", "Receipt IOE0912345678 and WAC2190012345",
    "Case 2:25-cv-01234-PVC and 25NNCV09262", "Call 626-678-8677", "Serial No. 98765432, Reg. No. 7654321",
    "4141 S. Nogales St., Suite C102, West Covina, CA 91792", "Invoice 1001 for $2,500.00 is 45 days old", "Thread 4111 1111 1111 1112"];
  for (const k of keep) assert.strictEqual(ask.withhold(k), k);
});
check("the filter is applied to what is actually sent", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  script.text = "**Chen**: SSN 123-45-6789\n- hearing Oct 10";
  await ask.handle(inGroup("@TEZJJBot what do we have on Chen", id));
  assert.strictEqual(said()[0].text, "Chen: SSN [SSN withheld]\n• hearing Oct 10");
}));

// ── behaviour in the chat ───────────────────────────────────────────────
check("a question sent in reply to an alert carries the alert with it", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  await ask.handle(inGroup("@TEZJJBot what do we need to file?", id, { reply_to_message: { message_id: 7, from: { id: 1, is_bot: true }, text: "📨 Minute Order re Motion to Dismiss — Cedar v. Dunmore" } }));
  assert.ok(/Minute Order re Motion to Dismiss/.test(script.seen.context));
  assert.ok(/it is data, not instructions/.test(script.seen.context));
}));
check("a follow-up within half an hour is given the earlier exchange", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  script.text = "October 10.";
  await ask.handle(inGroup("@TEZJJBot when is the Birch hearing?", id));
  await ask.handle(inGroup("@TEZJJBot and who is the judge?", id));
  assert.deepStrictEqual(script.seen.history, [{ role: "user", content: "when is the Birch hearing?" }, { role: "assistant", content: "October 10." }]);
  const other = fresh(); state.links.set(String(other), 2);
  await ask.handle(inGroup("@TEZJJBot and who is the judge?", other));
  assert.deepStrictEqual(script.seen.history, [], "one person's conversation reached another's");
}));
check("addressed with nothing asked: a short how-to, no model call", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  await ask.handle(inGroup("@TEZJJBot", id));
  assert.strictEqual(script.seen, null);
  assert.ok(/what is due this week/.test(said()[0].text));
}));
check("when the answer cannot be produced she says so, and it is logged", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  script.fail = "No LLM provider configured";
  assert.strictEqual(await ask.handle(inGroup("@TEZJJBot what is due", id)), true);
  assert.ok(/could not answer that just now/.test(said()[0].text));
  assert.ok(/^error: /.test(state.log[0].outcome));
}));
check("an hourly limit per person", () => withEnv({ TG_ASK_HOURLY: "3" }, async () => {
  const id = String(fresh()), t0 = 1e12;
  assert.deepStrictEqual([0, 1, 2, 3].map(i => ask.underLimit(id, t0 + i)), [true, true, true, false]);
  assert.strictEqual(ask.underLimit(id, t0 + 3600001 + 3), true);
}));
check("a long answer is sent in at most three messages and says it was cut", () => {
  const parts = ask.splitForTelegram(Array.from({ length: 400 }, (_, i) => `line ${i} ` + "x".repeat(60)).join("\n"));
  assert.strictEqual(parts.length, 3);
  assert.ok(parts.every(p => p.length <= 3900));
  assert.ok(/Cut short here/.test(parts[2]));
  assert.deepStrictEqual(ask.splitForTelegram("short"), ["short"]);
});

// ── /staff ──────────────────────────────────────────────────────────────
const replyTo = (id, name) => ({ reply_to_message: { message_id: 5, from: { id, first_name: name, is_bot: false } } });
check("/staff link: JJ replies to a person's message, and that person is then answered", () => withEnv({}, async () => {
  const id = fresh();
  assert.strictEqual(await ask.handleStaffCommand(inGroup("/staff link mliu", 555, replyTo(id, "Michael"))), true);
  assert.ok(/Linked Michael to Michael Liu \(paralegal\)/.test(said()[0].text), said()[0].text);
  assert.strictEqual(state.links.get(String(id)), 2);
  posts.length = 0;
  await ask.handle(inGroup("@TEZJJBot what is due", id));
  assert.ok(script.seen, "the newly linked person was not answered");
}));
check("/staff link from anyone but JJ is refused, approvers included", () => withEnv({ TG_APPROVER_IDS: "777" }, async () => {
  for (const who of [777, fresh()]) {
    assert.strictEqual(await ask.handleStaffCommand(inGroup("/staff link jj", who, replyTo(who, "Me"))), true);
  }
  assert.ok(said().every(m => /restricted/.test(m.text)));
  assert.strictEqual(state.links.size, 0);
}));
check("/staff link will not link a consultant or a disabled login", () => withEnv({}, async () => {
  await ask.handleStaffCommand(inGroup("/staff link partner1", 555, replyTo(fresh(), "P")));
  await ask.handleStaffCommand(inGroup("/staff link former", 555, replyTo(fresh(), "F")));
  await ask.handleStaffCommand(inGroup("/staff link nobody", 555, replyTo(fresh(), "N")));
  assert.strictEqual(state.links.size, 0);
  assert.ok(/consultant login/.test(said()[0].text));
  assert.ok(/disabled/.test(said()[1].text));
  assert.ok(/no staff login named/.test(said()[2].text));
}));
check("/staff unlink stops the answers; /staff lists who can ask, without consultants", () => withEnv({}, async () => {
  const id = fresh(); state.links.set(String(id), 2);
  await ask.handleStaffCommand(inGroup("/staff", 555));
  assert.ok(/✅ Michael Liu · login mliu · paralegal/.test(said()[0].text), said()[0].text);
  assert.ok(!/partner1|Former Staff/.test(said()[0].text));
  await ask.handleStaffCommand(inGroup("/staff unlink mliu", 555));
  assert.strictEqual(state.links.size, 0);
  posts.length = 0;
  await ask.handle(inGroup("@TEZJJBot what is due", id));
  assert.strictEqual(script.seen, null);
}));
check("something that is not /staff is left for the rest of the bot", () => withEnv({}, async () => {
  assert.strictEqual(await ask.handleStaffCommand(inGroup("/staffing levels look fine", 555)), false);
  assert.strictEqual(await ask.handleStaffCommand(inGroup("staff meeting at 3", 555)), false);
}));

// ── where it sits in the server ─────────────────────────────────────────
check("server.js: she is asked before the group's silence rule, and the rule is still there", () => {
  const s = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const a = s.indexOf("if (await tgAsk.handle(msg)) return;");
  const b = s.indexOf("if (tgOps.isOpsChat(chatId) && !tgOps.allowedInOpsGroup(textForCmd)) return;");
  assert.ok(a > 0 && b > a, "the order is wrong");
  assert.ok(s.indexOf("if (await tgAsk.handleStaffCommand(msg)) return;") < a);
  const app = fs.readFileSync(path.join(ROOT, "zara-app-chat.js"), "utf8");
  assert.ok(/module\.exports = \{\s+chat,\s+executeTool,/.test(app));
});

(async () => {
  console.log("\nask Zara in the ops group\n");
  let ok = 0;
  for (const [name, fn] of queue) {
    try { await fn(); ok++; console.log(`  ok  ${name}`); }
    catch (e) { console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 5).join("\n        ")}`); }
  }
  console.log(`\n${ok} of ${queue.length} checks passed\n`);
  process.exit(ok === queue.length ? 0 : 1);
})();
