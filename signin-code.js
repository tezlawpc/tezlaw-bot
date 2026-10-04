// ============================================================
//  signin-code.js — A CODE AFTER THE PASSWORD
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  JJ wanted "a phone number on every user account so a code can
//  be sent to any user", and chose: a code AFTER the password.
//
//  Staff and consultants sign in with a username and a password.
//  A password alone is one leaked spreadsheet away from the firm's
//  whole client base, and a consultant's password is held by
//  someone who is not an employee. So after the password is right,
//  a six-digit code goes to the phone (or the email) the FIRM has
//  on file for that person, and the sign-in finishes only when they
//  type it back.
//
//  THE RULES, each chosen so that nobody is locked out by accident:
//
//  1. NO PHONE AND NO EMAIL ON FILE → password alone, as before.
//     Otherwise turning this on would lock out every account whose
//     details were never filled in — possibly JJ's own. The Users
//     page marks those accounts so the gap is visible, not silent.
//
//  2. THE CODE COULD NOT BE SENT (Twilio down, mail not set up) →
//     password alone, and the firm is told on Telegram. A broken
//     text-message account must not close the office. Someone with
//     a stolen password cannot cause this: they do not control
//     whether Twilio answers.
//
//  3. "DON'T ASK ON THIS DEVICE FOR 30 DAYS" → a signed device
//     token, tied to the password it was issued under, so changing
//     the password forgets every device.
//
//  4. THE PHONE APP. A build that does not know about codes would
//     receive "needs a code" and show nothing. So an app sign-in
//     asks for a code only when the app says it can show the step
//     (supports_code), until the firm turns on "require it in the
//     app" — which then tells old builds to update instead.
//
//  The code is never logged in production, never stored in the
//  clear, good for ten minutes and five tries.
// ============================================================

const crypto = require("crypto");
const db = require("./db");

const TTL_MIN = 10;          // a code lives this long
const MAX_TRIES = 5;         // wrong guesses per code
const MAX_SENDS = 5;         // codes per person per 15 minutes
const PENDING_MIN = 15;      // password accepted, code not yet typed
const DEVICE_DAYS = 30;
const DEVICE_COOKIE = "tezdev";

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// Changes whenever the password does, without revealing anything about it.
const passwordMark = (user) => sha("mark:" + (user.password_hash || "")).slice(0, 16);

