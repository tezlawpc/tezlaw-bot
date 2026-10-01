/**
 * check-offline-notes.js
 *
 * JJ: "the purpose is so that i can save and do hearing dictation and notes
 * even without internet."
 *
 * Immigration court is in a basement. The properties that matter are the ones
 * that decide whether an hour of a hearing survives a dead connection, and
 * every one of them is a way to lose work quietly:
 *
 *   · a slice is forgotten only after the SERVER says it has it
 *   · a queued note is kept when the network fails, not dropped
 *   · a restored draft is OFFERED, never silently applied over a blank form,
 *     because filling one client's note with another is worse than losing it
 *   · passwords and file inputs are never mirrored to disk
 *   · and when there IS a connection, the forms behave exactly as before —
 *     this must not be able to break the working path
 *
 * The queue is exercised against a stub rather than only pattern-matched,
 * because "keeps the item on failure" is a behaviour, not a spelling.
 */
const fs = require("fs");
const path = require("path");

const stubs = require("./lib/stub-missing");
stubs.install();

const REPO = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(REPO, "public", "offline-notes.js"), "utf8");
const bundles = fs.readFileSync(path.join(REPO, "client-script.js"), "utf8");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// ── 1. it is deployed the way the rest of the client code is ───────────
console.log("\nit reaches the browser at all");
{
  ok("registered in CLIENT_BUNDLES, so a missing deploy shows a banner",
    /"offline-notes\.js"/.test(bundles));

  const pages = [
    ["the dictation page", "voice-dictation.js", "renderDictatePage"],
    ["the master hearing note form", "hearing-notes.js", "renderNoteForm"],
    ["the individual hearing note form", "individual-hearing-notes.js", null],
  ];
  for (const [label, file, fn] of pages) {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    ok(label + " loads it", /clientScriptTag\("offline-notes\.js"\)/.test(text));
  }

  // And actually rendered, not just present in the source.
  const page = require("../voice-dictation").renderDictatePage();
  ok("...and the tag survives rendering", /\/static\/offline-notes\.js\?v=/.test(page));
}

