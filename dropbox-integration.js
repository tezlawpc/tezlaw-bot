// ============================================================
//  TEZ LAW P.C. — DROPBOX INTEGRATION
//  ─────────────────────────────────────────────────────────
//  OAuth2 refresh-token flow + API wrappers for reading and
//  writing files to the firm's Dropbox Business account.
//
//  Setup flow:
//    1. JJ registers a Dropbox app at dropbox.com/developers/apps
//    2. Adds redirect URI:
//       https://tezlaw-bot.onrender.com/admin/dropbox/callback
//    3. Sets env vars: DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
//       DROPBOX_BRANCH_ROOTS (comma-separated)
//    4. Visits /admin/dropbox/setup and clicks Authorize
//    5. OAuth callback saves refresh token to DB
//
//  Runtime:
//    - Refresh token stored in `dropbox_settings` table (single row)
//    - Access tokens obtained on-demand from refresh token (cached
//      in-memory for their 4-hour lifetime)
//    - All API calls use dropboxApi() which handles auth + retry
// ============================================================

const axios = require("axios");
const db = require("./db");

// ── Schema ───────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dropbox_settings (
      id                    INTEGER PRIMARY KEY DEFAULT 1,
      refresh_token         TEXT,
      authorized_account_id TEXT,
      authorized_account_name TEXT,
      authorized_email      TEXT,
      root_namespace_id     TEXT,
      last_authorized_at    TIMESTAMPTZ,
      last_used_at          TIMESTAMPTZ,
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  // Migration: add root_namespace_id if missing
  try { await db.query(`ALTER TABLE dropbox_settings ADD COLUMN IF NOT EXISTS root_namespace_id TEXT`); }
  catch (e) { /* older PG; ignore */ }
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_dropbox_mapping (
      client_key    TEXT PRIMARY KEY,
      a_number      TEXT,
      client_name   TEXT,
      dropbox_path  TEXT NOT NULL,
      resolved_at   TIMESTAMPTZ DEFAULT NOW(),
      resolved_by   TEXT DEFAULT 'auto'
    )
  `);
  // Ensure default settings row exists
  await db.query(`INSERT INTO dropbox_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

// ── Settings helpers ─────────────────────────────────────

async function getSettings() {
  await initTable();
  const r = await db.query(`SELECT * FROM dropbox_settings WHERE id = 1`);
  return r.rows[0] || {};
}

async function saveRefreshToken({ refresh_token, account_id, account_name, email, root_namespace_id }) {
  await initTable();
  await db.query(
    `UPDATE dropbox_settings SET
       refresh_token = $1,
       authorized_account_id = $2,
       authorized_account_name = $3,
       authorized_email = $4,
       root_namespace_id = $5,
       last_authorized_at = NOW()
     WHERE id = 1`,
    [refresh_token, account_id, account_name, email, root_namespace_id || null]
  );
}

function getBranchRoots() {
  const raw = process.env.DROPBOX_BRANCH_ROOTS || "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function isConfigured() {
  return !!(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET);
}

// ── OAuth flow ───────────────────────────────────────────

function authorizeUrl(callbackUrl) {
  const params = new URLSearchParams({
    client_id: process.env.DROPBOX_APP_KEY,
    response_type: "code",
    token_access_type: "offline",       // request refresh token
    redirect_uri: callbackUrl,
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

async function exchangeCodeForToken(code, callbackUrl) {
  const params = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: callbackUrl,
  });
  const auth = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString("base64");
  const resp = await axios.post("https://api.dropboxapi.com/oauth2/token", params, {
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });
  return resp.data; // { access_token, refresh_token, expires_in, account_id, ... }
}

// ── Access token cache ──────────────────────────────────

let _accessToken = null;
let _accessTokenExpiresAt = 0;
let _pathRootHeader = null;      // cached path-root JSON string (team namespace)
let _pathRootFetched = false;    // avoid re-fetching per call

async function getAccessToken() {
  const now = Date.now();
  if (_accessToken && _accessTokenExpiresAt > now + 60000) return _accessToken; // reuse if >1min left

  const settings = await getSettings();
  if (!settings.refresh_token) {
    throw new Error("Dropbox not authorized. Visit /admin/dropbox/setup to connect.");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: settings.refresh_token,
  });
  const auth = Buffer.from(`${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`).toString("base64");
  const resp = await axios.post("https://api.dropboxapi.com/oauth2/token", params, {
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 15000,
  });
  _accessToken = resp.data.access_token;
  _accessTokenExpiresAt = now + ((resp.data.expires_in || 14400) * 1000);
  await db.query(`UPDATE dropbox_settings SET last_used_at = NOW() WHERE id = 1`);
  return _accessToken;
}

