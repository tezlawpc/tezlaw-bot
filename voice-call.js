// ============================================================
//  voice-call.js — Zara Voice AI
//  Twilio (phone) + Deepgram (STT) + Claude (AI) + ElevenLabs (TTS)
//
//  Architecture (no media streaming — avoids audio encoding issues):
//  1. Caller dials → POST /voice/incoming → Zara greets with <Play>
//  2. Caller speaks → Twilio records speech → POST /voice/respond
//  3. Server: Deepgram transcribes → Claude replies → ElevenLabs speaks
//  4. Twilio plays audio → gather next speech → loop
// ============================================================

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

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

// ── In-memory call sessions ───────────────────────────────
const sessions = new Map();

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      conversation: [],
      transcript:   [],
      intake:       { name: null, issue: null, callback: null, caseType: null },
      transferred:  false,
    });
  }
  return sessions.get(callSid);
}

function clearSession(callSid) {
  sessions.delete(callSid);
}

// ── ElevenLabs TTS → returns mp3 Buffer ──────────────────
async function elevenLabsTTS(text) {
  const key   = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");

  console.log("[voice] ElevenLabs TTS:", text.substring(0, 80));
  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
    {
      text,
      model_id: "eleven_turbo_v2_5",  // Fastest ElevenLabs model ~75ms
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    },
    {
      headers: {
        "xi-api-key":   key,
        "Content-Type": "application/json",
        "Accept":       "audio/mpeg",
      },
      responseType: "arraybuffer",
    }
  );
  console.log("[voice] ElevenLabs audio:", res.data.byteLength, "bytes");
  return Buffer.from(res.data);
}

// ── Deepgram STT — transcribe audio URL ──────────────────
async function deepgramTranscribe(audioUrl) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY not set");

  const res = await axios.post(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true",
    { url: audioUrl },
    { headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" } }
  );
  const transcript = res.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  console.log("[voice] Deepgram transcript:", transcript);
  return transcript;
}

// ── Claude AI response ────────────────────────────────────
async function askClaude(systemPrompt, conversation) {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 150,
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
// We save mp3 to /tmp and serve it via /voice/audio/:id
const audioCache = new Map();

function storeAudio(id, buffer) {
  audioCache.set(id, { buffer, created: Date.now() });
  // Clean up old audio after 5 min
  setTimeout(() => audioCache.delete(id), 5 * 60 * 1000);
}

function serveAudio(req, res) {
  const { id } = req.params;
  const entry = audioCache.get(id);
  if (!entry) return res.status(404).send("Not found");
  res.set("Content-Type", "audio/mpeg");
  res.set("Content-Length", entry.buffer.length);
  res.send(entry.buffer);
}

// ── Build TwiML to play audio and gather speech ───────────
function buildGatherTwiML(audioUrl, action) {
  // Play audio first, then Record caller speech
  // Using Record instead of Gather - more reliable, uses Deepgram for transcription
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Record action="${action}" method="POST"
    maxLength="30"
    timeout="5"
    playBeep="false"
    trim="trim-silence"/>
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
function buildVoicePrompt(savedPrompt) {
  const afterHours = !isBusinessHours()
    ? "\n\nIMPORTANT: It is currently after office hours (Mon-Fri 9am-5pm PT). Let the caller know their info will be passed to the team and they'll hear back next business day."
    : "";

  return (savedPrompt || "") + `

============================
VOICE CALL — CRITICAL RULES
============================
You are Zara answering a PHONE CALL. Keep ALL responses under 2 sentences.
No bullet points. No lists. Speak naturally like a receptionist.

GOAL: Briefly help, then collect name, issue, and callback number (one at a time).

If URGENT (ICE, detained, accident just happened, court today): say exactly:
"This sounds urgent — please hold while I connect you with Attorney Zhang."
Then say ONLY: TRANSFER_NOW

Never mention you are AI unless asked directly.${afterHours}`;
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
  if (!intake.caseType) {
    if (/visa|green card|immigration|uscis|daca|deportation/i.test(text))    intake.caseType = "Immigration";
    else if (/accident|injury|crash/i.test(text))                             intake.caseType = "Car Accident / Personal Injury";
    else if (/evict|landlord|tenant|rent/i.test(text))                        intake.caseType = "Landlord / Tenant";
    else if (/will|trust|estate|probate/i.test(text))                         intake.caseType = "Estate Planning";
    else if (/contract|lawsuit|sued|business/i.test(text))                    intake.caseType = "Business Litigation";
  }
  if (!intake.issue && text.length > 20) intake.issue = text.substring(0, 200);
}

// ── Send post-call summary to Telegram ───────────────────
async function notifyCallSummary({ from, transcript, intake, transferred }) {
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID } = process.env;
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return;
  const intakeText = intake.name
    ? `\n👤 Name: ${intake.name}\n⚖️ Issue: ${intake.issue || "Not specified"}\n📞 Callback: ${intake.callback || from}`
    : "\n(No intake collected)";
  const text = `📞 VOICE CALL — TEZ LAW P.C.\n\n📱 Caller: ${from}\n${transferred ? "🔀 Transferred to JJ\n" : ""}${intakeText}\n\n📝 Transcript:\n${transcript.slice(-2000) || "(empty)"}`;
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: JJ_TELEGRAM_ID, text: text.substring(0, 4000),
  }).catch(e => console.error("[voice] Telegram notify error:", e.message));
}

