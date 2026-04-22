// ============================================================
//  voice.js — Zara Voice Module
//  Text-to-Speech (OpenAI TTS) + platform voice sending
//  Used in JJ Mode only (Telegram + WhatsApp)
// ============================================================

const axios    = require("axios");
const FormData = require("form-data");

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ── Text → OGG/OPUS audio buffer (OpenAI TTS) ────────────
async function textToSpeech(text) {
  // Truncate to ~500 chars for voice — send full text in text message
  const voiceText = text.length > 600
    ? text.substring(0, 580) + "... see full response above."
    : text;

  const response = await axios.post(
    "https://api.openai.com/v1/audio/speech",
    {
      model:           "tts-1",
      voice:           "nova",   // warm, professional female voice
      input:           voiceText,
      response_format: "opus",   // OGG/OPUS — works natively on Telegram + WhatsApp
    },
    {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type":  "application/json",
      },
      responseType: "arraybuffer",
    }
  );
  return Buffer.from(response.data);
}

// ── Send voice message on Telegram ───────────────────────
async function sendTelegramVoice(chatId, audioBuffer) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("voice", audioBuffer, {
    filename:    "zara.ogg",
    contentType: "audio/ogg",
  });
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendVoice`,
    form,
    { headers: form.getHeaders() }
  );
}

// ── Send voice message on WhatsApp ────────────────────────
async function sendWhatsAppVoice(to, audioBuffer) {
  const WA_API = `https://graph.facebook.com/v22.0`;

  // Step 1: Upload media
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "audio/ogg");
  form.append("file", audioBuffer, {
    filename:    "zara.ogg",
    contentType: "audio/ogg",
  });
  const uploadResp = await axios.post(
    `${WA_API}/${PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        ...form.getHeaders(),
      },
    }
  );
  const mediaId = uploadResp.data.id;
  if (!mediaId) throw new Error("WhatsApp media upload failed: " + JSON.stringify(uploadResp.data));

  // Step 2: Send as voice (PTT — push to talk bubble)
  await axios.post(
    `${WA_API}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "audio",
      audio:             { id: mediaId, voice: true },
    },
    {
      headers: {
        Authorization:  `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ── Main: generate and send voice reply ──────────────────
//  platform: "telegram" | "whatsapp"
//  userId:   chatId (telegram) or phone number (whatsapp)
async function sendVoiceReply(platform, userId, text) {
  try {
    console.log(`🎙️ Generating voice reply for ${platform}:${userId}`);
    const audioBuffer = await textToSpeech(text);
    if (platform === "telegram") {
      await sendTelegramVoice(userId, audioBuffer);
    } else if (platform === "whatsapp") {
      await sendWhatsAppVoice(userId, audioBuffer);
    }
    console.log(`✅ Voice reply sent to ${platform}:${userId}`);
  } catch (err) {
    console.error(`❌ Voice reply error (${platform}):`, err.message);
    // Voice failure is non-fatal — text reply already sent
  }
}

module.exports = { sendVoiceReply, textToSpeech };
