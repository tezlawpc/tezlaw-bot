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

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL DICTATION CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
