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
//
//  A work order is a REQUEST until an attorney or manager approves it
//  (work-orders.js). The pages here say which stage each one is at.
// ============================================================

const theme = require("./tez-theme");
const { esc } = theme;

// ── Words ───────────────────────────────────────────────────
// What a consultant sends the firm is called a TASK on every screen and in
// every message. It was "work order"; JJ: "word work order seems weird. tez
// is a law firm after all, maybe revise to task or case?" Task, because that
// is what the firm already calls it once approved (the firm's Task list), and
// because much of what is sent concerns a client the firm already has — a
// document to collect is not a "case". The code keeps its old names
// (work-orders.js, wo_approved): those are never shown to anyone.

// ── Look ────────────────────────────────────────────────────
// JJ, signed in as a consultant: "keep the design theme similar to tez."
// The colours, type and shield come from tez-theme.js (the brand guide);
// nothing on these pages sets its own. No emoji: the guide rules them out
// as icons, and a status is a word with a dot beside it.

// A work order's life, in the words a consultant should read.
//   pending_approval → an attorney or manager has not said yes yet
//   open / pending   → accepted, waiting in the firm's queue
const STATUS = {
  pending_approval: { short: "Awaiting approval", long: "Waiting for an attorney or manager at the firm to approve it. Nothing has been started.", dot: "var(--orange)" },
  open:             { short: "Approved",          long: "Approved and in the firm's queue.", dot: "var(--good)" },
  pending:          { short: "In the queue",      long: "In the firm's queue.", dot: "var(--good)" },
  in_progress:      { short: "In progress",       long: "The firm is working on it.", dot: "var(--charcoal)" },
  completed:        { short: "Completed",         long: "The firm has finished this.", dot: "var(--stone)" },
  rejected:         { short: "Not accepted",      long: "The firm did not accept this task.", dot: "var(--bad)" },
  cancelled:        { short: "Cancelled",         long: "This task was cancelled.", dot: "var(--stone)" },
};
const statusOf = (s) => STATUS[s] || { short: String(s || "").replace(/_/g, " ") || "—", long: "", dot: "var(--stone)" };
const badge = (s) => `<span class="status-badge" style="--dot:${statusOf(s).dot};">${esc(statusOf(s).short)}</span>`;

const PRIORITY_LABELS = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const MATTER_LABELS = {
  immigration: "Immigration", pi: "Personal injury", business: "Business litigation",
  ll_tenant: "Landlord / tenant", estate: "Estate planning", tm: "Trademarks / patents",
  real_estate: "Real estate", admin: "General / other",
};
const matterLabel = (m) => MATTER_LABELS[m] || String(m || "").replace(/_/g, " ");

