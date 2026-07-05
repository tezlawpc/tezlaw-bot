// ============================================================
//  TEZ LAW P.C. — PHASE 3 FEEDBACK LOOP v1
//  ─────────────────────────────────────────────────────────
//  Zara learns from JJ's ratings on her answers.
//
//  Flow:
//    1. JJ asks question → Zara searches moat + firm docs
//    2. Zara answers, records the answer + retrieved source IDs
//    3. JJ rates: /good | /bad [reason] | /fix <correction>
//    4. Rating updates source_weights table
//    5. Future searches multiply cosine similarity by weight
//
//  Weight formula:
//    weight = 1.0 + 0.15 * (good - bad) / max(1, sqrt(total))
//    clamped to [0.3, 3.0]
//
//  Corrections stored in jj_corrections table. When a similar
//  question is asked later, the correction surfaces as "gold answer".
//
//  Safety:
//    - Weights only affect ranking, never create false relevance
//    - Cold start: new sources default weight 1.0
//    - Correction-similarity threshold guards against spurious matches
// ============================================================

const axios = require("axios");
const db    = require("./db");

const OPENAI_EMBED_MODEL = "text-embedding-3-large";

// Weight formula parameters
const WEIGHT_LEARNING_RATE = 0.15;   // how fast weights shift
const WEIGHT_MIN = 0.3;
const WEIGHT_MAX = 3.0;

// Correction retrieval params
const CORRECTION_SIMILARITY_THRESHOLD = 0.72;  // must be very similar to reuse a correction

// ── Schema ─────────────────────────────────────────────────

async function initFeedbackTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS jj_answers (
        id            SERIAL PRIMARY KEY,
        chat_id       TEXT,
        question      TEXT NOT NULL,
        question_embedding halfvec(3072),
        answer        TEXT NOT NULL,
        moat_ids      INTEGER[],
        firm_doc_ids  INTEGER[],
        rating        TEXT,             -- 'good' | 'bad' | 'corrected' | NULL
        rating_reason TEXT,
        rated_at      TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_jj_answers_chat_created
        ON jj_answers (chat_id, created_at DESC)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_jj_answers_rating
        ON jj_answers (rating) WHERE rating IS NOT NULL
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS source_weights (
        id           SERIAL PRIMARY KEY,
        source_type  TEXT NOT NULL,       -- 'moat' | 'firm'
        source_id    INTEGER NOT NULL,
        good_count   INTEGER DEFAULT 0,
        bad_count    INTEGER DEFAULT 0,
        weight       NUMERIC(4,3) DEFAULT 1.0,
        last_used    TIMESTAMPTZ,
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_type, source_id)
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_source_weights_lookup
        ON source_weights (source_type, source_id)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS jj_corrections (
        id                SERIAL PRIMARY KEY,
        answer_id         INTEGER REFERENCES jj_answers(id) ON DELETE CASCADE,
        question          TEXT NOT NULL,
        question_embedding halfvec(3072),
        original_answer   TEXT,
        corrected_answer  TEXT NOT NULL,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { if (e.code !== "23505") throw e; }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_jj_corrections_created
        ON jj_corrections (created_at DESC)
    `);
  } catch (e) { if (e.code !== "23505") throw e; }
}

// ── Helpers ────────────────────────────────────────────────

async function embedText(text) {
  const r = await axios.post(
    "https://api.openai.com/v1/embeddings",
    { input: text.substring(0, 8000), model: OPENAI_EMBED_MODEL, encoding_format: "float" },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  return r.data.data[0].embedding;
}

function computeWeight(good, bad) {
  const delta = good - bad;
  const total = good + bad;
  const scaled = WEIGHT_LEARNING_RATE * delta / Math.max(1, Math.sqrt(total));
  const raw = 1.0 + scaled;
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, raw));
}

// ── Record An Answer ───────────────────────────────────────

/**
 * Called after every substantive JJ mode answer to log the (question,
 * retrieved_source_ids, answer) triple. Returns the answer_id which JJ
 * can then rate.
 *
 * @param {object} input
 *   - chatId: string
 *   - question: string
 *   - answer: string
 *   - moatIds: number[] (citation_edges_internal ids used)
 *   - firmDocIds: number[]
 * @returns {Promise<number>} answer_id
 */
async function recordAnswer({ chatId, question, answer, moatIds = [], firmDocIds = [] }) {
  await initFeedbackTables();

  // Embed the question (cheap — one call)
  let embedding = null;
  try {
    const emb = await embedText(question);
    embedding = "[" + emb.join(",") + "]";
  } catch (e) {
    console.log("[feedback] Question embed failed (non-fatal):", e.message);
  }

  const r = await db.query(
    `INSERT INTO jj_answers (chat_id, question, question_embedding, answer, moat_ids, firm_doc_ids)
     VALUES ($1, $2, $3::halfvec, $4, $5, $6)
     RETURNING id`,
    [chatId, question, embedding, answer, moatIds, firmDocIds]
  );
  const answerId = r.rows[0].id;

  // Mark source last_used
  if (moatIds.length) {
    await db.query(
      `INSERT INTO source_weights (source_type, source_id, last_used)
       SELECT 'moat', UNNEST($1::int[]), NOW()
       ON CONFLICT (source_type, source_id) DO UPDATE SET last_used = NOW()`,
      [moatIds]
    );
  }
  if (firmDocIds.length) {
    await db.query(
      `INSERT INTO source_weights (source_type, source_id, last_used)
       SELECT 'firm', UNNEST($1::int[]), NOW()
       ON CONFLICT (source_type, source_id) DO UPDATE SET last_used = NOW()`,
      [firmDocIds]
    );
  }

  return answerId;
}

// ── Rate An Answer ─────────────────────────────────────────

/**
 * Get the most recent unrated answer for a chat.
 */
async function getLastAnswer(chatId) {
  const r = await db.query(
    `SELECT id, question, answer, moat_ids, firm_doc_ids, rating
     FROM jj_answers WHERE chat_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [chatId]
  );
  return r.rows[0] || null;
}

