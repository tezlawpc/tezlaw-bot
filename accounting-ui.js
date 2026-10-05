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

// ─── Saying the trust status honestly ───────────────────────
//
// Green beside IOLTA TRUST is read as "the three-way reconciliation was done
// and it balanced" — the RRC 1.15 duty itself. So green is reserved for the
// one status that earns it. The two states where no claim can be made are
// grey, not red: red says the books disagree, which is a different and
// separately urgent problem, and dressing "no data" up as a variance would
// send somebody hunting for a discrepancy that does not exist.
const TRUST_GREEN = "#2F6B3F", TRUST_RED = "#9C2B1E", TRUST_GREY = "#5E5854";

function trustColor(trust) {
  if (!trust) return TRUST_GREY;
  if (trust.reconcile_status === "reconciled") return TRUST_GREEN;
  if (trust.reconcile_status === "variance") return TRUST_RED;
  return TRUST_GREY;   // no_data, unverified, or a shape we do not recognise
}

function trustCaption(trust) {
  if (!trust) return "No trust reconciliation available";
  switch (trust.reconcile_status) {
    case "reconciled": return "✓ Reconciled";
    case "variance":   return "⚠ Variance " + fmt$(Math.abs(trust.variance || 0));
    case "no_data":    return "No trust activity recorded";
    case "unverified": return "Not verified — app transactions are not on the ledger";
    default:           return "Reconciliation status unknown";
  }
}

// ─── The second figure ──────────────────────────────────────
//
// Client trust is recorded in two places that have never been joined. The
// staff app writes trust_transactions; the accounting module writes
// accounting_trust_ledger and reconciles only that one. So the RRC 1.15
// figure on this page has been computed from one of the firm's two trust
// records, and nothing on screen said which.
//
// Both are now shown side by side, and neither is presented as the answer.
// Merging them for real means deciding which rows are the same transaction
// recorded twice, and that is a judgement about the firm's money that an
// attorney makes, not one this page should make quietly. Until then: two
// columns, the difference named, and the duplicates it would have to resolve
// listed out.

