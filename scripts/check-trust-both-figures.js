/**
 * check-trust-both-figures.js
 *
 * Client trust is recorded in two places that have never been joined. The
 * staff app writes trust_transactions. The accounting module writes
 * accounting_trust_ledger and reconciles only that one. So the RRC 1.15
 * figure on the trust page has been computed from one of the firm's two trust
 * records — and nothing on screen said which.
 *
 * Both are now shown side by side. Neither is presented as the answer.
 *
 * WHY NOT JUST MERGE THEM
 * Combining the two means deciding which rows are the same transaction
 * recorded twice. Get that wrong in one direction and the client's money is
 * counted twice; wrong in the other and a real deposit disappears. That is a
 * judgement about client funds for an attorney to make, not one a page should
 * make quietly on his behalf. So the merge is shown, the duplicates it would
 * have to resolve are listed, and `is_reconciled` still comes from the
 * accounting ledger alone until JJ decides.
 *
 * What these checks hold:
 *   - the merged figure never replaces the reconciliation status
 *   - a client only one ledger has ever seen still appears
 *   - the possible duplicates are surfaced, not buried
 *   - trust-ledger still writes nothing
 *   - neither page can be taken down by the second opinion failing
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const ui = require(path.join(ROOT, "accounting-ui.js"));
const tl = require(path.join(ROOT, "trust-ledger.js"));
const { renderBothLedgers, mergeProblems, c$ } = ui;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const src = fs.readFileSync(path.join(ROOT, "accounting-ui.js"), "utf8");
const led = fs.readFileSync(path.join(ROOT, "trust-ledger.js"), "utf8");

// Two ledgers for one client. The accounting side has the retainer; the app
// has a disbursement the accounting side never saw.
const APP = [
  { id: 7, client_key: "chen", txn_type: "withdrawal", amount_cents: 150000,
    description: "Filing fee to USCIS", transaction_date: "2026-03-10",
    running_balance_cents: 350000, created_at: "2026-03-10T10:00:00Z" },
];
const ACCT = [
  { id: 2, client_key: "chen", client_name: "Chen", deposit_amount: "5000.00", disburse_amount: "0",
    description: "Retainer", transaction_date: "2026-02-01", running_balance: "5000.00",
    created_at: "2026-02-01T10:00:00Z", entry_id: 11 },
];

console.log("\nTrust: both figures, side by side\n");

// ── The merge itself ───────────────────────────────────────

check("the two ledgers combine in date order", () => {
  const m = tl.mergeLedgers(APP, ACCT);
  assert.deepStrictEqual(m.rows.map(r => r.source), ["accounting", "app"],
    "February before March, whichever table each came from");
  assert.strictEqual(m.closing_balance_cents, 350000, "$5,000 in, $1,500 out");
  assert.strictEqual(m.counts.accounting, 1);
  assert.strictEqual(m.counts.app, 1);
});

check("the accounting ledger alone reaches a different figure", () => {
  // The whole reason for showing two columns: the accounting side has never
  // seen the disbursement, so it believes the client still holds $5,000.
  const acctOnly = tl.mergeLedgers([], ACCT);
  assert.strictEqual(acctOnly.closing_balance_cents, 500000);
  assert.notStrictEqual(acctOnly.closing_balance_cents, tl.mergeLedgers(APP, ACCT).closing_balance_cents);
});

check("a reversed app transaction stays visible but moves no money", () => {
  const reversed = [{ ...APP[0], reversed_by_txn_id: 9 }];
  const m = tl.mergeLedgers(reversed, ACCT);
  assert.strictEqual(m.closing_balance_cents, 500000, "a reversal is history, not money");
  assert.strictEqual(m.rows.length, 2, "and it is still on the page");
  assert.ok(m.rows.some(r => r.reversed));
});

// ── The trap a merge has to avoid ──────────────────────────

check("the same transaction in both tables is flagged, not silently doubled", () => {
  const dupApp = [{ id: 1, client_key: "chen", txn_type: "deposit", amount_cents: 500000,
    description: "Retainer", transaction_date: "2026-02-01", running_balance_cents: 500000,
    created_at: "2026-02-01T10:00:00Z" }];
  const m = tl.mergeLedgers(dupApp, ACCT);
  const dups = m.problems.filter(p => p.kind === "possible_duplicate");
  assert.strictEqual(dups.length, 1, "same day, same amount, same direction, one from each table");
  assert.strictEqual(m.closing_balance_cents, 1000000,
    "the naive total IS doubled — which is exactly why it is shown with the warning, not merged");
});

check("a negative client balance is reported", () => {
  const over = [{ id: 3, client_key: "chen", txn_type: "withdrawal", amount_cents: 900000,
    description: "Over-disbursement", transaction_date: "2026-04-01",
    running_balance_cents: 0, created_at: "2026-04-01T10:00:00Z" }];
  const m = tl.mergeLedgers(over, ACCT);
  const neg = m.problems.filter(p => p.kind === "negative_balance");
  assert.ok(neg.length, "a client trust balance below zero is the thing RRC 1.15 is about");
  assert.ok(/RRC 1\.15/.test(neg[0].detail));
});

check("a stored balance that agrees with date order raises nothing", () => {
  // The base fixture is consistent: $5,000 in, $1,500 out, stored 350000.
  // Silence here is the point — a mismatch warning on correct data would
  // train everybody to ignore the warning that matters.
  const m = tl.mergeLedgers(APP, ACCT);
  assert.strictEqual(m.problems.filter(p => p.kind === "balance_mismatch").length, 0);
});

check("a stored balance that disagrees with date order is reported", () => {
  const wrong = [{ ...APP[0], running_balance_cents: 999999 }];
  const m = tl.mergeLedgers(wrong, ACCT);
  const mm = m.problems.filter(p => p.kind === "balance_mismatch");
  assert.strictEqual(mm.length, 1);
  assert.strictEqual(mm[0].computed, 350000);
  assert.strictEqual(mm[0].stored, 999999);
  assert.ok(/most recently entered row/.test(mm[0].detail),
    "the explanation has to say why the stored figure is wrong, or it reads as our arithmetic being off");
});

check("a back-dated app row exposes the stored balances after it", () => {
  const backdated = [
    { id: 10, client_key: "chen", txn_type: "deposit", amount_cents: 100000, description: "Later entry",
      transaction_date: "2026-05-01", running_balance_cents: 100000, created_at: "2026-05-01T10:00:00Z" },
    { id: 11, client_key: "chen", txn_type: "deposit", amount_cents: 200000, description: "Back-dated",
      transaction_date: "2026-01-01", running_balance_cents: 300000, created_at: "2026-05-02T10:00:00Z" },
  ];
  const m = tl.mergeLedgers(backdated, []);
  assert.deepStrictEqual(m.rows.map(r => r.id), [11, 10], "date order, not entry order");
  assert.ok(m.problems.some(p => p.kind === "balance_mismatch"),
    "the stored figures were computed in entry order and no longer hold");
});

// ── The merged figure never becomes the answer ─────────────

check("the reconciliation status still comes from the accounting ledger alone", () => {
  // JJ asked for both figures now and a merge later. The status, the colour
  // and is_reconciled must not quietly start using the merged number.
  const i = src.indexOf("async function renderTrustReconciliation");
  const body = src.slice(i, src.indexOf("async function renderChartOfAccounts", i));
  assert.ok(/trustStatusLine\(trust\)/.test(body), "the status is still trust's");
  assert.ok(!/trustStatusLine\(merged/.test(body));
  assert.ok(!/is_reconciled = /.test(body), "nothing reassigns the verdict");
});

check("the panel says plainly which figure the status is based on", () => {
  assert.ok(/The figures above come from the accounting ledger alone, which is what the status is based on/.test(src));
  assert.ok(/for comparison only/.test(src));
});

check("both variances are shown together, so they can be compared", () => {
  assert.ok(/Accounting ledger alone: \$\{fmt\$\(trust\.variance\)\}/.test(src),
    "the merged variance is meaningless without the other one beside it");
  assert.ok(/mergedVariance = merged \? bankCents - merged\.total_liability_cents : null/.test(src));
});

check("the merged variance is computed against the same bank balance", () => {
  assert.ok(/const bankCents = Math\.round\(\(Number\(trust\.bank_balance\) \|\| 0\) \* 100\)/.test(src),
    "two figures compared against different bank balances would not be a comparison");
});

// ── Nobody falls off the table ─────────────────────────────

check("the per-client table is the union of both ledgers", () => {
  assert.ok(/new Set\(\[\.\.\.acctByKey\.keys\(\), \.\.\.mergedByKey\.keys\(\)\]\)/.test(src),
    "a client the accounting ledger has never seen is the case most worth looking at");
});

check("a client in only one ledger is labelled as such", () => {
  assert.ok(/the staff app only/.test(src));
  assert.ok(/the accounting ledger only/.test(src));
});

check("a row the two disagree about is marked", () => {
  assert.ok(/const differs = acctCents != null && bothCents != null && acctCents !== bothCents/.test(src));
  assert.ok(/A highlighted row is one the two ledgers disagree about/.test(src),
    "the highlight needs a key, or it reads as decoration");
});

check("cents are compared as cents, not as floats", () => {
  // The accounting side stores NUMERIC and the app stores integer cents.
  // Comparing 5000.00 to 500000 through a float is how a cent goes missing.
  assert.ok(/Math\.round\(Number\(a\.balance\) \* 100\)/.test(src));
});

// ── Rendering the second table ─────────────────────────────

check("every row names which ledger it came from", () => {
  const html = renderBothLedgers({ ok: true, data: tl.mergeLedgers(APP, ACCT) });
  assert.ok(html.includes(">App<"));
  assert.ok(html.includes(">Accounting<"));
});

check("a recomputed balance that differs from the stored one shows both", () => {
  const data = tl.mergeLedgers([{ ...APP[0], running_balance_cents: 999999 }], ACCT);
  const html = renderBothLedgers({ ok: true, data });
  assert.ok(/stored \$9,999\.99/.test(html), "the stored figure is evidence and should stay visible");
});

check("a negative low point is called out with the rule", () => {
  const over = [{ id: 3, client_key: "chen", txn_type: "withdrawal", amount_cents: 900000,
    description: "Over", transaction_date: "2026-04-01", running_balance_cents: 0,
    created_at: "2026-04-01T10:00:00Z" }];
  const html = renderBothLedgers({ ok: true, data: tl.mergeLedgers(over, ACCT) });
  assert.ok(/may never go below zero/.test(html));
  assert.ok(/RRC 1\.15/.test(html));
});

check("the duplicates are listed where somebody will see them", () => {
  const html = mergeProblems({ problems: [
    { kind: "possible_duplicate", client_key: "chen", detail: "App row 1 and accounting row 2 are the same amount on the same day." },
  ]});
  assert.ok(/to resolve before these two ledgers can be merged/.test(html));
  assert.ok(/Possibly the same transaction in both ledgers/.test(html));
  assert.ok(/chen/.test(html));
});

check("duplicates come before the other problems", () => {
  const html = mergeProblems({ problems: [
    { kind: "negative_balance", client_key: "a", detail: "neg" },
    { kind: "possible_duplicate", client_key: "b", detail: "dup" },
  ]});
  assert.ok(html.indexOf("Possibly the same transaction") < html.indexOf("below zero"),
    "a duplicate is why the combined figure may be overstated; it is read first");
});

check("a long list is truncated rather than filling the page", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: "possible_duplicate", client_key: "c" + i, detail: "d" }));
  const html = mergeProblems({ problems: many });
  assert.ok(/and 28 more/.test(html));
});

check("no problems renders nothing at all", () => {
  assert.strictEqual(mergeProblems({ problems: [] }), "");
  assert.strictEqual(mergeProblems(null), "");
});

check("a client key cannot inject markup", () => {
  const html = mergeProblems({ problems: [
    { kind: "possible_duplicate", client_key: '<script>alert(1)</script>', detail: '<img src=x onerror=alert(1)>' },
  ]});
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!/<img src=x/.test(html));
});

// ── Money formatting ───────────────────────────────────────

check("cents render as money, and a missing figure as a dash", () => {
  assert.strictEqual(c$(500000), "$5,000.00");
  assert.strictEqual(c$(-125050), "-$1,250.50");
  assert.strictEqual(c$(0), "$0.00", "a real zero is a figure");
  assert.strictEqual(c$(null), "—");
  assert.strictEqual(c$(undefined), "—");
});

// ── The second opinion cannot break the page ───────────────

check("a failure to read the app's ledger leaves the page standing", () => {
  const html = renderBothLedgers({ ok: false, error: "relation \"trust_transactions\" does not exist" });
  assert.ok(/could not be read/.test(html));
  assert.ok(/trust_transactions/.test(html), "the real error belongs on the page");
  assert.ok(!/\$0\.00/.test(html), "and it must not be dressed up as a zero balance");
});

check("both pages catch the merged read on their own", () => {
  assert.ok(/async function bothLedgers\(\)/.test(src));
  const n = (src.match(/console\.warn\("\[accounting-ui\] merged/g) || []).length;
  assert.strictEqual(n, 2, "the all-clients page and the per-client page each wrap their own read");
});

check("one table missing is reported without losing the other", () => {
  assert.ok(/The staff app's table could not be read/.test(src));
  assert.ok(/The accounting table could not be read/.test(src));
  // Read through locals, so the repo-wide `accounting.<fn>` export scan in
  // check-accounting-companies.js does not mistake a property named
  // `accounting` for a call into the accounting module.
  assert.ok(/const appSrc = merged \? merged\.sources\.app : null/.test(src));
  assert.ok(/const acctSrc = merged \? merged\.sources\["accounting"\] : null/.test(src));
  assert.ok(/!appSrc\.available/.test(src) && /!acctSrc\.available/.test(src));
});

// ── And it still writes nothing ────────────────────────────

check("trust-ledger remains read-only", () => {
  // It reads the staff app's live trust table. The moment it can write, a
  // display bug becomes a client-funds bug.
  for (const verb of ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "TRUNCATE", "DROP"]) {
    assert.ok(!new RegExp("\\b" + verb + "\\b").test(led),
      `trust-ledger.js contains ${verb} — it must only ever read`);
  }
});

check("the pages do not write to either trust table either", () => {
  for (const verb of ["INSERT INTO trust_transactions", "UPDATE trust_transactions",
                      "INSERT INTO accounting_trust_ledger", "UPDATE accounting_trust_ledger"]) {
    assert.ok(!src.includes(verb), `accounting-ui.js contains "${verb}"`);
  }
});

console.log(`\n${passed} checks passed\n`);
