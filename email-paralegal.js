// ============================================================
//  TEZ LAW P.C. — EMAIL PARALEGAL v1
//  ─────────────────────────────────────────────────────────
//  Scans JJ's Gmail accounts every 30 min, tracks threads
//  where JJ hasn't replied. Twice-daily WhatsApp digest at
//  7 AM and 8 PM Pacific.
//
//  Privacy: LOCAL PATTERN-MATCHING ONLY. Email bodies never
//  leave the server. Classification uses only:
//    - Sender email + domain
//    - Subject line
//    - List-Unsubscribe / Auto-Submitted headers
//    - Recipient count (mass emails)
//    - Marketing/notification keywords in subject
//
//  Multi-account: supports N Gmail accounts. Uses OAuth 2.0
//  with per-account refresh tokens stored in DB.
//
//  Snooze/ignore: JJ can mute individual threads or add
//  sender patterns to a permanent allow-list.
// ============================================================

const axios = require("axios");
const db = require("./db");

// ── Schema ───────────────────────────────────────────────

async function initEmailTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gmail_accounts (
      id             SERIAL PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      refresh_token  TEXT NOT NULL,
      access_token   TEXT,
      token_expiry   TIMESTAMPTZ,
      active         BOOLEAN DEFAULT TRUE,
      last_scan_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW()
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

  // Seed the allow-list on first run
  await seedAllowList();
}

// ── Allow-list Seed Data ─────────────────────────────────
// These patterns catch ~80% of noise emails without needing to read bodies.

