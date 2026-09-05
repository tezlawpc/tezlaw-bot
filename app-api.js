// ============================================================
//  TEZ LAW P.C. — MOBILE APP JSON API
//  ─────────────────────────────────────────────────────────
//  All endpoints for the native iOS "Zara" app live here.
//  Called from React Native (Expo) via /api/* routes.
//
//  Auth model:
//   • Staff/attorneys/consultants: Bearer JWT
//   • Clients: SMS OTP → issues client-scoped Bearer JWT
//
//  Data visibility model:
//   • admin role: sees everything
//   • attorney/paralegal/viewer: only tasks assigned to them,
//     plus clients / hearings / deadlines / notes that touch
//     those tasks. Anything else → filtered out or 403.
//   • consultant: only their own submitted work orders.
//   • client: only their own case data.
//
//  Response format:
//   Success: { ok: true, ...payload }
//   Error:   { ok: false, error: "message" } with 4xx/5xx status
// ============================================================

const crypto = require("crypto");
const db = require("./db");
const auth = require("./auth");

// ── Utilities ─────────────────────────────────────────────

function extractToken(req) {
  const h = req.get("authorization") || req.get("Authorization") || "";
  if (h.startsWith("Bearer ")) return h.substring(7).trim();
  const cookies = auth.parseCookies(req);
  return cookies[auth.COOKIE_NAME] || null;
}

async function requireBearer(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
    const payload = await auth.verifyToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: "Invalid or expired token" });
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: err.message });
  }
}

function requireFirmUser(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Auth required" });
  const r = req.user.r;
  if (!["admin", "attorney", "paralegal", "viewer"].includes(r)) {
    return res.status(403).json({ ok: false, error: "Firm role required" });
  }
  next();
}

function requireConsultantRole(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: "Auth required" });
  if (req.user.r !== "consultant" && req.user.r !== "admin") {
    return res.status(403).json({ ok: false, error: "Consultant role required" });
  }
  next();
}

function requireClient(req, res, next) {
  if (!req.user || req.user.r !== "client") {
    return res.status(403).json({ ok: false, error: "Client role required" });
  }
  next();
}

// ═══════════════════════════════════════════════════════
//  ROLE-BASED VISIBILITY HELPERS
//  ────────────────────────────────────────────────────
//  Only admins see everything. All other firm users see
//  only what's assigned to them and the client data touching
//  those assignments.
// ═══════════════════════════════════════════════════════

function isAdmin(user) {
  return !!user && user.r === "admin";
}

// Terms to match against tasks.assigned_to (which is free text —
// could be username, full name, first name, or email).
function userAssignmentTerms(user) {
  const t = [];
  if (user?.u) t.push(String(user.u).toLowerCase().trim());
  if (user?.n) t.push(String(user.n).toLowerCase().trim());
  if (user?.n && String(user.n).includes(" ")) {
    t.push(String(user.n).split(" ")[0].toLowerCase().trim());
  }
  // Strip email domain if username is an email
  if (user?.u && String(user.u).includes("@")) {
    t.push(String(user.u).split("@")[0].toLowerCase().trim());
  }
  return Array.from(new Set(t.filter(Boolean)));
}

// True if this firm user is authorized to see this task.
function canUserSeeTask(user, task) {
  if (!task) return false;
  if (isAdmin(user)) return true;
  if (task.created_by && String(task.created_by) === String(user.uid)) return true;
  if (task.submitted_by_user_id && String(task.submitted_by_user_id) === String(user.uid)) return true;
  const assigned = String(task.assigned_to || "").toLowerCase().trim();
  if (!assigned) return false;
  const terms = userAssignmentTerms(user);
  return terms.some(t => t && assigned.includes(t));
}

// Returns Set<string> of client_keys the user can access,
// or null for admin (meaning: no filtering — see all).
async function getVisibleClientKeys(user) {
  if (isAdmin(user)) return null;
  const terms = userAssignmentTerms(user);
  const params = [String(user.uid)];
  let nameClause = "";
  if (terms.length) {
    const conds = terms.map((_, i) => `LOWER(assigned_to) LIKE $${i + 2}`);
    nameClause = " OR " + conds.join(" OR ");
    for (const t of terms) params.push(`%${t}%`);
  }
  try {
    const q = `
      SELECT DISTINCT client_key FROM tasks
      WHERE client_key IS NOT NULL
        AND (created_by::text = $1 OR submitted_by_user_id::text = $1${nameClause})
    `;
    const r = await db.query(q, params);
    return new Set(r.rows.map(row => row.client_key).filter(Boolean));
  } catch (e) {
    console.warn("[visibility] getVisibleClientKeys:", e.message);
    return new Set();
  }
}

