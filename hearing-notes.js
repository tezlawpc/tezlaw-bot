// ============================================================
//  TEZ LAW P.C. — HEARING NOTES
//  ─────────────────────────────────────────────────────────
//  Structured note-taking tool for USE DURING master calendar
//  (and other) hearings. Attorney takes notes on laptop, Zara
//  cleans them up and produces two outputs:
//    1. Paralegal summary — complete, structured, professional
//    2. Client summary — in client's language, plain language
//
//  Delivery:
//    - Paralegal: Telegram to Jue (via RECIPIENT_JUE_TELEGRAM_ID)
//    - Client: copy-to-clipboard (paste into WhatsApp, email, etc.)
//    - Both: copy buttons available always
//
//  No SMTP send yet (waiting on GoDaddy resolution).
// ============================================================

const axios = require("axios");
const db = require("./db");

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// ── Schema ───────────────────────────────────────────────

async function initHearingNotesTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS hearing_notes (
      id                    SERIAL PRIMARY KEY,
      client_name           TEXT NOT NULL,
      a_number              TEXT,
      client_language       TEXT DEFAULT 'en',
      client_email          TEXT,
      client_phone          TEXT,
      judge_name            TEXT,
      hearing_date          TIMESTAMPTZ,
      hearing_type          TEXT DEFAULT 'master',
      case_type             TEXT,
      dhs_attorney          TEXT,
      client_attendance     TEXT,
      attorney_appearance   TEXT,
      pleadings_admitted    TEXT,
      pleadings_denied      TEXT,
      pleadings_contested   TEXT,
      pleadings_method      TEXT,
      removability_conceded BOOLEAN,
      applications          JSONB DEFAULT '[]'::jsonb,
      disposition           TEXT,
      disposition_notes     TEXT,
      bond_outcome          TEXT,
      bond_amount           INTEGER,
      next_hearing_date     TIMESTAMPTZ,
      next_hearing_type     TEXT,
      interpreter_used      BOOLEAN,
      interpreter_language  TEXT,
      deadlines             JSONB DEFAULT '[]'::jsonb,
      raw_notes             TEXT,
      paralegal_summary     TEXT,
      client_summary        TEXT,
      sent_to_paralegal_at  TIMESTAMPTZ,
      sent_to_client_at     TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrations for tables that predate the new columns
  for (const col of [
    ["dhs_attorney", "TEXT"],
    ["client_attendance", "TEXT"],
    ["attorney_appearance", "TEXT"],
    ["disposition", "TEXT"],
    ["disposition_notes", "TEXT"],
    ["bond_outcome", "TEXT"],
    ["bond_amount", "INTEGER"],
    ["pleadings_method", "TEXT"],
  ]) {
    try {
      await db.query(`ALTER TABLE hearing_notes ADD COLUMN IF NOT EXISTS ${col[0]} ${col[1]}`);
    } catch (e) { /* older Postgres may not support IF NOT EXISTS on ADD COLUMN */ }
  }
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_hearing_notes_created
      ON hearing_notes (created_at DESC)
  `);
}

// ── I-589 PDF Extraction (OCR via Claude) ────────────────
//
// Accepts a PDF buffer (fillable or scanned) and extracts client info
// relevant to hearing notes. Uses Claude Sonnet for better OCR accuracy
// on scanned documents.

async function extractI589FieldsFromPdf(pdfBuffer) {
  const base64Pdf = pdfBuffer.toString("base64");

  const prompt = `You are extracting data from a USCIS Form I-589 (Application for Asylum and for Withholding of Removal).

The PDF may be a fillable form OR a scanned/printed copy. Extract the following fields as accurately as possible. If a field is illegible or not present, use null.

Extract these fields and return ONLY valid JSON with this exact structure (no other text):

{
  "client_name": "Full legal name (Last, First Middle format if possible)",
  "a_number": "A-Number if visible (format: A123-456-789)",
  "date_of_birth": "Date of birth (YYYY-MM-DD format)",
  "country_of_citizenship": "Country of citizenship/nationality",
  "country_of_birth": "Country of birth",
  "native_language": "Native/primary language (e.g. Mandarin, Spanish, Punjabi)",
  "us_address": "Client's US mailing address (street, city, state, zip)",
  "asylum_basis": ["Array of persecution grounds checked (any of: race, religion, nationality, political_opinion, particular_social_group, torture)"],
  "spouse_name": "Spouse's name if listed",
  "children_count": "Number of children listed on the form (integer or null)",
  "date_of_entry": "Date of last entry to US (YYYY-MM-DD)",
  "manner_of_entry": "Manner of last entry (e.g. visa waiver, EWI, B1/B2, etc)"
}

Important rules:
- Return ONLY the JSON object. No preamble, no explanation, no code fences.
- Use null (not empty string) for any field you cannot read.
- For dates, use YYYY-MM-DD format. If only month/year visible, use YYYY-MM-01. If unclear, use null.
- For the A-Number, include the "A" prefix and dashes if that's how it appears.
- Do NOT invent data. If unsure, use null.`;

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64Pdf,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 120000, // 2 min — OCR of 15-page PDF takes time
    }
  );

  const text = resp.data.content?.[0]?.text?.trim() || "{}";
  // Strip potential code fences
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let extracted;
  try {
    extracted = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned unparseable JSON: ${cleaned.substring(0, 200)}`);
  }

  // Map extracted native language to our language code
  const langCode = mapLanguageNameToCode(extracted.native_language);

  return {
    raw: extracted,
    // Fields that map directly to the hearing notes form:
    form_prefill: {
      client_name: extracted.client_name || null,
      a_number: extracted.a_number || null,
      client_language: langCode,
      case_type: "Asylum (I-589)",
      // These aren't on the form yet but we return them anyway for
      // downstream use (e.g. saving to case file):
      _extra: {
        date_of_birth: extracted.date_of_birth,
        country_of_citizenship: extracted.country_of_citizenship,
        country_of_birth: extracted.country_of_birth,
        native_language: extracted.native_language,
        us_address: extracted.us_address,
        asylum_basis: extracted.asylum_basis,
        spouse_name: extracted.spouse_name,
        children_count: extracted.children_count,
        date_of_entry: extracted.date_of_entry,
        manner_of_entry: extracted.manner_of_entry,
      },
    },
  };
}

function mapLanguageNameToCode(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  if (/mandarin|cantonese|chinese|mandarín|中文/i.test(lower)) return "zh";
  if (/spanish|español|espanol|castellano/i.test(lower)) return "es";
  if (/hindi|हिन्दी/i.test(lower)) return "hi";
  if (/punjabi|panjabi|ਪੰਜਾਬੀ/i.test(lower)) return "pa";
  if (/english|inglés|anglais/i.test(lower)) return "en";
  return null; // unknown language, let user pick
}

// ── AI Summary Generation ────────────────────────────────

