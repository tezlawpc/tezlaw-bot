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

app.post("/admin/backups/run-now", auth.requireRole("admin"), async (req, res) => {
  try {
    const backups = require("./backup-system");
    const result = await backups.runBackup({ manual: true });
    res.json({ ok: true, result });
  } catch (err) {
    console.error("[backup run]:", err.message);
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
  const diag = { steps: [], overall_ok: true };

  // Step 1: Access token
  try {
    const token = await dbx.getAccessToken();
    diag.steps.push({ step: "1. Get access token", ok: true, detail: `Token starts with: ${token.substring(0, 8)}...` });
  } catch (e) {
    diag.steps.push({ step: "1. Get access token", ok: false, error: e.message });
    diag.overall_ok = false;
    return res.json(diag);
  }

  // Step 2: Path root header
  try {
    const header = await dbx.getPathRootHeader();
    diag.steps.push({ step: "2. Get path root header", ok: true, detail: `Header value: ${header || "(none — falls back to personal namespace)"}` });
  } catch (e) {
    diag.steps.push({ step: "2. Get path root header", ok: false, error: e.message });
    diag.overall_ok = false;
  }

  // Step 3: List /Zara-Backups
  try {
    const backups = require("./backup-system");
    const list = await backups.listBackups();
    diag.steps.push({ step: "3. List /Zara-Backups folder", ok: true, detail: `Found ${list.length} existing backup(s)` });
  } catch (e) {
    diag.steps.push({ step: "3. List /Zara-Backups folder", ok: false, error: e.message });
  }

  // Step 4: Test upload with a tiny buffer
  try {
    const token = await dbx.getAccessToken();
    const pathRoot = await dbx.getPathRootHeader();
    const testBuf = Buffer.from("test", "utf8");
    const testPath = `/Zara-Backups/_diagnose_${Date.now()}.txt`;
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: testPath, mode: "overwrite", autorename: false, mute: true }),
    };
    if (pathRoot) headers["Dropbox-API-Path-Root"] = pathRoot;
    await axios.post("https://content.dropboxapi.com/2/files/upload", testBuf, {
      headers, timeout: 30000,
    });
    diag.steps.push({ step: "4. Test upload (4 bytes)", ok: true, detail: `Uploaded to ${testPath}` });
    try { await dbx.deleteFile(testPath); } catch { /* silent */ }
  } catch (e) {
    const errData = e.response?.data;
    let dbxMsg = "";
    if (errData) {
      dbxMsg = typeof errData === "string" ? errData
             : errData.error_summary ? errData.error_summary
             : JSON.stringify(errData).substring(0, 300);
    }
    diag.steps.push({
      step: "4. Test upload (4 bytes)",
      ok: false,
      error: e.message,
      dropbox_response: dbxMsg,
      status: e.response?.status,
    });
    diag.overall_ok = false;
  }

  res.json(diag);
});

