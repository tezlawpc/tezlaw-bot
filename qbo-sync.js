// ============================================================
//  TEZ LAW P.C. — QUICKBOOKS ONLINE LIVE SYNC
//  ─────────────────────────────────────────────────────────
//  OAuth 2.0 authentication + push journal entries to QBO.
//
//  Setup (one time by JJ):
//   1. Go to https://developer.intuit.com/app/developer/dashboard
//   2. Create app → get Client ID + Client Secret
//   3. Set redirect URI: {RENDER_EXTERNAL_URL}/admin/accounting/quickbooks/callback
//   4. Add to Render env vars:
//      QBO_CLIENT_ID=...
//      QBO_CLIENT_SECRET=...
//      QBO_ENVIRONMENT=sandbox (or production)
//   5. Click "Connect QuickBooks" in the admin UI
//
//  How it works:
//   - OAuth 2.0 flow: authorize → callback → exchange code for tokens
//   - Access token expires after 60 min → auto-refresh
//   - Refresh token valid 100 days → prompts reconnect if expired
//   - Every journal entry we create can be auto-pushed to QBO
//   - Account mapping: our internal COA → QBO Account IDs (auto or manual)
//
//  QBO endpoints:
//   Sandbox: https://sandbox-quickbooks.api.intuit.com
//   Prod:    https://quickbooks.api.intuit.com
//   OAuth:   https://appcenter.intuit.com/connect/oauth2
//   Tokens:  https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
// ============================================================

const axios = require("axios");
const db = require("./db");

// ─── Config ─────────────────────────────────────────────

const OAUTH_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
const OAUTH_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const OAUTH_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const SCOPES = "com.intuit.quickbooks.accounting";

function apiBase(env) {
  return env === "production"
    ? "https://quickbooks.api.intuit.com/v3/company"
    : "https://sandbox-quickbooks.api.intuit.com/v3/company";
}

function getEnv() {
  return process.env.QBO_ENVIRONMENT || "sandbox";
}

function getClientId() { return process.env.QBO_CLIENT_ID || ""; }
function getClientSecret() { return process.env.QBO_CLIENT_SECRET || ""; }
function getRedirectUri() {
  const base = process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
  return `${base}/admin/accounting/quickbooks/callback`;
}

function isConfigured() {
  return !!(getClientId() && getClientSecret());
}

// ─── Config storage ─────────────────────────────────────

async function ensureConfigColumns() {
  const alters = [
    "ADD COLUMN IF NOT EXISTS auto_push_enabled BOOLEAN DEFAULT FALSE",
    "ADD COLUMN IF NOT EXISTS scheduled_sync_enabled BOOLEAN DEFAULT FALSE",
    "ADD COLUMN IF NOT EXISTS sync_interval_minutes INTEGER DEFAULT 60",
    "ADD COLUMN IF NOT EXISTS last_scheduled_sync_at TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS last_sync_pushed INTEGER DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS last_sync_failed INTEGER DEFAULT 0",
    "ADD COLUMN IF NOT EXISTS last_sync_errors TEXT",
  ];
  for (const alter of alters) {
    try { await db.query(`ALTER TABLE accounting_qb_config ${alter}`); } catch {}
  }
}

async function getConfig() {
  await ensureConfigColumns();
  const r = await db.query(`SELECT * FROM accounting_qb_config ORDER BY id DESC LIMIT 1`);
  return r.rows[0] || null;
}

