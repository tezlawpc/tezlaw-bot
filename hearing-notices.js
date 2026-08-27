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
      created_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_client_hearing_notices_client
      ON client_hearing_notices (client_key)
  `);
  // Prevent double-inserting the exact same file (same hash) for the same client
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_hearing_notices_dedup
      ON client_hearing_notices (client_key, dropbox_path, dropbox_hash)
  `);
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

async function extractFromFile({ buffer, mimeType, filename }) {
  const isPdf = mimeType && mimeType.includes("pdf");
  const isImage = mimeType && mimeType.startsWith("image/");
  if (!isPdf && !isImage) {
    // Skip anything we can't OCR — Word docs, spreadsheets, etc.
    return { is_hearing_notice: false, reason: `unsupported mime: ${mimeType}` };
  }
  const base64 = buffer.toString("base64");
  let normalizedMime = mimeType;
  if (mimeType === "image/heic" || mimeType === "image/heif") normalizedMime = "image/jpeg";

  const prompt = `You are scanning an immigration case file for hearing notices from EOIR (Immigration Court), USCIS, or state courts.

FIRST decide: is this document a hearing notice — meaning it schedules a specific future hearing/interview and includes date + time + location?

Return ONLY valid JSON with this exact structure (no preamble, no code fences):

{
  "is_hearing_notice": true or false,
  "confidence": "high" | "medium" | "low",
  "notice_type": "EOIR master hearing notice" | "EOIR individual hearing notice" | "EOIR bond hearing notice" | "USCIS interview notice" | "USCIS biometrics notice" | "other" | null,
  "hearing_date": "YYYY-MM-DD" or null,
  "hearing_time": "HH:MM" 24h or null,
  "hearing_type": "master" | "individual" | "bond" | "status" | "biometrics" | "interview" | "other" | null,
  "court_name": "Full court name (e.g. 'Los Angeles Immigration Court', 'USCIS Los Angeles Field Office')" or null,
  "court_address": "Full street address including city, state, ZIP" or null,
  "judge_name": "Immigration Judge name if listed" or null,
  "client_name": "Respondent/applicant name if listed" or null,
  "a_number": "A-Number with format A123-456-789 if listed" or null,
  "notes": "Any short important notes: 'appear in person', 'via WebEx', 'reschedule of X/Y date', etc." or null
}

Rules:
- If is_hearing_notice is false, set all other fields to null.
- Only set is_hearing_notice=true if the document clearly SCHEDULES a hearing — not a status report, transcript, motion, or general letter.
- If it's a reschedule notice, use the NEW scheduled date, not the vacated one.
- Confidence: "high" if all key fields are clearly readable, "medium" if some fields inferred, "low" if you're mostly guessing.
- Filename is "${filename}" — use it as a hint but don't rely on it alone.`;

  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image",    source: { type: "base64", media_type: normalizedMime,    data: base64 } };

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 90000,
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

// ── Scan a client's Dropbox folder ───────────────────────

// Returns { scanned, hearing_notices_found, skipped }
async function scanClientFolder({ clientKey, clientName, aNumber, dropboxFolderPath, limit = 20 }) {
  await initTable();
  const dbx = require("./dropbox-integration");

  const entries = await dbx.listFolder(dropboxFolderPath);
  if (!entries) return { scanned: 0, notices: [], error: "Folder not found or empty" };

  const files = entries
    .filter(e => e[".tag"] === "file" && looksLikeNoticeCandidate(e.name))
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

  return { scanned, skipped, notices, errors, total_candidates: files.length };
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

module.exports = {
  initTable,
  extractFromFile,
  fetchDropboxFile,
  scanClientFolder,
  listClientNotices,
  markNotified,
  dismissNotice,
  buildNotificationMessage,
  buildContactLinks,
};
