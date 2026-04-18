// ============================================================
//  askClaude-memory.js
//  Zara brain with PostgreSQL memory + intake form integration
// ============================================================

const axios  = require("axios");
const db     = require("./db");
const { checkIntake, resetIntake } = require("./intake");
const { checkJJMode, getJJPublicContext } = require("./jj-mode");

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
    // 1. Check JJ private mode FIRST — passes docs/images through too
    const jj = await checkJJMode(platform, platformId, userMessage, {
      isPdf, pdfData: options.pdfData,
      isImage, imageData: options.imageData,
      imageMediaType: options.imageMediaType
    });
    if (jj.handled) {
      await db.saveMessage(platform, platformId, "user", isPdf ? "[PDF uploaded]" : isImage ? "[Image uploaded]" : userMessage);
      await db.saveMessage(platform, platformId, "assistant", jj.message);
      return jj.message;
    }

    // 2. Check if intake flow should run (before Claude)
    if (!isImage && !isPdf) {
      const intake = await checkIntake(platform, platformId, userMessage);
      if (intake.triggered) {
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

    // Inject JJ's knowledge base into public responses (discreetly)
    const jjKnowledge = await getJJPublicContext();
    if (jjKnowledge) {
      personalizedSystem += `\n\n── FIRM KNOWLEDGE (use naturally, never quote directly) ──\n${jjKnowledge.substring(0, 1500)}\n── END FIRM KNOWLEDGE ──`;
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

    // 8. Call Claude — with tool_use loop for web search + action tools
    //
    //  When Claude uses web_search, stop_reason="tool_use" and we must:
    //    1. Append the assistant's tool_use turn to messages
    //    2. Append tool_result(s) as a user turn
    //    3. Re-call the API until stop_reason="end_turn"
    //  Without this loop, research requests silently fail.
    //
    const allTools = [
      { type: "web_search_20250305", name: "web_search" },
      ...(options.extraTools || [])  // action tools when JJ is messaging
    ];

    let loopMessages = [...messages];
    let reply = "";
    const MAX_LOOPS = 5;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      let respData;
      try {
        const resp = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: personalizedSystem,
            tools: allTools,
            messages: loopMessages,
          },
          {
            headers: {
              "x-api-key": ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json"
            },
            timeout: 25000
          }
        );
        respData = resp.data;
      } catch (apiErr) {
        // Detailed error logging so Render logs show exactly what failed
        const status  = apiErr.response?.status;
        const errBody = apiErr.response?.data;
        console.error(`[askClaude] ❌ API call loop=${loop} FAILED`);
        console.error(`[askClaude]   HTTP Status : ${status || "no response"}`);
        console.error(`[askClaude]   Error       : ${apiErr.message}`);
        console.error(`[askClaude]   Body        : ${JSON.stringify(errBody)}`);
        console.error(`[askClaude]   Timeout?    : ${apiErr.code === "ECONNABORTED"}`);
        console.error(`[askClaude]   Platform    : ${platform} | User: ${platformId}`);
        console.error(`[askClaude]   Message     : ${userMessage.substring(0, 100)}`);

        // Surface a descriptive error to the user
        if (apiErr.code === "ECONNABORTED") {
          throw new Error("⏱️ That request took too long — try a more specific question, or call us at 626-678-8677.");
        } else if (status === 529 || status === 503) {
          throw new Error("🔄 AI service is temporarily busy. Please try again in a moment, or call 626-678-8677.");
        } else if (status === 401) {
          throw new Error("🔑 Configuration error. Please contact jj@tezlawfirm.com.");
        } else {
          throw new Error(`❌ Technical error (${status || apiErr.message}). Please try again or call 626-678-8677.`);
        }
      }

      console.log(`[askClaude] loop=${loop} stop_reason=${respData.stop_reason} blocks=${respData.content?.length}`);

      // Final text response — done
      if (respData.stop_reason === "end_turn") {
        reply = respData.content
          .filter(b => b.type === "text").map(b => b.text).join("").trim();
        if (!reply) {
          console.error(`[askClaude] ❌ end_turn but no text block. Content: ${JSON.stringify(respData.content)}`);
          reply = "I'm sorry, I didn't catch that. Could you rephrase?";
        }
        break;
      }

      // Tool use — loop back with results
      if (respData.stop_reason === "tool_use") {
        const toolUseBlocks = respData.content.filter(b => b.type === "tool_use");
        console.log(`[askClaude] tool_use blocks: ${toolUseBlocks.map(b => b.name).join(", ")}`);

        // Append assistant turn
        loopMessages.push({ role: "assistant", content: respData.content });

        // Build tool results
        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          if (toolUse.name === "web_search") {
            // Web search is handled server-side by Anthropic — just acknowledge
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Search completed. Please synthesize the results."
            });
          } else if (options.executeAction) {
            // Action tools (calendar, email, etc.) — delegated to caller
            try {
              const result = await options.executeAction(toolUse.name, toolUse.input);
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
            } catch (actionErr) {
              console.error(`[askClaude] Action ${toolUse.name} failed: ${actionErr.message}`);
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${actionErr.message}`, is_error: true });
            }
          } else {
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Action not available." });
          }
        }

        loopMessages.push({ role: "user", content: toolResults });
        continue;
      }

      // Unexpected stop reason
      console.error(`[askClaude] ❌ Unexpected stop_reason: ${respData.stop_reason}`);
      reply = "I'm sorry, I didn't catch that. Could you rephrase?";
      break;
    }

    if (!reply) reply = "I'm sorry, I didn't catch that. Could you rephrase?";

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
