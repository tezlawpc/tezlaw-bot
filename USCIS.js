// ============================================================
//  uscis.js — USCIS Case Status API Integration
//  OAuth 2.0 Client Credentials + GET /{receiptNumber}
//  Sandbox:    https://api-int.uscis.gov/case-status
//  Production: https://api.uscis.gov/case-status
//
//  Response schema verified against USCIS developer portal docs.
//  Supports standard receipts (EAC/LIN/SRC/WAC/NBC/MSC/SRC)
//  and IOE-prefix receipts (different schema — no submittedDate/modifiedDate).
// ============================================================

const axios = require("axios");

// ── Environment toggle ────────────────────────────────────
const IS_PRODUCTION = process.env.USCIS_PRODUCTION === "true";

const BASE_URL  = IS_PRODUCTION
  ? "https://api.uscis.gov/case-status"
  : "https://api-int.uscis.gov/case-status";

const TOKEN_URL = IS_PRODUCTION
  ? "https://api.uscis.gov/oauth/accesstoken"
  : "https://api-int.uscis.gov/oauth/accesstoken";

// Sandbox limits: 5 TPS, 1,000/day, M-F 7AM-8PM EST only
// Production limits: 10 TPS, 400,000/day
const SANDBOX_NOTE = "The USCIS sandbox is available Monday through Friday, 7 AM to 8 PM Eastern Time.";

// ── Token cache (reuse until expiry) ─────────────────────
let cachedToken    = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const clientId     = process.env.USCIS_CLIENT_ID;
  const clientSecret = process.env.USCIS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("USCIS_CLIENT_ID and USCIS_CLIENT_SECRET env vars are required");
  }

  console.log("[uscis] Requesting new OAuth access token...");

  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     clientId,
      client_secret: clientSecret,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      validateStatus: (s) => s < 500,
    }
  );

  if (res.status !== 200) {
    throw new Error(`USCIS token error ${res.status}: ${JSON.stringify(res.data)}`);
  }

  const { access_token, expires_in } = res.data;
  cachedToken    = access_token;
  tokenExpiresAt = now + (expires_in || 3600) * 1000;

  console.log(`[uscis] Access token obtained (expires in ${expires_in}s)`);
  return cachedToken;
}

// ── Receipt number validation ─────────────────────────────
// USCIS supports two formats per official docs:
//   Standard: [a-zA-Z]{3}[0-9]{10}      e.g. EAC9999103403
//   IOE:      [a-zA-Z]{3}\*[0-9]{9}     e.g. IOE*123456789
function isValidReceiptNumber(receipt) {
  const clean = receipt.replace(/[-\s]/g, "");
  return /^[a-zA-Z]{3}[0-9]{10}$/i.test(clean) ||
         /^[a-zA-Z]{3}\*[0-9]{9}$/i.test(clean);
}

function normalizeReceiptNumber(receipt) {
  // Remove dashes and spaces, uppercase — USCIS requires no dashes
  return receipt.replace(/[-\s]/g, "").toUpperCase();
}

function isIOEPrefix(receiptNumber) {
  return receiptNumber.toUpperCase().startsWith("IOE");
}