/**
 * Apply a rating to a specific answer, updating source weights.
 *
 * @param {number} answerId
 * @param {'good' | 'bad' | 'corrected'} rating
 * @param {string} reason (optional)
 * @returns {Promise<object>} { ok, updatedSources }
 */
async function rateAnswer(answerId, rating, reason = null) {
  const validRatings = ["good", "bad", "corrected"];
  if (!validRatings.includes(rating)) {
    return { ok: false, reason: `Invalid rating. Must be one of: ${validRatings.join(", ")}` };
  }

  const answerRow = await db.query(
    `SELECT id, moat_ids, firm_doc_ids, rating AS existing_rating FROM jj_answers WHERE id = $1`,
    [answerId]
  );
  if (!answerRow.rows.length) return { ok: false, reason: "Answer not found" };

  const existing = answerRow.rows[0].existing_rating;
  if (existing) {
    return { ok: false, reason: `Already rated: ${existing}. Use /rerate to change.` };
  }

  // Update the rating
  await db.query(
    `UPDATE jj_answers SET rating = $1, rating_reason = $2, rated_at = NOW() WHERE id = $3`,
    [rating, reason, answerId]
  );

  // Update source weights (only 'good' and 'bad' shift weights;
  // 'corrected' means JJ wrote a better answer — treated like 'bad' for source weighting)
  const isBoost = (rating === "good");
  const isDown  = (rating === "bad" || rating === "corrected");
  if (!isBoost && !isDown) return { ok: true, updatedSources: 0 };

  const column = isBoost ? "good_count" : "bad_count";

  const moatIds = answerRow.rows[0].moat_ids || [];
  const firmIds = answerRow.rows[0].firm_doc_ids || [];

  let updatedCount = 0;

  if (moatIds.length) {
    await db.query(
      `INSERT INTO source_weights (source_type, source_id, ${column}, last_used)
       SELECT 'moat', UNNEST($1::int[]), 1, NOW()
       ON CONFLICT (source_type, source_id) DO UPDATE
       SET ${column} = source_weights.${column} + 1,
           updated_at = NOW()`,
      [moatIds]
    );
    updatedCount += moatIds.length;
  }

  if (firmIds.length) {
    await db.query(
      `INSERT INTO source_weights (source_type, source_id, ${column}, last_used)
       SELECT 'firm', UNNEST($1::int[]), 1, NOW()
       ON CONFLICT (source_type, source_id) DO UPDATE
       SET ${column} = source_weights.${column} + 1,
           updated_at = NOW()`,
      [firmIds]
    );
    updatedCount += firmIds.length;
  }

  // Recompute weights for the affected rows
  const allIds = [...moatIds.map(id => ["moat", id]), ...firmIds.map(id => ["firm", id])];
  for (const [type, id] of allIds) {
    const cur = await db.query(
      `SELECT good_count, bad_count FROM source_weights
       WHERE source_type = $1 AND source_id = $2`,
      [type, id]
    );
    if (cur.rows.length) {
      const { good_count, bad_count } = cur.rows[0];
      const w = computeWeight(good_count, bad_count);
      await db.query(
        `UPDATE source_weights SET weight = $1
         WHERE source_type = $2 AND source_id = $3`,
        [w, type, id]
      );
    }
  }

  return { ok: true, updatedSources: updatedCount, rating };
}

