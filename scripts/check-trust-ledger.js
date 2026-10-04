// check-trust-ledger.js — the client ledger an auditor would read.
//
// Client trust money sits in two tables that cannot see each other, and the
// staff app computes each new running balance from
//     ORDER BY id DESC LIMIT 1
// which is INSERTION order. Everything below follows from that one line:
//
//   · a back-dated entry takes its balance from whatever was keyed in last,
//     so the stored balances are a correct insertion log and a wrong client
//     ledger;
//   · the overdraft guard tests the same ordering, so a back-dated withdrawal
//     can pass it and still leave the date-ordered ledger below zero on a day
//     in the past — a trust shortfall no screen shows;
//   · and the trust page reads only the other table, so app activity is
//     invisible there entirely.
//
// RRC 1.15(d)(3) wants one per-client ledger. These assertions are what makes
// the merged one trustworthy: balances recomputed in date order, disagreements
// reported rather than smoothed over, and the same transaction appearing in
// both tables flagged rather than counted twice.

const assert = require("assert");
const path = require("path");

require("./lib/stub-pg").install();

const T = require(path.join(__dirname, "..", "trust-ledger.js"));
const { mergeLedgers, toCents, fromCents } = T;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Builders. created_at is what breaks ties within a day, so it is explicit:
// a test that relied on insertion order would be testing the bug.
let seq = 0;
function appRow({ date, deposit = 0, withdraw = 0, balance, created, id, reversed = false }) {
  seq++;
  return {
    id: id ?? seq,
    client_key: "chen-mei",
    staff_id: 1,
    txn_type: deposit ? "deposit" : "withdrawal",
    amount_cents: deposit || withdraw,
    description: deposit ? "Retainer received" : "Filing fee paid",
    memo: null,
    reference_number: null,
    transaction_date: date,
    running_balance_cents: balance,
    reversed_by_txn_id: reversed ? 999 : null,
    created_at: created || `${date}T12:00:00Z`,
  };
}

function acctRow({ date, deposit = "0.00", disburse = "0.00", balance = null, created, id }) {
  seq++;
  return {
    id: id ?? seq,
    entry_id: 500 + seq,
    client_key: "chen-mei",
    client_name: "Chen, Mei",
    transaction_date: date,
    description: "Trust posting",
    deposit_amount: deposit,
    disburse_amount: disburse,
    running_balance: balance,
    reference: null,
    created_at: created || `${date}T12:00:00Z`,
  };
}

console.log("\ntrust ledger\n");

// ── Money ──────────────────────────────────────────────────

check("NUMERIC comes in as exact cents", () => {
  // 10.15 * 100 is 1014.9999999999999 in binary floating point. A cent lost
  // per row is a reconciliation that never balances.
  assert.strictEqual(toCents("10.15"), 1015);
  assert.strictEqual(toCents("0.07"), 7);
  assert.strictEqual(toCents("1234567.89"), 123456789);
  assert.strictEqual(toCents(null), 0);
  assert.strictEqual(toCents(""), 0);
  assert.strictEqual(fromCents(123456789), "1234567.89");
  assert.strictEqual(fromCents(7), "0.07");
});

// ── The ordering bug ───────────────────────────────────────

check("rows are read in date order, not the order they were typed", () => {
  // Keyed in: Mar 1 deposit, then Mar 20 deposit, then a BACK-DATED Mar 10
  // withdrawal. The app gave the back-dated row a balance derived from Mar 20.
  const rows = [
    appRow({ date: "2026-03-01", deposit: 500000, balance: 500000, created: "2026-03-01T09:00:00Z", id: 1 }),
    appRow({ date: "2026-03-20", deposit: 200000, balance: 700000, created: "2026-03-20T09:00:00Z", id: 2 }),
    appRow({ date: "2026-03-10", withdraw: 100000, balance: 600000, created: "2026-03-25T09:00:00Z", id: 3 }),
  ];
  const led = mergeLedgers(rows, []);
  assert.deepStrictEqual(led.rows.map(r => r.id), [1, 3, 2], "the ledger must read 1 Mar, 10 Mar, 20 Mar");
  assert.deepStrictEqual(led.rows.map(r => r.computed_balance_cents), [500000, 400000, 600000]);
  assert.strictEqual(led.closing_balance_cents, 600000);
});

