// ============================================================
//  channel-inbox.js — Zara's channel conversations, for Tara
//
//  Every message Zara saves (WhatsApp, Messenger, Telegram, WeChat, web
//  chat) already lands in the `messages` table, keyed by platform +
//  platform_id. Nobody on staff could see those conversations. This
//  module keeps one `channel_threads` row per person per channel so the
//  Tara inbox can list them next to the client-portal threads.
//
//  Phase 1 (this file): record threads, list them, read them, mark read.
//  Staff replies and the Zara pause arrive in phase 2.
//
//  JJ's private-mode conversations never become threads. Three guards,
//  any one of which is enough:
//    1. askClaude-memory passes { thread: false } on the JJ-mode path;
//    2. touchThread skips any sender with a JJ session in jj_memory;
//    3. the list query filters those senders out again, plus
//       JJ_TELEGRAM_ID and anything in INBOX_EXCLUDE (platform:id,…).
// ============================================================

const db = require("./db");
const auth = require("./auth");

// Channels that belong in the inbox. Anything else Zara talks on
// (the in-app assistant, voice) stays out.
const CHANNELS = ["whatsapp", "messenger", "telegram", "wechat", "website", "instagram", "email"];
const INBOX_ROLES = ["admin", "manager", "attorney", "paralegal"];

// ── Exclusions ────────────────────────────────────────────

function excludedPairs() {
  const out = [];
  const tg = process.env.JJ_TELEGRAM_ID;
  if (tg) out.push(["telegram", String(tg)]);
  for (const item of String(process.env.INBOX_EXCLUDE || "").split(",")) {
    const s = item.trim();
    const i = s.indexOf(":");
    if (i > 0) out.push([s.slice(0, i).toLowerCase(), s.slice(i + 1)]);
  }
  return out;
}

function isExcludedPair(platform, platformId) {
  return excludedPairs().some(([p, id]) => p === platform && id === String(platformId));
}

async function hasJJSession(platform, platformId) {
  try {
    const r = await db.query(
      `SELECT 1 FROM jj_memory WHERE jj_said = $1 LIMIT 1`,
      [`_session_${platform}_${platformId}`]
    );
    return r.rows.length > 0;
  } catch (e) {
    // If we cannot tell, keep it out of the inbox.
    return true;
  }
}

// SQL fragment: true when a thread row belongs to JJ.
const JJ_FILTER = `NOT EXISTS (
  SELECT 1 FROM jj_memory j
   WHERE j.jj_said = '_session_' || t.platform || '_' || t.platform_id
)`;