async function generateParalegalSummary(data) {
  const structured = buildStructuredNotes(data);

  const prompt = `You are cleaning up immigration court hearing notes for a paralegal at Tez Law, P.C.

The attorney (JJ Zhang) took these notes during the hearing. Your job is to produce a clean, professional summary the paralegal (Jue Wang) can use to update the case file.

Rules:
- Complete and detailed — include ALL information provided
- Structured with clear headings
- Professional attorney-to-paralegal tone (efficient, factual)
- Preserve ALL specific dates, deadlines, allegation numbers, and case details exactly
- Do NOT invent or embellish — only use what's in the notes
- Do NOT add "Please note" or "Kindly" language — direct and efficient
- Use bullet points where appropriate for scannability
- End with an "Action Items" section listing what the paralegal needs to do

Structured hearing data:
${structured}

Attorney's raw notes:
${data.raw_notes || "(no additional notes)"}

Produce the paralegal summary now. Start directly with the summary — no preamble.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
    return resp.data.content?.[0]?.text?.trim() || "(summary generation failed)";
  } catch (e) {
    console.error("[hearing-notes] Paralegal summary error:", e.message);
    return `AI cleanup unavailable. Raw notes below:\n\n${structured}\n\n---\n\n${data.raw_notes || ""}`;
  }
}

async function generateClientSummary(data) {
  const lang = data.client_language || "en";
  const langNames = {
    en: "English",
    zh: "Simplified Chinese (中文)",
    es: "Spanish (Español)",
    hi: "Hindi (हिन्दी)",
    pa: "Punjabi (ਪੰਜਾਬੀ)",
  };
  const languageName = langNames[lang] || "English";

  const structured = buildStructuredNotes(data);

  const prompt = `You are writing a client-friendly hearing summary in ${languageName}.

The client attended their immigration court hearing today with attorney JJ Zhang of Tez Law, P.C. Your job is to write a warm but professional summary explaining what happened and what they need to do next.

Rules:
- Write ENTIRELY in ${languageName}
- Plain language — no legalese, no Latin phrases
- Warm and reassuring tone but professional
- Focus on: what happened, what deadlines the client needs to remember, what they need to do next
- Include specific dates and deadlines with clear context
- Do NOT invent information — only what's in the notes
- End with attorney contact info: "If you have questions, please contact us at 626-678-8677 or jj@tezlawfirm.com" (translate this line too)
- If interpreter was used, mention this positively
- Address the client directly ("You" / "您" / "Usted" / "आप" / "ਤੁਸੀਂ")
- Sign off with "Sincerely, Attorney JJ Zhang, Tez Law, P.C." (translate)

Client's name: ${data.client_name}

Hearing details (in English — you translate the relevant parts):
${structured}

Attorney's raw notes:
${data.raw_notes || "(no additional notes)"}

Produce the client summary in ${languageName} now. Start directly with the greeting.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
    return resp.data.content?.[0]?.text?.trim() || "(summary generation failed)";
  } catch (e) {
    console.error("[hearing-notes] Client summary error:", e.message);
    return "(AI summary unavailable — please write manually)";
  }
}

// Build a structured representation of the notes data for AI prompting
function buildStructuredNotes(data) {
  const lines = [
    `Client: ${data.client_name || "(not provided)"}`,
    `A-Number: ${data.a_number || "(not provided)"}`,
    `Client contact: ${[data.client_email, data.client_phone].filter(Boolean).join(" / ") || "(not provided)"}`,
    `Judge: ${data.judge_name || "(not provided)"}`,
    `DHS Trial Attorney: ${data.dhs_attorney || "(not noted)"}`,
    `Hearing date: ${data.hearing_date ? new Date(data.hearing_date).toLocaleString() : "(not provided)"}`,
    `Hearing type: ${data.hearing_type || "master"}`,
    `Case type: ${data.case_type || "(not specified)"}`,
    `Client attendance: ${data.client_attendance || "(not noted)"}`,
    `Attorney appearance: ${data.attorney_appearance || "(not noted)"}`,
    "",
    "PLEADINGS TAKEN:",
    `  Method: ${data.pleadings_method || "(not noted)"}`,
    `  Removability conceded: ${data.removability_conceded ? "Yes" : "No"}`,
    "",
    `APPLICATIONS REQUESTED: ${(data.applications && data.applications.length) ? data.applications.join(", ") : "(none noted)"}`,
    "",
    "DISPOSITION (outcome of today's hearing):",
    `  ${data.disposition || "(not noted)"}`,
    data.disposition_notes ? `  Details: ${data.disposition_notes}` : "",
    "",
  ];

  // Bond section only if noted
  if (data.bond_outcome && data.bond_outcome !== "not_applicable" && data.bond_outcome !== "") {
    lines.push("BOND:");
    lines.push(`  Outcome: ${data.bond_outcome}`);
    if (data.bond_outcome === "granted" && data.bond_amount) {
      lines.push(`  Amount: $${Number(data.bond_amount).toLocaleString()}`);
    }
    lines.push("");
  }

  lines.push(
    "NEXT HEARING:",
    `  Type: ${data.next_hearing_type || "(not scheduled)"}`,
    `  Date/time: ${data.next_hearing_date ? new Date(data.next_hearing_date).toLocaleString() : "(not scheduled)"}`,
    "",
    `INTERPRETER: ${data.interpreter_used ? `Yes (${data.interpreter_language || "language not noted"})` : "No"}`,
    "",
    "DEADLINES SET:"
  );
  if (data.deadlines && data.deadlines.length) {
    for (const d of data.deadlines) {
      lines.push(`  • ${d.date || "(date TBD)"}: ${d.description || "(no description)"}`);
    }
  } else {
    lines.push("  (none noted)");
  }
  return lines.filter(l => l !== "").join("\n").replace(/\n\n+/g, "\n\n");
}

// ── Storage ──────────────────────────────────────────────

async function saveNote(data, { generateSummaries = true } = {}) {
  await initHearingNotesTables();

  let paralegal_summary = null;
  let client_summary = null;

  if (generateSummaries) {
    // Generate both in parallel to save time
    const [pSum, cSum] = await Promise.all([
      generateParalegalSummary(data),
      generateClientSummary(data),
    ]);
    paralegal_summary = pSum;
    client_summary = cSum;
  }

  const r = await db.query(
    `INSERT INTO hearing_notes
      (client_name, a_number, client_language, client_email, client_phone,
       judge_name, hearing_date, hearing_type, case_type,
       dhs_attorney, client_attendance, attorney_appearance,
       pleadings_admitted, pleadings_denied, pleadings_contested, pleadings_method, removability_conceded,
       applications, disposition, disposition_notes, bond_outcome, bond_amount,
       next_hearing_date, next_hearing_type,
       interpreter_used, interpreter_language, deadlines,
       raw_notes, paralegal_summary, client_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15, $16, $17, $18::jsonb, $19, $20, $21, $22,
             $23, $24, $25, $26, $27::jsonb,
             $28, $29, $30)
     RETURNING id`,
    [
      data.client_name, data.a_number || null, data.client_language || "en",
      data.client_email || null, data.client_phone || null,
      data.judge_name || null, data.hearing_date || null,
      data.hearing_type || "master", data.case_type || null,
      data.dhs_attorney || null, data.client_attendance || null, data.attorney_appearance || null,
      data.pleadings_admitted || null, data.pleadings_denied || null,
      data.pleadings_contested || null, data.pleadings_method || null,
      !!data.removability_conceded,
      JSON.stringify(data.applications || []),
      data.disposition || null, data.disposition_notes || null,
      data.bond_outcome || null, data.bond_amount || null,
      data.next_hearing_date || null, data.next_hearing_type || null,
      !!data.interpreter_used, data.interpreter_language || null,
      JSON.stringify(data.deadlines || []),
      data.raw_notes || null, paralegal_summary, client_summary,
    ]
  );
  return { id: r.rows[0].id, paralegal_summary, client_summary };
}

