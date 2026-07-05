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

  // ── /help — Show all JJ commands ──
  if (lower === "/help" || lower === "help" || lower === "commands") {
    const helpText = [
      "🔒 *JJ Mode — Command Reference*",
      "",
      "*💬 General*",
      "  Just ask any legal question — Zara searches moat + firm docs.",
      "  `show memory` — see what Zara remembers",
      "  `/logout` — end JJ session",
      "",
      "*📚 Firm Documents (Phase 2)*",
      "  `/brief [source-url]` — upload public document, text on next lines",
      "  `/brief` as PDF caption — upload attached PDF",
      "  `/firm list [practice_area]` — see recent firm docs",
      "  `/firm delete <id>` — remove a firm doc",
      "  `/outcome <id> won|lost|settled|pending [notes]` — mark case outcome",
      "",
      "*🎯 Feedback Loop (Phase 3)*",
      "  `/good` — thumbs up last answer, boost its sources",
      "  `/bad [reason]` — thumbs down, demote sources",
      "  `/fix <corrected version>` — supply gold answer, stored for future",
      "  `/rate <answer-id> good|bad` — rate a specific past answer",
      "  `/stats` — see feedback history + weight distribution",
      "",
      "*📰 Legal Digest*",
      "  `/pending` — see auto-detected cache updates awaiting approval",
      "  `/approve <id>` — approve pending update",
      "  `/reject <id>` — reject pending update",
      "  `/status` — bot status snapshot",
      "",
      "*🤖 Automation Running*",
      "  Sat 11 PM PT — Weekly moat update (new court rulings)",
      "  Daily 6 AM PT — Legal digest (contradictions → /pending)",
      "  Daily 7 AM PT — Deadline summary",
      "  Daily 8 AM PT — Autoposter (blog + firm doc ingest)",
      "  Sun 3 AM PT — Cache purge",
      "",
      "_311K precedents • 143 firm docs • JJ mode session persists across redeploys_",
    ].join("\n");
    return { handled: true, message: helpText };
  }

  // ── /status — snapshot of moat + firm knowledge ──
  if (lower === "/status") {
    try {
      const r1 = await db.query(`SELECT COUNT(*) AS n FROM citation_edges_internal WHERE embedding IS NOT NULL`);
      const r2 = await db.query(`SELECT COUNT(*) AS n FROM firm_documents`);
      const r3 = await db.query(`SELECT COUNT(*) AS n FROM jj_answers`).catch(() => ({ rows: [{ n: "0" }] }));
      const r4 = await db.query(`SELECT COUNT(*) AS n FROM jj_answers WHERE rating IS NOT NULL`).catch(() => ({ rows: [{ n: "0" }] }));
      const r5 = await db.query(`SELECT COUNT(*) AS n FROM jj_corrections`).catch(() => ({ rows: [{ n: "0" }] }));
      const r6 = await db.query(`SELECT COUNT(*) AS n FROM pending_cache_updates WHERE status = 'pending'`).catch(() => ({ rows: [{ n: "0" }] }));

      const status = [
        "📊 *Zara Status*",
        "",
        `*Moat (Level 3 RAG):*`,
        `  • ${parseInt(r1.rows[0].n).toLocaleString()} embedded parens`,
        "",
        `*Firm knowledge (Phase 2):*`,
        `  • ${parseInt(r2.rows[0].n).toLocaleString()} firm documents`,
        "",
        `*Feedback (Phase 3):*`,
        `  • ${parseInt(r3.rows[0].n).toLocaleString()} answers logged`,
        `  • ${parseInt(r4.rows[0].n).toLocaleString()} rated`,
        `  • ${parseInt(r5.rows[0].n).toLocaleString()} corrections stored`,
        "",
        `*Legal digest:*`,
        `  • ${parseInt(r6.rows[0].n).toLocaleString()} pending cache updates awaiting /approve`,
        "",
        `_All systems operational._`,
      ].join("\n");
      return { handled: true, message: status };
    } catch (e) {
      return { handled: true, message: `❌ /status error: ${e.message}` };
    }
  }

  // ── /approve <id>, /reject <id>, /pending — cache update approvals ──
  // These come from legal-digest contradiction detection. JJ taps these
  // from his phone to approve or reject auto-detected cache updates.
  const approvalMatch = lower.match(/^\/(approve|reject)\s+(\d+)\b/);
  if (approvalMatch) {
    try {
      const { decidePendingUpdate } = require("./legal-digest");
      const decision = approvalMatch[1];
      const id       = parseInt(approvalMatch[2], 10);
      const result   = await decidePendingUpdate(id, decision);
      return { handled: true, message: result.msg };
    } catch (err) {
      console.error("[JJ-Mode] Approval handler error:", err.message);
      return { handled: true, message: `❌ Approval error: ${err.message}` };
    }
  }

  if (lower === "/pending" || lower === "pending updates" || lower === "show pending") {
    try {
      const result = await db.query(
        `SELECT id, question, opinion_court, opinion_date, created_at
         FROM pending_cache_updates
         WHERE status = 'pending'
         ORDER BY created_at DESC
         LIMIT 20`
      );

      if (!result.rows.length) {
        return { handled: true, message: "✅ No pending cache updates." };
      }

      const lines = result.rows.map(r => {
        const q = r.question.length > 70 ? r.question.substring(0, 70) + "..." : r.question;
        const meta = [r.opinion_court, r.opinion_date].filter(Boolean).join(" • ");
        return `#${r.id} — ${q}${meta ? "\n   " + meta : ""}`;
      });

      const msg = [
        `⚠️ ${result.rows.length} pending cache update(s):`,
        "",
        lines.join("\n\n"),
        "",
        "Reply /approve <id> or /reject <id>",
      ].join("\n");

      return { handled: true, message: msg };
    } catch (err) {
      console.error("[JJ-Mode] /pending error:", err.message);
      return { handled: true, message: `❌ Error fetching pending updates: ${err.message}` };
    }
  }

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

  // ── /brief — Ingest a firm document into moat (Phase 2) ──
  //  Usage:
  //    /brief <optional source URL>
  //    <document text on subsequent lines>
  //
  //    Or attach PDF with /brief as caption.
  //
  //  Zara will pre-flight check public/private, redact PII, extract structure,
  //  embed, and store. Only public documents accepted by default.
  //
  //  Note: matches on the FIRST line of the message (multi-line messages have
  //  document body on lines 2+).
  const firstLine = lower.split("\n", 1)[0].trim();
  const briefMatch = firstLine.match(/^\/brief(?:\s+(.*))?$/);
  if (briefMatch) {
    try {
      const { ingestDocument } = require("./firm-documents");
      const argsText = briefMatch[1] || "";

      // Parse optional URL from args
      const urlMatch = argsText.match(/https?:\/\/\S+/);
      const sourceUrl = urlMatch ? urlMatch[0] : null;
      const labelHint = argsText.replace(urlMatch ? urlMatch[0] : "", "").trim();

      // Get document text: either from PDF or from message body (after /brief line)
      let docText = null;

      if (options.isPdf && options.pdfText) {
        // pdfText is expected to be pre-extracted plain text from the PDF
        docText = options.pdfText;
      } else if (options.pdfData) {
        return { handled: true, message: "⚠️ PDF received but no text extracted. The upload handler needs to pass options.pdfText (extracted plaintext) for /brief to work. Alternatively, paste the document text directly." };
      } else {
        // Look for document text after the /brief line (multi-line message)
        const lines = userMessage.split("\n");
        if (lines.length > 1) {
          docText = lines.slice(1).join("\n").trim();
        }
      }

      if (!docText || docText.length < 200) {
        return {
          handled: true,
          message: [
            "📥 *Firm Document Ingestion*",
            "",
            "To upload a document to firm memory:",
            "",
            "*Option A* — Paste text:",
            "```",
            "/brief https://source-url.com (optional)",
            "<paste full document text here>",
            "```",
            "",
            "*Option B* — Attach a PDF with `/brief` as caption.",
            "",
            "⚠️ *ONLY public/filed documents accepted.* Zara will refuse anything that looks like private client work.",
            "",
            "Once ingested, Zara will search these alongside published cases in future JJ answers.",
          ].join("\n")
        };
      }

      // Actually ingest (async, but we wait so we can return the result)
      const notice = "⏳ Ingesting document — pre-flight check + redaction + extraction + embedding. Takes ~30-60 seconds...";
      // Fire-and-await
      const result = await ingestDocument({
        text: docText,
        sourceUrl,
        matterLabelOverride: labelHint || null,
        allowPrivate: false,
        actorId: "jj",
      });

      if (!result.ok) {
        const preflightInfo = result.preflight
          ? `\n\n_Preflight verdict: ${result.preflight.verdict}_\n_Reason: ${result.preflight.reason}_${
              (result.preflight.redFlags || []).length ? "\n_Red flags: " + result.preflight.redFlags.join(", ") + "_" : ""
            }`
          : "";
        return {
          handled: true,
          message: `❌ *Ingestion refused*\n\n${result.reason}${preflightInfo}`
        };
      }

      return {
        handled: true,
        message: [
          "✅ *Document ingested*",
          "",
          `📄 *${result.matterLabel}*`,
          `Type: ${result.documentType} • Practice: ${result.practiceArea}`,
          `Public: ${result.isPublic ? "yes" : "unclear"}`,
          "",
          `📊 Extracted:`,
          `  • ${result.keyIssuesCount} legal issues`,
          `  • ${result.keyArgumentsCount} key arguments`,
          `  • ${result.authoritiesCount} authorities cited`,
          `  • ${result.redactionsCount} PII items redacted`,
          `  • Embedded: ${result.hasEmbedding ? "yes" : "no (search will still work by metadata)"}`,
          "",
          `Doc ID: ${result.docId}`,
          "",
          `_Zara will now cite this in future JJ answers when relevant._`,
          "",
          `Add outcome later: \`/outcome ${result.docId} won|lost|settled|pending [notes]\``,
        ].join("\n")
      };
    } catch (e) {
      console.error("[JJ-Mode] /brief error:", e.message, e.stack);
      return { handled: true, message: `❌ /brief error: ${e.message}` };
    }
  }

  // ── /firm — List, delete firm documents ──
  const firmListMatch = lower.match(/^\/firm\s+(list|recent)(?:\s+(\w+))?$/);
  if (firmListMatch) {
    try {
      const { listFirmDocs } = require("./firm-documents");
      const practiceArea = firmListMatch[2] || null;
      const rows = await listFirmDocs({ limit: 15, practiceArea });
      if (!rows.length) {
        return { handled: true, message: "📚 No firm documents ingested yet. Use `/brief` to add one." };
      }
      const lines = rows.map(r => {
        const dt = r.uploaded_at.toISOString().split("T")[0];
        const outc = r.outcome ? ` • outcome:${r.outcome}` : "";
        return `#${r.id} — *${r.matter_label}*\n   ${r.document_type} • ${r.practice_area} • ${dt}${outc}`;
      });
      return {
        handled: true,
        message: `📚 *Firm documents* (${rows.length}${practiceArea ? " in " + practiceArea : ""}):\n\n${lines.join("\n\n")}`
      };
    } catch (e) {
      console.error("[JJ-Mode] /firm list error:", e.message);
      return { handled: true, message: `❌ Error: ${e.message}` };
    }
  }

  const firmDeleteMatch = lower.match(/^\/firm\s+delete\s+(\d+)$/);
  if (firmDeleteMatch) {
    try {
      const { deleteFirmDoc } = require("./firm-documents");
      const id = parseInt(firmDeleteMatch[1], 10);
      const result = await deleteFirmDoc(id, "jj");
      return {
        handled: true,
        message: result.ok
          ? `🗑️ Deleted #${id} — ${result.deleted}`
          : `❌ ${result.reason}`
      };
    } catch (e) {
      return { handled: true, message: `❌ Delete error: ${e.message}` };
    }
  }

  // ── /outcome <id> <outcome> [notes] — Mark case outcome ──
  const outcomeMatch = lower.match(/^\/outcome\s+(\d+)\s+(won|lost|settled|pending|unknown|withdrawn|dismissed)(?:\s+(.+))?$/);
  if (outcomeMatch) {
    try {
      const { updateOutcome } = require("./firm-documents");
      const id     = parseInt(outcomeMatch[1], 10);
      const status = outcomeMatch[2];
      const notes  = outcomeMatch[3] || null;
      const result = await updateOutcome(id, status, notes, "jj");
      return {
        handled: true,
        message: result.ok
          ? `✅ Outcome recorded — #${id} (${result.matterLabel}): ${status}${notes ? "\n_" + notes + "_" : ""}`
          : `❌ ${result.reason}`
      };
    } catch (e) {
      return { handled: true, message: `❌ Outcome error: ${e.message}` };
    }
  }

  // ── PHASE 3 FEEDBACK COMMANDS ─────────────────────────────
  const chatIdForFeedback = options.chatId || `${platform}:${userId}`;

  // /good — thumbs up the last answer
  if (lower === "/good") {
    try {
      const { getLastAnswer, rateAnswer } = require("./feedback-loop");
      const last = await getLastAnswer(chatIdForFeedback);
      if (!last) return { handled: true, message: "No recent answer to rate. Ask me something first." };
      if (last.rating) return { handled: true, message: `Answer #${last.id} was already rated: ${last.rating}` };
      const result = await rateAnswer(last.id, "good");
      if (!result.ok) return { handled: true, message: `❌ ${result.reason}` };
      return {
        handled: true,
        message: `👍 Rated answer #${last.id} as GOOD.\n\n${result.updatedSources} sources boosted. Zara will surface them more often for similar questions.`
      };
    } catch (e) {
      return { handled: true, message: `❌ /good error: ${e.message}` };
    }
  }

  // /bad [reason] — thumbs down the last answer
  const badMatch = userMessage.match(/^\/bad(?:\s+(.+))?$/i);
  if (badMatch) {
    try {
      const { getLastAnswer, rateAnswer } = require("./feedback-loop");
      const reason = badMatch[1] || null;
      const last = await getLastAnswer(chatIdForFeedback);
      if (!last) return { handled: true, message: "No recent answer to rate." };
      if (last.rating) return { handled: true, message: `Already rated: ${last.rating}` };
      const result = await rateAnswer(last.id, "bad", reason);
      if (!result.ok) return { handled: true, message: `❌ ${result.reason}` };
      return {
        handled: true,
        message: `👎 Rated answer #${last.id} as BAD.\n\n${result.updatedSources} sources demoted.${reason ? "\n\n_Reason: " + reason + "_" : ""}`
      };
    } catch (e) {
      return { handled: true, message: `❌ /bad error: ${e.message}` };
    }
  }

  // /rate <id> <good|bad> [reason] — rate a specific answer by ID
  const rateMatch = userMessage.match(/^\/rate\s+(\d+)\s+(good|bad)(?:\s+(.+))?$/i);
  if (rateMatch) {
    try {
      const { rateAnswer } = require("./feedback-loop");
      const id = parseInt(rateMatch[1], 10);
      const rating = rateMatch[2].toLowerCase();
      const reason = rateMatch[3] || null;
      const result = await rateAnswer(id, rating, reason);
      if (!result.ok) return { handled: true, message: `❌ ${result.reason}` };
      return {
        handled: true,
        message: `${rating === "good" ? "👍" : "👎"} Rated answer #${id} as ${rating.toUpperCase()}.\n${result.updatedSources} sources updated.`
      };
    } catch (e) {
      return { handled: true, message: `❌ /rate error: ${e.message}` };
    }
  }

  // /fix <corrected version> — apply a correction
  const fixMatch = userMessage.match(/^\/fix\b\s*([\s\S]*)$/i);
  if (fixMatch) {
    try {
      const { getLastAnswer, recordCorrection } = require("./feedback-loop");
      const correction = fixMatch[1].trim();
      if (!correction || correction.length < 50) {
        return {
          handled: true,
          message: "Usage: `/fix <your corrected version>` — supply at least a full corrected paragraph.\n\nExample:\n```\n/fix\nActually the right analysis is: [your corrected version]\n```"
        };
      }
      const last = await getLastAnswer(chatIdForFeedback);
      if (!last) return { handled: true, message: "No recent answer to fix." };
      if (last.rating) return { handled: true, message: `Answer #${last.id} was already rated: ${last.rating}` };
      const result = await recordCorrection(last.id, correction);
      if (!result.ok) return { handled: true, message: `❌ ${result.reason}` };
      return {
        handled: true,
        message: `🔧 Correction recorded for answer #${last.id}.\n\nWhen a similar question comes up, Zara will reference your corrected version. Sources from the original answer have been demoted.`
      };
    } catch (e) {
      console.error("[JJ-Mode] /fix error:", e.message, e.stack);
      return { handled: true, message: `❌ /fix error: ${e.message}` };
    }
  }

  // /stats — feedback and moat statistics
  if (lower === "/stats") {
    try {
      const { getFeedbackStats } = require("./feedback-loop");
      const s = await getFeedbackStats();
      const lines = [
        "📊 *Feedback Loop Stats*",
        "",
        `*Answers:*`,
        `  • Total: ${s.answers.total_answers}`,
        `  • 👍 Good: ${s.answers.good_count}`,
        `  • 👎 Bad: ${s.answers.bad_count}`,
        `  • 🔧 Corrected: ${s.answers.corrected_count}`,
        `  • Unrated: ${s.answers.unrated_count}`,
        "",
        `*Source weights:*`,
      ];
      for (const row of s.sources) {
        lines.push(`  • ${row.source_type}: ${row.n} sources | avg=${row.avg_weight} | boosted=${row.boosted} | demoted=${row.demoted}`);
      }
      lines.push("");
      lines.push(`*Corrections stored:* ${s.corrections}`);
      return { handled: true, message: lines.join("\n") };
    } catch (e) {
      return { handled: true, message: `❌ /stats error: ${e.message}` };
    }
  }

  // Build JJ-specific system prompt
  const jjContext = await getJJContext();
  let jjSystemPrompt = buildJJSystemPrompt(jjContext);

  // Track retrieved source IDs for feedback recording later
  let retrievedMoatIds = [];
  let retrievedFirmIds = [];
  let correctionFound = null;

  // ─── Phase D: LEVEL 3 RAG MOAT INJECTION ───────────────────
  // For substantive text questions, semantically search the paren
  // moat and prepend relevant precedent to the system prompt.
  // Fails open — if moat is unavailable or returns nothing, JJ mode
  // continues normally.
  if (!options.isPdf && !options.isImage && userMessage && userMessage.length >= 40) {
    const lowerMsg = userMessage.trim().toLowerCase();
    const isCommand = /^\/(approve|reject|status|pending|help|logout|exit|brief|firm|outcome|good|bad|fix|stats|rate)/.test(lowerMsg);
    const isAckOnly = /^(yes|no|ok|okay|continue|go|good|thanks|thank you|great|nice|cool|got it)[.!?]?$/.test(lowerMsg);

    if (!isCommand && !isAckOnly) {
      // ─── PHASE 3: Check for stored correction on similar question ──
      try {
        const { findRelevantCorrection } = require("./feedback-loop");
        correctionFound = await findRelevantCorrection(userMessage);
        if (correctionFound) {
          console.log(`[JJ-Mode] 🔧 Found relevant correction (sim ${(correctionFound.similarity * 100).toFixed(0)}%): "${correctionFound.originalQuestion.substring(0, 60)}..."`);
          jjSystemPrompt = jjSystemPrompt +
            "\n\n═════════════════════════════════════════\n" +
            "  JJ'S PRIOR CORRECTION ON SIMILAR QUESTION\n" +
            "═════════════════════════════════════════\n\n" +
            `Original question: "${correctionFound.originalQuestion}"\n\n` +
            `JJ's corrected answer:\n${correctionFound.correction}\n\n` +
            "IMPORTANT: JJ previously corrected an answer on a similar question. Treat his correction as the GOLD STANDARD for how to answer questions in this pattern. Adapt the reasoning to the current specific question, but do not deviate from the analytical framework JJ established.";
        }
      } catch (e) {
        console.log("[JJ-Mode] Correction lookup failed (non-fatal):", e.message);
      }

      // Load weight lookup helper once
      let getWeightMap = null;
      try {
        getWeightMap = require("./feedback-loop").getWeightMap;
      } catch (_) {}

      try {
        const { searchParensHybrid, formatMoatContext } = require("./judge-cross-reference");
        const moatStart = Date.now();
        let results = await searchParensHybrid(userMessage, {
          limit: 30,        // fetch more than we'll use; weighting may re-rank
          minSimilarity: 0.35,
          candidatePoolSize: 3000,
        });
        const moatMs = Date.now() - moatStart;

        // Apply weight boosts if feedback-loop is available
        if (results && results.length && getWeightMap) {
          try {
            const ids = results.map(r => r.id);
            const weights = await getWeightMap("moat", ids);
            for (const r of results) {
              const w = weights.get(r.id);
              if (w !== undefined) {
                r.originalSimilarity = r.similarity;
                r.similarity = r.similarity * w;
                r.weightApplied = w;
              }
            }
            // Re-sort by weighted similarity
            results.sort((a, b) => b.similarity - a.similarity);
          } catch (e) {
            console.log("[JJ-Mode] Weight application failed (non-fatal):", e.message);
          }
        }

        // Take top 15 after weighting
        results = (results || []).slice(0, 15);
        retrievedMoatIds = results.map(r => r.id);

        if (results && results.length) {
          const moatContext = formatMoatContext(results, { maxLength: 4500 });
          jjSystemPrompt = jjSystemPrompt +
            "\n\n" + moatContext +
            "\n\nIMPORTANT: The precedent above comes from Tez Law's proprietary moat — real parentheticals from real 9th Cir, BIA, CA state, and other opinions we've indexed. " +
            "When your answer draws on legal precedent, CITE specific cases by name from this moat. Do NOT fabricate cases. " +
            "If the moat doesn't cover the question, say so and rely on your general legal knowledge, but clearly indicate which claims are moat-backed vs. general knowledge. " +
            "For adjustment-of-status questions, ALWAYS check whether 245(i) grandfathering applies (petition filed on or before April 30, 2001, and physically present Dec 21, 2000). " +
            "For any waiver question, consider ALL alternative paths (245(i), U visa, T visa, VAWA, SIJS, cancellation of removal, humanitarian parole) not just the ones the user named.";
          console.log(`[JJ-Mode] 🎯 Moat: ${results.length} results in ${moatMs}ms, top sim ${(results[0].similarity * 100).toFixed(0)}%`);
        } else {
          console.log(`[JJ-Mode] 🎯 Moat: 0 results (${moatMs}ms) — no relevant precedent found`);
        }
      } catch (e) {
        console.error("[JJ-Mode] Moat search failed (fail-open):", e.message);
      }

      // ─── FIRM DOCUMENTS SEARCH (Phase 2 self-learning) ────
      try {
        const { searchFirmDocs, formatFirmContext } = require("./firm-documents");
        const firmStart = Date.now();
        let firmResults = await searchFirmDocs(userMessage, { limit: 10 });   // fetch more, weight, take top 5
        const firmMs = Date.now() - firmStart;

        // Apply weight boosts
        if (firmResults && firmResults.length && getWeightMap) {
          try {
            const ids = firmResults.map(r => r.id);
            const weights = await getWeightMap("firm", ids);
            for (const r of firmResults) {
              const w = weights.get(r.id);
              if (w !== undefined) {
                r.originalSimilarity = r.similarity;
                r.similarity = r.similarity * w;
                r.weightApplied = w;
              }
            }
            firmResults.sort((a, b) => b.similarity - a.similarity);
          } catch (e) {
            console.log("[JJ-Mode] Firm weight application failed (non-fatal):", e.message);
          }
        }

        firmResults = (firmResults || []).slice(0, 5);
        retrievedFirmIds = firmResults.map(r => r.id);

        if (firmResults && firmResults.length) {
          const firmContext = formatFirmContext(firmResults, { maxLength: 3000 });
          jjSystemPrompt = jjSystemPrompt +
            "\n\n" + firmContext +
            "\n\nIMPORTANT: When drawing on 'FROM OUR FIRM'S WORK' above, phrase it as 'In our firm's prior work on [issue], we argued...' — DO NOT name specific clients, and DO NOT quote unredacted names. " +
            "This material is from PUBLIC filings/publications only. Weight it alongside published precedent, but clearly label firm-sourced insights so JJ knows the provenance.";
          console.log(`[JJ-Mode] 📚 Firm docs: ${firmResults.length} results in ${firmMs}ms, top sim ${(firmResults[0].similarity * 100).toFixed(0)}%`);
        } else {
          console.log(`[JJ-Mode] 📚 Firm docs: 0 results (${firmMs}ms)`);
        }
      } catch (e) {
        console.error("[JJ-Mode] Firm docs search failed (fail-open):", e.message);
      }
    }
  }
  // ─── END MOAT INJECTION ────────────────────────────────────

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
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
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

    // ── PHASE 3: Record the answer for feedback tracking ──
    let answerId = null;
    try {
      const { recordAnswer } = require("./feedback-loop");
      answerId = await recordAnswer({
        chatId: chatIdForFeedback,
        question: userMessage || "",
        answer: reply,
        moatIds: retrievedMoatIds,
        firmDocIds: retrievedFirmIds,
      });
      console.log(`[JJ-Mode] 📝 Recorded answer #${answerId} for feedback (moat:${retrievedMoatIds.length} firm:${retrievedFirmIds.length})`);
    } catch (e) {
      console.log("[JJ-Mode] Answer recording failed (non-fatal):", e.message);
    }

    // Build source hint for JJ's rating context
    let sourceHint = "";
    if (answerId && (retrievedMoatIds.length || retrievedFirmIds.length || correctionFound)) {
      const parts = [];
      if (retrievedMoatIds.length) parts.push(`${retrievedMoatIds.length} moat`);
      if (retrievedFirmIds.length) parts.push(`${retrievedFirmIds.length} firm`);
      if (correctionFound)          parts.push(`prior correction (${(correctionFound.similarity * 100).toFixed(0)}%)`);
      sourceHint = `\n\n_📊 Answer #${answerId} • Sources: ${parts.join(", ")} • Rate with /good /bad /fix_`;
    }

    // ── PHASE E: MESSAGE CHUNKING ─────────────────────────
    // WhatsApp: 4096-char limit. Telegram: 4096. Messenger: 2000.
    // Instead of truncating, split at natural paragraph boundaries
    // and send as multiple messages. Return the first chunk normally;
    // send subsequent chunks async via the sendFn passed into
    // processMessage in askClaude-memory.js.
    const fullMessage = "🔒 [JJ Mode]\n\n" + docNote + reply + sourceHint;
    const CHUNK_LIMIT = platform === "messenger" ? 1900 : 3900;

    if (fullMessage.length <= CHUNK_LIMIT) {
      return { handled: true, message: fullMessage };
    }

    // Multi-message split
    const chunks = splitMessageForPlatform(fullMessage, CHUNK_LIMIT);
    console.log(`[JJ-Mode] 📮 Split ${fullMessage.length} chars into ${chunks.length} messages`);

    // Return first chunk; hand rest to caller via options.sendFn (if provided)
    if (options.sendFn && chunks.length > 1) {
      // Fire subsequent chunks async — small delays so client shows them in order
      (async () => {
        for (let i = 1; i < chunks.length; i++) {
          await new Promise(r => setTimeout(r, 800));
          try {
            await options.sendFn(chunks[i]);
          } catch (e) {
            console.error(`[JJ-Mode] Chunk ${i + 1}/${chunks.length} send failed:`, e.message);
          }
        }
      })();
    }

    return { handled: true, message: chunks[0] };
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

