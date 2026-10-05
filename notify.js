// ============================================================
//  notify.js — OUTBOUND ALERTS TO CONSULTANTS ("brokers")
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  Everything else in this repo notifies the FIRM. This file is
//  the only thing that notifies someone outside it, and that is
//  why it is written the way it is.
//
//  TWO RULES, both structural rather than advisory:
//
//  1. WRITE FIRST, SEND SECOND. Every alert becomes a row in
//     notification_outbox before any network call. On the morning
//     of 2026-09-28 the Telegram token was dead for roughly five
//     hours; every send in that window failed and vanished, and
//     court-mail had already marked its emails done. There was no
//     record that anyone had been told, or not told. A consultant
//     will not notice silence the way JJ does — they have nothing
//     to compare it against — so the record cannot depend on the
//     transport having been up.
//
//  2. CALLERS CANNOT WRITE THE MESSAGE. notifyClientEvent() takes
//     a `kind` off a fixed list and a client key. It looks up the
//     client name itself and builds the text from KINDS below.
//     There is no parameter through which a hearing date, an
//     A-number, a document name or a summary can reach an outside
//     recipient, because a boundary that depends on each future
//     caller remembering it is not a boundary. What happened and
//     to whom travels; what it says stays behind the login.
//
//  Consultants are admin_users with role='consultant', already
//  linked to clients through client_consultants. This file adds
//  no new notion of a person.
//
//  CHANNELS: email (nodemailer, already a dependency), SMS
//  (Twilio REST over axios — the `twilio` package is NOT installed
//  and never has been, so require("twilio") anywhere in this repo
//  is a dead call site), Telegram (sendMessage). No new packages.
// ============================================================

const db = require("./db");
const axios = require("axios");

// ── What may be said ────────────────────────────────────────
//
// The whole confidentiality decision lives in this object. A new
// event type is a new line here, reviewed once, rather than a new
// string built at a call site.

const KINDS = {
  court_mail:    { emoji: "📨", label: "New court notice", zh: "新的法院通知" },
  hearing_set:   { emoji: "📅", label: "Hearing scheduled", zh: "开庭已排期" },
  hearing_moved: { emoji: "📅", label: "Hearing rescheduled", zh: "开庭已改期" },
  deadline:      { emoji: "⏰", label: "Deadline approaching", zh: "期限临近" },
  status:        { emoji: "🔄", label: "Case status changed", zh: "案件状态有变化" },
  // Sent by hand from the firm's alerts page, when something happened that
  // no sweep would notice. Still a fixed headline: the person sending it
  // picks from this list, they do not type the message.
  document:      { emoji: "📄", label: "New document on file", zh: "有新文件" },
  update:        { emoji: "🔔", label: "Case update", zh: "案件有更新" },
  action:        { emoji: "❗", label: "Action needed", zh: "需要您处理" },
};

// Events about a consultant's OWN work order, sent to that consultant only.
// JJ: work orders "will need attorney or manager's approval" — so the person
// who submitted one has to hear which way it went, and why.
const USER_KINDS = {
  wo_approved: { emoji: "✅", label: "Task approved", zh: "任务已批准" },
  wo_rejected: { emoji: "↩️", label: "Task not accepted", zh: "任务未受理" },
  wo_update:   { emoji: "📝", label: "Update on your task", zh: "您的任务有更新" },
  wo_done:     { emoji: "✅", label: "Task completed", zh: "任务已完成" },
};

// Alerts go out in the language the consultant chose in the portal
// (admin_users.preferred_lang): English, or Simplified Chinese.
const isZh = (lang) => lang === "zh" || lang === "zh-CN";
const labelOf = (kind, lang = "en") => {
  const k = KINDS[kind] || USER_KINDS[kind];
  return k ? ((isZh(lang) && k.zh) || k.label) : kind;
};

// "app" is a push to the Tara app on the consultant's phone. JJ: "should be
// able to push case notification to brokers/consultants as well."
const CHANNELS = ["email", "sms", "telegram", "app"];

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
}

/** Where a consultant lands after logging in. Deep-links to the client. */
function loginLink(clientKey) {
  const b = baseUrl();
  if (!b) return "";
  return clientKey ? `${b}/consultant/client/${encodeURIComponent(clientKey)}` : `${b}/consultant`;
}

