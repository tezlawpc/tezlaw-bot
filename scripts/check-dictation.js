/**
 * check-dictation.js
 *
 * JJ, 2026-09-29: voice dictation answering "❌ Not authenticated. Please log
 * in."
 *
 * The cause was a 24-hour session expiring under a page left open overnight.
 * The damage was worse than the message: the error handler hid the playback
 * panel and showed the record panel, so the Transcribe button disappeared and
 * a finished recording became unreachable — still in memory, with no way to
 * send it. A recoverable failure destroyed a hearing note.
 *
 * Everything here is asserted against the RENDERED page rather than the file,
 * because the file and the script the browser runs are not the same text.
 */
const path = require("path");
const fs = require("fs");

// Stub only unresolvable bare modules — rendering touches no database.
const Module = require("module");
const orig = Module._load;
Module._load = function (req) {
  try { return orig.apply(this, arguments); }
  catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && !req.startsWith(".") && !req.startsWith("/")) {
      const fn = () => fn;
      return new Proxy(fn, { get: () => fn, apply: () => fn });
    }
    throw e;
  }
};

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const page = require("../voice-dictation").renderDictatePage({});
const script = [...String(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

console.log("\n── The recording survives a failed upload ──────");
ok("the page still compiles in a browser", (() => {
  try { new Function(script); return true; } catch { return false; }
})());
ok("showError keeps the playback panel up when the audio is still in memory",
  /var keep = !!audioBlob;/.test(script) &&
  /playback-panel"\)\.style\.display = keep \? "block" : "none"/.test(script));
ok("…so the Transcribe button is still there to press again",
  /onclick="submitAudio\(\)"/.test(page));
ok("the record panel only takes over when the audio is genuinely gone",
  /record-panel"\)\.style\.display = keep \? "none" : "block"/.test(script));

console.log("\n── An expired session is named, not mystifying ──");
ok("a 401 is told apart from any other failure",
  /if \(resp\.status === 401\) err\.authExpired = true;/.test(script));
ok("…and produces a message that says what happened",
  /Your session expired while this page was open/.test(script));
ok("…that reassures the recording is safe",
  /Your recording is safe/.test(script));
ok("…with a login link that opens a NEW tab, so this page and its audio survive",
  /id="error-login"[^>]*target="_blank"/.test(page));
ok("the login link is hidden unless it is the auth case",
  /error-login"\)\.style\.display = o\.login \? "inline-block" : "none"/.test(script));

console.log("\n── Asked before recording, when it is free ──────");
ok("the session is checked before the microphone opens",
  script.indexOf("await sessionAlive()") < script.indexOf("navigator.mediaDevices.getUserMedia"));
ok("whoami is read by its actual contract, not a guess across fields",
  /d\.authenticated === true/.test(script));
ok("a network failure does not stop someone recording",
  /return true;\s*\/\/ offline or blocked/.test(script));

console.log("\n── A local copy can always be kept ─────────────");
ok("there is a save button on the playback panel",
  /onclick="downloadAudio\(\)"/.test(page));
ok("it downloads the actual recording", /a\.href = URL\.createObjectURL\(audioBlob\)/.test(script));
ok("the file is named with a timestamp, not overwritten each time",
  /a\.download = "dictation-" \+ new Date\(\)\.toISOString\(\)/.test(script));
ok("the object URL is released afterwards", /URL\.revokeObjectURL/.test(script));

console.log("\n── Saving is separate from transcribing ────────");
{
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const inbox = fs.readFileSync(path.join(__dirname, "..", "dictation-inbox.js"), "utf8");

  ok("there is a save endpoint that does not transcribe",
    /app\.post\("\/admin\/hearing\/notes\/dictate\/save"/.test(srv));
  {
    const i = srv.indexOf('dictate/save"');
    const body = srv.slice(i, srv.indexOf("app.get(", i));
    ok("…and it really does not — no transcribe call on that path",
      !/transcribeAndSave|extractFieldsFromTranscript/.test(body));
    ok("…it answers as soon as the audio is stored",
      /res\.json\(\{ ok: true, id: row\.id/.test(body));
  }

  ok("Save is the prominent button on the page", /onclick="saveOnly\(\)"/.test(page));
  ok("…and the page says the laptop can be closed",
    /You can close the laptop now/.test(page));
  ok("Transcribe now is still available", /onclick="submitAudio\(\)"/.test(page));

  // Scoped to the /process route. A global index comparison would be
  // meaningless here: transcribeAndSave also appears in /dictate/extract-only,
  // which sits earlier in the file.
  {
    const i = srv.indexOf('app.post("/admin/hearing/notes/dictate/process"');
    const body = i < 0 ? "" : srv.slice(i, i + 4000);
    const park = body.indexOf('require("./dictation-inbox").save(');
    const tx = body.indexOf("transcribeAndSave");
    ok("even Transcribe now parks the audio first, so a failure costs the "
     + "transcription and never the recording",
      i > -1 && park > -1 && tx > -1 && park < tx,
      `park=${park} transcribe=${tx}`);
  }

  ok("a failed transcription KEEPS the audio, so it can be retried",
    /Audio is deliberately KEPT on failure/.test(inbox) &&
    /status='failed', error=\$2/.test(inbox) && !/status='failed'[^;]*audio=NULL/.test(inbox));
  ok("a finished one drops the audio, because the transcript is the record",
    /status='done'[\s\S]{0,60}audio=NULL/.test(inbox));
  ok("a recording cannot be transcribed twice at once",
    /WHERE id = \$1 AND status IN \('saved', 'failed'\) RETURNING/.test(inbox));
  ok("waiting recordings are transcribed on a timer",
    /setInterval\(sweep, 5 \* 60 \* 1000\)/.test(srv));
  ok("…and shortly after a restart, for anything left over",
    /setTimeout\(sweep, 30 \* 1000\)/.test(srv));
  ok("a failing recording is retried a bounded number of times",
    /attempts < \$2/.test(inbox) && /maxAttempts = 3/.test(inbox));
  ok("there is a page showing what is waiting",
    /app\.get\("\/admin\/hearing\/notes\/dictate\/inbox"/.test(srv));
  ok("…with a button to transcribe one now",
    /inbox\/:id\/transcribe/.test(srv));

  const ip = require("../dictation-inbox-page");
  const html = ip.render({ counts: { saved: 1 }, rows: [
    { id: 1, client_name: "Gao", status: "saved", attempts: 0, created_at: new Date() },
    { id: 2, client_name: "Li", status: "failed", attempts: 2, error: "empty", created_at: new Date() },
  ] });
  ok("a waiting recording can be transcribed on demand", /Transcribe now/.test(html));
  ok("a failed one can be tried again", /Try again/.test(html));
  ok("the inbox page has no inline JavaScript either", !/onclick=|<script/.test(html));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL DICTATION CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
