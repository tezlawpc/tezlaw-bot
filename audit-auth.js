// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-auth.js — SELF-CONTAINED AUTHENTICATION
//  ─────────────────────────────────────────────────────────
//  Deliberately independent of the host app's admin auth.
//
//  Why: external auditors get accounts here. TAAD's engagement
//  team must be able to sign in, see the PBC status and download
//  documents — and must NOT inherit any access to the host
//  application, see its navigation, or appear in its user list.
//  Equally, Nightfood's controller should not need an account in
//  a law firm's system to upload a bank reconciliation.
//
//  So this module owns its own users table, its own cookie
//  (`ngtfaudit`), its own roles and its own login pages. The only
//  shared dependency is db.js. That also means the whole /audit
//  tree can be lifted into its own Render service later by
//  copying these files and pointing DATABASE_URL at its own
//  database — no untangling required.
//
//  Mechanics mirror the host app's proven approach: scrypt password
//  hashing and HMAC-signed stateless session cookies, both from
//  Node's built-in crypto. No new dependencies, no session store.
//
//  SEGREGATION NOTE: 'auditor' users are READ + ANNOTATE only.
//  They can never upload a document, answer a sweep question, or
//  satisfy a checklist item. That is not a UI convenience — under
//  Rule 2-01(c)(4) an auditor who prepares the client's records
//  or performs management functions is not independent. The
//  permission matrix enforces the boundary structurally so the
//  portal cannot become an independence problem.
// ============================================================

const crypto = require("crypto");
const db = require("./db");

const COOKIE_NAME = "ngtfaudit";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — shorter than a general admin tool
const SESSION_TTL_LONG_MS = 7 * 24 * 60 * 60 * 1000; // 7d "remember me"

// ── Roles ────────────────────────────────────────────────
const ROLES = {
  portal_admin: {
    label: "Portal Administrator",
    org: "company",
    color: "#1F3A5F",
    description: "Manages users, engagements and portal settings. Full company-side access.",
  },
  company_admin: {
    label: "Company — Finance Lead (CEO/CFO)",
    org: "company",
    color: "#2C5F8A",
    description:
      "Uploads, answers sweep questions, signs off checklists, requests waivers, archives engagements.",
  },
  company_contributor: {
    label: "Company — Contributor (Controller / Staff)",
    org: "company",
    color: "#17706E",
    description: "Uploads documents and answers assigned sweep questions. Cannot waive items or archive.",
  },
  auditor_lead: {
    label: "Auditor — Engagement Partner / Manager",
    org: "auditor",
    color: "#9C4221",
    description:
      "Downloads everything, accepts or rejects PBC items, raises review notes, sets the report release date " +
      "and triggers the AS 1215 archive. Cannot upload or answer on the company's behalf.",
  },
  auditor_staff: {
    label: "Auditor — Engagement Staff",
    org: "auditor",
    color: "#B45309",
    description: "Downloads and comments. Cannot accept items, archive, or upload.",
  },
  audit_committee: {
    label: "Audit Committee Member",
    org: "committee",
    color: "#6B21A8",
    description:
      "Read-only. Sees status dashboards, the AS 1301 communication package, open review notes and gate status. " +
      "No document downloads by default.",
  },
};

// ── Permission matrix ────────────────────────────────────
// A permission not listed for a role is denied.
const PERMISSIONS = {
  "portal.users": ["portal_admin"],
  "portal.settings": ["portal_admin"],
  "engagement.create": ["portal_admin", "company_admin"],
  "engagement.archive": ["portal_admin", "auditor_lead"],
  "engagement.set_report_date": ["portal_admin", "auditor_lead"],
  "engagement.legal_hold": ["portal_admin", "auditor_lead"],

  // Upload is company-side ONLY — Rule 2-01(c)(4)(i) independence.
  "document.upload": ["portal_admin", "company_admin", "company_contributor"],
  "document.reclassify": ["portal_admin", "company_admin", "company_contributor", "auditor_lead"],
  "document.download": ["portal_admin", "company_admin", "company_contributor", "auditor_lead", "auditor_staff"],
  "document.download_confidential": ["portal_admin", "company_admin", "auditor_lead", "auditor_staff"],
  "document.supersede": ["portal_admin", "company_admin", "company_contributor"],
  "document.view_all": [
    "portal_admin",
    "company_admin",
    "company_contributor",
    "auditor_lead",
    "auditor_staff",
    "audit_committee",
  ],

  // Answering sweeps is company-side ONLY.
  "checklist.answer": ["portal_admin", "company_admin", "company_contributor"],
  "checklist.waive": ["portal_admin", "company_admin"],
  "checklist.accept": ["auditor_lead"],
  "checklist.reject": ["auditor_lead", "auditor_staff"],
  "checklist.generate": ["portal_admin", "company_admin"],
  "checklist.view": [
    "portal_admin",
    "company_admin",
    "company_contributor",
    "auditor_lead",
    "auditor_staff",
    "audit_committee",
  ],

  "comment.write": ["portal_admin", "company_admin", "company_contributor", "auditor_lead", "auditor_staff"],
  "comment.resolve": ["portal_admin", "company_admin", "auditor_lead"],

  "dashboard.view": [
    "portal_admin",
    "company_admin",
    "company_contributor",
    "auditor_lead",
    "auditor_staff",
    "audit_committee",
  ],
  "events.view": ["portal_admin", "company_admin", "auditor_lead", "auditor_staff", "audit_committee"],
};

