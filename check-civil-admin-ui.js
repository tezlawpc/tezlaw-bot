/**
 * End-to-end check for the Wave B web panels.
 *
 * Renders the real case-detail HTML, loads the real /static/civil-admin.js
 * into jsdom, and serves its fetch() calls from an in-memory stand-in for the
 * mirrored /admin/civil/api/* endpoints — with response shapes copied from the
 * actual app-api handlers. Then asserts the panels rendered real content and
 * that every form posts the field names the civil-* modules destructure.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const Module = require("module");
const REPO = require("path").join(__dirname, "..");

// ── Stub the server-side modules the UI renderer requires ──
const cdxStub = {
  DOC_CATEGORIES: [{ key: "pleadings", label: "Pleadings", color: "#D97706" }],
  listCaseFiles: async () => [],
  categorySummary: async () => [],
};
const civilStub = {
  STAGES: [
    { key: "intake", label: "Intake / Assessment", color: "#7B5330" },
    { key: "discovery", label: "Discovery", color: "#B8891E" },
    { key: "closed", label: "Closed", color: "#166534" },
  ],
  CASE_TYPES: ["breach of contract"],
  OUR_ROLES: ["plaintiff"],
  listEvents: async () => [],
  listDeadlines: async () => [{ id: 9, due_date: "2026-11-01", description: "File CMC statement", ccp_rule: "CRC 3.725", priority: "high", auto_generated: true }],
  listCommunications: async () => [],
  getCaseSummary: async () => ({
    id: 1, case_name: "O'Brien v. Smith", client_key: "obrien", stage: "discovery",
    billing_type: "hourly", hourly_rate: 450, court_docket_url: null,
    dropbox_path: null, files_archived_at: null,
  }),
};
const origLoad = Module._load;
Module._load = function (r) {
  if (r === "./civil-dropbox") return cdxStub;
  if (r === "./civil-litigation") return civilStub;
  return origLoad.apply(this, arguments);
};

// ── Fake API, shapes taken from app-api.js ──
const CALLS = [];
const DB = {
  "GET /meta": { ok: true, stages: civilStub.STAGES, case_types: civilStub.CASE_TYPES, our_roles: civilStub.OUR_ROLES },
  "GET /team/meta": { ok: true, roles: [
    { key: "lead_attorney", label: "Lead Attorney", color: "#3E2818" },
    { key: "paralegal", label: "Paralegal", color: "#E0B44E" },
  ] },
  "GET /discovery/meta": { ok: true,
    kinds: [{ key: "rogs_special", label: "Special Interrogatories", ccp: "CCP § 2030.030(a)(2)" }],
    directions: ["propounded", "received"],
    serve_methods: ["personal", "mail", "email", "efile", "overnight"] },
  "GET /cases/1": { ok: true, case: {
    id: 1, case_name: "O'Brien v. Smith", hourly_rate: 450, court_docket_url: "https://court.example/case/123",
    last_docket_check_at: "2026-09-01", docket_snapshot: { judge: "Hon. A. Reyes", department: "12", current_status: "At issue" },
    opposing_counsel: { name: "R. Vance", firm: "Vance LLP" },
  } },
  "GET /cases/1/team": { ok: true, team: [
    { id: 5, user_id: 2, role: "lead_attorney", full_name: "JJ Zhang", email: "jj@tezlawfirm.com", billing_rate: 550, is_primary: true },
    { id: 6, user_id: 3, role: "paralegal", full_name: "Jue Wang", billing_rate: 175, is_primary: false },
  ] },
  "GET /users": { ok: true, users: [{ id: 2, full_name: "JJ Zhang", username: "jj", billing_rate: 550 }] },
  "GET /cases/1/discovery": { ok: true,
    discovery: [{
      id: 11, kind: "rogs_special", direction: "propounded", set_number: 1, title: "SROGs Set One",
      to_party: "Smith", served_date: "2026-07-01", served_method: "mail",
      response_due_date: "2026-08-05", mtc_deadline: "2026-09-19", mtc_filed_date: null, status: "pending",
    }],
    summary: { overdue: [{ id: 11 }], upcoming_mtc: [{ id: 11 }], counts_by_kind: [] } },
  "GET /cases/1/depositions": { ok: true, depositions: [
    { id: 21, deponent_name: "Dana Smith", deponent_role: "party", scheduled_date: "2026-10-14",
      scheduled_time: "10:00 AM", location: "Tez Law", status: "confirmed", billable_hours: null },
  ] },
  "GET /cases/1/docket-checks?limit=10": { ok: true, checks: [
    { id: 31, checked_at: "2026-09-01", checked_by: "jj", success: true, changes_detected: true, changes_summary: "Trial set for 2027-01-11" },
  ] },
  "GET /cases/1/billing-summary": { ok: true, summary: {
    case_id: 1, case_name: "O'Brien v. Smith", matter_budget: 20000, budget_alert_pct: 75,
    billing_type: "hourly", hourly_rate: 450, retainer_amount: 5000, retainer_balance: 1200,
    total_hours: 31.5, total_amount: 15750, pct_of_budget: 78.8, remaining_budget: 4250,
    over_budget: false, nearing_budget: true,
    event_hours: 25, event_amount: 12500, communication_hours: 6.5, communication_amount: 3250,
    deposition_hours: 0, deposition_amount: 0,
    by_timekeeper: [{ user_id: 2, name: "JJ Zhang", entry_count: 12, total_hours: 24, total_amount: 13200 }],
  } },
};

function makeFetch() {
  return function (url, init) {
    init = init || {};
    const path = String(url).replace("/admin/civil/api", "");
    const key = (init.method || "GET") + " " + path;
    CALLS.push({ key, body: init.body ? JSON.parse(init.body) : null });
    const data = DB[key] || { ok: true };
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(data),
    });
  };
}

(async () => {
  const ui = require(REPO + "/civil-litigation-ui.js");
  const body = await ui.renderCaseDetail(1);
  const script = fs.readFileSync(REPO + "/public/civil-admin.js", "utf8");

  const dom = new JSDOM(`<!DOCTYPE html><html><body>${body}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = makeFetch();
  w.alert = () => {};
  w.confirm = () => true;
  const logs = [];
  w.addEventListener("error", e => logs.push("window error: " + e.message));

  try {
    w.eval(script);
  } catch (e) {
    console.log("FAIL  script threw on load:", e.message);
    process.exit(1);
  }

  // Let the promise chains settle.
  await new Promise(r => setTimeout(r, 400));

  let bad = 0;
  const doc = w.document;
  function check(label, fn) {
    let ok = false, detail = "";
    try { const r = fn(); ok = !!r; detail = typeof r === "string" ? r : ""; }
    catch (e) { detail = e.message; }
    if (!ok) bad++;
    console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail && !ok ? " — " + detail : ""));
  }
  const text = sel => (doc.querySelector(sel) || {}).textContent || "";

  console.log("\n=== panels rendered from live API shapes ===");
  check("team shows both members",        () => /JJ Zhang/.test(text('[data-civil-panel="team"]')) && /Jue Wang/.test(text('[data-civil-panel="team"]')));
  check("team shows role labels",         () => /Lead Attorney/.test(text('[data-civil-panel="team"]')));
  check("discovery shows the set",        () => /Special Interrogatories/.test(text('[data-civil-panel="discovery"]')));
  check("discovery flags overdue",        () => /overdue response/i.test(text('[data-civil-panel="discovery"]')));
  check("discovery flags MTC clock",      () => /motion-to-compel deadline/i.test(text('[data-civil-panel="discovery"]')));
  check("depos shows the deponent",       () => /Dana Smith/.test(text('[data-civil-panel="depos"]')));
  check("docket shows judge",             () => /Hon\. A\. Reyes/.test(text('[data-civil-panel="docket"]')));
  check("docket shows check history",     () => /Trial set for/.test(text('[data-civil-panel="docket"]')));
  check("financials shows the total",     () => /\$15,750\.00/.test(text('[data-civil-panel="financials"]')));
  check("financials shows budget burn",   () => /78\.8%/.test(text('[data-civil-panel="financials"]')));
  check("financials shows timekeeper",    () => /JJ Zhang/.test(text('[data-civil-panel="financials"]')));
  check("financials shows hour sources",  () => /Communications/.test(text('[data-civil-panel="financials"]')));
  check("no window errors",               () => logs.length === 0 || logs.join("; "));

  console.log("\n=== forms post the field names the modules destructure ===");
  function openAndSubmit(action, fill) {
    doc.querySelector(`[data-civil-action="${action}"]`).click();
    return new Promise(r => setTimeout(() => {
      const modal = [...doc.querySelectorAll("div")].reverse()
        .find(d => d.style.position === "fixed" && d.style.zIndex === "9998");
      if (!modal) return r(null);
      if (fill) fill(modal);
      const save = [...modal.querySelectorAll("button")].pop();
      save.click();
      setTimeout(() => r(modal), 250);
    }, 250));
  }
  const setVal = (modal, label, v) => {
    const wrap = [...modal.querySelectorAll("label")].find(l => l.textContent.replace(" *", "") === label);
    if (!wrap) throw new Error("no field labelled " + label);
    const ctl = wrap.parentNode.querySelector("input,textarea,select");
    ctl.value = v;
    return ctl;
  };

  await openAndSubmit("log-event", m => {
    setVal(m, "Kind", "hearing");
    setVal(m, "Title", "CMC held");
    setVal(m, "Billable hours", "1.5");
    setVal(m, "Timekeeper", "2");
  });
  const ev = CALLS.filter(c => c.key === "POST /cases/1/events").pop();
  check("log-event posts event_kind/title", () => ev && ev.body.event_kind === "hearing" && ev.body.title === "CMC held");
  check("log-event routes attorney_id",     () => ev && ev.body.attorney_id === 2 && ev.body.paralegal_id === undefined);
  check("log-event sends hours as number",  () => ev && ev.body.billable_hours === 1.5);

  await openAndSubmit("add-deadline", m => {
    setVal(m, "Due date", "2026-12-01");
    setVal(m, "Description", "Expert disclosure");
  });
  const dl = CALLS.filter(c => c.key === "POST /cases/1/deadlines").pop();
  check("add-deadline posts due_date/description", () => dl && dl.body.due_date === "2026-12-01" && dl.body.description === "Expert disclosure");
  check("add-deadline defaults priority",          () => dl && dl.body.priority === "medium");

  await openAndSubmit("log-comm", m => {
    setVal(m, "Subject", "Meet and confer letter");
    setVal(m, "Timekeeper", "3");
    setVal(m, "Billable hours", "0.5");
  });
  const cm = CALLS.filter(c => c.key === "POST /cases/1/communications").pop();
  check("log-comm posts subject",         () => cm && cm.body.subject === "Meet and confer letter");
  check("log-comm routes paralegal_id",   () => cm && cm.body.paralegal_id === 3 && cm.body.attorney_id === undefined);

  await openAndSubmit("edit-case", m => { setVal(m, "Case name", "O'Brien v. Smith (amended)"); });
  const ec = CALLS.filter(c => c.key === "PATCH /cases/1").pop();
  check("edit-case PATCHes case_name",        () => ec && ec.body.case_name === "O'Brien v. Smith (amended)");
  check("edit-case sends opposing_counsel obj", () => ec && typeof ec.body.opposing_counsel === "object");

  // Deadline complete button
  doc.querySelector("[data-civil-complete-deadline]").click();
  await new Promise(r => setTimeout(r, 150));
  check("complete-deadline PATCHes the right id", () => CALLS.some(c => c.key === "PATCH /deadlines/9/complete"));

  console.log("\n=== meet-and-confer blank-key guard ===");
  const mcBtn = [...doc.querySelectorAll('[data-civil-panel="discovery"] button')]
    .find(b => b.textContent === "MEET & CONFER");
  mcBtn.click();
  await new Promise(r => setTimeout(r, 200));
  let modal = [...doc.querySelectorAll("div")].reverse()
    .find(d => d.style.position === "fixed" && d.style.zIndex === "9998");
  setVal(modal, "M&C letter sent", "2026-09-10");
  [...modal.querySelectorAll("button")].pop().click();
  await new Promise(r => setTimeout(r, 200));
  const mc = CALLS.filter(c => c.key === "POST /discovery/11/meet-confer").pop();
  check("meet-confer sends only filled keys", () => mc && !("mtc_filed_date" in mc.body) && mc.body.meet_confer_letter_sent_date === "2026-09-10");

  console.log("\n" + "=".repeat(50));
  console.log(bad === 0 ? "ALL CHECKS PASSED" : bad + " CHECK(S) FAILED");
  console.log("=".repeat(50));
  process.exit(bad ? 1 : 0);
})();
