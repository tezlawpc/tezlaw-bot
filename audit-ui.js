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
const issuer = require("./audit-issuer");

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
  return Math.round((cal.parse(s) - cal.parse(cal.today())) / 86400000);
}

function pill(text, color, bg) {
  return `<span class="pill" style="color:${color};background:${bg || color + "18"};border-color:${color}44;">${esc(text)}</span>`;
}

const MONTHS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * The masthead, read from the issuer profile rather than hardcoded.
 *
 * It used to say "Nightfood Holdings, Inc. · NGTF · CIK 0001593001 · FYE
 * June 30" in the markup. That is a property of one registrant, not of
 * the software, and leaving it there would have made the profile page a
 * form that changes nothing visible — which is how a settings screen
 * comes to be quietly wrong.
 */
function masthead() {
  const p = issuer.current();
  const bits = [];
  if (p.ticker) bits.push(p.ticker);
  if (p.cik) bits.push(`CIK ${p.cik}`);
  bits.push("PCAOB Audit Portal");
  if (p.fiscalYearEndMonth && p.fiscalYearEndDay) {
    bits.push(`FYE ${MONTHS[p.fiscalYearEndMonth]} ${p.fiscalYearEndDay}`);
  }
  return { name: p.name || "Audit Portal", line: bits.join(" · "), configured: !!p.name };
}

/**
 * How much a date can be relied on. NULL means an ordinary taxonomy item
 * whose date comes from a rule the portal implements, so it gets no
 * badge at all: the badge means something only if most rows do not
 * carry one.
 */
