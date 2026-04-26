// ============================================================
//  jj-mode.js — JJ Zhang Private Mode for Zara
//  Password-protected session with persistent memory
//  that also enriches public responses
// ============================================================

const axios              = require("axios");
const db                 = require("./db");
const { sendVoiceReply } = require("./voice");

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

        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          if (toolUse.name === "web_search") {
            const query = toolUse.input?.query || "";
            console.log(`[JJ-Mode] web_search query: "${query}"`);

            // ── Legal citation/case search interceptor ───────────
            // If Claude is trying to search for a case, redirect to
            // CourtListener instead of trusting random web results
            const legalSearchPattern = /\b(v\.|versus|case|cases|ruling|opinion|decision|court|held|holding|citing|cites?|\d+\s+[A-Z][a-z]+\.\s*\d+|Cal\.|F\.\d+[a-z]+|I&N Dec)\b/i;

            if (legalSearchPattern.test(query)) {
              console.log(`[JJ-Mode] 🔒 Legal query intercepted — redirecting to CourtListener: "${query}"`);
              toolResults.push({
                type:        "tool_result",
                tool_use_id: toolUse.id,
                content:     `⚠️ LEGAL SEARCH INTERCEPTED: Web search is not a reliable source for case law verification. Query: "${query}"\n\nIMPORTANT: Do NOT cite any case based on web search results. Instead:\n1. Use the CourtListener integration (already available) for verified case lookup\n2. Tell JJ: "I'm routing this to CourtListener for a verified result"\n3. If CourtListener is unavailable, tell JJ the citation is UNVERIFIED and must be checked in Westlaw/Lexis before any use\n\nDo NOT fabricate or assume any case details. Do NOT treat blog posts, law reviews, or secondary sources as proof a case exists.`,
              });
            } else {
              // Non-legal web search — proceed normally
              toolResults.push({
                type:        "tool_result",
                tool_use_id: toolUse.id,
                content:     "Search completed. Please synthesize the results. Remember: if any case citations appear in search results, flag them as UNVERIFIED until confirmed via CourtListener.",
              });
            }
          } else {
            toolResults.push({
              type:        "tool_result",
              tool_use_id: toolUse.id,
              content:     "Action not available.",
            });
          }
        }
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
    "⚠️  LEGAL CITATION RULES — STRICTLY ENFORCED:",
    "When web search returns content about case law or legal citations:",
    "1. NEVER treat a blog post, law review article, legal news site, or secondary source as proof a case exists",
    "2. NEVER cite a case you found mentioned on a website as real authority — mention source as unverified only",
    "3. ONLY treat these as verified authority: courtlistener.com, courts.ca.gov, ca9.uscourts.gov, justice.gov/eoir, supremecourt.gov, law.justia.com/cases (primary source pages only)",
    "4. If JJ asks to research case law → say 'I'll use CourtListener for this' and let the CourtListener module handle it — do NOT use web_search for finding cases",
    "5. If a citation appears in web search results, ALWAYS flag it as 'UNVERIFIED — needs CourtListener/Westlaw check' before presenting it",
    "6. NEVER fabricate or guess at reporter volumes, page numbers, or years — if uncertain, say 'I cannot confirm this citation'",
    "7. Legal blog posts (Justia blog, Above the Law, Law360, legal newsletters) are COMMENTARY — never authority",
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
    "Be Zara at her best — smart, thorough, curious, and genuinely helpful."
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
