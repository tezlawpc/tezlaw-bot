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
      r.cluster_id, r.date_filed, r.docket_number,
      r.snippet AS ruling_snippet
    FROM citation_edges_internal e
    JOIN judge_rulings r ON r.id = e.ruling_id
    WHERE e.judge_name ILIKE $1
      AND (${conditions.join(" OR ")})
    ORDER BY r.date_filed DESC
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
      MAX(r.date_filed) AS most_recent_citation
    FROM citation_edges_internal e
    LEFT JOIN judge_rulings r ON r.id = e.ruling_id
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

  if (motionType) {
    motionFilter = ` AND r.motion_type ILIKE $${pi}`;
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
      MAX(r.date_filed) AS most_recent
    FROM citation_edges_internal e
    LEFT JOIN judge_rulings r ON r.id = e.ruling_id
    WHERE e.judge_name ILIKE $1${motionFilter}
    GROUP BY e.cited_case_name, e.cited_case_citation, e.cited_normalized, e.cited_cluster_id
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
//  6. ETL — BACKFILL citation_edges_internal FROM judge_rulings.cited_cases
//  Run once to populate the moat table from existing JSONB.
// ============================================================

/**
 * One-time backfill: flatten judge_rulings.cited_cases JSONB into
 * citation_edges_internal table.
 *
 * cited_cases JSONB shape (from existing extraction):
 *   [
 *     { case_name, citation, parenthetical?, treatment?, pin_cite? },
 *     ...
 *   ]
 *
 * Use: node -e "require('./judge-cross-reference').backfillCitationEdges()"
 */
async function backfillCitationEdges({ batchSize = 500, startFrom = 0 } = {}) {
  console.log(`[backfill] Starting citation edges backfill from ruling_id > ${startFrom}`);

  // Get total count
  const countResult = await db.query(
    `SELECT COUNT(*) FROM judge_rulings WHERE cited_cases IS NOT NULL AND id > $1`,
    [startFrom]
  );
  const total = parseInt(countResult.rows[0].count);
  console.log(`[backfill] ${total} rulings with cited_cases to process`);

  let processed = 0;
  let edgesCreated = 0;
  let lastId = startFrom;

  while (processed < total) {
    const rulings = await db.query(`
      SELECT r.id, r.judge_profile_id, r.judge_name, r.court, r.case_name, r.cited_cases
      FROM judge_rulings r
      WHERE r.cited_cases IS NOT NULL AND r.id > $1
      ORDER BY r.id ASC LIMIT $2
    `, [lastId, batchSize]);

    if (!rulings.rows.length) break;

    for (const ruling of rulings.rows) {
      const cites = Array.isArray(ruling.cited_cases) ? ruling.cited_cases : [];
      for (const c of cites) {
        if (!c || typeof c !== "object") continue;

        const citation = c.citation || c.cite || "";
        const caseName = c.case_name || c.caseName || c.name || "";
        if (!citation && !caseName) continue;

        const normalized = (citation || caseName).toLowerCase().replace(/\s+/g, " ").trim();

        try {
          await db.query(`
            INSERT INTO citation_edges_internal
              (ruling_id, judge_profile_id, judge_name, court, case_name,
               cited_case_name, cited_case_citation, cited_normalized,
               parenthetical, treatment, pin_cite)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `, [
            ruling.id,
            ruling.judge_profile_id,
            ruling.judge_name,
            ruling.court,
            ruling.case_name,
            caseName || null,
            citation || null,
            normalized,
            c.parenthetical || c.parens || null,
            c.treatment || null,
            c.pin_cite || c.pinCite || null,
          ]);
          edgesCreated++;
        } catch (err) {
          // Skip individual edge failures; keep going
        }
      }
      lastId = ruling.id;
      processed++;
    }

    if (processed % 100 === 0 || processed >= total) {
      console.log(`[backfill] ${processed}/${total} rulings processed, ${edgesCreated} edges created`);
    }
  }

  console.log(`[backfill] ✅ Done. ${processed} rulings, ${edgesCreated} edges created.`);
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
