// ============================================================
//  askClaude-memory.js
//  Zara brain with PostgreSQL memory + intake form integration
// ============================================================

const axios  = require("axios");
const db     = require("./db");
const { checkIntake, resetIntake } = require("./intake");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function detectLanguage(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/\b(hola|gracias|por favor|cómo|dónde|necesito|tengo|quiero|ayuda|abogado)\b/i.test(text)) return "es";
  return "en";
}

function detectCaseType(text) {
  const t = text.toLowerCase();
  if (/immigra|visa|green card|citizenship|deporta|asylum|daca|work permit|i-130|i-485|i-765/.test(t)) return "immigration";
  if (/accident|crash|injury|hurt|hospital|medical|pain|car crash|slip|fall/.test(t)) return "personal_injury";
  if (/business|contract|lawsuit|sue|litigation|employment/.test(t)) return "business";
  if (/patent|trademark|copyright|ip|intellectual/.test(t)) return "ip";
  if (/trust|will|estate|probate|inheritance|power of attorney/.test(t)) return "estate";
  return null;
}

async function askClaudeWithMemory(platform, platformId, userMessage, systemPrompt, options = {}) {
  const {
    isImage = false, imageData = null, imageMediaType = null,
    isPdf = false, pdfData = null, isVoiceTranscript = false,
  } = options;

  try {
    // 1. Check if intake flow should run FIRST (before Claude)
    if (!isImage && !isPdf) {
      const intake = await checkIntake(platform, platformId, userMessage);
      if (intake.triggered) {
        // Save messages to history so context is preserved
        await db.saveMessage(platform, platformId, "user", userMessage);
        await db.saveMessage(platform, platformId, "assistant", intake.message);
        return intake.message;
      }
    }

    // 2. Ensure client exists, detect language
    const lang = detectLanguage(userMessage);
    await db.getOrCreateClient(platform, platformId, lang);

    // 3. Detect and save case type
    const caseType = detectCaseType(userMessage);
    if (caseType) await db.updateClient(platform, platformId, { case_type: caseType });

    // 4. Save incoming message
    const savedContent = isImage ? "[Image sent]"
      : isPdf ? "[PDF document sent]"
      : isVoiceTranscript ? `[Voice message]: ${userMessage}`
      : userMessage;
    await db.saveMessage(platform, platformId, "user", savedContent);

    // 5. Load client context
    const { client, summary, history } = await db.getClientContext(platform, platformId);

    // 6. Build personalized system prompt
    let personalizedSystem = systemPrompt;
    if (client) {
      let ctx = "\n\n── CLIENT MEMORY ──";
      if (client.name) ctx += `\nClient name: ${client.name}`;
      if (client.preferred_language && client.preferred_language !== "en")
        ctx += `\nPreferred language: ${client.preferred_language} — respond in this language`;
      if (client.case_type) ctx += `\nCase type: ${client.case_type}`;
      if (client.first_seen) {
        const isReturning = (Date.now() - new Date(client.first_seen)) > 60 * 60 * 1000;
        if (isReturning) ctx += `\nReturning client (first contact: ${new Date(client.first_seen).toLocaleDateString()})`;
      }
      if (summary) ctx += `\n\nConversation summary:\n${summary}`;
      ctx += "\n── END MEMORY ──";
      personalizedSystem += ctx;
    }

    // 7. Build messages array
    const messages = [];
    for (const msg of history.slice(-8)) {
      if (isImage && msg.role === "user" && msg.content === "[Image sent]") continue;
      messages.push({ role: msg.role, content: msg.content });
    }

    if (isImage && imageData) {
      messages.push({ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageData } },
        { type: "text", text: userMessage || "Analyze this image. Respond in the same language as any text in the image." }
      ]});
    } else if (isPdf && pdfData) {
      messages.push({ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfData } },
        { type: "text", text: userMessage || "Analyze this legal document and explain what it means in plain language." }
      ]});
    } else {
      messages.push({ role: "user", content: userMessage });
    }

    // 8. Call Claude
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: personalizedSystem,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages,
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "anthropic-beta": "interleaved-thinking-2025-05-14"
        }
      }
    );

    const reply = resp.data.content
      .filter(b => b.type === "text").map(b => b.text).join("").trim()
      || "I'm sorry, I didn't catch that. Could you rephrase?";

    // 9. Save reply + auto-summarize
    await db.saveMessage(platform, platformId, "assistant", reply);
    if (!client?.name) tryExtractName(platform, platformId, userMessage);
    db.maybeAutoSummarize(platform, platformId, ANTHROPIC_API_KEY).catch(() => {});

    return reply;
  } catch (err) {
    console.error("askClaudeWithMemory error:", err.response?.data || err.message);
    return "I'm having a technical issue. Please contact us directly:\n📞 626-678-8677\n📧 jj@tezlawfirm.com";
  }
}

function tryExtractName(platform, platformId, text) {
  const match = text.match(/(?:my name is|i'm|i am|this is)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i);
  if (match) db.updateClient(platform, platformId, { name: match[1].trim() }).catch(() => {});
}

module.exports = { askClaudeWithMemory };
