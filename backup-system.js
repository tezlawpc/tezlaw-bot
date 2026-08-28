// ============================================================
//  TEZ LAW P.C. — DAILY BACKUP SYSTEM
//  ─────────────────────────────────────────────────────────
//  Every day at 3 AM Pacific: dumps every table in the DB
//  to a JSON file and uploads it to /Zara-Backups/ in your
//  Dropbox. Keeps the last 30 days, deletes older backups.
//
//  Restore workflow:
//  - Admin visits /admin/backups
//  - Selects a backup file to restore from
//  - Confirms twice (this overwrites current DB)
//  - Restore runs: truncate all tables → INSERT rows
//
//  What gets backed up: EVERY table in the public schema —
//  admin_users, hearing_notes, individual_hearing_notes,
//  client_hearing_notices, dropbox_settings, audit_log, etc.
//  Nothing hardcoded — new tables auto-included.
// ============================================================

const db = require("./db");
const axios = require("axios");
const zlib = require("zlib");

// Backup folder location — must be a path the OAuth user has WRITE access to.
//
// STRATEGY: Backups go to your HOME namespace (personal Dropbox area), not
// team space. Home namespace has guaranteed write access; team-space root
// requires team-admin OAuth scope which we don't have.
//
// This is different from client data which uses team-space paths via the
// Dropbox-API-Path-Root header. Backups are system infrastructure — they
// don't need to be visible to the team.
//
// Override via env var ZARA_BACKUP_FOLDER if you need to relocate.
const BACKUP_FOLDER = process.env.ZARA_BACKUP_FOLDER || "/Zara-Backups";
const RETENTION_DAYS = 30;
// If true, skip the Dropbox-API-Path-Root header for backup operations —
// this forces the API to operate against the user's home namespace instead
// of the team space root, giving guaranteed write access.
const USE_HOME_NAMESPACE = true;
const TIMEZONE_OFFSET_HOURS = -8;   // Pacific (approx)
const CRON_HOUR = 3;                 // Run at 3 AM Pacific

// ── Snapshot all tables to a JSON object ─────────────────

async function createSnapshot() {
  // Discover all tables in the public schema — nothing hardcoded so new
  // features automatically get backed up as they add tables.
  const tablesResult = await db.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const tables = tablesResult.rows.map(r => r.tablename);

  const snapshot = {
    version: "1.0",
    created_at: new Date().toISOString(),
    tables: {},
    counts: {},
  };

  for (const tbl of tables) {
    try {
      // Safely quote table name to prevent identifier issues
      const dataRes = await db.query(`SELECT * FROM "${tbl.replace(/"/g, '""')}"`);
      snapshot.tables[tbl] = dataRes.rows;
      snapshot.counts[tbl] = dataRes.rows.length;
    } catch (e) {
      console.warn(`[backup] Failed to snapshot table ${tbl}:`, e.message);
      snapshot.counts[tbl] = "ERROR: " + e.message;
    }
  }
  return snapshot;
}

// ── Upload to Dropbox ────────────────────────────────────

