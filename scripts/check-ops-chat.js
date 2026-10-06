// check-ops-chat.js — the ops group's house rules, run against the real code.
//
// What must hold:
//   - inside the ops group the bot reads a short list of commands and nothing
//     else, so staff talking to each other are never answered by Zara;
//   - the task commands answer staff only (the bot is public and the task
//     list names clients);
//   - every sender that used to write to JJ directly now follows a topic, and
//     still reaches JJ when no group is configured;
//   - what is meant to stay private (distress alerts, admin sign-in) still
//     goes to JJ alone.
//
// Runs with no network and no node_modules: axios, form-data and the
// database are stood in for.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ROOT = path.join(__dirname, "..");

const posts = [];                 // every Telegram call the code makes
let failNext = null;              // (url, body) => true to answer 400 once
class FakeForm {
  constructor() { this.fields = {}; }
  append(k, v) { this.fields[k] = Buffer.isBuffer(v) ? "<file>" : v; }
  getHeaders() { return {}; }
}
const fakeAxios = {
  post: async (url, body) => {
    const fields = body instanceof FakeForm ? body.fields : body;
    posts.push({ method: url.split("/").pop(), ...fields });
    if (failNext && failNext(url, fields)) {
      failNext = null;
      const e = new Error("Bad Request: message thread not found"); e.response = { status: 400 }; throw e;
    }
    return { data: { ok: true } };
  },
  get: async () => ({ data: {} }),
};
const fakeDb = { query: async () => ({ rows: [], rowCount: 0 }) };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "axios") return fakeAxios;
  if (request === "form-data") return FakeForm;
  if (request === "./db") return fakeDb;
  return origLoad.call(this, request, ...rest);
};

const route = require(path.join(ROOT, "tg-route.js"));
const ops = require(path.join(ROOT, "tg-ops.js"));
const tasks = require(path.join(ROOT, "tasks.js"));
const social = require(path.join(ROOT, "social-resend.js"));

const KEYS = ["TG_OPS_CHAT_ID", "TG_TOPIC_COURT", "TG_TOPIC_SOCIAL", "TG_TOPIC_LEADS", "TG_TOPIC_OPS",
              "TG_TOPIC_STATE", "TG_TOPIC_EOIR", "TG_TOPIC_FEDERAL", "TG_TOPIC_USPTO",
              "JJ_TELEGRAM_ID", "RECIPIENT_JJ_TELEGRAM_ID", "RECIPIENT_JUE_TELEGRAM_ID", "TG_APPROVER_IDS",
              "TELEGRAM_TOKEN", "TELEGRAM_BOT_TOKEN"];
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, { TELEGRAM_TOKEN: "t" }, vars);
  posts.length = 0; failNext = null;
  try { return await fn(); }
  finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const GROUP = { TG_OPS_CHAT_ID: "-1009", TG_TOPIC_COURT: "11", TG_TOPIC_SOCIAL: "12", TG_TOPIC_LEADS: "13", TG_TOPIC_OPS: "14", JJ_TELEGRAM_ID: "555" };
const inGroup = (text, thread, fromId = 777) => ({ text, chat: { id: -1009, type: "supergroup" }, from: { id: fromId }, ...(thread ? { message_thread_id: thread } : {}) });
const inDm = (text, fromId) => ({ text, chat: { id: fromId, type: "private" }, from: { id: fromId } });

const queue = [];
const check = (name, fn) => queue.push([name, fn]);

// ── quiet in the group ──────────────────────────────────────
check("staff chatter in the ops group is not read", () => withEnv(GROUP, () => {
  for (const t of ["can someone call the clerk back?", "TEZ-AB12CD", "/start", "/reset", "/contact", "/deadline Lu brief 8/3", "hi @TEZJJBot", ""]) {
    assert.strictEqual(ops.isOpsChat("-1009") && !ops.allowedInOpsGroup(t), true, JSON.stringify(t));
  }
}));
check("the short list of commands is read there, with or without @botname", () => withEnv(GROUP, () => {
  for (const t of ["/whereami", "/whereami@TEZJJBot", "/chatid", "/routing", "/routing test", "/tasks", "/done 12", "/snooze 12 3", "/newtask call the court"]) {
    assert.strictEqual(ops.allowedInOpsGroup(t), true, t);
  }
}));
check("a private chat, or any other group, is not the ops group", () => withEnv(GROUP, () => {
  assert.strictEqual(ops.isOpsChat("555"), false);
  assert.strictEqual(ops.isOpsChat("-1008"), false);
}));
check("no group configured: nothing is treated as the ops group", () => withEnv({ JJ_TELEGRAM_ID: "555" }, () => {
  assert.strictEqual(ops.isOpsChat("-1009"), false);
  assert.strictEqual(ops.isOpsChat(""), false);
}));

