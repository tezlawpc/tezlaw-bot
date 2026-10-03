#!/usr/bin/env node
/**
 * scripts/trust-ledger-audit.js
 *
 * READ ONLY. Writes nothing, creates nothing, migrates nothing. It answers
 * one question before Phase 0 touches any trust data: can the two trust
 * ledgers be merged, and what is in the way?
 *
 * WHY THERE ARE TWO
 *   trust_transactions      written only by app-api.js (the staff app).
 *                           Integer cents. Carries its own
 *                           running_balance_cents column.
 *   accounting_trust_ledger written only by accounting.postJournalEntry().
 *                           NUMERIC(14,2). Each row tied to a balanced
 *                           journal entry.
 * The admin reconciliation page reads the second. The app reads the first.
 * Neither can see the other. RRC 1.15(d)(3) requires a per-client ledger, and
 * two ledgers that disagree are worse than one.
 *
 * THE ORDERING TRAP THIS EXISTS TO FIND
 *   app-api.js derives each new running balance from
 *       ORDER BY id DESC LIMIT 1
 *   which is INSERTION order, not transaction_date order. A back-dated entry
 *   therefore takes its balance from whatever was keyed in most recently, not
 *   from what preceded it in time. An auditor reads a client ledger in date
 *   order. So if any client's rows were not entered in date order, the stored
 *   balances are right as an insertion log and wrong as a client ledger, and
 *   the migration must RECOMPUTE them rather than copy them across.
 *
 *   The same ordering is what the endpoint's overdraft guard tests against.
 *   A back-dated withdrawal can therefore pass that guard and still leave the
 *   date-ordered ledger below zero on some day in the past. Section 2 replays
 *   every client in date order to find exactly that.
 *
 * Run:  DATABASE_URL=... node scripts/trust-ledger-audit.js
 *       npm run audit:trust
 */

const db = require("../db");

const blockers = [];
const warnings = [];

const cents = c => "$" + (Number(c) / 100).toFixed(2);
const dollars = n => "$" + Number(n || 0).toFixed(2);
const day = d => (d ? new Date(d).toISOString().slice(0, 10) : "(no date)");

function h(title) {
  console.log("\n" + title);
  console.log("=".repeat(title.length));
}

async function tableExists(name) {
  const r = await db.query("SELECT to_regclass($1) AS t", [name]);
  return Boolean(r.rows[0] && r.rows[0].t);
}

// ---------------------------------------------------------------- section 1
// The app's ledger: totals, and whether the stored running balance agrees
// with the sum of the rows that produced it.
async function auditAppLedger() {
  h("1. trust_transactions (the staff app's ledger)");

  if (!(await tableExists("trust_transactions"))) {
    console.log("Table does not exist. Nothing to merge from this side.");
    return { rows: [], byClient: new Map() };
  }

  const summary = await db.query(`
    SELECT COUNT(*)::int AS n,
           COUNT(DISTINCT client_key)::int AS clients,
           MIN(transaction_date) AS lo,
           MAX(transaction_date) AS hi
      FROM trust_transactions`);
  const s = summary.rows[0];
  console.log(`rows: ${s.n}   clients: ${s.clients}   dates: ${day(s.lo)} to ${day(s.hi)}`);

  if (s.n === 0) {
    console.log("Empty. The merge has nothing to carry across from the app side.");
    return { rows: [], byClient: new Map() };
  }

  const all = await db.query(`
    SELECT id, client_key, txn_type, amount_cents, transaction_date,
           running_balance_cents, reversed_by_txn_id, category, description
      FROM trust_transactions
     ORDER BY client_key, id`);

  const byClient = new Map();
  for (const r of all.rows) {
    if (!byClient.has(r.client_key)) byClient.set(r.client_key, []);
    byClient.get(r.client_key).push(r);
  }

  let grand = 0;
  const mismatches = [];
  for (const [key, rows] of byClient) {
    // Computed in INSERTION order, which is what the app itself used.
    let bal = 0;
    for (const r of rows) {
      bal += r.txn_type === "deposit" ? r.amount_cents : -r.amount_cents;
    }
    const stored = rows[rows.length - 1].running_balance_cents;
    grand += bal;
    if (bal !== stored) {
      mismatches.push({ key, computed: bal, stored, rows: rows.length });
    }
  }

  console.log(`firm-wide trust balance (sum of all rows): ${cents(grand)}`);

  if (mismatches.length === 0) {
    console.log("Every client's stored running balance agrees with the sum of its rows.");
  } else {
    console.log(`\n${mismatches.length} client(s) whose stored balance disagrees with their own rows:`);
    for (const m of mismatches) {
      console.log(`  ${m.key}  stored ${cents(m.stored)}  computed ${cents(m.computed)}  (${m.rows} rows)`);
    }
    blockers.push(
      `${mismatches.length} client ledger(s) in trust_transactions do not sum to their stored ` +
      "running balance. Resolve which figure is correct before migrating; a merge would " +
      "otherwise carry the wrong number into the general ledger.");
  }

  return { rows: all.rows, byClient };
}