// Dates. A DATE column arrives as local midnight, so it is read with local
// getters; a timestamp is shown in Pacific time, where the firm is — the
// server's own clock is UTC, which put evening submissions on the next day.
const PT = "America/Los_Angeles";
function fmtDay(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v).length <= 10 ? `${v}T12:00:00` : v);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtWhen(v, withTime = false) {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return "";
  return d.toLocaleString("en-US", withTime
    ? { timeZone: PT, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { timeZone: PT, month: "short", day: "numeric", year: "numeric" });
}
const nameOf = (user) => (user && (user.n || user.u || user.name || user.username)) || "Consultant";

// Render the consultant portal chrome (self-contained — no firm sidebar).
function renderChrome({ title = "Consultant Portal", body, activeTab = "dashboard", user = {} }) {
  return theme.page({
    title, area: "Consultant Portal",
    nav: [
      { key: "dashboard", href: "/consultant", label: "Tasks" },
      { key: "new", href: "/consultant/new", label: "New task" },
      { key: "clients", href: "/consultant/clients", label: "My clients" },
      { key: "add-client", href: "/consultant/clients/new", label: "Add client" },
      { key: "alerts", href: "/consultant/alerts", label: "Alerts", count: Number(user.alerts) > 0 ? Number(user.alerts) : null },
    ],
    active: activeTab, who: nameOf(user), body,
    foot: "Questions about a client or a task: 626-678-8677 · jj@tezlawfirm.com",
  });
}

// ── Dashboard: list of THIS consultant's submissions ───────────
function renderDashboard({ user, tasks, stats }) {
  const n = (k) => Number(stats[k]) || 0;
  const rowsHtml = tasks.length ? tasks.map(t => {
    const overdue = t.due_date && !["completed", "rejected", "cancelled"].includes(t.status) && new Date(t.due_date) < new Date(Date.now() - 864e5);
    return `
      <a href="/consultant/task/${t.id}">
        <div>
          <div class="t">${esc(t.title)}</div>
          <div class="m">${[t.client_name ? esc(t.client_name) : null, t.matter_type ? esc(matterLabel(t.matter_type)) : null].filter(Boolean).join(" · ")}</div>
        </div>
        <div>
          ${badge(t.status)}
          ${t.assigned_to && t.status !== "pending_approval" && t.status !== "rejected" ? `<div class="m">With ${esc(t.assigned_to)}</div>` : ""}
        </div>
        <div class="m">
          ${t.due_date ? `<span${overdue ? ' style="color:var(--bad);font-weight:600;"' : ""}>Due ${esc(fmtDay(t.due_date))}</span><br>` : ""}
          Sent ${esc(fmtWhen(t.created_at))}
        </div>
      </a>`;
  }).join("") : `<div class="empty">You have not sent the firm any tasks yet.<br><a href="/consultant/new">Send your first one</a></div>`;

  return `
    <div class="page-header">
      <h1>Tasks</h1>
      <div class="sub">What you have sent to the firm and where each one stands. An attorney or manager approves a task before the firm starts on it.</div>
    </div>

    <div class="tiles">
      <div class="tile${n("pending_approval") ? " hot" : ""}"><div class="k">Awaiting approval</div><div class="v">${n("pending_approval")}</div></div>
      <div class="tile"><div class="k">With the firm</div><div class="v">${n("open") + n("pending") + n("in_progress")}</div></div>
      <div class="tile"><div class="k">Completed</div><div class="v">${n("completed")}</div></div>
      <div class="tile"><div class="k">Not accepted</div><div class="v">${n("rejected")}</div></div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
      <h3 style="margin:0;">Current tasks</h3>
      <a href="/consultant/new" class="btn-primary">New task</a>
    </div>

    <div class="card flush"><div class="rows">${rowsHtml}</div></div>`;
}

// My Clients / Add Client / one client: drawn in the browser by
// public/consultant-clients.js from /api/consultant/* (the same calls the
// phone app makes), so phone and computer show the same thing.
function renderClientsPage({ mode = "list", clientKey = null } = {}) {
  const heads = {
    list: ["My clients", "Clients filed under you at the firm, clients the firm assigned to you, and clients you entered. Search by name, phone, email or A-number."],
    new: ["Add a client", "Enter a new client's details. The firm is notified and the client appears in your list right away."],
    view: ["Client", ""],
  };
  const [h, sub] = heads[mode] || heads.list;
  return `
    <div class="page-header"><h1>${esc(h)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    <div data-consultant-clients="${esc(mode)}"${clientKey ? ` data-key="${esc(clientKey)}"` : ""}></div>
    ${require("./client-script").clientScriptTag("consultant-clients.js")}`;
}

// ── New work order form ─────────────────────────────────────
function renderNewForm() {
  return `
    <div class="page-header">
      <h1>New task</h1>
      <div class="sub">Tell the firm what is needed. An attorney or manager reviews it first; once it is approved the firm starts work, and you are told at each step.</div>
    </div>

    <div class="card">
      <form id="wo-form">
        <div class="field">
          <label for="wo-title">What do you need the firm to do? *</label>
          <input id="wo-title" type="text" name="title" required maxlength="300" placeholder="New client — auto accident on Aug 12">
          <div class="hint">One line. The details go below.</div>
        </div>

        <div class="grid2">
          <div>
            <label for="wo-client-name">Client name</label>
            <input type="text" name="client_name" maxlength="200" placeholder="Last, First" id="wo-client-name">
          </div>
          <div>
            <label for="wo-matter">Matter type *</label>
            <select id="wo-matter" name="matter_type" required>
              <option value="">Choose one</option>
              ${Object.keys(MATTER_LABELS).map(k => `<option value="${k}">${esc(MATTER_LABELS[k])}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="grid2">
          <div>
            <label for="wo-phone">Client phone, if known</label>
            <input id="wo-phone" type="tel" name="_client_phone" maxlength="40" placeholder="(626) 555-0100">
          </div>
          <div>
            <label for="wo-email">Client email, if known</label>
            <input id="wo-email" type="email" name="_client_email" maxlength="200">
          </div>
        </div>

        <div class="grid2">
          <div>
            <label for="wo-priority">Urgency</label>
            <select id="wo-priority" name="priority">
              <option value="normal">Normal — standard timeline</option>
              <option value="high">High — deadline within 30 days</option>
              <option value="urgent">Urgent — imminent deadline or detained client</option>
              <option value="low">Low — no rush</option>
            </select>
          </div>
          <div>
            <label for="wo-due">Deadline or court date, if known</label>
            <input id="wo-due" type="date" name="due_date">
          </div>
        </div>

        <div class="field">
          <label for="wo-desc">Details *</label>
          <textarea id="wo-desc" name="description" rows="7" required maxlength="7500" placeholder="What happened, what the client needs, key dates, and which documents you already have."></textarea>
        </div>

        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <button type="submit" class="btn-primary" id="submit-btn">Send for approval</button>
          <a href="/consultant" class="btn-secondary">Cancel</a>
          <span id="submit-status" role="status" class="hint" style="margin:0;"></span>
        </div>
      </form>
    </div>

    <script>
      // Kept free of apostrophes and backslashes on purpose: this script sits
      // inside a server-side template literal, which swallows both.
      (function () {
        var form = document.getElementById("wo-form");
        var btn = document.getElementById("submit-btn");
        var status = document.getElementById("submit-status");
        try {
          var c = new URLSearchParams(location.search).get("client");
          var el = document.getElementById("wo-client-name");
          if (c && el && !el.value) el.value = c.slice(0, 200);
        } catch (e) { /* older browser: type it */ }
        function fail(msg) {
          status.textContent = msg; status.style.color = "var(--bad)";
          btn.disabled = false; btn.textContent = "Send for approval";
        }
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          btn.disabled = true; btn.textContent = "Sending";
          status.textContent = ""; status.style.color = "";
          var data = {};
          new FormData(form).forEach(function (v, k) { if (v !== "") data[k] = v; });
          var bits = [];
          if (data._client_phone) bits.push("Phone: " + data._client_phone);
          if (data._client_email) bits.push("Email: " + data._client_email);
          if (bits.length) data.description = bits.join(" · ") + String.fromCharCode(10, 10) + (data.description || "");
          delete data._client_phone; delete data._client_email;
          fetch("/api/consultant/tasks", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(data)
          }).then(function (r) {
            return r.json().catch(function () { return { ok: false, error: "The server answered with HTTP " + r.status }; });
          }).then(function (d) {
            if (d.ok && d.task) location.href = "/consultant/task/" + d.task.id + "?sent=1";
            else fail(d.error || "That did not go through. Please try again.");
          }).catch(function (err) { fail("Could not reach the server: " + err.message); });
        });
      })();
    </script>`;
}

// ── Task detail with activity timeline ─────────────────────
function renderTaskDetail({ task, activity, milestones = [], progress = null, user, justSent = false }) {
  const st = statusOf(task.status);
  const last = (action) => [...activity].reverse().find(a => a.action === action);
  const rejected = task.status === "rejected" ? last("rejected") : null;
  const approved = last("approved");

  // Where it stands, said once at the top in plain words.
  let standing = "";
  if (task.status === "pending_approval") {
    standing = `<div class="card note"><strong>${justSent ? "Sent. " : ""}Waiting for approval.</strong>
      An attorney or manager at the firm reviews every task before any work starts. You will be told as soon as they decide.</div>`;
  } else if (rejected) {
    standing = `<div class="card warn"><strong>The firm did not accept this task.</strong>
      ${rejected.note ? `<div class="quote">${esc(rejected.note)}</div>` : ""}
      <div class="hint">${rejected.actor_name ? esc(rejected.actor_name) + " · " : ""}${esc(fmtWhen(rejected.created_at, true))}. If something has changed, send a new task.</div></div>`;
  } else if (approved && task.status === "open") {
    standing = `<div class="card ok"><strong>Approved${approved.actor_name ? " by " + esc(approved.actor_name) : ""}.</strong>
      It is in the firm's queue${task.assigned_to ? " with " + esc(task.assigned_to) : ""}.${approved.note ? `<div class="quote">${esc(approved.note)}</div>` : ""}</div>`;
  }

  // Milestone progress display — read-only for consultants. They see the
  // steps the firm is working through so they know exactly where things
  // stand without asking for updates.
  const pct = progress ? progress.percent : 0;
  const milestonesHtml = milestones.length ? `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
        <h3 style="margin:0;">Progress</h3>
        <div class="hint" style="margin:0;">${progress ? (progress.completed + progress.skipped) : 0} of ${progress ? progress.total : 0} steps · ${pct}%</div>
      </div>
      <div class="bar"><i style="width:${pct}%;"></i></div>
      <div class="timeline">
      ${milestones.map(m => {
        const done = m.status === "completed", skipped = m.status === "skipped", active = m.status === "in_progress";
        return `
          <div>
            <span class="dot${done || active ? " on" : ""}"${done ? ' style="background:var(--good);"' : ""}></span>
            <div>
              <div class="what"${done || skipped ? ' style="color:var(--stone);"' : ""}>${esc(m.title)}${active ? ' <span class="tag" style="--dot:var(--orange);margin-left:8px;">In progress</span>' : ""}${skipped ? " (not needed)" : ""}</div>
              ${m.completed_at ? `<div class="when">Done ${esc(fmtWhen(m.completed_at))}</div>` : (m.due_date && !done ? `<div class="when">Target ${esc(fmtDay(m.due_date))}</div>` : "")}
            </div>
          </div>`;
      }).join("")}
      </div>
    </div>` : "";

  const words = (v) => esc(statusOf(v).short !== "—" ? statusOf(v).short : (v || "?"));
  const timeline = activity.length ? activity.map(a => {
    let text = "";
    if (a.action === "created") text = "Task sent to the firm";
    else if (a.action === "approved") text = "Approved";
    else if (a.action === "rejected") text = "Not accepted";
    else if (a.action === "status_changed") text = `Status changed from <strong>${words(a.old_value)}</strong> to <strong>${words(a.new_value)}</strong>`;
    else if (a.action === "assigned") text = a.new_value ? `Assigned to <strong>${esc(a.new_value)}</strong>` : "Unassigned";
    else if (a.action === "note_added") text = String(a.actor_id) === String(user && (user.uid || user.id)) ? "Your note" : "Note from the firm";
    else if (a.action === "completed") text = "Marked complete";
    else if (a.action === "reopened") text = "Reopened";
    else if (a.action === "edited") text = a.old_value || a.new_value ? `Updated: ${esc(a.old_value)} → ${esc(a.new_value)}` : "Updated";
    else text = esc(String(a.action || "").replace(/_/g, " "));
    const key = ["approved", "rejected", "completed", "created"].includes(a.action);
    return `
      <div>
        <span class="dot${key ? " on" : ""}"></span>
        <div>
          <div class="what">${text}${a.actor_name ? ` <span style="color:var(--stone);">· ${esc(a.actor_name)}</span>` : ""}</div>
          ${a.note && a.action !== "created" ? `<div class="quote">${esc(a.note)}</div>` : ""}
          <div class="when">${esc(fmtWhen(a.created_at, true))}</div>
        </div>
      </div>`;
  }).join("") : `<div class="empty">No activity yet.</div>`;

  const fact = (label, value) => value ? `<div><span class="label">${label}</span><div style="font-weight:600;">${value}</div></div>` : "";
  const open = !["completed", "cancelled", "rejected"].includes(task.status);

  return `
    <div class="page-header">
      <a class="back" href="/consultant">&larr; All tasks</a>
      <h1 style="margin-top:10px;overflow-wrap:anywhere;">${esc(task.title)}</h1>
      <div class="sub">${badge(task.status)}${st.long ? `<span style="margin-left:12px;">${esc(st.long)}</span>` : ""}</div>
    </div>

    ${standing}

    <div class="card">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:18px;">
        ${fact("Client", task.client_name ? esc(task.client_name) : "")}
        ${fact("Matter type", task.matter_type ? esc(matterLabel(task.matter_type)) : "")}
        ${fact("Urgency", esc(PRIORITY_LABELS[task.priority] || task.priority || ""))}
        ${fact("Deadline", esc(fmtDay(task.due_date)))}
        ${task.status !== "pending_approval" && task.status !== "rejected" ? fact("With", task.assigned_to ? esc(task.assigned_to) : "") : ""}
        ${fact("Sent", esc(fmtWhen(task.created_at)))}
      </div>
      ${task.description ? `<div style="margin-top:18px;padding-top:18px;border-top:1px solid var(--travertine);"><span class="label">What you sent</span><div style="white-space:pre-wrap;overflow-wrap:anywhere;">${esc(task.description)}</div></div>` : ""}
    </div>

    ${milestonesHtml}

    <div class="card">
      <h3>Activity</h3>
      <div class="timeline">${timeline}</div>
    </div>

    ${open ? `
    <div class="card">
      <h3>Add a note for the firm</h3>
      <label for="comment-text">Your note</label>
      <textarea id="comment-text" rows="3" maxlength="2000" placeholder="Anything new the firm should know about this task." style="margin-bottom:12px;"></textarea>
      <button type="button" class="btn-primary" id="comment-btn">Send note</button>
      <span id="comment-status" role="status" class="hint" style="margin:0 0 0 12px;"></span>
    </div>

    <script>
      // No apostrophes or backslashes in here — see the note in the form above.
      (function () {
        var btn = document.getElementById("comment-btn");
        var status = document.getElementById("comment-status");
        btn.addEventListener("click", function () {
          var text = document.getElementById("comment-text").value.trim();
          if (!text) { status.textContent = "Write a note first."; status.style.color = "var(--bad)"; return; }
          btn.disabled = true; btn.textContent = "Sending"; status.textContent = "";
          fetch("/consultant/task/${Number(task.id)}/comment", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ note: text })
          }).then(function (r) {
            return r.json().catch(function () { return { ok: false, error: "The server answered with HTTP " + r.status }; });
          }).then(function (d) {
            if (d.ok) location.reload();
            else { status.textContent = d.error || "That did not go through."; status.style.color = "var(--bad)"; btn.disabled = false; btn.textContent = "Send note"; }
          }).catch(function (e) {
            status.textContent = "Could not reach the server: " + e.message; status.style.color = "var(--bad)";
            btn.disabled = false; btn.textContent = "Send note";
          });
        });
      })();
    </script>
    ` : ""}`;
}