// ── staff commands ──────────────────────────────────────────
check("a stranger messaging the bot cannot use staff commands", () => withEnv(GROUP, () => {
  assert.strictEqual(ops.mayUseStaffCommands({ id: 999 }, "999"), false);
}));
check("JJ and listed approvers can, in a direct message", () => withEnv({ ...GROUP, TG_APPROVER_IDS: " 601 ,602" }, () => {
  assert.strictEqual(ops.mayUseStaffCommands({ id: 555 }, "555"), true);
  assert.strictEqual(ops.mayUseStaffCommands({ id: 602 }, "602"), true);
  assert.strictEqual(ops.mayUseStaffCommands({ id: 603 }, "603"), false);
}));
check("anyone inside the ops group can", () => withEnv(GROUP, () => {
  assert.strictEqual(ops.mayUseStaffCommands({ id: 777 }, "-1009"), true);
}));
check("nothing configured at all: staff commands are closed, not open", () => withEnv({}, () => {
  assert.strictEqual(ops.mayUseStaffCommands({ id: 555 }, "555"), false);
  assert.strictEqual(ops.mayUseStaffCommands(undefined, "555"), false);
}));

// ── answering in the right place ────────────────────────────
check("a command typed in a topic is answered in that topic", () => withEnv(GROUP, () => {
  assert.deepStrictEqual(ops.replyDest(inGroup("/tasks", 14)), { chat_id: "-1009", message_thread_id: 14 });
  assert.strictEqual(ops.replyDest(inGroup("/tasks")), "-1009");
  assert.strictEqual(ops.replyDest(inDm("/tasks", 555)), "555");
}));
check("/tasks in a topic: the task list comes back in that topic", () => withEnv(GROUP, async () => {
  const handled = await tasks.handleTelegramCommand("/tasks", ops.replyDest(inGroup("/tasks", 14)));
  assert.strictEqual(handled, true);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].chat_id, "-1009");
  assert.strictEqual(posts[0].message_thread_id, 14);
}));
check("/tasks in JJ's direct message still answers there", () => withEnv(GROUP, async () => {
  await tasks.handleTelegramCommand("/tasks", "555");
  assert.strictEqual(posts[0].chat_id, "555");
  assert.strictEqual(posts[0].message_thread_id, undefined);
}));

