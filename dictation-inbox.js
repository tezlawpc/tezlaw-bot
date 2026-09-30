// ============================================================
//  dictation-inbox.js — THE RECORDING IS SAFE BEFORE ANYTHING
//  ELSE HAPPENS
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  JJ: "the voice dictation converting to transcript is taking
//  too long. especially when hearing is over attorney needs to
//  close laptop right away and sometimes voice notes might be
//  lost before it finish transcribing."
//
//  Capture and transcription were the same step. An attorney
//  walking out of court had to keep a laptop open through a
//  Whisper pass and a Claude extraction — a minute or more —
//  and closing the lid lost the hearing note entirely.
//
//  They are now separate. Audio lands here FIRST, in one fast
//  write, and the page can be closed the moment it says saved.
//  Transcription happens afterwards: on a timer, or when
//  somebody presses the button back at the office.
//
//  The immediate path uses this too. "Transcribe now" also saves
//  the audio here before transcribing, so a failure halfway
//  through — a dead token, a Whisper timeout, a closed lid —
//  costs the transcription, never the recording.
//
//  Audio is held as bytes in Postgres, the same way e-sign holds
//  documents. It is deleted once a transcript exists, because
//  the transcript and the Dropbox copy are the durable records
//  and audio is large.
// ============================================================

const db = () => require("./db");

