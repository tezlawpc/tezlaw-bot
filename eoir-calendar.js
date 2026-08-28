// eoir-calendar.js — Unified court calendar module
//
// Consolidates all hearing and deadline data from Zara into one calendar:
//   1. hearing_notes         → both past hearings AND next_hearing_date (upcoming)
//   2. individual_hearing_notes → past + next_action_deadline
//   3. client_hearing_notices  → from EOIR notices in Dropbox
//   4. deadlines               → all filing/action deadlines
//
// Provides two views (toggleable):
//   - List (agenda style, grouped by date)
//   - Month grid (Google Calendar style)
//
// De-duplicates the same client at the same time appearing across multiple
// sources (e.g. a hearing extracted from both a Dropbox notice and manually
// entered as a hearing note).

const db = require("./db");

const brand = { gold: "#B79C62", navy: "#0C1C36" };

// Colors for different event types
const EVENT_COLORS = {
  hearing:            "#0061FF",   // blue - hearings
  hearing_past:       "#8ea6c9",   // muted blue - past hearings
  hearing_notice:     "#00a86b",   // green - notices from Dropbox
  individual_hearing: "#9c27b0",   // purple - merits/individual
  deadline:           "#f9a825",   // yellow - deadlines
  deadline_overdue:   "#c62828",   // red - overdue deadlines
};

const SOURCE_LABELS = {
  hearing_note_upcoming: "Upcoming (from note)",
  hearing_note_past:     "Past hearing",
  hearing_notice:        "EOIR Notice",
  individual_hearing:    "Merits hearing",
  individual_upcoming:   "Next action",
  deadline:              "Deadline",
};

// ─── Data fetching ───────────────────────────────────

