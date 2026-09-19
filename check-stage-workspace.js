/**
 * Unit test for civil-litigation.getStageWorkspace().
 * Stubs ./db so the stage playbook, alert rules and sort order are exercised
 * against fixed rows rather than live data.
 */
const Module = require("module");
const origLoad = Module._load;

const DAY = 86400000;
const iso = n => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

let CASES = [], DEADLINES = [], DISCOVERY = [];
const dbStub = {
  query: async (sql, vals) => {
    if (/FROM civil_cases/.test(sql)) {
      // listCases builds its parameter list from whichever filters were
      // passed, so the stage is not at a fixed index — find it by value.
      const stages = new Set(CASES.map(c => c.stage));
      const stage = vals.find(v => stages.has(v));
      return { rows: CASES.filter(c => c.stage === stage) };
    }
    if (/FROM civil_case_deadlines/.test(sql)) {
      const ids = vals[0];
      return { rows: DEADLINES.filter(d => ids.includes(d.case_id)) };
    }
    if (/FROM civil_discovery/.test(sql)) {
      const ids = vals[0];
      return { rows: DISCOVERY.filter(d => ids.includes(d.case_id)) };
    }
    return { rows: [] };
  },
};
Module._load = function (r) {
  if (r === "./db") return dbStub;
  return origLoad.apply(this, arguments);
};

const civil = require(require("path").join(__dirname, "..", "civil-litigation.js"));

let bad = 0;
function check(label, cond, detail) {
  if (!cond) bad++;
  console.log((cond ? "  PASS  " : "  FAIL  ") + label + (!cond && detail ? " — " + detail : ""));
}
const alertText = c => c.alerts.map(a => a.text).join(" | ");

