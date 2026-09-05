// ============================================================
//  TEZ LAW P.C. — CONSULTANT PORTAL
//  ─────────────────────────────────────────────────────────
//  A limited, self-contained portal for external referral partners
//  (consultants) who bring leads/matters to the firm.
//
//  What they can do:
//   • Submit new work orders (leads) to the firm
//   • Track progress on every submission they've made
//   • See the timeline of activity: status changes, firm notes,
//     assignments, completions
//   • Add follow-up comments to their submissions
//
//  What they CANNOT do:
//   • See any firm-wide data (other clients, hearings, PI, accounting)
//   • See internal firm notes marked "hidden from submitter"
//   • See or interact with anyone else's submissions
//
//  Consultants have their own UI chrome (no firm sidebar); everything
//  they see lives at /consultant/*.
// ============================================================

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STATUS_COLORS = {
  pending: "#B79C62",
  in_progress: "#0061FF",
  completed: "#2e7d32",
  cancelled: "#999",
};
const STATUS_LABELS = {
  pending: "Pending — awaiting firm review",
  in_progress: "In Progress — firm working on it",
  completed: "Completed",
  cancelled: "Cancelled",
};
const PRIORITY_LABELS = {
  urgent: "🔴 Urgent",
  high: "🟠 High",
  normal: "🔵 Normal",
  low: "⚪ Low",
};

