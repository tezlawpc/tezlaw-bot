// ============================================================
//  TEZ LAW P.C. — AI AUDIT TRAIL
//  ─────────────────────────────────────────────────────────
//  Immutable record of every AI-generated output across Zara.
//  Purpose:
//   1. Malpractice insurance compliance
//   2. CA Bar complaint defense
//   3. Client transparency
//   4. Internal quality tracking
//
//  What gets logged:
//   - The exact AI output (never modified after creation)
//   - SHA-256 content hash (tamper detection)
//   - Which attorney reviewed it, when, from what IP
//   - Edits made vs original (with unified diff)
//   - Delivery confirmation (to whom, when, via what channel)
//   - Cost + model + tokens (for cost audits + risk analysis)
//
//  Retention: 7 years per CA RPC 1.15 (client file retention rule).
//
//  Integration pattern for other modules:
//    const audit = require("./ai-audit-trail");
//    const auditId = await audit.log({
//      feature_type: "closing_argument",
//      client_key: "...", client_name: "...", a_number: "...",
//      related_id: closing.id, related_table: "closing_arguments",
//      model_used: "claude-sonnet-4-6",
//      original_output: "...", input_context_summary: "...",
//      input_tokens: 5000, output_tokens: 2500, estimated_cost_usd: 0.075,
//      source_module: "closing-argument-generator.js",
//      generated_by: req.user.id,
//    });
//
//  Later when attorney reviews:
//    await audit.markReviewed(auditId, { userId, notes, editedVersion });
//
//  Later when delivered:
//    await audit.markDelivered(auditId, { deliveredTo, deliveredVia, deliveredBy });
// ============================================================

const crypto = require("crypto");
const db = require("./db");

