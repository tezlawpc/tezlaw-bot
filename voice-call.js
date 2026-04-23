// ============================================================
//  voice-call.js — Zara Voice AI (Court Clerk Priority)
//  Twilio Gather STT + Claude Haiku + ElevenLabs Flash
//  Special handling for court clerk calls
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

function clearSession(callSid) { sessions.delete(callSid); }

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

// ── Claude AI response (HAIKU + short max_tokens = FASTEST) ──
async function askClaude(systemPrompt, conversation) {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 80,
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

// ── Pre-cached greetings ──────────────────────────────────
const GREETING_OPEN  = "Hi, thank you for calling TEZ Law Firm, this is Zara speaking. How may I help you?";
const GREETING_CLOSED = "Hi, thank you for calling TEZ Law Firm, this is Zara speaking. Our office is currently closed, but I can take a message and have our team call you back next business day. How may I help you?";

let greetingReady = false;
async function initGreetings() {
  try {
    console.log("[voice] Pre-generating greeting audio...");
    const openAudio = await elevenLabsTTS(GREETING_OPEN);
    storeAudio("greeting_open", openAudio, true);
    const closedAudio = await elevenLabsTTS(GREETING_CLOSED);
    storeAudio("greeting_closed", closedAudio, true);
    greetingReady = true;
    console.log("[voice] Greetings pre-cached successfully");
  } catch (err) {
    console.error("[voice] Greeting pre-cache failed (will fallback to Polly):", err.message);
  }
}
initGreetings();

// ── Build TwiML — Gather for caller speech ────────────────
function buildPlayAndGatherTwiML(audioUrl, action) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" action="${action}" method="POST"
          language="en-US"
          speechTimeout="1"
          timeout="5"
          profanityFilter="false"
          actionOnEmptyResult="true"
          hints="court clerk, superior court, case number, hearing, docket, judge, Zhang, immigration, green card, visa, USCIS, deportation, accident, injury, crash, eviction, landlord, tenant, estate, will, trust, business, lawsuit, callback">
  </Gather>
  <Redirect method="POST">${action}</Redirect>
</Response>`;
}

function buildGatherOnly(action) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST"
          language="en-US"
          speechTimeout="1"
          timeout="5"
          profanityFilter="false"
          actionOnEmptyResult="true">
  </Gather>
  <Redirect method="POST">${action}</Redirect>
</Response>`;
}

function buildPlayTwiML(audioUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Hangup/>
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
    ? "\n\nIMPORTANT: It is currently after office hours (Mon-Fri 9am-5pm PT). Let the caller know their info will be passed to the team and they'll hear back next business day."
    : "";

  const courtProtocol = isCourtClerkCall ? `

============================
COURT CLERK PROTOCOL — HIGHEST PRIORITY
============================
This caller is a COURT CLERK or court personnel. Handle with extreme respect and efficiency.
Do NOT discuss legal matters, give advice, or engage in small talk. Be brief and professional.

Your mission, in order (one question per turn):
1. If you don't already have it, get the CASE NUMBER (ask them to state it slowly and clearly, including letters).
2. Get the COURT NAME and DEPARTMENT if applicable.
3. Get the BEST CALLBACK NUMBER.
4. Ask if there is a SPECIFIC MESSAGE or DEADLINE.
5. Close with: "Thank you — I'm alerting Attorney Zhang right now. He will call you back as soon as possible."

Keep every turn to 1 SHORT sentence. Do not ramble. Do not offer legal information.` : "";

  return (savedPrompt || "") + `

============================
VOICE CALL — CRITICAL RULES
============================
You are Zara answering a PHONE CALL for Tez Law P.C. Keep ALL responses to 1-2 SHORT sentences.
Under 25 words. No bullet points. No lists. Speak like a warm receptionist.

GOAL: Briefly help, then collect name, brief description of issue, and callback number (one at a time).

If URGENT (ICE, detained, accident just happened, court today): say exactly:
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

  // Case number extraction — multiple common formats
  if (!intake.caseNumber) {
    const patterns = [
      /\b(\d{2}[A-Z]{2,6}\d{4,8})\b/,                      // 22STCV12345, 23CMCV00123
      /\b([A-Z]{1,3}\d{5,8})\b/,                           // BC123456, SC123456, VA123456
      /\b(\d{1,2}:\d{2}-[A-Za-z]{2}-\d{4,6})\b/,           // federal 2:24-cv-00123
      /\bcase\s+(?:number|no\.?|#)[\s:]*([\w\-]{4,20})\b/i, // "case number 22STCV12345"
      /\bdocket\s+(?:number|no\.?|#)?[\s:]*([\w\-]{4,20})\b/i, // "docket number XYZ"
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) { intake.caseNumber = m[1].trim(); break; }
    }
  }

  // Court name
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
    }).catch(e => console.error("[voice] Court clerk alert Telegram error:", e.message));
  }
  console.log(`[voice] 🚨 COURT CLERK ALERT sent to ${targets.length} recipient(s)`);
}

// ── Send post-call summary to Telegram ───────────────────
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

  if (greetingReady && audioCache.has(greetingKey)) {
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
          language="en-US" speechTimeout="1" timeout="5"
          profanityFilter="false" actionOnEmptyResult="true">
  </Gather>
  <Redirect method="POST">${base}/voice/respond</Redirect>
</Response>`);
    console.log("[voice] Greeting served via Polly (ElevenLabs cache not ready)");
  }
}

