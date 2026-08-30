// ============================================================
//  TEZ LAW P.C. — HEARING NOTICES
//  ─────────────────────────────────────────────────────────
//  Scans a client's Dropbox folder for hearing notices,
//  extracts the next hearing date/time/place, stores it,
//  and offers one-click client notification via email/SMS/
//  WhatsApp with a translated message.
//
//  Detection strategy:
//    - Fetch file bytes from Dropbox via getTemporaryLink
//    - Send PDF/image to Claude Sonnet vision with a prompt
//      that answers "is this a hearing notice? if yes, extract"
//    - Cache extracted notices in `client_hearing_notices`
//      keyed by (client_key, dropbox_file_path, content_hash)
//    - Skip already-scanned files on repeat runs (content_hash)
// ============================================================

const axios = require("axios");
const db = require("./db");

// ── Schema ───────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_hearing_notices (
      id                 SERIAL PRIMARY KEY,
      client_key         TEXT NOT NULL,
      client_name        TEXT,
      a_number           TEXT,
      dropbox_path       TEXT NOT NULL,
      dropbox_hash       TEXT,
      hearing_date       TIMESTAMPTZ,
      hearing_time_text  TEXT,
      hearing_type       TEXT,
      court_name         TEXT,
      court_address      TEXT,
      judge_name         TEXT,
      notice_type        TEXT,
      confidence         TEXT,
      raw_extraction     JSONB,
      is_hearing_notice  BOOLEAN DEFAULT FALSE,
      notified_at        TIMESTAMPTZ,
      notification_channel TEXT,
      dismissed_at       TIMESTAMPTZ,
      dismiss_reason     TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrate pre-existing tables that lack dismiss_reason
  try { await db.query(`ALTER TABLE client_hearing_notices ADD COLUMN IF NOT EXISTS dismiss_reason TEXT`); } catch {}
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_hearing_notices_client
      ON client_hearing_notices (client_key)
  `);
  // Prevent double-inserting the exact same file (same hash) for the same client
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hearing_notices_dedup
      ON client_hearing_notices (client_key, dropbox_path, dropbox_hash)
  `);
  // Per-client scan-state tracking — lets daily scans skip clients whose folders
  // haven't changed since last scan (huge cost saving)
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_scan_state (
      client_key            TEXT PRIMARY KEY,
      dropbox_folder_path   TEXT,
      last_scanned_at       TIMESTAMPTZ,
      last_max_modified     TIMESTAMPTZ,
      files_scanned_last    INTEGER DEFAULT 0,
      notices_found_last    INTEGER DEFAULT 0,
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Global scan state (key-value). Tracks last_full_scan_completed_at — daily
  // scans use this as an authoritative floor: any file uploaded before this
  // timestamp was already checked during the full scan, so no need to re-look.
  await db.query(`
    CREATE TABLE IF NOT EXISTS notice_scan_settings (
      key    TEXT PRIMARY KEY,
      value  TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Get / set global scan settings (simple key-value)
async function getScanSetting(key) {
  const r = await db.query(`SELECT value FROM notice_scan_settings WHERE key = $1`, [key]);
  return r.rows[0]?.value || null;
}
async function setScanSetting(key, value) {
  await db.query(
    `INSERT INTO notice_scan_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  );
}

// ── Fetch file from Dropbox ──────────────────────────────

async function fetchDropboxFile(path) {
  const dbx = require("./dropbox-integration");
  const link = await dbx.getTemporaryLink(path);
  const resp = await axios.get(link, {
    responseType: "arraybuffer",
    maxContentLength: 32 * 1024 * 1024,   // 32MB cap
    maxBodyLength: 32 * 1024 * 1024,
    timeout: 60000,
  });
  return Buffer.from(resp.data);
}

