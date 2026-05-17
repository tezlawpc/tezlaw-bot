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

// ─── Classify parenthetical treatment ──────────────────────────────────
// Mirrors the logic from overnight-enrichment.js classifyTreatment()
function classifyTreatment(parenthetical) {
  if (!parenthetical || typeof parenthetical !== "string") return null;
  const p = parenthetical.toLowerCase();

  // Constraint-valid values: positive, neutral, distinguishes, criticizes,
  // overrules, reverses, followed, cited, unknown

  // Direct quote → "cited" (the parenthetical is quoting the source case)
  if (/[\u201C"][^\u201D"]{8,}[\u201D"]/.test(parenthetical)) return "cited";
  if (/['\u2018][^'\u2019]{8,}['\u2019]/.test(parenthetical)) return "cited";

  // Strongest negative: overruling, abrogating → "overrules"
  if (/\b(overruling|overruled|abrogating|abrogated)\b/.test(p)) return "overrules";

  // Reversing (specific) → "reverses"
  if (/\b(reversing|reversed|vacating|vacated)\b/.test(p)) return "reverses";

  // General critique → "criticizes"
  if (/\b(rejecting|disagreeing with|criticizing|declining to follow|disapproving)\b/.test(p)) return "criticizes";

  // Distinguishing → "distinguishes"
  if (/\b(distinguish(ing|ed)|limit(ing|ed) to)\b/.test(p)) return "distinguishes";

  // Following / adopting → "followed"
  if (/\b(adopting|adopted|following|follows|reaffirming|reaffirmed|approving|approved)\b/.test(p)) return "followed";

  // Explanatory signals → "neutral"
  if (/\b(holding|holds|finding|finds|noting|notes|stating|states|explaining|explains|recognizing|recognizes|interpreting|interprets|construing|construes|emphasizing|emphasizes|observing|observes)\b/.test(p)) return "neutral";
  if (/\b(the\s+\w+\s+(?:requires|must|may|cannot|shall))\b/.test(p)) return "neutral";

  // Citing X for Y → "cited"
  if (/^citing\b/.test(p)) return "cited";

  // Unrecognized — let it be null rather than "unknown" to keep signal high
  return null;
}

// Whitelist of CHECK-constraint-allowed treatment values.
// Any value not in this set will be coerced to null before insert,
// so we never violate the constraint even if external code injects something.
const ALLOWED_TREATMENTS = new Set([
  "positive", "neutral", "distinguishes", "criticizes",
  "overrules", "reverses", "followed", "cited", "unknown",
]);

function sanitizeTreatment(t) {
  if (!t) return null;
  if (typeof t !== "string") return null;
  return ALLOWED_TREATMENTS.has(t) ? t : null;
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
    // eyecite returns: { type, cite, span, parenthetical, pin_cite, plaintiff, defendant, year, court, volume, reporter, page, extra }
    // Filter to actual case citations (skip statutes like "15 U.S.C. § 1125", skip "unknown" markers)
    if (cit.type !== "full_case") continue;

    const citationText = cit.cite;
    if (!citationText) continue;

    // Build case name from plaintiff + defendant
    let caseName = null;
    if (cit.plaintiff && cit.defendant) {
      caseName = `${cit.plaintiff} v. ${cit.defendant}`;
    } else if (cit.defendant) {
      caseName = cit.defendant;
    } else if (cit.plaintiff) {
      caseName = cit.plaintiff;
    } else {
      // No case name parseable — still useful as a citation reference
      caseName = citationText;
    }

    // Dedup within this ruling
    const sig = normalizeCitation(citationText) + "|" + normalizeCitation(caseName);
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);

    // Prefer eyecite's native parenthetical; fall back to Phase 7 extractor if missing
    let parenthetical = cit.parenthetical || null;
    let pin_cite = cit.pin_cite || null;
    let treatment = null;
    let signal = null;
    let span_start = cit.span ? cit.span[0] : null;
    let span_end   = cit.span ? cit.span[1] : null;

    if (!parenthetical && typeof enrich.extractParentheticalForCitation === "function") {
      try {
        const fallback = await enrich.extractParentheticalForCitation(
          ruling.full_text,
          caseName,
          citationText
        );
        if (fallback) {
          parenthetical = fallback.parenthetical || null;
          pin_cite      = pin_cite || fallback.pin_cite || null;
          treatment     = fallback.treatment || null;
          signal        = fallback.signal || null;
          span_start    = span_start ?? fallback.span_start ?? null;
          span_end      = span_end   ?? fallback.span_end   ?? null;
        }
      } catch (e) {
        // non-fatal
      }
    }

    // If we have a parenthetical but no treatment yet, classify it now
    if (parenthetical && !treatment) {
      treatment = classifyTreatment(parenthetical);
    }

    // Always sanitize — anything outside the DB CHECK whitelist becomes null
    treatment = sanitizeTreatment(treatment);

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
      parenthetical,
      pin_cite,
      treatment,
      signal,
      span_start,
      span_end,
    });

    if (parenthetical) totals.parens_extracted++;
    if (treatment)     totals.treatments_extracted++;
  }

  totals.edges_extracted += edges.length;
  if (edges.length > 0) totals.rulings_with_edges++;
  return edges;
}

