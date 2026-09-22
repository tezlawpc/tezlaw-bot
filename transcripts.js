// ============================================================
//  transcripts.js — every voice recording's transcript, kept
// ------------------------------------------------------------
//  JJ: "for the voice transcript, it is not saving to each file when
//  its applied. at the minimum each case needs to save transcript if
//  there are any so can go back and read. It would be awesome if it
//  can be divided between each speaker for breakdown."
//
//  What was wrong: the dictation routes transcribed, handed the text to
//  the browser and forgot it. On a master note the text was pasted into
//  the notes box (kept only if the form was then saved); the individual
//  hearing form has no notes box at all, so "Apply" dropped it.
//
//  Now the transcript is saved the moment it is transcribed — before
//  anyone presses Apply or Discard — to the client it names, and linked
//  to the hearing note it is applied to. Speakers are separated by
//  OpenAI's diarizing model (gpt-4o-transcribe-diarize) and Zara names
//  them by role (Judge, the attorney, DHS counsel, the respondent,
//  interpreter); names can be corrected on the transcript page.
//
//  A recording can arrive in parts (the individual-hearing recorder
//  uploads a new part every 20 minutes). Each part is one entry in
//  `parts`, keyed by its index, with its own segments. Speaker keys are
//  "<part>/<piece>:<label>" because the model's "A" in one upload is not
//  the same person as "A" in the next — Zara's naming joins them.
// ============================================================

const db = require("./db");

const ROLES_HINT = ["Immigration Judge", "Attorney", "DHS Counsel", "Respondent", "Interpreter", "Witness", "Clerk", "Other"];

