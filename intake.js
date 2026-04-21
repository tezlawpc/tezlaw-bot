// ============================================================
//  intake.js — Structured Intake Flow for Zara
//  Tez Law P.C.
// ============================================================

const axios      = require("axios");
const nodemailer = require("nodemailer");
const { Pool }   = require("pg");

// ── DB pool ───────────────────────────────────────────────
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
function isLegalIntent(text) {
  const t = text.toLowerCase();

  // ── Skip intake for professional/procedural questions ──
  // These come from lawyers, existing clients, or staff — not new client intakes
  const isDistress = /ice|detained|arrested|deportation|court tomorrow|emergency|urgent|help me|scared/i.test(t);
  if (!isDistress) {
    const professionalPatterns = [
      /does the attorney/i,
      /does (?:the|my|your) lawyer/i,
      /do (?:we|you|i) need to file/i,
      /(?:file|filing|amend|amending|g-28|g28|i-765|i-131|i-485|i-130|n-400|i-90)\s+(?:for|to|with|again|another)/i,
      /^(?:hi\s+)?(?:does|do|is|are|can|should|will|would|what|when|how|why)\s/i,
      /\b(?:case status|receipt number|case number|a-number|uscis case)\b/i,
      /(?:already filed|previously filed|we filed|you filed)/i,
      /(?:amending|amendment|correcting|correction) (?:the|a|an)/i,
      /(?:processing time|how long|timeline|status update)/i,
    ];
    for (const pat of professionalPatterns) {
      if (pat.test(text)) return false;
    }
  }

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
    "abogado","accidente","demanda","herencia","contrato","ayuda legal",
    // Chinese
    "律师","签证","绿卡","移民","事故","遗嘱","合同","诉讼","法律"
  ];

  return legalKeywords.some(k => t.includes(k));
}

// ── Detect case type ──────────────────────────────────────
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
async function checkIntake(platform, userId, userText) {
  const state = await getIntakeState(platform, userId);

  // ── STATE: awaiting_name ──────────────────────────────
  if (state?.step === "awaiting_name") {
    const name = userText.trim();
    // Validate: reject questions, very short inputs, non-names
    const looksLikeQuestion = /^(?:what|how|when|why|where|who|does|do|is|are|can|will|would|could|should|i |my |the |a )/i.test(name);
    const tooShort = name.length < 2;
    const tooLong = name.split(" ").length > 6;
    const hasQuestionMark = name.includes("?");
    if (looksLikeQuestion || tooShort || tooLong || hasQuestionMark) {
      return {
        handled: true,
        reply: `I just need your name to get started — something like "John Smith". What's your name?`,
      };
    }
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
    // Validate: must look like a phone number or email
    const looksLikePhone = /[\d]{7,}/.test(contact.replace(/[\s\-\(\)\+]/g, ""));
    const looksLikeEmail = /\S+@\S+\.\S+/.test(contact);
    const looksLikeQuestion = /^(?:what|how|when|why|where|who|does|do|is|are|can|will|would|could|should)/i.test(contact) || contact.includes("?");
    if ((!looksLikePhone && !looksLikeEmail) || looksLikeQuestion) {
      return {
        handled: true,
        reply: `I need a phone number or email so our team can reach you. For example: "626-555-1234" or "yourname@email.com". What's the best way to contact you?`,
      };
    }
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
      // Only create lead if we have both name AND contact
      try {
        const db = require("./db");
        const { startDripCampaign } = require("./drip");
        if (!intakeData.name || !intakeData.contact) {
          console.log("[intake] Skipping lead creation — missing name or contact");
          return;
        }
        const lead = await db.createLead({
          platform, platformId: userId,
          name: intakeData.name,
          contact: intakeData.contact,
          caseType: intakeData.caseType,
        });
        if (lead) {
          // Start drip campaign
          startDripCampaign(lead.id, platform, userId, intakeData.caseType).catch(() => {});
          // Run conflict check
          const conflict = await db.runConflictCheck(
            lead.id, platform, userId, intakeData.name
          );
          if (conflict?.disposition === "possible") {
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

    await clearIntakeState(platform, userId);

    return {
      handled: true,
      reply: `Perfect — I've passed your info to the team and someone will follow up with you shortly. In the meantime, feel free to keep asking me anything! 😊`,
    };
  }

  // ── NO ACTIVE INTAKE STATE ────────────────────────────
  // Only trigger intake if:
  // 1. Has legal intent (not a professional/procedural question)
  // 2. NOT a pure question starting with question words
  // 3. At least 5 words (avoids single keyword triggers)
  const wordCount = userText.trim().split(/\s+/).length;
  const isPureQuestion = /^(?:does|do|is|are|can|should|will|would|what|when|how|why|where|who|which|could|may|might)\b/i.test(userText.trim());
  if (!state && isLegalIntent(userText) && !isPureQuestion && wordCount >= 5) {
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
