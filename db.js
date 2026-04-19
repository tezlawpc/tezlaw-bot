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

    // ── Intakes table ──────────────────────────────────────
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

    // ── JJ Zhang private knowledge base (never deleted) ──
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS jj_memory (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        jj_said TEXT,
        zara_said TEXT
      );
    `);

    await initWave1Tables();
    await initWave2Tables();
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
      `SELECT name, email, phone, preferred_language, case_type, first_seen, last_seen FROM clients WHERE platform=$1 AND platform_id=$2`,
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

// ── Save completed intake form ────────────────────────────
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

// ── Save a JJ memory entry (never deleted) ───────────────
async function saveJJMemory(entry) {
  try {
    await getPool().query(
      `INSERT INTO jj_memory (timestamp, jj_said, zara_said) VALUES ($1, $2, $3)`,
      [entry.timestamp, entry.jj_said, entry.zara_said]
    );
  } catch (err) {
    console.error("saveJJMemory error:", err.message);
  }
}

// ── Get JJ memories (most recent first) ──────────────────
async function getJJMemories(limit = 50) {
  try {
    const res = await getPool().query(
      `SELECT id, timestamp, jj_said, zara_said FROM jj_memory
       WHERE jj_said NOT LIKE '_session_%'
       ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return res.rows;
  } catch (err) {
    console.error("getJJMemories error:", err.message);
    return [];
  }
}

// ── JJ Session persistence (survives Render redeploys) ────
//  Stores auth state in jj_memory using a special _session_ key.
//  No new table needed. Once authenticated, JJ stays logged in
//  across redeploys until explicitly logging out with "exit".
async function setJJSession(platform, userId, authenticated) {
  try {
    const key = `_session_${platform}_${userId}`;
    // Always delete first to avoid duplicates
    await getPool().query(`DELETE FROM jj_memory WHERE jj_said = $1`, [key]);
    if (authenticated) {
      await getPool().query(
        `INSERT INTO jj_memory (timestamp, jj_said, zara_said) VALUES ($1, $2, $3)`,
        [new Date().toISOString(), key, "authenticated"]
      );
    }
  } catch(e) {
    console.error("setJJSession error:", e.message);
  }
}

async function getJJSession(platform, userId) {
  try {
    const key = `_session_${platform}_${userId}`;
    const result = await getPool().query(
      `SELECT 1 FROM jj_memory WHERE jj_said = $1 AND zara_said = 'authenticated' LIMIT 1`,
      [key]
    );
    return result.rows.length > 0;
  } catch(e) {
    console.error("getJJSession error:", e.message);
    return false;
  }
}

// ── Get timestamp of last message (for session detection) ──
async function getLastMessageTime(platform, platformId) {
  try {
    const res = await getPool().query(
      `SELECT created_at FROM messages
       WHERE platform=$1 AND platform_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [platform, platformId]
    );
    return res.rows[0]?.created_at || null;
  } catch (err) {
    console.error("getLastMessageTime error:", err.message);
    return null;
  }
}

// ── Update client name/contact from intake completion ────
async function syncIntakeToClient(platform, platformId, data) {
  const updates = {};
  if (data.name)    updates.name = data.name;
  if (data.contact) {
    if (data.contact.includes("@")) updates.email = data.contact;
    else updates.phone = data.contact;
  }
  if (data.caseType) updates.case_type = data.caseType;
  if (Object.keys(updates).length > 0) {
    await updateClient(platform, platformId, updates);
  }
}

// ── Wave 1: Init all new tables ───────────────────────────
async function initWave1Tables() {
  try {
    // Lead pipeline
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20),
        platform_id VARCHAR(100),
        name VARCHAR(200),
        contact VARCHAR(200),
        case_type VARCHAR(100),
        stage VARCHAR(50) NOT NULL DEFAULT 'new_lead',
        notes TEXT,
        stage_changed_at TIMESTAMP DEFAULT NOW(),
        acknowledged_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
      CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
    `);

    // Escalation log for hot lead alerts
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS escalation_log (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER REFERENCES leads(id),
        level INTEGER NOT NULL,
        method VARCHAR(20) NOT NULL,
        sent_at TIMESTAMP DEFAULT NOW(),
        acknowledged_at TIMESTAMP
      );
    `);

    // Conflict checks
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS conflict_checks (
        id SERIAL PRIMARY KEY,
        intake_id INTEGER,
        platform VARCHAR(20),
        platform_id VARCHAR(100),
        search_name VARCHAR(200),
        matches JSONB,
        disposition VARCHAR(20) DEFAULT 'pending',
        checked_at TIMESTAMP DEFAULT NOW(),
        reviewed_by VARCHAR(100),
        reviewed_at TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_conflicts_disposition ON conflict_checks(disposition);
    `);

    // Unanswered questions log
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS unanswered_questions (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20),
        platform_id VARCHAR(100),
        question TEXT NOT NULL,
        zara_response TEXT,
        resolved BOOLEAN DEFAULT FALSE,
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_uq_resolved ON unanswered_questions(resolved, created_at DESC);
    `);

    // Audit log
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        actor VARCHAR(100) NOT NULL DEFAULT 'admin',
        action VARCHAR(100) NOT NULL,
        target VARCHAR(200),
        old_value TEXT,
        new_value TEXT,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
    `);

    console.log("✅ Wave 1 tables ready");
  } catch (err) {
    console.error("initWave1Tables error:", err.message);
  }
}

