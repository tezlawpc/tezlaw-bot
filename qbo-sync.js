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
const crypto = require("crypto");
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
    // CSRF: the one-time value we put in the OAuth state and expect back.
    "ADD COLUMN IF NOT EXISTS oauth_state TEXT",
    "ADD COLUMN IF NOT EXISTS oauth_state_at TIMESTAMPTZ",
    // Intuit's request id, for their support team to trace a call.
    "ADD COLUMN IF NOT EXISTS last_intuit_tid TEXT",
    // Set when Intuit tells us the grant is dead, so the UI stops claiming
    // a connection that no longer exists.
    "ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ",
  ];
  for (const alter of alters) {
    try { await db.query(`ALTER TABLE accounting_qb_config ${alter}`); } catch {}
  }
}

/**
 * Which company's books an operation is for.
 *
 * Omitted means the law firm, matching accounting.companyIdOf — every caller
 * written before there were two entities omits it and means Tez Law.
 */
async function companyIdOf(company_id) {
  return await require("./accounting").companyIdOf(company_id);
}

/**
 * The QuickBooks connection for ONE company.
 *
 * This used to be `ORDER BY id DESC LIMIT 1` — a single global connection,
 * newest wins. That is the whole of JJ's original symptom: after connecting
 * the second QuickBooks company, the first one stopped syncing, because every
 * read of the config returned the newer row and the older connection became
 * unreachable without ever being disconnected. Nothing reported an error;
 * one company simply went quiet.
 */
async function getConfig(company_id = null) {
  await ensureConfigColumns();
  const cid = await companyIdOf(company_id);
  const r = await db.query(
    `SELECT * FROM accounting_qb_config WHERE company_id = $1 ORDER BY id DESC LIMIT 1`, [cid]);
  return r.rows[0] || null;
}

/** Every company that currently has a live QuickBooks connection. */
async function connectedConfigs() {
  await ensureConfigColumns();
  const r = await db.query(
    `SELECT c.*, co.name AS company_name
       FROM accounting_qb_config c
       JOIN accounting_companies co ON co.id = c.company_id
      WHERE c.access_token IS NOT NULL AND c.realm_id IS NOT NULL
      ORDER BY co.id`);
  return r.rows;
}

async function saveConfig(fields, company_id = null) {
  const cid = await companyIdOf(company_id);
  const existing = await getConfig(cid);
  fields = { ...fields, company_id: cid };
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

async function isConnected(company_id = null) {
  const cfg = await getConfig(company_id);
  if (!cfg || !cfg.access_token || !cfg.realm_id) return false;
  // Intuit told us the grant is dead. Reporting "connected" here is how the
  // screen ends up lying about a connection that stopped working days ago.
  if (cfg.revoked_at) return false;
  // Check token freshness — refresh_token valid ~100 days
  if (cfg.token_expires_at && new Date(cfg.token_expires_at) < new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)) {
    return false;
  }
  return true;
}

// ─── OAuth flow ─────────────────────────────────────────

/**
 * The consent URL for ONE company.
 *
 * The company id travels in `state` because Intuit hands that back on the
 * callback, and the callback is otherwise unable to tell which set of books
 * the tokens it just received belong to. Getting that wrong would attach the
 * business's QuickBooks file to the law firm's ledger.
 */
async function getAuthorizeUrl(company_id = null) {
  // Resolved here rather than taken on trust, so the state always names a
  // real company. Built from a raw argument it could read "tez-0" or
  // "tez-NaN", which parses back to nothing and quietly attaches the tokens
  // to whichever company the fallback picked.
  const cid = await companyIdOf(company_id);

  // THE STATE IS ALSO A CSRF TOKEN, and until now it was not one. It carried
  // only "tez-<id>", which is guessable, never checked against anything, and
  // therefore no protection at all: anyone could hand our callback an
  // authorization code of their choosing and we would exchange it and store
  // the resulting tokens against this company. A single-use random value,
  // stored server-side and compared on return, is what makes the callback
  // able to tell its own flow from somebody else's.
  const nonce = crypto.randomBytes(24).toString("base64url");
  const state = "tez-" + cid + "-" + nonce;
  await saveConfig({ oauth_state: state, oauth_state_at: new Date() }, cid);
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    scope: SCOPES,
    redirect_uri: getRedirectUri(),
    state,
  });
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/** Read the company id back off the OAuth state. Null if it is not ours. */
function companyFromState(state) {
  const m = /^tez-([1-9]\d*)-[\w-]{16,}$/.exec(String(state || ""));
  return m ? Number(m[1]) : null;
}

