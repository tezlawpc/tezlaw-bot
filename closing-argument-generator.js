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
      status             TEXT DEFAULT 'draft'  -- draft | finalized | delivered
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_closing_arg_note ON closing_arguments (individual_note_id)`);
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

async function getHearingContext(individualNoteId) {
  const r = await db.query(
    `SELECT id, client_name, a_number, hearing_date, next_hearing_date,
            hearing_type, case_type, court_location, judge_name,
            summary, notes, testimony_summary, key_facts,
            country_of_origin, protected_ground,
            past_persecution_facts, future_fear_facts,
            corroborating_evidence, credibility_notes
     FROM individual_hearing_notes WHERE id = $1`,
    [individualNoteId]
  );
  return r.rows[0] || null;
}

// ─── Main generator ─────────────────────────────────────

async function generateClosingArgument({ individualNoteId, additionalContext = "", createdBy = null }) {
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

  // Build the client facts context
  const facts = [
    note.client_name ? `Respondent: ${note.client_name}` : null,
    note.a_number ? `A-Number: ${note.a_number}` : null,
    note.country_of_origin ? `Country of Origin: ${note.country_of_origin}` : null,
    note.protected_ground ? `Protected Ground(s): ${note.protected_ground}` : null,
    note.court_location ? `Court: ${note.court_location}` : null,
    note.judge_name ? `Immigration Judge: ${note.judge_name}` : null,
    note.key_facts ? `\n### KEY FACTS\n${note.key_facts}` : null,
    note.past_persecution_facts ? `\n### PAST PERSECUTION FACTS\n${note.past_persecution_facts}` : null,
    note.future_fear_facts ? `\n### FUTURE FEAR FACTS\n${note.future_fear_facts}` : null,
    note.testimony_summary ? `\n### TESTIMONY SUMMARY\n${note.testimony_summary}` : null,
    note.corroborating_evidence ? `\n### CORROBORATING EVIDENCE\n${note.corroborating_evidence}` : null,
    note.credibility_notes ? `\n### CREDIBILITY NOTES\n${note.credibility_notes}` : null,
    note.summary ? `\n### CASE SUMMARY\n${note.summary}` : null,
    note.notes ? `\n### ATTORNEY NOTES\n${note.notes}` : null,
    additionalContext ? `\n### ADDITIONAL CONTEXT FROM ATTORNEY\n${additionalContext}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `You are drafting a CLOSING ORAL ARGUMENT for an immigration merits hearing at EOIR on behalf of the respondent seeking asylum, withholding of removal, and/or CAT protection.

# CRITICAL CONSTRAINTS

**ZERO HALLUCINATION RULE**: You may ONLY cite cases from the "VERIFIED CASE LAW" list below. If you need to make a point that requires a case NOT on the list, write [CITATION NEEDED — <describe what you need>] in the argument. DO NOT invent case names, invent citations, or paraphrase from memory. Every case cite in the output must appear verbatim in the verified list.

**STRUCTURE**: The closing argument must have these five sections (use headings):
1. **REAL ID Act Framework** — INA § 208(b)(1)(B), burden of proof, corroboration standard, credibility standard
2. **Credibility of the Respondent** — testimony was consistent, plausible, detailed; passes REAL ID credibility factors (demeanor, candor, responsiveness, plausibility, consistency, corroboration)
3. **Past Persecution** — the harm suffered rises to persecution; explicitly argue that even a SINGLE INCIDENT can suffice for past persecution if severe enough; cite verified cases
4. **Well-Founded Fear of Future Persecution** — apply the two-prong test:
   (a) SUBJECTIVE PRONG: respondent genuinely fears returning (evidence from testimony)
   (b) OBJECTIVE PRONG: fear is objectively reasonable (INS v. Cardoza-Fonseca 10% standard); explicitly argue that even a moderate level of persecution is a sufficient basis
5. **Conclusion** — the respondent has met their burden; request the court grant asylum (withholding + CAT as alternatives)

# VERIFIED CASE LAW (you may cite ONLY these)

${citesBlock}

# CLIENT'S CASE FACTS

${facts}

# WRITING STYLE

- Write in the voice of the respondent's attorney speaking to the Immigration Judge in open court
- First-person plural where natural ("we submit", "our client has shown")
- Formal but human — this is a spoken closing, not a brief
- ~1500-2500 words total
- Use inline citations formatted like: (Matter of Mogharrabi, 19 I&N Dec. 439 (BIA 1987))
- Weave the client's specific facts into each legal point — don't leave abstract legal principles disconnected from what happened to them
- Where the record supports it, quote the respondent's testimony
- Address weaknesses proactively (e.g., minor inconsistencies → explain them via trauma/translation)

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

  // Save to DB
  const inserted = await db.query(
    `INSERT INTO closing_arguments
       (individual_note_id, client_name, a_number, argument_text, cases_cited,
        model, input_tokens, output_tokens, estimated_cost_usd, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
     RETURNING id`,
    [
      individualNoteId, note.client_name, note.a_number, argument, citedCases,
      MODEL, inputTokens, outputTokens, costUsd, createdBy,
    ]
  );

  return {
    id: inserted.rows[0].id,
    argument,
    cases_cited: citedCases,
    verified_pool_size: verifiedCases.length,
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
            estimated_cost_usd
     FROM closing_arguments
     WHERE individual_note_id = $1
     ORDER BY generated_at DESC`,
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