/** Cents to a plain $ string, for figures that come from trust-ledger. */
const c$ = cents => cents == null ? "—" : (cents < 0 ? "-$" : "$") +
  (Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * The merged ledger, or a reason it is missing.
 *
 * trust-ledger reads both tables and writes nothing. It is wrapped here
 * because this page's whole job is the reconciliation the accounting side
 * already computes — a second opinion failing must not take that away.
 */
async function bothLedgers() {
  try {
    return { ok: true, data: await require("./trust-ledger").allClients() };
  } catch (e) {
    console.warn("[accounting-ui] merged trust ledger unavailable:", e.message);
    return { ok: false, error: e.message };
  }
}

const PROBLEM_LABEL = {
  possible_duplicate: "Possibly the same transaction in both ledgers",
  balance_mismatch: "A stored running balance disagrees with date order",
  negative_balance: "A client's balance goes below zero",
};

/**
 * What the merge found. Duplicates first: they are the reason the combined
 * figure may be overstated, so they are what makes the difference between
 * the two columns readable rather than alarming.
 */
function mergeProblems(data) {
  const problems = (data && data.problems) || [];
  if (!problems.length) return "";
  const byKind = {};
  for (const p of problems) (byKind[p.kind] = byKind[p.kind] || []).push(p);
  const order = ["possible_duplicate", "balance_mismatch", "negative_balance"];
  const kinds = [...order.filter(k => byKind[k]), ...Object.keys(byKind).filter(k => !order.includes(k))];

  return `
    <div style="background:#FBEDEA; padding:16px 18px; border-radius:8px; border-left:4px solid #9C2B1E; margin-bottom:20px;">
      <strong style="color:#9C2B1E;">${problems.length} thing${problems.length === 1 ? "" : "s"} to resolve before these two ledgers can be merged</strong>
      ${kinds.map(kind => {
        const rows = byKind[kind];
        return `
        <div style="margin-top:12px;">
          <div style="font-size:12px; font-weight:600; color:#2B2523;">${esc(PROBLEM_LABEL[kind] || kind)} (${rows.length})</div>
          <ul style="margin:6px 0 0 0; padding-left:20px; font-size:12px; color:#2B2523; line-height:1.7;">
            ${rows.slice(0, 12).map(p => `<li>${p.client_key ? `<a href="/admin/accounting/trust/${encodeURIComponent(p.client_key)}" style="color:#9C2B1E;">${esc(p.client_key)}</a> — ` : ""}${esc(p.detail || "")}</li>`).join("")}
            ${rows.length > 12 ? `<li style="color:#5E5854;">…and ${rows.length - 12} more</li>` : ""}
          </ul>
        </div>`;
      }).join("")}
    </div>`;
}

function trustStatusLine(trust) {
  if (!trust) return "—";
  switch (trust.reconcile_status) {
    case "reconciled": return "✓ RECONCILED";
    case "variance":   return "⚠ NOT RECONCILED";
    case "no_data":    return "NOTHING TO RECONCILE";
    case "unverified": return "CANNOT BE VERIFIED";
    default:           return "STATUS UNKNOWN";
  }
}

/**
 * The company switcher.
 *
 * Every accounting screen is now scoped to one set of books, and the two
 * render identically — same tiles, same layout, same currency. Without the
 * company named at the top of the page, somebody reads the other business's
 * numbers believing they are the firm's, and nothing on screen contradicts
 * them. So this is not navigation chrome; it is the label that makes the
 * figures below it mean anything.
 */
/**
 * A hidden company_id for the GET filter forms.
 *
 * Without it, changing a date range on the business's income statement
 * submits without company_id and lands back on the law firm — same layout,
 * same headings, different company. The switcher above would correct itself,
 * but only if somebody looked at it.
 */
function companyField(cid) {
  return cid ? `<input type="hidden" name="company_id" value="${Number(cid)}">` : "";
}

async function companySwitcher(currentId, basePath = "/admin/accounting") {
  let companies = [];
  try { companies = await accounting.listCompanies(); } catch { return ""; }
  if (companies.length < 2) return "";          // nothing to switch between
  const cur = companies.find(c => Number(c.id) === Number(currentId)) || companies[0];
  const tabs = companies.map(c => {
    const on = Number(c.id) === Number(cur.id);
    const sep = basePath.includes("?") ? "&" : "?";
    return `<a href="${esc(basePath)}${sep}company_id=${c.id}"
       style="padding:6px 14px; border-radius:6px; font-size:13px; text-decoration:none;
              ${on ? "background:#2B2523; color:#fff; font-weight:600;"
                   : "background:#fff; color:#2B2523; border:1px solid #E8E3DC;"}">
       ${esc(c.name)}${c.is_law_firm ? " <span style=\"opacity:.65; font-weight:400;\">· law firm</span>" : ""}
     </a>`;
  }).join(" ");
  return `<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:14px;">
      <span style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:.05em;">Books</span>
      ${tabs}
    </div>`;
}

// ─── Dashboard ──────────────────────────────────────────

async function renderDashboard(query = {}) {
  const cid = Number(query.company_id) > 0 ? Number(query.company_id) : null;
  const stats = await accounting.getStats(cid);
  const recent = await accounting.getLedger({ limit: 10, company_id: cid });

  // Trust reconciliation is the law firm's by definition, so it is only shown
  // on the firm's dashboard. Rendered on the other entity it would be the
  // firm's figures under the other company's heading.
  const trust = stats.is_law_firm ? await accounting.getTrustReconciliation() : null;

  const switcher = await companySwitcher(stats.company_id, "/admin/accounting");
  // Every link off this page keeps the selected company. Without it, a click
  // from the business dashboard to the ledger silently shows the law firm.
  const qs = cid ? `?company_id=${cid}` : "";

  // Also fetch QBO status for prominent card
  let qboStatus = null;
  try { qboStatus = await require("./qbo-sync").getSyncStatus(cid); } catch {}
  const qboConnected = qboStatus?.connected;
  const qboConfigured = qboStatus?.configured;
  const qboAutoOn = qboStatus?.auto_push_enabled;

  // Prominent QuickBooks card at top
  const qboCard = `
    <div style="background:${qboConnected ? "linear-gradient(135deg, #EEF5EF, #EEF5EF)" : "linear-gradient(135deg, #FFF3E6, #FFF3E6)"}; padding:20px 24px; border-radius:8px; border-left:4px solid ${qboConnected ? "#2F6B3F" : "#FF7B00"}; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div>
          <div style="font-size:15px; font-weight:700; color:#2B2523;">
            🔗 QuickBooks Online ${qboConnected ? `<span style="color:#2F6B3F;">✓ Connected</span>` : `<span style="color:#A34C00;">— Not connected</span>`}
          </div>
          <div style="font-size:12px; color:#5E5854; margin-top:4px;">
            ${qboConnected
              ? `Auto-push: <strong>${qboAutoOn ? "ON — every entry pushes to QBO instantly" : "OFF — turn on for real-time sync"}</strong>${qboStatus?.unsynced_entries > 0 ? " · " + qboStatus.unsynced_entries + " pending" : ""}`
              : (qboConfigured
                  ? "Click Connect below to authorize Tez Law's access to your QuickBooks Online account"
                  : "Setup takes ~10 minutes — get your Client ID from Intuit Developer Portal")}
          </div>
        </div>
        <a href="/admin/accounting/quickbooks" style="background:${qboConnected ? "#2B2523" : "#2F6B3F"}; color:white; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px; white-space:nowrap;">
          ${qboConnected ? "⚙ Manage Sync" : "🔗 Connect QuickBooks →"}
        </a>
      </div>
    </div>`;

  // Recent entries preview
  const recentRows = recent.length ? recent.map(e => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-size:12px;">${fmtDate(e.entry_date)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-size:13px;">${esc(e.description)}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-size:12px;">${esc(e.client_name || "")}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-size:12px; text-align:right;">${(e.lines || []).length} line${(e.lines || []).length === 1 ? "" : "s"}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-size:12px; text-align:right;">${fmt$((e.lines || []).reduce((s, l) => s + Number(l.debit || 0), 0))}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC;"><a href="/admin/accounting/entry/${e.id}" style="color:#A34C00; font-size:12px; text-decoration:none;">Open →</a></td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:40px; text-align:center; color:#5E5854;">No entries yet. Use the quick actions below to record fees, retainers, or expenses for any practice area.</td></tr>`;

  // `trust` is null on a non-law-firm entity, which has no trust account to
  // reconcile. Without the guard this throws on the business's dashboard.
  //
  // The banner also fires on "unverified" — the staff app holding trust
  // transactions the accounting ledger has never seen. The bank balance is
  // zero in that case, so the old `bank_balance > 0` guard hid precisely the
  // situation most worth surfacing.
  const trustBanner = trust && !trust.is_reconciled && (trust.bank_balance > 0 || trust.reconcile_status === "unverified") ? `
    <div style="background:#FBEDEA; padding:14px 18px; border-radius:8px; border-left:4px solid #9C2B1E; margin-bottom:16px; font-size:13px;">
      <strong style="color:#9C2B1E;">⚠ Trust account ${trust.reconcile_status === "unverified" ? "CANNOT BE RECONCILED" : "NOT RECONCILED"}</strong> — ${trust.reconcile_note
        ? esc(trust.reconcile_note)
        : `bank shows ${fmt$(trust.bank_balance)} but sum of client balances is ${fmt$(trust.sum_of_client_balances)} (variance: ${fmt$(trust.variance)})`}
      <a href="/admin/accounting/trust" style="color:#9C2B1E; margin-left:10px; font-weight:600;">Investigate →</a>
    </div>` : "";

  return `
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <h1>Accounting</h1>
        <div style="font-size:12px; color:#5E5854; margin-top:4px;">Double-entry ledger for ALL practice areas with IOLTA trust compliance.</div>
      </div>
    </div>

    ${switcher}

    ${qboCard}
    ${trustBanner}

    <!-- Recorded in this app -->
    <!--
      These six figures read tezlaw-bot's own journal tables, which fill only
      when somebody keys an entry in here. Nobody does, because the firm's
      books are in QuickBooks — so for months this strip showed six zeros at
      the top of the firm's accounts while the real books showed a seven-figure
      year. They are correct for what they measure; they were labelled as
      though they measured the firm's position.

      The QuickBooks panel above carries the firm's actual figures. This strip
      is the entry queue, and it says so.
    -->
    <h2 style="margin:22px 0 4px 0; font-size:16px; color:#2B2523;">Recorded here in tezlaw-bot</h2>
    <div style="font-size:11px; color:#5E5854; margin-bottom:10px; line-height:1.6;">
      Entries keyed into this app, which are what get pushed into QuickBooks. <strong>These are not the firm's position</strong> — the QuickBooks figures above are.
      A zero here means nothing has been entered in this app, not that the account is empty.
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-bottom:20px;">
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #E8E3DC;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em;">Operating Cash</div>
        <div style="font-size:17px; font-weight:600; color:#5E5854; margin-top:4px;">${fmt$(stats.operating_balance)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #E8E3DC;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em;">IOLTA Trust</div>
        <!-- A null balance means this entity HAS no trust account. Rendering
             that as $0.00 would read as a trust account that is reconciled
             and empty, which is a different and much more reassuring claim. -->
        ${stats.trust_balance === null
          ? `<div style="font-size:15px; font-weight:600; color:#5E5854; margin-top:8px;">Not applicable</div>
             <div style="font-size:11px; color:#5E5854;">Client trust is on the law firm's books only</div>`
          : `<div style="font-size:17px; font-weight:600; color:${trustColor(trust)}; margin-top:4px;">${fmt$(stats.trust_balance)}</div>
             <div style="font-size:11px; color:${trustColor(trust)}; margin-top:2px;">${trustCaption(trust)}</div>`}
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #E8E3DC;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em;">YTD Revenue</div>
        <div style="font-size:17px; font-weight:600; color:#5E5854; margin-top:4px;">${fmt$(stats.ytd_revenue)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #E8E3DC;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em;">YTD Expenses</div>
        <div style="font-size:17px; font-weight:600; color:#5E5854; margin-top:4px;">${fmt$(stats.ytd_expense)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #E8E3DC;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em;">YTD Net Income</div>
        <div style="font-size:17px; font-weight:600; color:${stats.ytd_net_income >= 0 ? "#2F6B3F" : "#9C2B1E"}; margin-top:4px;">${fmt$(stats.ytd_net_income)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #E8E3DC;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em;">Open Invoices</div>
        <div style="font-size:17px; font-weight:600; color:#2B2523; margin-top:4px;">${stats.open_invoices_count}</div>
        <div style="font-size:11px; color:#5E5854; margin-top:2px;">${fmt$(stats.open_invoices_balance)} outstanding</div>
      </div>
    </div>

    <!-- Quick entry actions (all practice areas) -->
    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px;">
      <h3 style="margin:0 0 12px 0; font-size:14px; color:#2B2523;">⚡ Quick Entry (Any Practice Area)</h3>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px;">
        <a href="/admin/accounting/record-fee" style="background:#2F6B3F; color:white; padding:14px 18px; border-radius:6px; text-decoration:none; font-weight:600; display:block;">
          💰 Record Legal Fee
          <div style="font-size:11px; font-weight:400; opacity:0.9; margin-top:3px;">Immigration, PI, Business, LL/T, Estate, TM, Real Estate</div>
        </a>
        <a href="/admin/accounting/record-retainer" style="background:#A34C00; color:white; padding:14px 18px; border-radius:6px; text-decoration:none; font-weight:600; display:block;">
          🏦 Record Retainer
          <div style="font-size:11px; font-weight:400; opacity:0.9; margin-top:3px;">Money into IOLTA trust from client</div>
        </a>
        <a href="/admin/accounting/record-expense" style="background:#9C2B1E; color:white; padding:14px 18px; border-radius:6px; text-decoration:none; font-weight:600; display:block;">
          💸 Record Expense
          <div style="font-size:11px; font-weight:400; opacity:0.9; margin-top:3px;">Rent, salaries, subscriptions, etc</div>
        </a>
        <a href="/admin/accounting/new-entry${qs}" style="background:#2B2523; color:white; padding:14px 18px; border-radius:6px; text-decoration:none; font-weight:600; display:block;">
          📝 Advanced Entry
          <div style="font-size:11px; font-weight:400; opacity:0.9; margin-top:3px;">Custom multi-line journal entry</div>
        </a>
      </div>
      <div style="font-size:11px; color:#5E5854; margin-top:12px; padding-top:10px; border-top:1px solid #E8E3DC;">
        <strong>Auto-imports:</strong>
        <a href="#" onclick="syncFromPI(); return false;" style="color:#A34C00; text-decoration:none;">🔄 Sync from PI</a>
        pulls every finalized PI disbursement + case cost into the ledger.
      </div>
    </div>

    <!-- Reports & Exports -->
    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px;">
      <h3 style="margin:0 0 12px 0; font-size:14px; color:#2B2523;">Reports & Exports</h3>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="/admin/accounting/ledger${qs}" style="background:#F3EFE9; color:#2B2523; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">📖 General Ledger</a>
        <a href="/admin/accounting/income-statement${qs}" style="background:#F3EFE9; color:#2B2523; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">📊 Income Statement (P&L)</a>
        <a href="/admin/accounting/balance-sheet${qs}" style="background:#F3EFE9; color:#2B2523; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">⚖️ Balance Sheet</a>
        <a href="/admin/accounting/trust" style="background:#F3EFE9; color:#2B2523; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">🔒 Trust Reconciliation</a>
        <a href="/admin/accounting/chart${qs}" style="background:#F3EFE9; color:#2B2523; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">📋 Chart of Accounts</a>
        <a href="/admin/accounting/companies" style="background:#F3EFE9; color:#2B2523; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">🏢 Companies</a>
      </div>

      <h4 style="margin:16px 0 8px 0; font-size:12px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em;">One-time Exports</h4>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="/admin/accounting/export/excel" style="background:#2F6B3F; color:white; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">📗 Excel (.xlsx)</a>
        <a href="/admin/accounting/export/iif" style="background:#2F6B3F; color:white; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">📥 QB Desktop (.iif)</a>
        <a href="/admin/accounting/export/csv" style="background:#2F6B3F; color:white; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">📥 QBO (.csv)</a>
      </div>
    </div>

    <!-- Recent entries -->
    <div style="background:white; border-radius:8px; border:1px solid #E8E3DC; overflow:hidden;">
      <div style="padding:12px 16px; background:#FAF8F5; border-bottom:1px solid #E8E3DC; display:flex; justify-content:space-between; align-items:center;">
        <strong style="color:#2B2523; font-size:14px;">Recent Journal Entries</strong>
        <a href="/admin/accounting/ledger${qs}" style="color:#A34C00; font-size:12px; text-decoration:none;">View all →</a>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead>
          <tr style="background:#FAF8F5;">
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Date</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Description</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Client</th>
            <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Lines</th>
            <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Amount</th>
            <th style="padding:10px 12px; border-bottom:1px solid #E8E3DC;"></th>
          </tr>
        </thead>
        <tbody>${recentRows}</tbody>
      </table>
    </div>

    <script>
      async function syncFromPI() {
        if (!confirm("Sync all finalized PI disbursements and case costs into the accounting ledger?\\n\\nThis is safe to run multiple times — entries already imported are skipped.")) return;
        try {
          const r = await fetch("/admin/accounting/sync-pi", { method: "POST" });
          const d = await r.json();
          if (d.ok) {
            alert("✓ Sync complete\\n\\nDisbursements imported: " + d.results.disbursements + "\\nCase costs imported: " + d.results.costs + (d.results.errors.length ? "\\nErrors: " + d.results.errors.length : ""));
            location.reload();
          } else alert("Error: " + d.error);
        } catch (e) { alert("Error: " + e.message); }
      }
    </script>`;
}

// ─── General Ledger ─────────────────────────────────────

async function renderLedger(query) {
  const cid = Number(query.company_id) > 0 ? Number(query.company_id) : null;
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

  const entries = await accounting.getLedger({ ...filters, limit: 500, company_id: cid });
  const accounts = await accounting.listAccounts(cid);
  const switcher = await companySwitcher(cid, "/admin/accounting/ledger");
  const accountOpts = accounts.map(a => `<option value="${a.account_number}" ${account === a.account_number ? "selected" : ""}>${a.account_number} ${esc(a.name)}</option>`).join("");

  const rowsHtml = entries.length ? entries.map(e => {
    const linesHtml = (e.lines || []).map(l => `
      <div style="display:grid; grid-template-columns:1fr 100px 100px; gap:8px; padding:2px 0; font-size:12px;">
        <div style="color:#5E5854;">${l.account_number} ${esc(l.account_name)}${l.memo ? ' <span style="color:#5E5854;">— ' + esc(l.memo) + '</span>' : ''}</div>
        <div style="text-align:right; color:${Number(l.debit) > 0 ? "#2B2523" : "#5E5854"};">${Number(l.debit) > 0 ? fmt$(l.debit) : ""}</div>
        <div style="text-align:right; color:${Number(l.credit) > 0 ? "#2B2523" : "#5E5854"};">${Number(l.credit) > 0 ? fmt$(l.credit) : ""}</div>
      </div>`).join("");
    return `
      <div style="background:white; padding:14px 16px; border:1px solid #E8E3DC; border-radius:6px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
          <div>
            <strong style="color:#2B2523; font-size:13px;">${fmtDate(e.entry_date)}</strong>
            <span style="margin-left:10px; color:#5E5854; font-size:13px;">${esc(e.description)}</span>
            ${e.reference ? `<span style="margin-left:8px; font-size:11px; color:#5E5854;">[${esc(e.reference)}]</span>` : ""}
            ${e.is_trust ? '<span style="margin-left:8px; background:#A34C00; color:white; padding:1px 8px; border-radius:8px; font-size:10px;">TRUST</span>' : ""}
          </div>
          <div style="font-size:11px; color:#5E5854;">
            ${esc(e.client_name || "")} ${e.matter_type ? "· " + esc(e.matter_type) : ""}
            <a href="/admin/accounting/entry/${e.id}" style="margin-left:8px; color:#A34C00; text-decoration:none;">#${e.id} →</a>
          </div>
        </div>
        <div style="border-top:1px solid #E8E3DC; padding-top:6px;">
          <div style="display:grid; grid-template-columns:1fr 100px 100px; gap:8px; font-size:10px; color:#5E5854; text-transform:uppercase; letter-spacing:0.05em; padding-bottom:4px; border-bottom:1px solid #E8E3DC;">
            <div>Account</div><div style="text-align:right;">Debit</div><div style="text-align:right;">Credit</div>
          </div>
          ${linesHtml}
        </div>
      </div>`;
  }).join("") : `<div style="padding:40px; text-align:center; color:#5E5854;">No entries match these filters.</div>`;

  return `
    <div class="page-header">
      <h1>General Ledger</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    ${switcher}

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
      ${companyField(cid)}
      <div><label style="font-size:11px; color:#5E5854; display:block;">From</label><input type="date" name="from" value="${from}" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;"></div>
      <div><label style="font-size:11px; color:#5E5854; display:block;">To</label><input type="date" name="to" value="${to}" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;"></div>
      <div><label style="font-size:11px; color:#5E5854; display:block;">Account</label>
        <select name="account" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px; min-width:220px;"><option value="">All accounts</option>${accountOpts}</select>
      </div>
      <div><label style="font-size:11px; color:#5E5854; display:block;">Client</label><input type="text" name="client" value="${esc(client)}" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;" placeholder="client-key"></div>
      <div><label style="font-size:11px; color:#5E5854; display:block;">Matter</label>
        <select name="matter" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;"><option value="">All</option>
          <option value="pi" ${matter==="pi"?"selected":""}>Personal Injury</option>
          <option value="immigration" ${matter==="immigration"?"selected":""}>Immigration</option>
          <option value="business" ${matter==="business"?"selected":""}>Business Lit</option>
          <option value="ll_tenant" ${matter==="ll_tenant"?"selected":""}>LL/Tenant</option>
          <option value="estate" ${matter==="estate"?"selected":""}>Estate</option>
        </select>
      </div>
      <button type="submit" style="background:#2B2523; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Filter</button>
      <a href="/admin/accounting/ledger" style="padding:8px 16px; color:#5E5854; text-decoration:none;">Clear</a>
    </form>

    <div style="font-size:12px; color:#5E5854; margin-bottom:10px;">${entries.length} entr${entries.length === 1 ? "y" : "ies"}${entries.length === 500 ? " (limit reached — narrow the filters)" : ""}</div>
    ${rowsHtml}`;
}

// ─── Income Statement (P&L) ─────────────────────────────

async function renderIncomeStatement(query) {
  const cid = Number(query.company_id) > 0 ? Number(query.company_id) : null;
  const today = new Date().toISOString().split("T")[0];
  const yearStart = new Date().getFullYear() + "-01-01";
  const from = query.from || yearStart;
  const to = query.to || today;
  const is = await accounting.getIncomeStatement(from, to, cid);
  const switcher = await companySwitcher(is.company_id, "/admin/accounting/income-statement");

  const revRows = is.revenues.length ? is.revenues.map(r => `
    <tr><td style="padding:8px 12px; padding-left:24px; border-bottom:1px solid #E8E3DC;">${r.account_number} — ${esc(r.name)}</td><td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(r.amount)}</td></tr>
  `).join("") : `<tr><td colspan="2" style="padding:8px 24px; color:#5E5854; font-style:italic;">(no revenue in period)</td></tr>`;
  const expRows = is.expenses.length ? is.expenses.map(e => `
    <tr><td style="padding:8px 12px; padding-left:24px; border-bottom:1px solid #E8E3DC;">${e.account_number} — ${esc(e.name)}</td><td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(e.amount)}</td></tr>
  `).join("") : `<tr><td colspan="2" style="padding:8px 24px; color:#5E5854; font-style:italic;">(no expenses in period)</td></tr>`;

  return `
    <div class="page-header">
      <h1>Income Statement (P&L)</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    ${switcher}

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
      ${companyField(cid)}
      <div><label style="font-size:11px; color:#5E5854; display:block;">From</label><input type="date" name="from" value="${from}" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;"></div>
      <div><label style="font-size:11px; color:#5E5854; display:block;">To</label><input type="date" name="to" value="${to}" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;"></div>
      <button type="submit" style="background:#2B2523; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Update</button>
    </form>

    <div style="background:white; padding:24px 32px; border-radius:8px; border:1px solid #E8E3DC; max-width:720px;">
      <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:700; color:#2B2523;">Tez Law P.C.</div>
        <div style="font-size:15px; color:#2B2523;">Income Statement</div>
        <div style="font-size:12px; color:#5E5854;">${fmtDate(from)} to ${fmtDate(to)}</div>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tr><td colspan="2" style="padding:12px 0 6px 0; border-top:2px solid #2B2523;"><strong style="color:#2B2523;">REVENUE</strong></td></tr>
        ${revRows}
        <tr style="font-weight:700; background:#FAF8F5;"><td style="padding:8px 12px;">Total Revenue</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(is.total_revenue)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:1px solid #E8E3DC;"><strong style="color:#2B2523;">EXPENSES</strong></td></tr>
        ${expRows}
        <tr style="font-weight:700; background:#FAF8F5;"><td style="padding:8px 12px;">Total Expenses</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(is.total_expense)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:2px solid #2B2523;"></td></tr>
        <tr style="background:${is.net_income >= 0 ? "#EEF5EF" : "#FBEDEA"}; font-weight:700; font-size:16px;">
          <td style="padding:14px 12px;">NET INCOME</td>
          <td style="padding:14px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace; color:${is.net_income >= 0 ? "#2F6B3F" : "#9C2B1E"};">${fmt$(is.net_income)}</td>
        </tr>
      </table>
    </div>

    <div style="margin-top:16px;">
      <button onclick="window.print()" style="background:#2B2523; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🖨️ Print</button>
    </div>`;
}

// ─── Balance Sheet ──────────────────────────────────────

async function renderBalanceSheet(query) {
  const cid = Number(query.company_id) > 0 ? Number(query.company_id) : null;
  const today = new Date().toISOString().split("T")[0];
  const asOf = query.as_of || today;
  const bs = await accounting.getBalanceSheet(asOf, cid);
  const switcher = await companySwitcher(bs.company_id, "/admin/accounting/balance-sheet");

  const bucketHtml = (items, label) => {
    const rows = items.length ? items.map(a => `
      <tr><td style="padding:6px 12px; padding-left:24px; border-bottom:1px solid #E8E3DC;">${a.account_number} — ${esc(a.name)}</td><td style="padding:6px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(a.amount)}</td></tr>
    `).join("") : `<tr><td colspan="2" style="padding:8px 24px; color:#5E5854; font-style:italic;">(no ${label.toLowerCase()})</td></tr>`;
    return rows;
  };

  return `
    <div class="page-header">
      <h1>Balance Sheet</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    ${switcher}

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px; display:flex; gap:10px; align-items:end;">
      ${companyField(cid)}
      <div><label style="font-size:11px; color:#5E5854; display:block;">As of</label><input type="date" name="as_of" value="${asOf}" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;"></div>
      <button type="submit" style="background:#2B2523; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Update</button>
    </form>

    <div style="background:white; padding:24px 32px; border-radius:8px; border:1px solid #E8E3DC; max-width:720px;">
      <div style="text-align:center; margin-bottom:20px;">
        <div style="font-size:20px; font-weight:700; color:#2B2523;">Tez Law P.C.</div>
        <div style="font-size:15px; color:#2B2523;">Balance Sheet</div>
        <div style="font-size:12px; color:#5E5854;">As of ${fmtDate(asOf)}</div>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tr><td colspan="2" style="padding:12px 0 6px 0; border-top:2px solid #2B2523;"><strong style="color:#2B2523;">ASSETS</strong></td></tr>
        ${bucketHtml(bs.assets, "assets")}
        <tr style="font-weight:700; background:#FAF8F5;"><td style="padding:8px 12px;">Total Assets</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_assets)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:1px solid #E8E3DC;"><strong style="color:#2B2523;">LIABILITIES</strong></td></tr>
        ${bucketHtml(bs.liabilities, "liabilities")}
        <tr style="font-weight:700; background:#FAF8F5;"><td style="padding:8px 12px;">Total Liabilities</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_liabilities)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:1px solid #E8E3DC;"><strong style="color:#2B2523;">EQUITY</strong></td></tr>
        ${bucketHtml(bs.equity, "equity")}
        <tr style="font-weight:700; background:#FAF8F5;"><td style="padding:8px 12px;">Total Equity</td><td style="padding:8px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_equity)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:2px solid #2B2523;"></td></tr>
        <tr style="background:#FAF8F5; font-weight:700; font-size:14px;">
          <td style="padding:10px 12px;">Total Liabilities + Equity</td>
          <td style="padding:10px 12px; text-align:right; font-family:ui-monospace, Menlo, monospace;">${fmt$(bs.total_liabilities + bs.total_equity)}</td>
        </tr>
        ${Math.abs(bs.total_assets - (bs.total_liabilities + bs.total_equity)) > 0.01 ? `
        <tr><td colspan="2" style="padding:12px; background:#FBEDEA; color:#9C2B1E; text-align:center; font-size:12px;">⚠ Balance sheet does not balance — variance ${fmt$(bs.total_assets - (bs.total_liabilities + bs.total_equity))}</td></tr>
        ` : ""}
      </table>
    </div>

    <div style="margin-top:16px;">
      <button onclick="window.print()" style="background:#2B2523; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🖨️ Print</button>
    </div>`;
}

// ─── Trust Reconciliation ───────────────────────────────

async function renderTrustReconciliation(query) {
  const today = new Date().toISOString().split("T")[0];
  const asOf = query.as_of || today;
  const [trust, both] = await Promise.all([
    accounting.getTrustReconciliation(asOf),
    bothLedgers(),
  ]);
  const merged = both.ok ? both.data : null;

  // Per client, the accounting ledger's figure beside the two ledgers
  // together. Built from the union of both key sets: a client the accounting
  // ledger has never seen is precisely the case worth looking at, and it
  // would be missing from a table built off the accounting side alone.
  const acctByKey = new Map(trust.client_balances.map(c => [c.client_key, c]));
  const mergedByKey = new Map((merged ? merged.clients : []).map(c => [c.client_key, c]));
  const allKeys = [...new Set([...acctByKey.keys(), ...mergedByKey.keys()])].sort((a, b) => {
    const na = (acctByKey.get(a) || mergedByKey.get(a) || {}).client_name || a;
    const nb = (acctByKey.get(b) || mergedByKey.get(b) || {}).client_name || b;
    return String(na).localeCompare(String(nb));
  });

  const clientRows = allKeys.length ? allKeys.map(key => {
    const a = acctByKey.get(key);
    const m = mergedByKey.get(key);
    const name = (a && a.client_name) || (m && m.client_name) || key;
    const acctCents = a ? Math.round(Number(a.balance) * 100) : null;
    const bothCents = m ? m.balance_cents : null;
    const differs = acctCents != null && bothCents != null && acctCents !== bothCents;
    const onlyIn = acctCents == null ? "the staff app only" : bothCents == null ? "the accounting ledger only" : null;
    return `
    <tr${differs || onlyIn ? ' style="background:#FFFBF5;"' : ""}>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; font-size:13px;">
        <a href="/admin/accounting/trust/${encodeURIComponent(key)}" style="color:#2B2523; text-decoration:none; font-weight:500;">${esc(name)}</a>
        ${onlyIn ? `<div style="font-size:11px; color:#A34C00; margin-top:2px;">In ${esc(onlyIn)}</div>` : ""}
      </td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-family:ui-monospace, Menlo, monospace;">${acctCents == null ? '<span style="color:#5E5854;">—</span>' : fmt$(a.balance)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-family:ui-monospace, Menlo, monospace; ${differs ? "color:#9C2B1E; font-weight:600;" : ""}">${bothCents == null ? '<span style="color:#5E5854;">—</span>' : c$(bothCents)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-size:12px; color:#5E5854;">${m ? `${m.counts.accounting} + ${m.counts.app}` : "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="4" style="padding:20px; text-align:center; color:#5E5854; font-style:italic;">No client trust balances in either ledger</td></tr>`;

  // The second comparison, against the same bank balance. Stated, never
  // substituted: the status above stays the accounting ledger's answer until
  // somebody decides how the two records combine.
  const appSrc = merged ? merged.sources.app : null;
  const acctSrc = merged ? merged.sources["accounting"] : null;
  const bankCents = Math.round((Number(trust.bank_balance) || 0) * 100);
  const mergedVariance = merged ? bankCents - merged.total_liability_cents : null;
  const bothPanel = !both.ok ? `
    <div style="background:#FAF8F5; padding:14px 18px; border-radius:8px; border-left:4px solid #5E5854; margin-bottom:20px; font-size:13px;">
      The staff app's trust ledger could not be read, so only the accounting ledger is shown above.
      <code style="font-size:12px;">${esc(both.error || "")}</code>
    </div>` : `
    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #E8E3DC; border-left:4px solid #A34C00; margin-bottom:20px;">
      <div style="font-size:13px; color:#2B2523; margin-bottom:14px; line-height:1.6;">
        <strong>Both ledgers together.</strong> Client trust is recorded in two places that have never been joined —
        the staff app (${appSrc.rows} transaction${appSrc.rows === 1 ? "" : "s"})
        and the accounting ledger (${acctSrc.rows}).
        The figures above come from the accounting ledger alone, which is what the status is based on.
        These are the two together, in date order, for comparison only.
        ${!appSrc.available ? `<br><span style="color:#9C2B1E;">The staff app's table could not be read: ${esc(appSrc.error || "")}</span>` : ""}
        ${!acctSrc.available ? `<br><span style="color:#9C2B1E;">The accounting table could not be read: ${esc(acctSrc.error || "")}</span>` : ""}
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:20px;">
        <div>
          <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Client liability, both ledgers</div>
          <div style="font-size:22px; font-weight:700; color:#2B2523; margin-top:4px;">${c$(merged.total_liability_cents)}</div>
          <div style="font-size:11px; color:#5E5854; margin-top:2px;">${merged.clients.length} client${merged.clients.length === 1 ? "" : "s"}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Against bank (1020)</div>
          <div style="font-size:22px; font-weight:700; color:${Math.abs(mergedVariance) < 1 ? "#2F6B3F" : "#9C2B1E"}; margin-top:4px;">${c$(mergedVariance)}</div>
          <div style="font-size:11px; color:#5E5854; margin-top:2px;">Accounting ledger alone: ${fmt$(trust.variance)}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Transactions</div>
          <div style="font-size:22px; font-weight:700; color:#2B2523; margin-top:4px;">${acctSrc.rows + appSrc.rows}</div>
          <div style="font-size:11px; color:#5E5854; margin-top:2px;">accounting + app</div>
        </div>
      </div>
    </div>
    ${mergeProblems(merged)}`;

  return `
    <div class="page-header">
      <h1>Trust Reconciliation</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    <div style="background:#F3EFE9; padding:14px 18px; border-radius:8px; border-left:4px solid #A34C00; margin-bottom:16px; font-size:13px;">
      <strong>CA Bar RRC 1.15:</strong> Trust account bank balance must always equal the sum of all client trust balances. Any variance requires immediate investigation.
    </div>

    ${trust.reconcile_note ? `
    <div style="background:#FAF8F5; padding:14px 18px; border-radius:8px; border-left:4px solid #5E5854; margin-bottom:16px; font-size:13px; color:#2B2523;">
      ${esc(trust.reconcile_note)}
    </div>` : ""}

    <div style="background:${trust.reconcile_status === "reconciled" ? "#EEF5EF" : trust.reconcile_status === "variance" ? "#FBEDEA" : "#F3EFE9"}; padding:20px; border-radius:8px; border-left:4px solid ${trustColor(trust)}; margin-bottom:20px;">
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:20px;">
        <div>
          <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Bank Balance (1020)</div>
          <div style="font-size:22px; font-weight:700; color:#2B2523; margin-top:4px;">${fmt$(trust.bank_balance)}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Sum of Client Ledgers</div>
          <div style="font-size:22px; font-weight:700; color:#2B2523; margin-top:4px;">${fmt$(trust.sum_of_client_balances)}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Variance</div>
          <div style="font-size:22px; font-weight:700; color:${trustColor(trust)}; margin-top:4px;">${fmt$(trust.variance)}</div>
        </div>
        <div>
          <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Status</div>
          <div style="font-size:18px; font-weight:700; color:${trustColor(trust)}; margin-top:6px;">
            ${trustStatusLine(trust)}
          </div>
        </div>
      </div>
    </div>

    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px; display:flex; gap:10px; align-items:end;">
      <div><label style="font-size:11px; color:#5E5854; display:block;">As of</label><input type="date" name="as_of" value="${asOf}" style="padding:6px; border:1px solid #CFC8BE; border-radius:4px;"></div>
      <button type="submit" style="background:#2B2523; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Update</button>
    </form>

    ${bothPanel}

    <div style="background:white; border-radius:8px; border:1px solid #E8E3DC; overflow:hidden;">
      <div style="padding:12px 16px; background:#FAF8F5; border-bottom:1px solid #E8E3DC;">
        <strong style="color:#2B2523;">Per-Client Trust Balances (${allKeys.length})</strong>
        <span style="font-size:11px; color:#5E5854; margin-left:8px;">A highlighted row is one the two ledgers disagree about, or that only one of them has.</span>
      </div>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#FAF8F5;">
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Client</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Accounting ledger</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Both ledgers</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Txns</th>
        </tr></thead>
        <tbody>${clientRows}</tbody>
      </table>
    </div>`;
}

// ─── Chart of Accounts ──────────────────────────────────

async function renderChartOfAccounts(query = {}) {
  const cid = Number(query.company_id) > 0 ? Number(query.company_id) : null;
  const accounts = await accounting.listAccounts(cid);
  const switcher = await companySwitcher(cid, "/admin/accounting/chart");
  const typeColors = { asset: "#2B2523", liability: "#9C2B1E", equity: "#5E5854", revenue: "#2F6B3F", expense: "#A34C00" };
  const grouped = {};
  for (const a of accounts) {
    if (!grouped[a.type]) grouped[a.type] = [];
    grouped[a.type].push(a);
  }

  const sections = ["asset", "liability", "equity", "revenue", "expense"].map(t => {
    if (!grouped[t]) return "";
    const accountRows = grouped[t].map(a => `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-family:ui-monospace, Menlo, monospace; font-size:12px; color:${typeColors[t]}; font-weight:600;">${a.account_number}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-size:13px;">${esc(a.name)}</td>
        <td style="padding:8px 12px; border-bottom:1px solid #E8E3DC; font-size:11px; color:#5E5854;">${esc(a.subtype || "")}</td>
      </tr>
    `).join("");
    return `
      <div style="background:white; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px; overflow:hidden;">
        <div style="padding:12px 16px; background:${typeColors[t]}; color:white;">
          <strong style="text-transform:uppercase; letter-spacing:0.05em;">${t}s</strong>
        </div>
        <table style="width:100%; border-collapse:collapse;">${accountRows}</table>
      </div>`;
  }).join("");

  return `
    <div class="page-header">
      <h1>Chart of Accounts</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    ${switcher}
    <div style="font-size:12px; color:#5E5854; margin-bottom:16px;">
      Standard law firm chart of accounts. ${accounts.length} accounts active. Trust accounts (2010, 1020) are governed by CA Bar RRC 1.15.
    </div>
    ${sections}`;
}

// ─── Client Trust Ledger ────────────────────────────────

async function renderClientTrustLedger(clientKey) {
  const [entries, ledger] = await Promise.all([
    accounting.getClientTrustLedger(clientKey),
    (async () => {
      try { return { ok: true, data: await require("./trust-ledger").forClient(clientKey) }; }
      catch (e) {
        console.warn("[accounting-ui] merged client ledger unavailable:", e.message);
        return { ok: false, error: e.message };
      }
    })(),
  ]);
  const clientName = entries[0]?.client_name || clientKey;

  const rows = entries.length ? entries.map(e => `
    <tr>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; font-size:12px;">${fmtDate(e.transaction_date)}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; font-size:13px;">${esc(e.description)}${e.reference ? ' <span style="color:#5E5854; font-size:11px;">[' + esc(e.reference) + ']</span>' : ''}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; color:${Number(e.deposit_amount) > 0 ? "#2F6B3F" : "#5E5854"};">${Number(e.deposit_amount) > 0 ? "+" + fmt$(e.deposit_amount) : ""}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; color:${Number(e.disburse_amount) > 0 ? "#9C2B1E" : "#5E5854"};">${Number(e.disburse_amount) > 0 ? "−" + fmt$(e.disburse_amount) : ""}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; font-weight:600;">${fmt$(e.running_balance)}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" style="padding:40px; text-align:center; color:#5E5854;">No trust transactions</td></tr>`;

  const currentBalance = entries.length ? Number(entries[entries.length - 1].running_balance) : 0;
  const bothTable = renderBothLedgers(ledger);

  return `
    <div class="page-header">
      <h1>Trust Ledger — ${esc(clientName)}</h1>
      <a href="/admin/accounting/trust" class="back-link">← All trust balances</a>
    </div>

    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #E8E3DC; margin-bottom:16px;">
      <div style="font-size:11px; color:#5E5854; text-transform:uppercase;">Current Trust Balance</div>
      <div style="font-size:32px; font-weight:700; color:${currentBalance > 0 ? "#2F6B3F" : "#2B2523"}; margin-top:4px;">${fmt$(currentBalance)}</div>
      <div style="font-size:12px; color:#5E5854; margin-top:4px;">${entries.length} transaction${entries.length === 1 ? "" : "s"} on the accounting ledger${ledger.ok && ledger.data.counts.app ? `, and ${ledger.data.counts.app} more in the staff app` : ""}</div>
    </div>

    <div style="background:white; border-radius:8px; border:1px solid #E8E3DC; overflow:hidden;">
      <div style="padding:12px 16px; background:#FAF8F5; border-bottom:1px solid #E8E3DC;">
        <strong style="color:#2B2523;">Accounting ledger</strong>
        <span style="font-size:11px; color:#5E5854; margin-left:8px;">accounting_trust_ledger only — the figures the reconciliation uses</span>
      </div>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#FAF8F5;">
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Date</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Description</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Deposit</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Disburse</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Balance</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${bothTable}`;
}