// ── /routing ────────────────────────────────────────────────
check("/routing is refused for a stranger and says nothing about the setup", () => withEnv(GROUP, async () => {
  assert.strictEqual(await ops.handleRouting(inDm("/routing", 999)), true);
  assert.strictEqual(posts.length, 1);
  assert.ok(/restricted/.test(posts[0].text));
  assert.ok(!/-1009/.test(posts[0].text));
}));
check("/routing shows each topic and where it points", () => withEnv({ ...GROUP, TG_TOPIC_SOCIAL: "" }, async () => {
  assert.strictEqual(await ops.handleRouting(inDm("/routing", 555)), true);
  const t = posts[0].text;
  assert.ok(/Court & deadlines: its own topic in the group \(thread 11\)/.test(t), t);
  assert.ok(/Social & content: the group, with no topic\. Set TG_TOPIC_SOCIAL/.test(t), t);
  assert.ok(/Always direct to JJ/.test(t));
}));
check("/routing with no group says alerts still reach JJ", () => withEnv({ JJ_TELEGRAM_ID: "555" }, async () => {
  await ops.handleRouting(inDm("/routing", 555));
  assert.ok(/Court & deadlines: JJ's direct messages, because no group is set/.test(posts[0].text));
  assert.ok(/Group: not set/.test(posts[0].text));
}));
check("/routing test posts one line into each topic, then reports", () => withEnv(GROUP, async () => {
  await ops.handleRouting(inGroup("/routing test", 14));
  // Court & deadlines, its four divisions (no topic of their own here, so they
  // arrive in Court & deadlines and say so), then the other three.
  assert.strictEqual(posts.length, 9);
  assert.deepStrictEqual(posts.slice(0, 8).map(p => p.message_thread_id), [11, 11, 11, 11, 11, 12, 13, 14]);
  assert.ok(posts.slice(0, 8).every(p => p.chat_id === "-1009"));
  assert.ok(/no topic of its own yet/.test(posts[1].text), posts[1].text);
  assert.strictEqual(posts[8].message_thread_id, 14);                    // the report, where it was asked
  assert.strictEqual((posts[8].text.match(/: sent/g) || []).length, 8);
  assert.strictEqual((posts[8].text.match(/its own topic is not set yet/g) || []).length, 4);
}));
check("/routing test reaches each court topic once it has its own thread", () => withEnv(
  { ...GROUP, TG_TOPIC_STATE: "21", TG_TOPIC_EOIR: "22", TG_TOPIC_FEDERAL: "23", TG_TOPIC_USPTO: "24" }, async () => {
  await ops.handleRouting(inGroup("/routing test", 14));
  assert.deepStrictEqual(posts.slice(0, 8).map(p => p.message_thread_id), [11, 21, 22, 23, 24, 12, 13, 14]);
  assert.ok(!/not set yet/.test(posts[8].text), posts[8].text);
}));
check("something that is not /routing is left for the rest of the bot", () => withEnv(GROUP, async () => {
  assert.strictEqual(await ops.handleRouting(inDm("/routingx", 555)), false);
  assert.strictEqual(await ops.handleRouting(inDm("what is the routing number", 555)), false);
  assert.strictEqual(posts.length, 0);
}));

// ── senders that moved ──────────────────────────────────────
check("a task reminder goes to the Ops topic", () => withEnv(GROUP, async () => {
  await tasks.sendSingleTaskReminder({ id: 5, title: "File the brief", due_date: new Date(), priority: "urgent", status: "open" },
    require(path.join(ROOT, "tg-route.js")).target("ops"));
  assert.strictEqual(posts[0].chat_id, "-1009");
  assert.strictEqual(posts[0].message_thread_id, 14);
  assert.ok(posts[0].reply_markup, "the Done / Snooze buttons travel with it");
}));
check("a task reminder still reaches JJ when no group is set", () => withEnv({ JJ_TELEGRAM_ID: "555" }, async () => {
  await tasks.sendCreationReminder({ id: 5, title: "File the brief", due_date: new Date(), priority: "urgent", status: "open" });
  assert.strictEqual(posts[0].chat_id, "555");
  assert.strictEqual(posts[0].message_thread_id, undefined);
}));
check("a deleted Ops topic: the reminder lands in the group, not nowhere", () => withEnv(GROUP, async () => {
  failNext = (url, b) => !!b.message_thread_id;
  await tasks.sendCreationReminder({ id: 5, title: "File the brief", due_date: new Date(), priority: "urgent", status: "open" });
  const sent = posts.filter(p => p.method === "sendMessage");
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].chat_id, "-1009");
  assert.strictEqual(sent[1].message_thread_id, undefined);
}));
check("a social draft and its buttons go to the Social topic", () => withEnv(GROUP, async () => {
  const kb = { inline_keyboard: [[{ text: "Approve", callback_data: "soc_go_1" }]] };
  assert.strictEqual(await social.send("Draft text", kb), true);
  assert.strictEqual(posts[0].message_thread_id, 12);
  assert.deepStrictEqual(posts[0].reply_markup, kb);
}));
check("a social card (photo) goes to the Social topic with its buttons", () => withEnv(GROUP, async () => {
  const kb = { inline_keyboard: [[{ text: "Approve", callback_data: "soc_go_1" }]] };
  assert.strictEqual(await social.sendPhoto(Buffer.from("x"), "caption", kb), true);
  assert.strictEqual(posts[0].method, "sendPhoto");
  assert.strictEqual(posts[0].chat_id, "-1009");
  assert.strictEqual(posts[0].message_thread_id, "12");
  assert.strictEqual(posts[0].reply_markup, JSON.stringify(kb));
}));
check("a photo to a deleted topic is retried in the group", () => withEnv(GROUP, async () => {
  failNext = (url, b) => !!b.message_thread_id;
  assert.strictEqual(await route.sendMedia("social", "photo", Buffer.from("x"), "card.png", "c"), true);
  assert.strictEqual(posts.length, 2);
  assert.strictEqual(posts[1].message_thread_id, undefined);
}));
check("a video goes out as a video, and with no destination nothing is claimed", async () => {
  await withEnv(GROUP, async () => {
    assert.strictEqual(await route.sendMedia("social", "video", Buffer.from("x"), "v.mp4", "c"), true);
    assert.strictEqual(posts[0].method, "sendVideo");
    assert.strictEqual(posts[0].supports_streaming, "true");
  });
  await withEnv({}, async () => {
    assert.strictEqual(await route.sendMedia("social", "photo", Buffer.from("x"), "card.png", "c"), false);
    assert.strictEqual(posts.length, 0);
  });
});
check("social drafts still reach JJ when no group is set", () => withEnv({ JJ_TELEGRAM_ID: "555" }, async () => {
  await social.send("Draft text");
  await social.sendPhoto(Buffer.from("x"), "caption");
  assert.deepStrictEqual(posts.map(p => String(p.chat_id)), ["555", "555"]);
}));