// ---------------------------------------------------------------- section 2
// Replay each client in DATE order. Two things matter: whether date order
// differs from insertion order at all, and whether the date-ordered balance
// ever goes below zero.
function auditOrdering(byClient) {
  h("2. Date order versus insertion order");

  if (byClient.size === 0) {
    console.log("No rows to replay.");
    return;
  }

  const reordered = [];
  const negatives = [];

  for (const [key, rows] of byClient) {
    const byDate = rows.slice().sort((a, b) => {
      const da = String(a.transaction_date || "");
      const dbb = String(b.transaction_date || "");
      if (da < dbb) return -1;
      if (da > dbb) return 1;
      return a.id - b.id;          // same day: fall back to insertion order
    });

    const differs = byDate.some((r, i) => r.id !== rows[i].id);
    if (differs) {
      const at = byDate.findIndex((r, i) => r.id !== rows[i].id);
      reordered.push({ key, at, id: byDate[at].id, date: day(byDate[at].transaction_date) });
    }

    let bal = 0;
    let low = 0;
    let lowAt = null;
    for (const r of byDate) {
      bal += r.txn_type === "deposit" ? r.amount_cents : -r.amount_cents;
      if (bal < low) { low = bal; lowAt = r; }
    }
    if (low < 0) {
      negatives.push({ key, low, date: day(lowAt.transaction_date), id: lowAt.id });
    }
  }

  if (reordered.length === 0) {
    console.log("Every client was entered in date order. Stored running balances are");
    console.log("valid as a date-ordered client ledger and can be carried across as they stand.");
  } else {
    console.log(`${reordered.length} client(s) have rows that were NOT entered in date order.`);
    console.log("For these, the stored running_balance_cents column is an insertion log, not");
    console.log("a client ledger. The migration must recompute in date order.\n");
    for (const r of reordered.slice(0, 20)) {
      console.log(`  ${r.key}  first divergence at position ${r.at} (txn #${r.id}, dated ${r.date})`);
    }
    if (reordered.length > 20) console.log(`  ... and ${reordered.length - 20} more`);
    warnings.push(
      `${reordered.length} client(s) have out-of-date-order rows. Recompute running balances ` +
      "during the migration instead of copying running_balance_cents.");
  }

  if (negatives.length === 0) {
    console.log("\nNo client goes below zero at any point when replayed in date order.");
  } else {
    console.log(`\n${negatives.length} client(s) go BELOW ZERO when replayed in date order:`);
    for (const n of negatives) {
      console.log(`  ${n.key}  low of ${cents(n.low)} on ${n.date} (txn #${n.id})`);
    }
    blockers.push(
      `${negatives.length} client trust ledger(s) go negative in date order. The app's own ` +
      "guard only tests insertion order, so a back-dated withdrawal can pass it. Under RRC 1.15 " +
      "a negative client balance means one client's funds paid another's disbursement. " +
      "Investigate each before migrating.");
  }
}

