/**
 * check-sql-params.js
 *
 * A query parameter used two ways in one statement.
 *
 * The merge button on the duplicate-hearings page never worked. Postgres
 * refused the whole statement on every click with "inconsistent types
 * deduced for parameter $1":
 *
 *     duplicate_of   = $1,
 *     dismiss_reason = COALESCE(dismiss_reason, 'merged into notice #' || $1)
 *
 * Postgres deduces ONE type per parameter from all of its uses. Assigning
 * $1 to an integer column says integer; concatenating it with || says text.
 * Both cannot be true, so nothing runs. A cast at each use fixes it.
 *
 * Why this is its own file: every check in this repo that touches the
 * database stubs db.query, so none of them can catch a typing error — the
 * stub accepts any statement at all. This reads the SQL as text instead.
 *
 * What it does NOT flag, deliberately. A parameter that is text in every
 * one of its uses is fine and needs no cast:
 *
 *     LIKE '%' || $3 || '%'          ($3 is text throughout)
 *     ($1 || ' days')::interval      (the cast is on the result, not needed on $1)
 *     note = COALESCE(note,'') || $3 (the column takes the concatenation, not $3)
 *
 * Those were all in the repo when this was written and all of them are
 * correct. The defect is specifically a parameter handed straight to a
 * column in one clause and concatenated in another, which is a conflict
 * whatever the column's type happens to be.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failures = 0;

function check(name, fn) {
  const bad = fn();
  if (bad && bad.length) {
    failures++;
    console.log(`  FAIL  ${name}`);
    for (const b of bad) console.log(`        ${b}`);
  } else {
    passed++;
    console.log(`  ok  ${name}`);
  }
}

function sourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" ||
        entry.name === "tmp" || entry.name === "public") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * The backtick strings that look like SQL. One of these is one statement,
 * which is the scope Postgres deduces a parameter's type over.
 */
function sqlLiterals(src) {
  const out = [];
  const re = /`([^`\\]|\\.)*`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const body = m[0].slice(1, -1);
    if (!/\$\d/.test(body)) continue;
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) continue;
    out.push({ body, index: m.index });
  }
  return out;
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

console.log("\nQuery parameters carry their type\n");

check("no parameter is both assigned to a column and concatenated", () => {
  const offenders = [];

  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, "utf8");
    for (const stmt of sqlLiterals(src)) {
      // Handed straight to a column: `col = $1`, with no cast on it.
      const assigned = new Set(
        [...stmt.body.matchAll(/\b\w+\s*=\s*\$(\d+)(?!\s*::)/g)].map((x) => x[1]));
      if (!assigned.size) continue;

      // Pulled into a string: `$1 ||` or `|| $1`, with no cast on it.
      const concatenated = new Set([
        ...[...stmt.body.matchAll(/\$(\d+)(?!\s*::)\s*\|\|/g)].map((x) => x[1]),
        ...[...stmt.body.matchAll(/\|\|\s*\$(\d+)(?!\s*::)/g)].map((x) => x[1]),
      ]);

      for (const n of assigned) {
        if (!concatenated.has(n)) continue;
        offenders.push(
          `${path.relative(ROOT, file)}:${lineOf(src, stmt.index)}  ` +
          `$${n} is assigned to a column and also concatenated with || in the same statement.\n` +
          `        Postgres will refuse it: "inconsistent types deduced for parameter $${n}". ` +
          `Cast both uses.`);
      }
    }
  }
  return offenders;
});

check("the statement that raised this in production is fixed", () => {
  const src = fs.readFileSync(path.join(ROOT, "hearing-notices.js"), "utf8");
  const bad = [];
  const i = src.indexOf("const collapsed = await db.query(");
  if (i === -1) return ["hearing-notices.js: the merge statement has moved or gone"];
  const stmt = src.slice(i, src.indexOf("[keepId, ids]);", i));
  if (!/duplicate_of\s+= \$1::int/.test(stmt)) {
    bad.push("hearing-notices.js: duplicate_of = $1 has lost its ::int cast");
  }
  if (!/'merged into notice #' \|\| \$1::text/.test(stmt)) {
    bad.push("hearing-notices.js: the dismiss_reason concatenation has lost its ::text cast");
  }
  if (!/inconsistent types deduced/.test(src)) {
    bad.push("hearing-notices.js: the reason the casts are there is not written next to them");
  }
  return bad;
});

check("the rule itself still catches the original bug", () => {
  // A regression test for the check, not for the repo: if someone loosens
  // the pattern, this says so rather than the check quietly passing on
  // everything forever.
  const original = "`UPDATE t SET duplicate_of = $1, reason = COALESCE(reason, 'into #' || $1) WHERE id = ANY($2::int[])`";
  const stmt = sqlLiterals(original)[0];
  if (!stmt) return ["the SQL-literal scanner no longer recognises an UPDATE"];
  const assigned = new Set([...stmt.body.matchAll(/\b\w+\s*=\s*\$(\d+)(?!\s*::)/g)].map((x) => x[1]));
  const concatenated = new Set([
    ...[...stmt.body.matchAll(/\$(\d+)(?!\s*::)\s*\|\|/g)].map((x) => x[1]),
    ...[...stmt.body.matchAll(/\|\|\s*\$(\d+)(?!\s*::)/g)].map((x) => x[1]),
  ]);
  return assigned.has("1") && concatenated.has("1")
    ? []
    : ["the pattern no longer catches the statement it was written for"];
});

if (failures) {
  console.log(`\n${failures} FAILED\n`);
  process.exit(1);
}
console.log(`\n${passed} checks passed\n`);
