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
  // Prevent double-inserting the exact same file (same hash) for the same client.
  // NOTE: this dedupes the FILE, not the HEARING. The same notice sitting in
  // two Dropbox folders is two files, so until scanClientFolder started
  // checking the hearing as well, it became two hearings on the calendar.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hearing_notices_dedup
      ON client_hearing_notices (client_key, dropbox_path, dropbox_hash)
  `);

  // Which row a duplicate was folded into. Set rather than deleting: the row
  // is still the record that a document arrived, and a merge stays reversible.
  try { await db.query(`ALTER TABLE client_hearing_notices ADD COLUMN IF NOT EXISTS duplicate_of INTEGER`); } catch {}

  // Looked up for every scanned file, and by the duplicates page.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_hearing_notices_hearing
      ON client_hearing_notices (client_key, hearing_date)
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
  const duplicates = [];      // hearings already on the calendar under another file
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

        // ── Is this hearing already on the client's calendar? ──
        //
        // The row written below is two things at once: a record that this
        // FILE has been read, and a record that this HEARING exists. The
        // ON CONFLICT target covers only the first. So the same notice in
        // two Dropbox folders, or re-saved under a new name, produced a
        // second hearing -- and a second reminder to the client.
        //
        // The email path (court-mail.js) has always checked the hearing
        // before inserting. This is that check, and because it looks at the
        // whole table it also catches the overlap between the two paths,
        // which neither of them handled.
        //
        // By day, not by timestamp: two copies of one notice routinely
        // disagree about the time -- one read as midnight because no time
        // was printed on the page it was taken from -- and matching the
        // timestamp would file them as two hearings, which is the bug.
        const already = await db.query(
          `SELECT id, hearing_time_text, hearing_type, court_name
             FROM client_hearing_notices
            WHERE client_key = $1
              AND hearing_date::date = $2::date
              AND is_hearing_notice = TRUE
              AND dismissed_at IS NULL
              AND duplicate_of IS NULL
            ORDER BY id ASC LIMIT 1`,
          [clientKey, hearingDate]
        ).catch((e) => { console.warn("[hearing-notices] dedup lookup:", e.message); return { rows: [] }; });

        if (already.rows.length) {
          const keepId = already.rows[0].id;

          // Record the file so it is not fetched and extracted again on every
          // scan, but not as a hearing: is_hearing_notice FALSE and dismissed
          // are what every reader in this application filters on, so the row
          // never reaches a calendar. hearing_date is kept, so the merge can
          // be read back and undone.
          await db.query(
            `INSERT INTO client_hearing_notices
               (client_key, client_name, a_number, dropbox_path, dropbox_hash,
                hearing_date, hearing_time_text, hearing_type, raw_extraction,
                is_hearing_notice, duplicate_of, dismissed_at, dismiss_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, FALSE, $10, NOW(), $11)
             ON CONFLICT (client_key, dropbox_path, dropbox_hash) DO UPDATE
               SET duplicate_of = EXCLUDED.duplicate_of,
                   is_hearing_notice = FALSE,
                   dismissed_at = COALESCE(client_hearing_notices.dismissed_at, NOW()),
                   dismiss_reason = COALESCE(client_hearing_notices.dismiss_reason, EXCLUDED.dismiss_reason)`,
            [
              clientKey, clientName || null, aNumber || null,
              file.path_display, file.content_hash || null,
              hearingDate, extraction.hearing_time || null,
              extraction.hearing_type || null,
              JSON.stringify(extraction), keepId,
              `duplicate of notice #${keepId} (same client, same hearing date)`,
            ]
          ).catch((e) => console.warn("[hearing-notices] duplicate row:", e.message));

          // This copy may carry a detail the one on the calendar lacks -- a
          // time, a courtroom, a judge. Fill gaps only; COALESCE(existing,
          // new) can never overwrite a value that is already there.
          await db.query(
            `UPDATE client_hearing_notices SET
               hearing_time_text = COALESCE(hearing_time_text, $2),
               hearing_type      = COALESCE(hearing_type, $3),
               court_name        = COALESCE(court_name, $4),
               court_address     = COALESCE(court_address, $5),
               judge_name        = COALESCE(judge_name, $6),
               notice_type       = COALESCE(notice_type, $7)
             WHERE id = $1`,
            [
              keepId, extraction.hearing_time || null, extraction.hearing_type || null,
              extraction.court_name || null, extraction.court_address || null,
              extraction.judge_name || null, extraction.notice_type || null,
            ]
          ).catch((e) => console.warn(`[hearing-notices] enrich #${keepId}:`, e.message));

          duplicates.push({
            file: file.name, dropbox_path: file.path_display, duplicate_of: keepId,
          });
          continue;   // not a new hearing: nothing to notify anybody about
        }

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

        // Log to universal audit trail (only for actual hearing notices)
        try {
          const audit = require("./ai-audit-trail");
          await audit.log({
            feature_type: "notice_scan",
            source_module: "hearing-notices.js",
            related_table: "client_hearing_notices",
            related_id: inserted.rows[0].id,
            client_key: clientKey,
            client_name: clientName || null,
            a_number: aNumber || null,
            matter_type: "immigration",
            original_output: JSON.stringify(extraction, null, 2),
            input_context_summary: `Extracted from ${file.name} (${Math.round((file.size || 0) / 1024)}KB, modified ${file.server_modified})`,
            model_used: EXTRACTION_MODEL,
            estimated_cost_usd: 0.0035,
          });
        } catch (e) { console.warn("[audit-trail] notice-scan log:", e.message); }
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

  return { scanned, skipped, notices, duplicates, errors, total_candidates: files.length, estimated_cost_usd: estimatedCostUsd, delta_skipped: false };
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
  en: (n) => `Hi, this is Tez Law Firm. This is a reminder about your upcoming ${hearingKind(n.hearing_type, "en")} hearing:

📅 Date: ${hearingWhen(n, "en")}
${n.court_name ? `📍 Court: ${n.court_name}\n` : ""}${n.court_address ? `📌 Address: ${n.court_address}\n` : ""}${n.judge_name ? `⚖️ Judge: ${n.judge_name}\n` : ""}
Please arrive 30 minutes early with your government-issued ID. If you cannot attend, call us IMMEDIATELY at 626-678-8677.

— TEZ LAW FIRM`,

  zh: (n) => `您好，这里是TEZ律师事务所。这是关于您即将到来的${hearingKind(n.hearing_type, "zh")}庭审的提醒：

📅 日期：${hearingWhen(n, "zh")}
${n.court_name ? `📍 法院：${n.court_name}\n` : ""}${n.court_address ? `📌 地址：${n.court_address}\n` : ""}${n.judge_name ? `⚖️ 法官：${n.judge_name}\n` : ""}
请提前30分钟到达并携带政府颁发的身份证件。如无法出席，请立即致电626-678-8677。

— TEZ律师事务所`,

  es: (n) => `Hola, le habla el bufete Tez Law. Le recordamos su próxima audiencia de ${hearingKind(n.hearing_type, "es")}:

📅 Fecha: ${hearingWhen(n, "es")}
${n.court_name ? `📍 Corte: ${n.court_name}\n` : ""}${n.court_address ? `📌 Dirección: ${n.court_address}\n` : ""}${n.judge_name ? `⚖️ Juez: ${n.judge_name}\n` : ""}
Por favor llegue 30 minutos antes con su identificación oficial. Si no puede asistir, llámenos INMEDIATAMENTE al 626-678-8677.

— TEZ LAW FIRM`,
};

