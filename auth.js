// ============================================================
//  TEZ LAW P.C. — AUTHENTICATION
//  ─────────────────────────────────────────────────────────
//  Session-based auth for the /admin/* area.
//
//  Design notes:
//  - Passwords hashed with scrypt (Node's built-in, no deps)
//  - Sessions are signed HMAC tokens stored in an httpOnly cookie
//  - Session secret self-generates and persists in DB (survives restarts)
//  - No users → app enters "setup mode": first visit to any /admin/*
//    redirects to /admin/setup so JJ can create the first admin user
//  - After users exist, all /admin/* except /login /logout /setup requires
//    a valid session cookie
//  - No external session store needed (cookie carries the payload)
//
//  Bootstrap sequence on fresh Render deploy:
//    1. First /admin/* request → redirected to /admin/setup
//    2. JJ enters username + password → account created + logged in
//    3. All future access requires login
// ============================================================

const crypto = require("crypto");
const db = require("./db");

const COOKIE_NAME = "tezauth";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;              // 24h default
const SESSION_TTL_LONG_MS = 30 * 24 * 60 * 60 * 1000;   // 30d "remember me"

// ── Roles ────────────────────────────────────────────────
// Kept intentionally simple: four roles, each with a fixed feature set.
// Add more granular permissions later if a role split is needed.
//
//   admin      = JJ. Everything, including user + system management.
//   attorney   = Licensed attorneys. Hearing notes, clients, Dropbox, notices.
//                No user management, no OAuth setup, no email setup.
//   paralegal  = Case managers / paralegals. Clients, Dropbox files, hearing
//                notices, view hearing notes. Cannot create/edit hearing notes.
//   viewer     = Read-only across the platform.

const ROLES = {
  admin: {
    label: "Administrator",
    description: "Full access to everything, including user + system settings",
    color: "#0C1C36",
  },
  attorney: {
    label: "Attorney",
    description: "Hearing notes (create/edit), clients, Dropbox, hearing notices",
    color: "#B79C62",
  },
  paralegal: {
    label: "Paralegal / Case Manager",
    description: "Clients, Dropbox, hearing notices. View hearing notes only.",
    color: "#0061FF",
  },
  viewer: {
    label: "Viewer (Read-Only)",
    description: "View-only access to clients, hearings, and Dropbox files",
    color: "#666",
  },
  consultant: {
    label: "Consultant / Referral Partner",
    description: "Referral partners who submit new leads + work orders. Sees ONLY their own submissions and progress. No access to firm-wide clients or matters.",
    color: "#7c4dff",
  },
};

// Which roles are allowed to reach each feature area.
// Used both by the requireRole middleware and by the client-side
// sidebar filter (via /admin/whoami's `permissions` payload).
const PERMISSIONS = {
  // System admin — only JJ
  "users.manage":         ["admin"],
  "dropbox.setup":        ["admin"],
  "email.setup":          ["admin"],
  "system.settings":      ["admin"],

  // Matter Manager and its operational tooling (intake, leads, prompts,
  // autoposter, analytics, drip campaigns, SOL tracking) — JJ only.
  // Attorneys and paralegals do their case work through hearing notes +
  // client profiles, not through JJ's operational panel.
  "matters.access":       ["admin"],
  "admin_panel.access":   ["admin"],

  // Hearing notes — attorneys write, paralegals + viewers can read
  "hearings.write":       ["admin", "attorney"],
  "hearings.read":        ["admin", "attorney", "paralegal", "viewer"],

  // Firm-wide hearing note lists — separate keys per menu item so JJ can
  // grant/deny each individually in the per-user checkbox UI. Defaults keep
  // attorneys out (they interact with their own notes via dashboard).
  "notes.master":         ["admin", "paralegal"],  // "Master Notes" sidebar link
  "notes.individual":     ["admin", "paralegal"],  // "Individual Notes" sidebar link
  "notes.history":        ["admin", "paralegal"],  // "Hearing History" sidebar link
  // Backward-compat alias — any old code still checking notes.list keeps working
  "notes.list":           ["admin", "paralegal"],

  // Dashboard — everyone gets a landing page. Kept broad on purpose.
  "dashboard.access":     ["admin", "attorney", "paralegal", "viewer"],

  // Client-facing tools — all roles, viewers read only
  "clients.write":        ["admin", "attorney", "paralegal"],
  "clients.read":         ["admin", "attorney", "paralegal", "viewer"],

  // Dropbox files — download for all authed, upload/delete for staff
  "dropbox.files.write":  ["admin", "attorney", "paralegal"],
  "dropbox.files.read":   ["admin", "attorney", "paralegal", "viewer"],
  // Configuring the Dropbox integration itself (auth tokens, folder scan) — admin
  "dropbox.setup":        ["admin"],

  // Hearing notices — everyone can view + send
  "notices.send":         ["admin", "attorney", "paralegal"],
  "notices.read":         ["admin", "attorney", "paralegal", "viewer"],

  // Integration configuration — admin only
  "outlook.setup":        ["admin"],

  // Motions — attorneys draft and file, paralegals prepare, viewers read only
  "motions.write":        ["admin", "attorney", "paralegal"],
  "motions.read":         ["admin", "attorney", "paralegal", "viewer"],

  // Calendar + deadlines — everyone reads, staff can edit
  "calendar.read":        ["admin", "attorney", "paralegal", "viewer"],
  "deadlines.read":       ["admin", "attorney", "paralegal", "viewer"],
  "deadlines.write":      ["admin", "attorney", "paralegal"],

  // Analytics / reports — admin only (may include revenue, cost data)
  "analytics.read":       ["admin"],

  // Accounting — admin + paralegal (case manager handles bookkeeping).
  // Attorneys and viewers don't see accounting at all.
  "accounting.read":      ["admin", "paralegal"],
  "accounting.write":     ["admin", "paralegal"],
  // Personal Injury — everyone reads, staff writes. Separate from clients
  // so JJ can grant PI access without giving all clients access, or vice versa.
  "pi.read":              ["admin", "attorney", "paralegal", "viewer"],
  "pi.write":             ["admin", "attorney", "paralegal"],
  // Federal Matters & Trademarks — same rules as regular clients
  "federal.read":         ["admin", "attorney", "paralegal", "viewer"],
  "federal.write":        ["admin", "attorney", "paralegal"],
  // Task list — everyone can see and interact with tasks
  "tasks.read":           ["admin", "attorney", "paralegal", "viewer"],
  "tasks.write":          ["admin", "attorney", "paralegal"],

  // Mobile PWA search — same as clients.read
  "mobile.search":        ["admin", "attorney", "paralegal", "viewer"],

  // ── Consultant portal (referral partners) ──────────────
  // Consultants are external referral partners who bring leads/matters to
  // the firm. They log in to a *separate* portal with a limited view:
  // they can submit work orders (tasks) and track progress on the ones
  // they submitted — nothing else. They cannot see firm-wide data.
  "consultant.portal":    ["admin", "consultant"],   // access the /consultant portal
  "consultant.submit":    ["admin", "consultant"],   // submit new work orders / leads
  "consultant.track":     ["admin", "consultant"],   // track their own submissions
};

