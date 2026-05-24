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
    await initMatterManagerTables();
    await initMatterManagerV2();
    await initMatterManagerV3();
    await initMatterManagerV4();
    await initMatterManagerV5();
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
async function initWave2Tables() {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS conversation_scores (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20),
        platform_id VARCHAR(100),
        message_count INT DEFAULT 0,
        score_accuracy INT,
        score_tone INT,
        score_disclaimer INT,
        score_upl_risk VARCHAR(10),
        score_overall INT,
        summary TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sol_deadlines (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20),
        platform_id VARCHAR(100),
        client_name VARCHAR(200),
        case_type VARCHAR(100),
        incident_date DATE,
        deadline_date DATE,
        alerted_90 BOOLEAN DEFAULT FALSE,
        alerted_30 BOOLEAN DEFAULT FALSE,
        alerted_7  BOOLEAN DEFAULT FALSE,
        alerted_1  BOOLEAN DEFAULT FALSE,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS drip_campaigns (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20),
        platform_id VARCHAR(100),
        case_type VARCHAR(100),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS drip_messages (
        id SERIAL PRIMARY KEY,
        campaign_id INT REFERENCES drip_campaigns(id),
        message TEXT,
        send_at TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'pending',
        sent_at TIMESTAMPTZ
      );
    `);
    console.log("✅ Wave 2 tables ready");
  } catch (err) {
    console.error("❌ Wave 2 tables error:", err.message);
  }
}

// ============================================================
//  Matter Manager — Phase 4
//
//  Tables for tracking active legal matters with deadlines,
//  notes, and document links. Distinct from the Zara intake
//  tables above (clients, intakes, leads) which handle
//  prospective-client communication. These tables track
//  active engaged matters.
//
//  Access restricted to authenticated TEZ users only via the
//  existing admin auth layer. Cal. Rule of Professional Conduct
//  1.6 (confidentiality) and Cal. State Bar Formal Op. 2010-179
//  (cloud computing duties).
// ============================================================
async function initMatterManagerTables() {
  try {
    // Shared trigger function — auto-updates updated_at on row change.
    // CREATE OR REPLACE is idempotent.
    await getPool().query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$
    `);

    // 1. users — owners of matters; each holds their own calendar secret
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL        PRIMARY KEY,
        username        VARCHAR(50)   NOT NULL UNIQUE,
        display_name    VARCHAR(200),
        calendar_secret VARCHAR(64)   NOT NULL UNIQUE,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        updated_at      TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_secret
        ON users(calendar_secret)
    `);
    await getPool().query(`DROP TRIGGER IF EXISTS trg_users_updated_at ON users`);
    await getPool().query(`
      CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // 2. matters — active engagements
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matters (
        id                    SERIAL        PRIMARY KEY,
        user_id               INTEGER       NOT NULL
                                REFERENCES users(id) ON DELETE RESTRICT,
        client_name           VARCHAR(200)  NOT NULL,
        matter_ref            VARCHAR(100),
        matter_ref_normalized VARCHAR(100)
                                GENERATED ALWAYS AS (
                                  regexp_replace(LOWER(matter_ref), '[^a-z0-9]', '', 'g')
                                ) STORED,
        court                 VARCHAR(200),
        case_type             VARCHAR(100),
        status                VARCHAR(50)   NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'closed', 'archived')),
        dropbox_url           TEXT,
        notes                 TEXT,
        created_at            TIMESTAMPTZ   DEFAULT NOW(),
        updated_at            TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_matters_user_id ON matters(user_id)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_matters_status ON matters(status)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_matters_user_status
        ON matters(user_id, status)
    `);
    await getPool().query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_matter_ref_normalized_per_user
        ON matters(user_id, matter_ref_normalized)
        WHERE matter_ref IS NOT NULL
    `);
    await getPool().query(`DROP TRIGGER IF EXISTS trg_matters_updated_at ON matters`);
    await getPool().query(`
      CREATE TRIGGER trg_matters_updated_at
        BEFORE UPDATE ON matters
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // 3. matter_deadlines — per-matter calendar entries
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matter_deadlines (
        id          SERIAL        PRIMARY KEY,
        matter_id   INTEGER       NOT NULL
                      REFERENCES matters(id) ON DELETE CASCADE,
        title       VARCHAR(300)  NOT NULL,
        citation    VARCHAR(200),
        due_date    DATE          NOT NULL,
        party       VARCHAR(20)   NOT NULL DEFAULT 'us'
                      CHECK (party IN ('us', 'them', 'court')),
        note        TEXT,
        completed   BOOLEAN       NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ   DEFAULT NOW(),
        updated_at  TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_deadlines_matter_id
        ON matter_deadlines(matter_id)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_deadlines_due_date
        ON matter_deadlines(due_date)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_deadlines_matter_due
        ON matter_deadlines(matter_id, due_date)
    `);
    await getPool().query(`DROP TRIGGER IF EXISTS trg_deadlines_updated_at ON matter_deadlines`);
    await getPool().query(`
      CREATE TRIGGER trg_deadlines_updated_at
        BEFORE UPDATE ON matter_deadlines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // 4. matter_notes — timeline of notes per matter
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matter_notes (
        id          SERIAL        PRIMARY KEY,
        matter_id   INTEGER       NOT NULL
                      REFERENCES matters(id) ON DELETE CASCADE,
        content     TEXT          NOT NULL,
        created_at  TIMESTAMPTZ   DEFAULT NOW(),
        updated_at  TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_notes_matter_id
        ON matter_notes(matter_id)
    `);
    await getPool().query(`DROP TRIGGER IF EXISTS trg_notes_updated_at ON matter_notes`);
    await getPool().query(`
      CREATE TRIGGER trg_notes_updated_at
        BEFORE UPDATE ON matter_notes
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // 5. matter_files — document/URL links per matter
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matter_files (
        id          SERIAL        PRIMARY KEY,
        matter_id   INTEGER       NOT NULL
                      REFERENCES matters(id) ON DELETE CASCADE,
        filename    VARCHAR(500)  NOT NULL,
        url         TEXT          NOT NULL,
        created_at  TIMESTAMPTZ   DEFAULT NOW(),
        updated_at  TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_files_matter_id
        ON matter_files(matter_id)
    `);
    await getPool().query(`DROP TRIGGER IF EXISTS trg_files_updated_at ON matter_files`);
    await getPool().query(`
      CREATE TRIGGER trg_files_updated_at
        BEFORE UPDATE ON matter_files
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // Backfill: ensure JJ admin user exists with a calendar secret.
    // ON CONFLICT (username) DO NOTHING keeps existing secret if row exists.
    const crypto = require("crypto");
    const freshSecret = crypto.randomBytes(32).toString("hex");
    await getPool().query(
      `INSERT INTO users (username, display_name, calendar_secret)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING`,
      ["jj", "JJ Zhang", freshSecret]
    );

    console.log("✅ Matter manager tables ready");
  } catch (err) {
    console.error("❌ initMatterManagerTables error:", err.message);
  }
}

// ============================================================
//  Matter Manager v2 (Phase 5) — Schema Additions
//
//  Adds:
//    - 5 new columns to matters table (opened_date, triggering_date,
//      custody_location, petitioner_name, relief_sought)
//    - matter_checklists table (per-matter checklist headers)
//    - matter_checklist_items table (items within each checklist)
//
//  All operations are additive and idempotent. Uses ALTER TABLE
//  ADD COLUMN IF NOT EXISTS and CREATE TABLE IF NOT EXISTS so
//  re-runs are safe. Triggers re-use the existing set_updated_at()
//  function created by initMatterManagerTables().
//
//  No existing columns or tables are modified. Existing Lu v. Bondi
//  matter data is preserved verbatim.
// ============================================================
async function initMatterManagerV2() {
  try {
    // ────────────────────────────────────────────────────────
    //  1. New columns on matters table
    // ────────────────────────────────────────────────────────
    await getPool().query(`
      ALTER TABLE matters
        ADD COLUMN IF NOT EXISTS opened_date       DATE,
        ADD COLUMN IF NOT EXISTS triggering_date   DATE,
        ADD COLUMN IF NOT EXISTS custody_location  VARCHAR(300),
        ADD COLUMN IF NOT EXISTS petitioner_name   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS relief_sought     VARCHAR(300)
    `);

    // ────────────────────────────────────────────────────────
    //  2. matter_checklists — per-matter checklist headers
    //
    //  A matter can have multiple checklists (e.g. "Initial
    //  Filing Packet" + "Opening Brief Workplan"). Each checklist
    //  has many items (matter_checklist_items below).
    // ────────────────────────────────────────────────────────
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matter_checklists (
        id            SERIAL        PRIMARY KEY,
        matter_id     INTEGER       NOT NULL
                        REFERENCES matters(id) ON DELETE CASCADE,
        title         VARCHAR(200)  NOT NULL,
        subtitle      VARCHAR(300),
        display_order INTEGER       NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ   DEFAULT NOW(),
        updated_at    TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_checklists_matter_id
        ON matter_checklists(matter_id)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_checklists_matter_order
        ON matter_checklists(matter_id, display_order)
    `);
    await getPool().query(`DROP TRIGGER IF EXISTS trg_checklists_updated_at ON matter_checklists`);
    await getPool().query(`
      CREATE TRIGGER trg_checklists_updated_at
        BEFORE UPDATE ON matter_checklists
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // ────────────────────────────────────────────────────────
    //  3. matter_checklist_items — individual checkbox items
    //
    //  text:      "Form 3 Petition for Review prepared, signed, dated"
    //  citation:  "Cir. R. 15-4"  (optional)
    //  completed: TRUE / FALSE
    // ────────────────────────────────────────────────────────
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matter_checklist_items (
        id            SERIAL        PRIMARY KEY,
        checklist_id  INTEGER       NOT NULL
                        REFERENCES matter_checklists(id) ON DELETE CASCADE,
        text          TEXT          NOT NULL,
        citation      VARCHAR(200),
        completed     BOOLEAN       NOT NULL DEFAULT FALSE,
        display_order INTEGER       NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ   DEFAULT NOW(),
        updated_at    TIMESTAMPTZ   DEFAULT NOW()
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist_id
        ON matter_checklist_items(checklist_id)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_checklist_items_checklist_order
        ON matter_checklist_items(checklist_id, display_order)
    `);
    await getPool().query(`DROP TRIGGER IF EXISTS trg_checklist_items_updated_at ON matter_checklist_items`);
    await getPool().query(`
      CREATE TRIGGER trg_checklist_items_updated_at
        BEFORE UPDATE ON matter_checklist_items
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    console.log("✅ Matter manager v2 schema ready");
  } catch (err) {
    console.error("❌ initMatterManagerV2 error:", err.message);
  }
}

// ============================================================
//  Matter Manager v3 (Phase 5 stage 2c) — Proposal Inbox
//
//  Adds:
//    - matter_proposals table for pending NEF / order extractions
//
//  Stores deadline / field-update / new-matter proposals from
//  CM/ECF emails (or pasted text) so the UI can show a review
//  inbox before anything is written to live deadlines.
//
//  All operations additive and idempotent.
// ============================================================
async function initMatterManagerV3() {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matter_proposals (
        id              SERIAL        PRIMARY KEY,
        user_id         INTEGER       NOT NULL
                          REFERENCES users(id) ON DELETE CASCADE,
        matter_id       INTEGER
                          REFERENCES matters(id) ON DELETE SET NULL,
        kind            VARCHAR(40)   NOT NULL,
        source          VARCHAR(40)   NOT NULL DEFAULT 'manual_paste',
        source_ref      VARCHAR(200),
        proposed_data   JSONB         NOT NULL,
        raw_excerpt     TEXT,
        status          VARCHAR(20)   NOT NULL DEFAULT 'pending',
        confidence      VARCHAR(10),
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ,
        CHECK (kind IN ('deadline', 'field_update', 'new_matter')),
        CHECK (source IN ('manual_paste', 'email_inbound', 'api')),
        CHECK (status IN ('pending', 'accepted', 'dismissed'))
      )
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_proposals_user_status
        ON matter_proposals(user_id, status)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_proposals_matter_status
        ON matter_proposals(matter_id, status)
    `);
    await getPool().query(`
      CREATE INDEX IF NOT EXISTS idx_proposals_created
        ON matter_proposals(created_at DESC)
    `);

    console.log("✅ Matter manager v3 schema ready (proposals inbox)");
  } catch (err) {
    console.error("❌ initMatterManagerV3 error:", err.message);
  }
}

