// ============================================================
//  TEZ LAW P.C. — ACCOUNTING MODULE
//  ─────────────────────────────────────────────────────────
//  Double-entry ledger with CA Bar RRC 1.15-compliant trust
//  (IOLTA) accounting. Auto-syncs from PI disbursements +
//  case costs. Exports to Excel, IIF (QuickBooks Desktop),
//  and CSV (QuickBooks Online).
//
//  Key concepts:
//   - Every transaction has a debit + credit that must balance
//   - Trust accounts are SEPARATE from operating (never mixed)
//   - Per-client trust ledgers (required by CA Bar)
//   - Standard law firm chart of accounts (seeded on init)
//
//  QuickBooks integration options:
//   1. IIF file — Desktop imports natively (File → Utilities → Import → IIF)
//   2. CSV file — QBO imports via Banking → Upload transactions
//   3. Live sync via QBO API — Phase 2 (requires OAuth setup)
//
//  Trust compliance rules enforced:
//   - Trust deposits credit "Client Trust Liability" and debit "IOLTA Trust"
//   - Never post trust money to a revenue account
//   - Each client's trust balance is queryable independently
//   - Trust reconciliation report shows: bank balance = sum of client ledgers
// ============================================================

const db = require("./db");

// ─── Standard law firm chart of accounts ────────────────
// Seeded on init. account_number is standard 4-digit + suffix.

const DEFAULT_COA = [
  // ─ Assets (1000s) ─
  { number: "1010", name: "Cash - Operating Account",     type: "asset",     subtype: "bank" },
  { number: "1020", name: "Cash - IOLTA Trust Account",   type: "asset",     subtype: "trust_bank" },
  { number: "1100", name: "Accounts Receivable",          type: "asset",     subtype: "ar" },
  { number: "1200", name: "Case Costs Advanced",          type: "asset",     subtype: "advance" },
  { number: "1500", name: "Office Equipment",             type: "asset",     subtype: "fixed" },

  // ─ Liabilities (2000s) ─
  { number: "2010", name: "Client Trust Liability",       type: "liability", subtype: "trust" },
  { number: "2100", name: "Accounts Payable",             type: "liability", subtype: "ap" },
  { number: "2200", name: "Referral Fees Payable",        type: "liability", subtype: "ap" },
  { number: "2300", name: "Medical Liens Payable",        type: "liability", subtype: "ap" },
  { number: "2400", name: "Payroll Liabilities",          type: "liability", subtype: "payroll" },

  // ─ Equity (3000s) ─
  { number: "3000", name: "Owner's Equity",               type: "equity",    subtype: "equity" },
  { number: "3100", name: "Retained Earnings",            type: "equity",    subtype: "equity" },
  { number: "3900", name: "Owner's Draw",                 type: "equity",    subtype: "draw" },

  // ─ Revenue (4000s) — by practice area ─
  { number: "4010", name: "Legal Fees - Immigration",      type: "revenue",   subtype: "fee_income" },
  { number: "4020", name: "Legal Fees - Personal Injury",  type: "revenue",   subtype: "fee_income" },
  { number: "4030", name: "Legal Fees - Business Litigation", type: "revenue", subtype: "fee_income" },
  { number: "4040", name: "Legal Fees - Landlord/Tenant",  type: "revenue",   subtype: "fee_income" },
  { number: "4050", name: "Legal Fees - Estate Planning",  type: "revenue",   subtype: "fee_income" },
  { number: "4060", name: "Legal Fees - Trademarks/Patents", type: "revenue", subtype: "fee_income" },
  { number: "4070", name: "Legal Fees - Real Estate",      type: "revenue",   subtype: "fee_income" },
  { number: "4200", name: "Referral Income",               type: "revenue",   subtype: "other_income" },
  { number: "4900", name: "Miscellaneous Income",          type: "revenue",   subtype: "other_income" },

  // ─ Expenses (5000s / 6000s) ─
  { number: "5010", name: "Salaries & Wages",              type: "expense",   subtype: "operating" },
  { number: "5020", name: "Payroll Taxes",                 type: "expense",   subtype: "operating" },
  { number: "5030", name: "Contractor Payments",           type: "expense",   subtype: "operating" },
  { number: "5040", name: "Referral Fees Paid",            type: "expense",   subtype: "operating" },
  { number: "6010", name: "Rent",                          type: "expense",   subtype: "operating" },
  { number: "6020", name: "Utilities",                     type: "expense",   subtype: "operating" },
  { number: "6030", name: "Office Supplies",               type: "expense",   subtype: "operating" },
  { number: "6040", name: "Software & Subscriptions",      type: "expense",   subtype: "operating" },
  { number: "6050", name: "Marketing & Advertising",       type: "expense",   subtype: "operating" },
  { number: "6060", name: "Continuing Legal Education",    type: "expense",   subtype: "operating" },
  { number: "6070", name: "Malpractice Insurance",         type: "expense",   subtype: "operating" },
  { number: "6080", name: "Bar Dues & Licenses",           type: "expense",   subtype: "operating" },
  { number: "6090", name: "Professional Services (Accounting, Legal)", type: "expense", subtype: "operating" },
  { number: "6100", name: "Bank Fees",                     type: "expense",   subtype: "operating" },
  { number: "6200", name: "Meals & Entertainment",         type: "expense",   subtype: "operating" },
  { number: "6300", name: "Travel",                        type: "expense",   subtype: "operating" },
  { number: "6900", name: "Miscellaneous Expenses",        type: "expense",   subtype: "operating" },
];

// ─── A second set of books is not a law firm ────────────
//
//  JJ runs more than one business, and the second QuickBooks company is a
//  separate entity with its own books — not a mirror of the firm's.
//
//  It deliberately does NOT get:
//    · 1020 Cash - IOLTA Trust Account
//    · 2010 Client Trust Liability
//  Client trust money belongs to the law firm and nowhere else (RRC 1.15).
//  Leaving those accounts off a non-law-firm entity means a trust entry
//  cannot be posted there even by accident — there is no account to post to.
//  It also drops the practice-area fee lines and the bar dues / malpractice
//  expenses, which mean nothing outside the firm.

