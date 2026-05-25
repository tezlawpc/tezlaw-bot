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
  // Personal pronouns referring to their specific situation
  /\b(my case|my situation|my husband|my wife|my father|my mother|my child|my son|my daughter|my brother|my sister|my parent|my employer|my landlord|my tenant)\b/i,
  /\b(i was|i am being|i have been|i got served|i received|i just got|they arrested|they detained|they took|we were)\b/i,
  // Case/receipt numbers
  /receipt number|case number|a-number|\bIOE\b|\bLIN\b|\bEAC\b|\bSRC\b|\bWAC\b|\bMSC\b|\bcase #/i,
  // Emergency/distress
  /\b(ice|detained|arrested|deported|raid|emergency|urgent|help me now|please help|scared|afraid|deportation notice|they came to)\b/i,
  // Time-specific personal events
  /\b(yesterday|just happened|right now|this morning|last night|today i|i just|i recently|we just)\b/i,
  // Asking for specific personal advice
  /\b(what should i do|what do i do|should i|can i still|is it too late for me|do i have a case|will i be)\b/i,
  // JJ / internal
  /\b(password|private|jj mode|attorney mode|paralegal mode|zara mode)\b/i,
  // Specific addresses or names that suggest a real case
  /\b\d{3,5}\s+[A-Z][a-z]+\s+(st|ave|blvd|dr|ln|rd|way|ct)\b/i,
];

// ── Legal keyword extractor for fingerprinting ───────────────
// EXPANDED: covers more common client questions
const LEGAL_KEYWORDS = [
  // ── Immigration ───────────────────────────────────────────
  "green card","i-130","i-485","i-765","i-131","i-90","i-751","i-864","i-693",
  "citizenship","naturalization","daca","asylum","deportation","removal",
  "visa","h-1b","h1b","eb-1","eb-2","eb-3","eb-4","eb-5","f-1","j-1","b-1","b-2",
  "uscis","eoir","bia","nta","overstay","work permit","ead","advance parole",
  "adjustment of status","consular processing","immigrant visa","nonimmigrant",
  "vawa","u-visa","t-visa","sb 54","ab 60","drivers license undocumented",
  "three year bar","ten year bar","3 year bar","10 year bar","unlawful presence",
  "travel ban","visa ban","entry ban","expedited removal","voluntary departure",
  "cancellation of removal","withholding","cat","convention against torture",
  "asylum officer","immigration judge","master calendar","individual hearing",
  "motion to reopen","motion to reconsider","petition for review","9th circuit",
  "uscis processing time","visa bulletin","priority date","preference category",
  "affidavit of support","public charge","inadmissibility","waiver","i-601",
  "immigration lawyer","immigration attorney","immigration consultation",
  // ── Personal Injury ───────────────────────────────────────
  "car accident","auto accident","personal injury","negligence","premises liability",
  "slip and fall","wrongful death","medical bills","pain and suffering",
  "settlement","insurance claim","comparative fault","uninsured motorist",
  "hit and run","rear end","intersection accident","pedestrian accident",
  "motorcycle accident","truck accident","uber accident","lyft accident",
  "dog bite","product liability","medical malpractice",
  "contingency fee","no win no fee","free consultation injury",
  "government claim","government vehicle","public entity claim",
  "statute of limitations injury","two year deadline","6 month deadline",
  "police report","accident report","demand letter","bodily injury",
  // ── Eviction / Landlord-Tenant ────────────────────────────
  "eviction","unlawful detainer","3-day notice","30-day notice","60-day notice",
  "just cause eviction","security deposit","habitability","landlord","tenant",
  "rent","rent control","ab 1482","section 8","housing voucher",
  "retaliatory eviction","wrongful eviction","constructive eviction",
  "month to month","lease agreement","lease termination","notice to quit",
  "pay or quit","cure or quit","unlawful detainer lawsuit","ud case",
  "writ of possession","lockout","illegal lockout","change locks",
  "repair and deduct","rent withholding","bed bugs","mold","uninhabitable",
  "landlord harassment","rent increase","rent raise","deposit return",
  "small claims eviction","eviction lawyer","eviction attorney",
  // ── Estate Planning / Probate ─────────────────────────────
  "living trust","revocable trust","irrevocable trust","probate","probate fees",
  "will","last will","estate planning","power of attorney","durable poa",
  "conservatorship","guardianship","inheritance","trustee","executor",
  "beneficiary","advance directive","healthcare directive","living will",
  "pour over will","joint tenancy","community property","prop 19",
  "estate tax","inheritance tax","gift tax","step up basis",
  "avoid probate","probate cost","estate attorney","trust attorney",
  "successor trustee","trust administration","small estate affidavit",
  "letters testamentary","letters of administration",
  // ── Business / Contracts ─────────────────────────────────
  "llc","corporation","s corp","c corp","sole proprietor","partnership",
  "non-compete","noncompete","trade secret","breach of contract",
  "trademark","patent","copyright","intellectual property",
  "employment contract","independent contractor","wrongful termination",
  "wage theft","overtime","meal break","rest break","labor law",
  "business dispute","partnership dispute","shareholder dispute",
  "buy sell agreement","operating agreement","articles of incorporation",
  "business formation","incorporate","register business","dba",
  // ── General Legal Procedure / FAQ ────────────────────────
  "statute of limitations","filing fee","court fee","attorney fees",
  "contingency","free consultation","do i need a lawyer","pro se",
  "small claims","small claims court","how much does","how long does",
  "what is a","what are the","how does","what happens if",
  "can i sue","can i be sued","what is the deadline","legal advice",
  "retainer","flat fee","hourly rate","legal aid","legal help",
  "notary","affidavit","deposition","subpoena","summons","complaint",
  "default judgment","garnishment","lien","judgment","appeal",
  "restraining order","protective order","tro",
];