function hasPermission(user, permKey) {
  if (!user || !user.r) return false;
  // Note: this is the SYNCHRONOUS check based on role only — used by middleware
  // that runs on every request. Per-user overrides are applied to the effective
  // permissions map returned by /admin/whoami and used by the sidebar filter.
  // For gated routes, we call hasPermissionAsync() below which also applies overrides.
  const roles = PERMISSIONS[permKey] || [];
  return roles.includes(user.r);
}

// Async permission check that ALSO applies per-user overrides from the
// user_permission_overrides table. This is what routes and the sidebar filter
// use to determine the actual, effective permission for a user.
async function hasPermissionAsync(user, permKey) {
  if (!user) return false;
  const override = await getUserOverride(user.uid || user.id, permKey);
  if (override !== null) return override;  // explicit override wins
  return hasPermission(user, permKey);
}

// Return the full effective permission map for a user (role defaults with
// per-user overrides layered on top). Called by /admin/whoami so the sidebar
// filter knows exactly which links to show.
async function getEffectivePermissions(user) {
  const perms = {};
  const overrides = await getUserOverridesMap(user.uid || user.id);
  for (const key of Object.keys(PERMISSIONS)) {
    if (overrides[key] !== undefined) perms[key] = overrides[key];
    else perms[key] = hasPermission(user, key);
  }
  return perms;
}

// Fetch a single override (returns null if none set).
async function getUserOverride(userId, permKey) {
  if (!userId) return null;
  try {
    await ensureOverrideTable();
    const r = await db.query(
      `SELECT granted FROM user_permission_overrides WHERE user_id = $1 AND permission_key = $2`,
      [userId, permKey]
    );
    if (!r.rows.length) return null;
    return r.rows[0].granted;
  } catch { return null; }
}

// Fetch all overrides for a user as { key: bool } (or empty object).
async function getUserOverridesMap(userId) {
  if (!userId) return {};
  try {
    await ensureOverrideTable();
    const r = await db.query(
      `SELECT permission_key, granted FROM user_permission_overrides WHERE user_id = $1`,
      [userId]
    );
    return Object.fromEntries(r.rows.map(row => [row.permission_key, row.granted]));
  } catch { return {}; }
}

// Set (or clear) an override for a user.
async function setUserOverride(userId, permKey, granted) {
  await ensureOverrideTable();
  if (granted === null) {
    // Clear the override — fall back to role default
    await db.query(
      `DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_key = $2`,
      [userId, permKey]
    );
  } else {
    await db.query(
      `INSERT INTO user_permission_overrides (user_id, permission_key, granted)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, permission_key)
       DO UPDATE SET granted = EXCLUDED.granted, updated_at = NOW()`,
      [userId, permKey, granted]
    );
  }
}

// Set many overrides at once. `perms` is { key: bool } — anything present is
// stored as an explicit override; anything absent (or matching role default)
// stays as the role default (nothing stored). Clears prior overrides first.
async function setUserOverridesBulk(userId, perms) {
  await ensureOverrideTable();
  await db.query(`DELETE FROM user_permission_overrides WHERE user_id = $1`, [userId]);
  const entries = Object.entries(perms || {});
  for (const [key, val] of entries) {
    if (typeof val !== "boolean") continue;
    if (!PERMISSIONS[key]) continue;  // ignore unknown keys
    await db.query(
      `INSERT INTO user_permission_overrides (user_id, permission_key, granted) VALUES ($1, $2, $3)`,
      [userId, key, val]
    );
  }
}

let _overrideTableReady = false;
async function ensureOverrideTable() {
  if (_overrideTableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      user_id        INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      permission_key TEXT NOT NULL,
      granted        BOOLEAN NOT NULL,
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, permission_key)
    )
  `);
  _overrideTableReady = true;
}

// Middleware factory: requires the user to have a specific permission.
// Use like:  app.post("/admin/users/new", requirePermission("users.manage"), handler)
function requirePermission(permKey) {
  return (req, res, next) => {
    if (!req.user) {
      if (req.method === "GET") {
        return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).json({ ok: false, error: "Not authenticated" });
    }
    if (!hasPermission(req.user, permKey)) {
      const roleLabel = ROLES[req.user.r]?.label || req.user.r;
      if (req.method === "GET") {
        return res.status(403).send(renderDeniedPage({
          userRole: roleLabel,
          permission: permKey,
        }));
      }
      return res.status(403).json({
        ok: false,
        error: `Access denied. Your role (${roleLabel}) doesn't have "${permKey}" permission.`,
      });
    }
    next();
  };
}

// Middleware: requires the user to have ONE of the listed roles.
// Simpler than requirePermission when you're just gating by role.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      if (req.method === "GET") {
        return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).json({ ok: false, error: "Not authenticated" });
    }
    if (!allowedRoles.includes(req.user.r)) {
      const roleLabel = ROLES[req.user.r]?.label || req.user.r;
      if (req.method === "GET") {
        return res.status(403).send(renderDeniedPage({
          userRole: roleLabel,
          requiredRoles: allowedRoles.map(r => ROLES[r]?.label || r).join(" or "),
        }));
      }
      return res.status(403).json({
        ok: false,
        error: `Access denied. This action requires ${allowedRoles.join(" or ")} role.`,
      });
    }
    next();
  };
}

function renderDeniedPage({ userRole, permission, requiredRoles }) {
  const needs = requiredRoles ? `role: ${requiredRoles}` : `permission: ${permission}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Access Denied</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f7f7f7;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:white;padding:40px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.08);max-width:480px;text-align:center}
h1{color:#c00;margin:0 0 12px 0}p{color:#555;line-height:1.5}
a{background:#0C1C36;color:white;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;margin-top:16px}</style></head>
<body><div class="card">
<div style="font-size:48px; margin-bottom:12px;">🔒</div>
<h1>Access Denied</h1>
<p>Your role (<strong>${escapeHtml(userRole)}</strong>) doesn't have access to this feature.</p>
<p style="font-size:12px; color:#888;">Required ${escapeHtml(needs)}</p>
<a href="/admin/">← Back to Dashboard</a>
</div></body></html>`;
}

let _sessionSecret = null;

// ── Schema ───────────────────────────────────────────────

