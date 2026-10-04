// ============================================================
//  calendar-feeds.js — more than one calendar, side by side
//  Tez Law P.C.
//
//  outlook-sync.js could already subscribe to an iCal URL, parse it and file
//  the events. It just could not do it twice: outlook_config held a single row
//  with a single ical_url, and outlook_synced_events.ical_uid was UNIQUE on its
//  own, so a second feed carrying the same event would collide with the first.
//
//  This makes feeds plural. Each one has a name, a colour and its own answer to
//  "is this event worth showing" — the firm's Outlook calendar is filtered down
//  to hearings, where a MyCase calendar probably wants everything. The parser,
//  the fetcher and the upsert all still come from outlook-sync.js; this module
//  owns the list of feeds and the loop over it.
//
//  The existing single configuration migrates in as the first feed, keeping its
//  URL, its keyword filter and every event already synced under it. Nothing
//  about what the calendar currently shows changes until a feed is edited.
// ============================================================

const db = require("./db");

const brand = { gold: "#A34C00", navy: "#2B2523" };

// Enough distinct colours that a few feeds are still tellable apart at the size
// a month-grid chip renders. Deliberately clear of the event colours in
// eoir-calendar.js, except the Microsoft blue the Outlook source already used.
const FEED_COLORS = [
  "#0078d4",  // Microsoft blue — what the Outlook source has always been
  "#00897b",  // teal
  "#d81b60",  // pink
  "#5e35b1",  // deep purple
  "#ef6c00",  // orange
  "#455a64",  // blue grey
];

const DEFAULT_KEYWORDS = "hearing|merits|individual|MCH|master calendar|MTR|EOIR|immigration court";

// The name the migrated Outlook configuration takes. JJ calls this the firm
// calendar; it is the same feed the Outlook Sync page has always pulled.
const LEGACY_FEED_NAME = "Firm calendar (Outlook)";

// ─── Schema ──────────────────────────────────────────

async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      ical_url          TEXT,
      color             TEXT DEFAULT '${FEED_COLORS[0]}',
      enabled           BOOLEAN DEFAULT true,
      -- 'keywords' keeps only events matching keyword_filter, the way the
      -- Outlook sync always has. 'all' shows everything the feed publishes,
      -- which is what a practice-management calendar usually wants.
      filter_mode       TEXT DEFAULT 'keywords',
      keyword_filter    TEXT DEFAULT '${DEFAULT_KEYWORDS}',
      sort_order        INTEGER DEFAULT 0,
      last_synced_at    TIMESTAMP,
      last_sync_status  TEXT,
      last_sync_events  INTEGER DEFAULT 0,
      last_sync_errors  TEXT,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);

  // Events gain a feed. Nullable at first so the column can be added to a table
  // that already holds rows; the backfill below fills it and the unique index
  // then depends on it being set.
  await db.query(`ALTER TABLE outlook_synced_events ADD COLUMN IF NOT EXISTS feed_id INTEGER`);

  const legacyId = await migrateLegacyConfig();

  // Every event synced before feeds existed came from the one configured URL.
  if (legacyId) {
    await db.query(`UPDATE outlook_synced_events SET feed_id = $1 WHERE feed_id IS NULL`, [legacyId]);
  }

  // The same meeting can legitimately appear in two calendars, so a UID is only
  // unique within its feed. Drop the single-column constraint by whatever name
  // Postgres gave it rather than guessing, then index the pair.
  await db.query(`
    DO $$
    DECLARE conname_found text;
    BEGIN
      SELECT c.conname INTO conname_found
        FROM pg_constraint c
       WHERE c.conrelid = 'outlook_synced_events'::regclass
         AND c.contype = 'u'
         AND (SELECT array_agg(a.attname::text)
                FROM pg_attribute a
               WHERE a.attrelid = c.conrelid
                 AND a.attnum = ANY(c.conkey)) = ARRAY['ical_uid'];
      IF conname_found IS NOT NULL THEN
        EXECUTE format('ALTER TABLE outlook_synced_events DROP CONSTRAINT %I', conname_found);
      END IF;
    END $$;
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outlook_feed_uid
      ON outlook_synced_events(feed_id, ical_uid)
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_outlook_feed ON outlook_synced_events(feed_id)`);

  console.log("[calendar-feeds] Schema initialized");
}

