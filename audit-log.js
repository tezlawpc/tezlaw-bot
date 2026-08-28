// ============================================================
//  TEZ LAW P.C. — AUDIT LOG
//  ─────────────────────────────────────────────────────────
//  Tracks every meaningful change made through Zara's admin
//  interface. Answers: who did what, when, to what record.
//
//  Design:
//  - Single audit_log table with JSONB `changes` field
//  - Silent middleware you can wrap any write with
//  - Viewer page for admins at /admin/audit-log
//  - Never blocks main flow: log failures are logged, not thrown
// ============================================================

const db = require("./db");

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id           SERIAL PRIMARY KEY,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      user_id      INTEGER,
      username     TEXT,
      user_role    TEXT,
      action       TEXT NOT NULL,
      target_type  TEXT,
      target_id    TEXT,
      target_label TEXT,
      changes      JSONB,
      ip_address   TEXT,
      user_agent   TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at DESC)`);
}

// Standard action identifiers — use these constants when calling log().
const ACTIONS = {
  USER_LOGIN:         "user.login",
  USER_LOGIN_FAILED:  "user.login_failed",
  USER_LOGOUT:        "user.logout",
  USER_CREATED:       "user.created",
  USER_DELETED:       "user.deleted",
  USER_ROLE_CHANGED:  "user.role_changed",
  USER_PASSWORD_CHANGED: "user.password_changed",
  USER_PASSWORD_RESET:   "user.password_reset",

  HEARING_CREATED:    "hearing.created",
  HEARING_UPDATED:    "hearing.updated",
  HEARING_DELETED:    "hearing.deleted",
  HEARING_SUMMARY_SENT: "hearing.summary_sent",

  CLIENT_DOC_UPLOADED: "client_doc.uploaded",
  CLIENT_DOC_DELETED:  "client_doc.deleted",

  DROPBOX_FILE_LINKED:   "dropbox.file_linked",
  DROPBOX_FILE_UNLINKED: "dropbox.file_unlinked",
  DROPBOX_FILE_UPLOADED: "dropbox.file_uploaded",
  DROPBOX_FILE_DELETED:  "dropbox.file_deleted",

  NOTICE_SENT:        "notice.sent",
  NOTICE_SCANNED:     "notice.scanned",

  BULK_IMPORT:        "bulk.import",
};

// Log an action. Never throws; failures go to console.
// Usage:
//   await audit.log({ req, action: ACTIONS.HEARING_CREATED, target_type: 'hearing', target_id: id, target_label: clientName })
async function log({ req, action, target_type = null, target_id = null, target_label = null, changes = null }) {
  try {
    const user = req?.user || {};
    const ipHeader = req?.headers?.["x-forwarded-for"];
    const ip = (ipHeader ? ipHeader.split(",")[0].trim() : (req?.socket?.remoteAddress || null));
    await db.query(
      `INSERT INTO audit_log
         (user_id, username, user_role, action, target_type, target_id, target_label, changes, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        user.uid || null,
        user.u || null,
        user.r || null,
        action,
        target_type,
        target_id != null ? String(target_id) : null,
        target_label ? String(target_label).substring(0, 200) : null,
        changes ? JSON.stringify(changes) : null,
        ip,
        req?.headers?.["user-agent"] ? String(req.headers["user-agent"]).substring(0, 500) : null,
      ]
    );
  } catch (err) {
    console.warn("[audit] log failed:", err.message);
  }
}

