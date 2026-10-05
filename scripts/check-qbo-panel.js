// check-qbo-panel.js — a missing number must never render as zero.
//
// The accounting pages showed 0.00 everywhere for months. Not because the firm
// earned nothing, but because they read tezlaw-bot's own ledger tables, which
// fill only when somebody hand-keys an entry, while the real books sat in
// QuickBooks. A zero on an income statement does not read as "no data" — it
// reads as a fact about the firm, and it looked confident about it.
//
// So the single property this file exists to defend: every way of having no
// figure — not connected, a sandbox realm, an expired token, an unreadable
// report, an empty period — must SAY what happened. None of them may render a
// dollar amount.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const P = require(path.join(ROOT, "qbo-panel.js"));
const { renderPanel, money, esc } = P;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Does this HTML contain anything a reader would take for a figure?
function hasMoney(html) {
  return /\$\s?-?[\d,]+\.\d{2}/.test(html);
}

const GOOD = {
  header: { report_name: "ProfitAndLoss", start_period: "2026-01-01", end_period: "2026-10-04", currency: "USD" },
  lines: [
    { label: "Income", amount_cents: null, depth: 0, kind: "header", group: "Income" },
    { label: "Legal Fees", amount_cents: 24831015, depth: 1, kind: "line", group: "Income", account_id: "79" },
    { label: "Total Income", amount_cents: 26081015, depth: 0, kind: "summary", group: "Income" },
  ],
  groups: { Income: 26081015, Expenses: 16824000, NetIncome: 9257015 },
  income_cents: 26081015,
  expenses_cents: 16824000,
  net_income_cents: 9257015,
  unparsed: 0,
  parse_error: null,
  from_cache: false,
  fetched_at: "2026-10-04T23:00:00Z",
};

const HEADLINE = [
  { key: "income_cents", label: "Income" },
  { key: "expenses_cents", label: "Expenses" },
  { key: "net_income_cents", label: "Net income" },
];

console.log("\nQuickBooks panel\n");

// ── The one rule ───────────────────────────────────────────

check("not connected says so, and shows no figures", () => {
  const html = renderPanel({ title: "P&L", result: { ok: false, reason: "not_connected" }, headline: HEADLINE });
  assert.ok(/not connected/i.test(html));
  assert.ok(!hasMoney(html), "a missing connection must not render as a dollar amount");
  assert.ok(html.includes("/admin/accounting/quickbooks"), "and should say where to fix it");
});

check("a sandbox realm says so, and shows no figures", () => {
  const html = renderPanel({ title: "P&L", result: { ok: false, reason: "sandbox" }, headline: HEADLINE });
  assert.ok(/sandbox/i.test(html));
  assert.ok(!hasMoney(html), "sandbox figures are meaningless and must not be shown at all");
});

check("a read failure says what failed, not zero", () => {
  const html = renderPanel({
    title: "P&L",
    result: { ok: false, reason: "error", detail: "401 Unauthorized (intuit_tid abc123)" },
    headline: HEADLINE,
  });
  assert.ok(html.includes("401 Unauthorized"), "the real error belongs on the page");
  assert.ok(/read failure, not a statement/i.test(html),
    "it must distinguish 'could not read' from 'the figure is zero'");
  assert.ok(!hasMoney(html));
});

check("an empty report says QuickBooks returned nothing", () => {
  const html = renderPanel({
    title: "P&L",
    result: { header: { start_period: "2026-01-01", end_period: "2026-10-04" }, lines: [], groups: {}, unparsed: 0, parse_error: null },
    headline: HEADLINE,
  });
  assert.ok(/no lines for the period/i.test(html));
  assert.ok(!hasMoney(html), "an empty period must not be dressed up as $0.00");
});

check("a genuine zero is still allowed to be zero", () => {
  // The distinction the whole file turns on: QuickBooks SAYING zero is a fact.
  const html = renderPanel({
    title: "P&L",
    result: { ...GOOD, lines: [{ label: "Total Income", amount_cents: 0, depth: 0, kind: "summary", group: "Income" }],
              income_cents: 0, expenses_cents: 0, net_income_cents: 0 },
    headline: HEADLINE,
  });
  assert.ok(hasMoney(html), "a figure QuickBooks reported as zero is real and must be shown");
});

// ── Normal rendering ───────────────────────────────────────

check("the headline figures are shown", () => {
  const html = renderPanel({ title: "P&L", result: GOOD, headline: HEADLINE });
  assert.ok(html.includes("$260,810.15"), "income");
  assert.ok(html.includes("$168,240.00"), "expenses");
  assert.ok(html.includes("$92,570.15"), "net income");
});

