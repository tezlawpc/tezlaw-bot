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
  // Cards are triaged, not just listed: a litigator scanning this board cares
  // first about what is about to blow up. Urgency = trial inside 60 days or
  // SOL inside 90 days (hard, unextendable), then trial inside 120 days.
  const DAY = 86400000;
  const daysUntil = d => {
    if (!d) return null;
    const t = new Date(d).getTime();
    return Number.isFinite(t) ? Math.ceil((t - Date.now()) / DAY) : null;
  };
  const urgencyOf = c => {
    const t = daysUntil(c.trial_date);
    const sol = daysUntil(c.statute_of_limitations);
    if ((t !== null && t <= 60) || (sol !== null && sol <= 90)) return 2;
    if (t !== null && t <= 120) return 1;
    return 0;
  };
  const soonestOf = c => {
    const xs = [daysUntil(c.trial_date), daysUntil(c.statute_of_limitations)].filter(v => v !== null);
    return xs.length ? Math.min(...xs) : Infinity;
  };

  const stagesHtml = board.stages.map(stage => {
    // Most-urgent first, then soonest date, then whatever moved last.
    const cases = (board.cases_by_stage[stage.key] || []).slice().sort((a, b) => {
      const ua = urgencyOf(a), ub = urgencyOf(b);
      if (ua !== ub) return ub - ua;
      const sa = soonestOf(a), sb = soonestOf(b);
      if (sa !== sb) return sa - sb;
      return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
    });

    const cards = cases.map(c => {
      const role = c.our_role ? c.our_role.toUpperCase().slice(0, 4) : "";
      const amt = c.amount_in_controversy ? fmtCurrency(c.amount_in_controversy) : "";
      const t = daysUntil(c.trial_date);
      const sol = daysUntil(c.statute_of_limitations);
      const u = urgencyOf(c);
      const edge = u === 2 ? "#A02818" : u === 1 ? "#F07800" : stage.color;

      const chip = (label, color, title) =>
        `<span title="${esc(title)}" style="display:inline-block;padding:1px 4px;border-radius:3px;background:${color};color:#FBF3DE;font-size:9px;font-weight:700;line-height:1.4;white-space:nowrap;">${esc(label)}</span>`;

      const chips = [
        c.files_archived_at ? chip("ARCHIVED", "#4B5563", "Case file archived — Dropbox sync paused") : "",
        role ? `<span style="display:inline-block;padding:1px 4px;border:1px solid ${stage.color};border-radius:3px;color:${stage.color};font-size:9px;font-weight:600;line-height:1.4;">${esc(role)}</span>` : "",
        t !== null ? chip(t < 0 ? "TRIAL PAST" : "T-" + t + "d", t <= 60 ? "#A02818" : t <= 120 ? "#F07800" : "#7B5330", "Trial: " + fmtDate(c.trial_date)) : "",
        sol !== null && sol <= 180 ? chip("SOL " + sol + "d", sol <= 90 ? "#A02818" : "#B8891E", "SOL: " + fmtDate(c.statute_of_limitations)) : "",
      ].filter(Boolean).join(" ");

      const tip = [c.case_name, c.case_type, c.case_number ? "#" + c.case_number : "", amt]
        .filter(Boolean).join(" · ");

      // A full-width row, not a column card. Nine columns at 1fr each left
      // about 150px per card on a laptop, which is why every case name was
      // clamped to two lines and truncated — "Global Student Housing LLC vs.
      // James Turco" and "Global Student Housing LLC vs. Jane Tran" looked
      // identical. Across the full width the name never needs truncating,
      // which is the whole point of a case list.
      const meta = [
        c.case_number ? "#" + esc(c.case_number) : "",
        c.case_type ? esc(c.case_type) : "",
        c.court ? esc(c.court) : "",
      ].filter(Boolean).join(" &middot; ");

      return `
        <a href="/admin/civil/case/${c.id}" title="${esc(tip)}" draggable="true" data-case-id="${c.id}" data-stage="${esc(stage.key)}" class="civil-card" style="display:flex;align-items:center;gap:10px;padding:8px 11px;margin-bottom:4px;background:#FBF3DE;border:1px solid #D4C4A0;border-left:3px solid ${edge};border-radius:5px;text-decoration:none;color:#3E2818;cursor:grab;">
          <div style="flex:1;min-width:0;">
            <div style="font-family:Cinzel,serif;font-size:13px;font-weight:600;line-height:1.3;">${esc(c.case_name)}</div>
            ${meta ? `<div style="margin-top:2px;font-size:10.5px;color:#7B5330;">${meta}</div>` : ""}
          </div>
          ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;flex-shrink:0;">${chips}</div>` : ""}
          ${amt ? `<div style="flex-shrink:0;min-width:86px;text-align:right;font-size:11.5px;font-weight:700;color:#B8891E;">${esc(amt)}</div>` : ""}
        </a>
      `;
    }).join("") || `<div style="text-align:center;padding:14px 4px;font-style:italic;color:#B0A188;font-size:11px;">—</div>`;

    // Empty columns recede so attention lands where the work actually is.
    const empty = cases.length === 0;
    const urgentCount = cases.filter(c => urgencyOf(c) === 2).length;

    // Each stage is a full-width band. An empty stage collapses to its
    // header rather than reserving a column of blank space — with 115 of
    // ~220 matters in Intake, the old board spent most of its width on
    // columns that had nothing in them.
    return `
      <details class="civil-col" data-stage="${esc(stage.key)}" data-label="${esc(stage.label)}" ${empty ? "" : "open"} style="background:#F5EBD3;border:1px solid #D4C4A0;border-left:4px solid ${stage.color};border-radius:7px;overflow:hidden;margin-bottom:9px;${empty ? "opacity:.6;" : ""}">
        <summary style="padding:9px 12px;background:#FBF3DE;border-bottom:1px solid #D4C4A0;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="display:flex;align-items:center;gap:9px;min-width:0;">
            <div style="font-family:Cinzel,serif;font-size:12px;font-weight:600;color:#3E2818;letter-spacing:1px;text-transform:uppercase;">${esc(stage.label)}</div>
            ${urgentCount ? `<span style="font-size:10px;font-weight:700;color:#A02818;letter-spacing:.3px;">&#9888; ${urgentCount} urgent</span>` : ""}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <a href="/admin/civil/stage/${esc(stage.key)}" style="font-size:10.5px;color:#B8891E;text-decoration:none;">open workspace &rarr;</a>
            <div style="min-width:22px;height:20px;padding:0 7px;border-radius:10px;background:${stage.color};color:#FBF3DE;font-family:Cinzel,serif;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">${cases.length}</div>
          </div>
        </summary>
        <div style="padding:7px;">${cards}</div>
      </details>
    `;
  }).join("");

  const totalActive = Object.values(board.counts).reduce((a, b) => a + b, 0);
  const totalUrgent = Object.values(board.cases_by_stage || {})
    .flat().filter(c => urgencyOf(c) === 2).length;

  return `
    <div style="padding:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <h1 style="margin:0;font-family:'Cinzel',serif;color:#3E2818;">⚖️ Civil Litigation</h1>
          <div style="color:#7B5330;font-style:italic;margin-top:4px;">
            ${totalActive} active case${totalActive === 1 ? "" : "s"} across ${board.stages.length} stages${totalUrgent ? ` · <strong style="color:#A02818;font-style:normal;">${totalUrgent} need attention</strong>` : ""}
          </div>
        </div>
        <a href="/admin/civil/new" style="padding:10px 18px;background:#F07800;color:#FBF3DE;border:1px solid #A02818;border-radius:6px;font-family:Cinzel,serif;font-size:12px;font-weight:600;letter-spacing:1.5px;text-decoration:none;">+ NEW CASE</a>
      </div>
      <!--CIVIL_FILTER_BANNER-->
      <!-- Stacked, not side by side. Nine columns sharing the width meant no
           case name was ever fully readable; down the page each row gets the
           whole width. Stages stay collapsible, so the lifecycle order is
           still visible at a glance even with a stage of 115 matters open. -->
      <div style="max-width:1200px;">
        ${stagesHtml}
      </div>
      <div style="margin-top:10px;display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#7B5330;">
        <span><span style="display:inline-block;width:9px;height:9px;background:#A02818;border-radius:2px;vertical-align:middle;"></span> trial &le;60d or SOL &le;90d</span>
        <span><span style="display:inline-block;width:9px;height:9px;background:#F07800;border-radius:2px;vertical-align:middle;"></span> trial &le;120d</span>
        <span style="font-style:italic;">cards sorted most-urgent first · hover for details · drag a row onto another stage to change it &middot; click a stage header to collapse it</span>
      </div>
      <div id="civilToast" style="display:none;position:fixed;bottom:18px;left:50%;transform:translateX(-50%);padding:9px 16px;background:#3E2818;color:#FBF3DE;border:1px solid #B8891E;border-radius:6px;font-size:12px;z-index:9999;"></div>
      <script>
        // NOTE: this block is written inside a server-side template literal.
        // Never use backslash escapes (\\n, \\') or backtick templates here —
        // the server consumes them before the browser ever sees this script.
        (function () {
          var dragged = null;

          function toast(msg, bad) {
            var t = document.getElementById("civilToast");
            if (!t) return;
            t.textContent = msg;
            t.style.borderColor = bad ? "#A02818" : "#B8891E";
            t.style.display = "block";
            clearTimeout(t._h);
            t._h = setTimeout(function () { t.style.display = "none"; }, 2600);
          }

          document.querySelectorAll(".civil-card").forEach(function (card) {
            card.addEventListener("dragstart", function (e) {
              dragged = card;
              card.style.opacity = ".45";
              try { e.dataTransfer.setData("text/plain", card.dataset.caseId); } catch (err) {}
              if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            });
            card.addEventListener("dragend", function () {
              card.style.opacity = "";
              document.querySelectorAll(".civil-col").forEach(function (c) { c.style.outline = ""; });
              dragged = null;
            });
          });

          document.querySelectorAll(".civil-col").forEach(function (col) {
            col.addEventListener("dragover", function (e) {
              if (!dragged || dragged.dataset.stage === col.dataset.stage) return;
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              col.style.outline = "2px dashed #F07800";
            });
            col.addEventListener("dragleave", function () { col.style.outline = ""; });
            col.addEventListener("drop", function (e) {
              col.style.outline = "";
              if (!dragged) return;
              e.preventDefault();
              var card = dragged;
              var target = col.dataset.stage;
              if (card.dataset.stage === target) return;
              card.style.opacity = ".45";
              fetch("/admin/civil/case/" + card.dataset.caseId + "/move-stage", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ stage: target })
              }).then(function (r) { return r.json(); }).then(function (d) {
                if (d && d.ok) {
                  toast("Moved to " + (col.dataset.label || target));
                  location.reload();
                } else {
                  card.style.opacity = "";
                  toast((d && d.error) || "Could not move that case", true);
                }
              }).catch(function (err) {
                card.style.opacity = "";
                toast("Could not move that case: " + err.message, true);
              });
            });
          });
        })();
      </script>
    </div>
  `.replace("<!--CIVIL_FILTER_BANNER-->", filterBanner);
}

// The civil admin client is a REAL static file, not inline script. Everything
// on these pages used to be written inside server-side template literals,
// where \n and \' are eaten by the server before the browser sees them — a
// bug that shipped three times and each time killed the entire script block.
// New behaviour goes in public/civil-admin.js; only the small legacy blocks
// below are still inline.
//
// /static is served with maxAge 7d, so the URL carries the file's mtime and a
// deploy is picked up immediately instead of a week later.
// A missing bundle used to fall back to ?v=1 and 404 silently, leaving the
// page's mount points empty with nothing to explain why. It now says so.
function civilAdminScriptTag() {
  return require("./client-script").clientScriptTag("civil-admin.js");
}

// A section heading with action buttons on the right.
function sectionHead(title, buttons) {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:24px 0 12px 0;">
      <h2 style="margin:0;font-family:Cinzel,serif;color:#3E2818;font-size:16px;letter-spacing:1.5px;">${title}</h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${buttons || ""}</div>
    </div>`;
}
function actionBtn(action, label, kind) {
  const bg = kind === "danger" ? "#A02818" : kind === "quiet" ? "#F5EBD3" : "#5A3B22";
  const fg = kind === "quiet" ? "#3E2818" : "#FBF3DE";
  const bd = kind === "quiet" ? "#D4C4A0" : "#B8891E";
  return `<button type="button" data-civil-action="${action}" style="padding:7px 13px;background:${bg};color:${fg};border:1px solid ${bd};border-radius:5px;cursor:pointer;font-size:11px;font-family:Cinzel,serif;letter-spacing:1px;">${label}</button>`;
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

  // Dropbox mirror — the module is optional, so a missing or unconfigured
  // one must render an empty panel rather than break the whole page.
  let files = [], fileCats = [], filesErr = null;
  try {
    const cdx = require("./civil-dropbox");
    [files, fileCats] = await Promise.all([
      cdx.listCaseFiles(id),
      cdx.categorySummary(id),
    ]);
  } catch (e) { filesErr = e.message; }
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
      <td style="padding:10px;text-align:right;"><button type="button" data-civil-complete-deadline="${d.id}" style="padding:4px 9px;background:#F5EBD3;color:#3E2818;border:1px solid #D4C4A0;border-radius:4px;cursor:pointer;font-size:11px;">✓ Done</button></td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:20px;text-align:center;font-style:italic;color:#7B5330;">No pending deadlines. Add trigger dates (filed, service, trial) to auto-generate.</td></tr>`;

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
    <div data-case-id="${id}" style="padding:24px;max-width:1400px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <a href="/admin/civil" style="color:#B8891E;text-decoration:none;font-size:12px;">← Back to Kanban</a>
        <div style="display:flex;align-items:center;gap:8px;">
          <label for="civilStageSel" style="font-size:10px;color:#7B5330;font-family:Cinzel,serif;letter-spacing:1.2px;text-transform:uppercase;">Stage</label>
          <select id="civilStageSel" data-case-id="${id}" data-current="${esc(stage.key)}" style="padding:6px 12px;background:${stage.color};color:#FBF3DE;font-family:Cinzel,serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;border:1px solid #5A3B22;border-radius:4px;cursor:pointer;">
            ${civil.STAGES.map(s => `<option value="${esc(s.key)}"${s.key === stage.key ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
          </select>
          <span id="civilStageMsg" style="font-size:11px;color:#7B5330;"></span>
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
      ${sectionHead("📋 CASE OVERVIEW", actionBtn("edit-case", "EDIT CASE"))}
      <table style="width:100%;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;border-collapse:collapse;">
        ${overviewTable}
      </table>
      ${opposingHtml}

      <!-- Court docket checker (build 37) — rendered by civil-admin.js -->
      <div data-civil-panel="docket"></div>

      <!-- Case team (build 38) — rendered by civil-admin.js -->
      <div data-civil-panel="team"></div>

      <!-- Deadlines -->
      ${sectionHead(`⏰ PENDING DEADLINES (${deadlines.length})`,
        actionBtn("add-deadline", "+ ADD DEADLINE") + actionBtn("regenerate-deadlines", "🔄 REGENERATE", "quiet"))}
      <table style="width:100%;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;border-collapse:collapse;">
        <thead style="background:#3E2818;color:#FBF3DE;">
          <tr><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DUE DATE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DESCRIPTION</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">CCP RULE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">PRIORITY</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">SOURCE</th><th style="padding:10px;"></th></tr>
        </thead>
        <tbody>${deadlinesHtml}</tbody>
      </table>

      <!-- Discovery (build 36) — rendered by civil-admin.js -->
      <div data-civil-panel="discovery"></div>

      <!-- Depositions (build 36) — rendered by civil-admin.js -->
      <div data-civil-panel="depos"></div>

      <!-- Events -->
      ${sectionHead(`📅 CASE TIMELINE (${events.length})`, actionBtn("log-event", "+ LOG EVENT"))}
      <table style="width:100%;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;border-collapse:collapse;">
        <thead style="background:#3E2818;color:#FBF3DE;">
          <tr><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DATE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">KIND</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">TITLE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DETAILS</th><th style="padding:10px;text-align:right;font-size:11px;letter-spacing:1px;">HOURS</th><th style="padding:10px;text-align:right;font-size:11px;letter-spacing:1px;">BILLED</th></tr>
        </thead>
        <tbody>${eventsHtml}</tbody>
      </table>

      <!-- Communications -->
      ${sectionHead(`💬 COMMUNICATIONS (${comms.length})`, actionBtn("log-comm", "+ LOG COMMUNICATION"))}
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

      <!-- Billing + matter budget (build 38) — rendered by civil-admin.js -->
      <div data-civil-panel="financials"></div>

      ${renderDocumentsPanel(id, summary, files, fileCats, filesErr)}

      ${summary.internal_notes ? `<h2 style="font-family:Cinzel,serif;color:#3E2818;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">📝 INTERNAL NOTES</h2><div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;padding:16px;white-space:pre-wrap;">${esc(summary.internal_notes)}</div>` : ""}
      <script>
        // NOTE: server-side template literal — no backslash escapes (\\n, \\')
        // and no backtick templates in here.
        (function () {
          var sel = document.getElementById("civilStageSel");
          var msg = document.getElementById("civilStageMsg");
          if (!sel) return;
          sel.addEventListener("change", function () {
            var target = sel.value;
            var previous = sel.dataset.current;
            if (target === previous) return;
            sel.disabled = true;
            if (msg) { msg.style.color = "#7B5330"; msg.textContent = "Saving..."; }
            fetch("/admin/civil/case/" + sel.dataset.caseId + "/move-stage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ stage: target })
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (d && d.ok) { location.reload(); return; }
              sel.value = previous;
              sel.disabled = false;
              if (msg) { msg.style.color = "#A02818"; msg.textContent = (d && d.error) || "Could not change stage"; }
            }).catch(function (err) {
              sel.value = previous;
              sel.disabled = false;
              if (msg) { msg.style.color = "#A02818"; msg.textContent = "Could not change stage: " + err.message; }
            });
          });
        })();
      </script>
      ${civilAdminScriptTag()}
    </div>
  `;
}


// ── Documents panel (Dropbox mirror) ────────────────────────
function renderDocumentsPanel(id, summary, files, cats, err) {
  const linked = !!summary.dropbox_path;
  const archived = !!summary.files_archived_at;
  const synced = summary.dropbox_synced_at ? fmtDate(summary.dropbox_synced_at) : "never";
  const live = files.filter(f => !f.removed_at);
  const withFiles = cats.filter(c => c.count > 0);

  const head = `<h2 style="font-family:Cinzel,serif;color:#3E2818;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">📁 DOCUMENTS (${live.length})</h2>`;

  if (err) {
    return head + `<div style="padding:14px;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;color:#7B5330;font-style:italic;">Document sync unavailable: ${esc(err)}</div>`;
  }

  const controls = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;">
      <input id="dbx-path" value="${esc(summary.dropbox_path || "")}" placeholder="/Civil/Client Folder — paste a Dropbox path or share link"
             style="flex:1;min-width:260px;padding:8px;border:1px solid #D4C4A0;border-radius:5px;background:#FBF3DE;color:#3E2818;font-size:12px;">
      <button onclick="dbxSave(${id})" style="padding:8px 14px;background:#3E2818;color:#FBF3DE;border:1px solid #5A3B22;border-radius:5px;cursor:pointer;font-size:11px;font-family:Cinzel,serif;letter-spacing:1px;">${linked ? "UPDATE" : "LINK"} FOLDER</button>
      <button onclick="dbxSuggest(${id})" style="padding:8px 14px;background:#FBF3DE;color:#3E2818;border:1px solid #D4C4A0;border-radius:5px;cursor:pointer;font-size:11px;font-family:Cinzel,serif;letter-spacing:1px;">SUGGEST</button>
      ${linked ? `<button onclick="dbxSync(${id})" style="padding:8px 14px;background:#F07800;color:#FBF3DE;border:1px solid #A02818;border-radius:5px;cursor:pointer;font-size:11px;font-family:Cinzel,serif;letter-spacing:1px;">SYNC NOW</button>` : ""}
      ${linked ? `<button onclick="dbxArchive(${id}, ${archived ? "false" : "true"})" style="padding:8px 14px;background:${archived ? "#166534" : "#A02818"};color:#FBF3DE;border:1px solid #5A3B22;border-radius:5px;cursor:pointer;font-size:11px;font-family:Cinzel,serif;letter-spacing:1px;">${archived ? "UNARCHIVE" : "ARCHIVE"}</button>` : ""}
    </div>
    <div id="dbx-msg" style="font-size:11px;color:#7B5330;margin-bottom:10px;">
      ${linked ? `Linked to <strong>${esc(summary.dropbox_path)}</strong> · last synced ${esc(synced)}${archived ? ` · <span style="color:#A02818;font-weight:700;">ARCHIVED — sync paused</span>` : ""}` : "No Dropbox folder linked yet."}
      ${summary.dropbox_sync_error ? `<div style="color:#A02818;margin-top:4px;">Last sync error: ${esc(summary.dropbox_sync_error)}</div>` : ""}
    </div>
    <div id="dbx-suggest"></div>`;

  if (!live.length) {
    return head + controls + `<div style="padding:16px;text-align:center;font-style:italic;color:#8B7355;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;">${linked ? "No documents mirrored yet — hit Sync Now." : "Link a folder to mirror this matter's documents."}</div>`;
  }

  const tabs = withFiles.map(c =>
    `<button onclick="dbxFilter('${c.key}')" data-cat="${c.key}" class="dbx-tab" style="padding:5px 10px;border:1px solid ${c.color};border-radius:14px;background:#FBF3DE;color:${c.color};cursor:pointer;font-size:11px;font-weight:600;">${esc(c.label)} ${c.count}</button>`
  ).join(" ");

  const rows = live.map(f => {
    const cat = cats.find(c => c.key === f.category) || { color: "#4B5563", label: f.category };
    const kb = f.size_bytes ? (f.size_bytes > 1048576 ? (f.size_bytes / 1048576).toFixed(1) + " MB" : Math.round(f.size_bytes / 1024) + " KB") : "";
    return `
      <div class="dbx-row" data-cat="${esc(f.category)}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #E8DCC0;">
        <span style="flex-shrink:0;width:9px;height:9px;border-radius:2px;background:${cat.color};"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;color:#3E2818;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name || "")}</div>
          <div style="font-size:10px;color:#8B7355;">${esc(cat.label)}${f.relative_folder ? " · " + esc(f.relative_folder) : ""}${kb ? " · " + kb : ""}${f.server_modified ? " · " + fmtDate(f.server_modified) : ""}</div>
        </div>
        ${f.archived ? `<span style="font-size:9px;font-weight:700;color:#7B5330;letter-spacing:1px;">ARCHIVED</span>` : ""}
        <a href="#" onclick="dbxOpen(event, ${f.id})" style="flex-shrink:0;font-size:11px;color:#B84200;text-decoration:none;font-weight:600;">OPEN ↗</a>
      </div>`;
  }).join("");

  return head + controls + `
    <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:5px;">
      <button onclick="dbxFilter('')" class="dbx-tab" data-cat="" style="padding:5px 10px;border:1px solid #3E2818;border-radius:14px;background:#3E2818;color:#FBF3DE;cursor:pointer;font-size:11px;font-weight:600;">All ${live.length}</button>
      ${tabs}
    </div>
    <div style="background:#FBF3DE;border:1px solid #D4C4A0;border-radius:6px;overflow:hidden;">${rows}</div>

    <script>
      function dbxMsg(t, bad) {
        var el = document.getElementById("dbx-msg");
        el.innerHTML = t; el.style.color = bad ? "#A02818" : "#7B5330";
      }
      function dbxFilter(cat) {
        document.querySelectorAll(".dbx-row").forEach(function (r) {
          r.style.display = (!cat || r.dataset.cat === cat) ? "flex" : "none";
        });
        document.querySelectorAll(".dbx-tab").forEach(function (b) {
          var on = (b.dataset.cat || "") === cat;
          b.style.background = on ? "#3E2818" : "#FBF3DE";
          b.style.color = on ? "#FBF3DE" : (b.style.borderColor || "#3E2818");
        });
      }
      async function dbxPost(url, body) {
        var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        return await r.json();
      }
      async function dbxSave(id) {
        var path = document.getElementById("dbx-path").value.trim();
        if (!path) { dbxMsg("Enter a Dropbox folder path first.", true); return; }
        dbxMsg("Linking…");
        var d = await dbxPost("/admin/civil/case/" + id + "/dropbox", { path: path });
        if (d.ok) { dbxMsg("Linked. Syncing…"); await dbxSync(id); }
        else dbxMsg(d.error || "Could not link that folder.", true);
      }
      async function dbxSync(id) {
        dbxMsg("Syncing with Dropbox…");
        var d = await dbxPost("/admin/civil/case/" + id + "/dropbox/sync", {});
        if (d.ok) { dbxMsg("Synced: +" + (d.added || 0) + " new, " + (d.total || 0) + " total. Reloading…"); setTimeout(function(){ location.reload(); }, 900); }
        else dbxMsg(d.error || d.reason || "Sync failed.", true);
      }
      async function dbxSuggest(id) {
        dbxMsg("Looking for matching folders…");
        var box = document.getElementById("dbx-suggest");
        box.innerHTML = "";
        var r = await fetch("/admin/civil/case/" + id + "/dropbox/suggest");
        var d = await r.json();
        if (!d.ok || !d.suggestions || !d.suggestions.length) {
          dbxMsg("No likely folders found — paste the path manually.", true);
          return;
        }
        dbxMsg("Pick the matching folder:");
        // Built with DOM APIs rather than an HTML string: folder names can
        // contain quotes, and a nested-quote onclick is what broke this
        // script block the first time round.
        d.suggestions.forEach(function (sg) {
          var row = document.createElement("div");
          row.style.cssText = "padding:6px 8px;margin-bottom:4px;background:#FBF3DE;border:1px solid #D4C4A0;border-radius:5px;display:flex;justify-content:space-between;gap:10px;align-items:center;";
          var label = document.createElement("span");
          label.style.cssText = "font-size:12px;color:#3E2818;word-break:break-all;";
          label.textContent = sg.path;
          var use = document.createElement("a");
          use.href = "#";
          use.style.cssText = "font-size:11px;color:#B84200;font-weight:600;text-decoration:none;white-space:nowrap;";
          use.textContent = "USE (score " + sg.score + ")";
          use.onclick = function (ev) {
            ev.preventDefault();
            document.getElementById("dbx-path").value = sg.path;
            box.innerHTML = "";
            dbxMsg("Folder selected — press LINK FOLDER to save.");
          };
          row.appendChild(label);
          row.appendChild(use);
          box.appendChild(row);
        });
      }
      async function dbxArchive(id, on) {
        if (on && !confirm("Archive this case file? The document list is frozen and hourly sync pauses for this matter. Nothing is moved or deleted in Dropbox.")) return;
        dbxMsg(on ? "Archiving…" : "Unarchiving…");
        var d = await dbxPost("/admin/civil/case/" + id + "/files/" + (on ? "archive" : "unarchive"), {});
        if (d.ok) location.reload(); else dbxMsg(d.error || "Failed.", true);
      }
      async function dbxOpen(e, fileId) {
        e.preventDefault();
        var r = await fetch("/admin/civil/files/" + fileId + "/link");
        var d = await r.json();
        if (d.ok && d.url) window.open(d.url, "_blank");
        else dbxMsg(d.error || "Could not open that file.", true);
      }
    </script>`;
}

module.exports = { renderKanban, renderCaseDetail, renderDocumentsPanel, civilAdminScriptTag };
