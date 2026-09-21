/**
 * check-zara-empty-answer.js
 *
 * JJ asked Zara a legal-strategy question on a client's file and got
 * "(no response)".
 *
 * With her tools switched on (build 47), a strategy question makes her
 * write her analysis AND look something up in the same turn. The text she
 * wrote before the lookup was thrown away; only the final round's text was
 * kept. When the final round came back empty, because she had already
 * said everything, the answer vanished.
 *
 * Pinned here, against the real zara-core with the API faked:
 *   · text written alongside a tool call is kept
 *   · an empty final answer gets ONE plain-text nudge, tools off
 *   · an answer cut off at the length limit says so
 *   · staff answers get room for a real analysis (4000 tokens, 150s)
 *   · nothing ever surfaces as a bare "(no response)"
 */
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.OPENAI_API_KEY;

const Module = require("module");
let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// Each scenario is a script of API responses, played in order.
let script = [];
const bodies = [];
const fakeAxios = {
  post: async (url, body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const next = script.shift();
    if (!next) throw new Error("unexpected extra API call");
    return { data: next };
  },
};
const thoughts = [];
const fakeDb = {
  query: async (sql, v) => {
    if (/INSERT INTO zara_thoughts/.test(sql)) thoughts.push({ error: v[8] });
    return { rows: [] };
  },
};

const orig = Module._load;
Module._load = function (r, ...rest) {
  if (r === "axios") return fakeAxios;
  if (r === "./db") return fakeDb;
  return orig.call(this, r, ...rest);
};
const core = require("../zara-core");
const chatMod = require("../zara-app-chat");

const text = (t, stop = "end_turn") => ({ content: [{ type: "text", text: t }], stop_reason: stop, usage: {} });
const toolCall = (pre) => ({
  content: [].concat(pre ? [{ type: "text", text: pre }] : [],
    [{ type: "tool_use", id: "tu1", name: "get_client_notes", input: { client: "agrc" } }]),
  stop_reason: "tool_use", usage: {},
});
const empty = () => ({ content: [], stop_reason: "end_turn", usage: {} });
const tools = [{ name: "get_client_notes", input_schema: { type: "object", properties: {} } }];
const onToolUse = async () => ({ notes: "Client wants to settle before depositions." });

(async () => {
  console.log("\n── The bug: analysis written before a lookup ───");
  script = [toolCall("Three angles on the motion to dismiss: standing, the RICO pleading, and the statute."), empty()];
  bodies.length = 0;
  let out = await core.think({ surface: "staff", message: "What's our strategy?", tools, onToolUse });
  check("the analysis written alongside the lookup is returned", () => /Three angles/.test(out.text));
  check("…without spending an extra call to get it", () => bodies.length === 2);

  console.log("\n── Nothing at all: one nudge ───────────────────");
  script = [toolCall(null), empty(), text("Here is the strategy: move to compel arbitration first.")];
  bodies.length = 0;
  out = await core.think({ surface: "staff", message: "What's our strategy?", tools, onToolUse });
  check("an empty final answer is followed by one nudge", () => bodies.length === 3);
  check("…which gets the answer", () => /compel arbitration/.test(out.text));
  const nudgeBody = bodies[2];
  check("…with tools turned off for that call", () => nudgeBody.tool_choice && nudgeBody.tool_choice.type === "none");
  const lastTurn = nudgeBody.messages[nudgeBody.messages.length - 1];
  check("…added to the last user turn, so the conversation still alternates", () =>
    lastTurn.role === "user" && Array.isArray(lastTurn.content) &&
    lastTurn.content.some(b => b.type === "tool_result") &&
    lastTurn.content.some(b => b.type === "text" && /full answer now/.test(b.text)));
  const roles = nudgeBody.messages.map(m => m.role);
  check("…no two turns from the same side in a row", () => roles.every((r, i) => i === 0 || r !== roles[i - 1]) || roles.join(","));

  script = [empty(), text("Answer after nudge.")];
  bodies.length = 0;
  out = await core.think({ surface: "staff", message: "Strategy?" });
  check("the nudge works without tools too", () => out.text === "Answer after nudge." && bodies.length === 2);
  check("…appended to the user's own message", () =>
    /Strategy\?\n\nPlease give your full answer now/.test(bodies[1].messages[bodies[1].messages.length - 1].content));

  script = [empty(), empty()];
  thoughts.length = 0;
  out = await core.think({ surface: "staff", message: "Strategy?" });
  check("it nudges only once — no loop", () => out.text === "");
  check("…and records the empty answer in model health", () => thoughts.some(t => /empty answer/.test(t.error || "")));

  console.log("\n── Cut off at the length limit ─────────────────");
  script = [text("First, the standing argument… and second,", "max_tokens")];
  out = await core.think({ surface: "staff", message: "Strategy?" });
  check("a truncated answer says it was cut off", () => /Cut off at the length limit/.test(out.text) && /continue/.test(out.text));

  console.log("\n── The staff chat ──────────────────────────────");
  script = [text("ok")];
  bodies.length = 0;
  await chatMod.chat({ surface: "staff", message: "Strategy?", db: fakeDb, user: { uid: 1, r: "admin" } });
  check("staff answers get room for a real analysis", () => bodies[0].max_tokens === 4000);
  script = [text("ok")];
  bodies.length = 0;
  await chatMod.chat({ surface: "client", message: "When is my hearing?" });
  check("client answers stay short", () => bodies[0].max_tokens === 1500);

  script = [empty(), empty()];
  const reply = await chatMod.chat({ surface: "staff", message: "Strategy?" });
  check("a genuinely empty result never shows as \"(no response)\"", () => reply !== "(no response)" && /try asking again/.test(reply));

  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "zara-app-chat.js"), "utf8");
  check("staff calls allow 150 seconds for a long answer", () => /timeout: surface === "staff" \? 150000/.test(src));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL ZARA-EMPTY-ANSWER CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
