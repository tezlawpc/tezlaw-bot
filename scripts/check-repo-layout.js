/**
 * check-repo-layout.js
 *
 * Uploading a file through GitHub's web UI drops it wherever the page happens
 * to be, so a file meant for scripts/ lands at the repo root. That has now
 * happened three times — check-eoir-parse.js, check-eoir-digest.js and
 * check-social-posts.js — and each time it broke quietly: package.json points
 * at scripts/<name>.js, the file is at <name>.js, and `npm test` dies with
 * MODULE_NOT_FOUND on a repo that looks fine in the file list.
 *
 * A misplaced check script is also a dead check script: it does
 * require("../court-mail"), which from the root resolves outside the repo
 * entirely. So the test it contains silently stops protecting anything.
 *
 * This runs first in the chain and fails loudly instead.
 */
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
let failures = 0;
function fail(msg) { failures++; console.log("  FAIL " + msg); }
function ok(msg) { console.log("  ok   " + msg); }

console.log("\nRepo layout\n");

// ── 1. Every script package.json runs must exist where it says ──
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const referenced = new Set();
for (const cmd of Object.values(pkg.scripts || {})) {
  for (const m of String(cmd).matchAll(/node\s+([\w./-]+\.js)/g)) referenced.add(m[1]);
}
const missing = [...referenced].filter(p => !fs.existsSync(path.join(REPO, p)));
if (missing.length) {
  for (const p of missing) {
    const base = path.basename(p);
    const stray = fs.existsSync(path.join(REPO, base)) ? `  (it is at ./${base} — move it to ${p})` : "";
    fail(`package.json runs ${p}, which does not exist${stray}`);
  }
} else {
  ok(`all ${referenced.size} scripts package.json runs exist`);
}

// ── 2. No check script stranded at the repo root ──────────────
// They all require("../something"); from the root that points outside the repo.
const atRoot = fs.readdirSync(REPO)
  .filter(f => /^check-.*\.js$/.test(f) && fs.statSync(path.join(REPO, f)).isFile());
if (atRoot.length) {
  for (const f of atRoot) {
    fail(`./${f} belongs in scripts/ — at the root its require("../…") resolves outside the repo`);
  }
} else {
  ok("no check script stranded at the repo root");
}

// ── 3. Nothing duplicated between root and scripts/ ───────────
// Two copies means one of them is stale, and it is never obvious which.
const scriptsDir = path.join(REPO, "scripts");
if (fs.existsSync(scriptsDir)) {
  const inScripts = new Set(fs.readdirSync(scriptsDir).filter(f => f.endsWith(".js")));
  const dupes = fs.readdirSync(REPO).filter(f => f.endsWith(".js") && inScripts.has(f));
  if (dupes.length) for (const f of dupes) fail(`${f} exists at BOTH ./ and scripts/ — one is stale`);
  else ok("no file exists at both ./ and scripts/");
}

// ── 4. Every check script in scripts/ is actually run ─────────
// A test nobody runs is worse than no test: it reads as coverage.
if (fs.existsSync(scriptsDir)) {
  const orphans = fs.readdirSync(scriptsDir)
    .filter(f => /^check-.*\.js$/.test(f))
    .filter(f => !referenced.has(`scripts/${f}`));
  if (orphans.length) {
    for (const f of orphans) fail(`scripts/${f} is never run by package.json`);
  } else {
    ok("every check script in scripts/ is wired into package.json");
  }
}

console.log(failures ? `\n${failures} LAYOUT PROBLEM(S)\n` : "\nrepo layout ok\n");
process.exit(failures ? 1 : 0);