/**
 * The entire outbound payload, for every channel.
 *
 * Deliberately short and deliberately uninformative. The consultant is
 * already assigned to this client, so the name tells them nothing they
 * did not know; the substance is the part that must not travel, because
 * an email gets forwarded and a phone gets lost.
 */
function renderMessage(kind, clientName, clientKey, lang = "en") {
  const k = KINDS[kind];
  if (!k) throw new Error(`notify: unknown kind "${kind}"`);
  const zh = isZh(lang);
  const who = String(clientName || (zh ? "您的一位客户" : "a client you are assigned to")).trim();
  const link = loginLink(clientKey);
  const label = labelOf(kind, lang);
  const subject = `${label} — ${who}`;
  const body = [`${k.emoji} ${label} — ${who}`,
    zh ? (link ? `登录查看：${link}` : "请登录查看。") : (link ? `Log in to view: ${link}` : "Log in to view.")].join("\n");
  return { subject, body };
}

/** The same, for a work order. Names the client if the order named one. */
function renderUserMessage(kind, task, lang = "en") {
  const k = USER_KINDS[kind];
  if (!k) throw new Error(`notify: unknown kind "${kind}"`);
  const zh = isZh(lang);
  const what = String((task && task.client_name) || "").trim() || (zh ? `任务 #${task.id}` : `task #${task.id}`);
  const b = baseUrl();
  const link = b ? `${b}/consultant/task/${task.id}` : "";
  const label = labelOf(kind, lang);
  const subject = `${label} — ${what}`;
  const body = [`${k.emoji} ${label} — ${what}`,
    zh ? (link ? `登录查看：${link}` : "请登录查看。") : (link ? `Log in to view: ${link}` : "Log in to view.")].join("\n");
  return { subject, body };
}

// ── Schema ──────────────────────────────────────────────────

let _inited = false;
async function initTables() {
  if (_inited) return;
  // email/phone are added elsewhere too; IF NOT EXISTS makes order irrelevant.
  for (const sql of [
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email TEXT`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS telegram_link_code TEXT`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS notify_sms BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS notify_paused_until TIMESTAMPTZ`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS notify_app BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS preferred_lang TEXT DEFAULT 'en'`,
  ]) {
    try { await db.query(sql); } catch (e) { console.warn("[notify] schema:", e.message); }
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      client_key   TEXT,
      kind         TEXT NOT NULL,
      channel      TEXT NOT NULL,
      address      TEXT NOT NULL,
      subject      TEXT,
      body         TEXT NOT NULL,
      dedupe_key   TEXT UNIQUE,
      status       TEXT NOT NULL DEFAULT 'pending',
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      queued_at    TIMESTAMPTZ DEFAULT NOW(),
      last_try_at  TIMESTAMPTZ,
      sent_at      TIMESTAMPTZ
    )
  `);
  // What a consultant sees when they DO sign in. The outbox records what
  // was sent and whether it arrived; this records what happened, whether or
  // not anything could be sent. Without it "Log in to view" led to a page
  // with nothing on it, and a consultant with no channel turned on had no
  // record at all.
  await db.query(`
    CREATE TABLE IF NOT EXISTS consultant_feed (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      client_key  TEXT,
      task_id     INTEGER,
      kind        TEXT NOT NULL,
      who         TEXT,
      dedupe_key  TEXT UNIQUE,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      seen_at     TIMESTAMPTZ
    )
  `);
  for (const sql of [
    `ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS task_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS consultant_feed_user ON consultant_feed (user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS notification_outbox_pending ON notification_outbox (status, last_try_at)`,
    `CREATE INDEX IF NOT EXISTS notification_outbox_user ON notification_outbox (user_id, queued_at DESC)`,
  ]) {
    try { await db.query(sql); } catch (e) { console.warn("[notify] index:", e.message); }
  }
  _inited = true;
}

// ── Who to tell ─────────────────────────────────────────────

/**
 * The consultants currently assigned to a client.
 * removed_at IS NULL matters: client_consultants keeps history, so
 * without it a consultant taken off a case keeps getting their alerts.
 */
async function consultantsForClient(clientKey) {
  const r = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.telegram_chat_id,
            u.notify_email, u.notify_sms, u.notify_telegram, u.notify_app, u.notify_paused_until, u.disabled,
            u.preferred_lang
       FROM client_consultants cc
       JOIN admin_users u ON u.id = cc.consultant_id
      WHERE cc.client_key = $1 AND cc.removed_at IS NULL
        AND COALESCE(u.disabled, FALSE) = FALSE`,
    [clientKey]
  );
  return r.rows;
}

