// ============================================================
//  voice-call.js — Zara Voice AI (Max Speed + Thinking Sound)
//  Twilio Gather STT + Claude Haiku + ElevenLabs Flash + Court Clerk Priority
//  "Okay, give me one second" plays instantly while reply generates in background
// ============================================================

const axios = require("axios");

// ── Business hours (Pacific Time) ────────────────────────
function isBusinessHours() {
  const now = new Date();
  const pt  = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return pt.getDay() >= 1 && pt.getDay() <= 5 && pt.getHours() >= 9 && pt.getHours() < 17;
}

// ── Urgent keywords → transfer to JJ ─────────────────────
function isUrgent(text) {
  return /\b(ice|detained|arrest|deport|court today|court tomorrow|accident just|just happened|emergency|injured badly|in jail|in custody|scared|please help now)\b/i.test(text);
}

// ── Court clerk detection ─────────────────────────────────
function isCourtClerk(text) {
  return /\b(court clerk|clerk of (the )?court|clerk'?s office|calling from (the )?court|superior court|courthouse|judge'?s chambers|district court|federal court|court of appeals|municipal court|calling regarding (the )?case|case manager|court reporter|bailiff|probation officer|court administrator|calling on behalf of (the )?judge|this is .{0,40}(court|clerk))\b/i.test(text);
}

// ── In-memory call sessions ───────────────────────────────
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      conversation: [],
      transcript:   [],
      intake:       { name: null, issue: null, callback: null, caseType: null, caseNumber: null, courtName: null },
      transferred:  false,
      isCourtClerk: false,
      courtAlertSent: false,
    });
  }
  return sessions.get(callSid);
}

function clearSession(callSid) {
  sessions.delete(callSid);
  pendingReplies.delete(callSid);
}

// ── Background work queue (for "thinking sound" pattern) ──
const pendingReplies = new Map();

// ── ElevenLabs TTS → returns mp3 Buffer (FLASH = ~40ms first byte) ──
async function elevenLabsTTS(text) {
  const key   = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");

  console.log("[voice] ElevenLabs TTS:", text.substring(0, 80));
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
    {
      text,
      model_id: "eleven_flash_v2_5",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: { "xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      responseType: "arraybuffer",
      validateStatus: (s) => s < 500,
    }
  );

  if (res.status !== 200) {
    const errText = Buffer.from(res.data).toString("utf8");
    console.error("[voice] ElevenLabs API error", res.status, errText.substring(0, 200));
    throw new Error(`ElevenLabs ${res.status}: ${errText.substring(0, 100)}`);
  }

  const buf = Buffer.from(res.data);
  console.log("[voice] ElevenLabs audio:", buf.length, "bytes");
  if (buf.length < 1000) {
    throw new Error("ElevenLabs returned invalid audio: " + buf.toString("utf8").substring(0, 100));
  }
  return buf;
}

// ── Claude AI response (HAIKU + tight max_tokens = FASTEST) ──
async function askClaude(systemPrompt, conversation) {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 60,
      system:     systemPrompt,
      messages:   conversation,
    },
    {
      headers: {
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
      },
    }
  );
  return res.data.content[0]?.text || "";
}

// ── Serve audio file ──────────────────────────────────────
const audioCache = new Map();
function storeAudio(id, buffer, persistent = false) {
  audioCache.set(id, { buffer, created: Date.now(), persistent });
  if (!persistent) {
    setTimeout(() => audioCache.delete(id), 5 * 60 * 1000);
  }
}
function serveAudio(req, res) {
  const { id } = req.params;
  const entry = audioCache.get(id);
  if (!entry) return res.status(404).send("Not found");
  res.set("Content-Type", "audio/mpeg");
  res.set("Content-Length", entry.buffer.length);
  res.send(entry.buffer);
}

// ── Pre-cached audio (generated once at server startup) ──
const GREETING_OPEN   = "Thank you for calling Tez Law Firm. My name is Zara, and I'm here to help. How can I help you today?";
const GREETING_CLOSED = "Thank you for calling Tez Law Firm. My name is Zara. Our office is currently closed. But I can still assist you. How can I help you?";
const THINKING_TEXT   = "Okay, give me one second.";
const REPROMPT_TEXT   = "Sorry, could you repeat that?";

