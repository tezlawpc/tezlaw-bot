// ============================================================
//  TEZ LAW P.C. — MOBILE APP (PWA)
//  ─────────────────────────────────────────────────────────
//  iPhone-optimized client search + detail views.
//  Designed for one-handed use, big touch targets, minimal scrolling.
//
//  Routes served:
//    GET  /admin/mobile                → Search page
//    GET  /admin/mobile/client/:key    → Client detail
//    GET  /admin/api/clients/search    → JSON search API
//    GET  /admin/api/clients/:key      → JSON detail API
// ============================================================

const db = require("./db");

// ── JSON API: Universal Client Search ─────────────────────
// Searches across: name, a_number, phone, email, case_type,
// hearing_type, language, address, judge_name, court_location.

async function searchClients(q, limit = 25) {
  if (!q || q.trim().length < 2) return [];

  const term = "%" + q.trim().toLowerCase() + "%";
  const cp = require("./client-profiles");
  const all = await cp.aggregateClients();

  const results = [];
  for (const c of all) {
    const haystack = [
      c.client_name, c.a_number, c.client_email, c.client_phone,
      c.client_address, c.client_language,
      ...(Array.from(c.case_types || [])),
      ...(Array.from(c.judges || [])),
      ...(c.hearings || []).map(h => h.type_label),
      ...(c.hearings || []).map(h => h.disposition),
    ].filter(Boolean).map(x => String(x).toLowerCase()).join(" | ");

    if (haystack.includes(q.trim().toLowerCase())) {
      // Get most-recent-upcoming hearing for the card preview
      const now = Date.now();
      const upcoming = (c.hearings || [])
        .filter(h => h.hearing_date && new Date(h.hearing_date).getTime() >= now)
        .sort((a, b) => new Date(a.hearing_date) - new Date(b.hearing_date))[0];

      results.push({
        key: c.key,
        client_name: c.client_name,
        a_number: c.a_number,
        client_phone: c.client_phone,
        client_email: c.client_email,
        client_language: c.client_language,
        case_types: Array.from(c.case_types || []),
        upcoming_hearing_date: upcoming ? upcoming.hearing_date : null,
        upcoming_hearing_type: upcoming ? upcoming.type_label : null,
        total_hearings: (c.hearings || []).length,
      });
    }
    if (results.length >= limit) break;
  }
  return results;
}

// ── JSON API: Full Client Detail ────────────────────────

async function getClientDetail(key) {
  const cp = require("./client-profiles");
  const all = await cp.aggregateClients();
  const client = all.find(c => c.key === key);
  if (!client) return null;

  // Also fetch pending deadlines for this client
  let deadlines = [];
  try {
    const r = await db.query(
      `SELECT id, description, due_date, priority, source_type
       FROM deadlines
       WHERE (client_name = $1 OR a_number = $2)
         AND status = 'pending'
       ORDER BY due_date ASC LIMIT 20`,
      [client.client_name, client.a_number]
    );
    deadlines = r.rows;
  } catch {}

  // Recent notices (unnotified)
  let unnotifiedNotices = [];
  try {
    const r = await db.query(
      `SELECT id, hearing_date, hearing_type, court_name, notified_at
       FROM client_hearing_notices
       WHERE (client_key = $1 OR a_number = $2)
         AND is_hearing_notice = TRUE
         AND dismissed_at IS NULL
         AND notified_at IS NULL
       ORDER BY hearing_date ASC LIMIT 10`,
      [key, client.a_number]
    );
    unnotifiedNotices = r.rows;
  } catch {}

  const now = Date.now();
  return {
    key: client.key,
    client_name: client.client_name,
    a_number: client.a_number,
    client_email: client.client_email,
    client_phone: client.client_phone,
    client_address: client.client_address,
    client_language: client.client_language,
    case_types: Array.from(client.case_types || []),
    judges: Array.from(client.judges || []),
    hearings: (client.hearings || []).map(h => ({
      id: h.id,
      kind: h.kind,
      type_label: h.type_label,
      hearing_date: h.hearing_date,
      judge_name: h.judge_name,
      court_location: h.court_location,
      disposition: h.disposition,
      sent: h.sent,
      is_future: h.hearing_date && new Date(h.hearing_date).getTime() >= now,
    })).sort((a, b) => new Date(b.hearing_date || 0) - new Date(a.hearing_date || 0)),
    deadlines,
    unnotified_notices: unnotifiedNotices,
  };
}

// ── Mobile Search Page ───────────────────────────────────

function renderMobileSearchPage() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<title>Zara — Client Search</title>

<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0C1C36">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Zara">
<link rel="apple-touch-icon" href="https://tezlawfirm.com/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png">

