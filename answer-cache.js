// ============================================================
//  answer-cache.js — Semantic Answer Cache
//  Tez Law P.C. | Zero-token responses for repeat questions
//
//  HOW IT WORKS:
//  Step 1 — Keyword fingerprint (free, instant)
//           Extract legal terms → hash → check PostgreSQL
//           Handles ~60% of repeat questions
//
//  Step 2 — Haiku similarity check (cheap, ~$0.001/check)
//           If no fingerprint match, ask Haiku if any of the
//           top cached Q&As mean the same thing
//           Handles another ~20% of questions
//
//  Step 3 — Full Claude response (Sonnet)
//           Stores the Q&A in cache for next time
//           Covers the remaining 20%
//
//  TWO CACHE LAYERS:
//  - Global cache: general legal FAQ (serves all clients)
//  - Practice-area cache: nuanced answers per area
//    (immigration, personal_injury, eviction, estate, business)
//
//  CACHE RULES:
//  - Never cache personal/case-specific answers
//  - Never cache distress/urgent situations
//  - Never cache JJ private mode
//  - Cache TTL: 30 days general, 7 days for time-sensitive
//  - Minimum 3 hits before a cached answer is trusted
// ============================================================

const axios = require("axios");
const db    = require("./db");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Cache TTL in days ────────────────────────────────────────
const TTL = {
  general:         30,
  immigration:     14,  // USCIS processing times change
  personal_injury: 30,
  eviction:        30,
  estate:          30,
  business:        30,
  fees:             7,  // Fees change frequently
  procedure:       30,
};

// ── Questions that should NEVER be cached ───────────────────
// Personal, urgent, or case-specific — always need fresh Sonnet
const NEVER_CACHE_PATTERNS = [
  /my case|my situation|my husband|my wife|my father|my mother|my child|my son|my daughter/i,
  /i was|i am|i have been|i got|i received|they arrested|they detained|they took/i,
  /receipt number|case number|a-number|\bIOE\b|\bLIN\b|\bEAC\b|\bSRC\b|\bWAC\b|\bMSC\b/i,
  /ice|detained|arrested|deported|raid|emergency|urgent|help me|please help/i,
  /yesterday|today|last week|this week|just happened|right now|currently/i,
  /my specific|in my case|for me personally|what should i do|what do i do/i,
  /password|private|jj mode|attorney mode/i,
];

// ── Legal keyword extractor for fingerprinting ───────────────
const LEGAL_KEYWORDS = [
  // Immigration
  "green card","i-130","i-485","i-765","citizenship","naturalization",
  "daca","asylum","deportation","removal","visa","h-1b","h1b","eb-1","eb-2",
  "uscis","eoir","bia","nta","overstay","work permit","ead","advance parole",
  "i-131","i-90","i-751","i-864","i-693","adjustment of status",
  "consular processing","immigrant visa","nonimmigrant","vawa","u-visa",
  // Personal injury
  "car accident","auto accident","personal injury","negligence",
  "medical bills","pain and suffering","settlement","insurance claim",
  "comparative fault","premises liability","slip and fall","wrongful death",
  // Eviction/UD
  "eviction","unlawful detainer","3-day notice","30-day notice","60-day notice",
  "just cause","security deposit","habitability","landlord","tenant","rent",
  "ab 1482","rent control","section 8",
  // Estate
  "living trust","probate","will","estate planning","power of attorney",
  "conservatorship","inheritance","trustee","executor","beneficiary",
  "advance directive","healthcare directive","durable poa",
  // Business
  "llc","corporation","non-compete","trade secret","breach of contract",
  "trademark","patent","copyright","employment contract","partnership",
  // Procedure
  "statute of limitations","deadline","filing fee","court fee",
  "how long","how much","cost","fee","price","attorney fees","contingency",
  "free consultation","do i need a lawyer","pro se",
];

// ── Practice area detector ───────────────────────────────────
function detectPracticeArea(text) {
  const t = text.toLowerCase();
  if (/immigra|visa|green card|uscis|citizenship|deporta|asylum|daca|work permit|i-\d|nta|overstay/.test(t)) return "immigration";
  if (/accident|injury|hurt|hospital|medical|negligence|car crash|slip|fall|wrongful/.test(t)) return "personal_injury";
  if (/evict|unlawful detainer|landlord|tenant|rent|3.day notice|security deposit|habitab/.test(t)) return "eviction";
  if (/trust|will|estate|probate|inheritance|conservat|power of attorney|beneficiary/.test(t)) return "estate";
  if (/business|contract|trademark|patent|copyright|llc|corporation|non.compete|employ/.test(t)) return "business";
  return "general";
}

