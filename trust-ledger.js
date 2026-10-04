// ============================================================
//  trust-ledger.js — one client ledger, read from two tables
//  Tez Law P.C.
//
//  Client trust money is recorded in two places that cannot see each other:
//
//    trust_transactions       written by the staff app (app-api.js).
//                             Integer cents. Carries running_balance_cents.
//    accounting_trust_ledger  written by accounting.postJournalEntry().
//                             NUMERIC(14,2). Every row tied to a balanced
//                             journal entry.
//
//  The trust page reads the second; the app writes the first. So trust activity
//  staff record in the app does not appear on the trust page at all. RRC
//  1.15(d)(3) requires a per-client ledger, and a ledger that omits half the
//  transactions is worse than no ledger.
//
//  THIS MODULE WRITES NOTHING. It reads both tables and presents one ledger.
//  Actually merging them means creating journal entries for the app's rows —
//  real postings against the firm's books — and that is a decision taken
//  deliberately, with the numbers in view, not a side effect of opening a page.
//
//  TWO THINGS IT RECOMPUTES RATHER THAN TRUSTS
//
//  1. The running balance. app-api.js derives each new balance from
//         ORDER BY id DESC LIMIT 1
//     which is INSERTION order, not transaction_date order. A back-dated entry
//     therefore takes its balance from whatever was keyed in most recently
//     rather than from what precedes it in time. An auditor reads a client
//     ledger in date order, so the stored balances are correct as an insertion
//     log and wrong as a client ledger. Every balance here is recomputed in
//     date order, and any disagreement with the stored one is reported.
//
//  2. Whether the account ever went negative. The same ORDER BY is what the
//     app's overdraft guard tests against, so a back-dated withdrawal can pass
//     that guard and still leave the date-ordered ledger below zero on some day
//     in the past — a trust shortfall that no screen currently shows.
// ============================================================

const db = require("./db");

// Money is integer cents everywhere in here. NUMERIC(14,2) comes out of pg as a
// string; parseFloat then round, rather than multiplying a float by 100, which
// turns 10.15 into 1014.9999999999999.
function toCents(v) {
  if (v == null || v === "") return 0;
  return Math.round(parseFloat(v) * 100);
}

function fromCents(c) {
  return (Number(c) / 100).toFixed(2);
}

/**
 * One row, in the shape the page renders, whichever table it came from.
 * deposit_cents and disburse_cents are both non-negative; exactly one is set.
 */
function normaliseAppRow(r) {
  const amount = Math.abs(Number(r.amount_cents) || 0);
  const isDeposit = r.txn_type === "deposit";
  return {
    source: "app",
    id: r.id,
    client_key: r.client_key,
    date: r.transaction_date,
    description: r.description || "",
    memo: r.memo || null,
    reference: r.reference_number || null,
    deposit_cents: isDeposit ? amount : 0,
    disburse_cents: isDeposit ? 0 : amount,
    // The app stores its own balance, so it can be checked against ours.
    stored_balance_cents: Number(r.running_balance_cents),
    reversed: r.reversed_by_txn_id != null,
    created_at: r.created_at,
    entry_id: null,
  };
}

function normaliseAccountingRow(r) {
  return {
    source: "accounting",
    id: r.id,
    client_key: r.client_key,
    client_name: r.client_name || null,
    date: r.transaction_date,
    description: r.description || "",
    memo: null,
    reference: r.reference || null,
    deposit_cents: toCents(r.deposit_amount),
    disburse_cents: toCents(r.disburse_amount),
    stored_balance_cents: r.running_balance == null ? null : toCents(r.running_balance),
    reversed: false,
    created_at: r.created_at,
    entry_id: r.entry_id,
  };
}

