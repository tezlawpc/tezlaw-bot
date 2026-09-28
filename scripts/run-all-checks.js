/**
 * run-all-checks.js — run every check, then report.
 *
 * `npm test` used to be forty scripts joined by &&, which stops at the first
 * failure. On 2026-09-28 that hid seventeen checks: check-zara-core had been
 * failing since commit 475326f, so everything after it — e-sign, court mail,
 * consultant clients, client search, the lot — had not run for days, and the
 * suite still looked like a suite. A gate that silently shrinks is worse than
 * no gate, because it keeps the confidence while losing the coverage.
 *
 * So: run all of them, keep going, and print one summary at the end naming
 * every failure. Exit non-zero if any failed, so CI still blocks.
 *
 * Each check runs in its own process. That is deliberate — several of them
 * stub globals and monkey-patch Module._load, and sharing a process would let
 * one check's fakes leak into the next one's results.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const only = process.argv.slice(2).filter(a => !a.startsWith("-"));
const quiet = process.argv.includes("--quiet");

// Order comes from package.json's own list, so the two cannot drift.
// "test" now runs THIS file, so the ordered list lives in "test:chain" —
// which is also still runnable on its own when you want the old
// stop-at-the-first-failure behaviour for bisecting.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const chain = pkg.scripts["test:chain"] || pkg.scripts.test || "";
const listed = (chain.match(/scripts\/check-[\w-]+\.js/g) || []);
if (!listed.length) {
  console.error('No checks listed. Expected package.json "test:chain" to name them.');
  process.exit(1);
}
const onDisk = fs.readdirSync(path.join(ROOT, "scripts"))
  .filter(f => /^check-.+\.js$/.test(f)).map(f => "scripts/" + f);

// Anything on disk but not in the list would never run. Name it rather than
// quietly skipping it — that is the same failure mode in miniature.
const unlisted = onDisk.filter(f => !listed.includes(f));

const scripts = (only.length
  ? onDisk.filter(f => only.some(o => f.includes(o)))
  : listed);

if (!scripts.length) {
  console.error(only.length ? `No check matches: ${only.join(", ")}` : "No checks found.");
  process.exit(1);
}

// Everything package.json says should be installed.
const DEPS = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  "jsdom",
]);

const results = [];
const started = Date.now();

for (const rel of scripts) {
  const name = path.basename(rel, ".js").replace(/^check-/, "");
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [rel], { cwd: ROOT, encoding: "utf8", timeout: 180000 });
  const ms = Date.now() - t0;
  const out = (r.stdout || "") + (r.stderr || "");
  const ok = r.status === 0;

  // A check that died because a dependency is not installed has not failed —
  // it has not run. JJ's M5 is the deploy clone and carries no node_modules,
  // so without this distinction a run there is 26 red lines that all mean
  // "npm install", and a real failure hides in the middle of them.
  const missing = ok ? null : (out.match(/Cannot find module '([^']+)'/) || [])[1];
  const skipped = !!missing && (DEPS.has(missing) || DEPS.has(missing.split("/")[0]));

  results.push({ name, rel, ok, skipped, missing, ms, out, signal: r.signal, status: r.status });

  if (!quiet && !ok && !skipped) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  const tag = ok ? "  ok  " : skipped ? "  skip" : "  FAIL";
  const note = ok ? "" : skipped ? `  (needs ${missing} — run npm install)` : `  (exit ${r.signal || r.status})`;
  console.log(`${tag}  ${name}${note}  ${ms}ms`);
}

const failed = results.filter(r => !r.ok && !r.skipped);
const skipped = results.filter(r => r.skipped);
const passed = results.filter(r => r.ok);
const total = ((Date.now() - started) / 1000).toFixed(1);

console.log("\n" + "=".repeat(60));
console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} could not run — ${results.length} checks in ${total}s`);

if (skipped.length) {
  const mods = [...new Set(skipped.map(s => s.missing))].sort();
  console.log(`\n${skipped.length} check(s) never ran because dependencies are not installed here (${mods.join(", ")}).`);
  console.log("  This machine cannot verify them. Run the suite where node_modules exists:");
  console.log("    npm install     (or run it on the other Mac)");
}

if (unlisted.length) {
  console.log(`\n${unlisted.length} check(s) exist but are NOT in package.json's test list, so they never run:`);
  for (const f of unlisted) console.log(`  · ${f}`);
}

if (failed.length) {
  console.log(`\n${failed.length} FAILED:`);
  for (const f of failed) {
    // The last line that looks like a failure, so the summary says what broke
    // rather than making you scroll back through the passing output.
    const why = (f.out.split("\n").reverse().find(l => /FAIL|✗|Error:|Cannot find module|FAILED/.test(l)) || "").trim();
    console.log(`  · ${f.name}${why ? "\n      " + why.slice(0, 160) : ""}`);
    console.log(`      rerun: node ${f.rel}`);
  }
}
console.log("=".repeat(60) + "\n");
process.exit(failed.length ? 1 : 0);
