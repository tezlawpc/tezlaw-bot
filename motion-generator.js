// motion-generator.js — Court motion draft generator using Claude Sonnet
//
// Generates first-draft motions for immigration cases (v1). Supports:
//   - Motion for Continuance (48c)
//   - Motion to Reopen
//   - Motion for Change of Venue
//
// Workflow:
//   1. Attorney picks motion type + client (from hearing note or manual)
//   2. Provides specific facts/grounds
//   3. Claude Sonnet generates full draft using case history from hearing_notes
//   4. Attorney reviews + edits in browser
//   5. Downloads as .docx or uploads directly to client's Dropbox folder
//
// Entry points:
//   - /admin/motions           — list all motions
//   - /admin/motions/new       — start a new motion (Motion-First)
//   - Button on hearing note   — pre-fill from hearing (Case-First)
//   - Button on client profile — pre-fill from client history (Case-First)
//
// DOCX generation uses pizzip (already installed) — no new npm dependencies.

const db = require("./db");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
const PizZip = require("pizzip");
const axios = require("axios");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-5-20250929";

const brand = { gold: "#B79C62", navy: "#0C1C36" };

// ─── Motion type definitions ─────────────────────────

const MOTION_TYPES = {
  continuance: {
    label: "Motion for Continuance",
    short: "Continuance",
    category: "immigration",
    citation: "8 C.F.R. § 1003.29; Matter of Sanchez Sosa, 25 I&N Dec. 807 (BIA 2012); Matter of L-A-B-R-, 27 I&N Dec. 405 (A.G. 2018)",
    system_prompt: `You are a licensed immigration attorney drafting a Motion for Continuance for immigration court (EOIR).

The motion must be professional, well-supported by good cause under Matter of L-A-B-R-, and formatted for filing with EOIR.

Structure the motion in these sections:
1. CAPTION (court, respondent, A#, in the matter of)
2. INTRODUCTION - one paragraph identifying the motion and party
3. PROCEDURAL HISTORY - concise summary of the case posture
4. LEGAL STANDARD - cite 8 C.F.R. § 1003.29, Matter of L-A-B-R- (good cause factors: likelihood of relief, statutory or regulatory bases, DHS position, procedural posture, diligence, prior continuances)
5. STATEMENT OF GOOD CAUSE - apply the L-A-B-R- factors to these facts
6. PRAYER FOR RELIEF - specific requested continuance date range if provided
7. RESPECTFULLY SUBMITTED signature block for TEZ LAW FIRM (JJ Zhang, Managing Attorney, CA Bar #326666)
8. CERTIFICATE OF SERVICE

Use formal legal writing. First-person plural ("Respondent respectfully requests..."). Do NOT include headers like "**Motion Draft**" — output the motion itself.`,
  },

  motion_to_reopen: {
    label: "Motion to Reopen",
    short: "Reopen",
    category: "immigration",
    citation: "8 C.F.R. § 1003.23(b)(3); INA § 240(c)(7); Matter of Coelho, 20 I&N Dec. 464 (BIA 1992)",
    system_prompt: `You are a licensed immigration attorney drafting a Motion to Reopen an immigration case (EOIR).

The motion must satisfy the requirements of 8 C.F.R. § 1003.23(b)(3) and address the 90-day time bar under INA § 240(c)(7) (or argue equitable tolling / an applicable exception).

Structure:
1. CAPTION (court, respondent, A#)
2. INTRODUCTION
3. PROCEDURAL HISTORY - prior order date and disposition, why timing matters
4. LEGAL STANDARD - 8 C.F.R. § 1003.23(b)(3), Coelho, and any relevant time-bar exceptions (changed country conditions under INA § 240(c)(7)(C)(ii), ineffective assistance under Matter of Lozada, sua sponte reopening, etc.)
5. GROUNDS FOR REOPENING - the specific new facts / evidence / changed circumstances warranting reopening. Apply the "material, previously unavailable" standard.
6. TIMELINESS ANALYSIS - address the 90-day bar directly (met, or excused, or exception applies)
7. PRIMA FACIE ELIGIBILITY FOR RELIEF - if applicable, show respondent is eligible for the underlying relief sought (asylum, cancellation, adjustment, etc.)
8. PRAYER FOR RELIEF
9. Signature block: TEZ LAW FIRM, JJ Zhang, Managing Attorney, CA Bar #326666
10. CERTIFICATE OF SERVICE

Reference attached exhibits by exhibit letter. Use formal legal writing. Output the motion itself, no meta-commentary.`,
  },

  change_of_venue: {
    label: "Motion for Change of Venue",
    short: "Change of Venue",
    category: "immigration",
    citation: "8 C.F.R. § 1003.20; Matter of Rahman, 20 I&N Dec. 480 (BIA 1992)",
    system_prompt: `You are a licensed immigration attorney drafting a Motion for Change of Venue in immigration court.

The motion must show good cause under 8 C.F.R. § 1003.20 and Matter of Rahman.

Structure:
1. CAPTION - current court + A# + respondent
2. INTRODUCTION - motion type, current court, requested court
3. PROCEDURAL HISTORY
4. LEGAL STANDARD - 8 C.F.R. § 1003.20 good cause factors:
   - Administrative convenience
   - Expeditious treatment of the case
   - Location of witnesses/counsel/evidence
   - Compliance with time requirements
5. STATEMENT OF GOOD CAUSE - apply factors to these facts (respondent's address change, counsel location, witnesses)
6. WAIVER OF APPEARANCE at any pending master calendar hearings pending resolution (if applicable)
7. PRAYER FOR RELIEF - transfer to specific requested court
8. Signature: TEZ LAW FIRM
9. CERTIFICATE OF SERVICE

Use formal legal writing. Output the motion itself.`,
  },
};