// ── PHASE E: Message chunking helper ─────────────────────
// Splits a long message into platform-safe chunks at natural
// boundaries (paragraph > sentence > word > hard cut).
// Prepends "(N/M)" continuation markers to help readers.
function splitMessageForPlatform(text, limit = 3900) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Prefer double-newline (paragraph) breaks
    let cutAt = remaining.lastIndexOf("\n\n", limit);
    // Fall back to single newline
    if (cutAt < limit * 0.5) cutAt = remaining.lastIndexOf("\n", limit);
    // Fall back to sentence end
    if (cutAt < limit * 0.5) {
      const sentenceEnd = remaining.substring(0, limit).lastIndexOf(". ");
      if (sentenceEnd >= limit * 0.5) cutAt = sentenceEnd + 1;
    }
    // Fall back to word boundary
    if (cutAt < limit * 0.5) cutAt = remaining.lastIndexOf(" ", limit);
    // Absolute fallback: hard cut
    if (cutAt < limit * 0.5) cutAt = limit;

    chunks.push(remaining.substring(0, cutAt).trim());
    remaining = remaining.substring(cutAt).trim();
  }

  // Prepend continuation markers "(N/M)" to chunks 2..N
  if (chunks.length > 1) {
    return chunks.map((c, i) =>
      i === 0 ? c : `(${i + 1}/${chunks.length}) ${c}`
    );
  }
  return chunks;
}

module.exports = {
  checkJJMode,
  isJJAuthenticated,
  isJJAuthenticatedAsync,
  getJJPublicContext,
  isResearchRequest,
  splitMessageForPlatform,
};