function dayOf(d) {
  if (!d) return "";
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/**
 * Merge, order by date, and recompute.
 *
 * Ordering is transaction_date, then created_at, then source and id. The date
 * is what an auditor reads by; created_at breaks ties within a day across two
 * tables more faithfully than either table's id, which are independent
 * sequences and say nothing about each other.
 *
 * Pure: give it two arrays, get back the ledger. No database, no clock.
 */
function mergeLedgers(appRows = [], accountingRows = []) {
  const rows = [
    ...appRows.map(normaliseAppRow),
    ...accountingRows.map(normaliseAccountingRow),
  ];

  rows.sort((a, b) => {
    const da = dayOf(a.date), dbb = dayOf(b.date);
    if (da !== dbb) return da < dbb ? -1 : 1;
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (ca !== cb) return ca - cb;
    if (a.source !== b.source) return a.source < b.source ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });

  const problems = [];
  let balance = 0;
  let lowest = { cents: 0, date: null };

  for (const row of rows) {
    // A reversed transaction is history, not money: it stays visible in the
    // ledger and contributes nothing to the balance.
    if (!row.reversed) {
      balance += row.deposit_cents - row.disburse_cents;
    }
    row.computed_balance_cents = balance;

    if (row.stored_balance_cents != null && row.stored_balance_cents !== balance) {
      row.balance_mismatch_cents = balance - row.stored_balance_cents;
      problems.push({
        kind: "balance_mismatch",
        row_id: row.id,
        source: row.source,
        date: dayOf(row.date),
        stored: row.stored_balance_cents,
        computed: balance,
        detail: `${row.source} row ${row.id} stores a balance of $${fromCents(row.stored_balance_cents)}; ` +
                `in date order it is $${fromCents(balance)}. The stored figure was taken from the ` +
                `most recently entered row, not the preceding one.`,
      });
    }

    if (balance < lowest.cents) lowest = { cents: balance, date: dayOf(row.date) };
    if (balance < 0) {
      problems.push({
        kind: "negative_balance",
        row_id: row.id,
        source: row.source,
        date: dayOf(row.date),
        computed: balance,
        detail: `This client's trust balance is $${fromCents(balance)} on ${dayOf(row.date)}. ` +
                `A trust account may never go below zero for a client (RRC 1.15).`,
      });
    }
  }

  // The same deposit recorded in both places is the trap a merge has to avoid:
  // combined naively it doubles the client's money. Same day, same amount, same
  // direction, one from each table.
  for (const a of rows.filter(r => r.source === "app")) {
    for (const b of rows.filter(r => r.source === "accounting")) {
      if (dayOf(a.date) !== dayOf(b.date)) continue;
      if (a.deposit_cents !== b.deposit_cents) continue;
      if (a.disburse_cents !== b.disburse_cents) continue;
      if (a.deposit_cents === 0 && a.disburse_cents === 0) continue;
      problems.push({
        kind: "possible_duplicate",
        row_id: a.id,
        other_row_id: b.id,
        date: dayOf(a.date),
        detail: `App row ${a.id} and accounting row ${b.id} are the same amount on the same day. ` +
                `If they are the same transaction, combining the two ledgers would count it twice.`,
      });
    }
  }

  return {
    rows,
    closing_balance_cents: balance,
    lowest_balance_cents: lowest.cents,
    lowest_balance_date: lowest.date,
    problems,
    counts: {
      app: rows.filter(r => r.source === "app").length,
      accounting: rows.filter(r => r.source === "accounting").length,
      total: rows.length,
    },
  };
}

// ─── Reading ─────────────────────────────────────────
// Each table is read in its own try. One of them not existing yet — the
// accounting tables on an older database, say — must not take the whole
// ledger down; a half ledger clearly labelled beats an error page.

async function readAppRows(clientKey) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM trust_transactions
        ${clientKey ? "WHERE client_key = $1" : ""}
        ORDER BY transaction_date ASC, created_at ASC, id ASC`,
      clientKey ? [clientKey] : []
    );
    return { rows, error: null };
  } catch (e) {
    console.warn("[trust-ledger] trust_transactions unavailable:", e.message);
    return { rows: [], error: e.message };
  }
}

async function readAccountingRows(clientKey) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM accounting_trust_ledger
        ${clientKey ? "WHERE client_key = $1" : ""}
        ORDER BY transaction_date ASC, created_at ASC, id ASC`,
      clientKey ? [clientKey] : []
    );
    return { rows, error: null };
  } catch (e) {
    console.warn("[trust-ledger] accounting_trust_ledger unavailable:", e.message);
    return { rows: [], error: e.message };
  }
}

/** The full ledger for one client, from both tables. */
async function forClient(clientKey) {
  if (!clientKey) throw new Error("forClient needs a client key");
  const [app, acct] = await Promise.all([readAppRows(clientKey), readAccountingRows(clientKey)]);
  const out = mergeLedgers(app.rows, acct.rows);
  out.client_key = clientKey;
  out.sources = {
    app: { available: !app.error, error: app.error },
    accounting: { available: !acct.error, error: acct.error },
  };
  return out;
}

/**
 * Every client with trust activity, with the balance each one is actually owed.
 * The firm's total trust liability is the sum of these, and it has to equal the
 * IOLTA bank balance — which is the reconciliation RRC 1.15 requires.
 */
async function allClients() {
  const [app, acct] = await Promise.all([readAppRows(null), readAccountingRows(null)]);
  const keys = new Set([
    ...app.rows.map(r => r.client_key),
    ...acct.rows.map(r => r.client_key),
  ].filter(Boolean));

  const clients = [];
  let total = 0;
  const problems = [];

  for (const key of [...keys].sort()) {
    const led = mergeLedgers(
      app.rows.filter(r => r.client_key === key),
      acct.rows.filter(r => r.client_key === key)
    );
    total += led.closing_balance_cents;
    clients.push({
      client_key: key,
      client_name: led.rows.find(r => r.client_name)?.client_name || null,
      balance_cents: led.closing_balance_cents,
      lowest_balance_cents: led.lowest_balance_cents,
      lowest_balance_date: led.lowest_balance_date,
      transactions: led.counts.total,
      counts: led.counts,
      problem_count: led.problems.length,
    });
    for (const p of led.problems) problems.push({ ...p, client_key: key });
  }

  return {
    clients,
    total_liability_cents: total,
    problems,
    sources: {
      app: { available: !app.error, error: app.error, rows: app.rows.length },
      accounting: { available: !acct.error, error: acct.error, rows: acct.rows.length },
    },
  };
}

module.exports = {
  forClient,
  allClients,
  // Pure, so the checks can exercise the real ordering and balance logic
  // without a database. The bugs this guards against are invisible to a
  // source scan and only appear once rows are out of date order.
  mergeLedgers,
  toCents,
  fromCents,
};