// ─── Schema ──────────────────────────────────────────

async function init() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS motions (
      id                SERIAL PRIMARY KEY,
      client_name       TEXT,
      a_number          TEXT,
      motion_type       TEXT NOT NULL,
      practice_area     TEXT DEFAULT 'immigration',
      court_name        TEXT,
      judge_name        TEXT,
      case_number       TEXT,
      hearing_note_id   INTEGER,
      filing_deadline   DATE,
      status            TEXT DEFAULT 'draft',
      version           INTEGER DEFAULT 1,
      title             TEXT,
      content_markdown  TEXT,
      ai_grounds        TEXT,
      ai_facts          TEXT,
      ai_notes          TEXT,
      dropbox_path      TEXT,
      generated_by      INTEGER,
      filed_at          TIMESTAMP,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_motions_client ON motions(client_name, a_number)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_motions_status ON motions(status, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_motions_hearing ON motions(hearing_note_id)`);
  console.log("[motion-generator] Schema initialized");
}

// ─── DB operations ───────────────────────────────────

async function createMotion(fields) {
  const { rows } = await db.query(
    `INSERT INTO motions (
       client_name, a_number, motion_type, practice_area, court_name, judge_name,
       hearing_note_id, filing_deadline, title, content_markdown,
       ai_grounds, ai_facts, ai_notes, generated_by, status
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      fields.client_name || null,
      fields.a_number || null,
      fields.motion_type,
      fields.practice_area || "immigration",
      fields.court_name || null,
      fields.judge_name || null,
      fields.hearing_note_id || null,
      fields.filing_deadline || null,
      fields.title || null,
      fields.content_markdown || null,
      fields.ai_grounds || null,
      fields.ai_facts || null,
      fields.ai_notes || null,
      fields.generated_by || null,
      fields.status || "draft",
    ]
  );
  return rows[0].id;
}

async function updateMotion(id, fields) {
  const allowed = [
    "client_name", "a_number", "court_name", "judge_name",
    "filing_deadline", "title", "content_markdown", "status", "dropbox_path",
    "filed_at",
  ];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return;
  sets.push(`updated_at = NOW()`);
  values.push(id);
  await db.query(`UPDATE motions SET ${sets.join(", ")} WHERE id = $${i}`, values);
}

