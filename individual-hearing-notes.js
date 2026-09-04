// ============================================================
//  TEZ LAW P.C. — INDIVIDUAL HEARING NOTES
//  ─────────────────────────────────────────────────────────
//  Prep + note-taking tool for INDIVIDUAL / MERITS hearings.
//
//  Workflow:
//    1. JJ opens form at /admin/hearing/individual
//    2. Enters client name/A# and clicks "Load from prior hearing" to
//       auto-fill client info from the most recent master hearing
//    3. Uploads Excel exhibit list — parsed and shown as editable table
//    4. Uploads hearing summary (PDF/text) — Claude extracts Q&A pairs
//       for the examination section and closing argument
//    5. Fills in objections, pre-exam notes, witness examinations
//    6. Saves — everything is editable through the actual hearing
//    7. After hearing, revises, generates paralegal + client summaries,
//       sends to team group via Telegram
//
//  Sections:
//    - Client / Case / Court info (pre-filled from master hearing)
//    - Court address
//    - Exhibit list (from Excel upload)
//    - Objections on evidence
//    - Pre-examination notes
//    - Witness examinations (Q / A / Judge notes columns)
//    - Closing oral argument
// ============================================================

const axios = require("axios");
const db = require("./db");
const XLSX = require("xlsx");
const hearingNotes = require("./hearing-notes");

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
// Both PDF and text extraction now use Haiku 4.5. It's ~5x cheaper than Sonnet
// and handles structured JSON extraction fine. If accuracy issues surface on
// specific unusual documents, we can add per-call opt-in to Sonnet.
const EXTRACT_MODEL      = "claude-haiku-4-5-20251001";
const TEXT_EXTRACT_MODEL = "claude-haiku-4-5-20251001";

// Max file size for individual hearing note upload
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;  // 6MB

// ── Schema ───────────────────────────────────────────────

async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS individual_hearing_notes (
      id                    SERIAL PRIMARY KEY,
      client_name           TEXT NOT NULL,
      a_number              TEXT,
      client_language       TEXT DEFAULT 'en',
      client_email          TEXT,
      client_phone          TEXT,
      client_address        TEXT,
      case_type             TEXT,
      hearing_date          TIMESTAMPTZ,
      judge_name            TEXT,
      court_location        TEXT,
      court_address         TEXT,
      dhs_attorney          TEXT,
      attorney_appearance   TEXT,
      respondent_appearance TEXT,
      exhibits              JSONB DEFAULT '[]'::jsonb,
      evidence_objections   TEXT,
      pre_examination_notes TEXT,
      examinations          JSONB DEFAULT '[]'::jsonb,
      closing_argument      TEXT,
      disposition           TEXT,
      disposition_notes     TEXT,
      next_hearing_date     TIMESTAMPTZ,
      next_hearing_type     TEXT,
      next_action_deadline  DATE,
      hearing_summary_raw   TEXT,
      paralegal_summary     TEXT,
      client_summary        TEXT,
      sent_to_paralegal_at  TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrations for existing installations (safe no-op if columns exist)
  const alters = [
    "ADD COLUMN IF NOT EXISTS attorney_appearance TEXT",
    "ADD COLUMN IF NOT EXISTS respondent_appearance TEXT",
    "ADD COLUMN IF NOT EXISTS next_hearing_date TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS next_hearing_type TEXT",
    "ADD COLUMN IF NOT EXISTS client_address TEXT",
    "ADD COLUMN IF NOT EXISTS continuation_of INTEGER",
    "ADD COLUMN IF NOT EXISTS continuation_number INTEGER",
  ];
  for (const alter of alters) {
    try { await db.query(`ALTER TABLE individual_hearing_notes ${alter}`); }
    catch (e) { /* column may already exist on older PG or race — ignore */ }
  }
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_individual_hearing_notes_created
      ON individual_hearing_notes (created_at DESC)
  `);
}

// ── Excel Parsing ────────────────────────────────────────

// Accept an .xlsx or .csv buffer, return an array of exhibit objects.
// Uses first sheet, first row as headers.
function parseExhibitExcel(buffer, filename = "exhibits.xlsx") {
  if (!buffer || !buffer.length) {
    throw new Error(`File is empty or unreadable (0 bytes).`);
  }

  let workbook;
  try {
    // dateNF prevents SheetJS from choking on unusual date formats in cells
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, cellText: false });
  } catch (e) {
    throw new Error(
      `Could not parse "${filename}" as Excel/CSV: ${e.message}. ` +
      `The file may be corrupted, password-protected, or in an unsupported format (e.g. Numbers, old .xls). ` +
      `Try re-saving as .xlsx or .csv from Excel and re-uploading.`
    );
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("No sheets found in file.");
  const sheet = workbook.Sheets[firstSheetName];

  let rows;
  try {
    // header:1 returns array of arrays; raw:true skips number/date formatting
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true, blankrows: false });
  } catch (e) {
    throw new Error(
      `Could not read cells from sheet "${firstSheetName}": ${e.message}. ` +
      `Try selecting/copying the exhibit list to a new blank Excel and uploading that.`
    );
  }
  if (!rows.length) return { exhibits: [], sheet_name: firstSheetName, raw_rows: [] };

  // Detect header row: use the first row that has more than 1 non-empty cell
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const nonEmpty = rows[i].filter(c => String(c).trim()).length;
    if (nonEmpty >= 2) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map(h => String(h == null ? "" : h).trim().toLowerCase());
  const dataRows = rows.slice(headerIdx + 1).filter(r => r.some(c => String(c == null ? "" : c).trim()));

  // Try to map common column names to standard fields.
  // - "number" is the list/row number (list #)
  // - "eoir_submission" is the EOIR filing reference (e.g. "EOR-1", "5/12/25 filing")
  //   Usually Column B on Tez Law's exhibit sheets, but we match by header first.
  const colIdx = {
    number:           findCol(headers, ["#", "no.", "no ", "list", "item", "number", "tab"]),
    eoir_submission:  findCol(headers, ["eoir", "eoir submission", "eor submission", "submission", "filing", "eor"]),
    description:      findCol(headers, ["description", "desc", "document", "title", "name"]),
    offered_by:       findCol(headers, ["offered by", "party", "proponent", "offered", "by"]),
    marked:           findCol(headers, ["marked", "identified", "id'd"]),
    admitted:         findCol(headers, ["admitted", "received", "admit"]),
    objection:        findCol(headers, ["objection", "objections", "notes", "note"]),
    bates:            findCol(headers, ["bates", "bates #", "pages"]),
  };

  // Fallback: if EOIR wasn't matched by header but a column B exists, use it
  if (colIdx.eoir_submission < 0 && headers.length >= 2 && headers[1]) {
    // Only use column B if header wasn't already claimed as something else
    const claimed = new Set(Object.values(colIdx).filter(v => v >= 0));
    if (!claimed.has(1)) colIdx.eoir_submission = 1;
  }

  const safeCell = (val) => {
    if (val == null) return "";
    if (val instanceof Date) return val.toLocaleDateString();
    return String(val).trim();
  };

  const exhibits = dataRows.map((r, i) => ({
    number:           colIdx.number           >= 0 ? safeCell(r[colIdx.number])           : String(i + 1),
    eoir_submission:  colIdx.eoir_submission  >= 0 ? safeCell(r[colIdx.eoir_submission])  : "",
    description:      colIdx.description      >= 0 ? safeCell(r[colIdx.description])      : (r.filter(c => String(c == null ? "" : c).trim()).map(safeCell).join(" ").trim() || ""),
    offered_by:       colIdx.offered_by       >= 0 ? safeCell(r[colIdx.offered_by])       : "",
    marked:           colIdx.marked           >= 0 ? safeCell(r[colIdx.marked])           : "",
    admitted:         colIdx.admitted         >= 0 ? safeCell(r[colIdx.admitted])         : "",
    not_admitted:     "",  // new checkbox — inverted semantics; user checks only when NOT admitted
    objection:        colIdx.objection        >= 0 ? safeCell(r[colIdx.objection])        : "",
    bates:            colIdx.bates            >= 0 ? safeCell(r[colIdx.bates])            : "",
  })).filter(e => e.description || e.number || e.eoir_submission);

  return { exhibits, sheet_name: firstSheetName, raw_rows: rows.slice(0, 5) };
}

function findCol(headers, keywords) {
  for (const kw of keywords) {
    const idx = headers.findIndex(h => h && h.includes(kw));
    if (idx >= 0) return idx;
  }
  return -1;
}

// ── Hearing Summary Extraction ──────────────────────────

// Accept PDF or plain text, ask Claude to extract structured
// examination Q&A pairs, witness list, and closing argument.
async function extractHearingSummary({ pdfBuffer, textContent, mimeType, filename = "summary" }) {
  // Reject oversized files upfront - large merits packets should be split
  if (pdfBuffer && pdfBuffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${Math.round(pdfBuffer.length / 1024 / 1024 * 10) / 10}MB > 6MB limit). ` +
      `Merits hearing summaries should be under 6MB. Split into witness-testimony half + closing-argument half.`
    );
  }
  const prompt = `You are analyzing an immigration attorney's hearing summary / prep outline for an individual (merits) hearing. The document may contain:
- Case caption (client name, A-Number, court, judge, hearing date at the top)
- Notes about the case background
- Direct examination questions for the applicant/witnesses
- Anticipated cross-examination
- Redirect
- Judge questions the attorney expects
- Closing argument bullets or full text
- Or any combination of the above

Your job: extract as much structured content as possible. Return ONLY valid JSON (no preamble, no code fences) with this structure:

{
  "client_info": {
    "client_name": "Full name of the respondent/applicant if named in doc, else empty string. Prefer 'Last, First' format if that's how it appears.",
    "a_number": "A-Number if given (with or without dashes), else empty string",
    "client_email": "Client email address if listed anywhere in the doc, else empty string",
    "client_phone": "Client phone number if listed anywhere in the doc, else empty string",
    "client_address": "Client's mailing address if listed anywhere in the doc (may be in caption, contact block, or biographical info), else empty string. Include street, city, state, ZIP.",
    "hearing_date": "Hearing date and time in ISO format YYYY-MM-DDTHH:MM if found (guess time if not stated). Empty string if not in doc.",
    "judge_name": "Immigration judge name if given, else empty string. Include honorific if present (e.g. 'Hon. Kevin Riley').",
    "court_location": "Court short name if given (e.g. 'Los Angeles Immigration Court'), else empty string",
    "court_address": "Full street address of the court if given ANYWHERE in the doc (may appear in caption, header, notice attachments, or after judge/court name), else empty string. Include street, city, state, ZIP.",
    "dhs_attorney": "DHS trial attorney name if given, else empty string",
    "case_type": "Type of case if identifiable — e.g. 'Asylum (I-589)', 'Withholding of Removal', 'CAT protection', 'Cancellation of Removal'. Empty string if unclear.",
    "attorney_appearance": "How the attorney is appearing: 'In person', 'WebEx', 'Telephone', or empty if not stated",
    "respondent_appearance": "How the respondent is appearing: 'In person', 'WebEx', 'Telephone', or empty if not stated"
  },
  "case_summary": "Brief 1-2 sentence description of the case (from any narrative context in the doc)",
  "witnesses": [
    {
      "name": "Witness name (or empty if not named)",
      "role": "Respondent | Spouse | Additional witness"
    }
  ],
  "examinations": [
    {
      "witness_role": "Respondent | Spouse | Additional witness",
      "witness_name": "Witness name if given, else empty string",
      "examination_type": "direct/cross/redirect (best guess)",
      "sections": [
        {
          "title": "Section title (e.g. 'Background', 'Life in China', 'Persecution events', 'Fear of return', 'Country conditions'). Identify natural thematic sections from the doc's structure — headings, spacing, topic shifts.",
          "qa_rows": [
            {
              "question": "The question the attorney will ask (verbatim or best paraphrase)",
              "expected_answer": "Expected/prepared answer if noted, else empty string",
              "judge_notes": ""
            }
          ]
        }
      ]
    }
  ],
  "closing_argument": "Closing argument text - preserve headings/structure with newlines"
}

Rules:
- Return ONLY the JSON object.
- Look CAREFULLY at the first page/section of the doc for the case caption — that's where client name, A-Number, judge, hearing date are usually listed. Do not skip this.
- Extract questions in ORDER as they appear.
- Break each witness's examination into THEMATIC SECTIONS based on the doc's structure. Common sections for direct exam: Background, Life in home country, Persecution events, Coming to the US, Fear of return, Country conditions. Look for headers, bold text, or topic shifts in the doc. If the doc has no obvious sections, use one section titled "Testimony" with all rows.
- If a question has a paired anticipated answer in the doc, put it in expected_answer. Otherwise leave empty.
- judge_notes stays empty — the attorney fills that in DURING the hearing.
- witness_role must be one of exactly: "Respondent" (the applicant themselves), "Spouse" (respondent's spouse), or "Additional witness" (experts, country conditions witnesses, family members other than spouse, etc.). Default to "Respondent" if unclear.
- If it's unclear whether something is direct vs cross, guess based on tone (softball → direct, adversarial → cross).
- If the doc has only closing argument, still return the JSON structure with empty examinations array.
- If the doc has only exam Q's, return with empty closing_argument string.
- Do not invent content. Empty strings and empty structures are fine.`;

  const isTextMode = !pdfBuffer && !!textContent;
  const messages = [];
  if (pdfBuffer && mimeType && mimeType.includes("pdf")) {
    messages.push({
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBuffer.toString("base64") } },
        { type: "text", text: prompt },
      ],
    });
  } else if (textContent) {
    // Clean up mammoth-extracted text: collapse whitespace, remove tab/space
    // sequences that add noise without meaning. Preserves paragraph breaks.
    const cleanedText = String(textContent)
      .replace(/[ \t]+/g, " ")            // collapse runs of tabs/spaces
      .replace(/\n{3,}/g, "\n\n")         // collapse 3+ newlines to 2
      .replace(/^\s+|\s+$/gm, "")         // trim each line
      .trim();
    messages.push({
      role: "user",
      content: `${prompt}\n\n=== HEARING SUMMARY DOCUMENT ===\n\n${cleanedText}`,
    });
  } else {
    throw new Error("Provide either pdfBuffer (with mimeType) or textContent.");
  }

  // Model selection: PDF uses Sonnet (needs vision reasoning). Plain text uses
  // Haiku 4.5 which is 5-10x faster and plenty capable for structured extraction
  // from already-plain text. This was blowing the 3-min timeout with Sonnet.
  const modelForCall = isTextMode ? TEXT_EXTRACT_MODEL : EXTRACT_MODEL;
  const startedAt = Date.now();

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    // 16000 tokens ≈ 12000 words — enough for a comprehensive merits hearing prep doc
    // (multiple witnesses, extensive Q&A, full closing argument). 4000 was truncating.
    { model: modelForCall, max_tokens: 16000, messages },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      // 5-minute timeout as safety net; Haiku typically finishes in 20-40 seconds.
      timeout: 300000,
    }
  );
  const elapsedMs = Date.now() - startedAt;
  console.log(`[extract-summary] ${modelForCall} completed in ${elapsedMs}ms (${(elapsedMs / 1000).toFixed(1)}s)`);

  const text = resp.data.content?.[0]?.text?.trim() || "{}";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const stopReason = resp.data.stop_reason;
  let extracted;
  try {
    extracted = JSON.parse(cleaned);
  } catch (e) {
    const truncatedNote = stopReason === "max_tokens"
      ? " (Claude's response was TRUNCATED — hit token limit. Try splitting the doc into a witness-testimony half and a closing-argument half, then upload separately.)"
      : "";
    throw new Error(
      `Extracted text from your document, but Claude's structured response wasn't valid JSON` +
      `${truncatedNote}. Response length: ${cleaned.length} chars. Stop reason: ${stopReason || "unknown"}. ` +
      `You can still see the raw extracted text at the bottom of the form and paste sections manually.`
    );
  }

  // Normalize structure - ensure arrays exist
  extracted.client_info = extracted.client_info || {};
  extracted.client_info = {
    client_name:           extracted.client_info.client_name           || "",
    a_number:              extracted.client_info.a_number              || "",
    client_email:          extracted.client_info.client_email          || "",
    client_phone:          extracted.client_info.client_phone          || "",
    client_address:        extracted.client_info.client_address        || "",
    hearing_date:          extracted.client_info.hearing_date          || "",
    judge_name:            extracted.client_info.judge_name            || "",
    court_location:        extracted.client_info.court_location        || "",
    court_address:         extracted.client_info.court_address         || "",
    dhs_attorney:          extracted.client_info.dhs_attorney          || "",
    case_type:             extracted.client_info.case_type             || "",
    attorney_appearance:   extracted.client_info.attorney_appearance   || "",
    respondent_appearance: extracted.client_info.respondent_appearance || "",
  };
  extracted.witnesses = extracted.witnesses || [];
  extracted.examinations = (extracted.examinations || []).map(ex => {
    // Support both new schema (witness_role + witness_name) and legacy (witness)
    const witness_role = ex.witness_role || "Respondent";
    const witness_name = ex.witness_name || ex.witness || "";

    // Normalize sections: prefer new `sections` schema, fall back to old `qa_rows`.
    // Old records with flat qa_rows are wrapped in a single unnamed section.
    let sections;
    if (Array.isArray(ex.sections) && ex.sections.length) {
      sections = ex.sections.map(s => ({
        title: s.title || "Testimony",
        qa_rows: (s.qa_rows || []).map(qa => ({
          question: qa.question || "",
          expected_answer: qa.expected_answer || "",
          judge_notes: qa.judge_notes || "",
        })),
      }));
    } else if (Array.isArray(ex.qa_rows) && ex.qa_rows.length) {
      sections = [{
        title: "Testimony",
        qa_rows: ex.qa_rows.map(qa => ({
          question: qa.question || "",
          expected_answer: qa.expected_answer || "",
          judge_notes: qa.judge_notes || "",
        })),
      }];
    } else {
      sections = [{ title: "Testimony", qa_rows: [] }];
    }

    return {
      witness_role,
      witness_name,
      witness: witness_name ? `${witness_role} (${witness_name})` : witness_role,
      examination_type: ex.examination_type || "direct",
      sections,
      // Keep qa_rows flat too for backward compat with downstream code
      qa_rows: sections.flatMap(s => s.qa_rows),
    };
  });
  extracted.closing_argument = extracted.closing_argument || "";
  extracted.case_summary = extracted.case_summary || "";
  return extracted;
}

