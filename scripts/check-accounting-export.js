/**
 * check-accounting-export.js
 *
 * "Reports & exports are not pulling anything."
 *
 * They were pulling exactly what they were asked to: tezlaw-bot's own
 * journal, which fills only when somebody keys an entry in. Nobody does — the
 * firm's books are in QuickBooks — so all three export buttons handed back a
 * file with column headers and no rows.
 *
 * That is the same failure as the dashboard's six zeros, in a worse place. A
 * workbook of zeros does not read as an empty table; it reads as the firm's
 * year, and it is the artefact that goes to an accountant or an auditor.
 *
 * Two different fixes, because the three exports are two different things:
 *
 *   .xlsx  is for a person to read. It now carries QuickBooks' own profit and
 *          loss and balance sheet alongside the local ledger, with a first
 *          sheet naming the source of every other sheet — because two sets of
 *          books in one workbook that does not say which is which will be
 *          read as one.
 *
 *   .iif / .csv  exist to carry local entries INTO QuickBooks. With none to
 *          carry, the honest answer is not an empty file that imports
 *          nothing; it is a page saying so and pointing at the workbook that
 *          does have the figures.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

require("./lib/stub-pg").install();

const ROOT = path.join(__dirname, "..");
const accounting = require(path.join(ROOT, "accounting.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const acct = fs.readFileSync(path.join(ROOT, "accounting.js"), "utf8");
const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

console.log("\nAccounting exports\n");

// ── A route can ask before it serves a download ────────────

check("exportCounts is exported and reports both sources", () => {
  assert.strictEqual(typeof accounting.exportCounts, "function");
  assert.strictEqual(typeof accounting.quickbooksSource, "function");
  const i = acct.indexOf("async function exportCounts");
  const body = acct.slice(i, acct.indexOf("async function quickbooksSource"));
  assert.ok(/quickbooks: await quickbooksSource\(\)/.test(body),
    "a route saying 'nothing to export' should be able to say where the numbers are instead");
});

check("a failed count does not masquerade as zero", () => {
  // Returning 0 on a query error would make the route claim there is nothing
  // to export when it simply could not tell.
  const i = acct.indexOf("async function exportCounts");
  const body = acct.slice(i, acct.indexOf("async function quickbooksSource"));
  assert.ok(/entries: null/.test(body));
  assert.ok(/emptiness is not established/.test(body),
    "the reason belongs next to the code");
});

check("only a production QuickBooks connection counts as a source", () => {
  const i = acct.indexOf("async function quickbooksSource");
  const body = acct.slice(i, acct.indexOf("// ─── Export: Excel", i));
  assert.ok(/env !== "production"/.test(body));
  assert.ok(/sandbox, not the firm's books/.test(body),
    "sandbox figures in an accountant's workbook would be worse than none");
});

// ── The workbook says where every sheet came from ──────────

check("the first sheet is the source, not a figure", () => {
  const i = acct.indexOf("async function exportToExcel");
  const body = acct.slice(i, acct.indexOf('XLSX.utils.book_append_sheet(wb, ws1', i));
  assert.ok(/"Source"/.test(body), "no source sheet");
  assert.ok(body.indexOf('"Source"') < body.length,
    "it must be appended before the ledger sheet so it lands first in the workbook");
});

check("it distinguishes the two sets of books by name", () => {
  assert.ok(/Sheets 1-5 — from tezlaw-bot's own ledger/.test(acct));
  assert.ok(/Sheets 6-7 — from QuickBooks/.test(acct));
});

check("an empty local ledger is explained, not left to be guessed at", () => {
  assert.ok(/NOT because the firm had no activity/.test(acct),
    "five empty sheets with no explanation is the bug, not the fix");
});

check("the QuickBooks company and realm are named", () => {
  // Which company the figures came from was invisible for months while the
  // app was quietly talking to a sandbox.
  assert.ok(/realm " \+ qbSrc\.realm/.test(acct));
  assert.ok(/qbSrc\.company \|\| "connected company"/.test(acct));
});

// ── The workbook carries the real numbers ──────────────────

check("QuickBooks' profit and loss and balance sheet are included", () => {
  assert.ok(/"QB Profit and Loss"/.test(acct));
  assert.ok(/"QB Balance Sheet"/.test(acct));
  assert.ok(/reports\.profitAndLoss\(/.test(acct) && /reports\.balanceSheet\(/.test(acct));
});

check("the export's date range is passed through to QuickBooks", () => {
  assert.ok(/start_date: from_date \|\| undefined, end_date: to_date \|\| undefined/.test(acct),
    "a workbook for one period with QuickBooks sheets for another is worse than no sheets");
  assert.ok(/as_of: to_date \|\| undefined/.test(acct), "a balance sheet is as-of a date");
});

check("amounts are written as numbers, not strings", () => {
  // An accountant has to be able to sum the column.
  assert.ok(/l\.amount_cents == null \? "" : l\.amount_cents \/ 100/.test(acct));
});

check("the QuickBooks account id travels with each line", () => {
  // So a figure in the workbook can be traced back to the account it came
  // from, which is how the dashboard tiles are matched too.
  assert.ok(/"QuickBooks account id": l\.account_id/.test(acct));
});

check("a QuickBooks outage still produces the workbook", () => {
  const i = acct.indexOf('if (qbSrc.available) {');
  const body = acct.slice(i, acct.indexOf('return XLSX.write', i));
  assert.ok(/catch \(e\)/.test(body));
  assert.ok(/"QB \(unavailable\)"/.test(body),
    "and says so in the workbook rather than silently dropping two sheets");
});

// ── The import files refuse to be empty ────────────────────

check("the .iif and .csv routes check before serving", () => {
  const n = (srv.match(/if \(counts\.entries === 0\) \{/g) || []).length;
  assert.strictEqual(n, 2, "both import formats need the guard");
  assert.ok(/nothingToExportPage\("a QuickBooks Desktop \.iif file", counts\)/.test(srv));
  assert.ok(/nothingToExportPage\("a QuickBooks Online \.csv file", counts\)/.test(srv));
});

check("the guard triggers only on a known zero, never on an unknown", () => {
  // exportCounts returns null when it could not count. `=== 0` is deliberate:
  // `!counts.entries` would also catch null and refuse a download that should
  // have been served.
  assert.ok(!/if \(!counts\.entries\)/.test(srv),
    "a loose check would refuse to export when the count merely failed");
});

check("the page says where the real figures are", () => {
  const i = srv.indexOf("function nothingToExportPage");
  const body = srv.slice(i, srv.indexOf('app.get("/admin/accounting/export/excel"', i));
  assert.ok(/\/admin\/accounting\/export\/excel/.test(body),
    "a dead end is not an answer; point at the export that works");
  assert.ok(/system of record/.test(body));
});

check("the Excel export is never refused", () => {
  // It carries QuickBooks' sheets, so it is useful even with no local
  // entries at all.
  const i = srv.indexOf('app.get("/admin/accounting/export/excel"');
  const body = srv.slice(i, srv.indexOf('app.get("/admin/accounting/export/iif"', i));
  assert.ok(!/counts\.entries === 0/.test(body));
});

check("the page escapes what it interpolates", () => {
  const i = srv.indexOf("function nothingToExportPage");
  const body = srv.slice(i, srv.indexOf('app.get("/admin/accounting/export/excel"', i));
  // Company name and error text come from QuickBooks and from exceptions.
  const n = (body.match(/replace\(\/\[<>&\]\/g, ""\)/g) || []).length;
  assert.ok(n >= 2, `only ${n} of the interpolated values are stripped`);
});

console.log(`\n${passed} checks passed\n`);
