// ============================================================
//  TEZ LAW P.C. — INDIVIDUAL HEARING CLOSING ARGUMENT GENERATOR
//  ─────────────────────────────────────────────────────────
//  Purpose: Draft closing oral arguments for merits (individual)
//  hearings that follow the classic asylum framework:
//
//    1. REAL ID Act — credibility & corroboration standard
//    2. Credibility — respondent's testimony passes REAL ID
//    3. Past Persecution — including "single incident" doctrine
//    4. Well-Founded Fear — subjective + objective prongs
//    5. Level of Persecution — sufficient to support relief
//
//  ZERO-HALLUCINATION GUARANTEE:
//  The generator retrieves VERIFIED case law from Tez Law's own
//  firm document repository (firm_documents.authorities_cited)
//  and the vetted legal_citations table. Claude is instructed
//  to ONLY cite cases from that verified list — if it needs a
//  case not in the list, it says so explicitly rather than
//  inventing one.
// ============================================================

const axios = require("axios");
const db = require("./db");

// Model: Sonnet 4.6. This is high-stakes legal writing — the extra $$ vs Haiku
// is worth it for coherent multi-page arguments with proper citation weaving.
const MODEL = "claude-sonnet-4-6";

// ─── Schema ─────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS closing_arguments (
      id                 SERIAL PRIMARY KEY,
      individual_note_id INTEGER,
      client_name        TEXT,
      a_number           TEXT,
      argument_text      TEXT,
      cases_cited        TEXT[],
      generated_at       TIMESTAMPTZ DEFAULT NOW(),
      model              TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      estimated_cost_usd NUMERIC(10, 4),
      user_edits         TEXT,          -- attorney's edited final version
      created_by         INTEGER,       -- admin_users.id
      status             TEXT DEFAULT 'draft',  -- draft | finalized | delivered | superseded
      version            INTEGER DEFAULT 1,     -- 1, 2, 3… for this hearing
      parent_id          INTEGER,               -- id of previous version this was regenerated from
      additional_context TEXT,                  -- attorney's added context at generation time
      testimony_snapshot JSONB                  -- the examinations data used, for audit
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_closing_arg_note ON closing_arguments (individual_note_id)`);
  // Migrations
  const alters = [
    "ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1",
    "ADD COLUMN IF NOT EXISTS parent_id INTEGER",
    "ADD COLUMN IF NOT EXISTS additional_context TEXT",
    "ADD COLUMN IF NOT EXISTS testimony_snapshot JSONB",
  ];
  for (const alter of alters) {
    try { await db.query(`ALTER TABLE closing_arguments ${alter}`); } catch {}
  }
}

// ─── Verified case-law retrieval ────────────────────────

// Pulls asylum/immigration case law from the firm's GOAT/MOAT documents and
// vetted legal_citations. Returns a deduped list Claude can safely cite from.
async function retrieveVerifiedCaseLaw() {
  const cases = new Map();  // caseName → { name, cite, source, url }

  // 1. From firm_documents.authorities_cited — cases the firm has actually used
  try {
    const r = await db.query(
      `SELECT id, matter_label, authorities_cited, key_arguments
       FROM firm_documents
       WHERE (practice_area ILIKE '%asylum%'
              OR practice_area ILIKE '%immigration%'
              OR practice_area ILIKE '%removal%'
              OR document_type ILIKE '%brief%'
              OR document_type ILIKE '%motion%')
         AND authorities_cited IS NOT NULL
         AND array_length(authorities_cited, 1) > 0
       ORDER BY created_at DESC
       LIMIT 100`
    );
    for (const row of r.rows) {
      for (const auth of row.authorities_cited || []) {
        const clean = String(auth).trim();
        if (!clean || clean.length < 5) continue;
        if (!cases.has(clean.toLowerCase())) {
          cases.set(clean.toLowerCase(), {
            citation: clean,
            source: `firm brief: ${row.matter_label || "unlabeled"}`,
            source_id: row.id,
          });
        }
      }
    }
  } catch (e) { console.warn("[closing-arg] firm_documents fetch:", e.message); }

  // 2. From legal_citations — vetted individual cases (relevance_score > 0)
  try {
    const r = await db.query(
      `SELECT case_name, citation, court, date_filed, url, category, relevance_score
       FROM legal_citations
       WHERE (category ILIKE '%asylum%'
              OR category ILIKE '%immigration%'
              OR category ILIKE '%persecution%'
              OR category ILIKE '%credibility%'
              OR case_name ILIKE '%asylum%'
              OR case_name ILIKE '%persecution%')
         AND relevance_score >= 0
       ORDER BY relevance_score DESC, date_filed DESC
       LIMIT 60`
    );
    for (const row of r.rows) {
      const key = row.case_name.toLowerCase();
      if (!cases.has(key)) {
        cases.set(key, {
          case_name: row.case_name,
          citation: row.citation,
          court: row.court,
          date: row.date_filed,
          url: row.url,
          category: row.category,
          source: "legal_citations table",
        });
      }
    }
  } catch (e) { console.warn("[closing-arg] legal_citations fetch:", e.message); }

  return Array.from(cases.values());
}

// ─── Case facts retrieval ───────────────────────────────
//
// Reads from the ACTUAL individual_hearing_notes schema:
//   - pre_examination_notes: attorney's outline and prep notes
//   - examinations JSONB: witness Q&A with actual responses recorded in judge_notes
//   - evidence_objections, disposition_notes: hearing-time observations
//   - hearing_summary_raw, paralegal_summary: post-hearing summaries
//   - exhibits JSONB: exhibit list

async function getHearingContext(individualNoteId) {
  const r = await db.query(
    `SELECT id, client_name, a_number, client_language,
            hearing_date, next_hearing_date,
            case_type, court_location, court_address,
            judge_name, dhs_attorney,
            attorney_appearance, respondent_appearance,
            exhibits, evidence_objections,
            pre_examination_notes, examinations,
            closing_argument, disposition, disposition_notes,
            hearing_summary_raw, paralegal_summary, client_summary
     FROM individual_hearing_notes WHERE id = $1`,
    [individualNoteId]
  );
  return r.rows[0] || null;
}

// Formats the JSONB examinations array into a rich, structured testimony
// block for Claude. Prioritizes ACTUAL testimony given (judge_notes column
// on each Q&A row), which the attorney fills in DURING the hearing.
// Also includes expected answers (from prep) as fallback context.
function formatExaminations(examinations) {
  if (!Array.isArray(examinations) || examinations.length === 0) {
    return "(No witness examinations recorded)";
  }
  const parts = [];
  for (const ex of examinations) {
    const role = ex.witness_role || "Witness";
    const name = ex.witness_name || "";
    const type = ex.examination_type || "examination";
    const header = name ? `${role} (${name}) — ${type}` : `${role} — ${type}`;
    parts.push(`\n#### ${header}`);

    const sections = Array.isArray(ex.sections) ? ex.sections : [];
    for (const sec of sections) {
      const rows = Array.isArray(sec.qa_rows) ? sec.qa_rows : [];
      // Only include rows with an actual response (judge_notes) OR an expected
      // answer — skip empty rows so the prompt stays focused.
      const meaningful = rows.filter(r =>
        (r.judge_notes && r.judge_notes.trim()) ||
        (r.expected_answer && r.expected_answer.trim())
      );
      if (!meaningful.length) continue;

      parts.push(`\n**${sec.title || "Testimony"}**`);
      for (const row of meaningful) {
        const q = (row.question || "").trim();
        const actualAnswer = (row.judge_notes || "").trim();
        const expectedAnswer = (row.expected_answer || "").trim();
        if (q) parts.push(`Q: ${q}`);
        // Actual testimony given (from attorney's notes during hearing) takes priority
        if (actualAnswer) {
          parts.push(`A [as testified]: ${actualAnswer}`);
        } else if (expectedAnswer) {
          parts.push(`A [prep note, not yet given at hearing]: ${expectedAnswer}`);
        }
      }
    }
  }
  return parts.join("\n");
}

