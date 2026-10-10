// ============================================================
//  firm-events-page.js — adding, changing and deleting a
//                        calendar entry
//  ─────────────────────────────────────────────────────────
//  One form, used for both new and existing events, because a new-event
//  form and an edit form that drift apart is how a field ends up
//  editable in one and not the other. The only differences are where it
//  posts and whether the Delete button is there.
//
//  No inline script, no onclick: these pages are JavaScript template
//  literals. See notify-admin.js:11.
//
//  The date box is <input type="date">, which hands back YYYY-MM-DD, and
//  the times are <input type="time">, which hand back HH:MM. That is
//  exactly what firm-events.js stores, so the usual place a date gets
//  mangled -- parsing what somebody typed -- is not in the path at all.
//  cleanTime still accepts "9:30 AM" for anything posted by hand.
// ============================================================

const E = require("./firm-events");

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CARD = "background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:18px 20px; margin-bottom:14px;";
const LABEL = "font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#A34C00; font-weight:700; margin:0 0 12px;";
const FIELD = "padding:8px 10px; border:1px solid #CFC8BE; border-radius:4px; font-size:14px; box-sizing:border-box; width:100%; font-family:inherit;";
const ROW = "display:grid; grid-template-columns:150px minmax(0,1fr); gap:10px 12px; align-items:center; margin-bottom:10px; max-width:620px;";
const BTN = "padding:9px 16px; background:#FF7B00; color:#1E1B1A; border:1px solid #9C2B1E; border-radius:4px; cursor:pointer; font-size:14px; font-weight:600;";
const BTN_QUIET = "padding:9px 16px; background:#F3EFE9; color:#2B2523; border:1px solid #E8E3DC; border-radius:4px; cursor:pointer; font-size:14px; text-decoration:none; display:inline-block;";
const BTN_BAD = "padding:9px 16px; background:#FBEDEA; color:#9C2B1E; border:1px solid #9C2B1E; border-radius:4px; cursor:pointer; font-size:14px;";

const KIND_LABELS = {
  appointment: "Appointment",
  consultation: "Consultation",
  signing: "Signing",
  deadline: "Deadline",
  court: "Court",
  internal: "Internal",
  other: "Other",
};

