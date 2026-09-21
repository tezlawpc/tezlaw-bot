/**
 * check-zara-actions.js
 *
 * JJ: "can we give zara the tool to update the file, upload documents and
 * analyze the file and update the case folder? … we are no longer going to
 * sync with mycase."
 *
 * Zara said she had "read-only tools" and told him to edit the matter in
 * MyCase. Now:
 *   · she can list and READ the documents in a matter's Dropbox folder
 *   · she can PROPOSE changes: case details, notes, deadlines, hearings,
 *     and a Word memo for the case folder
 *   · nothing is written until a person presses Apply on the card
 *   · Apply cannot run twice, will not overwrite an edit made since the
 *     proposal, and a failure leaves the proposal ready to retry
 *   · documents attached in the chat are filed to the case folder and read
 *   · MyCase is gone: Zara is told so, and the paralegal calendars
 *     deadlines on the civil matter instead of creating MyCase tasks
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
async function checkA(name, fn) {
  let ok = false, detail = "";
  try { const r = await fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// ── A small database ─────────────────────────────────────────
const matter = {
  id: 223, case_name: "Jing Liu v. James Turco, et al.", case_number: null, court: "C.D. Cal.",
  service_date: null, trial_date: null, hourly_rate: 550, jurisdiction: "federal",
};
const proposals = [];
const files = [
  { id: 71, case_id: 223, name: "Complaint.pdf", path_display: "/Cases/Liu/Pleadings/Complaint.pdf", category: "pleadings" },
  { id: 99, case_id: 500, name: "Other.pdf", path_display: "/Cases/Other/Other.pdf", category: "pleadings" },
];
const fakeDb = {
  query: async (sql, v = []) => {
    const q = sql.replace(/\s+/g, " ");
    if (/CREATE TABLE/.test(q)) return { rows: [] };
    if (/SELECT \* FROM civil_cases WHERE id = \$1/.test(q)) return { rows: v[0] === 223 ? [{ ...matter }] : [] };
    if (/INSERT INTO zara_proposals/.test(q)) {
      const p = { id: proposals.length + 1, kind: v[0], case_id: v[1], payload: JSON.parse(v[2]), summary: v[3],
        lines: JSON.parse(v[4]), reason: v[5], requested_by: v[6], status: "pending", created_at: new Date() };
      proposals.push(p);
      return { rows: [p] };
    }
    if (/SELECT \* FROM zara_proposals WHERE id = \$1/.test(q)) return { rows: proposals.filter(p => p.id === v[0]).map(p => ({ ...p })) };
    if (/SET status = 'applying' WHERE id = \$1 AND status = 'pending'/.test(q)) {
      const p = proposals.find(x => x.id === v[0] && x.status === "pending");
      if (p) p.status = "applying";
      return { rows: p ? [{ id: p.id }] : [] };
    }
    if (/UPDATE zara_proposals SET status = 'pending', error/.test(q)) { const p = proposals.find(x => x.id === v[0]); p.status = "pending"; p.error = v[1]; return { rows: [] }; }
    if (/UPDATE zara_proposals SET status = 'applied'/.test(q)) { const p = proposals.find(x => x.id === v[0]); p.status = "applied"; p.decided_by = v[1]; return { rows: [] }; }
    if (/UPDATE zara_proposals SET status = 'discarded'/.test(q)) { const p = proposals.find(x => x.id === v[0]); p.status = "discarded"; return { rows: [] }; }
    if (/UPDATE zara_proposals SET status = 'expired'/.test(q)) { const p = proposals.find(x => x.id === v[0]); p.status = "expired"; return { rows: [] }; }
    if (/FROM civil_case_files WHERE id = \$1/.test(q)) return { rows: files.filter(f => f.id === v[0]) };
    return { rows: [] };
  },
};

const calls = { updateCase: [], events: [], deadlines: [], hearings: [], uploads: [] };
let updateFails = false;
const fakeCivil = {
  updateCase: async (id, patch) => {
    if (updateFails) throw new Error("database is down");
    calls.updateCase.push({ id, patch }); Object.assign(matter, patch); return matter;
  },
  logEvent: async (id, e) => { calls.events.push({ id, ...e }); return { id: 1 }; },
  addManualDeadline: async (id, d) => { calls.deadlines.push({ id, ...d }); return { id: 5, ...d }; },
  listDeadlines: async () => [{ due_date: "2026-10-05", description: "Answer due" }],
};
const fakeHearings = { addHearing: async (id, h, o) => { calls.hearings.push({ id, h, o }); return { id: 8 }; } };
const fakeUpload = {
  uploadToCase: async (id, fs2, o) => {
    calls.uploads.push({ id, files: fs2, o });
    return { ok: true, uploaded: fs2.map(f => ({ name: f.originalname, saved_as: f.originalname, folder_label: "Research", path: "/x/" + f.originalname })), failed: [] };
  },
  safeFileName: n => String(n),
};
const fakeDropbox = {
  listCaseFiles: async id => files.filter(f => f.case_id === id).map(f => ({ ...f, relative_folder: "Pleadings", server_modified: "2026-09-01T00:00:00Z" })),
  fileLink: async () => "https://dl.example/complaint",
};
let extracted = "COMPLAINT for breach of fiduciary duty. Plaintiff Jing Liu invested $500,000.";
const fakeExtract = { textFromBuffer: async () => extracted };
const fakeAxios = { get: async () => ({ data: Buffer.from("pdf") }), post: async () => ({ data: {} }) };

const orig = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "./civil-litigation") return fakeCivil;
  if (r === "./civil-hearings") return fakeHearings;
  if (r === "./civil-upload") return fakeUpload;
  if (r === "./civil-dropbox") return fakeDropbox;
  if (r === "./civil-intake-extract") return fakeExtract;
  if (r === "axios") return fakeAxios;
  return orig.call(this, r, ...rest);
};
const actions = require("../zara-actions");
const tools = require("../zara-case-tools");
const chatMod = require("../zara-app-chat");

(async () => {
  console.log("\n── She can read the case folder ────────────────");
  const names = chatMod.STAFF_TOOLS.map(t => t.name);
  check("staff Zara has the case-folder and proposal tools", () =>
    ["list_case_documents", "read_case_document", "propose_matter_update", "propose_case_entry", "propose_memo"].every(n => names.includes(n)));
  let r = await tools.run("list_case_documents", { case_id: 223 });
  check("list_case_documents lists this matter's documents with ids", () => r.count === 1 && r.documents[0].file_id === 71 && r.documents[0].name === "Complaint.pdf");
  r = await tools.run("read_case_document", { case_id: 223, file_id: 71 });
  check("read_case_document returns the document's text", () => /breach of fiduciary duty/.test(r.text) && r.name === "Complaint.pdf");
  r = await tools.run("read_case_document", { case_id: 223, file_id: 99 });
  check("…but never another matter's document", () => /different matter/.test(r.error || ""));
  extracted = "";
  r = await tools.run("read_case_document", { case_id: 223, file_id: 71 });
  check("…and says plainly when a scan has no text", () => /without OCR/.test(r.error || ""));
  extracted = "x".repeat(50000);
  r = await tools.run("read_case_document", { case_id: 223, file_id: 71 });
  check("…and a very long document is cut to size and flagged", () => r.truncated === true && r.text.length === tools.MAX_DOC_CHARS);

  console.log("\n── She proposes; nothing is written ────────────");
  const sink = [];
  const user = { uid: 1, u: "jj", r: "admin" };
  r = await tools.run("propose_matter_update", {
    case_id: 223, changes: { case_number: "2:26-cv-01671", service_date: "2026-09-02", court: "C.D. Cal.", hourly_rate: "$600", made_up: "x" },
    reason: "From the summons",
  }, { user, sink });
  check("a proposal comes back as NOT SAVED", () => r.proposed && /NOT SAVED/.test(r.status));
  check("…and shows up as a card for the chat", () => sink.length === 1 && sink[0].id === r.proposal_id);
  check("…listing each change from → to", () =>
    sink[0].lines.some(l => /Case number: \(blank\) → 2:26-cv-01671/.test(l)) &&
    sink[0].lines.some(l => /Service date: \(blank\) → 2026-09-02/.test(l)) &&
    sink[0].lines.some(l => /Hourly rate: 550 → 600/.test(l)));
  check("…leaving out what is already right", () => !sink[0].lines.some(l => /^Court/.test(l)));
  check("…warning that dates recalculate the automatic deadlines", () => sink[0].lines.some(l => /recalculates the automatic deadlines/.test(l)));
  check("…and saying what it could not change", () => r.not_applied && r.not_applied.includes("made_up"));
  check("NOTHING was written to the matter", () => calls.updateCase.length === 0 && matter.case_number === null);

  r = await tools.run("propose_matter_update", { case_id: 223, changes: { trial_date: "sometime next year" } }, { user, sink });
  check("a date that is not a date is refused, not guessed", () => /Nothing to change/.test(r.error || "") && /not a date/.test(r.error));

  const d = await tools.run("propose_case_entry", { case_id: 223, type: "deadline", date: "2026-09-23",
    description: "Answer or respond to complaint", rule: "FRCP 12(a)(1)(A)(i)", priority: "high" }, { user, sink });
  const hr = await tools.run("propose_case_entry", { case_id: 223, type: "hearing", date: "2026-11-02", time: "8:30 AM",
    hearing_type: "Scheduling Conference", department: "8D" }, { user, sink });
  const n = await tools.run("propose_case_entry", { case_id: 223, type: "note", title: "Full picture from JJ", description: "Client served 9/2 by personal service." }, { user, sink });
  const bad = await tools.run("propose_case_entry", { case_id: 223, type: "deadline", description: "no date" }, { user, sink });
  check("deadline, hearing and note proposals work", () => d.proposed && hr.proposed && n.proposed);
  check("…a deadline without a date is refused", () => /real due date/.test(bad.error || ""));
  const memo = await tools.run("propose_memo", { case_id: 223, title: "Memo - MTD Analysis",
    content: "# Issues\n\nStanding is the strongest ground.\n\n**Recommendation:** move to dismiss." }, { user, sink });
  check("a memo proposal names the file it will create", () => memo.proposed && /Memo - MTD Analysis\.docx/.test(memo.lines[0]));
  check("still nothing written, no deadline, no hearing, no upload", () =>
    !calls.updateCase.length && !calls.deadlines.length && !calls.hearings.length && !calls.uploads.length);
  r = await tools.run("propose_case_entry", { type: "note", title: "x" }, { user, sink });
  check("a proposal with no matter id asks for one", () => /case_id is required/.test(r.error));

  console.log("\n── Apply ───────────────────────────────────────");
  const upd = proposals[0];
  matter.court = "C.D. Cal.";
  matter.hourly_rate = 575;          // someone changed the rate by hand after Zara looked
  let out = await actions.applyProposal(upd.id, { by: "jj" });
  check("Apply writes the matter", () => calls.updateCase.length === 1 && matter.case_number === "2:26-cv-01671" && matter.service_date === "2026-09-02");
  check("…but never overwrites an edit made since the proposal", () =>
    !("hourly_rate" in calls.updateCase[0].patch) && matter.hourly_rate === 575 && out.result.skipped_changed_since.some(s => /Hourly rate/.test(s)));
  check("…and records who approved it in the case history", () =>
    calls.events.some(e => /proposed by Zara/.test(e.title) && /Approved by jj/.test(e.description)));
  await checkA("Apply twice does nothing the second time", async () => {
    try { await actions.applyProposal(upd.id, { by: "jj" }); return "applied twice"; }
    catch (e) { return /already applied/.test(e.message) && calls.updateCase.length === 1 || e.message; }
  });

  const dl = proposals.find(p => p.kind === "add_deadline");
  await actions.applyProposal(dl.id, { by: "jj" });
  check("a deadline goes onto the matter with its rule and priority", () =>
    calls.deadlines[0].due_date === "2026-09-23" && calls.deadlines[0].ccp_rule === "FRCP 12(a)(1)(A)(i)" && calls.deadlines[0].priority === "high");
  const hp = proposals.find(p => p.kind === "add_hearing");
  await actions.applyProposal(hp.id, { by: "jj" });
  check("a hearing goes onto the matter", () => calls.hearings[0].h.hearing_date === "2026-11-02" && calls.hearings[0].h.department === "8D");
  const mp = proposals.find(p => p.kind === "save_memo");
  out = await actions.applyProposal(mp.id, { by: "jj" });
  check("a memo is uploaded into the case's Dropbox folder as .docx", () =>
    calls.uploads.length === 1 && calls.uploads[0].id === 223 && calls.uploads[0].files[0].originalname === "Memo - MTD Analysis.docx");
  const docx = calls.uploads[0].files[0].buffer;
  const mammoth = require("mammoth");
  const readBack = (await mammoth.extractRawText({ buffer: docx })).value;
  check("…and it is a real Word document with the memo in it", () =>
    /Memo - MTD Analysis/.test(readBack) && /Standing is the strongest ground/.test(readBack) && /Recommendation: move to dismiss/.test(readBack));

  // A failure leaves it ready to retry.
  const np = proposals.find(p => p.kind === "add_note");
  const again = await tools.run("propose_matter_update", { case_id: 223, changes: { county: "Los Angeles" } }, { user, sink });
  updateFails = true;
  await checkA("a failed Apply says why", async () => {
    try { await actions.applyProposal(again.proposal_id, { by: "jj" }); return "did not fail"; }
    catch (e) { return /database is down/.test(e.message) || e.message; }
  });
  check("…and leaves the proposal pending, so Apply can be pressed again", () => proposals.find(p => p.id === again.proposal_id).status === "pending");
  updateFails = false;
  await actions.applyProposal(again.proposal_id, { by: "jj" });
  check("…which then works", () => matter.county === "Los Angeles");

  await actions.discardProposal(np.id, { by: "jj" });
  check("Discard throws a proposal away", () => proposals.find(p => p.id === np.id).status === "discarded");
  await checkA("…and it can no longer be applied", async () => {
    try { await actions.applyProposal(np.id, { by: "jj" }); return "applied"; }
    catch (e) { return /already discarded/.test(e.message) || e.message; }
  });

  const old = await tools.run("propose_case_entry", { case_id: 223, type: "note", title: "old" }, { user, sink });
  proposals.find(p => p.id === old.proposal_id).created_at = new Date(Date.now() - 8 * 86400000);
  await checkA("a proposal more than a week old must be asked for again", async () => {
    try { await actions.applyProposal(old.proposal_id, { by: "jj" }); return "applied"; }
    catch (e) { return /more than a week old/.test(e.message) || e.message; }
  });

  console.log("\n── What Zara is told ───────────────────────────");
  check("she proposes and the user applies", () => /propose_matter_update/.test(chatMod.STAFF_OPS) && /Apply/.test(chatMod.STAFF_OPS));
  check("…and never claims a change is saved", () => /never say a change is saved/.test(chatMod.STAFF_OPS));
  check("…and proposes EVERY change from new facts, in the same reply", () => /propose every change in THIS reply/.test(chatMod.STAFF_OPS));
  check("the firm does not use MyCase — she is told so", () => /does not use MyCase/.test(chatMod.STAFF_OPS) && /Never tell the user to update something "in MyCase"/.test(chatMod.STAFF_OPS));

  console.log("\n── The routes ──────────────────────────────────");
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
    if (r === "./zara-app-chat") return {
      chat: async a => { chatCall = a; a.proposals.push({ id: 42, summary: "Update 1 field", lines: ["Case number: (blank) → 1"] }); return "Review and press Apply."; },
      STAFF_OPS: "ops",
    };
    if (r === "./civil-snapshot") return { caseIdFromContext: () => null, snapshot: async () => ({}) };
    if (r === "./civil-upload") return fakeUpload;
    if (r === "./civil-intake-extract") return fakeExtract;
    if (r === "./zara-actions") return actions;
    if (/^\.\/(civil-litigation|civil-discovery|civil-team|civil-billing|civil-dropbox|civil-court-docket|push-notifications|zara-core)$/.test(r)) return stub;
    return orig.call(this, r, ...rest);
  };
  delete require.cache[require.resolve("../app-api")];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { uid: 1, u: "jj", n: "JJ Zhang", r: "admin" }; next(); });
  require("../app-api").registerAppApi(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })
    .then(r => r.json());

  extracted = "SUMMONS. You have 21 days after service.";
  let res = await post("/admin/zara/api/chat", { message: "update the file", context: "x",
    attachments: [{ name: "Summons.pdf", text: extracted, filed_to: "Pleadings as Summons.pdf" }] });
  check("the chat returns Zara's proposals with her answer", () => res.ok && res.reply.proposals[0].id === 42 && /Apply/.test(res.reply.answer));
  check("…and attached documents reach her, with where they were filed", () =>
    /ATTACHED DOCUMENTS/.test(chatCall.context) && /Summons\.pdf \(filed to Pleadings as Summons\.pdf\)/.test(chatCall.context) && /21 days after service/.test(chatCall.context));

  const p2 = await tools.run("propose_case_entry", { case_id: 223, type: "note", title: "via route" }, { user, sink });
  res = await post(`/admin/zara/api/proposals/${p2.proposal_id}/apply`);
  check("the web Apply button's route applies it", () => res.ok && proposals.find(p => p.id === p2.proposal_id).status === "applied");
  res = await post(`/admin/zara/api/proposals/${p2.proposal_id}/apply`);
  check("…and a second press is refused, not repeated", () => res.ok === false && /already applied/.test(res.error));
  const p3 = await tools.run("propose_case_entry", { case_id: 223, type: "note", title: "discard me" }, { user, sink });
  res = await post(`/admin/zara/api/proposals/${p3.proposal_id}/discard`);
  check("the web Discard button's route discards it", () => res.ok && proposals.find(p => p.id === p3.proposal_id).status === "discarded");
  const appStatus = await fetch(base + `/api/staff/zara/proposals/${p3.proposal_id}/discard`, { method: "POST" }).then(r => r.status);
  check("…and the app has the same routes (behind its own token login)", () => appStatus !== 404 || "404");

  calls.uploads.length = 0;
  const fd = new FormData();
  fd.append("files", new Blob([Buffer.from("%PDF")]), "Summons.pdf");
  fd.append("case_id", "223");
  res = await fetch(base + "/admin/zara/api/attach", { method: "POST", body: fd }).then(r => r.json());
  check("a document attached on a case page is filed to that matter's folder", () =>
    res.ok && calls.uploads.length === 1 && calls.uploads[0].id === 223 && /via Zara chat/.test(calls.uploads[0].o.by));
  check("…and its text comes back for Zara, with where it went", () =>
    /21 days after service/.test(res.docs[0].text) && /Research as Summons\.pdf/.test(res.docs[0].filed_to));
  const fd2 = new FormData();
  fd2.append("files", new Blob([Buffer.from("%PDF")]), "Lease.pdf");
  res = await fetch(base + "/admin/zara/api/attach", { method: "POST", body: fd2 }).then(r => r.json());
  check("off a case page it is read but not filed anywhere", () => res.ok && calls.uploads.length === 1 && res.docs[0].text && !res.docs[0].filed_to);
  server.close();

  console.log("\n── The chat widget ─────────────────────────────");
  const js = fs.readFileSync(path.join(REPO, "public", "zara-chat.js"), "utf8");
  const dom = new JSDOM(`<!doctype html><html><body><h1>Liu v. Turco</h1><div data-case-id="223"></div></body></html>`,
    { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/case/223" });
  const w = dom.window;
  const posted = [];
  w.fetch = (url, opts) => {
    posted.push({ url, body: opts && opts.body });
    if (/\/chat$/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true, reply: {
      answer: "Here is what I would change. Review and press Apply.",
      proposals: [
        { id: 5, summary: "Update 2 fields on Jing Liu v. James Turco", lines: ["Case number: (blank) → 2:26-cv-01671", "Service date: (blank) → 2026-09-02"], reason: "From the summons" },
        { id: 6, summary: "Add a deadline", lines: ["2026-09-23 — Answer due"] },
      ] } }) });
    if (/\/proposals\/5\/apply$/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true, result: { applied: ["case_number"] } }) });
    if (/\/proposals\/6\/discard$/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true, status: "discarded" }) });
    if (/\/attach$/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true, docs: [{ name: "Summons.pdf", text: "SUMMONS…", filed_to: "Pleadings as Summons.pdf" }], filed: { ok: true } }) });
    return Promise.resolve({ json: () => Promise.resolve({ ok: false, error: "unexpected " + url }) });
  };
  w.eval(js);
  await new Promise(r => setTimeout(r, 20));
  w.ZaraChat.open();
  const doc = w.document;
  check("there is a 📎 attach button", () => [...doc.querySelectorAll("button")].some(b => b.textContent === "📎"));
  w.ZaraChat.attach([new w.File(["x"], "Summons.pdf")]);
  await new Promise(r => setTimeout(r, 30));
  check("an attachment shows where it was filed", () => /Summons\.pdf → Pleadings as Summons\.pdf/.test(doc.body.textContent));
  check("…and was sent with this case's id", () => { const b = posted.find(p => /attach$/.test(p.url)).body; return b.get("case_id") === "223"; });

  const ta = doc.querySelector("textarea");
  ta.value = "now you have the full picture, update the file";
  ta.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter" }));
  await new Promise(r => setTimeout(r, 30));
  const chatBody = JSON.parse(posted.find(p => /\/chat$/.test(p.url)).body);
  check("the attachment's text goes with the question", () => chatBody.attachments.length === 1 && chatBody.attachments[0].text === "SUMMONS…");
  check("each proposal is a card with Apply and Discard", () =>
    doc.querySelectorAll("[data-zara-proposal]").length === 2 && !!doc.querySelector('[data-zara-apply="5"]') && !!doc.querySelector('[data-zara-discard="5"]'));
  check("…showing the changes", () => /Service date: \(blank\) → 2026-09-02/.test(doc.body.textContent));
  check("…with an Apply-all for several", () => [...doc.querySelectorAll("button")].some(b => /Apply all 2/.test(b.textContent)));
  doc.querySelector('[data-zara-apply="5"]').click();
  await new Promise(r => setTimeout(r, 30));
  check("Apply posts to the apply route and shows it applied", () =>
    posted.some(p => /\/admin\/zara\/api\/proposals\/5\/apply$/.test(p.url)) && /✓ Applied/.test(doc.querySelector('[data-zara-proposal="5"]').textContent));
  check("…with no Apply button left on it", () => !doc.querySelector('[data-zara-apply="5"]'));
  doc.querySelector('[data-zara-discard="6"]').click();
  await new Promise(r => setTimeout(r, 30));
  check("Discard marks it discarded", () => /Discarded/.test(doc.querySelector('[data-zara-proposal="6"]').textContent));

  console.log("\n── MyCase is gone ──────────────────────────────");
  const para = fs.readFileSync(path.join(REPO, "paralegal.js"), "utf8");
  check("the paralegal no longer calls MyCase", () => !/app\.mycase\.com/.test(para) && !/MYCASE_API_KEY/.test(para));
  Module._load = function (r, ...rest) {
    if (r === "./civil-snapshot") return { findMatters: async q => /Turco/i.test(q) ? [{ id: 223, case_name: "Jing Liu v. James Turco" }] : /Smith/i.test(q) ? [{ id: 1 }, { id: 2 }] : [] };
    if (r === "./civil-litigation") return fakeCivil;
    return orig.call(this, r, ...rest);
  };
  delete require.cache[require.resolve("../paralegal")];
  const paralegal = require("../paralegal");
  calls.deadlines.length = 0;
  let cal = await paralegal.calendarOnCivilMatter("Liu v. Turco — calendar this", [
    { label: "📅 Answer due", date: "2026-10-05", priority: "CRITICAL" },
    { label: "Rule 26(f) conference", date: "2026-10-20", priority: "HIGH" },
    { label: "Initial disclosures", date: "14 days after 26(f)", priority: "HIGH" },
  ]);
  check("its deadlines go onto the civil matter the message names", () => cal.matter.id === 223 && calls.deadlines.length === 1 && calls.deadlines[0].description === "Rule 26(f) conference");
  check("…never twice", () => cal.skipped.some(s => /already on the matter/.test(s.why)));
  check("…and one without a fixed date is left for a person", () => cal.skipped.some(s => /no fixed date/.test(s.why)));
  cal = await paralegal.calendarOnCivilMatter("Jones v. Smith — set deadlines", [{ label: "x", date: "2026-10-05" }]);
  check("when the name matches several matters it adds nothing and says so", () => !cal.matter && /matches 2 civil matters/.test(cal.reason));
  const stubRes = await paralegal.createMyCaseTask("x", "y", "2026-01-01");
  check("old MyCase callers get a clear answer instead of a crash", () => stubRes.success === false && /no longer used/.test(stubRes.error));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL ZARA-ACTIONS CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
