// ============================================================
//  askClaude-memory.js
//  Zara brain with PostgreSQL memory + intake form integration
// ============================================================

const axios  = require("axios");
const fs     = require("fs");
const db     = require("./db");
const { checkIntake, resetIntake } = require("./intake");
const { checkJJMode, getJJPublicContext } = require("./jj-mode");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Load weekly trends from autoposter sources.json ──────
// Autoposter saves this file every Sunday with current legal trends
const SOURCES_FILE = "/var/data/sources.json";

function getWeeklyTrends() {
  try {
    if (!fs.existsSync(SOURCES_FILE)) return null;
    const sources = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
    if (!sources.weeklyTrends) return null;

    // Only use if researched within last 8 days
    if (sources.lastResearched) {
      const daysSince = (Date.now() - new Date(sources.lastResearched).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 8) return null;
    }

    let trends = `Current legal trends (as of ${new Date(sources.lastResearched).toLocaleDateString()}): ${sources.weeklyTrends}`;
    if (sources.urgentArea && sources.urgentTopic) {
      trends += `\n\nURGENT THIS WEEK (${sources.urgentArea}): ${sources.urgentTopic}`;
    }
    return trends;
  } catch(e) {
    return null;
  }
}

// ── Load full sources data for proactive warnings + lead routing ──
function getSourcesData() {
  try {
    if (!fs.existsSync(SOURCES_FILE)) return null;
    const sources = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
    if (!sources.lastResearched) return null;
    const daysSince = (Date.now() - new Date(sources.lastResearched).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 8) return null;
    return sources;
  } catch(e) { return null; }
}

// ── Load recent WordPress posts for FAQ reference ──────────
const POSTS_CACHE_FILE = "/var/data/recent_posts_cache.json";

async function getRecentPosts() {
  // Use cached posts if fresh (< 6 hours old)
  try {
    if (fs.existsSync(POSTS_CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(POSTS_CACHE_FILE, "utf8"));
      const hoursOld = (Date.now() - cache.timestamp) / (1000 * 60 * 60);
      if (hoursOld < 6 && cache.posts?.length > 0) return cache.posts;
    }
  } catch(e) {}

  // Fetch from WordPress REST API
  const WP_URL = process.env.WP_URL;
  if (!WP_URL) return null;
  try {
    const resp = await axios.get(
      `${WP_URL}/wp-json/wp/v2/posts?per_page=20&status=publish&_fields=id,title,link,excerpt,categories,date`,
      { timeout: 5000 }
    );
    const posts = resp.data.map(p => ({
      title: p.title?.rendered?.replace(/<[^>]+>/g, "") || "",
      link: p.link,
      excerpt: p.excerpt?.rendered?.replace(/<[^>]+>/g, "").substring(0, 150) || "",
      date: p.date?.split("T")[0] || ""
    })).filter(p => p.title && p.link);

    // Cache for 6 hours
    fs.writeFileSync(POSTS_CACHE_FILE, JSON.stringify({ posts, timestamp: Date.now() }));
    return posts;
  } catch(e) {
    console.log("WP posts fetch failed:", e.message);
    return null;
  }
}

