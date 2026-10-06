// e2e-hook.js — preloaded into the server that scripts/e2e.js starts.
//
// Three jobs, so the test server can do nothing outside this machine:
//   1. Telegram: every call is written to a log instead of being sent.
//   2. The model: a scripted stand-in answers, so no key and no cost. It asks
//      for the look-up the question calls for and then repeats the look-up's
//      result, which is what lets the test read exactly what Zara was given.
//   3. Everything else: any connection that is not to this machine is refused
//      at the socket, whichever library asked for it.
const fs = require("fs");
const net = require("net");
const Module = require("module");
const TG_LOG = process.env.E2E_TG_LOG, MODEL_LOG = process.env.E2E_MODEL_LOG, NET_LOG = process.env.E2E_NET_LOG;
const put = (file, obj) => { if (file) { try { fs.appendFileSync(file, JSON.stringify(obj) + "\n"); } catch (_) {} } };

// ── 3. nothing leaves this machine ───────────────────────────────────────
const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", ""]);
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];                       // Node's own normalised form
  let host = "";
  if (first && typeof first === "object") host = first.path ? "" : (first.host || "localhost");
  else if (typeof first === "number") host = typeof args[1] === "string" ? args[1] : "localhost";
  if (!LOCAL.has(String(host).toLowerCase())) {
    put(NET_LOG, { blocked: String(host) });
    const err = new Error("blocked by the test hook: " + host);
    err.code = "EBLOCKED";
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args);
};

// ── 2. the model ─────────────────────────────────────────────────────────
function model(body) {
  const last = body.messages[body.messages.length - 1];
  put(MODEL_LOG, { system: body.system, tools: (body.tools || []).map(t => t.name), messages: body.messages });
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (Array.isArray(last.content) && last.content.some(b => b.type === "tool_result")) {
    const r = last.content.filter(b => b.type === "tool_result").map(b => String(b.content)).join(" || ");
    return { content: [{ type: "text", text: "**From the record**: " + r.slice(0, 1500) + "\nSSN 123-45-6789" }], stop_reason: "end_turn", usage };
  }
  const q = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
  // The group has court_calendar; the app has list_upcoming_hearings. Both read the calendar.
  const cal = (body.tools || []).some(t => t.name === "court_calendar") ? "court_calendar" : "list_upcoming_hearings";
  const call = /trust/i.test(q) ? ["get_client_trust_balance", { client_name: "Lu" }]
             : /update|change/i.test(q) ? ["propose_case_entry", { case_id: 1 }]
             : /sixty/i.test(q) ? [cal, { days: 60 }]
             : /for Lu\b/i.test(q) ? [cal, { client: "Lu" }]
             : /hearings? this week|on the calendar/i.test(q) ? [cal, { days: 7 }]
             : null;
  if (!call) return { content: [{ type: "text", text: "No look-up was needed." }], stop_reason: "end_turn", usage };
  return { content: [{ type: "tool_use", id: "tu_1", name: call[0], input: call[1] }], stop_reason: "tool_use", usage };
}

// ── 1. Telegram, and the model's address ─────────────────────────────────
const origLoad = Module._load;
let wrapped = null;
Module._load = function (request, ...rest) {
  const m = origLoad.call(this, request, ...rest);
  if (request !== "axios") return m;
  if (wrapped) return wrapped;
  const fake = async (url, body) => {
    if (/api\.telegram\.org/.test(String(url))) {
      const fields = body && typeof body.getBuffer === "function" ? { form: true } : body;
      put(TG_LOG, { call: String(url).split("/").pop(), ...(fields || {}) });
      return { data: { ok: true, result: { message_id: 1, username: "TEZJJBot" } }, status: 200 };
    }
    if (/api\.anthropic\.com\/v1\/messages/.test(String(url))) return { data: model(body), status: 200 };
    const e = new Error("blocked by the test hook: " + String(url).slice(0, 80)); e.code = "EBLOCKED"; throw e;
  };
  m.post = (url, body) => fake(url, body);
  m.get = (url) => fake(url);
  wrapped = m;
  return m;
};