async function uploadToDropbox(filename, buffer) {
  const dbx = require("./dropbox-integration");
  const token = await dbx.getAccessToken();
  // Skip path root header if configured — this operates in the user's
  // home namespace where they have guaranteed write access.
  const pathRootHeader = USE_HOME_NAMESPACE ? null : await dbx.getPathRootHeader();

  // Validate filename — Dropbox is strict about forbidden characters
  // (/ \ < > : " | ? * and trailing dots) and expects the full path to
  // start with /. Reject early with a clear message.
  if (/[<>:"|?*\\]/.test(filename)) {
    throw new Error(`Backup filename contains forbidden characters: ${filename}`);
  }
  if (!BACKUP_FOLDER.startsWith("/")) {
    throw new Error(`BACKUP_FOLDER must start with /: ${BACKUP_FOLDER}`);
  }

  const fullPath = `${BACKUP_FOLDER}/${filename}`;

  // Ensure /Zara-Backups folder exists (create_folder is idempotent-safe with autorename=false)
  try {
    const createFolderHeaders = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (pathRootHeader) createFolderHeaders["Dropbox-API-Path-Root"] = pathRootHeader;
    await axios.post(
      "https://api.dropboxapi.com/2/files/create_folder_v2",
      { path: BACKUP_FOLDER, autorename: false },
      { headers: createFolderHeaders, timeout: 15000 }
    );
    console.log(`[backup] Created folder ${BACKUP_FOLDER}`);
  } catch (e) {
    // "conflict" errors are OK — folder already exists
    const dbxError = e.response?.data?.error_summary || "";
    const dbxRawError = e.response?.data || null;
    if (dbxError.includes("conflict") || dbxError.includes("path/conflict")) {
      // Folder exists, that's fine
    } else {
      console.warn(`[backup] create_folder failed with non-conflict error. Dropbox response:`,
        JSON.stringify(dbxRawError).substring(0, 500));
      // Don't throw — try the upload anyway since folder might exist from before
    }
  }

  const uploadArgs = {
    path: fullPath,
    mode: "overwrite",
    autorename: false,
    mute: true,
  };

  const uploadHeaders = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
    "Dropbox-API-Arg": JSON.stringify(uploadArgs),
  };
  if (pathRootHeader) uploadHeaders["Dropbox-API-Path-Root"] = pathRootHeader;

  console.log(`[backup] Uploading ${(buffer.length / 1024).toFixed(1)}KB to ${fullPath}`);
  console.log(`[backup] Using path root header:`, pathRootHeader || "(none)");

  let resp;
  try {
    resp = await axios.post(
      "https://content.dropboxapi.com/2/files/upload",
      buffer,
      {
        headers: uploadHeaders,
        maxBodyLength: 200 * 1024 * 1024,
        maxContentLength: 200 * 1024 * 1024,
        timeout: 120000,
      }
    );
  } catch (e) {
    // Extract detailed error from Dropbox response body
    const status = e.response?.status;
    const errData = e.response?.data;
    let dbxMessage = "";
    if (errData) {
      // Dropbox may return either a JSON object or a raw string
      if (typeof errData === "string") {
        dbxMessage = errData;
      } else if (errData.error_summary) {
        dbxMessage = errData.error_summary;
      } else if (errData.error) {
        dbxMessage = typeof errData.error === "string" ? errData.error : JSON.stringify(errData.error);
      } else {
        dbxMessage = JSON.stringify(errData).substring(0, 300);
      }
    }
    console.error(`[backup] Upload failed HTTP ${status}: ${dbxMessage}`);
    console.error(`[backup] Path root header sent:`, pathRootHeader);
    console.error(`[backup] Upload path:`, fullPath);
    // Throw a rich error that includes context so it flows to the UI
    throw new Error(
      `Dropbox upload failed (HTTP ${status || "?"}): ${dbxMessage || e.message}. ` +
      `Path: ${fullPath}. ` +
      (pathRootHeader ? `Path root header was sent. ` : `No path root header sent. `) +
      `Check server logs for full details.`
    );
  }
  return { path: fullPath, size: resp.data.size, uploaded_at: resp.data.server_modified };
}

// ── List existing backups in Dropbox ─────────────────────