let cacheReady = false;
async function initAudioCache() {
  try {
    console.log("[voice] Pre-generating audio cache...");
    const openAudio     = await elevenLabsTTS(GREETING_OPEN);     storeAudio("greeting_open", openAudio, true);
    const closedAudio   = await elevenLabsTTS(GREETING_CLOSED);   storeAudio("greeting_closed", closedAudio, true);
    const thinkingAudio = await elevenLabsTTS(THINKING_TEXT);     storeAudio("thinking", thinkingAudio, true);
    const repromptAudio = await elevenLabsTTS(REPROMPT_TEXT);     storeAudio("reprompt", repromptAudio, true);
    cacheReady = true;
    console.log("[voice] Audio cache ready (greetings + thinking + reprompt)");
  } catch (err) {
    console.error("[voice] Pre-cache failed (will fallback to Polly):", err.message);
  }
}
initAudioCache();

// ── Build TwiML ───────────────────────────────────────────
function buildPlayAndGatherTwiML(audioUrl, action) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" action="${action}" method="POST"
          language="en-US"
          speechTimeout="0.5"
          timeout="5"
          profanityFilter="false"
          actionOnEmptyResult="true"
          hints="court clerk, superior court, case number, hearing, docket, judge, Zhang, immigration, green card, visa, USCIS, deportation, accident, injury, eviction, landlord, tenant, estate, will, trust, business, lawsuit, callback">
  </Gather>
  <Redirect method="POST">${action}</Redirect>
</Response>`;
}

function buildGatherOnly(action) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST"
          language="en-US"
          speechTimeout="0.5"
          timeout="5"
          profanityFilter="false"
          actionOnEmptyResult="true">
  </Gather>
  <Redirect method="POST">${action}</Redirect>
</Response>`;
}

function buildThinkingTwiML(thinkingUrl, continueUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${thinkingUrl}</Play>
  <Redirect method="POST">${continueUrl}</Redirect>
</Response>`;
}

function buildTransferTwiML(audioUrl) {
  const JJ = process.env.JJ_PHONE || "6266788677";
  const base = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Dial timeout="30" action="${base}/voice/transfer-fallback">
    <Number>${JJ}</Number>
  </Dial>
</Response>`;
}

// ── Voice system prompt ───────────────────────────────────
function buildVoicePrompt(savedPrompt, isCourtClerkCall) {
  const afterHours = !isBusinessHours()
    ? "\n\nAFTER HOURS: The office is currently closed (Mon-Fri 9am-5pm PT). You can still fully assist the caller. Do NOT tell them to call back or that no one is available. Help them as normal, collect their name and callback number, and let them know the team will follow up."
    : "";

  const courtProtocol = isCourtClerkCall ? `

============================
COURT CLERK PROTOCOL — HIGHEST PRIORITY
============================
This caller is a COURT CLERK or government representative. Be brief, formal, and professional. No legal chit-chat.

Collect in order (ONE question per turn):
1. Case number (ask them to state it slowly, letter by letter if needed).
2. Court name and department.
3. Best callback number.
4. Any specific message, deadline, or urgency.
5. Then say exactly: "Thank you — I'm alerting Attorney Zhang right now. He will call you back as soon as possible."

ONE sentence only. Under 15 words. Do not discuss the case or speak on the attorney's behalf.` : "";

  return (savedPrompt || "") + `

============================
VOICE CALL — IDENTITY & RULES
============================
You are Zara, the AI phone intake assistant for Tez Law P.C. in West Covina, California. You are warm, calm, and professional.

HARD LIMIT: ONE short sentence per reply. Under 20 words. No exceptions.
No bullet points. No lists. Speak like a warm, human receptionist.

LANGUAGES: You speak English and Mandarin Chinese. If the caller speaks Mandarin or Chinese, switch fully into Mandarin and stay in it for the entire call. Do not mix languages mid-sentence.

GOAL: Listen, qualify, and route. Collect name, brief issue, and callback number — one question at a time.

PRACTICE AREAS: Immigration (visas, green cards, asylum, DACA, removal defense, naturalization), personal injury and car accidents, business litigation, landlord and tenant evictions, estate planning including wills and trusts, trademarks and patents.
The firm does NOT handle criminal defense, family law, or bankruptcy — refer those callers to the State Bar of California.

GUARDRAILS:
- Never give legal advice or predict outcomes, fees, or timelines.
- Never quote specific fees — say the attorney will go over fees during consultation.
- Keep all immigration information strictly confidential.
- If asked whether you are AI, answer honestly and briefly, then move on.
- Never speak on behalf of the attorney regarding any pending case or deadline.

COURT AND GOVERNMENT CALLERS: If the caller identifies as a clerk, officer, or representative from any court or government agency — state court, federal court, immigration court, EOIR, USCIS, ICE, CBP, IRS, or any other body — treat it as highest priority. Do not discuss any case. Collect their information only and confirm attorney callback.

If URGENT (ICE, detained, arrest, deportation, court today, serious accident, emergency): say exactly:
"This sounds urgent — please hold while I connect you with Attorney Zhang."
Then say ONLY: TRANSFER_NOW

Never mention you are AI unless asked directly.${courtProtocol}${afterHours}`;
}

