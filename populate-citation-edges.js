// populate-citation-edges.js
//
// Stage 2B — Citation Edge Population
//
// Walks every ruling that has full_text but lacks edges in citation_edges_internal.
// For each, extracts citations via eyecite, then for each citation extracts the
// substantive parenthetical (if any) via the existing Phase 7 extractor.
// Bulk-inserts new edges. Idempotent + resumable via Postgres checkpoint.
//
// USAGE:
//   node populate-citation-edges.js                 # DRY RUN (no inserts)
//   node populate-citation-edges.js --commit        # APPLY
//   node populate-citation-edges.js --commit --court="9th Circuit Court of Appeals"
//   node populate-citation-edges.js --commit --limit=1000   # process N rulings
//   node populate-citation-edges.js --reset-checkpoint      # start from scratch
//
// CHECKPOINT: stored in Postgres table cleanup_checkpoint so Render redeploys
// don't lose progress.

const db = require("./db");
const enrich = require("./overnight-enrichment");

let eyecite = null;
try { eyecite = require("./eyecite-bridge"); }
catch (e) { console.error("eyecite-bridge not available:", e.message); process.exit(1); }

// ─── Args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const RESET = args.includes("--reset-checkpoint");
const courtArg = args.find(a => a.startsWith("--court="));
const COURT_FILTER = courtArg ? courtArg.split("=")[1] : null;
const limitArg = args.find(a => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1]) : Infinity;
const batchArg = args.find(a => a.startsWith("--batch="));
const BATCH_SIZE = batchArg ? parseInt(batchArg.split("=")[1]) : 100;

// ─── State ─────────────────────────────────────────────────────────────
const STARTED_AT = Date.now();
let totals = {
  rulings_scanned: 0,
  rulings_with_edges: 0,
  rulings_no_text: 0,
  rulings_no_citations: 0,
  edges_extracted: 0,
  parens_extracted: 0,
  treatments_extracted: 0,
  errors: 0,
};

