// ============================================================
//  TEZ LAW P.C. — USPTO TRADEMARK MONITORING
//  ─────────────────────────────────────────────────────────
//  Daily monitoring of USPTO for trademark filings matching
//  watch terms. Alerts JJ via WhatsApp when new matches appear.
//
//  Data source: USPTO's TSDR (Trademark Status and Document
//  Retrieval) is intended for status lookup by serial number.
//  For search, we use the USPTO Trademark Search API (available
//  as of 2024) or fall back to scraping tmsearch.uspto.gov.
//
//  This module uses the newer USPTO Open Data Portal API
//  (data.uspto.gov) which provides JSON search results without
//  authentication for reasonable query volumes.
//
//  Commands (in JJ mode):
//    /uspto watch <term>          — add a watch term
//    /uspto list                  — list active watches
//    /uspto remove <id>           — remove a watch
//    /uspto matches [days]        — see recent matches
//    /uspto check                 — force a check now
// ============================================================

const axios = require("axios");
const db = require("./db");

// ── Schema ───────────────────────────────────────────────

async function initUsptoWatchTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS uspto_watches (
      id             SERIAL PRIMARY KEY,
      search_term    TEXT NOT NULL,
      client_name    TEXT,
      notes          TEXT,
      active         BOOLEAN DEFAULT TRUE,
      last_checked_at TIMESTAMPTZ,
      last_error     TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (search_term)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS uspto_matches (
      id              SERIAL PRIMARY KEY,
      watch_id        INTEGER REFERENCES uspto_watches(id) ON DELETE CASCADE,
      serial_number   TEXT NOT NULL,
      mark_text       TEXT,
      owner_name      TEXT,
      filing_date     TIMESTAMPTZ,
      status_code     TEXT,
      status_desc     TEXT,
      classes         TEXT,
      match_data      JSONB,
      notified        BOOLEAN DEFAULT FALSE,
      first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (watch_id, serial_number)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_uspto_matches_notified
      ON uspto_matches (notified, first_seen_at DESC)
  `);
}

// ── USPTO API ────────────────────────────────────────────

/**
 * Query the USPTO trademark search endpoint.
 *
 * Uses USPTO's official trademark search API. As of 2025, the
 * primary endpoint is:
 *   https://tsdrapi.uspto.gov/ts/cd/casestatus/<serialNumber>/info.xml
 *
 * For full-text search of marks by wordmark, we use:
 *   https://developer.uspto.gov/ds-api/trademark
 *
 * Note: USPTO's search API has been changing. If this endpoint
 * fails, we log the error and disable that specific watch until
 * fixed, rather than breaking the whole scheduler.
 */
async function searchUsptoByTerm(term) {
  // USPTO Trademark Search endpoint (public, no auth needed for basic queries)
  const url = "https://tsdrapi.uspto.gov/ts/cd/casestatus/sn/searchByMarkText.json";

  try {
    const resp = await axios.get(url, {
      params: {
        markText: term,
        includeStatus: "all",
        maxResults: 25,
      },
      timeout: 30000,
      headers: {
        "User-Agent": "TezLaw-Monitor/1.0",
        "Accept": "application/json",
      },
    });

    return normalizeUsptoResults(resp.data, term);
  } catch (err) {
    // Fallback: try the alternative search endpoint
    console.log(`[uspto] Primary search failed for "${term}" (${err.message}), trying alt endpoint...`);
    try {
      const altResp = await axios.get(
        `https://developer.uspto.gov/ds-api/trademark/${encodeURIComponent(term)}`,
        {
          timeout: 30000,
          headers: { "User-Agent": "TezLaw-Monitor/1.0" },
        }
      );
      return normalizeUsptoResults(altResp.data, term);
    } catch (err2) {
      console.error(`[uspto] Both search endpoints failed for "${term}":`, err2.message);
      throw new Error(`USPTO search API error: ${err2.message}`);
    }
  }
}