async function saveConfig(fields) {
  const existing = await getConfig();
  if (existing) {
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 1}`).join(", ");
    const values = Object.values(fields);
    values.push(existing.id);
    await db.query(
      `UPDATE accounting_qb_config SET ${sets}, updated_at = NOW() WHERE id = $${values.length}`,
      values
    );
  } else {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    await db.query(
      `INSERT INTO accounting_qb_config (${keys.join(", ")}) VALUES (${placeholders})`,
      values
    );
  }
}

async function isConnected() {
  const cfg = await getConfig();
  if (!cfg || !cfg.access_token || !cfg.realm_id) return false;
  // Check token freshness — refresh_token valid ~100 days
  if (cfg.token_expires_at && new Date(cfg.token_expires_at) < new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)) {
    return false;
  }
  return true;
}

// ─── OAuth flow ─────────────────────────────────────────

function getAuthorizeUrl(state = "tez-law") {
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    scope: SCOPES,
    redirect_uri: getRedirectUri(),
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, realmId) {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await axios.post(
    OAUTH_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 30000,
    }
  );

  const { access_token, refresh_token, expires_in } = resp.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000);

  await saveConfig({
    realm_id: realmId,
    access_token,
    refresh_token,
    token_expires_at: expiresAt,
    environment: getEnv(),
    last_sync_at: null,
  });

  return { realm_id: realmId, expires_at: expiresAt };
}

async function refreshAccessToken() {
  const cfg = await getConfig();
  if (!cfg || !cfg.refresh_token) throw new Error("No refresh token — reconnect required");

  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await axios.post(
    OAUTH_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refresh_token,
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: 30000,
    }
  );

  const { access_token, refresh_token, expires_in } = resp.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000);

  await saveConfig({
    access_token,
    refresh_token: refresh_token || cfg.refresh_token,
    token_expires_at: expiresAt,
  });

  return access_token;
}

// Get a fresh access token — refreshes automatically if expired
async function getValidAccessToken() {
  const cfg = await getConfig();
  if (!cfg || !cfg.access_token) throw new Error("Not connected to QuickBooks — click Connect first");
  const expiresAt = cfg.token_expires_at ? new Date(cfg.token_expires_at) : null;
  const buffer = 60 * 1000; // refresh 60s before actual expiry
  if (expiresAt && expiresAt.getTime() - buffer <= Date.now()) {
    return await refreshAccessToken();
  }
  return cfg.access_token;
}

async function disconnect() {
  const cfg = await getConfig();
  if (!cfg) return;
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // Revoke the refresh token on Intuit's side (best effort)
  if (cfg.refresh_token) {
    try {
      await axios.post(
        OAUTH_REVOKE_URL,
        { token: cfg.refresh_token },
        {
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          timeout: 15000,
        }
      );
    } catch (e) { console.warn("[qbo] revoke:", e.message); }
  }

  // Clear stored tokens
  await db.query(`DELETE FROM accounting_qb_config`);
}

// ─── QBO API calls ──────────────────────────────────────

async function qboRequest({ method = "GET", path, data = null, params = {} }) {
  const token = await getValidAccessToken();
  const cfg = await getConfig();
  const base = apiBase(cfg.environment || getEnv());
  const url = `${base}/${cfg.realm_id}${path}`;

  const resp = await axios({
    method,
    url,
    data,
    params: { minorversion: "70", ...params },
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 45000,
  });
  return resp.data;
}

// Fetch all accounts from QBO (for mapping)
async function fetchQBOAccounts() {
  const data = await qboRequest({
    path: `/query`,
    params: { query: "SELECT * FROM Account MAXRESULTS 1000" },
  });
  return (data?.QueryResponse?.Account) || [];
}

// Fetch company info (used to verify connection)
async function fetchCompanyInfo() {
  const cfg = await getConfig();
  const data = await qboRequest({ path: `/companyinfo/${cfg.realm_id}` });
  return data?.CompanyInfo || null;
}

// ─── Account mapping ────────────────────────────────────
// Maps our internal chart of accounts (account_number → id) to QBO Account IDs.
// Stored in accounting_qb_config.account_mappings as JSON:
//   { "1010": "qbAcctId1", "1020": "qbAcctId2", ... }

async function getAccountMappings() {
  const cfg = await getConfig();
  return cfg?.account_mappings || {};
}

async function saveAccountMapping(ourAccountNumber, qbAccountId) {
  const cfg = await getConfig();
  const mappings = cfg?.account_mappings || {};
  mappings[String(ourAccountNumber)] = String(qbAccountId);
  await saveConfig({ account_mappings: JSON.stringify(mappings) });
}

// Auto-match by name — call after connecting to try automatic mapping
async function autoMapAccounts() {
  const accounting = require("./accounting");
  const [ourAccounts, qboAccounts] = await Promise.all([
    accounting.listAccounts(),
    fetchQBOAccounts(),
  ]);
  const mappings = await getAccountMappings();
  let matched = 0;

  for (const ours of ourAccounts) {
    if (mappings[ours.account_number]) continue; // already mapped
    // Try exact-name match, then case-insensitive substring
    let match = qboAccounts.find(qb =>
      qb.Name && qb.Name.toLowerCase() === ours.name.toLowerCase()
    );
    if (!match) {
      // Strip trailing qualifiers like "- Operating" for looser match
      const shortName = ours.name.replace(/ - .+$/, "").trim();
      match = qboAccounts.find(qb =>
        qb.Name && qb.Name.toLowerCase().includes(shortName.toLowerCase())
      );
    }
    if (match) {
      mappings[ours.account_number] = String(match.Id);
      matched++;
    }
  }

  await saveConfig({ account_mappings: JSON.stringify(mappings) });
  return { matched, our_total: ourAccounts.length, qbo_total: qboAccounts.length };
}

// ─── Push a journal entry to QBO ────────────────────────

async function pushJournalEntry(entryId) {
  const accounting = require("./accounting");

  // Load our entry with lines
  const entries = await db.query(
    `SELECT je.*,
       (SELECT json_agg(json_build_object(
          'account_id', jl.account_id,
          'account_number', a.account_number,
          'account_name', a.name,
          'debit', jl.debit,
          'credit', jl.credit,
          'memo', jl.memo,
          'line_number', jl.line_number
        ) ORDER BY jl.line_number)
        FROM accounting_journal_lines jl
        JOIN accounting_accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = je.id) as lines
     FROM accounting_journal_entries je
     WHERE je.id = $1`,
    [entryId]
  );
  const entry = entries.rows[0];
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  if (entry.qb_txn_id) {
    return { ok: true, already_synced: true, qb_txn_id: entry.qb_txn_id };
  }

  const mappings = await getAccountMappings();
  const qboLines = [];
  const missing = [];

  for (const line of entry.lines || []) {
    const qbAcctId = mappings[String(line.account_number)];
    if (!qbAcctId) {
      missing.push(`${line.account_number} ${line.account_name}`);
      continue;
    }
    const amount = Number(line.debit || 0) > 0 ? Number(line.debit) : Number(line.credit || 0);
    const postingType = Number(line.debit || 0) > 0 ? "Debit" : "Credit";
    qboLines.push({
      Amount: amount,
      DetailType: "JournalEntryLineDetail",
      Description: (line.memo || entry.description || "").substring(0, 4000),
      JournalEntryLineDetail: {
        PostingType: postingType,
        AccountRef: { value: qbAcctId },
      },
    });
  }

  if (missing.length) {
    throw new Error(`Missing QBO account mapping for: ${missing.join(", ")}. Go to Account Mapping to fix.`);
  }
  if (!qboLines.length) throw new Error("No lines to push");

  const payload = {
    TxnDate: new Date(entry.entry_date).toISOString().split("T")[0],
    PrivateNote: (entry.description || "").substring(0, 4000),
    DocNumber: entry.reference ? String(entry.reference).substring(0, 21) : undefined,
    Line: qboLines,
  };

  const resp = await qboRequest({
    method: "POST",
    path: "/journalentry",
    data: payload,
  });

  const qbTxnId = resp?.JournalEntry?.Id;
  if (!qbTxnId) throw new Error("QBO didn't return a transaction ID");

  // Store QB ID so we don't double-post
  await db.query(
    `UPDATE accounting_journal_entries SET qb_txn_id = $1, qb_synced_at = NOW() WHERE id = $2`,
    [qbTxnId, entryId]
  );

  return { ok: true, qb_txn_id: qbTxnId };
}

// ─── Batch sync all unsynced entries ────────────────────

async function pushAllUnsyncedEntries({ limit = 100, from_date = null } = {}) {
  const conds = ["is_posted = TRUE", "qb_txn_id IS NULL"];
  const params = [];
  let i = 1;
  if (from_date) { conds.push(`entry_date >= $${i++}`); params.push(from_date); }
  params.push(limit);

  const unsynced = await db.query(
    `SELECT id FROM accounting_journal_entries
     WHERE ${conds.join(" AND ")}
     ORDER BY entry_date ASC, id ASC
     LIMIT $${i}`,
    params
  );

  const results = { total: unsynced.rows.length, pushed: 0, failed: 0, errors: [] };
  for (const row of unsynced.rows) {
    try {
      await pushJournalEntry(row.id);
      results.pushed++;
      // QBO rate limit: 500 requests/min, so pace ourselves at ~5/sec max
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      results.failed++;
      results.errors.push(`Entry #${row.id}: ${e.message}`);
      if (results.errors.length > 20) break;
    }
  }

  await saveConfig({ last_sync_at: new Date() });
  return results;
}

