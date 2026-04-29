// ============================================================
//  overnight-enrichment.js
//  Long-running background job to enrich the moat data.
//
//  Runs 4 phases in sequence with checkpointing:
//    1. Resolve cluster IDs via CourtListener /citation-lookup/
//    2. Extract parentheticals + treatment from full opinion text
//    3. Deduplicate citation_edges_internal rows
//    4. Layer 2 motion intelligence re-enrichment
//
//  USAGE:
//    nohup node overnight-enrichment.js > overnight.log 2>&1 &
//
//  Or to run only specific phases:
//    node overnight-enrichment.js --phase=1
//    node overnight-enrichment.js --phases=1,3
//
//  CHECKPOINT FILE: /var/data/overnight-checkpoint.json
//    Survives Render restarts so the job resumes where it stopped.
//
//  REPORT FILE: /var/data/overnight-report.json
//    Final report you read when you wake up.
// ============================================================

const fs   = require("fs");
const path = require("path");
const db   = require("./db");
const cl   = require("./courtlistener-client");

// Optional: eyecite for parenthetical extraction
let eyecite = null;
try { eyecite = require("./eyecite-bridge"); } catch (e) { /* graceful */ }

// Optional: Layer 2 motion intelligence
let motionIntel = null;
try { motionIntel = require("./motion-intelligence"); } catch (e) { /* graceful */ }

// ============================================================
//  CONFIG
// ============================================================

const STORAGE_DIR        = process.env.PERSISTENT_STORAGE_DIR || "/var/data";
const CHECKPOINT_FILE    = path.join(STORAGE_DIR, "overnight-checkpoint.json");
const REPORT_FILE        = path.join(STORAGE_DIR, "overnight-report.json");
const LOG_FILE           = path.join(STORAGE_DIR, "overnight-progress.log");
const MAX_RUNTIME_HOURS  = 10;  // Hard stop after 10 hours
const STARTED_AT         = Date.now();

// Throttle settings (CourtListener: 5000/hr general, 60/min on /citation-lookup/)
const CITATION_LOOKUP_INTERVAL_MS = 1100;  // ~55/min
const OPINION_FETCH_INTERVAL_MS   = 200;   // ~5/sec for general API
const BATCH_SIZE                  = 100;
const SAVE_CHECKPOINT_EVERY       = 25;

// ============================================================
//  STATE / CHECKPOINT
// ============================================================

let state = {
  job_id:     null,
  started_at: new Date().toISOString(),
  phases: {
    1: { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0 },
    2: { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0 },
    3: { status: "pending", processed: 0, total: 0, merged: 0, errors: 0 },
    4: { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0 },
    5: { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0, fetched_chars: 0 },
    6: { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0 },
  },
  current_phase: null,
};

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
      log(`[init] Resuming from checkpoint. Job ID: ${saved.job_id}`);
      return saved;
    }
  } catch (err) {
    log(`[init] Checkpoint corrupt or unreadable: ${err.message}, starting fresh`);
  }
  return null;
}

function saveCheckpoint() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`[checkpoint] Save failed: ${err.message}`);
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) { /* non-fatal */ }
}

