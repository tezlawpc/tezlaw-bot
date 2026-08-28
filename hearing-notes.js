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
//    - Team group: Telegram group chat via HEARING_NOTES_TELEGRAM_GROUP_ID
//      (add @TEZJJBot to the group, use /chatid in the group to get the ID)
//    - Client: copy-to-clipboard (paste into WhatsApp, email, etc.)
//    - Both: copy buttons available always
//
//  Backward-compat: still honors RECIPIENT_JUE_TELEGRAM_ID as fallback.
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
      client_address        TEXT,
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
      asylum_fee_needed     BOOLEAN,
      biometrics_needed     BOOLEAN,
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
    ["asylum_fee_needed", "BOOLEAN"],
    ["biometrics_needed", "BOOLEAN"],
    ["client_address", "TEXT"],
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

// ── Generic Document Extraction (OCR via Claude) ─────────
//
// Accepts a file buffer + mime type. Handles PDFs and images
// (JPG/PNG/WebP). Claude identifies what kind of document it is
// and extracts any client/case fields it can find, PLUS narrative
// content usable in the free-form notes section.

async function extractDocumentFields(fileBuffer, mimeType, originalName = "") {
  // Normalize HEIC (iPhone photos) — treat as jpeg for Anthropic vision API
  let normalizedMime = mimeType;
  if (mimeType === "image/heic" || mimeType === "image/heif" || /\.(heic|heif)$/i.test(originalName)) {
    normalizedMime = "image/jpeg";  // Anthropic accepts jpeg/png/gif/webp
  }
  const base64 = fileBuffer.toString("base64");

  const isPdf = normalizedMime && normalizedMime.includes("pdf");
  const isImage = normalizedMime && normalizedMime.startsWith("image/");
  if (!isPdf && !isImage) {
    throw new Error(`Unsupported file type: ${mimeType}. Upload PDF, JPG, PNG, WebP, or HEIC.`);
  }

  const prompt = `You are extracting client/case information from a document related to an immigration case. The document could be any of these types:
- USCIS Form I-589 (Application for Asylum)
- Notice to Appear (NTA / Form I-862)
- EOIR hearing notice / court notice
- USCIS receipt notice or approval notice
- Client meeting notes (handwritten or typed)
- **Handwritten hearing notes** by covering counsel or another attorney at a hearing they attended on our behalf
- Client intake form
- Court orders / minute orders
- Any other immigration-related document

First identify what type of document this is. If it's handwritten attorney notes from a hearing, extract EVERYTHING you can read about what happened: judge's decisions, deadlines, next hearing date, pleadings, applications discussed, DHS positions, motions ruled on, testimony highlights, and any specific dates/deadlines.

Then extract as many of the following fields as possible. Use null for fields not present or illegible. Do NOT invent data.

Return ONLY valid JSON with this structure (no preamble, no code fences):

{
  "document_type": "Best label for what this document is (e.g. 'I-589', 'NTA', 'EOIR Hearing Notice', 'Attorney Hearing Notes')",
  "client_name": "Full legal name in 'Last, First Middle' format if possible",
  "a_number": "A-Number with format A123-456-789 if visible",
  "date_of_birth": "YYYY-MM-DD",
  "country_of_citizenship": "Country name",
  "country_of_birth": "Country name",
  "native_language": "Language name (e.g. 'Mandarin', 'Spanish', 'Punjabi')",
  "us_address": "Full US mailing address if listed",
  "client_phone": "Phone number if listed",
  "client_email": "Email address if listed",
  "judge_name": "Immigration Judge name if mentioned",
  "dhs_attorney": "DHS/ICE trial attorney name if mentioned",
  "hearing_date": "YYYY-MM-DD of hearing referenced in this document (if attorney notes describe hearing that happened, use that date; if it's a notice for future hearing, use that)",
  "hearing_time": "HH:MM in 24h format",
  "hearing_type": "master/individual/status/bond/other",
  "case_type": "Type of case (e.g. 'Asylum (I-589)', 'Cancellation of Removal (non-LPR)')",
  "next_hearing_date": "YYYY-MM-DD of the NEXT hearing if mentioned (different from hearing_date above)",
  "next_hearing_time": "HH:MM 24h",
  "next_hearing_type": "master/individual/status/bond/other",
  "charges": "Charges of removability from NTA if present (e.g. 'INA 237(a)(1)(B)')",
  "allegations": "Numbered allegations from NTA if present (as string)",
  "applications_mentioned": ["Array of relief applications mentioned"],
  "asylum_basis": ["Array of persecution grounds from I-589: race/religion/nationality/political_opinion/particular_social_group/torture"],
  "date_of_entry": "YYYY-MM-DD of last US entry if mentioned",
  "manner_of_entry": "How client entered US (e.g. 'B1/B2 visa', 'EWI', 'visa waiver')",
  "spouse_name": "Spouse name if listed",
  "children_count": 0,
  "narrative_notes": "Any narrative content useful for hearing notes: what the document actually says, procedural history, meeting summary, judge's comments, DHS positions, deadlines mentioned, testimony highlights from covering counsel's handwritten notes, etc. Keep to 2-4 paragraphs. Preserve specific dates and numbers exactly. If handwritten, transcribe as much as legible."
}

Rules:
- Return ONLY the JSON object. No preamble, no explanation, no code fences.
- Use null (not empty string) for any field you cannot read confidently.
- For dates, YYYY-MM-DD format. If only month/year visible, use YYYY-MM-01. If unsure, null.
- For handwritten sections that are illegible, use null rather than guessing. Better to leave a field null than guess wrong.
- If this is meeting notes or handwritten hearing notes, extract as much as possible AND put the meaningful content into narrative_notes.`;

  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image",    source: { type: "base64", media_type: normalizedMime,    data: base64 } };

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      messages: [
        {
          role: "user",
          content: [contentBlock, { type: "text", text: prompt }],
        },
      ],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 120000, // 2 min — OCR of large scanned PDF takes time
    }
  );

  const text = resp.data.content?.[0]?.text?.trim() || "{}";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let extracted;
  try {
    extracted = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Claude returned unparseable JSON: ${cleaned.substring(0, 300)}`);
  }

  const langCode = mapLanguageNameToCode(extracted.native_language);

  // Map to form fields (only fields that map directly to the hearing notes form)
  const form_prefill = {
    document_type: extracted.document_type,
    client_name: extracted.client_name || null,
    a_number: extracted.a_number || null,
    client_language: langCode,
    client_phone: extracted.client_phone || null,
    client_email: extracted.client_email || null,
    client_address: extracted.us_address || null,
    judge_name: extracted.judge_name || null,
    dhs_attorney: extracted.dhs_attorney || null,
    case_type: extracted.case_type || null,
    hearing_type: extracted.hearing_type || null,
    hearing_datetime: mergeDateTime(extracted.hearing_date, extracted.hearing_time),
    next_hearing_date: mergeDateTime(extracted.next_hearing_date, extracted.next_hearing_time),
    next_hearing_type: extracted.next_hearing_type || null,
    narrative_notes: extracted.narrative_notes || null,
    // Reference-only extras shown to user, not filled into form:
    _extra: {
      date_of_birth: extracted.date_of_birth,
      country_of_citizenship: extracted.country_of_citizenship,
      country_of_birth: extracted.country_of_birth,
      native_language: extracted.native_language,
      us_address: extracted.us_address,
      charges: extracted.charges,
      allegations: extracted.allegations,
      applications_mentioned: extracted.applications_mentioned,
      asylum_basis: extracted.asylum_basis,
      date_of_entry: extracted.date_of_entry,
      manner_of_entry: extracted.manner_of_entry,
      spouse_name: extracted.spouse_name,
      children_count: extracted.children_count,
    },
  };

  return { raw: extracted, form_prefill };
}

function mergeDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const time = timeStr && /^\d{1,2}:\d{2}/.test(timeStr) ? timeStr : "09:00";
  return `${dateStr}T${time.length === 4 ? "0" + time : time}`;
}

// Backward compatibility alias
async function extractI589FieldsFromPdf(pdfBuffer) {
  return extractDocumentFields(pdfBuffer, "application/pdf", "i589.pdf");
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

  const prompt = `You are cleaning up immigration court hearing notes for a paralegal at Tez Law Firm.

The attorney of record took these notes during the hearing. Your job is to produce a clean, professional summary the team (paralegals, associates) can use to update the case file and take follow-up action.

Rules:
- Complete and detailed — include ALL information provided
- Structured with clear headings
- Professional attorney-to-paralegal tone (efficient, factual)
- Preserve ALL specific dates, deadlines, allegation numbers, and case details exactly
- Do NOT invent or embellish — only use what's in the notes
- Do NOT add "Please note" or "Kindly" language — direct and efficient
- Use bullet points where appropriate for scannability
- End with an "Action Items" section listing what the team needs to do

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

The client attended their immigration court hearing today with their attorney from Tez Law Firm. Your job is to write a warm but professional summary explaining what happened and what they need to do next.

Rules:
- Write ENTIRELY in ${languageName}
- Plain language — no legalese, no Latin phrases
- Warm and reassuring tone but professional
- Focus on: what happened, what deadlines the client needs to remember, what they need to do next
- Include specific dates and deadlines with clear context
- Do NOT invent information — only what's in the notes
- End with firm contact info: "If you have questions, please contact us at 626-678-8677 or info@tezlawfirm.com" (translate this line too)
- If interpreter was used, mention this positively
- Address the client directly ("You" / "您" / "Usted" / "आप" / "ਤੁਸੀਂ")
- Sign off with "Sincerely, TEZ LAW FIRM" (translate the "Sincerely" part but keep TEZ LAW FIRM as the firm name; for Chinese use "TEZ律师事务所")
- Do NOT use any personal attorney name (no "JJ Zhang", no "章律师", no "Attorney [Name]")

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
    data.asylum_fee_needed ? "ASYLUM FEE: Required (client must pay filing fee)" : "",
    data.biometrics_needed ? "BIOMETRICS: Required (client must attend biometrics appointment when scheduled by USCIS)" : "",
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

// Look up an existing hearing note that matches on (client + hearing time + type).
// Used to prevent creating a duplicate when the same hearing gets re-submitted
// (page refresh, back button, second click, etc.).
//
// Match criteria (returns the first match):
//   1. Same client_name (case-insensitive, trimmed) AND
//   2. Same hearing_date within a 60-minute window OR both null AND
//   3. Same hearing_type (or both null)
//
// Notes:
//   - A_number is a strong secondary key. If two rows have the same A#,
//     they're the same client.
//   - The 60-minute window absorbs typos (10:00 AM vs 10:30 AM) which are
//     almost always the same hearing being re-entered.
async function findExistingNote(data) {
  await initHearingNotesTables();
  const name = String(data.client_name || "").trim();
  if (!name) return null;

  // Prefer A-number match if provided (most reliable)
  if (data.a_number) {
    const byA = await db.query(
      `SELECT id, client_name, hearing_date, hearing_type, sent_to_paralegal_at
       FROM hearing_notes
       WHERE a_number = $1
         AND ($2::timestamptz IS NULL OR ABS(EXTRACT(EPOCH FROM (hearing_date - $2::timestamptz))) < 3600)
       ORDER BY created_at DESC LIMIT 1`,
      [data.a_number, data.hearing_date || null]
    );
    if (byA.rows[0]) return byA.rows[0];
  }

  // Fall back to case-insensitive name match + time window
  const byName = await db.query(
    `SELECT id, client_name, hearing_date, hearing_type, sent_to_paralegal_at
     FROM hearing_notes
     WHERE LOWER(TRIM(client_name)) = LOWER($1)
       AND (
         ($2::timestamptz IS NULL AND hearing_date IS NULL)
         OR ABS(EXTRACT(EPOCH FROM (hearing_date - $2::timestamptz))) < 3600
       )
       AND (COALESCE(hearing_type, '') = COALESCE($3, ''))
     ORDER BY created_at DESC LIMIT 1`,
    [name, data.hearing_date || null, data.hearing_type || null]
  );
  return byName.rows[0] || null;
}

async function saveNote(data, { generateSummaries = true, allowDuplicate = false } = {}) {
  await initHearingNotesTables();

  // Duplicate detection — if a matching hearing already exists, update it
  // instead of creating a new row. This prevents the "N duplicates for the
  // same hearing" mess when a form gets re-submitted (back button, page
  // reload, second click, etc.).
  if (!allowDuplicate) {
    const existing = await findExistingNote(data);
    if (existing) {
      console.log(`[hearing-notes] Duplicate detected for ${data.client_name} — updating #${existing.id} instead of creating new`);
      await updateNote(existing.id, data);
      let paralegal_summary = null, client_summary = null;
      if (generateSummaries) {
        const summaries = await generateAndSaveSummariesForMaster(existing.id);
        paralegal_summary = summaries?.paralegal_summary || null;
        client_summary = summaries?.client_summary || null;
      }
      return { id: existing.id, paralegal_summary, client_summary, was_duplicate: true };
    }
  }

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
       applications, asylum_fee_needed, biometrics_needed,
       disposition, disposition_notes, bond_outcome, bond_amount,
       next_hearing_date, next_hearing_type, deadlines,
       raw_notes, paralegal_summary, client_summary, client_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15, $16, $17,
             $18::jsonb, $19, $20,
             $21, $22, $23, $24,
             $25, $26, $27::jsonb,
             $28, $29, $30, $31)
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
      !!data.asylum_fee_needed, !!data.biometrics_needed,
      data.disposition || null, data.disposition_notes || null,
      data.bond_outcome || null, data.bond_amount || null,
      data.next_hearing_date || null, data.next_hearing_type || null,
      JSON.stringify(data.deadlines || []),
      data.raw_notes || null, paralegal_summary, client_summary,
      data.client_address || null,
    ]
  );
  const newId = r.rows[0].id;
  // Log initial revision
  await saveRevision(newId, "created", data, null);
  return { id: newId, paralegal_summary, client_summary, was_duplicate: false };
}