async function seedAllowList() {
  const seeds = [
    // Sender email patterns (exact or wildcards handled as substring match)
    { pattern: "noreply@", pattern_type: "sender_contains", reason: "no-reply automation" },
    { pattern: "no-reply@", pattern_type: "sender_contains", reason: "no-reply automation" },
    { pattern: "donotreply@", pattern_type: "sender_contains", reason: "no-reply automation" },
    { pattern: "do-not-reply@", pattern_type: "sender_contains", reason: "no-reply automation" },
    { pattern: "notification@", pattern_type: "sender_contains", reason: "notification bot" },
    { pattern: "notifications@", pattern_type: "sender_contains", reason: "notification bot" },
    { pattern: "updates@", pattern_type: "sender_contains", reason: "update bot" },
    { pattern: "newsletter@", pattern_type: "sender_contains", reason: "newsletter" },
    { pattern: "postmaster@", pattern_type: "sender_contains", reason: "mail system" },
    { pattern: "mailer-daemon@", pattern_type: "sender_contains", reason: "mail system" },
    { pattern: "bounce@", pattern_type: "sender_contains", reason: "bounce handler" },
    { pattern: "bounces@", pattern_type: "sender_contains", reason: "bounce handler" },
    { pattern: "hello@", pattern_type: "sender_contains", reason: "marketing" },
    { pattern: "marketing@", pattern_type: "sender_contains", reason: "marketing" },
    { pattern: "promo@", pattern_type: "sender_contains", reason: "promotional" },
    { pattern: "promotions@", pattern_type: "sender_contains", reason: "promotional" },
    { pattern: "team@", pattern_type: "sender_contains", reason: "generic team" },
    { pattern: "support@", pattern_type: "sender_contains", reason: "support system" },
    { pattern: "help@", pattern_type: "sender_contains", reason: "support system" },
    { pattern: "billing@", pattern_type: "sender_contains", reason: "billing (informational)" },
    { pattern: "invoice@", pattern_type: "sender_contains", reason: "invoice (informational)" },
    { pattern: "receipt@", pattern_type: "sender_contains", reason: "receipt (informational)" },
    { pattern: "orders@", pattern_type: "sender_contains", reason: "order confirmation" },
    { pattern: "confirm@", pattern_type: "sender_contains", reason: "confirmation bot" },
    { pattern: "info@", pattern_type: "sender_contains", reason: "info blast" },
    { pattern: "news@", pattern_type: "sender_contains", reason: "news blast" },

    // Domain patterns
    { pattern: "linkedin.com", pattern_type: "domain", reason: "LinkedIn notifications" },
    { pattern: "mailchimp.com", pattern_type: "domain", reason: "mailchimp campaigns" },
    { pattern: "constantcontact.com", pattern_type: "domain", reason: "constant contact campaigns" },
    { pattern: "hubspot.com", pattern_type: "domain", reason: "hubspot campaigns" },
    { pattern: "salesforce.com", pattern_type: "domain", reason: "salesforce automation" },
    { pattern: "sendgrid.net", pattern_type: "domain", reason: "sendgrid campaigns" },
    { pattern: "mailgun.org", pattern_type: "domain", reason: "mailgun campaigns" },
    { pattern: "amazonses.com", pattern_type: "domain", reason: "ses campaigns" },
    { pattern: "mail.notion.so", pattern_type: "domain", reason: "notion notifications" },
    { pattern: "e.godaddy.com", pattern_type: "domain", reason: "godaddy marketing" },
    { pattern: "email.godaddy.com", pattern_type: "domain", reason: "godaddy marketing" },
    { pattern: "e.wordpress.com", pattern_type: "domain", reason: "wordpress marketing" },
    { pattern: "google.com", pattern_type: "domain_exact", reason: "google internal (usually notification)" },
    { pattern: "facebookmail.com", pattern_type: "domain", reason: "facebook notifications" },
    { pattern: "meetup.com", pattern_type: "domain", reason: "meetup notifications" },
    { pattern: "youtube.com", pattern_type: "domain", reason: "youtube notifications" },
    { pattern: "eventbrite.com", pattern_type: "domain", reason: "eventbrite" },
    { pattern: "zoom.us", pattern_type: "domain", reason: "zoom notifications" },
    { pattern: "docusign.net", pattern_type: "domain", reason: "docusign notifications" },
    { pattern: "docusign.com", pattern_type: "domain", reason: "docusign notifications" },

    // Subject patterns (case-insensitive substring)
    { pattern: "unsubscribe", pattern_type: "subject_contains", reason: "unsubscribe language" },
    { pattern: "newsletter", pattern_type: "subject_contains", reason: "newsletter" },
    { pattern: "% off", pattern_type: "subject_contains", reason: "promotional" },
    { pattern: "% OFF", pattern_type: "subject_contains", reason: "promotional" },
    { pattern: "your receipt", pattern_type: "subject_contains", reason: "receipt" },
    { pattern: "order confirmation", pattern_type: "subject_contains", reason: "order confirmation" },
    { pattern: "your invoice", pattern_type: "subject_contains", reason: "invoice" },
    { pattern: "invoice from", pattern_type: "subject_contains", reason: "invoice" },
    { pattern: "payment received", pattern_type: "subject_contains", reason: "payment confirmation" },
    { pattern: "delivery update", pattern_type: "subject_contains", reason: "delivery notification" },
    { pattern: "shipping notification", pattern_type: "subject_contains", reason: "shipping notification" },
    { pattern: "your package", pattern_type: "subject_contains", reason: "package notification" },
    { pattern: "webinar", pattern_type: "subject_contains", reason: "webinar promotion" },
    { pattern: "you're invited", pattern_type: "subject_contains", reason: "generic invite" },
    { pattern: "weekly digest", pattern_type: "subject_contains", reason: "weekly digest" },
    { pattern: "daily digest", pattern_type: "subject_contains", reason: "daily digest" },
    { pattern: "your daily", pattern_type: "subject_contains", reason: "daily automation" },
    { pattern: "your weekly", pattern_type: "subject_contains", reason: "weekly automation" },
    { pattern: "last chance", pattern_type: "subject_contains", reason: "marketing urgency" },
    { pattern: "limited time", pattern_type: "subject_contains", reason: "marketing urgency" },
    { pattern: "flash sale", pattern_type: "subject_contains", reason: "sale marketing" },
    { pattern: "clearance", pattern_type: "subject_contains", reason: "sale marketing" },
    { pattern: "expiring soon", pattern_type: "subject_contains", reason: "marketing" },
    { pattern: "[spam]", pattern_type: "subject_contains", reason: "spam label" },
    { pattern: "[bulk]", pattern_type: "subject_contains", reason: "bulk mail" },
    { pattern: "unsubscribe:", pattern_type: "subject_contains", reason: "unsubscribe language" },
    { pattern: "meeting recording", pattern_type: "subject_contains", reason: "recording notification" },
    { pattern: "cloud recording", pattern_type: "subject_contains", reason: "recording notification" },
    { pattern: "case status update", pattern_type: "subject_contains", reason: "mycase notification" },
    { pattern: "clio update", pattern_type: "subject_contains", reason: "clio notification" },
  ];

  for (const s of seeds) {
    try {
      await db.query(
        `INSERT INTO email_allow_list (pattern, pattern_type, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (pattern, pattern_type) DO NOTHING`,
        [s.pattern, s.pattern_type, s.reason]
      );
    } catch (e) {
      // ignore conflicts
    }
  }
}