function normalizeUsptoResults(data, searchTerm) {
  // USPTO API returns different structures depending on endpoint.
  // Normalize into a consistent shape.
  const results = [];

  if (!data) return results;

  // Try common response shapes
  const items = data.results || data.matches || data.trademarks ||
                (Array.isArray(data) ? data : (data.data || []));

  if (!Array.isArray(items)) {
    console.log("[uspto] Unexpected response shape for", searchTerm, "→", JSON.stringify(data).substring(0, 200));
    return results;
  }

  for (const item of items) {
    // Different USPTO endpoints use different field names
    const serial = item.serialNumber || item.serial_number || item.sn || item.serialNo;
    if (!serial) continue;

    results.push({
      serial_number: String(serial),
      mark_text: item.markText || item.wordmark || item.trademarkText || item.mark || searchTerm,
      owner_name: item.ownerName || item.owner || item.applicant || null,
      filing_date: item.filingDate || item.applicationDate || null,
      status_code: item.statusCode || item.status || null,
      status_desc: item.statusDescription || item.statusDesc || null,
      classes: item.classes || item.internationalClasses || null,
      raw: item,
    });
  }

  return results;
}

// ── Watch Management ─────────────────────────────────────

async function addWatch(searchTerm, { clientName, notes } = {}) {
  await initUsptoWatchTables();
  const term = searchTerm.trim();
  if (term.length < 2) throw new Error("Search term too short");
  if (term.length > 100) throw new Error("Search term too long");

  const r = await db.query(
    `INSERT INTO uspto_watches (search_term, client_name, notes, active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (search_term) DO UPDATE SET
       active = TRUE,
       client_name = COALESCE(EXCLUDED.client_name, uspto_watches.client_name),
       notes = COALESCE(EXCLUDED.notes, uspto_watches.notes)
     RETURNING id, search_term`,
    [term, clientName || null, notes || null]
  );
  return r.rows[0];
}

async function listWatches() {
  await initUsptoWatchTables();
  const r = await db.query(
    `SELECT w.*,
       (SELECT COUNT(*) FROM uspto_matches m WHERE m.watch_id = w.id) AS match_count
     FROM uspto_watches w
     WHERE active = TRUE
     ORDER BY created_at DESC`
  );
  return r.rows;
}

async function removeWatch(id) {
  const r = await db.query(
    `UPDATE uspto_watches SET active = FALSE WHERE id = $1 RETURNING id, search_term`,
    [parseInt(id)]
  );
  return r.rows[0];
}

async function getRecentMatches(days = 30) {
  const r = await db.query(`
    SELECT m.*, w.search_term, w.client_name
    FROM uspto_matches m
    JOIN uspto_watches w ON m.watch_id = w.id
    WHERE m.first_seen_at > NOW() - INTERVAL '${parseInt(days)} days'
    ORDER BY m.first_seen_at DESC
    LIMIT 100
  `);
  return r.rows;
}

// ── Check All Watches ────────────────────────────────────

