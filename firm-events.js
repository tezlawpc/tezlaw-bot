// ============================================================
//  firm-events.js — the calendar entries a person types in
//  ─────────────────────────────────────────────────────────
//  "i am stil unable to add or delete calenders and sync." (JJ,
//  2026-10-09, after asking twice)
//
//  WHAT WAS MISSING. Every item on the firm's calendar was DERIVED:
//  a hearing note, a notice read out of Dropbox, a matter deadline, or
//  an event pulled in from a synced Outlook calendar. There was no way
//  to put a consultation, a signing appointment or a client meeting on
//  it, and nothing to delete -- the Calendar page could only show you
//  what some other record implied.
//
//  This is the one source whose rows a person owns outright. They can be
//  created, edited and deleted, they carry a client and a matter so they
//  show on that file, and they go OUT on the .ics feed so they land in
//  the calendar app the office actually watches. Outlook-origin events
//  stay read-only: they belong to Outlook and writing back needs Graph
//  OAuth, which is a separate job.
//
//  ── THE DATE, AND WHY IT IS NOT A TIMESTAMP ───────────────
//
//  event_day is a DATE and start_time is TEXT. Deliberately. No
//  timestamptz anywhere in this table.
//
//  Every date bug in this codebase has come from storing a courtroom
//  date as an instant and then reading it in a different zone. On
//  2026-10-09 a client profile was showing Pan, Ping's 10:00 AM hearing
//  as "3:00 AM" because a naive timestamp went into a TIMESTAMPTZ
//  column, Postgres read it as UTC, and the page rendered it in Pacific.
//  A hearing at 9:00 AM is at 9:00 AM; it is not an instant that moves
//  when you travel.
//
//  So the date is a date and the time is the text that was typed. The
//  ONE place a conversion happens is calendarRows(), which hands the
//  Calendar page a timestamptz because the other six sources give it
//  one. That conversion is `(day + time) AT TIME ZONE 'UTC'`, which
//  matches the convention court-calendar.js documents and that
//  storedDay(), hearing-when.js and client-profiles.js all read back.
//
//  ── DELETING ──────────────────────────────────────────────
//
//  Soft, via deleted_at. A deleted event disappears from the calendar
//  and from the feed, and the row stays. Two reasons: a calendar
//  subscriber that has already seen the event needs a CANCELLED
//  instruction rather than silence, and an appointment somebody deleted
//  by accident is worth being able to find.
// ============================================================

const db = () => require("./db");

// 24-hour, zero-padded. The only shape stored, so everything reading
// these can split on the colon without a parser.
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