let _ready = null;
function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    await db.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS phone TEXT`).catch(() => {});
    await db.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email TEXT`).catch(() => {});
    await db.query(`
      CREATE TABLE IF NOT EXISTS staff_signin_codes (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        channel     TEXT NOT NULL,
        sent_to     TEXT NOT NULL,
        code_hash   TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        used        BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS staff_signin_codes_user ON staff_signin_codes (user_id, created_at DESC)`).catch(() => {});
    await db.query(`
      CREATE TABLE IF NOT EXISTS signin_settings (
        id            INTEGER PRIMARY KEY DEFAULT 1,
        web_required  BOOLEAN NOT NULL DEFAULT TRUE,
        app_required  BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_by    TEXT
      )`);
    await db.query(`INSERT INTO signin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

async function getSettings() {
  try {
    await ensure();
    const r = await db.query(`SELECT web_required, app_required FROM signin_settings WHERE id = 1`);
    return r.rows[0] || { web_required: true, app_required: false };
  } catch (e) {
    console.warn("[signin-code] settings:", e.message);
    return { web_required: true, app_required: false };
  }
}

async function setSettings({ web_required, app_required }, by) {
  await ensure();
  await db.query(
    `UPDATE signin_settings SET web_required = $1, app_required = $2, updated_at = NOW(), updated_by = $3 WHERE id = 1`,
    [!!web_required, !!app_required, by ? String(by).slice(0, 80) : null]);
}

// ── Where a code can go ─────────────────────────────────────

function e164(raw) {
  const t = String(raw || "").trim();
  const d = t.replace(/\D/g, "");
  if (!d) return null;
  if (t.startsWith("+")) return "+" + d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d.length >= 8 ? "+" + d : null;
}
function maskPhone(p) { const d = String(p || "").replace(/\D/g, ""); return d.length >= 4 ? `phone ending ${d.slice(-4)}` : "your phone"; }
function maskEmail(e) {
  const [a, b] = String(e || "").split("@");
  if (!a || !b) return "your email";
  return `${a[0]}${"•".repeat(Math.max(1, Math.min(a.length - 1, 5)))}@${b}`;
}

/** The phone and email the FIRM has on file for this person. */
async function channelsFor(userId) {
  await ensure();
  const r = await db.query(`SELECT phone, email FROM admin_users WHERE id = $1`, [userId]);
  const u = r.rows[0] || {};
  const out = [];
  const phone = e164(u.phone);
  if (phone) out.push({ channel: "sms", to: phone, masked: maskPhone(phone) });
  const email = String(u.email || "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.push({ channel: "email", to: email, masked: maskEmail(email) });
  return out;
}

// ── Device and pending tokens (signed by auth.js's own secret) ──

async function deviceToken(user) {
  const auth = require("./auth");
  return auth.makeToken({ dv: user.id, k: passwordMark(user), exp: Date.now() + DEVICE_DAYS * 864e5 });
}
async function deviceTrusted(user, token) {
  if (!token) return false;
  const p = await require("./auth").verifyToken(token);
  return !!(p && p.dv === user.id && p.k === passwordMark(user));
}
async function pendingToken(user, extra = {}) {
  return require("./auth").makeToken({ p2: user.id, k: passwordMark(user), ...extra, exp: Date.now() + PENDING_MIN * 60000 });
}
/** The user a pending token belongs to, or null. Their password must not have changed since. */
async function userFromPending(token) {
  const p = await require("./auth").verifyToken(token);
  if (!p || !p.p2) return null;
  const r = await db.query(
    `SELECT id, username, password_hash, full_name, role, disabled FROM admin_users WHERE id = $1 AND disabled = FALSE`, [p.p2]);
  const user = r.rows[0];
  if (!user || passwordMark(user) !== p.k) return null;
  return { user, payload: p };
}

// ── Is a code needed for this sign-in? ──────────────────────

/**
 * @returns {{required:boolean, why:string, channels:Array, updateApp?:boolean}}
 *   why: off | no_contact | trusted_device | old_app | needed
 */
async function gate(user, { surface = "web", device = null, supportsCode = false } = {}) {
  const s = await getSettings();
  if (surface === "web" && !s.web_required) return { required: false, why: "off", channels: [] };
  const channels = await channelsFor(user.id);
  if (!channels.length) return { required: false, why: "no_contact", channels };
  if (await deviceTrusted(user, device)) return { required: false, why: "trusted_device", channels };
  if (surface === "app" && !supportsCode) {
    if (s.app_required) return { required: true, why: "needed", channels, updateApp: true };
    return { required: false, why: "old_app", channels };
  }
  return { required: true, why: "needed", channels };
}

// ── Sending ─────────────────────────────────────────────────

const isLive = () => process.env.NODE_ENV === "production" || process.env.RENDER === "true" || !!process.env.RENDER_EXTERNAL_URL;

async function sendSms(to, userId) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  const verifySid = process.env.TWILIO_VERIFY_SID;
  const from = process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER;
  const axios = require("axios");
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  // Twilio Verify first — the same service the client app's codes use.
  if (sid && token && verifySid) {
    await axios.post(`https://verify.twilio.com/v2/Services/${verifySid}/Verifications`,
      new URLSearchParams({ To: to, Channel: "sms" }).toString(), { auth: { username: sid, password: token }, headers, timeout: 15000 });
    return "verify";
  }
  if (sid && token && from) {
    const code = String(crypto.randomInt(100000, 1000000));
    await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      new URLSearchParams({ To: to, From: from, Body: `Your TEZ Law Firm sign-in code is ${code}. It expires in ${TTL_MIN} minutes. Do not share it.` }).toString(),
      { auth: { username: sid, password: token }, headers, timeout: 15000 });
    return sha(code);
  }
  if (!isLive()) {
    const code = String(crypto.randomInt(100000, 1000000));
    console.warn(`[DEV] sign-in code for user ${userId}: ${code}`);
    return sha(code);
  }
  throw new Error("text messages are not set up on the server (TWILIO_*)");
}

async function sendEmail(to, userId) {
  const m = require("./notify").mailTransport();
  const code = String(crypto.randomInt(100000, 1000000));
  if (!m) {
    if (isLive()) throw new Error("email is not set up on the server (SMTP_* or GMAIL_*)");
    console.warn(`[DEV] sign-in code for user ${userId}: ${code}`);
    return sha(code);
  }
  await m.t.sendMail({
    from: `"TEZ Law Firm" <${m.from}>`,
    to,
    subject: "Your sign-in code",
    text: `Your TEZ Law Firm sign-in code is ${code}.\n\nIt expires in ${TTL_MIN} minutes. If you did not just try to sign in, tell the firm: someone has your password.`,
  });
  return sha(code);
}

/**
 * Send a code. Tries the preferred channel, then the other.
 * @returns {{ok:true, channel, masked, others:Array}|{ok:false, error, tried:Array}}
 */