let ready = null;
function initTables() {
  if (!ready) {
    ready = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS transcripts (
          id            SERIAL PRIMARY KEY,
          session_key   TEXT UNIQUE,
          source        TEXT,
          title         TEXT,
          client_key    TEXT,
          client_name   TEXT,
          a_number      TEXT,
          case_id       INTEGER,
          note_type     TEXT,
          note_id       INTEGER,
          parts         JSONB NOT NULL DEFAULT '{}'::jsonb,
          speakers      JSONB NOT NULL DEFAULT '{}'::jsonb,
          speakers_named_at TIMESTAMPTZ,
          text          TEXT,
          dropbox_path  TEXT,
          dropbox_error TEXT,
          created_by    TEXT,
          created_by_uid TEXT,
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          updated_at    TIMESTAMPTZ DEFAULT NOW()
        )`);
      await db.query(`CREATE INDEX IF NOT EXISTS transcripts_client_idx ON transcripts (client_key)`);
      await db.query(`CREATE INDEX IF NOT EXISTS transcripts_note_idx ON transcripts (note_type, note_id)`);
      await db.query(`CREATE INDEX IF NOT EXISTS transcripts_created_idx ON transcripts (created_at DESC)`);
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

// ── Identity ─────────────────────────────────────────────

const digits = s => String(s || "").replace(/\D/g, "");
function keyFor({ clientName, aNumber }) {
  try { return require("./client-profiles").clientKey({ aNumber: aNumber || null, clientName: clientName || null }); }
  catch (e) { return null; }
}
function cleanName(s) { const t = String(s || "").replace(/\s+/g, " ").trim(); return t ? t.slice(0, 200) : null; }

// ── Reading a transcript ─────────────────────────────────

// Parts in order, each with its segments, and the offset (seconds from
// the start of the whole recording) its times count from.
function orderedParts(row) {
  const parts = row && row.parts && typeof row.parts === "object" ? row.parts : {};
  let offset = 0;
  return Object.keys(parts).map(k => ({ index: Number(k), ...parts[k] }))
    .filter(p => Number.isFinite(p.index))
    .sort((a, b) => a.index - b.index)
    .map(p => {
      const out = { ...p, offset };
      const segEnd = (p.segments || []).reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
      offset += Number(p.duration) || segEnd || 0;
      return out;
    });
}

// Every speaker key in first-heard order.
function speakerKeys(row) {
  const seen = [];
  for (const p of orderedParts(row)) {
    for (const s of p.segments || []) {
      if (s.speaker == null) continue;
      const k = `${p.index}/${s.speaker}`;
      if (!seen.includes(k)) seen.push(k);
    }
  }
  return seen;
}

function isDiarized(row) {
  return orderedParts(row).some(p => p.diarized && (p.segments || []).some(s => s.speaker != null));
}

// Display name for a key: the saved name, or "Speaker N" by first-heard order.
function nameFor(row, key, keys) {
  const map = (row && row.speakers) || {};
  if (map[key]) return map[key];
  const i = (keys || speakerKeys(row)).indexOf(key);
  return "Speaker " + (i >= 0 ? i + 1 : "?");
}

// Consecutive segments by the same person become one block.
function blocks(row) {
  const keys = speakerKeys(row);
  const diar = isDiarized(row);
  const out = [];
  for (const p of orderedParts(row)) {
    if (p.error && !(p.segments || []).length && !p.text) {
      out.push({ speaker: null, name: null, start: p.offset, end: p.offset, text: `[Part ${p.index + 1} could not be transcribed: ${p.error}]`, part: p.index, failed: true });
      continue;
    }
    const segs = (p.segments || []).length ? p.segments : [{ speaker: null, start: 0, end: p.duration || 0, text: p.text || "" }];
    for (const s of segs) {
      const text = String(s.text || "").trim();
      if (!text) continue;
      const key = diar && s.speaker != null ? `${p.index}/${s.speaker}` : null;
      const name = key ? nameFor(row, key, keys) : null;
      const last = out[out.length - 1];
      // Without speakers, words still break into readable paragraphs.
      if (last && !last.failed && last.name === name && last.part === p.index && (name || last.text.length < 700)) {
        last.text += " " + text;
        last.end = p.offset + (Number(s.end) || 0);
      } else {
        out.push({ speaker: key, name, start: p.offset + (Number(s.start) || 0), end: p.offset + (Number(s.end) || 0), text, part: p.index });
      }
    }
  }
  // Join neighbours across a part boundary when they are the same person.
  const joined = [];
  for (const b of out) {
    const last = joined[joined.length - 1];
    if (last && !last.failed && !b.failed && last.name && last.name === b.name) { last.text += " " + b.text; last.end = b.end; }
    else joined.push({ ...b });
  }
  return joined;
}

function clock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = n => String(n).padStart(2, "0");
  return (h ? h + ":" + pad(m) : m) + ":" + pad(r);
}

// Plain text. With speakers: "Judge: …" blocks. Without: the words.
function toText(row, { times = false } = {}) {
  return blocks(row).map(b => {
    const t = times ? `[${clock(b.start)}] ` : "";
    return b.name ? `${t}${b.name}: ${b.text}` : `${t}${b.text}`;
  }).join("\n\n");
}

function durationOf(row) {
  const ps = orderedParts(row);
  if (!ps.length) return 0;
  const last = ps[ps.length - 1];
  const segEnd = (last.segments || []).reduce((m, s) => Math.max(m, Number(s.end) || 0), 0);
  return last.offset + (Number(last.duration) || segEnd || 0);
}

function summary(row) {
  const keys = speakerKeys(row);
  const names = [...new Set(keys.map(k => nameFor(row, k, keys)))];
  return {
    id: row.id, title: row.title, source: row.source,
    client_key: row.client_key, client_name: row.client_name, a_number: row.a_number,
    case_id: row.case_id, note_type: row.note_type, note_id: row.note_id,
    created_at: row.created_at, created_by: row.created_by,
    parts: orderedParts(row).length, duration_sec: Math.round(durationOf(row)),
    diarized: isDiarized(row), speakers: names,
    dropbox_path: row.dropbox_path, dropbox_error: row.dropbox_error,
    preview: String(row.text || "").slice(0, 220),
  };
}

function full(row) {
  const keys = speakerKeys(row);
  return {
    ...summary(row),
    speaker_keys: keys.map(k => ({ key: k, name: nameFor(row, k, keys), named: !!(row.speakers || {})[k] })),
    blocks: blocks(row),
    text: toText(row),
    speakers_named_at: row.speakers_named_at,
  };
}

// ── Writing ──────────────────────────────────────────────

function partFrom(result, extra = {}) {
  const r = result || {};
  return {
    model: r.model || null,
    diarized: !!r.diarized,
    duration: Number(r.duration) || null,
    text: String(r.text || ""),
    segments: (r.segments || []).map(s => ({
      speaker: s.speaker == null ? null : String(s.speaker),
      start: Number(s.start) || 0, end: Number(s.end) || 0,
      text: String(s.text || ""),
    })),
    error: r.error || null,
    at: new Date().toISOString(),
    ...extra,
  };
}

function defaultTitle({ source, clientName, noteType }) {
  const when = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const what = noteType === "individual" || /individual/.test(source || "") ? "Individual hearing recording"
    : /master|hearing/.test(source || "") ? "Hearing dictation" : "Voice recording";
  return `${what}${clientName ? " — " + clientName : ""} (${when})`;
}

// Save one transcribed part. `sessionKey` groups the parts of one
// recording; without one, each call is its own transcript.
async function addPart({ sessionKey = null, index = 0, result, source = "dictation", user = null,
  clientName = null, aNumber = null, noteType = null, noteId = null, title = null }) {
  await initTables();
  const part = partFrom(result);
  const idx = Math.max(0, Math.min(999, parseInt(index, 10) || 0));
  const name = cleanName(clientName), anum = cleanName(aNumber);
  const ckey = (name || anum) ? keyFor({ clientName: name, aNumber: anum }) : null;
  const by = user ? (user.n || user.u || null) : null;
  const uid = user && user.uid != null ? String(user.uid) : null;
  const sk = sessionKey ? String(sessionKey).slice(0, 120) : null;
  const t = title || defaultTitle({ source, clientName: name, noteType });

  let row;
  if (sk) {
    // Parts can arrive at the same moment; the unique key and the jsonb
    // merge keep both.
    await db.query(
      `INSERT INTO transcripts (session_key, source, title, client_key, client_name, a_number, note_type, note_id, created_by, created_by_uid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (session_key) DO NOTHING`,
      [sk, source, t, ckey, name, anum, noteType, noteId, by, uid]);
    const r = await db.query(
      `UPDATE transcripts SET parts = parts || jsonb_build_object($2::text, $3::jsonb),
         client_name = COALESCE(client_name, $4), a_number = COALESCE(a_number, $5),
         client_key = COALESCE(client_key, $6),
         note_type = COALESCE(note_type, $7), note_id = COALESCE(note_id, $8),
         updated_at = NOW()
       WHERE session_key = $1 RETURNING *`,
      [sk, String(idx), JSON.stringify(part), name, anum, ckey, noteType, noteId]);
    row = r.rows[0];
  } else {
    const r = await db.query(
      `INSERT INTO transcripts (source, title, client_key, client_name, a_number, note_type, note_id, parts, created_by, created_by_uid)
       VALUES ($1,$2,$3,$4,$5,$6,$7, jsonb_build_object($8::text, $9::jsonb), $10, $11) RETURNING *`,
      [source, t, ckey, name, anum, noteType, noteId, String(idx), JSON.stringify(part), by, uid]);
    row = r.rows[0];
  }
  await refreshText(row);
  return row;
}

// The searchable text column. Written only if no other part landed in
// between (otherwise that part's own call writes the fuller text).
async function refreshText(row) {
  if (!row) return;
  const count = Object.keys(row.parts || {}).length;
  const text = toText(row);
  row.text = text;
  await db.query(
    `UPDATE transcripts SET text = $2 WHERE id = $1 AND (SELECT COUNT(*) FROM jsonb_object_keys(parts)) = $3`,
    [row.id, text, count]);
}

async function get(id) {
  await initTables();
  const r = await db.query(`SELECT * FROM transcripts WHERE id = $1`, [Number(id)]);
  return r.rows[0] || null;
}
async function getBySession(sessionKey) {
  await initTables();
  const r = await db.query(`SELECT * FROM transcripts WHERE session_key = $1`, [String(sessionKey)]);
  return r.rows[0] || null;
}

// Fill in who the recording is about, without overwriting what a person set.
async function noteClient(id, { clientName, aNumber, force = false } = {}) {
  const name = cleanName(clientName), anum = cleanName(aNumber);
  if (!name && !anum) return get(id);
  await initTables();
  const cur = await get(id);
  if (!cur) return null;
  const nextName = force ? (name || cur.client_name) : (cur.client_name || name);
  const nextA = force ? (anum || cur.a_number) : (cur.a_number || anum);
  const nextKey = keyFor({ clientName: nextName, aNumber: nextA });
  const r = await db.query(
    `UPDATE transcripts SET client_name = $2, a_number = $3, client_key = $4, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [cur.id, nextName, nextA, nextKey]);
  return r.rows[0];
}

// Assign to a client by profile key (the transcript page's "Assign").
async function assignClient(id, clientKey) {
  const c = await require("./client-profiles").getClientByKey(String(clientKey));
  if (!c) throw new Error("Client not found");
  await initTables();
  const before = await get(id);
  if (!before) throw new Error("Transcript not found");
  // A copy already filed for another client stays where it is (nothing is
  // deleted from Dropbox); the new copy goes to this client's folder.
  if (before.dropbox_path && before.client_key && before.client_key !== c.key) {
    await db.query(`UPDATE transcripts SET dropbox_path = NULL, dropbox_error = $2 WHERE id = $1`,
      [before.id, "An earlier copy is still at " + before.dropbox_path + " — delete it there if that was the wrong client."]);
  }
  const r = await db.query(
    `UPDATE transcripts SET client_key = $2, client_name = $3, a_number = $4, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [Number(id), c.key, c.client_name || null, c.a_number || null]);
  if (!r.rows[0]) throw new Error("Transcript not found");
  return r.rows[0];
}

function parseIds(v) {
  const list = Array.isArray(v) ? v : String(v || "").split(/[,\s]+/);
  return [...new Set(list.map(x => parseInt(x, 10)).filter(n => n > 0))].slice(0, 50);
}

// Link transcripts to the hearing note they were applied to. A transcript
// already linked (to this note or another) is left alone, so the
// individual form's autosave every few seconds costs nothing.
// Returns the ids newly linked.
//
// `byUid` (the person saving the note) limits it to their own recordings:
// ids arrive from a browser form or the app, so without it anyone could
// pull someone else's recording onto their note and client.
async function linkToNote(ids, { noteType, noteId, clientName = null, aNumber = null, byUid }) {
  const list = parseIds(ids);
  if (!list.length || !noteId) return [];
  if (byUid === undefined) throw new Error("linkToNote needs byUid (null only for internal calls)");
  await initTables();
  const r = await db.query(
    `UPDATE transcripts SET note_type = $2, note_id = $3, updated_at = NOW()
     WHERE id = ANY($1::int[]) AND note_id IS NULL AND ($4::text IS NULL OR created_by_uid = $4) RETURNING id`,
    [list, String(noteType), Number(noteId), byUid == null ? null : String(byUid)]);
  const done = r.rows.map(x => x.id);
  for (const id of done) {
    try { await noteClient(id, { clientName, aNumber }); } catch (e) { /* identity is a nicety */ }
    fileSoon(id);
  }
  return done;
}

// The phone app cannot send ids (no app build for this), so when it saves
// a note, the same person's recent unlinked recordings for that client
// are linked to it.
async function autoLink({ user, noteType, noteId, clientName, aNumber, hours = 12 }) {
  if (!user || user.uid == null || !noteId) return [];
  await initTables();
  const d = digits(aNumber);
  const n = cleanName(clientName);
  if (!d && !n) return [];
  const r = await db.query(
    `SELECT id FROM transcripts
      WHERE created_by_uid = $1 AND note_id IS NULL AND source = 'app-dictation'
        AND created_at > NOW() - ($2 || ' hours')::interval
        AND ((LENGTH($3) >= 8 AND regexp_replace(COALESCE(a_number,''), '\\D', '', 'g') = $3)
          OR ($4::text IS NOT NULL AND LOWER(client_name) = LOWER($4)))
      ORDER BY created_at DESC LIMIT 10`,
    [String(user.uid), String(hours), d, n]);
  return linkToNote(r.rows.map(x => x.id), { noteType, noteId, clientName, aNumber, byUid: user.uid });
}

async function listForClient({ key, clientName, aNumber }) {
  await initTables();
  const d = digits(aNumber);
  const r = await db.query(
    `SELECT * FROM transcripts
      WHERE client_key = $1
         OR (LENGTH($2) >= 8 AND regexp_replace(COALESCE(a_number,''), '\\D', '', 'g') = $2)
         OR ($3::text IS NOT NULL AND COALESCE(a_number, '') = '' AND LOWER(client_name) = LOWER($3))
      ORDER BY created_at DESC LIMIT 200`,
    [key || "", d, cleanName(clientName)]);
  return r.rows.map(summary);
}

async function listForNote(noteType, noteId) {
  await initTables();
  const r = await db.query(
    `SELECT * FROM transcripts WHERE note_type = $1 AND note_id = $2 ORDER BY created_at`,
    [String(noteType), Number(noteId)]);
  return r.rows.map(summary);
}

async function search({ q = "", limit = 100, unassigned = false } = {}) {
  await initTables();
  const term = String(q || "").trim();
  const r = await db.query(
    `SELECT * FROM transcripts
      WHERE ($1 = '' OR client_name ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%' OR text ILIKE '%' || $1 || '%'
             OR ($3 <> '' AND regexp_replace(COALESCE(a_number,''), '\\D', '', 'g') LIKE '%' || $3 || '%'))
        AND (NOT $4 OR client_key IS NULL)
      ORDER BY created_at DESC LIMIT $2`,
    [term, Math.min(500, Number(limit) || 100), digits(term).length >= 4 ? digits(term) : "", !!unassigned]);
  return r.rows.map(summary);
}

async function setSpeakers(id, map) {
  const row = await get(id);
  if (!row) throw new Error("Transcript not found");
  const keys = speakerKeys(row);
  const set = {}, drop = [];
  for (const [k, v] of Object.entries(map || {})) {
    if (!keys.includes(k)) continue;
    const name = cleanName(v);
    // A blank box, or the placeholder left as it was, means "unnamed".
    if (name && !/^speaker \d+$/i.test(name)) set[k] = name.slice(0, 60); else drop.push(k);
  }
  // Merged in the database, so two people editing different names at
  // once both keep theirs.
  const r = await db.query(
    `UPDATE transcripts SET speakers = (speakers || $2::jsonb) - $3::text[], updated_at = NOW() WHERE id = $1 RETURNING *`,
    [row.id, JSON.stringify(set), drop]);
  await refreshText(r.rows[0]);
  return r.rows[0];
}

async function setTitle(id, title) {
  const t = cleanName(title);
  if (!t) throw new Error("A title is needed");
  await initTables();
  const r = await db.query(`UPDATE transcripts SET title = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [Number(id), t]);
  if (!r.rows[0]) throw new Error("Transcript not found");
  return r.rows[0];
}

async function remove(id) {
  await initTables();
  const r = await db.query(`DELETE FROM transcripts WHERE id = $1 RETURNING id`, [Number(id)]);
  return !!r.rows[0];
}

// ── Zara names the speakers ──────────────────────────────

function namingPrompt(row, { recordedBy = null } = {}) {
  const keys = speakerKeys(row);
  const byKey = {};
  for (const p of orderedParts(row)) for (const s of p.segments || []) {
    if (s.speaker == null) continue;
    const k = `${p.index}/${s.speaker}`;
    (byKey[k] = byKey[k] || []).push(String(s.text || "").trim());
  }
  // A running excerpt shows who answers whom; samples per speaker make
  // sure a quiet voice (the interpreter) is seen too.
  const flow = [];
  for (const p of orderedParts(row)) for (const s of p.segments || []) {
    if (flow.join("\n").length > 9000) break;
    if (s.speaker != null && s.text) flow.push(`[${p.index}/${s.speaker}] ${String(s.text).trim()}`);
  }
  const samples = keys.map(k => {
    const lines = byKey[k] || [];
    const words = lines.join(" ").split(/\s+/).length;
    return `${k} — ${lines.length} turns, ~${words} words. Samples:\n` + lines.slice(0, 6).map(l => "  • " + l.slice(0, 240)).join("\n");
  }).join("\n\n");
  return `This is a recording made by a law firm (Tez Law P.C.), usually in immigration court or right after a hearing, sometimes a client meeting. An automatic system split it into speakers and gave each an arbitrary key like "0/A" (part/label). The same person can have different keys in different parts.

Name each key by role, using these where they fit: ${ROLES_HINT.join(", ")}.
${recordedBy ? `The person who recorded it is ${recordedBy} (a firm attorney/staff member); when the attorney is speaking, use "${recordedBy}".\n` : ""}${row.client_name ? `The client (respondent) is ${row.client_name}; you may write "Respondent (${row.client_name})".\n` : ""}If one person is plainly dictating notes alone, that is the recorder. If you cannot tell, write "Speaker" plus a number. Never invent a personal name that is not said in the recording — except the recorder's and the client's above. A judge or DHS attorney named in the recording may be named ("Judge Riley").

Speakers:
${samples}

Opening of the conversation:
${flow.join("\n")}

Reply with one JSON object mapping every key to a name, e.g. {"0/A":"Immigration Judge","0/B":"${recordedBy || "Attorney"}"}. Nothing else.`;
}

function parseNames(text, keys) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return {};
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { return {}; }
  const out = {};
  for (const k of keys) {
    const v = obj && typeof obj[k] === "string" ? cleanName(obj[k]) : null;
    if (v) out[k] = v.slice(0, 60);
  }
  return out;
}

