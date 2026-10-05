// check-ci-file.js — the build file must be one GitHub can read.
//
// GitHub reads .github/workflows/ci.yml before it runs anything. If that
// file does not parse, no check runs, the build is marked failed in zero
// seconds, and nothing deploys, while every check still passes on the
// machine that pushed. It has happened three times, each time the same way:
// a step named with a colon in it and no quotes.
//
//     - name: Court mail: the docket mailbox        <- GitHub rejects the file
//     - name: "Court mail: the docket mailbox"      <- fine
//
// This cannot run on GitHub when the file is broken, so it is in the chain
// `npm test` runs locally, where it is the first thing to fail.
// No YAML library needed: it looks for the patterns that break the file.

const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", ".github", "workflows", "ci.yml");
const lines = fs.readFileSync(file, "utf8").split("\n");
const problems = [];

lines.forEach((line, i) => {
  const n = i + 1;
  if (/\t/.test(line.match(/^\s*/)[0])) problems.push(`line ${n}: a tab in the indentation`);
  // "key: value" where the unquoted value itself contains ": " or ends in ":"
  const m = line.match(/^(\s*)(- )?([A-Za-z_][\w-]*): (.*)$/);
  if (!m) return;
  const value = m[4].trim();
  if (!value || /^["'|>[{&*!#]/.test(value)) return;          // quoted, block, flow, or a comment
  const bare = value.replace(/\s+#.*$/, "");                   // drop a trailing comment
  if (/: /.test(bare) || /:$/.test(bare)) {
    problems.push(`line ${n}: put quotes around the value, it contains a colon\n        ${line.trim()}`);
  }
});

if (problems.length) {
  console.log("\nThe build file will be rejected by GitHub:\n");
  for (const p of problems) console.log("  FAIL  " + p);
  console.log(`\n${problems.length} problem(s) in .github/workflows/ci.yml. Nothing would deploy.\n`);
  process.exit(1);
}
console.log("  ok  the build file has no unquoted colon in a step name or value");