async function listBackups() {
  const dbx = require("./dropbox-integration");
  try {
    const token = await dbx.getAccessToken();
    const pathRootHeader = USE_HOME_NAMESPACE ? null : await dbx.getPathRootHeader();
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (pathRootHeader) headers["Dropbox-API-Path-Root"] = pathRootHeader;

    const resp = await axios.post(
      "https://api.dropboxapi.com/2/files/list_folder",
      { path: BACKUP_FOLDER, recursive: false },
      { headers, timeout: 30000 }
    );
    const entries = resp.data.entries || [];
    return entries
      .filter(e => e[".tag"] === "file" && e.name.startsWith("zara-backup-"))
      .map(e => ({
        name: e.name,
        path: e.path_display,
        size: e.size,
        server_modified: e.server_modified,
        client_modified: e.client_modified,
      }))
      .sort((a, b) => new Date(b.server_modified) - new Date(a.server_modified));
  } catch (e) {
    // Folder may not exist yet — that's OK, return empty list
    const msg = e.response?.data?.error_summary || "";
    if (msg.includes("not_found") || msg.includes("path/not_found")) return [];
    console.warn("[backup] list failed:", e.message, msg);
    return [];
  }
}

// ── Delete backups older than RETENTION_DAYS ─────────────

async function pruneOldBackups() {
  const dbx = require("./dropbox-integration");
  const backups = await listBackups();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const token = await dbx.getAccessToken();
  const pathRootHeader = USE_HOME_NAMESPACE ? null : await dbx.getPathRootHeader();
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (pathRootHeader) headers["Dropbox-API-Path-Root"] = pathRootHeader;

  let deleted = 0;
  for (const b of backups) {
    if (new Date(b.server_modified).getTime() < cutoff) {
      try {
        await axios.post(
          "https://api.dropboxapi.com/2/files/delete_v2",
          { path: b.path },
          { headers, timeout: 30000 }
        );
        deleted++;
      } catch (e) {
        console.warn(`[backup] failed to delete old backup ${b.name}:`, e.message);
      }
    }
  }
  return deleted;
}

// ── Full backup: snapshot + upload + prune ───────────────

async function runBackup({ manual = false } = {}) {
  const startTime = Date.now();
  console.log(`[backup] Starting ${manual ? "manual" : "scheduled"} backup at`, new Date().toISOString());

  const snapshot = await createSnapshot();
  const totalRows = Object.values(snapshot.counts).reduce(
    (sum, c) => sum + (typeof c === "number" ? c : 0), 0
  );

  // Compress with gzip — legal data compresses ~90%
  const json = JSON.stringify(snapshot);
  const compressed = zlib.gzipSync(json);

  const dateStr = new Date().toISOString().substring(0, 10);
  const timeStr = new Date().toISOString().substring(11, 19).replace(/:/g, "-");
  const filename = `zara-backup-${dateStr}_${timeStr}.json.gz`;

  const uploadResult = await uploadToDropbox(filename, compressed);
  const deletedOld = await pruneOldBackups();
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  const summary = {
    ok: true,
    filename,
    dropbox_path: uploadResult.path,
    tables_backed_up: Object.keys(snapshot.tables).length,
    total_rows: totalRows,
    raw_size_bytes: json.length,
    compressed_size_bytes: compressed.length,
    compression_ratio: (100 * (1 - compressed.length / json.length)).toFixed(1) + "%",
    old_backups_deleted: deletedOld,
    duration_seconds: durationSec,
    manual,
  };

  console.log(`[backup] ✅ Done in ${durationSec}s — ${totalRows} rows across ${Object.keys(snapshot.tables).length} tables — ${(compressed.length / 1024).toFixed(1)}KB uploaded`);

  // Send Telegram alert with summary
  try {
    await sendTelegramAlert(summary);
  } catch (e) {
    console.warn("[backup] Telegram alert failed:", e.message);
  }

  return summary;
}

async function sendTelegramAlert(summary) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const jjChatId = process.env.RECIPIENT_JJ_TELEGRAM_ID || process.env.RECIPIENT_JUE_TELEGRAM_ID;
  if (!token || !jjChatId) return;
  const msg = `📦 Daily Zara backup complete

📅 ${new Date().toLocaleDateString()}
📊 ${summary.total_rows} rows / ${summary.tables_backed_up} tables
💾 ${(summary.compressed_size_bytes / 1024).toFixed(1)} KB (${summary.compression_ratio} compression)
⏱️ ${summary.duration_seconds}s
🗑️ ${summary.old_backups_deleted} old backup(s) pruned

File: ${summary.filename}
${summary.manual ? "(triggered manually)" : "(scheduled 3 AM Pacific)"}`;
  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: jjChatId, text: msg },
    { timeout: 10000 }
  );
}

