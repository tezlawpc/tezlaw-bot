// ============================================================
//  analytics.js — Zara Self-Improvement Engine
//  Tez Law P.C. — Weekly conversation analysis via Claude API
//  Emails JJ a digest with actionable prompt improvements.
//
//  Compatible with db.js (PostgreSQL / pg Pool)
//  Tables used: messages, clients, intakes, client_summaries
// ============================================================

const axios      = require("axios");
const nodemailer = require("nodemailer");
const { Pool }   = require("pg");
const fs         = require("fs");

// ── Config ────────────────────────────────────────────────
const ANALYTICS_LOG  = process.env.ANALYTICS_LOG || "/var/data/analytics_history.json";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const GMAIL_EMAIL    = process.env.GMAIL_EMAIL;
const GMAIL_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const JJ_EMAIL       = "jj@tezlawfirm.com";

// ── Reuse the same pg pool as db.js ──────────────────────
let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

// ── Fetch last N days of conversations ───────────────────
// Uses exact schema from db.js:
//   messages(platform, platform_id, role, content, created_at)
//   clients(platform, platform_id, name, case_type, preferred_language, first_seen)
//   intakes(platform, platform_id, name, issue, contact, case_type, created_at)
async function fetchRecentConversations(days = 7) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await getPool().query(`
      SELECT platform, platform_id, role, content, created_at
      FROM messages
      WHERE created_at > $1
      ORDER BY platform, platform_id, created_at ASC
    `, [since]);

    // Group into conversations keyed by platform:platform_id
    const map = {};
    for (const row of result.rows) {
      const key = `${row.platform}:${row.platform_id}`;
      if (!map[key]) map[key] = { platform: row.platform, platformId: row.platform_id, messages: [] };
      map[key].messages.push({ role: row.role, content: row.content });
    }

    return Object.values(map);
  } catch (err) {
    console.error("fetchRecentConversations error:", err.message);
    return [];
  }
}

// ── Fetch stats: lead count from intakes table ────────────
async function fetchWeekStats(days = 7) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [msgRes, intakeRes, clientRes] = await Promise.all([
      getPool().query(`SELECT COUNT(*) as n FROM messages WHERE created_at > $1`, [since]),
      getPool().query(`SELECT COUNT(*) as n FROM intakes WHERE created_at > $1`, [since]),
      getPool().query(`SELECT COUNT(DISTINCT platform || ':' || platform_id) as n FROM messages WHERE created_at > $1`, [since]),
    ]);

    // Count distinct platforms active this week
    const platRes = await getPool().query(
      `SELECT COUNT(DISTINCT platform) as n FROM messages WHERE created_at > $1`, [since]
    );

    return {
      totalMessages:     parseInt(msgRes.rows[0].n),
      totalConversations:parseInt(clientRes.rows[0].n),
      completedIntakes:  parseInt(intakeRes.rows[0].n),
      activePlatforms:   parseInt(platRes.rows[0].n),
    };
  } catch (err) {
    console.error("fetchWeekStats error:", err.message);
    return { totalMessages: 0, totalConversations: 0, completedIntakes: 0, activePlatforms: 0 };
  }
}