check("a stored balance that disagrees is reported, not quietly replaced", () => {
  const rows = [
    appRow({ date: "2026-03-01", deposit: 500000, balance: 500000, created: "2026-03-01T09:00:00Z", id: 1 }),
    appRow({ date: "2026-03-20", deposit: 200000, balance: 700000, created: "2026-03-20T09:00:00Z", id: 2 }),
    appRow({ date: "2026-03-10", withdraw: 100000, balance: 600000, created: "2026-03-25T09:00:00Z", id: 3 }),
  ];
  const led = mergeLedgers(rows, []);
  const mismatches = led.problems.filter(p => p.kind === "balance_mismatch");
  assert.ok(mismatches.length >= 1, "the back-dated row's stored balance is wrong and must be called out");
  const m = mismatches.find(p => p.row_id === 3);
  assert.ok(m, "row 3 is the back-dated one");
  assert.strictEqual(m.stored, 600000);
  assert.strictEqual(m.computed, 400000);
});

check("balances that agree raise nothing", () => {
  const rows = [
    appRow({ date: "2026-03-01", deposit: 500000, balance: 500000, created: "2026-03-01T09:00:00Z", id: 1 }),
    appRow({ date: "2026-03-05", withdraw: 100000, balance: 400000, created: "2026-03-05T09:00:00Z", id: 2 }),
  ];
  const led = mergeLedgers(rows, []);
  assert.strictEqual(led.problems.length, 0, "an in-order ledger is not a problem: " + JSON.stringify(led.problems));
  assert.strictEqual(led.closing_balance_cents, 400000);
});

// ── The shortfall the overdraft guard cannot see ───────────

check("a back-dated withdrawal that overdraws a past day is caught", () => {
  // Entered: Mar 1 deposit $1,000; Mar 25 deposit $5,000. Then someone
  // back-dates a $3,000 withdrawal to Mar 10. Against the latest row the
  // balance looks like $6,000, so the app's guard allows it — but on 10 March
  // the client only had $1,000.
  const rows = [
    appRow({ date: "2026-03-01", deposit: 100000, balance: 100000, created: "2026-03-01T09:00:00Z", id: 1 }),
    appRow({ date: "2026-03-25", deposit: 500000, balance: 600000, created: "2026-03-25T09:00:00Z", id: 2 }),
    appRow({ date: "2026-03-10", withdraw: 300000, balance: 300000, created: "2026-03-26T09:00:00Z", id: 3 }),
  ];
  const led = mergeLedgers(rows, []);
  const neg = led.problems.filter(p => p.kind === "negative_balance");
  assert.strictEqual(neg.length, 1, "exactly one day goes negative");
  assert.strictEqual(neg[0].date, "2026-03-10");
  assert.strictEqual(neg[0].computed, -200000, "the client was $2,000 short on 10 March");
  assert.strictEqual(led.lowest_balance_cents, -200000);
  assert.strictEqual(led.lowest_balance_date, "2026-03-10");
  // ...and the closing balance is fine, which is exactly why no screen shows it.
  assert.strictEqual(led.closing_balance_cents, 300000);
});

check("a ledger that never goes negative reports no shortfall", () => {
  const led = mergeLedgers([
    appRow({ date: "2026-03-01", deposit: 100000, balance: 100000, id: 1 }),
    appRow({ date: "2026-03-10", withdraw: 50000, balance: 50000, id: 2 }),
  ], []);
  assert.strictEqual(led.problems.filter(p => p.kind === "negative_balance").length, 0);
  assert.strictEqual(led.lowest_balance_cents, 0, "the lowest point is the opening zero");
});

// ── Both tables in one ledger ──────────────────────────────

check("app rows and accounting rows appear in the same ledger", () => {
  const led = mergeLedgers(
    [appRow({ date: "2026-03-05", deposit: 250000, balance: 250000, id: 1 })],
    [acctRow({ date: "2026-03-01", deposit: "1000.00", id: 2 })]
  );
  assert.strictEqual(led.counts.app, 1);
  assert.strictEqual(led.counts.accounting, 1);
  assert.strictEqual(led.counts.total, 2);
  assert.deepStrictEqual(led.rows.map(r => r.source), ["accounting", "app"], "1 March comes before 5 March");
  assert.strictEqual(led.closing_balance_cents, 350000);
});

