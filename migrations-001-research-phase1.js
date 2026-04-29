// ============================================================
//  migrations/001_research_phase1.js
//  Phase 1 schema additions for the expanded Research module
//
//  Tables added:
//    - research_collections (per-matter folders)
//    - saved_cases (saved cases/statutes/forms with annotations)
//    - search_history (per-user search log)
//    - research_cache (TTL'd cache for upstream API responses)
//    - pdf_uploads (cite-checking briefs)
//    - citation_edges_internal (Layer 1 cited_cases JSONB flattened)
//
//  Run: node migrations/001_research_phase1.js
// ============================================================

const db = require("../db");

const MIGRATIONS = [
  // 1. Per-matter folders for saved research
  `CREATE TABLE IF NOT EXISTS research_collections (
    id BIGSERIAL PRIMARY KEY,
    matter_id BIGINT,
    parent_id BIGINT REFERENCES research_collections(id) ON DELETE CASCADE,
    user_id BIGINT,
    name TEXT NOT NULL,
    color TEXT DEFAULT 'gray',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_collections_matter ON research_collections(matter_id)`,

  // 2. Saved cases / statutes / forms with annotations
  `CREATE TABLE IF NOT EXISTS saved_cases (
    id BIGSERIAL PRIMARY KEY,
    collection_id BIGINT REFERENCES research_collections(id) ON DELETE CASCADE,
    matter_id BIGINT,
    user_id BIGINT,
    resource_type TEXT NOT NULL CHECK (resource_type IN
      ('case','statute','reg','uscis_pm','form','brief','external','caci','rule')),
    resource_id TEXT NOT NULL,
    cached_title TEXT,
    cached_citation TEXT,
    cached_snippet TEXT,
    cached_url TEXT,
    notes_md TEXT DEFAULT '',
    tags TEXT[] DEFAULT '{}',
    annotations JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(matter_id, resource_type, resource_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_saved_tags_gin ON saved_cases USING GIN(tags)`,
  `CREATE INDEX IF NOT EXISTS idx_saved_collection ON saved_cases(collection_id)`,

  // 3. Search history
  `CREATE TABLE IF NOT EXISTS search_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT,
    matter_id BIGINT,
    query_text TEXT NOT NULL,
    query_mode TEXT DEFAULT 'nl' CHECK (query_mode IN ('nl','boolean','citation','natural')),
    sources_searched TEXT[],
    filters JSONB DEFAULT '{}'::jsonb,
    result_count INTEGER,
    clicked_ids TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_history_user_recent ON search_history(user_id, created_at DESC)`,

  // 4. TTL'd cache for upstream API responses
  `CREATE TABLE IF NOT EXISTS research_cache (
    cache_key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    hit_count INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cache_expires ON research_cache(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cache_source ON research_cache(source)`,

  // 5. PDF uploads for cite-checking briefs
  `CREATE TABLE IF NOT EXISTS pdf_uploads (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT,
    matter_id BIGINT,
    original_filename TEXT NOT NULL,
    storage_url TEXT,
    bytes INTEGER,
    pages INTEGER,
    extracted_text TEXT,
    extraction_status TEXT DEFAULT 'pending'
      CHECK (extraction_status IN ('pending','processing','done','failed')),
    citations_found JSONB DEFAULT '[]'::jsonb,
    citation_summary JSONB DEFAULT '{}'::jsonb,
    error_message TEXT,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pdf_user ON pdf_uploads(user_id, uploaded_at DESC)`,

  // 6. Internal citation edges (the MOAT — flattened from judge_rulings.cited_cases)
  `CREATE TABLE IF NOT EXISTS citation_edges_internal (
    id BIGSERIAL PRIMARY KEY,
    ruling_id BIGINT REFERENCES judge_rulings(id) ON DELETE CASCADE,
    judge_profile_id INTEGER REFERENCES judge_profiles(id) ON DELETE CASCADE,
    judge_name TEXT NOT NULL,
    court TEXT,
    case_name TEXT,
    citation_text TEXT,
    cited_case_name TEXT,
    cited_case_citation TEXT,
    cited_normalized TEXT,
    cited_cluster_id TEXT,
    parenthetical TEXT,
    pin_cite TEXT,
    treatment TEXT CHECK (treatment IS NULL OR treatment IN
      ('positive','neutral','distinguishes','criticizes','overrules','reverses','followed','cited','unknown')),
    signal TEXT,
    span_start INTEGER,
    span_end INTEGER,
    extracted_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cei_judge ON citation_edges_internal(judge_profile_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cei_cited_norm ON citation_edges_internal(cited_normalized)`,
  `CREATE INDEX IF NOT EXISTS idx_cei_cited_cluster ON citation_edges_internal(cited_cluster_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cei_treatment ON citation_edges_internal(treatment) WHERE treatment IN ('overrules','reverses','criticizes','distinguishes')`,
];

(async () => {
  console.log("[migration 001] Running Phase 1 research schema migration...");
  let success = 0, failed = 0;

  for (const stmt of MIGRATIONS) {
    const preview = stmt.substring(0, 60).replace(/\s+/g, " ");
    try {
      await db.query(stmt);
      console.log(`✅ ${preview}...`);
      success++;
    } catch (err) {
      console.error(`❌ ${preview}...`);
      console.error(`   ${err.message}`);
      failed++;
    }
  }

  console.log(`\n[migration 001] Complete. ${success} succeeded, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
})();
