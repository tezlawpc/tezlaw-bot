// ============================================================
//  voice-call.js — Zara Voice AI
//  Twilio (phone) + Deepgram (STT) + Claude (AI) + ElevenLabs (TTS)
//  Tez Law P.C.
//
//  Architecture:
//  Caller → Twilio → /voice/stream (WebSocket)
//         → Deepgram STT → Claude AI → ElevenLabs TTS
//         → audio back to Twilio → Caller hears response
//
//  Latency: Deepgram <200ms STT + Claude ~300ms + ElevenLabs ~75ms
//  Total: ~575ms end-to-end (natural conversation pace)
// ============================================================

const WebSocket  = require("ws");
const axios      = require("axios");
const https      = require("https");

// ── Business hours (Pacific Time) ────────────────────────
function isBusinessHours() {
  const now = new Date();
  const pt  = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day  = pt.getDay();   // 0=Sun 6=Sat
  const hour = pt.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 17;
}

// ── Urgent keywords → transfer to JJ ─────────────────────
function isUrgent(text) {
  return /\b(ice|detained|arrest|deport|court today|court tomorrow|accident just|just happened|emergency|injured badly|in jail|in custody|scared|please help now)\b/i.test(text);
}

// ── System prompt for voice ───────────────────────────────
function buildVoicePrompt(savedPrompt) {
  const afterHoursNote = !isBusinessHours()
    ? "\n\nNOTE: It is currently AFTER HOURS (office is open Mon-Fri 9am-5pm PT). Let the caller know their message will be passed to the team and someone will call back next business day."
    : "";

  return (savedPrompt || "") + `

============================
VOICE CALL INSTRUCTIONS — CRITICAL
============================
You are answering a PHONE CALL for Tez Law P.C. Keep ALL responses SHORT — 1-3 sentences max.
Speak naturally. No bullet points, no lists, no markdown, no asterisks.
Do NOT read punctuation aloud. Speak like a warm, professional receptionist.

CALL FLOW:
1. You will receive the caller's words as text. Respond naturally and conversationally.
2. Answer any legal questions briefly, then collect intake.
3. INTAKE TO COLLECT — ask one at a time:
   - Full name
   - Brief description of their legal issue
   - Best callback phone number
4. If URGENT (ICE, detained, accident just happened, court today, emergency):
   Say exactly: "This sounds urgent, please hold while I connect you with Attorney Zhang right now." 
   Then on the next line say only: TRANSFER_NOW
5. After collecting all intake info, confirm:
   "I've noted your information and Attorney Zhang's team will call you back shortly. Is there anything else I can help you with?"
6. End the call warmly once they're done.${afterHoursNote}

IMPORTANT: Never say you're an AI unless directly asked. You are Zara, the legal assistant for Tez Law P.C.`;
}

