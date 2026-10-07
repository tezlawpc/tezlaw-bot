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
    <div style="margin-bottom:14px;padding:10px 14px;background:#FAF8F5;border:1px solid ${activeStage.color};border-left-width:4px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:12px;">
      <div style="font-family:Montserrat,sans-serif;font-size:13px;color:#2B2523;letter-spacing:1px;">
        Filtered to <strong style="color:${activeStage.color};">${esc(activeStage.label)}</strong>
      </div>
      <a href="/admin/civil" style="font-size:12px;color:#A34C00;text-decoration:none;font-weight:600;">Show all cases ×</a>
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
  // ── Two questions the board never answered ───────────────
  //
  // "How long has this sat?" and "what's due next?". Both were only findable
  // by opening the matter, which on a board of ~220 means they were not
  // findable. A stalled case does not announce itself: it just stops
  // appearing in anybody's day.
  //
  // Quiet days are counted from the last entry in the case log (or the last
  // deadline marked done) — not from updated_at, which a typo correction
  // moves. A matter with no entries counts from the day it was opened, which
  // is the one most worth seeing.
  const daysSince = at => {
    if (!at) return null;
    const t = new Date(at).getTime();
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / DAY) : null;
  };
  // Thresholds are deliberately plain: a fortnight is a reminder, a month is
  // a problem, a quarter on an active matter is how a malpractice claim
  // starts.
  const QUIET_WARN = 14, QUIET_BAD = 30, QUIET_SEVERE = 90;
  const quietColor = d =>
    d >= QUIET_SEVERE ? "#9C2B1E" : d >= QUIET_BAD ? "#FF7B00" : "#5E5854";

  const urgencyOf = c => {
    const t = daysUntil(c.trial_date);
    const sol = daysUntil(c.statute_of_limitations);
    // An overdue deadline or a hearing inside a week belongs at the top
    // alongside a near trial date. Most matters on this board have no trial
    // date set, so without this the triage only ever ranked a handful of them.
    const due = c.next_due ? daysUntil(c.next_due.date) : null;
    if ((t !== null && t <= 60) || (sol !== null && sol <= 90) || (due !== null && due < 0)) return 2;
    if ((t !== null && t <= 120) || (due !== null && due <= 7)) return 1;
    return 0;
  };
  const soonestOf = c => {
    const xs = [
      daysUntil(c.trial_date),
      daysUntil(c.statute_of_limitations),
      c.next_due ? daysUntil(c.next_due.date) : null,
    ].filter(v => v !== null);
    return xs.length ? Math.min(...xs) : Infinity;
  };

  const stagesHtml = board.stages.map(stage => {
    // Most-urgent first, then soonest date, then whatever moved last.
    const cases = (board.cases_by_stage[stage.key] || []).slice().sort((a, b) => {
      const ua = urgencyOf(a), ub = urgencyOf(b);
      if (ua !== ub) return ub - ua;
      const sa = soonestOf(a), sb = soonestOf(b);
      if (sa !== sb) return sa - sb;
      // Then the quietest first, rather than the most recently touched. A
      // board sorted by updated_at buries exactly the matters that need
      // looking at: the ones nobody has touched.
      const qa = new Date(a.last_activity_at || a.created_at || 0).getTime();
      const qb = new Date(b.last_activity_at || b.created_at || 0).getTime();
      return qa - qb;
    });

    const cards = cases.map(c => {
      const role = c.our_role ? c.our_role.toUpperCase().slice(0, 4) : "";
      const amt = c.amount_in_controversy ? fmtCurrency(c.amount_in_controversy) : "";
      const t = daysUntil(c.trial_date);
      const sol = daysUntil(c.statute_of_limitations);
      const u = urgencyOf(c);
      const edge = u === 2 ? "#9C2B1E" : u === 1 ? "#FF7B00" : stage.color;

      const chip = (label, color, title) =>
        `<span title="${esc(title)}" style="display:inline-block;padding:1px 4px;border-radius:3px;background:${color};color:#FAF8F5;font-size:9px;font-weight:700;line-height:1.4;white-space:nowrap;">${esc(label)}</span>`;

      // Days quiet, and what is due next. Both sit before the trial and SOL
      // chips because they are the ones that apply to every matter on the
      // board, not only the ones with a trial date set.
      const quiet = daysSince(c.last_activity_at);
      const due = c.next_due;
      const dueIn = due ? daysUntil(due.date) : null;
      const chips = [
        c.files_archived_at ? chip("ARCHIVED", "#5E5854", "Case file archived — Dropbox sync paused") : "",
        quiet !== null && quiet >= QUIET_WARN
          ? chip("QUIET " + quiet + "d", quietColor(quiet),
                 `No movement for ${quiet} day${quiet === 1 ? "" : "s"} — last: ${c.last_activity_source || "unknown"} ${fmtDate(c.last_activity_at)}`)
          : "",
        due
          ? chip(
              (dueIn !== null && dueIn < 0 ? "OVERDUE " + Math.abs(dueIn) + "d" : "DUE " + fmtDate(due.date)),
              dueIn !== null && dueIn < 0 ? "#9C2B1E" : dueIn !== null && dueIn <= 7 ? "#FF7B00" : "#2F6B3F",
              `${due.kind === "hearing" ? "Hearing" : "Deadline"} ${fmtDate(due.date)}: ${due.label || ""}`)
          : "",
        role ? `<span style="display:inline-block;padding:1px 4px;border:1px solid ${stage.color};border-radius:3px;color:${stage.color};font-size:9px;font-weight:600;line-height:1.4;">${esc(role)}</span>` : "",
        t !== null ? chip(t < 0 ? "TRIAL PAST" : "T-" + t + "d", t <= 60 ? "#9C2B1E" : t <= 120 ? "#FF7B00" : "#5E5854", "Trial: " + fmtDate(c.trial_date)) : "",
        sol !== null && sol <= 180 ? chip("SOL " + sol + "d", sol <= 90 ? "#9C2B1E" : "#A34C00", "SOL: " + fmtDate(c.statute_of_limitations)) : "",
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
        <a href="/admin/civil/case/${c.id}" title="${esc(tip)}" draggable="true" data-case-id="${c.id}" data-stage="${esc(stage.key)}" class="civil-card" style="display:flex;align-items:center;gap:10px;padding:8px 11px;margin-bottom:4px;background:#FAF8F5;border:1px solid #E8E3DC;border-left:3px solid ${edge};border-radius:5px;text-decoration:none;color:#2B2523;cursor:grab;">
          <div style="flex:1;min-width:0;">
            <div style="font-family:Montserrat,sans-serif;font-size:13px;font-weight:600;line-height:1.3;">${esc(c.case_name)}</div>
            ${meta ? `<div style="margin-top:2px;font-size:10.5px;color:#5E5854;">${meta}</div>` : ""}
          </div>
          ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;flex-shrink:0;">${chips}</div>` : ""}
          ${amt ? `<div style="flex-shrink:0;min-width:86px;text-align:right;font-size:11.5px;font-weight:700;color:#A34C00;">${esc(amt)}</div>` : ""}
        </a>
      `;
    }).join("") || `<div style="text-align:center;padding:14px 4px;font-style:italic;color:#5E5854;font-size:11px;">—</div>`;

    // Empty columns recede so attention lands where the work actually is.
    const empty = cases.length === 0;
    const urgentCount = cases.filter(c => urgencyOf(c) === 2).length;

    // Each stage is a full-width band. An empty stage collapses to its
    // header rather than reserving a column of blank space — with 115 of
    // ~220 matters in Intake, the old board spent most of its width on
    // columns that had nothing in them.
    return `
      <details class="civil-col" data-stage="${esc(stage.key)}" data-label="${esc(stage.label)}" ${empty ? "" : "open"} style="background:#F3EFE9;border:1px solid #E8E3DC;border-left:4px solid ${stage.color};border-radius:7px;overflow:hidden;margin-bottom:9px;${empty ? "opacity:.6;" : ""}">
        <summary style="padding:9px 12px;background:#FAF8F5;border-bottom:1px solid #E8E3DC;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="display:flex;align-items:center;gap:9px;min-width:0;">
            <div style="font-family:Montserrat,sans-serif;font-size:12px;font-weight:600;color:#2B2523;letter-spacing:1px;text-transform:uppercase;">${esc(stage.label)}</div>
            ${urgentCount ? `<span style="font-size:10px;font-weight:700;color:#9C2B1E;letter-spacing:.3px;">&#9888; ${urgentCount} urgent</span>` : ""}
            ${cases.length > 8 ? `<span style="font-size:10px;color:#5E5854;font-style:italic;">scrolls &#8597;</span>` : ""}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <a href="/admin/civil/stage/${esc(stage.key)}" style="font-size:10.5px;color:#A34C00;text-decoration:none;">open workspace &rarr;</a>
            <div style="min-width:22px;height:20px;padding:0 7px;border-radius:10px;background:${stage.color};color:#FAF8F5;font-family:Montserrat,sans-serif;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">${cases.length}</div>
          </div>
        </summary>
        <div class="civil-col-scroll" style="padding:7px;max-height:46vh;overflow-y:auto;overscroll-behavior:contain;">${cards}</div>
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
          <h1 style="margin:0;font-family:Cormorant Garamond,Georgia,serif;color:#2B2523;">Civil Litigation</h1>
          <div style="color:#5E5854;font-style:italic;margin-top:4px;">
            ${totalActive} active case${totalActive === 1 ? "" : "s"} across ${board.stages.length} stages${totalUrgent ? ` · <strong style="color:#9C2B1E;font-style:normal;">${totalUrgent} need attention</strong>` : ""}
          </div>
        </div>
        <a href="/admin/civil/new" style="padding:10px 18px;background:#FF7B00;color:#1E1B1A;border:1px solid #FF7B00;border-radius:6px;font-family:Montserrat,sans-serif;font-size:12px;font-weight:600;letter-spacing:1.5px;text-decoration:none;">+ NEW CASE</a>
      </div>
      <!--CIVIL_FILTER_BANNER-->
      <!-- Stacked, not side by side. Nine columns sharing the width meant no
           case name was ever fully readable; down the page each row gets the
           whole width. Stages stay collapsible, so the lifecycle order is
           still visible at a glance even with a stage of 115 matters open. -->
      <style>
        /* Each stage band scrolls inside itself, capped at 46vh — roughly
           eight rows. Without this, Intake alone ran 115 rows and the page
           was six screens long, so the lifecycle order the board exists to
           show was never visible at once. Now every stage header is on
           screen together and you scroll inside whichever one you are
           working in. */
        .civil-col-scroll::-webkit-scrollbar { width: 9px; }
        .civil-col-scroll::-webkit-scrollbar-track { background: #FFF3E6; }
        .civil-col-scroll::-webkit-scrollbar-thumb { background: #CFC8BE; border-radius: 5px; }
        .civil-col-scroll::-webkit-scrollbar-thumb:hover { background: #A34C00; }
        .civil-col-scroll { scrollbar-width: thin; scrollbar-color: #CFC8BE #FFF3E6; }
        .civil-col > summary::-webkit-details-marker { display: none; }
        .civil-col > summary:hover { background: #FAF8F5; }
      </style>
      <div style="max-width:1200px;">
        ${stagesHtml}
      </div>
      <div style="margin-top:10px;display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#5E5854;">
        <span><span style="display:inline-block;width:9px;height:9px;background:#9C2B1E;border-radius:2px;vertical-align:middle;"></span> trial &le;60d or SOL &le;90d</span>
        <span><span style="display:inline-block;width:9px;height:9px;background:#FF7B00;border-radius:2px;vertical-align:middle;"></span> trial &le;120d</span>
        <span style="font-style:italic;">cards sorted most-urgent first · hover for details · drag a row onto another stage to change it &middot; click a stage header to collapse it</span>
      </div>
      <div id="civilToast" style="display:none;position:fixed;bottom:18px;left:50%;transform:translateX(-50%);padding:9px 16px;background:#2B2523;color:#FAF8F5;border:1px solid #A34C00;border-radius:6px;font-size:12px;z-index:9999;"></div>
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
            t.style.borderColor = bad ? "#9C2B1E" : "#A34C00";
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
              col.style.outline = "2px dashed #FF7B00";
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
      <h2 style="margin:0;font-family:Cormorant Garamond,Georgia,serif;color:#2B2523;font-size:16px;letter-spacing:1.5px;">${title}</h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${buttons || ""}</div>
    </div>`;
}
function actionBtn(action, label, kind) {
  const bg = kind === "danger" ? "#9C2B1E" : kind === "quiet" ? "#F3EFE9" : "#3A3330";
  const fg = kind === "quiet" ? "#2B2523" : "#FAF8F5";
  const bd = kind === "quiet" ? "#E8E3DC" : "#A34C00";
  return `<button type="button" data-civil-action="${action}" style="padding:7px 13px;background:${bg};color:${fg};border:1px solid ${bd};border-radius:5px;cursor:pointer;font-size:11px;font-family:Montserrat,sans-serif;letter-spacing:1px;">${label}</button>`;
}

// ── Case detail page ────────────────────────────────────────
async function renderCaseDetail(id) {
  const summary = await civil.getCaseSummary(id);
  if (!summary) return `<div style="padding:40px;text-align:center;color:#5E5854;">Case not found</div>`;
  const [events, deadlines, closedDeadlines, comms] = await Promise.all([
    civil.listEvents(id, { limit: 100 }),
    civil.listDeadlines(id, { status: "pending" }),
    // Done and dismissed ones, so they can be reopened or deleted. They used
    // to vanish from the page entirely the moment ✓ Done was pressed.
    civil.listDeadlines(id, { status: ["completed", "dismissed"], newestFirst: true }).catch(() => []),
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
    ["Client", `<a href="/admin/clients/${esc(summary.client_key)}" style="color:#A34C00;">${esc(summary.client_key)}</a>`],
    ["Case Type", esc(summary.case_type || "—")],
    ["Court", `${esc(summary.court || "—")}${summary.county ? " · " + esc(summary.county) : ""}`],
    ["Case Number", esc(summary.case_number || "—")],
    ["Our Role", (summary.our_role || "—").toUpperCase()],
    ["Opposing Party", esc(summary.opposing_party || "—")],
    ["Filed Date", fmtDate(summary.filed_date) || "—"],
    ["Service Date", fmtDate(summary.service_date) || "—"],
    ["Statute of Limitations", fmtDate(summary.statute_of_limitations) || "—"],
    ["CMC Date", fmtDate(summary.cmc_date) || "—"],
    ["Trial Date", `<strong style="color:#9C2B1E;">${fmtDate(summary.trial_date) || "—"}</strong>`],
    ["Amount in Controversy", summary.amount_in_controversy ? "$" + Number(summary.amount_in_controversy).toLocaleString() : "—"],
    ["Billing", `${summary.billing_type}${summary.hourly_rate ? " @ $" + summary.hourly_rate + "/hr" : ""}${summary.contingency_pct ? " " + summary.contingency_pct + "%" : ""}`],
  ];

  const overviewTable = overviewRows.map(([k, v]) => `
    <tr><td style="padding:8px 12px;color:#5E5854;font-family:Montserrat,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;vertical-align:top;width:180px;">${k}</td><td style="padding:8px 12px;color:#2B2523;">${v}</td></tr>
  `).join("");

  // Conflict check. Both sides go in the link: our client AND the opposing
  // party and their counsel, because the opposing party is what decides a
  // rule 1.9 question and the old automatic check never searched for it.
  const conflictNames = [
    summary.case_name, summary.client_key, summary.opposing_party,
    summary.opposing_counsel && summary.opposing_counsel.name,
    summary.opposing_counsel && summary.opposing_counsel.firm,
  ].filter(Boolean);
  const conflictHref = require("./conflicts-page").linkFor({
    kind: "civil", ref: `Civil #${id}`, names: conflictNames,
  });
  const conflictHtml = `
    <div style="margin-top:16px; padding:14px 16px; background:#FAF8F5; border:1px solid #E8E3DC; border-radius:6px;">
      <a href="${conflictHref}" style="display:inline-block; background:#A34C00; color:#FFFFFF; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:14px; font-weight:600;">
        ◆ Run a conflict check
      </a>
      <div style="margin-top:8px; font-size:13px; color:#5E5854;">
        Checks ${conflictNames.length} name${conflictNames.length === 1 ? "" : "s"} from this case — our client and the other side — against every matter the firm has. The result is filed against this case.
      </div>
    </div>`;

  const opposingHtml = summary.opposing_counsel && Object.keys(summary.opposing_counsel).length ? `
    <div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;padding:16px;margin-top:16px;">
      <div style="font-family:Cormorant Garamond,Georgia,serif;font-weight:600;color:#2B2523;margin-bottom:8px;">Opposing Counsel</div>
      ${summary.opposing_counsel.name ? `<div>${esc(summary.opposing_counsel.name)}</div>` : ""}
      ${summary.opposing_counsel.firm ? `<div style="color:#5E5854;">${esc(summary.opposing_counsel.firm)}</div>` : ""}
      ${summary.opposing_counsel.email ? `<div><a href="mailto:${esc(summary.opposing_counsel.email)}" style="color:#A34C00;">${esc(summary.opposing_counsel.email)}</a></div>` : ""}
      ${summary.opposing_counsel.phone ? `<div><a href="tel:${esc(summary.opposing_counsel.phone)}" style="color:#A34C00;">${esc(summary.opposing_counsel.phone)}</a></div>` : ""}
    </div>
  ` : "";

  const deadlinesHtml = deadlines.length ? deadlines.map(d => `
    <tr style="border-bottom:1px solid #E8E3DC;">
      <td style="padding:10px;">${fmtDate(d.due_date)}</td>
      <td style="padding:10px;">${esc(d.description)}</td>
      <td style="padding:10px;font-size:11px;color:#5E5854;">${esc(d.ccp_rule || "")}</td>
      <td style="padding:10px;"><span style="padding:2px 6px;background:${d.priority === "high" ? "#9C2B1E" : d.priority === "low" ? "#5E5854" : "#A34C00"};color:#FAF8F5;font-size:10px;border-radius:3px;">${esc(d.priority)}</span></td>
      <td style="padding:10px;">${d.auto_generated ? "🤖 AUTO" : "MANUAL"}</td>
      <td style="padding:10px;text-align:right;white-space:nowrap;"><button type="button" data-civil-complete-deadline="${d.id}" style="padding:4px 9px;background:#F3EFE9;color:#2B2523;border:1px solid #E8E3DC;border-radius:4px;cursor:pointer;font-size:11px;">✓ Done</button> <button type="button" data-civil-delete-deadline="${d.id}" data-auto="${d.auto_generated ? "1" : "0"}" data-label="${esc(d.description)}" title="Remove this deadline" style="padding:4px 8px;background:#FAF8F5;color:#9C2B1E;border:1px solid #E8E3DC;border-radius:4px;cursor:pointer;font-size:11px;">🗑</button></td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:20px;text-align:center;font-style:italic;color:#5E5854;">No pending deadlines. Add trigger dates (filed, service, trial) to auto-generate.</td></tr>`;

  // Completed and dismissed deadlines — collapsed, newest first, each with
  // Reopen and Delete. A deadline marked Done by mistake could not be undone
  // before this, and a completed one could not be removed at all.
  const closedHtml = closedDeadlines.length ? `
    <details style="margin-top:10px;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;">
      <summary style="padding:10px 12px;cursor:pointer;font-family:Montserrat,sans-serif;font-size:12px;letter-spacing:1px;color:#2B2523;">
        COMPLETED &amp; REMOVED DEADLINES (${closedDeadlines.length})
      </summary>
      <table style="width:100%;border-collapse:collapse;">
        ${closedDeadlines.map(d => `
          <tr style="border-top:1px solid #E8E3DC;${d.status === "dismissed" ? "opacity:.65;" : ""}">
            <td style="padding:8px 10px;white-space:nowrap;text-decoration:line-through;color:#5E5854;">${fmtDate(d.due_date)}</td>
            <td style="padding:8px 10px;color:#2B2523;">${esc(d.description)}</td>
            <td style="padding:8px 10px;font-size:11px;color:#5E5854;white-space:nowrap;">
              ${d.status === "dismissed" ? "removed" : "done"}${d.completed_at ? " " + fmtDate(d.completed_at) : ""}${d.completed_by ? " · " + esc(d.completed_by) : ""}
            </td>
            <td style="padding:8px 10px;text-align:right;white-space:nowrap;">
              <button type="button" data-civil-reopen-deadline="${d.id}" style="padding:3px 8px;background:#F3EFE9;color:#2B2523;border:1px solid #E8E3DC;border-radius:4px;cursor:pointer;font-size:11px;">${d.status === "dismissed" ? "↺ Restore" : "↺ Reopen"}</button>
              ${d.status === "dismissed" ? "" : `<button type="button" data-civil-delete-deadline="${d.id}" data-auto="${d.auto_generated ? "1" : "0"}" data-label="${esc(d.description)}" title="Remove this deadline" style="padding:3px 8px;background:#FAF8F5;color:#9C2B1E;border:1px solid #E8E3DC;border-radius:4px;cursor:pointer;font-size:11px;">🗑</button>`}
            </td>
          </tr>`).join("")}
      </table>
    </details>` : "";

  const eventsHtml = events.length ? events.map(e => `
    <tr style="border-bottom:1px solid #E8E3DC;">
      <td style="padding:10px;font-size:11px;">${fmtDate(e.event_date || e.created_at)}</td>
      <td style="padding:10px;"><span style="padding:2px 6px;background:#5E5854;color:#FAF8F5;font-size:10px;border-radius:3px;">${esc(e.event_kind)}</span></td>
      <td style="padding:10px;font-weight:600;">${esc(e.title)}</td>
      <td style="padding:10px;font-size:11px;color:#5E5854;">${esc(e.description || "")}</td>
      <td style="padding:10px;text-align:right;">${e.billable_hours ? Number(e.billable_hours).toFixed(2) + "h" : ""}</td>
      <td style="padding:10px;text-align:right;font-weight:600;">${e.billable_amount ? "$" + Number(e.billable_amount).toFixed(2) : ""}</td>
    </tr>
  `).join("") : `<tr><td colspan="6" style="padding:20px;text-align:center;font-style:italic;color:#5E5854;">No events logged yet.</td></tr>`;

  return `
    <div data-case-id="${id}" style="padding:24px;max-width:1400px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <a href="/admin/civil" style="color:#A34C00;text-decoration:none;font-size:12px;">← Back to Kanban</a>
        <div style="display:flex;align-items:center;gap:8px;">
          <label for="civilStageSel" style="font-size:10px;color:#5E5854;font-family:Montserrat,sans-serif;letter-spacing:1.2px;text-transform:uppercase;">Stage</label>
          <select id="civilStageSel" data-case-id="${id}" data-current="${esc(stage.key)}" style="padding:6px 12px;background:${stage.color};color:#FAF8F5;font-family:Montserrat,sans-serif;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;border:1px solid #3A3330;border-radius:4px;cursor:pointer;">
            ${civil.STAGES.map(s => `<option value="${esc(s.key)}"${s.key === stage.key ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
          </select>
          <span id="civilStageMsg" style="font-size:11px;color:#5E5854;"></span>
        </div>
      </div>
      <h1 style="margin:8px 0 24px 0;font-family:Cormorant Garamond,Georgia,serif;color:#2B2523;">${esc(summary.case_name)}</h1>

      <!-- Summary cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px;">
        <div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#5E5854;letter-spacing:1.5px;text-transform:uppercase;font-family:Montserrat,sans-serif;">Billable Hours</div>
          <div style="font-size:24px;font-weight:700;color:#2B2523;margin-top:4px;">${(summary.billable_total_hours || 0).toFixed(2)}h</div>
        </div>
        <div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#5E5854;letter-spacing:1.5px;text-transform:uppercase;font-family:Montserrat,sans-serif;">Total Billed</div>
          <div style="font-size:24px;font-weight:700;color:#2B2523;margin-top:4px;">$${(summary.billable_total_amount || 0).toFixed(2)}</div>
        </div>
        <div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#5E5854;letter-spacing:1.5px;text-transform:uppercase;font-family:Montserrat,sans-serif;">Events Logged</div>
          <div style="font-size:24px;font-weight:700;color:#2B2523;margin-top:4px;">${summary.event_count || 0}</div>
        </div>
        <div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;padding:16px;">
          <div style="font-size:10px;color:#5E5854;letter-spacing:1.5px;text-transform:uppercase;font-family:Montserrat,sans-serif;">Next Deadline</div>
          <div style="font-size:14px;font-weight:600;color:#9C2B1E;margin-top:6px;line-height:1.3;">${summary.next_deadline ? fmtDate(summary.next_deadline.due_date) + "<br><span style='font-size:11px;font-weight:400;color:#2B2523;'>" + esc(summary.next_deadline.description.substring(0, 60)) + "</span>" : "—"}</div>
        </div>
      </div>

      <!-- Overview -->
      ${sectionHead("📋 CASE OVERVIEW", `<span style="display:flex;gap:8px;">${actionBtn("log-time", "⏱ LOG TIME")}${actionBtn("edit-case", "EDIT CASE")}</span>`)}
      <table style="width:100%;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;border-collapse:collapse;">
        ${overviewTable}
      </table>
      ${opposingHtml}
        ${conflictHtml}

      <!-- Court docket checker (build 37) — rendered by civil-admin.js -->
      <div data-civil-panel="docket"></div>

      <!-- Case team (build 38) — rendered by civil-admin.js -->
      <div data-civil-panel="team"></div>

      <!-- Hearings and the notes from them (civil-hearings.js) — rendered by civil-admin.js -->
      <div data-civil-panel="hearings"></div>

      <!-- Documents out for e-signature (esign.js) — rendered by esign-admin.js -->
      <div data-esign="case" data-esign-case="${esc(String(id))}"></div>

      <!-- Deadlines -->
      ${sectionHead(`⏰ PENDING DEADLINES (${deadlines.length})`,
        actionBtn("add-deadline", "+ ADD DEADLINE") + actionBtn("regenerate-deadlines", "🔄 REGENERATE", "quiet"))}
      <table style="width:100%;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;border-collapse:collapse;">
        <thead style="background:#2B2523;color:#FAF8F5;">
          <tr><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DUE DATE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DESCRIPTION</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">CCP RULE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">PRIORITY</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">SOURCE</th><th style="padding:10px;"></th></tr>
        </thead>
        <tbody>${deadlinesHtml}</tbody>
      </table>
      ${closedHtml}

      <!-- Discovery (build 36) — rendered by civil-admin.js -->
      <div data-civil-panel="discovery"></div>

      <!-- Depositions (build 36) — rendered by civil-admin.js -->
      <div data-civil-panel="depos"></div>

      <!-- Events -->
      ${sectionHead(`📅 CASE TIMELINE (${events.length})`, actionBtn("log-event", "+ LOG EVENT"))}
      <table style="width:100%;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;border-collapse:collapse;">
        <thead style="background:#2B2523;color:#FAF8F5;">
          <tr><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DATE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">KIND</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">TITLE</th><th style="padding:10px;text-align:left;font-size:11px;letter-spacing:1px;">DETAILS</th><th style="padding:10px;text-align:right;font-size:11px;letter-spacing:1px;">HOURS</th><th style="padding:10px;text-align:right;font-size:11px;letter-spacing:1px;">BILLED</th></tr>
        </thead>
        <tbody>${eventsHtml}</tbody>
      </table>

      <!-- Communications -->
      ${sectionHead(`💬 COMMUNICATIONS (${comms.length})`, actionBtn("log-comm", "+ LOG COMMUNICATION"))}
      ${comms.length ? comms.map(c => `
        <div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;padding:12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#5E5854;margin-bottom:6px;">
            <div><strong>${esc(c.kind || "")}</strong> · ${esc(c.direction || "")} · ${esc(c.channel || "")}</div>
            <div>${fmtDate(c.created_at)}</div>
          </div>
          ${c.subject ? `<div style="font-weight:600;margin-bottom:4px;">${esc(c.subject)}</div>` : ""}
          <div style="font-size:13px;line-height:1.4;color:#2B2523;">${esc(c.body || "").substring(0, 500)}</div>
          ${c.contact_name ? `<div style="font-size:11px;color:#5E5854;margin-top:6px;">${esc(c.contact_name)}${c.contact_email ? " · " + esc(c.contact_email) : ""}</div>` : ""}
        </div>
      `).join("") : `<div style="padding:20px;text-align:center;font-style:italic;color:#5E5854;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;">No communications logged yet.</div>`}

      <!-- Billing + matter budget (build 38) — rendered by civil-admin.js -->
      <!-- Time & billing (civil-time.js) — rendered by civil-admin.js -->
      <div data-civil-panel="time"></div>

      <div data-civil-panel="financials"></div>

      ${renderDocumentsPanel(id, summary, files, fileCats, filesErr)}

      ${summary.internal_notes ? `<h2 style="font-family:Cormorant Garamond,Georgia,serif;color:#2B2523;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">📝 INTERNAL NOTES</h2><div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;padding:16px;white-space:pre-wrap;">${esc(summary.internal_notes)}</div>` : ""}
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
            if (msg) { msg.style.color = "#5E5854"; msg.textContent = "Saving..."; }
            fetch("/admin/civil/case/" + sel.dataset.caseId + "/move-stage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ stage: target })
            }).then(function (r) { return r.json(); }).then(function (d) {
              if (d && d.ok) { location.reload(); return; }
              sel.value = previous;
              sel.disabled = false;
              if (msg) { msg.style.color = "#9C2B1E"; msg.textContent = (d && d.error) || "Could not change stage"; }
            }).catch(function (err) {
              sel.value = previous;
              sel.disabled = false;
              if (msg) { msg.style.color = "#9C2B1E"; msg.textContent = "Could not change stage: " + err.message; }
            });
          });
        })();
      </script>
      ${civilAdminScriptTag()}
      ${require("./client-script").clientScriptTag("esign-admin.js")}
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

  const head = `<h2 style="font-family:Cormorant Garamond,Georgia,serif;color:#2B2523;margin:24px 0 12px 0;font-size:16px;letter-spacing:1.5px;">📁 DOCUMENTS (${live.length})</h2>`;

  if (err) {
    return head + `<div style="padding:14px;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;color:#5E5854;font-style:italic;">Document sync unavailable: ${esc(err)}</div>`;
  }

  const controls = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;">
      <input id="dbx-path" value="${esc(summary.dropbox_path || "")}" placeholder="/Civil/Client Folder — paste a Dropbox path or share link"
             style="flex:1;min-width:260px;padding:8px;border:1px solid #E8E3DC;border-radius:5px;background:#FAF8F5;color:#2B2523;font-size:12px;">
      <button onclick="dbxSave(${id})" style="padding:8px 14px;background:#2B2523;color:#FAF8F5;border:1px solid #3A3330;border-radius:5px;cursor:pointer;font-size:11px;font-family:Montserrat,sans-serif;letter-spacing:1px;">${linked ? "UPDATE" : "LINK"} FOLDER</button>
      <button onclick="dbxSuggest(${id})" style="padding:8px 14px;background:#FAF8F5;color:#2B2523;border:1px solid #E8E3DC;border-radius:5px;cursor:pointer;font-size:11px;font-family:Montserrat,sans-serif;letter-spacing:1px;">SUGGEST</button>
      ${linked ? "" : `<button onclick="dbxProvision(${id})" title="Create this matter's folder in the civil Dropbox root, with the standard subfolders, and link it" style="padding:8px 14px;background:#2F6B3F;color:#FAF8F5;border:1px solid #2F6B3F;border-radius:5px;cursor:pointer;font-size:11px;font-family:Montserrat,sans-serif;letter-spacing:1px;">CREATE FOLDER</button>`}
      ${linked ? `<button onclick="dbxSync(${id})" style="padding:8px 14px;background:#FF7B00;color:#1E1B1A;border:1px solid #A34C00;border-radius:5px;cursor:pointer;font-size:11px;font-family:Montserrat,sans-serif;letter-spacing:1px;">SYNC NOW</button>` : ""}
      ${linked ? `<button onclick="dbxArchive(${id}, ${archived ? "false" : "true"})" style="padding:8px 14px;background:${archived ? "#2F6B3F" : "#9C2B1E"};color:#FAF8F5;border:1px solid #3A3330;border-radius:5px;cursor:pointer;font-size:11px;font-family:Montserrat,sans-serif;letter-spacing:1px;">${archived ? "UNARCHIVE" : "ARCHIVE"}</button>` : ""}
    </div>
    <div id="dbx-msg" style="font-size:11px;color:#5E5854;margin-bottom:10px;">
      ${linked ? `Linked to <strong>${esc(summary.dropbox_path)}</strong> · last synced ${esc(synced)}${archived ? ` · <span style="color:#9C2B1E;font-weight:700;">ARCHIVED — sync paused</span>` : ""}` : "No Dropbox folder linked yet."}
      ${summary.dropbox_sync_error ? `<div style="color:#9C2B1E;margin-top:4px;">Last sync error: ${esc(summary.dropbox_sync_error)}</div>` : ""}
    </div>
    <div id="dbx-suggest"></div>
    ${archived ? "" : `<div data-civil-upload data-case-id="${esc(String(id))}"
         data-categories="${esc(JSON.stringify((cats || []).filter(c => c.key !== "other").map(c => ({ key: c.key, label: c.label }))))}"
         style="margin:4px 0 14px 0;"></div>
    ${require("./client-script").clientScriptTag("civil-docs.js")}`}`;

  // The handlers for every button above. This used to ride along only with
  // the file list, so on a matter with no documents yet — every unlinked
  // case, and every brand-new one — LINK FOLDER, SUGGEST and SYNC NOW
  // called functions that were never defined, and did nothing at all.
  const script = `    <script>
      function dbxMsg(t, bad) {
        var el = document.getElementById("dbx-msg");
        el.innerHTML = t; el.style.color = bad ? "#9C2B1E" : "#5E5854";
      }
      function dbxFilter(cat) {
        document.querySelectorAll(".dbx-row").forEach(function (r) {
          r.style.display = (!cat || r.dataset.cat === cat) ? "flex" : "none";
        });
        document.querySelectorAll(".dbx-tab").forEach(function (b) {
          var on = (b.dataset.cat || "") === cat;
          b.style.background = on ? "#2B2523" : "#FAF8F5";
          b.style.color = on ? "#FAF8F5" : (b.style.borderColor || "#2B2523");
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
          row.style.cssText = "padding:6px 8px;margin-bottom:4px;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:5px;display:flex;justify-content:space-between;gap:10px;align-items:center;";
          var label = document.createElement("span");
          label.style.cssText = "font-size:12px;color:#2B2523;word-break:break-all;";
          label.textContent = sg.path;
          var use = document.createElement("a");
          use.href = "#";
          use.style.cssText = "font-size:11px;color:#A34C00;font-weight:600;text-decoration:none;white-space:nowrap;";
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
      // Make the folder rather than find it: for a matter opened before
      // setup was automatic, or one opened while Dropbox was down. Safe to
      // press twice — an existing folder of the same name is linked, not
      // duplicated.
      async function dbxProvision(id) {
        dbxMsg("Creating the matter folder in Dropbox…");
        var d = await dbxPost("/admin/civil/api/cases/" + id + "/provision", {});
        var p = (d && d.provisioning) || {};
        var ok = p.dropbox && (p.dropbox.created || p.dropbox.adopted || p.dropbox.linked);
        if (ok) {
          var el = document.getElementById("dbx-msg");
          el.style.color = "#2F6B3F";
          el.textContent = p.summary + ". Reloading…";
          setTimeout(function () { location.reload(); }, 1100);
          return;
        }
        var why = (p.dropbox && (p.dropbox.reason || p.dropbox.error)) || (d && d.error) || "Could not create the folder.";
        var el2 = document.getElementById("dbx-msg");
        el2.style.color = "#9C2B1E";
        el2.textContent = why;
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

  if (!live.length) {
    return head + controls + `<div style="padding:16px;text-align:center;font-style:italic;color:#5E5854;background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;">${linked ? "No documents mirrored yet — hit Sync Now." : "Link a folder to mirror this matter's documents."}</div>` + script;
  }

  const tabs = withFiles.map(c =>
    `<button onclick="dbxFilter('${c.key}')" data-cat="${c.key}" class="dbx-tab" style="padding:5px 10px;border:1px solid ${c.color};border-radius:14px;background:#FAF8F5;color:${c.color};cursor:pointer;font-size:11px;font-weight:600;">${esc(c.label)} ${c.count}</button>`
  ).join(" ");

  const rows = live.map(f => {
    const cat = cats.find(c => c.key === f.category) || { color: "#4B5563", label: f.category };
    const kb = f.size_bytes ? (f.size_bytes > 1048576 ? (f.size_bytes / 1048576).toFixed(1) + " MB" : Math.round(f.size_bytes / 1024) + " KB") : "";
    return `
      <div class="dbx-row" data-cat="${esc(f.category)}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #E8E3DC;">
        <span style="flex-shrink:0;width:9px;height:9px;border-radius:2px;background:${cat.color};"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;color:#2B2523;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name || "")}</div>
          <div style="font-size:10px;color:#5E5854;">${esc(cat.label)}${f.relative_folder ? " · " + esc(f.relative_folder) : ""}${kb ? " · " + kb : ""}${f.server_modified ? " · " + fmtDate(f.server_modified) : ""}</div>
        </div>
        ${f.archived ? `<span style="font-size:9px;font-weight:700;color:#5E5854;letter-spacing:1px;">ARCHIVED</span>` : ""}
        <a href="#" onclick="dbxOpen(event, ${f.id})" style="flex-shrink:0;font-size:11px;color:#A34C00;text-decoration:none;font-weight:600;">OPEN ↗</a>
      </div>`;
  }).join("");

  return head + controls + `
    <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:5px;">
      <button onclick="dbxFilter('')" class="dbx-tab" data-cat="" style="padding:5px 10px;border:1px solid #2B2523;border-radius:14px;background:#2B2523;color:#FAF8F5;cursor:pointer;font-size:11px;font-weight:600;">All ${live.length}</button>
      ${tabs}
    </div>
    <div style="background:#FAF8F5;border:1px solid #E8E3DC;border-radius:6px;overflow:hidden;">${rows}</div>

    ${script}`;
}

module.exports = { renderKanban, renderCaseDetail, renderDocumentsPanel, civilAdminScriptTag };