async function listNotes(limit = 50) {
  await initHearingNotesTables();
  const r = await db.query(
    `SELECT id, client_name, a_number, hearing_date, next_hearing_date, next_hearing_type,
       client_language, sent_to_paralegal_at, sent_to_client_at, created_at
     FROM hearing_notes
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getNote(id) {
  await initHearingNotesTables();
  const r = await db.query(`SELECT * FROM hearing_notes WHERE id = $1`, [id]);
  return r.rows[0];
}

// ── Telegram Send ────────────────────────────────────────

async function sendToParalegal(id) {
  const note = await getNote(id);
  if (!note) throw new Error(`Note ${id} not found`);
  if (!note.paralegal_summary) throw new Error("No paralegal summary generated");

  const rawRecipient = process.env.RECIPIENT_JUE_TELEGRAM_ID || process.env.RECIPIENT_JUE_TELEGRAM;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!rawRecipient || !telegramToken) {
    throw new Error("Telegram not configured. Set RECIPIENT_JUE_TELEGRAM_ID env var (either Jue's numeric user ID from @userinfobot, OR her @username — she must have started your bot first).");
  }

  // Resolve the recipient to a chat_id. If already numeric, use as-is.
  // If it starts with @ or is a string username, try to resolve via getChat.
  let chatId = null;
  const trimmed = String(rawRecipient).trim();
  if (/^-?\d+$/.test(trimmed)) {
    chatId = trimmed;
  } else {
    // Username path — needs @ prefix for getChat
    const withAt = trimmed.startsWith("@") ? trimmed : "@" + trimmed;
    try {
      const resp = await axios.get(
        `https://api.telegram.org/bot${telegramToken}/getChat`,
        { params: { chat_id: withAt }, timeout: 10000 }
      );
      if (resp.data && resp.data.ok && resp.data.result?.id) {
        chatId = String(resp.data.result.id);
      }
    } catch (e) {
      const detail = e.response?.data?.description || e.message;
      throw new Error(`Could not resolve Telegram user ${withAt}: ${detail}. She may need to message your bot first (@TEZJJBot), OR give me her numeric user ID from @userinfobot.`);
    }
    if (!chatId) {
      throw new Error(`Could not resolve Telegram user ${withAt}. She may need to message your bot first.`);
    }
  }

  const header = `📋 *Hearing Notes — ${note.client_name}*\nA#: ${note.a_number || "(none)"}\nDate: ${note.hearing_date ? new Date(note.hearing_date).toLocaleDateString() : "(not set)"}\n\n`;
  const message = header + note.paralegal_summary;

  // Telegram has a 4096 char limit per message
  const chunks = [];
  const MAX = 4000;
  let remaining = message;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf("\n\n", MAX);
    if (cut < 1000) cut = remaining.lastIndexOf("\n", MAX);
    if (cut < 1000) cut = MAX;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trim();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${telegramToken}/sendMessage`,
        {
          chat_id: chatId,
          text: chunk,
          parse_mode: "Markdown",
        },
        { timeout: 15000 }
      );
    } catch (e) {
      const detail = e.response?.data?.description || e.message;
      throw new Error(`Telegram send failed: ${detail}. Recipient may need to message @TEZJJBot first to enable delivery.`);
    }
  }

  await db.query(
    `UPDATE hearing_notes SET sent_to_paralegal_at = NOW() WHERE id = $1`,
    [id]
  );

  return { sent: true, chunks: chunks.length, resolved_chat_id: chatId };
}

// ── Admin Panel Chrome (Sidebar + Layout) ────────────────
// Matches admin.js styling so hearing notes pages feel integrated.
// activeItem: which nav item to highlight — "notes" | "history" | null

function renderAdminChrome({ title, body, activeItem = null }) {
  const notesActive = activeItem === "notes" ? "active" : "";
  const historyActive = activeItem === "history" ? "active" : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Zara Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #f0ede6; color: #0C1C36; }

  /* Sidebar (mirrors admin.js) */
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; width: 220px;
             background: #0C1C36; padding: 0; z-index: 100;
             overflow-y: auto; overflow-x: hidden; }
  .sidebar::-webkit-scrollbar { width: 6px; }
  .sidebar::-webkit-scrollbar-track { background: transparent; }
  .sidebar::-webkit-scrollbar-thumb { background: rgba(183,156,98,.3); border-radius: 3px; }
  .sidebar::-webkit-scrollbar-thumb:hover { background: rgba(183,156,98,.6); }
  .sidebar-logo { padding: 24px 20px; border-bottom: 1px solid rgba(183,156,98,.3); }
  .sidebar-logo h2 { color: #B79C62; font-size: 18px; }
  .sidebar-logo p { color: rgba(183,156,98,.6); font-size: 11px; margin-top: 2px; }
  .nav-item { display: block; padding: 14px 20px; color: rgba(255,255,255,.7);
              cursor: pointer; border-left: 3px solid transparent; transition: all .2s;
              font-size: 14px; text-decoration: none; }
  .nav-item:hover, .nav-item.active { color: #B79C62; background: rgba(183,156,98,.1);
                                       border-left-color: #B79C62; }
  .nav-item .icon { margin-right: 10px; }

  /* Main */
  .main { margin-left: 220px; padding: 28px; min-height: 100vh; }
  .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .page-header h1 { color: #0C1C36; font-size: 24px; }
  .back-link { color: #B79C62; text-decoration: none; font-size: 13px; }
  .back-link:hover { text-decoration: underline; }

  /* Mobile responsive */
  @media (max-width: 768px) {
    .sidebar { width: 56px; padding: 0; }
    .sidebar-logo { padding: 14px 8px; text-align: center; border-bottom: 1px solid rgba(183,156,98,.3); }
    .sidebar-logo img { width: 36px !important; margin: 0 auto 4px !important; }
    .sidebar-logo h2 { font-size: 11px; letter-spacing: .04em; }
    .sidebar-logo p { display: none; }
    .nav-item { padding: 12px 0; text-align: center; font-size: 16px; }
    .nav-item span:not(.icon) { display: none; }
    .nav-item .icon { margin-right: 0; font-size: 18px; }
    .main { margin-left: 56px; padding: 16px 12px; }
    .page-header { flex-wrap: wrap; gap: 10px; }
    .page-header h1 { font-size: 18px; }
  }

  /* Hearing form specific */
  label { display: block; margin: 10px 0 4px; font-weight: 600; font-size: 14px; }
  input[type="text"], input[type="datetime-local"], input[type="date"], select, textarea {
    width: 100%; padding: 8px; margin: 3px 0; box-sizing: border-box;
    border: 1px solid #ccc; border-radius: 4px; font-size: 14px; font-family: inherit;
  }
  textarea { min-height: 60px; }
  input[type="checkbox"] { margin-right: 6px; transform: scale(1.15); }
  .row { display: flex; gap: 12px; margin: 6px 0; }
  .row > div { flex: 1; }
  fieldset { border: 1px solid #ddd; padding: 15px; margin: 15px 0; border-radius: 4px; background: white; }
  legend { font-weight: 600; color: #0C1C36; padding: 0 8px; }
  .button-row { margin-top: 25px; display: flex; gap: 10px; flex-wrap: wrap; }
  button {
    padding: 12px 24px; font-size: 15px; border-radius: 4px; cursor: pointer;
    border: none; font-family: inherit;
  }
  button[type="submit"] { background: #B79C62; color: white; }
  button[type="submit"]:hover { background: #8f7a4c; }
  button.secondary { background: #eee; color: #333; }
  #raw_notes { min-height: 200px; font-family: monospace; font-size: 14px; }
  .deadlines-container { margin: 8px 0; }
  .deadline-row { display: flex; gap: 8px; margin: 6px 0; }
  .deadline-row input[type="date"] { flex: 0 0 160px; }
  .deadline-row input[type="text"] { flex: 1; }
  .deadline-row button { flex: 0 0 auto; padding: 4px 10px; background: #eee; border: none; cursor: pointer; border-radius: 4px; }
  .add-deadline { background: #eee; padding: 6px 12px; border: none; cursor: pointer; border-radius: 4px; font-size: 13px; }
  .hint { color: #666; font-size: 12px; font-style: italic; margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background: white; }
  th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f5f5f5; color: #0C1C36; }
  tr:hover { background: #fafafa; }
</style>
</head>
<body>

<div class="sidebar">
  <div class="sidebar-logo">
    <img src="https://tezlawfirm.com/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png" alt="TEZ Law" style="width:60px;height:auto;display:block;margin-bottom:8px">
    <h2>Zara</h2>
    <p>Admin Panel</p>
  </div>
  <a href="/admin/matters/" class="nav-item" style="background:rgba(183,156,98,.08); border-left-color:rgba(183,156,98,.4); border-bottom:1px solid rgba(183,156,98,.2);">
    <span class="icon">⚖️</span><span>→ Matter Manager</span>
  </a>
  <a href="/admin/hearing/notes" class="nav-item ${notesActive}" style="background:rgba(183,156,98,.08); ${notesActive ? "" : "border-left-color:rgba(183,156,98,.4);"} border-bottom:1px solid rgba(183,156,98,.2);">
    <span class="icon">📝</span><span>→ Hearing Notes</span>
  </a>
  <a href="/admin/hearing/notes/history" class="nav-item ${historyActive}" style="border-bottom:1px solid rgba(183,156,98,.2); font-size:13px; opacity:.85;">
    <span class="icon">📚</span><span>Hearing History</span>
  </a>
  <a href="/admin/email-setup" class="nav-item" style="border-bottom:1px solid rgba(183,156,98,.2); font-size:13px; opacity:.85;">
    <span class="icon">📬</span><span>Email Setup</span>
  </a>
  <a href="/admin/" class="nav-item">
    <span class="icon">📊</span><span>Dashboard</span>
  </a>
</div>

<div class="main">
  ${body}
</div>

</body>
</html>`;
}

