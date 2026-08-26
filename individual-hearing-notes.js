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
const EXTRACT_MODEL   = "claude-sonnet-4-6";

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
      exhibits              JSONB DEFAULT '[]'::jsonb,
      evidence_objections   TEXT,
      pre_examination_notes TEXT,
      examinations          JSONB DEFAULT '[]'::jsonb,
      closing_argument      TEXT,
      disposition           TEXT,
      disposition_notes     TEXT,
      next_action_deadline  DATE,
      hearing_summary_raw   TEXT,
      paralegal_summary     TEXT,
      client_summary        TEXT,
      sent_to_paralegal_at  TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_individual_hearing_notes_created
      ON individual_hearing_notes (created_at DESC)
  `);
}

// ── Excel Parsing ────────────────────────────────────────

// Accept an .xlsx or .csv buffer, return an array of exhibit objects.
// Uses first sheet, first row as headers.
function parseExhibitExcel(buffer, filename = "exhibits.xlsx") {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("No sheets found in file.");
  const sheet = workbook.Sheets[firstSheetName];
  // header:1 returns array of arrays
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (!rows.length) return { exhibits: [], sheet_name: firstSheetName, raw_rows: [] };

  // Detect header row: use the first row that has more than 1 non-empty cell
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const nonEmpty = rows[i].filter(c => String(c).trim()).length;
    if (nonEmpty >= 2) { headerIdx = i; break; }
  }
  const headers = rows[headerIdx].map(h => String(h).trim().toLowerCase());
  const dataRows = rows.slice(headerIdx + 1).filter(r => r.some(c => String(c).trim()));

  // Try to map common column names to standard fields
  const colIdx = {
    number:      findCol(headers, ["exhibit", "exh", "no.", "no", "#", "number", "tab"]),
    description: findCol(headers, ["description", "desc", "document", "title", "name"]),
    offered_by:  findCol(headers, ["offered by", "party", "proponent", "offered", "by"]),
    marked:      findCol(headers, ["marked", "identified", "id'd"]),
    admitted:    findCol(headers, ["admitted", "received", "admit"]),
    objection:   findCol(headers, ["objection", "objections", "notes", "note"]),
    bates:       findCol(headers, ["bates", "bates #", "pages"]),
  };

  const exhibits = dataRows.map((r, i) => ({
    number:      colIdx.number      >= 0 ? String(r[colIdx.number] || "").trim() : String(i + 1),
    description: colIdx.description >= 0 ? String(r[colIdx.description] || "").trim() : (r.filter(c => String(c).trim()).join(" ").trim() || ""),
    offered_by:  colIdx.offered_by  >= 0 ? String(r[colIdx.offered_by] || "").trim() : "",
    marked:      colIdx.marked      >= 0 ? String(r[colIdx.marked] || "").trim() : "",
    admitted:    colIdx.admitted    >= 0 ? String(r[colIdx.admitted] || "").trim() : "",
    objection:   colIdx.objection   >= 0 ? String(r[colIdx.objection] || "").trim() : "",
    bates:       colIdx.bates       >= 0 ? String(r[colIdx.bates] || "").trim() : "",
  })).filter(e => e.description || e.number);

  return { exhibits, sheet_name: firstSheetName, raw_rows: rows };
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
- Notes about the case background
- Direct examination questions for the applicant/witnesses
- Anticipated cross-examination
- Redirect
- Judge questions the attorney expects
- Closing argument bullets or full text
- Or any combination of the above

Your job: extract as much structured content as possible. Return ONLY valid JSON (no preamble, no code fences) with this structure:

{
  "case_summary": "Brief 1-2 sentence description of the case (from any narrative context in the doc)",
  "witnesses": [
    {
      "name": "Witness name (or 'Applicant' if not named)",
      "role": "e.g. Applicant, Spouse, Expert, Country Conditions Expert"
    }
  ],
  "examinations": [
    {
      "witness": "Witness name",
      "examination_type": "direct/cross/redirect (best guess)",
      "qa_rows": [
        {
          "question": "The question the attorney will ask (verbatim or best paraphrase)",
          "expected_answer": "Expected/prepared answer if noted, else empty string",
          "judge_notes": ""
        }
      ]
    }
  ],
  "closing_argument": "Closing argument text - preserve headings/structure with newlines"
}

Rules:
- Return ONLY the JSON object.
- Extract questions in ORDER as they appear.
- If a question has a paired anticipated answer in the doc, put it in expected_answer. Otherwise leave empty.
- judge_notes stays empty — the attorney fills that in DURING the hearing.
- If it's unclear whether something is direct vs cross, guess based on tone (softball → direct, adversarial → cross).
- If the doc has only closing argument, still return the JSON structure with empty examinations array.
- If the doc has only exam Q's, return with empty closing_argument string.
- Do not invent content. Empty structures are fine.`;

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
    messages.push({
      role: "user",
      content: `${prompt}\n\n=== HEARING SUMMARY DOCUMENT ===\n\n${textContent}`,
    });
  } else {
    throw new Error("Provide either pdfBuffer (with mimeType) or textContent.");
  }

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: EXTRACT_MODEL, max_tokens: 4000, messages },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 120000,
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

  // Normalize structure - ensure arrays exist
  extracted.witnesses = extracted.witnesses || [];
  extracted.examinations = (extracted.examinations || []).map(ex => ({
    witness: ex.witness || "Applicant",
    examination_type: ex.examination_type || "direct",
    qa_rows: (ex.qa_rows || []).map(qa => ({
      question: qa.question || "",
      expected_answer: qa.expected_answer || "",
      judge_notes: qa.judge_notes || "",
    })),
  }));
  extracted.closing_argument = extracted.closing_argument || "";
  extracted.case_summary = extracted.case_summary || "";
  return extracted;
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
         hearing_summary_raw=$20, updated_at=NOW()
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
       next_action_deadline, hearing_summary_raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18,$19,$20)
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