// ---------------------------------------------------------------- section 3
async function auditGlLedger() {
  h("3. accounting_trust_ledger (the general ledger's trust ledger)");

  if (!(await tableExists("accounting_trust_ledger"))) {
    console.log("Table does not exist.");
    return new Map();
  }

  const s = await db.query(`
    SELECT COUNT(*)::int AS n, COUNT(DISTINCT client_key)::int AS clients,
           MIN(transaction_date) AS lo, MAX(transaction_date) AS hi
      FROM accounting_trust_ledger`);
  const row = s.rows[0];
  console.log(`rows: ${row.n}   clients: ${row.clients}   dates: ${day(row.lo)} to ${day(row.hi)}`);

  if (row.n === 0) {
    console.log("Empty, as expected: postJournalEntry() threw on every call until the fix");
    console.log("earlier in this work, so nothing had ever posted. The merge is one-directional.");
    return new Map();
  }

  const per = await db.query(`
    SELECT client_key,
           COALESCE(SUM(deposit_amount), 0)  AS dep,
           COALESCE(SUM(disburse_amount), 0) AS dis
      FROM accounting_trust_ledger
     GROUP BY client_key ORDER BY client_key`);

  const m = new Map();
  let grand = 0;
  for (const r of per.rows) {
    const bal = Number(r.dep) - Number(r.dis);
    m.set(r.client_key, bal);
    grand += bal;
  }
  console.log(`firm-wide trust balance on this side: ${dollars(grand)}`);
  return m;
}

// ---------------------------------------------------------------- section 4
async function auditControlAccounts() {
  h("4. General ledger control accounts");

  if (!(await tableExists("accounting_accounts"))) {
    console.log("The accounting module has never run. No control accounts exist.");
    return;
  }

  let companyId = null;
  if (await tableExists("accounting_companies")) {
    const c = await db.query(
      "SELECT id, name FROM accounting_companies WHERE is_law_firm = TRUE ORDER BY id LIMIT 1");
    if (c.rows[0]) {
      companyId = c.rows[0].id;
      console.log(`law firm entity: ${c.rows[0].name} (id ${companyId})`);
    } else {
      warnings.push("No company is flagged is_law_firm. Trust reporting cannot resolve its books.");
      console.log("No company flagged is_law_firm.");
      return;
    }
  }

  const q = companyId
    ? `SELECT a.account_number, a.name, a.type,
              COALESCE(SUM(l.debit), 0) AS dr, COALESCE(SUM(l.credit), 0) AS cr
         FROM accounting_accounts a
         LEFT JOIN accounting_journal_lines l ON l.account_id = a.id
        WHERE a.company_id = $1 AND a.account_number IN ('1020', '2010')
        GROUP BY a.account_number, a.name, a.type
        ORDER BY a.account_number`
    : `SELECT a.account_number, a.name, a.type,
              COALESCE(SUM(l.debit), 0) AS dr, COALESCE(SUM(l.credit), 0) AS cr
         FROM accounting_accounts a
         LEFT JOIN accounting_journal_lines l ON l.account_id = a.id
        WHERE a.account_number IN ('1020', '2010')
        GROUP BY a.account_number, a.name, a.type
        ORDER BY a.account_number`;

  const r = companyId ? await db.query(q, [companyId]) : await db.query(q);

  if (r.rows.length === 0) {
    console.log("Neither 1020 (IOLTA) nor 2010 (Client Trust Liability) exists on these books.");
    blockers.push("The trust control accounts 1020 and 2010 are missing. Run initTables() first.");
    return;
  }

  for (const a of r.rows) {
    // An asset reads debit minus credit; a liability reads credit minus debit.
    const bal = a.type === "liability" ? Number(a.cr) - Number(a.dr) : Number(a.dr) - Number(a.cr);
    console.log(`  ${a.account_number}  ${a.name.padEnd(32)} ${dollars(bal)}`);
  }
  console.log("\nIf both read $0.00, no trust entry has ever posted to the general ledger,");
  console.log("which is the expected state before the merge.");
}