/** Enabled channels that actually have somewhere to send to. */
function channelsFor(user) {
  if (user.notify_paused_until && new Date(user.notify_paused_until) > new Date()) return [];
  const out = [];
  if (user.notify_email !== false && user.email) out.push({ channel: "email", address: String(user.email).trim() });
  if (user.notify_sms === true && user.phone) out.push({ channel: "sms", address: String(user.phone).trim() });
  if (user.notify_telegram === true && user.telegram_chat_id) out.push({ channel: "telegram", address: String(user.telegram_chat_id).trim() });
  return out;
}

/**
 * channelsFor(), plus the Tara app when this person has it installed and
 * signed in. Whether a phone is registered is a database fact, so this half
 * cannot live in the synchronous function above (which the admin page calls
 * once per row).
 */
async function reachable(user) {
  if (user.notify_paused_until && new Date(user.notify_paused_until) > new Date()) return [];
  const out = channelsFor(user);
  if (user.notify_app === false) return out;
  try {
    const r = await db.query(
      `SELECT 1 FROM push_tokens WHERE user_ref = $1 AND user_kind IN ('consultant', 'firm') LIMIT 1`,
      [String(user.id)]);
    if (r.rows.length) out.push({ channel: "app", address: String(user.id) });
  } catch { /* no push_tokens table yet: nobody has the app */ }
  return out;
}

/** One line in the consultant's own list of what has happened. */
async function addToFeed({ userId, clientKey = null, taskId = null, kind, who = null, dedupe }) {
  try {
    await db.query(
      `INSERT INTO consultant_feed (user_id, client_key, task_id, kind, who, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
      [userId, clientKey, taskId, kind, who, dedupe]);
  } catch (e) { console.warn("[notify] feed:", e.message); }
}

// ── Resolving a client ──────────────────────────────────────
//
// Hearings and deadlines are stored by client_name / a_number; only
// client_consultants and tasks carry client_key. So routing an alert
// means matching a name back to a key, and that match is the one place
// this feature can go badly wrong: sending "New court notice — Wang,
// Baohong" to the wrong broker is precisely the disclosure the
// headline-only rule exists to prevent.
//
// So: A-number first (it is an identifier, names are not), then an
// exact name. If more than one client matches, we do NOT pick one —
// the caller gets null and the event is recorded as unroutable.

async function resolveClientKey({ clientKey = null, aNumber = null, clientName = null } = {}) {
  if (clientKey) return { key: clientKey, how: "given" };

  const digits = String(aNumber || "").replace(/\D/g, "");
  if (digits.length >= 8) {
    try {
      const r = await db.query(
        `SELECT DISTINCT client_key FROM tasks
          WHERE client_key IS NOT NULL
            AND regexp_replace(COALESCE(a_number, ''), '\\D', '', 'g') = $1`,
        [digits]
      );
      if (r.rows.length === 1) return { key: r.rows[0].client_key, how: "a_number" };
      if (r.rows.length > 1) return { key: null, how: "ambiguous_a_number" };
    } catch (e) { console.warn("[notify] resolve by a_number:", e.message); }
  }

  const name = String(clientName || "").trim();
  if (name.length >= 3) {
    try {
      const r = await db.query(
        `SELECT DISTINCT client_key FROM tasks
          WHERE client_key IS NOT NULL AND LOWER(TRIM(client_name)) = LOWER($1)`,
        [name]
      );
      if (r.rows.length === 1) return { key: r.rows[0].client_key, how: "name" };
      if (r.rows.length > 1) return { key: null, how: "ambiguous_name" };
    } catch (e) { console.warn("[notify] resolve by name:", e.message); }
  }
  return { key: null, how: "no_match" };
}

// ── Queue ───────────────────────────────────────────────────

/**
 * Queue one event for every consultant on the client, on every channel
 * they have turned on. Returns what was queued and, importantly, what
 * could not be — a consultant with no reachable channel is a silent
 * failure otherwise, and silence is the thing this file exists to stop.
 *
 * `ref` should identify the underlying event (a court_mail id, a hearing
 * id) so a retried sweep does not queue the same alert twice.
 */
async function notifyClientEvent({ clientKey, kind, ref = null, clientName = null }) {
  await initTables();
  if (!KINDS[kind]) throw new Error(`notify: unknown kind "${kind}"`);
  const result = { queued: 0, unreachable: [], recipients: 0 };
  if (!clientKey) return result;

  let name = clientName;
  if (!name) {
    try {
      // The client's name lives on the tasks rows, not on a clients table —
      // MAX() because a client has many rows and any of them carries it.
      const r = await db.query(
        `SELECT MAX(client_name) AS name FROM tasks WHERE client_key = $1`, [clientKey]);
      name = r.rows[0] && r.rows[0].name;
    } catch { /* name is optional; the alert still goes */ }
  }
  const users = await consultantsForClient(clientKey);
  result.recipients = users.length;
  for (const u of users) {
    const { subject, body } = renderMessage(kind, name, clientKey, u.preferred_lang);
    await addToFeed({ userId: u.id, clientKey, kind, who: name || null,
      dedupe: `${kind}:${ref == null ? "-" : ref}:${clientKey}:${u.id}` });
    const chans = await reachable(u);
    if (!chans.length) {
      result.unreachable.push({ user_id: u.id, username: u.username, why: reasonUnreachable(u) });
      continue;
    }
    for (const c of chans) {
      const dedupe = `${kind}:${ref == null ? "-" : ref}:${clientKey}:${u.id}:${c.channel}`;
      try {
        const ins = await db.query(
          `INSERT INTO notification_outbox (user_id, client_key, kind, channel, address, subject, body, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
          [u.id, clientKey, kind, c.channel, c.address, subject, body, dedupe]
        );
        if (ins.rows.length) result.queued++;
      } catch (e) {
        console.warn("[notify] queue:", e.message);
      }
    }
  }
  return result;
}