// ── AI Summary Generation ────────────────────────────────

async function generateParalegalSummary(data) {
  const structured = buildStructuredForAISummary(data);

  const prompt = `You are producing a SHORT, scannable individual hearing recap for the Tez Law team.

Keep it MINIMAL. This is a case-file update — the paralegal already has access to the full note with all witness testimony and closing argument, so DO NOT reproduce those. Just the essentials.

Include ONLY these sections (skip any that have no info):

1. **Case info** — one line each: client name, A#, case type, hearing date, judge, court, appearance method
2. **Exhibits** — brief count + note any that were NOT admitted (specify which and why)
3. **Pre-hearing notes** (if any — quote briefly)
4. **Disposition** + disposition notes
5. **Next hearing** (date + type) if scheduled
6. **Action items** — short bullet list of follow-up tasks

RULES:
- Total length: aim for under 300 words. Punchy, scannable, no filler.
- No witness testimony summaries. No closing argument content. Those are in the full note.
- Use clean structure with short bold section headers.
- Preserve specific dates, exhibit numbers, and deadlines exactly.
- Do NOT invent info. If a section has no data, skip it entirely.

Hearing data:
${structured}

Produce the recap now. Start directly — no preamble.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: ANTHROPIC_MODEL, max_tokens: 1200, messages: [{ role: "user", content: prompt }] },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );
    return resp.data.content?.[0]?.text?.trim() || "(summary generation failed)";
  } catch (e) {
    console.error("[individual-hearing] Paralegal summary error:", e.message);
    return `AI cleanup unavailable. Structured notes:\n\n${structured}`;
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
  const structured = buildStructuredForAISummary(data);

  const prompt = `You are writing a SHORT client-facing note about an immigration individual (merits) hearing, in ${languageName}.

Keep it BRIEF and reassuring. This isn't a detailed hearing recap — just enough for the client to know what happened and what to do next.

Structure (skip any sections with no info):

1. Brief greeting acknowledging the hearing took place (date, judge)
2. Basic info: what type of hearing it was, exhibits filed (count only)
3. What happened at the hearing (1-2 short sentences — did they testify? Was there a decision?)
4. What comes next: any next hearing date/type, any deadlines
5. Contact info + sign-off

RULES:
- Write ENTIRELY in ${languageName}
- Plain, warm language — no legalese
- Total length: aim for under 200 words. Short is better than long.
- Do NOT walk through witness testimony or closing argument details
- Do NOT quote exhibits by title — just note the count
- Address the client directly ("You" / "您" / "Usted" / "आप" / "ਤੁਸੀਂ")
- End with: "If you have any questions, please contact us at 626-678-8677 or info@tezlawfirm.com" (translated)
- Sign off with "Sincerely, TEZ LAW FIRM" (translate "Sincerely" but keep TEZ LAW FIRM as the firm name; for Chinese use "TEZ律师事务所"). Do NOT use any personal attorney name.
- Do NOT invent information

Client name: ${data.client_name}

Hearing data (in English — translate meaningful parts to ${languageName}):
${structured}

Produce the client note in ${languageName} now. Start directly with the greeting.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: ANTHROPIC_MODEL, max_tokens: 1200, messages: [{ role: "user", content: prompt }] },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );
    return resp.data.content?.[0]?.text?.trim() || "(summary generation failed)";
  } catch (e) {
    console.error("[individual-hearing] Client summary error:", e.message);
    return "(AI summary unavailable — please write manually)";
  }
}

function buildStructuredForAI(data) {
  return buildStructuredInternal(data, { minimal: false });
}

// Minimal structured data — for summary generation. Excludes witness Q&A
// and full closing argument. Only what's needed for a concise recap:
// basic info + exhibits + pre/post-hearing notes + disposition.
function buildStructuredForAISummary(data) {
  return buildStructuredInternal(data, { minimal: true });
}

function buildStructuredInternal(data, { minimal }) {
  const lines = [
    `Client: ${data.client_name || "(not provided)"}`,
    `A-Number: ${data.a_number || "(not provided)"}`,
    `Client language: ${data.client_language || "en"}`,
    `Case type: ${data.case_type || "(not specified)"}`,
    `Hearing date: ${data.hearing_date ? new Date(data.hearing_date).toLocaleString() : "(not provided)"}`,
    `Judge: ${data.judge_name || "(not noted)"}`,
    `Court: ${data.court_location || "(not noted)"}`,
  ];
  if (!minimal) {
    lines.push(`Court address: ${data.court_address || "(not noted)"}`);
  }
  lines.push(`DHS Trial Attorney: ${data.dhs_attorney || "(not noted)"}`);
  if (data.attorney_appearance || data.respondent_appearance) {
    lines.push(`Attorney appearance: ${data.attorney_appearance || "(not noted)"}`);
    lines.push(`Respondent appearance: ${data.respondent_appearance || "(not noted)"}`);
  }
  lines.push("");

  // Exhibits (always included, both minimal and detailed)
  const exhibits = data.exhibits || [];
  if (exhibits.length) {
    lines.push(`EXHIBITS (${exhibits.length} total):`);
    for (const e of exhibits) {
      const parts = [`#${e.number || "?"}`, e.description || "(no description)"];
      const flags = [];
      if (e.eoir_submission) flags.push(`EOIR: ${e.eoir_submission}`);
      if (e.marked)     flags.push(`marked as #${e.marked}`);
      if (e.not_admitted) flags.push("NOT ADMITTED");
      else flags.push("admitted");
      if (e.objection)  flags.push(`objection: ${e.objection}`);
      lines.push(`  - ${parts.join(": ")}${flags.length ? " [" + flags.join("; ") + "]" : ""}`);
    }
    lines.push("");
  } else {
    lines.push("EXHIBITS: (none)");
    lines.push("");
  }

  if (data.pre_examination_notes) {
    lines.push("PRE-HEARING NOTES:");
    lines.push(data.pre_examination_notes);
    lines.push("");
  }

  // In minimal mode, skip the detailed examinations Q&A and full closing argument.
  // Just note that they occurred so the summary can reference them.
  if (minimal) {
    const exams = data.examinations || [];
    if (exams.length) {
      lines.push("WITNESSES EXAMINED:");
      for (const ex of exams) {
        const role = ex.witness_role || "Respondent";
        const name = ex.witness_name || "";
        const witnessDisplay = name ? `${role} (${name})` : role;
        const rowCount = (ex.sections || []).reduce((sum, s) => sum + (s.qa_rows || []).length, 0)
          || (ex.qa_rows || []).length;
        lines.push(`  - ${witnessDisplay} — ${ex.examination_type || "examination"} (${rowCount} Q&A rows)`);
      }
      lines.push("");
    }
    if (data.closing_argument) {
      lines.push("CLOSING ARGUMENT: (delivered — see individual hearing note for full text)");
      lines.push("");
    }
  } else {
    // Full detail mode — used for direct display, not summary generation
    const exams = data.examinations || [];
    if (exams.length) {
      lines.push(`WITNESS EXAMINATIONS (${exams.length}):`);
      for (const ex of exams) {
        const role = ex.witness_role || "";
        const name = ex.witness_name || "";
        let witnessDisplay;
        if (role && name) witnessDisplay = `${role}: ${name}`;
        else if (name) witnessDisplay = name;
        else if (role) witnessDisplay = role;
        else witnessDisplay = ex.witness || "(unnamed witness)";
        lines.push(`\n${witnessDisplay} — ${ex.examination_type || "examination"}`);
        const rows = (ex.qa_rows || []).filter(r => r.question || r.expected_answer || r.judge_notes);
        if (rows.length) {
          for (const r of rows) {
            if (r.question) lines.push(`  Q: ${r.question}`);
            if (r.expected_answer) lines.push(`  A: ${r.expected_answer}`);
            if (r.judge_notes) lines.push(`  [Judge/Notes]: ${r.judge_notes}`);
            lines.push("");
          }
        } else {
          lines.push("  (no Q&A recorded)");
        }
      }
    } else {
      lines.push("WITNESS EXAMINATIONS: (none recorded)");
    }
    lines.push("");

    if (data.closing_argument) {
      lines.push("CLOSING ORAL ARGUMENT:");
      lines.push(data.closing_argument);
      lines.push("");
    }
  }

  if (data.disposition) {
    lines.push("DISPOSITION:");
    lines.push(`  ${data.disposition}`);
    if (data.disposition_notes) lines.push(`  Notes: ${data.disposition_notes}`);
    lines.push("");
  }

  if (data.next_hearing_date || data.next_hearing_type) {
    lines.push(`NEXT HEARING: ${data.next_hearing_type || "(type not noted)"} on ${data.next_hearing_date ? new Date(data.next_hearing_date).toLocaleString() : "(date not set)"}`);
  }
  if (data.next_action_deadline) {
    lines.push(`NEXT ACTION DEADLINE: ${data.next_action_deadline}`);
  }

  return lines.join("\n");
}

// ── Save summaries separately ─────────────────────────────

async function saveSummaries(id, paralegal_summary, client_summary) {
  await initTables();
  await db.query(
    `UPDATE individual_hearing_notes
     SET paralegal_summary = $1, client_summary = $2, updated_at = NOW()
     WHERE id = $3`,
    [paralegal_summary, client_summary, id]
  );
}

// Generate both summaries for a saved note
async function generateAndSaveSummaries(id) {
  const note = await getIndividualNote(id);
  if (!note) throw new Error(`Note ${id} not found`);
  const [p, c] = await Promise.all([
    generateParalegalSummary(note),
    generateClientSummary(note),
  ]);
  await saveSummaries(id, p, c);
  return { paralegal_summary: p, client_summary: c };
}

// ── Send To Team Group ────────────────────────────────────

async function sendToTeamGroup(id) {
  const note = await getIndividualNote(id);
  if (!note) throw new Error(`Note ${id} not found`);
  if (!note.paralegal_summary) throw new Error("No paralegal summary generated yet. Click Generate Summaries first.");

  const rawRecipient =
    process.env.HEARING_NOTES_TELEGRAM_GROUP_ID ||
    process.env.HEARING_NOTES_TELEGRAM_ID ||
    process.env.RECIPIENT_JUE_TELEGRAM_ID ||
    process.env.RECIPIENT_JUE_TELEGRAM;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!rawRecipient || !telegramToken) {
    throw new Error("Telegram not configured. Set HEARING_NOTES_TELEGRAM_GROUP_ID env var.");
  }

  let chatId = null;
  const trimmed = String(rawRecipient).trim();
  if (/^-?\d+$/.test(trimmed)) {
    chatId = trimmed;
  } else {
    const withAt = trimmed.startsWith("@") ? trimmed : "@" + trimmed;
    try {
      const resp = await axios.get(
        `https://api.telegram.org/bot${telegramToken}/getChat`,
        { params: { chat_id: withAt }, timeout: 10000 }
      );
      if (resp.data && resp.data.ok && resp.data.result?.id) chatId = String(resp.data.result.id);
    } catch (e) {
      const detail = e.response?.data?.description || e.message;
      throw new Error(`Could not resolve Telegram target ${withAt}: ${detail}`);
    }
    if (!chatId) throw new Error(`Could not resolve Telegram target ${withAt}`);
  }

  const header = `⚖️ *Individual Hearing Notes — ${note.client_name}*\nA#: ${note.a_number || "(none)"}\nHearing: ${note.hearing_date ? new Date(note.hearing_date).toLocaleDateString() : "(not set)"}\nJudge: ${note.judge_name || "(not noted)"}\n\n`;
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
        { chat_id: chatId, text: chunk, parse_mode: "Markdown" },
        { timeout: 15000 }
      );
    } catch (e) {
      const detail = e.response?.data?.description || e.message;
      const hint = detail.includes("chat not found") ? " (Make sure @TEZJJBot is in the group.)" : "";
      throw new Error(`Telegram send failed: ${detail}.${hint}`);
    }
  }

  await db.query(
    `UPDATE individual_hearing_notes SET sent_to_paralegal_at = NOW() WHERE id = $1`,
    [id]
  );
  return { sent: true, chunks: chunks.length };
}

// ── Storage ──────────────────────────────────────────────

async function saveIndividualNote(data, id = null) {
  await initTables();
  if (id) {
    const r = await db.query(
      `UPDATE individual_hearing_notes SET
         client_name=$1, a_number=$2, client_language=$3, client_email=$4, client_phone=$5,
         case_type=$6, hearing_date=$7, judge_name=$8, court_location=$9, court_address=$10,
         dhs_attorney=$11, exhibits=$12::jsonb, evidence_objections=$13, pre_examination_notes=$14,
         examinations=$15::jsonb, closing_argument=$16,
         disposition=$17, disposition_notes=$18, next_action_deadline=$19,
         hearing_summary_raw=$20,
         attorney_appearance=$22, respondent_appearance=$23,
         next_hearing_date=$24, next_hearing_type=$25,
         client_address=$26,
         updated_at=NOW()
       WHERE id=$21 RETURNING id`,
      [
        data.client_name, data.a_number || null, data.client_language || "en",
        data.client_email || null, data.client_phone || null,
        data.case_type || null, data.hearing_date || null,
        data.judge_name || null, data.court_location || null, data.court_address || null,
        data.dhs_attorney || null,
        JSON.stringify(data.exhibits || []),
        data.evidence_objections || null, data.pre_examination_notes || null,
        JSON.stringify(data.examinations || []),
        data.closing_argument || null,
        data.disposition || null, data.disposition_notes || null,
        data.next_action_deadline || null,
        data.hearing_summary_raw || null,
        id,
        data.attorney_appearance || null, data.respondent_appearance || null,
        data.next_hearing_date || null, data.next_hearing_type || null,
        data.client_address || null,
      ]
    );
    if (!r.rows[0]) throw new Error(`Individual hearing note ${id} not found`);
    try {
      const dt = require("./deadline-tracker");
      await dt.syncFromIndividualHearing(r.rows[0].id);
      await dt.syncMeritsEvidenceDeadline(r.rows[0].id);
    } catch (e) { console.warn("[individual-hearing-notes] deadline sync warning:", e.message); }
    return { id: r.rows[0].id, updated: true };
  }
  const r = await db.query(
    `INSERT INTO individual_hearing_notes
      (client_name, a_number, client_language, client_email, client_phone,
       case_type, hearing_date, judge_name, court_location, court_address,
       dhs_attorney, exhibits, evidence_objections, pre_examination_notes,
       examinations, closing_argument, disposition, disposition_notes,
       next_action_deadline, hearing_summary_raw,
       attorney_appearance, respondent_appearance,
       next_hearing_date, next_hearing_type, client_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,$25)
     RETURNING id`,
    [
      data.client_name, data.a_number || null, data.client_language || "en",
      data.client_email || null, data.client_phone || null,
      data.case_type || null, data.hearing_date || null,
      data.judge_name || null, data.court_location || null, data.court_address || null,
      data.dhs_attorney || null,
      JSON.stringify(data.exhibits || []),
      data.evidence_objections || null, data.pre_examination_notes || null,
      JSON.stringify(data.examinations || []),
      data.closing_argument || null,
      data.disposition || null, data.disposition_notes || null,
      data.next_action_deadline || null,
      data.hearing_summary_raw || null,
      data.attorney_appearance || null, data.respondent_appearance || null,
      data.next_hearing_date || null, data.next_hearing_type || null,
      data.client_address || null,
    ]
  );
  const newId = r.rows[0].id;
  try {
    const dt = require("./deadline-tracker");
    await dt.syncFromIndividualHearing(newId);
    await dt.syncMeritsEvidenceDeadline(newId);
  } catch (e) { console.warn("[individual-hearing-notes] deadline sync warning:", e.message); }
  return { id: newId, updated: false };
}

async function listIndividualNotes(limit = 50) {
  await initTables();
  const r = await db.query(
    `SELECT id, client_name, a_number, hearing_date, judge_name,
       client_language, sent_to_paralegal_at, created_at
     FROM individual_hearing_notes
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getIndividualNote(id) {
  await initTables();
  const r = await db.query(`SELECT * FROM individual_hearing_notes WHERE id = $1`, [id]);
  return r.rows[0];
}

async function deleteIndividualNote(id) {
  await initTables();
  const r = await db.query(
    `DELETE FROM individual_hearing_notes WHERE id = $1 RETURNING id, client_name`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Individual note ${id} not found`);
  return { id: r.rows[0].id, client_name: r.rows[0].client_name };
}

