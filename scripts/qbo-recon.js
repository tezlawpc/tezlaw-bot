/**
 * scripts/qbo-recon.js
 *
 * READ ONLY. Issues nothing but SELECT queries against the connected
 * QuickBooks realm. Creates nothing, writes nothing, changes no setting.
 *
 * WHY THIS RUNS BEFORE PHASE 1
 * QuickBooks is the system of record for the firm's money. Phase 1 pulls from
 * it, which means the shape of the cache, the account mapping, and whether
 * practice areas can be tracked at all are all decided by what is already in
 * the realm. Guessing any of those produces a mapping that has to be redone
 * against live books. This answers them from the realm itself.
 *
 * SPECIFICALLY, IT SETTLES:
 *   - the subscription tier, by reading Preferences rather than inferring it.
 *     Class and Department exist only on Plus and Advanced. Without Class
 *     there is no practice-area reporting inside QuickBooks and it stays in
 *     tezlaw-bot.
 *   - whether a trust structure already exists: an IOLTA bank account, a
 *     trust liability parent, per-client sub-accounts. If it does, Phase 4
 *     maps onto it; if not, Phase 4 builds it.
 *   - how much history the realm holds, which decides the sync cutoff date.
 *   - whether anything is already namespaced, so the prefix the sync writes
 *     cannot collide with an existing convention.
 *
 * ON CLIENT NAMES
 * Per-client trust sub-accounts carry client names, and this output is meant
 * to be pasted into a chat. Leaf accounts under a trust parent are reported
 * by count and balance, never by name. Customer names are never printed at
 * all — only counts. Pass --names to override, which you should only do in a
 * terminal whose output is not leaving the firm.
 *
 * Run:  node scripts/qbo-recon.js
 *       npm run audit:qbo
 */

const qbo = require("../qbo-sync");
const accounting = require("../accounting");
const db = require("../db");

const SHOW_NAMES = process.argv.includes("--names");
const notes = [];

const money = n => "$" + Number(n || 0).toFixed(2);

function h(title) {
  console.log("\n" + title);
  console.log("=".repeat(title.length));
}

async function query(sql, cid) {
  const d = await qbo.qboRequest({ path: "/query", params: { query: sql }, company_id: cid });
  return (d && d.QueryResponse) || {};
}

async function tryQuery(label, sql, cid) {
  try {
    return await query(sql, cid);
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    console.log(`  ${label.padEnd(16)} unavailable - ${msg}`);
    return null;
  }
}

async function countOf(entity, cid) {
  const r = await tryQuery(entity, `SELECT COUNT(*) FROM ${entity}`, cid);
  if (!r) return null;
  return typeof r.totalCount === "number" ? r.totalCount : 0;
}

// ---------------------------------------------------------------- section 1
async function connection(cid) {
  h("1. Connection");
  const cfg = await qbo.getConfig(cid);
  if (!cfg || !cfg.realm_id) {
    console.log("No QuickBooks connection on these books. Connect first, then re-run.");
    return null;
  }
  console.log(`environment: ${cfg.environment || "(unset)"}`);
  console.log(`realm:       ${cfg.realm_id}`);

  const info = await qbo.fetchCompanyInfo(cid);
  if (info) {
    console.log(`company:     ${info.CompanyName || "(unnamed)"}`);
    if (info.LegalName && info.LegalName !== info.CompanyName) console.log(`legal name:  ${info.LegalName}`);
    console.log(`country:     ${info.Country || "(unset)"}`);
    console.log(`fiscal year starts: ${info.FiscalYearStartMonth || "(unset)"}`);
    if (info.CompanyStartDate) console.log(`books begin: ${info.CompanyStartDate}`);
  }
  if (String(cfg.environment) !== "production") {
    notes.push(
      "The stored environment is not 'production'. Everything below describes a sandbox " +
      "company, not the firm's real books. Reconnect against production before using any of it.");
  }
  return cfg;
}