function checkRuntimeBudget() {
  const hoursElapsed = (Date.now() - STARTED_AT) / (1000 * 60 * 60);
  if (hoursElapsed >= MAX_RUNTIME_HOURS) {
    log(`[budget] Max runtime ${MAX_RUNTIME_HOURS}h reached. Stopping gracefully.`);
    return false;
  }
  return true;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
//  PHASE 1 — Resolve Cluster IDs via /citation-lookup/
//
//  For each citation_edges_internal row that has a citation string
//  but no cluster_id, ask CourtListener what cluster it points to.
//  This unlocks linking to real case pages.
// ============================================================

async function phase1_resolveClusterIds() {
  log("===== PHASE 1: Resolving cluster IDs via CourtListener =====");
  state.current_phase = 1;
  state.phases[1].status = "running";

  // Step 1A: Citation-based lookup (fast, accurate via /citation-lookup/ endpoint)
  await _phase1a_citationLookup();
  if (!checkRuntimeBudget()) return;

  // Step 1B: Name-only lookup via case search (slower, needs fuzzy matching)
  await _phase1b_nameSearch();

  state.phases[1].status = "complete";
  saveCheckpoint();
  log(`[phase1] ✅ Complete. Total processed: ${state.phases[1].processed}, errors: ${state.phases[1].errors}`);
}

async function _phase1a_citationLookup() {
  // Count edges WITH a citation string
  const countQuery = await db.query(`
    SELECT COUNT(*) FROM citation_edges_internal
    WHERE cited_cluster_id IS NULL
      AND cited_case_citation IS NOT NULL
      AND cited_case_citation != ''
      AND id > $1
  `, [state.phases[1].last_id]);
  const total = parseInt(countQuery.rows[0].count);
  state.phases[1].total = (state.phases[1].total || 0) + total;
  log(`[phase1a] ${total} edges have citations — using /citation-lookup/`);

  if (total === 0) return;

  let lastId = state.phases[1].last_id;

  while (true) {
    if (!checkRuntimeBudget()) {
      state.phases[1].status = "paused_budget";
      saveCheckpoint();
      return;
    }

    const batch = await db.query(`
      SELECT id, cited_case_name, cited_case_citation
      FROM citation_edges_internal
      WHERE cited_cluster_id IS NULL
        AND cited_case_citation IS NOT NULL
        AND cited_case_citation != ''
        AND id > $1
      ORDER BY id ASC
      LIMIT $2
    `, [lastId, BATCH_SIZE]);

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      try {
        const lookupText = `${row.cited_case_name || ""}, ${row.cited_case_citation}`.trim();
        const results = await cl.citationLookup(lookupText);
        await sleep(CITATION_LOOKUP_INTERVAL_MS);

        let clusterId = null;
        let normalizedCitation = null;
        if (Array.isArray(results)) {
          for (const r of results) {
            if (r.clusters && r.clusters.length > 0) {
              clusterId = r.clusters[0].id;
              normalizedCitation = (r.normalized_citations && r.normalized_citations[0]) || null;
              break;
            }
          }
        }

        if (clusterId) {
          await db.query(`
            UPDATE citation_edges_internal
            SET cited_cluster_id = $1,
                cited_normalized = COALESCE($2, cited_normalized)
            WHERE id = $3
          `, [String(clusterId), normalizedCitation, row.id]);
        }
      } catch (err) {
        state.phases[1].errors++;
      }

      state.phases[1].processed++;
      state.phases[1].last_id = row.id;
      lastId = row.id;

      if (state.phases[1].processed % SAVE_CHECKPOINT_EVERY === 0) {
        saveCheckpoint();
        log(`[phase1a] ${state.phases[1].processed} processed (${state.phases[1].errors} errors)`);
      }
    }
  }
}

async function _phase1b_nameSearch() {
  // Edges WITHOUT citations — use search endpoint with case name
  // De-dupe by case name first to avoid re-searching the same name
  const distinctNames = await db.query(`
    SELECT cited_case_name, MIN(id) AS first_id, COUNT(*) AS edge_count
    FROM citation_edges_internal
    WHERE cited_cluster_id IS NULL
      AND (cited_case_citation IS NULL OR cited_case_citation = '')
      AND cited_case_name IS NOT NULL
      AND length(cited_case_name) > 5
    GROUP BY cited_case_name
    ORDER BY edge_count DESC
  `);
  log(`[phase1b] ${distinctNames.rows.length} unique case names need search-based resolution`);

  let processed = 0;
  for (const row of distinctNames.rows) {
    if (!checkRuntimeBudget()) return;

    try {
      // Search caselaw by case name
      const searchResults = await cl.searchOpinions({
        q: `caseName:"${row.cited_case_name.replace(/"/g, "")}"`,
        page_size: 3,
      });
      await sleep(OPINION_FETCH_INTERVAL_MS);

      const top = (searchResults.results || [])[0];
      if (top && (top.cluster_id || top.id)) {
        const clusterId = String(top.cluster_id || top.id);
        // Update ALL edges with this case name
        await db.query(`
          UPDATE citation_edges_internal
          SET cited_cluster_id = $1
          WHERE cited_case_name = $2
            AND cited_cluster_id IS NULL
        `, [clusterId, row.cited_case_name]);
      }
    } catch (err) {
      state.phases[1].errors++;
    }

    processed++;
    state.phases[1].processed++;
    if (processed % 10 === 0) {
      saveCheckpoint();
      log(`[phase1b] ${processed}/${distinctNames.rows.length} unique names searched`);
    }
  }
}