function can(user, permission) {
  if (!user || !user.role) return false;
  const allowed = PERMISSIONS[permission];
  if (!allowed) return false;
  return allowed.includes(user.role);
}

function permissionsFor(role) {
  const out = {};
  Object.keys(PERMISSIONS).forEach((p) => (out[p] = PERMISSIONS[p].includes(role)));
  return out;
}

// ── Password hashing (scrypt, no dependencies) ───────────
//
// ASYNC, deliberately. scryptSync costs ~40ms of BLOCKED EVENT LOOP,
// and this router is mounted inside a larger application — so a burst
// of login attempts against /audit would stall every other request the
// host app is serving, not just this portal's. The async form hands the
// work to libuv's threadpool and leaves the loop free.
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt)).toString("hex");
  return `${salt}:${hash}`;
}

async function verifyPasswordHash(password, stored) {
  try {
    const [salt, hash] = String(stored || "").split(":");
    if (!salt || !hash) return false;
    const check = await scrypt(password, salt);
    const b = Buffer.from(hash, "hex");
    if (check.length !== b.length) return false;
    return crypto.timingSafeEqual(check, b);
  } catch {
    return false;
  }
}

// A fixed hash to compare against when the account does not exist, so
// an unknown email costs the same ~40ms as a known one. Without this,
// a known address answered in ~45ms and an unknown one in ~1ms — a 40x
// gap that lets anyone enumerate which members of the engagement team
// hold accounts on this issuer's portal.
const DUMMY_SALT = "0".repeat(32);
let _dummyHash = null;
async function burnTime() {
  if (!_dummyHash) _dummyHash = (await scrypt("not-a-real-password", DUMMY_SALT)).toString("hex");
  await scrypt("not-a-real-password", DUMMY_SALT);
}

// ── Session secret (self-generating, persists in DB) ─────
let _secret = null;
async function getSessionSecret() {
  if (_secret) return _secret;
  const r = await db.query(`SELECT secret FROM ngtf_audit_session_settings WHERE id = 1`);
  if (r.rows.length) {
    _secret = r.rows[0].secret;
    return _secret;
  }
  const fresh = crypto.randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO ngtf_audit_session_settings (id, secret) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [fresh]
  );
  const again = await db.query(`SELECT secret FROM ngtf_audit_session_settings WHERE id = 1`);
  _secret = again.rows[0].secret;
  return _secret;
}

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
    const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Cookies ──────────────────────────────────────────────
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  header.split(";").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i < 0) return;
    const k = pair.substring(0, i).trim();
    const v = pair.substring(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  });
  return out;
}

/** Where the router is mounted, for building redirects. */
function mountBase() {
  return process.env.AUDIT_BASE_PATH || "/audit";
}

// Secure by DEFAULT. The old version sniffed for NODE_ENV=production or
// Render-specific variables and silently issued the session cookie
// without `Secure` anywhere else — a staging box, a client-hosted
// deployment, or a container image missing one env var would send this
// portal's session over plaintext HTTP. Opting out is now explicit.
function isSecureEnv() {
  return process.env.AUDIT_INSECURE_COOKIES !== "1";
}

function setSessionCookie(res, token, ttlMs) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    // Scoped to the mount point so the portal session is not sent on
    // every request to the host application's own routes.
    `Path=${mountBase()}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (isSecureEnv()) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, `Path=${mountBase()}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureEnv()) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

function appendSetCookie(res, value) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", value);
  else res.setHeader("Set-Cookie", Array.isArray(prev) ? prev.concat(value) : [prev, value]);
}

