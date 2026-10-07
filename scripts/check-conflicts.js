/**
 * check-conflicts.js
 *
 * "need to add button for conflict of interest for cases now that we are
 *  accepting many cases."
 *
 * The check that existed searched `clients` and `intakes`. It never read
 * civil_cases.opposing_party, federal_matters.opposing_party or the adverse
 * insured on a PI case, so it could report "cleared" on a name the firm had
 * been directly opposite. For a conflict check a false clear is the whole
 * danger: rule 1.7 and 1.9 turn on exactly the names it was not reading.
 *
 * What these checks defend:
 *   1. the sweep includes the other side, not just our own clients;
 *   2. a source that cannot be read is reported, and never reads as a clear;
 *   3. names match the way the firm's names are actually written — reversed
 *      Chinese order, initials, entity abbreviations — without flooding on
 *      a shared surname;
 *   4. every check is filed, including the ones that find nothing;
 *   5. the page says what it searched, and a weak hit is never dressed up
 *      as a finding.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const conflicts = require(path.join(ROOT, "conflicts.js"));
const page = require(path.join(ROOT, "conflicts-page.js"));
const server = read("server.js");
const nav = read("hearing-notes.js");
const civilUi = read("civil-litigation-ui.js");

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

console.log("\nA conflict check that looks at the other side\n");

// ── What it searches ──────────────────────────────────────

check("the sweep reads the other side, not only our clients", () => {
  const sides = new Set(conflicts.SOURCES.map((s) => s.side));
  assert.ok(sides.has("adverse"), "no source is marked adverse: this is the old bug");
  assert.ok(sides.has("opposing counsel"));
  assert.ok(sides.has("client"));
  const sql = conflicts.SOURCES.map((s) => s.sql).join("\n");
  for (const col of ["civil_cases", "opposing_party", "opposing_counsel",
                     "pi_insurance", "federal_matters", "intakes", "clients"]) {
    assert.ok(sql.includes(col), `${col} is not searched`);
  }
});

check("the adverse insured is the one the PI query asks for", () => {
  const pi = conflicts.SOURCES.find((s) => /PI adverse/.test(s.name));
  assert.ok(pi, "the PI adverse source is missing");
  assert.ok(/role = 'adverse'/.test(pi.sql),
    "without this it would sweep our own client's carriers in as opponents");
  assert.strictEqual(pi.side, "adverse");
});

check("opposing counsel is read whether it was stored as objects or strings", () => {
  const oc = conflicts.SOURCES.find((s) => s.side === "opposing counsel");
  assert.ok(/jsonb_typeof/.test(oc.sql), "a non-array value would throw and cost the source");
  assert.ok(/e->>'name'/.test(oc.sql) && /e#>>'\{\}'/.test(oc.sql));
});

// ── What it says when it could not look ──────────────────

check("a source that cannot be read is never a clear", () => {
  const src = code(read("conflicts.js"));
  assert.ok(/unavailable\.length \? "incomplete"/.test(src),
    "with a source down the result must be incomplete, not cleared");
  assert.ok(/unavailable\.push/.test(src));
});

check("but a practice area that was never switched on is simply empty", () => {
  const src = read("conflicts.js");
  assert.ok(/42P01/.test(src),
    "a table that does not exist holds no parties; that is not a failure to report");
});

check("the page tells the reader it could not look everywhere", () => {
  const html = page.renderPage({
    user: {}, result: {
      searched: ["Wei Chen"], hits: [], disposition: "incomplete",
      unavailable: ["PI adverse insured and carriers"],
      sources_searched: 8, sources_total: 9, parties_compared: 10,
    },
  });
  assert.ok(/could not be completed/.test(html));
  assert.ok(/is not a clear/.test(html), "the reader has to be told not to rely on it");
  assert.ok(!/No match in any of the firm/.test(html), "it must not also claim a clear");
  assert.ok(/8 of 9 sources/.test(html), "and must say how much of the firm it saw");
});

// ── How names are compared ───────────────────────────────

check("a Chinese name written in either order is the same person", () => {
  assert.strictEqual(conflicts.compareNames("Zhang Dong Sheng", "Dong Sheng Zhang"), "exact");
  assert.strictEqual(conflicts.compareNames("Luna Huang", "Huang, Luna"), "exact");
  assert.strictEqual(conflicts.compareNames("张东升", "张东升"), "exact");
});

check("an entity is the same entity through its abbreviations", () => {
  assert.strictEqual(conflicts.compareNames("Tez Law P.C.", "TEZ LAW"), "exact");
  assert.strictEqual(conflicts.compareNames("Acme L.L.C.", "Acme LLC"), "exact");
  assert.strictEqual(conflicts.compareNames("Smith & Jones LLP", "Smith and Jones"), "exact");
});

check("a fuller version of a name is a strong match, not a miss", () => {
  assert.strictEqual(conflicts.compareNames("Wei Ming Chen", "Wei Chen"), "strong");
  assert.strictEqual(conflicts.compareNames("张东升", "张东"), "strong");
});

check("an initial is a near-miss worth showing", () => {
  assert.strictEqual(conflicts.compareNames("Wei Chen", "W. Chen"), "weak");
  assert.strictEqual(conflicts.compareNames("Chen", "Wei Chen"), "weak");
});

check("a shared surname with a different given name is NOT a match", () => {
  // Chen, Zhang, Wang and Li would each bury the real hits.
  assert.strictEqual(conflicts.compareNames("Wei Chen", "Wendy Chen"), null);
  assert.strictEqual(conflicts.compareNames("John Smith", "Jane Smith"), null);
  assert.strictEqual(conflicts.compareNames("张东升", "李东升"), null);
});

check("and a substring of a name is not a match either", () => {
  // The old check ran ILIKE '%chen%', which matched Chenoweth.
  assert.strictEqual(conflicts.compareNames("Wei Chen", "Chenoweth Holdings"), null);
  assert.strictEqual(conflicts.compareNames("Wei Chen", "Wei Chang"), null);
});

check("an empty or missing name never matches anything", () => {
  for (const bad of ["", "   ", null, undefined]) {
    assert.strictEqual(conflicts.compareNames(bad, "Wei Chen"), null);
    assert.strictEqual(conflicts.compareNames("Wei Chen", bad), null);
  }
});

// ── The record ───────────────────────────────────────────

check("a check is filed whatever it found", () => {
  const src = code(read("conflicts.js"));
  const i = src.indexOf("async function checkAndRecord");
  const body = src.slice(i, src.indexOf("async function checksFor"));
  assert.ok(/INSERT INTO conflict_checks/.test(body));
  assert.ok(/run_by/.test(body) && /searched_names/.test(body) && /sources_unavailable/.test(body),
    "who ran it, what it covered and what it could not read are the record");
  assert.ok(!/if \(result\.hits\.length\)/.test(body),
    "a check that found nothing is the one most worth having on file");
});

check("and a check that could not be filed says so rather than looking filed", () => {
  const src = code(read("conflicts.js"));
  assert.ok(/not_recorded/.test(src));
  const html = page.renderPage({
    user: {}, result: {
      searched: ["X"], hits: [], disposition: "cleared", unavailable: [],
      sources_searched: 9, sources_total: 9, parties_compared: 1,
      not_recorded: "connection lost",
    },
  });
  assert.ok(/could not be filed/.test(html) && /run it again/.test(html));
});

check("the columns the record needs are migrated in", () => {
  const src = read("conflicts.js");
  for (const col of ["case_kind", "case_ref", "run_by", "searched_names", "sources_unavailable"]) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS \\$\\{col\\}|${col}`).test(src), `${col} is not added`);
  }
  assert.ok(/ADD COLUMN IF NOT EXISTS/.test(src));
});

// ── Reaching it ──────────────────────────────────────────

check("it is mounted, on the menu, and gated to the people who open cases", () => {
  assert.ok(/require\("\.\/conflicts-page"\)\.mount\(app, auth\)/.test(server), "not mounted");
  assert.ok(/\/admin\/conflicts" class="nav-link/.test(nav), "not on the menu");
  assert.deepStrictEqual(page.ROLES, ["admin", "manager", "attorney"],
    "an attorney opening a case has to be able to run one");
});

check("the civil case button carries BOTH sides into the check", () => {
  assert.ok(/conflicts-page/.test(civilUi), "the case page does not link to the check");
  const i = civilUi.indexOf("const conflictNames");
  const body = civilUi.slice(i, i + 400);
  assert.ok(/opposing_party/.test(body),
    "a check run from a case that omits the opposing party is the old bug again");
  assert.ok(/opposing_counsel/.test(body));
  assert.ok(/client_key|case_name/.test(body));
});

check("the link it builds is a real one", () => {
  const href = page.linkFor({ kind: "civil", ref: "Civil #12", names: ["Wei Chen", "Acme LLC"] });
  assert.ok(href.startsWith("/admin/conflicts?"));
  const q = new URLSearchParams(href.split("?")[1]);
  assert.deepStrictEqual(q.getAll("names"), ["Wei Chen", "Acme LLC"]);
  assert.strictEqual(q.get("ref"), "Civil #12");
  assert.strictEqual(q.get("kind"), "civil");
});

check("a check run from a case does not report the case against itself", () => {
  const src = code(read("conflicts-page.js"));
  assert.ok(/exclude: ref \? \[ref\] : \[\]/.test(src),
    "without this every case conflicts with itself and the page is useless");
  assert.ok(/skip\.has\(party\.matter\)/.test(code(read("conflicts.js"))));
});

// ── The page itself ──────────────────────────────────────

check("the page contributes no script of its own", () => {
  // notify-admin.js's rule: an apostrophe in an onclick inside a template
  // literal kills every script on the page. This page is one nobody can
  // afford to have quietly stop working.
  assert.ok(!/<script/i.test(code(read("conflicts-page.js"))));
  assert.ok(/method="POST"/.test(page.renderPage({ user: {} })), "it has to be a form");
});

check("a weak hit is kept apart from a finding", () => {
  const hit = (side, strength) => ({
    side, strength, name: "W. Chen", matter: "PI #3", source: "x", detail: null, searched: "Wei Chen",
  });
  const html = page.renderPage({
    user: {}, result: {
      searched: ["Wei Chen"], hits: [hit("client", "weak")], disposition: "cleared",
      unavailable: [], sources_searched: 9, sources_total: 9, parties_compared: 5,
    },
  });
  assert.ok(/near-miss/.test(html) && /Not a finding/.test(html));
  assert.ok(/<details/.test(html), "a near-miss should not sit at the top of the page");
});

check("being on the other side is said in plain words", () => {
  const html = page.renderPage({
    user: {}, result: {
      searched: ["Wei Chen"], disposition: "conflict",
      hits: [{ side: "adverse", strength: "exact", name: "Wei Chen", matter: "Civil #12", source: "civil", detail: null, searched: "Wei Chen" }],
      unavailable: [], sources_searched: 9, sources_total: 9, parties_compared: 5,
    },
  });
  assert.ok(/on the other side of this name/.test(html));
  assert.ok(/1\.7/.test(html) && /1\.9/.test(html), "name the rules it is a question under");
  assert.ok(/THE OTHER SIDE/.test(html));
});

check("the reason is written next to the code", () => {
  const src = read("conflicts.js");
  assert.ok(/never saw/.test(src) && /false clear/.test(src),
    "the next person needs to know what this replaced and why");
});

console.log(`\n${passed} checks passed\n`);
