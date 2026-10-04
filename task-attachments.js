// ============================================================
//  task-attachments.js — DOCUMENTS ON A CONSULTANT'S TASK
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  A consultant sending the firm a task usually has paper to go
//  with it — a passport page, a notice, a signed agreement. Until
//  now that had to travel by email or by message, apart from the
//  task it belonged to, and whoever approved the task approved it
//  blind.
//
//  The files ride with the task:
//
//    consultant   adds them when sending a task, or later on its
//                 page; sees and downloads only what THEY added
//    the firm     sees every file on the approval page and on the
//                 task, and downloads them
//
//  What keeps it safe:
//    · a short list of document and image types — nothing that
//      runs (no .html, .js, .exe, .zip);
//    · 15 MB a file, 12 files a task;
//    · always served as a download with nosniff, never shown
//      inline, so an uploaded file cannot run in the firm's
//      browser session;
//    · the file's bytes are never in a list query — the list
//      selects named columns, and only the download reads content.
//
//  Stored in Postgres beside the task (like client_documents).
//  Filing a copy into the client's Dropbox folder is a decision
//  for whoever approves the task, not something a consultant's
//  upload should do on its own.
// ============================================================

const db = require("./db");

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 12;
const TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", webp: "image/webp", gif: "image/gif",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain", rtf: "application/rtf", csv: "text/csv",
};
const ALLOWED = Object.keys(TYPES);
const CLOSED = new Set(["completed", "cancelled", "rejected"]);