(async () => {
  console.log("\n=== playbook covers every stage ===");
  check("9 stages, 9 playbook entries",
    Object.keys(civil.STAGE_PLAYBOOK).length === civil.STAGES.length);
  check("every stage key has a playbook",
    civil.STAGES.every(s => civil.STAGE_PLAYBOOK[s.key]),
    civil.STAGES.filter(s => !civil.STAGE_PLAYBOOK[s.key]).map(s => s.key).join(","));
  check("every playbook rule is a real CCP rule key", (() => {
    const real = new Set(civil.CCP_RULES.map(r => r.key));
    const bogus = [];
    Object.entries(civil.STAGE_PLAYBOOK).forEach(([k, p]) =>
      (p.rules || []).forEach(r => { if (!real.has(r)) bogus.push(k + ":" + r); }));
    return bogus.length === 0 || bogus.join(",");
  })() === true, "bogus rule keys referenced");

  console.log("\n=== intake: SOL is the whole job ===");
  CASES = [
    { id: 1, stage: "intake", status: "active", case_name: "No SOL Co", statute_of_limitations: null, retainer_amount: 5000 },
    { id: 2, stage: "intake", status: "active", case_name: "SOL Soon", statute_of_limitations: iso(40), retainer_amount: 2500, amount_in_controversy: 100000 },
    { id: 3, stage: "intake", status: "active", case_name: "Comfortable", statute_of_limitations: iso(500), retainer_amount: 1000 },
  ];
  DEADLINES = [];
  let w = await civil.getStageWorkspace("intake");
  check("returns all three matters", w.cases.length === 3);
  check("missing SOL is flagged", /No statute of limitations/.test(alertText(w.cases.find(c => c.id === 1))));
  check("SOL in 40d is a danger", w.cases.find(c => c.id === 2).alerts.some(a => a.level === "danger"));
  check("comfortable SOL raises nothing", w.cases.find(c => c.id === 3).alerts.length === 0, alertText(w.cases.find(c => c.id === 3)));
  check("at-risk count is 1", w.rollup.at_risk === 1, String(w.rollup.at_risk));
  check("amount at stake sums", w.rollup.amount_at_stake === 100000, String(w.rollup.amount_at_stake));
  check("focus is the SOL field", w.cases[0].focus.field === "statute_of_limitations");
  check("riskiest sorts first", w.cases[0].id === 2 || w.cases[0].id === 1, "got id " + w.cases[0].id);

  console.log("\n=== pleadings: filed but never served ===");
  CASES = [
    { id: 4, stage: "pleadings", status: "active", case_name: "Stale Service", filed_date: iso(-75), service_date: null, our_role: "plaintiff" },
    { id: 5, stage: "pleadings", status: "active", case_name: "Served, No Answer", filed_date: iso(-30), service_date: iso(-20), answered_date: null, our_role: "defendant" },
  ];
  DEADLINES = [
    { id: 90, case_id: 4, due_date: iso(-5), description: "File Proof of Service", source_trigger: "proof_of_service", status: "pending" },
    { id: 91, case_id: 5, due_date: iso(10), description: "Answer due", source_trigger: "answer_due", status: "pending" },
    { id: 92, case_id: 5, due_date: iso(3), description: "Expert exchange", source_trigger: "expert_witness_exchange", status: "pending" },
  ];
  w = await civil.getStageWorkspace("pleadings");
  const c4 = w.cases.find(c => c.id === 4), c5 = w.cases.find(c => c.id === 5);
  check("75 days unserved is a danger", /still no service date/.test(alertText(c4)));
  check("past-due deadline is counted", /1 deadline past due/.test(alertText(c4)));
  check("defendant with no answer is flagged", /no responsive pleading/.test(alertText(c5)));
  check("stage filters foreign deadlines out",
    c5.deadlines.length === 1 && c5.deadlines[0].source_trigger === "answer_due",
    c5.deadlines.map(d => d.source_trigger).join(","));
  check("but still reports the full count", c5.deadline_count_all === 2, String(c5.deadline_count_all));

  console.log("\n=== manual deadlines belong to whoever is looking ===");
  DEADLINES.push({ id: 93, case_id: 5, due_date: iso(6), description: "Call the client", source_trigger: null, status: "pending" });
  w = await civil.getStageWorkspace("pleadings");
  check("null source_trigger shows in every stage",
    w.cases.find(c => c.id === 5).deadlines.some(d => d.description === "Call the client"));

  console.log("\n=== discovery: counts come from civil_discovery ===");
  CASES = [{ id: 6, stage: "discovery", status: "active", case_name: "Rogs Fight", trial_date: iso(200) }];
  DEADLINES = [];
  DISCOVERY = [{ case_id: 6, total: 4, overdue: 2, mtc_soon: 1 }];
  w = await civil.getStageWorkspace("discovery");
  check("discovery rollup is attached", w.cases[0].discovery.total === 4);
  check("overdue responses raise a danger", /2 overdue responses/.test(alertText(w.cases[0])));
  check("MTC window raises a danger", /1 motion-to-compel deadline within 30 days/.test(alertText(w.cases[0])));

  console.log("\n=== trial prep: no trial date means no deadlines at all ===");
  CASES = [
    { id: 7, stage: "trial_prep", status: "active", case_name: "Dateless", trial_date: null },
    { id: 8, stage: "trial_prep", status: "active", case_name: "Imminent", trial_date: iso(20) },
  ];
  DEADLINES = []; DISCOVERY = [];
  w = await civil.getStageWorkspace("trial_prep");
  check("missing trial date is a danger", /No trial date/.test(alertText(w.cases.find(c => c.id === 7))));
  check("trial in 20d says discovery is closed", /discovery is closed/.test(alertText(w.cases.find(c => c.id === 8))));

  console.log("\n=== post-trial: the clocks nobody generates ===");
  CASES = [{ id: 9, stage: "post_trial", status: "active", case_name: "Judgment Entered", trial_date: iso(-10) }];
  w = await civil.getStageWorkspace("post_trial");
  check("warns that appeal/JNOV dates are manual", /15-day motion and 60-day appeal/.test(alertText(w.cases[0])));

  console.log("\n=== closed: stop syncing dead matters ===");
  CASES = [{ id: 10, stage: "closed", status: "active", case_name: "Done", dropbox_path: "/Cases/Done", files_archived_at: null }];
  w = await civil.getStageWorkspace("closed");
  check("unarchived closed matter is flagged", /not archived/.test(alertText(w.cases[0])));

  console.log("\n=== unknown stage ===");
  let threw = false;
  try { await civil.getStageWorkspace("nonsense"); } catch (e) { threw = /Unknown stage/.test(e.message); }
  check("rejects an unknown stage key", threw);

  console.log("\n" + "=".repeat(52));
  console.log(bad === 0 ? "ALL STAGE-WORKSPACE CHECKS PASSED" : bad + " CHECK(S) FAILED");
  console.log("=".repeat(52));
  process.exit(bad ? 1 : 0);
})();