// ── User CRUD ────────────────────────────────────────────
async function countUsers() {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM ngtf_audit_users WHERE active = TRUE`);
  return r.rows[0].n;
}

async function createUser({ email, name, org, role, password, firmName, title, phone }) {
  if (!email || !name) throw new Error("email and name are required");
  if (!ROLES[role]) throw new Error(`Unknown role "${role}"`);
  const e = String(email).trim().toLowerCase();
  const pwHash = password ? await hashPassword(password) : null;
  const r = await db.query(
    `INSERT INTO ngtf_audit_users (email, name, org, role, firm_name, title, phone, password_hash, must_reset)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, email, name, org, role`,
    [
      e,
      name,
      org || ROLES[role].org,
      role,
      firmName || null,
      title || null,
      phone || null,
      pwHash,
      !password,
    ]
  );
  return r.rows[0];
}

async function getUserByEmail(email) {
  const r = await db.query(`SELECT * FROM ngtf_audit_users WHERE email = $1 AND active = TRUE`, [
    String(email || "").trim().toLowerCase(),
  ]);
  return r.rows[0] || null;
}

async function getUserById(id) {
  const r = await db.query(`SELECT * FROM ngtf_audit_users WHERE id = $1 AND active = TRUE`, [id]);
  return r.rows[0] || null;
}

async function setPassword(userId, password) {
  const hash = await hashPassword(password);
  const r = await db.query(
    `UPDATE ngtf_audit_users SET password_hash = $1, must_reset = FALSE WHERE id = $2`,
    [hash, userId]
  );
  if (!r.rowCount) throw new Error(`No active user with id ${userId}.`);
}

/**
 * Deactivate a user, refusing the two cases that lock the portal open.
 *
 * Setup mode triggers when the ACTIVE user count reaches zero, so
 * deactivating the last account previously re-opened /audit/setup to
 * anyone on the internet, who could then create a fresh portal_admin and
 * read seven years of an SEC issuer's workpapers. The setup_completed
 * marker below closes that hole; this closes the door that led to it.
 */
async function deactivateUser(targetId, actingUserId) {
  if (Number(targetId) === Number(actingUserId)) {
    throw new Error("You cannot deactivate your own account.");
  }
  const target = await getUserById(targetId);
  if (!target) throw new Error("User not found or already inactive.");

  const remaining = await db.query(
    `SELECT COUNT(*)::int AS n FROM ngtf_audit_users
      WHERE active = TRUE AND role = 'portal_admin' AND id <> $1`,
    [targetId]
  );
  if (target.role === "portal_admin" && remaining.rows[0].n === 0) {
    throw new Error(
      "This is the last active portal administrator. Create another administrator before deactivating this one — " +
        "otherwise nobody can manage the portal."
    );
  }
  const r = await db.query(`UPDATE ngtf_audit_users SET active = FALSE WHERE id = $1`, [targetId]);
  if (!r.rowCount) throw new Error("User not found or already inactive.");
  return target;
}

// ── Setup-completed marker ───────────────────────────────
// Presence of this row, not a live user count, is what closes setup.
let _setupDoneCache = false;
async function isSetupComplete() {
  if (_setupDoneCache) return true;
  try {
    const r = await db.query(`SELECT 1 FROM ngtf_audit_settings WHERE key = 'setup_completed'`);
    if (r.rows.length) {
      _setupDoneCache = true;
      return true;
    }
    // A portal that already has users but predates this marker is
    // complete too — backfill so it never re-opens.
    const n = await countUsers();
    if (n > 0) {
      await markSetupComplete();
      return true;
    }
    return false;
  } catch {
    // Tables not created yet. Treat as incomplete but do NOT cache.
    return false;
  }
}

async function markSetupComplete() {
  await db.query(
    `INSERT INTO ngtf_audit_settings (key, value, updated_at)
     VALUES ('setup_completed', $1, NOW()) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify({ at: new Date().toISOString() })]
  );
  _setupDoneCache = true;
}

// ── Login throttling ─────────────────────────────────────
// Counts recent failures in the append-only event log — no extra table,
// and the record is itself evidence. Applied per email AND per IP so
// neither a targeted nor a spray attack gets unlimited attempts.
const LOGIN_WINDOW_MIN = Number(process.env.AUDIT_LOGIN_WINDOW_MIN || 15);
const LOGIN_MAX_FAILS = Number(process.env.AUDIT_LOGIN_MAX_FAILS || 8);