// ============================================================
//  Matter Manager v4 (Phase 6 — IP / USPTO support)
//
//  Adds:
//    - matters.serial_number    (USPTO serial / patent app number / copyright reg)
//    - matters.mark             (trademark text, invention title, or work title)
//    - matters.mark_format      (standard / design / sound, etc. — TM only)
//    - matters.filing_basis     ('1(a)' / '1(b)' / '44(e)' / '66(a)' — TM only)
//    - matters.intl_class       (TM class, e.g. "041")
//    - matters.owner_name       (TM/patent owner / copyright claimant)
//    - matters.owner_email      (optional, for future reminders)
//    - matter_ip_reminders     (track which ITU/SOU reminders already fired,
//                                so the daily cron doesn't re-send)
// ============================================================
async function initMatterManagerV4() {
  try {
    const additions = [
      ["serial_number", "VARCHAR(40)"],
      ["mark",          "VARCHAR(300)"],
      ["mark_format",   "VARCHAR(40)"],
      ["filing_basis",  "VARCHAR(20)"],
      ["intl_class",    "VARCHAR(40)"],
      ["owner_name",    "VARCHAR(200)"],
      ["owner_email",   "VARCHAR(200)"]
    ];
    for (const [col, type] of additions) {
      await getPool().query(
        `ALTER TABLE matters ADD COLUMN IF NOT EXISTS ${col} ${type}`
      );
    }
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS matter_ip_reminders (
        id           SERIAL PRIMARY KEY,
        matter_id    INTEGER NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
        deadline_id  INTEGER NOT NULL REFERENCES matter_deadlines(id) ON DELETE CASCADE,
        days_out     INTEGER NOT NULL,
        sent_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(deadline_id, days_out)
      )
    `);
    console.log("✅ Matter manager v4 schema ready (IP / USPTO)");
  } catch (err) {
    console.error("❌ initMatterManagerV4 error:", err.message);
  }
}

// ============================================================
//  Matter Manager v5 (Phase 7 — auto-email-ingest)
//
//  Adds:
//    - matter_proposals.message_id  (UNIQUE — dedup against duplicate forwards)
//    - inbound_email_log            (every webhook hit, accepted or rejected,
//                                     for debugging + abuse forensics)
// ============================================================
async function initMatterManagerV5() {
  try {
    // Idempotency: SendGrid passes the original email Message-ID header.
    // Two forwards of the same email = same Message-ID = dedup at the DB layer.
    // Nullable because existing rows (created via paste before v5) won't have one.
    await getPool().query(
      `ALTER TABLE matter_proposals ADD COLUMN IF NOT EXISTS message_id VARCHAR(500)`
    );
    await getPool().query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_message_id
         ON matter_proposals(message_id)
         WHERE message_id IS NOT NULL`
    );

    // Audit log: every inbound email attempt, including rejections.
    // Lets you debug "why didn't that email land in my inbox?" + spots abuse.
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS inbound_email_log (
        id              SERIAL PRIMARY KEY,
        received_at     TIMESTAMPTZ DEFAULT NOW(),
        from_email      VARCHAR(300),
        to_email        VARCHAR(300),
        subject         VARCHAR(500),
        message_id      VARCHAR(500),
        outcome         VARCHAR(40) NOT NULL,
        reason          TEXT,
        proposal_id     INTEGER REFERENCES matter_proposals(id) ON DELETE SET NULL,
        body_size       INTEGER,
        CHECK (outcome IN (
          'accepted_parsed', 'accepted_raw', 'rejected_sender', 'rejected_duplicate',
          'rejected_auth', 'rejected_empty', 'parser_error'
        ))
      )
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS idx_inbound_log_received ON inbound_email_log(received_at DESC)`
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS idx_inbound_log_outcome ON inbound_email_log(outcome, received_at DESC)`
    );

    console.log("✅ Matter manager v5 schema ready (auto-email-ingest)");
  } catch (err) {
    console.error("❌ initMatterManagerV5 error:", err.message);
  }
}

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

// ── Raw query passthrough (used by legal intelligence modules) ──
async function query(sql, params) {
  return getPool().query(sql, params);
}

module.exports = {
  initDB, getOrCreateClient, updateClient, saveMessage,
  getHistory, getClientContext, saveSummary, clearHistory,
  saveIntake, maybeAutoSummarize, saveJJMemory, getJJMemories,
  setJJSession, getJJSession, getLastMessageTime, syncIntakeToClient,
  initWave1Tables, initMatterManagerTables, initMatterManagerV2, initMatterManagerV3, initMatterManagerV4, initMatterManagerV5, logAudit, createLead, updateLeadStage,
  runConflictCheck, logUnansweredQuestion,
  query,
};
