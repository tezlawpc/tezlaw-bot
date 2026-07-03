// ============================================================
//  embed-parens.js — Phase B of Level 3 RAG
//
//  Embeds 311K parentheticals via OpenAI text-embedding-3-large
//  (3072 dimensions) into citation_edges_internal.embedding column.
//
//  DESIGN DECISIONS:
//
//  1. DEDUP AT SOURCE. Many parens are duplicated across rulings
//     (same "per curiam", same standard-of-review boilerplate).
//     We embed each UNIQUE paren text once, then bulk-update all
//     rows sharing that text. Roughly halves the API cost.
//
//  2. BATCH SIZE 100. OpenAI accepts arrays of inputs; batching
//     saves round-trips. 100 is well under the 8191-token limit
//     per input.
//
//  3. POSTGRES CHECKPOINT. Same pattern as Stage 2B — resumable
//     across Render redeploys. job_name = 'embed_parens:all'.
//
//  4. RATE LIMITING. OpenAI Tier 1: 5000 RPM, 5M TPM. We do ~2K
//     RPM (33/sec) which is well under. If we hit 429, exponential
//     backoff.
//
//  5. HNSW INDEX BUILT AFTER. Building HNSW on empty column is
//     instant. Building it AFTER embedding is expensive (~10 min
//     for 300K rows). We do it in a separate step to avoid slowing
//     down the pipeline.
//
//  6. NO CLAUDE. Pure OpenAI + Postgres. Cheap and fast.
//
//  RUN: node embed-parens.js
//       node embed-parens.js --limit=500    (test with 500)
//       node embed-parens.js --reset        (clear checkpoint, restart)
// ============================================================

const axios = require("axios");
const db    = require("./db");

// ── CONFIG ────────────────────────────────────────────────────
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL      = "text-embedding-3-large";  // 3072 dim
const BATCH_SIZE = 100;                        // parens per API call (reduced from 200 to fit TPM limits)
const CHECKPOINT_JOB = "embed_parens:all";
const COST_PER_1M    = 0.13;                   // $ per 1M input tokens
const MS_BETWEEN_BATCHES = 500;                // 500ms = ~120 batches/min = ~12K rows/min pace

// CLI args
const args = process.argv.slice(2);
const LIMIT = (args.find(a => a.startsWith("--limit="))?.split("=")[1]) | 0 || null;
const RESET = args.includes("--reset");

if (!OPENAI_KEY) {
  console.error("❌ OPENAI_API_KEY not set");
  process.exit(1);
}

// ── STATE ─────────────────────────────────────────────────────
let state = {
  processed: 0,
  api_calls: 0,
  cache_hits: 0,      // dedup hits — didn't need API call
  errors: 0,
  tokens_used: 0,
  cost_usd: 0,
  last_id: 0,
  started_at: new Date().toISOString(),
};

// ── CHECKPOINT ────────────────────────────────────────────────
async function loadCheckpoint() {
  try {
    const r = await db.query(
      "SELECT last_id, totals FROM cleanup_checkpoint WHERE job_name = $1",
      [CHECKPOINT_JOB]
    );
    if (r.rows.length) {
      const c = r.rows[0];
      state.last_id = parseInt(c.last_id, 10) || 0;
      if (c.totals) Object.assign(state, c.totals);
      return true;
    }
  } catch (e) { console.error("[checkpoint] load error:", e.message); }
  return false;
}

async function saveCheckpoint() {
  try {
    await db.query(`
      INSERT INTO cleanup_checkpoint (job_name, last_id, totals, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (job_name) DO UPDATE
        SET last_id = EXCLUDED.last_id,
            totals  = EXCLUDED.totals,
            updated_at = NOW()
    `, [CHECKPOINT_JOB, state.last_id, JSON.stringify(state)]);
  } catch (e) { console.error("[checkpoint] save error:", e.message); }
}

async function resetCheckpoint() {
  await db.query("DELETE FROM cleanup_checkpoint WHERE job_name = $1", [CHECKPOINT_JOB]);
  state = {
    processed: 0, api_calls: 0, cache_hits: 0, errors: 0,
    tokens_used: 0, cost_usd: 0, last_id: 0,
    started_at: new Date().toISOString(),
  };
}