function formatExhibits(exhibits) {
  if (!Array.isArray(exhibits) || exhibits.length === 0) return "";
  return exhibits
    .filter(e => e && (e.label || e.description || e.title))
    .map((e, i) => {
      const label = e.label || e.title || `Exhibit ${i + 1}`;
      const desc = e.description || e.summary || "";
      return desc ? `- ${label}: ${desc}` : `- ${label}`;
    })
    .join("\n");
}

// ─── Main generator ─────────────────────────────────────

async function generateClosingArgument({ individualNoteId, additionalContext = "", createdBy = null, parentId = null }) {
  await initTable();
  const note = await getHearingContext(individualNoteId);
  if (!note) throw new Error(`Individual hearing note #${individualNoteId} not found.`);

  const verifiedCases = await retrieveVerifiedCaseLaw();
  if (verifiedCases.length < 5) {
    throw new Error(
      `Only ${verifiedCases.length} verified case citations found in your firm's GOAT/MOAT + legal_citations. ` +
      `You need at least 5 asylum-related cases before generating closing arguments to avoid hallucinated cites. ` +
      `Add more asylum briefs to your firm documents at /admin/firm-documents, or seed the citations database.`
    );
  }

  // Build the "case law you may cite" section
  const citesBlock = verifiedCases
    .slice(0, 40)  // Cap to keep prompt focused
    .map((c, i) => {
      const cite = c.case_name && c.citation
        ? `${c.case_name}, ${c.citation}`
        : (c.citation || c.case_name || "unknown");
      return `${i + 1}. ${cite}${c.court ? " (" + c.court + ")" : ""}${c.category ? " [" + c.category + "]" : ""}`;
    })
    .join("\n");

  // Format the witness testimony (Q&A from all examinations) into a rich block
  const testimonyBlock = formatExaminations(note.examinations);
  const exhibitsBlock = formatExhibits(note.exhibits);

  // Determine the version number for this new closing
  let version = 1;
  if (parentId) {
    const p = await db.query(`SELECT version FROM closing_arguments WHERE id = $1`, [parentId]);
    if (p.rows[0]) version = (p.rows[0].version || 0) + 1;
  } else {
    const p = await db.query(
      `SELECT COALESCE(MAX(version), 0) as max_v FROM closing_arguments WHERE individual_note_id = $1`,
      [individualNoteId]
    );
    version = (p.rows[0]?.max_v || 0) + 1;
  }

  // Build the client facts context — REAL columns only
  const facts = [
    note.client_name ? `Respondent: ${note.client_name}` : null,
    note.a_number ? `A-Number: ${note.a_number}` : null,
    note.case_type ? `Relief Sought / Case Type: ${note.case_type}` : null,
    note.court_location ? `Court: ${note.court_location}` : null,
    note.judge_name ? `Immigration Judge: ${note.judge_name}` : null,
    note.dhs_attorney ? `DHS Trial Attorney: ${note.dhs_attorney}` : null,
    note.hearing_date ? `Hearing Date: ${new Date(note.hearing_date).toLocaleDateString()}` : null,

    note.pre_examination_notes ? `\n### ATTORNEY'S PRE-HEARING NOTES / OUTLINE\n${note.pre_examination_notes}` : null,

    `\n### WITNESS TESTIMONY (Q&A recorded during examination)\n${testimonyBlock}`,

    exhibitsBlock ? `\n### EXHIBITS\n${exhibitsBlock}` : null,
    note.evidence_objections ? `\n### EVIDENCE / OBJECTIONS\n${note.evidence_objections}` : null,

    note.hearing_summary_raw ? `\n### RAW HEARING NOTES\n${note.hearing_summary_raw}` : null,
    note.paralegal_summary ? `\n### PARALEGAL SUMMARY\n${note.paralegal_summary}` : null,
    note.disposition_notes ? `\n### DISPOSITION NOTES\n${note.disposition_notes}` : null,

    additionalContext ? `\n### ADDITIONAL CONTEXT / DIRECTION FROM ATTORNEY\n${additionalContext}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `You are drafting a CLOSING ORAL ARGUMENT for an immigration merits hearing at EOIR on behalf of the respondent seeking asylum, withholding of removal, and/or CAT protection.

# CRITICAL CONSTRAINTS

**ZERO HALLUCINATION RULE**: You may ONLY cite cases from the "VERIFIED CASE LAW" list below. If you need to make a point that requires a case NOT on the list, write [CITATION NEEDED — <describe what you need>] in the argument. DO NOT invent case names, invent citations, or paraphrase from memory. Every case cite in the output must appear verbatim in the verified list.

**GROUND EVERY ARGUMENT IN THE ACTUAL TESTIMONY**: The WITNESS TESTIMONY section below contains the actual Q&A from the merits hearing. Every factual claim in your closing MUST be supported by specific testimony. When you argue past persecution, quote or paraphrase the respondent's actual testimony describing what happened. When you argue subjective fear, cite testimony where they expressed that fear. When you argue credibility, point to specific consistent details from the record. Do NOT invent facts.

**USE ATTORNEY'S NOTES**: The ATTORNEY'S PRE-HEARING NOTES and any ADDITIONAL CONTEXT contain the attorney's theory of the case and strategic points to emphasize. Weave these into the argument.

# STRUCTURE (all five sections required, in this order)

1. **REAL ID Act Framework** — INA § 208(b)(1)(B), burden of proof, corroboration standard, credibility standard
2. **Credibility of the Respondent** — analyze specific consistent details from the testimony; passes REAL ID credibility factors (demeanor, candor, responsiveness, plausibility, consistency, corroboration). Cite specific testimony.
3. **Past Persecution** — connect the actual harm described in testimony to the persecution standard; explicitly argue that even a SINGLE INCIDENT can suffice for past persecution if severe enough; cite verified cases and quote or reference the specific testimony
4. **Well-Founded Fear of Future Persecution** — apply the two-prong test:
   (a) SUBJECTIVE PRONG: respondent's own testimony expressing genuine fear (quote/reference)
   (b) OBJECTIVE PRONG: fear is objectively reasonable (INS v. Cardoza-Fonseca 10% standard); explicitly argue that even a moderate LEVEL OF PERSECUTION is a sufficient basis; support with country conditions from testimony/exhibits
5. **Conclusion** — the respondent has met their burden; request the court grant asylum (withholding + CAT as alternatives)

# VERIFIED CASE LAW (you may cite ONLY these)

${citesBlock}

# CLIENT'S CASE FACTS AND HEARING RECORD

${facts}

# WRITING STYLE

- Write in the voice of the respondent's attorney speaking to the Immigration Judge in open court
- First-person plural where natural ("we submit", "our client has shown")
- Formal but human — this is a spoken closing, not a brief
- ~1500-2500 words total
- Use inline citations formatted like: (Matter of Mogharrabi, 19 I&N Dec. 439 (BIA 1987))
- **Weave the actual testimony into your legal arguments** — every legal point should reference specific testimony that supports it. Use phrases like "as the respondent testified…", "the record shows…", "when asked about X, our client stated…"
- Where the record supports it, briefly quote or closely paraphrase the respondent's testimony
- Address weaknesses proactively (e.g., minor inconsistencies → explain via trauma/translation, referencing specific testimony)
- If the testimony record is thin on any element, note honestly in the argument rather than fabricating

# BEGIN CLOSING ARGUMENT

Output only the closing argument text, ready to be read aloud. Start with "Your Honor," and end with a clear ask.`;

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: MODEL,
      max_tokens: 4000,
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

  const argument = resp.data.content?.[0]?.text || "";
  const usage = resp.data.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  // Sonnet 4.6 pricing: $3/MTok input, $15/MTok output
  const costUsd = +((inputTokens * 3 + outputTokens * 15) / 1_000_000).toFixed(4);

  // Extract which cases were actually cited by matching against the verified list
  const citedCases = [];
  for (const c of verifiedCases) {
    const label = c.case_name || c.citation;
    if (label && argument.toLowerCase().includes(label.toLowerCase())) {
      citedCases.push(c.case_name || c.citation);
    }
  }

  // Save to DB — includes version + parent_id + testimony snapshot for audit
  const inserted = await db.query(
    `INSERT INTO closing_arguments
       (individual_note_id, client_name, a_number, argument_text, cases_cited,
        model, input_tokens, output_tokens, estimated_cost_usd, created_by, status,
        version, parent_id, additional_context, testimony_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $12, $13, $14::jsonb)
     RETURNING id`,
    [
      individualNoteId, note.client_name, note.a_number, argument, citedCases,
      MODEL, inputTokens, outputTokens, costUsd, createdBy,
      version, parentId, additionalContext || null,
      JSON.stringify(note.examinations || []),
    ]
  );

  // Log to universal audit trail for malpractice / bar-complaint defense
  try {
    const audit = require("./ai-audit-trail");
    await audit.log({
      feature_type: "closing_argument",
      source_module: "closing-argument-generator.js",
      related_table: "closing_arguments",
      related_id: inserted.rows[0].id,
      client_key: null,       // individual_hearing_notes doesn't have a stable client_key
      client_name: note.client_name,
      a_number: note.a_number,
      matter_type: "asylum",
      original_output: argument,
      input_context_summary: `Closing arg v${version} for hearing #${individualNoteId}. ${(note.examinations || []).length} witnesses, ${verifiedCases.length} verified cases in pool. Attorney context: ${additionalContext ? additionalContext.substring(0, 200) : "(none)"}`,
      input_context_full: prompt,
      model_used: MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: costUsd,
      generated_by: createdBy,
    });
  } catch (e) { console.warn("[audit-trail] closing-arg log failed:", e.message); }

  return {
    id: inserted.rows[0].id,
    argument,
    cases_cited: citedCases,
    verified_pool_size: verifiedCases.length,
    version,
    parent_id: parentId,
    testimony_witnesses: (note.examinations || []).length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: costUsd,
  };
}