// ── Claude extraction ────────────────────────────────────
//
// COST OPTIMIZATION:
//  - Model: Haiku 4.5 (was Sonnet 4.6) — ~5x cheaper, equivalent accuracy for
//    structured JSON extraction from short forms
//  - max_tokens: 500 (was 1200) — response JSON is ~200 tokens
//  - Trimmed prompt from ~500 → ~180 tokens
//  - Hard file-size skip at 4MB (huge PDFs are usually motions/exhibits,
//    not hearing notices)
//
// Result: ~10x lower cost per file vs prior config.

const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024;  // 4MB
const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

async function extractFromFile({ buffer, mimeType, filename }) {
  const isPdf = mimeType && mimeType.includes("pdf");
  const isImage = mimeType && mimeType.startsWith("image/");
  if (!isPdf && !isImage) {
    return { is_hearing_notice: false, reason: `unsupported mime: ${mimeType}` };
  }
  if (buffer.length > MAX_SCAN_FILE_BYTES) {
    return { is_hearing_notice: false, reason: `too large (${Math.round(buffer.length / 1024)}KB > 4MB — likely motion/exhibit not notice)` };
  }
  const base64 = buffer.toString("base64");
  let normalizedMime = mimeType;
  if (mimeType === "image/heic" || mimeType === "image/heif") normalizedMime = "image/jpeg";

  // Compact prompt — structured extraction doesn't need verbose instructions
  const prompt = `Extract hearing notice info as JSON. Return ONLY the JSON, no fences.

{
  "is_hearing_notice": bool,
  "confidence": "high"|"medium"|"low",
  "notice_type": "EOIR master"|"EOIR individual"|"EOIR bond"|"USCIS interview"|"USCIS biometrics"|"other"|null,
  "hearing_date": "YYYY-MM-DD"|null,
  "hearing_time": "HH:MM"|null,
  "hearing_type": "master"|"individual"|"bond"|"biometrics"|"interview"|"status"|"other"|null,
  "court_name": string|null,
  "court_address": string|null,
  "judge_name": string|null,
  "client_name": string|null,
  "a_number": "A123-456-789"|null,
  "notes": string|null
}

Rules: is_hearing_notice=true ONLY if it schedules a specific future hearing (not motions/letters/transcripts). For reschedules use the NEW date. If false, other fields = null. Filename: "${filename}".`;

  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image",    source: { type: "base64", media_type: normalizedMime,    data: base64 } };

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: EXTRACTION_MODEL,
      max_tokens: 500,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
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
  const text = resp.data.content?.[0]?.text?.trim() || "{}";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Notice extraction returned unparseable JSON: ${cleaned.substring(0, 200)}`);
  }
}

function mergeDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  if (timeStr) return `${dateStr}T${timeStr.length === 5 ? timeStr : timeStr.padEnd(5, "0")}:00`;
  return `${dateStr}T00:00:00`;
}

function guessMime(filename) {
  const n = String(filename || "").toLowerCase();
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".heic")) return "image/heic";
  if (n.endsWith(".heif")) return "image/heif";
  return "application/octet-stream";
}

// Filter for what looks like a notice worth scanning (skip obvious non-notices)
function looksLikeNoticeCandidate(filename) {
  const n = String(filename || "").toLowerCase();
  // Always try PDFs and images
  if (/\.(pdf|jpg|jpeg|png|webp|heic|heif)$/.test(n)) return true;
  return false;
}

// Stricter filter for daily incremental scans — skips things unlikely to be a notice
// to keep token spend low. Full manual "Update from Dropbox" still uses the broad filter.
function looksLikeNoticeCandidateStrict(filename) {
  const n = String(filename || "").toLowerCase();
  if (!/\.(pdf|jpg|jpeg|png|webp|heic|heif)$/.test(n)) return false;

  // Strong POSITIVE signals — must have at least one to qualify for daily scan
  const positive = /(eoir|uscis|notice|noa|hearing|master|individual|mch|nta|nto|master calendar|interview|biometric|court|immigration|ij[_\s-]|judge|na[_\-]?|nnta|scheduled)/i;
  if (positive.test(n)) return true;

  // Negative signals — files that are almost certainly not hearing notices
  const negative = /(retainer|engagement|invoice|receipt|payment|photo|selfie|passport|id[_\s-]|driver|license|birth cert|marriage cert|divorce|tax return|w[_\-]?2|1099|paystub|paycheck|application|form i-|form g-|i-\d+|g-\d+|evidence|exhibit|declaration|affidavit|letter|correspondence|email)/i;
  if (negative.test(n)) return false;

  // Ambiguous — for daily scan, skip. Manual scan will catch these.
  return false;
}

// ── Scan a client's Dropbox folder ───────────────────────

// Returns { scanned, notices, skipped, errors, total_candidates, estimated_cost_usd }
// mode: "full" (default, broad file filter, 4MB max) | "daily" (strict filter + only recent files, 1MB max)
async function scanClientFolder({ clientKey, clientName, aNumber, dropboxFolderPath, limit = 20, mode = "full", daysBack = 7 }) {
  await initTable();
  const dbx = require("./dropbox-integration");

  const entries = await dbx.listFolder(dropboxFolderPath);
  if (!entries) return { scanned: 0, notices: [], error: "Folder not found or empty" };

  // Pick filter based on mode
  const filterFn = mode === "daily" ? looksLikeNoticeCandidateStrict : looksLikeNoticeCandidate;
  const cutoffMs = mode === "daily" ? Date.now() - daysBack * 24 * 60 * 60 * 1000 : 0;
  // Tighter file-size cap in daily mode — hearing notices are usually 50-500KB.
  // Big PDFs in a recent-files window are almost always exhibits or motions.
  const maxSizeThisMode = mode === "daily" ? 1024 * 1024 : MAX_SCAN_FILE_BYTES;

  // ── DELTA CHECK (daily mode only) ─────────────────────────
  // Two-layer cutoff:
  //   1. Global floor: last_full_scan_completed_at (all files present during the
  //      last full scan were already checked, so we can safely ignore them).
  //   2. Per-client watermark: last_max_modified from prior daily scans.
  // A file is only worth scanning if server_modified > MAX(floor, watermark).
  let deltaSkipped = false;
  if (mode === "daily") {
    const [stateRes, floorStr] = await Promise.all([
      db.query(`SELECT last_max_modified FROM client_scan_state WHERE client_key = $1`, [clientKey]),
      getScanSetting("last_full_scan_completed_at"),
    ]);
    const perClientCutoff = stateRes.rows[0]?.last_max_modified
      ? new Date(stateRes.rows[0].last_max_modified).getTime()
      : 0;
    const globalFloor = floorStr ? new Date(floorStr).getTime() : 0;
    const effectiveCutoff = Math.max(perClientCutoff, globalFloor);

    if (effectiveCutoff > 0) {
      // Any candidate file newer than the effective cutoff?
      const newestCandidate = entries
        .filter(e => e[".tag"] === "file" && filterFn(e.name))
        .reduce((max, e) => Math.max(max, new Date(e.server_modified).getTime()), 0);

      if (newestCandidate <= effectiveCutoff) {
        deltaSkipped = true;
        await db.query(
          `INSERT INTO client_scan_state (client_key, dropbox_folder_path, last_scanned_at, updated_at)
           VALUES ($1, $2, NOW(), NOW())
           ON CONFLICT (client_key) DO UPDATE SET last_scanned_at = NOW(), updated_at = NOW()`,
          [clientKey, dropboxFolderPath]
        );
        return {
          scanned: 0, skipped: 0, notices: [], errors: [],
          total_candidates: 0, estimated_cost_usd: 0,
          delta_skipped: true,
        };
      }
    }
  }

  // Get the effective cutoff again (or 0 for full mode) so we filter files below.
  let hardCutoffMs = 0;
  if (mode === "daily") {
    const [stateRes, floorStr] = await Promise.all([
      db.query(`SELECT last_max_modified FROM client_scan_state WHERE client_key = $1`, [clientKey]),
      getScanSetting("last_full_scan_completed_at"),
    ]);
    const perClientCutoff = stateRes.rows[0]?.last_max_modified
      ? new Date(stateRes.rows[0].last_max_modified).getTime()
      : 0;
    const globalFloor = floorStr ? new Date(floorStr).getTime() : 0;
    hardCutoffMs = Math.max(perClientCutoff, globalFloor);
  }

  const files = entries
    .filter(e => e[".tag"] === "file" && filterFn(e.name))
    .filter(e => mode !== "daily" || new Date(e.server_modified).getTime() >= cutoffMs)
    // Delta floor: skip files uploaded before the last full scan or watermark
    .filter(e => !hardCutoffMs || new Date(e.server_modified).getTime() > hardCutoffMs)
    .filter(e => !e.size || e.size <= maxSizeThisMode)
    .sort((a, b) => new Date(b.server_modified).getTime() - new Date(a.server_modified).getTime())  // newest first
    .slice(0, limit);

  // Filter out files we've already scanned (same path + content hash)
  const existing = await db.query(
    `SELECT dropbox_path, dropbox_hash FROM client_hearing_notices WHERE client_key = $1`,
    [clientKey]
  );
  const alreadyScanned = new Set(existing.rows.map(r => `${r.dropbox_path}|${r.dropbox_hash || ""}`));

  const notices = [];
  let scanned = 0;
  let skipped = 0;
  const errors = [];

  for (const file of files) {
    const key = `${file.path_display}|${file.content_hash || ""}`;
    if (alreadyScanned.has(key)) { skipped++; continue; }

    try {
      const buffer = await fetchDropboxFile(file.path_display);
      const mimeType = guessMime(file.name);
      const extraction = await extractFromFile({ buffer, mimeType, filename: file.name });
      scanned++;

      if (extraction.is_hearing_notice && extraction.hearing_date) {
        const hearingDate = mergeDateTime(extraction.hearing_date, extraction.hearing_time);
        const inserted = await db.query(
          `INSERT INTO client_hearing_notices
             (client_key, client_name, a_number, dropbox_path, dropbox_hash,
              hearing_date, hearing_time_text, hearing_type, court_name, court_address,
              judge_name, notice_type, confidence, raw_extraction, is_hearing_notice)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, TRUE)
           ON CONFLICT (client_key, dropbox_path, dropbox_hash) DO UPDATE
             SET hearing_date = EXCLUDED.hearing_date,
                 hearing_time_text = EXCLUDED.hearing_time_text,
                 raw_extraction = EXCLUDED.raw_extraction,
                 is_hearing_notice = TRUE
           RETURNING id, hearing_date, hearing_type, court_name, court_address, judge_name, notice_type`,
          [
            clientKey, clientName || null, aNumber || null,
            file.path_display, file.content_hash || null,
            hearingDate, extraction.hearing_time || null,
            extraction.hearing_type || null,
            extraction.court_name || null,
            extraction.court_address || null,
            extraction.judge_name || null,
            extraction.notice_type || null,
            extraction.confidence || "low",
            JSON.stringify(extraction),
          ]
        );
        notices.push({ ...inserted.rows[0], filename: file.name, dropbox_path: file.path_display });
      } else {
        // Record the non-hearing-notice files too so we don't re-scan them
        await db.query(
          `INSERT INTO client_hearing_notices
             (client_key, client_name, a_number, dropbox_path, dropbox_hash, is_hearing_notice, raw_extraction)
           VALUES ($1, $2, $3, $4, $5, FALSE, $6::jsonb)
           ON CONFLICT (client_key, dropbox_path, dropbox_hash) DO NOTHING`,
          [clientKey, clientName || null, aNumber || null, file.path_display, file.content_hash || null, JSON.stringify(extraction)]
        );
      }
    } catch (e) {
      errors.push({ file: file.name, error: e.message });
    }
  }

  // Rough cost estimate using Haiku 4.5 pricing.
  // Input: $0.80/MTok, Output: $4/MTok. Each scan ~= 3-5K input, 300-500 output tokens.
  // Average ≈ $0.0035/file. Actual costs will vary based on PDF page count.
  const estimatedCostUsd = +(scanned * 0.0035).toFixed(4);

  // Record scan state so next daily run can skip this client if nothing changed.
  // Track the highest server_modified we saw among candidate files — this is
  // our watermark for delta detection.
  try {
    const candidateMaxModified = entries
      .filter(e => e[".tag"] === "file" && filterFn(e.name))
      .reduce((max, e) => Math.max(max, new Date(e.server_modified).getTime()), 0);
    if (candidateMaxModified > 0) {
      await db.query(
        `INSERT INTO client_scan_state
           (client_key, dropbox_folder_path, last_scanned_at, last_max_modified,
            files_scanned_last, notices_found_last, updated_at)
         VALUES ($1, $2, NOW(), $3, $4, $5, NOW())
         ON CONFLICT (client_key) DO UPDATE SET
           dropbox_folder_path = EXCLUDED.dropbox_folder_path,
           last_scanned_at = NOW(),
           last_max_modified = GREATEST(client_scan_state.last_max_modified, EXCLUDED.last_max_modified),
           files_scanned_last = EXCLUDED.files_scanned_last,
           notices_found_last = EXCLUDED.notices_found_last,
           updated_at = NOW()`,
        [clientKey, dropboxFolderPath, new Date(candidateMaxModified).toISOString(), scanned, notices.length]
      );
    }
  } catch (stateErr) {
    console.warn(`[scan-state] ${clientKey}: ${stateErr.message}`);
  }

  return { scanned, skipped, notices, errors, total_candidates: files.length, estimated_cost_usd: estimatedCostUsd, delta_skipped: false };
}

// ── Retrieval ────────────────────────────────────────────

async function listClientNotices(clientKey, { includeDetected = true, includeDismissed = false } = {}) {
  await initTable();
  const conditions = ["client_key = $1", "is_hearing_notice = TRUE"];
  if (!includeDismissed) conditions.push("dismissed_at IS NULL");
  const r = await db.query(
    `SELECT id, dropbox_path, hearing_date, hearing_time_text, hearing_type,
            court_name, court_address, judge_name, notice_type, confidence,
            notified_at, notification_channel, created_at
     FROM client_hearing_notices
     WHERE ${conditions.join(" AND ")}
     ORDER BY hearing_date ASC NULLS LAST`,
    [clientKey]
  );
  return r.rows;
}

async function markNotified(id, channel) {
  await initTable();
  await db.query(
    `UPDATE client_hearing_notices
     SET notified_at = NOW(), notification_channel = $2
     WHERE id = $1`,
    [id, channel]
  );
}

async function dismissNotice(id) {
  await initTable();
  await db.query(
    `UPDATE client_hearing_notices SET dismissed_at = NOW() WHERE id = $1`,
    [id]
  );
}

// ── Client notification message builders ─────────────────

const MESSAGES = {
  en: (n) => `Hi, this is Tez Law Firm. This is a reminder about your upcoming ${prettyType(n.hearing_type)} hearing:

