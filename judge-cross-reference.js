// ============================================================
//  judge-cross-reference.js
//  Bridges Layer 1 (judge_rulings, judge_profiles) to Research.
//
//  THE COMPETITIVE MOAT — these queries cannot be replicated by
//  Westlaw/Lexis/Fastcase because they require firm-specific data
//  about which judges have cited which cases, with what treatment.
//
//  PRIMARY QUERIES:
//    1. hasJudgeCited(judgeName, caseId)
//       → "Has Judge X cited THIS case before, and how?"
//
//    2. judgesCitingCase(caseId)
//       → "Which judges in the firm's working DB have cited this case?"
//
//    3. coCitedCases(caseId)
//       → "Cases this judge cites alongside the seed case"
//
//    4. predictTreatment(judgeName, caseId, queryContext)
//       → "How would Judge X likely treat this case?"
//          (uses Layer 1 profile + cited_cases history)
// ============================================================

const db = require("./db");

// ============================================================
//  1. HAS JUDGE CITED THIS CASE?
// ============================================================

/**
 * Find every time a specific judge has cited a specific case.
 * Returns the parenthetical, treatment, and ruling context.
 *
 * @param {string} judgeName - case-insensitive partial match (e.g., "Wardlaw")
 * @param {Object} caseRef - { caseId?, citation?, caseName? }
 * @returns Array of citation events
 */
