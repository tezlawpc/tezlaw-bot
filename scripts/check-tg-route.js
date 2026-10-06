// check-tg-route.js — the routing table, exercised against real logic.
//
// The property that matters is the fallback: no configuration at all, or a
// half-finished one, must still deliver. A notification system's bad failure
// is not noise, it is a court date nobody heard about.

const assert = require("assert");
const path = require("path");
const route = require(path.join(__dirname, "..", "tg-route.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function withEnv(vars, fn) {
  const saved = {};
  const keys = ["TG_OPS_CHAT_ID", "TG_TOPIC_COURT", "TG_TOPIC_SOCIAL",
                "TG_TOPIC_LEADS", "TG_TOPIC_OPS", "JJ_TELEGRAM_ID",
                "RECIPIENT_JJ_TELEGRAM_ID", "TG_TOPIC_STATE", "TG_TOPIC_EOIR",
                "TG_TOPIC_FEDERAL", "TG_TOPIC_USPTO"];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try { fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

console.log("\ntg-route routing table\n");

check("nothing configured at all -> nowhere, and says so", () => {
  withEnv({}, () => assert.strictEqual(route.routeFor("court"), null));
});

check("no group, DM set -> the DM, exactly as before", () => {
  withEnv({ JJ_TELEGRAM_ID: "555" }, () => {
    const r = route.routeFor("court");
    assert.strictEqual(r.chat_id, "555");
    assert.strictEqual(r.via, "dm");
    assert.strictEqual(r.message_thread_id, undefined);
  });
});

check("group set, topic set -> that topic's thread", () => {
  withEnv({ TG_OPS_CHAT_ID: "-1001234", TG_TOPIC_COURT: "12" }, () => {
    const r = route.routeFor("court");
    assert.strictEqual(r.chat_id, "-1001234");
    assert.strictEqual(r.message_thread_id, 12);
    assert.strictEqual(r.via, "topic");
  });
});

check("group set, this topic unset -> the group, not nowhere", () => {
  withEnv({ TG_OPS_CHAT_ID: "-1001234", TG_TOPIC_COURT: "12" }, () => {
    const r = route.routeFor("social");
    assert.strictEqual(r.chat_id, "-1001234");
    assert.strictEqual(r.message_thread_id, undefined);
    assert.strictEqual(r.via, "group");
  });
});

check("a non-numeric topic id is ignored rather than sent", () => {
  withEnv({ TG_OPS_CHAT_ID: "-1001234", TG_TOPIC_OPS: "General" }, () => {
    const r = route.routeFor("ops");
    assert.strictEqual(r.message_thread_id, undefined);
    assert.strictEqual(r.via, "group");
  });
});

check("an unknown topic name still reaches the DM", () => {
  withEnv({ TG_OPS_CHAT_ID: "-1001234", JJ_TELEGRAM_ID: "555" }, () => {
    const r = route.routeFor("nonsense");
    assert.strictEqual(r.chat_id, "555");
    assert.strictEqual(r.via, "dm");
  });
});

check("RECIPIENT_JJ_TELEGRAM_ID is honoured when JJ_TELEGRAM_ID is absent", () => {
  withEnv({ RECIPIENT_JJ_TELEGRAM_ID: "777" }, () => {
    assert.strictEqual(route.routeFor("ops").chat_id, "777");
  });
});

check("whitespace in a pasted env var does not break routing", () => {
  withEnv({ TG_OPS_CHAT_ID: " -1001234 ", TG_TOPIC_LEADS: " 9 " }, () => {
    const r = route.routeFor("leads");
    assert.strictEqual(r.chat_id, "-1001234");
    assert.strictEqual(r.message_thread_id, 9);
  });
});

check("the four topics and the four court divisions are declared", () => {
  assert.deepStrictEqual(Object.keys(route.TOPICS).sort(),
                         ["court", "eoir", "federal", "leads", "ops", "social", "state", "uspto"]);
});

check("describeRouting covers every topic", () => {
  withEnv({ JJ_TELEGRAM_ID: "555" }, () => {
    const rows = route.describeRouting();
    assert.strictEqual(rows.length, 8);
    assert.ok(rows.every(r => r.via === "dm"));
  });
});

console.log(`\n${passed} assertions, all passing.\n`);
