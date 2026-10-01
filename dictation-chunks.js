// ============================================================
//  dictation-chunks.js — THE RECORDING IS NEVER ONLY IN RAM
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  JJ: "i need to be able to save the voice dictation asap when
//  its stopped or constantly saving every 5 minutes?"
//
//  He is describing the hole exactly. voice-dictation.js called
//  mediaRecorder.start() with no timeslice, so ondataavailable
//  fired ONCE, at stop. For a ninety-minute merits hearing the
//  entire recording lived in one browser tab's memory until the
//  moment he pressed stop — and the moment a hearing ends is
//  precisely when the laptop gets shut.
//
//  Saving on stop (which the inbox already does) only helps if
//  you reach stop. This module covers the hour before it.
//
//  HOW:
//    · The browser records in short slices and uploads each one
//      as it is produced. A slice on the server cannot be lost
//      by closing a lid.
//    · Slices are stored individually, keyed by position, and
//      assembled only at the end. An upload that fails is
//      retried without disturbing the ones that landed.
//    · Nothing waits for the user to come back. sweepAbandoned()
//      assembles a session that went quiet, because the laptop
//      closing mid-hearing IS the expected ending, not an error.
//
//  WHY SLICES ASSEMBLE BY POSITION, AND WHY A GAP TRUNCATES:
//    A webm or mp4 stream from MediaRecorder carries its container
//    header in the FIRST slice only. Slices concatenated in order
//    from zero are a valid file; slices with a hole in the middle
//    are a valid file up to the hole and rubbish after it. So
//    assembly takes the contiguous run from 0 and stops at the
//    first missing index, and says so. Half a hearing that plays
//    is worth more than a whole one that does not.
// ============================================================

const db = () => require("./db");

// 15s slices, uploaded as they arrive. The exposure is one slice,
// not five minutes: a slice costs one small request, and the
// request JJ actually made ("every 5 minutes") would still lose up
// to five minutes of a hearing. There is no reason to prefer that.
const SLICE_MS = 15000;

// A session with no slice for this long is treated as over. Long
// enough that a tunnel or a wifi handover does not end a hearing,
// short enough that the audio is in the inbox before anyone looks.
const QUIET_MINUTES = 20;

