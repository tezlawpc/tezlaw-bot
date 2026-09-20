/**
 * The UTBMS code sets and the phase playbooks are reference data that other
 * code trusts: a task template pointing at a code that does not exist would
 * put an un-billable line on a client invoice, and a gate pointing at a task
 * that does not exist would silently never be satisfiable.
 *
 * Also exercises the LEDES 1998B writer, since a malformed file is rejected
 * by the client's e-billing platform rather than by us.
 */
const path = require("path");
const Module = require("module");
const origLoad = Module._load;
Module._load = function (r) {
  if (r === "./db") return { query: async () => ({ rows: [], rowCount: 0 }) };
  return origLoad.apply(this, arguments);
};

const u = require(path.join(__dirname, "..", "civil-utbms.js"));
const p = require(path.join(__dirname, "..", "civil-phases.js"));
const civil = require(path.join(__dirname, "..", "civil-litigation.js"));

let bad = 0;
function check(label, cond, detail) {
  if (!cond) bad++;
  console.log((cond ? "  PASS  " : "  FAIL  ") + label + (!cond && detail !== undefined ? " — " + detail : ""));
}

console.log("\n=== UTBMS code sets ===");
check("6 litigation phases", u.TASK_PHASES.length === 6, String(u.TASK_PHASES.length));
check("L600 is eDiscovery, not ADR — the common misreading",
  u.TASK_PHASES.find(x => x.key === "L600").label === "eDiscovery");
check("ADR lives at L160 inside L100",
  u.TASK_CODES.some(c => c.code === "L160" && c.phase === "L100" && /ADR/.test(c.label)));
check("every task code rolls up to a real phase",
  u.TASK_CODES.every(c => u.TASK_PHASES.some(ph => ph.key === c.phase)),
  u.TASK_CODES.filter(c => !u.TASK_PHASES.some(ph => ph.key === c.phase)).map(c => c.code).join(","));
check("task codes are unique", new Set(u.TASK_CODES.map(c => c.code)).size === u.TASK_CODES.length);
check("activity codes are unique", new Set(u.ACTIVITY_CODES.map(c => c.code)).size === u.ACTIVITY_CODES.length);
check("expense codes are unique", new Set(u.EXPENSE_CODES.map(c => c.code)).size === u.EXPENSE_CODES.length);
check("the ABA activity set A101-A111 is present",
  ["A101", "A102", "A103", "A104", "A105", "A106", "A107", "A108", "A109", "A110", "A111"]
    .every(c => u.isValidActivityCode(c)));
check("phaseOf('L320') is L300", u.phaseOf("L320") === "L300", u.phaseOf("L320"));
check("codes are matched case-insensitively", u.isValidTaskCode("l320"));

console.log("\n=== invoice line validation, as a client's platform would do it ===");
const good = { kind: "F", task_code: "L310", activity_code: "A103", date: "2026-09-10", total: 1125, description: "Draft SROGs" };
check("a well-formed fee line passes", u.validateLine(good).length === 0, JSON.stringify(u.validateLine(good)));
check("a phase HEADER is rejected with a clear reason",
  /phase header/.test(u.validateLine(Object.assign({}, good, { task_code: "L300" }))[0] || ""));
check("an unknown task code is rejected",
  /Unknown task code/.test(u.validateLine(Object.assign({}, good, { task_code: "L999" }))[0] || ""));
check("a fee line with no activity code is rejected",
  u.validateLine(Object.assign({}, good, { activity_code: "" })).some(e => /activity code/.test(e)));
check("a fee line carrying an expense code is rejected",
  u.validateLine(Object.assign({}, good, { expense_code: "E101" })).some(e => /must not carry an expense/.test(e)));
const goodExp = { kind: "E", expense_code: "E112", date: "2026-09-12", total: 435, description: "Filing fee" };
check("a well-formed expense line passes", u.validateLine(goodExp).length === 0, JSON.stringify(u.validateLine(goodExp)));
check("an expense line carrying a task code is rejected",
  u.validateLine(Object.assign({}, goodExp, { task_code: "L310" })).some(e => /must not carry a task/.test(e)));
check("a line with no narrative is rejected",
  u.validateLine(Object.assign({}, good, { description: "  " })).some(e => /narrative/.test(e)));