// ── Restore from a backup ────────────────────────────────

async function downloadBackup(dropboxPath) {
  const dbx = require("./dropbox-integration");
  const token = await dbx.getAccessToken();
  const pathRootHeader = USE_HOME_NAMESPACE ? null : await dbx.getPathRootHeader();
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }),
  };
  if (pathRootHeader) headers["Dropbox-API-Path-Root"] = pathRootHeader;
  const resp = await axios.post(
    "https://content.dropboxapi.com/2/files/download",
    null,
    {
      headers,
      responseType: "arraybuffer",
      maxContentLength: 200 * 1024 * 1024,
      timeout: 120000,
    }
  );
  const buffer = Buffer.from(resp.data);
  const decompressed = zlib.gunzipSync(buffer);
  return JSON.parse(decompressed.toString("utf8"));
}

// Restore preview — download and count without applying
async function previewRestore(dropboxPath) {
  const snapshot = await downloadBackup(dropboxPath);
  return {
    created_at: snapshot.created_at,
    tables: Object.keys(snapshot.tables).length,
    counts: snapshot.counts,
    total_rows: Object.values(snapshot.counts).reduce(
      (sum, c) => sum + (typeof c === "number" ? c : 0), 0
    ),
  };
}

// Restore: WIPES ALL DATA and reloads from the snapshot
// Use with extreme care. Consider taking a fresh backup right before.
async function restoreFromBackup(dropboxPath) {
  console.log("[backup] RESTORE starting from", dropboxPath);

  // Take a "just-before-restore" snapshot first as safety net
  let preRestoreSnapshotPath = null;
  try {
    const preSnapshot = await createSnapshot();
    const preJson = JSON.stringify(preSnapshot);
    const preCompressed = zlib.gzipSync(preJson);
    const preFilename = `zara-pre-restore-${new Date().toISOString().substring(0, 19).replace(/:/g, "-")}.json.gz`;
    const uploadRes = await uploadToDropbox(preFilename, preCompressed);
    preRestoreSnapshotPath = uploadRes.path;
    console.log("[backup] Pre-restore safety snapshot saved to", preRestoreSnapshotPath);
  } catch (e) {
    console.warn("[backup] Failed to save pre-restore snapshot:", e.message);
    // Continue — the source backup is still there
  }

  const snapshot = await downloadBackup(dropboxPath);
  const tables = Object.keys(snapshot.tables);
  const restored = { tables_wiped: 0, tables_restored: 0, rows_inserted: 0, errors: [] };

  // NOTE: Restore runs sequentially on the pool's query interface. Each
  // db.query() call may go to a different backend connection, so we can't
  // wrap the whole thing in one BEGIN/COMMIT. Instead we disable FK checks
  // per-statement using session_replication_role, then truncate + insert
  // table-by-table. If something fails partway, the pre-restore snapshot
  // above is our undo path.
  try {
    // Truncate all tables first (session_replication_role prevents FK errors)
    await db.query("SET session_replication_role = replica");
    for (const tbl of tables) {
      try {
        await db.query(`TRUNCATE TABLE "${tbl.replace(/"/g, '""')}" RESTART IDENTITY CASCADE`);
        restored.tables_wiped++;
      } catch (e) {
        restored.errors.push({ table: tbl, phase: "truncate", error: e.message });
      }
    }

    // Insert rows from snapshot
    for (const tbl of tables) {
      const rows = snapshot.tables[tbl] || [];
      if (!rows.length) { restored.tables_restored++; continue; }
      const columns = Object.keys(rows[0]);
      const columnList = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(", ");
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      const insertSql = `INSERT INTO "${tbl.replace(/"/g, '""')}" (${columnList}) VALUES (${placeholders})`;

      for (const row of rows) {
        try {
          const values = columns.map(c => {
            const v = row[c];
            // JSON columns come out as objects — need to stringify for INSERT
            if (v !== null && typeof v === "object" && !(v instanceof Date)) {
              return JSON.stringify(v);
            }
            return v;
          });
          await db.query(insertSql, values);
          restored.rows_inserted++;
        } catch (e) {
          restored.errors.push({ table: tbl, phase: "insert", error: e.message.substring(0, 200) });
        }
      }
      restored.tables_restored++;

      // Re-sync serial sequences so future INSERTs get correct IDs
      try {
        await db.query(`
          SELECT setval(
            pg_get_serial_sequence('"${tbl.replace(/"/g, '""')}"', 'id'),
            COALESCE((SELECT MAX(id) FROM "${tbl.replace(/"/g, '""')}"), 1)
          )
        `);
      } catch { /* not all tables have serial id */ }
    }
    await db.query("SET session_replication_role = DEFAULT");
    console.log("[backup] RESTORE completed");
  } catch (e) {
    console.error("[backup] RESTORE failed:", e.message);
    restored.errors.push({ table: "ALL", phase: "restore", error: e.message });
    // Try to restore FK checks even on error
    try { await db.query("SET session_replication_role = DEFAULT"); } catch { /* silent */ }
    throw e;
  }

  return {
    ...restored,
    source_backup: dropboxPath,
    pre_restore_snapshot: preRestoreSnapshotPath,
    snapshot_created_at: snapshot.created_at,
  };
}