let ready = null;
async function initTables() {
  if (ready) return ready;
  ready = (async () => {
    await db().query(`
      CREATE TABLE IF NOT EXISTS dictation_sessions (
        id            TEXT PRIMARY KEY,     -- generated in the browser
        user_id       INTEGER,
        user_name     TEXT,
        mime          TEXT,
        ext           TEXT,
        client_name   TEXT,
        a_number      TEXT,
        hearing_type  TEXT,
        started_at    TIMESTAMPTZ DEFAULT NOW(),
        last_slice_at TIMESTAMPTZ,
        finished_at   TIMESTAMPTZ,
        finished_by   TEXT,                 -- user | sweeper
        inbox_id      INTEGER,
        slice_count   INTEGER DEFAULT 0,
        bytes         BIGINT  DEFAULT 0,
        note          TEXT
      )
    `);
    await db().query(`
      CREATE TABLE IF NOT EXISTS dictation_slices (
        session_id  TEXT NOT NULL REFERENCES dictation_sessions(id) ON DELETE CASCADE,
        idx         INTEGER NOT NULL,
        bytes       BYTEA NOT NULL,
        received_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (session_id, idx)
      )
    `);
    await db().query(
      `CREATE INDEX IF NOT EXISTS dictation_sessions_open
         ON dictation_sessions (last_slice_at) WHERE finished_at IS NULL`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/** Open (or re-open) a session. Idempotent: the browser may retry. */
async function begin({ id, user = null, mime = "audio/webm", ext = "webm",
                       clientName = null, aNumber = null, hearingType = null } = {}) {
  await initTables();
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(String(id))) {
    throw new Error("a dictation session needs a plausible id");
  }
  await db().query(
    `INSERT INTO dictation_sessions
       (id, user_id, user_name, mime, ext, client_name, a_number, hearing_type, last_slice_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (id) DO UPDATE SET
       -- Hints can be typed after recording starts, so let them land late.
       -- Everything else is fixed at the first slice and must not move.
       client_name  = COALESCE(EXCLUDED.client_name,  dictation_sessions.client_name),
       a_number     = COALESCE(EXCLUDED.a_number,     dictation_sessions.a_number),
       hearing_type = COALESCE(EXCLUDED.hearing_type, dictation_sessions.hearing_type)`,
    [String(id), user && user.uid ? user.uid : null,
     user ? (user.n || user.u || null) : null, mime, ext,
     clientName || null, aNumber || null, hearingType || null]);
  return String(id);
}

/**
 * Store one slice.
 *
 * ON CONFLICT DO NOTHING, so a client that retries a slice it already
 * delivered (an ack lost on bad courthouse wifi) is harmless rather than a
 * duplicate in the middle of the audio.
 */
async function putSlice({ sessionId, idx, buffer }) {
  await initTables();
  const i = Number(idx);
  if (!Number.isInteger(i) || i < 0) throw new Error("slice index must be a whole number");
  if (!buffer || !buffer.length) throw new Error("slice is empty");

  const r = await db().query(
    `INSERT INTO dictation_slices (session_id, idx, bytes)
     VALUES ($1,$2,$3) ON CONFLICT (session_id, idx) DO NOTHING`,
    [String(sessionId), i, buffer]);

  if (r.rowCount > 0) {
    await db().query(
      `UPDATE dictation_sessions
          SET slice_count = slice_count + 1,
              bytes = bytes + $2,
              last_slice_at = NOW()
        WHERE id = $1`,
      [String(sessionId), buffer.length]);
  } else {
    // Still a sign of life, even though the bytes were already here.
    await db().query(
      `UPDATE dictation_sessions SET last_slice_at = NOW() WHERE id = $1`, [String(sessionId)]);
  }
  return { stored: r.rowCount > 0, idx: i };
}

/** Which slice indices the server already holds — lets a client skip re-sending. */
async function have(sessionId) {
  await initTables();
  const r = await db().query(
    `SELECT idx FROM dictation_slices WHERE session_id = $1 ORDER BY idx`, [String(sessionId)]);
  return r.rows.map(x => x.idx);
}

/**
 * Assemble the contiguous run of slices from 0 and hand it to the inbox.
 *
 * Safe to call twice: a finished session returns its existing inbox id rather
 * than creating a second copy. The browser calls this on stop; the sweeper
 * calls it when the browser never did.
 */
async function finish({ sessionId, by = "user", hints = {} } = {}) {
  await initTables();
  const sR = await db().query(`SELECT * FROM dictation_sessions WHERE id = $1`, [String(sessionId)]);
  const s = sR.rows[0];
  if (!s) throw new Error("no such dictation session");
  if (s.finished_at) return { ok: true, already: true, inbox_id: s.inbox_id, note: s.note };

  const r = await db().query(
    `SELECT idx, bytes FROM dictation_slices WHERE session_id = $1 ORDER BY idx`, [String(sessionId)]);
  if (!r.rows.length) {
    await db().query(
      `UPDATE dictation_sessions
          SET finished_at = NOW(), finished_by = $2, note = $3 WHERE id = $1`,
      [String(sessionId), by, "no audio ever arrived"]);
    return { ok: false, inbox_id: null, note: "no audio ever arrived" };
  }

  // Contiguous from zero only — see the header for why a hole truncates.
  const parts = [];
  let expected = 0;
  let dropped = 0;
  for (const row of r.rows) {
    if (row.idx !== expected) { dropped = r.rows.length - parts.length; break; }
    parts.push(row.bytes);
    expected++;
  }
  const note = dropped
    ? `a slice did not arrive, so this is the first ${parts.length} of ${r.rows.length} slices`
    : null;

  if (!parts.length) {
    await db().query(
      `UPDATE dictation_sessions SET finished_at = NOW(), finished_by = $2, note = $3 WHERE id = $1`,
      [String(sessionId), by, "the first slice never arrived, so nothing can be assembled"]);
    return { ok: false, inbox_id: null, note: "the first slice never arrived, so nothing can be assembled" };
  }

  const audio = Buffer.concat(parts);
  const stamp = new Date(s.started_at || Date.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const inbox = require("./dictation-inbox");
  const saved = await inbox.save({
    buffer: audio,
    filename: `dictation-${stamp}.${s.ext || "webm"}`,
    clientName: hints.clientName || s.client_name,
    aNumber: hints.aNumber || s.a_number,
    hearingType: hints.hearingType || s.hearing_type,
    user: s.user_id ? { uid: s.user_id, n: s.user_name } : null,
  });
  const inboxId = saved ? saved.id : null;

  await db().query(
    `UPDATE dictation_sessions
        SET finished_at = NOW(), finished_by = $2, inbox_id = $3, note = $4 WHERE id = $1`,
    [String(sessionId), by, inboxId || null, note]);
  // The bytes live in the inbox now. Keeping a second copy of a hearing's
  // audio in here would double the storage for no benefit.
  await db().query(`DELETE FROM dictation_slices WHERE session_id = $1`, [String(sessionId)]);

  return { ok: true, inbox_id: inboxId, bytes: audio.length, slices: parts.length, note };
}

/**
 * Finalize sessions that went quiet.
 *
 * This is the one that answers JJ's actual problem. The attorney shuts the
 * laptop the second the hearing ends; the page never gets to say "finish".
 * Nothing should be waiting for it to.
 */
async function sweepAbandoned({ quietMinutes = QUIET_MINUTES, limit = 20 } = {}) {
  await initTables();
  const r = await db().query(
    `SELECT id FROM dictation_sessions
      WHERE finished_at IS NULL
        AND last_slice_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY last_slice_at ASC
      LIMIT $2`,
    [String(quietMinutes), limit]);

  const out = { considered: r.rows.length, finished: 0, empty: 0, errors: [] };
  for (const row of r.rows) {
    try {
      const res = await finish({ sessionId: row.id, by: "sweeper" });
      if (res.ok) out.finished++; else out.empty++;
    } catch (e) {
      out.errors.push(`${row.id}: ${e.message}`);
    }
  }
  return out;
}

/** Open sessions, for the page and for a status line. */
async function open({ limit = 20 } = {}) {
  await initTables();
  const r = await db().query(
    `SELECT id, user_name, client_name, slice_count, bytes, started_at, last_slice_at
       FROM dictation_sessions WHERE finished_at IS NULL
      ORDER BY last_slice_at DESC LIMIT $1`, [limit]);
  return r.rows;
}

module.exports = {
  initTables, begin, putSlice, have, finish, sweepAbandoned, open,
  SLICE_MS, QUIET_MINUTES,
};