// How a hearing's date, time and kind are stated to a client now lives in
// hearing-when.js, shared with hearing-reminders.js.
//
// What used to be here: a per-language prettyType() whose fallback turned a
// court notice's own "Custody Redetermination Hearing" into "hearing" (so a
// client read "your upcoming hearing hearing"), and a formatDate() that
// called toLocaleString with hour/minute and no timeZone. That printed
// hearing_date — a date-only value stored at noon UTC — in the server's zone,
// so a 9:00 AM hearing was announced as 12:00 PM, and hearing_time_text,
// which held the real "9:00 AM", was never read at all.
//
// Both builders had their own copy of that code and their own copy of that
// bug. One module now, so they cannot drift apart again.
const { hearingWhen, hearingKind } = require("./hearing-when");

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

// ── Duplicate hearings: find, preview, merge ──────────────
//
//  "double check the function to add and delete hearings. right now there
//   are alot of duplicate hearings in the calender."
//
//  WHY THEY HAPPEN. A row in client_hearing_notices is two things at once:
//  a note that a FILE has been read, and a note that a HEARING exists. Only
//  the first was ever deduplicated -- the unique index is on
//  (client_key, dropbox_path, dropbox_hash). So the same hearing notice
//  sitting in two Dropbox folders, or re-saved under a new name, was two
//  files, and therefore two hearings, and therefore two reminders. The
//  email path (court-mail.js) has always checked the hearing itself before
//  inserting; the Dropbox path never did, and neither checked the other.
//
//  scanClientFolder now makes that check, so no new ones appear. What
//  follows is for the ones already in the table.
//
//  IT DOES NOT CLEAN UP BY ITSELF. These are client records. Some have
//  already been sent to the client; some were dismissed by hand with a
//  reason somebody typed. The page shows exactly what it would merge and
//  changes nothing until the button is pressed, and a merge is reversible:
//  the losing rows keep their hearing_date and their file, and are marked
//  duplicate_of the row that stayed.

