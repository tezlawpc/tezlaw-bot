// ============================================================
//  judge-cross-reference.js  (v1.2 — parallel-citation dedup)
//  Bridges Layer 1 (judge_rulings, judge_profiles) to Research.
//
//  v1.2 CHANGES:
//   - judgeTopCitedCases:  groups by case name only (not by citation).
//     Three parallel cites of "Anders v. California" (US Reports +
//     S.Ct. + L.Ed.) now collapse into one entry. mode() picks the
//     most-frequent citation form to display. all_citations array
//     includes every parallel form found.
//   - judgesCitingCase: documented behavior (already correct).
//
//  v1.1 BASELINE:
//   - junk filter on cited_case_name (excludes broken/truncated)
//   - paren quality filter (drops per curiam, en banc, year-only)
//   - negative_count returned
//
//  PRIMARY QUERIES:
//    1. hasJudgeCited(judgeName, caseId)
//    2. judgesCitingCase(caseId)
//    3. coCitedCases(caseId)
//    4. judgeTopCitedCases(judgeName, motionType, limit)
//    5. predictTreatment(judgeName, caseId, queryContext)
// ============================================================

const db = require("./db");

// SHARED JUNK FILTERS
const JUNK_CASE_NAME_FILTER = `
  e.cited_case_name IS NOT NULL
  AND length(e.cited_case_name) >= 10
  AND e.cited_case_name ~* ' v\\.? '
  AND e.cited_case_name NOT ILIKE '— U.S.%'
  AND e.cited_case_name NOT ILIKE '- U.S.%'
  AND e.cited_case_name NOT ILIKE 'Inc.%'
  AND e.cited_case_name NOT ILIKE 'States v.%'
  AND e.cited_case_name NOT ILIKE 'LLC v.%'
  AND e.cited_case_name NOT ILIKE 'Corp.%'
  AND e.cited_case_name NOT ILIKE '%-- U.S.%'
`;

const PAREN_QUALITY_FILTER = `
  e.parenthetical IS NOT NULL
  AND length(e.parenthetical) > 20
  AND e.parenthetical NOT ILIKE 'per curiam%'
  AND e.parenthetical NOT ILIKE 'en banc%'
  AND e.parenthetical !~ '^\\d{4}$'
`;

// ============================================================
//  1. HAS JUDGE CITED THIS CASE?
// ============================================================

async function hasJudgeCited(judgeName, caseRef) {
  if (!judgeName || !caseRef) return [];

  const conditions = [];
  const params = [`%${judgeName}%`];
  let pi = 2;

  if (caseRef.citation) {
    conditions.push(`e.cited_normalized ILIKE $${pi}`);
    params.push(`%${caseRef.citation}%`);
    pi++;
  }
  if (caseRef.caseName) {
    conditions.push(`e.cited_case_name ILIKE $${pi}`);
    params.push(`%${caseRef.caseName}%`);
    pi++;
  }
  if (caseRef.caseId) {
    conditions.push(`e.cited_cluster_id = $${pi}`);
    params.push(String(caseRef.caseId));
    pi++;
  }

  if (!conditions.length) return [];

  const query = `
    SELECT
      e.id, e.case_name AS ruling_case_name, e.cited_case_name,
      e.cited_case_citation, e.parenthetical, e.treatment, e.signal,
      e.pin_cite, e.judge_name, e.court,
      r.id AS ruling_id, r.case_name AS ruling_full_name,
      r.case_number, r.hearing_date, r.motion_type AS ruling_motion_type
    FROM citation_edges_internal e
    LEFT JOIN judge_rulings r ON r.id = e.ruling_id
    WHERE e.judge_name ILIKE $1
      AND (${conditions.join(" OR ")})
    ORDER BY e.id DESC
    LIMIT 50
  `;

  try {
    const r = await db.query(query, params);
    return r.rows;
  } catch (err) {
    console.error(`[judge-cross-ref] hasJudgeCited error:`, err.message);
    return [];
  }
}

