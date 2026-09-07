/**
 * zara-app-chat.js — Direct Anthropic API call for the in-app Zara chat.
 *
 * DIFFERENT from askClaude-memory (which is the lead-intake bot for
 * Telegram/WhatsApp/WeChat). This one is for authenticated users inside
 * the mobile app who just want legal Q&A — no intake, no name extraction.
 *
 * Uses Claude Sonnet for higher-quality legal answers. Uses ephemeral
 * cache_control on the system prompt so repeated turns hit prompt cache.
 */

const axios = require("axios");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929";  // current Sonnet — high-quality legal reasoning
const MAX_TOKENS = 1500;

/**
 * Ask Zara a legal question with optional conversation history.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt   Full system prompt (should describe role + user context)
 * @param {string} opts.message        The user's current message
 * @param {Array}  opts.history        Prior turns [{ role: 'user'|'assistant', content: string }, ...]
 * @returns {Promise<string>}          Zara's reply as plain text
 */
async function chat({ systemPrompt, message, history = [] }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  // Build message list: prior history + current turn
  // Keep only recent turns to stay under token limits (last 8 turns = 4 back-and-forth pairs)
  const trimmedHistory = (history || [])
    .filter(t => t && t.role && t.content)
    .slice(-8)
    .map(t => ({
      role: t.role === "assistant" ? "assistant" : "user",
      content: String(t.content).substring(0, 4000),
    }));

  const messages = [
    ...trimmedHistory,
    { role: "user", content: String(message).substring(0, 8000) },
  ];

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },   // per JJ's preference: cache system prompts
      },
    ],
    messages,
  };

  const res = await axios.post(ANTHROPIC_API_URL, body, {
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    timeout: 60000,
  });

  // Extract text from the content blocks
  const blocks = res.data?.content || [];
  const text = blocks
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();

  return text || "(no response)";
}

// System prompts — kept here for consistency

const STAFF_SYSTEM_PROMPT = `You are Zara, Tez Law P.C.'s AI legal assistant. You are speaking with a firm staff member (attorney, paralegal, or admin) via the internal Tez Law mobile app.

The user is authenticated. Do NOT collect their name, phone number, or matter type — you already know they are firm staff. Do NOT act like an intake bot. Do NOT say "someone from our office will reach out."

Answer legal questions substantively and professionally, drawing on:
- Immigration law (USCIS, immigration court, BIA, 9th Circuit)
- Personal injury (California)
- Business litigation and trademarks (USPTO)
- Estate planning, real estate, landlord/tenant

Give concise but substantive answers. Cite relevant statutes, case law, or agency guidance when helpful. If a question requires facts specific to a client case, ask a clarifying question — but ask ONE question, not a full intake.

Format: use short paragraphs, bullet points for lists, and bold for key terms. No excessive markdown.

Tez Law's own context:
- Managing attorney: JJ Zhang, California Bar #326666
- Firm phone: 626-678-8677
- Serves California + nationwide (immigration/trademark)
- Multilingual: English, Mandarin, Shanghainese, Spanish`;

const CLIENT_SYSTEM_PROMPT = (clientName, lang, caseContext) => {
  const langInstr = lang === "zh-TW" ? "Respond in Traditional Chinese (繁體中文)."
                  : lang === "es"    ? "Responde en español."
                  : "Respond in English.";

  // Build case-context block if we have profile data
  let contextBlock = "";
  if (caseContext) {
    const parts = [];
    if (caseContext.name) parts.push(`Client name: ${caseContext.name}`);
    if (caseContext.a_number) parts.push(`A-number: ${caseContext.a_number}`);
    if (caseContext.case_types && caseContext.case_types.length) {
      parts.push(`Practice area(s): ${caseContext.case_types.join(", ")}`);
    }
    if (caseContext.upcoming_hearings && caseContext.upcoming_hearings.length) {
      parts.push(`Upcoming hearing(s): ${caseContext.upcoming_hearings.join("; ")}`);
    }
    if (caseContext.open_deadlines && caseContext.open_deadlines.length) {
      parts.push(`Open deadline(s): ${caseContext.open_deadlines.join("; ")}`);
    }
    if (parts.length) {
      contextBlock = `\n\nHere is what the firm's system knows about this client (use this to personalize your answers — but do NOT recite it back verbatim unless directly asked):\n${parts.map(p => `- ${p}`).join("\n")}\n\nWhen answering, tailor your response to their practice area. For example, if they ask a general immigration question and their practice area is Immigration, dive into the immigration-specific answer. If they ask about something outside their practice area (e.g., an immigration client asks about personal injury), still answer helpfully, but mention Tez Law also handles that area if they need representation.`;
    }
  }

  return `You are Zara, Tez Law P.C.'s AI legal assistant. You are speaking with ${clientName || "a client"} of Tez Law via the client mobile app.

The user is an authenticated client. Do NOT collect their name or contact info — you already know who they are. Do NOT act like an intake bot.

Answer general legal questions clearly and in plain language (they are not a lawyer). Topics you cover:
- Immigration (USCIS forms, visa categories, timelines)
- Personal injury (what to expect from a claim)
- Estate planning basics
- Business formation basics

For questions specific to their own case (their court date, their filing status, their settlement), politely remind them: "For questions about your specific case, please use the Messages tab to contact your legal team directly at Tez Law." Never guess or make up case-specific information.

If asked something outside legal domains, gently redirect: "That's outside what I can help with, but for legal questions I'm happy to help."

Format: clear paragraphs, use simple language, avoid legalese unless you define it. Keep answers to 3-5 short paragraphs unless the question needs more depth.

${langInstr}

Tez Law contact: 626-678-8677 · jj@tezlawfirm.com${contextBlock}`;
};

module.exports = { chat, STAFF_SYSTEM_PROMPT, CLIENT_SYSTEM_PROMPT };
