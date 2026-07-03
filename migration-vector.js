// ============================================================
//  migration-vector-v2.js
//  UPDATE from v1: Add halfvec column for HNSW indexing
//
//  Problem: pgvector 0.8.1 HNSW indexes have a 2000-dimension limit.
//  text-embedding-3-large is 3072 dim, so vector(3072) CAN'T be
//  HNSW-indexed. Sequential scan on 300K rows would take seconds
//  per query — too slow for JJ mode.
//
//  Solution: halfvec(3072) — 16-bit floats. HNSW supports it up to
//  4000 dimensions. Storage halved, quality loss negligible for RAG.
//
//  This migration is IDEMPOTENT and can run over the v1 result.
//  If v1 already ran and added vector(3072), we add halfvec(3072)
//  as a second column and use that for indexing.
// ============================================================

const db = require("./db");

async function run() {
  console.log("=== Level 3 RAG — Migration v2 (halfvec) ===\n");

  try {
    // Step 1: Ensure pgvector extension exists
    console.log("[1/3] Ensuring pgvector extension...");
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    const ext = await db.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'");
    console.log("  ✅ pgvector version:", ext.rows[0].extversion);

    // Step 2: Verify halfvec type exists (requires pgvector >= 0.7)
    console.log("\n[2/3] Verifying halfvec support...");
    const halfvecCheck = await db.query(`
      SELECT typname FROM pg_type WHERE typname = 'halfvec'
    `);
    if (halfvecCheck.rows.length === 0) {
      console.error("❌ halfvec type not available. Need pgvector >= 0.7");
      console.error("   Your version:", ext.rows[0].extversion);
      process.exit(1);
    }
    console.log("  ✅ halfvec available");

    // Step 3: Add halfvec column (idempotent)
    console.log("\n[3/3] Adjusting citation_edges_internal schema...");

    const cols = await db.query(`
      SELECT column_name, udt_name
      FROM information_schema.columns
      WHERE table_name = 'citation_edges_internal'
        AND column_name IN ('embedding','embedded_at')
    `);
    const has = {};
    for (const c of cols.rows) has[c.column_name] = c.udt_name;

    // Change: use halfvec(3072) from the start. If vector(3072) already exists
    // from v1, we drop it and re-add as halfvec (safe because no data yet).
    if (has.embedding === "vector") {
      console.log("  ⚠️  Found existing vector(3072) column — dropping to replace with halfvec");
      // Confirm no data in the column
      const dataCheck = await db.query("SELECT COUNT(*) AS n FROM citation_edges_internal WHERE embedding IS NOT NULL");
      const embeddedCount = parseInt(dataCheck.rows[0].n, 10);
      if (embeddedCount > 0) {
        console.error(`❌ ${embeddedCount} rows already have embeddings — cannot safely drop. Aborting.`);
        console.error("   If you want to migrate to halfvec, contact admin (Claude).");
        process.exit(1);
      }
      await db.query("ALTER TABLE citation_edges_internal DROP COLUMN embedding");
      await db.query("ALTER TABLE citation_edges_internal ADD COLUMN embedding halfvec(3072)");
      console.log("  ✅ dropped vector(3072), re-added as halfvec(3072)");
    } else if (has.embedding === "halfvec") {
      console.log("  ⏭  embedding halfvec(3072) already exists");
    } else {
      await db.query("ALTER TABLE citation_edges_internal ADD COLUMN embedding halfvec(3072)");
      console.log("  ✅ added embedding halfvec(3072) column");
    }

    if (!has.embedded_at) {
      await db.query("ALTER TABLE citation_edges_internal ADD COLUMN embedded_at TIMESTAMPTZ");
      console.log("  ✅ added embedded_at column");
    } else {
      console.log("  ⏭  embedded_at already exists");
    }

    // Recreate the partial index (drop old if exists)
    await db.query("DROP INDEX IF EXISTS idx_cei_embedded_at");
    await db.query(`
      CREATE INDEX idx_cei_embedded_at
      ON citation_edges_internal (embedded_at)
      WHERE embedded_at IS NULL
    `);
    console.log("  ✅ partial index on unembedded rows refreshed");

    // Summary
    console.log("\n=== State ===");
    const stats = await db.query(`
      SELECT
        COUNT(*) AS total_edges,
        COUNT(*) FILTER (WHERE parenthetical IS NOT NULL AND length(parenthetical) > 20) AS embeddable,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
        COUNT(*) FILTER (WHERE parenthetical IS NOT NULL AND length(parenthetical) > 20 AND embedding IS NULL) AS to_embed
      FROM citation_edges_internal
    `);
    const s = stats.rows[0];
    console.log("  Total edges:      ", s.total_edges);
    console.log("  Embeddable parens:", s.embeddable);
    console.log("  Already embedded: ", s.embedded);
    console.log("  Remaining to embed:", s.to_embed);

    console.log("\n✅ Migration v2 complete. Next: node embed-parens.js");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

run();