// ============================================================
//  2. WHICH JUDGES HAVE CITED THIS CASE?
//
//  Already groups by (judge_name, court) so parallel citations
//  don't split the result. The WHERE clause matches any citation
//  form, so a judge who cited via 386 U.S. 738 + 87 S.Ct. 1396 is
//  counted twice in citation_count, which is correct (they cited
//  it twice in the same opinion).
// ============================================================

async function judgesCitingCase(caseRef) {
  const conditions = [];
  const params = [];
  let pi = 1;

  if (caseRef.citation) {
    conditions.push(`e.cited_normalized ILIKE $${pi}`);
    params.push(`%${caseRef.citation}%`); pi++;
  }
  if (caseRef.caseName) {
    conditions.push(`e.cited_case_name ILIKE $${pi}`);
    params.push(`%${caseRef.caseName}%`); pi++;
  }
  if (caseRef.caseId) {
    conditions.push(`e.cited_cluster_id = $${pi}`);
    params.push(String(caseRef.caseId)); pi++;
  }

  if (!conditions.length) return [];

  const query = `
    SELECT
      e.judge_name,
      e.court,
      COUNT(*) AS citation_count,
      COUNT(*) FILTER (WHERE e.treatment IN ('positive','followed')) AS positive_count,
      COUNT(*) FILTER (WHERE e.treatment = 'distinguishes') AS distinguishes_count,
      COUNT(*) FILTER (WHERE e.treatment IN ('criticizes','overrules','reverses')) AS negative_count,
      ARRAY_AGG(DISTINCT e.parenthetical) FILTER (WHERE ${PAREN_QUALITY_FILTER}) AS sample_parentheticals,
      MAX(e.extracted_at) AS most_recent_citation
    FROM citation_edges_internal e
    WHERE (${conditions.join(" OR ")})
      AND e.judge_name IS NOT NULL
      AND length(e.judge_name) BETWEEN 4 AND 60
      AND e.judge_name NOT ILIKE '%panel%'
      AND e.judge_name NOT ILIKE '%(per curiam)%'
      AND e.judge_name NOT ILIKE '%circuit judge%'
      AND e.judge_name NOT IN ('Unknown', 'Unknown Judge', 'Per Curiam', 'Consideration', 'Took')
    GROUP BY e.judge_name, e.court
    HAVING COUNT(*) >= 1
    ORDER BY citation_count DESC, most_recent_citation DESC
    LIMIT 30
  `;

  try {
    const r = await db.query(query, params);
    return r.rows;
  } catch (err) {
    console.error(`[judge-cross-ref] judgesCitingCase error:`, err.message);
    return [];
  }
}

// ============================================================
//  3. CO-CITED CASES
// ============================================================

async function coCitedCases(caseRef, judgeName = null, limit = 10) {
  const seedConditions = [];
  const seedParams = [];
  let pi = 1;

  if (caseRef.citation) {
    seedConditions.push(`cited_normalized ILIKE $${pi}`);
    seedParams.push(`%${caseRef.citation}%`); pi++;
  }
  if (caseRef.caseName) {
    seedConditions.push(`cited_case_name ILIKE $${pi}`);
    seedParams.push(`%${caseRef.caseName}%`); pi++;
  }
  if (caseRef.caseId) {
    seedConditions.push(`cited_cluster_id = $${pi}`);
    seedParams.push(String(caseRef.caseId)); pi++;
  }

  if (!seedConditions.length) return [];

  let judgeFilter = "";
  if (judgeName) {
    seedParams.push(`%${judgeName}%`);
    judgeFilter = ` AND judge_name ILIKE $${pi}`;
    pi++;
  }

  const query = `
    WITH seed_rulings AS (
      SELECT DISTINCT ruling_id
      FROM citation_edges_internal
      WHERE (${seedConditions.join(" OR ")})${judgeFilter}
    )
    SELECT
      e.cited_case_name,
      e.cited_case_citation,
      e.cited_normalized,
      COUNT(*) AS co_citation_count,
      COUNT(DISTINCT e.judge_name) AS distinct_judges,
      ARRAY_AGG(DISTINCT e.treatment) FILTER (WHERE e.treatment IS NOT NULL) AS treatments,
      ARRAY_AGG(DISTINCT e.parenthetical) FILTER (WHERE ${PAREN_QUALITY_FILTER}) AS sample_parentheticals
    FROM citation_edges_internal e
    WHERE e.ruling_id IN (SELECT ruling_id FROM seed_rulings)
      AND NOT (${seedConditions.map(c => c).join(" OR ")})
      AND ${JUNK_CASE_NAME_FILTER}
    GROUP BY e.cited_case_name, e.cited_case_citation, e.cited_normalized
    HAVING COUNT(*) >= 2
    ORDER BY co_citation_count DESC, distinct_judges DESC
    LIMIT $${pi}
  `;
  seedParams.push(limit);

  try {
    const r = await db.query(query, seedParams);
    return r.rows;
  } catch (err) {
    console.error(`[judge-cross-ref] coCitedCases error:`, err.message);
    return [];
  }
}

