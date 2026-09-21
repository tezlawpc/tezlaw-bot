// ============================================================
//  civil-hearings.js — hearings on a civil matter, and what happened
//  ─────────────────────────────────────────────────────────
//  A hearing has two lives. Before it: a date, a time, a department,
//  who is appearing and how. After it: what the court did, the notes
//  from the courtroom, and what happens next. Both live on one record
//  so the notes sit next to the hearing they came from.
//
//  Wiring into the rest of the matter:
//
//    · Scheduling a hearing puts it on the PENDING DEADLINES list, with
//      a reminder, so it shows wherever deadlines show and the reminder
//      jobs pick it up. Moving the hearing moves that deadline; the
//      hearing being held, vacated or deleted closes it.
//    · Recording the outcome writes the ruling to the case history.
//    · "Continued to" schedules the continued hearing in the same step,
//      so the next date is never left in someone's head.
//    · Time spent at the hearing can be logged in the same form, as a
//      time entry billed like any other.
// ============================================================

const db = require("./db");

const TYPES = [
  "Case Management Conference", "Motion hearing", "Demurrer", "Ex parte",
  "Order to Show Cause", "Trial Setting Conference", "Final Status Conference",
  "Mandatory Settlement Conference", "Trial", "Status conference",
  "Post-mediation status", "Other",
];
const APPEARANCES = ["In person", "Remote (video)", "Telephonic", "CourtCall", "LACourtConnect"];
const STATUSES = ["scheduled", "held", "continued", "vacated", "off_calendar"];