// ── Schema ────────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS channel_threads (
      id                SERIAL PRIMARY KEY,
      platform          VARCHAR(20)  NOT NULL,
      platform_id       VARCHAR(100) NOT NULL,
      client_key        TEXT,
      status            TEXT NOT NULL DEFAULT 'open',
      assigned_to       INTEGER,
      zara_paused_until TIMESTAMPTZ,
      unread_count      INTEGER NOT NULL DEFAULT 0,
      last_inbound_at   TIMESTAMPTZ,
      last_message_at   TIMESTAMPTZ DEFAULT NOW(),
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (platform, platform_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_threads_last ON channel_threads (last_message_at DESC)`);

  // Columns phase 2 writes; added now so the migration happens once.
  for (const col of [
    `sender_kind TEXT`,
    `sender_user_id INTEGER`,
    `delivery_status TEXT`,
    `delivery_error TEXT`,
    `attachment_url TEXT`,
  ]) {
    await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }

  // First boot: seed threads from the last 30 days so the inbox is not
  // empty. JJ's sessions and excluded ids are skipped; nothing is unread.
  const seeded = await db.query(`
    INSERT INTO channel_threads (platform, platform_id, last_message_at, last_inbound_at)
    SELECT m.platform, m.platform_id, MAX(m.created_at),
           MAX(m.created_at) FILTER (WHERE m.role = 'user')
      FROM messages m
     WHERE m.created_at > NOW() - INTERVAL '30 days'
       AND m.platform = ANY($1)
       AND NOT EXISTS (
         SELECT 1 FROM jj_memory j
          WHERE j.jj_said = '_session_' || m.platform || '_' || m.platform_id)
       AND NOT EXISTS (
         SELECT 1 FROM messages x
          WHERE x.platform = m.platform AND x.platform_id = m.platform_id
            AND x.content LIKE '[private mode authentication%')
     GROUP BY m.platform, m.platform_id
    ON CONFLICT (platform, platform_id) DO NOTHING
    RETURNING id
  `, [CHANNELS]);
  if (seeded.rows.length) console.log(`[channel-inbox] seeded ${seeded.rows.length} threads from the last 30 days`);
}

// ── Recording ─────────────────────────────────────────────

/**
 * Called by db.saveMessage after every message Zara stores.
 * role: "user" (the person wrote in) or "assistant" (Zara replied).
 */
async function touchThread(platform, platformId, role) {
  try {
    if (!CHANNELS.includes(platform)) return;
    if (isExcludedPair(platform, platformId)) return;
    if (await hasJJSession(platform, platformId)) return;
    const inbound = role === "user";
    await db.query(`
      INSERT INTO channel_threads (platform, platform_id, unread_count, last_inbound_at, last_message_at)
      VALUES ($1, $2, $3, CASE WHEN $4 THEN NOW() END, NOW())
      ON CONFLICT (platform, platform_id) DO UPDATE SET
        unread_count    = channel_threads.unread_count + $3,
        last_inbound_at = CASE WHEN $4 THEN NOW() ELSE channel_threads.last_inbound_at END,
        last_message_at = NOW(),
        status          = CASE WHEN $4 AND channel_threads.status = 'done' THEN 'open'
                               ELSE channel_threads.status END
    `, [platform, String(platformId), inbound ? 1 : 0, inbound]);
  } catch (e) {
    console.error("[channel-inbox] touchThread:", e.message);
  }
}

function senderKind(row) {
  if (row.sender_kind) return row.sender_kind;
  return row.role === "user" ? "client" : "zara";
}

// ── HTTP ──────────────────────────────────────────────────

function extractToken(req) {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.substring(7).trim();
  const cookies = auth.parseCookies(req);
  return cookies[auth.COOKIE_NAME] || null;
}

async function requireInboxUser(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
    const payload = await auth.verifyToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    if (!INBOX_ROLES.includes(payload.r)) return res.status(403).json({ ok: false, error: "Inbox access requires a staff role" });
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message });
  }
}

const THREAD_COLUMNS = `
  t.id, t.platform, t.platform_id, t.client_key, t.status, t.assigned_to,
  t.zara_paused_until, t.unread_count, t.last_inbound_at, t.last_message_at,
  c.name AS contact_name, c.phone, c.email, c.preferred_language, c.case_type`;

function publicThread(row) {
  const labels = {
    whatsapp: "WhatsApp", messenger: "Messenger", telegram: "Telegram", wechat: "WeChat",
    website: "Web chat", instagram: "Instagram", email: "Email",
  };
  const channel = labels[row.platform] || row.platform;
  return {
    id: row.id,
    platform: row.platform,
    channel_label: channel,
    display_name: row.contact_name || `${channel} visitor`,
    phone: row.phone || null,
    email: row.email || null,
    language: row.preferred_language || null,
    case_type: row.case_type || null,
    client_key: row.client_key || null,
    status: row.status,
    assigned_to: row.assigned_to,
    zara_paused_until: row.zara_paused_until,
    unread_count: row.unread_count,
    last_inbound_at: row.last_inbound_at,
    last_at: row.last_message_at,
    last_msg: row.last_content == null ? null : {
      body: String(row.last_content).slice(0, 140),
      sender_kind: senderKind({ role: row.last_role, sender_kind: row.last_sender_kind }),
      created_at: row.last_created_at,
    },
  };
}

function exclusionSql(startIndex) {
  const pairs = excludedPairs();
  if (!pairs.length) return { sql: "", params: [] };
  const parts = [], params = [];
  let i = startIndex;
  for (const [p, id] of pairs) {
    parts.push(`(t.platform = $${i++} AND t.platform_id = $${i++})`);
    params.push(p, id);
  }
  return { sql: ` AND NOT (${parts.join(" OR ")})`, params };
}

async function listThreads({ filter = "all", limit = 200 } = {}) {
  const where = [JJ_FILTER, `t.platform = ANY($1)`];
  if (filter === "unread") where.push(`t.unread_count > 0`);
  else if (filter === "done") where.push(`t.status = 'done'`);
  else where.push(`t.status <> 'done'`);
  const ex = exclusionSql(3);
  const r = await db.query(`
    SELECT ${THREAD_COLUMNS},
           lm.content AS last_content, lm.role AS last_role,
           lm.sender_kind AS last_sender_kind, lm.created_at AS last_created_at
      FROM channel_threads t
      LEFT JOIN clients c ON c.platform = t.platform AND c.platform_id = t.platform_id
      LEFT JOIN LATERAL (
        SELECT content, role, sender_kind, created_at FROM messages m
         WHERE m.platform = t.platform AND m.platform_id = t.platform_id
         ORDER BY m.created_at DESC LIMIT 1
      ) lm ON TRUE
     WHERE ${where.join(" AND ")}${ex.sql}
     ORDER BY t.last_message_at DESC NULLS LAST
     LIMIT $2
  `, [CHANNELS, Math.min(Number(limit) || 200, 500), ...ex.params]);
  const total = await db.query(
    `SELECT COALESCE(SUM(t.unread_count), 0)::int AS n FROM channel_threads t
      WHERE ${JJ_FILTER} AND t.platform = ANY($1) AND t.status <> 'done'${ex.sql.replace(/\$(\d+)/g, (_, n) => "$" + (Number(n) - 1))}`,
    [CHANNELS, ...ex.params]
  );
  return { threads: r.rows.map(publicThread), total_unread: total.rows[0]?.n || 0 };
}

async function getThread(id) {
  const ex = exclusionSql(2);
  const r = await db.query(`
    SELECT ${THREAD_COLUMNS}, NULL AS last_content
      FROM channel_threads t
      LEFT JOIN clients c ON c.platform = t.platform AND c.platform_id = t.platform_id
     WHERE t.id = $1 AND ${JJ_FILTER}${ex.sql}
  `, [id, ...ex.params]);
  if (!r.rows.length) return null;
  const t = r.rows[0];
  const m = await db.query(`
    SELECT id, role, content, sender_kind, sender_user_id, delivery_status, attachment_url, created_at
      FROM (SELECT * FROM messages WHERE platform = $1 AND platform_id = $2
             ORDER BY created_at DESC LIMIT 200) recent
     ORDER BY created_at ASC
  `, [t.platform, t.platform_id]);
  return {
    thread: publicThread(t),
    messages: m.rows.map(row => ({
      id: row.id,
      sender_kind: senderKind(row),
      sender_user_id: row.sender_user_id,
      body: row.content,
      attachment_url: row.attachment_url,
      delivery_status: row.delivery_status,
      created_at: row.created_at,
    })),
  };
}

function registerRoutes(app) {
  app.get("/api/staff/threads", requireInboxUser, async (req, res) => {
    try {
      const filter = ["all", "unread", "done"].includes(req.query.filter) ? req.query.filter : "all";
      res.json({ ok: true, ...(await listThreads({ filter, limit: req.query.limit })) });
    } catch (err) {
      console.error("[/api/staff/threads]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/staff/threads/:id", requireInboxUser, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
      const out = await getThread(id);
      if (!out) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, ...out });
    } catch (err) {
      console.error("[/api/staff/threads/:id]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/staff/threads/:id/read", requireInboxUser, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: "bad id" });
      await db.query(`UPDATE channel_threads SET unread_count = 0 WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  initTable, touchThread, registerRoutes,
  listThreads, getThread,
  // exported for scripts/check-channel-inbox.js
  _internal: { isExcludedPair, excludedPairs, exclusionSql, publicThread, senderKind, CHANNELS, INBOX_ROLES },
};