console.log("\n=== LEDES 1998B ===");
const file = u.buildLedes1998B(
  { invoice_number: "INV-1", invoice_date: "2026-09-30", client_id: "ACME", law_firm_matter_id: "M-1",
    law_firm_id: "TEZ", billing_start: "2026-09-01", billing_end: "2026-09-30", description: "September" },
  [Object.assign({ units: 2.5, unit_cost: 450, timekeeper_id: "JZ", timekeeper_name: "JJ Zhang", timekeeper_classification: "PT" }, good),
   Object.assign({ units: 1, unit_cost: 435 }, goodExp)]
);
const lines = file.trim().split("\n");
check("header names all 24 fields", lines[0].split("|").length === 24, String(lines[0].split("|").length));
check("header matches the spec field order", lines[0] === u.LEDES_1998B_FIELDS.join("|"));
check("one row per line item", lines.length === 3, String(lines.length));
lines.slice(1).forEach((l, i) => check("row " + (i + 1) + " has 24 fields", l.split("|").length === 24, String(l.split("|").length)));
const fee = lines[1].split("|");
check("dates are YYYYMMDD", fee[0] === "20260930", fee[0]);
check("fee row is typed F", fee[9] === "F", fee[9]);
check("fee row carries the task code in field 15", fee[14] === "L310", fee[14]);
check("fee row leaves the expense code empty", fee[15] === "", JSON.stringify(fee[15]));
check("fee row carries the activity code in field 17", fee[16] === "A103", fee[16]);
const exp = lines[2].split("|");
check("expense row is typed E", exp[9] === "E", exp[9]);
check("expense row carries the expense code in field 16", exp[15] === "E112", exp[15]);
check("expense row leaves task and activity empty", exp[14] === "" && exp[16] === "");
check("invoice total is the sum of the lines", fee[4] === "1560.00", fee[4]);
check("the file ends with a newline", /\n$/.test(file));
// A pipe or newline inside a narrative would corrupt the record separators.
const dirty = u.buildLedes1998B({ invoice_number: "X" },
  [Object.assign({}, good, { description: "Draft | review\nand revise", units: 1, unit_cost: 1 })]);
check("pipes and newlines in a narrative are flattened",
  dirty.trim().split("\n").length === 2 && dirty.split("\n")[1].split("|").length === 24);

console.log("\n=== phase playbooks ===");
check("9 phases", p.PHASE_KEYS.length === 9, String(p.PHASE_KEYS.length));
check("the phase keys match the lifecycle stages",
  p.PHASE_KEYS.every(k => civil.STAGES.some(s => s.key === k)) &&
  civil.STAGES.every(s => p.PHASE_KEYS.includes(s.key)),
  p.PHASE_KEYS.join(",") + " vs " + civil.STAGES.map(s => s.key).join(","));

let taskTotal = 0, gateTotal = 0;
p.PHASE_KEYS.forEach(k => {
  const spec = p.PHASES[k];
  taskTotal += spec.tasks.length;
  gateTotal += spec.gates.length;
  const keys = new Set(spec.tasks.map(t => t.key));
  if (keys.size !== spec.tasks.length) { bad++; console.log("  FAIL  " + k + " has duplicate task keys"); }
  spec.tasks.forEach(t => {
    if (!p.ROLE_KEYS.has(t.role)) { bad++; console.log("  FAIL  " + k + ":" + t.key + " has role " + t.role); }
    if (!u.isValidTaskCode(t.utbms)) { bad++; console.log("  FAIL  " + k + ":" + t.key + " has UTBMS code " + t.utbms); }
    if (typeof t.days !== "number") { bad++; console.log("  FAIL  " + k + ":" + t.key + " has no day offset"); }
    if (!t.label) { bad++; console.log("  FAIL  " + k + ":" + t.key + " has no label"); }
  });
  spec.gates.forEach(g => {
    if (g.task && !keys.has(g.task)) { bad++; console.log("  FAIL  " + k + " gate " + g.key + " points at missing task " + g.task); }
    if (!g.label) { bad++; console.log("  FAIL  " + k + " gate " + g.key + " has no label"); }
  });
  if (!spec.utbmsPhase || !u.TASK_PHASES.some(x => x.key === spec.utbmsPhase)) {
    bad++; console.log("  FAIL  " + k + " has no valid UTBMS phase");
  }
  if (!spec.folder) { bad++; console.log("  FAIL  " + k + " has no document folder"); }
});
check(taskTotal + " tasks across 9 phases, every one with a real role and a real UTBMS code", true);
check(gateTotal + " gate criteria, every one labelled and resolvable", true);
check("every phase has a headline and a caution",
  p.PHASE_KEYS.every(k => p.PHASES[k].headline && p.PHASES[k].caution));