/**
 * Confirm a returned state is the one WE issued for this company, and recent.
 *
 * Compared with timingSafeEqual rather than ===, and cleared on use so a
 * state cannot be replayed. Fifteen minutes is longer than any real consent
 * flow and short enough that an abandoned one cannot be picked up later.
 */
async function consumeState(state, company_id) {
  const cid = await companyIdOf(company_id);
  const cfg = await getConfig(cid);
  const expected = cfg && cfg.oauth_state;
  if (!expected) throw new Error("No connection was started for this company — begin again from Connect");

  const a = Buffer.from(String(state || ""));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("This sign-in did not come from a connection started here. Press Connect and try again.");
  }

  const issued = cfg.oauth_state_at ? new Date(cfg.oauth_state_at).getTime() : 0;
  // Single use: clear it before doing anything else with the code.
  await saveConfig({ oauth_state: null, oauth_state_at: null }, cid);
  if (!issued || Date.now() - issued > 15 * 60 * 1000) {
    throw new Error("That connection attempt expired. Press Connect and try again.");
  }
  return cid;
}

async function exchangeCodeForTokens(code, realmId, company_id = null) {
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

  const cid = await companyIdOf(company_id);

  // One QuickBooks file per set of books, and never the same file twice.
  // Two companies pointed at one realm would push both ledgers into it, and
  // the entries would interleave with no way to tell them apart afterwards.
  const clash = await db.query(
    `SELECT c.company_id, co.name
       FROM accounting_qb_config c
       JOIN accounting_companies co ON co.id = c.company_id
      WHERE c.realm_id = $1 AND c.company_id <> $2`, [realmId, cid]);
  if (clash.rows[0]) {
    throw new Error(
      `That QuickBooks company is already connected to ${clash.rows[0].name}. ` +
      `Disconnect it there first, or pick a different QuickBooks company.`);
  }

  await saveConfig({
    realm_id: realmId,
    access_token,
    refresh_token,
    token_expires_at: expiresAt,
    environment: getEnv(),
    last_sync_at: null,
    revoked_at: null,
    oauth_state: null,
    oauth_state_at: null,
  }, cid);

  return { realm_id: realmId, expires_at: expiresAt, company_id: cid };
}

async function refreshAccessToken(company_id = null) {
  const cid = await companyIdOf(company_id);
  const cfg = await getConfig(cid);
  if (!cfg || !cfg.refresh_token) throw new Error("No refresh token — reconnect required");

  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // INVALID_GRANT IS NOT A TRANSIENT ERROR. It means the refresh token is
  // dead — revoked from inside QuickBooks, expired after 100 days of no use,
  // or superseded. Intuit does not tell this app when a user disconnects at
  // their end, so without this the stored tokens sit there and the admin
  // screen keeps reporting a live connection while every sync quietly fails.
  // Recording it is what lets the UI say "reconnect" instead of "connected".
  let resp;
  try {
    resp = await axios.post(
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
  } catch (e) {
    const body = e && e.response && e.response.data;
    const code = body && (body.error || body.Fault);
    if (String(code) === "invalid_grant" || (e.response && e.response.status === 400)) {
      await saveConfig({
        access_token: null,
        refresh_token: null,
        revoked_at: new Date(),
        last_sync_errors: "QuickBooks rejected the saved authorisation (invalid_grant). Press Connect to reauthorise.",
      }, cid);
      throw new Error("QuickBooks has revoked this connection — press Connect to reauthorise.");
    }
    throw e;
  }

  const { access_token, refresh_token, expires_in } = resp.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000);

  await saveConfig({
    access_token,
    refresh_token: refresh_token || cfg.refresh_token,
    token_expires_at: expiresAt,
    revoked_at: null,          // a successful refresh clears any earlier doubt
  }, cid);

  return access_token;
}