// ============================================================
//  PHASE 2 — Extract Parentheticals + Treatment
//
//  For citations where we now have a cluster_id (from Phase 1) AND
//  a ruling_id (so we know which opinion cited it), fetch the citing
//  opinion's full text and find the parenthetical for this citation.
//
//  Skip rows where ruling_id is NULL (data came from judge_insights
//  aggregate, no specific source opinion). We can still classify
//  treatment from the cited case alone, but parentheticals require
//  the original citing opinion.
// ============================================================

async function phase2_extractParentheticals() {
  log("===== PHASE 2: Extracting parentheticals + treatment =====");
  state.current_phase = 2;
  state.phases[2].status = "running";

  if (!eyecite) {
    log("[phase2] ⚠️ Eyecite bridge not available, skipping treatment classification");
  }

  // Only process rows where we have a citing opinion to extract from
  const countQuery = await db.query(`
    SELECT COUNT(*) FROM citation_edges_internal e
    JOIN judge_rulings r ON r.id = e.ruling_id
    WHERE e.parenthetical IS NULL
      AND r.full_text IS NOT NULL
      AND length(r.full_text) > 500
      AND e.cited_case_name IS NOT NULL
      AND e.id > $1
  `, [state.phases[2].last_id]);
  state.phases[2].total = parseInt(countQuery.rows[0].count);
  log(`[phase2] ${state.phases[2].total} edges need parenthetical extraction`);

  if (state.phases[2].total === 0) {
    state.phases[2].status = "complete";
    saveCheckpoint();
    return;
  }

  let lastId = state.phases[2].last_id;

  while (true) {
    if (!checkRuntimeBudget()) {
      state.phases[2].status = "paused_budget";
      saveCheckpoint();
      return;
    }

    const batch = await db.query(`
      SELECT e.id, e.cited_case_name, e.cited_case_citation, e.cited_normalized,
             r.id AS ruling_id, r.full_text
      FROM citation_edges_internal e
      JOIN judge_rulings r ON r.id = e.ruling_id
      WHERE e.parenthetical IS NULL
        AND r.full_text IS NOT NULL
        AND length(r.full_text) > 500
        AND e.cited_case_name IS NOT NULL
        AND e.id > $1
      ORDER BY e.id ASC
      LIMIT $2
    `, [lastId, BATCH_SIZE]);

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      try {
        const result = await extractParentheticalForCitation(
          row.full_text,
          row.cited_case_name,
          row.cited_case_citation
        );

        if (result.parenthetical || result.treatment || result.pin_cite) {
          await db.query(`
            UPDATE citation_edges_internal
            SET parenthetical = COALESCE($1, parenthetical),
                treatment     = COALESCE($2, treatment),
                pin_cite      = COALESCE($3, pin_cite)
            WHERE id = $4
          `, [result.parenthetical, result.treatment, result.pin_cite, row.id]);
        }
      } catch (err) {
        state.phases[2].errors++;
      }

      state.phases[2].processed++;
      state.phases[2].last_id = row.id;
      lastId = row.id;

      if (state.phases[2].processed % SAVE_CHECKPOINT_EVERY === 0) {
        saveCheckpoint();
        log(`[phase2] ${state.phases[2].processed}/${state.phases[2].total} processed (${state.phases[2].errors} errors)`);
      }
    }
  }

  state.phases[2].status = "complete";
  saveCheckpoint();
  log(`[phase2] ✅ Complete. Processed ${state.phases[2].processed}, errors: ${state.phases[2].errors}`);
}

/**
 * Find the parenthetical/pin-cite/treatment for a citation in an opinion.
 *
 * Strategy:
 *   1. Locate the citation in the opinion text (case name OR citation)
 *   2. Extract the parenthetical that follows (if any)
 *   3. Extract pin cite (specific page after volume/reporter)
 *   4. Classify treatment from parenthetical text via Bluebook patterns
 */