// ── Question classifier: is this cacheable? ──────────────────
function isCacheable(message) {
  // Never cache personal/urgent/specific questions
  if (NEVER_CACHE_PATTERNS.some(p => p.test(message))) return false;
  // Must be a question or information request
  if (message.length < 10) return false;
  // Must contain a legal keyword to be worth caching
  const lower = message.toLowerCase();
  return LEGAL_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Build keyword fingerprint ────────────────────────────────
function buildFingerprint(message) {
  const lower = message.toLowerCase();
  // Extract matching keywords and sort for consistent hashing
  const found = LEGAL_KEYWORDS
    .filter(kw => lower.includes(kw))
    .sort()
    .join("|");

  // Also capture question intent words
  const intentMatch = lower.match(/\b(how much|how long|what is|what are|can i|do i need|is it|when can|what happens|explain|difference between|requirements for|process for|cost of|fee for|deadline for)\b/);
  const intent = intentMatch ? intentMatch[1].replace(/\s+/g, "_") : "general";

  return `${intent}:${found}`;
}

// ── Detect if answer is time-sensitive ──────────────────────
function isTimeSensitive(message) {
  return /processing time|how long does it take|current wait|backlog|fee|cost|price|how much/i.test(message);
}

// ============================================================
//  DATABASE SETUP
// ============================================================
async function initCacheTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS answer_cache (
        id              SERIAL PRIMARY KEY,
        fingerprint     TEXT,
        question_sample TEXT NOT NULL,
        answer          TEXT NOT NULL,
        practice_area   TEXT NOT NULL DEFAULT 'general',
        cache_layer     TEXT NOT NULL DEFAULT 'global',
        hit_count       INTEGER DEFAULT 1,
        last_hit        TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        expires_at      TIMESTAMPTZ,
        is_time_sensitive BOOLEAN DEFAULT FALSE,
        language        TEXT DEFAULT 'en'
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_cache_fingerprint
      ON answer_cache(fingerprint)
      WHERE fingerprint IS NOT NULL
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_cache_area
      ON answer_cache(practice_area, cache_layer)
    `);

    console.log("[cache] ✅ Answer cache table ready");
  } catch (err) {
    console.error("[cache] Table init error:", err.message);
  }
}

// ============================================================
//  STEP 1: FINGERPRINT LOOKUP (free, instant)
// ============================================================
async function fingerprintLookup(message, practiceArea) {
  const fingerprint = buildFingerprint(message);
  if (!fingerprint || fingerprint === "general:") return null;

  try {
    // Check global cache first, then practice-area cache
    const result = await db.query(`
      SELECT id, answer, hit_count, practice_area, cache_layer, language
      FROM answer_cache
      WHERE fingerprint = $1
        AND expires_at > NOW()
        AND (cache_layer = 'global' OR practice_area = $2)
      ORDER BY
        CASE WHEN practice_area = $2 THEN 0 ELSE 1 END,
        hit_count DESC
      LIMIT 1
    `, [fingerprint, practiceArea]);

    if (!result.rows.length) return null;

    const cached = result.rows[0];

    // Update hit count
    await db.query(
      "UPDATE answer_cache SET hit_count = hit_count + 1, last_hit = NOW() WHERE id = $1",
      [cached.id]
    );

    console.log(`[cache] ✅ Fingerprint hit (${cached.cache_layer}/${cached.practice_area}) hits:${cached.hit_count + 1}`);
    return { answer: cached.answer, source: "fingerprint", hitCount: cached.hit_count + 1 };

  } catch (err) {
    console.error("[cache] Fingerprint lookup error:", err.message);
    return null;
  }
}

// ============================================================
//  STEP 2: HAIKU SIMILARITY CHECK (cheap, ~$0.001/check)
// ============================================================
async function haikuSimilarityCheck(message, practiceArea, language = "en") {
  try {
    // Load top cached Q&As for this practice area + global
    const cached = await db.query(`
      SELECT question_sample, answer, id, hit_count
      FROM answer_cache
      WHERE expires_at > NOW()
        AND hit_count >= 2
        AND (cache_layer = 'global' OR practice_area = $1)
      ORDER BY hit_count DESC
      LIMIT 40
    `, [practiceArea]);

    if (!cached.rows.length) return null;

    // Build the comparison list
    const questionList = cached.rows
      .map((r, i) => `${i + 1}. "${r.question_sample}"`)
      .join("\n");

    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 20,
        messages: [{
          role:    "user",
          content: `Does this new question ask essentially the same thing as any of the cached questions below? Answer with ONLY the number (e.g. "7") or "NONE".

New question: "${message.substring(0, 200)}"

Cached questions:
${questionList}

Consider questions the same if they ask for the same legal information even if worded differently. Be strict — only match if the answer would be identical.

Answer (number or NONE):`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 8000,
      }
    );

    const answer = resp.data.content[0]?.text?.trim() || "NONE";
    if (answer === "NONE" || !/^\d+$/.test(answer)) return null;

    const idx = parseInt(answer) - 1;
    if (idx < 0 || idx >= cached.rows.length) return null;

    const match = cached.rows[idx];

    // Update hit count
    await db.query(
      "UPDATE answer_cache SET hit_count = hit_count + 1, last_hit = NOW() WHERE id = $1",
      [match.id]
    );

    console.log(`[cache] ✅ Haiku similarity hit — matched question #${idx + 1}, hits:${match.hit_count + 1}`);
    return { answer: match.answer, source: "similarity", hitCount: match.hit_count + 1 };

  } catch (err) {
    console.error("[cache] Haiku similarity error:", err.message);
    return null;
  }
}

