// ============================================================
//  CIVIL LITIGATION — WEB ADMIN UI
//  Kanban board + case list + case detail HTML pages served
//  under /admin/civil/*. Wired from server.js.
//
//  Britannia theme (walnut / gold / parchment).
// ============================================================

const civil = require("./civil-litigation");

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtCurrency(n) {
  if (n == null || n === "") return "";
  const num = Number(n);
  if (!isFinite(num)) return "";
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000)     return `$${(num / 1_000).toFixed(0)}k`;
  return `$${num.toFixed(0)}`;
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ── Kanban board ────────────────────────────────────────────
// opts: { stage, status } — drives the filtered sidebar links. An unknown
// stage key is ignored rather than returning an empty board, so a stale
// bookmark still shows something useful.
async function renderKanban(opts = {}) {
  const validStage = opts.stage && civil.STAGES.some(s => s.key === opts.stage) ? opts.stage : null;
  const filter = {};
  if (validStage) filter.stage = validStage;
  if (opts.status) filter.status = opts.status;
  const board = await civil.kanban(filter);
  const activeStage = validStage ? civil.STAGES.find(s => s.key === validStage) : null;
  const filterBanner = activeStage ? `
    <div style="margin-bottom:14px;padding:10px 14px;background:#FBF3DE;border:1px solid ${activeStage.color};border-left-width:4px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:12px;">
      <div style="font-family:Cinzel,serif;font-size:13px;color:#3E2818;letter-spacing:1px;">
        Filtered to <strong style="color:${activeStage.color};">${esc(activeStage.label)}</strong>
      </div>
      <a href="/admin/civil" style="font-size:12px;color:#B84200;text-decoration:none;font-weight:600;">Show all cases ×</a>
    </div>` : "";
  const stagesHtml = board.stages.map(stage => {
    const cases = board.cases_by_stage[stage.key] || [];
    const cards = cases.map(c => {
      const role = c.our_role ? c.our_role.toUpperCase() : "";
      const amt = c.amount_in_controversy ? fmtCurrency(c.amount_in_controversy) : "";
      const trial = c.trial_date ? fmtDate(c.trial_date) : "";
      return `
        <a href="/admin/civil/case/${c.id}" style="display:block;padding:10px;margin-bottom:8px;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;text-decoration:none;color:#3E2818;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;">
            <div style="flex:1;font-family:Cinzel,serif;font-size:13px;font-weight:600;line-height:1.3;">${esc(c.case_name)}</div>
            ${role ? `<div style="padding:2px 6px;border:1px solid ${stage.color};border-radius:4px;font-size:9px;font-weight:600;letter-spacing:1px;color:${stage.color};">${esc(role)}</div>` : ""}
          </div>
          ${c.case_type ? `<div style="font-style:italic;font-size:11px;color:#7B5330;">${esc(c.case_type)}</div>` : ""}
          ${c.case_number ? `<div style="font-size:10px;color:#8B7355;margin-top:2px;">#${esc(c.case_number)}</div>` : ""}
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding-top:6px;border-top:1px solid #D4C4A0;">
            ${trial ? `<div style="font-size:10px;font-weight:600;color:#A02818;">Trial: ${esc(trial)}</div>` : "<div></div>"}
            ${amt ? `<div style="font-size:11px;font-weight:700;color:#B8891E;">${esc(amt)}</div>` : ""}
          </div>
        </a>
      `;
    }).join("") || `<div style="text-align:center;padding:20px;font-style:italic;color:#8B7355;font-size:12px;">—</div>`;

    return `
      <div style="min-width:280px;background:#F5EBD3;border:1px solid #D4C4A0;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;max-height:calc(100vh - 250px);">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#FBF3DE;border-bottom:1px solid #D4C4A0;border-left:4px solid ${stage.color};">
          <div style="font-family:Cinzel,serif;font-size:13px;font-weight:600;color:#3E2818;letter-spacing:1.5px;text-transform:uppercase;">${esc(stage.label)}</div>
          <div style="min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:${stage.color};color:#FBF3DE;font-family:Cinzel,serif;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">${cases.length}</div>
        </div>
        <div style="padding:10px;overflow-y:auto;flex:1;">${cards}</div>
      </div>
    `;
  }).join("");

  const totalActive = Object.values(board.counts).reduce((a, b) => a + b, 0);

  return `
    <div style="padding:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-family:'Cinzel',serif;color:#3E2818;">⚖️ Civil Litigation</h1>
          <div style="color:#7B5330;font-style:italic;margin-top:4px;">${totalActive} active case${totalActive === 1 ? "" : "s"} across ${board.stages.length} stages</div>
        </div>
        <a href="/admin/civil/new" style="padding:10px 18px;background:#F07800;color:#FBF3DE;border:1px solid #A02818;border-radius:6px;font-family:Cinzel,serif;font-size:12px;font-weight:600;letter-spacing:1.5px;text-decoration:none;">+ NEW CASE</a>
      </div>
      <!--CIVIL_FILTER_BANNER-->
      <div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:12px;">
        ${stagesHtml}
      </div>
    </div>
  `.replace("<!--CIVIL_FILTER_BANNER-->", filterBanner);
}

// ── Case detail page ────────────────────────────────────────
async function renderCaseDetail(id) {
  const summary = await civil.getCaseSummary(id);
  if (!summary) return `<div style="padding:40px;text-align:center;color:#7B5330;">Case not found</div>`;
  const [events, deadlines, comms] = await Promise.all([
    civil.listEvents(id, { limit: 100 }),
    civil.listDeadlines(id, { status: "pending" }),
    civil.listCommunications(id),
  ]);
  const stage = civil.STAGES.find(s => s.key === summary.stage) || civil.STAGES[0];

  const overviewRows = [
    ["Client", `<a href="/admin/clients/${esc(summary.client_key)}" style="color:#B8891E;">${esc(summary.client_key)}</a>`],
    ["Case Type", esc(summary.case_type || "—")],
    ["Court", `${esc(summary.court || "—")}${summary.county ? " · " + esc(summary.county) : ""}`],
    ["Case Number", esc(summary.case_number || "—")],
    ["Our Role", (summary.our_role || "—").toUpperCase()],
    ["Opposing Party", esc(summary.opposing_party || "—")],
    ["Filed Date", fmtDate(summary.filed_date) || "—"],
    ["Service Date", fmtDate(summary.service_date) || "—"],
    ["Statute of Limitations", fmtDate(summary.statute_of_limitations) || "—"],
    ["CMC Date", fmtDate(summary.cmc_date) || "—"],
    ["Trial Date", `<strong style="color:#A02818;">${fmtDate(summary.trial_date) || "—"}</strong>`],
    ["Amount in Controversy", summary.amount_in_controversy ? "$" + Number(summary.amount_in_controversy).toLocaleString() : "—"],
    ["Billing", `${summary.billing_type}${summary.hourly_rate ? " @ $" + summary.hourly_rate + "/hr" : ""}${summary.contingency_pct ? " " + summary.contingency_pct + "%" : ""}`],
  ];

  const overviewTable = overviewRows.map(([k, v]) => `
    <tr><td style="padding:8px 12px;color:#7B5330;font-family:Cinzel,serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;width:180px;">${k}</td><td style="padding:8px 12px;color:#3E2818;">${v}</td></tr>
  `).join("");

  const opposingHtml = summary.opposing_counsel && Object.keys(summary.opposing_counsel).length ? `
    <div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:16px;margin-top:16px;">
      <div style="font-family:Cinzel,serif;font-weight:600;color:#3E2818;margin-bottom:8px;">Opposing Counsel</div>
      ${summary.opposing_counsel.name ? `<div>${esc(summary.opposing_counsel.name)}</div>` : ""}
      ${summary.opposing_counsel.firm ? `<div style="color:#7B5330;">${esc(summary.opposing_counsel.firm)}</div>` : ""}
      ${summary.opposing_counsel.email ? `<div><a href="mailto:${esc(summary.opposing_counsel.email)}" style="color:#B8891E;">${esc(summary.opposing_counsel.email)}</a></div>` : ""}
      ${summary.opposing_counsel.phone ? `<div><a href="tel:${esc(summary.opposing_counsel.phone)}" style="color:#B8891E;">${esc(summary.opposing_counsel.phone)}</a></div>` : ""}
    </div>
  ` : "";

  const deadlinesHtml = deadlines.length ? deadlines.map(d => `
    <tr style="border-bottom:1px solid #E5D5B8;">
      <td style="padding:10px;">${fmtDate(d.due_date)}</td>
      <td style="padding:10px;">${esc(d.description)}</td>
      <td style="padding:10px;font-size:11px;color:#7B5330;">${esc(d.ccp_rule || "")}</td>
      <td style="padding:10px;"><span style="padding:2px 6px;background:${d.priority === "high" ? "#A02818" : d.priority === "low" ? "#8B7355" : "#B8891E"};color:#FBF3DE;font-size:10px;border-radius:3px;">${esc(d.priority)}</span></td>
      <td style="padding:10px;">${d.auto_generated ? "🤖 AUTO" : "MANUAL"}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" style="padding:20px;text-align:center;font-style:italic;color:#7B5330;">No pending deadlines. Add trigger dates (filed, service, trial) to auto-generate.</td></tr>`;

  const eventsHtml = events.length ? events.map(e => `
    <tr style="border-bottom:1px solid #E5D5B8;">
      <td style="padding:10px;font-size:11px;">${fmtDate(e.event_date || e.created_at)}</td>
      <td style="padding:10px;"><span style="padding:2px 6px;background:#7B5330;color:#FBF3DE;font-size:10px;border-radius:3px;">${esc(e.event_kind)}</span></td>
      <td style="padding:10px;font-weight:600;">${esc(e.title)}</td>
      <td style="padding:10px;font-size:11px;color:#7B5330;">${esc(e.description || "")}</td>
      <td style="padding:10px;text-align:right;">${e.billable_hours ? Number(e.billable_hours).toFixed(2) + "h" : ""}</td>
      <td style="padding:10px;text-align:right;font-weight:600;">${e.billable_amount ? "$" + Number(e.billable_amount).toFixed(2) : ""}</td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:20px;text-align:center;font-style:italic;color:#7B5330;">No events logged yet.</td></tr>`;

  return `
    <div style="padding:24px;max-width:1400px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <a href="/admin/civil" style="color:#B8891E;text-decoration:none;font-size:12px;">← Back to Kanban</a>
        <div>
          <span style="padding:6px 12px;background:${stage.color};color:#FBF3DE;font-family:Cinzel,serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;border-radius:4px;">${esc(stage.label)}</span>
        </div>
      </div>
      <h1 style="margin:8px 0 24px 0;font-family:Cinzel,serif;color:#3E2818;">${esc(summary.case_name)}</h1>

      <!-- Summary cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px;">
        <div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#7B5330;letter-spacing:1.5px;text-transform:uppercase;font-family:Cinzel,serif;">Billable Hours</div>
          <div style="font-size:24px;font-weight:700;color:#3E2818;margin-top:4px;">${(summary.billable_total_hours || 0).toFixed(2)}h</div>
        </div>
        <div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#7B5330;letter-spacing:1.5px;text-transform:uppercase;font-family:Cinzel,serif;">Total Billed</div>
          <div style="font-size:24px;font-weight:700;color:#3E2818;margin-top:4px;">$${(summary.billable_total_amount || 0).toFixed(2)}</div>
        </div>
        <div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#7B5330;letter-spacing:1.5px;text-transform:uppercase;font-family:Cinzel,serif;">Events Logged</div>
          <div style="font-size:24px;font-weight:700;color:#3E2818;margin-top:4px;">${summary.event_count || 0}</div>
        </div>
        <div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#7B5330;letter-spacing:1.5px;text-transform:uppercase;font-family:Cinzel,serif;">Next Deadline</div>
          <div style="font-size:14px;font-weight:600;color:#A02818;margin-top:6px;line-height:1.3;">${summary.next_deadline ? fmtDate(summary.next_deadline.due_date) + "<br><span style='font-size:11px;font-weight:400;color:#3E2818;'>" + esc(summary.next_deadline.description.substring(0, 60)) + "</span>" : "—"}</div>
        </div>
      </div>

      <!-- Overview -->
      <h2 style="font-family:Cinzel,serif;color:#3E2818;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">📋 CASE OVERVIEW</h2>
      <table style="width:100%;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;border-collapse:collapse;">
        ${overviewTable}
      </table>
      ${opposingHtml}

      <!-- Deadlines -->
      <h2 style="font-family:Cinzel,serif;color:#3E2818;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">⏰ PENDING DEADLINES (${deadlines.length})</h2>
      <table style="width:100%;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;border-collapse:collapse;">
        <thead style="background:#3E2818;color:#FBF3DE;">
          <tr><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DUE DATE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DESCRIPTION</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">CCP RULE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">PRIORITY</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">SOURCE</th></tr>
        </thead>
        <tbody>${deadlinesHtml}</tbody>
      </table>

      <!-- Events -->
      <h2 style="font-family:Cinzel,serif;color:#3E2818;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">📅 CASE TIMELINE (${events.length})</h2>
      <table style="width:100%;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;border-collapse:collapse;">
        <thead style="background:#3E2818;color:#FBF3DE;">
          <tr><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DATE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">KIND</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">TITLE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DETAILS</th><th style="padding:10px;text-align:right;font-size:11px;letter-spacing:1px;">HOURS</th><th style="padding:10px;text-align:right;font-size:11px;letter-spacing:1px;">BILLED</th></tr>
        </thead>
        <tbody>${eventsHtml}</tbody>
      </table>

      <!-- Communications -->
      <h2 style="font-family:Cinzel,serif;color:#3E2818;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">💬 COMMUNICATIONS (${comms.length})</h2>
      ${comms.length ? comms.map(c => `
        <div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#7B5330;margin-bottom:6px;">
            <div><strong>${esc(c.kind || "")}</strong> · ${esc(c.direction || "")} · ${esc(c.channel || "")}</div>
            <div>${fmtDate(c.created_at)}</div>
          </div>
          ${c.subject ? `<div style="font-weight:600;margin-bottom:4px;">${esc(c.subject)}</div>` : ""}
          <div style="font-size:13px;line-height:1.4;color:#3E2818;">${esc(c.body || "").substring(0, 500)}</div>
          ${c.contact_name ? `<div style="font-size:11px;color:#7B5330;margin-top:6px;">${esc(c.contact_name)}${c.contact_email ? " · " + esc(c.contact_email) : ""}</div>` : ""}
        </div>
      `).join("") : `<div style="padding:20px;text-align:center;font-style:italic;color:#7B5330;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;">No communications logged yet.</div>`}

      ${summary.internal_notes ? `<h2 style="font-family:Cinzel,serif;color:#3E2818;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">📝 INTERNAL NOTES</h2><div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:16px;white-space:pre-wrap;">${esc(summary.internal_notes)}</div>` : ""}
    </div>
  `;
}

module.exports = { renderKanban, renderCaseDetail };