// ── HTML: Note-Taking Form ───────────────────────────────

const APPLICATION_OPTIONS = [
  "I-589 Asylum",
  "Withholding of Removal",
  "CAT (Convention Against Torture)",
  "Cancellation of Removal (LPR)",
  "Cancellation of Removal (non-LPR)",
  "Adjustment of Status (I-485)",
  "I-130 Petition for Alien Relative",
  "I-751 Removal of Conditions",
  "I-360 Special Immigrant / VAWA",
  "I-601 Waiver (inadmissibility)",
  "I-601A Provisional Waiver",
  "I-212 Consent to Reapply",
  "212(c) Relief",
  "212(h) Waiver",
  "237(a)(1)(H) Waiver (fraud)",
  "N-400 Naturalization",
  "TPS (Temporary Protected Status)",
  "NACARA",
  "SIJ (Special Immigrant Juvenile)",
  "U Visa (I-918)",
  "T Visa (I-914)",
  "Voluntary Departure",
  "Prosecutorial Discretion",
  "Termination",
  "Administrative Closure",
  "Motion to Reopen",
  "Motion to Reconsider",
  "Motion to Change Venue",
  "Other",
];

function renderNoteForm({ generated = null, saved = false, sent = null, error = null, prev = {} } = {}) {
  const langOptions = [
    { v: "en", l: "English" },
    { v: "zh", l: "中文 (Chinese)" },
    { v: "es", l: "Español (Spanish)" },
    { v: "hi", l: "हिन्दी (Hindi)" },
    { v: "pa", l: "ਪੰਜਾਬੀ (Punjabi)" },
  ].map(o => `<option value="${o.v}" ${prev.client_language === o.v ? "selected" : ""}>${o.l}</option>`).join("");

  const hearingTypeOptions = [
    "master", "individual/merits", "status", "bond", "custody redetermination", "other"
  ].map(t => `<option value="${t}" ${prev.hearing_type === t ? "selected" : ""}>${t}</option>`).join("");

  const nextHearingTypeOptions = [
    "", "master", "individual/merits", "status", "bond", "hearing on motion", "other"
  ].map(t => `<option value="${t}" ${prev.next_hearing_type === t ? "selected" : ""}>${t || "(none scheduled)"}</option>`).join("");

  const prevApps = prev.applications || [];
  const applicationCheckboxes = APPLICATION_OPTIONS.map((app, i) => `
    <label style="display:inline-flex; align-items:center; font-weight:normal; margin:4px 12px 4px 0;">
      <input type="checkbox" name="application_${i}" value="${escapeAttr(app)}" ${prevApps.includes(app) ? "checked" : ""}>
      ${escapeHtml(app)}
    </label>`).join("");

  const errorSection = error ? `
    <div style="background:#ffebee; padding:15px; border-left:4px solid #c00; margin:15px 0; border-radius:4px;">
      <strong>⚠️ Error:</strong> ${escapeHtml(error)}
    </div>` : "";

  const previewSection = generated ? `
    <div style="background:#f5f9ff; padding:20px; margin:20px 0; border-left:4px solid #0C1C36; border-radius:4px;">
      <h2 style="margin-top:0;">📋 Paralegal Summary (English, detailed)</h2>
      <pre id="paralegal-content" style="white-space:pre-wrap; font-family:inherit; margin:0; background:white; padding:15px; border-radius:4px;">${escapeHtml(generated.paralegal_summary || "")}</pre>
      <div style="margin-top:12px;">
        <button type="button" onclick="copyContent('paralegal-content')" style="background:#0C1C36; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">📋 Copy Paralegal Summary</button>
        ${generated.id ? `
        <button type="button" onclick="sendParalegal(${generated.id})" style="background:#4CAF50; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-left:8px;">📤 Send to Jue via Telegram</button>
        <span id="send-status" style="margin-left:12px; font-weight:bold;"></span>
        ` : ""}
      </div>
    </div>

    <div style="background:#fdf7f0; padding:20px; margin:20px 0; border-left:4px solid #B79C62; border-radius:4px;">
      <h2 style="margin-top:0;">👤 Client Summary (in client's language)</h2>
      <pre id="client-content" style="white-space:pre-wrap; font-family:inherit; margin:0; background:white; padding:15px; border-radius:4px;">${escapeHtml(generated.client_summary || "")}</pre>
      <div style="margin-top:12px;">
        <button type="button" onclick="copyContent('client-content')" style="background:#B79C62; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">📋 Copy Client Summary</button>
        <span style="margin-left:12px; color:#666; font-size:13px;">Paste into WhatsApp, Telegram, or email to send to client</span>
      </div>
    </div>

    ${saved ? '<p style="color:#4CAF50; font-weight:bold;">✅ Saved to database.</p>' : ""}
    ${sent ? `<p style="color:#4CAF50; font-weight:bold;">📤 Sent to Jue via Telegram (${sent.chunks} message${sent.chunks > 1 ? "s" : ""}).</p>` : ""}
  ` : "";

  const body = `
  <div class="page-header">
    <h1>📝 Hearing Notes</h1>
  </div>
  <p style="margin-bottom:15px; color:#555;">Take notes during the hearing. Zara will clean them up and generate a paralegal summary + client-friendly summary in the client's language.</p>

  <div style="background:#fdf7f0; border:1px dashed #B79C62; padding:15px; border-radius:6px; margin-bottom:20px;">
    <div style="display:flex; align-items:center; gap:15px; flex-wrap:wrap;">
      <div style="flex:1; min-width:200px;">
        <strong>📄 Upload Client's I-589 (optional)</strong><br>
        <span style="font-size:12px; color:#666;">Zara will OCR the PDF and auto-fill client info. Works with scanned or fillable PDFs. Takes ~30–60 seconds.</span>
      </div>
      <div>
        <input type="file" id="i589-upload" accept=".pdf,application/pdf" style="display:none;" onchange="uploadI589(this.files[0])">
        <button type="button" onclick="document.getElementById('i589-upload').click()" style="background:#B79C62; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; font-size:14px;">Choose I-589 PDF</button>
      </div>
    </div>
    <div id="i589-status" style="margin-top:10px; font-size:13px;"></div>
    <div id="i589-extracted" style="margin-top:10px;"></div>
  </div>

  ${errorSection}
  ${previewSection}

  <form method="POST" action="/admin/hearing/notes" id="hearing-form">
    <fieldset>
      <legend>Client & Hearing</legend>
      <div class="row">
        <div>
          <label>Client name *</label>
          <input type="text" name="client_name" required value="${escapeAttr(prev.client_name)}" placeholder="e.g. Chen, Xifen">
        </div>
        <div>
          <label>A-Number</label>
          <input type="text" name="a_number" value="${escapeAttr(prev.a_number)}" placeholder="A123-456-789">
        </div>
      </div>
      <div class="row">
        <div>
          <label>Client email</label>
          <input type="text" name="client_email" value="${escapeAttr(prev.client_email)}" placeholder="client@example.com">
        </div>
        <div>
          <label>Client phone</label>
          <input type="text" name="client_phone" value="${escapeAttr(prev.client_phone)}" placeholder="e.g. 626-555-0123">
        </div>
      </div>
      <div class="row">
        <div>
          <label>Client's language (for client summary)</label>
          <select name="client_language">${langOptions}</select>
        </div>
        <div>
          <label>Hearing type</label>
          <select name="hearing_type">${hearingTypeOptions}</select>
        </div>
      </div>
      <div class="row">
        <div>
          <label>Judge</label>
          <input type="text" name="judge_name" value="${escapeAttr(prev.judge_name)}" placeholder="e.g. Hon. Kevin Riley">
        </div>
        <div>
          <label>DHS Trial Attorney</label>
          <input type="text" name="dhs_attorney" value="${escapeAttr(prev.dhs_attorney)}" placeholder="e.g. AUSA J. Smith">
        </div>
      </div>
      <div class="row">
        <div>
          <label>Hearing date/time</label>
          <input type="datetime-local" name="hearing_date" step="1800" value="${escapeAttr(prev.hearing_date)}">
        </div>
        <div>
          <label>Case type</label>
          <input type="text" name="case_type" value="${escapeAttr(prev.case_type)}" placeholder="e.g. Asylum (I-589), Cancellation of Removal">
        </div>
      </div>
      <div class="row">
        <div>
          <label>Client attendance</label>
          <select name="client_attendance">
            <option value="">-- select --</option>
            <option value="in_person" ${prev.client_attendance === "in_person" ? "selected" : ""}>In person</option>
            <option value="webex" ${prev.client_attendance === "webex" ? "selected" : ""}>WebEx / video</option>
            <option value="phone" ${prev.client_attendance === "phone" ? "selected" : ""}>Telephonic</option>
            <option value="waived" ${prev.client_attendance === "waived" ? "selected" : ""}>Waived</option>
            <option value="absent" ${prev.client_attendance === "absent" ? "selected" : ""}>ABSENT ⚠️</option>
          </select>
        </div>
        <div>
          <label>Attorney appearance</label>
          <select name="attorney_appearance">
            <option value="">-- select --</option>
            <option value="in_person" ${prev.attorney_appearance === "in_person" ? "selected" : ""}>In person</option>
            <option value="webex" ${prev.attorney_appearance === "webex" ? "selected" : ""}>WebEx / video</option>
            <option value="telephonic" ${prev.attorney_appearance === "telephonic" ? "selected" : ""}>Telephonic</option>
            <option value="covering" ${prev.attorney_appearance === "covering" ? "selected" : ""}>Covering counsel</option>
          </select>
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Pleadings Taken</legend>
      <div class="row">
        <div>
          <label>How were pleadings taken?</label>
          <select name="pleadings_method">
            <option value="">-- N/A --</option>
            <option value="oral" ${prev.pleadings_method === "oral" ? "selected" : ""}>Oral (on the record)</option>
            <option value="written" ${prev.pleadings_method === "written" ? "selected" : ""}>Written (submitted)</option>
            <option value="oral_and_written" ${prev.pleadings_method === "oral_and_written" ? "selected" : ""}>Both oral and written</option>
          </select>
        </div>
        <div>
          <label style="display:inline-flex; align-items:center; font-weight:normal; margin-top:24px;">
            <input type="checkbox" name="removability_conceded" value="1" ${prev.removability_conceded ? "checked" : ""}>
            Removability conceded
          </label>
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Applications Requested</legend>
      <div style="display:flex; flex-wrap:wrap;">${applicationCheckboxes}</div>
    </fieldset>

    <fieldset>
      <legend>Disposition (Outcome Of Today's Hearing)</legend>
      <label>Disposition</label>
      <select name="disposition">
        <option value="">-- select --</option>
        <option value="pleadings_taken_continued_individual" ${prev.disposition === "pleadings_taken_continued_individual" ? "selected" : ""}>Pleadings taken, continued to individual/merits</option>
        <option value="continued_status" ${prev.disposition === "continued_status" ? "selected" : ""}>Continued for status</option>
        <option value="continued_master" ${prev.disposition === "continued_master" ? "selected" : ""}>Continued to next master calendar</option>
        <option value="admin_closure" ${prev.disposition === "admin_closure" ? "selected" : ""}>Administrative closure granted</option>
        <option value="termination" ${prev.disposition === "termination" ? "selected" : ""}>Case terminated</option>
        <option value="vd_granted" ${prev.disposition === "vd_granted" ? "selected" : ""}>Voluntary departure granted</option>
        <option value="removal_ordered" ${prev.disposition === "removal_ordered" ? "selected" : ""}>Removal order entered</option>
        <option value="relief_granted" ${prev.disposition === "relief_granted" ? "selected" : ""}>Relief granted (asylum/cancellation/etc.)</option>
        <option value="relief_denied" ${prev.disposition === "relief_denied" ? "selected" : ""}>Relief denied</option>
        <option value="motion_granted" ${prev.disposition === "motion_granted" ? "selected" : ""}>Motion granted</option>
        <option value="motion_denied" ${prev.disposition === "motion_denied" ? "selected" : ""}>Motion denied</option>
        <option value="decision_reserved" ${prev.disposition === "decision_reserved" ? "selected" : ""}>Decision reserved</option>
        <option value="in_absentia_ordered" ${prev.disposition === "in_absentia_ordered" ? "selected" : ""}>In absentia removal order entered ⚠️</option>
        <option value="other" ${prev.disposition === "other" ? "selected" : ""}>Other (specify in notes)</option>
      </select>
      <label>Disposition details</label>
      <textarea name="disposition_notes" rows="2" placeholder="e.g. VD granted, 60 days, $500 bond required. Or: Continued to Sep 15 for individual hearing on asylum.">${escapeHtml(prev.disposition_notes || "")}</textarea>
    </fieldset>

    <fieldset>
      <legend>Next Hearing</legend>
      <div class="row">
        <div>
          <label>Type</label>
          <select name="next_hearing_type">${nextHearingTypeOptions}</select>
        </div>
        <div>
          <label>Date/time</label>
          <input type="datetime-local" name="next_hearing_date" step="1800" value="${escapeAttr(prev.next_hearing_date)}">
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Bond (If Applicable)</legend>
      <div class="hint">Only fill this in for bond hearings or when bond is at issue.</div>
      <div class="row">
        <div>
          <label>Bond outcome</label>
          <select name="bond_outcome">
            <option value="">-- N/A --</option>
            <option value="granted" ${prev.bond_outcome === "granted" ? "selected" : ""}>Granted</option>
            <option value="denied" ${prev.bond_outcome === "denied" ? "selected" : ""}>Denied</option>
            <option value="continued" ${prev.bond_outcome === "continued" ? "selected" : ""}>Continued</option>
            <option value="withdrawn" ${prev.bond_outcome === "withdrawn" ? "selected" : ""}>Withdrawn</option>
          </select>
        </div>
        <div>
          <label>Bond amount (if granted)</label>
          <input type="text" name="bond_amount" value="${escapeAttr(prev.bond_amount)}" placeholder="e.g. 5000">
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Interpreter</legend>
      <label style="display:inline-flex; align-items:center; font-weight:normal;">
        <input type="checkbox" name="interpreter_used" value="1" ${prev.interpreter_used ? "checked" : ""}>
        Interpreter used
      </label>
      <label>Interpreter language (if used)</label>
      <input type="text" name="interpreter_language" value="${escapeAttr(prev.interpreter_language)}" placeholder="e.g. Mandarin, Spanish, Punjabi">
    </fieldset>

    <fieldset>
      <legend>Deadlines Set</legend>
      <div class="hint">Add each deadline the judge set — filing deadlines, biometrics, evidence submission, etc.</div>
      <div id="deadlines-container" class="deadlines-container"></div>
      <button type="button" class="add-deadline" onclick="addDeadlineRow()">+ Add deadline</button>
    </fieldset>

    <fieldset>
      <legend>Free-Form Notes</legend>
      <div class="hint">Rough notes — Zara will clean these up. Include whatever you observed: what DHS attorney said, judge's comments, client demeanor, evidence issues, strategy thoughts, etc.</div>
      <textarea name="raw_notes" id="raw_notes" placeholder="Type or paste rough notes here...">${escapeHtml(prev.raw_notes || "")}</textarea>
    </fieldset>

    <div class="button-row">
      <button type="submit" name="action" value="preview">✨ Generate Summaries (Preview)</button>
      <button type="submit" name="action" value="save">💾 Generate + Save</button>
      <button type="reset" class="secondary">Clear form</button>
    </div>
  </form>

  <p style="margin-top:30px; color:#888; font-size:13px;">
    <a href="/admin/hearing/notes/history" class="back-link">View past hearing notes →</a>
  </p>

  <script>
    // Deadline rows
    let deadlineIndex = 0;
    function addDeadlineRow(date, desc) {
      const container = document.getElementById("deadlines-container");
      const row = document.createElement("div");
      row.className = "deadline-row";
      row.innerHTML =
        '<input type="date" name="deadline_date_' + deadlineIndex + '" value="' + (date || "") + '">' +
        '<input type="text" name="deadline_desc_' + deadlineIndex + '" placeholder="Description (e.g. File I-589)" value="' + (desc || "") + '">' +
        '<button type="button" onclick="this.parentElement.remove()">×</button>';
      container.appendChild(row);
      deadlineIndex++;
    }

    const prevDeadlines = ${JSON.stringify(prev.deadlines || [])};
    if (prevDeadlines.length === 0) {
      addDeadlineRow();
    } else {
      prevDeadlines.forEach(d => addDeadlineRow(d.date, d.description));
    }

    function copyContent(id) {
      const el = document.getElementById(id);
      navigator.clipboard.writeText(el.textContent);
      const status = document.createElement("span");
      status.textContent = " ✅ Copied";
      status.style.color = "#4CAF50";
      status.style.marginLeft = "8px";
      el.parentElement.appendChild(status);
      setTimeout(() => status.remove(), 2000);
    }

    async function sendParalegal(id) {
      const status = document.getElementById("send-status");
      status.textContent = "Sending...";
      status.style.color = "#666";
      try {
        const resp = await fetch("/admin/hearing/notes/" + id + "/send-paralegal", { method: "POST" });
        const data = await resp.json();
        if (data.ok) {
          status.textContent = "✅ Sent to Jue via Telegram";
          status.style.color = "#4CAF50";
        } else {
          status.textContent = "❌ " + (data.error || "Send failed");
          status.style.color = "#c00";
        }
      } catch (e) {
        status.textContent = "❌ " + e.message;
        status.style.color = "#c00";
      }
    }

    // ── I-589 Upload + Auto-Fill ──────────────────────────
    async function uploadI589(file) {
      if (!file) return;
      const statusEl = document.getElementById("i589-status");
      const extractedEl = document.getElementById("i589-extracted");
      extractedEl.innerHTML = "";

      // File size check (32 MB is API limit)
      if (file.size > 32 * 1024 * 1024) {
        statusEl.innerHTML = '<span style="color:#c00;">❌ File too large (max 32 MB). Try a smaller/lower-quality scan.</span>';
        return;
      }

      statusEl.innerHTML = '<span style="color:#666;">⏳ Uploading and OCRing... this can take 30–60 seconds for a full I-589.</span>';

      const formData = new FormData();
      formData.append("i589", file);

      try {
        const resp = await fetch("/admin/hearing/notes/extract-i589", {
          method: "POST",
          body: formData,
        });
        const data = await resp.json();

        if (!resp.ok || !data.ok) {
          statusEl.innerHTML = '<span style="color:#c00;">❌ ' + (data.error || "Extraction failed") + '</span>';
          return;
        }

        // Fill form fields with extracted values
        const filled = [];
        const prefill = data.form_prefill || {};

        function fillIfEmpty(fieldName, value) {
          if (!value) return false;
          const el = document.querySelector('[name="' + fieldName + '"]');
          if (!el) return false;
          // Don't overwrite user-entered values
          if (el.value && el.value.trim()) return false;
          el.value = value;
          el.style.backgroundColor = "#fffde7"; // subtle highlight
          filled.push(fieldName);
          return true;
        }

        fillIfEmpty("client_name", prefill.client_name);
        fillIfEmpty("a_number", prefill.a_number);
        fillIfEmpty("case_type", prefill.case_type);

        // Set language dropdown
        if (prefill.client_language) {
          const langEl = document.querySelector('[name="client_language"]');
          if (langEl && langEl.value === "en") { // only if still default
            langEl.value = prefill.client_language;
            langEl.style.backgroundColor = "#fffde7";
            filled.push("client_language");
          }
        }

        // Auto-check I-589 Asylum in applications
        const asylumCheckbox = Array.from(document.querySelectorAll('input[type="checkbox"]'))
          .find(cb => cb.value && cb.value.startsWith("I-589 Asylum"));
        if (asylumCheckbox && !asylumCheckbox.checked) {
          asylumCheckbox.checked = true;
          filled.push("I-589 Asylum (application)");
        }

        // Show extracted info summary
        const extra = prefill._extra || {};
        const extraLines = [];
        if (extra.date_of_birth) extraLines.push("DOB: " + extra.date_of_birth);
        if (extra.country_of_citizenship) extraLines.push("Country: " + extra.country_of_citizenship);
        if (extra.us_address) extraLines.push("US Address: " + extra.us_address);
        if (extra.asylum_basis && extra.asylum_basis.length) extraLines.push("Asylum basis: " + extra.asylum_basis.join(", "));
        if (extra.date_of_entry) extraLines.push("Entered US: " + extra.date_of_entry + (extra.manner_of_entry ? " (" + extra.manner_of_entry + ")" : ""));
        if (extra.spouse_name) extraLines.push("Spouse: " + extra.spouse_name);
        if (extra.children_count) extraLines.push("Children: " + extra.children_count);

        if (filled.length === 0) {
          statusEl.innerHTML = '<span style="color:#ff9800;">⚠️ Extracted but no new fields filled (form may already have values). See below for extracted data.</span>';
        } else {
          statusEl.innerHTML = '<span style="color:#4CAF50;">✅ Extracted and filled: ' + filled.join(", ") + '. Please verify highlighted fields.</span>';
        }

        if (extraLines.length) {
          extractedEl.innerHTML = '<div style="background:white; padding:10px; border-radius:4px; margin-top:8px; font-size:13px; color:#333; border:1px solid #eee;">' +
            '<strong>Additional data from I-589 (reference only):</strong><br>' +
            extraLines.map(l => "• " + l).join("<br>") +
            '</div>';
        }

      } catch (e) {
        statusEl.innerHTML = '<span style="color:#c00;">❌ Upload error: ' + e.message + '</span>';
      }
    }
  </script>`;

  return renderAdminChrome({ title: "Hearing Notes", body, activeItem: "notes" });
}