check("a client with activity only in the app is not an empty ledger", () => {
  // This is what the trust page shows today: nothing.
  const led = mergeLedgers([appRow({ date: "2026-03-05", deposit: 250000, balance: 250000, id: 1 })], []);
  assert.strictEqual(led.counts.total, 1);
  assert.strictEqual(led.closing_balance_cents, 250000);
});

check("same day, both tables: created_at decides the order", () => {
  const led = mergeLedgers(
    [appRow({ date: "2026-03-05", deposit: 100000, balance: 100000, created: "2026-03-05T15:00:00Z", id: 1 })],
    [acctRow({ date: "2026-03-05", deposit: "500.00", created: "2026-03-05T09:00:00Z", id: 2 })]
  );
  assert.deepStrictEqual(led.rows.map(r => r.source), ["accounting", "app"], "09:00 precedes 15:00");
  assert.deepStrictEqual(led.rows.map(r => r.computed_balance_cents), [50000, 150000]);
});

// ── Not counting the same money twice ──────────────────────

check("the same amount on the same day in both tables is flagged", () => {
  const led = mergeLedgers(
    [appRow({ date: "2026-03-05", deposit: 250000, balance: 250000, id: 1 })],
    [acctRow({ date: "2026-03-05", deposit: "2500.00", id: 2 })]
  );
  const dup = led.problems.filter(p => p.kind === "possible_duplicate");
  assert.strictEqual(dup.length, 1,
    "if these are one transaction, merging the ledgers would double the client's money");
  assert.strictEqual(dup[0].row_id, 1);
  assert.strictEqual(dup[0].other_row_id, 2);
});

check("different amounts on the same day are not duplicates", () => {
  const led = mergeLedgers(
    [appRow({ date: "2026-03-05", deposit: 250000, balance: 250000, id: 1 })],
    [acctRow({ date: "2026-03-05", deposit: "1000.00", id: 2 })]
  );
  assert.strictEqual(led.problems.filter(p => p.kind === "possible_duplicate").length, 0);
});

check("the same amount on different days is not a duplicate", () => {
  const led = mergeLedgers(
    [appRow({ date: "2026-03-05", deposit: 250000, balance: 250000, id: 1 })],
    [acctRow({ date: "2026-04-05", deposit: "2500.00", id: 2 })]
  );
  assert.strictEqual(led.problems.filter(p => p.kind === "possible_duplicate").length, 0);
});

// ── Reversals ──────────────────────────────────────────────

check("a reversed transaction stays visible and moves no money", () => {
  const led = mergeLedgers([
    appRow({ date: "2026-03-01", deposit: 100000, balance: 100000, id: 1 }),
    appRow({ date: "2026-03-02", withdraw: 50000, balance: 50000, id: 2, reversed: true }),
  ], []);
  assert.strictEqual(led.counts.total, 2, "the reversed row is history and stays on the ledger");
  assert.strictEqual(led.closing_balance_cents, 100000, "but it must not change the balance");
});

// ── Degenerate input ───────────────────────────────────────

check("no transactions is a zero balance, not a crash", () => {
  const led = mergeLedgers([], []);
  assert.strictEqual(led.counts.total, 0);
  assert.strictEqual(led.closing_balance_cents, 0);
  assert.deepStrictEqual(led.problems, []);
});

check("called with nothing at all it still answers", () => {
  const led = mergeLedgers();
  assert.strictEqual(led.counts.total, 0);
  assert.strictEqual(led.closing_balance_cents, 0);
});

check("an accounting row with no stored balance is not a mismatch", () => {
  // running_balance is nullable there; absent is not the same as wrong.
  const led = mergeLedgers([], [acctRow({ date: "2026-03-01", deposit: "100.00", balance: null, id: 1 })]);
  assert.strictEqual(led.problems.filter(p => p.kind === "balance_mismatch").length, 0);
  assert.strictEqual(led.closing_balance_cents, 10000);
});

// ── It writes nothing ──────────────────────────────────────

check("this module cannot write to the trust tables", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "trust-ledger.js"), "utf8");
  for (const forbidden of ["INSERT INTO", "UPDATE ", "DELETE FROM", "ALTER TABLE", "CREATE TABLE"]) {
    assert.ok(!src.includes(forbidden),
      `trust-ledger.js contains "${forbidden}" — it is a read of client trust money and must stay one. ` +
      "Merging the two ledgers for real means creating journal entries, which is a deliberate step.");
  }
});

console.log(`\n${passed} checks passed\n`);