// ─── Checkpoint table ──────────────────────────────────────────────────
async function ensureCheckpointTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS cleanup_checkpoint (
      job_name      TEXT PRIMARY KEY,
      last_id       BIGINT NOT NULL DEFAULT 0,
      started_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      totals        JSONB
    )
  `);
}

async function getCheckpoint(jobName) {
  const r = await db.query(`SELECT last_id, totals FROM cleanup_checkpoint WHERE job_name = $1`, [jobName]);
  return r.rows.length ? r.rows[0] : null;
}

async function saveCheckpoint(jobName, lastId, t) {
  await db.query(`
    INSERT INTO cleanup_checkpoint (job_name, last_id, totals, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (job_name) DO UPDATE SET
      last_id = EXCLUDED.last_id,
      totals = EXCLUDED.totals,
      updated_at = NOW()
  `, [jobName, lastId, JSON.stringify(t)]);
}

async function resetCheckpoint(jobName) {
  await db.query(`DELETE FROM cleanup_checkpoint WHERE job_name = $1`, [jobName]);
}

function log(msg) {
  const elapsed = ((Date.now() - STARTED_AT) / 1000).toFixed(0);
  console.log(`[${elapsed}s] ${msg}`);
}

// ─── Citation normalization ────────────────────────────────────────────
function normalizeCitation(text) {
  if (!text) return null;
  return text.replace(/\s+/g, " ")
             .replace(/[,.;]+$/, "")
             .trim()
             .toLowerCase();
}

// ─── Process a single ruling ───────────────────────────────────────────
async function processRuling(ruling) {
  if (!ruling.full_text || ruling.full_text.length < 800) {
    totals.rulings_no_text++;
    return [];
  }

  // Extract citations via eyecite
  let citations;
  try {
    citations = await eyecite.extractFullCases(ruling.full_text);
  } catch (e) {
    totals.errors++;
    return [];
  }

  if (!citations || citations.length === 0) {
    totals.rulings_no_citations++;
    return [];
  }

  const edges = [];
  const seenSignatures = new Set();

  for (const cit of citations) {
    // eyecite returns objects with: citation_text, case_name, plaintiff, defendant, year, etc.
    const citationText = cit.citation_text || cit.full_citation || cit.matched || null;
    const caseName = cit.case_name || (cit.plaintiff && cit.defendant ? `${cit.plaintiff} v. ${cit.defendant}` : null);

    if (!citationText || !caseName) continue;

    // Dedup within this ruling (same citation cited twice = one edge)
    const sig = normalizeCitation(citationText) + "|" + normalizeCitation(caseName);
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);

    // Try to extract a parenthetical for this citation
    let parenResult = null;
    try {
      parenResult = await enrich.extractParentheticalForCitation(
        ruling.full_text,
        caseName,
        citationText
      );
    } catch (e) {
      // extractor errors are non-fatal — still record the edge without paren
    }

    edges.push({
      ruling_id:           ruling.id,
      judge_profile_id:    ruling.judge_profile_id,
      judge_name:          ruling.judge_name,
      court:               ruling.court,
      case_name:           ruling.case_name,
      citation_text:       citationText,
      cited_case_name:     caseName,
      cited_case_citation: citationText,
      cited_normalized:    normalizeCitation(citationText),
      parenthetical:       parenResult?.parenthetical || null,
      pin_cite:            parenResult?.pin_cite || null,
      treatment:           parenResult?.treatment || null,
      signal:              parenResult?.signal || null,
      span_start:          parenResult?.span_start || null,
      span_end:            parenResult?.span_end || null,
    });

    if (parenResult?.parenthetical) totals.parens_extracted++;
    if (parenResult?.treatment)     totals.treatments_extracted++;
  }

  totals.edges_extracted += edges.length;
  if (edges.length > 0) totals.rulings_with_edges++;
  return edges;
}

// ─── Bulk insert edges ─────────────────────────────────────────────────
async function bulkInsertEdges(edges) {
  if (!edges.length) return 0;

  // Build VALUES clause for bulk INSERT
  const cols = [
    "ruling_id", "judge_profile_id", "judge_name", "court", "case_name",
    "citation_text", "cited_case_name", "cited_case_citation", "cited_normalized",
    "parenthetical", "pin_cite", "treatment", "signal", "span_start", "span_end",
    "extracted_at"
  ];

  const placeholders = [];
  const values = [];
  let p = 1;
  for (const e of edges) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW())`);
    values.push(
      e.ruling_id, e.judge_profile_id, e.judge_name, e.court, e.case_name,
      e.citation_text, e.cited_case_name, e.cited_case_citation, e.cited_normalized,
      e.parenthetical, e.pin_cite, e.treatment, e.signal, e.span_start, e.span_end
    );
  }

  const sql = `INSERT INTO citation_edges_internal (${cols.join(", ")}) VALUES ${placeholders.join(", ")}`;
  const r = await db.query(sql, values);
  return r.rowCount;
}