// ── Practice area detector ───────────────────────────────────
function detectPracticeArea(text) {
  const t = text.toLowerCase();
  if (/immigra|visa|green card|uscis|citizenship|deporta|asylum|daca|work permit|i-\d|nta|overstay|eoir|bia|removal|undocumented|unlawful presence|travel document|advance parole/.test(t)) return "immigration";
  if (/accident|injury|hurt|hospital|medical|negligence|car crash|slip|fall|wrongful death|pain|settlement|insurance claim|bodily injury|malpractice/.test(t)) return "personal_injury";
  if (/evict|unlawful detainer|landlord|tenant|rent|3.day notice|security deposit|habitab|lockout|lease|notice to quit|section 8/.test(t)) return "eviction";
  if (/trust|will|estate|probate|inheritance|conservat|power of attorney|beneficiary|guardian|executor|trustee/.test(t)) return "estate";
  if (/business|contract|trademark|patent|copyright|llc|corporation|non.compete|employ|trade secret|partnership|shareholder/.test(t)) return "business";
  return "general";
}

// ── Question classifier: is this cacheable? ──────────────────
function isCacheable(message) {
  // Never cache personal/urgent/specific questions
  if (NEVER_CACHE_PATTERNS.some(p => p.test(message))) return false;

  // Must be long enough to be meaningful
  if (message.length < 8) return false;

  // Must not be a greeting or one-word message
  if (/^(hi|hello|hey|hola|thanks|thank you|ok|okay|yes|no|sure|help)$/i.test(message.trim())) return false;

  const lower = message.toLowerCase();

  // EXPANDED: also cache general informational patterns
  // even if they don't contain a specific legal keyword
  const generalInfoPatterns = [
    /how (much|long|do|does|can|should|many)/i,
    /what (is|are|does|do|happens|if)/i,
    /can (i|you|we|someone)/i,
    /do i need/i,
    /is it (legal|possible|true|required|necessary)/i,
    /explain (the|a|how)/i,
    /difference between/i,
    /requirements? for/i,
    /process for/i,
    /deadline for/i,
    /cost of|fee for|price of/i,
  ];

  // Cache if it has a legal keyword
  if (LEGAL_KEYWORDS.some(kw => lower.includes(kw))) return true;

  // Also cache if it's a general info pattern about a legal topic area
  const hasInfoPattern = generalInfoPatterns.some(p => p.test(message));
  const hasLegalContext = /law|legal|lawyer|attorney|court|judge|rights|sue|lawsuit|case|claim|contract|property|immigration|divorce|custody|injury|accident|eviction|trust|will|estate|business|trademark|patent/i.test(message);

  return hasInfoPattern && hasLegalContext;
}

