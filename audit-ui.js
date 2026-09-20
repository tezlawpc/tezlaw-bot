// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-ui.js — SERVER-RENDERED HTML
//  ─────────────────────────────────────────────────────────
//  Self-contained pages: one <style> block in the chrome, no
//  external stylesheets, fonts or scripts. Nothing loads from a
//  CDN, which matters because auditors often work from locked-down
//  networks and because a page that silently fails to load its
//  stylesheet is a page that gets screenshotted into a workpaper
//  looking broken.
//
//  Deliberately NOT themed like the host application. Two reasons:
//  external auditors should not see another organization's
//  branding or navigation, and this tree is meant to be liftable
//  into its own service later without a redesign.
// ============================================================

const tax = require("./audit-taxonomy");
const cal = require("./audit-calendar");
const auth = require("./audit-auth");
const checklists = require("./audit-checklists");

// Mount path. The portal is mount-path agnostic: every link below is
// built from this, so the same tree serves at /audit inside the host
// application and at whatever path a standalone deployment chooses.
const BASE = process.env.AUDIT_BASE_PATH || "/audit";

// ── Helpers ─────────────────────────────────────────────────
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(d) {
  const s = cal.dstr(d);
  if (!s) return "—";
  const dt = cal.parse(s);
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtBytes(n) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

function daysUntil(d) {
  const s = cal.dstr(d);
  if (!s) return null;
  return Math.round((cal.parse(s) - cal.parse(cal.iso(new Date()))) / 86400000);
}

function pill(text, color, bg) {
  return `<span class="pill" style="color:${color};background:${bg || color + "18"};border-color:${color}44;">${esc(text)}</span>`;
}

function statusPill(status) {
  const map = {
    open: ["#B45309", "Open"],
    pending_confirmation: ["#B45309", "Needs confirmation"],
    satisfied: ["#1C7C54", "Delivered"],
    answered_no: ["#1C7C54", "Answered — No"],
    answered_yes: ["#2C5F8A", "Answered — Yes"],
    waived: ["#667", "Waived"],
    na: ["#667", "N/A"],
    active: ["#1C7C54", "Active"],
    superseded: ["#889", "Superseded"],
    fieldwork: ["#2C5F8A", "Fieldwork"],
    review: ["#2C5F8A", "Review"],
    report_released: ["#6B21A8", "Report released"],
    archived: ["#9C4221", "Archived — append only"],
    locked: ["#991B1B", "Locked"],
  };
  const [c, label] = map[status] || ["#667", status];
  return pill(label, c);
}

// ── Chrome ──────────────────────────────────────────────────
const NAV = [
  { key: "dashboard", href: `${BASE}`, label: "Dashboard", perm: "dashboard.view" },
  { key: "upload", href: `${BASE}/upload`, label: "Upload", perm: "document.upload" },
  { key: "documents", href: `${BASE}/documents`, label: "Documents", perm: "document.view_all" },
  { key: "triage", href: `${BASE}/triage`, label: "Triage", perm: "document.view_all" },
  { key: "calendar", href: `${BASE}/calendar`, label: "Calendar", perm: "dashboard.view" },
  { key: "taxonomy", href: `${BASE}/taxonomy`, label: "Document index", perm: "dashboard.view" },
  { key: "sync", href: `${BASE}/sync`, label: "Dropbox", perm: "portal.settings" },
  { key: "users", href: `${BASE}/users`, label: "Users", perm: "portal.users" },
];

function chrome({ title, body, user, active, wide = false }) {
  const nav = NAV.filter((n) => !user || auth.can(user, n.perm))
    .map(
      (n) =>
        `<a href="${n.href}" class="nav${n.key === active ? " nav-on" : ""}">${esc(n.label)}</a>`
    )
    .join("");

  const roleInfo = user ? auth.ROLES[user.role] : null;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · NGTF Audit Portal</title>
<style>
  :root{
    --ink:#11161D; --ink2:#3A4553; --mute:#6B7684; --line:#E2E6EB; --bg:#F5F7F9;
    --card:#FFFFFF; --navy:#1F3A5F; --navy2:#2C5F8A; --red:#991B1B; --amber:#B45309;
    --green:#1C7C54; --purple:#6B21A8; --rust:#9C4221;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:var(--navy2);text-decoration:none} a:hover{text-decoration:underline}
  code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#EEF1F4;
    padding:1px 5px;border-radius:3px;color:#33404F}
  header.top{background:var(--navy);color:#fff;padding:0 22px}
  .brandrow{display:flex;align-items:center;justify-content:space-between;padding:13px 0 11px;gap:16px;flex-wrap:wrap}
  .brand{font-size:16px;font-weight:650;letter-spacing:.2px}
  .brand small{display:block;font-size:10.5px;font-weight:400;letter-spacing:1.6px;
    text-transform:uppercase;opacity:.62;margin-top:2px}
  .who{font-size:12px;text-align:right;opacity:.9;line-height:1.4}
  .who b{font-weight:600}
  .who a{color:#BBD3EE}
  nav.tabs{display:flex;gap:2px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.14)}
  .nav{padding:9px 14px;color:rgba(255,255,255,.72);font-size:13px;border-bottom:2px solid transparent}
  .nav:hover{color:#fff;text-decoration:none;background:rgba(255,255,255,.06)}
  .nav-on{color:#fff;border-bottom-color:#7FB2E8;background:rgba(255,255,255,.08)}
  main{max-width:${wide ? "1480px" : "1180px"};margin:0 auto;padding:22px}
  h1{font-size:21px;margin:0 0 3px;font-weight:650;letter-spacing:-.2px}
  h2{font-size:15px;margin:0 0 11px;font-weight:650}
  h3{font-size:13px;margin:0 0 8px;font-weight:650;text-transform:uppercase;letter-spacing:.7px;color:var(--mute)}
  .sub{color:var(--mute);font-size:13px;margin-bottom:18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin-bottom:16px}
  .card.tight{padding:0;overflow:hidden}
  .card h2{margin-bottom:12px}
  .grid{display:grid;gap:14px}
  .g2{grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
  .g3{grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
  .g4{grid-template-columns:repeat(auto-fit,minmax(175px,1fr))}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-weight:600;color:var(--mute);font-size:11px;text-transform:uppercase;
    letter-spacing:.6px;padding:9px 12px;background:#F8FAFB;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:9px 12px;border-bottom:1px solid #EFF2F5;vertical-align:top}
  tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#FAFBFC}
  .pill{display:inline-block;padding:1.5px 8px;border-radius:11px;font-size:11px;font-weight:600;
    border:1px solid;white-space:nowrap}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:13px 15px}
  .stat .n{font-size:25px;font-weight:660;line-height:1.1;letter-spacing:-.6px}
  .stat .l{font-size:11px;color:var(--mute);text-transform:uppercase;letter-spacing:.7px;margin-top:3px}
  .stat .x{font-size:11.5px;color:var(--mute);margin-top:5px}
  .btn{display:inline-block;padding:8px 15px;border-radius:6px;font-size:13px;font-weight:600;
    border:1px solid var(--navy);background:var(--navy);color:#fff;cursor:pointer}
  .btn:hover{opacity:.9;text-decoration:none;color:#fff}
  .btn.ghost{background:#fff;color:var(--navy);}
  .btn.sm{padding:4px 10px;font-size:12px}
  .btn.danger{background:var(--red);border-color:var(--red)}
  .btn.ok{background:var(--green);border-color:var(--green)}
  .btn[disabled]{opacity:.45;cursor:not-allowed}
  input[type=text],input[type=email],input[type=password],input[type=date],select,textarea{
    width:100%;padding:8px 10px;border:1px solid #CFD6DE;border-radius:6px;font:inherit;font-size:13px;
    background:#fff;color:var(--ink)}
  textarea{min-height:76px;resize:vertical}
  label{display:block;font-size:12px;font-weight:600;color:var(--ink2);margin:11px 0 4px}
  .note{padding:11px 13px;border-radius:6px;font-size:12.5px;line-height:1.55;margin:11px 0;border-left:3px solid}
  .note.blue{background:#F1F6FB;border-color:var(--navy2);color:#21374B}
  .note.red{background:#FDF0F0;border-color:var(--red);color:#6C1616}
  .note.amber{background:#FDF6EA;border-color:var(--amber);color:#71400A}
  .note.green{background:#EFF8F3;border-color:var(--green);color:#125238}
  .note.purple{background:#F7F1FB;border-color:var(--purple);color:#4A1670}
  .bar{height:6px;background:#E8ECF0;border-radius:3px;overflow:hidden}
  .bar i{display:block;height:100%;border-radius:3px}
  .mono{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#4A5764;word-break:break-all}
  .muted{color:var(--mute)}
  .sm{font-size:12px}
  .xs{font-size:11px}
  .right{text-align:right}
  .row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
  .between{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
  .auth-wrap{max-width:410px;margin:8vh auto;padding:0 18px}
  .empty{padding:30px;text-align:center;color:var(--mute);font-size:13px}
  details summary{cursor:pointer;font-size:12.5px;color:var(--navy2);padding:4px 0}
  details[open] summary{margin-bottom:7px}
  .flag{display:inline-block;background:#FDF6EA;color:#71400A;border:1px solid #E8C98F;
    border-radius:4px;padding:1px 6px;font-size:10.5px;margin:2px 3px 0 0;font-weight:600}
  .brk{display:inline-block;width:20px;height:20px;border-radius:4px;color:#fff;font-size:11px;
    font-weight:700;text-align:center;line-height:20px;margin-right:7px;flex:0 0 auto}
  footer{max-width:1180px;margin:0 auto;padding:26px 22px 38px;color:var(--mute);font-size:11.5px;line-height:1.6}
  @media(max-width:640px){main{padding:14px}.card{padding:13px}td,th{padding:7px 9px}}
</style>
</head><body>
<header class="top">
  <div class="brandrow">
    <div class="brand">Nightfood Holdings, Inc.
      <small>NGTF · CIK 0001593001 · PCAOB Audit Portal · FYE June 30</small></div>
    ${
      user
        ? `<div class="who"><b>${esc(user.name)}</b>${user.firmName ? ` · ${esc(user.firmName)}` : ""}<br>
           ${esc(roleInfo ? roleInfo.label : user.role)} · <a href="${BASE}/logout">Sign out</a></div>`
        : ""
    }
  </div>
  ${user ? `<nav class="tabs">${nav}</nav>` : ""}
</header>
<main>${body}</main>
<footer>
  Documents are versioned, never overwritten. Every download is logged. Engagements become append-only at
  the AS 1215.15 documentation completion date — 14 days after report release — and are retained seven years
  from that release date under AS 1215.14. Deadline calculations shown here are computed from the rules cited
  and are a working calendar, not legal advice; securities counsel owns the filing calendar.
</footer>
</body></html>`;
}

// ── Auth pages ──────────────────────────────────────────────
function loginPage({ next, error } = {}) {
  const body = `
  <div class="auth-wrap">
    <div class="card">
      <h1>Sign in</h1>
      <div class="sub">Nightfood Holdings audit portal</div>
      ${error ? `<div class="note red">${esc(error)}</div>` : ""}
      <form method="POST" action="${BASE}/login">
        <input type="hidden" name="next" value="${esc(next || BASE)}">
        <label>Email</label><input type="email" name="email" required autofocus autocomplete="username">
        <label>Password</label><input type="password" name="password" required autocomplete="current-password">
        <label style="font-weight:400;margin-top:13px;">
          <input type="checkbox" name="remember" value="1" style="width:auto;margin-right:6px;">Keep me signed in for 7 days</label>
        <div style="margin-top:15px;"><button class="btn" type="submit" style="width:100%;">Sign in</button></div>
      </form>
    </div>
    <div class="xs muted" style="text-align:center;">
      Access is logged. Auditor accounts are read-and-annotate only —
      they cannot upload or certify the company's records.
    </div>
  </div>`;
  return chrome({ title: "Sign in", body, user: null });
}

function setupPage() {
  const body = `
  <div class="auth-wrap">
    <div class="card">
      <h1>Create the first administrator</h1>
      <div class="sub">No accounts exist yet. This one becomes the portal administrator.</div>
      <form method="POST" action="${BASE}/setup">
        <label>Full name</label><input type="text" name="name" required autofocus>
        <label>Email</label><input type="email" name="email" required autocomplete="username">
        <label>Password (10 characters minimum)</label>
        <input type="password" name="password" required minlength="10" autocomplete="new-password">
        <label>Confirm password</label>
        <input type="password" name="confirm" required minlength="10" autocomplete="new-password">
        <div style="margin-top:15px;"><button class="btn" type="submit" style="width:100%;">Create account</button></div>
      </form>
      <div class="note blue" style="margin-top:16px;">
        Add the TAAD engagement team afterwards with the <b>auditor</b> roles. Auditor accounts can download
        everything and raise review notes, but cannot upload documents or answer the company's sweep
        questions — SEC Rule 2-01(c)(4) treats bookkeeping and management functions as impairing independence,
        so the portal enforces that boundary structurally rather than by convention.
      </div>
    </div>
  </div>`;
  return chrome({ title: "Setup", body, user: null });
}

function errorPage(message, user) {
  return chrome({
    title: "Error",
    user,
    body: `<div class="card"><h1>Something went wrong</h1><div class="note red">${esc(message)}</div>
      <a class="btn ghost" href="${BASE}">Back to dashboard</a></div>`,
  });
}

// ── Dashboard ───────────────────────────────────────────────
function dashboardPage(d, user) {
  const openGates = d.engagements.reduce((a, e) => a + (e.open_gates || 0), 0);
  const overdue = d.engagements.reduce((a, e) => a + (e.overdue_count || 0), 0);
  const openItems = d.engagements.reduce((a, e) => a + (e.open_count || 0), 0);
  const docs = d.engagements.reduce((a, e) => a + (e.doc_count || 0), 0);

  const stats = `
  <div class="grid g4" style="margin-bottom:16px;">
    <div class="stat"><div class="n" style="color:${openGates ? "var(--red)" : "var(--green)"}">${openGates}</div>
      <div class="l">Open gating items</div><div class="x">Block a report or filing</div></div>
    <div class="stat"><div class="n" style="color:${overdue ? "var(--amber)" : "var(--ink)"}">${overdue}</div>
      <div class="l">Overdue</div><div class="x">Past internal due date</div></div>
    <div class="stat"><div class="n">${openItems}</div><div class="l">Open items</div>
      <div class="x">Across active engagements</div></div>
    <div class="stat"><div class="n">${docs}</div><div class="l">Documents on file</div>
      <div class="x">${d.triageCount ? `<a href="${BASE}/triage" style="color:var(--amber);font-weight:600;">${d.triageCount} need triage</a>` : "All classified"}</div></div>
  </div>`;

  const filings = d.upcomingFilings.length
    ? `<table><tr><th>Form</th><th>Period</th><th>Due</th><th>In</th><th>12b-25 by</th></tr>
      ${d.upcomingFilings
        .map((f) => {
          const n = daysUntil(f.filing_due_date);
          const c = n <= 7 ? "var(--red)" : n <= 21 ? "var(--amber)" : "var(--ink)";
          return `<tr><td><b>${esc(f.filing_form || "—")}</b></td>
            <td><a href="${BASE}/engagement/${f.id}">${esc(f.period_label)}</a></td>
            <td>${fmtDate(f.filing_due_date)}</td>
            <td style="color:${c};font-weight:600;">${n} day${n === 1 ? "" : "s"}</td>
            <td class="sm muted">${fmtDate(f.filing_nt_due_date)}</td></tr>`;
        })
        .join("")}</table>`
    : `<div class="empty">No upcoming filings scheduled. Open an engagement from the Calendar to start one.</div>`;

  const clocks = d.archiveClocks.length
    ? d.archiveClocks
        .map((c) => {
          const col = c.status === "locked_overdue" ? "var(--red)" : c.status === "critical" ? "var(--red)" : c.status === "urgent" ? "var(--amber)" : "var(--green)";
          return `<div style="padding:10px 0;border-bottom:1px solid #EFF2F5;">
            <div class="between"><div><a href="${BASE}/engagement/${c.id}"><b>${esc(c.period_label)}</b></a>
              <div class="xs muted">Report released ${fmtDate(c.reportReleaseDate)} · complete by ${fmtDate(c.completionDate)}</div></div>
              <div style="color:${col};font-weight:650;font-size:15px;white-space:nowrap;">
                ${c.daysRemaining < 0 ? `${Math.abs(c.daysRemaining)}d over` : `${c.daysRemaining}d left`}</div></div></div>`;
        })
        .join("")
    : `<div class="empty">No engagement has a report release date set yet.</div>`;

  const recent = d.recentUploads.length
    ? `<table><tr><th>Document</th><th>Ref</th><th>Brief</th><th>When</th></tr>
      ${d.recentUploads
        .map(
          (r) => `<tr>
        <td><a href="${BASE}/document/${r.id}">${esc(r.filename)}</a>${r.version > 1 ? ` <span class="xs muted">v${r.version}</span>` : ""}
          ${r.is_gate ? ` ${pill("GATE", "#991B1B")}` : ""}</td>
        <td><code>${esc(r.category_code || "—")}</code></td>
        <td class="sm">${esc(String(r.brief || "").slice(0, 150))}${String(r.brief || "").length > 150 ? "…" : ""}</td>
        <td class="sm muted" style="white-space:nowrap;">${fmtDateTime(r.uploaded_at)}</td></tr>`
        )
        .join("")}</table>`
    : `<div class="empty">Nothing uploaded yet.</div>`;

  const overdueList = d.overdue.length
    ? `<table><tr><th>Ref</th><th>Item</th><th>Period</th><th>Due</th></tr>
      ${d.overdue
        .map(
          (o) => `<tr>
          <td>${o.is_gate ? pill("GATE", "#991B1B") : ""} <code>${esc(o.category_code || "—")}</code></td>
          <td><a href="${BASE}/engagement/${o.engagement_id}">${esc(String(o.label).slice(0, 92))}</a></td>
          <td class="sm muted">${esc(o.period_label)}</td>
          <td class="sm" style="color:var(--red);font-weight:600;white-space:nowrap;">${fmtDate(o.due_date)}</td></tr>`
        )
        .join("")}</table>`
    : `<div class="empty">Nothing overdue.</div>`;

  const notes = d.openNotes.length
    ? d.openNotes
        .map(
          (n) => `<div style="padding:10px 0;border-bottom:1px solid #EFF2F5;">
        <div class="xs muted">${esc(n.author_name || "—")} · ${esc(n.author_org || "")} · ${fmtDateTime(n.created_at)}</div>
        <div class="sm" style="margin-top:3px;">${esc(String(n.body).slice(0, 220))}</div>
        ${n.document_id ? `<a class="xs" href="${BASE}/document/${n.document_id}">Open document →</a>` : ""}</div>`
        )
        .join("")
    : `<div class="empty">No open review notes.</div>`;

  const engRows = d.engagements.length
    ? `<table><tr><th>Period</th><th>Tier</th><th>Status</th><th class="right">Docs</th>
        <th class="right">Open</th><th class="right">Gates</th><th>Progress</th><th>Filing due</th></tr>
      ${d.engagements
        .map((e) => {
          const done = (e.item_count || 0) - (e.open_count || 0);
          const pct = e.item_count ? Math.round((done / e.item_count) * 100) : 0;
          const col = e.open_gates ? "var(--red)" : pct === 100 ? "var(--green)" : "var(--navy2)";
          return `<tr>
          <td><a href="${BASE}/engagement/${e.id}"><b>${esc(e.period_label)}</b></a></td>
          <td class="sm muted">${esc(e.tier)}</td>
          <td>${statusPill(e.status)}${e.legal_hold ? " " + pill("LEGAL HOLD", "#991B1B") : ""}</td>
          <td class="right">${e.doc_count}</td>
          <td class="right">${e.open_count}</td>
          <td class="right" style="color:${e.open_gates ? "var(--red)" : "inherit"};font-weight:${e.open_gates ? 700 : 400};">${e.open_gates}</td>
          <td style="min-width:110px;"><div class="bar"><i style="width:${pct}%;background:${col};"></i></div>
            <div class="xs muted" style="margin-top:2px;">${pct}% · ${done}/${e.item_count}</div></td>
          <td class="sm">${fmtDate(e.filing_due_date)}</td></tr>`;
        })
        .join("")}</table>`
    : `<div class="empty">No engagements yet. <a href="${BASE}/calendar">Open one from the Calendar</a>.</div>`;

  const body = `
  <div class="between"><div>
    <h1>Audit dashboard</h1>
    <div class="sub">Non-accelerated filer · smaller reporting company · not an EGC, so AS 3101 critical audit
      matters apply · no SOX 404(b) auditor attestation required</div>
  </div>${auth.can(user, "document.upload") ? `<a class="btn" href="${BASE}/upload">Upload documents</a>` : ""}</div>
  ${stats}
  ${openGates ? `<div class="note red"><b>${openGates} gating item${openGates === 1 ? " is" : "s are"} still open.</b>
    A gating item is one where a standard or rule prevents the report or filing from issuing until it is
    delivered — the quarterly representation letter, for instance, makes an AS 4105 interim review incomplete
    and the Form 10-Q unfileable until it is signed.</div>` : ""}
  <div class="grid g2">
    <div class="card tight"><div style="padding:14px 18px 0;"><h2>Upcoming filings</h2></div>${filings}</div>
    <div class="card"><h2>AS 1215 archive clocks</h2>${clocks}</div>
  </div>
  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Engagements</h2></div>${engRows}</div>
  <div class="grid g2">
    <div class="card tight"><div style="padding:14px 18px 0;"><h2>Overdue items</h2></div>${overdueList}</div>
    <div class="card"><h2>Open review notes</h2>${notes}</div>
  </div>
  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Recent uploads</h2></div>${recent}</div>`;

  return chrome({ title: "Dashboard", body, user, active: "dashboard", wide: true });
}

// ── Engagement page ─────────────────────────────────────────
function engagementPage({ engagement: e, checklist, documents, progress, notes, events }, user) {
  const items = checklist ? checklist.items : [];
  const done = items.filter((i) => i.status !== "open").length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  const openGates = items.filter((i) => i.status === "open" && i.is_gate);

  const progressRows = progress
    .map((p) => {
      const br = tax.BRACKET_BY_CODE[p.bracket_code];
      const pc = p.total ? Math.round((p.done / p.total) * 100) : 0;
      return `<tr>
        <td><span class="brk" style="background:${br ? br.color : "#889"}">${esc(p.bracket_code)}</span>${esc(br ? br.label : p.bracket_code)}</td>
        <td style="min-width:130px;"><div class="bar"><i style="width:${pc}%;background:${p.open_gates ? "var(--red)" : br ? br.color : "var(--navy2)"};"></i></div></td>
        <td class="right sm">${p.done}/${p.total}</td>
        <td class="right sm" style="color:${p.open_gates ? "var(--red)" : "var(--mute)"};font-weight:${p.open_gates ? 700 : 400};">${p.open_gates || ""}</td>
        <td class="right sm" style="color:${p.overdue ? "var(--amber)" : "var(--mute)"};">${p.overdue || ""}</td></tr>`;
    })
    .join("");

  const canArchive = auth.can(user, "engagement.archive");
  const canSetDate = auth.can(user, "engagement.set_report_date");

  const lifecycle = `
  <div class="card">
    <h2>Engagement lifecycle</h2>
    <table style="font-size:13px;">
      <tr><td class="muted" style="width:44%;">Status</td><td>${statusPill(e.status)}${e.legal_hold ? " " + pill("LEGAL HOLD", "#991B1B") : ""}</td></tr>
      <tr><td class="muted">Form / filing due</td><td>${esc(e.filing_form || "—")} · ${fmtDate(e.filing_due_date)}</td></tr>
      <tr><td class="muted">Form 12b-25 due by</td><td>${fmtDate(e.filing_nt_due_date)}</td></tr>
      <tr><td class="muted">Extended date if 12b-25 filed</td><td>${fmtDate(e.filing_extended_date)}</td></tr>
      <tr><td class="muted">Report release date</td><td>${fmtDate(e.report_release_date)}</td></tr>
      <tr><td class="muted">AS 1215.15 completion date</td><td><b>${fmtDate(e.doc_completion_date)}</b>
        ${e.doc_completion_date ? `<span class="xs muted"> (14 days)</span>` : ""}</td></tr>
      <tr><td class="muted">AS 1215.14 retention through</td><td>${fmtDate(e.retention_expiry)}</td></tr>
    </table>
    ${
      canSetDate && !["archived", "locked"].includes(e.status)
        ? `<div style="margin-top:13px;padding-top:13px;border-top:1px solid var(--line);">
             <label>Set report release date (starts the 14-day AS 1215 clock)</label>
             <div class="row"><input type="date" id="rrdate" style="max-width:180px;">
               <button class="btn sm" onclick="setReportDate(${e.id})">Set date</button></div></div>`
        : ""
    }
    ${
      canArchive && e.status === "report_released"
        ? `<div style="margin-top:13px;">
             <button class="btn sm danger" onclick="archiveEngagement(${e.id})">Archive — make append-only</button>
             <div class="xs muted" style="margin-top:5px;">Irreversible. Enforced by database trigger.</div></div>`
        : ""
    }
    <a class="btn ghost sm" style="margin-top:13px;" href="${BASE}/api/engagement/${e.id}/pbc.xlsx">Export PBC index (.xlsx)</a>
    ${
      auth.can(user, "document.download")
        ? `<div style="margin-top:15px;padding-top:14px;border-top:1px solid var(--line);">
             <div style="font-weight:600;margin-bottom:3px;">Send this period</div>
             <div class="xs muted" style="margin-bottom:9px;">Every document in its designated folder, with a manifest of
               SHA-256 hashes and the PBC index. One archive instead of ${e.doc_count || "dozens of"} downloads.</div>
             <label class="xs" style="display:block;margin-bottom:4px;">
               <input type="checkbox" id="expSup"> Include superseded versions</label>
             <label class="xs" style="display:block;margin-bottom:9px;">
               <input type="checkbox" id="expCls" checked> Classified documents only</label>
             <a class="btn sm" id="expBtn" href="${BASE}/api/engagement/${e.id}/export.zip?delivered=1">Download .zip</a>
           </div>`
        : ""
    }
  </div>`;

  const docRows = documents.length
    ? `<table><tr><th>Document</th><th>Ref</th><th>Ver</th><th>Size</th><th>Status</th><th>DL</th><th>Uploaded</th></tr>
      ${documents
        .map(
          (d) => `<tr>
        <td><a href="${BASE}/document/${d.id}">${esc(d.filename)}</a>
          ${d.is_gate ? " " + pill("GATE", "#991B1B") : ""}${d.is_confidential ? " " + pill("RESTRICTED", "#6B21A8") : ""}
          ${d.post_archive ? " " + pill("POST-ARCHIVE", "#9C4221") : ""}
          ${(d.flags || []).length ? `<div>${d.flags.map((f) => `<span class="flag">${esc(String(f).replace(/_/g, " "))}</span>`).join("")}</div>` : ""}</td>
        <td><code>${esc(d.category_code || "—")}</code></td>
        <td class="sm">v${d.version}</td>
        <td class="sm muted">${fmtBytes(d.size_bytes)}</td>
        <td>${statusPill(d.status)}</td>
        <td class="sm muted right">${d.download_count || 0}</td>
        <td class="sm muted" style="white-space:nowrap;">${fmtDateTime(d.uploaded_at)}</td></tr>`
        )
        .join("")}</table>`
    : `<div class="empty">No documents yet for this period.</div>`;

  const eventRows = events
    .slice(0, 40)
    .map(
      (ev) => `<tr><td class="sm" style="white-space:nowrap;">${fmtDateTime(ev.created_at)}</td>
      <td class="sm"><code>${esc(ev.event)}</code></td>
      <td class="sm muted">${esc(ev.actor_email || "system")}</td></tr>`
    )
    .join("");

  const body = `
  <div class="between"><div>
    <h1>${esc(e.period_name || e.period_label)}</h1>
    <div class="sub">${esc(e.tier)} engagement · period ended ${fmtDate(e.period_end)}</div>
  </div>
  <div class="row">
    <a class="btn ghost" href="${BASE}/checklist/${e.id}">Open checklist</a>
    ${auth.can(user, "document.upload") && !["archived", "locked"].includes(e.status) ? `<a class="btn" href="${BASE}/upload">Upload</a>` : ""}
  </div></div>

  ${e.headline ? `<div class="note blue">${esc(e.headline)}</div>` : ""}
  ${
    ["archived", "locked"].includes(e.status)
      ? `<div class="note red"><b>This engagement is append-only.</b> Under AS 1215.16 documentation may not be
         deleted or discarded after the documentation completion date. Information may still be added, but each
         addition must record the date, the preparer and the reason. This is enforced by database trigger, so it
         holds even against direct database access.</div>`
      : ""
  }
  ${
    openGates.length
      ? `<div class="note red"><b>${openGates.length} gating item${openGates.length === 1 ? "" : "s"} outstanding:</b>
         ${openGates.slice(0, 8).map((g) => esc(g.category_code || g.sweep_id)).join(", ")}${openGates.length > 8 ? ", …" : ""}</div>`
      : ""
  }

  <div class="grid g3" style="margin-bottom:16px;">
    <div class="stat"><div class="n">${pct}%</div><div class="l">Complete</div>
      <div class="x">${done} of ${items.length} items</div></div>
    <div class="stat"><div class="n" style="color:${openGates.length ? "var(--red)" : "var(--green)"}">${openGates.length}</div>
      <div class="l">Open gates</div><div class="x">Block the filing</div></div>
    <div class="stat"><div class="n">${documents.filter((d) => d.status === "active").length}</div>
      <div class="l">Active documents</div><div class="x">${documents.length} including superseded</div></div>
  </div>

  <div class="grid g2">
    <div class="card tight"><div style="padding:14px 18px 0;"><h2>Progress by section</h2></div>
      <table><tr><th>Section</th><th></th><th class="right">Done</th><th class="right">Gates</th><th class="right">Late</th></tr>${progressRows}</table></div>
    ${lifecycle}
  </div>

  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Documents</h2></div>${docRows}</div>

  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Chain of custody</h2>
    <div class="xs muted" style="margin-bottom:10px;">Append-only. Cannot be edited or deleted by anyone, including a portal administrator.</div></div>
    <table><tr><th>When</th><th>Event</th><th>Actor</th></tr>${eventRows}</table></div>

  <script>
  async function post(url, body){
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function setReportDate(id){
    const d = document.getElementById('rrdate').value;
    if(!d) return alert('Pick a date first.');
    try{ const j = await post('${BASE}/api/engagement/'+id+'/report-release',{date:d});
      alert('Report release date set.\\n\\nAS 1215.15 documentation completion date: '+j.clock.completionDate+
            '\\nAS 1215.14 retention through: '+j.clock.retentionExpiry); location.reload();
    }catch(e){ alert(e.message); }
  }
  async function archiveEngagement(id){
    if(!confirm('Archive this engagement?\\n\\nThis is irreversible. Documents can no longer be deleted or replaced. '+
      'New information may still be added, but each addition must record a reason under AS 1215.16.')) return;
    try{ await post('${BASE}/api/engagement/'+id+'/archive'); location.reload(); }catch(e){ alert(e.message); }
  }
  </script>`;

  return chrome({ title: e.period_label, body, user, active: "dashboard", wide: true });
}

// ── Checklist page ──────────────────────────────────────────
function checklistPage({ engagement: e, checklist }, user) {
  if (!checklist) return errorPage("No checklist has been generated for this engagement.", user);
  const items = checklist.items;
  const sweeps = items.filter((i) => i.kind === "sweep");
  const docs = items.filter((i) => i.kind === "document");
  const canAnswer = auth.can(user, "checklist.answer") && !["archived", "locked"].includes(e.status);
  const canAccept = auth.can(user, "checklist.accept");
  const canWaive = auth.can(user, "checklist.waive");

  const sweepCards = sweeps
    .map((s) => {
      const answered = s.status !== "open";
      const yes = s.answer === true;
      const bg = !answered ? "#FDF6EA" : yes ? "#F1F6FB" : "#EFF8F3";
      const bd = !answered ? "#B45309" : yes ? "#2C5F8A" : "#1C7C54";
      return `<div class="card" style="background:${bg};border-left:3px solid ${bd};">
      <div class="between"><div style="flex:1;min-width:240px;">
        <div style="font-weight:600;font-size:13.5px;">${esc(s.label)}</div>
        <div class="xs muted" style="margin-top:4px;">${esc((s.authority || []).join(" · "))}</div>
      </div><div>${answered ? statusPill(s.status) : pill("Needs answer", "#B45309")}</div></div>
      ${s.why ? `<details style="margin-top:8px;"><summary>Why the auditor asks this</summary>
        <div class="sm" style="color:var(--ink2);">${esc(s.why)}</div></details>` : ""}
      ${
        answered
          ? `<div class="sm" style="margin-top:9px;padding-top:9px;border-top:1px solid rgba(0,0,0,.07);">
             <b>${yes ? "YES" : "NO"}</b> — ${esc(s.answered_by_name || "")} · ${fmtDateTime(s.answered_at)}
             ${s.answer_note ? `<div style="margin-top:4px;">${esc(s.answer_note)}</div>` : ""}</div>`
          : canAnswer
          ? `<div style="margin-top:10px;">
               <textarea id="note-${s.id}" placeholder="If YES, describe what occurred — the auditor needs enough to know what to look for."></textarea>
               <div class="row" style="margin-top:8px;">
                 <button class="btn sm ok" onclick="answer(${s.id},false)">No — nothing to report</button>
                 <button class="btn sm" onclick="answer(${s.id},true)">Yes — and here is what</button></div>
               <div class="xs muted" style="margin-top:6px;">A NO is recorded as signed negative assurance with
                 your name and the time. A YES adds the documents it implies to this checklist automatically.</div></div>`
          : `<div class="xs muted" style="margin-top:9px;">Awaiting a company answer.</div>`
      }
    </div>`;
    })
    .join("");

  const byBracket = {};
  docs.forEach((d) => {
    const b = d.bracket_code || "?";
    (byBracket[b] = byBracket[b] || []).push(d);
  });

  const docSections = Object.keys(byBracket)
    .sort()
    .map((b) => {
      const br = tax.BRACKET_BY_CODE[b];
      const list = byBracket[b];
      const doneN = list.filter((i) => !["open", "pending_confirmation"].includes(i.status)).length;
      const rows = list
        .map((i) => {
          const late =
            ["open", "pending_confirmation"].includes(i.status) &&
            daysUntil(i.due_date) !== null &&
            daysUntil(i.due_date) < 0;
          return `<tr>
          <td style="white-space:nowrap;">${i.is_gate ? pill("GATE", "#991B1B") + " " : ""}<code>${esc(i.category_code || "")}</code></td>
          <td>${esc(i.label)}
            ${i.spawned_from_item ? `<div class="xs" style="color:var(--navy2);">Added by a YES sweep answer</div>` : ""}
            ${i.note ? `<details><summary>Guidance</summary><div class="sm" style="color:var(--ink2);">${esc(i.note)}</div></details>` : ""}
            ${i.doc_filename ? `<div class="xs"><a href="${BASE}/document/${i.satisfied_by_doc}">${esc(i.doc_filename)}</a> v${i.doc_version}</div>` : ""}
            ${i.waiver_reason ? `<div class="xs muted">Waived: ${esc(i.waiver_reason)}</div>` : ""}
            ${
              i.status === "pending_confirmation"
                ? `<div class="xs" style="color:var(--red);font-weight:600;">A document was filed here but the
                     classification was not confident enough to close a gating item. Open it and confirm the
                     category — until then this counts as outstanding.</div>`
                : ""
            }</td>
          <td class="sm" style="white-space:nowrap;color:${late ? "var(--red)" : "var(--mute)"};font-weight:${late ? 600 : 400};">${fmtDate(i.due_date)}</td>
          <td>${statusPill(i.status)}${i.auditor_accepted ? " " + pill("ACCEPTED", "#1C7C54") : ""}</td>
          <td class="right" style="white-space:nowrap;">
            ${canAccept && i.status === "satisfied" && !i.auditor_accepted ? `<button class="btn sm ok" onclick="accept(${i.id})">Accept</button> ` : ""}
            ${canAccept && i.status === "satisfied" ? `<button class="btn sm ghost" onclick="reject(${i.id})">Reject</button>` : ""}
            ${canWaive && i.status === "open" && !i.is_gate ? `<button class="btn sm ghost" onclick="waive(${i.id})">Waive</button>` : ""}
          </td></tr>`;
        })
        .join("");
      return `<div class="card tight">
        <div style="padding:13px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;">
          <span class="brk" style="background:${br ? br.color : "#889"}">${esc(b)}</span>
          <div style="flex:1;"><b>${esc(br ? br.label : b)}</b>
            <div class="xs muted">${doneN} of ${list.length} delivered</div></div></div>
        ${br ? `<div style="padding:10px 18px;background:#FAFBFC;border-bottom:1px solid var(--line);" class="sm muted">${esc(br.blurb)}</div>` : ""}
        <table><tr><th>Ref</th><th>Item</th><th>Due</th><th>Status</th><th></th></tr>${rows}</table></div>`;
    })
    .join("");

  const body = `
  <div class="between"><div>
    <h1>Checklist — ${esc(e.period_name || e.period_label)}</h1>
    <div class="sub">${docs.length} document items · ${sweeps.length} sweep questions ·
      target complete by ${fmtDate(checklist.target_complete_by)}</div></div>
    <a class="btn ghost" href="${BASE}/engagement/${e.id}">Engagement overview</a></div>

  ${checklist.headline ? `<div class="note blue">${esc(checklist.headline)}</div>` : ""}

  <h2 style="margin-top:20px;">Sweep questions</h2>
  <div class="note amber">These catch the documents nobody remembered existed. A checklist of "upload X" items
    can only ever surface what someone already thought of; these ask the questions the auditor is required to ask
    anyway under AS 4105.18, and a YES automatically adds the documents it implies. Answer every one, including
    the ones where the answer is nothing — a NIL answer is the evidence.</div>
  ${sweepCards || `<div class="empty">No sweep questions on this checklist.</div>`}

  <h2 style="margin-top:22px;">Document requests by section</h2>
  ${docSections}

  <script>
  async function post(url, body){
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function answer(id, yes){
    const note = (document.getElementById('note-'+id)||{}).value || '';
    if(yes && note.trim().length < 3) return alert('Describe what occurred so the auditor knows what to look for.');
    try{ const j = await post('${BASE}/api/item/'+id+'/answer',{answer:yes,note:note});
      if(j.spawned && j.spawned.length) alert('Recorded. '+j.spawned.length+' document request'+
        (j.spawned.length===1?'':'s')+' added to this checklist:\\n\\n'+j.spawned.map(s=>s.category_code+' — '+s.label).join('\\n'));
      location.reload();
    }catch(e){ alert(e.message); }
  }
  (function(){
    // Keep the export link's query string in step with the checkboxes,
    // so the href is always what the buttons say it is.
    var b=document.getElementById('expBtn'); if(!b) return;
    var sup=document.getElementById('expSup'), cls=document.getElementById('expCls');
    var base=b.getAttribute('href').split('?')[0];
    function sync(){
      var q=[];
      if(sup && sup.checked) q.push('superseded=1');
      if(cls && cls.checked) q.push('delivered=1');
      b.setAttribute('href', base + (q.length ? '?'+q.join('&') : ''));
    }
    if(sup) sup.addEventListener('change', sync);
    if(cls) cls.addEventListener('change', sync);
    sync();
  })();
  async function accept(id){ try{ await post('${BASE}/api/item/'+id+'/accept'); location.reload(); }catch(e){ alert(e.message); } }
  async function reject(id){
    const r = prompt('What is wrong with it? The company will receive this note.');
    if(!r) return;
    try{ await post('${BASE}/api/item/'+id+'/reject',{reason:r}); location.reload(); }catch(e){ alert(e.message); }
  }
  async function waive(id){
    const r = prompt('Reason for waiving this item (the auditor will read it):');
    if(!r) return;
    try{ await post('${BASE}/api/item/'+id+'/waive',{reason:r}); location.reload(); }catch(e){ alert(e.message); }
  }
  </script>`;

  return chrome({ title: "Checklist", body, user, active: "dashboard", wide: true });
}

// ── Document page ───────────────────────────────────────────
function documentPage({ document: d, engagement, comments, events, versions }, user) {
  const cat = d.category_code ? tax.CATEGORY_BY_CODE[d.category_code] : null;
  const br = cat ? tax.BRACKET_BY_CODE[cat.bracket] : null;
  const cls = d.classification || {};

  const catOptions = tax.CATEGORIES.map(
    (c) => `<option value="${c.code}"${c.code === d.category_code ? " selected" : ""}>${esc(c.code)} — ${esc(c.label)}</option>`
  ).join("");

  const commentHtml = comments.length
    ? comments
        .map(
          (c) => `<div style="padding:11px 0;border-bottom:1px solid #EFF2F5;">
        <div class="xs muted">${esc(c.author_name || "—")}${c.author_firm ? ` · ${esc(c.author_firm)}` : ""} ·
          ${esc(c.author_org || "")} · ${fmtDateTime(c.created_at)}
          ${c.kind === "review_note" ? " " + pill("REVIEW NOTE", "#9C4221") : ""}
          ${c.resolved ? " " + pill("RESOLVED", "#1C7C54") : ""}</div>
        <div class="sm" style="margin-top:4px;white-space:pre-wrap;">${esc(c.body)}</div>
        ${!c.resolved && auth.can(user, "comment.resolve") ? `<button class="btn sm ghost" style="margin-top:6px;" onclick="resolveComment(${c.id})">Mark resolved</button>` : ""}
      </div>`
        )
        .join("")
    : `<div class="empty">No notes on this document.</div>`;

  const body = `
  <div class="between"><div>
    <h1>${esc(d.filename)}</h1>
    <div class="sub">${br ? `<span class="brk" style="background:${br.color}">${esc(br.code)}</span>${esc(br.label)} · ` : ""}
      ${cat ? esc(cat.code + " — " + cat.label) : "Unclassified"}</div></div>
    <div class="row">
      ${auth.can(user, "document.download") ? `<a class="btn" href="${BASE}/api/document/${d.id}/download">Download</a>` : ""}
      ${engagement ? `<a class="btn ghost" href="${BASE}/engagement/${engagement.id}">Engagement</a>` : ""}
    </div></div>

  ${d.brief ? `<div class="note blue"><b>Brief.</b> ${esc(d.brief)}</div>` : ""}
  ${d.is_gate ? `<div class="note red"><b>Gating item.</b> A report or filing cannot issue without this.</div>` : ""}
  ${d.post_archive ? `<div class="note amber"><b>Added after the documentation completion date.</b>
      Reason recorded under AS 1215.16: ${esc(d.addition_reason || "—")}</div>` : ""}
  ${(d.flags || []).length ? `<div class="note amber"><b>Pre-flight flags.</b>
      ${d.flags.map((f) => `<span class="flag">${esc(String(f).replace(/_/g, " "))}</span>`).join("")}</div>` : ""}
  ${cat && cat.note ? `<div class="note purple"><b>What the auditor does with this.</b> ${esc(cat.note)}</div>` : ""}

  <div class="grid g2">
    <div class="card"><h2>Document</h2>
      <table style="font-size:13px;">
        <tr><td class="muted" style="width:40%;">Status</td><td>${statusPill(d.status)}</td></tr>
        <tr><td class="muted">Version</td><td>v${d.version}${d.supersedes_id ? ` <span class="xs muted">(supersedes #${d.supersedes_id})</span>` : ""}</td></tr>
        <tr><td class="muted">Size / type</td><td>${fmtBytes(d.size_bytes)} · ${esc(d.mime_type || "—")}</td></tr>
        <tr><td class="muted">SHA-256</td><td><span class="mono">${esc(d.sha256)}</span></td></tr>
        <tr><td class="muted">Period</td><td>${esc(d.period_label || "—")}${d.period_as_of ? ` · as of ${fmtDate(d.period_as_of)}` : ""}</td></tr>
        <tr><td class="muted">Designated folder</td><td><span class="mono">${esc(d.folder_path || "—")}</span></td></tr>
        <tr><td class="muted">Uploaded</td><td>${fmtDateTime(d.uploaded_at)}</td></tr>
        <tr><td class="muted">Authority</td><td class="sm">${cat ? esc((cat.authority || []).join(", ")) : "—"}</td></tr>
      </table></div>

    <div class="card"><h2>Classification</h2>
      <table style="font-size:13px;">
        <tr><td class="muted" style="width:40%;">Confidence</td><td><b>${d.confidence == null ? "—" : d.confidence + "%"}</b>
          ${d.needs_confirmation ? " " + pill("Needs confirmation", "#B45309") : ""}</td></tr>
        <tr><td class="muted">Method</td><td>${esc(d.classify_method || "—")}</td></tr>
        ${d.reclassified_from ? `<tr><td class="muted">Originally</td><td><code>${esc(d.reclassified_from)}</code></td></tr>` : ""}
      </table>
      ${cls.aiReasoning ? `<div class="sm" style="margin-top:9px;color:var(--ink2);"><b>Reasoning.</b> ${esc(cls.aiReasoning)}</div>` : ""}
      ${
        Array.isArray(cls.candidates) && cls.candidates.length > 1
          ? `<details style="margin-top:9px;"><summary>Other candidates considered</summary>
             <table class="sm">${cls.candidates
               .map((c) => `<tr><td><code>${esc(c.code)}</code></td><td>${esc(c.label)}</td><td class="right muted">${c.score}%</td></tr>`)
               .join("")}</table></details>`
          : ""
      }
      ${
        Array.isArray(cls.reasoningTrail) && cls.reasoningTrail.length
          ? `<details style="margin-top:7px;"><summary>Classification trail</summary>
             <ul class="sm muted" style="margin:0;padding-left:18px;">${cls.reasoningTrail.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>`
          : ""
      }
      ${
        auth.can(user, "document.reclassify")
          ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
             <label>Correct the category</label>
             <select id="newcat">${catOptions}</select>
             <button class="btn sm" style="margin-top:8px;" onclick="reclassify(${d.id})">Reclassify</button></div>`
          : ""
      }
    </div>
  </div>

  ${
    versions && versions.length > 1
      ? `<div class="card tight"><div style="padding:14px 18px 0;"><h2>Version history</h2></div>
        <table><tr><th>Version</th><th>File</th><th>Status</th><th>Uploaded</th></tr>
        ${versions
          .map(
            (v) => `<tr><td>v${v.version}</td><td><a href="${BASE}/document/${v.id}">${esc(v.filename)}</a></td>
          <td>${statusPill(v.status)}</td><td class="sm muted">${fmtDateTime(v.uploaded_at)}</td></tr>`
          )
          .join("")}</table></div>`
      : ""
  }

  <div class="card"><h2>Review notes</h2>${commentHtml}
    ${
      auth.can(user, "comment.write")
        ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
           <textarea id="cbody" placeholder="Raise a question or note about this document…"></textarea>
           <button class="btn sm" style="margin-top:8px;" onclick="addComment(${d.id}${engagement ? "," + engagement.id : ",null"})">Post note</button></div>`
        : ""
    }
  </div>

  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Chain of custody</h2></div>
    <table><tr><th>When</th><th>Event</th><th>Actor</th><th>Detail</th></tr>
    ${events
      .map(
        (ev) => `<tr><td class="sm" style="white-space:nowrap;">${fmtDateTime(ev.created_at)}</td>
        <td class="sm"><code>${esc(ev.event)}</code></td>
        <td class="sm muted">${esc(ev.actor_email || "system")}</td>
        <td class="xs muted">${esc(ev.detail ? JSON.stringify(ev.detail).slice(0, 130) : "")}</td></tr>`
      )
      .join("")}</table></div>

  <script>
  async function post(url, body){
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function reclassify(id){
    const c = document.getElementById('newcat').value;
    const reason = prompt('Why is this being reclassified? (optional)') || '';
    try{ await post('${BASE}/api/document/'+id+'/reclassify',{category:c,reason:reason}); location.reload(); }catch(e){ alert(e.message); }
  }
  async function addComment(docId, engId){
    const b = document.getElementById('cbody').value;
    if(!b.trim()) return alert('Write something first.');
    try{ await post('${BASE}/api/comment',{documentId:docId,engagementId:engId,body:b}); location.reload(); }catch(e){ alert(e.message); }
  }
  async function resolveComment(id){ try{ await post('${BASE}/api/comment/'+id+'/resolve'); location.reload(); }catch(e){ alert(e.message); } }
  </script>`;

  return chrome({ title: d.filename, body, user, active: "documents", wide: true });
}

// ── Documents list ──────────────────────────────────────────
function documentsPage({ documents, engagements, filters }, user) {
  const engOpts = engagements
    .map((e) => `<option value="${e.id}"${filters.engagementId === e.id ? " selected" : ""}>${esc(e.period_label)}</option>`)
    .join("");
  const brOpts = tax.BRACKETS.map(
    (b) => `<option value="${b.code}"${filters.bracketCode === b.code ? " selected" : ""}>${esc(b.code)} — ${esc(b.label)}</option>`
  ).join("");

  const rows = documents.length
    ? documents
        .map(
          (d) => `<tr>
      <td><a href="${BASE}/document/${d.id}">${esc(d.filename)}</a>
        ${d.is_gate ? " " + pill("GATE", "#991B1B") : ""}${d.is_confidential ? " " + pill("RESTRICTED", "#6B21A8") : ""}
        ${d.brief ? `<div class="xs muted">${esc(String(d.brief).slice(0, 130))}</div>` : ""}</td>
      <td><code>${esc(d.category_code || "—")}</code></td>
      <td class="sm">${esc(d.period_label || "—")}</td>
      <td class="sm">v${d.version}</td>
      <td>${statusPill(d.status)}</td>
      <td class="sm muted right">${d.download_count || 0}</td>
      <td class="sm muted" style="white-space:nowrap;">${fmtDateTime(d.uploaded_at)}</td>
      <td>${auth.can(user, "document.download") ? `<a class="btn sm ghost" href="${BASE}/api/document/${d.id}/download">Get</a>` : ""}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="8"><div class="empty">No documents match these filters.</div></td></tr>`;

  const body = `
  <h1>Documents</h1>
  <div class="sub">${documents.length} shown · every download is logged against the requesting account</div>
  <div class="card">
    <form method="GET" class="row" style="align-items:flex-end;">
      <div style="flex:1;min-width:170px;"><label>Engagement</label>
        <select name="engagement"><option value="">All</option>${engOpts}</select></div>
      <div style="flex:1;min-width:170px;"><label>Section</label>
        <select name="bracket"><option value="">All</option>${brOpts}</select></div>
      <div style="flex:1;min-width:140px;"><label>Status</label>
        <select name="status">
          <option value="active"${filters.status === "active" ? " selected" : ""}>Active</option>
          <option value="superseded"${filters.status === "superseded" ? " selected" : ""}>Superseded</option>
          <option value="all"${filters.status === "all" ? " selected" : ""}>All versions</option></select></div>
      <button class="btn" type="submit">Filter</button>
    </form>
  </div>
  <div class="card tight"><table>
    <tr><th>Document</th><th>Ref</th><th>Period</th><th>Ver</th><th>Status</th><th class="right">DL</th><th>Uploaded</th><th></th></tr>
    ${rows}</table></div>`;

  return chrome({ title: "Documents", body, user, active: "documents", wide: true });
}

// ── Triage ──────────────────────────────────────────────────
function triagePage({ documents }, user) {
  const catOptions = tax.CATEGORIES.map((c) => `<option value="${c.code}">${esc(c.code)} — ${esc(c.label)}</option>`).join("");
  const rows = documents.length
    ? documents
        .map(
          (d) => `<tr>
      <td><a href="${BASE}/document/${d.id}">${esc(d.filename)}</a>
        ${d.brief ? `<div class="xs muted">${esc(String(d.brief).slice(0, 160))}</div>` : ""}</td>
      <td><code>${esc(d.category_code || "none")}</code><div class="xs muted">${d.confidence == null ? "" : d.confidence + "%"}</div></td>
      <td class="sm">${esc(d.period_label || "—")}</td>
      <td style="min-width:260px;">
        <select id="cat-${d.id}"><option value="">— choose —</option>${catOptions}</select></td>
      <td style="white-space:nowrap;">
        <button class="btn sm" onclick="fix(${d.id})">Set</button>
        <button class="btn sm ghost" onclick="confirmIt(${d.id})">Confirm as-is</button></td></tr>`
        )
        .join("")
    : `<tr><td colspan="5"><div class="empty">Nothing waiting. Every document has been classified and confirmed.</div></td></tr>`;

  const body = `
  <h1>Triage</h1>
  <div class="sub">Documents the classifier could not place with enough confidence, or that carried warning flags</div>
  <div class="note blue">Nothing here was rejected — every file is stored, hashed and versioned. Triage only
    decides which designated folder it belongs in and which checklist item it satisfies.</div>
  <div class="card tight"><table>
    <tr><th>Document</th><th>Guessed</th><th>Period</th><th>Correct category</th><th></th></tr>${rows}</table></div>
  <script>
  async function post(url, body){
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function fix(id){
    const c = document.getElementById('cat-'+id).value;
    if(!c) return alert('Choose a category first.');
    try{ await post('${BASE}/api/document/'+id+'/reclassify',{category:c}); location.reload(); }catch(e){ alert(e.message); }
  }
  async function confirmIt(id){ try{ await post('${BASE}/api/document/'+id+'/confirm'); location.reload(); }catch(e){ alert(e.message); } }
  </script>`;

  return chrome({ title: "Triage", body, user, active: "triage", wide: true });
}

// ── Dropbox sync ────────────────────────────────────────────
function syncPage({ status, files, configured }, user) {
  const last = (status && status.lastResult) || null;
  const rows = files.length
    ? files
        .map((f) => {
          const tone =
            f.status === "imported" ? "#1C7C54" : f.status === "failed" ? "#991B1B" : "#667";
          return `<tr>
        <td><code class="xs">${esc(String(f.remote_path || "").replace(/^\//, ""))}</code>
          ${f.error ? `<div class="xs" style="color:var(--red);">${esc(f.error)}</div>` : ""}</td>
        <td>${pill(f.status, tone)}</td>
        <td>${
          f.document_id
            ? `<a href="${BASE}/document/${f.document_id}">${esc(f.filename || "open")}</a>
               <div class="xs muted"><code>${esc(f.category_code || "unclassified")}</code>${
                 f.confidence == null ? "" : " · " + f.confidence + "%"
               }${f.needs_confirmation ? " · needs confirmation" : ""}</div>`
            : '<span class="xs muted">—</span>'
        }</td>
        <td class="sm" style="white-space:nowrap;">${fmtDate(f.last_seen_at)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="4"><div class="empty">Nothing scanned yet.</div></td></tr>`;

  const setup = `
    <div class="note amber"><b>Dropbox is not connected.</b> Set these on the Render service, then run a check:
      <div class="xs mono" style="margin-top:8px;line-height:1.8;">
        DROPBOX_SHARED_LINK &nbsp; the folder's share URL<br>
        DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN &nbsp; for a scheduled scan<br>
        <span class="muted">or DROPBOX_ACCESS_TOKEN alone, which Dropbox expires after four hours</span>
      </div>
      <div class="xs" style="margin-top:9px;">Create the app at dropbox.com/developers with the
        <code>sharing.read</code> and <code>files.metadata.read</code> scopes. The portal never writes to Dropbox.</div>
    </div>`;

  const body = `
  <h1>Dropbox</h1>
  <div class="sub">Scans the company folder and copies in anything new</div>

  ${configured ? "" : setup}

  <div class="note blue"><b>Imported documents satisfy nothing.</b> Everything the scan finds lands in a holding
    engagement with no checklist, so no box is ticked and no gate closes until a person files it into a period.
    A file sitting in a shared folder is not evidence that the company delivered it for the audit — only someone
    filing it makes that true.</div>

  <div class="card">
    <div class="between">
      <div>
        <div style="font-weight:600;">${configured ? "Connected" : "Not connected"}</div>
        <div class="xs muted">${
          status && status.finishedAt ? "Last scan " + esc(String(status.finishedAt).replace("T", " ").slice(0, 16)) : "No scan has run yet"
        }${status && status.state === "running" ? " · a scan is running now" : ""}</div>
      </div>
      <div style="white-space:nowrap;">
        <button class="btn ghost sm" id="btnTest" onclick="checkIt()">Test connection</button>
        <button class="btn sm" id="btnScan" onclick="runIt(false)">Scan now</button>
      </div>
    </div>
    <div id="syncMsg" hidden style="margin-top:13px;padding:11px 13px;border-radius:7px;font-size:14px;"></div>
    ${
      last
        ? `<div class="row" style="margin-top:13px;gap:22px;flex-wrap:wrap;">
             <div><div class="xs muted">Seen</div><b>${last.seen || 0}</b></div>
             <div><div class="xs muted">Imported</div><b style="color:var(--green);">${last.imported || 0}</b></div>
             <div><div class="xs muted">New versions</div><b>${last.versions || 0}</b></div>
             <div><div class="xs muted">Skipped</div><b>${last.skipped || 0}</b></div>
             <div><div class="xs muted">Failed</div><b style="color:${last.failed ? "var(--red)" : "inherit"};">${last.failed || 0}</b></div>
           </div>
           ${last.deferred ? `<div class="xs" style="margin-top:9px;color:var(--amber);">More files remain; the next scan continues where this one stopped.</div>` : ""}
           ${
             last.errors && last.errors.length
               ? `<details style="margin-top:10px;"><summary class="xs">Errors from the last scan</summary>
                  <div class="xs mono" style="margin-top:6px;">${last.errors.map((e) => esc(e)).join("<br>")}</div></details>`
               : ""
           }`
        : ""
    }
    <div class="xs muted" style="margin-top:13px;">Every scan walks the whole folder — Dropbox offers no
      change feed for a shared link — and skips anything already imported at its current revision.
      A retry run also re-attempts files that previously failed or were skipped.
      <a href="#" onclick="runIt(true);return false;">Retry failed files</a>.</div>
  </div>

  <div class="card tight"><table>
    <tr><th>File in Dropbox</th><th>Status</th><th>In the portal</th><th>Last seen</th></tr>${rows}</table></div>

  <script>
  // Both of these call Dropbox and can run for many seconds on a real
  // folder. Without a visible in-flight state the page looks dead, so
  // people click again — and every extra click was firing another walk
  // and stacking another blocking alert on top of the last. The buttons
  // now disable themselves for the duration and report in the page.
  var busy = false;
  function msg(text, tone){
    var el = document.getElementById('syncMsg');
    var c = tone === 'bad' ? ['var(--red)','#FBE9E9'] : tone === 'good' ? ['var(--green)','#E3F1EA'] : ['var(--ink2)','var(--bg)'];
    el.style.color = c[0]; el.style.background = c[1];
    el.textContent = text; el.hidden = false;
  }
  function setBusy(on, label){
    busy = on;
    var t = document.getElementById('btnTest'), r = document.getElementById('btnScan');
    [t,r].forEach(function(b){ if(b){ b.disabled = on; b.style.opacity = on ? '.5' : '1'; b.style.cursor = on ? 'wait' : 'pointer'; } });
    if(on && label) msg(label, 'info');
  }
  // Parse defensively. A proxy timeout or a restart returns an HTML
  // error page, and calling .json() on that throws a SyntaxError that
  // browsers word unhelpfully — Safari says "The string did not match
  // the expected pattern", which tells the reader nothing about what
  // actually happened.
  async function readJson(r){
    const text = await r.text();
    try{ return JSON.parse(text); }
    catch(e){
      throw new Error(
        r.status >= 500 || r.status === 502 || r.status === 504
          ? 'The server did not answer (HTTP ' + r.status + '). It may still be starting up \u2014 wait a moment and reload.'
          : 'Unexpected reply from the server (HTTP ' + r.status + '). ' + text.slice(0,120)
      );
    }
  }
  async function post(url, body){
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j = await readJson(r); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function getJson(url){
    const r = await fetch(url,{headers:{'Accept':'application/json'}});
    return readJson(r);
  }
  function ticker(base){
    var n = 0;
    return setInterval(function(){ n += 1; msg(base + ' (' + n + 's)', 'info'); }, 1000);
  }
  async function checkIt(){
    if(busy) return;
    setBusy(true, 'Contacting Dropbox\u2026');
    var tick = ticker('Contacting Dropbox\u2026');
    try{
      const j = await post('${BASE}/api/sync/check');
      clearInterval(tick);
      if(j.ok){
        msg('Connected to "' + j.folder + '". ' + j.sampled + ' file(s) across ' + (j.folders || 1) +
            ' folder(s)' + (j.truncated ? ', and more beyond the sample' : '') + '.', 'good');
      } else {
        msg('Not connected. ' + j.error, 'bad');
      }
    }catch(e){ clearInterval(tick); msg(e.message, 'bad'); }
    finally{ setBusy(false); }
  }
  // The scan runs detached on the server, so this starts it and then
  // watches /api/sync/status. Nothing here holds an HTTP request open,
  // which is what used to break on a folder large enough to run past
  // Render's request timeout.
  var poller = null;
  async function runIt(full){
    if(busy) return;
    if(full && !confirm('Retry every file that previously failed or was skipped?')) return;
    setBusy(true, 'Starting the scan\u2026');
    try{
      await post('${BASE}/api/sync/run',{full:!!full});
    }catch(e){ msg(e.message, 'bad'); setBusy(false); return; }
    watch();
  }
  function watch(){
    var started = Date.now();
    var misses = 0;
    if(poller) clearInterval(poller);
    poller = setInterval(async function(){
      var secs = Math.round((Date.now() - started)/1000);
      try{
        const s = await getJson('${BASE}/api/sync/status');
        misses = 0;
        var st = s.lastRun || {};
        // A record still saying "running" while this process is not
        // running one belongs to a scan that was killed — a deploy, a
        // restart. Stop watching it rather than counting up for ever.
        if(s.stale){
          clearInterval(poller); poller = null;
          msg('That scan stopped before it finished, almost certainly because the service restarted. ' +
              'Nothing was lost \u2014 run it again and it continues from where it left off.', 'bad');
          setBusy(false); return;
        }
        if(s.running || st.state === 'running'){
          var p = st.progress;
          msg(p
            ? 'Importing\u2026 ' + p.imported + ' imported, ' + p.skipped + ' skipped of ' + p.of + ' files (' + secs + 's)'
            : (st.phase === 'listing'
                ? 'Listing the folder\u2026 one request per subfolder, so a deep tree takes a while (' + secs + 's)'
                : 'Starting\u2026 (' + secs + 's)'), 'info');
          return;
        }
        clearInterval(poller); poller = null;
        var r = st.lastResult || {};
        if(st.state === 'error' || st.state === 'interrupted'){
          msg((st.state === 'interrupted' ? '' : 'Scan failed. ') + (st.error || 'Unknown error'), 'bad');
          setBusy(false); return;
        }
        msg('Scan finished. ' + (r.imported||0) + ' imported, ' + (r.skipped||0) + ' skipped, ' + (r.failed||0) + ' failed' +
            (r.deferred ? '. More files remain \u2014 run it again to continue' : '') + '. Reloading\u2026', 'good');
        setTimeout(function(){ location.reload(); }, 1500);
      }catch(e){
        // A restart or a blip should not end the watch; the scan is
        // running on the server regardless of this page.
        if(++misses >= 10){ clearInterval(poller); poller = null; msg(e.message, 'bad'); setBusy(false); }
        else msg('Scanning\u2026 waiting for the server (' + secs + 's)', 'info');
      }
    }, 2500);
  }
  // If a scan is already running when the page loads, pick up watching it.
  (async function(){
    try{
      const s = await getJson('${BASE}/api/sync/status');
      if(!s.stale && (s.running || (s.lastRun && s.lastRun.state === 'running'))){ setBusy(true, 'Scan in progress\u2026'); watch(); }
    }catch(e){}
  })();
  </script>`;

  return chrome({ title: "Dropbox", body, user, active: "sync", wide: true });
}

// ── Upload ──────────────────────────────────────────────────
function uploadPage({ engagements }, user) {
  const catOptions = tax.CATEGORIES.map((c) => `<option value="${c.code}">${esc(c.code)} — ${esc(c.label)}</option>`).join("");
  const engOptions = engagements
    .map(
      (e) =>
        `<option value="${e.id}">${esc(e.period_label)} — ${esc(e.tier)}${
          e.filing_form ? ` (${esc(e.filing_form)})` : ""
        }</option>`
    )
    .join("");
  const body = `
  <h1>Upload documents</h1>
  <div class="sub">Drop files in. The portal reads each one, decides what it is, files it in the right folder,
    ticks the checklist item and tells the auditor what arrived — you do not need to choose anything.</div>

  <div class="card">
    <label>Which period is this for?</label>
    <select id="engagementId" style="max-width:480px;">
      <option value="">Work it out from the document (default)</option>
      ${engOptions}
    </select>
    <div class="xs muted" style="margin-top:5px;">
      Worth setting when you are sending a whole package at once. A document dated 30 September belongs
      equally to the September monthly close and to the Q1 interim review, and nothing in the file itself
      says which — so if you are assembling the quarterly package, say so here and everything lands together.
    </div>

    <div id="drop" style="margin-top:15px;border:2px dashed #C3CCD6;border-radius:9px;padding:36px;text-align:center;background:#FAFCFD;cursor:pointer;">
      <div style="font-size:15px;font-weight:600;">Drop files here, or click to choose</div>
      <div class="sm muted" style="margin-top:5px;">PDF, Excel, Word, CSV, images · up to 50 MB each · 25 at a time</div>
      <input type="file" id="files" multiple style="display:none;">
    </div>

    <details style="margin-top:14px;"><summary>Override the automatic filing (rarely needed)</summary>
      <div class="grid g2" style="margin-top:9px;">
        <div><label>Force a category</label>
          <select id="category"><option value="">Let the portal decide</option>${catOptions}</select></div>
        <div><label>Force a period (as-of date)</label><input type="date" id="periodHint"></div>
      </div>
      <label>Reason, if the engagement is already archived (AS 1215.16 requires one)</label>
      <input type="text" id="additionReason" placeholder="e.g. Lender confirmation received after the documentation completion date">
    </details>

    <div id="out" style="margin-top:16px;"></div>
  </div>

  <div class="note blue"><b>What happens next.</b> Each file is hashed, versioned and stored. If the same
    bytes are already on record the upload is refused as a duplicate rather than creating a meaningless new
    version; if the content differs, it becomes v2 and the earlier version is retained, not overwritten —
    AS 1215.06 requires an experienced auditor with no prior connection to the engagement to be able to
    reconstruct what the auditor saw and when. The TAAD engagement team is notified immediately with a short
    description of what arrived.</div>

  <script>
  const drop=document.getElementById('drop'), input=document.getElementById('files'), out=document.getElementById('out');
  drop.onclick=()=>input.click();
  drop.ondragover=e=>{e.preventDefault();drop.style.background='#EEF5FB';drop.style.borderColor='#2C5F8A';};
  drop.ondragleave=()=>{drop.style.background='#FAFCFD';drop.style.borderColor='#C3CCD6';};
  drop.ondrop=e=>{e.preventDefault();drop.style.background='#FAFCFD';drop.style.borderColor='#C3CCD6';send(e.dataTransfer.files);};
  input.onchange=()=>send(input.files);

  async function send(files){
    if(!files||!files.length) return;
    const fd=new FormData();
    for(const f of files) fd.append('files',f);
    const eng=document.getElementById('engagementId').value; if(eng) fd.append('engagementId',eng);
    const cat=document.getElementById('category').value; if(cat) fd.append('category',cat);
    const ph=document.getElementById('periodHint').value; if(ph) fd.append('periodHint',ph);
    const ar=document.getElementById('additionReason').value; if(ar) fd.append('additionReason',ar);
    out.innerHTML='<div class="sm muted">Reading and classifying '+files.length+' file'+(files.length===1?'':'s')+'…</div>';
    try{
      const r=await fetch('${BASE}/api/upload',{method:'POST',body:fd});
      const j=await r.json();
      if(!j.ok){ out.innerHTML='<div class="note red">'+(j.error||'Upload failed')+'</div>'; return; }
      out.innerHTML=j.results.map(render).join('');
    }catch(e){ out.innerHTML='<div class="note red">'+e.message+'</div>'; }
  }

  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
  function render(r){
    if(!r.ok) return '<div class="note red"><b>'+esc(r.filename)+'</b> — '+esc(r.error)+'</div>';
    if(r.duplicate) return '<div class="note amber"><b>'+esc(r.filename)+'</b> — '+esc(r.message)+'</div>';
    const flags=(r.flags||[]).map(f=>'<span class="flag">'+esc(f.replace(/_/g,' '))+'</span>').join('');
    return '<div class="note green"><b>'+esc(r.filename)+'</b> → <code>'+esc(r.category||'?')+'</code> '+
      esc(r.categoryLabel||'')+(r.version>1?' <b>(v'+r.version+')</b>':'')+
      '<div class="sm" style="margin-top:5px;">'+esc(r.brief||'')+'</div>'+
      '<div class="xs muted" style="margin-top:5px;">Filed to <span class="mono">'+esc(r.folderPath||'')+'</span></div>'+
      '<div class="xs muted">'+r.confidence+'% confidence via '+esc(r.method||'')+
      (r.needsConfirmation?' · <b style="color:#B45309;">flagged for confirmation</b>':'')+'</div>'+
      (r.satisfied&&r.satisfied.length?'<div class="xs" style="margin-top:4px;color:#1C7C54;font-weight:600;">Ticked off: '+r.satisfied.map(esc).join('; ')+'</div>':'')+
      (flags?'<div style="margin-top:5px;">'+flags+'</div>':'')+
      '<div class="xs" style="margin-top:6px;"><a href="${BASE}/document/'+r.documentId+'">Open document →</a></div></div>';
  }
  </script>`;
  return chrome({ title: "Upload", body, user, active: "upload" });
}

// ── Taxonomy reference ──────────────────────────────────────
function taxonomyPage(user) {
  const sections = tax.BRACKETS.map((b) => {
    const cats = tax.categoriesForBracket(b.code);
    const rows = cats
      .map(
        (c) => `<tr>
      <td style="white-space:nowrap;"><code>${esc(c.code)}</code>${c.gate ? " " + pill("GATE", "#991B1B") : ""}${c.conf ? " " + pill("RESTRICTED", "#6B21A8") : ""}</td>
      <td><b>${esc(c.label)}</b>
        ${c.note ? `<details><summary>What the auditor does with it</summary><div class="sm" style="color:var(--ink2);">${esc(c.note)}</div></details>` : ""}</td>
      <td class="xs">${c.tiers.map((t) => pill(t, "#2C5F8A")).join(" ")}</td>
      <td class="xs muted">${esc((c.authority || []).join(", "))}</td></tr>`
      )
      .join("");
    return `<div class="card tight">
      <div style="padding:13px 18px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;">
        <span class="brk" style="background:${b.color};margin-top:2px;">${esc(b.code)}</span>
        <div><b>${esc(b.label)}</b> <span class="xs muted">· ${cats.length} categories</span>
          <div class="sm muted" style="margin-top:4px;">${esc(b.blurb)}</div></div></div>
      <table><tr><th>Ref</th><th>Document</th><th>Checklists</th><th>Authority</th></tr>${rows}</table></div>`;
  }).join("");

  const s = tax.STATS;
  const body = `
  <h1>Document index</h1>
  <div class="sub">${s.categories} document categories in ${s.brackets} sections · ${s.gates} are gating items ·
    this index is what the classifier routes against and what the checklists are generated from</div>

  <div class="grid g4" style="margin-bottom:16px;">
    <div class="stat"><div class="n">${s.monthly}</div><div class="l">Monthly close</div></div>
    <div class="stat"><div class="n">${s.quarterly}</div><div class="l">Quarterly review</div></div>
    <div class="stat"><div class="n">${s.annual}</div><div class="l">Annual audit</div></div>
    <div class="stat"><div class="n">${s.event}</div><div class="l">Event-driven</div></div>
  </div>

  <div class="note blue"><b>How to read this.</b> Every category carries the PCAOB or SEC provision that makes
    the document necessary, so neither side has to argue about whether an item belongs on the list. A
    <b>gating</b> item is one where a standard or rule prevents the report or filing from issuing without it —
    the AS 4105 quarterly representation letter, the AS 2505 legal letters, the AS 2805 annual representation
    letter. A <b>restricted</b> item carries privilege or personal data and is limited to lead roles.</div>

  ${sections}`;
  return chrome({ title: "Document index", body, user, active: "taxonomy", wide: true });
}

// ── Calendar ────────────────────────────────────────────────
function calendarPage({ fiscalYear, engagements }, user) {
  const plan = checklists.buildFiscalYearPlan(fiscalYear);
  const byLabel = {};
  engagements.forEach((e) => (byLabel[e.period_label] = e));

  const rows = plan
    .map((p) => {
      const existing = byLabel[p.periodLabel];
      const dl = p.filingDeadline;
      const n = dl ? daysUntil(dl.dueDate) : null;
      return `<tr>
      <td><b>${esc(p.periodLabel)}</b><div class="xs muted">${esc(p.periodName)}</div></td>
      <td>${pill(p.tier, p.tier === "annual" ? "#991B1B" : p.tier === "quarterly" ? "#2C5F8A" : "#6B7684")}</td>
      <td class="sm">${dl ? esc(dl.form) : "—"}</td>
      <td class="sm">${dl ? fmtDate(dl.dueDate) : "—"}${n !== null && n >= 0 ? `<div class="xs muted">in ${n}d</div>` : ""}</td>
      <td class="sm muted">${dl ? fmtDate(dl.ntDueBy) : "—"}</td>
      <td class="right sm">${p.counts.documents} + ${p.counts.sweeps}</td>
      <td class="right sm" style="color:var(--red);">${p.counts.gates}</td>
      <td>${
        existing
          ? `<a class="btn sm ghost" href="${BASE}/engagement/${existing.id}">Open</a>`
          : auth.can(user, "engagement.create")
          ? `<button class="btn sm" onclick="openEng('${p.tier}',${fiscalYear},${p.quarter || p.fiscalMonth || "null"})">Create</button>`
          : `<span class="xs muted">not created</span>`
      }</td></tr>`;
    })
    .join("");

  const fsd = cal.filerStatusMeasurementDate(fiscalYear);
  const body = `
  <div class="between"><div>
    <h1>Fiscal calendar — FY${fiscalYear}</h1>
    <div class="sub">July 1, ${fiscalYear - 1} through June 30, ${fiscalYear} · non-accelerated filer
      (10-K 90 days, 10-Q 45 days) · dates rolled forward per Rule 0-3</div></div>
    <div class="row">
      <a class="btn ghost sm" href="${BASE}/calendar?fy=${fiscalYear - 1}">← FY${fiscalYear - 1}</a>
      <a class="btn ghost sm" href="${BASE}/calendar?fy=${fiscalYear + 1}">FY${fiscalYear + 1} →</a>
      ${auth.can(user, "engagement.create") ? `<button class="btn" onclick="seedYear(${fiscalYear})">Create all periods</button>` : ""}
    </div></div>

  <div class="card tight"><table>
    <tr><th>Period</th><th>Tier</th><th>Form</th><th>Filing due</th><th>12b-25 by</th>
      <th class="right">Items</th><th class="right">Gates</th><th></th></tr>${rows}</table></div>

  <div class="grid g3">
    <div class="card"><h2>Filer status measurement</h2>
      <div class="sm">Public float is measured on <b>${fmtDate(fsd.date)}</b> — the last business day of the
        second fiscal quarter — and determines accelerated-filer status for FY${fiscalYear}.</div>
      <div class="note blue" style="margin-top:10px;">${esc(fsd.note)}</div></div>
    <div class="card"><h2>Registration statement bring-down</h2>
      <div class="sm">Section 11 liability attaches at <b>effectiveness</b>, not at the audit report date, so AS 4101
        requires the auditor to extend subsequent-events procedures through effectiveness and to repeat them at
        <b>each amendment</b>: read the prospectus, review the latest interim information, inquire of management,
        read minutes, and obtain an updated legal letter and updated management representations.</div>
      <div class="note amber" style="margin-top:10px;">Consents must be <b>currently dated</b> at each amendment.
        While Fruci's reports still cover FY2024–FY2025 in the registration statement, <b>two</b> are needed — one
        from TAAD and one from Fruci. Reg S-X 8-08 also makes financial statements older than 135 days at
        effectiveness stale. Those two are the most common causes of S-1 delay.</div>
      ${
        auth.can(user, "engagement.create")
          ? `<div style="margin-top:12px;">
               <label>Open a bring-down checklist for an amendment</label>
               <div class="row">
                 <input type="text" id="s1label" placeholder="e.g. Amendment No. 2" style="max-width:240px;">
                 <button class="btn sm" onclick="openS1(${fiscalYear})">Create</button>
               </div>
               <div class="xs muted" style="margin-top:5px;">15 document items, 7 of them gating, plus the
                 subsequent-events and auditor-consultation sweeps.</div>
             </div>`
          : ""
      }
    </div>
    <div class="card"><h2>Event engagements</h2>
      <div class="note">An acquisition, disposition, auditor change or non-reliance determination is not a
        period, so it gets its own engagement keyed to the date it happened. Two clocks start that day:
        the initial <b>Form 8-K within four business days</b> (Gen. Instr. B.1), and, if the Rule 3-05/8-04
        significance test clears 20%, <b>audited financial statements of the acquired business within 71
        calendar days</b> of that 8-K due date (Item 9.01(a)(4)). Run the significance test at signing —
        a target audit cannot be produced in 71 days if it is commissioned on day 60, which is how the
        Victorville Item 9.01 amendment came to be filed roughly two and a half months late.</div>
      ${
        auth.can(user, "engagement.create")
          ? `<div style="margin-top:12px;">
               <label>Open an engagement for a transaction</label>
               <div class="row">
                 <input type="text" id="evtlabel" placeholder="e.g. Jiun Jiang share exchange" style="max-width:260px;">
                 <input type="date" id="evtdate" style="max-width:170px;">
                 <button class="btn sm" onclick="openEvent(${fiscalYear})">Create</button>
               </div>
               <div class="xs muted" style="margin-top:5px;">37 document items, 7 of them gating. The date is
                 the day the event occurred, not the day you are filing it.</div>
             </div>`
          : ""
      }
    </div>
    <div class="card"><h2>Late-filing history</h2>
      <div class="note amber">EDGAR shows Form 12b-25 filings for FYE 6/30/2025 (10-K) and for Q1 and Q3 of
        FY2026, and the Q2 FY2026 10-Q appears to have been filed after its due date with no NT on file.
        Rule 12b-25 requires the notification within <b>one business day</b> of the due date, the reasons in
        reasonable detail, and — where the delay is the auditor's — a <b>signed statement from the auditor</b>.
        Nasdaq Rule 5250(c) makes timely filing a continued-listing condition, so this pattern needs to be
        closed out before a listing application rather than after.</div></div>
  </div>

  <script>
  async function post(url, body){
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function openEng(tier, fy, n){
    try{ const j = await post('${BASE}/api/engagement/open',{tier:tier,fiscalYear:fy,n:n}); location.href='${BASE}/engagement/'+j.engagement.id; }
    catch(e){ alert(e.message); }
  }
  async function openS1(fy){
    const label = (document.getElementById('s1label').value || '').trim();
    if(!label) return alert('Name the amendment, e.g. "Amendment No. 2" or "Initial S-1".');
    try{ const j = await post('${BASE}/api/engagement/open',{tier:'s1',fiscalYear:fy,n:label});
      location.href='${BASE}/engagement/'+j.engagement.id; }
    catch(e){ alert(e.message); }
  }
  async function openEvent(fy){
    const label = (document.getElementById('evtlabel').value || '').trim();
    const eventDate = (document.getElementById('evtdate').value || '').trim();
    if(!label) return alert('Name the transaction, e.g. "Jiun Jiang share exchange".');
    if(!eventDate) return alert('Enter the date the event occurred — both the 8-K and the 71-day amendment clock run from it.');
    try{ const j = await post('${BASE}/api/engagement/open',{tier:'event',fiscalYear:fy,n:{label:label,eventDate:eventDate}});
      location.href='${BASE}/engagement/'+j.engagement.id; }
    catch(e){ alert(e.message); }
  }
  async function seedYear(fy){
    if(!confirm('Create every monthly, quarterly and annual engagement for FY'+fy+', each with its full checklist?')) return;
    try{ const j = await post('${BASE}/api/engagement/seed-year',{fiscalYear:fy});
      alert('Created or confirmed '+j.engagements.length+' periods.'); location.reload(); }
    catch(e){ alert(e.message); }
  }
  </script>`;

  return chrome({ title: `FY${fiscalYear} calendar`, body, user, active: "calendar", wide: true });
}

// ── Users ───────────────────────────────────────────────────
function usersPage({ users }, user) {
  const roleOptions = Object.entries(auth.ROLES)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
    .join("");
  const rows = users
    .map(
      (u) => `<tr>
    <td><b>${esc(u.name)}</b><div class="xs muted">${esc(u.email)}</div></td>
    <td>${pill(auth.ROLES[u.role] ? auth.ROLES[u.role].label : u.role, auth.ROLES[u.role] ? auth.ROLES[u.role].color : "#667")}</td>
    <td class="sm">${esc(u.firm_name || "—")}</td>
    <td class="sm muted">${esc(u.org)}</td>
    <td class="sm muted">${u.last_login ? fmtDateTime(u.last_login) : "never"}</td>
    <td>${u.active ? pill("Active", "#1C7C54") : pill("Inactive", "#667")}${u.must_reset ? " " + pill("No password set", "#B45309") : ""}</td>
    <td style="white-space:nowrap;">
      <button class="btn sm ghost" onclick="setPw(${u.id})">Set password</button>
      ${u.id !== user.id ? `<button class="btn sm ghost" onclick="deact(${u.id})">Deactivate</button>` : ""}</td></tr>`
    )
    .join("");

  const roleHelp = Object.entries(auth.ROLES)
    .map(
      ([k, v]) => `<tr><td style="white-space:nowrap;">${pill(v.label, v.color)}</td>
      <td class="sm">${esc(v.description)}</td></tr>`
    )
    .join("");

  const body = `
  <h1>Users</h1>
  <div class="sub">Company personnel, the TAAD engagement team, and audit committee members</div>

  <div class="note purple"><b>The independence boundary is structural, not a setting.</b> Auditor accounts can
    download every document and raise review notes, but the permission matrix gives them no route to upload a
    document or answer a sweep question — SEC Rule 2-01(c)(4) treats bookkeeping and management functions as
    impairing independence, so the portal is built so it cannot become an independence problem.</div>

  <div class="card tight"><table>
    <tr><th>User</th><th>Role</th><th>Firm</th><th>Side</th><th>Last sign-in</th><th>Status</th><th></th></tr>${rows}</table></div>

  <div class="card"><h2>Add a user</h2>
    <div class="grid g2">
      <div><label>Full name</label><input type="text" id="n-name"></div>
      <div><label>Email</label><input type="email" id="n-email"></div>
      <div><label>Role</label><select id="n-role">${roleOptions}</select></div>
      <div><label>Firm (auditors)</label><input type="text" id="n-firm" placeholder="TAAD, LLP"></div>
      <div><label>Title</label><input type="text" id="n-title"></div>
      <div><label>Initial password (10+ characters)</label><input type="text" id="n-pw"></div>
    </div>
    <button class="btn" style="margin-top:13px;" onclick="addUser()">Create user</button></div>

  <div class="card tight"><div style="padding:14px 18px 0;"><h2>What each role can do</h2></div>
    <table>${roleHelp}</table></div>

  <script>
  async function post(url, body){
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j = await r.json(); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function addUser(){
    const b={name:v('n-name'),email:v('n-email'),role:v('n-role'),firmName:v('n-firm'),title:v('n-title'),password:v('n-pw')};
    if(!b.name||!b.email) return alert('Name and email are required.');
    if(b.password && b.password.length<10) return alert('Use at least 10 characters.');
    try{ await post('${BASE}/api/users',b); location.reload(); }catch(e){ alert(e.message); }
  }
  function v(id){ return document.getElementById(id).value.trim(); }
  async function setPw(id){
    const p = prompt('New password (10 characters minimum):');
    if(!p) return;
    try{ await post('${BASE}/api/users/'+id+'/password',{password:p}); alert('Password set.'); }catch(e){ alert(e.message); }
  }
  async function deact(id){
    if(!confirm('Deactivate this user? They will lose access immediately.')) return;
    try{ await post('${BASE}/api/users/'+id+'/deactivate'); location.reload(); }catch(e){ alert(e.message); }
  }
  </script>`;

  return chrome({ title: "Users", body, user, active: "users", wide: true });
}

module.exports = {
  chrome,
  esc,
  loginPage,
  setupPage,
  errorPage,
  dashboardPage,
  engagementPage,
  checklistPage,
  documentPage,
  documentsPage,
  triagePage,
  syncPage,
  uploadPage,
  taxonomyPage,
  calendarPage,
  usersPage,
};