// ─── Retrieval / listing ────────────────────────────────

async function getClosingArgument(id) {
  await initTable();
  const r = await db.query(`SELECT * FROM closing_arguments WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function listForNote(individualNoteId) {
  await initTable();
  const r = await db.query(
    `SELECT id, argument_text, cases_cited, generated_at, model, status,
            estimated_cost_usd, version, parent_id, additional_context,
            jsonb_array_length(COALESCE(testimony_snapshot, '[]'::jsonb)) as testimony_witness_count
     FROM closing_arguments
     WHERE individual_note_id = $1
     ORDER BY version DESC, generated_at DESC`,
    [individualNoteId]
  );
  return r.rows;
}

async function updateClosingArgument(id, { user_edits, status }) {
  await initTable();
  const sets = [];
  const values = [];
  let i = 1;
  if (user_edits !== undefined) { sets.push(`user_edits = $${i++}`); values.push(user_edits); }
  if (status !== undefined) { sets.push(`status = $${i++}`); values.push(status); }
  if (!sets.length) return null;
  values.push(id);
  const r = await db.query(
    `UPDATE closing_arguments SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return r.rows[0] || null;
}

module.exports = {
  initTable,
  retrieveVerifiedCaseLaw,
  generateClosingArgument,
  getClosingArgument,
  listForNote,
  updateClosingArgument,
};