// ── ElevenLabs TTS → returns audio Buffer ────────────────
async function elevenLabsTTS(text, voiceId) {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    console.error("[voice] ERROR: ELEVENLABS_API_KEY not set in environment");
    throw new Error("ELEVENLABS_API_KEY not set");
  }
  console.log("[voice] ElevenLabs TTS request:", text.substring(0, 60));

  // Default voice: Rachel (warm, professional American female)
  const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

  const res = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream`,
    {
      text,
      model_id: "eleven_flash_v2_5",  // ~75ms latency, optimized for real-time
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.3,
        use_speaker_boost: true,
      },
      output_format: "ulaw_8000",  // Twilio needs 8kHz µ-law
    },
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      responseType: "arraybuffer",
    }
  );

  return Buffer.from(res.data);
}

// ── Deepgram STT — streaming via WebSocket ────────────────
function createDeepgramConnection(onTranscript) {
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DEEPGRAM_API_KEY) {
    console.error("[voice] DEEPGRAM_API_KEY not set");
    return null;
  }

  // Nova-3 model, optimized for telephony
  const dgWs = new WebSocket(
    "wss://api.deepgram.com/v1/listen?" +
    "model=nova-3&" +
    "detect_language=true&" +     // Auto-detect English, Chinese, Spanish
    "encoding=mulaw&" +
    "sample_rate=8000&" +
    "channels=1&" +
    "punctuate=true&" +
    "interim_results=true&" +
    "endpointing=300&" +          // 300ms silence = end of utterance
    "utterance_end_ms=1000&" +    // 1s max utterance gap
    "smart_format=true",
    {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    }
  );

  dgWs.on("open", () => {
    console.log("[voice] Deepgram STT connected");
  });

  dgWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Only process final transcripts (is_final=true)
      if (msg.type === "Results" && msg.is_final) {
        const transcript = msg.channel?.alternatives?.[0]?.transcript || "";
        if (transcript.trim()) {
          console.log(`[voice] Deepgram transcript: "${transcript}"`);
          onTranscript(transcript);
        }
      }
    } catch (err) {
      console.error("[voice] Deepgram message error:", err.message);
    }
  });

  dgWs.on("error", (err) => {
    console.error("[voice] Deepgram WebSocket error:", err.message);
  });

  dgWs.on("close", () => {
    console.log("[voice] Deepgram connection closed");
  });

  return dgWs;
}

// ── Call Claude for AI response ───────────────────────────
async function askClaudeVoice(systemPrompt, conversationHistory) {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",  // Fast model for voice
      max_tokens: 200,                      // Short responses for voice
      system: systemPrompt,
      messages: conversationHistory,
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.content[0]?.text || "";
}

// ── Send post-call Telegram notification ─────────────────
async function notifyCallSummary({ fromNumber, transcript, intake, duration, transferred }) {
  const { TELEGRAM_TOKEN, JJ_TELEGRAM_ID } = process.env;
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return;

  const intakeText = intake.name
    ? `\n👤 Name: ${intake.name}\n⚖️ Issue: ${intake.issue || "Not specified"}\n📞 Callback: ${intake.callback || fromNumber}`
    : "\n(No intake collected)";

  const text =
    `📞 VOICE CALL — TEZ LAW P.C.\n\n` +
    `📱 Caller: ${fromNumber}\n` +
    `⏱ Duration: ${Math.round(duration)}s\n` +
    (transferred ? `🔀 Transferred to JJ\n` : "") +
    intakeText + `\n\n` +
    `📝 Transcript:\n${transcript.slice(-2000) || "(empty)"}`;

  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: JJ_TELEGRAM_ID,
    text: text.substring(0, 4000),
  }).catch(err => console.error("[voice] Call summary Telegram error:", err.message));
}

// ── Save call intake to DB ────────────────────────────────
async function saveCallIntake(fromNumber, intake) {
  if (!intake.name && !intake.callback) return;
  try {
    const db = require("./db");
    const userId = `phone_${fromNumber}`;
    await db.saveIntake("phone", userId, {
      name:      intake.name || "Voice Caller",
      issue:     intake.issue || "Phone call inquiry",
      contact:   intake.callback || fromNumber,
      case_type: intake.caseType || "General Legal",
    });
    if (intake.name && intake.callback) {
      await db.createLead({
        platform:   "phone",
        platformId: userId,
        name:       intake.name,
        contact:    intake.callback,
        caseType:   intake.caseType || "General Legal",
      });
    }
    console.log("[voice] Call intake saved to DB");
  } catch (err) {
    console.error("[voice] saveCallIntake error:", err.message);
  }
}

// ── Extract intake from conversation ─────────────────────
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
    if (/visa|green card|immigration|uscis|daca|deportation/i.test(text))     intake.caseType = "Immigration";
    else if (/accident|injury|crash|hospital/i.test(text))                     intake.caseType = "Car Accident / Personal Injury";
    else if (/evict|landlord|tenant|rent/i.test(text))                         intake.caseType = "Landlord / Tenant";
    else if (/will|trust|estate|probate/i.test(text))                          intake.caseType = "Estate Planning";
    else if (/contract|lawsuit|sued|business/i.test(text))                     intake.caseType = "Business Litigation";
  }
  if (!intake.issue && text.length > 30) {
    intake.issue = text.substring(0, 200);
  }
}

// ── Transfer call to JJ ───────────────────────────────────
async function transferToJJ(callSid) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, RENDER_EXTERNAL_URL } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  const baseUrl = RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  try {
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
      new URLSearchParams({ Url: `${baseUrl}/voice/transfer`, Method: "POST" }).toString(),
      {
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    console.log("[voice] Transfer to JJ initiated");
  } catch (err) {
    console.error("[voice] Transfer error:", err.message);
  }
}

// ── Main WebSocket handler ────────────────────────────────
function handleMediaStream(ws, req, savedPrompt) {
  console.log("[voice] New Twilio media stream connected");

  let dgWs          = null;
  let callSid       = null;
  let streamSid     = null;
  let fromNumber    = "unknown";
  let transferred   = false;
  let callStart     = Date.now();
  let isProcessing  = false;  // Prevent overlapping AI calls

  const transcript      = [];  // Full call transcript
  const conversation    = [];  // Claude conversation history
  const intake          = { name: null, issue: null, callback: null, caseType: null };
  const systemPrompt    = buildVoicePrompt(savedPrompt);

  // ── Send audio back to Twilio ───────────────────────
  function sendAudioToTwilio(audioBuffer) {
    if (!streamSid || ws.readyState !== WebSocket.OPEN) {
      console.error("[voice] Cannot send audio — streamSid:", streamSid, "ws state:", ws.readyState);
      return;
    }
    // Twilio expects raw mulaw audio as base64 in 20ms chunks (160 bytes each at 8kHz)
    // Each chunk = 160 bytes of raw audio (NOT base64 size)
    const CHUNK_BYTES = 160; // 20ms at 8kHz mulaw
    let offset = 0;
    while (offset < audioBuffer.length) {
      const chunk = audioBuffer.slice(offset, offset + CHUNK_BYTES);
      ws.send(JSON.stringify({
        event:     "media",
        streamSid: streamSid,
        media:     { payload: chunk.toString("base64") },
      }));
      offset += CHUNK_BYTES;
    }
    // Mark end of audio
    ws.send(JSON.stringify({
      event:     "mark",
      streamSid: streamSid,
      mark:      { name: "audio_done" },
    }));
    console.log("[voice] Audio sent to Twilio:", audioBuffer.length, "bytes in", Math.ceil(audioBuffer.length/CHUNK_BYTES), "chunks");
  }

  // ── Process caller speech with AI + TTS ────────────
  async function processCallerSpeech(callerText) {
    if (isProcessing || transferred) return;
    isProcessing = true;

    try {
      // Add to transcript
      transcript.push(`Caller: ${callerText}`);
      extractIntake(callerText, intake);

      // Check for urgent transfer
      if (isUrgent(callerText)) {
        const urgentReply = "This sounds urgent, please hold while I connect you with Attorney Zhang right now.";
        transcript.push(`Zara: ${urgentReply}`);
        const audio = await elevenLabsTTS(urgentReply);
        sendAudioToTwilio(audio);
        transferred = true;
        setTimeout(() => transferToJJ(callSid), 3000);
        return;
      }

      // Add to Claude conversation
      conversation.push({ role: "user", content: callerText });

      // Get Claude response
      const aiReply = await askClaudeVoice(systemPrompt, conversation);
      console.log(`[voice] Zara: "${aiReply.substring(0, 80)}..."`);

      // Check if Claude wants to transfer
      if (aiReply.includes("TRANSFER_NOW")) {
        const cleanReply = aiReply.replace("TRANSFER_NOW", "").trim();
        if (cleanReply) {
          transcript.push(`Zara: ${cleanReply}`);
          const audio = await elevenLabsTTS(cleanReply);
          sendAudioToTwilio(audio);
        }
        transferred = true;
        setTimeout(() => transferToJJ(callSid), 3000);
        return;
      }

      // Add to conversation history
      conversation.push({ role: "assistant", content: aiReply });
      transcript.push(`Zara: ${aiReply}`);

      // Convert to speech with ElevenLabs
      const audio = await elevenLabsTTS(aiReply);
      sendAudioToTwilio(audio);

    } catch (err) {
      console.error("[voice] processCallerSpeech error:", err.message);
      // Fallback message
      try {
        const fallback = "I apologize, I'm having a technical issue. Please call us at 626-678-8677 and our team will be happy to help.";
        const audio = await elevenLabsTTS(fallback);
        sendAudioToTwilio(audio);
      } catch {}
    } finally {
      isProcessing = false;
    }
  }

  // ── Send opening greeting ───────────────────────────
  async function sendGreeting() {
    // Wait until streamSid is available (retry up to 10 times)
    let attempts = 0;
    while (!streamSid && attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    if (!streamSid) {
      console.error("[voice] Greeting failed — streamSid not available after 2s");
      return;
    }
    try {
      const greeting = isBusinessHours()
        ? "Thank you for calling Tez Law P.C., this is Zara your legal assistant. How can I help you today?"
        : "Thank you for calling Tez Law P.C., this is Zara your legal assistant. Our office is currently closed, but I can take a message and have our team call you back next business day. How can I help you?";

      transcript.push(`Zara: ${greeting}`);
      conversation.push({ role: "assistant", content: greeting });

      console.log("[voice] Generating greeting audio, streamSid:", streamSid);
      const audio = await elevenLabsTTS(greeting);
      console.log("[voice] Greeting audio generated, size:", audio.length, "bytes");
      sendAudioToTwilio(audio);
      console.log("[voice] Opening greeting sent to Twilio");
    } catch (err) {
      console.error("[voice] Greeting error:", err.message);
    }
  }

  // ── Handle Twilio media stream events ──────────────
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case "start":
          streamSid  = data.start?.streamSid;
          callSid    = data.start?.callSid;
          fromNumber = data.start?.customParameters?.caller || "unknown";
          console.log(`[voice] Stream started — SID: ${callSid}, caller: ${fromNumber}`);

          // Connect Deepgram STT
          dgWs = createDeepgramConnection((callerText) => {
            processCallerSpeech(callerText).catch(err =>
              console.error("[voice] processCallerSpeech unhandled:", err.message)
            );
          });

          // Send greeting after brief delay (let stream stabilize)
          setTimeout(sendGreeting, 1500);
          break;

        case "media":
          // Forward caller audio to Deepgram
          if (dgWs?.readyState === WebSocket.OPEN) {
            const audioBuffer = Buffer.from(data.media.payload, "base64");
            dgWs.send(audioBuffer);
          }
          break;

        case "mark":
          // Audio playback finished
          break;

        case "stop":
          console.log("[voice] Stream stopped");
          const duration = (Date.now() - callStart) / 1000;
          const fullTranscript = transcript.join("\n");

          // Clean up Deepgram
          if (dgWs?.readyState === WebSocket.OPEN) {
            dgWs.close();
          }

          // Notify JJ + save intake
          notifyCallSummary({ fromNumber, transcript: fullTranscript, intake, duration, transferred });
          saveCallIntake(fromNumber, intake);
          break;
      }
    } catch (err) {
      console.error("[voice] WS message error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[voice] Twilio WS closed");
    if (dgWs?.readyState === WebSocket.OPEN) dgWs.close();
  });

  ws.on("error", (err) => {
    console.error("[voice] Twilio WS error:", err.message);
  });
}

// ── Incoming call TwiML ───────────────────────────────────
function handleIncomingCall(req, res) {
  const host  = req.headers.host || "tezlaw-bot.onrender.com";
  const wsUrl = `wss://${host}/voice/stream`;
  const caller = req.body?.From || "unknown";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}"/>
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
}

// ── Transfer to JJ's cell ─────────────────────────────────
function handleTransfer(req, res) {
  const JJ_PHONE = process.env.JJ_PHONE || "6266788677";
  const baseUrl  = process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Please hold while I connect you with Attorney Zhang.</Say>
  <Dial timeout="30" action="${baseUrl}/voice/transfer-fallback">
    <Number>${JJ_PHONE}</Number>
  </Dial>
</Response>`;

  res.type("text/xml").send(twiml);
}

// ── Transfer fallback (JJ didn't answer) ─────────────────
function handleTransferFallback(req, res) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">
    I'm sorry, Attorney Zhang is unavailable right now. 
    Please leave your name and number after the tone and he will call you back as soon as possible.
  </Say>
  <Record maxLength="120" transcribeCallback="/voice/transcribe"/>
  <Say voice="Polly.Joanna">Thank you. We will be in touch shortly. Goodbye.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
}

// ── Voicemail transcription callback ─────────────────────
async function handleTranscription(req, res) {
  res.sendStatus(200);
  const { TranscriptionText, From, CallSid } = req.body || {};
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
  handleTransfer,
  handleTransferFallback,
  handleTranscription,
  handleMediaStream,
};