// Brings the single outlook_config row in as a feed, once. Returns the feed id
// that legacy events belong to, or null if there was nothing to migrate and no
// feed exists yet.
async function migrateLegacyConfig() {
  const existing = await db.query(`SELECT id FROM calendar_feeds ORDER BY id ASC LIMIT 1`);
  if (existing.rows.length) return existing.rows[0].id;

  let cfg = null;
  try {
    const { rows } = await db.query(`SELECT * FROM outlook_config ORDER BY id ASC LIMIT 1`);
    cfg = rows[0] || null;
  } catch {
    // outlook_config may not exist on a fresh database; that is not an error.
  }

  // Carry the old settings across exactly, including the keyword filter. A
  // migration that quietly started showing every meeting in the firm calendar
  // would change what the calendar displays without anyone asking for it.
  const { rows } = await db.query(
    `INSERT INTO calendar_feeds (name, ical_url, color, enabled, filter_mode, keyword_filter, sort_order)
     VALUES ($1, $2, $3, $4, 'keywords', $5, 0)
     RETURNING id`,
    [
      LEGACY_FEED_NAME,
      cfg?.ical_url || null,
      FEED_COLORS[0],
      cfg ? cfg.auto_sync_enabled !== false : true,
      cfg?.keyword_filter || DEFAULT_KEYWORDS,
    ]
  );
  console.log(`[calendar-feeds] Migrated the Outlook configuration in as feed ${rows[0].id}`);
  return rows[0].id;
}

// ─── CRUD ────────────────────────────────────────────

async function list({ enabledOnly = false } = {}) {
  const { rows } = await db.query(
    `SELECT f.*,
            (SELECT COUNT(*) FROM outlook_synced_events e WHERE e.feed_id = f.id) AS event_count
       FROM calendar_feeds f
      ${enabledOnly ? "WHERE f.enabled = true" : ""}
      ORDER BY f.sort_order ASC, f.id ASC`
  );
  return rows.map(r => ({ ...r, event_count: Number(r.event_count) || 0 }));
}

async function get(id) {
  const { rows } = await db.query(`SELECT * FROM calendar_feeds WHERE id = $1`, [id]);
  return rows[0] || null;
}

