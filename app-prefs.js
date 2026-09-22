// ============================================================
//  app-prefs.js — per-person app settings, and "open the full admin"
// ------------------------------------------------------------
//  JJ: "for dashboard, give user the option to add or move."
//
//  GET/PUT /api/staff/prefs/:key     one person's saved setting (their
//                                    dashboard layout: which sections and
//                                    shortcuts, in what order). Saved on
//                                    the server so it follows them from
//                                    phone to iPad to a new phone.
//
//  POST /api/staff/web-link          the iPad's "Full Admin" button: a
//  GET  /app-web-login?c=…           one-time link, good for 60 seconds,
//                                    that signs the browser into the web
//                                    admin as the same person (so nobody
//                                    retypes a password on a tablet).
// ============================================================

const crypto = require("crypto");
const db = require("./db");

let ready = null;
function initTables() {
  if (!ready) {
    ready = db.query(`
      CREATE TABLE IF NOT EXISTS app_user_prefs (
        uid        TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (uid, key)
      )`).catch(e => { ready = null; throw e; });
  }
  return ready;
}

const KEY_RE = /^[a-z0-9_.-]{1,40}$/;
const MAX_BYTES = 20000;

async function getPref(uid, key) {
  await initTables();
  const r = await db.query(`SELECT value, updated_at FROM app_user_prefs WHERE uid = $1 AND key = $2`, [String(uid), key]);
  return r.rows[0] || null;
}
async function setPref(uid, key, value) {
  await initTables();
  const json = JSON.stringify(value === undefined ? null : value);
  if (json.length > MAX_BYTES) throw new Error("Setting too large");
  const r = await db.query(
    `INSERT INTO app_user_prefs (uid, key, value, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (uid, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING value, updated_at`,
    [String(uid), key, json]);
  return r.rows[0];
}
async function deletePref(uid, key) {
  await initTables();
  await db.query(`DELETE FROM app_user_prefs WHERE uid = $1 AND key = $2`, [String(uid), key]);
}

// ── One-time web sign-in links ───────────────────────────
// Kept in memory: a link lives 60 seconds and is used once, so losing
// them on a restart only means tapping the button again.
const links = new Map();
const LINK_MS = 60 * 1000;
function sweep() { const now = Date.now(); for (const [k, v] of links) if (v.exp < now) links.delete(k); }

function safeNext(n) {
  const s = String(n || "");
  // Only pages of the admin itself: no other sites, no protocol tricks.
  return /^\/admin(\/[\w\-./?=&%]*)?$/.test(s) && !s.includes("//") ? s : "/admin/dashboard";
}

function attach(app, { requireBearer, requireFirmUser, auth }) {
  app.get("/api/staff/prefs/:key", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const key = String(req.params.key);
      if (!KEY_RE.test(key)) return res.status(400).json({ ok: false, error: "Bad key" });
      const row = await getPref(req.user.uid, key);
      res.json({ ok: true, value: row ? row.value : null, updated_at: row ? row.updated_at : null });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.put("/api/staff/prefs/:key", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const key = String(req.params.key);
      if (!KEY_RE.test(key)) return res.status(400).json({ ok: false, error: "Bad key" });
      const body = req.body || {};
      if (body.reset === true) { await deletePref(req.user.uid, key); return res.json({ ok: true, value: null }); }
      const row = await setPref(req.user.uid, key, body.value);
      res.json({ ok: true, value: row.value, updated_at: row.updated_at });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.post("/api/staff/web-link", requireBearer, requireFirmUser, async (req, res) => {
    try {
      sweep();
      const code = crypto.randomBytes(24).toString("base64url");
      links.set(code, { uid: req.user.uid, exp: Date.now() + LINK_MS });
      const next = safeNext((req.body || {}).next);
      const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
      res.json({ ok: true, url: `${String(base).replace(/\/+$/, "")}/app-web-login?c=${code}&next=${encodeURIComponent(next)}`, expires_in: 60 });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/app-web-login", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      sweep();
      const code = String(req.query.c || "");
      const link = links.get(code);
      links.delete(code);   // used once, even if it fails below
      if (!link || link.exp < Date.now()) return res.redirect("/admin/login?next=" + encodeURIComponent(safeNext(req.query.next)));
      // The person as they are now (a role change or a disabled account
      // since the app signed in counts).
      const r = await db.query(`SELECT id, username, full_name, role, disabled FROM admin_users WHERE id = $1`, [link.uid]);
      const u = r.rows[0];
      if (!u || u.disabled) return res.redirect("/admin/login");
      const ttl = 24 * 60 * 60 * 1000;
      const token = await auth.makeToken({ uid: u.id, u: u.username, n: u.full_name, r: u.role, exp: Date.now() + ttl });
      const secure = process.env.NODE_ENV === "production" || process.env.RENDER === "true" || process.env.RENDER_EXTERNAL_URL;
      res.setHeader("Set-Cookie", [`${auth.COOKIE_NAME}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax",
        `Max-Age=${Math.floor(ttl / 1000)}`].concat(secure ? ["Secure"] : []).join("; "));
      res.redirect(safeNext(req.query.next));
    } catch (e) { res.status(500).send("Sign-in link failed: " + e.message); }
  });
}

module.exports = { attach, initTables, getPref, setPref, deletePref, safeNext, _links: links };
