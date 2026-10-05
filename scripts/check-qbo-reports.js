// check-qbo-reports.js — reading QuickBooks' own reports correctly.
//
// Every accounting page in tezlaw-bot showed zero, because qbo-sync only ever
// pushed and the local ledger tables fill only when somebody hand-keys an
// entry. The firm's actual books were in QuickBooks the whole time.
//
// The fix asks QuickBooks for its own ProfitAndLoss and BalanceSheet rather
// than rebuilding a general ledger here, so the numbers on the page are its
// numbers. That makes the report parser the load-bearing piece, and a report
// parser has two ways to be quietly wrong: a cent lost to floating point on
// every line, and a total read from the wrong column. Both foot to something
// plausible, which is what makes them dangerous.
//
// The fixtures below follow Intuit's documented report shape: a tree of
// Section rows (Header, nested Rows, Summary) and Data rows (ColData, label
// first, amount last), with a stable "group" on the sections.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "qbo-reports.js"));
const { flattenReport, headerOf, toCents, fromCents, paramsKey } = R;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ── Fixtures ───────────────────────────────────────────────

const PROFIT_AND_LOSS = {
  Header: {
    Time: "2026-10-04T17:30:00-07:00",
    ReportName: "ProfitAndLoss",
    StartPeriod: "2026-01-01",
    EndPeriod: "2026-10-04",
    Currency: "USD",
    Option: [{ Name: "AccountingStandard", Value: "Cash" }],
  },
  Columns: { Column: [{ ColTitle: "", ColType: "Account" }, { ColTitle: "Total", ColType: "Money" }] },
  Rows: {
    Row: [
      {
        Header: { ColData: [{ value: "Income" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Legal Fees", id: "79" }, { value: "248310.15" }], type: "Data" },
            { ColData: [{ value: "Consultation Fees", id: "80" }, { value: "12500.00" }], type: "Data" },
          ],
        },
        Summary: { ColData: [{ value: "Total Income" }, { value: "260810.15" }] },
        type: "Section",
        group: "Income",
      },
      {
        Header: { ColData: [{ value: "Expenses" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Filing Fees", id: "91" }, { value: "18240.00" }], type: "Data" },
            { ColData: [{ value: "Rent", id: "92" }, { value: "54000.00" }], type: "Data" },
            {
              Header: { ColData: [{ value: "Payroll" }, { value: "" }] },
              Rows: { Row: [{ ColData: [{ value: "Salaries", id: "93" }, { value: "96000.00" }], type: "Data" }] },
              Summary: { ColData: [{ value: "Total Payroll" }, { value: "96000.00" }] },
              type: "Section",
              group: "Payroll",
            },
          ],
        },
        Summary: { ColData: [{ value: "Total Expenses" }, { value: "168240.00" }] },
        type: "Section",
        group: "Expenses",
      },
      {
        Summary: { ColData: [{ value: "Net Income" }, { value: "92570.15" }] },
        type: "Section",
        group: "NetIncome",
      },
    ],
  },
};

const BALANCE_SHEET = {
  Header: { ReportName: "BalanceSheet", StartPeriod: "2026-10-04", EndPeriod: "2026-10-04", Currency: "USD" },
  Columns: { Column: [{ ColTitle: "", ColType: "Account" }, { ColTitle: "Total", ColType: "Money" }] },
  Rows: {
    Row: [
      {
        Header: { ColData: [{ value: "ASSETS" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Operating Checking", id: "35" }, { value: "84210.44" }], type: "Data" },
            { ColData: [{ value: "IOLTA Trust", id: "36" }, { value: "126500.00" }], type: "Data" },
          ],
        },
        Summary: { ColData: [{ value: "TOTAL ASSETS" }, { value: "210710.44" }] },
        type: "Section",
        group: "TotalAssets",
      },
      {
        Header: { ColData: [{ value: "Liabilities" }, { value: "" }] },
        Rows: { Row: [{ ColData: [{ value: "Client Trust Liability", id: "44" }, { value: "126500.00" }], type: "Data" }] },
        Summary: { ColData: [{ value: "Total Liabilities" }, { value: "126500.00" }] },
        type: "Section",
        group: "TotalLiabilities",
      },
    ],
  },
};

console.log("\nQuickBooks reports\n");

// ── Money ──────────────────────────────────────────────────

check("amounts become exact cents", () => {
  // 248310.15 * 100 is 24831014.999999996 in binary floating point. One cent
  // per line, across a year of entries, is a report that does not foot.
  assert.strictEqual(toCents("248310.15"), 24831015);
  assert.strictEqual(toCents("0.07"), 7);
  assert.strictEqual(toCents("-1250.50"), -125050);
  assert.strictEqual(toCents("1,234.56"), 123456, "QuickBooks sometimes sends grouped digits");
  assert.strictEqual(toCents("$900.00"), 90000);
});

check("an absent amount is null, not zero", () => {
  // A section header has no amount. Zero would read as "this cost nothing".
  assert.strictEqual(toCents(""), null);
  assert.strictEqual(toCents(null), null);
  assert.strictEqual(toCents(undefined), null);
  assert.strictEqual(toCents("n/a"), null);
});

check("cents format back for a page", () => {
  assert.strictEqual(fromCents(24831015), "$248,310.15");
  assert.strictEqual(fromCents(-125050), "-$1,250.50");
  assert.strictEqual(fromCents(0), "$0.00");
  assert.strictEqual(fromCents(null), null);
});

// ── The report tree ────────────────────────────────────────

check("the header says what the report is and when", () => {
  const h = headerOf(PROFIT_AND_LOSS);
  assert.strictEqual(h.report_name, "ProfitAndLoss");
  assert.strictEqual(h.start_period, "2026-01-01");
  assert.strictEqual(h.end_period, "2026-10-04");
  assert.strictEqual(h.currency, "USD");
});

check("every account line is found, at any nesting depth", () => {
  const { lines } = flattenReport(PROFIT_AND_LOSS);
  const labels = lines.filter(l => l.kind === "line").map(l => l.label);
  for (const want of ["Legal Fees", "Consultation Fees", "Filing Fees", "Rent", "Salaries"]) {
    assert.ok(labels.includes(want), `${want} is missing from the flattened report`);
  }
  // Salaries sits inside Payroll inside Expenses.
  const salaries = lines.find(l => l.label === "Salaries");
  assert.ok(salaries.depth > 1, "a nested account should carry its depth so the page can indent it");
});

check("an account keeps its QuickBooks id", () => {
  const { lines } = flattenReport(PROFIT_AND_LOSS);
  const fees = lines.find(l => l.label === "Legal Fees");
  assert.strictEqual(fees.account_id, "79", "the id is what a drill-through would use");
  assert.strictEqual(fees.amount_cents, 24831015);
});

check("section totals are keyed by group, not by label", () => {
  // Labels are localised and user-editable; "group" is Intuit's stable handle.
  const { groups } = flattenReport(PROFIT_AND_LOSS);
  assert.strictEqual(groups.Income, 26081015);
  assert.strictEqual(groups.Expenses, 16824000);
  assert.strictEqual(groups.NetIncome, 9257015);
  assert.strictEqual(groups.Payroll, 9600000, "a nested section gets its own total too");
});

check("the totals actually foot", () => {
  const { groups } = flattenReport(PROFIT_AND_LOSS);
  assert.strictEqual(groups.Income - groups.Expenses, groups.NetIncome,
    "income minus expenses must equal net income, or the parser read a wrong column");
});

check("a balance sheet parses the same way", () => {
  const { groups, lines } = flattenReport(BALANCE_SHEET);
  assert.strictEqual(groups.TotalAssets, 21071044);
  assert.strictEqual(groups.TotalLiabilities, 12650000);
  const iolta = lines.find(l => l.label === "IOLTA Trust");
  assert.ok(iolta, "the trust account must be visible — it is the RRC 1.15 reconciliation's other half");
  assert.strictEqual(iolta.amount_cents, 12650000);
});

check("the amount comes from the last populated column", () => {
  // A comparison report (this year vs last) has several money columns; the
  // total is the rightmost. Reading column 1 would silently report last year.
  const comparison = {
    Header: { ReportName: "ProfitAndLoss" },
    Rows: { Row: [{
      Summary: { ColData: [{ value: "Net Income" }, { value: "50000.00" }, { value: "75000.00" }, { value: "125000.00" }] },
      type: "Section", group: "NetIncome",
    }] },
  };
  assert.strictEqual(flattenReport(comparison).groups.NetIncome, 12500000);
});

check("a blank trailing column does not hide the total", () => {
  const padded = {
    Rows: { Row: [{
      Summary: { ColData: [{ value: "Net Income" }, { value: "4200.00" }, { value: "" }] },
      type: "Section", group: "NetIncome",
    }] },
  };
  assert.strictEqual(flattenReport(padded).groups.NetIncome, 420000);
});

check("a loss keeps its sign", () => {
  const loss = {
    Rows: { Row: [{
      Summary: { ColData: [{ value: "Net Income" }, { value: "-18400.25" }] },
      type: "Section", group: "NetIncome",
    }] },
  };
  assert.strictEqual(flattenReport(loss).groups.NetIncome, -1840025);
});

// ── Shapes we have not seen ────────────────────────────────

check("an empty report is empty, not an error", () => {
  for (const empty of [{}, { Rows: {} }, { Rows: { Row: [] } }, null, undefined]) {
    const out = flattenReport(empty);
    assert.deepStrictEqual(out.lines, []);
    assert.strictEqual(out.parse_error, null);
  }
});

check("a single row not wrapped in an array still parses", () => {
  // Some QuickBooks responses collapse a one-element Row array to an object.
  const single = { Rows: { Row: { ColData: [{ value: "Rent", id: "92" }, { value: "1200.00" }] } } };
  const { lines } = flattenReport(single);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].amount_cents, 120000);
});

check("a row shape we do not understand is counted, not fatal", () => {
  const odd = { Rows: { Row: [
    { ColData: [{ value: "Rent" }, { value: "1200.00" }] },
    { SomethingNew: true },
    "a bare string",
  ] } };
  const out = flattenReport(odd);
  assert.strictEqual(out.lines.length, 1, "the line it understood is still returned");
  assert.strictEqual(out.unparsed, 2, "and the rest is reported rather than silently dropped");
  assert.strictEqual(out.parse_error, null);
});

// ── Cache keys ─────────────────────────────────────────────

check("the cache key does not depend on option order", () => {
  assert.strictEqual(
    paramsKey({ start_date: "2026-01-01", end_date: "2026-10-04" }),
    paramsKey({ end_date: "2026-10-04", start_date: "2026-01-01" }),
    "the same request written two ways must hit the same cache row"
  );
  assert.notStrictEqual(paramsKey({ start_date: "2026-01-01" }), paramsKey({ start_date: "2025-01-01" }));
  assert.strictEqual(paramsKey({}), "(none)");
});

// ── It only reads ──────────────────────────────────────────

check("this module never writes to QuickBooks", () => {
  const src = fs.readFileSync(path.join(ROOT, "qbo-reports.js"), "utf8");
  assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)["']/.test(src),
    "qbo-reports issues reads only — a write belongs in qbo-sync, deliberately");
  assert.ok(/method:\s*["']GET["']/.test(src));
});

check("the preview route is admin-only and read-only", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(/app\.get\("\/admin\/accounting\/quickbooks\/report",\s*auth\.requireRole\("admin"\)/.test(server),
    "the raw report shows the firm's finances — admin only, and GET");
});

check("the page says which environment it is talking to", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(/QuickBooks SANDBOX/.test(server),
    "a sandbox connection must say so — it authenticates perfectly and reports zeros that look like facts");
  assert.ok(/QBO_ENVIRONMENT now says/.test(server),
    "a stored environment that disagrees with the variable must be surfaced, not silently preferred");
});

console.log(`\n${passed} checks passed\n`);
