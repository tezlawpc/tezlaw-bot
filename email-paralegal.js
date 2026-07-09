// ============================================================
//  TEZ LAW P.C. — EMAIL PARALEGAL v2 (IMAP)
//  ─────────────────────────────────────────────────────────
//  IMAP-based multi-provider email scanner. Works with:
//    - Gmail (imap.gmail.com — needs app password)
//    - GoDaddy (imap.secureserver.net or outlook.office365.com)
//    - Hotmail/Outlook (outlook.office365.com)
//    - Any IMAP-compatible email provider
//
//  Privacy: LOCAL PATTERN-MATCHING ONLY. Email bodies never
//  leave the server.
//
//  Credentials: passwords encrypted at rest with AES-256-GCM.
// ============================================================

const { ImapFlow } = require("imapflow");
const crypto = require("crypto");
const db = require("./db");

// ── Encryption ──────────────────────────────────────────

function getEncKey() {
  const raw = process.env.EMAIL_ENC_KEY || process.env.JJ_MODE_PASSWORD || "tezlaw-set-EMAIL_ENC_KEY-please";
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plaintext) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(ciphertext) {
  const key = getEncKey();
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

// ── Schema ───────────────────────────────────────────────

async function initEmailTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS imap_accounts (
      id                SERIAL PRIMARY KEY,
      email             TEXT UNIQUE NOT NULL,
      imap_host         TEXT NOT NULL,
      imap_port         INTEGER NOT NULL DEFAULT 993,
      imap_user         TEXT NOT NULL,
      encrypted_pass    TEXT NOT NULL,
      use_tls           BOOLEAN DEFAULT TRUE,
      active            BOOLEAN DEFAULT TRUE,
      last_scan_at      TIMESTAMPTZ,
      last_error        TEXT,
      display_name      TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_tracker (
      id                SERIAL PRIMARY KEY,
      account_email     TEXT NOT NULL,
      thread_id         TEXT NOT NULL,
      message_id        TEXT NOT NULL,
      sender_name       TEXT,
      sender_email      TEXT,
      sender_domain     TEXT,
      subject           TEXT,
      received_at       TIMESTAMPTZ,
      first_seen_at     TIMESTAMPTZ DEFAULT NOW(),
      last_checked_at   TIMESTAMPTZ DEFAULT NOW(),
      status            TEXT DEFAULT 'pending',
      snooze_until      TIMESTAMPTZ,
      digest_number     INTEGER,
      UNIQUE (account_email, thread_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_email_tracker_status
      ON email_tracker (status, received_at DESC)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_allow_list (
      id            SERIAL PRIMARY KEY,
      pattern       TEXT NOT NULL,
      pattern_type  TEXT NOT NULL,
      reason        TEXT,
      added_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (pattern, pattern_type)
    )
  `);

  await seedAllowList();
}

async function seedAllowList() {
  const seeds = [
    { pattern: "noreply@", pattern_type: "sender_contains", reason: "no-reply" },
    { pattern: "no-reply@", pattern_type: "sender_contains", reason: "no-reply" },
    { pattern: "donotreply@", pattern_type: "sender_contains", reason: "no-reply" },
    { pattern: "do-not-reply@", pattern_type: "sender_contains", reason: "no-reply" },
    { pattern: "notification@", pattern_type: "sender_contains", reason: "notification" },
    { pattern: "notifications@", pattern_type: "sender_contains", reason: "notification" },
    { pattern: "updates@", pattern_type: "sender_contains", reason: "updates" },
    { pattern: "newsletter@", pattern_type: "sender_contains", reason: "newsletter" },
    { pattern: "postmaster@", pattern_type: "sender_contains", reason: "mail system" },
    { pattern: "mailer-daemon@", pattern_type: "sender_contains", reason: "mail system" },
    { pattern: "bounce@", pattern_type: "sender_contains", reason: "bounce" },
    { pattern: "bounces@", pattern_type: "sender_contains", reason: "bounce" },
    { pattern: "marketing@", pattern_type: "sender_contains", reason: "marketing" },
    { pattern: "promo@", pattern_type: "sender_contains", reason: "promotional" },
    { pattern: "promotions@", pattern_type: "sender_contains", reason: "promotional" },
    { pattern: "billing@", pattern_type: "sender_contains", reason: "billing" },
    { pattern: "invoice@", pattern_type: "sender_contains", reason: "invoice" },
    { pattern: "receipt@", pattern_type: "sender_contains", reason: "receipt" },
    { pattern: "orders@", pattern_type: "sender_contains", reason: "order" },
    { pattern: "news@", pattern_type: "sender_contains", reason: "news blast" },
    { pattern: "digest@", pattern_type: "sender_contains", reason: "digest" },
    { pattern: "linkedin.com", pattern_type: "domain", reason: "LinkedIn" },
    { pattern: "mailchimp.com", pattern_type: "domain", reason: "mailchimp" },
    { pattern: "constantcontact.com", pattern_type: "domain", reason: "constant contact" },
    { pattern: "hubspot.com", pattern_type: "domain", reason: "hubspot" },
    { pattern: "sendgrid.net", pattern_type: "domain", reason: "sendgrid" },
    { pattern: "mailgun.org", pattern_type: "domain", reason: "mailgun" },
    { pattern: "amazonses.com", pattern_type: "domain", reason: "ses" },
    { pattern: "mail.notion.so", pattern_type: "domain", reason: "notion" },
    { pattern: "email.godaddy.com", pattern_type: "domain", reason: "godaddy marketing" },
    { pattern: "e.godaddy.com", pattern_type: "domain", reason: "godaddy marketing" },
    { pattern: "e.wordpress.com", pattern_type: "domain", reason: "wordpress" },
    { pattern: "facebookmail.com", pattern_type: "domain", reason: "facebook" },
    { pattern: "meetup.com", pattern_type: "domain", reason: "meetup" },
    { pattern: "youtube.com", pattern_type: "domain", reason: "youtube" },
    { pattern: "eventbrite.com", pattern_type: "domain", reason: "eventbrite" },
    { pattern: "zoom.us", pattern_type: "domain", reason: "zoom" },
    { pattern: "docusign.net", pattern_type: "domain", reason: "docusign" },
    { pattern: "docusign.com", pattern_type: "domain", reason: "docusign" },
    { pattern: "clio.com", pattern_type: "domain", reason: "clio" },
    { pattern: "mycase.com", pattern_type: "domain", reason: "mycase" },
    { pattern: "avvo.com", pattern_type: "domain", reason: "avvo" },
    { pattern: "unsubscribe", pattern_type: "subject_contains", reason: "unsubscribe" },
    { pattern: "newsletter", pattern_type: "subject_contains", reason: "newsletter" },
    { pattern: "% off", pattern_type: "subject_contains", reason: "promo" },
    { pattern: "your receipt", pattern_type: "subject_contains", reason: "receipt" },
    { pattern: "order confirmation", pattern_type: "subject_contains", reason: "order" },
    { pattern: "your invoice", pattern_type: "subject_contains", reason: "invoice" },
    { pattern: "invoice from", pattern_type: "subject_contains", reason: "invoice" },
    { pattern: "payment received", pattern_type: "subject_contains", reason: "payment" },
    { pattern: "delivery update", pattern_type: "subject_contains", reason: "delivery" },
    { pattern: "webinar", pattern_type: "subject_contains", reason: "webinar" },
    { pattern: "weekly digest", pattern_type: "subject_contains", reason: "digest" },
    { pattern: "daily digest", pattern_type: "subject_contains", reason: "digest" },
    { pattern: "flash sale", pattern_type: "subject_contains", reason: "sale" },
    { pattern: "limited time", pattern_type: "subject_contains", reason: "sale" },
    { pattern: "last chance", pattern_type: "subject_contains", reason: "sale" },
    { pattern: "cloud recording", pattern_type: "subject_contains", reason: "recording" },
    { pattern: "meeting recording", pattern_type: "subject_contains", reason: "recording" },
  ];

  for (const s of seeds) {
    try {
      await db.query(
        `INSERT INTO email_allow_list (pattern, pattern_type, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (pattern, pattern_type) DO NOTHING`,
        [s.pattern, s.pattern_type, s.reason]
      );
    } catch (e) { /* ignore */ }
  }
}

// ── Address Parsing ──────────────────────────────────────

function parseAddress(addrObj) {
  if (!addrObj) return { name: null, email: null, domain: null };
  const first = Array.isArray(addrObj) ? addrObj[0] : addrObj;
  if (!first) return { name: null, email: null, domain: null };
  const email = (first.address || "").toLowerCase().trim();
  const name = (first.name || "").trim();
  const domain = email.split("@")[1] || null;
  return { name: name || null, email: email || null, domain };
}

function countAddresses(list) {
  if (!list) return 0;
  return Array.isArray(list) ? list.length : 1;
}

// ── Header Parsing ───────────────────────────────────────

function parseHeadersToMap(headersBuffer) {
  if (!headersBuffer) return new Map();
  if (headersBuffer instanceof Map) return headersBuffer;
  if (Buffer.isBuffer(headersBuffer)) {
    const text = headersBuffer.toString("utf8");
    const map = new Map();
    const lines = text.split(/\r?\n/);
    let currentKey = null;
    let currentVal = "";
    for (const line of lines) {
      if (/^\s/.test(line) && currentKey) {
        currentVal += " " + line.trim();
      } else {
        if (currentKey) {
          const arr = map.get(currentKey) || [];
          arr.push(currentVal);
          map.set(currentKey, arr);
        }
        const idx = line.indexOf(":");
        if (idx > 0) {
          currentKey = line.substring(0, idx).toLowerCase().trim();
          currentVal = line.substring(idx + 1).trim();
        } else {
          currentKey = null;
          currentVal = "";
        }
      }
    }
    if (currentKey) {
      const arr = map.get(currentKey) || [];
      arr.push(currentVal);
      map.set(currentKey, arr);
    }
    return map;
  }
  return new Map();
}

function parseReferencesFromHeaders(headers) {
  const map = parseHeadersToMap(headers);
  const refs = map.get("references");
  if (!refs || !refs[0]) return null;
  return refs[0].split(/\s+/).filter(Boolean);
}

function extractInReplyTo(headers) {
  const map = parseHeadersToMap(headers);
  const irt = map.get("in-reply-to");
  return irt && irt[0] ? irt[0].trim() : null;
}

function normalizeSubject(subject) {
  if (!subject) return "";
  return subject.replace(/^((re|fwd|fw|aw|antw|sv):\s*)+/gi, "").trim();
}

// ── Classification ───────────────────────────────────────

let allowListCache = null;
let allowListCacheAt = 0;

async function getAllowList() {
  const now = Date.now();
  if (allowListCache && now - allowListCacheAt < 60 * 1000) {
    return allowListCache;
  }
  const r = await db.query(`SELECT pattern, pattern_type FROM email_allow_list`);
  allowListCache = r.rows;
  allowListCacheAt = now;
  return allowListCache;
}

async function shouldSkip({ senderEmail, senderDomain, subject, headers, recipientCount }) {
  const allowList = await getAllowList();

  if (headers) {
    const map = parseHeadersToMap(headers);
    const autoSubmitted = map.get("auto-submitted");
    if (autoSubmitted && autoSubmitted[0] && !/^no$/i.test(autoSubmitted[0])) {
      return { skip: true, reason: `auto-submitted: ${autoSubmitted[0]}` };
    }
    const precedence = map.get("precedence");
    if (precedence && precedence[0] && /^(bulk|list|junk)$/i.test(precedence[0])) {
      return { skip: true, reason: `precedence: ${precedence[0]}` };
    }
    const listUnsub = map.get("list-unsubscribe");
    if (listUnsub && listUnsub[0]) {
      return { skip: true, reason: "list-unsubscribe (mailing list)" };
    }
    const listId = map.get("list-id");
    if (listId && listId[0]) {
      return { skip: true, reason: "list-id header" };
    }
  }

  if (recipientCount > 5) {
    return { skip: true, reason: `${recipientCount} recipients (mass email)` };
  }

  const subjectLower = (subject || "").toLowerCase();
  const senderLower = (senderEmail || "").toLowerCase();
  const domainLower = (senderDomain || "").toLowerCase();

  for (const entry of allowList) {
    const p = entry.pattern.toLowerCase();
    if (entry.pattern_type === "sender_exact" && senderLower === p) {
      return { skip: true, reason: `allow: sender=${entry.pattern}` };
    }
    if (entry.pattern_type === "sender_contains" && senderLower.includes(p)) {
      return { skip: true, reason: `allow: sender contains ${entry.pattern}` };
    }
    if (entry.pattern_type === "domain_exact" && domainLower === p) {
      return { skip: true, reason: `allow: domain=${entry.pattern}` };
    }
    if (entry.pattern_type === "domain" && (domainLower === p || domainLower.endsWith("." + p))) {
      return { skip: true, reason: `allow: domain=${entry.pattern}` };
    }
    if (entry.pattern_type === "subject_contains" && subjectLower.includes(p)) {
      return { skip: true, reason: `allow: subject contains "${entry.pattern}"` };
    }
  }

  return { skip: false };
}

// ── IMAP Scan ────────────────────────────────────────────

async function connectImap(account) {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port || 993,
    secure: account.use_tls !== false,
    auth: {
      user: account.imap_user,
      pass: decrypt(account.encrypted_pass),
    },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function findSentFolder(client) {
  const candidates = ["Sent", "[Gmail]/Sent Mail", "INBOX.Sent", "Sent Items", "Sent Mail"];
  for (const name of candidates) {
    try {
      const s = await client.status(name, { messages: true });
      if (s && s.messages !== undefined) return name;
    } catch (_) { /* try next */ }
  }
  return null;
}

async function getSentMessageIds(client) {
  const sentIds = new Set();
  const sentFolder = await findSentFolder(client);
  if (!sentFolder) return sentIds;

  try {
    const lock = await client.getMailboxLock(sentFolder);
    try {
      const since = new Date(Date.now() - 30 * 86400 * 1000);
      const messages = client.fetch({ since }, { envelope: true, headers: ["in-reply-to", "references"] });
      for await (const msg of messages) {
        if (msg.envelope?.messageId) sentIds.add(msg.envelope.messageId);
        const inReplyTo = extractInReplyTo(msg.headers);
        if (inReplyTo) sentIds.add(inReplyTo);
        const refs = parseReferencesFromHeaders(msg.headers);
        if (refs) for (const r of refs) sentIds.add(r);
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.log(`[imap] Sent scan error: ${e.message}`);
  }
  return sentIds;
}

async function getSentSubjects(client) {
  const subjects = new Set();
  const sentFolder = await findSentFolder(client);
  if (!sentFolder) return subjects;

  try {
    const lock = await client.getMailboxLock(sentFolder);
    try {
      const since = new Date(Date.now() - 30 * 86400 * 1000);
      const messages = client.fetch({ since }, { envelope: true });
      for await (const msg of messages) {
        const s = normalizeSubject(msg.envelope?.subject || "");
        if (s) subjects.add(s.toLowerCase());
      }
    } finally {
      lock.release();
    }
  } catch (e) { /* silent */ }
  return subjects;
}

async function scanAccount(account) {
  console.log(`[imap-scanner] Scanning ${account.email}...`);
  let stats = { total: 0, tracked: 0, autoSkipped: 0, alreadyReplied: 0, errors: 0 };
  let client;
  try {
    client = await connectImap(account);
  } catch (e) {
    console.error(`[imap-scanner] Connect failed for ${account.email}:`, e.message);
    await db.query(`UPDATE imap_accounts SET last_error = $1 WHERE id = $2`, [e.message, account.id]);
    return { ...stats, error: e.message };
  }

  try {
    const sentMessageIds = await getSentMessageIds(client);
    const sentSubjects = await getSentSubjects(client);

    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 7 * 86400 * 1000);
      const messages = client.fetch(
        { since },
        {
          envelope: true, uid: true, flags: true,
          headers: ["list-unsubscribe", "list-id", "auto-submitted", "precedence", "in-reply-to", "references"],
        }
      );

      const conversationMap = new Map();

      for await (const msg of messages) {
        stats.total++;
        try {
          const env = msg.envelope || {};
          const from = parseAddress(env.from);
          const subject = env.subject || "(no subject)";
          const messageId = env.messageId || `uid-${msg.uid}`;

          if (from.email && from.email === account.email.toLowerCase()) continue;

          const references = parseReferencesFromHeaders(msg.headers);
          const inReplyTo = extractInReplyTo(msg.headers);
          const rootMessageId = references?.[0] || inReplyTo || messageId;
          const normalizedSubject = normalizeSubject(subject);
          const conversationKey = rootMessageId || `subject:${normalizedSubject}:${from.email}`;

          const jjReplied =
            (references && references.some(id => sentMessageIds.has(id))) ||
            (inReplyTo && sentMessageIds.has(inReplyTo)) ||
            (sentMessageIds.has(messageId)) ||
            (normalizedSubject && sentSubjects.has(normalizedSubject.toLowerCase()));

          if (jjReplied) {
            stats.alreadyReplied++;
            await db.query(
              `UPDATE email_tracker SET status = 'replied', last_checked_at = NOW()
               WHERE account_email = $1 AND thread_id = $2 AND status = 'pending'`,
              [account.email, conversationKey]
            );
            continue;
          }

          const existing = conversationMap.get(conversationKey);
          const receivedAt = env.date ? new Date(env.date) : new Date();
          if (!existing || existing.receivedAt < receivedAt) {
            conversationMap.set(conversationKey, {
              conversationKey, messageId, from, subject, receivedAt,
              headers: msg.headers,
              recipientCount: countAddresses(env.to) + countAddresses(env.cc),
            });
          }
        } catch (e) {
          console.error(`[imap-scanner] Message error: ${e.message}`);
          stats.errors++;
        }
      }

      for (const conv of conversationMap.values()) {
        try {
          const skipDecision = await shouldSkip({
            senderEmail: conv.from.email,
            senderDomain: conv.from.domain,
            subject: conv.subject,
            headers: conv.headers,
            recipientCount: conv.recipientCount,
          });

          if (skipDecision.skip) {
            stats.autoSkipped++;
            await db.query(
              `INSERT INTO email_tracker
                (account_email, thread_id, message_id, sender_name, sender_email, sender_domain,
                 subject, received_at, status, last_checked_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ignored', NOW())
               ON CONFLICT (account_email, thread_id) DO UPDATE SET
                 last_checked_at = NOW(),
                 status = CASE WHEN email_tracker.status = 'pending' THEN 'ignored' ELSE email_tracker.status END`,
              [account.email, conv.conversationKey, conv.messageId, conv.from.name, conv.from.email,
               conv.from.domain, conv.subject, conv.receivedAt]
            );
            continue;
          }

          await db.query(
            `INSERT INTO email_tracker
              (account_email, thread_id, message_id, sender_name, sender_email, sender_domain,
               subject, received_at, last_checked_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), 'pending')
             ON CONFLICT (account_email, thread_id) DO UPDATE SET
               message_id      = EXCLUDED.message_id,
               received_at     = EXCLUDED.received_at,
               last_checked_at = NOW(),
               status          = CASE
                 WHEN email_tracker.status IN ('ignored', 'replied') THEN 'pending'
                 ELSE email_tracker.status
               END`,
            [account.email, conv.conversationKey, conv.messageId, conv.from.name, conv.from.email,
             conv.from.domain, conv.subject, conv.receivedAt]
          );

          stats.tracked++;
        } catch (e) {
          console.error(`[imap-scanner] Insert error: ${e.message}`);
          stats.errors++;
        }
      }
    } finally {
      lock.release();
    }

    await db.query(
      `UPDATE imap_accounts SET last_scan_at = NOW(), last_error = NULL WHERE id = $1`,
      [account.id]
    );
  } catch (e) {
    console.error(`[imap-scanner] Scan error for ${account.email}: ${e.message}`);
    stats.errors++;
    stats.error = e.message;
    await db.query(`UPDATE imap_accounts SET last_error = $1 WHERE id = $2`, [e.message, account.id]);
  } finally {
    try { await client.logout(); } catch (_) {}
  }

  console.log(`[imap-scanner] ${account.email}: ${stats.tracked} tracked, ${stats.autoSkipped} auto-skipped, ${stats.alreadyReplied} already-replied of ${stats.total} messages`);
  return stats;
}

// ── Public API ───────────────────────────────────────────

async function scanAllAccounts() {
  await initEmailTables();
  const accounts = await db.query(`SELECT * FROM imap_accounts WHERE active = TRUE`);
  const allStats = [];
  for (const account of accounts.rows) {
    try {
      const stats = await scanAccount(account);
      allStats.push({ email: account.email, ...stats });
    } catch (e) {
      console.error(`[imap-scanner] Failed for ${account.email}:`, e.message);
      allStats.push({ email: account.email, error: e.message });
    }
  }
  return allStats;
}

async function getPendingThreads() {
  const r = await db.query(`
    SELECT
      id, account_email, thread_id, sender_name, sender_email, subject,
      received_at, first_seen_at,
      EXTRACT(EPOCH FROM (NOW() - received_at))/3600 AS hours_old
    FROM email_tracker
    WHERE status = 'pending'
      AND (snooze_until IS NULL OR snooze_until < NOW())
    ORDER BY received_at ASC
  `);
  return r.rows;
}

async function markReplied(trackerId) {
  const r = await db.query(
    `UPDATE email_tracker SET status = 'replied', last_checked_at = NOW()
     WHERE id = $1 RETURNING account_email, subject`,
    [trackerId]
  );
  return r.rows[0];
}

async function snoozeThread(trackerId, days) {
  const until = new Date(Date.now() + days * 86400 * 1000);
  const r = await db.query(
    `UPDATE email_tracker SET snooze_until = $1, last_checked_at = NOW()
     WHERE id = $2 RETURNING account_email, subject`,
    [until, trackerId]
  );
  return r.rows[0];
}

async function ignoreThread(trackerId) {
  const r = await db.query(
    `UPDATE email_tracker SET status = 'ignored', last_checked_at = NOW()
     WHERE id = $1 RETURNING account_email, subject`,
    [trackerId]
  );
  return r.rows[0];
}

async function addAllowListPattern(pattern, patternType, reason) {
  const r = await db.query(
    `INSERT INTO email_allow_list (pattern, pattern_type, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (pattern, pattern_type) DO NOTHING
     RETURNING id`,
    [pattern, patternType, reason || "user-added"]
  );
  allowListCache = null;
  return r.rows[0];
}

async function addAccount({ email, imap_host, imap_port, imap_user, password, use_tls, display_name }) {
  await initEmailTables();
  const encryptedPass = encrypt(password);
  const r = await db.query(
    `INSERT INTO imap_accounts (email, imap_host, imap_port, imap_user, encrypted_pass, use_tls, display_name, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     ON CONFLICT (email) DO UPDATE SET
       imap_host = EXCLUDED.imap_host,
       imap_port = EXCLUDED.imap_port,
       imap_user = EXCLUDED.imap_user,
       encrypted_pass = EXCLUDED.encrypted_pass,
       use_tls = EXCLUDED.use_tls,
       display_name = EXCLUDED.display_name,
       active = TRUE,
       last_error = NULL
     RETURNING id, email`,
    [email, imap_host, imap_port || 993, imap_user, encryptedPass, use_tls !== false, display_name]
  );
  return r.rows[0];
}

async function testAccount({ imap_host, imap_port, imap_user, password, use_tls }) {
  try {
    const client = new ImapFlow({
      host: imap_host,
      port: imap_port || 993,
      secure: use_tls !== false,
      auth: { user: imap_user, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = await client.status("INBOX", { messages: true });
      lock.release();
      await client.logout();
      return { ok: true, messageCount: status.messages };
    } catch (e) {
      lock.release();
      await client.logout();
      return { ok: false, error: `Connected but INBOX not accessible: ${e.message}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listAccounts() {
  await initEmailTables();
  const r = await db.query(
    `SELECT id, email, imap_host, imap_port, active, last_scan_at, last_error, display_name, created_at
     FROM imap_accounts ORDER BY id`
  );
  return r.rows;
}

async function removeAccount(email) {
  const r = await db.query(`DELETE FROM imap_accounts WHERE email = $1 RETURNING id`, [email]);
  return r.rowCount > 0;
}

module.exports = {
  initEmailTables,
  scanAllAccounts,
  scanAccount,
  getPendingThreads,
  markReplied,
  snoozeThread,
  ignoreThread,
  addAllowListPattern,
  addAccount,
  testAccount,
  listAccounts,
  removeAccount,
  encrypt,
  decrypt,
};

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--init")) {
      await initEmailTables();
      console.log("Email tables ready");
      process.exit(0);
    }
    if (args.includes("--scan")) {
      const stats = await scanAllAccounts();
      console.log(JSON.stringify(stats, null, 2));
      process.exit(0);
    }
    console.log("Usage: node email-paralegal.js [--init | --scan]");
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