// ── OAuth Token Refresh ──────────────────────────────────

async function refreshAccessToken(account) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in Render env vars");
  }

  const resp = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refresh_token,
      grant_type: "refresh_token",
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  const { access_token, expires_in } = resp.data;
  const expiry = new Date(Date.now() + (expires_in - 60) * 1000); // 60s safety margin

  await db.query(
    `UPDATE gmail_accounts SET access_token = $1, token_expiry = $2 WHERE id = $3`,
    [access_token, expiry, account.id]
  );

  return access_token;
}

async function getValidAccessToken(account) {
  if (account.access_token && account.token_expiry && new Date(account.token_expiry) > new Date()) {
    return account.access_token;
  }
  return await refreshAccessToken(account);
}

// ── Gmail API Calls ──────────────────────────────────────

async function listRecentThreads(accessToken, sinceDaysAgo = 7) {
  const sinceEpoch = Math.floor((Date.now() - sinceDaysAgo * 86400 * 1000) / 1000);
  const query = `newer_than:${sinceDaysAgo}d`;

  const resp = await axios.get(
    "https://gmail.googleapis.com/gmail/v1/users/me/threads",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { q: query, maxResults: 100 },
    }
  );

  return resp.data.threads || [];
}

async function fetchThread(accessToken, threadId) {
  const resp = await axios.get(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date", "List-Unsubscribe", "Auto-Submitted", "Precedence"] },
    }
  );
  return resp.data;
}

// ── Header Extraction Helpers ────────────────────────────

function extractHeader(headers, name) {
  if (!headers) return null;
  const h = headers.find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function parseEmailAddress(headerValue) {
  if (!headerValue) return { name: null, email: null, domain: null };
  // Handles: "John Doe <john@example.com>" and "john@example.com"
  const match = headerValue.match(/^(?:"?([^"<]*)"?\s*<)?([^>]+@[^>]+?)>?$/);
  if (!match) return { name: null, email: headerValue.toLowerCase(), domain: null };
  const name = (match[1] || "").trim();
  const email = match[2].trim().toLowerCase();
  const domain = email.split("@")[1] || null;
  return { name: name || null, email, domain };
}

function countRecipients(headers) {
  const to = extractHeader(headers, "To") || "";
  const cc = extractHeader(headers, "Cc") || "";
  const combined = to + "," + cc;
  return (combined.match(/@/g) || []).length;
}

// ── Classification (Local Pattern Matching Only) ─────────

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

  // 1. Auto-Submitted header (RFC 3834)
  const autoSubmitted = extractHeader(headers, "Auto-Submitted");
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
    return { skip: true, reason: `auto-submitted: ${autoSubmitted}` };
  }

  // 2. Precedence: bulk / list / junk
  const precedence = extractHeader(headers, "Precedence");
  if (precedence && ["bulk", "list", "junk"].includes(precedence.toLowerCase())) {
    return { skip: true, reason: `precedence: ${precedence}` };
  }

  // 3. List-Unsubscribe header (RFC 2369) — indicates mailing list
  const listUnsub = extractHeader(headers, "List-Unsubscribe");
  if (listUnsub) {
    return { skip: true, reason: "has List-Unsubscribe header (mailing list)" };
  }

  // 4. Mass recipient (> 5) suggests broadcast, not personal
  if (recipientCount > 5) {
    return { skip: true, reason: `${recipientCount} recipients (mass email)` };
  }

  // 5. Allow-list pattern matches
  const subjectLower = (subject || "").toLowerCase();
  const senderLower = (senderEmail || "").toLowerCase();
  const domainLower = (senderDomain || "").toLowerCase();

  for (const entry of allowList) {
    const p = entry.pattern.toLowerCase();
    if (entry.pattern_type === "sender_exact" && senderLower === p) {
      return { skip: true, reason: `allow-list: sender=${entry.pattern}` };
    }
    if (entry.pattern_type === "sender_contains" && senderLower.includes(p)) {
      return { skip: true, reason: `allow-list: sender contains ${entry.pattern}` };
    }
    if (entry.pattern_type === "domain_exact" && domainLower === p) {
      return { skip: true, reason: `allow-list: domain=${entry.pattern}` };
    }
    if (entry.pattern_type === "domain" && (domainLower === p || domainLower.endsWith("." + p))) {
      return { skip: true, reason: `allow-list: domain=${entry.pattern}` };
    }
    if (entry.pattern_type === "subject_contains" && subjectLower.includes(p)) {
      return { skip: true, reason: `allow-list: subject contains "${entry.pattern}"` };
    }
  }

  return { skip: false };
}