// Render the consultant portal chrome (self-contained — no firm sidebar).
// The consultant sees a simple top nav: Dashboard | + New Work Order | Sign Out.
function renderChrome({ title = "Consultant Portal", body, activeTab = "dashboard", user = {} }) {
  const tabLink = (key, href, label) => `
    <a href="${href}" style="color:${activeTab === key ? "#0C1C36" : "#666"}; text-decoration:none; padding:10px 16px; font-weight:${activeTab === key ? "700" : "500"}; border-bottom:${activeTab === key ? "3px solid #B79C62" : "3px solid transparent"};">${label}</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — Tez Law</title>
  <style>
    :root { --gold: #B79C62; --navy: #0C1C36; --light: #faf9f5; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--light); color: var(--navy); }
    header { background: white; border-bottom: 1px solid #eee; padding: 12px 24px; display: flex; align-items: center; gap: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .brand { font-size: 18px; font-weight: 700; color: var(--navy); }
    .brand .gold { color: var(--gold); }
    nav.tabs { display: flex; gap: 4px; margin-left: 20px; flex: 1; }
    .who { font-size: 12px; color: #666; }
    .who strong { color: var(--navy); }
    .signout { background: none; border: none; color: #666; font-size: 12px; cursor: pointer; padding: 6px 12px; }
    .signout:hover { color: #c62828; }
    main { max-width: 1100px; margin: 20px auto; padding: 0 20px; }
    .page-header { margin-bottom: 20px; }
    .page-header h1 { margin: 0 0 6px; font-size: 26px; color: var(--navy); }
    .page-header .sub { font-size: 13px; color: #666; }
    .card { background: white; border-radius: 8px; border: 1px solid #eee; padding: 20px; margin-bottom: 16px; }
    .btn-primary { background: var(--gold); color: white; padding: 10px 20px; border: none; border-radius: 6px; text-decoration: none; font-weight: 600; cursor: pointer; display: inline-block; font-size: 14px; }
    .btn-primary:hover { background: #a08a55; }
    .btn-secondary { background: white; color: var(--navy); padding: 10px 20px; border: 1px solid #ccc; border-radius: 6px; text-decoration: none; font-weight: 500; cursor: pointer; display: inline-block; font-size: 14px; }
    label { display: block; font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.4px; }
    input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; font-family: inherit; }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 3px rgba(183,156,98,0.15); }
    .status-badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; color: white; }
    @media (max-width: 640px) { header { padding: 10px 12px; flex-wrap: wrap; } nav.tabs { margin-left: 0; width: 100%; overflow-x: auto; } main { padding: 0 12px; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">TEZ <span class="gold">LAW</span> · Consultant Portal</div>
    <nav class="tabs">
      ${tabLink("dashboard", "/consultant", "📊 My Work Orders")}
      ${tabLink("new", "/consultant/new", "＋ Submit New")}
    </nav>
    <div class="who">Signed in as <strong>${esc(user.name || user.username || "Consultant")}</strong></div>
    <form method="POST" action="/logout" style="margin:0;"><button type="submit" class="signout">Sign out</button></form>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

// ── Dashboard: list of THIS consultant's submissions ───────────
function renderDashboard({ user, tasks, stats }) {
  const rowsHtml = tasks.length ? tasks.map(t => {
    const status = STATUS_COLORS[t.status] || "#666";
    const statusLabel = t.status.replace(/_/g, " ").toUpperCase();
    const dueLabel = t.due_date ? new Date(t.due_date).toLocaleDateString() : "—";
    const isOverdue = t.due_date && t.status !== "completed" && new Date(t.due_date) < new Date();
    return `
      <tr>
        <td style="padding:14px 12px; border-bottom:1px solid #eee; vertical-align:top;">
          <a href="/consultant/task/${t.id}" style="color:var(--navy); font-weight:600; text-decoration:none; font-size:14px;">${esc(t.title)}</a>
          ${t.client_name ? `<div style="font-size:12px; color:#666; margin-top:3px;">👤 ${esc(t.client_name)}</div>` : ""}
          ${t.matter_type ? `<div style="font-size:11px; color:#888; margin-top:2px;">${esc(t.matter_type.replace(/_/g, " "))}</div>` : ""}
        </td>
        <td style="padding:14px 12px; border-bottom:1px solid #eee; vertical-align:top;">
          <span class="status-badge" style="background:${status};">${statusLabel}</span>
          ${t.assigned_to ? `<div style="font-size:11px; color:#666; margin-top:4px;">Assigned: ${esc(t.assigned_to)}</div>` : ""}
        </td>
        <td style="padding:14px 12px; border-bottom:1px solid #eee; vertical-align:top; font-size:13px; ${isOverdue ? "color:#c62828; font-weight:600;" : "color:#666;"}">
          ${dueLabel}${isOverdue ? " ⚠" : ""}
        </td>
        <td style="padding:14px 12px; border-bottom:1px solid #eee; vertical-align:top; font-size:12px; color:#666;">
          ${new Date(t.created_at).toLocaleDateString()}
        </td>
        <td style="padding:14px 12px; border-bottom:1px solid #eee; vertical-align:top;">
          <a href="/consultant/task/${t.id}" class="btn-secondary" style="padding:6px 12px; font-size:12px;">View →</a>
        </td>
      </tr>`;
  }).join("") : `<tr><td colspan="5" style="padding:60px; text-align:center; color:#888;">You haven't submitted any work orders yet. <a href="/consultant/new" style="color:var(--gold);">Submit your first one →</a></td></tr>`;

  return `
    <div class="page-header">
      <h1>📊 My Work Orders</h1>
      <div class="sub">Every case you've referred to Tez Law. Click any row to see the current status and full activity timeline.</div>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:20px;">
      <div class="card" style="padding:14px; margin-bottom:0;">
        <div style="font-size:10px; color:#888; text-transform:uppercase;">Total Submitted</div>
        <div style="font-size:24px; font-weight:700; color:var(--navy);">${stats.total || 0}</div>
      </div>
      <div class="card" style="padding:14px; margin-bottom:0;">
        <div style="font-size:10px; color:#0061FF; text-transform:uppercase;">In Progress</div>
        <div style="font-size:24px; font-weight:700; color:#0061FF;">${stats.in_progress || 0}</div>
      </div>
      <div class="card" style="padding:14px; margin-bottom:0;">
        <div style="font-size:10px; color:#B79C62; text-transform:uppercase;">Pending Review</div>
        <div style="font-size:24px; font-weight:700; color:#B79C62;">${stats.pending || 0}</div>
      </div>
      <div class="card" style="padding:14px; margin-bottom:0;">
        <div style="font-size:10px; color:#2e7d32; text-transform:uppercase;">Completed</div>
        <div style="font-size:24px; font-weight:700; color:#2e7d32;">${stats.completed || 0}</div>
      </div>
    </div>

    <div style="text-align:right; margin-bottom:12px;">
      <a href="/consultant/new" class="btn-primary">＋ Submit New Work Order</a>
    </div>

    <div class="card" style="padding:0; overflow:hidden;">
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#fafaf7;">
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Work Order</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Status</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Due</th>
          <th style="padding:10px 12px; text-align:left; font-size:11px; color:#666; text-transform:uppercase; border-bottom:1px solid #eee;">Submitted</th>
          <th style="padding:10px 12px; border-bottom:1px solid #eee;"></th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

// ── New work order form ─────────────────────────────────────
function renderNewForm() {
  return `
    <div class="page-header">
      <h1>＋ Submit New Work Order</h1>
      <div class="sub">Fill in what you know — the firm will review, assign, and start work. You'll get notified at every step.</div>
    </div>

    <div class="card">
      <form onsubmit="submitOrder(event)">
        <div style="margin-bottom:14px;">
          <label>Work Order Title *</label>
          <input type="text" name="title" required placeholder="e.g. New client: John Smith - Auto accident 8/12">
          <div style="font-size:11px; color:#888; margin-top:4px;">Short summary of what the firm needs to work on</div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
          <div>
            <label>Client Name</label>
            <input type="text" name="client_name" placeholder="John Smith">
          </div>
          <div>
            <label>Matter Type *</label>
            <select name="matter_type" required>
              <option value="">— pick one —</option>
              <option value="immigration">Immigration</option>
              <option value="pi">Personal Injury</option>
              <option value="business">Business Litigation</option>
              <option value="ll_tenant">Landlord/Tenant</option>
              <option value="estate">Estate Planning</option>
              <option value="tm">Trademarks/Patents</option>
              <option value="real_estate">Real Estate</option>
              <option value="admin">General / Other</option>
            </select>
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
          <div>
            <label>Client Phone (if known)</label>
            <input type="tel" name="_client_phone" placeholder="(555) 123-4567">
          </div>
          <div>
            <label>Client Email (if known)</label>
            <input type="email" name="_client_email" placeholder="john@example.com">
          </div>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
          <div>
            <label>Urgency</label>
            <select name="priority">
              <option value="normal">🔵 Normal — standard timeline</option>
              <option value="high">🟠 High — deadline within 30 days</option>
              <option value="urgent">🔴 Urgent — imminent deadline or detained client</option>
              <option value="low">⚪ Low — no rush</option>
            </select>
          </div>
          <div>
            <label>Deadline / Court Date (if known)</label>
            <input type="date" name="due_date">
          </div>
        </div>

        <div style="margin-bottom:14px;">
          <label>Details & Context *</label>
          <textarea name="description" rows="6" required placeholder="What happened? What does the client need? Any key facts, dates, or documents you already have? The more detail, the faster the firm can move."></textarea>
        </div>

        <div style="display:flex; gap:10px; align-items:center;">
          <button type="submit" class="btn-primary" id="submit-btn">📤 Submit to Firm</button>
          <a href="/consultant" class="btn-secondary">Cancel</a>
          <span id="submit-status" style="color:#666; font-size:12px; margin-left:12px;"></span>
        </div>
      </form>
    </div>

    <script>
      async function submitOrder(e) {
        e.preventDefault();
        const btn = document.getElementById("submit-btn");
        btn.disabled = true; btn.textContent = "⏳ Submitting…";
        const fd = new FormData(e.target);
        const data = {};
        for (const [k, v] of fd.entries()) if (v !== "") data[k] = v;
        // Roll optional contact fields into the description so the firm has them
        const contactBits = [];
        if (data._client_phone) contactBits.push("Phone: " + data._client_phone);
        if (data._client_email) contactBits.push("Email: " + data._client_email);
        if (contactBits.length) data.description = contactBits.join(" · ") + "\\n\\n" + (data.description || "");
        delete data._client_phone;
        delete data._client_email;
        try {
          const r = await fetch("/consultant/tasks", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          const d = await r.json();
          if (d.ok) {
            location.href = "/consultant/task/" + d.task.id;
          } else {
            alert("Error: " + (d.error || "unknown"));
            btn.disabled = false; btn.textContent = "📤 Submit to Firm";
          }
        } catch (err) {
          alert("Network error: " + err.message);
          btn.disabled = false; btn.textContent = "📤 Submit to Firm";
        }
      }
    </script>`;
}

// ── Task detail with activity timeline ─────────────────────
function renderTaskDetail({ task, activity, user }) {
  const status = STATUS_COLORS[task.status] || "#666";
  const statusLabel = STATUS_LABELS[task.status] || task.status;

  const ACTION_ICONS = {
    created: "＋",
    status_changed: "↻",
    assigned: "👤",
    note_added: "💬",
    completed: "✓",
    reopened: "↺",
    edited: "✎",
  };

  const timeline = activity.length ? activity.map(a => {
    const icon = ACTION_ICONS[a.action] || "•";
    let text = "";
    if (a.action === "created") text = "Work order submitted";
    else if (a.action === "status_changed") text = `Status changed from <strong>${esc(a.old_value || "?")}</strong> to <strong>${esc(a.new_value || "?")}</strong>`;
    else if (a.action === "assigned") text = a.new_value ? `Assigned to <strong>${esc(a.new_value)}</strong>` : "Unassigned";
    else if (a.action === "note_added") text = "Note added by firm";
    else if (a.action === "completed") text = "Marked complete";
    else if (a.action === "reopened") text = "Reopened";
    else if (a.action === "edited") text = `Updated: ${esc(a.old_value)} → ${esc(a.new_value)}`;
    else text = esc(a.action);

    const when = new Date(a.created_at).toLocaleString();
    return `
      <div style="display:flex; gap:12px; padding:12px 0; border-bottom:1px solid #f0f0f0;">
        <div style="width:32px; height:32px; border-radius:16px; background:#f5f2ea; display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:14px; color:var(--gold);">${icon}</div>
        <div style="flex:1;">
          <div style="font-size:13px; color:var(--navy);">${text}${a.actor_name ? ` — <span style="color:#666;">by ${esc(a.actor_name)}</span>` : ""}</div>
          ${a.note ? `<div style="background:#fafaf7; padding:10px 12px; border-radius:6px; margin-top:6px; font-size:13px; color:#333; white-space:pre-wrap;">${esc(a.note)}</div>` : ""}
          <div style="font-size:11px; color:#999; margin-top:4px;">${when}</div>
        </div>
      </div>`;
  }).join("") : `<div style="color:#888; padding:20px; text-align:center;">No activity yet.</div>`;

  return `
    <div class="page-header">
      <a href="/consultant" style="color:#666; text-decoration:none; font-size:13px;">← Back to my work orders</a>
      <h1 style="margin-top:8px;">${esc(task.title)}</h1>
      <div class="sub">
        <span class="status-badge" style="background:${status};">${task.status.replace(/_/g, " ").toUpperCase()}</span>
        <span style="margin-left:10px;">${statusLabel}</span>
      </div>
    </div>

    <div class="card">
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:16px; font-size:13px;">
        ${task.client_name ? `<div><div style="font-size:10px; color:#888; text-transform:uppercase;">Client</div><div style="font-weight:600; color:var(--navy);">${esc(task.client_name)}</div></div>` : ""}
        ${task.matter_type ? `<div><div style="font-size:10px; color:#888; text-transform:uppercase;">Matter Type</div><div>${esc(task.matter_type.replace(/_/g, " "))}</div></div>` : ""}
        ${task.priority ? `<div><div style="font-size:10px; color:#888; text-transform:uppercase;">Priority</div><div>${PRIORITY_LABELS[task.priority] || task.priority}</div></div>` : ""}
        ${task.due_date ? `<div><div style="font-size:10px; color:#888; text-transform:uppercase;">Deadline</div><div>${new Date(task.due_date).toLocaleDateString()}</div></div>` : ""}
        ${task.assigned_to ? `<div><div style="font-size:10px; color:#888; text-transform:uppercase;">Assigned To</div><div>${esc(task.assigned_to)}</div></div>` : ""}
        <div><div style="font-size:10px; color:#888; text-transform:uppercase;">Submitted</div><div>${new Date(task.created_at).toLocaleDateString()}</div></div>
      </div>
      ${task.description ? `<div style="margin-top:16px; padding-top:16px; border-top:1px solid #eee;"><div style="font-size:10px; color:#888; text-transform:uppercase; margin-bottom:6px;">Original Submission</div><div style="white-space:pre-wrap; font-size:13px; color:#333;">${esc(task.description)}</div></div>` : ""}
    </div>

    <div class="card">
      <h3 style="margin-top:0; font-size:16px; color:var(--navy);">📋 Activity Timeline</h3>
      ${timeline}
    </div>

    ${task.status !== "completed" && task.status !== "cancelled" ? `
    <div class="card">
      <h3 style="margin-top:0; font-size:16px; color:var(--navy);">💬 Add a Follow-Up Note</h3>
      <textarea id="comment-text" rows="3" placeholder="Send a follow-up message to the firm about this work order..." style="margin-bottom:10px;"></textarea>
      <button type="button" onclick="addComment()" class="btn-primary" id="comment-btn">📤 Send to Firm</button>
      <span id="comment-status" style="color:#666; font-size:12px; margin-left:12px;"></span>
    </div>

    <script>
      async function addComment() {
        const text = document.getElementById("comment-text").value.trim();
        if (!text) return alert("Type a note first.");
        const btn = document.getElementById("comment-btn");
        btn.disabled = true; btn.textContent = "⏳ Sending…";
        try {
          const r = await fetch("/consultant/task/${task.id}/comment", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ note: text }),
          });
          const d = await r.json();
          if (d.ok) location.reload();
          else { alert("Error: " + d.error); btn.disabled = false; btn.textContent = "📤 Send to Firm"; }
        } catch (e) { alert("Network error: " + e.message); btn.disabled = false; btn.textContent = "📤 Send to Firm"; }
      }
    </script>
    ` : ""}`;
}

module.exports = { renderChrome, renderDashboard, renderNewForm, renderTaskDetail };