// ── Cron scheduler ────────────────────────────────────────

let _lastRunDate = null;
function startCron() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000;   // check every hour

  async function tick() {
    try {
      const now = new Date();
      const pacificHour = (now.getUTCHours() + TIMEZONE_OFFSET_HOURS + 24) % 24;
      const dateKey = now.toISOString().substring(0, 10);
      if (pacificHour === CRON_HOUR && _lastRunDate !== dateKey) {
        _lastRunDate = dateKey;
        console.log("[backup] cron trigger at", now.toISOString());
        try {
          await runBackup({ manual: false });
        } catch (e) {
          console.error("[backup] scheduled backup failed:", e.message);
          try { await sendTelegramAlert({ error: e.message }); } catch { /* silent */ }
        }
      }
    } catch (e) {
      console.error("[backup] cron tick error:", e.message);
    }
  }

  setTimeout(tick, 2 * 60 * 1000);   // first tick 2 min after boot
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log(`✅ Backup cron scheduled (${CRON_HOUR}:00 Pacific daily)`);
}

// ── Admin viewer page ─────────────────────────────────────

function renderBackupsPage({ backups, lastBackup, stats }) {
  const hearingNotes = require("./hearing-notes");

  const rows = backups.map(b => {
    const sizeKB = (b.size / 1024).toFixed(1);
    const dt = new Date(b.server_modified);
    const ageHours = (Date.now() - dt.getTime()) / (1000 * 60 * 60);
    const ageStr = ageHours < 24 ? `${Math.floor(ageHours)}h ago`
                  : ageHours < 24 * 7 ? `${Math.floor(ageHours / 24)}d ago`
                  : `${Math.floor(ageHours / (24 * 7))}w ago`;
    const isRecent = ageHours < 30;
    return `
      <tr>
        <td style="font-family:monospace; font-size:12px;">${escapeHtml(b.name)}</td>
        <td style="font-size:12px;">${dt.toLocaleString()} <span style="color:${isRecent ? "#2e7d32" : "#888"};">(${ageStr})</span></td>
        <td style="font-size:12px;">${sizeKB} KB</td>
        <td>
          <button onclick="previewBackup('${b.path.replace(/'/g, "\\'")}')" style="background:#eee; color:#333; padding:5px 10px; border:none; border-radius:3px; cursor:pointer; font-size:11px; margin-right:4px;">Preview</button>
          <button onclick="restoreBackup('${b.path.replace(/'/g, "\\'")}', '${escapeHtml(b.name)}')" style="background:#c00; color:white; padding:5px 10px; border:none; border-radius:3px; cursor:pointer; font-size:11px;">Restore</button>
        </td>
      </tr>`;
  }).join("");

  const body = `
    <div class="page-header">
      <h1>📦 Backups</h1>
      <div style="font-size:13px; color:#666;">
        Daily backups of Zara's entire database, uploaded to <code style="font-size:11px;">/Zara-Backups/</code> in your Dropbox.
        Runs at 3 AM Pacific. Keeps the last 30 days.
      </div>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:20px;">
      <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee; border-top:3px solid #B79C62;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600;">Total Backups</div>
        <div style="font-size:26px; font-weight:600; color:#0C1C36; margin-top:4px;">${backups.length}</div>
      </div>
      <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee; border-top:3px solid ${lastBackup && (Date.now() - new Date(lastBackup.server_modified).getTime()) < 30 * 60 * 60 * 1000 ? "#2e7d32" : "#c00"};">
        <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600;">Latest Backup</div>
        <div style="font-size:16px; font-weight:600; color:#0C1C36; margin-top:4px;">
          ${lastBackup ? new Date(lastBackup.server_modified).toLocaleString() : "<span style='color:#c00;'>None yet</span>"}
        </div>
      </div>
      <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee; border-top:3px solid #0061FF;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; font-weight:600;">Retention</div>
        <div style="font-size:16px; font-weight:600; color:#0C1C36; margin-top:4px;">30 days</div>
        <div style="font-size:10px; color:#888; margin-top:2px;">Older auto-deleted</div>
      </div>
    </div>

    <div style="background:white; padding:15px 20px; border-radius:6px; margin-bottom:20px; border:1px solid #eee;">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
        <div>
          <strong>Manual backup:</strong>
          <span style="font-size:12px; color:#666;">Force a backup right now (in addition to the daily 3 AM run).</span>
        </div>
        <button onclick="runBackupNow()" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">🚀 Backup now</button>
      </div>
      <div id="backup-status" style="margin-top:10px; font-size:13px;"></div>
    </div>

    <div style="background:#fef3f0; padding:15px 20px; border-radius:6px; margin-bottom:20px; border-left:4px solid #c62828;">
      <strong style="color:#c62828;">⚠️ Restore warning</strong>
      <div style="font-size:12px; color:#666; margin-top:6px;">
        Restore <strong>wipes ALL current Zara data</strong> and replaces it with the selected backup.
        Every existing record (hearings, clients, users, audit log) will be gone.
        A safety snapshot is automatically saved right before restore, so you can undo — but only if you catch it fast.
        <strong>Test restores by starting with a Preview first.</strong>
      </div>
    </div>

    <table style="background:white; width:100%; font-size:13px;">
      <thead>
        <tr><th>Filename</th><th>Uploaded</th><th>Size</th><th>Actions</th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="4" style="text-align:center; color:#888; padding:20px;">No backups yet. Click "Backup now" or wait for the daily 3 AM run.</td></tr>'}</tbody>
    </table>

    <div id="preview-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:10000; align-items:center; justify-content:center;">
      <div style="background:white; padding:20px 24px; border-radius:8px; max-width:600px; width:90%; max-height:80vh; overflow-y:auto;">
        <h3 style="margin:0 0 10px 0; color:#0C1C36;">📋 Backup preview</h3>
        <div id="preview-content" style="font-size:13px;">Loading…</div>
        <div style="margin-top:16px; text-align:right;">
          <button onclick="document.getElementById('preview-modal').style.display='none'" style="background:#eee; padding:8px 14px; border:none; border-radius:4px; cursor:pointer;">Close</button>
        </div>
      </div>
    </div>

    <script>
      async function runBackupNow() {
        const status = document.getElementById("backup-status");
        status.innerHTML = '<span style="color:#666;">⏳ Running backup (this can take 10-30 seconds)…</span>';
        try {
          const r = await fetch("/admin/backups/run-now", { method: "POST" });
          const d = await r.json();
          if (d.ok) {
            status.innerHTML = '<span style="color:#2e7d32;">✅ Backup complete! ' +
              d.result.total_rows + ' rows / ' + d.result.tables_backed_up + ' tables / ' +
              (d.result.compressed_size_bytes / 1024).toFixed(1) + ' KB uploaded in ' + d.result.duration_seconds + 's.</span>';
            setTimeout(() => location.reload(), 2500);
          } else {
            status.innerHTML = '<span style="color:#c00;">❌ ' + (d.error || "unknown error") + '</span>';
          }
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
        }
      }
      async function previewBackup(path) {
        const modal = document.getElementById("preview-modal");
        const content = document.getElementById("preview-content");
        content.innerHTML = "Loading…";
        modal.style.display = "flex";
        try {
          const r = await fetch("/admin/backups/preview?path=" + encodeURIComponent(path));
          const d = await r.json();
          if (!d.ok) { content.innerHTML = '<span style="color:#c00;">❌ ' + d.error + '</span>'; return; }
          const rows = Object.entries(d.preview.counts).map(([t, c]) =>
            '<tr><td style="font-family:monospace; font-size:11px;">' + t + '</td><td style="text-align:right;">' + c + '</td></tr>'
          ).join("");
          content.innerHTML =
            '<div style="margin-bottom:10px;"><strong>Snapshot from:</strong> ' + new Date(d.preview.created_at).toLocaleString() + '</div>' +
            '<div><strong>Total rows:</strong> ' + d.preview.total_rows.toLocaleString() + ' across ' + d.preview.tables + ' tables</div>' +
            '<table style="width:100%; margin-top:10px; font-size:12px;"><thead><tr><th style="text-align:left;">Table</th><th style="text-align:right;">Rows</th></tr></thead><tbody>' + rows + '</tbody></table>';
        } catch (e) {
          content.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
        }
      }
      async function restoreBackup(path, name) {
        if (!confirm("⚠️ RESTORE from " + name + "?\\n\\nThis will WIPE all current data and replace it with the backup.\\n\\nA safety snapshot is saved first, but this is still destructive.")) return;
        if (!confirm("Are you REALLY sure?\\n\\nType 'yes' in the next prompt to confirm.")) return;
        const confirmText = prompt("Type 'restore' (exactly) to confirm:");
        if (confirmText !== "restore") { alert("Cancelled."); return; }
        const status = document.getElementById("backup-status");
        status.innerHTML = '<span style="color:#666;">⏳ Restoring — do NOT close this page…</span>';
        try {
          const r = await fetch("/admin/backups/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          });
          const d = await r.json();
          if (d.ok) {
            status.innerHTML = '<span style="color:#2e7d32;">✅ Restore complete: ' +
              d.result.tables_restored + ' tables, ' + d.result.rows_inserted + ' rows inserted. ' +
              (d.result.errors.length ? d.result.errors.length + ' errors — check server logs.' : '') +
              '<br><strong>You may need to log in again.</strong></span>';
            setTimeout(() => location.href = "/admin/dashboard", 4000);
          } else {
            status.innerHTML = '<span style="color:#c00;">❌ Restore failed: ' + (d.error || "unknown") + '</span>';
          }
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
        }
      }
    </script>`;
  return hearingNotes.renderAdminChrome({ title: "Backups", body, activeItem: null });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = {
  runBackup,
  listBackups,
  previewRestore,
  restoreFromBackup,
  pruneOldBackups,
  startCron,
  renderBackupsPage,
  BACKUP_FOLDER,
};
