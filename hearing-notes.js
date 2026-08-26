// ============================================================
//  TEZ LAW P.C. — HEARING NOTES
//  ─────────────────────────────────────────────────────────
//  Structured note-taking tool for USE DURING master calendar
//  (and other) hearings. Attorney takes notes on laptop, Zara
//  cleans them up and produces two outputs:
//    1. Paralegal summary — complete, structured, professional
//    2. Client summary — in client's language, plain language
//
//  Delivery:
//    - Paralegal: Telegram to Jue (via RECIPIENT_JUE_TELEGRAM_ID)
//    - Client: copy-to-clipboard (paste into WhatsApp, email, etc.)
//    - Both: copy buttons available always
//
//  No SMTP send yet (waiting on GoDaddy resolution).
// ============================================================

const axios = require("axios");
const db = require("./db");

const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// ── Schema ───────────────────────────────────────────────

async function initHearingNotesTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS hearing_notes (
      id                    SERIAL PRIMARY KEY,
      client_name           TEXT NOT NULL,
      a_number              TEXT,
      client_language       TEXT DEFAULT 'en',
      client_email          TEXT,
      client_phone          TEXT,
      judge_name            TEXT,
      hearing_date          TIMESTAMPTZ,
      hearing_type          TEXT DEFAULT 'master',
      case_type             TEXT,
      pleadings_admitted    TEXT,
      pleadings_denied      TEXT,
      pleadings_contested   TEXT,
      removability_conceded BOOLEAN,
      applications          JSONB DEFAULT '[]'::jsonb,
      next_hearing_date     TIMESTAMPTZ,
      next_hearing_type     TEXT,
      interpreter_used      BOOLEAN,
      interpreter_language  TEXT,
      deadlines             JSONB DEFAULT '[]'::jsonb,
      raw_notes             TEXT,
      paralegal_summary     TEXT,
      client_summary        TEXT,
      sent_to_paralegal_at  TIMESTAMPTZ,
      sent_to_client_at     TIMESTAMPTZ,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_hearing_notes_created
      ON hearing_notes (created_at DESC)
  `);
}

// ── AI Summary Generation ────────────────────────────────

async function generateParalegalSummary(data) {
  const structured = buildStructuredNotes(data);

  const prompt = `You are cleaning up immigration court hearing notes for a paralegal at Tez Law, P.C.

The attorney (JJ Zhang) took these notes during the hearing. Your job is to produce a clean, professional summary the paralegal (Jue Wang) can use to update the case file.

Rules:
- Complete and detailed — include ALL information provided
- Structured with clear headings
- Professional attorney-to-paralegal tone (efficient, factual)
- Preserve ALL specific dates, deadlines, allegation numbers, and case details exactly
- Do NOT invent or embellish — only use what's in the notes
- Do NOT add "Please note" or "Kindly" language — direct and efficient
- Use bullet points where appropriate for scannability
- End with an "Action Items" section listing what the paralegal needs to do

Structured hearing data:
${structured}

Attorney's raw notes:
${data.raw_notes || "(no additional notes)"}

Produce the paralegal summary now. Start directly with the summary — no preamble.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
    return resp.data.content?.[0]?.text?.trim() || "(summary generation failed)";
  } catch (e) {
    console.error("[hearing-notes] Paralegal summary error:", e.message);
    return `AI cleanup unavailable. Raw notes below:\n\n${structured}\n\n---\n\n${data.raw_notes || ""}`;
  }
}

