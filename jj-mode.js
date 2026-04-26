// ============================================================
//  jj-mode.js — JJ Zhang Private Mode for Zara
//  Password-protected session with persistent memory
//  that also enriches public responses
// ============================================================

const axios              = require("axios");
const db                 = require("./db");
const { sendVoiceReply } = require("./voice");
const { isParalegalCommand, handleParalegalCommand } = require("./paralegal");
const { isResearchCommand, handleResearchCommand }   = require("./courtlistener");
const { isStatuteCommand, handleStatuteCommand }     = require("./castatutes");
const { isCitationCommand, handleCitationCommand }   = require("./citations");
const { formatJudgeProfileForJJ }                    = require("./judge-scanner");

// ── JJ Session state (per platform:userId) ────────────────
const jjSessions = {};
// State: null | 'awaiting_password' | 'authenticated'

const JJ_PASSWORD = process.env.JJ_PASSWORD || "tezlaw2026jj";

// ── Trigger phrases ───────────────────────────────────────
const JJ_TRIGGERS_KEYWORDS = ["jj", "zhang", "private", "switch",
  "private channel", "private mode", "attorney mode", "jj mode",
  "我是jj", "我是章", "章律师", "切换", "私人", "private chat", "secure mode"];

async function isJJTrigger(message) {
  const lower = message.toLowerCase();

  // Quick keyword pre-check to avoid unnecessary API calls
  const hasKeyword = JJ_TRIGGERS_KEYWORDS.some(k => lower.includes(k));
  if (!hasKeyword) return false;

  // Use Claude Haiku to intelligently detect intent
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{
          role: "user",
          content: `Does this message indicate someone identifying as "JJ Zhang" or requesting to switch to a private/attorney/secure mode? Answer only YES or NO.\n\nMessage: "${message}"`
        }]
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      }
    );
    const answer = resp.data.content[0]?.text?.trim().toUpperCase();
    return answer === "YES";
  } catch(e) {
    // Fallback if API call fails
    return lower.includes("jj zhang") || lower.includes("jj mode") || lower.includes("private channel");
  }
}

async function isJJAuthenticatedAsync(platform, userId) {
  if (jjSessions[`${platform}:${userId}`] === "authenticated") return true;
  try {
    const session = await db.getJJSession(platform, userId);
    if (session) {
      jjSessions[`${platform}:${userId}`] = "authenticated";
      return true;
    }
  } catch(e) {}
  return false;
}

function isJJAuthenticated(platform, userId) {
  return jjSessions[`${platform}:${userId}`] === "authenticated";
}

function isAwaitingPassword(platform, userId) {
  return jjSessions[`${platform}:${userId}`] === "awaiting_password";
}

// ── Main JJ mode handler ──────────────────────────────────
// Returns { handled: true, message } if JJ mode intercepts
// Returns { handled: false } to let normal flow continue
async function checkJJMode(platform, userId, userMessage, options = {}) {
  const key = `${platform}:${userId}`;

  // Already authenticated — handle JJ commands (pass options for docs/images)
  // DB-backed check so auth survives Render redeploys
  if (await isJJAuthenticatedAsync(platform, userId)) {
    return await handleJJSession(platform, userId, userMessage, options);
  }

  // Awaiting password — normalize by removing all spaces/punctuation for flexible input
  if (isAwaitingPassword(platform, userId)) {
    const normalize = (s) => s.toLowerCase().replace(/[\s\-_.,!?]+/g, "");
    if (normalize(userMessage) === normalize(JJ_PASSWORD)) {
      jjSessions[key] = "authenticated";
      // Persist auth to DB so it survives Render redeploys
      try { await db.setJJSession(platform, userId, true); } catch(e) {}
      const memory = await getJJMemorySummary();
      const welcomeMsg = memory
        ? `✅ Welcome back, JJ! You're now in private mode.\n\n📚 Here's what I remember:\n\n${memory}\n\nWhat would you like to work on today?`
        : "✅ Welcome back, JJ! You're in private mode. What would you like to work on today?";
      sendVoiceReply(platform, userId, "Welcome back JJ! You're now in private mode. How can I help you today?").catch(() => {});
      return { handled: true, message: welcomeMsg };
    } else {
      // Wrong password — clear state
      delete jjSessions[key];
      return {
        handled: true,
        message: "❌ Incorrect password. Switching back to public mode."
      };
    }
  }

  // Intelligent trigger detection
  if (await isJJTrigger(userMessage)) {
    jjSessions[key] = "awaiting_password";
    return {
      handled: true,
      message: "🔐 Hey JJ! Please enter your password to switch to private mode."
    };
  }

  return { handled: false };
}