// ---------------------------------------------------------------- section 5
// The migration writes client_name into accounting_trust_ledger. Every
// client_key carrying money has to resolve to a name, and no key may be a
// merged alias that points somewhere else.
async function auditClientKeys(byClient) {
  h("5. Can every client_key be resolved?");

  const keys = [...byClient.keys()];
  if (keys.length === 0) { console.log("No keys to resolve."); return; }

  const named = new Map();
  if (await tableExists("client_dropbox_mapping")) {
    const r = await db.query(
      "SELECT client_key, client_name FROM client_dropbox_mapping WHERE client_key = ANY($1::text[])",
      [keys]);
    for (const x of r.rows) if (x.client_name) named.set(x.client_key, x.client_name);
  }
  if (await tableExists("client_accounts")) {
    const r = await db.query(
      "SELECT client_key, full_name FROM client_accounts WHERE client_key = ANY($1::text[])",
      [keys]);
    for (const x of r.rows) if (x.full_name && !named.has(x.client_key)) named.set(x.client_key, x.full_name);
  }
  if (await tableExists("pi_cases")) {
    const r = await db.query(
      "SELECT client_key, client_name FROM pi_cases WHERE client_key = ANY($1::text[])", [keys]);
    for (const x of r.rows) if (x.client_name && !named.has(x.client_key)) named.set(x.client_key, x.client_name);
  }

  const unresolved = keys.filter(k => !named.has(k));
  console.log(`${named.size} of ${keys.length} keys resolve to a client name.`);
  if (unresolved.length) {
    console.log("Unresolved:");
    for (const k of unresolved) {
      const bal = byClient.get(k).reduce(
        (a, r) => a + (r.txn_type === "deposit" ? r.amount_cents : -r.amount_cents), 0);
      console.log(`  ${k}   holding ${cents(bal)}`);
    }
    warnings.push(
      `${unresolved.length} client_key(s) holding trust money resolve to no name. ` +
      "They can migrate with the key as the name, but a trust ledger that names no client " +
      "is not a per-client ledger an auditor can read.");
  }

  // A key that was merged away still carries its rows.
  if (await tableExists("client_aliases")) {
    const r = await db.query(
      "SELECT alias_key, canonical_key, alias_name FROM client_aliases WHERE alias_key = ANY($1::text[])",
      [keys]);
    if (r.rows.length) {
      console.log(`\n${r.rows.length} key(s) holding trust money were merged into another client:`);
      for (const a of r.rows) {
        const bal = byClient.get(a.alias_key).reduce(
          (x, t) => x + (t.txn_type === "deposit" ? t.amount_cents : -t.amount_cents), 0);
        console.log(`  ${a.alias_key} -> ${a.canonical_key}   holding ${cents(bal)}`);
      }
      blockers.push(
        `${r.rows.length} merged alias key(s) still hold trust transactions. Migrating them as ` +
        "written would give one client two trust ledgers under different keys. Decide whether " +
        "to repoint them to the canonical key first.");
    } else {
      console.log("\nNo merged alias keys are holding trust money.");
    }
  }
}

// ---------------------------------------------------------------- section 6
function auditOverlap(byClient, glBalances) {
  h("6. Do the two ledgers overlap?");
  if (glBalances.size === 0) {
    console.log("The general ledger side is empty, so nothing can double-count.");
    console.log("Every app row migrates exactly once.");
    return;
  }
  const both = [...byClient.keys()].filter(k => glBalances.has(k));
  if (both.length === 0) {
    console.log("No client appears on both sides. Nothing can double-count.");
    return;
  }
  console.log(`${both.length} client(s) appear on BOTH sides:`);
  for (const k of both) {
    const app = byClient.get(k).reduce(
      (a, r) => a + (r.txn_type === "deposit" ? r.amount_cents : -r.amount_cents), 0);
    console.log(`  ${k}   app ${cents(app)}   ledger ${dollars(glBalances.get(k))}`);
  }
  blockers.push(
    `${both.length} client(s) hold balances in BOTH trust ledgers. A blind migration would ` +
    "double their trust liability. Each must be reconciled by hand first.");
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("Trust ledger audit — READ ONLY, nothing is written");
  console.log("run at " + new Date().toISOString());

  const { byClient } = await auditAppLedger();
  auditOrdering(byClient);
  const glBalances = await auditGlLedger();
  await auditControlAccounts();
  await auditClientKeys(byClient);
  auditOverlap(byClient, glBalances);

  h("Verdict");
  if (blockers.length === 0 && warnings.length === 0) {
    console.log("Clear. The two ledgers can be merged mechanically.");
  }
  if (blockers.length) {
    console.log(`${blockers.length} BLOCKER(S) — do not migrate until each is resolved:\n`);
    blockers.forEach((b, i) => console.log(`  ${i + 1}. ${b}\n`));
  }
  if (warnings.length) {
    console.log(`${warnings.length} thing(s) the migration must handle, but which do not block it:\n`);
    warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}\n`));
  }
  console.log("Nothing was written. Re-run this after any fix.");
}

main()
  .catch(err => { console.error("\naudit failed:", err.message); process.exitCode = 1; })
  .finally(async () => { try { await db.getPool().end(); } catch (_) {} });
