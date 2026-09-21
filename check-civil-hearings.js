/**
 * check-civil-hearings.js
 *
 * Hearings on a civil matter, and the notes from them.
 *
 *   · A scheduled hearing is on the pending-deadline list with a reminder,
 *     moves when the hearing moves, and closes when the hearing is held,
 *     vacated or deleted — so it can never linger as a stale reminder.
 *   · Recording the outcome keeps the notes and ruling on the hearing,
 *     writes them to the case history, and a continuance schedules the
 *     next hearing in the same step, carrying the details forward.
 *   · Appearance time goes to Time & Billing as an A109 entry.
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
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

const S = { hearings: [], deadlines: [], history: [], time: [], id: 0 };
const iso = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

const fakeDb = {
  query: async (sql, v = []) => {
    const q = sql.replace(/\s+/g, " ");
    if (/^ ?CREATE /.test(q)) return { rows: [] };
    if (/SELECT judge, department FROM civil_hearings/.test(q)) {
      const rows = S.hearings.filter(h => h.case_id === v[0]).sort((a, b) => b.hearing_date.localeCompare(a.hearing_date));
      return { rows: rows.slice(0, 1) };
    }
    if (/INSERT INTO civil_hearings/.test(q)) {
      const h = { id: ++S.id, case_id: v[0], hearing_date: v[1], hearing_time: v[2], hearing_type: v[3],
        department: v[4], judge: v[5], location: v[6], appearance: v[7], appearing: v[8], purpose: v[9],
        notes: v[10], continued_from: v[11], created_by: v[12], status: "scheduled", deadline_id: null,
        ruling: null, next_steps: null, continued_to: null };
      S.hearings.push(h); return { rows: [Object.assign({}, h)] };
    }
    if (/SELECT \* FROM civil_hearings WHERE id = \$1/.test(q)) return { rows: S.hearings.filter(h => h.id === v[0]).map(h => Object.assign({}, h)) };
    if (/SELECT \* FROM civil_hearings WHERE case_id = \$1/.test(q)) return { rows: S.hearings.filter(h => h.case_id === v[0]) };
    if (/UPDATE civil_hearings SET deadline_id = \$2/.test(q)) { S.hearings.find(h => h.id === v[0]).deadline_id = v[1]; return { rows: [] }; }
    if (/UPDATE civil_hearings SET status = \$2/.test(q)) {
      const h = S.hearings.find(x => x.id === v[0]);
      Object.assign(h, { status: v[1], notes: v[2] ?? h.notes, ruling: v[3] ?? h.ruling, next_steps: v[4] ?? h.next_steps, continued_to: v[5] });
      return { rows: [Object.assign({}, h)] };
    }
    if (/UPDATE civil_hearings SET/.test(q)) {
      const h = S.hearings.find(x => x.id === v[0]);
      const cols = [...q.matchAll(/(\w+) = \$(\d+)/g)];
      cols.forEach(([, col, n]) => { h[col] = v[Number(n) - 1]; });
      return { rows: [Object.assign({}, h)] };
    }
    if (/DELETE FROM civil_hearings WHERE id = \$1/.test(q)) { S.hearings = S.hearings.filter(h => h.id !== v[0]); return { rows: [] }; }
    if (/INSERT INTO civil_case_deadlines/.test(q)) {
      const d = { id: ++S.id, case_id: v[0], due_date: v[1], description: v[2], priority: v[3], reminder_days_before: v[4], status: "pending" };
      S.deadlines.push(d); return { rows: [{ id: d.id }] };
    }
    if (/UPDATE civil_case_deadlines SET due_date = \$2/.test(q)) {
      const d = S.deadlines.find(x => x.id === v[0]);
      if (!d) return { rows: [] };
      Object.assign(d, { due_date: v[1], description: v[2], priority: v[3], status: "pending" });
      return { rows: [{ id: d.id }] };
    }
    if (/UPDATE civil_case_deadlines SET status = 'completed'/.test(q)) {
      const d = S.deadlines.find(x => x.id === v[0]); if (d && d.status === "pending") d.status = "completed"; return { rows: [] };
    }
    if (/DELETE FROM civil_case_deadlines WHERE id = \$1 AND status = 'pending'/.test(q)) {
      S.deadlines = S.deadlines.filter(d => !(d.id === v[0] && d.status === "pending")); return { rows: [] };
    }
    return { rows: [] };
  },
};

const orig = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "./civil-litigation") return { logEvent: async (id, e) => { S.history.push(Object.assign({ case_id: id }, e)); } };
  if (r === "./civil-time") return { logTime: async (caseId, d, o) => { const t = Object.assign({ caseId, by: o.by, userId: o.userId, billable_hours: d.hours }, d); S.time.push(t); return t; } };
  return orig.call(this, r, ...rest);
};
const H = require("../civil-hearings");

(async () => {
  console.log("\n── Scheduling ──────────────────────────────────");
  await throws("a hearing needs a date", () => H.addHearing(7, { hearing_type: "Motion hearing" }), /date is required/);
  await throws("…a real one", () => H.addHearing(7, { hearing_date: "next Tuesday" }), /not a date/);

  const a = await H.addHearing(7, {
    hearing_date: "2026-10-15", hearing_time: "8:30 AM", hearing_type: "Motion hearing",
    department: "12", judge: "Hon. A. Reyes", appearance: "Remote (video)",
    purpose: "Motion to compel further responses, RFPs Set One",
  }, { by: "jj" });
  const dl = () => S.deadlines.find(d => d.id === S.hearings.find(h => h.id === a.id).deadline_id);
  check("it is saved", () => a.id && a.status === "scheduled");
  check("it goes on the pending deadline list", () => dl() && dl().status === "pending" && dl().due_date === "2026-10-15");
  check("…described so it reads as a hearing", () => /Hearing: Motion hearing at 8:30 AM · Dept\. 12/.test(dl().description));
  check("…with a reminder", () => dl().reminder_days_before === 3);
  check("the case history records it", () => S.history.some(x => /Hearing set: Motion hearing/.test(x.title) && x.event_kind === "hearing"));

  const t = await H.addHearing(7, { hearing_date: "2027-01-11", hearing_type: "Trial" });
  const tdl = S.deadlines.find(d => d.id === S.hearings.find(h => h.id === t.id).deadline_id);
  check("a trial is high priority with two weeks' warning", () => tdl.priority === "high" && tdl.reminder_days_before === 14);
  check("judge and department carry forward from the last hearing", () => {
    const row = S.hearings.find(h => h.id === t.id);
    return row.judge === "Hon. A. Reyes" && row.department === "12";
  });

  console.log("\n── Moving it ───────────────────────────────────");
  await H.updateHearing(a.id, { hearing_date: "2026-10-22" }, { by: "jj" });
  check("moving the hearing moves its deadline", () => dl().due_date === "2026-10-22");
  check("…and the history says from and to", () => S.history.some(x => /Hearing moved/.test(x.title) && /Oct 15, 2026 → Oct 22, 2026/.test(x.description)));
  await throws("…but not to a non-date", () => H.updateHearing(a.id, { hearing_date: "" }), /valid hearing date/);

  // Someone deleted the reminder by hand from the deadline list; editing the
  // hearing must put it back rather than fail.
  const lost = dl().id;
  S.deadlines = S.deadlines.filter(d => d.id !== lost);
  await H.updateHearing(a.id, { hearing_time: "9:00 AM" });
  check("a reminder deleted by hand is recreated on the next edit", () => dl() && dl().status === "pending" && /9:00 AM/.test(dl().description));

  console.log("\n── What happened ───────────────────────────────");
  await throws("continued needs a date", () => H.recordOutcome(a.id, { status: "continued" }), /what date/);

  let out = await H.recordOutcome(a.id, {
    status: "continued", continued_to: "2026-11-19",
    notes: "Judge wants a further meet and confer on RFPs 4–9.",
    ruling: "Continued; parties to file a joint statement 5 court days before.",
    next_steps: "Send M&C letter this week.",
    hours: 1.5,
  }, { by: "jj", userId: 2 });
  const heldRow = S.hearings.find(h => h.id === a.id);
  check("the notes are kept on the hearing", () => /further meet and confer/.test(heldRow.notes));
  check("…with the ruling and next steps", () => /joint statement/.test(heldRow.ruling) && /M&C letter/.test(heldRow.next_steps));
  check("its reminder is closed — no stale deadline", () => dl().status === "completed");
  check("the continued hearing is scheduled in the same step", () => out.continued && out.continued.hearing_date === "2026-11-19");
  check("…carrying type, judge and department forward", () =>
    out.continued.hearing_type === "Motion hearing" && out.continued.judge === "Hon. A. Reyes" && out.continued.department === "12");
  check("…linked back to the one it continues", () => out.continued.continued_from === a.id && /continued from Oct 22, 2026/.test(out.continued.purpose));
  check("…with its own reminder", () => S.deadlines.some(d => d.due_date === "2026-11-19" && d.status === "pending"));
  check("appearance time is billed as A109", () => out.time && out.time.billable_hours === 1.5 && out.time.utbms_activity === "A109");
  check("…under the person who recorded it", () => out.time.userId === 2);
  check("…described from the hearing and ruling", () => /Appear at motion hearing \(Dept\. 12\) — Continued/.test(out.time.description));
  check("the history carries the ruling and the new date", () =>
    S.history.some(x => /Hearing continued/.test(x.title) && /Ruling: Continued/.test(x.description) && /Continued to Nov 19, 2026/.test(x.description)));

  out = await H.recordOutcome(out.continued.id, { status: "held", ruling: "Motion granted in part." });
  check("held with no hours logs no time", () => !out.time && S.time.length === 1);

  console.log("\n── Removing one ────────────────────────────────");
  await H.addHearing(7, { hearing_date: "2026-12-01", hearing_type: "Status conference", notes: "Bring settlement numbers" });
  const s = S.hearings[S.hearings.length - 1];
  const sDl = s.deadline_id;
  await H.deleteHearing(s.id, { by: "jj" });
  check("deleting a hearing removes it", () => !S.hearings.some(h => h.id === s.id));
  check("…and its pending reminder", () => !S.deadlines.some(d => d.id === sDl));
  check("…but the history keeps a record, notes included", () =>
    S.history.some(x => /Hearing removed: Status conference/.test(x.title) && /settlement numbers/.test(x.description)));
  await throws("an unknown hearing is refused", () => H.deleteHearing(9999), /not found/);

  console.log("\n── Listing ─────────────────────────────────────");
  const list = await H.listHearings(7);
  check("every hearing on the matter is listed", () => list.length === S.hearings.filter(h => h.case_id === 7).length);

  console.log("\n── Wiring ──────────────────────────────────────");
  const api = fs.readFileSync(path.join(REPO, "app-api.js"), "utf8");
  const ui = fs.readFileSync(path.join(REPO, "civil-litigation-ui.js"), "utf8");
  const js = fs.readFileSync(path.join(REPO, "public", "civil-admin.js"), "utf8");
  [
    ['app.get("/api/staff/civil/cases/:id/hearings"', "list"],
    ['app.post("/api/staff/civil/cases/:id/hearings"', "add"],
    ['app.patch("/api/staff/civil/hearings/:id"', "edit"],
    ['app.post("/api/staff/civil/hearings/:id/outcome"', "record outcome"],
    ['app.delete("/api/staff/civil/hearings/:id"', "delete"],
  ].forEach(([sig, what]) => check(`route: ${what}`, () => api.includes(sig)));
  check("the case page has a hearings panel", () => /data-civil-panel="hearings"/.test(ui));
  check("…above the deadlines", () => ui.indexOf('data-civil-panel="hearings"') < ui.indexOf("<!-- Deadlines -->"));
  check("…rendered by the case-page script", () => /panel\("hearings"\) \? renderHearings\(\)/.test(js));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL CIVIL-HEARINGS CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