async function getUnifiedEvents({ from_date, to_date, client_search, event_types, court, judge }) {
  // Build WHERE clauses per source
  const params = [];
  const addParam = (v) => { params.push(v); return `$${params.length}`; };

  const fromP = from_date ? addParam(from_date) : null;
  const toP = to_date ? addParam(to_date) : null;
  const clientP = client_search ? addParam(`%${client_search}%`) : null;

  const dateRange = (col) => {
    const parts = [];
    if (fromP) parts.push(`${col} >= ${fromP}`);
    if (toP) parts.push(`${col} <= ${toP}`);
    return parts.length ? parts.join(" AND ") : null;
  };

  const clientFilter = (nameCol, aNumCol) => {
    if (!clientP) return null;
    return `(${nameCol} ILIKE ${clientP} OR ${aNumCol} ILIKE ${clientP})`;
  };

  // Wrap conditions with AND
  const buildWhere = (baseCond, ...extras) => {
    const clauses = [baseCond, ...extras].filter(Boolean);
    return clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  };

  // ──────────────────────────────────────────────
  // Query 1: hearing_notes with upcoming next_hearing_date
  // ──────────────────────────────────────────────
  const q1 = `
    SELECT 'hearing_note_upcoming' as source, id::text as source_id,
           client_name, a_number, next_hearing_date as event_date,
           next_hearing_type as event_subtype,
           judge_name, NULL as court_name, NULL as court_address,
           NULL::text as description, NULL as priority, NULL as status
    FROM hearing_notes
    ${buildWhere(
      "next_hearing_date IS NOT NULL",
      dateRange("next_hearing_date"),
      clientFilter("client_name", "a_number")
    )}
  `;

  // ──────────────────────────────────────────────
  // Query 2: hearing_notes past hearing_date
  // ──────────────────────────────────────────────
  const q2 = `
    SELECT 'hearing_note_past' as source, id::text as source_id,
           client_name, a_number, hearing_date as event_date,
           hearing_type as event_subtype,
           judge_name, NULL as court_name, NULL as court_address,
           disposition as description, NULL as priority, NULL as status
    FROM hearing_notes
    ${buildWhere(
      "hearing_date IS NOT NULL",
      dateRange("hearing_date"),
      clientFilter("client_name", "a_number")
    )}
  `;

  // ──────────────────────────────────────────────
  // Query 3: client_hearing_notices (Dropbox extractions)
  // ──────────────────────────────────────────────
  const q3 = `
    SELECT 'hearing_notice' as source, id::text as source_id,
           client_name, a_number, hearing_date as event_date,
           hearing_type as event_subtype,
           judge_name, court_name, court_address,
           notice_type as description, NULL as priority, NULL as status
    FROM client_hearing_notices
    ${buildWhere(
      "hearing_date IS NOT NULL",
      dateRange("hearing_date"),
      clientFilter("client_name", "a_number")
    )}
  `;

  // ──────────────────────────────────────────────
  // Query 4a: individual_hearing_notes past hearing_date
  // ──────────────────────────────────────────────
  const q4a = `
    SELECT 'individual_hearing' as source, id::text as source_id,
           client_name, a_number, hearing_date as event_date,
           'individual/merits' as event_subtype,
           judge_name, NULL as court_name, NULL as court_address,
           disposition as description, NULL as priority, NULL as status
    FROM individual_hearing_notes
    ${buildWhere(
      "hearing_date IS NOT NULL",
      dateRange("hearing_date"),
      clientFilter("client_name", "a_number")
    )}
  `;

  // ──────────────────────────────────────────────
  // Query 4b: individual_hearing_notes upcoming next_action_deadline
  // ──────────────────────────────────────────────
  const q4b = `
    SELECT 'individual_upcoming' as source, id::text as source_id,
           client_name, a_number, next_action_deadline as event_date,
           'next action' as event_subtype,
           judge_name, NULL as court_name, NULL as court_address,
           NULL::text as description, NULL as priority, NULL as status
    FROM individual_hearing_notes
    ${buildWhere(
      "next_action_deadline IS NOT NULL",
      dateRange("next_action_deadline"),
      clientFilter("client_name", "a_number")
    )}
  `;

  // ──────────────────────────────────────────────
  // Query 5: deadlines (pending only)
  // ──────────────────────────────────────────────
  const q5 = `
    SELECT 'deadline' as source, id::text as source_id,
           client_name, a_number, due_date as event_date,
           'deadline' as event_subtype,
           NULL as judge_name, NULL as court_name, NULL as court_address,
           description, priority, status
    FROM deadlines
    ${buildWhere(
      "status = 'pending'",
      "due_date IS NOT NULL",
      dateRange("due_date"),
      clientFilter("client_name", "a_number")
    )}
  `;

  // Combine all with UNION ALL. If any source table is missing, catch error.
  const results = [];
  const queries = [
    ["hearing_notes upcoming", q1],
    ["hearing_notes past", q2],
    ["hearing_notices", q3],
    ["individual_hearing past", q4a],
    ["individual_hearing upcoming", q4b],
    ["deadlines", q5],
  ];

  for (const [label, sql] of queries) {
    try {
      const { rows } = await db.query(sql, params);
      results.push(...rows);
    } catch (e) {
      // Table may not exist yet or other query error
      console.warn(`[eoir-calendar] ${label} query failed:`, e.message);
    }
  }

  // Post-filter for judge/court after aggregation
  let filtered = results;
  if (court) {
    filtered = filtered.filter(e => e.court_name && e.court_name.toLowerCase().includes(court.toLowerCase()));
  }
  if (judge) {
    filtered = filtered.filter(e => e.judge_name && e.judge_name.toLowerCase().includes(judge.toLowerCase()));
  }
  if (event_types && event_types.length) {
    filtered = filtered.filter(e => event_types.includes(e.source));
  }

  // De-duplicate: same client + same event_date rounded to nearest hour → merge sources
  const deduped = dedupeEvents(filtered);

  // Sort by date ascending
  deduped.sort((a, b) => new Date(a.event_date) - new Date(b.event_date));

  return deduped;
}

