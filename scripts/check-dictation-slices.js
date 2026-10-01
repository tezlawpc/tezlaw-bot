/**
 * check-dictation-slices.js
 *
 * JJ: "i need to be able to save the voice dictation asap when its stopped or
 * constantly saving every 5 minutes?"
 *
 * The property under test is the one he actually cares about: a hearing he
 * recorded is recoverable even if he shuts the laptop the instant it ends and
 * never opens that tab again. That requires three things to hold together:
 *
 *   1. The browser records in slices and uploads them DURING the hearing.
 *      mediaRecorder.start() with no argument fires ondataavailable once, at
 *      stop, which is what made the whole recording perishable.
 *   2. The server stores slices by position and assembles only at the end,
 *      and a retried slice does not duplicate itself in the middle of the
 *      audio.
 *   3. Nothing waits for the page to say "finish", because it often cannot.
 *
 * The browser half is checked by reading the page the browser is actually
 * served — this script is inside a template literal, and asserting on the
 * source file would not catch the escaping fault that once killed it.
 */
const fs = require("fs");
const path = require("path");

const stubs = require("./lib/stub-missing");
stubs.install();

const REPO = path.join(__dirname, "..");
const vd = fs.readFileSync(path.join(REPO, "voice-dictation.js"), "utf8");
const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const chunksSrc = fs.readFileSync(path.join(REPO, "dictation-chunks.js"), "utf8");
const chunks = require("../dictation-chunks");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// The page as the browser gets it.
const page = require("../voice-dictation").renderDictatePage
  ? require("../voice-dictation").renderDictatePage()
  : null;

// ── 1. the browser uploads while recording ─────────────────────────────
console.log("\nthe recording leaves the laptop while the hearing runs");
{
  ok("MediaRecorder is started WITH a timeslice", /mediaRecorder\.start\(SLICE_MS\)/.test(vd));
  ok("...and never without one again", !/mediaRecorder\.start\(\);/.test(vd));
  ok("the slice interval is seconds, not the five minutes originally asked for",
    /const SLICE_MS = (\d+);/.test(vd) && Number(vd.match(/const SLICE_MS = (\d+);/)[1]) <= 60000,
    "a five-minute slice would still lose five minutes of a hearing");

  const handler = vd.slice(vd.indexOf("mediaRecorder.ondataavailable"), vd.indexOf("mediaRecorder.onstop"));
  ok("each slice is queued for upload as it arrives", /sliceQueue\.push\(/.test(handler));
  ok("...and the upload is kicked immediately", /uploadSlices\(\)/.test(handler));
  ok("a local copy is still kept, so playback needs no round trip", /chunks\.push\(e\.data\)/.test(handler));
}

console.log("\na failed upload does not punch a hole in the audio");
{
  const up = vd.slice(vd.indexOf("async function uploadSlices"), vd.indexOf("async function finishSlices"));
  ok("the queue is drained in order from the head", /sliceQueue\[0\]/.test(up));
  ok("a slice is removed ONLY after the server acknowledges it",
    up.indexOf("sliceQueue.shift()") > up.indexOf("data.ok"));
  ok("a failure leaves the slice queued rather than dropping it",
    !/catch[\s\S]{0,200}sliceQueue\.shift/.test(up));
  ok("...and says so out loud instead of looking fine", /Upload is behind/.test(up));
  ok("one upload at a time, so slices cannot race into the wrong order",
    /if \(sliceUploading \|\| !sliceSessionId\) return;/.test(up));
}

console.log("\nstop does the saving, without a button press");
{
  const onstop = vd.slice(vd.indexOf("mediaRecorder.onstop"), vd.indexOf("// A timeslice is the entire fix"));
  ok("stopping flushes and finishes by itself", /await finishSlices\(\)/.test(onstop));
  ok("success goes straight to the saved panel", /saved-panel[\s\S]{0,80}block/.test(onstop));
  ok("...and says the laptop can be closed", /close the laptop/.test(onstop));
  ok("failure falls back to the whole-file upload rather than pretending",
    /showPlayback\(\)/.test(onstop) && /did not get the whole recording/.test(onstop));

  const save = vd.slice(vd.indexOf("async function saveOnly"), vd.indexOf("async function submitAudio"));
  ok("the Save button will not file a second copy of the same hearing",
    /if \(sliceSavedId\)/.test(save));
}

console.log("\nthe page the browser is served actually contains it");
{
  ok("renderDictatePage is exported and renders", !!page && page.length > 1000);
  if (page) {
    ok("the slice uploader reached the page", /function uploadSlices/.test(page));
    ok("the timeslice reached the page", /mediaRecorder\.start\(SLICE_MS\)/.test(page));
    ok("the safety line is in the markup", /id="slice-status"/.test(page));
    ok("pagehide makes a last-gasp attempt", /sendBeacon/.test(page));
    // The real test is not whether the text looks right — a correctly escaped
    // quote in the DELIVERED script is ordinary and fine. It is whether what
    // the browser receives parses at all. That is the fault that took client
    // search down: the source escaped a quote, the template literal ate the
    // backslash, and the browser got a string that ended early.
    // The page carries more than one script block (the shared admin chrome has
    // its own), so take the one that holds this feature rather than slicing
    // from the first opening tag to the last closing one.
    const blocks = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(page)) !== null) blocks.push(m[1]);
    const script = blocks.find(b => b.includes("function uploadSlices")) || "";
    let parsed = true, why = "";
    try { new Function(script); } catch (e) { parsed = false; why = e.message; }
    ok("the script the browser is served actually parses", parsed, why);
    ok("...and it is the whole script, not a fragment", script.length > 2000);
  }
}

