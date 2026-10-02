/**
 * check-accounting-companies.js
 *
 * The ledger now carries more than one set of books: Tez Law P.C. and a
 * separate business entity, posted side by side with a company_id on every
 * row. Two things about that are worth testing properly.
 *
 * THE FIRST IS RRC 1.15. Client trust money belongs to the law firm's books
 * and nowhere else. Commingling it into another entity's ledger is not a
 * reporting bug — it is the kind of error that ends a career, and it would be
 * invisible on screen because both entities render identically. So the guard
 * that refuses a trust line on a non-law-firm company is tested behaviourally
 * here, not read and assumed.
 *
 * THE SECOND IS THAT NOTHING HAD EVER POSTED. postJournalEntry built its
 * lines with `{ ...line, account_id: acct.id, account }` — object shorthand
 * for a variable that does not exist in that scope. Every single call threw
 * ReferenceError before reaching the INSERT, so the ledger this module exists
 * to maintain had never recorded one entry. It read as working: no errors
 * surfaced anywhere a human would see them, and an empty ledger looks exactly
 * like a ledger nobody has used yet. That is why there is a regression test
 * for one character.
 *
 * The migration is also checked for being safe to run twice, because it runs
 * at every boot against live tables and adds a NOT NULL column to them.
 *
 * Nothing here touches Postgres; db is stubbed and every query is recorded.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
require("./lib/stub-missing").install();

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const src = fs.readFileSync(path.join(ROOT, "accounting.js"), "utf8");

// ── The chart of accounts for a non-law-firm entity ────────────────────
console.log("the business chart of accounts");
{
  const coa = src.slice(src.indexOf("const BUSINESS_COA"), src.indexOf("];", src.indexOf("const BUSINESS_COA")));
  ok("carries no trust bank account", !/trust_bank/.test(coa));
  ok("carries no client trust liability", !/subtype: "trust"/.test(coa));
  ok("names no IOLTA account", !/IOLTA/i.test(coa));
  // The law firm's own accounts, by number. Neither may appear on the other
  // entity's books, so a plain number check is the clearest form of this.
  ok("does not include account 1020 (IOLTA cash)", !/"1020"/.test(coa));
  ok("does not include account 2010 (client trust liability)", !/"2010"/.test(coa));
}

// ── The typo that meant nothing ever posted ────────────────────────────
console.log("the ledger actually posts");
{
  const post = src.slice(src.indexOf("async function postJournalEntry"),
                         src.indexOf("// Insert entry"));
  ok("resolved lines carry the account OBJECT, not an undefined shorthand",
     /account:\s*acct\b/.test(post) && !/account_id: acct\.id,\s*account\s*[,}]/.test(post),
     "a bare `account` here is a ReferenceError on every call");
  // The thing that made it undetectable: a later line reads it back.
  ok("…and something downstream reads l.account, which is why it mattered",
     /\.account\.subtype/.test(src));
}

// ── Only one entity may ever hold client trust money ───────────────────
console.log("RRC 1.15");
{
  ok("there is a single law-firm entity accessor", /async function lawFirmCompany/.test(src));
  ok("the guard is reached from postJournalEntry",
     /if \(isTrust\)[\s\S]{0,400}lawFirmCompany\(\)/.test(src));
  ok("…and it throws rather than warning",
     /if \(isTrust\)[\s\S]{0,600}throw new Error/.test(src));
}

// ── The migration runs at every boot, against live tables ──────────────
console.log("the migration is safe to repeat");
{
  const mig = src.slice(src.indexOf("async function initTables"), src.indexOf("async function getAccountByNumber"));
  const creates = mig.match(/CREATE TABLE(?! IF NOT EXISTS)/g) || [];
  ok("every CREATE TABLE is IF NOT EXISTS", creates.length === 0, creates.join(", "));
  const addCols = mig.match(/ADD COLUMN(?! IF NOT EXISTS)/g) || [];
  ok("every ADD COLUMN is IF NOT EXISTS", addCols.length === 0, addCols.join(", "));
  const idx = mig.match(/CREATE (UNIQUE )?INDEX(?! IF NOT EXISTS)/g) || [];
  ok("every CREATE INDEX is IF NOT EXISTS", idx.length === 0, idx.join(", "));
  ok("dropping the old global unique constraints is IF EXISTS",
     !/DROP CONSTRAINT(?! IF EXISTS)/.test(mig));
  // Backfill must precede SET NOT NULL or the first boot after deploy fails
  // on every existing row.
  const backfill = mig.indexOf("SET company_id = $1 WHERE company_id IS NULL");
  const notNull = mig.indexOf("SET NOT NULL");
  ok("rows are backfilled before the column is made NOT NULL",
     backfill > 0 && notNull > backfill, "backfill@" + backfill + " notNull@" + notNull);
  const loop = mig.slice(mig.indexOf("ADD COLUMN IF NOT EXISTS company_id"));
  const block = loop.slice(0, loop.indexOf("}", loop.indexOf("console.warn")) + 1);
  ok("a failed migration warns rather than killing the boot",
     /catch/.test(block) && /console\.warn/.test(block) && !/throw/.test(block),
     block.replace(/\s+/g, " ").slice(0, 140));
}

// ── Uniqueness is now per company, not global ──────────────────────────
console.log("uniqueness is scoped to a company");
{
  ok("account numbers are unique per company",
     /UNIQUE INDEX[\s\S]{0,120}accounting_accounts \(company_id, account_number\)/.test(src));
  ok("invoice numbers are unique per company",
     /UNIQUE INDEX[\s\S]{0,120}accounting_invoices \(company_id, invoice_number\)/.test(src));
  ok("each company has at most one QuickBooks connection",
     /UNIQUE INDEX[\s\S]{0,120}accounting_qb_config \(company_id\)/.test(src));
}

// ── Existing callers must keep working ─────────────────────────────────
// server.js, qbo-sync.js and accounting-ui.js all call this module without a
// company_id. They have to keep landing on the law firm's books rather than
// throwing or, worse, silently posting to whichever company sorts first.
console.log("callers that pass no company");
{
  const resolve = src.slice(src.indexOf("async function companyIdOf"),
                            src.indexOf("async function createCompany"));
  ok("a missing company_id resolves to a default rather than null",
     /defaultCompany\(\)/.test(resolve), resolve.replace(/\s+/g, " ").slice(0, 120));
  // Not "the default company is the law firm" — the default is whatever the
  // switcher last selected, and it SHOULD be changeable. The rule is narrower
  // and more important: an omitted company_id means the firm regardless of
  // what is marked default, because every caller that omits it was written
  // when the firm was the only entity.
  ok("…and that default is the law firm, not whatever is flagged is_default",
     /lawFirmCompany\(\)/.test(resolve) &&
     resolve.indexOf("lawFirmCompany()") < resolve.indexOf("defaultCompany()"),
     resolve.replace(/\s+/g, " ").slice(0, 160));
}

// ── Behaviour: the guard refuses, against a stubbed database ───────────
console.log("the guard, exercised");

const FIRM = { id: 1, name: "Tez Law P.C.", is_law_firm: true };
const OTHER = { id: 2, name: "Other Business LLC", is_law_firm: false };
const queries = [];

const dbFile = require.resolve(path.join(ROOT, "db.js"));
require.cache[dbFile] = {
  id: dbFile, filename: dbFile, loaded: true, children: [], paths: [],
  exports: {
    query: async (sql, params) => {
      queries.push(String(sql).replace(/\s+/g, " ").trim());
      const q = String(sql);
      if (/FROM accounting_companies/.test(q)) {
        if (/is_law_firm/.test(q)) return { rows: [FIRM] };
        if (params && Number(params[0]) === OTHER.id) return { rows: [OTHER] };
        if (params && Number(params[0]) === FIRM.id) return { rows: [FIRM] };
        return { rows: [FIRM, OTHER] };
      }
      if (/FROM accounting_accounts/.test(q)) {
        // Pretend both entities somehow have the trust account, so the guard
        // is what refuses — not a missing row.
        return { rows: [{ id: 99, account_number: "1020", subtype: "trust_bank" }] };
      }
      if (/INSERT INTO accounting_journal_entries/.test(q)) return { rows: [{ id: 500 }] };
      return { rows: [] };
    },
  },
};

async function main() {
  const acct = require("../accounting");
  const trustLine = [
    { account_number: "1020", debit: 500, credit: 0 },
    { account_number: "2010", debit: 0, credit: 500 },
  ];

  let threw = null;
  try {
    await acct.postJournalEntry({
      entry_date: "2026-10-01", description: "Client retainer",
      lines: trustLine, company_id: OTHER.id,
    });
  } catch (e) { threw = e; }

  ok("a trust entry on the other entity is refused", !!threw,
     "it posted — client funds would be on the wrong entity's books");
  if (threw) {
    ok("…and the message names the entity it refused",
       /Other Business LLC/.test(threw.message), threw.message);
  }
  ok("…and nothing was written before it refused",
     !queries.some(q => /INSERT INTO accounting_journal_entries/.test(q)),
     queries.filter(q => /INSERT/.test(q)).join(" | "));

  console.log(failures ? "\n" + failures + " failed" : "\nall good");
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.log("  FAIL the check itself threw  → " + err.message);
  process.exit(1);
});