function renderHistoryPage(notes) {
  const rows = notes.length ? notes.map(n => `
    <tr>
      <td>#${n.id}</td>
      <td>${escapeHtml(n.client_name)}</td>
      <td>${escapeHtml(n.a_number || "")}</td>
      <td>${n.hearing_date ? new Date(n.hearing_date).toLocaleDateString() : "-"}</td>
      <td>${n.next_hearing_date ? new Date(n.next_hearing_date).toLocaleDateString() : "-"}</td>
      <td>${escapeHtml(n.next_hearing_type || "-")}</td>
      <td>${n.client_language}</td>
      <td>${n.sent_to_paralegal_at ? "✅" : "—"}</td>
      <td>${new Date(n.created_at).toLocaleDateString()}</td>
      <td><a href="/admin/hearing/notes/${n.id}" style="color:#B79C62;">view</a></td>
    </tr>`).join("") : `<tr><td colspan="10" style="text-align:center; color:#888;">No hearing notes yet.</td></tr>`;

  const body = `
    <div class="page-header">
      <h1>📚 Hearing Notes History</h1>
      <a href="/admin/hearing/notes" class="back-link">← Back to note-taking</a>
    </div>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Client</th><th>A#</th><th>Hearing</th>
          <th>Next</th><th>Next Type</th><th>Lang</th>
          <th>Sent Jue</th><th>Created</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  return renderAdminChrome({ title: "Hearing History", body, activeItem: "history" });
}

function renderDetailPage(note) {
  if (!note) {
    const body = `<div class="page-header"><h1>Not found</h1></div><p><a href="/admin/hearing/notes/history" class="back-link">← Back to history</a></p>`;
    return renderAdminChrome({ title: "Not Found", body });
  }

  const body = `
    <div class="page-header">
      <h1>Hearing #${note.id} — ${escapeHtml(note.client_name)}</h1>
      <div>
        <a href="/admin/hearing/notes/history" class="back-link">← History</a>
        &nbsp; · &nbsp;
        <a href="/admin/hearing/notes" class="back-link">New note</a>
      </div>
    </div>

    <div style="background: white; padding: 20px; border-radius: 4px; margin: 15px 0; border-left: 4px solid #B79C62;">
      <div style="margin:4px 0;"><strong>Client:</strong> ${escapeHtml(note.client_name)}</div>
      <div style="margin:4px 0;"><strong>A-Number:</strong> ${escapeHtml(note.a_number || "-")}</div>
      <div style="margin:4px 0;"><strong>Client contact:</strong> ${escapeHtml([note.client_email, note.client_phone].filter(Boolean).join(" / ") || "-")}</div>
      <div style="margin:4px 0;"><strong>Hearing:</strong> ${note.hearing_date ? new Date(note.hearing_date).toLocaleString() : "-"} (${escapeHtml(note.hearing_type || "master")})</div>
      <div style="margin:4px 0;"><strong>Judge:</strong> ${escapeHtml(note.judge_name || "-")}</div>
      <div style="margin:4px 0;"><strong>DHS Trial Attorney:</strong> ${escapeHtml(note.dhs_attorney || "-")}</div>
      <div style="margin:4px 0;"><strong>Client attendance:</strong> ${escapeHtml(note.client_attendance || "-")}</div>
      <div style="margin:4px 0;"><strong>Attorney appearance:</strong> ${escapeHtml(note.attorney_appearance || "-")}</div>
      <div style="margin:4px 0;"><strong>Disposition:</strong> ${escapeHtml(note.disposition || "-")}${note.disposition_notes ? " — " + escapeHtml(note.disposition_notes) : ""}</div>
      ${note.bond_outcome ? `<div style="margin:4px 0;"><strong>Bond:</strong> ${escapeHtml(note.bond_outcome)}${note.bond_amount ? ` — $${Number(note.bond_amount).toLocaleString()}` : ""}</div>` : ""}
      <div style="margin:4px 0;"><strong>Next hearing:</strong> ${note.next_hearing_date ? new Date(note.next_hearing_date).toLocaleString() : "not scheduled"} (${escapeHtml(note.next_hearing_type || "-")})</div>
      <div style="margin:4px 0;"><strong>Client language:</strong> ${note.client_language}</div>
      <div style="margin:4px 0;"><strong>Sent to Jue:</strong> ${note.sent_to_paralegal_at ? new Date(note.sent_to_paralegal_at).toLocaleString() : "not sent"}</div>
      <div style="margin:4px 0;"><strong>Created:</strong> ${new Date(note.created_at).toLocaleString()}</div>
    </div>

    <h2 style="color:#B79C62; margin-top:30px;">Paralegal Summary</h2>
    <button type="button" onclick="copyEl('paralegal-detail')" style="background:#0C1C36; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-bottom:8px;">📋 Copy</button>
    <pre id="paralegal-detail" style="background:white; padding:15px; border:1px solid #ddd; border-radius:4px; white-space:pre-wrap; font-family:inherit;">${escapeHtml(note.paralegal_summary || "(none)")}</pre>

    <h2 style="color:#B79C62; margin-top:30px;">Client Summary (${note.client_language})</h2>
    <button type="button" onclick="copyEl('client-detail')" style="background:#B79C62; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-bottom:8px;">📋 Copy</button>
    <pre id="client-detail" style="background:white; padding:15px; border:1px solid #ddd; border-radius:4px; white-space:pre-wrap; font-family:inherit;">${escapeHtml(note.client_summary || "(none)")}</pre>

    <h2 style="color:#B79C62; margin-top:30px;">Original Raw Notes</h2>
    <pre style="background:white; padding:15px; border:1px solid #ddd; border-radius:4px; white-space:pre-wrap; font-family:inherit;">${escapeHtml(note.raw_notes || "(none)")}</pre>

    <script>
      function copyEl(id) {
        navigator.clipboard.writeText(document.getElementById(id).textContent);
        alert("Copied!");
      }
    </script>`;

  return renderAdminChrome({ title: `Hearing #${note.id}`, body });
}