async function generateClientSummary(data) {
  const lang = data.client_language || "en";
  const langNames = {
    en: "English",
    zh: "Simplified Chinese (中文)",
    es: "Spanish (Español)",
    hi: "Hindi (हिन्दी)",
    pa: "Punjabi (ਪੰਜਾਬੀ)",
  };
  const languageName = langNames[lang] || "English";

  const structured = buildStructuredNotes(data);

  const prompt = `You are writing a client-friendly hearing summary in ${languageName}.

The client attended their immigration court hearing today with attorney JJ Zhang of Tez Law, P.C. Your job is to write a warm but professional summary explaining what happened and what they need to do next.

Rules:
- Write ENTIRELY in ${languageName}
- Plain language — no legalese, no Latin phrases
- Warm and reassuring tone but professional
- Focus on: what happened, what deadlines the client needs to remember, what they need to do next
- Include specific dates and deadlines with clear context
- Do NOT invent information — only what's in the notes
- End with attorney contact info: "If you have questions, please contact us at 626-678-8677 or jj@tezlawfirm.com" (translate this line too)
- If interpreter was used, mention this positively
- Address the client directly ("You" / "您" / "Usted" / "आप" / "ਤੁਸੀਂ")
- Sign off with "Sincerely, Attorney JJ Zhang, Tez Law, P.C." (translate)

Client's name: ${data.client_name}

Hearing details (in English — you translate the relevant parts):
${structured}

Attorney's raw notes:
${data.raw_notes || "(no additional notes)"}

Produce the client summary in ${languageName} now. Start directly with the greeting.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
    return resp.data.content?.[0]?.text?.trim() || "(summary generation failed)";
  } catch (e) {
    console.error("[hearing-notes] Client summary error:", e.message);
    return "(AI summary unavailable — please write manually)";
  }
}

// Build a structured representation of the notes data for AI prompting
function buildStructuredNotes(data) {
  const lines = [
    `Client: ${data.client_name || "(not provided)"}`,
    `A-Number: ${data.a_number || "(not provided)"}`,
    `Judge: ${data.judge_name || "(not provided)"}`,
    `Hearing date: ${data.hearing_date ? new Date(data.hearing_date).toLocaleString() : "(not provided)"}`,
    `Hearing type: ${data.hearing_type || "master"}`,
    `Case type: ${data.case_type || "(not specified)"}`,
    "",
    "PLEADINGS TAKEN:",
    `  Admitted allegations: ${data.pleadings_admitted || "(none noted)"}`,
    `  Denied allegations: ${data.pleadings_denied || "(none noted)"}`,
    `  Contested allegations: ${data.pleadings_contested || "(none noted)"}`,
    `  Removability conceded: ${data.removability_conceded ? "Yes" : "No"}`,
    "",
    `APPLICATIONS REQUESTED: ${(data.applications && data.applications.length) ? data.applications.join(", ") : "(none noted)"}`,
    "",
    "NEXT HEARING:",
    `  Type: ${data.next_hearing_type || "(not scheduled)"}`,
    `  Date/time: ${data.next_hearing_date ? new Date(data.next_hearing_date).toLocaleString() : "(not scheduled)"}`,
    "",
    `INTERPRETER: ${data.interpreter_used ? `Yes (${data.interpreter_language || "language not noted"})` : "No"}`,
    "",
    "DEADLINES SET:",
  ];
  if (data.deadlines && data.deadlines.length) {
    for (const d of data.deadlines) {
      lines.push(`  • ${d.date || "(date TBD)"}: ${d.description || "(no description)"}`);
    }
  } else {
    lines.push("  (none noted)");
  }
  return lines.join("\n");
}

// ── Storage ──────────────────────────────────────────────

async function saveNote(data, { generateSummaries = true } = {}) {
  await initHearingNotesTables();

  let paralegal_summary = null;
  let client_summary = null;

  if (generateSummaries) {
    // Generate both in parallel to save time
    const [pSum, cSum] = await Promise.all([
      generateParalegalSummary(data),
      generateClientSummary(data),
    ]);
    paralegal_summary = pSum;
    client_summary = cSum;
  }

  const r = await db.query(
    `INSERT INTO hearing_notes
      (client_name, a_number, client_language, client_email, client_phone,
       judge_name, hearing_date, hearing_type, case_type,
       pleadings_admitted, pleadings_denied, pleadings_contested, removability_conceded,
       applications, next_hearing_date, next_hearing_type,
       interpreter_used, interpreter_language, deadlines,
       raw_notes, paralegal_summary, client_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19::jsonb,
             $20, $21, $22)
     RETURNING id`,
    [
      data.client_name, data.a_number || null, data.client_language || "en",
      data.client_email || null, data.client_phone || null,
      data.judge_name || null, data.hearing_date || null,
      data.hearing_type || "master", data.case_type || null,
      data.pleadings_admitted || null, data.pleadings_denied || null,
      data.pleadings_contested || null, !!data.removability_conceded,
      JSON.stringify(data.applications || []),
      data.next_hearing_date || null, data.next_hearing_type || null,
      !!data.interpreter_used, data.interpreter_language || null,
      JSON.stringify(data.deadlines || []),
      data.raw_notes || null, paralegal_summary, client_summary,
    ]
  );
  return { id: r.rows[0].id, paralegal_summary, client_summary };
}

async function listNotes(limit = 50) {
  await initHearingNotesTables();
  const r = await db.query(
    `SELECT id, client_name, a_number, hearing_date, next_hearing_date, next_hearing_type,
       client_language, sent_to_paralegal_at, sent_to_client_at, created_at
     FROM hearing_notes
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getNote(id) {
  await initHearingNotesTables();
  const r = await db.query(`SELECT * FROM hearing_notes WHERE id = $1`, [id]);
  return r.rows[0];
}

// ── Telegram Send ────────────────────────────────────────

async function sendToParalegal(id) {
  const note = await getNote(id);
  if (!note) throw new Error(`Note ${id} not found`);
  if (!note.paralegal_summary) throw new Error("No paralegal summary generated");

  const telegramId = process.env.RECIPIENT_JUE_TELEGRAM_ID;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!telegramId || !telegramToken) {
    throw new Error("Telegram not configured. Set RECIPIENT_JUE_TELEGRAM_ID env var (Jue's Telegram numeric user ID).");
  }

  const header = `📋 *Hearing Notes — ${note.client_name}*\nA#: ${note.a_number || "(none)"}\nDate: ${note.hearing_date ? new Date(note.hearing_date).toLocaleDateString() : "(not set)"}\n\n`;
  const message = header + note.paralegal_summary;

  // Telegram has a 4096 char limit per message
  const chunks = [];
  const MAX = 4000;
  let remaining = message;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf("\n\n", MAX);
    if (cut < 1000) cut = remaining.lastIndexOf("\n", MAX);
    if (cut < 1000) cut = MAX;
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trim();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    await axios.post(
      `https://api.telegram.org/bot${telegramToken}/sendMessage`,
      {
        chat_id: telegramId,
        text: chunk,
        parse_mode: "Markdown",
      },
      { timeout: 15000 }
    );
  }

  await db.query(
    `UPDATE hearing_notes SET sent_to_paralegal_at = NOW() WHERE id = $1`,
    [id]
  );

  return { sent: true, chunks: chunks.length };
}