// ── Save intake to DB ─────────────────────────────────────
async function saveCallIntake(from, intake) {
  if (!intake.name && !intake.callback) return;
  try {
    const db = require("./db");
    const uid = `phone_${from}`;
    await db.saveIntake("phone", uid, {
      name: intake.name || "Voice Caller", issue: intake.issue || "Phone inquiry",
      contact: intake.callback || from, case_type: intake.caseType || "General Legal",
    });
    if (intake.name && intake.callback) {
      await db.createLead({ platform: "phone", platformId: uid,
        name: intake.name, contact: intake.callback, caseType: intake.caseType || "General Legal" });
    }
  } catch (e) { console.error("[voice] saveCallIntake error:", e.message); }
}

// ══════════════════════════════════════════════════════════
//  ROUTE HANDLERS
// ══════════════════════════════════════════════════════════

// POST /voice/incoming — first webhook when call arrives
async function handleIncomingCall(req, res, savedPrompt) {
  const callSid = req.body?.CallSid || "unknown";
  const from    = req.body?.From || "unknown";
  const base    = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  console.log(`[voice] Incoming call SID=${callSid} from=${from}`);

  try {
    const greeting = isBusinessHours()
      ? "Hi, thank you for calling TEZ Law Firm, this is Zara speaking. How may I help you?"
      : "Hi, thank you for calling TEZ Law Firm, this is Zara speaking. Our office is currently closed, but I can take a message and have our team call you back next business day. How may I help you?";

    const audio = await elevenLabsTTS(greeting);
    const id = `greeting_${callSid}_${Date.now()}`;
    storeAudio(id, audio);

    const audioUrl = `${base}/voice/audio/${id}`;
    const session = getSession(callSid);
    session.conversation.push({ role: "assistant", content: greeting });
    session.transcript.push(`Zara: ${greeting}`);
    session.from = from;
    session.savedPrompt = savedPrompt;

    res.type("text/xml").send(buildGatherTwiML(audioUrl, `${base}/voice/respond`));
  } catch (err) {
    console.error("[voice] handleIncomingCall error:", err.message);
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Thank you for calling Tez Law P.C. Please call us back at 626-678-8677. Goodbye.</Say></Response>`);
  }
}

// POST /voice/respond — caller spoke, process and respond
async function handleRespond(req, res) {
  const callSid    = req.body?.CallSid || "unknown";
  // Get speech from either SpeechResult (Gather) or RecordingUrl (Record)
  let speechText = req.body?.SpeechResult || "";

  // If we have a recording URL, transcribe it with Deepgram
  if (!speechText && req.body?.RecordingUrl) {
    try {
      console.log("[voice] Transcribing recording:", req.body.RecordingUrl);
      speechText = await deepgramTranscribe(req.body.RecordingUrl + ".mp3");
      console.log("[voice] Deepgram result:", speechText);
    } catch (err) {
      console.error("[voice] Deepgram transcription error:", err.message);
    }
  }
  const base       = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  const session    = getSession(callSid);
  console.log(`[voice] Speech received: "${speechText}"`);

  // No speech detected - re-record silently
  if (!speechText.trim()) {
    return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record action="${base}/voice/respond" method="POST"
    maxLength="30"
    timeout="5"
    playBeep="false"
    trim="trim-silence"/>
</Response>`);

  session.transcript.push(`Caller: ${speechText}`);
  extractIntake(speechText, session.intake);

  try {
    // Check urgent
    if (isUrgent(speechText) && !session.transferred) {
      session.transferred = true;
      const msg = "This sounds urgent — please hold while I connect you with Attorney Zhang.";
      const audio = await elevenLabsTTS(msg);
      const id = `transfer_${Date.now()}`;
      storeAudio(id, audio);
      session.transcript.push(`Zara: ${msg}`);
      notifyCallSummary({ from: session.from, transcript: session.transcript.join("\n"), intake: session.intake, transferred: true });
      saveCallIntake(session.from, session.intake);
      clearSession(callSid);
      return res.type("text/xml").send(buildTransferTwiML(`${base}/voice/audio/${id}`));
    }

    // Get Claude response then convert to speech
    session.conversation.push({ role: "user", content: speechText });
    const systemPrompt = buildVoicePrompt(session.savedPrompt);
    const aiReply = await askClaude(systemPrompt, session.conversation);
    console.log(`[voice] Zara reply: "${aiReply.substring(0, 80)}"`);

    // Check if Claude wants to transfer
    if (aiReply.includes("TRANSFER_NOW") && !session.transferred) {
      session.transferred = true;
      const cleanReply = aiReply.replace("TRANSFER_NOW", "").trim() || "Please hold while I connect you.";
      const audio = await elevenLabsTTS(cleanReply);
      const id = `transfer_${Date.now()}`;
      storeAudio(id, audio);
      session.transcript.push(`Zara: ${cleanReply}`);
      notifyCallSummary({ from: session.from, transcript: session.transcript.join("\n"), intake: session.intake, transferred: true });
      saveCallIntake(session.from, session.intake);
      clearSession(callSid);
      return res.type("text/xml").send(buildTransferTwiML(`${base}/voice/audio/${id}`));
    }

    session.conversation.push({ role: "assistant", content: aiReply });
    session.transcript.push(`Zara: ${aiReply}`);

    // Convert to speech
    const audio = await elevenLabsTTS(aiReply);
    const id = `reply_${callSid}_${Date.now()}`;
    storeAudio(id, audio);

    res.type("text/xml").send(buildGatherTwiML(`${base}/voice/audio/${id}`, `${base}/voice/respond`));
  } catch (err) {
    console.error("[voice] handleRespond error:", err.message);
    try {
      const audio = await elevenLabsTTS("I'm having a technical issue. Please call us at 626-678-8677. Goodbye.");
      const id = `error_${Date.now()}`;
      storeAudio(id, audio);
      res.type("text/xml").send(buildPlayTwiML(`${base}/voice/audio/${id}`));
    } catch {
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Please call us at 626-678-8677. Goodbye.</Say></Response>`);
    }
  }
}

// POST /voice/status — call ended
}
async function handleCallStatus(req, res) {
  res.sendStatus(200);
  const { CallSid, CallStatus, From } = req.body || {};
  if (CallStatus === "completed" || CallStatus === "no-answer") {
    const session = sessions.get(CallSid);
    if (session) {
      notifyCallSummary({ from: session.from || From, transcript: session.transcript.join("\n"), intake: session.intake, transferred: session.transferred });
      saveCallIntake(session.from || From, session.intake);
      clearSession(CallSid);
    }
  }
}

// GET /voice/audio/:id — serve audio file
function handleAudio(req, res) {
  serveAudio(req, res);
}

// POST /voice/transfer — transfer TwiML
function handleTransfer(req, res) {
  const JJ   = process.env.JJ_PHONE || "6266788677";
  const base = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please hold while I connect you with Attorney Zhang.</Say>
  <Dial timeout="30" action="${base}/voice/transfer-fallback">
    <Number>${JJ}</Number>
  </Dial>
</Response>`);
}

// POST /voice/transfer-fallback — JJ didn't answer
function handleTransferFallback(req, res) {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>I'm sorry, Attorney Zhang is unavailable. Please leave your name and number after the tone and he will call you back shortly.</Say>
  <Record maxLength="120" transcribeCallback="/voice/transcribe"/>
  <Say>Thank you. We will be in touch shortly. Goodbye.</Say>
</Response>`);
}

// POST /voice/transcribe — voicemail transcription
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