const BUSINESS_COA = [
  // ─ Assets ─
  { number: "1010", name: "Cash - Operating Account",     type: "asset",     subtype: "bank" },
  { number: "1100", name: "Accounts Receivable",          type: "asset",     subtype: "ar" },
  { number: "1500", name: "Equipment",                    type: "asset",     subtype: "fixed" },

  // ─ Liabilities ─
  { number: "2100", name: "Accounts Payable",             type: "liability", subtype: "ap" },
  { number: "2400", name: "Payroll Liabilities",          type: "liability", subtype: "payroll" },

  // ─ Equity ─
  { number: "3000", name: "Owner's Equity",               type: "equity",    subtype: "equity" },
  { number: "3100", name: "Retained Earnings",            type: "equity",    subtype: "equity" },
  { number: "3900", name: "Owner's Draw",                 type: "equity",    subtype: "draw" },

  // ─ Revenue ─
  { number: "4100", name: "Sales / Service Revenue",      type: "revenue",   subtype: "other_income" },
  { number: "4200", name: "Commission Income",            type: "revenue",   subtype: "other_income" },
  { number: "4900", name: "Miscellaneous Income",         type: "revenue",   subtype: "other_income" },

  // ─ Expenses ─
  { number: "5010", name: "Salaries & Wages",             type: "expense",   subtype: "operating" },
  { number: "5020", name: "Payroll Taxes",                type: "expense",   subtype: "operating" },
  { number: "5030", name: "Contractor Payments",          type: "expense",   subtype: "operating" },
  { number: "6010", name: "Rent",                         type: "expense",   subtype: "operating" },
  { number: "6020", name: "Utilities",                    type: "expense",   subtype: "operating" },
  { number: "6030", name: "Office Supplies",              type: "expense",   subtype: "operating" },
  { number: "6040", name: "Software & Subscriptions",     type: "expense",   subtype: "operating" },
  { number: "6050", name: "Marketing & Advertising",      type: "expense",   subtype: "operating" },
  { number: "6090", name: "Professional Services (Accounting, Legal)", type: "expense", subtype: "operating" },
  { number: "6100", name: "Bank Fees",                    type: "expense",   subtype: "operating" },
  { number: "6200", name: "Meals & Entertainment",        type: "expense",   subtype: "operating" },
  { number: "6300", name: "Travel",                       type: "expense",   subtype: "operating" },
  { number: "6900", name: "Miscellaneous Expenses",       type: "expense",   subtype: "operating" },
];

// ─── Companies (entities) ───────────────────────────────
//
//  Every account, entry, invoice and QuickBooks connection belongs to exactly
//  one company. The law firm is seeded first and is the default, so anything
//  written without naming a company lands on the firm's books — which is what
//  every caller written before this existed intends.

async function listCompanies({ includeInactive = false } = {}) {
  const r = await db.query(
    `SELECT * FROM accounting_companies ${includeInactive ? "" : "WHERE is_active"}
      ORDER BY is_default DESC, name`);
  return r.rows;
}