async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id             SERIAL PRIMARY KEY,
      username       TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      full_name      TEXT,
      role           TEXT DEFAULT 'admin',
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      last_login_at  TIMESTAMPTZ,
      disabled       BOOLEAN DEFAULT FALSE
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS session_settings (
      id      INT PRIMARY KEY DEFAULT 1,
      secret  TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Session secret (self-generating) ─────────────────────

async function getSessionSecret() {
  if (_sessionSecret) return _sessionSecret;
  await initTables();
  const r = await db.query(`SELECT secret FROM session_settings WHERE id = 1`);
  if (r.rows[0]) {
    _sessionSecret = r.rows[0].secret;
    return _sessionSecret;
  }
  const newSecret = crypto.randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO session_settings (id, secret) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [newSecret]
  );
  // In case a race put a different value in — re-read
  const again = await db.query(`SELECT secret FROM session_settings WHERE id = 1`);
  _sessionSecret = again.rows[0].secret;
  return _sessionSecret;
}

// ── Password hashing ─────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPasswordHash(password, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    if (!salt || !hash) return false;
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    const a = Buffer.from(check, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Signed tokens ────────────────────────────────────────

async function makeToken(payload) {
  const secret = await getSessionSecret();
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

async function verifyToken(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [data, sig] = parts;
    const secret = await getSessionSecret();
    const expectedSig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Cookie helpers ───────────────────────────────────────

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  header.split(";").forEach(pair => {
    const idx = pair.indexOf("=");
    if (idx < 0) return;
    const k = pair.substring(0, idx).trim();
    const v = pair.substring(idx + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

function setSessionCookie(res, token, ttlMs) {
  const secure = process.env.NODE_ENV === "production" ||
                 process.env.RENDER === "true" ||
                 process.env.RENDER_EXTERNAL_URL;
  const maxAge = Math.floor(ttlMs / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ||
                 process.env.RENDER === "true" ||
                 process.env.RENDER_EXTERNAL_URL;
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

// ── User CRUD ────────────────────────────────────────────

async function countUsers() {
  await initTables();
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM admin_users WHERE disabled = FALSE`);
  return r.rows[0].n;
}

async function findUserByUsername(username) {
  await initTables();
  const r = await db.query(
    `SELECT id, username, password_hash, full_name, role, disabled
     FROM admin_users
     WHERE LOWER(username) = LOWER($1) AND disabled = FALSE`,
    [username.trim()]
  );
  return r.rows[0] || null;
}

async function createUser({ username, password, fullName, role = "admin" }) {
  await initTables();
  const clean = String(username || "").trim().toLowerCase();
  if (!clean || !/^[a-z0-9_.-]{2,32}$/.test(clean)) {
    throw new Error("Username must be 2–32 chars, letters/numbers/._- only");
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const hash = hashPassword(password);
  const r = await db.query(
    `INSERT INTO admin_users (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, username, full_name, role`,
    [clean, hash, fullName || null, role]
  );
  return r.rows[0];
}

async function updateLastLogin(userId) {
  await db.query(`UPDATE admin_users SET last_login_at = NOW() WHERE id = $1`, [userId]);
}

async function listUsers() {
  await initTables();
  const r = await db.query(
    `SELECT id, username, full_name, role, created_at, last_login_at, disabled
     FROM admin_users
     ORDER BY created_at ASC`
  );
  return r.rows;
}

async function deleteUser(id) {
  await db.query(`DELETE FROM admin_users WHERE id = $1`, [id]);
}

async function changePassword(userId, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const hash = hashPassword(newPassword);
  await db.query(`UPDATE admin_users SET password_hash = $1 WHERE id = $2`, [hash, userId]);
}

// ── Middleware ───────────────────────────────────────────

// Middleware for /admin/* — bypass for login/setup/logout,
// enforce authentication for everything else. If no users exist yet,
// redirect all /admin/* traffic to /admin/setup so JJ can create the
// first admin account.
async function requireAdminAuth(req, res, next) {
  try {
    // Whitelist — auth-adjacent endpoints must be reachable without auth.
    // /whoami is included because it's called by client-side JS to check
    // auth status; it returns { authenticated: false } when not logged in
    // instead of redirecting to login (which would break the JSON API).
    const path = req.path;
    const WHITELIST = new Set(["/login", "/logout", "/setup", "/whoami", "/whoami-early"]);
    if (WHITELIST.has(path)) return next();

    // Bootstrap: if no admin users exist, force setup
    const n = await countUsers();
    if (n === 0) {
      if (req.method === "GET") return res.redirect("/admin/setup");
      return res.status(403).json({ ok: false, error: "Setup required. Visit /admin/setup." });
    }

    // Check session cookie
    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    const payload = await verifyToken(token);
    if (!payload || !payload.uid) {
      if (req.method === "GET") {
        const nextUrl = encodeURIComponent(req.originalUrl || req.url);
        return res.redirect(`/admin/login?next=${nextUrl}`);
      }
      return res.status(401).json({ ok: false, error: "Not authenticated. Please log in." });
    }
    req.user = payload;
    next();
  } catch (err) {
    console.error("[auth middleware]:", err.message);
    res.status(500).send(`<h1>Auth error</h1><p>${err.message}</p>`);
  }
}

// ── Login flow handlers ──────────────────────────────────

function renderLoginPage({ error = null, nextUrl = "", username = "" } = {}) {
  const nextField = nextUrl ? `<input type="hidden" name="next" value="${escapeHtml(nextUrl)}">` : "";
  return `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — Tez Law Firm</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f7f7f7; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: white; padding: 40px 40px 30px 40px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); width: min(400px, 90vw); }
    h1 { color: #0C1C36; margin: 0 0 6px 0; font-size: 24px; text-align: center; }
    .brand { text-align: center; color: #B79C62; font-size: 12px; letter-spacing: 2px; margin-bottom: 24px; font-weight: 600; }
    label { display: block; margin: 12px 0 4px 0; color: #333; font-size: 13px; font-weight: 600; }
    input[type="text"], input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 15px; box-sizing: border-box; }
    input:focus { outline: none; border-color: #B79C62; }
    .row { display: flex; align-items: center; margin: 14px 0; font-size: 13px; color: #555; }
    .row input { margin-right: 6px; }
    button { width: 100%; padding: 12px; background: #0C1C36; color: white; border: none; border-radius: 4px; font-size: 15px; cursor: pointer; margin-top: 16px; font-weight: 600; }
    button:hover { background: #1a3057; }
    .err { background: #fee; color: #900; padding: 10px 12px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; border-left: 3px solid #c00; }
    .foot { text-align: center; color: #999; font-size: 11px; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">TEZ LAW P.C.</div>
    <h1>Sign in</h1>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/admin/login">
      ${nextField}
      <label for="username">Username</label>
      <input type="text" id="username" name="username" value="${escapeHtml(username)}" autofocus required autocomplete="username">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
      <div class="row">
        <input type="checkbox" id="remember" name="remember" value="1">
        <label for="remember" style="margin:0; font-weight:normal; cursor:pointer;">Remember me for 30 days</label>
      </div>
      <button type="submit">Sign in</button>
    </form>
    <div class="foot">Protect your rights — we handle the rest.</div>
  </div>
</body></html>`;
}

function renderSetupPage({ error = null, username = "", fullName = "" } = {}) {
  return `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Setup — Tez Law Firm</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f7f7f7; margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); width: min(500px, 90vw); }
    h1 { color: #0C1C36; margin: 0 0 6px 0; font-size: 26px; }
    .brand { color: #B79C62; font-size: 12px; letter-spacing: 2px; margin-bottom: 16px; font-weight: 600; }
    .intro { background: #fdf7f0; border-left: 3px solid #B79C62; padding: 12px 14px; border-radius: 4px; margin: 16px 0 20px 0; font-size: 13px; color: #555; }
    label { display: block; margin: 12px 0 4px 0; color: #333; font-size: 13px; font-weight: 600; }
    input[type="text"], input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 4px; font-size: 15px; box-sizing: border-box; }
    input:focus { outline: none; border-color: #B79C62; }
    .hint { font-size: 11px; color: #888; margin-top: 3px; }
    button { width: 100%; padding: 12px; background: #0C1C36; color: white; border: none; border-radius: 4px; font-size: 15px; cursor: pointer; margin-top: 20px; font-weight: 600; }
    .err { background: #fee; color: #900; padding: 10px 12px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; border-left: 3px solid #c00; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">TEZ LAW P.C.</div>
    <h1>Create the first admin account</h1>
    <div class="intro">
      Zara doesn't have any admin users yet. Create the first one below — this account will have full access.
      You can add more users later via the Admin Users page.
    </div>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/admin/setup">
      <label for="fullName">Full name</label>
      <input type="text" id="fullName" name="full_name" value="${escapeHtml(fullName)}" placeholder="e.g. JJ Zhang" required>

      <label for="username">Username</label>
      <input type="text" id="username" name="username" value="${escapeHtml(username)}" placeholder="e.g. jj" required autocomplete="username">
      <div class="hint">2–32 characters. Letters, numbers, dot, dash, underscore only.</div>

      <label for="password">Password</label>
      <input type="password" id="password" name="password" required autocomplete="new-password">
      <div class="hint">Minimum 8 characters. Use something strong.</div>

      <label for="password2">Confirm password</label>
      <input type="password" id="password2" name="password2" required autocomplete="new-password">

      <button type="submit">Create admin account</button>
    </form>
  </div>
</body></html>`;
}

// ── Route registration ───────────────────────────────────

function mount(app) {
  // Login page
  app.get("/admin/login", async (req, res) => {
    // If already logged in, bounce them home
    const cookies = parseCookies(req);
    const payload = await verifyToken(cookies[COOKIE_NAME]);
    if (payload && payload.uid) return res.redirect(req.query.next || "/admin/hearing/notes");
    // If no users exist, redirect to setup
    const n = await countUsers();
    if (n === 0) return res.redirect("/admin/setup");
    res.send(renderLoginPage({ nextUrl: req.query.next || "" }));
  });

  app.post("/admin/login", async (req, res) => {
    try {
      const username = String(req.body.username || "").trim();
      const password = String(req.body.password || "");
      const remember = !!req.body.remember;
      const nextUrl = String(req.body.next || "/admin/hearing/notes");
      if (!username || !password) {
        return res.send(renderLoginPage({ error: "Enter both username and password.", nextUrl, username }));
      }
      const user = await findUserByUsername(username);
      if (!user || !verifyPasswordHash(password, user.password_hash)) {
        return res.send(renderLoginPage({ error: "Wrong username or password.", nextUrl, username }));
      }
      const ttl = remember ? SESSION_TTL_LONG_MS : SESSION_TTL_MS;
      const token = await makeToken({
        uid: user.id,
        u: user.username,
        n: user.full_name,
        r: user.role,
        exp: Date.now() + ttl,
      });
      setSessionCookie(res, token, ttl);
      await updateLastLogin(user.id);
      // Consultants have their own portal — bounce them there instead of
      // the firm admin panel (which they can't see anyway).
      let safeNext;
      if (user.role === "consultant") {
        safeNext = nextUrl.startsWith("/consultant") ? nextUrl : "/consultant";
      } else {
        safeNext = (nextUrl.startsWith("/admin/") || nextUrl === "/admin") ? nextUrl : "/admin/hearing/notes";
      }
      res.redirect(safeNext);
    } catch (err) {
      console.error("[login]:", err.message);
      res.status(500).send(renderLoginPage({ error: "Login error: " + err.message }));
    }
  });

  app.post("/admin/logout", (req, res) => {
    clearSessionCookie(res);
    res.redirect("/admin/login");
  });
  app.get("/admin/logout", (req, res) => {
    clearSessionCookie(res);
    res.redirect("/admin/login");
  });
  // Aliases used by the consultant portal chrome (no /admin/ prefix)
  app.post("/logout", (req, res) => { clearSessionCookie(res); res.redirect("/admin/login"); });
  app.get("/logout", (req, res) => { clearSessionCookie(res); res.redirect("/admin/login"); });

  // Setup — only accessible while no admin users exist
  app.get("/admin/setup", async (req, res) => {
    const n = await countUsers();
    if (n > 0) return res.redirect("/admin/login");
    res.send(renderSetupPage());
  });

  app.post("/admin/setup", async (req, res) => {
    try {
      const n = await countUsers();
      if (n > 0) return res.redirect("/admin/login");
      const username = String(req.body.username || "").trim();
      const fullName = String(req.body.full_name || "").trim();
      const password = String(req.body.password || "");
      const password2 = String(req.body.password2 || "");
      if (password !== password2) {
        return res.send(renderSetupPage({ error: "Passwords don't match.", username, fullName }));
      }
      const user = await createUser({ username, password, fullName, role: "admin" });
      const token = await makeToken({
        uid: user.id, u: user.username, n: user.full_name, r: user.role,
        exp: Date.now() + SESSION_TTL_MS,
      });
      setSessionCookie(res, token, SESSION_TTL_MS);
      await updateLastLogin(user.id);
      res.redirect("/admin/hearing/notes");
    } catch (err) {
      console.error("[setup]:", err.message);
      res.send(renderSetupPage({ error: err.message, username: req.body.username, fullName: req.body.full_name }));
    }
  });

  // Current user info (for chrome to show "Logged in as X | Logout")
  app.get("/admin/whoami", async (req, res) => {
    const cookies = parseCookies(req);
    const payload = await verifyToken(cookies[COOKIE_NAME]);
    if (!payload || !payload.uid) return res.json({ ok: false, authenticated: false });
    // Compute effective permissions: role defaults + per-user overrides
    const perms = await getEffectivePermissions({ uid: payload.uid, r: payload.r });
    res.json({
      ok: true,
      authenticated: true,
      username: payload.u,
      name: payload.n,
      role: payload.r,
      role_label: ROLES[payload.r]?.label || payload.r,
      role_color: ROLES[payload.r]?.color || "#666",
      permissions: perms,
    });
  });

  // User management page — admin only
  app.get("/admin/users", requireRole("admin"), async (req, res) => {
    try {
      const users = await listUsers();
      const existingUsernames = new Set(users.map(u => u.username));

      const rows = users.map(u => {
        const roleInfo = ROLES[u.role] || { label: u.role, color: "#666" };
        return `
        <tr>
          <td><strong>${escapeHtml(u.username)}</strong></td>
          <td>${escapeHtml(u.full_name || "")}</td>
          <td>
            <span style="background:${roleInfo.color}; color:white; padding:3px 8px; border-radius:10px; font-size:11px; font-weight:600;">${escapeHtml(roleInfo.label)}</span>
          </td>
          <td>${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '<span style="color:#c00; font-style:italic;">never</span>'}</td>
          <td>${new Date(u.created_at).toLocaleDateString()}</td>
          <td>
            ${req.user && req.user.uid !== u.id
              ? `<button type="button" onclick="editUser(${u.id}, '${escapeHtml(u.username)}', '${escapeHtml(u.role)}')" style="background:#eee; color:#333; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:11px; margin-right:4px;">Edit role</button>
                 <a href="/admin/users/${u.id}/permissions" style="background:#0C1C36; color:white; text-decoration:none; padding:5px 10px; border-radius:3px; font-size:11px; margin-right:4px; display:inline-block;">🔐 Permissions</a>
                 <button type="button" onclick="resetUserPassword(${u.id}, '${escapeHtml(u.username)}')" style="background:#B79C62; color:white; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:11px; margin-right:4px;">Reset password</button>
                 <form method="POST" action="/admin/users/${u.id}/delete" style="display:inline;" onsubmit="return confirm('Delete user ${escapeHtml(u.username)}? This cannot be undone.');"><button type="submit" style="background:#c00; color:white; border:none; padding:4px 10px; border-radius:3px; cursor:pointer; font-size:11px;">Delete</button></form>`
              : `<a href="/admin/users/${u.id}/permissions" style="background:#0C1C36; color:white; text-decoration:none; padding:5px 10px; border-radius:3px; font-size:11px; display:inline-block;">🔐 My permissions</a>`}
          </td>
        </tr>`;
      }).join("");

      // Known Tez Law staff members — quick-add buttons pre-fill the form
      const KNOWN_STAFF = [
        { username: "chandler",    full_name: "Chandler Jin",   role: "attorney",  note: "Associate Attorney (NY Bar)" },
        { username: "jue",         full_name: "Jue Wang",       role: "paralegal", note: "Case Manager / Paralegal" },
        { username: "michael",     full_name: "Michael Liu",    role: "paralegal", note: "Immigration Court Specialist" },
        { username: "linmei",      full_name: "Lin Mei",        role: "paralegal", note: "Personal Injury" },
      ];
      const missingStaff = KNOWN_STAFF.filter(s => !existingUsernames.has(s.username));
      const quickAddHTML = missingStaff.length ? `
        <div style="background:#fdf7f0; padding:15px 20px; border-radius:6px; margin-bottom:15px; border-left:4px solid #B79C62;">
          <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:8px;">
            <div>
              <strong style="color:#0C1C36;">⚡ Quick-add Tez Law staff</strong>
              <div style="font-size:12px; color:#666; margin-top:3px;">Click a name to pre-fill the form below. Set a strong temporary password and share with the person.</div>
            </div>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px;">
            ${missingStaff.map(s => `
              <button type="button" onclick="quickAddStaff(${JSON.stringify(s).replace(/"/g, "&quot;")})" style="background:white; border:1px solid #B79C62; color:#0C1C36; padding:6px 10px; border-radius:4px; cursor:pointer; font-size:12px;">
                <strong>${escapeHtml(s.full_name)}</strong>
                <span style="color:#666; font-size:11px; margin-left:6px;">${escapeHtml(s.note)}</span>
              </button>
            `).join("")}
          </div>
        </div>
      ` : "";

      // Role legend — helps JJ pick the right one
      const roleLegend = `
        <div style="background:white; padding:15px 20px; border-radius:6px; margin-bottom:15px; border:1px solid #eee;">
          <strong style="color:#0C1C36;">📋 Role permissions</strong>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px; margin-top:10px;">
            ${Object.entries(ROLES).map(([key, r]) => `
              <div style="border-left:3px solid ${r.color}; padding:8px 12px;">
                <div style="font-weight:600; color:${r.color}; margin-bottom:3px; font-size:13px;">${escapeHtml(r.label)}</div>
                <div style="font-size:11px; color:#666; line-height:1.4;">${escapeHtml(r.description)}</div>
              </div>
            `).join("")}
          </div>
        </div>`;

      const roleOptionsHTML = Object.entries(ROLES).map(([key, r]) =>
        `<option value="${key}">${escapeHtml(r.label)} — ${escapeHtml(r.description)}</option>`
      ).join("");

      const hearingNotes = require("./hearing-notes");
      const body = `
        <div class="page-header"><h1>👤 Admin Users</h1></div>

        ${quickAddHTML}
        ${roleLegend}

        <table style="background:white;">
          <thead>
            <tr><th>Username</th><th>Full name</th><th>Role</th><th>Last login</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <div style="background:white; padding:20px; border-radius:6px; margin-top:20px; border:1px solid #eee;">
          <h3 style="margin:0 0 12px 0; color:#0C1C36;">➕ Add a user</h3>
          <form method="POST" action="/admin/users/new">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <div>
                <label style="font-size:12px; color:#666; display:block; margin-bottom:3px;">Full name</label>
                <input type="text" name="full_name" id="new_full_name" required style="width:100%; padding:9px; border:1px solid #ccc; border-radius:3px; box-sizing:border-box;">
              </div>
              <div>
                <label style="font-size:12px; color:#666; display:block; margin-bottom:3px;">Username (letters/numbers/._-, 2–32 chars)</label>
                <input type="text" name="username" id="new_username" required pattern="[a-z0-9_.\\-]{2,32}" style="width:100%; padding:9px; border:1px solid #ccc; border-radius:3px; box-sizing:border-box;">
              </div>
              <div>
                <label style="font-size:12px; color:#666; display:block; margin-bottom:3px;">Password (min 8 chars)</label>
                <input type="password" name="password" required minlength="8" style="width:100%; padding:9px; border:1px solid #ccc; border-radius:3px; box-sizing:border-box;">
              </div>
              <div>
                <label style="font-size:12px; color:#666; display:block; margin-bottom:3px;">Role</label>
                <select name="role" id="new_role" style="width:100%; padding:9px; border:1px solid #ccc; border-radius:3px; box-sizing:border-box;">${roleOptionsHTML}</select>
              </div>
            </div>
            <div style="margin-top:14px; text-align:right;">
              <button type="submit" style="background:#0C1C36; color:white; padding:10px 18px; border:none; border-radius:4px; cursor:pointer; font-weight:600;">Create user</button>
            </div>
          </form>
        </div>

        <div style="background:#f9f9f9; padding:15px 20px; border-radius:6px; margin-top:20px; font-size:13px; color:#666; border-left:3px solid #B79C62;">
          <strong>🔑 Change your password:</strong>
          <form method="POST" action="/admin/users/change-password" style="display:inline-flex; gap:6px; align-items:center; margin-left:8px;">
            <input type="password" name="new_password" placeholder="new password (min 8 chars)" required minlength="8" style="padding:6px 10px; border:1px solid #ccc; border-radius:3px; width:200px;">
            <button type="submit" style="background:#B79C62; color:white; padding:6px 12px; border:none; border-radius:3px; cursor:pointer; font-size:12px;">Change</button>
          </form>
          <div style="font-size:11px; margin-top:4px; color:#888;">You'll be signed out and asked to log in again after changing.</div>
        </div>

        <script>
          function quickAddStaff(staff) {
            document.getElementById("new_full_name").value = staff.full_name;
            document.getElementById("new_username").value = staff.username;
            document.getElementById("new_role").value = staff.role;
            document.querySelector('input[name="password"]').focus();
            // Scroll to the form
            document.querySelector('input[name="password"]').scrollIntoView({ behavior: "smooth", block: "center" });
          }
          function editUser(id, username, currentRole) {
            const roleOptions = ${JSON.stringify(Object.entries(ROLES).map(([k,r]) => ({k, l: r.label})))};
            let promptOptions = "Change role for " + username + "\\n\\nAvailable roles:\\n";
            roleOptions.forEach((r, i) => { promptOptions += (i+1) + ". " + r.l + " (" + r.k + ")\\n"; });
            const choice = prompt(promptOptions + "\\nEnter role key (e.g. attorney, paralegal, viewer, admin):", currentRole);
            if (!choice || choice === currentRole) return;
            if (!roleOptions.some(r => r.k === choice)) { alert("Invalid role: " + choice); return; }
            fetch("/admin/users/" + id + "/role", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "role=" + encodeURIComponent(choice),
            }).then(r => r.json()).then(d => {
              if (d.ok) location.reload();
              else alert("Error: " + (d.error || "unknown"));
            });
          }
          async function resetUserPassword(id, username) {
            if (!confirm("Reset password for " + username + "?\\n\\nA new temporary password will be generated. You'll need to share it with the user via a secure channel (WhatsApp, phone, in-person). Their existing password will stop working immediately.")) return;
            try {
              const resp = await fetch("/admin/users/" + id + "/reset-password", { method: "POST" });
              const data = await resp.json();
              if (!data.ok) { alert("Error: " + (data.error || "unknown")); return; }
              // Show the temp password in a modal so admin can copy it
              const modal = document.createElement("div");
              modal.style.cssText = "position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:10000; display:flex; align-items:center; justify-content:center;";
              modal.innerHTML =
                '<div style="background:white; padding:30px; border-radius:8px; max-width:480px; box-shadow:0 20px 60px rgba(0,0,0,0.3);">' +
                  '<h2 style="margin:0 0 12px 0; color:#0C1C36;">🔑 Password reset</h2>' +
                  '<p style="color:#666; font-size:13px;">Share this temporary password with <strong>' + data.full_name + '</strong> (' + data.username + ') via a secure channel. It will only be shown once.</p>' +
                  '<div style="background:#fdf7f0; padding:15px; border-radius:6px; text-align:center; margin:15px 0; border:2px solid #B79C62;">' +
                    '<code style="font-size:22px; font-weight:600; color:#0C1C36; letter-spacing:2px; font-family:monospace;">' + data.temporary_password + '</code>' +
                  '</div>' +
                  '<div style="display:flex; gap:8px; justify-content:flex-end;">' +
                    '<button onclick="navigator.clipboard.writeText(\\'' + data.temporary_password + '\\'); this.textContent=\\'Copied\\';" style="background:#eee; padding:8px 14px; border:none; border-radius:4px; cursor:pointer;">📋 Copy</button>' +
                    '<button onclick="this.closest(\\'div\\').parentElement.parentElement.remove()" style="background:#0C1C36; color:white; padding:8px 14px; border:none; border-radius:4px; cursor:pointer;">Done</button>' +
                  '</div>' +
                  '<div style="font-size:11px; color:#888; margin-top:12px;">The user should log in and immediately change their password via the "Change your password" box.</div>' +
                '</div>';
              document.body.appendChild(modal);
            } catch (e) {
              alert("Error: " + e.message);
            }
          }
        </script>
      `;
      res.send(hearingNotes.renderAdminChrome({ title: "Admin Users", body, activeItem: "users" }));
    } catch (err) {
      res.status(500).send(`<h1>Error</h1><p>${escapeHtml(err.message)}</p>`);
    }
  });

  app.post("/admin/users/new", requireRole("admin"), async (req, res) => {
    try {
      await createUser({
        username: req.body.username,
        password: req.body.password,
        fullName: req.body.full_name,
        role: req.body.role || "paralegal",
      });
      res.redirect("/admin/users");
    } catch (err) {
      res.status(400).send(`<h1>Error</h1><p>${escapeHtml(err.message)}</p><p><a href="/admin/users">← Back</a></p>`);
    }
  });

  app.post("/admin/users/:id/delete", requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).send("Invalid id");
      if (req.user && req.user.uid === id) {
        return res.status(400).send(`<h1>Cannot delete your own account</h1><p><a href="/admin/users">← Back</a></p>`);
      }
      await deleteUser(id);
      res.redirect("/admin/users");
    } catch (err) {
      res.status(500).send(`<h1>Error</h1><p>${escapeHtml(err.message)}</p>`);
    }
  });

  app.post("/admin/users/:id/role", requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const newRole = String(req.body.role || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
      if (!ROLES[newRole]) return res.status(400).json({ ok: false, error: "Invalid role" });
      if (req.user && req.user.uid === id && newRole !== "admin") {
        return res.status(400).json({ ok: false, error: "You cannot demote yourself. Have another admin change your role." });
      }
      await db.query(`UPDATE admin_users SET role = $1 WHERE id = $2`, [newRole, id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/users/change-password", async (req, res) => {
    try {
      if (!req.user) return res.status(401).send("Not authenticated");
      await changePassword(req.user.uid, req.body.new_password);
      clearSessionCookie(res);
      res.redirect("/admin/login");
    } catch (err) {
      res.status(400).send(`<h1>Error</h1><p>${escapeHtml(err.message)}</p><p><a href="/admin/users">← Back</a></p>`);
    }
  });

  // Admin-initiated password reset: generates a random temporary password
  // and shows it to the admin ONCE. Admin shares it with the user via secure
  // channel (in-person, phone, WhatsApp). User must change it after login.
  app.post("/admin/users/:id/reset-password", requireRole("admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
      const user = await db.query(`SELECT username, full_name FROM admin_users WHERE id = $1`, [id]);
      if (!user.rows[0]) return res.status(404).json({ ok: false, error: "User not found" });
      // Generate a strong random password (12 chars, mixed case + digits)
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      let tempPassword = "";
      for (let i = 0; i < 12; i++) tempPassword += chars[Math.floor(Math.random() * chars.length)];
      await changePassword(id, tempPassword);
      res.json({
        ok: true,
        username: user.rows[0].username,
        full_name: user.rows[0].full_name,
        temporary_password: tempPassword,
        message: "Password reset. Share the temporary password with the user via a secure channel. They should change it after login via the 'Change your password' box.",
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Per-user permission overrides ────────────────────────────────
  // Checkbox UI lets JJ toggle exactly what each user can see, on top of
  // (and overriding) their role defaults.

  // Human-friendly grouping of permission keys → what JJ sees in the UI.
  // The order defines the UI section order. Groups without matching keys are
  // omitted automatically. Any permission key not listed here will be shown
  // under "Other" so nothing silently disappears.
  const PERMISSION_GROUPS = [
    { label: "Overview & Landing", keys: [
      "dashboard.access", "clients.read", "clients.write",
      "calendar.read", "deadlines.read", "deadlines.write",
      "tasks.read", "tasks.write",
      "analytics.read", "mobile.search",
    ]},
    { label: "Immigration Hearings & Motions", keys: [
      "notes.master", "notes.individual", "notes.history",
      "hearings.read", "hearings.write",
      "motions.read", "motions.write",
    ]},
    { label: "Federal & Trademarks", keys: [
      "federal.read", "federal.write",
    ]},
    { label: "Personal Injury", keys: [
      "pi.read", "pi.write",
    ]},
    { label: "Accounting", keys: [
      "accounting.read", "accounting.write",
    ]},
    { label: "Notices, Dropbox, Matters, Content", keys: [
      "notices.read", "notices.write", "notices.send",
      "dropbox.files.read", "dropbox.files.write",
      "matters.access",
      "content.read", "content.write",
      "intake.access", "pipeline.access", "drip.access",
    ]},
    { label: "Consultant Portal (Referral Partners)", keys: [
      "consultant.portal", "consultant.submit", "consultant.track",
    ]},
    { label: "Firm & Admin Configuration", keys: [
      "users.manage", "admin_panel.access",
      "dropbox.setup", "email.setup", "outlook.setup",
      "system.settings",
    ]},
  ];

  // Human-friendly label for each permission key (falls back to the key itself)
  const PERMISSION_LABELS = {
    "dashboard.access": "Access dashboard (landing page)",
    "clients.read": "View clients page",
    "clients.write": "Create/edit clients",
    "calendar.read": "View calendar",
    "deadlines.read": "View deadlines page",
    "deadlines.write": "Create/edit deadlines",
    "tasks.read": "View task list",
    "tasks.write": "Create/edit tasks",
    "analytics.read": "View analytics / reports",
    "mobile.search": "Mobile search app",
    "notes.master": "Master Notes (sidebar link)",
    "notes.individual": "Individual Notes (sidebar link)",
    "notes.history": "Hearing History (sidebar link)",
    "notes.list": "[legacy alias — use master/individual/history above]",
    "hearings.read": "Read hearing notes (individual notes)",
    "hearings.write": "Create/edit hearing notes",
    "motions.read": "View court motions",
    "motions.write": "Create/edit motions",
    "federal.read": "View Federal & TM matters (all sidebar links)",
    "federal.write": "Create/edit Federal & TM matters",
    "pi.read": "View PI (all sidebar links + brokers)",
    "pi.write": "Create/edit PI cases",
    "accounting.read": "View accounting (Ledger, IOLTA, IS/BS, QBO — all links)",
    "accounting.write": "Create accounting entries + QBO push",
    "notices.read": "View hearing notices",
    "notices.write": "Edit hearing notices",
    "notices.send": "Send hearing notices to clients",
    "dropbox.files.read": "View / download Dropbox files",
    "dropbox.files.write": "Upload / delete Dropbox files",
    "matters.access": "Intake, Pipeline, Drip, Conflicts, SOL, Research (all Matters Manager links)",
    "content.read": "View blog / website content",
    "content.write": "Edit blog / website content",
    "intake.access": "Intake console",
    "pipeline.access": "Sales pipeline",
    "drip.access": "Drip campaigns",
    "users.manage": "Manage users & permissions",
    "admin_panel.access": "Admin panel entry",
    "dropbox.setup": "Configure Dropbox integration",
    "email.setup": "Configure email integration",
    "outlook.setup": "Configure Outlook integration",
    "system.settings": "System settings",
    "consultant.portal": "Access consultant portal (external referral partners)",
    "consultant.submit": "Submit new work orders / leads to the firm",
    "consultant.track": "Track own submitted work orders",
  };

  app.get("/admin/users/:id/permissions", requireRole("admin"), async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      const r = await db.query(`SELECT id, username, full_name, role FROM admin_users WHERE id = $1`, [userId]);
      if (!r.rows.length) return res.status(404).send("User not found");
      const user = r.rows[0];
      const roleInfo = ROLES[user.role] || { label: user.role, color: "#666" };
      const overrides = await getUserOverridesMap(userId);

      // Build all groups; capture keys not covered so we can render an "Other" bucket
      const usedKeys = new Set();
      const groupBlocks = PERMISSION_GROUPS.map(g => {
        const keys = g.keys.filter(k => PERMISSIONS[k]);
        keys.forEach(k => usedKeys.add(k));
        if (!keys.length) return "";
        return renderPermGroup(g.label, keys, user.role, overrides);
      }).join("");
      const otherKeys = Object.keys(PERMISSIONS).filter(k => !usedKeys.has(k));
      const otherBlock = otherKeys.length ? renderPermGroup("Other", otherKeys, user.role, overrides) : "";

      // Prefer the admin chrome (with sidebar) so nav is consistent
      let hearingNotes;
      try { hearingNotes = require("./hearing-notes"); } catch { hearingNotes = null; }

      const body = `
        <div class="page-header">
          <h1>🔐 Permissions — ${escapeHtml(user.full_name || user.username)}</h1>
          <a href="/admin/users" class="back-link">← Users</a>
        </div>

        <div style="background:#f5f9ff; padding:14px 16px; border-radius:8px; border-left:4px solid #0061FF; margin-bottom:16px; font-size:13px;">
          <strong>Role default:</strong> <span style="background:${roleInfo.color}; color:white; padding:2px 8px; border-radius:8px; font-size:11px; font-weight:600;">${escapeHtml(roleInfo.label)}</span>
          &nbsp;·&nbsp; Checkboxes below override the role default per-permission. <strong>Green rows</strong> = matches role default. <strong>Yellow rows</strong> = you've overridden. Unchecking a green box denies it; checking a red box grants it.
        </div>

        <form id="permForm">
          ${groupBlocks}${otherBlock}

          <div style="margin-top:20px; display:flex; gap:10px; align-items:center;">
            <button type="button" onclick="savePerms()" id="saveBtn" style="background:#0C1C36; color:white; padding:12px 24px; border:none; border-radius:6px; cursor:pointer; font-weight:600;">💾 Save Permissions</button>
            <button type="button" onclick="resetToRoleDefaults()" style="background:#f5f2ea; color:#0C1C36; padding:12px 24px; border:1px solid #B79C62; border-radius:6px; cursor:pointer;">↺ Reset to Role Defaults</button>
            <span id="permStatus" style="color:#666; font-size:12px; margin-left:10px;"></span>
          </div>
        </form>

        <script>
          async function savePerms() {
            const btn = document.getElementById("saveBtn");
            btn.disabled = true; btn.textContent = "⏳ Saving…";
            const perms = {};
            document.querySelectorAll('input[type=checkbox][data-perm-key]').forEach(cb => {
              perms[cb.dataset.permKey] = cb.checked;
            });
            try {
              const r = await fetch("/admin/users/${userId}/permissions", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ permissions: perms }),
              });
              const d = await r.json();
              if (d.ok) {
                document.getElementById("permStatus").textContent = "✓ Saved";
                document.getElementById("permStatus").style.color = "#2e7d32";
                setTimeout(() => location.reload(), 700);
              } else {
                alert("Error: " + d.error);
                btn.disabled = false; btn.textContent = "💾 Save Permissions";
              }
            } catch (e) {
              alert("Network error: " + e.message);
              btn.disabled = false; btn.textContent = "💾 Save Permissions";
            }
          }
          async function resetToRoleDefaults() {
            if (!confirm("Clear all per-user overrides and reset to role defaults?")) return;
            const r = await fetch("/admin/users/${userId}/permissions/reset", { method: "POST" });
            if (r.ok) location.reload();
          }
        </script>`;

      if (hearingNotes && hearingNotes.renderAdminChrome) {
        res.send(hearingNotes.renderAdminChrome({ title: "User Permissions", body, activeItem: "users" }));
      } else {
        res.send(`<html><head><title>Permissions</title><style>body{font-family:system-ui;padding:20px;max-width:960px;margin:auto;background:#faf9f5;} .page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;} .back-link{color:#666;text-decoration:none;}</style></head><body>${body}</body></html>`);
      }
    } catch (err) {
      console.error("[permissions page]:", err.message);
      res.status(500).send("Error: " + err.message);
    }
  });

  // Render one collapsible permission group as a table of checkboxes
  function renderPermGroup(label, keys, userRole, overrides) {
    const rows = keys.map(k => {
      const roleGranted = (PERMISSIONS[k] || []).includes(userRole);
      const hasOverride = overrides[k] !== undefined;
      const effective = hasOverride ? overrides[k] : roleGranted;
      const bg = hasOverride ? "#fff8e1" : (effective ? "#e8f5e9" : "#fafaf7");
      const explainer = hasOverride
        ? (effective ? "✎ Overridden ON" : "✎ Overridden OFF")
        : (effective ? "Role default: ON" : "Role default: OFF");
      const explainerColor = hasOverride ? "#e65100" : (effective ? "#2e7d32" : "#999");
      return `
        <tr style="background:${bg};">
          <td style="padding:10px 14px; border-bottom:1px solid #eee;">
            <label style="display:flex; align-items:center; gap:10px; cursor:pointer;">
              <input type="checkbox" data-perm-key="${escapeHtml(k)}" ${effective ? "checked" : ""} style="width:18px; height:18px; cursor:pointer;">
              <div>
                <div style="font-size:13px; color:#0C1C36;">${escapeHtml(PERMISSION_LABELS[k] || k)}</div>
                <div style="font-size:10px; color:#888; font-family:ui-monospace, Menlo, monospace; margin-top:2px;">${escapeHtml(k)}</div>
              </div>
            </label>
          </td>
          <td style="padding:10px 14px; border-bottom:1px solid #eee; text-align:right; font-size:11px; color:${explainerColor}; font-weight:${hasOverride ? "600" : "400"};">
            ${explainer}
          </td>
        </tr>`;
    }).join("");
    return `
      <div style="background:white; border-radius:8px; border:1px solid #eee; margin-bottom:12px; overflow:hidden;">
        <div style="padding:10px 16px; background:#0C1C36; color:white; font-weight:600; font-size:13px;">${escapeHtml(label)}</div>
        <table style="width:100%; border-collapse:collapse;">
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  app.post("/admin/users/:id/permissions", requireRole("admin"), async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      const r = await db.query(`SELECT role FROM admin_users WHERE id = $1`, [userId]);
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "User not found" });
      const userRole = r.rows[0].role;

      // Only store checkboxes that DIFFER from the role default.
      // If a checkbox matches the role default, we don't need to store an override
      // (that way changing the role in the future picks up new defaults automatically).
      const submitted = req.body?.permissions || {};
      const toStore = {};
      for (const [key, val] of Object.entries(submitted)) {
        if (typeof val !== "boolean") continue;
        if (!PERMISSIONS[key]) continue;
        const roleDefault = (PERMISSIONS[key] || []).includes(userRole);
        if (val !== roleDefault) toStore[key] = val;  // only store deviations
      }
      await setUserOverridesBulk(userId, toStore);
      res.json({ ok: true, overrides_stored: Object.keys(toStore).length });
    } catch (err) {
      console.error("[permissions save]:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/admin/users/:id/permissions/reset", requireRole("admin"), async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      await setUserOverridesBulk(userId, {});
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = {
  initTables,
  requireAdminAuth,
  requireRole,
  requirePermission,
  hasPermission,
  hasPermissionAsync,
  getEffectivePermissions,
  getUserOverride,
  getUserOverridesMap,
  setUserOverride,
  setUserOverridesBulk,
  ensureOverrideTable,
  mount,
  createUser,
  findUserByUsername,
  countUsers,
  hashPassword,
  verifyPasswordHash,
  verifyToken,
  parseCookies,
  ROLES,
  PERMISSIONS,
  COOKIE_NAME,
};