/**
 * Alert settings for one consultant.
 *
 * Built as plain form POSTs with no inline JavaScript at all. That is a
 * deliberate choice, not laziness: these pages are JS template literals,
 * so an apostrophe or a \n inside an onclick handler is swallowed by the
 * literal and reaches the browser as a syntax error that kills every
 * script on the page. On 2026-09-28 exactly that took client search down
 * for five hours. A form needs no script, so it cannot break that way.
 *
 * What a consultant can see here is their own contact details and their
 * own switches. Nothing about any client appears on this page.
 */
function renderAlertsPage({ user = {}, me = {}, health = {}, linkCode = null, saved = false, linked = false, feed = [], hasApp = false }) {
  const on = (v) => v ? "checked" : "";
  const chan = (key, label, enabled, address, missing, note) => {
    const ready = !!address;
    return `
    <div style="display:flex;gap:14px;align-items:flex-start;padding:16px 0;border-top:1px solid var(--travertine);">
      <input type="checkbox" id="ch-${key}" name="${key}" value="1" ${on(enabled)} style="margin-top:3px;flex:0 0 auto;">
      <div style="flex:1;">
        <label for="ch-${key}" style="font-size:15px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--charcoal);margin:0;">${label}</label>
        <div style="font-size:13px;color:${ready ? "var(--stone)" : "var(--ember)"};margin-top:3px;">
          ${ready ? esc(address) : missing}
        </div>
        ${note ? `<div class="hint">${note}</div>` : ""}
        ${enabled && !ready ? `<div class="hint" style="color:var(--bad);font-weight:600;">Turned on, but there is nowhere to send — you will not be alerted on this channel.</div>` : ""}
      </div>
    </div>`;
  };

  const down = [];
  if (!health.email) down.push("email");
  if (!health.sms) down.push("text message");
  if (!health.telegram) down.push("Telegram");

  // What has happened, newest first. This is the list the alerts point to.
  const feedHtml = feed.length ? feed.map(f => {
    const href = f.task_id ? `/consultant/task/${Number(f.task_id)}`
      : (f.client_key ? `/consultant/client/${encodeURIComponent(f.client_key)}` : null);
    const inner = `
        <div>
          <div class="t">${esc(f.label)}${f.seen_at ? "" : ' <span class="tag" style="--dot:var(--orange);margin-left:8px;">New</span>'}</div>
          <div class="m">${esc(f.who || (f.task_id ? "Task #" + f.task_id : "A client of yours"))}</div>
        </div>
        <div class="m">${esc(fmtWhen(f.created_at, true))}</div>
        <div class="m" style="font-weight:600;color:var(--ember);">${href ? "Open" : ""}</div>`;
    return href ? `<a href="${esc(href)}">${inner}</a>` : `<div>${inner}</div>`;
  }).join("") : `<div class="empty">Nothing yet. When something happens on one of your clients or tasks, it is listed here.</div>`;

  return `
  <div class="page-header">
    <h1>Alerts</h1>
    <div class="sub">What has happened on your clients and tasks, and how you hear about it.</div>
  </div>

  ${saved ? `<div class="card ok">Saved.</div>` : ""}
  ${linked ? `<div class="card ok">Telegram is linked. Alerts will go to that chat.</div>` : ""}

  <h3>Recent</h3>
  <div class="card flush"><div class="rows">${feedHtml}</div></div>

  <div class="card" style="margin-top:28px;">
    <h3>What you will be told</h3>
    <p style="color:var(--stone);margin:0 0 14px;">
      A new court notice, a hearing scheduled or rescheduled, a deadline coming up,
      a change in case status, or an update the firm sends you &mdash; for your clients only.
      And every decision on a task you sent: approved, not accepted, updated, completed.
    </p>
    <p class="quote" style="margin:0;white-space:normal;">
      <strong>The alert itself says only what happened and for which client.</strong>
      Dates, documents, A&#8209;numbers and the substance of a notice are never sent by
      email, text or app notification &mdash; you sign in here to read them. That is deliberate:
      an email gets forwarded and a phone gets lost.
    </p>
  </div>

  <form method="POST" action="/consultant/alerts">
    <div class="card">
      <h3>Where to reach you</h3>
      <div class="hint" style="margin:0 0 12px;">Ask the firm to change your email or phone number.</div>
      ${chan("notify_app", "Tara app on your phone", me.notify_app !== false, hasApp ? "This account is signed in on a phone" : "", "Not signed in on a phone yet &mdash; open the Tara app and sign in with this account.", "A notification on your lock screen.")}
      ${chan("notify_email", "Email", me.notify_email !== false, me.email, "No email address on file &mdash; ask the firm to add one.", "")}
      ${chan("notify_sms", "Text message", me.notify_sms === true, me.phone, "No phone number on file &mdash; ask the firm to add one.", "Standard message rates apply.")}
      ${chan("notify_telegram", "Telegram", me.notify_telegram === true, me.telegram_chat_id ? "Linked" : "", "Not linked yet &mdash; use the box below.", "")}
      <div style="margin-top:18px;">
        <button type="submit" class="btn-primary">Save</button>
      </div>
    </div>
  </form>

  <div class="card">
    <h3>Link Telegram</h3>
    <p style="color:var(--stone);margin-top:0;">
      Telegram will not let us message you until you message the bot first.
      ${linkCode
        ? `Open Telegram, start a chat with <strong>@TEZJJBot</strong>, and send it this code:`
        : `Generate a code, then send it to <strong>@TEZJJBot</strong> on Telegram.`}
    </p>
    ${linkCode ? `<div style="font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:2px;background:var(--marble);border:1px dashed var(--stone);border-radius:3px;padding:14px;text-align:center;margin:0 0 12px;">${esc(linkCode)}</div>
      <p class="hint" style="margin:0 0 14px;">The code works once. Come back to this page afterwards to confirm.</p>` : ""}
    <form method="POST" action="/consultant/alerts/telegram-code" style="margin:0;">
      <button type="submit" class="btn-secondary">${linkCode ? "Generate a new code" : "Generate a code"}</button>
    </form>
  </div>

  ${down.length ? `
  <div class="card note">
    <strong>Not available right now</strong>
    <div class="hint" style="font-size:13px;">
      The firm has not set up ${esc(down.join(" or "))} on the server yet, so alerts on
      ${down.length > 1 ? "those channels" : "that channel"} will queue rather than send.
      Nothing is lost &mdash; they go out once it is switched on, and everything is listed above in the meantime.
    </div>
  </div>` : ""}
  `;
}

module.exports = { renderChrome, renderDashboard, renderNewForm, renderTaskDetail, renderClientsPage, renderAlertsPage };