async function extractParentheticalForCitation(opinionText, caseName, citation) {
  if (!opinionText || (!caseName && !citation)) {
    return { parenthetical: null, treatment: null, pin_cite: null };
  }

  // Build a search anchor — prefer citation if present, else case name
  const anchor = citation || caseName;
  const escapedAnchor = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Look for: anchor [, pin] ( parenthetical text )
  // Allow up to 250 chars of intermediate text for the parenthetical
  const rx = new RegExp(
    `${escapedAnchor}` +
    `(?:,\\s*(\\d+))?` +              // optional pin cite
    `[^()]{0,200}?` +                  // some intermediate text
    `\\(([^)]{10,400})\\)`,            // the parenthetical content
    "i"
  );

  const match = opinionText.match(rx);
  if (!match) {
    return { parenthetical: null, treatment: null, pin_cite: null };
  }

  const pinCite      = match[1] || null;
  const parenthetical = match[2].trim();

  // Classify treatment via Bluebook signal phrases
  const treatment = classifyTreatment(parenthetical);

  return { parenthetical, treatment, pin_cite: pinCite };
}

function classifyTreatment(parenthetical) {
  if (!parenthetical) return null;
  const NEG = {
    overrules:     /\boverrul(ed|ing|es)\b|\babrogat(ed|ing|es)\b|\bsupersed/i,
    reverses:      /\brevers(ed|ing|es)\b|\bvacat(ed|ing|es)\b/i,
    criticizes:    /\bcriticiz(ed|ing|es)\b|\bcalled into doubt\b|\bquestioned\b/i,
    distinguishes: /\bdistinguish(ed|ing|es)\b|\bdeclin(ed|ing|es) to follow\b/i,
  };
  const POS = {
    positive: /\b(?:re)?affirm(ed|ing|s)\b|\bfollow(ed|ing|s)\b/i,
  };
  for (const [k, rx] of Object.entries(NEG)) {
    if (rx.test(parenthetical)) return k;
  }
  for (const [k, rx] of Object.entries(POS)) {
    if (rx.test(parenthetical)) return k;
  }
  // Holding/explanatory language is "neutral"
  if (/\bheld\b|\bholding\b|\bnoting\b|\bexplaining\b|\bstating\b/i.test(parenthetical)) {
    return "neutral";
  }
  return null;  // truly indeterminate
}

// ============================================================
//  PHASE 3 — Deduplicate citation_edges_internal
//
//  Problem: same case appears multiple times with different formats:
//    "Duran-Rodriguez v. Barr"
//    "Duran-Rodriguez v. Barr, 918 F.3d 1025"
//    "Duran-Rodriguez v. Barr, 918 F.3d 1025 (9th Cir. 2019)"
//
//  Solution: group by (judge_profile_id, normalized case name without citation)
//  and merge into the canonical row (the one with the most metadata).
// ============================================================