// ── Fetch new intakes this week for digest ─────────────────
async function fetchNewIntakes(days = 7) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const res = await getPool().query(`
      SELECT name, issue, contact, case_type, platform, created_at
      FROM intakes
      WHERE created_at > $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [since]);
    return res.rows;
  } catch (err) {
    console.error("fetchNewIntakes error:", err.message);
    return [];
  }
}

// ── Format conversations for Claude analysis ──────────────
function formatConversationsForAnalysis(conversations) {
  if (!conversations.length) return "No conversations recorded in this period.";

  let out = "";
  let count = 0;
  for (const convo of conversations) {
    if (convo.messages.length < 2) continue; // skip single-message convos
    if (count >= 60) break;                  // cap to control token spend
    out += `\n--- Conversation ${count + 1} [${convo.platform}] ---\n`;
    for (const msg of convo.messages) {
      const label   = msg.role === "assistant" ? "ZARA" : "CLIENT";
      const content = msg.content.length > 400
        ? msg.content.substring(0, 400) + "..."
        : msg.content;
      out += `${label}: ${content}\n`;
    }
    count++;
  }
  return out || "No multi-turn conversations recorded this period.";
}

// ── Claude analysis ───────────────────────────────────────
async function analyzeWithClaude(conversationText, weekLabel) {
  const prompt = `You are analyzing real conversations between Zara (AI legal assistant for Tez Law P.C. in West Covina, CA) and prospective clients over the past 7 days.

Practice areas: Immigration, Car Accidents, Business Litigation, Patents/Trademarks, Estate Planning.

Analyze the conversations and identify:
1. Questions Zara answered weakly, vaguely, or incorrectly
2. Topics that came up repeatedly that Zara lacks depth on
3. Moments clients seemed frustrated, confused, or disengaged
4. Knowledge gaps (things clearly missing from Zara's training)
5. What practice areas dominated this week

Then produce exactly these sections:

## WEEKLY SUMMARY
2-3 sentence overview of the week.

## PRACTICE AREA BREAKDOWN
List each practice area with estimated % of questions.

## TOP ISSUES FOUND
Up to 5 specific problems you observed, with a quote from the conversation if possible.

## RECOMMENDED PROMPT IMPROVEMENTS
Exactly 3 specific, copy-paste-ready additions or edits to Zara's SYSTEM_PROMPT. Be concrete — don't say "add more detail," say exactly what text to add and where.

## URGENT KNOWLEDGE GAPS
Anything Zara clearly got wrong that could mislead a client on a legal matter. Flag these prominently.

## SUGGESTED FOLLOW-UPS
Any clients from this week who seem like warm leads that JJ should personally follow up with (describe their issue without identifying info).

Here are the conversations for ${weekLabel}:

${conversationText}`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-opus-4-5",
      max_tokens: 2500,
      system: "You are a senior AI product manager reviewing a legal chatbot's performance. Be specific, direct, and actionable. Prioritize catching anything that could mislead clients on legal matters.",
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 60000,
    }
  );

  return response.data.content[0].text;
}

// ── Build HTML email ──────────────────────────────────────
function buildEmailHtml(analysis, stats, intakes, weekLabel) {
  const intakeRows = intakes.length
    ? intakes.map(i => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee">${i.name || "—"}</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${i.case_type || "—"}</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${i.contact || "—"}</td>
          <td style="padding:8px;border-bottom:1px solid #eee">${i.platform}</td>
        </tr>`).join("")
    : `<tr><td colspan="4" style="padding:12px;color:#999;text-align:center">No completed intakes this week</td></tr>`;

  // Convert markdown-style ## headers in analysis to styled HTML
  const analysisHtml = analysis
    .replace(/## (.+)/g, '<h3 style="color:#0C1C36;border-bottom:2px solid #B79C62;padding-bottom:4px;margin-top:24px">$1</h3>')
    .replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:720px;margin:0 auto;color:#0C1C36;background:#fff">

  <!-- Header -->
  <div style="background:#0C1C36;padding:24px 28px">
    <h1 style="color:#B79C62;margin:0;font-size:22px">⚡ Zara Weekly Intelligence Report</h1>
    <p style="color:#B79C62;opacity:.7;margin:6px 0 0;font-size:13px">${weekLabel} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}</p>
  </div>

  <div style="padding:24px 28px">

    <!-- Stats -->
    <h2 style="color:#0C1C36;margin-top:0">📈 This Week at a Glance</h2>
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="text-align:center;padding:16px;background:#f5f0e8;border-radius:6px;width:25%">
          <div style="font-size:32px;font-weight:bold;color:#B79C62">${stats.totalConversations}</div>
          <div style="font-size:12px;color:#666;margin-top:4px">Conversations</div>
        </td>
        <td style="width:12px"></td>
        <td style="text-align:center;padding:16px;background:#f5f0e8;border-radius:6px;width:25%">
          <div style="font-size:32px;font-weight:bold;color:#B79C62">${stats.totalMessages}</div>
          <div style="font-size:12px;color:#666;margin-top:4px">Messages</div>
        </td>
        <td style="width:12px"></td>
        <td style="text-align:center;padding:16px;background:#f5f0e8;border-radius:6px;width:25%">
          <div style="font-size:32px;font-weight:bold;color:#B79C62">${stats.completedIntakes}</div>
          <div style="font-size:12px;color:#666;margin-top:4px">Completed Intakes</div>
        </td>
        <td style="width:12px"></td>
        <td style="text-align:center;padding:16px;background:#f5f0e8;border-radius:6px;width:25%">
          <div style="font-size:32px;font-weight:bold;color:#B79C62">${stats.activePlatforms}</div>
          <div style="font-size:12px;color:#666;margin-top:4px">Platforms Active</div>
        </td>
      </tr>
    </table>

    <!-- New Intakes -->
    <h2 style="margin-top:32px">📋 New Intakes This Week</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#0C1C36;color:#B79C62">
          <th style="padding:10px;text-align:left">Name</th>
          <th style="padding:10px;text-align:left">Case Type</th>
          <th style="padding:10px;text-align:left">Contact</th>
          <th style="padding:10px;text-align:left">Platform</th>
        </tr>
      </thead>
      <tbody>${intakeRows}</tbody>
    </table>

    <!-- Claude Analysis -->
    <h2 style="margin-top:32px">🤖 Claude's Analysis</h2>
    <div style="background:#f8f8f8;padding:20px;border-radius:6px;font-size:14px;line-height:1.7">
      ${analysisHtml}
    </div>

    <!-- How to Apply -->
    <h2 style="margin-top:32px">✅ How to Apply Improvements</h2>
    <ol style="font-size:14px;line-height:2">
      <li>Review <strong>RECOMMENDED PROMPT IMPROVEMENTS</strong> above</li>
      <li>Go to GitHub → <code>tezlawpc/tezlaw-telegram-bot</code> → <code>server.js</code></li>
      <li>Find <code>const SYSTEM_PROMPT</code> and apply the suggested edits</li>
      <li>Commit → Render auto-deploys in ~2 minutes</li>
    </ol>
    <p style="font-size:13px;color:#666">To run analytics manually: <code>GET /analytics/run?token=YOUR_SECRET</code></p>

  </div>

  <!-- Footer -->
  <div style="background:#0C1C36;padding:16px 28px;text-align:center">
    <p style="color:#B79C62;margin:0;font-size:12px">TEZ Law P.C. &nbsp;·&nbsp; Zara Analytics Engine &nbsp;·&nbsp; Every Sunday 9:00 AM</p>
  </div>

</body>
</html>`;
}

// ── Send email ────────────────────────────────────────────
async function sendDigestEmail(analysis, stats, intakes, weekLabel) {
  if (!GMAIL_EMAIL || !GMAIL_PASSWORD) {
    console.log("📧 Gmail not configured — printing digest to console:\n");
    console.log(analysis);
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_EMAIL, pass: GMAIL_PASSWORD },
  });

  await transporter.sendMail({
    from: `"Zara Analytics" <${GMAIL_EMAIL}>`,
    to: JJ_EMAIL,
    subject: `📊 Zara Weekly Report — ${weekLabel}`,
    html: buildEmailHtml(analysis, stats, intakes, weekLabel),
  });

  console.log(`📧 Weekly digest sent to ${JJ_EMAIL}`);
}

// ── Analytics history (prevent duplicate runs) ────────────
function loadHistory() {
  try {
    return fs.existsSync(ANALYTICS_LOG)
      ? JSON.parse(fs.readFileSync(ANALYTICS_LOG, "utf8"))
      : {};
  } catch { return {}; }
}

function saveHistory(weekKey, summary) {
  const h = loadHistory();
  h[weekKey] = { ranAt: new Date().toISOString(), summary: summary.substring(0, 500) };
  try { fs.writeFileSync(ANALYTICS_LOG, JSON.stringify(h, null, 2)); } catch {}
}

function getWeekLabel() {
  const now   = new Date();
  const year  = now.getFullYear();
  const start = new Date(year, 0, 1);
  const week  = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  return `Week ${week}, ${year}`;
}

// ── Main entry point ──────────────────────────────────────
async function runWeeklyAnalysis(force = false) {
  const weekLabel = getWeekLabel();
  const weekKey   = weekLabel.replace(/\s/g, "-");

  console.log(`\n📊 Zara Analytics — ${weekLabel}`);

  if (!force) {
    const h = loadHistory();
    if (h[weekKey]) {
      console.log(`✅ Already ran for ${weekLabel} — skipping. Pass force=true to re-run.`);
      return;
    }
  }

  // 1. Fetch data
  console.log("📥 Fetching conversations...");
  const [conversations, stats, intakes] = await Promise.all([
    fetchRecentConversations(7),
    fetchWeekStats(7),
    fetchNewIntakes(7),
  ]);
  console.log(`   ${conversations.length} conversations, ${stats.totalMessages} messages, ${intakes.length} intakes`);

  // 2. Format + analyze
  const formatted = formatConversationsForAnalysis(conversations);
  console.log("🤖 Sending to Claude for analysis...");
  let analysis;
  if (conversations.length === 0) {
    analysis = "## WEEKLY SUMMARY\nNo conversations recorded this week. Zara may have been offline or no clients reached out.\n\n## PRACTICE AREA BREAKDOWN\nN/A\n\n## TOP ISSUES FOUND\nNo data.\n\n## RECOMMENDED PROMPT IMPROVEMENTS\nNo changes suggested — no data to analyze.\n\n## URGENT KNOWLEDGE GAPS\nNone detected.\n\n## SUGGESTED FOLLOW-UPS\nNone.";
  } else {
    analysis = await analyzeWithClaude(formatted, weekLabel);
  }
  console.log("✅ Analysis complete");

  // 3. Email
  await sendDigestEmail(analysis, stats, intakes, weekLabel);

  // 4. Save history
  saveHistory(weekKey, analysis);

  console.log(`🎉 Analytics complete for ${weekLabel}\n`);
  return { analysis, stats, intakes };
}

// ── Scheduler ─────────────────────────────────────────────
function scheduleWeeklyAnalytics() {
  function msUntilSunday9am() {
    const now  = new Date();
    const next = new Date(now);
    next.setDate(now.getDate() + ((7 - now.getDay()) % 7 || 7));
    next.setHours(9, 0, 0, 0);
    return next - now;
  }

  const ms   = msUntilSunday9am();
  const days = Math.floor(ms / 86400000);
  const hrs  = Math.floor((ms % 86400000) / 3600000);
  console.log(`📅 Analytics scheduler active — first run in ${days}d ${hrs}h (Sunday 9:00 AM)`);

  setTimeout(() => {
    runWeeklyAnalysis();
    setInterval(() => runWeeklyAnalysis(), 7 * 24 * 60 * 60 * 1000);
  }, ms);
}

module.exports = { scheduleWeeklyAnalytics, runWeeklyAnalysis };
