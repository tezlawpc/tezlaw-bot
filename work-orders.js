// ============================================================
//  work-orders.js — A CONSULTANT'S WORK ORDER NEEDS A YES
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  JJ, signed in as a consultant: "work orders can be submitted.
//  however, will need attorney or manager's approval."
//
//  A consultant is not the firm. What they send in is a request,
//  and it becomes the firm's work only when a lawyer or a manager
//  says so. Half of that already existed and half did not:
//
//    · The phone app's route filed an order as 'pending_approval'.
//      The WEBSITE's route filed it as 'pending' — straight into
//      the firm's task list, no approval at all. Same button, two
//      different outcomes depending on the device.
//    · Only an admin could approve, and only in the phone app.
//      An attorney could not; a manager could not; nobody could
//      from a computer.
//    · The reason for turning one down was written with
//      tasks.recordActivity(), a function that has never existed,
//      behind a typeof check — so the reason was silently dropped
//      and the consultant was never told why.
//    · An order waiting for approval still showed in /admin/tasks
//      and went out in the morning reminder (fixed in tasks.js).
//
//  Now there is one place that decides, used by both the phone
//  routes (app-api.js) and the page below, so they cannot drift:
//
//      approve()  pending_approval → open      (enters the queue)
//      reject()   pending_approval → rejected  (reason required)
//
//  Each is a single conditional UPDATE, so two people pressing
//  Approve at once approve it once. Each writes the timeline entry
//  the consultant sees, and tasks.logActivity() alerts them.
//
//  The page is plain HTML forms, no script — see notify-admin.js
//  for why that is a rule here and not a preference.
// ============================================================

const theme = require("./tez-theme");
const { esc } = theme;

// Where the firm decides them. On screen these are "tasks from consultants";
// "work order" survives only in this file's name and in the code.
const PAGE = "/admin/consultant-tasks";

const APPROVER_ROLES = ["admin", "manager", "attorney"];
const canApprove = (user) => !!user && APPROVER_ROLES.includes(user.r);
const nameOf = (user) => (user && (user.n || user.u || user.name || user.username)) || "Firm";

const PRIORITIES = ["urgent", "high", "normal", "low"];
const MATTERS = {
  immigration: "Immigration", pi: "Personal injury", business: "Business litigation",
  ll_tenant: "Landlord / tenant", estate: "Estate planning", tm: "Trademarks / patents",
  real_estate: "Real estate", admin: "General / other",
};

const db = () => require("./db");