// Get a fresh access token — refreshes automatically if expired
async function getValidAccessToken(company_id = null) {
  const cid = await companyIdOf(company_id);
  const cfg = await getConfig(cid);
  if (!cfg || !cfg.access_token) throw new Error("Not connected to QuickBooks — click Connect first");
  const expiresAt = cfg.token_expires_at ? new Date(cfg.token_expires_at) : null;
  const buffer = 60 * 1000; // refresh 60s before actual expiry
  if (expiresAt && expiresAt.getTime() - buffer <= Date.now()) {
    return await refreshAccessToken(cid);
  }
  return cfg.access_token;
}

async function disconnect(company_id = null) {
  const cid = await companyIdOf(company_id);
  const cfg = await getConfig(cid);
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

  // Clear stored tokens FOR THIS COMPANY ONLY. This was an unqualified
  // DELETE, which with a second set of books would have signed the law firm
  // out of QuickBooks because somebody disconnected the other business — and
  // the only symptom would have been that one company silently stopped
  // syncing, which is the bug this whole change exists to fix.
  await db.query(`DELETE FROM accounting_qb_config WHERE company_id = $1`, [cid]);
}

// ─── QBO API calls ──────────────────────────────────────

async function qboRequest({ method = "GET", path, data = null, params = {}, company_id = null }) {
  const cid = await companyIdOf(company_id);
  const token = await getValidAccessToken(cid);
  const cfg = await getConfig(cid);
  const base = apiBase(cfg.environment || getEnv());
  const url = `${base}/${cfg.realm_id}${path}`;

  // intuit_tid is the id Intuit's own support uses to find a request in their
  // logs. Keeping it turns "the sync failed" into something they can trace,
  // and they ask for it on every ticket. Captured from success AND failure —
  // the failing call is the one anybody ever needs to look up.
  const opts = {
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
  };

  let resp;
  try {
    resp = await axios(opts);
  } catch (e) {
    const tid = e && e.response && e.response.headers && e.response.headers["intuit_tid"];
    if (tid) {
      console.error(`[qbo] ${method} ${path} failed — intuit_tid ${tid}`);
      try { await saveConfig({ last_intuit_tid: String(tid).slice(0, 120) }, cid); } catch {}
      e.message = `${e.message} (intuit_tid ${tid})`;
    }
    throw e;
  }

  const tid = resp.headers && resp.headers["intuit_tid"];
  if (tid) {
    try { await saveConfig({ last_intuit_tid: String(tid).slice(0, 120) }, cid); } catch {}
  }
  return resp.data;
}

// Fetch all accounts from QBO (for mapping)
async function fetchQBOAccounts(company_id = null) {
  const data = await qboRequest({
    path: `/query`,
    params: { query: "SELECT * FROM Account MAXRESULTS 1000" },
    company_id,
  });
  return (data?.QueryResponse?.Account) || [];
}

// Fetch company info (used to verify connection)
async function fetchCompanyInfo(company_id = null) {
  const cid = await companyIdOf(company_id);
  const cfg = await getConfig(cid);
  const data = await qboRequest({ path: `/companyinfo/${cfg.realm_id}`, company_id: cid });
  return data?.CompanyInfo || null;
}

// ─── Account mapping ────────────────────────────────────
// Maps our internal chart of accounts (account_number → id) to QBO Account IDs.
// Stored in accounting_qb_config.account_mappings as JSON:
//   { "1010": "qbAcctId1", "1020": "qbAcctId2", ... }

// NOTE: mappings are keyed by OUR account number, and both companies have an
// account "1010". They are only unambiguous because each company has its own
// config row — a single shared mapping would have pointed the law firm's 1010
// at whichever QuickBooks account was mapped last.
async function getAccountMappings(company_id = null) {
  const cfg = await getConfig(company_id);
  return cfg?.account_mappings || {};
}

async function saveAccountMapping(ourAccountNumber, qbAccountId, company_id = null) {
  const cid = await companyIdOf(company_id);
  const cfg = await getConfig(cid);
  const mappings = cfg?.account_mappings || {};
  mappings[String(ourAccountNumber)] = String(qbAccountId);
  await saveConfig({ account_mappings: JSON.stringify(mappings) }, cid);
}

