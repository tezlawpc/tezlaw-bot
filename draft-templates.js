// ============================================================
//  TEZ LAW P.C. — PHASE 4 TEMPLATE DRAFTING v1
//  ─────────────────────────────────────────────────────────
//  Zara can now:
//    1. Store .docx templates with {{PLACEHOLDER}} markers
//    2. Extract facts from attached fact documents (PDF/DOCX)
//    3. Draft substantive narrative sections using moat + firm docs
//    4. Return a filled .docx as Telegram attachment
//
//  Placeholder types (inferred from name):
//    - Simple: short values (names, dates, numbers) — extracted from
//      facts or asked interactively.
//        Naming: SHORT ALL-CAPS like CLIENT_NAME_FULL, A_NUMBER,
//        FILING_DATE, DHS_SERVICE_ADDRESS.
//
//    - Narrative: long substantive prose — drafted by Zara with
//      moat + firm docs grounding.
//        Naming: contains _NARRATIVE, _BODIES, _LIST, or
//        _JUSTIFICATION suffixes.
//
//  Storage:
//    - draft_templates:    the .docx templates
//    - draft_history:      completed drafts (for audit + feedback)
//    - draft_sessions:     multi-turn state
//
//  Dependencies:
//    - pizzip           for .docx zip manipulation
//    - mammoth          for extracting text from .docx facts documents
//    - pdf-parse        (existing) for PDF facts documents
// ============================================================

const PizZip     = require("pizzip");
const mammoth    = require("mammoth");
const pdfParse   = require("pdf-parse");
const axios      = require("axios");
const db         = require("./db");

const ANTHROPIC_MODEL = "claude-sonnet-4-6";

// ── Schema Initialization ──────────────────────────────────

async function initDraftTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS draft_templates (
        id             SERIAL PRIMARY KEY,
        name           TEXT UNIQUE NOT NULL,
        practice_area  TEXT,
        description    TEXT,
        placeholders   JSONB,
        docx_content   BYTEA NOT NULL,
        uploaded_by    TEXT DEFAULT 'jj',
        uploaded_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_draft_templates_name
        ON draft_templates (name)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS draft_history (
        id             SERIAL PRIMARY KEY,
        template_id    INTEGER REFERENCES draft_templates(id) ON DELETE SET NULL,
        template_name  TEXT NOT NULL,
        input_values   JSONB,
        used_moat_ids  INTEGER[],
        used_firm_ids  INTEGER[],
        output_docx    BYTEA,
        chat_id        TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_draft_history_chat
        ON draft_history (chat_id, created_at DESC)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS draft_sessions (
        chat_id           TEXT PRIMARY KEY,
        template_id       INTEGER REFERENCES draft_templates(id) ON DELETE CASCADE,
        state             TEXT NOT NULL,
        collected         JSONB DEFAULT '{}'::jsonb,
        fact_doc_text     TEXT,
        missing_fields    TEXT[],
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }
}

// ── Placeholder Classification ─────────────────────────────

/**
 * Given a placeholder name, decide whether it's a simple field
 * (short text value) or a narrative field (Zara-drafted prose).
 */
function classifyPlaceholder(name) {
  const upper = name.toUpperCase();

  const narrativeSuffixes = [
    "_NARRATIVE", "_BODIES", "_LIST", "_JUSTIFICATION",
    "_PARAGRAPH", "_PARAGRAPH_2", "_ARGUMENTS",
  ];

  for (const suffix of narrativeSuffixes) {
    if (upper.endsWith(suffix) || upper.includes(suffix)) return "narrative";
  }

  return "simple";
}

/**
 * Given a placeholder name, produce a human-readable label.
 * E.g., "CLIENT_NAME_FULL" -> "Client name (full)"
 */
function humanizeName(name) {
  return name
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, l => l.toUpperCase())
    .replace(/\s+full\b/i, " (full)")
    .replace(/\s+short\b/i, " (short)")
    .replace(/\bIj\b/g, "IJ")
    .replace(/\bDhs\b/g, "DHS");
}