// ─── Sync status ────────────────────────────────────────

async function getSyncStatus() {
  const cfg = await getConfig();
  if (!cfg) {
    return {
      connected: false,
      configured: isConfigured(),
      environment: getEnv(),
      redirect_uri: getRedirectUri(),
    };
  }

  const [total, synced, unsynced] = await Promise.all([
    db.query(`SELECT COUNT(*) as n FROM accounting_journal_entries WHERE is_posted`),
    db.query(`SELECT COUNT(*) as n FROM accounting_journal_entries WHERE is_posted AND qb_txn_id IS NOT NULL`),
    db.query(`SELECT COUNT(*) as n FROM accounting_journal_entries WHERE is_posted AND qb_txn_id IS NULL`),
  ]);

  const mappings = cfg.account_mappings || {};
  const mappedCount = Object.keys(mappings).length;

  return {
    connected: true,
    configured: true,
    environment: cfg.environment,
    realm_id: cfg.realm_id,
    last_sync_at: cfg.last_sync_at,
    token_expires_at: cfg.token_expires_at,
    total_entries: Number(total.rows[0].n),
    synced_entries: Number(synced.rows[0].n),
    unsynced_entries: Number(unsynced.rows[0].n),
    mapped_accounts: mappedCount,
    redirect_uri: getRedirectUri(),
    // Auto-push + scheduled sync
    auto_push_enabled: !!cfg.auto_push_enabled,
    scheduled_sync_enabled: !!cfg.scheduled_sync_enabled,
    sync_interval_minutes: cfg.sync_interval_minutes || 60,
    last_scheduled_sync_at: cfg.last_scheduled_sync_at,
    last_sync_pushed: cfg.last_sync_pushed || 0,
    last_sync_failed: cfg.last_sync_failed || 0,
    last_sync_errors: cfg.last_sync_errors || null,
  };
}

