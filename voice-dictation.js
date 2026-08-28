// ============================================================
//  TEZ LAW P.C. — VOICE DICTATION FOR HEARING NOTES
//  ─────────────────────────────────────────────────────────
//  Flow:
//   1. Attorney records audio via browser (works on laptop or phone)
//   2. Audio uploads to server
//   3. OpenAI Whisper transcribes → text
//   4. Claude Sonnet extracts hearing note fields via tool use
//   5. Creates a draft hearing note (using existing dedup + revision logic)
//   6. Redirects to the edit view for finalization
//
//  Cost: ~$0.10-0.30 per dictation (Whisper $0.006/min + Claude Sonnet)
//  Audio limit: 25 MB (Whisper's cap — ~30 min at OGG/OPUS)
// ============================================================

const axios = require("axios");
const FormData = require("form-data");

// ── Whisper transcription ────────────────────────────────

async function transcribeAudio(audioBuffer, filename) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  // Whisper accepts: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
  // Browser MediaRecorder outputs webm (Chrome/Firefox) or mp4 (Safari).
  const formData = new FormData();
  const contentType = filename.endsWith(".mp4") ? "audio/mp4"
                    : filename.endsWith(".m4a") ? "audio/m4a"
                    : filename.endsWith(".wav") ? "audio/wav"
                    : filename.endsWith(".ogg") ? "audio/ogg"
                    : "audio/webm";
  formData.append("file", audioBuffer, { filename, contentType });
  formData.append("model", "whisper-1");
  formData.append("response_format", "json");
  // Don't force language — Whisper auto-detects. JJ may dictate in
  // English, Mandarin, or Spanish depending on the client's hearing.

  const resp = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...formData.getHeaders(),
      },
      maxBodyLength: 30 * 1024 * 1024,
      maxContentLength: 30 * 1024 * 1024,
      timeout: 180000,   // Whisper can take 60-90 sec on longer clips
    }
  );
  return resp.data.text || "";
}

// ── Claude field extraction (tool use for guaranteed JSON) ──

async function extractFieldsFromTranscript(transcript, hint = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const contextHint = [
    hint.client_name ? `Client name hint: ${hint.client_name}` : "",
    hint.a_number ? `A-Number hint: ${hint.a_number}` : "",
    hint.hearing_type ? `Hearing type hint: ${hint.hearing_type}` : "",
  ].filter(Boolean).join("\n");

  const prompt = `You are extracting immigration court hearing note fields from an attorney's spoken dictation.

The attorney at TEZ LAW FIRM just left immigration court and is dictating notes about a hearing they attended. Your job is to extract structured fields.

${contextHint ? `Context from the attorney (may be helpful):\n${contextHint}\n\n` : ""}Attorney's dictation (from voice transcript — may contain filler words, misheard names, "um", "uh"):

"""
${transcript}
"""

Extraction guidelines:
- Client's name: extract from context, standardize to "Last, First" format if possible
- A-Number: 9-digit alien registration number (may be spoken as "A 249 402 327")
- Hearing date/time: today's date + any time mentioned. If no time given, use 9:00 AM today.
- Hearing type: master, individual, bond, status, biometrics
- Case type: asylum, cancellation, adjustment, VAWA, etc.
- Judge/DHS attorney names: extract even if spelling is approximate
- Applications filed: any I-589, I-485, I-601, EOIR-42B, etc. mentioned
- Deadlines: any specific dates the attorney mentions (e.g. "I-589 due September 30")
- raw_notes: preserve the full narrative content — this becomes the reference
- Judge names commonly heard: Kevin Riley, Munish Sharda, Mimi Tsankov, etc.
- Court is usually "Los Angeles Immigration Court" or "Van Nuys IC" unless attorney says otherwise
- If attorney says "next hearing October 15 for individual" — set next_hearing_date=2026-10-15T09:00:00 and next_hearing_type=individual

Fill fields you're confident about; leave nulls for anything unclear rather than guessing.
The raw_notes field should contain the full transcript verbatim (or lightly cleaned) so nothing is lost.`;

  const anthResp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      tools: [{
        name: "record_hearing_note",
        description: "Record the extracted hearing note fields from the attorney's dictation.",
        input_schema: {
          type: "object",
          properties: {
            client_name: { type: ["string", "null"], description: "Client's name, ideally 'Last, First'" },
            a_number: { type: ["string", "null"], description: "9-digit A-number, formatted like A249-402-327" },
            client_language: { type: ["string", "null"], enum: ["en", "zh", "es", "hi", "pa", null], description: "Client's preferred language" },
            hearing_datetime: { type: ["string", "null"], description: "ISO datetime of the hearing that just happened" },
            hearing_type: { type: ["string", "null"], enum: ["master", "individual", "bond", "status", "biometrics", "interview", null] },
            case_type: { type: ["string", "null"], description: "e.g. asylum, cancellation, adjustment" },
            judge_name: { type: ["string", "null"] },
            dhs_attorney: { type: ["string", "null"] },
            client_attendance: { type: ["string", "null"], enum: ["present", "absent", "waived", null] },
            attorney_appearance: { type: ["string", "null"] },
            pleadings_admitted: { type: ["string", "null"], description: "Which allegations admitted (e.g. '1-3')" },
            pleadings_denied: { type: ["string", "null"], description: "Which allegations denied" },
            pleadings_contested: { type: ["string", "null"] },
            pleadings_method: { type: ["string", "null"] },
            removability_conceded: { type: "boolean" },
            applications: {
              type: "array",
              items: { type: "string" },
              description: "Applications filed or discussed (I-589, I-485, EOIR-42B, etc.)",
            },
            asylum_fee_needed: { type: "boolean" },
            biometrics_needed: { type: "boolean" },
            disposition: { type: ["string", "null"] },
            disposition_notes: { type: ["string", "null"] },
            next_hearing_date: { type: ["string", "null"], description: "ISO datetime of next hearing" },
            next_hearing_type: { type: ["string", "null"] },
            deadlines: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  date: { type: "string", description: "ISO date" },
                  description: { type: "string" },
                },
              },
              description: "Deadlines mentioned by the attorney",
            },
            raw_notes: { type: "string", description: "The full attorney dictation (transcript, verbatim or lightly cleaned)" },
          },
          required: ["client_name", "raw_notes"],
        },
      }],
      tool_choice: { type: "tool", name: "record_hearing_note" },
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 90000,
    }
  );

  const toolUse = (anthResp.data.content || []).find(b => b.type === "tool_use");
  if (!toolUse || !toolUse.input) {
    throw new Error("Claude did not return structured extraction");
  }
  return toolUse.input;
}