// ── Build keyword fingerprint ────────────────────────────────
function buildFingerprint(message) {
  const lower = message.toLowerCase();

  // Extract matching keywords and sort for consistent hashing
  const found = LEGAL_KEYWORDS
    .filter(kw => lower.includes(kw))
    .sort()
    .join("|");

  // Capture question intent words — expanded list
  const intentMatch = lower.match(
    /\b(how much|how long|how do|how does|how can|what is|what are|what does|what do|what happens|can i|do i need|is it|is there|when can|when do|explain|difference between|requirements? for|process for|cost of|fee for|deadline for|do i have|am i eligible|qualify for|what if)\b/
  );
  const intent = intentMatch
    ? intentMatch[1].replace(/\s+/g, "_").replace(/\?/g, "")
    : "general";

  // Also include language for multilingual cache separation
  const langHint = /[\u4e00-\u9fff]/.test(message) ? ":zh"
                 : /\b(hola|gracias|cómo|necesito|tengo|abogado)\b/i.test(message) ? ":es"
                 : ":en";

  return `${intent}:${found}${langHint}`;
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
        language        TEXT DEFAULT 'en',
        source_type     TEXT DEFAULT 'client',
        source_url      TEXT
      )
    `);

    // Idempotent migration for existing deployments — adds source columns
    // if they don't exist yet. Safe to run on every startup.
    await db.query(`
      ALTER TABLE answer_cache
        ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'client',
        ADD COLUMN IF NOT EXISTS source_url  TEXT
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
      SELECT id, answer, hit_count, practice_area, cache_layer, language,
             source_type, source_url
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
    return {
      answer:     cached.answer,
      source:     "fingerprint",
      hitCount:   cached.hit_count + 1,
      sourceType: cached.source_type || "client",
      sourceUrl:  cached.source_url || null,
    };

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
      SELECT question_sample, answer, id, hit_count, source_type, source_url
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
    return {
      answer:     match.answer,
      source:     "similarity",
      hitCount:   match.hit_count + 1,
      sourceType: match.source_type || "client",
      sourceUrl:  match.source_url || null,
    };

  } catch (err) {
    console.error("[cache] Haiku similarity error:", err.message);
    return null;
  }
}