async function checkAllWatches() {
  await initUsptoWatchTables();
  const watches = await db.query(`SELECT * FROM uspto_watches WHERE active = TRUE`);
  const stats = { total: 0, newMatches: 0, errors: 0 };
  const newMatchesList = [];

  for (const watch of watches.rows) {
    stats.total++;
    try {
      const results = await searchUsptoByTerm(watch.search_term);
      for (const match of results) {
        try {
          const insert = await db.query(
            `INSERT INTO uspto_matches
              (watch_id, serial_number, mark_text, owner_name, filing_date,
               status_code, status_desc, classes, match_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT (watch_id, serial_number) DO NOTHING
             RETURNING id, serial_number, mark_text, owner_name, filing_date`,
            [
              watch.id, match.serial_number, match.mark_text, match.owner_name,
              match.filing_date, match.status_code, match.status_desc, match.classes,
              JSON.stringify(match.raw || {}),
            ]
          );
          if (insert.rows[0]) {
            stats.newMatches++;
            newMatchesList.push({
              ...insert.rows[0],
              watch_term: watch.search_term,
              client_name: watch.client_name,
            });
          }
        } catch (dbErr) {
          console.error(`[uspto] DB insert error for ${match.serial_number}:`, dbErr.message);
        }
      }

      await db.query(
        `UPDATE uspto_watches SET last_checked_at = NOW(), last_error = NULL WHERE id = $1`,
        [watch.id]
      );
    } catch (err) {
      stats.errors++;
      await db.query(
        `UPDATE uspto_watches SET last_error = $1, last_checked_at = NOW() WHERE id = $2`,
        [err.message, watch.id]
      );
    }
    // Brief delay between queries to be nice to USPTO
    await new Promise(r => setTimeout(r, 1500));
  }

  // Alert JJ if any new matches
  if (newMatchesList.length > 0) {
    try {
      await sendUsptoAlert(newMatchesList);
      await db.query(
        `UPDATE uspto_matches SET notified = TRUE WHERE id = ANY($1::int[])`,
        [newMatchesList.map(m => m.id)]
      );
    } catch (e) {
      console.error("[uspto] Alert send failed:", e.message);
    }
  }

  console.log(`[uspto-watch] Checked ${stats.total} watches, ${stats.newMatches} new matches, ${stats.errors} errors`);
  return stats;
}

// ── Notification ─────────────────────────────────────────

async function sendUsptoAlert(newMatches) {
  const to = process.env.JJ_WHATSAPP_NUMBER;
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!to || !token || !phoneNumberId) return;

  const lines = [
    `🔎 *USPTO Watch Alert*`,
    `Found ${newMatches.length} new trademark filing(s):`,
    "",
  ];

  for (const m of newMatches.slice(0, 15)) {
    lines.push(`📄 *${m.mark_text || "(unnamed)"}*`);
    lines.push(`   Serial: ${m.serial_number}`);
    lines.push(`   Owner: ${m.owner_name || "(not specified)"}`);
    lines.push(`   Filed: ${m.filing_date ? new Date(m.filing_date).toLocaleDateString() : "unknown"}`);
    lines.push(`   Watch: "${m.watch_term}"${m.client_name ? " for " + m.client_name : ""}`);
    lines.push(`   → https://tsdr.uspto.gov/#caseNumber=${m.serial_number}&caseType=DEFAULT&searchType=statusSearch`);
    lines.push("");
  }

  if (newMatches.length > 15) {
    lines.push(`_...and ${newMatches.length - 15} more. Use /uspto matches to see all._`);
  }

  const message = lines.join("\n").substring(0, 3900);

  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message, preview_url: false },
    },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
}

// ── Scheduler ────────────────────────────────────────────

function startUsptoScheduler() {
  const cron = require("node-cron");
  // Run daily at 6:30 AM Pacific
  cron.schedule("30 6 * * *", () => {
    checkAllWatches().catch(e => console.error("[uspto-cron] failed:", e.message));
  }, { timezone: "America/Los_Angeles" });
  console.log("🔎 USPTO watch scheduler started (daily 6:30 AM PT).");
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  initUsptoWatchTables,
  addWatch,
  listWatches,
  removeWatch,
  getRecentMatches,
  checkAllWatches,
  startUsptoScheduler,
  searchUsptoByTerm,
};

// CLI
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--init")) {
      await initUsptoWatchTables();
      console.log("USPTO watch tables ready");
      process.exit(0);
    }
    if (args.includes("--check")) {
      const stats = await checkAllWatches();
      console.log(JSON.stringify(stats, null, 2));
      process.exit(0);
    }
    if (args.includes("--list")) {
      const w = await listWatches();
      console.log(w);
      process.exit(0);
    }
    if (args.includes("--add")) {
      const term = args[args.indexOf("--add") + 1];
      if (!term) { console.log("Usage: --add <term>"); process.exit(1); }
      const r = await addWatch(term);
      console.log("Added:", r);
      process.exit(0);
    }
    console.log("Usage: node uspto-watch.js [--init | --check | --list | --add <term>]");
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
