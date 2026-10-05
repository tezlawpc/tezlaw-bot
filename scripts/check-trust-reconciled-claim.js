/**
 * check-trust-reconciled-claim.js
 *
 * One property, and it is the most consequential one on any screen in this
 * repo: the software may never say client trust is reconciled unless it is.
 *
 * It said it. The accounting dashboard showed
 *
 *     IOLTA TRUST
 *     $0.00
 *     ✓ Reconciled
 *
 * for a trust account it had never seen a single transaction for. The
 * reconciliation is bank balance minus the sum of the client ledgers, and on
 * an empty database that is zero minus zero — which satisfies the test
 * exactly. So the one case where nothing at all was known produced the most
 * reassuring output the page can produce.
 *
 * A green tick beside a trust balance is not read as "the arithmetic came out
 * even". It is read as "the three-way reconciliation was performed and it
 * balanced", which is the RRC 1.15 duty itself — the rule the State Bar takes
 * licences over. A screen that asserts it without evidence is worse than a
 * screen that shows nothing, because somebody relies on it and stops looking.
 *
 * So four states have to stay distinguishable, and only one of them may be
 * green:
 *
 *   reconciled   activity exists and the two sides agree
 *   variance     activity exists and they disagree — find out why, today
 *   no_data      nothing recorded; assert nothing
 *   unverified   the staff app holds trust transactions this reconciliation
 *                cannot see (it reads accounting_trust_ledger; the app writes
 *                trust_transactions). Client money is moving and this page
 *                cannot account for it.
 *
 * Everything below exists to keep an empty or unreadable ledger out of the
 * first of those.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const accounting = require(path.join(ROOT, "accounting.js"));
const ui = require(path.join(ROOT, "accounting-ui.js"));
const { trustStatus, TRUST_STATUS_LABEL } = accounting;
const { trustColor, trustCaption, trustStatusLine } = ui;

const GREEN = "#2F6B3F";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("\nTrust reconciliation: the claim\n");

// ── The bug itself ─────────────────────────────────────────

check("an entirely empty ledger is NOT reconciled", () => {
  const s = trustStatus({ bank_balance: 0, sum_of_client_balances: 0, ledger_entry_count: 0, app_transaction_count: 0 });
  assert.strictEqual(s.reconcile_status, "no_data");
  assert.strictEqual(s.is_reconciled, false,
    "zero minus zero balances arithmetically; that is not a reconciliation");
  assert.ok(s.reconcile_note, "and it has to say why it is claiming nothing");
  assert.ok(/not a statement that the trust account balances/i.test(s.reconcile_note));
});

check("the arithmetic still balances on an empty ledger — separately recorded", () => {
  // Keeping both facts means nobody has to rediscover why the green tick
  // appeared. arithmetic_balanced is the old behaviour, named honestly.
  const s = trustStatus({});
  assert.strictEqual(s.arithmetic_balanced, true);
  assert.strictEqual(s.is_reconciled, false);
  assert.strictEqual(s.has_activity, false);
});

check("an empty ledger renders grey, with no tick and no claim", () => {
  const s = trustStatus({});
  assert.notStrictEqual(trustColor(s), GREEN, "grey, not green");
  assert.ok(!/✓/.test(trustCaption(s)), "a tick is the claim; there is nothing to tick");
  assert.ok(!/Reconciled/i.test(trustCaption(s)));
  assert.ok(!/✓/.test(trustStatusLine(s)));
});

// ── The state that is actually true of this firm today ─────
// The staff app records client trust in trust_transactions. The accounting
// module reconciles accounting_trust_ledger. Nothing joins them, so the app
// can hold a hundred deposits while this page reads zero on both sides — and
// the old code called that reconciled.

check("app transactions the accounting ledger cannot see are 'unverified'", () => {
  const s = trustStatus({ bank_balance: 0, sum_of_client_balances: 0, ledger_entry_count: 0, app_transaction_count: 14 });
  assert.strictEqual(s.reconcile_status, "unverified");
  assert.strictEqual(s.is_reconciled, false);
  assert.ok(/14 client trust transaction/.test(s.reconcile_note),
    "the note should say how many are unaccounted for");
  assert.notStrictEqual(trustColor(s), GREEN);
});

check("'unverified' is not dressed up as 'no data'", () => {
  // These call for different work: one needs the ledgers joined, the other
  // needs somebody to start recording. Collapsing them hides live client money.
  const none = trustStatus({});
  const some = trustStatus({ app_transaction_count: 3 });
  assert.notStrictEqual(none.reconcile_status, some.reconcile_status);
  assert.strictEqual(some.has_activity, true);
});

// ── The states that were already right ─────────────────────

check("real activity that balances IS reconciled", () => {
  const s = trustStatus({ bank_balance: 12500.00, sum_of_client_balances: 12500.00, ledger_entry_count: 7 });
  assert.strictEqual(s.reconcile_status, "reconciled");
  assert.strictEqual(s.is_reconciled, true);
  assert.strictEqual(s.reconcile_note, null, "nothing to explain when it balances");
  assert.strictEqual(trustColor(s), GREEN);
  assert.ok(/✓/.test(trustCaption(s)));
});

check("real activity that does not balance is a variance, in red", () => {
  const s = trustStatus({ bank_balance: 12500.00, sum_of_client_balances: 12000.00, ledger_entry_count: 7 });
  assert.strictEqual(s.reconcile_status, "variance");
  assert.strictEqual(s.is_reconciled, false);
  assert.strictEqual(trustColor(s), "#9C2B1E");
});

check("a one-cent variance is a variance", () => {
  // RRC 1.15 has no materiality threshold. A cent out means a cent of
  // somebody's money is somewhere it should not be.
  const s = trustStatus({ bank_balance: 100.01, sum_of_client_balances: 100.00, ledger_entry_count: 2 });
  assert.strictEqual(s.reconcile_status, "variance");
});

check("sub-cent float noise is not a variance", () => {
  const s = trustStatus({ bank_balance: 100.001, sum_of_client_balances: 100.00, ledger_entry_count: 2 });
  assert.strictEqual(s.reconcile_status, "reconciled");
});

check("a non-zero bank balance alone counts as activity", () => {
  // Money in the trust account and no client ledgers behind it is the single
  // most serious state these books can be in. It must never read as empty.
  const s = trustStatus({ bank_balance: 5000, sum_of_client_balances: 0, ledger_entry_count: 0 });
  assert.strictEqual(s.has_activity, true);
  assert.strictEqual(s.reconcile_status, "variance");
  assert.strictEqual(s.is_reconciled, false);
});

check("client ledgers with no bank balance is also a variance, not 'no data'", () => {
  const s = trustStatus({ bank_balance: 0, sum_of_client_balances: 3200, ledger_entry_count: 4 });
  assert.strictEqual(s.reconcile_status, "variance");
  assert.strictEqual(s.is_reconciled, false);
});

// ── Nothing unknown may come out green ─────────────────────

check("an unrecognised status is never green and never ticks", () => {
  for (const s of [undefined, null, {}, { reconcile_status: "something_new" }, { is_reconciled: true }]) {
    assert.notStrictEqual(trustColor(s), GREEN, `${JSON.stringify(s)} rendered green`);
    assert.ok(!/✓/.test(trustCaption(s)), `${JSON.stringify(s)} rendered a tick`);
    assert.ok(!/✓/.test(trustStatusLine(s)), `${JSON.stringify(s)} rendered a tick`);
  }
});

check("a legacy object with is_reconciled: true but no status stays grey", () => {
  // Fail-safe in the direction that matters. An old shape reaching these
  // helpers should produce "unknown", not a green tick on faith.
  assert.notStrictEqual(trustColor({ is_reconciled: true }), GREEN);
  assert.ok(/unknown/i.test(trustCaption({ is_reconciled: true })));
});

// ── The pages must use the helpers, not the old ternaries ──
// The whole fix is defeated by one `trust.is_reconciled ? green : red` left
// behind in the markup, so the file is checked for them directly.

check("no page colours a trust figure straight off is_reconciled", () => {
  const src = fs.readFileSync(path.join(ROOT, "accounting-ui.js"), "utf8");
  const bad = src.split("\n")
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /is_reconciled\s*\?/.test(l));
  assert.deepStrictEqual(bad, [],
    "these lines branch on is_reconciled directly; use trustColor/trustCaption/trustStatusLine:\n" +
    bad.map(([n, l]) => `    ${n}: ${l.trim()}`).join("\n"));
});

check("no literal '✓ Reconciled' outside the helpers", () => {
  const src = fs.readFileSync(path.join(ROOT, "accounting-ui.js"), "utf8");
  const helperStart = src.indexOf("function trustColor");
  const helperEnd = src.indexOf("function companyField");
  assert.ok(helperStart > -1 && helperEnd > helperStart, "the helpers moved; this check needs updating");
  const outside = src.slice(0, helperStart) + src.slice(helperEnd);
  assert.ok(!/✓ Reconciled/.test(outside) && !/✓ RECONCILED/.test(outside),
    "a hard-coded reconciliation claim bypasses every state check above");
});

check("the trust page surfaces the note when there is one", () => {
  const src = fs.readFileSync(path.join(ROOT, "accounting-ui.js"), "utf8");
  assert.ok(/trust\.reconcile_note/.test(src),
    "the reason nothing is being claimed has to reach the page, not just the object");
  assert.ok(/esc\(trust\.reconcile_note\)/.test(src),
    "and it is escaped — the note interpolates a count from the database");
});

check("the dashboard banner fires on 'unverified' too", () => {
  const src = fs.readFileSync(path.join(ROOT, "accounting-ui.js"), "utf8");
  // The old guard was `bank_balance > 0`, which is false in exactly the
  // unverified case — hiding the one state nobody would otherwise notice.
  assert.ok(/reconcile_status === "unverified"/.test(src));
});

// ── Every other consumer of the figure ─────────────────────

check("the Excel export states the status rather than YES/NO", () => {
  const src = fs.readFileSync(path.join(ROOT, "accounting.js"), "utf8");
  assert.ok(!/Reconciled: \$\{trust\.is_reconciled \? "YES/.test(src),
    "the export would still print YES on an empty ledger");
  assert.ok(/TRUST_STATUS_LABEL\[trust\.reconcile_status\]/.test(src));
  assert.ok(/trust\.reconcile_note \? \[\{ Item: trust\.reconcile_note/.test(src),
    "the workbook is what gets handed to an auditor; the caveat travels with it");
});

check("every status has a label, and only one says reconciled", () => {
  for (const k of ["reconciled", "variance", "no_data", "unverified"]) {
    assert.ok(TRUST_STATUS_LABEL[k], `no label for ${k}`);
  }
  const claiming = Object.entries(TRUST_STATUS_LABEL)
    .filter(([, v]) => !/NOT RECONCILED/.test(v));
  assert.deepStrictEqual(claiming.map(([k]) => k), ["reconciled"],
    "a label that does not say NOT RECONCILED reads as reconciled");
});

check("a counting failure cannot become a reconciliation", () => {
  const src = fs.readFileSync(path.join(ROOT, "accounting.js"), "utf8");
  // Both row counts are wrapped in try/catch so a missing table does not take
  // the page down. The danger is the catch leaving a zero that then reads as
  // "empty, therefore balanced" — so the catch must not be the only guard.
  assert.ok(/trust ledger row count failed/.test(src),
    "a failed count should be logged, not swallowed silently");
  assert.ok(/app_transaction_count: appRowCount/.test(src),
    "the count reaches the caller so an unknown stays visible");
});

check("getTrustReconciliation returns the status fields", () => {
  const src = fs.readFileSync(path.join(ROOT, "accounting.js"), "utf8");
  const i = src.indexOf("async function getTrustReconciliation");
  const body = src.slice(i, src.indexOf("\n}", i));
  for (const f of ["ledger_entry_count", "app_transaction_count", "trustStatus({"]) {
    assert.ok(body.includes(f), `getTrustReconciliation does not return ${f}`);
  }
  assert.ok(!/is_reconciled: Math\.abs/.test(body),
    "the raw arithmetic must not be assigned to is_reconciled again");
});

console.log(`\n${passed} checks passed\n`);