📅 Date: ${formatDate(n.hearing_date, "en")}
${n.court_name ? `📍 Court: ${n.court_name}\n` : ""}${n.court_address ? `📌 Address: ${n.court_address}\n` : ""}${n.judge_name ? `⚖️ Judge: ${n.judge_name}\n` : ""}
Please arrive 30 minutes early with your government-issued ID. If you cannot attend, call us IMMEDIATELY at 626-678-8677.

— TEZ LAW FIRM`,

  zh: (n) => `您好，这里是TEZ律师事务所。这是关于您即将到来的${prettyTypeZh(n.hearing_type)}庭审的提醒：

📅 日期：${formatDate(n.hearing_date, "zh")}
${n.court_name ? `📍 法院：${n.court_name}\n` : ""}${n.court_address ? `📌 地址：${n.court_address}\n` : ""}${n.judge_name ? `⚖️ 法官：${n.judge_name}\n` : ""}
请提前30分钟到达并携带政府颁发的身份证件。如无法出席，请立即致电626-678-8677。

— TEZ律师事务所`,

  es: (n) => `Hola, le habla el bufete Tez Law. Le recordamos su próxima audiencia de ${prettyTypeEs(n.hearing_type)}:

📅 Fecha: ${formatDate(n.hearing_date, "es")}
${n.court_name ? `📍 Corte: ${n.court_name}\n` : ""}${n.court_address ? `📌 Dirección: ${n.court_address}\n` : ""}${n.judge_name ? `⚖️ Juez: ${n.judge_name}\n` : ""}
Por favor llegue 30 minutos antes con su identificación oficial. Si no puede asistir, llámenos INMEDIATAMENTE al 626-678-8677.