function confidencePill(conf) {
  if (!conf || conf === "computed") return "";
  if (conf === "approximate") return pill("APPROXIMATE", "#B45309");
  return pill("UNVERIFIED", "#9C4221");
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
  { key: "report-event", href: `${BASE}/report-event`, label: "Report something", perm: "dashboard.view" },
  { key: "events", href: `${BASE}/events`, label: "Event register", perm: "dashboard.view" },
  { key: "upload", href: `${BASE}/upload`, label: "Upload", perm: "document.upload" },
  { key: "transmittals", href: `${BASE}/transmittals`, label: "Deliveries", perm: "delivery.view" },
  { key: "subledgers", href: `${BASE}/subledgers`, label: "AR / AP", perm: "subledger.view" },
  { key: "documents", href: `${BASE}/documents`, label: "Documents", perm: "document.view_all" },
  { key: "triage", href: `${BASE}/triage`, label: "Triage", perm: "document.view_all" },
  { key: "calendar", href: `${BASE}/calendar`, label: "Calendar", perm: "dashboard.view" },
  { key: "playbooks", href: `${BASE}/playbooks`, label: "Corporate actions", perm: "dashboard.view" },
  { key: "taxonomy", href: `${BASE}/taxonomy`, label: "Document index", perm: "dashboard.view" },
  { key: "profile", href: `${BASE}/profile`, label: "Issuer profile", perm: "dashboard.view" },
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
  const mast = masthead();

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(mast.configured ? mast.name : "Audit Portal")}</title>
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
  /* A delivery receipt gets printed and attached to a letter, so the
     printed page has to be the evidence and nothing else: no navigation,
     no buttons, no forms, and hashes that do not run off the paper. */
  @media print{
    header.top nav.tabs,.noprint,.btn,form.noprint{display:none!important}
    header.top{background:#fff!important;color:#000!important;padding:0 0 10px;border-bottom:2px solid #000}
    header.top .who{color:#000!important}
    body{background:#fff}
    main{max-width:none;padding:0}
    .card{border:1px solid #999;break-inside:avoid;page-break-inside:avoid;margin-bottom:10px}
    .mono,code{word-break:break-all;white-space:pre-wrap}
    a{color:#000;text-decoration:none}
    .printonly{display:block!important}
  }
  .printonly{display:none}
</style>
</head><body>
<header class="top">
  <div class="brandrow">
    <div class="brand">${esc(mast.name)}
      <small>${esc(mast.line)}</small></div>
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
<script src="/print-view.js"></script></body></html>`;
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

  // The reporting posture used to be a sentence typed into this page. It
  // is now derived, so it cannot say "not an EGC" about a registrant
  // whose profile says otherwise.
  const prof = issuer.current();
  const der = issuer.derive(prof);
  const posture = [
    der.filerStatusLabel.toLowerCase(),
    der.scaledDisclosure ? "smaller reporting company" : "not a smaller reporting company",
    der.camsApply
      ? "not an EGC, so AS 3101 critical audit matters apply"
      : "emerging growth company, so the auditor's report omits critical audit matters",
    der.icfrAttestation
      ? "SOX 404(b) auditor attestation applies"
      : "no SOX 404(b) auditor attestation required",
  ].join(" · ");

  const body = `
  <div class="between"><div>
    <h1>Audit dashboard</h1>
    <div class="sub">${esc(posture)}</div>
  </div>${auth.can(user, "document.upload") ? `<a class="btn" href="${BASE}/upload">Upload documents</a>` : ""}</div>
  ${
    !prof.name
      ? `<div class="note red"><b>No issuer profile has been set, so this portal is computing every period
         from a December 31 fiscal year end.</b> That is a default, not a determination about this registrant.
         Until the profile is filled in, period labels, quarter ends and filing deadlines are very likely wrong,
         and engagements opened now will keep the wrong dates even after the profile is corrected.
         <a href="${BASE}/profile">Set the issuer profile</a> before opening any period.</div>`
      : ""
  }
  ${stats}
  ${deliveryStrip(d.delivery, user)}
  ${subledgerStrip(d.subledger, user)}
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
          <td style="white-space:nowrap;">${i.is_gate ? pill("GATE", "#991B1B") + " " : ""}<code>${esc(i.playbook_step_id || i.category_code || "")}</code></td>
          <td>${esc(i.label)}
            ${i.spawned_from_item ? `<div class="xs" style="color:var(--navy2);">Added by a YES sweep answer</div>` : ""}
            ${
              i.playbook_key
                ? `<div class="xs" style="color:var(--navy2);">From the ${esc(i.playbook_key.replace(/_/g, " "))} playbook${
                    i.anchor_date ? `, measured from ${fmtDate(i.anchor_date)}` : ""
                  }</div>`
                : ""
            }
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
          <td class="sm" style="white-space:nowrap;color:${late ? "var(--red)" : "var(--mute)"};font-weight:${late ? 600 : 400};">${fmtDate(i.due_date)}
            ${i.date_confidence && i.date_confidence !== "computed" ? `<div style="margin-top:3px;">${confidencePill(i.date_confidence)}</div>` : ""}</td>
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
  // The index deliberately shows EVERY category, including ones whose
  // industry module is switched off, because it is a reference work: a
  // filtered index would understate the taxonomy and give no way to see
  // what turning a module on would add. Inactive ones are labelled.
  const active = tax.activeModules();
  const sections = tax.BRACKETS.map((b) => {
    const cats = tax.categoriesForBracket(b.code);
    const rows = cats
      .map(
        (c) => `<tr${active.includes(tax.moduleOf(c)) ? "" : ' style="opacity:.6;"'}>
      <td style="white-space:nowrap;"><code>${esc(c.code)}</code>${c.gate ? " " + pill("GATE", "#991B1B") : ""}${c.conf ? " " + pill("RESTRICTED", "#6B21A8") : ""}</td>
      <td><b>${esc(c.label)}</b>
        ${
          tax.moduleOf(c) === "core"
            ? ""
            : active.includes(tax.moduleOf(c))
            ? " " + pill(tax.INDUSTRY_MODULES[tax.moduleOf(c)].label, "#1C7C54")
            : " " + pill("module off — not requested", "#667")
        }
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
  const live = tax.liveStats();
  const body = `
  <h1>Document index</h1>
  <div class="sub">${s.categories} document categories in ${s.brackets} sections · ${s.gates} are gating items ·
    ${live.categories} active for this issuer's industry ·
    this index is what the classifier routes against and what the checklists are generated from</div>

  <div class="note amber"><b>${live.categories} of ${s.categories} categories are active.</b>
    The rest belong to industry modules this issuer has not selected, and are shown greyed out. They are
    still routed by the classifier, so a document that genuinely belongs to one is filed correctly rather
    than forced into the wrong category; they simply are not requested on a checklist. Change the selection
    on the <a href="${BASE}/profile">issuer profile</a>.</div>

  <div class="grid g4" style="margin-bottom:16px;">
    <div class="stat"><div class="n">${live.monthly}</div><div class="l">Monthly close</div>
      <div class="x">of ${s.monthly} in the full index</div></div>
    <div class="stat"><div class="n">${live.quarterly}</div><div class="l">Quarterly review</div>
      <div class="x">of ${s.quarterly}</div></div>
    <div class="stat"><div class="n">${live.annual}</div><div class="l">Annual audit</div>
      <div class="x">of ${s.annual}</div></div>
    <div class="stat"><div class="n">${live.event}</div><div class="l">Event-driven</div>
      <div class="x">of ${s.event}</div></div>
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
// ── Issuer profile ──────────────────────────────────────────
//
// The page that makes the rest of the portal general. Every filing
// deadline, every period label and every applicable-rule conclusion
// below is computed from these fields rather than written into code, so
// this form is the difference between a portal built for one registrant
// and a portal that can be pointed at another one.
function profilePage({ profile: p, derived, warnings = [], stats = null }, user) {
  const canEdit = auth.can(user, "portal.settings");
  const d = derived || issuer.derive(p);
  const issuer_modules = tax.INDUSTRY_MODULES;

  const opt = (v, cur, label) =>
    `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(label)}</option>`;

  const monthOpts = MONTHS.slice(1)
    .map((m, i) => opt(i + 1, p.fiscalYearEndMonth, m))
    .join("");
  const dayOpts = Array.from({ length: 31 }, (_, i) => opt(i + 1, p.fiscalYearEndDay, String(i + 1))).join("");
  const filerOpts = Object.entries(issuer.FILER_STATUSES)
    .map(([k, v]) => opt(k, p.filerStatus, `${v.label} — ${v.annualDays}/${v.quarterlyDays} days`))
    .join("");
  const exchangeOpts = Object.entries(issuer.EXCHANGES)
    .map(([k, v]) => opt(k, p.exchange, v.label))
    .join("");

  const check = (id, val, label, help) => `
    <label style="display:flex;gap:9px;align-items:flex-start;margin:13px 0 0;font-weight:400;">
      <input type="checkbox" id="${id}" ${val ? "checked" : ""} ${canEdit ? "" : "disabled"}
        style="width:auto;margin-top:2px;flex:0 0 auto;">
      <span><b style="font-size:12px;">${esc(label)}</b>
        <div class="xs muted" style="margin-top:2px;">${help}</div></span></label>`;

  // What the profile implies, each with the authority it rests on. This
  // is the part that is genuinely hard to copy, so it is the part the
  // page puts in front of the reader rather than hiding behind a save.
  const conclusions = d.conclusions
    .map(
      (c) => `<tr>
      <td style="white-space:nowrap;">${
        c.value === true
          ? pill("APPLIES", "#991B1B")
          : c.value === false
          ? pill("DOES NOT APPLY", "#1C7C54")
          : pill(String(c.value).toUpperCase(), "#2C5F8A")
      }</td>
      <td class="sm">${esc(c.why)}</td>
      <td class="xs muted" style="white-space:nowrap;">${esc((c.authority || []).join(" · ")) || "—"}</td></tr>`
    )
    .join("");

  // The periods this fiscal calendar produces. A year end entered wrongly
  // is close to invisible in a form and obvious in a list of dates, so the
  // page shows the dates rather than asking anyone to trust the form.
  const thisFy = cal.fiscalYearOf(new Date());
  let preview = "";
  try {
    const qs = issuer.quarterEndsFor(p, thisFy);
    const start = issuer.fiscalYearStart(p, thisFy);
    const measure = issuer.filerStatusMeasurementDateFor(p, thisFy);
    preview = `
      <div class="card"><h2>What this fiscal calendar produces for FY${thisFy}</h2>
      <div class="sm muted" style="margin-bottom:10px;">Fiscal year ${fmtDate(cal.iso(start))} to
        ${fmtDate(cal.iso(qs[3].end))}. A fiscal year is named for the calendar year in which it ends.</div>
      <table>
        <tr><th>Period</th><th>Ends</th><th>Filing</th><th>Due</th></tr>
        ${qs
          .map((q) => {
            const isFY = q.q === 4;
            const days = isFY ? d.annualDays : d.quarterlyDays;
            const due = cal.addDays(q.end, days);
            return `<tr><td>${isFY ? "Q4 / fiscal year end" : "Q" + q.q}</td>
              <td class="sm">${fmtDate(cal.iso(q.end))}</td>
              <td class="sm">${isFY ? "10-K" : "10-Q"}</td>
              <td class="sm">${fmtDate(cal.iso(due))} <span class="xs muted">(${days} days)</span></td></tr>`;
          })
          .join("")}
      </table>
      <div class="note blue" style="margin:12px 16px 14px;">The Rule 12b-2 public float measurement date for
        FY${thisFy} is <b>${fmtDate(cal.iso(measure))}</b>, the last day of the second fiscal quarter. Float
        measured then is what moves a company between filer statuses, and with it the deadlines above.</div>
      </div>`;
  } catch (err) {
    preview = `<div class="note red">This fiscal year end does not produce a valid calendar: ${esc(err.message)}</div>`;
  }

  const warn = warnings.length
    ? `<div class="note amber"><b>Worth a second look.</b><ul style="margin:6px 0 0;padding-left:18px;">
       ${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
    : "";

  const body = `
  <div class="between"><div>
    <h1>Issuer profile</h1>
    <div class="sub">The facts every deadline in this portal is computed from</div></div>
    ${canEdit ? `<button class="btn" onclick="save()" id="saveBtn">Save profile</button>` : ""}</div>

  ${
    !p.name
      ? `<div class="note red"><b>No issuer has been configured.</b> Until the name and fiscal year end are set,
         the portal is computing every period from a December 31 default, which is almost certainly not this
         registrant's year end. Fill this in before opening any engagement.</div>`
      : ""
  }
  ${warn}

  <div class="note blue"><b>Nothing on this page is a determination the software makes.</b> Filer status, smaller
    reporting company status and emerging growth company status are determinations the registrant makes and
    states on its own cover pages. The portal records what was determined and computes from it. If a value here
    disagrees with the most recent 10-K cover page, the cover page is right and this is wrong.</div>

  <div class="card"><h2>Identity</h2>
    <div class="grid g2">
      <div><label>Registrant name</label><input type="text" id="f-name" value="${esc(p.name)}" ${canEdit ? "" : "disabled"}></div>
      <div><label>Ticker</label><input type="text" id="f-ticker" value="${esc(p.ticker)}" ${canEdit ? "" : "disabled"}></div>
      <div><label>CIK</label><input type="text" id="f-cik" value="${esc(p.cik)}" ${canEdit ? "" : "disabled"}></div>
      <div><label>State of incorporation</label><input type="text" id="f-state" value="${esc(p.stateOfIncorporation)}" ${canEdit ? "" : "disabled"}></div>
      <div><label>Principal office</label><input type="text" id="f-office" value="${esc(p.principalOffice)}" ${canEdit ? "" : "disabled"}></div>
      <div><label>Reporting timezone</label><input type="text" id="f-tz" value="${esc(p.timezone)}" ${canEdit ? "" : "disabled"}></div>
    </div></div>

  <div class="card"><h2>Fiscal calendar</h2>
    <div class="sm muted" style="margin-bottom:4px;">Every period label, every quarter end and every filing
      deadline in the portal derives from these two fields. Changing them re-dates future periods; engagements
      already open keep the dates they were created with.</div>
    <div class="grid g2">
      <div><label>Fiscal year end month</label><select id="f-fyem" ${canEdit ? "" : "disabled"}>${monthOpts}</select></div>
      <div><label>Fiscal year end day</label><select id="f-fyed" ${canEdit ? "" : "disabled"}>${dayOpts}</select></div>
    </div>
    <div class="xs muted" style="margin-top:8px;">A 52/53-week fiscal year is not supported. If this registrant
      uses one, the portal will compute period ends a few days out and the dates need checking by hand.</div>
  </div>

  <div class="card"><h2>Reporting posture</h2>
    <div class="grid g2">
      <div><label>Filer status (Exchange Act Rule 12b-2)</label><select id="f-filer" ${canEdit ? "" : "disabled"}>${filerOpts}</select>
        <div class="xs muted" style="margin-top:4px;">Sets the 10-K and 10-Q deadlines for every period.</div></div>
      <div><label>Exchange or quotation venue</label><select id="f-exchange" ${canEdit ? "" : "disabled"}>${exchangeOpts}</select>
        <div class="xs muted" style="margin-top:4px;">Decides whose listing rules bind, and whether they bind at all.</div></div>
    </div>
    ${check("f-src", p.smallerReportingCompany, "Smaller reporting company", "Scaled disclosure, and financial statements under Reg S-X Article 8 rather than Article 3.")}
    ${check("f-egc", p.emergingGrowthCompany, "Emerging growth company", "An EGC's auditor's report omits critical audit matters, and the status expires — normally five years from the first registered sale.")}
    ${check("f-icfr", p.icfrAuditorAttestation, "Auditor attestation on ICFR is obtained", "Section 404(b). Not required of a non-accelerated filer, and not of an EGC at all. Management's own 404(a) report is required either way.")}
    ${check("f-gc", p.goingConcernDoubt, "Substantial doubt about going concern", "Drives the ASC 205-40 evaluation, the disclosure and the emphasis paragraph in the auditor's report.")}
    ${check("f-reporting", p.reportingCompany !== false, "Files reports under the Exchange Act", "10-K, 10-Q and 8-K. Turn this off only for a company that does not report at all.")}
    ${check("f-s12", p.section12Registered, "Registered under Section 12 of the Exchange Act", "A separate fact from being listed and from filing reports, and it is the gate on Section 16 and Schedule 13D. A company that registered an offering on Form S-1 and never filed a Form 8-A reports under Section 15(d) only: it files 10-Ks, 10-Qs and 8-Ks, but its insiders file NO Forms 3, 4 or 5 and its 5% holders file no Schedule 13D. If this is wrong, the event register will either invent obligations that do not exist or miss ones that do.")}
    <div class="grid g2" style="margin-top:14px;">
      <div><label>EGC first registered sale date</label><input type="date" id="f-egcdate" value="${esc(p.egcFirstSaleDate || "")}" ${canEdit ? "" : "disabled"}>
        <div class="xs muted" style="margin-top:4px;">Leave blank if not an EGC. Used to warn before the status lapses.</div></div>
    </div>
  </div>

  <div class="card"><h2>Industry</h2>
    <div class="sm muted" style="margin-bottom:4px;">The core categories bind every reporting company.
      Industry modules add the categories that only matter for a particular business, and they are the
      reason this portal can be pointed at a second issuer without editing code.</div>
    <div class="grid g2">
      <div><label>SIC code</label><input type="text" id="f-sic" value="${esc(p.sic || "")}" placeholder="2000" ${canEdit ? "" : "disabled"}>
        <div class="xs muted" style="margin-top:4px;">As filed on the cover page. Used only to suggest
          modules below, never to switch them on by itself.</div></div>
    </div>
    <div style="margin-top:14px;">
      ${Object.values(issuer_modules)
        .filter((m) => !m.always)
        .map((m) => {
          const on = (p.industryModules || []).includes(m.key);
          const suggested = (derived.suggestedModules || []).includes(m.key);
          return `<label style="display:flex;gap:9px;align-items:flex-start;margin:13px 0 0;font-weight:400;">
            <input type="checkbox" class="mod" value="${esc(m.key)}" ${on ? "checked" : ""} ${canEdit ? "" : "disabled"}
              style="width:auto;margin-top:2px;flex:0 0 auto;">
            <span><b style="font-size:12px;">${esc(m.label)}</b>
              ${suggested ? " " + pill("SUGGESTED BY SIC", "#B45309") : ""}
              <div class="xs muted" style="margin-top:2px;">${esc(m.blurb)}</div></span></label>`;
        })
        .join("")}
    </div>
    ${
      stats
        ? `<div class="note blue" style="margin-top:14px;"><b>With these modules, a checklist draws on
           ${stats.categories} of ${tax.STATS.categories} categories.</b> ${stats.annual} on an annual
           engagement, ${stats.quarterly} on a quarterly one, ${stats.monthly} on a monthly close.
           Categories belonging to a module that is off stay in the document index and still resolve for
           documents already filed under them; they simply stop being requested.</div>`
        : ""
    }
  </div>

  <div class="card"><h2>Audit</h2>
    <div class="grid g2">
      <div><label>Independent registered public accounting firm</label><input type="text" id="f-auditor" value="${esc(p.auditor)}" ${canEdit ? "" : "disabled"}></div>
      <div><label>Predecessor auditor</label><input type="text" id="f-pred" value="${esc(p.predecessorAuditor)}" ${canEdit ? "" : "disabled"}>
        <div class="xs muted" style="margin-top:4px;">Where a predecessor's reports still cover periods presented, its consent is needed on any registration statement.</div></div>
    </div></div>

  <div class="card tight"><div style="padding:14px 18px 0;"><h2>What this profile implies</h2>
    <div class="sm muted" style="margin-bottom:11px;">Derived on every request, never stored, so these cannot
      drift out of step with the facts above.</div></div>
    <table><tr><th>Conclusion</th><th>Why</th><th>Authority</th></tr>${conclusions}</table></div>

  ${preview}

  ${
    canEdit
      ? `<div class="row"><button class="btn" onclick="save()">Save profile</button>
         <span id="msg" class="sm muted"></span></div>`
      : `<div class="note amber">You can see this profile but not change it. Filer status and fiscal year end
         drive the whole filing calendar, so editing is limited to the portal administrator.</div>`
  }

  <script>
  function v(id){ var e=document.getElementById(id); return e? e.value.trim() : ''; }
  function c(id){ var e=document.getElementById(id); return e? !!e.checked : false; }
  async function save(){
    var btn=document.getElementById('saveBtn'), msg=document.getElementById('msg');
    var body={
      name:v('f-name'), ticker:v('f-ticker'), cik:v('f-cik'),
      stateOfIncorporation:v('f-state'), principalOffice:v('f-office'),
      timezone:v('f-tz')||'America/New_York',
      fiscalYearEndMonth:parseInt(v('f-fyem'),10), fiscalYearEndDay:parseInt(v('f-fyed'),10),
      filerStatus:v('f-filer'), exchange:v('f-exchange'),
      sic:v('f-sic'),
      reportingCompany:c('f-reporting'), section12Registered:c('f-s12'),
      industryModules:Array.prototype.slice.call(document.querySelectorAll('input.mod'))
        .filter(function(x){return x.checked}).map(function(x){return x.value}),
      smallerReportingCompany:c('f-src'), emergingGrowthCompany:c('f-egc'),
      icfrAuditorAttestation:c('f-icfr'), goingConcernDoubt:c('f-gc'),
      egcFirstSaleDate:v('f-egcdate')||null,
      auditor:v('f-auditor'), predecessorAuditor:v('f-pred')
    };
    if(!body.name) return alert('The registrant name is required.');
    if(btn) btn.disabled=true;
    if(msg) msg.textContent='Saving...';
    try{
      var r=await fetch('${BASE}/api/issuer/profile',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      var j=await r.json();
      if(!j.ok) throw new Error(j.error||'Save failed');
      if(j.warnings && j.warnings.length) alert('Saved, with notes:\\n\\n' + j.warnings.join('\\n\\n'));
      location.reload();
    }catch(e){
      if(btn) btn.disabled=false;
      if(msg) msg.textContent='';
      alert(e.message);
    }
  }
  </script>`;

  return chrome({ title: "Issuer profile", body, user, active: "profile" });
}

// ── Corporate actions ───────────────────────────────────────
function playbooksPage({ playbooks, declared, engagements }, user) {
  const canDeclare = auth.can(user, "engagement.create");

  const cards = playbooks
    .map(
      (p) => `<div class="card" style="border-left:3px solid var(--navy2);">
      <div class="between"><div style="flex:1;min-width:260px;">
        <div style="font-weight:650;font-size:14px;">${esc(p.label)}</div>
        <div class="xs muted" style="margin-top:3px;">${p.steps} obligations ·
          ${p.verified} with a checked citation ·
          ${p.needsVerification ? `<b style="color:var(--rust);">${p.needsVerification} still to verify</b>` : "all verified"}</div>
      </div>
      ${canDeclare ? `<button class="btn sm" onclick="pick('${esc(p.key)}')">Declare this action</button>` : ""}</div>
      <div class="sm" style="color:var(--ink2);margin-top:9px;">${esc(p.headline)}</div>
      <div class="xs muted" style="margin-top:8px;">Measured from: ${p.anchors
        .map((a) => esc(a.label.toLowerCase()))
        .join(", ")}</div>
      <div id="form-${esc(p.key)}" style="display:none;margin-top:13px;padding-top:13px;border-top:1px solid var(--line);">
        <div class="grid g2">
          ${p.anchors
            .map(
              (a) => `<div><label>${esc(a.label)}</label>
              <input type="date" id="a-${esc(p.key)}-${esc(a.key)}">
              <div class="xs muted" style="margin-top:3px;">${esc(a.help)} ${a.steps} step${a.steps === 1 ? "" : "s"} measured from it.</div></div>`
            )
            .join("")}
          <div><label>Attach to</label>
            <select id="e-${esc(p.key)}">
              <option value="">A new engagement for this action</option>
              ${engagements
                .map((e) => `<option value="${e.id}">${esc(e.period_name || e.period_label)}</option>`)
                .join("")}
            </select>
            <div class="xs muted" style="margin-top:3px;">A new engagement keeps the action's obligations
              together. Attach to an existing one only if the action belongs to that period's close.</div></div>
        </div>
        <div class="row" style="margin-top:12px;">
          <button class="btn ghost" onclick="preview('${esc(p.key)}')">Preview the dates</button>
          <button class="btn" onclick="declare('${esc(p.key)}')">Create the checklist items</button>
          <span class="sm muted" id="msg-${esc(p.key)}"></span>
        </div>
        <div id="out-${esc(p.key)}"></div>
      </div>
    </div>`
    )
    .join("");

  const declaredRows = declared.length
    ? declared
        .map(
          (a) => `<tr>
        <td><a href="${BASE}/checklist/${a.engagement_id}">${esc(a.period_name || a.period_label)}</a>
          <div class="xs muted">${esc(String(a.playbook_key).replace(/_/g, " "))}</div></td>
        <td class="sm">${fmtDate(a.first_anchor)}</td>
        <td class="sm">${a.steps} obligation${a.steps === 1 ? "" : "s"}${
            a.unverified ? `<div class="xs" style="color:var(--rust);">${a.unverified} unverified</div>` : ""
          }</td>
        <td class="sm">${a.outstanding} open</td>
        <td class="sm">${fmtDate(a.next_due)}</td>
        <td>${statusPill(a.status)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">No corporate action has been declared yet.</td></tr>`;

  const body = `
  <h1>Corporate actions</h1>
  <div class="sub">Declare an action once, and every obligation it drags behind it becomes a dated checklist item</div>

  <div class="note amber"><b>Read the confidence label on every date before you plan around it.</b>
    A step marked <b>UNVERIFIED</b> is believed to apply, but its citation, its trigger or its day count has not
    been checked against the primary source. It is still created, because a reminder to go and check is worth
    more than silence, and it never gates a close. A step marked <b>APPROXIMATE</b> is measured in trading days,
    which are approximated here with the federal business day calendar: the exchanges observe Good Friday and do
    not observe Columbus Day or Veterans Day, so it can be out by a day or two.</div>

  <div class="note blue">This is a working calendar assembled from the rules cited, not legal advice, and it does
    not replace securities counsel. Its purpose is narrower and more specific: to make sure that no obligation in
    a sequence goes unnoticed because it belongs to nobody. The exchange mechanics after a reverse split are the
    usual example. Counsel watches the securities filings, the transfer agent watches the mechanics, the auditor
    watches the financial statements, and the requirement that sits between them is the one that costs months.</div>

  <h2 style="margin-top:20px;">Declared actions</h2>
  <div class="card tight"><table>
    <tr><th>Action</th><th>From</th><th>Obligations</th><th>Outstanding</th><th>Next due</th><th>Status</th></tr>
    ${declaredRows}</table></div>

  <h2 style="margin-top:22px;">Available playbooks</h2>
  ${cards}

  <script>
  var LAST = {};
  function pick(k){
    var f=document.getElementById('form-'+k);
    f.style.display = f.style.display==='none' ? 'block' : 'none';
  }
  function anchorsFor(k){
    var out={}, inputs=document.querySelectorAll('[id^="a-'+k+'-"]');
    for(var i=0;i<inputs.length;i++){
      var key=inputs[i].id.substring(('a-'+k+'-').length);
      if(inputs[i].value) out[key]=inputs[i].value;
    }
    return out;
  }
  function conf(c){
    if(c==='unconfirmed') return '<span class="pill" style="color:#9C4221;background:#9C422118;border-color:#9C422144;">UNVERIFIED</span>';
    if(c==='approximate') return '<span class="pill" style="color:#B45309;background:#B4530918;border-color:#B4530944;">APPROXIMATE</span>';
    return '';
  }
  function escape(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(m){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; }); }
  async function preview(k){
    var msg=document.getElementById('msg-'+k), out=document.getElementById('out-'+k);
    var anchors=anchorsFor(k);
    if(!Object.keys(anchors).length){ return alert('Enter at least one date. Every deadline in the sequence is an offset from the action\\'s own dates.'); }
    msg.textContent='Computing...';
    try{
      var r=await fetch('${BASE}/api/playbooks/preview',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k,anchors:anchors})});
      var j=await r.json();
      if(!j.ok) throw new Error(j.error||'Failed');
      LAST[k]=j.built;
      var rows=j.built.items.map(function(i){
        return '<tr><td style="white-space:nowrap;"><code>'+escape(i.id)+'</code></td>'+
          '<td>'+escape(i.label)+
            (i.note?'<details><summary>Guidance</summary><div class="sm" style="color:var(--ink2);white-space:pre-line;">'+escape(i.note)+'</div></details>':'')+
            '<div class="xs muted">'+escape((i.authority||[]).join(" · "))+'</div></td>'+
          '<td class="sm" style="white-space:nowrap;">'+(i.dueDate||'no fixed date')+
            (conf(i.dateConfidence)?'<div style="margin-top:3px;">'+conf(i.dateConfidence)+'</div>':'')+'</td></tr>';
      }).join('');
      out.innerHTML='<div class="card tight" style="margin-top:12px;"><table>'+
        '<tr><th>Ref</th><th>Obligation</th><th>Due</th></tr>'+rows+'</table></div>'+
        '<div class="xs muted">'+j.built.counts.total+' obligations, '+
        j.built.counts.needsVerification+' of which still need their citation checked. Nothing has been saved yet.</div>';
      msg.textContent='';
    }catch(e){ msg.textContent=''; alert(e.message); }
  }
  async function declare(k){
    var anchors=anchorsFor(k);
    if(!Object.keys(anchors).length){ return alert('Enter at least one date first.'); }
    if(!confirm('This creates real checklist items with real due dates. Unverified steps are included and labelled as unverified. Continue?')) return;
    var msg=document.getElementById('msg-'+k);
    msg.textContent='Creating...';
    var engSel=document.getElementById('e-'+k);
    try{
      var r=await fetch('${BASE}/api/playbooks/declare',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:k,anchors:anchors,engagementId:engSel && engSel.value ? parseInt(engSel.value,10) : null})});
      var j=await r.json();
      if(!j.ok) throw new Error(j.error||'Failed');
      location.href='${BASE}/checklist/'+j.engagementId;
    }catch(e){ msg.textContent=''; alert(e.message); }
  }
  </script>`;

  return chrome({ title: "Corporate actions", body, user, active: "playbooks", wide: true });
}

// ── Operating events ────────────────────────────────────────
//
// The intake is the only page in this portal written for somebody with
// no accounting background, and it is written in their words. A person
// who knew to search for "material definitive agreement" would never
// have needed it. Everything here is phrased as the thing they did.

function obligationCard(o) {
  const color = o.preAct ? "#991B1B" : o.severity === "critical" ? "#991B1B" : o.severity === "high" ? "#B45309" : "#2C5F8A";
  const due = o.dueDate || o.due_date;
  const item = o.item8k || o.item_8k;
  const s3 = o.s3Risk || o.s3_risk;
  const pre = o.preAct || o.pre_act;
  const ver = o.verified;
  return `<div class="card" style="border-left:3px solid ${color};margin-bottom:11px;">
    <div class="between">
      <div style="flex:1;min-width:250px;">
        ${pre ? pill("WAS DUE BEFORE YOU DID IT", "#991B1B") + " " : ""}
        ${item ? pill("Form 8-K Item " + esc(item), "#991B1B") + " " : ""}
        ${o.kind === "decision" ? pill("A DECISION, NOT A FILING", "#6B21A8") + " " : ""}
        ${ver === false ? confidencePill("unconfirmed") + " " : ""}
        <div style="font-weight:650;font-size:13.5px;margin-top:5px;">${esc(o.label)}</div>
        <div class="xs muted" style="margin-top:4px;">${esc((o.authority || []).join(" · "))}</div>
      </div>
      <div class="right" style="white-space:nowrap;">
        <div style="font-weight:700;font-size:15px;color:${color};">${due ? fmtDate(due) : "No fixed date"}</div>
        ${due ? `<div class="xs muted">${(() => { const n = daysUntil(due); return n === null ? "" : n < 0 ? Math.abs(n) + " days past" : n === 0 ? "today" : "in " + n + " days"; })()}</div>` : ""}
        ${o.anchorLabel ? `<div class="xs muted">from ${esc(String(o.anchorLabel).toLowerCase())}</div>` : ""}
      </div>
    </div>
    ${o.consequence ? `<div class="sm" style="color:var(--ink2);margin-top:9px;">${esc(o.consequence)}</div>` : ""}
    ${s3 ? `<div class="note red" style="margin:9px 0 0;"><b>Filing this late also costs Form S-3 eligibility for twelve months.</b>
      Curing it late does not restore it. If the company raises money off a shelf or an at-the-market facility,
      a four-day miss here shuts that down for a year.</div>` : ""}
    ${o.note ? `<details style="margin-top:7px;"><summary>More detail</summary><div class="sm" style="color:var(--ink2);white-space:pre-line;">${esc(o.note)}</div></details>` : ""}
  </div>`;
}

function reportEventPage({ catalog, engagements, profile }, user) {
  const regime = catalog.regime;
  const groups = Object.keys(catalog.groups).sort();

  const cards = groups
    .map((g) => {
      const items = catalog.groups[g]
        .map(
          (e) => `<button type="button" class="evbtn" data-key="${esc(e.key)}"
            style="display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--line);
                   border-radius:7px;padding:12px 14px;margin-bottom:8px;cursor:pointer;font:inherit;">
            <div style="font-weight:600;font-size:13.5px;color:var(--ink);">${esc(e.label)}</div>
            <div class="xs muted" style="margin-top:3px;">
              ${e.maxObligations} thing${e.maxObligations === 1 ? "" : "s"} this can trigger${e.hasPreAct ? " · one of them is due BEFORE you act" : ""}</div>
          </button>`
        )
        .join("");
      return `<div style="margin-bottom:18px;"><h3 style="margin-bottom:9px;">${esc(g)}</h3>${items}</div>`;
    })
    .join("");

  const engOpts = engagements
    .map((e) => `<option value="${e.id}">${esc(e.period_name || e.period_label)}</option>`)
    .join("");

  const body = `
  <h1>Report something that happened</h1>
  <div class="sub">Tell it in your own words. The portal works out what it triggered and when it is due.</div>

  <div class="note blue"><b>You do not need to know whether something is reportable.</b> That is the whole point.
    Pick the closest description, answer two or three questions, and the portal will tell you what it found,
    including when it finds nothing. An event reported and found not reportable costs you a minute. The
    reverse costs a filing deadline, and for some items twelve months of Form S-3 eligibility.</div>

  <div class="note amber"><b>This portal never decides whether something is material.</b> It computes dates,
    names the rule and asks for a decision. Materiality is management's judgment, and under SAB 99 a conclusion
    resting only on a percentage has, in the staff's words, no basis in the accounting literature or the law.</div>

  <div class="card" style="background:#F8FAFB;">
    <div class="sm"><b>What applies to this company:</b>
      ${regime.reporting ? pill("Files SEC reports", "#2C5F8A") : pill("Not a reporting company", "#667")}
      ${regime.listed ? pill("Listed — " + esc(regime.exchangeFamily) + " rules apply", "#991B1B") : pill("Not exchange listed", "#667")}
      ${regime.section12 ? pill("Section 12 — Forms 3/4/5 apply", "#B45309") : pill("No Section 16 duties", "#667")}
    </div>
    <div class="xs muted" style="margin-top:7px;">These three facts decide which obligations exist, and they are
      set on the <a href="${BASE}/profile">issuer profile</a>. If any of them is wrong, everything below is wrong.</div>
  </div>

  <div id="picker">${cards}</div>

  <div id="form" style="display:none;"></div>
  <div id="result"></div>

  <script>
  var CATALOG = ${JSON.stringify(catalog.groups)};
  var ENG_OPTS = ${JSON.stringify(engOpts)};
  var CURRENT = null;

  function byKey(k){
    for (var g in CATALOG) { for (var i=0;i<CATALOG[g].length;i++){ if (CATALOG[g][i].key===k) return CATALOG[g][i]; } }
    return null;
  }
  function esc(t){ return String(t==null?'':t).replace(/[&<>"]/g,function(m){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; }); }

  document.querySelectorAll('.evbtn').forEach(function(b){
    b.addEventListener('click', function(){ pick(b.getAttribute('data-key')); });
  });

  function pick(key){
    var e = byKey(key); if(!e) return;
    CURRENT = e;
    document.getElementById('picker').style.display='none';
    document.getElementById('result').innerHTML='';
    var qs = e.questions.map(function(q){
      if (q.type==='yesno') {
        return '<div style="margin:14px 0;"><div style="font-weight:600;font-size:13px;">'+esc(q.prompt)+'</div>'+
          (q.help?'<div class="xs muted" style="margin:3px 0 6px;">'+esc(q.help)+'</div>':'')+
          '<div class="row"><label style="font-weight:400;margin:0;"><input type="radio" name="q-'+q.id+'" value="yes" style="width:auto;"> Yes</label>'+
          '<label style="font-weight:400;margin:0;"><input type="radio" name="q-'+q.id+'" value="no" style="width:auto;" checked> No</label>'+
          '<label style="font-weight:400;margin:0;"><input type="radio" name="q-'+q.id+'" value="unsure" style="width:auto;"> Not sure</label></div></div>';
      }
      var t = q.type==='date' ? 'date' : 'text';
      return '<div style="margin:14px 0;"><label>'+esc(q.prompt)+'</label>'+
        '<input type="'+t+'" id="q-'+q.id+'">'+
        (q.help?'<div class="xs muted" style="margin-top:4px;">'+esc(q.help)+'</div>':'')+'</div>';
    }).join('');

    var anchors = e.anchors.map(function(a){
      return '<div><label>'+esc(a.label)+'</label><input type="date" id="d-'+a.key+'">'+
        (a.help?'<div class="xs muted" style="margin-top:4px;">'+esc(a.help)+'</div>':'')+'</div>';
    }).join('');

    document.getElementById('form').innerHTML =
      '<div class="between"><div><h2 style="font-size:17px;">'+esc(e.label)+'</h2></div>'+
      '<button class="btn ghost sm" onclick="back()">Pick something else</button></div>'+
      '<div class="note blue">'+esc(e.headline)+'</div>'+
      '<div class="card"><h2>Dates</h2><div class="grid g2">'+anchors+
      '<div><label>When did you or anyone here first know?</label><input type="date" id="d-learned2">'+
      '<div class="xs muted" style="margin-top:4px;">Kept separately from when it happened. A few obligations run from knowledge, and the sequence is what matters if anyone ever asks.</div></div>'+
      '</div></div>'+
      '<div class="card"><h2>A few questions</h2>'+qs+'</div>'+
      '<div class="card"><h2>Anything else worth knowing</h2>'+
      '<textarea id="summary" placeholder="In your own words. If you are unsure of a date, say so here."></textarea>'+
      '<label style="margin-top:12px;">Attach to a period (optional)</label>'+
      '<select id="engagement"><option value="">Not tied to a particular period</option>'+ENG_OPTS+'</select>'+
      '<div class="xs muted" style="margin-top:4px;">Pick one and the documents it asks for also appear on that period\'s checklist.</div>'+
      '</div>'+
      '<div class="row"><button class="btn ghost" onclick="preview()">Show me what this triggers</button>'+
      '<button class="btn" onclick="submit()">Report it</button><span class="sm muted" id="msg"></span></div>';
    document.getElementById('form').style.display='block';
    window.scrollTo(0,0);
  }

  function back(){
    document.getElementById('form').style.display='none';
    document.getElementById('result').innerHTML='';
    document.getElementById('picker').style.display='block';
  }

  function gather(){
    var answers={}, dates={};
    CURRENT.questions.forEach(function(q){
      if (q.type==='yesno') {
        var sel=document.querySelector('input[name="q-'+q.id+'"]:checked');
        answers[q.id] = sel ? sel.value : 'no';
      } else {
        var el=document.getElementById('q-'+q.id);
        if (el && el.value) answers[q.id]=el.value;
      }
    });
    CURRENT.anchors.forEach(function(a){
      var el=document.getElementById('d-'+a.key);
      if (el && el.value) dates[a.key]=el.value;
    });
    var l=document.getElementById('d-learned2');
    if (l && l.value) dates.learned=l.value;
    return {answers:answers, dates:dates};
  }

  async function preview(){
    var g=gather();
    if (!Object.keys(g.dates).length) return alert('Please give at least one date. Every deadline is measured from one.');
    var msg=document.getElementById('msg'); msg.textContent='Working it out...';
    try {
      var r=await fetch('${BASE}/api/events/preview',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:CURRENT.key,answers:g.answers,dates:g.dates})});
      var j=await r.json(); if(!j.ok) throw new Error(j.error||'Failed');
      render(j.built); msg.textContent='';
    } catch(e){ msg.textContent=''; alert(e.message); }
  }

  function render(b){
    var html='<h2 style="margin-top:20px;">What this triggers</h2>';
    if (!b.obligations.length) {
      html+='<div class="note green"><b>Nothing appears to be triggered by this.</b> That is a real answer and '+
        'worth recording: a decision that something was not reportable leaves no other trace, and it is the '+
        'one most likely to be looked at later.</div>';
    } else {
      if (b.counts.preAct) html+='<div class="note red"><b>Something here was due BEFORE you acted.</b> '+
        'It cannot be fixed by doing it late. Read it first and speak to counsel today.</div>';
      html+='<div class="sm muted" style="margin-bottom:11px;">'+b.counts.total+' in total · '+
        b.counts.filings+' filing'+(b.counts.filings===1?'':'s')+' · '+b.counts.critical+' critical'+
        (b.counts.s3Risk?' · '+b.counts.s3Risk+' affecting Form S-3 eligibility':'')+
        (b.counts.unverified?' · '+b.counts.unverified+' with an unconfirmed date':'')+'</div>';
      html+=b.obligations.map(card).join('');
    }
    if (b.suppressed && b.suppressed.length) {
      html+='<details style="margin-top:14px;"><summary>'+b.suppressed.length+
        ' obligation(s) do not apply to this company</summary><div class="sm muted" style="margin-top:7px;">'+
        b.suppressed.map(function(x){return '<div style="margin-bottom:5px;"><b>'+esc(x.label)+'</b><br>'+esc(x.reason)+'</div>';}).join('')+
        '</div></details>';
    }
    document.getElementById('result').innerHTML=html;
  }

  function card(o){
    var color = o.preAct ? '#991B1B' : o.severity==='critical' ? '#991B1B' : o.severity==='high' ? '#B45309' : '#2C5F8A';
    var h='<div class="card" style="border-left:3px solid '+color+';margin-bottom:11px;"><div class="between">'+
      '<div style="flex:1;min-width:250px;">';
    if (o.preAct) h+='<span class="pill" style="color:#991B1B;background:#991B1B18;border-color:#991B1B44;">WAS DUE BEFORE YOU DID IT</span> ';
    if (o.item8k) h+='<span class="pill" style="color:#991B1B;background:#991B1B18;border-color:#991B1B44;">Form 8-K Item '+esc(o.item8k)+'</span> ';
    if (o.kind==='decision') h+='<span class="pill" style="color:#6B21A8;background:#6B21A818;border-color:#6B21A844;">A DECISION, NOT A FILING</span> ';
    if (o.verified===false) h+='<span class="pill" style="color:#9C4221;background:#9C422118;border-color:#9C422144;">UNVERIFIED DATE</span> ';
    h+='<div style="font-weight:650;font-size:13.5px;margin-top:5px;">'+esc(o.label)+'</div>'+
       '<div class="xs muted" style="margin-top:4px;">'+esc((o.authority||[]).join(' · '))+'</div></div>'+
       '<div class="right" style="white-space:nowrap;"><div style="font-weight:700;font-size:15px;color:'+color+';">'+
       (o.dueDate||'No fixed date')+'</div>'+
       (o.anchorLabel?'<div class="xs muted">from '+esc(String(o.anchorLabel).toLowerCase())+'</div>':'')+'</div></div>';
    if (o.consequence) h+='<div class="sm" style="color:var(--ink2);margin-top:9px;">'+esc(o.consequence)+'</div>';
    if (o.s3Risk) h+='<div class="note red" style="margin:9px 0 0;"><b>Filing this late also costs Form S-3 '+
      'eligibility for twelve months.</b> Curing it late does not restore it.</div>';
    if (o.note) h+='<details style="margin-top:7px;"><summary>More detail</summary><div class="sm" '+
      'style="color:var(--ink2);white-space:pre-line;">'+esc(o.note)+'</div></details>';
    return h+'</div>';
  }

  async function submit(){
    var g=gather();
    if (!Object.keys(g.dates).length) return alert('Please give at least one date. Every deadline is measured from one.');
    var msg=document.getElementById('msg'); msg.textContent='Recording...';
    try {
      var r=await fetch('${BASE}/api/events/report',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({key:CURRENT.key,answers:g.answers,dates:g.dates,
          summary:(document.getElementById('summary')||{}).value||'',
          engagementId:(document.getElementById('engagement')||{}).value||null})});
      var j=await r.json(); if(!j.ok) throw new Error(j.error||'Failed');
      location.href='${BASE}/event/'+j.reportId;
    } catch(e){ msg.textContent=''; alert(e.message); }
  }
  </script>`;

  return chrome({ title: "Report something", body, user, active: "report-event" });
}

function eventRegisterPage({ reports, obligations, undetermined, attestations, stats, preAct, confirm }, user) {
  const canDetermine = auth.can(user, "event.determine");

  const obRows = obligations.length
    ? obligations
        .map((o) => {
          const late = o.due_date && daysUntil(o.due_date) < 0;
          return `<tr>
        <td style="white-space:nowrap;">${o.pre_act ? pill("PRE-ACT", "#991B1B") + " " : ""}${o.item_8k ? `<code>8-K ${esc(o.item_8k)}</code>` : esc(o.kind)}</td>
        <td>${esc(o.label)}
          <div class="xs muted">from “${esc(o.event_label)}” · <a href="${BASE}/event/${o.report_id}">open</a></div>
          ${o.s3_risk ? `<div class="xs" style="color:var(--red);font-weight:600;">Late here costs Form S-3 eligibility for twelve months.</div>` : ""}
          ${o.verified === false ? `<div class="xs" style="color:var(--rust);font-weight:600;">Unverified date — check the rule.</div>` : ""}</td>
        <td class="sm" style="white-space:nowrap;color:${late ? "var(--red)" : "var(--mute)"};font-weight:${late ? 600 : 400};">${fmtDate(o.due_date)}</td>
        <td>${pill(o.severity || "normal", o.severity === "critical" ? "#991B1B" : o.severity === "high" ? "#B45309" : "#667")}</td>
        <td class="right">${canDetermine ? `<button class="btn sm ghost" onclick="doneOb(${o.id})">Done</button>` : ""}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="empty">Nothing outstanding.</td></tr>`;

  const repRows = reports.length
    ? reports
        .map(
          (r) => `<tr>
      <td><a href="${BASE}/event/${r.id}">${esc(r.event_label)}</a>
        <div class="xs muted">${esc(r.reported_by_name || "")} · ${fmtDateTime(r.reported_at)}</div></td>
      <td class="sm">${fmtDate(r.occurred_on)}</td>
      <td class="sm">${r.obligations} total${r.open_obligations ? `, ${r.open_obligations} open` : ""}
        ${r.overdue ? `<div class="xs" style="color:var(--red);font-weight:600;">${r.overdue} overdue</div>` : ""}</td>
      <td class="sm">${fmtDate(r.next_due)}</td>
      <td>${
        r.determined_at
          ? pill(String(r.determination).replace(/_/g, " "), r.determination === "reportable" ? "#991B1B" : "#1C7C54")
          : pill("NEEDS A DECISION", "#B45309")
      }</td></tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Nothing reported yet.</td></tr>`;

  const today = cal.today();
  const weekStart = confirm || cal.iso(cal.addDays(cal.parse(today), -7));

  const body = `
  <div class="between"><div>
    <h1>Event register</h1>
    <div class="sub">Everything reported, what it triggered, and who decided</div></div>
    <a class="btn" href="${BASE}/report-event">Report something</a></div>

  <div class="grid g4" style="margin-bottom:16px;">
    <div class="stat"><div class="n" style="color:${stats.undetermined ? "var(--amber)" : "var(--green)"}">${stats.undetermined}</div>
      <div class="l">Need a decision</div><div class="x">Including the ones that turn out to be nothing</div></div>
    <div class="stat"><div class="n" style="color:${stats.overdue ? "var(--red)" : "var(--ink)"}">${stats.overdue}</div>
      <div class="l">Overdue</div><div class="x">No Form 8-K extension exists</div></div>
    <div class="stat"><div class="n">${stats.openObligations}</div><div class="l">Open obligations</div></div>
    <div class="stat"><div class="n" style="color:${stats.s3Risk ? "var(--red)" : "var(--ink)"}">${stats.s3Risk}</div>
      <div class="l">Affect Form S-3</div><div class="x">Twelve months if filed late</div></div>
  </div>

  ${
    stats.preAct
      ? `<div class="note red"><b>${stats.preAct} obligation${stats.preAct === 1 ? " was" : "s were"} due before the act that triggered ${stats.preAct === 1 ? "it" : "them"}.</b>
         Filing or notifying late does not cure these. They are listed first below.</div>`
      : ""
  }

  <div class="card" style="border-left:3px solid var(--green);">
    <h2>Weekly confirmation</h2>
    <div class="sm" style="color:var(--ink2);">Completeness is the hard half of this. A register that only knows
      what somebody chose to type in can show that what was reported was reported, and nothing more. An
      affirmative “nothing to report”, signed and dated, is what makes it evidence.</div>
    <div class="row" style="margin-top:12px;">
      <span class="sm muted">For ${fmtDate(weekStart)} to ${fmtDate(today)}:</span>
      <button class="btn ok sm" onclick="confirmPeriod('nothing_to_report')">Nothing to report</button>
      <button class="btn ghost sm" onclick="confirmPeriod('reported')">I reported everything I know of</button>
      <span class="sm muted" id="cmsg"></span>
    </div>
  </div>

  <h2 style="margin-top:22px;">Outstanding obligations</h2>
  <div class="card tight"><table>
    <tr><th>What</th><th>Obligation</th><th>Due</th><th></th><th></th></tr>${obRows}</table></div>

  <h2 style="margin-top:22px;">Reported events</h2>
  <div class="card tight"><table>
    <tr><th>Event</th><th>Happened</th><th>Obligations</th><th>Next due</th><th>Decision</th></tr>${repRows}</table></div>

  ${
    attestations.length
      ? `<h2 style="margin-top:22px;">Confirmation history</h2>
         <div class="card tight"><table><tr><th>Person</th><th>Period</th><th>Answer</th><th>Signed</th></tr>
         ${attestations
           .map(
             (a) => `<tr><td class="sm">${esc(a.user_name)}</td>
             <td class="sm">${fmtDate(a.period_start)} to ${fmtDate(a.period_end)}</td>
             <td>${a.answer === "nothing_to_report" ? pill("Nothing to report", "#1C7C54") : pill("Reported everything", "#2C5F8A")}</td>
             <td class="sm muted">${fmtDateTime(a.created_at)}</td></tr>`
           )
           .join("")}</table></div>`
      : ""
  }

  ${
    preAct && preAct.length
      ? `<h2 style="margin-top:22px;">Things that need doing BEFORE you act</h2>
         <div class="note amber">These are the obligations that cannot be cured. Worth knowing before the
         decision rather than after it, because by the time the act has happened the notice is already late.</div>
         <div class="card tight"><table><tr><th>If you are about to</th><th>You must first</th><th>Authority</th></tr>
         ${preAct
           .map(
             (x) => `<tr><td class="sm">${esc(x.eventLabel)}</td>
             <td class="sm"><b>${esc(x.label)}</b><div class="xs muted">${esc(x.consequence || "")}</div></td>
             <td class="xs muted">${esc((x.authority || []).join(" · "))}</td></tr>`
           )
           .join("")}</table></div>`
      : ""
  }

  <script>
  async function post(url, body){
    var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    var j=await r.json(); if(!j.ok) throw new Error(j.error||'Request failed'); return j;
  }
  async function doneOb(id){
    var n=prompt('What was done? This goes on the record.');
    if(!n) return;
    try{ await post('${BASE}/api/events/obligation/'+id+'/done',{note:n}); location.reload(); }catch(e){ alert(e.message); }
  }
  async function confirmPeriod(answer){
    var msg=document.getElementById('cmsg');
    var note = answer==='nothing_to_report' ? '' : (prompt('Anything to add? (optional)')||'');
    msg.textContent='Recording...';
    try{
      await post('${BASE}/api/events/confirm-period',
        {periodStart:'${weekStart}',periodEnd:'${today}',answer:answer,note:note});
      location.reload();
    }catch(e){ msg.textContent=''; alert(e.message); }
  }
  </script>`;

  return chrome({ title: "Event register", body, user, active: "events", wide: true });
}

function eventDetailPage({ report: r }, user) {
  const canDetermine = auth.can(user, "event.determine");
  const obs = r.obligations.map((o) => obligationCard({ ...o, item8k: o.item_8k, preAct: o.pre_act, s3Risk: o.s3_risk, note: o.guidance, authority: o.authority, dueDate: o.due_date, anchorLabel: null })).join("");

  const body = `
  <div class="between"><div>
    <h1>${esc(r.event_label)}</h1>
    <div class="sub">Reported by ${esc(r.reported_by_name || "—")} on ${fmtDateTime(r.reported_at)}</div></div>
    <a class="btn ghost" href="${BASE}/events">Back to the register</a></div>

  ${r.summary ? `<div class="note blue">${esc(r.summary)}</div>` : ""}

  <div class="card"><h2>The timeline</h2>
    <div class="sm muted" style="margin-bottom:10px;">Kept as four separate dates on purpose. If anyone ever asks
      when this company first knew something, this is the answer, and a single date column could not give it.</div>
    <table>
      <tr><th>It happened</th><td class="sm">${fmtDate(r.occurred_on)}</td></tr>
      <tr><th>Someone here knew</th><td class="sm">${fmtDate(r.learned_on)}</td></tr>
      <tr><th>It was reported</th><td class="sm">${fmtDateTime(r.reported_at)}</td></tr>
      <tr><th>Management was told</th><td class="sm">${r.notified_at ? fmtDateTime(r.notified_at) : "—"}</td></tr>
      <tr><th>Control version in force</th><td class="sm"><code>${esc(r.catalog_version)}</code></td></tr>
    </table>
  </div>

  <h2 style="margin-top:20px;">What it triggered</h2>
  ${obs || `<div class="empty">Nothing was triggered by this event.</div>`}

  <div class="card" style="border-left:3px solid ${r.determined_at ? "var(--green)" : "var(--amber)"};">
    <h2>The determination</h2>
    ${
      r.determined_at
        ? `<div>${pill(String(r.determination).replace(/_/g, " "), r.determination === "reportable" ? "#991B1B" : "#1C7C54")}
           by <b>${esc(r.determined_by_name || "")}</b> on ${fmtDateTime(r.determined_at)}</div>
           <div class="sm" style="margin-top:9px;color:var(--ink2);white-space:pre-line;">${esc(r.determination_note || "")}</div>
           <div class="xs muted" style="margin-top:9px;">A recorded determination is final. If it was wrong, report a
             correcting event rather than rewriting this one.</div>`
        : canDetermine
        ? `<div class="note amber">Somebody has to decide, and the decision is recorded against their name.
             This includes deciding that nothing is reportable, which is the determination with no other trace
             and the one most likely to be examined later. The portal will not make it for you.</div>
           <label>What did you conclude?</label>
           <select id="det">
             <option value="reportable">Reportable — the obligations above apply</option>
             <option value="not_reportable">Not reportable — nothing is required</option>
             <option value="deferred">Deferred — waiting on facts or on counsel</option>
           </select>
           <label>Why? Briefly.</label>
           <textarea id="note" placeholder="The reasoning. For a materiality call, address the qualitative factors and not just the numbers."></textarea>
           <button class="btn" style="margin-top:12px;" onclick="determine()">Record the determination</button>
           <span class="sm muted" id="dmsg"></span>`
        : `<div class="note amber">This still needs a decision from someone with authority to make it.</div>`
    }
  </div>

  <script>
  async function determine(){
    var d=document.getElementById('det').value, n=document.getElementById('note').value;
    if(!n||n.trim().length<10) return alert('Please give the reasoning. This is the record showing a person decided, on a date.');
    var msg=document.getElementById('dmsg'); msg.textContent='Recording...';
    try{
      var r=await fetch('${BASE}/api/events/'+${r.id}+'/determine',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({determination:d,note:n})});
      var j=await r.json(); if(!j.ok) throw new Error(j.error||'Failed');
      location.reload();
    }catch(e){ msg.textContent=''; alert(e.message); }
  }
  </script>`;

  return chrome({ title: esc(r.event_label), body, user, active: "events" });
}

// ════════════════════════════════════════════════════════════
//  DELIVERY LEDGER
// ════════════════════════════════════════════════════════════
//
// The screens here exist to answer one question honestly: was the other
// side actually told, and did they agree the package was complete. Every
// receipt fact is shown with what it can support, because the failure
// mode of a delivery dashboard is a green tick that means less than the
// reader assumes.

const RECEIPT_FACTS = [
  ["notified_at", "Queued for sending", "The portal created the message.", "#889"],
  ["email_sent_at", "Our mail server accepted it", "Says nothing about whether it arrived.", "#B45309"],
  ["email_delivered_at", "Their mail server accepted it", "This is the fact that answers “it never arrived”.", "#2C5F8A"],
  ["email_bounced_at", "Rejected on delivery", "It demonstrably did not arrive. No reminder will fix this.", "#991B1B"],
  ["email_opened_at", "Tracking image loaded", "Unreliable in both directions — gateways prefetch it, most clients block it. Not evidence on its own.", "#B45309"],
  ["link_clicked_at", "Link in the email clicked", "The link was addressed to this person, so it identifies them.", "#2C5F8A"],
  ["first_viewed_at", "Opened the package in the portal", "Signed in as themselves.", "#17706E"],
  ["last_download_at", "Downloaded the files", "The strongest observation short of a statement.", "#17706E"],
  ["disputed_at", "Reported incomplete", "They say something is missing.", "#9C4221"],
  ["dispute_resolved_at", "Dispute resolved", "", "#667"],
  ["acknowledged_at", "Acknowledged as complete", "A statement by them. The only receipt that closes an item.", "#1C7C54"],
];

function stagePill(stage) {
  if (!stage) return "";
  return pill(stage.label, stage.color);
}

function receiptTimeline(r) {
  const rows = RECEIPT_FACTS.filter(([k]) => r[k]).map(
    ([k, label, caption, color]) => `<tr>
      <td style="white-space:nowrap;color:${color};font-weight:600;width:1%;">${esc(label)}</td>
      <td class="sm" style="white-space:nowrap;">${fmtDateTime(r[k])}</td>
      <td class="xs muted">${esc(caption)}${
      k === "email_bounced_at" && r.bounce_reason
        ? `<br><span class="mono" style="color:var(--red);">${esc(String(r.bounce_reason).slice(0, 220))}</span>`
        : ""
    }${
      k === "acknowledged_at" && r.acknowledged_note
        ? `<br><b>Note:</b> ${esc(r.acknowledged_note)}`
        : ""
    }${k === "disputed_at" && r.dispute_note ? `<br><b>Said:</b> ${esc(r.dispute_note)}` : ""}${
      k === "dispute_resolved_at" && r.dispute_resolution ? `<br><b>Resolution:</b> ${esc(r.dispute_resolution)}` : ""
    }${
      k === "last_download_at" && Number(r.download_count) > 1
        ? ` (${r.download_count} downloads)`
        : ""
    }${
      k === "link_clicked_at" && r.link_clicked_ip ? ` From ${esc(r.link_clicked_ip)}.` : ""
    }</td></tr>`
  );
  if (!rows.length) {
    return `<div class="empty" style="padding:14px;">Nothing has happened yet — the message has not even been sent.
      If this persists, SMTP is not configured and <b>no notification has left the building</b>.</div>`;
  }
  return `<table style="font-size:12.5px;">${rows.join("")}</table>`;
}

/** The dashboard band. Silent unless something needs a human. */
function deliveryStrip(s, user) {
  if (!s) return "";
  const out = [];

  if (s.undelivered) {
    out.push(`<div class="note ${s.undeliveredStale ? "red" : "amber"}">
      <b>${s.undelivered} document${s.undelivered === 1 ? "" : "s"} ${
      s.undelivered === 1 ? "has" : "have"
    } never been transmitted to anyone.</b>
      ${
        s.auditor_accounts === 0
          ? `There are no active auditor accounts, so nothing <em>can</em> be transmitted. The portal will not
             record a delivery that cannot have happened. <a href="${BASE}/users">Create the engagement
             team's accounts</a> and these go out on the next sweep.`
          : `A file sitting in the portal is stored, not delivered — that distinction is the whole reason
             this ledger exists. ${
               s.undeliveredOldestHours >= 24
                 ? `The oldest has been waiting ${Math.floor(s.undeliveredOldestHours / 24)} day${
                     Math.floor(s.undeliveredOldestHours / 24) === 1 ? "" : "s"
                   }. `
                 : ""
             }<a href="${BASE}/transmittals?tab=undelivered">Review and transmit</a>.`
      }
    </div>`);
  }

  if (s.bounced) {
    out.push(`<div class="note red"><b>${s.bounced} notification${s.bounced === 1 ? "" : "s"} did not arrive.</b>
      The receiving mail server rejected ${s.bounced === 1 ? "it" : "them"}, so the recipient was never told the
      package existed. Reminders will not help — the address has to be fixed and the package reissued.
      <a href="${BASE}/transmittals?filter=stalled">See which</a>.</div>`);
  }

  if (s.disputed) {
    out.push(`<div class="note red"><b>${s.disputed} package${s.disputed === 1 ? " has" : "s have"} been reported
      incomplete.</b> <a href="${BASE}/transmittals?filter=disputed">Open the dispute${
      s.disputed === 1 ? "" : "s"
    }</a> and send what was missing as a further transmittal.</div>`);
  } else if (s.stalled) {
    out.push(`<div class="note amber"><b>${s.stalled} package${s.stalled === 1 ? " is" : "s are"} stalled</b> past
      ${s.config ? s.config.stalled_business_days : 5} business days without acknowledgment. These are now recorded
      as delays for the AS 1301.25 schedule rather than chased as reminders.
      <a href="${BASE}/delays">See the schedule</a>.</div>`);
  }

  if (s.awaitingMe && s.awaitingMe.length) {
    out.push(`<div class="note blue"><b>${s.awaitingMe.length} package${
      s.awaitingMe.length === 1 ? "" : "s"
    } ${s.awaitingMe.length === 1 ? "is" : "are"} waiting for your acknowledgment.</b>
      ${s.awaitingMe
        .slice(0, 4)
        .map((t) => `<a href="${BASE}/transmittal/${t.id}">${esc(t.number)}</a>`)
        .join(" · ")}${s.awaitingMe.length > 4 ? ` and ${s.awaitingMe.length - 4} more` : ""}.
      Only you can say a package is complete — the portal can see it was delivered, not that it was enough.</div>`);
  }

  return out.join("");
}

// ── The ledger ──────────────────────────────────────────────
function transmittalsPage(
  { transmittals, undelivered, stats, filter, tab, engagements, auditorAccounts },
  user
) {
  const canCreate = auth.can(user, "delivery.create");
  const FILTERS = [
    ["open", "Open"],
    ["stalled", "Stalled"],
    ["disputed", "Disputed"],
    ["closed", "Acknowledged"],
    ["all", "All"],
    ["void", "Void"],
  ];

  const chips = FILTERS.map(
    ([k, label]) =>
      `<a class="btn sm ${k === filter ? "" : "ghost"}" href="${BASE}/transmittals?filter=${k}">${esc(label)}</a>`
  ).join(" ");

  const statRow = `
  <div class="grid g4" style="margin-bottom:16px;">
    <div class="stat"><div class="n" style="color:${stats.undelivered ? "var(--red)" : "var(--green)"}">${
    stats.undelivered
  }</div>
      <div class="l">Undelivered</div><div class="x">Uploaded, nobody told</div></div>
    <div class="stat"><div class="n">${stats.open}</div><div class="l">Awaiting receipt</div>
      <div class="x">Of ${stats.total} issued</div></div>
    <div class="stat"><div class="n" style="color:${stats.stalled || stats.bounced ? "var(--red)" : "var(--ink)"}">${
    stats.stalled + stats.bounced
  }</div>
      <div class="l">Not moving</div><div class="x">${stats.bounced} did not arrive</div></div>
    <div class="stat"><div class="n">${
      stats.medianAckBusinessDays == null ? "—" : stats.medianAckBusinessDays
    }</div>
      <div class="l">Median ack</div><div class="x">${
        stats.ackSampleSize ? `Business days, last ${stats.ackSampleSize}` : "No acknowledgments yet"
      }</div></div>
  </div>`;

  const ledger = transmittals.length
    ? `<table>
      <tr><th>No.</th><th>Subject</th><th>Period</th><th class="right">Items</th><th>State</th>
        <th>Addressed to</th><th class="right">Age</th><th>Sent</th></tr>
      ${transmittals
        .map((t) => {
          const roll = t.dispute_count
            ? ["Disputed", "#9C4221"]
            : t.voided_at
            ? ["Void", "#889"]
            : t.to_count && t.ack_count === t.to_count
            ? ["Acknowledged", "#1C7C54"]
            : t.bounce_count && !t.viewed_count
            ? ["Did not arrive", "#991B1B"]
            : t.stalled_count
            ? ["Stalled", "#991B1B"]
            : t.viewed_count
            ? ["Seen", "#B45309"]
            : ["Awaiting", "#B45309"];
          return `<tr>
          <td><a href="${BASE}/transmittal/${t.id}"><b>${esc(t.number)}</b></a>
            ${t.auto_generated ? `<div class="xs muted">auto</div>` : ""}</td>
          <td>${esc(String(t.subject).slice(0, 70))}
            <div class="xs muted">${t.direction === "to_auditor" ? "company → auditor" : "auditor → company"}${
            t.delivery_method !== "portal" ? ` · also by ${esc(t.delivery_method.replace(/_/g, " "))}` : ""
          }</div></td>
          <td class="sm muted">${esc(t.period_label || "—")}</td>
          <td class="right">${t.doc_count}${t.item_count ? ` <span class="xs muted">+${t.item_count}r</span>` : ""}</td>
          <td>${pill(roll[0], roll[1])}</td>
          <td class="sm">${t.ack_count}/${t.to_count} signed
            ${t.bounce_count ? ` ${pill(t.bounce_count + " bounced", "#991B1B")}` : ""}</td>
          <td class="right sm" style="color:${
            t.ageBusinessDays >= 5 && t.ack_count < t.to_count ? "var(--red);font-weight:600" : "inherit"
          };">${t.ageBusinessDays}bd</td>
          <td class="sm muted" style="white-space:nowrap;">${fmtDate(t.created_at)}</td></tr>`;
        })
        .join("")}</table>`
    : `<div class="empty">No transmittals match this filter.${
        canCreate ? ` <a href="${BASE}/transmittal/new">Issue one</a>.` : ""
      }</div>`;

  const undeliveredTable = undelivered.length
    ? `<form method="POST" action="${BASE}/api/transmittal/create" id="txform">
      <input type="hidden" name="direction" value="to_auditor">
      <table>
        <tr><th style="width:1%;"><input type="checkbox" id="all" style="width:auto;"></th>
          <th>Document</th><th>Ref</th><th>Period</th><th class="right">Size</th><th>Waiting</th><th>Arrived by</th></tr>
        ${undelivered
          .map(
            (d) => `<tr>
          <td><input type="checkbox" name="documentIds" value="${d.id}" checked style="width:auto;"></td>
          <td><a href="${BASE}/document/${d.id}">${esc(d.filename)}</a>
            ${d.is_gate ? ` ${pill("GATE", "#991B1B")}` : ""}
            ${d.needs_confirmation ? ` ${pill("UNCLASSIFIED", "#B45309")}` : ""}</td>
          <td><code>${esc(d.category_code || "—")}</code></td>
          <td class="sm muted">${esc(d.engagement_period || "no period")}</td>
          <td class="right sm">${fmtBytes(d.size_bytes)}</td>
          <td class="sm" style="color:${d.ageHours >= 24 ? "var(--red);font-weight:600" : "inherit"};">${
              d.ageHours >= 24 ? `${Math.floor(d.ageHours / 24)}d ${d.ageHours % 24}h` : `${d.ageHours}h`
            }</td>
          <td class="sm muted">${esc(d.uploaded_by_name || d.source || "—")}</td></tr>`
          )
          .join("")}
      </table>
      <div style="padding:14px 18px;border-top:1px solid var(--line);">
        <label>Message to the engagement team (optional)</label>
        <textarea name="message" placeholder="Anything they should know before opening these."></textarea>
        <div class="row" style="margin-top:12px;">
          <button class="btn ok" type="submit" ${auditorAccounts ? "" : "disabled"}>Issue transmittal and notify</button>
          ${
            auditorAccounts
              ? `<span class="xs muted">One numbered package, one email each, and the receipt clock starts.</span>`
              : `<span class="xs" style="color:var(--red);">No active auditor accounts — there is nobody to send to.</span>`
          }
        </div>
      </div>
    </form>
    <script>
      document.getElementById("all").addEventListener("change", function(e){
        document.querySelectorAll('#txform input[name=documentIds]').forEach(function(c){ c.checked = e.target.checked; });
      });
      document.getElementById("txform").addEventListener("submit", function(e){
        e.preventDefault();
        var ids = Array.from(document.querySelectorAll('#txform input[name=documentIds]:checked')).map(function(c){return Number(c.value);});
        if (!ids.length) { alert("Select at least one document."); return; }
        var btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = "Issuing\\u2026";
        fetch("${BASE}/api/transmittal/create", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ direction:"to_auditor", documentIds: ids,
            message: document.querySelector('#txform textarea[name=message]').value })
        }).then(function(r){return r.json();}).then(function(j){
          if (j.ok) location.href = "${BASE}/transmittal/" + j.transmittal.id;
          else { alert(j.error || "Could not issue the transmittal."); btn.disabled = false; btn.textContent = "Issue transmittal and notify"; }
        }).catch(function(err){ alert(String(err)); btn.disabled = false; btn.textContent = "Issue transmittal and notify"; });
      });
    </script>`
    : `<div class="empty">Nothing is waiting. Every document on file has been transmitted to somebody — which
        is the state this page exists to keep you in.</div>`;

  const body = `
  <div class="between"><div>
    <h1>Deliveries</h1>
    <div class="sub">Who was told what, when they saw it, and whether they said it was complete</div>
  </div>${canCreate ? `<a class="btn" href="${BASE}/transmittal/new">Issue a transmittal</a>` : ""}</div>

  ${statRow}

  <div class="note blue">
    <b>A shared folder cannot settle &ldquo;we never got it&rdquo;.</b> It knows a file exists; it does not know
    that a named person was told, that the message reached their mail server, that they opened it, or that they
    agreed the package was complete. Those are four separate facts and only the last one closes an item, so each
    is recorded separately here and labelled with what it can actually support.
  </div>

  <div class="row" style="margin-bottom:14px;">
    <a class="btn sm ${tab === "undelivered" ? "" : "ghost"}" href="${BASE}/transmittals?tab=undelivered">
      Undelivered${stats.undelivered ? ` (${stats.undelivered})` : ""}</a>
    <a class="btn sm ${tab === "undelivered" ? "ghost" : ""}" href="${BASE}/transmittals">Ledger</a>
    <span style="flex:1;"></span>
    <a class="btn sm ghost" href="${BASE}/delays">AS 1301.25 delays</a>
  </div>

  ${
    tab === "undelivered"
      ? `<div class="card tight">
           <div style="padding:14px 18px 0;">
             <h2>Uploaded, but nobody has been told</h2>
             <div class="sub">An active document that has never appeared on a live transmittal. This is a tracked
               state, not an absence — it is the exact gap that produces &ldquo;we never got it&rdquo;, so the
               portal names it rather than showing a reassuring tick.</div>
           </div>${undeliveredTable}</div>`
      : `<div class="card tight">
           <div style="padding:14px 18px 0;"><div class="between"><h2>Transmittal ledger</h2>
             <div class="row">${chips}</div></div></div>${ledger}</div>`
  }`;

  return chrome({ title: "Deliveries", body, user, active: "transmittals", wide: true });
}

// ── One package ─────────────────────────────────────────────
function transmittalDetailPage({ data, myReceipt }, user) {
  const { transmittal: t, documents, recipients, events, manifest, rollup } = data;
  const canAck = !!myReceipt && !myReceipt.acknowledged_at && !t.voided_at;
  const canResolve = auth.can(user, "delivery.create");
  const canVoid = auth.can(user, "delivery.admin") && !t.voided_at;
  let canonical = [];
  try {
    const delivery = require("./audit-delivery");
    canonical = [delivery.MANIFEST_FORMAT].concat(delivery.manifestLines(documents));
  } catch {
    /* the fingerprint panel degrades to the stored hash alone */
  }

  const manifestRows = documents
    .map(
      (d) => `<tr>
      <td class="right muted" style="width:1%;">${d.ordinal}</td>
      <td>${
        d.document_id
          ? `<a href="${BASE}/document/${d.document_id}">${esc(d.filename)}</a>`
          : `${esc(d.filename)} ${pill("REQUESTED", "#B45309")}`
      }
        ${d.version && d.version > 1 ? ` <span class="xs muted">v${d.version}</span>` : ""}
        ${
          Number(d.superseded_by_count) > 0
            ? `<div class="xs" style="color:var(--amber);">A newer version of this file exists now. The manifest
                 deliberately still names the version that was handed over.</div>`
            : ""
        }</td>
      <td class="sm muted">${esc(d.category_label || d.category_code || "—")}</td>
      <td class="right sm">${d.size_bytes ? fmtBytes(d.size_bytes) : "—"}</td>
      <td><code class="xs">${esc(d.sha256 ? d.sha256.slice(0, 16) : "—")}</code></td></tr>`
    )
    .join("");

  const people = recipients
    .map(
      (r) => `<div class="card" style="margin-bottom:12px;">
      <div class="between">
        <div><b>${esc(r.name || r.email)}</b>
          <span class="xs muted">${esc(r.email)}${r.org ? ` · ${esc(r.org)}` : ""}</span>
          <div class="xs muted">${
            r.kind === "to" ? "Addressed to — owes an acknowledgment" : "Copied — not chased"
          }${
        Number(r.reminder_count) ? ` · ${r.reminder_count} reminder${Number(r.reminder_count) === 1 ? "" : "s"} sent` : ""
      }${r.stalled_at ? ` · recorded as stalled ${fmtDate(r.stalled_at)}` : ""}</div></div>
        <div>${stagePill(r.stage)}</div>
      </div>
      <div class="xs muted" style="margin:7px 0 9px;">${esc(r.stage ? r.stage.weight : "")}</div>
      ${receiptTimeline(r)}
      ${
        r.disputed_at && !r.dispute_resolved_at && canResolve
          ? `<form class="noprint" style="margin-top:10px;" onsubmit="return resolveDispute(event, ${r.id})">
               <label>Record how this dispute was resolved</label>
               <input type="text" name="resolution" required minlength="10"
                 placeholder="e.g. the September statement was sent as T-0019 on the 9th">
               <button class="btn sm" type="submit" style="margin-top:8px;">Record resolution</button>
             </form>`
          : ""
      }
    </div>`
    )
    .join("");

  const eventRows = events.length
    ? `<table><tr><th>When</th><th>Event</th><th>Who</th><th>Detail</th></tr>
      ${events
        .map(
          (e) => `<tr>
        <td class="sm muted" style="white-space:nowrap;">${fmtDateTime(e.created_at)}</td>
        <td class="sm"><b>${esc(String(e.event).replace(/^transmittal_/, "").replace(/_/g, " "))}</b></td>
        <td class="sm muted">${esc(e.actor_email || "system")}${e.ip ? `<div class="xs">${esc(e.ip)}</div>` : ""}</td>
        <td class="xs muted mono">${esc(JSON.stringify(e.detail || {}).slice(0, 180))}</td></tr>`
        )
        .join("")}</table>`
    : `<div class="empty">No events recorded.</div>`;

  const body = `
  <div class="between"><div>
    <h1>${esc(t.number)} — ${esc(t.subject)}</h1>
    <div class="sub">${
      t.direction === "to_auditor" ? "Issued by the company to the engagement team" : "Issued by the engagement team to the company"
    }${t.period_label ? ` · ${esc(t.period_name || t.period_label)}` : ""} · ${fmtDateTime(t.created_at)}${
    t.created_by_name ? ` by ${esc(t.created_by_name)}` : ""
  }</div>
  </div><div class="row noprint">
    ${pill(rollup.label, rollup.color)}
    <button type="button" id="print-this" class="btn sm ghost">Print receipt</button>
    <a class="btn sm ghost" href="${BASE}/transmittals">All deliveries</a>
  </div></div>

  ${
    t.voided_at
      ? `<div class="note red"><b>This transmittal was voided ${fmtDate(t.voided_at)}${
          t.voided_by_name ? ` by ${esc(t.voided_by_name)}` : ""
        }.</b> ${esc(t.void_reason || "")}<br>
        It is kept rather than deleted because the recipients saw it, and a gap in the numbering would be the
        suspicious part.</div>`
      : ""
  }
  ${t.message ? `<div class="card"><h3>Covering message</h3><div style="white-space:pre-wrap;">${esc(t.message)}</div></div>` : ""}
  ${
    t.delivery_method !== "portal"
      ? `<div class="note amber"><b>This package also went out by ${esc(
          t.delivery_method.replace(/_/g, " ")
        )}.</b> ${esc(t.method_note || "")}<br>
        Recorded here so the ledger covers every route, not only the tidy one. A record that knows about just
        the portal has the same blind spot in a new costume.</div>`
      : ""
  }

  ${
    canAck
      ? `<div class="card noprint" style="border-color:#1C7C54;border-width:2px;">
          <h2>Acknowledge receipt</h2>
          <p class="sm" style="margin-top:0;">The portal can see that this reached you and whether you took the
            files. It cannot say on your behalf that the package is complete — only you can, and that
            statement is what closes these items. An acknowledgment is final once recorded.</p>
          <form onsubmit="return ack(event)">
            <label>Note (optional)</label>
            <input type="text" name="note" placeholder="e.g. received, reconciled to the trial balance">
            <div class="row" style="margin-top:12px;">
              <button class="btn ok" type="submit">Acknowledge — this package is complete</button>
              <button class="btn ghost" type="button" onclick="document.getElementById('disp').style.display='block'">
                Something is missing</button>
            </div>
          </form>
          <form id="disp" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line);"
            onsubmit="return disp(event)">
            <label>What is missing or wrong? (at least ten characters)</label>
            <textarea name="note" required minlength="10"
              placeholder="e.g. the September bank statement for the operating account is not in here"></textarea>
            <div class="xs muted" style="margin-top:6px;">A fast objection is worth far more to the close than
              slow silence, and the sender is told immediately.</div>
            <button class="btn danger" type="submit" style="margin-top:10px;">Report the package incomplete</button>
          </form>
        </div>`
      : myReceipt && myReceipt.acknowledged_at
      ? `<div class="note green"><b>You acknowledged this package on ${fmtDateTime(myReceipt.acknowledged_at)}.</b>
          ${myReceipt.acknowledged_note ? esc(myReceipt.acknowledged_note) : ""}</div>`
      : !myReceipt
      ? `<div class="note blue">You are not a recipient of this transmittal, so there is nothing for you to
          acknowledge. An acknowledgment only means something if it comes from the person the package was
          addressed to.</div>`
      : ""
  }

  <div class="card tight">
    <div style="padding:14px 18px 0;"><div class="between"><h2>Manifest</h2>
      <div class="sm muted">${t.doc_count} document${t.doc_count === 1 ? "" : "s"}${
    t.item_count ? ` · ${t.item_count} requested` : ""
  } · ${fmtBytes(t.total_bytes)}</div></div></div>
    <table><tr><th class="right">#</th><th>File</th><th>Category</th><th class="right">Size</th><th>SHA-256</th></tr>
      ${manifestRows}</table>
    <div style="padding:14px 18px;border-top:1px solid var(--line);">
      <div class="between">
        <div>
          <h3 style="margin-bottom:4px;">Manifest fingerprint</h3>
          <div class="mono">${esc(manifest.stored)}</div>
        </div>
        <div>${
          manifest.matches
            ? pill("VERIFIED", "#1C7C54")
            : pill("DOES NOT MATCH — INVESTIGATE", "#991B1B")
        }</div>
      </div>
      <div class="xs muted" style="margin-top:8px;">
        A SHA-256 over this package's own ordered list of file names, file hashes and sizes. Either a file is
        under that fingerprint or it is not, so if anything is later said to be missing the question is settled
        by arithmetic rather than recollection. ${
          manifest.matches
            ? "Recomputed from the sealed manifest just now and it matches."
            : "<b style='color:var(--red)'>The recomputed value does not match the sealed one. That should be impossible — the manifest is sealed by database trigger — so treat it as a serious integrity question and do not rely on this package.</b>"
        }
      </div>
      ${
        canonical.length
          ? `<details class="noprint" style="margin-top:9px;"><summary>Show the canonical form, so the other side can recompute it</summary>
             <div class="mono xs" style="white-space:pre;background:#F8FAFB;padding:10px;border-radius:5px;border:1px solid var(--line);overflow:auto;">${esc(
               canonical.join("\n")
             )}</div>
             <div class="xs muted" style="margin-top:6px;">Lines joined with a single newline, no trailing
               newline, UTF-8, then SHA-256. The first line is the format identifier, so a future change to the
               format cannot be mistaken for a tampered manifest.</div></details>`
          : ""
      }
    </div>
  </div>

  <h2 style="margin-top:22px;">Receipts — ${rollup.acked} of ${rollup.owed} addressed recipients have signed</h2>
  ${people}

  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Chain of custody</h2>
    <div class="sub">Append-only. Nothing here can be edited or removed, including by direct database access.</div>
  </div>${eventRows}</div>

  ${
    canVoid
      ? `<div class="card noprint"><h2>Void this transmittal</h2>
          <p class="sm" style="margin-top:0;">Voiding withdraws the package. It is never deleted: the recipients
            saw it, and a hole in the numbering is harder to explain than a withdrawal. The reason is kept.</p>
          <form onsubmit="return voidTx(event)">
            <label>Reason (at least ten characters)</label>
            <input type="text" name="reason" required minlength="10"
              placeholder="e.g. issued against the wrong period; reissued as T-0021">
            <button class="btn danger" type="submit" style="margin-top:10px;">Void ${esc(t.number)}</button>
          </form></div>`
      : ""
  }

  <script>
    function post(url, payload, btn) {
      if (btn) { btn.disabled = true; }
      return fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload||{}) })
        .then(function(r){ return r.json(); })
        .then(function(j){ if (j.ok) location.reload(); else { alert(j.error || "That did not work."); if (btn) btn.disabled = false; } })
        .catch(function(e){ alert(String(e)); if (btn) btn.disabled = false; });
    }
    function ack(e){ e.preventDefault();
      post("${BASE}/api/transmittal/${t.id}/acknowledge", { note: e.target.note.value }, e.target.querySelector("button")); return false; }
    function disp(e){ e.preventDefault();
      post("${BASE}/api/transmittal/${t.id}/dispute", { note: e.target.note.value }, e.target.querySelector("button")); return false; }
    function voidTx(e){ e.preventDefault();
      if (!confirm("Void ${esc(t.number)}? This cannot be undone.")) return false;
      post("${BASE}/api/transmittal/${t.id}/void", { reason: e.target.reason.value }, e.target.querySelector("button")); return false; }
    function resolveDispute(e, id){ e.preventDefault();
      post("${BASE}/api/transmittal/receipt/" + id + "/resolve", { resolution: e.target.resolution.value }, e.target.querySelector("button")); return false; }
  </script>`;

  return chrome({ title: `${t.number} · Transmittal`, body, user, active: "transmittals", wide: true });
}

// ── Compose ─────────────────────────────────────────────────
function newTransmittalPage({ engagements, candidates, people, direction, openItems }, user) {
  const isToAuditor = direction !== "to_company";

  const docRows = candidates.length
    ? candidates
        .map(
          (d) => `<tr>
      <td style="width:1%;"><input type="checkbox" name="doc" value="${d.id}" style="width:auto;"></td>
      <td>${esc(d.filename)}${d.is_gate ? ` ${pill("GATE", "#991B1B")}` : ""}
        ${d.transmitted ? ` ${pill("already sent", "#889")}` : ""}</td>
      <td><code class="xs">${esc(d.category_code || "—")}</code></td>
      <td class="sm muted">${esc(d.engagement_period || "—")}</td>
      <td class="right sm">${fmtBytes(d.size_bytes)}</td></tr>`
        )
        .join("")
    : "";

  const itemRows = (openItems || [])
    .map(
      (i) => `<tr>
      <td style="width:1%;"><input type="checkbox" name="item" value="${i.id}" style="width:auto;"></td>
      <td>${esc(String(i.label).slice(0, 110))}${i.is_gate ? ` ${pill("GATE", "#991B1B")}` : ""}</td>
      <td><code class="xs">${esc(i.category_code || "—")}</code></td>
      <td class="sm muted">${esc(i.period_label || "—")}</td>
      <td class="sm">${fmtDate(i.due_date)}</td></tr>`
    )
    .join("");

  const body = `
  <h1>Issue a transmittal</h1>
  <div class="sub">A numbered package, addressed to named people, with a receipt clock</div>

  <div class="note blue">
    Numbering is the cheap trick that makes this work. It gives both sides a noun: &ldquo;transmittal 14, sent
    the 6th, acknowledged the 8th&rdquo; ends an argument that &ldquo;the files are in the folder&rdquo; cannot
    even begin. Batching matters too — twelve files are one package and one email, because a system that
    pages a recipient twelve times is muted by week two, and a muted system is worse than none: it still
    produces a record saying the auditor was notified.
  </div>

  <form id="f">
    <div class="card">
      <h2>Direction</h2>
      <select name="direction" onchange="location.href='${BASE}/transmittal/new?direction=' + this.value">
        <option value="to_auditor" ${isToAuditor ? "selected" : ""}>Company → engagement team (sending documents)</option>
        <option value="to_company" ${!isToAuditor ? "selected" : ""}>Engagement team → company (requesting items)</option>
      </select>
      <div class="xs muted" style="margin-top:6px;">The direction decides who owes the acknowledgment, and which
        side gets chased. An auditor requesting items is not preparing the company's records, so this does not
        touch the Rule 2-01 independence boundary.</div>

      <label>Subject</label>
      <input type="text" name="subject" placeholder="${
        isToAuditor ? "e.g. Q1 bank reconciliations and statements" : "e.g. Outstanding PBC items for Q1 fieldwork"
      }">

      <label>Covering message</label>
      <textarea name="message" placeholder="What the other side should know before opening this."></textarea>

      <label>Also sent by another route?</label>
      <select name="deliveryMethod">
        <option value="portal">No — the portal only</option>
        <option value="email_attachment">Also emailed as attachments</option>
        <option value="courier">Also sent by courier or hand delivery</option>
        <option value="other">Also sent some other way</option>
      </select>
      <input type="text" name="methodNote" placeholder="Detail, if it went out another way" style="margin-top:8px;">
      <div class="xs muted" style="margin-top:6px;">Record it either way. A ledger that only knows about the tidy
        path has the same blind spot that produced the problem.</div>
    </div>

    <div class="card">
      <h2>Recipients</h2>
      ${
        people.length
          ? people
              .map(
                (p) => `<label style="font-weight:400;display:flex;gap:8px;align-items:flex-start;margin:7px 0;">
          <input type="checkbox" name="rcpt" value="${p.user_id}" checked style="width:auto;margin-top:3px;">
          <span><b>${esc(p.name)}</b> <span class="xs muted">${esc(p.email)}</span>
            <div class="xs muted">${
              p.kind === "to" ? "Will be asked to acknowledge, and chased until they do" : "Copied only"
            }</div></span></label>`
              )
              .join("")
          : `<div class="note red"><b>There is nobody to send to.</b> ${
              isToAuditor
                ? "No active auditor accounts exist yet. Create the engagement team's accounts first — until then documents will keep showing as undelivered, which is accurate."
                : "No active company accounts exist."
            } <a href="${BASE}/users">Manage users</a>.</div>`
      }
    </div>

    ${
      docRows
        ? `<div class="card tight"><div style="padding:14px 18px 0;"><h2>Documents to enclose</h2>
            <div class="sub">Most recent first. Files already transmitted are marked — re-sending is fine,
              it just creates a second package.</div></div>
          <table><tr><th></th><th>Document</th><th>Ref</th><th>Period</th><th class="right">Size</th></tr>${docRows}</table></div>`
        : `<div class="card"><h2>Documents to enclose</h2><div class="empty">No documents on file yet.</div></div>`
    }

    ${
      itemRows
        ? `<div class="card tight"><div style="padding:14px 18px 0;"><h2>Items to request</h2>
            <div class="sub">Open checklist items. These carry no bytes, so they contribute no hash to the
              manifest — the fingerprint attests to files, and a request is not a file.</div></div>
          <table><tr><th></th><th>Item</th><th>Ref</th><th>Period</th><th>Due</th></tr>${itemRows}</table></div>`
        : ""
    }

    <div class="card">
      <button class="btn ok" type="submit" ${people.length ? "" : "disabled"}>Issue and notify</button>
      <a class="btn ghost" href="${BASE}/transmittals">Cancel</a>
    </div>
  </form>

  <script>
    document.getElementById("f").addEventListener("submit", function(e){
      e.preventDefault();
      var f = e.target;
      var docs = Array.from(f.querySelectorAll('input[name=doc]:checked')).map(function(c){return Number(c.value);});
      var items = Array.from(f.querySelectorAll('input[name=item]:checked')).map(function(c){return Number(c.value);});
      var rcpt = Array.from(f.querySelectorAll('input[name=rcpt]:checked')).map(function(c){return Number(c.value);});
      if (!docs.length && !items.length) { alert("Select at least one document or one item to request."); return; }
      if (!rcpt.length) { alert("Select at least one recipient \\u2014 a package addressed to nobody would record a delivery that did not happen."); return; }
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = "Issuing\\u2026";
      fetch("${BASE}/api/transmittal/create", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          direction: f.direction.value, subject: f.subject.value, message: f.message.value,
          deliveryMethod: f.deliveryMethod.value, methodNote: f.methodNote.value,
          documentIds: docs, itemIds: items, recipientIds: rcpt })
      }).then(function(r){return r.json();}).then(function(j){
        if (j.ok) location.href = "${BASE}/transmittal/" + j.transmittal.id;
        else { alert(j.error || "Could not issue the transmittal."); btn.disabled = false; btn.textContent = "Issue and notify"; }
      }).catch(function(err){ alert(String(err)); btn.disabled = false; btn.textContent = "Issue and notify"; });
    });
  </script>`;

  return chrome({ title: "Issue a transmittal", body, user, active: "transmittals" });
}

// ── AS 1301.25 schedule of delays ───────────────────────────
function delaysPage({ report, engagementId, engagements }, user) {
  const section = (rows, title, blurb) => `
    <div class="card tight">
      <div style="padding:14px 18px 0;"><h2>${esc(title)}</h2><div class="sub">${blurb}</div></div>
      ${
        rows.length
          ? `<table><tr><th>No.</th><th>Package</th><th>Recipient</th><th>Period</th>
              <th class="right">Business days</th><th>What happened</th><th>Reminders</th></tr>
            ${rows
              .map(
                (x) => `<tr>
              <td><b>${esc(x.number)}</b></td>
              <td class="sm">${esc(String(x.subject).slice(0, 60))}
                <div class="xs muted">sent ${fmtDate(x.created_at)}${
                  x.ack_due_on ? ` · asked for by ${fmtDate(x.ack_due_on)}` : ""
                }</div></td>
              <td class="sm">${esc(x.name || x.email)}</td>
              <td class="sm muted">${esc(x.period_label || "—")}</td>
              <td class="right" style="font-weight:600;color:${
                x.businessDays > report.stalledBusinessDays ? "var(--red)" : "var(--ink)"
              };">${x.businessDays}</td>
              <td class="sm">${esc(x.reason)}${x.stillOutstanding ? ` ${pill("STILL OPEN", "#991B1B")}` : ""}
                ${x.bounce_reason ? `<div class="xs mono" style="color:var(--red);">${esc(String(x.bounce_reason).slice(0, 120))}</div>` : ""}
                ${x.dispute_note ? `<div class="xs muted">&ldquo;${esc(String(x.dispute_note).slice(0, 120))}&rdquo;</div>` : ""}</td>
              <td class="right sm">${x.reminder_count}</td></tr>`
              )
              .join("")}</table>`
          : `<div class="empty">Nothing to report here.</div>`
      }
    </div>`;

  const gates = report.openGates.length
    ? `<div class="card tight">
        <div style="padding:14px 18px 0;"><h2>Gating items still outstanding</h2>
          <div class="sub">A gate is by definition information the auditor is waiting for, so these are the
            clearest case of the delay AS 1301.25 asks about.</div></div>
        <table><tr><th>Ref</th><th>Item</th><th>Period</th><th>Was due</th><th class="right">Business days late</th></tr>
        ${report.openGates
          .map(
            (g) => `<tr>
            <td><code>${esc(g.category_code || "—")}</code></td>
            <td class="sm">${esc(String(g.label).slice(0, 100))}</td>
            <td class="sm muted">${esc(g.period_label || "—")}</td>
            <td class="sm">${fmtDate(g.due_date)}</td>
            <td class="right" style="color:var(--red);font-weight:600;">${g.businessDaysLate}</td></tr>`
          )
          .join("")}</table></div>`
    : "";

  const nothing =
    !report.toAuditor.length && !report.toCompany.length && !report.openGates.length;

  const body = `
  <div class="between"><div>
    <h1>Delays in receiving information</h1>
    <div class="sub">AS 1301.25 · schedule of difficulties encountered · generated ${fmtDateTime(
      report.generatedAt
    )}</div>
  </div><div class="row noprint">
    <button type="button" id="print-this" class="btn sm ghost">Print</button>
    <a class="btn sm ghost" href="${BASE}/transmittals">Deliveries</a>
  </div></div>

  <div class="note purple">
    AS 1301.25 requires the auditor to communicate to the audit committee any difficulties encountered during
    the audit, and names <b>delays in receiving information</b> as an example. That schedule is normally
    assembled from memory at the end of fieldwork, which is why it is always vague and always contested. This
    one is built from the delivery ledger with dates — which also means it will sometimes show that the
    delay was not the company's.
    <br><br>
    A package counts as a delay here once it has been outstanding more than
    <b>${report.stalledBusinessDays} business days</b>, or if it bounced, or if the recipient reported it
    incomplete. This is a factual schedule, not a conclusion: whether any of it was significant to the audit
    is the engagement partner's judgment.
  </div>

  ${nothing ? `<div class="card"><div class="empty">No delays recorded. Nothing has bounced, stalled or been
    reported incomplete, and no gating item is overdue.</div></div>` : ""}

  ${section(
    report.toAuditor,
    "Company → engagement team",
    "Packages the company sent that the engagement team was slow to acknowledge, or never did."
  )}
  ${section(
    report.toCompany,
    "Engagement team → company",
    "Items the engagement team requested that the company was slow to return. The direction cuts both ways, deliberately."
  )}
  ${gates}`;

  return chrome({ title: "AS 1301.25 delays", body, user, active: "transmittals", wide: true });
}

// ════════════════════════════════════════════════════════════
//  AR / AP SUBLEDGERS AND SAMPLING
// ════════════════════════════════════════════════════════════

function money(n) {
  const v = Number(n) || 0;
  return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function money0(n) {
  const v = Number(n) || 0;
  return (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString("en-US");
}

function kindLabel(k) {
  return k === "ar" ? "Receivables" : k === "ap" ? "Payables" : String(k || "").toUpperCase();
}

function riskChips(flags) {
  const sub = require("./audit-subledger");
  return (flags || [])
    .map((f) => {
      const l = sub.RISK_FLAG_LABELS[f];
      const color = f === "dated_after_period_end" || f === "contra_balance" ? "#991B1B"
        : f === "key_item" || f === "related_party" ? "#9C4221"
        : f === "cutoff_window" || f === "over_90" ? "#B45309" : "#2C5F8A";
      return `<span class="flag" style="border-color:${color}66;color:${color};background:${color}11;" title="${esc(
        l ? l[1] : ""
      )}">${esc(l ? l[0] : f.replace(/_/g, " "))}</span>`;
    })
    .join("");
}