// ─── Auto-push settings ─────────────────────────────────

async function isAutoPushEnabled() {
  const cfg = await getConfig();
  return !!(cfg && cfg.auto_push_enabled);
}

async function isScheduledSyncEnabled() {
  const cfg = await getConfig();
  return !!(cfg && cfg.scheduled_sync_enabled);
}

async function setAutoPush(enabled) {
  await ensureConfigColumns();
  await saveConfig({ auto_push_enabled: !!enabled });
}

async function setScheduledSync(enabled, intervalMinutes = null) {
  await ensureConfigColumns();
  const patch = { scheduled_sync_enabled: !!enabled };
  if (intervalMinutes && intervalMinutes >= 5 && intervalMinutes <= 1440) {
    patch.sync_interval_minutes = intervalMinutes;
  }
  await saveConfig(patch);
}

// ─── Scheduled sync worker ──────────────────────────────
// Called every 5 min by server.js interval. Checks if it's time to run a full
// batch sync based on user's configured interval. Idempotent, non-blocking.

let syncInProgress = false;

async function runScheduledSyncIfDue() {
  if (syncInProgress) {
    console.log("[qbo-scheduler] Previous sync still running — skipping");
    return { skipped: true, reason: "in_progress" };
  }

  const cfg = await getConfig();
  if (!cfg || !cfg.scheduled_sync_enabled) return { skipped: true, reason: "disabled" };
  if (!cfg.access_token) return { skipped: true, reason: "not_connected" };

  // Is it time to sync?
  const intervalMs = (cfg.sync_interval_minutes || 60) * 60 * 1000;
  const lastSync = cfg.last_scheduled_sync_at ? new Date(cfg.last_scheduled_sync_at).getTime() : 0;
  const nowMs = Date.now();
  if (nowMs - lastSync < intervalMs) {
    const minsLeft = Math.ceil((intervalMs - (nowMs - lastSync)) / 60000);
    return { skipped: true, reason: "not_due", minutes_until_next: minsLeft };
  }

  syncInProgress = true;
  console.log("[qbo-scheduler] Starting scheduled sync…");
  try {
    const results = await pushAllUnsyncedEntries({ limit: 200 });
    await saveConfig({
      last_scheduled_sync_at: new Date(),
      last_sync_pushed: results.pushed,
      last_sync_failed: results.failed,
      last_sync_errors: results.errors.slice(0, 10).join(" | ").substring(0, 2000) || null,
    });
    console.log(`[qbo-scheduler] Complete: ${results.pushed} pushed, ${results.failed} failed`);
    return { skipped: false, results };
  } catch (e) {
    console.error("[qbo-scheduler] Failed:", e.message);
    await saveConfig({
      last_scheduled_sync_at: new Date(),
      last_sync_errors: `Sync failed: ${e.message}`.substring(0, 2000),
    });
    return { skipped: false, error: e.message };
  } finally {
    syncInProgress = false;
  }
}

// Start the interval-based worker on module load (server.js requires this module on boot)
function startScheduler() {
  // Check every 5 minutes — the actual sync only runs when the user's configured
  // interval has elapsed since last_scheduled_sync_at
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    runScheduledSyncIfDue().catch(e => console.warn("[qbo-scheduler] tick error:", e.message));
  }, CHECK_INTERVAL_MS);
  console.log("[qbo-scheduler] Started (checks every 5 min)");
}

module.exports = {
  isConfigured, isConnected,
  getAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, disconnect,
  qboRequest, fetchQBOAccounts, fetchCompanyInfo,
  getAccountMappings, saveAccountMapping, autoMapAccounts,
  pushJournalEntry, pushAllUnsyncedEntries,
  getSyncStatus, getConfig, ensureConfigColumns,
  getRedirectUri,
  // Auto-push + scheduled sync
  isAutoPushEnabled, isScheduledSyncEnabled,
  setAutoPush, setScheduledSync,
  runScheduledSyncIfDue, startScheduler,
};