// ─── Schema ─────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_audit_trail (
      id                    SERIAL PRIMARY KEY,

      -- What was generated
      feature_type          TEXT NOT NULL,        -- closing_argument, motion, intake_extraction, notice_scan, voice_dictation, etc.
      source_module         TEXT,                 -- which .js file produced it
      related_table         TEXT,                 -- table where feature-specific record lives
      related_id            INTEGER,              -- primary key in related_table

      -- Client context
      client_key            TEXT,
      client_name           TEXT,
      a_number              TEXT,
      matter_type           TEXT,                 -- asylum, PI, UD, etc.

      -- The AI output (IMMUTABLE — never edited after insert)
      original_output       TEXT NOT NULL,
      original_hash         TEXT NOT NULL,        -- SHA-256 of original_output (tamper detection)
      input_context_summary TEXT,                 -- brief description of what was fed in
      input_context_hash    TEXT,                 -- SHA-256 of the full input (for reproducibility)

      -- Model metadata
      model_used            TEXT,
      input_tokens          INTEGER,
      output_tokens         INTEGER,
      estimated_cost_usd    NUMERIC(10, 4),

      -- Who created it
      generated_by          INTEGER,              -- admin_users.id who triggered generation
      generated_at          TIMESTAMPTZ DEFAULT NOW(),
      generated_from_ip     TEXT,

      -- Review workflow
      status                TEXT DEFAULT 'unreviewed',  -- unreviewed | reviewed | approved | delivered | withdrawn | flagged
      reviewed_by           INTEGER,              -- admin_users.id who reviewed
      reviewed_at           TIMESTAMPTZ,
      reviewed_from_ip      TEXT,
      reviewer_notes        TEXT,

      -- What actually got used (may differ from original after attorney edits)
      final_version         TEXT,                 -- edited version if attorney changed it
      edit_diff             TEXT,                 -- unified diff between original and final
      edit_char_delta       INTEGER,              -- signed number of characters changed

      -- Delivery record
      delivered_at          TIMESTAMPTZ,
      delivered_by          INTEGER,
      delivered_to          TEXT,                 -- recipient (client email, court name, etc.)
      delivered_via         TEXT,                 -- email | in-court | mail | client-portal | sms | whatsapp | filed
      delivery_confirmation TEXT,                 -- tracking number, message ID, etc.

      -- Risk/compliance flags
      bar_complaint_related BOOLEAN DEFAULT FALSE,
      malpractice_flag      BOOLEAN DEFAULT FALSE,
      flag_reason           TEXT,
      flagged_by            INTEGER,
      flagged_at            TIMESTAMPTZ,

      -- Metadata
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migrations for existing installations
  const alters = [
    "ADD COLUMN IF NOT EXISTS matter_type TEXT",
    "ADD COLUMN IF NOT EXISTS bar_complaint_related BOOLEAN DEFAULT FALSE",
    "ADD COLUMN IF NOT EXISTS malpractice_flag BOOLEAN DEFAULT FALSE",
    "ADD COLUMN IF NOT EXISTS flagged_by INTEGER",
    "ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ",
    "ADD COLUMN IF NOT EXISTS delivery_confirmation TEXT",
  ];
  for (const alter of alters) {
    try { await db.query(`ALTER TABLE ai_audit_trail ${alter}`); } catch {}
  }

  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_client ON ai_audit_trail (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_a_number ON ai_audit_trail (a_number)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_feature ON ai_audit_trail (feature_type)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_status ON ai_audit_trail (status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_generated_at ON ai_audit_trail (generated_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_flags ON ai_audit_trail (bar_complaint_related, malpractice_flag) WHERE bar_complaint_related OR malpractice_flag`);
}

// ─── Helpers ─────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

// Simple unified-diff style change summary (not full diff, but shows char delta)
function computeEditDiff(original, edited) {
  if (!original || !edited) return null;
  const origLen = original.length;
  const editLen = edited.length;
  const charDelta = editLen - origLen;

  // Line-level diff — for each line in edited that isn't in original, mark +
  const origLines = new Set(original.split("\n").map(l => l.trim()).filter(Boolean));
  const editLines = edited.split("\n");
  const added = editLines.filter(l => l.trim() && !origLines.has(l.trim()));

  const editLinesSet = new Set(editLines.map(l => l.trim()).filter(Boolean));
  const removed = original.split("\n").filter(l => l.trim() && !editLinesSet.has(l.trim()));

  return {
    char_delta: charDelta,
    lines_added: added.length,
    lines_removed: removed.length,
    summary: `${charDelta >= 0 ? "+" : ""}${charDelta} chars, ${added.length} lines added, ${removed.length} lines removed`,
  };
}

// ─── Public API ─────────────────────────────────────────

// Log a new AI output. Returns the audit trail ID.
async function log({
  feature_type,
  source_module = null,
  related_table = null,
  related_id = null,
  client_key = null,
  client_name = null,
  a_number = null,
  matter_type = null,
  original_output,
  input_context_summary = null,
  input_context_full = null,        // full input, used to compute input_context_hash
  model_used = null,
  input_tokens = null,
  output_tokens = null,
  estimated_cost_usd = null,
  generated_by = null,
  generated_from_ip = null,
}) {
  if (!feature_type) throw new Error("audit.log: feature_type required");
  if (!original_output) throw new Error("audit.log: original_output required");

  await initTable();

  const originalHash = sha256(original_output);
  const inputContextHash = input_context_full ? sha256(input_context_full) : null;

  const r = await db.query(
    `INSERT INTO ai_audit_trail
       (feature_type, source_module, related_table, related_id,
        client_key, client_name, a_number, matter_type,
        original_output, original_hash,
        input_context_summary, input_context_hash,
        model_used, input_tokens, output_tokens, estimated_cost_usd,
        generated_by, generated_from_ip, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'unreviewed')
     RETURNING id`,
    [
      feature_type, source_module, related_table, related_id,
      client_key, client_name, a_number, matter_type,
      original_output, originalHash,
      input_context_summary, inputContextHash,
      model_used, input_tokens, output_tokens, estimated_cost_usd,
      generated_by, generated_from_ip,
    ]
  );
  return r.rows[0].id;
}

async function markReviewed(auditId, { userId, notes = null, editedVersion = null, ip = null } = {}) {
  await initTable();

  // If attorney provided an edited version, compute the diff vs original
  let diffJson = null;
  let charDelta = null;
  if (editedVersion) {
    const orig = await db.query(`SELECT original_output FROM ai_audit_trail WHERE id = $1`, [auditId]);
    const original = orig.rows[0]?.original_output || "";
    const d = computeEditDiff(original, editedVersion);
    if (d) {
      diffJson = JSON.stringify(d);
      charDelta = d.char_delta;
    }
  }

  const r = await db.query(
    `UPDATE ai_audit_trail SET
       status = 'reviewed',
       reviewed_by = $1,
       reviewed_at = NOW(),
       reviewed_from_ip = $2,
       reviewer_notes = $3,
       final_version = COALESCE($4, final_version),
       edit_diff = COALESCE($5, edit_diff),
       edit_char_delta = COALESCE($6, edit_char_delta),
       updated_at = NOW()
     WHERE id = $7
     RETURNING *`,
    [userId, ip, notes, editedVersion, diffJson, charDelta, auditId]
  );
  return r.rows[0] || null;
}

async function markApproved(auditId, { userId, ip = null } = {}) {
  await initTable();
  const r = await db.query(
    `UPDATE ai_audit_trail SET
       status = 'approved',
       reviewed_by = COALESCE(reviewed_by, $1),
       reviewed_at = COALESCE(reviewed_at, NOW()),
       reviewed_from_ip = COALESCE(reviewed_from_ip, $2),
       updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [userId, ip, auditId]
  );
  return r.rows[0] || null;
}

async function markDelivered(auditId, {
  deliveredBy = null,
  deliveredTo = null,
  deliveredVia = null,
  deliveryConfirmation = null,
} = {}) {
  await initTable();
  const r = await db.query(
    `UPDATE ai_audit_trail SET
       status = 'delivered',
       delivered_at = NOW(),
       delivered_by = $1,
       delivered_to = $2,
       delivered_via = $3,
       delivery_confirmation = $4,
       updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [deliveredBy, deliveredTo, deliveredVia, deliveryConfirmation, auditId]
  );
  return r.rows[0] || null;
}

async function markWithdrawn(auditId, { userId, reason = null } = {}) {
  await initTable();
  const r = await db.query(
    `UPDATE ai_audit_trail SET
       status = 'withdrawn',
       reviewer_notes = COALESCE(reviewer_notes, '') || E'\n\n[WITHDRAWN by user #' || $1 || ': ' || COALESCE($2, 'no reason given') || ']',
       updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [userId, reason, auditId]
  );
  return r.rows[0] || null;
}

async function flag(auditId, { userId, reason, isMalpractice = false, isBarComplaint = false } = {}) {
  await initTable();
  const r = await db.query(
    `UPDATE ai_audit_trail SET
       status = 'flagged',
       flagged_by = $1,
       flagged_at = NOW(),
       flag_reason = $2,
       malpractice_flag = $3,
       bar_complaint_related = $4,
       updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [userId, reason, isMalpractice, isBarComplaint, auditId]
  );
  return r.rows[0] || null;
}

// ─── Retrieval ──────────────────────────────────────────

async function get(auditId) {
  await initTable();
  const r = await db.query(`SELECT * FROM ai_audit_trail WHERE id = $1`, [auditId]);
  return r.rows[0] || null;
}

async function list({
  feature_type = null,
  status = null,
  client_key = null,
  a_number = null,
  reviewed_by = null,
  from_date = null,
  to_date = null,
  flagged_only = false,
  limit = 100,
  offset = 0,
} = {}) {
  await initTable();
  const conds = [];
  const params = [];
  let i = 1;
  if (feature_type) { conds.push(`feature_type = $${i++}`); params.push(feature_type); }
  if (status) { conds.push(`status = $${i++}`); params.push(status); }
  if (client_key) { conds.push(`client_key = $${i++}`); params.push(client_key); }
  if (a_number) { conds.push(`a_number = $${i++}`); params.push(a_number); }
  if (reviewed_by) { conds.push(`reviewed_by = $${i++}`); params.push(reviewed_by); }
  if (from_date) { conds.push(`generated_at >= $${i++}`); params.push(from_date); }
  if (to_date) { conds.push(`generated_at <= $${i++}`); params.push(to_date); }
  if (flagged_only) { conds.push(`(bar_complaint_related OR malpractice_flag)`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(limit, offset);
  const r = await db.query(
    `SELECT id, feature_type, source_module, client_name, a_number, matter_type,
            model_used, estimated_cost_usd, status, generated_at, reviewed_at,
            delivered_at, delivered_via, bar_complaint_related, malpractice_flag,
            LEFT(original_output, 200) as preview,
            LENGTH(original_output) as output_length,
            edit_char_delta, generated_by, reviewed_by
     FROM ai_audit_trail
     ${where}
     ORDER BY generated_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    params
  );
  return r.rows;
}

async function count(filters = {}) {
  await initTable();
  const conds = [];
  const params = [];
  let i = 1;
  if (filters.feature_type) { conds.push(`feature_type = $${i++}`); params.push(filters.feature_type); }
  if (filters.status) { conds.push(`status = $${i++}`); params.push(filters.status); }
  if (filters.client_key) { conds.push(`client_key = $${i++}`); params.push(filters.client_key); }
  if (filters.flagged_only) { conds.push(`(bar_complaint_related OR malpractice_flag)`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const r = await db.query(`SELECT COUNT(*)::int as n FROM ai_audit_trail ${where}`, params);
  return r.rows[0]?.n || 0;
}

// Aggregate statistics for the dashboard tile
async function stats() {
  await initTable();
  const r = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'unreviewed') as pending_review,
      COUNT(*) FILTER (WHERE status = 'reviewed') as reviewed,
      COUNT(*) FILTER (WHERE status = 'approved') as approved,
      COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
      COUNT(*) FILTER (WHERE bar_complaint_related OR malpractice_flag) as flagged,
      COUNT(*) FILTER (WHERE generated_at > NOW() - INTERVAL '7 days') as last_7_days,
      COUNT(*) FILTER (WHERE generated_at > NOW() - INTERVAL '30 days') as last_30_days,
      COUNT(*) as total_all_time,
      COALESCE(SUM(estimated_cost_usd), 0)::numeric(10,2) as total_cost_all_time,
      COALESCE(SUM(estimated_cost_usd) FILTER (WHERE generated_at > NOW() - INTERVAL '30 days'), 0)::numeric(10,2) as cost_last_30_days
    FROM ai_audit_trail
  `);
  return r.rows[0] || {};
}

// Export ALL audit records for a specific client — for insurance/bar audit responses
async function exportForClient(clientKey) {
  await initTable();
  const r = await db.query(
    `SELECT * FROM ai_audit_trail WHERE client_key = $1 ORDER BY generated_at ASC`,
    [clientKey]
  );
  return r.rows;
}

// Verify tamper integrity — recomputes hash for one record and confirms it matches
async function verifyIntegrity(auditId) {
  const row = await get(auditId);
  if (!row) return { ok: false, error: "Record not found" };
  const currentHash = sha256(row.original_output);
  return {
    ok: currentHash === row.original_hash,
    stored_hash: row.original_hash,
    computed_hash: currentHash,
    tamper_detected: currentHash !== row.original_hash,
  };
}

module.exports = {
  initTable,
  log,
  markReviewed,
  markApproved,
  markDelivered,
  markWithdrawn,
  flag,
  get,
  list,
  count,
  stats,
  exportForClient,
  verifyIntegrity,
};
