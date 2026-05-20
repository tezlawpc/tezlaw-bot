// ============================================================
//  matter-manager.js — Tez Law P.C. | Matter Management API
//
//  REST API for managing active legal matters, deadlines,
//  notes, and document links. Mounted under /admin/matters
//  in server.js, inheriting admin auth via requireAuth.
//
//  Also exports a top-level calendar feed handler used by
//  GET /calendar/:secret.ics in server.js — the calendar feed
//  is NOT under /admin because Outlook/Google Calendar fetch
//  without cookies, authenticating via the per-user secret.
//
//  Cal. Rule of Professional Conduct 1.6 (confidentiality)
//  Cal. State Bar Formal Op. 2010-179 (cloud computing duties)
// ============================================================

const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const { requireAuth } = require("./admin");

const router = express.Router();

// ── Helper: get the current user id (single-user system) ──
// For now, every authenticated admin session is JJ Zhang (user id 1).
// When multi-user is added later, derive this from the session token.
async function getCurrentUserId(req) {
  try {
    const r = await db.query(
      `SELECT id FROM users WHERE username = 'jj' LIMIT 1`
    );
    return r.rows[0]?.id || null;
  } catch (err) {
    console.error("getCurrentUserId error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  MATTERS — list, create, read, update, archive, delete
// ─────────────────────────────────────────────────────────────

// GET /admin/matters/api/matters?status=active
// List matters for the current user.
router.get("/api/matters", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const status = req.query.status || "active";
    if (!["active", "closed", "archived", "all"].includes(status)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    const whereClause = status === "all"
      ? "WHERE user_id = $1"
      : "WHERE user_id = $1 AND status = $2";
    const params = status === "all" ? [userId] : [userId, status];

    const r = await db.query(
      `SELECT id, client_name, matter_ref, court, case_type, status,
              dropbox_url, notes, created_at, updated_at
       FROM matters
       ${whereClause}
       ORDER BY updated_at DESC`,
      params
    );

    // Attach the count of upcoming uncompleted deadlines per matter
    const matters = await Promise.all(r.rows.map(async (m) => {
      const dr = await db.query(
        `SELECT COUNT(*) AS upcoming,
                MIN(due_date) AS next_due
         FROM matter_deadlines
         WHERE matter_id = $1 AND completed = FALSE`,
        [m.id]
      );
      return {
        ...m,
        upcoming_deadlines: parseInt(dr.rows[0].upcoming) || 0,
        next_due: dr.rows[0].next_due
      };
    }));

    res.json({ matters });
  } catch (err) {
    console.error("GET /api/matters error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/matters/api/matters/:id
// Get full matter detail including deadlines, notes, files.
router.get("/api/matters/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.id);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid id" });

    const mr = await db.query(
      `SELECT * FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Not found" });

    const dr = await db.query(
      `SELECT id, title, citation, due_date, party, note, completed,
              created_at, updated_at
       FROM matter_deadlines
       WHERE matter_id = $1
       ORDER BY due_date ASC`,
      [matterId]
    );

    const nr = await db.query(
      `SELECT id, content, created_at, updated_at
       FROM matter_notes
       WHERE matter_id = $1
       ORDER BY created_at DESC`,
      [matterId]
    );

    const fr = await db.query(
      `SELECT id, filename, url, created_at
       FROM matter_files
       WHERE matter_id = $1
       ORDER BY created_at DESC`,
      [matterId]
    );

    res.json({
      matter: mr.rows[0],
      deadlines: dr.rows,
      notes: nr.rows,
      files: fr.rows
    });
  } catch (err) {
    console.error("GET /api/matters/:id error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/matters/api/matters
// Create a new matter.
router.post("/api/matters", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const {
      client_name, matter_ref, court, case_type,
      status, dropbox_url, notes
    } = req.body || {};

    if (!client_name || typeof client_name !== "string") {
      return res.status(400).json({ error: "client_name required" });
    }

    const finalStatus = status || "active";
    if (!["active", "closed", "archived"].includes(finalStatus)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const r = await db.query(
      `INSERT INTO matters
         (user_id, client_name, matter_ref, court, case_type, status, dropbox_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, client_name, matter_ref || null, court || null, case_type || null,
       finalStatus, dropbox_url || null, notes || null]
    );

    res.json({ matter: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") { // unique violation
      return res.status(409).json({ error: "Matter with that case number already exists" });
    }
    console.error("POST /api/matters error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /admin/matters/api/matters/:id
// Update matter fields.
router.patch("/api/matters/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.id);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid id" });

    const allowed = ["client_name", "matter_ref", "court", "case_type",
                     "status", "dropbox_url", "notes"];
    const fields = [];
    const values = [matterId, userId];
    let i = 3;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        if (k === "status" && !["active", "closed", "archived"].includes(req.body[k])) {
          return res.status(400).json({ error: "Invalid status" });
        }
        fields.push(`${k} = $${i++}`);
        values.push(req.body[k]);
      }
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    const r = await db.query(
      `UPDATE matters SET ${fields.join(", ")}
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ matter: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Matter with that case number already exists" });
    }
    console.error("PATCH /api/matters/:id error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/matters/api/matters/:id
// Hard delete. CASCADES to deadlines, notes, files.
// Use status='archived' for soft delete; this is for true removal.
router.delete("/api/matters/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.id);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid id" });

    const r = await db.query(
      `DELETE FROM matters WHERE id = $1 AND user_id = $2 RETURNING id`,
      [matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: matterId });
  } catch (err) {
    console.error("DELETE /api/matters/:id error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  DEADLINES — nested under matters
// ─────────────────────────────────────────────────────────────

// POST /admin/matters/api/matters/:matterId/deadlines
router.post("/api/matters/:matterId/deadlines", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    // Verify user owns this matter
    const mr = await db.query(
      `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Matter not found" });

    const { title, citation, due_date, party, note } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });
    if (!due_date) return res.status(400).json({ error: "due_date required" });
    if (party && !["us", "them", "court"].includes(party)) {
      return res.status(400).json({ error: "Invalid party (must be us, them, or court)" });
    }

    const r = await db.query(
      `INSERT INTO matter_deadlines
         (matter_id, title, citation, due_date, party, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [matterId, title, citation || null, due_date, party || "us", note || null]
    );

    res.json({ deadline: r.rows[0] });
  } catch (err) {
    console.error("POST deadlines error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /admin/matters/api/matters/:matterId/deadlines/:id
router.patch("/api/matters/:matterId/deadlines/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const deadlineId = parseInt(req.params.id);
    if (isNaN(matterId) || isNaN(deadlineId)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    // Verify ownership chain: deadline -> matter -> user
    const own = await db.query(
      `SELECT md.id FROM matter_deadlines md
       JOIN matters m ON m.id = md.matter_id
       WHERE md.id = $1 AND md.matter_id = $2 AND m.user_id = $3`,
      [deadlineId, matterId, userId]
    );
    if (!own.rows.length) return res.status(404).json({ error: "Not found" });

    const allowed = ["title", "citation", "due_date", "party", "note", "completed"];
    const fields = [];
    const values = [deadlineId];
    let i = 2;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        if (k === "party" && !["us", "them", "court"].includes(req.body[k])) {
          return res.status(400).json({ error: "Invalid party" });
        }
        fields.push(`${k} = $${i++}`);
        values.push(req.body[k]);
      }
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    const r = await db.query(
      `UPDATE matter_deadlines SET ${fields.join(", ")}
       WHERE id = $1 RETURNING *`,
      values
    );
    res.json({ deadline: r.rows[0] });
  } catch (err) {
    console.error("PATCH deadlines error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/matters/api/matters/:matterId/deadlines/:id
router.delete("/api/matters/:matterId/deadlines/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const deadlineId = parseInt(req.params.id);

    const r = await db.query(
      `DELETE FROM matter_deadlines md
       USING matters m
       WHERE md.id = $1 AND md.matter_id = $2 AND m.id = md.matter_id AND m.user_id = $3
       RETURNING md.id`,
      [deadlineId, matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: deadlineId });
  } catch (err) {
    console.error("DELETE deadlines error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  NOTES — nested under matters
// ─────────────────────────────────────────────────────────────

router.post("/api/matters/:matterId/notes", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const mr = await db.query(
      `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Matter not found" });

    const { content } = req.body || {};
    if (!content) return res.status(400).json({ error: "content required" });

    const r = await db.query(
      `INSERT INTO matter_notes (matter_id, content)
       VALUES ($1, $2) RETURNING *`,
      [matterId, content]
    );
    res.json({ note: r.rows[0] });
  } catch (err) {
    console.error("POST notes error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/api/matters/:matterId/notes/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const noteId = parseInt(req.params.id);

    const r = await db.query(
      `DELETE FROM matter_notes mn
       USING matters m
       WHERE mn.id = $1 AND mn.matter_id = $2 AND m.id = mn.matter_id AND m.user_id = $3
       RETURNING mn.id`,
      [noteId, matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: noteId });
  } catch (err) {
    console.error("DELETE notes error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  FILES — nested under matters
// ─────────────────────────────────────────────────────────────

router.post("/api/matters/:matterId/files", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const mr = await db.query(
      `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Matter not found" });

    const { filename, url } = req.body || {};
    if (!filename || !url) {
      return res.status(400).json({ error: "filename and url required" });
    }

    const r = await db.query(
      `INSERT INTO matter_files (matter_id, filename, url)
       VALUES ($1, $2, $3) RETURNING *`,
      [matterId, filename, url]
    );
    res.json({ file: r.rows[0] });
  } catch (err) {
    console.error("POST files error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/api/matters/:matterId/files/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const fileId = parseInt(req.params.id);

    const r = await db.query(
      `DELETE FROM matter_files mf
       USING matters m
       WHERE mf.id = $1 AND mf.matter_id = $2 AND m.id = mf.matter_id AND m.user_id = $3
       RETURNING mf.id`,
      [fileId, matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: fileId });
  } catch (err) {
    console.error("DELETE files error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  CALENDAR FEED — top-level, no session auth, secret-protected
//
//  Mounted in server.js as GET /calendar/:secret.ics
//  Outlook/Google Calendar fetch this URL on a schedule (every
//  15min – 1hr depending on client) without cookies.
//  Authenticated by the per-user calendar_secret.
// ─────────────────────────────────────────────────────────────

// RFC 5545 date format (YYYYMMDD for all-day events)
function icsDate(date) {
  const d = new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// RFC 5545 timestamp format (DTSTAMP requires UTC ISO)
function icsTimestamp(date) {
  const d = new Date(date);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Escape special chars in calendar text fields per RFC 5545
function icsEscape(s) {
  if (!s) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

// Add days to a date string (YYYY-MM-DD), returning YYYYMMDD ICS format
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return icsDate(d);
}

// Handler — called from server.js
// GET /calendar/:secret.ics
async function handleCalendarFeed(req, res) {
  try {
    let secretParam = req.params.secret || "";
    // Strip trailing ".ics" if present (some clients add it; some don't)
    if (secretParam.endsWith(".ics")) {
      secretParam = secretParam.slice(0, -4);
    }

    // Must be 64-char hex per our schema
    if (!/^[a-f0-9]{64}$/.test(secretParam)) {
      return res.status(404).send("Not found");
    }

    // Look up the user by secret. Use a constant-time comparison even though
    // we're querying — the DB query itself is parameterized which prevents
    // injection; constant-time matters for the actual string compare.
    const r = await db.query(
      `SELECT id, username, display_name, calendar_secret
       FROM users
       WHERE calendar_secret = $1`,
      [secretParam]
    );

    if (!r.rows.length) return res.status(404).send("Not found");

    const user = r.rows[0];
    // Defense in depth: constant-time compare of the matched row
    const a = Buffer.from(user.calendar_secret);
    const b = Buffer.from(secretParam);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(404).send("Not found");
    }

    // Pull deadlines: non-archived matters, not-done, within next 365 days
    const dr = await db.query(
      `SELECT
         d.id           AS deadline_id,
         d.title        AS title,
         d.citation     AS citation,
         d.due_date     AS due_date,
         d.party        AS party,
         d.note         AS note,
         m.id           AS matter_id,
         m.client_name  AS client_name,
         m.matter_ref   AS matter_ref,
         m.court        AS court,
         m.case_type    AS case_type
       FROM matter_deadlines d
       JOIN matters m ON m.id = d.matter_id
       WHERE m.user_id = $1
         AND m.status != 'archived'
         AND d.completed = FALSE
         AND d.due_date >= CURRENT_DATE
         AND d.due_date <= CURRENT_DATE + INTERVAL '365 days'
       ORDER BY d.due_date ASC`,
      [user.id]
    );

    // Build the .ics body
    const now = icsTimestamp(new Date());
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Tez Law P.C.//Matter Manager//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:TEZ Matters — ${icsEscape(user.display_name || user.username)}`,
      "X-WR-TIMEZONE:America/Los_Angeles",
      "X-PUBLISHED-TTL:PT15M"
    ];

    for (const row of dr.rows) {
      const partyLabel = row.party === "them" ? "OPP" : row.party === "court" ? "CT" : "US";
      const summary = `[${partyLabel}] ${row.client_name} — ${row.title}`;
      const descParts = [];
      if (row.matter_ref) descParts.push(`Ref: ${row.matter_ref}`);
      if (row.court)      descParts.push(`Court: ${row.court}`);
      if (row.case_type)  descParts.push(`Type: ${row.case_type}`);
      if (row.citation)   descParts.push(`Citation: ${row.citation}`);
      if (row.note)       descParts.push("", row.note);
      const description = descParts.join("\n");
      const uid = `${row.matter_id}-${row.deadline_id}@tezlawfirm`;
      const dtstart = icsDate(row.due_date);
      const dtend   = addDays(row.due_date, 1); // all-day events, exclusive end

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART;VALUE=DATE:${dtstart}`);
      lines.push(`DTEND;VALUE=DATE:${dtend}`);
      lines.push(`SUMMARY:${icsEscape(summary)}`);
      if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
      lines.push("STATUS:CONFIRMED");
      lines.push("TRANSP:OPAQUE");

      // 7-day reminder
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${icsEscape(summary)} — 7 days`);
      lines.push("TRIGGER:-P7D");
      lines.push("END:VALARM");

      // 1-day reminder
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${icsEscape(summary)} — 1 day`);
      lines.push("TRIGGER:-P1D");
      lines.push("END:VALARM");

      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    // RFC 5545 requires CRLF line endings
    const body = lines.join("\r\n") + "\r\n";

    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow"
    });
    res.send(body);
  } catch (err) {
    console.error("Calendar feed error:", err.message);
    res.status(500).send("Internal Server Error");
  }
}

module.exports = { router, handleCalendarFeed };