— TEZ LAW FIRM`,
};

function prettyType(t) {
  const map = { master: "Master Calendar", individual: "Individual/Merits", bond: "Bond", status: "Status", biometrics: "Biometrics", interview: "Interview" };
  return map[t] || "hearing";
}
function prettyTypeZh(t) {
  const map = { master: "主听证", individual: "个人/庭审", bond: "保释", status: "状态", biometrics: "指纹采集", interview: "面谈" };
  return map[t] || "";
}
function prettyTypeEs(t) {
  const map = { master: "Calendario Maestro", individual: "Individual/Méritos", bond: "Fianza", status: "Estado", biometrics: "Biometría", interview: "Entrevista" };
  return map[t] || "audiencia";
}
function formatDate(dt, lang) {
  if (!dt) return "(fecha no confirmada)";
  const d = new Date(dt);
  if (isNaN(d)) return String(dt);
  const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  const locale = { en: "en-US", zh: "zh-CN", es: "es-MX" }[lang] || "en-US";
  return d.toLocaleString(locale, opts);
}

function buildNotificationMessage(notice, clientLang = "en") {
  const lang = ["en", "zh", "es"].includes(clientLang) ? clientLang : "en";
  return MESSAGES[lang](notice);
}

// Build one-click contact links (email, WhatsApp, SMS)
function buildContactLinks({ notice, clientEmail, clientPhone, clientLang }) {
  const msg = buildNotificationMessage(notice, clientLang);
  const subject = ({
    en: "Hearing Reminder — Tez Law Firm",
    zh: "庭审提醒 — TEZ律师事务所",
    es: "Recordatorio de Audiencia — Tez Law Firm",
  })[clientLang || "en"];
  const phoneDigits = String(clientPhone || "").replace(/[^\d]/g, "");
  const encMsg = encodeURIComponent(msg);
  const encSubject = encodeURIComponent(subject);
  return {
    email: clientEmail ? `mailto:${encodeURIComponent(clientEmail)}?subject=${encSubject}&body=${encMsg}` : null,
    whatsapp: phoneDigits ? `https://wa.me/${phoneDigits}?text=${encMsg}` : null,
    sms: phoneDigits ? `sms:+${phoneDigits}?&body=${encMsg}` : null,
    raw_message: msg,
    subject,
  };
}

// Auto-dismiss notices whose hearing has passed. Called by the daily cron.
// Grace period (default 1 day) prevents dismissing notices from earlier today
// in case timezones cause off-by-one confusion.
async function dismissPastNotices({ gracePeriodDays = 1 } = {}) {
  await initTable();
  const result = await db.query(
    `UPDATE client_hearing_notices
     SET dismissed_at = NOW(),
         dismiss_reason = COALESCE(dismiss_reason, 'auto: hearing date passed')
     WHERE dismissed_at IS NULL
       AND is_hearing_notice = TRUE
       AND hearing_date IS NOT NULL
       AND hearing_date < NOW() - $1::interval
     RETURNING id, client_name, hearing_date`,
    [`${gracePeriodDays} days`]
  );
  return { dismissed_count: result.rowCount, dismissed: result.rows };
}

module.exports = {
  initTable,
  extractFromFile,
  fetchDropboxFile,
  scanClientFolder,
  listClientNotices,
  markNotified,
  dismissNotice,
  dismissPastNotices,
  buildNotificationMessage,
  buildContactLinks,
  getScanSetting,
  setScanSetting,
};