// Auto-match by name — call after connecting to try automatic mapping
// Our account types map one-to-one onto QuickBooks' Classification. A name
// that matches across a type boundary is a different account that happens to
// share a word, never the same account.
const QBO_CLASSIFICATION = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expense",
};

// Compare names the way a person would: case, punctuation and "&" versus
// "and" are noise. Everything else has to agree exactly.
function normAccountName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Decide which of our accounts map onto which QuickBooks accounts.
 *
 * Pure: no database, no network. autoMapAccounts() does the I/O around it,
 * and the check script feeds it the firm's real account names.
 *
 * THE BUG THIS REPLACES
 *   The previous version fell back to
 *       shortName = ours.name.replace(/ - .+$/, "")   // "Cash - IOLTA Trust Account" -> "Cash"
 *       qb.Name.toLowerCase().includes(shortName)     // matches "Cash on hand"
 *   Against the firm's actual realm that mapped the IOLTA trust account to
 *   petty cash, sent the operating account to the same target, and collapsed
 *   all seven "Legal Fees - ..." income accounts onto whichever matched
 *   first. A wrong trust mapping posts client money into a firm account, so
 *   this now refuses every match it is not certain of and hands it back for a
 *   person to make.
 *
 * RULES
 *   1. Names must be equal once normalized. No substrings, no prefixes.
 *   2. The QuickBooks Classification must agree with our account type.
 *   3. Two candidates is not a match. It is an ambiguity, and it is reported.
 *   4. One QuickBooks account can back only one of ours.
 *   5. Trust accounts are never mapped automatically, however good the match.
 */
function planAccountMappings(ourAccounts, qboAccounts, existing = {}) {
  const mappings = { ...existing };
  const report = { matched: 0, mapped: [], ambiguous: [], unmatched: [], skipped_trust: [] };

  // A QuickBooks account already spoken for cannot be claimed again.
  const claimed = new Set(Object.values(mappings).map(String));

  for (const ours of ourAccounts || []) {
    if (mappings[ours.account_number]) continue;

    // Rule 5. The cost of a wrong guess here is client money in a firm
    // account, which no amount of convenience justifies.
    if (ours.subtype === "trust_bank" || ours.subtype === "trust") {
      report.skipped_trust.push({ account_number: ours.account_number, name: ours.name });
      continue;
    }

    const want = normAccountName(ours.name);
    const wantClass = QBO_CLASSIFICATION[String(ours.type || "").toLowerCase()] || null;

    const candidates = (qboAccounts || []).filter(qb => {
      if (normAccountName(qb.Name) !== want) return false;                                   // rule 1
      if (wantClass && qb.Classification && qb.Classification !== wantClass) return false;   // rule 2
      if (claimed.has(String(qb.Id))) return false;                                          // rule 4
      return true;
    });

    if (candidates.length === 1) {
      const hit = candidates[0];
      mappings[ours.account_number] = String(hit.Id);
      claimed.add(String(hit.Id));
      report.matched++;
      report.mapped.push({
        account_number: ours.account_number,
        name: ours.name,
        qb_id: String(hit.Id),
        qb_name: hit.Name,
      });
    } else if (candidates.length > 1) {                                                      // rule 3
      report.ambiguous.push({
        account_number: ours.account_number,
        name: ours.name,
        candidates: candidates.map(c => ({ id: String(c.Id), name: c.Name })),
      });
    } else {
      report.unmatched.push({ account_number: ours.account_number, name: ours.name });
    }
  }

  report.needs_manual =
    report.ambiguous.length + report.unmatched.length + report.skipped_trust.length;
  return { mappings, report };
}