// How much of a hearing a given copy actually knows. The fullest copy is
// the one worth keeping; a copy the client has already been told about wins
// a tie, because that is the one the reminder log and the client's own
// records point at.
function noticeCompleteness(n) {
  return (n.notified_at ? 8 : 0)
    + (n.hearing_time_text ? 4 : 0)
    + (n.court_name ? 2 : 0)
    + (n.judge_name ? 1 : 0)
    + (n.court_address ? 1 : 0)
    + (n.hearing_type ? 1 : 0);
}

/**
 * Every hearing that is on the calendar more than once: same client, same
 * day. Read-only.
 *
 * Same day, not same timestamp, on purpose. Two copies of one notice often
 * disagree about the time -- one was read as midnight because no time was
 * printed on that page -- and grouping on the timestamp would file them as
 * two different hearings, which is the bug, not the fix.
 */
async function findDuplicateHearings({ includePast = false } = {}) {
  await initTable();

  const r = await db.query(
    `SELECT client_key, hearing_date::date AS day, COUNT(*)::int AS n
       FROM client_hearing_notices
      WHERE is_hearing_notice = TRUE
        AND dismissed_at IS NULL
        AND duplicate_of IS NULL
        AND hearing_date IS NOT NULL
        ${includePast ? "" : "AND hearing_date >= CURRENT_DATE"}
      GROUP BY client_key, hearing_date::date
     HAVING COUNT(*) > 1
      ORDER BY hearing_date::date ASC
      LIMIT 200`
  );

  const groups = [];
  for (const g of r.rows) {
    const rows = (await db.query(
      `SELECT id, client_key, client_name, a_number, dropbox_path, dropbox_hash,
              hearing_date, hearing_time_text, hearing_type, court_name,
              court_address, judge_name, notice_type, confidence,
              notified_at, notification_channel, created_at
         FROM client_hearing_notices
        WHERE client_key = $1 AND hearing_date::date = $2::date
          AND is_hearing_notice = TRUE AND dismissed_at IS NULL AND duplicate_of IS NULL
        ORDER BY id ASC`,
      [g.client_key, g.day]
    )).rows;
    if (rows.length < 2) continue;

    const sorted = [...rows].sort(
      (a, b) => noticeCompleteness(b) - noticeCompleteness(a) || a.id - b.id);

    // Reasons a human has to look at this one rather than trust the suggestion.
    const warnings = [];
    const distinct = (f) => [...new Set(rows.map(f).filter(Boolean))];
    const times = distinct(n => n.hearing_time_text);
    if (times.length > 1) warnings.push(`the copies disagree about the time: ${times.join(" vs ")}`);
    const types = distinct(n => (n.hearing_type || "").trim());
    if (types.length > 1) warnings.push(`and about the kind of hearing: ${types.join(" vs ")}`);
    const courts = distinct(n => (n.court_name || "").trim());
    if (courts.length > 1) warnings.push(`and about the court: ${courts.join(" vs ")}`);
    const sent = rows.filter(n => n.notified_at);
    if (sent.length > 1) warnings.push(`${sent.length} of these have already been sent to the client`);
    const paths = distinct(n => n.dropbox_path);
    if (paths.length > 1 && distinct(n => n.dropbox_hash).length === 1)
      warnings.push("the same file is filed in more than one Dropbox folder — worth merging the folders too");

    groups.push({
      client_key: g.client_key,
      client_name: rows[0].client_name,
      a_number: rows[0].a_number,
      day: g.day,
      count: g.n,
      notices: sorted,
      keep_id: sorted[0].id,
      collapse_ids: sorted.slice(1).map(n => n.id),
      warnings,
    });
  }
  return groups;
}