// ── Revision History ─────────────────────────────────────
// Every save/update to a hearing note appends to hearing_note_revisions.
// Instead of creating a new hearing_notes row, we track what changed within
// the single canonical row.

async function initRevisionTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS hearing_note_revisions (
      id             SERIAL PRIMARY KEY,
      note_id        INTEGER NOT NULL REFERENCES hearing_notes(id) ON DELETE CASCADE,
      revision_type  TEXT NOT NULL,     -- 'created', 'updated', 'sent_to_paralegal', 'summaries_regenerated'
      changed_fields TEXT[],            -- list of field names that changed
      snapshot       JSONB,             -- full snapshot at this revision
      diff           JSONB,             -- {field: {old, new}}
      user_id        INTEGER,
      username       TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_hnr_note ON hearing_note_revisions (note_id, created_at DESC)`);
}

// Save a revision. Both `newData` and `oldData` are the plain form objects.
async function saveRevision(noteId, revisionType, newData, oldData = null, { user = null } = {}) {
  try {
    await initRevisionTable();
    const changedFields = [];
    const diff = {};
    if (oldData) {
      for (const key of Object.keys(newData || {})) {
        const oldV = oldData[key];
        const newV = newData[key];
        if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
          changedFields.push(key);
          diff[key] = { old: oldV, new: newV };
        }
      }
    }
    await db.query(
      `INSERT INTO hearing_note_revisions
         (note_id, revision_type, changed_fields, snapshot, diff, user_id, username)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
      [
        noteId, revisionType,
        changedFields.length ? changedFields : null,
        newData ? JSON.stringify(newData) : null,
        Object.keys(diff).length ? JSON.stringify(diff) : null,
        user?.uid || null,
        user?.u || null,
      ]
    );
  } catch (e) {
    console.warn("[hearing-notes] saveRevision failed:", e.message);
  }
}

async function getRevisions(noteId) {
  await initRevisionTable();
  const r = await db.query(
    `SELECT id, revision_type, changed_fields, diff, user_id, username, created_at
     FROM hearing_note_revisions
     WHERE note_id = $1
     ORDER BY created_at DESC`,
    [noteId]
  );
  return r.rows;
}

// Update an existing hearing note (does not regenerate summaries by default —
// call generateAndSaveSummariesForMaster separately if you want fresh ones).
async function updateNote(id, data, { user = null, skipRevision = false } = {}) {
  await initHearingNotesTables();

  // Snapshot the OLD state so we can compute a diff for the revision log.
  let oldNote = null;
  if (!skipRevision) {
    try { oldNote = await getNote(id); } catch (e) { /* silent */ }
  }

  const r = await db.query(
    `UPDATE hearing_notes SET
       client_name=$1, a_number=$2, client_language=$3, client_email=$4, client_phone=$5,
       judge_name=$6, hearing_date=$7, hearing_type=$8, case_type=$9,
       dhs_attorney=$10, client_attendance=$11, attorney_appearance=$12,
       pleadings_admitted=$13, pleadings_denied=$14, pleadings_contested=$15,
       pleadings_method=$16, removability_conceded=$17,
       applications=$18::jsonb, asylum_fee_needed=$19, biometrics_needed=$20,
       disposition=$21, disposition_notes=$22, bond_outcome=$23, bond_amount=$24,
       next_hearing_date=$25, next_hearing_type=$26, deadlines=$27::jsonb,
       raw_notes=$28, client_address=$30
     WHERE id=$29 RETURNING id`,
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
      !!data.asylum_fee_needed, !!data.biometrics_needed,
      data.disposition || null, data.disposition_notes || null,
      data.bond_outcome || null, data.bond_amount || null,
      data.next_hearing_date || null, data.next_hearing_type || null,
      JSON.stringify(data.deadlines || []),
      data.raw_notes || null,
      id,
      data.client_address || null,
    ]
  );
  if (!r.rows[0]) throw new Error(`Note ${id} not found`);

  if (!skipRevision) {
    await saveRevision(id, "updated", data, oldNote, { user });
  }
  return { id: r.rows[0].id, updated: true };
}

// Regenerate paralegal + client summaries for a saved master hearing.
async function generateAndSaveSummariesForMaster(id) {
  const note = await getNote(id);
  if (!note) throw new Error(`Note ${id} not found`);
  const [p, c] = await Promise.all([
    generateParalegalSummary(note),
    generateClientSummary(note),
  ]);
  await db.query(
    `UPDATE hearing_notes SET paralegal_summary=$1, client_summary=$2 WHERE id=$3`,
    [p, c, id]
  );
  return { paralegal_summary: p, client_summary: c };
}

async function listNotes(limit = 50) {
  await initHearingNotesTables();
  const r = await db.query(
    `SELECT id, client_name, a_number, hearing_date, hearing_type,
       next_hearing_date, next_hearing_type,
       client_language, sent_to_paralegal_at, sent_to_client_at, created_at
     FROM hearing_notes
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  const rows = r.rows;

  // Compute sequence number for each row: which # is this among the same
  // client's same-type hearings (e.g. "master #2", "bond #3"). Identity:
  // A-Number if present, else lowercased client name.
  const groups = {};
  for (const row of rows) {
    const key = ((row.a_number || row.client_name || "") + "|" + (row.hearing_type || "master"))
                  .toLowerCase().replace(/[-\s]/g, "");
    (groups[key] = groups[key] || []).push(row);
  }
  for (const key of Object.keys(groups)) {
    // Sort by hearing_date ASC (or created_at as fallback), assign 1,2,3...
    const list = groups[key];
    list.sort((a, b) => {
      const ad = a.hearing_date ? new Date(a.hearing_date).getTime() : new Date(a.created_at).getTime();
      const bd = b.hearing_date ? new Date(b.hearing_date).getTime() : new Date(b.created_at).getTime();
      return ad - bd;
    });
    for (let i = 0; i < list.length; i++) {
      list[i].sequence = i + 1;
      list[i].sequence_total = list.length;
    }
  }
  return rows;
}

// Get sequence info for a specific hearing note (used on detail page)
async function getHearingSequenceInfo(note) {
  if (!note) return null;
  const identity = (note.a_number || note.client_name || "").toLowerCase().replace(/[-\s]/g, "");
  const type = note.hearing_type || "master";

  // Find all hearings of the same type for the same client identity
  const r = await db.query(
    `SELECT id, hearing_date, created_at, a_number, client_name FROM hearing_notes
     WHERE hearing_type = $1
     ORDER BY COALESCE(hearing_date, created_at) ASC`,
    [type]
  );
  const matches = r.rows.filter(row => {
    const rowIdentity = (row.a_number || row.client_name || "").toLowerCase().replace(/[-\s]/g, "");
    return rowIdentity === identity;
  });
  const idx = matches.findIndex(row => row.id === note.id);
  return {
    sequence: idx >= 0 ? idx + 1 : null,
    total: matches.length,
    all_ids: matches.map(m => m.id),
  };
}

async function getNote(id) {
  await initHearingNotesTables();
  const r = await db.query(`SELECT * FROM hearing_notes WHERE id = $1`, [id]);
  return r.rows[0];
}

async function deleteNote(id) {
  await initHearingNotesTables();
  const r = await db.query(
    `DELETE FROM hearing_notes WHERE id = $1 RETURNING id, client_name`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Note ${id} not found`);
  return { id: r.rows[0].id, client_name: r.rows[0].client_name };
}