check("critical tasks exist in every phase",
  p.PHASE_KEYS.every(k => p.PHASES[k].tasks.some(t => t.critical)),
  p.PHASE_KEYS.filter(k => !p.PHASES[k].tasks.some(t => t.critical)).join(","));
check("all five roles are used somewhere",
  [...p.ROLE_KEYS].every(r => p.PHASE_KEYS.some(k => p.PHASES[k].tasks.some(t => t.role === r))));

console.log("\n=== documents route to the phase that produced them ===");
[
  ["Complaint.pdf", "", "pleadings"],
  ["Answer and Affirmative Defenses.docx", "", "pleadings"],
  ["SROGs Set One.docx", "", "discovery"],
  ["Smith Deposition Transcript.pdf", "", "discovery"],
  ["Privilege Log.xlsx", "", "discovery"],
  ["MSJ Points and Authorities.docx", "", "motions"],
  ["Daubert Motion.docx", "", "motions"],
  ["Joint Pretrial Order.pdf", "", "trial_prep"],
  ["Motion in Limine No 3.docx", "", "trial_prep"],
  ["Notice of Appeal.pdf", "", "post_trial"],
  ["Bill of Costs.pdf", "", "post_trial"],
  ["Engagement Letter.pdf", "", "intake"],
  ["Litigation Hold Notice.docx", "", "pre_filing"],
  ["Disengagement Letter.pdf", "", "closed"],
  ["Draft3_final.docx", "04_Discovery/Depositions", "discovery"],
  ["anything.pdf", "03_Pleadings", "pleadings"],
].forEach(([name, folder, want]) => {
  const got = p.phaseForFile(name, folder);
  check(("\"" + name + "\"" + (folder ? " in " + folder : "")).padEnd(52) + "-> " + want,
    got === want, "got " + got);
});
check("an unrecognisable file is left unphased rather than guessed",
  p.phaseForFile("scan0001.pdf", "") === null, String(p.phaseForFile("scan0001.pdf", "")));

console.log("\n=== stage inference ===");
const iso = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const cases = [
  ["nothing known", {}, "intake", "low"],
  ["SOL only", { statute_of_limitations: iso(200) }, "pre_filing", "medium"],
  ["filed", { filed_date: iso(-60) }, "pleadings", "medium"],
  ["answered", { filed_date: iso(-200), answered_date: iso(-150) }, "discovery", "high"],
  ["trial in 60 days", { filed_date: iso(-400), trial_date: iso(60) }, "trial_prep", "high"],
  ["trial passed", { trial_date: iso(-30) }, "post_trial", "medium"],
  ["judgment entered", { judgment_date: iso(-10) }, "post_trial", "medium"],
  ["archived", { files_archived_at: iso(-5) }, "closed", "medium"],
];
cases.forEach(([label, row, want, conf]) => {
  const s = p.suggestStage(Object.assign({ stage: "intake" }, row));
  check(label.padEnd(18) + "-> " + want, s.suggested === want, "got " + s.suggested);
  if (conf) check("  ...at " + conf + " confidence", s.confidence === conf, "got " + s.confidence);
});
check("documents alone can advance the suggestion",
  p.suggestStage({ stage: "intake" }, [{ phase: "discovery", count: 28 }]).suggested === "discovery");
check("documents and dates take the FURTHER of the two",
  p.suggestStage({ stage: "intake", trial_date: iso(40) }, [{ phase: "pleadings", count: 3 }]).suggested === "trial_prep");
check("a reason is always given when a move is proposed",
  p.suggestStage({ stage: "intake", filed_date: iso(-60) }).reasons.length > 0);
check("no move proposed when the stage already matches",
  p.suggestStage({ stage: "pleadings", filed_date: iso(-60) }).changed === false);

console.log("\n" + "=".repeat(54));
console.log(bad === 0 ? "ALL UTBMS / PHASE CHECKS PASSED" : bad + " CHECK(S) FAILED");
console.log("=".repeat(54));
process.exit(bad ? 1 : 0);