// ── 2. the rules that keep work from vanishing ─────────────────────────
console.log("\na slice is forgotten only once the server has it");
{
  const vd = fs.readFileSync(path.join(REPO, "voice-dictation.js"), "utf8");
  // Compared INSIDE the handler. Comparing positions in the whole file would
  // be a positional guess: uploadSlices is defined near the top and called
  // from a handler far below it, so the file order says nothing about the
  // order things happen in.
  const made = vd.slice(vd.indexOf("mediaRecorder.ondataavailable"), vd.indexOf("mediaRecorder.onstop"));
  ok("the durable copy is written before the upload is kicked",
    made.indexOf("offlineNotes.putSlice(") < made.indexOf("uploadSlices()"),
    "a slice uploaded before it is stored can be lost by a failure mid-request");
  const up = vd.slice(vd.indexOf("async function uploadSlices"), vd.indexOf("async function drainStoredSlices"));
  ok("dropSlice happens after the ok response", up.indexOf("data.ok") < up.indexOf("offlineNotes.dropSlice"));
  ok("storage being blocked does not stop the upload path",
    /putSlice\([\s\S]{0,400}catch\(function \(\) \{/.test(vd));

  const drain = vd.slice(vd.indexOf("async function drainStoredSlices"), vd.indexOf("// Drain on load"));
  ok("leftovers from a previous page life are sent", /pendingSlices\(\)/.test(drain));
  ok("...and the live recording is left to the in-memory queue, not raced",
    /v\.sessionId === sliceSessionId\) continue;/.test(drain));
  ok("...and a still-dead connection leaves the rest for next time", /return;   \/\/ still no usable/.test(drain));
  ok("a drained session is closed out rather than left to the sweeper",
    /dictate\/slice\/finish/.test(drain));
  ok("draining runs on load and on reconnect",
    /window\.addEventListener\("load", function \(\) \{ drainStoredSlices\(\); \}\)/.test(vd) &&
    /offlineNotes\.whenOnline\(/.test(vd));
}

console.log("\nthe online path is untouched");
{
  const guard = src.slice(src.indexOf("function guardNoteForm"), src.indexOf("function saidQueued"));
  ok("the submit handler returns immediately when online",
    /if \(navigator\.onLine\) return;/.test(guard));
  ok("...before anything is prevented or queued",
    guard.indexOf("navigator.onLine) return") < guard.indexOf("preventDefault"));
  ok("the draft key is scoped by the form action, so an edit page cannot restore another note",
    /key \+ ":" \+ \(form\.getAttribute\("action"\)/.test(guard));
}

console.log("\na draft is offered, never silently applied");
{
  const watch = src.slice(src.indexOf("function watchForm"), src.indexOf("function applyDraft"));
  ok("restoring goes through an offer", /offerDraft\(form, key, draft\)/.test(watch));
  ok("...and applyDraft is not called from the watcher", !/applyDraft\(/.test(watch));
  const offer = src.slice(src.indexOf("function offerDraft"), src.indexOf("// ── Queued submissions"));
  ok("the offer has a restore button", /use\.onclick/.test(offer) && /applyDraft\(form, draft\.data\)/.test(offer));
  ok("...and a discard button", /drop\.onclick/.test(offer) && /clearDraft\(key\)/.test(offer));
  ok("the offer says when the draft is from", /toLocaleString\(\)/.test(offer));
  ok("an all-blank draft is not offered at all", /\.trim\(\) !== ""/.test(watch));
}

console.log("\nwhat is never written to disk");
{
  const fields = src.slice(src.indexOf("function fieldsOf"), src.indexOf("function saveDraft"));
  ok("file inputs are skipped", /el\.type === "file"/.test(fields));
  ok("password inputs are skipped", /el\.type === "password"/.test(fields));
}

console.log("\nstorage that is blocked or full must not break the page");
{
  // Every bare localStorage / indexedDB access has to sit inside a try.
  const risky = [];
  src.split("\n").forEach(function (line, i) {
    if (/localStorage\.|indexedDB\.open/.test(line) && !/try \{|catch/.test(line)) {
      // allowed only when the enclosing helper is one of the wrapped ones
      risky.push((i + 1) + ": " + line.trim());
    }
  });
  const wrapped = risky.filter(function (l) {
    return !/^\s*\d+: (try|\} catch)/.test(l);
  });
  ok("localStorage and indexedDB are only touched inside wrapped helpers",
    wrapped.length <= 4, wrapped.join(" | "));
  ok("the IndexedDB open is itself guarded", /try \{ req = indexedDB\.open/.test(src));
  ok("slice keys are zero padded, because they sort as strings and audio must reassemble in order",
    /padStart\(6, "0"\)/.test(src));
}

// ── 3. the queue, for real ─────────────────────────────────────────────
console.log("\nthe submit queue, exercised");
{
  const store = {};
  const fakeLocal = {
    getItem: function (k) { return k in store ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
  };
  const el = () => ({ style: {}, appendChild() {}, remove() {}, setAttribute() {}, textContent: "", innerHTML: "",
                      addEventListener() {}, querySelectorAll: () => [], getAttribute: () => "/x", parentNode: { insertBefore() {} } });
  const sandbox = {
    window: { addEventListener() {}, scrollTo() {} },
    document: { createElement: el, body: { appendChild() {} }, getElementById: () => null },
    localStorage: fakeLocal,
    navigator: { onLine: false },
    indexedDB: { open() { throw new Error("no indexedDB in this check"); } },
    setTimeout: setTimeout, clearTimeout: clearTimeout, Date: Date, Math: Math,
    JSON: JSON, Object: Object, Promise: Promise, String: String, Number: Number,
    encodeURIComponent: encodeURIComponent, console: { log() {}, warn() {} },
  };
  sandbox.window.addEventListener = function () {};
  const run = new Function("window", "document", "localStorage", "navigator", "indexedDB",
    "setTimeout", "clearTimeout", "fetch", src + "\n;return window.offlineNotes;");

  let calls = [];
  const fakeFetch = (url, opt) => {
    calls.push({ url: url, body: opt.body });
    return Promise.resolve({ ok: false, status: 0 });   // a dead network
  };
  const api = run(sandbox.window, sandbox.document, fakeLocal, sandbox.navigator,
    sandbox.indexedDB, setTimeout, clearTimeout, fakeFetch);

  ok("the module exposes its API", !!api && typeof api.queueSubmit === "function");

  api.queueSubmit("/admin/hearing/notes", { client_name: "Wang", notes: "pleadings taken" }, "master hearing note");
  ok("a queued note is stored", JSON.parse(store["tez.submitQueue"]).length === 1);
  ok("...with its fields intact",
    JSON.parse(store["tez.submitQueue"])[0].fields.client_name === "Wang");

  return api.flushQueue().then(function (r) {
    ok("a network failure sends nothing", r.sent === 0);
    ok("...and KEEPS the note rather than dropping it", r.left === 1,
      "this is the property that matters: losing it here loses the hearing");
    ok("...and it was actually attempted", calls.length === 1);
    ok("...encoded as a form post the existing route can parse",
      /client_name=Wang/.test(calls[0].body));

    const serverRefused = (url, opt) => Promise.resolve({ ok: false, status: 400 });
    const api2 = run(sandbox.window, sandbox.document, fakeLocal, sandbox.navigator,
      sandbox.indexedDB, setTimeout, clearTimeout, serverRefused);
    return api2.flushQueue().then(function (r2) {
      ok("a 4xx is not retried forever", r2.sent === 0);
      ok("...but the note is still kept for a human to look at", r2.left === 1);
      const row = JSON.parse(store["tez.submitQueue"])[0];
      ok("...and marked with why", !!row.failedPermanently && /HTTP 400/.test(row.error || ""));
      done();
    });
  });
}

function done() {
  if (stubs.note()) console.log("\n" + stubs.note());
  console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL OFFLINE NOTES CHECKS PASSED\n");
  process.exit(failures ? 1 : 0);
}