// ── Audit log helper ──────────────────────────────────────
async function logAudit(actor, action, target, oldValue, newValue, ip) {
  try {
    await getPool().query(
      `INSERT INTO audit_log (actor, action, target, old_value, new_value, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor, action, target || null,
       oldValue ? String(oldValue).substring(0, 2000) : null,
       newValue ? String(newValue).substring(0, 2000) : null,
       ip || null]
    );
  } catch (err) {
    console.error("logAudit error:", err.message);
  }
}

// ── Lead pipeline helpers ─────────────────────────────────
async function createLead(data) {
  try {
    const res = await getPool().query(
      `INSERT INTO leads (platform, platform_id, name, contact, case_type, stage, stage_changed_at)
       VALUES ($1, $2, $3, $4, $5, 'new_lead', NOW())
       RETURNING *`,
      [data.platform, data.platformId, data.name, data.contact, data.caseType]
    );
    return res.rows[0];
  } catch (err) {
    console.error("createLead error:", err.message);
    return null;
  }
}

async function updateLeadStage(leadId, stage, actor, ip) {
  try {
    const old = await getPool().query(`SELECT stage FROM leads WHERE id=$1`, [leadId]);
    const oldStage = old.rows[0]?.stage;
    await getPool().query(
      `UPDATE leads SET stage=$1, stage_changed_at=NOW() WHERE id=$2`,
      [stage, leadId]
    );
    await logAudit(actor || "admin", "lead_stage_change",
      `lead:${leadId}`, oldStage, stage, ip);
  } catch (err) {
    console.error("updateLeadStage error:", err.message);
  }
}

// ── Conflict check helper ─────────────────────────────────
async function runConflictCheck(intakeId, platform, platformId, name) {
  try {
    if (!name) return null;
    const nameParts = name.toLowerCase().split(/\s+/);
    const matches = [];

    // Search clients table
    const clientRes = await getPool().query(
      `SELECT platform, platform_id, name, case_type, first_seen
       FROM clients
       WHERE LOWER(name) ILIKE ANY($1)
         AND NOT (platform=$2 AND platform_id=$3)`,
      [nameParts.map(p => `%${p}%`), platform, platformId]
    );
    if (clientRes.rows.length > 0) {
      matches.push(...clientRes.rows.map(r => ({
        source: "clients", name: r.name,
        case_type: r.case_type, first_seen: r.first_seen
      })));
    }

    // Search intakes table
    const intakeRes = await getPool().query(
      `SELECT name, case_type, contact, created_at
       FROM intakes
       WHERE LOWER(name) ILIKE ANY($1)
         AND NOT (platform=$2 AND platform_id=$3)
       ORDER BY created_at DESC LIMIT 5`,
      [nameParts.map(p => `%${p}%`), platform, platformId]
    );
    if (intakeRes.rows.length > 0) {
      matches.push(...intakeRes.rows.map(r => ({
        source: "intakes", name: r.name,
        case_type: r.case_type, contact: r.contact
      })));
    }

    const disposition = matches.length > 0 ? "possible" : "cleared";
    const res = await getPool().query(
      `INSERT INTO conflict_checks
         (intake_id, platform, platform_id, search_name, matches, disposition)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [intakeId, platform, platformId, name,
       JSON.stringify(matches), disposition]
    );
    return res.rows[0];
  } catch (err) {
    console.error("runConflictCheck error:", err.message);
    return null;
  }
}

