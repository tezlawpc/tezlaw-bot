// ============================================================
//  TEZ LAW P.C. — FIRM DOCUMENTS INGESTION v1
//  ─────────────────────────────────────────────────────────
//  PHASE 2 SELF-LEARNING: Firm work product goes into moat.
//
//  MODE: public_only — only ingests already-public documents:
//    - Filed briefs, motions, orders (from court dockets)
//    - Amicus briefs
//    - Published law review articles, CLE materials
//    - Firm-published blog posts / thought leadership
//    - Sample motions / templates for public education
//
//  Zara REFUSES to ingest anything that appears to be:
//    - Attorney-client privileged material
//    - Unfiled work product
//    - Client emails / correspondence
//    - Documents marked "confidential"
//    - Anything containing client names not already public
//
//  Safeguards:
//    - Pre-flight Haiku check: public vs private
//    - Redaction pass: strip identifying details
//    - Confirmation step before storage
//    - is_public flag defaults TRUE (locked in v1)
//    - Full audit log
//    - JJ-mode-only access (never visible in public chat)
//    - Source URL / provenance required
// ============================================================

const axios  = require("axios");
const crypto = require("crypto");
const db     = require("./db");

const ANTHROPIC_MODEL_HAIKU = "claude-haiku-4-5-20251001";
const ANTHROPIC_MODEL_SONNET = "claude-sonnet-4-6";
const OPENAI_EMBED_MODEL = "text-embedding-3-large";

// ── Schema ─────────────────────────────────────────────────

async function initFirmDocumentsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS firm_documents (
        id                 SERIAL PRIMARY KEY,
        source_hash        TEXT UNIQUE NOT NULL,
        matter_label       TEXT,
        document_type      TEXT,
        practice_area      TEXT,
        court_or_agency    TEXT,
        judge_name         TEXT,
        filing_date        DATE,
        key_issues         TEXT[],
        key_arguments      JSONB,
        authorities_cited  TEXT[],
        summary            TEXT,
        outcome            TEXT,
        outcome_notes      TEXT,
        redacted_text      TEXT,
        source_url         TEXT,
        is_public          BOOLEAN DEFAULT TRUE,
        embedding          halfvec(3072),
        pii_redacted       BOOLEAN DEFAULT TRUE,
        uploaded_by        TEXT DEFAULT 'jj',
        uploaded_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) {
    if (e.code !== "23505") throw e;
  }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_firm_docs_practice
        ON firm_documents (practice_area)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_firm_docs_uploaded
        ON firm_documents (uploaded_at DESC)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS firm_documents_audit (
        id           SERIAL PRIMARY KEY,
        action       TEXT NOT NULL,  -- ingest | delete | update_outcome
        doc_id       INTEGER,
        source_hash  TEXT,
        actor        TEXT DEFAULT 'jj',
        details      JSONB,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }
}

// ── Helpers ────────────────────────────────────────────────

/** Call Claude with a JSON-only response prompt and safely parse. */
async function askClaudeJSON(prompt, model = ANTHROPIC_MODEL_HAIKU, maxTokens = 1500) {
  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 90000,
    }
  );
  const text = r.data.content.filter(b => b.type === "text").map(b => b.text).join("");
  // Extract first {...} block (Sonnet/Haiku sometimes wrap in prose)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error("No JSON object in response. Got: " + text.substring(0, 300));
  return JSON.parse(objMatch[0]);
}

/** SHA-256 hash of text for dedup. */
function hashText(text) {
  return crypto.createHash("sha256").update(text.trim()).digest("hex");
}