/**
 * Tell ONE consultant about their own work order.
 *
 * Same rule as above — the caller passes a kind and an id, never text. The
 * task is looked up here and must have been submitted by that user, so there
 * is no way to point this at somebody else's work order and have its client
 * named to the wrong person.
 */
async function notifyUserEvent({ userId, kind, taskId, ref = null }) {
  await initTables();
  if (!USER_KINDS[kind]) throw new Error(`notify: unknown kind "${kind}"`);
  const result = { queued: 0, unreachable: [], recipients: 0 };
  const uid = parseInt(userId, 10), tid = parseInt(taskId, 10);
  if (!uid || !tid) return result;

  const t = (await db.query(
    `SELECT id, client_name, client_key FROM tasks WHERE id = $1 AND submitted_by_user_id = $2`, [tid, uid])).rows[0];
  if (!t) return result;
  const u = (await db.query(
    `SELECT id, username, full_name, email, phone, telegram_chat_id,
            notify_email, notify_sms, notify_telegram, notify_app, notify_paused_until, disabled, preferred_lang
       FROM admin_users WHERE id = $1`, [uid])).rows[0];
  if (!u || u.disabled) return result;
  result.recipients = 1;

  const { subject, body } = renderUserMessage(kind, t, u.preferred_lang);
  const base = `${kind}:${ref == null ? "-" : ref}:task${tid}:${uid}`;
  await addToFeed({ userId: uid, clientKey: t.client_key || null, taskId: tid, kind, who: t.client_name || null, dedupe: base });

  const chans = await reachable(u);
  if (!chans.length) {
    result.unreachable.push({ user_id: u.id, username: u.username, why: reasonUnreachable(u) });
    return result;
  }
  for (const c of chans) {
    try {
      const ins = await db.query(
        `INSERT INTO notification_outbox (user_id, client_key, kind, channel, address, subject, body, dedupe_key, task_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [uid, t.client_key || null, kind, c.channel, c.address, subject, body, `${base}:${c.channel}`, tid]);
      if (ins.rows.length) result.queued++;
    } catch (e) { console.warn("[notify] queue:", e.message); }
  }
  return result;
}

// ── What the consultant sees when signed in ─────────────────

/** Their own recent events, newest first; optionally for one client. */
async function feedFor(userId, { clientKey = null, limit = 30 } = {}) {
  await initTables();
  const r = await db.query(
    `SELECT id, kind, client_key, task_id, who, created_at, seen_at FROM consultant_feed
      WHERE user_id = $1 AND ($2::text IS NULL OR client_key = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [userId, clientKey, Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100)]);
  return r.rows.map(x => ({ ...x, label: labelOf(x.kind) }));   // English; a page in another language calls labelOf(kind, lang)
}

/** The consultant's chosen language: "en" or "zh". */
async function langFor(userId) {
  try {
    await initTables();
    const r = await db.query(`SELECT preferred_lang FROM admin_users WHERE id = $1`, [userId]);
    return isZh(r.rows[0] && r.rows[0].preferred_lang) ? "zh" : "en";
  } catch { return "en"; }
}
async function setLang(userId, lang) {
  await initTables();
  await db.query(`UPDATE admin_users SET preferred_lang = $2 WHERE id = $1`, [userId, isZh(lang) ? "zh" : "en"]);
}

async function unseenCount(userId) {
  try {
    await initTables();
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM consultant_feed WHERE user_id = $1 AND seen_at IS NULL`, [userId]);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch { return 0; }
}

async function markSeen(userId) {
  try { await db.query(`UPDATE consultant_feed SET seen_at = NOW() WHERE user_id = $1 AND seen_at IS NULL`, [userId]); }
  catch (e) { console.warn("[notify] seen:", e.message); }
}

function reasonUnreachable(u) {
  if (u.notify_paused_until && new Date(u.notify_paused_until) > new Date()) return "alerts paused";
  const wants = [];
  if (u.notify_email !== false) wants.push(u.email ? null : "no email on file");
  if (u.notify_sms === true) wants.push(u.phone ? null : "no phone on file");
  if (u.notify_telegram === true) wants.push(u.telegram_chat_id ? null : "Telegram not linked");
  const missing = wants.filter(Boolean);
  return missing.length ? missing.join("; ") : "all channels turned off";
}

// ── Senders ─────────────────────────────────────────────────

function mailTransport() {
  const nodemailer = require("nodemailer");
  if (process.env.SMTP_HOST) {
    return {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      t: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT || 587) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      }),
    };
  }
  if (process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD) {
    return {
      from: process.env.GMAIL_EMAIL,
      t: nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.GMAIL_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
      }),
    };
  }
  return null;
}

async function sendEmail(row) {
  const m = mailTransport();
  if (!m) throw new Error("email is not configured on the server (SMTP_* or GMAIL_*)");
  const mail = require("./tez-email");
  await m.t.sendMail({
    from: `"TEZ Law Firm" <${m.from}>`,
    to: row.address,
    subject: row.subject || "Update on your client",
    text: row.body,
    // The same words, in the firm's design. Nothing is added: an alert
    // carries its headline and its link, and no more.
    html: mail.wrap({ heading: row.subject || "Update on your client", body: mail.paragraphs(row.body) }),
  });
}

async function sendSms(row) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) throw new Error("SMS is not configured on the server (TWILIO_*)");
  const digits = String(row.address).replace(/[^\d]/g, "");
  if (!digits) throw new Error("phone number has no digits");
  const to = String(row.address).trim().startsWith("+") ? "+" + digits : (digits.length === 10 ? "+1" + digits : "+" + digits);
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    new URLSearchParams({ From: from, To: to, Body: row.body }).toString(),
    { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
}

async function sendTelegram(row) {
  const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram is not configured on the server (TELEGRAM_TOKEN)");
  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: row.address, text: String(row.body).slice(0, 3900), disable_web_page_preview: true },
    { timeout: 15000 }
  );
}

/**
 * The Tara app. Expo's push service takes the message; the row's address is
 * the consultant's user id and their devices are looked up at send time, so
 * a phone registered after the alert was queued still gets it on the retry.
 * The lock-screen text is the same headline as every other channel.
 */
async function sendApp(row) {
  const push = require("./push-notifications");
  const data = row.task_id
    ? { screen: "consultant-task", taskId: row.task_id }
    : { screen: "consultant-client", type: "consultant_client_update", clientKey: row.client_key, client_key: row.client_key };
  const r = await push.sendToUser("consultant", row.address, {
    title: row.subject || "Update on your client",
    // The row was written in the consultant's language; say this line in it too.
    body: /[\u4e00-\u9fff]/.test(String(row.subject || "")) ? "请打开 Tara 查看。" : "Open Tara to view.",
    data,
  });
  if (r && r.error) throw new Error(`app push: ${r.error}`);
  if (!r || !r.sent) throw new Error("no phone is signed in to the Tara app for this consultant");
}

const SENDERS = { email: sendEmail, sms: sendSms, telegram: sendTelegram, app: sendApp };

// ── Flush ───────────────────────────────────────────────────

const MAX_ATTEMPTS = 5;
// Back off between tries so a dead token does not burn all five attempts
// in one sweep, which is how a transient outage becomes a lost alert.
const BACKOFF_MIN = [0, 2, 10, 60, 240];

/**
 * Send what is pending. Safe to call repeatedly and safe to call
 * concurrently-ish: each row is claimed with a conditional UPDATE before
 * any network call, so two sweeps will not both send the same row.
 */
async function flush({ limit = 50 } = {}) {
  await initTables();
  const out = { sent: 0, failed: 0, gave_up: 0, tried: 0 };
  const r = await db.query(
    `SELECT * FROM notification_outbox
      WHERE status = 'pending' AND attempts < $2
      ORDER BY queued_at ASC LIMIT $1`,
    [limit, MAX_ATTEMPTS]
  );
  for (const row of r.rows) {
    const waitMin = BACKOFF_MIN[Math.min(row.attempts, BACKOFF_MIN.length - 1)];
    if (row.last_try_at && Date.now() - new Date(row.last_try_at).getTime() < waitMin * 60000) continue;

    // Claim it. If another sweep got there first, attempts moved and this
    // updates nothing.
    const claim = await db.query(
      `UPDATE notification_outbox SET attempts = attempts + 1, last_try_at = NOW()
        WHERE id = $1 AND attempts = $2 AND status = 'pending' RETURNING id`,
      [row.id, row.attempts]
    );
    if (!claim.rows.length) continue;
    out.tried++;

    try {
      const send = SENDERS[row.channel];
      if (!send) throw new Error(`no sender for channel "${row.channel}"`);
      await send(row);
      await db.query(`UPDATE notification_outbox SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = $1`, [row.id]);
      out.sent++;
    } catch (e) {
      const msg = String(e.response && e.response.data && (e.response.data.description || e.response.data.message) || e.message).slice(0, 500);
      const done = row.attempts + 1 >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE notification_outbox SET status = $2, last_error = $3 WHERE id = $1`,
        [row.id, done ? "failed" : "pending", msg]
      );
      if (done) { out.gave_up++; console.warn(`[notify] gave up on #${row.id} (${row.channel}): ${msg}`); }
      else out.failed++;
    }
  }
  return out;
}