/**
 * The same client, both ledgers, in date order with every row's source named.
 *
 * Shown beneath the accounting ledger rather than instead of it, because the
 * two answer different questions: the table above is what the reconciliation
 * is computed from, and this one is what the client's money actually did
 * across both records.
 *
 * The balance column is recomputed in date order. The app stores its own
 * running balance taken from the most recently *entered* row rather than the
 * preceding one by date, so a back-dated transaction leaves the stored
 * figures wrong from that point on — which is exactly the kind of thing this
 * column exists to expose, and why a mismatch is flagged rather than hidden.
 */
function renderBothLedgers(ledger) {
  if (!ledger.ok) {
    return `
    <div style="background:#FAF8F5; padding:14px 18px; border-radius:8px; border-left:4px solid #5E5854; margin-top:20px; font-size:13px;">
      The staff app's trust ledger could not be read, so only the accounting ledger is shown.
      <code style="font-size:12px;">${esc(ledger.error || "")}</code>
    </div>`;
  }
  const d = ledger.data;
  const SRC = {
    app: { label: "App", color: "#0061FF" },
    accounting: { label: "Accounting", color: "#A34C00" },
  };
  const rows = d.rows.length ? d.rows.map(r => {
    const src = SRC[r.source] || { label: r.source, color: "#5E5854" };
    const mismatch = r.balance_mismatch_cents != null;
    return `
    <tr${r.reversed ? ' style="opacity:.55;"' : mismatch ? ' style="background:#FFFBF5;"' : ""}>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; font-size:12px;">${esc(String(r.date || "").slice(0, 10))}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC;">
        <span style="display:inline-block; padding:1px 5px; border-radius:3px; background:${src.color}; color:#FAF8F5; font-size:9px; font-weight:700;">${esc(src.label)}</span>
      </td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; font-size:13px;">${esc(r.description || "")}${r.reference ? ` <span style="color:#5E5854; font-size:11px;">[${esc(r.reference)}]</span>` : ""}${r.reversed ? ' <span style="color:#9C2B1E; font-size:11px; font-weight:600;">REVERSED</span>' : ""}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; color:${r.deposit_cents > 0 ? "#2F6B3F" : "#5E5854"};">${r.deposit_cents > 0 ? "+" + c$(r.deposit_cents) : ""}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; color:${r.disburse_cents > 0 ? "#9C2B1E" : "#5E5854"};">${r.disburse_cents > 0 ? "−" + c$(r.disburse_cents) : ""}</td>
      <td style="padding:10px 12px; border-bottom:1px solid #E8E3DC; text-align:right; font-size:13px; font-family:ui-monospace, Menlo, monospace; font-weight:600; color:${r.computed_balance_cents < 0 ? "#9C2B1E" : "#2B2523"};">${c$(r.computed_balance_cents)}${mismatch ? `<div style="font-size:10px; font-weight:400; color:#A34C00;">stored ${c$(r.stored_balance_cents)}</div>` : ""}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="6" style="padding:30px; text-align:center; color:#5E5854; font-style:italic;">No trust transactions in either ledger</td></tr>`;

  return `
    <div style="background:white; border-radius:8px; border:1px solid #E8E3DC; border-left:4px solid #A34C00; overflow:hidden; margin-top:20px;">
      <div style="padding:12px 16px; background:#FAF8F5; border-bottom:1px solid #E8E3DC;">
        <strong style="color:#2B2523;">Both ledgers together</strong>
        <span style="font-size:11px; color:#5E5854; margin-left:8px;">${d.counts.accounting} accounting + ${d.counts.app} app, in date order. Balance recomputed; not merged.</span>
      </div>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#FAF8F5;">
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Date</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">From</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Description</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Deposit</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Disburse</th>
          <th style="padding:10px 12px; text-align:right; font-size:11px; color:#5E5854; text-transform:uppercase; border-bottom:1px solid #E8E3DC;">Balance</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="padding:12px 16px; background:#FAF8F5; border-top:1px solid #E8E3DC; display:flex; gap:24px; flex-wrap:wrap; font-size:12px;">
        <div><span style="color:#5E5854;">Closing balance, both ledgers:</span> <strong>${c$(d.closing_balance_cents)}</strong></div>
        ${d.lowest_balance_cents < 0 ? `<div style="color:#9C2B1E;"><strong>Lowest: ${c$(d.lowest_balance_cents)}</strong> on ${esc(d.lowest_balance_date || "")} — a client trust balance may never go below zero (RRC 1.15)</div>` : ""}
      </div>
    </div>
    ${mergeProblems(d)}`;
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

    <form id="entry-form" onsubmit="submitEntry(event)" style="background:white; padding:24px; border-radius:8px; border:1px solid #E8E3DC; max-width:900px;">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
        <div><label style="font-size:11px; color:#5E5854;">Date</label><input type="date" name="entry_date" value="${new Date().toISOString().split("T")[0]}" required style="width:100%; padding:8px; border:1px solid #CFC8BE; border-radius:4px;"></div>
        <div><label style="font-size:11px; color:#5E5854;">Reference (invoice #, check #, etc)</label><input type="text" name="reference" style="width:100%; padding:8px; border:1px solid #CFC8BE; border-radius:4px;"></div>
        <div style="grid-column:1/-1;"><label style="font-size:11px; color:#5E5854;">Description</label><input type="text" name="description" required style="width:100%; padding:8px; border:1px solid #CFC8BE; border-radius:4px;"></div>
        <div><label style="font-size:11px; color:#5E5854;">Client name (optional)</label><input type="text" name="client_name" style="width:100%; padding:8px; border:1px solid #CFC8BE; border-radius:4px;"></div>
        <div><label style="font-size:11px; color:#5E5854;">Matter type</label>
          <select name="matter_type" style="width:100%; padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
            <option value="">—</option>
            <option value="immigration">Immigration</option>
            <option value="pi">Personal Injury</option>
            <option value="business">Business Lit</option>
            <option value="ll_tenant">LL/Tenant</option>
            <option value="estate">Estate</option>
          </select>
        </div>
      </div>

      <h3 style="font-size:14px; color:#2B2523; margin:20px 0 8px 0;">Lines (must balance: debits = credits)</h3>
      <div id="lines-container">
        <div class="line-row" style="display:grid; grid-template-columns:2fr 1fr 1fr 2fr auto; gap:8px; margin-bottom:8px;">
          <select name="account_0" required style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;"><option value="">— account —</option>${acctOpts}</select>
          <input type="number" name="debit_0" placeholder="Debit" step="0.01" min="0" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
          <input type="number" name="credit_0" placeholder="Credit" step="0.01" min="0" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
          <input type="text" name="memo_0" placeholder="Memo" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
          <button type="button" onclick="removeLine(this)" style="background:none; border:none; color:#9C2B1E; cursor:pointer;">×</button>
        </div>
        <div class="line-row" style="display:grid; grid-template-columns:2fr 1fr 1fr 2fr auto; gap:8px; margin-bottom:8px;">
          <select name="account_1" required style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;"><option value="">— account —</option>${acctOpts}</select>
          <input type="number" name="debit_1" placeholder="Debit" step="0.01" min="0" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
          <input type="number" name="credit_1" placeholder="Credit" step="0.01" min="0" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
          <input type="text" name="memo_1" placeholder="Memo" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
          <button type="button" onclick="removeLine(this)" style="background:none; border:none; color:#9C2B1E; cursor:pointer;">×</button>
        </div>
      </div>
      <button type="button" onclick="addLine()" style="background:#F3EFE9; color:#2B2523; border:none; padding:8px 14px; border-radius:4px; cursor:pointer; font-size:12px;">+ Add Line</button>

      <div style="margin-top:20px; padding-top:16px; border-top:1px solid #E8E3DC;">
        <button type="submit" style="background:#2B2523; color:white; padding:12px 24px; border:none; border-radius:6px; cursor:pointer; font-weight:600;">Post Entry</button>
      </div>
    </form>

    <script>
      const ACCT_OPTS = \`${acctOpts.replace(/`/g, "\\`")}\`;
      let lineIdx = 2;
      function addLine() {
        const div = document.createElement("div");
        div.className = "line-row";
        div.style = "display:grid; grid-template-columns:2fr 1fr 1fr 2fr auto; gap:8px; margin-bottom:8px;";
        div.innerHTML = '<select name="account_' + lineIdx + '" required style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;"><option value="">— account —</option>' + ACCT_OPTS + '</select>' +
          '<input type="number" name="debit_' + lineIdx + '" placeholder="Debit" step="0.01" min="0" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">' +
          '<input type="number" name="credit_' + lineIdx + '" placeholder="Credit" step="0.01" min="0" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">' +
          '<input type="text" name="memo_' + lineIdx + '" placeholder="Memo" style="padding:8px; border:1px solid #CFC8BE; border-radius:4px;">' +
          '<button type="button" onclick="removeLine(this)" style="background:none; border:none; color:#9C2B1E; cursor:pointer;">×</button>';
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

/**
 * The companies page — where a second set of books comes from.
 *
 * Without this there is no way to create one at all: createCompany existed,
 * was exported, and had no caller anywhere in the repo, so every piece of
 * multi-company plumbing built on top of it was unreachable.
 *
 * No inline <script>: this is rendered inside a template literal, and an
 * apostrophe in a company name reaching a script block is what took client
 * search down for five hours on 2026-09-28.
 */
async function renderCompanies(query = {}) {
  const companies = await accounting.listCompanies({ includeInactive: true });
  const added = query.added ? String(query.added) : null;
  const failed = query.error ? String(query.error) : null;

  const rows = companies.map(c => `
    <tr style="border-bottom:1px solid #E8E3DC;">
      <td style="padding:10px 8px;">
        <strong>${esc(c.name)}</strong>
        ${c.is_law_firm ? `<span style="margin-left:8px; font-size:11px; background:#EEF5EF; color:#2F6B3F; padding:2px 8px; border-radius:10px; font-weight:600;">law firm</span>` : ""}
        ${c.is_default ? `<span style="margin-left:6px; font-size:11px; background:#F3EFE9; color:#5E5854; padding:2px 8px; border-radius:10px;">shown first</span>` : ""}
        ${c.is_active === false ? `<span style="margin-left:6px; font-size:11px; color:#5E5854;">inactive</span>` : ""}
        <div style="font-size:11px; color:#5E5854; margin-top:2px;">${esc(c.slug)}</div>
      </td>
      <td style="padding:10px 8px; font-size:12px; color:#5E5854;">
        ${c.is_law_firm
          ? "Holds client trust (IOLTA). Only this entity may."
          : "Business books. No trust accounts — client money cannot be posted here."}
      </td>
      <td style="padding:10px 8px; text-align:right; white-space:nowrap;">
        <a href="/admin/accounting?company_id=${c.id}" style="font-size:12px; color:#9C2B1E; font-weight:600;">Open books →</a>
      </td>
    </tr>`).join("");

  return `
    <div class="page-header">
      <h1>Companies</h1>
      <a href="/admin/accounting" class="back-link">← Accounting</a>
    </div>

    ${added ? `<div style="background:#EEF5EF; border-left:4px solid #2F6B3F; padding:12px 16px; border-radius:6px; margin-bottom:16px; font-size:13px;">
      Added <strong>${esc(added)}</strong> with its own chart of accounts. Use the Books switcher on any accounting screen to move between them.
    </div>` : ""}
    ${failed ? `<div style="background:#FBEDEA; border-left:4px solid #9C2B1E; padding:12px 16px; border-radius:6px; margin-bottom:16px; font-size:13px;">
      ${esc(failed)}
    </div>` : ""}

    <div style="background:#FFF3E6; border-left:4px solid #FF7B00; padding:12px 16px; border-radius:6px; margin-bottom:18px; font-size:13px; line-height:1.6;">
      Each company keeps its own ledger, chart of accounts, invoices and QuickBooks connection.
      Nothing crosses between them. <strong>Client trust money stays on the law firm's books</strong>
      — a new company is created with no trust accounts, and the ledger refuses a trust entry on it.
    </div>

    <table style="width:100%; border-collapse:collapse; background:white; border:1px solid #E8E3DC; border-radius:8px; overflow:hidden; margin-bottom:24px;">
      <thead><tr style="background:#FAF8F5;">
        <th style="padding:8px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase;">Company</th>
        <th style="padding:8px; text-align:left; font-size:11px; color:#5E5854; text-transform:uppercase;">Books</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <h2 style="font-size:15px; margin-bottom:8px;">Add a company</h2>
    <form method="POST" action="/admin/accounting/companies/create"
          style="background:white; padding:16px; border-radius:8px; border:1px solid #E8E3DC; display:flex; gap:10px; align-items:end; flex-wrap:wrap;">
      <div style="flex:1; min-width:240px;">
        <label style="font-size:11px; color:#5E5854; display:block; margin-bottom:3px;">Company name</label>
        <input type="text" name="name" required maxlength="120" placeholder="e.g. Tez Holdings LLC"
               style="width:100%; padding:8px; border:1px solid #CFC8BE; border-radius:4px;">
      </div>
      <button type="submit" style="background:#FF7B00;color:#1E1B1A; border:1px solid #9C2B1E; padding:9px 18px; border-radius:4px; cursor:pointer; font-weight:600;">
        Create books
      </button>
    </form>
    <div style="font-size:12px; color:#5E5854; margin-top:6px;">
      Seeded with a standard business chart of accounts — cash, receivables, payables, revenue and expenses.
      It will not be the law firm, and that cannot be changed here.
    </div>`;
}

module.exports = {
  renderDashboard,
  // Pure, so a check can prove what each reconciliation status renders as
  // without booting a server or standing up a database.
  trustColor, trustCaption, trustStatusLine,
  renderCompanies,
  renderLedger,
  renderIncomeStatement,
  renderBalanceSheet,
  renderTrustReconciliation,
  renderChartOfAccounts,
  renderClientTrustLedger,
  renderNewEntry,
  // Pure, so a check can prove what the second figure renders as.
  renderBothLedgers, mergeProblems, c$,
};
