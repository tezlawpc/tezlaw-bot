// ============================================================
//  intake.js — Structured Intake Flow for Zara
//  Tez Law P.C.
//
//  Flow: detect legal intent → ask name → ask issue detail
//        → ask contact → save to DB → notify Telegram + Email
//        → continue conversation normally
//
//  State machine stored in PostgreSQL (client_summaries table
//  reused with a special prefix, so no new table needed).
//  Uses existing: saveIntake(), updateClient(), notifyLead()
// ============================================================

const axios      = require("axios");
const nodemailer = require("nodemailer");
const { Pool }   = require("pg");

// ── DB pool (same pattern as db.js) ──────────────────────
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

// ── Intake state keys (stored in pg) ─────────────────────
// We store intake state as a small JSON blob in a dedicated table.
// States: null → "awaiting_name" → "awaiting_issue" → "awaiting_contact" → "done"

async function getIntakeState(platform, platformId) {
  try {
    const res = await getPool().query(
      `SELECT state FROM intake_state WHERE platform=$1 AND platform_id=$2`,
      [platform, platformId]
    );
    return res.rows[0] ? JSON.parse(res.rows[0].state) : null;
  } catch { return null; }
}

async function setIntakeState(platform, platformId, stateObj) {
  try {
    await getPool().query(
      `INSERT INTO intake_state (platform, platform_id, state, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (platform, platform_id)
       DO UPDATE SET state=$3, updated_at=NOW()`,
      [platform, platformId, JSON.stringify(stateObj)]
    );
  } catch (err) {
    console.error("setIntakeState error:", err.message);
  }
}

async function clearIntakeState(platform, platformId) {
  try {
    await getPool().query(
      `DELETE FROM intake_state WHERE platform=$1 AND platform_id=$2`,
      [platform, platformId]
    );
  } catch {}
}

// ── Create intake_state table if it doesn't exist ────────
async function initIntakeTable() {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS intake_state (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20) NOT NULL,
        platform_id VARCHAR(100) NOT NULL,
        state TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(platform, platform_id)
      );
    `);
    console.log("✅ intake_state table ready");
  } catch (err) {
    console.error("initIntakeTable error:", err.message);
  }
}

// ── Legal intent detector ─────────────────────────────────
// Returns true if the message is clearly about a legal matter
// (not a greeting, general question, or test)
function isLegalIntent(text) {
  const t = text.toLowerCase();

  // Explicit legal keywords
  const legalKeywords = [
    // Immigration
    "visa","green card","citizenship","naturalization","daca","deportation",
    "immigration","uscis","work permit","ead","i-130","i-485","i-90",
    "asylum","refugee","overstay","undocumented","ice","detained","nta",
    "removal","petition","sponsor","h-1b","h1b","eb-","adjustment of status",
    "consular","interview","waiver","inadmissible",
    // Car accidents / PI
    "accident","car crash","hit","injury","injured","hospital","whiplash",
    "rear-end","personal injury","insurance claim","medical bills","pain",
    "settlement","liability","at fault",
    // Business
    "contract","lawsuit","sued","being sued","non-compete","trade secret",
    "breach","corporation","llc","partnership","dispute","litigation",
    "trademark","patent","copyright","intellectual property",
    // Estate
    "will","trust","estate","probate","inheritance","beneficiary",
    "power of attorney","executor","trustee","heir",
    // Eviction / landlord
    "eviction","evict","landlord","tenant","lease","rent","notice to quit",
    "unlawful detainer","3-day","30-day",
    // General legal intent
    "lawyer","attorney","legal help","legal advice","law firm","consultation",
    "case","sue","file","court","hearing","judge","rights","legal issue",
    // Spanish
    "abogado","visa","accidente","demanda","herencia","contrato","ayuda legal",
    // Chinese
    "律师","签证","绿卡","移民","事故","遗嘱","合同","诉讼","法律"
  ];

  return legalKeywords.some(k => t.includes(k));
}

// ── Detect case type from message ────────────────────────
function detectCaseType(text) {
  const t = text.toLowerCase();
  if (/visa|green card|citizenship|immigration|uscis|daca|deportation|asylum|h-1b|eb-|overstay|undocumented|ice|removal|naturalization|petition|i-130|i-485/.test(t)) return "Immigration";
  if (/accident|crash|injury|injured|hospital|whiplash|personal injury|insurance claim|medical bills/.test(t)) return "Car Accident / Personal Injury";
  if (/eviction|evict|landlord|tenant|lease|rent|unlawful detainer|3-day|notice to quit/.test(t)) return "Landlord / Tenant";
  if (/will|trust|estate|probate|inheritance|beneficiary|power of attorney|executor/.test(t)) return "Estate Planning";
  if (/trademark|patent|copyright|intellectual property/.test(t)) return "Patents & Trademarks";
  if (/contract|lawsuit|sued|non-compete|trade secret|breach|corporation|llc|dispute|litigation/.test(t)) return "Business Litigation";
  return "General Legal";
}

// ── Notify Telegram ───────────────────────────────────────
async function notifyTelegram(data) {
  const { TELEGRAM_TOKEN, TEAM_TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_TOKEN || !TEAM_TELEGRAM_CHAT_ID) return;

  const text = `📋 NEW INTAKE — ${data.platform.toUpperCase()}

