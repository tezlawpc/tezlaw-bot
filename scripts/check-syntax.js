/**
 * Parses every JavaScript file in the repo (excluding node_modules) and fails
 * on the first syntax error.
 *
 * This exists because the server is a single long-running process: a syntax
 * error in any required module takes the whole admin panel down at boot, and
 * the failure only shows up in the Render log after the deploy has already
 * replaced the running instance.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SKIP = new Set(["node_modules", ".git", "dist", "public/vendor"]);

// ── Files in the wrong folder ────────────────────────────────
// GitHub's web "Upload files" drops every file at the top of the repo,
// whatever folder it came from. Five times now that has left the newest
// test scripts and page scripts at the root while CI ran stale copies —
// and the failure it produced pointed at some unrelated test. This names
// the real problem first, with the exact commands that fix it.
{
  const CLIENT_BUNDLES = ["civil-admin.js", "zara-admin.js", "zara-chat.js", "civil-intake.js", "civil-docs.js", "esign-admin.js", "esign-sign.js", "court-mail-page.js", "transcripts-page.js"];
  const strays = fs.readdirSync(ROOT).filter(f =>
    (/^check-.+\.js$/.test(f)) || CLIENT_BUNDLES.includes(f));
  if (strays.length) {
    console.error("\nFILES IN THE WRONG FOLDER — probably uploaded through the GitHub website,");
    console.error("which puts every file at the top of the repo. Fix, from the repo folder:\n");
    for (const f of strays) {
      const home = /^check-/.test(f) ? "scripts" : "public";
      console.error(`  git mv -f ${f} ${home}/${f}`);
    }
    console.error("\nthen: npm test && git commit -am \"Move files into their folders\" && git push\n");
    process.exit(1);
  }
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const files = walk(ROOT, []);
const failures = [];

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  try {
    // Wrapped the way Node wraps a CommonJS module, so a top-level `return`
    // or an `await` inside an async IIFE parses the same way it will at runtime.
    new vm.Script("(function(exports,require,module,__filename,__dirname){" + src + "\n})", {
      filename: rel,
    });
  } catch (err) {
    failures.push(rel + " — " + err.message);
  }
}

console.log("Parsed " + files.length + " JavaScript file(s).");
if (failures.length) {
  console.error("\nSYNTAX ERRORS:");
  failures.forEach(f => console.error("  ✗ " + f));
  process.exit(1);
}
console.log("No syntax errors.");