// ── Handle messages in JJ session ────────────────────────
async function handleJJSession(platform, userId, userMessage, options = {}) {
  const lower = userMessage.toLowerCase().trim();

  // Exit JJ mode
  if (["exit", "logout", "exit jj mode", "back to public", "退出"].includes(lower)) {
    delete jjSessions[`${platform}:${userId}`];
    try { await db.setJJSession(platform, userId, false); } catch(e) {}
    return { handled: true, message: "👋 Exiting JJ private mode. Back to public mode." };
  }

  // Show memory summary
  if (lower === "show memory" || lower === "what do you know" || lower === "显示记忆") {
    const memory = await getJJMemorySummary();
    return {
      handled: true,
      message: memory
        ? `📚 Here's my JJ knowledge base:\n\n${memory}`
        : "No JJ memories stored yet. Start sharing things or upload documents!"
    };
  }

  // ── Paralegal command intercept ──────────────────────────
  if (isParalegalCommand(userMessage)) {
    console.log("[JJ-Mode] 🏛️ Paralegal command detected");
    try {
      const paralegalReply = await handleParalegalCommand(userMessage, { platform, platformId: userId });
      await extractAndSaveJJKnowledge(userMessage, paralegalReply, "[Paralegal]");
      const full = "🏛️ [Zara Paralegal]\n\n" + paralegalReply;
      const final = full.length > 3900
        ? full.substring(0, 3800) + "\n\n...[truncated — voice reply has full response]"
        : full;
      sendVoiceReply(platform, userId, paralegalReply).catch(() => {});
      return { handled: true, message: final };
    } catch (err) {
      console.error("[JJ-Mode] Paralegal error:", err.message);
      // Fall through to normal JJ mode
    }
  }
  // ── End paralegal intercept ───────────────────────────────

  // ── CourtListener case law research ──────────────────────
  if (isResearchCommand(userMessage)) {
    console.log("[JJ-Mode] 🔍 Research command detected");
    try {
      const research = await handleResearchCommand(userMessage);
      await extractAndSaveJJKnowledge(userMessage, research, "[Research]");
      sendVoiceReply(platform, userId, research).catch(() => {});
      const full = "🔍 [Case Law]\n\n" + research;
      return { handled: true, message: full.length > 3900 ? full.substring(0,3800) + "\n...[truncated]" : full };
    } catch (err) {
      console.error("[JJ-Mode] Research error:", err.message);
    }
  }

  // ── CA Statute lookup ────────────────────────────────────
  if (isStatuteCommand(userMessage)) {
    console.log("[JJ-Mode] 📚 Statute command detected");
    try {
      const statute = await handleStatuteCommand(userMessage);
      sendVoiceReply(platform, userId, statute).catch(() => {});
      return { handled: true, message: "📚 [CA Statute]\n\n" + statute };
    } catch (err) {
      console.error("[JJ-Mode] Statute error:", err.message);
    }
  }

  // ── Citation good law check ──────────────────────────────
  if (isCitationCommand(userMessage)) {
    console.log("[JJ-Mode] 🔗 Citation command detected");
    try {
      const cite = await handleCitationCommand(userMessage);
      sendVoiceReply(platform, userId, cite).catch(() => {});
      return { handled: true, message: "🔗 [Citation Check]\n\n" + cite };
    } catch (err) {
      console.error("[JJ-Mode] Citation error:", err.message);
    }
  }

  // ── Judge profile lookup ─────────────────────────────────
  const judgeMatch = userMessage.match(/judge\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i) ||
                     userMessage.match(/hon\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const motionMatch = userMessage.match(/(demurrer|msj|summary judgment|motion to strike|motion to compel|unlawful detainer|anti-slapp|sanctions|discovery|injunction)/i);

  if (judgeMatch && /profile|analytics|how does|how do|ruling|grant rate|tend|usually|typically/.test(userMessage.toLowerCase())) {
    console.log("[JJ-Mode] ⚖️ Judge profile command detected");
    try {
      const profile = await formatJudgeProfileForJJ(
        judgeMatch[1],
        null,
        motionMatch?.[1] || null
      );
      sendVoiceReply(platform, userId, profile).catch(() => {});
      const full = "⚖️ [Judge Profile]\n\n" + profile;
      return { handled: true, message: full.length > 3900 ? full.substring(0,3800) + "\n...[truncated]" : full };
    } catch (err) {
      console.error("[JJ-Mode] Judge profile error:", err.message);
    }
  }

  // Build JJ-specific system prompt
  const jjContext = await getJJContext();
  const jjSystemPrompt = buildJJSystemPrompt(jjContext);

  // Build message content — handle documents and images
  let messageContent;
  if (options.isPdf && options.pdfData) {
    messageContent = [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: options.pdfData } },
      { type: "text", text: userMessage || "Please analyze this document thoroughly. Extract all key information, legal insights, case details, and anything that would be valuable to remember for future reference." }
    ];
  } else if (options.isImage && options.imageData) {
    messageContent = [
      { type: "image", source: { type: "base64", media_type: options.imageMediaType || "image/jpeg", data: options.imageData } },
      { type: "text", text: userMessage || "Please analyze this image thoroughly. Extract all key information and anything that would be valuable to remember." }
    ];
  } else {
    messageContent = userMessage;
  }

  // Call Claude with tool_use loop — JJ mode uses web search heavily
  try {
    const allTools = [{ type: "web_search_20250305", name: "web_search" }];
    let loopMessages = [{ role: "user", content: messageContent }];
    let reply = "";
    const MAX_LOOPS = 5;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      let respData;
      try {
        const resp = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            system: jjSystemPrompt,
            tools: allTools,
            messages: loopMessages,
          },
          {
            headers: {
              "x-api-key": process.env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json"
            },
            timeout: 180000
          }
        );
        respData = resp.data;
      } catch (apiErr) {
        const status  = apiErr.response?.status;
        const errBody = apiErr.response?.data;
        console.error(`[JJ-Mode] ❌ API call loop=${loop} FAILED`);
        console.error(`[JJ-Mode]   HTTP Status : ${status || "no response"}`);
        console.error(`[JJ-Mode]   Error       : ${apiErr.message}`);
        console.error(`[JJ-Mode]   Body        : ${JSON.stringify(errBody)}`);
        if (apiErr.code === "ECONNABORTED") {
          throw new Error("⏱️ That research took too long. Try a more specific query, or break it into smaller questions.");
        } else if (status === 529 || status === 503) {
          throw new Error("🔄 AI service temporarily busy. Please try again in a moment.");
        } else {
          throw new Error(`❌ API error (${status || apiErr.message}). Please try again.`);
        }
      }

      console.log(`[JJ-Mode] loop=${loop} stop_reason=${respData.stop_reason} blocks=${respData.content?.length}`);

      if (respData.stop_reason === "end_turn") {
        reply = respData.content
          .filter(b => b.type === "text").map(b => b.text).join("").trim();
        if (!reply) {
          console.error(`[JJ-Mode] ❌ end_turn but no text block. Content: ${JSON.stringify(respData.content)}`);
          reply = "I had trouble processing that. Please try again.";
        }
        break;
      }

      if (respData.stop_reason === "tool_use") {
        const toolUseBlocks = respData.content.filter(b => b.type === "tool_use");
        console.log(`[JJ-Mode] tool_use: ${toolUseBlocks.map(b => b.name).join(", ")}`);
        loopMessages.push({ role: "assistant", content: respData.content });
        const toolResults = toolUseBlocks.map(toolUse => ({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: "Search completed. Please synthesize the results."
        }));
        loopMessages.push({ role: "user", content: toolResults });
        continue;
      }

      console.error(`[JJ-Mode] ❌ Unexpected stop_reason: ${respData.stop_reason}`);
      reply = "I had trouble processing that. Please try again.";
      break;
    }

    if (!reply) reply = "I had trouble processing that. Please try again.";

    // Save to JJ knowledge base
    const isResearch = isResearchRequest(userMessage);
    const label = options.isPdf ? "[PDF Document uploaded]"
      : options.isImage ? "[Image/Document uploaded]"
      : isResearch ? `[Research: ${userMessage.substring(0, 100)}]`
      : userMessage;
    await extractAndSaveJJKnowledge(label, reply);

    const docNote = (options.isPdf || options.isImage)
      ? "📄 Document analyzed and saved to your knowledge base.\n\n"
      : isResearch ? "🔍 Research complete and saved to your knowledge base.\n\n"
      : "";

    // Send voice reply async — non-blocking, text already returned
    sendVoiceReply(platform, userId, reply).catch(() => {});

    // Truncate for Telegram's 4096-char limit; voice reply has full analysis
    const fullMessage = "🔒 [JJ Mode]\n\n" + docNote + reply;
    const finalMessage = fullMessage.length > 3900
      ? fullMessage.substring(0, 3800) + "\n\n...\n\n[Response truncated - voice reply has full analysis]"
      : fullMessage;
    return { handled: true, message: finalMessage };
  } catch (err) {
    console.error("JJ mode Claude error:", err.message);
    return { handled: true, message: "Sorry JJ, I had a technical issue. Please try again." };
  }
}