function supportChips(have, required) {
  const sub = require("./audit-subledger");
  const req = required || [];
  const out = [];
  for (const t of req) {
    const st = sub.SUPPORT_TYPES[t];
    const got = (have || []).includes(t);
    out.push(
      `<span class="flag" title="${esc(st ? st.proves : "")}" style="border-color:${
        got ? "#1C7C54" : "#991B1B"
      }66;color:${got ? "#1C7C54" : "#991B1B"};background:${got ? "#1C7C5411" : "#991B1B11"};">${
        got ? "✓ " : "✕ "
      }${esc(st ? st.short : t)}</span>`
    );
  }
  for (const t of have || []) {
    if (req.includes(t)) continue;
    const st = sub.SUPPORT_TYPES[t];
    out.push(`<span class="flag" style="border-color:#88999966;color:#667;background:#88999911;">${esc(st ? st.short : t)}</span>`);
  }
  return out.join("") || `<span class="xs muted">nothing attached</span>`;
}

function severityPill(sev) {
  return pill(sev === "high" ? "Fix this" : sev === "medium" ? "Worth doing" : "Note", sev === "high" ? "#991B1B" : sev === "medium" ? "#B45309" : "#667");
}

function checksCard(checks) {
  if (!checks.length) {
    return `<div class="card"><h2>Readiness checks</h2>
      <div class="empty">Nothing outstanding. The aging ties, the dates are inside the period, and the supporting
        populations are on file.</div></div>`;
  }
  return `<div class="card"><h2>Readiness checks</h2>
    <div class="sub">Each of these is something the auditor will raise. Every one is cheaper to find now than
      in a review note.</div>
    ${checks
      .map(
        (c) => `<div style="padding:11px 0;border-bottom:1px solid #EFF2F5;">
      <div class="between"><div><b>${esc(c.title)}</b></div><div>${severityPill(c.severity)}</div></div>
      <div class="sm" style="margin-top:4px;">${esc(c.detail)}</div>
      <div class="xs muted" style="margin-top:5px;"><b>Do:</b> ${esc(c.fix)}${
          (c.authority || []).length ? ` &nbsp;·&nbsp; ${esc(c.authority.join(", "))}` : ""
        }</div></div>`
      )
      .join("")}</div>`;
}