// ── Log unanswered question ───────────────────────────────
async function logUnansweredQuestion(platform, platformId, question, zaraResponse) {
  try {
    await getPool().query(
      `INSERT INTO unanswered_questions (platform, platform_id, question, zara_response)
       VALUES ($1, $2, $3, $4)`,
      [platform, platformId,
       question.substring(0, 2000),
       zaraResponse?.substring(0, 2000)]
    );
  } catch (err) {
    console.error("logUnansweredQuestion error:", err.message);
  }
}

// Save conversation score
async function saveConversationScore(platform, platformId, sessionStart, sessionEnd, msgCount, scores, summary) {
  const overall = Math.round((scores.accuracy + scores.tone + scores.disclaimer + (10 - scores.upl_risk)) / 4);
  const needsReview = overall < 6 || scores.upl_risk > 7;
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO conversation_scores
     (platform, platform_id, session_start, session_end, message_count,
      score_accuracy, score_tone, score_disclaimer, score_upl_risk, score_overall,
      needs_review, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [platform, platformId, sessionStart, sessionEnd, msgCount,
     scores.accuracy, scores.tone, scores.disclaimer, scores.upl_risk, overall,
     needsReview, summary]
  );
  return r.rows[0].id;
}

// Create SOL deadline
async function createSolDeadline(platformId, clientName, caseType, incidentDate) {
  const SOL_YEARS = {
    'personal_injury': 2, 'car_accident': 2, 'slip_and_fall': 2,
    'medical_malpractice': 3, 'wrongful_death': 2,
    'employment': 3, 'contract': 4, 'fraud': 3,
    'property_damage': 3, 'defamation': 1,
  };
  const caseKey = caseType.toLowerCase().replace(/\s+/g,'_');
  const years = SOL_YEARS[caseKey] || 2;
  const incident = new Date(incidentDate);
  const deadline = new Date(incident);
  deadline.setFullYear(deadline.getFullYear() + years);
  const pool = getPool();
  await pool.query(
    `INSERT INTO sol_deadlines (platform_id, client_name, case_type, incident_date, deadline_date)
     VALUES ($1,$2,$3,$4,$5)`,
    [platformId, clientName, caseType, incidentDate, deadline.toISOString().split('T')[0]]
  );
  return { deadline: deadline.toISOString().split('T')[0], years };
}

// Create drip campaign
async function createDripCampaign(platform, platformId, intakeId, clientName, caseType) {
  const pool = getPool();
  const r = await pool.query(
    `INSERT INTO drip_campaigns (platform, platform_id, intake_id, client_name, case_type)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [platform, platformId, intakeId, clientName, caseType]
  );
  return r.rows[0].id;
}

// Stop drip campaign
async function stopDripCampaign(platformId, reason) {
  const pool = getPool();
  await pool.query(
    `UPDATE drip_campaigns SET status='stopped', stopped_at=NOW(), stop_reason=$1
     WHERE platform_id=$2 AND status='active'`,
    [reason, platformId]
  );
}

module.exports = {
  initDB, getOrCreateClient, updateClient, saveMessage,
  getHistory, getClientContext, saveSummary, clearHistory,
  saveIntake, maybeAutoSummarize, saveJJMemory, getJJMemories,
  setJJSession, getJJSession, getLastMessageTime, syncIntakeToClient,
  initWave1Tables, logAudit, createLead, updateLeadStage,
  runConflictCheck, logUnansweredQuestion,
};