async function phase3_deduplicate() {
  log("===== PHASE 3: Deduplicating citation edges =====");
  state.current_phase = 3;
  state.phases[3].status = "running";

  // Build canonical name: strip citation + court info, lowercase
  // We'll do this via SQL since it's a pure aggregation
  const beforeCount = await db.query(`SELECT COUNT(*) FROM citation_edges_internal`);
  const before = parseInt(beforeCount.rows[0].count);
  log(`[phase3] Starting with ${before} edges`);
  state.phases[3].total = before;

  // Add canonical name column if missing
  await db.query(`
    ALTER TABLE citation_edges_internal
    ADD COLUMN IF NOT EXISTS canonical_name TEXT
  `).catch(() => {});

  // Compute canonical_name for every row:
  //   1. strip everything from first comma onward (removes citation + year)
  //   2. lowercase, collapse whitespace
  await db.query(`
    UPDATE citation_edges_internal
    SET canonical_name = LOWER(TRIM(REGEXP_REPLACE(
      COALESCE(cited_case_name, ''),
      ',.*$',
      '',
      'g'
    )))
    WHERE canonical_name IS NULL OR canonical_name = ''
  `);

  // Find duplicates: same (judge_profile_id, canonical_name) with > 1 row
  const dupes = await db.query(`
    SELECT judge_profile_id, canonical_name, COUNT(*) AS dupe_count
    FROM citation_edges_internal
    WHERE canonical_name IS NOT NULL AND canonical_name != ''
    GROUP BY judge_profile_id, canonical_name
    HAVING COUNT(*) > 1
    ORDER BY dupe_count DESC
  `);
  log(`[phase3] Found ${dupes.rows.length} duplicate groups`);

  for (const dupeGroup of dupes.rows) {
    if (!checkRuntimeBudget()) {
      state.phases[3].status = "paused_budget";
      saveCheckpoint();
      return;
    }

    try {
      // Get all rows in this group, sorted to pick the "best" canonical:
      // prefer rows with cluster_id, then citation, then parenthetical, then longest cited_case_name
      const groupRows = await db.query(`
        SELECT id, cited_case_name, cited_case_citation, cited_cluster_id,
               parenthetical, treatment, pin_cite
        FROM citation_edges_internal
        WHERE judge_profile_id = $1 AND canonical_name = $2
        ORDER BY
          (cited_cluster_id IS NOT NULL) DESC,
          (cited_case_citation IS NOT NULL) DESC,
          (parenthetical IS NOT NULL) DESC,
          length(cited_case_name) DESC,
          id ASC
      `, [dupeGroup.judge_profile_id, dupeGroup.canonical_name]);

      if (groupRows.rows.length < 2) continue;

      // Keep the first (best) row, merge the rest into it
      const keeper = groupRows.rows[0];
      const losers = groupRows.rows.slice(1);

      // Merge: take the best non-null value for each optional field
      const mergedCitation     = keeper.cited_case_citation || losers.map(l => l.cited_case_citation).find(Boolean) || null;
      const mergedClusterId    = keeper.cited_cluster_id || losers.map(l => l.cited_cluster_id).find(Boolean) || null;
      const mergedParenthetical = keeper.parenthetical || losers.map(l => l.parenthetical).find(Boolean) || null;
      const mergedTreatment    = keeper.treatment || losers.map(l => l.treatment).find(Boolean) || null;
      const mergedPinCite      = keeper.pin_cite || losers.map(l => l.pin_cite).find(Boolean) || null;

      // Update keeper with merged values
      await db.query(`
        UPDATE citation_edges_internal
        SET cited_case_citation = $1,
            cited_cluster_id    = $2,
            parenthetical       = $3,
            treatment           = $4,
            pin_cite            = $5
        WHERE id = $6
      `, [mergedCitation, mergedClusterId, mergedParenthetical, mergedTreatment, mergedPinCite, keeper.id]);

      // Delete the losers
      const loserIds = losers.map(l => l.id);
      await db.query(`DELETE FROM citation_edges_internal WHERE id = ANY($1::int[])`, [loserIds]);

      state.phases[3].merged += losers.length;
      state.phases[3].processed++;

      if (state.phases[3].processed % SAVE_CHECKPOINT_EVERY === 0) {
        saveCheckpoint();
        log(`[phase3] ${state.phases[3].processed} dupe groups merged, ${state.phases[3].merged} rows removed`);
      }
    } catch (err) {
      state.phases[3].errors++;
      log(`[phase3] Error on group: ${err.message.substring(0, 100)}`);
    }
  }

  const afterCount = await db.query(`SELECT COUNT(*) FROM citation_edges_internal`);
  const after = parseInt(afterCount.rows[0].count);

  state.phases[3].status = "complete";
  saveCheckpoint();
  log(`[phase3] ✅ Complete. ${before} → ${after} edges (${before - after} duplicates merged)`);
}

// ============================================================
//  PHASE 4 — Layer 2 Motion Intelligence Re-Enrichment
//
//  Apply the 1,540-field extraction to all judge_rulings.
//  Calls motion-intelligence.js's enrich function.
// ============================================================

async function phase4_motionIntel() {
  log("===== PHASE 4: Layer 2 motion intelligence enrichment =====");
  state.current_phase = 4;
  state.phases[4].status = "running";

  if (!motionIntel) {
    log("[phase4] ⚠️ motion-intelligence.js not available, skipping");
    state.phases[4].status = "skipped_unavailable";
    saveCheckpoint();
    return;
  }

  // Check what enrich function looks like
  const enrichFn = motionIntel.enrich || motionIntel.runEnrichment || motionIntel.enrichAll;
  if (!enrichFn) {
    log("[phase4] ⚠️ No enrich function exported from motion-intelligence.js, skipping");
    state.phases[4].status = "skipped_no_export";
    saveCheckpoint();
    return;
  }

  try {
    log("[phase4] Calling motion-intelligence enrichment...");
    const result = await enrichFn({
      onProgress: (p) => {
        state.phases[4].processed = p.processed || 0;
        state.phases[4].total     = p.total || 0;
        if (p.processed && p.processed % 50 === 0) {
          saveCheckpoint();
          log(`[phase4] ${p.processed}/${p.total} rulings enriched`);
        }
      },
    });
    log(`[phase4] ✅ Complete. Result: ${JSON.stringify(result).substring(0, 200)}`);
    state.phases[4].status = "complete";
  } catch (err) {
    log(`[phase4] Error: ${err.message}`);
    state.phases[4].errors++;
    state.phases[4].status = "errored";
  }

  saveCheckpoint();
}

