// ============================================================
//  whisper.js — Voice Transcription via OpenAI Whisper
//  Tez Law P.C. — Zara AI Assistant
//  Drop this file into all 3 bot repos.
//  Cost: ~$0.006/minute (roughly $0.01 per voice message)
//  Uses Node 18+ native fetch + FormData (no extra dependencies)
// ============================================================

const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Transcribe an audio buffer using OpenAI Whisper API
 * Supports: ogg, opus, mp3, mp4, wav, m4a, webm, amr
 */
async function transcribeAudio(audioBuffer, filename, language = null) {
  if (!OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY not set — Whisper transcription disabled");
    return null;
  }

  try {
    // Use native FormData + Blob (Node 18+)
    const blob = new Blob([audioBuffer], { type: getAudioMimeType(filename) });
    const formData = new FormData();
    formData.append("file", blob, filename);
    formData.append("model", "whisper-1");
    formData.append("response_format", "text");
    if (language && language !== "en") {
      formData.append("language", language);
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Whisper API error (${response.status}): ${err}`);
      return null;
    }

    const transcript = (await response.text()).trim();
    console.log(`🎤 Whisper transcribed: "${transcript.substring(0, 80)}"`);
    return transcript || null;
  } catch (err) {
    console.error("Whisper error:", err.message);
    return null;
  }
}

function getAudioMimeType(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const map = {
    ogg: "audio/ogg", opus: "audio/ogg",
    mp3: "audio/mpeg", mp4: "audio/mp4",
    m4a: "audio/mp4", wav: "audio/wav",
    webm: "audio/webm", amr: "audio/amr",
    flac: "audio/flac",
  };
  return map[ext] || "audio/ogg";
}

module.exports = { transcribeAudio };