// ── Form parsing ─────────────────────────────────────────

function parseFormSubmission(body) {
  // Exhibits: submitted as indexed fields exhibit_number_0, exhibit_description_0, etc.
  const exhibits = [];
  const exhibitKeys = Object.keys(body).filter(k => /^exhibit_number_\d+$/.test(k));
  const exhibitIndices = exhibitKeys.map(k => parseInt(k.split("_").pop(), 10)).sort((a, b) => a - b);
  for (const i of exhibitIndices) {
    const row = {
      number:      (body[`exhibit_number_${i}`] || "").trim(),
      description: (body[`exhibit_description_${i}`] || "").trim(),
      offered_by:  (body[`exhibit_offered_by_${i}`] || "").trim(),
      marked:      (body[`exhibit_marked_${i}`] || "").trim(),
      admitted:    (body[`exhibit_admitted_${i}`] || "").trim(),
      objection:   (body[`exhibit_objection_${i}`] || "").trim(),
      bates:       (body[`exhibit_bates_${i}`] || "").trim(),
    };
    if (row.number || row.description) exhibits.push(row);
  }

  // Examinations: nested — for each examination (e_0, e_1...), rows (r_0, r_1...)
  const examinations = [];
  const examKeys = Object.keys(body).filter(k => /^exam_witness_\d+$/.test(k));
  const examIndices = examKeys.map(k => parseInt(k.split("_").pop(), 10)).sort((a, b) => a - b);
  for (const ei of examIndices) {
    const witness = (body[`exam_witness_${ei}`] || "").trim();
    const exType  = (body[`exam_type_${ei}`] || "").trim();
    const qa_rows = [];
    const rowKeys = Object.keys(body).filter(k => new RegExp(`^exam_${ei}_q_\\d+$`).test(k));
    const rowIndices = rowKeys.map(k => parseInt(k.split("_").pop(), 10)).sort((a, b) => a - b);
    for (const ri of rowIndices) {
      const q = (body[`exam_${ei}_q_${ri}`] || "").trim();
      const a = (body[`exam_${ei}_a_${ri}`] || "").trim();
      const jn = (body[`exam_${ei}_jn_${ri}`] || "").trim();
      if (q || a || jn) qa_rows.push({ question: q, expected_answer: a, judge_notes: jn });
    }
    if (witness || exType || qa_rows.length) {
      examinations.push({ witness, examination_type: exType, qa_rows });
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
    exhibits,
    evidence_objections: (body.evidence_objections || "").trim() || null,
    pre_examination_notes: (body.pre_examination_notes || "").trim() || null,
    examinations,
    closing_argument: (body.closing_argument || "").trim() || null,
    disposition: (body.disposition || "").trim() || null,
    disposition_notes: (body.disposition_notes || "").trim() || null,
    next_action_deadline: body.next_action_deadline || null,
    hearing_summary_raw: (body.hearing_summary_raw || "").trim() || null,
  };
}

// ── HTML Form ────────────────────────────────────────────

function renderForm({ noteId = null, prev = {}, error = null, saved = false } = {}) {
  const isEdit = !!noteId;

  const langOptions = [
    { v: "en", l: "English" }, { v: "zh", l: "中文" }, { v: "es", l: "Español" },
    { v: "hi", l: "हिन्दी" }, { v: "pa", l: "ਪੰਜਾਬੀ" },
  ].map(o => `<option value="${o.v}" ${prev.client_language === o.v ? "selected" : ""}>${o.l}</option>`).join("");

  const exhibits = prev.exhibits || [];
  const examinations = prev.examinations || [];

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
      <a href="/admin/hearing/individual/history" class="back-link">← History</a>
    </div>

    <p style="margin-bottom:15px; color:#555;">Prep tool for individual/merits hearings. Fill this in before the hearing; all fields remain editable during and after. Upload the prep outline (PDF or text) and Excel exhibit list to auto-populate.</p>

    <!-- Upload areas -->
    <div style="display:flex; gap:15px; margin-bottom:20px; flex-wrap:wrap;">
      <div id="summary-drop" ondragover="dragOver(event, 'summary-drop')" ondragleave="dragLeave(event, 'summary-drop')" ondrop="dropSummary(event)"
           style="flex:1; min-width:300px; background:#fdf7f0; border:2px dashed #B79C62; padding:20px; border-radius:8px; text-align:center;">
        <strong>📄 Hearing Summary / Prep Outline</strong>
        <div style="font-size:12px; color:#666; margin:6px 0;">Drop PDF or text file — Claude extracts Q&amp;A + closing</div>
        <input type="file" id="summary-file" accept=".pdf,.txt,.md" style="display:none;" onchange="uploadSummary(this.files[0])">
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
      </fieldset>

      <!-- Section 3: Exhibit list -->
      <fieldset>
        <legend>Exhibit List</legend>
        <div class="hint">Upload an Excel/CSV above to auto-populate, or add rows manually.</div>
        <div style="overflow-x:auto;">
        <table id="exhibits-table" style="width:100%; margin:8px 0; font-size:13px;">
          <thead>
            <tr>
              <th style="width:60px; text-align:left;">#</th>
              <th style="text-align:left;">Description</th>
              <th style="width:100px; text-align:left;">Offered by</th>
              <th style="width:80px; text-align:left;">Marked</th>
              <th style="width:80px; text-align:left;">Admitted</th>
              <th style="text-align:left;">Objection / Notes</th>
              <th style="width:80px; text-align:left;">Bates</th>
              <th style="width:30px;"></th>
            </tr>
          </thead>
          <tbody id="exhibits-tbody"></tbody>
        </table>
        </div>
        <button type="button" onclick="addExhibitRow()" style="background:#eee; padding:6px 12px; border:none; cursor:pointer; border-radius:4px; font-size:13px;">+ Add exhibit row</button>
      </fieldset>

      <!-- Section 4: Objections -->
      <fieldset>
        <legend>Objections On Evidence Submitted</legend>
        <textarea name="evidence_objections" rows="4" placeholder="Notes about objections raised by either side on documentary or testimonial evidence.">${escapeHtml(prev.evidence_objections || "")}</textarea>
      </fieldset>

      <!-- Section 5: Pre-examination notes -->
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
        <input type="text" name="disposition" value="${escapeAttr(prev.disposition)}" placeholder="e.g. Relief granted, Decision reserved, Removal ordered">
        <label>Disposition notes</label>
        <textarea name="disposition_notes" rows="2">${escapeHtml(prev.disposition_notes || "")}</textarea>
        <label>Next action deadline</label>
        <input type="date" name="next_action_deadline" value="${escapeAttr(prev.next_action_deadline ? String(prev.next_action_deadline).substring(0, 10) : "")}">
      </fieldset>

      <div style="margin-top:20px; display:flex; gap:10px;">
        <button type="submit" style="background:#B79C62; color:white; padding:12px 28px; border:none; border-radius:4px; cursor:pointer; font-size:15px;">💾 ${isEdit ? "Update" : "Save"}</button>
        ${isEdit ? `<a href="/admin/hearing/individual" style="background:#eee; color:#333; padding:12px 28px; border-radius:4px; text-decoration:none; font-size:15px;">+ New</a>` : ""}
      </div>
    </form>

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
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td><input type="text" name="exhibit_number_' + idx + '" value="' + escapeHTML(data.number || "") + '" style="width:100%;"></td>' +
          '<td><input type="text" name="exhibit_description_' + idx + '" value="' + escapeHTML(data.description || "") + '" style="width:100%;"></td>' +
          '<td><input type="text" name="exhibit_offered_by_' + idx + '" value="' + escapeHTML(data.offered_by || "") + '" style="width:100%;"></td>' +
          '<td><input type="text" name="exhibit_marked_' + idx + '" value="' + escapeHTML(data.marked || "") + '" style="width:100%;"></td>' +
          '<td><input type="text" name="exhibit_admitted_' + idx + '" value="' + escapeHTML(data.admitted || "") + '" style="width:100%;"></td>' +
          '<td><input type="text" name="exhibit_objection_' + idx + '" value="' + escapeHTML(data.objection || "") + '" style="width:100%;"></td>' +
          '<td><input type="text" name="exhibit_bates_' + idx + '" value="' + escapeHTML(data.bates || "") + '" style="width:100%;"></td>' +
          '<td><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:#eee; border:none; padding:4px 8px; cursor:pointer; border-radius:3px;">×</button></td>';
        document.getElementById("exhibits-tbody").appendChild(tr);
      }
      function clearExhibits() {
        document.getElementById("exhibits-tbody").innerHTML = "";
      }

      // ── Examinations ────────────────────────────────────
      let examCounter = 0;
      function addExamination(data) {
        data = data || {};
        const idx = examCounter++;
        const wrap = document.createElement("div");
        wrap.dataset.examIdx = idx;
        wrap.style.cssText = "border:1px solid #ddd; padding:12px; margin:12px 0; border-radius:4px; background:#fafafa;";
        wrap.innerHTML =
          '<div style="display:flex; gap:8px; margin-bottom:8px; align-items:center;">' +
            '<label style="font-weight:600; flex:0 0 auto;">Witness:</label>' +
            '<input type="text" name="exam_witness_' + idx + '" value="' + escapeHTML(data.witness || "Applicant") + '" style="flex:1; padding:6px;">' +
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
          '<table style="width:100%; font-size:13px;">' +
            '<thead><tr>' +
              '<th style="width:35%; text-align:left; padding:4px;">Question</th>' +
              '<th style="width:35%; text-align:left; padding:4px;">Answer</th>' +
              '<th style="width:25%; text-align:left; padding:4px;">Judge Q / Notes</th>' +
              '<th style="width:30px;"></th>' +
            '</tr></thead>' +
            '<tbody data-exam-rows="' + idx + '"></tbody>' +
          '</table>' +
          '<button type="button" onclick="addQARow(' + idx + ')" style="background:#eee; padding:5px 10px; border:none; cursor:pointer; border-radius:3px; font-size:12px; margin-top:6px;">+ Add Q&amp;A row</button>';
        document.getElementById("exams-container").appendChild(wrap);
        (data.qa_rows || []).forEach(row => addQARow(idx, row));
        if (!data.qa_rows || !data.qa_rows.length) addQARow(idx);
      }
      function addQARow(examIdx, row) {
        row = row || {};
        const tbody = document.querySelector('tbody[data-exam-rows="' + examIdx + '"]');
        if (!tbody) return;
        const rowIdx = tbody.querySelectorAll("tr").length;
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td style="vertical-align:top; padding:4px;"><textarea name="exam_' + examIdx + '_q_' + rowIdx + '" rows="2" style="width:100%; font-family:inherit; font-size:13px;">' + escapeHTML(row.question || "") + '</textarea></td>' +
          '<td style="vertical-align:top; padding:4px;"><textarea name="exam_' + examIdx + '_a_' + rowIdx + '" rows="2" style="width:100%; font-family:inherit; font-size:13px;">' + escapeHTML(row.expected_answer || "") + '</textarea></td>' +
          '<td style="vertical-align:top; padding:4px;"><textarea name="exam_' + examIdx + '_jn_' + rowIdx + '" rows="2" style="width:100%; font-family:inherit; font-size:13px;">' + escapeHTML(row.judge_notes || "") + '</textarea></td>' +
          '<td style="vertical-align:top; padding:4px;"><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:#eee; border:none; padding:2px 6px; cursor:pointer; border-radius:3px;">×</button></td>';
        tbody.appendChild(tr);
      }
      function clearExaminations() {
        document.getElementById("exams-container").innerHTML = "";
        examCounter = 0;
      }
      function opt(v, l, current) { return '<option value="' + v + '"' + (current === v ? " selected" : "") + '>' + l + '</option>'; }
      function escapeHTML(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

      // Initialize with existing data
      INITIAL_EXHIBITS.forEach(e => addExhibitRow(e));
      if (!INITIAL_EXHIBITS.length) addExhibitRow();
      INITIAL_EXAMS.forEach(e => addExamination(e));
      if (!INITIAL_EXAMS.length) addExamination({ witness: "Applicant", examination_type: "direct" });

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
        status.innerHTML = '<span style="color:#666;">⏳ Uploading and extracting from ' + file.name + '... 30-60 seconds</span>';
        const fd = new FormData();
        fd.append("summary", file);
        try {
          const resp = await fetch("/admin/hearing/individual/extract-summary", { method: "POST", body: fd });
          const data = await resp.json();
          if (!data.ok) { status.innerHTML = '<span style="color:#c00;">❌ ' + (data.error || "Extraction failed") + '</span>'; return; }
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
          status.innerHTML = '<span style="color:#4CAF50;">✅ Extracted ' + (data.extracted.examinations || []).length + ' exam section(s), ' + (data.extracted.closing_argument ? "closing argument, " : "") + '' + (data.extracted.witnesses || []).length + ' witness(es).</span>';
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
        }
      }

      // ── Upload exhibits ─────────────────────────────────
      async function uploadExhibits(file) {
        if (!file) return;
        const status = document.getElementById("exhibits-status");
        status.innerHTML = '<span style="color:#666;">⏳ Parsing ' + file.name + '...</span>';
        const fd = new FormData();
        fd.append("exhibits", file);
        try {
          const resp = await fetch("/admin/hearing/individual/extract-exhibits", { method: "POST", body: fd });
          const data = await resp.json();
          if (!data.ok) { status.innerHTML = '<span style="color:#c00;">❌ ' + (data.error || "Parse failed") + '</span>'; return; }
          if (!data.exhibits.length) { status.innerHTML = '<span style="color:#ff9800;">⚠️ No exhibits detected in file.</span>'; return; }
          if (confirm("Parsed " + data.exhibits.length + " exhibit rows from sheet \\"" + (data.sheet_name || "?") + "\\". Replace current exhibits?")) {
            clearExhibits();
            data.exhibits.forEach(e => addExhibitRow(e));
          } else {
            data.exhibits.forEach(e => addExhibitRow(e));
          }
          status.innerHTML = '<span style="color:#4CAF50;">✅ Loaded ' + data.exhibits.length + ' exhibit rows.</span>';
        } catch (e) {
          status.innerHTML = '<span style="color:#c00;">❌ ' + e.message + '</span>';
        }
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
  const rows = notes.length ? notes.map(n => `
    <tr>
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
    </tr>`).join("") : `<tr><td colspan="9" style="text-align:center; color:#888;">No individual hearing notes yet.</td></tr>`;

  const body = `
    <div class="page-header">
      <h1>📖 Individual Hearing History</h1>
      <a href="/admin/hearing/individual" class="back-link">← Back to prep tool</a>
    </div>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Client</th><th>A#</th><th>Hearing</th>
          <th>Judge</th><th>Lang</th><th>Sent</th><th>Created</th><th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <script>
      async function delRow(id, name) {
        if (!confirm("Delete individual hearing note #" + id + " for " + name + "?")) return;
        try {
          const resp = await fetch("/admin/hearing/individual/" + id, { method: "DELETE" });
          const data = await resp.json();
          if (data.ok) window.location.reload();
          else alert("❌ " + (data.error || "delete failed"));
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
  parseFormSubmission,
  renderForm,
  renderHistoryPage,
};