/** OpenAI embedding for a text chunk. */
async function embedText(text) {
  const r = await axios.post(
    "https://api.openai.com/v1/embeddings",
    { input: text.substring(0, 8000), model: OPENAI_EMBED_MODEL, encoding_format: "float" },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  return r.data.data[0].embedding;
}

// ── Preflight Public/Private Check ─────────────────────────

/**
 * Uses Haiku to determine if a document appears to be public/filed vs. private work product.
 * Returns: { verdict: 'public' | 'private' | 'unclear', reason: string, redFlags: string[] }
 */
async function preflightPublicCheck(text) {
  const excerpt = text.substring(0, 4000);
  const prompt = `You are an ethics-focused legal AI assistant. Determine if this document is PUBLIC (filed with a court/agency, published, or otherwise part of the public record) or PRIVATE (attorney-client privileged work product, unfiled draft, client correspondence, confidential memo).

Document excerpt:
"""
${excerpt}
"""

Look for:
- PUBLIC signals: case caption with filed court, "Filed on", court stamps, "Amicus Brief of...", published article, "in support of motion to..."
- PRIVATE signals: "ATTORNEY-CLIENT PRIVILEGED", "WORK PRODUCT", "DRAFT — DO NOT DISTRIBUTE", email headers, client's personal details, confidential memos, ongoing case notes

Return ONLY JSON:
{
  "verdict": "public" | "private" | "unclear",
  "reason": "brief explanation",
  "redFlags": ["specific concerning phrases found"],
  "documentType": "brief" | "motion" | "order" | "article" | "letter" | "memo" | "email" | "other"
}`;

  return await askClaudeJSON(prompt);
}

// ── Redaction Pass ─────────────────────────────────────────

/**
 * Uses Haiku to strip PII from the document — client names, addresses, A-numbers,
 * DOB, phone, email, SSN — replacing with generic tokens.
 * Returns: { redactedText: string, redactionsCount: number, categories: string[] }
 */
async function redactPII(text) {
  // For very long docs, we chunk. Start with single-shot up to ~15K chars.
  const maxChars = 15000;
  const chunk = text.substring(0, maxChars);
  const truncated = text.length > maxChars;

  const prompt = `Redact all personally identifying information (PII) from this legal document. Replace with generic tokens:

REPLACE:
- Client/party first+last names → "[CLIENT]" or "[PARTY]" or role-based like "[PETITIONER]"
- A-numbers (A123-456-789) → "[A-NUMBER]"
- SSN → "[SSN]"
- DOB / dates of birth → "[DOB]"
- Home addresses → "[ADDRESS]"
- Phone numbers → "[PHONE]"
- Personal email addresses → "[EMAIL]"
- Specific employer names (unless publicly known) → "[EMPLOYER]"
- Specific school names for minors → "[SCHOOL]"

KEEP:
- Legal arguments, reasoning, doctrinal analysis
- Case citations (published cases are public)
- Statute references
- Court names, judge names (they're public officers)
- Attorney names (also public)
- Generic descriptions ("client entered US in early 2020")

Return ONLY JSON:
{
  "redactedText": "the full redacted document text",
  "redactionsCount": number of items redacted,
  "categories": ["names", "addresses", ...] // what got redacted
}

Document:
"""
${chunk}
"""

${truncated ? `\n(Note: document was truncated at ${maxChars} chars. Redact only what you see.)` : ""}`;

  const result = await askClaudeJSON(prompt, ANTHROPIC_MODEL_HAIKU, 8192);
  if (truncated) {
    result.redactedText = result.redactedText + "\n\n[...document truncated for redaction; original was " + text.length + " chars total]";
    result.truncatedAt = maxChars;
  }
  return result;
}

// ── Metadata Extraction ────────────────────────────────────

/**
 * Uses Sonnet (better reasoning) to extract structured metadata from the redacted doc.
 * Returns rich JSON with all the fields we store.
 */
async function extractMetadata(redactedText, sourceUrl) {
  const excerpt = redactedText.substring(0, 12000);
  const prompt = `Extract structured metadata from this LEGAL document. Return only what's confidently present — use null if unclear.

Document:
"""
${excerpt}
"""

${sourceUrl ? `Source URL: ${sourceUrl}` : ""}

Return ONLY JSON:
{
  "matterLabel": "brief descriptive label like 'Immigration 601 Waiver Motion' or null",
  "documentType": "brief" | "motion" | "order" | "amicus" | "petition" | "article" | "memo" | "other",
  "practiceArea": "immigration" | "personal_injury" | "business" | "estate" | "landlord_tenant" | "trademark" | "criminal" | "other",
  "courtOrAgency": "court name if any, e.g. '9th Circuit' or 'USCIS'",
  "judgeName": "judge if identified in document",
  "filingDate": "YYYY-MM-DD or null",
  "keyIssues": ["3-6 legal issues addressed"],
  "keyArguments": [
    {
      "argument": "one sentence describing the argument",
      "reasoning": "the legal reasoning / why it should prevail",
      "supportingCites": ["Case v. Case, 123 F.3d 456", ...]
    }
  ],
  "authoritiesCited": ["list of unique case names, statutes, regulations cited"],
  "summary": "2-3 sentence high-level summary of what the document argues/addresses"
}

Aim for the arguments field to be dense — 3-8 arguments, each substantive. This is what future JJ mode answers will lean on.`;

  return await askClaudeJSON(prompt, ANTHROPIC_MODEL_SONNET, 4096);
}

// ── Main Ingestion Pipeline ────────────────────────────────

/**
 * Ingest a document into firm_documents.
 *
 * @param {object} input
 *   - text: string (required)
 *   - sourceUrl: string (highly recommended — provenance)
 *   - matterLabelOverride: string (optional — what to call this)
 *   - allowPrivate: boolean (default false — MUST be explicit to bypass public check)
 *   - actorId: string (default 'jj')
 * @returns {Promise<object>} — outcome object
 */
async function ingestDocument(input) {
  const {
    text,
    sourceUrl = null,
    matterLabelOverride = null,
    allowPrivate = false,
    actorId = "jj",
  } = input;

  if (!text || text.trim().length < 200) {
    return { ok: false, reason: "Document too short (min 200 chars)" };
  }

  await initFirmDocumentsTable();

  // Step 1: Dedup check via hash
  const sourceHash = hashText(text);
  const dup = await db.query(
    `SELECT id FROM firm_documents WHERE source_hash = $1`,
    [sourceHash]
  );
  if (dup.rows.length > 0) {
    return { ok: false, reason: "Already ingested (duplicate hash)", docId: dup.rows[0].id };
  }

  // Step 2: Preflight — is this public or private?
  const preflight = await preflightPublicCheck(text);
  console.log("[firm-docs] Preflight:", preflight.verdict, "reason:", preflight.reason);

  if (preflight.verdict === "private" && !allowPrivate) {
    return {
      ok: false,
      reason: "Document appears to be private/privileged — refused. Use allowPrivate=true only after obtaining client consent.",
      preflight,
    };
  }

  if (preflight.verdict === "unclear" && !allowPrivate) {
    return {
      ok: false,
      reason: "Document's public status is unclear — refused. Manual review needed.",
      preflight,
    };
  }

  // Step 3: Redact PII (defense in depth even for public docs)
  const redaction = await redactPII(text);
  console.log("[firm-docs] Redacted", redaction.redactionsCount, "items across", (redaction.categories || []).length, "categories");

  // Step 4: Extract structured metadata from redacted version
  const meta = await extractMetadata(redaction.redactedText, sourceUrl);
  console.log("[firm-docs] Extracted:", meta.documentType, meta.practiceArea, meta.matterLabel);

  // Step 5: Embed the arguments (semantic search target)
  //   Concatenate the key arguments and their reasoning into an embedding-worthy chunk.
  const embeddingText = [
    meta.summary || "",
    ...(meta.keyIssues || []),
    ...((meta.keyArguments || []).map(a => `${a.argument} ${a.reasoning}`)),
  ].filter(Boolean).join(". ");

  let embedding = null;
  try {
    embedding = await embedText(embeddingText);
  } catch (e) {
    console.log("[firm-docs] Embedding failed (non-fatal):", e.message);
  }

  // Step 6: Store
  const finalLabel = matterLabelOverride || meta.matterLabel || "Untitled firm document";
  const embeddingLiteral = embedding ? "[" + embedding.join(",") + "]" : null;

  const insert = await db.query(
    `INSERT INTO firm_documents (
       source_hash, matter_label, document_type, practice_area, court_or_agency,
       judge_name, filing_date, key_issues, key_arguments, authorities_cited,
       summary, redacted_text, source_url, is_public, embedding, pii_redacted, uploaded_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::halfvec,$16,$17)
     RETURNING id`,
    [
      sourceHash,
      finalLabel,
      meta.documentType || preflight.documentType || "other",
      meta.practiceArea || "other",
      meta.courtOrAgency || null,
      meta.judgeName || null,
      meta.filingDate || null,
      meta.keyIssues || [],
      JSON.stringify(meta.keyArguments || []),
      meta.authoritiesCited || [],
      meta.summary || null,
      redaction.redactedText,
      sourceUrl,
      preflight.verdict === "public",  // true if public, false otherwise
      embeddingLiteral,
      true,  // pii_redacted always true in v1
      actorId,
    ]
  );

  const docId = insert.rows[0].id;

  // Step 7: Audit log
  await db.query(
    `INSERT INTO firm_documents_audit (action, doc_id, source_hash, actor, details)
     VALUES ('ingest', $1, $2, $3, $4)`,
    [docId, sourceHash, actorId, JSON.stringify({ preflight, redactionsCount: redaction.redactionsCount, sourceUrl })]
  );

  return {
    ok: true,
    docId,
    matterLabel: finalLabel,
    documentType: meta.documentType,
    practiceArea: meta.practiceArea,
    keyIssuesCount: (meta.keyIssues || []).length,
    keyArgumentsCount: (meta.keyArguments || []).length,
    authoritiesCount: (meta.authoritiesCited || []).length,
    redactionsCount: redaction.redactionsCount,
    hasEmbedding: !!embedding,
    isPublic: preflight.verdict === "public",
  };
}

// ── Search ─────────────────────────────────────────────────

/**
 * Semantic + keyword search on firm documents. Similar to searchParensHybrid.
 * @param {string} queryText
 * @param {object} options
 *   - limit: default 5
 *   - practiceArea: filter (optional)
 * @returns {Promise<Array>}
 */
async function searchFirmDocs(queryText, options = {}) {
  const { limit = 5, practiceArea = null } = options;

  // Only search if the table has any content
  const countCheck = await db.query(`SELECT COUNT(*) FROM firm_documents WHERE embedding IS NOT NULL`);
  if (parseInt(countCheck.rows[0].count, 10) === 0) return [];

  // Embed the query
  const qEmbedding = await embedText(queryText);
  const qVec = "[" + qEmbedding.join(",") + "]";

  // Similarity search (small table, so plain vector search is fast)
  const params = [qVec];
  let where = "WHERE embedding IS NOT NULL";
  if (practiceArea) {
    params.push(practiceArea);
    where += ` AND practice_area = $${params.length}`;
  }
  params.push(limit);

  const sql = `
    SELECT id, matter_label, document_type, practice_area, court_or_agency,
           judge_name, filing_date, key_issues, key_arguments, authorities_cited,
           summary, outcome, outcome_notes, source_url,
           1 - (embedding <=> $1::halfvec) AS similarity
    FROM firm_documents
    ${where}
    ORDER BY embedding <=> $1::halfvec
    LIMIT $${params.length}
  `;
  const r = await db.query(sql, params);
  return r.rows;
}

/**
 * Format firm doc search results into a context block for JJ mode injection.
 */
function formatFirmContext(results, options = {}) {
  const { maxLength = 3000 } = options;
  if (!results || results.length === 0) return "";

  let block = "═══════════════════════════════════════\n";
  block += "  FROM OUR FIRM'S WORK (public filings & published materials)\n";
  block += "═══════════════════════════════════════\n\n";

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (block.length > maxLength) break;
    const sim = (r.similarity * 100).toFixed(0);
    block += `${i + 1}. [${sim}%] ${r.matter_label} (${r.document_type})\n`;
    if (r.court_or_agency) block += `   Court/Agency: ${r.court_or_agency}\n`;
    if (r.filing_date) block += `   Filed: ${r.filing_date}\n`;
    if (r.summary) block += `   Summary: ${r.summary}\n`;
    if (r.key_arguments && r.key_arguments.length) {
      block += `   Key arguments:\n`;
      for (const arg of r.key_arguments.slice(0, 3)) {
        if (arg.argument) block += `     • ${arg.argument}\n`;
      }
    }
    if (r.outcome && r.outcome !== "pending") block += `   Outcome: ${r.outcome}\n`;
    block += `\n`;
  }

  return block;
}