/** The dashboard band. Silent unless something needs a person. */
function subledgerStrip(s, user) {
  if (!s) return "";
  const out = [];
  if (s.untied) {
    out.push(`<div class="note red"><b>${s.untied} aging${s.untied === 1 ? " has" : "s have"} not been agreed to the
      general ledger.</b> That is the first thing the auditor checks and the first thing that fails — and until it
      is done, any sample drawn from that population is built on sand.
      <a href="${BASE}/subledgers">Tie it out</a>.</div>`);
  }
  if (s.unmatched_selections) {
    out.push(`<div class="note red"><b>${s.unmatched_selections} selection${
      s.unmatched_selections === 1 ? "" : "s"
    } could not be matched to the aging you provided.</b>
      Either the sample was drawn from a different population, or the invoice is not in the aging that was handed
      over. Both are worth settling now rather than in week six.
      <a href="${BASE}/samples">Open the requests</a>.</div>`);
  }
  if (s.outstanding_selections) {
    out.push(`<div class="note amber"><b>${s.outstanding_selections} selection${
      s.outstanding_selections === 1 ? "" : "s"
    } still need support.</b>
      ${s.dueSoon && s.dueSoon.length ? `${esc(s.dueSoon[0].ref)} is due ${fmtDate(s.dueSoon[0].due_on)}. ` : ""}
      <a href="${BASE}/samples">Work the list</a>.</div>`);
  }
  if (s.ready_to_deliver) {
    out.push(`<div class="note green"><b>${s.ready_to_deliver} sample request${
      s.ready_to_deliver === 1 ? " is" : "s are"
    } complete and ready to go out.</b> Issuing it as a transmittal starts the receipt record, so there is no
      question later about whether it arrived. <a href="${BASE}/samples">Send it</a>.</div>`);
  }
  for (const k of ["ar", "ap"]) {
    const l = s.latest && s.latest[k];
    if (l && l.likelyUnsupported > 0) {
      out.push(`<div class="note blue"><b>${l.likelyUnsupported} likely-selected ${kindLabel(k).toLowerCase()} line${
        l.likelyUnsupported === 1 ? "" : "s"
      } have no support attached</b> — ${money0(l.likelyUnsupportedAmount)} of the ${kindLabel(k).toLowerCase()}
        balance. These are the large items and the ones carrying risk markers, so they are the ones most likely to be
        picked. <a href="${BASE}/subledger/${l.id}?filter=likely">Work them before the list arrives</a>.</div>`);
    }
  }
  return out.join("");
}