// ── Extract intake from speech ────────────────────────────
function extractIntake(text, intake) {
  if (!intake.name) {
    const m = text.match(/(?:my name is|i(?:'m| am)|this is)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/i);
    if (m) intake.name = m[1].trim();
  }
  if (!intake.callback) {
    const m = text.match(/\b(\+?1?\s?[\(\-]?\d{3}[\)\-\s]?\s?\d{3}[\-\s]?\d{4})\b/);
    if (m) intake.callback = m[1].replace(/\D/g, "");
  }
  if (!intake.caseNumber) {
    const patterns = [
      /\b(\d{2}[A-Z]{2,6}\d{4,8})\b/,
      /\b([A-Z]{1,3}\d{5,8})\b/,
      /\b(\d{1,2}:\d{2}-[A-Za-z]{2}-\d{4,6})\b/,
      /\bcase\s+(?:number|no\.?|#)[\s:]*([\w\-]{4,20})\b/i,
      /\bdocket\s+(?:number|no\.?|#)?[\s:]*([\w\-]{4,20})\b/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) { intake.caseNumber = m[1].trim(); break; }
    }
  }
  if (!intake.courtName) {
    const m = text.match(/\b([A-Za-z\s]{3,40}(?:superior court|district court|court of appeals|supreme court|municipal court|federal court|courthouse))\b/i);
    if (m) intake.courtName = m[1].trim().replace(/\s+/g, " ");
  }
  if (!intake.caseType) {
    if (isCourtClerk(text))                                                intake.caseType = "⚖️ COURT CLERK CALL";
    else if (/visa|green card|immigration|uscis|daca|deportation/i.test(text))  intake.caseType = "Immigration";
    else if (/accident|injury|crash/i.test(text))                          intake.caseType = "Car Accident / Personal Injury";
    else if (/evict|landlord|tenant|rent/i.test(text))                     intake.caseType = "Landlord / Tenant";
    else if (/will|trust|estate|probate/i.test(text))                      intake.caseType = "Estate Planning";
    else if (/contract|lawsuit|sued|business/i.test(text))                 intake.caseType = "Business Litigation";
  }
  if (!intake.issue && text.length > 20) intake.issue = text.substring(0, 200);
}

// ── 🚨 IMMEDIATE court clerk alert to JJ ────────────────
async function notifyCourtClerkAlert({ from, transcript, intake, callSid }) {
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID, TEAM_TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_TOKEN) return;

  const text = `🚨🚨🚨 COURT CLERK CALLING — URGENT 🚨🚨🚨

⚖️ Court: ${intake.courtName || "Not captured yet"}
📋 Case #: ${intake.caseNumber || "Not captured yet"}
📞 Clerk callback: ${intake.callback || "Not yet given"}
📱 Caller ID: ${from}
🆔 CallSid: ${callSid || "n/a"}

📝 What they said so far:
${transcript.slice(-1500) || "(call just started)"}

⚡ JJ — please call this clerk back ASAP.`;

  const targets = [JJ_TELEGRAM_ID, TEAM_TELEGRAM_CHAT_ID].filter(Boolean);
  for (const chat_id of targets) {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id,
      text: text.substring(0, 4000),
    }).catch(e => console.error("[voice] Court clerk alert error:", e.message));
  }
  console.log(`[voice] 🚨 COURT CLERK ALERT sent to ${targets.length} recipient(s)`);
}

// ── Post-call summary ────────────────────────────────────
async function notifyCallSummary({ from, transcript, intake, transferred, isCourtClerkCall }) {
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID, TEAM_TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_TOKEN) return;

  const header = isCourtClerkCall
    ? `🚨 COURT CLERK CALL ENDED — FULL SUMMARY 🚨`
    : `📞 VOICE CALL — TEZ LAW P.C.`;

  const courtBlock = isCourtClerkCall
    ? `\n⚖️ Court: ${intake.courtName || "Not captured"}\n📋 Case #: ${intake.caseNumber || "Not captured"}\n`
    : "";

  const intakeText = (intake.name || intake.callback || intake.caseType)
    ? `\n👤 Name: ${intake.name || "Not captured"}\n⚖️ Issue: ${intake.issue || intake.caseType || "Not specified"}\n📞 Callback: ${intake.callback || from}`
    : "\n(No intake collected)";

  const text = `${header}\n\n📱 Caller: ${from}\n${transferred ? "🔀 Transferred to JJ\n" : ""}${courtBlock}${intakeText}\n\n📝 Full transcript:\n${transcript.slice(-2000) || "(empty)"}`;

  const targets = [JJ_TELEGRAM_ID, TEAM_TELEGRAM_CHAT_ID].filter(Boolean);
  for (const chat_id of targets) {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id,
      text: text.substring(0, 4000),
    }).catch(e => console.error("[voice] Telegram notify error:", e.message));
  }
  console.log("[voice] Call summary sent to Telegram:", targets.length, "recipient(s)");
}

