// ============================================================
//  TEZ LAW P.C. — COURT DOCKET CHECKER
//  ─────────────────────────────────────────────────────────
//  Universal court docket monitoring. Works with any court
//  portal URL (LASC, Riverside SC, San Bernardino, Orange
//  County, PACER, CourtListener, etc.) because we do NOT
//  parse HTML with brittle selectors — instead we fetch the
//  page and let Claude extract structured data.
//
//  Per case:
//    · court_docket_url — the URL to check (paste from browser)
//    · docket_snapshot   — last extracted data as JSONB
//    · last_docket_check_at
//    · last_docket_change_at — when meaningful change last seen
//
//  On every check:
//    1. Fetch the URL (with a browser UA + reasonable timeout)
//    2. Ask Claude to extract: next hearing, recent filings,
//       trial date, judge, department, current status
//    3. Compare with prior snapshot
//    4. If changed → log a civil_case_events row + update
//       civil_cases.trial_date / cmc_date if those changed
//    5. Return summary to the app
//
//  No cron here (build 38+): manual check only via app button.
//  Batch check can be added by iterating with checkCase().
// ============================================================

const db = require("./db");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new (require("@anthropic-ai/sdk"))({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Realistic UA — some court sites block obvious bot requests
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

// ═══════════════════════════════════════════════════════════
//  SCHEMA (columns added to existing civil_cases table)
// ═══════════════════════════════════════════════════════════

async function initTables() {
  // Safe ALTERs — column may already exist from prior runs
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS court_docket_url TEXT`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS docket_snapshot JSONB`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS last_docket_check_at TIMESTAMPTZ`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS last_docket_change_at TIMESTAMPTZ`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS docket_status TEXT`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS docket_last_error TEXT`).catch(() => {});

  // Docket check history — an audit trail of every check
  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_docket_checks (
      id                SERIAL PRIMARY KEY,
      case_id           INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      checked_at        TIMESTAMPTZ DEFAULT NOW(),
      checked_by        TEXT,
      url               TEXT,
      http_status       INTEGER,
      success           BOOLEAN DEFAULT FALSE,
      changes_detected  BOOLEAN DEFAULT FALSE,
      extracted         JSONB,
      changes_summary   TEXT,
      error_message     TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_docket_checks_case ON civil_docket_checks (case_id, checked_at DESC)`);
}

// ═══════════════════════════════════════════════════════════
//  FETCH + EXTRACT
// ═══════════════════════════════════════════════════════════

// Fetches the URL with browser-like headers. Returns { html, status } or
// throws on hard failure. Times out at 30s. Follows redirects.
async function fetchDocket(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await r.text();
    return { html, status: r.status, ok: r.ok, finalUrl: r.url };
  } finally {
    clearTimeout(timer);
  }
}

// Extract structured data from a court docket HTML page using Claude.
// Returns a normalized object regardless of court portal format.
async function extractDocketData(html, caseInfo) {
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY not configured");

  // Truncate very long HTML — court pages can be 100k+, waste of tokens
  const trimmed = html.length > 60_000 ? html.slice(0, 60_000) : html;

  const prompt = `You are analyzing a court docket / case summary page from a California court website.

Case context (for cross-verification):
- Case name: ${caseInfo.case_name || "unknown"}
- Case number: ${caseInfo.case_number || "unknown"}
- Court: ${caseInfo.court || "unknown"}
- Party: ${caseInfo.opposing_party || "unknown"}

Extract structured data from the HTML below. Return ONLY a JSON object (no prose, no markdown fences) with these keys:

{
  "case_number":       "as displayed on the page",
  "case_title":        "case caption on the page",
  "current_status":    "active / disposed / stayed / etc.",
  "judge":             "name of the assigned judge",
  "department":        "courtroom / department number",
  "next_hearing":      { "date": "YYYY-MM-DD", "time": "HH:MM", "type": "MSC / trial / motion hearing / etc.", "location": "" },
  "trial_date":        "YYYY-MM-DD or null",
  "cmc_date":          "YYYY-MM-DD or null",
  "recent_filings":    [ { "date": "YYYY-MM-DD", "description": "...", "filing_party": "" } ],
  "recent_orders":     [ { "date": "YYYY-MM-DD", "description": "..." } ],
  "notes":             "anything else notable — new motions, upcoming deadlines, unusual entries"
}

Use null for anything not visible. Return up to 10 recent filings and up to 5 recent orders (most recent first).

If the HTML is a login page, error page, or does not appear to be a case docket, return { "error": "reason" }.

HTML:
${trimmed}`;

  const resp = await anthropic.messages.create({
    model: require("./zara-core").TIERS.fast.anthropic,
    max_tokens: 2000,
    messages: [
      { role: "user",      content: prompt },
      { role: "assistant", content: "{" }, // Force JSON output
    ],
  });

  // Recover the JSON — the assistant prefill of "{" means we need to prepend it
  const raw = "{" + (resp.content[0]?.text || "").trim();

  // Try parse; fall back to greedy match if the model added trailing text
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Claude returned unparseable JSON: " + raw.slice(0, 200));
    return JSON.parse(m[0]);
  }
}

// ═══════════════════════════════════════════════════════════
//  COMPARE + DETECT CHANGES
// ═══════════════════════════════════════════════════════════

// Compare two docket snapshots. Returns a human-readable summary of what
// changed (new filings, changed hearing date, new orders, status change).
// Returns empty string if nothing meaningful changed.
function diffSnapshots(prev, curr) {
  if (!prev) return "First check — baseline snapshot recorded";
  const changes = [];

  // Trial date changed
  if (fmtDate(prev.trial_date) !== fmtDate(curr.trial_date)) {
    changes.push(`Trial date: ${fmtDate(prev.trial_date) || "—"} → ${fmtDate(curr.trial_date) || "—"}`);
  }
  // CMC changed
  if (fmtDate(prev.cmc_date) !== fmtDate(curr.cmc_date)) {
    changes.push(`CMC date: ${fmtDate(prev.cmc_date) || "—"} → ${fmtDate(curr.cmc_date) || "—"}`);
  }
  // Next hearing changed
  const pnh = prev.next_hearing && prev.next_hearing.date;
  const cnh = curr.next_hearing && curr.next_hearing.date;
  if (fmtDate(pnh) !== fmtDate(cnh)) {
    changes.push(`Next hearing: ${fmtDate(pnh) || "—"} → ${fmtDate(cnh) || "—"}${curr.next_hearing?.type ? " (" + curr.next_hearing.type + ")" : ""}`);
  }
  // Status change
  if ((prev.current_status || "") !== (curr.current_status || "")) {
    changes.push(`Status: ${prev.current_status || "—"} → ${curr.current_status || "—"}`);
  }
  // Judge / dept
  if ((prev.judge || "") !== (curr.judge || "")) {
    changes.push(`Judge: ${prev.judge || "—"} → ${curr.judge || "—"}`);
  }
  if ((prev.department || "") !== (curr.department || "")) {
    changes.push(`Department: ${prev.department || "—"} → ${curr.department || "—"}`);
  }
  // New filings (compare by date+description key)
  const prevFilingKeys = new Set((prev.recent_filings || []).map(f => `${f.date}::${(f.description || "").slice(0, 60)}`));
  const newFilings = (curr.recent_filings || []).filter(f =>
    !prevFilingKeys.has(`${f.date}::${(f.description || "").slice(0, 60)}`)
  );
  if (newFilings.length) {
    changes.push(`${newFilings.length} new filing${newFilings.length === 1 ? "" : "s"}:\n` +
      newFilings.slice(0, 5).map(f => `  · ${fmtDate(f.date) || "?"} — ${f.description || ""}`).join("\n"));
  }
  // New orders
  const prevOrderKeys = new Set((prev.recent_orders || []).map(o => `${o.date}::${(o.description || "").slice(0, 60)}`));
  const newOrders = (curr.recent_orders || []).filter(o =>
    !prevOrderKeys.has(`${o.date}::${(o.description || "").slice(0, 60)}`)
  );
  if (newOrders.length) {
    changes.push(`${newOrders.length} new order${newOrders.length === 1 ? "" : "s"}:\n` +
      newOrders.slice(0, 3).map(o => `  · ${fmtDate(o.date) || "?"} — ${o.description || ""}`).join("\n"));
  }

  return changes.join("\n");
}

function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ═══════════════════════════════════════════════════════════
//  ORCHESTRATION
// ═══════════════════════════════════════════════════════════

// The main entry point. Fetches the docket, extracts data, compares to
// the last snapshot, updates the case + logs an event if anything changed.
// Returns { success, http_status, extracted, changes, error }.
async function checkCase(caseId, checkedBy) {
  const r = await db.query(`SELECT * FROM civil_cases WHERE id = $1`, [caseId]);
  const caseRow = r.rows[0];
  if (!caseRow) throw new Error("Case not found");
  if (!caseRow.court_docket_url) throw new Error("No court_docket_url set on this case");

  const checkStart = new Date();
  let httpStatus = null;
  let extracted = null;
  let changes = "";
  let success = false;
  let errorMessage = null;

  try {
    // 1. Fetch
    const fetched = await fetchDocket(caseRow.court_docket_url);
    httpStatus = fetched.status;
    if (!fetched.ok) throw new Error(`Court site returned HTTP ${fetched.status}`);

    // 2. Extract with Claude
    extracted = await extractDocketData(fetched.html, {
      case_name: caseRow.case_name,
      case_number: caseRow.case_number,
      court: caseRow.court,
      opposing_party: caseRow.opposing_party,
    });
    if (extracted.error) throw new Error(`Docket page: ${extracted.error}`);

    // 3. Compare with prior snapshot
    const prevSnapshot = caseRow.docket_snapshot;
    changes = diffSnapshots(prevSnapshot, extracted);

    // 4. Update the case row + log an event if changes detected
    const updates = ["last_docket_check_at = $1", "docket_snapshot = $2::jsonb", "docket_status = $3", "docket_last_error = NULL"];
    const vals = [checkStart, JSON.stringify(extracted), extracted.current_status || null];
    let paramCount = 4;

    // If Claude extracted a trial_date or cmc_date, and it differs from ours, sync it.
    // This kicks the CCP deadline auto-generator on the next PATCH.
    if (extracted.trial_date && fmtDate(extracted.trial_date) !== fmtDate(caseRow.trial_date)) {
      updates.push(`trial_date = $${paramCount++}`);
      vals.push(extracted.trial_date);
    }
    if (extracted.cmc_date && fmtDate(extracted.cmc_date) !== fmtDate(caseRow.cmc_date)) {
      updates.push(`cmc_date = $${paramCount++}`);
      vals.push(extracted.cmc_date);
    }

    if (changes) {
      updates.push(`last_docket_change_at = $${paramCount++}`);
      vals.push(checkStart);
    }

    vals.push(caseId);
    await db.query(
      `UPDATE civil_cases SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${paramCount}`,
      vals
    );

    // Log as a case timeline event so the docket check appears in the Timeline tab
    if (changes) {
      try {
        await db.query(
          `INSERT INTO civil_case_events
             (case_id, event_kind, event_date, title, description, created_by)
           VALUES ($1, 'note', $2, $3, $4, $5)`,
          [
            caseId, fmtDate(checkStart),
            `🔎 Docket update detected`,
            changes,
            `Docket check by ${checkedBy || "system"}`,
          ]
        );
      } catch (e) { console.warn("[docket] failed to log event:", e.message); }
    }

    // If the trigger dates changed, regenerate the auto-CCP deadlines
    if (updates.some(u => u.startsWith("trial_date") || u.startsWith("cmc_date"))) {
      try {
        const civil = require("./civil-litigation");
        await civil.autoGenerateDeadlines(caseId);
      } catch (e) { console.warn("[docket] failed to regenerate deadlines:", e.message); }
    }

    success = true;
  } catch (err) {
    errorMessage = err.message;
    // Record the error on the case so the UI can display it
    await db.query(
      `UPDATE civil_cases SET last_docket_check_at = $1, docket_last_error = $2 WHERE id = $3`,
      [checkStart, err.message, caseId]
    ).catch(() => {});
  }

  // Always log the check attempt to the history table
  await db.query(
    `INSERT INTO civil_docket_checks
       (case_id, checked_at, checked_by, url, http_status, success,
        changes_detected, extracted, changes_summary, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [
      caseId, checkStart, checkedBy || null, caseRow.court_docket_url,
      httpStatus, success, !!changes,
      JSON.stringify(extracted || {}), changes || null, errorMessage,
    ]
  ).catch(() => {});

  return {
    success,
    http_status: httpStatus,
    extracted,
    changes,
    error: errorMessage,
    checked_at: checkStart,
  };
}

// List past docket checks for a case (audit trail)
async function listChecks(caseId, limit = 20) {
  const r = await db.query(
    `SELECT * FROM civil_docket_checks WHERE case_id = $1
     ORDER BY checked_at DESC LIMIT $2`,
    [caseId, limit]
  );
  return r.rows;
}

module.exports = {
  initTables,
  checkCase, listChecks,
  fetchDocket, extractDocketData, diffSnapshots,
};