// ── Main: Get case status ─────────────────────────────────
async function getCaseStatus(receiptNumber) {
  const normalized = normalizeReceiptNumber(receiptNumber);

  if (!isValidReceiptNumber(normalized)) {
    return {
      success: false,
      error:   "invalid_receipt",
      message: "That doesn't look like a valid receipt number. USCIS receipt numbers are 13 characters — 3 letters followed by 10 digits, like EAC2190123456. Please double-check and try again.",
    };
  }

  try {
    const token = await getAccessToken();
    console.log(`[uscis] Fetching case status for ${normalized}...`);

    const res = await axios.get(`${BASE_URL}/${normalized}`, {
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true, // handle all codes manually
    });

    // ── 200 Success ──────────────────────────────────────
    if (res.status === 200) {
      const cs = res.data?.case_status;

      if (!cs) {
        return {
          success: false,
          error:   "parse_error",
          message: "USCIS returned an unexpected response format. Please try again.",
        };
      }

      // Core fields
      const receiptNum    = cs.receiptNumber   || normalized;
      const formType      = cs.formType        || "";
      const submittedDate = cs.submittedDate   || null; // absent for IOE prefix
      const modifiedDate  = cs.modifiedDate    || null; // absent for IOE prefix

      // Current status — USCIS provides English AND Spanish natively
      const statusTextEn  = cs.current_case_status_text_en || "";
      const statusDescEn  = cs.current_case_status_desc_en || "";
      const statusTextEs  = cs.current_case_status_text_es || "";
      const statusDescEs  = cs.current_case_status_desc_es || "";

      // Case history — only present for certain receipt numbers
      const historyRaw = cs.hist_case_status || [];
      const history = historyRaw.slice(0, 5).map(h => ({
        date:   h.date              || "",
        textEn: h.completed_text_en || "",
        textEs: h.completed_text_es || "",
      }));

      return {
        success:       true,
        receiptNumber: receiptNum,
        formType,
        submittedDate,
        modifiedDate,
        statusTextEn,
        statusDescEn,
        statusTextEs,
        statusDescEs,
        history,
        isIOE:         isIOEPrefix(normalized),
        raw:           res.data,
      };
    }

    // ── 401 Unauthorized ─────────────────────────────────
    if (res.status === 401) {
      cachedToken    = null;
      tokenExpiresAt = 0;
      console.error("[uscis] 401 Unauthorized — clearing token cache");
      return {
        success: false,
        error:   "auth_error",
        message: "There was an authentication issue with the USCIS system. Please try again in a moment.",
      };
    }

    // ── 404 Not Found ─────────────────────────────────────
    // Also returned for 8 U.S.C. 1367 protected individuals
    if (res.status === 404) {
      return {
        success: false,
        error:   "not_found",
        message: `Receipt number ${normalized} was not found in the USCIS system. Please verify the number on your Notice of Action (Form I-797). If you need further assistance, call USCIS at 1-800-375-5283.`,
      };
    }

    // ── 422 Unprocessable Entity ──────────────────────────
    // Receipt number format is wrong or prefix is invalid
    if (res.status === 422) {
      return {
        success: false,
        error:   "invalid_format",
        message: "The receipt number format is not valid — it must be 13 characters, 3 letters followed by 10 digits. Please check your Notice of Action (Form I-797) and try again.",
      };
    }

    // ── 429 Too Many Requests ─────────────────────────────
    // Sandbox: 5 TPS, 1,000/day | Production: 10 TPS, 400,000/day
    if (res.status === 429) {
      console.warn("[uscis] 429 Rate limit hit (Spike Arrest Violation)");
      return {
        success: false,
        error:   "rate_limit",
        message: "The USCIS lookup service is temporarily busy. Please try again in a few seconds.",
      };
    }

    // ── 503 Service Unavailable ───────────────────────────
    // Sandbox only available M-F 7AM–8PM EST
    if (res.status === 503) {
      return {
        success: false,
        error:   "service_unavailable",
        message: IS_PRODUCTION
          ? "The USCIS system is temporarily unavailable. Please try again shortly or visit uscis.gov."
          : `The USCIS system is currently offline. ${SANDBOX_NOTE}`,
      };
    }

    // ── Catch-all ─────────────────────────────────────────
    console.error(`[uscis] Unexpected status ${res.status}:`, res.data);
    return {
      success: false,
      error:   "api_error",
      message: `USCIS returned an unexpected response (${res.status}). Please try again or visit uscis.gov directly.`,
    };

  } catch (err) {
    console.error("[uscis] getCaseStatus error:", err.message);
    return {
      success: false,
      error:   "network_error",
      message: "Unable to reach the USCIS system right now. Please try again in a few minutes or visit uscis.gov to check your case status.",
    };
  }
}

