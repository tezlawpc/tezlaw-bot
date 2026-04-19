// sol.js — Statute of Limitations Calculator & Alert System (Wave 2)
// Tracks deadlines and sends Telegram alerts at 90/30/7/1 days before deadline

const db = require("./db");
const axios = require("axios");

// California SOL periods by case type (years)
const SOL_RULES = {
  personal_injury:      { years: 2,   label: "Personal Injury" },
  car_accident:         { years: 2,   label: "Car Accident" },
  slip_and_fall:        { years: 2,   label: "Slip & Fall" },
  medical_malpractice:  { years: 3,   label: "Medical Malpractice" },
  wrongful_death:       { years: 2,   label: "Wrongful Death" },
  employment:           { years: 3,   label: "Employment" },
  wage_theft:           { years: 3,   label: "Wage Theft" },
  discrimination:       { years: 1,   label: "Discrimination (DFEH)" },
  contract:             { years: 4,   label: "Contract (written)" },
  oral_contract:        { years: 2,   label: "Contract (oral)" },
  fraud:                { years: 3,   label: "Fraud" },
  property_damage:      { years: 3,   label: "Property Damage" },
  defamation:           { years: 1,   label: "Defamation" },
  eviction:             { years: 1,   label: "Eviction (unlawful detainer)" },
  collections:          { years: 4,   label: "Debt Collections" },
};

function getSolRule(caseType) {
  const key = caseType.toLowerCase().replace(/[\s\-\/]+/g, "_");
  // Try exact match first, then partial
  if (SOL_RULES[key]) return SOL_RULES[key];
  for (const [k, v] of Object.entries(SOL_RULES)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return { years: 2, label: "General (default 2yr)" };
}

function calculateDeadline(incidentDate, caseType) {
  const rule = getSolRule(caseType);
  const incident = new Date(incidentDate);
  const deadline = new Date(incident);
  deadline.setFullYear(deadline.getFullYear() + rule.years);
  const today = new Date();
  const daysLeft = Math.ceil((deadline - today) / (1000 * 60 * 60 * 24));
  return {
    deadline: deadline.toISOString().split("T")[0],
    daysLeft,
    years: rule.years,
    label: rule.label,
    expired: daysLeft < 0,
  };
}

async function sendTelegramAlert(text) {
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID } = process.env;
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return;
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: JJ_TELEGRAM_ID,
    text,
    parse_mode: "Markdown",
  }).catch(e => console.error("SOL Telegram alert error:", e.message));
}

async function checkSolAlerts() {
  try {
    const pool = db.getPool ? db.getPool() : require("pg").Pool;
    const { Pool } = require("pg");
    const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    const result = await p.query(`
      SELECT * FROM sol_deadlines
      WHERE deadline_date > NOW()
      AND (
        (alerted_90 = FALSE AND deadline_date <= NOW() + INTERVAL '90 days') OR
        (alerted_30 = FALSE AND deadline_date <= NOW() + INTERVAL '30 days') OR
        (alerted_7  = FALSE AND deadline_date <= NOW() + INTERVAL '7 days')  OR
        (alerted_1  = FALSE AND deadline_date <= NOW() + INTERVAL '1 day')
      )
    `);

    for (const row of result.rows) {
      const daysLeft = Math.ceil((new Date(row.deadline_date) - new Date()) / (1000 * 60 * 60 * 24));
      let alertLevel = null;
      let field = null;

      if (!row.alerted_1  && daysLeft <= 1)  { alertLevel = "🚨 1 DAY";  field = "alerted_1"; }
      else if (!row.alerted_7  && daysLeft <= 7)  { alertLevel = "🔴 7 DAYS"; field = "alerted_7"; }
      else if (!row.alerted_30 && daysLeft <= 30) { alertLevel = "🟠 30 DAYS"; field = "alerted_30"; }
      else if (!row.alerted_90 && daysLeft <= 90) { alertLevel = "🟡 90 DAYS"; field = "alerted_90"; }

      if (alertLevel && field) {
        const msg = `⚖️ *SOL DEADLINE ALERT — ${alertLevel}*\n\n`
          + `*Client:* ${row.client_name}\n`
          + `*Case Type:* ${row.case_type}\n`
          + `*Incident Date:* ${row.incident_date?.toString().split("T")[0]}\n`
          + `*Deadline:* ${row.deadline_date?.toString().split("T")[0]}\n`
          + `*Days Left:* ${daysLeft}\n`
          + (row.notes ? `*Notes:* ${row.notes}` : "");

        await sendTelegramAlert(msg);
        await p.query(`UPDATE sol_deadlines SET ${field}=TRUE WHERE id=$1`, [row.id]);
        console.log(`⚖️  SOL alert sent: ${row.client_name} — ${daysLeft} days left`);
      }
    }
    await p.end();
  } catch (err) {
    console.error("SOL check error:", err.message);
  }
}

function startSolScheduler() {
  // Check every 6 hours
  setInterval(checkSolAlerts, 6 * 60 * 60 * 1000);
  checkSolAlerts(); // run once on startup
  console.log("⚖️  SOL deadline scheduler started");
}

module.exports = { calculateDeadline, getSolRule, startSolScheduler, checkSolAlerts, SOL_RULES };