// De-duplicate events at the same time. If two sources have the same client
// at the same time (e.g. hearing_note_upcoming AND hearing_notice), merge them
// into one event that lists both source references.
function dedupeEvents(events) {
  const byKey = new Map();
  for (const e of events) {
    if (!e.event_date) continue;
    const dt = new Date(e.event_date);
    // Round to nearest hour for dedup
    const hourKey = `${(e.client_name || "").toLowerCase().trim()}|${(e.a_number || "").toLowerCase().trim()}|${dt.toISOString().substring(0, 13)}`;

    if (!byKey.has(hourKey)) {
      byKey.set(hourKey, { ...e, sources: [e.source], source_refs: [{ source: e.source, id: e.source_id }] });
    } else {
      const existing = byKey.get(hourKey);
      existing.sources.push(e.source);
      existing.source_refs.push({ source: e.source, id: e.source_id });
      // Fill in blanks from this event
      if (!existing.court_name && e.court_name) existing.court_name = e.court_name;
      if (!existing.court_address && e.court_address) existing.court_address = e.court_address;
      if (!existing.judge_name && e.judge_name) existing.judge_name = e.judge_name;
      if (!existing.description && e.description) existing.description = e.description;
      // Prefer non-deadline events as primary source
      if (existing.source === "deadline" && e.source !== "deadline") {
        existing.source = e.source;
        existing.event_subtype = e.event_subtype;
      }
    }
  }
  return Array.from(byKey.values());
}

// Compute stats for the header cards
function computeStats(events) {
  const now = new Date();
  const dayMs = 86400000;
  const weekEnd = new Date(now.getTime() + 7 * dayMs);
  const monthEnd = new Date(now.getTime() + 30 * dayMs);
  const stats = {
    total: events.length,
    upcoming_week: 0,
    upcoming_month: 0,
    past_due_deadlines: 0,
    pending_deadlines: 0,
    hearings_today: 0,
  };
  for (const e of events) {
    const dt = new Date(e.event_date);
    const isDeadline = e.source === "deadline";
    if (isDeadline) {
      if (dt < now) stats.past_due_deadlines++;
      else stats.pending_deadlines++;
    } else {
      if (dt >= now && dt <= weekEnd) stats.upcoming_week++;
      if (dt >= now && dt <= monthEnd) stats.upcoming_month++;
      // Today
      const isToday = dt.toDateString() === now.toDateString();
      if (isToday) stats.hearings_today++;
    }
  }
  return stats;
}