// Fetch and cache the team-space root namespace ID so we can access
// team folders (which live outside the user's personal namespace).
async function getPathRootHeader() {
  if (_pathRootFetched) return _pathRootHeader;
  _pathRootFetched = true;
  const settings = await getSettings();
  let rootId = settings.root_namespace_id;
  if (!rootId) {
    // Fetch current account and store root namespace ID
    try {
      const token = await getAccessToken();
      // Use native fetch — axios overrides Content-Type on empty-body POSTs.
      const resp = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "null",
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.warn(`[dropbox] account fetch HTTP ${resp.status}: ${errText}`);
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      rootId = data.root_info?.root_namespace_id;
      if (rootId) {
        await db.query(`UPDATE dropbox_settings SET root_namespace_id = $1 WHERE id = 1`, [rootId]);
      }
    } catch (e) {
      console.warn("[dropbox] could not fetch root namespace:", e.message);
    }
  }
  if (rootId) {
    _pathRootHeader = JSON.stringify({ ".tag": "root", "root": String(rootId) });
  }
  return _pathRootHeader;
}

// Reset the cache — call after re-authorization since namespace may change
function resetTokenCache() {
  _accessToken = null;
  _accessTokenExpiresAt = 0;
  _pathRootHeader = null;
  _pathRootFetched = false;
}

// Generic API call wrapper
async function dropboxApi(endpoint, body, { method = "POST", contentType = "application/json" } = {}) {
  const token = await getAccessToken();
  const pathRoot = await getPathRootHeader();
  const url = `https://api.dropboxapi.com/2/${endpoint}`;
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": contentType,
  };
  if (pathRoot) headers["Dropbox-API-Path-Root"] = pathRoot;
  try {
    const resp = await axios({
      method, url, headers, data: body,
      timeout: 30000,
    });
    return resp.data;
  } catch (e) {
    const detail = e.response?.data?.error_summary || e.response?.data || e.message;
    throw new Error(`Dropbox API error [${endpoint}]: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

// ── File Operations ──────────────────────────────────────

async function listFolder(path) {
  // path can be "" for root, or "/Law ICAN Immigration/Kong, Xiangmin"
  try {
    const result = await dropboxApi("files/list_folder", {
      path: path || "",
      recursive: false,
      include_media_info: false,
      include_deleted: false,
      include_has_explicit_shared_members: false,
    });
    // Handle pagination if there are many files
    const entries = [...result.entries];
    let cursor = result.cursor;
    let hasMore = result.has_more;
    while (hasMore) {
      const more = await dropboxApi("files/list_folder/continue", { cursor });
      entries.push(...more.entries);
      cursor = more.cursor;
      hasMore = more.has_more;
    }
    return entries;
  } catch (e) {
    if (e.message.includes("not_found")) return null; // folder doesn't exist
    throw e;
  }
}

async function uploadFile({ path, buffer, mode = "add", autorename = true }) {
  // Direct upload for files up to 150MB
  const token = await getAccessToken();
  const pathRoot = await getPathRootHeader();
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
    "Dropbox-API-Arg": JSON.stringify({
      path,
      mode,
      autorename,
      mute: true,
      strict_conflict: false,
    }),
  };
  if (pathRoot) headers["Dropbox-API-Path-Root"] = pathRoot;
  try {
    const resp = await axios.post(
      "https://content.dropboxapi.com/2/files/upload",
      buffer,
      {
        headers,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000,
      }
    );
    return resp.data;
  } catch (e) {
    const detail = e.response?.data?.error_summary || e.response?.data || e.message;
    throw new Error(`Dropbox upload failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
}

async function getTemporaryLink(path) {
  const result = await dropboxApi("files/get_temporary_link", { path });
  return result.link; // expires in 4 hours
}

async function deleteFile(path) {
  return await dropboxApi("files/delete_v2", { path });
}

async function createFolder(path) {
  try {
    return await dropboxApi("files/create_folder_v2", { path, autorename: false });
  } catch (e) {
    if (e.message.includes("conflict") || e.message.includes("exists")) return null;
    throw e;
  }
}

async function getMetadata(path) {
  try {
    return await dropboxApi("files/get_metadata", { path });
  } catch (e) {
    if (e.message.includes("not_found")) return null;
    throw e;
  }
}

// ── Client folder resolution ─────────────────────────────

// Normalize a client name for fuzzy matching (case + punctuation insensitive)
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/[^\w\s]/g, "")   // strip punctuation
    .replace(/\s+/g, " ")       // collapse whitespace
    .trim();
}