// ── Build JJ-specific system prompt ──────────────────────
function buildJJSystemPrompt(jjContext) {
  return [
    "You are Zara in PRIVATE MODE — JJ Zhang's personal AI assistant with no restrictions.",
    "",
    "JJ Zhang is the Managing Attorney of Tez Law P.C. This is a private, unlimited collaborative session.",
    "",
    "YOU CAN HELP JJ WITH ANYTHING:",
    "- Legal research, case strategy, complex legal analysis",
    "- Business, investments, personal decisions",
    "- Research any topic on the web and summarize findings",
    "- General knowledge, coding, writing, brainstorming",
    "- Learning and exploring any subject together",
    "- Personal projects, ideas, planning",
    "",
    "RESEARCH MODE:",
    "When JJ asks you to research, look up, find out about, or learn about any topic:",
    "1. Use your web_search tool to search thoroughly — do multiple searches if needed",
    "2. Synthesize the key findings into a clear, comprehensive summary",
    "3. Save the research to memory automatically",
    "4. Give JJ a detailed but readable response with key takeaways",
    "",
    "RULES IN JJ MODE:",
    "- No topic restrictions — help with anything JJ asks",
    "- Be direct, detailed, and treat JJ as a peer",
    "- No disclaimers or oversimplification needed",
    "- Remember everything — it all goes into the permanent knowledge base",
    "- Respond in whatever language JJ uses",
    "- When JJ shares or teaches you something, acknowledge what you are saving",
    "- Research findings are saved so you can reference them in future sessions",
    "",
    "CURRENT JJ KNOWLEDGE BASE:",
    jjContext || "No previous knowledge stored yet — start building it together!",
    "",
    "",
    "VOICE CAPABILITIES: You CAN send voice messages. When JJ asks to respond in voice or speak, just respond normally in text — the system converts it to voice automatically. Never say you cannot do voice.",
    "",
    "Be Zara at her best — smart, thorough, curious, and genuinely helpful.",
    "",
    "JUDGE INTELLIGENCE:",
    "When JJ mentions a judge by name in the context of drafting a motion or preparing for hearing,",
    "proactively mention that you can pull that judge\'s profile from your database.",
    "Example: \'I can pull Judge Martinez\'s profile — want to see how he rules on demurrers?\'",
    "Use: \'judge [name] profile\' or \'how does judge [name] rule on [motion]\'",
  ].join("\n");
}

