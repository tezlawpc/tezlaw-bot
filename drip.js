// drip.js — Drip Campaign Engine (Wave 2)
// Auto-sends follow-up messages after intake at 1hr / 24hr / 3day / 7day
// Stops when client responds or signs

const { Pool } = require("pg");
const axios    = require("axios");

let pool = null;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return pool;
}

// Default drip messages by case type
const DRIP_TEMPLATES = {
  default: [
    {
      delay_hours: 1,
      message: "Hi {name}! 👋 This is Zara from Tez Law. Just checking in — do you have any questions about your {case_type} case? Attorney JJ Zhang is reviewing your information and will be in touch soon.",
    },
    {
      delay_hours: 24,
      message: "Hi {name}, Zara here from Tez Law again. We want to make sure you get the help you need for your {case_type} matter. Would you like to schedule a free consultation with Attorney JJ Zhang? Just reply YES and we'll get you set up! 📅",
    },
    {
      delay_hours: 72,
      message: "Hi {name}! Tez Law here. Many clients with {case_type} cases have important deadlines — we'd hate for you to miss yours. Attorney JJ Zhang offers free consultations. Reply anytime to get started. 🏛️",
    },
    {
      delay_hours: 168,
      message: "Hi {name}, final follow-up from Tez Law. If you're still looking for legal help with your {case_type} matter, Attorney JJ Zhang is ready to assist. Reply STOP to opt out, or reply anytime to connect. ⚖️",
    },
  ],
  immigration: [
    {
      delay_hours: 1,
      message: "Hi {name}! 👋 This is Zara from Tez Law. Your immigration matter is important — Attorney JJ Zhang specializes in immigration law and is reviewing your case. Any questions? Just reply!",
    },
    {
      delay_hours: 24,
      message: "Hi {name}, Zara from Tez Law. Immigration cases often have urgent filing deadlines. Would you like a free consultation with Attorney JJ Zhang to discuss your options? Reply YES to schedule! 📅",
    },
    {
      delay_hours: 72,
      message: "Hi {name}! Immigration law changes frequently. Tez Law stays current on all USCIS updates to protect your case. Reply anytime — Attorney JJ Zhang is here to help. 🏛️",
    },
    {
      delay_hours: 168,
      message: "Hi {name}, last check-in from Tez Law about your immigration matter. We're here whenever you're ready. Reply STOP to opt out or reply to connect with Attorney JJ Zhang. ⚖️",
    },
  ],
};

function getTemplate(caseType) {
  const key = (caseType || "").toLowerCase();
  if (key.includes("immigr") || key.includes("visa") || key.includes("uscis") || key.includes("asylum")) {
    return DRIP_TEMPLATES.immigration;
  }
  return DRIP_TEMPLATES.default;
}

function fillTemplate(template, name, caseType) {
  return template
    .replace(/{name}/g, name || "there")
    .replace(/{case_type}/g, caseType || "legal");
}

async function startDripCampaign(platform, platformId, intakeId, clientName, caseType) {
  try {
    const p = getPool();
    // Don't start if already active
    const existing = await p.query(
      `SELECT id FROM drip_campaigns WHERE platform_id=$1 AND status='active'`,
      [platformId]
    );
    if (existing.rows.length) return;

    const r = await p.query(
      `INSERT INTO drip_campaigns (platform, platform_id, intake_id, client_name, case_type)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [platform, platformId, intakeId, clientName, caseType]
    );
    const campaignId = r.rows[0].id;

    const templates = getTemplate(caseType);
    for (const t of templates) {
      await p.query(
        `INSERT INTO drip_messages (campaign_id, delay_hours, message_text) VALUES ($1,$2,$3)`,
        [campaignId, t.delay_hours, fillTemplate(t.message, clientName, caseType)]
      );
    }
    console.log(`📧 Drip campaign started for ${clientName} (${caseType}) — ${templates.length} messages queued`);
  } catch (err) {
    console.error("Drip start error:", err.message);
  }
}

async function stopDripCampaign(platformId, reason) {
  try {
    await getPool().query(
      `UPDATE drip_campaigns SET status='stopped', stopped_at=NOW(), stop_reason=$1
       WHERE platform_id=$2 AND status='active'`,
      [reason, platformId]
    );
    console.log(`🛑 Drip stopped for ${platformId}: ${reason}`);
  } catch (err) {
    console.error("Drip stop error:", err.message);
  }
}

async function sendPlatformMessage(platform, platformId, message) {
  try {
    if (platform === "telegram") {
      await axios.post(
        `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: platformId, text: message }
      );
      return true;
    }
    // WhatsApp, Messenger, Website — log for now, implement per platform
    console.log(`[DRIP] Would send to ${platform}/${platformId}: ${message.substring(0, 80)}...`);
    return true;
  } catch (err) {
    console.error(`Drip send error (${platform}):`, err.message);
    return false;
  }
}

async function processDripQueue() {
  try {
    const p = getPool();
    // Find pending messages whose delay has elapsed
    const result = await p.query(`
      SELECT dm.*, dc.platform, dc.platform_id, dc.client_name, dc.status as campaign_status
      FROM drip_messages dm
      JOIN drip_campaigns dc ON dm.campaign_id = dc.id
      WHERE dm.status = 'pending'
        AND dc.status = 'active'
        AND dc.started_at + (dm.delay_hours || ' hours')::interval <= NOW()
      ORDER BY dm.campaign_id, dm.delay_hours
    `);

    for (const msg of result.rows) {
      const sent = await sendPlatformMessage(msg.platform, msg.platform_id, msg.message_text);
      await p.query(
        `UPDATE drip_messages SET status=$1, sent_at=NOW() WHERE id=$2`,
        [sent ? "sent" : "failed", msg.id]
      );
      if (sent) {
        console.log(`📧 Drip sent to ${msg.client_name} (${msg.platform}) — delay: ${msg.delay_hours}h`);
      }
    }
  } catch (err) {
    console.error("Drip queue error:", err.message);
  }
}

function startDripScheduler() {
  setInterval(processDripQueue, 15 * 60 * 1000); // every 15 min
  processDripQueue();
  console.log("📧 Drip campaign scheduler started (every 15 min)");
}

module.exports = { startDripCampaign, stopDripCampaign, startDripScheduler, processDripQueue };