👤 Name: ${data.name || "Not provided"}
⚖️ Case Type: ${data.caseType}
📝 Issue: ${data.issue}
📞 Contact: ${data.contact}
🕐 Time: ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT

Reply to this client ASAP! 🔔`;

  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: TEAM_TELEGRAM_CHAT_ID,
    text,
  });
}

// ── Notify Email ──────────────────────────────────────────
async function notifyEmail(data) {
  const { GMAIL_EMAIL, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_EMAIL || !GMAIL_APP_PASSWORD) return;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_EMAIL, pass: GMAIL_APP_PASSWORD },
  });

  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#0C1C36">
    <div style="background:#0C1C36;padding:20px 24px">
      <h2 style="color:#B79C62;margin:0">📋 New Client Intake — Tez Law P.C.</h2>
    </div>
    <div style="padding:24px;background:#f9f9f9">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:10px;font-weight:bold;width:130px">Name</td><td style="padding:10px">${data.name || "Not provided"}</td></tr>
        <tr style="background:#fff"><td style="padding:10px;font-weight:bold">Case Type</td><td style="padding:10px">${data.caseType}</td></tr>
        <tr><td style="padding:10px;font-weight:bold">Issue</td><td style="padding:10px">${data.issue}</td></tr>
        <tr style="background:#fff"><td style="padding:10px;font-weight:bold">Contact</td><td style="padding:10px">${data.contact}</td></tr>
        <tr><td style="padding:10px;font-weight:bold">Platform</td><td style="padding:10px">${data.platform}</td></tr>
        <tr style="background:#fff"><td style="padding:10px;font-weight:bold">Time</td><td style="padding:10px">${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT</td></tr>
      </table>
    </div>
    <div style="background:#0C1C36;padding:14px 24px;text-align:center">
      <p style="color:#B79C62;margin:0;font-size:12px">TEZ Law P.C. &nbsp;·&nbsp; Zara Intake System &nbsp;·&nbsp; 626-678-8677</p>
    </div>
  </div>`;

  await transporter.sendMail({
    from: `"Zara Intake" <${GMAIL_EMAIL}>`,
    to: "jj@tezlawfirm.com",
    subject: `📋 New Intake: ${data.caseType} — ${data.name || "New Client"} (${data.platform})`,
    html,
  });
}