// ============================================================
//  PHASE 5 — Backfill judge_rulings.full_text from CourtListener
//
//  judge_rulings has cluster_id (or URL we can extract one from) but
//  no full_text — Layer 1 only stored metadata. Without full_text,
//  Phase 2 can't extract parentheticals.
//
//  Strategy:
//    1. For each ruling missing full_text, derive its cluster_id (from
//       URL like https://www.courtlistener.com/opinion/12345/...)
//    2. Fetch the cluster's sub_opinions[0]
//    3. Pull plain_text or html_with_citations and store it
// ============================================================

async function phase5_backfillFullText() {
  log("===== PHASE 5: Backfilling full opinion text from CourtListener =====");
  state.current_phase = 5;
  state.phases[5].status = "running";

  // Add cluster_id column to judge_rulings if missing
  try {
    await db.query(`ALTER TABLE judge_rulings ADD COLUMN IF NOT EXISTS cluster_id TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_rulings_cluster_id ON judge_rulings(cluster_id)`);
  } catch { /* non-fatal */ }

  // Step 5a: Extract cluster_id from URL where missing
  const extractResult = await db.query(`
    UPDATE judge_rulings
    SET cluster_id = (
      regexp_match(url, 'courtlistener\\.com/opinion/(\\d+)')
    )[1]
    WHERE cluster_id IS NULL
      AND url LIKE '%courtlistener.com/opinion/%'
  `);
  log(`[phase5a] Extracted cluster_id from URL for ${extractResult.rowCount} rulings`);

  // Step 5b: Fetch full_text for each ruling that has cluster_id but no full_text
  const countQuery = await db.query(`
    SELECT COUNT(*) FROM judge_rulings
    WHERE cluster_id IS NOT NULL
      AND (full_text IS NULL OR length(full_text) < 500)
      AND id > $1
  `, [state.phases[5].last_id]);
  state.phases[5].total = parseInt(countQuery.rows[0].count);
  log(`[phase5] ${state.phases[5].total} rulings need full_text backfill`);

  if (state.phases[5].total === 0) {
    state.phases[5].status = "complete";
    saveCheckpoint();
    return;
  }

  let lastId = state.phases[5].last_id;

  while (true) {
    if (!checkRuntimeBudget()) {
      state.phases[5].status = "paused_budget";
      saveCheckpoint();
      return;
    }

    const batch = await db.query(`
      SELECT id, cluster_id, case_name
      FROM judge_rulings
      WHERE cluster_id IS NOT NULL
        AND (full_text IS NULL OR length(full_text) < 500)
        AND id > $1
      ORDER BY id ASC
      LIMIT $2
    `, [lastId, BATCH_SIZE]);

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      try {
        // Get cluster, then fetch first sub_opinion
        const cluster = await cl.getCluster(row.cluster_id);
        await sleep(OPINION_FETCH_INTERVAL_MS);

        let fullText = null;
        if (cluster.sub_opinions && cluster.sub_opinions.length > 0) {
          // sub_opinions is an array of URLs like /api/rest/v4/opinions/12345/
          const opUrl = cluster.sub_opinions[0];
          const opIdMatch = opUrl.match(/\/opinions\/(\d+)/);
          if (opIdMatch) {
            const opinion = await cl.getOpinion(opIdMatch[1]);
            await sleep(OPINION_FETCH_INTERVAL_MS);

            // Prefer plain_text, fall back to HTML stripped, then html_with_citations
            fullText = opinion.plain_text || null;
            if (!fullText && opinion.html) {
              // Quick HTML strip
              fullText = opinion.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            }
            if (!fullText && opinion.html_with_citations) {
              fullText = opinion.html_with_citations.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            }
          }
        }

        if (fullText && fullText.length > 500) {
          await db.query(`
            UPDATE judge_rulings
            SET full_text = $1
            WHERE id = $2
          `, [fullText.substring(0, 500000), row.id]);  // 500K char cap

          state.phases[5].fetched_chars += fullText.length;
        }
      } catch (err) {
        state.phases[5].errors++;
        // Common: 404 (cluster not found), 429 (rate limit handled by client)
      }

      state.phases[5].processed++;
      state.phases[5].last_id = row.id;
      lastId = row.id;

      if (state.phases[5].processed % SAVE_CHECKPOINT_EVERY === 0) {
        saveCheckpoint();
        const mb = (state.phases[5].fetched_chars / 1024 / 1024).toFixed(1);
        log(`[phase5] ${state.phases[5].processed}/${state.phases[5].total} processed, ~${mb}MB fetched (${state.phases[5].errors} errors)`);
      }
    }
  }

  state.phases[5].status = "complete";
  saveCheckpoint();
  const mb = (state.phases[5].fetched_chars / 1024 / 1024).toFixed(1);
  log(`[phase5] ✅ Complete. Backfilled ${state.phases[5].processed} rulings (~${mb}MB), errors: ${state.phases[5].errors}`);
}