let ready = null;
async function initTable() {
  if (ready) return ready;
  ready = (async () => {
    await db().query(`
      CREATE TABLE IF NOT EXISTS firm_events (
        id           SERIAL PRIMARY KEY,
        title        TEXT NOT NULL,
        -- A DATE and a time as text. See the header: not a timestamp.
        event_day    DATE NOT NULL,
        start_time   TEXT,
        end_time     TEXT,
        place        TEXT,
        note         TEXT,
        kind         TEXT NOT NULL DEFAULT 'appointment',
        -- Whose file it belongs on. Either, both, or neither.
        client_key   TEXT,
        client_name  TEXT,
        a_number     TEXT,
        matter_id    TEXT,
        -- Billable against that matter. The time entry it created, if any,
        -- so the same event cannot be billed twice.
        billable     BOOLEAN NOT NULL DEFAULT FALSE,
        time_entry_id INTEGER,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        created_by   TEXT,
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_by   TEXT,
        deleted_at   TIMESTAMPTZ,
        deleted_by   TEXT
      )
    `);
    await db().query(`
      CREATE INDEX IF NOT EXISTS firm_events_day
        ON firm_events (event_day) WHERE deleted_at IS NULL`);
    await db().query(`
      CREATE INDEX IF NOT EXISTS firm_events_client
        ON firm_events (client_key) WHERE deleted_at IS NULL`);
    await db().query(`
      CREATE INDEX IF NOT EXISTS firm_events_matter
        ON firm_events (matter_id) WHERE deleted_at IS NULL`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

const KINDS = ["appointment", "consultation", "signing", "deadline", "court", "internal", "other"];

/** A YYYY-MM-DD, or null. Never a Date: see the header. */
function cleanDay(v) {
  const s = String(v || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * A time as HH:MM, or null.
 *
 * Accepts what a person types -- "9:30", "9:30 AM", "14:00" -- and stores
 * one shape. A bare "9:30" is read as 9:30 in the morning, which is the
 * only reading an appointment book has: unlike a court notice, where
 * guessing am or pm is how a client misses a hearing, this value was
 * typed by the person who knows what they meant and can see it on screen.
 */
function cleanTime(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (TIME.test(s)) return s;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const mi = m[2] ? parseInt(m[2], 10) : 0;
    if (h < 1 || h > 12 || mi > 59) return null;
    const pm = m[3].toLowerCase() === "p";
    if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  }
  const bare = s.match(/^(\d{1,2}):(\d{2})$/);
  if (bare) {
    const h = parseInt(bare[1], 10), mi = parseInt(bare[2], 10);
    if (h <= 23 && mi <= 59) return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  }
  return null;
}

function fields(input = {}) {
  const day = cleanDay(input.event_day || input.day || input.date);
  const start = cleanTime(input.start_time || input.start);
  let end = cleanTime(input.end_time || input.end);
  // An end before its start is not a short meeting, it is a typo. Dropped
  // rather than stored, so nothing downstream has to cope with it.
  if (end && start && end <= start) end = null;
  const kind = KINDS.includes(String(input.kind || "").toLowerCase())
    ? String(input.kind).toLowerCase() : "appointment";
  return {
    title: String(input.title || "").trim().slice(0, 300),
    event_day: day,
    start_time: start,
    end_time: end,
    place: String(input.place || "").trim().slice(0, 300) || null,
    note: String(input.note || "").trim().slice(0, 4000) || null,
    kind,
    client_key: String(input.client_key || "").trim() || null,
    client_name: String(input.client_name || "").trim() || null,
    a_number: String(input.a_number || "").trim() || null,
    matter_id: String(input.matter_id || "").trim() || null,
    billable: input.billable === true || input.billable === "on" || input.billable === "true",
  };
}

/** How long it runs, in minutes, or null when there is no end. */
function minutesOf(ev) {
  if (!ev || !ev.start_time || !ev.end_time) return null;
  const [sh, sm] = ev.start_time.split(":").map(Number);
  const [eh, em] = ev.end_time.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  return mins > 0 ? mins : null;
}

async function create(input, { by = null } = {}) {
  await initTable();
  const f = fields(input);
  if (!f.title) throw new Error("An event needs a title.");
  if (!f.event_day) throw new Error("An event needs a date, as YYYY-MM-DD.");
  if (f.billable && !f.matter_id) throw new Error("Billable time has to be against a matter.");
  const r = await db().query(
    `INSERT INTO firm_events
       (title, event_day, start_time, end_time, place, note, kind,
        client_key, client_name, a_number, matter_id, billable, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
     RETURNING *`,
    [f.title, f.event_day, f.start_time, f.end_time, f.place, f.note, f.kind,
     f.client_key, f.client_name, f.a_number, f.matter_id, f.billable, by]
  );
  return r.rows[0];
}

async function update(id, input, { by = null } = {}) {
  await initTable();
  const f = fields(input);
  if (!f.title) throw new Error("An event needs a title.");
  if (!f.event_day) throw new Error("An event needs a date, as YYYY-MM-DD.");
  if (f.billable && !f.matter_id) throw new Error("Billable time has to be against a matter.");
  const r = await db().query(
    `UPDATE firm_events SET
       title=$2, event_day=$3, start_time=$4, end_time=$5, place=$6, note=$7, kind=$8,
       client_key=$9, client_name=$10, a_number=$11, matter_id=$12, billable=$13,
       updated_at=NOW(), updated_by=$14
     WHERE id=$1 AND deleted_at IS NULL
     RETURNING *`,
    [parseInt(id, 10), f.title, f.event_day, f.start_time, f.end_time, f.place, f.note,
     f.kind, f.client_key, f.client_name, f.a_number, f.matter_id, f.billable, by]
  );
  return r.rows[0] || null;
}

async function get(id) {
  await initTable();
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  const r = await db().query(`SELECT * FROM firm_events WHERE id = $1`, [n]);
  return r.rows[0] || null;
}

/** Soft delete. The row stays so a feed can say CANCELLED. */
async function remove(id, { by = null } = {}) {
  await initTable();
  const r = await db().query(
    `UPDATE firm_events SET deleted_at = NOW(), deleted_by = $2
     WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [parseInt(id, 10), by]
  );
  return r.rows[0] || null;
}

async function restore(id, { by = null } = {}) {
  await initTable();
  const r = await db().query(
    `UPDATE firm_events SET deleted_at = NULL, deleted_by = NULL,
       updated_at = NOW(), updated_by = $2
     WHERE id = $1 RETURNING *`,
    [parseInt(id, 10), by]
  );
  return r.rows[0] || null;
}

async function listBetween(fromDay, toDay, { includeDeleted = false } = {}) {
  await initTable();
  const where = [];
  const params = [];
  if (!includeDeleted) where.push("deleted_at IS NULL");
  const a = cleanDay(fromDay); const b = cleanDay(toDay);
  if (a) { params.push(a); where.push(`event_day >= $${params.length}`); }
  if (b) { params.push(b); where.push(`event_day <= $${params.length}`); }
  const r = await db().query(
    `SELECT * FROM firm_events ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY event_day ASC, COALESCE(start_time, '00:00') ASC`, params);
  return r.rows;
}

async function listForClient(clientKey) {
  await initTable();
  if (!clientKey) return [];
  const r = await db().query(
    `SELECT * FROM firm_events WHERE client_key = $1 AND deleted_at IS NULL
     ORDER BY event_day DESC, COALESCE(start_time, '00:00') DESC`, [clientKey]);
  return r.rows;
}

async function listForMatter(matterId) {
  await initTable();
  if (!matterId) return [];
  const r = await db().query(
    `SELECT * FROM firm_events WHERE matter_id = $1 AND deleted_at IS NULL
     ORDER BY event_day DESC, COALESCE(start_time, '00:00') DESC`, [String(matterId)]);
  return r.rows;
}

/**
 * The SQL the Calendar page unions in, as its seventh source.
 *
 * THE ONE CONVERSION. The other six sources hand that page a
 * timestamptz, so this one has to as well. `(day + time) AT TIME ZONE
 * 'UTC'` takes the date and the typed time, treats them as a wall clock,
 * and stamps them UTC -- which is exactly the convention
 * court-calendar.js documents and every reader of these values uses.
 * Using 'America/Los_Angeles' here instead would be the 2026-10-09 bug
 * again, one layer down.
 */
function calendarSql(extraConditions = []) {
  const where = ["deleted_at IS NULL", ...extraConditions.filter(Boolean)];
  return `
    SELECT 'firm_event' as source, id::text as source_id,
           client_key,
           COALESCE(NULLIF(client_name, ''), title) as client_name,
           a_number,
           ((event_day + COALESCE(start_time, '00:00')::time) AT TIME ZONE 'UTC') as event_date,
           kind as event_subtype,
           NULL as judge_name, place as court_name, NULL as court_address,
           COALESCE(note, title) as description,
           NULL as priority, NULL as status
    FROM firm_events
    WHERE ${where.join(" AND ")}`;
}

/** One VEVENT per hand-entered event, for the outbound .ics. */
function icsRows(events = []) {
  return events.map((e) => ({
    uid: `firm-event-${e.id}@tezlawfirm.com`,
    day: typeof e.event_day === "string" ? e.event_day.slice(0, 10)
      : new Date(e.event_day).toISOString().slice(0, 10),
    start: e.start_time || null,
    end: e.end_time || null,
    summary: e.title,
    location: e.place || "",
    description: [e.note, e.client_name ? `Client: ${e.client_name}` : "",
      e.matter_id ? `Matter: ${e.matter_id}` : ""].filter(Boolean).join("\n"),
    cancelled: !!e.deleted_at,
  }));
}

/**
 * Bill the event against its matter.
 *
 * Writes one time_entries row and remembers its id on the event, so
 * pressing the button twice does not bill the client twice. Needs a
 * staff id, which is req.user.uid on an admin route.
 */
async function bill(id, { staffId, rateCents = null } = {}) {
  await initTable();
  const ev = await get(id);
  if (!ev) throw new Error("No such event.");
  if (ev.deleted_at) throw new Error("That event was deleted.");
  if (!ev.billable) throw new Error("That event is not marked billable.");
  if (!ev.matter_id) throw new Error("Billable time has to be against a matter.");
  if (ev.time_entry_id) return { already: true, time_entry_id: ev.time_entry_id };
  const minutes = minutesOf(ev);
  if (!minutes) throw new Error("Give the event a start and an end time before billing it.");
  if (!staffId) throw new Error("No signed-in person to bill the time to.");

  const te = await db().query(
    `INSERT INTO time_entries
       (staff_id, client_key, description, minutes, hourly_rate_cents, billable, entry_date)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6::date) RETURNING id`,
    [staffId, ev.client_key || null, `${ev.title}${ev.place ? ` (${ev.place})` : ""}`,
     minutes, rateCents, typeof ev.event_day === "string"
       ? ev.event_day.slice(0, 10) : new Date(ev.event_day).toISOString().slice(0, 10)]
  );
  const entryId = te.rows[0].id;
  await db().query(`UPDATE firm_events SET time_entry_id = $2, updated_at = NOW() WHERE id = $1`,
    [ev.id, entryId]);
  return { already: false, time_entry_id: entryId, minutes };
}

module.exports = {
  KINDS, TIME, initTable, cleanDay, cleanTime, fields, minutesOf,
  create, update, get, remove, restore,
  listBetween, listForClient, listForMatter,
  calendarSql, icsRows, bill,
};