async function autoMapAccounts(company_id = null) {
  const accounting = require("./accounting");
  const cid = await companyIdOf(company_id);
  // listAccounts(cid), not listAccounts(). Unscoped it returns the law firm's
  // chart, so mapping the other business would have matched the firm's
  // account names against the business's QuickBooks file.
  const [ourAccounts, qboAccounts] = await Promise.all([
    accounting.listAccounts(cid),
    fetchQBOAccounts(cid),
  ]);
  const existing = await getAccountMappings(cid);

  const { mappings, report } = planAccountMappings(ourAccounts, qboAccounts, existing);

  await saveConfig({ account_mappings: JSON.stringify(mappings) }, cid);
  return { ...report, our_total: ourAccounts.length, qbo_total: qboAccounts.length };
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

  // THE COMPANY COMES FROM THE ENTRY, never from an argument or a default.
  // An entry is already on one company's books by the time it gets here, and
  // the only correct destination is that company's QuickBooks file. A caller
  // passing the wrong id, or a default quietly resolving to the law firm,
  // would file the other business's revenue into the firm's books — in
  // QuickBooks, where it becomes someone's tax return.
  const cid = entry.company_id;
  if (!cid) throw new Error(`Entry ${entryId} has no company — refusing to guess which books it belongs to`);

  const mappings = await getAccountMappings(cid);
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
    company_id: cid,
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

async function pushAllUnsyncedEntries({ limit = 100, from_date = null, company_id = null } = {}) {
  const cid = await companyIdOf(company_id);
  // Scoped to one company's entries. Unscoped, a sync of the business would
  // sweep up the law firm's unsynced entries too and push them through
  // whichever connection this call happened to be using.
  const conds = ["is_posted = TRUE", "qb_txn_id IS NULL", "company_id = $1"];
  const params = [cid];
  let i = 2;
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

  await saveConfig({ last_sync_at: new Date() }, cid);
  return results;
}

// ─── Sync status ────────────────────────────────────────

async function getSyncStatus(company_id = null) {
  const cid = await companyIdOf(company_id);
  const company = await require("./accounting").getCompany(cid);
  const cfg = await getConfig(cid);
  if (cfg && cfg.revoked_at) {
    return {
      connected: false,
      revoked: true,
      configured: isConfigured(),
      environment: cfg.environment || getEnv(),
      redirect_uri: getRedirectUri(),
      company_id: cid,
      company_name: company ? company.name : null,
      last_sync_errors: cfg.last_sync_errors || null,
      last_intuit_tid: cfg.last_intuit_tid || null,
    };
  }
  if (!cfg) {
    return {
      connected: false,
      configured: isConfigured(),
      environment: getEnv(),
      redirect_uri: getRedirectUri(),
      company_id: cid,
      company_name: company ? company.name : null,
    };
  }

  // Counts are per company. Shown side by side with another company's, an
  // unscoped total would have made both look like they had the same backlog.
  const [total, synced, unsynced] = await Promise.all([
    db.query(`SELECT COUNT(*) as n FROM accounting_journal_entries WHERE is_posted AND company_id = $1`, [cid]),
    db.query(`SELECT COUNT(*) as n FROM accounting_journal_entries WHERE is_posted AND qb_txn_id IS NOT NULL AND company_id = $1`, [cid]),
    db.query(`SELECT COUNT(*) as n FROM accounting_journal_entries WHERE is_posted AND qb_txn_id IS NULL AND company_id = $1`, [cid]),
  ]);

  const mappings = cfg.account_mappings || {};
  const mappedCount = Object.keys(mappings).length;

  return {
    connected: true,
    configured: true,
    company_id: cid,
    company_name: company ? company.name : null,
    last_intuit_tid: cfg.last_intuit_tid || null,
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

async function isAutoPushEnabled(company_id = null) {
  const cfg = await getConfig(company_id);
  return !!(cfg && cfg.auto_push_enabled);
}

async function isScheduledSyncEnabled(company_id = null) {
  const cfg = await getConfig(company_id);
  return !!(cfg && cfg.scheduled_sync_enabled);
}

async function setAutoPush(enabled, company_id = null) {
  await ensureConfigColumns();
  await saveConfig({ auto_push_enabled: !!enabled }, company_id);
}

async function setScheduledSync(enabled, intervalMinutes = null, company_id = null) {
  await ensureConfigColumns();
  const patch = { scheduled_sync_enabled: !!enabled };
  if (intervalMinutes && intervalMinutes >= 5 && intervalMinutes <= 1440) {
    patch.sync_interval_minutes = intervalMinutes;
  }
  await saveConfig(patch, company_id);
}

// ─── Scheduled sync worker ──────────────────────────────
// Called every 5 min by server.js interval. Checks if it's time to run a full
// batch sync based on user's configured interval. Idempotent, non-blocking.

let syncInProgress = false;

/**
 * Run the scheduled sync for EVERY connected company that is due.
 *
 * JJ asked for both sets of books syncing at the same time. This used to read
 * one config row and sync one company, which — with the old single-row
 * config — meant whichever connection was made most recently. The other
 * company was never synced and nothing said so.
 *
 * Each company keeps its own interval and its own last-run timestamp, so one
 * being due does not drag the other along, and one failing does not stop the
 * rest. The in-progress flag stays global on purpose: QuickBooks rate-limits
 * per app, not per company file, so two concurrent batches would throttle
 * each other.
 */
async function runScheduledSyncIfDue() {
  if (syncInProgress) {
    console.log("[qbo-scheduler] Previous sync still running — skipping");
    return { skipped: true, reason: "in_progress" };
  }

  const configs = await connectedConfigs();
  if (!configs.length) return { skipped: true, reason: "not_connected" };

  const due = configs.filter(cfg => {
    if (!cfg.scheduled_sync_enabled) return false;
    const intervalMs = (cfg.sync_interval_minutes || 60) * 60 * 1000;
    const last = cfg.last_scheduled_sync_at ? new Date(cfg.last_scheduled_sync_at).getTime() : 0;
    return Date.now() - last >= intervalMs;
  });

  if (!due.length) {
    // Report the nearest one so "nothing happened" is legible.
    let soonest = null;
    for (const cfg of configs.filter(c => c.scheduled_sync_enabled)) {
      const intervalMs = (cfg.sync_interval_minutes || 60) * 60 * 1000;
      const last = cfg.last_scheduled_sync_at ? new Date(cfg.last_scheduled_sync_at).getTime() : 0;
      const mins = Math.ceil((intervalMs - (Date.now() - last)) / 60000);
      if (soonest === null || mins < soonest) soonest = mins;
    }
    return soonest === null
      ? { skipped: true, reason: "disabled" }
      : { skipped: true, reason: "not_due", minutes_until_next: soonest };
  }

  syncInProgress = true;
  const perCompany = [];
  try {
    for (const cfg of due) {
      const label = cfg.company_name || ("company " + cfg.company_id);
      console.log(`[qbo-scheduler] Starting scheduled sync for ${label}…`);
      try {
        const results = await pushAllUnsyncedEntries({ limit: 200, company_id: cfg.company_id });
        await saveConfig({
          last_scheduled_sync_at: new Date(),
          last_sync_pushed: results.pushed,
          last_sync_failed: results.failed,
          last_sync_errors: results.errors.slice(0, 10).join(" | ").substring(0, 2000) || null,
        }, cfg.company_id);
        console.log(`[qbo-scheduler] ${label}: ${results.pushed} pushed, ${results.failed} failed`);
        perCompany.push({ company_id: cfg.company_id, company_name: cfg.company_name, results });
      } catch (e) {
        // One company's failure must not stop the others. The old version had
        // a single try/catch around the whole thing, so an expired token on
        // one connection would have silently skipped the other company too.
        console.error(`[qbo-scheduler] ${label} failed:`, e.message);
        await saveConfig({
          last_scheduled_sync_at: new Date(),
          last_sync_errors: `Sync failed: ${e.message}`.substring(0, 2000),
        }, cfg.company_id);
        perCompany.push({ company_id: cfg.company_id, company_name: cfg.company_name, error: e.message });
      }
    }
    return { skipped: false, companies: perCompany };
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
  // Pure, so the check can run the real matching logic without a database
  // or a network. The bug this guards against was invisible to a source scan.
  planAccountMappings, normAccountName,
  pushJournalEntry, pushAllUnsyncedEntries,
  getSyncStatus, getConfig, ensureConfigColumns,
  getRedirectUri,
  // Auto-push + scheduled sync
  isAutoPushEnabled, isScheduledSyncEnabled,
  setAutoPush, setScheduledSync,
  runScheduledSyncIfDue, startScheduler,
  // Multi-company
  connectedConfigs, companyFromState, companyIdOf,
  // OAuth CSRF
  consumeState,
};