// ============================================================
//  4. JUDGE'S TOP CITED CASES — JUNK-FILTERED + DEDUPED PARALLELS
//
//  v1.2: Groups by cited_case_name only (not by citation), so the
//  three parallel cites of "Anders v. California" (US Reports + S.Ct.
//  + L.Ed.) collapse into one entry. The displayed citation is the
//  most common form (likely US Reports, the canonical reporter).
// ============================================================

async function judgeTopCitedCases(judgeName, motionType = null, limit = 20) {
  const params = [`%${judgeName}%`];
  let pi = 2;
  let motionFilter = "";

  if (motionType) {
    motionFilter = ` AND EXISTS (
      SELECT 1 FROM judge_insights ji
      WHERE ji.judge_profile_id = e.judge_profile_id
        AND ji.motion_type ILIKE $${pi}
    )`;
    params.push(`%${motionType}%`); pi++;
  }
  params.push(limit);

  // Group by case name only — collapses parallel citations.
  // Use mode() to pick the most-frequent citation as the displayed primary.
  // Use SUM(times_cited) from the inner query so the count reflects ALL parallels combined.
  const query = `
    WITH per_citation AS (
      SELECT
        e.cited_case_name,
        e.cited_case_citation,
        e.cited_normalized,
        e.cited_cluster_id,
        e.parenthetical,
        e.treatment,
        e.extracted_at
      FROM citation_edges_internal e
      WHERE e.judge_name ILIKE $1${motionFilter}
        AND ${JUNK_CASE_NAME_FILTER}
    )
    SELECT
      cited_case_name,
      mode() WITHIN GROUP (ORDER BY cited_case_citation) AS cited_case_citation,
      mode() WITHIN GROUP (ORDER BY cited_normalized) AS cited_normalized,
      mode() WITHIN GROUP (ORDER BY cited_cluster_id) AS cited_cluster_id,
      COUNT(*) AS times_cited,
      COUNT(*) FILTER (WHERE treatment IN ('positive','followed')) AS positive_count,
      COUNT(*) FILTER (WHERE treatment = 'distinguishes') AS distinguishes_count,
      COUNT(*) FILTER (WHERE treatment IN ('criticizes','overrules','reverses')) AS negative_count,
      ARRAY_AGG(DISTINCT parenthetical) FILTER (
        WHERE parenthetical IS NOT NULL
          AND length(parenthetical) > 20
          AND parenthetical NOT ILIKE 'per curiam%'
          AND parenthetical NOT ILIKE 'en banc%'
          AND parenthetical !~ '^\\d{4}$'
      ) AS sample_parentheticals,
      ARRAY_AGG(DISTINCT cited_case_citation) FILTER (WHERE cited_case_citation IS NOT NULL) AS all_citations,
      MAX(extracted_at) AS most_recent
    FROM per_citation
    GROUP BY cited_case_name
    HAVING COUNT(*) >= 2
    ORDER BY times_cited DESC, most_recent DESC
    LIMIT $${pi}
  `;

  try {
    const r = await db.query(query, params);
    return r.rows;
  } catch (err) {
    console.error(`[judge-cross-ref] judgeTopCitedCases error:`, err.message);
    return [];
  }
}

// ============================================================
//  5. PREDICT TREATMENT
// ============================================================