// ── Record A Correction ────────────────────────────────────

/**
 * Store JJ's corrected version of an answer. Applied when /fix is used.
 */
async function recordCorrection(answerId, correctedAnswer) {
  const orig = await db.query(
    `SELECT question, question_embedding, answer FROM jj_answers WHERE id = $1`,
    [answerId]
  );
  if (!orig.rows.length) return { ok: false, reason: "Answer not found" };

  const { question, question_embedding, answer: originalAnswer } = orig.rows[0];

  await db.query(
    `INSERT INTO jj_corrections (answer_id, question, question_embedding, original_answer, corrected_answer)
     VALUES ($1, $2, $3::halfvec, $4, $5)`,
    [answerId, question, question_embedding, originalAnswer, correctedAnswer]
  );

  // Also treat as "corrected" rating (which demotes sources like bad)
  await rateAnswer(answerId, "corrected", "Superseded by JJ correction");

  return { ok: true };
}

// ── Weight Lookup ──────────────────────────────────────────

/**
 * Fetch a weight map for the given IDs. Used by search functions
 * to boost/demote results.
 *
 * @param {'moat' | 'firm'} sourceType
 * @param {number[]} ids
 * @returns {Promise<Map<number, number>>} — Map(sourceId → weight)
 */
async function getWeightMap(sourceType, ids) {
  if (!ids || ids.length === 0) return new Map();
  const r = await db.query(
    `SELECT source_id, weight FROM source_weights
     WHERE source_type = $1 AND source_id = ANY($2::int[])`,
    [sourceType, ids]
  );
  const map = new Map();
  for (const row of r.rows) map.set(row.source_id, parseFloat(row.weight));
  return map;
}

// ── Corrections Lookup ─────────────────────────────────────

/**
 * Given a new question, find if there's a stored correction for a very
 * similar previous question. If so, return the gold answer for use as
 * context.
 *
 * @param {string} question — the new incoming question
 * @returns {Promise<{correction: string, similarity: number, originalQuestion: string} | null>}
 */
async function findRelevantCorrection(question) {
  // Only search if there ARE corrections
  const check = await db.query(`SELECT COUNT(*) FROM jj_corrections WHERE question_embedding IS NOT NULL`);
  if (parseInt(check.rows[0].count, 10) === 0) return null;

  let qEmb;
  try {
    const arr = await embedText(question);
    qEmb = "[" + arr.join(",") + "]";
  } catch (e) {
    console.log("[feedback] correction lookup embed fail:", e.message);
    return null;
  }

  const r = await db.query(
    `SELECT question, corrected_answer, 1 - (question_embedding <=> $1::halfvec) AS similarity
     FROM jj_corrections
     WHERE question_embedding IS NOT NULL
     ORDER BY question_embedding <=> $1::halfvec
     LIMIT 1`,
    [qEmb]
  );

  if (r.rows.length === 0) return null;
  const top = r.rows[0];
  if (top.similarity < CORRECTION_SIMILARITY_THRESHOLD) return null;

  return {
    correction: top.corrected_answer,
    similarity: top.similarity,
    originalQuestion: top.question,
  };
}