/** Queue, then try immediately. The queue is what makes the alert durable. */
async function notifyAndFlush(args) {
  const q = await notifyClientEvent(args);
  if (q.queued) { try { await flush({ limit: q.queued + 10 }); } catch (e) { console.warn("[notify] flush:", e.message); } }
  return q;
}

// ── Telegram linking ────────────────────────────────────────
//
// Telegram cannot push to someone who has never messaged the bot, so a
// consultant has to start the conversation. They get a one-time code in
// the portal and send it to the bot; the webhook calls linkTelegram().

function newLinkCode() {
  return "TEZ-" + require("crypto").randomBytes(3).toString("hex").toUpperCase();
}

async function issueLinkCode(userId) {
  await initTables();
  const code = newLinkCode();
  await db.query(`UPDATE admin_users SET telegram_link_code = $2 WHERE id = $1`, [userId, code]);
  return code;
}

/** Returns the linked user, or null if the code is not one of ours. */
async function linkTelegram(code, chatId) {
  await initTables();
  const c = String(code || "").trim().toUpperCase();
  if (!/^TEZ-[0-9A-F]{6}$/.test(c)) return null;
  const r = await db.query(
    `UPDATE admin_users SET telegram_chat_id = $2, telegram_link_code = NULL, notify_telegram = TRUE
      WHERE telegram_link_code = $1 RETURNING id, username, full_name`,
    [c, String(chatId)]
  );
  return r.rows[0] || null;
}