// ── OPENAI CALL WITH RETRY ────────────────────────────────────
async function embedBatch(texts, retryCount = 0) {
  try {
    const r = await axios.post(
      "https://api.openai.com/v1/embeddings",
      { input: texts, model: MODEL, encoding_format: "float" },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );
    state.api_calls++;
    state.tokens_used += r.data.usage.total_tokens || 0;
    state.cost_usd = (state.tokens_used / 1e6) * COST_PER_1M;
    return r.data.data.map(d => d.embedding);
  } catch (e) {
    const status = e.response?.status;
    const retryAfterHeader = e.response?.headers?.["retry-after"];

    if ((status === 429 || (status >= 500 && status < 600)) && retryCount < 8) {
      // For 429s, respect the retry-after header if present.
      // Otherwise use slow exponential backoff (30s, 60s, 120s...)
      let backoff;
      if (retryAfterHeader) {
        backoff = parseInt(retryAfterHeader, 10) * 1000;
      } else if (status === 429) {
        // 429 = TPM/RPM limit hit → wait for the minute boundary to reset
        backoff = Math.min(120000, 30000 + retryCount * 15000);
      } else {
        // 5xx = server error → shorter backoff
        backoff = Math.min(60000, 1000 * Math.pow(2, retryCount));
      }
      console.log(`  ⏸  ${status} — retry ${retryCount + 1}/8 in ${(backoff/1000).toFixed(0)}s`);
      await new Promise(r => setTimeout(r, backoff));
      return embedBatch(texts, retryCount + 1);
    }
    throw e;
  }
}

// ── EMBEDDING FORMAT HELPERS ──────────────────────────────────
// pgvector wants the vector as string like '[0.123,0.456,...]'
function vectorToString(vec) {
  return "[" + vec.join(",") + "]";
}

// ── FETCH BATCH OF UNEMBEDDED PARENS ─────────────────────────
// Uses the partial index idx_cei_embedded_at WHERE embedded_at IS NULL
// for O(1) lookup, independent of how many rows are already embedded.
// This is critical because sibling dedup embeds rows scattered across
// the ID space, so `WHERE id > last_id` would force scanning past all
// the sibling-embedded rows.
async function fetchNextBatch() {
  const q = `
    SELECT id, parenthetical
    FROM citation_edges_internal
    WHERE embedded_at IS NULL
      AND parenthetical IS NOT NULL
      AND length(parenthetical) > 20
    ORDER BY id
    LIMIT $1
  `;
  const r = await db.query(q, [BATCH_SIZE]);
  return r.rows;
}

// ── BULK UPDATE ROWS WITH EMBEDDINGS ─────────────────────────
// For each (id, embedding) pair, UPDATE via unnest
async function saveEmbeddings(idEmbedPairs) {
  if (!idEmbedPairs.length) return;

  const ids   = idEmbedPairs.map(p => p.id);
  const vecs  = idEmbedPairs.map(p => vectorToString(p.embedding));

  await db.query(`
    UPDATE citation_edges_internal e
    SET embedding = data.emb::halfvec,
        embedded_at = NOW()
    FROM (
      SELECT UNNEST($1::int[]) AS id,
             UNNEST($2::text[]) AS emb
    ) data
    WHERE e.id = data.id
  `, [ids, vecs]);
}

// ── DEDUP + APPLY TO SIBLINGS ─────────────────────────────────
// For each unique paren text embedded, also apply the embedding to
// OTHER rows in citation_edges_internal that share the same paren text
// (this is the big cost saver — dedup at storage level, not just API).
async function applyEmbeddingToSiblings(sampleId, embeddingStr) {
  const r = await db.query(`
    WITH source AS (
      SELECT parenthetical FROM citation_edges_internal WHERE id = $1
    )
    UPDATE citation_edges_internal e
    SET embedding = $2::halfvec,
        embedded_at = NOW()
    FROM source s
    WHERE e.parenthetical = s.parenthetical
      AND e.id != $1
      AND e.embedding IS NULL
    RETURNING e.id
  `, [sampleId, embeddingStr]);
  return r.rowCount;
}

// ── FORMATTER ─────────────────────────────────────────────────
function fmtNum(n) { return n.toLocaleString(); }
function fmtPct(n, t) { return ((n / t) * 100).toFixed(1) + "%"; }