function normaliseUrl(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  // webcal:// is what calendar apps hand out; it is http(s) on the wire.
  const http = u.replace(/^webcal:\/\//i, "https://");
  if (!/^https?:\/\//i.test(http)) throw new Error("A calendar URL must start with https:// or webcal://");
  return http;
}

function normaliseColor(color, fallbackIndex = 0) {
  const c = String(color || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  return FEED_COLORS[fallbackIndex % FEED_COLORS.length];
}

async function create(fields) {
  const name = String(fields.name || "").trim();
  if (name.length < 2) throw new Error("Give the calendar a name, so you can tell it apart on the grid.");
  const existingCount = (await db.query(`SELECT COUNT(*)::int AS n FROM calendar_feeds`)).rows[0].n;
  const mode = fields.filter_mode === "all" ? "all" : "keywords";
  const { rows } = await db.query(
    `INSERT INTO calendar_feeds (name, ical_url, color, enabled, filter_mode, keyword_filter, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      name,
      normaliseUrl(fields.ical_url),
      normaliseColor(fields.color, existingCount),
      fields.enabled !== false,
      mode,
      String(fields.keyword_filter || DEFAULT_KEYWORDS).trim() || DEFAULT_KEYWORDS,
      existingCount,
    ]
  );
  return rows[0];
}

async function update(id, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col} = $${i++}`); values.push(val); };

  if (fields.name !== undefined) {
    const name = String(fields.name).trim();
    if (name.length < 2) throw new Error("Give the calendar a name, so you can tell it apart on the grid.");
    push("name", name);
  }
  if (fields.ical_url !== undefined)       push("ical_url", normaliseUrl(fields.ical_url));
  if (fields.color !== undefined)          push("color", normaliseColor(fields.color));
  if (fields.enabled !== undefined)        push("enabled", !!fields.enabled);
  if (fields.filter_mode !== undefined)    push("filter_mode", fields.filter_mode === "all" ? "all" : "keywords");
  if (fields.keyword_filter !== undefined) push("keyword_filter", String(fields.keyword_filter).trim() || DEFAULT_KEYWORDS);
  if (fields.sort_order !== undefined)     push("sort_order", parseInt(fields.sort_order, 10) || 0);

  // Sync bookkeeping, written by syncFeed rather than by a person.
  for (const col of ["last_synced_at", "last_sync_status", "last_sync_events", "last_sync_errors"]) {
    if (fields[col] !== undefined) push(col, fields[col]);
  }

  if (!sets.length) return await get(id);
  sets.push("updated_at = NOW()");
  const { rows } = await db.query(
    `UPDATE calendar_feeds SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    [...values, id]
  );
  return rows[0] || null;
}

// Removing a feed takes its events with it. They came from somewhere that is no
// longer being consulted, and leaving them behind would show the calendar
// entries from a calendar nobody is watching any more.
async function remove(id) {
  const feed = await get(id);
  if (!feed) return { removed: false };
  const { rowCount } = await db.query(`DELETE FROM outlook_synced_events WHERE feed_id = $1`, [id]);
  await db.query(`DELETE FROM calendar_feeds WHERE id = $1`, [id]);
  return { removed: true, name: feed.name, events_removed: rowCount };
}

// ─── Syncing ─────────────────────────────────────────

async function syncFeed(id) {
  const outlook = require("./outlook-sync");
  const feed = await get(id);
  if (!feed) throw new Error("No such calendar");
  if (!feed.ical_url) throw new Error(`${feed.name} has no calendar URL yet.`);

  const started = Date.now();
  await update(id, { last_sync_status: "in_progress" });

  try {
    const text = await outlook.fetchIcalUrl(feed.ical_url);
    if (!text || text.length < 100) throw new Error("The calendar came back empty — check the URL.");
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("That URL does not return a calendar — check it in a browser.");

    const events = outlook.parseIcal(text);
    const results = await outlook.upsertEvents(events, feed, id);
    const touched = results.imported + results.updated;

    await update(id, {
      last_synced_at: new Date().toISOString(),
      last_sync_status: results.errors.length ? "partial" : "ok",
      last_sync_events: touched,
      last_sync_errors: results.errors.length ? results.errors.slice(0, 5).join("\n") : null,
    });

    return { ...results, feed_id: id, feed_name: feed.name, total_events: events.length,
             elapsed_seconds: Math.round((Date.now() - started) / 1000) };
  } catch (e) {
    await update(id, { last_sync_status: "error", last_sync_errors: e.message });
    throw e;
  }
}

// Every enabled feed, each inside its own try. One calendar being unreachable
// must not stop the others: a court date missing because an unrelated feed 404'd
// is exactly the failure this whole module exists to avoid.
async function syncAll() {
  const feeds = await list({ enabledOnly: true });
  const out = [];
  for (const feed of feeds) {
    if (!feed.ical_url) {
      out.push({ feed_id: feed.id, feed_name: feed.name, skipped: "no URL set" });
      continue;
    }
    try {
      out.push(await syncFeed(feed.id));
    } catch (e) {
      console.warn(`[calendar-feeds] ${feed.name}: ${e.message}`);
      out.push({ feed_id: feed.id, feed_name: feed.name, error: e.message });
    }
  }
  return out;
}

let cronHandle = null;

function scheduleHourlySync() {
  if (cronHandle) clearInterval(cronHandle);
  cronHandle = setInterval(async () => {
    try {
      const results = await syncAll();
      const ok = results.filter(r => !r.error && !r.skipped).length;
      const bad = results.filter(r => r.error);
      console.log(`[calendar-feeds] Hourly sync: ${ok} calendar(s) ok${bad.length ? `, ${bad.length} failed` : ""}`);
    } catch (e) {
      console.warn("[calendar-feeds] Hourly sync failed:", e.message);
    }
  }, 60 * 60 * 1000);
  console.log("[calendar-feeds] Hourly sync scheduled");
}

// ─── UI ──────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function statusChip(feed) {
  const map = {
    ok:          ["#e8f5e9", "#2e7d32", "Synced"],
    partial:     ["#fff8e1", "#f57f17", "Synced with warnings"],
    error:       ["#ffebee", "#c62828", "Failed"],
    in_progress: ["#e3f2fd", "#1565c0", "Syncing…"],
  };
  const [bg, fg, label] = map[feed.last_sync_status] || ["#f5f5f5", "#777", "Never synced"];
  const when = feed.last_synced_at ? ` · ${new Date(feed.last_synced_at).toLocaleString()}` : "";
  return `<span style="background:${bg}; color:${fg}; padding:2px 7px; border-radius:3px; font-size:10px; font-weight:600;">${label}</span>
          <span style="font-size:10px; color:#999;">${escapeHtml(when)}</span>`;
}

function feedRow(feed) {
  const url = feed.ical_url || "";
  return `
  <div class="feed-row" data-id="${feed.id}" style="border:1px solid #eee; border-left:5px solid ${escapeHtml(feed.color)}; border-radius:6px; padding:14px 16px; margin-bottom:10px; background:white;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
      <div style="flex:1; min-width:240px;">
        <input class="f-name" value="${escapeHtml(feed.name)}" style="font-size:15px; font-weight:600; color:${brand.navy}; border:none; border-bottom:1px solid transparent; padding:2px 0; width:100%; background:transparent;" onfocus="this.style.borderBottomColor='#ddd'" onblur="this.style.borderBottomColor='transparent'">
        <div style="margin-top:6px;">${statusChip(feed)}</div>
        <div style="font-size:11px; color:#888; margin-top:4px;">${feed.event_count} event(s) stored${feed.last_sync_errors ? ` · <span style="color:#c62828;">${escapeHtml(String(feed.last_sync_errors).split("\n")[0])}</span>` : ""}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <input class="f-color" type="color" value="${escapeHtml(feed.color)}" title="Colour on the calendar" style="width:38px; height:30px; border:1px solid #ddd; border-radius:4px; padding:1px; background:white; cursor:pointer;">
        <label style="font-size:11px; color:#555; display:flex; align-items:center; gap:4px; cursor:pointer;">
          <input class="f-enabled" type="checkbox" ${feed.enabled ? "checked" : ""}> Show
        </label>
      </div>
    </div>

    <div style="margin-top:10px;">
      <input class="f-url" value="${escapeHtml(url)}" placeholder="https://… or webcal://… calendar URL" style="width:100%; padding:7px 9px; border:1px solid #ddd; border-radius:4px; font-size:12px; font-family:monospace;">
    </div>

    <div style="margin-top:10px; display:flex; align-items:center; gap:14px; flex-wrap:wrap; font-size:12px;">
      <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
        <input class="f-mode" type="radio" name="mode-${feed.id}" value="keywords" ${feed.filter_mode !== "all" ? "checked" : ""}> Only matching events
      </label>
      <label style="display:flex; align-items:center; gap:5px; cursor:pointer;">
        <input class="f-mode" type="radio" name="mode-${feed.id}" value="all" ${feed.filter_mode === "all" ? "checked" : ""}> Everything on this calendar
      </label>
      <input class="f-keywords" value="${escapeHtml(feed.keyword_filter || DEFAULT_KEYWORDS)}" placeholder="hearing|merits|…" style="flex:1; min-width:200px; padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:11px; font-family:monospace;">
    </div>

    <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
      <button onclick="saveFeed(${feed.id})" style="background:${brand.navy}; color:white; border:none; padding:6px 14px; border-radius:4px; font-size:12px; cursor:pointer;">Save</button>
      <button onclick="syncFeed(${feed.id})" style="background:${brand.gold}; color:white; border:none; padding:6px 14px; border-radius:4px; font-size:12px; cursor:pointer;">Sync now</button>
      <button onclick="removeFeed(${feed.id}, this)" style="background:white; color:#c62828; border:1px solid #f0c9c9; padding:6px 14px; border-radius:4px; font-size:12px; cursor:pointer; margin-left:auto;">Remove</button>
    </div>
  </div>`;
}

function renderFeedsPage(feeds) {
  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
    <div>
      <h1 style="margin:0;">Calendars</h1>
      <div style="font-size:12px; color:#666; margin-top:4px;">Every calendar the court calendar pulls from. Each one keeps its own colour and decides what it contributes.</div>
    </div>
    <a href="/admin/calendar" class="back-link">← Back to calendar</a>
  </div>

  <div style="background:#fff8e1; border-left:4px solid ${brand.gold}; padding:14px 18px; border-radius:4px; margin:16px 0; font-size:13px; line-height:1.6;">
    <div style="font-weight:600; color:${brand.navy}; margin-bottom:6px;">Where a calendar URL comes from</div>
    <p style="margin:0 0 6px 0;"><b>Outlook / Microsoft 365:</b> Calendar → Settings → Shared calendars → publish the calendar, permission "Can view all details", then copy the ICS link.</p>
    <p style="margin:0 0 6px 0;"><b>MyCase:</b> Calendar → the subscribe or feed option → copy the iCal URL it gives you.</p>
    <p style="margin:0 0 6px 0;"><b>Google Calendar:</b> Settings for the calendar → "Secret address in iCal format".</p>
    <p style="margin:0; color:#8a6d00;"><b>Treat these URLs as passwords.</b> Anyone holding one can read the whole calendar without signing in, so paste them here rather than into email or chat, and re-publish to rotate one if it gets out.</p>
  </div>

  <div style="background:#f8f8f8; border:1px solid #eee; border-radius:4px; padding:12px 16px; margin:16px 0; font-size:12px; color:#555; line-height:1.6;">
    <b>Only matching events</b> keeps what the words on the right match — how the firm calendar has always worked, so hearings come through and the rest of the day does not.
    <b>Everything on this calendar</b> contributes every event it publishes, which is usually what you want from a practice-management calendar.
  </div>

  <div id="feeds">
    ${feeds.map(feedRow).join("") || `<div style="padding:28px; text-align:center; color:#888; background:white; border:1px dashed #ddd; border-radius:6px;">No calendars yet. Add one below.</div>`}
  </div>

  <div style="background:white; border:1px solid #eee; border-radius:6px; padding:16px; margin-top:18px;">
    <div style="font-weight:600; color:${brand.navy}; margin-bottom:10px;">Add a calendar</div>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <input id="new-name" placeholder="Name, e.g. MyCase" style="flex:1; min-width:160px; padding:8px 10px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
      <input id="new-url" placeholder="https://… calendar URL" style="flex:2; min-width:240px; padding:8px 10px; border:1px solid #ddd; border-radius:4px; font-size:13px; font-family:monospace;">
      <select id="new-mode" style="padding:8px 10px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
        <option value="all">Everything on it</option>
        <option value="keywords">Only matching events</option>
      </select>
      <button onclick="addFeed()" style="background:${brand.navy}; color:white; border:none; padding:8px 18px; border-radius:4px; font-size:13px; cursor:pointer;">Add</button>
    </div>
    <div id="add-msg" style="font-size:12px; margin-top:8px;"></div>
  </div>

  <div style="margin-top:18px;">
    <button onclick="syncAll()" style="background:${brand.gold}; color:white; border:none; padding:9px 20px; border-radius:4px; font-size:13px; cursor:pointer;">Sync every calendar now</button>
    <span id="sync-msg" style="font-size:12px; margin-left:10px;"></span>
  </div>

  ${require("./client-script").clientScriptTag("calendar-feeds.js")}
  `;
}

module.exports = {
  init,
  list,
  get,
  create,
  update,
  remove,
  syncFeed,
  syncAll,
  scheduleHourlySync,
  renderFeedsPage,
  normaliseUrl,
  normaliseColor,
  FEED_COLORS,
  DEFAULT_KEYWORDS,
  LEGACY_FEED_NAME,
};
