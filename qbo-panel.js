// ============================================================
//  qbo-panel.js — the firm's real numbers, on the page
//  Tez Law P.C.
//
//  The income statement, balance sheet and dashboard read tezlaw-bot's own
//  ledger tables, which fill only when somebody hand-keys an entry. Nobody
//  does, because the firm's books are in QuickBooks. So every figure was zero,
//  and a zero on an income statement does not read as "no data" — it reads as
//  a fact about the firm.
//
//  This renders QuickBooks' own reports above whatever the page already shows,
//  rather than replacing it. Two reasons for sitting alongside rather than on
//  top: the local ledger is still the thing that pushes entries INTO
//  QuickBooks, so it has to stay visible; and when the two disagree, an
//  attorney should see both numbers rather than be handed one of them.
//
//  Every failure is stated rather than rendered as zero. Not connected, a
//  sandbox realm, an unparsable report, an expired token — each says what
//  happened and what to do, because the whole reason this took a day to find
//  was a screen that showed 0.00 and looked confident about it.
// ============================================================

const brand = { gold: "#A34C00", navy: "#2B2523" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(cents) {
  if (cents == null) return "—";
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `<span style="color:${neg ? "#c62828" : "inherit"}">${neg ? "-" : ""}$${s}</span>`;
}

function notice(kind, html) {
  const style = {
    error: "background:#ffebee; border-left:4px solid #c62828;",
    warn: "background:#fff8e1; border-left:4px solid #f57f17;",
    info: "background:#f5f9ff; border-left:4px solid #0061FF;",
  }[kind] || "background:#f5f5f5; border-left:4px solid #999;";
  return `<div style="${style} padding:14px 18px; border-radius:4px; margin-bottom:16px; font-size:13px; line-height:1.6;">${html}</div>`;
}

function tile(label, cents, accent) {
  return `
    <div style="flex:1; min-width:150px; background:white; border:1px solid #eee; border-top:3px solid ${accent}; border-radius:6px; padding:14px 16px;">
      <div style="font-size:11px; color:#777; text-transform:uppercase; letter-spacing:.5px;">${esc(label)}</div>
      <div style="font-size:21px; font-weight:600; color:${brand.navy}; margin-top:6px;">${money(cents)}</div>
    </div>`;
}

/** The lines of a report, indented the way QuickBooks nests them. */
function lineRows(lines) {
  return lines.map(l => {
    const bold = l.kind === "summary" || l.kind === "header";
    const pad = 12 + l.depth * 18;
    return `
      <tr style="${bold ? "background:#FAF8F5;" : ""}">
        <td style="padding:7px 12px 7px ${pad}px; font-size:13px; ${bold ? `font-weight:600; color:${brand.navy};` : "color:#444;"}">${esc(l.label)}</td>
        <td style="padding:7px 16px; text-align:right; font-size:13px; font-variant-numeric:tabular-nums; ${bold ? "font-weight:600;" : ""}">${money(l.amount_cents)}</td>
      </tr>`;
  }).join("");
}

function freshness(r) {
  if (!r || !r.fetched_at) return "";
  const when = new Date(r.fetched_at).toLocaleString();
  const cached = r.from_cache ? " (cached)" : "";
  return `<div style="font-size:11px; color:#999; margin-top:8px;">Read from QuickBooks ${esc(when)}${cached}. <a href="?refresh=1" style="color:${brand.gold};">Refresh</a></div>`;
}

/**
 * One panel. `result` is either { ok: false, reason, detail } or the shape
 * qbo-reports returns, with `headline` naming the figures to tile.
 */
function renderPanel({ title, result, headline = [], showLines = true }) {
  const head = `<h2 style="margin:22px 0 10px 0; font-size:16px; color:${brand.navy};">${esc(title)}</h2>`;

  if (!result || result.ok === false) {
    const reason = (result && result.reason) || "unavailable";
    const detail = (result && result.detail) || "";
    if (reason === "not_connected") {
      return head + notice("warn",
        `<b>QuickBooks is not connected.</b> These figures come from your QuickBooks books, so there is nothing to show until it is. ` +
        `<a href="/admin/accounting/quickbooks" style="color:${brand.gold};">Connect it</a>.`);
    }
    if (reason === "sandbox") {
      return head + notice("error",
        `<b>This connection points at the QuickBooks sandbox, not your books.</b> Anything shown from it would be meaningless, so nothing is shown. ` +
        `<a href="/admin/accounting/quickbooks" style="color:${brand.gold};">Reconnect</a> to your real company.`);
    }
    return head + notice("error",
      `<b>Could not read this report from QuickBooks.</b><br><code style="font-size:12px;">${esc(detail)}</code><br>` +
      `This is a read failure, not a statement that the figures are zero.`);
  }

  const tiles = headline
    .filter(h => result[h.key] !== undefined)
    .map(h => tile(h.label, result[h.key], h.accent || brand.gold))
    .join("");

  // A report that parsed to nothing is not a firm with no income.
  const empty = !result.lines || result.lines.length === 0;
  const parseNote = result.parse_error
    ? notice("warn", `<b>Part of this report could not be read.</b> <code style="font-size:12px;">${esc(result.parse_error)}</code> The lines below are what was understood.`)
    : (result.unparsed > 0
        ? notice("warn", `${result.unparsed} row(s) in this report were in a shape this page does not recognise and are not shown. The totals come from QuickBooks and are unaffected.`)
        : "");

  const period = result.header && result.header.start_period
    ? `<div style="font-size:12px; color:#777; margin-bottom:10px;">${esc(result.header.start_period)} to ${esc(result.header.end_period || "")}${result.header.currency ? " &middot; " + esc(result.header.currency) : ""}</div>`
    : "";

  const staleNote = result.error
    ? notice("warn", esc(result.error))
    : "";

  if (empty) {
    return head + period + staleNote + parseNote + notice("info",
      `QuickBooks returned this report with no lines for the period. That is QuickBooks' answer, not a failure to read it — check the date range in QuickBooks if you expected figures.`) + freshness(result);
  }

  return head + period + staleNote + parseNote +
    (tiles ? `<div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:14px;">${tiles}</div>` : "") +
    (showLines ? `
      <div style="background:white; border:1px solid #eee; border-radius:6px; overflow:hidden;">
        <table style="width:100%; border-collapse:collapse;">${lineRows(result.lines)}</table>
      </div>` : "") +
    freshness(result);
}

// ─── Gathering ───────────────────────────────────────
// Each fetch is caught on its own and turned into something the panel can
// state plainly. A thrown error here would take down a page that still has
// perfectly good local content below it.

async function safely(fn) {
  const qbo = require("./qbo-sync");
  try {
    const status = await qbo.getSyncStatus();
    if (!status.connected) return { ok: false, reason: "not_connected" };
    const env = status.environment || process.env.QBO_ENVIRONMENT || "sandbox";
    if (env !== "production") return { ok: false, reason: "sandbox" };
    return await fn();
  } catch (e) {
    console.warn("[qbo-panel]", e.message);
    return { ok: false, reason: "error", detail: e.message };
  }
}

async function profitAndLossPanel(query = {}) {
  const reports = require("./qbo-reports");
  const result = await safely(() => reports.profitAndLoss(
    { start_date: query.start_date || undefined, end_date: query.end_date || undefined },
    { force: query.refresh === "1" }
  ));
  return renderPanel({
    title: "From QuickBooks — Profit and Loss",
    result,
    headline: [
      { key: "income_cents", label: "Income", accent: "#2e7d32" },
      { key: "expenses_cents", label: "Expenses", accent: "#c62828" },
      { key: "net_income_cents", label: "Net income", accent: brand.gold },
    ],
  });
}

async function balanceSheetPanel(query = {}) {
  const reports = require("./qbo-reports");
  const result = await safely(() => reports.balanceSheet(
    { as_of: query.as_of || undefined },
    { force: query.refresh === "1" }
  ));
  return renderPanel({
    title: "From QuickBooks — Balance Sheet",
    result,
    headline: [
      { key: "assets_cents", label: "Assets", accent: "#2e7d32" },
      { key: "liabilities_cents", label: "Liabilities", accent: "#c62828" },
      { key: "equity_cents", label: "Equity", accent: brand.gold },
    ],
  });
}

/** Compact: headline figures only, for the dashboard. */
async function dashboardPanel(query = {}) {
  const reports = require("./qbo-reports");
  const pl = await safely(() => reports.profitAndLoss({}, { force: query.refresh === "1" }));
  const bs = await safely(() => reports.balanceSheet({}, { force: query.refresh === "1" }));

  // One shared failure message rather than the same banner twice.
  if (pl.ok === false && bs.ok === false) {
    return renderPanel({ title: "From QuickBooks", result: pl, headline: [] });
  }

  const tiles = [
    pl.ok === false ? "" : tile("Income, year to date", pl.income_cents, "#2e7d32"),
    pl.ok === false ? "" : tile("Expenses, year to date", pl.expenses_cents, "#c62828"),
    pl.ok === false ? "" : tile("Net income", pl.net_income_cents, brand.gold),
    bs.ok === false ? "" : tile("Assets", bs.assets_cents, "#0061FF"),
    bs.ok === false ? "" : tile("Liabilities", bs.liabilities_cents, "#6a1b9a"),
  ].filter(Boolean).join("");

  return `
    <h2 style="margin:22px 0 10px 0; font-size:16px; color:${brand.navy};">From QuickBooks</h2>
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:6px;">${tiles}</div>
    <div style="font-size:11px; color:#999; margin-bottom:16px;">
      Your books, read from QuickBooks. The figures below this come from tezlaw-bot's own ledger, which is what pushes entries into QuickBooks.
      <a href="/admin/accounting/income-statement" style="color:${brand.gold};">Full profit and loss</a>
    </div>`;
}

module.exports = {
  renderPanel,
  profitAndLossPanel,
  balanceSheetPanel,
  dashboardPanel,
  // Pure, for the checks.
  money,
  lineRows,
  esc,
};