async function predictionSnapshot(judgeName, caseRef, motionType = null) {
  const priors = await hasJudgeCited(judgeName, caseRef);

  const profileQuery = await db.query(
    `SELECT judge_name, court, total_rulings FROM judge_profiles WHERE judge_name ILIKE $1 ORDER BY total_rulings DESC LIMIT 1`,
    [`%${judgeName}%`]
  );
  const judgeRow = profileQuery.rows[0];

  const treatments = priors.reduce((acc, p) => {
    if (p.treatment) acc[p.treatment] = (acc[p.treatment] || 0) + 1;
    return acc;
  }, {});

  const negative = (treatments.criticizes || 0) + (treatments.overrules || 0) +
                   (treatments.reverses || 0) + (treatments.distinguishes || 0);
  const positive = (treatments.positive || 0) + (treatments.followed || 0);

  let confidence = "LOW";
  let summary = "";

  if (priors.length === 0) {
    summary = `Judge ${judgeName} has not cited this case in the firm's working database.`;
    confidence = "LOW";
  } else if (priors.length >= 5) {
    confidence = "HIGH";
    summary = `Judge ${judgeName} has cited this case ${priors.length} times. ` +
              `Treatment: ${positive} positive, ${negative} negative, ` +
              `${(treatments.neutral || 0) + (treatments.cited || 0)} neutral/citing.`;
  } else {
    confidence = "MEDIUM";
    summary = `Judge ${judgeName} has cited this case ${priors.length} times. Limited data.`;
  }

  return {
    judge: judgeRow ? {
      name:          judgeRow.judge_name,
      court:         judgeRow.court,
      total_rulings: judgeRow.total_rulings,
    } : { name: judgeName, court: null, total_rulings: 0 },
    prior_citations:    priors.slice(0, 10),
    citation_count:     priors.length,
    treatments_summary: treatments,
    has_distinguished:  (treatments.distinguishes || 0) > 0,
    has_followed:       (treatments.followed || 0) + (treatments.positive || 0) > 0,
    has_criticized:     (treatments.criticizes || 0) > 0,
    has_overruled:      (treatments.overrules || 0) > 0,
    confidence,
    summary,
  };
}

// ============================================================
//  6. ETL — BACKFILL citation_edges_internal FROM judge_insights.cited_cases
// ============================================================

async function backfillCitationEdges({ batchSize = 500, startFrom = 0 } = {}) {
  console.log(`[backfill] Starting citation edges backfill from insight_id > ${startFrom}`);

  const countResult = await db.query(
    `SELECT COUNT(*) FROM judge_insights
     WHERE cited_cases IS NOT NULL
       AND array_length(cited_cases, 1) > 0
       AND id > $1`,
    [startFrom]
  );
  const total = parseInt(countResult.rows[0].count);
  console.log(`[backfill] ${total} judge_insights rows with citations to process`);

  if (total === 0) {
    console.log(`[backfill] No data to process. Exiting.`);
    return { processed: 0, edgesCreated: 0 };
  }

  let processed = 0;
  let edgesCreated = 0;
  let lastId = startFrom;

  while (processed < total) {
    const insights = await db.query(`
      SELECT id, judge_profile_id, judge_name, court, motion_type, cited_cases
      FROM judge_insights
      WHERE cited_cases IS NOT NULL
        AND array_length(cited_cases, 1) > 0
        AND id > $1
      ORDER BY id ASC LIMIT $2
    `, [lastId, batchSize]);

    if (!insights.rows.length) break;

    for (const ins of insights.rows) {
      const cites = ins.cited_cases || [];

      for (const citeStr of cites) {
        if (!citeStr || typeof citeStr !== "string") continue;
        const trimmed = citeStr.trim();
        if (trimmed.length < 4) continue;

        const fullMatch = trimmed.match(/^(.+?),\s*(\d+\s+[A-Za-z.]+\s+\d+)\s*(?:\(([^)]+)\))?\s*$/);

        let caseName, citation;
        if (fullMatch) {
          caseName = fullMatch[1].trim();
          citation = fullMatch[2].trim();
        } else {
          caseName = trimmed;
          citation = null;
        }

        const normalized = trimmed.toLowerCase().replace(/\s+/g, " ").trim();

        try {
          await db.query(`
            INSERT INTO citation_edges_internal
              (ruling_id, judge_profile_id, judge_name, court,
               cited_case_name, cited_case_citation, cited_normalized,
               parenthetical, treatment, pin_cite)
            VALUES (NULL, $1, $2, $3, $4, $5, $6, NULL, NULL, NULL)
          `, [
            ins.judge_profile_id,
            ins.judge_name,
            ins.court,
            caseName,
            citation,
            normalized,
          ]);
          edgesCreated++;
        } catch (err) {
          // skip
        }
      }
      lastId = ins.id;
      processed++;
    }

    if (processed % 50 === 0 || processed >= total) {
      console.log(`[backfill] ${processed}/${total} insights processed, ${edgesCreated} edges created`);
    }
  }

  console.log(`[backfill] ✅ Done. ${processed} insights, ${edgesCreated} edges created.`);
  return { processed, edgesCreated };
}

