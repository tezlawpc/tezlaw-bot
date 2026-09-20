/**
 * Renders the real /admin/civil/stage/:key page body, loads the real
 * civil-admin.js into jsdom, and serves its fetch from a stand-in for the
 * mirrored API — using the exact payload getStageWorkspace() produces.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const REPO = require("path").join(__dirname, "..");
const civil = require(REPO + "/civil-litigation.js");

const DAY = 86400000;
const iso = n => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

// The page body, built exactly as server.js builds it.
const key = "trial_prep";
const stage = civil.STAGES.find(s => s.key === key);
const playbook = civil.STAGE_PLAYBOOK[key];
const esc = t => String(t == null ? "" : t)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tabs = civil.STAGES.map(s =>
  `<a href="/admin/civil/stage/${s.key}">${esc(s.label)}</a>`).join("");
const body = `
  <div>
    <h1>${esc(stage.label)}</h1>
    <div>${esc(playbook.headline)}</div>
    <div>${tabs}</div>
    <div data-civil-panel="stage" data-stage-key="${key}"></div>
  </div>`;

const PAYLOAD = {
  ok: true,
  stage: stage,
  playbook: {
    headline: playbook.headline, caution: playbook.caution,
    utbms_phase: "L400", folder: "06_Trial_Prep",
    kpis: ["Days to pretrial order", "Exhibits admitted vs offered"],
    task_count: 19, gate_count: 9,
  },
  cases: [
    {
      id: 8, case_name: "Imminent v. Trial", client_key: "imminent", case_type: "breach of contract",
      case_number: "24STCV001", our_role: "plaintiff", stage: key,
      trial_date: iso(20), amount_in_controversy: 250000, files_archived_at: null,
      focus: { label: "Trial", field: "trial_date", date: iso(20), days: 20 },
      deadlines: [
        { id: 1, due_date: iso(-3), description: "Expert witness list exchange", ccp_rule: "CCP § 2034.230(b)" },
        { id: 2, due_date: iso(5), description: "Motions in limine due", ccp_rule: "Local rules" },
      ],
      deadline_count_all: 6,
      discovery: null,
      alerts: [
        { level: "danger", text: "Trial in 20 days — discovery is closed" },
        { level: "danger", text: "1 deadline past due" },
      ],
      jurisdiction: "CA",
      task_progress: { total: 19, done: 6, pct: 32, overdue: 2, critical_open: 3 },
      gates: [
        { key: "pretrial_order", label: "Joint pretrial order filed and entered", ok: true },
        { key: "premark_exhibits", label: "All exhibits pre-marked", ok: false },
      ],
      gates_open: 1, gate_ready: false,
      unresolved_deadlines: [
        { key: "discovery_cutoff", label: "Discovery cutoff", reason: "Needs discovery cutoff date on the matter." },
      ],
    },
    {
      id: 7, case_name: "Dateless Matter", client_key: "dateless", stage: key,
      trial_date: null, focus: { label: "Trial", field: "trial_date", date: null, days: null },
      deadlines: [], deadline_count_all: 0, discovery: null,
      alerts: [{ level: "danger", text: "No trial date — none of this stage's deadlines can be computed" }],
    },
  ],
  rollup: {
    count: 2, at_risk: 2, amount_at_stake: 250000, open_deadlines: 2,
    gate_ready: 0, tasks_open: 13, tasks_overdue: 2,
    next_deadline: { due_date: iso(-3), description: "Expert witness list exchange", ccp_rule: "CCP § 2034.230(b)", case_name: "Imminent v. Trial" },
  },
};

const CALLS = [];
const DB = {
  "GET /meta": { ok: true, stages: civil.STAGES, case_types: civil.CASE_TYPES, our_roles: civil.OUR_ROLES },
  ["GET /stage/" + key]: PAYLOAD,
  ["GET /queue?phase=" + key]: { ok: true, count: 1, tasks: [
    { id: 501, case_id: 8, case_name: "Imminent v. Trial", phase: key, task_key: "premark_exhibits",
      label: "Pre-mark all trial exhibits", role: "case_manager", utbms_code: "L440",
      due_date: iso(-2), status: "open", critical: true },
  ] },
};

(async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${body}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const errs = [];
  w.addEventListener("error", e => errs.push(e.message));
  w.alert = () => {}; w.confirm = () => true;
  w.fetch = (url, init) => {
    init = init || {};
    const path = String(url).replace("/admin/civil/api", "");
    const k = (init.method || "GET") + " " + path;
    CALLS.push({ k, body: init.body ? JSON.parse(init.body) : null });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(DB[k] || { ok: true }) });
  };

  w.eval(fs.readFileSync(REPO + "/public/civil-admin.js", "utf8"));
  await new Promise(r => setTimeout(r, 500));

  const doc = w.document;
  const txt = (doc.querySelector('[data-civil-panel="stage"]') || {}).textContent || "";
  let bad = 0;
  const check = (label, cond, detail) => {
    if (!cond) bad++;
    console.log((cond ? "  PASS  " : "  FAIL  ") + label + (!cond && detail ? " — " + detail : ""));
  };

  console.log("\n=== stage workspace renders its own content ===");
  check("no window errors", errs.length === 0, errs.join("; "));
  check("fetched the stage endpoint", CALLS.some(c => c.k === "GET /stage/" + key));
  check("shows the stage headline", txt.includes("Everything counts backwards"));
  check("shows the stage caution", txt.includes("Expert exchange is 50 days out"));
  check("shows the UTBMS phase", txt.includes("UTBMS L400"));
  check("shows the checklist and gate counts", /19 standard tasks/.test(txt) && /9 gate criteria/.test(txt));
  check("shows the phase folder", txt.includes("06_Trial_Prep"));
  check("shows the KPIs it tracks", txt.includes("Days to pretrial order"));
  check("shows gate readiness in the rollup", /Gate Ready/.test(txt));
  check("shows the open-task rollup", /Open Tasks/.test(txt));
  check("shows the rollup", /Need Attention/.test(txt) && /At Stake/.test(txt));
  check("shows amount at stake", txt.includes("$250,000.00"));
  check("shows the next deadline banner", txt.includes("NEXT UP IN THIS STAGE"));
  check("flags the past-due deadline in days", /3d LATE/.test(txt));

  console.log("\n=== per-matter content ===");
  check("lists both matters", txt.includes("Imminent v. Trial") && txt.includes("Dateless Matter"));
  check("shows danger alerts", txt.includes("discovery is closed"));
  check("shows the no-trial-date warning", txt.includes("none of this stage's deadlines can be computed"));
  check("lists the stage's deadlines", txt.includes("Expert witness list exchange") && txt.includes("Motions in limine due"));
  check("shows the focus chip", /Trial .*20d/.test(txt.replace(/\s+/g, " ")));
  check("shows the jurisdiction",
    !!doc.querySelector('[data-civil-panel="stage"] span[title*="jurisdiction"]'),
    "no jurisdiction chip rendered");
  check("shows checklist progress", /Checklist 6 \/ 19/.test(txt));
  check("flags open critical tasks", /3 critical open/.test(txt));
  check("shows the gate strip", /1 of 2 criteria outstanding/.test(txt));
  check("shows an unmet gate", txt.includes("All exhibits pre-marked"));
  check("shows deadlines that need a date", /NEEDS A DATE/.test(txt) && txt.includes("Needs discovery cutoff date"));
  check("links each matter to its case page",
    !!doc.querySelector('[data-civil-panel="stage"] a[href="/admin/civil/case/8"]'));

  console.log("\n=== the four views ===");
  ["Matters", "Checklist", "Documents", "Budget"].forEach(function (v) {
    check("has a " + v + " view", [...doc.querySelectorAll("button")].some(b => b.textContent === v));
  });
  const checklistBtn = [...doc.querySelectorAll("button")].find(b => b.textContent === "Checklist");
  checklistBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const txt2 = doc.querySelector('[data-civil-panel="stage"]').textContent;
  check("checklist view offers a role filter",
    /WHOSE WORK/.test(txt2) && /Case Manager/.test(txt2) && /Docketing/.test(txt2));
  check("checklist view queries the role queue", CALLS.some(c => /^GET \/queue/.test(c.k)));
  // Back to matters for the remaining assertions.
  [...doc.querySelectorAll("button")].find(b => b.textContent === "Matters").click();
  await new Promise(r => setTimeout(r, 300));

  console.log("\n=== this is NOT the kanban board ===");
  check("no kanban columns rendered", !doc.querySelector(".civil-col"));
  check("no draggable cards", !doc.querySelector(".civil-card"));
  check("all nine stages are linked as tabs",
    civil.STAGES.every(s => doc.querySelector('a[href="/admin/civil/stage/' + s.key + '"]')));

  console.log("\n=== advance a matter from the workspace ===");
  const advance = [...doc.querySelectorAll("button")].find(b => b.textContent === "ADVANCE STAGE");
  check("advance button exists", !!advance);
  if (advance) {
    advance.click();
    await new Promise(r => setTimeout(r, 250));
    const modal = [...doc.querySelectorAll("div")].reverse()
      .find(d => d.style.position === "fixed" && d.style.zIndex === "9998");
    check("advance modal opens", !!modal);
    if (modal) {
      const sel = modal.querySelector("select");
      check("defaults to the NEXT stage",
        sel && sel.value === "trial", sel ? "got " + sel.value : "no select");
      [...modal.querySelectorAll("button")].pop().click();
      await new Promise(r => setTimeout(r, 250));
      const mv = CALLS.filter(c => /move-stage/.test(c.k)).pop();
      check("posts the move to the right case", mv && /\/8\//.test(mv.k), mv ? mv.k : "no call");
      check("posts the chosen stage", mv && mv.body.stage === "trial", mv ? JSON.stringify(mv.body) : "");
      check("applies the next phase checklist on advance",
        CALLS.some(c => c.k === "POST /cases/8/phase-tasks" && c.body && c.body.stage === undefined));
    }
  }

  console.log("\n" + "=".repeat(52));
  console.log(bad === 0 ? "ALL STAGE-PAGE CHECKS PASSED" : bad + " CHECK(S) FAILED");
  console.log("=".repeat(52));
  process.exit(bad ? 1 : 0);
})();