// ── Build FAQ reference block from recent posts ───────────
function buildFaqBlock(posts, caseType, weeklyTrends) {
  if (!posts || posts.length === 0) return null;

  // Map case type to keywords for relevance filtering
  const keywordMap = {
    immigration: ["immigration", "visa", "green card", "deportation", "asylum", "daca", "citizenship", "immigrant"],
    personal_injury: ["accident", "injury", "car crash", "personal injury", "dui", "slip", "fall"],
    business: ["business", "contract", "litigation", "employment", "non-compete", "trade secret"],
    ip: ["trademark", "patent", "copyright", "intellectual property"],
    estate: ["estate", "trust", "probate", "will", "inheritance", "prop 19"],
  };

  const keywords = caseType ? (keywordMap[caseType] || []) : [];

  // Filter relevant posts
  let relevant = posts.filter(p => {
    const text = (p.title + " " + p.excerpt).toLowerCase();
    return keywords.some(k => text.includes(k));
  }).slice(0, 3);

  // If no relevant posts by case type, use most recent
  if (relevant.length === 0) relevant = posts.slice(0, 2);

  if (relevant.length === 0) return null;

  return relevant.map(p => `- "${p.title}" (${p.date}): ${p.link}`).join("\n");
}

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

    // Inject JJ knowledge base into public responses (discreetly)
    const jjKnowledge = await getJJPublicContext();
    if (jjKnowledge) {
      personalizedSystem += `\n\n── FIRM KNOWLEDGE (use naturally, never quote directly) ──\n${jjKnowledge.substring(0, 1500)}\n── END FIRM KNOWLEDGE ──`;
    }

    // ── Inject weekly trends + proactive warnings + lead routing + FAQ refs ──
    const sources = getSourcesData();
    const weeklyTrends = getWeeklyTrends();

    if (weeklyTrends) {
      personalizedSystem += `\n\n── CURRENT LEGAL TRENDS ──\n${weeklyTrends}\n── END TRENDS ──`;
    }

    // Proactive warning: if client is asking about urgent area, warn them naturally
    if (sources?.urgentArea && sources?.urgentTopic && caseType) {
      const urgentAreaLower = sources.urgentArea.toLowerCase();
      const caseTypeLower = (caseType || "").toLowerCase();
      const isMatch = (
        (urgentAreaLower.includes("immigra") && caseTypeLower.includes("immigra")) ||
        (urgentAreaLower.includes("personal injury") && caseTypeLower.includes("personal")) ||
        (urgentAreaLower.includes("business") && caseTypeLower.includes("business")) ||
        (urgentAreaLower.includes("estate") && caseTypeLower.includes("estate")) ||
        (urgentAreaLower.includes("trademark") && caseTypeLower.includes("ip"))
      );
      if (isMatch) {
        personalizedSystem += `\n\n── PROACTIVE WARNING (mention naturally once if relevant) ──\nThere is an important development this week related to this client\'s situation: ${sources.urgentTopic}. If appropriate, mention it naturally — e.g. "By the way, there\'s something important happening this week you should know about..."\n── END WARNING ──`;
      }
    }

    // Smart lead routing: if urgent topic involves attorneys/professionals, route to JJ
    if (sources?.urgentTopic) {
      const urgentLower = sources.urgentTopic.toLowerCase();
      const msgLower = userMessage.toLowerCase();
      const isAttorneyTopic = /attorney|lawyer|law firm|sanctions|bar complaint|court sanction|fake citation|ai citation|malpractice/.test(urgentLower);
      const userIsAttorney = /attorney|lawyer|i'm a lawyer|law firm|my client|legal practice|bar number/.test(msgLower);
      if (isAttorneyTopic && userIsAttorney) {
        personalizedSystem += `\n\n── LEAD ROUTING ──\nThis user appears to be a legal professional asking about: ${sources.urgentTopic}. Route them to JJ Zhang directly for a professional consultation: jj@tezlawfirm.com or 626-678-8677.\n── END ROUTING ──`;
      }
    }

    // FAQ reference: inject recent relevant blog posts
    try {
      const recentPosts = await getRecentPosts();
      const faqBlock = buildFaqBlock(recentPosts, caseType, weeklyTrends);
      if (faqBlock) {
        personalizedSystem += `\n\n── RECENT TEZ LAW GUIDES (reference naturally when answering questions) ──\nWe recently published these guides that may be relevant:\n${faqBlock}\nWhen a client asks a question covered by one of these, naturally mention: "We actually just published a guide on this — [title] at [link]" and give them the key points.\n── END GUIDES ──`;
      }
    } catch(e) {
      // Non-fatal — continue without posts
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
    const allTools = [
      { type: "web_search_20250305", name: "web_search" },
      ...(options.extraTools || [])
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
        const status  = apiErr.response?.status;
        const errBody = apiErr.response?.data;
        console.error(`[askClaude] ❌ API call loop=${loop} FAILED`);
        console.error(`[askClaude]   HTTP Status : ${status || "no response"}`);
        console.error(`[askClaude]   Error       : ${apiErr.message}`);
        console.error(`[askClaude]   Body        : ${JSON.stringify(errBody)}`);
        console.error(`[askClaude]   Timeout?    : ${apiErr.code === "ECONNABORTED"}`);
        console.error(`[askClaude]   Platform    : ${platform} | User: ${platformId}`);
        console.error(`[askClaude]   Message     : ${userMessage.substring(0, 100)}`);

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

      if (respData.stop_reason === "end_turn") {
        reply = respData.content
          .filter(b => b.type === "text").map(b => b.text).join("").trim();
        if (!reply) {
          console.error(`[askClaude] ❌ end_turn but no text block. Content: ${JSON.stringify(respData.content)}`);
          reply = "I'm sorry, I didn't catch that. Could you rephrase?";
        }
        break;
      }

      if (respData.stop_reason === "tool_use") {
        const toolUseBlocks = respData.content.filter(b => b.type === "tool_use");
        console.log(`[askClaude] tool_use blocks: ${toolUseBlocks.map(b => b.name).join(", ")}`);

        loopMessages.push({ role: "assistant", content: respData.content });

        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
          if (toolUse.name === "web_search") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Search completed. Please synthesize the results."
            });
          } else if (options.executeAction) {
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