module.exports = {
  hasJudgeCited,
  judgesCitingCase,
  coCitedCases,
  judgeTopCitedCases,
  predictionSnapshot,
  backfillCitationEdges,
  searchParensBySimilarity,
  embedQueryText,
};

// ────────────────────────────────────────────────────────────────
//  PHASE C: SEMANTIC SEARCH (Level 3 RAG)
//  ────────────────────────────────────────────────────────────
//  searchParensBySimilarity — semantic vector search on the moat.
//  embedQueryText — OpenAI embedding call for a search query.
//
//  These require: (a) pgvector installed, (b) embedding halfvec(3072)
//  column populated (see embed-parens.js), (c) OPENAI_API_KEY env.
// ────────────────────────────────────────────────────────────────

const axios = require("axios");
const OPENAI_MODEL = "text-embedding-3-large";  // must match embed-parens.js

async function embedQueryText(text) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set");
  }
  const r = await axios.post(
    "https://api.openai.com/v1/embeddings",
    { input: text, model: OPENAI_MODEL, encoding_format: "float" },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
  return r.data.data[0].embedding;
}

/**
 * Semantic search on the parenthetical moat.
 *
 * @param {string} queryText  — Natural-language search (e.g. "245(i) grandfathering after overstay")
 * @param {object} options
 *   - limit: number of results (default 15, max 100)
 *   - court: filter to specific court (e.g. 'ca9', 'bia')
 *   - judge: filter to specific judge (partial match)
 *   - minSimilarity: filter results below this (0-1 scale, default 0.4)
 *   - excludeGenericParens: skip "per curiam" and similar (default true)
 * @returns {Promise<Array>} rows with paren, cited case, judge, similarity
 */
async function searchParensBySimilarity(queryText, options = {}) {
  const {
    limit = 15,
    court = null,
    judge = null,
    minSimilarity = 0.4,
    excludeGenericParens = true,
  } = options;

  if (!queryText || queryText.trim().length < 3) {
    throw new Error("queryText must be at least 3 chars");
  }

  // 1. Embed the query
  const qEmbedding = await embedQueryText(queryText);
  const qVec = "[" + qEmbedding.join(",") + "]";

  // 2. Vector similarity search
  //    Uses cosine distance operator <=>. Similarity = 1 - distance.
  //    HNSW index (built after embedding) makes this fast.
  const clauses = ["e.embedding IS NOT NULL"];
  const params = [qVec];
  let paramIdx = 2;

  if (court) {
    clauses.push(`e.court = $${paramIdx++}`);
    params.push(court);
  }
  if (judge) {
    clauses.push(`e.judge_name ILIKE $${paramIdx++}`);
    params.push("%" + judge + "%");
  }
  if (excludeGenericParens) {
    clauses.push(`length(e.parenthetical) > 40`);
    clauses.push(`e.parenthetical NOT ILIKE '%per curiam%'`);
    clauses.push(`e.parenthetical NOT ILIKE '%unpublished%'`);
  }

  const whereSql = clauses.join(" AND ");

  const sql = `
    SELECT
      e.id,
      e.parenthetical,
      e.cited_case_name,
      e.cited_case_citation,
      e.treatment,
      e.signal,
      e.judge_name,
      e.court,
      e.case_name AS ruling_case_name,
      r.motion_type AS ruling_motion_type,
      r.url        AS ruling_url,
      r.hearing_date,
      1 - (e.embedding <=> $1::halfvec) AS similarity
    FROM citation_edges_internal e
    LEFT JOIN judge_rulings r ON r.id = e.ruling_id
    WHERE ${whereSql}
    ORDER BY e.embedding <=> $1::halfvec
    LIMIT $${paramIdx}
  `;
  params.push(Math.min(limit, 100));

  const result = await db.query(sql, params);

  // 3. Filter by minimum similarity (post-query since HNSW ORDER BY is distance-based)
  const rows = result.rows.filter(r => r.similarity >= minSimilarity);

  return rows;
}