// ── Main Scan Function ───────────────────────────────────

async function scanAccount(account) {
  await initEmailTables();
  const accessToken = await getValidAccessToken(account);

  console.log(`[email-scanner] Scanning ${account.email}...`);

  // Get the "me" email address for this account (to identify who JJ is)
  let myEmail = account.email.toLowerCase();
  try {
    const profileResp = await axios.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (profileResp.data.emailAddress) {
      myEmail = profileResp.data.emailAddress.toLowerCase();
    }
  } catch (_) {}

  const threads = await listRecentThreads(accessToken, 7);
  let stats = { total: threads.length, tracked: 0, skipped: 0, alreadyReplied: 0, autoSkipped: 0 };

  for (const t of threads) {
    try {
      const thread = await fetchThread(accessToken, t.id);
      if (!thread.messages || !thread.messages.length) continue;

      const messages = thread.messages;
      const lastMsg = messages[messages.length - 1];
      const lastHeaders = lastMsg.payload?.headers || [];
      const fromHeader = extractHeader(lastHeaders, "From");
      const parsedFrom = parseEmailAddress(fromHeader);

      // Check: did JJ send the last message? If so, JJ has replied.
      const jjIsLastSender = parsedFrom.email && parsedFrom.email === myEmail;
      if (jjIsLastSender) {
        // Mark any existing tracker entry for this thread as replied
        await db.query(
          `UPDATE email_tracker SET status = 'replied', last_checked_at = NOW()
           WHERE account_email = $1 AND thread_id = $2 AND status = 'pending'`,
          [account.email, t.id]
        );
        stats.alreadyReplied++;
        continue;
      }

      // Check if JJ ever replied in this thread (any message sent by JJ)
      const jjEverReplied = messages.some(m => {
        const fh = extractHeader(m.payload?.headers || [], "From");
        return parseEmailAddress(fh).email === myEmail;
      });
      if (jjEverReplied) {
        // Thread has back-and-forth. JJ replied at some point.
        // But the LAST message isn't from JJ, so someone re-replied.
        // Consider this a NEW email needing a reply.
      }

      const subject = extractHeader(lastHeaders, "Subject") || "(no subject)";
      const dateStr = extractHeader(lastHeaders, "Date");
      const receivedAt = dateStr ? new Date(dateStr) : new Date(parseInt(lastMsg.internalDate) || Date.now());
      const recipientCount = countRecipients(lastHeaders);

      // Pattern-match allow-list check
      const skipDecision = await shouldSkip({
        senderEmail: parsedFrom.email,
        senderDomain: parsedFrom.domain,
        subject,
        headers: lastHeaders,
        recipientCount,
      });

      if (skipDecision.skip) {
        stats.autoSkipped++;
        // Still record it as 'ignored' so we don't rescan every time
        await db.query(
          `INSERT INTO email_tracker
            (account_email, thread_id, message_id, sender_name, sender_email, sender_domain,
             subject, received_at, status, last_checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ignored', NOW())
           ON CONFLICT (account_email, thread_id) DO UPDATE SET
             last_checked_at = NOW(),
             status = CASE WHEN email_tracker.status = 'pending' THEN 'ignored' ELSE email_tracker.status END`,
          [account.email, t.id, lastMsg.id, parsedFrom.name, parsedFrom.email, parsedFrom.domain,
           subject, receivedAt]
        );
        continue;
      }

      // Insert or update as pending
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
        [account.email, t.id, lastMsg.id, parsedFrom.name, parsedFrom.email, parsedFrom.domain,
         subject, receivedAt]
      );

      stats.tracked++;
    } catch (e) {
      console.error(`[email-scanner] Error processing thread ${t.id}:`, e.message);
    }
  }

  await db.query(
    `UPDATE gmail_accounts SET last_scan_at = NOW() WHERE id = $1`,
    [account.id]
  );

  console.log(`[email-scanner] ${account.email}: ${stats.tracked} tracked, ${stats.autoSkipped} auto-skipped, ${stats.alreadyReplied} already-replied out of ${stats.total} threads`);
  return stats;
}