// Group events by date string for the list view
function groupByDate(events) {
  const groups = new Map();
  for (const e of events) {
    const dt = new Date(e.event_date);
    const key = dt.toISOString().substring(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return Array.from(groups.entries()).map(([date, events]) => ({ date, events }));
}

// ─── Rendering: main page ────────────────────────────

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderCalendarPage({ events, stats, filters, view, monthYear }) {
  const listBody = renderListView(groupByDate(events));
  const monthBody = renderMonthView(events, monthYear);
  const activeView = view || "list";

  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
    <div>
      <h1 style="margin:0;">🗓️ EOIR Calendar</h1>
      <div style="font-size:12px; color:#666; margin-top:4px;">Unified view of hearings, notices, individual/merits, and deadlines.</div>
    </div>
    <div style="display:flex; gap:8px; align-items:center;">
      <div style="background:#f0f0f0; border-radius:6px; padding:2px; display:inline-flex;">
        <button onclick="switchView('list')" id="view-list-btn" style="background:${activeView === 'list' ? brand.navy : 'transparent'}; color:${activeView === 'list' ? 'white' : '#666'}; padding:6px 14px; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">📋 List</button>
        <button onclick="switchView('month')" id="view-month-btn" style="background:${activeView === 'month' ? brand.navy : 'transparent'}; color:${activeView === 'month' ? 'white' : '#666'}; padding:6px 14px; border:none; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600;">📅 Month</button>
      </div>
    </div>
  </div>

  <!-- Stats bar -->
  <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; margin:16px 0;">
    <div style="background:white; padding:14px; border-radius:8px; border:1px solid #e0e0e0; border-left:4px solid ${EVENT_COLORS.hearing};">
      <div style="font-size:11px; color:#666;">HEARINGS TODAY</div>
      <div style="font-size:24px; font-weight:700; color:${brand.navy}; margin-top:4px;">${stats.hearings_today}</div>
    </div>
    <div style="background:white; padding:14px; border-radius:8px; border:1px solid #e0e0e0; border-left:4px solid ${EVENT_COLORS.hearing};">
      <div style="font-size:11px; color:#666;">NEXT 7 DAYS</div>
      <div style="font-size:24px; font-weight:700; color:${brand.navy}; margin-top:4px;">${stats.upcoming_week}</div>
    </div>
    <div style="background:white; padding:14px; border-radius:8px; border:1px solid #e0e0e0; border-left:4px solid ${EVENT_COLORS.hearing};">
      <div style="font-size:11px; color:#666;">NEXT 30 DAYS</div>
      <div style="font-size:24px; font-weight:700; color:${brand.navy}; margin-top:4px;">${stats.upcoming_month}</div>
    </div>
    <div style="background:white; padding:14px; border-radius:8px; border:1px solid #e0e0e0; border-left:4px solid ${EVENT_COLORS.deadline};">
      <div style="font-size:11px; color:#666;">PENDING DEADLINES</div>
      <div style="font-size:24px; font-weight:700; color:${brand.navy}; margin-top:4px;">${stats.pending_deadlines}</div>
    </div>
    ${stats.past_due_deadlines > 0 ? `
    <div style="background:white; padding:14px; border-radius:8px; border:1px solid #e0e0e0; border-left:4px solid ${EVENT_COLORS.deadline_overdue};">
      <div style="font-size:11px; color:${EVENT_COLORS.deadline_overdue}; font-weight:600;">⚠️ PAST DUE</div>
      <div style="font-size:24px; font-weight:700; color:${EVENT_COLORS.deadline_overdue}; margin-top:4px;">${stats.past_due_deadlines}</div>
    </div>` : ""}
  </div>

  <!-- Filters -->
  <form method="GET" style="background:#f8f8f8; padding:12px; border-radius:6px; margin-bottom:16px; display:flex; gap:8px; flex-wrap:wrap; align-items:end;">
    <input type="hidden" name="view" value="${activeView}">
    <div>
      <label style="display:block; font-size:11px; color:#666;">From</label>
      <input type="date" name="from" value="${escapeHtml(filters.from_date_str || "")}" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px;">
    </div>
    <div>
      <label style="display:block; font-size:11px; color:#666;">To</label>
      <input type="date" name="to" value="${escapeHtml(filters.to_date_str || "")}" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px;">
    </div>
    <div>
      <label style="display:block; font-size:11px; color:#666;">Client / A#</label>
      <input type="text" name="client" value="${escapeHtml(filters.client_search || "")}" placeholder="Search..." style="padding:6px 10px; border:1px solid #ccc; border-radius:4px; width:180px;">
    </div>
    <div>
      <label style="display:block; font-size:11px; color:#666;">Court</label>
      <input type="text" name="court" value="${escapeHtml(filters.court || "")}" placeholder="e.g. LA" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px; width:120px;">
    </div>
    <div>
      <label style="display:block; font-size:11px; color:#666;">Judge</label>
      <input type="text" name="judge" value="${escapeHtml(filters.judge || "")}" placeholder="e.g. Riley" style="padding:6px 10px; border:1px solid #ccc; border-radius:4px; width:120px;">
    </div>
    <button type="submit" style="background:${brand.navy}; color:white; padding:8px 16px; border:none; border-radius:4px; cursor:pointer;">Filter</button>
    <a href="/admin/calendar?view=${activeView}" style="padding:8px 16px; color:#666; text-decoration:none; font-size:13px;">Reset</a>
  </form>

  <!-- Legend -->
  <div style="display:flex; gap:14px; flex-wrap:wrap; margin-bottom:12px; font-size:11px; color:#666;">
    <span><span style="display:inline-block; width:10px; height:10px; background:${EVENT_COLORS.hearing}; border-radius:2px; vertical-align:middle;"></span> Hearing (from notes)</span>
    <span><span style="display:inline-block; width:10px; height:10px; background:${EVENT_COLORS.hearing_notice}; border-radius:2px; vertical-align:middle;"></span> EOIR notice</span>
    <span><span style="display:inline-block; width:10px; height:10px; background:${EVENT_COLORS.individual_hearing}; border-radius:2px; vertical-align:middle;"></span> Merits/individual</span>
    <span><span style="display:inline-block; width:10px; height:10px; background:${EVENT_COLORS.deadline}; border-radius:2px; vertical-align:middle;"></span> Deadline</span>
    <span><span style="display:inline-block; width:10px; height:10px; background:${EVENT_COLORS.hearing_past}; border-radius:2px; vertical-align:middle;"></span> Past hearing</span>
  </div>

  <!-- Views (only one visible at a time) -->
  <div id="view-list" style="display:${activeView === 'list' ? 'block' : 'none'};">
    ${listBody}
  </div>
  <div id="view-month" style="display:${activeView === 'month' ? 'block' : 'none'};">
    ${monthBody}
  </div>

  <script>
    function switchView(v) {
      const listEl = document.getElementById("view-list");
      const monthEl = document.getElementById("view-month");
      const listBtn = document.getElementById("view-list-btn");
      const monthBtn = document.getElementById("view-month-btn");
      if (v === "list") {
        listEl.style.display = "block";
        monthEl.style.display = "none";
        listBtn.style.background = "${brand.navy}";
        listBtn.style.color = "white";
        monthBtn.style.background = "transparent";
        monthBtn.style.color = "#666";
      } else {
        listEl.style.display = "none";
        monthEl.style.display = "block";
        listBtn.style.background = "transparent";
        listBtn.style.color = "#666";
        monthBtn.style.background = "${brand.navy}";
        monthBtn.style.color = "white";
      }
      // Update URL without reload
      const url = new URL(location.href);
      url.searchParams.set("view", v);
      history.replaceState({}, "", url);
    }
    function navMonth(delta) {
      const url = new URL(location.href);
      let m = parseInt(url.searchParams.get("m") || (new Date().getMonth() + 1), 10);
      let y = parseInt(url.searchParams.get("y") || new Date().getFullYear(), 10);
      m += delta;
      if (m > 12) { m = 1; y++; }
      if (m < 1) { m = 12; y--; }
      url.searchParams.set("m", m);
      url.searchParams.set("y", y);
      url.searchParams.set("view", "month");
      location.href = url.toString();
    }
    function goToday() {
      const url = new URL(location.href);
      url.searchParams.delete("m");
      url.searchParams.delete("y");
      url.searchParams.delete("from");
      url.searchParams.delete("to");
      location.href = url.toString();
    }
  </script>`;
}

// ─── List view (agenda) ──────────────────────────────

function renderListView(groups) {
  if (!groups.length) {
    return `<div style="text-align:center; padding:60px 20px; color:#888; background:white; border-radius:8px; border:1px dashed #ccc;">
      No events in this date range. Try widening the filters or check back after new hearings are added.
    </div>`;
  }

  const now = new Date();
  const today = now.toISOString().substring(0, 10);
  const tomorrowDate = new Date(now.getTime() + 86400000);
  const tomorrow = tomorrowDate.toISOString().substring(0, 10);

  return groups.map(g => {
    const dt = new Date(g.date + "T00:00:00");
    const isToday = g.date === today;
    const isTomorrow = g.date === tomorrow;
    const isPast = g.date < today;
    const dateLabel = isToday ? "Today"
                    : isTomorrow ? "Tomorrow"
                    : dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const relLabel = isToday || isTomorrow ? `<span style="color:#888; font-weight:normal;"> · ${dt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>` : "";

    return `
    <div style="margin-bottom:24px;">
      <h3 style="margin:0 0 8px 0; padding-bottom:6px; border-bottom:2px solid ${isToday ? brand.gold : '#e0e0e0'}; color:${isPast ? '#888' : brand.navy}; font-size:14px; letter-spacing:0.5px;">
        ${dateLabel}${relLabel} ${g.events.length > 1 ? `<span style="font-size:11px; color:#888; font-weight:normal; margin-left:8px;">(${g.events.length} events)</span>` : ""}
      </h3>
      ${g.events.map(e => renderEventCard(e, isPast)).join("")}
    </div>`;
  }).join("");
}

function renderEventCard(event, isPast) {
  const color = EVENT_COLORS[event.source] || EVENT_COLORS.hearing;
  const dt = new Date(event.event_date);
  const timeStr = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const opacity = isPast ? 0.7 : 1;

  const sourceLabels = event.sources
    ? Array.from(new Set(event.sources)).map(s => SOURCE_LABELS[s] || s)
    : [SOURCE_LABELS[event.source] || event.source];

  // Build link to source
  let linkHref = "#";
  const primaryRef = event.source_refs?.[0] || { source: event.source, id: event.source_id };
  if (primaryRef.source === "hearing_note_upcoming" || primaryRef.source === "hearing_note_past") {
    linkHref = `/admin/hearing/notes/${primaryRef.id}`;
  } else if (primaryRef.source === "individual_hearing" || primaryRef.source === "individual_upcoming") {
    linkHref = `/admin/individual-hearings/${primaryRef.id}`;
  } else if (primaryRef.source === "hearing_notice") {
    linkHref = `/admin/notices`;
  } else if (primaryRef.source === "deadline") {
    linkHref = `/admin/deadlines`;
  }

  return `
    <a href="${linkHref}" style="display:block; background:white; padding:12px 14px; border-radius:6px; border:1px solid #eee; border-left:4px solid ${color}; margin-bottom:6px; text-decoration:none; color:inherit; opacity:${opacity}; transition:box-shadow .1s;" onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,.08)';" onmouseout="this.style.boxShadow='none';">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
        <div style="flex:1;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span style="font-weight:600; color:${brand.navy};">${escapeHtml(event.client_name || "(no name)")}</span>
            ${event.a_number ? `<span style="font-size:11px; color:#888; font-family:monospace;">${escapeHtml(event.a_number)}</span>` : ""}
            ${event.event_subtype ? `<span style="background:${color}; color:white; padding:2px 7px; border-radius:10px; font-size:10px; font-weight:600;">${escapeHtml(event.event_subtype)}</span>` : ""}
          </div>
          <div style="font-size:12px; color:#666; margin-top:4px; display:flex; gap:10px; flex-wrap:wrap;">
            ${event.court_name ? `<span>📍 ${escapeHtml(event.court_name)}</span>` : ""}
            ${event.judge_name ? `<span>⚖️ ${escapeHtml(event.judge_name)}</span>` : ""}
          </div>
          ${event.description ? `<div style="font-size:12px; color:#555; margin-top:6px; font-style:italic;">${escapeHtml(event.description.substring(0, 200))}${event.description.length > 200 ? '…' : ''}</div>` : ""}
          <div style="font-size:10px; color:#aaa; margin-top:6px;">${sourceLabels.join(" · ")}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:15px; font-weight:600; color:${isPast ? '#888' : brand.navy};">${timeStr}</div>
        </div>
      </div>
    </a>`;
}

// ─── Month grid view ─────────────────────────────────

function renderMonthView(events, monthYear) {
  const now = new Date();
  const currentMonth = monthYear ? monthYear.month : (now.getMonth() + 1);
  const currentYear = monthYear ? monthYear.year : now.getFullYear();

  // Build a map of date → events for this month
  const eventsByDate = new Map();
  for (const e of events) {
    if (!e.event_date) continue;
    const dt = new Date(e.event_date);
    if (dt.getMonth() + 1 !== currentMonth || dt.getFullYear() !== currentYear) continue;
    const key = dt.getDate();
    if (!eventsByDate.has(key)) eventsByDate.set(key, []);
    eventsByDate.get(key).push(e);
  }

  const firstDay = new Date(currentYear, currentMonth - 1, 1);
  const lastDay = new Date(currentYear, currentMonth, 0);
  const daysInMonth = lastDay.getDate();
  const startWeekday = firstDay.getDay(); // 0=Sun

  const monthName = firstDay.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  // Weekday headers
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayCells = weekdays.map(w => `
    <div style="padding:8px; text-align:center; font-size:11px; color:#666; font-weight:600; letter-spacing:0.5px; background:#f8f8f8;">
      ${w}
    </div>
  `).join("");

  // Day cells
  const cells = [];
  // Empty cells for the start of the month
  for (let i = 0; i < startWeekday; i++) {
    cells.push(`<div style="background:#fafafa; min-height:110px;"></div>`);
  }

  const todayDate = now.getDate();
  const isCurrentMonth = now.getMonth() + 1 === currentMonth && now.getFullYear() === currentYear;

  for (let day = 1; day <= daysInMonth; day++) {
    const dayEvents = eventsByDate.get(day) || [];
    const isToday = isCurrentMonth && day === todayDate;
    const eventsHtml = dayEvents.slice(0, 4).map(e => {
      const color = EVENT_COLORS[e.source] || EVENT_COLORS.hearing;
      const dt = new Date(e.event_date);
      const timeStr = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      const label = e.client_name ? e.client_name.split(",")[0].substring(0, 12) : "?";
      return `<div title="${escapeHtml(timeStr + ' ' + (e.client_name || ''))}" style="background:${color}; color:white; padding:2px 5px; border-radius:3px; font-size:10px; margin-bottom:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
        ${escapeHtml(timeStr.replace(":00", ""))} ${escapeHtml(label)}
      </div>`;
    }).join("");
    const overflowLabel = dayEvents.length > 4 ? `<div style="font-size:10px; color:#666; font-weight:600;">+${dayEvents.length - 4} more</div>` : "";

    cells.push(`
      <div style="background:white; padding:6px; min-height:110px; border:1px solid #f0f0f0; ${isToday ? `background:#fff8e1; border:2px solid ${brand.gold};` : ""} display:flex; flex-direction:column;">
        <div style="font-size:12px; color:${isToday ? brand.gold : '#333'}; font-weight:${isToday ? '700' : '500'}; margin-bottom:4px;">${day}${isToday ? " · Today" : ""}</div>
        <div style="flex:1; overflow:hidden;">
          ${eventsHtml}
          ${overflowLabel}
        </div>
      </div>
    `);
  }

  // Fill trailing empty cells
  const totalCells = startWeekday + daysInMonth;
  const trailing = (7 - (totalCells % 7)) % 7;
  for (let i = 0; i < trailing; i++) {
    cells.push(`<div style="background:#fafafa; min-height:110px;"></div>`);
  }

  return `
    <div style="background:white; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; background:${brand.navy}; color:white;">
        <button onclick="navMonth(-1)" style="background:rgba(255,255,255,.1); color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:14px;">‹ Prev</button>
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="font-size:16px; font-weight:600;">${monthName}</div>
          <button onclick="goToday()" style="background:${brand.gold}; color:white; border:none; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px;">Today</button>
        </div>
        <button onclick="navMonth(1)" style="background:rgba(255,255,255,.1); color:white; border:none; padding:6px 14px; border-radius:4px; cursor:pointer; font-size:14px;">Next ›</button>
      </div>
      <div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:1px; background:#e0e0e0;">
        ${weekdayCells}
        ${cells.join("")}
      </div>
    </div>
  `;
}

module.exports = {
  getUnifiedEvents,
  computeStats,
  groupByDate,
  renderCalendarPage,
  renderListView,
  renderMonthView,
  EVENT_COLORS,
  SOURCE_LABELS,
};