// ── Save intake to DB ─────────────────────────────────────
async function saveCallIntake(from, intake) {
  if (!intake.name && !intake.callback && !intake.caseNumber) return;
  try {
    const db = require("./db");
    const uid = `phone_${from}`;
    const issueFull = [
      intake.caseNumber ? `Case#: ${intake.caseNumber}` : null,
      intake.courtName ? `Court: ${intake.courtName}` : null,
      intake.issue,
    ].filter(Boolean).join(" | ") || "Phone inquiry";

    await db.saveIntake("phone", uid, {
      name: intake.name || "Voice Caller",
      issue: issueFull,
      contact: intake.callback || from,
      case_type: intake.caseType || "General Legal",
    });
    if (intake.name && intake.callback) {
      await db.createLead({
        platform: "phone", platformId: uid,
        name: intake.name, contact: intake.callback,
        caseType: intake.caseType || "General Legal",
      });
    }
  } catch (e) { console.error("[voice] saveCallIntake error:", e.message); }
}

// ── Generate reply in background (runs during thinking sound) ──
async function generateReply(session, speechText) {
  // Urgent — transfer to JJ (no Claude call needed)
  if (isUrgent(speechText) && !session.transferred && !session.isCourtClerk) {
    const msg = "This sounds urgent — please hold while I connect you with Attorney Zhang.";
    const audio = await elevenLabsTTS(msg);
    const id = `transfer_${Date.now()}`;
    storeAudio(id, audio);
    session.transcript.push(`Zara: ${msg}`);
    session.transferred = true;
    return { audioId: id, transfer: true };
  }

  // Claude response
  session.conversation.push({ role: "user", content: speechText });
  const systemPrompt = buildVoicePrompt(session.savedPrompt, session.isCourtClerk);
  const aiReply = await askClaude(systemPrompt, session.conversation);
  console.log(`[voice] Zara reply: "${aiReply.substring(0, 80)}"`);

  // Claude requested transfer
  if (aiReply.includes("TRANSFER_NOW") && !session.transferred) {
    session.transferred = true;
    const cleanReply = aiReply.replace("TRANSFER_NOW", "").trim() || "Please hold while I connect you.";
    const audio = await elevenLabsTTS(cleanReply);
    const id = `transfer_${Date.now()}`;
    storeAudio(id, audio);
    session.transcript.push(`Zara: ${cleanReply}`);
    return { audioId: id, transfer: true };
  }

  session.conversation.push({ role: "assistant", content: aiReply });
  session.transcript.push(`Zara: ${aiReply}`);

  const audio = await elevenLabsTTS(aiReply);
  const id = `reply_${Date.now()}`;
  storeAudio(id, audio);
  return { audioId: id, transfer: false };
}