async function scanAllAccounts() {
  await initEmailTables();
  const accounts = await db.query(`SELECT * FROM gmail_accounts WHERE active = TRUE`);
  const allStats = [];
  for (const account of accounts.rows) {
    try {
      const stats = await scanAccount(account);
      allStats.push({ email: account.email, ...stats });
    } catch (e) {
      console.error(`[email-scanner] Failed to scan ${account.email}:`, e.message);
      allStats.push({ email: account.email, error: e.message });
    }
  }
  return allStats;
}

// ── Query Functions For Digest ───────────────────────────

/**
 * Get all pending (unreplied) threads, grouped by urgency.
 */
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

/**
 * Add an allow-list rule at runtime (from /ignore command).
 */
async function addAllowListPattern(pattern, patternType, reason) {
  const r = await db.query(
    `INSERT INTO email_allow_list (pattern, pattern_type, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (pattern, pattern_type) DO NOTHING
     RETURNING id`,
    [pattern, patternType, reason || "user-added"]
  );
  allowListCache = null; // bust cache
  return r.rows[0];
}

// ── Account Management ───────────────────────────────────

async function addAccount(email, refreshToken) {
  await initEmailTables();
  const r = await db.query(
    `INSERT INTO gmail_accounts (email, refresh_token, active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (email) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       active = TRUE
     RETURNING id, email`,
    [email, refreshToken]
  );
  return r.rows[0];
}

async function listAccounts() {
  await initEmailTables();
  const r = await db.query(
    `SELECT id, email, active, last_scan_at, created_at FROM gmail_accounts ORDER BY id`
  );
  return r.rows;
}

async function removeAccount(email) {
  const r = await db.query(
    `DELETE FROM gmail_accounts WHERE email = $1 RETURNING id`,
    [email]
  );
  return r.rowCount > 0;
}

// ── Exports ──────────────────────────────────────────────

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
  listAccounts,
  removeAccount,
};

// CLI mode
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--init")) {
      await initEmailTables();
      console.log("email_tracker + gmail_accounts + email_allow_list tables ready");
      process.exit(0);
    }
    if (args.includes("--scan")) {
      const stats = await scanAllAccounts();
      console.log("Scan complete:", JSON.stringify(stats, null, 2));
      process.exit(0);
    }
    if (args.includes("--accounts")) {
      const accounts = await listAccounts();
      console.log(accounts);
      process.exit(0);
    }
    if (args.includes("--pending")) {
      const threads = await getPendingThreads();
      console.log(`${threads.length} pending threads:`);
      for (const t of threads) console.log(`  ${t.account_email} | ${t.sender_email} | ${t.subject} (${Math.round(t.hours_old)}h old)`);
      process.exit(0);
    }
    console.log("Usage: node email-paralegal.js [--init | --scan | --accounts | --pending]");
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