// ── Snapshots ───────────────────────────────────────────────
function subledgersPage({ subledgers, stats, engagements, canImport }, user) {
  const rows = subledgers.length
    ? `<table>
      <tr><th>As of</th><th>Ledger</th><th class="right">Lines</th><th class="right">Total</th>
        <th>Tie-out</th><th class="right">Likely picks</th><th>Imported</th><th></th></tr>
      ${subledgers
        .map((s) => {
          const varAbs = Math.abs(Number(s.variance) || 0);
          const tie = !s.tied_out
            ? pill("Not tied out", "#991B1B")
            : varAbs <= 0.5
            ? pill("Agreed", "#1C7C54")
            : pill(`Variance ${money0(s.variance)}`, "#B45309");
          return `<tr>
          <td><a href="${BASE}/subledger/${s.id}"><b>${fmtDate(s.as_of_date)}</b></a>
            ${s.version > 1 ? `<div class="xs muted">v${s.version}</div>` : ""}</td>
          <td>${esc(kindLabel(s.kind))}
            <div class="xs muted">${esc(s.engagement_period || "no period")}</div></td>
          <td class="right">${s.row_count}</td>
          <td class="right"><b>${money0(s.total_amount)}</b>
            ${Number(s.debit_count) ? `<div class="xs" style="color:var(--amber);">${s.debit_count} wrong-signed</div>` : ""}</td>
          <td>${tie}</td>
          <td class="right">${s.likely_count}
            <div class="xs muted">${s.lines_with_support} w/ support</div></td>
          <td class="sm muted" style="white-space:nowrap;">${fmtDate(s.imported_at)}</td>
          <td><a class="btn sm ghost" href="${BASE}/subledger/${s.id}">Open</a></td></tr>`;
        })
        .join("")}</table>`
    : `<div class="empty">No aging has been imported yet. Export an AR or AP aging <b>detail</b> report as of the
        period end — CSV or Excel, straight out of whatever you keep the books in — and drop it in below.</div>`;

  const importForm = canImport
    ? `<div class="card">
      <h2>Import an aging</h2>
      <div class="sub">An aging <b>detail</b> report, not a summary by customer: the portal needs the individual
        invoices, because those are what the auditor will select. CSV or Excel, as exported.</div>
      <form id="imp" enctype="multipart/form-data">
        <div class="grid g2">
          <div>
            <label>Which ledger</label>
            <select name="kind" required>
              <option value="ar">Accounts receivable aging</option>
              <option value="ap">Accounts payable aging</option>
            </select>
            <label>As of (the period end the aging was run at)</label>
            <input type="date" name="asOfDate" required>
            <label>Engagement (optional)</label>
            <select name="engagementId">
              <option value="">— work it out from the date —</option>
              ${engagements
                .map((e) => `<option value="${e.id}">${esc(e.period_label)}${e.period_name ? ` — ${esc(e.period_name)}` : ""}</option>`)
                .join("")}
            </select>
          </div>
          <div>
            <label>General-ledger balance for this account as of that date (optional, but do it now)</label>
            <input type="text" name="glBalance" placeholder="e.g. 1842355.17">
            <label>Source of that balance</label>
            <input type="text" name="glSource" placeholder="e.g. trial balance 1200 Accounts Receivable">
            <label>Auditor's individual-testing threshold, if they have shared it (optional)</label>
            <input type="text" name="keyItemThreshold" placeholder="leave blank if they have not">
            <div class="xs muted" style="margin-top:5px;">Blank is the honest answer when you do not have it. The
              portal will not invent a materiality figure and then present the worklist as if it knew their sample.</div>
          </div>
        </div>
        <label>File</label>
        <input type="file" name="file" accept=".csv,.xlsx,.xls,.txt" required>
        <div class="row" style="margin-top:13px;">
          <button class="btn" type="submit">Import</button>
          <span class="xs muted">Column headings are detected automatically, including the title rows above them.</span>
        </div>
      </form>
      <div class="note blue" style="margin-top:14px;">
        <b>The tie-out is what proves the import read your file correctly.</b> If the amount column were picked up
        wrongly the total would not agree to the general ledger, so entering the GL balance is both the
        reconciliation the auditor wants and the check that this worked. Re-importing supersedes cleanly, and the
        old population is kept, because it is what was tested.
      </div>
      <div id="impout"></div>
    </div>
    <script>
      document.getElementById("imp").addEventListener("submit", function(e){
        e.preventDefault();
        var btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = "Importing\\u2026";
        var fd = new FormData(e.target);
        fetch("${BASE}/api/subledger/import", { method:"POST", body: fd })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if (j.ok) { location.href = "${BASE}/subledger/" + j.subledger.subledger.id; return; }
            document.getElementById("impout").innerHTML =
              '<div class="note red">' + (j.error || "Could not read that file.") + '</div>';
            btn.disabled = false; btn.textContent = "Import";
          })
          .catch(function(err){
            document.getElementById("impout").innerHTML = '<div class="note red">' + String(err) + '</div>';
            btn.disabled = false; btn.textContent = "Import";
          });
      });
    </script>`
    : "";

  const body = `
  <div class="between"><div>
    <h1>Receivables &amp; payables</h1>
    <div class="sub">A frozen population that ties to the ledger, with the evidence filed against it</div>
  </div><a class="btn ghost" href="${BASE}/samples">Sample requests${
    stats.open_requests ? ` (${stats.open_requests})` : ""
  }</a></div>

  <div class="grid g4" style="margin-bottom:16px;">
    <div class="stat"><div class="n" style="color:${stats.untied ? "var(--red)" : "var(--green)"}">${stats.untied}</div>
      <div class="l">Not tied out</div><div class="x">Of ${stats.snapshots} active</div></div>
    <div class="stat"><div class="n">${stats.open_requests}</div><div class="l">Open requests</div>
      <div class="x">${stats.outstanding_selections} selections outstanding</div></div>
    <div class="stat"><div class="n" style="color:${stats.unmatched_selections ? "var(--red)" : "var(--ink)"}">${
    stats.unmatched_selections
  }</div>
      <div class="l">Unmatched</div><div class="x">Not in the aging given</div></div>
    <div class="stat"><div class="n" style="color:${stats.ready_to_deliver ? "var(--green)" : "var(--ink)"}">${
    stats.ready_to_deliver
  }</div><div class="l">Ready to send</div><div class="x">Complete, not yet delivered</div></div>
  </div>

  <div class="note blue">
    <b>The thing that costs weeks is not the missing document, it is the missing index.</b> A receivable exists in
    the accounting system as a number; the evidence that the number is real — the invoice, the delivery receipt,
    the cash that arrived — lives in somebody's inbox. Keying that evidence to the invoice number, once, is what
    turns "here are our forty selections" from an archaeology project into a worklist.
  </div>

  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Imported agings</h2></div>${rows}</div>
  ${importForm}`;

  return chrome({ title: "Receivables & payables", body, user, active: "subledgers", wide: true });
}

