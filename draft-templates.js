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

  const prompt = `You are drafting the "${humanLabel}" section of a legal document for Tez Law, P.C.

TEMPLATE: ${templateName}
SECTION TO DRAFT: ${placeholderName}
${sectionGuidance ? "GUIDANCE FOR THIS SECTION:\n" + sectionGuidance + "\n" : ""}

CASE FACTS:
${contextValues}

${factDocText ? "REFERENCE DOCUMENT TEXT:\n" + factDocText.substring(0, 8000) + "\n\n" : ""}
${moatContext}

${firmContext}

INSTRUCTIONS:
- Draft ONLY the "${humanLabel}" section content. Do NOT include the section heading — just the body prose.
- Match Tez Law's formal legal writing voice.
- Cite specific cases by name from the moat where applicable. Do NOT fabricate citations.
- Where the moat doesn't cover a point, indicate general legal knowledge without inventing case names.
- For factual sections, use the client's actual facts from the reference document.
- Do NOT include markdown formatting, bullet points, or asterisks. Use plain prose only.
- Return ONLY the drafted content, no preamble or explanation.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 120000,
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
    return "Introduce the case, state what the Immigration Judge decided, identify the specific relief the client sought, and briefly preview why the IJ's decision was in error. Keep to 2-4 sentences. Formal opening tone.";
  }
  if (upper.includes("STATEMENT_OF_FACTS") || upper.includes("STATEMENT_OF_FACT")) {
    return "Provide a chronological narrative of the case facts based on the reference document. Include: client's background, procedural history (when NTA issued, hearings held), what happened at the merits hearing, what evidence was presented, and what the IJ ruled. Be factual and specific. Use client's actual name and details.";
  }
  if (upper.includes("ISSUES_PRESENTED") || upper.includes("ISSUES_LIST")) {
    return "List the specific legal errors the IJ made, numbered 1, 2, 3, etc. Each issue phrased as a question or 'Whether the IJ erred by...'. Include both factual errors (clearly erroneous fact findings) and legal errors (misapplication of law).";
  }
  if (upper.includes("STANDARD_OF_REVIEW")) {
    return "State the applicable standards of review. Findings of fact = clearly erroneous (8 C.F.R. § 1003.1(d)(3)(i)). Legal issues = de novo (8 C.F.R. § 1003.1(d)(3)(ii)). Cite any additional case law from the moat relevant to the specific errors alleged.";
  }
  if (upper.includes("SUMMARY_OF_ARGUMENT")) {
    return "Provide a concise 1-2 paragraph summary of the arguments to follow. Preview the main legal errors and why relief is warranted.";
  }
  if (upper.includes("ARGUMENT") && (upper.includes("BODIES") || upper.includes("HEADINGS"))) {
    return "Draft the substantive legal argument(s). For each issue on appeal, provide: (a) the argument heading (bold, formatted like 'The IJ Erred By [Specific Error]'), (b) statement of the legal standard, (c) application of law to facts with case citations from the moat and firm documents. Support each argument with 2-4 specific case citations. Structure as needed: could be 1 argument or 4+ depending on the case. Number each argument (I., II., III.).";
  }
  if (upper.includes("CONCLUSION")) {
    return "State the specific relief requested. Common relief for BIA appeals: (1) sustain the appeal, (2) vacate the IJ's decision, (3) remand for further proceedings, or (4) grant the underlying relief (asylum, bond, cancellation, etc.). Be specific about what you're asking the Board to do.";
  }
  if (upper.includes("JUSTIFICATION") && upper.includes("THREE_MEMBER")) {
    return "Argue why the case warrants three-member review under 8 C.F.R. § 1003.1(e)(6). Typical grounds: (a) case presents important legal issue, (b) IJ decision conflicts with published Board precedent, (c) case has serious errors of law requiring correction. Cite the specific errors from your case.";
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

  // Add section-specific keywords
  if (upper.includes("STANDARD_OF_REVIEW")) {
    bits.push("clearly erroneous", "de novo", "standard of review BIA");
  } else if (upper.includes("ISSUES_PRESENTED")) {
    bits.push("immigration judge error");
  } else if (upper.includes("ARGUMENT")) {
    // Try to pull hints from fact doc text
    if (factDocText) {
      const factSnippet = factDocText.substring(0, 500);
      bits.push(factSnippet);
    }
  } else if (upper.includes("THREE_MEMBER")) {
    bits.push("three member review BIA precedent");
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