async function handleRespond(req, res) {
  const callSid = req.body?.CallSid || "unknown";
  const base    = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  const session = getSession(callSid);

  const speechText = (req.body?.SpeechResult || "").trim();
  const confidence = parseFloat(req.body?.Confidence || "0");
  console.log(`[voice] Speech received (confidence=${confidence}): "${speechText}"`);

  if (!speechText) {
    return res.type("text/xml").send(buildGatherOnly(`${base}/voice/respond`));
  }

  // Low confidence — ask to repeat
  if (confidence > 0 && confidence < 0.35 && session.conversation.length > 0) {
    try {
      const msg = "Sorry, could you repeat that?";
      const audio = await elevenLabsTTS(msg);
      const id = `reprompt_${Date.now()}`;
      storeAudio(id, audio);
      return res.type("text/xml").send(buildPlayAndGatherTwiML(`${base}/voice/audio/${id}`, `${base}/voice/respond`));
    } catch {
      return res.type("text/xml").send(buildGatherOnly(`${base}/voice/respond`));
    }
  }

  session.transcript.push(`Caller: ${speechText}`);
  extractIntake(speechText, session.intake);

  // ── COURT CLERK DETECTION ────────────────────────────
  // Check if this turn OR any prior turn mentions court clerk keywords
  if (!session.isCourtClerk) {
    const fullContext = session.transcript.join(" ");
    if (isCourtClerk(speechText) || isCourtClerk(fullContext)) {
      session.isCourtClerk = true;
      session.intake.caseType = "⚖️ COURT CLERK CALL";
      console.log(`[voice] 🚨 COURT CLERK DETECTED on call ${callSid}`);
    }
  }

  // Fire immediate alert once we have minimum info (case# OR callback OR 2+ exchanges)
  if (session.isCourtClerk && !session.courtAlertSent) {
    const hasUsefulInfo = session.intake.caseNumber || session.intake.callback || session.transcript.length >= 3;
    if (hasUsefulInfo) {
      session.courtAlertSent = true;
      // Fire and forget (don't block the response)
      notifyCourtClerkAlert({
        from: session.from,
        transcript: session.transcript.join("\n"),
        intake: session.intake,
        callSid,
      }).catch(() => {});
    }
  }

  try {
    // Urgent (legal emergency, not court clerk) → transfer to JJ
    if (isUrgent(speechText) && !session.transferred && !session.isCourtClerk) {
      session.transferred = true;
      const msg = "This sounds urgent — please hold while I connect you with Attorney Zhang.";
      const audio = await elevenLabsTTS(msg);
      const id = `transfer_${Date.now()}`;
      storeAudio(id, audio);
      session.transcript.push(`Zara: ${msg}`);
      notifyCallSummary({ from: session.from, transcript: session.transcript.join("\n"), intake: session.intake, transferred: true, isCourtClerkCall: false });
      saveCallIntake(session.from, session.intake);
      return res.type("text/xml").send(buildTransferTwiML(`${base}/voice/audio/${id}`));
    }

    // Claude response (with court clerk prompt if applicable)
    session.conversation.push({ role: "user", content: speechText });
    const systemPrompt = buildVoicePrompt(session.savedPrompt, session.isCourtClerk);
    const aiReply = await askClaude(systemPrompt, session.conversation);
    console.log(`[voice] Zara reply: "${aiReply.substring(0, 80)}"`);

    if (aiReply.includes("TRANSFER_NOW") && !session.transferred) {
      session.transferred = true;
      const cleanReply = aiReply.replace("TRANSFER_NOW", "").trim() || "Please hold while I connect you.";
      const audio = await elevenLabsTTS(cleanReply);
      const id = `transfer_${Date.now()}`;
      storeAudio(id, audio);
      session.transcript.push(`Zara: ${cleanReply}`);
      notifyCallSummary({ from: session.from, transcript: session.transcript.join("\n"), intake: session.intake, transferred: true, isCourtClerkCall: session.isCourtClerk });
      saveCallIntake(session.from, session.intake);
      return res.type("text/xml").send(buildTransferTwiML(`${base}/voice/audio/${id}`));
    }

    session.conversation.push({ role: "assistant", content: aiReply });
    session.transcript.push(`Zara: ${aiReply}`);

    const audio = await elevenLabsTTS(aiReply);
    const id = `reply_${callSid}_${Date.now()}`;
    storeAudio(id, audio);

    res.type("text/xml").send(buildPlayAndGatherTwiML(`${base}/voice/audio/${id}`, `${base}/voice/respond`));
  } catch (err) {
    console.error("[voice] handleRespond error:", err.message);
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">I'm having a technical issue. Please call us back at 626-678-8677. Goodbye.</Say></Response>`);
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
