// ============================================================
//  migration-vector.js
//  Phase A of Level 3 RAG: enable pgvector + add embedding column
//
//  This script is idempotent — safe to run multiple times.
//  Does NOT build the HNSW index yet — that comes after embedding
//  (index quality is better when built on populated data, and it
//  would take ages to build over 300K rows one-by-one during embedding).
//
//  RUN: node migration-vector.js
// ============================================================

const db = require("./db");

async function run() {
  console.log("=== Level 3 RAG — Migration ===\n");

  try {
    // Step 1: Enable pgvector extension
    console.log("[1/4] Enabling pgvector extension...");
    await db.query("CREATE EXTENSION IF NOT EXISTS vector");
    const ext = await db.query("SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'");
    console.log("  ✅ pgvector installed:", ext.rows[0]);

    // Step 2: Add embedding column if not exists
    console.log("\n[2/4] Adding embedding column to citation_edges_internal...");
    const existingCols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'citation_edges_internal'
        AND column_name IN ('embedding','embedded_at')
    `);
    const has = new Set(existingCols.rows.map(r => r.column_name));

    if (!has.has("embedding")) {
      await db.query("ALTER TABLE citation_edges_internal ADD COLUMN embedding vector(3072)");
      console.log("  ✅ embedding vector(3072) column added");
    } else {
      console.log("  ⏭  embedding column already exists");
    }

    if (!has.has("embedded_at")) {
      await db.query("ALTER TABLE citation_edges_internal ADD COLUMN embedded_at TIMESTAMPTZ");
      console.log("  ✅ embedded_at column added");
    } else {
      console.log("  ⏭  embedded_at column already exists");
    }

    // Step 3: Create supporting index on embedded_at for finding unembedded rows fast
    console.log("\n[3/4] Adding index on embedded_at (for finding unembedded rows)...");
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_cei_embedded_at
      ON citation_edges_internal (embedded_at)
      WHERE embedded_at IS NULL
    `);
    console.log("  ✅ partial index on unembedded rows created");

    // Step 4: Show state
    console.log("\n[4/4] Migration state summary:");
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

    console.log("\n✅ Migration complete. Next: node embed-parens.js");
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Migration failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

run();