// ============================================================
//  PHASE 6 — Re-run parenthetical extraction (was Phase 2)
//
//  Now that judge_rulings.full_text is populated by Phase 5,
//  re-run the parenthetical extraction logic from Phase 2.
//  This time it actually has source text to parse.
// ============================================================

async function phase6_extractParentheticalsRerun() {
  log("===== PHASE 6: Re-extracting parentheticals with newly-backfilled text =====");
  state.current_phase = 6;
  state.phases[6].status = "running";

  // Reset Phase 2 state so the same logic runs from scratch
  state.phases[2] = { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0 };
  saveCheckpoint();

  // Borrow Phase 2's logic via direct call
  await phase2_extractParentheticals();

  // Mirror Phase 2's final state into Phase 6's slot
  state.phases[6].processed = state.phases[2].processed;
  state.phases[6].total     = state.phases[2].total;
  state.phases[6].errors    = state.phases[2].errors;
  state.phases[6].status    = state.phases[2].status === "complete" ? "complete" : state.phases[2].status;
  saveCheckpoint();

  log(`[phase6] ✅ Complete. Processed ${state.phases[6].processed}, errors: ${state.phases[6].errors}`);
}

// ============================================================
//  FINAL REPORT
// ============================================================

async function generateReport() {
  log("===== Generating final report =====");

  const stats = {};

  // Total edges + how many have what
  const stat1 = await db.query(`
    SELECT
      COUNT(*) AS total_edges,
      COUNT(*) FILTER (WHERE cited_cluster_id IS NOT NULL) AS with_cluster_id,
      COUNT(*) FILTER (WHERE parenthetical IS NOT NULL) AS with_parenthetical,
      COUNT(*) FILTER (WHERE treatment IS NOT NULL) AS with_treatment,
      COUNT(*) FILTER (WHERE pin_cite IS NOT NULL) AS with_pin_cite
    FROM citation_edges_internal
  `);
  stats.edges = stat1.rows[0];

  // Treatment breakdown
  const stat2 = await db.query(`
    SELECT treatment, COUNT(*) AS cnt
    FROM citation_edges_internal
    WHERE treatment IS NOT NULL
    GROUP BY treatment
    ORDER BY cnt DESC
  `);
  stats.treatments = stat2.rows;

  // Top judges by citations
  const stat3 = await db.query(`
    SELECT judge_name, COUNT(DISTINCT cited_normalized) AS unique_cases, COUNT(*) AS total_citations
    FROM citation_edges_internal
    GROUP BY judge_name
    ORDER BY total_citations DESC
    LIMIT 20
  `);
  stats.top_judges = stat3.rows;

  // Top cited cases
  const stat4 = await db.query(`
    SELECT cited_case_name, COUNT(*) AS times_cited, COUNT(DISTINCT judge_profile_id) AS distinct_judges
    FROM citation_edges_internal
    WHERE cited_case_name IS NOT NULL
    GROUP BY cited_case_name
    ORDER BY times_cited DESC
    LIMIT 30
  `);
  stats.top_cited_cases = stat4.rows;

  const report = {
    job_started:  state.started_at,
    job_finished: new Date().toISOString(),
    runtime_hours: ((Date.now() - STARTED_AT) / (1000 * 60 * 60)).toFixed(2),
    phases:       state.phases,
    final_stats:  stats,
  };

  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    log(`[report] ✅ Saved to ${REPORT_FILE}`);
  } catch (err) {
    log(`[report] Failed to save: ${err.message}`);
  }

  // Pretty-print summary to log
  log("");
  log("═══════════════════════════════════════════════════════");
  log("  OVERNIGHT JOB COMPLETE — SUMMARY");
  log("═══════════════════════════════════════════════════════");
  log(`Runtime: ${report.runtime_hours} hours`);
  log("");
  log("Phase status:");
  for (const [n, p] of Object.entries(state.phases)) {
    log(`  Phase ${n}: ${p.status} — processed ${p.processed}/${p.total}, errors ${p.errors}`);
  }
  log("");
  log("Final moat statistics:");
  log(`  Total edges:        ${stats.edges.total_edges}`);
  log(`  With cluster_id:    ${stats.edges.with_cluster_id}`);
  log(`  With parenthetical: ${stats.edges.with_parenthetical}`);
  log(`  With treatment:     ${stats.edges.with_treatment}`);
  log(`  With pin cite:      ${stats.edges.with_pin_cite}`);
  log("");
  log("Treatment breakdown:");
  for (const t of stats.treatments) {
    log(`  ${t.treatment.padEnd(15)}: ${t.cnt}`);
  }
  log("");
  log(`Top 5 cited cases:`);
  stats.top_cited_cases.slice(0, 5).forEach((c, i) => {
    log(`  ${i+1}. ${c.cited_case_name} (cited ${c.times_cited}x by ${c.distinct_judges} judges)`);
  });
  log("");
  log("Read full report: cat " + REPORT_FILE);
  log("═══════════════════════════════════════════════════════");

  return report;
}

