// ============================================================
//  hot-leads.js — Hot Lead Alert Escalation Engine
//  Tez Law P.C.
//
//  Checks every 60 seconds for unacknowledged new leads.
//  Escalation tiers:
//    Level 1 (3 min)  → Telegram ping to JJ
//    Level 2 (8 min)  → SMS via Twilio (if configured)
//    Level 3 (15 min) → Voice call via Twilio (if configured)
//
//  A lead is "acknowledged" when JJ taps the Acknowledge
//  button in the admin panel (POST /api/leads/:id/acknowledge).
// ============================================================

const axios = require("axios");
const { Pool } = require("pg");

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

const ESCALATION_TIERS = [
  { level: 1, minutes: 3,  method: "telegram" },
  { level: 2, minutes: 8,  method: "sms"      },
  { level: 3, minutes: 15, method: "voice"    },
];

// ── Send Telegram alert ───────────────────────────────────
async function sendTelegramAlert(lead) {
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID } = process.env;
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: JJ_TELEGRAM_ID,
      text: `🔥 HOT LEAD — UNACKNOWLEDGED!\n\n` +
            `👤 ${lead.name || "Unknown"}\n` +
            `⚖️ ${lead.case_type || "General"}\n` +
            `📞 ${lead.contact || "No contact"}\n` +
            `📱 ${lead.platform}\n` +
            `⏱ ${Math.round(lead.minutes_waiting)} min waiting\n\n` +
            `Acknowledge in Admin Panel → Pipeline\n` +
            `Or call: 626-678-8677`,
      parse_mode: "Markdown",
    });
    return true;
  } catch (err) {
    console.error("Hot lead Telegram alert error:", err.message);
    return false;
  }
}

// ── Send SMS via Twilio ───────────────────────────────────
async function sendSMSAlert(lead) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, JJ_PHONE } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM || !JJ_PHONE) {
    console.log("[hot-leads] SMS skipped — Twilio not configured");
    return false;
  }
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        To:   JJ_PHONE,
        From: TWILIO_FROM,
        Body: `TEZ LAW ALERT: Hot lead unacknowledged ${Math.round(lead.minutes_waiting)} min!\n` +
              `${lead.name || "Unknown"} — ${lead.case_type || "General"}\n` +
              `${lead.contact || "No contact"}\n` +
              `Acknowledge: tezlaw-bot.onrender.com/admin`,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return true;
  } catch (err) {
    console.error("Hot lead SMS error:", err.message);
    return false;
  }
}

// ── Voice call via Twilio ─────────────────────────────────
async function sendVoiceAlert(lead) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, JJ_PHONE } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM || !JJ_PHONE) {
    console.log("[hot-leads] Voice call skipped — Twilio not configured");
    return false;
  }
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    Alert from Tez Law. You have a hot lead waiting ${Math.round(lead.minutes_waiting)} minutes.
    Client name: ${lead.name || "Unknown"}.
    Case type: ${lead.case_type || "General"}.
    Please check your admin panel or call the client back immediately.
  </Say>
  <Pause length="1"/>
  <Say voice="alice">Repeating. Client name: ${lead.name || "Unknown"}. Case type: ${lead.case_type || "General"}.</Say>
</Response>`;

    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
      new URLSearchParams({
        To:   JJ_PHONE,
        From: TWILIO_FROM,
        Twiml: twiml,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    return true;
  } catch (err) {
    console.error("Hot lead voice call error:", err.message);
    return false;
  }
}

// ── Log escalation to DB ──────────────────────────────────
async function logEscalation(leadId, level, method) {
  try {
    await getPool().query(
      `INSERT INTO escalation_log (lead_id, level, method, sent_at)
       VALUES ($1, $2, $3, NOW())`,
      [leadId, level, method]
    );
  } catch (err) {
    console.error("logEscalation error:", err.message);
  }
}

// ── Check if escalation already sent at this level ───────
async function alreadyEscalated(leadId, level) {
  try {
    const res = await getPool().query(
      `SELECT 1 FROM escalation_log
       WHERE lead_id=$1 AND level=$2 LIMIT 1`,
      [leadId, level]
    );
    return res.rows.length > 0;
  } catch {
    return false;
  }
}

// ── Main escalation check ─────────────────────────────────
async function checkHotLeads() {
  try {
    // Find all new leads that are unacknowledged
    const res = await getPool().query(`
      SELECT id, name, contact, case_type, platform,
        EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS minutes_waiting
      FROM leads
      WHERE stage = 'new_lead'
        AND acknowledged_at IS NULL
        AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at ASC
    `);

    for (const lead of res.rows) {
      const mins = parseFloat(lead.minutes_waiting);

      for (const tier of ESCALATION_TIERS) {
        if (mins >= tier.minutes) {
          const alreadySent = await alreadyEscalated(lead.id, tier.level);
          if (alreadySent) continue;

          console.log(`[hot-leads] Escalating lead ${lead.id} (${lead.name}) — Level ${tier.level} (${tier.method}) after ${Math.round(mins)} min`);

          let sent = false;
          if (tier.method === "telegram") sent = await sendTelegramAlert(lead);
          if (tier.method === "sms")      sent = await sendSMSAlert(lead);
          if (tier.method === "voice")    sent = await sendVoiceAlert(lead);

          if (sent || tier.method !== "telegram") {
            // Always log the escalation attempt
            await logEscalation(lead.id, tier.level, tier.method);
          }
        }
      }
    }
  } catch (err) {
    console.error("checkHotLeads error:", err.message);
  }
}

// ── Start the escalation scheduler ───────────────────────
function startHotLeadMonitor() {
  console.log("🔥 Hot lead monitor started (checking every 60s)");
  // Run immediately, then every 60 seconds
  checkHotLeads();
  setInterval(checkHotLeads, 60 * 1000);
}

module.exports = { startHotLeadMonitor, checkHotLeads };