// ── Daily sweep: hearings and deadlines ─────────────────────
//
// Hearings and deadlines live in five tables across three modules, so
// hooking each insert would mean five edits now and a forgotten sixth
// later. Instead this sweeps what is coming up. The dedupe key makes it
// idempotent, so running it twice a day, or twice in a minute after a
// restart, sends nothing twice.
//
// Windows match the ones the client reminders already use (7 and 1), so
// a broker hears at the same time the client does, not before.

const WINDOWS = [7, 1];

async function sweepUpcoming({ windows = WINDOWS } = {}) {
  await initTables();
  const out = { hearings: 0, deadlines: 0, queued: 0, unroutable: [] };

  for (const daysOut of windows) {
    const day = new Date(Date.now() + daysOut * 86400000).toISOString().slice(0, 10);
    const from = day + "T00:00:00Z", to = day + "T23:59:59Z";

    // Hearings. client_hearing_notices already carries client_key; the two
    // hearing_notes tables do not, so those route by A-number or name.
    const hearingQueries = [
      { sql: `SELECT id, client_key, client_name, a_number FROM client_hearing_notices
               WHERE is_hearing_notice = TRUE AND dismissed_at IS NULL
                 AND hearing_date >= $1 AND hearing_date < $2`, src: "notice" },
      { sql: `SELECT id, NULL::text AS client_key, client_name, a_number FROM hearing_notes
               WHERE next_hearing_date IS NOT NULL AND next_hearing_date >= $1 AND next_hearing_date < $2`, src: "master" },
      { sql: `SELECT id, NULL::text AS client_key, client_name, a_number FROM individual_hearing_notes
               WHERE next_hearing_date IS NOT NULL AND next_hearing_date >= $1 AND next_hearing_date < $2`, src: "individual" },
    ];
    for (const q of hearingQueries) {
      let rows = [];
      try { rows = (await db.query(q.sql, [from, to])).rows; }
      catch (e) { console.warn(`[notify] sweep ${q.src}:`, e.message); continue; }
      for (const row of rows) {
        out.hearings++;
        const r = await queueResolved({ row, kind: "hearing_set", ref: `${q.src}-${row.id}-d${daysOut}`, out });
        out.queued += r;
      }
    }

    // Deadlines. Only ones still open — a completed or cancelled deadline
    // is not news to anyone.
    try {
      const rows = (await db.query(
        `SELECT id, client_name, a_number FROM deadlines
          WHERE due_date >= $1::date AND due_date < ($1::date + 1)
            AND COALESCE(status, 'open') NOT IN ('complete', 'completed', 'cancelled', 'done')`,
        [day]
      )).rows;
      for (const row of rows) {
        out.deadlines++;
        out.queued += await queueResolved({ row, kind: "deadline", ref: `deadline-${row.id}-d${daysOut}`, out });
      }
    } catch (e) { console.warn("[notify] sweep deadlines:", e.message); }
  }

  if (out.queued) { try { await flush({ limit: out.queued + 20 }); } catch (e) { console.warn("[notify] flush:", e.message); } }
  return out;
}

