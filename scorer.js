// scorer.js — Conversation Scorer for Zara (Wave 2)
// Scores each conversation session on accuracy, tone, disclaimer compliance, UPL risk
// Called from askClaude-memory.js when a session ends (4h gap detected)

const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const client = new Anthropic();

async function scoreConversation(platform, platformId, messages, sessionStart) {
  if (!messages || messages.length < 2) return null;

  // Only score conversations with at least one Zara response
  const zaraMessages = messages.filter(m => m.role === "assistant");
  if (!zaraMessages.length) return null;

  // Build transcript (last 20 messages max)
  const transcript = messages.slice(-20).map(m =>
    `[${m.role === "assistant" ? "ZARA" : "CLIENT"}]: ${m.content.substring(0, 500)}`
  ).join("\n");

  const prompt = `You are a legal AI quality reviewer for Tez Law P.C. in California.

Review this conversation between Zara (AI assistant) and a client. Score each dimension 1-10.

TRANSCRIPT:
${transcript}

Score these dimensions:
1. ACCURACY (1-10): Was legal information factually correct for California law?
2. TONE (1-10): Was Zara warm, professional, and empathetic?
3. DISCLAIMER (1-10): Did Zara properly disclaim that responses are not legal advice?
4. UPL_RISK (1-10): Risk of unauthorized practice of law? (10 = very high risk, 1 = no risk)

Respond ONLY in JSON:
{
  "accuracy": <1-10>,
  "tone": <1-10>,
  "disclaimer": <1-10>,
  "upl_risk": <1-10>,
  "summary": "<one sentence summary of the conversation and any concerns>",
  "flags": ["<any specific issues found>"]
}`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const scores = JSON.parse(clean);

    const sessionEnd = new Date();
    const msgCount = messages.length;

    const scoreId = await db.saveConversationScore(
      platform, platformId,
      sessionStart, sessionEnd, msgCount,
      {
        accuracy:   scores.accuracy,
        tone:       scores.tone,
        disclaimer: scores.disclaimer,
        upl_risk:   scores.upl_risk,
      },
      scores.summary + (scores.flags?.length ? " Flags: " + scores.flags.join(", ") : "")
    );

    const overall = Math.round((scores.accuracy + scores.tone + scores.disclaimer + (10 - scores.upl_risk)) / 4);
    if (overall < 6 || scores.upl_risk > 7) {
      console.log(`⚠️  [SCORER] Conversation flagged for review (${platform}/${platformId}) — overall: ${overall}, UPL: ${scores.upl_risk}`);
    } else {
      console.log(`✅ [SCORER] Scored (${platform}/${platformId}) — overall: ${overall}/10`);
    }

    return scoreId;
  } catch (err) {
    console.error("Scorer error:", err.message);
    return null;
  }
}

module.exports = { scoreConversation };
