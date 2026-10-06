// ============================================================
//  court-calendar.js: the firm's court calendar, read for Zara
// ============================================================
//
//  One read-only function, read(), that gathers what the Calendar
//  screen in the Tara app and the admin Calendar page show:
//
//    1. the admin Calendar page (eoir-calendar.js): EOIR notices,
//       hearing notes and the synced Outlook calendars, with the
//       same hearing from two sources already merged;
//    2. notices on file that the Tara app lists and that page
//       leaves out;
//    3. civil court hearings;
//    4. open immigration deadlines: everything overdue, and what
//       falls due in the days asked for;
//    5. hearings and interviews that exist only as a task.
//
//  WHY IT EXISTS. Zara's hearing look-up used to read the task
//  list alone, so "any hearings this week?" was answered "none"
//  on a week with hearings on the calendar. Update 13 gave the
//  ops group this reader (it lived in tg-ask.js). Update 14 moved
//  it here so the Zara chat in the Tara app answers from it too.
//
//  WHO SEES WHAT. Pass `visibleKeys`:
//    null        the whole calendar: the ops group, and an admin
//                or manager in the app.
//    a Set       that person's own clients only, which is what
//                their Calendar screen shows (app-api.js
//                getVisibleClientKeys). Notices, civil hearings
//                deadlines and hearing tasks are matched by client
//                key. Hearing notes and synced calendar entries
//                have no client key, so they are left out rather
//                than guessed at.
//  The caller decides. This file never widens a Set to null.
//
//  DATES. A notice's hearing is stored as the date and time
//  printed on it, with no zone, so it is read back the same way
//  and never converted. "Today" is the office's day (Pacific).
// ============================================================

const db = () => require("./db");

const PT = "America/Los_Angeles";
// Today's date in the office's time zone, as YYYY-MM-DD.
const todayPT = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// The hour of the day in the office, 0-23.
//
// Three crons used to add a fixed -8 to the UTC hour. That is right from
// November to March and wrong for the other eight months, so every job that
// called itself "7 AM Pacific" actually ran at 8 AM through all of PDT.
// hourCycle h23 rather than hour12:false on purpose: some ICU builds render
// midnight as "24" with hour12:false, which would make an hour-0 job never
// match and a 3 AM one fire on the wrong side of the night.
const firmHour = (now = new Date()) =>
  parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: PT, hour: "2-digit", hourCycle: "h23" })
    .format(now), 10) % 24;