// ── the webhook itself (server.js is too large to load here, so read it) ──
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const handler = server.slice(server.indexOf('app.post("/telegram"'));
const at = s => { const i = handler.indexOf(s); assert.ok(i >= 0, "server.js no longer contains: " + s); return i; };
check("server.js: the group gate runs before anything reads the message", () => {
  const gate = at("if (tgOps.isOpsChat(chatId) && !tgOps.allowedInOpsGroup(textForCmd)) return;");
  for (const later of ["linkTelegram(", "tasks.handleTelegramCommand(", "if (msg.photo)", "if (msg.document)",
                       "if (msg.voice || msg.audio)", 'if (text === "/start")', 'await processMessage("telegram"']) {
    assert.ok(gate < at(later), "the gate must come before " + later);
  }
});
check("server.js: task commands and task buttons check for staff first", () => {
  assert.ok(at("if (!tgOps.mayUseStaffCommands(msg.from, chatId))") < at("tasks.handleTelegramCommand("));
  assert.ok(at("if (!tgOps.mayUseStaffCommands(cb.from, cbChatId))") < at("tasks.handleTelegramCallback("));
});
check("server.js: the deadline summary and trademark alerts follow the court topics", () => {
  assert.strictEqual(server.split('await tgSendTopic(B.topic, text);').length - 1, 2);
  assert.strictEqual(server.split('await tgSendTopic("uspto", text);').length - 1, 1);
  assert.ok(!/tgSend\(String\(JJ_TELEGRAM_ID\)/.test(server), "something still writes to JJ's chat id directly");
});
check("what is private stays private: distress alerts and admin sign-in go to JJ alone", () => {
  const d0 = server.indexOf("async function notifyDistress");
  assert.ok(d0 >= 0, "notifyDistress not found");
  const distress = server.slice(d0, server.indexOf("\n}\n", d0));
  assert.ok(/chat_id: String\(JJ_TELEGRAM_ID\)/.test(distress));
  assert.ok(!/tg-route/.test(distress));
  const admin = fs.readFileSync(path.join(ROOT, "admin.js"), "utf8");
  const a0 = admin.indexOf("async function sendAuthRequest");
  assert.ok(a0 >= 0, "sendAuthRequest not found");
  const auth = admin.slice(a0, admin.indexOf("\n}\n", a0));
  assert.ok(/chat_id: JJ_TELEGRAM_ID/.test(auth));
  assert.ok(!/tg-route/.test(auth));
});

(async () => {
  console.log("\nops group rules\n");
  let passed = 0;
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} of ${queue.length} checks passed\n`);
})();