// True if the user can access rows for this client_key.
async function canUserAccessClient(user, clientKey) {
  if (isAdmin(user)) return true;
  if (!clientKey) return false;
  const keys = await getVisibleClientKeys(user);
  return keys.has(clientKey);
}

// Filters items by client_key membership. Null keys → passthrough (admin).
// Items without client_key are dropped for non-admin (safer default).
function filterByClientKeys(items, keys, keyField = "client_key") {
  if (keys === null) return items;
  return items.filter(item => {
    const k = item?.[keyField];
    if (!k) return false;
    return keys.has(k);
  });
}

// ── Client SMS-OTP auth (separate from staff) ────────────────

async function initClientAuthTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_otp (
      id           SERIAL PRIMARY KEY,
      phone        TEXT NOT NULL,
      code_hash    TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      attempts     INTEGER DEFAULT 0,
      used         BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_otp_phone ON client_otp (phone, expires_at DESC)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_accounts (
      id             SERIAL PRIMARY KEY,
      phone          TEXT UNIQUE NOT NULL,
      client_key     TEXT,
      full_name      TEXT,
      email          TEXT,
      preferred_lang TEXT DEFAULT 'en',
      last_login_at  TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_accounts_phone ON client_accounts (phone)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_accounts_key ON client_accounts (client_key)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS push_tokens (
      id           SERIAL PRIMARY KEY,
      user_kind    TEXT NOT NULL,
      user_ref     TEXT NOT NULL,
      expo_token   TEXT NOT NULL UNIQUE,
      platform     TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS client_messages (
      id            SERIAL PRIMARY KEY,
      client_key    TEXT NOT NULL,
      sender_kind   TEXT NOT NULL,
      sender_name   TEXT,
      sender_id     INTEGER,
      body          TEXT NOT NULL,
      read_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_client_messages_key ON client_messages (client_key, created_at DESC)`);
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.startsWith("1") && digits.length > 10) return "+" + digits;
  return "+" + digits;
}

function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

async function issueClientToken(account) {
  return await auth.makeToken({
    uid: `c${account.id}`,
    u: account.phone,
    n: account.full_name || account.phone,
    r: "client",
    ck: account.client_key || null,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
}

// ─────────────────────────────────────────────────────────
// Route registration — call registerAppApi(app) from server.js
// ─────────────────────────────────────────────────────────
function registerAppApi(app) {
  initClientAuthTables().catch(e => console.warn("[app-api] init:", e.message));

  // ═══════════════════════════════════════════════════════
  //  AUTH
  // ═══════════════════════════════════════════════════════

  app.post("/api/auth/staff/login", async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ ok: false, error: "username and password required" });
      const user = await auth.findUserByUsername(String(username).toLowerCase().trim());
      if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });
      if (!user.active) return res.status(403).json({ ok: false, error: "Account disabled" });
      const ok = await auth.verifyPasswordHash(password, user.password_hash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });
      const token = await auth.makeToken({
        uid: user.id, u: user.username, n: user.full_name, r: user.role,
        exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });
      await auth.updateLastLogin(user.id);
      const perms = typeof auth.getEffectivePermissions === "function"
        ? await auth.getEffectivePermissions(user)
        : (typeof auth.getPermissions === "function" ? auth.getPermissions(user) : {});
      res.json({
        ok: true,
        token,
        user: {
          id: user.id, username: user.username, name: user.full_name, role: user.role,
          role_label: (auth.ROLES?.[user.role]?.label) || user.role,
          permissions: perms,
          is_admin: user.role === "admin",
        },
      });
    } catch (err) {
      console.error("[api staff login]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/auth/client/request-otp", async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      if (!phone) return res.status(400).json({ ok: false, error: "Valid phone required" });
      const recent = await db.query(
        `SELECT COUNT(*)::int AS n FROM client_otp WHERE phone = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
        [phone]
      );
      if (recent.rows[0].n >= 3) {
        return res.status(429).json({ ok: false, error: "Too many attempts, please try again in 15 minutes" });
      }
      const code = String(crypto.randomInt(100000, 999999));
      const codeHash = hashCode(code);
      await db.query(
        `INSERT INTO client_otp (phone, code_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
        [phone, codeHash]
      );
      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioFrom = process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER;
      if (twilioSid && twilioToken && twilioFrom) {
        try {
          const axios = require("axios");
          await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
            new URLSearchParams({
              To: phone, From: twilioFrom,
              Body: `Your Tez Law verification code is ${code}. Expires in 10 minutes. Do not share this code.`,
            }).toString(),
            { auth: { username: twilioSid, password: twilioToken }, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
          );
        } catch (twErr) {
          console.error("[client OTP twilio]:", twErr.response?.data || twErr.message);
          return res.status(500).json({ ok: false, error: "Failed to send SMS" });
        }
      } else {
        console.warn(`[DEV] Client OTP for ${phone}: ${code}`);
      }
      res.json({ ok: true, message: "Verification code sent" });
    } catch (err) {
      console.error("[api client request-otp]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/auth/client/verify-otp", async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      const code = String(req.body?.code || "").trim();
      if (!phone || !code) return res.status(400).json({ ok: false, error: "Phone and code required" });
      const r = await db.query(
        `SELECT * FROM client_otp
         WHERE phone = $1 AND used = FALSE AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [phone]
      );
      const otp = r.rows[0];
      if (!otp) return res.status(400).json({ ok: false, error: "Code expired — request a new one" });
      if (otp.attempts >= 5) {
        return res.status(429).json({ ok: false, error: "Too many attempts. Request a new code." });
      }
      const codeHash = hashCode(code);
      if (codeHash !== otp.code_hash) {
        await db.query(`UPDATE client_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
        return res.status(401).json({ ok: false, error: "Incorrect code" });
      }
      await db.query(`UPDATE client_otp SET used = TRUE WHERE id = $1`, [otp.id]);
      let accountR = await db.query(`SELECT * FROM client_accounts WHERE phone = $1`, [phone]);
      let account = accountR.rows[0];
      if (!account) {
        let clientKey = null, clientName = null;
        try {
          const cr = await db.query(
            `SELECT DISTINCT client_key, client_name FROM client_hearing_notices
             WHERE phone_number = $1 OR phone = $1
             ORDER BY client_name ASC LIMIT 1`,
            [phone]
          ).catch(() => ({ rows: [] }));
          if (cr.rows.length) {
            clientKey = cr.rows[0].client_key;
            clientName = cr.rows[0].client_name;
          }
        } catch {}
        const ins = await db.query(
          `INSERT INTO client_accounts (phone, client_key, full_name) VALUES ($1, $2, $3) RETURNING *`,
          [phone, clientKey, clientName]
        );
        account = ins.rows[0];
      }
      await db.query(`UPDATE client_accounts SET last_login_at = NOW() WHERE id = $1`, [account.id]);
      const token = await issueClientToken(account);
      res.json({
        ok: true,
        token,
        user: {
          id: `c${account.id}`,
          phone: account.phone,
          name: account.full_name,
          role: "client",
          client_key: account.client_key,
          preferred_lang: account.preferred_lang || "en",
          linked_to_case: !!account.client_key,
        },
      });
    } catch (err) {
      console.error("[api client verify-otp]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/me", requireBearer, async (req, res) => {
    res.json({
      ok: true,
      user: {
        id: req.user.uid, username: req.user.u, name: req.user.n,
        role: req.user.r, client_key: req.user.ck || null,
        is_admin: req.user.r === "admin",
      },
    });
  });

  // ═══════════════════════════════════════════════════════
  //  PUSH NOTIFICATION TOKENS
  // ═══════════════════════════════════════════════════════

  app.post("/api/push/register", requireBearer, async (req, res) => {
    try {
      const { token, platform } = req.body || {};
      if (!token) return res.status(400).json({ ok: false, error: "token required" });
      const userKind = req.user.r === "client" ? "client"
        : req.user.r === "consultant" ? "consultant"
        : "staff";
      const userRef = String(req.user.uid);
      await db.query(
        `INSERT INTO push_tokens (user_kind, user_ref, expo_token, platform)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (expo_token) DO UPDATE SET user_kind = EXCLUDED.user_kind,
           user_ref = EXCLUDED.user_ref, platform = EXCLUDED.platform, updated_at = NOW()`,
        [userKind, userRef, token, platform || "ios"]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/push/unregister", requireBearer, async (req, res) => {
    try {
      const { token } = req.body || {};
      if (token) await db.query(`DELETE FROM push_tokens WHERE expo_token = $1`, [token]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════
  //  STAFF: DASHBOARD, TASKS, CALENDAR, CLIENTS, NOTES
  //  (visibility-filtered per role)
  // ═══════════════════════════════════════════════════════

  // Consolidated dashboard summary
  app.get("/api/staff/dashboard", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const today = new Date().toISOString().split("T")[0];
      const nextWeek = new Date(Date.now() + 7 * 86400e3).toISOString().split("T")[0];

      const visibleKeys = await getVisibleClientKeys(req.user);
      const admin = isAdmin(req.user);

      const [allOpenTasks, allHearings, allDeadlines, unnotifiedAll] = await Promise.all([
        // Wider limit so we don't miss visible tasks after filtering
        tasks.listTasks({ due_within_days: 30, limit: admin ? 200 : 1000 }),
        db.query(
          `SELECT id, client_key, client_name, a_number, hearing_date, hearing_type, court_name
           FROM client_hearing_notices WHERE hearing_date >= $1 AND hearing_date <= $2 AND dismissed_at IS NULL
           ORDER BY hearing_date ASC LIMIT 200`, [today, nextWeek]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT id, description, due_date, priority, client_key, client_name, source_type
           FROM deadlines WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '14 days'
           ORDER BY due_date ASC LIMIT 200`
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT client_key FROM client_hearing_notices
           WHERE is_hearing_notice = TRUE AND dismissed_at IS NULL AND notified_at IS NULL`
        ).then(r => r.rows).catch(() => []),
      ]);

      // Apply visibility filters
      const openTasks = admin ? allOpenTasks : allOpenTasks.filter(t => canUserSeeTask(req.user, t));
      const hearings = filterByClientKeys(allHearings, visibleKeys);
      const deadlines = filterByClientKeys(allDeadlines, visibleKeys);
      const unnotifiedCount = admin
        ? unnotifiedAll.length
        : filterByClientKeys(unnotifiedAll, visibleKeys).length;

      const stats = { due_today: 0, overdue: 0, urgent: 0, total_open: openTasks.length };
      for (const t of openTasks) {
        const dueDay = t.due_date ? new Date(t.due_date).toISOString().split("T")[0] : null;
        if (dueDay && dueDay < today) stats.overdue++;
        if (dueDay === today) stats.due_today++;
        if (t.priority === "urgent") stats.urgent++;
      }
      const urgentTasks = openTasks.filter(t =>
        t.priority === "urgent" || t.priority === "high"
        || (t.days_until_due != null && t.days_until_due <= 3)
      ).slice(0, 6);

      res.json({
        ok: true,
        is_admin: admin,
        stats: {
          ...stats,
          hearings_this_week: hearings.length,
          deadlines_soon: deadlines.length,
          unnotified_hearings: unnotifiedCount,
        },
        urgent_tasks: urgentTasks,
        upcoming_hearings: hearings.slice(0, 15),
        upcoming_deadlines: deadlines.slice(0, 15),
      });
    } catch (err) {
      console.error("[api dashboard]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Tasks list — filtered to what the user can see
  app.get("/api/staff/tasks", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const filter = req.query.filter;
      const args = { limit: isAdmin(req.user) ? 200 : 1000 };
      if (filter === "overdue") args.overdue_only = true;
      else if (filter === "today") args.due_within_days = 0;
      else if (filter === "week") args.due_within_days = 7;
      else if (filter === "completed") args.completed_only = true;
      // Admin can filter by assignee explicitly; non-admin's own view is enforced below
      if (req.query.assigned_to && isAdmin(req.user)) args.assigned_to = req.query.assigned_to;
      if (req.query.client_key) args.client_key = req.query.client_key;
      const all = await tasks.listTasks(args);
      const items = isAdmin(req.user) ? all : all.filter(t => canUserSeeTask(req.user, t));
      res.json({ ok: true, count: items.length, tasks: items.slice(0, 200) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Task detail — 403 if user can't see it
  app.get("/api/staff/tasks/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const milestones = require("./task-milestones");
      const task = await tasks.getTask(id);
      if (!task) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, task)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const [mList, mProgress, activity] = await Promise.all([
        milestones.listMilestones(id),
        milestones.getProgress(id),
        tasks.listActivity(id),
      ]);
      res.json({ ok: true, task, milestones: mList, progress: mProgress, activity });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Create task — defaults assignee to creator if not specified, so non-admin
  // creators can immediately see the task they just made.
  app.post("/api/staff/tasks", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const body = { ...req.body };
      // If non-admin creator didn't set an assignee, default to themselves
      if (!isAdmin(req.user) && (!body.assigned_to || !String(body.assigned_to).trim())) {
        body.assigned_to = req.user.n || req.user.u;
      }
      const task = await tasks.createTask({
        ...body,
        created_by: req.user.uid,
        actor_name: req.user.n || req.user.u,
        actor_role: req.user.r,
      });
      res.json({ ok: true, task });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Update task — 403 unless user can see it
  app.patch("/api/staff/tasks/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const existing = await tasks.getTask(id);
      if (!existing) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, existing)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      // Non-admin can't reassign a task to a different person (would remove it from their view unexpectedly)
      const body = { ...req.body };
      if (!isAdmin(req.user) && body.assigned_to !== undefined && body.assigned_to !== existing.assigned_to) {
        return res.status(403).json({ ok: false, error: "Only admin can reassign tasks" });
      }
      const updated = await tasks.updateTask(id, {
        ...body,
        _actor_id: req.user.uid, _actor_name: req.user.n || req.user.u, _actor_role: req.user.r,
      });
      res.json({ ok: true, task: updated });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Complete task — 403 unless user can see it
  app.post("/api/staff/tasks/:id/complete", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const existing = await tasks.getTask(id);
      if (!existing) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, existing)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const t = await tasks.completeTask(id, {
        userId: req.user.uid,
        notes: req.body?.completion_notes || req.body?.notes,
        actorName: req.user.n || req.user.u,
        actorRole: req.user.r,
      });
      res.json({ ok: true, task: t });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Delete task — admin only, OR creator of the task
  app.delete("/api/staff/tasks/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const existing = await tasks.getTask(id);
      if (!existing) return res.status(404).json({ ok: false, error: "Task not found" });
      const isOwnCreation = existing.created_by && String(existing.created_by) === String(req.user.uid);
      if (!isAdmin(req.user) && !isOwnCreation) {
        return res.status(403).json({ ok: false, error: "Only the task creator or an admin can delete this" });
      }
      await tasks.deleteTask(id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Milestone update — check parent task ownership
  app.post("/api/staff/milestones/:id/update", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const milestones = require("./task-milestones");
      const tasks = require("./tasks");
      const before = await milestones.getMilestone(id);
      if (!before) return res.status(404).json({ ok: false, error: "Not found" });
      const parent = await tasks.getTask(before.task_id);
      if (!parent) return res.status(404).json({ ok: false, error: "Parent task not found" });
      if (!canUserSeeTask(req.user, parent)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const updated = await milestones.updateMilestone(id, {
        ...req.body,
        completed_by: req.body?.status === "completed" ? req.user.uid : undefined,
      });
      if (updated && req.body?.status && req.body.status !== before.status) {
        await tasks.logActivity(before.task_id, {
          actor_id: req.user.uid, actor_name: req.user.n || req.user.u, actor_role: req.user.r,
          action: "status_changed",
          old_value: `milestone "${before.title}" was ${before.status}`,
          new_value: `now ${updated.status}`,
        });
      }
      res.json({ ok: true, milestone: updated });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Add milestone — check parent task ownership
  app.post("/api/staff/tasks/:id/milestones", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const parent = await tasks.getTask(id);
      if (!parent) return res.status(404).json({ ok: false, error: "Task not found" });
      if (!canUserSeeTask(req.user, parent)) {
        return res.status(403).json({ ok: false, error: "You don't have access to this task" });
      }
      const milestones = require("./task-milestones");
      const m = await milestones.createMilestone(id, {
        title: String(req.body?.title || "").trim(),
        description: req.body?.description || null,
        due_date: req.body?.due_date || null,
      });
      res.json({ ok: true, milestone: m });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Calendar — filtered by user's clients
  app.get("/api/staff/calendar", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days || "30", 10), 90);
      const today = new Date().toISOString().split("T")[0];
      const end = new Date(Date.now() + days * 86400e3).toISOString().split("T")[0];
      const visibleKeys = await getVisibleClientKeys(req.user);
      const [allH, allD] = await Promise.all([
        db.query(
          `SELECT id, client_key, client_name, a_number, hearing_date, hearing_type, court_name, judge_name
           FROM client_hearing_notices WHERE hearing_date >= $1 AND hearing_date <= $2 AND dismissed_at IS NULL
           ORDER BY hearing_date ASC`, [today, end]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT id, description, due_date, priority, client_key, client_name, source_type
           FROM deadlines WHERE status = 'pending' AND due_date <= $1
           ORDER BY due_date ASC`, [end]
        ).then(r => r.rows).catch(() => []),
      ]);
      const hearings = filterByClientKeys(allH, visibleKeys);
      const deadlines = filterByClientKeys(allD, visibleKeys);
      res.json({ ok: true, hearings, deadlines, window_days: days, is_admin: isAdmin(req.user) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Clients — search + list, filtered to user's clients
  app.get("/api/staff/clients", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const mobile = require("./mobile-app");
      const q = req.query.q || "";
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const visibleKeys = await getVisibleClientKeys(req.user);

      let results;
      if (q && q.length >= 2) {
        results = await mobile.searchClients(q, 500);
      } else {
        const cp = require("./client-profiles");
        const all = await cp.aggregateClients();
        results = all.map(c => ({
          key: c.key, client_name: c.client_name, a_number: c.a_number,
          client_phone: c.client_phone, client_email: c.client_email,
          case_types: Array.from(c.case_types || []),
          total_hearings: (c.hearings || []).length,
        }));
      }
      // Filter to visible clients
      const filtered = filterByClientKeys(results, visibleKeys, "key");
      res.json({
        ok: true,
        count: filtered.length,
        clients: filtered.slice(0, limit),
        is_admin: isAdmin(req.user),
      });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Client detail — 403 unless user has access
  app.get("/api/staff/clients/:key", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "You don't have access to this client" });
      const mobile = require("./mobile-app");
      const client = await mobile.getClientDetail(req.params.key);
      if (!client) return res.status(404).json({ ok: false, error: "Client not found" });
      res.json({ ok: true, client });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Master hearing notes list — filtered by user's clients OR notes they authored
  app.get("/api/staff/notes/master", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const admin = isAdmin(req.user);
      const q = admin
        ? `SELECT id, client_key, client_name, a_number, hearing_date, judge_name, court_location,
                  client_language, paralegal_summary, created_at, created_by
           FROM hearing_notes ORDER BY hearing_date DESC NULLS LAST, created_at DESC LIMIT $1`
        : `SELECT id, client_key, client_name, a_number, hearing_date, judge_name, court_location,
                  client_language, paralegal_summary, created_at, created_by
           FROM hearing_notes ORDER BY hearing_date DESC NULLS LAST, created_at DESC LIMIT $1`;
      const r = await db.query(q, [admin ? limit : 500]);
      let notes = r.rows;
      if (!admin) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        // Include note if EITHER its client_key is visible OR the user created it
        notes = notes.filter(n =>
          (n.client_key && visibleKeys.has(n.client_key))
          || (n.created_by && String(n.created_by) === String(req.user.uid))
        );
        notes = notes.slice(0, limit);
      }
      res.json({ ok: true, count: notes.length, notes });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Master note detail — 403 unless user can access
  app.get("/api/staff/notes/master/:id", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const r = await db.query(`SELECT * FROM hearing_notes WHERE id = $1`, [id]);
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });
      const note = r.rows[0];
      if (!isAdmin(req.user)) {
        const okKey = note.client_key ? await canUserAccessClient(req.user, note.client_key) : false;
        const okAuthor = note.created_by && String(note.created_by) === String(req.user.uid);
        if (!okKey && !okAuthor) return res.status(403).json({ ok: false, error: "You don't have access to this note" });
      }
      res.json({ ok: true, note });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Individual notes list — same filter as master notes
  app.get("/api/staff/notes/individual", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const admin = isAdmin(req.user);
      const r = await db.query(
        `SELECT id, client_key, client_name, a_number, hearing_date, judge_name, court_location,
                client_language, case_type, disposition, paralegal_summary, created_at, created_by
         FROM individual_hearing_notes ORDER BY hearing_date DESC NULLS LAST, created_at DESC LIMIT $1`,
        [admin ? limit : 500]
      ).catch(() => ({ rows: [] }));
      let notes = r.rows;
      if (!admin) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        notes = notes.filter(n =>
          (n.client_key && visibleKeys.has(n.client_key))
          || (n.created_by && String(n.created_by) === String(req.user.uid))
        ).slice(0, limit);
      }
      res.json({ ok: true, count: notes.length, notes });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Federal / Trademark matters — admin sees all; others see matters with matching
  // assigned attorney or client_key visible to them.
  app.get("/api/staff/federal", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM federal_matters ORDER BY next_deadline ASC NULLS LAST, created_at DESC LIMIT 500`
      ).catch(() => ({ rows: [] }));
      let matters = r.rows;
      if (!isAdmin(req.user)) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        const terms = userAssignmentTerms(req.user);
        matters = matters.filter(m => {
          // Match by client_key
          if (m.client_key && visibleKeys.has(m.client_key)) return true;
          // Match by assigned attorney field (if the table has one)
          const assigned = String(m.assigned_to || m.attorney || "").toLowerCase();
          if (assigned && terms.some(t => assigned.includes(t))) return true;
          return false;
        }).slice(0, 200);
      }
      res.json({ ok: true, count: matters.length, matters });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // PI cases — same visibility model as federal
  app.get("/api/staff/pi", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const r = await db.query(
        `SELECT * FROM pi_cases ORDER BY updated_at DESC NULLS LAST LIMIT 500`
      ).catch(() => ({ rows: [] }));
      let cases = r.rows;
      if (!isAdmin(req.user)) {
        const visibleKeys = await getVisibleClientKeys(req.user);
        const terms = userAssignmentTerms(req.user);
        cases = cases.filter(c => {
          if (c.client_key && visibleKeys.has(c.client_key)) return true;
          const assigned = String(c.assigned_to || c.attorney || "").toLowerCase();
          if (assigned && terms.some(t => assigned.includes(t))) return true;
          return false;
        }).slice(0, 200);
      }
      res.json({ ok: true, count: cases.length, cases });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Zara chat — available to all firm users (personal AI assistant, no shared data)
  app.post("/api/staff/chat", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ ok: false, error: "message required" });
      let askClaude;
      try { askClaude = require("./askClaude-memory"); } catch { askClaude = null; }
      if (!askClaude || typeof askClaude.answerQuestion !== "function") {
        return res.status(501).json({ ok: false, error: "Chat not available on backend" });
      }
      const reply = await askClaude.answerQuestion({
        userId: `staff-${req.user.uid}`,
        question: message,
        history: history || [],
        actor: { role: req.user.r, name: req.user.n || req.user.u },
      });
      res.json({ ok: true, reply });
    } catch (err) {
      console.error("[api chat]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // USCIS receipt lookup — available to all firm users (public government data)
  app.get("/api/staff/uscis/:receipt", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const uscis = require("./uscis");
      const status = await uscis.lookupReceipt(req.params.receipt);
      res.json({ ok: true, status });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Firm-side: view messages with a client — 403 unless user can access
  app.get("/api/staff/clients/:key/messages", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const ok = await canUserAccessClient(req.user, req.params.key);
      if (!ok) return res.status(403).json({ ok: false, error: "You don't have access to this client" });
      const r = await db.query(
        `SELECT * FROM client_messages WHERE client_key = $1 ORDER BY created_at ASC LIMIT 200`,
        [req.params.key]
      );
      res.json({ ok: true, messages: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // Firm-side: send message to client — 403 unless user can access
  app.post("/api/staff/clients/:key/messages", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const clientKey = req.params.key;
      const ok = await canUserAccessClient(req.user, clientKey);
      if (!ok) return res.status(403).json({ ok: false, error: "You don't have access to this client" });
      const body = String(req.body?.body || "").trim().substring(0, 4000);
      if (!body) return res.status(400).json({ ok: false, error: "Message body required" });
      const r = await db.query(
        `INSERT INTO client_messages (client_key, sender_kind, sender_name, sender_id, body)
         VALUES ($1, 'firm', $2, $3, $4) RETURNING *`,
        [clientKey, req.user.n || req.user.u, req.user.uid, body]
      );
      res.json({ ok: true, message: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CONSULTANT PORTAL API
  //  (naturally scoped to their own submissions)
  // ═══════════════════════════════════════════════════════

  app.get("/api/consultant/dashboard", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const userId = req.user.uid;
      const [openTasks, allStats] = await Promise.all([
        tasks.listTasks({ submitted_by_user_id: userId, limit: 100 }),
        db.query(
          `SELECT status, COUNT(*)::int AS n FROM tasks WHERE submitted_by_user_id = $1 GROUP BY status`,
          [userId]
        ).then(r => r.rows),
      ]);
      const stats = { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
      for (const row of allStats) { stats[row.status] = row.n; stats.total += row.n; }
      res.json({ ok: true, stats, tasks: openTasks });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/consultant/tasks", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const tasks = require("./tasks");
      const userId = req.user.uid;
      const data = req.body || {};
      const cleaned = {
        title: String(data.title || "").trim(),
        description: data.description ? String(data.description).substring(0, 8000) : null,
        matter_type: data.matter_type || "admin",
        priority: ["urgent", "high", "normal", "low"].includes(data.priority) ? data.priority : "normal",
        due_date: data.due_date && /^\d{4}-\d{2}-\d{2}$/.test(data.due_date) ? data.due_date : null,
        client_name: data.client_name ? String(data.client_name).substring(0, 200) : null,
        status: "pending",
        submitted_by_user_id: userId,
        submitter_visible: true,
        created_by: userId,
        actor_name: req.user.n || req.user.u,
        actor_role: req.user.r,
      };
      if (!cleaned.title) return res.status(400).json({ ok: false, error: "Title required" });
      if (cleaned.client_name) {
        cleaned.client_key = cleaned.client_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      }
      const task = await tasks.createTask(cleaned);
      res.json({ ok: true, task });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/consultant/tasks/:id", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const milestones = require("./task-milestones");
      const task = await tasks.getTask(id);
      if (!task || task.submitted_by_user_id !== req.user.uid) {
        return res.status(404).json({ ok: false, error: "Not found" });
      }
      const [activity, mList, mProgress] = await Promise.all([
        tasks.listActivity(id, { filterVisibleOnly: true }),
        milestones.listMilestones(id),
        milestones.getProgress(id),
      ]);
      res.json({ ok: true, task, milestones: mList, progress: mProgress, activity });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/consultant/tasks/:id/comment", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "Bad id" });
      const tasks = require("./tasks");
      const task = await tasks.getTask(id);
      if (!task || task.submitted_by_user_id !== req.user.uid) {
        return res.status(404).json({ ok: false, error: "Not found" });
      }
      const note = String(req.body?.note || "").trim().substring(0, 2000);
      if (!note) return res.status(400).json({ ok: false, error: "Note required" });
      await tasks.addTaskComment(id, {
        actor_id: req.user.uid, actor_name: req.user.n || req.user.u,
        actor_role: req.user.r, note, visible_to_submitter: true,
      });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ═══════════════════════════════════════════════════════
  //  CLIENT PORTAL API (SMS OTP)
  //  (naturally scoped to their own client_key)
  // ═══════════════════════════════════════════════════════

  app.get("/api/client/overview", requireBearer, requireClient, async (req, res) => {
    try {
      const clientKey = req.user.ck;
      if (!clientKey) {
        return res.json({
          ok: true,
          linked_to_case: false,
          message: "Your account isn't linked to a case yet. Please contact Tez Law at 626-678-8677.",
        });
      }
      const [hearings, deadlines, unread] = await Promise.all([
        db.query(
          `SELECT id, hearing_date, hearing_type, court_name, judge_name
           FROM client_hearing_notices
           WHERE client_key = $1 AND dismissed_at IS NULL AND hearing_date >= CURRENT_DATE - INTERVAL '30 days'
           ORDER BY hearing_date ASC LIMIT 20`,
          [clientKey]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT id, description, due_date, priority
           FROM deadlines
           WHERE client_key = $1 AND status = 'pending'
           ORDER BY due_date ASC LIMIT 20`,
          [clientKey]
        ).then(r => r.rows).catch(() => []),
        db.query(
          `SELECT COUNT(*)::int AS n FROM client_messages
           WHERE client_key = $1 AND sender_kind = 'firm' AND read_at IS NULL`,
          [clientKey]
        ).then(r => r.rows[0]?.n || 0).catch(() => 0),
      ]);
      const nextHearing = hearings.find(h => new Date(h.hearing_date) >= new Date());
      res.json({
        ok: true,
        linked_to_case: true,
        client_name: req.user.n,
        next_hearing: nextHearing,
        upcoming_hearings: hearings,
        deadlines,
        unread_messages: unread,
      });
    } catch (err) {
      console.error("[api client overview]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/client/messages", requireBearer, requireClient, async (req, res) => {
    try {
      const clientKey = req.user.ck;
      if (!clientKey) return res.json({ ok: true, messages: [] });
      const r = await db.query(
        `SELECT * FROM client_messages WHERE client_key = $1 ORDER BY created_at ASC LIMIT 200`,
        [clientKey]
      );
      await db.query(
        `UPDATE client_messages SET read_at = NOW()
         WHERE client_key = $1 AND sender_kind = 'firm' AND read_at IS NULL`,
        [clientKey]
      );
      res.json({ ok: true, messages: r.rows });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/client/messages", requireBearer, requireClient, async (req, res) => {
    try {
      const clientKey = req.user.ck;
      if (!clientKey) return res.status(400).json({ ok: false, error: "Account not linked to a case" });
      const body = String(req.body?.body || "").trim().substring(0, 4000);
      if (!body) return res.status(400).json({ ok: false, error: "Message body required" });
      const r = await db.query(
        `INSERT INTO client_messages (client_key, sender_kind, sender_name, sender_id, body)
         VALUES ($1, 'client', $2, $3, $4) RETURNING *`,
        [clientKey, req.user.n, parseInt(String(req.user.uid).replace(/\D/g, ""), 10) || null, body]
      );
      try {
        if (process.env.TELEGRAM_BOT_TOKEN && (process.env.HEARING_NOTES_TELEGRAM_GROUP_ID || process.env.TELEGRAM_GROUP_ID)) {
          const axios = require("axios");
          await axios.post(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              chat_id: process.env.HEARING_NOTES_TELEGRAM_GROUP_ID || process.env.TELEGRAM_GROUP_ID,
              text: `💬 *New client message* from ${req.user.n || "client"}\n\n${body.substring(0, 400)}`,
              parse_mode: "Markdown",
            }
          ).catch(() => {});
        }
      } catch {}
      res.json({ ok: true, message: r.rows[0] });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/client/chat", requireBearer, requireClient, async (req, res) => {
    try {
      const { message, history } = req.body || {};
      if (!message) return res.status(400).json({ ok: false, error: "message required" });
      let askClaude;
      try { askClaude = require("./askClaude-memory"); } catch { askClaude = null; }
      if (!askClaude || typeof askClaude.answerQuestion !== "function") {
        return res.status(501).json({ ok: false, error: "Chat not available" });
      }
      const reply = await askClaude.answerQuestion({
        userId: `client-${req.user.uid}`,
        question: message,
        history: history || [],
        actor: { role: "client", name: req.user.n },
      });
      res.json({ ok: true, reply });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  console.log("[app-api] registered — mobile app endpoints live at /api/* (with role-based visibility)");
}

module.exports = { registerAppApi };
