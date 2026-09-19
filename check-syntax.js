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