// ---------------------------------------------------------------- section 2
// Tier, read from Preferences rather than guessed.
async function preferences(cid) {
  h("2. Subscription tier and tracking");
  const r = await tryQuery("Preferences", "SELECT * FROM Preferences", cid);
  const p = r && r.Preferences && r.Preferences[0];
  if (!p) { console.log("  could not read Preferences"); return; }

  const acct = p.AccountingInfoPrefs || {};
  const classOn = Boolean(acct.ClassTrackingPerTxn || acct.ClassTrackingPerTxnLine);
  const deptOn = Boolean(acct.TrackDepartments);

  console.log(`  class tracking:      ${classOn ? "ON" : "off"}`);
  console.log(`  department tracking: ${deptOn ? "ON" : "off"}  ${deptOn && acct.DepartmentTerminology ? "(" + acct.DepartmentTerminology + ")" : ""}`);
  if (acct.CustomerTerminology) console.log(`  customers are called: ${acct.CustomerTerminology}`);
  if (acct.FirstMonthOfFiscalYear) console.log(`  fiscal year starts:   ${acct.FirstMonthOfFiscalYear}`);
  if (acct.UseAccountNumbers !== undefined) console.log(`  account numbers:      ${acct.UseAccountNumbers ? "ON" : "off"}`);

  const classes = await countOf("Class", cid);
  if (classes === null) {
    console.log("  Class entity: not queryable, which means Simple Start or Essentials.");
    notes.push(
      "Class is unavailable, so practice-area reporting cannot live in QuickBooks. " +
      "It stays in tezlaw-bot, and matters carry a name prefix instead.");
  } else {
    console.log(`  existing classes:     ${classes}`);
    if (!classOn) {
      notes.push(
        "Class is available but class tracking is switched off. Turning it on is a settings " +
        "change in QuickBooks, not an API call, and it has to happen before practice areas " +
        "can be pushed.");
    }
  }

  if (acct.UseAccountNumbers === false) {
    notes.push(
      "Account numbers are switched off in QuickBooks, so accounts are identified by name only. " +
      "The mapping in accounting_accounts.qb_account_id must key on the QuickBooks Id, never " +
      "on a number that does not exist there.");
  }
}