let ready = null;
async function initTable() {
  if (ready) return ready;
  ready = (async () => {
    await db().query(`
      CREATE TABLE IF NOT EXISTS dictation_inbox (
        id            SERIAL PRIMARY KEY,
        audio         BYTEA,
        filename      TEXT,
        bytes         INTEGER,
        client_name   TEXT,
        a_number      TEXT,
        hearing_type  TEXT,
        status        TEXT NOT NULL DEFAULT 'saved',  -- saved | working | done | failed
        attempts      INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        transcript_id INTEGER,
        note_id       INTEGER,
        recorded_by   TEXT,
        recorded_by_uid TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        started_at    TIMESTAMPTZ,
        finished_at   TIMESTAMPTZ
      )
    `);
    await db().query(
      `CREATE INDEX IF NOT EXISTS dictation_inbox_status ON dictation_inbox (status, created_at)`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/**
 * Put the audio somewhere durable. This is the only thing on the critical
 * path, and it does nothing slow on purpose — no transcription, no Dropbox,
 * no model call. One INSERT, then the attorney can shut the laptop.
 */
async function save({ buffer, filename, clientName, aNumber, hearingType, user }) {
  await initTable();
  if (!buffer || !buffer.length) throw new Error("No audio to save");
  const r = await db().query(
    `INSERT INTO dictation_inbox
       (audio, filename, bytes, client_name, a_number, hearing_type, recorded_by, recorded_by_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [buffer, filename || "dictation.webm", buffer.length,
     (clientName || "").trim() || null, (aNumber || "").trim() || null,
     (hearingType || "").trim() || null,
     user ? (user.n || user.u || null) : null, user ? String(user.uid || "") || null : null]);
  return r.rows[0];
}

/** One saved recording, audio included. */
async function get(id) {
  await initTable();
  const r = await db().query(`SELECT * FROM dictation_inbox WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

/** Recent recordings, without the audio bytes — the list must stay light. */
async function list({ limit = 50 } = {}) {
  await initTable();
  const r = await db().query(
    `SELECT id, filename, bytes, client_name, a_number, hearing_type, status, attempts,
            error, transcript_id, note_id, recorded_by, created_at, finished_at
       FROM dictation_inbox ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

async function counts() {
  await initTable();
  const r = await db().query(`SELECT status, COUNT(*)::int AS n FROM dictation_inbox GROUP BY status`);
  const out = { saved: 0, working: 0, done: 0, failed: 0 };
  for (const row of r.rows) out[row.status] = row.n;
  return out;
}

/**
 * Transcribe one saved recording and file it as a draft hearing note.
 *
 * This is the slow part, and it runs where nobody is waiting on it. The
 * sequence matches what the dictate page used to do inline; the difference is
 * only WHEN it happens and what it costs if it fails.
 *
 * The row is claimed before any work starts, so a timer sweep and somebody
 * pressing the button cannot transcribe the same recording twice.
 */
async function transcribeOne(id, { user = null } = {}) {
  await initTable();
  const claim = await db().query(
    `UPDATE dictation_inbox SET status = 'working', attempts = attempts + 1, started_at = NOW()
      WHERE id = $1 AND status IN ('saved', 'failed') RETURNING *`, [id]);
  if (!claim.rows.length) return { ok: false, skipped: true, reason: "already being transcribed, or already done" };
  const row = claim.rows[0];

  try {
    const T = require("./transcripts");
    const voice = require("./voice-dictation");
    const hn = require("./hearing-notes");

    const { row: trow } = await T.transcribeAndSave(row.audio, row.filename || "dictation.webm", {
      source: "master-dictation", user: user || { n: row.recorded_by, uid: row.recorded_by_uid },
      clientName: row.client_name, aNumber: row.a_number, nameNow: false,
    });
    const transcript = T.toText(trow);
    await db().query(`UPDATE dictation_inbox SET transcript_id = $2 WHERE id = $1`, [id, trow.id]);

    if (!transcript || transcript.trim().length < 5) {
      throw new Error("The transcript came back empty — the recording may have been silent or too quiet.");
    }

    const hint = { client_name: row.client_name, a_number: row.a_number, hearing_type: row.hearing_type };
    const [extracted] = await Promise.all([
      voice.extractFieldsFromTranscript(transcript, hint),
      T.nameSpeakers(trow.id, { recordedBy: row.recorded_by }).catch(() => null),
    ]);
    await T.finish(trow.id, { extracted }).catch(() => null);

    if (!extracted.client_name) {
      // The transcript IS saved and findable — that is the thing that matters.
      throw new Error(`No client name could be identified. The transcript is saved as #${trow.id}; assign it there.`);
    }

    const note = {
      client_name: extracted.client_name,
      a_number: extracted.a_number || row.a_number || null,
      client_language: extracted.client_language || null,
      hearing_type: extracted.hearing_type || row.hearing_type || null,
      hearing_datetime: extracted.hearing_datetime || new Date().toISOString(),
      judge_name: extracted.judge_name || null,
      court_location: extracted.court_location || null,
      pleadings_taken: !!extracted.pleadings_taken,
      pleadings_admitted: extracted.pleadings_admitted || null,
      pleadings_denied: extracted.pleadings_denied || null,
      pleadings_contested: extracted.pleadings_contested || null,
      pleadings_method: extracted.pleadings_method || null,
      removability_conceded: !!extracted.removability_conceded,
      applications: extracted.applications || [],
      asylum_fee_needed: !!extracted.asylum_fee_needed,
      biometrics_needed: !!extracted.biometrics_needed,
      disposition: extracted.disposition || null,
      disposition_notes: extracted.disposition_notes || null,
      next_hearing_date: extracted.next_hearing_date || null,
      next_hearing_type: extracted.next_hearing_type || null,
      deadlines: extracted.deadlines || [],
      raw_notes: extracted.raw_notes || transcript,
    };
    const saved = await hn.saveNote(note, { generateSummaries: false });
    try {
      await T.linkToNote([trow.id], { noteType: "master", noteId: saved.id,
        clientName: note.client_name, aNumber: note.a_number, byUid: null });
    } catch (e) { console.warn("[dictation-inbox] transcript link:", e.message); }

    // The audio has done its job: a transcript and a note exist, and
    // transcripts keeps its own Dropbox copy. Holding 30 MB per hearing in
    // Postgres after that is just cost.
    await db().query(
      `UPDATE dictation_inbox SET status='done', note_id=$2, audio=NULL, error=NULL, finished_at=NOW()
        WHERE id = $1`, [id, saved.id]);

    return { ok: true, id, note_id: saved.id, transcript_id: trow.id, was_duplicate: saved.was_duplicate, transcript };
  } catch (e) {
    // Audio is deliberately KEPT on failure — it is the only irreplaceable
    // thing here, and a failed transcription must stay retryable.
    await db().query(
      `UPDATE dictation_inbox SET status='failed', error=$2, finished_at=NOW() WHERE id = $1`,
      [id, String(e.message).slice(0, 500)]);
    return { ok: false, id, error: e.message };
  }
}

/** Work through what is waiting. Meant for a timer. */
async function processPending({ limit = 3, maxAttempts = 3 } = {}) {
  await initTable();
  const r = await db().query(
    `SELECT id FROM dictation_inbox
      WHERE status = 'saved' OR (status = 'failed' AND attempts < $2)
      ORDER BY created_at ASC LIMIT $1`, [limit, maxAttempts]);
  const out = { tried: 0, done: 0, failed: 0 };
  for (const row of r.rows) {
    out.tried++;
    const res = await transcribeOne(row.id);
    if (res.ok) out.done++; else if (!res.skipped) out.failed++;
  }
  return out;
}

module.exports = { initTable, save, get, list, counts, transcribeOne, processPending };