<style>
  :root {
    --navy: #0C1C36;
    --gold: #B79C62;
    --canvas: #f5f2ea;
    --card: #ffffff;
    --text: #0C1C36;
    --muted: #6b6b6b;
    --danger: #c62828;
    --success: #2e7d32;
    --safe-top: env(safe-area-inset-top);
    --safe-bottom: env(safe-area-inset-bottom);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; background: var(--canvas); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", Segoe UI, Roboto, sans-serif;
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding-top: var(--safe-top);
    padding-bottom: var(--safe-bottom);
    overscroll-behavior-y: contain;
  }

  /* ── Sticky header with search ── */
  .app-header {
    position: sticky;
    top: 0;
    background: var(--navy);
    padding: 12px 16px 14px;
    z-index: 100;
    padding-top: calc(var(--safe-top) + 12px);
    box-shadow: 0 2px 12px rgba(0,0,0,.15);
  }
  .app-title {
    color: var(--gold);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    margin-bottom: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .app-title a {
    color: rgba(255,255,255,.6);
    font-size: 11px;
    text-decoration: none;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: none;
  }
  .search-wrap {
    position: relative;
  }
  .search-input {
    width: 100%;
    padding: 14px 44px 14px 44px;
    font-size: 16px;
    border-radius: 12px;
    border: 2px solid transparent;
    background: rgba(255,255,255,.95);
    color: var(--text);
    font-family: inherit;
    -webkit-appearance: none;
    transition: border-color .15s;
  }
  .search-input:focus {
    outline: none;
    border-color: var(--gold);
    background: #fff;
  }
  .search-icon {
    position: absolute;
    left: 14px; top: 50%;
    transform: translateY(-50%);
    font-size: 18px;
    color: var(--muted);
    pointer-events: none;
  }
  .search-clear {
    position: absolute;
    right: 12px; top: 50%;
    transform: translateY(-50%);
    background: #e0e0e0;
    color: #666;
    border: 0;
    width: 22px; height: 22px;
    border-radius: 50%;
    font-size: 14px;
    cursor: pointer;
    display: none;
    line-height: 1;
    padding: 0;
  }
  .search-hint {
    font-size: 10px;
    color: rgba(255,255,255,.5);
    margin-top: 6px;
    text-align: center;
  }

  /* ── Results ── */
  .results {
    padding: 12px 12px 60px;
  }
  .result-card {
    background: var(--card);
    padding: 14px 16px;
    border-radius: 12px;
    margin-bottom: 10px;
    display: block;
    text-decoration: none;
    color: inherit;
    box-shadow: 0 1px 3px rgba(0,0,0,.04);
    border: 1px solid rgba(0,0,0,.04);
    transition: transform .1s;
  }
  .result-card:active {
    transform: scale(0.98);
    background: #fafafa;
  }
  .result-name {
    font-size: 16px;
    font-weight: 600;
    color: var(--navy);
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .result-a {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    color: var(--muted);
    background: #f3ede1;
    padding: 2px 8px;
    border-radius: 8px;
    flex-shrink: 0;
  }
  .result-meta {
    font-size: 12px;
    color: var(--muted);
    margin-top: 6px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .result-hearing {
    background: #fdf7f0;
    border-left: 3px solid var(--gold);
    padding: 6px 10px;
    margin-top: 8px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--navy);
  }
  .result-hearing.past {
    background: #f5f5f5;
    border-left-color: #999;
    color: var(--muted);
  }
  .badge {
    background: var(--gold);
    color: white;
    padding: 1px 8px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* ── Empty / loading ── */
  .empty, .loading {
    text-align: center;
    padding: 60px 20px;
    color: var(--muted);
    font-size: 14px;
  }
  .empty-icon {
    font-size: 44px;
    margin-bottom: 12px;
    opacity: .3;
  }

  .spinner {
    display: inline-block;
    width: 24px; height: 24px;
    border: 3px solid #e0e0e0;
    border-top-color: var(--gold);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Quick nav strip at bottom */
  .quick-nav {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    background: white;
    border-top: 1px solid #e5e5e5;
    display: flex;
    padding: 8px 0 calc(8px + var(--safe-bottom));
    z-index: 100;
    box-shadow: 0 -2px 12px rgba(0,0,0,.05);
  }
  .quick-nav a {
    flex: 1;
    text-align: center;
    text-decoration: none;
    color: var(--muted);
    font-size: 10px;
    padding: 6px 0;
    font-weight: 500;
  }
  .quick-nav a .icon {
    font-size: 20px;
    display: block;
    margin-bottom: 2px;
    line-height: 1;
  }
  .quick-nav a.active { color: var(--gold); }
</style>
</head>
<body>

<div class="app-header">
  <div class="app-title">
    <span>Zara Mobile</span>
    <a href="/admin/dashboard">Desktop →</a>
  </div>
  <div class="search-wrap">
    <span class="search-icon">🔍</span>
    <input
      type="search"
      class="search-input"
      id="q"
      placeholder="Search client, A-number, phone…"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false">
    <button class="search-clear" id="clear-btn" onclick="clearSearch()">✕</button>
  </div>
  <div class="search-hint" id="hint">Name · A-number · phone · email · case type · address</div>
</div>

<div id="results" class="results">
  <div class="empty">
    <div class="empty-icon">🔍</div>
    <div>Start typing to search</div>
  </div>
</div>

<nav class="quick-nav">
  <a href="/admin/mobile" class="active">
    <span class="icon">🔍</span>
    Search
  </a>
  <a href="/admin/calendar">
    <span class="icon">📅</span>
    Calendar
  </a>
  <a href="/admin/dashboard">
    <span class="icon">📊</span>
    Dashboard
  </a>
  <a href="/admin/deadlines">
    <span class="icon">⏰</span>
    Deadlines
  </a>
</nav>

<script>
  // Register service worker for offline install
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }

  const input = document.getElementById("q");
  const results = document.getElementById("results");
  const clearBtn = document.getElementById("clear-btn");
  const hint = document.getElementById("hint");
  let searchTimer = null;
  let lastQuery = "";

  input.focus();
  input.addEventListener("input", () => {
    clearBtn.style.display = input.value ? "block" : "none";
    if (searchTimer) clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length === 0) {
      results.innerHTML = '<div class="empty"><div class="empty-icon">🔍</div><div>Start typing to search</div></div>';
      return;
    }
    if (q.length < 2) {
      results.innerHTML = '<div class="empty">Type at least 2 characters…</div>';
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 200);  // 200ms debounce
  });

  function clearSearch() {
    input.value = "";
    input.focus();
    clearBtn.style.display = "none";
    results.innerHTML = '<div class="empty"><div class="empty-icon">🔍</div><div>Start typing to search</div></div>';
  }

  async function runSearch(q) {
    if (q === lastQuery) return;
    lastQuery = q;
    results.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const r = await fetch("/admin/api/clients/search?q=" + encodeURIComponent(q));
      if (!r.ok) throw new Error("Search failed");
      const data = await r.json();
      renderResults(data.results || []);
    } catch (e) {
      results.innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
    }
  }

  function renderResults(items) {
    if (!items.length) {
      results.innerHTML = '<div class="empty"><div class="empty-icon">🕵️</div><div>No matches</div><div style="font-size:12px; margin-top:4px; color:#999;">Try a shorter or different keyword</div></div>';
      return;
    }
    results.innerHTML = items.map(c => renderCard(c)).join("");
  }

  function renderCard(c) {
    const upcoming = c.upcoming_hearing_date ? new Date(c.upcoming_hearing_date) : null;
    const now = new Date();
    let hearingHtml = "";
    if (upcoming) {
      const past = upcoming < now;
      const diffDays = Math.ceil((upcoming - now) / 86400000);
      const label = past ? "past"
        : diffDays === 0 ? "TODAY"
        : diffDays === 1 ? "TOMORROW"
        : diffDays + " days";
      hearingHtml = '<div class="result-hearing' + (past ? ' past' : '') + '">'
        + '<strong>' + esc(c.upcoming_hearing_type || 'hearing') + '</strong> · '
        + upcoming.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        + ' · ' + label
        + '</div>';
    }
    const caseTypeChip = c.case_types && c.case_types[0]
      ? '<span class="badge">' + esc(c.case_types[0]) + '</span>'
      : '';
    return '<a href="/admin/mobile/client/' + encodeURIComponent(c.key) + '" class="result-card">'
      + '<div class="result-name">'
      + '<span>' + esc(c.client_name || "(unnamed)") + '</span>'
      + (c.a_number ? '<span class="result-a">' + esc(c.a_number) + '</span>' : '')
      + '</div>'
      + '<div class="result-meta">'
      + caseTypeChip
      + (c.client_language && c.client_language !== 'en' ? '<span>🌐 ' + esc(c.client_language) + '</span>' : '')
      + (c.client_phone ? '<span>📞</span>' : '')
      + (c.client_email ? '<span>✉️</span>' : '')
      + '<span>' + c.total_hearings + ' hearing' + (c.total_hearings === 1 ? '' : 's') + '</span>'
      + '</div>'
      + hearingHtml
      + '</a>';
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
</script>

</body>
</html>`;
}

// ── Mobile Client Detail Page ────────────────────────────

function renderMobileClientPage(client) {
  if (!client) {
    return `<!DOCTYPE html><html><body style="padding:40px; font-family:-apple-system,sans-serif; text-align:center;">
      <h2>Client not found</h2>
      <p><a href="/admin/mobile">← Back to search</a></p></body></html>`;
  }

  const phoneClean = (client.client_phone || "").replace(/[^\d+]/g, "");
  const now = Date.now();
  const upcoming = (client.hearings || []).filter(h => h.hearing_date && new Date(h.hearing_date).getTime() >= now);
  const past = (client.hearings || []).filter(h => h.hearing_date && new Date(h.hearing_date).getTime() < now);

  const hearingLink = (h) => h.kind === "master"
    ? `/admin/hearing/notes/${h.id}`
    : `/admin/hearing/individual/${h.id}`;

  const renderHearing = (h) => {
    const dt = new Date(h.hearing_date);
    return `
      <a href="${hearingLink(h)}" class="card hearing-card">
        <div class="hearing-date">
          <div class="hd-month">${dt.toLocaleString(undefined, { month: 'short' }).toUpperCase()}</div>
          <div class="hd-day">${dt.getDate()}</div>
          <div class="hd-time">${dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
        </div>
        <div class="hearing-body">
          <div class="hearing-type">${escapeHtml(h.type_label || "hearing")}</div>
          ${h.judge_name ? `<div class="hearing-sub">Judge ${escapeHtml(h.judge_name)}</div>` : ""}
          ${h.court_location ? `<div class="hearing-sub">${escapeHtml(h.court_location)}</div>` : ""}
          ${h.disposition ? `<div class="hearing-sub">${escapeHtml(h.disposition)}</div>` : ""}
        </div>
      </a>`;
  };

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,maximum-scale=1">
<title>${escapeHtml(client.client_name || "Client")} — Zara</title>
<meta name="theme-color" content="#0C1C36">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="https://tezlawfirm.com/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png">
<link rel="manifest" href="/manifest.json">
<style>
  :root {
    --navy: #0C1C36;
    --gold: #B79C62;
    --canvas: #f5f2ea;
    --card: #ffffff;
    --text: #0C1C36;
    --muted: #6b6b6b;
    --safe-top: env(safe-area-inset-top);
    --safe-bottom: env(safe-area-inset-bottom);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; background: var(--canvas); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", Segoe UI, Roboto, sans-serif;
    color: var(--text);
    padding-bottom: var(--safe-bottom);
    -webkit-font-smoothing: antialiased;
    overscroll-behavior-y: contain;
  }

  /* ── Header ── */
  .header {
    background: var(--navy);
    padding: 12px 16px 22px;
    padding-top: calc(var(--safe-top) + 12px);
    color: white;
  }
  .back-link {
    color: rgba(255,255,255,.7);
    text-decoration: none;
    font-size: 14px;
    display: inline-block;
    padding: 8px 12px 8px 0;
    margin-left: -4px;
  }
  .client-name {
    color: white;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.01em;
    margin-top: 10px;
  }
  .client-a {
    color: var(--gold);
    font-family: ui-monospace, Menlo, monospace;
    font-size: 13px;
    margin-top: 4px;
  }
  .client-meta {
    color: rgba(255,255,255,.7);
    font-size: 12px;
    margin-top: 8px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .badge {
    background: rgba(183,156,98,.25);
    color: var(--gold);
    padding: 2px 8px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
  }

  /* ── Content ── */
  .content { padding: 12px; }
  h3 {
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin: 24px 12px 8px;
  }
  h3:first-of-type { margin-top: 4px; }
  .card {
    background: var(--card);
    padding: 14px 16px;
    border-radius: 12px;
    margin-bottom: 8px;
    display: block;
    text-decoration: none;
    color: inherit;
    box-shadow: 0 1px 3px rgba(0,0,0,.04);
    border: 1px solid rgba(0,0,0,.04);
  }
  .card:active { background: #fafafa; }

  /* ── Contact action buttons ── */
  .contact-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    padding: 0 12px;
    margin-bottom: 8px;
  }
  .contact-btn {
    background: var(--card);
    border-radius: 12px;
    padding: 12px 4px;
    text-align: center;
    text-decoration: none;
    color: var(--text);
    box-shadow: 0 1px 3px rgba(0,0,0,.05);
    border: 1px solid rgba(0,0,0,.05);
    transition: transform .1s;
  }
  .contact-btn:active { transform: scale(.94); background: #fafafa; }
  .contact-btn.disabled { opacity: 0.3; pointer-events: none; }
  .contact-icon {
    font-size: 22px;
    display: block;
    margin-bottom: 4px;
    line-height: 1;
  }
  .contact-label {
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
  }

  /* ── Hearings ── */
  .hearing-card {
    display: flex;
    gap: 14px;
    align-items: stretch;
  }
  .hearing-date {
    background: linear-gradient(180deg, #fdf7f0 0%, #f7ede0 100%);
    border-radius: 8px;
    padding: 6px 8px;
    text-align: center;
    min-width: 58px;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .hd-month {
    font-size: 10px;
    color: var(--gold);
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .hd-day {
    font-size: 20px;
    color: var(--navy);
    font-weight: 700;
    line-height: 1;
    margin-top: 2px;
  }
  .hd-time {
    font-size: 9px;
    color: var(--muted);
    margin-top: 3px;
  }
  .hearing-body {
    flex: 1;
    min-width: 0;
  }
  .hearing-type {
    font-weight: 600;
    color: var(--navy);
    font-size: 14px;
  }
  .hearing-sub {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }

  .cta-row {
    padding: 16px 12px 0;
  }
  .cta-btn {
    background: var(--gold);
    color: white;
    text-align: center;
    padding: 14px;
    border-radius: 12px;
    text-decoration: none;
    display: block;
    font-weight: 600;
    font-size: 15px;
    box-shadow: 0 3px 12px rgba(183,156,98,.3);
  }
  .cta-btn:active { transform: scale(.98); }
  .cta-secondary {
    background: white;
    color: var(--navy);
    border: 1px solid rgba(0,0,0,.08);
    box-shadow: 0 1px 3px rgba(0,0,0,.05);
    margin-top: 10px;
  }

  .empty-mini {
    color: var(--muted);
    font-size: 13px;
    padding: 20px 16px;
    text-align: center;
    font-style: italic;
  }
</style>
</head>
<body>

<div class="header">
  <a href="/admin/mobile" class="back-link">← Search</a>
  <div class="client-name">${escapeHtml(client.client_name || "(unnamed)")}</div>
  ${client.a_number ? `<div class="client-a">${escapeHtml(client.a_number)}</div>` : ""}
  <div class="client-meta">
    ${(client.case_types || []).map(t => `<span class="badge">${escapeHtml(t)}</span>`).join("")}
    ${client.client_language ? `<span class="badge">🌐 ${escapeHtml(client.client_language)}</span>` : ""}
  </div>
</div>

<div class="content">

  <!-- ── Quick contact actions ── -->
  <div class="contact-grid">
    <a href="${phoneClean ? "tel:" + phoneClean : "#"}" class="contact-btn ${phoneClean ? "" : "disabled"}">
      <span class="contact-icon">📞</span>
      <span class="contact-label">Call</span>
    </a>
    <a href="${phoneClean ? "sms:" + phoneClean : "#"}" class="contact-btn ${phoneClean ? "" : "disabled"}">
      <span class="contact-icon">💬</span>
      <span class="contact-label">Text</span>
    </a>
    <a href="${phoneClean ? "https://wa.me/" + phoneClean.replace(/^\\+/, "") : "#"}" target="_blank" class="contact-btn ${phoneClean ? "" : "disabled"}">
      <span class="contact-icon">📱</span>
      <span class="contact-label">WhatsApp</span>
    </a>
    <a href="${client.client_email ? "mailto:" + client.client_email : "#"}" class="contact-btn ${client.client_email ? "" : "disabled"}">
      <span class="contact-icon">✉️</span>
      <span class="contact-label">Email</span>
    </a>
  </div>

  ${(client.client_phone || client.client_email || client.client_address) ? `
  <a href="/admin/clients/${encodeURIComponent(client.key)}" class="card" style="font-size:12px;">
    ${client.client_phone ? `<div style="margin-bottom:4px;"><strong>📞</strong> ${escapeHtml(client.client_phone)}</div>` : ""}
    ${client.client_email ? `<div style="margin-bottom:4px;"><strong>✉️</strong> ${escapeHtml(client.client_email)}</div>` : ""}
    ${client.client_address ? `<div><strong>📍</strong> ${escapeHtml(client.client_address)}</div>` : ""}
  </a>` : ""}

  ${upcoming.length ? `
    <h3>Upcoming Hearings (${upcoming.length})</h3>
    ${upcoming.map(renderHearing).join("")}
  ` : `
    <h3>Upcoming Hearings</h3>
    <div class="empty-mini">No upcoming hearings scheduled.</div>
  `}

  ${(client.deadlines || []).length ? `
    <h3>Deadlines</h3>
    ${client.deadlines.slice(0, 5).map(d => {
      const dt = new Date(d.due_date);
      const diff = Math.ceil((dt - new Date()) / 86400000);
      const overdue = diff < 0;
      return `
        <div class="card">
          <div style="display:flex; justify-content:space-between; gap:8px;">
            <div style="flex:1;">
              <div style="font-weight:600; font-size:13px;">${escapeHtml(d.description || "")}</div>
              <div style="font-size:11px; color:#888;">${dt.toLocaleDateString()}</div>
            </div>
            <div style="font-size:12px; font-weight:600; color:${overdue ? "#c62828" : "#666"}; white-space:nowrap;">
              ${overdue ? Math.abs(diff) + "d late" : diff === 0 ? "TODAY" : diff + "d"}
            </div>
          </div>
        </div>`;
    }).join("")}
  ` : ""}

  ${past.length ? `
    <h3>Recent Past (${past.length})</h3>
    ${past.slice(0, 3).map(renderHearing).join("")}
  ` : ""}

  <div class="cta-row">
    <a href="/admin/hearing/individual/new?client_name=${encodeURIComponent(client.client_name || "")}&a_number=${encodeURIComponent(client.a_number || "")}" class="cta-btn">
      + Add Individual Hearing Note
    </a>
    <a href="/admin/hearing/notes/new?client_name=${encodeURIComponent(client.client_name || "")}&a_number=${encodeURIComponent(client.a_number || "")}" class="cta-btn cta-secondary">
      + Add Master Hearing Note
    </a>
  </div>

</div>

</body>
</html>`;
}

// ============================================================
//  MOBILE APP CHROME + TAB VIEWS
//  ─────────────────────────────────────────────────────────
//  All routes served under /admin/mobile/* so the PWA scope
//  keeps everything inside the installed home-screen app.
//  Bottom tab bar (iOS-style) provides navigation:
//    🏠 Home | ✓ Tasks | 📅 Calendar | 👥 Clients | ⋯ More
//
//  Every tab is a mobile-first view of the same data JJ sees
//  on desktop — so we don't fork the data model, just present
//  it more thumb-friendly.
// ============================================================

// Shared mobile chrome with bottom tab bar. Every mobile page uses this.
function renderMobileChrome({ title = "TEZ", body, activeTab = "home", user = {} }) {
  const tab = (key, href, icon, label) => `
    <a href="${href}" style="flex:1; text-align:center; padding:8px 4px; text-decoration:none; color:${activeTab === key ? '#B79C62' : '#666'}; font-size:10px; font-weight:${activeTab === key ? '700' : '500'};">
      <div style="font-size:22px; line-height:1;">${icon}</div>
      <div style="margin-top:3px;">${label}</div>
    </a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="TEZ">
  <meta name="theme-color" content="#0C1C36">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/wp-content/uploads/2025/12/cropped-Orange_Logo-removebg-preview.png">
  <title>${escapeHtml(title)} — TEZ</title>
  <style>
    :root { --gold: #B79C62; --navy: #0C1C36; --light: #faf9f5; --border: #e5e5e5; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin: 0; padding: 0; background: var(--light); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--navy); overscroll-behavior: none; }
    header.appbar { position: sticky; top: 0; z-index: 100; background: var(--navy); color: white; padding: 12px 16px; padding-top: calc(12px + env(safe-area-inset-top)); display: flex; align-items: center; gap: 10px; }
    header.appbar h1 { margin: 0; font-size: 17px; font-weight: 600; flex: 1; }
    header.appbar .back { color: white; text-decoration: none; font-size: 22px; margin-right: 4px; }
    main.content { padding: 16px 14px 84px 14px; min-height: calc(100vh - 60px); }
    nav.tabbar { position: fixed; bottom: 0; left: 0; right: 0; background: white; border-top: 1px solid var(--border); display: flex; padding-bottom: env(safe-area-inset-bottom); z-index: 100; box-shadow: 0 -1px 3px rgba(0,0,0,0.06); }
    .card { background: white; border-radius: 12px; padding: 14px; margin-bottom: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
    .card-tap { display: block; text-decoration: none; color: inherit; }
    .card-tap:active { background: #f5f2ea; }
    .stat-tile { background: white; border-radius: 12px; padding: 14px; text-align: center; }
    .stat-tile .label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-tile .value { font-size: 28px; font-weight: 700; color: var(--navy); margin-top: 4px; }
    .btn { display: block; width: 100%; padding: 14px; background: var(--gold); color: white; text-align: center; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px; border: none; cursor: pointer; margin-bottom: 10px; }
    .btn:active { background: #a08a55; }
    .btn-secondary { background: white; color: var(--navy); border: 1px solid var(--border); }
    .btn-secondary:active { background: #f5f2ea; }
    .section-title { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin: 20px 0 8px; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; color: white; }
    .badge-urgent { background: #c62828; }
    .badge-high { background: #e65100; }
    .badge-normal { background: #0061FF; }
    .badge-low { background: #888; }
    .empty { text-align: center; color: #999; padding: 40px 20px; font-size: 14px; }
    input, textarea, select { width: 100%; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; font-size: 16px; font-family: inherit; background: white; }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--gold); }
    label { display: block; font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.4px; margin: 12px 0 4px; }
  </style>
</head>
<body>
  <header class="appbar">
    <h1>${escapeHtml(title)}</h1>
  </header>
  <main class="content">${body}</main>
  <nav class="tabbar">
    ${tab("home",     "/admin/mobile",           "🏠", "Home")}
    ${tab("tasks",    "/admin/mobile/tasks",     "✓",  "Tasks")}
    ${tab("calendar", "/admin/mobile/calendar",  "📅", "Calendar")}
    ${tab("clients",  "/admin/mobile/clients",   "👥", "Clients")}
    ${tab("more",     "/admin/mobile/more",      "⋯",  "More")}
  </nav>
</body>
</html>`;
}

// ── HOME (Mobile Dashboard) ────────────────────────────────
async function renderMobileHome(user = {}) {
  const stats = { tasks_today: 0, tasks_overdue: 0, hearings_this_week: 0, deadlines_soon: 0 };
  let urgentTasks = [];
  let upcomingHearings = [];

  try {
    const tasks = require("./tasks");
    const openTasks = await tasks.listTasks({ due_within_days: 30, limit: 100 });
    const today = new Date().toISOString().split("T")[0];
    for (const t of openTasks) {
      const dueDay = t.due_date ? new Date(t.due_date).toISOString().split("T")[0] : null;
      if (dueDay && dueDay < today) stats.tasks_overdue++;
      if (dueDay === today) stats.tasks_today++;
    }
    urgentTasks = openTasks.filter(t => t.priority === "urgent" || t.priority === "high" || (t.days_until_due != null && t.days_until_due <= 3)).slice(0, 5);
  } catch {}

  try {
    const now = new Date();
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const r = await db.query(
      `SELECT client_name, a_number, hearing_date, hearing_type, court_name
       FROM client_hearing_notices
       WHERE hearing_date >= $1 AND hearing_date <= $2 AND dismissed_at IS NULL
       ORDER BY hearing_date ASC LIMIT 10`,
      [now.toISOString().split("T")[0], nextWeek.toISOString().split("T")[0]]
    );
    upcomingHearings = r.rows;
    stats.hearings_this_week = r.rows.length;
  } catch {}

  try {
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM deadlines WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '14 days'`);
    stats.deadlines_soon = r.rows[0]?.n || 0;
  } catch {}

  const greetName = user.name ? user.name.split(" ")[0] : "";
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const urgentHtml = urgentTasks.length ? urgentTasks.map(t => {
    const priBadge = t.priority === "urgent" ? "urgent" : t.priority === "high" ? "high" : "normal";
    const dueLabel = t.days_until_due != null
      ? (t.days_until_due < 0 ? `⚠ ${Math.abs(t.days_until_due)}d overdue` : t.days_until_due === 0 ? "📌 Today" : `In ${t.days_until_due}d`)
      : "";
    return `
      <a href="/admin/mobile/task/${t.id}" class="card card-tap">
        <div style="display:flex; align-items:flex-start; gap:10px;">
          <span class="badge badge-${priBadge}">${(t.priority || "normal").toUpperCase()}</span>
          <div style="flex:1;">
            <div style="font-weight:600; font-size:14px; color:var(--navy);">${escapeHtml(t.title)}</div>
            <div style="font-size:12px; color:#666; margin-top:2px;">${dueLabel}${t.client_name ? " · 👤 " + escapeHtml(t.client_name) : ""}</div>
          </div>
        </div>
      </a>`;
  }).join("") : `<div class="card empty">No urgent tasks. Nicely done. ✓</div>`;

  const hearingsHtml = upcomingHearings.length ? upcomingHearings.map(h => `
    <div class="card">
      <div style="font-weight:600; font-size:14px; color:var(--navy);">${escapeHtml(h.client_name || "(unnamed)")}</div>
      <div style="font-size:12px; color:#666; margin-top:2px;">${new Date(h.hearing_date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${h.hearing_type ? " · " + escapeHtml(h.hearing_type) : ""}</div>
      ${h.court_name ? `<div style="font-size:11px; color:#888; margin-top:2px;">${escapeHtml(h.court_name)}</div>` : ""}
    </div>`).join("") : `<div class="card empty">No hearings this week.</div>`;

  return `
    <div style="margin-bottom:14px;">
      <div style="font-size:13px; color:#666;">${greeting}${greetName ? ", " + escapeHtml(greetName) : ""}</div>
      <div style="font-size:16px; color:var(--navy); font-weight:600;">${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px;">
      <a href="/admin/mobile/tasks?filter=today" class="stat-tile" style="text-decoration:none;">
        <div class="label">Due Today</div>
        <div class="value" style="color:${stats.tasks_today > 0 ? '#e65100' : 'var(--navy)'};">${stats.tasks_today}</div>
      </a>
      <a href="/admin/mobile/tasks?filter=overdue" class="stat-tile" style="text-decoration:none;">
        <div class="label">Overdue</div>
        <div class="value" style="color:${stats.tasks_overdue > 0 ? '#c62828' : 'var(--navy)'};">${stats.tasks_overdue}</div>
      </a>
      <a href="/admin/mobile/calendar" class="stat-tile" style="text-decoration:none;">
        <div class="label">Hearings This Week</div>
        <div class="value">${stats.hearings_this_week}</div>
      </a>
      <a href="/admin/mobile/calendar?tab=deadlines" class="stat-tile" style="text-decoration:none;">
        <div class="label">Deadlines &lt;14d</div>
        <div class="value">${stats.deadlines_soon}</div>
      </a>
    </div>

    <a href="/admin/mobile/tasks/new" class="btn">＋ Quick Task</a>

    <div class="section-title">🔴 Urgent & Due Soon</div>
    ${urgentHtml}

    <div class="section-title">📅 Coming Up (Next 7 Days)</div>
    ${hearingsHtml}`;
}

// ── TASKS TAB (list + tap-to-complete) ────────────────────
async function renderMobileTasks(query = {}) {
  const tasks = require("./tasks");
  const filter = query.filter || null;
  const listArgs = { limit: 200 };
  if (filter === "overdue") listArgs.overdue_only = true;
  else if (filter === "today") listArgs.due_within_days = 0;
  else if (filter === "week") listArgs.due_within_days = 7;
  const items = await tasks.listTasks(listArgs);

  const rowsHtml = items.length ? items.map(t => {
    const priBadge = t.priority === "urgent" ? "urgent" : t.priority === "high" ? "high" : t.priority === "low" ? "low" : "normal";
    let dueColor = "#666", dueLabel = "";
    if (t.due_date && t.days_until_due != null) {
      const d = new Date(t.due_date).toLocaleDateString();
      if (t.days_until_due < 0) { dueColor = "#c62828"; dueLabel = `⚠ ${Math.abs(t.days_until_due)}d overdue`; }
      else if (t.days_until_due === 0) { dueColor = "#c62828"; dueLabel = "📌 Today"; }
      else if (t.days_until_due <= 7) { dueColor = "#e65100"; dueLabel = `${d} (${t.days_until_due}d)`; }
      else dueLabel = `${d}`;
    }
    return `
      <div class="card" style="display:flex; align-items:flex-start; gap:12px;">
        <input type="checkbox" onclick="completeTask(${t.id}, this)" style="width:22px; height:22px; margin-top:2px; flex-shrink:0;">
        <a href="/admin/mobile/task/${t.id}" style="flex:1; text-decoration:none; color:inherit;">
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:2px;">
            <span class="badge badge-${priBadge}">${(t.priority || "normal").toUpperCase()}</span>
            ${t.matter_type ? `<span style="font-size:10px; color:#888;">${escapeHtml(t.matter_type)}</span>` : ""}
          </div>
          <div style="font-weight:600; font-size:14px; color:var(--navy);">${escapeHtml(t.title)}</div>
          <div style="font-size:11px; color:${dueColor}; margin-top:3px; font-weight:${dueColor === "#c62828" ? "600" : "400"};">${dueLabel}${t.client_name ? " · 👤 " + escapeHtml(t.client_name) : ""}</div>
        </a>
      </div>`;
  }).join("") : `<div class="card empty">No tasks match. <a href="/admin/mobile/tasks" style="color:var(--gold);">Show all →</a></div>`;

  const tabBtn = (key, label) => `<a href="/admin/mobile/tasks${key ? '?filter=' + key : ''}" style="flex:1; text-align:center; padding:10px; background:${filter === key || (!filter && !key) ? 'var(--navy)' : 'white'}; color:${filter === key || (!filter && !key) ? 'white' : 'var(--navy)'}; text-decoration:none; border-radius:8px; font-size:12px; font-weight:600;">${label}</a>`;

  return `
    <a href="/admin/mobile/tasks/new" class="btn">＋ New Task</a>

    <div style="display:flex; gap:6px; margin-bottom:12px; overflow-x:auto;">
      ${tabBtn(null, "All Open")}
      ${tabBtn("today", "Today")}
      ${tabBtn("overdue", "Overdue")}
      ${tabBtn("week", "This Week")}
    </div>

    <div>${rowsHtml}</div>

    <script>
      async function completeTask(id, el) {
        el.disabled = true;
        try {
          const r = await fetch("/admin/tasks/" + id + "/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
          const d = await r.json();
          if (d.ok) { el.closest(".card").style.opacity = "0.3"; setTimeout(() => location.reload(), 400); }
          else { el.checked = false; el.disabled = false; alert("Error: " + d.error); }
        } catch (e) { el.checked = false; el.disabled = false; alert("Network error: " + e.message); }
      }
    </script>`;
}

// ── NEW TASK (mobile) ─────────────────────────────────────
function renderMobileNewTask() {
  return `
    <form onsubmit="createTaskMobile(event)">
      <label>Title *</label>
      <input type="text" name="title" required autofocus placeholder="e.g. File I-589 for Chen Wei">

      <label>Client (optional)</label>
      <input type="text" name="client_name" placeholder="Client name">

      <label>Matter</label>
      <select name="matter_type">
        <option value="">—</option>
        <option value="immigration">Immigration</option>
        <option value="pi">Personal Injury</option>
        <option value="business">Business</option>
        <option value="ll_tenant">Landlord/Tenant</option>
        <option value="estate">Estate</option>
        <option value="tm">Trademarks</option>
        <option value="real_estate">Real Estate</option>
        <option value="admin">Admin</option>
      </select>

      <label>Priority</label>
      <select name="priority">
        <option value="normal">🔵 Normal</option>
        <option value="high">🟠 High</option>
        <option value="urgent">🔴 Urgent</option>
        <option value="low">⚪ Low</option>
      </select>

      <label>Due Date</label>
      <input type="date" name="due_date">

      <label>Notes</label>
      <textarea name="description" rows="4" placeholder="Details, deadlines, context…"></textarea>

      <div style="margin-top:16px;">
        <button type="submit" class="btn" id="new-task-btn">💾 Save Task</button>
        <a href="/admin/mobile/tasks" class="btn btn-secondary">Cancel</a>
      </div>
    </form>

    <script>
      async function createTaskMobile(e) {
        e.preventDefault();
        const btn = document.getElementById("new-task-btn");
        btn.disabled = true; btn.textContent = "⏳ Saving…";
        const fd = new FormData(e.target);
        const data = {};
        for (const [k, v] of fd.entries()) if (v !== "") data[k] = v;
        if (data.client_name) data.client_key = data.client_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        try {
          const r = await fetch("/admin/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
          const d = await r.json();
          if (d.ok) location.href = "/admin/mobile/task/" + d.task.id;
          else { alert("Error: " + d.error); btn.disabled = false; btn.textContent = "💾 Save Task"; }
        } catch (e) { alert("Network error: " + e.message); btn.disabled = false; btn.textContent = "💾 Save Task"; }
      }
    </script>`;
}

// ── SINGLE TASK VIEW (mobile) ─────────────────────────────
async function renderMobileTaskDetail(id) {
  const tasks = require("./tasks");
  const milestones = require("./task-milestones");
  const task = await tasks.getTask(id);
  if (!task) return `<div class="empty">Task not found. <a href="/admin/mobile/tasks">← back</a></div>`;
  const [mList, mProgress, activity] = await Promise.all([
    milestones.listMilestones(id),
    milestones.getProgress(id),
    tasks.listActivity(id),
  ]);

  const priBadge = task.priority === "urgent" ? "urgent" : task.priority === "high" ? "high" : task.priority === "low" ? "low" : "normal";
  const statusColor = { pending: "#B79C62", in_progress: "#0061FF", completed: "#2e7d32", cancelled: "#999" }[task.status] || "#666";

  const mHtml = mList.length ? mList.map(m => {
    const isDone = m.status === "completed";
    const isSkipped = m.status === "skipped";
    const isActive = m.status === "in_progress";
    const bg = isDone ? "#e8f5e9" : isActive ? "#e3f2fd" : isSkipped ? "#f5f5f5" : "white";
    const strike = isDone || isSkipped ? "text-decoration:line-through; color:#888;" : "";
    return `
      <div style="background:${bg}; padding:10px 12px; border-radius:8px; margin-bottom:5px; display:flex; align-items:center; gap:10px;">
        <div style="width:24px; height:24px; border-radius:12px; background:${isDone ? "#2e7d32" : isActive ? "#0061FF" : "#ddd"}; color:white; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex-shrink:0;">${isDone ? "✓" : isSkipped ? "⊘" : m.order_num}</div>
        <div style="flex:1; font-size:13px; color:var(--navy); ${strike}">${escapeHtml(m.title)}</div>
        <select onchange="updateMs(${m.id}, this.value)" style="padding:4px 6px; border:1px solid var(--border); border-radius:4px; font-size:11px; width:auto;">
          <option value="pending" ${m.status === "pending" ? "selected" : ""}>Pending</option>
          <option value="in_progress" ${m.status === "in_progress" ? "selected" : ""}>Active</option>
          <option value="completed" ${m.status === "completed" ? "selected" : ""}>Done</option>
          <option value="skipped" ${m.status === "skipped" ? "selected" : ""}>Skip</option>
        </select>
      </div>`;
  }).join("") : "";

  const actHtml = activity.slice(-8).reverse().map(a => {
    const icons = { created: "＋", status_changed: "↻", assigned: "👤", note_added: "💬", completed: "✓", edited: "✎" };
    return `
      <div style="display:flex; gap:8px; padding:8px 0; border-bottom:1px solid #f0f0f0; font-size:12px;">
        <div style="width:20px; text-align:center; color:var(--gold);">${icons[a.action] || "•"}</div>
        <div style="flex:1;">
          <div>${a.action === "status_changed" ? `${escapeHtml(a.old_value || "")} → <strong>${escapeHtml(a.new_value || "")}</strong>` : escapeHtml(a.action.replace(/_/g, " "))}</div>
          ${a.note ? `<div style="color:#666; margin-top:2px;">${escapeHtml(a.note)}</div>` : ""}
          <div style="color:#999; font-size:10px;">${new Date(a.created_at).toLocaleString()}</div>
        </div>
      </div>`;
  }).join("");

  return `
    <div style="margin-bottom:6px;">
      <span class="badge" style="background:${statusColor};">${task.status.replace(/_/g, " ").toUpperCase()}</span>
      <span class="badge badge-${priBadge}" style="margin-left:4px;">${(task.priority || "normal").toUpperCase()}</span>
    </div>
    <h2 style="margin:6px 0 8px; font-size:18px; color:var(--navy);">${escapeHtml(task.title)}</h2>
    ${task.client_name ? `<div style="font-size:13px; color:#666; margin-bottom:8px;">👤 ${escapeHtml(task.client_name)}${task.a_number ? " · " + escapeHtml(task.a_number) : ""}</div>` : ""}
    ${task.due_date ? `<div style="font-size:13px; color:#666; margin-bottom:12px;">📅 Due ${new Date(task.due_date).toLocaleDateString()}</div>` : ""}
    ${task.description ? `<div class="card" style="white-space:pre-wrap; font-size:13px; line-height:1.5;">${escapeHtml(task.description)}</div>` : ""}

    ${mList.length ? `
    <div class="section-title">✅ Progress (${mProgress.percent}%)</div>
    <div style="background:#eee; border-radius:4px; height:6px; margin-bottom:10px; overflow:hidden;">
      <div style="background:linear-gradient(90deg, var(--gold), #2e7d32); height:100%; width:${mProgress.percent}%;"></div>
    </div>
    ${mHtml}` : ""}

    ${activity.length ? `<div class="section-title">📋 Activity</div><div class="card">${actHtml}</div>` : ""}

    <div style="margin-top:16px;">
      ${task.status !== "completed" ? `<button onclick="mobileComplete()" class="btn">✓ Mark Complete</button>` : ""}
      <a href="/admin/tasks/${id}/edit" class="btn btn-secondary">✎ Edit (Desktop)</a>
      <a href="/admin/mobile/tasks" class="btn btn-secondary">← Back to Tasks</a>
    </div>

    <script>
      async function updateMs(id, status) {
        try {
          const r = await fetch("/admin/tasks/milestones/" + id + "/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
          if ((await r.json()).ok) location.reload();
        } catch (e) { alert(e.message); }
      }
      async function mobileComplete() {
        const notes = prompt("Completion notes (optional):");
        if (notes === null) return;
        try {
          const r = await fetch("/admin/tasks/${id}/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completion_notes: notes || null }) });
          const d = await r.json();
          if (d.ok) location.reload();
        } catch (e) { alert(e.message); }
      }
    </script>`;
}

// ── CALENDAR TAB (hearings + deadlines) ────────────────────
async function renderMobileCalendar(query = {}) {
  const activeSubtab = query.tab || "hearings";
  const now = new Date();
  const nextMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  let hearings = [];
  let deadlines = [];
  try {
    const r = await db.query(
      `SELECT client_name, a_number, hearing_date, hearing_type, court_name
       FROM client_hearing_notices
       WHERE hearing_date >= $1 AND hearing_date <= $2 AND dismissed_at IS NULL
       ORDER BY hearing_date ASC LIMIT 100`,
      [now.toISOString().split("T")[0], nextMonth.toISOString().split("T")[0]]
    );
    hearings = r.rows;
  } catch {}

  try {
    const r = await db.query(
      `SELECT id, description, due_date, priority, client_name, source_type
       FROM deadlines
       WHERE status = 'pending' AND due_date <= CURRENT_DATE + INTERVAL '30 days'
       ORDER BY due_date ASC LIMIT 100`
    );
    deadlines = r.rows;
  } catch {}

  const subtab = (key, label, count) => `<a href="/admin/mobile/calendar?tab=${key}" style="flex:1; text-align:center; padding:10px; background:${activeSubtab === key ? 'var(--navy)' : 'white'}; color:${activeSubtab === key ? 'white' : 'var(--navy)'}; text-decoration:none; border-radius:8px; font-size:12px; font-weight:600;">${label} (${count})</a>`;

  // Group items by date for a cleaner mobile view
  function groupByDate(items, dateField) {
    const groups = {};
    for (const it of items) {
      const d = it[dateField] ? new Date(it[dateField]).toISOString().split("T")[0] : "unknown";
      if (!groups[d]) groups[d] = [];
      groups[d].push(it);
    }
    return groups;
  }

  let body;
  if (activeSubtab === "hearings") {
    const groups = groupByDate(hearings, "hearing_date");
    body = Object.keys(groups).length ? Object.keys(groups).sort().map(d => {
      const dateObj = new Date(d + "T00:00:00");
      const dateLabel = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      return `
        <div style="margin-bottom:14px;">
          <div style="font-size:12px; color:#666; font-weight:600; margin-bottom:6px; text-transform:uppercase;">${dateLabel}</div>
          ${groups[d].map(h => `
            <div class="card">
              <div style="font-weight:600; color:var(--navy);">${escapeHtml(h.client_name || "(unnamed)")}</div>
              ${h.a_number ? `<div style="font-size:11px; color:#888;">${escapeHtml(h.a_number)}</div>` : ""}
              ${h.hearing_type ? `<div style="font-size:12px; color:#666; margin-top:2px;">${escapeHtml(h.hearing_type)}</div>` : ""}
              ${h.court_name ? `<div style="font-size:11px; color:#888; margin-top:2px;">${escapeHtml(h.court_name)}</div>` : ""}
            </div>`).join("")}
        </div>`;
    }).join("") : `<div class="card empty">No hearings scheduled in the next 30 days.</div>`;
  } else {
    const groups = groupByDate(deadlines, "due_date");
    body = Object.keys(groups).length ? Object.keys(groups).sort().map(d => {
      const dateObj = new Date(d + "T00:00:00");
      const isOverdue = dateObj < now;
      const dateLabel = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      return `
        <div style="margin-bottom:14px;">
          <div style="font-size:12px; color:${isOverdue ? '#c62828' : '#666'}; font-weight:600; margin-bottom:6px; text-transform:uppercase;">${dateLabel}${isOverdue ? ' ⚠ OVERDUE' : ''}</div>
          ${groups[d].map(dl => {
            const pri = dl.priority === "urgent" ? "urgent" : dl.priority === "high" ? "high" : "normal";
            return `
            <div class="card">
              <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;"><span class="badge badge-${pri}">${(dl.priority || "normal").toUpperCase()}</span>${dl.source_type ? `<span style="font-size:10px; color:#888;">${escapeHtml(dl.source_type)}</span>` : ""}</div>
              <div style="font-weight:600; color:var(--navy); font-size:14px;">${escapeHtml(dl.description)}</div>
              ${dl.client_name ? `<div style="font-size:11px; color:#666; margin-top:2px;">👤 ${escapeHtml(dl.client_name)}</div>` : ""}
            </div>`;
          }).join("")}
        </div>`;
    }).join("") : `<div class="card empty">No pending deadlines in the next 30 days.</div>`;
  }

  return `
    <div style="display:flex; gap:6px; margin-bottom:14px;">
      ${subtab("hearings", "📅 Hearings", hearings.length)}
      ${subtab("deadlines", "⏰ Deadlines", deadlines.length)}
    </div>
    ${body}`;
}

// ── MORE TAB (links to less-common features) ──────────────
function renderMobileMore(user = {}) {
  const link = (href, icon, label, subtitle) => `
    <a href="${href}" class="card card-tap" style="display:flex; align-items:center; gap:14px; padding:14px;">
      <div style="font-size:24px; width:40px; text-align:center;">${icon}</div>
      <div style="flex:1;">
        <div style="font-weight:600; color:var(--navy); font-size:14px;">${label}</div>
        ${subtitle ? `<div style="font-size:11px; color:#888; margin-top:2px;">${subtitle}</div>` : ""}
      </div>
      <div style="color:#ccc; font-size:20px;">›</div>
    </a>`;

  return `
    <div class="section-title">CASE WORK</div>
    ${link("/admin/mobile/notes/new/master", "📝", "New Master Note", "Start a master calendar note")}
    ${link("/admin/mobile/notes/new/individual", "📄", "New Individual Note", "Start an individual hearing note")}
    ${link("/admin/federal", "⚖", "Federal & TM Matters", "Trademarks, federal court, appeals")}
    ${link("/admin/pi/cases", "🚑", "Personal Injury Cases", "PI dashboard + cases")}

    <div class="section-title">FIRM</div>
    ${link("/admin/dashboard", "▲", "Full Dashboard", "Desktop view")}
    ${link("/admin/tasks", "▤", "All Tasks (Desktop)", "Full task list with filters")}
    ${link("/admin/users", "👥", "Users & Permissions", "Manage staff access")}

    <div class="section-title">ACCOUNT</div>
    <div class="card" style="padding:14px;">
      <div style="font-size:12px; color:#888; text-transform:uppercase;">Signed in as</div>
      <div style="font-weight:600; color:var(--navy); margin-top:2px;">${escapeHtml(user.name || user.username || "?")}</div>
      <div style="font-size:11px; color:#888; margin-top:2px;">${escapeHtml(user.role_label || user.r || "")}</div>
    </div>
    <form method="POST" action="/admin/logout" style="margin:0;">
      <button type="submit" class="btn btn-secondary" style="color:#c62828;">Sign out</button>
    </form>`;
}

// ── CLIENTS TAB (uses existing search page) ────────────────
// Reuse renderMobileSearchPage but wrap it in the new chrome instead
// of the old fullscreen search UI. We just render an inline search
// bar that hits the existing /admin/api/clients/search endpoint.
function renderMobileClients() {
  return `
    <input type="search" id="q" placeholder="🔍 Search by name, A#, phone, email…" autofocus autocomplete="off" style="margin-bottom:14px;">
    <div id="results"></div>

    <script>
      let debounce;
      const q = document.getElementById("q");
      const results = document.getElementById("results");
      q.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => runSearch(q.value), 200);
      });
      async function runSearch(term) {
        if (!term || term.length < 2) { results.innerHTML = '<div class="empty">Type at least 2 characters to search.</div>'; return; }
        results.innerHTML = '<div class="empty">Searching…</div>';
        try {
          const r = await fetch("/admin/api/clients/search?q=" + encodeURIComponent(term));
          const d = await r.json();
          if (!d.ok) { results.innerHTML = '<div class="empty">' + d.error + '</div>'; return; }
          if (!d.results.length) { results.innerHTML = '<div class="empty">No matches for "' + escapeHtml(term) + '"</div>'; return; }
          results.innerHTML = d.results.map(c => \`
            <a href="/admin/mobile/client/\${encodeURIComponent(c.key)}" class="card card-tap">
              <div style="font-weight:600; color:#0C1C36; font-size:14px;">\${escapeHtml(c.client_name || "(unnamed)")}</div>
              \${c.a_number ? '<div style="font-size:11px; color:#888;">' + escapeHtml(c.a_number) + '</div>' : ''}
              \${c.upcoming_hearing_date ? '<div style="font-size:12px; color:#0061FF; margin-top:3px;">📅 Next: ' + new Date(c.upcoming_hearing_date).toLocaleDateString() + ' — ' + escapeHtml(c.upcoming_hearing_type || '') + '</div>' : ''}
              <div style="font-size:11px; color:#666; margin-top:2px;">\${c.total_hearings} hearing\${c.total_hearings === 1 ? '' : 's'}</div>
            </a>\`).join("");
        } catch (e) { results.innerHTML = '<div class="empty">Error: ' + e.message + '</div>'; }
      }
      function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    </script>`;
}


function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = {
  // API helpers
  searchClients,
  getClientDetail,
  // Legacy page renderers (kept for backward compat)
  renderMobileSearchPage,
  renderMobileClientPage,
  // Full mobile app chrome + tab views
  renderMobileChrome,
  renderMobileHome,
  renderMobileTasks,
  renderMobileNewTask,
  renderMobileTaskDetail,
  renderMobileCalendar,
  renderMobileMore,
  renderMobileClients,
};