// ── Form Parsing ─────────────────────────────────────────

function parseFormSubmission(body) {
  // Applications - collect all checked
  const applications = [];
  for (let i = 0; i < APPLICATION_OPTIONS.length; i++) {
    if (body[`application_${i}`]) applications.push(body[`application_${i}`]);
  }

  // Deadlines - collect indexed pairs
  const deadlines = [];
  const keys = Object.keys(body || {});
  const deadlineIndices = new Set();
  for (const k of keys) {
    const m = k.match(/^deadline_(?:date|desc)_(\d+)$/);
    if (m) deadlineIndices.add(parseInt(m[1]));
  }
  const sortedIndices = Array.from(deadlineIndices).sort((a, b) => a - b);
  for (const i of sortedIndices) {
    const date = body[`deadline_date_${i}`] || "";
    const desc = body[`deadline_desc_${i}`] || "";
    if (date || desc) deadlines.push({ date, description: desc });
  }

  return {
    client_name: (body.client_name || "").trim(),
    a_number: (body.a_number || "").trim(),
    client_language: body.client_language || "en",
    client_email: (body.client_email || "").trim() || null,
    client_phone: (body.client_phone || "").trim() || null,
    judge_name: (body.judge_name || "").trim(),
    hearing_date: body.hearing_date || null,
    hearing_type: body.hearing_type || "master",
    case_type: (body.case_type || "").trim(),
    dhs_attorney: (body.dhs_attorney || "").trim() || null,
    client_attendance: body.client_attendance || null,
    attorney_appearance: body.attorney_appearance || null,
    pleadings_admitted: (body.pleadings_admitted || "").trim(),
    pleadings_denied: (body.pleadings_denied || "").trim(),
    pleadings_contested: (body.pleadings_contested || "").trim(),
    pleadings_method: body.pleadings_method || null,
    removability_conceded: !!body.removability_conceded,
    applications,
    disposition: body.disposition || null,
    disposition_notes: (body.disposition_notes || "").trim() || null,
    bond_outcome: body.bond_outcome || null,
    bond_amount: body.bond_amount ? parseInt(body.bond_amount.toString().replace(/[,$\s]/g, ""), 10) || null : null,
    next_hearing_date: body.next_hearing_date || null,
    next_hearing_type: body.next_hearing_type || null,
    interpreter_used: !!body.interpreter_used,
    interpreter_language: (body.interpreter_language || "").trim(),
    deadlines,
    raw_notes: (body.raw_notes || "").trim(),
  };
}

// ── HTML Escape ──────────────────────────────────────────

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Exports ──────────────────────────────────────────────

module.exports = {
  initHearingNotesTables,
  saveNote,
  listNotes,
  getNote,
  sendToParalegal,
  generateParalegalSummary,
  generateClientSummary,
  extractI589FieldsFromPdf,
  renderNoteForm,
  renderHistoryPage,
  renderDetailPage,
  parseFormSubmission,
  APPLICATION_OPTIONS,
};
