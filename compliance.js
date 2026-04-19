// ============================================================
//  compliance.js — Zara Compliance Hook
//  Tez Law P.C.
//
//  Runs AFTER every Zara response is sent to the client.
//  Uses Claude API to detect definitive legal conclusions,
//  unauthorized practice of law, and guarantee language.
//
//  On violation:
//  1. Auto-sends a correction message to the client
//  2. Logs violation to PostgreSQL (compliance_violations table)
//  3. Pings JJ via Telegram
// ============================================================

const axios  = require("axios");
const { Pool } = require("pg");

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

// ── Init compliance table ─────────────────────────────────
async function initComplianceTable() {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS compliance_violations (
        id SERIAL PRIMARY KEY,
        platform VARCHAR(20) NOT NULL,
        platform_id VARCHAR(100) NOT NULL,
        user_message TEXT,
        zara_response TEXT NOT NULL,
        violation_type VARCHAR(100) NOT NULL,
        violation_detail TEXT,
        correction_sent TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_compliance_created
        ON compliance_violations(created_at DESC);
    `);
    console.log("✅ compliance_violations table ready");
  } catch (err) {
    console.error("initComplianceTable error:", err.message);
  }
}

// ── Log violation to DB ───────────────────────────────────
async function logViolation(platform, platformId, userMessage, zaraResponse, violationType, violationDetail, correctionSent) {
  try {
    await getPool().query(
      `INSERT INTO compliance_violations
        (platform, platform_id, user_message, zara_response, violation_type, violation_detail, correction_sent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [platform, platformId, userMessage?.substring(0, 2000), zaraResponse.substring(0, 2000),
       violationType, violationDetail, correctionSent]
    );
  } catch (err) {
    console.error("logViolation error:", err.message);
  }
}

// ── Notify JJ via Telegram ────────────────────────────────
async function notifyComplianceViolation(platform, userId, violationType, zaraResponse, correctionSent) {
  const { TELEGRAM_TOKEN, TEAM_TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_TOKEN || !TEAM_TELEGRAM_CHAT_ID) return;

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TEAM_TELEGRAM_CHAT_ID,
      text: `⚖️ COMPLIANCE FLAG — ${platform.toUpperCase()}

Type: ${violationType}
Client: ${userId}

Zara said:
"${zaraResponse.substring(0, 300)}${zaraResponse.length > 300 ? "..." : ""}"

Correction auto-sent:
"${correctionSent.substring(0, 200)}${correctionSent.length > 200 ? "..." : ""}"

Review in Admin Panel → Compliance Log`,
    });
  } catch (err) {
    console.error("notifyComplianceViolation error:", err.message);
  }
}

// ── Claude-powered violation detector ─────────────────────
// Uses a fast Haiku call to analyze the response.
// Returns: { violation: bool, type: string, detail: string }
async function detectViolation(userMessage, zaraResponse) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { violation: false };

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: `You are a legal ethics compliance checker for a law firm AI assistant named Zara.
Your job is to detect when Zara has made a definitive legal conclusion, guarantee, or unauthorized legal advice.

VIOLATIONS to detect:
1. DEFINITIVE_CONCLUSION — Zara states someone qualifies, will win, is entitled to, or definitely does/doesn't have a legal right or status. Examples: "You qualify for DACA", "You will win your case", "You are eligible for a green card", "You likely qualify", "You should be able to get", "You're probably entitled to".
2. LEGAL_GUARANTEE — Zara promises or guarantees a legal outcome. Examples: "You will get your visa", "This will be approved", "You won't be deported".
3. UPL_RISK — Zara gives specific legal strategy or advice that should only come from a licensed attorney. Examples: "You should file an I-485 before your visa expires", "Don't sign the settlement", "File a TRO immediately".
4. UNAUTHORIZED_DIAGNOSIS — Zara diagnoses the specific legal problem definitively without attorney review. Examples: "This is a breach of contract", "You have a valid VAWA claim".

NOT violations (do not flag):
- General information about how the law works
- Explaining what a visa or form is
- Listing what documents are needed in general
- Acknowledging the situation and referring to an attorney
- Saying "this is something our attorneys can help with"
- Using "may", "might", "it depends", "generally", "in some cases"
- Asking a clarifying question

Respond ONLY with valid JSON, no markdown:
{"violation": true/false, "type": "VIOLATION_TYPE_OR_NONE", "detail": "brief explanation of what was said"}`,
        messages: [{
          role: "user",
          content: `User asked: "${userMessage?.substring(0, 500) || "unknown"}"\n\nZara responded: "${zaraResponse.substring(0, 1000)}"`
        }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 8000,
      }
    );

    const text = resp.data.content[0].text.trim();
    const result = JSON.parse(text);
    return result;
  } catch (err) {
    console.error("detectViolation error:", err.message);
    return { violation: false };
  }
}

// ── Generate correction message ────────────────────────────
function buildCorrectionMessage(violationType) {
  const corrections = {
    DEFINITIVE_CONCLUSION: `Just to clarify — I can share general information, but I'm not able to give a definitive legal opinion on your specific situation. Whether you actually qualify depends on details that our attorneys would need to review. Would you like me to connect you with the right person on our team? 😊`,
    LEGAL_GUARANTEE: `I should clarify — I can't guarantee any legal outcome. Every case is different and results depend on many factors. For an accurate assessment of your situation, I'd recommend speaking with one of our attorneys directly. You can reach us at 626-678-8677. 😊`,
    UPL_RISK: `I want to make sure I'm being helpful the right way — the specific next steps for your situation really should come from a licensed attorney who can review all the details. I'd recommend speaking with our team directly at 626-678-8677 or I can have someone reach out to you. 😊`,
    UNAUTHORIZED_DIAGNOSIS: `I should clarify — I'm not able to give a definitive legal assessment of your situation. That's something our attorneys would need to evaluate properly. Would you like me to connect you with the right person on our team? 😊`,
  };
  return corrections[violationType] || corrections.DEFINITIVE_CONCLUSION;
}

// ── Main compliance check (call after every Zara response) ─
// sendFn: async function that sends a message to the client
// Returns: { flagged: bool }
async function checkCompliance(platform, userId, userMessage, zaraResponse, sendFn) {
  try {
    const result = await detectViolation(userMessage, zaraResponse);

    if (!result.violation) return { flagged: false };

    // Build and send correction
    const correction = buildCorrectionMessage(result.type);

    // Send correction to client (non-blocking relative to original response)
    // Small delay so correction feels like a natural follow-up, not simultaneous
    setTimeout(async () => {
      try {
        await sendFn(correction);
      } catch (err) {
        console.error("compliance correction send error:", err.message);
      }
    }, 1500);

    // Log + notify in parallel (fire and forget)
    Promise.allSettled([
      logViolation(platform, userId, userMessage, zaraResponse, result.type, result.detail, correction),
      notifyComplianceViolation(platform, userId, result.type, zaraResponse, correction),
    ]).catch(() => {});

    console.log(`⚖️ Compliance flag [${result.type}] on ${platform}:${userId}`);
    return { flagged: true, type: result.type, detail: result.detail };

  } catch (err) {
    console.error("checkCompliance error:", err.message);
    return { flagged: false };
  }
}

module.exports = { checkCompliance, initComplianceTable };
