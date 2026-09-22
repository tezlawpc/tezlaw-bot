/**
 * check-transcripts.js
 *
 * JJ: "for the voice transcript, it is not saving to each file when its
 * applied. at the minimum each case needs to save transcript if there are
 * any so can go back and read. It would be awesome if it can be divided
 * between each speaker for breakdown."
 *
 * Pins: a transcript is saved when it is transcribed (not when a form is
 * saved), parts of one recording land in one transcript, speakers are
 * separated and named, names can be corrected, the transcript is linked
 * to the hearing note it was applied to and shows on the client, and a
 * failing diarizing model falls back to whisper instead of losing words.
 *
 * Fakes: database (the queries transcripts.js makes), OpenAI (axios),
 * Zara, client profiles, Dropbox.
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const { JSDOM } = require("jsdom");
const REPO = path.join(__dirname, "..");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}
const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(JSON.stringify(a) + " ≠ " + JSON.stringify(b)); };

process.env.TRANSCRIPTS_TO_DROPBOX = "false";
process.env.OPENAI_API_KEY = "sk-test";
delete process.env.TRANSCRIBE_MODEL;

// ── Fake database: the statements transcripts.js makes ──────
const rows = [];
let seq = 1;
const now = () => new Date().toISOString();
const clone = r => r && JSON.parse(JSON.stringify(r));
const digits = s => String(s || "").replace(/\D/g, "");
const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^CREATE /.test(q)) return { rows: [] };
  if (/^INSERT INTO transcripts \(session_key/.test(q)) {
    if (!rows.some(r => r.session_key === v[0])) rows.push({ id: seq++, session_key: v[0], source: v[1], title: v[2], client_key: v[3], client_name: v[4], a_number: v[5], note_type: v[6], note_id: v[7], created_by: v[8], created_by_uid: v[9], parts: {}, speakers: {}, created_at: now() });
    return { rows: [] };
  }
  if (/^UPDATE transcripts SET parts = parts \|\|/.test(q)) {
    const r = rows.find(x => x.session_key === v[0]);
    r.parts[v[1]] = JSON.parse(v[2]);
    r.client_name = r.client_name || v[3]; r.a_number = r.a_number || v[4]; r.client_key = r.client_key || v[5];
    r.note_type = r.note_type || v[6]; r.note_id = r.note_id || v[7];
    return { rows: [clone(r)] };
  }
  if (/^INSERT INTO transcripts \(source/.test(q)) {
    const r = { id: seq++, session_key: null, source: v[0], title: v[1], client_key: v[2], client_name: v[3], a_number: v[4], note_type: v[5], note_id: v[6], parts: { [v[7]]: JSON.parse(v[8]) }, speakers: {}, created_by: v[9], created_by_uid: v[10], created_at: now() };
    rows.push(r); return { rows: [clone(r)] };
  }
  if (/^UPDATE transcripts SET text = \$2 WHERE id = \$1 AND/.test(q)) {
    const r = rows.find(x => x.id === v[0]);
    if (r && Object.keys(r.parts).length === v[2]) r.text = v[1];
    return { rows: [] };
  }
  if (/^SELECT \* FROM transcripts WHERE id = \$1/.test(q)) return { rows: rows.filter(x => x.id === v[0]).map(clone) };
  if (/^SELECT \* FROM transcripts WHERE session_key = \$1/.test(q)) return { rows: rows.filter(x => x.session_key === v[0]).map(clone) };
  if (/^UPDATE transcripts SET client_name = \$2, a_number = \$3, client_key = \$4/.test(q) || /^UPDATE transcripts SET client_key = \$2, client_name = \$3, a_number = \$4/.test(q)) {
    const r = rows.find(x => x.id === v[0]); if (!r) return { rows: [] };
    if (/SET client_name/.test(q)) { r.client_name = v[1]; r.a_number = v[2]; r.client_key = v[3]; }
    else { r.client_key = v[1]; r.client_name = v[2]; r.a_number = v[3]; }
    return { rows: [clone(r)] };
  }
  if (/^UPDATE transcripts SET note_type = \$2, note_id = \$3/.test(q)) {
    const got = rows.filter(x => v[0].includes(x.id) && x.note_id == null && (v[3] == null || x.created_by_uid === v[3]));
    got.forEach(r => { r.note_type = v[1]; r.note_id = v[2]; });
    return { rows: got.map(r => ({ id: r.id })) };
  }
  if (/^SELECT id FROM transcripts WHERE created_by_uid = \$1/.test(q)) {
    return { rows: rows.filter(r => r.created_by_uid === v[0] && r.note_id == null && r.source === "app-dictation" &&
      ((v[2].length >= 8 && digits(r.a_number) === v[2]) || (v[3] && String(r.client_name || "").toLowerCase() === v[3].toLowerCase()))).map(r => ({ id: r.id })) };
  }
  if (/^SELECT \* FROM transcripts WHERE client_key = \$1/.test(q)) {
    return { rows: rows.filter(r => r.client_key === v[0] || (v[1].length >= 8 && digits(r.a_number) === v[1]) ||
      (v[2] && !r.a_number && String(r.client_name || "").toLowerCase() === v[2].toLowerCase())).map(clone).reverse() };
  }
  if (/^SELECT \* FROM transcripts WHERE note_type = \$1 AND note_id = \$2/.test(q)) return { rows: rows.filter(r => r.note_type === v[0] && r.note_id === v[1]).map(clone) };
  if (/^SELECT \* FROM transcripts WHERE \(\$1 = ''/.test(q)) {
    const t = String(v[0]).toLowerCase();
    return { rows: rows.filter(r => (!t || [r.client_name, r.title, r.text].some(x => String(x || "").toLowerCase().includes(t)) || (v[2] && digits(r.a_number).includes(v[2]))) && (!v[3] || !r.client_key)).map(clone).reverse() };
  }
  if (/^UPDATE transcripts SET speakers = /.test(q)) {
    const r = rows.find(x => x.id === v[0]); const add = JSON.parse(v[1]);
    if (/speakers = \(speakers \|\| \$2::jsonb\) - \$3::text\[\]/.test(q)) { r.speakers = { ...r.speakers, ...add }; v[2].forEach(k => delete r.speakers[k]); }
    else if (/speakers = speakers \|\| \$2::jsonb/.test(q)) r.speakers = { ...r.speakers, ...add };
    else if (/speakers = \$2::jsonb \|\| speakers/.test(q)) r.speakers = { ...add, ...r.speakers };
    else throw new Error("fake db: speakers update " + q);
    if (/speakers_named_at/.test(q)) r.speakers_named_at = now();
    return { rows: [clone(r)] };
  }
  if (/^UPDATE transcripts SET title = \$2/.test(q)) { const r = rows.find(x => x.id === v[0]); if (!r) return { rows: [] }; r.title = v[1]; return { rows: [clone(r)] }; }
  if (/^UPDATE transcripts SET dropbox_path = NULL, dropbox_error = \$2/.test(q)) { const r = rows.find(x => x.id === v[0]); r.dropbox_path = null; r.dropbox_error = v[1]; return { rows: [] }; }
  if (/^UPDATE transcripts SET dropbox_path/.test(q)) { const r = rows.find(x => x.id === v[0]); r.dropbox_path = v[1]; if (!/^An earlier copy/.test(r.dropbox_error || "")) r.dropbox_error = null; return { rows: [] }; }
  if (/^UPDATE transcripts SET dropbox_error/.test(q)) { const r = rows.find(x => x.id === v[0]); if (r) r.dropbox_error = v[1]; return { rows: [] }; }
  if (/^DELETE FROM transcripts WHERE id = \$1/.test(q)) { const i = rows.findIndex(x => x.id === v[0]); if (i < 0) return { rows: [] }; rows.splice(i, 1); return { rows: [{ id: v[0] }] }; }
  throw new Error("fake db: unexpected query: " + q.slice(0, 120));
} };

// ── Fake OpenAI ──────────────────────────────────────────────
const openai = { calls: [], diarizeFails: false, script: null };
function fieldsOf(form) {
  const out = {};
  const parts = (form._streams || []).filter(x => typeof x === "string");
  for (let i = 0; i < parts.length; i++) {
    const m = /name="([^"]+)"/.exec(parts[i]);
    if (m && m[1] !== "file" && typeof parts[i + 1] === "string") out[m[1]] = parts[i + 1];
  }
  return out;
}
const fakeAxios = {
  post: async (url, body) => {
    if (!/audio\/transcriptions/.test(url)) throw new Error("unexpected axios post " + url);
    const f = fieldsOf(body);
    openai.calls.push(f);
    if (f.model === "gpt-4o-transcribe-diarize") {
      if (openai.diarizeFails) { const e = new Error("Request failed with status code 400"); e.response = { data: { error: { message: "audio too long" } } }; throw e; }
      if (f.response_format !== "diarized_json" || f.chunking_strategy !== "auto") throw new Error("diarize called without diarized_json + chunking_strategy");
      return { data: openai.script || { text: "Good morning. Good morning, Your Honor.", duration: 9,
        segments: [{ speaker: "A", start: 0, end: 2, text: "Good morning." }, { speaker: "B", start: 2, end: 5, text: "Good morning, Your Honor." }, { speaker: "A", start: 5, end: 9, text: "Is the respondent present?" }] } };
    }
    if (f.model === "whisper-1") return { data: { text: "One voice only.", duration: 4, segments: [{ start: 0, end: 4, text: "One voice only." }] } };
    throw new Error("unknown model " + f.model);
  },
};

// ── Zara and the rest ────────────────────────────────────────
const zara = { calls: 0, reply: null };
const fakeCore = { think: async (o) => { zara.calls++; zara.last = o.message; return { text: zara.reply || "{}" }; }, TIERS: { balanced: { anthropic: "x" } } };
const clients = [{ key: "a-a249402327", client_name: "Lopez, Maria", a_number: "A249-402-327" }, { key: "n-chen-wei", client_name: "Chen, Wei", a_number: null }];
const fakeProfiles = {
  clientKey: ({ aNumber, clientName }) => aNumber ? "a-" + String(aNumber).toLowerCase().replace(/[^\w]/g, "") : (clientName ? "n-" + String(clientName).toLowerCase().trim().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") : null),
  getClientByKey: async k => clients.find(c => c.key === k) || null,
  aggregateClients: async () => clients,
};
const dropbox = { uploads: [] };
const fakeDropbox = {
  isConfigured: () => true,
  resolveClientFolder: async ({ clientName }) => clientName === "Chen, Wei" ? null : "/Clients/Lopez Maria",
  createFolder: async () => ({}),
  uploadFile: async (o) => { dropbox.uploads.push(o); return { path_display: o.path }; },
};
const orig = Module._load;
Module._load = function (r, parent, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "axios") return fakeAxios;
  if (r === "./zara-core") return fakeCore;
  if (r === "./client-profiles" && !/check-transcripts/.test(parent && parent.filename || "")) return fakeProfiles;
  if (r === "./dropbox-integration") return fakeDropbox;
  return orig.call(this, r, parent, ...rest);
};
const T = require("../transcripts");
const voice = require("../voice-dictation");

(async () => {
  console.log("\n— Transcribing: speakers, and the whisper fallback —");
  const HAS_FFMPEG = (() => { try { require("child_process").execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch (e) { return false; } })();
  let audio = Buffer.from("not really audio");
  if (HAS_FFMPEG) {
    const tmp = path.join(require("os").tmpdir(), "tx-check-" + process.pid + ".m4a");
    require("child_process").execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=5", "-c:a", "aac", tmp]);
    audio = fs.readFileSync(tmp); fs.unlinkSync(tmp);
  }
  const d1 = await voice.transcribeDetailed(audio, "dictation.m4a");
  check("the diarizing model is asked for diarized_json with chunking_strategy auto", () => openai.calls[0].model === "gpt-4o-transcribe-diarize" && openai.calls[0].response_format === "diarized_json");
  check("segments keep speakers, qualified by piece (0:A, 0:B)", () => eq(d1.segments.map(s => s.speaker), ["0:A", "0:B", "0:A"]));
  check("…and it says it is diarized", () => d1.diarized === true && /diarize/.test(d1.model));

  openai.calls.length = 0; openai.diarizeFails = true;
  const d2 = await voice.transcribeDetailed(audio, "dictation.m4a");
  check("when the diarizing model fails, whisper-1 transcribes it (words are never lost)", () => d2.text === "One voice only." && d2.model === "whisper-1" && !d2.diarized);
  check("…whisper asked for timed segments (verbose_json)", () => openai.calls[1] && openai.calls[1].model === "whisper-1" && openai.calls[1].response_format === "verbose_json");
  openai.diarizeFails = false;

  openai.calls.length = 0; process.env.TRANSCRIBE_MODEL = "whisper-1";
  await voice.transcribeDetailed(audio, "dictation.m4a");
  check("TRANSCRIBE_MODEL=whisper-1 turns speaker separation off", () => openai.calls.length === 1 && openai.calls[0].model === "whisper-1");
  delete process.env.TRANSCRIBE_MODEL;

  if (HAS_FFMPEG) {
    const tmp = path.join(require("os").tmpdir(), "tx-long-" + process.pid + ".webm");
    require("child_process").execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=290", "-c:a", "libopus", "-b:a", "16k", tmp]);
    process.env.TRANSCRIBE_PIECE_SECONDS = "120";
    const pieces = await voice.audioPieces(fs.readFileSync(tmp), "long.webm");
    fs.unlinkSync(tmp);
    check("a long recording is cut into pieces the model accepts, with time offsets", () => pieces.length === 3 && Math.round(pieces[1].offset) === 120 && Math.round(pieces[2].offset) === 240);
    openai.calls.length = 0;
    const t2 = path.join(require("os").tmpdir(), "tx-long2-" + process.pid + ".webm");
    require("child_process").execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=250", "-c:a", "libopus", "-b:a", "16k", t2]);
    const longAudio = fs.readFileSync(t2); fs.unlinkSync(t2);
    const big = await voice.transcribeDetailed(longAudio, "long.webm");
    delete process.env.TRANSCRIBE_PIECE_SECONDS;
    check("…each piece is transcribed and its speakers stay apart (1:A is not 0:A)", () => openai.calls.length === 3 && big.segments.some(s => s.speaker === "1:A") && big.segments.some(s => s.speaker === "0:A"));
    check("…and later pieces' times count from the start of the recording", () => big.segments.find(s => s.speaker === "2:A").start >= 240);
  } else console.log("  skip  (no ffmpeg here) piece cutting");

  console.log("\n— Saved the moment it is transcribed —");
  const user = { uid: 7, n: "JJ Zhang", r: "admin" };
  zara.reply = null;
  const one = await T.transcribeAndSave(audio, "d.m4a", { source: "master-dictation", user, clientName: "Lopez, Maria", aNumber: "A249-402-327", nameNow: false });
  check("a dictation is saved before anyone presses Apply", () => rows.length === 1 && rows[0].id === one.row.id);
  check("…to the client it names (profile key from the A-number)", () => rows[0].client_key === "a-a249402327");
  check("…with the recorder", () => rows[0].created_by === "JJ Zhang" && rows[0].created_by_uid === "7");
  check("…and its text is searchable", () => /Your Honor/.test(rows[0].text));
  check("before naming, speakers read Speaker 1 / Speaker 2", () => /^Speaker 1: Good morning\.\n\nSpeaker 2: Good morning, Your Honor\.\n\nSpeaker 1: Is the respondent present\?$/.test(T.toText(one.row)) || T.toText(one.row));

  zara.reply = 'Here you go: {"0/0:A":"Judge Riley","0/0:B":"JJ Zhang","9/9:Z":"ignored"}';
  const named = await T.nameSpeakers(one.row.id, { recordedBy: "JJ Zhang" });
  check("Zara names the speakers by role", () => T.toText(named).startsWith("Judge Riley: Good morning.\n\nJJ Zhang: Good morning, Your Honor."));
  check("…her prompt says who recorded it and who the client is", () => /recorded it is JJ Zhang/.test(zara.last) && /Lopez, Maria/.test(zara.last));
  check("…keys she invents are dropped", () => !("9/9:Z" in named.speakers));

  const fixed = await T.setSpeakers(one.row.id, { "0/0:A": "Immigration Judge", "nope": "x" });
  check("a person can correct a name; it changes everywhere in the transcript", () => (T.toText(fixed).match(/Immigration Judge:/g) || []).length === 2);
  zara.calls = 0;
  const again = await T.nameSpeakers(one.row.id, { recordedBy: "JJ Zhang" });
  check("Zara does not overwrite names a person set (nothing left to name → no call)", () => zara.calls === 0 && again.speakers["0/0:A"] === "Immigration Judge");
  const kept = await T.setSpeakers(one.row.id, { "0/0:B": "Speaker 2" });
  check("saving the placeholder \"Speaker 2\" leaves the speaker unnamed (Zara may still name it)", () => !("0/0:B" in kept.speakers));
  await T.setSpeakers(one.row.id, { "0/0:B": "JJ Zhang" });
  const cleared = await T.setSpeakers(one.row.id, { "0/0:B": "" });
  check("clearing a name goes back to Speaker N", () => /Speaker 2: Good morning, Your Honor/.test(T.toText(cleared)));

  // One speaker alone: the recorder, no Zara call.
  openai.script = { text: "Notes for Chen.", duration: 3, segments: [{ speaker: "A", start: 0, end: 3, text: "Notes for Chen." }] };
  zara.calls = 0;
  const solo = await T.transcribeAndSave(audio, "d.m4a", { source: "app-dictation", user, clientName: "Chen, Wei" });
  check("a dictation with one voice is the recorder's, without asking Zara", () => zara.calls === 0 && T.toText(solo.row) === "JJ Zhang: Notes for Chen.");
  openai.script = null;

  console.log("\n— Parts of one recording (the 20-minute recorder) —");
  const sk = "web:7:abc";
  const [p0, p1] = await Promise.all([
    T.transcribeAndSave(audio, "c0.webm", { source: "individual-recording", user, sessionKey: sk, index: 0, clientName: "Lopez, Maria", nameNow: false }),
    T.transcribeAndSave(audio, "c1.webm", { source: "individual-recording", user, sessionKey: sk, index: 1, nameNow: false }),
  ]);
  const rec = await T.getBySession(sk);
  check("parts uploaded at the same time land in one transcript", () => p0.row.id === p1.row.id && Object.keys(rec.parts).length === 2);
  check("the same letter in two parts is two keys until named", () => eq(T.speakerKeys(rec), ["0/0:A", "0/0:B", "1/0:A", "1/0:B"]));
  check("each chunk's reply carries only that part's words", () => (p1.partText.match(/Good morning\./g) || []).length === 1);
  const joined = await T.setSpeakers(rec.id, { "0/0:A": "Immigration Judge", "1/0:A": "Immigration Judge", "0/0:B": "JJ Zhang", "1/0:B": "JJ Zhang" });
  check("naming joins them: one judge across both parts", () => [...new Set(T.blocks(joined).map(b => b.name))].join("|") === "Immigration Judge|JJ Zhang");
  check("the second part's times continue from the first", () => T.blocks(joined).filter(b => b.part === 1)[0].start >= 9);
  const failed = await T.addPart({ sessionKey: sk, index: 2, result: { error: "timeout" }, user });
  check("a part that failed says so in the transcript instead of vanishing", () => /Part 3 could not be transcribed: timeout/.test(T.toText(failed)));

  console.log("\n— Linked to the note it was applied to —");
  const stolen = await T.linkToNote(`${one.row.id}, ${rec.id}`, { noteType: "master", noteId: 99, clientName: "Someone Else", aNumber: "A999888777", byUid: 8 });
  check("a form naming someone else's transcript ids links nothing (and changes no client)", () => stolen.length === 0 && rows.find(r => r.id === one.row.id).a_number === "A249-402-327");
  let threw = false; try { await T.linkToNote("1", { noteType: "master", noteId: 1 }); } catch (e) { threw = /byUid/.test(e.message); }
  check("linkToNote refuses to run without saying whose recordings", () => threw);
  const linked = await T.linkToNote(`${one.row.id}, ${rec.id}, x`, { noteType: "individual", noteId: 44, clientName: "Lopez, Maria", aNumber: null, byUid: 7 });
  check("the hidden transcript_ids field links them", () => eq(linked.sort(), [one.row.id, rec.id].sort()));
  const forNote = await T.listForNote("individual", 44);
  check("…listForNote finds both", () => forNote.length === 2);
  const twice = await T.linkToNote(String(one.row.id), { noteType: "individual", noteId: 44, byUid: 7 });
  check("autosave every few seconds links nothing twice", () => eq(twice, []));
  await T.linkToNote(String(one.row.id), { noteType: "master", noteId: 45, byUid: 7 });
  check("…and a linked transcript is never moved to another note", () => rows.find(r => r.id === one.row.id).note_id === 44);

  const app1 = await T.autoLink({ user, noteType: "master", noteId: 50, clientName: "chen, wei", aNumber: null });
  check("a note saved from the phone picks up that person's recent dictation for the client", () => eq(app1, [solo.row.id]));
  const other = await T.autoLink({ user: { uid: 8 }, noteType: "master", noteId: 51, clientName: "Lopez, Maria" });
  check("…but not someone else's, nor web recordings", () => eq(other, []));

  const forClient = await T.listForClient({ key: "a-a249402327", clientName: "Lopez, Maria", aNumber: "A249-402-327" });
  check("the client's profile lists every transcript for that client", () => forClient.length === 2 && forClient.every(t => t.client_name === "Lopez, Maria"));
  const sameName = await T.listForClient({ key: "n-lopez-maria", clientName: "Lopez, Maria", aNumber: null });
  check("a different client with the same name does not see recordings filed under an A-number", () => !sameName.some(t => t.id === one.row.id) && sameName.some(t => t.id === rec.id));
  const byDigits = await T.listForClient({ key: "zz", aNumber: "249402327" });
  check("…found by A-number digits even when the key differs", () => byDigits.length >= 1);

  console.log("\n— Word copy and Dropbox —");
  const doc = T.toDocx(await T.get(rec.id));
  const PizZip = require("pizzip");
  const xml = new PizZip(doc).file("word/document.xml").asText();
  check("the Word copy has names, times and the verify warning", () => /Immigration Judge: Good morning\./.test(xml) && /\[0:00\]/.test(xml) && /verify against the recording/.test(xml));
  const p = await T.saveToDropbox(rec.id);
  check("it files to the client's Dropbox Transcripts folder", () => /^\/Clients\/Lopez Maria\/Transcripts\/\d{4}-\d\d-\d\d .*\(transcript \d+\)\.docx$/.test(p));
  await T.saveToDropbox(rec.id);
  check("…updating the same file after a rename (overwrite, same path)", () => dropbox.uploads.length === 2 && dropbox.uploads[1].path === p && dropbox.uploads[1].mode === "overwrite");
  let err = ""; try { await T.saveToDropbox(solo.row.id); } catch (e) { err = e.message; }
  check("a client with no Dropbox folder gets a plain reason (the transcript stays saved)", () => /no Dropbox folder/.test(err));

  console.log("\n— Small pieces —");
  check("noteFrom takes only master/individual with a real id", () => eq([T.noteFrom({ note_type: "master", note_id: "12" }), T.noteFrom({ note_type: "x", note_id: "3" }), T.noteFrom({ note_type: "individual", note_id: "0" })].map(n => n.noteId), [12, null, null]));
  check("parseNames reads the JSON out of a chatty reply", () => eq(T.parseNames('ok {"0/A":"Judge"} done', ["0/A", "0/B"]), { "0/A": "Judge" }));
  check("parseNames survives nonsense", () => eq(T.parseNames("no json", ["0/A"]), {}));
  const plainRow = { parts: { 0: { diarized: false, segments: Array.from({ length: 40 }, (_, i) => ({ speaker: null, start: i, end: i + 1, text: "word ".repeat(10).trim() })) } }, speakers: {} };
  check("without speakers, words still come in readable paragraphs", () => T.blocks(plainRow).length > 2 && T.blocks(plainRow).every(b => !b.name));
  check("clock formats long recordings", () => T.clock(3725) === "1:02:05" && T.clock(65) === "1:05");

  console.log("\n— Routes —");
  const auth = { requireRole: (...roles) => (req, res, next) => roles.includes(req.user.r) ? next() : res.status(403).json({ ok: false, error: "role" }) };
  const app = express();
  app.use(express.json());
  let who = { uid: 7, n: "JJ Zhang", r: "admin" };
  app.use((req, res, next) => { req.user = who; next(); });
  // Page chrome is not what this checks.
  require.cache[require.resolve("../hearing-notes")] = { exports: { renderAdminChrome: ({ body }) => "<html>" + body + "</html>" }, loaded: true, id: require.resolve("../hearing-notes") };
  require("../transcripts-routes").attach(app, auth);
  const srv = app.listen(0);
  const base = "http://127.0.0.1:" + srv.address().port;
  const J = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: /json/.test(r.headers.get("content-type") || "") ? await r.json() : await r.text(), headers: r.headers }; };

  const v = await J("GET", `/admin/transcripts/api/${rec.id}`);
  check("GET one transcript returns speaker blocks and names", () => v.body.ok && v.body.transcript.blocks.length >= 3 && v.body.transcript.speaker_keys.length === 4);
  const sp = await J("POST", `/admin/transcripts/api/${rec.id}/speakers`, { speakers: { "0/0:B": "Attorney JJ Zhang", "1/0:B": "Attorney JJ Zhang" } });
  check("renaming through the page saves", () => sp.body.ok && /Attorney JJ Zhang: Good morning, Your Honor/.test(sp.body.transcript.text));
  const un = rows.find(r => r.id === solo.row.id); un.client_key = null; un.client_name = null;
  const lst = await J("GET", "/admin/transcripts/api/list?unassigned=1");
  check("the list can show only recordings not yet assigned to a client", () => lst.body.transcripts.length === 1 && lst.body.transcripts[0].id === solo.row.id);
  const as = await J("POST", `/admin/transcripts/api/${solo.row.id}/client`, { client_key: "n-chen-wei" });
  check("assigning it to a client from the page", () => as.body.ok && as.body.transcript.client_name === "Chen, Wei");
  const fc = await J("GET", "/admin/transcripts/api/for-client/a-a249402327");
  check("the client panel's call lists the client's transcripts", () => fc.body.transcripts.length === 2);
  const fn = await J("GET", "/admin/transcripts/api/for-note/individual/44");
  check("the note panel's call lists the note's transcripts", () => fn.body.transcripts.length === 2);
  const dl = await fetch(base + `/admin/transcripts/api/${rec.id}/download.docx`);
  check("Word download", () => dl.status === 200 && /wordprocessingml/.test(dl.headers.get("content-type")));
  const tx = await J("GET", `/admin/transcripts/api/${rec.id}/download.txt`);
  check("text download has names and times", () => /\[0:00\] Immigration Judge: Good morning\./.test(tx.body));
  who = { uid: 9, n: "Para", r: "paralegal" };
  const pv = await J("GET", `/admin/transcripts/api/${rec.id}`);
  check("…reading works for a paralegal", () => pv.status === 200 && pv.body.can_delete === false);
  const pr = await J("POST", `/admin/transcripts/api/${rec.id}/speakers`, { speakers: { "0/0:A": "Mystery" } });
  check("…a paralegal cannot rename speakers or reassign (attorneys only)", () => pr.status === 403 && pv.body.can_edit === false);
  const pd = await J("DELETE", `/admin/transcripts/api/${rec.id}`);
  check("…but only an admin can delete", () => pd.status === 403 && rows.some(r => r.id === rec.id));
  who = { uid: 10, n: "Consultant", r: "consultant" };
  const cv = await J("GET", `/admin/transcripts/api/${rec.id}`);
  check("consultants cannot read transcripts", () => cv.status === 403);
  who = { uid: 7, n: "JJ Zhang", r: "admin" };
  const ad = await J("DELETE", `/admin/transcripts/api/${rec.id}`);
  check("an admin can delete one", () => ad.body.ok && !rows.some(r => r.id === rec.id));
  const fresh = await T.addPart({ result: { text: "hi", segments: [] }, user: { uid: 7, n: "JJ Zhang" }, source: "master-dictation" });
  who = { uid: 8, n: "Other", r: "attorney" };
  const lx = await J("POST", `/admin/transcripts/api/${fresh.id}/link`, { note_type: "master", note_id: 70 });
  check("Apply's link call cannot attach someone else's recording", () => lx.body.linked === false);
  who = { uid: 7, n: "JJ Zhang", r: "admin" };
  const lo = await J("POST", `/admin/transcripts/api/${fresh.id}/link`, { note_type: "master", note_id: 70 });
  check("…but links the recorder's own", () => lo.body.linked === true && rows.find(r => r.id === fresh.id).note_id === 70);
  const pg = await J("GET", `/admin/transcripts/${one.row.id}`);
  check("the transcript page loads its script", () => /data-transcripts="view"/.test(pg.body) && /transcripts-page\.js/.test(pg.body));
  srv.close();

  console.log("\n— Wiring —");
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const between = (a, b) => server.slice(server.indexOf(a), server.indexOf(b, server.indexOf(a) + 1));
  check("extract-only saves the transcript (not the old forget-it call)", () => /transcribeAndSave/.test(between('"/admin/hearing/notes/dictate/extract-only"', "app.post(")) && !/voice\.transcribeAudio/.test(between('"/admin/hearing/notes/dictate/extract-only"', "app.post(")));
  check("transcribe-chunk saves each part under the recorder's session", () => /sessionKey/.test(between('"/admin/hearing/notes/dictate/transcribe-chunk"', "async function compressAudioForWhisper")));
  check("process saves and links to the note it creates", () => /linkToNote\(\[trow\.id\]/.test(between('"/admin/hearing/notes/dictate/process"', 'app.post("/admin/hearing/notes/merge-duplicates"')));
  check("every hearing-note save links the transcripts named in the form", () => (server.match(/linkToNote\(req\.body\.transcript_ids/g) || []).length === 5);
  check("extract-from-text uses a transcript id only if it is the caller's own", () => /String\(own\.created_by_uid\) !== String\(req\.user\.uid\)/.test(between('"/admin/hearing/notes/dictate/extract-from-text"', 'app.post("/admin/hearing/notes/dictate/process"')));
  check("form saves link only the saver's own recordings", () => (server.match(/byUid: req\.user \? req\.user\.uid : "none"/g) || []).length === 5);
  check("the Transcripts pages are mounted", () => /require\("\.\/transcripts-routes"\)\.attach\(app, auth\)/.test(server));
  const appApi = fs.readFileSync(path.join(REPO, "app-api.js"), "utf8");
  check("the phone's dictation saves too", () => /source: "app-dictation"/.test(appApi) && !/voice\.transcribeAudio/.test(appApi));
  check("phone note saves (master, individual, edit) link transcripts", () => (appApi.match(/linkAppTranscripts\(req, "/g) || []).length === 3);

  console.log("\n— Pages —");
  Module._load = orig;   // the real page renderers from here on
  for (const k of Object.keys(require.cache)) if (/tezlaw-bot\/(hearing-notes|individual-hearing-notes|client-profiles)\.js$/.test(k) || k.endsWith("/hearing-notes.js")) delete require.cache[k];
  const hn = require("../hearing-notes"), ih = require("../individual-hearing-notes");
  const pages = { "master new": hn.renderNoteForm({}), "master edit": hn.renderNoteForm({ noteId: 12, prev: { client_name: "X" } }),
    "individual new": ih.renderForm({}), "individual edit": ih.renderForm({ noteId: 5, prev: { client_name: "Y" } }) };
  for (const [name, html] of Object.entries(pages)) {
    const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    check(`${name}: every inline script parses`, () => { scripts.forEach(s => new vm.Script(s)); return true; });
  }
  check("editing a master note: Apply links to it, and the note shows its transcripts", () => /const D_NOTE_ID = 12;/.test(pages["master edit"]) && /api\/" \+ dTranscriptId \+ "\/link"/.test(pages["master edit"]) && !/fd\.append\("note_id"/.test(pages["master edit"]) && /data-transcripts="note" data-note-type="master" data-note-id="12"/.test(pages["master edit"]));
  check("editing an individual note: same", () => /const D_NOTE_ID = 5;/.test(pages["individual edit"]) && /data-note-type="individual" data-note-id="5"/.test(pages["individual edit"]));
  check("the individual recorder sends a session id with each part", () => /fd\.append\("session_id", dSessionId\)/.test(pages["individual new"]));
  check("Apply puts the transcript id in the form (so saving links it)", () => /name = "transcript_ids"/.test(pages["master new"]) && /name = "transcript_ids"/.test(pages["individual new"]));
  const cp = fs.readFileSync(path.join(REPO, "client-profiles.js"), "utf8");
  check("the client profile has a Transcripts panel", () => /data-transcripts="client" data-client-key=/.test(cp) && /clientScriptTag\("transcripts-page\.js"\)/.test(cp));
  check("the nav has Transcripts", () => /href="\/admin\/transcripts"/.test(fs.readFileSync(path.join(REPO, "hearing-notes.js"), "utf8")));

  console.log("\n— The page script —");
  const bundle = fs.readFileSync(path.join(REPO, "public", "transcripts-page.js"), "utf8");
  const sample = T.full({ id: 3, title: "Individual hearing recording — Lopez, Maria", client_key: "a-a249402327", client_name: "Lopez, Maria", a_number: "A249-402-327",
    created_at: new Date().toISOString(), created_by: "JJ Zhang", note_type: "individual", note_id: 44, speakers: { "0/0:A": "Immigration Judge", "0/0:B": "JJ Zhang" },
    parts: { 0: { diarized: true, duration: 20, segments: [{ speaker: "0:A", start: 0, end: 3, text: "Good morning." }, { speaker: "0:B", start: 3, end: 6, text: "Good morning, Your Honor." }, { speaker: "0:C", start: 6, end: 9, text: "Interpreter sworn." }] } } });
  const posted = [];
  const dom = new JSDOM(`<div data-transcripts="view" data-id="3"></div>`, { runScripts: "outside-only", url: "http://x/admin/transcripts/3" });
  dom.window.fetch = async (url, init) => {
    if (init && init.method === "POST") posted.push({ url, body: JSON.parse(init.body || "{}") });
    const body = /\/speakers$/.test(url) ? { ok: true, transcript: sample } : { ok: true, transcript: sample, can_delete: false, can_edit: true };
    return { ok: true, status: 200, json: async () => body };
  };
  dom.window.eval(bundle);
  await new Promise(r => setTimeout(r, 50));
  const doc2 = dom.window.document;
  const text = doc2.body.textContent;
  check("the page shows each speaker's words under their name", () => /Immigration Judge/.test(text) && /Good morning, Your Honor\./.test(text) && /Speaker 3/.test(text));
  check("…with the client and a link to the hearing note", () => /Lopez, Maria/.test(text) && !!doc2.querySelector('a[href="/admin/hearing/individual/44"]'));
  check("…Word and text downloads", () => !!doc2.querySelector('a[href$="/download.docx"]') && !!doc2.querySelector('a[href$="/download.txt"]'));
  const find = doc2.querySelector('input[placeholder^="Find in this transcript"]');
  find.value = "sworn"; find.dispatchEvent(new dom.window.Event("input"));
  check("find narrows to the matching turns and marks the words", () => doc2.querySelectorAll("mark").length === 1 && !/Good morning, Your Honor/.test(doc2.body.textContent.split("Find in this transcript")[1] || doc2.body.textContent.slice(-200)));
  const boxes = [...doc2.querySelectorAll("details input[type=text]")];
  check("one name box per speaker", () => boxes.length === 3);
  boxes[2].value = "Interpreter";
  [...doc2.querySelectorAll("button")].find(b => b.textContent === "Save names").click();
  await new Promise(r => setTimeout(r, 20));
  check("Save names sends the new name for that speaker's key", () => posted.length === 1 && posted[0].body.speakers["0/0:C"] === "Interpreter" && posted[0].body.speakers["0/0:A"] === "Immigration Judge");

  const dom2 = new JSDOM(`<div data-transcripts="client" data-client-key="a-x"></div>`, { runScripts: "outside-only", url: "http://x/admin/clients/a-x" });
  dom2.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, transcripts: [T.summary({ id: 3, title: "Hearing dictation — X", parts: {}, speakers: {}, created_at: new Date().toISOString(), text: "Judge: hello" })] }) });
  dom2.window.eval(bundle);
  await new Promise(r => setTimeout(r, 30));
  check("the client panel lists transcripts with links", () => !!dom2.window.document.querySelector('a[href="/admin/transcripts/3"]') && /Transcripts \(1\)/.test(dom2.window.document.body.textContent));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