async function send(user, { prefer = null } = {}) {
  await ensure();
  const channels = await channelsFor(user.id);
  if (!channels.length) return { ok: false, error: "no phone or email on file", tried: [] };

  const recent = await db.query(
    `SELECT COUNT(*)::int AS n FROM staff_signin_codes WHERE user_id = $1 AND created_at > NOW() - INTERVAL '15 minutes'`, [user.id]);
  if (recent.rows[0].n >= MAX_SENDS) return { ok: false, limited: true, error: "Too many codes requested. Wait a few minutes and try again.", tried: [] };

  const order = [...channels].sort((a, b) => (a.channel === prefer ? -1 : 0) - (b.channel === prefer ? -1 : 0));
  const tried = [];
  for (const c of order) {
    try {
      const hash = c.channel === "sms" ? await sendSms(c.to, user.id) : await sendEmail(c.to, user.id);
      await db.query(`UPDATE staff_signin_codes SET used = TRUE WHERE user_id = $1 AND used = FALSE`, [user.id]);
      await db.query(
        `INSERT INTO staff_signin_codes (user_id, channel, sent_to, code_hash, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
        [user.id, c.channel, c.to, hash, String(TTL_MIN)]);
      return { ok: true, channel: c.channel, masked: c.masked, others: channels.filter(x => x.channel !== c.channel).map(x => ({ channel: x.channel, masked: x.masked })) };
    } catch (e) {
      const why = String((e.response && e.response.data && (e.response.data.message || e.response.data.description)) || e.message).slice(0, 200);
      tried.push({ channel: c.channel, why });
      console.warn(`[signin-code] ${c.channel} to user ${user.id} failed: ${why}`);
    }
  }
  return { ok: false, error: "the code could not be sent", tried };
}

/** Rule 2: let them in on the password, and make sure the firm hears about it. */
async function reportUnsendable(user, result, surface) {
  const detail = (result.tried || []).map(t => `${t.channel}: ${t.why}`).join("; ") || result.error;
  try { await db.logAudit(String(user.username), "signin_code_unsendable", surface, null, detail); } catch { /* best effort */ }
  try {
    await require("./tg-route").send("ops",
      `Sign-in code could not be sent to ${user.full_name || user.username} (${detail}).\n` +
      `They were let in on their password alone. Check their phone and email on the Users page, and the text-message and email settings on the server.`);
  } catch (e) { console.warn("[signin-code] telegram:", e.message); }
}

// ── Checking ────────────────────────────────────────────────

async function check(user, code) {
  await ensure();
  const typed = String(code || "").replace(/\D/g, "");
  if (typed.length !== 6) return { ok: false, error: "Enter the 6-digit code." };
  const r = await db.query(
    `SELECT * FROM staff_signin_codes WHERE user_id = $1 AND used = FALSE AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1`, [user.id]);
  const row = r.rows[0];
  if (!row) return { ok: false, expired: true, error: "That code has expired. Send a new one." };
  if (row.attempts >= MAX_TRIES) return { ok: false, expired: true, error: "Too many wrong tries. Send a new code." };

  let good = false;
  if (row.code_hash === "verify") {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, verifySid = process.env.TWILIO_VERIFY_SID;
      const v = await require("axios").post(`https://verify.twilio.com/v2/Services/${verifySid}/VerificationCheck`,
        new URLSearchParams({ To: row.sent_to, Code: typed }).toString(),
        { auth: { username: sid, password: token }, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 });
      good = !!(v.data && v.data.status === "approved");
    } catch (e) { good = false; }
  } else {
    const a = Buffer.from(sha(typed)), b = Buffer.from(String(row.code_hash));
    good = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!good) {
    await db.query(`UPDATE staff_signin_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const left = MAX_TRIES - row.attempts - 1;
    return { ok: false, error: left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Send a new code.", expired: left <= 0 };
  }
  await db.query(`UPDATE staff_signin_codes SET used = TRUE WHERE id = $1`, [row.id]);
  return { ok: true };
}

/** For the Users page: who is and is not covered. */
async function coverage() {
  await ensure();
  const r = await db.query(`SELECT id, phone, email FROM admin_users WHERE COALESCE(disabled, FALSE) = FALSE`);
  const none = r.rows.filter(u => !e164(u.phone) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email || "").trim())).map(u => u.id);
  return { total: r.rows.length, uncovered: none };
}

module.exports = {
  DEVICE_COOKIE, DEVICE_DAYS, TTL_MIN,
  ensure, getSettings, setSettings, channelsFor, gate, send, check, reportUnsendable, coverage,
  deviceToken, deviceTrusted, pendingToken, userFromPending, e164, maskPhone, maskEmail,
};