const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });
// Hearing dates are stored as the date and time printed on the notice, with
// no zone, so they are read back the same way (in UTC), never converted:
// converting moves a 9:00 hearing, or puts a midnight one on the day before.
// The Calendar page reads them this way too, so the answers match it.
const storedDay = (v) => { const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
function storedTime(v) {
  const d = new Date(v);
  if (isNaN(d) || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) return null;   // midnight = no time was given
  const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}
// A synced calendar is the exception. Outlook publishes local times, which are
// stored like the notices. Google publishes true instants ("…Z"), and those
// have to be converted to Pacific time or a 9:00 hearing reads as 4:00 PM.
// Which kind an event is can only be told from its original DTSTART line.
function instantPT(v) {
  const d = new Date(v);
  if (isNaN(d)) return null;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: PT, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return { day, time };
}
// Minutes after midnight for "9:00 AM" / "1:30 pm" / "13:30"; -1 when there is no usable time.
function minutesOf(t) {
  const m = String(t || "").match(/(\d{1,2})[:.](\d{2})\s*([AaPp])?/);
  if (!m) return -1;
  let h = parseInt(m[1], 10);
  if (m[3]) { const pm = /p/i.test(m[3]); h = (h % 12) + (pm ? 12 : 0); }
  return h * 60 + parseInt(m[2], 10);
}
const CALENDAR_SOURCE = {
  hearing_notice: "EOIR notice", hearing_note_upcoming: "hearing note", hearing_note_past: "hearing note (hearing held)",
  individual_hearing: "merits hearing note", individual_upcoming: "next action on a merits note", outlook_event: "synced calendar",
};
const CALENDAR_MAX = 60;

async function read(args, { now = new Date(), visibleKeys = null } = {}) {
  // A Set means "this person's own clients only" (see the top of the file); null means the whole calendar.
  const scoped = visibleKeys instanceof Set;
  const mine = (rows) => scoped ? rows.filter(r => r.client_key && visibleKeys.has(r.client_key)) : rows;
  const n = parseInt(args && args.days, 10);
  const days = Number.isInteger(n) && n > 0 ? Math.min(365, n) : 14;
  const client = String((args && (args.client || args.query)) || "").trim().slice(0, 80);
  const like = client ? `%${client}%` : null;
  const first = todayPT(now), last = addDays(first, days);
  const from = `${first}T00:00:00Z`, to = `${last}T23:59:59Z`;
  const unavailable = [];
  const attempt = async (what, fn, fallback) => {
    try { return await fn(); } catch (e) {
      // A table that has never been created (42P01) holds nothing: that is an
      // empty list, not a calendar that could not be read.
      if (e && e.code === "42P01") return fallback;
      console.warn(`[court-calendar] ${what}:`, e.message); unavailable.push(what); return fallback;
    }
  };

  // 1. The calendar the admin page shows (its own duplicates already merged).
  //    Its hearing notes and synced entries carry no client link, so a scoped reader does not get them.
  const events = scoped ? [] : await attempt("court calendar", () =>
    require("./eoir-calendar").getUnifiedEvents({ from_date: from, to_date: to, client_search: client || undefined }), []);

  // 2. The notices themselves: the time as printed, and any notice the Tara
  //    app's Calendar lists that the page above leaves out.
  const notices = mine(await attempt("hearing notices", async () => (await db().query(
    `SELECT id::text AS id, client_key, client_name, a_number, hearing_date, hearing_time_text, hearing_type, court_name, judge_name
       FROM client_hearing_notices
      WHERE hearing_date >= $1 AND hearing_date <= $2 AND dismissed_at IS NULL
        AND ($3::text IS NULL OR client_name ILIKE $3 OR a_number ILIKE $3)
      ORDER BY hearing_date ASC LIMIT 400`, [from, to, like])).rows, []));
  const noticeById = new Map(notices.map(x => [x.id, x]));
  const seenNotices = new Set();

  // How each synced event's time was published (see instantPT above).
  const refsOf = (e) => e.source_refs || [{ source: e.source, id: e.source_id }];
  const syncedIds = [...new Set(events.flatMap(e => refsOf(e).filter(r => r.source === "outlook_event").map(r => parseInt(r.id, 10))).filter(Number.isInteger))];
  const synced = new Map(syncedIds.length ? (await attempt("synced calendar times", async () => (await db().query(
    `SELECT id::text AS id, start_datetime, COALESCE(all_day, FALSE) AS all_day,
            substring(raw_ical from 'DTSTART[^\r\n]*') AS dtstart
       FROM outlook_synced_events WHERE id = ANY($1::int[])`, [syncedIds])).rows, [])).map(x => [x.id, x]) : []);

  const hearings = [];
  for (const e of events) {
    if (e.source === "deadline") continue;                       // deadlines are listed below, with the overdue ones
    let day = storedDay(e.event_date);
    if (!day) continue;
    const refs = refsOf(e);
    let printed = null, typed = null;
    for (const r of refs) {
      if (r.source === "outlook_event") {
        const sv = synced.get(String(r.id));
        if (!sv || sv.all_day || typed) continue;
        if (/Z\s*$/.test(sv.dtstart || "")) { const pt = instantPT(sv.start_datetime); if (pt) { typed = pt.time; if (e.source === "outlook_event") day = pt.day; } }
        else if (sv.dtstart) typed = storedTime(sv.start_datetime);
        continue;
      }
      if (r.source !== "hearing_notice") continue;
      seenNotices.add(String(r.id));
      const nt = noticeById.get(String(r.id));
      if (nt && nt.hearing_time_text && !printed) printed = nt.hearing_time_text;
    }
    // A synced event with no readable DTSTART keeps its day and gives no time, rather than a time that may be hours out.
    const hasSynced = refs.some(r => r.source === "outlook_event");
    const time = typed || printed || (hasSynced ? null : storedTime(e.event_date));
    if (day < first || day > last) continue;                     // a converted instant can fall just outside the window
    const sources = [...new Set((e.sources || [e.source]).map(s => (s === "outlook_event" && e.feed_name) ? `calendar: ${e.feed_name}` : (CALENDAR_SOURCE[s] || s)))];
    const fromCalendarOnly = e.source === "outlook_event";
    hearings.push({
      day, weekday: weekdayOf(day), time,
      client: e.client_name || null, a_number: e.a_number || null,
      type: e.event_subtype && e.event_subtype !== "outlook" ? e.event_subtype : null,
      court: e.court_name || null, judge: e.judge_name || null,
      entry: fromCalendarOnly && e.description && e.description !== e.client_name ? String(e.description).slice(0, 160) : undefined,
      on_calendar_as: sources.join(", "),
    });
  }
  for (const nt of notices) {
    if (seenNotices.has(nt.id)) continue;
    const day = storedDay(nt.hearing_date);
    if (!day) continue;
    // The page merges the same client on the same day; do the same here.
    const same = hearings.find(h => h.day === day && (
      (nt.a_number && h.a_number && String(nt.a_number).replace(/\D/g, "") === String(h.a_number).replace(/\D/g, "")) ||
      (nt.client_name && h.client && String(nt.client_name).toLowerCase().trim() === String(h.client).toLowerCase().trim())));
    if (same) { if (!same.time && nt.hearing_time_text) same.time = nt.hearing_time_text; continue; }
    hearings.push({
      day, weekday: weekdayOf(day), time: nt.hearing_time_text || storedTime(nt.hearing_date),
      client: nt.client_name || null, a_number: nt.a_number || null, type: nt.hearing_type || null,
      court: nt.court_name || null, judge: nt.judge_name || null, entry: undefined,
      on_calendar_as: scoped ? "EOIR notice" : "notice on file",
    });
  }

  // 3. Civil court hearings (the civil module keeps its own).
  const civil = mine(await attempt("civil hearings", async () => (await db().query(
    `SELECT to_char(h.hearing_date, 'YYYY-MM-DD') AS day, h.hearing_time, h.hearing_type, h.department, h.judge, h.location,
            h.appearance, c.case_name, c.case_number, c.court, c.client_key
       FROM civil_hearings h JOIN civil_cases c ON c.id = h.case_id
      WHERE h.status = 'scheduled' AND h.hearing_date >= $1::date AND h.hearing_date <= $2::date
        AND ($3::text IS NULL OR c.case_name ILIKE $3 OR c.case_number ILIKE $3)
      ORDER BY h.hearing_date ASC LIMIT 200`, [first, last, like])).rows, []));
  for (const h of civil) {
    hearings.push({
      day: h.day, weekday: weekdayOf(h.day), time: h.hearing_time || null,
      client: h.case_name || null, a_number: null,
      type: h.hearing_type ? String(h.hearing_type).replace(/_/g, " ") : null,
      court: [h.court, h.department ? `Dept. ${h.department}` : null, h.location].filter(Boolean).join(", ") || null,
      judge: h.judge || null,
      entry: [h.case_number ? `case no. ${h.case_number}` : null, h.appearance ? String(h.appearance).replace(/_/g, " ") : null].filter(Boolean).join("; ") || undefined,
      on_calendar_as: "civil case hearing",
    });
  }
  hearings.sort((a, b) => a.day.localeCompare(b.day) || minutesOf(a.time) - minutesOf(b.time));

  // 4. Open immigration deadlines: everything overdue, and what falls due in the window.
  //    A deadline has no client key of its own; the app's Calendar derives one from the A-number or name, and so does this.
  const deadlines = mine(await attempt("deadlines", async () => (await db().query(
    `SELECT client_name, a_number, description, priority, to_char(due_date, 'YYYY-MM-DD') AS due
            ${scoped ? `, ${require("./client-record").KEY_SQL} AS client_key` : ""}
       FROM deadlines
      WHERE status = 'pending' AND due_date <= $1::date
        AND ($2::text IS NULL OR client_name ILIKE $2 OR a_number ILIKE $2)
      ORDER BY due_date ASC LIMIT 400`, [last, like])).rows, [])).map(d => ({
        due: d.due, overdue: d.due < first, client: d.client_name || null, a_number: d.a_number || null,
        what: String(d.description || "").slice(0, 200), priority: d.priority && d.priority !== "normal" ? d.priority : undefined,
      }));

  // 5. Hearings, interviews and court dates that exist only as a task on the task list.
  //    The words are looked for in the task's title as well as its description:
  //    the old look-up read the description alone, and the title is where "USCIS interview" is usually typed.
  const hearingTasks = mine(await attempt("task list", async () => (await db().query(
    `SELECT t.client_key, t.client_name, t.matter_type, t.title, t.description, to_char(t.due_date, 'YYYY-MM-DD') AS due, t.assigned_to
       FROM tasks t
      WHERE t.due_date IS NOT NULL AND t.due_date >= $1::date AND t.due_date <= $2::date
        AND t.status NOT IN ('completed', 'cancelled', 'rejected', 'pending_approval')
        AND LOWER(COALESCE(t.title, '') || ' ' || COALESCE(t.description, '')) ~ '(hearing|court|interview|deposition|uscis)'
        AND ($3::text IS NULL OR t.client_name ILIKE $3)
      ORDER BY t.due_date ASC LIMIT 200`, [first, last, like])).rows, [])).slice(0, 30).map(t => ({
        due: t.due, client: t.client_name || null, matter_type: t.matter_type || null,
        what: [t.title, t.description].map(x => String(x || "").trim()).filter((x, i, a) => x && a.indexOf(x) === i).join(": ").slice(0, 240),
        assigned_to: t.assigned_to || null,
      }));

  const out = {
    today: first, from: first, through: last, days,
    ...(client ? { client_filter: client } : {}),
    hearings: hearings.slice(0, CALENDAR_MAX),
    deadlines: deadlines.slice(0, CALENDAR_MAX),
    hearing_tasks: hearingTasks,
    note: "Times are as printed on the notice or typed on the calendar. hearing_tasks are to-do items on the task list, not calendar entries." +
      (scoped ? " This is limited to this person's own clients, as on their Calendar screen in the app; hearing notes and synced calendar entries carry no client link and are not included. An admin or manager sees the whole calendar."
              : " The Matter Manager keeps its own deadlines and hearings."),
  };
  if (scoped) out.limited_to_own_clients = true;
  if (hearings.length > CALENDAR_MAX) out.more_hearings_not_shown = hearings.length - CALENDAR_MAX;
  if (deadlines.length > CALENDAR_MAX) out.more_deadlines_not_shown = deadlines.length - CALENDAR_MAX;
  // An empty list is only "nothing scheduled" if every source answered.
  if (unavailable.length) out.could_not_read = unavailable, out.warning = "Part of the calendar could not be read just now, so this may be incomplete. Say so; do not say nothing is scheduled.";
  return out;
}

module.exports = { read, todayPT, firmHour, addDays, storedDay, storedTime, instantPT, minutesOf, CALENDAR_MAX };
