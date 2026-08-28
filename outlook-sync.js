// outlook-sync.js — Pull hearing events from Outlook into Zara
//
// Two ways to feed Outlook data in:
//   1. iCal URL — JJ publishes his calendar from Outlook (Settings → Calendar
//      → Shared calendars → Publish), gets an .ics URL, pastes it here.
//      Zara auto-refreshes hourly.
//   2. Upload .ics file — one-time import if the org blocks calendar
//      publishing. JJ exports his Outlook calendar as .ics and uploads.
//
// Events are parsed for hearing metadata (A-number, client name), matched
// against Zara clients when possible, and appear as a new source in the
// EOIR Calendar. Unmatched events still show up so nothing gets lost.
//
// The parser handles core VEVENT fields (UID, DTSTART, DTEND, SUMMARY,
// LOCATION, DESCRIPTION) with support for folded lines (RFC 5545) and
// common timezone formats.

const db = require("./db");
const axios = require("axios");

const brand = { gold: "#B79C62", navy: "#0C1C36" };

// ─── Schema ──────────────────────────────────────────

async function init() {
  // Config table stores the iCal URL and sync metadata (single row)
  await db.query(`
    CREATE TABLE IF NOT EXISTS outlook_config (
      id                SERIAL PRIMARY KEY,
      ical_url          TEXT,
      last_synced_at    TIMESTAMP,
      last_sync_status  TEXT,
      last_sync_events  INTEGER DEFAULT 0,
      last_sync_errors  TEXT,
      auto_sync_enabled BOOLEAN DEFAULT true,
      keyword_filter    TEXT DEFAULT 'hearing|merits|individual|MCH|master calendar|MTR|EOIR|immigration court',
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);

  // Ensure at least one config row exists
  const existing = await db.query(`SELECT id FROM outlook_config LIMIT 1`);
  if (!existing.rows.length) {
    await db.query(`INSERT INTO outlook_config (id) VALUES (DEFAULT)`);
  }

  // Table of imported events (one row per Outlook event by iCal UID)
  await db.query(`
    CREATE TABLE IF NOT EXISTS outlook_synced_events (
      id                SERIAL PRIMARY KEY,
      ical_uid          TEXT UNIQUE NOT NULL,
      subject           TEXT,
      start_datetime    TIMESTAMPTZ,
      end_datetime      TIMESTAMPTZ,
      all_day           BOOLEAN DEFAULT false,
      location          TEXT,
      body_text         TEXT,
      organizer_name    TEXT,
      organizer_email   TEXT,
      matched_client_name TEXT,
      matched_a_number    TEXT,
      matched_hearing_type TEXT,
      is_hearing_related BOOLEAN DEFAULT true,
      raw_ical          TEXT,
      imported_at       TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_outlook_start ON outlook_synced_events(start_datetime)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_outlook_matched ON outlook_synced_events(matched_a_number, matched_client_name)`);
  console.log("[outlook-sync] Schema initialized");
}

// ─── iCal parser ────────────────────────────────────

// Parses a minimal iCal (.ics) document into VEVENT records.
// Handles line folding (continuation lines start with space/tab), quoted
// parameters, and TZID timestamps. Returns an array of event objects.
function parseIcal(text) {
  if (!text) return [];

  // Unfold: any line starting with space/tab is a continuation of the previous
  const lines = [];
  const rawLines = text.split(/\r?\n/);
  for (const line of rawLines) {
    if (line && (line[0] === " " || line[0] === "\t") && lines.length) {
      lines[lines.length - 1] += line.substring(1);
    } else {
      lines.push(line);
    }
  }

  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = { _raw_lines: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;

    current._raw_lines.push(line);

    // Split on first colon that comes after the key/parameter section
    const colonIdx = findKeyValueSplit(line);
    if (colonIdx === -1) continue;
    const keyPart = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1);

    // keyPart might be "DTSTART" or "DTSTART;TZID=America/Los_Angeles" or "DTSTART;VALUE=DATE"
    const [key, ...paramParts] = keyPart.split(";");
    const params = {};
    for (const p of paramParts) {
      const [k, v] = p.split("=");
      if (k && v !== undefined) params[k.toUpperCase()] = v;
    }

    const decodedValue = decodeIcalValue(value);

    switch (key.toUpperCase()) {
      case "UID": current.uid = decodedValue; break;
      case "SUMMARY": current.summary = decodedValue; break;
      case "LOCATION": current.location = decodedValue; break;
      case "DESCRIPTION": current.description = decodedValue; break;
      case "DTSTART": current.start = parseDateTime(decodedValue, params); break;
      case "DTEND": current.end = parseDateTime(decodedValue, params); break;
      case "ORGANIZER":
        current.organizer_email = extractMailto(decodedValue);
        current.organizer_name = params.CN || null;
        break;
      case "STATUS": current.status = decodedValue; break;
      case "SEQUENCE": current.sequence = parseInt(decodedValue, 10) || 0; break;
    }
  }

  return events;
}

function findKeyValueSplit(line) {
  // Colon inside a quoted parameter shouldn't count; find first unquoted colon
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === ":" && !inQuote) return i;
  }
  return -1;
}

function decodeIcalValue(s) {
  return String(s || "")
    .replace(/\\n/g, "\n")
    .replace(/\\N/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Parses an iCal DTSTART/DTEND value into an ISO datetime string.
// Handles:
//   - Floating datetime: 20261015T090000
//   - UTC datetime: 20261015T170000Z
//   - Date only: 20261015 (with VALUE=DATE parameter → all-day event)
//   - With TZID: uses TZID to indicate local timezone (kept as local ISO)
function parseDateTime(value, params) {
  const isDateOnly = params.VALUE === "DATE" || /^\d{8}$/.test(value);
  if (isDateOnly) {
    // All-day event
    const y = value.substring(0, 4);
    const m = value.substring(4, 6);
    const d = value.substring(6, 8);
    return { iso: `${y}-${m}-${d}T00:00:00`, all_day: true, tzid: null };
  }

  // Format: YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) return { iso: null, all_day: false, tzid: params.TZID || null };

  const [, y, m, d, h, mn, s, z] = match;
  const isUtc = z === "Z";

  if (isUtc) {
    return { iso: `${y}-${m}-${d}T${h}:${mn}:${s}Z`, all_day: false, tzid: "UTC" };
  }

  // Floating or TZID — return without Z suffix; app will treat as local
  return {
    iso: `${y}-${m}-${d}T${h}:${mn}:${s}`,
    all_day: false,
    tzid: params.TZID || null,
  };
}

function extractMailto(s) {
  const m = String(s || "").match(/mailto:(.+?)(?:$|;|,)/i);
  return m ? m[1] : null;
}

// ─── Fetching & syncing ──────────────────────────────

async function fetchIcalUrl(url) {
  const resp = await axios.get(url, {
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "Zara-Calendar-Sync/1.0",
      "Accept": "text/calendar, text/plain, */*",
    },
    responseType: "text",
    // Prevent axios from trying to parse it as JSON
    transformResponse: [(data) => data],
  });
  return resp.data;
}

// Match an Outlook event to a Zara client using patterns in the subject/body.
// Priority: A-Number > client name in subject > client name in body.
async function matchToClient(event) {
  const searchText = `${event.summary || ""} ${event.description || ""}`;
  const result = { a_number: null, client_name: null, is_hearing_related: true };

  // Extract A-number
  const anumMatch = searchText.match(/A[-\s]?(\d{3})[-\s]?(\d{3})[-\s]?(\d{3,4})/i);
  if (anumMatch) {
    result.a_number = `A${anumMatch[1]}-${anumMatch[2]}-${anumMatch[3]}`;
  }

  // Try to match client by A-number in DB
  if (result.a_number) {
    try {
      const { rows } = await db.query(
        `SELECT client_name FROM hearing_notes WHERE a_number ILIKE $1 LIMIT 1`,
        [result.a_number]
      );
      if (rows[0]) result.client_name = rows[0].client_name;
    } catch {}
  }

  // If no A-number match, try to match by client name (case-insensitive)
  if (!result.client_name) {
    try {
      const { rows } = await db.query(
        `SELECT DISTINCT client_name, a_number FROM hearing_notes WHERE client_name IS NOT NULL`
      );
      // Try each client name against event text
      for (const row of rows) {
        if (!row.client_name || row.client_name.length < 4) continue;
        // Match "Last, First" or "First Last" tokens
        const nameParts = row.client_name.replace(/,/g, "").split(/\s+/).filter(p => p.length > 2);
        // Require at least 2 name parts to match
        const matched = nameParts.filter(p =>
          new RegExp(`\\b${escapeRegex(p)}\\b`, "i").test(searchText)
        ).length;
        if (matched >= 2 || (nameParts.length === 1 && matched === 1)) {
          result.client_name = row.client_name;
          result.a_number = result.a_number || row.a_number;
          break;
        }
      }
    } catch {}
  }

  // Guess hearing type from subject text
  const subj = (event.summary || "").toLowerCase();
  if (/merits|individual/i.test(subj)) result.hearing_type = "individual/merits";
  else if (/master|MCH|status/i.test(subj)) result.hearing_type = "master";
  else if (/bond|custody/i.test(subj)) result.hearing_type = "bond";
  else result.hearing_type = "hearing";

  return result;
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Determine if an event looks hearing-related. If not, mark it low-relevance
// so it doesn't clutter the calendar (but still stored for reference).
function isHearingRelated(event, config) {
  const keywords = (config?.keyword_filter || "hearing|merits|individual|MCH|master calendar|MTR|EOIR").split("|");
  const searchText = `${event.summary || ""} ${event.location || ""} ${event.description || ""}`.toLowerCase();
  return keywords.some(kw => searchText.includes(kw.toLowerCase().trim()));
}

// Sync a list of parsed events into the DB, matching against clients as we go.
async function upsertEvents(events, config) {
  const results = { imported: 0, updated: 0, skipped: 0, errors: [] };

  for (const event of events) {
    try {
      if (!event.uid || !event.start?.iso) {
        results.skipped++;
        continue;
      }

      const isRelated = isHearingRelated(event, config);
      const match = await matchToClient(event);

      const existing = await db.query(
        `SELECT id FROM outlook_synced_events WHERE ical_uid = $1`,
        [event.uid]
      );
      const isNew = !existing.rows.length;

      await db.query(
        `INSERT INTO outlook_synced_events
           (ical_uid, subject, start_datetime, end_datetime, all_day, location,
            body_text, organizer_name, organizer_email, matched_client_name,
            matched_a_number, matched_hearing_type, is_hearing_related, raw_ical)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (ical_uid) DO UPDATE SET
           subject = EXCLUDED.subject,
           start_datetime = EXCLUDED.start_datetime,
           end_datetime = EXCLUDED.end_datetime,
           all_day = EXCLUDED.all_day,
           location = EXCLUDED.location,
           body_text = EXCLUDED.body_text,
           organizer_name = EXCLUDED.organizer_name,
           organizer_email = EXCLUDED.organizer_email,
           matched_client_name = COALESCE(EXCLUDED.matched_client_name, outlook_synced_events.matched_client_name),
           matched_a_number = COALESCE(EXCLUDED.matched_a_number, outlook_synced_events.matched_a_number),
           matched_hearing_type = EXCLUDED.matched_hearing_type,
           is_hearing_related = EXCLUDED.is_hearing_related,
           updated_at = NOW()`,
        [
          event.uid,
          event.summary || null,
          event.start.iso,
          event.end?.iso || null,
          event.start.all_day || false,
          event.location || null,
          event.description || null,
          event.organizer_name,
          event.organizer_email,
          match.client_name,
          match.a_number,
          match.hearing_type,
          isRelated,
          event._raw_lines?.join("\n").substring(0, 5000),
        ]
      );

      if (isNew) results.imported++;
      else results.updated++;
    } catch (e) {
      results.errors.push(`${event.uid || 'unknown'}: ${e.message}`);
    }
  }

  return results;
}

// Full sync: fetch URL, parse, upsert
async function syncFromUrl() {
  const config = await getConfig();
  if (!config?.ical_url) throw new Error("No iCal URL configured. Set one in Outlook Sync settings.");

  const start = Date.now();
  await updateConfig({ last_sync_status: "in_progress" });

  try {
    const icalText = await fetchIcalUrl(config.ical_url);
    if (!icalText || icalText.length < 100) throw new Error("Fetched iCal is empty or too short");
    if (!icalText.includes("BEGIN:VCALENDAR")) throw new Error("Response does not look like iCal — check the URL");

    const events = parseIcal(icalText);
    console.log(`[outlook-sync] Parsed ${events.length} events from ${config.ical_url.substring(0, 60)}...`);

    const results = await upsertEvents(events, config);
    const elapsed = Math.round((Date.now() - start) / 1000);
    const totalTouched = results.imported + results.updated;

    await updateConfig({
      last_synced_at: new Date().toISOString(),
      last_sync_status: results.errors.length ? "partial" : "ok",
      last_sync_events: totalTouched,
      last_sync_errors: results.errors.length ? results.errors.slice(0, 5).join("\n") : null,
    });

    return { ...results, elapsed_seconds: elapsed, total_events: events.length };
  } catch (e) {
    await updateConfig({
      last_sync_status: "error",
      last_sync_errors: e.message,
    });
    throw e;
  }
}

// Import from an uploaded .ics buffer (for orgs that block calendar publishing)
async function importFromBuffer(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("File does not appear to be an .ics calendar file");
  const config = await getConfig();
  const events = parseIcal(text);
  const results = await upsertEvents(events, config);
  await updateConfig({
    last_synced_at: new Date().toISOString(),
    last_sync_status: results.errors.length ? "partial" : "ok",
    last_sync_events: results.imported + results.updated,
    last_sync_errors: results.errors.length ? results.errors.slice(0, 5).join("\n") : null,
  });
  return { ...results, total_events: events.length };
}

// ─── Config CRUD ─────────────────────────────────────

async function getConfig() {
  const { rows } = await db.query(`SELECT * FROM outlook_config ORDER BY id ASC LIMIT 1`);
  return rows[0] || null;
}

async function updateConfig(fields) {
  const allowed = ["ical_url", "last_synced_at", "last_sync_status", "last_sync_events", "last_sync_errors", "auto_sync_enabled", "keyword_filter"];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return;
  sets.push(`updated_at = NOW()`);
  await db.query(`UPDATE outlook_config SET ${sets.join(", ")} WHERE id = (SELECT id FROM outlook_config ORDER BY id ASC LIMIT 1)`, values);
}

async function listRecentEvents(limit = 100) {
  const { rows } = await db.query(
    `SELECT * FROM outlook_synced_events
     WHERE is_hearing_related = true
     ORDER BY start_datetime DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function purgeAll() {
  await db.query(`DELETE FROM outlook_synced_events`);
}

// ─── Auto-sync cron ─────────────────────────────────

let cronHandle = null;

function scheduleHourlySync() {
  if (cronHandle) clearInterval(cronHandle);
  cronHandle = setInterval(async () => {
    try {
      const config = await getConfig();
      if (config?.ical_url && config?.auto_sync_enabled) {
        const result = await syncFromUrl();
        console.log(`[outlook-sync] Hourly sync: ${result.imported} new, ${result.updated} updated`);
      }
    } catch (e) {
      console.warn("[outlook-sync] Hourly sync failed:", e.message);
    }
  }, 60 * 60 * 1000);  // Every hour
  console.log("[outlook-sync] Hourly sync scheduled");
}

// ─── UI rendering ────────────────────────────────────

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderSettingsPage(config, recentEvents) {
  const lastSync = config?.last_synced_at
    ? new Date(config.last_synced_at).toLocaleString()
    : "Never";
  const statusColor = config?.last_sync_status === "ok" ? "#2e7d32"
                    : config?.last_sync_status === "error" ? "#c62828"
                    : config?.last_sync_status === "partial" ? "#f9a825"
                    : "#888";

  const eventRows = recentEvents.slice(0, 30).map(e => {
    const dt = new Date(e.start_datetime);
    const dtStr = dt.toLocaleString();
    const matched = e.matched_client_name || e.matched_a_number;
    return `
      <div style="padding:10px 12px; border-bottom:1px solid #f0f0f0; font-size:12px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
          <div style="flex:1;">
            <div style="font-weight:600; color:${brand.navy};">${escapeHtml(e.subject || "(no subject)")}</div>
            <div style="color:#666; margin-top:2px;">${escapeHtml(dtStr)}${e.location ? ` · 📍 ${escapeHtml(e.location)}` : ""}</div>
            <div style="margin-top:4px;">
              ${matched
                ? `<span style="background:#e8f5e9; color:#2e7d32; padding:2px 6px; border-radius:3px; font-size:10px;">✓ Matched: ${escapeHtml(matched)}</span>`
                : `<span style="background:#fff3e0; color:#e65100; padding:2px 6px; border-radius:3px; font-size:10px;">⚠️ Unmatched (still shown in calendar)</span>`}
              ${e.matched_hearing_type ? `<span style="background:#e3f2fd; color:#1565c0; padding:2px 6px; border-radius:3px; font-size:10px; margin-left:4px;">${escapeHtml(e.matched_hearing_type)}</span>` : ""}
            </div>
          </div>
        </div>
      </div>`;
  }).join("");

  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
    <div>
      <h1 style="margin:0;">📤 Outlook Sync</h1>
      <div style="font-size:12px; color:#666; margin-top:4px;">Pull merits hearings and other events from your Outlook calendar into Zara.</div>
    </div>
    <a href="/admin/calendar" class="back-link">← Back to calendar</a>
  </div>

  <!-- How-to instructions -->
  <div style="background:#fff8e1; border-left:4px solid ${brand.gold}; padding:14px 18px; border-radius:4px; margin:16px 0; font-size:13px; line-height:1.6;">
    <div style="font-weight:600; color:${brand.navy}; margin-bottom:6px;">📖 How to get your Outlook iCal URL</div>
    <p style="margin:0 0 8px 0;"><b>Outlook Web (Microsoft 365):</b></p>
    <ol style="margin:0 0 8px 20px; padding:0;">
      <li>Open Outlook Calendar in a browser (outlook.office.com/calendar)</li>
      <li>Click ⚙️ Settings (top right) → View all Outlook settings</li>
      <li>Calendar → Shared calendars</li>
      <li>Under "Publish a calendar", pick the calendar you want to share</li>
      <li>Choose permission level "Can view all details"</li>
      <li>Click Publish → copy the <b>ICS link</b></li>
      <li>Paste into the field below</li>
    </ol>
    <p style="margin:8px 0 0 0; font-size:11px; color:#666;">⚠️ If your org disabled publishing, use the "Upload .ics" option below to import a one-time snapshot.</p>
  </div>

  <!-- Configuration -->
  <div style="background:white; border:1px solid #e0e0e0; border-radius:8px; padding:20px; margin-bottom:16px;">
    <h3 style="margin-top:0; color:${brand.navy};">🔗 iCal URL (auto-sync every hour)</h3>
    <form id="config-form" onsubmit="saveConfig(event)">
      <div style="margin-bottom:12px;">
        <input type="url" name="ical_url" value="${escapeHtml(config?.ical_url || "")}" placeholder="https://outlook.office365.com/owa/calendar/xxx/calendar.ics" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-family:monospace; font-size:12px;">
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Keyword filter — only events matching these keywords appear as hearings (case-insensitive, separate with |):</label>
        <input type="text" name="keyword_filter" value="${escapeHtml(config?.keyword_filter || "hearing|merits|individual|MCH|master calendar|MTR|EOIR")}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-family:monospace; font-size:12px;">
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:inline-flex; align-items:center; font-weight:normal;">
          <input type="checkbox" name="auto_sync_enabled" ${config?.auto_sync_enabled !== false ? "checked" : ""} style="margin-right:6px;"> Auto-sync every hour
        </label>
      </div>
      <div style="display:flex; gap:8px;">
        <button type="submit" style="background:${brand.navy}; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; font-weight:600;">💾 Save config</button>
        <button type="button" onclick="syncNow()" id="sync-now-btn" style="background:${brand.gold}; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; font-weight:600;">🔄 Sync now</button>
      </div>
    </form>
  </div>

  <!-- Alternative: upload .ics -->
  <div style="background:white; border:1px solid #e0e0e0; border-radius:8px; padding:20px; margin-bottom:16px;">
    <h3 style="margin-top:0; color:${brand.navy};">📎 Or upload .ics file (one-time)</h3>
    <p style="font-size:12px; color:#666; margin-top:0;">If your org blocks calendar publishing, export from Outlook (File → Save Calendar → .ics) and upload here.</p>
    <form id="upload-form" onsubmit="uploadIcs(event)" enctype="multipart/form-data">
      <input type="file" name="ics_file" accept=".ics,text/calendar" required style="padding:8px; border:1px solid #ccc; border-radius:4px;">
      <button type="submit" style="background:${brand.navy}; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer; font-weight:600; margin-left:8px;">Upload & import</button>
    </form>
  </div>

  <!-- Sync status -->
  <div style="background:white; border:1px solid #e0e0e0; border-radius:8px; padding:20px; margin-bottom:16px;">
    <h3 style="margin-top:0; color:${brand.navy};">🩺 Last sync</h3>
    <div style="font-size:13px; line-height:1.8;">
      <div><b>Status:</b> <span style="color:${statusColor};">${escapeHtml(config?.last_sync_status || "never synced")}</span></div>
      <div><b>Last sync:</b> ${lastSync}</div>
      <div><b>Events imported/updated:</b> ${config?.last_sync_events || 0}</div>
      ${config?.last_sync_errors ? `<div style="color:#c62828; margin-top:6px;"><b>Errors:</b> <code style="font-size:11px;">${escapeHtml(config.last_sync_errors)}</code></div>` : ""}
    </div>
  </div>

  <!-- Recent events preview -->
  <div style="background:white; border:1px solid #e0e0e0; border-radius:8px; padding:0; overflow:hidden;">
    <div style="padding:14px 18px; border-bottom:1px solid #eee; background:#f8f8f8; display:flex; justify-content:space-between; align-items:center;">
      <h3 style="margin:0; color:${brand.navy};">📋 Recently synced events (${recentEvents.length})</h3>
      ${recentEvents.length > 0 ? `<button onclick="purgeEvents()" style="background:transparent; color:#c00; border:1px solid #ffe0e0; padding:5px 10px; border-radius:4px; cursor:pointer; font-size:11px;">🗑 Purge all</button>` : ""}
    </div>
    ${recentEvents.length > 0 ? eventRows : '<div style="padding:30px; text-align:center; color:#888;">No events synced yet. Configure the iCal URL or upload a file above.</div>'}
  </div>

  <script>
    async function saveConfig(e) {
      e.preventDefault();
      const form = e.target;
      const body = {
        ical_url: form.ical_url.value.trim() || null,
        keyword_filter: form.keyword_filter.value.trim(),
        auto_sync_enabled: form.auto_sync_enabled.checked,
      };
      try {
        const r = await fetch("/admin/outlook-sync/config", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
        const d = await r.json();
        if (d.ok) {
          const toast = document.createElement("div");
          toast.style.cssText = "position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#2e7d32; color:white; padding:12px 20px; border-radius:6px; z-index:10001; font-size:14px;";
          toast.textContent = "✅ Configuration saved";
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 2500);
        } else alert("Save failed: " + (d.error || "unknown"));
      } catch (e) { alert("Save failed: " + e.message); }
    }
    async function syncNow() {
      const btn = document.getElementById("sync-now-btn");
      btn.disabled = true;
      btn.textContent = "🔄 Syncing…";
      try {
        const r = await fetch("/admin/outlook-sync/run", { method: "POST" });
        const d = await r.json();
        if (d.ok) {
          alert("✅ Sync complete!\\n\\n" + d.imported + " new events\\n" + d.updated + " updated\\n" + d.skipped + " skipped\\n" + (d.errors?.length || 0) + " errors\\n\\nTotal parsed: " + d.total_events);
          location.reload();
        } else {
          alert("Sync failed: " + (d.error || "unknown"));
          btn.disabled = false;
          btn.textContent = "🔄 Sync now";
        }
      } catch (e) {
        alert("Sync failed: " + e.message);
        btn.disabled = false;
        btn.textContent = "🔄 Sync now";
      }
    }
    async function uploadIcs(e) {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData();
      fd.append("ics_file", form.ics_file.files[0]);
      try {
        const r = await fetch("/admin/outlook-sync/upload", { method: "POST", body: fd });
        const d = await r.json();
        if (d.ok) {
          alert("✅ Import complete!\\n\\n" + d.imported + " new events\\n" + d.updated + " updated\\n" + (d.errors?.length || 0) + " errors");
          location.reload();
        } else alert("Import failed: " + (d.error || "unknown"));
      } catch (e) { alert("Import failed: " + e.message); }
    }
    async function purgeEvents() {
      if (!confirm("Delete all synced events? Next sync will re-import them.")) return;
      try {
        const r = await fetch("/admin/outlook-sync/events", { method: "DELETE" });
        if ((await r.json()).ok) location.reload();
      } catch (e) { alert("Purge failed: " + e.message); }
    }
  </script>`;
}

module.exports = {
  init,
  parseIcal,
  fetchIcalUrl,
  syncFromUrl,
  importFromBuffer,
  matchToClient,
  isHearingRelated,
  getConfig,
  updateConfig,
  listRecentEvents,
  purgeAll,
  scheduleHourlySync,
  renderSettingsPage,
};
