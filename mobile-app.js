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

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

module.exports = {
  searchClients,
  getClientDetail,
  renderMobileSearchPage,
  renderMobileClientPage,
};