// Find all individual hearing notes for the same client (by A# preferred, name fallback).
// Returns array ordered by hearing_date ASC (or created_at). Used to render
// continuation tabs (1st Merits, 2nd Merits, 3rd Merits).
async function getIndividualNotesForClient({ clientName, aNumber }) {
  await initTables();
  const key = aNumber ? String(aNumber).toLowerCase().replace(/[-\s]/g, "") : null;
  const nameKey = clientName ? String(clientName).toLowerCase().trim() : null;
  if (!key && !nameKey) return [];

  const r = await db.query(
    `SELECT id, client_name, a_number, hearing_date, judge_name, disposition,
            continuation_of, continuation_number, created_at
     FROM individual_hearing_notes`
  );
  const matches = r.rows.filter(row => {
    if (key) {
      const rowKey = String(row.a_number || "").toLowerCase().replace(/[-\s]/g, "");
      if (rowKey && rowKey === key) return true;
    }
    if (nameKey) {
      const rowName = String(row.client_name || "").toLowerCase().trim();
      if (rowName === nameKey) return true;
    }
    return false;
  });
  matches.sort((a, b) => {
    const ad = a.hearing_date ? new Date(a.hearing_date).getTime() : new Date(a.created_at).getTime();
    const bd = b.hearing_date ? new Date(b.hearing_date).getTime() : new Date(b.created_at).getTime();
    return ad - bd;
  });
  return matches;
}

// ── Form parsing ─────────────────────────────────────────

function parseFormSubmission(body) {
  // Exhibits: submitted as indexed fields exhibit_number_0, exhibit_description_0, etc.
  // Marked and Admitted are now checkboxes — value is "yes" if checked, "" otherwise.
  // (Offered by and Bates fields removed from form; still stored empty for schema stability.)
  const exhibits = [];
  const exhibitKeys = Object.keys(body).filter(k => /^exhibit_number_\d+$/.test(k));
  const exhibitIndices = exhibitKeys.map(k => parseInt(k.split("_").pop(), 10)).sort((a, b) => a - b);
  for (const i of exhibitIndices) {
    // Marked is now a number (1-99), stored as its string form; empty = not marked yet.
    const markedRaw = String(body[`exhibit_marked_${i}`] || "").trim();
    const markedNum = markedRaw && !isNaN(Number(markedRaw))
      ? String(Math.max(1, Math.min(99, parseInt(markedRaw, 10))))
      : "";
    const row = {
      number:           (body[`exhibit_number_${i}`] || "").trim(),
      eoir_submission:  (body[`exhibit_eoir_submission_${i}`] || "").trim(),
      description:      (body[`exhibit_description_${i}`] || "").trim(),
      offered_by:       (body[`exhibit_offered_by_${i}`] || "").trim(),
      marked:           markedNum,
      // "Not admitted" checkbox — checked means exhibit was refused.
      // Default is admitted (empty not_admitted) since most get admitted.
      not_admitted:     body[`exhibit_not_admitted_${i}`] ? "yes" : "",
      // Legacy admitted field: retain for backward compat but not surfaced in new UI.
      admitted:         body[`exhibit_admitted_${i}`] ? "yes" : "",
      objection:        (body[`exhibit_objection_${i}`] || "").trim(),
      bates:            (body[`exhibit_bates_${i}`] || "").trim(),
      // Dropbox file path linked to this exhibit (assists file matching, no upload)
      dropbox_file_path: (body[`exhibit_dropbox_file_path_${i}`] || "").trim(),
    };
    if (row.number || row.description || row.eoir_submission || row.dropbox_file_path) exhibits.push(row);
  }

  // Examinations: nested — for each examination (exam_witness_role_N),
  // sections (exam_N_section_S_title), rows (exam_N_section_S_q_R).
  // Witness has separate role (dropdown) and name (text) fields; combined
  // into a display string in `witness` for backward compat with existing
  // renderers.
  const examinations = [];
  const examKeys = Object.keys(body).filter(k => /^exam_witness_role_\d+$/.test(k) || /^exam_witness_\d+$/.test(k));
  const examIndices = [...new Set(examKeys.map(k => parseInt(k.split("_").pop(), 10)))].sort((a, b) => a - b);
  for (const ei of examIndices) {
    const witnessRole = (body[`exam_witness_role_${ei}`] || "").trim();
    const witnessName = (body[`exam_witness_name_${ei}`] || body[`exam_witness_${ei}`] || "").trim();
    const witnessDisplay = witnessName
      ? (witnessRole ? `${witnessRole} (${witnessName})` : witnessName)
      : (witnessRole || "");
    const exType  = (body[`exam_type_${ei}`] || "").trim();

    // Discover sections for this examination
    const sectionTitleKeys = Object.keys(body).filter(k => new RegExp(`^exam_${ei}_section_\\d+_title$`).test(k));
    const sectionIndices = sectionTitleKeys.map(k => parseInt(k.match(/_section_(\d+)_/)[1], 10)).sort((a, b) => a - b);

    const sections = [];
    if (sectionIndices.length) {
      // New sections-based form
      for (const si of sectionIndices) {
        const title = (body[`exam_${ei}_section_${si}_title`] || "").trim();
        const qa_rows = [];
        const rowKeys = Object.keys(body).filter(k => new RegExp(`^exam_${ei}_section_${si}_q_\\d+$`).test(k));
        const rowIndices = rowKeys.map(k => parseInt(k.split("_").pop(), 10)).sort((a, b) => a - b);
        for (const ri of rowIndices) {
          const q = (body[`exam_${ei}_section_${si}_q_${ri}`] || "").trim();
          const a = (body[`exam_${ei}_section_${si}_a_${ri}`] || "").trim();
          const jn = (body[`exam_${ei}_section_${si}_jn_${ri}`] || "").trim();
          if (q || a || jn) qa_rows.push({ question: q, expected_answer: a, judge_notes: jn });
        }
        if (title || qa_rows.length) sections.push({ title: title || "Testimony", qa_rows });
      }
    } else {
      // Backward compat: old flat form
      const qa_rows = [];
      const rowKeys = Object.keys(body).filter(k => new RegExp(`^exam_${ei}_q_\\d+$`).test(k));
      const rowIndices = rowKeys.map(k => parseInt(k.split("_").pop(), 10)).sort((a, b) => a - b);
      for (const ri of rowIndices) {
        const q = (body[`exam_${ei}_q_${ri}`] || "").trim();
        const a = (body[`exam_${ei}_a_${ri}`] || "").trim();
        const jn = (body[`exam_${ei}_jn_${ri}`] || "").trim();
        if (q || a || jn) qa_rows.push({ question: q, expected_answer: a, judge_notes: jn });
      }
      if (qa_rows.length) sections.push({ title: "Testimony", qa_rows });
    }

    // Also compute flat qa_rows for downstream code that expects it
    const flatQaRows = sections.flatMap(s => s.qa_rows);

    if (witnessDisplay || exType || sections.length) {
      examinations.push({
        witness: witnessDisplay,
        witness_role: witnessRole,
        witness_name: witnessName,
        examination_type: exType,
        sections,
        qa_rows: flatQaRows,
      });
    }
  }

  return {
    client_name: (body.client_name || "").trim(),
    a_number: (body.a_number || "").trim() || null,
    client_language: body.client_language || "en",
    client_email: (body.client_email || "").trim() || null,
    client_phone: (body.client_phone || "").trim() || null,
    client_address: (body.client_address || "").trim() || null,
    case_type: (body.case_type || "").trim() || null,
    hearing_date: body.hearing_date || null,
    judge_name: (body.judge_name || "").trim() || null,
    court_location: (body.court_location || "").trim() || null,
    court_address: (body.court_address || "").trim() || null,
    dhs_attorney: (body.dhs_attorney || "").trim() || null,
    attorney_appearance: (body.attorney_appearance || "").trim() || null,
    respondent_appearance: (body.respondent_appearance || "").trim() || null,
    exhibits,
    evidence_objections: (body.evidence_objections || "").trim() || null,
    pre_examination_notes: (body.pre_examination_notes || "").trim() || null,
    examinations,
    closing_argument: (body.closing_argument || "").trim() || null,
    disposition: (body.disposition || "").trim() || null,
    disposition_notes: (body.disposition_notes || "").trim() || null,
    next_hearing_date: body.next_hearing_date || null,
    next_hearing_type: (body.next_hearing_type || "").trim() || null,
    next_action_deadline: body.next_action_deadline || null,
    hearing_summary_raw: (body.hearing_summary_raw || "").trim() || null,
  };
}

// ── HTML Form ────────────────────────────────────────────