// ---------------------------------------------------------------- section 3
async function chartOfAccounts(cid) {
  h("3. Chart of accounts");
  let accounts;
  try {
    accounts = await qbo.fetchQBOAccounts(cid);
  } catch (e) {
    console.log("  could not read accounts - " + String(e.message).slice(0, 160));
    return;
  }
  console.log(`  ${accounts.length} accounts`);

  const byType = new Map();
  for (const a of accounts) {
    const k = a.AccountType || "(none)";
    byType.set(k, (byType.get(k) || 0) + 1);
  }
  console.log("\n  by type:");
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${t}`);
  }

  // Which accounts look like trust, and which are children of one.
  const trustish = a => /trust|iolta|clta/i.test(String(a.Name) + " " + String(a.FullyQualifiedName || ""));
  const byId = new Map(accounts.map(a => [a.Id, a]));
  const parentIsTrust = a => {
    const pid = a.ParentRef && a.ParentRef.value;
    const parent = pid ? byId.get(pid) : null;
    return Boolean(parent && trustish(parent));
  };

  const banks = accounts.filter(a => a.AccountType === "Bank");
  console.log(`\n  bank accounts (${banks.length}):`);
  for (const b of banks) {
    console.log(`    ${b.Name}${trustish(b) ? "   <- looks like a trust account" : ""}   ${money(b.CurrentBalance)}`);
  }

  const trustParents = accounts.filter(a => trustish(a) && a.AccountType !== "Bank" && !parentIsTrust(a));
  if (trustParents.length === 0) {
    console.log("\n  No trust liability parent account exists.");
    notes.push(
      "There is no trust liability parent in the chart of accounts, so Phase 4 builds the " +
      "structure rather than mapping onto one: a liability parent, and a sub-account per client.");
  } else {
    console.log("\n  trust liability structure:");
    for (const p of trustParents) {
      const kids = accounts.filter(a => a.ParentRef && a.ParentRef.value === p.Id);
      console.log(`    ${p.Name}  (${p.AccountType})  ${money(p.CurrentBalance)}`);
      console.log(`      ${kids.length} sub-account(s)`);
      if (SHOW_NAMES) {
        for (const k of kids) console.log(`        ${k.Name}  ${money(k.CurrentBalance)}`);
      } else if (kids.length) {
        const sum = kids.reduce((s, k) => s + Number(k.CurrentBalance || 0), 0);
        console.log(`        names withheld; they sum to ${money(sum)}`);
        console.log("        (re-run with --names in a terminal, if you need them)");
      }
    }
  }

  const inactive = accounts.filter(a => a.Active === false).length;
  if (inactive) console.log(`\n  ${inactive} inactive account(s) - these still occupy their names`);
}

// ---------------------------------------------------------------- section 4
async function volumes(cid) {
  h("4. What the realm holds");
  const entities = [
    "Customer", "Vendor", "Item", "Employee",
    "Invoice", "Payment", "SalesReceipt", "CreditMemo",
    "Bill", "BillPayment", "Purchase", "Deposit",
    "JournalEntry", "TimeActivity", "Transfer",
  ];
  const got = {};
  for (const e of entities) {
    const n = await countOf(e, cid);
    if (n !== null) { got[e] = n; console.log(`  ${String(n).padStart(6)}  ${e}`); }
  }

  // Sub-customers are how matters will be represented. Count them without
  // printing any name.
  if (got.Customer !== undefined && got.Customer <= 1000) {
    const r = await tryQuery("Customer", "SELECT * FROM Customer MAXRESULTS 1000", cid);
    const list = (r && r.Customer) || [];
    const subs = list.filter(c => c.ParentRef).length;
    const jobs = list.filter(c => c.Job === true).length;
    console.log(`\n  of ${list.length} customers read, ${subs} are sub-customers and ${jobs} are flagged as jobs`);
    if (subs > 0) {
      notes.push(
        `${subs} sub-customer(s) already exist. Phase 2 must map onto them rather than ` +
        "creating duplicates, which means matching before creating, on name.");
    }
  } else if (got.Customer > 1000) {
    notes.push("More than 1000 customers. The customer read needs paging before Phase 2.");
  }

  if (got.Deposit > 0 || got.Purchase > 0) {
    console.log("\n  Deposits and purchases are present, which is consistent with an active bank feed.");
  }
  if (got.TimeActivity > 0) {
    notes.push(
      `${got.TimeActivity} TimeActivity record(s) already exist. Someone is entering time in ` +
      "QuickBooks. Phase 3 has to agree on who owns time entry before pushing any.");
  }
}

// ---------------------------------------------------------------- section 5
async function history(cid) {
  h("5. How much history");
  for (const e of ["Invoice", "Purchase", "JournalEntry"]) {
    const first = await tryQuery(e, `SELECT * FROM ${e} ORDER BY TxnDate ASC MAXRESULTS 1`, cid);
    const last = await tryQuery(e, `SELECT * FROM ${e} ORDER BY TxnDate DESC MAXRESULTS 1`, cid);
    const a = first && first[e] && first[e][0];
    const b = last && last[e] && last[e][0];
    if (a && b) console.log(`  ${e.padEnd(14)} ${a.TxnDate} to ${b.TxnDate}`);
    else console.log(`  ${e.padEnd(14)} none`);
  }
  console.log("\n  The sync cutoff should sit after the latest date above, so nothing already");
  console.log("  filed can be duplicated by a push.");
}

// ---------------------------------------------------------------- section 6
async function namespace(cid) {
  h("6. Namespace");
  for (const prefix of ["TEZ", "RM"]) {
    const r = await tryQuery("Customer", `SELECT COUNT(*) FROM Customer WHERE DisplayName LIKE '${prefix} %'`, cid);
    const n = r ? (r.totalCount || 0) : null;
    if (n !== null) console.log(`  customers named '${prefix} ...': ${n}`);
  }
  console.log("\n  A count of zero means the prefix is free for the sync to claim.");
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("QuickBooks reconnaissance - READ ONLY, nothing is written");
  console.log("run at " + new Date().toISOString());
  if (!SHOW_NAMES) console.log("client names withheld; pass --names to include them");

  const firm = await accounting.lawFirmCompany();
  if (!firm) { console.log("\nNo company is flagged is_law_firm. Nothing to query."); return; }
  console.log(`books: ${firm.name} (company ${firm.id})`);
  const cid = firm.id;

  const cfg = await connection(cid);
  if (!cfg) return;

  await preferences(cid);
  await chartOfAccounts(cid);
  await volumes(cid);
  await history(cid);
  await namespace(cid);

  h("What this changes");
  if (notes.length === 0) {
    console.log("Nothing unexpected. Phase 1 can be built against the plan as written.");
  } else {
    notes.forEach((n, i) => console.log(`  ${i + 1}. ${n}\n`));
  }
  console.log("Nothing was written to QuickBooks.");
}

main()
  .catch(err => { console.error("\nrecon failed:", err.message); process.exitCode = 1; })
  .finally(async () => { try { await db.getPool().end(); } catch (_) {} });