// Split a name into tokens (words) for order-independent matching.
// "Kong, Xiangmin - A249" → ["kong", "xiangmin"]  (A# skipped, single letters skipped)
function nameTokens(s) {
  const raw = String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")   // punctuation → space
    .split(/\s+/)
    .filter(Boolean);
  // Drop tokens that are:
  //   - Single letter (initial)
  //   - Look like A# (start with 'a' + digits, or all digits)
  //   - Common case-type words that would false-match
  const STOPWORDS = new Set([
    "asylum", "removal", "cancellation", "adjustment", "eoir", "uscis",
    "immigration", "immigrant", "petition", "case", "file", "client",
    "and", "the", "of", "for", "with", "aka", "dba",
    "i589", "i485", "i130", "i130i485",
    "mr", "mrs", "ms", "dr", "hon",
    "jr", "sr", "ii", "iii", "iv",
  ]);
  return raw.filter(t => {
    if (t.length < 2) return false;                    // initials
    if (/^a?\d+$/.test(t)) return false;               // A-numbers or digit blobs
    if (STOPWORDS.has(t)) return false;
    return true;
  });
}

// Extract only the digits from an A-number for tolerant substring matching
function aNumberDigits(a) {
  if (!a) return null;
  const digits = String(a).replace(/[^\d]/g, "");
  return digits.length >= 6 ? digits : null;
}

// Score a folder against a client. Returns {score, reason}.
// Score >= 70 is "good enough to auto-select". Below that = suggest only.
function scoreFolderMatch(folderName, clientTokens, aDigits) {
  const folderTokens = nameTokens(folderName);
  if (!folderTokens.length && !aDigits) return { score: 0, reason: null };

  // A# match wins if present in either — very high signal.
  if (aDigits) {
    const folderDigits = String(folderName).replace(/[^\d]/g, "");
    if (folderDigits && (folderDigits.includes(aDigits) || aDigits.includes(folderDigits))) {
      return { score: 100, reason: `A# match (${aDigits.slice(-4)})` };
    }
  }

  if (!clientTokens.length) return { score: 0, reason: null };

  // How many client name tokens appear in the folder tokens?
  const folderSet = new Set(folderTokens);
  const matched = clientTokens.filter(t => folderSet.has(t));

  if (matched.length === clientTokens.length) {
    // Every part of the client's name is in the folder.
    // "Kong Xiangmin" matches "Kong, Xiangmin", "Xiangmin Kong", "Kong Xiangmin - Asylum".
    return { score: 95, reason: "full name match" };
  }
  if (matched.length >= 2) {
    // Two-word match — likely the same person even if other parts differ.
    return { score: 80, reason: `${matched.length}/${clientTokens.length} name parts match` };
  }
  if (matched.length === 1 && clientTokens.length === 1) {
    // Single-word client name matches single-word folder — modest signal.
    return { score: 60, reason: "single-word name match" };
  }
  if (matched.length === 1 && folderTokens.length <= 3) {
    // Partial match in a short folder name — worth suggesting.
    return { score: 50, reason: `partial: "${matched[0]}" found` };
  }
  return { score: 0, reason: null };
}