function renderForm({ noteId = null, prev = {}, error = null, saved = false, siblings = [] } = {}) {
  const isEdit = !!noteId;

  const langOptions = [
    { v: "en", l: "English" },
    { v: "zh", l: "中文 (Chinese)" },
    { v: "es", l: "Español (Spanish)" },
    { v: "hi", l: "हिन्दी (Hindi)" },
    { v: "pa", l: "ਪੰਜਾਬੀ (Punjabi)" },
  ].map(o => `<option value="${o.v}" ${prev.client_language === o.v ? "selected" : ""}>${o.l}</option>`).join("");

  const exhibits = prev.exhibits || [];
  const examinations = prev.examinations || [];

  // Continuation tabs — show only if this client has multiple individual hearings.
  // Each tab is a link to that hearing's edit page. "+ Add continuation" creates
  // a new note pre-filled with this hearing's client info.
  let tabsSection = "";
  if (siblings && siblings.length > 0) {
    const ordinal = (n) => {
      const s = ["th", "st", "nd", "rd"];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    const tabLinks = siblings.map((s, i) => {
      const label = `${ordinal(i + 1)} Merits`;
      const dateStr = s.hearing_date ? new Date(s.hearing_date).toLocaleDateString() : "(no date)";
      const isCurrent = s.id === noteId;
      const style = isCurrent
        ? "background:#B79C62; color:white; padding:8px 16px; border-radius:6px 6px 0 0; text-decoration:none; font-weight:600; border-bottom:3px solid #0C1C36;"
        : "background:#eee; color:#333; padding:8px 16px; border-radius:6px 6px 0 0; text-decoration:none;";
      return `<a href="/admin/hearing/individual/${s.id}" style="${style}">${label} <span style="font-size:11px; opacity:.85;">${dateStr}</span></a>`;
    }).join("");
    // + Add continuation button — copies client info from current note
    const addLink = isEdit
      ? `<a href="/admin/hearing/individual?copy_from=${noteId}" style="background:#fdf7f0; color:#B79C62; padding:8px 16px; border-radius:6px 6px 0 0; text-decoration:none; border:1px dashed #B79C62;">+ Add continuation</a>`
      : "";
    tabsSection = `
      <div style="margin:15px 0 -1px 0; display:flex; gap:4px; flex-wrap:wrap; align-items:end; border-bottom:1px solid #ddd; padding-bottom:0;">
        ${tabLinks}
        ${addLink}
      </div>`;
  } else if (isEdit) {
    // Show "+ Add continuation" even with no siblings yet (this note is the only one)
    tabsSection = `
      <div style="margin:15px 0 -1px 0; display:flex; gap:4px; flex-wrap:wrap; align-items:end; border-bottom:1px solid #ddd;">
        <span style="background:#B79C62; color:white; padding:8px 16px; border-radius:6px 6px 0 0; font-weight:600; border-bottom:3px solid #0C1C36;">1st Merits <span style="font-size:11px; opacity:.85;">${prev.hearing_date ? new Date(prev.hearing_date).toLocaleDateString() : "(no date)"}</span></span>
        <a href="/admin/hearing/individual?copy_from=${noteId}" style="background:#fdf7f0; color:#B79C62; padding:8px 16px; border-radius:6px 6px 0 0; text-decoration:none; border:1px dashed #B79C62;">+ Add continuation</a>
      </div>`;
  }

  const errorSection = error ? `
    <div style="background:#ffebee; padding:15px; border-left:4px solid #c00; margin:15px 0; border-radius:4px;">
      <strong>⚠️ ${escapeHtml(error)}</strong>
    </div>` : "";

  const savedSection = saved ? `
    <div style="background:#e8f5e9; padding:12px; border-left:4px solid #4CAF50; margin:15px 0; border-radius:4px;">
      ✅ Saved. Note ID: #${noteId}
    </div>` : "";

  // Continuation chain navigator — shows every hearing in this merits chain
  // with clickable pills. Appears on:
  //   - the ROOT hearing if it has any continuations (so you can jump to them)
  //   - any CONTINUATION so you can jump back to the root or sibling continuations
  let continuationBanner = "";
  if (isEdit && prev.id) {
    // Determine the chain root: if this is a continuation, its continuation_of is the root.
    // Otherwise, this note IS the root.
    const chainRootId = prev.continuation_of || prev.id;
    // Filter siblings down to members of this chain
    const chain = (siblings || [])
      .filter(s => s.id === chainRootId || s.continuation_of === chainRootId)
      .sort((a, b) => {
        // Root first (continuation_of is null), then by continuation_number
        if (!a.continuation_of && b.continuation_of) return -1;
        if (a.continuation_of && !b.continuation_of) return 1;
        return (a.continuation_number || 0) - (b.continuation_number || 0);
      });

    if (chain.length > 1) {
      // Render each chain member as a pill
      const pillsHtml = chain.map(c => {
        const isCurrent = c.id === prev.id;
        const isRoot = !c.continuation_of;
        const label = isRoot
          ? `1st Merits`
          : `Continuation #${c.continuation_number || "?"}`;
        const dateStr = c.hearing_date
          ? new Date(c.hearing_date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          : "no date";
        const bg = isCurrent ? "#7c4dff" : "white";
        const color = isCurrent ? "white" : "#5b2ecc";
        const border = isCurrent ? "#7c4dff" : "#d5c5f5";
        const cursor = isCurrent ? "default" : "pointer";
        const inner = `
          <div style="font-size:12px; font-weight:700; line-height:1.1;">${label}</div>
          <div style="font-size:11px; opacity:0.9; margin-top:2px;">${dateStr}</div>`;
        if (isCurrent) {
          return `<div style="background:${bg}; color:${color}; border:1px solid ${border}; padding:8px 14px; border-radius:8px; cursor:${cursor}; min-width:90px; text-align:center;">${inner}<div style="font-size:9px; margin-top:2px; opacity:0.85;">← YOU ARE HERE</div></div>`;
        }
        return `<a href="/admin/hearing/individual/${c.id}/edit" style="background:${bg}; color:${color}; border:1px solid ${border}; padding:8px 14px; border-radius:8px; text-decoration:none; cursor:${cursor}; min-width:90px; text-align:center; transition:all 0.15s; display:block;" onmouseover="this.style.background='#f3e8ff'" onmouseout="this.style.background='white'">${inner}</a>`;
      }).join("");

      const currentIsRoot = !prev.continuation_of;
      const chainCount = chain.length;
      const continuationCount = chainCount - 1;
      const headerText = currentIsRoot
        ? `📅 This Merits Hearing has ${continuationCount} Continuation${continuationCount === 1 ? "" : "s"}`
        : `📅 Continuation #${prev.continuation_number || "?"} of ${chainCount}-Session Merits Hearing`;

      continuationBanner = `
        <div style="background:linear-gradient(135deg, #f3e8ff, #e9d5ff); padding:16px 20px; border-left:4px solid #7c4dff; margin:15px 0; border-radius:8px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:12px;">
            <div>
              <strong style="color:#5b2ecc; font-size:14px;">${headerText}</strong>
              <div style="font-size:12px; color:#666; margin-top:2px;">
                Click any session below to navigate. All sessions share client info and continue exhibits/testimony from the prior hearing.
              </div>
            </div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:stretch;">
            ${pillsHtml}
          </div>
        </div>`;
    }
  }

  const body = `
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <h1 style="margin:0;">⚖️ Individual Hearing ${isEdit ? "— Editing #" + noteId : "— New"}${(isEdit && prev.continuation_number) ? ` <span style="background:#7c4dff; color:white; padding:2px 8px; border-radius:6px; font-size:12px; vertical-align:middle;">CONTINUATION #${prev.continuation_number}</span>` : ""}</h1>
        <a href="/admin/hearing/history" class="back-link">← All Hearings</a>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${isEdit ? `
        <a href="/admin/hearing/individual/${noteId}/closing" style="background:linear-gradient(135deg, #0C1C36, #1a2f4f); color:white; padding:10px 18px; border:none; border-radius:6px; cursor:pointer; font-size:14px; font-weight:600; box-shadow:0 2px 6px rgba(12,28,54,0.3); display:flex; align-items:center; gap:6px; text-decoration:none;">
          🏛️ <span>Oral Argument</span>
        </a>
        <button type="button" onclick="addContinuation()" style="background:linear-gradient(135deg, #7c4dff, #9c6dff); color:white; padding:10px 18px; border:none; border-radius:6px; cursor:pointer; font-size:14px; font-weight:600; box-shadow:0 2px 6px rgba(124,77,255,0.3); display:flex; align-items:center; gap:6px;">
          📅 <span>Add Continuation Merits</span>
        </button>` : ""}
        <button type="button" onclick="openDictationModal()" style="background:linear-gradient(135deg, #B79C62, #d4b979); color:white; padding:10px 18px; border:none; border-radius:6px; cursor:pointer; font-size:14px; font-weight:600; box-shadow:0 2px 6px rgba(183,156,98,0.3); display:flex; align-items:center; gap:6px;">
          🎙️ <span>Voice dictate ${isEdit ? "additional notes" : "this hearing"}</span>
        </button>
      </div>
    </div>

    <!-- Dictation floating widget — visible ONLY while recording -->
    <div id="dictation-widget" style="display:none; position:fixed; bottom:20px; right:20px; z-index:9999; background:linear-gradient(145deg, #0C1C36, #1a2f4f); color:white; padding:14px 18px; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,0.35); min-width:280px; border:2px solid #B79C62;">
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="width:12px; height:12px; border-radius:50%; background:#c62828; animation:d-pulse 1.2s infinite;"></div>
        <div style="flex:1;">
          <div id="d-widget-timer" style="font-family:monospace; font-size:20px; font-weight:600; letter-spacing:1px;">00:00</div>
          <div id="d-widget-status" style="font-size:11px; color:#B79C62; margin-top:2px;">Session 1</div>
        </div>
        <button type="button" onclick="dToggleRecording()" style="background:#c62828; color:white; border:none; padding:9px 14px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600;">⏹️ Stop</button>
      </div>
      <div id="d-widget-hint" style="font-size:10px; color:#888; margin-top:8px; text-align:center;">
        Continue typing — auto-splits every 28 min
      </div>
    </div>
    <style>
      @keyframes d-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(1.3); }
      }
    </style>

    <!-- Review modal — only shown after stop -->
    <div id="dictation-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:10000; align-items:center; justify-content:center; padding:20px;">
      <div style="background:white; padding:24px; border-radius:10px; max-width:520px; width:100%; max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
          <div>
            <h2 style="margin:0 0 4px 0; color:#0C1C36;">🎙️ Voice Dictation</h2>
            <div style="font-size:12px; color:#666;">Review below before applying.</div>
          </div>
          <button type="button" onclick="closeDictationModal()" style="background:transparent; border:none; font-size:20px; cursor:pointer; color:#888;">✕</button>
        </div>

        <div id="d-processing-panel" style="padding:20px 0; text-align:center;">
          <div id="d-proc-icon" style="font-size:36px; margin-bottom:10px;">🎧</div>
          <div id="d-proc-status" style="font-size:14px; color:#0C1C36; font-weight:600;">Processing…</div>
          <div style="margin-top:14px;">
            <div style="background:#eee; height:5px; border-radius:3px; overflow:hidden;">
              <div id="d-proc-progress" style="background:linear-gradient(to right, #B79C62, #d4b979); height:100%; width:0%; transition:width 0.4s;"></div>
            </div>
          </div>
        </div>

        <div id="d-result-panel" style="display:none;">
          <div style="background:#e8f5e9; color:#2e7d32; padding:10px 14px; border-radius:4px; font-size:13px; margin-bottom:12px;">
            ✅ Transcription complete. Preview below before applying.
          </div>
          <details style="background:#f8f8f8; padding:8px 12px; border-radius:4px; margin-bottom:12px; font-size:12px;">
            <summary style="cursor:pointer; font-weight:600;">📝 Full transcript</summary>
            <div id="d-transcript" style="margin-top:8px; white-space:pre-wrap; max-height:200px; overflow-y:auto; color:#333;"></div>
          </details>
          <div id="d-extracted-preview" style="font-size:12px; margin-bottom:14px;"></div>
          <div style="display:flex; gap:8px;">
            <button type="button" onclick="dDiscard()" style="background:#eee; color:#333; padding:9px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px; flex:1;">🗑️ Discard</button>
            <button type="button" onclick="dApplyToForm()" style="background:#0C1C36; color:white; padding:9px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px; font-weight:600; flex:1;">✓ Apply to form</button>
          </div>
        </div>

        <div id="d-error-panel" style="display:none; background:#fee; color:#900; padding:12px; border-radius:4px; margin-top:10px; font-size:12px;">
          <strong>❌</strong> <span id="d-error-text"></span>
        </div>
      </div>
    </div>

    ${tabsSection}

    ${isEdit ? `<div id="autosave-status" style="font-size:12px; color:#888; margin:5px 0 10px 0; text-align:right;">Auto-save ready</div>` : ""}

    <p style="margin-bottom:15px; color:#555;">Prep tool for individual/merits hearings. Fill this in before the hearing; all fields remain editable during and after. Upload the prep outline (PDF or text) and Excel exhibit list to auto-populate.${isEdit ? ` <em style="color:#B79C62;">Auto-saves every 5 seconds when you make changes.</em>` : ""}</p>

    <!-- Upload areas -->
    <div style="display:flex; gap:15px; margin-bottom:20px; flex-wrap:wrap;">
      <div id="summary-drop" ondragover="dragOver(event, 'summary-drop')" ondragleave="dragLeave(event, 'summary-drop')" ondrop="dropSummary(event)"
           style="flex:1; min-width:300px; background:#fdf7f0; border:2px dashed #B79C62; padding:20px; border-radius:8px; text-align:center;">
        <strong>📄 Hearing Summary / Prep Outline</strong>
        <div style="font-size:12px; color:#666; margin:6px 0;">Drop PDF, Word (.docx), or text file — Claude extracts Q&amp;A + closing</div>
        <input type="file" id="summary-file" accept=".pdf,.docx,.txt,.md" style="display:none;" onchange="uploadSummary(this.files[0])">
        <button type="button" onclick="document.getElementById('summary-file').click()" style="background:#B79C62; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Choose file</button>
        <div id="summary-status" style="margin-top:8px; font-size:13px;"></div>
      </div>
      <div id="exhibits-drop" ondragover="dragOver(event, 'exhibits-drop')" ondragleave="dragLeave(event, 'exhibits-drop')" ondrop="dropExhibits(event)"
           style="flex:1; min-width:300px; background:#fdf7f0; border:2px dashed #B79C62; padding:20px; border-radius:8px; text-align:center;">
        <strong>📊 Exhibit List (Excel/CSV)</strong>
        <div style="font-size:12px; color:#666; margin:6px 0;">Drop .xlsx or .csv — auto-fills exhibit table below</div>
        <input type="file" id="exhibits-file" accept=".xlsx,.xls,.csv" style="display:none;" onchange="uploadExhibits(this.files[0])">
        <button type="button" onclick="document.getElementById('exhibits-file').click()" style="background:#B79C62; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Choose file</button>
        <div id="exhibits-status" style="margin-top:8px; font-size:13px;"></div>
      </div>
    </div>

    ${errorSection}
    ${savedSection}
    ${continuationBanner}

    <form method="POST" action="/admin/hearing/individual${isEdit ? "/" + noteId : ""}" id="ih-form">
      <input type="hidden" name="hearing_summary_raw" id="hearing_summary_raw" value="${escapeAttr(prev.hearing_summary_raw)}">

      <!-- Section 1: Client / Case / Court -->
      <fieldset>
        <legend>Client, Case & Judge</legend>
        <div class="row">
          <div>
            <label>Client name *</label>
            <input type="text" name="client_name" required value="${escapeAttr(prev.client_name)}" placeholder="e.g. Chen, Xifen">
          </div>
          <div>
            <label>A-Number</label>
            <input type="text" name="a_number" value="${escapeAttr(prev.a_number)}" placeholder="A123-456-789">
          </div>
          <div style="flex:0 0 auto;">
            <label>&nbsp;</label>
            <button type="button" onclick="loadFromPriorHearing()" style="background:#0C1C36; color:white; padding:8px 14px; border:none; border-radius:4px; cursor:pointer;">🔍 Load prior hearing</button>
          </div>
        </div>
        <div id="prior-hearing-status" style="font-size:12px; color:#666; margin:4px 0 8px 0;"></div>
        <div class="row">
          <div>
            <label>Client email</label>
            <input type="text" name="client_email" value="${escapeAttr(prev.client_email)}">
          </div>
          <div>
            <label>Client phone</label>
            <input type="text" name="client_phone" value="${escapeAttr(prev.client_phone)}">
          </div>
          <div>
            <label>Client language</label>
            <select name="client_language">${langOptions}</select>
          </div>
        </div>
        <label>Client mailing address</label>
        <textarea name="client_address" rows="2" placeholder="Street, City, State, ZIP">${escapeHtml(prev.client_address || "")}</textarea>
        <div class="row">
          <div>
            <label>Case type</label>
            <input type="text" name="case_type" value="${escapeAttr(prev.case_type)}" placeholder="e.g. Asylum (I-589)">
          </div>
          <div>
            <label>Hearing date/time</label>
            <input type="datetime-local" name="hearing_date" step="1800" value="${escapeAttr(prev.hearing_date ? isoToLocal(prev.hearing_date) : "")}">
          </div>
        </div>
        <div class="row">
          <div>
            <label>Judge</label>
            <input type="text" name="judge_name" value="${escapeAttr(prev.judge_name)}" placeholder="e.g. Hon. Kevin Riley">
          </div>
          <div>
            <label>DHS Trial Attorney</label>
            <input type="text" name="dhs_attorney" value="${escapeAttr(prev.dhs_attorney)}">
          </div>
        </div>
      </fieldset>

      <!-- Section 2: Court address -->
      <fieldset>
        <legend>Court</legend>
        <div class="row">
          <div>
            <label>Court location (short name)</label>
            <input type="text" name="court_location" value="${escapeAttr(prev.court_location)}" placeholder="e.g. Los Angeles Immigration Court">
          </div>
        </div>
        <label>Court address</label>
        <textarea name="court_address" rows="2">${escapeHtml(prev.court_address || "")}</textarea>
        <div class="row">
          <div>
            <label>Attorney appearance</label>
            <select name="attorney_appearance">
              <option value="" ${!prev.attorney_appearance ? "selected" : ""}>—</option>
              <option value="In person" ${prev.attorney_appearance === "In person" ? "selected" : ""}>In person</option>
              <option value="WebEx" ${prev.attorney_appearance === "WebEx" ? "selected" : ""}>WebEx</option>
              <option value="Telephone" ${prev.attorney_appearance === "Telephone" ? "selected" : ""}>Telephone</option>
            </select>
          </div>
          <div>
            <label>Respondent appearance</label>
            <select name="respondent_appearance">
              <option value="" ${!prev.respondent_appearance ? "selected" : ""}>—</option>
              <option value="In person" ${prev.respondent_appearance === "In person" ? "selected" : ""}>In person</option>
              <option value="WebEx" ${prev.respondent_appearance === "WebEx" ? "selected" : ""}>WebEx</option>
              <option value="Telephone" ${prev.respondent_appearance === "Telephone" ? "selected" : ""}>Telephone</option>
            </select>
          </div>
        </div>
      </fieldset>

      <!-- Section 3: Exhibit list -->
      <fieldset>
        <legend>Exhibit List</legend>
        <div class="hint">Upload an Excel/CSV above to auto-populate, or add rows manually. "Marked" is the exhibit's number (1-99) once formally identified in the record. Check "Not admitted" only when the exhibit was refused — everything else is assumed admitted.</div>
        <div style="overflow-x:auto;">
        <table id="exhibits-table" style="width:100%; margin:8px 0; font-size:13px;">
          <thead>
            <tr>
              <th style="width:72px; text-align:left;">#</th>
              <th style="width:120px; text-align:left;">EOIR Submission</th>
              <th style="text-align:left;">Description</th>
              <th style="width:70px; text-align:center;">Marked</th>
              <th style="width:90px; text-align:center;">Not admitted</th>
              <th style="text-align:left;">Objection / Notes</th>
              <th style="width:70px; text-align:center;" title="Attach a file from client's Dropbox">📎</th>
              <th style="width:30px;"></th>
            </tr>
          </thead>
          <tbody id="exhibits-tbody"></tbody>
        </table>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button type="button" onclick="addExhibitRow()" style="background:#eee; padding:6px 12px; border:none; cursor:pointer; border-radius:4px; font-size:13px;">+ Add exhibit row</button>
          <button type="button" onclick="autoMatchDropboxExhibits()" id="dbx-automatch-btn" style="background:#0061FF; color:white; padding:6px 12px; border:none; cursor:pointer; border-radius:4px; font-size:13px;">🎯 Auto-match to Dropbox files</button>
          <span style="font-size:12px; color:#666;">Uploads via Excel; use the 📎 icon on each row or Auto-match to link Dropbox files.</span>
        </div>
      </fieldset>

      <!-- Dropbox Exhibit Picker Modal -->
      <div id="dbx-exhibit-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
        <div style="background:white; border-radius:8px; width:min(720px, 92vw); max-height:90vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <div style="padding:15px 20px; border-bottom:1px solid #eee; display:flex; align-items:center; justify-content:space-between;">
            <h3 id="dbx-exhibit-modal-title" style="margin:0; color:#0C1C36; font-size:16px;">📎 Link to Exhibit</h3>
            <button type="button" onclick="closeDropboxExhibitPicker()" style="background:none; border:none; font-size:24px; color:#666; cursor:pointer; padding:0 4px;">×</button>
          </div>
          <div id="dbx-exhibit-breadcrumb" style="padding:10px 20px; font-size:13px; color:#666; background:#f9f9f9; border-bottom:1px solid #eee;"></div>
          <div style="padding:10px 20px;">
            <input type="text" id="dbx-exhibit-filter" placeholder="🔍 Filter files by name..." oninput="filterDbxExhibitFiles()" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; font-size:13px;">
          </div>
          <div id="dbx-exhibit-body" style="flex:1; overflow-y:auto; padding:0 20px 15px 20px; min-height:200px;">
            <div style="text-align:center; color:#666; padding:40px 0;">Loading…</div>
          </div>
          <div style="padding:12px 20px; border-top:1px solid #eee; display:flex; justify-content:space-between; align-items:center; gap:10px; background:#f9f9f9;">
            <span style="font-size:12px; color:#666;">💡 Click any file to link it to the exhibit above</span>
            <button type="button" onclick="closeDropboxExhibitPicker()" style="background:#eee; color:#333; padding:8px 14px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Section 4: Pre-examination notes (was Section 5) -->
      <fieldset>
        <legend>Notes Before Examinations</legend>
        <textarea name="pre_examination_notes" rows="4" placeholder="Opening statement notes, procedural matters, preliminary issues, judge's opening remarks, etc.">${escapeHtml(prev.pre_examination_notes || "")}</textarea>
      </fieldset>

      <!-- Section 6: Examinations -->
      <fieldset>
        <legend>Witness Examinations</legend>
        <div class="hint">Upload a hearing summary above to auto-populate Q&amp;A. Add witnesses / examinations as needed.</div>
        <div id="exams-container"></div>
        <button type="button" onclick="addExamination()" style="background:#eee; padding:6px 12px; border:none; cursor:pointer; border-radius:4px; font-size:13px;">+ Add examination</button>
      </fieldset>

      <!-- Section 7: Closing -->
      <fieldset>
        <legend>Closing Oral Argument</legend>
        <div class="hint">Pulled from hearing summary if provided. Editable.</div>
        <textarea name="closing_argument" rows="10" style="font-family:inherit; font-size:14px;">${escapeHtml(prev.closing_argument || "")}</textarea>
      </fieldset>

      <!-- Post-hearing (optional) -->
      <fieldset>
        <legend>Post-Hearing (Optional)</legend>
        <label>Disposition</label>
        <input type="text" name="disposition" value="${escapeAttr(prev.disposition)}" placeholder="e.g. Relief granted, Decision reserved, Removal ordered, Continued">
        <label>Disposition notes</label>
        <textarea name="disposition_notes" rows="2">${escapeHtml(prev.disposition_notes || "")}</textarea>
        <div class="row">
          <div>
            <label>Next hearing date/time</label>
            <input type="datetime-local" name="next_hearing_date" step="1800" value="${escapeAttr(prev.next_hearing_date ? isoToLocal(prev.next_hearing_date) : "")}">
          </div>
          <div>
            <label>Next hearing type</label>
            <select name="next_hearing_type">
              <option value="" ${!prev.next_hearing_type ? "selected" : ""}>—</option>
              <option value="master" ${prev.next_hearing_type === "master" ? "selected" : ""}>Master</option>
              <option value="individual" ${prev.next_hearing_type === "individual" ? "selected" : ""}>Individual/Merits (continued)</option>
              <option value="bond" ${prev.next_hearing_type === "bond" ? "selected" : ""}>Bond</option>
              <option value="status" ${prev.next_hearing_type === "status" ? "selected" : ""}>Status</option>
              <option value="other" ${prev.next_hearing_type === "other" ? "selected" : ""}>Other</option>
            </select>
          </div>
        </div>
        <label>Next action deadline</label>
        <input type="date" name="next_action_deadline" value="${escapeAttr(prev.next_action_deadline ? String(prev.next_action_deadline).substring(0, 10) : "")}">
      </fieldset>

      <div style="margin-top:20px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <button type="submit" style="background:#B79C62; color:white; padding:12px 28px; border:none; border-radius:4px; cursor:pointer; font-size:15px;">💾 ${isEdit ? "Update" : "Save"}</button>
        ${isEdit ? `<a href="/admin/hearing/individual" style="background:#eee; color:#333; padding:12px 28px; border-radius:4px; text-decoration:none; font-size:15px;">+ New</a>` : ""}
        ${isEdit ? `
          <button type="button" onclick="generateSummaries(${noteId})" style="background:#0C1C36; color:white; padding:12px 20px; border:none; border-radius:4px; cursor:pointer; font-size:14px;">✨ Generate Summaries</button>
          <span id="gen-status" style="font-size:13px;"></span>
          <button type="button" onclick="deleteThisNote(${noteId}, ${JSON.stringify(prev.client_name || "").replace(/"/g, "&quot;")})" style="background:#c00; color:white; padding:12px 20px; border:none; border-radius:4px; cursor:pointer; font-size:14px; margin-left:auto;">🗑️ Delete note</button>
        ` : ""}
      </div>
    </form>

    ${isEdit && (prev.paralegal_summary || prev.client_summary) ? `
    <div id="summaries-section" style="margin-top:30px;">
      <h2 style="color:#B79C62; border-bottom:2px solid #B79C62; padding-bottom:6px;">Generated Summaries</h2>

      <div style="background:#f5f9ff; padding:20px; margin:15px 0; border-left:4px solid #0C1C36; border-radius:4px;">
        <h3 style="margin-top:0;">📋 Paralegal Summary (English, detailed)</h3>
        <pre id="paralegal-content" style="white-space:pre-wrap; font-family:inherit; margin:0; background:white; padding:15px; border-radius:4px;">${escapeHtml(prev.paralegal_summary || "(not generated)")}</pre>
        <div style="margin-top:12px;">
          <button type="button" onclick="copyEl('paralegal-content')" style="background:#0C1C36; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">📋 Copy Paralegal Summary</button>
          <button type="button" onclick="sendToTeam(${noteId})" style="background:#4CAF50; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-left:8px;">📤 ${prev.sent_to_paralegal_at ? "Re-send" : "Send"} to team group</button>
          <button type="button" onclick="generateTasksFromNote('individual', ${noteId}, this)" style="background:#B79C62; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-left:8px;">🤖 Create Tasks</button>
          <span id="send-status" style="margin-left:12px; font-weight:bold;"></span>
        </div>
      </div>

      <div style="background:#fdf7f0; padding:20px; margin:15px 0; border-left:4px solid #B79C62; border-radius:4px;">
        <h3 style="margin-top:0;">👤 Client Summary (in client's language)</h3>
        <pre id="client-content" style="white-space:pre-wrap; font-family:inherit; margin:0; background:white; padding:15px; border-radius:4px;">${escapeHtml(prev.client_summary || "(not generated)")}</pre>
        <div style="margin-top:12px;">
          <button type="button" onclick="copyEl('client-content')" style="background:#B79C62; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">📋 Copy Client Summary</button>
          <span style="margin-left:12px; color:#666; font-size:13px;">Paste into WhatsApp, email, iMessage, etc.</span>
        </div>
      </div>
    </div>
    ` : ""}

    <script>
      // ── Voice dictation with auto-chunking + non-blocking widget ─────
      // Recording shows only as a small floating widget in the corner so the
      // attorney can keep typing in the form fields simultaneously. For long
      // individual hearings, we auto-rotate the MediaRecorder every 20 min.
      // At 40 kbps voice bitrate: 20 min × 40 kbps ≈ 6 MB per chunk — well under
      // the Whisper 25 MB API limit.
      const CHUNK_MINUTES = 20;
      const AUDIO_BITRATE = 40000;  // 40 kbps — plenty for legal dictation; Whisper handles low bitrate fine

      let dMediaStream = null;
      let dMediaRecorder = null;
      let dChunks = [];
      let dRecordStart = 0;
      let dChunkStart = 0;
      let dTimerInterval = null;
      let dRotationTimeout = null;
      let dAudioMime = "audio/webm";
      let dAudioExt = "webm";
      let dChunkIndex = 0;
      let dSessionsPending = [];
      let dSessionTranscripts = [];
      let dIsFinishing = false;
      let dTranscript = "";
      let dExtracted = null;

      // ── Continuation of Merits Hearing ──────────────────────
      // Creates a new individual_hearing_notes record that clones ALL fields
      // from the current note (client info, exhibits, examinations, prep notes,
      // etc.) with only the hearing_date changed to the continuation date.
      // The new note is linked to this one via continuation_of.
      async function addContinuation() {
        const noteId = ${isEdit ? noteId : 'null'};
        if (!noteId) { alert("Save this hearing note first, then add a continuation."); return; }

        const newDate = prompt("Enter the continuation hearing date (YYYY-MM-DD):");
        if (!newDate) return;
        // Basic validation: format check
        if (!/^\\d{4}-\\d{2}-\\d{2}/.test(newDate)) {
          alert("Please enter the date in YYYY-MM-DD format (e.g. 2026-11-15).");
          return;
        }
        const newTime = prompt("Hearing time (HH:MM in 24hr, e.g. 09:00), or leave blank:", "09:00") || "";
        const notes = prompt("Optional note about this continuation (e.g. 'Cross of DHS expert only'):", "");

        try {
          const r = await fetch("/admin/hearing/individual/" + noteId + "/continuation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ new_hearing_date: newDate, new_hearing_time: newTime, notes: notes || "" }),
          });
          const d = await r.json();
          if (d.ok) {
            // Redirect to the new note's edit page
            window.location.href = "/admin/hearing/individual/" + d.new_id + "/edit";
          } else {
            alert("Error: " + (d.error || "Failed to create continuation"));
          }
        } catch (e) {
          alert("Error: " + e.message);
        }
      }

      async function openDictationModal() {
        // Immediately request mic + start recording. Show floating widget only.
        try {
          dMediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
          });
        } catch (e) {
          alert("Microphone access denied: " + e.message);
          return;
        }
        const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
        let selectedType = "";
        for (const t of preferred) { if (MediaRecorder.isTypeSupported(t)) { selectedType = t; break; } }
        dAudioMime = selectedType || "audio/webm";
        dAudioExt = dAudioMime.includes("mp4") ? "mp4" : "webm";
        dChunkIndex = 0;
        dSessionsPending = [];
        dSessionTranscripts = [];
        dIsFinishing = false;
        dRecordStart = Date.now();
        dStartNewChunkRecorder();
        dStartTimer();
        document.getElementById("dictation-widget").style.display = "block";
      }

      function closeDictationModal() {
        dCleanup();
        document.getElementById("dictation-modal").style.display = "none";
      }
      function dCleanup() {
        try { if (dMediaRecorder && dMediaRecorder.state === "recording") dMediaRecorder.stop(); } catch { /* silent */ }
        if (dMediaStream) { dMediaStream.getTracks().forEach(t => t.stop()); dMediaStream = null; }
        dStopTimer();
        if (dRotationTimeout) { clearTimeout(dRotationTimeout); dRotationTimeout = null; }
        document.getElementById("dictation-widget").style.display = "none";
      }

      function dToggleRecording() {
        if (dMediaRecorder && dMediaRecorder.state === "recording" && !dIsFinishing) {
          dIsFinishing = true;
          document.getElementById("d-widget-status").textContent = "Finalizing…";
          dMediaRecorder.stop();
          if (dRotationTimeout) { clearTimeout(dRotationTimeout); dRotationTimeout = null; }
          dStopTimer();
        }
      }

      function dStartNewChunkRecorder() {
        const chunkIdx = dChunkIndex;
        dChunks = [];
        dChunkStart = Date.now();
        // Always set audioBitsPerSecond to prevent browsers from defaulting to
        // 128 kbps, which would push a 20-min chunk near/over Whisper's 25 MB cap.
        const opts = dAudioMime
          ? { mimeType: dAudioMime, audioBitsPerSecond: AUDIO_BITRATE }
          : { audioBitsPerSecond: AUDIO_BITRATE };
        dMediaRecorder = new MediaRecorder(dMediaStream, opts);
        dMediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) dChunks.push(e.data); };
        dMediaRecorder.onstop = () => {
          const blob = new Blob(dChunks, { type: dAudioMime });
          const wasFinal = dIsFinishing;
          dUploadChunk(chunkIdx, blob).catch(err => console.warn("Chunk upload err:", err));
          if (wasFinal) {
            if (dMediaStream) { dMediaStream.getTracks().forEach(t => t.stop()); dMediaStream = null; }
            document.getElementById("dictation-widget").style.display = "none";
            dWaitForTranscriptionsThenExtract();
          } else {
            dChunkIndex++;
            dStartNewChunkRecorder();
            dScheduleRotation();
          }
        };
        dMediaRecorder.start();
        dScheduleRotation();
      }

      function dScheduleRotation() {
        if (dRotationTimeout) clearTimeout(dRotationTimeout);
        dRotationTimeout = setTimeout(() => {
          if (dMediaRecorder && dMediaRecorder.state === "recording" && !dIsFinishing) {
            console.log("[dictate] Auto-rotating chunk " + dChunkIndex);
            dMediaRecorder.stop();
          }
        }, CHUNK_MINUTES * 60 * 1000);
      }

      async function dUploadChunk(chunkIdx, blob) {
        dSessionsPending.push(chunkIdx);
        const fd = new FormData();
        fd.append("audio", blob, "chunk-" + chunkIdx + "-" + Date.now() + "." + dAudioExt);
        fd.append("chunk_index", String(chunkIdx));
        try {
          const resp = await fetch("/admin/hearing/notes/dictate/transcribe-chunk", { method: "POST", body: fd });
          const text = await resp.text();
          let data; try { data = JSON.parse(text); } catch { throw new Error("Non-JSON: " + text.substring(0, 200)); }
          if (!resp.ok || !data.ok) throw new Error(data.error || "HTTP " + resp.status);
          dSessionTranscripts[chunkIdx] = data.transcript || "";
        } catch (e) {
          dSessionTranscripts[chunkIdx] = "[transcription failed for session " + (chunkIdx + 1) + ": " + e.message + "]";
          console.error("[dictate] Chunk " + chunkIdx + " error:", e);
        } finally {
          const i = dSessionsPending.indexOf(chunkIdx);
          if (i >= 0) dSessionsPending.splice(i, 1);
          dUpdateProcessingStatus();
        }
      }

      function dUpdateProcessingStatus() {
        if (document.getElementById("d-processing-panel").style.display !== "block") return;
        const total = dChunkIndex + 1;
        const done = total - dSessionsPending.length;
        const pct = Math.round((done / total) * 100);
        document.getElementById("d-proc-progress").style.width = pct + "%";
        document.getElementById("d-proc-status").textContent =
          "Transcribing session " + done + " of " + total + "…";
      }

      async function dWaitForTranscriptionsThenExtract() {
        // Open the modal in processing state
        document.getElementById("dictation-modal").style.display = "flex";
        document.getElementById("d-processing-panel").style.display = "block";
        document.getElementById("d-result-panel").style.display = "none";
        document.getElementById("d-error-panel").style.display = "none";
        document.getElementById("d-proc-icon").textContent = "🎧";
        document.getElementById("d-proc-status").textContent =
          "Transcribing " + (dChunkIndex + 1) + " session" + (dChunkIndex > 0 ? "s" : "") + "…";
        document.getElementById("d-proc-progress").style.width = "10%";

        while (dSessionsPending.length > 0) {
          await new Promise(r => setTimeout(r, 500));
        }
        const combined = dSessionTranscripts.filter(t => typeof t === "string").join("\\n\\n");
        if (!combined || combined.length < 5) {
          dShowError("All transcripts came back empty. Recording may have been silent.");
          return;
        }
        dTranscript = combined;
        document.getElementById("d-proc-icon").textContent = "🧠";
        document.getElementById("d-proc-status").textContent = "Claude extracting fields…";
        document.getElementById("d-proc-progress").style.width = "85%";
        try {
          const resp = await fetch("/admin/hearing/notes/dictate/extract-from-text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transcript: combined,
              client_name: document.querySelector('[name="client_name"]')?.value || "",
              a_number: document.querySelector('[name="a_number"]')?.value || "",
              hearing_type: "individual",
            }),
          });
          const text = await resp.text();
          let data; try { data = JSON.parse(text); } catch { throw new Error("Non-JSON: " + text.substring(0, 200)); }
          if (!resp.ok || !data.ok) throw new Error(data.error || "HTTP " + resp.status);
          dExtracted = data.extracted;
          dShowExtractedPreview();
          document.getElementById("d-processing-panel").style.display = "none";
          document.getElementById("d-result-panel").style.display = "block";
        } catch (e) { dShowError(e.message); }
      }

      function dStartTimer() {
        dTimerInterval = setInterval(() => {
          const totalSec = Math.floor((Date.now() - dRecordStart) / 1000);
          const chunkSec = Math.floor((Date.now() - dChunkStart) / 1000);
          const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
          const ss = String(totalSec % 60).padStart(2, "0");
          const chunkRemain = Math.max(0, CHUNK_MINUTES * 60 - chunkSec);
          const cm = String(Math.floor(chunkRemain / 60)).padStart(2, "0");
          const cs = String(chunkRemain % 60).padStart(2, "0");
          document.getElementById("d-widget-timer").textContent = mm + ":" + ss;
          document.getElementById("d-widget-status").textContent =
            "Session " + (dChunkIndex + 1) + " · splits in " + cm + ":" + cs;
        }, 250);
      }
      function dStopTimer() { if (dTimerInterval) { clearInterval(dTimerInterval); dTimerInterval = null; } }

      function dShowExtractedPreview() {
        document.getElementById("d-transcript").textContent = dTranscript;
        const e = dExtracted || {};
        const rows = [];
        if (e.client_name) rows.push(["Client", e.client_name]);
        if (e.a_number) rows.push(["A#", e.a_number]);
        if (e.judge_name) rows.push(["Judge", e.judge_name]);
        if (e.dhs_attorney) rows.push(["DHS", e.dhs_attorney]);
        if (e.hearing_datetime) rows.push(["Hearing time", new Date(e.hearing_datetime).toLocaleString()]);
        if (e.next_hearing_date) rows.push(["Next hearing", new Date(e.next_hearing_date).toLocaleString()]);
        if (e.disposition) rows.push(["Disposition", e.disposition]);
        const sessionCount = dChunkIndex + 1;
        const durationMin = Math.round((Date.now() - dRecordStart) / 60000);
        const html = rows.map(([k, v]) =>
          '<tr><td style="padding:3px 8px 3px 0; color:#666; white-space:nowrap;">' + k + '</td><td style="padding:3px 0; font-weight:500;">' + String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</td></tr>'
        ).join("");
        document.getElementById("d-extracted-preview").innerHTML =
          '<div style="background:#e8f5e9; color:#2e7d32; padding:8px 12px; border-radius:4px; margin-bottom:10px; font-size:11px;">' +
          '📊 ' + sessionCount + ' session' + (sessionCount > 1 ? "s" : "") + ' · ~' + durationMin + ' min total · ' + dTranscript.length + ' chars transcribed' +
          '</div>' +
          (rows.length ? '<div style="font-weight:600; margin-bottom:6px; color:#0C1C36;">Extracted fields:</div><table style="width:100%; font-size:12px;">' + html + '</table><div style="font-size:11px; color:#888; margin-top:6px;">Full transcript will append to the raw notes textarea.</div>'
                       : '<div style="color:#c00;">⚠️ No fields extracted, but transcript will still be appended.</div>');
      }

      function dDiscard() {
        dTranscript = ""; dExtracted = null;
        closeDictationModal();
      }

      function dApplyToForm() {
        const e = dExtracted || {};
        const setIfEmpty = (name, value) => {
          if (!value) return;
          const el = document.querySelector('[name="' + name + '"]');
          if (el && !el.value) el.value = value;
        };
        setIfEmpty("client_name", e.client_name);
        setIfEmpty("a_number", e.a_number);
        setIfEmpty("judge_name", e.judge_name);
        setIfEmpty("dhs_attorney", e.dhs_attorney);
        setIfEmpty("disposition", e.disposition);
        if (e.hearing_datetime) { const el = document.querySelector('[name="hearing_date"]'); if (el && !el.value) el.value = e.hearing_datetime.substring(0, 16); }
        if (e.next_hearing_date) { const el = document.querySelector('[name="next_hearing_date"]'); if (el && !el.value) el.value = e.next_hearing_date.substring(0, 16); }
        const rawNotes = document.querySelector('[name="raw_notes"], [name="attorney_notes"], [name="notes"]');
        if (rawNotes) {
          const stamp = new Date().toLocaleString();
          const sessionCount = dChunkIndex + 1;
          const header = "\\n\\n[Voice dictation " + stamp + " — " + sessionCount + " session" + (sessionCount > 1 ? "s" : "") + "]\\n";
          const prefix = rawNotes.value ? header : header.trim() + "\\n";
          rawNotes.value = rawNotes.value + prefix + dTranscript;
          rawNotes.dispatchEvent(new Event('input', { bubbles: true }));
        }
        closeDictationModal();
        const toast = document.createElement("div");
        toast.style.cssText = "position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#2e7d32; color:white; padding:12px 20px; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.15); z-index:10001; font-size:14px;";
        toast.textContent = "✅ Voice dictation applied (" + (dChunkIndex + 1) + " session" + (dChunkIndex > 0 ? "s" : "") + ")";
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3500);
      }
      function dShowError(msg) {
        document.getElementById("d-error-panel").style.display = "block";
        document.getElementById("d-error-text").textContent = msg;
        document.getElementById("d-processing-panel").style.display = "none";
      }
      // ── End dictation ─────────────────────────

      const INITIAL_EXHIBITS = ${JSON.stringify(exhibits)};
      const INITIAL_EXAMS    = ${JSON.stringify(examinations)};

      function isoToLocalStr(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d)) return "";
        const pad = n => n.toString().padStart(2, "0");
        return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
      }

      // ── Exhibits table ──────────────────────────────────
      let exhibitCounter = 0;
      function addExhibitRow(data) {
        data = data || {};
        const idx = exhibitCounter++;
        // Marked is now a number (1-99). If old data has "yes"/"X", show blank
        // so the browser's number input doesn't complain. Any actual number preserves.
        const markedNum = (data.marked != null && !isNaN(Number(data.marked)) && String(data.marked).trim() !== "")
          ? String(parseInt(data.marked, 10))
          : "";
        // Not admitted (inverted). Only checked if explicitly flagged as not admitted.
        // Older records with admitted: "yes" translate to not_admitted: false (they WERE admitted).
        const isNotAdmitted = !!(data.not_admitted && String(data.not_admitted).trim());
        const linkedPath = data.dropbox_file_path || "";
        const tr = document.createElement("tr");
        tr.dataset.exhibitIdx = idx;
        tr.innerHTML =
          '<td><input type="text" name="exhibit_number_' + idx + '" value="' + escapeHTML(data.number || "") + '" style="width:100%; padding:4px 6px; box-sizing:border-box; text-align:center;"></td>' +
          '<td><input type="text" name="exhibit_eoir_submission_' + idx + '" value="' + escapeHTML(data.eoir_submission || "") + '" style="width:100%;" placeholder="EOIR ref"></td>' +
          '<td><input type="text" name="exhibit_description_' + idx + '" value="' + escapeHTML(data.description || "") + '" style="width:100%;"></td>' +
          '<td style="text-align:center;"><input type="number" name="exhibit_marked_' + idx + '" min="1" max="99" value="' + escapeHTML(markedNum) + '" placeholder="—" style="width:60px; text-align:center; padding:4px;"></td>' +
          '<td style="text-align:center;"><input type="checkbox" name="exhibit_not_admitted_' + idx + '" value="yes"' + (isNotAdmitted ? " checked" : "") + ' style="transform:scale(1.3);"></td>' +
          '<td><input type="text" name="exhibit_objection_' + idx + '" value="' + escapeHTML(data.objection || "") + '" style="width:100%;"></td>' +
          '<td style="text-align:center;">' + renderExhibitLinkCell(idx, linkedPath) + '</td>' +
          '<td><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:#eee; border:none; padding:4px 8px; cursor:pointer; border-radius:3px;">×</button></td>';
        document.getElementById("exhibits-tbody").appendChild(tr);
      }

      // Render the paperclip cell for an exhibit row. Shows either:
      // - "Link" button (unlinked)
      // - Small chip with filename + link icon (linked, click to open, right-click to unlink)
      function renderExhibitLinkCell(idx, linkedPath) {
        const hiddenInput = '<input type="hidden" name="exhibit_dropbox_file_path_' + idx + '" value="' + escapeHTML(linkedPath) + '">';
        if (linkedPath) {
          const filename = linkedPath.split("/").pop() || linkedPath;
          const shortName = filename.length > 22 ? filename.substring(0, 19) + "…" : filename;
          return hiddenInput +
            '<div style="display:flex; align-items:center; gap:2px; justify-content:center;">' +
              '<button type="button" onclick="openExhibitLinkedFile(' + idx + ')" title="' + escapeHTML(filename) + '" style="background:#e8f5e9; color:#2e7d32; border:1px solid #2e7d32; padding:2px 6px; font-size:11px; border-radius:3px; cursor:pointer; max-width:130px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">📎 ' + escapeHTML(shortName) + '</button>' +
              '<button type="button" onclick="unlinkExhibitDropbox(' + idx + ')" title="Unlink" style="background:none; color:#c00; border:none; padding:2px 4px; font-size:12px; cursor:pointer;">×</button>' +
            '</div>';
        }
        return hiddenInput +
          '<button type="button" onclick="openLinkExhibitToDropbox(' + idx + ')" style="background:#eee; border:none; padding:4px 10px; font-size:11px; border-radius:3px; cursor:pointer;">📎 Link</button>';
      }

      // Open the linked Dropbox file in a new tab
      async function openExhibitLinkedFile(idx) {
        const hidden = document.querySelector('[name="exhibit_dropbox_file_path_' + idx + '"]');
        const path = hidden?.value;
        if (!path) return;
        try {
          const resp = await fetch("/admin/dropbox/temp-link?path=" + encodeURIComponent(path));
          const data = await resp.json();
          if (data.ok && data.link) {
            window.open(data.link, "_blank");
          } else {
            alert("Could not open file: " + (data.error || "unknown"));
          }
        } catch (e) {
          alert("Error opening file: " + e.message);
        }
      }

      function unlinkExhibitDropbox(idx) {
        const row = document.querySelector('tr[data-exhibit-idx="' + idx + '"]');
        if (!row) return;
        const cell = row.querySelector('td:nth-last-child(2)');   // paperclip cell (before delete)
        cell.innerHTML = renderExhibitLinkCell(idx, "");
      }

      function setExhibitLinkedPath(idx, path) {
        const row = document.querySelector('tr[data-exhibit-idx="' + idx + '"]');
        if (!row) return;
        const cell = row.querySelector('td:nth-last-child(2)');
        cell.innerHTML = renderExhibitLinkCell(idx, path);
      }
      function clearExhibits() {
        document.getElementById("exhibits-tbody").innerHTML = "";
      }

      // ── Dropbox Exhibit Picker ─────────────────────────
      // The modal is now used to LINK a Dropbox file to a specific
      // exhibit row (not to create new rows).
      let dbxExhibitCurrentPath = null;
      let dbxExhibitRootPath = null;
      let dbxExhibitFiles = [];
      let dbxExhibitSubfolders = [];
      let dbxLinkTargetIdx = null;   // which exhibit row is being linked

      async function openLinkExhibitToDropbox(exhibitIdx) {
        const clientName = (document.querySelector('[name="client_name"]')?.value || "").trim();
        const aNumber    = (document.querySelector('[name="a_number"]')?.value    || "").trim();
        if (!clientName && !aNumber) {
          alert("Enter the client name (or A-Number) at the top of the form first.");
          return;
        }
        dbxLinkTargetIdx = exhibitIdx;
        // Update modal title to show which exhibit we're linking
        const descEl = document.querySelector('[name="exhibit_description_' + exhibitIdx + '"]');
        const numEl = document.querySelector('[name="exhibit_number_' + exhibitIdx + '"]');
        const label = "Exhibit #" + (numEl?.value || "?") + (descEl?.value ? " — " + descEl.value : "");
        document.getElementById("dbx-exhibit-modal-title").textContent = "📎 Link to " + label;
        document.getElementById("dbx-exhibit-modal").style.display = "flex";
        document.getElementById("dbx-exhibit-filter").value = "";
        await loadDbxExhibitFolder(null);
      }

      function closeDropboxExhibitPicker() {
        document.getElementById("dbx-exhibit-modal").style.display = "none";
        dbxLinkTargetIdx = null;
      }

      async function loadDbxExhibitFolder(subpath) {
        const clientName = (document.querySelector('[name="client_name"]')?.value || "").trim();
        const aNumber    = (document.querySelector('[name="a_number"]')?.value    || "").trim();
        const body = document.getElementById("dbx-exhibit-body");
        body.innerHTML = '<div style="text-align:center; color:#666; padding:40px 0;">Loading…</div>';
        const url = "/admin/hearing/individual/dropbox/files"
          + "?client_name=" + encodeURIComponent(clientName)
          + "&a_number=" + encodeURIComponent(aNumber)
          + (subpath ? "&subfolder=" + encodeURIComponent(subpath) : "");
        try {
          const resp = await fetch(url);
          const data = await resp.json();
          if (!data.ok) {
            body.innerHTML = '<div style="color:#c00; padding:40px 20px; text-align:center;">❌ ' + escapeHTML(data.error || "Failed to load") + '</div>';
            document.getElementById("dbx-exhibit-breadcrumb").innerHTML = "";
            return;
          }
          dbxExhibitCurrentPath = data.current_path;
          dbxExhibitRootPath = data.folder;
          dbxExhibitFiles = data.files || [];
          dbxExhibitSubfolders = data.subfolders || [];
          renderDbxExhibitBrowser(data);
        } catch (e) {
          body.innerHTML = '<div style="color:#c00; padding:40px 20px; text-align:center;">❌ ' + escapeHTML(e.message) + '</div>';
        }
      }

      function renderDbxExhibitBrowser(data) {
        // Breadcrumb
        const crumb = document.getElementById("dbx-exhibit-breadcrumb");
        const crumbParts = (data.breadcrumb || []).map((c, i, arr) => {
          const isLast = i === arr.length - 1;
          if (isLast) return '<strong>' + escapeHTML(c.name) + '</strong>';
          return '<a href="#" onclick="loadDbxExhibitFolder(' + JSON.stringify(c.path).replace(/"/g,"&quot;") + '); return false;" style="color:#0061FF; text-decoration:none;">' + escapeHTML(c.name) + '</a>';
        }).join(' <span style="color:#999;">/</span> ');
        crumb.innerHTML = '📁 ' + crumbParts;

        const body = document.getElementById("dbx-exhibit-body");
        let html = "";

        if (dbxExhibitSubfolders.length) {
          html += '<div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin:8px 0 4px 0;">Subfolders</div>';
          html += dbxExhibitSubfolders.map(f =>
            '<div style="padding:8px; border-radius:4px; cursor:pointer; display:flex; align-items:center; gap:8px;" onmouseover="this.style.background=\\'#f0f8ff\\'" onmouseout="this.style.background=\\'\\'" onclick="loadDbxExhibitFolder(' + JSON.stringify(f.path).replace(/"/g,"&quot;") + ')">' +
              '<span style="font-size:16px;">📁</span>' +
              '<span style="font-weight:600; color:#0C1C36;">' + escapeHTML(f.name) + '</span>' +
            '</div>'
          ).join("");
        }

        if (dbxExhibitFiles.length) {
          html += '<div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin:12px 0 4px 0;">Files — click to link</div>';
          html += '<div id="dbx-exhibit-file-list">';
          html += dbxExhibitFiles.map((f, idx) => {
            const iconMap = {".pdf":"📄",".jpg":"🖼️",".jpeg":"🖼️",".png":"🖼️",".doc":"📝",".docx":"📝",".xls":"📊",".xlsx":"📊"};
            const ext = (f.name.match(/\\.[^.]+$/)||[""])[0].toLowerCase();
            const icon = iconMap[ext] || "📎";
            const sizeStr = f.size < 1024 ? f.size + " B" : f.size < 1048576 ? (f.size/1024).toFixed(1)+" KB" : (f.size/1048576).toFixed(1)+" MB";
            return '<div class="dbx-exhibit-file-row" data-idx="' + idx + '" data-name="' + escapeAttr(f.name.toLowerCase()) + '" onclick="linkDbxFileToExhibit(' + idx + ')" style="display:flex; align-items:center; gap:8px; padding:10px; border-radius:4px; cursor:pointer; margin-bottom:2px; border:1px solid transparent;">' +
              '<span style="font-size:16px;">' + icon + '</span>' +
              '<span style="flex:1; font-size:13px;">' + escapeHTML(f.name) + '</span>' +
              '<span style="font-size:11px; color:#888;">' + sizeStr + '</span>' +
            '</div>';
          }).join("");
          html += '</div>';
        } else if (!dbxExhibitSubfolders.length) {
          html += '<div style="text-align:center; color:#888; padding:40px 0;">This folder is empty.</div>';
        }

        body.innerHTML = html;

        document.querySelectorAll(".dbx-exhibit-file-row").forEach(r => {
          r.addEventListener("mouseover", () => r.style.background = "#e8f5e9");
          r.addEventListener("mouseout", () => r.style.background = "");
        });
      }

      function filterDbxExhibitFiles() {
        const q = document.getElementById("dbx-exhibit-filter").value.toLowerCase();
        document.querySelectorAll(".dbx-exhibit-file-row").forEach(r => {
          const name = r.dataset.name || "";
          r.style.display = (!q || name.includes(q)) ? "flex" : "none";
        });
      }

      // Click handler on a file row — links to the current target exhibit
      function linkDbxFileToExhibit(fileIdx) {
        if (dbxLinkTargetIdx == null) {
          alert("No exhibit selected to link to.");
          return;
        }
        const file = dbxExhibitFiles[fileIdx];
        if (!file) return;
        setExhibitLinkedPath(dbxLinkTargetIdx, file.path);
        closeDropboxExhibitPicker();
      }

      // ── Auto-match all unlinked exhibits to Dropbox files ──
      // Uses Claude on the server to intelligently match descriptions to filenames.
      // Shows a review dialog before applying so JJ can approve/reject each match.
      async function autoMatchDropboxExhibits() {
        const clientName = (document.querySelector('[name="client_name"]')?.value || "").trim();
        const aNumber    = (document.querySelector('[name="a_number"]')?.value    || "").trim();
        if (!clientName && !aNumber) {
          alert("Enter the client name (or A-Number) at the top of the form first.");
          return;
        }

        // Gather unlinked exhibits
        const rows = Array.from(document.querySelectorAll('#exhibits-tbody tr'));
        const unlinked = [];
        for (const row of rows) {
          const idx = row.dataset.exhibitIdx;
          const currentLink = document.querySelector('[name="exhibit_dropbox_file_path_' + idx + '"]')?.value;
          if (currentLink) continue;   // skip already-linked
          const desc = document.querySelector('[name="exhibit_description_' + idx + '"]')?.value || "";
          const eoir = document.querySelector('[name="exhibit_eoir_submission_' + idx + '"]')?.value || "";
          const num = document.querySelector('[name="exhibit_number_' + idx + '"]')?.value || "";
          if (!desc.trim()) continue;   // skip empty
          unlinked.push({ idx, description: desc, eoir_submission: eoir, exhibit_number: num });
        }

        if (!unlinked.length) {
          alert("Nothing to auto-match. All exhibit rows are either linked or have empty descriptions.");
          return;
        }

        const btn = document.getElementById("dbx-automatch-btn");
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "🤖 Asking Claude to match…";

        try {
          const resp = await fetch("/admin/hearing/individual/dropbox/auto-match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_name: clientName,
              a_number: aNumber,
              exhibits: unlinked,
            }),
          });
          const data = await resp.json();
          if (!data.ok) {
            alert("Auto-match failed: " + (data.error || "unknown error"));
            return;
          }
          if (!data.matches || !data.matches.length) {
            alert(data.warning || "No files found in Dropbox folder.");
            return;
          }
          showMatchReviewDialog(data.matches, data.total_files, data.folder);
        } catch (e) {
          alert("Auto-match error: " + e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = origText;
        }
      }

      // Show a modal with all Claude's proposed matches. User can approve
      // all, approve high-confidence only, or approve individually.
      function showMatchReviewDialog(matches, totalFiles, folder) {
        // Categorize
        const high = matches.filter(m => m.confidence === "high");
        const medium = matches.filter(m => m.confidence === "medium");
        const low = matches.filter(m => m.confidence === "low");
        const none = matches.filter(m => m.confidence === "none");

        const confBadge = (conf) => {
          const colors = { high: "#2e7d32", medium: "#e65100", low: "#c62828", none: "#888" };
          const labels = { high: "high", medium: "medium", low: "low", none: "no match" };
          return '<span style="background:' + colors[conf] + '; color:white; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600;">' + labels[conf] + '</span>';
        };

        const rowHTML = matches.map((m, i) => {
          const shortPath = m.dropbox_file_path ? m.dropbox_file_path.split("/").slice(-2).join("/") : "";
          const filenamePart = m.matched_filename
            ? '<div style="font-size:13px; color:#0C1C36;">📎 <strong>' + escapeHTML(m.matched_filename) + '</strong></div>' +
              '<div style="font-size:10px; color:#888; font-family:monospace;">' + escapeHTML(shortPath) + '</div>'
            : '<div style="font-size:13px; color:#c00; font-style:italic;">No match found</div>';
          const disabledAttr = m.confidence === "none" ? "disabled" : "";
          const checkedAttr = (m.confidence === "high" || m.confidence === "medium") ? "checked" : "";
          return '<tr>' +
            '<td style="padding:8px; vertical-align:top;">' +
              '<input type="checkbox" class="match-check" data-i="' + i + '" ' + checkedAttr + ' ' + disabledAttr + ' style="transform:scale(1.3);">' +
            '</td>' +
            '<td style="padding:8px;">' +
              '<div style="font-size:13px; color:#0C1C36; font-weight:600;">' + escapeHTML(m.description || "(no description)") + '</div>' +
            '</td>' +
            '<td style="padding:8px;">' + confBadge(m.confidence) + '</td>' +
            '<td style="padding:8px;">' + filenamePart + '</td>' +
            '<td style="padding:8px; font-size:11px; color:#666; font-style:italic; max-width:200px;">' + escapeHTML(m.reason || "") + '</td>' +
          '</tr>';
        }).join("");

        const modal = document.createElement("div");
        modal.id = "match-review-modal";
        modal.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:10000; display:flex; align-items:center; justify-content:center; padding:20px;";
        modal.innerHTML =
          '<div style="background:white; border-radius:8px; width:min(900px, 100%); max-height:90vh; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.3);">' +
            '<div style="padding:16px 20px; border-bottom:1px solid #eee;">' +
              '<div style="display:flex; justify-content:space-between; align-items:center;">' +
                '<h3 style="margin:0; color:#0C1C36; font-size:16px;">🤖 Review Auto-Match Suggestions</h3>' +
                '<button type="button" onclick="closeMatchReview()" style="background:none; border:none; font-size:24px; color:#666; cursor:pointer;">×</button>' +
              '</div>' +
              '<div style="font-size:12px; color:#666; margin-top:4px;">' +
                'Scanned <strong>' + totalFiles + '</strong> files in <code style="font-size:11px;">' + escapeHTML(folder) + '</code>. ' +
                '<span style="color:#2e7d32;">' + high.length + ' high</span> · ' +
                '<span style="color:#e65100;">' + medium.length + ' medium</span> · ' +
                '<span style="color:#c62828;">' + low.length + ' low</span> · ' +
                '<span style="color:#888;">' + none.length + ' no match</span>' +
              '</div>' +
            '</div>' +
            '<div style="padding:10px 20px; background:#f9f9f9; border-bottom:1px solid #eee; display:flex; gap:8px; flex-wrap:wrap;">' +
              '<button type="button" onclick="selectMatchesByConfidence([\\'high\\'])" style="background:#e8f5e9; color:#2e7d32; border:1px solid #2e7d32; padding:5px 10px; border-radius:3px; cursor:pointer; font-size:12px;">Only high confidence</button>' +
              '<button type="button" onclick="selectMatchesByConfidence([\\'high\\', \\'medium\\'])" style="background:#fff3e0; color:#e65100; border:1px solid #e65100; padding:5px 10px; border-radius:3px; cursor:pointer; font-size:12px;">High + medium (default)</button>' +
              '<button type="button" onclick="selectMatchesByConfidence([\\'high\\', \\'medium\\', \\'low\\'])" style="background:#f5f5f5; color:#333; border:1px solid #999; padding:5px 10px; border-radius:3px; cursor:pointer; font-size:12px;">All including low</button>' +
              '<button type="button" onclick="selectMatchesByConfidence([])" style="background:white; color:#333; border:1px solid #ccc; padding:5px 10px; border-radius:3px; cursor:pointer; font-size:12px;">None</button>' +
            '</div>' +
            '<div style="overflow-y:auto; flex:1; padding:0;">' +
              '<table style="width:100%; border-collapse:collapse; font-size:13px;">' +
                '<thead style="background:#f5f5f5; position:sticky; top:0;">' +
                  '<tr>' +
                    '<th style="padding:8px; width:40px; text-align:center;">Apply</th>' +
                    '<th style="padding:8px; text-align:left;">Exhibit</th>' +
                    '<th style="padding:8px; width:80px;">Confidence</th>' +
                    '<th style="padding:8px; text-align:left;">Matched File</th>' +
                    '<th style="padding:8px; text-align:left;">Claude\\'s reason</th>' +
                  '</tr>' +
                '</thead>' +
                '<tbody>' + rowHTML + '</tbody>' +
              '</table>' +
            '</div>' +
            '<div style="padding:12px 20px; border-top:1px solid #eee; display:flex; justify-content:space-between; align-items:center; gap:10px; background:#f9f9f9;">' +
              '<span style="font-size:12px; color:#666;">💡 Uncheck any match you don\\'t want to apply</span>' +
              '<div style="display:flex; gap:8px;">' +
                '<button type="button" onclick="closeMatchReview()" style="background:#eee; color:#333; padding:9px 16px; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Cancel</button>' +
                '<button type="button" onclick="applyMatches()" style="background:#0061FF; color:white; padding:9px 16px; border:none; border-radius:4px; cursor:pointer; font-size:13px; font-weight:600;">Apply selected matches</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        modal._matches = matches;
        document.body.appendChild(modal);
      }

      function selectMatchesByConfidence(allowedLevels) {
        const modal = document.getElementById("match-review-modal");
        const matches = modal._matches;
        document.querySelectorAll(".match-check").forEach(cb => {
          const m = matches[parseInt(cb.dataset.i)];
          if (cb.disabled) return;   // no-match rows can't be selected
          cb.checked = allowedLevels.includes(m.confidence);
        });
      }

      function closeMatchReview() {
        const modal = document.getElementById("match-review-modal");
        if (modal) modal.remove();
      }

      function applyMatches() {
        const modal = document.getElementById("match-review-modal");
        const matches = modal._matches;
        let applied = 0;
        document.querySelectorAll(".match-check:checked").forEach(cb => {
          const m = matches[parseInt(cb.dataset.i)];
          if (m && m.dropbox_file_path) {
            setExhibitLinkedPath(m.idx, m.dropbox_file_path);
            applied++;
          }
        });
        closeMatchReview();
        // Brief toast in the corner
        const toast = document.createElement("div");
        toast.style.cssText = "position:fixed; top:20px; right:20px; background:#2e7d32; color:white; padding:12px 20px; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.2); z-index:10001; font-size:14px;";
        toast.textContent = "✓ Applied " + applied + " match" + (applied === 1 ? "" : "es") + ". Remember to save the form.";
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
      }


      // ── Examinations (with sections) ────────────────────
      let examCounter = 0;
      function addExamination(data) {
        data = data || {};
        const idx = examCounter++;
        let role = data.witness_role || "";
        let name = data.witness_name || "";
        if (!role && !name && data.witness) {
          const m = String(data.witness).match(/^(Respondent|Spouse|Additional witness)\\s*\\(([^)]+)\\)\\s*$/i);
          if (m) { role = m[1]; name = m[2]; }
          else { role = "Respondent"; name = data.witness; }
        }
        if (!role) role = "Respondent";

        const wrap = document.createElement("div");
        wrap.dataset.examIdx = idx;
        wrap.style.cssText = "border:1px solid #ddd; padding:12px; margin:12px 0; border-radius:4px; background:#fafafa;";
        wrap.innerHTML =
          '<div style="display:flex; gap:8px; margin-bottom:8px; align-items:center; flex-wrap:wrap;">' +
            '<label style="font-weight:600; flex:0 0 auto;">Witness:</label>' +
            '<select name="exam_witness_role_' + idx + '" style="padding:6px; min-width:180px;">' +
              witnessRoleOpt("Respondent", role) +
              witnessRoleOpt("Spouse", role) +
              witnessRoleOpt("Additional witness", role) +
            '</select>' +
            '<input type="text" name="exam_witness_name_' + idx + '" value="' + escapeHTML(name) + '" placeholder="Name (optional)" style="flex:1; min-width:180px; padding:6px;">' +
            '<label style="font-weight:600; flex:0 0 auto;">Type:</label>' +
            '<select name="exam_type_' + idx + '" style="padding:6px;">' +
              opt("direct", "Direct examination", data.examination_type) +
              opt("cross", "Cross examination", data.examination_type) +
              opt("redirect", "Redirect", data.examination_type) +
              opt("recross", "Recross", data.examination_type) +
              opt("judge", "Judge examination", data.examination_type) +
              opt("other", "Other", data.examination_type) +
            '</select>' +
            '<button type="button" onclick="this.closest(\\'div[data-exam-idx]\\').remove()" style="background:#c00; color:white; border:none; padding:6px 10px; cursor:pointer; border-radius:3px;">Remove witness</button>' +
          '</div>' +
          '<div data-sections-container="' + idx + '"></div>' +
          '<button type="button" onclick="addSection(' + idx + ')" style="background:#0C1C36; color:white; padding:6px 12px; border:none; cursor:pointer; border-radius:3px; font-size:13px; margin-top:8px;">+ Add section</button>';
        document.getElementById("exams-container").appendChild(wrap);

        // Normalize sections (support old qa_rows and new sections)
        let sections = data.sections;
        if (!sections || !sections.length) {
          if (data.qa_rows && data.qa_rows.length) sections = [{ title: "Testimony", qa_rows: data.qa_rows }];
          else sections = [{ title: "Testimony", qa_rows: [] }];
        }
        sections.forEach(s => addSection(idx, s));
      }
      let sectionCounters = {};
      function addSection(examIdx, sectionData) {
        sectionData = sectionData || { title: "", qa_rows: [] };
        if (!(examIdx in sectionCounters)) sectionCounters[examIdx] = 0;
        const sIdx = sectionCounters[examIdx]++;
        const container = document.querySelector('div[data-sections-container="' + examIdx + '"]');
        if (!container) return;

        const secDiv = document.createElement("div");
        secDiv.dataset.sectionIdx = sIdx;
        secDiv.style.cssText = "border:1px solid #ccc; border-left:3px solid #B79C62; padding:10px; margin:10px 0; background:white; border-radius:3px;";
        secDiv.innerHTML =
          '<div style="display:flex; gap:8px; margin-bottom:6px; align-items:center;">' +
            '<label style="font-weight:600; font-size:13px; color:#B79C62; flex:0 0 auto;">Section:</label>' +
            '<input type="text" name="exam_' + examIdx + '_section_' + sIdx + '_title" value="' + escapeHTML(sectionData.title || "") + '" placeholder="e.g. Background, Persecution, Fear of return" style="flex:1; padding:5px; font-weight:600;">' +
            '<button type="button" onclick="this.closest(\\'div[data-section-idx]\\').remove()" style="background:#eee; color:#c00; border:none; padding:4px 10px; cursor:pointer; border-radius:3px; font-size:12px;">Remove section</button>' +
          '</div>' +
          '<table style="width:100%; font-size:13px;">' +
            '<thead><tr>' +
              '<th style="width:35%; text-align:left; padding:4px;">Question</th>' +
              '<th style="width:35%; text-align:left; padding:4px;">Answer</th>' +
              '<th style="width:25%; text-align:left; padding:4px;">Judge Q / Notes</th>' +
              '<th style="width:30px;"></th>' +
            '</tr></thead>' +
            '<tbody data-section-rows="' + examIdx + '_' + sIdx + '"></tbody>' +
          '</table>' +
          '<button type="button" onclick="addQARow(' + examIdx + ', ' + sIdx + ')" style="background:#eee; padding:4px 10px; border:none; cursor:pointer; border-radius:3px; font-size:12px; margin-top:4px;">+ Add Q&amp;A row</button>';
        container.appendChild(secDiv);

        const rows = sectionData.qa_rows || [];
        rows.forEach(r => addQARow(examIdx, sIdx, r));
        if (!rows.length) addQARow(examIdx, sIdx);
      }
      function addQARow(examIdx, sectionIdx, row) {
        row = row || {};
        const tbody = document.querySelector('tbody[data-section-rows="' + examIdx + '_' + sectionIdx + '"]');
        if (!tbody) return;
        const rowIdx = tbody.querySelectorAll("tr").length;
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td style="vertical-align:top; padding:4px;"><textarea name="exam_' + examIdx + '_section_' + sectionIdx + '_q_' + rowIdx + '" rows="2" style="width:100%; font-family:inherit; font-size:13px;">' + escapeHTML(row.question || "") + '</textarea></td>' +
          '<td style="vertical-align:top; padding:4px;"><textarea name="exam_' + examIdx + '_section_' + sectionIdx + '_a_' + rowIdx + '" rows="2" style="width:100%; font-family:inherit; font-size:13px;">' + escapeHTML(row.expected_answer || "") + '</textarea></td>' +
          '<td style="vertical-align:top; padding:4px;"><textarea name="exam_' + examIdx + '_section_' + sectionIdx + '_jn_' + rowIdx + '" rows="2" style="width:100%; font-family:inherit; font-size:13px;">' + escapeHTML(row.judge_notes || "") + '</textarea></td>' +
          '<td style="vertical-align:top; padding:4px;"><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:#eee; border:none; padding:2px 6px; cursor:pointer; border-radius:3px;">×</button></td>';
        tbody.appendChild(tr);
      }
      function clearExaminations() {
        document.getElementById("exams-container").innerHTML = "";
        examCounter = 0;
        sectionCounters = {};
      }
      function opt(v, l, current) { return '<option value="' + v + '"' + (current === v ? " selected" : "") + '>' + l + '</option>'; }
      function witnessRoleOpt(v, current) { return '<option value="' + v + '"' + (current === v ? " selected" : "") + '>' + v + '</option>'; }
      function escapeHTML(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
      function escapeAttr(s) { return escapeHTML(s); }

      // Initialize with existing data
      INITIAL_EXHIBITS.forEach(e => addExhibitRow(e));
      if (!INITIAL_EXHIBITS.length) addExhibitRow();
      INITIAL_EXAMS.forEach(e => addExamination(e));
      if (!INITIAL_EXAMS.length) addExamination({ witness_role: "Respondent", witness_name: "", examination_type: "direct" });

      // ── Load from prior master hearing ──────────────────
      async function loadFromPriorHearing() {
        const name = document.querySelector('[name="client_name"]').value.trim();
        const anum = document.querySelector('[name="a_number"]').value.trim();
        const status = document.getElementById("prior-hearing-status");
        if (!name && !anum) {
          status.innerHTML = '<span style="color:#c00;">Enter client name or A-Number first.</span>';
          return;
        }
        status.innerHTML = 'Searching...';
        try {
          const params = new URLSearchParams();
          if (name) params.set("name", name);
          if (anum) params.set("a", anum);
          const resp = await fetch("/admin/hearing/individual/prior-lookup?" + params);
          const data = await resp.json();
          if (!data.ok || !data.note) {
            status.innerHTML = '<span style="color:#c00;">No prior hearing found for this client.</span>';
            return;
          }
          const n = data.note;
          fillIfEmpty("client_name", n.client_name);
          fillIfEmpty("a_number", n.a_number);
          fillIfEmpty("client_email", n.client_email);
          fillIfEmpty("client_phone", n.client_phone);
          fillIfEmpty("case_type", n.case_type);
          fillIfEmpty("judge_name", n.judge_name);
          fillIfEmpty("dhs_attorney", n.dhs_attorney);
          const langEl = document.querySelector('[name="client_language"]');
          if (langEl && langEl.value === "en" && n.client_language) langEl.value = n.client_language;
          status.innerHTML = '<span style="color:#4CAF50;">✅ Loaded from master hearing #' + n.id + ' (' + new Date(n.created_at).toLocaleDateString() + ')</span>';
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">Error: ' + e.message + '</span>';
        }
      }
      function fillIfEmpty(name, val) {
        if (!val) return;
        const el = document.querySelector('[name="' + name + '"]');
        if (el && !el.value.trim()) {
          el.value = val;
          el.style.backgroundColor = "#fffde7";
        }
      }

      // ── Drag / drop ─────────────────────────────────────
      function dragOver(e, id) { e.preventDefault(); e.stopPropagation(); document.getElementById(id).style.background = "#faedd5"; }
      function dragLeave(e, id) { e.preventDefault(); e.stopPropagation(); document.getElementById(id).style.background = "#fdf7f0"; }
      function dropSummary(e) { e.preventDefault(); e.stopPropagation(); document.getElementById("summary-drop").style.background = "#fdf7f0"; if (e.dataTransfer.files[0]) uploadSummary(e.dataTransfer.files[0]); }
      function dropExhibits(e) { e.preventDefault(); e.stopPropagation(); document.getElementById("exhibits-drop").style.background = "#fdf7f0"; if (e.dataTransfer.files[0]) uploadExhibits(e.dataTransfer.files[0]); }

      // ── Upload hearing summary ──────────────────────────
      async function uploadSummary(file) {
        if (!file) return;
        const status = document.getElementById("summary-status");
        status.innerHTML = '<span style="color:#666;">⏳ Uploading and extracting from ' + escapeHTML(file.name) + '... 30-60 seconds</span>';
        console.log("[uploadSummary] file:", file.name, "type:", file.type, "size:", file.size);

        let fd;
        try {
          fd = new FormData();
          const originalName = file.name || "summary";
          const safeName = originalName.replace(/[^\\w.\\-]/g, "_");
          if (safeName !== originalName) {
            console.log("[uploadSummary] renaming for upload:", originalName, "→", safeName);
            const renamed = new File([file], safeName, { type: file.type || "application/octet-stream" });
            fd.append("summary", renamed);
          } else {
            fd.append("summary", file);
          }
        } catch (prepErr) {
          console.error("[uploadSummary] file prep failed:", prepErr);
          status.innerHTML = '<span style="color:#c00;">❌ Cannot read file: ' + escapeHTML(prepErr.message || String(prepErr)) + '</span>';
          return;
        }

        try {
          const resp = await fetch("/admin/hearing/individual/extract-summary", { method: "POST", body: fd });
          let data;
          try {
            data = await resp.json();
          } catch (jsonErr) {
            const text = await resp.text().catch(() => "(no response body)");
            console.error("[uploadSummary] server returned non-JSON:", resp.status, text.substring(0, 500));
            status.innerHTML = '<span style="color:#c00;">❌ Server error ' + resp.status + ' — check console for details</span>';
            return;
          }
          if (!data.ok) { status.innerHTML = '<span style="color:#c00;">❌ ' + escapeHTML(data.error || "Extraction failed") + '</span>'; return; }
          // If server returned a warning, show it — the file was read but AI extraction had issues
          if (data.warning) {
            status.innerHTML =
              '<span style="color:#ff9800;">⚠️ File extracted but AI structuring had issues. ' +
              'Raw text saved — you can copy sections into the form manually. ' +
              'Details: ' + escapeHTML(data.warning) + '</span>';
            // Still save the raw so it's available on the hidden field
            const raw = data.raw_text || "";
            if (raw) document.getElementById("hearing_summary_raw").value = raw;
            return;
          }
          // Populate client / case / judge fields from extracted client_info
          // (only fills empty fields, doesn't overwrite what's already there)
          const ci = data.extracted.client_info || {};
          let filledInfo = 0;
          const infoMap = {
            client_name:           ci.client_name,
            a_number:              ci.a_number,
            client_email:          ci.client_email,
            client_phone:          ci.client_phone,
            client_address:        ci.client_address,
            case_type:             ci.case_type,
            hearing_date:          ci.hearing_date,
            judge_name:            ci.judge_name,
            court_location:        ci.court_location,
            court_address:         ci.court_address,
            dhs_attorney:          ci.dhs_attorney,
            attorney_appearance:   ci.attorney_appearance,
            respondent_appearance: ci.respondent_appearance,
          };
          for (const [fieldName, val] of Object.entries(infoMap)) {
            if (!val) continue;
            const el = document.querySelector('[name="' + fieldName + '"]');
            if (el && !el.value.trim()) {
              el.value = val;
              el.style.backgroundColor = "#fffde7";  // highlight auto-filled
              filledInfo++;
            }
          }
          // Populate examinations from extracted structure
          if (data.extracted.examinations && data.extracted.examinations.length) {
            if (confirm("Extracted " + data.extracted.examinations.length + " examination section(s). Replace current examinations?")) {
              clearExaminations();
              data.extracted.examinations.forEach(e => addExamination(e));
            } else {
              data.extracted.examinations.forEach(e => addExamination(e));
            }
          }
          // Populate closing argument
          if (data.extracted.closing_argument) {
            const closeEl = document.querySelector('[name="closing_argument"]');
            if (!closeEl.value.trim() || confirm("Replace current closing argument with extracted version?")) {
              closeEl.value = data.extracted.closing_argument;
              closeEl.style.backgroundColor = "#fffde7";
            }
          }
          // Save raw for reference
          const raw = data.raw_text || "";
          if (raw) document.getElementById("hearing_summary_raw").value = raw;
          status.innerHTML = '<span style="color:#4CAF50;">✅ Extracted ' + (data.extracted.examinations || []).length + ' exam section(s), ' + (data.extracted.closing_argument ? "closing argument, " : "") + '' + (data.extracted.witnesses || []).length + ' witness(es)' + (filledInfo ? ", " + filledInfo + " client/court field(s) auto-filled" : "") + '.</span>';
        } catch (e) {
          console.error("[uploadSummary] fetch/network error:", e);
          status.innerHTML = '<span style="color:#c00;">❌ ' + escapeHTML(e.message || String(e) || "Upload failed") + ' — check browser console for details</span>';
        }
      }

      // ── Upload exhibits ─────────────────────────────────
      async function uploadExhibits(file) {
        if (!file) return;
        const status = document.getElementById("exhibits-status");
        status.innerHTML = '<span style="color:#666;">⏳ Parsing ' + escapeHTML(file.name) + '... (' + Math.round(file.size / 1024) + ' KB)</span>';
        console.log("[uploadExhibits] file:", file.name, "type:", file.type, "size:", file.size);

        // Some browsers reject FormData when filenames contain unusual characters.
        // Sanitize to ASCII-safe name; keeps extension intact.
        let fd;
        try {
          fd = new FormData();
          const originalName = file.name || "exhibits.xlsx";
          const safeName = originalName.replace(/[^\\w.\\-]/g, "_");
          if (safeName !== originalName) {
            console.log("[uploadExhibits] renaming for upload:", originalName, "→", safeName);
            const renamed = new File([file], safeName, { type: file.type || "application/octet-stream" });
            fd.append("exhibits", renamed);
          } else {
            fd.append("exhibits", file);
          }
        } catch (prepErr) {
          console.error("[uploadExhibits] file prep failed:", prepErr);
          status.innerHTML = '<span style="color:#c00;">❌ Cannot read file: ' + escapeHTML(prepErr.message || String(prepErr)) + '</span>';
          return;
        }

        try {
          const resp = await fetch("/admin/hearing/individual/extract-exhibits", { method: "POST", body: fd });
          let data;
          try {
            data = await resp.json();
          } catch (jsonErr) {
            const text = await resp.text().catch(() => "(no response body)");
            console.error("[uploadExhibits] server returned non-JSON:", resp.status, text.substring(0, 500));
            status.innerHTML = '<span style="color:#c00;">❌ Server error ' + resp.status + ' — check console for details</span>';
            return;
          }
          if (!data.ok) { status.innerHTML = '<span style="color:#c00;">❌ ' + escapeHTML(data.error || "Parse failed") + '</span>'; return; }
          if (!data.exhibits.length) { status.innerHTML = '<span style="color:#ff9800;">⚠️ No exhibits detected in file. Check that headers are in row 1.</span>'; return; }
          if (confirm("Parsed " + data.exhibits.length + " exhibit rows from sheet \\"" + (data.sheet_name || "?") + "\\". Replace current exhibits?")) {
            clearExhibits();
            data.exhibits.forEach(e => addExhibitRow(e));
          } else {
            data.exhibits.forEach(e => addExhibitRow(e));
          }
          status.innerHTML = '<span style="color:#4CAF50;">✅ Loaded ' + data.exhibits.length + ' exhibit rows.</span>';
        } catch (e) {
          console.error("[uploadExhibits] fetch/network error:", e);
          status.innerHTML = '<span style="color:#c00;">❌ ' + escapeHTML(e.message || String(e) || "Upload failed") + ' — check browser console for details</span>';
        }
      }

      // ── Generate summaries ──────────────────────────────
      async function generateSummaries(id) {
        const status = document.getElementById("gen-status");
        status.innerHTML = '<span style="color:#666;">⏳ Generating summaries... 15-30s</span>';
        try {
          const resp = await fetch("/admin/hearing/individual/" + id + "/generate-summaries", { method: "POST" });
          const data = await resp.json();
          if (data.ok) {
            status.innerHTML = '<span style="color:#4CAF50;">✅ Summaries generated. Reloading...</span>';
            setTimeout(() => window.location.reload(), 800);
          } else {
            status.innerHTML = '<span style="color:#c00;">❌ ' + (data.error || "Generation failed") + '</span>';
          }
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
        }
      }

      // ── Send to team group ──────────────────────────────
      async function sendToTeam(id) {
        const status = document.getElementById("send-status");
        status.textContent = "Sending...";
        status.style.color = "#666";
        try {
          const resp = await fetch("/admin/hearing/individual/" + id + "/send-paralegal", { method: "POST" });
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

      // ── Delete note ─────────────────────────────────────
      async function deleteThisNote(id, clientName) {
        if (!confirm("Delete individual hearing note #" + id + " for " + clientName + "?\\n\\nThis cannot be undone.")) return;
        try {
          const resp = await fetch("/admin/hearing/individual/" + id, { method: "DELETE" });
          const data = await resp.json();
          if (data.ok) {
            window.location.href = "/admin/hearing/individual/history";
          } else {
            alert("❌ Delete failed: " + (data.error || "unknown error"));
          }
        } catch (e) {
          alert("❌ Delete error: " + e.message);
        }
      }

      // ── Copy helper ─────────────────────────────────────
      function copyEl(id) {
        const el = document.getElementById(id);
        navigator.clipboard.writeText(el.textContent);
        const status = document.createElement("span");
        status.textContent = " ✅ Copied";
        status.style.color = "#4CAF50";
        status.style.marginLeft = "8px";
        el.parentElement.appendChild(status);
        setTimeout(() => status.remove(), 2000);
      }

      // ── Auto-save (edit mode only) ──────────────────────
      const AUTOSAVE_NOTE_ID = ${noteId ? noteId : "null"};
      let formDirty = false;
      let lastSaveAt = Date.now();
      let autosaveInFlight = false;

      if (AUTOSAVE_NOTE_ID) {
        const form = document.getElementById("ih-form");
        const status = document.getElementById("autosave-status");

        // Any input change marks the form as dirty
        const markDirty = () => { formDirty = true; };
        form.addEventListener("input", markDirty);
        form.addEventListener("change", markDirty);

        // Every 5s: if dirty, save
        setInterval(async () => {
          if (!formDirty || autosaveInFlight) return;
          autosaveInFlight = true;
          formDirty = false;
          const startedAt = Date.now();
          status.textContent = "Auto-saving...";
          status.style.color = "#666";
          try {
            const fd = new FormData(form);
            const resp = await fetch("/admin/hearing/individual/" + AUTOSAVE_NOTE_ID + "/autosave", {
              method: "POST",
              body: new URLSearchParams(fd),  // uses urlencoded; matches body parser
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
            const data = await resp.json();
            if (data.ok) {
              lastSaveAt = Date.now();
              status.textContent = "✓ Auto-saved just now";
              status.style.color = "#4CAF50";
            } else if (data.skip) {
              // Missing required field — silent skip, retry next cycle
              formDirty = true;
              status.textContent = "⚠️ " + data.error;
              status.style.color = "#ff9800";
            } else {
              formDirty = true;  // save failed, retry
              status.textContent = "❌ Auto-save failed: " + (data.error || "unknown");
              status.style.color = "#c00";
            }
          } catch (e) {
            formDirty = true;
            status.textContent = "❌ Auto-save error: " + e.message;
            status.style.color = "#c00";
          } finally {
            autosaveInFlight = false;
          }
        }, 5000);

        // Update relative timestamp every second
        setInterval(() => {
          if (formDirty || autosaveInFlight) return;
          const secs = Math.floor((Date.now() - lastSaveAt) / 1000);
          if (secs < 5) return;  // let the "just now" message stay
          const label = secs < 60 ? secs + "s ago"
                      : secs < 3600 ? Math.floor(secs / 60) + "m ago"
                      : Math.floor(secs / 3600) + "h ago";
          status.textContent = "✓ Auto-saved " + label;
          status.style.color = "#888";
        }, 1000);

        // Warn on navigation away with unsaved changes
        window.addEventListener("beforeunload", (e) => {
          if (formDirty || autosaveInFlight) {
            e.preventDefault();
            e.returnValue = "You have unsaved changes. Leave anyway?";
            return e.returnValue;
          }
        });
      }
    </script>`;

  return hearingNotes.renderAdminChrome({
    title: "Individual Hearing",
    body,
    activeItem: "individual",
  });
}

// Convert an ISO timestamp string to the `YYYY-MM-DDTHH:MM` local format
// that <input type="datetime-local"> expects
function isoToLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = n => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── History page ─────────────────────────────────────────

function renderHistoryPage(notes) {
  const rows = notes.length ? notes.map(n => {
    const sentClass = n.sent_to_paralegal_at ? "sent" : "unsent";
    return `
    <tr class="ih-row"
        data-name="${escapeAttr((n.client_name || "").toLowerCase())}"
        data-anumber="${escapeAttr((n.a_number || "").toLowerCase().replace(/[-\s]/g, ""))}"
        data-judge="${escapeAttr((n.judge_name || "").toLowerCase())}"
        data-sent="${sentClass}"
        data-lang="${escapeAttr(n.client_language || "")}">
      <td>#${n.id}</td>
      <td>${escapeHtml(n.client_name)}</td>
      <td>${escapeHtml(n.a_number || "")}</td>
      <td>${n.hearing_date ? new Date(n.hearing_date).toLocaleDateString() : "-"}</td>
      <td>${escapeHtml(n.judge_name || "-")}</td>
      <td>${n.client_language}</td>
      <td>${n.sent_to_paralegal_at ? "✅" : "—"}</td>
      <td>${new Date(n.created_at).toLocaleDateString()}</td>
      <td>
        <a href="/admin/hearing/individual/${n.id}" style="color:#B79C62;">edit</a>
        &nbsp;·&nbsp;
        <a href="#" onclick="delRow(${n.id}, ${JSON.stringify(n.client_name).replace(/"/g, '&quot;')}); return false;" style="color:#c00; font-size:12px;">🗑️</a>
      </td>
    </tr>`;
  }).join("") : `<tr id="no-data-row"><td colspan="9" style="text-align:center; color:#888;">No individual hearing notes yet.</td></tr>`;

  const body = `
    <div class="page-header">
      <h1>📖 Individual Hearing History</h1>
      <a href="/admin/hearing/individual" class="back-link">← Back to prep tool</a>
    </div>

    <div style="background:white; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #eee;">
      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        <div style="flex:1; min-width:260px;">
          <input type="text" id="search-input" placeholder="🔍 Search by client name or A-Number..."
                 onkeyup="filterRows()"
                 style="width:100%; padding:9px 12px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
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
          <th>ID</th><th>Client</th><th>A#</th><th>Hearing</th>
          <th>Judge</th><th>Lang</th><th>Sent</th><th>Created</th><th></th>
        </tr>
      </thead>
      <tbody id="rows-body">${rows}</tbody>
    </table>

    <script>
      const TOTAL = ${notes.length};
      function filterRows() {
        const search = document.getElementById("search-input").value.toLowerCase().replace(/[-\\s]/g, "");
        const sent = document.getElementById("filter-sent").value;
        const lang = document.getElementById("filter-lang").value;
        let visible = 0;
        document.querySelectorAll(".ih-row").forEach(row => {
          const name = row.dataset.name || "";
          const anumber = row.dataset.anumber || "";
          const judge = row.dataset.judge || "";
          const rowSent = row.dataset.sent || "";
          const rowLang = row.dataset.lang || "";
          const matchesSearch = !search || name.includes(search) || anumber.includes(search) || judge.includes(search);
          const matchesSent = !sent || rowSent === sent;
          const matchesLang = !lang || rowLang === lang;
          const show = matchesSearch && matchesSent && matchesLang;
          row.style.display = show ? "" : "none";
          if (show) visible++;
        });
        const count = document.getElementById("row-count");
        if (visible === TOTAL) count.textContent = "Showing " + TOTAL + " note" + (TOTAL === 1 ? "" : "s");
        else count.textContent = "Showing " + visible + " of " + TOTAL + " notes";
      }
      function clearFilters() {
        document.getElementById("search-input").value = "";
        document.getElementById("filter-sent").value = "";
        document.getElementById("filter-lang").value = "";
        filterRows();
      }
      async function delRow(id, name) {
        if (!confirm("Delete individual hearing note #" + id + " for " + name + "?")) return;
        try {
          const resp = await fetch("/admin/hearing/individual/" + id, { method: "DELETE" });
          const data = await resp.json();
          if (data.ok) {
            const rows = document.querySelectorAll('.ih-row');
            for (const r of rows) {
              if (r.querySelector('a[href*="/' + id + '"]')) { r.remove(); break; }
            }
            filterRows();
          } else {
            alert("❌ " + (data.error || "delete failed"));
          }
        } catch (e) { alert("❌ " + e.message); }
      }
    </script>`;

  return hearingNotes.renderAdminChrome({
    title: "Individual Hearing History",
    body,
    activeItem: "individual-history",
  });
}

// ── Utilities ────────────────────────────────────────────

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Exports ──────────────────────────────────────────────

// ──────────────────────────────────────────────────────────
// Clone this note as a continuation merits hearing.
// Duplicates every field (client info, prep notes, exhibits, examinations,
// evidence objections, disposition, etc.) so the attorney only has to update
// what's new for the continuation. The new note gets:
//   - hearing_date = provided newHearingDate (with optional time)
//   - continuation_of = original id
//   - continuation_number = next in sequence for this chain
//   - a leading note appended to pre_examination_notes explaining lineage
// Returns { new_id }.
async function cloneAsContinuation(originalId, { newHearingDate, newHearingTime, notes }) {
  await initTables();

  const orig = await getIndividualNote(originalId);
  if (!orig) throw new Error(`Original hearing note #${originalId} not found`);

  // Walk continuation chain: root = the earliest ancestor (continuation_of null)
  // continuation_number = max in chain + 1
  const chainRootId = orig.continuation_of || orig.id;
  const chain = await db.query(
    `SELECT id, hearing_date, continuation_number
     FROM individual_hearing_notes
     WHERE id = $1 OR continuation_of = $1
     ORDER BY COALESCE(continuation_number, 1) ASC, hearing_date ASC NULLS LAST, id ASC`,
    [chainRootId]
  );
  const nextNumber = (chain.rows.reduce((m, r) => Math.max(m, r.continuation_number || 0), 0) || 1) + 1;

  // Build merged hearing_date TS from newHearingDate (+ optional time)
  const mergedDate = newHearingTime
    ? `${newHearingDate} ${newHearingTime}`
    : `${newHearingDate} 09:00`;

  // Prepend continuation banner note so the attorney sees provenance in-app
  const banner = `[Continuation #${nextNumber} — cloned from hearing #${originalId} on ${orig.hearing_date ? new Date(orig.hearing_date).toLocaleDateString() : "(no date)"}${notes ? `. Note: ${notes}` : ""}]\n\n`;
  const clonedPreNotes = banner + (orig.pre_examination_notes || "");

  const r = await db.query(
    `INSERT INTO individual_hearing_notes
       (client_name, a_number, hearing_date, hearing_type, courtroom, judge_name,
        pre_examination_notes, examinations, evidence_objections, exhibits,
        hearing_summary_raw, disposition_notes, paralegal_summary, client_summary,
        attorney_appearance, respondent_appearance, next_hearing_date, next_hearing_type,
        client_address, continuation_of, continuation_number)
     VALUES ($1, $2, $3::timestamptz, $4, $5, $6,
             $7, $8::jsonb, $9, $10::jsonb,
             $11, $12, NULL, NULL,
             $13, $14, NULL, NULL,
             $15, $16, $17)
     RETURNING id`,
    [
      orig.client_name, orig.a_number, mergedDate, orig.hearing_type || "individual_merits",
      orig.courtroom, orig.judge_name,
      clonedPreNotes,
      JSON.stringify(orig.examinations || []),
      orig.evidence_objections,
      JSON.stringify(orig.exhibits || []),
      orig.hearing_summary_raw, orig.disposition_notes,
      orig.attorney_appearance, orig.respondent_appearance,
      orig.client_address, chainRootId, nextNumber,
    ]
  );

  return { new_id: r.rows[0].id, continuation_number: nextNumber, chain_root_id: chainRootId };
}

module.exports = {
  initTables,
  parseExhibitExcel,
  extractHearingSummary,
  saveIndividualNote,
  listIndividualNotes,
  getIndividualNote,
  deleteIndividualNote,
  getIndividualNotesForClient,
  parseFormSubmission,
  generateParalegalSummary,
  generateClientSummary,
  generateAndSaveSummaries,
  sendToTeamGroup,
  renderForm,
  renderHistoryPage,
  cloneAsContinuation,
};
