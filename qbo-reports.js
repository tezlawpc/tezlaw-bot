// ============================================================
//  qbo-reports.js — the firm's numbers, as QuickBooks reports them
//  Tez Law P.C.
//
//  qbo-sync.js only ever pushed: journal entries out of tezlaw-bot and into
//  QuickBooks. Nothing came back. So the income statement, balance sheet and
//  ledger pages read local tables that fill only when somebody hand-keys an
//  entry, and every figure on them was zero while the real books sat in
//  QuickBooks, untouched.
//
//  WHY REPORTS RATHER THAN TRANSACTIONS
//  The obvious fix is to pull every JournalEntry, Invoice, Payment, Bill and
//  Deposit and rebuild a general ledger here. That is a great deal of code
//  whose whole purpose is to arrive back at a number QuickBooks already
//  computes — and when the two disagree, as they eventually would, there is no
//  good answer to which is right. QuickBooks is the system of record for the
//  firm's money. So this asks it for its own ProfitAndLoss and BalanceSheet and
//  caches the answer. The numbers on the page are then QuickBooks' numbers, by
//  construction.
//
//  ON FAILING SOFTLY
//  A report that cannot be parsed must not throw. A finance page showing the
//  lines it understood, and saying plainly what it did not, is worth more than
//  a stack trace — and far more than a zero, which reads as a fact about the
//  firm rather than a fact about the software.
// ============================================================

const db = require("./db");

const DEFAULT_TTL_MINUTES = 15;

// ─── Cache ───────────────────────────────────────────