// ── Stats ──────────────────────────────────────────────────

async function getFeedbackStats() {
  const answers = await db.query(`
    SELECT
      COUNT(*)                        AS total_answers,
      COUNT(*) FILTER (WHERE rating='good')      AS good_count,
      COUNT(*) FILTER (WHERE rating='bad')       AS bad_count,
      COUNT(*) FILTER (WHERE rating='corrected') AS corrected_count,
      COUNT(*) FILTER (WHERE rating IS NULL)     AS unrated_count
    FROM jj_answers
  `);

  const sources = await db.query(`
    SELECT
      source_type,
      COUNT(*) AS n,
      AVG(weight)::NUMERIC(5,3) AS avg_weight,
      MIN(weight)::NUMERIC(5,3) AS min_weight,
      MAX(weight)::NUMERIC(5,3) AS max_weight,
      COUNT(*) FILTER (WHERE weight > 1.1) AS boosted,
      COUNT(*) FILTER (WHERE weight < 0.9) AS demoted
    FROM source_weights
    GROUP BY source_type
  `);

  const corrections = await db.query(`SELECT COUNT(*) FROM jj_corrections`);

  return {
    answers: answers.rows[0],
    sources: sources.rows,
    corrections: parseInt(corrections.rows[0].count, 10),
  };
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  initFeedbackTables,
  recordAnswer,
  getLastAnswer,
  rateAnswer,
  recordCorrection,
  getWeightMap,
  findRelevantCorrection,
  getFeedbackStats,
  computeWeight,  // exposed for testing
};

// ── CLI Mode ───────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);

    if (args.includes("--init")) {
      await initFeedbackTables();
      console.log("Feedback tables initialized: jj_answers, source_weights, jj_corrections");
      process.exit(0);
    }

    if (args.includes("--stats")) {
      const s = await getFeedbackStats();
      console.log("═".repeat(50));
      console.log("  FEEDBACK LOOP STATS");
      console.log("═".repeat(50));
      console.log("\nAnswers:");
      console.log(`  Total:      ${s.answers.total_answers}`);
      console.log(`  Good:       ${s.answers.good_count}`);
      console.log(`  Bad:        ${s.answers.bad_count}`);
      console.log(`  Corrected:  ${s.answers.corrected_count}`);
      console.log(`  Unrated:    ${s.answers.unrated_count}`);
      console.log("\nSource Weights:");
      for (const row of s.sources) {
        console.log(`  ${row.source_type}:`);
        console.log(`    N: ${row.n} | avg=${row.avg_weight} | range=[${row.min_weight}, ${row.max_weight}]`);
        console.log(`    Boosted: ${row.boosted} | Demoted: ${row.demoted}`);
      }
      console.log(`\nCorrections stored: ${s.corrections}`);
      console.log("═".repeat(50));
      process.exit(0);
    }

    if (args.includes("--test-weight")) {
      // Test the weight formula with sample inputs
      const cases = [
        [0, 0], [1, 0], [3, 0], [10, 0], [50, 0],
        [0, 1], [0, 3], [0, 10],
        [5, 2], [10, 5], [3, 3],
      ];
      console.log("Weight formula test:");
      console.log("good | bad | weight");
      for (const [g, b] of cases) {
        console.log(`${String(g).padStart(4)} | ${String(b).padStart(3)} | ${computeWeight(g, b).toFixed(3)}`);
      }
      process.exit(0);
    }

    console.log(`Usage:
  node feedback-loop.js --init         Create tables
  node feedback-loop.js --stats        Show current stats
  node feedback-loop.js --test-weight  Test weight formula
`);
    process.exit(0);
  })().catch(e => {
    console.error("CLI error:", e);
    process.exit(1);
  });
}