let ready = null;
function initTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS civil_hearings (
        id              SERIAL PRIMARY KEY,
        case_id         INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
        hearing_date    DATE NOT NULL,
        hearing_time    TEXT,
        hearing_type    TEXT NOT NULL,
        department      TEXT,
        judge           TEXT,
        location        TEXT,
        appearance      TEXT,
        appearing       TEXT,
        purpose         TEXT,
        status          TEXT DEFAULT 'scheduled',
        notes           TEXT,
        ruling          TEXT,
        next_steps      TEXT,
        continued_to    DATE,
        continued_from  INTEGER,
        deadline_id     INTEGER,
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_hearings_case ON civil_hearings (case_id, hearing_date DESC)`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

function day(d) {
  if (!d) return "";
  const t = new Date(d);
  return isNaN(t) ? String(d) : t.toISOString().slice(0, 10);
}
function pretty(d) {
  if (!d) return "";
  const t = new Date(d);
  return isNaN(t) ? String(d)
    : t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function clean(v) {
  const s = String(v == null ? "" : v).trim();
  return s || null;
}

function label(h) {
  return `${h.hearing_type}${h.hearing_time ? " at " + h.hearing_time : ""}${h.department ? " · Dept. " + h.department : ""}`;
}

// ── The deadline that mirrors a scheduled hearing ───────────

async function syncDeadline(h) {
  const open = h.status === "scheduled";
  if (!open) {
    if (h.deadline_id) {
      await db.query(
        `UPDATE civil_case_deadlines SET status = 'completed', completed_at = NOW(), completed_by = 'hearing ' || $2
          WHERE id = $1 AND status = 'pending'`,
        [h.deadline_id, h.status]
      ).catch(() => {});
    }
    return h.deadline_id || null;
  }
  const desc = `Hearing: ${label(h)}`;
  const priority = /trial|ex parte|order to show cause/i.test(h.hearing_type) ? "high" : "medium";
  if (h.deadline_id) {
    const r = await db.query(
      `UPDATE civil_case_deadlines SET due_date = $2, description = $3, priority = $4, status = 'pending',
              completed_at = NULL, completed_by = NULL
        WHERE id = $1 RETURNING id`,
      [h.deadline_id, day(h.hearing_date), desc, priority]
    );
    if (r.rows.length) return h.deadline_id;
  }
  const r = await db.query(
    `INSERT INTO civil_case_deadlines
       (case_id, due_date, description, ccp_rule, priority, auto_generated, source_trigger, reminder_days_before)
     VALUES ($1,$2,$3,NULL,$4,FALSE,NULL,$5) RETURNING id`,
    [h.case_id, day(h.hearing_date), desc, priority, /trial/i.test(h.hearing_type) ? 14 : 3]
  );
  const id = r.rows[0].id;
  await db.query(`UPDATE civil_hearings SET deadline_id = $2 WHERE id = $1`, [h.id, id]);
  return id;
}

async function logToHistory(caseId, title, description, by) {
  try {
    await require("./civil-litigation").logEvent(caseId, {
      event_kind: "hearing",
      event_date: new Date().toISOString().slice(0, 10),
      title, description, created_by: by || null,
    });
  } catch (e) { /* the hearing itself is saved either way */ }
}

// ── CRUD ────────────────────────────────────────────────────

async function listHearings(caseId) {
  await initTables();
  const r = await db.query(
    `SELECT * FROM civil_hearings WHERE case_id = $1
      ORDER BY (status = 'scheduled') DESC,
               CASE WHEN status = 'scheduled' THEN hearing_date END ASC,
               hearing_date DESC, id DESC`,
    [caseId]
  );
  return r.rows;
}

async function getHearing(id) {
  await initTables();
  const r = await db.query(`SELECT * FROM civil_hearings WHERE id = $1`, [id]);
  if (!r.rows.length) throw new Error("Hearing not found");
  return r.rows[0];
}

async function addHearing(caseId, data, { by = null } = {}) {
  await initTables();
  if (!data.hearing_date) throw new Error("A hearing date is required");
  if (isNaN(new Date(data.hearing_date))) throw new Error("That hearing date is not a date");
  const type = clean(data.hearing_type) || "Other";

  // Carry the judge and department forward from the last hearing on this
  // matter when none is given — they rarely change mid-case.
  let judge = clean(data.judge), dept = clean(data.department);
  if (!judge || !dept) {
    const prev = await db.query(
      `SELECT judge, department FROM civil_hearings WHERE case_id = $1 ORDER BY hearing_date DESC LIMIT 1`, [caseId]);
    if (prev.rows[0]) { judge = judge || prev.rows[0].judge; dept = dept || prev.rows[0].department; }
  }

  const r = await db.query(
    `INSERT INTO civil_hearings
       (case_id, hearing_date, hearing_time, hearing_type, department, judge, location,
        appearance, appearing, purpose, notes, continued_from, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [caseId, day(data.hearing_date), clean(data.hearing_time), type, dept, judge, clean(data.location),
     clean(data.appearance), clean(data.appearing), clean(data.purpose), clean(data.notes),
     data.continued_from || null, by]
  );
  const h = r.rows[0];
  h.deadline_id = await syncDeadline(h);
  if (!data._quiet) {
    await logToHistory(caseId, `Hearing set: ${type} on ${pretty(h.hearing_date)}`,
      [label(h), h.purpose, h.appearance && `Appearance: ${h.appearance}`, h.appearing && `Appearing: ${h.appearing}`]
        .filter(Boolean).join(" · "), by);
  }
  return h;
}

const EDITABLE = ["hearing_date", "hearing_time", "hearing_type", "department", "judge", "location",
                  "appearance", "appearing", "purpose", "notes", "ruling", "next_steps"];