// ─── Main loop ─────────────────────────────────────────────────────────
async function main() {
  console.log("════════════════════════════════════════════════");
  console.log("  STAGE 2B — Citation Edge Population");
  console.log("  Mode:", COMMIT ? "🔥 COMMIT" : "🧪 DRY RUN");
  console.log("  Court filter:", COURT_FILTER || "all");
  console.log("  Limit:", LIMIT === Infinity ? "all" : LIMIT);
  console.log("  Batch size:", BATCH_SIZE);
  console.log("════════════════════════════════════════════════");

  await ensureCheckpointTable();

  const jobName = COURT_FILTER
    ? `populate_edges:${COURT_FILTER.replace(/\s+/g, "_")}`
    : "populate_edges:all";

  if (RESET) {
    await resetCheckpoint(jobName);
    console.log("Checkpoint reset for job:", jobName);
  }

  let cp = await getCheckpoint(jobName);
  let lastId = cp?.last_id || 0;
  if (cp?.totals) totals = { ...totals, ...cp.totals };

  if (cp) {
    log(`Resuming from checkpoint: last_id=${lastId}, prior totals: ` + JSON.stringify(cp.totals));
  } else {
    log(`Starting fresh for job: ${jobName}`);
  }

  // Quick eyecite health check
  try {
    const h = await eyecite.health();
    log(`eyecite OK: ${JSON.stringify(h).substring(0, 100)}`);
  } catch (e) {
    console.error("eyecite health check failed:", e.message);
    process.exit(1);
  }

  let processedInRun = 0;

  while (processedInRun < LIMIT) {
    // Fetch next batch of rulings NOT YET edge-populated
    // (use NOT EXISTS to find rulings without any edges in citation_edges_internal)
    const params = [lastId, BATCH_SIZE];
    let courtClause = "";
    if (COURT_FILTER) {
      params.push(COURT_FILTER);
      courtClause = `AND r.court = $${params.length}`;
    }

    const batch = await db.query(`
      SELECT r.id, r.judge_profile_id, r.judge_name, r.court, r.case_name,
             r.full_text
      FROM judge_rulings r
      WHERE r.id > $1
        ${courtClause}
        AND r.full_text IS NOT NULL
        AND length(r.full_text) >= 800
        AND NOT EXISTS (SELECT 1 FROM citation_edges_internal e WHERE e.ruling_id = r.id)
      ORDER BY r.id ASC
      LIMIT $2
    `, params);

    if (batch.rows.length === 0) {
      log("No more rulings to process.");
      break;
    }

    let batchEdges = [];
    for (const ruling of batch.rows) {
      const edges = await processRuling(ruling);
      batchEdges = batchEdges.concat(edges);
      totals.rulings_scanned++;
      processedInRun++;
      lastId = Math.max(lastId, parseInt(ruling.id));

      if (processedInRun >= LIMIT) break;
    }

    // Insert this batch's edges (or simulate in dry-run)
    if (COMMIT && batchEdges.length > 0) {
      try {
        await bulkInsertEdges(batchEdges);
      } catch (e) {
        console.error("Bulk insert error:", e.message);
        totals.errors++;
      }
    }

    // Save checkpoint after each batch
    if (COMMIT) {
      await saveCheckpoint(jobName, lastId, totals);
    }

    log(`Batch done. last_id=${lastId} | scanned=${totals.rulings_scanned} edges=${totals.edges_extracted} parens=${totals.parens_extracted} treatments=${totals.treatments_extracted}`);

    if (batch.rows.length < BATCH_SIZE) {
      log("Batch returned less than size — likely end of corpus.");
      break;
    }
  }

  console.log("");
  console.log("════════════════════════════════════════════════");
  console.log("  FINAL TOTALS");
  console.log("════════════════════════════════════════════════");
  console.log("Rulings scanned:        ", totals.rulings_scanned);
  console.log("  with edges extracted: ", totals.rulings_with_edges);
  console.log("  no text:              ", totals.rulings_no_text);
  console.log("  no citations found:   ", totals.rulings_no_citations);
  console.log("Edges extracted:        ", totals.edges_extracted);
  console.log("  with parenthetical:   ", totals.parens_extracted);
  console.log("  with treatment:       ", totals.treatments_extracted);
  console.log("Errors:                 ", totals.errors);
  console.log("Last ruling id:         ", lastId);
  console.log("Mode:                   ", COMMIT ? "✅ COMMITTED" : "🧪 DRY RUN (no inserts)");

  // Final DB stats
  const dbStats = await db.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE parenthetical IS NOT NULL) AS with_paren,
      COUNT(*) FILTER (WHERE treatment IS NOT NULL) AS with_treatment,
      COUNT(DISTINCT ruling_id) AS distinct_rulings
    FROM citation_edges_internal
  `);
  console.log("");
  console.log("citation_edges_internal current state:", dbStats.rows[0]);

  process.exit(0);
}

main().catch(e => {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
});