async function getCompany(id) {
  if (!id) return await defaultCompany();
  const r = await db.query(`SELECT * FROM accounting_companies WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function defaultCompany() {
  const r = await db.query(
    `SELECT * FROM accounting_companies ORDER BY is_default DESC, id ASC LIMIT 1`);
  return r.rows[0] || null;
}

/** The entity whose books may hold client trust money. There is only ever one. */
async function lawFirmCompany() {
  const r = await db.query(
    `SELECT * FROM accounting_companies WHERE is_law_firm ORDER BY id ASC LIMIT 1`);
  return r.rows[0] || null;
}

/**
 * Resolve whatever a caller passed into a company id.
 * Callers that predate this feature pass nothing and get the firm.
 */
/**
 * Which books an operation belongs to.
 *
 * AN OMITTED company_id MEANS THE LAW FIRM, deliberately — not whichever
 * company is flagged default. Every caller in server.js, qbo-sync.js and
 * accounting-ui.js predates there being a second entity, so each of them
 * omits this argument and every one of them means Tez Law P.C. Resolving to
 * the default instead would mean that the moment the business entity is
 * marked default in the switcher, all of that existing code silently starts
 * posting fee income and invoices to the wrong company's books. Trust lines
 * would at least be refused by the RRC 1.15 guard; ordinary revenue would
 * not, and nothing on screen would look wrong.
 *
 * So: the default company governs what the UI shows first. It does not
 * govern where unlabelled writes land. New code that means the other entity
 * passes company_id explicitly.
 */
async function companyIdOf(company_id) {
  if (company_id) return Number(company_id);
  const firm = await lawFirmCompany();
  if (firm) return firm.id;
  // No law firm on the books at all — a fresh install mid-migration. Fall
  // back rather than throwing, so a first boot can still seed itself.
  const d = await defaultCompany();
  if (!d) throw new Error("No accounting company exists — run initTables()");
  return d.id;
}

/**
 * Add a second (or third) set of books.
 * is_law_firm is deliberately not a parameter: there is one law firm, it is
 * seeded at init, and a second one would mean two trust ledgers.
 */
async function createCompany({ name, slug = null, seed_coa = true }) {
  await initTables();
  const clean = String(name || "").trim();
  if (!clean) throw new Error("A company needs a name");
  const key = String(slug || clean).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  if (!key) throw new Error("A company needs a usable short name");

  const existing = await db.query(`SELECT * FROM accounting_companies WHERE slug = $1`, [key]);
  if (existing.rows[0]) return existing.rows[0];

  const r = await db.query(
    `INSERT INTO accounting_companies (name, slug, is_law_firm, is_default)
     VALUES ($1, $2, FALSE, FALSE) RETURNING *`, [clean, key]);
  const company = r.rows[0];
  if (seed_coa) await seedCOA(company.id, BUSINESS_COA);
  return company;
}

async function seedCOA(companyId, coa) {
  for (const acct of coa) {
    await db.query(
      `INSERT INTO accounting_accounts (company_id, account_number, name, type, subtype)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, account_number) DO NOTHING`,
      [companyId, acct.number, acct.name, acct.type, acct.subtype]);
  }
}

// ─── Schema ─────────────────────────────────────────────

async function initTables() {
  // The entity every other row belongs to. Created first: everything below
  // carries a company_id that points here.
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_companies (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT UNIQUE NOT NULL,
      is_law_firm BOOLEAN DEFAULT FALSE,   -- only this one may hold client trust money
      is_default  BOOLEAN DEFAULT FALSE,
      is_active   BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const haveCompanies = await db.query(`SELECT COUNT(*)::int AS n FROM accounting_companies`);
  if (haveCompanies.rows[0].n === 0) {
    await db.query(
      `INSERT INTO accounting_companies (name, slug, is_law_firm, is_default)
       VALUES ($1, 'tez-law', TRUE, TRUE)`,
      [process.env.FIRM_NAME || "Tez Law P.C."]);
  }

  // Chart of accounts
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_accounts (
      id             SERIAL PRIMARY KEY,
      account_number TEXT NOT NULL,          -- unique PER COMPANY, see the index below
      name           TEXT NOT NULL,
      type           TEXT NOT NULL,           -- asset | liability | equity | revenue | expense
      subtype        TEXT,                    -- bank | trust_bank | trust | fee_income | operating | etc.
      is_active      BOOLEAN DEFAULT TRUE,
      description    TEXT,
      qb_account_id  TEXT,                    -- for QBO sync (Phase 2)
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Journal entries (double-entry — every entry has matching debit and credit lines)
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_journal_entries (
      id              SERIAL PRIMARY KEY,
      entry_date      DATE NOT NULL,
      description     TEXT NOT NULL,
      reference       TEXT,                    -- invoice #, check #, receipt #, etc.
      source_module   TEXT,                    -- 'pi', 'manual', 'time_tracking', etc.
      source_id       INTEGER,                 -- id in source table
      client_key      TEXT,                    -- links to a client if applicable
      client_name     TEXT,
      matter_type     TEXT,                    -- immigration | pi | business | ll_tenant | estate | tm
      is_trust        BOOLEAN DEFAULT FALSE,   -- true if any line touches trust accounts
      is_posted       BOOLEAN DEFAULT TRUE,    -- false = draft
      is_reconciled   BOOLEAN DEFAULT FALSE,
      reconciled_date DATE,
      qb_txn_id       TEXT,                    -- for QBO sync
      qb_synced_at    TIMESTAMPTZ,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Journal lines (each entry has 2+ lines; sum of debits = sum of credits)
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_journal_lines (
      id           SERIAL PRIMARY KEY,
      entry_id     INTEGER NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE CASCADE,
      account_id   INTEGER NOT NULL REFERENCES accounting_accounts(id),
      debit        NUMERIC(14,2) DEFAULT 0,
      credit       NUMERIC(14,2) DEFAULT 0,
      memo         TEXT,
      line_number  INTEGER,
      CHECK (debit >= 0 AND credit >= 0),
      CHECK (NOT (debit > 0 AND credit > 0))    -- a line is either debit or credit, not both
    )
  `);

  // Client trust ledger — mandatory per client (CA Bar RRC 1.15)
  // This is a materialized view of trust-related journal lines, indexed by client
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_trust_ledger (
      id             SERIAL PRIMARY KEY,
      entry_id       INTEGER NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE CASCADE,
      client_key     TEXT NOT NULL,
      client_name    TEXT,
      matter_type    TEXT,
      transaction_date DATE NOT NULL,
      description    TEXT,
      deposit_amount NUMERIC(14,2) DEFAULT 0,  -- money IN to trust for this client
      disburse_amount NUMERIC(14,2) DEFAULT 0, -- money OUT of trust for this client
      running_balance NUMERIC(14,2),           -- calculated at insert time
      reference      TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Invoices (for hourly / retainer matters — not needed for contingency)
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_invoices (
      id             SERIAL PRIMARY KEY,
      invoice_number TEXT NOT NULL,          -- unique PER COMPANY, see the index below
      client_key     TEXT,
      client_name    TEXT NOT NULL,
      matter_type    TEXT,
      invoice_date   DATE NOT NULL,
      due_date       DATE,
      subtotal       NUMERIC(14,2) DEFAULT 0,
      tax_amount     NUMERIC(14,2) DEFAULT 0,
      total_amount   NUMERIC(14,2) NOT NULL,
      amount_paid    NUMERIC(14,2) DEFAULT 0,
      status         TEXT DEFAULT 'draft',    -- draft | sent | partial | paid | void
      line_items     JSONB DEFAULT '[]'::jsonb,
      notes          TEXT,
      journal_entry_id INTEGER REFERENCES accounting_journal_entries(id),
      pdf_path       TEXT,
      created_by     INTEGER,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // QuickBooks connection config (Phase 2 will populate this)
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_qb_config (
      id                    SERIAL PRIMARY KEY,
      realm_id              TEXT,                -- QBO company ID
      access_token          TEXT,
      refresh_token         TEXT,
      token_expires_at      TIMESTAMPTZ,
      last_sync_at          TIMESTAMPTZ,
      environment           TEXT DEFAULT 'sandbox', -- sandbox | production
      account_mappings      JSONB DEFAULT '{}'::jsonb, -- our_account_id → qb_account_id
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Indexes
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_date ON accounting_journal_entries (entry_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_client ON accounting_journal_entries (client_key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_source ON accounting_journal_entries (source_module, source_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON accounting_journal_lines (entry_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON accounting_journal_lines (account_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_trust_ledger_client ON accounting_trust_ledger (client_key, transaction_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON accounting_invoices (status, invoice_date DESC)`);

  // ── Entity migration ──────────────────────────────────
  //
  //  These tables predate companies. Every existing row is the law firm's —
  //  there was nowhere else for it to be — so it is backfilled to the firm
  //  and the column is then required. Idempotent: safe to run on every boot.
  const firm = (await lawFirmCompany()) || (await defaultCompany());
  const OWNED = [
    "accounting_accounts",
    "accounting_journal_entries",
    "accounting_invoices",
    "accounting_trust_ledger",
    "accounting_qb_config",
  ];
  for (const t of OWNED) {
    try {
      await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES accounting_companies(id)`);
      await db.query(`UPDATE ${t} SET company_id = $1 WHERE company_id IS NULL`, [firm.id]);
      await db.query(`ALTER TABLE ${t} ALTER COLUMN company_id SET NOT NULL`);
    } catch (e) {
      // SET NOT NULL is the only step here that can fail on a live table, and
      // only if a row could not be backfilled. Say so rather than boot silently
      // with a half-migrated ledger.
      console.warn(`[accounting] company_id migration on ${t}:`, e.message);
    }
  }

  // Account and invoice numbers are unique WITHIN a company, not globally —
  // both sets of books number their cash account 1010. The old global
  // constraints are dropped; on a fresh install they were never created.
  for (const drop of [
    "ALTER TABLE accounting_accounts DROP CONSTRAINT IF EXISTS accounting_accounts_account_number_key",
    "ALTER TABLE accounting_invoices DROP CONSTRAINT IF EXISTS accounting_invoices_invoice_number_key",
  ]) { try { await db.query(drop); } catch (e) { console.warn("[accounting] drop constraint:", e.message); } }

  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounting_accounts_company_number
                    ON accounting_accounts (company_id, account_number)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounting_invoices_company_number
                    ON accounting_invoices (company_id, invoice_number)`);
  // One QuickBooks connection per company, and one company per QuickBooks
  // realm — otherwise two sets of books could push into the same QBO file.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounting_qb_config_company
                    ON accounting_qb_config (company_id)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounting_qb_config_realm
                    ON accounting_qb_config (realm_id, environment) WHERE realm_id IS NOT NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_journal_company ON accounting_journal_entries (company_id, entry_date DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounting_accounts (company_id, account_number)`);

  // Seed the firm's chart of accounts if it has none.
  const existing = await db.query(
    `SELECT COUNT(*) as n FROM accounting_accounts WHERE company_id = $1`, [firm.id]);
  if (Number(existing.rows[0].n) === 0) await seedCOA(firm.id, DEFAULT_COA);
}

// ─── Account lookups ────────────────────────────────────

// An account number means nothing on its own now — both sets of books have a
// 1010. Callers that pass no company get the firm, which is what every caller
// written before companies existed meant.
async function getAccountByNumber(number, company_id = null) {
  const cid = await companyIdOf(company_id);
  const r = await db.query(
    `SELECT * FROM accounting_accounts WHERE company_id = $1 AND account_number = $2`,
    [cid, String(number)]);
  return r.rows[0] || null;
}

async function getAccountById(id) {
  const r = await db.query(`SELECT * FROM accounting_accounts WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function listAccounts(company_id = null) {
  const cid = await companyIdOf(company_id);
  const r = await db.query(
    `SELECT * FROM accounting_accounts WHERE company_id = $1 AND is_active ORDER BY account_number`,
    [cid]);
  return r.rows;
}

async function ensureAccount({ number, name, type, subtype = null, company_id = null }) {
  const cid = await companyIdOf(company_id);
  const existing = await getAccountByNumber(number, cid);
  if (existing) return existing;
  const r = await db.query(
    `INSERT INTO accounting_accounts (company_id, account_number, name, type, subtype)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [cid, String(number), name, type, subtype]
  );
  return r.rows[0];
}

// ─── Core: post a double-entry journal ──────────────────
// lines = [{ account_number, debit, credit, memo }, ...]
// Sum of debits MUST equal sum of credits (or throws).

async function postJournalEntry({
  entry_date,
  description,
  reference = null,
  source_module = "manual",
  source_id = null,
  client_key = null,
  client_name = null,
  matter_type = null,
  lines = [],
  created_by = null,
  company_id = null,
}) {
  await initTables();
  const cid = await companyIdOf(company_id);

  if (!lines.length || lines.length < 2) {
    throw new Error("Journal entry requires at least 2 lines (debit + credit)");
  }

  // Validate: sum of debits = sum of credits
  const totalDebits = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredits = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  if (Math.abs(totalDebits - totalCredits) > 0.01) {
    throw new Error(`Journal entry unbalanced: debits ${totalDebits.toFixed(2)} vs credits ${totalCredits.toFixed(2)}`);
  }

  // Resolve account numbers → IDs, detect trust involvement
  const resolvedLines = [];
  let isTrust = false;
  for (const line of lines) {
    const acct = await getAccountByNumber(line.account_number, cid);
    if (!acct) throw new Error(`Account not found on this company's books: ${line.account_number}`);
    if (acct.subtype === "trust_bank" || acct.subtype === "trust") isTrust = true;
    // `account: acct`, not `account`. The shorthand was a typo for a variable
    // that does not exist in this scope, so every call threw ReferenceError
    // before inserting anything — nothing had ever posted to this ledger.
    // Line 317 below reads l.account.subtype, which is what it was meant to be.
    resolvedLines.push({ ...line, account_id: acct.id, account: acct });
  }

  // Client trust money belongs to the law firm's books (RRC 1.15). A second
  // entity has no trust accounts at all, so this should be unreachable — it is
  // here because "should be unreachable" is not a control, and commingling
  // across entities is the kind of error that ends careers rather than
  // producing a bad report.
  if (isTrust) {
    const firm = await lawFirmCompany();
    if (!firm || firm.id !== cid) {
      const co = await getCompany(cid);
      throw new Error(
        `Trust accounts belong to the law firm's books only — refusing to post a trust entry to ${co ? co.name : "company " + cid}`);
    }
  }

  // Insert entry
  const entryR = await db.query(
    `INSERT INTO accounting_journal_entries
       (company_id, entry_date, description, reference, source_module, source_id,
        client_key, client_name, matter_type, is_trust, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [cid, entry_date, description, reference, source_module, source_id,
     client_key, client_name, matter_type, isTrust, created_by]
  );
  const entryId = entryR.rows[0].id;

  // Insert lines
  for (let i = 0; i < resolvedLines.length; i++) {
    const l = resolvedLines[i];
    await db.query(
      `INSERT INTO accounting_journal_lines
         (entry_id, account_id, debit, credit, memo, line_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [entryId, l.account_id, Number(l.debit || 0), Number(l.credit || 0), l.memo || null, i + 1]
    );
  }

  // If trust: also create per-client trust ledger entry
  if (isTrust && client_key) {
    // Determine deposit vs disbursement:
    //  - Deposit: cash goes INTO the trust bank (debit trust bank)
    //  - Disburse: cash goes OUT of the trust bank (credit trust bank)
    let deposit = 0, disburse = 0;
    for (const l of resolvedLines) {
      if (l.account.subtype === "trust_bank") {
        deposit += Number(l.debit || 0);
        disburse += Number(l.credit || 0);
      }
    }

    // Calculate new running balance for this client
    const prevBal = await db.query(
      `SELECT COALESCE(running_balance, 0) as bal FROM accounting_trust_ledger
       WHERE company_id = $1 AND client_key = $2 ORDER BY id DESC LIMIT 1`,
      [cid, client_key]
    );
    const prevBalance = Number(prevBal.rows[0]?.bal || 0);
    const newBalance = +(prevBalance + deposit - disburse).toFixed(2);

    await db.query(
      `INSERT INTO accounting_trust_ledger
         (company_id, entry_id, client_key, client_name, matter_type,
          transaction_date, description, deposit_amount, disburse_amount,
          running_balance, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [cid, entryId, client_key, client_name, matter_type,
       entry_date, description, deposit, disburse, newBalance, reference]
    );
  }

  // ── Auto-push to QuickBooks Online (non-blocking) ──
  // Fires in the background AFTER the local transaction is safely saved.
  // Failure never affects the local save — QBO can be down, misconfigured, or
  // the entry can have unmapped accounts, and the ledger entry is still valid.
  setImmediate(async () => {
    try {
      const qbo = require("./qbo-sync");
      if (!(await qbo.isAutoPushEnabled())) return;
      if (!(await qbo.isConnected())) return;
      await qbo.pushJournalEntry(entryId);
      console.log(`[auto-push] Entry #${entryId} → QBO ✓`);
    } catch (e) {
      // Log but don't throw — the local entry is still valid, will get picked up by scheduled sync
      console.warn(`[auto-push] Entry #${entryId} skipped: ${e.message}`);
    }
  });

  return { id: entryId, is_trust: isTrust };
}

// ─── Convenience wrappers ───────────────────────────────

// Trust deposit: cash into IOLTA + increase client trust liability
async function recordTrustDeposit({
  date, amount, client_key, client_name, matter_type, description, reference, created_by,
}) {
  return postJournalEntry({
    entry_date: date,
    description: description || `Trust deposit — ${client_name}`,
    reference,
    source_module: "manual",
    client_key, client_name, matter_type,
    lines: [
      { account_number: "1020", debit: amount, memo: description },
      { account_number: "2010", credit: amount, memo: description },
    ],
    created_by,
  });
}

// Trust disbursement: cash out of IOLTA + reduce client trust liability
async function recordTrustDisbursement({
  date, amount, client_key, client_name, matter_type, description, reference, created_by,
}) {
  return postJournalEntry({
    entry_date: date,
    description: description || `Trust disbursement — ${client_name}`,
    reference,
    source_module: "manual",
    client_key, client_name, matter_type,
    lines: [
      { account_number: "2010", debit: amount, memo: description },
      { account_number: "1020", credit: amount, memo: description },
    ],
    created_by,
  });
}

// Fee revenue earned (from operating account or moved from trust)
async function recordFeeRevenue({
  date, amount, matter_type, client_key, client_name, from_trust = false, description, reference, created_by,
}) {
  // Map matter type to account
  const feeAccounts = {
    immigration: "4010", pi: "4020", business: "4030",
    ll_tenant: "4040", estate: "4050", tm: "4060", real_estate: "4070",
  };
  const revenueAcct = feeAccounts[matter_type] || "4900";

  if (from_trust) {
    // Fee earned FROM a retainer sitting in trust — 2 entries:
    //   1. Recognize revenue: DR Client Trust Liability, CR Revenue
    //   2. Move cash: DR Operating Cash, CR IOLTA Trust
    const entry1 = await postJournalEntry({
      entry_date: date,
      description: description || `Legal fees earned from retainer — ${matter_type}`,
      reference,
      source_module: "manual_fee",
      client_key, client_name, matter_type,
      lines: [
        { account_number: "2010", debit: amount, memo: "Reduce trust liability" },
        { account_number: revenueAcct, credit: amount, memo: description },
      ],
      created_by,
    });
    const entry2 = await postJournalEntry({
      entry_date: date,
      description: `Transfer earned fees trust → operating — ${client_name || matter_type}`,
      reference,
      source_module: "manual_fee",
      client_key, client_name, matter_type,
      lines: [
        { account_number: "1010", debit: amount, memo: "Deposit to operating" },
        { account_number: "1020", credit: amount, memo: "Move from IOLTA" },
      ],
      created_by,
    });
    return { primary: entry1, transfer: entry2 };
  }

  // Fee paid directly (client wrote check to operating, no retainer involved)
  return postJournalEntry({
    entry_date: date,
    description: description || `Legal fees — ${matter_type}`,
    reference,
    source_module: "manual_fee",
    client_key, client_name, matter_type,
    lines: [
      { account_number: "1010", debit: amount, memo: description },
      { account_number: revenueAcct, credit: amount, memo: description },
    ],
    created_by,
  });
}

// Business expense
async function recordExpense({
  date, amount, account_number, vendor = null, description, reference, created_by,
}) {
  return postJournalEntry({
    entry_date: date,
    description: description || `Expense — ${vendor || "misc"}`,
    reference,
    source_module: "manual",
    lines: [
      { account_number, debit: amount },
      { account_number: "1010", credit: amount }, // paid from operating
    ],
    created_by,
  });
}

// ─── Auto-sync from PI module ───────────────────────────

// Pulls every finalized PI disbursement + case cost into the ledger.
// Idempotent — checks source_module + source_id so re-running is safe.

async function syncFromPI() {
  await initTables();
  const results = { disbursements: 0, costs: 0, errors: [] };

  // 1. PI Disbursements — full settlement waterfall
  const disbursements = await db.query(`
    SELECT d.*, c.client_name, c.client_key, c.matter_type
    FROM pi_disbursements d
    JOIN pi_cases c ON c.id = d.case_id
    WHERE d.finalized = TRUE
  `);

  for (const d of disbursements.rows) {
    // Skip if already imported
    const already = await db.query(
      `SELECT id FROM accounting_journal_entries WHERE source_module = 'pi_disbursement' AND source_id = $1`,
      [d.id]
    );
    if (already.rows[0]) continue;

    try {
      // Settlement waterfall:
      // 1. Receipt of settlement check → trust deposit
      //    DR IOLTA Trust, CR Client Trust Liability
      // 2. Attorney fee taken from trust
      //    DR Client Trust Liability, CR Legal Fees - PI
      //    (movement: trust → operating? actually just recognized as fee revenue)
      // 3. Case costs reimbursed to firm
      //    DR Client Trust Liability, CR Case Costs Advanced (zeroing out the asset)
      // 4. Medical bills paid from trust
      //    DR Client Trust Liability, CR Medical Liens Payable (or direct payment)
      //    Then when actually paid: DR Medical Liens Payable, CR IOLTA Trust
      // 5. Client net check
      //    DR Client Trust Liability, CR IOLTA Trust
      // 6. Referral fee (paid FROM attorney fee — so it's an expense)
      //    DR Referral Fees Paid, CR Cash Operating

      const date = d.finalized_date || d.created_at || new Date();
      const clientKey = d.client_key || `pi-${d.case_id}`;
      const ref = `PI-DISB-${d.id}`;

      // Step 1: Settlement receipt into trust
      await postJournalEntry({
        entry_date: date,
        description: `Settlement receipt — ${d.client_name}`,
        reference: ref,
        source_module: "pi_disbursement",
        source_id: d.id,
        client_key: clientKey, client_name: d.client_name, matter_type: "pi",
        lines: [
          { account_number: "1020", debit: Number(d.gross_settlement), memo: "Settlement check" },
          { account_number: "2010", credit: Number(d.gross_settlement), memo: "Trust liability to client" },
        ],
      });

      // Step 2: Attorney fee
      if (Number(d.attorney_fee_amount) > 0) {
        await postJournalEntry({
          entry_date: date,
          description: `Attorney fee earned — ${d.client_name} (${d.attorney_fee_pct}%)`,
          reference: ref,
          source_module: "pi_disbursement",
          source_id: d.id,
          client_key: clientKey, client_name: d.client_name, matter_type: "pi",
          lines: [
            { account_number: "2010", debit: Number(d.attorney_fee_amount) },
            { account_number: "1010", debit: 0 },
            { account_number: "4020", credit: Number(d.attorney_fee_amount) },
            { account_number: "1020", credit: 0 },
          ].filter(l => Number(l.debit || 0) > 0 || Number(l.credit || 0) > 0),
        });
        // Move cash from trust to operating (attorney fee is now firm money)
        await postJournalEntry({
          entry_date: date,
          description: `Transfer attorney fee to operating — ${d.client_name}`,
          reference: ref,
          source_module: "pi_disbursement",
          source_id: d.id,
          client_key: clientKey, client_name: d.client_name, matter_type: "pi",
          lines: [
            { account_number: "1010", debit: Number(d.attorney_fee_amount) },
            { account_number: "1020", credit: Number(d.attorney_fee_amount) },
          ],
        });
      }

      // Step 3: Case costs reimbursed
      if (Number(d.case_costs_total) > 0) {
        await postJournalEntry({
          entry_date: date,
          description: `Case costs reimbursed — ${d.client_name}`,
          reference: ref,
          source_module: "pi_disbursement",
          source_id: d.id,
          client_key: clientKey, client_name: d.client_name, matter_type: "pi",
          lines: [
            { account_number: "2010", debit: Number(d.case_costs_total) },
            { account_number: "1200", credit: Number(d.case_costs_total), memo: "Reversal of costs advanced" },
          ],
        });
        // Cash movement trust → operating
        await postJournalEntry({
          entry_date: date,
          description: `Transfer case costs reimb — ${d.client_name}`,
          reference: ref,
          source_module: "pi_disbursement",
          source_id: d.id,
          client_key: clientKey, client_name: d.client_name, matter_type: "pi",
          lines: [
            { account_number: "1010", debit: Number(d.case_costs_total) },
            { account_number: "1020", credit: Number(d.case_costs_total) },
          ],
        });
      }

      // Step 4: Medical bills paid from trust
      if (Number(d.medical_bills_total) > 0) {
        await postJournalEntry({
          entry_date: date,
          description: `Medical bills paid — ${d.client_name}`,
          reference: ref,
          source_module: "pi_disbursement",
          source_id: d.id,
          client_key: clientKey, client_name: d.client_name, matter_type: "pi",
          lines: [
            { account_number: "2010", debit: Number(d.medical_bills_total) },
            { account_number: "1020", credit: Number(d.medical_bills_total), memo: "Paid to providers" },
          ],
        });
      }

      // Step 5: Referral fee (paid FROM attorney fee, so treated as expense)
      if (Number(d.referral_fee_amount) > 0) {
        await postJournalEntry({
          entry_date: date,
          description: `Referral fee paid — ${d.client_name}`,
          reference: ref,
          source_module: "pi_disbursement",
          source_id: d.id,
          client_key: clientKey, client_name: d.client_name, matter_type: "pi",
          lines: [
            { account_number: "5040", debit: Number(d.referral_fee_amount) },
            { account_number: "1010", credit: Number(d.referral_fee_amount) },
          ],
        });
      }

      // Step 6: Client net disbursement
      if (Number(d.client_net_amount) > 0) {
        await postJournalEntry({
          entry_date: date,
          description: `Client net disbursement — ${d.client_name} (check ${d.client_check_number || "?"})`,
          reference: ref,
          source_module: "pi_disbursement",
          source_id: d.id,
          client_key: clientKey, client_name: d.client_name, matter_type: "pi",
          lines: [
            { account_number: "2010", debit: Number(d.client_net_amount) },
            { account_number: "1020", credit: Number(d.client_net_amount), memo: `Check ${d.client_check_number || "?"}` },
          ],
        });
      }

      results.disbursements++;
    } catch (e) {
      results.errors.push(`Disbursement #${d.id}: ${e.message}`);
    }
  }

  // 2. PI Case Costs Advanced (before settlement)
  // When firm pays a filing fee, expert, etc:
  //   DR Case Costs Advanced (asset), CR Cash Operating
  // Reimbursement happens automatically in Step 3 above when case settles.
  const costs = await db.query(`
    SELECT pc.*, c.client_name, c.client_key
    FROM pi_costs pc
    JOIN pi_cases c ON c.id = pc.case_id
  `);
  for (const cost of costs.rows) {
    const already = await db.query(
      `SELECT id FROM accounting_journal_entries WHERE source_module = 'pi_cost' AND source_id = $1`,
      [cost.id]
    );
    if (already.rows[0]) continue;

    try {
      await postJournalEntry({
        entry_date: cost.paid_date || cost.created_at || new Date(),
        description: `Case cost advanced — ${cost.description} (${cost.client_name})`,
        reference: `PI-COST-${cost.id}`,
        source_module: "pi_cost",
        source_id: cost.id,
        client_key: cost.client_key || `pi-${cost.case_id}`,
        client_name: cost.client_name, matter_type: "pi",
        lines: [
          { account_number: "1200", debit: Number(cost.amount) },
          { account_number: "1010", credit: Number(cost.amount) },
        ],
      });
      results.costs++;
    } catch (e) {
      results.errors.push(`Cost #${cost.id}: ${e.message}`);
    }
  }

  return results;
}

// ─── Reports ────────────────────────────────────────────

async function getAccountBalance(accountId, asOfDate = null) {
  const dateFilter = asOfDate ? `AND je.entry_date <= $2` : "";
  const params = asOfDate ? [accountId, asOfDate] : [accountId];
  const r = await db.query(
    `SELECT COALESCE(SUM(jl.debit), 0) as total_debit,
            COALESCE(SUM(jl.credit), 0) as total_credit
     FROM accounting_journal_lines jl
     JOIN accounting_journal_entries je ON je.id = jl.entry_id
     WHERE jl.account_id = $1 AND je.is_posted = TRUE ${dateFilter}`,
    params
  );
  const debit = Number(r.rows[0]?.total_debit || 0);
  const credit = Number(r.rows[0]?.total_credit || 0);
  // For asset/expense accounts: normal debit balance (debit - credit)
  // For liability/equity/revenue accounts: normal credit balance (credit - debit)
  const account = await getAccountById(accountId);
  if (["asset", "expense"].includes(account.type)) return +(debit - credit).toFixed(2);
  return +(credit - debit).toFixed(2);
}

async function getIncomeStatement(fromDate, toDate) {
  await initTables();
  const accounts = await db.query(
    `SELECT a.*,
            COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) as revenue_balance,
            COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as expense_balance
     FROM accounting_accounts a
     LEFT JOIN accounting_journal_lines jl ON jl.account_id = a.id
     LEFT JOIN accounting_journal_entries je ON je.id = jl.entry_id
       AND je.is_posted = TRUE
       AND je.entry_date >= $1 AND je.entry_date <= $2
     WHERE a.type IN ('revenue', 'expense')
     GROUP BY a.id
     HAVING COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) != 0
     ORDER BY a.account_number`,
    [fromDate, toDate]
  );
  const revenues = accounts.rows.filter(a => a.type === "revenue").map(a => ({
    account_number: a.account_number, name: a.name, amount: Number(a.revenue_balance),
  }));
  const expenses = accounts.rows.filter(a => a.type === "expense").map(a => ({
    account_number: a.account_number, name: a.name, amount: Number(a.expense_balance),
  }));
  const totalRevenue = revenues.reduce((s, a) => s + a.amount, 0);
  const totalExpense = expenses.reduce((s, a) => s + a.amount, 0);
  return {
    from_date: fromDate, to_date: toDate,
    revenues, expenses,
    total_revenue: +totalRevenue.toFixed(2),
    total_expense: +totalExpense.toFixed(2),
    net_income: +(totalRevenue - totalExpense).toFixed(2),
  };
}

async function getBalanceSheet(asOfDate = null) {
  await initTables();
  const asOf = asOfDate || new Date().toISOString().split("T")[0];
  const accounts = await listAccounts();
  const result = { as_of: asOf, assets: [], liabilities: [], equity: [] };
  for (const acct of accounts) {
    if (!["asset", "liability", "equity"].includes(acct.type)) continue;
    const bal = await getAccountBalance(acct.id, asOf);
    if (bal !== 0) {
      const bucket = { asset: "assets", liability: "liabilities", equity: "equity" }[acct.type];
      result[bucket].push({ account_number: acct.account_number, name: acct.name, amount: bal });
    }
  }
  result.total_assets = +result.assets.reduce((s, a) => s + a.amount, 0).toFixed(2);
  result.total_liabilities = +result.liabilities.reduce((s, a) => s + a.amount, 0).toFixed(2);
  result.total_equity = +result.equity.reduce((s, a) => s + a.amount, 0).toFixed(2);
  return result;
}

async function getTrustReconciliation(asOfDate = null) {
  await initTables();
  const asOf = asOfDate || new Date().toISOString().split("T")[0];
  // Trust bank account balance (from journal)
  const trustBank = await getAccountByNumber("1020");
  const bankBalance = await getAccountBalance(trustBank.id, asOf);
  // Sum of per-client trust ledger balances
  const clients = await db.query(
    `SELECT client_key, client_name,
       COALESCE(SUM(deposit_amount) - SUM(disburse_amount), 0) as balance
     FROM accounting_trust_ledger
     WHERE transaction_date <= $1
     GROUP BY client_key, client_name
     HAVING COALESCE(SUM(deposit_amount) - SUM(disburse_amount), 0) != 0
     ORDER BY client_name`,
    [asOf]
  );
  const clientTotals = clients.rows.map(c => ({
    client_key: c.client_key, client_name: c.client_name, balance: +Number(c.balance).toFixed(2),
  }));
  const sumOfClients = +clientTotals.reduce((s, c) => s + c.balance, 0).toFixed(2);
  return {
    as_of: asOf,
    bank_balance: bankBalance,
    client_balances: clientTotals,
    sum_of_client_balances: sumOfClients,
    variance: +(bankBalance - sumOfClients).toFixed(2),
    is_reconciled: Math.abs(bankBalance - sumOfClients) < 0.01,
  };
}

// General ledger listing (filterable)
async function getLedger({
  from_date = null, to_date = null, account_number = null, client_key = null,
  matter_type = null, limit = 500, offset = 0,
} = {}) {
  await initTables();
  const conds = ["je.is_posted = TRUE"];
  const params = [];
  let i = 1;
  if (from_date) { conds.push(`je.entry_date >= $${i++}`); params.push(from_date); }
  if (to_date) { conds.push(`je.entry_date <= $${i++}`); params.push(to_date); }
  if (client_key) { conds.push(`je.client_key = $${i++}`); params.push(client_key); }
  if (matter_type) { conds.push(`je.matter_type = $${i++}`); params.push(matter_type); }
  if (account_number) {
    conds.push(`EXISTS (SELECT 1 FROM accounting_journal_lines jl JOIN accounting_accounts a ON a.id = jl.account_id WHERE jl.entry_id = je.id AND a.account_number = $${i++})`);
    params.push(String(account_number));
  }
  params.push(limit, offset);
  const r = await db.query(
    `SELECT je.*,
       (SELECT json_agg(json_build_object(
          'account_number', a.account_number,
          'account_name', a.name,
          'account_type', a.type,
          'debit', jl.debit,
          'credit', jl.credit,
          'memo', jl.memo
        ) ORDER BY jl.line_number)
        FROM accounting_journal_lines jl
        JOIN accounting_accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = je.id) as lines
     FROM accounting_journal_entries je
     WHERE ${conds.join(" AND ")}
     ORDER BY je.entry_date DESC, je.id DESC
     LIMIT $${i++} OFFSET $${i}`,
    params
  );
  return r.rows;
}

async function getClientTrustLedger(client_key) {
  await initTables();
  const r = await db.query(
    `SELECT * FROM accounting_trust_ledger WHERE client_key = $1 ORDER BY transaction_date ASC, id ASC`,
    [client_key]
  );
  return r.rows;
}

async function getStats() {
  await initTables();
  const [operating, trust, ytdRev, ytdExp, unrecon, invoices] = await Promise.all([
    getAccountBalance((await getAccountByNumber("1010")).id),
    getAccountBalance((await getAccountByNumber("1020")).id),
    db.query(`SELECT COALESCE(SUM(jl.credit - jl.debit), 0) as total
              FROM accounting_journal_lines jl
              JOIN accounting_accounts a ON a.id = jl.account_id
              JOIN accounting_journal_entries je ON je.id = jl.entry_id
              WHERE a.type = 'revenue' AND je.entry_date >= date_trunc('year', CURRENT_DATE)`),
    db.query(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) as total
              FROM accounting_journal_lines jl
              JOIN accounting_accounts a ON a.id = jl.account_id
              JOIN accounting_journal_entries je ON je.id = jl.entry_id
              WHERE a.type = 'expense' AND je.entry_date >= date_trunc('year', CURRENT_DATE)`),
    db.query(`SELECT COUNT(*) as n FROM accounting_journal_entries WHERE is_posted AND NOT is_reconciled`),
    db.query(`SELECT COUNT(*) as n, COALESCE(SUM(total_amount - amount_paid), 0) as balance FROM accounting_invoices WHERE status IN ('sent', 'partial')`),
  ]);
  return {
    operating_balance: operating,
    trust_balance: trust,
    ytd_revenue: +Number(ytdRev.rows[0].total).toFixed(2),
    ytd_expense: +Number(ytdExp.rows[0].total).toFixed(2),
    ytd_net_income: +(Number(ytdRev.rows[0].total) - Number(ytdExp.rows[0].total)).toFixed(2),
    unreconciled_count: Number(unrecon.rows[0].n),
    open_invoices_count: Number(invoices.rows[0].n),
    open_invoices_balance: +Number(invoices.rows[0].balance).toFixed(2),
  };
}

// ─── Export: Excel ──────────────────────────────────────
// Uses xlsx package (already in the project for hearing note exhibit parsing)

async function exportToExcel({ from_date, to_date, filters = {} } = {}) {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();

  // Sheet 1: General Ledger
  const ledger = await getLedger({ from_date, to_date, ...filters, limit: 10000 });
  const ledgerRows = [];
  for (const entry of ledger) {
    for (const line of (entry.lines || [])) {
      ledgerRows.push({
        Date: entry.entry_date,
        Reference: entry.reference || "",
        Description: entry.description,
        Client: entry.client_name || "",
        "Matter Type": entry.matter_type || "",
        "Account #": line.account_number,
        "Account Name": line.account_name,
        Debit: Number(line.debit || 0),
        Credit: Number(line.credit || 0),
        Memo: line.memo || "",
      });
    }
  }
  const ws1 = XLSX.utils.json_to_sheet(ledgerRows);
  XLSX.utils.book_append_sheet(wb, ws1, "General Ledger");

  // Sheet 2: Income Statement
  const income = await getIncomeStatement(from_date || "1900-01-01", to_date || new Date().toISOString().split("T")[0]);
  const incomeRows = [
    { Line: "REVENUE", Amount: null },
    ...income.revenues.map(r => ({ Line: `  ${r.account_number} ${r.name}`, Amount: r.amount })),
    { Line: "Total Revenue", Amount: income.total_revenue },
    { Line: "", Amount: null },
    { Line: "EXPENSES", Amount: null },
    ...income.expenses.map(e => ({ Line: `  ${e.account_number} ${e.name}`, Amount: e.amount })),
    { Line: "Total Expenses", Amount: income.total_expense },
    { Line: "", Amount: null },
    { Line: "NET INCOME", Amount: income.net_income },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(incomeRows), "Income Statement");

  // Sheet 3: Balance Sheet
  const bs = await getBalanceSheet(to_date);
  const bsRows = [
    { Line: "ASSETS", Amount: null },
    ...bs.assets.map(a => ({ Line: `  ${a.account_number} ${a.name}`, Amount: a.amount })),
    { Line: "Total Assets", Amount: bs.total_assets },
    { Line: "", Amount: null },
    { Line: "LIABILITIES", Amount: null },
    ...bs.liabilities.map(l => ({ Line: `  ${l.account_number} ${l.name}`, Amount: l.amount })),
    { Line: "Total Liabilities", Amount: bs.total_liabilities },
    { Line: "", Amount: null },
    { Line: "EQUITY", Amount: null },
    ...bs.equity.map(e => ({ Line: `  ${e.account_number} ${e.name}`, Amount: e.amount })),
    { Line: "Total Equity", Amount: bs.total_equity },
    { Line: "", Amount: null },
    { Line: "Total Liabilities + Equity", Amount: +(bs.total_liabilities + bs.total_equity).toFixed(2) },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bsRows), "Balance Sheet");

  // Sheet 4: Trust Reconciliation
  const trust = await getTrustReconciliation(to_date);
  const trustRows = [
    { Item: "Bank balance (IOLTA Trust Account)", Amount: trust.bank_balance },
    { Item: "Sum of client trust balances", Amount: trust.sum_of_client_balances },
    { Item: "Variance", Amount: trust.variance },
    { Item: `Reconciled: ${trust.is_reconciled ? "YES ✓" : "NO ✗"}`, Amount: null },
    { Item: "", Amount: null },
    { Item: "PER-CLIENT BALANCES", Amount: null },
    ...trust.client_balances.map(c => ({ Item: `  ${c.client_name}`, Amount: c.balance })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trustRows), "Trust Reconciliation");

  // Sheet 5: Chart of Accounts
  const accounts = await listAccounts();
  const acctRows = await Promise.all(accounts.map(async a => ({
    "Account #": a.account_number,
    Name: a.name,
    Type: a.type,
    Subtype: a.subtype || "",
    Balance: await getAccountBalance(a.id, to_date),
  })));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(acctRows), "Chart of Accounts");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ─── Export: IIF (QuickBooks Desktop native) ────────────
// IIF = Intuit Interchange Format, tab-delimited, imports directly into
// QuickBooks Desktop via File → Utilities → Import → IIF Files.

async function exportToIIF({ from_date, to_date } = {}) {
  await initTables();
  const entries = await getLedger({ from_date, to_date, limit: 10000 });
  const lines = [];

  // Header rows (IIF format requires specific header row structure)
  lines.push("!ACCNT\tNAME\tACCNTTYPE\tDESC");
  const accounts = await listAccounts();
  const iifAcctType = {
    asset: "OCASSET", liability: "OCLIAB", equity: "EQUITY",
    revenue: "INC", expense: "EXP",
  };
  const specialTypes = {
    bank: "BANK", trust_bank: "BANK", ar: "AR", ap: "AP", fixed: "FIXASSET",
  };
  for (const a of accounts) {
    const type = specialTypes[a.subtype] || iifAcctType[a.type] || "OCASSET";
    lines.push(`ACCNT\t${a.name}\t${type}\t`);
  }
  lines.push("");

  // Transactions
  lines.push("!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO");
  lines.push("!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO");
  lines.push("!ENDTRNS");

  for (const entry of entries) {
    const date = new Date(entry.entry_date);
    const dateStr = `${(date.getMonth() + 1).toString().padStart(2, "0")}/${date.getDate().toString().padStart(2, "0")}/${date.getFullYear()}`;
    const ref = (entry.reference || `JE-${entry.id}`).replace(/\t/g, " ");
    const memo = (entry.description || "").replace(/\t/g, " ").substring(0, 200);
    const clientName = (entry.client_name || "").replace(/\t/g, " ");

    // First line is TRNS, remaining are SPL. Sign convention:
    // - TRNS amount is positive for debit to bank/asset
    // - SPL amount is negative for the offsetting credit
    const linesArr = entry.lines || [];
    if (!linesArr.length) continue;
    // Simplification: use first line as TRNS
    const first = linesArr[0];
    const trnsAmount = Number(first.debit || 0) > 0 ? Number(first.debit) : -Number(first.credit || 0);
    lines.push(`TRNS\tGENERAL JOURNAL\t${dateStr}\t${first.account_name}\t${clientName}\t${trnsAmount.toFixed(2)}\t${ref}\t${memo}`);
    for (let i = 1; i < linesArr.length; i++) {
      const l = linesArr[i];
      const amt = Number(l.debit || 0) > 0 ? Number(l.debit) : -Number(l.credit || 0);
      const lineMemo = (l.memo || memo).replace(/\t/g, " ").substring(0, 200);
      lines.push(`SPL\tGENERAL JOURNAL\t${dateStr}\t${l.account_name}\t${clientName}\t${amt.toFixed(2)}\t${ref}\t${lineMemo}`);
    }
    lines.push("ENDTRNS");
  }

  return lines.join("\r\n");
}

// ─── Export: CSV for QuickBooks Online ──────────────────
// QBO's "3-column" format for bank transactions.
// For journal entries, QBO also accepts a specific journal import CSV.

async function exportToCSV({ from_date, to_date } = {}) {
  await initTables();
  const entries = await getLedger({ from_date, to_date, limit: 10000 });
  const rows = [
    // Header
    ["Date", "Entry #", "Description", "Client", "Matter", "Account #", "Account Name", "Debit", "Credit", "Memo"].join(","),
  ];
  const csvEsc = s => {
    const str = String(s == null ? "" : s);
    if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  for (const entry of entries) {
    for (const line of (entry.lines || [])) {
      rows.push([
        entry.entry_date,
        entry.id,
        csvEsc(entry.description),
        csvEsc(entry.client_name || ""),
        entry.matter_type || "",
        line.account_number,
        csvEsc(line.account_name),
        Number(line.debit || 0).toFixed(2),
        Number(line.credit || 0).toFixed(2),
        csvEsc(line.memo || ""),
      ].join(","));
    }
  }
  return rows.join("\r\n");
}

module.exports = {
  initTables,
  DEFAULT_COA,
  // Chart of accounts
  getAccountByNumber, getAccountById, listAccounts, ensureAccount,
  // Journal
  postJournalEntry,
  // Convenience wrappers
  recordTrustDeposit, recordTrustDisbursement, recordFeeRevenue, recordExpense,
  // Auto-sync
  syncFromPI,
  // Reports
  getAccountBalance, getIncomeStatement, getBalanceSheet, getTrustReconciliation,
  getLedger, getClientTrustLedger, getStats,
  // Exports
  exportToExcel, exportToIIF, exportToCSV,
};
