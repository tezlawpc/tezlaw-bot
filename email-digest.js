// ============================================================
//  TEZ LAW P.C. — EMAIL DIGEST BUILDER
//  ─────────────────────────────────────────────────────────
//  Runs twice a day (7 AM & 8 PM Pacific) to build and send
//  a WhatsApp digest of unreplied emails to JJ.
// ============================================================

const axios = require("axios");
const {
  getPendingThreads,
  scanAllAccounts,
} = require("./email-paralegal");

// ── Formatting Helpers ───────────────────────────────────

function ageBucket(hoursOld) {
  if (hoursOld < 24) return "recent";
  if (hoursOld < 72) return "pending";
  return "urgent";
}

function formatAge(hoursOld) {
  if (hoursOld < 24) return `${Math.round(hoursOld)}h`;
  return `${Math.round(hoursOld / 24)}d`;
}

function truncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.substring(0, max - 1) + "…";
}

function displayName(t) {
  if (t.sender_name && t.sender_name.trim()) return t.sender_name;
  return t.sender_email || "(unknown)";
}

/**
 * Build the WhatsApp digest message. Splits into chunks if > 3800 chars.
 */
function buildDigestMessage(threads, timeLabel = "morning") {
  if (!threads || !threads.length) {
    return [`📬 *No unreplied emails* (${timeLabel} digest)\n\nYou're caught up. Nice work.`];
  }

  const buckets = { urgent: [], pending: [], recent: [] };
  for (const t of threads) {
    buckets[ageBucket(parseFloat(t.hours_old))].push(t);
  }

  const lines = [];
  lines.push(`📬 *Unreplied emails — ${timeLabel} digest*`);
  lines.push(`Total: ${threads.length} threads across ${new Set(threads.map(t => t.account_email)).size} account(s)`);
  lines.push("");

  let itemNum = 0;

  if (buckets.urgent.length) {
    lines.push(`🔴 *URGENT (>3 days)*`);
    for (const t of buckets.urgent) {
      itemNum++;
      lines.push(formatThread(itemNum, t));
    }
    lines.push("");
  }

  if (buckets.pending.length) {
    lines.push(`🟡 *PENDING (1-3 days)*`);
    for (const t of buckets.pending) {
      itemNum++;
      lines.push(formatThread(itemNum, t));
    }
    lines.push("");
  }

  if (buckets.recent.length) {
    lines.push(`🟢 *RECENT (<24h)*`);
    for (const t of buckets.recent) {
      itemNum++;
      lines.push(formatThread(itemNum, t));
    }
    lines.push("");
  }

  lines.push(`_Reply:_`);
  lines.push(`  \`/replied <id>\` — mark handled`);
  lines.push(`  \`/snooze <id> <days>\` — mute temporarily`);
  lines.push(`  \`/ignore <id>\` — stop tracking this thread`);
  lines.push(`  \`/unreplied\` — refresh digest anytime`);

  const full = lines.join("\n");
  return splitForWhatsApp(full);
}

function formatThread(num, t) {
  const age = formatAge(parseFloat(t.hours_old));
  const name = truncate(displayName(t), 40);
  const email = truncate(t.sender_email || "", 40);
  const subject = truncate(t.subject || "(no subject)", 70);
  const acct = t.account_email.split("@")[0];

  return `${num}. [${age}] *${name}* <${email}>\n   "${subject}"\n   → ${acct}@ • \`id:${t.id}\``;
}

function splitForWhatsApp(text, limit = 3800) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    // Try to split on double newline (paragraph)
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(remaining.substring(0, cut).trim());
    remaining = remaining.substring(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Send To WhatsApp ─────────────────────────────────────

async function sendToWhatsApp(chunks) {
  const to = process.env.JJ_WHATSAPP_NUMBER; // format: 16266788677 (no +)
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!to || !token || !phoneNumberId) {
    throw new Error("JJ_WHATSAPP_NUMBER, WHATSAPP_TOKEN, PHONE_NUMBER_ID must be set");
  }

  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    // Small delay between chunks to preserve order
    await new Promise(r => setTimeout(r, 300));
  }
}

// ── Main Digest Runners ──────────────────────────────────

async function runDigest(timeLabel = "morning", options = {}) {
  console.log(`[email-digest] Running ${timeLabel} digest...`);

  // Step 1: fresh scan of all accounts (unless caller says skip)
  if (!options.skipScan) {
    try {
      await scanAllAccounts();
    } catch (e) {
      console.error(`[email-digest] Scan failed (proceeding with existing data): ${e.message}`);
    }
  }

  // Step 2: query all pending threads
  const threads = await getPendingThreads();

  // Step 3: format
  const chunks = buildDigestMessage(threads, timeLabel);

  // Step 4: send unless dry-run
  if (options.dryRun) {
    console.log("[email-digest] DRY RUN — would have sent:");
    for (const c of chunks) console.log(c, "\n---");
    return { threadCount: threads.length, chunks: chunks.length };
  }

  await sendToWhatsApp(chunks);
  console.log(`[email-digest] Sent ${chunks.length} chunk(s) covering ${threads.length} threads.`);
  return { threadCount: threads.length, chunks: chunks.length };
}

async function runMorningDigest() { return runDigest("morning"); }
async function runEveningDigest() { return runDigest("evening"); }

// ── Scheduler ────────────────────────────────────────────

function startEmailScheduler() {
  const cron = require("node-cron");

  // 7:00 AM Pacific = 15:00 UTC (with DST it varies, but Render's TZ is UTC)
  // Node-cron with runtime TZ: use options with timezone
  cron.schedule("0 7 * * *", () => {
    runMorningDigest().catch(e => console.error("[digest] morning failed:", e.message));
  }, { timezone: "America/Los_Angeles" });

  // 8:00 PM Pacific
  cron.schedule("0 20 * * *", () => {
    runEveningDigest().catch(e => console.error("[digest] evening failed:", e.message));
  }, { timezone: "America/Los_Angeles" });

  // Every 30 min: background scan (no digest)
  cron.schedule("*/30 * * * *", () => {
    scanAllAccounts().catch(e => console.error("[email-scan] cron failed:", e.message));
  });

  console.log("📬 Email paralegal scheduler started (7 AM + 8 PM PT digest, scan every 30 min).");
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  runMorningDigest,
  runEveningDigest,
  runDigest,
  buildDigestMessage,
  startEmailScheduler,
  sendToWhatsApp,
};

// CLI mode
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--morning")) {
      await runMorningDigest();
      process.exit(0);
    }
    if (args.includes("--evening")) {
      await runEveningDigest();
      process.exit(0);
    }
    if (args.includes("--dry-run")) {
      await runDigest("test", { dryRun: true, skipScan: true });
      process.exit(0);
    }
    console.log("Usage: node email-digest.js [--morning | --evening | --dry-run]");
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