// Version check endpoint — hit this to verify which build of the code is
// actually running on Render. Helps diagnose "changes didn't deploy" issues.
app.get("/version", (req, res) => {
  res.json({
    version: "v4-voice-audit-2026-08-28",
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
app.get("/admin/dashboard", async (req, res) => {
  try {
    const dashboard = require("./dashboard");
    const [upcoming, unnotified, recent, reminderStats, clientStats] = await Promise.all([
      dashboard.getUpcomingHearings(14),
      dashboard.getUnnotifiedNotices(),
      dashboard.getRecentHearings(10),
      dashboard.getReminderStats(),
      dashboard.getClientStats(),
    ]);
    res.send(dashboard.renderDashboard({ upcoming, unnotified, recent, reminderStats, clientStats }));
  } catch (err) {
    console.error("[dashboard]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
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
    console.error("[audit log]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
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
app.use("/admin", auth.requireRole("admin"), adminRouter);
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
app.get("/", (req, res) => res.send("Tez Law P.C. — Zara running on all channels ✅"));

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
    const accounts = await paralegal.listAccounts();

    const accountsHtml = accounts.length ? accounts.map(a => `
      <div style="background:#f5f5f5; padding:12px; margin:8px 0; border-left: 4px solid ${a.active ? "#4CAF50" : "#999"};">
        <strong>${a.email}</strong> <span style="color:#666;">(${a.imap_host}:${a.imap_port})</span>
        <br><small>Last scan: ${a.last_scan_at ? new Date(a.last_scan_at).toLocaleString() : "never"}</small>
        ${a.last_error ? `<br><small style="color:red;">Error: ${a.last_error}</small>` : ""}
      </div>
    `).join("") : "<p><em>No accounts linked yet.</em></p>";

    res.send(`
      <html><head><title>Zara Email Setup</title>
      <style>
        body { font-family: sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; }
        h1 { color: #0C1C36; }
        h2 { color: #B79C62; margin-top: 30px; }
        input, select, button { padding: 8px; margin: 4px 0; font-size: 14px; }
        input[type="text"], input[type="password"], input[type="email"] { width: 100%; box-sizing: border-box; }
        button { background: #B79C62; color: white; border: none; padding: 10px 20px; cursor: pointer; }
        button:hover { background: #8f7a4c; }
        .preset { display: inline-block; margin: 3px; padding: 4px 10px; background: #eee; cursor: pointer; border-radius: 3px; font-size: 12px; }
        .preset:hover { background: #ddd; }
        .warn { background: #fff3cd; padding: 12px; border-left: 4px solid #ffc107; margin: 20px 0; }
      </style>
      </head><body>
        <h1>📬 Zara Email Setup</h1>
        <p>Configure IMAP credentials for accounts you want Zara to monitor.</p>

        <h2>Linked Accounts</h2>
        ${accountsHtml}

        <h2>Add / Update Account</h2>
        <div class="warn">
          <strong>⚠️ App passwords:</strong> For Gmail, Hotmail, and Google Workspace accounts with 2FA, you likely need an <em>app-specific password</em> (not your login password). 
          <br>• Gmail: <a href="https://myaccount.google.com/apppasswords" target="_blank">myaccount.google.com/apppasswords</a>
          <br>• Hotmail/Outlook: <a href="https://account.microsoft.com/security" target="_blank">account.microsoft.com/security</a> → App passwords
        </div>

        <form method="POST" action="/admin/email-setup">
          <label>Email address:<br>
          <input type="email" name="email" required placeholder="jj@tezlawfirm.com"></label><br>

          <label>Display name (optional):<br>
          <input type="text" name="display_name" placeholder="Tez Law primary"></label><br>

          <label>IMAP host:<br>
          <input type="text" name="imap_host" required placeholder="imap.secureserver.net" id="imap_host"></label>
          <div>
            <small>Quick fill:</small>
            <span class="preset" onclick="fillPreset('imap.secureserver.net',993)">GoDaddy Workspace</span>
            <span class="preset" onclick="fillPreset('outlook.office365.com',993)">GoDaddy 365 / Hotmail / Outlook</span>
            <span class="preset" onclick="fillPreset('imap.gmail.com',993)">Gmail</span>
            <span class="preset" onclick="fillPreset('imap.mail.yahoo.com',993)">Yahoo</span>
            <span class="preset" onclick="fillPreset('imap.zoho.com',993)">Zoho</span>
          </div>

          <label>IMAP port:<br>
          <input type="number" name="imap_port" value="993" id="imap_port" required></label><br>

          <label>Username (usually same as email):<br>
          <input type="text" name="imap_user" required placeholder="jj@tezlawfirm.com"></label><br>

          <label>Password (or app-specific password):<br>
          <input type="password" name="password" required></label><br>

          <label>
            <input type="checkbox" name="use_tls" value="1" checked>
            Use TLS/SSL (recommended)
          </label><br><br>

          <button type="submit" name="action" value="test">Test connection</button>
          <button type="submit" name="action" value="save">Test + Save</button>
        </form>

        <h2>Remove Account</h2>
        <form method="POST" action="/admin/email-setup">
          <label>Email to remove:<br>
          <input type="email" name="email" required></label>
          <button type="submit" name="action" value="remove" style="background:#c00;">Remove</button>
        </form>

        <script>
          function fillPreset(host, port) {
            document.getElementById("imap_host").value = host;
            document.getElementById("imap_port").value = port;
          }
        </script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.post("/admin/email-setup", async (req, res) => {
  try {
    const paralegal = require("./email-paralegal");
    const { email, imap_host, imap_port, imap_user, password, use_tls, display_name, action } = req.body;

    if (action === "remove") {
      const removed = await paralegal.removeAccount(email);
      return res.send(`
        <html><body style="font-family:sans-serif; padding:40px;">
          ${removed ? `<h1 style="color:#c00;">🗑️ Removed</h1><p>Account <strong>${email}</strong> has been removed.</p>` : `<h1>Not found</h1><p>${email} was not in the account list.</p>`}
          <p><a href="/admin/email-setup">← Back to setup</a></p>
        </body></html>
      `);
    }

    // Test the connection first
    const testResult = await paralegal.testAccount({
      imap_host, imap_port: parseInt(imap_port) || 993, imap_user, password,
      use_tls: use_tls === "1" || use_tls === "on",
    });

    if (!testResult.ok) {
      return res.send(`
        <html><body style="font-family:sans-serif; padding:40px; max-width:600px;">
          <h1 style="color:#c00;">❌ Connection failed</h1>
          <p><strong>Host:</strong> ${imap_host}:${imap_port}</p>
          <p><strong>User:</strong> ${imap_user}</p>
          <p><strong>Error:</strong> <code>${testResult.error}</code></p>
          <h3>Common fixes:</h3>
          <ul>
            <li>Verify the password is correct — try app-specific password if 2FA is enabled</li>
            <li>Check IMAP is enabled in your email provider settings</li>
            <li>Confirm the host and port match your provider's docs</li>
            <li>Some providers block IMAP for OAuth-only accounts (e.g., Microsoft may require Modern Auth)</li>
          </ul>
          <p><a href="/admin/email-setup">← Try again</a></p>
        </body></html>
      `);
    }

    if (action === "test") {
      return res.send(`
        <html><body style="font-family:sans-serif; padding:40px;">
          <h1 style="color:#4CAF50;">✅ Connection works!</h1>
          <p>Successfully connected to <strong>${imap_host}:${imap_port}</strong> as <strong>${imap_user}</strong>.</p>
          <p>INBOX contains ${testResult.messageCount} messages.</p>
          <p>Click "Test + Save" if you're ready to store this account.</p>
          <p><a href="/admin/email-setup">← Back to setup</a></p>
        </body></html>
      `);
    }

    // action === "save"
    const account = await paralegal.addAccount({
      email, imap_host, imap_port: parseInt(imap_port) || 993, imap_user, password,
      use_tls: use_tls === "1" || use_tls === "on",
      display_name,
    });

    res.send(`
      <html><body style="font-family:sans-serif; padding:40px;">
        <h1 style="color:#4CAF50;">✅ Saved!</h1>
        <p>Account <strong>${account.email}</strong> is now linked to Zara (id: ${account.id}).</p>
        <p>${testResult.messageCount} messages in INBOX. Zara will scan every 30 min.</p>
        <p><a href="/admin/email-setup">← Add another account</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error("[/admin/email-setup POST] error:", err.message);
    res.status(500).send(`<html><body><h1>Error</h1><p>${err.message}</p><p><a href="/admin/email-setup">← Back</a></p></body></html>`);
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
      hearing_datetime: extraction.hearing_datetime || null,
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
    const noteId = await hn.saveNote(note, { generateSummaries: false });
    res.json({ ok: true, note_id: noteId });
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

  // Initialize backup system + start cron
  try {
    const backups = require("./backup-system");
    backups.startCron();
    console.log("✅ Backup cron scheduled (3 AM Pacific daily)");
  } catch (e) {
    console.error("⚠️  Backup init failed:", e.message);
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