async function getMotion(id) {
  const { rows } = await db.query(`SELECT * FROM motions WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function listMotions({ status, client_name, motion_type, limit = 100 } = {}) {
  const where = [];
  const params = [];
  let i = 1;
  if (status) { where.push(`status = $${i++}`); params.push(status); }
  if (client_name) { where.push(`(client_name ILIKE $${i} OR a_number ILIKE $${i})`); params.push(`%${client_name}%`); i++; }
  if (motion_type) { where.push(`motion_type = $${i++}`); params.push(motion_type); }
  const sql = `
    SELECT id, client_name, a_number, motion_type, court_name, status, title,
           filing_deadline, created_at, updated_at, filed_at, dropbox_path
    FROM motions
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC
    LIMIT ${parseInt(limit, 10)}
  `;
  const { rows } = await db.query(sql, params);
  return rows;
}

async function deleteMotion(id) {
  await db.query(`DELETE FROM motions WHERE id = $1`, [id]);
}

// ─── Case history retrieval ──────────────────────────

async function getCaseContext({ client_name, a_number, hearing_note_id }) {
  const context = {};

  // Pull specific hearing note if provided
  if (hearing_note_id) {
    const { rows } = await db.query(
      `SELECT * FROM hearing_notes WHERE id = $1`,
      [hearing_note_id]
    );
    if (rows.length) {
      context.current_hearing = rows[0];
      client_name = client_name || rows[0].client_name;
      a_number = a_number || rows[0].a_number;
    }
  }

  // Pull all prior hearing notes for this client (by A# or name)
  if (a_number || client_name) {
    const identifiers = [];
    const idParams = [];
    if (a_number) { identifiers.push(`a_number = $${idParams.length + 1}`); idParams.push(a_number); }
    if (client_name) { identifiers.push(`client_name ILIKE $${idParams.length + 1}`); idParams.push(client_name); }
    const { rows } = await db.query(
      `SELECT id, hearing_date, hearing_type, judge_name, dhs_attorney,
              disposition, disposition_notes, paralegal_summary, deadlines, next_hearing_date
       FROM hearing_notes
       WHERE ${identifiers.join(" OR ")}
       ORDER BY hearing_date DESC NULLS LAST
       LIMIT 20`,
      idParams
    );
    context.hearing_history = rows;
  }

  // Also pull individual merits hearing notes if available
  try {
    if (a_number || client_name) {
      const identifiers = [];
      const idParams = [];
      if (a_number) { identifiers.push(`a_number = $${idParams.length + 1}`); idParams.push(a_number); }
      if (client_name) { identifiers.push(`client_name ILIKE $${idParams.length + 1}`); idParams.push(client_name); }
      const { rows } = await db.query(
        `SELECT id, hearing_date, judge_name, dhs_attorney, disposition, next_action_deadline,
                paralegal_summary
         FROM individual_hearing_notes
         WHERE ${identifiers.join(" OR ")}
         ORDER BY hearing_date DESC
         LIMIT 10`,
        idParams
      );
      context.individual_hearings = rows;
    }
  } catch { /* table may not exist yet */ }

  // Any active deadlines for the client
  try {
    if (a_number || client_name) {
      const idParams = [];
      const conds = ["status = 'pending'"];
      if (a_number) { conds.push(`a_number = $${idParams.length + 1}`); idParams.push(a_number); }
      else if (client_name) { conds.push(`client_name ILIKE $${idParams.length + 1}`); idParams.push(client_name); }
      const { rows } = await db.query(
        `SELECT due_date, description FROM deadlines
         WHERE ${conds.join(" AND ")}
         ORDER BY due_date ASC LIMIT 10`,
        idParams
      );
      context.active_deadlines = rows;
    }
  } catch { /* deadlines table may not exist */ }

  return context;
}

// ─── Claude generation ───────────────────────────────

async function generateMotion({ motion_type, client_name, a_number, hearing_note_id, court_name, judge_name, filing_deadline, grounds, additional_facts }) {
  const motionConfig = MOTION_TYPES[motion_type];
  if (!motionConfig) throw new Error(`Unknown motion type: ${motion_type}`);

  const context = await getCaseContext({ client_name, a_number, hearing_note_id });

  // Build the case history block
  let historyBlock = "";
  if (context.hearing_history?.length) {
    historyBlock += "\n\nPRIOR HEARING NOTES:\n";
    for (const h of context.hearing_history.slice(0, 5)) {
      const dt = h.hearing_date ? new Date(h.hearing_date).toLocaleDateString() : "unknown date";
      historyBlock += `- ${dt}: ${h.hearing_type || "hearing"}, Judge ${h.judge_name || "unknown"}, DHS ${h.dhs_attorney || "unknown"}. Disposition: ${h.disposition || "n/a"}. ${h.disposition_notes || ""}\n`;
      if (h.paralegal_summary) {
        historyBlock += `  Summary: ${h.paralegal_summary.substring(0, 400)}\n`;
      }
    }
  }

  if (context.individual_hearings?.length) {
    historyBlock += "\nINDIVIDUAL/MERITS HEARINGS:\n";
    for (const h of context.individual_hearings) {
      const dt = h.hearing_date ? new Date(h.hearing_date).toLocaleDateString() : "unknown date";
      historyBlock += `- ${dt}: Judge ${h.judge_name || "unknown"}, Disposition: ${h.disposition || "n/a"}\n`;
    }
  }

  if (context.active_deadlines?.length) {
    historyBlock += "\nACTIVE DEADLINES:\n";
    for (const d of context.active_deadlines) {
      historyBlock += `- ${new Date(d.due_date).toLocaleDateString()}: ${d.description}\n`;
    }
  }

  // Build user prompt
  const userPrompt = `Draft a ${motionConfig.label} for the following case:

CLIENT: ${client_name || "[client name to be filled]"}
A-NUMBER: ${a_number || "[A-number to be filled]"}
COURT: ${court_name || "[court name to be filled]"}
JUDGE: ${judge_name || "[judge to be filled]"}
${filing_deadline ? `FILING DEADLINE: ${filing_deadline}\n` : ""}
GROUNDS FOR MOTION:
${grounds || "(counsel will supply — draft with placeholder [GROUNDS TO BE SUPPLIED])"}

${additional_facts ? `ADDITIONAL FACTS:\n${additional_facts}\n` : ""}
CASE HISTORY:${historyBlock || "\n(no prior hearing notes available in system)"}

Draft the motion in Markdown format. Use ## for major section headers and normal paragraphs for body text. Be specific and case-focused — apply legal standards to THIS respondent's facts, not generic language.

For any fact you cannot verify from the record, use bracketed placeholders like [DATE], [SPECIFIC EVIDENCE], or [ATTORNEY WILL VERIFY] so the drafter knows to fill in.

Do not include any preamble like "Here is the motion:" — output the motion directly starting with the caption.`;

  console.log(`[motion-generator] Generating ${motion_type} for ${client_name || "unnamed"}`);
  const start = Date.now();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    system: motionConfig.system_prompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const elapsed = Math.round((Date.now() - start) / 1000);
  const markdown = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n\n");

  console.log(`[motion-generator] Generated ${markdown.length} chars in ${elapsed}s`);

  return {
    markdown,
    tokens_used: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    generation_seconds: elapsed,
    context_summary: {
      prior_hearings: context.hearing_history?.length || 0,
      individual_hearings: context.individual_hearings?.length || 0,
      active_deadlines: context.active_deadlines?.length || 0,
    },
  };
}

// ─── DOCX generation from markdown ───────────────────

// Generate DOCX for a motion. If a matching template exists, use it (with
// placeholder substitution). Otherwise fall back to standalone generation.
async function generateDocxForMotion(motion) {
  const templates = require("./motion-templates");
  const template = await templates.getTemplateForMotion(motion.motion_type).catch(() => null);

  if (template && template.docx_content) {
    // Apply template
    const cfg = MOTION_TYPES[motion.motion_type] || {};
    const buffer = Buffer.isBuffer(template.docx_content) ? template.docx_content : Buffer.from(template.docx_content);
    return templates.applyTemplate(buffer, {
      title: (motion.title || cfg.label || motion.motion_type).toUpperCase(),
      client_name: motion.client_name || "",
      a_number: motion.a_number || "",
      court_name: motion.court_name || "",
      judge_name: motion.judge_name || "",
      case_number: "",
      filing_deadline: motion.filing_deadline ? new Date(motion.filing_deadline).toLocaleDateString("en-US") : "",
      content_markdown: motion.content_markdown || "",
      date: new Date().toLocaleDateString("en-US"),
    });
  }

  // No template — fall back to plain generation
  return generateDocx({
    title: motion.title || MOTION_TYPES[motion.motion_type]?.label,
    motionType: motion.motion_type,
    clientName: motion.client_name,
    aNumber: motion.a_number,
    markdown: motion.content_markdown || "",
  });
}

// Simple markdown → DOCX converter. Handles:
//   ## Header → bold, size 24pt, uppercase-friendly
//   Regular paragraphs → 12pt
//   **bold** → runs with bold formatting
//   *italic* → italic runs
//   Line breaks preserved
//
// Uses pizzip to write a valid .docx (Open Office XML) file.

function generateDocx({ title, motionType, clientName, aNumber, markdown }) {
  const paragraphs = markdownToWordXML(markdown, { title, motionType, clientName, aNumber });

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="120" w:line="360" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
</w:styles>`;

  const zip = new PizZip();
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("_rels/.rels", relsXml);
  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", documentRelsXml);
  zip.file("word/styles.xml", stylesXml);

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

// Convert markdown to Word XML paragraphs.
function markdownToWordXML(md, meta) {
  const lines = md.split(/\r?\n/);
  const paragraphs = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      // Empty line — insert empty paragraph
      paragraphs.push(`<w:p/>`);
      continue;
    }

    // ## Header
    if (/^##\s+/.test(line)) {
      const text = escapeXml(line.replace(/^##\s+/, ""));
      paragraphs.push(`<w:p>
  <w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
  <w:r>
    <w:rPr><w:b/><w:sz w:val="26"/></w:rPr>
    <w:t xml:space="preserve">${text}</w:t>
  </w:r>
</w:p>`);
      continue;
    }

    // # Big header (used for CAPTION or title)
    if (/^#\s+/.test(line)) {
      const text = escapeXml(line.replace(/^#\s+/, ""));
      paragraphs.push(`<w:p>
  <w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>
  <w:r>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr>
    <w:t xml:space="preserve">${text}</w:t>
  </w:r>
</w:p>`);
      continue;
    }

    // Normal paragraph — supports **bold** and *italic* inline
    const runs = renderInlineRuns(line);
    paragraphs.push(`<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${runs}</w:p>`);
  }

  return paragraphs.join("\n");
}

function renderInlineRuns(text) {
  // Simple markdown inline parser: **bold**, *italic*
  const runs = [];
  let remaining = text;
  const BOLD = /\*\*(.+?)\*\*/;
  const ITALIC = /\*(.+?)\*/;

  while (remaining.length) {
    // Find earliest match of ** or *
    const boldMatch = remaining.match(BOLD);
    const italicMatch = remaining.match(ITALIC);

    let match = null;
    let type = null;
    if (boldMatch && (!italicMatch || boldMatch.index <= italicMatch.index)) {
      match = boldMatch; type = "bold";
    } else if (italicMatch) {
      match = italicMatch; type = "italic";
    }

    if (!match) {
      runs.push(makeRun(remaining));
      break;
    }

    if (match.index > 0) {
      runs.push(makeRun(remaining.substring(0, match.index)));
    }
    runs.push(makeRun(match[1], type));
    remaining = remaining.substring(match.index + match[0].length);
  }

  return runs.join("");
}

function makeRun(text, style = null) {
  const escapedText = escapeXml(text);
  const rPr = style === "bold" ? "<w:rPr><w:b/></w:rPr>"
            : style === "italic" ? "<w:rPr><w:i/></w:rPr>"
            : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapedText}</w:t></w:r>`;
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Dropbox upload ──────────────────────────────────

async function uploadToDropbox(motionId) {
  const motion = await getMotion(motionId);
  if (!motion) throw new Error("Motion not found");
  if (!motion.content_markdown) throw new Error("Motion has no content");

  const docxBuffer = await generateDocxForMotion(motion);

  // Sanitize client name for folder path
  const safeClientName = (motion.client_name || "unknown").replace(/[<>:"|?*\\/]/g, "_");
  const dateStr = new Date().toISOString().substring(0, 10);
  const motionShort = MOTION_TYPES[motion.motion_type]?.short || motion.motion_type;
  const filename = `${dateStr}_${motionShort}_${safeClientName}_v${motion.version || 1}.docx`;

  // Path: try to find client folder in Dropbox, else use /USCIS/_MOTIONS
  const dbx = require("./dropbox-integration");
  const token = await dbx.getAccessToken();
  const pathRootHeader = await dbx.getPathRootHeader();

  let uploadPath;
  try {
    // Attempt to locate client folder via existing matcher (memory-noted feature)
    if (dbx.findClientFolder && motion.client_name) {
      const folderMatch = await dbx.findClientFolder({ client_name: motion.client_name, a_number: motion.a_number });
      if (folderMatch?.path) {
        uploadPath = `${folderMatch.path}/Motions/${filename}`;
      }
    }
  } catch (e) {
    console.warn("[motion-generator] Client folder lookup failed:", e.message);
  }

  if (!uploadPath) {
    // Fallback to _MOTIONS holding folder
    uploadPath = `/USCIS/_MOTIONS/${filename}`;
  }

  const uploadHeaders = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
    "Dropbox-API-Arg": JSON.stringify({
      path: uploadPath,
      mode: "add",
      autorename: true,
      mute: true,
    }),
  };
  if (pathRootHeader) uploadHeaders["Dropbox-API-Path-Root"] = pathRootHeader;

  try {
    const resp = await axios.post(
      "https://content.dropboxapi.com/2/files/upload",
      docxBuffer,
      { headers: uploadHeaders, timeout: 60000, maxBodyLength: 50 * 1024 * 1024 }
    );
    const finalPath = resp.data.path_display || uploadPath;
    await updateMotion(motionId, { dropbox_path: finalPath });
    return { path: finalPath, size: resp.data.size };
  } catch (e) {
    const dbxErr = e.response?.data?.error_summary || e.message;
    throw new Error(`Dropbox upload failed: ${dbxErr}`);
  }
}

// ─── UI rendering ────────────────────────────────────

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMotionListPage(motions, filters = {}) {
  const rows = motions.map(m => {
    const type = MOTION_TYPES[m.motion_type]?.short || m.motion_type;
    const dt = new Date(m.created_at).toLocaleDateString();
    const statusColor = m.status === "filed" ? "#2e7d32"
                       : m.status === "reviewed" ? "#0061FF"
                       : "#B79C62";
    return `
      <tr style="border-bottom:1px solid #eee;">
        <td style="padding:10px 12px;"><a href="/admin/motions/${m.id}" style="color:${brand.gold}; font-weight:600; text-decoration:none;">${escapeHtml(m.title || type)}</a></td>
        <td style="padding:10px 12px;">${escapeHtml(m.client_name || "-")} ${m.a_number ? `<span style="color:#888; font-size:11px;">(${escapeHtml(m.a_number)})</span>` : ""}</td>
        <td style="padding:10px 12px;"><span style="background:${statusColor}; color:white; padding:2px 8px; border-radius:4px; font-size:11px;">${m.status}</span></td>
        <td style="padding:10px 12px; color:#666; font-size:12px;">${dt}</td>
        <td style="padding:10px 12px; font-size:12px;">
          ${m.dropbox_path ? `<span style="color:#0061FF;">📁 Dropbox</span>` : ""}
          ${m.filed_at ? `<span style="color:#2e7d32;">✅ Filed</span>` : ""}
        </td>
      </tr>`;
  }).join("");

  const motionTypeOptions = Object.entries(MOTION_TYPES).map(([key, cfg]) =>
    `<option value="${key}" ${filters.motion_type === key ? "selected" : ""}>${cfg.label}</option>`
  ).join("");

  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
    <h1 style="margin:0;">📜 Court Motions</h1>
    <div style="display:flex; gap:8px;">
      <a href="/admin/motions/templates" style="background:#eee; color:#333; padding:9px 16px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;">📋 Templates</a>
      <a href="/admin/motions/new" style="background:${brand.gold}; color:white; padding:9px 16px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;">+ New motion</a>
    </div>
  </div>

  <form method="GET" style="background:#f8f8f8; padding:12px; border-radius:6px; margin:16px 0; display:flex; gap:8px; flex-wrap:wrap; align-items:end;">
    <div>
      <label style="display:block; font-size:11px; color:#666;">Client / A#</label>
      <input type="text" name="client" value="${escapeHtml(filters.client_name || "")}" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px; width:200px;">
    </div>
    <div>
      <label style="display:block; font-size:11px; color:#666;">Motion type</label>
      <select name="type" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px;">
        <option value="">All</option>
        ${motionTypeOptions}
      </select>
    </div>
    <div>
      <label style="display:block; font-size:11px; color:#666;">Status</label>
      <select name="status" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px;">
        <option value="">All</option>
        <option value="draft" ${filters.status === "draft" ? "selected" : ""}>Draft</option>
        <option value="reviewed" ${filters.status === "reviewed" ? "selected" : ""}>Reviewed</option>
        <option value="filed" ${filters.status === "filed" ? "selected" : ""}>Filed</option>
      </select>
    </div>
    <button type="submit" style="background:${brand.navy}; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Filter</button>
    <a href="/admin/motions" style="padding:8px 16px; color:#666; text-decoration:none; font-size:13px;">Reset</a>
  </form>

  <div style="background:white; border:1px solid #e0e0e0; border-radius:6px; overflow:hidden;">
    <table style="width:100%; border-collapse:collapse;">
      <thead style="background:#f8f8f8;">
        <tr>
          <th style="padding:10px 12px; text-align:left; font-size:12px; color:#666;">Motion</th>
          <th style="padding:10px 12px; text-align:left; font-size:12px; color:#666;">Client</th>
          <th style="padding:10px 12px; text-align:left; font-size:12px; color:#666;">Status</th>
          <th style="padding:10px 12px; text-align:left; font-size:12px; color:#666;">Created</th>
          <th style="padding:10px 12px; text-align:left; font-size:12px; color:#666;">Actions</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="5" style="text-align:center; padding:30px; color:#888;">No motions yet. Click <b>+ New motion</b> to draft one.</td></tr>`}</tbody>
    </table>
  </div>`;
}

function renderNewMotionForm(prefill = {}) {
  const motionOptions = Object.entries(MOTION_TYPES).map(([key, cfg]) =>
    `<option value="${key}" ${prefill.motion_type === key ? "selected" : ""}>${cfg.label}</option>`
  ).join("");

  return `
  <div class="page-header">
    <h1>📜 New Motion</h1>
    <a href="/admin/motions" class="back-link">← All motions</a>
  </div>

  <p style="color:#666; margin-bottom:20px;">Fill in the details below. Claude Sonnet drafts the motion using client history from hearing notes, and you can edit before finalizing.</p>

  <form id="new-motion-form" onsubmit="submitNewMotion(event)" style="max-width:720px;">
    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #e0e0e0; margin-bottom:16px;">
      <h3 style="margin-top:0; color:${brand.navy};">Motion type</h3>
      <select name="motion_type" required style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
        <option value="">-- Choose --</option>
        ${motionOptions}
      </select>
    </div>

    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #e0e0e0; margin-bottom:16px;">
      <h3 style="margin-top:0; color:${brand.navy};">Client</h3>
      <p style="font-size:11px; color:#888; margin:0 0 10px 0;">Type either the client's name OR A-number — Zara will look up their court/judge info from prior hearings.</p>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div style="position:relative;">
          <label style="display:block; font-size:12px; color:#666;">Client name *</label>
          <input type="text" name="client_name" required autocomplete="off" value="${escapeHtml(prefill.client_name || "")}" oninput="lookupClient(this.value, 'name')" onblur="setTimeout(()=>{ document.getElementById('client-suggestions').style.display='none'; }, 200)" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
        </div>
        <div>
          <label style="display:block; font-size:12px; color:#666;">A-number</label>
          <input type="text" name="a_number" autocomplete="off" value="${escapeHtml(prefill.a_number || "")}" oninput="lookupClient(this.value, 'anum')" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
        </div>
      </div>
      <div id="client-suggestions" style="display:none; margin-top:8px; background:#f8f8f8; border:1px solid #ddd; border-radius:4px; padding:6px; max-height:280px; overflow-y:auto;"></div>
      <div id="lookup-status" style="font-size:11px; color:${brand.gold}; margin-top:6px; display:none;"></div>
      ${prefill.hearing_note_id ? `<input type="hidden" name="hearing_note_id" value="${prefill.hearing_note_id}"><div style="font-size:11px; color:${brand.gold}; margin-top:8px;">✓ Linked to hearing note #${prefill.hearing_note_id}</div>` : ""}
    </div>

    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #e0e0e0; margin-bottom:16px;">
      <h3 style="margin-top:0; color:${brand.navy};">Court info</h3>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div>
          <label style="display:block; font-size:12px; color:#666;">Court name</label>
          <input type="text" name="court_name" value="${escapeHtml(prefill.court_name || "")}" placeholder="e.g. Los Angeles Immigration Court" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
        </div>
        <div>
          <label style="display:block; font-size:12px; color:#666;">Judge</label>
          <input type="text" name="judge_name" value="${escapeHtml(prefill.judge_name || "")}" placeholder="e.g. Hon. Kevin Riley" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
        </div>
        <div>
          <label style="display:block; font-size:12px; color:#666;">Filing deadline</label>
          <input type="date" name="filing_deadline" value="${prefill.filing_deadline || ""}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box;">
          <div style="font-size:10px; color:#888; margin-top:2px;">Optional — leave blank if unknown</div>
        </div>
      </div>
    </div>

    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #e0e0e0; margin-bottom:16px;">
      <h3 style="margin-top:0; color:${brand.navy};">Grounds for motion *</h3>
      <p style="font-size:12px; color:#666; margin-bottom:8px;">Explain WHY this motion should be granted. Be specific — Claude will apply legal standards to these facts.</p>
      <textarea name="grounds" required rows="6" placeholder="e.g. Respondent needs additional time to gather country conditions evidence and locate expert witness on gang violence in El Salvador. Prior counsel had not requested this evidence. Client is diligently working with new counsel and expert has confirmed availability in 60 days." style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-family:inherit; font-size:13px;"></textarea>
    </div>

    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #e0e0e0; margin-bottom:16px;">
      <h3 style="margin-top:0; color:${brand.navy};">Additional facts (optional)</h3>
      <p style="font-size:12px; color:#666; margin-bottom:8px;">Anything else Claude should know — client's specific situation, prior counsel history, procedural quirks, etc.</p>
      <textarea name="additional_facts" rows="4" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-family:inherit; font-size:13px;"></textarea>
    </div>

    <div style="display:flex; gap:8px;">
      <a href="/admin/motions" style="flex:1; padding:12px; background:#eee; color:#333; text-align:center; border:none; border-radius:4px; text-decoration:none; font-weight:600;">Cancel</a>
      <button type="submit" id="generate-btn" style="flex:2; padding:12px; background:${brand.navy}; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600; font-size:14px;">🤖 Generate motion with Claude</button>
    </div>
  </form>

  <div id="generating-overlay" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:10000; align-items:center; justify-content:center;">
    <div style="background:white; padding:30px; border-radius:10px; text-align:center; max-width:400px;">
      <div style="font-size:40px; margin-bottom:12px;">🧠</div>
      <div style="font-size:16px; font-weight:600; color:${brand.navy}; margin-bottom:8px;">Claude is drafting your motion…</div>
      <div id="gen-progress" style="font-size:12px; color:#666;">Analyzing case history…</div>
      <div style="background:#eee; height:5px; border-radius:3px; margin-top:16px; overflow:hidden;">
        <div id="gen-bar" style="background:linear-gradient(to right, ${brand.gold}, #d4b979); height:100%; width:10%; transition:width 0.5s;"></div>
      </div>
      <div style="font-size:11px; color:#888; margin-top:14px;">Usually takes 15-45 seconds.</div>
    </div>
  </div>

  <script>
    // ── Client autocomplete lookup ─────────────────────────
    let lookupTimeout = null;
    async function lookupClient(query, sourceField) {
      if (lookupTimeout) clearTimeout(lookupTimeout);
      const suggestionsEl = document.getElementById("client-suggestions");
      const trimmed = String(query || "").trim();
      if (trimmed.length < 2) {
        suggestionsEl.style.display = "none";
        return;
      }
      // Debounce: wait 350ms after typing stops
      lookupTimeout = setTimeout(async () => {
        try {
          const r = await fetch("/admin/motions/lookup-client?q=" + encodeURIComponent(trimmed));
          const d = await r.json();
          if (!d.ok || !d.matches || d.matches.length === 0) {
            suggestionsEl.style.display = "none";
            return;
          }
          renderSuggestions(d.matches);
        } catch (e) { console.warn("Lookup error:", e); }
      }, 350);
    }

    function renderSuggestions(matches) {
      const suggestionsEl = document.getElementById("client-suggestions");
      let html = '<div style="font-size:11px; color:#666; margin-bottom:6px;">💡 Found ' + matches.length + ' client' + (matches.length > 1 ? 's' : '') + ' — click to auto-fill court/judge:</div>';
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const escStr = (s) => String(s || "").replace(/'/g, "\\\\'").replace(/&/g, "&amp;").replace(/</g, "&lt;");
        html += '<div onclick="selectClient(' + i + ')" style="padding:8px 10px; margin-bottom:4px; background:white; border:1px solid #ddd; border-radius:4px; cursor:pointer; font-size:12px;" onmouseover="this.style.background=\\'#fffbe6\\'" onmouseout="this.style.background=\\'white\\'">';
        html +=   '<div style="font-weight:600; color:#0C1C36;">' + escStr(m.client_name || "(no name)") + (m.a_number ? ' <span style="color:#888; font-size:11px;">' + escStr(m.a_number) + '</span>' : '') + '</div>';
        if (m.court_name) html += '<div style="color:#666; margin-top:2px;">📍 ' + escStr(m.court_name) + '</div>';
        if (m.judge_name) html += '<div style="color:#666;">⚖️ ' + escStr(m.judge_name) + '</div>';
        if (m.last_hearing_date) {
          const dt = new Date(m.last_hearing_date).toLocaleDateString();
          html += '<div style="color:#888; font-size:10px; margin-top:2px;">Last hearing: ' + dt + ' (' + escStr(m.last_hearing_type || "hearing") + ')</div>';
        }
        html += '</div>';
      }
      suggestionsEl.innerHTML = html;
      suggestionsEl.style.display = "block";
      window._clientMatches = matches;
    }

    function selectClient(idx) {
      const m = window._clientMatches[idx];
      if (!m) return;
      // Fill any fields that are empty (don't overwrite what user typed)
      const setIfEmpty = (name, value) => {
        if (!value) return;
        const el = document.querySelector('[name="' + name + '"]');
        if (el && !el.value.trim()) el.value = value;
      };
      // Client fields — force-overwrite these since user is selecting a client
      const cnEl = document.querySelector('[name="client_name"]');
      const anEl = document.querySelector('[name="a_number"]');
      if (cnEl && m.client_name) cnEl.value = m.client_name;
      if (anEl && m.a_number) anEl.value = m.a_number;
      setIfEmpty("court_name", m.court_name);
      setIfEmpty("judge_name", m.judge_name);
      document.getElementById("client-suggestions").style.display = "none";
      const status = document.getElementById("lookup-status");
      status.textContent = "✓ Filled court/judge info for " + m.client_name;
      status.style.display = "block";
      setTimeout(() => { status.style.display = "none"; }, 4000);
    }
    // ── End client lookup ─────────────────────────

    async function submitNewMotion(e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {};
      for (const [k, v] of fd.entries()) body[k] = v;
      document.getElementById("generating-overlay").style.display = "flex";
      document.getElementById("generate-btn").disabled = true;
      const bar = document.getElementById("gen-bar");
      const progText = document.getElementById("gen-progress");
      setTimeout(() => { bar.style.width = "30%"; progText.textContent = "Pulling prior hearing notes…"; }, 2000);
      setTimeout(() => { bar.style.width = "55%"; progText.textContent = "Claude drafting sections…"; }, 6000);
      setTimeout(() => { bar.style.width = "80%"; progText.textContent = "Finalizing citations…"; }, 15000);
      try {
        const r = await fetch("/admin/motions/generate", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
        const txt = await r.text();
        let d; try { d = JSON.parse(txt); } catch { throw new Error("Non-JSON response: " + txt.substring(0, 300)); }
        if (!d.ok) throw new Error(d.error || "unknown error");
        bar.style.width = "100%";
        progText.textContent = "Done! Redirecting…";
        setTimeout(() => { location.href = "/admin/motions/" + d.motion_id; }, 500);
      } catch (err) {
        document.getElementById("generating-overlay").style.display = "none";
        document.getElementById("generate-btn").disabled = false;
        alert("Failed to generate motion: " + err.message);
      }
    }
  </script>`;
}

function renderMotionEditor(motion) {
  const cfg = MOTION_TYPES[motion.motion_type] || {};
  const escapedContent = escapeHtml(motion.content_markdown || "");
  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
    <div>
      <h1 style="margin:0;">${escapeHtml(cfg.label || motion.motion_type)} — ${escapeHtml(motion.client_name || "unnamed")}</h1>
      <div style="font-size:12px; color:#666; margin-top:4px;">
        ${motion.a_number ? "A#: " + escapeHtml(motion.a_number) + " · " : ""}${escapeHtml(motion.court_name || "")}${motion.judge_name ? " · " + escapeHtml(motion.judge_name) : ""} · Status: <b>${motion.status}</b>
      </div>
    </div>
    <div style="display:flex; gap:6px;">
      <a href="/admin/motions/${motion.id}/download" style="background:${brand.gold}; color:white; padding:9px 14px; border-radius:6px; text-decoration:none; font-weight:600; font-size:13px;">💾 Download .docx</a>
      <button onclick="uploadDropbox(${motion.id})" style="background:#0061FF; color:white; padding:9px 14px; border:none; border-radius:6px; cursor:pointer; font-weight:600; font-size:13px;">☁️ Upload to Dropbox</button>
      <a href="/admin/motions" class="back-link" style="padding:9px 14px;">← All motions</a>
    </div>
  </div>

  <div style="display:grid; grid-template-columns:2fr 1fr; gap:16px; margin-top:20px;">
    <div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #e0e0e0;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <h3 style="margin:0; color:${brand.navy};">Motion draft (markdown)</h3>
          <button onclick="saveContent()" style="background:${brand.navy}; color:white; padding:6px 12px; border:none; border-radius:4px; cursor:pointer; font-size:12px;">💾 Save</button>
        </div>
        <textarea id="motion-content" style="width:100%; min-height:600px; padding:16px; border:1px solid #ccc; border-radius:4px; box-sizing:border-box; font-family:'Courier New', monospace; font-size:13px; line-height:1.6;">${escapedContent}</textarea>
        <div style="font-size:11px; color:#888; margin-top:6px;">Use ## for section headers, **bold** for emphasis, *italic* for case names.</div>
      </div>
    </div>

    <div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #e0e0e0; margin-bottom:12px;">
        <h3 style="margin-top:0; color:${brand.navy};">Status</h3>
        <select id="status-select" onchange="updateStatus(this.value)" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
          <option value="draft" ${motion.status === "draft" ? "selected" : ""}>📝 Draft</option>
          <option value="reviewed" ${motion.status === "reviewed" ? "selected" : ""}>✅ Reviewed</option>
          <option value="filed" ${motion.status === "filed" ? "selected" : ""}>📤 Filed</option>
        </select>
      </div>

      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #e0e0e0; margin-bottom:12px;">
        <h3 style="margin-top:0; color:${brand.navy};">Metadata</h3>
        <div style="font-size:12px; color:#666; line-height:1.6;">
          <div><b>Type:</b> ${escapeHtml(cfg.label || motion.motion_type)}</div>
          <div><b>Citation:</b> ${escapeHtml(cfg.citation || "-")}</div>
          <div><b>Created:</b> ${new Date(motion.created_at).toLocaleString()}</div>
          ${motion.filing_deadline ? `<div><b>Filing deadline:</b> ${new Date(motion.filing_deadline).toLocaleDateString()}</div>` : ""}
          ${motion.dropbox_path ? `<div style="margin-top:6px;"><b>Dropbox:</b> <code style="font-size:11px; word-break:break-all;">${escapeHtml(motion.dropbox_path)}</code></div>` : ""}
          ${motion.filed_at ? `<div style="color:#2e7d32; margin-top:6px;"><b>✅ Filed:</b> ${new Date(motion.filed_at).toLocaleString()}</div>` : ""}
        </div>
      </div>

      <div style="background:#f8f8f8; padding:12px; border-radius:6px; border:1px solid #e0e0e0;">
        <div style="font-size:11px; color:#666; margin-bottom:6px;">⚠️ Legal review required</div>
        <div style="font-size:11px; color:#666;">Claude drafts are FIRST DRAFTS. Attorney must review every citation, fact, and application of law before filing. Verify all bracketed placeholders are filled.</div>
      </div>

      <div style="background:#fff8e1; padding:10px 12px; border-radius:6px; border:1px solid #ffe082; margin-top:10px; font-size:11px; color:#555;">
        <div style="font-weight:600; color:${brand.navy}; margin-bottom:4px;">📋 Pleading paper</div>
        Downloaded .docx will use your uploaded template if one exists. <a href="/admin/motions/templates" style="color:${brand.gold};">Manage templates →</a>
      </div>

      <button onclick="deleteMotion(${motion.id})" style="width:100%; margin-top:12px; padding:10px; background:#fee; color:#c00; border:1px solid #ffe0e0; border-radius:4px; cursor:pointer; font-size:12px;">🗑 Delete this motion</button>
    </div>
  </div>

  <script>
    async function saveContent() {
      const content = document.getElementById("motion-content").value;
      try {
        const r = await fetch("/admin/motions/${motion.id}", { method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({content_markdown: content}) });
        const d = await r.json();
        if (d.ok) {
          const toast = document.createElement("div");
          toast.style.cssText = "position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#2e7d32; color:white; padding:12px 20px; border-radius:6px; z-index:10001; font-size:14px;";
          toast.textContent = "✅ Saved";
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 2000);
        } else alert("Save failed: " + (d.error || "unknown"));
      } catch (e) { alert("Save failed: " + e.message); }
    }
    async function updateStatus(status) {
      const body = { status };
      if (status === "filed") body.filed_at = new Date().toISOString();
      try {
        const r = await fetch("/admin/motions/${motion.id}", { method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body) });
        const d = await r.json();
        if (d.ok && status === "filed") setTimeout(() => location.reload(), 500);
      } catch (e) { alert("Failed: " + e.message); }
    }
    async function uploadDropbox(id) {
      if (!confirm("Upload this motion (.docx) to Dropbox? It will go to the client's folder if found, otherwise to /USCIS/_MOTIONS/.")) return;
      try {
        const r = await fetch("/admin/motions/" + id + "/upload-dropbox", { method: "POST" });
        const d = await r.json();
        if (d.ok) { alert("Uploaded to " + d.path); location.reload(); }
        else alert("Upload failed: " + d.error);
      } catch (e) { alert("Upload failed: " + e.message); }
    }
    async function deleteMotion(id) {
      if (!confirm("Delete this motion permanently? This cannot be undone.")) return;
      try {
        const r = await fetch("/admin/motions/" + id, { method: "DELETE" });
        const d = await r.json();
        if (d.ok) location.href = "/admin/motions";
        else alert("Delete failed: " + d.error);
      } catch (e) { alert("Delete failed: " + e.message); }
    }
  </script>`;
}

module.exports = {
  init,
  MOTION_TYPES,
  generateMotion,
  createMotion,
  updateMotion,
  getMotion,
  listMotions,
  deleteMotion,
  generateDocx,
  generateDocxForMotion,
  uploadToDropbox,
  renderMotionListPage,
  renderNewMotionForm,
  renderMotionEditor,
};