async function pendingCount() {
  try {
    const r = await db().query(`SELECT COUNT(*)::int AS n FROM tasks WHERE status = 'pending_approval'`);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch { return 0; }
}

async function listPending() {
  const r = await db().query(
    `SELECT t.*, au.full_name AS submitter_name, au.username AS submitter_username
       FROM tasks t LEFT JOIN admin_users au ON au.id = t.submitted_by_user_id
      WHERE t.status = 'pending_approval'
      ORDER BY CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, t.created_at ASC
      LIMIT 200`);
  return r.rows;
}

async function recentDecisions(limit = 12) {
  try {
    const r = await db().query(
      `SELECT a.action, a.actor_name, a.note, a.created_at, t.id AS task_id, t.title, t.client_name,
              COALESCE(au.full_name, au.username) AS submitter
         FROM task_activity a
         JOIN tasks t ON t.id = a.task_id
         LEFT JOIN admin_users au ON au.id = t.submitted_by_user_id
        WHERE a.action IN ('approved', 'rejected')
        ORDER BY a.created_at DESC LIMIT $1`, [limit]);
    return r.rows;
  } catch { return []; }
}

async function staffNames() {
  try {
    const r = await db().query(
      `SELECT COALESCE(full_name, username) AS name FROM admin_users
        WHERE role <> 'consultant' AND COALESCE(disabled, FALSE) = FALSE ORDER BY 1`);
    return r.rows.map(x => x.name).filter(Boolean);
  } catch { return []; }
}

const clean = (v, n) => { const t = String(v == null ? "" : v).trim(); return t ? t.slice(0, n) : null; };

/**
 * Approve. `overrides` may change who it goes to, its priority, its due
 * date or its matter type before it enters the queue.
 * Returns { ok, task } or { ok:false, status, error }.
 */
async function approve(id, actor, overrides = {}) {
  const tid = parseInt(id, 10);
  if (!Number.isInteger(tid) || tid <= 0) return { ok: false, status: 400, error: "Bad id" };
  if (!canApprove(actor)) return { ok: false, status: 403, error: "An attorney or manager must approve a consultant's task" };

  const sets = ["status = 'open'", "updated_at = NOW()"];
  const vals = [tid];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (overrides.assigned_to !== undefined) set("assigned_to", clean(overrides.assigned_to, 200));
  if (PRIORITIES.includes(overrides.priority)) set("priority", overrides.priority);
  if (overrides.due_date && /^\d{4}-\d{2}-\d{2}$/.test(overrides.due_date)) set("due_date", overrides.due_date);
  if (overrides.matter_type && MATTERS[overrides.matter_type]) set("matter_type", overrides.matter_type);

  // The status test is IN the update: whoever gets here second changes nothing.
  const r = await db().query(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = $1 AND status = 'pending_approval' RETURNING *`, vals);
  const task = r.rows[0];
  if (!task) {
    const cur = await db().query(`SELECT status FROM tasks WHERE id = $1`, [tid]);
    if (!cur.rows.length) return { ok: false, status: 404, error: "Task not found" };
    return { ok: false, status: 409, error: `Already decided (now: ${String(cur.rows[0].status).replace(/_/g, " ")})` };
  }

  await require("./tasks").logActivity(tid, {
    actor_id: actor.uid, actor_name: nameOf(actor), actor_role: actor.r,
    action: "approved", old_value: "pending_approval", new_value: "open",
    note: clean(overrides.note, 2000), visible_to_submitter: true,
  });

  if (task.assigned_to) {
    try {
      require("./push-notifications").sendToFirmByName(task.assigned_to, {
        title: `Approved: ${task.title}`,
        body: `New task in your queue${task.client_name ? ` · ${task.client_name}` : ""}`,
        data: { screen: "task", taskId: task.id },
      }).catch(() => {});
    } catch { /* push is a courtesy */ }
  }
  return { ok: true, task };
}

/** Turn it down. A reason is required: the consultant is owed one. */
async function reject(id, actor, reason) {
  const tid = parseInt(id, 10);
  if (!Number.isInteger(tid) || tid <= 0) return { ok: false, status: 400, error: "Bad id" };
  if (!canApprove(actor)) return { ok: false, status: 403, error: "An attorney or manager must decide a consultant's task" };
  const why = clean(reason, 2000);
  if (!why) return { ok: false, status: 400, error: "A reason is required — the consultant will see it" };

  const r = await db().query(
    `UPDATE tasks SET status = 'rejected', updated_at = NOW() WHERE id = $1 AND status = 'pending_approval' RETURNING *`, [tid]);
  const task = r.rows[0];
  if (!task) {
    const cur = await db().query(`SELECT status FROM tasks WHERE id = $1`, [tid]);
    if (!cur.rows.length) return { ok: false, status: 404, error: "Task not found" };
    return { ok: false, status: 409, error: `Already decided (now: ${String(cur.rows[0].status).replace(/_/g, " ")})` };
  }
  await require("./tasks").logActivity(tid, {
    actor_id: actor.uid, actor_name: nameOf(actor), actor_role: actor.r,
    action: "rejected", old_value: "pending_approval", new_value: "rejected",
    note: why, visible_to_submitter: true,
  });
  return { ok: true, task };
}

/**
 * Tell the people who can approve that one is waiting. Never throws: the
 * order is already saved, and an alert that fails must not turn a
 * successful submission into an error on the consultant's screen.
 */
async function announce(task, submitterName) {
  const who = submitterName || "A consultant";
  const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  try {
    await require("./tg-route").send("ops",
      `Task from a consultant needs approval\nFrom: ${who}\n\n${task.title}` +
      `${task.client_name ? `\nClient: ${task.client_name}` : ""}\nPriority: ${task.priority || "normal"}` +
      `${task.due_date ? `\nDue: ${String(task.due_date instanceof Date ? task.due_date.toISOString() : task.due_date).slice(0, 10)}` : ""}` +
      `\n\nAn attorney or manager approves it here: ${base}${PAGE}`);
  } catch (e) { console.warn("[work-orders] telegram:", e.message); }
  try {
    await require("./push-notifications").sendToRoles(APPROVER_ROLES, {
      title: "Consultant task needs approval",
      body: `${who} submitted: ${task.title}`,
      data: { screen: "pending-approvals", taskId: task.id },
    });
  } catch (e) { console.warn("[work-orders] push:", e.message); }
}

// ── The firm's page ─────────────────────────────────────────

const PT = "America/Los_Angeles";
const when = (v) => { try { return v ? new Date(v).toLocaleString("en-US", { timeZone: PT, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; } catch { return ""; } };
const day = (v) => {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v).length <= 10 ? `${v}T12:00:00` : v);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const isoDay = (v) => {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v).length <= 10 ? `${v}T12:00:00` : v);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const PRI_DOT = { urgent: "var(--bad)", high: "var(--orange)", normal: "var(--stone)", low: "var(--travertine)" };

function renderPage({ user, pending = [], recent = [], staff = [], files = {}, flash = null, error = null }) {
  const kb = (n) => { const b = Number(n) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; };
  const cards = pending.map(t => {
    const pri = PRIORITIES.includes(t.priority) ? t.priority : "normal";
    // What the consultant attached. Downloads, never opened in the page.
    const mine = files[t.id] || [];
    const docs = mine.length ? `<span class="label">Documents they attached (${mine.length})</span>
      <div style="margin:0 0 18px;">${mine.map(f => `<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--travertine);">
        <span style="overflow-wrap:anywhere;">${esc(f.filename)} <span class="hint" style="margin:0;">· ${esc(kb(f.bytes))}</span></span>
        <a class="btn-secondary btn-small" href="/api/staff/task-attachments/${Number(f.id)}">Download</a></div>`).join("")}</div>` : "";
    return `
    <section class="card" id="wo-${t.id}">
      <div style="display:flex;gap:10px 18px;flex-wrap:wrap;align-items:baseline;justify-content:space-between;">
        <h3 style="margin:0;overflow-wrap:anywhere;">${esc(t.title)}</h3>
        <span class="tag" style="--dot:${PRI_DOT[pri]};">${esc(pri)} priority</span>
      </div>
      <div class="hint" style="margin:6px 0 14px;">
        From <strong>${esc(t.submitter_name || t.submitter_username || "a consultant")}</strong> · ${esc(when(t.created_at))}
        · ${esc(MATTERS[t.matter_type] || String(t.matter_type || "").replace(/_/g, " ") || "no matter type")}
        ${t.due_date ? ` · deadline ${esc(day(t.due_date))}` : ""}
      </div>
      <div class="grid2" style="margin-bottom:6px;">
        <div><span class="label">Client named</span>${t.client_name ? esc(t.client_name) : "<em>none</em>"}
          <div class="hint">${t.client_key
            ? "Filed under this client's record."
            : (t.client_name ? "Not matched to a client record — the name is as the consultant typed it." : "")}</div></div>
        <div><span class="label">Would go to</span>${t.assigned_to ? esc(t.assigned_to) : "<em>nobody yet</em>"}
          <div class="hint">From the firm's default for this matter type. Change it below.</div></div>
      </div>
      ${t.description ? `<span class="label">What they wrote</span><div class="quote" style="margin:0 0 18px;">${esc(t.description)}</div>` : ""}
      ${docs}

      <div class="grid2" style="margin-bottom:0;align-items:start;">
        <form method="POST" action="${PAGE}/${t.id}/approve" style="border-top:3px solid var(--good);padding-top:14px;">
          <div class="field"><label for="a-${t.id}">Assign to</label>
            <input id="a-${t.id}" type="text" name="assigned_to" list="firm-staff" value="${esc(t.assigned_to || "")}" maxlength="200" autocomplete="off"></div>
          <div class="grid2">
            <div><label for="p-${t.id}">Priority</label>
              <select id="p-${t.id}" name="priority">${PRIORITIES.map(p => `<option value="${p}"${p === pri ? " selected" : ""}>${p[0].toUpperCase() + p.slice(1)}</option>`).join("")}</select></div>
            <div><label for="d-${t.id}">Due</label>
              <input id="d-${t.id}" type="date" name="due_date" value="${esc(isoDay(t.due_date))}"></div>
          </div>
          <div class="field"><label for="n-${t.id}">Note to the consultant (optional)</label>
            <input id="n-${t.id}" type="text" name="note" maxlength="2000" placeholder="They will see this"></div>
          <button type="submit" class="btn-primary">Approve</button>
        </form>
        <form method="POST" action="${PAGE}/${t.id}/reject" style="border-top:3px solid var(--bad);padding-top:14px;">
          <div class="field"><label for="r-${t.id}">Reason for not accepting</label>
            <textarea id="r-${t.id}" name="reason" rows="5" maxlength="2000" required placeholder="The consultant will see this, so say what would change the answer."></textarea></div>
          <button type="submit" class="btn-secondary btn-danger">Do not accept</button>
        </form>
      </div>
    </section>`;
  }).join("");

  const decided = recent.map(d => `
      <div>
        <div><div class="t">${esc(d.title)}</div>
          <div class="m">${d.client_name ? esc(d.client_name) + " · " : ""}from ${esc(d.submitter || "a consultant")}${d.note ? ` · “${esc(String(d.note).slice(0, 140))}”` : ""}</div></div>
        <div><span class="tag" style="--dot:${d.action === "approved" ? "var(--good)" : "var(--bad)"};">${d.action === "approved" ? "Approved" : "Not accepted"}</span>
          <div class="m">${esc(d.actor_name || "")}</div></div>
        <div class="m">${esc(when(d.created_at))}</div>
      </div>`).join("");

  const body = `
    <div class="page-header">
      <h1>Consultant tasks waiting for approval</h1>
      <div class="sub">Sent in by consultants. Nothing here is in the firm's own task list, and nobody is reminded about it,
        until an attorney or manager approves it. The consultant is told either way.</div>
    </div>
    ${flash ? `<div class="card ok">${esc(flash)}</div>` : ""}
    ${error ? `<div class="card warn">${esc(error)}</div>` : ""}
    ${cards || `<div class="card"><div class="empty">Nothing is waiting.</div></div>`}
    <datalist id="firm-staff">${staff.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
    ${decided ? `<h3 style="margin-top:34px;">Recently decided</h3><div class="card flush"><div class="rows">${decided}</div></div>` : ""}`;

  return theme.page({
    title: "Consultant tasks", area: "Consultant Tasks",
    nav: navFor(user, pending.length), active: "pending", who: nameOf(user), body,
  });
}

// The alerts page proper (/admin/alerts) edits consultants' contact details,
// so it stays with admins and managers; an attorney is not shown the link.
function navFor(user, waiting) {
  return [
    { key: "pending", href: PAGE, label: "Waiting for approval", count: waiting || null },
    { key: "alert", href: PAGE + "/alert", label: "Send an alert" },
    { key: "tasks", href: "/admin/tasks", label: "Task list" },
    ...(user && (user.r === "admin" || user.r === "manager") ? [{ key: "alerts", href: "/admin/alerts", label: "Alert settings" }] : []),
    { key: "home", href: "/admin/dashboard", label: "Dashboard" },
  ];
}

/** Tell a client's consultant that something happened — attorneys included. */
function renderAlertPage({ user, clients = [], waiting = 0, flash = null, error = null }) {
  const notify = require("./notify");
  const kinds = require("./notify-admin").HAND_KINDS.filter(k => notify.KINDS[k]);
  const body = `
    <div class="page-header">
      <h1>Send an alert to a consultant</h1>
      <div class="sub">Tells the consultant on a client that something happened. They get the headline you pick and a link to sign in;
        the substance stays behind the login, so there is no message box. Court mail, hearings and deadlines already send on their own.</div>
    </div>
    ${flash ? `<div class="card ok">${esc(flash)}</div>` : ""}
    ${error ? `<div class="card warn">${esc(error)}</div>` : ""}
    <div class="card">
      ${clients.length ? `
      <form method="POST" action="${PAGE}/alert">
        <div class="grid2">
          <div><label for="al-client">Client</label>
            <select id="al-client" name="client_key" required>
              <option value="">Choose a client</option>
              ${clients.map(c => `<option value="${esc(c.client_key)}">${esc(c.client_name || c.client_key)} · ${esc(c.consultants || "")}</option>`).join("")}
            </select>
            <div class="hint">Only clients who have a consultant are listed, with the consultant's name.</div></div>
          <div><label for="al-kind">What happened</label>
            <select id="al-kind" name="kind" required>
              <option value="">Choose a headline</option>
              ${kinds.map(k => `<option value="${k}">${esc(notify.KINDS[k].label)}</option>`).join("")}
            </select></div>
        </div>
        <button type="submit" class="btn-primary">Send alert</button>
      </form>` : `<div class="empty">No client has a consultant assigned yet.</div>`}
    </div>`;
  return theme.page({ title: "Send an alert", area: "Consultant Tasks", nav: navFor(user, waiting), active: "alert", who: nameOf(user), body });
}

/**
 * Register the firm-side pages. /admin/* is already behind sign-in
 * (server.js: app.use("/admin", auth.requireAdminAuth)); this adds the
 * role: an attorney, a manager, or an admin.
 */
function mount(app, auth) {
  app.use(PAGE, auth.requireRole(...APPROVER_ROLES));

  app.get(PAGE, async (req, res) => {
    try {
      const [pending, recent, staff] = await Promise.all([listPending(), recentDecisions(), staffNames()]);
      const files = await require("./task-attachments").listForTasks(pending.map(t => t.id));
      const done = { approved: "Approved. It is in the task list now and the consultant has been told.",
                     rejected: "Not accepted. The consultant has been sent your reason." }[req.query.done] || null;
      res.send(renderPage({ user: req.user, pending, recent, staff, files, flash: done, error: req.query.error ? String(req.query.error).slice(0, 300) : null }));
    } catch (err) {
      console.error("[work-orders page]:", err.message);
      res.status(500).send("Error: " + err.message);
    }
  });

  app.get(PAGE + "/alert", async (req, res) => {
    try {
      const [clients, waiting] = await Promise.all([require("./notify-admin").loadAlertableClients(), pendingCount()]);
      res.send(renderAlertPage({ user: req.user, clients, waiting,
        flash: req.query.sent ? String(req.query.sent).slice(0, 600) : null,
        error: req.query.problem ? String(req.query.problem).slice(0, 600) : null }));
    } catch (err) {
      console.error("[work-orders alert page]:", err.message);
      res.status(500).send("Error: " + err.message);
    }
  });
  app.post(PAGE + "/alert", async (req, res) => {
    try {
      const b = req.body || {};
      const out = await require("./notify-admin").sendByHand({ clientKey: b.client_key, kind: b.kind, user: req.user });
      res.redirect(PAGE + "/alert?" + (out.ok ? "sent=" : "problem=") + encodeURIComponent(out.text));
    } catch (err) {
      console.error("[work-orders alert]:", err.message);
      res.redirect(PAGE + "/alert?problem=" + encodeURIComponent(err.message));
    }
  });

  const decide = (fn, done) => async (req, res) => {
    try {
      const out = await fn(req);
      res.redirect(PAGE + "?" + (out.ok ? "done=" + done : "error=" + encodeURIComponent(out.error)));
    } catch (err) {
      console.error("[work-orders decide]:", err.message);
      res.redirect(PAGE + "?error=" + encodeURIComponent(err.message));
    }
  };
  app.post(PAGE + "/:id/approve", decide(req => {
    const b = req.body || {};
    return approve(req.params.id, req.user, { assigned_to: b.assigned_to, priority: b.priority, due_date: b.due_date, note: b.note });
  }, "approved"));
  app.post(PAGE + "/:id/reject", decide(req => reject(req.params.id, req.user, (req.body || {}).reason), "rejected"));
}

module.exports = {
  PAGE, APPROVER_ROLES, canApprove, MATTERS,
  pendingCount, listPending, recentDecisions, approve, reject, announce,
  renderPage, renderAlertPage, mount,
};