// ── Extract Placeholders From .docx ────────────────────────

/**
 * Parses a .docx file and extracts all {{PLACEHOLDER}} names.
 * Returns array of { name, type, count }.
 */
function extractPlaceholders(docxBuffer) {
  const zip = new PizZip(docxBuffer);
  const docXml = zip.file("word/document.xml").asText();

  // Also check header/footer files
  let allText = docXml;
  for (const fileName of zip.files ? Object.keys(zip.files) : []) {
    if (fileName.startsWith("word/header") || fileName.startsWith("word/footer")) {
      try { allText += "\n" + zip.file(fileName).asText(); } catch (_) {}
    }
  }

  // Find {{PLACEHOLDER_NAME}} — allow letters, digits, underscores
  const matches = allText.match(/\{\{[A-Z0-9_]+\}\}/g) || [];

  // Count occurrences and dedupe
  const counts = new Map();
  for (const m of matches) {
    const name = m.replace(/[{}]/g, "");
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const placeholders = Array.from(counts.entries()).map(([name, count]) => ({
    name,
    type: classifyPlaceholder(name),
    count,
    humanLabel: humanizeName(name),
  }));

  // Sort: simple first, then narrative
  placeholders.sort((a, b) => {
    if (a.type !== b.type) return a.type === "simple" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return placeholders;
}

// ── Store/Retrieve Templates ───────────────────────────────

async function saveTemplate({ name, docxBuffer, practiceArea, description, uploadedBy = "jj" }) {
  await initDraftTables();
  const placeholders = extractPlaceholders(docxBuffer);

  const r = await db.query(
    `INSERT INTO draft_templates (name, practice_area, description, placeholders, docx_content, uploaded_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (name) DO UPDATE SET
       practice_area = EXCLUDED.practice_area,
       description   = EXCLUDED.description,
       placeholders  = EXCLUDED.placeholders,
       docx_content  = EXCLUDED.docx_content,
       uploaded_by   = EXCLUDED.uploaded_by,
       uploaded_at   = NOW()
     RETURNING id, name`,
    [name, practiceArea, description, JSON.stringify(placeholders), docxBuffer, uploadedBy]
  );

  return { ok: true, id: r.rows[0].id, name: r.rows[0].name, placeholders };
}

async function getTemplate(name) {
  await initDraftTables();
  const r = await db.query(
    `SELECT id, name, practice_area, description, placeholders, docx_content, uploaded_at
     FROM draft_templates WHERE name = $1`,
    [name]
  );
  return r.rows[0] || null;
}

async function listTemplates() {
  await initDraftTables();
  const r = await db.query(
    `SELECT id, name, practice_area, description,
       jsonb_array_length(COALESCE(placeholders, '[]'::jsonb)) AS placeholder_count,
       uploaded_at
     FROM draft_templates
     ORDER BY uploaded_at DESC`
  );
  return r.rows;
}

async function deleteTemplate(name) {
  const r = await db.query(
    `DELETE FROM draft_templates WHERE name = $1 RETURNING id`,
    [name]
  );
  return r.rowCount > 0;
}

// ── Extract Text From Fact Document ────────────────────────

/**
 * Given a fact document buffer (PDF or DOCX), extract plain text.
 */
async function extractFactDocText(buffer, mimeType) {
  if (!buffer) return null;

  try {
    if (mimeType === "application/pdf" || (buffer[0] === 0x25 && buffer[1] === 0x50)) {
      // PDF magic bytes %P
      const data = await pdfParse(buffer);
      return data.text;
    }

    if (mimeType && mimeType.includes("officedocument") ||
        (buffer[0] === 0x50 && buffer[1] === 0x4B)) {
      // DOCX (zip) magic bytes PK
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    // Try as plain text
    return buffer.toString("utf8");
  } catch (e) {
    console.error("[draft-templates] Fact extraction failed:", e.message);
    return null;
  }
}

// ── Auto-Fill Simple Placeholders From Fact Doc ────────────

/**
 * Use Sonnet to identify which simple placeholders can be filled from
 * the fact document text. Returns { collected: {NAME: value}, notes }
 */
async function autoFillSimpleFromFactDoc(placeholders, factDocText) {
  if (!factDocText || factDocText.length < 100) {
    return { collected: {}, notes: "No fact document text to extract from." };
  }

  const simpleFields = placeholders.filter(p => p.type === "simple");
  if (simpleFields.length === 0) return { collected: {}, notes: "" };

  const fieldList = simpleFields.map(p => `  - ${p.name}: ${p.humanLabel}`).join("\n");

  const prompt = `You are extracting factual values from a client's case document to fill placeholders in a legal template.

TEMPLATE PLACEHOLDERS (extract values for these if found in the document):
${fieldList}

DOCUMENT TEXT:
${factDocText.substring(0, 15000)}

INSTRUCTIONS:
1. For each placeholder, find the corresponding value IN THE DOCUMENT.
2. Do NOT invent or guess values. If a value is not clearly stated in the document, return null for that field.
3. For dates, use the format shown in the document (do not reformat).
4. For names, use the full name as written.
5. Return your answer as a JSON object with the placeholder NAMES as keys, values as strings (or null).

Return ONLY the JSON, no other text. Example:
{
  "CLIENT_NAME_FULL": "SMITH, JOHN",
  "A_NUMBER": "123-456-789",
  "IJ_DECISION_DATE": null
}`;

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
        timeout: 60000,
      }
    );

    const text = resp.data.content[0]?.text?.trim() || "";
    // Strip any code fences
    const cleaned = text.replace(/```json|```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // Try to find a JSON object in the text
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("Could not parse JSON from extraction response");
    }

    // Filter to only include valid, non-null values matching our placeholders
    const collected = {};
    const validNames = new Set(simpleFields.map(p => p.name));
    for (const [key, value] of Object.entries(parsed)) {
      if (validNames.has(key) && value && typeof value === "string" && value.trim()) {
        collected[key] = value.trim();
      }
    }

    return { collected, notes: `Auto-extracted ${Object.keys(collected).length} fields from fact document.` };
  } catch (e) {
    console.error("[draft-templates] Auto-fill error:", e.message);
    return { collected: {}, notes: "Auto-extraction failed; please provide values manually." };
  }
}

// ── Draft Narrative Section ────────────────────────────────

/**
 * Draft a single narrative placeholder using moat + firm docs grounding.
 * If factDocText contains "=== ATTORNEY NOTES ===" section, those are treated
 * as authoritative case theory from JJ (higher weight than attached documents).
 */
async function draftNarrativeSection({
  placeholderName,
  templateName,
  collectedValues,
  factDocText,
  moatContext = "",
  firmContext = "",
}) {
  const humanLabel = humanizeName(placeholderName);
  const contextValues = Object.entries(collectedValues)
    .map(([k, v]) => `- ${humanizeName(k)}: ${v}`)
    .join("\n");

  const sectionGuidance = getSectionGuidance(placeholderName);

  // Separate attorney notes from attached documents for stronger weighting
  let attorneyNotes = "";
  let attachedDoc = "";
  if (factDocText) {
    const notesMatch = factDocText.match(/=== ATTORNEY NOTES ON CASE ===\n([\s\S]*?)(?:\n\n=== ATTACHED DOCUMENT ===|$)/);
    const attachedMatch = factDocText.match(/=== ATTACHED DOCUMENT ===\n([\s\S]*)$/);
    if (notesMatch) attorneyNotes = notesMatch[1].trim();
    if (attachedMatch) attachedDoc = attachedMatch[1].trim();
    // If no delimiters, entire text is attached doc
    if (!notesMatch && !attachedMatch) attachedDoc = factDocText;
  }

  // Build the prompt with attorney notes ABOVE EVERYTHING — before section
  // guidance, before extracted values, before moat, before firm docs.
  //
  // If attorney notes are absent, we still allow drafting but strongly warn
  // against fabricating case facts. Statement of Facts specifically inserts
  // a placeholder rather than inventing a client story.

  const hasNotes = attorneyNotes && attorneyNotes.length > 20;
  const hasAttachedDoc = attachedDoc && attachedDoc.length > 100;
  const factualSectionUpper = placeholderName.toUpperCase();
  const isFactualSection =
    factualSectionUpper.includes("STATEMENT_OF_FACTS") ||
    factualSectionUpper.includes("STATEMENT_OF_FACT");

  // If drafting a factual section without any client facts, insert placeholder
  if (isFactualSection && !hasAttachedDoc && !hasNotes) {
    return {
      ok: true,
      content: "[STATEMENT OF FACTS TO BE COMPLETED BY ATTORNEY — no client-specific facts were provided to draft this section. Please supply the client's factual background, procedural history, and evidence submitted at the merits hearing.]",
    };
  }

  const promptParts = [];

  // 1. Attorney notes FIRST — the case theory
  if (hasNotes) {
    promptParts.push(`═══════════════════════════════════════════════════════════════
★★★ ATTORNEY'S CASE THEORY — ABSOLUTE SOURCE OF TRUTH ★★★
═══════════════════════════════════════════════════════════════

The following are JJ Zhang's own notes on this specific case.
These describe the ACTUAL case, the ACTUAL legal errors being
appealed, and the ACTUAL relief being sought.

★ You MUST draft this section as an appeal of THIS case.
★ You MUST NOT drift into a different case type (asylum ≠ 212(h) waiver ≠ cancellation etc.)
★ If the moat retrieval or firm documents contradict these notes, FOLLOW THE NOTES.
★ If the notes identify specific IJ errors, STRUCTURE the section around THOSE errors.
★ Do NOT invent facts, medical conditions, family circumstances, or case theories
  that are not present in these notes or in the attached document.

═══════════════════════════════════════════════════════════════
ATTORNEY NOTES:
${attorneyNotes}
═══════════════════════════════════════════════════════════════`);
  } else {
    promptParts.push(`⚠️ NO ATTORNEY NOTES PROVIDED.

You do not have the attorney's specific case theory. This means you MUST:
- Rely ONLY on the attached document below for factual context
- NOT invent client facts, medical conditions, family circumstances, or case-specific details
- Draft the section in a way that requires attorney customization before filing
- If you cannot draft this section without inventing facts, output a placeholder like:
  "[SECTION TO BE COMPLETED BY ATTORNEY]"`);
  }

  // 2. Attached document as reference
  if (hasAttachedDoc) {
    promptParts.push(`═══════════════════════════════════════════════════════════════
ATTACHED DOCUMENT (reference material — factual grounding):
═══════════════════════════════════════════════════════════════
${attachedDoc.substring(0, 10000)}`);
  }

  // 3. Section identifier and guidance
  promptParts.push(`═══════════════════════════════════════════════════════════════
SECTION TO DRAFT: ${humanLabel} (${placeholderName})
═══════════════════════════════════════════════════════════════
${sectionGuidance ? "GUIDANCE:\n" + sectionGuidance : ""}

Template: ${templateName}
Client fields extracted: ${contextValues || "(none extracted)"}`);

  // 4. Legal research context (moat + firm docs) LAST — supports, doesn't dictate
  if (moatContext) {
    promptParts.push(`═══════════════════════════════════════════════════════════════
LEGAL RESEARCH FROM MOAT (supporting authority — DO NOT let this override case theory):
═══════════════════════════════════════════════════════════════
${moatContext}`);
  }
  if (firmContext) {
    promptParts.push(`═══════════════════════════════════════════════════════════════
PRIOR FIRM WORK (reference for voice/style):
═══════════════════════════════════════════════════════════════
${firmContext}`);
  }

  // 5. Instructions
  promptParts.push(`═══════════════════════════════════════════════════════════════
INSTRUCTIONS:
═══════════════════════════════════════════════════════════════
1. Draft ONLY the "${humanLabel}" section content. Do NOT include the section heading — just the body prose.
2. Match Tez Law's formal legal writing voice.
3. STAY ON THIS CASE. Do not drift to a different case type or fabricate a case that isn't in the attorney notes or attached document.
4. If attorney notes describe an asylum case, this is an asylum appeal. If they describe 212(h), it's a 212(h) case. Do not swap.
5. Cite specific cases by name ONLY from the moat research provided above. Do NOT invent case names or citations.
6. Where the moat doesn't cover a point, state legal principles without inventing case-specific citations.
7. For factual assertions: use ONLY facts from attorney notes and attached document. Do not invent client medical conditions, family circumstances, or case history.
8. NO markdown formatting, bullet points, asterisks, or bold. Use plain prose only.
9. Return ONLY the drafted section content, with no preamble, explanation, or wrap-up commentary.`);

  const prompt = promptParts.join("\n\n");

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 180000,
      }
    );

    const text = resp.data.content[0]?.text?.trim() || "";
    return { ok: true, content: text };
  } catch (e) {
    console.error(`[draft-templates] Draft ${placeholderName} error:`, e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Section-specific guidance strings for narrative drafting.
 */
function getSectionGuidance(placeholderName) {
  const upper = placeholderName.toUpperCase();
  if (upper.includes("INTRODUCTION")) {
    return `Introduce the case in 2-4 sentences. Include:
- The specific type of relief sought (identify from attorney notes: asylum, bond, cancellation, waiver, etc. — do NOT default to 212(h) or any other type not mentioned)
- What the IJ decided (from notes/attached document only)
- Brief preview of why the IJ decision was in error (from the SPECIFIC errors in attorney notes — not generic errors)

Formal opening tone. Do not invent facts about the client's identity, medical history, or family circumstances.`;
  }
  if (upper.includes("STATEMENT_OF_FACTS") || upper.includes("STATEMENT_OF_FACT")) {
    return `Provide a chronological narrative of case facts.

ABSOLUTE RULE: Every fact stated MUST come from either the attorney notes or the attached document. Do not invent:
- Medical conditions the client doesn't mention
- Family relationships not in the record
- Procedural history not documented
- Evidence not identified

If insufficient facts are provided to write a complete section, write:
"[STATEMENT OF FACTS TO BE COMPLETED — insufficient factual detail provided]"

Include (only if in the record): client's country of origin, entry to US, procedural history (NTA date if known, hearing dates if known), what happened at the merits hearing, what evidence was presented, and what the IJ ruled.`;
  }
  if (upper.includes("ISSUES_PRESENTED") || upper.includes("ISSUES_LIST")) {
    return `List the SPECIFIC legal errors the IJ made — using the errors identified in the attorney notes.

If attorney notes identify 6 errors, list all 6. If they identify 2, list 2. Do NOT add or invent additional issues.

Each issue phrased as "Whether the IJ erred by [specific error from notes]."

Number each issue 1., 2., 3., etc.

Do NOT invent generic issues (e.g., "extreme hardship analysis") unless the attorney notes specifically raise them.`;
  }
  if (upper.includes("STANDARD_OF_REVIEW")) {
    return `State the applicable standards of review:
- Findings of fact: clearly erroneous, 8 C.F.R. § 1003.1(d)(3)(i)
- Legal issues: de novo, 8 C.F.R. § 1003.1(d)(3)(ii)

Then briefly identify which standard applies to which of the specific errors in the attorney notes (fact vs law).

Cite any additional standard-of-review case law from the moat that is DIRECTLY relevant to the specific error types alleged. Do NOT cite general BIA appeal cases if they are not on point.`;
  }
  if (upper.includes("SUMMARY_OF_ARGUMENT")) {
    return "Provide a concise 1-2 paragraph summary of the arguments to follow, based on the specific IJ errors from attorney notes. Preview each argument briefly.";
  }
  if (upper.includes("ARGUMENT") && (upper.includes("BODIES") || upper.includes("HEADINGS"))) {
    return `Draft substantive legal arguments — one argument per IJ error identified in the attorney notes.

ABSOLUTE RULES:
- Number of arguments = number of distinct errors in attorney notes (if notes list 6 errors, write 6 arguments)
- Each argument's HEADING must reflect the specific error from the notes (e.g., "The IJ Erred By Finding That YouTube And Twitter Are Not Accessible In China" — using the actual error from notes)
- Do NOT invent additional arguments not raised by the attorney
- Do NOT substitute generic BIA arguments (e.g., extreme hardship, waiver, cancellation) if they aren't in the notes

Structure for each argument:
(a) Heading identifying the specific error from attorney notes
(b) Legal standard applicable to that error type
(c) Application of law to facts with case citations from the moat (only cite cases that appear in the moat context — do NOT invent citations)
(d) Conclusion for that argument

Format each argument with roman numeral prefix (I., II., III., etc.) at the start.`;
  }
  if (upper.includes("CONCLUSION")) {
    return `State the specific relief requested, matching the type of relief indicated in the attorney notes.
Common relief: (1) sustain the appeal, (2) vacate the IJ's decision, (3) remand for further proceedings, (4) grant the underlying relief (asylum, bond, cancellation, waiver — use the type actually at issue).

If attorney notes indicate asylum, request asylum relief. If bond, request bond. Do not default to the wrong relief type.

Be specific about what the Board should do.`;
  }
  if (upper.includes("JUSTIFICATION") && upper.includes("THREE_MEMBER")) {
    return "Argue why the case warrants three-member review under 8 C.F.R. § 1003.1(e)(6). Typical grounds: (a) case presents important legal issue, (b) IJ decision conflicts with published Board precedent, (c) case has serious errors of law requiring correction. Cite the specific errors from your case theory (attorney notes), not generic grounds.";
  }
  return "";
}

// ── Substitute Values Into .docx ───────────────────────────

/**
 * Given a template .docx buffer and a values map, produce a filled .docx.
 * Uses simple regex substitution on the XML.
 */
function fillDocxTemplate(docxBuffer, values) {
  const zip = new PizZip(docxBuffer);

  // Substitute in document.xml and all header/footer files
  const filesToProcess = ["word/document.xml"];
  for (const fileName of Object.keys(zip.files)) {
    if (fileName.startsWith("word/header") || fileName.startsWith("word/footer")) {
      filesToProcess.push(fileName);
    }
  }

  for (const fileName of filesToProcess) {
    const file = zip.file(fileName);
    if (!file) continue;
    let xml = file.asText();

    // For each placeholder, do direct substitution
    for (const [name, value] of Object.entries(values)) {
      const marker = `{{${name}}}`;
      // Escape special XML chars in the value
      const escapedValue = String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

      // Split by newlines to preserve paragraph breaks (basic approach)
      // For narrative sections, we split on \n\n into new paragraphs (advanced)
      // For simple values, just direct substitute
      xml = xml.split(marker).join(escapedValue);
    }

    // Also remove any yellow highlighting from filled placeholders
    // (this is best-effort — Word will still keep highlighting on remaining unfilled markers)
    zip.file(fileName, xml);
  }

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

// ── Session State Management ───────────────────────────────

async function startSession(chatId, templateId, factDocText) {
  await initDraftTables();
  await db.query(
    `INSERT INTO draft_sessions (chat_id, template_id, state, collected, fact_doc_text, missing_fields)
     VALUES ($1, $2, 'started', '{}'::jsonb, $3, ARRAY[]::text[])
     ON CONFLICT (chat_id) DO UPDATE SET
       template_id = $2,
       state = 'started',
       collected = '{}'::jsonb,
       fact_doc_text = $3,
       missing_fields = ARRAY[]::text[],
       updated_at = NOW()`,
    [chatId, templateId, factDocText]
  );
}

async function getSession(chatId) {
  const r = await db.query(
    `SELECT * FROM draft_sessions WHERE chat_id = $1`,
    [chatId]
  );
  return r.rows[0] || null;
}

async function updateSession(chatId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updates)) {
    if (key === "collected" || key === "fact_doc_text") {
      fields.push(`${key} = $${idx}::${key === "collected" ? "jsonb" : "text"}`);
      values.push(key === "collected" ? JSON.stringify(value) : value);
    } else if (key === "missing_fields") {
      fields.push(`${key} = $${idx}::text[]`);
      values.push(value);
    } else {
      fields.push(`${key} = $${idx}`);
      values.push(value);
    }
    idx++;
  }
  fields.push(`updated_at = NOW()`);
  values.push(chatId);
  await db.query(
    `UPDATE draft_sessions SET ${fields.join(", ")} WHERE chat_id = $${idx}`,
    values
  );
}

async function clearSession(chatId) {
  await db.query(`DELETE FROM draft_sessions WHERE chat_id = $1`, [chatId]);
}

// ── Full Draft Pipeline ────────────────────────────────────

/**
 * Complete the draft — generate all narrative sections and fill template.
 * Called after user confirms values.
 *
 * @returns {Buffer} the filled .docx buffer
 */
async function completeDraft({ session, template, sendProgress }) {
  const placeholders = template.placeholders;
  const collected = { ...session.collected };
  const factDocText = session.fact_doc_text;

  // Get moat + firm search functions
  let searchParensHybrid, formatMoatContext, searchFirmDocs, formatFirmContext;
  try {
    const jcr = require("./judge-cross-reference");
    searchParensHybrid = jcr.searchParensHybrid;
    formatMoatContext = jcr.formatMoatContext;
  } catch (e) { console.log("[draft] moat search unavailable:", e.message); }

  try {
    const fd = require("./firm-documents");
    searchFirmDocs = fd.searchFirmDocs;
    formatFirmContext = fd.formatFirmContext;
  } catch (e) { console.log("[draft] firm docs unavailable:", e.message); }

  const usedMoatIds = [];
  const usedFirmIds = [];
  const narrativeFields = placeholders.filter(p => p.type === "narrative");

  let i = 0;
  for (const ph of narrativeFields) {
    i++;
    if (sendProgress) {
      await sendProgress(`✏️ Drafting ${i}/${narrativeFields.length}: ${ph.humanLabel}...`);
    }

    // Build search query from placeholder name + collected facts
    const searchQuery = buildSearchQuery(ph.name, collected, factDocText);

    let moatContext = "";
    let firmContext = "";

    // Search moat
    if (searchParensHybrid && formatMoatContext) {
      try {
        const results = await searchParensHybrid(searchQuery, {
          limit: 15,
          minSimilarity: 0.35,
          candidatePoolSize: 2000,
        });
        if (results && results.length) {
          moatContext = formatMoatContext(results, { maxLength: 3500 });
          for (const r of results) usedMoatIds.push(r.id);
        }
      } catch (e) { console.log("[draft] moat search fail:", e.message); }
    }

    // Search firm docs
    if (searchFirmDocs && formatFirmContext) {
      try {
        const firmResults = await searchFirmDocs(searchQuery, { limit: 5 });
        if (firmResults && firmResults.length) {
          firmContext = formatFirmContext(firmResults, { maxLength: 2500 });
          for (const r of firmResults) usedFirmIds.push(r.id);
        }
      } catch (e) { console.log("[draft] firm search fail:", e.message); }
    }

    // Draft the section
    const result = await draftNarrativeSection({
      placeholderName: ph.name,
      templateName: template.name,
      collectedValues: collected,
      factDocText,
      moatContext,
      firmContext,
    });

    if (result.ok) {
      collected[ph.name] = result.content;
    } else {
      collected[ph.name] = `[DRAFT ERROR — please fill manually: ${result.error}]`;
    }
  }

  // Fill the template
  if (sendProgress) await sendProgress(`📄 Assembling final document...`);
  const filledDocx = fillDocxTemplate(template.docx_content, collected);

  // Record in history
  await db.query(
    `INSERT INTO draft_history
      (template_id, template_name, input_values, used_moat_ids, used_firm_ids, output_docx, chat_id)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
    [
      template.id,
      template.name,
      JSON.stringify(session.collected), // original inputs, not narrative content
      Array.from(new Set(usedMoatIds)),
      Array.from(new Set(usedFirmIds)),
      filledDocx,
      session.chat_id,
    ]
  );

  return filledDocx;
}

/**
 * Build a semantic search query for a given placeholder + case context.
 */
function buildSearchQuery(placeholderName, collected, factDocText) {
  const upper = placeholderName.toUpperCase();
  const bits = [];

  // Include key case identifiers
  for (const [key, value] of Object.entries(collected)) {
    if (key.toUpperCase().includes("COUNTRY") || key.toUpperCase().includes("TYPE") ||
        key.toUpperCase().includes("ISSUE")) {
      bits.push(String(value));
    }
  }

  // Extract attorney notes if present — most valuable signal for search
  let attorneyNotes = "";
  if (factDocText) {
    const notesMatch = factDocText.match(/=== ATTORNEY NOTES ON CASE ===\n([\s\S]*?)(?:\n\n=== ATTACHED|$)/);
    if (notesMatch) attorneyNotes = notesMatch[1].trim();
  }

  // Add section-specific keywords
  if (upper.includes("STANDARD_OF_REVIEW")) {
    bits.push("clearly erroneous", "de novo", "standard of review BIA");
    // If attorney notes mention specific error types, include them
    if (attorneyNotes) {
      if (/credibility|credib/i.test(attorneyNotes)) bits.push("credibility finding review");
      if (/one[\s-]?year|1[\s-]?year|MAF/i.test(attorneyNotes)) bits.push("one-year bar asylum");
      if (/CLP|circumstances/i.test(attorneyNotes)) bits.push("CLP rule vacated");
    }
  } else if (upper.includes("ISSUES_PRESENTED")) {
    bits.push("immigration judge error");
    if (attorneyNotes) bits.push(attorneyNotes.substring(0, 300));
  } else if (upper.includes("ARGUMENT")) {
    // Attorney notes are the best signal for what to search
    if (attorneyNotes) {
      bits.push(attorneyNotes.substring(0, 400));
    } else if (factDocText) {
      const factSnippet = factDocText.substring(0, 500);
      bits.push(factSnippet);
    }
  } else if (upper.includes("STATEMENT_OF_FACTS")) {
    // Facts section: use client identifying info + country
    if (attorneyNotes) bits.push(attorneyNotes.substring(0, 300));
  } else if (upper.includes("INTRODUCTION")) {
    if (attorneyNotes) bits.push(attorneyNotes.substring(0, 200));
  } else if (upper.includes("THREE_MEMBER")) {
    bits.push("three member review BIA precedent");
  } else if (upper.includes("CONCLUSION")) {
    if (attorneyNotes) bits.push(attorneyNotes.substring(0, 200));
  }

  return bits.filter(Boolean).join(" ").substring(0, 500) || placeholderName;
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  initDraftTables,
  extractPlaceholders,
  classifyPlaceholder,
  humanizeName,
  saveTemplate,
  getTemplate,
  listTemplates,
  deleteTemplate,
  extractFactDocText,
  autoFillSimpleFromFactDoc,
  draftNarrativeSection,
  fillDocxTemplate,
  startSession,
  getSession,
  updateSession,
  clearSession,
  completeDraft,
  buildSearchQuery,
};

// ── CLI Mode (for local testing) ──────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--init")) {
      await initDraftTables();
      console.log("Draft tables initialized: draft_templates, draft_history, draft_sessions");
      process.exit(0);
    }
    if (args.includes("--list")) {
      const templates = await listTemplates();
      console.log(`\n${templates.length} template(s):\n`);
      for (const t of templates) {
        console.log(`  #${t.id} | ${t.name} | ${t.practice_area || "-"} | ${t.placeholder_count} placeholders`);
      }
      process.exit(0);
    }
    console.log(`Usage:
  node draft-templates.js --init      Initialize tables
  node draft-templates.js --list      List templates
`);
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