// ════════════════════════════════════════════════════════
//  ROUTE HANDLERS
// ════════════════════════════════════════════════════════

async function handleIncomingCall(req, res, savedPrompt) {
  const callSid = req.body?.CallSid || "unknown";
  const from    = req.body?.From   || "unknown";
  const base    = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  console.log(`[voice] Incoming call SID=${callSid} from=${from}`);

  const afterHours = !isBusinessHours();
  const greetingText = afterHours ? GREETING_CLOSED : GREETING_OPEN;
  const greetingKey  = afterHours ? "greeting_closed" : "greeting_open";

  const session = getSession(callSid);
  session.conversation.push({ role: "assistant", content: greetingText });
  session.transcript.push(`Zara: ${greetingText}`);
  session.from = from;
  session.savedPrompt = savedPrompt;

  if (cacheReady && audioCache.has(greetingKey)) {
    res.type("text/xml").send(buildPlayAndGatherTwiML(
      `${base}/voice/audio/${greetingKey}`,
      `${base}/voice/respond`
    ));
    console.log("[voice] Greeting served from cache (ElevenLabs)");
  } else {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${greetingText}</Say>
  <Gather input="speech" action="${base}/voice/respond" method="POST"
          language="en-US" speechTimeout="0.5" timeout="5"
          profanityFilter="false" actionOnEmptyResult="true">
  </Gather>
  <Redirect method="POST">${base}/voice/respond</Redirect>
</Response>`);
    console.log("[voice] Greeting served via Polly (cache not ready)");
  }
}

async function handleRespond(req, res) {
  const callSid = req.body?.CallSid || "unknown";
  const base    = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  const session = getSession(callSid);

  const speechText = (req.body?.SpeechResult || "").trim();
  const confidence = parseFloat(req.body?.Confidence || "0");

  // ═══ CONTINUE PHASE ═══
  // No speech in this request + pending reply exists → return the real reply
  if (!speechText && pendingReplies.has(callSid)) {
    const pending = pendingReplies.get(callSid);
    pendingReplies.delete(callSid);
    try {
      const result = await pending;
      if (result.transfer) {
        notifyCallSummary({ from: session.from, transcript: session.transcript.join("\n"), intake: session.intake, transferred: true, isCourtClerkCall: session.isCourtClerk });
        saveCallIntake(session.from, session.intake);
        return res.type("text/xml").send(buildTransferTwiML(`${base}/voice/audio/${result.audioId}`));
      }
      return res.type("text/xml").send(buildPlayAndGatherTwiML(`${base}/voice/audio/${result.audioId}`, `${base}/voice/respond`));
    } catch (err) {
      console.error("[voice] Reply generation failed:", err.message);
      return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">I'm having a technical issue. Please call us back. Goodbye.</Say></Response>`);
    }
  }

  // ═══ SILENCE ═══
  // No speech + no pending → caller is silent, gather again
  if (!speechText) {
    return res.type("text/xml").send(buildGatherOnly(`${base}/voice/respond`));
  }

  console.log(`[voice] Speech received (confidence=${confidence}): "${speechText}"`);

  // ═══ LOW CONFIDENCE ═══
  // Use pre-cached "Sorry, could you repeat that?" — instant
  if (confidence > 0 && confidence < 0.35 && session.conversation.length > 0) {
    if (cacheReady && audioCache.has("reprompt")) {
      return res.type("text/xml").send(buildPlayAndGatherTwiML(`${base}/voice/audio/reprompt`, `${base}/voice/respond`));
    }
    return res.type("text/xml").send(buildGatherOnly(`${base}/voice/respond`));
  }

  // ═══ NEW TURN — real speech received ═══
  session.transcript.push(`Caller: ${speechText}`);
  extractIntake(speechText, session.intake);

  // Court clerk detection
  if (!session.isCourtClerk) {
    const fullContext = session.transcript.join(" ");
    if (isCourtClerk(speechText) || isCourtClerk(fullContext)) {
      session.isCourtClerk = true;
      session.intake.caseType = "⚖️ COURT CLERK CALL";
      console.log(`[voice] 🚨 COURT CLERK DETECTED on call ${callSid}`);
    }
  }

  // Fire immediate court clerk alert (non-blocking)
  if (session.isCourtClerk && !session.courtAlertSent) {
    const hasUsefulInfo = session.intake.caseNumber || session.intake.callback || session.transcript.length >= 3;
    if (hasUsefulInfo) {
      session.courtAlertSent = true;
      notifyCourtClerkAlert({
        from: session.from,
        transcript: session.transcript.join("\n"),
        intake: session.intake,
        callSid,
      }).catch(() => {});
    }
  }

  // ═══ KICK OFF REPLY IN BACKGROUND + PLAY THINKING SOUND ═══
  // Start generating reply now — it runs while thinking sound plays
  const replyPromise = generateReply(session, speechText).catch(err => {
    console.error("[voice] generateReply error:", err.message);
    throw err;
  });
  pendingReplies.set(callSid, replyPromise);

  // Immediately play "Okay, give me one second" — caller hears response NOW
  const thinkingUrl = (cacheReady && audioCache.has("thinking"))
    ? `${base}/voice/audio/thinking`
    : null;

  if (thinkingUrl) {
    res.type("text/xml").send(buildThinkingTwiML(thinkingUrl, `${base}/voice/respond`));
    console.log("[voice] Thinking sound playing while reply generates...");
  } else {
    // Fallback: Polly "okay, give me one second"
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Okay, give me one second.</Say>
  <Redirect method="POST">${base}/voice/respond</Redirect>
</Response>`);
  }
}

async function handleCallStatus(req, res) {
  res.sendStatus(200);
  const { CallSid, CallStatus, From } = req.body || {};
  console.log(`[voice] Call status: SID=${CallSid} status=${CallStatus}`);
  if (["completed","no-answer","failed","busy","canceled"].includes(CallStatus)) {
    const session = sessions.get(CallSid);
    if (session) {
      await notifyCallSummary({
        from: session.from || From,
        transcript: session.transcript.join("\n"),
        intake: session.intake,
        transferred: session.transferred,
        isCourtClerkCall: session.isCourtClerk,
      });
      await saveCallIntake(session.from || From, session.intake);
      clearSession(CallSid);
    } else {
      console.log(`[voice] No session found for ${CallSid}`);
    }
  }
}

function handleAudio(req, res) { serveAudio(req, res); }

function handleTransfer(req, res) {
  const JJ = process.env.JJ_PHONE || "6266788677";
  const base = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Please hold while I connect you with Attorney Zhang.</Say>
  <Dial timeout="30" action="${base}/voice/transfer-fallback">
    <Number>${JJ}</Number>
  </Dial>
</Response>`);
}

function handleTransferFallback(req, res) {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">I'm sorry, Attorney Zhang is unavailable. Please leave your name and number after the tone and he will call you back shortly.</Say>
  <Record maxLength="120" transcribeCallback="/voice/transcribe"/>
  <Say voice="Polly.Joanna-Neural">Thank you. We will be in touch shortly. Goodbye.</Say>
</Response>`);
}

async function handleTranscription(req, res) {
  res.sendStatus(200);
  const { TranscriptionText, From } = req.body || {};
  if (!TranscriptionText) return;
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID } = process.env;
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return;
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: JJ_TELEGRAM_ID,
    text: `📨 VOICEMAIL — TEZ LAW P.C.\n\n📱 From: ${From || "unknown"}\n\n📝 Message:\n${TranscriptionText}`,
  }).catch(() => {});
}

module.exports = {
  handleIncomingCall,
  handleRespond,
  handleCallStatus,
  handleAudio,
  handleTransfer,
  handleTransferFallback,
  handleTranscription,
};
