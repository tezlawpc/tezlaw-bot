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
      last_authorized_at    TIMESTAMPTZ,
      last_used_at          TIMESTAMPTZ,
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
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

async function saveRefreshToken({ refresh_token, account_id, account_name, email }) {
  await initTable();
  await db.query(
    `UPDATE dropbox_settings SET
       refresh_token = $1,
       authorized_account_id = $2,
       authorized_account_name = $3,
       authorized_email = $4,
       last_authorized_at = NOW()
     WHERE id = 1`,
    [refresh_token, account_id, account_name, email]
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

// Generic API call wrapper
async function dropboxApi(endpoint, body, { method = "POST", contentType = "application/json" } = {}) {
  const token = await getAccessToken();
  const url = `https://api.dropboxapi.com/2/${endpoint}`;
  try {
    const resp = await axios({
      method,
      url,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": contentType,
      },
      data: body,
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
  try {
    const resp = await axios.post(
      "https://content.dropboxapi.com/2/files/upload",
      buffer,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path,
            mode,
            autorename,
            mute: true,
            strict_conflict: false,
          }),
        },
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
// Returns the full Dropbox path (e.g. "/Law ICAN Immigration/Kong, Xiangmin") or null.
async function findClientFolder({ clientName, aNumber }) {
  const branches = getBranchRoots();
  if (!branches.length) return null;

  const targetLastFirst = toLastCommaFirst(clientName);
  const targetNorm = normalizeName(targetLastFirst);
  const targetANorm = aNumber ? String(aNumber).toLowerCase().replace(/[^\w]/g, "") : null;

  for (const branch of branches) {
    const branchPath = branch.startsWith("/") ? branch : "/" + branch;

    // First try direct hit: /<branch>/Last, First
    const directPath = `${branchPath}/${targetLastFirst}`;
    const meta = await getMetadata(directPath);
    if (meta && meta[".tag"] === "folder") return directPath;

    // Otherwise, list all subfolders of the branch and fuzzy-match
    const entries = await listFolder(branchPath);
    if (!entries) continue;

    for (const entry of entries) {
      if (entry[".tag"] !== "folder") continue;
      const folderName = entry.name;
      const folderNorm = normalizeName(folderName);
      // Match if folder name contains client's normalized name, or A# appears
      if (folderNorm === targetNorm) return entry.path_display;
      if (targetNorm && folderNorm.includes(targetNorm)) return entry.path_display;
      if (targetANorm && folderNorm.replace(/[^\w]/g, "").includes(targetANorm)) return entry.path_display;
    }
  }
  return null;
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

  const path = await findClientFolder({ clientName, aNumber });
  if (path) {
    await db.query(
      `INSERT INTO client_dropbox_mapping (client_key, a_number, client_name, dropbox_path, resolved_by)
       VALUES ($1, $2, $3, $4, 'auto')
       ON CONFLICT (client_key) DO UPDATE
         SET dropbox_path = EXCLUDED.dropbox_path,
             resolved_at = NOW(),
             a_number = EXCLUDED.a_number,
             client_name = EXCLUDED.client_name`,
      [clientKey, aNumber || null, clientName || null, path]
    );
    return path;
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
  dropboxApi,
  listFolder,
  uploadFile,
  getTemporaryLink,
  deleteFile,
  createFolder,
  getMetadata,
  findClientFolder,
  resolveClientFolder,
  setClientFolderMapping,
  clearClientFolderMapping,
  listClientFiles,
  clearListCache,
  toLastCommaFirst,
  normalizeName,
};
