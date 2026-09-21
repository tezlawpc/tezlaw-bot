/**
 * check-case-tools.js
 *
 * Four things JJ found missing or broken on a working case, in one pass:
 *
 *   1. Deadlines could not be deleted, and once marked Done they vanished
 *      with no way back. Now: delete any deadline; an AUTO-generated one
 *      is dismissed rather than deleted, because Regenerate would
 *      otherwise resurrect it; completed ones can be reopened. Every
 *      removal is written to the case history.
 *
 *   2. No time log. Now: time entries, unbilled totals, invoices that
 *      print and export as LEDES. Billed time is frozen until its
 *      invoice is voided; voiding never deletes.
 *
 *   3. The web chat 404'd — covered by check-civil-parity.js, which now
 *      fails if any mirror rule has no twin.
 *
 *   4. "How do I tell Zara what a better answer would have been?" —
 *      Teach Zara under each answer; distilled to one lesson; live at
 *      once when JJ teaches, queued for review when anyone else does.
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
async function throws(name, fn, re) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  check(name, () => (err && re.test(err.message)) || (err ? err.message : "did not throw"));
}

// ── An in-memory database that understands exactly the SQL under test ──
const S = {};
function reset() {
  Object.assign(S, {
    deadlines: [
      { id: 1, case_id: 7, due_date: "2026-10-01", description: "Manual: call client", status: "completed", auto_generated: false },
      { id: 2, case_id: 7, due_date: "2026-11-01", description: "Auto: expert exchange", status: "pending", auto_generated: true, source_trigger: "expert_exchange" },
    ],
    events: [], comms: [], invoices: [], log: [], nextId: 100,
  });
}
reset();

function timeRows() {
  const ev = S.events.filter(e => e.billable_hours != null).map(e => Object.assign({ source: "event", entry_date: e.event_date, narrative: e.description || e.title }, e));
  const cm = S.comms.filter(c => c.billable_hours != null).map(c => Object.assign({ source: "comm", entry_date: c.created_at, narrative: c.subject, event_kind: "communication" }, c));
  return ev.concat(cm).map(r => Object.assign(r, {
    invoice_number: (S.invoices.find(i => i.id === r.invoice_id) || {}).invoice_number || null,
    timekeeper_name: r.attorney_id === 2 ? "JJ Zhang" : null,
  }));
}

const fakeDb = {
  query: async (sql, v = []) => {
    const q = sql.replace(/\s+/g, " ");
    // deadlines
    if (/SELECT \* FROM civil_case_deadlines WHERE id = \$1/.test(q)) return { rows: S.deadlines.filter(d => d.id === v[0]) };
    if (/DELETE FROM civil_case_deadlines WHERE id = \$1/.test(q)) { S.deadlines = S.deadlines.filter(d => d.id !== v[0]); return { rows: [] }; }
    if (/UPDATE civil_case_deadlines SET status = 'dismissed'/.test(q)) {
      S.deadlines.forEach(d => { if (d.id === v[0]) { d.status = "dismissed"; d.completed_by = v[1]; } }); return { rows: [] };
    }
    if (/UPDATE civil_case_deadlines SET status = 'pending'/.test(q)) {
      const d = S.deadlines.find(x => x.id === v[0]); if (d) d.status = "pending"; return { rows: d ? [d] : [] };
    }
    // events
    if (/INSERT INTO civil_case_events/.test(q)) {
      const row = { id: ++S.nextId, case_id: v[0], event_kind: v[1], event_date: v[2], title: v[3], description: v[4],
        billable_hours: v[5], billable_rate: v[6], billable_amount: v[7], attorney_id: v[8], paralegal_id: v[9],
        created_by: v[13], invoice_id: null, no_charge: false };
      if (row.event_kind === "note") S.log.push(row); else S.events.push(row);
      return { rows: [row] };
    }
    if (/UPDATE civil_cases SET updated_at/.test(q)) return { rows: [] };
    if (/UPDATE civil_case_events SET utbms_code = \$2/.test(q)) {
      const e = S.events.find(x => x.id === v[0]);
      Object.assign(e, { utbms_code: v[1], utbms_activity: v[2], no_charge: v[3] });
      if (v[3]) e.billable_amount = 0;
      return { rows: [] };
    }
    if (/SELECT \* FROM civil_case_events WHERE id = \$1/.test(q)) return { rows: S.events.filter(e => e.id === v[0]) };
    if (/SELECT \* FROM civil_case_communications WHERE id = \$1/.test(q)) return { rows: S.comms.filter(e => e.id === v[0]) };
    if (/DELETE FROM civil_case_events WHERE id = \$1/.test(q)) { S.events = S.events.filter(e => e.id !== v[0]); return { rows: [] }; }
    if (/UPDATE civil_case_communications SET billable_hours = NULL/.test(q)) {
      S.comms.forEach(c => { if (c.id === v[0]) c.billable_hours = null; }); return { rows: [] };
    }
    if (/UPDATE civil_case_(events|communications) SET billable_hours = \$2/.test(q)) {
      const e = (/civil_case_events/.test(q) ? S.events : S.comms).find(x => x.id === v[0]);
      Object.assign(e, { billable_hours: v[1], billable_rate: v[2], billable_amount: v[3], no_charge: v[4] });
      return { rows: [e] };
    }
    // time + invoices
    if (/WITH t AS/.test(q)) {
      let rows = timeRows();
      if (/t\.invoice_id IS NULL/.test(q)) rows = rows.filter(r => !r.invoice_id);
      if (/t\.invoice_id IS NOT NULL/.test(q)) rows = rows.filter(r => r.invoice_id);
      return { rows: rows.map(r => Object.assign({}, r)) };
    }
    if (/SELECT COUNT\(\*\)::int AS n FROM civil_invoices/.test(q)) return { rows: [{ n: S.invoices.filter(i => i.case_id === v[0]).length }] };
    if (/INSERT INTO civil_invoices/.test(q)) {
      const inv = { id: ++S.nextId, case_id: v[0], invoice_number: v[1], period_from: v[2], period_to: v[3],
        total_hours: v[4], total_amount: v[5], notes: v[6], created_by: v[7], status: "issued", invoice_date: "2026-09-20" };
      S.invoices.push(inv); return { rows: [inv] };
    }
    if (/UPDATE civil_case_events SET invoice_id = \$1 WHERE id = \$2/.test(q)) { S.events.forEach(e => { if (e.id === v[1] && !e.invoice_id) e.invoice_id = v[0]; }); return { rows: [] }; }
    if (/UPDATE civil_case_communications SET invoice_id = \$1 WHERE id = \$2/.test(q)) { S.comms.forEach(e => { if (e.id === v[1] && !e.invoice_id) e.invoice_id = v[0]; }); return { rows: [] }; }
    if (/SELECT \* FROM civil_invoices WHERE id = \$1/.test(q)) return { rows: S.invoices.filter(i => i.id === v[0]) };
    if (/UPDATE civil_case_events SET invoice_id = NULL WHERE invoice_id = \$1/.test(q)) { S.events.forEach(e => { if (e.invoice_id === v[0]) e.invoice_id = null; }); return { rows: [] }; }
    if (/UPDATE civil_case_communications SET invoice_id = NULL WHERE invoice_id = \$1/.test(q)) { S.comms.forEach(e => { if (e.invoice_id === v[0]) e.invoice_id = null; }); return { rows: [] }; }
    if (/UPDATE civil_invoices SET status = 'void'/.test(q)) {
      const i = S.invoices.find(x => x.id === v[0]); i.status = "void"; i.voided_by = v[1]; return { rows: [i] };
    }
    if (/SELECT \* FROM civil_invoices WHERE case_id = \$1/.test(q)) return { rows: S.invoices.filter(i => i.case_id === v[0]).slice().reverse() };
    if (/SELECT \* FROM civil_cases WHERE id = \$1/.test(q)) return { rows: [{ id: 7, case_name: "Ruiz v. Acme <Corp>", case_number: "25STCV01234", client_key: "ruiz-ana", hourly_rate: 500 }] };
    if (/SELECT client_name FROM tasks/.test(q)) return { rows: [{ client_name: "Ana Ruiz" }] };
    return { rows: [] };   // CREATE TABLE / ALTER TABLE / anything else
  },
};

const orig = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "./civil-billing") return { resolveRate: async () => 550 };
  if (r === "./jurisdictions") return { computeDeadlines: () => ({ deadlines: [], unresolved: [] }) };
  return orig.call(this, r, ...rest);
};
const civil = require("../civil-litigation");
const T = require("../civil-time");
// The hook stays in place: both modules require civil-billing lazily,
// inside the calls under test. Section 4 installs its own.

(async () => {
  console.log("\n── 1. Deadlines ────────────────────────────────");
  let r = await civil.deleteDeadline(1, "jj");
  check("a manual deadline is deleted outright", () => r.mode === "deleted" && !S.deadlines.some(d => d.id === 1));
  check("…even though it was already completed", () => r.deadline.status === "completed");
  check("…and the removal is in the case history", () =>
    S.log.some(l => /Deadline removed: Manual: call client/.test(l.title) && l.created_by === "jj"));

  r = await civil.deleteDeadline(2, "jj");
  check("an AUTO deadline is dismissed, not deleted", () => r.mode === "dismissed" && S.deadlines.find(d => d.id === 2).status === "dismissed");
  check("…and the history says Regenerate will not bring it back", () =>
    S.log.some(l => /Regenerate will not bring it back/.test(l.description || "")));

  const src = fs.readFileSync(path.join(REPO, "civil-litigation.js"), "utf8");
  const upsert = src.slice(src.indexOf("ON CONFLICT (case_id, source_trigger) WHERE auto_generated = TRUE"));
  const doUpdate = upsert.slice(0, upsert.indexOf("`,"));
  check("Regenerate's upsert never touches status — so a dismissal sticks", () => !/status\s*=/.test(doUpdate));
  check("…and its cleanup only removes PENDING auto deadlines", () =>
    /auto_generated = TRUE AND status = 'pending'/.test(src.replace(/\s+/g, " ")));

  const d = await civil.reopenDeadline(2, "jj");
  check("a dismissed or completed deadline can be reopened", () => d.status === "pending");
  await throws("an unknown deadline is refused", () => civil.deleteDeadline(999, "jj"), /not found/);

  console.log("\n── 2. Time & billing ───────────────────────────");
  reset();
  await throws("time with no hours is refused", () => T.logTime(7, { description: "x" }), /hours/);
  await throws("…more than 24 hours in one entry is refused", () => T.logTime(7, { hours: 25, description: "x" }), /24 hours/);
  await throws("…and time with no description, which prints on the invoice", () => T.logTime(7, { hours: 1 }), /Describe/);

  let e1 = await T.logTime(7, { hours: 2.5, description: "Draft opposition", utbms_code: "L210", date: "2026-09-10" }, { by: "jj", userId: 2 });
  check("time is logged as a 'time' event, so every existing report counts it", () => e1.event_kind === "time");
  check("…the person logging is the timekeeper when none is named", () => e1.attorney_id === 2);
  check("…the rate is resolved and the amount computed", () => e1.billable_rate === 550 && e1.billable_amount === 1375);
  check("…UTBMS codes are kept", () => e1.utbms_code === "L210");

  const e2 = await T.logTime(7, { hours: 1, description: "Courtesy call", no_charge: true, date: "2026-09-11" }, { userId: 2 });
  check("no-charge time is recorded at $0", () => e2.no_charge === true && e2.billable_amount === 0);

  S.comms.push({ id: 900, case_id: 7, subject: "Call with client", billable_hours: 0.5, billable_rate: null,
                 billable_amount: null, created_at: "2026-09-12", invoice_id: null, no_charge: false, attorney_id: 2 });

  let list = await T.listTime(7);
  let tot = T.totals(list);
  check("communication time is listed alongside logged time", () => list.length === 3 && list.some(x => x.source === "comm"));
  check("totals: hours include everything", () => tot.hours === 4);
  check("…amount excludes no-charge", () => tot.amount === 1375);
  check("…and time with no rate is counted as unpriced, not as $0", () => tot.unpriced === 1);

  await throws("an invoice is REFUSED while any line has no rate", () => T.createInvoice(7, {}), /no rate/);
  await T.updateTime("comm", 900, { rate: 300 });
  check("editing the rate fixes the amount", () => S.comms[0].billable_rate === 300 && S.comms[0].billable_amount === 150);

  let inv = await T.createInvoice(7, { by: "jj" });
  check("an invoice takes all the unbilled time", () => inv.totals.entries === 3 && inv.total_amount === 1525);
  check("…is numbered per matter", () => inv.invoice_number === "TEZ-7-001");
  check("…and marks every line billed", () => S.events.every(x => x.invoice_id === inv.id) && S.comms[0].invoice_id === inv.id);
  check("…and the case history records it", () => S.log.some(l => /Invoice TEZ-7-001 prepared/.test(l.title)));
  await throws("an empty period cannot be invoiced", () => T.createInvoice(7, {}), /No unbilled time/);

  await throws("BILLED time cannot be edited", () => T.updateTime("event", e1.id, { hours: 9 }), /Void the invoice first/);
  await throws("…or deleted", () => T.deleteTime("event", e1.id), /Void the invoice first/);

  const html = await T.renderInvoiceHtml(inv.id);
  check("the printed invoice has the client and matter", () => /Ana Ruiz/.test(html) && /Case No\. 25STCV01234/.test(html));
  check("…every line", () => /Draft opposition/.test(html) && /Courtesy call/.test(html) && /Call with client/.test(html));
  check("…no-charge work shown as NO CHARGE", () => /NO CHARGE/.test(html));
  check("…the total", () => /\$1,525\.00/.test(html));
  check("…and escapes what it prints", () => /Ruiz v\. Acme &lt;Corp&gt;/.test(html) && !/<Corp>/.test(html));

  const v = await T.voidInvoice(inv.id, { by: "jj" });
  check("voiding marks the invoice void — it is not deleted", () => v.status === "void" && S.invoices.length === 1);
  check("…and returns its time to unbilled", () => S.events.every(x => !x.invoice_id) && !S.comms[0].invoice_id);
  const vhtml = await T.renderInvoiceHtml(inv.id);
  check("a voided invoice prints marked VOID", () => /class="void">VOID/.test(vhtml));

  r = await T.deleteTime("event", e2.id);
  check("unbilled time can be deleted", () => r.mode === "deleted" && !S.events.some(x => x.id === e2.id));
  r = await T.deleteTime("comm", 900);
  check("…removing hours from a call keeps the call itself", () => r.mode === "hours_removed" && S.comms.length === 1);
  await throws("an unknown source is refused", () => T.deleteTime("hearing_notes", 1), /Unknown/);

  console.log("\n── 4. Teaching Zara (the route) ────────────────");
  const lessons = [];
  let reflectResult = null;
  const coreStub = {
    initTables: async () => {},
    reflect: async a => { reflectResult = a; return a.correction.includes("one-off") ? { proposed: false, reason: "Nothing generalisable" }
      : { proposed: true, lesson: { id: 41, lesson: "Always check the local rules before quoting a hearing deadline.", status: "proposed" } }; },
    proposeLesson: async a => { const l = { id: 42, lesson: a.lesson, status: "proposed", source: a.source }; lessons.push(l); return l; },
    approveLesson: async (id, o) => ({ id, lesson: "Always check the local rules before quoting a hearing deadline.", status: "active", approved_by: o.by }),
    retireLesson: async id => ({ id, retired: true }),
  };
  const stub = new Proxy({}, { get: (_t, k) => {
    if (k === "initTables") return async () => {};
    if (k === "DOC_CATEGORIES") return []; if (k === "startScheduler") return () => {};
    if (k === "STAGES") return []; if (k === "STAGE_KEYS") return new Set();
    if (k === "CASE_TYPES" || k === "OUR_ROLES") return [];
    return async () => ({});
  }});
  Module._load = function (r2, ...rest) {
    if (r2 === "./zara-core") return coreStub;
    if (/^\.\/(civil-litigation|civil-discovery|civil-team|civil-billing|civil-dropbox|civil-court-docket|db|push-notifications)$/.test(r2)) return stub;
    return orig.call(this, r2, ...rest);
  };
  delete require.cache[require.resolve("../app-api")];
  const app = express();
  app.use(express.json());
  let asUser = { uid: 1, u: "jj", n: "JJ Zhang", r: "admin" };
  app.use((req, _res, next) => { req.user = asUser; next(); });
  require("../app-api").registerAppApi(app);
  Module._load = orig;
  const server = app.listen(0);
  const port = server.address().port;
  const post = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  }).then(x => x.json().then(j => Object.assign(j, { _status: x.status })));

  let t = await post("/admin/zara/api/teach", {
    question: "When is the CMC statement due?", answer: "30 days before.", better: "Claude says 15 calendar days under CRC 3.725 …",
  });
  check("the web can reach the teach route", () => t._status === 200 && t.ok);
  check("a correction is distilled into one lesson, not stored verbatim", () =>
    t.lesson && t.lesson.lesson.length < 200 && reflectResult && /CRC 3\.725/.test(reflectResult.correction));
  check("…Zara's own answer and the question go with it", () =>
    reflectResult.question === "When is the CMC statement due?" && reflectResult.answer === "30 days before.");
  check("when JJ (admin) teaches, the lesson is LIVE at once", () => t.live === true && t.lesson.status === "active");

  asUser = { uid: 3, u: "jue", n: "Jue Wang", r: "paralegal" };
  t = await post("/admin/zara/api/teach", { question: "q", answer: "a", better: "a better rule for next time" });
  check("when anyone else teaches, it waits for review", () => t.saved && t.live === false);

  t = await post("/admin/zara/api/teach", { question: "q", answer: "a", better: "a one-off fact" });
  check("a one-off fact is not turned into a lesson", () => t.ok && t.saved === false && /Nothing generalisable/.test(t.reason));

  t = await post("/admin/zara/api/teach", { lesson: "Never estimate a filing fee; look it up." });
  check("a rule can be written directly", () => t.saved && lessons.some(l => /filing fee/.test(l.lesson) && l.source === "human"));

  t = await post("/admin/zara/api/teach", {});
  check("an empty correction is refused", () => t._status === 400);

  t = await post("/admin/zara/api/teach/41/undo", {});
  check("only an admin can undo a live lesson", () => t._status === 403);
  asUser = { uid: 1, u: "jj", n: "JJ Zhang", r: "admin" };
  t = await post("/admin/zara/api/teach/41/undo", {});
  check("…JJ can", () => t.ok && t.lesson.retired);
  server.close();

  console.log("\n── 4. Teaching Zara (the chat box) ─────────────");
  const dom = new JSDOM(`<!doctype html><html><body><h1>Ruiz v. Acme</h1><div data-case-id="7"></div></body></html>`,
    { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/case/7" });
  const w = dom.window;
  const calls = [];
  w.fetch = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    let data = { ok: true };
    if (/\/chat$/.test(url)) data = { ok: true, reply: { answer: "The CMC statement is due 30 days before." } };
    if (/\/teach$/.test(url)) data = { ok: true, saved: true, live: true, lesson: { id: 41, lesson: "Check CRC 3.725 for CMC deadlines." } };
    if (/\/undo$/.test(url)) data = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
  };
  w.eval(fs.readFileSync(path.join(REPO, "public", "zara-chat.js"), "utf8"));
  await new Promise(r2 => setTimeout(r2, 20));
  w.ZaraChat.open();
  const ta = [...w.document.querySelectorAll("textarea")][0];
  ta.value = "When is the CMC statement due?";
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  await new Promise(r2 => setTimeout(r2, 30));
  check("the chat posts to the route that now exists", () => calls.some(c => c.url === "/admin/zara/api/chat"));
  const teachLink = [...w.document.querySelectorAll("a")].find(a => /Teach Zara/.test(a.textContent));
  check("every answer has a Teach Zara link", () => !!teachLink);
  teachLink.click();
  const better = [...w.document.querySelectorAll("textarea")]
    .find(x => /better answer/.test(x.getAttribute("placeholder") || ""));
  better.value = "It's 15 calendar days before the CMC — CRC 3.725.";
  const teachBtn = [...w.document.querySelectorAll("button")].find(b => b.textContent === "Teach");
  teachBtn.click();
  await new Promise(r2 => setTimeout(r2, 30));
  const tc = calls.find(c => c.url === "/admin/zara/api/teach");
  check("Teach posts the question, her answer and the better answer", () =>
    tc && tc.body.question === "When is the CMC statement due?" &&
    /30 days before/.test(tc.body.answer) && /CRC 3\.725/.test(tc.body.better));
  check("…and shows the lesson she learned", () => /Learned: “Check CRC 3\.725/.test(w.document.body.textContent));
  const undo = [...w.document.querySelectorAll("a")].find(a => a.textContent === "undo");
  check("…with an undo", () => !!undo);
  undo.click();
  await new Promise(r2 => setTimeout(r2, 30));
  check("undo retires that lesson", () => calls.some(c => c.url === "/admin/zara/api/teach/41/undo"));

  // A failed request gets no Teach link — there is nothing to teach about a 404.
  w.fetch = () => Promise.reject(new Error("HTTP 404"));
  ta.value = "again";
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  await new Promise(r2 => setTimeout(r2, 30));
  const bubbles = [...w.document.querySelectorAll("div")].filter(d2 => /Couldn't reach Zara/.test(d2.textContent) && d2.children.length === 0);
  const after = bubbles.length ? bubbles[bubbles.length - 1].nextSibling : null;
  check("an error message has no Teach link under it", () => !after || !/Teach Zara/.test(after.textContent || ""));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL CASE-TOOLS CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