// ────────────────────────────────────────────────────────────────
//  Format helper: produce a text block for prompt context
// ────────────────────────────────────────────────────────────────
function formatMoatContext(searchResults, options = {}) {
  const {
    header = "═══ RELEVANT PRECEDENT FROM YOUR MOAT ═══",
    maxLength = 6000,   // don't blow prompt budget
    includeUrls = false,
  } = options;

  if (!searchResults || !searchResults.length) return "";

  const lines = [header, ""];
  let charBudget = maxLength - header.length - 200;

  for (let i = 0; i < searchResults.length; i++) {
    const r = searchResults[i];
    const sim = (r.similarity * 100).toFixed(0);
    const caseLine = `${i + 1}. ${r.cited_case_name || "Unknown"}${r.cited_case_citation ? " (" + r.cited_case_citation + ")" : ""}`;
    const meta = `   Court: ${r.court || "?"} | Judge: ${r.judge_name || "?"} | Similarity: ${sim}%`;
    const parenLine = `   Paren: "${r.parenthetical}"`;

    let entry = caseLine + "\n" + meta + "\n" + parenLine;
    if (r.treatment) entry += `\n   Treatment: ${r.treatment}`;
    if (includeUrls && r.ruling_url) entry += `\n   Ruling: ${r.ruling_url}`;
    entry += "\n";

    if (entry.length > charBudget) break;
    lines.push(entry);
    charBudget -= entry.length;
  }

  lines.push("═══ END PRECEDENT ═══");
  return lines.join("\n");
}

// Also export the formatter
module.exports.formatMoatContext = formatMoatContext;
module.exports.searchParensHybrid = searchParensHybrid;
module.exports.extractLegalKeywords = extractLegalKeywords;

// ────────────────────────────────────────────────────────────────
//  HYBRID KEYWORD+VECTOR SEARCH
//  ────────────────────────────────────────────────────────────
//  Works WITHOUT an HNSW/IVFFlat index (Render Basic tier can't
//  build one). Instead:
//  1. Extract legal keywords from query using Haiku
//  2. Postgres ILIKE filter narrows to ~1-3K candidate parens
//  3. Load those rows' embeddings into JS
//  4. Rank by cosine similarity in JS (in-memory, ~50ms for 3K rows)
//
//  Total time: 500ms-2s per query (vs 94s without index).
//  Cost per query: ~$0.0004 (Haiku keyword extraction + one query embedding)
// ────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL_HAIKU = "claude-haiku-4-5-20251001";

async function extractLegalKeywords(queryText) {
  // Small Haiku call — asks for 5-10 legal terms to keyword-match
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  const prompt = `Extract 5-10 legal keywords/phrases from this question. Return ONLY a JSON array of strings — words that would appear literally in court parentheticals about this topic. Prefer statutes (§ 245(i), 8 USC 1101), case name fragments (Cardoza, Landin), doctrinal terms (extreme hardship, adjustment of status), and specific concepts. Skip generic words (the, a, court, ruling).

Question: "${queryText}"

Output JSON only, no explanation. Example: ["245(i)", "grandfathering", "adjustment of status", "unlawful presence", "B-2 visa", "overstay", "waiver", "immediate relative"]`;

  const r = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: ANTHROPIC_MODEL_HAIKU,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 10000,
    }
  );

  const text = r.data.content.filter(b => b.type === "text").map(b => b.text).join("");
  // Extract JSON array — may be wrapped in code fences
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) throw new Error("Haiku didn't return JSON array. Got: " + text.substring(0, 200));

  const keywords = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(keywords) || keywords.length === 0) throw new Error("Invalid keywords");

  // Sanitize — remove empty, dedupe, limit to 10
  return [...new Set(keywords.filter(k => k && typeof k === "string" && k.trim().length > 1))].slice(0, 10);
}