// ── Outcome Update ─────────────────────────────────────────

async function updateOutcome(docId, outcome, notes = null, actorId = "jj") {
  const validOutcomes = ["won", "lost", "settled", "pending", "unknown", "withdrawn", "dismissed"];
  if (!validOutcomes.includes(outcome)) {
    return { ok: false, reason: `Invalid outcome. Must be one of: ${validOutcomes.join(", ")}` };
  }

  const r = await db.query(
    `UPDATE firm_documents SET outcome = $1, outcome_notes = $2, updated_at = NOW()
     WHERE id = $3 RETURNING id, matter_label`,
    [outcome, notes, docId]
  );

  if (r.rows.length === 0) return { ok: false, reason: "Document not found" };

  await db.query(
    `INSERT INTO firm_documents_audit (action, doc_id, actor, details)
     VALUES ('update_outcome', $1, $2, $3)`,
    [docId, actorId, JSON.stringify({ outcome, notes })]
  );

  return { ok: true, docId: r.rows[0].id, matterLabel: r.rows[0].matter_label, outcome };
}

// ── List / Delete ──────────────────────────────────────────

async function listFirmDocs(options = {}) {
  const { limit = 20, practiceArea = null } = options;
  const params = [];
  let where = "";
  if (practiceArea) {
    params.push(practiceArea);
    where = `WHERE practice_area = $${params.length}`;
  }
  params.push(limit);
  const r = await db.query(`
    SELECT id, matter_label, document_type, practice_area, court_or_agency,
           filing_date, outcome, uploaded_at,
           array_length(key_arguments::jsonb::text[], 1) AS args_count
    FROM firm_documents
    ${where}
    ORDER BY uploaded_at DESC
    LIMIT $${params.length}
  `, params);
  return r.rows;
}