async function listRecent({ userId = null, action = null, limit = 200, before = null } = {}) {
  await initTable();
  const conditions = [];
  const params = [];
  if (userId) { conditions.push(`user_id = $${params.length + 1}`); params.push(userId); }
  if (action) { conditions.push(`action = $${params.length + 1}`); params.push(action); }
  if (before) { conditions.push(`created_at < $${params.length + 1}`); params.push(before); }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  params.push(limit);
  const r = await db.query(
    `SELECT id, created_at, user_id, username, user_role, action, target_type, target_id, target_label, changes, ip_address
     FROM audit_log
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function listDistinctUsers() {
  await initTable();
  const r = await db.query(
    `SELECT DISTINCT user_id, username FROM audit_log WHERE user_id IS NOT NULL ORDER BY username`
  );
  return r.rows;
}

// Render the audit log viewer page (admin-only)
function renderAuditLogPage({ entries, filters, users, actions }) {
  const hearingNotes = require("./hearing-notes");

  const ACTION_LABELS = {
    "user.login": "🔓 Login",
    "user.login_failed": "❌ Failed login",
    "user.logout": "🚪 Logout",
    "user.created": "➕ User created",
    "user.deleted": "🗑️ User deleted",
    "user.role_changed": "🔄 Role changed",
    "user.password_changed": "🔑 Password changed",
    "user.password_reset": "🔓 Password reset",
    "hearing.created": "📝 Hearing note created",
    "hearing.updated": "✏️ Hearing note updated",
    "hearing.deleted": "🗑️ Hearing note deleted",
    "hearing.summary_sent": "📤 Summary sent",
    "client_doc.uploaded": "📎 Doc uploaded",
    "client_doc.deleted": "🗑️ Doc deleted",
    "dropbox.file_linked": "🔗 File linked to exhibit",
    "dropbox.file_unlinked": "🔗 File unlinked",
    "dropbox.file_uploaded": "☁️ File uploaded to Dropbox",
    "dropbox.file_deleted": "🗑️ File deleted from Dropbox",
    "notice.sent": "✉️ Client notified",
    "notice.scanned": "🔍 Notice scanned",
    "bulk.import": "📦 Bulk import",
    // Motion generator (added post-launch)
    "motion.generate": "📜 Motion drafted",
    "motion.delete": "🗑️ Motion deleted",
    "motion.upload_dropbox": "☁️ Motion uploaded to Dropbox",
    "motion_template.upload": "📋 Motion template uploaded",
  };

  const rows = entries.length ? entries.map(e => {
    try {
      const ts = e.created_at ? new Date(e.created_at).toLocaleString() : "";
      const roleColor = { admin: "#0C1C36", attorney: "#B79C62", paralegal: "#0061FF", viewer: "#666" }[e.user_role] || "#999";
      const changesPreview = shortenJson(e.changes);
      return `
        <tr>
          <td style="white-space:nowrap; font-size:11px; color:#666;">${escapeHtml(ts)}</td>
          <td>
            <strong>${escapeHtml(e.username || "(system)")}</strong>
            ${e.user_role ? `<span style="background:${roleColor}; color:white; padding:1px 6px; border-radius:8px; font-size:9px; margin-left:4px;">${escapeHtml(e.user_role)}</span>` : ""}
          </td>
          <td>${escapeHtml(ACTION_LABELS[e.action] || e.action || "")}</td>
          <td>
            ${e.target_label ? `<strong>${escapeHtml(e.target_label)}</strong>` : ""}
            ${e.target_type ? `<div style="font-size:10px; color:#999;">${escapeHtml(e.target_type)}${e.target_id ? ":" + escapeHtml(e.target_id) : ""}</div>` : ""}
          </td>
          <td style="font-size:11px; color:#666; font-family:monospace; max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(changesPreview)}">${escapeHtml(changesPreview)}</td>
          <td style="font-size:10px; color:#999; font-family:monospace;">${escapeHtml(e.ip_address || "")}</td>
        </tr>`;
    } catch (renderErr) {
      // Skip individual bad rows rather than crashing the whole page
      return `<tr><td colspan="6" style="color:#c00; font-size:11px; padding:6px;">⚠️ Skipped entry #${e.id}: ${escapeHtml(renderErr.message)}</td></tr>`;
    }
  }).join("") : `<tr><td colspan="6" style="text-align:center; color:#888; padding:30px;">No audit entries match your filters.</td></tr>`;

  const userOptions = users.map(u =>
    `<option value="${u.user_id}" ${String(filters.userId) === String(u.user_id) ? "selected" : ""}>${escapeHtml(u.username)}</option>`
  ).join("");
  const actionOptions = actions.map(a =>
    `<option value="${a}" ${filters.action === a ? "selected" : ""}>${escapeHtml(ACTION_LABELS[a] || a)}</option>`
  ).join("");

  const body = `
    <div class="page-header">
      <h1>📜 Audit Log</h1>
      <div style="font-size:13px; color:#666;">Every change made through Zara — who did what, when, and to which record.</div>
    </div>

    <div style="background:white; padding:15px 20px; border-radius:6px; margin-bottom:15px; border:1px solid #eee;">
      <form method="GET" style="display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
        <div>
          <label style="font-size:11px; color:#666; display:block;">User</label>
          <select name="user_id" style="padding:7px; border:1px solid #ccc; border-radius:3px; min-width:120px;">
            <option value="">All users</option>${userOptions}
          </select>
        </div>
        <div>
          <label style="font-size:11px; color:#666; display:block;">Action type</label>
          <select name="action" style="padding:7px; border:1px solid #ccc; border-radius:3px; min-width:180px;">
            <option value="">All actions</option>${actionOptions}
          </select>
        </div>
        <div>
          <button type="submit" style="background:#0C1C36; color:white; padding:8px 14px; border:none; border-radius:3px; cursor:pointer; font-size:13px;">Filter</button>
        </div>
        <div>
          <a href="/admin/audit-log" style="color:#B79C62; font-size:12px;">Clear</a>
        </div>
        <div style="margin-left:auto; font-size:12px; color:#666;">
          Showing latest <strong>${entries.length}</strong> ${entries.length === 200 ? "(limit)" : ""}
        </div>
      </form>
    </div>

    <table style="background:white; width:100%;">
      <thead>
        <tr>
          <th style="width:130px;">When</th>
          <th style="width:130px;">Who</th>
          <th style="width:200px;">What</th>
          <th>Target</th>
          <th style="width:250px;">Changes</th>
          <th style="width:100px;">IP</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  return hearingNotes.renderAdminChrome({ title: "Audit Log", body, activeItem: null });
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function shortenJson(obj) {
  if (obj == null) return "";
  try {
    // Handle strings that were double-encoded
    let str;
    if (typeof obj === "string") {
      str = obj;
    } else {
      str = JSON.stringify(obj, (k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (v instanceof Date) return v.toISOString();
        return v;
      });
    }
    if (!str) return "";
    return str.length > 120 ? str.substring(0, 117) + "…" : str;
  } catch { return "[unrenderable]"; }
}

module.exports = {
  initTable,
  log,
  ACTIONS,
  listRecent,
  listDistinctUsers,
  renderAuditLogPage,
};
