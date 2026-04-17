// ============================================================
//  db.js — Zara Memory Layer (PostgreSQL)
//  Tez Law P.C.
// ============================================================

const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

async function initDB() {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20) NOT NULL,
        platform_id VARCHAR(100) NOT NULL,
        name VARCHAR(200),
        email VARCHAR(200),
        phone VARCHAR(50),
        preferred_language VARCHAR(10) DEFAULT 'en',
        case_type VARCHAR(100),
        first_seen TIMESTAMP DEFAULT NOW(),
        last_seen TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, platform_id)
      );
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20) NOT NULL,
        platform_id VARCHAR(100) NOT NULL,
        role VARCHAR(10) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_lookup
        ON messages(platform, platform_id, created_at DESC);
    `);

    await getPool().query(`
      CREATE TABLE IF NOT EXISTS client_summaries (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20) NOT NULL,
        platform_id VARCHAR(100) NOT NULL,
        summary TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, platform_id)
      );
    `);

    // ── Intakes table (new) ────────────────────────────────
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS intakes (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20) NOT NULL,
        platform_id VARCHAR(100) NOT NULL,
        name VARCHAR(200),
        issue TEXT,
        contact VARCHAR(200),
        case_type VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── Add email/phone columns if they don't exist (migration) ──
    await getPool().query(`
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS email VARCHAR(200);
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
    `).catch(() => {});

    console.log("✅ DB tables ready");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
}

async function getOrCreateClient(platform, platformId, detectedLanguage = null) {
  try {
    const res = await getPool().query(
      `INSERT INTO clients (platform, platform_id, preferred_language, last_seen)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (platform, platform_id) DO UPDATE
         SET last_seen = NOW()
             ${detectedLanguage ? ", preferred_language = $3" : ""}
       RETURNING *`,
      detectedLanguage
        ? [platform, platformId, detectedLanguage]
        : [platform, platformId, "en"]
    );
    return res.rows[0];
  } catch (err) {
    console.error("getOrCreateClient error:", err.message);
    return null;
  }
}

async function updateClient(platform, platformId, updates = {}) {
  try {
    const fields = [];
    const values = [platform, platformId];
    let i = 3;
    if (updates.name)               { fields.push(`name = $${i++}`);               values.push(updates.name); }
    if (updates.case_type)          { fields.push(`case_type = $${i++}`);           values.push(updates.case_type); }
    if (updates.preferred_language) { fields.push(`preferred_language = $${i++}`); values.push(updates.preferred_language); }
    if (updates.email)              { fields.push(`email = $${i++}`);               values.push(updates.email); }
    if (updates.phone)              { fields.push(`phone = $${i++}`);               values.push(updates.phone); }
    if (!fields.length) return;
    await getPool().query(
      `UPDATE clients SET ${fields.join(", ")} WHERE platform=$1 AND platform_id=$2`,
      values
    );
  } catch (err) {
    console.error("updateClient error:", err.message);
  }
}

async function saveMessage(platform, platformId, role, content) {
  try {
    await getPool().query(
      `INSERT INTO messages (platform, platform_id, role, content) VALUES ($1, $2, $3, $4)`,
      [platform, platformId, role, content.substring(0, 4000)]
    );
  } catch (err) {
    console.error("saveMessage error:", err.message);
  }
}

async function getHistory(platform, platformId, limit = 10) {
  try {
    const res = await getPool().query(
      `SELECT role, content FROM (
         SELECT role, content, created_at FROM messages
         WHERE platform = $1 AND platform_id = $2
         ORDER BY created_at DESC LIMIT $3
       ) sub ORDER BY created_at ASC`,
      [platform, platformId, limit]
    );
    return res.rows;
  } catch (err) {
    console.error("getHistory error:", err.message);
    return [];
  }
}

async function getClientContext(platform, platformId) {
  try {
    const client = await getPool().query(
      `SELECT name, preferred_language, case_type, first_seen FROM clients WHERE platform=$1 AND platform_id=$2`,
      [platform, platformId]
    );
    if (!client.rows.length) return { client: null, summary: null, history: [] };
    const summaryRow = await getPool().query(
      `SELECT summary FROM client_summaries WHERE platform=$1 AND platform_id=$2`,
      [platform, platformId]
    );
    const history = await getHistory(platform, platformId, 10);
    return { client: client.rows[0], summary: summaryRow.rows[0]?.summary || null, history };
  } catch (err) {
    console.error("getClientContext error:", err.message);
    return { client: null, summary: null, history: [] };
  }
}

async function saveSummary(platform, platformId, summary) {
  try {
    await getPool().query(
      `INSERT INTO client_summaries (platform, platform_id, summary, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (platform, platform_id) DO UPDATE SET summary = $3, updated_at = NOW()`,
      [platform, platformId, summary]
    );
  } catch (err) {
    console.error("saveSummary error:", err.message);
  }
}

async function clearHistory(platform, platformId) {
  try {
    await getPool().query(`DELETE FROM messages WHERE platform=$1 AND platform_id=$2`, [platform, platformId]);
    await getPool().query(`DELETE FROM client_summaries WHERE platform=$1 AND platform_id=$2`, [platform, platformId]);
  } catch (err) {
    console.error("clearHistory error:", err.message);
  }
}

// ── Save completed intake form ───────────────────────────────
async function saveIntake(platform, platformId, data) {
  try {
    await getPool().query(
      `INSERT INTO intakes (platform, platform_id, name, issue, contact, case_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [platform, platformId, data.name, data.issue, data.contact, data.caseType || null]
    );
  } catch (err) {
    console.error("saveIntake error:", err.message);
  }
}

async function maybeAutoSummarize(platform, platformId, anthropicApiKey) {
  try {
    const countRes = await getPool().query(
      `SELECT COUNT(*) FROM messages WHERE platform=$1 AND platform_id=$2`,
      [platform, platformId]
    );
    const count = parseInt(countRes.rows[0].count);
    if (count < 25 || count % 25 !== 0) return;

    const allMsgs = await getPool().query(
      `SELECT role, content FROM messages WHERE platform=$1 AND platform_id=$2 ORDER BY created_at ASC LIMIT 30`,
      [platform, platformId]
    );
    const conversation = allMsgs.rows.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

    const axios = require("axios");
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: `Summarize this legal intake conversation in 3-4 sentences. Focus on the client's legal issue, situation, key details, and what help they need.\n\n${conversation}` }]
      },
      { headers: { "x-api-key": anthropicApiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } }
    );

    await saveSummary(platform, platformId, resp.data.content[0].text);
    await getPool().query(
      `DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE platform=$1 AND platform_id=$2 ORDER BY created_at ASC LIMIT 20)`,
      [platform, platformId]
    );
    console.log(`📝 Auto-summarized ${platform}:${platformId}`);
  } catch (err) {
    console.error("maybeAutoSummarize error:", err.message);
  }
}

module.exports = {
  initDB, getOrCreateClient, updateClient, saveMessage,
  getHistory, getClientContext, saveSummary, clearHistory,
  saveIntake, maybeAutoSummarize,
};