// ─── Bulk insert edges (defensive) ─────────────────────────────────────
//
// Chunks edges into small batches. If a bulk INSERT fails, falls back to
// per-row INSERT for that chunk so one bad row doesn't lose the rest.
// Coerces values to safe types before binding.
function coerceValue(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === "object") {
    // span_start/end sometimes came in as Array — flatten to first element if so
    if (Array.isArray(v)) return v.length ? coerceValue(v[0]) : null;
    return null;  // any other object — treat as null
  }
  if (typeof v === "number" && !isFinite(v)) return null;
  return v;
}

async function insertOneRow(e) {
  try {
    await db.query(`
      INSERT INTO citation_edges_internal
        (ruling_id, judge_profile_id, judge_name, court, case_name,
         citation_text, cited_case_name, cited_case_citation, cited_normalized,
         parenthetical, pin_cite, treatment, signal, span_start, span_end, extracted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    `, [
      coerceValue(e.ruling_id), coerceValue(e.judge_profile_id),
      coerceValue(e.judge_name), coerceValue(e.court), coerceValue(e.case_name),
      coerceValue(e.citation_text), coerceValue(e.cited_case_name),
      coerceValue(e.cited_case_citation), coerceValue(e.cited_normalized),
      coerceValue(e.parenthetical), coerceValue(e.pin_cite),
      coerceValue(e.treatment), coerceValue(e.signal),
      coerceValue(e.span_start), coerceValue(e.span_end),
    ]);
    return 1;
  } catch (err) {
    // Single-row failure: log and skip
    totals.errors++;
    return 0;
  }
}

async function bulkInsertEdges(edges) {
  if (!edges || !edges.length) return 0;

  const CHUNK = 50;
  let inserted = 0;

  for (let i = 0; i < edges.length; i += CHUNK) {
    const chunk = edges.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;

    const cols = [
      "ruling_id", "judge_profile_id", "judge_name", "court", "case_name",
      "citation_text", "cited_case_name", "cited_case_citation", "cited_normalized",
      "parenthetical", "pin_cite", "treatment", "signal", "span_start", "span_end",
      "extracted_at",
    ];

    const placeholders = [];
    const values = [];
    let p = 1;
    for (const e of chunk) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW())`);
      values.push(
        coerceValue(e.ruling_id), coerceValue(e.judge_profile_id),
        coerceValue(e.judge_name), coerceValue(e.court), coerceValue(e.case_name),
        coerceValue(e.citation_text), coerceValue(e.cited_case_name),
        coerceValue(e.cited_case_citation), coerceValue(e.cited_normalized),
        coerceValue(e.parenthetical), coerceValue(e.pin_cite),
        coerceValue(e.treatment), coerceValue(e.signal),
        coerceValue(e.span_start), coerceValue(e.span_end)
      );
    }

    // Safety: values count must equal placeholders count exactly
    const expectedCount = chunk.length * 15;
    if (values.length !== expectedCount) {
      console.log(`[bulk] values count mismatch (${values.length} vs ${expectedCount}), falling back to per-row`);
      for (const e of chunk) inserted += await insertOneRow(e);
      continue;
    }

    try {
      const sql = `INSERT INTO citation_edges_internal (${cols.join(", ")}) VALUES ${placeholders.join(", ")}`;
      const r = await db.query(sql, values);
      inserted += r.rowCount;
    } catch (err) {
      // Bulk failed — retry the chunk one row at a time
      console.log(`[bulk] chunk failed (${err.message.substring(0, 100)}), falling back to per-row for ${chunk.length} edges`);
      for (const e of chunk) inserted += await insertOneRow(e);
    }
  }

  return inserted;
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