// Names every unnamed key (never overwrites a name a person typed).
async function nameSpeakers(id, { recordedBy = null, force = false } = {}) {
  const row = await get(id);
  if (!row) return null;
  const keys = speakerKeys(row);
  const current = row.speakers || {};
  const todo = keys.filter(k => force || !current[k]);
  if (!todo.length) return row;
  let names = {};
  if (keys.length === 1) {
    names = { [keys[0]]: recordedBy || "Attorney" };
  } else {
    try {
      const core = require("./zara-core");
      const prompt = namingPrompt(row, { recordedBy });
      const out = await core.think({
        surface: "system", tier: "fast", message: prompt,
        extra: "You label speakers in a legal recording. Your whole reply is one JSON object.",
        maxTokens: 800, maxMessageChars: prompt.length + 100, timeout: 60000,
      });
      names = parseNames(out && out.text, keys);
    } catch (e) {
      console.warn("[transcripts] naming speakers:", e.message);
      return row;
    }
  }
  const add = {};
  for (const k of todo) if (names[k]) add[k] = names[k];
  // Zara's names never replace one a person typed meanwhile (theirs wins
  // in the merge) — unless "rename all" was asked for.
  const r = await db.query(
    force
      ? `UPDATE transcripts SET speakers = speakers || $2::jsonb, speakers_named_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`
      : `UPDATE transcripts SET speakers = $2::jsonb || speakers, speakers_named_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [row.id, JSON.stringify(add)]);
  await refreshText(r.rows[0]);
  return r.rows[0];
}

// ── Word copy, and filing it in the client's Dropbox folder ──

function toDocx(row) {
  const docx = require("./docx-fill");
  const head = [
    row.title || "Transcript",
    row.client_name ? `Client: ${row.client_name}${row.a_number ? "  ·  A# " + row.a_number : ""}` : null,
    `Recorded: ${new Date(row.created_at || Date.now()).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}${row.created_by ? "  ·  by " + row.created_by : ""}`,
    isDiarized(row) ? "Speakers were separated automatically and named by Zara; check names against the recording." : "Speakers were not separated for this recording.",
    "Machine transcript — verify against the recording before quoting it.",
    "",
  ].filter(x => x !== null).join("\n");
  return docx.textToDocx(head + "\n" + toText(row, { times: true }), { title: null });
}

function fileName(row) {
  const date = new Date(row.created_at || Date.now()).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const base = String(row.title || "Transcript").replace(/\s*\([^)]*\)\s*$/, "").replace(/[\/\\:?*"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${date} ${base} (transcript ${row.id}).docx`;
}

async function saveToDropbox(id) {
  const row = await get(id);
  if (!row) throw new Error("Transcript not found");
  if (!row.client_key && !row.client_name && !row.a_number) throw new Error("Assign the transcript to a client first");
  const dbx = require("./dropbox-integration");
  if (!dbx.isConfigured || !(await Promise.resolve(dbx.isConfigured()))) throw new Error("Dropbox is not connected");
  const folder = await dbx.resolveClientFolder({ clientKey: row.client_key, clientName: row.client_name, aNumber: row.a_number });
  if (!folder) throw new Error("This client has no Dropbox folder linked (set it on the client's profile)");
  const dir = `${folder}/Transcripts`;
  try { await dbx.createFolder(dir); } catch (e) { /* already there */ }
  // The same file is updated when speakers are renamed, so its name stays.
  const target = row.dropbox_path && row.dropbox_path.toLowerCase().startsWith(dir.toLowerCase() + "/")
    ? row.dropbox_path : `${dir}/${fileName(row)}`;
  const up = await dbx.uploadFile({ path: target, buffer: toDocx(row), mode: "overwrite", autorename: false });
  const p = (up && (up.path_display || up.path_lower)) || target;
  await db.query(`UPDATE transcripts SET dropbox_path = $2, dropbox_error = CASE WHEN dropbox_error LIKE 'An earlier copy%' THEN dropbox_error ELSE NULL END WHERE id = $1`, [row.id, p]);
  try { if (dbx.clearListCache) dbx.clearListCache(folder); } catch (e) { /* cache only */ }
  return p;
}

// Best effort, in the background: a missing Dropbox link must never lose
// the transcript itself (it is in the database either way).
const filing = new Map();
function fileSoon(id, delayMs = 4000) {
  if (process.env.TRANSCRIPTS_TO_DROPBOX === "false") return;
  clearTimeout(filing.get(id));
  const t = setTimeout(async () => {
    filing.delete(id);
    try { await saveToDropbox(id); }
    catch (e) {
      try { await db.query(`UPDATE transcripts SET dropbox_error = $2 WHERE id = $1`, [id, String(e.message).slice(0, 300)]); } catch (e2) { /* ignore */ }
    }
  }, delayMs);
  if (t.unref) t.unref();
  filing.set(id, t);
}

// ── The one call the dictation routes make ───────────────
//
// Transcribe (with speakers when the model allows), save as a part,
// name the speakers. Returns { row, text } where text is what goes into
// the note ("Judge: …" blocks, or the plain words).
async function transcribeAndSave(buffer, filename, opts = {}) {
  const voice = require("./voice-dictation");
  let result;
  try { result = await voice.transcribeDetailed(buffer, filename); }
  catch (e) {
    // Keep a record that the recording existed and failed, then report it.
    if (opts.sessionKey) {
      try { await addPart({ ...opts, result: { error: e.message } }); } catch (e2) { /* ignore */ }
    }
    throw e;
  }
  let row;
  try { row = await addPart({ ...opts, result }); }
  catch (e) {
    // The words still go back to the page (as before this module existed);
    // only the saved copy is missing, and the log says so.
    console.error("[transcripts] could not save a transcript:", e.message);
    row = { id: null, parts: { [String(parseInt(opts.index, 10) || 0)]: partFrom(result) }, speakers: {}, unsaved: e.message };
    return { row, text: toText(row), partText: partText(row, opts.index || 0), result, saved: false };
  }
  if (opts.nameNow !== false) {
    try { row = (await nameSpeakers(row.id, { recordedBy: opts.user ? (opts.user.n || opts.user.u) : null })) || row; }
    catch (e) { /* names are a nicety */ }
  }
  // Not filed to Dropbox yet: the client may only be a guess until the
  // dictation is applied to a note or assigned by a person.
  return { row, text: toText(row), partText: partText(row, opts.index || 0), result, saved: row.id != null };
}

// After the fields are read: record who it is about (from what Zara read,
// never over what a person set) and link the note if there is one.
async function finish(id, { extracted = null, noteType = null, noteId = null } = {}) {
  if (!id) return null;
  if (extracted && (extracted.client_name || extracted.a_number)) {
    try { await noteClient(id, { clientName: extracted.client_name, aNumber: extracted.a_number }); } catch (e) { /* nicety */ }
  }
  if (noteType && noteId) await linkToNote([id], { noteType, noteId, byUid: null });
  return get(id);
}

// Which note a dictation belongs to, from the form fields the page sends.
function noteFrom(body) {
  const b = body || {};
  const type = String(b.note_type || "").trim();
  const id = parseInt(b.note_id, 10);
  return (type === "master" || type === "individual") && id > 0 ? { noteType: type, noteId: id } : { noteType: null, noteId: null };
}

// The words of one part only, with speaker names (for the chunk recorder,
// which assembles parts itself).
function partText(row, index) {
  const idx = parseInt(index, 10) || 0;
  return blocks(row).filter(b => b.part === idx).map(b => b.name ? `${b.name}: ${b.text}` : b.text).join("\n\n");
}

module.exports = {
  initTables, addPart, get, getBySession, noteClient, assignClient, linkToNote, autoLink, parseIds,
  listForClient, listForNote, search, setSpeakers, setTitle, remove,
  nameSpeakers, namingPrompt, parseNames, saveToDropbox, fileSoon, transcribeAndSave, finish, noteFrom,
  // reading
  orderedParts, speakerKeys, isDiarized, blocks, toText, partText, summary, full, toDocx, fileName, clock, durationOf,
};