// Find the most recent hearing note matching a client (by A# preferred, name fallback)
// Used to pre-fill client/court info when creating an individual hearing note.
async function getMostRecentForClient({ clientName, aNumber }) {
  await initHearingNotesTables();
  const key = aNumber ? String(aNumber).toLowerCase().replace(/[-\s]/g, "") : null;
  const nameKey = clientName ? String(clientName).toLowerCase().trim() : null;

  // Try A-Number match first
  if (key) {
    const r = await db.query(
      `SELECT * FROM hearing_notes
       WHERE LOWER(REGEXP_REPLACE(COALESCE(a_number, ''), '[- ]', '', 'g')) = $1
       ORDER BY COALESCE(hearing_date, created_at) DESC LIMIT 1`,
      [key]
    );
    if (r.rows[0]) return r.rows[0];
  }
  // Fallback: client name match
  if (nameKey) {
    const r = await db.query(
      `SELECT * FROM hearing_notes
       WHERE LOWER(TRIM(client_name)) = $1
       ORDER BY COALESCE(hearing_date, created_at) DESC LIMIT 1`,
      [nameKey]
    );
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

// ── Telegram Send ────────────────────────────────────────

async function sendToParalegal(id) {
  const note = await getNote(id);
  if (!note) throw new Error(`Note ${id} not found`);
  if (!note.paralegal_summary) throw new Error("No paralegal summary generated");

  // Prefer group chat, fall back to individual recipient for backward compat
  const rawRecipient =
    process.env.HEARING_NOTES_TELEGRAM_GROUP_ID ||
    process.env.HEARING_NOTES_TELEGRAM_ID ||
    process.env.RECIPIENT_JUE_TELEGRAM_ID ||
    process.env.RECIPIENT_JUE_TELEGRAM;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!rawRecipient || !telegramToken) {
    throw new Error("Telegram not configured. Set HEARING_NOTES_TELEGRAM_GROUP_ID env var to the group's chat ID (send /chatid in the group to get it — group IDs start with -100).");
  }

  // Resolve to a chat_id. Numeric (positive or negative) is used as-is.
  // Group chat IDs are negative (e.g. -1001234567890).
  let chatId = null;
  const trimmed = String(rawRecipient).trim();
  if (/^-?\d+$/.test(trimmed)) {
    chatId = trimmed;
  } else {
    // Legacy path: try @username resolution
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
      throw new Error(`Could not resolve Telegram target ${withAt}: ${detail}. For groups, send /chatid in the group to @TEZJJBot and use the returned numeric ID.`);
    }
    if (!chatId) {
      throw new Error(`Could not resolve Telegram target ${withAt}.`);
    }
  }

  const header = `📋 *Hearing Notes — ${note.client_name}*\nA#: ${note.a_number || "(none)"}\nDate: ${note.hearing_date ? new Date(note.hearing_date).toLocaleDateString() : "(not set)"}\n\n`;
  const message = header + note.paralegal_summary;

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
      const hint = detail.includes("chat not found")
        ? " (Make sure @TEZJJBot is a member of the group.)"
        : detail.includes("bot was blocked")
        ? " (The user has blocked the bot.)"
        : "";
      throw new Error(`Telegram send failed: ${detail}.${hint}`);
    }
  }

  await db.query(
    `UPDATE hearing_notes SET sent_to_paralegal_at = NOW() WHERE id = $1`,
    [id]
  );

  // Record the send action as a revision (not a duplicate note)
  await saveRevision(id, "sent_to_paralegal", null, null);

  return { sent: true, chunks: chunks.length, resolved_chat_id: chatId };
}

// ── Admin Panel Chrome (Sidebar + Layout) ────────────────
// Matches admin.js styling so hearing notes pages feel integrated.
// activeItem: which nav item to highlight — "notes" | "history" | null

