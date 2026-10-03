/**
 * check-qbo-account-mapping.js
 *
 * autoMapAccounts() used to fall back to a substring match on a truncated
 * name:
 *     shortName = ours.name.replace(/ - .+$/, "")    // "Cash - IOLTA Trust Account" -> "Cash"
 *     qb.Name.toLowerCase().includes(shortName)      // matches "Cash on hand"
 *
 * The October 3 reconnaissance of the firm's real realm showed exactly what
 * that would have done to live books: the IOLTA trust account mapped to petty
 * cash, the operating account mapped to the same target, and all seven
 * "Legal Fees - ..." income accounts collapsed onto whichever account matched
 * first. A trust account pointed at a firm account posts client money into
 * firm money, which is the one mapping error that cannot be allowed to
 * happen quietly.
 *
 * It never fired because nobody had pressed auto-map against production. That
 * is not a defence — it is why this file exists.
 *
 * WHY THE MATCHING IS A PURE FUNCTION. An earlier bug in this codebase hid
 * for three commits because the checks read source text while the code itself
 * was unreachable. So the logic lives in planAccountMappings(), the check
 * imports it through module.exports and runs it, and the fixture is the
 * firm's own account names rather than invented ones.
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
require("./lib/stub-missing").install();

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

// Stub db before anything requires it, or pg loads for real.
const dbFile = require.resolve(path.join(ROOT, "db.js"));
require.cache[dbFile] = {
  id: dbFile, filename: dbFile, loaded: true, children: [], paths: [],
  exports: { query: async () => ({ rows: [] }), getPool: () => ({ end: async () => {} }) },
};

const accounting = require(path.join(ROOT, "accounting.js"));
const qbo = require(path.join(ROOT, "qbo-sync.js"));

// ── reachability ───────────────────────────────────────────────────────────
ok("planAccountMappings is exported", typeof qbo.planAccountMappings === "function");
ok("normAccountName is exported", typeof qbo.normAccountName === "function");
ok("autoMapAccounts is still exported", typeof qbo.autoMapAccounts === "function");
if (typeof qbo.planAccountMappings !== "function") {
  console.log("\n  cannot continue without planAccountMappings");
  process.exit(1);
}

// ── the fixture is the firm's real chart, as the recon read it ─────────────
// Ids are positional; names and classifications are what QuickBooks returned
// on 2026-10-03, plus two income/expense accounts that make the collapse and
// the classification rule testable.
const REALM = [
  { Id: "1",  Name: "Cash on hand",                 Classification: "Asset",     AccountType: "Bank" },
  { Id: "2",  Name: "Checking",                     Classification: "Asset",     AccountType: "Bank" },
  { Id: "3",  Name: "Checking (0736)",              Classification: "Asset",     AccountType: "Bank" },
  { Id: "4",  Name: "QuickBooks Checking Account",  Classification: "Asset",     AccountType: "Bank" },
  { Id: "5",  Name: "TEZ ckg CIB 6526",             Classification: "Asset",     AccountType: "Bank" },
  { Id: "6",  Name: "TEZ Trust Account",            Classification: "Asset",     AccountType: "Bank" },
  { Id: "7",  Name: "Trust account CIB 6849",       Classification: "Asset",     AccountType: "Bank" },
  { Id: "8",  Name: "IOLTA Interest Payable",       Classification: "Liability", AccountType: "Other Current Liability" },
  { Id: "9",  Name: "Trust Accounts - Liabilities", Classification: "Liability", AccountType: "Other Current Liability" },
  { Id: "10", Name: "Legal Fees",                   Classification: "Revenue",   AccountType: "Income" },
  { Id: "11", Name: "Accounts Receivable",          Classification: "Asset",     AccountType: "Accounts Receivable" },
  { Id: "12", Name: "Rent",                         Classification: "Expense",   AccountType: "Expense" },
  // Same name, different classification. Only the class rule tells them apart.
  { Id: "13", Name: "Rent",                         Classification: "Asset",     AccountType: "Other Asset" },
];

const OURS = (accounting.DEFAULT_COA || []).map(a => ({
  account_number: a.number, name: a.name, type: a.type, subtype: a.subtype,
}));
ok("DEFAULT_COA is exported and non-empty", OURS.length > 0, `${OURS.length} accounts`);

const { mappings, report } = qbo.planAccountMappings(OURS, REALM, {});
const mappedBy = n => report.mapped.find(m => m.account_number === n);
const skipped = n => report.skipped_trust.some(s => s.account_number === n);

// ── rule 5: trust is never mapped automatically ────────────────────────────
const iolta = OURS.find(a => a.subtype === "trust_bank");
const trustLiab = OURS.find(a => a.subtype === "trust");
ok("an IOLTA/trust_bank account exists in the chart to protect", Boolean(iolta));
if (iolta) {
  ok("IOLTA trust account is never auto-mapped", skipped(iolta.account_number) && !mappedBy(iolta.account_number),
     JSON.stringify(mappedBy(iolta.account_number) || null));
}
if (trustLiab) {
  ok("client trust liability is never auto-mapped", skipped(trustLiab.account_number) && !mappedBy(trustLiab.account_number));
}

// ── the exact regression: nothing lands on petty cash ───────────────────────
const ontoCashOnHand = report.mapped.filter(m => m.qb_id === "1");
ok("nothing is mapped to 'Cash on hand'", ontoCashOnHand.length === 0,
   ontoCashOnHand.map(m => m.name).join(", "));

const operating = OURS.find(a => /operating/i.test(a.name) && a.type === "asset");
if (operating) {
  ok("operating cash is not substring-matched onto a bank account",
     !mappedBy(operating.account_number),
     JSON.stringify(mappedBy(operating.account_number) || null));
}

// ── rule 4: no QuickBooks account backs two of ours ────────────────────────
const ids = report.mapped.map(m => m.qb_id);
ok("no QuickBooks account is claimed twice", new Set(ids).size === ids.length,
   `${ids.length} mappings, ${new Set(ids).size} distinct targets`);

// ── the seven practice-area income accounts must not collapse ──────────────
const legalFees = OURS.filter(a => /^Legal Fees - /.test(a.name));
ok("the chart still has several 'Legal Fees - ...' accounts", legalFees.length >= 5, `${legalFees.length}`);
const collapsed = legalFees.filter(a => {
  const m = mappedBy(a.account_number);
  return m && m.qb_id === "10";
});
ok("no 'Legal Fees - ...' account collapses onto 'Legal Fees'", collapsed.length === 0,
   collapsed.map(a => a.name).join(", "));

// ── a true exact match still works; the fix is not "refuse everything" ─────
const ar = OURS.find(a => a.name === "Accounts Receivable");
if (ar) {
  const m = mappedBy(ar.account_number);
  ok("an exact name match still maps", m && m.qb_id === "11", JSON.stringify(m || null));
}

// ── rule 2: classification decides between two identical names ─────────────
const rent = OURS.find(a => a.name === "Rent");
if (rent) {
  const m = mappedBy(rent.account_number);
  ok("Rent maps to the Expense account, not the Asset of the same name",
     m && m.qb_id === "12", JSON.stringify(m || null));
}

// ── normalisation: noise collapses, distinct names do not ──────────────────
const n = qbo.normAccountName;
ok("'&' and 'and' normalise together", n("Meals & Entertainment") === n("meals and entertainment"));
ok("case and punctuation are noise", n("Accounts Receivable") === n("ACCOUNTS  RECEIVABLE."));
ok("distinct names stay distinct", n("Cash - Operating Account") !== n("Cash on hand"));
ok("a truncated name no longer matches a longer one",
   n("Cash - IOLTA Trust Account") !== n("Cash on hand"));

// ── idempotence: a second pass adds nothing and duplicates nothing ─────────
const second = qbo.planAccountMappings(OURS, REALM, mappings);
ok("re-running maps nothing new", second.report.matched === 0, `${second.report.matched}`);
ok("re-running does not change the mapping set",
   JSON.stringify(second.mappings) === JSON.stringify(mappings));

// ── whatever is not mapped is reported, not silently dropped ───────────────
const accountedFor =
  report.mapped.length + report.ambiguous.length + report.unmatched.length + report.skipped_trust.length;
ok("every account is either mapped or reported", accountedFor === OURS.length,
   `${accountedFor} of ${OURS.length}`);
ok("needs_manual is reported to the caller", typeof report.needs_manual === "number");

console.log(`\n  ${report.matched} mapped, ${report.ambiguous.length} ambiguous, ` +
            `${report.unmatched.length} unmatched, ${report.skipped_trust.length} trust accounts held back`);

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall checks passed");