// ── 2. the server side ─────────────────────────────────────────────────
console.log("\nslices are stored by position and assembled once");
{
  ok("a slice is keyed by session and index", /PRIMARY KEY \(session_id, idx\)/.test(chunksSrc));
  ok("a retried slice is ignored rather than duplicated",
    /ON CONFLICT \(session_id, idx\) DO NOTHING/.test(chunksSrc));
  ok("beginning a session is idempotent, so no slice depends on an earlier call",
    /ON CONFLICT \(id\) DO UPDATE SET/.test(chunksSrc));
  ok("late-typed hints can still land", /COALESCE\(EXCLUDED\.client_name/.test(chunksSrc));
  ok("a session id has to look like one", /\^\[A-Za-z0-9_-\]\{8,64\}\$/.test(chunksSrc));

  const fin = chunksSrc.slice(chunksSrc.indexOf("async function finish"), chunksSrc.indexOf("async function sweepAbandoned"));
  ok("assembly is in index order", /ORDER BY idx/.test(fin));
  ok("a hole truncates rather than producing rubbish after it",
    /if \(row\.idx !== expected\)/.test(fin));
  ok("...and the truncation is recorded in words", /a slice did not arrive/.test(fin));
  ok("finishing twice does not create two inbox rows", /if \(s\.finished_at\) return/.test(fin));
  ok("the audio goes to the inbox, which already handles transcription",
    /require\("\.\/dictation-inbox"\)/.test(fin) && /inbox\.save\(/.test(fin));
  ok("slices are dropped once the inbox owns the bytes",
    /DELETE FROM dictation_slices WHERE session_id/.test(fin));
}

console.log("\nnothing waits for the attorney to come back");
{
  ok("there is a sweeper for abandoned sessions", typeof chunks.sweepAbandoned === "function");
  const sweep = chunksSrc.slice(chunksSrc.indexOf("async function sweepAbandoned"), chunksSrc.indexOf("/** Open sessions"));
  ok("it picks sessions that went quiet", /last_slice_at < NOW\(\) - /.test(sweep));
  ok("...only unfinished ones", /finished_at IS NULL/.test(sweep));
  ok("and marks who finished them, so a swept one is distinguishable",
    /by: "sweeper"/.test(sweep));
  ok("the quiet period is long enough to survive a tunnel",
    chunks.QUIET_MINUTES >= 10, "QUIET_MINUTES=" + chunks.QUIET_MINUTES);

  ok("the sweeper is actually scheduled on boot",
    /require\("\.\/dictation-chunks"\)\.initTables\(\)/.test(srv) &&
    /sweepAbandoned\(\)/.test(srv));
  ok("...on an interval, not once", /setInterval\(sweep, 5 \* 60 \* 1000\)/.test(
    srv.slice(srv.indexOf("dictation-chunks\").initTables"), srv.indexOf("require(\"./social-posts\")"))));
}

console.log("\nthe routes exist and do not collide with the live-transcribe one");
{
  ok("slice upload route", /app\.post\("\/admin\/hearing\/notes\/dictate\/slice"/.test(srv));
  ok("finish route", /app\.post\("\/admin\/hearing\/notes\/dictate\/slice\/finish"/.test(srv));
  ok("a route to ask which slices landed", /dictate\/slice\/have/.test(srv));
  ok("the pre-existing transcribe-chunk route is untouched",
    /app\.post\("\/admin\/hearing\/notes\/dictate\/transcribe-chunk"/.test(srv));
  ok("the old whole-file save still exists as the fallback",
    /app\.post\("\/admin\/hearing\/notes\/dictate\/save"/.test(srv));

  const route = srv.slice(srv.indexOf('dictate/slice"'), srv.indexOf('dictate/slice/have'));
  ok("every slice asserts its session, rather than trusting an earlier call",
    /await chunks\.begin\(/.test(route));
}

if (stubs.note()) console.log("\n" + stubs.note());
console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL DICTATION SLICE CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