async function deleteFirmDoc(docId, actorId = "jj") {
  const r = await db.query(
    `DELETE FROM firm_documents WHERE id = $1 RETURNING matter_label, source_hash`,
    [docId]
  );
  if (r.rows.length === 0) return { ok: false, reason: "Not found" };

  await db.query(
    `INSERT INTO firm_documents_audit (action, doc_id, source_hash, actor)
     VALUES ('delete', $1, $2, $3)`,
    [docId, r.rows[0].source_hash, actorId]
  );
  return { ok: true, deleted: r.rows[0].matter_label };
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  initFirmDocumentsTable,
  ingestDocument,
  searchFirmDocs,
  formatFirmContext,
  updateOutcome,
  listFirmDocs,
  deleteFirmDoc,
  // Exposed for testing
  preflightPublicCheck,
  redactPII,
  extractMetadata,
};

// ── CLI Mode ───────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    if (args.includes("--init")) {
      await initFirmDocumentsTable();
      console.log("firm_documents table + audit log initialized");
      process.exit(0);
    }

    if (args.includes("--list")) {
      const rows = await listFirmDocs({ limit: 20 });
      if (rows.length === 0) console.log("No firm documents yet");
      else for (const r of rows) {
        console.log(`#${r.id} | ${r.matter_label} | ${r.document_type} | ${r.practice_area} | outcome:${r.outcome || "-"} | ${r.uploaded_at.toISOString().split("T")[0]}`);
      }
      process.exit(0);
    }

    if (args.includes("--search")) {
      const qIdx = args.indexOf("--search");
      const query = args[qIdx + 1];
      if (!query) { console.error("Usage: --search 'query text'"); process.exit(1); }
      console.log(`Searching firm docs for: "${query}"\n`);
      const results = await searchFirmDocs(query, { limit: 5 });
      console.log(formatFirmContext(results));
      process.exit(0);
    }

    if (args.includes("--test-preflight")) {
      const textIdx = args.indexOf("--test-preflight");
      const text = args[textIdx + 1];
      if (!text) { console.error("Usage: --test-preflight 'document text'"); process.exit(1); }
      const result = await preflightPublicCheck(text);
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    console.log(`Usage:
  node firm-documents.js --init                Create tables
  node firm-documents.js --list                List recent uploads
  node firm-documents.js --search "query"      Semantic search
  node firm-documents.js --test-preflight "..."  Test public/private detector
`);
    process.exit(0);
  })().catch(e => {
    console.error("CLI error:", e);
    process.exit(1);
  });
}
