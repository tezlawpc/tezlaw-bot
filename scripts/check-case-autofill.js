/**
 * check-case-autofill.js
 *
 * "in civil and PI cases and all federal cases, make a function where when
 *  case files are linked via dropbox, make a function to read the files and
 *  fill in the information on that case automatically. Second, able to
 *  upload documents and read to fill out the info in that case."
 *
 * This is the feature that writes to a live litigation record from a
 * machine's reading of a PDF, so the checks are mostly about what it
 * REFUSES to do. The four rules in case-autofill.js's header:
 *
 *   1. a field that already has a value is never proposed;
 *   2. a value with no quote from the document is dropped;
 *   3. at Apply, a field that stopped being blank is skipped, not
 *      overwritten;
 *   4. only a column on that matter kind's own list can be written,
 *      and the list is what builds the SQL.
 *
 * Plus the two fields it must never read off a page at all — the civil
 * statute of limitations and the PI SOL date. Those are computed from the
 * defendant and the plaintiff, not printed anywhere, and a machine-filled
 * SOL that is wrong is the worst single field in this system.
 *
 * The extractor runs against a stubbed model and a stubbed database, so
 * these exercise the real module, not a description of it.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}
async function acheck(name, fn) {
  let ok = false, detail = "";
  try { const r = await fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// ── A database that remembers, so Apply can actually be tested ──
const DB = {
  matters: {},          // table -> { id -> row }
  runs: [],
  sql: [],              // every statement, for the SQL-shape checks
};
function resetDb() {
  DB.matters = { civil_cases: {}, pi_cases: {}, federal_matters: {} };
  DB.runs = [];
  DB.sql = [];
}
resetDb();

const fakeDb = {
  async query(text, vals = []) {
    DB.sql.push({ text, vals });
    const t = text.replace(/\s+/g, " ").trim();

    if (/^(CREATE|ALTER)/i.test(t)) return { rows: [] };

    let m = t.match(/^SELECT \* FROM (\w+) WHERE id = \$1$/i);
    if (m && DB.matters[m[1]]) {
      const row = DB.matters[m[1]][vals[0]];
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^SELECT \* FROM case_autofill_runs WHERE id = \$1$/i.test(t)) {
      const r = DB.runs.find((x) => x.id === vals[0]);
      return { rows: r ? [{ ...r }] : [] };
    }
    if (/^INSERT INTO case_autofill_runs/i.test(t)) {
      const row = {
        id: DB.runs.length + 1,
        kind: vals[0], case_id: vals[1], source: vals[2],
        documents: JSON.parse(vals[3]), proposals: JSON.parse(vals[4]),
        conflicts: JSON.parse(vals[5]), warnings: JSON.parse(vals[6]),
        run_by: vals[7], model: vals[8], error: vals[9], status: vals[10],
        created_at: new Date(), decided_by: null, decided_at: null, applied: null,
      };
      DB.runs.push(row);
      return { rows: [{ ...row }] };
    }
    if (/^SELECT id, source, status/i.test(t)) {
      return { rows: DB.runs.filter((r) => r.kind === vals[0] && r.case_id === vals[1]) };
    }
    m = t.match(/^UPDATE case_autofill_runs SET status = 'applying' WHERE id = \$1 AND status = 'pending' RETURNING id$/i);
    if (m) {
      const r = DB.runs.find((x) => x.id === vals[0] && x.status === "pending");
      if (!r) return { rows: [] };
      r.status = "applying";
      return { rows: [{ id: r.id }] };
    }
    if (/^UPDATE case_autofill_runs SET/i.test(t)) {
      const r = DB.runs.find((x) => x.id === vals[0]);
      if (!r) return { rows: [] };
      const st = t.match(/status = '(\w+)'/);
      if (st) {
        // The "back to pending" statement only fires while applying.
        if (/AND status = 'applying'/i.test(t) && r.status !== "applying") return { rows: [] };
        r.status = st[1];
      }
      if (/decided_by = \$2/.test(t)) { r.decided_by = vals[1]; r.decided_at = new Date(); }
      if (/applied = \$3/.test(t)) r.applied = JSON.parse(vals[2]);
      if (/warnings = \$2/.test(t)) r.warnings = JSON.parse(vals[1]);
      if (/error = \$2/.test(t)) r.error = vals[1];
      return { rows: [] };
    }
    m = t.match(/^UPDATE (\w+) SET (.+) WHERE id = \$1$/i);
    if (m && DB.matters[m[1]]) {
      const row = DB.matters[m[1]][vals[0]];
      const sets = m[2].split(",").map((s) => s.trim());
      for (const s of sets) {
        const p = s.match(/^(\w+) = \$(\d+)$/);
        if (p) row[p[1]] = vals[Number(p[2]) - 1];
      }
      return { rows: [] };
    }
    return { rows: [] };
  },
};

// ── The modules, with the model and the database stubbed ──
//
// The patch STAYS in place for the whole run, rather than being lifted after
// the require. case-autofill requires civil-litigation, civil-dropbox and
// dropbox-integration lazily, inside the functions — so lifting it let the
// real civil-litigation load, and its logEvent then wrote into a database
// that is not there, caught and swallowed. The history check failed for a
// reason that had nothing to do with the code it was checking.
let reply = "{}";
const thinkCalls = [];
const logged = [];
const realLoad = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "./zara-core") {
    return { think: async (a) => { thinkCalls.push(a); return { text: reply, model: "stub" }; } };
  }
  if (r === "./civil-litigation") {
    return { logEvent: async (id, e) => { logged.push({ id, ...e }); } };
  }
  if (r === "./dropbox-integration") {
    return { listFolderDeep: async () => [], downloadFile: async () => Buffer.from("x") };
  }
  if (r === "./civil-dropbox") return { listCaseFiles: async () => [] };
  if (r === "./hearing-notes") return { renderAdminChrome: ({ body }) => `<html><body>${body}</body></html>` };
  return realLoad.call(this, r, ...rest);
};
const af = require("../case-autofill");
const page = require("../case-autofill-page");

const doc = (s, filename = "complaint.txt") => ({ buffer: Buffer.from(s, "utf8"), filename });
const J = (fields, evidence, source = {}) => JSON.stringify({ ...fields, _evidence: evidence, _source: source });

(async () => {
  console.log("\nReading a case file into a case record\n");

  // ════════════════════════════════════════════════════════
  console.log("── The two fields it must never read ──────────");

  check("the civil statute of limitations is not a field it can propose", () =>
    !af.CIVIL_FIELDS.some((f) => f[0] === "statute_of_limitations"));
  check("nor is the PI SOL date", () =>
    !af.PI_FIELDS.some((f) => f[0] === "sol_date"));
  check("and the page says why, rather than leaving a suspicious blank", () => {
    const civil = af.neverProposed("civil");
    const pi = af.neverProposed("pi");
    assert.ok(civil.some((n) => n.field === "statute_of_limitations" && n.why.length > 30));
    assert.ok(pi.some((n) => n.field === "sol_date" && n.why.length > 30));
  });
  check("whether a government claim is required is a judgment, not a reading", () =>
    af.neverProposed("pi").some((n) => n.field === "gov_claim_required"));

  // ════════════════════════════════════════════════════════
  console.log("\n── The allow-list is what builds the SQL ──────");

  check("every kind of matter has one, and they do not overlap tables", () => {
    assert.deepStrictEqual(af.KINDS.sort(), ["civil", "federal", "pi"]);
    const tables = af.KINDS.map((k) => af.MATTERS[k].table);
    assert.strictEqual(new Set(tables).size, 3);
  });
  check("a kind that does not exist is refused, not guessed at", () => {
    assert.throws(() => af.matterKind("probate"), /Not a kind of matter/);
    assert.throws(() => af.matterKind(""), /Not a kind of matter/);
    assert.throws(() => af.matterKind("CIVIL_CASES"), /Not a kind of matter/);
  });
  check("every field names a real column of its own table", () => {
    // The columns are read out of the module that creates each table, so a
    // rename there fails this rather than failing at 2am against Postgres.
    const sources = {
      civil: read("civil-litigation.js"), pi: read("personal-injury.js"),
      federal: read("federal-matters.js"),
    };
    for (const kind of af.KINDS) {
      const table = af.MATTERS[kind].table;
      const src = sources[kind];
      const block = src.slice(src.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
      const create = block.slice(0, block.indexOf("`"));
      for (const [col] of af.MATTERS[kind].fields) {
        assert.ok(new RegExp(`^\\s+${col}\\s+`, "m").test(create),
          `${table} has no column ${col}`);
      }
    }
  });
  check("fieldMap returns the list and nothing else", () => {
    const m = af.fieldMap("civil");
    assert.strictEqual(m.size, af.CIVIL_FIELDS.length);
    assert.ok(m.has("case_number"));
    assert.ok(!m.has("id") && !m.has("client_key") && !m.has("status") && !m.has("internal_notes"));
  });
  check("the columns that decide who owns a matter are not on any list", () => {
    for (const kind of af.KINDS) {
      for (const forbidden of ["id", "client_key", "created_at", "created_by", "status", "stage",
                               "lead_attorney_id", "case_manager_id", "assigned_attorney", "retainer_balance"]) {
        assert.ok(!af.MATTERS[kind].fields.some((f) => f[0] === forbidden),
          `${kind} would let a document set ${forbidden}`);
      }
    }
  });

  // ════════════════════════════════════════════════════════
  console.log("\n── Blank, and what counts as a value ──────────");

  check("a zero is a value; an empty string and spaces are not", () => {
    assert.strictEqual(af.isBlank(0), false);
    assert.strictEqual(af.isBlank(""), true);
    assert.strictEqual(af.isBlank("   "), true);
    assert.strictEqual(af.isBlank(null), true);
    assert.strictEqual(af.isBlank(undefined), true);
    assert.strictEqual(af.isBlank("x"), false);
  });
  check("a date already on file compares as a day, not a timestamp", () =>
    af.currentValue({ filed_date: new Date("2026-03-04T00:00:00Z") }, "filed_date", "date") === "2026-03-04");

  // ════════════════════════════════════════════════════════
  console.log("\n── A value that fails its own type becomes null ──");

  check("money arrives with a dollar sign and commas", () => {
    assert.strictEqual(af.coerce("number", "$1,250,000"), 1250000);
    assert.strictEqual(af.coerce("number", "33.33%"), 33.33);
    assert.strictEqual(af.coerce("number", "about forty"), null);
    assert.strictEqual(af.coerce("number", "-500"), null);
  });
  check("an enum outside its own set is null, not the first option", () => {
    assert.strictEqual(af.coerce("enum:hourly|contingency|flat|hybrid", "Contingency"), "contingency");
    assert.strictEqual(af.coerce("enum:hourly|contingency|flat|hybrid", "flat fee"), null);
    assert.strictEqual(af.coerce("enum:minor|moderate|severe|catastrophic", "SEVERE"), "severe");
    assert.strictEqual(af.coerce("enum:auto|slip_fall|other", "slip fall"), "slip_fall");
  });
  check("a date that is not one is null", () => {
    assert.strictEqual(af.coerce("date", "March 4, 2026"), "2026-03-04");
    assert.strictEqual(af.coerce("date", "sometime in spring"), null);
    assert.strictEqual(af.coerce("date", ""), null);
  });

  // ════════════════════════════════════════════════════════
  console.log("\n── Which six files out of a hundred ───────────");

  check("a complaint outranks an answer, and both outrank a letter", () => {
    assert.ok(af.rankFile("Verified Complaint.pdf") < af.rankFile("Answer.pdf"));
    assert.strictEqual(af.rankFile("Letter to opposing counsel.pdf"), null);
  });
  check("a file nothing can read is not worth one of the six", () => {
    assert.strictEqual(af.rankFile("IMG_4821.HEIC"), null);
    assert.strictEqual(af.rankFile("exhibits.zip"), null);
    assert.strictEqual(af.rankFile("bodycam.mp4"), null);
    assert.ok(af.rankFile("complaint.pdf") !== null);
    assert.ok(af.rankFile("intake.docx") !== null);
  });
  check("a police report counts on a PI case and not on a civil one", () => {
    assert.ok(af.rankFile("Traffic Collision Report.pdf", "", "pi") !== null);
    assert.strictEqual(af.rankFile("Traffic Collision Report.pdf", "", "civil"), null);
  });
  check("an office action counts on a federal matter", () =>
    af.rankFile("Office Action 2026-04-02.pdf", "", "federal") !== null);
  check("a scan with no useful name is read if it sits in Pleadings", () => {
    assert.ok(af.rankFile("Scan 0041.pdf", "Pleadings") !== null);
    assert.strictEqual(af.rankFile("Scan 0041.pdf", "Correspondence"), null);
  });

  // ════════════════════════════════════════════════════════
  console.log("\n── Reading documents into a proposal ──────────");

  function civilCase(extra = {}) {
    resetDb();
    DB.matters.civil_cases[7] = {
      id: 7, client_key: "chen-wei", case_name: "Chen v. Acme LLC",
      case_number: null, court: null, county: null, case_type: null, our_role: null,
      opposing_party: null, filed_date: null, service_date: null, answered_date: null,
      cmc_date: null, trial_date: null, amount_in_controversy: null,
      billing_type: null, hourly_rate: null, contingency_pct: null, retainer_amount: null,
      statute_of_limitations: null, ...extra,
    };
  }

  await acheck("a field the record does not have, with a quote, is proposed", async () => {
    civilCase();
    reply = J({ case_number: "25STCV01234", court: "Superior Court of California, County of Los Angeles" },
      { case_number: "Case No. 25STCV01234", court: "SUPERIOR COURT OF CALIFORNIA, COUNTY OF LOS ANGELES" },
      { case_number: "complaint.txt", court: "complaint.txt" });
    const run = await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    assert.strictEqual(run.proposals.length, 2);
    const n = run.proposals.find((p) => p.field === "case_number");
    assert.strictEqual(n.value, "25STCV01234");
    assert.ok(n.quote.includes("25STCV01234"));
    assert.strictEqual(n.source, "complaint.txt");
    assert.strictEqual(run.status, "pending");
  });

  await acheck("RULE 2 — a value it cannot quote is dropped, and the count is said", async () => {
    civilCase();
    reply = J({ case_number: "25STCV01234", court: "Some Court" },
      { case_number: "Case No. 25STCV01234" });            // no quote for court
    const run = await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    assert.strictEqual(run.proposals.length, 1);
    assert.strictEqual(run.proposals[0].field, "case_number");
    assert.ok(run.warnings.some((w) => /could not point to/.test(w)));
  });

  await acheck("RULE 1 — a field the record already holds is never proposed", async () => {
    civilCase({ case_number: "25STCV09999" });
    reply = J({ case_number: "25STCV01234" }, { case_number: "Case No. 25STCV01234" });
    const run = await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    assert.strictEqual(run.proposals.length, 0, "it would have overwritten a filed case number");
    assert.strictEqual(run.conflicts.length, 1);
    assert.strictEqual(run.conflicts[0].current, "25STCV09999");
    assert.strictEqual(run.conflicts[0].value, "25STCV01234");
    assert.strictEqual(run.status, "empty");
  });

  await acheck("a document that agrees with the record is not news", async () => {
    civilCase({ case_number: "25STCV01234" });
    reply = J({ case_number: "25STCV01234" }, { case_number: "Case No. 25STCV01234" });
    const run = await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    assert.strictEqual(run.proposals.length, 0);
    assert.strictEqual(run.conflicts.length, 0);
  });

  await acheck("a filing date in the future is a misread, and is dropped", async () => {
    civilCase();
    const next = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    reply = J({ filed_date: next }, { filed_date: "Filed " + next });
    const run = await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    assert.strictEqual(run.proposals.length, 0);
    assert.ok(run.warnings.some((w) => /future/.test(w)));
  });

  await acheck("…but a trial date in the future is simply a trial date", async () => {
    civilCase();
    const next = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
    reply = J({ trial_date: next }, { trial_date: "Trial set for " + next });
    const run = await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    assert.strictEqual(run.proposals.length, 1);
    assert.strictEqual(run.proposals[0].drives_deadlines, true);
  });

  await acheck("a scan with no text layer says so instead of looking empty", async () => {
    civilCase();
    reply = J({}, {});
    const run = await af.readDocuments("civil", 7, [doc("    \n  ", "scan.txt")], { by: "JJ" });
    assert.strictEqual(run.proposals.length, 0);
    assert.ok(run.warnings.some((w) => /scan/i.test(w) && /OCR/.test(w)));
  });

  await acheck("a file type nothing can read is reported by name", async () => {
    civilCase();
    const run = await af.readDocuments("civil", 7, [doc("x", "photo.heic")], { by: "JJ" });
    assert.ok(run.warnings.some((w) => /photo\.heic/.test(w)));
    assert.ok(/Nothing readable/.test(run.error || ""));
  });

  await acheck("the model is told who our client is, so it can spot the other side's papers", async () => {
    civilCase();
    reply = J({}, {});
    thinkCalls.length = 0;
    await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    const sent = thinkCalls[thinkCalls.length - 1].message;
    assert.ok(/Chen v\. Acme LLC/.test(sent), "the record's own names were not given as context");
    assert.ok(/OTHER SIDE/.test(sent), "nothing warns it that the folder holds adverse papers");
    assert.ok(/file stamp/.test(sent), "nothing distinguishes the filing date from the signature date");
  });

  await acheck("PI and federal matters read too, each with their own fields", async () => {
    resetDb();
    DB.matters.pi_cases[3] = { id: 3, client_name: "Lu, Guang", incident_date: null,
      police_report_number: null, severity: null, sol_date: null };
    reply = J({ police_report_number: "WC-26-0412", severity: "severe", sol_date: "2028-01-01" },
      { police_report_number: "Report No. WC-26-0412", severity: "multiple fractures", sol_date: "x" });
    // .txt, not .pdf: the buffer is a stub, and pdf-parse would be the thing
    // under test instead of the field list.
    const run = await af.readDocuments("pi", 3, [doc("x", "Traffic Collision Report.txt")], { by: "Lin" });
    const fields = run.proposals.map((p) => p.field).sort();
    assert.deepStrictEqual(fields, ["police_report_number", "severity"]);
    assert.ok(!fields.includes("sol_date"), "the SOL came through despite not being on the list");
  });

  // ════════════════════════════════════════════════════════
  console.log("\n── Writing only what was ticked ───────────────");

  async function pendingRun() {
    civilCase();
    reply = J({ case_number: "25STCV01234", court: "LASC", our_role: "plaintiff", filed_date: "2026-02-10" },
      { case_number: "Case No. 25STCV01234", court: "LASC", our_role: "Plaintiff CHEN", filed_date: "Filed 02/10/2026" });
    return af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
  }

  await acheck("only the ticked fields are written", async () => {
    const run = await pendingRun();
    await af.applyRun(run.id, ["case_number", "court"], { by: "JJ" });
    const row = DB.matters.civil_cases[7];
    assert.strictEqual(row.case_number, "25STCV01234");
    assert.strictEqual(row.court, "LASC");
    assert.strictEqual(row.our_role, null, "an unticked field was written anyway");
    assert.strictEqual(row.filed_date, null);
  });

  await acheck("RULE 4 — a field name that was not proposed is refused", async () => {
    const run = await pendingRun();
    // What a hand-edited form would send.
    const out = await af.applyRun(run.id, ["case_number", "internal_notes", "status"], { by: "JJ" });
    assert.deepStrictEqual(out.refused.sort(), ["internal_notes", "status"]);
    assert.strictEqual(DB.matters.civil_cases[7].internal_notes, undefined);
    assert.strictEqual(DB.matters.civil_cases[7].status, undefined);
  });

  await acheck("…and the UPDATE only ever names columns from the list", async () => {
    const run = await pendingRun();
    DB.sql.length = 0;
    await af.applyRun(run.id, ["case_number", "court", "filed_date"], { by: "JJ" });
    const upd = DB.sql.find((s) => /^\s*UPDATE civil_cases SET/.test(s.text));
    assert.ok(upd, "no UPDATE was issued");
    // The SET clause only — `WHERE id = $1` is how the row is found, not a
    // field anything proposed.
    const setClause = upd.text.slice(upd.text.indexOf("SET") + 3, upd.text.indexOf("WHERE"));
    const cols = setClause.match(/(\w+) = \$\d+/g).map((s) => s.split(" ")[0]);
    assert.ok(cols.length >= 3, "the SET clause was not read correctly");
    const allowed = new Set(af.CIVIL_FIELDS.map((f) => f[0]));
    for (const c of cols) assert.ok(allowed.has(c), `${c} is not on the list`);
    // Values are bound, never interpolated.
    assert.ok(!/25STCV01234/.test(upd.text), "a value was put into the SQL text");
  });

  await acheck("RULE 3 — a field somebody filled in meanwhile is skipped, not overwritten", async () => {
    const run = await pendingRun();
    DB.matters.civil_cases[7].court = "Typed in by Jue while this sat on screen";
    const out = await af.applyRun(run.id, ["case_number", "court"], { by: "JJ" });
    assert.strictEqual(DB.matters.civil_cases[7].court, "Typed in by Jue while this sat on screen");
    assert.strictEqual(DB.matters.civil_cases[7].case_number, "25STCV01234");
    assert.ok(out.skipped.some((s) => /filled in since/.test(s)));
  });

  await acheck("if every field was filled in meanwhile, nothing is written and it says so", async () => {
    const run = await pendingRun();
    DB.matters.civil_cases[7].case_number = "already";
    await af.applyRun(run.id, ["case_number"], { by: "JJ" }).then(
      () => { throw new Error("it wrote anyway"); },
      (e) => assert.ok(/filled in since/.test(e.message)));
    // And it is still usable: the other fields are still proposed.
    const again = await af.getRun(run.id);
    assert.strictEqual(again.status, "pending");
  });

  await acheck("ticking nothing writes nothing", async () => {
    const run = await pendingRun();
    await af.applyRun(run.id, [], { by: "JJ" }).then(
      () => { throw new Error("it wrote anyway"); },
      (e) => assert.ok(/Nothing was ticked/.test(e.message)));
  });

  await acheck("a double-click cannot apply the same read twice", async () => {
    const run = await pendingRun();
    await af.applyRun(run.id, ["case_number"], { by: "JJ" });
    await af.applyRun(run.id, ["court"], { by: "JJ" }).then(
      () => { throw new Error("it applied twice"); },
      (e) => assert.ok(/already been applied/.test(e.message)));
    assert.strictEqual(DB.matters.civil_cases[7].court, null);
  });

  await acheck("a read older than a week has to be run again", async () => {
    const run = await pendingRun();
    DB.runs.find((r) => r.id === run.id).created_at = new Date(Date.now() - 8 * 86400000);
    await af.applyRun(run.id, ["case_number"], { by: "JJ" }).then(
      () => { throw new Error("it applied a stale read"); },
      (e) => assert.ok(/more than a week old/.test(e.message)));
    assert.strictEqual(DB.runs.find((r) => r.id === run.id).status, "expired");
  });

  await acheck("the record keeps the quote, not just the value", async () => {
    const run = await pendingRun();
    await af.applyRun(run.id, ["case_number"], { by: "Chandler" });
    const saved = DB.runs.find((r) => r.id === run.id);
    assert.strictEqual(saved.status, "applied");
    assert.strictEqual(saved.decided_by, "Chandler");
    assert.strictEqual(saved.run_by, "JJ");
    assert.ok(saved.applied.fields[0].quote.includes("25STCV01234"));
  });

  await acheck("a civil matter's history says what was written and who approved it", async () => {
    logged.length = 0;
    const run = await pendingRun();
    await af.applyRun(run.id, ["case_number"], { by: "Chandler" });
    assert.strictEqual(logged.length, 1);
    assert.ok(/25STCV01234/.test(logged[0].description));
    assert.ok(/approved by Chandler/.test(logged[0].description));
    assert.ok(/read by JJ/i.test(logged[0].description));
  });

  await acheck("discarding leaves the record and refuses a later apply", async () => {
    const run = await pendingRun();
    await af.discardRun(run.id, { by: "JJ" });
    assert.strictEqual(DB.runs.find((r) => r.id === run.id).status, "discarded");
    await af.applyRun(run.id, ["case_number"], { by: "JJ" }).then(
      () => { throw new Error("a discarded read still applied"); },
      (e) => assert.ok(/was discarded/.test(e.message)));
  });

  // ════════════════════════════════════════════════════════
  console.log("\n── The page asks before it writes ─────────────");

  const src = read("case-autofill-page.js");
  const code = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  check("no inline script — an apostrophe in a case name cannot kill the page", () => {
    assert.ok(!/<script/i.test(code(src)), "a script tag would break on O'Brien v. Acme");
    assert.ok(!/onclick=/i.test(code(src)));
  });

  check("every decision is a real POST form", () => {
    for (const route of ["/read", "/upload", "/apply", "/discard"]) {
      assert.ok(src.includes(`${"${PAGE}"}${route}`), `${route} has no form`);
    }
    assert.ok(/enctype="multipart\/form-data"/.test(src), "the upload form cannot carry a file");
  });

  await acheck("a date that drives the deadline chain arrives unticked", async () => {
    const run = await pendingRun();
    const html = page.renderRun({
      run: await af.getRun(run.id), matter: af.matterKind("civil"),
      row: DB.matters.civil_cases[7], user: { n: "JJ" },
    });
    const forFiled = html.slice(html.indexOf('value="filed_date"') - 120, html.indexOf('value="filed_date"') + 60);
    assert.ok(!/checked/.test(forFiled), "filed_date came pre-ticked; it recomputes every deadline under it");
    const forCourt = html.slice(html.indexOf('value="court"') - 120, html.indexOf('value="court"') + 60);
    assert.ok(/checked/.test(forCourt), "an ordinary field should be one click, not fifteen");
    assert.ok(/recomputes the deadlines/.test(html), "nothing on screen says why it is unticked");
  });

  await acheck("the quote and the file it came from are both on screen", async () => {
    const run = await pendingRun();
    const html = page.renderRun({
      run: await af.getRun(run.id), matter: af.matterKind("civil"),
      row: DB.matters.civil_cases[7], user: { n: "JJ" },
    });
    assert.ok(html.includes("Case No. 25STCV01234"), "the quote is not shown");
    assert.ok(html.includes("complaint.txt"), "the file it came from is not shown");
  });

  await acheck("a conflict is shown with both values and no way to tick it", async () => {
    civilCase({ case_number: "25STCV09999" });
    reply = J({ case_number: "25STCV01234" }, { case_number: "Case No. 25STCV01234" });
    const run = await af.readDocuments("civil", 7, [doc("x")], { by: "JJ" });
    const html = page.renderRun({
      run: await af.getRun(run.id), matter: af.matterKind("civil"),
      row: DB.matters.civil_cases[7], user: { n: "JJ" },
    });
    assert.ok(html.includes("25STCV09999") && html.includes("25STCV01234"), "both values should be visible");
    assert.ok(!/name="field" value="case_number"/.test(html), "a conflict was offered as a checkbox");
    assert.ok(/Worth your eye/.test(html));
  });

  check("a case name with an apostrophe or a tag survives the page", () => {
    resetDb();
    DB.matters.civil_cases[9] = { id: 9, case_name: `O'Brien v. <script>alert(1)</script>` };
    const html = page.renderStart({
      matter: af.matterKind("civil"), row: DB.matters.civil_cases[9],
      picked: { folder: null, files: [], note: "no folder" }, recent: [], user: {},
    });
    assert.ok(html.includes("O&#39;Brien"), "the apostrophe was not escaped");
    assert.ok(!/<script>alert/.test(html), "a case name reached the browser as markup");
  });

  check("the landing screen offers both ways in", () => {
    resetDb();
    DB.matters.civil_cases[9] = { id: 9, case_name: "Chen v. Acme" };
    const html = page.renderStart({
      matter: af.matterKind("civil"), row: DB.matters.civil_cases[9],
      picked: { folder: "/Clients/Chen", files: [{ name: "Complaint.pdf", folder: "Pleadings", size: 90000 }], considered: 42 },
      recent: [], user: {},
    });
    assert.ok(/Complaint\.pdf/.test(html), "it does not say which files it would read");
    assert.ok(/out of 42/.test(html), "it does not say how many it passed over");
    assert.ok(/type="file"/.test(html), "there is no way to upload a document");
  });

  check("a matter with no folder is told what to do instead", () => {
    resetDb();
    DB.matters.civil_cases[9] = { id: 9, case_name: "Chen v. Acme" };
    const html = page.renderStart({
      matter: af.matterKind("civil"), row: DB.matters.civil_cases[9],
      picked: { folder: null, files: [], note: "This civil matter has no Dropbox folder linked yet. Link one, or upload the documents here instead." },
      recent: [], user: {},
    });
    assert.ok(/no Dropbox folder linked/.test(html));
    assert.ok(/type="file"/.test(html), "the upload route should still be open");
  });

  check("the roles are the ones who can already edit a matter by hand", () => {
    assert.deepStrictEqual(page.ROLES.sort(), ["admin", "attorney", "manager", "paralegal"]);
  });

  // ════════════════════════════════════════════════════════
  console.log("\n── Wired in ───────────────────────────────────");

  const server = read("server.js");
  check("the page is mounted", () =>
    /require\("\.\/case-autofill-page"\)\.mount\(app, auth, docUpload\)/.test(server));
  check("the table is created at boot, not on the first click", () =>
    /require\("\.\/case-autofill"\)\.initTables\(\)/.test(server));
  check("all three kinds of case page have the button", () => {
    assert.ok(/case-autofill-page/.test(read("civil-litigation-ui.js")), "civil case page has no button");
    assert.ok(/case-autofill-page/.test(read("personal-injury-ui.js")), "PI case page has no button");
    assert.ok(/case-autofill-page/.test(server), "federal matter page has no button");
  });
  check("the button says the same thing on all three", () => {
    const html = page.buttonFor("pi", 3);
    assert.ok(/Read the case file/.test(html));
    assert.ok(/Nothing is written until you tick it/.test(html));
    // Escaped, because the href goes through esc() — &amp; is the correct
    // spelling of & inside an attribute.
    assert.ok(html.includes("kind=pi&amp;id=3"), "the link does not carry the matter");
  });
  check("the check is registered the way every check here is", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.ok(pkg.scripts["check:case-autofill"], "no npm script");
    assert.ok(/check-case-autofill\.js/.test(pkg.scripts["test:chain"]), "not in test:chain");
    assert.ok(/check-case-autofill\.js/.test(read(".github/workflows/ci.yml")), "not a CI step");
  });

  console.log(failures
    ? `\n${failures} FAILED\n`
    : "\nAll checks passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