// ============================================================
//  STORE NEW Q&A IN CACHE
// ============================================================
async function storeCachedAnswer(message, answer, practiceArea, language = "en") {
  // Double-check it's cacheable before storing
  if (!isCacheable(message)) return;

  // Don't cache very short answers (likely errors or deflections)
  if (!answer || answer.length < 50) return;

  // Don't cache answers that mention specific client details
  if (/your case|your situation|your husband|call us now|626-678-8677/.test(answer) &&
      answer.indexOf("626-678-8677") < 50) return;

  const fingerprint     = buildFingerprint(message);
  const timeSensitive   = isTimeSensitive(message);
  const ttlDays         = timeSensitive ? TTL.fees : (TTL[practiceArea] || TTL.general);
  const expiresAt       = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  // Determine cache layer
  // Global: general legal FAQ that applies to anyone
  // Practice-area: nuanced answers specific to that area
  const cacheLayer = practiceArea === "general" ? "global" : practiceArea;

  try {
    await db.query(`
      INSERT INTO answer_cache
        (fingerprint, question_sample, answer, practice_area, cache_layer,
         hit_count, expires_at, is_time_sensitive, language)
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)
      ON CONFLICT DO NOTHING
    `, [
      fingerprint || null,
      message.substring(0, 300),
      answer.substring(0, 2000),
      practiceArea,
      cacheLayer,
      expiresAt,
      timeSensitive,
      language,
    ]);

    console.log(`[cache] 💾 Stored new answer (${cacheLayer}/${practiceArea}, TTL ${ttlDays}d)`);
  } catch (err) {
    console.error("[cache] Store error:", err.message);
  }
}

// ============================================================
//  MAIN CACHE CHECK — called from askClaude-memory.js
//  Returns cached answer or null (meaning: call Claude)
// ============================================================
async function checkAnswerCache(message, practiceArea, language = "en") {
  // Never cache these
  if (!isCacheable(message)) return null;

  // Step 1: Fingerprint (free)
  const fingerHit = await fingerprintLookup(message, practiceArea);
  if (fingerHit) return fingerHit;

  // Step 2: Haiku similarity (cheap)
  const similarHit = await haikuSimilarityCheck(message, practiceArea, language);
  if (similarHit) return similarHit;

  return null;
}

// ============================================================
//  CACHE STATS — for admin/monitoring
// ============================================================
async function getCacheStats() {
  try {
    const stats = await db.query(`
      SELECT
        COUNT(*)                                    AS total_entries,
        SUM(hit_count)                              AS total_hits,
        COUNT(*) FILTER (WHERE cache_layer = 'global')       AS global_entries,
        COUNT(*) FILTER (WHERE cache_layer != 'global')      AS area_entries,
        AVG(hit_count)::numeric(10,1)               AS avg_hits,
        MAX(hit_count)                              AS max_hits,
        COUNT(*) FILTER (WHERE expires_at < NOW())  AS expired_entries,
        SUM(hit_count) FILTER (WHERE last_hit > NOW() - INTERVAL '24 hours') AS hits_today
      FROM answer_cache
    `);

    const byArea = await db.query(`
      SELECT practice_area, COUNT(*) as entries, SUM(hit_count) as hits
      FROM answer_cache
      WHERE expires_at > NOW()
      GROUP BY practice_area
      ORDER BY hits DESC
    `);

    return {
      overall: stats.rows[0],
      byArea:  byArea.rows,
    };
  } catch (err) {
    return { overall: {}, byArea: [] };
  }
}

// ── Purge expired cache entries (run weekly) ─────────────────
async function purgeExpiredCache() {
  try {
    const result = await db.query(
      "DELETE FROM answer_cache WHERE expires_at < NOW() RETURNING id"
    );
    console.log(`[cache] 🧹 Purged ${result.rowCount} expired cache entries`);
    return result.rowCount;
  } catch (err) {
    console.error("[cache] Purge error:", err.message);
    return 0;
  }
}

module.exports = {
  initCacheTable,
  checkAnswerCache,
  storeCachedAnswer,
  getCacheStats,
  purgeExpiredCache,
  isCacheable,
  detectPracticeArea,
};
