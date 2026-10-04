/**
 * check-task-attachments.js
 *
 * A consultant can attach documents to a task they send the firm. That is
 * outsiders uploading files to a page staff open while signed in, so the
 * rules that keep it safe are pinned here:
 *
 *   · only document and image types — nothing a browser would run;
 *   · the file is always handed over as a download, never shown inline;
 *   · a consultant reaches only their own uploads on their own tasks;
 *   · the bytes are never part of a list.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail !== undefined ? "  → " + JSON.stringify(detail) : "")); }
}

const REPO = path.join(__dirname, "..");
// The module only needs db for queries; none are made here.
require.cache[require.resolve("../db")] = { exports: { query: async () => ({ rows: [] }) }, loaded: true, id: require.resolve("../db") };
const ta = require("../task-attachments");
const src = fs.readFileSync(path.join(REPO, "task-attachments.js"), "utf8");

console.log("\n── What may be attached ─────────────────────────");
for (const good of ["passport.pdf", "Notice of Hearing.PDF", "scan.jpeg", "photo.HEIC", "retainer.docx", "ledger.xlsx", "notes.txt"]) {
  ok(`${good} is accepted`, !!ta.cleanName(good), ta.cleanName(good));
}
for (const bad of ["page.html", "page.htm", "script.js", "run.exe", "archive.zip", "image.svg", "macro.docm", "shell.sh", "noextension", "", null, "trick.pdf.html", "x.php"]) {
  ok(`${JSON.stringify(bad)} is refused`, ta.cleanName(bad) === null, ta.cleanName(bad));
}
ok("nothing that runs in a browser is on the list", !ta.ALLOWED.some(e => ["html", "htm", "svg", "js", "xml", "xhtml", "mht", "php", "exe", "zip"].includes(e)), ta.ALLOWED);
ok("a path in the name is dropped, the name kept", ta.cleanName("C:\\Users\\x\\passport.pdf").name === "passport.pdf" && ta.cleanName("../../etc/passwd.pdf").name === "passwd.pdf");
ok("control characters and angle brackets are stripped", ta.cleanName("a<b>\u0000c.pdf").name === "abc.pdf", ta.cleanName("a<b>\u0000c.pdf"));
ok("a Chinese file name that arrived as Latin-1 bytes is read back correctly",
  ta.cleanName(Buffer.from("护照.pdf", "utf8").toString("latin1")).name === "护照.pdf",
  ta.cleanName(Buffer.from("护照.pdf", "utf8").toString("latin1")));
ok("…and one that arrived correctly is left alone", ta.cleanName("护照.pdf").name === "护照.pdf");
ok("15 MB a file, 12 files a task", ta.MAX_BYTES === 15 * 1024 * 1024 && ta.MAX_FILES === 12);

console.log("\n── How a file is handed back ────────────────────");
{
  const headers = {}; let body = null;
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, end: (b) => { body = b; } };
  ta.sendDownload(res, { filename: '护照 "scan".pdf', mime: "application/pdf", bytes: 3, content: Buffer.from("abc") });
  ok("always as a download, never inline", /^attachment;/.test(headers["content-disposition"]), headers["content-disposition"]);
  ok("the browser is told not to guess the type", headers["x-content-type-options"] === "nosniff");
  ok("not cached", /no-store/.test(headers["cache-control"]));
  ok("a quote in the name cannot end the header early", !/filename="[^"]*"[^;]*"/.test(headers["content-disposition"].split(";")[1] || ""), headers["content-disposition"]);
  ok("the real name survives for browsers that read filename*", headers["content-disposition"].includes("filename*=UTF-8''" + encodeURIComponent('护照 "scan".pdf')));
  ok("the bytes are the file's", body && body.toString() === "abc");
}

console.log("\n── Who reaches what ─────────────────────────────");
const route = (re) => (src.match(re) || [""])[0];
const consList = route(/app\.get\("\/api\/consultant\/tasks\/:id\/attachments"[\s\S]*?\n  \}\);/);
const consPost = route(/app\.post\("\/api\/consultant\/tasks\/:id\/attachments"[\s\S]*?\n  \}\);/);
const consGet = route(/app\.get\("\/api\/consultant\/attachments\/:aid"[\s\S]*?\n  \}\);/);
const staffGet = route(/app\.get\("\/api\/staff\/task-attachments\/:aid"[\s\S]*?\n  \}\);/);
const staffList = route(/app\.get\("\/api\/staff\/tasks\/:id\/attachments"[\s\S]*?\n  \}\);/);
ok("the consultant routes are consultant-only", [consList, consPost, consGet].every(r => /requireBearer, requireConsultantRole/.test(r)));
ok("the firm routes are firm-only", [staffGet, staffList].every(r => /requireBearer, requireFirmUser/.test(r)));
ok("a consultant lists and adds only on a task they sent", /ownTask\(req\)/.test(consList) && /ownTask\(req\)/.test(consPost) &&
  /String\(t\.submitted_by_user_id\) === String\(req\.user\.uid\)/.test(src));
ok("a consultant sees only the files they added", /listMine\(t\.id, req\.user\.uid\)/.test(consList));
ok("a consultant opens only their own upload, on their own task",
  /String\(a\.uploaded_by\) !== String\(req\.user\.uid\)/.test(consGet) && /String\(t\.submitted_by_user_id\) !== String\(req\.user\.uid\)/.test(consGet));
ok("someone else's file answers Not found, not Forbidden (no hint that it exists)", !/403/.test(consGet) && /404/.test(consGet));
ok("a closed task takes no more files", /CLOSED\.has\(t\.status\)/.test(consPost) && /409/.test(consPost));
ok("lists never select the bytes", /const LIST_COLS = `id, task_id, filename, mime, bytes, uploaded_by, uploaded_by_name, uploaded_by_role, created_at`/.test(src) &&
  (src.match(/SELECT \$\{LIST_COLS\}/g) || []).length >= 3 && (src.match(/SELECT \*/g) || []).length === 1);
ok("what goes back in JSON has no bytes either", /const publicRow = \(a\) => \(\{ id: a\.id, filename: a\.filename, bytes: a\.bytes, created_at: a\.created_at, uploaded_by_name:/.test(src));
ok("the upload is limited before it is read into memory", /limits: \{ fileSize: MAX_BYTES, files: 1 \}/.test(src));

const appApi = fs.readFileSync(path.join(REPO, "app-api.js"), "utf8");
const pending = (appApi.match(/app\.get\("\/api\/staff\/admin\/tasks\/pending"[\s\S]*?\n  \}\);/) || [""])[0];
ok("whoever approves a task sees its documents", /listForTasks\(rows\.map\(r => r\.id\)\)/.test(pending) && /requireApprover/.test(pending));
ok("the routes are mounted", /require\("\.\/task-attachments"\)\.attach\(app, \{ requireBearer, requireConsultantRole, requireFirmUser \}\)/.test(appApi));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