let _ready = null;
function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS task_attachments (
        id               SERIAL PRIMARY KEY,
        task_id          INTEGER NOT NULL,
        filename         TEXT NOT NULL,
        mime             TEXT NOT NULL,
        bytes            INTEGER NOT NULL,
        content          BYTEA NOT NULL,
        uploaded_by      INTEGER,
        uploaded_by_name TEXT,
        uploaded_by_role TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS task_attachments_task ON task_attachments (task_id, created_at)`).catch(() => {});
  })().catch(e => { _ready = null; throw e; });
  return _ready;
}

// "Passport (scan).PDF" → { name: "Passport (scan).PDF", ext: "pdf" }; null if not allowed.
function cleanName(original) {
  // multer hands a non-ASCII file name over as Latin-1 bytes ("æ¤ç§" for
  // "护照"). If every character fits in one byte and the bytes are valid
  // UTF-8, they were UTF-8 all along: read them as such.
  let raw = String(original || "");
  if (/[\u0080-\u00ff]/.test(raw) && !/[^\u0000-\u00ff]/.test(raw)) {
    const again = Buffer.from(raw, "latin1").toString("utf8");
    if (!again.includes("\ufffd")) raw = again;
  }
  const base = raw.replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f<>:"|?*]/g, "").trim().slice(-120);
  const m = base.match(/\.([A-Za-z0-9]{1,5})$/);
  const ext = m ? m[1].toLowerCase() : "";
  if (!base || !TYPES[ext]) return null;
  return { name: base, ext };
}

const LIST_COLS = `id, task_id, filename, mime, bytes, uploaded_by, uploaded_by_name, uploaded_by_role, created_at`;

/** Every file on a task (firm side). Never selects the bytes. */
async function listForTask(taskId) {
  await ensure();
  const r = await db.query(`SELECT ${LIST_COLS} FROM task_attachments WHERE task_id = $1 ORDER BY created_at ASC`, [taskId]);
  return r.rows;
}

/** Files on several tasks at once, for the approval page: { taskId: [rows] }. */
async function listForTasks(taskIds) {
  const ids = (taskIds || []).filter(Number.isInteger);
  const out = {};
  if (!ids.length) return out;
  try {
    await ensure();
    const r = await db.query(`SELECT ${LIST_COLS} FROM task_attachments WHERE task_id = ANY($1::int[]) ORDER BY created_at ASC`, [ids]);
    for (const row of r.rows) (out[row.task_id] = out[row.task_id] || []).push(row);
  } catch (e) { console.warn("[task-attachments] list:", e.message); }
  return out;
}

/** The files a consultant added to their own task. */
async function listMine(taskId, userId) {
  await ensure();
  const r = await db.query(
    `SELECT ${LIST_COLS} FROM task_attachments WHERE task_id = $1 AND uploaded_by = $2 ORDER BY created_at ASC`, [taskId, userId]);
  return r.rows;
}

/**
 * Save one uploaded file onto a task.
 * @param {{originalname:string, buffer:Buffer, size:number}} file  multer's memory file
 * @returns {{ok:true, attachment}|{ok:false, status, error}}
 */
async function add(task, file, who) {
  await ensure();
  if (!file || !file.buffer || !file.buffer.length) return { ok: false, status: 400, error: "No file was received." };
  const n = cleanName(file.originalname);
  if (!n) return { ok: false, status: 415, error: `That kind of file cannot be attached. Use: ${ALLOWED.join(", ")}.` };
  if (file.buffer.length > MAX_BYTES) return { ok: false, status: 413, error: "That file is over 15 MB." };
  const count = await db.query(`SELECT COUNT(*)::int AS n FROM task_attachments WHERE task_id = $1`, [task.id]);
  if (count.rows[0].n >= MAX_FILES) return { ok: false, status: 409, error: `A task can carry ${MAX_FILES} files. Send the rest by message.` };
  const r = await db.query(
    `INSERT INTO task_attachments (task_id, filename, mime, bytes, content, uploaded_by, uploaded_by_name, uploaded_by_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${LIST_COLS}`,
    [task.id, n.name, TYPES[n.ext], file.buffer.length, file.buffer, who.uid, who.name || null, who.role || null]);
  return { ok: true, attachment: r.rows[0] };
}

async function getWithContent(id) {
  await ensure();
  const r = await db.query(`SELECT * FROM task_attachments WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

function sendDownload(res, a) {
  const ascii = String(a.filename).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Type", a.mime || "application/octet-stream");
  res.setHeader("Content-Length", a.bytes);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.end(a.content);
}

const publicRow = (a) => ({ id: a.id, filename: a.filename, bytes: a.bytes, created_at: a.created_at, uploaded_by_name: a.uploaded_by_name || null });

/** Register the routes. Called from app-api.js with its own guards. */
function attach(app, { requireBearer, requireConsultantRole, requireFirmUser }) {
  const multer = require("multer");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
  // multer reports an oversize file by calling next(err); say it in words.
  const one = (req, res, next) => upload.single("file")(req, res, (err) => {
    if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "That file is over 15 MB." : "The upload could not be read." });
    next();
  });
  const idOf = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
  const ownTask = async (req) => {
    const id = idOf(req.params.id);
    if (!id) return null;
    const t = await require("./tasks").getTask(id);
    return t && String(t.submitted_by_user_id) === String(req.user.uid) ? t : null;
  };

  // ── Consultant ──
  app.get("/api/consultant/tasks/:id/attachments", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const t = await ownTask(req);
      if (!t) return res.status(404).json({ ok: false, error: "Not found" });
      res.json({ ok: true, attachments: (await listMine(t.id, req.user.uid)).map(publicRow), can_add: !CLOSED.has(t.status), allowed: ALLOWED, max_mb: 15 });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post("/api/consultant/tasks/:id/attachments", requireBearer, requireConsultantRole, one, async (req, res) => {
    try {
      const t = await ownTask(req);
      if (!t) return res.status(404).json({ ok: false, error: "Not found" });
      if (CLOSED.has(t.status)) return res.status(409).json({ ok: false, error: "This task is closed. Send a new task, or a message." });
      const out = await add(t, req.file, { uid: req.user.uid, name: req.user.n || req.user.u, role: req.user.r });
      if (!out.ok) return res.status(out.status).json({ ok: false, error: out.error });
      // On the task's timeline for both sides; and, once the firm has taken
      // the task on, a nudge to whoever holds it.
      await require("./tasks").logActivity(t.id, {
        actor_id: req.user.uid, actor_name: req.user.n || req.user.u, actor_role: req.user.r,
        action: "attachment_added", note: out.attachment.filename, visible_to_submitter: true,
      });
      if (t.assigned_to && t.status !== "pending_approval") {
        try {
          require("./push-notifications").sendToFirmByName(t.assigned_to, {
            title: "Document added to a task", body: `${req.user.n || "A consultant"}: ${t.title}`, data: { screen: "task", taskId: t.id },
          }).catch(() => {});
        } catch { /* a courtesy */ }
      }
      res.json({ ok: true, attachment: publicRow(out.attachment) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/consultant/attachments/:aid", requireBearer, requireConsultantRole, async (req, res) => {
    try {
      const a = idOf(req.params.aid) ? await getWithContent(idOf(req.params.aid)) : null;
      // Their own upload, on their own task — both, so that a reassigned or
      // deleted task does not leave a stray door open.
      if (!a || String(a.uploaded_by) !== String(req.user.uid)) return res.status(404).json({ ok: false, error: "Not found" });
      const t = await require("./tasks").getTask(a.task_id);
      if (!t || String(t.submitted_by_user_id) !== String(req.user.uid)) return res.status(404).json({ ok: false, error: "Not found" });
      sendDownload(res, a);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── Firm ──
  app.get("/api/staff/tasks/:id/attachments", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const id = idOf(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: "Bad id" });
      res.json({ ok: true, attachments: (await listForTask(id)).map(publicRow) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.get("/api/staff/task-attachments/:aid", requireBearer, requireFirmUser, async (req, res) => {
    try {
      const a = idOf(req.params.aid) ? await getWithContent(idOf(req.params.aid)) : null;
      if (!a) return res.status(404).json({ ok: false, error: "Not found" });
      sendDownload(res, a);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
}

module.exports = { attach, ensure, add, listForTask, listForTasks, listMine, cleanName, sendDownload, ALLOWED, MAX_BYTES, MAX_FILES, TYPES };
