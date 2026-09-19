// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-dropbox.js — SHARED-LINK READER
//  ─────────────────────────────────────────────────────────
//  Reads a Dropbox shared folder link. READ ONLY, by construction:
//  this module has no write, move, rename or delete call, so a bug
//  here cannot disturb the company's own files. The portal takes
//  copies; Dropbox stays the source.
//
//  WHY A SHARED LINK RATHER THAN A CONNECTED ACCOUNT
//  A shared link needs no one to hand the portal their Dropbox
//  credentials and grants no access beyond that one folder. The
//  cost is that Dropbox offers no change notifications for shared
//  links, so the portal polls — hence the scheduled scan.
//
//  CREDENTIALS
//  Listing a shared link still requires an app token, because the
//  API endpoints are authenticated even when the content is public.
//  Two ways to supply it:
//
//    DROPBOX_ACCESS_TOKEN                     — simplest; Dropbox's
//      generated tokens now expire after 4 hours, so this suits
//      testing rather than a daily job.
//    DROPBOX_APP_KEY + DROPBOX_APP_SECRET
//      + DROPBOX_REFRESH_TOKEN                — what a scheduled
//      job should use. The module refreshes as needed and caches
//      the result in memory.
//
//  DROPBOX_SHARED_LINK holds the folder URL itself.
// ============================================================

const https = require("https");

const API_HOST = "api.dropboxapi.com";
const CONTENT_HOST = "content.dropboxapi.com";
const OAUTH_HOST = "api.dropbox.com";

let cachedToken = null;
let cachedUntil = 0;

function configured() {
  return !!(
    process.env.DROPBOX_SHARED_LINK &&
    (process.env.DROPBOX_ACCESS_TOKEN ||
      (process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET && process.env.DROPBOX_REFRESH_TOKEN))
  );
}

function sharedLink() {
  return String(process.env.DROPBOX_SHARED_LINK || "").trim();
}

/** Low-level HTTPS request returning a Buffer plus the response headers. */
function request({ host, path, method = "POST", headers = {}, body = null, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Dropbox request timed out after ${Math.round(timeoutMs / 1000)}s`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Current bearer token, refreshing when a refresh token is configured. */
async function token() {
  if (process.env.DROPBOX_REFRESH_TOKEN && process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET) {
    if (cachedToken && Date.now() < cachedUntil) return cachedToken;
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
    }).toString();
    const basic = Buffer.from(
      `${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`
    ).toString("base64");
    const r = await request({
      host: OAUTH_HOST,
      path: "/oauth2/token",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(form),
      },
      body: form,
    });
    if (r.status !== 200) {
      throw new Error(`Dropbox token refresh failed (${r.status}): ${r.body.toString("utf8").slice(0, 300)}`);
    }
    const j = JSON.parse(r.body.toString("utf8"));
    cachedToken = j.access_token;
    // Refresh a minute early rather than discovering expiry mid-scan.
    cachedUntil = Date.now() + Math.max(60, (j.expires_in || 14400) - 60) * 1000;
    return cachedToken;
  }
  const t = process.env.DROPBOX_ACCESS_TOKEN;
  if (!t) throw new Error("No Dropbox credentials configured.");
  return t;
}

async function rpc(path, payload) {
  const bearer = await token();
  const body = JSON.stringify(payload);
  const r = await request({
    host: API_HOST,
    path,
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
  const text = r.body.toString("utf8");
  if (r.status === 401) {
    cachedToken = null;
    throw new Error("Dropbox rejected the credentials (401). The token may have expired.");
  }
  if (r.status === 429) {
    const retry = Number(r.headers["retry-after"] || 30);
    const e = new Error(`Dropbox rate limit hit; retry after ${retry}s.`);
    e.retryAfter = retry;
    throw e;
  }
  if (r.status !== 200) throw new Error(`Dropbox ${path} failed (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * Every file under the shared folder, recursively.
 *
 * Returns { files, cursor }. Keeping the cursor lets the next scan ask
 * Dropbox only what changed rather than walking the whole tree, which
 * matters once the folder holds years of documents.
 */
async function listAll({ cursor = null, max = 10000 } = {}) {
  const url = sharedLink();
  if (!url) throw new Error("DROPBOX_SHARED_LINK is not set.");

  const files = [];
  let res;
  let cur = cursor;

  if (cur) {
    try {
      res = await rpc("/2/files/list_folder/continue", { cursor: cur });
    } catch (err) {
      // A cursor goes stale if the link is re-shared or the folder is
      // moved. Fall back to a full walk rather than silently importing
      // nothing for ever.
      if (/reset|invalid|expired/i.test(err.message)) {
        cur = null;
      } else {
        throw err;
      }
    }
  }

  if (!res) {
    res = await rpc("/2/files/list_folder", {
      path: "",
      shared_link: { url },
      recursive: true,
      include_deleted: false,
      include_non_downloadable_files: false,
      limit: 1000,
    });
  }

  const take = (r) => {
    for (const e of r.entries || []) {
      if (e[".tag"] !== "file") continue;
      files.push({
        id: e.id,
        name: e.name,
        path: e.path_display || e.path_lower || "/" + e.name,
        rev: e.rev,
        size: e.size,
        contentHash: e.content_hash || null,
        modified: e.server_modified || e.client_modified || null,
      });
    }
  };

  take(res);
  while (res.has_more && files.length < max) {
    res = await rpc("/2/files/list_folder/continue", { cursor: res.cursor });
    take(res);
  }

  return { files, cursor: res.cursor || null, truncated: files.length >= max };
}

/**
 * Download one file from the shared link.
 * `path` is relative to the shared folder root, e.g. "/2026/Bank/stmt.pdf".
 */
async function download(path) {
  const url = sharedLink();
  const bearer = await token();
  const arg = JSON.stringify({ url, path });
  const r = await request({
    host: CONTENT_HOST,
    path: "/2/sharing/get_shared_link_file",
    headers: {
      Authorization: `Bearer ${bearer}`,
      // Dropbox-API-Arg must be HTTP-header safe: escape non-ASCII,
      // which filenames from a company's folder will certainly contain.
      "Dropbox-API-Arg": arg.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")),
    },
  });
  if (r.status === 401) {
    cachedToken = null;
    throw new Error("Dropbox rejected the credentials (401) during download.");
  }
  if (r.status !== 200) {
    throw new Error(`Dropbox download of ${path} failed (${r.status}): ${r.body.toString("utf8").slice(0, 200)}`);
  }
  return r.body;
}

/** Confirm the link and credentials work, without importing anything. */
async function check() {
  if (!configured()) {
    return {
      ok: false,
      error:
        "Dropbox is not configured. Set DROPBOX_SHARED_LINK plus either DROPBOX_ACCESS_TOKEN, or " +
        "DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN.",
    };
  }
  try {
    const meta = await rpc("/2/sharing/get_shared_link_metadata", { url: sharedLink() });
    const probe = await listAll({ max: 200 });
    return {
      ok: true,
      folder: meta.name || "(unnamed)",
      kind: meta[".tag"],
      sampled: probe.files.length,
      truncated: probe.truncated,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { configured, check, listAll, download, sharedLink };