// ── Dictation page renderer ──────────────────────────────

function renderDictatePage() {
  const hn = require("./hearing-notes");
  const body = `
<div class="page-header">
  <h1>🎙️ Voice Dictate Hearing Notes</h1>
  <div style="font-size:13px; color:#666;">
    Just walked out of court? Record your notes here — Zara transcribes with Whisper, extracts the hearing fields with Claude, and creates a draft for you to review.
  </div>
</div>

<div style="background:white; padding:24px; border-radius:8px; border:1px solid #eee; max-width:720px; margin:0 auto;">

  <!-- Optional context inputs to help Claude with tricky names -->
  <div style="background:#fdf7f0; border:1px solid #e8dbc0; border-radius:6px; padding:14px 16px; margin-bottom:20px;">
    <div style="font-size:12px; color:#666; margin-bottom:8px; font-weight:600;">Optional context (helps with name spelling)</div>
    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px;">
      <div>
        <label style="font-size:11px; color:#888;">Client name</label>
        <input type="text" id="hint-client-name" placeholder="e.g. Kong, Xiangmin" style="width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:3px; font-size:13px;">
      </div>
      <div>
        <label style="font-size:11px; color:#888;">A-Number</label>
        <input type="text" id="hint-a-number" placeholder="e.g. A249-402-327" style="width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:3px; font-size:13px;">
      </div>
      <div>
        <label style="font-size:11px; color:#888;">Hearing type</label>
        <select id="hint-hearing-type" style="width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:3px; font-size:13px;">
          <option value="">(auto-detect)</option>
          <option value="master">Master</option>
          <option value="individual">Individual/Merits</option>
          <option value="bond">Bond</option>
          <option value="status">Status</option>
        </select>
      </div>
    </div>
  </div>

  <!-- Big record button -->
  <div id="record-panel" style="text-align:center; padding:20px 0;">
    <button type="button" id="record-btn" onclick="toggleRecording()"
            style="width:180px; height:180px; border-radius:50%; border:none; background:linear-gradient(145deg, #B79C62, #8f7a4c); color:white; font-size:16px; font-weight:600; cursor:pointer; box-shadow:0 8px 24px rgba(183,156,98,0.3); transition:all 0.2s;">
      <div style="font-size:52px; margin-bottom:6px;" id="record-icon">🎙️</div>
      <div id="record-label">Tap to record</div>
    </button>
    <div id="timer" style="font-family:monospace; font-size:28px; color:#0C1C36; margin-top:20px; letter-spacing:2px;">00:00</div>
    <div id="record-hint" style="font-size:12px; color:#888; margin-top:8px;">
      Tips: mention client name, A-number, judge, DHS attorney, pleadings, applications, next hearing date, and any deadlines.
    </div>
  </div>

  <!-- Playback + submit -->
  <div id="playback-panel" style="display:none; padding:20px 0;">
    <div style="background:#f8f8f8; padding:15px; border-radius:6px; margin-bottom:15px;">
      <audio id="audio-preview" controls style="width:100%;"></audio>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button type="button" onclick="rerecord()" style="background:#eee; color:#333; padding:8px 14px; border:none; border-radius:3px; cursor:pointer; font-size:13px;">🔄 Re-record</button>
        <button type="button" onclick="submitAudio()" id="submit-btn" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:3px; cursor:pointer; font-size:13px; font-weight:600; flex:1;">🎯 Transcribe + Create Draft</button>
      </div>
    </div>
  </div>

  <!-- Processing state -->
  <div id="processing-panel" style="display:none; padding:30px 0; text-align:center;">
    <div id="processing-icon" style="font-size:40px; margin-bottom:12px;">🎧</div>
    <div id="processing-status" style="font-size:16px; color:#0C1C36; font-weight:600;">Uploading audio…</div>
    <div id="processing-sub" style="font-size:12px; color:#888; margin-top:6px;">This can take 30-90 seconds depending on length.</div>

    <div style="margin-top:20px; max-width:400px; margin-left:auto; margin-right:auto;">
      <div style="background:#eee; height:6px; border-radius:3px; overflow:hidden;">
        <div id="processing-progress" style="background:linear-gradient(to right, #B79C62, #d4b979); height:100%; width:0%; transition:width 0.4s;"></div>
      </div>
    </div>

    <details id="transcript-preview" style="display:none; margin-top:24px; text-align:left; background:#fdf7f0; padding:12px 16px; border-radius:6px; border:1px solid #e8dbc0;">
      <summary style="cursor:pointer; font-weight:600; font-size:13px;">📝 Transcript preview</summary>
      <div id="transcript-text" style="font-size:13px; margin-top:8px; color:#333; white-space:pre-wrap; max-height:200px; overflow-y:auto;"></div>
    </details>
  </div>

  <div id="error-panel" style="display:none; background:#fee; color:#900; padding:15px; border-radius:6px; margin-top:15px; font-size:13px;">
    <strong>❌ Error:</strong> <span id="error-text"></span>
    <div style="margin-top:10px;">
      <button type="button" onclick="resetAll()" style="background:#eee; color:#333; padding:6px 12px; border:none; border-radius:3px; cursor:pointer; font-size:12px;">Start over</button>
    </div>
  </div>

</div>

<p style="margin-top:24px; color:#888; font-size:13px; text-align:center;">
  <a href="/admin/hearing/notes" style="color:#B79C62;">← Back to note-taking</a>
</p>

<script>
let mediaRecorder = null;
let chunks = [];
let recordStart = 0;
let timerInterval = null;
let audioBlob = null;
let audioMime = "audio/webm";
let audioExt = "webm";

async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 44100,
      },
    });

    // Pick best supported MIME. Chrome/Firefox → webm/opus; Safari → mp4.
    const preferredTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/mp4;codecs=mp4a.40.2",
    ];
    let selectedType = "";
    for (const t of preferredTypes) {
      if (MediaRecorder.isTypeSupported(t)) { selectedType = t; break; }
    }

    audioMime = selectedType || "audio/webm";
    audioExt = audioMime.includes("mp4") ? "mp4" : "webm";

    mediaRecorder = new MediaRecorder(stream, selectedType ? { mimeType: selectedType } : undefined);
    chunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      audioBlob = new Blob(chunks, { type: audioMime });
      // Stop all tracks to release the mic
      stream.getTracks().forEach(t => t.stop());
      showPlayback();
    };
    mediaRecorder.start();
    recordStart = Date.now();
    startTimer();
    document.getElementById("record-icon").textContent = "⏹️";
    document.getElementById("record-label").textContent = "Tap to stop";
    document.getElementById("record-btn").style.background = "linear-gradient(145deg, #c62828, #8b1a1a)";
    document.getElementById("record-btn").style.boxShadow = "0 8px 24px rgba(198,40,40,0.4)";
    document.getElementById("record-hint").textContent = "Recording… speak clearly";
  } catch (e) {
    showError("Microphone access denied or unavailable. " + e.message);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  stopTimer();
}

function startTimer() {
  timerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - recordStart) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    document.getElementById("timer").textContent = mm + ":" + ss;
    // Warn if approaching Whisper's 25MB limit (~30 min at 128kbps)
    if (sec > 25 * 60) {
      document.getElementById("record-hint").textContent = "⚠️ Getting long. Whisper limit is ~30 min. Consider stopping and starting a new recording.";
    }
  }, 250);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function showPlayback() {
  document.getElementById("record-panel").style.display = "none";
  document.getElementById("playback-panel").style.display = "block";
  const audio = document.getElementById("audio-preview");
  audio.src = URL.createObjectURL(audioBlob);
}

function rerecord() {
  audioBlob = null;
  document.getElementById("audio-preview").src = "";
  document.getElementById("playback-panel").style.display = "none";
  document.getElementById("record-panel").style.display = "block";
  document.getElementById("timer").textContent = "00:00";
  document.getElementById("record-icon").textContent = "🎙️";
  document.getElementById("record-label").textContent = "Tap to record";
  document.getElementById("record-btn").style.background = "linear-gradient(145deg, #B79C62, #8f7a4c)";
  document.getElementById("record-btn").style.boxShadow = "0 8px 24px rgba(183,156,98,0.3)";
  document.getElementById("record-hint").textContent = "Tips: mention client name, A-number, judge, DHS attorney, pleadings, applications, next hearing date, and any deadlines.";
}

function resetAll() {
  document.getElementById("error-panel").style.display = "none";
  document.getElementById("processing-panel").style.display = "none";
  rerecord();
}

function updateProgress(status, sub, pct, icon = "🎧") {
  document.getElementById("processing-status").textContent = status;
  document.getElementById("processing-sub").textContent = sub;
  document.getElementById("processing-progress").style.width = pct + "%";
  document.getElementById("processing-icon").textContent = icon;
}

async function submitAudio() {
  if (!audioBlob) return;
  document.getElementById("playback-panel").style.display = "none";
  document.getElementById("processing-panel").style.display = "block";

  updateProgress("Uploading audio…", "Sending to server", 15, "📤");

  const formData = new FormData();
  const fname = "dictation-" + Date.now() + "." + audioExt;
  formData.append("audio", audioBlob, fname);
  formData.append("client_name", document.getElementById("hint-client-name").value.trim());
  formData.append("a_number", document.getElementById("hint-a-number").value.trim());
  formData.append("hearing_type", document.getElementById("hint-hearing-type").value);

  try {
    const resp = await fetch("/admin/hearing/notes/dictate/process", {
      method: "POST",
      body: formData,
    });

    // Server streams progress updates via chunked response? Not for now —
    // just wait for final response. Show interim updates via setTimeout.
    setTimeout(() => updateProgress("Whisper transcribing…", "Converting speech to text", 45, "🎧"), 2000);
    setTimeout(() => updateProgress("Claude extracting fields…", "Structuring the hearing notes", 75, "🧠"), 8000);

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error("Server returned non-JSON: " + text.substring(0, 200)); }

    if (!resp.ok || !data.ok) {
      throw new Error(data.error || ("HTTP " + resp.status));
    }

    // Show transcript preview
    if (data.transcript) {
      document.getElementById("transcript-preview").style.display = "block";
      document.getElementById("transcript-text").textContent = data.transcript;
    }
    updateProgress("Draft created!", "Redirecting…", 100, "✅");
    setTimeout(() => {
      window.location.href = "/admin/hearing/notes/" + data.note_id + "?saved=1&from=dictate";
    }, 1200);

  } catch (e) {
    showError(e.message);
  }
}

function showError(msg) {
  document.getElementById("processing-panel").style.display = "none";
  document.getElementById("playback-panel").style.display = "none";
  document.getElementById("record-panel").style.display = "block";
  document.getElementById("error-panel").style.display = "block";
  document.getElementById("error-text").textContent = msg;
}

// Check mic support up front
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  showError("Your browser doesn't support audio recording. Try Chrome, Safari, or Firefox on a modern OS.");
}
</script>
`;
  return hn.renderAdminChrome({ title: "Voice Dictation", body, activeItem: null });
}

module.exports = {
  transcribeAudio,
  extractFieldsFromTranscript,
  renderDictatePage,
};