// ── Save to DB ────────────────────────────────────────────
async function saveIntakeToDB(platform, platformId, data) {
  try {
    await getPool().query(
      `INSERT INTO intakes (platform, platform_id, name, issue, contact, case_type)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [platform, platformId, data.name, data.issue, data.contact, data.caseType]
    );
    // Sync all collected info to the clients table for memory persistence
    const updates = {};
    if (data.name) updates.name = data.name;
    if (data.caseType) updates.case_type = data.caseType;
    if (data.contact) {
      if (data.contact.includes("@")) updates.email = data.contact;
      else updates.phone = data.contact;
    }
    if (Object.keys(updates).length > 0) {
      await getPool().query(
        `UPDATE clients SET ${Object.keys(updates).map((k,i) => `${k}=$${i+3}`).join(", ")} WHERE platform=$1 AND platform_id=$2`,
        [platform, platformId, ...Object.values(updates)]
      );
    }
  } catch (err) {
    console.error("saveIntakeToDB error:", err.message);
  }
}

// ── Main intake handler ───────────────────────────────────
// Returns: { handled: true, reply: string } if intake intercepted the message
//          { handled: false } if intake is done or not applicable
async function checkIntake(platform, userId, userText) {
  const state = await getIntakeState(platform, userId);

  // ── STATE: awaiting_name ──────────────────────────────
  if (state?.step === "awaiting_name") {
    const name = userText.trim();
    // Store name and advance
    await setIntakeState(platform, userId, {
      step: "awaiting_issue",
      name,
      caseType: state.caseType,
      originalMessage: state.originalMessage,
    });
    return {
      handled: true,
      reply: `Nice to meet you, ${name.split(" ")[0]}! 😊 Can you tell me a bit more about what's going on? The more detail you share, the better I can help.`,
    };
  }

  // ── STATE: awaiting_issue ─────────────────────────────
  if (state?.step === "awaiting_issue") {
    const issue = userText.trim();
    await setIntakeState(platform, userId, {
      step: "awaiting_contact",
      name: state.name,
      caseType: state.caseType,
      issue,
      originalMessage: state.originalMessage,
    });
    return {
      handled: true,
      reply: `Got it, I've noted that. What's the best way for our team to reach you — phone number or email?`,
    };
  }

  // ── STATE: awaiting_contact ───────────────────────────
  if (state?.step === "awaiting_contact") {
    const contact = userText.trim();
    const intakeData = {
      name: state.name,
      caseType: state.caseType,
      issue: state.issue,
      contact,
      platform,
    };

    // Save + notify + create lead + conflict check (non-blocking)
    Promise.allSettled([
      saveIntakeToDB(platform, userId, intakeData),
      notifyTelegram(intakeData),
      notifyEmail(intakeData),
    ]).then(async (results) => {
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`Intake step ${i} failed:`, r.reason?.message);
        }
      });
      // Wave 1: auto-create lead + run conflict check after intake saves
      try {
        const db = require("./db");
        const lead = await db.createLead({
          platform, platformId: userId,
          name: intakeData.name,
          contact: intakeData.contact,
          caseType: intakeData.caseType,
        });
        if (lead && intakeData.name) {
          const conflict = await db.runConflictCheck(
            lead.id, platform, userId, intakeData.name
          );
          if (conflict?.disposition === "possible") {
            // Notify JJ of potential conflict
            const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID } = process.env;
            if (TELEGRAM_TOKEN && JJ_TELEGRAM_ID) {
              await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: JJ_TELEGRAM_ID,
                text: `⚠️ CONFLICT CHECK — Possible match!\n\nNew client: ${intakeData.name}\nCase: ${intakeData.caseType}\n\n${conflict.matches.length} existing record(s) found with similar name.\n\nReview in Admin Panel → Conflicts tab before assigning.`,
              }).catch(() => {});
            }
          }
        }
      } catch (e) {
        console.error("Lead/conflict post-intake error:", e.message);
      }
    });

    // Mark intake as done
    await clearIntakeState(platform, userId);

    return {
      handled: true,
      reply: `Perfect — I've passed your info to the team and someone will follow up with you shortly. In the meantime, feel free to keep asking me anything! 😊`,
    };
  }

  // ── NO ACTIVE INTAKE STATE ────────────────────────────
  // Check if this message triggers a new intake
  if (!state && isLegalIntent(userText)) {
    const caseType = detectCaseType(userText);
    await setIntakeState(platform, userId, {
      step: "awaiting_name",
      caseType,
      originalMessage: userText,
    });
    return {
      handled: true,
      reply: `I can definitely help with that! First, may I get your name?`,
    };
  }

  // Not a legal matter — let normal conversation handle it
  return { handled: false };
}

module.exports = { checkIntake, initIntakeTable };