function renderAdminChrome({ title, body, activeItem = null }) {
  const notesActive = activeItem === "notes" ? "active" : "";
  const historyActive = activeItem === "history" ? "active" : "";
  const indivActive = activeItem === "individual" ? "active" : "";
  const indivHistActive = activeItem === "individual-history" ? "active" : "";
  const clientsActive = activeItem === "clients" ? "active" : "";
  const dropboxActive = activeItem === "dropbox" ? "active" : "";

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

  <!-- Primary work items — visible to everyone with role -->
  <a href="/admin/dashboard" class="nav-item" data-perm="hearings.read" style="background:rgba(183,156,98,.08); border-left-color:rgba(183,156,98,.4); border-bottom:1px solid rgba(183,156,98,.2);">
    <span class="icon">📊</span><span>→ Dashboard</span>
  </a>
  <a href="/admin/clients" class="nav-item ${clientsActive}" data-perm="clients.read" style="background:rgba(183,156,98,.08); ${clientsActive ? "" : "border-left-color:rgba(183,156,98,.4);"} border-bottom:1px solid rgba(183,156,98,.2);">
    <span class="icon">👥</span><span>→ Client Profiles</span>
  </a>
  <a href="/admin/hearing/notes" class="nav-item ${notesActive}" data-perm="hearings.read" style="background:rgba(183,156,98,.08); ${notesActive ? "" : "border-left-color:rgba(183,156,98,.4);"} border-bottom:1px solid rgba(183,156,98,.2);">
    <span class="icon">📝</span><span>→ Master Hearing Notes</span>
  </a>
  <a href="/admin/hearing/individual" class="nav-item ${indivActive}" data-perm="hearings.read" style="background:rgba(183,156,98,.08); ${indivActive ? "" : "border-left-color:rgba(183,156,98,.4);"} border-bottom:1px solid rgba(183,156,98,.2);">
    <span class="icon">⚖️</span><span>→ Individual Hearing Notes</span>
  </a>
  <a href="/admin/hearing/history" class="nav-item ${historyActive}" data-perm="hearings.read" style="border-bottom:1px solid rgba(183,156,98,.2); font-size:13px; opacity:.85;">
    <span class="icon">📚</span><span>All Hearing History</span>
  </a>

  <!-- Admin-only items — hidden for attorney/paralegal/viewer -->
  <a href="/admin/matters/" class="nav-item" data-perm="matters.access" style="background:rgba(12,28,54,.06); border-left-color:rgba(12,28,54,.4); border-bottom:1px solid rgba(12,28,54,.15); font-size:13px;">
    <span class="icon">⚖️</span><span>Matter Manager <span style="font-size:9px; opacity:.6;">(admin)</span></span>
  </a>
  <a href="/admin/dropbox/setup" class="nav-item ${dropboxActive}" data-perm="dropbox.setup" style="background:rgba(0,97,255,.06); ${dropboxActive ? "" : "border-left-color:rgba(0,97,255,.4);"} border-bottom:1px solid rgba(0,97,255,.15); font-size:13px;">
    <span class="icon">📦</span><span>Dropbox Setup <span style="font-size:9px; opacity:.6;">(admin)</span></span>
  </a>
  <a href="/admin/email-setup" class="nav-item" data-perm="email.setup" style="border-bottom:1px solid rgba(183,156,98,.15); font-size:13px; opacity:.85;">
    <span class="icon">📬</span><span>Email Setup <span style="font-size:9px; opacity:.6;">(admin)</span></span>
  </a>
  <a href="/admin/reminders" class="nav-item" data-perm="users.manage" style="border-bottom:1px solid rgba(183,156,98,.15); font-size:13px; opacity:.85;">
    <span class="icon">📣</span><span>Hearing Reminders <span style="font-size:9px; opacity:.6;">(admin)</span></span>
  </a>
  <a href="/admin/backups" class="nav-item" data-perm="users.manage" style="border-bottom:1px solid rgba(183,156,98,.15); font-size:13px; opacity:.85;">
    <span class="icon">💾</span><span>Backups <span style="font-size:9px; opacity:.6;">(admin)</span></span>
  </a>
  <a href="/admin/audit-log" class="nav-item" data-perm="users.manage" style="border-bottom:1px solid rgba(183,156,98,.15); font-size:13px; opacity:.85;">
    <span class="icon">📜</span><span>Audit Log <span style="font-size:9px; opacity:.6;">(admin)</span></span>
  </a>
  <a href="/admin/users" class="nav-item" data-perm="users.manage" style="border-bottom:1px solid rgba(183,156,98,.15); font-size:13px; opacity:.85;">
    <span class="icon">👤</span><span>Admin Users <span style="font-size:9px; opacity:.6;">(admin)</span></span>
  </a>
</div>

<div class="main">
  <div id="auth-user-chip" style="position:fixed; top:12px; right:20px; font-size:12px; color:#555; background:white; padding:6px 12px; border-radius:20px; box-shadow:0 1px 4px rgba(0,0,0,.08); z-index:100; display:flex; align-items:center; gap:8px;">
    <span id="auth-user-name" style="color:#0C1C36; font-weight:600;">…</span>
    <span id="auth-user-role" style="background:#666; color:white; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600;"></span>
    <form method="POST" action="/admin/logout" style="display:inline; margin:0;">
      <button type="submit" style="background:none; border:none; color:#c00; font-size:11px; cursor:pointer; padding:0; text-decoration:underline;">Logout</button>
    </form>
  </div>
  <script>
    fetch("/admin/whoami").then(r => r.json()).then(d => {
      if (!d.authenticated) {
        document.getElementById("auth-user-chip").style.display = "none";
        return;
      }
      document.getElementById("auth-user-name").textContent = d.name || d.username;
      const roleEl = document.getElementById("auth-user-role");
      roleEl.textContent = d.role_label || d.role;
      roleEl.style.background = d.role_color || "#666";
      // Hide sidebar items the user's role can't access
      document.querySelectorAll("[data-perm]").forEach(el => {
        const p = el.dataset.perm;
        if (!(d.permissions && d.permissions[p])) el.style.display = "none";
      });
    }).catch(() => document.getElementById("auth-user-chip").style.display = "none");
  </script>
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

function renderNoteForm({ noteId = null, generated = null, saved = false, sent = null, error = null, prev = {}, merged = false, revisions = [] } = {}) {
  const isEdit = !!noteId;
  // When editing, auto-show saved summaries (like individual hearing form does)
  if (isEdit && !generated && (prev.paralegal_summary || prev.client_summary)) {
    generated = {
      id: noteId,
      paralegal_summary: prev.paralegal_summary || "",
      client_summary: prev.client_summary || "",
    };
  }
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
        <button type="button" onclick="sendParalegal(${generated.id})" style="background:#4CAF50; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-left:8px;">📤 Send to team group</button>
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
    ${merged ? '<div style="background:#fff8e1; border-left:4px solid #f9a825; padding:12px 16px; border-radius:4px; margin-bottom:10px; font-size:13px;"><strong>ℹ️ Merged with existing hearing note.</strong> Zara detected that a hearing note for this client at this time already existed (note #' + noteId + '). Instead of creating a duplicate, your changes were merged into the existing note. Scroll down to see revision history.</div>' : ""}
    ${sent ? `<p style="color:#4CAF50; font-weight:bold;">📤 Sent to team group (${sent.chunks} message${sent.chunks > 1 ? "s" : ""}).</p>` : ""}
  ` : "";

  // Revision history panel — only on edit mode
  const revisionsHtml = isEdit && revisions && revisions.length ? `
    <details style="margin:20px 0; background:white; border:1px solid #eee; border-radius:6px;" ${revisions.length > 1 ? "" : "open"}>
      <summary style="cursor:pointer; padding:12px 16px; background:#f8f8f8; border-radius:6px 6px 0 0; font-weight:600; color:#0C1C36; display:flex; align-items:center; justify-content:space-between;">
        <span>📜 Revision History (${revisions.length})</span>
        <span style="font-size:11px; color:#888; font-weight:normal;">Click to ${revisions.length > 1 ? "expand" : "collapse"}</span>
      </summary>
      <div style="padding:0;">
        ${revisions.map(r => {
          const dt = new Date(r.created_at).toLocaleString();
          const typeLabel = {
            "created": "🆕 Created",
            "updated": "✏️ Updated",
            "sent_to_paralegal": "📤 Sent to team",
            "summaries_regenerated": "🔄 Summaries regenerated",
          }[r.revision_type] || r.revision_type;
          const fields = r.changed_fields && r.changed_fields.length
            ? `<div style="font-size:11px; color:#888; margin-top:4px;">Changed: ${r.changed_fields.map(f => `<code style="background:#eee; padding:1px 4px; border-radius:2px; font-size:10px;">${escapeHtml(f)}</code>`).join(" ")}</div>`
            : "";
          return `
            <div style="padding:10px 16px; border-bottom:1px solid #f0f0f0; font-size:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span><strong>${typeLabel}</strong> ${r.username ? `by <span style="color:#0C1C36;">${escapeHtml(r.username)}</span>` : ""}</span>
                <span style="color:#888;">${dt}</span>
              </div>
              ${fields}
            </div>`;
        }).join("")}
      </div>
    </details>
  ` : "";

  const body = `
  <div class="page-header">
    <h1>📝 Hearing Notes${isEdit ? ` — Editing #${noteId}` : ""}</h1>
  </div>
  <p style="margin-bottom:15px; color:#555;">Take notes during the hearing. Zara will clean them up and generate a paralegal summary + client-friendly summary in the client's language.</p>

  <div id="upload-area"
       ondragover="handleDragOver(event)"
       ondragleave="handleDragLeave(event)"
       ondrop="handleDrop(event)"
       style="background:#fdf7f0; border:2px dashed #B79C62; padding:25px; border-radius:8px; margin-bottom:20px; text-align:center; transition:all .2s;">
    <div style="font-size:14px; margin-bottom:12px;">
      <strong style="font-size:16px;">📄 Drop a document here</strong> — or —
      <button type="button" onclick="document.getElementById('doc-upload').click()" style="background:#B79C62; color:white; padding:8px 18px; border:none; border-radius:4px; cursor:pointer; font-size:14px; margin-left:8px;">Choose file</button>
      <input type="file" id="doc-upload" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*" style="display:none;" onchange="uploadDocument(this.files[0])">
    </div>
    <div style="font-size:12px; color:#666; margin-bottom:4px;">
      Works with I-589, NTA, court notices, meeting notes, hearing orders, receipts, or <strong>handwritten hearing notes</strong> from covering counsel.
    </div>
    <div style="font-size:12px; color:#666;">
      Accepts PDF, JPG, PNG, WebP, HEIC · Max 32 MB · OCR takes ~30–60 seconds
    </div>
    <div id="doc-status" style="margin-top:12px; font-size:13px;"></div>
    <div id="doc-extracted" style="margin-top:10px;"></div>
  </div>

  ${errorSection}
  ${previewSection}

  <form method="POST" action="/admin/hearing/notes${isEdit ? "/" + noteId : ""}" id="hearing-form">
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
      <label>Client mailing address</label>
      <textarea name="client_address" rows="2" placeholder="Street, City, State, ZIP">${escapeHtml(prev.client_address || "")}</textarea>
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
      <div style="margin-top:14px; padding-top:10px; border-top:1px solid #eee;">
        <label style="display:inline-flex; align-items:center; font-weight:normal; margin-right:20px;">
          <input type="checkbox" name="asylum_fee_needed" value="1" ${prev.asylum_fee_needed ? "checked" : ""}>
          Asylum fee needed ($100 as of 2025)
        </label>
        <label style="display:inline-flex; align-items:center; font-weight:normal;">
          <input type="checkbox" name="biometrics_needed" value="1" ${prev.biometrics_needed ? "checked" : ""}>
          Biometrics needed
        </label>
      </div>
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
      ${isEdit ? `
        <button type="submit" name="action" value="update" style="background:#B79C62; color:white;">💾 Update</button>
        <button type="submit" name="action" value="update_and_regenerate" style="background:#0C1C36; color:white;">💾 Update + Regenerate Summaries</button>
        <a href="/admin/hearing/notes" style="background:#eee; color:#333; padding:12px 24px; border-radius:4px; text-decoration:none; font-size:15px;">+ New note</a>
        <button type="button" onclick="deleteThisNote(${noteId}, ${JSON.stringify(prev.client_name || "").replace(/"/g, "&quot;")})" style="background:#c00; color:white; padding:12px 20px; border:none; border-radius:4px; cursor:pointer; font-size:14px; margin-left:auto;">🗑️ Delete note</button>
      ` : `
        <button type="submit" name="action" value="preview">✨ Generate Summaries (Preview)</button>
        <button type="submit" name="action" value="save">💾 Generate + Save</button>
        <button type="reset" class="secondary">Clear form</button>
      `}
    </div>
  </form>

  ${revisionsHtml}

  <p style="margin-top:30px; color:#888; font-size:13px;">
    <a href="/admin/hearing/history" class="back-link">View all hearing notes →</a>
    &nbsp;·&nbsp;
    <a href="/admin/hearing/notes/dictate" class="back-link" style="color:#B79C62;">🎙️ Voice dictate a hearing →</a>
    &nbsp;·&nbsp;
    <a href="/admin/hearing/notes/bulk-upload" class="back-link" style="color:#0061FF;">📚 Bulk upload multiple documents →</a>
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
          status.textContent = "✅ Sent to team group";
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

    async function deleteThisNote(id, clientName) {
      if (!confirm("Delete hearing note #" + id + " for " + clientName + "?\\n\\nThis cannot be undone.")) return;
      try {
        const resp = await fetch("/admin/hearing/notes/" + id, { method: "DELETE" });
        const data = await resp.json();
        if (data.ok) {
          window.location.href = "/admin/hearing/history";
        } else {
          alert("❌ Delete failed: " + (data.error || "unknown error"));
        }
      } catch (e) {
        alert("❌ Delete error: " + e.message);
      }
    }

    // ── Document Upload + Auto-Fill ──────────────────────
    // Handles drag-drop AND file picker.
    // Extracts fields from I-589, NTA, notes, court orders, etc.

    function handleDragOver(e) {
      e.preventDefault(); e.stopPropagation();
      document.getElementById("upload-area").style.background = "#faedd5";
      document.getElementById("upload-area").style.borderColor = "#8f7a4c";
    }
    function handleDragLeave(e) {
      e.preventDefault(); e.stopPropagation();
      document.getElementById("upload-area").style.background = "#fdf7f0";
      document.getElementById("upload-area").style.borderColor = "#B79C62";
    }
    function handleDrop(e) {
      e.preventDefault(); e.stopPropagation();
      document.getElementById("upload-area").style.background = "#fdf7f0";
      document.getElementById("upload-area").style.borderColor = "#B79C62";
      const files = e.dataTransfer.files;
      if (files.length > 0) uploadDocument(files[0]);
    }

    async function uploadDocument(file) {
      if (!file) return;
      const statusEl = document.getElementById("doc-status");
      const extractedEl = document.getElementById("doc-extracted");
      extractedEl.innerHTML = "";

      console.log("[uploadDocument] File:", { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified });

      if (file.size > 32 * 1024 * 1024) {
        statusEl.innerHTML = '<span style="color:#c00;">❌ File too large (max 32 MB). Try a smaller/lower-quality scan.</span>';
        return;
      }

      // Very permissive — allow anything that looks like PDF/image
      const nameOk = /\\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
      const typeOk = (file.type || "").includes("pdf") || (file.type || "").startsWith("image/");
      if (!nameOk && !typeOk && file.type !== "" && file.type !== "application/octet-stream") {
        console.warn("[uploadDocument] Rejected file:", { name: file.name, type: file.type });
        statusEl.innerHTML = '<span style="color:#c00;">❌ Unsupported file type "' + (file.type || file.name) + '". Use PDF, JPG, PNG, WebP, or HEIC.</span>';
        return;
      }

      statusEl.innerHTML = '<span style="color:#666;">⏳ Uploading and OCRing ' + escapeHTMLLocal(file.name) + ' — 30–60 seconds for a large scan...</span>';

      // Rebuild the File with a sanitized name to avoid Safari FormData issues
      // with special chars, emoji, or non-ASCII filenames.
      let safeFile = file;
      try {
        const safeName = (file.name || "upload").replace(/[^\\w.\\-]/g, "_") || "upload";
        if (safeName !== file.name && typeof File === "function") {
          safeFile = new File([file], safeName, { type: file.type || "application/octet-stream" });
          console.log("[uploadDocument] Renamed to:", safeName);
        }
      } catch (e) {
        console.warn("[uploadDocument] Could not rename file, using original:", e.message);
      }

      let formData;
      try {
        formData = new FormData();
        formData.append("document", safeFile, safeFile.name || "upload");
      } catch (e) {
        console.error("[uploadDocument] FormData construction failed:", e);
        statusEl.innerHTML = '<span style="color:#c00;">❌ FormData error: ' + e.message + '</span>';
        return;
      }

      let resp;
      try {
        resp = await fetch("/admin/hearing/notes/extract-document", {
          method: "POST",
          body: formData,
        });
      } catch (e) {
        console.error("[uploadDocument] fetch failed:", e);
        statusEl.innerHTML = '<span style="color:#c00;">❌ Network error: ' + e.message + '. Check your connection or try a smaller file.</span>';
        return;
      }

      let data;
      try {
        const text = await resp.text();
        try {
          data = JSON.parse(text);
        } catch (parseErr) {
          console.error("[uploadDocument] Non-JSON response:", { status: resp.status, body: text.substring(0, 500) });
          statusEl.innerHTML = '<span style="color:#c00;">❌ Server returned non-JSON response (HTTP ' + resp.status + '). Body starts with: ' + escapeHTMLLocal(text.substring(0, 200)) + '</span>';
          return;
        }
      } catch (e) {
        console.error("[uploadDocument] Response read failed:", e);
        statusEl.innerHTML = '<span style="color:#c00;">❌ Response error: ' + e.message + '</span>';
        return;
      }

      try {
        if (!resp.ok || !data.ok) {
          statusEl.innerHTML = '<span style="color:#c00;">❌ ' + (data.error || "Extraction failed (HTTP " + resp.status + ")") + '</span>';
          return;
        }

        const filled = [];
        const prefill = data.form_prefill || {};
        const docType = prefill.document_type || "document";

        function fillIfEmpty(fieldName, value) {
          if (!value) return false;
          const el = document.querySelector('[name="' + fieldName + '"]');
          if (!el) return false;
          if (el.value && el.value.trim()) return false;
          el.value = value;
          el.style.backgroundColor = "#fffde7";
          filled.push(fieldName);
          return true;
        }

        fillIfEmpty("client_name", prefill.client_name);
        fillIfEmpty("a_number", prefill.a_number);
        fillIfEmpty("client_email", prefill.client_email);
        fillIfEmpty("client_phone", prefill.client_phone);
        fillIfEmpty("client_address", prefill.client_address);
        fillIfEmpty("case_type", prefill.case_type);
        fillIfEmpty("judge_name", prefill.judge_name);
        fillIfEmpty("dhs_attorney", prefill.dhs_attorney);
        fillIfEmpty("next_hearing_date", prefill.next_hearing_date);
        fillIfEmpty("next_hearing_type", prefill.next_hearing_type);

        // Language dropdown
        if (prefill.client_language) {
          const langEl = document.querySelector('[name="client_language"]');
          if (langEl && langEl.value === "en") {
            langEl.value = prefill.client_language;
            langEl.style.backgroundColor = "#fffde7";
            filled.push("client_language");
          }
        }

        // Hearing type
        if (prefill.hearing_type) {
          const htEl = document.querySelector('[name="hearing_type"]');
          if (htEl) {
            const match = Array.from(htEl.options).find(o => o.value.toLowerCase().includes(prefill.hearing_type.toLowerCase()));
            if (match) {
              htEl.value = match.value;
              htEl.style.backgroundColor = "#fffde7";
              filled.push("hearing_type");
            }
          }
        }

        // Hearing date/time
        if (prefill.hearing_datetime) {
          const dtEl = document.querySelector('[name="hearing_date"]');
          if (dtEl && !dtEl.value) {
            // Chop off timezone/seconds to match datetime-local format
            const val = prefill.hearing_datetime.substring(0, 16);
            dtEl.value = val;
            dtEl.style.backgroundColor = "#fffde7";
            filled.push("hearing_date");
          }
        }

        // Narrative notes → append to raw_notes
        if (prefill.narrative_notes) {
          const notesEl = document.getElementById("raw_notes");
          if (notesEl) {
            const stamp = "--- From " + docType + " (" + file.name + ") ---";
            const addition = stamp + "\\n" + prefill.narrative_notes;
            notesEl.value = notesEl.value.trim()
              ? notesEl.value + "\\n\\n" + addition
              : addition;
            notesEl.style.backgroundColor = "#fffde7";
            filled.push("raw_notes");
          }
        }

        // Auto-check I-589 Asylum if doc is an I-589
        if (docType && /i-?589|asylum/i.test(docType)) {
          const asylumCheckbox = Array.from(document.querySelectorAll('input[type="checkbox"]'))
            .find(cb => cb.value && cb.value.startsWith("I-589 Asylum"));
          if (asylumCheckbox && !asylumCheckbox.checked) {
            asylumCheckbox.checked = true;
            filled.push("I-589 Asylum (application)");
          }
        }

        // Show extracted info summary
        const extra = prefill._extra || {};
        const extraLines = [];
        if (extra.date_of_birth) extraLines.push("DOB: " + extra.date_of_birth);
        if (extra.country_of_citizenship) extraLines.push("Country: " + extra.country_of_citizenship);
        if (extra.us_address) extraLines.push("US Address: " + extra.us_address);
        if (extra.charges) extraLines.push("Charges: " + extra.charges);
        if (extra.allegations) extraLines.push("Allegations: " + extra.allegations);
        if (extra.asylum_basis && extra.asylum_basis.length) extraLines.push("Asylum basis: " + extra.asylum_basis.join(", "));
        if (extra.applications_mentioned && extra.applications_mentioned.length) extraLines.push("Applications mentioned: " + extra.applications_mentioned.join(", "));
        if (extra.date_of_entry) extraLines.push("Entered US: " + extra.date_of_entry + (extra.manner_of_entry ? " (" + extra.manner_of_entry + ")" : ""));
        if (extra.spouse_name) extraLines.push("Spouse: " + extra.spouse_name);
        if (extra.children_count) extraLines.push("Children: " + extra.children_count);

        const detectedLine = '<div style="font-size:12px; color:#666; margin-bottom:6px;">Detected: <strong>' + (docType || "unknown document") + '</strong></div>';

        if (filled.length === 0) {
          statusEl.innerHTML = detectedLine + '<span style="color:#ff9800;">⚠️ No new fields filled. Form may already have values, or nothing extractable from this doc.</span>';
        } else {
          statusEl.innerHTML = detectedLine + '<span style="color:#4CAF50;">✅ Filled: ' + filled.join(", ") + '. Please verify highlighted fields.</span>';
        }

        if (extraLines.length) {
          extractedEl.innerHTML = '<div style="background:white; padding:10px; border-radius:4px; margin-top:8px; font-size:13px; color:#333; border:1px solid #eee; text-align:left;">' +
            '<strong>Additional data extracted (for reference):</strong><br>' +
            extraLines.map(l => "• " + l).join("<br>") +
            '</div>';
        }
      } catch (e) {
        // Anything unexpected during the "fill fields" phase
        console.error("[uploadDocument] fill phase failed:", e);
        statusEl.innerHTML = '<span style="color:#c00;">❌ Fill error: ' + e.message + '. Extraction may have succeeded — check server logs.</span>';
      }
    }

    // Local escaper for status messages (defined inside the form template)
    function escapeHTMLLocal(s) {
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // Backward-compat alias in case old code paths still call it
    async function uploadI589(file) { return uploadDocument(file); }
  </script>`;

  return renderAdminChrome({ title: "Hearing Notes", body, activeItem: "notes" });
}

function renderHistoryPage(notes) {
  const rows = notes.length ? notes.map(n => {
    const sentClass = n.sent_to_paralegal_at ? "sent" : "unsent";
    return `
    <tr class="hearing-row"
        data-name="${escapeAttr((n.client_name || "").toLowerCase())}"
        data-anumber="${escapeAttr((n.a_number || "").toLowerCase().replace(/[-\s]/g, ""))}"
        data-htype="${escapeAttr(n.hearing_type || "")}"
        data-sent="${sentClass}"
        data-lang="${escapeAttr(n.client_language || "")}">
      <td>#${n.id}</td>
      <td>${escapeHtml(n.client_name)}</td>
      <td>${escapeHtml(n.a_number || "")}</td>
      <td>${escapeHtml(n.hearing_type || "-")}${n.sequence_total && n.sequence_total > 1 ? ` <span style="background:#B79C62; color:white; padding:1px 6px; border-radius:8px; font-size:11px;">#${n.sequence}/${n.sequence_total}</span>` : ""}</td>
      <td>${n.hearing_date ? new Date(n.hearing_date).toLocaleDateString() : "-"}</td>
      <td>${n.next_hearing_date ? new Date(n.next_hearing_date).toLocaleDateString() : "-"}</td>
      <td>${escapeHtml(n.next_hearing_type || "-")}</td>
      <td>${n.client_language}</td>
      <td>${n.sent_to_paralegal_at ? "✅" : "—"}</td>
      <td>${new Date(n.created_at).toLocaleDateString()}</td>
      <td>
        <a href="/admin/hearing/notes/${n.id}" style="color:#B79C62;">view</a>
        &nbsp;·&nbsp;
        <a href="#" onclick="deleteRow(${n.id}, ${JSON.stringify(n.client_name).replace(/"/g, "&quot;")}); return false;" style="color:#c00; font-size:12px;">🗑️</a>
      </td>
    </tr>`;
  }).join("") : `<tr id="no-data-row"><td colspan="11" style="text-align:center; color:#888;">No hearing notes yet.</td></tr>`;

  const body = `
    <div class="page-header">
      <h1>📚 Hearing Notes History</h1>
      <a href="/admin/hearing/notes" class="back-link">← Back to note-taking</a>
      &nbsp;·&nbsp;
      <a href="/admin/hearing/notes/duplicates" class="back-link" style="color:#c62828;">🧹 Find duplicates</a>
    </div>

    <div style="background:white; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #eee;">
      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        <div style="flex:1; min-width:260px;">
          <input type="text" id="search-input" placeholder="🔍 Search by client name or A-Number..."
                 onkeyup="filterRows()"
                 style="width:100%; padding:9px 12px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
        </div>
        <div>
          <select id="filter-htype" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All hearing types</option>
            <option value="master">Master</option>
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
            <option value="sent">Sent to team ✅</option>
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
        Showing ${notes.length} note${notes.length === 1 ? "" : "s"}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>ID</th><th>Client</th><th>A#</th><th>Type</th><th>Hearing</th>
          <th>Next</th><th>Next Type</th><th>Lang</th>
          <th>Sent</th><th>Created</th><th></th>
        </tr>
      </thead>
      <tbody id="rows-body">${rows}</tbody>
    </table>

    <script>
      const TOTAL = ${notes.length};
      function filterRows() {
        const search = document.getElementById("search-input").value.toLowerCase().replace(/[-\\s]/g, "");
        const htype = document.getElementById("filter-htype").value;
        const sent = document.getElementById("filter-sent").value;
        const lang = document.getElementById("filter-lang").value;
        let visible = 0;
        document.querySelectorAll(".hearing-row").forEach(row => {
          const name = row.dataset.name || "";
          const anumber = row.dataset.anumber || "";
          const rowHtype = row.dataset.htype || "";
          const rowSent = row.dataset.sent || "";
          const rowLang = row.dataset.lang || "";
          const matchesSearch = !search || name.includes(search) || anumber.includes(search);
          const matchesHtype = !htype || rowHtype === htype;
          const matchesSent = !sent || rowSent === sent;
          const matchesLang = !lang || rowLang === lang;
          const show = matchesSearch && matchesHtype && matchesSent && matchesLang;
          row.style.display = show ? "" : "none";
          if (show) visible++;
        });
        const count = document.getElementById("row-count");
        if (visible === TOTAL) {
          count.textContent = "Showing " + TOTAL + " note" + (TOTAL === 1 ? "" : "s");
        } else {
          count.textContent = "Showing " + visible + " of " + TOTAL + " notes";
        }
      }
      function clearFilters() {
        document.getElementById("search-input").value = "";
        document.getElementById("filter-htype").value = "";
        document.getElementById("filter-sent").value = "";
        document.getElementById("filter-lang").value = "";
        filterRows();
      }
      async function deleteRow(id, clientName) {
        if (!confirm("Delete hearing note #" + id + " for " + clientName + "?\\n\\nThis cannot be undone.")) return;
        try {
          const resp = await fetch("/admin/hearing/notes/" + id, { method: "DELETE" });
          const data = await resp.json();
          if (data.ok) {
            // Remove the row from the table without a full page reload
            const row = document.querySelector('tr.hearing-row[data-name][data-anumber]');
            const rows = document.querySelectorAll('.hearing-row');
            for (const r of rows) {
              if (r.querySelector('a[href*="/' + id + '"]')) {
                r.remove();
                break;
              }
            }
            filterRows();
          } else {
            alert("❌ Delete failed: " + (data.error || "unknown error"));
          }
        } catch (e) {
          alert("❌ Delete error: " + e.message);
        }
      }
    </script>`;

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
        &nbsp; · &nbsp;
        <a href="#" onclick="deleteNote(${note.id}, ${JSON.stringify(note.client_name).replace(/"/g, "&quot;")}); return false;" style="color:#c00; font-size:13px;">🗑️ Delete</a>
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
      ${note.asylum_fee_needed ? '<div style="margin:4px 0;"><strong>Asylum fee:</strong> Required</div>' : ""}
      ${note.biometrics_needed ? '<div style="margin:4px 0;"><strong>Biometrics:</strong> Required</div>' : ""}
      ${note.bond_outcome ? `<div style="margin:4px 0;"><strong>Bond:</strong> ${escapeHtml(note.bond_outcome)}${note.bond_amount ? ` — $${Number(note.bond_amount).toLocaleString()}` : ""}</div>` : ""}
      <div style="margin:4px 0;"><strong>Next hearing:</strong> ${note.next_hearing_date ? new Date(note.next_hearing_date).toLocaleString() : "not scheduled"} (${escapeHtml(note.next_hearing_type || "-")})</div>
      <div style="margin:4px 0;"><strong>Client language:</strong> ${note.client_language}</div>
      <div style="margin:4px 0;"><strong>Sent to team:</strong> ${note.sent_to_paralegal_at ? new Date(note.sent_to_paralegal_at).toLocaleString() : "not sent"}</div>
      <div style="margin:4px 0;"><strong>Created:</strong> ${new Date(note.created_at).toLocaleString()}</div>
    </div>

    <h2 style="color:#B79C62; margin-top:30px;">Paralegal Summary</h2>
    <div style="margin-bottom:8px;">
      <button type="button" onclick="copyEl('paralegal-detail')" style="background:#0C1C36; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">📋 Copy</button>
      <button type="button" onclick="sendParalegalDetail(${note.id})" style="background:#4CAF50; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-left:8px;">📤 ${note.sent_to_paralegal_at ? "Re-send" : "Send"} to team group</button>
      <span id="send-detail-status" style="margin-left:12px; font-weight:bold;"></span>
    </div>
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
      async function deleteNote(id, clientName) {
        if (!confirm("Delete hearing note #" + id + " for " + clientName + "?\\n\\nThis cannot be undone.")) return;
        try {
          const resp = await fetch("/admin/hearing/notes/" + id, { method: "DELETE" });
          const data = await resp.json();
          if (data.ok) {
            window.location.href = "/admin/hearing/notes/history";
          } else {
            alert("❌ Delete failed: " + (data.error || "unknown error"));
          }
        } catch (e) {
          alert("❌ Delete error: " + e.message);
        }
      }
      async function sendParalegalDetail(id) {
        const status = document.getElementById("send-detail-status");
        status.textContent = "Sending...";
        status.style.color = "#666";
        try {
          const resp = await fetch("/admin/hearing/notes/" + id + "/send-paralegal", { method: "POST" });
          const data = await resp.json();
          if (data.ok) {
            status.textContent = "✅ Sent to team group";
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
    client_address: (body.client_address || "").trim() || null,
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
    asylum_fee_needed: !!body.asylum_fee_needed,
    biometrics_needed: !!body.biometrics_needed,
    disposition: body.disposition || null,
    disposition_notes: (body.disposition_notes || "").trim() || null,
    bond_outcome: body.bond_outcome || null,
    bond_amount: body.bond_amount ? parseInt(body.bond_amount.toString().replace(/[,$\s]/g, ""), 10) || null : null,
    next_hearing_date: body.next_hearing_date || null,
    next_hearing_type: body.next_hearing_type || null,
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

// ── Duplicate finder & merger ───────────────────────────
// Finds hearing notes that appear to be duplicates (same client + same
// hearing time) so JJ can consolidate them.

async function findDuplicates() {
  await initHearingNotesTables();
  const r = await db.query(`
    SELECT
      LOWER(TRIM(client_name)) AS name_key,
      COALESCE(a_number, '') AS a_key,
      DATE_TRUNC('hour', hearing_date) AS hour_key,
      COALESCE(hearing_type, '') AS type_key,
      ARRAY_AGG(id ORDER BY created_at DESC) AS ids,
      COUNT(*) AS n
    FROM hearing_notes
    WHERE client_name IS NOT NULL
    GROUP BY name_key, a_key, hour_key, type_key
    HAVING COUNT(*) > 1
    ORDER BY n DESC, MAX(created_at) DESC
    LIMIT 100
  `);

  const groups = [];
  for (const row of r.rows) {
    const notes = await db.query(
      `SELECT id, client_name, a_number, hearing_date, hearing_type, created_at,
              sent_to_paralegal_at, sent_to_client_at,
              CASE WHEN raw_notes IS NOT NULL AND LENGTH(raw_notes) > 10 THEN 1 ELSE 0 END AS has_notes,
              CASE WHEN paralegal_summary IS NOT NULL THEN 1 ELSE 0 END AS has_summary
       FROM hearing_notes WHERE id = ANY($1) ORDER BY
         (raw_notes IS NOT NULL AND LENGTH(raw_notes) > 10) DESC,   -- prefer ones with notes
         (paralegal_summary IS NOT NULL) DESC,                       -- prefer ones with summary
         (sent_to_paralegal_at IS NOT NULL) DESC,                    -- prefer ones already sent
         created_at ASC                                              -- oldest first (usually canonical)`,
      [row.ids]
    );
    groups.push({
      key: `${row.name_key}|${row.hour_key}|${row.type_key}`,
      count: row.n,
      notes: notes.rows,
      // Suggest keeping the FIRST one in the sorted result (best candidate)
      keep_id: notes.rows[0].id,
      delete_ids: notes.rows.slice(1).map(n => n.id),
    });
  }
  return groups;
}

// Merge duplicates: delete the "extra" notes, keep the canonical one.
// Also records a revision on the canonical note noting what was merged.
async function mergeDuplicates(keepId, deleteIds) {
  await initHearingNotesTables();
  await initRevisionTable();
  let deleted = 0;
  for (const id of deleteIds) {
    if (id === keepId) continue;
    try {
      // Migrate any revisions from the deleted note to the kept one
      await db.query(
        `UPDATE hearing_note_revisions SET note_id = $1 WHERE note_id = $2`,
        [keepId, id]
      );
      await db.query(`DELETE FROM hearing_notes WHERE id = $1`, [id]);
      deleted++;
    } catch (e) {
      console.warn(`[hearing-notes] Failed to delete duplicate #${id}:`, e.message);
    }
  }
  await saveRevision(keepId, "updated", { merged_from: deleteIds }, null);
  return { keep_id: keepId, deleted_count: deleted, deleted_ids: deleteIds };
}