/**
 * Collapse the extra copies into one.
 *
 * The losing rows are not deleted. They keep their hearing_date, their
 * Dropbox path and their extraction, and gain duplicate_of pointing at the
 * row that stayed -- so this can be read back, audited, or undone. They are
 * marked is_hearing_notice = FALSE and dismissed, which is what every reader
 * in the application filters on, so they leave the calendar and stop
 * producing reminders without a single query needing to change.
 */
async function mergeDuplicateHearings(keepId, collapseIds) {
  await initTable();

  const ids = [...new Set(collapseIds.map(Number).filter(n => Number.isInteger(n) && n !== keepId))];
  if (!Number.isInteger(keepId) || !ids.length) throw new Error("need a row to keep and at least one to collapse");

  // The page may have been open a while. Re-check that these rows really are
  // the same client and the same day before touching them: merging two
  // unrelated hearings is far worse than showing a stale page.
  const keep = (await db.query(
    `SELECT id, client_key, hearing_date::date AS day FROM client_hearing_notices WHERE id = $1`,
    [keepId])).rows[0];
  if (!keep) throw new Error(`notice #${keepId} not found`);

  const victims = (await db.query(
    `SELECT id, client_key, hearing_date::date AS day FROM client_hearing_notices WHERE id = ANY($1::int[])`,
    [ids])).rows;
  const mismatched = victims.filter(
    v => v.client_key !== keep.client_key || String(v.day) !== String(keep.day));
  if (mismatched.length) {
    throw new Error(
      `refusing to merge: #${mismatched.map(v => v.id).join(", #")} `
      + `${mismatched.length === 1 ? "is" : "are"} not the same client and date as #${keepId}. `
      + "Reload the page and try again.");
  }
  if (!victims.length) throw new Error("none of those rows exist any more");

  // Anything a losing copy knows that the keeper does not, the keeper gets.
  // COALESCE, so a copy can only fill a gap, never overwrite what is there.
  await db.query(
    `UPDATE client_hearing_notices k SET
       hearing_time_text = COALESCE(k.hearing_time_text, d.hearing_time_text),
       hearing_type      = COALESCE(k.hearing_type,      d.hearing_type),
       court_name        = COALESCE(k.court_name,        d.court_name),
       court_address     = COALESCE(k.court_address,     d.court_address),
       judge_name        = COALESCE(k.judge_name,        d.judge_name),
       notice_type       = COALESCE(k.notice_type,       d.notice_type),
       a_number          = COALESCE(k.a_number,          d.a_number),
       client_name       = COALESCE(k.client_name,       d.client_name)
     FROM (
       SELECT MIN(hearing_time_text) AS hearing_time_text, MIN(hearing_type) AS hearing_type,
              MIN(court_name) AS court_name, MIN(court_address) AS court_address,
              MIN(judge_name) AS judge_name, MIN(notice_type) AS notice_type,
              MIN(a_number) AS a_number, MIN(client_name) AS client_name
         FROM client_hearing_notices WHERE id = ANY($2::int[])
     ) d
     WHERE k.id = $1`,
    [keepId, ids]);

  const collapsed = await db.query(
    `UPDATE client_hearing_notices SET
       duplicate_of      = $1,
       is_hearing_notice = FALSE,
       dismissed_at      = COALESCE(dismissed_at, NOW()),
       dismiss_reason    = COALESCE(dismiss_reason, 'merged into notice #' || $1)
     WHERE id = ANY($2::int[])
     RETURNING id`,
    [keepId, ids]);

  console.log(`[hearing-notices] merged ${collapsed.rowCount} duplicate(s) into #${keepId}`);
  return { keep_id: keepId, merged_count: collapsed.rowCount, merged_ids: collapsed.rows.map(r => r.id) };
}