// ── MAIN LOOP ─────────────────────────────────────────────────
async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Level 3 RAG — Phase B: Embed 311K Parens");
  console.log("  Model:", MODEL, "(3072 dim)");
  console.log("  Batch size:", BATCH_SIZE);
  console.log("  Throttle:", MS_BETWEEN_BATCHES, "ms between batches");
  if (LIMIT) console.log("  Limit:", LIMIT, "(test mode)");
  console.log("═══════════════════════════════════════════════════════\n");

  if (RESET) {
    await resetCheckpoint();
    console.log("Checkpoint reset.\n");
  } else {
    const resumed = await loadCheckpoint();
    if (resumed) {
      console.log(`Resumed from checkpoint: last_id=${state.last_id}, processed=${fmtNum(state.processed)}\n`);
    } else {
      console.log("Starting fresh (no checkpoint found).\n");
    }
  }

  // Get target count
  const target = await db.query(`
    SELECT COUNT(*) AS n FROM citation_edges_internal
    WHERE parenthetical IS NOT NULL
      AND length(parenthetical) > 20
      AND embedding IS NULL
  `);
  const totalRemaining = parseInt(target.rows[0].n, 10);
  const embedLimit = LIMIT || totalRemaining;
  console.log(`Total remaining to embed: ${fmtNum(totalRemaining)}\n`);

  if (totalRemaining === 0) {
    console.log("✅ Nothing to embed. All done!");
    process.exit(0);
  }

  const start = Date.now();
  let checkpointSaveEvery = 5;  // save after every 5 batches
  let batchNum = 0;
  let printedInitial = false;

  while (true) {
    if (LIMIT && state.processed >= LIMIT) {
      console.log(`\n[limit] Reached ${LIMIT}, stopping.`);
      break;
    }

    const rows = await fetchNextBatch();
    if (!rows.length) {
      console.log("\n✅ No more rows to embed. Complete!");
      break;
    }

    batchNum++;
    const texts = rows.map(r => r.parenthetical);

    // Explicit throttle between API calls — smoother TPM usage
    if (batchNum > 1) {
      await new Promise(r => setTimeout(r, MS_BETWEEN_BATCHES));
    }

    let embeddings;
    try {
      embeddings = await embedBatch(texts);
    } catch (e) {
      state.errors++;
      console.error(`  ❌ Batch ${batchNum} failed: ${e.message}`);
      // Skip these IDs and continue
      state.last_id = rows[rows.length - 1].id;
      await saveCheckpoint();
      continue;
    }

    // Save embeddings for the primary rows
    const pairs = rows.map((r, i) => ({ id: r.id, embedding: embeddings[i] }));
    await saveEmbeddings(pairs);

    // NOTE: Sibling dedup was removed for speed.
    // The per-row UPDATE loop with WHERE parenthetical = ... was doing
    // full table scans (no index on parenthetical text). Sequential embed
    // costs ~$0.90 total (~5x more) but runs in ~15 min vs ~20 hours.
    // If we need dedup later, batch it as a post-process pass after full embed.
    let siblingCount = 0;

    state.cache_hits += siblingCount;
    state.processed += rows.length + siblingCount;
    state.last_id = rows[rows.length - 1].id;

    // Progress log
    const elapsedS = (Date.now() - start) / 1000;
    const rate = state.processed / elapsedS;
    const remaining = totalRemaining - state.processed;
    const etaS = remaining / rate;
    const etaMin = Math.round(etaS / 60);

    if (!printedInitial || batchNum % 5 === 0) {
      console.log(
        `[${new Date().toISOString().substring(11, 19)}] ` +
        `batch ${batchNum} | ` +
        `processed ${fmtNum(state.processed)} (+${rows.length} api, +${siblingCount} sibling) | ` +
        `${rate.toFixed(0)}/sec | ` +
        `ETA ${etaMin}min | ` +
        `spent $${state.cost_usd.toFixed(2)}`
      );
      printedInitial = true;
    }

    // Checkpoint save
    if (batchNum % checkpointSaveEvery === 0) {
      await saveCheckpoint();
    }
  }

  // Final save
  await saveCheckpoint();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  EMBEDDING COMPLETE");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Processed:    ${fmtNum(state.processed)} parens`);
  console.log(`  API calls:    ${fmtNum(state.api_calls)}`);
  console.log(`  Sibling hits: ${fmtNum(state.cache_hits)} (dedup savings)`);
  console.log(`  Errors:       ${state.errors}`);
  console.log(`  Tokens used:  ${fmtNum(state.tokens_used)}`);
  console.log(`  Cost:         $${state.cost_usd.toFixed(2)}`);
  console.log(`  Duration:     ${((Date.now() - start) / 60000).toFixed(1)} min`);
  console.log("═══════════════════════════════════════════════════════\n");

  console.log("Next step: node build-hnsw-index.js");
  process.exit(0);
}

run().catch(e => {
  console.error("\n❌ Fatal error:", e.message);
  console.error(e.stack);
  process.exit(1);
});
