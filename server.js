// ============================================================
//  server.js — Tez Law P.C. | Zara — All Bots Combined
//  Telegram + WhatsApp + Facebook Messenger + WeChat + Website
// ============================================================

const express  = require("express");
const axios    = require("axios");
const crypto   = require("crypto");
const xml2js   = require("xml2js");
const FormData = require("form-data");
const fs       = require("fs");
const { initDB, clearHistory, getHistory } = require("./db");
const { scheduleWeeklyAnalytics, runWeeklyAnalysis } = require("./analytics");
const { askClaudeWithMemory }     = require("./askClaude-memory");
const { transcribeAudio }         = require("./whisper");
const { sendVoiceReply }          = require("./voice");
const { checkIntake, initIntakeTable } = require("./intake");
const { isJJAuthenticated }       = require("./jj-mode");
const { router: adminRouter, handleAdminCallback, initPromptTable, getSavedPrompt } = require("./admin");
const { checkCompliance, initComplianceTable } = require("./compliance");
const { scheduleUSCISRefresh, buildLivePrompt } = require("./uscis-updater");
const { startHotLeadMonitor } = require("./hot-leads");
const { handleIncomingCall, handleRespond, handleCallStatus, handleAudio, handleTransfer, handleTransferFallback, handleTranscription } = require("./voice-call");
const { startSolScheduler }   = require("./sol");
const { startDripScheduler }  = require("./drip");
const cookieParser = require("cookie-parser");

// ── Legal Intelligence modules ────────────────────────────
const { scheduleDigest, runDailyDigest }         = require("./legal-digest");
const { initCitationTables }                      = require("./citations");
const { initJudgeProfileTables, getScanStatus }   = require("./judge-scanner");
const { initCacheTable, getCacheStats, purgeExpiredCache } = require("./answer-cache");

// Matter manager: REST routes (mounted at /admin/matters) + .ics calendar feed
const { router: matterManagerRouter, handleCalendarFeed, ingestEmailText } = require("./matter-manager");
const multer  = require("multer");
const db      = require("./db");
const pdfParse = require("pdf-parse");

// In-memory multer for SendGrid inbound webhook (multipart/form-data).
// 25MB per file, 50MB per request total — handles typical EOIR PDFs (usually <2MB)
// with plenty of headroom for unusual cases.
const sendgridUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 }
});

// General document upload — used by /extract-document, /extract-i589,
// /extract-summary, /extract-exhibits. 32MB matches Anthropic PDF upload limit.
// Declared here (not later) so route definitions can reference it in order.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

// Extract text from a PDF buffer. Returns "" on error (so a corrupted PDF
// doesn't tank the whole ingest — we keep the email body for parsing).
async function extractPdfText(buffer, filename) {
  try {
    const data = await pdfParse(buffer);
    return data.text || "";
  } catch (err) {
    console.warn(`PDF extraction failed for ${filename}:`, err.message);
    return "";
  }
}

// Research module is loaded inside admin.js so it inherits admin auth.

const app = express();
// Body parser limits raised from 100kb default to 25mb so hearing note forms
// with extensive Q&A rows, closing arguments, and multiple witnesses don't
// hit "payload too large" errors. Individual merits prep can easily reach 1-3mb.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb", parameterLimit: 50000 }));
app.use(express.text({ type: "text/xml" }));
app.use(cookieParser());

// ── Authentication ─────────────────────────────────────────
// CRITICAL ORDER:
//   1. requireAdminAuth middleware FIRST — sets req.user on every /admin/*
//      request before any route handler runs.
//   2. Role-based middleware SECOND — checks req.user for specific paths.
//   3. auth.mount() LAST — registers login/logout/setup/users routes that
//      depend on req.user being set (via requireRole checks inside).
//
// If you register routes BEFORE requireAdminAuth, req.user is undefined when
// the route handler runs and every request fails with 401.
const auth = require("./auth");
app.use("/admin", auth.requireAdminAuth);

// ── Role-based access control ─────────────────────────────
// Admin-only feature areas (JJ only): Dropbox OAuth setup, email
// configuration, user management, system utilities. Regular hearing/client
// work is open to attorneys + paralegals via the individual route mounts.
app.use("/admin/dropbox/setup",     auth.requireRole("admin"));
app.use("/admin/dropbox/callback",  auth.requireRole("admin"));
app.use("/admin/dropbox/diag",      auth.requireRole("admin"));
app.use("/admin/dropbox/raw-account", auth.requireRole("admin"));
app.use("/admin/email-setup",       auth.requireRole("admin"));
app.use("/admin/init-drafts",       auth.requireRole("admin"));
app.use("/admin/inbound-log",       auth.requireRole("admin"));

// Hearing note WRITE actions require admin or attorney role.
// Attach a router-level middleware that only fires on write methods.
app.use("/admin/hearing", (req, res, next) => {
  if (req.method === "GET") return next();   // reads allowed for paralegals + viewers
  // WRITE operations require admin or attorney
  return auth.requireRole("admin", "attorney")(req, res, next);
});

// Now mount the login/logout/setup/users routes AFTER all middleware.
auth.mount(app);

