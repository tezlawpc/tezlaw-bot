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
const EXTRACT_MODEL   = "claude-sonnet-4-6";  // used for PDF extraction (needs vision reasoning)
const TEXT_EXTRACT_MODEL = "claude-haiku-4-5-20251001";  // 5-10x faster for text-only extraction from Word/txt

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
  const structured = buildStructuredForAI(data);

  const prompt = `You are cleaning up individual (merits) hearing notes for the legal team at Tez Law, P.C.

The attorney (JJ Zhang) prepared and used these notes for an individual/merits hearing. Your job is to produce a clean, professional summary the team can use to update the case file and take follow-up action.

Rules:
- Complete and detailed — include ALL material information
- Structured with clear headings for each section
- Professional attorney-to-team tone (efficient, factual)
- Preserve ALL specific dates, exhibit numbers, deadlines, and witness names exactly
- Summarize witness testimony as narrative (don't dump every Q&A row) — capture the substance of what was covered
- Do NOT invent or embellish — only use what's in the notes
- Use bullet points where appropriate for scannability
- End with an "Action Items" section listing follow-up tasks

Structured hearing data:
${structured}

Produce the paralegal summary now. Start directly with the summary — no preamble.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: ANTHROPIC_MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] },
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
  const structured = buildStructuredForAI(data);

  const prompt = `You are writing a client-friendly summary of an immigration individual (merits) hearing in ${languageName}.

The client attended their individual hearing today with attorney JJ Zhang of Tez Law, P.C. Your job is to write a warm but professional summary explaining what happened and what comes next.

Rules:
- Write ENTIRELY in ${languageName}
- Plain language — no legalese, no Latin phrases, no complex procedural terminology
- Warm and reassuring tone but professional
- Focus on: what happened at the hearing, what the client said/showed, what the judge decided (if anything), and what happens next
- Do NOT walk through every question and answer — summarize testimony as narrative
- Include specific dates and deadlines with clear context
- Do NOT invent information — only what's in the notes
- End with attorney contact info: "If you have questions, please contact us at 626-678-8677 or jj@tezlawfirm.com" (translated)
- Address the client directly ("You" / "您" / "Usted" / "आप" / "ਤੁਸੀਂ")
- Sign off with "Sincerely, Attorney JJ Zhang, Tez Law, P.C." (translated)

Client name: ${data.client_name}

Hearing details (in English — you translate the meaningful parts):
${structured}

Produce the client summary in ${languageName} now. Start directly with the greeting.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: ANTHROPIC_MODEL, max_tokens: 3000, messages: [{ role: "user", content: prompt }] },
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
  const lines = [
    `Client: ${data.client_name || "(not provided)"}`,
    `A-Number: ${data.a_number || "(not provided)"}`,
    `Client language: ${data.client_language || "en"}`,
    `Case type: ${data.case_type || "(not specified)"}`,
    `Hearing date: ${data.hearing_date ? new Date(data.hearing_date).toLocaleString() : "(not provided)"}`,
    `Judge: ${data.judge_name || "(not noted)"}`,
    `Court: ${data.court_location || "(not noted)"}`,
    `Court address: ${data.court_address || "(not noted)"}`,
    `DHS Trial Attorney: ${data.dhs_attorney || "(not noted)"}`,
    "",
  ];

  // Exhibits
  const exhibits = data.exhibits || [];
  if (exhibits.length) {
    lines.push(`EXHIBITS (${exhibits.length} total):`);
    for (const e of exhibits) {
      const parts = [`#${e.number || "?"}`, e.description || "(no description)"];
      const flags = [];
      if (e.eoir_submission) flags.push(`EOIR: ${e.eoir_submission}`);
      if (e.marked)     flags.push(`marked as #${e.marked}`);
      // Default = admitted; only note if explicitly not admitted
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
    lines.push("PRE-EXAMINATION NOTES:");
    lines.push(data.pre_examination_notes);
    lines.push("");
  }

  // Examinations
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

  if (data.disposition) {
    lines.push("DISPOSITION:");
    lines.push(`  ${data.disposition}`);
    if (data.disposition_notes) lines.push(`  Notes: ${data.disposition_notes}`);
    lines.push("");
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
      ]
    );
    if (!r.rows[0]) throw new Error(`Individual hearing note ${id} not found`);
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
       next_hearing_date, next_hearing_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,
             $21,$22,$23,$24)
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
    ]
  );
  return { id: r.rows[0].id, updated: false };
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
    `SELECT id, client_name, a_number, hearing_date, judge_name, disposition, created_at
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
    };
    if (row.number || row.description || row.eoir_submission) exhibits.push(row);
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

  const body = `
    <div class="page-header">
      <h1>⚖️ Individual Hearing ${isEdit ? "— Editing #" + noteId : "— New"}</h1>
      <a href="/admin/hearing/history" class="back-link">← All Hearings</a>
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
              <th style="width:50px; text-align:left;">#</th>
              <th style="width:120px; text-align:left;">EOIR Submission</th>
              <th style="text-align:left;">Description</th>
              <th style="width:70px; text-align:center;">Marked</th>
              <th style="width:90px; text-align:center;">Not admitted</th>
              <th style="text-align:left;">Objection / Notes</th>
              <th style="width:30px;"></th>
            </tr>
          </thead>
          <tbody id="exhibits-tbody"></tbody>
        </table>
        </div>
        <button type="button" onclick="addExhibitRow()" style="background:#eee; padding:6px 12px; border:none; cursor:pointer; border-radius:4px; font-size:13px;">+ Add exhibit row</button>
      </fieldset>

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
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td><input type="text" name="exhibit_number_' + idx + '" value="' + escapeHTML(data.number || "") + '" style="width:100%;"></td>' +
          '<td><input type="text" name="exhibit_eoir_submission_' + idx + '" value="' + escapeHTML(data.eoir_submission || "") + '" style="width:100%;" placeholder="EOIR ref"></td>' +
          '<td><input type="text" name="exhibit_description_' + idx + '" value="' + escapeHTML(data.description || "") + '" style="width:100%;"></td>' +
          '<td style="text-align:center;"><input type="number" name="exhibit_marked_' + idx + '" min="1" max="99" value="' + escapeHTML(markedNum) + '" placeholder="—" style="width:60px; text-align:center; padding:4px;"></td>' +
          '<td style="text-align:center;"><input type="checkbox" name="exhibit_not_admitted_' + idx + '" value="yes"' + (isNotAdmitted ? " checked" : "") + ' style="transform:scale(1.3);"></td>' +
          '<td><input type="text" name="exhibit_objection_' + idx + '" value="' + escapeHTML(data.objection || "") + '" style="width:100%;"></td>' +
          '<td><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:#eee; border:none; padding:4px 8px; cursor:pointer; border-radius:3px;">×</button></td>';
        document.getElementById("exhibits-tbody").appendChild(tr);
      }
      function clearExhibits() {
        document.getElementById("exhibits-tbody").innerHTML = "";
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
};