// Guess "Last, First" format from a client name that might be "First Last" or "Last, First"
function toLastCommaFirst(name) {
  if (!name) return "";
  const trimmed = name.trim();
  if (trimmed.includes(",")) return trimmed;  // already Last, First
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return trimmed;
  const last = parts.pop();
  return `${last}, ${parts.join(" ")}`;
}

// Try to find a client's Dropbox folder across configured branches.
// Recurses up to MAX_SCAN_DEPTH into sub-branches (e.g. broker folders like "Law Patrick").
// Returns {path, score, reason} for the best auto-match, or null if none scored high enough.
const MAX_SCAN_DEPTH = 2;   // branch → sub-branch → client folder
async function findClientFolder({ clientName, aNumber }) {
  const branches = getBranchRoots();
  if (!branches.length) return null;

  const tokens = nameTokens(clientName);
  const aDigits = aNumberDigits(aNumber);
  const targetLastFirst = toLastCommaFirst(clientName);

  let best = null;

  // Fast path: try exact direct hits first (only at level 1)
  for (const branch of branches) {
    const branchPath = branch.startsWith("/") ? branch : "/" + branch;
    for (const candidateName of [targetLastFirst, targetLastFirst.toUpperCase(), clientName, (clientName || "").toUpperCase()]) {
      if (!candidateName) continue;
      const directPath = `${branchPath}/${candidateName}`;
      const meta = await getMetadata(directPath);
      if (meta && meta[".tag"] === "folder") {
        return { path: directPath, score: 100, reason: `exact match: ${candidateName}`, branch: branchPath };
      }
    }
  }

  // Recursive scan: walk each branch up to MAX_SCAN_DEPTH deep,
  // scoring every folder as a potential client folder along the way.
  async function scanFolder(path, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    const entries = await listFolder(path);
    if (!entries) return;
    for (const entry of entries) {
      if (entry[".tag"] !== "folder") continue;
      const scored = scoreFolderMatch(entry.name, tokens, aDigits);
      if (scored.score > 0) {
        const cand = {
          path: entry.path_display,
          score: scored.score,
          reason: `${scored.reason} @ depth ${depth}`,
          branch: path,
        };
        if (!best || cand.score > best.score) best = cand;
      }
      // Recurse into this folder to check its children too.
      // Skip recursion if we've already found a perfect match to save API calls.
      if (depth < MAX_SCAN_DEPTH && (!best || best.score < 95)) {
        await scanFolder(entry.path_display, depth + 1);
      }
    }
  }

  for (const branch of branches) {
    const branchPath = branch.startsWith("/") ? branch : "/" + branch;
    await scanFolder(branchPath, 1);
    if (best && best.score >= 95) break;  // stop at high-confidence match
  }

  // Only auto-select if we're confident
  return best && best.score >= 70 ? best : null;
}