check("account lines appear, indented by depth", () => {
  const html = renderPanel({ title: "P&L", result: GOOD, headline: HEADLINE });
  assert.ok(html.includes("Legal Fees"));
  assert.ok(html.includes("$248,310.15"));
  assert.ok(/padding:7px 12px 7px 30px/.test(html), "a depth-1 line should be indented further than a depth-0 one");
});

check("the period and currency are stated", () => {
  const html = renderPanel({ title: "P&L", result: GOOD, headline: HEADLINE });
  assert.ok(html.includes("2026-01-01"));
  assert.ok(html.includes("2026-10-04"));
  assert.ok(html.includes("USD"));
});

check("the reader is told how old the figures are", () => {
  const html = renderPanel({ title: "P&L", result: GOOD, headline: HEADLINE });
  assert.ok(/Read from QuickBooks/.test(html));
  assert.ok(/refresh=1/.test(html), "and given a way to refresh");
});

check("a stale cached report admits it is stale", () => {
  const html = renderPanel({
    title: "P&L",
    result: { ...GOOD, from_cache: true, error: "Could not refresh from QuickBooks (timeout). Showing the last copy." },
    headline: HEADLINE,
  });
  assert.ok(/Showing the last copy/.test(html));
  assert.ok(/cached/.test(html));
});

check("rows that could not be parsed are disclosed", () => {
  const html = renderPanel({ title: "P&L", result: { ...GOOD, unparsed: 3 }, headline: HEADLINE });
  assert.ok(/3 row\(s\)/.test(html), "silently dropping rows from a financial report is not acceptable");
  assert.ok(/totals come from QuickBooks and are unaffected/.test(html));
});

// ── Money ──────────────────────────────────────────────────

check("an absent figure is a dash, never $0.00", () => {
  assert.strictEqual(money(null), "—");
  assert.strictEqual(money(undefined), "—");
  assert.ok(money(0).includes("$0.00"), "an actual zero is a figure");
});

check("negatives are signed and coloured", () => {
  const out = money(-125050);
  assert.ok(out.includes("-$1,250.50"));
  assert.ok(out.includes("#c62828"), "a loss should not look like a gain");
});

check("thousands are grouped", () => {
  assert.ok(money(123456789).includes("$1,234,567.89"));
});

// ── Safety ─────────────────────────────────────────────────

check("an account name cannot inject markup", () => {
  const html = renderPanel({
    title: "P&L",
    result: { ...GOOD, lines: [{ label: '<script>alert(1)</script>', amount_cents: 100, depth: 0, kind: "line" }] },
    headline: [],
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

check("an error message cannot inject markup", () => {
  const html = renderPanel({
    title: "P&L",
    result: { ok: false, reason: "error", detail: '</code><img src=x onerror=alert(1)>' },
    headline: [],
  });
  assert.ok(!/<img src=x/.test(html));
});

check("esc handles quotes, for attribute contexts", () => {
  assert.strictEqual(esc('a"b<c>d&e'), "a&quot;b&lt;c&gt;d&amp;e");
});

// ── The pages are actually wired ───────────────────────────
// Without this, the panels exist and no page shows them — which is precisely
// the state that had everything reading zero while the fetcher was deployed.

check("all three accounting pages render the panel", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  for (const [route, fn] of [
    ["/admin/accounting", "dashboardPanel"],
    ["/admin/accounting/income-statement", "profitAndLossPanel"],
    ["/admin/accounting/balance-sheet", "balanceSheetPanel"],
  ]) {
    assert.ok(server.includes(fn),
      `${route} does not call ${fn} — the page would go back to showing zeros`);
  }
  assert.ok(/body: qboTop \+ body/.test(server),
    "the panel must be rendered above the existing page, not instead of it");
});

check("the local ledger is kept, not replaced", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  for (const fn of ["renderDashboard", "renderIncomeStatement", "renderBalanceSheet"]) {
    assert.ok(server.includes(fn),
      `${fn} was removed — the local ledger is what pushes entries INTO QuickBooks and has to stay visible`);
  }
});

check("a panel failure cannot take the page down", () => {
  const src = fs.readFileSync(path.join(ROOT, "qbo-panel.js"), "utf8");
  assert.ok(/async function safely/.test(src));
  assert.ok(/catch \(e\)/.test(src),
    "every fetch is caught: a QuickBooks outage must not break a page that still has local content");
});

console.log(`\n${passed} checks passed\n`);
