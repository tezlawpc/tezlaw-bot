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

// Default drip messages by case type.
//
// October 2026 advertising review: the earlier wording offered a "free
// consultation" (some consultations carry a fee), said "Attorney JJ Zhang is
// reviewing your case" an hour after intake whether or not he was, leaned on
// deadline fear ("we'd hate for you to miss yours"), called him a specialist,
// and never said Zara is automated. These say only what is true at the
// moment they go out, name the firm and its city (B&P § 6157.2(b)), say Zara
// is an automated assistant, and offer a way out in the first message.
const DRIP_TEMPLATES = {
  default: [
    {
      delay_hours: 1,
      message: "Hi {name}, this is Zara, TEZ Law Firm's automated assistant (West Covina, CA). Thank you for reaching out about your {case_type} matter. Someone from our office will follow up with you. Reply here with any questions, or reply STOP and we won't message you again.",
    },
    {
      delay_hours: 24,
      message: "Hi {name}, Zara here, TEZ Law Firm's automated assistant. Would you like to schedule a consultation with attorney JJ Zhang about your {case_type} matter? Reply YES and our office will contact you to find a time and tell you about any consultation fee.",
    },
    {
      delay_hours: 72,
      message: "Hi {name}, a note from TEZ Law Firm: if you'd like to talk with an attorney about your {case_type} matter, reply here or call 626-678-8677.",
    },
    {
      delay_hours: 168,
      message: "Hi {name}, this is our last follow-up from TEZ Law Firm. Reply anytime to connect with our office, or reply STOP and we won't message you again.",
    },
  ],
  immigration: [
    {
      delay_hours: 1,
      message: "Hi {name}, this is Zara, TEZ Law Firm's automated assistant (West Covina, CA). Thank you for reaching out about your immigration matter. Someone from our office will follow up with you. Reply here with any questions, or reply STOP and we won't message you again.",
    },
    {
      delay_hours: 24,
      message: "Hi {name}, Zara here, TEZ Law Firm's automated assistant. Would you like to schedule a consultation with attorney JJ Zhang about your immigration matter? Reply YES and our office will contact you to find a time and tell you about any consultation fee.",
    },
    {
      delay_hours: 72,
      message: "Hi {name}, a note from TEZ Law Firm: if you'd like to talk with an attorney about your immigration matter, reply here or call 626-678-8677.",
    },
    {
      delay_hours: 168,
      message: "Hi {name}, this is our last follow-up from TEZ Law Firm about your immigration matter. Reply anytime to connect with our office, or reply STOP and we won't message you again.",
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