// Return a ranked list of possible matches (recursive, including lower-scoring ones)
// so the attorney can pick from a "did you mean" list.
async function suggestClientFolders({ clientName, aNumber, minScore = 20, limit = 12 }) {
  const branches = getBranchRoots();
  if (!branches.length) return [];
  const tokens = nameTokens(clientName);
  const aDigits = aNumberDigits(aNumber);
  const suggestions = [];

  async function scanFolder(path, depth) {
    if (depth > MAX_SCAN_DEPTH) return;
    const entries = await listFolder(path);
    if (!entries) return;
    for (const entry of entries) {
      if (entry[".tag"] !== "folder") continue;
      const scored = scoreFolderMatch(entry.name, tokens, aDigits);
      const score = scored.score || (depth === MAX_SCAN_DEPTH ? 10 : 0);
      if (score > 0) {
        suggestions.push({
          path: entry.path_display,
          name: entry.name,
          branch: path,
          depth,
          score,
          reason: scored.reason || `in ${path}`,
        });
      }
      if (depth < MAX_SCAN_DEPTH) await scanFolder(entry.path_display, depth + 1);
    }
  }

  for (const branch of branches) {
    const branchPath = branch.startsWith("/") ? branch : "/" + branch;
    await scanFolder(branchPath, 1);
  }
  return suggestions
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Get cached mapping OR resolve fresh (and cache it)
async function resolveClientFolder({ clientKey, clientName, aNumber, forceRescan = false }) {
  await initTable();
  if (!forceRescan) {
    const cached = await db.query(
      `SELECT dropbox_path FROM client_dropbox_mapping WHERE client_key = $1`,
      [clientKey]
    );
    if (cached.rows[0]) return cached.rows[0].dropbox_path;
  }

  const match = await findClientFolder({ clientName, aNumber });
  if (match && match.path) {
    await db.query(
      `INSERT INTO client_dropbox_mapping (client_key, a_number, client_name, dropbox_path, resolved_by)
       VALUES ($1, $2, $3, $4, 'auto')
       ON CONFLICT (client_key) DO UPDATE
         SET dropbox_path = EXCLUDED.dropbox_path,
             resolved_at = NOW(),
             a_number = EXCLUDED.a_number,
             client_name = EXCLUDED.client_name`,
      [clientKey, aNumber || null, clientName || null, match.path]
    );
    return match.path;
  }
  return null;
}

// Manual mapping override — attorney can set the exact folder path
async function setClientFolderMapping({ clientKey, aNumber, clientName, dropboxPath }) {
  await initTable();
  await db.query(
    `INSERT INTO client_dropbox_mapping (client_key, a_number, client_name, dropbox_path, resolved_by)
     VALUES ($1, $2, $3, $4, 'manual')
     ON CONFLICT (client_key) DO UPDATE
       SET dropbox_path = EXCLUDED.dropbox_path,
           resolved_at = NOW(),
           resolved_by = 'manual'`,
    [clientKey, aNumber || null, clientName || null, dropboxPath]
  );
}

async function clearClientFolderMapping(clientKey) {
  await initTable();
  await db.query(`DELETE FROM client_dropbox_mapping WHERE client_key = $1`, [clientKey]);
}

// ── Higher-level: list a client's files ──────────────────

const _listCache = new Map();
const LIST_CACHE_MS = 5 * 60 * 1000;

async function listClientFiles({ clientKey, clientName, aNumber, useCache = true }) {
  const path = await resolveClientFolder({ clientKey, clientName, aNumber });
  if (!path) return { folder: null, files: [], resolved: false };

  if (useCache) {
    const cached = _listCache.get(path);
    if (cached && (Date.now() - cached.at) < LIST_CACHE_MS) {
      return { folder: path, files: cached.files, resolved: true, cached: true };
    }
  }

  const entries = await listFolder(path);
  if (!entries) return { folder: path, files: [], resolved: true, folder_missing: true };
  const files = entries.filter(e => e[".tag"] === "file").map(e => ({
    name: e.name,
    path: e.path_display,
    id: e.id,
    size: e.size,
    server_modified: e.server_modified,
    client_modified: e.client_modified,
    content_hash: e.content_hash,
  }));
  _listCache.set(path, { files, at: Date.now() });
  return { folder: path, files, resolved: true };
}

function clearListCache(path = null) {
  if (path) _listCache.delete(path);
  else _listCache.clear();
}

module.exports = {
  isConfigured,
  initTable,
  getSettings,
  saveRefreshToken,
  getBranchRoots,
  authorizeUrl,
  exchangeCodeForToken,
  getAccessToken,
  getPathRootHeader,
  resetTokenCache,
  dropboxApi,
  listFolder,
  uploadFile,
  getTemporaryLink,
  deleteFile,
  createFolder,
  getMetadata,
  findClientFolder,
  suggestClientFolders,
  resolveClientFolder,
  setClientFolderMapping,
  clearClientFolderMapping,
  listClientFiles,
  clearListCache,
  toLastCommaFirst,
  normalizeName,
  // Debug helpers
  nameTokens,
  aNumberDigits,
  scoreFolderMatch,
};