// ── Extract and save knowledge from JJ's messages ────────
async function extractAndSaveJJKnowledge(userMessage, zaraReply, label = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    jj_said: (label || userMessage).substring(0, 2000),
    zara_said: zaraReply.substring(0, 2000),
  };
  await db.saveJJMemory(entry);
}

// ── Get JJ context for system prompt ─────────────────────
async function getJJContext() {
  try {
    const memories = await db.getJJMemories(50); // last 50 entries
    if (!memories || memories.length === 0) return null;
    return memories
      .map(m => `[${new Date(m.timestamp).toLocaleDateString()}] JJ: ${m.jj_said}\nZara: ${m.zara_said}`)
      .join("\n\n---\n\n");
  } catch(e) {
    console.error("getJJContext error:", e.message);
    return null;
  }
}

// ── Get summary of JJ memory for display ─────────────────
async function getJJMemorySummary() {
  try {
    const memories = await db.getJJMemories(10);
    if (!memories || memories.length === 0) return null;
    return memories
      .map((m, i) => `${i+1}. [${new Date(m.timestamp).toLocaleDateString()}] ${m.jj_said.substring(0, 100)}...`)
      .join("\n");
  } catch(e) {
    return null;
  }
}

// ── Get JJ knowledge for enriching PUBLIC responses ──────
// Called by askClaude-memory.js to add JJ's insights to public answers
async function getJJPublicContext() {
  try {
    const memories = await db.getJJMemories(30);
    if (!memories || memories.length === 0) return null;

    // Return a condensed version for public use
    return memories
      .map(m => `${m.jj_said.substring(0, 150)}`)
      .join(" | ");
  } catch(e) {
    return null;
  }
}

// ── Detect research requests ─────────────────────────────
function isResearchRequest(message) {
  const lower = message.toLowerCase();
  return /^(research|look up|find out|learn about|search for|investigate|study|explore|tell me about|what is|what are|how does|explain)\s+.{5,}/i.test(message) ||
    lower.includes("research ") || lower.includes("look up ") ||
    lower.includes("find information") || lower.includes("search for ");
}

module.exports = {
  checkJJMode,
  isJJAuthenticated,
  isJJAuthenticatedAsync,
  getJJPublicContext,
  isResearchRequest,
};