// ── HTML: Note-Taking Form ───────────────────────────────

const APPLICATION_OPTIONS = [
  "I-589 Asylum",
  "Withholding of Removal",
  "CAT (Convention Against Torture)",
  "Cancellation of Removal (LPR)",
  "Cancellation of Removal (non-LPR)",
  "Adjustment of Status",
  "Voluntary Departure",
  "Prosecutorial Discretion",
  "Termination",
  "Administrative Closure",
  "Other",
];

function renderNoteForm({ generated = null, saved = false, sent = null, error = null, prev = {} } = {}) {
  const langOptions = [
    { v: "en", l: "English" },
    { v: "zh", l: "中文 (Chinese)" },
    { v: "es", l: "Español (Spanish)" },
    { v: "hi", l: "हिन्दी (Hindi)" },
    { v: "pa", l: "ਪੰਜਾਬੀ (Punjabi)" },
  ].map(o => `<option value="${o.v}" ${prev.client_language === o.v ? "selected" : ""}>${o.l}</option>`).join("");

  const hearingTypeOptions = [
    "master", "individual/merits", "status", "bond", "custody redetermination", "other"
  ].map(t => `<option value="${t}" ${prev.hearing_type === t ? "selected" : ""}>${t}</option>`).join("");

  const nextHearingTypeOptions = [
    "", "master", "individual/merits", "status", "bond", "hearing on motion", "other"
  ].map(t => `<option value="${t}" ${prev.next_hearing_type === t ? "selected" : ""}>${t || "(none scheduled)"}</option>`).join("");

  const prevApps = prev.applications || [];
  const applicationCheckboxes = APPLICATION_OPTIONS.map((app, i) => `
    <label style="display:inline-flex; align-items:center; font-weight:normal; margin:4px 12px 4px 0;">
      <input type="checkbox" name="application_${i}" value="${escapeAttr(app)}" ${prevApps.includes(app) ? "checked" : ""}>
      ${escapeHtml(app)}
    </label>`).join("");

  const errorSection = error ? `
    <div style="background:#ffebee; padding:15px; border-left:4px solid #c00; margin:15px 0; border-radius:4px;">
      <strong>⚠️ Error:</strong> ${escapeHtml(error)}
    </div>` : "";

  const previewSection = generated ? `
    <div style="background:#f5f9ff; padding:20px; margin:20px 0; border-left:4px solid #0C1C36; border-radius:4px;">
      <h2 style="margin-top:0;">📋 Paralegal Summary (English, detailed)</h2>
      <pre id="paralegal-content" style="white-space:pre-wrap; font-family:inherit; margin:0; background:white; padding:15px; border-radius:4px;">${escapeHtml(generated.paralegal_summary || "")}</pre>
      <div style="margin-top:12px;">
        <button type="button" onclick="copyContent('paralegal-content')" style="background:#0C1C36; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">📋 Copy Paralegal Summary</button>
        ${generated.id ? `
        <button type="button" onclick="sendParalegal(${generated.id})" style="background:#4CAF50; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer; margin-left:8px;">📤 Send to Jue via Telegram</button>
        <span id="send-status" style="margin-left:12px; font-weight:bold;"></span>
        ` : ""}
      </div>
    </div>

    <div style="background:#fdf7f0; padding:20px; margin:20px 0; border-left:4px solid #B79C62; border-radius:4px;">
      <h2 style="margin-top:0;">👤 Client Summary (in client's language)</h2>
      <pre id="client-content" style="white-space:pre-wrap; font-family:inherit; margin:0; background:white; padding:15px; border-radius:4px;">${escapeHtml(generated.client_summary || "")}</pre>
      <div style="margin-top:12px;">
        <button type="button" onclick="copyContent('client-content')" style="background:#B79C62; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">📋 Copy Client Summary</button>
        <span style="margin-left:12px; color:#666; font-size:13px;">Paste into WhatsApp, Telegram, or email to send to client</span>
      </div>
    </div>

    ${saved ? '<p style="color:#4CAF50; font-weight:bold;">✅ Saved to database.</p>' : ""}
    ${sent ? `<p style="color:#4CAF50; font-weight:bold;">📤 Sent to Jue via Telegram (${sent.chunks} message${sent.chunks > 1 ? "s" : ""}).</p>` : ""}
  ` : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Hearing Notes — Tez Law Zara</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 900px; margin: 20px auto; padding: 20px; color: #333; }
    h1 { color: #0C1C36; border-bottom: 3px solid #B79C62; padding-bottom: 10px; }
    h2 { color: #B79C62; }
    label { display: block; margin: 10px 0 4px; font-weight: 600; font-size: 14px; }
    input[type="text"], input[type="datetime-local"], input[type="date"], select, textarea {
      width: 100%; padding: 8px; margin: 3px 0; box-sizing: border-box;
      border: 1px solid #ccc; border-radius: 4px; font-size: 14px; font-family: inherit;
    }
    textarea { min-height: 60px; }
    input[type="checkbox"] { margin-right: 6px; transform: scale(1.15); }
    .row { display: flex; gap: 12px; margin: 6px 0; }
    .row > div { flex: 1; }
    fieldset { border: 1px solid #ddd; padding: 15px; margin: 15px 0; border-radius: 4px; }
    legend { font-weight: 600; color: #0C1C36; padding: 0 8px; }
    .button-row { margin-top: 25px; display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      padding: 12px 24px; font-size: 15px; border-radius: 4px; cursor: pointer;
      border: none; font-family: inherit;
    }
    button[type="submit"] { background: #B79C62; color: white; }
    button[type="submit"]:hover { background: #8f7a4c; }
    button.secondary { background: #eee; color: #333; }
    #raw_notes { min-height: 200px; font-family: monospace; font-size: 14px; }
    .deadlines-container { margin: 8px 0; }
    .deadline-row { display: flex; gap: 8px; margin: 6px 0; }
    .deadline-row input[type="date"] { flex: 0 0 160px; }
    .deadline-row input[type="text"] { flex: 1; }
    .deadline-row button { flex: 0 0 auto; padding: 4px 10px; background: #eee; border: none; cursor: pointer; border-radius: 4px; }
    .add-deadline { background: #eee; padding: 6px 12px; border: none; cursor: pointer; border-radius: 4px; font-size: 13px; }
    .hint { color: #666; font-size: 12px; font-style: italic; margin: 2px 0; }
  </style>
</head>
<body>
  <h1>📝 Hearing Notes</h1>
  <p>Take notes during the hearing. Zara will clean them up and generate a paralegal summary + client-friendly summary in the client's language.</p>

  ${errorSection}
  ${previewSection}

  <form method="POST" action="/admin/hearing/notes">
    <fieldset>
      <legend>Client & Hearing</legend>
      <div class="row">
        <div>
          <label>Client name *</label>
          <input type="text" name="client_name" required value="${escapeAttr(prev.client_name)}" placeholder="e.g. Chen, Xifen">
        </div>
        <div>
          <label>A-Number</label>
          <input type="text" name="a_number" value="${escapeAttr(prev.a_number)}" placeholder="A123-456-789">
        </div>
      </div>
      <div class="row">
        <div>
          <label>Client's language (for client summary)</label>
          <select name="client_language">${langOptions}</select>
        </div>
        <div>
          <label>Hearing type</label>
          <select name="hearing_type">${hearingTypeOptions}</select>
        </div>
      </div>
      <div class="row">
        <div>
          <label>Judge</label>
          <input type="text" name="judge_name" value="${escapeAttr(prev.judge_name)}" placeholder="e.g. Hon. Kevin Riley">
        </div>
        <div>
          <label>Hearing date/time</label>
          <input type="datetime-local" name="hearing_date" value="${escapeAttr(prev.hearing_date)}">
        </div>
      </div>
      <label>Case type</label>
      <input type="text" name="case_type" value="${escapeAttr(prev.case_type)}" placeholder="e.g. Asylum (I-589), Cancellation of Removal">
    </fieldset>

    <fieldset>
      <legend>Pleadings Taken</legend>
      <div class="row">
        <div>
          <label>Allegations admitted</label>
          <input type="text" name="pleadings_admitted" value="${escapeAttr(prev.pleadings_admitted)}" placeholder="e.g. 1, 2, 3">
        </div>
        <div>
          <label>Allegations denied</label>
          <input type="text" name="pleadings_denied" value="${escapeAttr(prev.pleadings_denied)}" placeholder="e.g. 4, 5">
        </div>
        <div>
          <label>Allegations contested</label>
          <input type="text" name="pleadings_contested" value="${escapeAttr(prev.pleadings_contested)}" placeholder="e.g. 6">
        </div>
      </div>
      <label style="display:inline-flex; align-items:center; font-weight:normal; margin-top:8px;">
        <input type="checkbox" name="removability_conceded" value="1" ${prev.removability_conceded ? "checked" : ""}>
        Removability conceded
      </label>
    </fieldset>

    <fieldset>
      <legend>Applications Requested</legend>
      <div style="display:flex; flex-wrap:wrap;">${applicationCheckboxes}</div>
    </fieldset>

    <fieldset>
      <legend>Next Hearing</legend>
      <div class="row">
        <div>
          <label>Type</label>
          <select name="next_hearing_type">${nextHearingTypeOptions}</select>
        </div>
        <div>
          <label>Date/time</label>
          <input type="datetime-local" name="next_hearing_date" value="${escapeAttr(prev.next_hearing_date)}">
        </div>
      </div>
    </fieldset>

    <fieldset>
      <legend>Interpreter</legend>
      <label style="display:inline-flex; align-items:center; font-weight:normal;">
        <input type="checkbox" name="interpreter_used" value="1" ${prev.interpreter_used ? "checked" : ""}>
        Interpreter used
      </label>
      <label>Interpreter language (if used)</label>
      <input type="text" name="interpreter_language" value="${escapeAttr(prev.interpreter_language)}" placeholder="e.g. Mandarin, Spanish, Punjabi">
    </fieldset>

    <fieldset>
      <legend>Deadlines Set</legend>
      <div class="hint">Add each deadline the judge set — filing deadlines, biometrics, evidence submission, etc.</div>
      <div id="deadlines-container" class="deadlines-container"></div>
      <button type="button" class="add-deadline" onclick="addDeadlineRow()">+ Add deadline</button>
    </fieldset>

    <fieldset>
      <legend>Free-Form Notes</legend>
      <div class="hint">Rough notes — Zara will clean these up. Include whatever you observed: what DHS attorney said, judge's comments, client demeanor, evidence issues, strategy thoughts, etc.</div>
      <textarea name="raw_notes" id="raw_notes" placeholder="Type or paste rough notes here...">${escapeHtml(prev.raw_notes || "")}</textarea>
    </fieldset>

    <div class="button-row">
      <button type="submit" name="action" value="preview">✨ Generate Summaries (Preview)</button>
      <button type="submit" name="action" value="save">💾 Generate + Save</button>
      <button type="reset" class="secondary">Clear form</button>
    </div>
  </form>

  <p style="margin-top:30px; color:#888; font-size:13px;">
    <a href="/admin/hearing/notes/history">View past hearing notes →</a>
  </p>

  <script>
    // Deadline rows
    let deadlineIndex = 0;
    function addDeadlineRow(date, desc) {
      const container = document.getElementById("deadlines-container");
      const row = document.createElement("div");
      row.className = "deadline-row";
      row.innerHTML =
        '<input type="date" name="deadline_date_' + deadlineIndex + '" value="' + (date || "") + '">' +
        '<input type="text" name="deadline_desc_' + deadlineIndex + '" placeholder="Description (e.g. File I-589)" value="' + (desc || "") + '">' +
        '<button type="button" onclick="this.parentElement.remove()">×</button>';
      container.appendChild(row);
      deadlineIndex++;
    }

    // Load previous deadlines if any
    const prevDeadlines = ${JSON.stringify(prev.deadlines || [])};
    if (prevDeadlines.length === 0) {
      addDeadlineRow();
    } else {
      prevDeadlines.forEach(d => addDeadlineRow(d.date, d.description));
    }

    function copyContent(id) {
      const el = document.getElementById(id);
      navigator.clipboard.writeText(el.textContent);
      const status = document.createElement("span");
      status.textContent = " ✅ Copied";
      status.style.color = "#4CAF50";
      status.style.marginLeft = "8px";
      el.parentElement.appendChild(status);
      setTimeout(() => status.remove(), 2000);
    }

    async function sendParalegal(id) {
      const status = document.getElementById("send-status");
      status.textContent = "Sending...";
      status.style.color = "#666";
      try {
        const resp = await fetch("/admin/hearing/notes/" + id + "/send-paralegal", { method: "POST" });
        const data = await resp.json();
        if (data.ok) {
          status.textContent = "✅ Sent to Jue via Telegram";
          status.style.color = "#4CAF50";
        } else {
          status.textContent = "❌ " + (data.error || "Send failed");
          status.style.color = "#c00";
        }
      } catch (e) {
        status.textContent = "❌ " + e.message;
        status.style.color = "#c00";
      }
    }
  </script>
</body>
</html>`;
}

function renderHistoryPage(notes) {
  const rows = notes.length ? notes.map(n => `
    <tr>
      <td>#${n.id}</td>
      <td>${escapeHtml(n.client_name)}</td>
      <td>${escapeHtml(n.a_number || "")}</td>
      <td>${n.hearing_date ? new Date(n.hearing_date).toLocaleDateString() : "-"}</td>
      <td>${n.next_hearing_date ? new Date(n.next_hearing_date).toLocaleDateString() : "-"}</td>
      <td>${escapeHtml(n.next_hearing_type || "-")}</td>
      <td>${n.client_language}</td>
      <td>${n.sent_to_paralegal_at ? "✅" : "—"}</td>
      <td>${new Date(n.created_at).toLocaleDateString()}</td>
      <td><a href="/admin/hearing/notes/${n.id}">view</a></td>
    </tr>`).join("") : `<tr><td colspan="10" style="text-align:center; color:#888;">No hearing notes yet.</td></tr>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Hearing Notes History — Tez Law Zara</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1200px; margin: 30px auto; padding: 20px; }
    h1 { color: #0C1C36; border-bottom: 3px solid #B79C62; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f5f5f5; color: #0C1C36; }
    tr:hover { background: #fafafa; }
    a.button { display: inline-block; padding: 10px 20px; background: #B79C62; color: white; text-decoration: none; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>📝 Hearing Notes History</h1>
  <p><a href="/admin/hearing/notes" class="button">← Back to note-taking</a></p>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Client</th><th>A#</th><th>Hearing</th>
        <th>Next</th><th>Next Type</th><th>Client Lang</th>
        <th>Sent Jue</th><th>Created</th><th></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function renderDetailPage(note) {
  if (!note) return `<html><body><h1>Not found</h1><p><a href="/admin/hearing/notes/history">← Back</a></p></body></html>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Hearing #${note.id} — Tez Law Zara</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 900px; margin: 30px auto; padding: 20px; }
    h1 { color: #0C1C36; border-bottom: 3px solid #B79C62; padding-bottom: 10px; }
    h2 { color: #B79C62; margin-top: 30px; }
    .meta { background: #f5f5f5; padding: 15px; border-radius: 4px; margin: 15px 0; }
    .meta div { margin: 4px 0; }
    pre { background: white; padding: 15px; border: 1px solid #ddd; border-radius: 4px;
          white-space: pre-wrap; font-family: inherit; }
    button { background: #0C1C36; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1>Hearing #${note.id} — ${escapeHtml(note.client_name)}</h1>
  <p><a href="/admin/hearing/notes/history">← History</a> · <a href="/admin/hearing/notes">New note</a></p>

  <div class="meta">
    <div><strong>Client:</strong> ${escapeHtml(note.client_name)}</div>
    <div><strong>A-Number:</strong> ${escapeHtml(note.a_number || "-")}</div>
    <div><strong>Hearing:</strong> ${note.hearing_date ? new Date(note.hearing_date).toLocaleString() : "-"} (${escapeHtml(note.hearing_type || "master")})</div>
    <div><strong>Judge:</strong> ${escapeHtml(note.judge_name || "-")}</div>
    <div><strong>Next hearing:</strong> ${note.next_hearing_date ? new Date(note.next_hearing_date).toLocaleString() : "not scheduled"} (${escapeHtml(note.next_hearing_type || "-")})</div>
    <div><strong>Client language:</strong> ${note.client_language}</div>
    <div><strong>Sent to Jue:</strong> ${note.sent_to_paralegal_at ? new Date(note.sent_to_paralegal_at).toLocaleString() : "not sent"}</div>
    <div><strong>Created:</strong> ${new Date(note.created_at).toLocaleString()}</div>
  </div>

  <h2>Paralegal Summary</h2>
  <button type="button" onclick="copyEl('paralegal-detail')">📋 Copy</button>
  <pre id="paralegal-detail">${escapeHtml(note.paralegal_summary || "(none)")}</pre>

  <h2>Client Summary (${note.client_language})</h2>
  <button type="button" onclick="copyEl('client-detail')">📋 Copy</button>
  <pre id="client-detail">${escapeHtml(note.client_summary || "(none)")}</pre>

  <h2>Original Raw Notes</h2>
  <pre>${escapeHtml(note.raw_notes || "(none)")}</pre>

  <script>
    function copyEl(id) {
      navigator.clipboard.writeText(document.getElementById(id).textContent);
      alert("Copied!");
    }
  </script>
</body>
</html>`;
}

// ── Form Parsing ─────────────────────────────────────────

function parseFormSubmission(body) {
  // Applications - collect all checked
  const applications = [];
  for (let i = 0; i < APPLICATION_OPTIONS.length; i++) {
    if (body[`application_${i}`]) applications.push(body[`application_${i}`]);
  }

  // Deadlines - collect indexed pairs
  const deadlines = [];
  const keys = Object.keys(body || {});
  const deadlineIndices = new Set();
  for (const k of keys) {
    const m = k.match(/^deadline_(?:date|desc)_(\d+)$/);
    if (m) deadlineIndices.add(parseInt(m[1]));
  }
  const sortedIndices = Array.from(deadlineIndices).sort((a, b) => a - b);
  for (const i of sortedIndices) {
    const date = body[`deadline_date_${i}`] || "";
    const desc = body[`deadline_desc_${i}`] || "";
    if (date || desc) deadlines.push({ date, description: desc });
  }

  return {
    client_name: (body.client_name || "").trim(),
    a_number: (body.a_number || "").trim(),
    client_language: body.client_language || "en",
    client_email: (body.client_email || "").trim() || null,
    client_phone: (body.client_phone || "").trim() || null,
    judge_name: (body.judge_name || "").trim(),
    hearing_date: body.hearing_date || null,
    hearing_type: body.hearing_type || "master",
    case_type: (body.case_type || "").trim(),
    pleadings_admitted: (body.pleadings_admitted || "").trim(),
    pleadings_denied: (body.pleadings_denied || "").trim(),
    pleadings_contested: (body.pleadings_contested || "").trim(),
    removability_conceded: !!body.removability_conceded,
    applications,
    next_hearing_date: body.next_hearing_date || null,
    next_hearing_type: body.next_hearing_type || null,
    interpreter_used: !!body.interpreter_used,
    interpreter_language: (body.interpreter_language || "").trim(),
    deadlines,
    raw_notes: (body.raw_notes || "").trim(),
  };
}

// ── HTML Escape ──────────────────────────────────────────

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Exports ──────────────────────────────────────────────

module.exports = {
  initHearingNotesTables,
  saveNote,
  listNotes,
  getNote,
  sendToParalegal,
  generateParalegalSummary,
  generateClientSummary,
  renderNoteForm,
  renderHistoryPage,
  renderDetailPage,
  parseFormSubmission,
  APPLICATION_OPTIONS,
};
