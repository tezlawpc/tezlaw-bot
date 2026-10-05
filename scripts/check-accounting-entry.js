/**
 * check-accounting-entry.js
 *
 * Two bugs, both about an accounting entry naming the wrong thing.
 *
 * ── 1. WHOSE ENTRY IS IT ──────────────────────────────────
 * Record Fee and Record Retainer had a plain text box for the client's name,
 * and the server turned whatever was typed into a client key by slugifying
 * it. That key is what the journal entry — and for a retainer, the client's
 * trust ledger — gets filed under, and nothing checked it against the firm's
 * actual clients. So "Chen Wei", "Wei Chen" and "chen wei" produced three
 * different clients, none of them necessarily the real one, and the client's
 * own trust ledger page could not find the entry.
 *
 * A trust ledger under a key that matches no client is not a client ledger,
 * and RRC 1.15 requires one per client.
 *
 * The property that matters most here is not the search box. It is that the
 * hidden key is cleared the instant the name is edited. Picking "Chen Wei"
 * and typing over it must never post Chen Wei's key with somebody else's
 * name — that files one client's money into another client's ledger, which is
 * worse than the free-text box it replaces.
 *
 * ── 2. A COLUMN THAT DOES NOT EXIST ───────────────────────
 * "Sync from PI" died on `column c.matter_type does not exist`. syncFromPI
 * selected c.matter_type from pi_cases, which has no such column — and never
 * read it: every postJournalEntry in that function passes matter_type: "pi"
 * literally, which is right, because a PI disbursement is a PI matter by
 * construction.
 *
 * This is the second time this exact mistake has been made on this exact
 * table; check-pi-brokers.js already guards `final_settlement`. So the check
 * below is written against the DDL rather than against one column name: it
 * reads pi_cases' definition and refuses any `c.<column>` that is not in it.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const acct = fs.readFileSync(path.join(ROOT, "accounting.js"), "utf8");
const pick = fs.readFileSync(path.join(ROOT, "public", "accounting-client.js"), "utf8");
const pi = fs.readFileSync(path.join(ROOT, "personal-injury.js"), "utf8");
const bundles = fs.readFileSync(path.join(ROOT, "client-script.js"), "utf8");

console.log("\nAccounting entries: the client, and the columns\n");

// ── The picker exists and is wired ─────────────────────────

check("both forms carry a client picker, not a bare text box", () => {
  const n = (srv.match(/data-client-pick/g) || []).length;
  assert.strictEqual(n, 2, `found ${n} pickers; Record Fee and Record Retainer both need one`);
  const keys = (srv.match(/<input type="hidden" name="client_key"/g) || []).length;
  assert.strictEqual(keys, 2, "each picker needs its hidden key field");
});

check("the picker script is a registered bundle, not inline", () => {
  assert.ok(/"accounting-client\.js",/.test(bundles),
    "a file not in CLIENT_BUNDLES is not served and the box silently stays dumb");
  const tags = (srv.match(/clientScriptTag\("accounting-client\.js"\)/g) || []).length;
  assert.strictEqual(tags, 2, "both pages must include it");
});

check("it searches the firm's real clients", () => {
  assert.ok(/\/admin\/api\/clients\/search/.test(pick));
});

// ── The property the whole thing turns on ──────────────────

check("editing the name clears the picked key", () => {
  const i = pick.indexOf('name.addEventListener("input"');
  assert.ok(i > -1, "no input handler");
  const body = pick.slice(i, pick.indexOf('name.addEventListener("keydown"'));
  assert.ok(/key\.value = ""/.test(body),
    "a stale key riding along with a different name files money under the wrong client");
  // And it has to happen before anything else in that handler, not after a
  // fetch that might not come back.
  assert.ok(body.indexOf('key.value = ""') < body.indexOf("setTimeout"),
    "the key must be cleared synchronously, not after the search returns");
});

check("a selection sets both the name and the key together", () => {
  const i = pick.indexOf("function choose(");
  const body = pick.slice(i, pick.indexOf("function render("));
  assert.ok(/name\.value = c\.client_name \|\| c\.key/.test(body));
  assert.ok(/key\.value = c\.key \|\| ""/.test(body));
});

check("a stale search response cannot overwrite a newer one", () => {
  assert.ok(/var mine = \+\+seq/.test(pick));
  assert.ok(/if \(mine !== seq\) return/.test(pick),
    "a slow request resolving late would repopulate the menu under the user");
});

check("the form says which key the entry will be filed under", () => {
  assert.ok(/function describe\(\)/.test(pick));
  assert.ok(/creates a new ledger/.test(pick),
    "a client not in the system is allowed, but it should not happen invisibly");
  assert.ok(/Attached to/.test(pick), "and a matched client should be confirmed");
});

check("search being unavailable leaves the box usable", () => {
  assert.ok(/Client search is unavailable/.test(pick));
  assert.ok(/\.catch\(function \(\)/.test(pick));
});

check("client names are escaped into the menu", () => {
  // The menu renders names from the database with innerHTML.
  assert.ok(/function esc\(s\)/.test(pick));
  assert.ok(/d\.textContent = String/.test(pick), "escaping via textContent, not a regex");
  assert.ok(/esc\(c\.client_name \|\| c\.key\)/.test(pick));
});

// ── The server does not take the key on trust ──────────────

check("a client_key off the wire is verified before it is used", () => {
  assert.ok(/async function clientKeyFor\(body\)/.test(srv));
  const i = srv.indexOf("async function clientKeyFor(body)");
  const body = srv.slice(i, srv.indexOf("app.get(\"/admin/accounting/record-fee\"", i));
  assert.ok(/aggregateClients\(\)/.test(body), "it has to be looked up, not trusted");
  assert.ok(/all\.find\(c => c\.key === picked\)/.test(body));
  assert.ok(/not recognised, falling back/.test(body),
    "an unknown key must be discarded, not written into the ledger");
});

check("an unverifiable key falls back to the old behaviour, not to nothing", () => {
  const i = srv.indexOf("async function clientKeyFor(body)");
  const body = srv.slice(i, srv.indexOf("app.get(\"/admin/accounting/record-fee\"", i));
  // Staff do take retainers from people who are not in the system yet.
  // Blocking that would be worse than the bug.
  assert.ok(/return \{ client_key: slug, matched: false \}/.test(body));
  assert.ok(/catch \(e\) \{/.test(body), "a lookup failure must not block recording money");
});

check("neither POST slugifies the name on its own any more", () => {
  for (const fn of ["recordFeeRevenue", "recordTrustDeposit"]) {
    const i = srv.indexOf(`accounting.${fn}({`);
    assert.ok(i > -1, `${fn} call not found`);
    const body = srv.slice(i, i + 600);
    assert.ok(/client_key: who\.client_key/.test(body), `${fn} does not use the verified key`);
    assert.ok(!/client_key: \(req\.body\.client_name/.test(body),
      `${fn} still derives the key from the typed name`);
  }
});

check("both POSTs resolve the client before recording", () => {
  const n = (srv.match(/const who = await clientKeyFor\(req\.body\);/g) || []).length;
  assert.strictEqual(n, 2);
});

// ── pi_cases: only columns that exist ──────────────────────

const DDL = (pi.match(/CREATE TABLE IF NOT EXISTS pi_cases[\s\S]*?\n\s*\)\s*`/) || [""])[0];

check("pi_cases' definition can be read", () => {
  assert.ok(DDL.length > 200, "the DDL did not parse out; the check below would pass vacuously");
});

const COLUMNS = new Set(
  DDL.split("\n").slice(1)
    .map(l => (l.match(/^\s{4,}([a-z_]+)\s+[A-Z]/) || [])[1])
    .filter(Boolean)
);

check("pi_cases has the columns syncFromPI actually relies on", () => {
  for (const c of ["client_name", "client_key"]) {
    assert.ok(COLUMNS.has(c), `pi_cases has no ${c}`);
  }
});

check("pi_cases has no matter_type — which is why Sync from PI threw", () => {
  assert.ok(!COLUMNS.has("matter_type"));
});

check("nothing selects a c.<column> that pi_cases does not define", () => {
  // Written against the DDL rather than one column name: this is the second
  // time the same mistake has been made on this table (check-pi-brokers.js
  // guards final_settlement), so the check should catch the third.
  const offenders = [];
  for (const file of ["accounting.js", "server.js", "personal-injury.js"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    // Each SQL template that joins pi_cases under the alias c.
    const re = /`([^`]*JOIN\s+pi_cases\s+c\b[^`]*)`/gi;
    let m;
    while ((m = re.exec(src))) {
      const sql = m[1];
      for (const ref of sql.matchAll(/\bc\.([a-z_]+)\b/g)) {
        const col = ref[1];
        // Aliases the query defines itself are fine, as are the join keys.
        if (COLUMNS.has(col) || col === "id") continue;
        offenders.push(`${file}: c.${col}`);
      }
    }
  }
  assert.deepStrictEqual([...new Set(offenders)], [],
    "these read columns pi_cases does not have, and will throw at runtime");
});

check("syncFromPI still labels every PI entry as a PI matter", () => {
  const i = acct.indexOf("async function syncFromPI");
  const body = acct.slice(i, acct.indexOf("\n}", acct.indexOf("results.costs++", i)));
  const n = (body.match(/matter_type: "pi"/g) || []).length;
  assert.ok(n >= 9, `only ${n} entries carry matter_type — dropping the column must not drop the label`);
});

console.log(`\n${passed} checks passed\n`);