// ── Format result for bot message ────────────────────────
// lang: "en" | "zh" | "es"
function formatCaseStatusMessage(result, lang = "en") {
  if (!result.success) {
    return result.message;
  }

  if (lang === "zh") {
    const lines = [];
    lines.push(`📋 *案件编号:* ${result.receiptNumber}`);
    if (result.formType)      lines.push(`📄 *申请表格:* ${result.formType}`);
    lines.push(`📌 *当前状态:* ${result.statusTextEn}`);
    if (result.statusDescEn)  lines.push(`\n${result.statusDescEn}`);
    if (result.submittedDate) lines.push(`\n📅 *提交日期:* ${result.submittedDate}`);
    if (result.modifiedDate)  lines.push(`🔄 *最后更新:* ${result.modifiedDate}`);
    if (result.history.length > 0) {
      lines.push(`\n📜 *案件历史:*`);
      result.history.forEach(h => lines.push(`• ${h.date} — ${h.textEn}`));
    }
    lines.push(`\n_如有疑问，请联系 Tez Law 律师事务所：626-678-8677_`);
    return lines.join("\n");
  }

  if (lang === "es") {
    // Use USCIS's own Spanish translations
    const lines = [];
    lines.push(`📋 *Número de recibo:* ${result.receiptNumber}`);
    if (result.formType)      lines.push(`📄 *Formulario:* ${result.formType}`);
    lines.push(`📌 *Estado actual:* ${result.statusTextEs || result.statusTextEn}`);
    const descEs = result.statusDescEs || result.statusDescEn;
    if (descEs)               lines.push(`\n${descEs}`);
    if (result.submittedDate) lines.push(`\n📅 *Fecha de envío:* ${result.submittedDate}`);
    if (result.modifiedDate)  lines.push(`🔄 *Última actualización:* ${result.modifiedDate}`);
    if (result.history.length > 0) {
      lines.push(`\n📜 *Historial del caso:*`);
      result.history.forEach(h => lines.push(`• ${h.date} — ${h.textEs || h.textEn}`));
    }
    lines.push(`\n_Para preguntas, contacte a Tez Law P.C.: 626-678-8677_`);
    return lines.join("\n");
  }

  // Default: English
  const lines = [];
  lines.push(`📋 *Receipt Number:* ${result.receiptNumber}`);
  if (result.formType)      lines.push(`📄 *Form Type:* ${result.formType}`);
  lines.push(`📌 *Current Status:* ${result.statusTextEn}`);
  if (result.statusDescEn)  lines.push(`\n${result.statusDescEn}`);
  if (result.submittedDate) lines.push(`\n📅 *Submitted:* ${result.submittedDate}`);
  if (result.modifiedDate)  lines.push(`🔄 *Last Updated:* ${result.modifiedDate}`);
  if (result.history.length > 0) {
    lines.push(`\n📜 *Case History:*`);
    result.history.forEach(h => lines.push(`• ${h.date} — ${h.textEn}`));
  }
  lines.push(`\n_For questions about your case, contact Tez Law P.C. at 626-678-8677._`);
  return lines.join("\n");
}

// ── Receipt number extractor (for bot message parsing) ───
// Handles natural messages like:
//   "check my case EAC2190123456"
//   "my receipt number is EAC 219 012 3456"
//   "IOE*123456789"
function extractReceiptNumber(text) {
  const match = text.match(
    /\b([A-Z]{3}[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{4}|[A-Z]{3}\d{10}|[A-Z]{3}\*\d{9})\b/i
  );
  if (!match) return null;
  return normalizeReceiptNumber(match[1]);
}

module.exports = {
  getCaseStatus,
  formatCaseStatusMessage,
  extractReceiptNumber,
  isValidReceiptNumber,
  normalizeReceiptNumber,
  isIOEPrefix,
};
