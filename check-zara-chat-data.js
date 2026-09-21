/**
 * check-zara-chat-data.js
 *
 * JJ, on matter #223: "yes" → Zara: "Let me pull that together for you."
 * → nothing, for ten minutes.
 *
 * Three things were wrong, and each is pinned here:
 *
 *   1. Staff tools were NEVER enabled. The chat checked user.role, but
 *      every session token carries the role as `r`. So Zara was told she
 *      had tools and was never given any — she could only promise.
 *   2. None of the tools could read a civil matter anyway. Now
 *      get_civil_matter and find_civil_matter can, and on a case page
 *      the matter is pre-loaded so no lookup is needed at all.
 *   3. Nothing stopped her ending a reply with a promise of work to come.
 *      A reply is final: she is now told so, and the widget gives up after
 *      90 seconds with a clear message instead of "thinking" forever.
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { JSDOM } = require("jsdom");
const REPO = path.join(__dirname, "..");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// ── A database holding one matter ───────────────────────────
let hearingsBroken = false;
const fakeDb = {
  query: async (sql, v = []) => {
    const q = sql.replace(/\s+/g, " ");
    if (/SELECT \* FROM civil_cases WHERE id = \$1/.test(q)) {
      return { rows: v[0] === 223 ? [{ id: 223, case_name: "Jing Liu v. James Turco, et al.", case_number: "2:26-cv-01671",
        client_key: "agrc", court: "C.D. Cal.", stage: "pleadings", our_role: "defendant",
        trial_date: "2027-06-01", hourly_rate: 550, internal_notes: "EB-5 investor suit" }] : [] };
    }
    if (/FROM civil_case_deadlines/.test(q)) return { rows: [{ due_date: "2026-10-05", description: "Answer due", priority: "high", auto_generated: false }] };
    if (/FROM civil_hearings/.test(q)) {
      if (hearingsBroken) throw new Error('relation "civil_hearings" does not exist');
      return { rows: [
        { hearing_date: "2026-10-20", hearing_time: "10:00 AM", hearing_type: "Scheduling Conference", status: "scheduled", department: "8D" },
        { hearing_date: "2026-09-01", hearing_type: "Motion hearing", status: "held", ruling: "Motion to dismiss denied in part", notes: "Court skeptical of RICO count" },
      ] };
    }
    if (/WITH t AS/.test(q)) return { rows: [
      { d: "2026-09-18", what: "Draft answer", h: "3.5", amt: "1925", invoice_id: null },
      { d: "2026-08-30", what: "Research", h: "2", amt: "1100", invoice_id: 9 },
    ] };
    if (/FROM civil_invoices/.test(q)) return { rows: [{ invoice_number: "TEZ-223-001", invoice_date: "2026-08-31", total_hours: 2, total_amount: 1100, status: "issued" }] };
    if (/FROM civil_case_events/.test(q)) return { rows: [{ event_date: "2026-09-18", event_kind: "note", title: "Answer drafted" }] };
    if (/FROM civil_cases WHERE case_name ILIKE/.test(q)) return { rows: [{ id: 223, case_name: "Jing Liu v. James Turco, et al.", case_number: "2:26-cv-01671", stage: "pleadings" }] };
    return { rows: [] };
  },
};

const orig = Module._load;
let thinkArgs = null;
Module._load = function (r, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "./zara-core") return {
    think: async a => { thinkArgs = a; return { text: "ok" }; },
    initTables: async () => {},
  };
  return orig.call(this, r, ...rest);
};
const snap = require("../civil-snapshot");
const chatMod = require("../zara-app-chat");

(async () => {
  console.log("\n── 1. Tools are actually switched on ───────────");
  thinkArgs = null;
  await chatMod.chat({ surface: "staff", message: "hi", db: fakeDb, user: { uid: 1, u: "jj", n: "JJ", r: "admin" } });
  check("a session user (role in `r`) gets the staff tools", () => Array.isArray(thinkArgs.tools) && thinkArgs.tools.length > 5);
  check("…and a tool runner", () => typeof thinkArgs.onToolUse === "function");
  await chatMod.chat({ surface: "staff", message: "hi", db: fakeDb, user: { uid: 1, role: "attorney" } });
  check("the older `role` spelling still works", () => Array.isArray(thinkArgs.tools));
  await chatMod.chat({ surface: "staff", message: "hi", db: fakeDb, user: { uid: 9, r: "client" } });
  check("a CLIENT never gets firm tools", () => thinkArgs.tools === null);
  await chatMod.chat({ surface: "staff", message: "hi" });
  check("no user, no tools", () => thinkArgs.tools === null);

  console.log("\n── 2. She can read a civil matter ──────────────");
  await chatMod.chat({ surface: "staff", message: "hi", db: fakeDb, user: { uid: 1, r: "admin" } });
  const names = thinkArgs.tools.map(t => t.name);
  check("get_civil_matter is offered", () => names.includes("get_civil_matter"));
  check("find_civil_matter is offered", () => names.includes("find_civil_matter"));

  const s = await thinkArgs.onToolUse("get_civil_matter", { case_id: 223 });
  check("the snapshot names the matter", () => s.matter && s.matter.case_name === "Jing Liu v. James Turco, et al.");
  check("…its pending deadlines", () => s.pending_deadlines[0].what === "Answer due");
  check("…the upcoming hearing", () => s.hearings.upcoming[0].type === "Scheduling Conference");
  check("…what happened at the last one", () => /denied in part/.test(s.hearings.past[0].ruling) && /RICO/.test(s.hearings.past[0].notes));
  check("…unbilled vs billed time", () => s.time.unbilled.hours === 3.5 && s.time.unbilled.amount === 1925 && s.time.billed.amount === 1100);
  check("…invoices and recent activity", () => s.invoices[0].number === "TEZ-223-001" && s.recent_activity.length === 1);

  hearingsBroken = true;
  const s2 = await snap.snapshot(223);
  hearingsBroken = false;
  check("one broken section does not sink the rest", () => s2.hearings.unavailable && s2.pending_deadlines.length === 1);

  const bad = await thinkArgs.onToolUse("get_civil_matter", { case_id: 999 });
  check("an unknown matter comes back as an error she can report, not a crash", () => /No civil matter #999/.test(bad.error || ""));
  const found = await thinkArgs.onToolUse("find_civil_matter", { query: "Turco" });
  check("find_civil_matter returns ids", () => found.matters[0].id === 223);

  check("the page context's case id is recognised", () =>
    snap.caseIdFromContext("They have civil matter #223 open.") === 223 &&
    snap.caseIdFromContext("URL: /admin/civil/case/223") === 223 &&
    snap.caseIdFromContext("URL: /admin/clients") === null);

  console.log("\n── 3. Every reply is final ─────────────────────");
  check("she is told a reply cannot be followed up", () => /EVERY REPLY IS FINAL/.test(chatMod.STAFF_OPS));
  check("…and the exact phrase that stranded JJ is named", () => /let me pull that together/.test(chatMod.STAFF_OPS));
  check("…and to answer from a pre-loaded snapshot directly", () => /MATTER SNAPSHOT/.test(chatMod.STAFF_OPS));

  console.log("\n── The route pre-loads the matter ──────────────");
  let chatCall = null;
  const stub = new Proxy({}, { get: (_t, k) => {
    if (k === "initTables") return async () => {};
    if (k === "DOC_CATEGORIES") return []; if (k === "startScheduler") return () => {};
    if (k === "STAGES") return []; if (k === "STAGE_KEYS") return new Set();
    if (k === "CASE_TYPES" || k === "OUR_ROLES") return [];
    return async () => ({});
  }});
  Module._load = function (r, ...rest) {
    if (r === "./db") return fakeDb;
    if (r === "./zara-app-chat") return { chat: async a => { chatCall = a; return "answer"; }, STAFF_OPS: "ops" };
    if (r === "./civil-snapshot") return snap;
    if (/^\.\/(civil-litigation|civil-discovery|civil-team|civil-billing|civil-dropbox|civil-court-docket|push-notifications|zara-core)$/.test(r)) return stub;
    return orig.call(this, r, ...rest);
  };
  delete require.cache[require.resolve("../app-api")];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { uid: 1, u: "jj", n: "JJ Zhang", r: "admin" }; next(); });
  require("../app-api").registerAppApi(app);
  const server = app.listen(0);
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/admin/zara/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json());

  let res = await post({ message: "status?", context: "The user is on the page: Jing Liu v. James Turco\nThey have civil matter #223 open." });
  check("the web chat route answers", () => res.ok && res.reply.answer === "answer");
  check("on a case page the matter is handed to her up front", () =>
    /MATTER SNAPSHOT \(civil matter #223/.test(chatCall.context) && /Answer due/.test(chatCall.context) && /Scheduling Conference/.test(chatCall.context));
  check("…with the logged-in user, so her tools are enabled", () => chatCall.user && chatCall.user.r === "admin" && !!chatCall.db);

  res = await post({ message: "hello", context: "URL: /admin/clients" });
  check("off a case page, nothing is pre-loaded", () => !/MATTER SNAPSHOT/.test(chatCall.context));

  res = await post({ message: "hello", context: "They have civil matter #999 open." });
  check("a matter that cannot be loaded still gets an answer", () => res.ok && !/MATTER SNAPSHOT/.test(chatCall.context));
  server.close();

  console.log("\n── The widget never waits forever ──────────────");
  const js = fs.readFileSync(path.join(REPO, "public", "zara-chat.js"), "utf8");
  check("the request is aborted after 90 seconds", () => /setTimeout\(function \(\) \{ if \(ctrl\) ctrl\.abort\(\); \}, 90000\)/.test(js));
  const dom = new JSDOM(`<!doctype html><html><body><h1>x</h1></body></html>`, { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/case/223" });
  const w = dom.window;
  w.fetch = () => { const e = new Error("aborted"); e.name = "AbortError"; return Promise.reject(e); };
  w.eval(js);
  await new Promise(r => setTimeout(r, 20));
  w.ZaraChat.open();
  const ta = w.document.querySelector("textarea");
  ta.value = "status?";
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  await new Promise(r => setTimeout(r, 30));
  check("a timed-out request says so plainly", () => /more than 90 seconds/.test(w.document.body.textContent));
  check("…and is not left on \"thinking\"", () => !/Zara is thinking/.test(w.document.body.textContent));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL ZARA-CHAT-DATA CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