// ────────────────────────────────────────────────────────────────
//  Parse pgvector's halfvec text format into a JS Float32Array
//  Input: "[0.123,-0.456,...]"
// ────────────────────────────────────────────────────────────────
function parseVec(vecStr) {
  // pgvector returns as string like "[0.123,-0.456,...]"
  const stripped = vecStr.replace(/^\[|\]$/g, "");
  const parts = stripped.split(",");
  const arr = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) arr[i] = parseFloat(parts[i]);
  return arr;
}

// Cosine similarity of two Float32Arrays (assumes both are normalized —
// text-embedding-3-large returns normalized vectors, so this is just dot product)
function cosineSim(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Hybrid keyword+vector search — the production entry point for JJ mode.
 *
 * @param {string} queryText — the user's question
 * @param {object} options
 *   - limit: max results (default 15)
 *   - candidatePoolSize: max SQL rows before ranking (default 3000)
 *   - courts: array of courts to restrict search to (default: immigration-relevant courts)
 *   - minSimilarity: filter results below this (default 0.4)
 *   - keywordsOverride: skip Haiku extraction, use these keywords instead
 * @returns {Promise<Array>}
 */
async function searchParensHybrid(queryText, options = {}) {
  const {
    limit = 15,
    candidatePoolSize = 3000,
    courts = [
      "9th Circuit Court of Appeals",
      "Board of Immigration Appeals",
      "U.S. Supreme Court",
      "5th Circuit",
      "11th Circuit",
    ],
    minSimilarity = 0.4,
    keywordsOverride = null,
  } = options;

  if (!queryText || queryText.trim().length < 3) {
    throw new Error("queryText must be at least 3 chars");
  }

  const startTotal = Date.now();

  // Step 1: Extract keywords
  const kwStart = Date.now();
  const keywords = keywordsOverride || await extractLegalKeywords(queryText);
  const kwMs = Date.now() - kwStart;
  console.log(`[hybrid] keywords (${kwMs}ms):`, keywords);

  // Step 2: Embed query
  const embStart = Date.now();
  const qEmbedding = await embedQueryText(queryText);
  const qVec = new Float32Array(qEmbedding);
  const embMs = Date.now() - embStart;

  // Step 3: SQL keyword prefilter
  // Build OR clause across keywords, ILIKE match on parenthetical
  const params = [];
  const kwClauses = keywords.map((k, i) => {
    params.push("%" + k + "%");
    return `e.parenthetical ILIKE $${params.length}`;
  });

  // Courts filter — using ANY
  params.push(courts);

  const sqlStart = Date.now();
  const sql = `
    SELECT
      e.id,
      e.parenthetical,
      e.cited_case_name,
      e.cited_case_citation,
      e.treatment,
      e.signal,
      e.judge_name,
      e.court,
      e.case_name AS ruling_case_name,
      e.embedding::text AS emb_text
    FROM citation_edges_internal e
    WHERE e.embedding IS NOT NULL
      AND e.court = ANY($${params.length})
      AND length(e.parenthetical) > 40
      AND e.parenthetical NOT ILIKE '%per curiam%'
      AND (${kwClauses.join(" OR ")})
    LIMIT ${candidatePoolSize}
  `;

  const rows = await db.query(sql, params);
  const sqlMs = Date.now() - sqlStart;
  console.log(`[hybrid] SQL prefilter (${sqlMs}ms): ${rows.rows.length} candidates`);

  if (rows.rows.length === 0) {
    return [];
  }

  // Step 4: Rank in JS by cosine similarity
  const rankStart = Date.now();
  const scored = [];
  for (const row of rows.rows) {
    try {
      const vec = parseVec(row.emb_text);
      const sim = cosineSim(qVec, vec);
      if (sim >= minSimilarity) {
        scored.push({
          id: row.id,
          parenthetical: row.parenthetical,
          cited_case_name: row.cited_case_name,
          cited_case_citation: row.cited_case_citation,
          treatment: row.treatment,
          signal: row.signal,
          judge_name: row.judge_name,
          court: row.court,
          ruling_case_name: row.ruling_case_name,
          similarity: sim,
        });
      }
    } catch (e) {
      // Skip rows with parse errors
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const rankMs = Date.now() - rankStart;

  const totalMs = Date.now() - startTotal;
  console.log(`[hybrid] Ranked ${scored.length}/${rows.rows.length} candidates (${rankMs}ms). Total: ${totalMs}ms | Query embed: ${embMs}ms`);

  return scored.slice(0, limit);
}


// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--backfill")) {
    backfillCitationEdges().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  }
  else if (args.includes("--search")) {
    // node judge-cross-reference.js --search "extreme hardship waiver 601"
    const queryIdx = args.indexOf("--search");
    const query = args[queryIdx + 1];
    if (!query) {
      console.error("Usage: node judge-cross-reference.js --search \"your query text\" [--court ca9] [--limit 15]");
      process.exit(1);
    }
    const courtIdx = args.indexOf("--court");
    const limitIdx = args.indexOf("--limit");
    const opts = {
      court: courtIdx >= 0 ? args[courtIdx + 1] : null,
      limit: limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 15,
    };

    console.log(`\nSearching for: "${query}"${opts.court ? " (court: " + opts.court + ")" : ""}\n`);

    searchParensBySimilarity(query, opts)
      .then(results => {
        console.log(`Found ${results.length} results\n`);
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const sim = (r.similarity * 100).toFixed(1);
          console.log(`${i + 1}. [${sim}%] ${r.cited_case_name || "Unknown"}`);
          if (r.cited_case_citation) console.log(`   Cite: ${r.cited_case_citation}`);
          console.log(`   Court: ${r.court || "?"} | Judge: ${r.judge_name || "?"}`);
          console.log(`   Paren: "${r.parenthetical}"`);
          if (r.treatment) console.log(`   Treatment: ${r.treatment}`);
          console.log("");
        }
        process.exit(0);
      })
      .catch(e => { console.error("Search failed:", e.message); console.error(e.stack); process.exit(1); });
  }
  else if (args.includes("--hybrid")) {
    // node judge-cross-reference.js --hybrid "245(i) grandfathering B-2 overstay"
    const queryIdx = args.indexOf("--hybrid");
    const query = args[queryIdx + 1];
    if (!query) {
      console.error("Usage: node judge-cross-reference.js --hybrid \"your query text\" [--limit 15]");
      process.exit(1);
    }
    const limitIdx = args.indexOf("--limit");
    const opts = {
      limit: limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 15,
    };

    console.log(`\n=== HYBRID SEARCH: "${query}" ===\n`);

    searchParensHybrid(query, opts)
      .then(results => {
        console.log(`\nFound ${results.length} results\n`);
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const sim = (r.similarity * 100).toFixed(1);
          console.log(`${i + 1}. [${sim}%] ${r.cited_case_name || "Unknown"}`);
          if (r.cited_case_citation) console.log(`   Cite: ${r.cited_case_citation}`);
          console.log(`   Court: ${r.court || "?"} | Judge: ${r.judge_name || "?"}`);
          console.log(`   Paren: "${r.parenthetical}"`);
          if (r.treatment) console.log(`   Treatment: ${r.treatment}`);
          console.log("");
        }
        process.exit(0);
      })
      .catch(e => { console.error("Hybrid search failed:", e.message); console.error(e.stack); process.exit(1); });
  }
  else {
    console.log("Usage:");
    console.log("  node judge-cross-reference.js --backfill");
    console.log("  node judge-cross-reference.js --search \"query text\" [--court ca9] [--limit 15]");
    process.exit(0);
  }
}