async function hasJudgeCited(judgeName, caseRef) {
  if (!judgeName || !caseRef) return [];

  // Build matching conditions
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
// ============================================================

/**
 * Find every judge in the firm's working DB who has cited this case.
 * Useful for "who's friendly to this authority?" research.
 *
 * @param {Object} caseRef - { caseId?, citation?, caseName? }
 * @returns Aggregated by judge with citation count + treatment summary
 */
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
      ARRAY_AGG(DISTINCT e.parenthetical) FILTER (WHERE e.parenthetical IS NOT NULL) AS sample_parentheticals,
      MAX(e.extracted_at) AS most_recent_citation
    FROM citation_edges_internal e
    WHERE ${conditions.join(" OR ")}
    GROUP BY e.judge_name, e.court
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
//  3. CO-CITED CASES (Cases This Judge Cites Alongside Seed)
// ============================================================

/**
 * Cases that frequently appear in the same rulings as the seed case.
 * Pattern: find rulings citing seedCase → list other cases in those rulings.
 *
 * @param {Object} caseRef - the seed case
 * @param {string} judgeName - optional, scope to this judge
 * @param {number} limit - default 10
 */
async function coCitedCases(caseRef, judgeName = null, limit = 10) {
  // Step 1: find ruling_ids that cite the seed case
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
      ARRAY_AGG(DISTINCT e.parenthetical) FILTER (WHERE e.parenthetical IS NOT NULL) AS sample_parentheticals
    FROM citation_edges_internal e
    WHERE e.ruling_id IN (SELECT ruling_id FROM seed_rulings)
      AND NOT (${seedConditions.map((c, i) => c.replace(/\$\d+/g, m => `$${parseInt(m.slice(1))}`)).join(" OR ")})
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
//  4. JUDGE'S TOP CITED CASES (most authoritative for this judge)
// ============================================================

/**
 * Get the cases a specific judge cites most often. Useful for:
 *  - "What authorities does Judge X rely on?"
 *  - Brief-writing: lead with cases this judge respects
 */
async function judgeTopCitedCases(judgeName, motionType = null, limit = 20) {
  const params = [`%${judgeName}%`];
  let pi = 2;
  let motionFilter = "";

  // Motion filter via judge_insights (since citation_edges_internal doesn't have motion_type)
  if (motionType) {
    motionFilter = ` AND EXISTS (
      SELECT 1 FROM judge_insights ji
      WHERE ji.judge_profile_id = e.judge_profile_id
        AND ji.motion_type ILIKE $${pi}
    )`;
    params.push(`%${motionType}%`); pi++;
  }
  params.push(limit);

  const query = `
    SELECT
      e.cited_case_name,
      e.cited_case_citation,
      e.cited_normalized,
      e.cited_cluster_id,
      COUNT(*) AS times_cited,
      COUNT(*) FILTER (WHERE e.treatment IN ('positive','followed')) AS positive_count,
      COUNT(*) FILTER (WHERE e.treatment = 'distinguishes') AS distinguishes_count,
      ARRAY_AGG(DISTINCT e.parenthetical) FILTER (WHERE e.parenthetical IS NOT NULL) AS sample_parentheticals,
      MAX(e.extracted_at) AS most_recent
    FROM citation_edges_internal e
    WHERE e.judge_name ILIKE $1${motionFilter}
    GROUP BY e.cited_case_name, e.cited_case_citation, e.cited_normalized, e.cited_cluster_id
    HAVING COUNT(*) >= 1
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
//  Uses captured judge profile + cited_cases history to predict
//  how Judge X would likely treat caseId in the queryContext.
// ============================================================

/**
 * Build a snapshot for "how would Judge X treat this case?"
 * Returns structured data (not a Claude call — that lives in research-engine.js)
 *
 * @returns {
 *   judge: { name, court, total_rulings },
 *   prior_citations: [...],     // every prior cite of this case by this judge
 *   has_distinguished: bool,
 *   has_followed: bool,
 *   has_criticized: bool,
 *   confidence: 'HIGH' | 'MEDIUM' | 'LOW',
 *   summary: string,
 * }
 */
async function predictionSnapshot(judgeName, caseRef, motionType = null) {
  const priors = await hasJudgeCited(judgeName, caseRef);

  // Profile lookup
  const profileQuery = await db.query(
    `SELECT judge_name, court, total_rulings FROM judge_profiles WHERE judge_name ILIKE $1 ORDER BY total_rulings DESC LIMIT 1`,
    [`%${judgeName}%`]
  );
  const judgeRow = profileQuery.rows[0];

  // Tally treatments
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
//  Run once to populate the moat table from existing data.
// ============================================================

/**
 * One-time backfill: flatten judge_insights.cited_cases ARRAY into
 * citation_edges_internal table.
 *
 * judge_insights schema (per Layer 1):
 *   - judge_profile_id, judge_name, court, motion_type
 *   - cited_cases    text[]   ← array of citation strings
 *   - cited_statutes text[]
 *   - accepted_args  text[]
 *
 * cited_cases entries are strings like:
 *   "Nahrvani v. Gonzales, 399 F.3d 1148 (9th Cir. 2005)"
 *   "Mendez-Gutierrez v. Ashcroft"
 *
 * Use: node judge-cross-reference.js --backfill
 */
async function backfillCitationEdges({ batchSize = 500, startFrom = 0 } = {}) {
  console.log(`[backfill] Starting citation edges backfill from insight_id > ${startFrom}`);

  // Get total count of insights with citations
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

        // Parse "Case Name, ### Reporter ### (Court Year)" pattern
        // Two main shapes seen in the data:
        //   Full:    "Nahrvani v. Gonzales, 399 F.3d 1148 (9th Cir. 2005)"
        //   Short:   "Mendez-Gutierrez v. Ashcroft"
        const fullMatch = trimmed.match(/^(.+?),\s*(\d+\s+[A-Za-z.]+\s+\d+)\s*(?:\(([^)]+)\))?\s*$/);

        let caseName, citation;
        if (fullMatch) {
          caseName = fullMatch[1].trim();
          citation = fullMatch[2].trim();
        } else {
          // Short form — just the case name
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
          // Skip individual edge failures; keep going
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
};

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--backfill")) {
    backfillCitationEdges().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  } else {
    console.log("Usage: node judge-cross-reference.js --backfill");
    process.exit(0);
  }
}