function renderDuplicatesPage(groups) {
  const dupCount = groups.reduce((sum, g) => sum + (g.count - 1), 0);
  const groupCards = groups.length ? groups.map(g => {
    const rows = g.notes.map((n, idx) => {
      const isKept = idx === 0;
      const dt = n.hearing_date ? new Date(n.hearing_date).toLocaleString() : "(no date)";
      const created = new Date(n.created_at).toLocaleString();
      return `
        <tr style="${isKept ? 'background:#e8f5e9;' : ''}">
          <td style="padding:6px 10px;">
            ${isKept ? '<strong style="color:#2e7d32;">✓ KEEP</strong>' : '<span style="color:#c62828;">DELETE</span>'}
          </td>
          <td style="font-family:monospace; font-size:11px;">#${n.id}</td>
          <td style="font-size:11px;">${escapeHtml(n.hearing_type || "—")}</td>
          <td style="font-size:11px;">${dt}</td>
          <td style="font-size:11px;">${created}</td>
          <td style="text-align:center;">${n.has_notes ? '📝' : ''}</td>
          <td style="text-align:center;">${n.has_summary ? '📄' : ''}</td>
          <td style="text-align:center;">${n.sent_to_paralegal_at ? '📤' : ''}</td>
        </tr>`;
    }).join("");
    return `
      <div style="background:white; padding:16px; border-radius:6px; border:1px solid #eee; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div>
            <strong style="font-size:14px;">${escapeHtml(g.notes[0].client_name)}</strong>
            <span style="color:#888; font-size:12px; margin-left:8px;">${g.count} copies</span>
          </div>
          <button onclick="mergeGroup('${g.keep_id}', [${g.delete_ids.join(",")}])" style="background:#c62828; color:white; padding:6px 12px; border:none; border-radius:4px; cursor:pointer; font-size:12px;">
            Merge (keep #${g.keep_id}, delete ${g.delete_ids.length})
          </button>
        </div>
        <table style="width:100%; font-size:12px;">
          <thead style="background:#f8f8f8;">
            <tr><th style="text-align:left; padding:4px 10px;">Action</th><th>ID</th><th>Type</th><th>Hearing Date</th><th>Created</th><th>📝</th><th>📄</th><th>📤</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join("") : `<div style="background:white; padding:30px; text-align:center; border-radius:6px; color:#2e7d32;"><h2>🎉 No duplicates found!</h2><p style="color:#666;">Your hearing notes database is clean.</p></div>`;

  const body = `
    <div class="page-header">
      <h1>🧹 Duplicate Hearing Notes</h1>
      <div style="font-size:13px; color:#666;">
        Zara found <strong>${dupCount}</strong> duplicate hearing note(s) across <strong>${groups.length}</strong> group(s).
        Each group shows notes that share the same client + hearing time + type.
        The row highlighted green is the canonical one (has the most data — original + notes + summary + sent status).
      </div>
    </div>

    <div style="background:#fff8e1; border-left:4px solid #f9a825; padding:12px 16px; border-radius:4px; margin-bottom:20px; font-size:13px;">
      <strong>ℹ️ How merge works:</strong> Zara deletes the extra rows but keeps ALL their revision history attached to the surviving canonical note. The canonical row is the one with the most content (raw notes + summary + team-sent status).
    </div>

    ${groupCards}

    <script>
      async function mergeGroup(keepId, deleteIds) {
        if (!confirm("Merge these duplicates?\\n\\nKeep note #" + keepId + ", delete " + deleteIds.length + " duplicate(s).\\n\\nThis cannot be undone (but they'll show in the next Dropbox backup).")) return;
        try {
          const r = await fetch("/admin/hearing/notes/merge-duplicates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keep_id: keepId, delete_ids: deleteIds }),
          });
          const d = await r.json();
          if (d.ok) location.reload();
          else alert("Error: " + (d.error || "unknown"));
        } catch (e) { alert("Error: " + e.message); }
      }
    </script>`;

  return renderAdminChrome({ title: "Duplicate Hearing Notes", body, activeItem: null });
}
// Multi-file upload → Claude extraction in parallel → review grid →
// bulk-create draft hearing notes with one click.
function renderBulkUploadPage() {
  const body = `
<div class="page-header">
  <h1>📚 Bulk Upload Master Hearing Notes</h1>
  <div style="font-size:13px; color:#666;">
    Drop or select multiple photos/PDFs from a day of court. Zara extracts fields for each in parallel, then you review + create the drafts.
  </div>
</div>

<div id="bulk-upload-area"
     ondragover="handleBulkDrag(event, true)"
     ondragleave="handleBulkDrag(event, false)"
     ondrop="handleBulkDrop(event)"
     style="border:3px dashed #B79C62; padding:32px 20px; text-align:center; border-radius:8px; background:#fdf7f0; cursor:pointer; margin-bottom:20px;"
     onclick="document.getElementById('bulk-file-input').click()">
  <div style="font-size:40px; margin-bottom:8px;">📚</div>
  <strong style="font-size:16px;">Drop multiple documents here — or click to select</strong>
  <div style="font-size:12px; color:#666; margin-top:6px;">
    PDF, JPG, PNG, WebP, or HEIC. Up to 20 files at a time. Each processes in parallel (~30–60 sec each).
  </div>
  <input type="file" id="bulk-file-input" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*" style="display:none;" onchange="handleBulkFiles(this.files)">
</div>

<div id="bulk-progress-bar" style="display:none; background:white; padding:15px 20px; border-radius:6px; margin-bottom:15px; border:1px solid #eee;">
  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
    <strong id="bulk-progress-label" style="color:#0C1C36;">Processing…</strong>
    <span id="bulk-progress-count" style="font-size:13px; color:#666;">0 of 0</span>
  </div>
  <div style="background:#eee; height:8px; border-radius:4px; overflow:hidden;">
    <div id="bulk-progress-fill" style="background:linear-gradient(to right, #B79C62, #d4b979); height:100%; width:0%; transition:width 0.3s;"></div>
  </div>
</div>

<div id="bulk-cards-grid" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:15px;"></div>

<div id="bulk-actions-bar" style="display:none; position:sticky; bottom:0; background:white; padding:15px 20px; border-radius:6px; border:1px solid #eee; margin-top:20px; box-shadow:0 -4px 12px rgba(0,0,0,.05); display:none;">
  <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
    <div>
      <span id="bulk-ready-count" style="font-size:13px; color:#666;">0 ready</span>
    </div>
    <div style="display:flex; gap:8px;">
      <button type="button" onclick="discardAllPending()" style="background:#eee; color:#333; padding:9px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Discard all pending</button>
      <button type="button" onclick="createAllAsDrafts()" id="bulk-create-all-btn" style="background:#0C1C36; color:white; padding:9px 16px; border:none; border-radius:4px; cursor:pointer; font-size:13px; font-weight:600;">Create all as drafts</button>
    </div>
  </div>
</div>

<script>
const CONCURRENCY = 3;   // max simultaneous Claude extractions
const cards = new Map();   // cardId → { file, status, extraction, noteId }
let queue = [];
let inFlight = 0;

function handleBulkDrag(e, on) {
  e.preventDefault(); e.stopPropagation();
  const el = document.getElementById("bulk-upload-area");
  el.style.background = on ? "#faedd5" : "#fdf7f0";
  el.style.borderColor = on ? "#8f7a4c" : "#B79C62";
}
function handleBulkDrop(e) {
  handleBulkDrag(e, false);
  handleBulkFiles(e.dataTransfer.files);
}

function handleBulkFiles(files) {
  const arr = Array.from(files || []);
  if (!arr.length) return;
  const remaining = Math.min(arr.length, 20);
  if (arr.length > 20) alert("Max 20 files at a time. Only the first 20 will be processed.");

  document.getElementById("bulk-progress-bar").style.display = "block";
  document.getElementById("bulk-actions-bar").style.display = "block";

  for (let i = 0; i < remaining; i++) {
    const file = arr[i];
    const cardId = "card-" + Date.now() + "-" + i + "-" + Math.random().toString(36).substr(2, 5);
    cards.set(cardId, { file, status: "queued", extraction: null, noteId: null });
    renderCard(cardId);
    queue.push(cardId);
  }
  updateProgress();
  processQueue();
}

async function processQueue() {
  while (queue.length && inFlight < CONCURRENCY) {
    const cardId = queue.shift();
    inFlight++;
    processCard(cardId).finally(() => {
      inFlight--;
      processQueue();
      updateProgress();
    });
  }
}

async function processCard(cardId) {
  const c = cards.get(cardId);
  if (!c) return;

  c.status = "uploading";
  renderCard(cardId);

  // Rename file to sanitize (Safari/iOS quirks)
  let safeFile = c.file;
  try {
    const safeName = (c.file.name || "upload").replace(/[^\\w.\\-]/g, "_") || "upload";
    if (typeof File === "function") {
      safeFile = new File([c.file], safeName, { type: c.file.type || "application/octet-stream" });
    }
  } catch (e) { /* use original */ }

  const formData = new FormData();
  formData.append("document", safeFile, safeFile.name);

  try {
    c.status = "extracting";
    renderCard(cardId);
    const resp = await fetch("/admin/hearing/notes/extract-document", {
      method: "POST",
      body: formData,
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error("Server returned non-JSON: " + text.substring(0, 100)); }
    if (!resp.ok || !data.ok) throw new Error(data.error || "Extraction failed (HTTP " + resp.status + ")");
    c.extraction = data.form_prefill || {};
    c.raw = data.raw_extraction || null;
    c.status = "ready";
  } catch (e) {
    c.status = "error";
    c.error = e.message;
  }
  renderCard(cardId);
}

function renderCard(cardId) {
  const c = cards.get(cardId);
  if (!c) return;
  const grid = document.getElementById("bulk-cards-grid");
  let card = document.getElementById(cardId);
  if (!card) {
    card = document.createElement("div");
    card.id = cardId;
    card.style.cssText = "background:white; border-radius:6px; padding:15px; border:1px solid #eee; box-shadow:0 1px 3px rgba(0,0,0,.04);";
    grid.appendChild(card);
  }

  const statusMap = {
    queued:     { emoji: "⏳", text: "Queued",           color: "#888" },
    uploading:  { emoji: "📤", text: "Uploading…",       color: "#0061FF" },
    extracting: { emoji: "🤖", text: "Claude extracting…",color: "#B79C62" },
    ready:      { emoji: "✓",  text: "Ready to create",  color: "#2e7d32" },
    creating:   { emoji: "💾", text: "Creating draft…",  color: "#B79C62" },
    created:    { emoji: "✅", text: "Draft created",    color: "#2e7d32" },
    error:      { emoji: "❌", text: "Error",            color: "#c00" },
    discarded:  { emoji: "🗑️", text: "Discarded",        color: "#888" },
  };
  const s = statusMap[c.status] || statusMap.queued;

  const filename = c.file?.name || "upload";
  const shortName = filename.length > 32 ? filename.substring(0, 29) + "…" : filename;

  let content = '';
  content += '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">';
  content +=   '<div style="font-size:12px; color:#666; font-family:monospace; overflow:hidden; text-overflow:ellipsis;" title="' + escapeHTMLLocal2(filename) + '">📄 ' + escapeHTMLLocal2(shortName) + '</div>';
  content +=   '<span style="background:' + s.color + '; color:white; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600;">' + s.emoji + ' ' + s.text + '</span>';
  content += '</div>';

  if (c.status === "error") {
    content += '<div style="background:#fee; color:#900; padding:8px; border-radius:3px; font-size:12px; margin-bottom:8px;">' + escapeHTMLLocal2(c.error) + '</div>';
    content += '<button type="button" onclick="retryCard(\\'' + cardId + '\\')" style="background:#eee; padding:5px 10px; border:none; border-radius:3px; cursor:pointer; font-size:11px; margin-right:4px;">Retry</button>';
    content += '<button type="button" onclick="discardCard(\\'' + cardId + '\\')" style="background:#eee; padding:5px 10px; border:none; border-radius:3px; cursor:pointer; font-size:11px;">Discard</button>';
  } else if (c.status === "ready") {
    const e = c.extraction || {};
    content += '<div style="font-size:13px; line-height:1.5;">';
    content += e.client_name ? '<div><strong>Client:</strong> ' + escapeHTMLLocal2(e.client_name) + '</div>' : '<div style="color:#c00;">⚠️ No client name extracted</div>';
    if (e.a_number) content += '<div><strong>A#:</strong> ' + escapeHTMLLocal2(e.a_number) + '</div>';
    if (e.hearing_datetime) content += '<div><strong>Hearing:</strong> ' + escapeHTMLLocal2(new Date(e.hearing_datetime).toLocaleString()) + '</div>';
    if (e.judge_name) content += '<div><strong>Judge:</strong> ' + escapeHTMLLocal2(e.judge_name) + '</div>';
    if (e.case_type) content += '<div style="font-size:12px; color:#666;"><strong>Type:</strong> ' + escapeHTMLLocal2(e.case_type) + '</div>';
    if (e.hearing_type) content += '<div style="font-size:12px; color:#666;"><strong>Master/Individual:</strong> ' + escapeHTMLLocal2(e.hearing_type) + '</div>';
    if (e.narrative_notes) {
      const short = e.narrative_notes.length > 120 ? e.narrative_notes.substring(0, 120) + "…" : e.narrative_notes;
      content += '<div style="font-size:11px; color:#888; margin-top:4px; font-style:italic;">' + escapeHTMLLocal2(short) + '</div>';
    }
    content += '</div>';
    content += '<div style="display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;">';
    content +=   '<button type="button" onclick="createDraft(\\'' + cardId + '\\')" style="background:#0C1C36; color:white; padding:6px 12px; border:none; border-radius:3px; cursor:pointer; font-size:11px; font-weight:600;">💾 Create draft</button>';
    content +=   '<button type="button" onclick="discardCard(\\'' + cardId + '\\')" style="background:#eee; color:#666; padding:6px 12px; border:none; border-radius:3px; cursor:pointer; font-size:11px;">Discard</button>';
    content += '</div>';
  } else if (c.status === "created") {
    content += '<div style="background:#e8f5e9; color:#2e7d32; padding:8px; border-radius:3px; font-size:12px;">';
    content +=   '<strong>Draft created!</strong> ' + (c.extraction?.client_name ? escapeHTMLLocal2(c.extraction.client_name) : "");
    content += '</div>';
    content += '<a href="/admin/hearing/notes/' + c.noteId + '" target="_blank" style="display:inline-block; margin-top:8px; background:#0C1C36; color:white; padding:6px 12px; text-decoration:none; border-radius:3px; font-size:11px; font-weight:600;">Open to edit →</a>';
  } else if (c.status === "discarded") {
    content += '<div style="color:#888; font-size:12px; font-style:italic;">Discarded</div>';
  } else {
    // uploading / extracting / queued
    content += '<div style="text-align:center; padding:20px 0; color:#888;">';
    content += '<div style="font-size:24px;">' + s.emoji + '</div>';
    content += '<div style="font-size:12px; margin-top:6px;">' + s.text + '</div>';
    content += '</div>';
  }
  card.innerHTML = content;
}

function escapeHTMLLocal2(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function updateProgress() {
  const total = cards.size;
  const done = Array.from(cards.values()).filter(c => c.status === "ready" || c.status === "error" || c.status === "created" || c.status === "discarded").length;
  const readyCount = Array.from(cards.values()).filter(c => c.status === "ready").length;
  const errorCount = Array.from(cards.values()).filter(c => c.status === "error").length;
  const createdCount = Array.from(cards.values()).filter(c => c.status === "created").length;
  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById("bulk-progress-fill").style.width = pct + "%";
  document.getElementById("bulk-progress-count").textContent = done + " of " + total + (errorCount ? "  (" + errorCount + " errors)" : "");
  document.getElementById("bulk-progress-label").textContent = done < total ? "Processing…" : "All processed";
  document.getElementById("bulk-ready-count").textContent = readyCount + " ready · " + createdCount + " created";
  document.getElementById("bulk-create-all-btn").disabled = readyCount === 0;
  document.getElementById("bulk-create-all-btn").style.opacity = readyCount === 0 ? "0.5" : "1";
}

async function createDraft(cardId) {
  const c = cards.get(cardId);
  if (!c || c.status !== "ready" || !c.extraction) return;
  c.status = "creating";
  renderCard(cardId);
  try {
    const resp = await fetch("/admin/hearing/notes/create-from-extraction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extraction: c.extraction, raw: c.raw }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "Failed to create draft");
    c.noteId = data.note_id;
    c.status = "created";
  } catch (e) {
    c.status = "error";
    c.error = e.message;
  }
  renderCard(cardId);
  updateProgress();
}

async function createAllAsDrafts() {
  const readyCards = Array.from(cards.entries()).filter(([, c]) => c.status === "ready");
  if (!readyCards.length) return;
  if (!confirm("Create " + readyCards.length + " draft hearing note" + (readyCards.length === 1 ? "" : "s") + "?")) return;
  // Fire off in parallel, small concurrency
  const chunks = [];
  for (let i = 0; i < readyCards.length; i += 3) chunks.push(readyCards.slice(i, i + 3));
  for (const chunk of chunks) {
    await Promise.all(chunk.map(([cardId]) => createDraft(cardId)));
  }
  updateProgress();
}

function retryCard(cardId) {
  const c = cards.get(cardId);
  if (!c) return;
  c.status = "queued";
  c.error = null;
  renderCard(cardId);
  queue.push(cardId);
  processQueue();
  updateProgress();
}

function discardCard(cardId) {
  const c = cards.get(cardId);
  if (!c) return;
  c.status = "discarded";
  renderCard(cardId);
  updateProgress();
}

function discardAllPending() {
  if (!confirm("Discard all extractions that haven't been saved as drafts?")) return;
  cards.forEach((c, cardId) => {
    if (c.status === "ready" || c.status === "error") discardCard(cardId);
  });
}
</script>`;

  return renderAdminChrome({ title: "Bulk Upload Hearing Notes", body, activeItem: "notes" });
}


module.exports = {
  initHearingNotesTables,
  initRevisionTable,
  saveNote,
  updateNote,
  findExistingNote,
  saveRevision,
  getRevisions,
  generateAndSaveSummariesForMaster,
  listNotes,
  getNote,
  deleteNote,
  getMostRecentForClient,
  getHearingSequenceInfo,
  sendToParalegal,
  generateParalegalSummary,
  generateClientSummary,
  extractDocumentFields,
  extractI589FieldsFromPdf,
  renderNoteForm,
  renderAdminChrome,
  renderHistoryPage,
  renderDetailPage,
  renderBulkUploadPage,
  renderDuplicatesPage,
  findDuplicates,
  mergeDuplicates,
  parseFormSubmission,
  APPLICATION_OPTIONS,
};
