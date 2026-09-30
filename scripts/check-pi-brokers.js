/**
 * check-pi-brokers.js
 *
 * JJ, 2026-09-29: "under personal injury section, brokers tab is broken,
 * 'Error: column final_settlement does not exist'".
 *
 * It was not a regression. pi_cases has never had that column — the page has
 * been failing since the day it was written, and nothing noticed because no
 * check ever rendered it against a real schema.
 *
 * The settlement lives on pi_settlements, flagged is_final. So the assertions
 * here are: the dead column is gone from the whole repo, and the page reads
 * the table that actually holds the money.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const REPO = path.join(__dirname, "..");
const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const pi = fs.readFileSync(path.join(REPO, "personal-injury.js"), "utf8");

console.log("\n── The column that never existed ───────────────");
{
  // Precisely: nothing may SELECT final_settlement as if pi_cases had it.
  // A blunt search for the word is wrong and I wrote it that way first — the
  // name is also a civil-litigation task key, and personal-injury.js legitimately
  // ALIASES a subquery to it. What is forbidden is treating it as a column.
  const files = fs.readdirSync(REPO).filter(f => f.endsWith(".js"));
  const asColumn = /(?:SUM|AVG|MIN|MAX|COUNT)\s*\(\s*(?:[a-z_]+\.)?final_settlement\s*\)|SELECT[^;]{0,200}?,\s*(?:[a-z_]+\.)?final_settlement\s*[,\s]/i;
  const offenders = files.filter(f => {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    // Strip the alias form, which is the correct usage.
    const stripped = src.replace(/\)\s*as final_settlement/gi, ") as _aliased");
    return asColumn.test(stripped);
  });
  ok("nothing treats final_settlement as a column on pi_cases",
    offenders.length === 0, offenders.join(", "));
  ok("personal-injury.js still provides it as an alias, which is the correct form",
    /\(SELECT check_amount FROM pi_settlements[\s\S]{0,80}\) as final_settlement/.test(pi));

  const ddl = (pi.match(/CREATE TABLE IF NOT EXISTS pi_cases[\s\S]*?\)\s*`/) || [""])[0];
  ok("…and the schema confirms why: pi_cases does not define it",
    !/final_settlement/.test(ddl));
  ok("the settlement lives on pi_settlements, flagged is_final",
    /CREATE TABLE IF NOT EXISTS pi_settlements[\s\S]*?is_final\s+BOOLEAN/.test(pi));
}

console.log("\n── The brokers page reads the right table ──────");
{
  const i = srv.indexOf('app.get("/admin/pi/brokers"');
  ok("the brokers route exists", i > -1);
  const body = i > -1 ? srv.slice(i, srv.indexOf("app.get(", i + 10)) : "";
  ok("it joins pi_settlements", /FROM pi_settlements/.test(body));
  ok("…only the accepted final settlement", /ps\.is_final = TRUE/.test(body));
  ok("…using check_amount, the SAME definition getCases() uses, so the two "
   + "pages cannot report different settlement totals",
    /ps\.check_amount AS amount/.test(body));
  ok("…and ONE row per case, so a corrected settlement is not double counted",
    /ORDER BY COALESCE\(ps\.check_received_date[\s\S]{0,80}LIMIT 1/.test(body));
  ok("it still groups by the referral source", /GROUP BY COALESCE\(NULLIF\(c\.referral_source/.test(body));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL PI BROKER CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