/** Put a merged row back on the calendar. */
async function unmergeDuplicateHearing(id) {
  await initTable();
  const r = await db.query(
    `UPDATE client_hearing_notices SET
       duplicate_of = NULL, is_hearing_notice = TRUE,
       dismissed_at = NULL, dismiss_reason = NULL
     WHERE id = $1 AND duplicate_of IS NOT NULL AND hearing_date IS NOT NULL
     RETURNING id, client_name, hearing_date`,
    [id]);
  if (!r.rowCount) throw new Error(`#${id} is not a merged duplicate with a date on it`);
  return r.rows[0];
}

function renderDuplicateHearingsPage(groups, { includePast = false } = {}) {
  const { renderAdminChrome } = require("./hearing-notes");
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const extra = groups.reduce((n, g) => n + (g.count - 1), 0);
  const day = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`)
    .toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", year: "numeric", month: "short", day: "numeric" });

  const cards = groups.map(g => {
    const rows = g.notices.map((n, i) => {
      const keep = i === 0;
      const folder = n.dropbox_path
        ? esc(String(n.dropbox_path).split("/").slice(-2).join("/"))
        : '<em style="color:#8A827C;">from email</em>';
      return `<tr style="${keep ? "background:#FFF4E8;" : ""}">
        <td style="padding:8px 10px; white-space:nowrap;">${keep
          ? '<strong style="color:#A34C00;">KEEP</strong>'
          : '<span style="color:#5E5854;">merge in</span>'}</td>
        <td style="padding:8px 10px; font-family:ui-monospace,monospace; font-size:12px;">#${n.id}</td>
        <td style="padding:8px 10px; font-size:13px;">${esc(n.hearing_time_text) || '<span style="color:#8A827C;">no time</span>'}</td>
        <td style="padding:8px 10px; font-size:13px;">${esc(n.hearing_type) || "—"}</td>
        <td style="padding:8px 10px; font-size:13px;">${esc(n.court_name) || "—"}</td>
        <td style="padding:8px 10px; font-size:12px; color:#5E5854;">${folder}</td>
        <td style="padding:8px 10px; text-align:center;">${n.notified_at
          ? `<span title="sent to the client ${esc(n.notified_at)}">sent</span>` : ""}</td>
      </tr>`;
    }).join("");

    const warn = g.warnings.length ? `
      <div style="margin:0 0 14px; padding:10px 14px; background:#FFF4E8; border-left:3px solid #FF7B00; font-size:13px; color:#1E1B1A;">
        <strong>Read this one before merging.</strong> ${g.warnings.map(esc).join(". ")}.
      </div>` : "";

    return `<section style="background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:20px; margin-bottom:20px;">
      <div style="display:flex; justify-content:space-between; align-items:baseline; gap:16px; flex-wrap:wrap; margin-bottom:4px;">
        <h2 style="margin:0; font-size:18px; color:#2B2523;">${esc(g.client_name) || esc(g.client_key)}</h2>
        <span style="font-size:13px; color:#5E5854;">${day(g.day)} · ${g.count} copies${g.a_number ? ` · ${esc(g.a_number)}` : ""}</span>
      </div>
      <p style="margin:0 0 14px; font-size:13px; color:#5E5854;">
        One hearing, ${g.count} rows. Merging keeps #${g.keep_id} and fills any gaps in it from the others.
      </p>
      ${warn}
      <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:16px;">
        <thead><tr style="text-align:left; color:#8A827C; font-size:11px; letter-spacing:.06em; text-transform:uppercase;">
          <th style="padding:6px 10px;"></th><th style="padding:6px 10px;">Row</th><th style="padding:6px 10px;">Time</th>
          <th style="padding:6px 10px;">Type</th><th style="padding:6px 10px;">Court</th>
          <th style="padding:6px 10px;">File</th><th style="padding:6px 10px;"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button type="button" class="merge-btn" data-keep="${g.keep_id}" data-collapse="${g.collapse_ids.join(",")}"
        style="background:#A34C00; color:#FFFFFF; border:0; padding:10px 18px; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer;">
        Merge these ${g.count} into #${g.keep_id}
      </button>
      <span class="merge-msg" style="margin-left:12px; font-size:13px;"></span>
    </section>`;
  }).join("");

  const body = `
    <div class="page-header"><h1>Duplicate hearings</h1></div>

    <p style="max-width:62ch; color:#1E1B1A; font-size:14px; line-height:1.6;">
      ${groups.length
        ? `${groups.length} hearing${groups.length === 1 ? " is" : "s are"} on the calendar more than once — ${extra} extra row${extra === 1 ? "" : "s"} in all.
           Nothing here has been changed. Merging keeps the fullest copy, fills its gaps from the others, and takes the
           rest off the calendar without deleting them, so a merge can be undone.`
        : `No hearing is on the calendar twice${includePast ? "" : " from today onward"}. New ones are now prevented at the
           point a notice is read, so this page should stay empty.`}
    </p>

    <p style="font-size:13px; color:#5E5854;">
      <a href="/admin/hearing/notices/duplicates${includePast ? "" : "?past=1"}" style="color:#A34C00;">
        ${includePast ? "Show only upcoming hearings" : "Include hearings that have already happened"}</a>
      &nbsp;·&nbsp;
      <a href="/admin/hearing/notes/duplicates" style="color:#A34C00;">Duplicate hearing notes (a different table)</a>
    </p>

    ${cards}

    <script>
      document.querySelectorAll(".merge-btn").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var msg = btn.parentElement.querySelector(".merge-msg");
          var keep = parseInt(btn.dataset.keep, 10);
          var collapse = btn.dataset.collapse.split(",").map(Number).filter(Boolean);
          if (!window.confirm("Keep #" + keep + " and merge " + collapse.length + " other row(s) into it?\\n\\nThis can be undone.")) return;
          btn.disabled = true; btn.style.opacity = ".5";
          msg.style.color = "#5E5854"; msg.textContent = "merging\\u2026";
          try {
            var resp = await fetch("/admin/hearing/notices/merge-duplicates", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ keep_id: keep, collapse_ids: collapse }),
            });
            var data = await resp.json();
            if (!data.ok) throw new Error(data.error || "merge failed");
            msg.style.color = "#A34C00";
            msg.textContent = "merged " + data.merged_count + " into #" + data.keep_id + ".";
            btn.closest("section").style.opacity = ".45";
          } catch (e) {
            msg.style.color = "#A34C00";
            msg.textContent = e.message;
            btn.disabled = false; btn.style.opacity = "1";
          }
        });
      });
    </script>`;

  return renderAdminChrome({ title: "Duplicate hearings", body, activeItem: "notice-duplicates" });
}

module.exports = {
  initTable,
  findDuplicateHearings,
  mergeDuplicateHearings,
  unmergeDuplicateHearing,
  renderDuplicateHearingsPage,
  noticeCompleteness,
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
