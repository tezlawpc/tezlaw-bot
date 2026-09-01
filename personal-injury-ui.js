// ============================================================
//  TEZ LAW P.C. — PI ADMIN UI
//  Renders the dashboard, case list, case detail, and
//  disbursement statement pages using the main admin chrome.
// ============================================================

const pi = require("./personal-injury");

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const fmt$ = n => "$" + (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = d => d ? new Date(d).toLocaleDateString() : "—";
const daysBetween = (a, b) => Math.floor((new Date(a) - new Date(b)) / 86400000);

const STATUSES = [
  { key: "intake",         label: "New Intake",       color: "#B79C62" },
  { key: "investigating",  label: "Investigating",    color: "#0061FF" },
  { key: "treating",       label: "Under Treatment",  color: "#7c4dff" },
  { key: "demand_prep",    label: "Preparing Demand", color: "#00838f" },
  { key: "demanding",      label: "Demand Sent",      color: "#00695c" },
  { key: "negotiating",    label: "Negotiating",      color: "#e65100" },
  { key: "settled",        label: "Settled",          color: "#2e7d32" },
  { key: "disbursing",     label: "Disbursing Funds", color: "#1b5e20" },
  { key: "closed",         label: "Closed",           color: "#666" },
  { key: "rejected",       label: "Rejected / Dropped", color: "#c62828" },
];
const statusMap = Object.fromEntries(STATUSES.map(s => [s.key, s]));

const INCIDENT_TYPES = [
  { key: "auto",       label: "Auto Accident" },
  { key: "slip_fall",  label: "Slip & Fall" },
  { key: "dog_bite",   label: "Dog Bite" },
  { key: "premises",   label: "Premises Liability" },
  { key: "product",    label: "Product Liability" },
  { key: "med_mal",    label: "Medical Malpractice" },
  { key: "workplace",  label: "Workplace Injury" },
  { key: "assault",    label: "Assault / Intentional" },
  { key: "other",      label: "Other" },
];

const PROVIDER_TYPES = [
  "ER", "urgent_care", "primary", "chiro", "PT", "ortho", "neuro",
  "MRI", "surgery", "pain_mgmt", "psych", "dental", "other",
];

const INSURANCE_ROLES = [
  { key: "adverse",         label: "Adverse party (defendant's liability)" },
  { key: "client_medpay",   label: "Client's Med-Pay (own auto policy)" },
  { key: "client_um_uim",   label: "Client's UM/UIM" },
  { key: "client_health",   label: "Client's health insurance" },
  { key: "client_auto",     label: "Client's auto (property damage)" },
];

// ─── Dashboard ──────────────────────────────────────────

async function renderDashboard() {
  const stats = await pi.getStats();

  const solExpired = Number(stats.sol_expired || 0);
  const sol30 = Number(stats.sol_within_30_days || 0);
  const sol60 = Number(stats.sol_within_60_days || 0);

  const alertBanner = solExpired > 0 || sol30 > 0 ? `
    <div style="background:${solExpired > 0 ? "#fee" : "#fff8e1"}; padding:16px 20px; border-radius:8px; border-left:4px solid ${solExpired > 0 ? "#c62828" : "#f57f17"}; margin-bottom:16px;">
      <strong style="color:${solExpired > 0 ? "#c62828" : "#f57f17"}; font-size:14px;">
        ${solExpired > 0 ? `🚨 ${solExpired} case${solExpired === 1 ? "" : "s"} PAST STATUTE OF LIMITATIONS` : `⚠️ ${sol30} case${sol30 === 1 ? "" : "s"} with SOL expiring within 30 days`}
      </strong>
      <div style="margin-top:6px;"><a href="/admin/pi/cases?sol_soon=1" style="color:${solExpired > 0 ? "#c62828" : "#f57f17"}; font-weight:600;">View at-risk cases →</a></div>
    </div>` : "";

  const statsGrid = `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:20px;">
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Active Cases</div>
        <div style="font-size:28px; font-weight:700; color:#0C1C36; margin-top:4px;">${stats.active_cases || 0}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">New Intake</div>
        <div style="font-size:28px; font-weight:700; color:#B79C62; margin-top:4px;">${stats.new_intake || 0}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Under Treatment</div>
        <div style="font-size:28px; font-weight:700; color:#7c4dff; margin-top:4px;">${stats.in_treatment || 0}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">In Negotiation</div>
        <div style="font-size:28px; font-weight:700; color:#e65100; margin-top:4px;">${stats.in_negotiation || 0}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Awaiting Disbursement</div>
        <div style="font-size:28px; font-weight:700; color:#2e7d32; margin-top:4px;">${stats.awaiting_disbursement || 0}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">SOL &lt; 60 days</div>
        <div style="font-size:28px; font-weight:700; color:${sol60 > 0 ? "#c62828" : "#0C1C36"}; margin-top:4px;">${sol60}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Annual Gross Recovery</div>
        <div style="font-size:20px; font-weight:700; color:#2e7d32; margin-top:4px;">${fmt$(stats.annual_gross_recovery)}</div>
      </div>
      <div style="background:white; padding:16px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:11px; color:#888; text-transform:uppercase; letter-spacing:0.05em;">Annual Fees Earned</div>
        <div style="font-size:20px; font-weight:700; color:#2e7d32; margin-top:4px;">${fmt$(stats.annual_attorney_fees)}</div>
      </div>
    </div>`;

  return `
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <h1>🚑 Personal Injury Dashboard</h1>
        <div style="font-size:12px; color:#666; margin-top:4px;">Case management for auto, slip & fall, dog bite, premises, product, medical malpractice</div>
      </div>
      <div style="display:flex; gap:8px;">
        <a href="/admin/pi/cases" style="background:#0C1C36; color:white; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:600;">All Cases →</a>
        <a href="/admin/pi/discover/preview" style="background:#0C1C36; color:white; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:600;">🔍 Preview Match</a>
        <button onclick="discoverFromDropbox()" style="background:#B79C62; color:white; padding:10px 18px; border-radius:6px; border:none; cursor:pointer; font-weight:600;">🔄 Sync from Dropbox</button>
      </div>
    </div>

    ${alertBanner}
    ${statsGrid}

    <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
      <h3 style="margin:0 0 12px 0; font-size:14px; color:#0C1C36;">Quick Actions</h3>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <a href="/admin/pi/cases?status=intake" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">📋 New intakes needing details</a>
        <a href="/admin/pi/cases?status=treating" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">🏥 Cases under treatment</a>
        <a href="/admin/pi/cases?status=settled" style="background:#f5f2ea; color:#0C1C36; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">💰 Settled, needs disbursement</a>
        <a href="/admin/pi/cases?sol_soon=1" style="background:#fee; color:#c62828; padding:10px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:500;">⚠️ SOL approaching</a>
      </div>
    </div>

    <script>
      async function discoverFromDropbox() {
        if (!confirm("Scan Dropbox for folders containing 'PI' as a whole word (or 'Personal Injury') and sync them into PI cases?\\n\\nMatches: 'Chen Wei -PI', 'Chen Wei PI', 'PI - Chen Wei', 'Chen Wei (PI)', etc.\\n\\nTip: click 'Preview Match' first to see exactly what would be imported.")) return;
        const btn = event.target;
        btn.disabled = true; btn.textContent = "⏳ Scanning…";
        try {
          const r = await fetch("/admin/pi/discover", { method: "POST" });
          const d = await r.json();
          if (d.ok) {
            alert("Found " + d.results.found + " PI folders.\\nCreated: " + d.results.created + "\\nUpdated: " + d.results.updated);
            location.reload();
          } else {
            alert("Error: " + d.error);
            btn.disabled = false; btn.textContent = "🔄 Sync from Dropbox";
          }
        } catch (e) {
          alert("Error: " + e.message);
          btn.disabled = false; btn.textContent = "🔄 Sync from Dropbox";
        }
      }
    </script>`;
}

// ─── Case list ──────────────────────────────────────────

async function renderCaseList(query) {
  const filters = {};
  if (query.status) filters.status = query.status;
  if (query.sol_soon) filters.sol_approaching_days = 60;
  if (query.broker) filters.broker = query.broker;

  const cases = await pi.listCases(filters);

  const statusOptsHtml = STATUSES.map(s =>
    `<option value="${s.key}" ${query.status === s.key ? "selected" : ""}>${s.label}</option>`
  ).join("");

  const rowsHtml = cases.length ? cases.map(c => {
    const status = statusMap[c.status] || { label: c.status, color: "#666" };
    const solDays = c.days_to_sol;
    let solColor = "#666";
    let solLabel = fmtDate(c.sol_date);
    if (c.sol_date && solDays != null) {
      if (solDays < 0) { solColor = "#c62828"; solLabel = "EXPIRED " + Math.abs(solDays) + "d ago"; }
      else if (solDays <= 30) { solColor = "#c62828"; solLabel += " (" + solDays + "d)"; }
      else if (solDays <= 90) { solColor = "#e65100"; solLabel += " (" + solDays + "d)"; }
      else { solLabel += " (" + solDays + "d)"; }
    }
    const bestOffer = c.best_offer ? fmt$(c.best_offer) : "—";
    const finalSet = c.final_settlement ? fmt$(c.final_settlement) : "—";

    return `
      <tr>
        <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top;">
          <a href="/admin/pi/case/${c.id}" style="color:#0C1C36; font-weight:600; text-decoration:none;">${esc(c.client_name)}</a>
          ${c.incident_type ? `<div style="font-size:11px; color:#888;">${esc(INCIDENT_TYPES.find(i => i.key === c.incident_type)?.label || c.incident_type)}</div>` : ""}
          <div style="font-size:11px; color:#888;">${c.incident_date ? "Incident: " + fmtDate(c.incident_date) : "No incident date"}</div>
          ${c.referral_source ? `<div style="font-size:11px; color:#B79C62; margin-top:2px;">🤝 ${esc(c.referral_source)}</div>` : ""}
        </td>
        <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top;">
          <span style="background:${status.color}; color:white; padding:3px 10px; border-radius:8px; font-size:11px; font-weight:600;">${status.label}</span>
        </td>
        <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top; font-size:12px; color:${solColor}; font-weight:${solColor === "#c62828" ? "700" : "500"};">
          ${solLabel}
        </td>
        <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top; font-size:12px;">
          ${c.providers_count || 0} providers<br>
          <span style="color:#666;">${fmt$(c.total_billed)} billed</span>
        </td>
        <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top; font-size:12px;">
          Best offer: ${bestOffer}<br>
          <strong style="color:#2e7d32;">Settled: ${finalSet}</strong>
        </td>
        <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top;">
          <a href="/admin/pi/case/${c.id}" style="background:#0C1C36; color:white; padding:6px 12px; border-radius:4px; text-decoration:none; font-size:12px;">Open →</a>
        </td>
      </tr>`;
  }).join("") : `<tr><td colspan="6" style="padding:60px; text-align:center; color:#888;">No cases match these filters. Try <a href="/admin/pi">syncing from Dropbox</a>.</td></tr>`;

  return `
    <div class="page-header">
      <h1>🚑 PI Cases (${cases.length})</h1>
      <a href="/admin/pi" class="back-link">← Dashboard</a>
    </div>

    ${query.broker ? `<div style="background:#fff8e1; padding:12px 16px; border-radius:8px; border-left:4px solid #B79C62; margin-bottom:16px; font-size:13px;">🤝 Filtered by broker: <strong>${esc(query.broker)}</strong> · <a href="/admin/pi/cases" style="color:#0061FF; text-decoration:none;">Show all</a> · <a href="/admin/pi/brokers" style="color:#0061FF; text-decoration:none;">All brokers →</a></div>` : ""}
    <form method="GET" style="background:white; padding:14px; border-radius:8px; border:1px solid #eee; margin-bottom:16px; display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
      <div>
        <label style="font-size:11px; color:#888; display:block; margin-bottom:2px;">Status</label>
        <select name="status" style="padding:6px; border:1px solid #ccc; border-radius:4px;">
          <option value="">All statuses</option>${statusOptsHtml}
        </select>
      </div>
      <div>
        <label style="font-size:11px; color:#888; display:block; margin-bottom:2px;">
          <input type="checkbox" name="sol_soon" value="1" ${query.sol_soon ? "checked" : ""}> SOL within 60 days
        </label>
      </div>
      <button type="submit" style="background:#0C1C36; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Filter</button>
      <a href="/admin/pi/cases" style="padding:8px 16px; color:#666; text-decoration:none; font-size:13px;">Clear</a>
    </form>

    <div style="background:white; border-radius:8px; border:1px solid #eee; overflow:hidden;">
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <thead>
          <tr style="background:#fafaf7;">
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Client / Incident</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Status</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">SOL Date</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Medicals</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Money</th>
            <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;"></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

// ─── Case detail (main workhorse page) ──────────────────

async function renderCaseDetail(caseId) {
  const data = await pi.getCase(caseId);
  if (!data) return `<div style="padding:40px;"><h2>Case not found</h2><a href="/admin/pi">← Back to PI dashboard</a></div>`;
  const c = data.case;
  const status = statusMap[c.status] || { label: c.status, color: "#666" };

  // SOL warning
  const solDaysLeft = c.sol_date ? daysBetween(c.sol_date, new Date()) : null;
  const solWarning = solDaysLeft != null && solDaysLeft < 60 && !["closed", "settled", "disbursed"].includes(c.status) ? `
    <div style="background:${solDaysLeft < 0 ? "#fee" : "#fff8e1"}; padding:12px 16px; border-radius:8px; border-left:4px solid ${solDaysLeft < 0 ? "#c62828" : "#f57f17"}; margin-bottom:16px; font-size:13px;">
      <strong style="color:${solDaysLeft < 0 ? "#c62828" : "#f57f17"};">
        ${solDaysLeft < 0 ? "🚨 STATUTE OF LIMITATIONS HAS PASSED" : `⚠️ SOL in ${solDaysLeft} days`}
      </strong> (${fmtDate(c.sol_date)})
    </div>` : "";

  // Totals for the money row
  const totalBilled = data.bills.reduce((s, b) => s + Number(b.billed_amount || 0), 0);
  const totalOutstanding = data.bills.reduce((s, b) => s + Number(b.outstanding_balance || 0), 0);
  const totalCosts = data.costs.reduce((s, c) => s + Number(c.amount || 0), 0);
  const finalSet = data.settlements.find(s => s.is_final);

  const statusOptsHtml = STATUSES.map(s =>
    `<option value="${s.key}" ${c.status === s.key ? "selected" : ""}>${s.label}</option>`
  ).join("");
  const incidentTypeOptsHtml = INCIDENT_TYPES.map(i =>
    `<option value="${i.key}" ${c.incident_type === i.key ? "selected" : ""}>${i.label}</option>`
  ).join("");

  const providersHtml = data.providers.length ? data.providers.map(p => `
    <tr>
      <td style="padding:10px; border-bottom:1px solid #eee;"><strong>${esc(p.provider_name)}</strong>${p.provider_type ? `<div style="font-size:11px; color:#888;">${esc(p.provider_type)}</div>` : ""}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:12px;">${p.phone ? esc(p.phone) : ""}${p.billing_email ? `<br>${esc(p.billing_email)}` : ""}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:12px;">${fmtDate(p.first_visit_date)} → ${fmtDate(p.last_visit_date)}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:12px;">${p.visits_count || 0} visits${p.is_lop ? ' <span style="background:#B79C62; color:white; padding:1px 6px; border-radius:6px; font-size:10px;">LOP</span>' : ""}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:11px; color:#888;">${p.records_received ? "✓ records" : "⌛ records"} · ${p.bills_received ? "✓ bills" : "⌛ bills"}</td>
      <td style="padding:10px; border-bottom:1px solid #eee;"><button onclick="deleteProvider(${p.id})" style="background:none; border:none; color:#c62828; cursor:pointer;">×</button></td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:20px; text-align:center; color:#888; font-size:13px;">No providers added yet.</td></tr>`;

  const billsHtml = data.bills.length ? data.bills.map(b => {
    const flags = [];
    if (b.is_medi_cal) flags.push('<span style="background:#c62828; color:white; padding:1px 6px; border-radius:6px; font-size:10px;">MEDI-CAL</span>');
    if (b.is_medicare) flags.push('<span style="background:#c62828; color:white; padding:1px 6px; border-radius:6px; font-size:10px;">MEDICARE</span>');
    if (b.is_lien) flags.push('<span style="background:#B79C62; color:white; padding:1px 6px; border-radius:6px; font-size:10px;">LIEN</span>');
    return `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #eee;"><strong>${esc(b.provider_name)}</strong> ${flags.join(" ")}<div style="font-size:11px; color:#888;">${fmtDate(b.date_of_service_from)} → ${fmtDate(b.date_of_service_to)}</div></td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:right; font-size:13px;">${fmt$(b.billed_amount)}</td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:right; font-size:13px; color:#0061FF;">${fmt$(b.paid_by_insurance)}</td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:right; font-size:13px; color:#888;">${fmt$(b.write_off)}</td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:right; font-size:13px; color:${Number(b.outstanding_balance) > 0 ? "#c62828" : "#666"}; font-weight:600;">${fmt$(b.outstanding_balance)}</td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:right; font-size:13px; color:#2e7d32;">${b.reduction_negotiated > 0 ? "−" + fmt$(b.reduction_negotiated) : "—"}</td>
        <td style="padding:10px; border-bottom:1px solid #eee;"><button onclick="deleteBill(${b.id})" style="background:none; border:none; color:#c62828; cursor:pointer;">×</button></td>
      </tr>`;
  }).join("") : `<tr><td colspan="7" style="padding:20px; text-align:center; color:#888; font-size:13px;">No bills added yet.</td></tr>`;

  const totalBillsRow = data.bills.length > 0 ? `
    <tr style="background:#fafaf7; font-weight:700;">
      <td style="padding:10px;">TOTALS</td>
      <td style="padding:10px; text-align:right;">${fmt$(totalBilled)}</td>
      <td style="padding:10px; text-align:right; color:#0061FF;">${fmt$(data.bills.reduce((s, b) => s + Number(b.paid_by_insurance || 0), 0))}</td>
      <td style="padding:10px; text-align:right; color:#888;">${fmt$(data.bills.reduce((s, b) => s + Number(b.write_off || 0), 0))}</td>
      <td style="padding:10px; text-align:right; color:#c62828;">${fmt$(totalOutstanding)}</td>
      <td style="padding:10px; text-align:right; color:#2e7d32;">−${fmt$(data.bills.reduce((s, b) => s + Number(b.reduction_negotiated || 0), 0))}</td>
      <td></td>
    </tr>` : "";

  const insuranceHtml = data.insurance.length ? data.insurance.map(i => {
    const roleLabel = INSURANCE_ROLES.find(r => r.key === i.role)?.label || i.role;
    return `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #eee;"><strong>${esc(i.carrier_name || "?")}</strong><div style="font-size:11px; color:#888;">${esc(roleLabel)}</div></td>
        <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px;">${esc(i.claim_number || "")}</td>
        <td style="padding:10px; border-bottom:1px solid #eee; font-size:12px;">${esc(i.adjuster_name || "")}${i.adjuster_phone ? "<br>" + esc(i.adjuster_phone) : ""}</td>
        <td style="padding:10px; border-bottom:1px solid #eee; text-align:right; font-size:13px;">${fmt$(i.policy_limits)}</td>
        <td style="padding:10px; border-bottom:1px solid #eee;"><button onclick="deleteInsurance(${i.id})" style="background:none; border:none; color:#c62828; cursor:pointer;">×</button></td>
      </tr>`;
  }).join("") : `<tr><td colspan="5" style="padding:20px; text-align:center; color:#888; font-size:13px;">No insurance carriers added yet.</td></tr>`;

  const settlementsHtml = data.settlements.length ? data.settlements.map(s => `
    <tr style="${s.is_final ? "background:#e8f5e9;" : ""}">
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px;">${fmtDate(s.offer_date)}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px;">${esc(s.offer_from || "")}${s.is_final ? ' <span style="background:#2e7d32; color:white; padding:1px 8px; border-radius:6px; font-size:10px;">FINAL</span>' : ""}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px; font-weight:600;">${fmt$(s.offer_amount)}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px; color:#0061FF;">${s.counter_amount ? fmt$(s.counter_amount) : "—"}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:12px;">${esc(s.response || "pending")}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:12px; color:#666;">${s.check_received_date ? "✓ check " + fmtDate(s.check_received_date) : ""}</td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:20px; text-align:center; color:#888; font-size:13px;">No offers yet.</td></tr>`;

  const costsHtml = data.costs.length ? data.costs.map(cost => `
    <tr>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px;">${fmtDate(cost.paid_date)}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px;">${esc(cost.description)}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:11px; color:#888;">${esc(cost.category || "")}</td>
      <td style="padding:10px; border-bottom:1px solid #eee; font-size:13px; text-align:right; font-weight:600;">${fmt$(cost.amount)}</td>
    </tr>
  `).join("") : `<tr><td colspan="4" style="padding:20px; text-align:center; color:#888; font-size:13px;">No costs recorded.</td></tr>`;

  return `
    <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <h1>🚑 ${esc(c.client_name)}</h1>
        <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
          <span style="background:${status.color}; color:white; padding:3px 10px; border-radius:8px; font-size:11px; font-weight:600;">${status.label}</span>
          ${c.dropbox_folder_path ? `<span style="font-size:11px; color:#888;">📁 ${esc(c.dropbox_folder_path)}</span>` : ""}
        </div>
      </div>
      <div style="display:flex; gap:8px;">
        <a href="/admin/pi/case/${c.id}/demand" style="background:#B79C62; color:white; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:600;">📝 Demand Letters</a>
        <a href="/admin/pi/case/${c.id}/disbursement" style="background:#2e7d32; color:white; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:600;">💰 Disbursement</a>
        <a href="/admin/pi/cases" class="back-link" style="padding:10px 16px;">← All Cases</a>
      </div>
    </div>

    ${solWarning}

    <!-- Money summary -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px; margin-bottom:16px;">
      <div style="background:white; padding:14px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:10px; color:#888; text-transform:uppercase;">Total Medical Billed</div>
        <div style="font-size:18px; font-weight:700; color:#0C1C36; margin-top:2px;">${fmt$(totalBilled)}</div>
      </div>
      <div style="background:white; padding:14px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:10px; color:#888; text-transform:uppercase;">Outstanding</div>
        <div style="font-size:18px; font-weight:700; color:${totalOutstanding > 0 ? "#c62828" : "#0C1C36"}; margin-top:2px;">${fmt$(totalOutstanding)}</div>
      </div>
      <div style="background:white; padding:14px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:10px; color:#888; text-transform:uppercase;">Case Costs Advanced</div>
        <div style="font-size:18px; font-weight:700; color:#0C1C36; margin-top:2px;">${fmt$(totalCosts)}</div>
      </div>
      <div style="background:white; padding:14px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:10px; color:#888; text-transform:uppercase;">Lost Wages</div>
        <div style="font-size:18px; font-weight:700; color:#0C1C36; margin-top:2px;">${fmt$(c.lost_wages)}</div>
      </div>
      <div style="background:white; padding:14px; border-radius:8px; border:1px solid #eee;">
        <div style="font-size:10px; color:#888; text-transform:uppercase;">${finalSet ? "Final Settlement" : "Best Offer"}</div>
        <div style="font-size:18px; font-weight:700; color:#2e7d32; margin-top:2px;">${finalSet ? fmt$(finalSet.check_amount || finalSet.offer_amount) : fmt$(Math.max(0, ...data.settlements.filter(s => !s.is_final).map(s => Number(s.offer_amount || 0))))}</div>
      </div>
    </div>

    <!-- Two-column layout: case info | providers/bills -->
    <div style="display:grid; grid-template-columns:1fr; gap:16px;">

      <!-- Case info form -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
        <details>
          <summary style="cursor:pointer; font-weight:600; color:#0C1C36; font-size:15px;">📋 Case Details</summary>
          <form onsubmit="saveCase(event)" style="margin-top:16px; display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:12px;">
            <div><label style="font-size:11px; color:#888;">Client Name</label><input name="client_name" value="${esc(c.client_name)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Phone</label><input name="client_phone" value="${esc(c.client_phone)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Email</label><input name="client_email" value="${esc(c.client_email)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">DOB</label><input type="date" name="client_dob" value="${c.client_dob || ""}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Address</label><input name="client_address" value="${esc(c.client_address)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Incident Date</label><input type="date" name="incident_date" value="${c.incident_date || ""}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Incident Type</label><select name="incident_type" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"><option value="">—</option>${incidentTypeOptsHtml}</select></div>
            <div><label style="font-size:11px; color:#888;">Incident Location</label><input name="incident_location" value="${esc(c.incident_location)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Police Report #</label><input name="police_report_number" value="${esc(c.police_report_number)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">SOL Date (2yr CA default)</label><input type="date" name="sol_date" value="${c.sol_date || ""}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Severity</label><select name="severity" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"><option value="">—</option><option ${c.severity==='minor'?'selected':''}>minor</option><option ${c.severity==='moderate'?'selected':''}>moderate</option><option ${c.severity==='severe'?'selected':''}>severe</option><option ${c.severity==='catastrophic'?'selected':''}>catastrophic</option></select></div>
            <div><label style="font-size:11px; color:#888;">Client Fault % (comparative)</label><input type="number" step="0.01" name="client_fault_pct" value="${c.client_fault_pct || 0}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Lost Wages ($)</label><input type="number" step="0.01" name="lost_wages" value="${c.lost_wages || 0}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Pain & Suffering Est ($)</label><input type="number" step="0.01" name="pain_suffering_est" value="${c.pain_suffering_est || ""}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Attorney Fee % (pre-lit)</label><input type="number" step="0.01" name="attorney_fee_pct_prelit" value="${c.attorney_fee_pct_prelit || 33.33}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Attorney Fee % (post-filing)</label><input type="number" step="0.01" name="attorney_fee_pct_postfile" value="${c.attorney_fee_pct_postfile || 40.00}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Referral Source</label><input name="referral_source" value="${esc(c.referral_source)}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Referral Fee % (of attorney fee)</label><input type="number" step="0.01" name="referral_fee_pct" value="${c.referral_fee_pct || 0}" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;"></div>
            <div><label style="font-size:11px; color:#888;">Status</label><select name="status" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">${statusOptsHtml}</select></div>
            <div style="grid-column:1/-1;"><label style="font-size:11px; color:#888;">Injuries Description</label><textarea name="injuries_description" rows="2" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">${esc(c.injuries_description)}</textarea></div>
            <div style="grid-column:1/-1;"><label style="font-size:11px; color:#888;">Incident Description</label><textarea name="incident_description" rows="2" style="width:100%; padding:8px; border:1px solid #ccc; border-radius:4px;">${esc(c.incident_description)}</textarea></div>
            <div style="grid-column:1/-1;"><button type="submit" style="background:#0C1C36; color:white; padding:10px 20px; border:none; border-radius:6px; cursor:pointer; font-weight:600;">Save Details</button></div>
          </form>
        </details>
      </div>

      <!-- Insurance -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="margin:0; font-size:15px; color:#0C1C36;">🏢 Insurance Carriers</h3>
          <button onclick="addInsurance()" style="background:#B79C62; color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:12px;">+ Add</button>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#fafaf7;"><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Carrier / Role</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Claim #</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Adjuster</th><th style="padding:8px 10px; text-align:right; font-size:11px; color:#666;">Limits</th><th></th></tr></thead>
          <tbody>${insuranceHtml}</tbody>
        </table>
      </div>

      <!-- Providers -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="margin:0; font-size:15px; color:#0C1C36;">🏥 Medical Providers (${data.providers.length})</h3>
          <button onclick="addProvider()" style="background:#B79C62; color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:12px;">+ Add</button>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#fafaf7;"><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Provider</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Contact</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Treatment Period</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Visits</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Status</th><th></th></tr></thead>
          <tbody>${providersHtml}</tbody>
        </table>
      </div>

      <!-- Bills -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="margin:0; font-size:15px; color:#0C1C36;">💵 Medical Bills (${data.bills.length})</h3>
          <button onclick="addBill()" style="background:#B79C62; color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:12px;">+ Add</button>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#fafaf7;">
            <th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Provider / Dates</th>
            <th style="padding:8px 10px; text-align:right; font-size:11px; color:#666;">Billed</th>
            <th style="padding:8px 10px; text-align:right; font-size:11px; color:#666;">Ins Paid</th>
            <th style="padding:8px 10px; text-align:right; font-size:11px; color:#666;">Write-off</th>
            <th style="padding:8px 10px; text-align:right; font-size:11px; color:#666;">Outstanding</th>
            <th style="padding:8px 10px; text-align:right; font-size:11px; color:#666;">Negotiated</th>
            <th></th>
          </tr></thead>
          <tbody>${billsHtml}${totalBillsRow}</tbody>
        </table>
      </div>

      <!-- Settlement offers -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="margin:0; font-size:15px; color:#0C1C36;">💰 Settlement Offers (${data.settlements.length})</h3>
          <button onclick="addSettlement()" style="background:#B79C62; color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:12px;">+ Add Offer</button>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#fafaf7;"><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Date</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">From</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Offer</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Counter</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Response</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Notes</th></tr></thead>
          <tbody>${settlementsHtml}</tbody>
        </table>
      </div>

      <!-- Case costs -->
      <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="margin:0; font-size:15px; color:#0C1C36;">📎 Case Costs Advanced (${data.costs.length})</h3>
          <button onclick="addCost()" style="background:#B79C62; color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:12px;">+ Add Cost</button>
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <thead><tr style="background:#fafaf7;"><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Date</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Description</th><th style="padding:8px 10px; text-align:left; font-size:11px; color:#666;">Category</th><th style="padding:8px 10px; text-align:right; font-size:11px; color:#666;">Amount</th></tr></thead>
          <tbody>${costsHtml}</tbody>
        </table>
      </div>

    </div>

    <script>
      const CASE_ID = ${c.id};

      async function saveCase(e) {
        e.preventDefault();
        const form = e.target;
        const data = Object.fromEntries(new FormData(form));
        const r = await fetch("/admin/pi/case/" + CASE_ID, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const d = await r.json();
        if (d.ok) { alert("✓ Saved"); location.reload(); }
        else alert("Error: " + d.error);
      }

      async function addProvider() {
        const name = prompt("Provider name (e.g. 'LA Orthopedic Center'):");
        if (!name) return;
        const type = prompt("Type (ER/urgent_care/primary/chiro/PT/ortho/MRI/pain_mgmt/other):", "chiro");
        const phone = prompt("Phone (optional):");
        const isLop = confirm("Is this a Letter of Protection (LOP) provider? OK for yes.");
        const r = await fetch("/admin/pi/case/" + CASE_ID + "/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider_name: name, provider_type: type, phone, is_lop: isLop }),
        });
        if (r.ok) location.reload();
      }

      async function addBill() {
        const provider = prompt("Provider name:");
        if (!provider) return;
        const billed = parseFloat(prompt("Amount billed ($):", "0")) || 0;
        const paid = parseFloat(prompt("Amount paid by insurance ($):", "0")) || 0;
        const isLien = confirm("Statutory lien? (Medi-Cal, Medicare, hospital) OK for yes");
        const r = await fetch("/admin/pi/case/" + CASE_ID + "/bills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider_name: provider, billed_amount: billed, paid_by_insurance: paid, is_lien: isLien }),
        });
        if (r.ok) location.reload();
      }

      async function addInsurance() {
        const roles = ${JSON.stringify(INSURANCE_ROLES)};
        const roleKeys = roles.map(r => r.key).join(" / ");
        const role = prompt("Role (" + roleKeys + "):", "adverse");
        if (!role) return;
        const carrier = prompt("Carrier name (e.g. State Farm):");
        const claim = prompt("Claim number:");
        const adjuster = prompt("Adjuster name (optional):");
        const adjusterPhone = prompt("Adjuster phone (optional):");
        const limits = parseFloat(prompt("Policy limits ($):", "0")) || 0;
        const r = await fetch("/admin/pi/case/" + CASE_ID + "/insurance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, carrier_name: carrier, claim_number: claim, adjuster_name: adjuster, adjuster_phone: adjusterPhone, policy_limits: limits }),
        });
        if (r.ok) location.reload();
      }

      async function addSettlement() {
        const from = prompt("Offer from (carrier name):");
        if (!from) return;
        const amount = parseFloat(prompt("Offer amount ($):", "0")) || 0;
        const isFinal = confirm("Is this the ACCEPTED final settlement? OK for yes");
        const r = await fetch("/admin/pi/case/" + CASE_ID + "/settlements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offer_from: from, offer_amount: amount, offer_date: new Date().toISOString().split("T")[0], is_final: isFinal, response: isFinal ? "accepted" : "pending" }),
        });
        if (r.ok) location.reload();
      }

      async function addCost() {
        const desc = prompt("Description (e.g. 'Filing fee - LASC'):");
        if (!desc) return;
        const category = prompt("Category (filing_fee/medical_records/expert/court_reporter/mediation/other):", "other");
        const amount = parseFloat(prompt("Amount ($):", "0")) || 0;
        const r = await fetch("/admin/pi/case/" + CASE_ID + "/costs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: desc, category, amount, paid_date: new Date().toISOString().split("T")[0] }),
        });
        if (r.ok) location.reload();
      }
    </script>`;
}

// ─── Disbursement statement ─────────────────────────────

async function renderDisbursement(caseId) {
  const data = await pi.getCase(caseId);
  if (!data) return `<div>Case not found</div>`;
  const c = data.case;
  const calc = await pi.calculateDisbursement(caseId);

  const feePct = calc.attorney_fee_pct;

  return `
    <div class="page-header">
      <h1>💰 Settlement Disbursement — ${esc(c.client_name)}</h1>
      <a href="/admin/pi/case/${c.id}" class="back-link">← Back to case</a>
    </div>

    <div style="background:white; padding:24px 32px; border-radius:8px; border:1px solid #eee; max-width:820px; font-family:ui-serif, Georgia, serif;" id="statement">
      <h2 style="margin:0 0 4px 0; font-size:20px; color:#0C1C36;">SETTLEMENT DISBURSEMENT STATEMENT</h2>
      <div style="font-size:13px; color:#666; margin-bottom:24px;">Tez Law P.C. — ${new Date().toLocaleDateString()}</div>

      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <tr><td style="padding:10px 4px;"><strong>Client:</strong></td><td style="padding:10px 4px; text-align:right;">${esc(c.client_name)}</td></tr>
        <tr><td style="padding:10px 4px;"><strong>Incident Date:</strong></td><td style="padding:10px 4px; text-align:right;">${fmtDate(c.incident_date)}</td></tr>
        <tr><td style="padding:10px 4px;"><strong>Case Type:</strong></td><td style="padding:10px 4px; text-align:right;">${esc(INCIDENT_TYPES.find(i => i.key === c.incident_type)?.label || c.incident_type)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:2px solid #0C1C36;"><h3 style="margin:0; font-size:16px; color:#0C1C36;">Gross Recovery</h3></td></tr>
        <tr><td style="padding:8px 4px;">Total Settlement</td><td style="padding:8px 4px; text-align:right; font-weight:600;">${fmt$(calc.gross_settlement)}</td></tr>

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:1px solid #eee;"><h3 style="margin:0; font-size:16px; color:#0C1C36;">Deductions</h3></td></tr>
        <tr><td style="padding:8px 4px;">Attorney Fee (${feePct}%)</td><td style="padding:8px 4px; text-align:right;">− ${fmt$(calc.attorney_fee_amount)}</td></tr>
        ${calc.referral_fee_amount > 0 ? `<tr><td style="padding:4px 4px 4px 20px; font-size:12px; color:#666;">— Referral fee (${calc.referral_fee_pct}% of attorney fee, paid from attorney's portion)</td><td style="padding:4px 4px; text-align:right; font-size:12px; color:#666;">${fmt$(calc.referral_fee_amount)}</td></tr>` : ""}
        <tr><td style="padding:8px 4px;">Case Costs Advanced</td><td style="padding:8px 4px; text-align:right;">− ${fmt$(calc.case_costs_total)}</td></tr>
        ${calc.case_costs_breakdown.length ? calc.case_costs_breakdown.map(cc => `<tr><td style="padding:4px 4px 4px 20px; font-size:12px; color:#666;">— ${esc(cc.description)}</td><td style="padding:4px 4px; text-align:right; font-size:12px; color:#666;">${fmt$(cc.amount)}</td></tr>`).join("") : ""}
        <tr><td style="padding:8px 4px;">Medical Bills</td><td style="padding:8px 4px; text-align:right;">− ${fmt$(calc.medical_bills_total)}</td></tr>
        ${calc.medical_bills_breakdown.length ? calc.medical_bills_breakdown.map(b => `<tr><td style="padding:4px 4px 4px 20px; font-size:12px; color:#666;">— ${esc(b.provider_name)}${b.is_lien ? " (LIEN)" : ""}${b.reduction_negotiated > 0 ? ` (reduced by ${fmt$(b.reduction_negotiated)})` : ""}</td><td style="padding:4px 4px; text-align:right; font-size:12px; color:#666;">${fmt$(b.final_paid)}</td></tr>`).join("") : ""}
        ${calc.other_deductions > 0 ? `<tr><td style="padding:8px 4px;">Other Deductions</td><td style="padding:8px 4px; text-align:right;">− ${fmt$(calc.other_deductions)}</td></tr>` : ""}

        <tr><td colspan="2" style="padding:20px 0 6px 0; border-top:2px solid #0C1C36;">
          <h3 style="margin:0; font-size:16px; color:#2e7d32;">CLIENT NET RECOVERY</h3>
        </td></tr>
        <tr style="background:#e8f5e9;">
          <td style="padding:14px 4px; font-size:18px; font-weight:700;">Payable to Client</td>
          <td style="padding:14px 4px; text-align:right; font-size:22px; font-weight:700; color:#2e7d32;">${fmt$(calc.client_net_amount)}</td>
        </tr>
        <tr><td colspan="2" style="padding:6px 4px; font-size:11px; color:#888;">Client receives ${calc.client_net_pct}% of gross settlement. Total medical reductions negotiated: ${fmt$(calc.total_medical_reductions)}.</td></tr>
      </table>

      <div style="margin-top:32px; padding-top:20px; border-top:1px solid #eee;">
        <p style="font-size:13px; line-height:1.6; color:#555;">I, ${esc(c.client_name)}, have reviewed this statement and understand the deductions and disbursements. I acknowledge receipt of the funds shown above.</p>
        <div style="display:flex; gap:40px; margin-top:30px;">
          <div style="flex:1;">
            <div style="border-bottom:1px solid #333; padding-bottom:2px; height:40px;"></div>
            <div style="font-size:11px; color:#666; margin-top:4px;">Client Signature</div>
          </div>
          <div style="flex:1;">
            <div style="border-bottom:1px solid #333; padding-bottom:2px; height:40px;"></div>
            <div style="font-size:11px; color:#666; margin-top:4px;">Date</div>
          </div>
        </div>
      </div>
    </div>

    <div style="margin-top:16px; display:flex; gap:8px;">
      <button onclick="window.print()" style="background:#0C1C36; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">🖨️ Print Statement</button>
      <button onclick="finalizeDisbursement()" style="background:#2e7d32; color:white; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:600;">✓ Finalize & Save</button>
    </div>

    <script>
      async function finalizeDisbursement() {
        const checkNum = prompt("Client check number (optional):");
        if (checkNum === null) return;
        const r = await fetch("/admin/pi/case/${c.id}/disbursement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            gross_settlement: ${calc.gross_settlement},
            attorney_fee_pct: ${calc.attorney_fee_pct},
            attorney_fee_amount: ${calc.attorney_fee_amount},
            case_costs_total: ${calc.case_costs_total},
            medical_bills_total: ${calc.medical_bills_total},
            liens_total: ${calc.liens_total},
            referral_fee_amount: ${calc.referral_fee_amount},
            client_net_amount: ${calc.client_net_amount},
            client_check_number: checkNum,
            client_check_date: new Date().toISOString().split("T")[0],
            finalized: true,
          }),
        });
        const d = await r.json();
        if (d.ok) { alert("✓ Disbursement finalized"); location.href = "/admin/pi/case/${c.id}"; }
        else alert("Error: " + d.error);
      }
    </script>`;
}

module.exports = {
  renderDashboard,
  renderCaseList,
  renderCaseDetail,
  renderDisbursement,
};