// ── Backups (admin only) ─────────────────────────────────
app.get("/admin/backups", auth.requireRole("admin"), async (req, res) => {
  try {
    const backups = require("./backup-system");
    const list = await backups.listBackups();
    const lastBackup = list[0] || null;
    res.send(backups.renderBackupsPage({ backups: list, lastBackup, stats: {} }));
  } catch (err) {
    console.error("[backups]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Mini-backup diagnostic — runs the FULL pipeline with just the users table
// to isolate where things fail. Returns detailed timing and phase info.
app.post("/admin/backups/test-mini", auth.requireRole("admin"), async (req, res) => {
  const trace = { phases: [], overall_ok: false };
  const startPhase = (name) => {
    const p = { phase: name, started_at: new Date().toISOString(), started_ms: Date.now() };
    trace.phases.push(p);
    return p;
  };
  const endPhase = (p, extra = {}) => {
    p.finished_at = new Date().toISOString();
    p.duration_seconds = ((Date.now() - p.started_ms) / 1000).toFixed(2);
    Object.assign(p, extra);
    delete p.started_ms;
  };

  try {
    // Phase 1: Query a small table (admin_users) — schema-aware
    let p = startPhase("query_admin_users");
    const usersRes = await db.query(`SELECT id, username, full_name, role FROM admin_users LIMIT 100`);
    endPhase(p, { row_count: usersRes.rows.length });

    // Phase 2: Discover all tables (metadata only)
    p = startPhase("list_tables");
    const tables = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    endPhase(p, { table_count: tables.rows.length });

    // Phase 3: Detect BYTEA columns across all tables
    p = startPhase("detect_bytea");
    const byteaMap = {};
    for (const t of tables.rows) {
      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type='bytea'`,
        [t.tablename]
      );
      if (cols.rows.length) byteaMap[t.tablename] = cols.rows.map(c => c.column_name);
    }
    endPhase(p, { bytea_columns: byteaMap });

    // Phase 4: Table sizes — critical for identifying the hang culprit
    p = startPhase("table_sizes");
    const sizes = await db.query(`
      SELECT
        relname AS table_name,
        pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
        pg_total_relation_size(relid) AS total_size_bytes,
        n_live_tup AS row_estimate
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 20
    `);
    endPhase(p, { top_tables: sizes.rows });

    // Phase 4b: Investigate case_files specifically — this is where the last
    // real backup hung. Get its exact schema.
    p = startPhase("investigate_case_files");
    try {
      const caseCols = await db.query(`
        SELECT column_name, data_type, character_maximum_length
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='case_files'
        ORDER BY ordinal_position
      `);
      const caseRowCount = await db.query(`SELECT COUNT(*) FROM case_files`);
      endPhase(p, {
        exists: true,
        columns: caseCols.rows,
        row_count: parseInt(caseRowCount.rows[0].count, 10),
      });
    } catch (e) {
      endPhase(p, { exists: false, error: e.message });
    }

    // Phase 5: Compress a small JSON payload
    p = startPhase("compress_test");
    const zlib = require("zlib");
    const testJson = JSON.stringify({ test: usersRes.rows });
    const compressed = zlib.gzipSync(testJson);
    endPhase(p, { raw_bytes: testJson.length, compressed_bytes: compressed.length });

    // Phase 6: Upload the small payload to Dropbox
    p = startPhase("upload_dropbox");
    const backups = require("./backup-system");
    const uploadRes = await backups.uploadToDropbox("zara-test-mini-" + Date.now() + ".json.gz", compressed);
    endPhase(p, { uploaded_to: uploadRes.path, size: uploadRes.size });

    // Phase 7: Delete the test file
    p = startPhase("cleanup_test_file");
    try {
      const dbx = require("./dropbox-integration");
      const token = await dbx.getAccessToken();
      const axios = require("axios");
      await axios.post(
        "https://api.dropboxapi.com/2/files/delete_v2",
        { path: uploadRes.path },
        { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15000 }
      );
      endPhase(p, { deleted: true });
    } catch (delErr) {
      endPhase(p, { deleted: false, warning: delErr.message });
    }

    trace.overall_ok = true;
    trace.total_seconds = ((Date.now() - trace.phases[0].started_ms) / 1000).toFixed(2);
    // Strip started_ms from output for cleanliness
    for (const ph of trace.phases) { delete ph.started_ms; }
    res.json(trace);
  } catch (err) {
    const currentPhase = trace.phases[trace.phases.length - 1];
    if (currentPhase && !currentPhase.finished_at) {
      currentPhase.finished_at = new Date().toISOString();
      currentPhase.error = err.message;
      currentPhase.stack = err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : null;
    }
    trace.error = err.message;
    trace.stack = err.stack ? err.stack.split("\n").slice(0, 8).join("\n") : null;
    res.status(500).json(trace);
  }
});

// Persistent backup status via DB so it survives Render restarts. Also
// captures progress phases (querying/serializing/compressing/uploading/pruning)
// so the client can show what stage is running.
async function initBackupStatusTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS backup_status (
      id           INTEGER PRIMARY KEY DEFAULT 1,
      running      BOOLEAN DEFAULT false,
      phase        TEXT,
      progress     JSONB DEFAULT '{}'::jsonb,
      last_result  JSONB,
      started_at   TIMESTAMP,
      finished_at  TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`INSERT INTO backup_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // Reset stale "running" state on boot — if the process died mid-backup,
  // don't leave the status locked forever.
  await db.query(`UPDATE backup_status SET running = false, phase = 'reset_on_restart', updated_at = NOW() WHERE running = true AND updated_at < NOW() - INTERVAL '10 minutes'`);
}

async function setBackupStatus({ running, phase, progress, last_result, started_at, finished_at }) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (running !== undefined) { sets.push(`running = $${i++}`); vals.push(running); }
  if (phase !== undefined) { sets.push(`phase = $${i++}`); vals.push(phase); }
  if (progress !== undefined) { sets.push(`progress = $${i++}::jsonb`); vals.push(JSON.stringify(progress)); }
  if (last_result !== undefined) { sets.push(`last_result = $${i++}::jsonb`); vals.push(JSON.stringify(last_result)); }
  if (started_at !== undefined) { sets.push(`started_at = $${i++}`); vals.push(started_at); }
  if (finished_at !== undefined) { sets.push(`finished_at = $${i++}`); vals.push(finished_at); }
  sets.push(`updated_at = NOW()`);
  await db.query(`UPDATE backup_status SET ${sets.join(", ")} WHERE id = 1`, vals);
}

async function getBackupStatus() {
  await initBackupStatusTable();
  const { rows } = await db.query(`SELECT * FROM backup_status WHERE id = 1`);
  return rows[0] || { running: false, phase: null, progress: {}, last_result: null };
}

app.post("/admin/backups/run-now", auth.requireRole("admin"), async (req, res) => {
  const current = await getBackupStatus();
  if (current.running) {
    return res.json({ ok: true, status: "already_running", message: "A backup is already in progress. Check /admin/backups/status.", started_at: current.started_at });
  }
  await setBackupStatus({
    running: true,
    phase: "starting",
    progress: {},
    started_at: new Date(),
    finished_at: null,
  });

  // Kick off the backup in the background — do NOT await it in the request.
  (async () => {
    try {
      const backups = require("./backup-system");
      const result = await backups.runBackup({
        manual: true,
        onProgress: async (progress) => {
          try {
            await setBackupStatus({ phase: progress.phase, progress });
          } catch (e) { console.warn("[backup] progress update failed:", e.message); }
        },
      });
      await setBackupStatus({
        running: false,
        phase: "completed",
        last_result: { ...result, status: "completed", finished_at: new Date().toISOString() },
        finished_at: new Date(),
      });
    } catch (err) {
      console.error("[backup run]:", err.message, err.stack);
      await setBackupStatus({
        running: false,
        phase: "failed",
        last_result: { status: "failed", error: err.message, finished_at: new Date().toISOString() },
        finished_at: new Date(),
      });
    }
  })();

  res.json({ ok: true, status: "started", message: "Backup started in background. Poll /admin/backups/status for progress." });
});

app.get("/admin/backups/status", auth.requireRole("admin"), async (req, res) => {
  try {
    const status = await getBackupStatus();
    res.json({
      ok: true,
      running: status.running,
      phase: status.phase,
      progress: status.progress || {},
      started_at: status.started_at,
      finished_at: status.finished_at,
      last: status.last_result,
      updated_at: status.updated_at,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reset stuck backup status manually (admin escape hatch)
app.post("/admin/backups/reset-status", auth.requireRole("admin"), async (req, res) => {
  try {
    await setBackupStatus({
      running: false,
      phase: "manually_reset",
      finished_at: new Date(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/backups/preview", auth.requireRole("admin"), async (req, res) => {
  try {
    const backups = require("./backup-system");
    const path = req.query.path;
    if (!path) return res.status(400).json({ ok: false, error: "Missing path" });
    const preview = await backups.previewRestore(path);
    res.json({ ok: true, preview });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/backups/restore", auth.requireRole("admin"), async (req, res) => {
  try {
    const backups = require("./backup-system");
    const path = req.body.path;
    if (!path) return res.status(400).json({ ok: false, error: "Missing path" });
    const result = await backups.restoreFromBackup(path);
    res.json({ ok: true, result });
  } catch (err) {
    console.error("[backup restore]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnostic — tests each step of the backup flow in isolation so we can
// pinpoint which specific Dropbox call is failing.
app.get("/admin/backups/diagnose", auth.requireRole("admin"), async (req, res) => {
  const dbx = require("./dropbox-integration");
  const backups = require("./backup-system");
  const diag = {
    steps: [],
    overall_ok: true,
    backup_folder: backups.BACKUP_FOLDER,
    namespace_mode: "home (skipping path root header for backups)",
  };

  // Step 1: Access token
  let token;
  try {
    token = await dbx.getAccessToken();
    diag.steps.push({ step: "1. Get access token", ok: true, detail: `Token starts with: ${token.substring(0, 8)}...` });
  } catch (e) {
    diag.steps.push({ step: "1. Get access token", ok: false, error: e.message });
    diag.overall_ok = false;
    return res.json(diag);
  }

  // Step 2: Team-space path root header (INFO only, not used for backups)
  try {
    const header = await dbx.getPathRootHeader();
    diag.steps.push({ step: "2. Team-space path root (not used for backups)", ok: true, detail: `Header value would be: ${header || "(none)"}` });
  } catch (e) {
    diag.steps.push({ step: "2. Team-space path root (not used for backups)", ok: false, error: e.message });
  }

  // Step 3: List backup folder in HOME namespace (no path root header)
  try {
    const list = await backups.listBackups();
    diag.steps.push({ step: `3. List ${backups.BACKUP_FOLDER} in home namespace`, ok: true, detail: `Found ${list.length} existing backup(s)` });
  } catch (e) {
    diag.steps.push({ step: `3. List ${backups.BACKUP_FOLDER} in home namespace`, ok: false, error: e.message });
  }

  // Step 4: Test upload to HOME namespace (no path root header)
  try {
    const testBuf = Buffer.from("test", "utf8");
    const testPath = `${backups.BACKUP_FOLDER}/_diagnose_${Date.now()}.txt`;
    // NO Dropbox-API-Path-Root header — targets home namespace directly
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: testPath, mode: "overwrite", autorename: false, mute: true }),
    };
    await axios.post("https://content.dropboxapi.com/2/files/upload", testBuf, {
      headers, timeout: 30000,
    });
    diag.steps.push({ step: "4. Test upload (4 bytes) to home namespace", ok: true, detail: `Uploaded to ${testPath}` });

    // Try to delete the test file (also via home namespace)
    try {
      await axios.post(
        "https://api.dropboxapi.com/2/files/delete_v2",
        { path: testPath },
        { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15000 }
      );
    } catch { /* silent */ }
  } catch (e) {
    const errData = e.response?.data;
    let dbxMsg = "";
    if (errData) {
      dbxMsg = typeof errData === "string" ? errData
             : errData.error_summary ? errData.error_summary
             : JSON.stringify(errData).substring(0, 300);
    }
    diag.steps.push({
      step: "4. Test upload (4 bytes) to home namespace",
      ok: false,
      error: e.message,
      dropbox_response: dbxMsg,
      status: e.response?.status,
      hint: dbxMsg.includes("no_write_permission")
        ? `Even the home namespace has no write access — check OAuth scope. Your app may be misconfigured.`
        : dbxMsg.includes("malformed_path")
        ? `Path format is invalid: ${backups.BACKUP_FOLDER}. Set ZARA_BACKUP_FOLDER env var to a valid path starting with /.`
        : null,
    });
    diag.overall_ok = false;
  }

  res.json(diag);
});

// Version check endpoint — hit this to verify which build of the code is
// actually running on Render. Helps diagnose "changes didn't deploy" issues.
app.get("/version", (req, res) => {
  res.json({
    version: "v7-eoir-calendar-2026-08-28",
    features: {
      auto_match_tool_use: true,
      hearing_note_dedup: true,
      revision_history: true,
      backup_system: true,
      bulk_upload: true,
      voice_dictation: true,
      audit_log_instrumented: true,
    },
    server_time: new Date().toISOString(),
  });
});

// ── Triage Dashboard ─────────────────────────────────────
// ── Personal Injury Case Management ───────────────────────
// CA-specific PI workflow: intake → treatment → demand → settlement → disbursement
// Auto-discovers cases from Dropbox folders ending in "-PI"

app.get("/admin/pi", async (req, res) => {
  try {
    const piUI = require("./personal-injury-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await piUI.renderDashboard();
    res.send(hearingNotes.renderAdminChrome({ title: "PI Dashboard", body, activeItem: "pi-dashboard" }));
  } catch (err) {
    console.error("[pi dashboard]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/pi/cases", async (req, res) => {
  try {
    const piUI = require("./personal-injury-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await piUI.renderCaseList(req.query || {});
    res.send(hearingNotes.renderAdminChrome({ title: "PI Cases", body, activeItem: "pi-cases" }));
  } catch (err) {
    console.error("[pi cases]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/pi/case/:id", async (req, res) => {
  try {
    const piUI = require("./personal-injury-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await piUI.renderCaseDetail(parseInt(req.params.id, 10));
    res.send(hearingNotes.renderAdminChrome({ title: "PI Case", body, activeItem: "pi-cases" }));
  } catch (err) {
    console.error("[pi case detail]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/pi/case/:id/disbursement", async (req, res) => {
  try {
    const piUI = require("./personal-injury-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await piUI.renderDisbursement(parseInt(req.params.id, 10));
    res.send(hearingNotes.renderAdminChrome({ title: "Disbursement", body, activeItem: "pi-cases" }));
  } catch (err) {
    console.error("[pi disbursement]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// Action endpoints
app.post("/admin/pi/discover", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const results = await pi.discoverPICasesFromDropbox();
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[pi discover]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/pi/case/:id", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const updated = await pi.updateCase(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, case: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/pi/case/:id/providers", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const provider = await pi.addProvider(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, provider });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/pi/case/:id/bills", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const bill = await pi.addBill(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, bill });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/pi/case/:id/insurance", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const ins = await pi.addInsurance(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, insurance: ins });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/pi/case/:id/costs", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const cost = await pi.addCost(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, cost });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/pi/case/:id/settlements", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const s = await pi.addSettlementOffer(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, settlement: s });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/pi/case/:id/disbursement", async (req, res) => {
  try {
    const pi = require("./personal-injury");
    const d = await pi.saveDisbursement(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, disbursement: d });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Accounting Module ────────────────────────────────
// Double-entry ledger with CA Bar RRC 1.15 IOLTA trust compliance.
// Auto-syncs from PI disbursements. Exports to Excel, IIF (QB Desktop),
// CSV (QBO).

app.get("/admin/accounting", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderDashboard();
    res.send(hearingNotes.renderAdminChrome({ title: "Accounting", body, activeItem: "accounting" }));
  } catch (err) {
    console.error("[accounting dashboard]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/ledger", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderLedger(req.query || {});
    res.send(hearingNotes.renderAdminChrome({ title: "General Ledger", body, activeItem: "accounting-ledger" }));
  } catch (err) {
    console.error("[accounting ledger]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/income-statement", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderIncomeStatement(req.query || {});
    res.send(hearingNotes.renderAdminChrome({ title: "Income Statement", body, activeItem: "accounting" }));
  } catch (err) {
    console.error("[accounting P&L]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/balance-sheet", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderBalanceSheet(req.query || {});
    res.send(hearingNotes.renderAdminChrome({ title: "Balance Sheet", body, activeItem: "accounting" }));
  } catch (err) {
    console.error("[accounting BS]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/trust", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderTrustReconciliation(req.query || {});
    res.send(hearingNotes.renderAdminChrome({ title: "Trust Reconciliation", body, activeItem: "accounting-trust" }));
  } catch (err) {
    console.error("[accounting trust]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/trust/:clientKey", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderClientTrustLedger(req.params.clientKey);
    res.send(hearingNotes.renderAdminChrome({ title: "Client Trust Ledger", body, activeItem: "accounting-trust" }));
  } catch (err) {
    console.error("[accounting client trust]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/chart", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderChartOfAccounts();
    res.send(hearingNotes.renderAdminChrome({ title: "Chart of Accounts", body, activeItem: "accounting" }));
  } catch (err) {
    console.error("[accounting COA]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/new-entry", async (req, res) => {
  try {
    const ui = require("./accounting-ui");
    const hearingNotes = require("./hearing-notes");
    const body = await ui.renderNewEntry();
    res.send(hearingNotes.renderAdminChrome({ title: "New Journal Entry", body, activeItem: "accounting" }));
  } catch (err) {
    console.error("[accounting new entry]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/entry/:id", async (req, res) => {
  try {
    const accounting = require("./accounting");
    const hearingNotes = require("./hearing-notes");
    const entries = await accounting.getLedger({ limit: 1 });
    // Get single entry with its lines
    const full = await accounting.getLedger({});
    const entry = full.find(e => e.id === parseInt(req.params.id, 10));
    if (!entry) return res.status(404).send("Entry not found");
    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fmt$ = n => "$" + (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const linesHtml = (entry.lines || []).map(l => `
      <tr>
        <td style="padding:10px 12px; border-bottom:1px solid #eee; font-family:ui-monospace, Menlo, monospace; font-size:12px;">${l.account_number}</td>
        <td style="padding:10px 12px; border-bottom:1px solid #eee;">${esc(l.account_name)}</td>
        <td style="padding:10px 12px; border-bottom:1px solid #eee; font-size:12px; color:#666;">${esc(l.memo || "")}</td>
        <td style="padding:10px 12px; border-bottom:1px solid #eee; text-align:right; font-family:ui-monospace, Menlo, monospace;">${Number(l.debit) > 0 ? fmt$(l.debit) : ""}</td>
        <td style="padding:10px 12px; border-bottom:1px solid #eee; text-align:right; font-family:ui-monospace, Menlo, monospace;">${Number(l.credit) > 0 ? fmt$(l.credit) : ""}</td>
      </tr>`).join("");
    const totalD = (entry.lines || []).reduce((s, l) => s + Number(l.debit || 0), 0);
    const totalC = (entry.lines || []).reduce((s, l) => s + Number(l.credit || 0), 0);
    const body = `
      <div class="page-header">
        <h1>Journal Entry #${entry.id}</h1>
        <a href="/admin/accounting/ledger" class="back-link">← Ledger</a>
      </div>
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; font-size:13px;">
          <div><strong>Date:</strong> ${new Date(entry.entry_date).toLocaleDateString()}</div>
          <div><strong>Reference:</strong> ${esc(entry.reference || "—")}</div>
          <div><strong>Description:</strong> ${esc(entry.description)}</div>
          <div><strong>Client:</strong> ${esc(entry.client_name || "—")}</div>
          <div><strong>Matter:</strong> ${esc(entry.matter_type || "—")}</div>
          <div><strong>Source:</strong> ${esc(entry.source_module)}${entry.source_id ? " #" + entry.source_id : ""}</div>
          ${entry.is_trust ? '<div><strong>🔒 TRUST TRANSACTION</strong></div>' : ""}
        </div>
      </div>
      <div style="background:white; border-radius:8px; border:1px solid #eee; overflow:hidden;">
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#fafaf7;">
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase;">Acct #</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase;">Account</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase;">Memo</th>
            <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase;">Debit</th>
            <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase;">Credit</th>
          </tr></thead>
          <tbody>${linesHtml}
            <tr style="background:#fafaf7; font-weight:700;">
              <td colspan="3" style="padding:10px 12px;">TOTALS</td>
              <td style="padding:10px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(totalD)}</td>
              <td style="padding:10px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(totalC)}</td>
            </tr>
          </tbody>
        </table>
      </div>`;
    res.send(hearingNotes.renderAdminChrome({ title: "Journal Entry", body, activeItem: "accounting-ledger" }));
  } catch (err) {
    console.error("[accounting entry]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// Actions
app.post("/admin/accounting/sync-pi", async (req, res) => {
  try {
    const accounting = require("./accounting");
    const results = await accounting.syncFromPI();
    res.json({ ok: true, results });
  } catch (err) {
    console.error("[accounting sync-pi]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/accounting/entry", async (req, res) => {
  try {
    const accounting = require("./accounting");
    const entry = await accounting.postJournalEntry({
      ...req.body,
      created_by: req.user?.id || null,
    });
    res.json({ ok: true, id: entry.id });
  } catch (err) {
    console.error("[accounting post entry]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Exports
app.get("/admin/accounting/export/excel", async (req, res) => {
  try {
    const accounting = require("./accounting");
    const buf = await accounting.exportToExcel({
      from_date: req.query.from || null,
      to_date: req.query.to || null,
    });
    const filename = `tez-accounting-${new Date().toISOString().split("T")[0]}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    console.error("[accounting excel]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/export/iif", async (req, res) => {
  try {
    const accounting = require("./accounting");
    const iif = await accounting.exportToIIF({
      from_date: req.query.from || null,
      to_date: req.query.to || null,
    });
    const filename = `tez-quickbooks-${new Date().toISOString().split("T")[0]}.iif`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(iif);
  } catch (err) {
    console.error("[accounting iif]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/accounting/export/csv", async (req, res) => {
  try {
    const accounting = require("./accounting");
    const csv = await accounting.exportToCSV({
      from_date: req.query.from || null,
      to_date: req.query.to || null,
    });
    const filename = `tez-quickbooks-${new Date().toISOString().split("T")[0]}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error("[accounting csv]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// ── PI Demand Letter Generator ────────────────────────
// Time-limited policy limits demand compliant with CCP §§ 999-999.5.
// Uses only verified case law from firm's GOAT/MOAT (zero hallucinated cites).

app.get("/admin/pi/case/:id/demand", async (req, res) => {
  try {
    const dl = require("./pi-demand-letter");
    const pi = require("./personal-injury");
    const hearingNotes = require("./hearing-notes");
    const caseId = parseInt(req.params.id, 10);
    const [caseData, letters, verifiedPool] = await Promise.all([
      pi.getCase(caseId),
      dl.listForCase(caseId),
      dl.retrieveVerifiedPICaseLaw(),
    ]);
    if (!caseData) return res.status(404).send("Case not found");
    const c = caseData.case;

    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const fmt$ = n => "$" + (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // Insurance carrier options for the target dropdown
    const carrierOpts = caseData.insurance.map(i =>
      `<option value="${i.id}">${esc(i.carrier_name || "?")} — ${esc(i.role)}${i.policy_limits ? " · " + fmt$(i.policy_limits) : " · limits undisclosed"}</option>`
    ).join("");

    // Existing letters
    const statusColors = {
      draft: "#B79C62", sent: "#0061FF", carrier_responded: "#7c4dff",
      limits_disclosed: "#00838f", tendered: "#2e7d32", rejected: "#c62828",
      bad_faith_flagged: "#c62828", superseded: "#999",
    };
    const lettersHtml = letters.length ? letters.map(l => {
      const dt = new Date(l.generated_at).toLocaleString();
      const preview = (l.letter_text || "").substring(0, 300).replace(/</g, "&lt;");
      const status = l.status || "draft";
      const color = statusColors[status] || "#666";
      const daysToDeadline = l.deadline_date ? Math.ceil((new Date(l.deadline_date) - new Date()) / 86400000) : null;
      let deadlineLabel = "";
      if (l.deadline_date && ["sent", "carrier_responded"].includes(status)) {
        if (daysToDeadline < 0) deadlineLabel = `<span style="color:#c62828; font-weight:600;">⚠ ${Math.abs(daysToDeadline)}d PAST DEADLINE</span>`;
        else if (daysToDeadline <= 7) deadlineLabel = `<span style="color:#c62828; font-weight:600;">${daysToDeadline}d until deadline</span>`;
        else deadlineLabel = `<span style="color:#666;">${daysToDeadline}d to deadline</span>`;
      }
      return `
        <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:10px;">
            <div style="flex:1;">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <strong style="color:#0C1C36; font-size:15px;">Version ${l.version || 1}</strong>
                <span style="background:${color}; color:white; padding:2px 8px; border-radius:8px; font-size:10px;">${status.toUpperCase().replace(/_/g, " ")}</span>
                ${l.bad_faith_flagged ? '<span style="background:#c62828; color:white; padding:2px 8px; border-radius:8px; font-size:10px;">🚩 BAD FAITH</span>' : ""}
                <span style="font-size:11px; color:#888;">#${l.id}</span>
              </div>
              <div style="font-size:12px; color:#666; margin-top:4px;">
                ${dt} · To ${esc(l.target_carrier_name || "?")}${l.target_claim_number ? " (Claim " + esc(l.target_claim_number) + ")" : ""}
              </div>
              <div style="font-size:12px; color:#666; margin-top:2px;">
                Deadline: ${l.deadline_date ? new Date(l.deadline_date).toLocaleDateString() : "—"} (${l.deadline_days || "?"} days per CCP § 999.1)
                ${deadlineLabel ? " · " + deadlineLabel : ""}
              </div>
              <div style="font-size:11px; color:#888; margin-top:2px;">
                ${(l.cases_cited || []).length} cases cited · $${Number(l.estimated_cost_usd || 0).toFixed(3)}
                ${l.policy_limits_disclosed ? " · ✓ Limits disclosed: " + fmt$(l.disclosed_limits_amount) : ""}
                ${l.carrier_tendered_limits ? " · ✓ TENDERED " + fmt$(l.tendered_amount) : ""}
              </div>
            </div>
            <a href="/admin/pi/case/${caseId}/demand/${l.id}" style="background:#0C1C36; color:white; padding:6px 14px; border-radius:4px; text-decoration:none; font-size:12px; align-self:flex-start;">Open →</a>
          </div>
          <div style="font-size:12px; color:#555; padding:10px; background:#fafaf7; border-radius:6px; font-family:ui-serif, Georgia, serif; line-height:1.5;">${preview}${l.letter_text && l.letter_text.length > 300 ? "…" : ""}</div>
        </div>`;
    }).join("") : `<div style="text-align:center; padding:40px; color:#888;">No demand letters generated yet.</div>`;

    const canGenerate = caseData.insurance.length > 0 && verifiedPool.length >= 3;
    const warnHtml = !canGenerate ? `
      <div style="background:#fff8e1; padding:14px 16px; border-radius:8px; border-left:4px solid #f57f17; margin-bottom:16px; font-size:13px;">
        ${caseData.insurance.length === 0 ? "<strong>⚠ Add an insurance carrier first</strong> — go back to the case and add the adverse party's carrier before generating a demand.<br>" : ""}
        ${verifiedPool.length < 3 ? `<strong>⚠ Only ${verifiedPool.length} verified PI case citations found</strong> — the generator includes 6 foundational bad faith cases automatically, but adding your firm's own demand letters to <a href="/admin/firm-documents" style="color:#f57f17;">/admin/firm-documents</a> improves quality.<br>` : ""}
      </div>` : "";

    const body = `
      <div class="page-header">
        <h1>📝 Demand Letters — ${esc(c.client_name)}</h1>
        <a href="/admin/pi/case/${caseId}" class="back-link">← Back to case</a>
      </div>

      <div style="background:#f5f9ff; padding:14px 16px; border-radius:8px; border-left:4px solid #0061FF; margin-bottom:16px; font-size:13px;">
        <strong>Verified case law pool:</strong> ${verifiedPool.length} cases (${verifiedPool.filter(v => v.source === "foundational").length} foundational + ${verifiedPool.filter(v => v.source !== "foundational" && v.source !== "legal_citations table").length} from firm briefs + ${verifiedPool.filter(v => v.source === "legal_citations table").length} from legal_citations)
      </div>

      ${warnHtml}

      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
        <h2 style="font-size:16px; margin:0 0 12px 0; color:#0C1C36;">✨ Generate New Demand Letter</h2>
        <p style="font-size:13px; color:#666; margin-bottom:12px;">
          Time-limited policy limits demand compliant with CCP §§ 999-999.5. Auto-calculates the deadline (33 days if policy limits ≤ $250K, 60 days if > $250K, or 60 days if undisclosed). Uses only verified case law.
        </p>
        <div style="display:grid; grid-template-columns:1fr; gap:12px;">
          <div>
            <label style="font-size:11px; color:#888; display:block; margin-bottom:4px;">Target insurance carrier</label>
            <select id="target-insurance" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;" ${!canGenerate ? "disabled" : ""}>
              ${carrierOpts || '<option value="">No carriers on file</option>'}
            </select>
          </div>
          <div>
            <label style="font-size:11px; color:#888; display:block; margin-bottom:4px;">Additional direction for the AI (optional)</label>
            <textarea id="additional-context" placeholder="e.g., 'stress permanent impairment', 'emphasize clear liability from police report', 'address argument that treatment was excessive'..." style="width:100%; min-height:80px; padding:10px; border:1px solid #ccc; border-radius:6px; font-size:13px; box-sizing:border-box;" ${!canGenerate ? "disabled" : ""}></textarea>
          </div>
          <div>
            <button onclick="generateDemand()" id="gen-btn" ${!canGenerate ? "disabled" : ""} style="background:${canGenerate ? "#B79C62" : "#ccc"}; color:white; border:none; padding:12px 24px; border-radius:6px; cursor:${canGenerate ? "pointer" : "not-allowed"}; font-weight:600; font-size:14px;">
              📝 Generate Demand Letter
            </button>
            <div id="gen-status" style="margin-top:10px; font-size:12px; color:#666;"></div>
          </div>
        </div>
      </div>

      <h3 style="margin:20px 0 12px 0; font-size:14px; color:#666; text-transform:uppercase; letter-spacing:0.05em;">Generated Letters (${letters.length})</h3>
      ${lettersHtml}

      <script>
        async function generateDemand() {
          const btn = document.getElementById("gen-btn");
          const status = document.getElementById("gen-status");
          const targetId = document.getElementById("target-insurance").value;
          const ctx = document.getElementById("additional-context").value.trim();
          if (!targetId) { alert("Select a target insurance carrier"); return; }
          btn.disabled = true;
          btn.textContent = "⏳ Drafting (45-90s)…";
          status.innerHTML = "<div style='color:#0061FF;'>Retrieving case facts, verified case law, and drafting CCP § 999.1-compliant demand…</div>";
          try {
            const r = await fetch("/admin/pi/case/${caseId}/generate-demand", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target_insurance_id: parseInt(targetId, 10), additional_context: ctx }),
            });
            const d = await r.json();
            if (d.ok) {
              status.innerHTML = "<div style='color:#2e7d32;'>✅ Generated! Redirecting…</div>";
              setTimeout(() => location.href = "/admin/pi/case/${caseId}/demand/" + d.id, 500);
            } else {
              status.innerHTML = "<div style='color:#c62828;'>❌ " + (d.error || "Failed") + "</div>";
              btn.disabled = false;
              btn.textContent = "📝 Generate Demand Letter";
            }
          } catch (e) {
            status.innerHTML = "<div style='color:#c62828;'>❌ " + e.message + "</div>";
            btn.disabled = false;
            btn.textContent = "📝 Generate Demand Letter";
          }
        }
      </script>`;

    res.send(hearingNotes.renderAdminChrome({ title: "PI Demand Letters", body, activeItem: "pi-cases" }));
  } catch (err) {
    console.error("[pi demand list]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.post("/admin/pi/case/:id/generate-demand", async (req, res) => {
  try {
    const dl = require("./pi-demand-letter");
    const result = await dl.generateDemandLetter({
      caseId: parseInt(req.params.id, 10),
      targetInsuranceId: req.body?.target_insurance_id,
      additionalContext: req.body?.additional_context || "",
      parentId: req.body?.parent_id || null,
      createdBy: req.user?.id || null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[pi demand generate]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/pi/case/:caseId/demand/:demandId", async (req, res) => {
  try {
    const dl = require("./pi-demand-letter");
    const hearingNotes = require("./hearing-notes");
    const letter = await dl.getDemandLetter(parseInt(req.params.demandId, 10));
    if (!letter) return res.status(404).send("Demand letter not found");

    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fmt$ = n => "$" + (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const displayText = letter.user_edits || letter.letter_text;
    const daysToDeadline = letter.deadline_date ? Math.ceil((new Date(letter.deadline_date) - new Date()) / 86400000) : null;

    const statusColors = {
      draft: "#B79C62", sent: "#0061FF", carrier_responded: "#7c4dff",
      limits_disclosed: "#00838f", tendered: "#2e7d32", rejected: "#c62828",
      bad_faith_flagged: "#c62828", superseded: "#999",
    };
    const color = statusColors[letter.status] || "#666";

    const body = `
      <div class="page-header">
        <h1>📝 Demand Letter — Version ${letter.version || 1}</h1>
        <a href="/admin/pi/case/${req.params.caseId}/demand" class="back-link">← All demand letters</a>
      </div>

      <div style="background:#f5f9ff; padding:14px 16px; border-radius:8px; font-size:12px; color:#555; margin-bottom:16px; display:flex; gap:16px; flex-wrap:wrap;">
        <div><strong>Target:</strong> ${esc(letter.target_carrier_name || "?")}</div>
        ${letter.target_claim_number ? `<div><strong>Claim #:</strong> ${esc(letter.target_claim_number)}</div>` : ""}
        <div><strong>Generated:</strong> ${new Date(letter.generated_at).toLocaleString()}</div>
        <div><strong>Model:</strong> ${letter.model}</div>
        <div><strong>Cost:</strong> $${Number(letter.estimated_cost_usd || 0).toFixed(4)}</div>
        <div><strong>Cases cited:</strong> ${(letter.cases_cited || []).length}</div>
        <div><strong>Status:</strong> <span style="background:${color}; color:white; padding:2px 8px; border-radius:8px; font-size:11px; font-weight:600;">${letter.status.toUpperCase().replace(/_/g, " ")}</span></div>
      </div>

      <!-- Deadline banner -->
      ${letter.deadline_date ? `
      <div style="background:${daysToDeadline < 0 ? "#fee" : daysToDeadline <= 7 ? "#fff8e1" : "#e8f5e9"}; padding:14px 20px; border-radius:8px; border-left:4px solid ${daysToDeadline < 0 ? "#c62828" : daysToDeadline <= 7 ? "#f57f17" : "#2e7d32"}; margin-bottom:16px;">
        <strong style="font-size:14px; color:${daysToDeadline < 0 ? "#c62828" : daysToDeadline <= 7 ? "#f57f17" : "#2e7d32"};">
          ${daysToDeadline < 0
            ? `🚨 DEADLINE PASSED ${Math.abs(daysToDeadline)} DAYS AGO (${new Date(letter.deadline_date).toLocaleDateString()})`
            : daysToDeadline === 0
              ? `⚠ DEADLINE IS TODAY (${new Date(letter.deadline_date).toLocaleDateString()})`
              : `📅 Deadline: ${new Date(letter.deadline_date).toLocaleDateString()} — ${daysToDeadline} days remaining`}
        </strong>
        <div style="font-size:12px; color:#666; margin-top:4px;">
          ${letter.deadline_days}-day statutory minimum per CCP § 999.1 (policy limits ${letter.policy_limits_amount ? "= " + fmt$(letter.policy_limits_amount) : "undisclosed"})
        </div>
        ${daysToDeadline < 0 && !letter.carrier_tendered_limits && !letter.bad_faith_flagged ? `
        <div style="margin-top:8px; padding:10px; background:white; border-radius:6px;">
          <strong style="color:#c62828;">⚠ Bad faith exposure preserved.</strong> The carrier had a valid CCP § 999.1 demand and failed to timely tender. Consider flagging for bad faith documentation.
          <button onclick="flagBadFaith()" style="margin-left:8px; background:#c62828; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:12px;">🚩 Flag Bad Faith</button>
        </div>` : ""}
      </div>` : ""}

      <!-- Letter body -->
      <div style="background:white; padding:40px 50px; border-radius:8px; border:1px solid #eee; max-width:820px; font-family:ui-serif, Georgia, serif; font-size:14px; line-height:1.7; color:#0C1C36; white-space:pre-wrap;" id="letter-text">${esc(displayText)}</div>

      <!-- Certificate of Service -->
      <details style="background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee; margin-top:16px;">
        <summary style="cursor:pointer; font-weight:600; color:#0C1C36;">📋 Certificate of Service (attach to sent letter)</summary>
        <pre style="margin-top:12px; padding:16px; background:#fafaf7; border-radius:6px; white-space:pre-wrap; font-family:ui-serif, Georgia, serif; font-size:13px; line-height:1.6;">${esc(letter.certificate_of_service || "")}</pre>
      </details>

      <!-- Action buttons -->
      <div style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
        <button onclick="copyText()" style="background:#0C1C36; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">📋 Copy letter</button>
        <button onclick="printLetter()" style="background:#B79C62; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🖨️ Print</button>
        <button onclick="regenerate()" style="background:#7c4dff; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🔄 Regenerate</button>
        <button onclick="markSent()" style="background:#0061FF; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">📬 Mark Sent</button>
        <button onclick="recordResponse()" style="background:#00838f; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">📨 Record Response</button>
      </div>

      ${(letter.cases_cited || []).length > 0 ? `
      <details style="margin-top:20px; background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee;">
        <summary style="cursor:pointer; font-weight:600; color:#0C1C36;">📚 Cases cited (${letter.cases_cited.length})</summary>
        <ul style="margin-top:10px; font-size:12px; color:#555; line-height:1.7;">
          ${letter.cases_cited.map(c => `<li>${esc(c)}</li>`).join("")}
        </ul>
      </details>` : ""}

      ${letter.response_summary ? `
      <details style="margin-top:16px; background:#f5f9ff; padding:16px 20px; border-radius:8px; border-left:3px solid #0061FF;">
        <summary style="cursor:pointer; font-weight:600;">📨 Carrier Response</summary>
        <div style="margin-top:10px; font-size:13px; color:#555;">
          <div><strong>Received:</strong> ${letter.response_received_date ? new Date(letter.response_received_date).toLocaleDateString() : "—"}</div>
          ${letter.policy_limits_disclosed ? `<div><strong>Policy limits disclosed:</strong> ${fmt$(letter.disclosed_limits_amount)}</div>` : "<div>Limits NOT disclosed</div>"}
          ${letter.carrier_tendered_limits ? `<div style="color:#2e7d32;"><strong>✓ TENDERED:</strong> ${fmt$(letter.tendered_amount)}</div>` : ""}
          ${letter.settlement_offered ? `<div><strong>Settlement offered:</strong> ${fmt$(letter.settlement_offered)} (${letter.settlement_offered_date ? new Date(letter.settlement_offered_date).toLocaleDateString() : "no date"})</div>` : ""}
          <div style="margin-top:8px; white-space:pre-wrap;">${esc(letter.response_summary)}</div>
        </div>
      </details>` : ""}

      ${letter.bad_faith_flagged ? `
      <div style="background:#fee; padding:16px 20px; border-radius:8px; border-left:4px solid #c62828; margin-top:16px;">
        <strong style="color:#c62828;">🚩 FLAGGED FOR BAD FAITH DOCUMENTATION</strong>
        <div style="font-size:12px; color:#666; margin-top:6px;">Flagged on: ${letter.bad_faith_flag_date ? new Date(letter.bad_faith_flag_date).toLocaleDateString() : "—"}</div>
        ${letter.bad_faith_notes ? `<div style="margin-top:8px; font-size:13px; white-space:pre-wrap;">${esc(letter.bad_faith_notes)}</div>` : ""}
      </div>` : ""}

      <script>
        const CASE_ID = ${req.params.caseId};
        const DEMAND_ID = ${letter.id};

        function copyText() {
          navigator.clipboard.writeText(document.getElementById("letter-text").innerText).then(() => alert("✓ Copied"));
        }
        function printLetter() { window.print(); }

        async function regenerate() {
          const ctx = prompt("What to change / emphasize (optional):", "");
          if (ctx === null) return;
          const r = await fetch("/admin/pi/case/" + CASE_ID + "/generate-demand", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              target_insurance_id: ${letter.target_insurance_id},
              additional_context: ctx,
              parent_id: DEMAND_ID,
            }),
          });
          const d = await r.json();
          if (d.ok) {
            await fetch("/admin/pi/case/" + CASE_ID + "/demand/" + DEMAND_ID + "/supersede", { method: "POST" });
            location.href = "/admin/pi/case/" + CASE_ID + "/demand/" + d.id;
          } else alert("Error: " + d.error);
        }

        async function markSent() {
          const method = prompt("Sent via (certified_mail / email / fax / courier):", "certified_mail");
          if (!method) return;
          const tracking = prompt("Tracking / confirmation number (optional):", "");
          const insuredAddress = prompt("Insured's service address (for cc to insured):", "");
          const r = await fetch("/admin/pi/case/" + CASE_ID + "/demand/" + DEMAND_ID + "/sent", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sent_date: new Date().toISOString().split("T")[0],
              sent_via: method,
              sent_to_carrier: true,
              sent_to_insured: !!insuredAddress,
              tracking_number: tracking,
              insured_service_address: insuredAddress,
            }),
          });
          if (r.ok) location.reload();
        }

        async function recordResponse() {
          const summary = prompt("Carrier response summary:", "");
          if (summary === null) return;
          const disclosed = confirm("Did carrier disclose policy limits? OK for yes.");
          let disclosedAmount = null;
          if (disclosed) {
            disclosedAmount = parseFloat(prompt("Disclosed policy limits amount ($):", "0")) || 0;
          }
          const tendered = confirm("Did carrier TENDER policy limits? OK for yes.");
          let tenderedAmount = null;
          if (tendered) {
            tenderedAmount = parseFloat(prompt("Tendered amount ($):", disclosedAmount || "0")) || 0;
          } else {
            const offered = parseFloat(prompt("Any settlement offer? Enter amount, or 0 if none:", "0")) || 0;
            if (offered > 0) {
              window._settlementOffered = offered;
            }
          }
          const r = await fetch("/admin/pi/case/" + CASE_ID + "/demand/" + DEMAND_ID + "/response", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response_received_date: new Date().toISOString().split("T")[0],
              response_summary: summary,
              policy_limits_disclosed: disclosed,
              disclosed_limits_amount: disclosedAmount,
              carrier_tendered_limits: tendered,
              tendered_amount: tenderedAmount,
              settlement_offered: window._settlementOffered || null,
              settlement_offered_date: window._settlementOffered ? new Date().toISOString().split("T")[0] : null,
            }),
          });
          if (r.ok) location.reload();
        }

        async function flagBadFaith() {
          const notes = prompt("Bad faith documentation notes (what steps carrier failed to take, dates, etc.):");
          if (!notes) return;
          const r = await fetch("/admin/pi/case/" + CASE_ID + "/demand/" + DEMAND_ID + "/flag-bad-faith", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes }),
          });
          if (r.ok) location.reload();
        }
      </script>`;

    res.send(hearingNotes.renderAdminChrome({ title: `Demand v${letter.version}`, body, activeItem: "pi-cases" }));
  } catch (err) {
    console.error("[pi demand view]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// Delivery + response tracking endpoints
app.post("/admin/pi/case/:caseId/demand/:demandId/sent", async (req, res) => {
  try {
    const dl = require("./pi-demand-letter");
    const updated = await dl.updateDeliveryStatus(parseInt(req.params.demandId, 10), req.body || {});
    res.json({ ok: true, letter: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/admin/pi/case/:caseId/demand/:demandId/response", async (req, res) => {
  try {
    const dl = require("./pi-demand-letter");
    const updated = await dl.updateResponseStatus(parseInt(req.params.demandId, 10), req.body || {});
    res.json({ ok: true, letter: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/admin/pi/case/:caseId/demand/:demandId/flag-bad-faith", async (req, res) => {
  try {
    const dl = require("./pi-demand-letter");
    const updated = await dl.flagBadFaith(parseInt(req.params.demandId, 10), req.body?.notes);
    res.json({ ok: true, letter: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/admin/pi/case/:caseId/demand/:demandId/supersede", async (req, res) => {
  try {
    const dl = require("./pi-demand-letter");
    await dl.markSuperseded(parseInt(req.params.demandId, 10));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── AI Audit Trail — malpractice / bar-complaint defense ──
// Every AI-generated output is logged with immutable original + attorney
// review + delivery record. This is the compliance backbone for a firm
// using AI at scale.

app.get("/admin/audit-trail", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const hearingNotes = require("./hearing-notes");

    const filters = {
      feature_type: req.query.feature_type || null,
      status: req.query.status || null,
      client_key: req.query.client_key || null,
      a_number: req.query.a_number || null,
      flagged_only: req.query.flagged === "1",
      limit: 50,
      offset: parseInt(req.query.offset || "0", 10),
    };
    const [rows, totalCount, stats] = await Promise.all([
      audit.list(filters),
      audit.count(filters),
      audit.stats(),
    ]);

    const filterOptions = {
      feature_type: ["closing_argument", "motion", "notice_scan", "intake_extraction", "voice_dictation", "chat_response"],
      status: ["unreviewed", "reviewed", "approved", "delivered", "withdrawn", "flagged"],
    };
    const featureOptsHtml = filterOptions.feature_type.map(f =>
      `<option value="${f}" ${filters.feature_type === f ? "selected" : ""}>${f.replace(/_/g, " ")}</option>`
    ).join("");
    const statusOptsHtml = filterOptions.status.map(s =>
      `<option value="${s}" ${filters.status === s ? "selected" : ""}>${s}</option>`
    ).join("");

    const statusColors = {
      unreviewed: "#B79C62",
      reviewed: "#0061FF",
      approved: "#2e7d32",
      delivered: "#00695c",
      withdrawn: "#999",
      flagged: "#c62828",
    };

    const rowsHtml = rows.length ? rows.map(r => {
      const dt = new Date(r.generated_at).toLocaleString();
      const preview = (r.preview || "").replace(/</g, "&lt;");
      const client = r.client_name ? `${r.client_name}${r.a_number ? " (" + r.a_number + ")" : ""}` : "(no client link)";
      const color = statusColors[r.status] || "#666";
      const flagIcon = (r.bar_complaint_related || r.malpractice_flag) ? '<span title="Flagged for compliance review" style="color:#c62828; font-size:16px;">⚠️</span> ' : "";
      const editIndicator = r.edit_char_delta ? ` · ${r.edit_char_delta >= 0 ? "+" : ""}${r.edit_char_delta} chars edited` : "";
      const deliveredIndicator = r.delivered_at ? ` · ✓ delivered via ${r.delivered_via || "?"}` : "";
      return `
        <tr>
          <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top;">
            <div style="display:flex; align-items:center; gap:6px;">
              ${flagIcon}<strong style="color:#0C1C36;">#${r.id}</strong>
              <span style="background:${color}; color:white; padding:2px 8px; border-radius:8px; font-size:10px; font-weight:600;">${r.status.toUpperCase()}</span>
            </div>
            <div style="font-size:11px; color:#888; margin-top:2px;">${dt}</div>
          </td>
          <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top;">
            <div style="font-weight:500; color:#0C1C36;">${r.feature_type.replace(/_/g, " ")}</div>
            <div style="font-size:11px; color:#888;">${(r.source_module || "").replace(".js", "")}</div>
          </td>
          <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top; font-size:13px;">
            ${client}
            <div style="font-size:11px; color:#888;">${r.matter_type || ""}</div>
          </td>
          <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top; font-size:11px; color:#666;">
            ${r.model_used || "—"}<br>
            <span style="color:#2e7d32;">$${Number(r.estimated_cost_usd || 0).toFixed(3)}</span><br>
            ${r.output_length}ch${editIndicator}${deliveredIndicator}
          </td>
          <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top; font-size:12px; color:#555; max-width:400px;">
            <div style="font-family:ui-serif, Georgia, serif; line-height:1.5;">${preview}${(r.output_length || 0) > 200 ? "…" : ""}</div>
          </td>
          <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top;">
            <a href="/admin/audit-trail/${r.id}" style="background:#0C1C36; color:white; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:12px;">Open →</a>
          </td>
        </tr>`;
    }).join("") : `<tr><td colspan="6" style="padding:60px; text-align:center; color:#888;">No audit records match these filters.</td></tr>`;

    const pageCount = Math.ceil(totalCount / 50);
    const currentPage = Math.floor(filters.offset / 50) + 1;

    const body = `
      <div class="page-header">
        <h1>🛡️ AI Audit Trail</h1>
        <div style="font-size:12px; color:#666; margin-top:4px;">Immutable log of every AI output — malpractice + bar complaint defense</div>
      </div>

      <!-- Stats grid -->
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:20px;">
        <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Pending review</div>
          <div style="font-size:24px; font-weight:700; color:${(stats.pending_review || 0) > 0 ? "#B79C62" : "#0C1C36"}; margin-top:4px;">${stats.pending_review || 0}</div>
        </div>
        <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Approved</div>
          <div style="font-size:24px; font-weight:700; color:#2e7d32; margin-top:4px;">${stats.approved || 0}</div>
        </div>
        <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Delivered</div>
          <div style="font-size:24px; font-weight:700; color:#00695c; margin-top:4px;">${stats.delivered || 0}</div>
        </div>
        <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Flagged</div>
          <div style="font-size:24px; font-weight:700; color:${(stats.flagged || 0) > 0 ? "#c62828" : "#0C1C36"}; margin-top:4px;">${stats.flagged || 0}</div>
        </div>
        <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Last 30 days</div>
          <div style="font-size:24px; font-weight:700; color:#0C1C36; margin-top:4px;">${stats.last_30_days || 0}</div>
          <div style="font-size:11px; color:#2e7d32; margin-top:2px;">$${Number(stats.cost_last_30_days || 0).toFixed(2)}</div>
        </div>
        <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Total all time</div>
          <div style="font-size:24px; font-weight:700; color:#0C1C36; margin-top:4px;">${stats.total_all_time || 0}</div>
          <div style="font-size:11px; color:#2e7d32; margin-top:2px;">$${Number(stats.total_cost_all_time || 0).toFixed(2)}</div>
        </div>
      </div>

      <!-- Filters -->
      <form method="GET" style="background:white; padding:16px; border-radius:8px; border:1px solid #eee; margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
        <div>
          <label style="font-size:11px; color:#888; display:block; margin-bottom:2px;">Feature type</label>
          <select name="feature_type" style="padding:6px; border:1px solid #ccc; border-radius:4px;">
            <option value="">All types</option>
            ${featureOptsHtml}
          </select>
        </div>
        <div>
          <label style="font-size:11px; color:#888; display:block; margin-bottom:2px;">Status</label>
          <select name="status" style="padding:6px; border:1px solid #ccc; border-radius:4px;">
            <option value="">All statuses</option>
            ${statusOptsHtml}
          </select>
        </div>
        <div>
          <label style="font-size:11px; color:#888; display:block; margin-bottom:2px;">A-Number</label>
          <input type="text" name="a_number" value="${(filters.a_number || "").replace(/"/g, "&quot;")}" style="padding:6px; border:1px solid #ccc; border-radius:4px; width:140px;" placeholder="A123456789">
        </div>
        <div>
          <label style="font-size:11px; color:#888; display:block; margin-bottom:2px;">
            <input type="checkbox" name="flagged" value="1" ${filters.flagged_only ? "checked" : ""}> Flagged only
          </label>
        </div>
        <button type="submit" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer; font-weight:600;">Filter</button>
        <a href="/admin/audit-trail" style="padding:8px 16px; color:#666; text-decoration:none; font-size:13px;">Clear</a>
      </form>

      <!-- Results table -->
      <div style="background:white; border-radius:8px; border:1px solid #eee; overflow:hidden;">
        <div style="padding:12px 16px; background:#fafaf7; border-bottom:1px solid #eee; font-size:12px; color:#666;">
          Showing ${rows.length} of ${totalCount} records
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead>
            <tr style="background:#fafaf7;">
              <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">ID / Status</th>
              <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Feature</th>
              <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Client</th>
              <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Model / Cost</th>
              <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Preview</th>
              <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;"></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;

    res.send(hearingNotes.renderAdminChrome({ title: "AI Audit Trail", body, activeItem: "audit-trail" }));
  } catch (err) {
    console.error("[audit-trail list]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// Detail view
app.get("/admin/audit-trail/:id", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const hearingNotes = require("./hearing-notes");
    const row = await audit.get(parseInt(req.params.id, 10));
    if (!row) return res.status(404).send("Audit record not found");
    const integrity = await audit.verifyIntegrity(row.id);

    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const statusColors = {
      unreviewed: "#B79C62", reviewed: "#0061FF", approved: "#2e7d32",
      delivered: "#00695c", withdrawn: "#999", flagged: "#c62828",
    };

    const body = `
      <div class="page-header">
        <h1>🛡️ Audit Record #${row.id}</h1>
        <a href="/admin/audit-trail" class="back-link">← All audit records</a>
      </div>

      <!-- Metadata block -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; font-size:13px;">
          <div><strong>Feature:</strong> ${esc(row.feature_type)}</div>
          <div><strong>Status:</strong> <span style="background:${statusColors[row.status]}; color:white; padding:2px 8px; border-radius:8px; font-size:11px; font-weight:600;">${esc(row.status).toUpperCase()}</span></div>
          <div><strong>Client:</strong> ${esc(row.client_name || "(none)")}</div>
          ${row.a_number ? `<div><strong>A#:</strong> ${esc(row.a_number)}</div>` : ""}
          <div><strong>Matter:</strong> ${esc(row.matter_type || "—")}</div>
          <div><strong>Model:</strong> ${esc(row.model_used || "—")}</div>
          <div><strong>Cost:</strong> $${Number(row.estimated_cost_usd || 0).toFixed(4)}</div>
          <div><strong>Generated:</strong> ${new Date(row.generated_at).toLocaleString()}</div>
          ${row.generated_by ? `<div><strong>By user:</strong> #${row.generated_by}</div>` : ""}
          ${row.reviewed_at ? `<div><strong>Reviewed:</strong> ${new Date(row.reviewed_at).toLocaleString()}</div>` : ""}
          ${row.delivered_at ? `<div><strong>Delivered:</strong> ${new Date(row.delivered_at).toLocaleString()} via ${esc(row.delivered_via)}</div>` : ""}
        </div>
      </div>

      <!-- Integrity check -->
      <div style="background:${integrity.tamper_detected ? "#fee" : "#e8f5e9"}; padding:14px 16px; border-radius:8px; border-left:4px solid ${integrity.tamper_detected ? "#c62828" : "#2e7d32"}; margin-bottom:16px; font-size:12px; font-family:ui-monospace, Menlo, monospace;">
        <strong>🔒 Integrity check:</strong> ${integrity.tamper_detected ? "❌ TAMPERING DETECTED — hashes do not match" : "✓ PASSED — content matches stored hash"}<br>
        <span style="color:#888;">Stored hash: ${integrity.stored_hash?.substring(0, 32) || "?"}…</span><br>
        <span style="color:#888;">Computed:    ${integrity.computed_hash?.substring(0, 32) || "?"}…</span>
      </div>

      <!-- Original AI output (immutable) -->
      <details open style="background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
        <summary style="cursor:pointer; font-weight:600; color:#0C1C36;">📄 Original AI Output (${row.original_output ? row.original_output.length : 0} chars) — IMMUTABLE</summary>
        <pre style="margin-top:14px; padding:16px; background:#fafaf7; border-radius:6px; white-space:pre-wrap; word-wrap:break-word; font-family:ui-serif, Georgia, serif; font-size:13px; line-height:1.6; max-height:600px; overflow-y:auto;">${esc(row.original_output)}</pre>
      </details>

      ${row.final_version ? `
      <details style="background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
        <summary style="cursor:pointer; font-weight:600; color:#0C1C36;">✏️ Final Version (after attorney edits)</summary>
        <pre style="margin-top:14px; padding:16px; background:#fafaf7; border-radius:6px; white-space:pre-wrap; word-wrap:break-word; font-family:ui-serif, Georgia, serif; font-size:13px; line-height:1.6; max-height:600px; overflow-y:auto;">${esc(row.final_version)}</pre>
        ${row.edit_diff ? `<div style="margin-top:10px; font-size:12px; color:#666;"><strong>Edit summary:</strong> ${esc((JSON.parse(row.edit_diff) || {}).summary || "")}</div>` : ""}
      </details>` : ""}

      ${row.reviewer_notes ? `
      <div style="background:#fff8ec; padding:14px 16px; border-radius:8px; border-left:3px solid #B79C62; margin-bottom:16px; font-size:13px;">
        <strong>📝 Reviewer notes:</strong><br>
        <div style="white-space:pre-wrap; margin-top:6px;">${esc(row.reviewer_notes)}</div>
      </div>` : ""}

      ${row.input_context_summary ? `
      <details style="background:#f5f9ff; padding:14px 16px; border-radius:8px; border-left:3px solid #0061FF; margin-bottom:16px; font-size:12px;">
        <summary style="cursor:pointer; font-weight:600;">📥 Input context that produced this output</summary>
        <div style="margin-top:8px; color:#555; white-space:pre-wrap;">${esc(row.input_context_summary)}</div>
        ${row.input_context_hash ? `<div style="margin-top:6px; font-family:ui-monospace, Menlo, monospace; font-size:10px; color:#888;">Input hash: ${row.input_context_hash.substring(0, 48)}…</div>` : ""}
      </details>` : ""}

      <!-- Action buttons -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
        <h3 style="margin:0 0 12px 0; font-size:14px; color:#666;">Actions</h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${row.status === "unreviewed" ? `<button onclick="markReviewed()" style="background:#0061FF; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">✓ Mark Reviewed</button>` : ""}
          ${(row.status === "reviewed" || row.status === "unreviewed") ? `<button onclick="markApproved()" style="background:#2e7d32; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">✓ Approve</button>` : ""}
          ${(row.status === "approved" || row.status === "reviewed") ? `<button onclick="markDelivered()" style="background:#00695c; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">📬 Mark Delivered</button>` : ""}
          <button onclick="flagRecord()" style="background:#c62828; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🚩 Flag</button>
          <button onclick="withdrawRecord()" style="background:#999; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">↩️ Withdraw</button>
          ${row.client_key ? `<a href="/admin/audit-trail/export/client/${encodeURIComponent(row.client_key)}" style="background:#0C1C36; color:white; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600; text-decoration:none; margin-left:auto;">📥 Export full client trail</a>` : ""}
        </div>
      </div>

      <script>
        const AUDIT_ID = ${row.id};
        async function markReviewed() {
          const notes = prompt("Optional review notes:");
          if (notes === null) return;
          const editedVersion = prompt("If you edited the final version, paste it here (or leave blank):");
          const r = await fetch("/admin/audit-trail/" + AUDIT_ID + "/reviewed", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes, editedVersion: editedVersion || null }),
          });
          if (r.ok) location.reload(); else alert("Error");
        }
        async function markApproved() {
          if (!confirm("Approve this AI output as final?")) return;
          const r = await fetch("/admin/audit-trail/" + AUDIT_ID + "/approved", { method: "POST" });
          if (r.ok) location.reload(); else alert("Error");
        }
        async function markDelivered() {
          const deliveredTo = prompt("Delivered to (e.g., client email, court name):");
          if (deliveredTo === null) return;
          const deliveredVia = prompt("Delivered via (email, in-court, mail, portal, sms):", "email");
          const confirmation = prompt("Confirmation/tracking (optional):");
          const r = await fetch("/admin/audit-trail/" + AUDIT_ID + "/delivered", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deliveredTo, deliveredVia, deliveryConfirmation: confirmation }),
          });
          if (r.ok) location.reload(); else alert("Error");
        }
        async function flagRecord() {
          const reason = prompt("Reason for flagging:");
          if (!reason) return;
          const isMalpractice = confirm("Is this malpractice-related? OK for yes, Cancel for no.");
          const isBarComplaint = confirm("Is this bar-complaint-related? OK for yes, Cancel for no.");
          const r = await fetch("/admin/audit-trail/" + AUDIT_ID + "/flag", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason, isMalpractice, isBarComplaint }),
          });
          if (r.ok) location.reload(); else alert("Error");
        }
        async function withdrawRecord() {
          const reason = prompt("Reason for withdrawal:");
          if (!reason) return;
          const r = await fetch("/admin/audit-trail/" + AUDIT_ID + "/withdraw", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason }),
          });
          if (r.ok) location.reload(); else alert("Error");
        }
      </script>`;

    res.send(hearingNotes.renderAdminChrome({ title: `Audit #${row.id}`, body, activeItem: "audit-trail" }));
  } catch (err) {
    console.error("[audit-trail detail]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// Action endpoints
app.post("/admin/audit-trail/:id/reviewed", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const updated = await audit.markReviewed(parseInt(req.params.id, 10), {
      userId: req.user?.id,
      notes: req.body?.notes,
      editedVersion: req.body?.editedVersion,
      ip: req.ip,
    });
    res.json({ ok: true, record: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/admin/audit-trail/:id/approved", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const updated = await audit.markApproved(parseInt(req.params.id, 10), { userId: req.user?.id, ip: req.ip });
    res.json({ ok: true, record: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/admin/audit-trail/:id/delivered", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const updated = await audit.markDelivered(parseInt(req.params.id, 10), {
      deliveredBy: req.user?.id,
      deliveredTo: req.body?.deliveredTo,
      deliveredVia: req.body?.deliveredVia,
      deliveryConfirmation: req.body?.deliveryConfirmation,
    });
    res.json({ ok: true, record: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/admin/audit-trail/:id/flag", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const updated = await audit.flag(parseInt(req.params.id, 10), {
      userId: req.user?.id,
      reason: req.body?.reason,
      isMalpractice: !!req.body?.isMalpractice,
      isBarComplaint: !!req.body?.isBarComplaint,
    });
    res.json({ ok: true, record: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/admin/audit-trail/:id/withdraw", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const updated = await audit.markWithdrawn(parseInt(req.params.id, 10), {
      userId: req.user?.id,
      reason: req.body?.reason,
    });
    res.json({ ok: true, record: updated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Client-level export for insurance / bar audit
app.get("/admin/audit-trail/export/client/:clientKey", async (req, res) => {
  try {
    const audit = require("./ai-audit-trail");
    const rows = await audit.exportForClient(req.params.clientKey);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="ai-audit-${req.params.clientKey}-${new Date().toISOString().split("T")[0]}.json"`);
    res.send(JSON.stringify({
      export_generated_at: new Date().toISOString(),
      client_key: req.params.clientKey,
      total_records: rows.length,
      records: rows,
    }, null, 2));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Closing Oral Argument generator ──────────────────────
// Drafts the closing argument for an individual (merits) hearing using ONLY
// case law verified from the firm's GOAT/MOAT documents. Zero hallucination.

app.get("/admin/hearing/individual/:id/closing", async (req, res) => {
  try {
    const cag = require("./closing-argument-generator");
    const hearingNotes = require("./hearing-notes");
    const noteId = parseInt(req.params.id, 10);
    if (!noteId) return res.status(400).send("Invalid note ID");

    const args = await cag.listForNote(noteId);
    const verifiedPool = await cag.retrieveVerifiedCaseLaw();

    // Peek at the hearing note to show attorney what testimony/notes will feed in
    const noteRes = await db.query(
      `SELECT examinations, pre_examination_notes, hearing_summary_raw
       FROM individual_hearing_notes WHERE id = $1`, [noteId]
    );
    const noteRow = noteRes.rows[0] || {};
    const examCount = Array.isArray(noteRow.examinations) ? noteRow.examinations.length : 0;
    let qaCount = 0;
    let witnessSummary = [];
    for (const ex of noteRow.examinations || []) {
      const role = ex.witness_role || "Witness";
      const name = ex.witness_name ? ` (${ex.witness_name})` : "";
      const type = ex.examination_type || "";
      let rows = 0;
      let answered = 0;
      for (const sec of ex.sections || []) {
        for (const qa of sec.qa_rows || []) {
          if (qa.question || qa.expected_answer || qa.judge_notes) rows++;
          if (qa.judge_notes && qa.judge_notes.trim()) answered++;
        }
      }
      qaCount += rows;
      witnessSummary.push(`${role}${name} ${type} — ${answered}/${rows} answers recorded`);
    }
    const hasPreNotes = (noteRow.pre_examination_notes || "").trim().length > 0;
    const hasRawNotes = (noteRow.hearing_summary_raw || "").trim().length > 0;

    const sourcesBlock = `
      <div style="background:#fff8ec; padding:14px 16px; border-radius:8px; border-left:4px solid #B79C62; margin-bottom:16px; font-size:13px;">
        <strong>Sources that will feed into this closing:</strong>
        <ul style="margin:8px 0 0 0; padding-left:20px; color:#555;">
          ${examCount > 0
            ? `<li>${examCount} witness examination${examCount === 1 ? "" : "s"} with ${qaCount} Q&A rows</li>${witnessSummary.map(w => `<li style="font-size:12px; color:#777; list-style:none; margin-left:-14px;">&nbsp;&nbsp;• ${w}</li>`).join("")}`
            : `<li style="color:#c62828;">⚠ No witness examinations recorded yet — closing will be light on testimony grounding</li>`}
          ${hasPreNotes ? `<li>Attorney's pre-hearing notes / outline</li>` : ""}
          ${hasRawNotes ? `<li>Raw hearing notes / dictation</li>` : ""}
          <li>${verifiedPool.length} verified case citations from GOAT/MOAT + legal_citations</li>
        </ul>
      </div>`;

    const argsHtml = args.length ? args.map(a => {
      const dt = new Date(a.generated_at).toLocaleString();
      const preview = (a.argument_text || "").substring(0, 300).replace(/</g, "&lt;");
      const status = a.status || "draft";
      const statusColor = { draft: "#B79C62", finalized: "#0061FF", delivered: "#2e7d32", superseded: "#999" }[status] || "#666";
      const parentLabel = a.parent_id ? ` · regenerated from #${a.parent_id}` : "";
      const witnessLabel = a.testimony_witness_count ? ` · ${a.testimony_witness_count} witness${a.testimony_witness_count === 1 ? "" : "es"} in record` : "";
      const ctxLabel = a.additional_context ? ` · custom context` : "";
      return `
        <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:10px;">
            <div style="flex:1;">
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <strong style="color:#0C1C36; font-size:15px;">Version ${a.version || 1}</strong>
                <span style="background:${statusColor}; color:white; padding:2px 8px; border-radius:8px; font-size:10px;">${status.toUpperCase()}</span>
                <span style="font-size:11px; color:#888;">#${a.id}</span>
              </div>
              <div style="font-size:11px; color:#888; margin-top:4px;">${dt} · ${a.model} · $${Number(a.estimated_cost_usd || 0).toFixed(3)} · ${(a.cases_cited || []).length} cases${witnessLabel}${parentLabel}${ctxLabel}</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <a href="/admin/hearing/individual/${noteId}/closing/${a.id}" style="background:#0C1C36; color:white; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:12px;">Open →</a>
            </div>
          </div>
          <div style="font-size:12px; color:#555; padding:10px; background:#fafaf7; border-radius:6px; font-family:ui-serif, Georgia, serif; line-height:1.5;">${preview}${a.argument_text && a.argument_text.length > 300 ? "…" : ""}</div>
        </div>`;
    }).join("") : `<div style="text-align:center; padding:40px; color:#888;">No closing arguments generated yet.</div>`;

    const body = `
      <div class="page-header">
        <h1>🏛️ Closing Arguments — Individual Hearing #${noteId}</h1>
        <a href="/admin/hearing/individual/${noteId}" class="back-link">← Back to hearing note</a>
      </div>

      <div style="background:#f5f9ff; padding:14px 16px; border-radius:8px; border-left:4px solid #0061FF; margin-bottom:16px; font-size:13px;">
        <strong>Verified case law pool:</strong> ${verifiedPool.length} cases available from your firm's GOAT/MOAT + legal_citations.
        ${verifiedPool.length < 5 ? `<span style="color:#c62828; font-weight:600;"> ⚠️ Need at least 5 asylum cases to generate. Add briefs at <a href="/admin/firm-documents" style="color:#c62828;">/admin/firm-documents</a>.</span>` : ""}
      </div>

      ${sourcesBlock}

      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
        <h2 style="font-size:16px; margin:0 0 12px 0; color:#0C1C36;">✨ Generate New Closing Argument</h2>
        <p style="font-size:13px; color:#666; margin-bottom:10px;">
          This will draft a closing oral argument covering REAL ID Act, credibility, past persecution (including single-incident doctrine), and well-founded fear (subjective + objective prongs). Only cases from your verified pool will be cited.
        </p>
        <label style="font-size:12px; color:#666; display:block; margin-bottom:4px;">Additional context for the AI (optional)</label>
        <textarea id="additional-context" placeholder="e.g., 'emphasize country conditions evidence from Exhibit 12', 'address government's argument that harm was localized', 'client has minor inconsistencies about dates — explain via trauma'..." style="width:100%; min-height:80px; padding:10px; border:1px solid #ccc; border-radius:6px; font-family:inherit; font-size:13px; box-sizing:border-box;"></textarea>
        <button onclick="generateClosing()" id="gen-btn" ${verifiedPool.length < 5 ? "disabled" : ""} style="margin-top:10px; background:${verifiedPool.length < 5 ? "#ccc" : "#B79C62"}; color:white; border:none; padding:12px 24px; border-radius:6px; cursor:${verifiedPool.length < 5 ? "not-allowed" : "pointer"}; font-weight:600; font-size:14px;">
          🏛️ Generate Closing Argument
        </button>
        <div id="gen-status" style="margin-top:10px; font-size:12px; color:#666;"></div>
      </div>

      <h3 style="margin:20px 0 12px 0; font-size:14px; color:#666; text-transform:uppercase; letter-spacing:0.05em;">Generated Arguments (${args.length})</h3>
      ${argsHtml}

      <script>
        async function generateClosing() {
          const btn = document.getElementById("gen-btn");
          const status = document.getElementById("gen-status");
          const ctx = document.getElementById("additional-context").value.trim();
          btn.disabled = true;
          btn.textContent = "⏳ Drafting (30-90s)…";
          status.innerHTML = "<div style='color:#0061FF;'>Reading case facts, retrieving verified case law, drafting…</div>";
          try {
            const r = await fetch("/admin/hearing/individual/${noteId}/generate-closing", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ additional_context: ctx }),
            });
            const d = await r.json();
            if (d.ok) {
              status.innerHTML = "<div style='color:#2e7d32;'>✅ Generated! Redirecting…</div>";
              setTimeout(() => location.href = "/admin/hearing/individual/${noteId}/closing/" + d.id, 500);
            } else {
              status.innerHTML = "<div style='color:#c62828;'>❌ " + (d.error || "Failed") + "</div>";
              btn.disabled = false;
              btn.textContent = "🏛️ Generate Closing Argument";
            }
          } catch (e) {
            status.innerHTML = "<div style='color:#c62828;'>❌ " + e.message + "</div>";
            btn.disabled = false;
            btn.textContent = "🏛️ Generate Closing Argument";
          }
        }
      </script>`;

    res.send(hearingNotes.renderAdminChrome({ title: "Closing Arguments", body, activeItem: "individual" }));
  } catch (err) {
    console.error("[closing list]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// Clone a merits hearing as a continuation — pre-fills every field from the
// original (exhibits, examinations, prep notes, etc.) with only the hearing_date
// changed to the new date attorney provides.
app.post("/admin/hearing/individual/:id/continuation", async (req, res) => {
  try {
    const ihn = require("./individual-hearing-notes");
    const noteId = parseInt(req.params.id, 10);
    if (!noteId) return res.status(400).json({ ok: false, error: "Invalid note ID" });
    const { new_hearing_date, new_hearing_time, notes } = req.body || {};
    if (!new_hearing_date) return res.status(400).json({ ok: false, error: "new_hearing_date required" });

    const result = await ihn.cloneAsContinuation(noteId, {
      newHearingDate: new_hearing_date,
      newHearingTime: new_hearing_time || null,
      notes: notes || null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[continuation]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/hearing/individual/:id/generate-closing", async (req, res) => {
  try {
    const cag = require("./closing-argument-generator");
    const noteId = parseInt(req.params.id, 10);
    if (!noteId) return res.status(400).json({ ok: false, error: "Invalid note ID" });

    const result = await cag.generateClosingArgument({
      individualNoteId: noteId,
      additionalContext: (req.body && req.body.additional_context) || "",
      parentId: (req.body && req.body.parent_id) || null,
      createdBy: req.user?.id || null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[closing generate]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/hearing/individual/:noteId/closing/:closingId", async (req, res) => {
  try {
    const cag = require("./closing-argument-generator");
    const hearingNotes = require("./hearing-notes");
    const closing = await cag.getClosingArgument(parseInt(req.params.closingId, 10));
    if (!closing) return res.status(404).send("Closing argument not found");

    const displayText = closing.user_edits || closing.argument_text;
    const escaped = String(displayText).replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const body = `
      <div class="page-header">
        <h1>🏛️ Closing Argument — Version ${closing.version || 1}</h1>
        <a href="/admin/hearing/individual/${req.params.noteId}/closing" class="back-link">← All versions</a>
      </div>

      <div style="background:#f5f9ff; padding:12px 14px; border-radius:8px; font-size:12px; color:#555; margin-bottom:16px; display:flex; gap:16px; flex-wrap:wrap;">
        <div><strong>Client:</strong> ${(closing.client_name || "").replace(/</g, "&lt;")}</div>
        ${closing.a_number ? `<div><strong>A#:</strong> ${closing.a_number.replace(/</g, "&lt;")}</div>` : ""}
        <div><strong>Generated:</strong> ${new Date(closing.generated_at).toLocaleString()}</div>
        <div><strong>Model:</strong> ${closing.model}</div>
        <div><strong>Cost:</strong> $${Number(closing.estimated_cost_usd || 0).toFixed(4)}</div>
        <div><strong>Cases cited:</strong> ${(closing.cases_cited || []).length}</div>
        <div><strong>Status:</strong> ${closing.status}</div>
        ${closing.parent_id ? `<div><strong>Regenerated from:</strong> <a href="/admin/hearing/individual/${req.params.noteId}/closing/${closing.parent_id}" style="color:#0061FF;">Version ${closing.version - 1} (#${closing.parent_id})</a></div>` : ""}
      </div>

      ${closing.additional_context ? `
      <details style="background:#fff8ec; padding:12px 16px; border-radius:8px; border-left:3px solid #B79C62; margin-bottom:16px; font-size:12px;">
        <summary style="cursor:pointer; font-weight:600; color:#0C1C36;">📝 Attorney's context for this version</summary>
        <div style="margin-top:8px; color:#555; white-space:pre-wrap;">${String(closing.additional_context).replace(/</g, "&lt;")}</div>
      </details>` : ""}

      <div style="background:white; padding:32px 40px; border-radius:8px; border:1px solid #eee; max-width:820px; font-family:ui-serif, Georgia, serif; font-size:15px; line-height:1.75; color:#0C1C36; white-space:pre-wrap;" id="argument-text">${escaped}</div>

      <div style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
        <button onclick="copyText()" style="background:#0C1C36; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">📋 Copy to clipboard</button>
        <button onclick="printArgument()" style="background:#B79C62; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🖨️ Print</button>
        <button onclick="regenerate()" style="background:#7c4dff; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🔄 Regenerate (new version)</button>
        <button onclick="markStatus('finalized')" style="background:#0061FF; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">✓ Mark finalized</button>
        <button onclick="markStatus('delivered')" style="background:#2e7d32; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🎯 Mark delivered</button>
      </div>

      ${(closing.cases_cited || []).length > 0 ? `
      <details style="margin-top:20px; background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee;">
        <summary style="cursor:pointer; font-weight:600; color:#0C1C36;">📚 Cases cited in this closing (${closing.cases_cited.length})</summary>
        <ul style="margin-top:10px; font-size:12px; color:#555; line-height:1.7;">
          ${closing.cases_cited.map(c => `<li>${String(c).replace(/</g, "&lt;")}</li>`).join("")}
        </ul>
      </details>` : ""}

      <!-- Regenerate modal -->
      <div id="regen-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:9999; align-items:center; justify-content:center; padding:20px;">
        <div style="background:white; padding:24px; border-radius:12px; max-width:520px; width:100%;">
          <h3 style="margin:0 0 12px 0; color:#0C1C36;">🔄 Regenerate Closing</h3>
          <p style="font-size:13px; color:#666; margin-bottom:12px;">
            A new version will be created using the same hearing notes and testimony, plus any additional direction you provide below. The previous version stays saved.
          </p>
          <label style="font-size:12px; color:#666; display:block; margin-bottom:4px;">What to change / emphasize (optional)</label>
          <textarea id="regen-context" placeholder="e.g., 'make it more concise', 'emphasize country conditions', 'add more discussion of PSG', 'address the DHS argument about internal relocation'..." style="width:100%; min-height:100px; padding:10px; border:1px solid #ccc; border-radius:6px; font-family:inherit; font-size:13px; box-sizing:border-box;"></textarea>
          <div style="margin-top:14px; display:flex; gap:8px; justify-content:flex-end;">
            <button onclick="closeRegenModal()" style="background:#eee; color:#555; border:none; padding:8px 16px; border-radius:6px; cursor:pointer;">Cancel</button>
            <button onclick="doRegenerate()" id="regen-btn" style="background:#7c4dff; color:white; border:none; padding:8px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🔄 Regenerate</button>
          </div>
        </div>
      </div>

      <script>
        function copyText() {
          const text = document.getElementById("argument-text").innerText;
          navigator.clipboard.writeText(text).then(() => alert("✓ Copied to clipboard"));
        }
        function printArgument() { window.print(); }
        function regenerate() {
          const modal = document.getElementById("regen-modal");
          modal.style.display = "flex";
        }
        function closeRegenModal() {
          document.getElementById("regen-modal").style.display = "none";
        }
        async function doRegenerate() {
          const btn = document.getElementById("regen-btn");
          const ctx = document.getElementById("regen-context").value.trim();
          btn.disabled = true;
          btn.textContent = "⏳ Drafting (30-90s)…";
          try {
            const r = await fetch("/admin/hearing/individual/${req.params.noteId}/generate-closing", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ additional_context: ctx, parent_id: ${closing.id} }),
            });
            const d = await r.json();
            if (d.ok) {
              // Mark the parent as superseded
              await fetch("/admin/hearing/individual/${req.params.noteId}/closing/${closing.id}/status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "superseded" }),
              });
              location.href = "/admin/hearing/individual/${req.params.noteId}/closing/" + d.id;
            } else {
              alert("Error: " + (d.error || "unknown"));
              btn.disabled = false;
              btn.textContent = "🔄 Regenerate";
            }
          } catch (e) {
            alert("Error: " + e.message);
            btn.disabled = false;
            btn.textContent = "🔄 Regenerate";
          }
        }
        async function markStatus(status) {
          const r = await fetch("/admin/hearing/individual/${req.params.noteId}/closing/${closing.id}/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          });
          const d = await r.json();
          if (d.ok) location.reload();
          else alert("Error: " + (d.error || "unknown"));
        }
      </script>`;

    res.send(hearingNotes.renderAdminChrome({ title: "Closing Argument", body, activeItem: "individual" }));
  } catch (err) {
    console.error("[closing view]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.post("/admin/hearing/individual/:noteId/closing/:closingId/status", async (req, res) => {
  try {
    const cag = require("./closing-argument-generator");
    const status = req.body && req.body.status;
    if (!["draft", "finalized", "delivered", "superseded"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }
    const updated = await cag.updateClosingArgument(parseInt(req.params.closingId, 10), { status });
    res.json({ ok: true, closing: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Zara SPA tabs wrapped in the main admin chrome ─────
// Loads /admin/?embed=1#tab in an iframe so the outer sidebar stays visible.
// This lets JJ browse Intakes, Messages, Prompt, Research, etc. without leaving
// the unified navigation.
app.get("/admin/panel/:tab", async (req, res) => {
  try {
    // Only admin role can see Zara operational tabs. Others → dashboard.
    if (!req.user) return res.redirect("/admin/login?next=" + encodeURIComponent(req.originalUrl));
    if (req.user.r !== "admin") {
      const hearingNotes = require("./hearing-notes");
      return res.status(403).send(hearingNotes.renderAdminChrome({
        title: "Access Denied",
        activeItem: null,
        body: `
          <div class="page-header"><h1 style="color:#c00;">🔒 Not Available</h1></div>
          <div style="background:white; padding:24px; border-radius:8px; border:1px solid #eee; max-width:520px;">
            <p style="margin-bottom:16px; font-size:14px; line-height:1.5;">
              This section is only available to Admin users. Your role
              (<strong>${req.user.r}</strong>) doesn't have access.
            </p>
            <p style="margin-bottom:20px; font-size:13px; color:#666;">
              If you think this is wrong, ask JJ to update your role via
              <a href="/admin/users" style="color:#B79C62;">Admin Users</a>.
            </p>
            <a href="/admin/dashboard" style="background:#0C1C36; color:white; padding:8px 16px; border-radius:6px; text-decoration:none; font-size:13px;">← Dashboard</a>
          </div>`,
      }));
    }

    const { tab } = req.params;
    const validTabs = {
      dashboard:  "Zara Overview",
      prompt:     "System Prompt",
      intakes:    "Intakes",
      messages:   "Messages",
      compliance: "Compliance",
      analytics:  "Analytics",
      research:   "Legal Research",
      pipeline:   "Pipeline",
      conflicts:  "Conflicts",
      questions:  "Questions",
      audit:      "Audit",
      post:       "Post Creator",
      scores:     "Conversation Scores",
      sol:        "SoL Deadlines",
      drip:       "Drip Campaigns",
    };
    if (!validTabs[tab]) return res.redirect("/admin/dashboard");

    const hearingNotes = require("./hearing-notes");
    res.send(hearingNotes.renderAdminChrome({
      title: validTabs[tab],
      activeItem: null,
      body: `
        <div style="margin:-28px -32px -40px 0; padding:0; min-height:calc(100vh - 0px);">
          <iframe
            src="/admin/?embed=1#${tab}"
            id="zara-embed"
            style="width:100%; min-height:calc(100vh - 8px); height:calc(100vh - 8px); border:0; display:block; background:white; border-radius:8px 0 0 0;"
            allow="clipboard-read; clipboard-write"
          ></iframe>
        </div>
        <script>
          // Keep iframe height synced to viewport
          function resizeEmbed() {
            const f = document.getElementById('zara-embed');
            if (f) f.style.height = (window.innerHeight - 8) + 'px';
          }
          window.addEventListener('resize', resizeEmbed);
          resizeEmbed();
        </script>
      `,
    }));
  } catch (err) {
    console.error("[/admin/panel]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

app.get("/admin/dashboard", async (req, res) => {
  try {
    const dashboard = require("./dashboard");
    const [
      upcoming, unnotified, recent, reminderStats, clientStats,
      intakes, intakeStats, motions, motionStats, deadlines, deadlineStats, health,
      posts, postStats, drips, dripStats, sols, solStats,
      pendingResearch, citations, researchStats, usptoMatches, usptoStats, moat,
    ] = await Promise.all([
      dashboard.getUpcomingHearings(14),
      dashboard.getUnnotifiedNotices(),
      dashboard.getRecentHearings(10),
      dashboard.getReminderStats(),
      dashboard.getClientStats(),
      dashboard.getRecentIntakes(10),
      dashboard.getIntakeStats(),
      dashboard.getPendingMotions(10),
      dashboard.getMotionStats(),
      dashboard.getUrgentDeadlines(15),
      dashboard.getDeadlineStats(),
      dashboard.getSystemHealth(),
      dashboard.getRecentPosts(10),
      dashboard.getPostStats(),
      dashboard.getDripCampaigns(10),
      dashboard.getDripStats(),
      dashboard.getUrgentSolDeadlines(8),
      dashboard.getSolStats(),
      dashboard.getPendingResearch(8),
      dashboard.getRecentCitations(6),
      dashboard.getResearchStats(),
      dashboard.getUsptoMatches(8),
      dashboard.getUsptoStats(),
      dashboard.getMoatStats(),
    ]);
    res.send(dashboard.renderDashboard({
      upcoming, unnotified, recent, reminderStats, clientStats,
      intakes, intakeStats, motions, motionStats, deadlines, deadlineStats, health,
      posts, postStats, drips, dripStats, sols, solStats,
      pendingResearch, citations, researchStats, usptoMatches, usptoStats, moat,
    }));
  } catch (err) {
    console.error("[dashboard]:", err.message, err.stack);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><pre>${err.stack}</pre>`);
  }
});

// ── Deadline Tracker ─────────────────────────────
app.get("/admin/deadlines", async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    const hearingNotes = require("./hearing-notes");
    const filters = {
      client_name: req.query.client || undefined,
      assigned_to: req.query.assigned || undefined,
      source_type: req.query.source || undefined,
      status: req.query.status || undefined,
    };
    const list = await deadlines.listDeadlines(filters);

    // Get all users for the assign dropdown
    let users = [];
    try {
      const result = await db.query(`SELECT id, full_name AS name FROM admin_users WHERE COALESCE(disabled, false) = false ORDER BY full_name`);
      users = result.rows;
    } catch {
      try {
        const result = await db.query(`SELECT id, full_name AS name FROM admin_users ORDER BY full_name LIMIT 20`);
        users = result.rows;
      } catch { users = []; }
    }

    const renderFn = deadlines.renderDeadlinesPage(req.user, filters);
    const body = await renderFn(list, users);

    res.send(hearingNotes.renderAdminChrome({ title: "Deadline Tracker", body, activeItem: "deadlines" }));
  } catch (err) {
    console.error("[deadlines page]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><pre>${err.stack || ""}</pre>`);
  }
});

app.post("/admin/deadlines", express.json(), async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    const id = await deadlines.createManual({
      client_name: req.body.client_name,
      a_number: req.body.a_number,
      due_date: req.body.due_date,
      description: req.body.description,
      priority: req.body.priority,
      assigned_to: req.body.assigned_to ? parseInt(req.body.assigned_to, 10) : null,
      notes: req.body.notes,
    });
    try {
      const audit = require("./audit-log");
      await audit.log({ user_id: req.user?.id, action: "deadline.create_manual", target_type: "deadline", target_id: id, changes: req.body });
    } catch { /* silent */ }
    res.json({ ok: true, id });
  } catch (err) {
    console.error("[deadline create]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/deadlines/:id/complete", async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    await deadlines.markComplete(parseInt(req.params.id, 10), req.user?.id);
    try {
      const audit = require("./audit-log");
      await audit.log({ user_id: req.user?.id, action: "deadline.complete", target_type: "deadline", target_id: parseInt(req.params.id, 10) });
    } catch { /* silent */ }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/deadlines/:id/reopen", async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    await deadlines.reopen(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/admin/deadlines/:id/snooze", express.json(), async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    const days = parseInt(req.body.days, 10) || 7;
    await deadlines.snooze(parseInt(req.params.id, 10), days);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/admin/deadlines/:id/edit", express.json(), async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    await deadlines.updateDeadline(parseInt(req.params.id, 10), req.body);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/admin/deadlines/:id/delete", async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    await deadlines.remove(parseInt(req.params.id, 10));
    try {
      const audit = require("./audit-log");
      await audit.log({ user_id: req.user?.id, action: "deadline.delete", target_type: "deadline", target_id: parseInt(req.params.id, 10) });
    } catch { /* silent */ }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/admin/deadlines/sync-all", auth.requireRole("admin"), async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    const results = await deadlines.syncAll();
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── EOIR Calendar (unified hearings + deadlines) ─────

// ── Outlook Sync ─────────────────────────────────────
app.get("/admin/outlook-sync", async (req, res) => {
  try {
    const outlook = require("./outlook-sync");
    const hearingNotes = require("./hearing-notes");
    const config = await outlook.getConfig();
    const events = await outlook.listRecentEvents(100);
    const body = outlook.renderSettingsPage(config, events);
    res.send(hearingNotes.renderAdminChrome({ title: "Outlook Sync", body, activeItem: "calendar" }));
  } catch (err) {
    console.error("[outlook-sync]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><pre>${err.stack}</pre>`);
  }
});

app.post("/admin/outlook-sync/config", express.json(), async (req, res) => {
  try {
    const outlook = require("./outlook-sync");
    await outlook.updateConfig({
      ical_url: req.body.ical_url,
      keyword_filter: req.body.keyword_filter,
      auto_sync_enabled: !!req.body.auto_sync_enabled,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/admin/outlook-sync/run", async (req, res) => {
  try {
    const outlook = require("./outlook-sync");
    const result = await outlook.syncFromUrl();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[outlook-sync run]:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const icsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post("/admin/outlook-sync/upload", icsUpload.single("ics_file"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const outlook = require("./outlook-sync");
    const result = await outlook.importFromBuffer(req.file.buffer);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[outlook-sync upload]:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/admin/outlook-sync/events", async (req, res) => {
  try {
    const outlook = require("./outlook-sync");
    await outlook.purgeAll();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Track scan status in DB (survives Render restarts, allows polling)
async function initScanStatusTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS scan_status (
      id                SERIAL PRIMARY KEY,
      scan_type         TEXT NOT NULL,
      running           BOOLEAN DEFAULT true,
      phase             TEXT,
      current_client    TEXT,
      progress_current  INTEGER DEFAULT 0,
      progress_total    INTEGER DEFAULT 0,
      results           JSONB,
      error             TEXT,
      cancel_requested  BOOLEAN DEFAULT FALSE,
      started_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);
  // Migration: add cancel_requested if the table already existed
  try {
    await db.query(`ALTER TABLE scan_status ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN DEFAULT FALSE`);
  } catch (e) { console.warn("[scan-status] migration cancel_requested:", e.message); }

  // On boot, clear any stale "running" scans older than 30 minutes
  await db.query(`
    UPDATE scan_status
    SET running = false, error = 'Interrupted (server restarted)', updated_at = NOW()
    WHERE running = true AND updated_at < NOW() - INTERVAL '30 minutes'
  `);
}
initScanStatusTable().catch(e => console.warn("[scan-status] init:", e.message));

// Init AI audit trail table on boot (safe no-op if exists)
try {
  require("./ai-audit-trail").initTable().catch(e => console.warn("[audit-trail] init:", e.message));
} catch (e) { console.warn("[audit-trail] module load:", e.message); }

// Init Personal Injury tables on boot
try {
  require("./personal-injury").initTables().catch(e => console.warn("[pi] init:", e.message));
} catch (e) { console.warn("[pi] module load:", e.message); }

// Init PI demand letter table on boot
try {
  require("./pi-demand-letter").initTable().catch(e => console.warn("[pi-demand] init:", e.message));
} catch (e) { console.warn("[pi-demand] module load:", e.message); }

// Init Accounting tables on boot (seeds default chart of accounts if empty)
try {
  require("./accounting").initTables().catch(e => console.warn("[accounting] init:", e.message));
} catch (e) { console.warn("[accounting] module load:", e.message); }

async function setScanStatus(id, updates) {
  const allowed = ["running", "phase", "current_client", "progress_current", "progress_total", "results", "error"];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      if (key === "results" && updates[key] != null) {
        sets.push(`${key} = $${i++}::jsonb`);
        values.push(JSON.stringify(updates[key]));
      } else {
        sets.push(`${key} = $${i++}`);
        values.push(updates[key]);
      }
    }
  }
  if (!sets.length) return;
  sets.push(`updated_at = NOW()`);
  values.push(id);
  await db.query(`UPDATE scan_status SET ${sets.join(", ")} WHERE id = $${i}`, values);
}

async function startScanAllNoticesJob() {
  // Check for existing running scan
  const running = await db.query(
    `SELECT id FROM scan_status WHERE scan_type = 'dropbox_notices' AND running = true LIMIT 1`
  );
  if (running.rows.length) {
    return { already_running: true, scan_id: running.rows[0].id };
  }

  // Create new scan status row
  const inserted = await db.query(
    `INSERT INTO scan_status (scan_type, running, phase) VALUES ('dropbox_notices', true, 'starting') RETURNING id`
  );
  const scanId = inserted.rows[0].id;

  // Fire and forget — do the actual work asynchronously so HTTP returns fast
  runScanAllNoticesAsync(scanId).catch(err => {
    console.error("[scan-all-notices] fatal:", err);
    setScanStatus(scanId, { running: false, error: err.message }).catch(() => {});
  });

  return { started: true, scan_id: scanId };
}

async function runScanAllNoticesAsync(scanId) {
  const cp = require("./client-profiles");
  const dbx = require("./dropbox-integration");
  const hn = require("./hearing-notices");

  await setScanStatus(scanId, { phase: "loading_clients" });
  const clients = await cp.aggregateClients();
  const total = clients.length;

  const results = {
    total_clients: total,
    scanned: 0,
    skipped_no_folder: 0,
    errors: 0,
    new_notices: 0,
    updated_notices: 0,
    total_files_processed: 0,
    estimated_cost_usd: 0,
    per_client: [],
    timeout_clients: [],
  };

  await setScanStatus(scanId, {
    phase: "scanning",
    progress_current: 0,
    progress_total: total,
  });

  // Per-client hard timeout to prevent one stuck client from blocking whole batch
  const PER_CLIENT_TIMEOUT_MS = 90 * 1000;  // 90 seconds each
  const LIMIT_PER_CLIENT = 3;  // Max NEW files scanned per client per run (already-scanned ones auto-skipped)

  const withTimeout = (promise, ms, label) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms/1000}s: ${label}`)), ms)),
    ]);
  };

  for (let i = 0; i < clients.length; i++) {
    // Check if user requested cancellation between each client
    const cancelCheck = await db.query(`SELECT cancel_requested FROM scan_status WHERE id = $1`, [scanId]);
    if (cancelCheck.rows[0] && cancelCheck.rows[0].cancel_requested) {
      results.cancelled = true;
      results.cancelled_at_index = i;
      await setScanStatus(scanId, {
        running: false,
        phase: "cancelled",
        error: `Cancelled by user after ${i} of ${clients.length} clients`,
        results,
      });
      console.log(`[scan-all-notices] Cancelled by user after ${i}/${clients.length}`);
      return;
    }

    const client = clients[i];
    const clientLabel = client.client_name || "unknown";

    await setScanStatus(scanId, {
      progress_current: i,
      current_client: clientLabel,
    });

    try {
      const folder = await withTimeout(
        dbx.resolveClientFolder({
          clientKey: client.key, clientName: client.client_name, aNumber: client.a_number,
        }),
        15000,
        `resolveClientFolder(${clientLabel})`
      ).catch(() => null);

      if (!folder) {
        results.skipped_no_folder++;
        continue;
      }

      const scan = await withTimeout(
        hn.scanClientFolder({
          clientKey: client.key,
          clientName: client.client_name,
          aNumber: client.a_number,
          dropboxFolderPath: folder,
          limit: LIMIT_PER_CLIENT,
        }),
        PER_CLIENT_TIMEOUT_MS,
        `scanClientFolder(${clientLabel})`
      ).catch((e) => ({ error: e.message }));

      if (scan.error) {
        results.errors++;
        const isTimeout = /Timeout after/.test(scan.error);
        if (isTimeout) results.timeout_clients.push(clientLabel);
        results.per_client.push({ client: clientLabel, error: scan.error });
        // Update progress after each error too
        await setScanStatus(scanId, { results });
        continue;
      }

      results.scanned++;
      const newCount = scan.new_notices || scan.newNotices || 0;
      const updatedCount = scan.updated_notices || scan.updatedNotices || 0;
      results.new_notices += newCount;
      results.updated_notices += updatedCount;
      results.total_files_processed += (scan.scanned || 0);
      results.estimated_cost_usd = +(Number(results.estimated_cost_usd || 0) + Number(scan.estimated_cost_usd || 0)).toFixed(4);

      if (newCount > 0 || updatedCount > 0) {
        results.per_client.push({
          client: clientLabel,
          a_number: client.a_number,
          new: newCount,
          updated: updatedCount,
        });
      }

      // Periodic status write (every 5 clients) so UI polling sees progress
      if (i % 5 === 0) {
        await setScanStatus(scanId, { results });
      }
    } catch (e) {
      results.errors++;
      console.warn(`[scan-all] ${clientLabel}: ${e.message}`);
      results.per_client.push({ client: clientLabel, error: e.message });
    }
  }

  await setScanStatus(scanId, {
    running: false,
    phase: "complete",
    progress_current: total,
    current_client: null,
    results,
  });

  // Record the full-scan completion timestamp. Daily scans use this as a
  // hard floor — any file uploaded before this was already checked, so it
  // will never be re-scanned by a daily job.
  try {
    const hn = require("./hearing-notices");
    await hn.setScanSetting("last_full_scan_completed_at", new Date().toISOString());
  } catch (e) {
    console.warn("[scan-all-notices] failed to record completion timestamp:", e.message);
  }

  console.log(`[scan-all-notices] Complete: ${results.scanned}/${total} scanned, ${results.new_notices} new notices, ${results.errors} errors`);
}

app.post("/admin/calendar/scan-all-notices", async (req, res) => {
  try {
    const result = await startScanAllNoticesJob();
    if (result.already_running) {
      return res.json({ ok: true, already_running: true, scan_id: result.scan_id });
    }
    res.json({ ok: true, started: true, scan_id: result.scan_id });
  } catch (err) {
    console.error("[calendar scan-all]:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/calendar/scan-status", async (req, res) => {
  try {
    const scanId = req.query.scan_id ? parseInt(req.query.scan_id, 10) : null;
    let row;
    if (scanId) {
      const { rows } = await db.query(`SELECT * FROM scan_status WHERE id = $1`, [scanId]);
      row = rows[0];
    } else {
      // Return most recent
      const { rows } = await db.query(
        `SELECT * FROM scan_status WHERE scan_type = 'dropbox_notices' ORDER BY started_at DESC LIMIT 1`
      );
      row = rows[0];
    }
    if (!row) return res.json({ ok: true, exists: false });
    res.json({
      ok: true,
      exists: true,
      scan_id: row.id,
      running: row.running,
      phase: row.phase,
      current_client: row.current_client,
      progress_current: row.progress_current,
      progress_total: row.progress_total,
      results: row.results,
      error: row.error,
      cancel_requested: row.cancel_requested || false,
      started_at: row.started_at,
      updated_at: row.updated_at,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/calendar/scan-status/reset", async (req, res) => {
  try {
    await db.query(`UPDATE scan_status SET running = false WHERE scan_type = 'dropbox_notices' AND running = true`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Request cancellation of a running scan. The scan loop checks this flag
// between each client and exits gracefully with partial results.
app.post("/admin/calendar/scan-status/cancel", async (req, res) => {
  try {
    const scanId = req.body && req.body.scan_id ? parseInt(req.body.scan_id, 10) : null;
    if (scanId) {
      await db.query(`UPDATE scan_status SET cancel_requested = TRUE WHERE id = $1 AND running = TRUE`, [scanId]);
    } else {
      // No specific ID — cancel any running scan of this type
      await db.query(`UPDATE scan_status SET cancel_requested = TRUE WHERE scan_type = 'dropbox_notices' AND running = TRUE`);
    }
    res.json({ ok: true, cancel_requested: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Manually trigger cleanup of past hearing notices (same as daily cron does)
app.post("/admin/calendar/cleanup-past", async (req, res) => {
  try {
    const hn = require("./hearing-notices");
    const grace = req.body && req.body.grace_period_days ? parseInt(req.body.grace_period_days, 10) : 1;
    const result = await hn.dismissPastNotices({ gracePeriodDays: grace });
    res.json({ ok: true, dismissed_count: result.dismissed_count, dismissed: result.dismissed.slice(0, 20) });
  } catch (err) {
    console.error("[cleanup-past]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Set the "last full scan completed" watermark to NOW. Useful for seeding daily
// scans so they don't re-scan every file on their first run before a real full
// scan has been done.
app.post("/admin/calendar/scan-floor/seed-now", async (req, res) => {
  try {
    const hn = require("./hearing-notices");
    const iso = new Date().toISOString();
    await hn.setScanSetting("last_full_scan_completed_at", iso);
    res.json({ ok: true, last_full_scan_completed_at: iso });
  } catch (err) {
    console.error("[scan-floor seed]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Read the current scan floor value
app.get("/admin/calendar/scan-floor", async (req, res) => {
  try {
    const hn = require("./hearing-notices");
    const value = await hn.getScanSetting("last_full_scan_completed_at");
    res.json({ ok: true, last_full_scan_completed_at: value });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/calendar", async (req, res) => {
  try {
    const cal = require("./eoir-calendar");
    const hearingNotes = require("./hearing-notes");

    // Determine date range for month view vs list view
    const view = req.query.view === "month" ? "month" : "list";
    const now = new Date();
    let fromDate, toDate, monthYear = null;

    if (view === "month") {
      const m = parseInt(req.query.m, 10) || (now.getMonth() + 1);
      const y = parseInt(req.query.y, 10) || now.getFullYear();
      monthYear = { month: m, year: y };
      // Pull events for this month plus a buffer
      fromDate = new Date(y, m - 1, 1).toISOString();
      toDate = new Date(y, m, 1).toISOString();
    } else {
      // List view: default to TODAY (00:00 local) forward 90 days.
      // If the user explicitly passes ?from=YYYY-MM-DD they can look at past hearings.
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      fromDate = req.query.from
        ? new Date(req.query.from).toISOString()
        : startOfToday.toISOString();
      toDate = req.query.to
        ? new Date(req.query.to + "T23:59:59").toISOString()
        : new Date(now.getTime() + 90 * 86400000).toISOString();
    }

    const filters = {
      from_date: fromDate,
      to_date: toDate,
      from_date_str: req.query.from || "",
      to_date_str: req.query.to || "",
      client_search: req.query.client || "",
      court: req.query.court || "",
      judge: req.query.judge || "",
    };

    const events = await cal.getUnifiedEvents({
      from_date: fromDate,
      to_date: toDate,
      client_search: req.query.client,
      court: req.query.court,
      judge: req.query.judge,
    });

    // Stats always include full range so numbers are meaningful
    const statsEvents = await cal.getUnifiedEvents({
      from_date: new Date(now.getTime() - 30 * 86400000).toISOString(),
      to_date: new Date(now.getTime() + 90 * 86400000).toISOString(),
    });
    const stats = cal.computeStats(statsEvents);

    const body = cal.renderCalendarPage({ events, stats, filters, view, monthYear });
    res.send(hearingNotes.renderAdminChrome({ title: "EOIR Calendar", body, activeItem: "calendar" }));
  } catch (err) {
    console.error("[calendar]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><pre>${err.stack}</pre>`);
  }
});

// Manual trigger for daily alerts (testing/debugging)
app.post("/admin/deadlines/run-alerts", auth.requireRole("admin"), async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    const results = await deadlines.runDailyAlerts();
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Backfill: create merits evidence deadlines for ALL individual hearings with
// future dates. Also useful after upgrading to this feature.
app.post("/admin/deadlines/backfill-merits", auth.requireRole("admin"), async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    const results = await deadlines.backfillMeritsEvidenceDeadlines();
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Backfill: create master hearing prep deadlines for ALL hearing_notes with
// future next_hearing_date.
app.post("/admin/deadlines/backfill-master", auth.requireRole("admin"), async (req, res) => {
  try {
    const deadlines = require("./deadline-tracker");
    const results = await deadlines.backfillMasterHearingDeadlines();
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Court Motion Draft Generator ─────────────────────
app.get("/admin/motions", async (req, res) => {
  try {
    const motions = require("./motion-generator");
    const hearingNotes = require("./hearing-notes");
    const filters = {
      client_name: req.query.client || undefined,
      motion_type: req.query.type || undefined,
      status: req.query.status || undefined,
    };
    const list = await motions.listMotions(filters);
    const body = motions.renderMotionListPage(list, filters);
    res.send(hearingNotes.renderAdminChrome({ title: "Court Motions", body, activeItem: "motions" }));
  } catch (err) {
    console.error("[motions list]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.get("/admin/motions/new", async (req, res) => {
  try {
    const motions = require("./motion-generator");
    const hearingNotes = require("./hearing-notes");
    const prefill = {
      client_name: req.query.client_name || undefined,
      a_number: req.query.a_number || undefined,
      hearing_note_id: req.query.hearing_note_id ? parseInt(req.query.hearing_note_id, 10) : undefined,
      motion_type: req.query.type || undefined,
    };
    // If linked to a hearing note, pull court/judge info from it
    if (prefill.hearing_note_id) {
      try {
        const { rows } = await db.query(
          `SELECT client_name, a_number, judge_name FROM hearing_notes WHERE id = $1`,
          [prefill.hearing_note_id]
        );
        if (rows[0]) {
          prefill.client_name = prefill.client_name || rows[0].client_name;
          prefill.a_number = prefill.a_number || rows[0].a_number;
          prefill.judge_name = rows[0].judge_name;
          // Court name lives on hearing_notices — try to pull from there
          const nRes = await db.query(
            `SELECT court_name FROM client_hearing_notices
             WHERE (a_number = $1 OR client_name ILIKE $2) AND court_name IS NOT NULL
             ORDER BY hearing_date DESC NULLS LAST LIMIT 1`,
            [rows[0].a_number, rows[0].client_name]
          ).catch(() => ({ rows: [] }));
          if (nRes.rows[0]?.court_name) prefill.court_name = nRes.rows[0].court_name;
        }
      } catch (e) {
        console.warn("[motions new prefill]:", e.message);
      }
    }
    const body = motions.renderNewMotionForm(prefill);
    res.send(hearingNotes.renderAdminChrome({ title: "New Motion", body, activeItem: "motions" }));
  } catch (err) {
    console.error("[motions new]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.get("/admin/motions/:id(\\d+)", async (req, res) => {
  try {
    const motions = require("./motion-generator");
    const hearingNotes = require("./hearing-notes");
    const motion = await motions.getMotion(parseInt(req.params.id, 10));
    if (!motion) return res.status(404).send("<h1>Motion not found</h1>");
    const body = motions.renderMotionEditor(motion);
    res.send(hearingNotes.renderAdminChrome({ title: "Motion Editor", body, activeItem: "motions" }));
  } catch (err) {
    console.error("[motions view]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/motions/generate", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const motions = require("./motion-generator");
    const result = await motions.generateMotion({
      motion_type: req.body.motion_type,
      client_name: req.body.client_name,
      a_number: req.body.a_number,
      hearing_note_id: req.body.hearing_note_id ? parseInt(req.body.hearing_note_id, 10) : null,
      court_name: req.body.court_name,
      judge_name: req.body.judge_name,
      filing_deadline: req.body.filing_deadline || null,
      grounds: req.body.grounds,
      additional_facts: req.body.additional_facts,
    });
    // Save as new motion
    const motion_id = await motions.createMotion({
      motion_type: req.body.motion_type,
      client_name: req.body.client_name,
      a_number: req.body.a_number,
      hearing_note_id: req.body.hearing_note_id ? parseInt(req.body.hearing_note_id, 10) : null,
      court_name: req.body.court_name,
      judge_name: req.body.judge_name,
      filing_deadline: req.body.filing_deadline || null,
      title: motions.MOTION_TYPES[req.body.motion_type]?.label,
      content_markdown: result.markdown,
      ai_grounds: req.body.grounds,
      ai_facts: req.body.additional_facts,
      ai_notes: JSON.stringify({ generation_seconds: result.generation_seconds, tokens_used: result.tokens_used, context_summary: result.context_summary }),
      generated_by: req.user?.id || null,
      status: "draft",
    });
    try {
      const audit = require("./audit-log");
      await audit.log({ user_id: req.user?.id, action: "motion.generate", target_type: "motion", target_id: motion_id, changes: { motion_type: req.body.motion_type, client_name: req.body.client_name } });
    } catch { /* silent */ }
    res.json({ ok: true, motion_id, ...result });
  } catch (err) {
    console.error("[motions generate]:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/admin/motions/:id(\\d+)", express.json({ limit: "5mb" }), async (req, res) => {
  try {
    const motions = require("./motion-generator");
    await motions.updateMotion(parseInt(req.params.id, 10), req.body);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete("/admin/motions/:id(\\d+)", async (req, res) => {
  try {
    const motions = require("./motion-generator");
    await motions.deleteMotion(parseInt(req.params.id, 10));
    try {
      const audit = require("./audit-log");
      await audit.log({ user_id: req.user?.id, action: "motion.delete", target_type: "motion", target_id: parseInt(req.params.id, 10) });
    } catch {}
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/admin/motions/:id(\\d+)/download", async (req, res) => {
  try {
    const motions = require("./motion-generator");
    const motion = await motions.getMotion(parseInt(req.params.id, 10));
    if (!motion) return res.status(404).send("Motion not found");
    const docx = await motions.generateDocxForMotion(motion);
    const cfg = motions.MOTION_TYPES[motion.motion_type];
    const safeName = (motion.client_name || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${new Date().toISOString().substring(0, 10)}_${cfg?.short || motion.motion_type}_${safeName}.docx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(docx);
  } catch (err) {
    console.error("[motions download]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// ── Motion Templates (pleading paper) ────────────────
app.get("/admin/motions/templates", async (req, res) => {
  try {
    const templates = require("./motion-templates");
    const motions = require("./motion-generator");
    const hearingNotes = require("./hearing-notes");
    const list = await templates.listTemplates();
    const body = templates.renderTemplatesPage(list, motions.MOTION_TYPES);
    res.send(hearingNotes.renderAdminChrome({ title: "Motion Templates", body, activeItem: "motions" }));
  } catch (err) {
    console.error("[templates list]:", err);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Upload uses multer's memoryStorage (same as audio/document uploads)
const templateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB max for a template
});

app.post("/admin/motions/templates", templateUpload.single("template_file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }
    const templates = require("./motion-templates");
    let motionTypes = [];
    try { motionTypes = JSON.parse(req.body.motion_types || "[]"); } catch {}
    const result = await templates.uploadTemplate({
      name: req.body.name,
      description: req.body.description,
      docxBuffer: req.file.buffer,
      filename: req.file.originalname,
      motionTypes,
      isDefault: req.body.is_default === "true",
      userId: req.user?.id,
    });
    try {
      const audit = require("./audit-log");
      await audit.log({ user_id: req.user?.id, action: "motion_template.upload", target_type: "motion_template", target_id: result.id, changes: { name: req.body.name, filename: req.file.originalname } });
    } catch {}
    res.json({ ok: true, template: result });
  } catch (err) {
    console.error("[templates upload]:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/motions/templates/:id/download", async (req, res) => {
  try {
    const templates = require("./motion-templates");
    const t = await templates.getTemplate(parseInt(req.params.id, 10));
    if (!t) return res.status(404).send("Template not found");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${t.original_filename || 'template.docx'}"`);
    res.send(t.docx_content);
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/motions/templates/:id/set-default", async (req, res) => {
  try {
    const templates = require("./motion-templates");
    await templates.setDefault(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete("/admin/motions/templates/:id", async (req, res) => {
  try {
    const templates = require("./motion-templates");
    await templates.deleteTemplate(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/admin/motions/:id(\\d+)/upload-dropbox", async (req, res) => {
  try {
    const motions = require("./motion-generator");
    const result = await motions.uploadToDropbox(parseInt(req.params.id, 10));
    try {
      const audit = require("./audit-log");
      await audit.log({ user_id: req.user?.id, action: "motion.upload_dropbox", target_type: "motion", target_id: parseInt(req.params.id, 10), changes: { path: result.path } });
    } catch {}
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[motions upload]:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Client lookup — searches across hearing_notes, client_hearing_notices, and
// individual_hearing_notes for a client by name or A-number. Returns best
// match with court, judge, and other info that can be auto-filled into
// the motion form.
app.get("/admin/motions/lookup-client", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ ok: true, matches: [] });

    // Try A-number match first (higher precedence)
    const anumRegex = /a?\s*[-]?\s*\d{2,3}[-\s]?\d{3}[-\s]?\d{3,4}/i;
    const isANumQuery = anumRegex.test(q);
    const wildcard = `%${q}%`;

    const notesCond = isANumQuery ? `a_number ILIKE $1` : `(client_name ILIKE $1 OR a_number ILIKE $1)`;
    const noticesCond = isANumQuery ? `a_number ILIKE $1` : `(client_name ILIKE $1 OR a_number ILIKE $1)`;

    // Grab most recent hearing note for judge/client info
    const hearingNoteRows = await db.query(
      `SELECT client_name, a_number, judge_name, dhs_attorney, hearing_type, hearing_date
       FROM hearing_notes
       WHERE ${notesCond}
       ORDER BY hearing_date DESC NULLS LAST
       LIMIT 5`,
      [wildcard]
    ).then(r => r.rows).catch(() => []);

    // Grab most recent hearing notice for court info
    const noticeRows = await db.query(
      `SELECT client_name, a_number, court_name, court_address, judge_name, hearing_date, hearing_type
       FROM client_hearing_notices
       WHERE ${noticesCond}
       ORDER BY hearing_date DESC NULLS LAST
       LIMIT 5`,
      [wildcard]
    ).then(r => r.rows).catch(() => []);

    // Aggregate by client (name + a_number) — one entry per client with best info from each source
    const byClient = new Map();
    const addToClient = (row, source) => {
      const key = `${(row.client_name || "").toLowerCase().trim()}|${(row.a_number || "").toLowerCase().trim()}`;
      if (!byClient.has(key)) {
        byClient.set(key, {
          client_name: row.client_name,
          a_number: row.a_number,
          court_name: null,
          judge_name: null,
          dhs_attorney: null,
          last_hearing_date: null,
          last_hearing_type: null,
          sources: [],
        });
      }
      const c = byClient.get(key);
      c.sources.push(source);
      if (row.court_name && !c.court_name) c.court_name = row.court_name;
      if (row.judge_name && !c.judge_name) c.judge_name = row.judge_name;
      if (row.dhs_attorney && !c.dhs_attorney) c.dhs_attorney = row.dhs_attorney;
      if (row.hearing_date) {
        const rowDate = new Date(row.hearing_date);
        if (!c.last_hearing_date || rowDate > new Date(c.last_hearing_date)) {
          c.last_hearing_date = row.hearing_date;
          c.last_hearing_type = row.hearing_type;
        }
      }
    };

    // Notices FIRST (they have court_name which is what we most want to pull)
    for (const row of noticeRows) addToClient(row, "hearing_notice");
    for (const row of hearingNoteRows) addToClient(row, "hearing_note");

    const matches = Array.from(byClient.values()).slice(0, 10);
    res.json({ ok: true, matches });
  } catch (err) {
    console.error("[motions lookup-client]:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Audit Log Viewer (admin only) ────────────────────────
app.get("/admin/audit-log", auth.requireRole("admin"), async (req, res) => {
  try {
    const audit = require("./audit-log");
    const filters = {
      userId: req.query.user_id ? parseInt(req.query.user_id) : null,
      action: req.query.action || null,
    };
    const entries = await audit.listRecent({ userId: filters.userId, action: filters.action, limit: 200 });
    const users = await audit.listDistinctUsers();
    res.send(audit.renderAuditLogPage({
      entries,
      filters,
      users,
      actions: Object.values(audit.ACTIONS),
    }));
  } catch (err) {
    console.error("[audit log]:", err.message, "\n", err.stack);
    try {
      const hearingNotes = require("./hearing-notes");
      res.status(500).send(hearingNotes.renderAdminChrome({
        title: "Audit Log Error",
        body: `
          <div class="page-header"><h1 style="color:#c00;">⚠️ Audit Log Error</h1></div>
          <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; max-width:900px;">
            <p>The audit log page failed to render. Details below (also logged server-side):</p>
            <pre style="background:#fef3f0; padding:14px; border-radius:6px; overflow-x:auto; font-size:12px; border-left:3px solid #c00; color:#c00;">${String(err.message || err).replace(/</g, '&lt;')}</pre>
            <details style="margin-top:12px;"><summary style="cursor:pointer; color:#666; font-size:13px;">Stack trace</summary>
              <pre style="background:#f8f8f8; padding:12px; border-radius:6px; overflow-x:auto; font-size:11px; margin-top:8px;">${String(err.stack || '').replace(/</g, '&lt;')}</pre>
            </details>
            <p style="margin-top:20px;"><a href="/admin/dashboard" style="color:#B79C62;">← Back to dashboard</a></p>
          </div>`,
        activeItem: null,
      }));
    } catch {
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  }
});

// ── Manual reminder trigger (admin only) — for testing ───
app.post("/admin/reminders/run-now", auth.requireRole("admin"), async (req, res) => {
  try {
    const reminders = require("./hearing-reminders");
    const result = await reminders.runDailyReminders();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Reminder viewer page (admin only)
app.get("/admin/reminders", auth.requireRole("admin"), async (req, res) => {
  try {
    const reminders = require("./hearing-reminders");
    const [recent, stats] = await Promise.all([
      reminders.getRecentReminders(100),
      reminders.getStats(),
    ]);
    const hearingNotes = require("./hearing-notes");
    const rows = recent.map(r => {
      const dt = new Date(r.sent_at).toLocaleString();
      const hearingDt = r.hearing_date ? new Date(r.hearing_date).toLocaleString() : "";
      const statusBadge = r.success
        ? '<span style="background:#2e7d32; color:white; padding:2px 8px; border-radius:10px; font-size:10px;">✓ sent</span>'
        : r.channel === "skipped"
        ? '<span style="background:#888; color:white; padding:2px 8px; border-radius:10px; font-size:10px;">⊙ skipped</span>'
        : '<span style="background:#c00; color:white; padding:2px 8px; border-radius:10px; font-size:10px;">✕ failed</span>';
      return `<tr>
        <td style="font-size:11px; color:#666;">${dt}</td>
        <td>${r.client_name || ""}</td>
        <td>${hearingDt}</td>
        <td>${r.days_out}d</td>
        <td>${r.channel || ""}</td>
        <td>${statusBadge}</td>
        <td style="font-size:11px; color:#c00;">${r.error_message || ""}</td>
      </tr>`;
    }).join("");
    const body = `
      <div class="page-header"><h1>📣 Hearing Reminders</h1><div style="font-size:13px; color:#666;">Automated reminders sent to clients before hearings. Runs daily at 7 AM Pacific.</div></div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:15px;">
        <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase;">Sent (all-time)</div>
          <div style="font-size:22px; font-weight:600; color:#0C1C36;">${stats.sent}</div>
        </div>
        <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase;">Last 7 days</div>
          <div style="font-size:22px; font-weight:600; color:#0C1C36;">${stats.last_7_days}</div>
        </div>
        <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase;">WhatsApp</div>
          <div style="font-size:22px; font-weight:600; color:#25D366;">${stats.whatsapp_sent}</div>
        </div>
        <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase;">SMS</div>
          <div style="font-size:22px; font-weight:600; color:#0061FF;">${stats.sms_sent}</div>
        </div>
        <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase;">Skipped (no phone)</div>
          <div style="font-size:22px; font-weight:600; color:#888;">${stats.skipped}</div>
        </div>
        <div style="background:white; padding:14px; border-radius:6px; border:1px solid #eee;">
          <div style="font-size:11px; color:#888; text-transform:uppercase;">Failed</div>
          <div style="font-size:22px; font-weight:600; color:${stats.failed ? "#c00" : "#0C1C36"};">${stats.failed}</div>
        </div>
      </div>
      <div style="background:white; padding:15px 20px; border-radius:6px; margin-bottom:15px; border:1px solid #eee;">
        <strong>Manual trigger:</strong>
        <button type="button" onclick="runNow()" style="background:#0C1C36; color:white; padding:8px 14px; border:none; border-radius:3px; cursor:pointer; margin-left:10px;">🚀 Run reminders now</button>
        <span style="font-size:12px; color:#666; margin-left:10px;">Sends any pending 7-day or 1-day reminders immediately.</span>
        <div id="run-status" style="margin-top:10px; font-size:13px;"></div>
      </div>
      <table style="background:white; width:100%; font-size:13px;">
        <thead>
          <tr><th>Sent at</th><th>Client</th><th>Hearing</th><th>Window</th><th>Channel</th><th>Status</th><th>Error</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center; color:#888; padding:20px;">No reminders sent yet.</td></tr>'}</tbody>
      </table>
      <script>
        async function runNow() {
          const s = document.getElementById("run-status");
          s.textContent = "⏳ Running…";
          try {
            const r = await fetch("/admin/reminders/run-now", { method: "POST" });
            const d = await r.json();
            if (d.ok) {
              s.innerHTML = '<span style="color:#2e7d32;">✓ Done — 7d: ' + d.result.sevenDay.sent + ' sent, 1d: ' + d.result.oneDay.sent + ' sent</span>';
              setTimeout(() => location.reload(), 2000);
            } else {
              s.innerHTML = '<span style="color:#c00;">❌ ' + d.error + '</span>';
            }
          } catch (e) {
            s.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
          }
        }
      </script>`;
    res.send(hearingNotes.renderAdminChrome({ title: "Hearing Reminders", body, activeItem: null }));
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// ── Admin panel ───────────────────────────────────────────
// Matter manager mounted BEFORE adminRouter so /admin/matters/* takes
// precedence; otherwise Express would route those requests into the
// general admin router (which has no /matters/* routes and would 404).
//
// Both are restricted to admin role only — they contain JJ's operational
// tooling (intake, leads, prompts, autoposter, analytics, drip campaigns,
// SOL tracking, etc.) that attorneys and paralegals don't need for their
// case work. Attorneys use hearing notes + client profiles + the triage
// dashboard as their entry points; they don't need the ops panel.
//
// Non-admins hitting /admin/ (the old operational dashboard) are redirected
// to /admin/dashboard (the triage view) instead of seeing an Access Denied
// page, since /admin/ is the "root" that users might land on by default.
app.get("/admin/", (req, res, next) => {
  if (req.user && req.user.r !== "admin") {
    return res.redirect("/admin/dashboard");
  }
  next();
});

app.use("/admin/matters", auth.requireRole("admin"), matterManagerRouter);
// NOTE: The role gate that used to be here has moved INSIDE adminRouter itself
// (see admin.js). Applying requireRole("admin") on the mount blocked EVERY /admin/*
// request from non-admins because Express runs mount middleware before route
// matching — even routes handled by app.get() later in this file never fired.
app.use("/admin", adminRouter);
app.get("/admin", (req, res) => res.redirect("/admin/"));

// ──────────────────────────────────────────────────────────────
//  SENDGRID INBOUND-EMAIL WEBHOOK (auto-ingest)
//
//  How it works:
//    1. SendGrid forwards every email arriving at *@inbound.tezlawfirm.com
//       to this URL via POST multipart/form-data.
//    2. The URL itself contains a long secret (env var INBOUND_WEBHOOK_SECRET).
//       Anyone hitting the URL without the right secret gets 401. Equivalent
//       to a shared-secret bearer token but encoded in the path so SendGrid
//       doesn't need custom-header support.
//    3. We check the sender domain against an allowlist (court / gov senders
//       and your own address). Everything else gets logged and dropped.
//    4. We dedup against the Message-ID header — same email forwarded twice
//       doesn't create duplicate proposals.
//    5. We pass the email body to ingestEmailText() which creates proposals
//       in the existing inbox queue. You review and accept manually. NEVER
//       auto-creates matters or deadlines.
//    6. If parsing fails, we file a "raw" proposal so the email is at
//       least visible in your inbox for manual review.
//    7. Every webhook hit (accepted or rejected) is logged to inbound_email_log
//       for debugging and abuse forensics.
//
//  Setup checklist (you do these on your side):
//    [ ] Generate INBOUND_WEBHOOK_SECRET env var (32+ random hex chars)
//    [ ] Add MX record on tezlawfirm.com pointing inbound.tezlawfirm.com → mx.sendgrid.net
//    [ ] In SendGrid Inbound Parse settings, point inbound.tezlawfirm.com →
//        https://tezlaw-bot.onrender.com/webhook/inbound-email/{SECRET}
//    [ ] Forward a court email to dockets@inbound.tezlawfirm.com to test
// ──────────────────────────────────────────────────────────────

// Sender allowlist — only emails FROM these domains/addresses are accepted.
// Wildcard prefix '*@' = any user at that domain.
const INBOUND_SENDER_ALLOWLIST = [
  "*@uscourts.gov",
  "*@usdoj.gov",
  "*@uspto.gov",
  "*@dhs.gov",
  "*@ice.dhs.gov",
  "*@cbp.dhs.gov",
  "*@uscis.dhs.gov",
  "*@ecf.ca9.uscourts.gov",
  "*@ecf.cacd.uscourts.gov",
  "*@ecf.cand.uscourts.gov",
  "*@ecf.casd.uscourts.gov",
  "*@ecf.caed.uscourts.gov",
  // SendGrid sometimes wraps via subdomain; allow forwarded items from your own address
  "jj@tezlawfirm.com"
];

function senderAllowed(fromAddr) {
  if (!fromAddr) return false;
  const addr = String(fromAddr).toLowerCase().trim();
  // Pull the actual email out of "Name <addr@example.com>" if needed
  const m = addr.match(/<([^>]+)>/);
  const cleanAddr = (m ? m[1] : addr).trim();
  for (const rule of INBOUND_SENDER_ALLOWLIST) {
    if (rule.startsWith("*@")) {
      const domain = rule.slice(2);
      if (cleanAddr.endsWith("@" + domain)) return true;
    } else if (rule.toLowerCase() === cleanAddr) {
      return true;
    }
  }
  return false;
}

// Find which user owns the inbound flow. v1 = single-user (JJ).
// Matches the same lookup used by getCurrentUserId() in matter-manager.js
// so the auto-ingest pipeline writes proposals to the same user as paste-ingest.
async function getInboundOwnerUserId() {
  try {
    const r = await db.query(
      `SELECT id FROM users WHERE username = 'jj' LIMIT 1`
    );
    return r.rows[0]?.id || null;
  } catch {
    return null;
  }
}

// Log every webhook attempt for forensics
async function logInbound(fields, outcome, reason, proposalId) {
  try {
    await db.query(
      `INSERT INTO inbound_email_log
        (from_email, to_email, subject, message_id, outcome, reason, proposal_id, body_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        (fields.from || "").substring(0, 300),
        (fields.to || "").substring(0, 300),
        (fields.subject || "").substring(0, 500),
        (fields.messageId || "").substring(0, 500),
        outcome,
        reason ? String(reason).substring(0, 2000) : null,
        proposalId,
        fields.bodySize || 0
      ]
    );
  } catch (err) {
    console.error("logInbound error:", err.message);
  }
}

app.post("/webhook/inbound-email/:secret", sendgridUpload.any(), async (req, res) => {
  // ── Step 1: Secret check (path-token auth) ──
  const expected = process.env.INBOUND_WEBHOOK_SECRET;
  if (!expected || expected.length < 16) {
    console.error("INBOUND_WEBHOOK_SECRET not set or too short");
    return res.status(500).send("Server not configured");
  }
  if (req.params.secret !== expected) {
    // Don't log the secret attempted; just count the rejection
    console.warn("Inbound webhook: bad secret from", req.ip);
    return res.status(401).send("unauthorized");
  }

  // ── Step 2: Pull fields from SendGrid multipart form ──
  // SendGrid sends these keys when "Send Raw, full MIME message" is OFF:
  //   from, to, subject, text, html, attachments, charsets, envelope, dkim, SPF, headers
  // We use `text` (plain-text body) per Q5 in the planning conversation.
  const fields = {
    from:      req.body?.from      || "",
    to:        req.body?.to        || "",
    subject:   req.body?.subject   || "",
    text:      req.body?.text      || req.body?.html || "",
    headers:   req.body?.headers   || "",
    envelope:  req.body?.envelope  || "",
    bodySize:  (req.body?.text || "").length
  };

  // Extract Message-ID from headers blob if present
  // Headers come as one big string: "Header-Name: value\r\nHeader-Name: value\r\n..."
  let messageId = null;
  const midMatch = fields.headers.match(/^Message-ID:\s*(<[^>]+>|[^\r\n]+)/im);
  if (midMatch) messageId = midMatch[1].trim();
  fields.messageId = messageId;

  // ── Step 3: Sender allowlist ──
  if (!senderAllowed(fields.from)) {
    await logInbound(fields, "rejected_sender", `From not on allowlist: ${fields.from}`, null);
    // Return 200 so SendGrid doesn't retry. Email is silently dropped — that's intentional.
    return res.status(200).send("dropped: sender not allowed");
  }

  // ── Step 4: Body validation ──
  if (!fields.text || fields.text.length < 20) {
    await logInbound(fields, "rejected_empty", "Body too short or missing", null);
    return res.status(200).send("dropped: empty body");
  }

  // ── Step 4.5: Extract PDF attachments ──
  // SendGrid sends attachments as fields named attachment1, attachment2, etc.,
  // each containing the binary file. multer.any() puts these in req.files.
  // We extract text from each PDF and append it to fields.text so the parser
  // sees both the email body AND the PDF contents in one combined input.
  let pdfsExtracted = 0;
  let pdfChars = 0;
  if (Array.isArray(req.files) && req.files.length > 0) {
    const pdfTexts = [];
    for (const file of req.files) {
      // SendGrid prepends "attachment" to all attachment field names. Filter to PDFs.
      const isPdf = (file.mimetype === "application/pdf") ||
                    (file.originalname && file.originalname.toLowerCase().endsWith(".pdf"));
      if (!isPdf) continue;
      const text = await extractPdfText(file.buffer, file.originalname || file.fieldname);
      if (text && text.length > 20) {
        pdfTexts.push(`\n\n--- PDF ATTACHMENT: ${file.originalname || file.fieldname} ---\n${text}`);
        pdfsExtracted++;
        pdfChars += text.length;
      }
    }
    if (pdfTexts.length > 0) {
      fields.text = fields.text + pdfTexts.join("");
      fields.bodySize = fields.text.length;
      console.log(`Inbound webhook: extracted ${pdfsExtracted} PDF(s), +${pdfChars} chars`);
    }
  }

  // ── Step 5: Resolve owner ──
  const userId = await getInboundOwnerUserId();
  if (!userId) {
    await logInbound(fields, "rejected_auth", "No owner user found", null);
    return res.status(500).send("server: owner unresolved");
  }

  // ── Step 6: Run the shared ingest pipeline ──
  // Source-ref encodes useful provenance: "From X · Subject: Y" so you can see at a glance where it came from
  const sourceRef = `email · From ${fields.from} · ${fields.subject || "(no subject)"}`;
  let result;
  try {
    result = await ingestEmailText(userId, fields.text, {
      source: "email_inbound",
      source_ref: sourceRef,
      message_id: messageId
    });
  } catch (err) {
    console.error("Inbound webhook ingest error:", err.message);
    await logInbound(fields, "parser_error", err.message, null);
    // 200 so SendGrid doesn't retry; we have the audit log
    return res.status(200).send("error: parser failed");
  }

  // ── Step 7: Handle outcomes ──
  if (!result.ok) {
    await logInbound(fields, "parser_error", result.error, null);
    return res.status(200).send(`error: ${result.error}`);
  }

  if (result.duplicate) {
    await logInbound(fields, "rejected_duplicate", `Already ingested as proposal ${result.existing_proposal_id}`, result.existing_proposal_id);
    return res.status(200).send("dropped: duplicate");
  }

  // If parsers ran but produced zero proposals, file a "raw" proposal so the
  // email isn't lost — you can still see and manually action it in the inbox.
  let firstProposalId = result.proposals?.[0]?.id || null;
  if (result.proposals.length === 0 || result.parser_failed) {
    try {
      const ins = await db.query(
        `INSERT INTO matter_proposals
           (user_id, kind, source, source_ref, proposed_data, raw_excerpt, status, confidence, message_id)
         VALUES ($1, 'new_matter', 'email_inbound', $2, $3, $4, 'pending', 'low', $5)
         RETURNING id`,
        [
          userId,
          sourceRef,
          JSON.stringify({
            _raw: true,
            _note: "Parser produced no structured fields — review email body manually.",
            subject: fields.subject,
            from: fields.from
          }),
          fields.text.substring(0, 4000),
          messageId
        ]
      );
      firstProposalId = ins.rows[0]?.id || firstProposalId;
      await logInbound(fields, "accepted_raw", "Filed as raw proposal for manual review", firstProposalId);
    } catch (err) {
      console.error("Raw proposal insert error:", err.message);
      await logInbound(fields, "parser_error", `Raw insert failed: ${err.message}`, null);
    }
  } else {
    await logInbound(
      fields,
      "accepted_parsed",
      `Created ${result.proposals.length} proposal(s); matter_matched=${result.summary?.matter_matched || "none"}`,
      firstProposalId
    );
  }

  return res.status(200).send("ok");
});

// Admin-side: simple log viewer so you can debug "why didn't that email land in my inbox?"
app.get("/admin/inbound-log", async (req, res) => {
  // Hooked into admin auth via cookie — same gate as admin panel
  const isAdmin = req.cookies && req.cookies.admin_auth === process.env.ADMIN_PASSWORD;
  if (!isAdmin) return res.status(401).send("unauthorized");
  try {
    const r = await db.query(
      `SELECT id, received_at, from_email, to_email, subject, outcome, reason, proposal_id, body_size
         FROM inbound_email_log
        ORDER BY received_at DESC
        LIMIT 100`
    );
    res.json({ entries: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Calendar .ics feed (top-level, secret-protected, no admin session) ──
// Outlook/Google Calendar fetch this URL on a refresh interval without
// cookies. Authenticated by the per-user calendar_secret in the URL path.
// Do NOT move this under /admin — it would break Outlook/Google subscriptions.
app.get("/calendar/:secret", handleCalendarFeed);

// ── Environment variables ─────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  // Telegram
  TELEGRAM_TOKEN,
  TEAM_TELEGRAM_CHAT_ID,
  // WhatsApp / Messenger
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,
  PAGE_ID,
  // WeChat
  WECHAT_TOKEN,
  WECHAT_APP_ID,
  WECHAT_APP_SECRET,
  OPENAI_API_KEY,
  // WordPress auto-poster
  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,
  // Gmail
  GMAIL_EMAIL,
  GMAIL_APP_PASSWORD,
  // Render
  RENDER_EXTERNAL_URL,
  PORT = 3000,
  // Legal Intelligence
  COURTLISTENER_TOKEN,
  TRELLIS_API_KEY,
  JJ_TELEGRAM_ID,
} = process.env;

console.log("ANTHROPIC_API_KEY:", !!ANTHROPIC_API_KEY);
console.log("TELEGRAM_TOKEN:", !!TELEGRAM_TOKEN);
console.log("WHATSAPP_TOKEN:", !!WHATSAPP_TOKEN);
console.log("WECHAT_APP_ID:", !!WECHAT_APP_ID);
console.log("COURTLISTENER_TOKEN:", !!COURTLISTENER_TOKEN);
console.log("TRELLIS_API_KEY:", !!TRELLIS_API_KEY);
console.log("JJ_TELEGRAM_ID:", !!JJ_TELEGRAM_ID);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const CACHE_FILE   = process.env.CACHE_PATH || "/var/data/legal_cache.json";

// ── System prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `Your name is Zara. You are a warm, friendly legal assistant for Tez Law P.C. in West Covina, California.

============================
THE TEAM
============================

JJ ZHANG — Managing Attorney
- Phone: 626-678-8677
- Email: jj@tezlawfirm.com

JUE WANG — Paralegal (immigration filings & USCIS matters)
- Email: jue.wang@tezlawfirm.com

MICHAEL LIU — Paralegal (immigration court support & motions)
- Email: michael.liu@tezlawfirm.com

LIN MEI — Paralegal (personal injury & state court filings)
- Email: lin.mei@tezlawfirm.com

============================
CONVERSATION STYLE — CRITICAL
============================

You are having a REAL conversation, not writing a legal document.

RULES:
- Keep responses SHORT. 2-4 sentences max for most replies.
- Ask ONE question at a time. Never ask two questions in one message.
- Be casual and warm. Like texting a knowledgeable friend.
- No bullet points unless absolutely necessary.
- No long lists. No headers. No walls of text.
- Respond in whatever language the person writes in (English, Spanish, Chinese).
- When someone tells you their problem, acknowledge it FIRST before asking anything.
- Only ask for more info if you genuinely need it to help them.

URGENT SITUATIONS (ICE detention, NTA, court date, serious accident):
Keep it short and direct. Give the phone number immediately.
Example: "That's urgent — please call us right now at 626-678-8677."

============================
WHAT YOU KNOW
============================

IMMIGRATION (USCIS → Jue Wang | Court → Michael Liu):
- Green cards: family (I-130), employment (EB-1 to EB-5), humanitarian (asylum, VAWA, U-visa)
- Processing times (2026): Marriage green card ~8-10 months. Naturalization ~5.5 months. EAD ~2 months.
- DACA: renewals only, renew 180 days before expiration
- ICE detention: URGENT — call 626-678-8677, locate via 1-888-351-4024, don't sign anything
- NTA: URGENT — doesn't mean automatic deportation, contact Michael Liu immediately
- Overstay bars: 180 days = 3-year bar; 1+ year = 10-year bar
- H-1B: specialty work visa, 85,000 spots/year, wage-based lottery
- California: AB 60 driver's license for undocumented, SB 54 limits local ICE cooperation

CAR ACCIDENTS (→ Lin Mei: lin.mei@tezlawfirm.com):
- After accident: call 911, get medical attention, document everything, don't admit fault
- Deadlines: personal injury 2 years; government vehicle only 6 MONTHS
- Contingency fee: 33.3% pre-lawsuit, 40% at trial — no upfront cost
- Partial fault: California pure comparative negligence — you can still recover

BUSINESS LITIGATION (→ JJ Zhang):
- Non-competes: VOID in California
- Trade secret theft: act fast, TRO available, 3 years from discovery
- Got served: 30 days to respond, preserve all documents

PATENTS & TRADEMARKS (→ JJ Zhang):
- Trademark: 8-12 months, $350/class USPTO fee
- Utility patent: 20 years, $10,000-$30,000+ total

ESTATE PLANNING (→ JJ Zhang):
- Living trust avoids probate — an $800K West Covina home = $36,000+ in probate fees
- Trust packages: $1,500-$3,000 individual, $2,500-$5,000 couple
- No California estate tax; federal exemption $13.99M in 2025

============================
CASE STATUS QUESTIONS
============================
If anyone asks about case status, hearing dates, USCIS receipts — DO NOT look it up. Instead:
1. Acknowledge warmly
2. Flag it for the team
3. Ask for name + contact
4. Reassure someone will follow up

============================
GENERAL AI ASSISTANT
============================
You are also a helpful general AI assistant. Help with non-legal questions too — nearby places, translations, general knowledge. Be a smart, helpful friend first.

============================
DISTRESS DETECTION — CRITICAL
============================
HIGH URGENCY: ICE, detained, arrested, deportation, NTA, accident just happened, injured, scared, please help, court tomorrow
MEDIUM URGENCY: visa expired, out of status, denied, worried, desperate

For HIGH URGENCY: acknowledge warmly, give 626-678-8677, tell them NOT to sign anything.

============================
VOICE CAPABILITIES
============================
You CAN send voice messages. When someone asks you to respond in voice, speak, or send audio:
- Just respond normally in text as usual
- The system automatically converts your text reply into a voice message and sends it
- NEVER say you cannot do voice or that you only communicate through text
- You have full voice capabilities on Telegram and WhatsApp`;

const WELCOME_MESSAGE = `Hi! 👋 I'm Zara, the virtual assistant for Tez Law P.C. in West Covina.

I'm here 24/7 to help with any legal questions — whether it's immigration, a car accident, estate planning, evictions, or business matters.

What brings you here today? Feel free to describe your situation and I'll point you in the right direction. 😊`;

const CONTACT_MESSAGE = `Here's the Tez Law P.C. team:

👨‍💼 JJ Zhang — Managing Attorney
📞 626-678-8677
📧 jj@tezlawfirm.com

📋 Jue Wang — Paralegal (immigration & USCIS)
📧 jue.wang@tezlawfirm.com

⚖️ Michael Liu — Paralegal (immigration court)
📧 michael.liu@tezlawfirm.com

🚗 Lin Mei — Paralegal (personal injury & state court)
📧 lin.mei@tezlawfirm.com

📍 West Covina, California`;

// ── Legal research cache ──────────────────────────────────
const CACHE_TTL = {
  statute: 30*24*60*60*1000, caselaw: 7*24*60*60*1000,
  policy: 7*24*60*60*1000, fees: 3*24*60*60*1000, general: 14*24*60*60*1000,
};
function detectCacheType(q) {
  q = q.toLowerCase();
  if (/processing time|fee|cost|how long/.test(q)) return "fees";
  if (/bia|case law|decision|matter of/.test(q)) return "caselaw";
  if (/policy|policy manual/.test(q)) return "policy";
  if (/ina|cfr|§|vehicle code|civil code|probate code|statute|section/.test(q)) return "statute";
  return "general";
}
function loadCache() { try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE,"utf8")) : {}; } catch(e) { return {}; } }
function saveCache(c) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c,null,2)); } catch(e) {} }
function getCacheKey(m) { return m.toLowerCase().trim().replace(/[^a-z0-9\s§]/g,"").replace(/\s+/g,"_").substring(0,100); }
function getCachedAnswer(m) {
  const c = loadCache(), k = getCacheKey(m), e = c[k];
  if (!e) return null;
  if (Date.now()-e.timestamp > CACHE_TTL[detectCacheType(m)]) return null;
  return e.answer;
}
function setCachedAnswer(m, a) {
  const c = loadCache(), k = getCacheKey(m);
  c[k] = { answer: a, timestamp: Date.now(), type: detectCacheType(m) };
  saveCache(c);
}
function isLegalResearchQuestion(m) {
  return /ina|cfr|§|statute|code|regulation|uscis|bia|eoir|removal|deportation|vehicle code|civil code|probate code|ccp|uspto|patent|trademark|processing time|filing fee|form i-|case law|matter of|what does|what is the law|is it legal|what are the requirements/i.test(m);
}

// ── Distress detection ────────────────────────────────────
function detectDistress(msg) {
  const t = msg.toLowerCase();

  // Use whole-word regex for short keywords that appear inside other words
  // e.g. "ice" inside "police", "raid" inside "afraid", "nta" inside "santa"
  function wholeWord(keyword) {
    return new RegExp("(?<![a-z])" + keyword.replace(/[-]/g, "\\-") + "(?![a-z])", "i").test(t);
  }

  // Keywords that need whole-word matching (short, risky substrings)
  const highWholeWord = ["ice","nta","raid","help me","scared","miedo"];
  // Keywords safe to substring match (long enough, unique enough)
  const highSubstring = ["detained","arrested","deportation","deported","removal",
    "notice to appear","they took","emergency","accident just happened","injured",
    "hospital","bleeding","please help","don\'t know what to do","court tomorrow",
    "hearing tomorrow","sign anything","拘留","被抓","遣返","紧急","帮我","害怕",
    "detenido","arrestado","deportación","ayúdame"];
  const med = ["visa expired","status expired","out of status","denied",
    "lost my job","fired","separated","family separated","worried","desperate","no options"];

  const highMatch = highWholeWord.some(k => wholeWord(k)) || highSubstring.some(k => t.includes(k));
  if (highMatch) return "high";
  if (med.some(k => t.includes(k))) return "medium";
  return "none";
}

async function notifyDistress(userId, message, urgency, platform) {
  if (!TEAM_TELEGRAM_CHAT_ID || !TELEGRAM_TOKEN) return;
  // Never forward JJ's private messages to the team
  if (isJJAuthenticated(platform, userId)) return;
  const emoji = urgency === "high" ? "🚨" : "⚠️";
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TEAM_TELEGRAM_CHAT_ID,
      text: `${emoji} ${urgency.toUpperCase()} — ${platform}\n\n"${message.substring(0,200)}"\n\nFollow up immediately! 📞 626-678-8677`
    });
  } catch(e) { console.error("Distress notify error:", e.message); }
}

async function notifyLead(userId, message, platform) {
  if (!TEAM_TELEGRAM_CHAT_ID || !TELEGRAM_TOKEN) return;
  // Never forward JJ's private messages to the team
  if (isJJAuthenticated(platform, userId)) return;
  const phoneMatch = message.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
  const emailMatch = message.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (!phoneMatch && !emailMatch) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TEAM_TELEGRAM_CHAT_ID,
      text: `🆕 New Lead from ${platform}!\n\n${phoneMatch ? `📞 ${phoneMatch[0]}\n` : ""}${emailMatch ? `📧 ${emailMatch[0]}\n` : ""}\nClient: ${userId}`
    });
  } catch(e) { console.error("Lead notify error:", e.message); }
}

// ── Shared message processor ──────────────────────────────
async function processMessage(platform, userId, userText, sendFn) {
  // Proactive greeting for brand new users on their very first message ever
  try {
    const hist = await getHistory(platform, userId);
    if (hist.length === 0) {
      await sendFn(WELCOME_MESSAGE);
      await new Promise(r => setTimeout(r, 600));
    }
  } catch(e) { /* non-fatal — continue */ }

  const lower = userText.toLowerCase().trim();

  // ── OWNER CHECK: never treat JJ as a client ──────────────
  // When JJ is authenticated, skip ALL client shortcuts and notifications.
  // Every message goes straight to askClaudeWithMemory → checkJJMode.
  if (!isJJAuthenticated(platform, userId)) {
    if (["hi","hello","hey","hola","start","你好"].includes(lower)) {
      await sendFn(WELCOME_MESSAGE); return;
    }
    if (["contact","team","contacto"].includes(lower)) {
      await sendFn(CONTACT_MESSAGE); return;
    }
    if (lower === "reset") {
      await clearHistory(platform, userId);
      await sendFn("Fresh start! What can I help you with? 😊"); return;
    }
  }

  const livePrompt = buildLivePrompt(app, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
  const reply = await askClaudeWithMemory(platform, userId, userText, livePrompt, {
    sendProgress: sendFn,
  });

  // Reply can be a string OR { text, attachment } — from /draft filling a .docx
  if (reply && typeof reply === "object" && reply.attachment) {
    await sendFn(reply.text || "");
    // Signal to caller (Telegram handler) that an attachment needs to be sent
    // by exposing it on sendFn if it supports it
    if (typeof sendFn._deliverAttachment === "function") {
      await sendFn._deliverAttachment(reply.attachment);
    }
  } else {
    await sendFn(typeof reply === "string" ? reply : (reply?.text || ""));
  }

  // ── PRIVACY: never forward JJ's messages to the team ──
  if (isJJAuthenticated(platform, userId)) return;

  // ── Post-response hooks (non-blocking) ─────────────────
  const urgency = detectDistress(userText);
  Promise.allSettled([
    urgency !== "none" ? notifyDistress(userId, userText, urgency, platform) : Promise.resolve(),
    notifyLead(userId, userText, platform),
    checkCompliance(platform, userId, userText, reply, sendFn),
  ]).catch(() => {});
}

// ────────────────────────────────────────────────────────────
//  TELEGRAM
// ────────────────────────────────────────────────────────────
async function tgSend(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text });
}
async function tgDownloadFile(fileId) {
  const r = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: fileId } });
  const path = r.data.result.file_path;
  const fr = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${path}`, { responseType: "arraybuffer" });
  return { buffer: Buffer.from(fr.data), extension: path.split(".").pop().toLowerCase() };
}

// Send a file attachment to a Telegram chat.
// attachment = { buffer, filename, mimeType }
async function tgSendDocument(chatId, attachment) {
  if (!attachment || !attachment.buffer) return;
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", attachment.buffer, {
    filename: attachment.filename || "document.docx",
    contentType: attachment.mimeType || "application/octet-stream",
  });
  try {
    await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (err) {
    console.error("[tgSendDocument] Error:", err.response?.data || err.message);
    await tgSend(chatId, "⚠️ I generated the file but couldn't send it. Try /draft again.");
  }
}

// Handle a reply that may be a string OR { text, attachment } from JJ /draft flow.
async function handleReplyOrAttachment(chatId, reply) {
  if (reply && typeof reply === "object" && reply.attachment) {
    if (reply.text) await tgSend(chatId, reply.text);
    await tgSendDocument(chatId, reply.attachment);
  } else if (typeof reply === "string") {
    await tgSend(chatId, reply);
  } else if (reply && reply.text) {
    await tgSend(chatId, reply.text);
  }
}

// ────────────────────────────────────────────────────────────
//  Daily deadline summary (Telegram, sent each morning at 7am PT)
//
//  Two parts:
//    1. CRITICAL THRESHOLDS HIT TODAY — IP deadlines (TM, Patent, Copyright)
//       that just crossed a 30/14/7/1-day threshold. Tracked in
//       matter_ip_reminders so each (deadline, threshold) only fires once.
//    2. Standard 14-day rolling summary (Overdue / Today / Week / Next Week).
//
//  Excludes archived matters and party='them' (informational) deadlines.
//  Restricted to JJ_TELEGRAM_ID.
// ────────────────────────────────────────────────────────────

// IP deadline reminder thresholds (Checkpoint 4)
// Standard 30/14/7/1 for most IP deadlines.
// Patent issue fee gets the 3-day touch because it's non-extendable.
const IP_REMINDER_THRESHOLDS = [30, 14, 7, 1];
const PATENT_ISSUE_FEE_THRESHOLDS = [30, 14, 7, 3, 1];
// EOIR hearings: 60/30/14 — wider lead time but no aggressive ramp.
// (Per JJ preference 2026-05-27 — daily summary still surfaces hearings in
// the 14-day rolling window, so no risk of going silent close to hearing.)
const HEARING_THRESHOLDS = [60, 30, 14];

// Identify whether a deadline should get threshold reminders.
// Returns an array of threshold days (smallest fires first), or null if no reminders.
//
// Trigger rules:
//   - EOIR hearings → HEARING_THRESHOLDS (60/30/14)
//     Detection: case_type='Removal' AND party='court' AND title contains 'hearing',
//     OR title produced by the EOIR parser (Master / Individual / Bond / Immigration).
//     Non-EOIR court hearings (9th Cir oral argument, district court hearings, etc.)
//     get NO threshold reminders — daily summary covers them.
//   - IP matter + patent issue fee → PATENT_ISSUE_FEE_THRESHOLDS (30/14/7/3/1)
//   - IP matter (TM/Patent/Copyright) → IP_REMINDER_THRESHOLDS (30/14/7/1)
//   - Everything else → null (no threshold reminders; standard daily summary still covers it)
function thresholdsForDeadline(caseType, title, party) {
  const lowerTitle = (title || "").toLowerCase();
  // EOIR hearings — recognized either by case_type or by the title strings
  // the EOIR parser produces.
  const isEoirHearing =
    party === "court" && lowerTitle.includes("hearing") && (
      caseType === "Removal" ||
      lowerTitle.includes("master calendar") ||
      lowerTitle.includes("individual hearing") ||
      lowerTitle.includes("bond hearing") ||
      lowerTitle.includes("immigration hearing") ||
      lowerTitle.includes("immigration court")
    );
  if (isEoirHearing) {
    return HEARING_THRESHOLDS;
  }
  // IP-specific reminders
  if (!["Trademark", "Patent", "Copyright"].includes(caseType)) return null;
  if (lowerTitle.includes("issue fee") && caseType === "Patent") {
    return PATENT_ISSUE_FEE_THRESHOLDS;
  }
  return IP_REMINDER_THRESHOLDS;
}

async function sendDailyDeadlineSummary() {
  if (!JJ_TELEGRAM_ID) {
    console.log("Daily summary skipped — JJ_TELEGRAM_ID not set");
    return;
  }
  const db = require("./db");

  // Anchor "today" in Pacific time. We compare YYYY-MM-DD strings,
  // which avoids JS Date timezone confusion when matched against
  // the DATE-typed due_date column.
  const now = new Date();
  const ptFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  const todayStr = ptFmt.format(now); // YYYY-MM-DD in PT

  // 7 days from now and 14 days, computed in PT
  function addDaysPT(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return ptFmt.format(dt);
  }
  const in7Str  = addDaysPT(todayStr, 7);
  const in14Str = addDaysPT(todayStr, 14);
  const in30Str = addDaysPT(todayStr, 30);

  // Helper: compute days between two YYYY-MM-DD strings (PT-anchored).
  function daysBetween(fromStr, toStr) {
    const [fy, fm, fd] = fromStr.split("-").map(Number);
    const [ty, tm, td] = toStr.split("-").map(Number);
    const f = Date.UTC(fy, fm - 1, fd);
    const t = Date.UTC(ty, tm - 1, td);
    return Math.round((t - f) / 86400000);
  }

  // ─────────────────────────────────────────────────────────
  //  PART 1: Critical IP threshold check
  //  Find IP deadlines whose days-until matches a threshold AND we
  //  haven't already sent a reminder for that (deadline, threshold).
  // ─────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────
  //  PART 1: Critical threshold check
  //  Finds:
  //   - IP deadlines (TM/Patent/Copyright) with us-party
  //   - Immigration/litigation hearings (court-party, "hearing" in title)
  //  Tracks each (deadline, threshold) in matter_ip_reminders so we
  //  don't re-fire. The table name keeps "ip" for legacy reasons; it
  //  now covers both IP and hearing thresholds.
  //  Pulls in up to 60 days out so hearing 60-day threshold can fire.
  // ─────────────────────────────────────────────────────────
  const in60Str = addDaysPT(todayStr, 60);
  let ipRows = [];
  try {
    const r = await db.query(
      `SELECT d.id, d.title, d.party, d.due_date, d.citation,
              m.client_name, m.matter_ref, m.case_type, m.id AS matter_id, m.mark
         FROM matter_deadlines d
         JOIN matters m ON m.id = d.matter_id
        WHERE d.completed = FALSE
          AND m.status = 'active'
          AND d.due_date IS NOT NULL
          AND d.due_date::date >= $1::date
          AND d.due_date::date <= $2::date
          AND (
            -- IP us-party deadlines
            (m.case_type IN ('Trademark', 'Patent', 'Copyright') AND (d.party IS NULL OR d.party = 'us'))
            OR
            -- Court-party hearings (any matter type)
            (d.party = 'court' AND LOWER(d.title) LIKE '%hearing%')
          )`,
      [todayStr, in60Str]
    );
    ipRows = r.rows;
  } catch (err) {
    console.error("sendDailyDeadlineSummary threshold query error:", err.message);
    // Continue — we can still send the standard summary
  }

  // For each deadline, check if today crosses (or just crossed) any threshold
  // and we haven't sent that reminder before. Insert tracker row + push to alerts.
  const criticalAlerts = [];
  for (const row of ipRows) {
    const dueStr = String(row.due_date).slice(0, 10);
    const daysLeft = daysBetween(todayStr, dueStr);
    if (daysLeft < 0) continue; // shouldn't happen given query, but safe

    const thresholds = thresholdsForDeadline(row.case_type, row.title, row.party);
    if (!thresholds) continue;

    // Determine the SMALLEST threshold that's been crossed but not yet fired.
    // Crossed = daysLeft <= threshold. We fire the smallest such threshold first
    // so we don't double-alert (e.g. firing 30+14+7+1 all at once for a deadline
    // that's been ignored for a month). Tracker prevents re-firing same threshold.
    let firedThreshold = null;
    for (const threshold of thresholds.slice().sort((a, b) => a - b)) {
      if (daysLeft > threshold) continue;
      // Check if we've already sent THIS threshold for THIS deadline
      let alreadySent = false;
      try {
        const r2 = await db.query(
          `SELECT 1 FROM matter_ip_reminders
            WHERE deadline_id = $1 AND days_out = $2
            LIMIT 1`,
          [row.id, threshold]
        );
        alreadySent = r2.rows.length > 0;
      } catch (err) {
        console.error("matter_ip_reminders lookup error:", err.message);
        alreadySent = true; // fail-safe: don't spam if DB is broken
      }
      if (!alreadySent) {
        firedThreshold = threshold;
        break; // fire smallest unsent threshold; stop here
      }
    }

    if (firedThreshold !== null) {
      // Record the reminder BEFORE we add to outgoing alerts so a Telegram-send
      // failure doesn't cause re-fire next day. Worst case: we logged but failed
      // to send — you'll catch the deadline in the next day's standard summary.
      try {
        await db.query(
          `INSERT INTO matter_ip_reminders (matter_id, deadline_id, days_out)
           VALUES ($1, $2, $3)
           ON CONFLICT (deadline_id, days_out) DO NOTHING`,
          [row.matter_id, row.id, firedThreshold]
        );
      } catch (err) {
        console.error("matter_ip_reminders insert error:", err.message);
        continue; // skip this alert; don't risk double-firing
      }
      criticalAlerts.push({ row, daysLeft, threshold: firedThreshold });
    }
  }

  // ─────────────────────────────────────────────────────────
  //  PART 2: Standard 14-day rolling summary (unchanged from before)
  // ─────────────────────────────────────────────────────────
  let rows;
  try {
    const r = await db.query(
      `SELECT d.id, d.title, d.party, d.due_date, d.citation,
              m.client_name, m.matter_ref, m.id AS matter_id
         FROM matter_deadlines d
         JOIN matters m ON m.id = d.matter_id
        WHERE d.completed = FALSE
          AND m.status = 'active'
          AND d.due_date IS NOT NULL
          AND d.due_date::date <= $1::date
          AND (d.party IS NULL OR d.party <> 'them')
        ORDER BY d.due_date ASC, m.client_name ASC`,
      [in14Str]
    );
    rows = r.rows;
  } catch (err) {
    console.error("sendDailyDeadlineSummary query error:", err.message);
    return;
  }

  // Bucket each row
  const overdue = [];
  const today   = [];
  const week    = [];
  const next    = [];
  for (const row of rows) {
    const due = String(row.due_date).slice(0, 10);
    if (due < todayStr) overdue.push(row);
    else if (due === todayStr) today.push(row);
    else if (due <= in7Str) week.push(row);
    else if (due <= in14Str) next.push(row);
  }

  // Format the message
  const dateLabel = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long", month: "long", day: "numeric"
  });

  let msg = `📅 Daily Deadlines — ${dateLabel}\n`;

  function fmtRow(r) {
    const due = String(r.due_date).slice(0, 10);
    const [y, m, d] = due.split("-");
    const mmdd = `${parseInt(m)}/${parseInt(d)}`;
    const partyTag = r.party === "us" ? "[us]"
                   : r.party === "them" ? "[gov]"
                   : "[ct]";
    const caption = (r.client_name || "Unknown").substring(0, 30);
    const title   = (r.title || "Untitled").substring(0, 60);
    return `   • ${mmdd} ${partyTag} ${caption} — ${title}`;
  }

  function fmtCritical(alert) {
    const { row, daysLeft, threshold } = alert;
    const caption = (row.mark || row.client_name || "Unknown").substring(0, 40);
    const title   = (row.title || "Untitled").substring(0, 80);
    const dayLabel = daysLeft === 0 ? "TODAY" :
                     daysLeft === 1 ? "TOMORROW" :
                     `in ${daysLeft} days`;
    return `   • ${title}\n     ${caption} · ${dayLabel} · ${threshold}-day threshold`;
  }

  // Critical alerts go FIRST — they're the most important
  if (criticalAlerts.length > 0) {
    msg += `\n🚨 CRITICAL THRESHOLDS HIT (${criticalAlerts.length})\n${criticalAlerts.map(fmtCritical).join("\n")}\n`;
  }

  if (overdue.length === 0 && today.length === 0 && week.length === 0 && next.length === 0) {
    if (criticalAlerts.length === 0) {
      msg += `\nAll clear — nothing due in the next 14 days.\n\n📖 https://tezlaw-bot.onrender.com/admin/matters/`;
    } else {
      msg += `\n(Nothing else due in next 14 days.)\n\n📖 https://tezlaw-bot.onrender.com/admin/matters/`;
    }
  } else {
    if (overdue.length) {
      msg += `\n🔴 OVERDUE (${overdue.length})\n${overdue.map(fmtRow).join("\n")}\n`;
    }
    if (today.length) {
      msg += `\n⚠️ TODAY (${today.length})\n${today.map(fmtRow).join("\n")}\n`;
    }
    if (week.length) {
      msg += `\n📌 THIS WEEK (${week.length})\n${week.map(fmtRow).join("\n")}\n`;
    }
    if (next.length) {
      msg += `\n📋 NEXT WEEK (${next.length})\n${next.map(fmtRow).join("\n")}\n`;
    }
    msg += `\n📖 https://tezlaw-bot.onrender.com/admin/matters/`;
  }

  try {
    await tgSend(String(JJ_TELEGRAM_ID), msg);
    console.log(`📅 Daily deadline summary sent — ${criticalAlerts.length} critical, ${overdue.length} overdue, ${today.length} today, ${week.length} this week, ${next.length} next week`);
  } catch (err) {
    console.error("Failed to send daily summary:", err.message);
  }
}

// ── Pending /deadline disambiguation map ──────────────────
// Key: chatId, Value: { matches[], title, dueDate, expiresAt }
const pendingDeadlines = new Map();

// Parse a date token into YYYY-MM-DD.
// Accepts: "8/3", "8/3/26", "8/3/2026", "2026-08-03", "8-3", "8-3-26".
// Defaults year to current year if missing. If date is already past
// today and only month/day given, bumps to next year.
function parseDateToken(token) {
  if (!token) return null;
  const t = token.trim();

  // Already YYYY-MM-DD
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  // M/D, M/D/YY, M/D/YYYY (or with dashes)
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const mo = parseInt(m[1]);
    const d  = parseInt(m[2]);
    let y;
    if (m[3]) {
      y = parseInt(m[3]);
      if (y < 100) y += 2000;
    } else {
      // Default to current year in PT
      const now = new Date();
      const ptYear = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric" }).format(now);
      y = parseInt(ptYear);
      // If the resulting date is already in the past, bump to next year
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const candidate = `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      if (candidate < today) y += 1;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  return null;
}

// Handle `/deadline ...` from JJ. Parses last token as date,
// first token as matter search, middle as title.
async function handleDeadlineCommand(chatId, text) {
  const db = require("./db");

  // Strip leading "/deadline"
  const rest = text.replace(/^\/deadline\s*/i, "").trim();

  if (!rest || rest === "cancel") {
    if (pendingDeadlines.has(chatId)) {
      pendingDeadlines.delete(chatId);
      await tgSend(chatId, "✕ Pending /deadline cancelled.");
    } else {
      await tgSend(chatId,
        "Usage: /deadline <matter> <title> <date>\n" +
        "Example: /deadline Lu opening brief 8/3\n" +
        "Dates: M/D, M/D/YY, M/D/YYYY, YYYY-MM-DD"
      );
    }
    return;
  }

  // Split on whitespace, isolate last token as date
  const parts = rest.split(/\s+/);
  if (parts.length < 3) {
    await tgSend(chatId, "Need at least: <matter> <title> <date>. Example: /deadline Lu opening brief 8/3");
    return;
  }
  const dateToken = parts[parts.length - 1];
  const dueDate = parseDateToken(dateToken);
  if (!dueDate) {
    await tgSend(chatId, `❌ Couldn't parse "${dateToken}" as a date. Try: M/D, M/D/YYYY, or YYYY-MM-DD`);
    return;
  }
  const matterSearch = parts[0];
  const title = parts.slice(1, -1).join(" ").trim();
  if (!title) {
    await tgSend(chatId, "❌ Need a title between matter and date. Example: /deadline Lu opening brief 8/3");
    return;
  }

  // Find matching matters for JJ (user_id 1)
  let matches;
  try {
    const r = await db.query(
      `SELECT id, client_name, matter_ref FROM matters
        WHERE user_id = 1 AND status = 'active'
          AND (client_name ILIKE $1 OR matter_ref ILIKE $1 OR petitioner_name ILIKE $1)
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 10`,
      [`%${matterSearch}%`]
    );
    matches = r.rows;
  } catch (err) {
    console.error("/deadline matter search error:", err.message);
    await tgSend(chatId, "❌ Database error. Try again.");
    return;
  }

  if (matches.length === 0) {
    await tgSend(chatId, `❌ No active matter found matching "${matterSearch}".`);
    return;
  }

  if (matches.length === 1) {
    await insertDeadlineFromCommand(chatId, matches[0], title, dueDate);
    return;
  }

  // Multiple matches → ask user to pick a number
  pendingDeadlines.set(chatId, {
    matches, title, dueDate,
    expiresAt: Date.now() + 5 * 60 * 1000 // 5 min
  });
  let msg = `Multiple matters matched "${matterSearch}". Reply with a number:\n\n`;
  matches.forEach((m, i) => {
    msg += `${i + 1}. ${m.client_name}${m.matter_ref ? " — " + m.matter_ref : ""}\n`;
  });
  msg += `\n(or /deadline cancel)`;
  await tgSend(chatId, msg);
}

async function resolveDeadlineChoice(chatId, choice, pending) {
  if (choice < 1 || choice > pending.matches.length) {
    await tgSend(chatId, `❌ Choose 1–${pending.matches.length}.`);
    return;
  }
  pendingDeadlines.delete(chatId);
  const matter = pending.matches[choice - 1];
  await insertDeadlineFromCommand(chatId, matter, pending.title, pending.dueDate);
}

async function insertDeadlineFromCommand(chatId, matter, title, dueDate) {
  const db = require("./db");
  try {
    const r = await db.query(
      `INSERT INTO matter_deadlines (matter_id, title, citation, due_date, party, note, completed)
       VALUES ($1, $2, NULL, $3, 'us', NULL, FALSE)
       RETURNING id`,
      [matter.id, title, dueDate]
    );
    db.logAudit("jj", "create_deadline_telegram", `matter:${matter.id}/deadline:${r.rows[0].id}`,
                null, JSON.stringify({title, dueDate}), null).catch(() => {});
    const dateLabel = new Date(dueDate + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", year: "numeric"
    });
    await tgSend(chatId,
      `✅ Added to ${matter.client_name}:\n` +
      `   "${title}"\n` +
      `   Due ${dateLabel}\n\n` +
      `📖 https://tezlaw-bot.onrender.com/admin/matters/`
    );
  } catch (err) {
    console.error("insertDeadlineFromCommand error:", err.message);
    await tgSend(chatId, "❌ Couldn't save deadline. Try the web dashboard.");
  }
}

app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  // ── Admin panel auth callback ─────────────────────────
  if (update.callback_query) {
    const cb = update.callback_query;
    if (cb.data?.startsWith("admin_")) {
      const result = await handleAdminCallback(cb.data, cb.id);
      if (result) {
        axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: cb.id,
          text: result.answer,
        }).catch(() => {});
      }
      return;
    }
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = String(msg.chat.id);
  const firstName = msg.from?.first_name || "there";

  try {
    // ── /chatid — utility command for setting up group chats ──
    // Works in DMs, groups, and channels. Returns the current chat's ID
    // so JJ can set env vars like HEARING_NOTES_TELEGRAM_GROUP_ID.
    const textForCmd = (msg.text || msg.caption || "").trim();
    if (/^\/chatid(@\w+)?\s*$/i.test(textForCmd)) {
      const chatType = msg.chat.type || "unknown"; // 'private', 'group', 'supergroup', 'channel'
      const chatTitle = msg.chat.title || "(no title)";
      const info =
        `📍 *Chat ID Info*\n\n` +
        `Chat ID: \`${chatId}\`\n` +
        `Type: ${chatType}\n` +
        (chatType !== "private" ? `Title: ${chatTitle}\n` : `From: ${firstName}\n`) +
        `\n_Copy the Chat ID above to use in env vars like_ \`HEARING_NOTES_TELEGRAM_GROUP_ID\`.`;
      await tgSend(chatId, info);
      return;
    }
    if (msg.photo) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const best = msg.photo[msg.photo.length-1];
      const { buffer, extension } = await tgDownloadFile(best.file_id);
      const mimeMap = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", gif:"image/gif", webp:"image/webp" };
      const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "Analyze this image.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), { isImage:true, imageData:buffer.toString("base64"), imageMediaType:mimeMap[extension]||"image/jpeg" });
      await tgSend(chatId, reply); return;
    }
    if (msg.document) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const { buffer } = await tgDownloadFile(msg.document.file_id);
      const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      if (msg.document.mime_type === "application/pdf") {
        const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "Analyze this PDF.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
          isPdf:true, pdfData:buffer.toString("base64"),
          sendProgress: (t) => tgSend(chatId, t),
        });
        await handleReplyOrAttachment(chatId, reply);
      } else if (msg.document.mime_type === docxMime ||
                 (msg.document.file_name && msg.document.file_name.toLowerCase().endsWith(".docx"))) {
        // DOCX — for /template add or /draft with facts doc
        const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
          isDocx:true, docxData:buffer.toString("base64"),
          sendProgress: (t) => tgSend(chatId, t),
        });
        await handleReplyOrAttachment(chatId, reply);
      } else {
        await tgSend(chatId, "I can read images, PDFs, and .docx files. Please resend in one of those formats.");
      }
      return;
    }
    if (msg.voice || msg.audio) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const { buffer } = await tgDownloadFile((msg.voice||msg.audio).file_id);
      const transcript = await transcribeAudio(buffer, "voice.ogg");
      if (!transcript) { await tgSend(chatId, "Sorry, I couldn't make out that voice message. Please type instead."); return; }
      await tgSend(chatId, `🎤 I heard: "${transcript}"\n\nLet me help...`);
      await processMessage("telegram", chatId, transcript, (t) => tgSend(chatId, t));
      return;
    }
    if (!msg.text) return;
    const text = msg.text;
    if (text === "/start") {
      await clearHistory("telegram", chatId);
      await tgSend(chatId, `Hi ${firstName}! ${WELCOME_MESSAGE}`); return;
    }
    if (text === "/contact") { await tgSend(chatId, CONTACT_MESSAGE); return; }
    if (text === "/reset") { await clearHistory("telegram", chatId); await tgSend(chatId, "✅ Reset! How can I help?"); return; }

    // ── Matter Manager commands (JJ-only) ─────────────────
    if (text === "/today" || text.startsWith("/deadline") || text === "/help_matters") {
      const isJJ = JJ_TELEGRAM_ID && String(chatId) === String(JJ_TELEGRAM_ID);
      if (!isJJ) {
        await tgSend(chatId, "Sorry, that command is restricted.");
        return;
      }
      if (text === "/today") {
        await sendDailyDeadlineSummary();
        return;
      }
      if (text === "/help_matters") {
        await tgSend(chatId,
          "📚 Matter Manager Commands\n\n" +
          "/today — Send today's deadline summary now\n" +
          "/deadline <matter> <title> <date>\n" +
          "   e.g. /deadline Lu opening brief 8/3\n" +
          "   Dates: M/D, M/D/YY, M/D/YYYY, YYYY-MM-DD\n" +
          "/deadline cancel — Cancel a pending command"
        );
        return;
      }
      // /deadline command
      await handleDeadlineCommand(chatId, text);
      return;
    }

    // If there's a pending /deadline disambiguation, treat a bare number as the choice
    if (pendingDeadlines.has(chatId) && /^\d+$/.test(text.trim())) {
      const pending = pendingDeadlines.get(chatId);
      if (Date.now() > pending.expiresAt) {
        pendingDeadlines.delete(chatId);
        await tgSend(chatId, "⏱️ That selection expired. Please re-run /deadline.");
        return;
      }
      await resolveDeadlineChoice(chatId, parseInt(text.trim()), pending);
      return;
    }

    // Send "thinking" message if Claude takes more than 5 seconds
    let thinkingMsg = null;
    const thinkingTimer = setTimeout(async () => {
      try {
        const r = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "🤔 Let me think about that for a moment..."
        });
        thinkingMsg = r.data.result?.message_id;
      } catch(e) {}
    }, 5000);

    await processMessage("telegram", chatId, text, Object.assign(async (t) => {
      lastTgReply = t;
      await tgSend(chatId, t);
    }, {
      _deliverAttachment: async (att) => { await tgSendDocument(chatId, att); },
    }));
    clearTimeout(thinkingTimer);

    // Delete the thinking message once real reply is sent
    if (thinkingMsg) {
      axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: thinkingMsg }).catch(() => {});
    }
    if (lastTgReply && isJJAuthenticated("telegram", chatId)) {
      sendVoiceReply("telegram", chatId, lastTgReply).catch(() => {});
    }
  } catch(err) {
    console.error("Telegram error:", err.message);
    try { await tgSend(chatId, "Sorry, technical issue. Call us: 626-678-8677"); } catch(e) {}
  }
});

// Telegram GET verification
app.get("/telegram", (req, res) => res.send("Telegram webhook active"));

// ────────────────────────────────────────────────────────────
//  WHATSAPP + MESSENGER
// ────────────────────────────────────────────────────────────
async function waSend(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body: text }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
  } catch(e) {
    // 400 = invalid recipient or status webhook — ignore silently
    if (e.response?.status === 400) return;
    throw e;
  }
}
async function msgrSend(recipientId, text) {
  await axios.post(`https://graph.facebook.com/v18.0/${PAGE_ID}/messages`, {
    recipient: { id: recipientId }, message: { text }
  }, { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" } });
}
async function waDownloadMedia(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const file = await axios.get(meta.data.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: "arraybuffer" });
  return { buffer: Buffer.from(file.data), mimeType: meta.data.mime_type };
}

// Upload a media file to WhatsApp's Cloud API. Returns the media_id which
// can then be referenced in a sendMessage document call.
// WhatsApp requires 2-step upload: first upload media to get an ID,
// then send a message referencing that media_id.
async function waUploadMedia(buffer, filename, mimeType) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", buffer, { filename, contentType: mimeType });

  const uploadResp = await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );
  return uploadResp.data.id;
}

// Send a file attachment to a WhatsApp chat.
// attachment = { buffer, filename, mimeType }
async function waSendDocument(to, attachment) {
  if (!attachment || !attachment.buffer) return;
  try {
    const mediaId = await waUploadMedia(
      attachment.buffer,
      attachment.filename || "document.docx",
      attachment.mimeType || "application/octet-stream"
    );
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: mediaId,
          filename: attachment.filename || "document.docx",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("[waSendDocument] Error:", err.response?.data || err.message);
    await waSend(to, "⚠️ I generated the file but couldn't send it. Try /draft again.");
  }
}

// Handle a reply that may be a string OR { text, attachment } from JJ /draft flow.
async function waHandleReplyOrAttachment(to, reply) {
  if (reply && typeof reply === "object" && reply.attachment) {
    if (reply.text) await waSend(to, reply.text);
    await waSendDocument(to, reply.attachment);
  } else if (typeof reply === "string") {
    await waSend(to, reply);
  } else if (reply && reply.text) {
    await waSend(to, reply.text);
  }
}

// WhatsApp verification
app.get("/whatsapp", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN && req.query["hub.challenge"]) {
    res.send(req.query["hub.challenge"]);
  } else { res.sendStatus(403); }
});

// ── Facebook Messenger webhook verification ───────────────
app.get("/messenger", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === (process.env.MESSENGER_VERIFY_TOKEN || VERIFY_TOKEN)) {
    console.log("✅ Messenger webhook verified");
    res.send(challenge);
  } else {
    console.error("❌ Messenger webhook verification failed");
    res.sendStatus(403);
  }
});

app.post("/whatsapp", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    // Ignore status updates (delivered, read, sent) — these are not messages
    if (!value || value?.statuses || !value?.messages) return;
    const message = value.messages[0];
    if (!message) return;
    if (!["text","image","audio","document"].includes(message.type)) return;
    const from = message.from;
    try {
      if (message.type === "image") {
        const { buffer, mimeType } = await waDownloadMedia(message.image.id);
        const reply = await askClaudeWithMemory("whatsapp", from, message.image.caption || "Analyze this image.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), { isImage:true, imageData:buffer.toString("base64"), imageMediaType:mimeType });
        await waSend(from, reply); return;
      }
      if (message.type === "document") {
        const { buffer, mimeType } = await waDownloadMedia(message.document.id);
        const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const filename = message.document.filename || "";
        if (mimeType === "application/pdf") {
          const reply = await askClaudeWithMemory("whatsapp", from, message.document.caption || "Analyze this PDF.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
            isPdf:true, pdfData:buffer.toString("base64"),
            sendProgress: (t) => waSend(from, t),
          });
          await waHandleReplyOrAttachment(from, reply);
        } else if (mimeType === docxMime || filename.toLowerCase().endsWith(".docx")) {
          // DOCX — for /template add, /brief, /case add, or /draft with facts doc
          const reply = await askClaudeWithMemory("whatsapp", from, message.document.caption || "", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
            isDocx:true, docxData:buffer.toString("base64"),
            sendProgress: (t) => waSend(from, t),
          });
          await waHandleReplyOrAttachment(from, reply);
        } else {
          await waSend(from, "I can read images, PDFs, and .docx files. Please resend in one of those formats.");
        }
        return;
      }
      if (message.type === "audio") {
        const { buffer, mimeType } = await waDownloadMedia(message.audio.id);
        const ext = mimeType.includes("ogg") ? "ogg" : "m4a";
        const transcript = await transcribeAudio(buffer, `voice.${ext}`);
        if (!transcript) { await waSend(from, "Sorry, I couldn't make out that voice message. Please type instead."); return; }
        await waSend(from, `🎤 I heard: "${transcript}"\n\nLet me help...`);
        await processMessage("whatsapp", from, transcript, Object.assign(async (t) => {
          await waSend(from, t);
        }, {
          _deliverAttachment: async (att) => { await waSendDocument(from, att); },
        }));
        return;
      }
      if (message.type === "text") {
        // Send "thinking" message if Claude takes more than 5 seconds
        let thinkingTimer = setTimeout(() => {
          waSend(from, "🤔 Let me think about that for a moment...").catch(() => {});
        }, 5000);
        await processMessage("whatsapp", from, message.text.body, Object.assign(async (t) => {
          await waSend(from, t);
        }, {
          _deliverAttachment: async (att) => { await waSendDocument(from, att); },
        }));
        clearTimeout(thinkingTimer);
      }
    } catch(err) {
      console.error("WhatsApp error:", err.message);
      try { await waSend(from, "Something went wrong. 📞 626-678-8677"); } catch(e) {}
    }
    return;
  }

  // Facebook Messenger
  if (body.object === "page") {
    const entry = body.entry?.[0];
    // Handle messaging events (not echoes, not reads)
    const event = entry?.messaging?.[0];
    if (!event || event.message?.is_echo) return;
    const senderId = event.sender.id;

    // Handle postbacks (button clicks)
    if (event.postback) {
      try {
        await processMessage("messenger", senderId, event.postback.payload || event.postback.title, (t) => msgrSend(senderId, t));
      } catch(err) { console.error("Messenger postback error:", err.message); }
      return;
    }

    // Must have a message
    if (!event.message) return;

    try {
      // Send typing indicator
      await axios.post(`https://graph.facebook.com/v18.0/${PAGE_ID}/messages`, {
        recipient: { id: senderId },
        sender_action: "typing_on"
      }, { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }).catch(() => {});

      // Handle image attachments
      if (event.message.attachments) {
        const att = event.message.attachments[0];
        if (att.type === "image") {
          const reply = await askClaudeWithMemory("messenger", senderId,
            "The user sent an image. Please acknowledge and ask how you can help.",
            buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
          await msgrSend(senderId, reply);
          return;
        }
      }

      if (!event.message.text) return;

      // Thinking message if Claude takes > 5s
      let thinkingTimer = setTimeout(() => {
        msgrSend(senderId, "🤔 Let me look into that for you...").catch(() => {});
      }, 5000);

      await processMessage("messenger", senderId, event.message.text, (t) => msgrSend(senderId, t));
      clearTimeout(thinkingTimer);

    } catch(err) {
      console.error("Messenger error:", err.message);
      try { await msgrSend(senderId, "Something went wrong. 📞 626-678-8677"); } catch(e) {}
    }
  }
});

// ────────────────────────────────────────────────────────────
//  WECHAT
// ────────────────────────────────────────────────────────────
let wcToken = null, wcTokenExpiry = 0;

async function getWeChatToken() {
  if (wcToken && Date.now() < wcTokenExpiry) return wcToken;
  const resp = await axios.post("https://api.weixin.qq.com/cgi-bin/stable_token", {
    grant_type: "client_credential", appid: WECHAT_APP_ID, secret: WECHAT_APP_SECRET
  });
  if (!resp.data.access_token) throw new Error("WeChat token error: " + JSON.stringify(resp.data));
  wcToken = resp.data.access_token;
  wcTokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  console.log("✅ WeChat token refreshed");
  return wcToken;
}

// wcSend removed — using direct XML reply instead

// wcSendDirect — used for async responses AFTER initial XML reply (voice messages)
async function wcSendDirect(openId, text) {
  try {
    const token = await getWeChatToken();
    const chunks = [];
    for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
    for (const chunk of chunks) {
      const r = await axios.post(
        `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`,
        { touser: openId, msgtype: "text", text: { content: chunk } }
      );
      if (r.data.errcode && r.data.errcode !== 0) {
        console.error("wcSendDirect error:", JSON.stringify(r.data));
      }
    }
  } catch(err) {
    console.error("wcSendDirect error:", err.message);
  }
}

async function wcDownloadMedia(mediaId) {
  const token = await getWeChatToken();
  const resp = await axios.get(`https://api.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`, { responseType: "arraybuffer" });
  return { buffer: Buffer.from(resp.data), contentType: resp.headers["content-type"] || "audio/amr" };
}

function wcXmlReply(toUser, fromUser, content) {
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${Math.floor(Date.now()/1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;
}

async function handleWeChatMsg(req, res) {
  try {
    const xml   = await xml2js.parseStringPromise(req.body, { explicitArray: false });
    const msg   = xml.xml;
    const from  = msg.FromUserName;
    const to    = msg.ToUserName;
    const type  = msg.MsgType;
    console.log(`WeChat ${type} from ${from}`);

    if (type === "event" && msg.Event === "subscribe") {
      res.type("application/xml").send(wcXmlReply(from, to, WELCOME_MESSAGE)); return;
    }
    if (type === "text") {
      // Direct XML reply — no IP whitelist needed
      try {
        const userText = msg.Content?.trim() || "";
        console.log(`WeChat text from ${from}: "${userText.substring(0, 50)}"`);
        // Race Claude against 4.5s timeout to stay within WeChat's 5s window
        const reply = await Promise.race([
          (async () => {
            const lowerText = userText.toLowerCase().trim();
            if (["hi","hello","hey","hola","start","你好"].includes(lowerText)) {
              await clearHistory("wechat", from);
              return WELCOME_MESSAGE;
            }
            if (["contact","team","contacto"].includes(lowerText)) return CONTACT_MESSAGE;
            if (lowerText === "reset") { await clearHistory("wechat", from); return "Fresh start! What can I help you with? 😊"; }
            const r = await askClaudeWithMemory("wechat", from, userText, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
            if (!isJJAuthenticated("wechat", from)) {
              const urgency = detectDistress(userText);
              if (urgency !== "none") notifyDistress(from, userText, urgency, "WeChat").catch(()=>{});
              notifyLead(from, userText, "WeChat").catch(()=>{});
            }
            return r;
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500))
        ]);
        res.type("application/xml").send(wcXmlReply(from, to, reply.substring(0, 600)));
      } catch(err) {
        if (err.message === "timeout") {
          console.log("WeChat response timeout — sending fallback");
          res.type("application/xml").send(wcXmlReply(from, to, "🤔 Still thinking... please send your message again in a moment. 😊"));
        } else {
          console.error("WeChat text error:", err.message);
          res.type("application/xml").send(wcXmlReply(from, to, "Sorry, something went wrong. Please call us at 626-678-8677."));
        }
      }
      return;
    }
    if (type === "voice") {
      // Use WeChat built-in recognition if available
      if (msg.Recognition) {
        try {
          const text = msg.Recognition;
          console.log(`WeChat voice recognized: "${text.substring(0,50)}"`);
          const reply = await Promise.race([
            askClaudeWithMemory("wechat", from, text, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT)),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4200))
          ]);
          res.type("application/xml").send(wcXmlReply(from, to,
            `🎤 "${text}"\n\n${reply}`.substring(0, 600)
          ));
        } catch(err) {
          res.type("application/xml").send(wcXmlReply(from, to,
            "I heard your voice message but took too long to respond. Please type your question instead. 😊"
          ));
        }
        return;
      }
      // No built-in recognition available — ask user to type, suggest other channels
      res.type("application/xml").send(wcXmlReply(from, to,
        "🎤 WeChat暂不支持语音识别，请改用文字提问。如需语音服务，请使用 Telegram (@TEZJJBot) 或 WhatsApp (+1 555-634-2247)。\n\nVoice isn\'t supported on WeChat. For voice, please use Telegram (@TEZJJBot) or WhatsApp (+1 555-634-2247). Or just type here! 😊"
      ));
      return;
    }
    if (type === "image") {
      try {
        const imgResp = await axios.get(msg.PicUrl, { responseType: "arraybuffer" });
        const mimeType = imgResp.headers["content-type"] || "image/jpeg";
        const reply = await Promise.race([
          askClaudeWithMemory("wechat", from, "Analyze this image. If it's a legal document, explain what it is.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), { isImage:true, imageData:Buffer.from(imgResp.data).toString("base64"), imageMediaType:mimeType }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
        ]);
        res.type("application/xml").send(wcXmlReply(from, to, reply.substring(0, 600)));
      } catch(err) {
        if (err.message === "timeout") {
          res.type("application/xml").send(wcXmlReply(from, to, "Processing your image... please send it again in a moment. 😊"));
        } else {
          console.error("WeChat image error:", err.message);
          res.type("application/xml").send(wcXmlReply(from, to, "I had trouble reading that image. Please describe what you need help with."));
        }
      }
      return;
    }
    res.type("application/xml").send(wcXmlReply(from, to, "I support text, voice, and image messages. 😊\n\n我支持文字、语音和图片消息。"));
  } catch(err) {
    console.error("WeChat handler error:", err.message);
    res.send("success");
  }
}

function wcVerify(req, res) {
  const { signature, timestamp, nonce, echostr } = req.query;
  const hash = crypto.createHash("sha1").update([WECHAT_TOKEN, timestamp, nonce].sort().join("")).digest("hex");
  if (hash === signature) { console.log("✅ WeChat verified"); res.send(echostr); }
  else { res.status(403).send("Forbidden"); }
}

app.get("/wechat",   wcVerify);
app.post("/wechat",  handleWeChatMsg);
app.get("/webhook",  wcVerify);
app.post("/webhook", handleWeChatMsg);

// ────────────────────────────────────────────────────────────
//  WEBSITE CHAT
// ────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  const { message, sessionId } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing message or sessionId" });
  try {
    const reply = await askClaudeWithMemory("website", sessionId, message, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
    res.json({ reply });
  } catch(err) {
    console.error("Web chat error:", err.message);
    res.status(500).json({ reply: "Having trouble connecting. Please call us at 626-678-8677." });
  }
});
app.options("/chat", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.sendStatus(200);
});

// ────────────────────────────────────────────────────────────
//  ANALYTICS — Manual trigger endpoint
// ────────────────────────────────────────────────────────────
app.get("/analytics/run", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  res.json({ status: "started", message: "Analytics running — check jj@tezlawfirm.com in ~2 minutes." });
  runWeeklyAnalysis(true).catch(err => console.error("Manual analytics error:", err.message));
});

// ── Manual autoposter trigger ─────────────────────────────
app.post("/autoposter/run", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { runDailyScheduler } = require("./autoposter");
  res.json({ status: "started", message: "Auto-poster running — check Telegram for results." });
  runDailyScheduler().catch(err => console.error("Manual autoposter error:", err.message));
});


// ────────────────────────────────────────────────────────────
//  LEGAL INTELLIGENCE — Manual trigger endpoints
// ────────────────────────────────────────────────────────────

// Manual digest trigger
app.post("/legal/digest/run", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  res.json({ status: "started", message: "Legal digest running — check Telegram in ~2 minutes." });
  runDailyDigest(true).catch(err => console.error("Manual digest error:", err.message));
});

// Judge scanner status
app.get("/legal/judge-scanner/status", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    const status = await getScanStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Citation stats for dashboard
app.get("/legal/citation-stats", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try {
    const db = require("./db");
    const result = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM legal_citations)         AS total_cases,
        (SELECT COUNT(*) FROM citation_treatments)      AS total_treatments,
        (SELECT COUNT(*) FROM citation_treatments
         WHERE treatment_type = 'negative')             AS negative_count,
        (SELECT COUNT(*) FROM legal_citations
         WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
    `);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.json({ total_cases: 0, total_treatments: 0, negative_count: 0, new_this_week: 0 });
  }
});

// Cache stats endpoint
app.get("/legal/cache-stats", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    const stats = await getCacheStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  HEALTH CHECK + START
// ────────────────────────────────────────────────────────────
// ── Mobile PWA ────────────────────────────────────────────
// Optimized for iPhone/Android home-screen install.
// Universal client search + tap-to-call detail views.
app.get("/admin/mobile", (req, res) => {
  const mobile = require("./mobile-app");
  res.send(mobile.renderMobileSearchPage());
});

app.get("/admin/mobile/client/:key", async (req, res) => {
  try {
    const mobile = require("./mobile-app");
    const client = await mobile.getClientDetail(req.params.key);
    res.send(mobile.renderMobileClientPage(client));
  } catch (err) {
    console.error("[mobile client]:", err.message);
    res.status(500).send("Error: " + err.message);
  }
});

// JSON APIs — used by the mobile app, but also available for
// future native iOS/Android app builds
app.get("/admin/api/clients/search", async (req, res) => {
  try {
    const mobile = require("./mobile-app");
    const q = req.query.q || "";
    const limit = Math.min(parseInt(req.query.limit || "25", 10), 100);
    const results = await mobile.searchClients(q, limit);
    res.json({ ok: true, query: q, count: results.length, results });
  } catch (err) {
    console.error("[api/clients/search]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/api/clients/:key", async (req, res) => {
  try {
    const mobile = require("./mobile-app");
    const client = await mobile.getClientDetail(req.params.key);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    res.json({ ok: true, client });
  } catch (err) {
    console.error("[api/clients/:key]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/", (req, res) => res.send("Tez Law P.C. — Zara running on all channels ✅"));

// ── PWA support: manifest + service worker ─────────
// Makes Zara installable as an app on iOS/Android home screens.
app.get("/manifest.json", (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    name: "Zara Admin — Tez Law P.C.",
    short_name: "Zara",
    description: "Legal case management for Tez Law P.C.",
    start_url: "/admin/mobile",
    scope: "/admin/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0C1C36",
    theme_color: "#0C1C36",
    icons: [
      {
        src: "https://tezlawfirm.com/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any maskable"
      },
      {
        src: "https://tezlawfirm.com/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable"
      }
    ],
    shortcuts: [
      { name: "Search Client",  url: "/admin/mobile" },
      { name: "Dashboard",      url: "/admin/dashboard" },
      { name: "Calendar",       url: "/admin/calendar" },
      { name: "Master Notes",   url: "/admin/hearing/notes" }
    ]
  });
});

// Minimal service worker — required by iOS for "Add to Home Screen"
// to render as a proper standalone app. Does network-first with graceful
// offline fallback. Doesn't cache API responses (keeps data fresh).
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  res.send(`
// Zara Service Worker — network-first, minimal caching
const CACHE_NAME = 'zara-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Bypass API and auth calls — always fresh
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/admin/api/') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.includes('/scan-status') ||
      url.pathname.includes('/backup-status')) {
    return; // let browser handle normally
  }

  event.respondWith(
    fetch(event.request)
      .catch(() => {
        // Offline fallback: try cache
        return caches.match(event.request).then(cached => {
          return cached || new Response('Offline — please reconnect.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          });
        });
      })
  );
});
  `);
});

// ── Draft templates admin ─────────────────────────────────
// One-time initialization endpoint (idempotent) — creates the three
// draft_templates tables. Also called automatically on server boot below.
app.get("/admin/init-drafts", async (req, res) => {
  try {
    const dt = require("./draft-templates");
    await dt.initDraftTables();
    const templates = await dt.listTemplates();
    res.json({
      ok: true,
      message: "Draft tables initialized",
      templates: templates.length,
    });
  } catch (err) {
    console.error("[/admin/init-drafts] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── IMAP Email Paralegal — Setup + Admin Endpoints ────────
//
// Setup: JJ visits /admin/email-setup, gets an HTML form to enter
// IMAP credentials for each account. Zara tests the connection,
// encrypts the password, stores in DB, and starts scanning.
//
// Common IMAP settings for JJ's providers:
//   GoDaddy Workspace Email: imap.secureserver.net:993 (SSL)
//   GoDaddy 365 through GoDaddy: outlook.office365.com:993 (SSL)
//   Gmail:  imap.gmail.com:993 (SSL) — needs "App Password" from Google
//   Hotmail/Outlook.com: outlook.office365.com:993 (SSL) — may need app password
//

app.get("/admin/email-setup", async (req, res) => {
  try {
    const paralegal = require("./email-paralegal");
    const hearingNotes = require("./hearing-notes");
    const accounts = await paralegal.listAccounts();

    const accountsHtml = accounts.length ? accounts.map(a => `
      <div style="background:white; padding:14px 16px; margin:8px 0; border-radius:8px; border:1px solid #eee; border-left: 4px solid ${a.active ? "#4CAF50" : "#999"};">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <strong style="color:#0C1C36;">${a.email}</strong>
            <div style="color:#666; font-size:12px; margin-top:2px;">${a.imap_host}:${a.imap_port}</div>
            <div style="color:#888; font-size:11px; margin-top:4px;">Last scan: ${a.last_scan_at ? new Date(a.last_scan_at).toLocaleString() : "never"}</div>
            ${a.last_error ? `<div style="color:#c00; font-size:11px; margin-top:4px;">Error: ${a.last_error}</div>` : ""}
          </div>
        </div>
      </div>
    `).join("") : `<div style="text-align:center; padding:20px; color:#888; font-style:italic;">No accounts linked yet.</div>`;

    const body = `
      <div class="page-header">
        <h1>📬 Email Setup</h1>
        <div style="font-size:13px; color:#666;">Configure IMAP credentials for accounts you want Zara to monitor.</div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
        <!-- Left: Linked Accounts + Remove -->
        <div>
          <div style="background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
            <h2 style="margin:0 0 12px 0; font-size:15px; color:#0C1C36;">Linked Accounts</h2>
            ${accountsHtml}
          </div>

          <div style="background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee;">
            <h2 style="margin:0 0 12px 0; font-size:15px; color:#0C1C36;">Remove Account</h2>
            <form method="POST" action="/admin/email-setup">
              <label style="display:block; font-size:12px; color:#666; margin-bottom:4px;">Email to remove</label>
              <input type="email" name="email" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; margin-bottom:10px;">
              <button type="submit" name="action" value="remove" style="background:#c00; color:white; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; font-weight:600;">Remove</button>
            </form>
          </div>
        </div>

        <!-- Right: Add/Update Account -->
        <div style="background:white; padding:16px 20px; border-radius:8px; border:1px solid #eee;">
          <h2 style="margin:0 0 12px 0; font-size:15px; color:#0C1C36;">Add / Update Account</h2>

          <div style="background:#fff3cd; padding:12px; border-left:4px solid #ffc107; margin-bottom:16px; border-radius:4px; font-size:12px; line-height:1.5;">
            <strong>⚠️ App passwords:</strong> For Gmail, Hotmail, and Google Workspace accounts with 2FA, use an <em>app-specific password</em> (not your login password).
            <br>• Gmail: <a href="https://myaccount.google.com/apppasswords" target="_blank">myaccount.google.com/apppasswords</a>
            <br>• Hotmail/Outlook: <a href="https://account.microsoft.com/security" target="_blank">account.microsoft.com/security</a> → App passwords
          </div>

          <form method="POST" action="/admin/email-setup">
            <label style="font-size:12px; color:#666;">Email address</label>
            <input type="email" name="email" required placeholder="jj@tezlawfirm.com" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; margin-bottom:10px;">

            <label style="font-size:12px; color:#666;">Display name (optional)</label>
            <input type="text" name="display_name" placeholder="Tez Law primary" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; margin-bottom:10px;">

            <label style="font-size:12px; color:#666;">IMAP host</label>
            <input type="text" name="imap_host" required placeholder="imap.secureserver.net" id="imap_host" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; margin-bottom:6px;">

            <div style="margin-bottom:10px;">
              <small style="color:#888; font-size:11px;">Quick fill:</small>
              <span onclick="fillPreset('imap.secureserver.net',993)" style="display:inline-block; margin:3px; padding:3px 8px; background:#eee; cursor:pointer; border-radius:3px; font-size:11px;">GoDaddy Workspace</span>
              <span onclick="fillPreset('outlook.office365.com',993)" style="display:inline-block; margin:3px; padding:3px 8px; background:#eee; cursor:pointer; border-radius:3px; font-size:11px;">GoDaddy 365 / Hotmail / Outlook</span>
              <span onclick="fillPreset('imap.gmail.com',993)" style="display:inline-block; margin:3px; padding:3px 8px; background:#eee; cursor:pointer; border-radius:3px; font-size:11px;">Gmail</span>
              <span onclick="fillPreset('imap.mail.yahoo.com',993)" style="display:inline-block; margin:3px; padding:3px 8px; background:#eee; cursor:pointer; border-radius:3px; font-size:11px;">Yahoo</span>
              <span onclick="fillPreset('imap.zoho.com',993)" style="display:inline-block; margin:3px; padding:3px 8px; background:#eee; cursor:pointer; border-radius:3px; font-size:11px;">Zoho</span>
            </div>

            <label style="font-size:12px; color:#666;">IMAP port</label>
            <input type="number" name="imap_port" value="993" id="imap_port" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; margin-bottom:10px;">

            <label style="font-size:12px; color:#666;">Username (usually same as email)</label>
            <input type="text" name="imap_user" required placeholder="jj@tezlawfirm.com" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; margin-bottom:10px;">

            <label style="font-size:12px; color:#666;">Password (or app-specific password)</label>
            <input type="password" name="password" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; margin-bottom:10px;">

            <label style="display:inline-flex; align-items:center; font-weight:normal; margin-bottom:16px;">
              <input type="checkbox" name="use_tls" value="1" checked style="margin-right:6px;"> Use TLS/SSL (recommended)
            </label>

            <div style="display:flex; gap:8px;">
              <button type="submit" name="action" value="test" style="background:#eee; color:#333; border:none; padding:10px 16px; border-radius:4px; cursor:pointer; font-weight:600; flex:1;">Test connection</button>
              <button type="submit" name="action" value="save" style="background:#B79C62; color:white; border:none; padding:10px 16px; border-radius:4px; cursor:pointer; font-weight:600; flex:1;">Test + Save</button>
            </div>
          </form>
        </div>
      </div>

      <script>
        function fillPreset(host, port) {
          document.getElementById("imap_host").value = host;
          document.getElementById("imap_port").value = port;
        }
      </script>`;

    res.send(hearingNotes.renderAdminChrome({ title: "Email Setup", body, activeItem: null }));
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.post("/admin/email-setup", async (req, res) => {
  try {
    const paralegal = require("./email-paralegal");
    const hearingNotes = require("./hearing-notes");
    const { email, imap_host, imap_port, imap_user, password, use_tls, display_name, action } = req.body;

    const wrap = (title, bodyHtml) => hearingNotes.renderAdminChrome({
      title, body: bodyHtml, activeItem: null,
    });

    if (action === "remove") {
      const removed = await paralegal.removeAccount(email);
      return res.send(wrap("Email Setup", `
        <div class="page-header"><h1>${removed ? "🗑️ Account Removed" : "Not Found"}</h1></div>
        <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; max-width:600px;">
          ${removed
            ? `<p>Account <strong>${email}</strong> has been removed.</p>`
            : `<p><em>${email} was not in the account list.</em></p>`}
          <p style="margin-top:20px;"><a href="/admin/email-setup" style="background:#0C1C36; color:white; padding:8px 16px; border-radius:4px; text-decoration:none;">← Back to setup</a></p>
        </div>
      `));
    }

    // Test the connection first
    const testResult = await paralegal.testAccount({
      imap_host, imap_port: parseInt(imap_port) || 993, imap_user, password,
      use_tls: use_tls === "1" || use_tls === "on",
    });

    if (!testResult.ok) {
      return res.send(wrap("Email Setup — Failed", `
        <div class="page-header"><h1 style="color:#c00;">❌ Connection Failed</h1></div>
        <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; max-width:700px;">
          <div style="background:#fef3f0; padding:12px 16px; border-left:4px solid #c62828; border-radius:4px; margin-bottom:16px; font-family:monospace; font-size:12px;">
            ${testResult.error}
          </div>
          <table style="font-size:13px;">
            <tr><td style="padding:4px 12px 4px 0; color:#666;">Host:</td><td><code>${imap_host}:${imap_port}</code></td></tr>
            <tr><td style="padding:4px 12px 4px 0; color:#666;">User:</td><td><code>${imap_user}</code></td></tr>
          </table>
          <h3 style="margin-top:20px; font-size:14px;">Common fixes</h3>
          <ul style="font-size:13px; line-height:1.7;">
            <li>Verify the password — try app-specific password if 2FA is enabled</li>
            <li>Check IMAP is enabled in your email provider settings</li>
            <li>Confirm the host and port match your provider's docs</li>
            <li>Some providers block IMAP for OAuth-only accounts (e.g., Microsoft may require Modern Auth)</li>
          </ul>
          <p style="margin-top:20px;"><a href="/admin/email-setup" style="background:#0C1C36; color:white; padding:8px 16px; border-radius:4px; text-decoration:none;">← Try again</a></p>
        </div>
      `));
    }

    if (action === "test") {
      return res.send(wrap("Email Setup — Test OK", `
        <div class="page-header"><h1 style="color:#4CAF50;">✅ Connection Works</h1></div>
        <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; max-width:600px;">
          <p>Successfully connected to <strong>${imap_host}:${imap_port}</strong> as <strong>${imap_user}</strong>.</p>
          <p>INBOX contains <strong>${testResult.messageCount}</strong> messages.</p>
          <p style="color:#666; font-size:13px;">Click "Test + Save" if you're ready to store this account.</p>
          <p style="margin-top:20px;"><a href="/admin/email-setup" style="background:#0C1C36; color:white; padding:8px 16px; border-radius:4px; text-decoration:none;">← Back to setup</a></p>
        </div>
      `));
    }

    // action === "save"
    const account = await paralegal.addAccount({
      email, imap_host, imap_port: parseInt(imap_port) || 993, imap_user, password,
      use_tls: use_tls === "1" || use_tls === "on",
      display_name,
    });

    res.send(wrap("Email Setup — Saved", `
      <div class="page-header"><h1 style="color:#4CAF50;">✅ Saved</h1></div>
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; max-width:600px;">
        <p>Account <strong>${account.email}</strong> is now linked to Zara (id: ${account.id}).</p>
        <p>${testResult.messageCount} messages in INBOX. Zara will scan every 30 min.</p>
        <p style="margin-top:20px;"><a href="/admin/email-setup" style="background:#0C1C36; color:white; padding:8px 16px; border-radius:4px; text-decoration:none;">← Add another account</a></p>
      </div>
    `));
  } catch (err) {
    console.error("[/admin/email-setup POST] error:", err.message);
    try {
      const hearingNotes = require("./hearing-notes");
      res.status(500).send(hearingNotes.renderAdminChrome({
        title: "Email Setup — Error",
        body: `<div class="page-header"><h1 style="color:#c00;">Error</h1></div>
               <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; max-width:600px;">
                 <p style="font-family:monospace; color:#c00;">${err.message}</p>
                 <p><a href="/admin/email-setup">← Back</a></p>
               </div>`,
        activeItem: null,
      }));
    } catch {
      res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    }
  }
});

// Trigger digest manually (for testing)
app.get("/admin/email-digest/:when", async (req, res) => {
  try {
    const digest = require("./email-digest");
    const when = req.params.when || "test";
    const dryRun = req.query.dry === "1";
    const result = await digest.runDigest(when, { dryRun });
    res.json({ ok: true, ...result, dryRun });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Master Calendar Hearing Form ─────────────────────────
//
// REDIRECT: The original pre-hearing email form has been replaced
// by the hearing NOTES tool at /admin/hearing/notes.
//
app.get("/admin/hearing/master", (req, res) => res.redirect("/admin/hearing/notes"));
app.post("/admin/hearing/master", (req, res) => res.redirect("/admin/hearing/notes"));
app.get("/admin/hearing/master/history", (req, res) => res.redirect("/admin/hearing/notes/history"));
app.get("/admin/hearing/master/:id", (req, res) => res.redirect(`/admin/hearing/notes/${req.params.id}`));

// ── Hearing Notes ─────────────────────────────────────────
//
// Structured note-taking during hearings + AI-generated summaries
// for paralegal (English, detailed) and client (their language, plain).
//
// Routes:
//   GET  /admin/hearing/notes                    → note-taking form
//   POST /admin/hearing/notes                    → generate + preview/save
//   GET  /admin/hearing/notes/history            → past notes
//   GET  /admin/hearing/notes/:id                → one hearing detail
//   POST /admin/hearing/notes/:id/send-paralegal → send to Jue via Telegram
//
app.get("/admin/hearing/notes", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    await hn.initHearingNotesTables();
    res.send(hn.renderNoteForm({}));
  } catch (err) {
    console.error("[/admin/hearing/notes GET]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/notes", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const action = req.body.action;
    const parsed = hn.parseFormSubmission(req.body);

    if (!parsed.client_name) {
      return res.send(hn.renderNoteForm({
        error: "Client name is required.",
        prev: parsed,
      }));
    }

    if (action === "save") {
      const saved = await hn.saveNote(parsed, { generateSummaries: true });
      // Audit log
      try {
        const audit = require("./audit-log");
        await audit.log({
          req,
          action: saved.was_duplicate ? audit.ACTIONS.HEARING_UPDATED : audit.ACTIONS.HEARING_CREATED,
          target_type: "hearing_note",
          target_id: saved.id,
          target_label: parsed.client_name,
          changes: { hearing_type: parsed.hearing_type, hearing_date: parsed.hearing_date, was_duplicate: saved.was_duplicate },
        });
      } catch { /* silent */ }
      // Redirect to the edit URL so:
      //  - the form comes back in EDIT mode (subsequent saves UPDATE, not INSERT)
      //  - browser refresh or back button won't create a duplicate row
      //  - a dedup flag surfaces when we merged with an existing note instead of creating a new one
      const flag = saved.was_duplicate ? "&merged=1" : "";
      return res.redirect(`/admin/hearing/notes/${saved.id}?saved=1${flag}`);
    }

    // Preview only — generate summaries but don't save to DB
    const hnMod = require("./hearing-notes");
    const [paralegal_summary, client_summary] = await Promise.all([
      hnMod.generateParalegalSummary(parsed),
      hnMod.generateClientSummary(parsed),
    ]);
    return res.send(hn.renderNoteForm({
      generated: { paralegal_summary, client_summary },
      saved: false,
      prev: parsed,
    }));
  } catch (err) {
    console.error("[/admin/hearing/notes POST]:", err.message, err.stack);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><p><a href="/admin/hearing/notes">Back</a></p>`);
  }
});

app.get("/admin/hearing/notes/history", (req, res) => res.redirect("/admin/hearing/history"));

// IMPORTANT: extract-document and extract-i589 must be registered BEFORE the
// parametrized /:id route below. Otherwise Express matches "extract-document"
// against ":id", parseInt() returns NaN, and the request fails with
// "Invalid id" before ever reaching handleExtract.
app.post("/admin/hearing/notes/extract-document", docUpload.single("document"), handleExtract);
app.post("/admin/hearing/notes/extract-i589", docUpload.single("i589"), handleExtract);

// Bulk upload — same route-order rule (must beat /:id)
app.get("/admin/hearing/notes/bulk-upload", (req, res) => {
  const hn = require("./hearing-notes");
  res.send(hn.renderBulkUploadPage());
});

// Duplicate finder + merger
app.get("/admin/hearing/notes/duplicates", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const groups = await hn.findDuplicates();
    res.send(hn.renderDuplicatesPage(groups));
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// ── Voice dictation ─────────────────────────────────────
// Attorney records audio in browser → Whisper transcribes →
// Claude extracts fields → creates draft hearing note.
app.get("/admin/hearing/notes/dictate", (req, res) => {
  const voice = require("./voice-dictation");
  res.send(voice.renderDictatePage());
});

// Multer config for audio uploads — 30MB cap covers ~35 min at 128kbps opus
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// Extract-only endpoint — transcribes + extracts fields but does NOT create
// a note. Used by the embedded dictation modal in the hearing note form to
// populate fields inline. Returns JSON with the extracted data so client-side
// JS can merge into the current form.
app.post("/admin/hearing/notes/dictate/extract-only", audioUpload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No audio file uploaded" });
    }
    const voice = require("./voice-dictation");
    const filename = req.file.originalname || "dictation.webm";
    console.log(`[dictate-extract-only] Received ${req.file.buffer.length} bytes`);
    const transcript = await voice.transcribeAudio(req.file.buffer, filename);
    console.log(`[dictate-extract-only] Transcript: ${transcript.length} chars`);
    if (!transcript || transcript.trim().length < 5) {
      return res.status(400).json({
        ok: false,
        error: "Transcript was empty or too short. Recording may have been silent.",
      });
    }
    const hint = {
      client_name: String(req.body.client_name || "").trim() || null,
      a_number: String(req.body.a_number || "").trim() || null,
      hearing_type: String(req.body.hearing_type || "").trim() || null,
    };
    const extracted = await voice.extractFieldsFromTranscript(transcript, hint);
    res.json({ ok: true, transcript, extracted });
  } catch (err) {
    console.error("[dictate-extract-only]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Chunk transcription — for long-form dictation split into multiple audio
// chunks (Whisper has a 25 MB limit, ~30 min at typical opus bitrates).
// Client uploads each chunk as it finishes recording, gets back just the
// transcript. Client combines transcripts and calls extract-from-text.
app.post("/admin/hearing/notes/dictate/transcribe-chunk", audioUpload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No audio file uploaded" });
    }
    const voice = require("./voice-dictation");
    const filename = req.file.originalname || `chunk-${Date.now()}.webm`;
    const chunkIndex = req.body.chunk_index || "?";
    console.log(`[dictate-chunk] Chunk ${chunkIndex}: ${req.file.buffer.length} bytes`);
    const transcript = await voice.transcribeAudio(req.file.buffer, filename);
    console.log(`[dictate-chunk] Chunk ${chunkIndex} transcript: ${transcript.length} chars`);
    res.json({ ok: true, chunk_index: chunkIndex, transcript });
  } catch (err) {
    console.error("[dictate-chunk]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Extract fields from a plain-text transcript (post multi-chunk combine).
app.post("/admin/hearing/notes/dictate/extract-from-text", async (req, res) => {
  try {
    const transcript = String(req.body.transcript || "").trim();
    if (transcript.length < 10) {
      return res.status(400).json({ ok: false, error: "Transcript is too short" });
    }
    const voice = require("./voice-dictation");
    const hint = {
      client_name: String(req.body.client_name || "").trim() || null,
      a_number: String(req.body.a_number || "").trim() || null,
      hearing_type: String(req.body.hearing_type || "").trim() || null,
    };
    console.log(`[dictate-extract-from-text] Transcript: ${transcript.length} chars`);
    const extracted = await voice.extractFieldsFromTranscript(transcript, hint);
    res.json({ ok: true, extracted });
  } catch (err) {
    console.error("[dictate-extract-from-text]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/hearing/notes/dictate/process", audioUpload.single("audio"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No audio file uploaded" });
    }
    const voice = require("./voice-dictation");
    const hn = require("./hearing-notes");

    console.log(`[dictate] Received ${req.file.buffer.length} bytes, filename=${req.file.originalname}`);

    // Whisper
    const filename = req.file.originalname || "dictation.webm";
    const transcript = await voice.transcribeAudio(req.file.buffer, filename);
    console.log(`[dictate] Whisper transcript: ${transcript.length} chars`);

    if (!transcript || transcript.trim().length < 5) {
      return res.status(400).json({
        ok: false,
        error: "Transcript was empty or too short. Recording may have been silent or too quiet.",
      });
    }

    // Claude extraction with hints
    const hint = {
      client_name: String(req.body.client_name || "").trim() || null,
      a_number: String(req.body.a_number || "").trim() || null,
      hearing_type: String(req.body.hearing_type || "").trim() || null,
    };
    const extracted = await voice.extractFieldsFromTranscript(transcript, hint);
    console.log(`[dictate] Claude extracted: client=${extracted.client_name}, type=${extracted.hearing_type}`);

    if (!extracted.client_name) {
      return res.status(400).json({
        ok: false,
        error: "Couldn't identify a client name from the dictation. Try again and start with 'This is [client name]'s hearing.'",
        transcript,
      });
    }

    // Build note object (matches saveNote schema). Default hearing_datetime
    // to now if Claude didn't set one — dictation happens right after court.
    const note = {
      client_name: extracted.client_name,
      a_number: extracted.a_number || hint.a_number || null,
      client_language: extracted.client_language || "en",
      hearing_datetime: extracted.hearing_datetime || new Date().toISOString(),
      hearing_type: extracted.hearing_type || hint.hearing_type || "master",
      case_type: extracted.case_type || null,
      judge_name: extracted.judge_name || null,
      dhs_attorney: extracted.dhs_attorney || null,
      client_attendance: extracted.client_attendance || null,
      attorney_appearance: extracted.attorney_appearance || null,
      pleadings_admitted: extracted.pleadings_admitted || null,
      pleadings_denied: extracted.pleadings_denied || null,
      pleadings_contested: extracted.pleadings_contested || null,
      pleadings_method: extracted.pleadings_method || null,
      removability_conceded: !!extracted.removability_conceded,
      applications: extracted.applications || [],
      asylum_fee_needed: !!extracted.asylum_fee_needed,
      biometrics_needed: !!extracted.biometrics_needed,
      disposition: extracted.disposition || null,
      disposition_notes: extracted.disposition_notes || null,
      next_hearing_date: extracted.next_hearing_date || null,
      next_hearing_type: extracted.next_hearing_type || null,
      deadlines: extracted.deadlines || [],
      raw_notes: extracted.raw_notes || transcript,
    };

    // Save as draft — dedup + revision logic applies automatically.
    // Do NOT generate summaries yet — attorney needs to review the transcript
    // extraction before triggering paralegal/client comms.
    const saved = await hn.saveNote(note, { generateSummaries: false });
    console.log(`[dictate] Created draft note #${saved.id} (was_duplicate=${saved.was_duplicate})`);

    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req,
        action: saved.was_duplicate ? audit.ACTIONS.HEARING_UPDATED : audit.ACTIONS.HEARING_CREATED,
        target_type: "hearing_note",
        target_id: saved.id,
        target_label: extracted.client_name,
        changes: { source: "voice_dictation", transcript_length: transcript.length, was_duplicate: saved.was_duplicate },
      });
    } catch (auditErr) { /* silent */ }

    res.json({
      ok: true,
      note_id: saved.id,
      was_duplicate: saved.was_duplicate,
      transcript,
      extracted_summary: {
        client_name: extracted.client_name,
        hearing_type: extracted.hearing_type,
        judge_name: extracted.judge_name,
        applications_count: (extracted.applications || []).length,
        deadlines_count: (extracted.deadlines || []).length,
      },
    });
  } catch (err) {
    console.error("[dictate] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/hearing/notes/merge-duplicates", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const keepId = parseInt(req.body.keep_id);
    const deleteIds = (req.body.delete_ids || []).map(x => parseInt(x)).filter(Boolean);
    if (!keepId || !deleteIds.length) return res.status(400).json({ ok: false, error: "Missing keep_id or delete_ids" });
    const result = await hn.mergeDuplicates(keepId, deleteIds);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create a hearing note directly from an extraction result (JSON body).
// Called by the bulk upload page to bulk-create draft hearing notes without
// requiring the attorney to re-enter every field.
app.post("/admin/hearing/notes/create-from-extraction", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const extraction = req.body.extraction || {};
    if (!extraction.client_name) {
      return res.status(400).json({ ok: false, error: "Client name is required — the extraction didn't identify one. Open manually to fill it in." });
    }
    // Build a note object matching what saveNote expects. Extraction fields
    // map directly to hearing_notes columns; missing ones default to null.
    const note = {
      client_name:      extraction.client_name || "",
      a_number:         extraction.a_number || null,
      client_language:  extraction.client_language || "en",
      client_email:     extraction.client_email || null,
      client_phone:     extraction.client_phone || null,
      client_address:   extraction.client_address || null,
      // NOTE: saveNote uses `hearing_date` for the primary hearing timestamp
      // (matches DB column). Extraction uses `hearing_datetime` — bridge here.
      hearing_date:     extraction.hearing_datetime || null,
      hearing_type:     extraction.hearing_type || null,
      case_type:        extraction.case_type || null,
      judge_name:       extraction.judge_name || null,
      dhs_attorney:     extraction.dhs_attorney || null,
      next_hearing_date: extraction.next_hearing_date || null,
      next_hearing_type: extraction.next_hearing_type || null,
      raw_notes:        extraction.narrative_notes || "",
      deadlines:        [],
      applications_filed: [],
      applications_pending: [],
    };
    // Save as draft — do NOT auto-generate paralegal/client summaries yet
    // (they're for finalized hearings; drafts still need attorney review).
    const saveResult = await hn.saveNote(note, { generateSummaries: false });
    res.json({ ok: true, note_id: saveResult.id, was_duplicate: saveResult.was_duplicate });
  } catch (err) {
    console.error("[bulk-create-from-extraction]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/hearing/notes/:id", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const note = await hn.getNote(id);
    if (!note) return res.status(404).send(`<h1>Not found</h1><p><a href="/admin/hearing/history">← Back to history</a></p>`);
    const revisions = await hn.getRevisions(id).catch(() => []);
    res.send(hn.renderNoteForm({
      noteId: id,
      prev: note,
      saved: req.query.saved === "1",
      merged: req.query.merged === "1",
      revisions,
    }));
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Update an existing master hearing note
app.post("/admin/hearing/notes/:id", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const parsed = hn.parseFormSubmission(req.body);
    if (!parsed.client_name) {
      return res.send(hn.renderNoteForm({
        noteId: id,
        error: "Client name is required.",
        prev: { ...parsed, id },
      }));
    }
    await hn.updateNote(id, parsed, { user: req.user });
    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req, action: audit.ACTIONS.HEARING_UPDATED,
        target_type: "hearing_note", target_id: id, target_label: parsed.client_name,
        changes: { hearing_type: parsed.hearing_type, hearing_date: parsed.hearing_date },
      });
    } catch { /* silent */ }
    if (req.body.action === "update_and_regenerate") {
      await hn.generateAndSaveSummariesForMaster(id);
    }
    res.redirect(`/admin/hearing/notes/${id}?saved=1`);
  } catch (err) {
    console.error("[/admin/hearing/notes/:id POST]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/notes/:id/send-paralegal", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await hn.sendToParalegal(id);
    // Audit log
    try {
      const audit = require("./audit-log");
      const note = await hn.getNote(id).catch(() => ({}));
      await audit.log({
        req, action: audit.ACTIONS.HEARING_SUMMARY_SENT,
        target_type: "hearing_note", target_id: id, target_label: note?.client_name || null,
        changes: { chunks: result.chunks },
      });
    } catch { /* silent */ }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[send-paralegal]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/admin/hearing/notes/:id", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await hn.deleteNote(id);
    console.log(`[hearing-notes] Deleted note #${id} (${result.client_name})`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[delete-hearing-note]:", err.message);
    res.status(err.message.includes("not found") ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// ── Individual Hearing Notes ──────────────────────────────
//
// Full prep tool for individual/merits hearings. Supports Excel exhibit
// upload, PDF/text hearing summary upload with Claude extraction, and
// pre-fill from prior master hearing.
//
app.get("/admin/hearing/individual", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    await ih.initTables();
    // ?copy_from=<id> — pre-fill client info from an existing hearing to create
    // a continuation. We copy client/court/judge info but NOT exhibits, exams,
    // or closing (those are specific to each hearing session).
    let prev = {};
    if (req.query.copy_from) {
      const src = await ih.getIndividualNote(parseInt(req.query.copy_from));
      if (src) {
        prev = {
          client_name: src.client_name,
          a_number: src.a_number,
          client_language: src.client_language,
          client_email: src.client_email,
          client_phone: src.client_phone,
          client_address: src.client_address,
          case_type: src.case_type,
          judge_name: src.judge_name,
          court_location: src.court_location,
          court_address: src.court_address,
          dhs_attorney: src.dhs_attorney,
        };
      }
    }
    res.send(ih.renderForm({ prev }));
  } catch (err) {
    console.error("[/admin/hearing/individual GET]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/individual", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const parsed = ih.parseFormSubmission(req.body);
    if (!parsed.client_name) {
      return res.send(ih.renderForm({ error: "Client name is required.", prev: parsed }));
    }
    const saved = await ih.saveIndividualNote(parsed);
    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req, action: audit.ACTIONS.HEARING_CREATED,
        target_type: "individual_hearing", target_id: saved.id, target_label: parsed.client_name,
        changes: { hearing_date: parsed.hearing_date, judge_name: parsed.judge_name },
      });
    } catch { /* silent */ }
    res.redirect(`/admin/hearing/individual/${saved.id}?saved=1`);
  } catch (err) {
    console.error("[/admin/hearing/individual POST]:", err.message, err.stack);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><p><a href="/admin/hearing/individual">Back</a></p>`);
  }
});

app.get("/admin/hearing/individual/history", (req, res) => res.redirect("/admin/hearing/history"));

// ── Client Profiles ───────────────────────────────────────
// Aggregated view of every client across master and individual hearing
// notes. Grouped by A-Number (preferred) or client name.
app.get("/admin/clients", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const clients = await cp.aggregateClients();
    res.send(cp.renderClientList(clients));
  } catch (err) {
    console.error("[/admin/clients]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Bulk import all client folders from configured Dropbox branches
app.post("/admin/clients/bulk-import-dropbox", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const dryRun = req.query.dry === "1";
    const result = await dbx.bulkImportFromDropbox({ dryRun });
    res.json({ ok: true, dry_run: dryRun, ...result });
  } catch (err) {
    console.error("[bulk import]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Hearing Notices (scan Dropbox + client notification) ─
// Scans a client's Dropbox folder for hearing notices via Claude Sonnet vision,
// extracts date/time/court/judge, stores them, and offers one-click notification.

app.post("/admin/clients/:key/hearing-notices/scan", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const dbx = require("./dropbox-integration");
    const hn = require("./hearing-notices");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    const folder = await dbx.resolveClientFolder({
      clientKey: client.key, clientName: client.client_name, aNumber: client.a_number,
    });
    if (!folder) return res.status(400).json({ ok: false, error: "Dropbox folder not linked for this client" });
    const result = await hn.scanClientFolder({
      clientKey: client.key,
      clientName: client.client_name,
      aNumber: client.a_number,
      dropboxFolderPath: folder,
      limit: parseInt(req.query.limit || "20"),
    });
    res.json({ ok: true, folder, ...result });
  } catch (err) {
    console.error("[hearing notices scan]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/clients/:key/hearing-notices", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const hn = require("./hearing-notices");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    const notices = await hn.listClientNotices(client.key);
    // Build contact links for each notice
    const enriched = notices.map(n => ({
      ...n,
      contact_links: hn.buildContactLinks({
        notice: n,
        clientEmail: client.client_email,
        clientPhone: client.client_phone,
        clientLang: client.client_language,
      }),
    }));
    res.json({ ok: true, notices: enriched });
  } catch (err) {
    console.error("[hearing notices list]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/clients/:key/hearing-notices/:id/notified", async (req, res) => {
  try {
    const hn = require("./hearing-notices");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const channel = (req.body.channel || "").trim() || "unknown";
    await hn.markNotified(id, channel);
    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req, action: audit.ACTIONS.NOTICE_SENT,
        target_type: "hearing_notice", target_id: id, target_label: req.params.key,
        changes: { channel },
      });
    } catch { /* silent */ }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/admin/clients/:key/hearing-notices/:id/dismiss", async (req, res) => {
  try {
    const hn = require("./hearing-notices");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    await hn.dismissNotice(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Dropbox Integration ───────────────────────────────────
// OAuth setup flow, config, and per-client file operations.
// See dropbox-integration.js for details.

const DROPBOX_CALLBACK_URL = (process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com") + "/admin/dropbox/callback";

// Diagnostic: browse Dropbox to see what Zara can actually reach
// Per-client Dropbox matching debug — shows tokens, branches scanned,
// every candidate folder with its score, and where the current mapping came from.
app.get("/admin/clients/:key/dropbox/debug", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const dbx = require("./dropbox-integration");
    const hn = require("./hearing-notes");
    const db = require("./db");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) return res.status(404).send("Client not found");

    const branches = dbx.getBranchRoots();
    const tokens = dbx.nameTokens ? dbx.nameTokens(client.client_name) : [];
    const aDigits = dbx.aNumberDigits ? dbx.aNumberDigits(client.a_number) : null;

    // Existing mapping?
    const mapRes = await db.query(
      `SELECT * FROM client_dropbox_mapping WHERE client_key = $1`,
      [client.key]
    );
    const existingMapping = mapRes.rows[0] || null;

    // For each branch, list folders and score them
    const branchDetails = [];
    for (const b of branches) {
      const bpath = b.startsWith("/") ? b : "/" + b;
      const detail = { branch: bpath };
      try {
        const meta = await dbx.getMetadata(bpath);
        if (!meta) { detail.error = "Branch folder does not exist"; branchDetails.push(detail); continue; }
        if (meta[".tag"] !== "folder") { detail.error = `Path is a ${meta[".tag"]}, not a folder`; branchDetails.push(detail); continue; }
        const entries = await dbx.listFolder(bpath);
        if (!entries) { detail.error = "listFolder returned null"; branchDetails.push(detail); continue; }
        const subfolders = entries.filter(e => e[".tag"] === "folder");
        detail.subfolder_count = subfolders.length;
        detail.file_count = entries.filter(e => e[".tag"] === "file").length;
        // Score every subfolder
        detail.scored = subfolders.map(f => {
          const s = dbx.scoreFolderMatch ? dbx.scoreFolderMatch(f.name, tokens, aDigits) : { score: 0, reason: "scorer not exposed" };
          return { name: f.name, path: f.path_display, score: s.score, reason: s.reason };
        }).sort((a, b) => b.score - a.score);
      } catch (e) {
        detail.error = e.message;
      }
      branchDetails.push(detail);
    }

    const escapeHtml = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const scoreBadge = (n) => {
      const color = n >= 70 ? "#4CAF50" : n >= 40 ? "#ff9800" : "#c00";
      return `<span style="background:${color}; color:white; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">${n}</span>`;
    };

    const body = `
      <div class="page-header">
        <h1>🔍 Dropbox Debug: ${escapeHtml(client.client_name || client.key)}</h1>
        <a href="/admin/clients/${client.key}" class="back-link">← Back to client</a>
      </div>

      <div style="background:white; padding:15px; border-radius:4px; border:1px solid #eee; margin-bottom:15px;">
        <h3 style="margin-top:0;">Client info Zara is matching on</h3>
        <table style="font-size:13px;">
          <tr><td style="padding:4px 15px 4px 0;"><strong>Name:</strong></td><td><code>${escapeHtml(client.client_name || "(none)")}</code></td></tr>
          <tr><td style="padding:4px 15px 4px 0;"><strong>A-Number:</strong></td><td><code>${escapeHtml(client.a_number || "(none)")}</code></td></tr>
          <tr><td style="padding:4px 15px 4px 0;"><strong>Client key:</strong></td><td><code>${escapeHtml(client.key)}</code></td></tr>
          <tr><td style="padding:4px 15px 4px 0;"><strong>Name tokens (matcher uses these):</strong></td><td>${tokens.map(t => `<code style="background:#f0f0f0; padding:2px 6px; margin-right:4px;">${escapeHtml(t)}</code>`).join("") || "<em>none extracted</em>"}</td></tr>
          <tr><td style="padding:4px 15px 4px 0;"><strong>A# digits (matcher uses):</strong></td><td>${aDigits ? `<code>${escapeHtml(aDigits)}</code>` : "<em>none</em>"}</td></tr>
        </table>
      </div>

      <div style="background:white; padding:15px; border-radius:4px; border:1px solid #eee; margin-bottom:15px;">
        <h3 style="margin-top:0;">Current mapping in DB</h3>
        ${existingMapping
          ? `<div>Path: <code>${escapeHtml(existingMapping.dropbox_path)}</code></div>
             <div style="font-size:12px; color:#666; margin-top:4px;">Resolved ${new Date(existingMapping.resolved_at).toLocaleString()} (${existingMapping.resolved_by})</div>
             <form method="POST" action="/admin/clients/${client.key}/dropbox/mapping" style="margin-top:10px;">
               <input type="hidden" name="path" value="">
               <button type="submit" style="background:#c00; color:white; padding:6px 12px; border:none; border-radius:3px; cursor:pointer; font-size:13px;">Clear this mapping & rescan</button>
             </form>`
          : `<em>No mapping yet — will auto-detect on next scan.</em>`}
      </div>

      <div style="background:white; padding:15px; border-radius:4px; border:1px solid #eee;">
        <h3 style="margin-top:0;">Configured branches (${branches.length})</h3>
        ${branches.length === 0 ? `<div style="color:#c00;">⚠️ No branches configured. Set DROPBOX_BRANCH_ROOTS env var in Render.</div>` : ""}
        ${branchDetails.map(bd => `
          <div style="margin-bottom:20px; padding:12px; background:#f8f8f8; border-radius:4px;">
            <div style="font-weight:600; margin-bottom:6px;"><code>${escapeHtml(bd.branch)}</code></div>
            ${bd.error
              ? `<div style="color:#c00;">❌ ${escapeHtml(bd.error)}</div>`
              : `<div style="font-size:12px; color:#666; margin-bottom:8px;">${bd.subfolder_count} subfolders, ${bd.file_count} top-level files</div>
                 ${bd.scored && bd.scored.length ? `
                   <table style="width:100%; font-size:13px;">
                     <thead><tr style="border-bottom:1px solid #ddd;"><th style="text-align:left; width:60px;">Score</th><th style="text-align:left;">Folder Name</th><th style="text-align:left;">Match reason</th><th></th></tr></thead>
                     <tbody>
                       ${bd.scored.slice(0, 30).map(s => `
                         <tr>
                           <td>${scoreBadge(s.score)}</td>
                           <td><code>${escapeHtml(s.name)}</code></td>
                           <td style="font-size:12px; color:#666;">${escapeHtml(s.reason || "—")}</td>
                           <td>
                             <form method="POST" action="/admin/clients/${client.key}/dropbox/mapping" style="margin:0; display:inline;">
                               <input type="hidden" name="path" value="${escapeHtml(s.path)}">
                               <button type="submit" style="background:#0061FF; color:white; border:none; padding:3px 10px; border-radius:3px; cursor:pointer; font-size:11px;">Use this</button>
                             </form>
                           </td>
                         </tr>`).join("")}
                     </tbody>
                   </table>
                   ${bd.scored.length > 30 ? `<div style="font-size:12px; color:#888; margin-top:6px;">Showing top 30 of ${bd.scored.length} folders</div>` : ""}
                 ` : `<em>No subfolders</em>`}`
            }
          </div>`).join("")}
      </div>

      <div style="background:#fdf7f0; padding:15px; border-radius:4px; border-left:4px solid #B79C62; margin-top:15px;">
        <h3 style="margin-top:0;">How to fix</h3>
        <ul style="line-height:1.8;">
          <li>Score ≥70 = auto-selected. Below that = shown as suggestion only.</li>
          <li>If the RIGHT folder scored low, the matcher needs tuning — send me the folder name and the client name.</li>
          <li>If the branch shows an error, fix the DROPBOX_BRANCH_ROOTS env var.</li>
          <li>If the right folder isn't in the list at all, either it's in a different branch or nested deeper. Configure a more specific branch path.</li>
          <li>To force a specific folder, click <strong>"Use this"</strong> next to it — this creates a manual mapping that persists.</li>
        </ul>
      </div>`;

    res.send(hn.renderAdminChrome({ title: "Dropbox Debug", body, activeItem: "dropbox" }));
  } catch (err) {
    console.error("[dropbox debug]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><pre>${err.stack || ""}</pre>`);
  }
});

app.get("/admin/dropbox/browse", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const hn = require("./hearing-notes");
    const path = req.query.path || "";  // "" = root

    let entries = null;
    let error = null;
    try {
      entries = await dbx.listFolder(path);
    } catch (e) {
      error = e.message;
    }

    const branches = dbx.getBranchRoots();
    const parent = path ? path.substring(0, path.lastIndexOf("/")) : null;

    // Try each configured branch and report what happened
    const branchReports = [];
    if (!path) {
      for (const b of branches) {
        const bpath = b.startsWith("/") ? b : "/" + b;
        try {
          const meta = await dbx.getMetadata(bpath);
          if (!meta) {
            branchReports.push({ path: bpath, status: "❌ not_found", detail: "This folder does not exist in your Dropbox at this exact path." });
          } else if (meta[".tag"] !== "folder") {
            branchReports.push({ path: bpath, status: "⚠️ not_a_folder", detail: `Path exists but is a ${meta[".tag"]}, not a folder.` });
          } else {
            const contents = await dbx.listFolder(bpath);
            branchReports.push({
              path: bpath,
              status: "✅ found",
              detail: `${(contents || []).filter(e => e[".tag"] === "folder").length} subfolders, ${(contents || []).filter(e => e[".tag"] === "file").length} files at top level`,
            });
          }
        } catch (e) {
          branchReports.push({ path: bpath, status: "❌ error", detail: e.message });
        }
      }
    }

    const escapeHtml = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

    let entriesHtml = "";
    if (error) {
      entriesHtml = `<div style="background:#fef2f2; border-left:4px solid #c00; padding:15px; border-radius:4px;"><strong>Error listing this path:</strong><br><code>${escapeHtml(error)}</code></div>`;
    } else if (!entries || !entries.length) {
      entriesHtml = `<div style="color:#888; padding:20px; text-align:center;">(empty folder)</div>`;
    } else {
      const folders = entries.filter(e => e[".tag"] === "folder");
      const files = entries.filter(e => e[".tag"] === "file");
      entriesHtml = `
        <table style="width:100%; font-size:13px;">
          <thead><tr style="border-bottom:1px solid #eee;"><th style="text-align:left; width:30px;"></th><th style="text-align:left;">Name</th><th style="text-align:left;">Path</th></tr></thead>
          <tbody>
            ${folders.map(f => `
              <tr>
                <td>📁</td>
                <td><a href="/admin/dropbox/browse?path=${encodeURIComponent(f.path_display)}" style="color:#0061FF; font-weight:600; text-decoration:none;">${escapeHtml(f.name)}</a></td>
                <td style="font-family:monospace; font-size:11px; color:#666;">${escapeHtml(f.path_display)}</td>
              </tr>`).join("")}
            ${files.map(f => `
              <tr>
                <td>📄</td>
                <td>${escapeHtml(f.name)}</td>
                <td style="font-family:monospace; font-size:11px; color:#666;">${escapeHtml(f.path_display)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
        <div style="font-size:12px; color:#666; margin-top:8px;">${folders.length} folder(s), ${files.length} file(s)</div>`;
    }

    const branchReportsHtml = branchReports.length ? `
      <div style="background:white; padding:15px; border-radius:4px; border:1px solid #eee; margin-bottom:15px;">
        <h3 style="margin:0 0 10px 0;">Configured branch check</h3>
        ${branchReports.map(b => `
          <div style="padding:8px; margin-bottom:6px; background:#f8f8f8; border-radius:4px;">
            <div><code style="font-weight:600;">${escapeHtml(b.path)}</code> — ${b.status}</div>
            <div style="font-size:12px; color:#666; margin-top:4px;">${escapeHtml(b.detail)}</div>
          </div>`).join("")}
      </div>` : "";

    const breadcrumb = path
      ? `<div style="margin-bottom:10px;"><a href="/admin/dropbox/browse" style="color:#0061FF;">📦 Root</a> ${path.split("/").filter(Boolean).map((seg, i, arr) => {
          const fullPath = "/" + arr.slice(0, i + 1).join("/");
          return `/ <a href="/admin/dropbox/browse?path=${encodeURIComponent(fullPath)}" style="color:#0061FF;">${escapeHtml(seg)}</a>`;
        }).join(" ")}</div>`
      : `<div style="margin-bottom:10px;"><strong>📦 Dropbox Root</strong></div>`;

    const body = `
      <div class="page-header">
        <h1>📦 Dropbox Browser</h1>
        <a href="/admin/dropbox/setup" class="back-link">← Setup</a>
      </div>
      <p style="color:#666;">This shows what Zara can actually see in your Dropbox. Use it to verify branch folder names and paths.</p>
      ${branchReportsHtml}
      <div style="background:white; padding:15px; border-radius:4px; border:1px solid #eee;">
        ${breadcrumb}
        ${entriesHtml}
      </div>`;

    res.send(hn.renderAdminChrome({ title: "Dropbox Browser", body, activeItem: "dropbox" }));
  } catch (err) {
    console.error("[dropbox browse]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Dumps the raw response from Dropbox's get_current_account so we can see
// exactly what fields (including root_info) it returned.
app.get("/admin/dropbox/raw-account", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const token = await dbx.getAccessToken();
    // Native fetch — axios keeps overriding Content-Type on this specific endpoint.
    const resp = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "null",
    });
    const text = await resp.text();
    if (!resp.ok) {
      return res.status(500).type("text/plain").send(
        "Error: HTTP " + resp.status + "\n\nResponse body: " + text
      );
    }
    // Pretty-print JSON
    try {
      res.type("text/plain").send(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      res.type("text/plain").send(text);
    }
  } catch (err) {
    res.status(500).type("text/plain").send("Error: " + err.message + "\n" + (err.stack || ""));
  }
});

// Diagnostic: shows lengths of Dropbox env vars (safe, doesn't reveal values)
app.get("/admin/dropbox/diag", async (req, res) => {
  const key = process.env.DROPBOX_APP_KEY || "";
  const secret = process.env.DROPBOX_APP_SECRET || "";
  const branches = process.env.DROPBOX_BRANCH_ROOTS || "";
  let dbxStatus = "not loaded";
  let namespaceInfo = "unknown";
  try {
    const dbx = require("./dropbox-integration");
    const settings = await dbx.getSettings();
    dbxStatus = settings.refresh_token ? "authorized" : "not authorized";
    namespaceInfo = settings.root_namespace_id
      ? `saved: ${settings.root_namespace_id}`
      : "NOT SAVED — needs re-authorization";

    // Try to fetch namespace live if missing
    if (!settings.root_namespace_id && settings.refresh_token && req.query.fix === "1") {
      try {
        const header = await dbx.getPathRootHeader();
        namespaceInfo = header ? `just fetched: ${header}` : "fetch attempted but no namespace returned";
      } catch (e) {
        namespaceInfo += ` (fetch failed: ${e.message})`;
      }
    }
  } catch (e) {
    dbxStatus = "error: " + e.message;
  }
  res.type("text/plain").send(
    `Dropbox env diagnostic:
DROPBOX_APP_KEY:       length=${key.length}, first_char="${key[0] || ""}", last_char="${key[key.length-1] || ""}", has_spaces=${/\s/.test(key)}, has_quotes=${/["']/.test(key)}
DROPBOX_APP_SECRET:    length=${secret.length}, first_char="${secret[0] || ""}", last_char="${secret[secret.length-1] || ""}", has_spaces=${/\s/.test(secret)}, has_quotes=${/["']/.test(secret)}
DROPBOX_BRANCH_ROOTS:  "${branches}"

Auth status:           ${dbxStatus}
Team namespace ID:     ${namespaceInfo}

Expected:
DROPBOX_APP_KEY:       15 chars, alphanumeric only, no spaces/quotes
DROPBOX_APP_SECRET:    15 chars, alphanumeric only, no spaces/quotes
DROPBOX_BRANCH_ROOTS:  comma-separated folder names, e.g. "/USCIS/ASYLUM_EOIR"
Team namespace ID:     Should be saved if you re-authorized after Aug 27 build.

TIP: If team namespace ID shows "NOT SAVED", visit /admin/dropbox/diag?fix=1 to
     force-fetch it right now without re-authorizing. If that still fails,
     click "Re-authorize" on /admin/dropbox/setup.
`
  );
});

app.get("/admin/dropbox/setup", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const configured = dbx.isConfigured();
    const settings = configured ? await dbx.getSettings() : {};
    const branches = dbx.getBranchRoots();
    const hn = require("./hearing-notes");
    const authorized = !!(settings && settings.refresh_token);

    let statusHtml = "";
    if (!configured) {
      statusHtml = `
        <div style="background:#fef2f2; border-left:4px solid #c00; padding:15px; border-radius:4px;">
          <strong>⚠️ Not configured</strong>
          <p style="margin:8px 0 0 0;">Set these env vars in Render, then reload:</p>
          <ul style="margin:8px 0;">
            <li><code>DROPBOX_APP_KEY</code></li>
            <li><code>DROPBOX_APP_SECRET</code></li>
            <li><code>DROPBOX_BRANCH_ROOTS</code> (comma-separated folder names, e.g. <code>Law ICAN Immigration,Some Broker</code>)</li>
          </ul>
        </div>`;
    } else if (!authorized) {
      statusHtml = `
        <div style="background:#fff8e1; border-left:4px solid #ff9800; padding:15px; border-radius:4px;">
          <strong>Configured, but not yet authorized.</strong>
          <p style="margin:8px 0;">Click below to grant Zara access to your Dropbox.</p>
          <a href="${dbx.authorizeUrl(DROPBOX_CALLBACK_URL)}" style="background:#0061FF; color:white; padding:10px 20px; border-radius:4px; text-decoration:none; display:inline-block; font-weight:600;">
            📦 Authorize Dropbox
          </a>
        </div>`;
    } else {
      statusHtml = `
        <div style="background:#e8f5e9; border-left:4px solid #4CAF50; padding:15px; border-radius:4px;">
          <strong>✅ Connected</strong>
          <div style="margin-top:8px; line-height:1.7;">
            Account: <strong>${settings.authorized_account_name || "-"}</strong> (${settings.authorized_email || ""})<br>
            Authorized: ${settings.last_authorized_at ? new Date(settings.last_authorized_at).toLocaleString() : "-"}<br>
            Last used: ${settings.last_used_at ? new Date(settings.last_used_at).toLocaleString() : "never"}
          </div>
          <div style="margin-top:12px;">
            <a href="${dbx.authorizeUrl(DROPBOX_CALLBACK_URL)}" style="background:#eee; color:#333; padding:8px 14px; border-radius:4px; text-decoration:none; font-size:13px;">Re-authorize</a>
          </div>
        </div>`;
    }

    const branchList = branches.length
      ? branches.map(b => `<li><code>${b}</code></li>`).join("")
      : `<li style="color:#888;">None configured yet.</li>`;

    const body = `
      <div class="page-header">
        <h1>📦 Dropbox Integration</h1>
        <a href="/admin/clients" class="back-link">← Clients</a>
      </div>

      ${statusHtml}

      <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-top:15px;">
        <h3 style="margin-top:0;">📁 Configured Branch Folders</h3>
        <p style="color:#666; font-size:13px;">Zara looks for each client's folder inside these top-level branches (in order). Change the <code>DROPBOX_BRANCH_ROOTS</code> env var in Render to update.</p>
        <ul>${branchList}</ul>
      </div>

      <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-top:15px;">
        <h3 style="margin-top:0;">How It Works</h3>
        <ol style="line-height:1.9;">
          <li>Client profiles auto-detect the matching Dropbox folder by searching branches for a folder named <code>Last, First</code>.</li>
          <li>Once found, the folder path is cached in Zara's database — subsequent loads are instant.</li>
          <li>Files uploaded via the profile go directly to the Dropbox folder.</li>
          <li>Deletes from Zara also delete from Dropbox (with confirmation).</li>
          <li>Downloads use temporary Dropbox links (served directly by Dropbox, not proxied through Zara).</li>
        </ol>
      </div>

      <div style="background:white; padding:20px; border-radius:6px; border:1px solid #eee; margin-top:15px;">
        <h3 style="margin-top:0;">Callback URL</h3>
        <p style="color:#666; font-size:13px;">Add this exact URL to your Dropbox app's "Redirect URIs" in the OAuth 2 settings:</p>
        <code style="display:block; background:#f5f5f5; padding:10px; border-radius:4px; word-break:break-all;">${DROPBOX_CALLBACK_URL}</code>
      </div>`;

    res.send(hn.renderAdminChrome({ title: "Dropbox Setup", body, activeItem: "dropbox" }));
  } catch (err) {
    console.error("[dropbox setup]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.get("/admin/dropbox/callback", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const code = req.query.code;
    if (!code) return res.status(400).send(`<h1>Missing authorization code</h1><p>${req.query.error_description || ""}</p>`);
    const tokens = await dbx.exchangeCodeForToken(code, DROPBOX_CALLBACK_URL);

    // Fetch account info for display + team namespace ID for team folder access
    let accountName = null, accountEmail = null, accountId = tokens.account_id || null, rootNamespaceId = null;
    try {
      const acctResp = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
        },
        body: "null",
      });
      if (!acctResp.ok) throw new Error(`HTTP ${acctResp.status}`);
      const acctData = await acctResp.json();
      accountName = acctData.name?.display_name || null;
      accountEmail = acctData.email || null;
      accountId = acctData.account_id || accountId;
      rootNamespaceId = acctData.root_info?.root_namespace_id || null;
    } catch (e) {
      console.warn("[dropbox callback] could not fetch account info:", e.message);
    }

    await dbx.saveRefreshToken({
      refresh_token: tokens.refresh_token,
      account_id: accountId,
      account_name: accountName,
      email: accountEmail,
      root_namespace_id: rootNamespaceId,
    });
    // Force cache reset so next API call uses new tokens + namespace
    if (dbx.resetTokenCache) dbx.resetTokenCache();

    res.redirect("/admin/dropbox/setup?connected=1");
  } catch (err) {
    console.error("[dropbox callback]:", err.message);
    res.status(500).send(`<h1>Authorization failed</h1><p>${err.message}</p><p><a href="/admin/dropbox/setup">Try again</a></p>`);
  }
});

// List Dropbox files for a client (JSON)
app.get("/admin/clients/:key/dropbox/files", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const dbx = require("./dropbox-integration");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    const result = await dbx.listClientFiles({
      clientKey: client.key,
      clientName: client.client_name,
      aNumber: client.a_number,
      useCache: req.query.fresh !== "1",
    });

    // If no folder was auto-resolved, include suggestions so the UI can offer "did you mean" picks
    if (!result.resolved) {
      try {
        const suggestions = await dbx.suggestClientFolders({
          clientName: client.client_name,
          aNumber: client.a_number,
          limit: 8,
        });
        return res.json({ ok: true, ...result, suggestions });
      } catch (e) {
        return res.json({ ok: true, ...result, suggestions: [], suggestions_error: e.message });
      }
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[dropbox files list]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get folder suggestions for a client without altering current mapping
app.get("/admin/clients/:key/dropbox/suggest", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const dbx = require("./dropbox-integration");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    const suggestions = await dbx.suggestClientFolders({
      clientName: client.client_name,
      aNumber: client.a_number,
      limit: 20,
    });
    res.json({ ok: true, suggestions });
  } catch (err) {
    console.error("[dropbox suggest]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Upload a file to the client's Dropbox folder
app.post("/admin/clients/:key/dropbox/upload", docUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const cp = require("./client-profiles");
    const dbx = require("./dropbox-integration");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });

    let folder = await dbx.resolveClientFolder({
      clientKey: client.key,
      clientName: client.client_name,
      aNumber: client.a_number,
    });
    if (!folder) {
      return res.status(400).json({
        ok: false,
        error: "Client's Dropbox folder not found. Use the 'Change folder' option on the profile to set it manually.",
      });
    }

    const originalName = (req.body.original_filename || req.file.originalname || "file").trim();
    const uploadPath = `${folder}/${originalName}`;
    const result = await dbx.uploadFile({
      path: uploadPath,
      buffer: req.file.buffer,
      autorename: true,
    });
    dbx.clearListCache(folder);
    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req, action: audit.ACTIONS.DROPBOX_FILE_UPLOADED,
        target_type: "dropbox_file", target_id: result.path_display, target_label: client.client_name,
        changes: { filename: result.name, size: result.size },
      });
    } catch { /* silent */ }
    res.json({ ok: true, path: result.path_display, name: result.name, size: result.size });
  } catch (err) {
    console.error("[dropbox upload]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Download a file from Dropbox (redirects to temporary link)
// Return a Dropbox temporary link as JSON (used by exhibit link opener)
app.get("/admin/dropbox/temp-link", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ ok: false, error: "Missing path" });
    const link = await dbx.getTemporaryLink(filePath);
    res.json({ ok: true, link });
  } catch (err) {
    console.error("[dropbox temp-link]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/clients/:key/dropbox/download", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const filePath = req.query.path;
    if (!filePath) return res.status(400).send("Missing path");
    const link = await dbx.getTemporaryLink(filePath);
    res.redirect(link);
  } catch (err) {
    console.error("[dropbox download]:", err.message);
    res.status(500).send(`Error: ${err.message}`);
  }
});

// Delete a file from Dropbox
app.post("/admin/clients/:key/dropbox/delete", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const cp = require("./client-profiles");
    const filePath = req.body.path;
    if (!filePath) return res.status(400).json({ ok: false, error: "Missing path" });
    await dbx.deleteFile(filePath);
    // Clear cache for that folder
    const client = await cp.getClientByKey(req.params.key);
    if (client) {
      const folder = await dbx.resolveClientFolder({
        clientKey: client.key, clientName: client.client_name, aNumber: client.a_number,
      });
      if (folder) dbx.clearListCache(folder);
    }
    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req, action: audit.ACTIONS.DROPBOX_FILE_DELETED,
        target_type: "dropbox_file", target_id: filePath, target_label: client?.client_name || null,
      });
    } catch { /* silent */ }
    res.json({ ok: true });
  } catch (err) {
    console.error("[dropbox delete]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Set / override / clear the Dropbox folder mapping for a client
app.post("/admin/clients/:key/dropbox/mapping", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const dbx = require("./dropbox-integration");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) {
      if (req.accepts("html")) return res.status(404).send("Client not found");
      return res.status(404).json({ ok: false, error: "Client not found" });
    }
    const path = (req.body.path || "").trim();
    const isFormPost = !req.xhr && (req.get("content-type") || "").includes("form-urlencoded") && req.accepts("html");

    if (path === "") {
      await dbx.clearClientFolderMapping(client.key);
      if (isFormPost) return res.redirect(`/admin/clients/${client.key}/dropbox/debug`);
      return res.json({ ok: true, cleared: true });
    }
    const meta = await dbx.getMetadata(path);
    if (!meta || meta[".tag"] !== "folder") {
      if (isFormPost) return res.status(400).send(`<h1>Not a Dropbox folder</h1><p><code>${path}</code></p><a href="/admin/clients/${client.key}/dropbox/debug">← Back</a>`);
      return res.status(400).json({ ok: false, error: `Not a Dropbox folder: ${path}` });
    }
    await dbx.setClientFolderMapping({
      clientKey: client.key,
      aNumber: client.a_number,
      clientName: client.client_name,
      dropboxPath: path,
    });
    dbx.clearListCache(path);
    if (isFormPost) return res.redirect(`/admin/clients/${client.key}`);
    res.json({ ok: true, path });
  } catch (err) {
    console.error("[dropbox mapping]:", err.message);
    if (req.accepts("html")) return res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/clients/:key", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const cd = require("./client-documents");
    const client = await cp.getClientByKey(req.params.key);
    let documents = [];
    if (client) {
      documents = await cd.listDocuments(client.key, client.a_number);
    }
    res.send(cp.renderClientDetail(client, { documents }));
  } catch (err) {
    console.error("[/admin/clients/:key]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Upload a document to a client's file
app.post("/admin/clients/:key/documents", docUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const cp = require("./client-profiles");
    const cd = require("./client-documents");
    const client = await cp.getClientByKey(req.params.key);
    if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
    const originalName = (req.body.original_filename || req.file.originalname || "file").trim();
    const result = await cd.uploadDocument({
      clientKey: client.key,
      clientName: client.client_name,
      aNumber: client.a_number,
      filename: originalName,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
      category: (req.body.category || "").trim() || null,
      description: (req.body.description || "").trim() || null,
    });
    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req, action: audit.ACTIONS.CLIENT_DOC_UPLOADED,
        target_type: "client_document", target_id: result.id || null, target_label: client.client_name,
        changes: { filename: originalName, size: req.file.buffer.length, category: req.body.category || null },
      });
    } catch { /* silent */ }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[client docs upload]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Download a client document
app.get("/admin/clients/:key/documents/:id/download", async (req, res) => {
  try {
    const cd = require("./client-documents");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const doc = await cd.getDocument(id);
    if (!doc) return res.status(404).send("Not found");
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    // Content-Disposition — safely encode filename for headers with special chars
    const safe = String(doc.filename).replace(/["\\\r\n]/g, "_");
    const encoded = encodeURIComponent(doc.filename);
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`);
    res.setHeader("Content-Length", doc.file_data.length);
    res.end(doc.file_data);
  } catch (err) {
    console.error("[client docs download]:", err.message);
    res.status(500).send(`Error: ${err.message}`);
  }
});

// Delete a client document
app.delete("/admin/clients/:key/documents/:id", async (req, res) => {
  try {
    const cd = require("./client-documents");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await cd.deleteDocument(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[client docs delete]:", err.message);
    res.status(err.message.includes("not found") ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// ── Unified Hearing History ──────────────────────────────
// Combines master + individual hearing notes into one searchable/filterable
// list. Every row has an "edit" link that goes to the appropriate editor.
app.get("/admin/hearing/history", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const ih = require("./individual-hearing-notes");
    const [masterRows, individualRows] = await Promise.all([
      hn.listNotes(200),
      ih.listIndividualNotes(200),
    ]);

    // Normalize rows into a unified shape
    const normalized = [];
    for (const m of masterRows) {
      normalized.push({
        kind: "master",
        id: m.id,
        edit_url: `/admin/hearing/notes/${m.id}`,
        type_label: m.hearing_type || "master",
        sequence: m.sequence,
        sequence_total: m.sequence_total,
        client_name: m.client_name,
        a_number: m.a_number,
        client_language: m.client_language,
        hearing_date: m.hearing_date,
        judge_name: null,
        sent_to_paralegal_at: m.sent_to_paralegal_at,
        created_at: m.created_at,
      });
    }
    for (const i of individualRows) {
      normalized.push({
        kind: "individual",
        id: i.id,
        edit_url: `/admin/hearing/individual/${i.id}`,
        type_label: "individual",
        sequence: null,
        sequence_total: null,
        client_name: i.client_name,
        a_number: i.a_number,
        client_language: i.client_language,
        hearing_date: i.hearing_date,
        judge_name: i.judge_name,
        sent_to_paralegal_at: i.sent_to_paralegal_at,
        created_at: i.created_at,
      });
    }
    // Sort by created_at desc
    normalized.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.send(renderUnifiedHistory(normalized));
  } catch (err) {
    console.error("[/admin/hearing/history]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

function renderUnifiedHistory(rows) {
  const hn = require("./hearing-notes");

  const html = require("./hearing-notes"); // reuse escapes if exported? not exported — inline them here
  const esc = (s) => s == null ? "" : String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");

  const tbody = rows.length ? rows.map(r => {
    const seqBadge = r.sequence_total && r.sequence_total > 1
      ? ` <span style="background:#B79C62; color:white; padding:1px 6px; border-radius:8px; font-size:11px;">#${r.sequence}/${r.sequence_total}</span>`
      : "";
    const kindBadge = r.kind === "individual"
      ? `<span style="background:#0C1C36; color:#B79C62; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">INDIV</span>`
      : `<span style="background:#B79C62; color:white; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">MASTER</span>`;
    const deleteUrl = r.kind === "master" ? `/admin/hearing/notes/${r.id}` : `/admin/hearing/individual/${r.id}`;
    return `
    <tr class="h-row"
        data-kind="${r.kind}"
        data-type="${esc((r.type_label || "").toLowerCase())}"
        data-name="${esc((r.client_name || "").toLowerCase())}"
        data-anumber="${esc((r.a_number || "").toLowerCase().replace(/[-\s]/g, ""))}"
        data-judge="${esc((r.judge_name || "").toLowerCase())}"
        data-sent="${r.sent_to_paralegal_at ? "sent" : "unsent"}"
        data-lang="${esc(r.client_language || "")}">
      <td>${kindBadge} #${r.id}</td>
      <td>${esc(r.type_label || "-")}${seqBadge}</td>
      <td>${esc(r.client_name)}</td>
      <td>${esc(r.a_number || "")}</td>
      <td>${r.hearing_date ? new Date(r.hearing_date).toLocaleDateString() : "-"}</td>
      <td>${esc(r.judge_name || "-")}</td>
      <td>${r.client_language}</td>
      <td>${r.sent_to_paralegal_at ? "✅" : "—"}</td>
      <td>${new Date(r.created_at).toLocaleDateString()}</td>
      <td>
        <a href="${r.edit_url}" style="color:#B79C62;">edit</a>
        &nbsp;·&nbsp;
        <a href="#" onclick="delRow('${r.kind}', ${r.id}, ${JSON.stringify(r.client_name).replace(/"/g, '&quot;')}); return false;" style="color:#c00; font-size:12px;">🗑️</a>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="10" style="text-align:center; color:#888;">No hearing notes yet.</td></tr>`;

  const body = `
    <div class="page-header">
      <h1>📚 All Hearing Notes</h1>
      <div>
        <a href="/admin/hearing/notes" class="back-link">+ New master hearing</a>
        &nbsp;·&nbsp;
        <a href="/admin/hearing/individual" class="back-link">+ New individual hearing</a>
      </div>
    </div>

    <div style="background:white; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #eee;">
      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        <div style="flex:1; min-width:260px;">
          <input type="text" id="search-input" placeholder="🔍 Search by client name, A-Number, or judge..."
                 onkeyup="filterRows()"
                 style="width:100%; padding:9px 12px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
        </div>
        <div>
          <select id="filter-kind" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All hearings</option>
            <option value="master">Master hearings only</option>
            <option value="individual">Individual hearings only</option>
          </select>
        </div>
        <div>
          <select id="filter-type" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All types</option>
            <option value="master">Master</option>
            <option value="individual">Individual</option>
            <option value="individual/merits">Individual/Merits</option>
            <option value="status">Status</option>
            <option value="bond">Bond</option>
            <option value="custody redetermination">Custody Redetermination</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <select id="filter-sent" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All</option>
            <option value="sent">Sent ✅</option>
            <option value="unsent">Not sent</option>
          </select>
        </div>
        <div>
          <select id="filter-lang" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All languages</option>
            <option value="en">English</option>
            <option value="zh">Chinese</option>
            <option value="es">Spanish</option>
            <option value="hi">Hindi</option>
            <option value="pa">Punjabi</option>
          </select>
        </div>
        <div>
          <button type="button" onclick="clearFilters()"
                  style="padding:9px 14px; background:#eee; border:none; border-radius:4px; cursor:pointer; font-size:13px;">
            Clear
          </button>
        </div>
      </div>
      <div id="row-count" style="margin-top:10px; font-size:13px; color:#666;">
        Showing ${rows.length} note${rows.length === 1 ? "" : "s"}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>ID</th><th>Type</th><th>Client</th><th>A#</th><th>Hearing</th>
          <th>Judge</th><th>Lang</th><th>Sent</th><th>Created</th><th></th>
        </tr>
      </thead>
      <tbody id="rows-body">${tbody}</tbody>
    </table>

    <script>
      const TOTAL = ${rows.length};
      function filterRows() {
        const search = document.getElementById("search-input").value.toLowerCase().replace(/[-\\s]/g, "");
        const kind = document.getElementById("filter-kind").value;
        const type = document.getElementById("filter-type").value;
        const sent = document.getElementById("filter-sent").value;
        const lang = document.getElementById("filter-lang").value;
        let visible = 0;
        document.querySelectorAll(".h-row").forEach(row => {
          const name = row.dataset.name || "";
          const anumber = row.dataset.anumber || "";
          const judge = row.dataset.judge || "";
          const matchesSearch = !search || name.includes(search) || anumber.includes(search) || judge.includes(search);
          const matchesKind = !kind || row.dataset.kind === kind;
          const matchesType = !type || row.dataset.type === type;
          const matchesSent = !sent || row.dataset.sent === sent;
          const matchesLang = !lang || row.dataset.lang === lang;
          const show = matchesSearch && matchesKind && matchesType && matchesSent && matchesLang;
          row.style.display = show ? "" : "none";
          if (show) visible++;
        });
        const count = document.getElementById("row-count");
        if (visible === TOTAL) count.textContent = "Showing " + TOTAL + " note" + (TOTAL === 1 ? "" : "s");
        else count.textContent = "Showing " + visible + " of " + TOTAL + " notes";
      }
      function clearFilters() {
        document.getElementById("search-input").value = "";
        document.getElementById("filter-kind").value = "";
        document.getElementById("filter-type").value = "";
        document.getElementById("filter-sent").value = "";
        document.getElementById("filter-lang").value = "";
        filterRows();
      }
      async function delRow(kind, id, name) {
        if (!confirm("Delete " + kind + " hearing note #" + id + " for " + name + "?")) return;
        const url = kind === "master" ? "/admin/hearing/notes/" + id : "/admin/hearing/individual/" + id;
        try {
          const resp = await fetch(url, { method: "DELETE" });
          const data = await resp.json();
          if (data.ok) {
            const rows = document.querySelectorAll(".h-row");
            for (const r of rows) {
              if (r.querySelector('a[href="' + (kind === "master" ? "/admin/hearing/notes/" + id : "/admin/hearing/individual/" + id) + '"]')) {
                r.remove();
                break;
              }
            }
            filterRows();
          } else {
            alert("❌ " + (data.error || "delete failed"));
          }
        } catch (e) { alert("❌ " + e.message); }
      }
    </script>`;

  return hn.renderAdminChrome({
    title: "All Hearing Notes",
    body,
    activeItem: "history",
  });
}

// GET /admin/hearing/individual/prior-lookup?name=...&a=...
app.get("/admin/hearing/individual/prior-lookup", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const note = await hn.getMostRecentForClient({
      clientName: req.query.name || "",
      aNumber: req.query.a || "",
    });
    if (!note) return res.json({ ok: true, note: null });
    // Return only the fields we need on the form
    res.json({
      ok: true,
      note: {
        id: note.id,
        client_name: note.client_name,
        a_number: note.a_number,
        client_email: note.client_email,
        client_phone: note.client_phone,
        client_address: note.client_address,
        client_language: note.client_language,
        case_type: note.case_type,
        judge_name: note.judge_name,
        dhs_attorney: note.dhs_attorney,
        created_at: note.created_at,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Extract hearing summary from PDF, Word (.docx), or text file.
// Registered BEFORE the /:id route so Express matches this specific path first.
app.post("/admin/hearing/individual/extract-summary", docUpload.single("summary"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const ih = require("./individual-hearing-notes");
    const name = req.file.originalname || "summary";
    const mime = req.file.mimetype || "";
    const isPdf  = mime.includes("pdf") || /\.pdf$/i.test(name);
    const isText = mime.startsWith("text/") || /\.(txt|md)$/i.test(name);
    const isDocx =
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      /\.docx$/i.test(name);
    const isDoc  = /\.doc$/i.test(name) && !isDocx;

    let extracted, rawText = null;
    if (isPdf) {
      extracted = await ih.extractHearingSummary({
        pdfBuffer: req.file.buffer,
        mimeType: "application/pdf",
        filename: name,
      });
    } else if (isDocx) {
      // Word .docx — extract plain text with mammoth, then run through Claude
      const mammoth = require("mammoth");
      try {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        rawText = (result.value || "").trim();
        if (!rawText) {
          return res.status(400).json({
            ok: false,
            error: "Word document appears to be empty or contains only images.",
          });
        }
      } catch (e) {
        return res.status(400).json({
          ok: false,
          error: `Could not read Word document: ${e.message}. Try saving as PDF instead.`,
        });
      }
      // Try the AI extraction — but if it fails, still return the raw text
      // so the attorney can save it to the note and manually work from it.
      try {
        extracted = await ih.extractHearingSummary({ textContent: rawText, filename: name });
      } catch (e) {
        return res.status(200).json({
          ok: true,
          extracted: { witnesses: [], examinations: [], closing_argument: "", case_summary: "" },
          raw_text: rawText,
          warning: e.message,
        });
      }
    } else if (isText) {
      rawText = req.file.buffer.toString("utf8");
      extracted = await ih.extractHearingSummary({ textContent: rawText, filename: name });
    } else if (isDoc) {
      return res.status(400).json({
        ok: false,
        error: "Old-format .doc files aren't supported — please save as .docx or PDF and re-upload.",
      });
    } else {
      return res.status(400).json({
        ok: false,
        error: "File must be PDF, Word (.docx), or text (.txt/.md).",
      });
    }
    res.json({ ok: true, extracted, raw_text: rawText });
  } catch (err) {
    console.error("[extract-summary]:", err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
});

// Parse Excel/CSV exhibit list. Registered BEFORE the /:id route.
app.post("/admin/hearing/individual/extract-exhibits", docUpload.single("exhibits"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const ih = require("./individual-hearing-notes");
    const name = req.file.originalname || "exhibits.xlsx";
    if (!/\.(xlsx|xls|csv)$/i.test(name)) {
      return res.status(400).json({ ok: false, error: "File must be .xlsx, .xls, or .csv" });
    }
    const result = ih.parseExhibitExcel(req.file.buffer, name);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[extract-exhibits]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Server-side auto-match: uses Claude Sonnet to intelligently match
// exhibit descriptions to actual Dropbox filenames.
// Much more accurate than token-overlap because Claude understands context
// (e.g. "Passport" matches "SCAN_2024_01_15_travel_doc.pdf" when needed).
//
// Body: { client_name, a_number, exhibits: [{idx, description, eoir_submission}, ...] }
// Returns: { matches: [{idx, dropbox_file_path, confidence, reason}, ...] }
app.post("/admin/hearing/individual/dropbox/auto-match", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const clientName = String(req.body.client_name || "").trim();
    const aNumber = String(req.body.a_number || "").trim();
    const exhibits = Array.isArray(req.body.exhibits) ? req.body.exhibits : [];

    if (!clientName && !aNumber) {
      return res.status(400).json({ ok: false, error: "Client name or A-Number required" });
    }
    if (!exhibits.length) {
      return res.status(400).json({ ok: false, error: "No exhibits provided" });
    }

    // Resolve client's Dropbox root folder
    const clientKey = dbx.makeClientKey({ clientName, aNumber });
    const rootFolder = await dbx.resolveClientFolder({
      clientKey, clientName, aNumber,
    });
    if (!rootFolder) {
      return res.status(404).json({
        ok: false,
        error: `No Dropbox folder found for ${clientName || aNumber}. Link one via the client profile first.`,
      });
    }

    // Recursively fetch ALL files under client folder (up to 4 levels deep,
    // covers structure like /CLIENT/EOR-1/subfolder/file.pdf)
    console.log(`[auto-match] Scanning Dropbox folder: ${rootFolder}`);
    const allFiles = await gatherAllFilesRecursive(dbx, rootFolder, 4);
    console.log(`[auto-match] Found ${allFiles.length} files under ${rootFolder}`);

    if (!allFiles.length) {
      return res.json({
        ok: true,
        folder: rootFolder,
        matches: [],
        total_files: 0,
        warning: "No files found in Dropbox folder. Verify the folder has documents.",
      });
    }

    // Build the prompt for Claude
    const filesList = allFiles.map((f, i) => {
      const rel = f.path.startsWith(rootFolder) ? f.path.substring(rootFolder.length) : f.path;
      return `${i + 1}. ${f.name}   [path: ${rel}]`;
    }).join("\n");

    const exhibitsList = exhibits.map((e, i) =>
      `${i + 1}. ${e.description}${e.eoir_submission ? ` (EOIR: ${e.eoir_submission})` : ""}`
    ).join("\n");

    const prompt = `You are matching legal exhibit descriptions to Dropbox filenames for an immigration hearing.

The exhibits (from an EOIR exhibit list) are:
${exhibitsList}

The available Dropbox files (in the client's folder) are:
${filesList}

Your task: For EACH exhibit, identify the SINGLE best matching file from the list above.

Matching guidance:
- "Passport" matches files with "passport", "travel doc", or "identity" in the name/path
- "I-589" or "asylum application" matches "i589", "asylum", or "application" files
- "NTA" or "Notice to Appear" matches "NTA", "notice to appear", "I-862" files
- "Birth Certificate" matches "birth cert", "BC", "acta de nacimiento"
- "Country Conditions" matches files with the country name + reports, or "HRW", "State Dept", "human rights"
- "Medical Records" matches files with "medical", "hospital", "clinic", "psych", "MD"
- "Declaration" matches files with "decl", "statement", "affidavit"
- "Translation" matches files with "translation", "cert. translation", "trans"
- If a file is in a subfolder matching the EOIR submission (e.g. "EOR-1"), that's a stronger signal
- Files may have client's name prefixed (e.g. "Kong_passport.pdf") — the client's name is not part of the exhibit description
- Files may be in Chinese, Spanish, or other languages — match by meaning if possible
- If NO file reasonably matches an exhibit, return null for that exhibit's match

Respond with ONLY a JSON array (no preamble, no code fences). Each entry represents one exhibit in the order given above:

[
  {"exhibit_num": 1, "file_num": 3, "confidence": "high", "reason": "Filename directly says 'passport'"},
  {"exhibit_num": 2, "file_num": null, "confidence": "none", "reason": "No I-589 file found"},
  {"exhibit_num": 3, "file_num": 7, "confidence": "medium", "reason": "File in EOR-1 folder matches submission ref"}
]

Confidence levels:
- "high": obvious match, filename directly maps to description
- "medium": likely match based on partial words, folder context, or inference
- "low": possible but ambiguous — attorney should verify
- "none": no reasonable match found

Do not repeat the same file for multiple exhibits unless it truly represents multiple exhibit numbers.`;

    // Use Anthropic's tool use to force a structured JSON response.
    // Tool use guarantees Claude returns data matching our schema — no more
    // "invalid JSON" errors from preambles, code fences, or trailing text.
    console.log(`[auto-match v3-tooluse] Sending ${exhibits.length} exhibits + ${allFiles.length} files to Claude`);
    const anthResp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        tools: [{
          name: "report_matches",
          description: "Report the exhibit-to-file matches for the immigration hearing exhibit list.",
          input_schema: {
            type: "object",
            properties: {
              matches: {
                type: "array",
                description: "One entry per exhibit, in the order the exhibits were given.",
                items: {
                  type: "object",
                  properties: {
                    exhibit_num: {
                      type: "integer",
                      description: "1-based exhibit number from the input list",
                    },
                    file_num: {
                      type: ["integer", "null"],
                      description: "1-based file number from the file list, or null if no match",
                    },
                    confidence: {
                      type: "string",
                      enum: ["high", "medium", "low", "none"],
                    },
                    reason: {
                      type: "string",
                      description: "Brief reason for the match or non-match",
                    },
                  },
                  required: ["exhibit_num", "confidence", "reason"],
                },
              },
            },
            required: ["matches"],
          },
        }],
        tool_choice: { type: "tool", name: "report_matches" },
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    // Extract from tool_use block. This is the guaranteed-structured path.
    let claudeMatches = null;
    const contentBlocks = anthResp.data.content || [];
    const toolUseBlock = contentBlocks.find(b => b.type === "tool_use" && b.name === "report_matches");
    if (toolUseBlock && Array.isArray(toolUseBlock.input?.matches)) {
      claudeMatches = toolUseBlock.input.matches;
      console.log(`[auto-match v3-tooluse] ✓ Tool call returned ${claudeMatches.length} matches`);
    } else {
      // Fallback: try to extract JSON from any text blocks. Some edge cases
      // (rate limits, model refusals, older model versions without tool support)
      // return a text block instead of a tool use call.
      const textBlock = contentBlocks.find(b => b.type === "text")?.text || "";
      console.warn(`[auto-match v3-tooluse] ⚠️  No tool_use block. Content types: ${contentBlocks.map(b => b.type).join(",")}. Falling back to text parse.`);
      claudeMatches = extractJsonArrayFromText(textBlock);
      if (!claudeMatches) {
        console.error("[auto-match v3-tooluse] Claude did not call the tool AND text was unparseable. Response:",
          JSON.stringify(anthResp.data.content).substring(0, 1000));
        return res.status(500).json({
          ok: false,
          error: "Claude didn't return matches in a usable format (v3-tooluse). Try again in a moment or match manually.",
          debug_snippet: textBlock.substring(0, 200),
          content_types: contentBlocks.map(b => b.type),
          stop_reason: anthResp.data.stop_reason,
        });
      }
      console.log(`[auto-match v3-tooluse] Fallback parsed ${claudeMatches.length} matches from text`);
    }

    // Map Claude's response back to exhibit indices with actual file paths
    const matches = exhibits.map((exhibit, i) => {
      const claudeMatch = claudeMatches.find(m => m.exhibit_num === i + 1);
      if (!claudeMatch || claudeMatch.file_num == null) {
        return {
          idx: exhibit.idx,
          description: exhibit.description,
          dropbox_file_path: null,
          matched_filename: null,
          confidence: "none",
          reason: claudeMatch?.reason || "No match returned",
        };
      }
      const file = allFiles[claudeMatch.file_num - 1];
      if (!file) {
        return {
          idx: exhibit.idx,
          description: exhibit.description,
          dropbox_file_path: null,
          matched_filename: null,
          confidence: "none",
          reason: "Claude referenced a file that doesn't exist",
        };
      }
      return {
        idx: exhibit.idx,
        description: exhibit.description,
        dropbox_file_path: file.path,
        matched_filename: file.name,
        confidence: claudeMatch.confidence || "medium",
        reason: claudeMatch.reason || "",
      };
    });

    res.json({
      ok: true,
      folder: rootFolder,
      total_files: allFiles.length,
      matches,
    });
  } catch (err) {
    console.error("[auto-match]:", err.message, err.response?.data || "");
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
});

// Robust JSON array extractor — handles preamble, trailing text, code fences.
// Used as a fallback path when Claude returns a text block instead of a
// tool_use block. Bracket-matching that respects strings/escapes.
function extractJsonArrayFromText(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();

  // Try direct parse first (fast path)
  try { const p = JSON.parse(trimmed); if (Array.isArray(p)) return p; } catch { /* continue */ }

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  let candidate = trimmed
    .replace(/^```(?:json|javascript|js)?\s*\n?/im, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
  try { const p = JSON.parse(candidate); if (Array.isArray(p)) return p; } catch { /* continue */ }

  // Find first '[' and its matching ']' by walking brackets while respecting
  // strings and escape sequences. Handles preamble like "Here's the JSON:" or
  // trailing explanation like "\nNote: ..." after the array.
  const start = candidate.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "[") depth++;
    else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;

  try {
    const p = JSON.parse(candidate.substring(start, end + 1));
    return Array.isArray(p) ? p : null;
  } catch { return null; }
}

// Recursively gather all files under a Dropbox folder, up to maxDepth deep.
// Uses listFolder for each level (respects team namespace via dropbox-integration).
async function gatherAllFilesRecursive(dbx, path, maxDepth) {
  const collected = [];
  async function walk(currentPath, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await dbx.listFolder(currentPath);
    } catch (e) {
      console.warn(`[gather] listFolder(${currentPath}) failed:`, e.message);
      return;
    }
    if (!entries) return;
    for (const entry of entries) {
      if (entry[".tag"] === "file") {
        collected.push({
          name: entry.name,
          path: entry.path_display,
          size: entry.size,
          parent: currentPath,
          parentName: currentPath.split("/").pop() || currentPath,
        });
      } else if (entry[".tag"] === "folder" && depth < maxDepth) {
        await walk(entry.path_display, depth + 1);
      }
    }
  }
  await walk(path, 1);
  return collected;
}

// Browse a client's Dropbox folder from within the individual hearing form —
// used by the "Browse Dropbox → add as exhibits" modal picker.
// Query params: client_name, a_number (either or both), optional subfolder path.
// Returns folder + breadcrumb + subfolders + files as JSON.
app.get("/admin/hearing/individual/dropbox/files", async (req, res) => {
  try {
    const dbx = require("./dropbox-integration");
    const clientName = (req.query.client_name || "").trim();
    const aNumber = (req.query.a_number || "").trim();
    const requestedSubfolder = (req.query.subfolder || "").trim();

    if (!clientName && !aNumber) {
      return res.status(400).json({ ok: false, error: "Client name or A-Number required" });
    }

    // Build a client key using the same logic as the client-profiles aggregator
    const clientKey = dbx.makeClientKey({ clientName, aNumber });
    if (!clientKey) {
      return res.status(400).json({ ok: false, error: "Could not derive client key" });
    }

    // Resolve (or reuse cached) root folder for this client
    const rootFolder = await dbx.resolveClientFolder({
      clientKey, clientName, aNumber,
    });
    if (!rootFolder) {
      return res.status(404).json({
        ok: false,
        error: `No Dropbox folder found for ${clientName || aNumber}. Link one via the client profile first.`,
      });
    }

    // Determine which folder to list: requested subfolder must be under rootFolder
    let currentPath = rootFolder;
    if (requestedSubfolder) {
      if (!requestedSubfolder.startsWith(rootFolder)) {
        return res.status(400).json({ ok: false, error: "Subfolder must be inside the client folder" });
      }
      currentPath = requestedSubfolder;
    }

    const entries = await dbx.listFolder(currentPath);
    if (!entries) return res.status(404).json({ ok: false, error: `Folder not found: ${currentPath}` });

    const subfolders = entries
      .filter(e => e[".tag"] === "folder")
      .map(e => ({ name: e.name, path: e.path_display }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries
      .filter(e => e[".tag"] === "file")
      .map(e => ({
        name: e.name,
        path: e.path_display,
        size: e.size,
        server_modified: e.server_modified,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Breadcrumb from root down to currentPath
    const breadcrumb = [];
    if (rootFolder) {
      const rootName = rootFolder.split("/").pop() || rootFolder;
      breadcrumb.push({ name: rootName, path: null });   // null path = go to root
      if (currentPath !== rootFolder) {
        const rel = currentPath.substring(rootFolder.length).split("/").filter(Boolean);
        let acc = rootFolder;
        for (const seg of rel) {
          acc += "/" + seg;
          breadcrumb.push({ name: seg, path: acc });
        }
      }
    }

    res.json({
      ok: true,
      folder: rootFolder,
      current_path: currentPath,
      breadcrumb,
      subfolders,
      files,
    });
  } catch (err) {
    console.error("[individual dropbox browse]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/hearing/individual/:id", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const note = await ih.getIndividualNote(id);
    if (!note) return res.status(404).send("Not found");
    // Find sibling individual hearings for the same client (for continuation tabs)
    const siblings = await ih.getIndividualNotesForClient({
      clientName: note.client_name,
      aNumber: note.a_number,
    });
    res.send(ih.renderForm({
      noteId: id,
      prev: note,
      siblings,
      saved: req.query.saved === "1",
    }));
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/individual/:id", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const parsed = ih.parseFormSubmission(req.body);
    if (!parsed.client_name) {
      const siblings = await ih.getIndividualNotesForClient({
        clientName: parsed.client_name,
        aNumber: parsed.a_number,
      });
      return res.send(ih.renderForm({ noteId: id, error: "Client name is required.", prev: parsed, siblings }));
    }
    await ih.saveIndividualNote(parsed, id);
    // Audit log
    try {
      const audit = require("./audit-log");
      await audit.log({
        req, action: audit.ACTIONS.HEARING_UPDATED,
        target_type: "individual_hearing", target_id: id, target_label: parsed.client_name,
      });
    } catch { /* silent */ }
    res.redirect(`/admin/hearing/individual/${id}?saved=1`);
  } catch (err) {
    console.error("[/admin/hearing/individual/:id POST]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Autosave endpoint — same save logic, returns JSON instead of redirect.
// Called by the client every 5 seconds when form is dirty.
app.post("/admin/hearing/individual/:id/autosave", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const parsed = ih.parseFormSubmission(req.body);
    // For autosave, tolerate missing client_name (user might be mid-typing)
    if (!parsed.client_name) {
      return res.json({ ok: false, error: "Client name required for save", skip: true });
    }
    await ih.saveIndividualNote(parsed, id);
    res.json({ ok: true, id, saved_at: new Date().toISOString() });
  } catch (err) {
    console.error("[individual autosave]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/admin/hearing/individual/:id", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await ih.deleteIndividualNote(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// Generate AI paralegal + client summaries for a saved individual hearing
app.post("/admin/hearing/individual/:id/generate-summaries", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await ih.generateAndSaveSummaries(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[individual generate-summaries]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send paralegal summary of an individual hearing to team Telegram group
app.post("/admin/hearing/individual/:id/send-paralegal", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await ih.sendToTeamGroup(id);
    // Audit log
    try {
      const audit = require("./audit-log");
      const note = await ih.getIndividualNote(id).catch(() => ({}));
      await audit.log({
        req, action: audit.ACTIONS.HEARING_SUMMARY_SENT,
        target_type: "individual_hearing", target_id: id, target_label: note?.client_name || null,
      });
    } catch { /* silent */ }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[individual send-paralegal]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Extract hearing summary from PDF or text file
// Extract routes moved to earlier in the file — see /admin/hearing/individual/extract-summary
// and /admin/hearing/individual/extract-exhibits above the /:id route.

// Document upload + extract — accepts PDF, JPG, PNG, WebP.
// Uses Claude vision to OCR + extract structured client/case data.
// (docUpload is declared near the top of this file — see near sendgridUpload.)

async function handleExtract(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }
    const name = req.file.originalname || "upload";
    const mime = req.file.mimetype || "";
    const isPdf   = mime.includes("pdf")    || /\.pdf$/i.test(name);
    // Accept HEIC/HEIF (iPhone photos) — they'll be normalized to image/jpeg below.
    const isImage = mime.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(name);
    if (!isPdf && !isImage) {
      return res.status(400).json({ ok: false, error: "Unsupported file type. Use PDF, JPG, PNG, WebP, or HEIC." });
    }
    // Normalize MIME type. Browsers/iOS often send empty or generic MIME for
    // heic files, and Anthropic vision API doesn't accept image/heic — so
    // we relabel as image/jpeg. The raw bytes go through unchanged; Claude
    // decodes based on file magic bytes.
    let effectiveMime = mime;
    if (!effectiveMime || effectiveMime === "application/octet-stream") {
      if (isPdf) effectiveMime = "application/pdf";
      else if (/\.jpe?g$/i.test(name))            effectiveMime = "image/jpeg";
      else if (/\.png$/i.test(name))              effectiveMime = "image/png";
      else if (/\.webp$/i.test(name))             effectiveMime = "image/webp";
      else if (/\.(heic|heif)$/i.test(name))      effectiveMime = "image/jpeg";  // Anthropic doesn't accept heic
    }
    // Also handle when browser DID send image/heic explicitly
    if (effectiveMime === "image/heic" || effectiveMime === "image/heif") {
      effectiveMime = "image/jpeg";
    }
    console.log(`[extract-document] Processing ${name} (${req.file.size} bytes, mime=${mime}, effectiveMime=${effectiveMime})`);
    const hn = require("./hearing-notes");
    const extracted = await hn.extractDocumentFields(req.file.buffer, effectiveMime, name);
    res.json({ ok: true, ...extracted });
  } catch (err) {
    console.error("[extract-document]:", err.message, err.response?.data || "");
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
}

// Note: /admin/hearing/notes/extract-document and /extract-i589 are registered
// EARLIER in the file, ABOVE the parametrized /:id route (see near line 2165)
// so Express can match them before falling through to the /:id catchall.

// ── Voice call routes ─────────────────────────────────────
app.post("/voice/incoming",          (req, res) => {
  const savedPrompt = app.locals.SYSTEM_PROMPT || null;
  handleIncomingCall(req, res, savedPrompt);
});
app.post("/voice/respond",           (req, res) => handleRespond(req, res));
app.post("/voice/status",            (req, res) => handleCallStatus(req, res));
app.get( "/voice/audio/:id",         (req, res) => handleAudio(req, res));
app.post("/voice/transfer",          (req, res) => handleTransfer(req, res));
app.post("/voice/transfer-fallback", (req, res) => handleTransferFallback(req, res));
app.post("/voice/transcribe",        (req, res) => handleTranscription(req, res));

app.listen(PORT, async () => {
  console.log(`🚀 Zara running on port ${PORT}`);
  initDB();
  initIntakeTable();
  initComplianceTable();

  // Initialize draft template tables (Phase 4)
  try {
    const dt = require("./draft-templates");
    await dt.initDraftTables();
    console.log("✅ Draft template tables ready");
  } catch (e) {
    console.error("⚠️  Draft table init failed:", e.message);
  }

  // Initialize case files table (persistent memory for drafting)
  try {
    const cf = require("./case-files");
    await cf.initCaseFilesTable();
    console.log("✅ Case files table ready");
  } catch (e) {
    console.error("⚠️  Case files table init failed:", e.message);
  }

  // Initialize email paralegal tables + start scheduler
  try {
    const paralegal = require("./email-paralegal");
    const digest = require("./email-digest");
    await paralegal.initEmailTables();
    console.log("✅ Email paralegal tables ready");
    digest.startEmailScheduler();
  } catch (e) {
    console.error("⚠️  Email paralegal init failed:", e.message);
  }

  // Initialize structured intake agent
  try {
    const intakeAgent = require("./intake-agent");
    await intakeAgent.initIntakeAgentTables();
    console.log("✅ Intake agent tables ready");
  } catch (e) {
    console.error("⚠️  Intake agent init failed:", e.message);
  }

  // Initialize USPTO watch tables (trademark monitoring)
  try {
    const usptoWatch = require("./uspto-watch");
    await usptoWatch.initUsptoWatchTables();
    console.log("✅ USPTO watch tables ready");
    usptoWatch.startUsptoScheduler();
  } catch (e) {
    console.error("⚠️  USPTO watch init failed:", e.message);
  }

  // Initialize hearing notes tables (courtroom note-taking tool)
  try {
    const hn = require("./hearing-notes");
    await hn.initHearingNotesTables();
    console.log("✅ Hearing notes tables ready");
  } catch (e) {
    console.error("⚠️  Hearing notes init failed:", e.message);
  }

  // Initialize individual hearing notes tables (merits hearing prep tool)
  try {
    const ih = require("./individual-hearing-notes");
    await ih.initTables();
    console.log("✅ Individual hearing tables ready");
  } catch (e) {
    console.error("⚠️  Individual hearing init failed:", e.message);
  }

  // Initialize client documents table
  try {
    const cd = require("./client-documents");
    await cd.initTable();
    console.log("✅ Client documents table ready");
  } catch (e) {
    console.error("⚠️  Client documents init failed:", e.message);
  }

  // Initialize Dropbox settings + mapping tables
  try {
    const dbx = require("./dropbox-integration");
    await dbx.initTable();
    console.log("✅ Dropbox settings table ready");
  } catch (e) {
    console.error("⚠️  Dropbox init failed:", e.message);
  }

  // Initialize hearing notices table
  try {
    const hn = require("./hearing-notices");
    await hn.initTable();
    console.log("✅ Hearing notices table ready");
  } catch (e) {
    console.error("⚠️  Hearing notices init failed:", e.message);
  }

  // Initialize auth tables
  try {
    await auth.initTables();
    const userCount = await auth.countUsers();
    if (userCount === 0) {
      console.log("🔐 Auth: NO ADMIN USERS YET — visit /admin/setup to create the first account");
    } else {
      console.log(`🔐 Auth ready — ${userCount} admin user(s) registered`);
    }
  } catch (e) {
    console.error("⚠️  Auth init failed:", e.message);
  }

  // Initialize audit log
  try {
    const audit = require("./audit-log");
    await audit.initTable();
    console.log("✅ Audit log table ready");
  } catch (e) {
    console.error("⚠️  Audit log init failed:", e.message);
  }

  // Initialize hearing note revision table
  try {
    const hn = require("./hearing-notes");
    await hn.initRevisionTable();
    console.log("✅ Hearing note revisions table ready");
  } catch (e) {
    console.error("⚠️  Revision table init failed:", e.message);
  }

  // Initialize hearing reminders + start cron
  try {
    const reminders = require("./hearing-reminders");
    await reminders.initTable();
    reminders.startCron();
    console.log("✅ Hearing reminders scheduled");
  } catch (e) {
    console.error("⚠️  Reminders init failed:", e.message);
  }

  // Initialize deadline tracker + start alert cron
  try {
    const deadlines = require("./deadline-tracker");
    await deadlines.init();
    deadlines.scheduleDailyAlerts();
    console.log("✅ Deadline tracker + alert cron scheduled (7 AM Pacific)");
  } catch (e) {
    console.error("⚠️  Deadline tracker init failed:", e.message);
  }

  // Initialize motion generator + templates
  try {
    const motions = require("./motion-generator");
    await motions.init();
    const templates = require("./motion-templates");
    await templates.init();
    console.log("✅ Motion generator + templates ready");
  } catch (e) {
    console.error("⚠️  Motion generator init failed:", e.message);
  }

  // Initialize Outlook sync
  try {
    const outlook = require("./outlook-sync");
    await outlook.init();
    outlook.scheduleHourlySync();
    console.log("✅ Outlook sync ready (hourly cron scheduled)");
  } catch (e) {
    console.error("⚠️  Outlook sync init failed:", e.message);
  }

  // Initialize backup system + start cron
  try {
    const backups = require("./backup-system");
    backups.startCron();
    // Ensure backup_status table exists and clean up any stale "running" state
    try { await initBackupStatusTable(); } catch (e) { console.warn("[backup] status table init:", e.message); }
    console.log("✅ Backup cron scheduled (3 AM Pacific daily)");
  } catch (e) {
    console.error("⚠️  Backup init failed:", e.message);
  }

  // ── Daily calendar refresh ─────────────────────────────
  // Runs at 6 AM Pacific:
  //   1. Auto-dismisses past hearing notices (hearing_date < yesterday)
  //   2. Runs an incremental Dropbox scan (last 7 days of files only,
  //      strict filename filter) to catch new notices with minimal token spend.
  try {
    const { default: cron } = await import("node-cron").catch(() => ({ default: require("node-cron") }));
    cron.schedule("0 6 * * *", async () => {
      console.log("🌅 [daily-calendar-refresh] Starting…");

      // Step 1: dismiss past notices
      try {
        const hn = require("./hearing-notices");
        const cleanup = await hn.dismissPastNotices({ gracePeriodDays: 1 });
        console.log(`🧹 [daily-calendar-refresh] Auto-dismissed ${cleanup.dismissed_count} past hearing notices`);
      } catch (e) {
        console.error("[daily-calendar-refresh] dismiss error:", e.message);
      }

      // Step 2: incremental Dropbox scan in "daily" mode
      // - Only files modified in last 2 days (was 7 days)
      // - Strict filename filter → skips retainers/receipts/etc
      // - Delta check: clients whose folders haven't changed since last scan cost $0
      // - Max 2 files per client per day
      // Typical run: ~90% of clients skipped due to no changes, ~5-15 files sent to Claude.
      try {
        const cp = require("./client-profiles");
        const dbx = require("./dropbox-integration");
        const hn = require("./hearing-notices");

        const clients = await cp.aggregateClients();
        let scannedFiles = 0;
        let newNotices = 0;
        let clientsScanned = 0;
        let clientsSkippedDelta = 0;
        let clientsSkippedNoFolder = 0;
        let totalCost = 0;

        // Serial to respect rate limits & avoid runaway spend if something goes wrong
        for (const client of clients) {
          try {
            const folder = await Promise.race([
              dbx.resolveClientFolder({
                clientKey: client.key, clientName: client.client_name, aNumber: client.a_number,
              }),
              new Promise(r => setTimeout(() => r(null), 8000)),  // 8s timeout on folder resolve
            ]).catch(() => null);
            if (!folder) {
              clientsSkippedNoFolder++;
              continue;
            }

            const scan = await Promise.race([
              hn.scanClientFolder({
                clientKey: client.key,
                clientName: client.client_name,
                aNumber: client.a_number,
                dropboxFolderPath: folder,
                mode: "daily",
                daysBack: 2,   // Only very recent additions (was 7)
                limit: 2,      // Max NEW files per client (was 3)
              }),
              new Promise(r => setTimeout(() => r({ error: "timeout" }), 30000)),
            ]).catch((e) => ({ error: e.message }));

            if (scan.delta_skipped) {
              clientsSkippedDelta++;
              continue;
            }
            if (!scan.error) {
              clientsScanned++;
              scannedFiles += scan.scanned || 0;
              newNotices += scan.new_notices || scan.newNotices || (scan.notices || []).length || 0;
              totalCost += scan.estimated_cost_usd || 0;
            }
          } catch (e) {
            console.warn(`[daily-calendar-refresh] ${client.client_name}: ${e.message}`);
          }
        }
        console.log(
          `✅ [daily-calendar-refresh] Complete: ` +
          `${clientsScanned} scanned / ${clientsSkippedDelta} skipped (no changes) / ${clientsSkippedNoFolder} skipped (no folder) / ${clients.length} total. ` +
          `${scannedFiles} files sent to Claude, ${newNotices} new notices found. ` +
          `Est. cost: $${totalCost.toFixed(4)}`
        );
      } catch (e) {
        console.error("[daily-calendar-refresh] scan error:", e.message);
      }
    }, { timezone: "America/Los_Angeles" });
    console.log("✅ Daily calendar refresh scheduled (6 AM Pacific)");
  } catch (e) {
    console.error("⚠️  Daily calendar cron failed:", e.message);
  }

  // Load saved system prompt from DB (if admin has edited it)
  initPromptTable().then(() => getSavedPrompt()).then(saved => {
    if (saved) {
      app.locals.SYSTEM_PROMPT = saved;
      console.log("✅ Loaded saved system prompt from DB");
    }
  }).catch(() => {});

  const url = RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  setInterval(() => axios.get(url).catch(() => {}), 4 * 60 * 1000);
  console.log("Keep-alive ping →", url);

  // ── Start WordPress auto-poster ─────────────────────────
  try {
    const { scheduleDaily } = require("./autoposter");
    scheduleDaily();
    console.log("📅 WordPress auto-poster scheduler started.");
  } catch (e) {
    console.error("❌ Auto-poster failed to load:", e.message);
  }

  // ── Start weekly analytics ──────────────────────────────
  try {
    scheduleWeeklyAnalytics();
    console.log("📊 Analytics scheduler started.");
  } catch (e) {
    console.error("❌ Analytics failed to load:", e.message);
  }

  // ── Init Wave 1 tables ─────────────────────────────────
  try {
    const { initWave1Tables } = require("./db");
    initWave1Tables();
  } catch (e) {
    console.error("❌ Wave 1 tables failed:", e.message);
  }

  // ── Hot lead escalation monitor ─────────────────────────
  try {
    startHotLeadMonitor();
  } catch (e) {
    console.error("❌ Hot lead monitor failed:", e.message);
  }

  try {
    startSolScheduler();
  } catch (e) {
    console.error("❌ SOL scheduler failed:", e.message);
  }

  try {
    startDripScheduler();
  } catch (e) {
    console.error("❌ Drip scheduler failed:", e.message);
  }

  // ── Load USCIS processing times ─────────────────────────
  try {
    scheduleUSCISRefresh(app);
    console.log("🏛️  USCIS processing times scheduler started.");
  } catch (e) {
    console.error("❌ USCIS updater failed to load:", e.message);
  }

  // ── Answer cache table ──────────────────────────────────
  try {
    await initCacheTable();
    console.log("⚡ Answer cache table ready.");
  } catch (e) {
    console.error("❌ Answer cache table failed:", e.message);
  }

  // ── Weekly cache purge (every Sunday 3 AM PT) ────────────
  try {
    const { default: cron } = await import("node-cron").catch(() => ({ default: require("node-cron") }));
    cron.schedule("0 11 * * 0", () => {
      purgeExpiredCache().catch(err => console.error("Cache purge error:", err.message));
    }, { timezone: "America/Los_Angeles" });
    console.log("🧹 Weekly cache purge scheduled (Sunday 3 AM PT).");
  } catch (e) {
    console.error("❌ Cache purge scheduler failed:", e.message);
  }

  // ── Legal Intelligence — Citation tables ────────────────
  try {
    await initCitationTables();
    console.log("🔗 Citation tracker tables ready.");
  } catch (e) {
    console.error("❌ Citation tables failed:", e.message);
  }

  // ── Legal Intelligence — Judge profile tables ────────────
  try {
    await initJudgeProfileTables();
    console.log("⚖️  Judge profile tables ready.");
  } catch (e) {
    console.error("❌ Judge profile tables failed:", e.message);
  }

  // ── Legal Intelligence — Daily digest scheduler ──────────
  try {
    scheduleDigest();
    console.log("📰 Legal digest scheduler started (6:00 AM Pacific).");
  } catch (e) {
    console.error("❌ Legal digest scheduler failed:", e.message);
  }

  // ── Matter Manager — Daily deadline summary (7:00 AM PT) ─
  try {
    const { default: cron } = await import("node-cron").catch(() => ({ default: require("node-cron") }));
    cron.schedule("0 7 * * *", () => {
      sendDailyDeadlineSummary().catch(err => console.error("Daily deadline summary error:", err.message));
    }, { timezone: "America/Los_Angeles" });
    console.log("📅 Daily deadline summary scheduled (7:00 AM PT).");
  } catch (e) {
    console.error("❌ Daily deadline summary scheduler failed:", e.message);
  }
});