async function loginThrottled(email, ip) {
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM ngtf_audit_events
        WHERE event = 'login_failed'
          AND created_at > NOW() - ($1 || ' minutes')::interval
          AND (lower(actor_email) = lower($2) OR (ip IS NOT NULL AND ip = $3))`,
      [String(LOGIN_WINDOW_MIN), String(email || ""), ip || null]
    );
    return r.rows[0].n >= LOGIN_MAX_FAILS;
  } catch {
    return false; // never lock people out because the check itself broke
  }
}

async function listUsers() {
  const r = await db.query(
    `SELECT id, email, name, org, role, firm_name, title, phone, active, must_reset,
            notify_email, notify_sms, notify_digest, notify_instant, created_at, last_login
       FROM ngtf_audit_users ORDER BY org, role, name`
  );
  return r.rows;
}

async function authenticate(email, password) {
  const u = await getUserByEmail(email);
  if (!u || !u.password_hash) {
    // Spend the same time as a real verification so an unknown address
    // is not distinguishable from a wrong password by response time.
    await burnTime();
    return null;
  }
  if (!(await verifyPasswordHash(password, u.password_hash))) return null;
  await db.query(`UPDATE ngtf_audit_users SET last_login = NOW() WHERE id = $1`, [u.id]);
  return u;
}

async function login(res, user, remember) {
  const ttl = remember ? SESSION_TTL_LONG_MS : SESSION_TTL_MS;
  const token = await makeToken({
    uid: user.id,
    email: user.email,
    role: user.role,
    org: user.org,
    exp: Date.now() + ttl,
  });
  setSessionCookie(res, token, ttl);
  return token;
}

// ── Middleware ───────────────────────────────────────────
// EXACT matches only. Prefix matching on a non-normalized req.path let
// "/login/../api/whoami" satisfy startsWith("/login/") and skip the
// whole auth check. Express happens to 404 that today, but it is a
// bypass waiting for the first route added under /login/*.
const PUBLIC_PATHS = ["/login", "/logout", "/setup", "/healthz"];

function isPublic(rawPath) {
  let p = String(rawPath || "/");
  try {
    p = require("path").posix.normalize(p);
  } catch {
    /* fall through with the raw value */
  }
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return PUBLIC_PATHS.includes(p);
}

/**
 * Express middleware. Mount with app.use("/audit", requireAuth).
 * Sets req.auditUser on success.
 */
function requireAuth(req, res, next) {
  (async () => {
    const sub = req.path || "/";

    if (isPublic(sub)) return next();

    // Setup mode is gated on a ONE-SHOT MARKER, never on a live user
    // count. Counting active users meant that deactivating the last
    // account re-opened /audit/setup to anyone who reached it first,
    // who could then mint a portal_admin and read the whole archive.
    if (!(await isSetupComplete())) {
      if (wantsJSON(req)) return res.status(503).json({ ok: false, error: "setup_required" });
      return res.redirect(`${mountBase()}/setup`);
    }

    const cookies = parseCookies(req);
    const payload = await verifyToken(cookies[COOKIE_NAME]);
    if (!payload) {
      if (wantsJSON(req)) return res.status(401).json({ ok: false, error: "unauthenticated" });
      const back = encodeURIComponent(req.originalUrl || mountBase());
      return res.redirect(`${mountBase()}/login?next=${back}`);
    }

    const user = await getUserById(payload.uid);
    if (!user) {
      clearSessionCookie(res);
      if (wantsJSON(req)) return res.status(401).json({ ok: false, error: "user_inactive" });
      return res.redirect(`${mountBase()}/login`);
    }

    req.auditUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      org: user.org,
      role: user.role,
      firmName: user.firm_name,
      title: user.title,
      mustReset: user.must_reset,
    };
    next();
  })().catch((err) => {
    console.error("[ngtf-audit auth]", err.message);
    res.status(500).send("Authentication error");
  });
}

function wantsJSON(req) {
  return (
    (req.path || "").startsWith("/api/") ||
    String(req.headers.accept || "").includes("application/json") ||
    String(req.headers["x-requested-with"] || "") === "XMLHttpRequest"
  );
}

/** Route guard: requirePermission("document.upload") */
function requirePermission(permission) {
  return (req, res, next) => {
    if (can(req.auditUser, permission)) return next();
    const msg = `Your role (${
      req.auditUser ? ROLES[req.auditUser.role]?.label || req.auditUser.role : "none"
    }) does not permit: ${permission}`;
    if (wantsJSON(req)) return res.status(403).json({ ok: false, error: "forbidden", detail: msg });
    return res.status(403).send(msg);
  };
}

/** Convenience guard for the independence boundary. */
function requireCompanySide(req, res, next) {
  if (req.auditUser && (req.auditUser.org === "company" || req.auditUser.role === "portal_admin")) return next();
  const msg =
    "This action is restricted to company personnel. Auditor accounts cannot prepare, upload or " +
    "certify the company's records — SEC Rule 2-01(c)(4) treats bookkeeping and management " +
    "functions as impairing independence.";
  if (wantsJSON(req)) return res.status(403).json({ ok: false, error: "independence_boundary", detail: msg });
  return res.status(403).send(msg);
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  SESSION_TTL_LONG_MS,
  ROLES,
  PERMISSIONS,
  can,
  permissionsFor,
  hashPassword,
  verifyPasswordHash,
  makeToken,
  verifyToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  countUsers,
  createUser,
  deactivateUser,
  isSetupComplete,
  markSetupComplete,
  loginThrottled,
  mountBase,
  getUserByEmail,
  getUserById,
  setPassword,
  listUsers,
  authenticate,
  login,
  requireAuth,
  requirePermission,
  requireCompanySide,
  wantsJSON,
};