async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounting_qb_report_cache (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER NOT NULL,
      report      TEXT NOT NULL,
      params_key  TEXT NOT NULL,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload     JSONB NOT NULL
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qb_report_cache
      ON accounting_qb_report_cache(company_id, report, params_key)
  `);
}

// Stable regardless of the order the caller wrote the options in, so the same
// request is the same cache row.
function paramsKey(params = {}) {
  return Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&") || "(none)";
}

async function readCache(companyId, report, params, ttlMinutes) {
  const { rows } = await db.query(
    `SELECT payload, fetched_at,
            EXTRACT(EPOCH FROM (NOW() - fetched_at)) / 60 AS age_minutes
       FROM accounting_qb_report_cache
      WHERE company_id = $1 AND report = $2 AND params_key = $3`,
    [companyId, report, paramsKey(params)]
  );
  if (!rows[0]) return null;
  const age = Number(rows[0].age_minutes);
  return { payload: rows[0].payload, fetched_at: rows[0].fetched_at, age_minutes: age, stale: age > ttlMinutes };
}

async function writeCache(companyId, report, params, payload) {
  await db.query(
    `INSERT INTO accounting_qb_report_cache (company_id, report, params_key, payload, fetched_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id, report, params_key)
     DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()`,
    [companyId, report, paramsKey(params), JSON.stringify(payload)]
  );
}

// ─── Money ───────────────────────────────────────────
// QuickBooks sends amounts as strings. Parse then round; multiplying a float by
// 100 turns 10.15 into 1014.9999999999999, and a cent per line is a report that
// does not foot.

function toCents(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function fromCents(c) {
  if (c == null) return null;
  const neg = c < 0;
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-$" : "$") + s;
}

// ─── Parsing ─────────────────────────────────────────
//
// A QuickBooks report is a tree:
//
//   { Header: {...}, Columns: { Column: [...] }, Rows: { Row: [ ... ] } }
//
// where each Row is either a Section (a Header line, nested Rows, and a Summary
// line) or Data (a ColData array: first cell the label, last cell the amount).
// Section rows carry a "group" — Income, Expenses, NetIncome and so on — which
// is the stable handle for the totals that matter; the human labels are
// localised and the account names are the firm's own.

function cellValue(colData, index) {
  if (!Array.isArray(colData) || !colData[index]) return null;
  const v = colData[index].value;
  return v == null || v === "" ? null : String(v);
}

function amountFromColData(colData) {
  // The amount is the last populated cell. A single-column report puts it in
  // position 1; a comparison report has several, and the last is the total.
  if (!Array.isArray(colData)) return null;
  for (let i = colData.length - 1; i >= 1; i--) {
    const c = toCents(colData[i] && colData[i].value);
    if (c != null) return c;
  }
  return null;
}

/**
 * Flatten a report into lines a page can render directly.
 * Never throws: an unrecognised row is counted, not fatal.
 */
function flattenReport(report) {
  const lines = [];
  const groups = {};
  let unparsed = 0;

  function walk(rows, depth, inGroup) {
    if (!rows) return;
    const list = Array.isArray(rows) ? rows : (Array.isArray(rows.Row) ? rows.Row : (rows.Row ? [rows.Row] : []));
    for (const row of list) {
      if (!row || typeof row !== "object") { unparsed++; continue; }
      const group = row.group || inGroup || null;

      if (row.Header || row.Rows || row.Summary) {
        const headerLabel = cellValue(row.Header && row.Header.ColData, 0);
        if (headerLabel) {
          lines.push({ label: headerLabel, amount_cents: amountFromColData(row.Header.ColData),
                       depth, kind: "header", group });
        }
        walk(row.Rows, depth + 1, group);
        if (row.Summary && row.Summary.ColData) {
          const label = cellValue(row.Summary.ColData, 0);
          const amount = amountFromColData(row.Summary.ColData);
          lines.push({ label: label || "Total", amount_cents: amount, depth, kind: "summary", group });
          // The group's total is its summary line. Recorded by group name so a
          // caller asks for "NetIncome" rather than matching on a label that
          // changes with the QuickBooks locale.
          if (group && amount != null) groups[group] = amount;
        }
        continue;
      }

      if (row.ColData) {
        const label = cellValue(row.ColData, 0);
        const amount = amountFromColData(row.ColData);
        // An id means the line is a real account rather than a spacer.
        const accountId = row.ColData[0] && row.ColData[0].id ? String(row.ColData[0].id) : null;
        if (label != null || amount != null) {
          lines.push({ label: label || "", amount_cents: amount, depth, kind: "line", group, account_id: accountId });
        }
        continue;
      }

      unparsed++;
    }
  }

  try {
    walk(report && report.Rows, 0, null);
  } catch (e) {
    // Shape we have never seen. Keep whatever was gathered and say so.
    return { lines, groups, unparsed: unparsed + 1, parse_error: e.message };
  }

  return { lines, groups, unparsed, parse_error: null };
}

function headerOf(report) {
  const h = (report && report.Header) || {};
  return {
    report_name: h.ReportName || null,
    start_period: h.StartPeriod || null,
    end_period: h.EndPeriod || null,
    date_macro: h.DateMacro || null,
    currency: h.Currency || null,
    // Which QuickBooks company this came from — the thing that was invisible
    // while the app was quietly talking to a sandbox.
    time: h.Time || null,
  };
}

// ─── Fetching ────────────────────────────────────────

/**
 * One report, cached. Returns the parsed shape plus the raw payload, so a
 * preview route can show exactly what QuickBooks sent.
 */
async function getReport(name, params = {}, { company_id = null, ttlMinutes = DEFAULT_TTL_MINUTES, force = false } = {}) {
  const qbo = require("./qbo-sync");
  await initTables();
  const companyId = await qbo.companyIdOf(company_id);

  let cached = null;
  try { cached = await readCache(companyId, name, params, ttlMinutes); } catch (e) {
    console.warn("[qbo-reports] cache read failed:", e.message);
  }

  if (cached && !cached.stale && !force) {
    return { ...shape(cached.payload), from_cache: true, fetched_at: cached.fetched_at, age_minutes: cached.age_minutes };
  }

  let payload;
  try {
    const resp = await qbo.qboRequest({ method: "GET", path: `/reports/${name}`, params, company_id: companyId });
    payload = resp && resp.data ? resp.data : resp;
    try { await writeCache(companyId, name, params, payload); } catch (e) {
      console.warn("[qbo-reports] cache write failed:", e.message);
    }
  } catch (e) {
    // A stale cached report beats no report: say how old it is and show it.
    if (cached) {
      return { ...shape(cached.payload), from_cache: true, stale: true,
               fetched_at: cached.fetched_at, age_minutes: cached.age_minutes,
               error: `Could not refresh from QuickBooks (${e.message}). Showing the last copy.` };
    }
    throw e;
  }

  return { ...shape(payload), from_cache: false, fetched_at: new Date().toISOString(), age_minutes: 0 };
}

function shape(payload) {
  const parsed = flattenReport(payload);
  return {
    header: headerOf(payload),
    lines: parsed.lines,
    groups: parsed.groups,
    unparsed: parsed.unparsed,
    parse_error: parsed.parse_error,
    raw: payload,
  };
}

// ─── The two reports the pages need ──────────────────

function thisYearStart() {
  return `${new Date().getFullYear()}-01-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

async function profitAndLoss({ start_date = thisYearStart(), end_date = today(), ...rest } = {}, opts = {}) {
  const r = await getReport("ProfitAndLoss", { start_date, end_date, ...rest }, opts);
  return {
    ...r,
    // Group names QuickBooks uses on this report. Null where the realm does not
    // produce that section — a cash-basis firm with no COGS, say.
    income_cents: r.groups.Income ?? null,
    expenses_cents: r.groups.Expenses ?? null,
    gross_profit_cents: r.groups.GrossProfit ?? null,
    net_income_cents: r.groups.NetIncome ?? r.groups.NetOperatingIncome ?? null,
  };
}

async function balanceSheet({ as_of = today(), ...rest } = {}, opts = {}) {
  const r = await getReport("BalanceSheet", { start_date: as_of, end_date: as_of, ...rest }, opts);
  return {
    ...r,
    assets_cents: r.groups.TotalAssets ?? r.groups.ASSETS ?? null,
    liabilities_cents: r.groups.TotalLiabilities ?? r.groups.Liabilities ?? null,
    equity_cents: r.groups.TotalEquity ?? r.groups.Equity ?? null,
  };
}

async function trialBalance({ start_date = thisYearStart(), end_date = today(), ...rest } = {}, opts = {}) {
  return await getReport("TrialBalance", { start_date, end_date, ...rest }, opts);
}

module.exports = {
  initTables,
  getReport,
  profitAndLoss,
  balanceSheet,
  trialBalance,
  // Pure, so the checks exercise the real parser against real report shapes
  // without a realm, a token or a network.
  flattenReport,
  headerOf,
  toCents,
  fromCents,
  paramsKey,
  shape,
};