/** YYYY-MM-DD out of whatever the row carries, for the date box. */
function dayValue(v) {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  const d = new Date(v);
  // A DATE column comes back as a Date at midnight UTC. Read in UTC, or
  // the box offers the day before. Same rule as everywhere else here.
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

function renderEventForm(event, { error = null, clients = [] } = {}) {
  const ev = event || {};
  const isNew = !ev.id;
  const action = isNew ? "/admin/calendar/event" : `/admin/calendar/event/${ev.id}`;

  const row = (label, control, hint) => `
    <div style="${ROW}">
      <label style="font-size:13px; color:#5E5854;">${esc(label)}</label>
      <div>${control}${hint ? `<div style="font-size:11px; color:#8A827C; margin-top:4px;">${esc(hint)}</div>` : ""}</div>
    </div>`;

  return `
  <div style="max-width:760px;">
    <p style="margin:0 0 4px; font-size:13px; color:#5E5854;">
      <a href="/admin/calendar" style="color:#A34C00;">&larr; Calendar</a>
    </p>
    <h1 style="margin:0 0 14px; font-size:24px; color:#2B2523;">
      ${isNew ? "Add a calendar entry" : "Edit this calendar entry"}
    </h1>

    ${error ? `<div style="${CARD} border-left:4px solid #9C2B1E; background:#FBEDEA;">
      <strong style="color:#9C2B1E;">Not saved.</strong>
      <div style="margin-top:4px; color:#2B2523;">${esc(error)}</div>
    </div>` : ""}

    ${!isNew && ev.deleted_at ? `<div style="${CARD} border-left:4px solid #9C2B1E;">
      <strong style="color:#9C2B1E;">This entry is deleted.</strong>
      <div style="font-size:13px; color:#5E5854; margin-top:4px;">
        It is off the calendar and out of the feed. The record is kept.
      </div>
      <form method="POST" action="/admin/calendar/event/${ev.id}/restore" style="margin-top:10px;">
        <button type="submit" style="${BTN_QUIET}">Put it back</button>
      </form>
    </div>` : ""}

    <form method="POST" action="${esc(action)}" style="${CARD}">
      <p style="${LABEL}">What and when</p>
      ${row("Title", `<input type="text" name="title" required maxlength="300"
          value="${esc(ev.title || "")}" style="${FIELD}" placeholder="Consultation — Chen Peng">`)}
      ${row("Kind", `<select name="kind" style="${FIELD}">
          ${E.KINDS.map((k) => `<option value="${esc(k)}"${(ev.kind || "appointment") === k ? " selected" : ""}>${esc(KIND_LABELS[k] || k)}</option>`).join("")}
        </select>`)}
      ${row("Date", `<input type="date" name="event_day" required
          value="${esc(dayValue(ev.event_day))}" style="${FIELD}">`)}
      ${row("Starts", `<input type="time" name="start_time"
          value="${esc(ev.start_time || "")}" style="${FIELD}">`,
        "Leave both times empty for an all-day entry.")}
      ${row("Ends", `<input type="time" name="end_time"
          value="${esc(ev.end_time || "")}" style="${FIELD}">`)}
      ${row("Place", `<input type="text" name="place" maxlength="300"
          value="${esc(ev.place || "")}" style="${FIELD}" placeholder="West Covina office, or a courtroom">`)}
      ${row("Note", `<textarea name="note" rows="3" maxlength="4000"
          style="${FIELD}">${esc(ev.note || "")}</textarea>`)}

      <p style="${LABEL} margin-top:20px;">Whose file it belongs on</p>
      ${row("Client", `<input type="text" name="client_name" list="firm-event-clients" maxlength="200"
          value="${esc(ev.client_name || "")}" style="${FIELD}" placeholder="Optional">
        <datalist id="firm-event-clients">
          ${clients.slice(0, 400).map((c) => `<option value="${esc(c.client_name || "")}"></option>`).join("")}
        </datalist>`,
        "Typing a name here puts the entry on that client's file.")}
      ${row("Client key", `<input type="text" name="client_key" maxlength="200"
          value="${esc(ev.client_key || "")}" style="${FIELD}" placeholder="Optional, e.g. a-201555444">`)}
      ${row("A-Number", `<input type="text" name="a_number" maxlength="40"
          value="${esc(ev.a_number || "")}" style="${FIELD}" placeholder="Optional">`)}
      ${row("Matter", `<input type="text" name="matter_id" maxlength="100"
          value="${esc(ev.matter_id || "")}" style="${FIELD}" placeholder="Optional">`)}
      ${row("Billable", `<label style="display:flex; align-items:center; gap:8px; font-size:14px;">
          <input type="checkbox" name="billable" ${ev.billable ? "checked" : ""} style="width:18px; height:18px;">
          <span style="color:#5E5854;">Bill the time against that matter</span>
        </label>`,
        "Needs a matter, a start and an end. Marking it billable does not create the time entry; the button below does.")}

      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:18px;">
        <button type="submit" style="${BTN}">${isNew ? "Add it to the calendar" : "Save changes"}</button>
        <a href="/admin/calendar" style="${BTN_QUIET}">Cancel</a>
      </div>
    </form>

    ${!isNew && !ev.deleted_at ? `
    <div style="${CARD}">
      <p style="${LABEL}">Time</p>
      ${ev.time_entry_id ? `
        <p style="font-size:13px; color:#2B2523; margin:0;">
          Billed as time entry #${esc(String(ev.time_entry_id))}${
            E.minutesOf(ev) ? `, ${esc(String(E.minutesOf(ev)))} minutes` : ""}.
          It will not be billed again from here.
        </p>`
      : ev.billable ? `
        <form method="POST" action="/admin/calendar/event/${ev.id}/bill" style="margin:0;">
          <p style="font-size:13px; color:#5E5854; margin:0 0 10px;">
            ${E.minutesOf(ev)
              ? `${esc(String(E.minutesOf(ev)))} minutes against matter ${esc(ev.matter_id || "")}.`
              : "Give it a start and an end time first."}
          </p>
          <button type="submit" style="${BTN_QUIET}" ${E.minutesOf(ev) ? "" : "disabled"}>
            Create the time entry
          </button>
        </form>`
      : `<p style="font-size:13px; color:#5E5854; margin:0;">Not marked billable.</p>`}
    </div>

    <div style="${CARD}">
      <p style="${LABEL}">Delete</p>
      <p style="font-size:13px; color:#5E5854; margin:0 0 10px;">
        It comes off the calendar and out of the .ics feed. The record is kept, so a calendar
        that has already seen it can be told the appointment is cancelled, and so an entry
        deleted by mistake can be found again.
      </p>
      <form method="POST" action="/admin/calendar/event/${ev.id}/delete" style="margin:0;">
        <button type="submit" style="${BTN_BAD}">Delete this entry</button>
      </form>
    </div>` : ""}

    <div style="margin-bottom:28px;"></div>
  </div>`;
}

/** The "+ Add entry" button for the Calendar page's own toolbar. */
function addButton() {
  return `<a href="/admin/calendar/event" style="background:#FF7B00; color:#1E1B1A; padding:8px 14px;
    border:1px solid #9C2B1E; border-radius:4px; text-decoration:none; font-size:13px;
    font-weight:600;">+ Add entry</a>`;
}

module.exports = { renderEventForm, addButton, dayValue, KIND_LABELS };