async function queueResolved({ row, kind, ref, out }) {
  const res = await resolveClientKey({ clientKey: row.client_key, aNumber: row.a_number, clientName: row.client_name });
  if (!res.key) {
    // Recorded rather than dropped: "no broker was told" is the kind of
    // thing that should be findable later, not inferred from silence.
    out.unroutable.push({ ref, client_name: row.client_name || null, why: res.how });
    return 0;
  }
  const q = await notifyClientEvent({ clientKey: res.key, kind, ref, clientName: row.client_name });
  return q.queued;
}

// ── Config visibility ───────────────────────────────────────

/** What is actually configured, for the boot check and the admin page. */
function channelHealth() {
  const m = !!(process.env.SMTP_HOST || (process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD));
  const s = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN &&
               (process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER));
  const t = !!(process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN);
  // The app needs no server setting: Expo's push service takes any valid
  // device token. Whether a given consultant HAS a device is per person.
  return { email: m, sms: s, telegram: t, app: true };
}

module.exports = {
  KINDS, USER_KINDS, CHANNELS, labelOf,
  initTables,
  notifyClientEvent, notifyAndFlush, notifyUserEvent, flush, sweepUpcoming,
  consultantsForClient, channelsFor, reachable, reasonUnreachable, resolveClientKey,
  renderMessage, renderUserMessage, loginLink,
  feedFor, unseenCount, markSeen, mailTransport, langFor, setLang, isZh,
  issueLinkCode, linkTelegram,
  channelHealth,
};
