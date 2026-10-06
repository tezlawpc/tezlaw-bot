// ============================================================
//  hearing-when.js — how a hearing's date and time are stated
//                    to a client. Quoted, never computed.
//  ─────────────────────────────────────────────────────────
//  THE BUG THIS EXISTS TO END
//  A reminder for a custody redetermination at Imperial said
//  "Tuesday, October 6, 2026 at 12:00 PM". The notice said 9:00 AM.
//
//  Two faults, compounding:
//
//  1. hearing_time_text — "9:00 AM", parsed correctly out of the PDF and
//     stored — was never read by either message builder. Both formatted
//     hearing_date instead, which for a notice carries 12:00:00Z: a
//     date-only placeholder at noon UTC, not a real instant.
//
//  2. Both called toLocaleString() with no timeZone, so the placeholder
//     rendered in the server's zone. Render runs UTC. Noon UTC printed as
//     "12:00 PM" and looked like a real time.
//
//  A client told noon for a 9:00 AM custody hearing misses it. For a
//  detained client that is not a usability problem.
//
//  THE RULE
//  Never compute a time for a client. The notice is the authority: quote
//  hearing_time_text verbatim. If there is no time text, say so and give the
//  firm's number — an unconfirmed time is safe, an invented one is not.
//
//  The DATE is formatted in UTC on purpose. These values are date-only,
//  stored at noon UTC, so their UTC calendar date is the real date;
//  rendering a date-only value in a zone behind UTC is how you print the
//  day before.
//
//  Both senders — hearing-notices.js (a human clicks it) and
//  hearing-reminders.js (a 7 AM cron sends it unattended) — come through
//  here. They each had their own copy of this formatting, and their own copy
//  of this bug, which is why there is now one.
// ============================================================

// A time we are willing to repeat. The notice parser is not perfect, and a
// malformed value is better dropped than passed to a client as fact.
// Hour and minute are range-checked, not just shaped. An earlier version of
// this regex accepted "99:99 AM" — a parser artefact would have been quoted
// to a client as a hearing time, which is the whole failure this file exists
// to prevent, reintroduced one layer down.
const TIME_SHAPE = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i;

const PHRASES = {
  en: {
    join: (d, t) => `${d} at ${t}`,
    noTime: (d) => `${d} — time not confirmed, please call us at 626-678-8677`,
    noDate: "(date not confirmed — please call us at 626-678-8677)",
    locale: "en-US",
    fallbackKind: "hearing",
  },
  zh: {
    join: (d, t) => `${d} ${t}`,
    noTime: (d) => `${d} — 开庭时间未确认，请致电 626-678-8677`,
    noDate: "（日期未确认 — 请致电 626-678-8677）",
    locale: "zh-CN",
    fallbackKind: "",
  },
  es: {
    join: (d, t) => `${d} a las ${t}`,
    noTime: (d) => `${d} — hora sin confirmar, llámenos al 626-678-8677`,
    noDate: "(fecha sin confirmar — llámenos al 626-678-8677)",
    locale: "es-MX",
    fallbackKind: "audiencia",
  },
};

function lang(l) {
  return PHRASES[l] ? l : "en";
}

/**
 * The time, exactly as the notice stated it, or null.
 * Never derived from a timestamp.
 */
function quotedTime(timeText) {
  const t = String(timeText == null ? "" : timeText).trim().replace(/\s+/g, " ");
  if (!t) return null;
  // Tolerate "9:00 AM", "9 AM", "9:00am", "1:30 p.m."; refuse anything else
  // rather than repeat a parser artefact to a client.
  const m = TIME_SHAPE.exec(t);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  // A court notice states a 12-hour clock time. "0:15 PM" and "99:99 AM" are
  // not times; they are evidence the parser misread the page.
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = m[3].toUpperCase() + "M";
  // Normalised, so two notices written differently read the same to a client.
  return m[2] === undefined ? `${hour} ${meridiem}` : `${hour}:${m[2]} ${meridiem}`;
}

/**
 * The calendar date, in UTC, with no time of day. See the note above on why
 * UTC: these are date-only values stored at noon UTC.
 */
function quotedDate(hearingDate, l) {
  if (!hearingDate) return null;
  const d = new Date(hearingDate);
  if (isNaN(d)) return null;
  return d.toLocaleDateString(PHRASES[l].locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The one line a client reads: when the hearing is.
 *
 * Takes a row with `hearing_date` and, where the source has one,
 * `hearing_time_text`. Sources that carry no time text (a master hearing's
 * next_hearing_date, say) correctly produce the "time not confirmed" form —
 * they never had a time to state in the first place.
 */
function hearingWhen(row, l) {
  const k = lang(l);
  const p = PHRASES[k];
  const date = quotedDate(row && row.hearing_date, k);
  if (!date) return p.noDate;
  const time = quotedTime(row && row.hearing_time_text);
  return time ? p.join(date, time) : p.noTime(date);
}

const KINDS = {
  en: { master: "Master Calendar", individual: "Individual/Merits", bond: "Bond", status: "Status", biometrics: "Biometrics", interview: "Interview" },
  zh: { master: "主听证", individual: "个人/庭审", bond: "保释", status: "状态", biometrics: "指纹采集", interview: "面谈" },
  es: { master: "Calendario Maestro", individual: "Individual/Méritos", bond: "Fianza", status: "Estado", biometrics: "Biometría", interview: "Entrevista" },
};

/**
 * What kind of hearing, as a qualifier that reads correctly in front of the
 * word "hearing" — the templates supply that word themselves.
 *
 * hearing_type is a short key ("bond") on some rows and a full phrase from a
 * court notice ("Custody Redetermination Hearing") on others. The phrase case
 * used to fall through to the generic fallback and produce "your upcoming
 * hearing hearing", so a real detail was thrown away AND it read as broken.
 * Now an unrecognised phrase is kept and its trailing "hearing" trimmed.
 */
function hearingKind(type, l) {
  const k = lang(l);
  const raw = String(type == null ? "" : type).trim();
  if (!raw) return PHRASES[k].fallbackKind;
  const mapped = KINDS[k][raw.toLowerCase()];
  if (mapped) return mapped;
  // A phrase from a notice: "Custody Redetermination Hearing" -> "Custody
  // Redetermination", so the template's own "hearing" is not doubled.
  const trimmed = raw.replace(/\s*hearings?\s*$/i, "").trim();
  return trimmed || PHRASES[k].fallbackKind;
}

module.exports = { hearingWhen, hearingKind, quotedTime, quotedDate };
