/**
 * check-i589-folder-view.js
 *
 * TWO THINGS WENT WRONG WITH THE I-589 FILE MATCHING, both the same mistake.
 *
 * The matching rules were widened twice by inferring the firm's naming
 * conventions from the handful of filenames that happened to be visible on
 * screen. The first guess ranked a supplement packet above the base form.
 * The second added "asylum application", which matched
 * "TANG, JINGKUI Asylum Application Fee Receipts.pdf" — so a folder's
 * payment receipts were downloaded and sent to a vision model to be read as
 * though they were the form. Meanwhile 180 clients sit in a "no I-589"
 * bucket nobody has ever looked inside.
 *
 * The fix for guessing is not a cleverer guess. It is a page that lists the
 * real filenames with the score each one got, so the next change to these
 * rules is made against evidence. This file tests that the receipts no
 * longer rank as the form, and that the page cannot do any harm:
 *
 *   1. The receipts file must not be treated as a candidate at all.
 *   2. A genuine form must still outrank what sits beside it, and a form
 *      that merely mentions a receipt must stay reachable.
 *   3. inspectFolder must be free and read-only. If it ever downloads a file
 *      or calls the model, "just look at the folder" quietly becomes a
 *      per-client API bill — and a diagnostic that costs money stops being
 *      run, which is how we got here.
 *   4. It must write nothing. It gets pointed at clients whose proposals
 *      have already been applied.
 *   5. The page must carry no inline <script>. An apostrophe in a client's
 *      filename is precisely the input that took client search down for five
 *      hours on 2026-09-28.
 *
 * Nothing here touches Dropbox or the database; both are stubbed, and every
 * call they receive is recorded so "it downloaded nothing" is observed
 * rather than assumed.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const stub = require("./lib/stub-missing");
stub.install();

const x = require("../i589-extract");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// ── 1 & 2. Scoring, against the real filenames that caused the trouble ──
console.log("scoring");

const receipts = { name: "TANG, JINGKUI Asylum Application Fee Receipts.pdf" };
const form     = { name: "MA, JIANLI I-589 signed.pdf" };
const supp     = { name: "MA, JIANLI I-589 Supplement B.pdf" };
const stmt     = { name: "MA, JIANLI Declaration.pdf" };
const withFee  = { name: "I-589 with fee receipt.pdf" };

ok("the fee-receipts file is not a candidate",
   x.scoreCandidate(receipts) <= 0, "scored " + x.scoreCandidate(receipts));
ok("a plain signed form outranks the supplement beside it",
   x.scoreCandidate(form) > x.scoreCandidate(supp));
ok("a plain signed form outranks the declaration beside it",
   x.scoreCandidate(form) > x.scoreCandidate(stmt));
ok("a form that merely mentions a receipt is still reachable",
   x.scoreCandidate(withFee) > 0, "scored " + x.scoreCandidate(withFee));
ok("but it ranks below a form that does not",
   x.scoreCandidate(withFee) < x.scoreCandidate(form));

const ranked = x.rankCandidates([receipts, supp, form, stmt]);
ok("the ranker puts the form first and drops the receipts",
   ranked.length > 0 && ranked[0].name === form.name &&
   !ranked.some(f => f.name === receipts.name),
   ranked.map(f => f.name).join(" | "));

// ── Stubs for Dropbox and the database ─────────────────────────────────
const calls = [];
const FOLDER = "/Clients/Ma, Jianli";
const entries = [
  { ".tag": "file",   name: form.name,     path_display: FOLDER + "/" + form.name,     server_modified: "2026-02-01T00:00:00Z" },
  { ".tag": "file",   name: receipts.name, path_display: FOLDER + "/" + receipts.name, server_modified: "2026-03-01T00:00:00Z" },
  { ".tag": "file",   name: "scan0001.jpg", path_display: FOLDER + "/scan0001.jpg",    server_modified: "2026-01-01T00:00:00Z" },
  { ".tag": "folder", name: "Evidence",     path_display: FOLDER + "/Evidence" },
];

function preload(rel, exports) {
  const file = require.resolve(path.join(ROOT, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}
preload("dropbox-integration.js", {
  resolveClientFolder: async () => { calls.push("resolveClientFolder"); return FOLDER; },
  listFolderDeep: async () => { calls.push("listFolderDeep"); return entries; },
  downloadFile: async () => { calls.push("downloadFile"); return Buffer.alloc(0); },
});
preload("db.js", {
  query: async (sql) => {
    calls.push("db:" + String(sql).trim().split(/\s+/)[0].toUpperCase());
    return { rows: [] };
  },
});

async function main() {
  // ── 3 & 4. inspectFolder is free and read-only ───────────────────────
  console.log("inspectFolder");

  const sweep = require("../i589-sweep");
  const report = await sweep.inspectFolder({ client_key: "ma-jianli", client_name: "Ma, Jianli" });

  ok("it listed the folder",
     report.folder === FOLDER && report.files.length === 3,
     JSON.stringify({ folder: report.folder, files: report.files.length, error: report.error }));
  ok("it downloaded nothing", !calls.includes("downloadFile"), calls.join(", "));
  ok("it wrote nothing",
     !calls.some(c => /^db:(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)$/.test(c)),
     calls.join(", "));
  ok("it lists non-PDFs too, so a form saved as an image is visible",
     report.files.some(f => /\.jpg$/i.test(f.name)));
  ok("it scores every file it lists",
     report.files.length > 0 && report.files.every(f => typeof f.score === "number"));
  ok("the receipts file is listed but is not one a scan would try",
     report.files.some(f => f.name === receipts.name) &&
     !report.candidates.some(p => p.indexOf(receipts.name) >= 0),
     JSON.stringify(report.candidates));
  ok("the form is one a scan would try",
     report.candidates.some(p => p.indexOf(form.name) >= 0));
  ok("the highest-scoring file is listed first",
     report.files.length > 1 && report.files[0].score >= report.files[1].score);

  // A folder that cannot be resolved must say so rather than throwing.
  preload("dropbox-integration.js", { resolveClientFolder: async () => null });
  delete require.cache[require.resolve(path.join(ROOT, "i589-sweep.js"))];
  const sweep2 = require("../i589-sweep");
  const none = await sweep2.inspectFolder({ client_key: "nobody", client_name: "Nobody" });
  ok("an unresolvable folder is reported, not thrown",
     none.error && none.files.length === 0, JSON.stringify(none));

  // ── The source itself: no model, no download, in the body ────────────
  const sweepSrc = fs.readFileSync(path.join(ROOT, "i589-sweep.js"), "utf8");
  const body = sweepSrc.slice(sweepSrc.indexOf("async function inspectFolder"),
                              sweepSrc.indexOf("async function inspectStatus"));
  ok("inspectFolder's body names no model and no download",
     body.length > 200 && !/downloadFile|readItem8|i589-vision/.test(body),
     "body is " + body.length + " chars");

  // ── 5. The page carries no inline script ─────────────────────────────
  console.log("the page");

  const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const at = serverSrc.indexOf('app.get("/admin/clients/i589/files"');
  ok("the route exists", at > 0);
  if (at > 0) {
    // Slice to the next top-level route rather than a character count, so
    // this keeps testing the whole handler as it grows.
    const nextRoute = serverSrc.indexOf("\napp.", at + 10);
    const route = serverSrc.slice(at, nextRoute > 0 ? nextRoute : serverSrc.length);
    ok("it sends no inline <script>", !/<script/i.test(route));
    ok("it escapes what it prints",
       /replace\(\/&\/g/.test(route) && /replace\(\/</.test(route));
    const gate = serverSrc.indexOf('app.use("/admin/clients/i589", auth.requireRole');
    ok("it sits behind the I-589 role gate",
       gate > 0 && gate < at,
       "the app.use guard must be registered before this route");
  }

  const pageSrc = fs.readFileSync(path.join(ROOT, "i589-page.js"), "utf8");
  ok("every row links to its folder listing",
     /i589\/files\?key=\$\{encodeURIComponent/.test(pageSrc));
  ok("the no-I-589 count is itself a way in",
     /i589\/files\?status=no_form/.test(pageSrc));

  const note = stub.note();
  if (note) console.log(note);
  console.log(failures ? "\n" + failures + " failed" : "\nall good");
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.log("  FAIL the check itself threw  → " + err.message);
  process.exit(1);
});