async function updateHearing(id, data, { by = null } = {}) {
  const before = await getHearing(id);
  const sets = [], vals = [id];
  for (const k of EDITABLE) {
    if (data[k] === undefined) continue;
    if (k === "hearing_date") {
      if (!data[k] || isNaN(new Date(data[k]))) throw new Error("A valid hearing date is required");
      vals.push(day(data[k]));
    } else vals.push(clean(data[k]));
    sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return before;
  sets.push("updated_at = NOW()");
  const h = (await db.query(`UPDATE civil_hearings SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals)).rows[0];
  await syncDeadline(h);
  if (data.hearing_date !== undefined && day(before.hearing_date) !== day(h.hearing_date)) {
    await logToHistory(h.case_id, `Hearing moved: ${h.hearing_type}`,
      `${pretty(before.hearing_date)} → ${pretty(h.hearing_date)}`, by);
  }
  return h;
}

/**
 * Record what happened. status: held | continued | vacated | off_calendar.
 * Optional: notes, ruling, next_steps, continued_to (+ continued_time),
 * and hours — logged as a time entry for the appearance.
 */
async function recordOutcome(id, data, { by = null, userId = null } = {}) {
  const h0 = await getHearing(id);
  const status = STATUSES.includes(data.status) ? data.status : "held";
  if (status === "scheduled") throw new Error("Pick what happened: held, continued, vacated or off calendar");
  if (status === "continued" && !data.continued_to) throw new Error("Continued to what date?");

  const h = (await db.query(
    `UPDATE civil_hearings
        SET status = $2, notes = COALESCE($3, notes), ruling = COALESCE($4, ruling),
            next_steps = COALESCE($5, next_steps), continued_to = $6, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, status, clean(data.notes), clean(data.ruling), clean(data.next_steps),
     status === "continued" ? day(data.continued_to) : null]
  )).rows[0];
  await syncDeadline(h);

  const out = { hearing: h, continued: null, time: null };

  // The continued hearing is scheduled now, carrying everything forward.
  if (status === "continued") {
    out.continued = await addHearing(h.case_id, {
      hearing_date: data.continued_to,
      hearing_time: data.continued_time || h.hearing_time,
      hearing_type: h.hearing_type, department: h.department, judge: h.judge, location: h.location,
      appearance: h.appearance, appearing: h.appearing,
      purpose: h.purpose ? `${h.purpose} (continued from ${pretty(h.hearing_date)})` : `Continued from ${pretty(h.hearing_date)}`,
      continued_from: h.id, _quiet: true,
    }, { by });
  }

  const hours = Number(data.hours);
  if (hours > 0) {
    try {
      out.time = await require("./civil-time").logTime(h.case_id, {
        date: day(h.hearing_date), hours,
        description: `Appear at ${h.hearing_type.toLowerCase()}${h.department ? " (Dept. " + h.department + ")" : ""}` +
                     (h.ruling ? ` — ${h.ruling.slice(0, 120)}` : ""),
        utbms_activity: "A109",
      }, { by, userId });
    } catch (e) { out.time_error = e.message; }
  }

  const verb = { held: "Hearing held", continued: "Hearing continued", vacated: "Hearing vacated", off_calendar: "Hearing off calendar" }[status];
  await logToHistory(h.case_id, `${verb}: ${h.hearing_type} (${pretty(h.hearing_date)})`,
    [h.ruling && `Ruling: ${h.ruling}`,
     status === "continued" && `Continued to ${pretty(h.continued_to)}`,
     h.next_steps && `Next: ${h.next_steps}`,
     h.notes && `Notes: ${h.notes}`].filter(Boolean).join("\n") || verb, by);

  return out;
}

async function deleteHearing(id, { by = null } = {}) {
  const h = await getHearing(id);
  if (h.deadline_id) {
    await db.query(`DELETE FROM civil_case_deadlines WHERE id = $1 AND status = 'pending'`, [h.deadline_id]).catch(() => {});
  }
  await db.query(`DELETE FROM civil_hearings WHERE id = $1`, [id]);
  await logToHistory(h.case_id, `Hearing removed: ${h.hearing_type} (${pretty(h.hearing_date)})`,
    h.notes ? `Its notes were: ${h.notes}` : "Removed from the hearings list.", by);
  return { ok: true };
}

module.exports = {
  TYPES, APPEARANCES, STATUSES,
  initTables, listHearings, getHearing, addHearing, updateHearing, recordOutcome, deleteHearing,
};