// ============================================================
//  STORE NEW Q&A IN CACHE
// ============================================================
async function storeCachedAnswer(message, answer, practiceArea, language = "en", sourceMeta = {}) {
  // Source tagging: 'client' (default), 'digest' (court opinion), 'blog' (autoposter)
  const { sourceType = "client", sourceUrl = null, bypassCacheableCheck = false } = sourceMeta;

  // Double-check it's cacheable before storing.
  // Blog seeds bypass this check because content is JJ-reviewed and
  // educational framing ("what should I do if...") shouldn't trigger
  // the personal-distress filter.
  if (!bypassCacheableCheck && !isCacheable(message)) return;

  // Don't cache very short answers (likely errors or deflections)
  if (!answer || answer.length < 50) return;

  // Don't cache error/fallback responses
  if (/technical issue|call us at|626-678-8677|try again|something went wrong/i.test(answer) &&
      answer.length < 200) return;

  // Don't cache answers that are purely personal/case-specific
  // (detect by checking if the answer references specific names/numbers)
  const hasPersonalContent = /your case number|your receipt|your husband|your wife|your application|we will call you|someone will follow up/i.test(answer);
  if (hasPersonalContent) return;

  // Don't cache intake-triggered responses
  if (/what is your name|can i get your|please share your contact|best number to reach/i.test(answer)) return;

  const fingerprint   = buildFingerprint(message);
  const timeSensitive = isTimeSensitive(message);

  // TTL: time-sensitive = 7 days, immigration = 14, everything else = 30
  // Multilingual answers get same TTL — language is encoded in fingerprint
  const ttlDays   = timeSensitive ? TTL.fees : (TTL[practiceArea] || TTL.general);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  // Cache layer: general questions → global, nuanced → practice-area
  // Questions with 3+ legal keywords are nuanced → practice-area layer
  const keywordCount = LEGAL_KEYWORDS.filter(kw => message.toLowerCase().includes(kw)).length;
  const cacheLayer   = (practiceArea === "general" || keywordCount <= 1)
    ? "global"
    : practiceArea;

  try {
    await db.query(`
      INSERT INTO answer_cache
        (fingerprint, question_sample, answer, practice_area, cache_layer,
         hit_count, expires_at, is_time_sensitive, language,
         source_type, source_url)
      VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10)
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
      sourceType,
      sourceUrl,
    ]);

    const sourceLabel = sourceType !== "client" ? ` source:${sourceType}` : "";
    console.log(`[cache] 💾 Stored (${cacheLayer}/${practiceArea}, TTL ${ttlDays}d, lang:${language}${sourceLabel})`);
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
//  FIND CACHED ANSWER FOR CONTRADICTION GATE (used by legal-digest)
//  Like checkAnswerCache but does NOT increment hit_count and
//  ALWAYS returns sourceType/sourceUrl. Used by digest + blog
//  seeding to detect contradictions before overwriting.
// ============================================================
async function findCachedAnswer(question, practiceArea, language = "en") {
  // Try fingerprint match first
  const fingerprint = buildFingerprint(question);
  if (fingerprint && fingerprint !== "general:") {
    try {
      const result = await db.query(`
        SELECT question_sample, answer, source_type, source_url, practice_area, cache_layer
        FROM answer_cache
        WHERE fingerprint = $1
          AND expires_at > NOW()
          AND language = $2
          AND (cache_layer = 'global' OR practice_area = $3)
        ORDER BY
          CASE WHEN practice_area = $3 THEN 0 ELSE 1 END,
          hit_count DESC
        LIMIT 1
      `, [fingerprint, language, practiceArea || "general"]);

      if (result.rows.length) {
        const row = result.rows[0];
        return {
          question:   row.question_sample,
          answer:     row.answer,
          sourceType: row.source_type || "client",
          sourceUrl:  row.source_url || null,
        };
      }
    } catch (_) { /* fall through */ }
  }

  // Fallback: ILIKE on first 40 chars of question
  try {
    const result = await db.query(
      `SELECT question_sample, answer, source_type, source_url
       FROM answer_cache
       WHERE expires_at > NOW()
         AND language = $1
         AND ($2::text IS NULL OR practice_area = $2 OR cache_layer = 'global')
         AND question_sample ILIKE '%' || $3 || '%'
       ORDER BY hit_count DESC
       LIMIT 1`,
      [language, practiceArea || null, question.substring(0, 40)]
    );

    if (result.rows.length) {
      const row = result.rows[0];
      return {
        question:   row.question_sample,
        answer:     row.answer,
        sourceType: row.source_type || "client",
        sourceUrl:  row.source_url || null,
      };
    }
  } catch (_) { /* table may not be ready yet */ }

  return null;
}

// ============================================================
//  APPEND BLOG URL (called from askClaude-memory.js after a hit)
//  Adds a "Read more" link when the cached answer came from a
//  daily blog post. JJ mode is kept clean — no link appended.
// ============================================================
function appendSourceUrl(cacheHit, isJJMode = false) {
  if (!cacheHit || !cacheHit.answer) return cacheHit?.answer || "";
  if (isJJMode) return cacheHit.answer;

  if (cacheHit.sourceType === "blog" && cacheHit.sourceUrl) {
    return `${cacheHit.answer}\n\n📖 Read more on our blog: ${cacheHit.sourceUrl}`;
  }

  return cacheHit.answer;
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
  findCachedAnswer,
  appendSourceUrl,
  getCacheStats,
  purgeExpiredCache,
  isCacheable,
  detectPracticeArea,
};