// ── One snapshot ────────────────────────────────────────────
function subledgerDetailPage(
  { data, checks, readiness: rd, lines, lineTotal, lineTotalAmount, filter, q, risk, people, canImport },
  user
) {
  const s = data.subledger;
  const sub = require("./audit-subledger");
  const varAbs = Math.abs(Number(s.variance) || 0);

  const buckets = [
    ["Current", s.bucket_current],
    ["1–30", s.bucket_1_30],
    ["31–60", s.bucket_31_60],
    ["61–90", s.bucket_61_90],
    ["Over 90", s.bucket_over_90],
  ];
  const bucketTotal = buckets.reduce((a, b) => a + Math.abs(Number(b[1]) || 0), 0) || 1;

  const tieOutPanel = s.tied_out
    ? `<div class="note ${varAbs <= 0.5 ? "green" : "amber"}">
        <b>${
          varAbs <= 0.5
            ? "Agreed to the general ledger."
            : `Tied out with a variance of ${money(s.variance)}.`
        }</b>
        Subledger ${money(s.total_amount)} against general ledger ${money(s.gl_balance)}${
        s.gl_source ? `, per ${esc(s.gl_source)}` : ""
      }. Recorded ${fmtDateTime(s.tied_out_at)}${s.tied_out_by_name ? ` by ${esc(s.tied_out_by_name)}` : ""}.
        ${s.tie_out_note ? `<br><b>Explanation:</b> ${esc(s.tie_out_note)}` : ""}
        <br><span class="xs">A reconciliation is final once recorded. A corrected aging is imported as a new
        snapshot, which supersedes this one without destroying it — this population is what was tested.</span>
      </div>`
    : `<div class="card" style="border-color:var(--red);border-width:2px;">
        <h2>Agree it to the general ledger</h2>
        <p class="sm" style="margin-top:0;">This is the first thing the auditor does with an aging and the first
          thing that fails. It is also the check that the import read your file correctly: if the amount column had
          been picked up wrongly, the total below would not agree.</p>
        <div class="row" style="margin-bottom:10px;">
          <div class="stat" style="flex:1;"><div class="n">${money0(s.total_amount)}</div>
            <div class="l">This aging totals</div><div class="x">${s.row_count} open items</div></div>
        </div>
        <form onsubmit="return tieOut(event)">
          <label>General-ledger balance for this account as of ${fmtDate(s.as_of_date)}</label>
          <input type="text" name="glBalance" required placeholder="e.g. 1842355.17">
          <label>Where that came from</label>
          <input type="text" name="glSource" placeholder="e.g. trial balance account 1200">
          <label>Explanation, if there is a difference</label>
          <textarea name="note" placeholder="Required when the two do not agree. An unexplained variance is the finding, and it is far cheaper to write down now than to reconstruct in February."></textarea>
          <button class="btn" type="submit" style="margin-top:11px;">Record the tie-out</button>
        </form>
      </div>`;

  const readinessCard = `
  <div class="card">
    <div class="between"><h2>Support coverage</h2>
      <div class="xs muted">${esc(rd.required.map((t) => sub.SUPPORT_TYPES[t].label).join(" + "))}</div></div>
    <div class="grid g2">
      <div>
        <div class="between"><div class="sm"><b>By dollars</b></div><div class="sm"><b>${rd.dollarsPct}%</b></div></div>
        <div class="bar"><i style="width:${rd.dollarsPct}%;background:${
    rd.dollarsPct >= 90 ? "var(--green)" : rd.dollarsPct >= 50 ? "var(--amber)" : "var(--red)"
  };"></i></div>
        <div class="xs muted" style="margin-top:4px;">${money0(rd.dollarsComplete)} of ${money0(rd.dollars)}</div>
      </div>
      <div>
        <div class="between"><div class="sm">By line count</div><div class="sm">${rd.linesPct}%</div></div>
        <div class="bar"><i style="width:${rd.linesPct}%;background:#99A;"></i></div>
        <div class="xs muted" style="margin-top:4px;">${rd.linesComplete} of ${rd.lines} lines${
    rd.onlyLikely ? " (likely picks only)" : ""
  }</div>
      </div>
    </div>
    <div class="note blue" style="margin-bottom:0;">
      <b>The dollar figure is the one that matters.</b> 95% of lines covered while the three largest invoices are
      missing is not 95% ready, it is zero — they sample by dollars, and the largest items are tested
      individually rather than sampled at all.
    </div>
    ${
      Object.keys(rd.missingByType).length
        ? `<table style="margin-top:6px;"><tr><th>Missing</th><th class="right">Lines</th><th class="right">Dollars</th></tr>
            ${Object.entries(rd.missingByType)
              .filter(([, v]) => v.lines)
              .map(
                ([k, v]) =>
                  `<tr><td>${esc(v.label)}<div class="xs muted">${esc(sub.SUPPORT_TYPES[k].proves)}</div></td>
                   <td class="right">${v.lines}</td><td class="right">${money0(v.dollars)}</td></tr>`
              )
              .join("") || `<tr><td colspan="3" class="muted sm">Nothing missing.</td></tr>`}</table>`
        : ""
    }
  </div>`;

  const FILTERS = [
    ["", `All ${lineTotal ? "" : ""}`],
    ["likely", "Likely picks"],
    ["unsupported", "No support"],
    ["contra", "Wrong-signed"],
    ["over_90", "Over 90 days"],
    ["related", "Related party"],
    ["after_period", "Dated after period end"],
  ];
  const chips = FILTERS.map(
    ([k, label]) =>
      `<a class="btn sm ${k === (filter || "") ? "" : "ghost"}" href="${BASE}/subledger/${s.id}${
        k ? `?filter=${k}` : ""
      }">${esc(label.trim())}</a>`
  ).join(" ");

  const supportOptions = Object.entries(sub.SUPPORT_TYPES)
    .filter(([, v]) => v.kinds.includes(s.kind))
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
    .join("");

  const lineRows = lines.length
    ? lines
        .map(
          (l) => `<tr>
      <td class="right muted xs">${l.line_no}</td>
      <td><b>${esc(l.counterparty_name)}</b>
        <div class="xs muted">${esc(l.doc_number || "no number")}${l.po_number ? ` · PO ${esc(l.po_number)}` : ""}</div></td>
      <td class="sm">${fmtDate(l.doc_date)}<div class="xs muted">${
            l.due_date ? "due " + fmtDate(l.due_date) : ""
          }</div></td>
      <td class="right"><b>${money(l.open_amount)}</b>
        <div class="xs muted">${l.days_outstanding == null ? "" : l.days_outstanding + "d"}</div></td>
      <td>${riskChips(l.risk_flags)}</td>
      <td>${supportChips(l.support_types, rd.required)}</td>
      <td style="width:1%;"><details><summary>Attach</summary>
        <form class="noprint" enctype="multipart/form-data" onsubmit="return addSupport(event, ${l.id})"
          style="min-width:230px;padding:6px 0;">
          <select name="supportType" required>${supportOptions}</select>
          <input type="file" name="file" required style="margin-top:6px;">
          <input type="text" name="note" placeholder="note (optional)" style="margin-top:6px;">
          <button class="btn sm" type="submit" style="margin-top:7px;">Upload &amp; file</button>
        </form></details></td></tr>`
        )
        .join("")
    : "";

  const body = `
  <div class="between"><div>
    <h1>${esc(kindLabel(s.kind))} as of ${fmtDate(s.as_of_date)}</h1>
    <div class="sub">${s.row_count} open items · ${money(s.total_amount)} · ${s.counterparty_count}
      ${s.kind === "ar" ? "customers" : "vendors"} · imported ${fmtDateTime(s.imported_at)}${
    s.imported_by_name ? ` by ${esc(s.imported_by_name)}` : ""
  }${s.version > 1 ? ` · version ${s.version}` : ""}</div>
  </div><div class="row">
    ${s.status === "superseded" ? pill("SUPERSEDED", "#889") : ""}
    ${s.document_id ? `<a class="btn sm ghost" href="${BASE}/document/${s.document_id}">Source file</a>` : ""}
    <a class="btn sm ghost" href="${BASE}/subledgers">All agings</a>
  </div></div>

  ${
    s.status === "superseded"
      ? `<div class="note amber"><b>A later version of this aging has been imported.</b> This one is kept because it
          is the population that was tested — a sample drawn from it still points here.</div>`
      : ""
  }

  ${tieOutPanel}

  <div class="grid g2">
    <div class="card">
      <h2>Aging</h2>
      <table>${buckets
        .map(
          ([label, v]) => `<tr>
        <td style="width:80px;">${esc(label)}</td>
        <td style="min-width:120px;"><div class="bar"><i style="width:${
          Math.round((Math.abs(Number(v) || 0) / bucketTotal) * 100)
        }%;background:${label === "Over 90" ? "var(--red)" : label === "61–90" ? "var(--amber)" : "var(--navy2)"};"></i></div></td>
        <td class="right">${money0(v)}</td></tr>`
        )
        .join("")}</table>
      ${
        s.key_item_threshold
          ? `<div class="xs muted" style="margin-top:9px;">Individual-testing threshold
              <b>${money0(s.key_item_threshold)}</b>${s.threshold_source ? ` (${esc(s.threshold_source)})` : ""}.</div>`
          : `<div class="xs muted" style="margin-top:9px;">No individual-testing threshold has been shared, so the
              likely-picks list is the largest items plus risk markers rather than a prediction of their sample.
              ${canImport ? `<a href="#" onclick="setThreshold();return false;">Enter one if the auditor gives you theirs</a>.` : ""}</div>`
      }
    </div>
    <div class="card">
      <h2>Concentration</h2>
      <table>${data.concentration
        .map(
          (c) => `<tr><td>${esc(c.counterparty_name)}<div class="xs muted">${c.lines} item${
            c.lines === 1 ? "" : "s"
          }</div></td>
          <td class="right">${money0(c.amount)}</td>
          <td class="right" style="width:60px;color:${c.pct >= 10 ? "var(--amber)" : "inherit"};font-weight:${
            c.pct >= 10 ? 600 : 400
          };">${c.pct}%</td></tr>`
        )
        .join("")}</table>
      ${
        data.concentration[0] && data.concentration[0].pct >= 10
          ? `<div class="xs muted" style="margin-top:8px;">A concentration at this level is a disclosure question
              under ASC 275-10-50-20, separately from collectability.</div>`
          : ""
      }
    </div>
  </div>

  ${readinessCard}
  ${checksCard(checks)}

  <div class="card tight">
    <div style="padding:14px 18px 0;">
      <div class="between"><h2>Transactions</h2>
        <form method="GET" action="${BASE}/subledger/${s.id}" class="row">
          ${filter ? `<input type="hidden" name="filter" value="${esc(filter)}">` : ""}
          <input type="text" name="q" value="${esc(q || "")}" placeholder="invoice number or name"
            style="width:220px;">
          <button class="btn sm ghost" type="submit">Find</button>
        </form></div>
      <div class="row" style="margin:4px 0 10px;">${chips}</div>
      <div class="sub">${lineTotal} line${lineTotal === 1 ? "" : "s"} · ${money0(lineTotalAmount)}${
    lines.length < lineTotal ? ` · showing the largest ${lines.length}` : ""
  }</div>
    </div>
    ${
      lineRows
        ? `<table><tr><th class="right">#</th><th>${s.kind === "ar" ? "Customer" : "Vendor"} / invoice</th>
            <th>Date</th><th class="right">Open</th><th>Why it may be picked</th><th>Support</th><th></th></tr>
          ${lineRows}</table>`
        : `<div class="empty">Nothing matches that.</div>`
    }
  </div>

  <script>
    function tieOut(e){ e.preventDefault();
      var f=e.target, btn=f.querySelector('button');
      btn.disabled=true;
      fetch("${BASE}/api/subledger/${s.id}/tie-out", { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ glBalance:f.glBalance.value, glSource:f.glSource.value, note:f.note.value }) })
        .then(function(r){return r.json();}).then(function(j){
          if (j.ok) location.reload(); else { alert(j.error); btn.disabled=false; } })
        .catch(function(x){ alert(String(x)); btn.disabled=false; });
      return false; }
    function addSupport(e, lineId){ e.preventDefault();
      var f=e.target, btn=f.querySelector('button');
      btn.disabled=true; btn.textContent="Uploading\\u2026";
      var fd=new FormData(f); fd.append("lineId", lineId);
      fetch("${BASE}/api/subledger/support", { method:"POST", body: fd })
        .then(function(r){return r.json();}).then(function(j){
          if (j.ok) location.reload();
          else { alert(j.error); btn.disabled=false; btn.textContent="Upload & file"; } })
        .catch(function(x){ alert(String(x)); btn.disabled=false; btn.textContent="Upload & file"; });
      return false; }
    function setThreshold(){
      var v = prompt("Individual-testing threshold the auditor gave you (dollars). Blank to clear.");
      if (v === null) return;
      fetch("${BASE}/api/subledger/${s.id}/threshold", { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ threshold: v === "" ? null : v, source: "supplied by the auditor" }) })
        .then(function(r){return r.json();}).then(function(j){ if (j.ok) location.reload(); else alert(j.error); }); }
  </script>`;

  return chrome({ title: `${kindLabel(s.kind)} ${fmtDate(s.as_of_date)}`, body, user, active: "subledgers", wide: true });
}

// ── Sample requests ─────────────────────────────────────────
function samplesPage({ requests, subledgers, status, canCreate }, user) {
  const sub = require("./audit-subledger");
  const rows = requests.length
    ? `<table><tr><th>Ref</th><th>Procedure</th><th>Population</th><th class="right">Selections</th>
        <th>Progress</th><th>Due</th><th>From</th></tr>
      ${requests
        .map((r) => {
          const pct = r.total ? Math.round((r.complete / r.total) * 100) : 0;
          return `<tr>
          <td><a href="${BASE}/sample/${r.id}"><b>${esc(r.ref)}</b></a>
            <div class="xs muted">${esc(r.kind.toUpperCase())}</div></td>
          <td>${esc((sub.PROCEDURES[r.procedure] || { label: r.procedure }).label)}
            <div class="xs muted">${esc(String(r.label).slice(0, 60))}</div></td>
          <td class="sm muted">${fmtDate(r.as_of_date)}<div class="xs">${esc(r.period_label || "")}</div></td>
          <td class="right">${r.total}
            ${r.unmatched ? `<div class="xs" style="color:var(--red);">${r.unmatched} unmatched</div>` : ""}</td>
          <td style="min-width:110px;"><div class="bar"><i style="width:${pct}%;background:${
            pct === 100 ? "var(--green)" : "var(--navy2)"
          };"></i></div><div class="xs muted" style="margin-top:2px;">${r.complete}/${r.total}</div></td>
          <td class="sm ${r.due_on && daysUntil(r.due_on) < 0 ? "" : "muted"}" style="${
            r.due_on && daysUntil(r.due_on) < 0 ? "color:var(--red);font-weight:600;" : ""
          }">${fmtDate(r.due_on)}</td>
          <td class="sm muted">${esc(r.requested_by_firm || "—")}
            ${r.status !== "open" ? `<div>${statusPill(r.status === "delivered" ? "report_released" : "satisfied")}</div>` : ""}</td></tr>`;
        })
        .join("")}</table>`
    : `<div class="empty">No sample requests recorded.</div>`;

  const active = subledgers.filter((s) => s.status === "active");
  const form = canCreate
    ? `<div class="card">
      <h2>Record a selection list</h2>
      <div class="sub">Paste what the auditor sent. A header row of Selection, Customer, Invoice, Date, Amount is
        surest, but a block copied straight out of Excel works too.</div>
      <form id="sam">
        <div class="grid g2">
          <div>
            <label>Population it was drawn from</label>
            <select name="subledgerId" required id="subsel">
              ${active
                .map(
                  (s) =>
                    `<option value="${s.id}" data-kind="${s.kind}">${esc(kindLabel(s.kind))} — ${fmtDate(
                      s.as_of_date
                    )} (${s.row_count} items${s.tied_out ? ", tied out" : ", NOT tied out"})</option>`
                )
                .join("")}
            </select>
            <label>Procedure</label>
            <select name="procedure" required id="procsel">
              ${Object.entries(sub.PROCEDURES)
                .map(([k, v]) => `<option value="${k}" data-kind="${v.kind || ""}">${esc(v.label)}</option>`)
                .join("")}
            </select>
            <div class="xs muted" id="procnote" style="margin-top:6px;"></div>
          </div>
          <div>
            <label>Which firm sent it</label>
            <input type="text" name="requestedByFirm" placeholder="e.g. TAAD, LLP" required>
            <label>Who at the firm (optional)</label>
            <input type="text" name="requestedByName">
            <div class="grid g2" style="gap:9px;">
              <div><label>Received on</label><input type="date" name="receivedOn"></div>
              <div><label>Due back</label><input type="date" name="dueOn"></div>
            </div>
          </div>
        </div>
        <label>The selections</label>
        <textarea name="list" required style="min-height:150px;font-family:ui-monospace,Menlo,monospace;font-size:12px;"
          placeholder="Selection&#9;Customer&#9;Invoice&#9;Date&#9;Amount&#10;1&#9;Acme Foods Inc&#9;INV-10433&#9;9/12/2026&#9;48,210.00&#10;2&#9;Harbor Distributing&#9;INV-10512&#9;9/24/2026&#9;31,005.50"></textarea>
        <div class="row" style="margin-top:12px;">
          <button class="btn" type="submit">Match against the aging</button>
          <span class="xs muted">Nothing is sent to anyone — this builds the worklist.</span>
        </div>
      </form>
      <div class="note amber" style="margin-top:14px;">
        <b>The record will say the auditor chose this sample and that you transcribed it.</b> Those are different
        facts and the portal keeps them apart, because a record implying the company selected its own audit sample
        is both wrong and reads very badly later. Attach their file to the request once it exists.
      </div>
      <div id="samout"></div>
    </div>
    <script>
      var PROCS = ${JSON.stringify(
        Object.fromEntries(Object.entries(sub.PROCEDURES).map(([k, v]) => [k, { note: v.note, kind: v.kind, requires: v.requires }]))
      )};
      function syncProc(){
        var p = document.getElementById("procsel").value;
        var d = PROCS[p] || {};
        document.getElementById("procnote").textContent = d.note || "";
      }
      document.getElementById("procsel").addEventListener("change", syncProc); syncProc();
      document.getElementById("sam").addEventListener("submit", function(e){
        e.preventDefault();
        var f = e.target, btn = f.querySelector('button[type=submit]');
        var opt = document.getElementById("subsel").selectedOptions[0];
        btn.disabled = true; btn.textContent = "Matching\\u2026";
        fetch("${BASE}/api/sample/create", { method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ subledgerId: Number(f.subledgerId.value), kind: opt.dataset.kind,
            procedure: f.procedure.value, requestedByFirm: f.requestedByFirm.value,
            requestedByName: f.requestedByName.value, receivedOn: f.receivedOn.value || null,
            dueOn: f.dueOn.value || null, list: f.list.value }) })
          .then(function(r){return r.json();}).then(function(j){
            if (j.ok) { location.href = "${BASE}/sample/" + j.request.request.id; return; }
            document.getElementById("samout").innerHTML = '<div class="note red">' + (j.error||"Could not read that list.") + '</div>';
            btn.disabled = false; btn.textContent = "Match against the aging";
          }).catch(function(x){
            document.getElementById("samout").innerHTML = '<div class="note red">' + String(x) + '</div>';
            btn.disabled = false; btn.textContent = "Match against the aging"; });
      });
    </script>`
    : "";

  const body = `
  <div class="between"><div>
    <h1>Sample requests</h1>
    <div class="sub">A selection list, matched to the population, with the gaps and their owners</div>
  </div><div class="row">
    ${["open", "complete", "delivered", "all"]
      .map(
        (k) =>
          `<a class="btn sm ${k === status ? "" : "ghost"}" href="${BASE}/samples?status=${k}">${
            k[0].toUpperCase() + k.slice(1)
          }</a>`
      )
      .join(" ")}
    <a class="btn sm ghost" href="${BASE}/subledgers">Agings</a>
  </div></div>
  <div class="card tight"><div style="padding:14px 18px 0;"><h2>Requests</h2></div>${rows}</div>
  ${form}`;

  return chrome({ title: "Sample requests", body, user, active: "subledgers", wide: true });
}

// ── One request: the worklist ───────────────────────────────
function sampleDetailPage({ data, people, canWork }, user) {
  const sub = require("./audit-subledger");
  const r = data.request;
  const proc = data.procedure;
  const required = r.required_support || [];
  const confirmationOnly = !!proc.companySuppliesOnly;

  const supportOptions = Object.entries(sub.SUPPORT_TYPES)
    .filter(([k, v]) => v.kinds.includes(r.kind) && (!confirmationOnly || k === "counterparty_contact" || k === "other"))
    .map(([k, v]) => `<option value="${k}"${required.includes(k) ? " selected" : ""}>${esc(v.label)}</option>`)
    .join("");

  const rows = data.selections
    .map((s) => {
      const badge =
        s.status === "complete"
          ? pill("Complete", "#1C7C54")
          : s.status === "waived"
          ? pill("Waived", "#889")
          : s.status === "unmatched"
          ? pill("NOT IN THE AGING", "#991B1B")
          : s.status === "partial"
          ? pill("Partial", "#B45309")
          : pill("Open", "#B45309");
      return `<tr>
      <td class="right"><b>${esc(s.selection_no)}</b></td>
      <td>
        <div><b>${esc(s.given_counterparty || "—")}</b> <span class="xs muted">as the auditor wrote it</span></div>
        <div class="xs muted">${esc(s.given_doc_number || "no number")} · ${fmtDate(s.given_doc_date)} · ${
        s.given_amount == null ? "no amount" : money(s.given_amount)
      }</div>
        ${
          s.line_id
            ? `<div class="xs" style="margin-top:3px;color:var(--green);">→ line ${s.line_no}: ${esc(
                s.counterparty_name
              )} ${esc(s.doc_number || "")} ${money(s.open_amount)}
                <span class="muted">(${esc(String(s.match_method || "").replace(/_/g, " "))})</span></div>`
            : `<div class="xs" style="margin-top:3px;color:var(--red);">${esc(s.match_note || "No match found.")}</div>`
        }
        ${s.given_note ? `<div class="xs" style="color:var(--amber);margin-top:3px;">${esc(s.given_note)}</div>` : ""}
        ${s.waiver_reason ? `<div class="xs muted" style="margin-top:3px;"><b>Waived:</b> ${esc(s.waiver_reason)}</div>` : ""}
      </td>
      <td>${badge}${s.risk_flags && s.risk_flags.length ? `<div style="margin-top:4px;">${riskChips(s.risk_flags)}</div>` : ""}</td>
      <td>${supportChips(s.have, required)}
        ${
          s.support.length
            ? `<details style="margin-top:5px;"><summary class="xs">${s.support.length} file${
                s.support.length === 1 ? "" : "s"
              }</summary>${s.support
                .map(
                  (x) =>
                    `<div class="xs" style="padding:2px 0;"><a href="${BASE}/document/${x.document_id}">${esc(
                      x.filename
                    )}</a> <span class="muted">${esc(
                      sub.SUPPORT_TYPES[x.support_type] ? sub.SUPPORT_TYPES[x.support_type].short : x.support_type
                    )}</span>${
                      canWork
                        ? ` <a href="#" onclick="dropSupport(${x.id});return false;" style="color:var(--red);">remove</a>`
                        : ""
                    }</div>`
                )
                .join("")}</details>`
            : ""
        }</td>
      <td class="sm">${esc(s.assigned_to_name || "—")}</td>
      <td style="width:1%;">${
        canWork && s.status !== "waived"
          ? `<details><summary>Work</summary><div style="min-width:250px;padding:6px 0;">
              ${
                s.line_id
                  ? `<form enctype="multipart/form-data" onsubmit="return addSupport(event, ${s.line_id})">
                      <select name="supportType" required>${supportOptions}</select>
                      <input type="file" name="file" required style="margin-top:6px;">
                      <button class="btn sm" type="submit" style="margin-top:7px;">Upload &amp; file</button>
                    </form>`
                  : `<div class="xs" style="color:var(--red);margin-bottom:7px;">Match it to a line before attaching
                      anything — otherwise the document is filed against nothing.</div>
                     <form onsubmit="return manualMatch(event, ${s.id})">
                       <input type="text" name="q" placeholder="search the aging" required>
                       <button class="btn sm ghost" type="submit" style="margin-top:6px;">Search</button>
                     </form>`
              }
              <form onsubmit="return assign(event, ${s.id})" style="margin-top:9px;">
                <select name="userId"><option value="">— unassigned —</option>
                  ${people.map((p) => `<option value="${p.id}"${p.id === s.assigned_to ? " selected" : ""}>${esc(p.name)}</option>`).join("")}
                </select>
                <button class="btn sm ghost" type="submit" style="margin-top:6px;">Assign</button>
              </form>
              <form onsubmit="return waive(event, ${s.id})" style="margin-top:9px;">
                <input type="text" name="reason" placeholder="why it cannot be produced" required minlength="10">
                <button class="btn sm danger" type="submit" style="margin-top:6px;">Waive</button>
              </form>
            </div></details>`
          : ""
      }</td></tr>`;
    })
    .join("");

  const body = `
  <div class="between"><div>
    <h1>${esc(r.ref)} — ${esc(proc.label)}</h1>
    <div class="sub">${esc(kindLabel(r.kind))} as of ${fmtDate(r.as_of_date)}${
    r.period_label ? ` · ${esc(r.period_label)}` : ""
  } · ${data.counts.total} selection${data.counts.total === 1 ? "" : "s"}${
    r.due_on ? ` · due ${fmtDate(r.due_on)}` : ""
  }</div>
  </div><div class="row">
    ${
      r.status === "delivered"
        ? `<a class="btn sm ghost" href="${BASE}/transmittal/${r.transmittal_id}">Delivered — see the receipt</a>`
        : data.counts.complete + data.counts.waived === data.counts.total && canWork
        ? `<button class="btn ok" onclick="deliver()">Issue as a transmittal</button>`
        : ""
    }
    <a class="btn sm ghost" href="${BASE}/api/sample/${r.id}/package.zip">Download the package</a>
    <a class="btn sm ghost" href="${BASE}/samples">All requests</a>
  </div></div>

  <div class="note blue">
    <b>${esc(proc.label)}.</b> ${esc(proc.note)}
    ${(proc.authority || []).length ? `<br><span class="xs">${esc(proc.authority.join(" · "))}</span>` : ""}
  </div>

  ${
    confirmationOnly
      ? `<div class="note red">
          <b>Do not collect confirmation responses, and do not contact the customer about the confirmation.</b>
          AS 2310.15 requires the auditor to select the items, send the requests and receive the responses. A reply
          that passed through the company is not confirmation evidence — submitting one does not speed the audit
          up, it voids the procedure and forces it to be done again. What you provide here is verified contact
          detail, and nothing else is accepted on this request.
        </div>`
      : ""
  }

  ${
    !r.tied_out
      ? `<div class="note red"><b>The aging this sample was drawn from has not been agreed to the general ledger.</b>
          Do that first — if the population does not tie, the sample does not mean anything regardless of how
          well it is supported. <a href="${BASE}/subledger/${r.subledger_id}">Tie it out</a>.</div>`
      : ""
  }

  ${
    data.counts.unmatched
      ? `<div class="note red"><b>${data.counts.unmatched} selection${
          data.counts.unmatched === 1 ? "" : "s"
        } could not be found in this aging.</b>
        Before chasing documents, settle which population they are working from. The usual cause is that the
        selections were drawn from a different aging than the one that was handed over, and that is a five-minute
        email rather than a week of searching.</div>`
      : ""
  }

  <div class="grid g4" style="margin-bottom:16px;">
    <div class="stat"><div class="n" style="color:${data.dollarsPct >= 100 ? "var(--green)" : "var(--ink)"}">${
    data.dollarsPct
  }%</div><div class="l">Covered by dollars</div>
      <div class="x">${money0(data.dollarsComplete)} of ${money0(data.dollars)}</div></div>
    <div class="stat"><div class="n">${data.counts.complete}</div><div class="l">Complete</div>
      <div class="x">Of ${data.counts.total}</div></div>
    <div class="stat"><div class="n" style="color:${
      data.counts.open + data.counts.partial ? "var(--amber)" : "var(--ink)"
    }">${data.counts.open + data.counts.partial}</div><div class="l">Still needed</div>
      <div class="x">${data.counts.partial} part-done</div></div>
    <div class="stat"><div class="n" style="color:${data.counts.unmatched ? "var(--red)" : "var(--ink)"}">${
    data.counts.unmatched
  }</div><div class="l">Unmatched</div><div class="x">${data.counts.waived} waived</div></div>
  </div>

  <div class="card">
    <h3>Provenance</h3>
    <table style="font-size:12.5px;">
      <tr><td style="width:34%;color:var(--mute);">Selections chosen by</td><td><b>${esc(
        r.requested_by_firm || "not recorded"
      )}</b>${r.requested_by_name ? ` — ${esc(r.requested_by_name)}` : ""}</td></tr>
      <tr><td style="color:var(--mute);">Entered in the portal by</td><td>${esc(r.entered_by_name || "—")} on ${fmtDateTime(
    r.entered_at
  )}</td></tr>
      <tr><td style="color:var(--mute);">How</td><td>${esc(
        String(r.selections_source).replace(/_/g, " ")
      )}${
    r.source_filename
      ? ` · <a href="${BASE}/document/${r.source_document_id}">${esc(r.source_filename)}</a>`
      : ` · <span style="color:var(--amber);">their own file is not attached</span>`
  }</td></tr>
      <tr><td style="color:var(--mute);">Support required per selection</td><td>${esc(
        required.map((t) => sub.SUPPORT_TYPES[t].label).join(" + ") || "—"
      )}</td></tr>
    </table>
    <div class="xs muted">Who chose the sample and who typed it in are kept apart deliberately. Under AS 2315 and
      AS 2310.15 the auditor selects the items, and a record implying the company selected its own audit sample
      would be both wrong and hard to explain.</div>
  </div>

  <div class="card tight">
    <div style="padding:14px 18px 0;"><h2>Selections</h2>
      <div class="sub">The left column is what the auditor wrote, verbatim. Where their list and the aging
        disagree, that disagreement is the finding — it is not tidied up to make the match work.</div></div>
    <table><tr><th class="right">#</th><th>Selection</th><th>State</th><th>Support</th><th>Owner</th><th></th></tr>
      ${rows}</table>
  </div>

  <div id="matchbox"></div>

  <script>
    function post(url, payload){
      return fetch(url, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload||{}) })
        .then(function(r){return r.json();}).then(function(j){
          if (j.ok) location.reload(); else alert(j.error || "That did not work."); });
    }
    function addSupport(e, lineId){ e.preventDefault();
      var f=e.target, btn=f.querySelector('button');
      btn.disabled=true; btn.textContent="Uploading\\u2026";
      var fd=new FormData(f); fd.append("lineId", lineId);
      fetch("${BASE}/api/subledger/support", { method:"POST", body: fd })
        .then(function(r){return r.json();}).then(function(j){
          if (j.ok) location.reload(); else { alert(j.error); btn.disabled=false; btn.textContent="Upload & file"; } })
        .catch(function(x){ alert(String(x)); btn.disabled=false; btn.textContent="Upload & file"; });
      return false; }
    function assign(e, id){ e.preventDefault();
      post("${BASE}/api/selection/" + id + "/assign", { userId: e.target.userId.value || null }); return false; }
    function waive(e, id){ e.preventDefault();
      post("${BASE}/api/selection/" + id + "/waive", { reason: e.target.reason.value }); return false; }
    function dropSupport(id){ if(!confirm("Remove this support link? The document itself is kept.")) return;
      post("${BASE}/api/subledger/support/" + id + "/remove", {}); }
    function manualMatch(e, selId){ e.preventDefault();
      var q = e.target.q.value;
      fetch("${BASE}/api/subledger/${r.subledger_id}/lines?q=" + encodeURIComponent(q) + "&limit=12")
        .then(function(r){return r.json();}).then(function(j){
          if (!j.ok || !j.lines.length) { alert("Nothing in the aging matches that."); return; }
          var html = '<div class="card"><h2>Pick the line for selection ' + selId + '</h2><table>' +
            j.lines.map(function(l){
              return '<tr><td>' + l.line_no + '</td><td>' + l.counterparty_name + '</td><td>' +
                (l.doc_number||'') + '</td><td class="right">' + l.open_amount + '</td>' +
                '<td><button class="btn sm" onclick="pick(' + selId + ',' + l.id + ')">This one</button></td></tr>';
            }).join('') + '</table></div>';
          document.getElementById("matchbox").innerHTML = html;
          document.getElementById("matchbox").scrollIntoView();
        });
      return false; }
    function pick(selId, lineId){
      post("${BASE}/api/selection/" + selId + "/match", { lineId: lineId, note: "Matched by hand after an ambiguous or failed automatic match." }); }
    function deliver(){
      if (!confirm("Issue this as a numbered transmittal to the engagement team?")) return;
      post("${BASE}/api/sample/${r.id}/deliver", {}); }
  </script>`;

  return chrome({ title: `${r.ref} · Sample`, body, user, active: "subledgers", wide: true });
}

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
  profilePage,
  playbooksPage,
  reportEventPage,
  eventRegisterPage,
  eventDetailPage,
  // delivery ledger
  deliveryStrip,
  subledgerStrip,
  subledgersPage,
  subledgerDetailPage,
  samplesPage,
  sampleDetailPage,
  riskChips,
  supportChips,
  money,
  money0,
  transmittalsPage,
  transmittalDetailPage,
  newTransmittalPage,
  delaysPage,
  receiptTimeline,
  usersPage,
};
