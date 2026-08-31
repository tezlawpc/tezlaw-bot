// ============================================================
//  TEZ LAW P.C. — ACCOUNTING ADMIN UI
// ============================================================

const accounting = require("./accounting");

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const fmt$ = n => {
  const num = Number(n || 0);
  const sign = num < 0 ? "-" : "";
  return sign + "$" + Math.abs(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtDate = d => d ? new Date(d).toLocaleDateString() : "—";

// ─── Dashboard ──────────────────────────────────────────

async function renderDashboard() {
  const stats = await accounting.getStats();
  const recent = await accounting.getLedger({ limit: 10 });
  const trust = await accounting.getTrustReconciliation();

  // Recent entries preview
  const recentRows = recent.length ? recent.map(e => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px solid #eee; font-size:12px;">${fmtDate(e.entry_date)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #eee; font-size:13px;">${esc(e.description)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #eee; font-size:12px;">${esc(e.client_name || "")}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #eee; font-size:12px; text-align:right;">${(e.lines || []).length} line${(e.lines || []).length === 1 ? "" : "s"}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #eee; font-size:12px; text-align:right;">${fmt$((e.lines || []).reduce((s, l) => s + Number(l.debit || 0), 0))}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #eee;"><a href="/admin/accounting/entry/${e.id}" style="color:#0061FF; font-size:12px; text-decoration:none;">Open →</a></td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:40px; text-align:center; color:#888;">No entries yet. Click <strong>Sync from PI</strong> below to import.</td></tr>`;

  const trustBanner = !trust.is_reconciled && trust.bank_balance > 0 ? `
    <div style="background:#fee; padding:14px 18px; border-radius:8px; border-left:4px solid #c62828; margin-bottom:16px; font-size:13px;">
      <strong style="color:#c62828;">⚠ Trust account NOT RECONCILED</strong> — bank shows ${fmt$(trust.bank_balance)} but sum of client balances is ${fmt$(trust.sum_of_client_balances)} (variance: ${fmt$(trust.variance)})
      <a href="/admin/accounting/trust" style="color:#c62828; margin-left:10px; font-weight:600;">Investigate →</a>
    </div>` : "";

  return `
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <h1>💼 Accounting</h1>
        <div style="font-size:12px; color:#666; margin-top:4px;">Double-entry ledger with IOLTA trust compliance. Auto-syncs from PI disbursements.</div>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button onclick="syncFromPI()" style="background:#B79C62; color:white; padding:10px 18px; border-radius:6px; border:none; cursor:pointer; font-weight:600;">🔄 Sync from PI</button>
        <a href="/admin/accounting/new-entry" style="background:#0C1C36; color:white; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:600;">+ New Entry</a>
      </div>
    </div>

    ${trustBanner}

    <!-- Money stat tiles -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-bottom:20px;">
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Operating Cash</div>
        <div style="font-size:22px; font-weight:700; color:#0C1C36; margin-top:4px;">${fmt$(stats.operating_balance)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">IOLTA Trust</div>
        <div style="font-size:22px; font-weight:700; color:${trust.is_reconciled ? "#2e7d32" : "#c62828"}; margin-top:4px;">${fmt$(stats.trust_balance)}</div>
        <div style="font-size:11px; color:${trust.is_reconciled ? "#2e7d32" : "#c62828"}; margin-top:2px;">${trust.is_reconciled ? "✓ Reconciled" : "⚠ Variance " + fmt$(Math.abs(trust.variance))}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">YTD Revenue</div>
        <div style="font-size:22px; font-weight:700; color:#2e7d32; margin-top:4px;">${fmt$(stats.ytd_revenue)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">YTD Expenses</div>
        <div style="font-size:22px; font-weight:700; color:#0C1C36; margin-top:4px;">${fmt$(stats.ytd_expense)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">YTD Net Income</div>
        <div style="font-size:22px; font-weight:700; color:${stats.ytd_net_income >= 0 ? "#2e7d32" : "#c62828"}; margin-top:4px;">${fmt$(stats.ytd_net_income)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Open Invoices</div>
        <div style="font-size:22px; font-weight:700; color:#0C1C36; margin-top:4px;">${stats.open_invoices_count}</div>
        <div style="font-size:11px; color:#666; margin-top:2px;">${fmt$(stats.open_invoices_balance)} outstanding</div>
      </div>
    </div>

    <!-- Quick actions -->
    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
      <h3 style="margin:0 0 12px 0; font-size:14px; color:#0C1C36;">Reports & Exports</h3>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="/admin/accounting/ledger" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">📖 General Ledger</a>
        <a href="/admin/accounting/income-statement" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">📊 Income Statement (P&L)</a>
        <a href="/admin/accounting/balance-sheet" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">⚖️ Balance Sheet</a>
        <a href="/admin/accounting/trust" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">🔒 Trust Reconciliation</a>
        <a href="/admin/accounting/chart" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">📋 Chart of Accounts</a>
      </div>
      <h4 style="margin:16px 0 8px 0; font-size:12px; color:#666; text-transform:uppercase; letter-spacing:0.05em;">Exports</h4>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="/admin/accounting/export/excel" style="background:#217346; color:white; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">📗 Download Excel (.xlsx)</a>
        <a href="/admin/accounting/export/iif" style="background:#2CA01C; color:white; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">📥 QuickBooks Desktop (.iif)</a>
        <a href="/admin/accounting/export/csv" style="background:#2CA01C; color:white; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">📥 QuickBooks Online (.csv)</a>
      </div>
      <div style="font-size:11px; color:#888; margin-top:8px;">
        <strong>Desktop (IIF):</strong> File → Utilities → Import → IIF Files &nbsp;·&nbsp;
        <strong>Online (CSV):</strong> Banking → Upload transactions
      </div>
    </div>

    <!-- Recent entries -->
    <div style="background:white; border-radius:8px; border:1px solid #eee; overflow:hidden;">
      <div style="padding:12px 16px; background:#fafaf7; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
        <strong style="color:#0C1C36; font-size:14px;">Recent Journal Entries</strong>
        <a href="/admin/accounting/ledger" style="color:#0061FF; font-size:12px; text-decoration:none;">View all →</a>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead>
          <tr style="background:#fafaf7;">
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Date</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Description</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Client</th>
            <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Lines</th>
            <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Amount</th>
            <th style="padding:10px 12px; border-bottom:1px solid #eee;"></th>
          </tr>
        </thead>
        <tbody>${recentRows}</tbody>
      </table>
    </div>

    <script>
      async function syncFromPI() {
        if (!confirm("Sync all finalized PI disbursements and case costs into the accounting ledger?\\n\\nThis is safe to run multiple times — entries already imported are skipped.")) return;
        const btn = event.target;
        btn.disabled = true; btn.textContent = "⏳ Syncing…";
        try {
          const r = await fetch("/admin/accounting/sync-pi", { method: "POST" });
          const d = await r.json();
          if (d.ok) {
            alert("✓ Sync complete\\n\\nDisbursements imported: " + d.results.disbursements + "\\nCase costs imported: " + d.results.costs + (d.results.errors.length ? "\\nErrors: " + d.results.errors.length : ""));
            location.reload();
          } else {
            alert("Error: " + d.error);
            btn.disabled = false; btn.textContent = "🔄 Sync from PI";
          }
        } catch (e) {
          alert("Error: " + e.message);
          btn.disabled = false; btn.textContent = "🔄 Sync from PI";
        }
      }
    </script>`;
}

// ─── General Ledger ─────────────────────────────────────

async function renderLedger(query) {
  const from = query.from || "";
  const to = query.to || "";
  const client = query.client || "";
  const matter = query.matter || "";
  const account = query.account || "";

  const filters = {};
  if (from) filters.from_date = from;
  if (to) filters.to_date = to;
  if (client) filters.client_key = client;
  if (matter) filters.matter_type = matter;
  if (account) filters.account_number = account;

  const entries = await accounting.getLedger({ ...filters, limit: 500 });
  const accounts = await accounting.listAccounts();
  const accountOpts = accounts.map(a => `<option value="${a.account_number}" ${account === a.account_number ? "selected" : ""}>${a.account_number} ${esc(a.name)}</option>`).join("");

  const rowsHtml = entries.length ? entries.map(e => {
    const linesHtml = (e.lines || []).map(l => `
      <div style="display:grid; grid-template-columns:1fr 100px 100px; gap:8px; padding:2px 0; font-size:12px;">
        <div style="color:#555;">${l.account_number} ${esc(l.account_name)}${l.memo ? ' <span style="color:#888;">— ' + esc(l.memo) + '</span>' : ''}</div>
        <div style="text-align:right; color:${Number(l.debit) > 0 ? "#0C1C36" : "#ccc"};">${Number(l.debit) > 0 ? fmt$(l.debit) : ""}</div>
        <div style="text-align:right; color:${Number(l.credit) > 0 ? "#0C1C36" : "#ccc"};">${Number(l.credit) > 0 ? fmt$(l.credit) : ""}</div>
      </div>`).join("");
    return `
      <div style="background:white; padding:14px 16px; border:1px solid #eee; border-radius:6px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
          <div>
            <strong style="color:#0C1C36; font-size:13px;">${fmtDate(e.entry_date)}</strong>
            <span style="margin-left:10px; color:#555; font-size:13px;">${esc(e.description)}</span>
            ${e.reference ? `<span style="margin-left:8px; font-size:11px; color:#888;">[${esc(e.reference)}]</span>` : ""}
            ${e.is_trust ? '<span style="margin-left:8px; background:#B79C62; color:white; padding:1px 8px; border-radius:8px; font-size:10px;">TRUST</span>' : ""}
          </div>
          <div style="font-size:11px; color:#888;">
            ${esc(e.client_name || "")} ${e.matter_type ? "· " + esc(e.matter_type) : ""}
            <a href="/admin/accounting/entry/${e.id}" style="margin-left:8px; color:#0061FF; text-decoration:none;">#${e.id} →</a>
          </div>
        </div>
        <div style="border-top:1px solid #f0f0f0; padding-top:6px;">
          <div style="display:grid; grid-template-columns:1fr 100px 100px; gap:8px; font-size:10px; color:#888; text-transform:uppercase; letter-spacing:0.05em; padding-bottom:4px; border-bottom:1px solid #eee;">
            <div>Account</div><div style="text-align:right;">Debit</div><div style="text-align:right;">Credit</div>
          </div>
          ${linesHtml}
        </div>
      </div>`;
  }).join("") : `<div style="padding:40px; text-align:center; color:#888;">No entries match these filters.</div>`;

  return `
    <div class="page-header">
      <h1>📖 General Ledger</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #eee; margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
      <div><label style="font-size:11px; color:#888; display:block;">From</label><input type="date" name="from" value="${from}" style="padding:6px; border:1px solid #ccc; border-radius:4px;"></div>
      <div><label style="font-size:11px; color:#888; display:block;">To</label><input type="date" name="to" value="${to}" style="padding:6px; border:1px solid #ccc; border-radius:4px;"></div>
      <div><label style="font-size:11px; color:#888; display:block;">Account</label>
        <select name="account" style="padding:6px; border:1px solid #ccc; border-radius:4px; min-width:220px;"><option value="">All accounts</option>${accountOpts}</select>
      </div>
      <div><label style="font-size:11px; color:#888; display:block;">Client</label><input type="text" name="client" value="${esc(client)}" style="padding:6px; border:1px solid #ccc; border-radius:4px;" placeholder="client-key"></div>
      <div><label style="font-size:11px; color:#888; display:block;">Matter</label>
        <select name="matter" style="padding:6px; border:1px solid #ccc; border-radius:4px;"><option value="">All</option>
          <option value="pi" ${matter==="pi"?"selected":""}>Personal Injury</option>
          <option value="immigration" ${matter==="immigration"?"selected":""}>Immigration</option>
          <option value="business" ${matter==="business"?"selected":""}>Business Lit</option>
          <option value="ll_tenant" ${matter==="ll_tenant"?"selected":""}>LL/Tenant</option>
          <option value="estate" ${matter==="estate"?"selected":""}>Estate</option>
        </select>
      </div>
      <button type="submit" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Filter</button>
      <a href="/admin/accounting/ledger" style="padding:8px 16px; color:#666; text-decoration:none;">Clear</a>
    </form>

    <div style="font-size:12px; color:#666; margin-bottom:10px;">${entries.length} entr${entries.length === 1 ? "y" : "ies"}${entries.length === 500 ? " (limit reached — narrow the filters)" : ""}</div>
    ${rowsHtml}`;
}

// ─── Income Statement (P&L) ─────────────────────────────

async function renderIncomeStatement(query) {
  const today = new Date().toISOString().split("T")[0];
  const yearStart = new Date().getFullYear() + "-01-01";
  const from = query.from || yearStart;
  const to = query.to || today;
  const is = await accounting.getIncomeStatement(from, to);

  const revRows = is.revenues.length ? is.revenues.map(r => `
    <tr><td style="padding:8px 12px; padding-left:24px; border-bottom:1px solid #f0f0f0;">${r.account_number} — ${esc(r.name)}</td><td style="padding:8px 12px; border-bottom:1px solid #f0f0f0; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(r.amount)}</td></tr>
  `).join("") : `<tr><td colspan="2" style="padding:8px 24px; color:#888; font-style:italic;">(no revenue in period)</td></tr>`;
  const expRows = is.expenses.length ? is.expenses.map(e => `
    <tr><td style="padding:8px 12px; padding-left:24px; border-bottom:1px solid #f0f0f0;">${e.account_number} — ${esc(e.name)}</td><td style="padding:8px 12px; border-bottom:1px solid #f0f0f0; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(e.amount)}</td></tr>
  `).join("") : `<tr><td colspan="2" style="padding:8px 24px; color:#888; font-style:italic;">(no expenses in period)</td></tr>`;

  return `
    <div class="page-header">
      <h1>📊 Income Statement (P&L)</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #eee; margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
      <div><label style="font-size:11px; color:#888; display:block;">From</label><input type="date" name="from" value="${from}" style="padding:6px; border:1px solid #ccc; border-radius:4px;"></div>
      <div><label style="font-size:11px; color:#888; display:block;">To</label><input type="date" name="to" value="${to}" style="padding:6px; border:1px solid #ccc; border-radius:4px;"></div>
      <button type="submit" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Update</button>
    </form>

    <div style="background:white; padding:24px 32px; border-radius:8px; border:1px solid #eee; max-width:720px;">
      <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:700; color:#0C1C36;">Tez Law P.C.</div>
        <div style="font-size:15px; color:#0C1C36;">Income Statement</div>
        <div style="font-size:12px; color:#666;">${fmtDate(from)} to ${fmtDate(to)}</div>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tr><td colspan="2" style="padding:12px 0 6px 0; border-top:2px solid #0C1C36;"><strong style="color:#0C1C36;">REVENUE</strong></td></tr>
        ${revRows}
        <tr style="font-weight:700; background:#fafaf7;"><td style="padding:8px 12px;">Total Revenue</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(is.total_revenue)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:1px solid #eee;"><strong style="color:#0C1C36;">EXPENSES</strong></td></tr>
        ${expRows}
        <tr style="font-weight:700; background:#fafaf7;"><td style="padding:8px 12px;">Total Expenses</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(is.total_expense)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:2px solid #0C1C36;"></td></tr>
        <tr style="background:${is.net_income >= 0 ? "#e8f5e9" : "#fee"}; font-weight:700; font-size:16px;">
          <td style="padding:14px 12px;">NET INCOME</td>
          <td style="padding:14px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace; color:${is.net_income >= 0 ? "#2e7d32" : "#c62828"};">${fmt$(is.net_income)}</td>
        </tr>
      </table>
    </div>

    <div style="margin-top:16px;">
      <button onclick="window.print()" style="background:#0C1C36; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🖨️ Print</button>
    </div>`;
}

// ─── Balance Sheet ──────────────────────────────────────

async function renderBalanceSheet(query) {
  const today = new Date().toISOString().split("T")[0];
  const asOf = query.as_of || today;
  const bs = await accounting.getBalanceSheet(asOf);

  const bucketHtml = (items, label) => {
    const rows = items.length ? items.map(a => `
      <tr><td style="padding:6px 12px; padding-left:24px; border-bottom:1px solid #f0f0f0;">${a.account_number} — ${esc(a.name)}</td><td style="padding:6px 12px; border-bottom:1px solid #f0f0f0; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(a.amount)}</td></tr>
    `).join("") : `<tr><td colspan="2" style="padding:8px 24px; color:#888; font-style:italic;">(no ${label.toLowerCase()})</td></tr>`;
    return rows;
  };

  return `
    <div class="page-header">
      <h1>⚖️ Balance Sheet</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #eee; margin-bottom:16px; display:flex; gap:10px; align-items:end;">
      <div><label style="font-size:11px; color:#888; display:block;">As of</label><input type="date" name="as_of" value="${asOf}" style="padding:6px; border:1px solid #ccc; border-radius:4px;"></div>
      <button type="submit" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Update</button>
    </form>

    <div style="background:white; padding:24px 32px; border-radius:8px; border:1px solid #eee; max-width:720px;">
      <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:700; color:#0C1C36;">Tez Law P.C.</div>
        <div style="font-size:15px; color:#0C1C36;">Balance Sheet</div>
        <div style="font-size:12px; color:#666;">As of ${fmtDate(asOf)}</div>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tr><td colspan="2" style="padding:12px 0 6px 0; border-top:2px solid #0C1C36;"><strong style="color:#0C1C36;">ASSETS</strong></td></tr>
        ${bucketHtml(bs.assets, "assets")}
        <tr style="font-weight:700; background:#fafaf7;"><td style="padding:8px 12px;">Total Assets</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_assets)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:1px solid #eee;"><strong style="color:#0C1C36;">LIABILITIES</strong></td></tr>
        ${bucketHtml(bs.liabilities, "liabilities")}
        <tr style="font-weight:700; background:#fafaf7;"><td style="padding:8px 12px;">Total Liabilities</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_liabilities)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:1px solid #eee;"><strong style="color:#0C1C36;">EQUITY</strong></td></tr>
        ${bucketHtml(bs.equity, "equity")}
        <tr style="font-weight:700; background:#fafaf7;"><td style="padding:8px 12px;">Total Equity</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_equity)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:2px solid #0C1C36;"></td></tr>
        <tr style="background:#fafaf7; font-weight:700; font-size:14px;">
          <td style="padding:10px 12px;">Total Liabilities + Equity</td>
          <td style="padding:10px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_liabilities + bs.total_equity)}</td>
        </tr>
        ${Math.abs(bs.total_assets - (bs.total_liabilities + bs.total_equity)) > 0.01 ? `
        <tr><td colspan="2" style="padding:12px; background:#fee; color:#c62828; text-align:center; font-size:12px;">⚠ Balance sheet does not balance — variance ${fmt$(bs.total_assets - (bs.total_liabilities + bs.total_equity))}</td></tr>
        ` : ""}
      </table>
    </div>

    <div style="margin-top:16px;">
      <button onclick="window.print()" style="background:#0C1C36; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🖨️ Print</button>
    </div>`;
}

// ─── Trust Reconciliation ───────────────────────────────

async function renderTrustReconciliation(query) {
  const today = new Date().toISOString().split("T")[0];
  const asOf = query.as_of || today;
  const trust = await accounting.getTrustReconciliation(asOf);

  const clientRows = trust.client_balances.length ? trust.client_balances.map(c => `
    <tr>
      <td style="padding:10px 12px; border-bottom:1px solid #eee; font-size:13px;"><a href="/admin/accounting/trust/${encodeURIComponent(c.client_key)}" style="color:#0C1C36; text-decoration:none; font-weight:500;">${esc(c.client_name || c.client_key)}</a></td>
      <td style="padding:10px 12px; border-bottom:1px solid #eee; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(c.balance)}</td>
    </tr>
  `).join("") : `<tr><td colspan="2" style="padding:20px; text-align:center; color:#888; font-style:italic;">No client trust balances</td></tr>`;

  return `
    <div class="page-header">
      <h1>🔒 Trust Reconciliation</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    <div style="background:#f5f9ff; padding:14px 18px; border-radius:8px; border-left:4px solid #0061FF; margin-bottom:16px; font-size:13px;">
      <strong>CA Bar RRC 1.15:</strong> Trust account bank balance must always equal the sum of all client trust balances. Any variance requires immediate investigation.
    </div>

    <div style="background:${trust.is_reconciled ? "#e8f5e9" : "#fee"}; padding:20px; border-radius:8px; border-left:4px solid ${trust.is_reconciled ? "#2e7d32" : "#c62828"}; margin-bottom:20px;">
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:20px;">
        <div>
          <div style="font-size:11px; color:#666; text-transform:uppercase;">Bank Balance (1020)</div>
          <div style="font-size:22px; font-weight:700; color:#0C1C36; margin-top:4px;">${fmt$(trust.bank_balance)}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#666; text-transform:uppercase;">Sum of Client Ledgers</div>
          <div style="font-size:22px; font-weight:700; color:#0C1C36; margin-top:4px;">${fmt$(trust.sum_of_client_balances)}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#666; text-transform:uppercase;">Variance</div>
          <div style="font-size:22px; font-weight:700; color:${trust.is_reconciled ? "#2e7d32" : "#c62828"}; margin-top:4px;">${fmt$(trust.variance)}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#666; text-transform:uppercase;">Status</div>
          <div style="font-size:18px; font-weight:700; color:${trust.is_reconciled ? "#2e7d32" : "#c62828"}; margin-top:6px;">
            ${trust.is_reconciled ? "✓ RECONCILED" : "⚠ NOT RECONCILED"}
          </div>
        </div>
      </div>
    </div>

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #eee; margin-bottom:16px; display:flex; gap:10px; align-items:end;">
      <div><label style="font-size:11px; color:#888; display:block;">As of</label><input type="date" name="as_of" value="${asOf}" style="padding:6px; border:1px solid #ccc; border-radius:4px;"></div>
      <button type="submit" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Update</button>
    </form>

    <div style="background:white; border-radius:8px; border:1px solid #eee; overflow:hidden;">
      <div style="padding:12px 16px; background:#fafaf7; border-bottom:1px solid #eee;">
        <strong style="color:#0C1C36;">Per-Client Trust Balances (${trust.client_balances.length})</strong>
      </div>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#fafaf7;">
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Client</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Balance</th>
        </tr></thead>
        <tbody>${clientRows}</tbody>
      </table>
    </div>`;
}

// ─── Chart of Accounts ──────────────────────────────────

async function renderChartOfAccounts() {
  const accounts = await accounting.listAccounts();
  const typeColors = { asset: "#0C1C36", liability: "#c62828", equity: "#7c4dff", revenue: "#2e7d32", expense: "#e65100" };
  const grouped = {};
  for (const a of accounts) {
    if (!grouped[a.type]) grouped[a.type] = [];
    grouped[a.type].push(a);
  }

  const sections = ["asset", "liability", "equity", "revenue", "expense"].map(t => {
    if (!grouped[t]) return "";
    const accountRows = grouped[t].map(a => `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; font-family:ui-monospace, Menlo, monospace; font-size:12px; color:${typeColors[t]}; font-weight:600;">${a.account_number}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; font-size:13px;">${esc(a.name)}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; font-size:11px; color:#888;">${esc(a.subtype || "")}</td>
      </tr>
    `).join("");
    return `
      <div style="background:white; border-radius:8px; border:1px solid #eee; margin-bottom:16px; overflow:hidden;">
        <div style="padding:12px 16px; background:${typeColors[t]}; color:white;">
          <strong style="text-transform:uppercase; letter-spacing:0.05em;">${t}s</strong>
        </div>
        <table style="width:100%; border-collapse:collapse;">${accountRows}</table>
      </div>`;
  }).join("");

  return `
    <div class="page-header">
      <h1>📋 Chart of Accounts</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>
    <div style="font-size:12px; color:#666; margin-bottom:16px;">
      Standard law firm chart of accounts. ${accounts.length} accounts active. Trust accounts (2010, 1020) are governed by CA Bar RRC 1.15.
    </div>
    ${sections}`;
}

// ─── Client Trust Ledger ────────────────────────────────

async function renderClientTrustLedger(clientKey) {
  const entries = await accounting.getClientTrustLedger(clientKey);
  const clientName = entries[0]?.client_name || clientKey;

  const rows = entries.length ? entries.map(e => `
    <tr>
      <td style="padding:10px 12px; border-bottom:1px solid #eee; font-size:12px;">${fmtDate(e.transaction_date)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #eee; font-size:13px;">${esc(e.description)}${e.reference ? ' <span style="color:#888; font-size:11px;">[' + esc(e.reference) + ']</span>' : ''}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #eee; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; color:${Number(e.deposit_amount) > 0 ? "#2e7d32" : "#ccc"};">${Number(e.deposit_amount) > 0 ? "+" + fmt$(e.deposit_amount) : ""}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #eee; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; color:${Number(e.disburse_amount) > 0 ? "#c62828" : "#ccc"};">${Number(e.disburse_amount) > 0 ? "−" + fmt$(e.disburse_amount) : ""}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #eee; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; font-weight:600;">${fmt$(e.running_balance)}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" style="padding:40px; text-align:center; color:#888;">No trust transactions</td></tr>`;

  const currentBalance = entries.length ? Number(entries[entries.length - 1].running_balance) : 0;

  return `
    <div class="page-header">
      <h1>🔒 Trust Ledger — ${esc(clientName)}</h1>
      <a href="/admin/accounting/trust" class="back-link">← All trust balances</a>
    </div>

    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; margin-bottom:16px;">
      <div style="font-size:11px; color:#888; text-transform:uppercase;">Current Trust Balance</div>
      <div style="font-size:32px; font-weight:700; color:${currentBalance > 0 ? "#2e7d32" : "#0C1C36"}; margin-top:4px;">${fmt$(currentBalance)}</div>
      <div style="font-size:12px; color:#666; margin-top:4px;">${entries.length} transactions</div>
    </div>

    <div style="background:white; border-radius:8px; border:1px solid #eee; overflow:hidden;">
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#fafaf7;">
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Date</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Description</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Deposit</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Disburse</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Balance</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─── New manual entry form ──────────────────────────────

async function renderNewEntry() {
  const accounts = await accounting.listAccounts();
  const acctOpts = accounts.map(a => `<option value="${a.account_number}">${a.account_number} — ${esc(a.name)}</option>`).join("");
  return `
    <div class="page-header">
      <h1>+ New Journal Entry</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    <form id="entry-form" onsubmit="submitEntry(event)" style="background:white; padding:24px; border-radius:8px; border:1px solid #eee; max-width:900px;">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
        <div><label style="font-size:11px; color:#888;">Date</label><input type="date" name="entry_date" value="${new Date().toISOString().split("T")[0]}" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
        <div><label style="font-size:11px; color:#888;">Reference (invoice #, check #, etc)</label><input type="text" name="reference" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
        <div style="grid-column:1/-1;"><label style="font-size:11px; color:#888;">Description</label><input type="text" name="description" required style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
        <div><label style="font-size:11px; color:#888;">Client name (optional)</label><input type="text" name="client_name" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
        <div><label style="font-size:11px; color:#888;">Matter type</label>
          <select name="matter_type" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">
            <option value="">—</option>
            <option value="immigration">Immigration</option>
            <option value="pi">Personal Injury</option>
            <option value="business">Business Lit</option>
            <option value="ll_tenant">LL/Tenant</option>
            <option value="estate">Estate</option>
          </select>
        </div>
      </div>

      <h3 style="font-size:14px; color:#0C1C36; margin:20px 0 8px 0;">Lines (must balance: debits = credits)</h3>
      <div id="lines-container">
        <div class="line-row" style="display:grid; grid-template-columns:2fr 1fr 1fr 2fr auto; gap:8px; margin-bottom:8px;">
          <select name="account_0" required style="padding:8px; border:1px solid #ccc; border-radius:4px;"><option value="">— account —</option>${acctOpts}</select>
          <input type="number" name="debit_0" placeholder="Debit" step="0.01" min="0" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
          <input type="number" name="credit_0" placeholder="Credit" step="0.01" min="0" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
          <input type="text" name="memo_0" placeholder="Memo" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
          <button type="button" onclick="removeLine(this)" style="background:none; border:none; color:#c62828; cursor:pointer;">×</button>
        </div>
        <div class="line-row" style="display:grid; grid-template-columns:2fr 1fr 1fr 2fr auto; gap:8px; margin-bottom:8px;">
          <select name="account_1" required style="padding:8px; border:1px solid #ccc; border-radius:4px;"><option value="">— account —</option>${acctOpts}</select>
          <input type="number" name="debit_1" placeholder="Debit" step="0.01" min="0" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
          <input type="number" name="credit_1" placeholder="Credit" step="0.01" min="0" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
          <input type="text" name="memo_1" placeholder="Memo" style="padding:8px; border:1px solid #ccc; border-radius:4px;">
          <button type="button" onclick="removeLine(this)" style="background:none; border:none; color:#c62828; cursor:pointer;">×</button>
        </div>
      </div>
      <button type="button" onclick="addLine()" style="background:#f5f2ea; color:#0C1C36; border:none; padding:8px 14px; border-radius:4px; cursor:pointer; font-size:12px;">+ Add Line</button>

      <div style="margin-top:20px; padding-top:16px; border-top:1px solid #eee;">
        <button type="submit" style="background:#0C1C36; color:white; padding:12px 24px; border:none; border-radius:6px; cursor:pointer; font-weight:600;">Post Entry</button>
      </div>
    </form>

    <script>
      const ACCT_OPTS = \`${acctOpts.replace(/`/g, "\\`")}\`;
      let lineIdx = 2;
      function addLine() {
        const div = document.createElement("div");
        div.className = "line-row";
        div.style = "display:grid; grid-template-columns:2fr 1fr 1fr 2fr auto; gap:8px; margin-bottom:8px;";
        div.innerHTML = '<select name="account_' + lineIdx + '" required style="padding:8px; border:1px solid #ccc; border-radius:4px;"><option value="">— account —</option>' + ACCT_OPTS + '</select>' +
          '<input type="number" name="debit_' + lineIdx + '" placeholder="Debit" step="0.01" min="0" style="padding:8px; border:1px solid #ccc; border-radius:4px;">' +
          '<input type="number" name="credit_' + lineIdx + '" placeholder="Credit" step="0.01" min="0" style="padding:8px; border:1px solid #ccc; border-radius:4px;">' +
          '<input type="text" name="memo_' + lineIdx + '" placeholder="Memo" style="padding:8px; border:1px solid #ccc; border-radius:4px;">' +
          '<button type="button" onclick="removeLine(this)" style="background:none; border:none; color:#c62828; cursor:pointer;">×</button>';
        document.getElementById("lines-container").appendChild(div);
        lineIdx++;
      }
      function removeLine(btn) { btn.parentElement.remove(); }
      async function submitEntry(e) {
        e.preventDefault();
        const form = e.target;
        const fd = new FormData(form);
        const data = { entry_date: fd.get("entry_date"), description: fd.get("description"), reference: fd.get("reference"), client_name: fd.get("client_name"), matter_type: fd.get("matter_type"), lines: [] };
        const rows = form.querySelectorAll(".line-row");
        rows.forEach((row, i) => {
          const acct = row.querySelector('[name^="account_"]').value;
          if (!acct) return;
          data.lines.push({
            account_number: acct,
            debit: parseFloat(row.querySelector('[name^="debit_"]').value) || 0,
            credit: parseFloat(row.querySelector('[name^="credit_"]').value) || 0,
            memo: row.querySelector('[name^="memo_"]').value,
          });
        });
        try {
          const r = await fetch("/admin/accounting/entry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
          const d = await r.json();
          if (d.ok) location.href = "/admin/accounting/entry/" + d.id;
          else alert("Error: " + d.error);
        } catch (e) { alert("Error: " + e.message); }
      }
    </script>`;
}

module.exports = {
  renderDashboard,
  renderLedger,
  renderIncomeStatement,
  renderBalanceSheet,
  renderTrustReconciliation,
  renderChartOfAccounts,
  renderClientTrustLedger,
  renderNewEntry,
};