// ============================================================
//  MAIN
// ============================================================

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let phasesToRun = [1, 2, 3, 4, 5, 6];
  for (const arg of args) {
    if (arg.startsWith("--phase=")) {
      phasesToRun = [parseInt(arg.split("=")[1])];
    } else if (arg.startsWith("--phases=")) {
      phasesToRun = arg.split("=")[1].split(",").map(n => parseInt(n));
    }
  }

  log(`╔══════════════════════════════════════════════════════╗`);
  log(`║  TEZ LAW OVERNIGHT MOAT ENRICHMENT JOB              ║`);
  log(`║  Phases to run: ${phasesToRun.join(", ").padEnd(34)}║`);
  log(`║  Max runtime:   ${MAX_RUNTIME_HOURS} hours${" ".repeat(36)}║`);
  log(`╚══════════════════════════════════════════════════════╝`);

  // Resume from checkpoint if exists
  const checkpoint = loadCheckpoint();
  if (checkpoint) {
    state = checkpoint;
    // Ensure phases 5 and 6 exist if checkpoint is from older version
    if (!state.phases[5]) state.phases[5] = { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0, fetched_chars: 0 };
    if (!state.phases[6]) state.phases[6] = { status: "pending", processed: 0, total: 0, errors: 0, last_id: 0 };
    log(`[init] Resumed: ${JSON.stringify(state.phases, null, 2)}`);
  } else {
    state.job_id = `overnight-${Date.now()}`;
    saveCheckpoint();
  }

  try {
    if (phasesToRun.includes(1) && state.phases[1].status !== "complete") {
      await phase1_resolveClusterIds();
    }
    if (phasesToRun.includes(2) && state.phases[2].status !== "complete") {
      await phase2_extractParentheticals();
    }
    if (phasesToRun.includes(3) && state.phases[3].status !== "complete") {
      await phase3_deduplicate();
    }
    if (phasesToRun.includes(4) && state.phases[4].status !== "complete") {
      await phase4_motionIntel();
    }
    if (phasesToRun.includes(5) && state.phases[5].status !== "complete") {
      await phase5_backfillFullText();
    }
    if (phasesToRun.includes(6) && state.phases[6].status !== "complete") {
      await phase6_extractParentheticalsRerun();
    }

    await generateReport();
  } catch (err) {
    log(`[main] FATAL ERROR: ${err.message}`);
    log(err.stack);
    saveCheckpoint();
    process.exit(1);
  }

  log("[main] ✅ Job complete. Goodnight 🌙");
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  phase1_resolveClusterIds,
  phase2_extractParentheticals,
  phase3_deduplicate,
  phase4_motionIntel,
  phase5_backfillFullText,
  phase6_extractParentheticalsRerun,
  generateReport
};
