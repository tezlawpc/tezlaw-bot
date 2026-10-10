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
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const db = require("./db");
const { requireAuth: requireAdminAuth } = require("./admin");

const router = express.Router();

// ── Who may use the Matter Manager ────────────────────────
// JJ (role "admin"): everything, as before.
//
// Firm staff: TRADEMARK matters only. JJ, asked whether staff need to see
// trademark matters now that they live here: "Yes they do." They get what
// they had on the Federal & TM page, by the same two permissions, so the
// per-user switches on the Permissions page keep working:
//     federal.read   see trademark matters
//     federal.write  open a trademark matter and work on it
//
// Everything else in here stays JJ's: every other kind of matter, the
// docket inbox, the court-order and NEF readers, email intake, archiving or
// deleting a matter, and removing a deadline.
//
// The rule for staff is "refused unless listed". matterAccess (mounted in
// front of this router in server.js) lets a staff request through only if
// it matches a line of STAFF_ROUTES, and only after it has looked up the
// matter the address names and found it to be a Trademark matter. A route
// added to this file later is therefore closed to staff until someone adds
// it to the list on purpose.
const TM_TYPE = "Trademark";
const STAFF_MATTER_POSTS = "deadlines|lifecycle|notes|files|tsdr/check|client-summary";
const STAFF_ROUTES = [
  { method: "GET",    re: /^\/$/ },
  { method: "GET",    re: /^\/app$/ },
  { method: "GET",    re: /^\/v2$/ },
  { method: "GET",    re: /^\/api\/me$/ },
  { method: "GET",    re: /^\/api\/matters$/ },                       // the handler lists Trademark matters only
  { method: "GET",    re: /^\/api\/matters\/(\d{1,9})$/,                              matter: true },
  { method: "GET",    re: /^\/api\/matters\/(\d{1,9})\/tsdr$/,                        matter: true },
  { method: "POST",   re: /^\/api\/matters$/,                                     write: true, creates: true },
  { method: "PATCH",  re: /^\/api\/matters\/(\d{1,9})$/,                              write: true, matter: true, edits: true },
  { method: "POST",   re: new RegExp("^\\/api\\/matters\\/(\\d{1,9})\\/(?:" + STAFF_MATTER_POSTS + ")$"), write: true, matter: true },
  { method: "POST",   re: /^\/api\/matters\/(\d{1,9})\/checklists\/template\/trademark$/, write: true, matter: true },
  { method: "PATCH",  re: /^\/api\/matters\/(\d{1,9})\/deadlines\/(\d{1,9})$/,            write: true, matter: true, deadline: true },
  { method: "DELETE", re: /^\/api\/matters\/(\d{1,9})\/(notes|files)\/(\d{1,9})$/, write: true, matter: true, removes: true },
  { method: "PATCH",  re: /^\/api\/checklist-items\/(\d{1,9})$/,                      write: true, item: true },
  { method: "POST",   re: /^\/api\/parse-uspto$/,                                write: true },
];

// What a staff member may set on a trademark matter. Not here on purpose:
// status and case_type (archiving or re-typing is JJ's), court, and the
// custody / petitioner fields that belong to other kinds of matter.
const STAFF_MATTER_FIELDS = new Set([
  "client_name", "matter_ref", "notes", "dropbox_url", "opened_date", "triggering_date", "relief_sought",
  "serial_number", "mark", "mark_format", "filing_basis", "intl_class", "owner_name", "owner_email",
]);
const DEADLINE_FIELDS = ["title", "citation", "due_date", "party", "note", "completed"];

// A matter's case number is shared by every kind of matter: it must be
// unique, and it decides which matter an inbound court email is filed under.
// So a trademark matter's case number is kept in one form, which no court
// docket number or A-number can equal:
//     "SN 97123456"    application serial number (8 digits)
//     "RN 5320233"     registration number (7 digits; an older, shorter one
//                      must be written with "RN" or "Reg. No." in front)
//     "TTAB 91234567"  Board proceeding number (8 digits beginning 91–94)
// A staff member may enter nothing else. ("cv" as a case number would have
// caught every court email the firm receives; a bare 2612345 would have
// blocked JJ from opening Ninth Circuit No. 26-12345.) What the person wrote
// in front of the number is honoured, never overridden: "RN 97123456" is
// refused, not quietly filed as a serial number.
function usptoRef(v) {
  if (typeof v !== "string" || v.length > 100) return null;     // the column holds 100; and nothing long is ever matched
  const m = /^(?:(sn|serial(?:\s+no\.?)?|rn|reg(?:istration)?\.?(?:\s+no\.?)?|ttab|opp(?:osition)?\.?(?:\s+no\.?)?|canc(?:ellation)?\.?(?:\s+no\.?)?)\s*)?([\d\s\/,\-]+)$/i.exec(v.trim());
  if (!m) return null;
  const said = (m[1] || "").toLowerCase();
  const digits = m[2].replace(/\D/g, "");
  const proceeding = /^9[1-4]\d{6}$/.test(digits);     // 91 opposition, 92 cancellation, 93 interference, 94 concurrent use
  if (said) {
    if (/^s/.test(said)) return digits.length === 8 && !proceeding ? "SN " + digits : null;
    if (/^r/.test(said)) return digits.length >= 5 && digits.length <= 7 ? "RN " + digits : null;
    return proceeding ? "TTAB " + digits : null;
  }
  if (digits.length === 8) return (proceeding ? "TTAB " : "SN ") + digits;
  return digits.length === 7 ? "RN " + digits : null;
}

// Is this USPTO number already the case number of another trademark matter,
// however it was written there ("97123456", "97/123,456", "SN 97123456")?
// Only a reference that IS a USPTO number is compared this way, and only
// with others that are: "Docket 12345-A" and "Docket 12345-B" share their
// digits and are different references. (An exact repeat of any reference is
// refused by the database, as it always was.)
async function trademarkRefTaken(userId, ref, exceptMatterId) {
  const canonical = usptoRef(ref);
  if (!canonical) return false;
  const r = await db.query(
    `SELECT matter_ref FROM matters
      WHERE user_id = $1 AND case_type = $2 AND matter_ref IS NOT NULL
        AND regexp_replace(matter_ref, '[^0-9]', '', 'g') = $3 AND id <> $4
      LIMIT 50`, [userId, TM_TYPE, canonical.replace(/\D/g, ""), exceptMatterId || 0]);
  return r.rows.some(row => usptoRef(row.matter_ref) === canonical);
}

// Longest value each field of a matter can hold. A longer one is refused
// with a sentence rather than failing in the database.
const STAFF_FIELD_MAX = {
  client_name: 200, matter_ref: 100, notes: 20000, dropbox_url: 2000, relief_sought: 300, serial_number: 40, mark: 300,
  mark_format: 40, filing_basis: 20, intl_class: 40, owner_name: 200, owner_email: 200,
};
// These hold a code or an address, never prose: no markup in them.
const STAFF_PLAIN_FIELDS = ["serial_number", "mark_format", "filing_basis", "intl_class", "owner_email"];
function isWebLink(v) { return typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()); }
function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

// Pure: which staff rule (if any) covers this request. Exported for the check.
function staffRule(method, pathname) {
  const m = String(method || "").toUpperCase();
  for (const rule of STAFF_ROUTES) {
    if (rule.method !== m) continue;
    const hit = rule.re.exec(String(pathname || ""));
    if (!hit) continue;
    const out = { ...rule, id: hit[1] ? parseInt(hit[1], 10) : null, subId: null, what: null };
    if (rule.removes) { out.what = hit[2]; out.subId = parseInt(hit[3], 10); }
    else if (hit[2]) out.subId = parseInt(hit[2], 10);
    return out;
  }
  return null;
}

// Pure: is this body acceptable from a staff member under this rule?
// Returns null when it is, or the sentence to refuse with. May tidy the
// body: fields of a new matter that belong to other kinds of matter are
// dropped, and the case number is put in its stored form.
function staffBodyProblem(rule, body) {
  if (!isPlainObject(body)) return rule.creates || rule.edits ? "Nothing to save." : null;
  const keys = Object.keys(body);
  if (keys.length > 40) return "Too many fields.";
  // Plain values only: what is checked here is then exactly what is stored.
  for (const k of keys) {
    const v = body[k];
    if (v !== null && !["string", "number", "boolean"].includes(typeof v)) return `The value of ${String(k).slice(0, 40)} must be plain text, a number, or yes/no.`;
  }
  if (rule.creates) {
    if (body.case_type !== TM_TYPE) return "Staff can open Trademark matters here. Other matter types are opened by JJ.";
    if (body.status != null && body.status !== "active") return "A new matter is opened as active.";
    for (const k of keys) {
      if (!STAFF_MATTER_FIELDS.has(k) && !["case_type", "status", "court"].includes(k)) delete body[k];
    }
    body.court = body.court === "TTAB" ? "TTAB" : "USPTO";
  }
  if (rule.edits) {
    const extra = keys.filter(k => !STAFF_MATTER_FIELDS.has(k));
    if (extra.includes("status") || extra.includes("case_type")) {
      return "Only JJ can archive, reopen or re-type a matter. Archiving stops its reminders and its daily USPTO check.";
    }
    if (extra.length) return `Staff cannot change ${extra.slice(0, 5).map(k => String(k).slice(0, 40)).join(", ")} on a matter.`;
  }
  if (rule.creates || rule.edits) {
    for (const k of keys) {
      if (STAFF_MATTER_FIELDS.has(k) && body[k] !== null && typeof body[k] !== "string") return `The value of ${k} must be text.`;
    }
    if ("client_name" in body && !String(body.client_name || "").trim()) return "A matter needs a client or owner name.";
    for (const k of keys) {
      const max = STAFF_FIELD_MAX[k];
      if (max && typeof body[k] === "string" && body[k].length > max) return `${k} is too long (${max} characters at most).`;
    }
    for (const k of STAFF_PLAIN_FIELDS) {
      if (typeof body[k] === "string" && /[<>"\\]/.test(body[k])) return `${k} cannot contain < > " or a backslash.`;
    }
    if (typeof body.filing_basis === "string" && body.filing_basis.trim() && !normalizeFilingBasis(body.filing_basis)) {
      return "The filing basis is 1(a), 1(b), 44(d), 44(e) or 66(a).";
    }
    if (typeof body.matter_ref === "string" && !body.matter_ref.trim()) body.matter_ref = null;
    if (body.matter_ref != null) {
      const ref = usptoRef(body.matter_ref);
      if (!ref) return "The case number on a trademark matter is its USPTO serial number (8 digits), its registration number (7 digits; write RN before an older, shorter one), or its TTAB proceeding number.";
      body.matter_ref = ref;
    }
    if (body.dropbox_url != null && body.dropbox_url !== "" && !isWebLink(body.dropbox_url)) return "A link must start with http:// or https://.";
  }
  if (body.url != null && body.url !== "" && !isWebLink(body.url)) return "A link must start with http:// or https://.";
  return null;
}

function refuse(req, res, status, message) {
  if (req.path.startsWith("/api/")) return res.status(status).json({ error: message });
  return res.status(status).send(`<!doctype html><meta charset="utf-8"><title>Not available</title><body style="font-family:Montserrat,-apple-system,sans-serif;background:#FAF8F5;color:#1E1B1A;padding:40px;"><h2 style="font-family:'Cormorant Garamond',Georgia,serif;">Not available</h2><p>${message}</p><p><a href="/admin/dashboard" style="color:#A34C00;">Back to the dashboard</a></p></body>`);
}

// What goes into an audit row is bounded: each value clipped, the row capped.
const clip = v => {
  const t = typeof v === "string" ? v : v == null ? v : JSON.stringify(v);
  return typeof t === "string" && t.length > 300 ? t.slice(0, 300) + "…" : t;
};
function pickFields(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[String(k).slice(0, 40)] = clip(obj[k]);
  return out;
}
// A row is kept to about 12,000 characters. When what was sent is larger,
// the values are shortened — every field that was set is still named, with
// the start of its value, and what was there before is kept whole. (A
// request padded with junk must not be able to push the one real change, or
// the value it overwrote, out of the record.)
function staffAudit(req, action, matterId, matterLabel, changes) {
  let c = changes;
  if (JSON.stringify(c).length > 12000) {
    const shorter = o => { const out = {}; for (const k of Object.keys(o)) out[k] = typeof o[k] === "string" && o[k].length > 80 ? o[k].slice(0, 80) + "…" : o[k]; return out; };
    c = { ...changes, note: [changes.note, "long values shortened"].filter(Boolean).join("; ") };
    if (isPlainObject(changes.set)) c.set = shorter(changes.set);
    if (isPlainObject(changes.sent)) c.sent = shorter(changes.sent);
  }
  return require("./audit-log").log({
    req, action, target_type: "matter", target_id: matterId != null ? String(matterId) : null, target_label: matterLabel, changes: c,
  }).catch(() => {});
}

// What the record held before a staff change, so the audit log can show
// what was overwritten or removed. Best effort: a failure here never blocks
// the request.
async function staffBefore(rule, body) {
  try {
    if (rule.edits) {
      const keys = Object.keys(body).filter(k => STAFF_MATTER_FIELDS.has(k));
      if (!keys.length) return null;
      const r = await db.query(`SELECT ${keys.join(", ")} FROM matters WHERE id = $1`, [rule.id]);
      return r.rows[0] ? pickFields(r.rows[0], keys) : null;
    }
    if (rule.deadline) {
      const r = await db.query(
        `SELECT title, citation, to_char(due_date, 'YYYY-MM-DD') AS due_date, party, note, completed
           FROM matter_deadlines WHERE id = $1 AND matter_id = $2`, [rule.subId, rule.id]);
      return r.rows[0] ? pickFields(r.rows[0], DEADLINE_FIELDS.filter(k => k in body)) : null;
    }
    if (rule.removes) {
      const r = rule.what === "notes"
        ? await db.query(`SELECT content FROM matter_notes WHERE id = $1 AND matter_id = $2`, [rule.subId, rule.id])
        : await db.query(`SELECT filename, url FROM matter_files WHERE id = $1 AND matter_id = $2`, [rule.subId, rule.id]);
      return r.rows[0] ? pickFields(r.rows[0], Object.keys(r.rows[0])) : null;
    }
    if (rule.item) {
      const r = await db.query(`SELECT text, completed FROM matter_checklist_items WHERE id = $1`, [rule.id]);
      return r.rows[0] ? pickFields(r.rows[0], ["text", "completed"]) : null;
    }
  } catch (e) { console.error("staffBefore:", e.message); }
  return null;
}

async function matterAccess(req, res, next) {
  // Set on every request, from the signed-in user only. Nothing a browser
  // sends can set these.
  req.mmScope = null;
  req.mmCanWrite = false;
  try {
    const user = req.user;
    if (!user) {
      if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
      return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (user.r === "admin") { req.mmScope = "all"; req.mmCanWrite = true; return next(); }

    const auth = require("./auth");
    const NO = "The Matter Manager is open to you for trademark matters only.";
    if (!(await auth.hasPermissionAsync(user, "federal.read"))) {
      return refuse(req, res, 403, "Your account does not have access to Federal & TM matters. Ask JJ to turn it on under Users → Permissions.");
    }
    const requestLine = `${req.method} ${req.path}`.substring(0, 200);
    // A change that is turned away is recorded too, so trying is not invisible.
    const turnedAway = (status, message, matterId) => {
      if (req.method !== "GET") {
        const sentBody = isPlainObject(req.body) ? req.body : {}, sentKeys = Object.keys(sentBody);
        const entry = { request: requestLine, refused_with: status, reason: message, sent: pickFields(sentBody, sentKeys.slice(0, 40)) };
        if (sentKeys.length > 40) entry.fields_sent = sentKeys.length;
        staffAudit(req, "matter_manager.staff_refused", matterId || null, null, entry);
      }
      return refuse(req, res, status, message);
    };
    const rule = staffRule(req.method, req.path);
    if (!rule) return turnedAway(403, NO);

    const canWrite = await auth.hasPermissionAsync(user, "federal.write");
    if (rule.write && !canWrite) return turnedAway(403, "Your account can view trademark matters but not change them.");

    // The matter the address names must be a Trademark matter.
    let matterId = rule.matter ? rule.id : null, matterLabel = null;
    if (rule.matter || rule.item) {
      const r = rule.matter
        ? await db.query(`SELECT id, case_type, client_name, mark FROM matters WHERE id = $1`, [rule.id])
        : await db.query(
            `SELECT m.id, m.case_type, m.client_name, m.mark FROM matter_checklist_items i
               JOIN matter_checklists c ON c.id = i.checklist_id
               JOIN matters m ON m.id = c.matter_id
              WHERE i.id = $1`, [rule.id]);
      // Same answer whether it does not exist or is another kind of matter.
      // An attempt to CHANGE one is recorded (the reply says no more for it).
      if (!r.rows.length || r.rows[0].case_type !== TM_TYPE) {
        if (req.method !== "GET") {
          staffAudit(req, "matter_manager.staff_refused", rule.matter ? rule.id : null, null,
            { request: requestLine, refused_with: 404, reason: "Not a trademark matter, or no such matter." });
        }
        return res.status(404).json({ error: "Not found" });
      }
      matterId = r.rows[0].id;
      matterLabel = r.rows[0].mark || r.rows[0].client_name || null;
    }
    if (rule.write) {
      if (req.body != null && !isPlainObject(req.body)) return turnedAway(400, "Send the change as a JSON object.", matterId);
      const problem = staffBodyProblem(rule, req.body || {});
      if (problem) return turnedAway(403, problem, matterId);
    }

    req.mmScope = "trademark";
    req.mmCanWrite = canWrite;

    // Who changed what, with what it was before. Written when the reply is
    // sent OR the connection closes first, so a dropped connection cannot
    // leave a change unrecorded. (JJ's own changes are not logged here, as before.)
    if (req.method !== "GET") {
      const body = isPlainObject(req.body) ? req.body : {};
      const before = await staffBefore(rule, body);
      // Every field sent is recorded (there are at most 40: more is refused above).
      const changes = { request: requestLine, set: pickFields(body, Object.keys(body)) };
      if (before) changes.before = before;
      // A new matter has no id until the handler replies with it.
      if (rule.creates) {
        const send = res.json.bind(res);
        res.json = (payload) => {
          try { if (payload && payload.matter && payload.matter.id) { matterId = payload.matter.id; matterLabel = payload.matter.mark || payload.matter.client_name || null; } } catch (_) {}
          return send(payload);
        };
      }
      let written = false;
      const write = (how) => {
        if (written) return;
        written = true;
        if (how === "sent" && (res.statusCode < 200 || res.statusCode >= 300)) changes.refused_with = res.statusCode;
        if (how === "closed") changes.note = "the connection closed before the reply was sent; the change may have been made";
        staffAudit(req, "matter_manager.staff_change", matterId, matterLabel, changes);
      };
      res.on("finish", () => write("sent"));
      res.on("close", () => write("closed"));
    }
    return next();
  } catch (err) {
    console.error("matterAccess error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
}

// Every route below names requireAuth. A request that matterAccess passed
// for a staff member goes on; anything else must be the admin, exactly as
// before. If this router is ever mounted WITHOUT matterAccess in front of
// it, req.mmScope is never set and only the admin gets in.
function requireAuth(req, res, next) {
  if (req.mmScope === "trademark") return next();
  return requireAdminAuth(req, res, next);
}

// ── The Matter Manager, inside Tara ───────────────────────
// It used to be a page of its own, with its own masthead and no way to the
// rest of the firm's pages but a link. It is now a Tara page: the sidebar and
// heading are Tara's, and the docket runs in a frame beneath them. Same
// matters, same deadlines, same API below, same address — the links in the
// daily Telegram summary still land here.
//
//   /admin/matters/            the Tara page (?view=inbox|archive|courts|reference)
//   /admin/matters/app         the docket itself, shown only inside that frame
//   /admin/matters/v2          an unfinished preview that was never shipped → the Tara page
const VIEWS = new Set(["active", "inbox", "archive", "courts", "reference", "trademarks"]);
router.get("/", requireAuth, (req, res) => {
  // Staff have one view here; whatever address they arrive by goes to it.
  if (req.mmScope === "trademark" && req.query.view !== "trademarks") return res.redirect("/admin/matters/?view=trademarks");
  const view = VIEWS.has(String(req.query.view || "")) ? String(req.query.view) : "";
  // The frame fills Tara's content area edge to edge (the docket has its own
  // margins), below the top bar on a phone.
  const body = `
    <style>
      .mm-frame { margin:-28px -32px -40px -32px; }
      .mm-frame iframe { width:100%; height:100vh; border:0; display:block; background:#FAF8F5; }
      @media (max-width: 768px) { .mm-frame { margin:-14px -12px -24px; } .mm-frame iframe { height:calc(100vh - 60px); height:calc(100dvh - 60px); } }
    </style>
    <div class="mm-frame">
      <iframe src="/admin/matters/app${view ? "#" + view : ""}" id="matters-frame" title="Matter Manager"
        allow="clipboard-read; clipboard-write"></iframe>
    </div>`;
  res.set("Cache-Control", "no-store");
  res.send(require("./hearing-notes").renderAdminChrome({
    title: "Matter Manager", body, activeItem: view === "inbox" ? "matters-inbox" : (view === "trademarks" || req.mmScope === "trademark") ? "matters-trademarks" : "matters",
  }));
});
router.get("/app", requireAuth, (req, res) => {
  // Never let a stale copy outlive a deploy inside the frame; and the page
  // may be framed only by this site.
  res.set("Cache-Control", "no-store");
  res.set("Content-Security-Policy", "frame-ancestors 'self'");
  res.sendFile(path.join(__dirname, "matters.html"));
});
router.get("/v2", requireAuth, (req, res) => res.redirect("/admin/matters/"));

// ─────────────────────────────────────────────────────────────
//  ORDER PARSER — Claude-powered deadline extraction
//
//  POST /admin/matters/api/parse
//  Body: { order_text: "...", matter_context: "..." (optional) }
//  Returns: { deadlines: [...], raw_response: "..." }
//
//  CRITICAL DESIGN CONSTRAINT: This endpoint PROPOSES deadlines.
//  It NEVER writes to the database. The client must explicitly
//  POST each accepted deadline to /api/matters/:id/deadlines.
//  This forces a human-confirmation click per deadline — the
//  friction is intentional and prevents Claude's extraction
//  errors from silently becoming missed court deadlines.
// ─────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a careful legal assistant extracting court-imposed deadlines from a legal document for a California immigration attorney.

The document below is a court order, minute order, NEF (Notice of Electronic Filing), BIA decision, scheduling order, or similar. Extract EVERY date-certain deadline you can find.

For each deadline you find, return:
- title: short description (e.g., "Opening Brief due", "CAR due", "Response to motion to dismiss due")
- due_date: ISO format YYYY-MM-DD. If the order says "within 30 days" without a starting date, do NOT guess — leave due_date null and explain in source_excerpt.
- party: who must act. "us" = the attorney (petitioner/movant/appellant client side). "them" = opposing party (gov/respondent/appellee). "court" = the court itself (e.g., when the court must rule by a date).
- citation: the rule or statute cited, if any (e.g., "FRAP 31", "8 USC § 1252(b)", "9th Cir. R. 31-2"). null if none.
- source_excerpt: the EXACT verbatim text from the document that supports this deadline (max 200 chars). This is critical — the attorney will verify your extraction against this excerpt.
- confidence: "high" / "medium" / "low".
  - high: explicit date in the document with clear party and trigger
  - medium: requires modest interpretation (e.g., computing 60 days from a stated start date)
  - low: ambiguous trigger, contingent on event not yet occurred, or unclear party

Important rules:
1. Do NOT compute deadlines from ambiguous starting points. If "within 30 days of filing the CAR" and CAR hasn't been filed, leave due_date null.
2. Do NOT fabricate. If you're not sure, say confidence: "low" and explain in source_excerpt.
3. Do include deadlines for the opposing party and the court — the attorney needs full case-wide awareness.
4. Use the calendar-day rule unless the document specifies business days. Federal: FRCP 6 / FRAP 26 generally use calendar days.
5. If the document mentions a date but it's not a deadline (e.g., date of order issuance, date of service), do NOT include it.

Return ONLY valid JSON with this exact shape, no other text:
{
  "deadlines": [
    {
      "title": "...",
      "due_date": "YYYY-MM-DD" or null,
      "party": "us" | "them" | "court",
      "citation": "..." or null,
      "source_excerpt": "...",
      "confidence": "high" | "medium" | "low"
    }
  ]
}

If you find no deadlines, return {"deadlines": []}.

DOCUMENT TO ANALYZE:
---
{ORDER_TEXT}
---`;

function callClaudeForExtraction(orderText) {
  const prompt = EXTRACTION_PROMPT.replace("{ORDER_TEXT}", orderText);
  return callClaudeAPI(prompt);
}

// Generic Claude API call returning the text content.
// Used by both order extraction and NEF intake parsing.
function callClaudeAPI(prompt, maxTokens = 4000) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error("ANTHROPIC_API_KEY not configured"));

    const payload = JSON.stringify({
      model: require("./zara-core").TIERS.balanced.anthropic,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message || "Claude API error"));
          const text = data.content?.[0]?.text || "";
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse Claude response: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

router.post("/api/parse", requireAuth, async (req, res) => {
  try {
    const { order_text } = req.body || {};

    if (!order_text || typeof order_text !== "string") {
      return res.status(400).json({ error: "order_text required" });
    }
    if (order_text.length < 30) {
      return res.status(400).json({ error: "Order text too short to analyze" });
    }
    if (order_text.length > 50000) {
      return res.status(400).json({ error: "Order text too long (max 50k chars). Paste relevant section." });
    }

    const responseText = await callClaudeForExtraction(order_text);

    // Claude should return JSON. Try to extract it even if wrapped in markdown.
    let parsed;
    try {
      // Strip markdown fences if present
      let cleaned = responseText.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Parser JSON error. Raw response:", responseText);
      return res.status(500).json({
        error: "Could not parse extraction. The order text may have confused the analyzer.",
        raw: responseText.substring(0, 500)
      });
    }

    if (!parsed.deadlines || !Array.isArray(parsed.deadlines)) {
      return res.status(500).json({ error: "Unexpected response shape from analyzer" });
    }

    // Validate each deadline has required fields and reasonable values
    const validated = parsed.deadlines
      .filter(d => d && typeof d === "object")
      .map(d => ({
        title: String(d.title || "Untitled").substring(0, 300),
        due_date: d.due_date && /^\d{4}-\d{2}-\d{2}$/.test(d.due_date) ? d.due_date : null,
        party: ["us", "them", "court"].includes(d.party) ? d.party : "us",
        citation: d.citation ? String(d.citation).substring(0, 200) : null,
        source_excerpt: d.source_excerpt ? String(d.source_excerpt).substring(0, 400) : "",
        confidence: ["high", "medium", "low"].includes(d.confidence) ? d.confidence : "low"
      }));

    res.json({ deadlines: validated });
  } catch (err) {
    console.error("POST /api/parse error:", err.message);
    res.status(500).json({ error: err.message || "Parser error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  NEF INTAKE PARSER — extract matter fields from email text
//
//  POST /admin/matters/api/parse-intake
//  Body: { nef_text: "..." }
//  Returns: { fields: {...}, raw_response: "..." }
//
//  Same propose-only design as the order parser: this returns
//  a proposed set of matter fields. The UI must show them in
//  an editable form before saving — never auto-creates a matter.
// ─────────────────────────────────────────────────────────────

const INTAKE_PROMPT = `You are extracting case information from a Notice of Electronic Filing (NEF), BIA decision, court order, or similar legal document so a California immigration attorney can open a new matter.

Extract these fields from the document. Be conservative — leave a field as null if not clearly present. Do NOT guess.

- client_name: The case caption. Use the format "Petitioner v. Respondent" if both parties named (e.g., "Lu v. Bondi" or "Zhang v. MULLIN"). If only one party named, use that party's name.
- petitioner_name: The full name of the petitioner/plaintiff/movant (e.g., "Guangfeng Lu", "Jiabin Zhang"). Single individual, not a caption.
- matter_ref: The case number or A-number (e.g., "5:26-cv-02340", "A 216-866-000", "23-1234"). Preserve formatting.
- court: Use SHORT FORM:
  - "9th Cir." for Court of Appeals for the Ninth Circuit
  - "C.D. Cal." for Central District of California
  - "N.D. Cal." for Northern District of California
  - "S.D.N.Y." for Southern District of New York
  - "W.D. Okla." for Western District of Oklahoma
  - "EOIR" for immigration court
  - "BIA" for Board of Immigration Appeals
  - "USCIS" for U.S. Citizenship and Immigration Services
  - Use similar abbreviations for other courts
- case_type: Pick ONE of these short-form values based on docket text:
  - "PFR" for Petition for Review (9th Cir. immigration appeals)
  - "Habeas" for 28 U.S.C. § 2241 habeas corpus
  - "Mandamus" for 28 U.S.C. § 1361 mandamus
  - "N400" for 8 U.S.C. § 1447(b) naturalization delay
  - "APA" for Administrative Procedure Act actions
  - "Removal" for EOIR removal proceedings
  - "USCIS" for affirmative USCIS applications
  - "Other" if none fit
- opened_date: Date the case/filing was opened, in YYYY-MM-DD. Use the "filed on" or "entered" date if present.
- triggering_date: The underlying event that triggered the case (e.g., BIA decision date for a PFR, agency denial date for an APA action, NTA date for removal). Leave null unless explicit.
- custody_location: If the petitioner is detained, the facility name (e.g., "Cimarron Facility, Cushing OK"). Leave null if not mentioned or if petitioner is not detained.
- relief_sought: Brief description (e.g., "Asylum / W/H / CAT", "Release from custody", "Adjudication of N-400"). Leave null if unclear.
- notes: A 1-2 sentence summary of what the document indicates about the case posture (e.g., "PFR filed 5/4/2026 challenging BIA dismissal. Petitioner detained at Cimarron.").

Return ONLY valid JSON with this exact shape, no other text:
{
  "fields": {
    "client_name": "..." or null,
    "petitioner_name": "..." or null,
    "matter_ref": "..." or null,
    "court": "..." or null,
    "case_type": "..." or null,
    "opened_date": "YYYY-MM-DD" or null,
    "triggering_date": "YYYY-MM-DD" or null,
    "custody_location": "..." or null,
    "relief_sought": "..." or null,
    "notes": "..." or null
  },
  "confidence": "high" | "medium" | "low"
}

DOCUMENT TO ANALYZE:
---
{NEF_TEXT}
---`;

router.post("/api/parse-intake", requireAuth, async (req, res) => {
  try {
    const { nef_text } = req.body || {};

    if (!nef_text || typeof nef_text !== "string") {
      return res.status(400).json({ error: "nef_text required" });
    }
    if (nef_text.length < 20) {
      return res.status(400).json({ error: "Text too short to analyze" });
    }
    if (nef_text.length > 50000) {
      return res.status(400).json({ error: "Text too long (max 50k chars). Paste relevant section." });
    }

    const prompt = INTAKE_PROMPT.replace("{NEF_TEXT}", nef_text);
    const responseText = await callClaudeAPI(prompt, 2000);

    let parsed;
    try {
      let cleaned = responseText.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Intake parser JSON error. Raw:", responseText);
      return res.status(500).json({
        error: "Could not parse extraction.",
        raw: responseText.substring(0, 500)
      });
    }

    const f = parsed.fields || {};

    // Validate and sanitize each field
    const validated = {
      client_name:      f.client_name ? String(f.client_name).substring(0, 200) : null,
      petitioner_name:  f.petitioner_name ? String(f.petitioner_name).substring(0, 200) : null,
      matter_ref:       f.matter_ref ? String(f.matter_ref).substring(0, 100) : null,
      court:            f.court ? String(f.court).substring(0, 100) : null,
      case_type:        f.case_type ? String(f.case_type).substring(0, 50) : null,
      opened_date:      f.opened_date && /^\d{4}-\d{2}-\d{2}$/.test(f.opened_date) ? f.opened_date : null,
      triggering_date:  f.triggering_date && /^\d{4}-\d{2}-\d{2}$/.test(f.triggering_date) ? f.triggering_date : null,
      custody_location: f.custody_location ? String(f.custody_location).substring(0, 300) : null,
      relief_sought:    f.relief_sought ? String(f.relief_sought).substring(0, 300) : null,
      notes:            f.notes ? String(f.notes).substring(0, 2000) : null
    };

    const confidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low";

    res.json({ fields: validated, confidence });
  } catch (err) {
    console.error("POST /api/parse-intake error:", err.message);
    res.status(500).json({ error: err.message || "Parser error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  USPTO PARSER — Trademark / Patent / Copyright intake
//
//  POST /admin/matters/api/parse-uspto
//  Body: { uspto_text: "..." }
//
//  USPTO emails are highly structured (fixed-position fields,
//  consistent labels). Higher-confidence than the court order
//  parser. Used to pre-populate the new-matter form.
// ─────────────────────────────────────────────────────────────
const USPTO_PROMPT = `You are extracting structured fields from a USPTO (U.S. Patent and Trademark Office) or U.S. Copyright Office (USCO) email or filing receipt. The output goes into a California attorney's matter management system.

The email/receipt:
"""
{USPTO_TEXT}
"""

Identify what KIND of USPTO/USCO document this is and extract the relevant fields. Return STRICT JSON only — no markdown fences, no preamble.

JSON shape:
{
  "doc_type": "trademark_filing_receipt" | "trademark_office_action" | "trademark_publication_notice" | "trademark_notice_of_allowance" | "trademark_registration_certificate" | "trademark_other" | "patent_filing_receipt" | "patent_office_action" | "patent_notice_of_allowance" | "patent_other" | "copyright_certificate" | "copyright_other" | "unknown",
  "case_type": "Trademark" | "Patent" | "Copyright",
  "fields": {
    "client_name": "...",         // The owner/applicant/registrant. Use the owner_name. For TM filings this is the entity, not the attorney.
    "owner_name": "...",          // Full owner/applicant name (e.g., "Techforce Robotics Inc.")
    "owner_email": "...",         // Owner's primary email if visible
    "serial_number": "...",       // USPTO serial number (TM, 8-digit), patent application number, or USCO registration number
    "matter_ref": "...",          // Same as serial_number — used as the searchable case reference
    "mark": "...",                // Trademark text, patent invention title, or copyright work title
    "mark_format": "...",         // "Standard character" / "Stylized" / "Design" / "Sound" / "Standard" (for non-TM, leave null)
    "filing_basis": "...",        // TM: "1(a)" / "1(b)" / "44(e)" / "66(a)". For non-TM, null.
    "intl_class": "...",          // TM: e.g. "041" or "041, 042". For non-TM, null.
    "opened_date": "YYYY-MM-DD",  // Filing date if visible (the date the application/registration was received/recorded)
    "triggering_date": "YYYY-MM-DD",  // Office Action issue date, Publication date, NOA date — whichever event the email represents. Null for filing receipts.
    "court": "USPTO" | "USCO",    // Always one of these for IP docs.
    "relief_sought": "...",       // For TM: brief description of goods/services. For patent: brief abstract. For copyright: work type.
    "notes": "..."                // 1-2 sentence summary capturing the most important context (e.g. "Trademark application filed for Robotic Connective Network in Class 041 on Section 1(b) intent-to-use basis").
  },
  "confidence": "high" | "medium" | "low"
}

Rules:
- Use null for any field you cannot find with confidence — DO NOT GUESS.
- Dates MUST be YYYY-MM-DD format. If the source says "May 23, 2026", output "2026-05-23".
- For trademarks: "Section 1(b)" → filing_basis "1(b)"; "Section 1(a)" → filing_basis "1(a)".
- mark text should be exactly as it appears (preserve case for stylized; uppercase for standard character).
- owner_name should be the legal name of the applicant/owner, not the attorney.
- For Office Actions, set triggering_date to the OA issue date so the 3-month response deadline can be calculated.
- For Notices of Allowance, set triggering_date to the NOA issue date so the 6-month SOU window can be calculated.
- confidence "high" if all key fields (serial, mark, owner, dates) are clearly stated.

Return ONLY the JSON.`;

// ─────────────────────────────────────────────────────────────
//  EOIR HEARING NOTICE PROMPT (Phase 8 — auto-calendaring)
//
//  EOIR (Executive Office for Immigration Review) sends notices via email
//  with PDF attachments. Both the email body and PDF text are passed in
//  combined form. The prompt below extracts hearing dates and the call-up
//  date for additional documents.
//
//  Real-stakes parser. Missing a master/individual hearing means
//  in absentia removal for the client. Every field must be extracted
//  exactly as written — confidence 'high' ONLY when the date is unambiguous.
// ─────────────────────────────────────────────────────────────
const EOIR_PROMPT = `You are extracting structured fields from a Notice of Hearing from the U.S. Department of Justice's Executive Office for Immigration Review (EOIR) sent to a California immigration attorney.

Document (may include both email body AND extracted PDF attachment text):
"""
{EOIR_TEXT}
"""

Identify hearing information and return STRICT JSON only — no markdown fences, no preamble.

JSON shape:
{
  "doc_type": "eoir_hearing_notice" | "eoir_other",
  "case_type": "Removal",
  "fields": {
    "client_name": "...",         // Respondent name as written (e.g., "ZHANG, YONG"). Preserve "LAST, FIRST" format if that's how it appears. If multiple respondents listed in RE: lines, use the FIRST one (lead respondent).
    "co_respondents": "...",      // Other respondent names + A-numbers listed in the RE: section if any. Null if single respondent. Example: "YE YE, PAULO BO TAO (A216-203-625)".
    "alien_number": "...",        // A-number, normalized to format "A###-###-###" (e.g., "A246-723-217"). If "LEAD FILE" or "RE:" line shows "246-723-217", normalize to "A246-723-217". Use the LEAD FILE number, not co-respondent numbers.
    "matter_ref": "...",          // Same as alien_number — used as the searchable case reference
    "hearing_date": "YYYY-MM-DD", // Date of the hearing. NEVER guess. If unclear, set null.
    "hearing_time": "...",        // Time as written (e.g., "10:30 A.M. AZT", "9:00 AM EST"). Preserve time zone abbreviation.
    "hearing_type": "Master" | "Individual" | "Bond" | "Unknown",
                                  // "Master" if "MASTER" appears; "Individual" if "INDIVIDUAL" or "Merits" appears; "Bond" for bond hearings.
    "is_internet_based": true | false,  // True if "Internet-Based Hearing" or "Webex" appears in the actual notice (NOT in boilerplate). Look at the heading "Notice of [X] Hearing".
    "court_address": "...",       // Full court address as printed (may span multiple lines — concatenate with commas)
    "court_name": "...",          // e.g., "Eloy Immigration Court", "Los Angeles Immigration Court"
    "webex_url": "...",           // URL if internet-based, else null
    "ij_name": "...",             // Immigration Judge name if visible (sometimes in URL like "IJ.ZHANG" → "Judge Zhang"), else null
    "callup_date": "YYYY-MM-DD",  // The "Call up for additional documents" date if present in the header. Null if not present.
    "notice_date": "YYYY-MM-DD",  // When the notice was issued (the "DATE:" header)
    "court": "EOIR",              // Always "EOIR" for these
    "orders_or_instructions": "...",  // Verbatim text of any standing orders, special instructions, or specific filing requirements present in this notice (NOT the generic boilerplate about Failure to Appear, Change of Address, In-Person/Internet-Based Hearings, etc.). Most notices have none — return null. Only populate when the notice contains a specific custom instruction from the IJ for this case.
    "notes": "..."                // 1-2 sentence summary: hearing type, date, court, any unusual flags
  },
  "confidence": "high" | "medium" | "low"
}

CRITICAL Rules:
- Use null for any field you cannot find with confidence — DO NOT GUESS dates.
- All dates MUST be YYYY-MM-DD format. "Jun 10, 2026" → "2026-06-10". "Nov 5, 2029" → "2029-11-05". "5/22/26" → "2026-05-22".
- For partial dates like "6/3/26" assume 20XX (so "6/3/26" → "2026-06-03").
- alien_number MUST start with "A" and use hyphens: "246-723-217" → "A246-723-217".
- hearing_type: "INDIVIDUAL" in the notice text → "Individual"; "MASTER" → "Master"; "BOND" → "Bond". Default "Unknown" if ambiguous.
- Confidence "high" if date, time, type, and court are all clearly stated. "medium" if one is inferred. "low" if any is missing.
- The callup_date is BURIED in the header ("Call up for additional documents: 6/3/26"). If not present in the header section, return null — DO NOT confuse with the "DATE:" line which is just the notice issue date.
- IGNORE all boilerplate sections: "Representation:", "Failure to Appear:", "Change of Address:", "Internet-Based Hearings:", "In-Person Hearings:", "For information about your case", "Certificate of Service". These are generic text on every notice, NOT case-specific orders.
- orders_or_instructions should be populated ONLY for genuinely case-specific instructions (e.g., an IJ requiring exhibits filed in a specific format by a specific date). Default null.
- If the document is NOT an EOIR hearing notice, return doc_type: "eoir_other" and leave hearing_date/hearing_time null.

Return ONLY the JSON.`;

router.post("/api/parse-uspto", requireAuth, async (req, res) => {
  try {
    const { uspto_text } = req.body || {};

    if (!uspto_text || typeof uspto_text !== "string") {
      return res.status(400).json({ error: "uspto_text required" });
    }
    if (uspto_text.length < 20) {
      return res.status(400).json({ error: "Text too short to analyze" });
    }
    if (uspto_text.length > 60000) {
      return res.status(400).json({ error: "Text too long (max 60k chars). Paste relevant section." });
    }

    const prompt = USPTO_PROMPT.replace("{USPTO_TEXT}", uspto_text);
    const responseText = await callClaudeAPI(prompt, 2000);

    let parsed;
    try {
      let cleaned = responseText.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("USPTO parser JSON error. Raw:", responseText);
      return res.status(500).json({
        error: "Could not parse extraction.",
        raw: responseText.substring(0, 500)
      });
    }

    const f = parsed.fields || {};

    // Validate and sanitize each field
    const validated = {
      client_name:     f.client_name ? String(f.client_name).substring(0, 200) : (f.owner_name ? String(f.owner_name).substring(0, 200) : null),
      owner_name:      f.owner_name ? String(f.owner_name).substring(0, 200) : null,
      owner_email:     f.owner_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.owner_email) ? f.owner_email.substring(0, 200) : null,
      serial_number:   f.serial_number ? String(f.serial_number).substring(0, 40) : null,
      matter_ref:      f.matter_ref ? String(f.matter_ref).substring(0, 100) : (f.serial_number ? String(f.serial_number).substring(0, 100) : null),
      mark:            f.mark ? String(f.mark).substring(0, 300) : null,
      mark_format:     f.mark_format ? String(f.mark_format).substring(0, 40) : null,
      filing_basis:    f.filing_basis ? String(f.filing_basis).substring(0, 20) : null,
      intl_class:      f.intl_class ? String(f.intl_class).substring(0, 40) : null,
      court:           f.court ? String(f.court).substring(0, 100) : null,
      case_type:       parsed.case_type && ["Trademark","Patent","Copyright"].includes(parsed.case_type) ? parsed.case_type : null,
      opened_date:     f.opened_date && /^\d{4}-\d{2}-\d{2}$/.test(f.opened_date) ? f.opened_date : null,
      triggering_date: f.triggering_date && /^\d{4}-\d{2}-\d{2}$/.test(f.triggering_date) ? f.triggering_date : null,
      relief_sought:   f.relief_sought ? String(f.relief_sought).substring(0, 300) : null,
      notes:           f.notes ? String(f.notes).substring(0, 2000) : null
    };

    const confidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low";
    const docType = parsed.doc_type || "unknown";

    res.json({ fields: validated, confidence, doc_type: docType });
  } catch (err) {
    console.error("POST /api/parse-uspto error:", err.message);
    res.status(500).json({ error: err.message || "Parser error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  CLIENT STATUS SUMMARY — generate a formal status update
//
//  POST /admin/matters/api/matters/:id/client-summary
//  Body: { include_mandarin?: boolean }
//
//  Generates a formal/businesslike English status update for the
//  client, plus optional Mandarin translation. Draft only — never
//  sends; user copies and forwards via their own channel.
//
//  Profile 2 (Formal/Businesslike) voice:
//   - "Dear Mr./Ms. [LastName]" greeting
//   - Procedural posture + upcoming deadlines as bulleted lists
//   - Third-person legal references
//   - Standard professional sign-off
//   - AI-disclaimer + privilege footer
// ─────────────────────────────────────────────────────────────
const CLIENT_SUMMARY_PROMPT = `You are drafting a formal status-update letter from an attorney (JJ Zhang, CA Bar #326666, TEZ Law Firm) to a client regarding their legal matter.

VOICE: Formal / businesslike. NOT warm/effusive, NOT casual. Think professional law-firm letter.
 - Greeting: USE EXACTLY the salutation provided in REQUIRED_SALUTATION below. Do not modify it or substitute your own. Use it verbatim as the first line of the letter.
 - Procedural posture in factual third-person ("The Board issued...", "A Petition for Review was filed...")
 - Upcoming deadlines as a bulleted list
 - Past events as a bulleted list under "Procedural posture"
 - Sign off: "Sincerely, JJ Zhang, Attorney at Law"
 - No emotional language, no reassurance phrases, no "I know this is difficult"
 - Plain English — avoid jargon the client wouldn't know, but use proper procedural terms
 - Keep total length under 350 words for English version

ADDRESSEE TYPE: {ENTITY_TYPE}
REQUIRED_SALUTATION (English): {SALUTATION_EN}
REQUIRED_SALUTATION (Mandarin): {SALUTATION_ZH}

If ADDRESSEE TYPE is "entity":
 - Do NOT use "Mr." or "Ms." or any gendered title
 - Refer to the addressee as the company/entity throughout, not as a person
 - Avoid phrasing like "you personally" — say "your company" or use the entity name
 - For Mandarin: do NOT use 先生/女士; address the company directly (e.g., 致[公司名]：)

If ADDRESSEE TYPE is "individual":
 - Use the client's name in the salutation as provided (no Mr./Ms. — already determined for you)
 - Do NOT add any honorific or gendered title anywhere in the letter
 - For Mandarin: address the client by name as provided; do NOT add 先生/女士

DO NOT:
 - Make legal predictions ("we will likely win", "your case is strong")
 - Promise outcomes
 - Use first-name basis with the client
 - Speculate about events that haven't happened
 - Reference internal strategy

DO:
 - State facts and dates as recorded in the matter notes / deadlines
 - Identify upcoming critical dates the client should know
 - Use the exact case caption and case number if available
 - Note next anticipated step

Matter data:
"""
{MATTER_DATA}
"""

Output STRICT JSON ONLY (no markdown fences, no preamble):
{
  "subject_line": "Status Update — [brief case identifier]",
  "english": "Full letter body in English. Include greeting, procedural posture (bulleted), upcoming deadlines (bulleted), brief forward-look sentence, and sign-off. Do NOT include the disclaimer footer — that is added separately.",
  "mandarin": "Standard professional Mandarin translation of the English body. Use 简体中文 (simplified Chinese). Same structure as English. Salutation: 致[姓氏]先生/女士.",
  "warnings": ["List any factual gaps that may require attorney review before sending, e.g. 'matter notes are blank — letter may be too generic', 'no upcoming deadlines logged'"]
}`;

router.post("/api/matters/:id/client-summary", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const matterId = parseInt(req.params.id);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid id" });

    // Verify ownership and load matter + deadlines + notes
    const mRes = await db.query(
      `SELECT * FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mRes.rows.length) return res.status(404).json({ error: "Matter not found" });
    const m = mRes.rows[0];

    const dRes = await db.query(
      `SELECT title, citation, to_char(due_date, 'YYYY-MM-DD') AS due_date, party, note, completed
         FROM matter_deadlines
        WHERE matter_id = $1
        ORDER BY matter_deadlines.due_date ASC NULLS LAST`,
      [matterId]
    );
    const deadlines = dRes.rows;

    // Build the data block fed to Claude
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = deadlines.filter(d => d.due_date && String(d.due_date).slice(0, 10) >= today && !d.completed);
    const past = deadlines.filter(d => d.due_date && String(d.due_date).slice(0, 10) < today);

    const matterData = [
      `Client: ${m.client_name || "—"}`,
      m.petitioner_name && m.petitioner_name !== m.client_name ? `Petitioner: ${m.petitioner_name}` : null,
      `Matter type: ${m.case_type || "—"}`,
      `Court: ${m.court || "—"}`,
      m.matter_ref ? `Case number: ${m.matter_ref}` : null,
      m.opened_date ? `Matter opened: ${String(m.opened_date).slice(0,10)}` : null,
      m.triggering_date ? `Triggering event date: ${String(m.triggering_date).slice(0,10)}` : null,
      m.custody_location ? `Client custody: ${m.custody_location}` : null,
      m.relief_sought ? `Relief sought: ${m.relief_sought}` : null,
      m.mark ? `Mark / Title: ${m.mark}` : null,
      m.serial_number ? `Serial/App/Reg: ${m.serial_number}` : null,
      m.filing_basis ? `Filing basis: ${m.filing_basis}` : null,
      m.owner_name ? `Owner: ${m.owner_name}` : null,
      "",
      "Past events (recently passed deadlines):",
      past.length === 0
        ? "  (none recorded)"
        : past.slice(-8).map(d => `  - ${String(d.due_date).slice(0,10)}: ${d.title}${d.completed ? " [completed]" : ""}`).join("\n"),
      "",
      "Upcoming deadlines:",
      upcoming.length === 0
        ? "  (none currently scheduled)"
        : upcoming.slice(0, 10).map(d => `  - ${String(d.due_date).slice(0,10)}: ${d.title} (party: ${d.party || "us"})`).join("\n"),
      "",
      "Matter notes (most recent first, may be empty):",
      m.notes ? String(m.notes).substring(0, 2000) : "(no notes recorded)"
    ].filter(Boolean).join("\n");

    // ── Detect entity vs. individual to drive the salutation ──
    // Strip the " v. X" caption for litigation matters; that's the adverse party.
    let addresseeName = (m.client_name || "").split(/\s+v\.\s+/)[0].trim();
    // For IP matters, owner_name is more accurate than the (often-mark-name) client_name
    if (m.owner_name) addresseeName = m.owner_name;

    const ENTITY_SUFFIX = /\b(inc\.?|incorporated|llc|l\.l\.c\.?|ltd\.?|limited|corp\.?|corporation|company|co\.?|gmbh|s\.a\.?|s\.l\.?|lp|l\.p\.?|llp|l\.l\.p\.?|plc|trust|foundation|association|partners|partnership|group|holdings|enterprises|industries|technologies)\b/i;
    const isEntity = ENTITY_SUFFIX.test(addresseeName);

    let salutationEn, salutationZh;
    if (isEntity) {
      salutationEn = `Dear ${addresseeName}:`;
      salutationZh = `致${addresseeName}：`;
    } else {
      // For individuals: use the full client name (no Mr./Ms. — JJ preference)
      // For "Last, First" format, render as "First Last" for natural greeting
      let display = addresseeName;
      if (addresseeName.includes(",")) {
        const [last, ...rest] = addresseeName.split(",").map(s => s.trim());
        if (rest.length && rest[0]) display = `${rest.join(", ")} ${last}`;
      }
      salutationEn = `Dear ${display}:`;
      salutationZh = `致${display}：`;
    }

    const prompt = CLIENT_SUMMARY_PROMPT
      .replace("{MATTER_DATA}", matterData)
      .replace("{ENTITY_TYPE}", isEntity ? "entity" : "individual")
      .replace("{SALUTATION_EN}", salutationEn)
      .replace("{SALUTATION_ZH}", salutationZh);

    const responseText = await callClaudeAPI(prompt, 3000);

    let parsed;
    try {
      let cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Client summary JSON error. Raw:", responseText.substring(0, 500));
      return res.status(500).json({
        error: "Could not parse summary output.",
        raw: responseText.substring(0, 500)
      });
    }

    // Append the disclaimer footer (server-side so attorney can't accidentally remove it)
    const DISCLAIMER_EN = "\n\n---\n*This summary may contain inaccuracies — please contact our office at (909) 374-6995 if anything is unclear or if you have questions. Confidential — Attorney-Client Privileged Communication.*";
    const DISCLAIMER_ZH = "\n\n---\n*本摘要可能存在不准确之处——如有任何疑问或不明之处，请致电我们办公室 (909) 374-6995。机密文件——律师与委托人特权通讯。*";

    const SIGNATURE_EN = "\n\nSincerely,\nJJ Zhang\nAttorney at Law · CA Bar #326666\nTEZ Law Firm\n4141 S. Nogales St., C102, West Covina, CA 91792\n(909) 374-6995 · jj@tezlawfirm.com";

    // English: ensure signature is present; if Claude already included one, don't duplicate
    let englishOut = parsed.english || "";
    if (!/JJ Zhang/i.test(englishOut.split("\n").slice(-6).join("\n"))) {
      englishOut += SIGNATURE_EN;
    }
    englishOut += DISCLAIMER_EN;

    let mandarinOut = parsed.mandarin || "";
    if (mandarinOut) {
      // For Mandarin, append same signature block (English signature is fine — name and contact info don't translate)
      if (!/JJ Zhang/i.test(mandarinOut.split("\n").slice(-6).join("\n"))) {
        mandarinOut += SIGNATURE_EN;
      }
      mandarinOut += DISCLAIMER_ZH;
    }

    res.json({
      subject_line: parsed.subject_line || `Status Update — ${m.client_name || "your matter"}`,
      english: englishOut,
      mandarin: mandarinOut,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
    });
  } catch (err) {
    console.error("POST /api/matters/:id/client-summary error:", err.message);
    res.status(500).json({ error: err.message || "Generator error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  INGEST DRY-RUN — Phase 0 validation for auto-NEF pipeline
//
//  POST /admin/matters/api/ingest-dry-run
//  Body: { email_text: "..." }
//  Returns: {
//    case_numbers_found: [...],
//    matter_match: { id, client_name, matter_ref } | null,
//    proposed_deadlines: [...],
//    proposed_fields: {...},
//    raw_match_attempts: [...]
//  }
//
//  PURE READ — never writes to the database. The point is to
//  validate (a) we can extract case numbers from real CM/ECF
//  emails and (b) we can match them to existing matters in
//  the user's account.
// ─────────────────────────────────────────────────────────────

// Normalize a case number for fuzzy matching:
// "5:26-cv-02340" -> "526cv02340"
// "23-1234"       -> "231234"
// "A 216-866-000" -> "a216866000"
// A court email (an NEF, an order, an immigration-court notice) is never
// about a USPTO or Copyright Office matter. Those matters are skipped when
// an email's case number is matched: an 8-digit serial number such as
// 97261234 "contains" the circuit number 26-1234, and the email would be
// filed under the trademark.
const NOT_COURT_MATTERS = new Set(["Trademark", "Patent", "Copyright"]);

function normalizeCaseRef(s) {
  return String(s || "").toLowerCase().replace(/[\s\-:\.\/]/g, "");
}

// Extract candidate case numbers from CM/ECF email text.
// Returns array of distinct candidates (max 8) in order of appearance.
// Patterns covered:
//  - District: 5:26-cv-02340, 2:23-cr-00100, etc.
//  - Circuit:  23-1234, 26-12345
//  - A-number: A 216-866-000, A216-866-000
//  - BIA:      File: A 216 866 000
function extractCaseNumbers(text) {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const norm = normalizeCaseRef(s);
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(s.trim()); }
  };
  // District court: D:YY-{cv,cr,mj,mc,ml}-NNNNN (with optional spaces)
  const districtRe = /\b\d{1,2}\s*:\s*\d{2}\s*-\s*(?:cv|cr|mj|mc|ml|bk)\s*-\s*\d{4,6}\b/gi;
  // Circuit: YY-NNNN or YY-NNNNN
  const circuitRe = /(?:^|\s|No\.\s*|Case\s*Number:\s*|Case\s*No\.\s*)(\d{2}-\d{4,5})(?=\b)/gi;
  // A-number: A followed by 8-9 digits with optional spaces/dashes
  const aNumRe = /A[\s\-]*\d{3}[\s\-]*\d{3}[\s\-]*\d{3}\b/gi;

  let m;
  while ((m = districtRe.exec(text)) !== null) push(m[0]);
  while ((m = circuitRe.exec(text)) !== null) push(m[1]);
  while ((m = aNumRe.exec(text)) !== null) push(m[0]);

  return out.slice(0, 8);
}

router.post("/api/ingest-dry-run", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const { email_text } = req.body || {};
    if (!email_text || typeof email_text !== "string") {
      return res.status(400).json({ error: "email_text required" });
    }
    if (email_text.length < 20) {
      return res.status(400).json({ error: "Text too short to analyze" });
    }
    if (email_text.length > 100000) {
      return res.status(400).json({ error: "Text too long (max 100k chars)" });
    }

    // 1. Extract candidate case numbers
    const candidates = extractCaseNumbers(email_text);

    // 2. Try to match against existing matters
    let matterMatch = null;
    const matchAttempts = [];

    if (candidates.length > 0) {
      const allMatters = await db.query(
        `SELECT id, client_name, matter_ref, court, case_type
           FROM matters
          WHERE user_id = $1
          ORDER BY id ASC`,
        [userId]
      );

      for (const cand of candidates) {
        const candNorm = normalizeCaseRef(cand);
        for (const m of allMatters.rows) {
          if (NOT_COURT_MATTERS.has(m.case_type)) continue;
          const refNorm = normalizeCaseRef(m.matter_ref || "");
          if (!refNorm) continue;
          // Match if either contains the other (handles "5:26-cv-02340" vs "26-2340")
          if (candNorm === refNorm || candNorm.includes(refNorm) || refNorm.includes(candNorm)) {
            matchAttempts.push({ candidate: cand, matched_matter_id: m.id, matched_ref: m.matter_ref, strategy: "normalized contains" });
            if (!matterMatch) {
              matterMatch = {
                id: m.id,
                client_name: m.client_name,
                matter_ref: m.matter_ref,
                court: m.court,
                case_type: m.case_type
              };
            }
          }
        }
      }
    }

    // 3. Run both parsers in parallel (proposals only — no writes)
    const [intakeResult, orderResult] = await Promise.allSettled([
      (async () => {
        const prompt = INTAKE_PROMPT.replace("{NEF_TEXT}", email_text);
        const text = await callClaudeAPI(prompt, 2000);
        let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        return JSON.parse(cleaned);
      })(),
      (async () => {
        const responseText = await callClaudeForExtraction(email_text);
        let cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        return JSON.parse(cleaned);
      })()
    ]);

    const proposedFields = intakeResult.status === "fulfilled" ? (intakeResult.value.fields || {}) : null;
    const intakeConfidence = intakeResult.status === "fulfilled" ? intakeResult.value.confidence : null;
    const intakeError = intakeResult.status === "rejected" ? intakeResult.reason.message : null;

    const proposedDeadlines = orderResult.status === "fulfilled" && Array.isArray(orderResult.value.deadlines)
      ? orderResult.value.deadlines
      : [];
    const orderError = orderResult.status === "rejected" ? orderResult.reason.message : null;

    res.json({
      // === Phase 0 validation report ===
      summary: {
        case_numbers_found: candidates.length,
        matter_matched: matterMatch ? true : false,
        proposed_deadline_count: proposedDeadlines.length,
        proposed_field_count: proposedFields ? Object.values(proposedFields).filter(v => v != null && v !== "").length : 0,
        intake_confidence: intakeConfidence
      },
      case_numbers_found: candidates,
      matter_match: matterMatch,
      match_attempts: matchAttempts,
      proposed_deadlines: proposedDeadlines,
      proposed_fields: proposedFields,
      errors: {
        intake_parser: intakeError,
        order_parser: orderError
      },
      // What WOULD happen if this were live (not a dry run):
      would_do: matterMatch
        ? `Attach ${proposedDeadlines.length} proposed deadline(s) to matter #${matterMatch.id} (${matterMatch.client_name}) for review`
        : (proposedFields && proposedFields.matter_ref)
          ? `No matter match — would queue ${proposedDeadlines.length} deadline(s) + matter draft for "${proposedFields.client_name || 'unknown'}" pending your confirmation`
          : `No matter match and no extractable case number — would queue email body in inbox for manual review`
    });
  } catch (err) {
    console.error("POST /api/ingest-dry-run error:", err.message);
    res.status(500).json({ error: err.message || "Dry-run error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  INGEST — Phase 2: actually save proposals to the inbox
//
//  POST /admin/matters/api/ingest
//  Body: { email_text: "...", source?: "manual_paste"|"email_inbound"|"api", source_ref?: "..." }
//  Returns: { proposals: [...], matter_match, summary }
//
//  Does the same matching + parsing as dry-run, but writes any
//  resulting proposals to the matter_proposals table for review.
//
//  Still PROPOSE-ONLY for deadlines: nothing is added to
//  matter_deadlines. The proposal sits in 'pending' state until
//  PATCH /api/proposals/:id with action='accept' is called.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
//  ingestEmailText() — SHARED PARSING + PROPOSAL CREATION
//
//  Called by both:
//    - POST /api/ingest (manual paste, user-authenticated)
//    - POST /webhook/inbound-email (SendGrid auto-ingest)
//
//  Inputs:
//    userId       (int)    — owner of any proposals created
//    emailText    (string) — full email body text
//    opts (obj):
//      source     ('manual_paste' | 'email_inbound' | 'api')
//      source_ref (string)  — origin label (subject, "from: name", etc.)
//      message_id (string)  — original Message-ID header (for dedup; null OK)
//
//  Returns: { ok, summary, matter_match, proposals, error?, duplicate? }
//    - duplicate=true if message_id already exists in proposals table
// ─────────────────────────────────────────────────────────────
async function ingestEmailText(userId, emailText, opts = {}) {
  if (!emailText || typeof emailText !== "string") {
    return { ok: false, error: "email_text required", proposals: [] };
  }
  if (emailText.length < 20) {
    return { ok: false, error: "Text too short to analyze", proposals: [] };
  }
  if (emailText.length > 100000) {
    return { ok: false, error: "Text too long (max 100k chars)", proposals: [] };
  }

  const sourceVal = ["manual_paste", "email_inbound", "api"].includes(opts.source) ? opts.source : "manual_paste";
  const sourceRefVal = opts.source_ref ? String(opts.source_ref).substring(0, 200) : null;
  const messageId = opts.message_id ? String(opts.message_id).substring(0, 500) : null;

  // Idempotency: if we've already seen this Message-ID, skip silently.
  // (Same email forwarded twice should not create duplicate proposals.)
  if (messageId) {
    const dup = await db.query(
      `SELECT id FROM matter_proposals WHERE message_id = $1 LIMIT 1`,
      [messageId]
    );
    if (dup.rows.length > 0) {
      return { ok: true, duplicate: true, existing_proposal_id: dup.rows[0].id, proposals: [] };
    }
  }

  // 1. Extract case numbers and find matter match
  const candidates = extractCaseNumbers(emailText);
  let matterMatch = null;

  if (candidates.length > 0) {
    const allMatters = await db.query(
      `SELECT id, client_name, matter_ref, court, case_type
         FROM matters WHERE user_id = $1 ORDER BY id ASC`,
      [userId]
    );
    for (const cand of candidates) {
      const candNorm = normalizeCaseRef(cand);
      for (const m of allMatters.rows) {
        if (NOT_COURT_MATTERS.has(m.case_type)) continue;
        const refNorm = normalizeCaseRef(m.matter_ref || "");
        if (!refNorm) continue;
        if (candNorm === refNorm || candNorm.includes(refNorm) || refNorm.includes(candNorm)) {
          if (!matterMatch) {
            matterMatch = { id: m.id, client_name: m.client_name, matter_ref: m.matter_ref };
          }
        }
      }
    }
  }

  // EOIR DETECTION ─ Is this an immigration court hearing notice?
  // Look for distinctive EOIR markers in the text. Reliable signals:
  //   - "EXECUTIVE OFFICE FOR IMMIGRATION REVIEW"
  //   - "Notice of ... Hearing" (Internet-Based, In-Person, Telephonic)
  //   - "LEAD FILE:" (only EOIR uses this term)
  // We require at least 2 markers to reduce false positives.
  const eoirMarkers = [
    /executive office for immigration review/i,
    /eoir/i,
    /notice of\s+(internet-based|in-person|telephonic|master|individual|bond)?\s*hearing/i,
    /lead file\s*:/i,
    /immigration court/i,
    /immigration judge/i
  ];
  const matchedMarkers = eoirMarkers.filter(rx => rx.test(emailText)).length;
  const isEoir = matchedMarkers >= 2;

  // 2. Run parsers in parallel.
  //   - Always run INTAKE (for matter attribution + new-matter proposals)
  //   - Run ORDER (generic deadline extraction) ONLY if NOT EOIR.
  //     The generic order parser hallucinates deadlines from EOIR boilerplate
  //     (e.g., "fifteen days before hearing", "within five days of receipt") —
  //     things that are not actual deadlines, just procedural prose. The EOIR
  //     parser knows the document structure and produces only real hearings.
  //   - Run EOIR if EOIR markers detected.
  const parserPromises = [
    (async () => {
      const prompt = INTAKE_PROMPT.replace("{NEF_TEXT}", emailText);
      const text = await callClaudeAPI(prompt, 2000);
      let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      return JSON.parse(cleaned);
    })()
  ];
  if (!isEoir) {
    parserPromises.push((async () => {
      const responseText = await callClaudeForExtraction(emailText);
      let cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      return JSON.parse(cleaned);
    })());
  } else {
    // Placeholder so result indices remain consistent
    parserPromises.push(Promise.resolve({ deadlines: [] }));
  }
  if (isEoir) {
    parserPromises.push((async () => {
      const prompt = EOIR_PROMPT.replace("{EOIR_TEXT}", emailText);
      const text = await callClaudeAPI(prompt, 2000);
      let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      return JSON.parse(cleaned);
    })());
  }
  const results = await Promise.allSettled(parserPromises);
  const intakeResult = results[0];
  const orderResult  = results[1];
  const eoirResult   = isEoir ? results[2] : null;

  const intakeFields = intakeResult.status === "fulfilled" ? (intakeResult.value.fields || {}) : null;
  const intakeConfidence = intakeResult.status === "fulfilled" ? intakeResult.value.confidence : null;
  const deadlines = orderResult.status === "fulfilled" && Array.isArray(orderResult.value.deadlines)
    ? orderResult.value.deadlines : [];

  // EOIR-specific extraction. If we detected EOIR markers AND the parser succeeded,
  // generate hearing+callup deadline templates that get inserted just like the
  // order-parser deadlines. The "matterMatch" check below uses the A-number from
  // the EOIR fields to attempt to attribute to an existing matter.
  let eoirFields = null;
  if (eoirResult && eoirResult.status === "fulfilled") {
    eoirFields = eoirResult.value.fields || null;
    const eoirConf = eoirResult.value.confidence || "low";

    // If EOIR parser found an A-number and we haven't already matched a matter,
    // try matching against the A-number directly.
    if (!matterMatch && eoirFields && eoirFields.alien_number) {
      const aNorm = normalizeCaseRef(eoirFields.alien_number);
      const allMatters2 = await db.query(
        `SELECT id, client_name, matter_ref, case_type FROM matters WHERE user_id = $1`,
        [userId]
      );
      for (const m of allMatters2.rows) {
        if (NOT_COURT_MATTERS.has(m.case_type)) continue;
        const refNorm = normalizeCaseRef(m.matter_ref || "");
        if (refNorm && (refNorm === aNorm || refNorm.includes(aNorm) || aNorm.includes(refNorm))) {
          matterMatch = { id: m.id, client_name: m.client_name, matter_ref: m.matter_ref };
          break;
        }
      }
    }

    // Build hearing-specific deadlines and merge into the deadlines array.
    // These flow through the standard deadline-proposal insert path below.
    if (eoirFields && eoirFields.hearing_date && /^\d{4}-\d{2}-\d{2}$/.test(eoirFields.hearing_date)) {
      const type = eoirFields.hearing_type || "Unknown";
      const courtName = eoirFields.court_name || "Immigration Court";
      const title = type === "Master"     ? `Master Calendar Hearing — ${courtName}`
                  : type === "Individual" ? `Individual Hearing (Merits) — ${courtName}`
                  : type === "Bond"       ? `Bond Hearing — ${courtName}`
                  : `Immigration Hearing — ${courtName}`;
      const noteLines = [];
      if (eoirFields.hearing_time)     noteLines.push(`Time: ${eoirFields.hearing_time}`);
      if (eoirFields.is_internet_based) noteLines.push(`Internet-based (Webex)`);
      if (eoirFields.webex_url)        noteLines.push(`URL: ${eoirFields.webex_url}`);
      if (eoirFields.court_address)    noteLines.push(`Address: ${eoirFields.court_address}`);
      if (eoirFields.ij_name)          noteLines.push(`IJ: ${eoirFields.ij_name}`);
      if (eoirFields.alien_number)     noteLines.push(`A#: ${eoirFields.alien_number}`);
      if (eoirFields.co_respondents)   noteLines.push(`Co-respondent(s): ${eoirFields.co_respondents}`);
      if (type === "Master") {
        noteLines.push("Block: 1 hour. Standard procedural hearing.");
      } else if (type === "Individual") {
        noteLines.push("Block: 4 hours. Merits/evidentiary hearing — full prep required.");
      }
      // Append any case-specific orders/instructions if Claude found them in the notice
      // (NOT boilerplate — only genuinely specific instructions from the IJ).
      if (eoirFields.orders_or_instructions &&
          typeof eoirFields.orders_or_instructions === "string" &&
          eoirFields.orders_or_instructions.trim() &&
          eoirFields.orders_or_instructions.trim().toLowerCase() !== "null") {
        noteLines.push(`Orders/Instructions: ${eoirFields.orders_or_instructions.trim()}`);
      }
      deadlines.push({
        title,
        citation: "8 C.F.R. § 1003.18",
        due_date: eoirFields.hearing_date,
        party: "court",
        note: noteLines.join(" · "),
        confidence: eoirConf,
        matter_ref: eoirFields.alien_number || eoirFields.matter_ref || null,
        _eoir_hearing: true
      });

      // Add callup deadline if present (always a "us" party action — submit
      // additional documents by this date if any are coming)
      if (eoirFields.callup_date && /^\d{4}-\d{2}-\d{2}$/.test(eoirFields.callup_date)) {
        deadlines.push({
          title: `Call-up: Additional documents due — ${courtName}`,
          citation: "Immigration Court Practice Manual Ch. 3",
          due_date: eoirFields.callup_date,
          party: "us",
          note: `Pre-hearing call-up for ${type} hearing on ${eoirFields.hearing_date}. Submit any additional briefs/exhibits by this date.`,
          confidence: eoirConf,
          matter_ref: eoirFields.alien_number || eoirFields.matter_ref || null,
          _eoir_callup: true
        });
      }
    }
  }

  // Both parsers failed: tell caller so it can decide whether to file a "raw" proposal
  const parserFailed = intakeResult.status === "rejected" && orderResult.status === "rejected";

  // 3. Write proposals to the inbox table
  const excerpt = emailText.substring(0, 4000);
  const created = [];

  // 3a. Deadline proposals (one per extracted deadline that has a date)
  for (const d of deadlines) {
    if (!d.due_date) continue;
    const ins = await db.query(
      `INSERT INTO matter_proposals
         (user_id, matter_id, kind, source, source_ref,
          proposed_data, raw_excerpt, status, confidence, message_id)
       VALUES ($1, $2, 'deadline', $3, $4, $5, $6, 'pending', $7, $8)
       RETURNING id, kind, matter_id, proposed_data, confidence, created_at`,
      [
        userId,
        matterMatch ? matterMatch.id : null,
        sourceVal,
        sourceRefVal,
        JSON.stringify(d),
        excerpt,
        d.confidence || intakeConfidence || "low",
        messageId
      ]
    );
    created.push(ins.rows[0]);
  }

  // 3b. New-matter proposal if no match and intake parser found case info
  if (!matterMatch && intakeFields && (intakeFields.matter_ref || intakeFields.case_type || intakeFields.client_name)) {
    const ins = await db.query(
      `INSERT INTO matter_proposals
         (user_id, kind, source, source_ref, proposed_data, raw_excerpt, status, confidence, message_id)
       VALUES ($1, 'new_matter', $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id, kind, matter_id, proposed_data, confidence, created_at`,
      [
        userId,
        sourceVal,
        sourceRefVal,
        JSON.stringify(intakeFields),
        excerpt,
        intakeConfidence || "low",
        messageId
      ]
    );
    created.push(ins.rows[0]);
  }

  // 3c. Field-update proposal if matter matched and intake parser found new fields
  if (matterMatch && intakeFields) {
    const meaningfulFields = Object.fromEntries(
      Object.entries(intakeFields).filter(([k, v]) => v != null && v !== "")
    );
    if (Object.keys(meaningfulFields).length > 0) {
      const ins = await db.query(
        `INSERT INTO matter_proposals
           (user_id, matter_id, kind, source, source_ref,
            proposed_data, raw_excerpt, status, confidence, message_id)
         VALUES ($1, $2, 'field_update', $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING id, kind, matter_id, proposed_data, confidence, created_at`,
        [
          userId,
          matterMatch.id,
          sourceVal,
          sourceRefVal,
          JSON.stringify(meaningfulFields),
          excerpt,
          intakeConfidence || "low",
          messageId
        ]
      );
      created.push(ins.rows[0]);
    }
  }

  return {
    ok: true,
    parser_failed: parserFailed,
    summary: {
      case_numbers_found: candidates,
      matter_matched: matterMatch ? matterMatch.id : null,
      proposals_created: created.length,
      deadline_proposals: created.filter(c => c.kind === "deadline").length,
      new_matter_proposals: created.filter(c => c.kind === "new_matter").length,
      field_update_proposals: created.filter(c => c.kind === "field_update").length
    },
    matter_match: matterMatch,
    proposals: created
  };
}

router.post("/api/ingest", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const { email_text, source, source_ref } = req.body || {};
    const result = await ingestEmailText(userId, email_text, {
      source: source || "manual_paste",
      source_ref
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    if (result.duplicate) {
      return res.json({
        summary: { case_numbers_found: [], matter_matched: null, proposals_created: 0 },
        matter_match: null,
        proposals: [],
        duplicate: true,
        existing_proposal_id: result.existing_proposal_id
      });
    }
    res.json({
      summary: result.summary,
      matter_match: result.matter_match,
      proposals: result.proposals
    });
  } catch (err) {
    console.error("POST /api/ingest error:", err.message);
    res.status(500).json({ error: err.message || "Ingest error" });
  }
});


// ─────────────────────────────────────────────────────────────
//  GET /api/proposals — list pending proposals (the inbox)
//  Query: ?status=pending|accepted|dismissed|all  (default: pending)
//         ?matter_id=N  (optional filter)
// ─────────────────────────────────────────────────────────────
router.get("/api/proposals", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const statusFilter = req.query.status || "pending";
    if (!["pending", "accepted", "dismissed", "all"].includes(statusFilter)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }
    const matterFilter = req.query.matter_id ? parseInt(req.query.matter_id) : null;
    if (req.query.matter_id && isNaN(matterFilter)) {
      return res.status(400).json({ error: "Invalid matter_id" });
    }

    const conditions = ["p.user_id = $1"];
    const params = [userId];
    let i = 2;
    if (statusFilter !== "all") {
      conditions.push(`p.status = $${i++}`);
      params.push(statusFilter);
    }
    if (matterFilter !== null) {
      conditions.push(`p.matter_id = $${i++}`);
      params.push(matterFilter);
    }

    const r = await db.query(
      `SELECT p.id, p.matter_id, p.kind, p.source, p.source_ref,
              p.proposed_data, p.raw_excerpt, p.status, p.confidence,
              p.created_at, p.resolved_at,
              m.client_name AS matter_client_name,
              m.matter_ref  AS matter_ref
         FROM matter_proposals p
         LEFT JOIN matters m ON m.id = p.matter_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY p.created_at DESC
         LIMIT 200`,
      params
    );

    res.json({ proposals: r.rows });
  } catch (err) {
    console.error("GET /api/proposals error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  PATCH /api/proposals/:id — accept or dismiss a proposal
//  Body: { action: 'accept' | 'dismiss', matter_id?: N (for unmatched proposals) }
//
//  On 'accept':
//    - kind='deadline': creates a row in matter_deadlines
//    - kind='new_matter': creates a row in matters
//    - kind='field_update': applies fields to the matter row
//  Then marks the proposal as 'accepted'.
//
//  On 'dismiss': just marks as 'dismissed'. No data written.
// ─────────────────────────────────────────────────────────────
router.patch("/api/proposals/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const propId = parseInt(req.params.id);
    if (isNaN(propId)) return res.status(400).json({ error: "Invalid id" });

    const { action, matter_id: matterIdOverride } = req.body || {};
    if (!["accept", "dismiss"].includes(action)) {
      return res.status(400).json({ error: "action must be 'accept' or 'dismiss'" });
    }

    // Load the proposal (verify ownership)
    const pr = await db.query(
      `SELECT * FROM matter_proposals WHERE id = $1 AND user_id = $2`,
      [propId, userId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: "Proposal not found" });
    const prop = pr.rows[0];

    if (prop.status !== "pending") {
      return res.status(409).json({ error: `Proposal already ${prop.status}` });
    }

    // DISMISS path — easy
    if (action === "dismiss") {
      await db.query(
        `UPDATE matter_proposals SET status='dismissed', resolved_at=NOW() WHERE id=$1`,
        [propId]
      );
      return res.json({ ok: true, action: "dismissed", id: propId });
    }

    // ACCEPT path — depends on kind
    const data = typeof prop.proposed_data === "string"
      ? JSON.parse(prop.proposed_data)
      : prop.proposed_data;
    const effectiveMatterId = matterIdOverride
      ? parseInt(matterIdOverride)
      : prop.matter_id;

    if (prop.kind === "deadline") {
      if (!effectiveMatterId) {
        return res.status(400).json({ error: "Deadline proposal has no matter_id — pass matter_id in body" });
      }
      // Verify the target matter is ours
      const mc = await db.query(
        `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
        [effectiveMatterId, userId]
      );
      if (!mc.rows.length) return res.status(404).json({ error: "Target matter not found" });

      const ins = await db.query(
        `INSERT INTO matter_deadlines (matter_id, title, citation, due_date, party, note, completed)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         RETURNING id, title, due_date`,
        [
          effectiveMatterId,
          String(data.title || "Untitled").substring(0, 300),
          data.citation ? String(data.citation).substring(0, 200) : null,
          data.due_date,
          ["us", "them", "court"].includes(data.party) ? data.party : "us",
          data.source_excerpt ? String(data.source_excerpt).substring(0, 1000) : null
        ]
      );
      await db.query(
        `UPDATE matter_proposals SET status='accepted', resolved_at=NOW(), matter_id=$2 WHERE id=$1`,
        [propId, effectiveMatterId]
      );
      return res.json({ ok: true, action: "accepted", kind: "deadline", deadline: ins.rows[0] });
    }

    if (prop.kind === "new_matter") {
      // Build matter payload from intake fields
      const finalStatus = "active";
      const ins = await db.query(
        `INSERT INTO matters
           (user_id, client_name, matter_ref, court, case_type, status,
            opened_date, triggering_date, custody_location,
            petitioner_name, relief_sought, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, client_name, matter_ref`,
        [
          userId,
          (data.client_name || data.petitioner_name || "Unknown").substring(0, 200),
          data.matter_ref ? String(data.matter_ref).substring(0, 100) : null,
          data.court ? String(data.court).substring(0, 100) : null,
          data.case_type ? String(data.case_type).substring(0, 50) : null,
          finalStatus,
          data.opened_date && /^\d{4}-\d{2}-\d{2}$/.test(data.opened_date) ? data.opened_date : null,
          data.triggering_date && /^\d{4}-\d{2}-\d{2}$/.test(data.triggering_date) ? data.triggering_date : null,
          data.custody_location ? String(data.custody_location).substring(0, 300) : null,
          data.petitioner_name ? String(data.petitioner_name).substring(0, 200) : null,
          data.relief_sought ? String(data.relief_sought).substring(0, 300) : null,
          data.notes ? String(data.notes).substring(0, 2000) : null
        ]
      );
      const newMatterId = ins.rows[0].id;
      await db.query(
        `UPDATE matter_proposals SET status='accepted', resolved_at=NOW(), matter_id=$2 WHERE id=$1`,
        [propId, newMatterId]
      );
      // Also attach any pending unmatched deadline proposals to this new matter.
      // Match by normalized matter_ref. Normalization:
      //   - Lower-case
      //   - Strip all non-alphanumeric (spaces, hyphens, dots, parens)
      //   - Strip leading "a" prefix (so "216-203-622" matches "A216-203-622")
      // This way the intake parser's "A 216-203-622" matches the EOIR parser's
      // "A216-203-622" matches the raw notice "216-203-622".
      await db.query(
        `UPDATE matter_proposals
            SET matter_id = $1
          WHERE user_id = $2 AND matter_id IS NULL AND kind = 'deadline' AND status = 'pending'
            AND regexp_replace(
                  regexp_replace(LOWER(COALESCE(proposed_data->>'matter_ref', '')), '[^a-z0-9]', '', 'g'),
                  '^a', '', 'g'
                )
              = regexp_replace(
                  regexp_replace(LOWER(COALESCE($3, '')), '[^a-z0-9]', '', 'g'),
                  '^a', '', 'g'
                )
            AND COALESCE(proposed_data->>'matter_ref', '') <> ''`,
        [newMatterId, userId, ins.rows[0].matter_ref || ""]
      );
      return res.json({ ok: true, action: "accepted", kind: "new_matter", matter: ins.rows[0] });
    }

    if (prop.kind === "field_update") {
      if (!effectiveMatterId) {
        return res.status(400).json({ error: "field_update proposal has no matter_id" });
      }
      // Apply each field as an update on the matter
      const allowed = ["matter_ref", "court", "case_type", "petitioner_name",
                       "opened_date", "triggering_date", "custody_location", "relief_sought",
                       "serial_number", "mark", "mark_format", "filing_basis",
                       "intl_class", "owner_name", "owner_email"];
      const sets = [];
      const params = [effectiveMatterId, userId];
      let i = 3;
      for (const k of allowed) {
        if (data[k] != null && data[k] !== "") {
          sets.push(`${k} = $${i++}`);
          params.push(data[k]);
        }
      }
      if (sets.length === 0) {
        await db.query(
          `UPDATE matter_proposals SET status='dismissed', resolved_at=NOW() WHERE id=$1`,
          [propId]
        );
        return res.json({ ok: true, action: "dismissed", reason: "no fields to apply" });
      }
      const upd = await db.query(
        `UPDATE matters SET ${sets.join(", ")}
          WHERE id = $1 AND user_id = $2
          RETURNING id, client_name, matter_ref`,
        params
      );
      if (!upd.rows.length) return res.status(404).json({ error: "Target matter not found" });
      await db.query(
        `UPDATE matter_proposals SET status='accepted', resolved_at=NOW() WHERE id=$1`,
        [propId]
      );
      return res.json({ ok: true, action: "accepted", kind: "field_update", matter: upd.rows[0], applied_fields: Object.keys(data).filter(k => allowed.includes(k)) });
    }

    return res.status(500).json({ error: "Unknown proposal kind: " + prop.kind });
  } catch (err) {
    console.error("PATCH /api/proposals error:", err.message);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/proposals/count — quick badge count for UI
//  Returns: { pending: N, by_matter: { matter_id: count, ... } }
// ─────────────────────────────────────────────────────────────
router.get("/api/proposals/count", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const tot = await db.query(
      `SELECT COUNT(*)::int AS n FROM matter_proposals WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    const byMatter = await db.query(
      `SELECT matter_id, COUNT(*)::int AS n
         FROM matter_proposals
        WHERE user_id = $1 AND status = 'pending'
        GROUP BY matter_id`,
      [userId]
    );

    const byMatterMap = {};
    for (const row of byMatter.rows) {
      byMatterMap[row.matter_id ?? "unmatched"] = row.n;
    }

    res.json({
      pending: tot.rows[0].n,
      by_matter: byMatterMap
    });
  } catch (err) {
    console.error("GET /api/proposals/count error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

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
// GET /admin/matters/api/me — what this person may do here, so the page can
// show only what will work. The page is not what enforces it; matterAccess is.
router.get("/api/me", requireAuth, (req, res) => {
  const staff = req.mmScope === "trademark";
  res.json({ scope: staff ? "trademark" : "all", can_write: staff ? !!req.mmCanWrite : true });
});

router.get("/api/matters", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const status = req.query.status || "active";
    if (!["active", "closed", "archived", "all"].includes(status)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    // Staff see Trademark matters only. (requireAuth lets a non-admin reach
    // this line only with req.mmScope === "trademark".)
    const tmOnly = req.mmScope === "trademark";
    const whereClause = (status === "all"
      ? "WHERE m.user_id = $1"
      : "WHERE m.user_id = $1 AND m.status = $2") + (tmOnly ? ` AND m.case_type = '${TM_TYPE}'` : "");
    const params = status === "all" ? [userId] : [userId, status];

    const r = await db.query(
      `SELECT m.id, m.client_name, m.matter_ref, m.court, m.case_type, m.status,
              m.dropbox_url, m.notes, m.created_at, m.updated_at,
              m.opened_date, m.triggering_date, m.custody_location,
              m.petitioner_name, m.relief_sought,
              m.serial_number, m.mark, m.mark_format, m.filing_basis,
              m.intl_class, m.owner_name, m.owner_email,
              COALESCE(cl.checklist_total, 0)     AS checklist_total,
              COALESCE(cl.checklist_completed, 0) AS checklist_completed
       FROM matters m
       LEFT JOIN (
         SELECT c.matter_id,
                COUNT(i.id)::int                                      AS checklist_total,
                COUNT(i.id) FILTER (WHERE i.completed = TRUE)::int    AS checklist_completed
         FROM matter_checklists c
         LEFT JOIN matter_checklist_items i ON i.checklist_id = c.id
         GROUP BY c.matter_id
       ) cl ON cl.matter_id = m.id
       ${whereClause}
       ORDER BY m.updated_at DESC`,
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

    // Checklists with nested items, aggregated in a single query
    // via json_agg. Items ordered by display_order then id.
    const cr = await db.query(
      `SELECT
         c.id, c.title, c.subtitle, c.display_order,
         c.created_at, c.updated_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id',            i.id,
               'text',          i.text,
               'citation',      i.citation,
               'completed',     i.completed,
               'display_order', i.display_order
             ) ORDER BY i.display_order, i.id
           ) FILTER (WHERE i.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM matter_checklists c
       LEFT JOIN matter_checklist_items i ON i.checklist_id = c.id
       WHERE c.matter_id = $1
       GROUP BY c.id
       ORDER BY c.display_order, c.id`,
      [matterId]
    );

    res.json({
      matter: mr.rows[0],
      deadlines: dr.rows,
      notes: nr.rows,
      files: fr.rows,
      checklists: cr.rows
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
      status, dropbox_url, notes,
      opened_date, triggering_date, custody_location,
      petitioner_name, relief_sought,
      serial_number, mark, mark_format, filing_basis,
      intl_class, owner_name, owner_email
    } = req.body || {};

    if (!client_name || typeof client_name !== "string") {
      return res.status(400).json({ error: "client_name required" });
    }

    const finalStatus = status || "active";
    if (!["active", "closed", "archived"].includes(finalStatus)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // Normalize date inputs: empty string → null. Postgres rejects "".
    // Validate ISO YYYY-MM-DD if provided (allow Postgres to do final check).
    const normDate = (v) => {
      if (v === undefined || v === null || v === "") return null;
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error("Invalid date format (expected YYYY-MM-DD)");
      }
      return v;
    };

    let openedDateVal, triggeringDateVal;
    try {
      openedDateVal = normDate(opened_date);
      triggeringDateVal = normDate(triggering_date);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // A trademark's case number is kept in one form whoever enters it (see
    // usptoRef), and no two trademark matters may carry the same number.
    let refVal = matter_ref || null;
    if (case_type === TM_TYPE && typeof refVal === "string") {
      refVal = usptoRef(refVal) || refVal;
      if (await trademarkRefTaken(userId, refVal, 0)) {
        return res.status(409).json({ error: "A trademark matter with that number already exists" });
      }
    }

    const r = await db.query(
      `INSERT INTO matters
         (user_id, client_name, matter_ref, court, case_type, status, dropbox_url, notes,
          opened_date, triggering_date, custody_location, petitioner_name, relief_sought,
          serial_number, mark, mark_format, filing_basis, intl_class, owner_name, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING *`,
      [userId, client_name, refVal, court || null, case_type || null,
       finalStatus, dropbox_url || null, notes || null,
       openedDateVal, triggeringDateVal,
       custody_location || null, petitioner_name || null, relief_sought || null,
       serial_number ? String(serial_number).substring(0, 40) : null,
       mark ? String(mark).substring(0, 300) : null,
       mark_format ? String(mark_format).substring(0, 40) : null,
       filing_basis ? String(filing_basis).substring(0, 20) : null,
       intl_class ? String(intl_class).substring(0, 40) : null,
       owner_name ? String(owner_name).substring(0, 200) : null,
       owner_email ? String(owner_email).substring(0, 200) : null]
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
                     "status", "dropbox_url", "notes",
                     "opened_date", "triggering_date", "custody_location",
                     "petitioner_name", "relief_sought",
                     "serial_number", "mark", "mark_format", "filing_basis",
                     "intl_class", "owner_name", "owner_email"];
    const dateFields = new Set(["opened_date", "triggering_date"]);
    // The case number: an empty one is "none" (stored empty, it would take
    // the one unique slot and block the next matter cleared the same way),
    // and a trademark's is kept in one form (see usptoRef).
    let refVal;
    if (req.body && typeof req.body.matter_ref === "string") {
      refVal = req.body.matter_ref.trim() ? req.body.matter_ref : null;
      if (refVal) {
        let type = req.body.case_type;
        if (type === undefined) {
          const cur = await db.query(`SELECT case_type FROM matters WHERE id = $1 AND user_id = $2`, [matterId, userId]);
          type = cur.rows[0] && cur.rows[0].case_type;
        }
        if (type === TM_TYPE) {
          refVal = usptoRef(refVal) || refVal;
          if (await trademarkRefTaken(userId, refVal, matterId)) {
            return res.status(409).json({ error: "A trademark matter with that number already exists" });
          }
        }
      }
    }
    const fields = [];
    const values = [matterId, userId];
    let i = 3;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        if (k === "status" && !["active", "closed", "archived"].includes(req.body[k])) {
          return res.status(400).json({ error: "Invalid status" });
        }
        let v = req.body[k];
        if (k === "matter_ref" && refVal !== undefined) v = refVal;
        // Normalize date inputs: empty string → null
        if (dateFields.has(k)) {
          if (v === "" || v === undefined) {
            v = null;
          } else if (v !== null) {
            if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
              return res.status(400).json({ error: `Invalid date format for ${k} (expected YYYY-MM-DD)` });
            }
          }
        }
        fields.push(`${k} = $${i++}`);
        values.push(v);
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

// ─────────────────────────────────────────────────────────────
//  IP LIFECYCLE DEADLINE GENERATOR
//
//  POST /admin/matters/api/matters/:matterId/lifecycle
//  Body: { event: '<event_key>', anchor_date: 'YYYY-MM-DD' }
//
//  Generates a pre-defined set of deadlines anchored to a key event in
//  the IP lifecycle (TM examination, TM NOA, TM registration, Patent OA,
//  Patent NOA, Patent issue, Copyright registration).
//
//  Idempotent: if a deadline with the same title already exists on this
//  matter (case-insensitive), skip it. So clicking the button twice won't
//  duplicate. (Returns counts of added vs. skipped.)
//
//  Informational events use party='them' so they render as quieter cards
//  and don't surface as overdue/urgent on the dashboard.
//
//  WARNING: patent issue-fee is 3-month NON-EXTENDABLE. Missing it
//  abandons the patent. Title clearly marks this.
// ─────────────────────────────────────────────────────────────

// Helper: add N months to a YYYY-MM-DD string, return new YYYY-MM-DD.
// Uses calendar months (Jan 31 + 1 mo = Feb 28/29) consistent with USPTO/FRAP.
function addMonths(yyyymmdd, months) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  // Move month forward
  const targetMonth = base.getUTCMonth() + months;
  const targetDate = new Date(Date.UTC(base.getUTCFullYear(), targetMonth, base.getUTCDate()));
  // If overflow (e.g. Jan 31 + 1 = Mar 3), back up to last day of intended month
  if (targetDate.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) {
    targetDate.setUTCDate(0); // last day of previous month
  }
  return targetDate.toISOString().slice(0, 10);
}

// Helper: add N years
function addYears(yyyymmdd, years) {
  return addMonths(yyyymmdd, years * 12);
}

// Helper: add N calendar days
function addCalendarDays(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// Event definitions. Each returns an array of deadline templates from the anchor date.
// title MUST be unique-per-event so idempotency check works.
// Normalise a stored filing basis: "Section 1(b)", "1(B)" and "1b" all
// become "1(b)". Returns "1(a)" | "1(b)" | "44" | "66(a)" | null.
function normalizeFilingBasis(raw) {
  const b = String(raw || "").toLowerCase().replace(/[^0-9a-z]/g, "");
  return b.includes("66a") ? "66(a)"
       : b.includes("1b")  ? "1(b)"
       : b.includes("44")  ? "44"
       : b.includes("1a")  ? "1(a)"
       : null;
}

function lifecycleDeadlines(eventKey, anchorDate, matter) {
  const filingBasis = normalizeFilingBasis(matter && matter.filing_basis);
  const ET = " USPTO deadlines close at 11:59 p.m. Eastern (8:59 p.m. Pacific) on the due date.";
  const events = {
    // ── TRADEMARK ──────────────────────────────────────────────
    // Timings per USPTO "Trademark processing wait times" (data as of
    // Oct 1, 2026): first examining action averages 4.3 months (target 5.0);
    // registration or abandonment averages 10.4 months. These are estimates
    // for watching only. The real deadlines come from tm_office_action and
    // tm_publication, which are anchored to the dates the USPTO actually issues.
    tm_examination: () => [
      {
        title: "USPTO: First examining action expected (estimate)",
        citation: "TMEP §§ 700-1400",
        due_date: addMonths(anchorDate, 5),
        party: "them",
        note: "First examining action currently averages about 4 to 5 months after filing. If an office action issues, click 'Office Action Received' with its issue date: the response is due 3 months from that date (one 3-month extension available for $125)."
      },
      {
        title: "USPTO: Publication expected if approved (estimate)",
        citation: "15 U.S.C. § 1062 · TMEP § 1502",
        due_date: addMonths(anchorDate, 7),
        party: "them",
        note: "If approved, the mark is published in the Trademark Official Gazette. Click 'Published' with the publication date to calendar the 30-day opposition period."
      },
      // Status checks. 37 C.F.R. § 2.23(d) puts the duty to monitor on the
      // applicant (at least every 6 months); the USPTO advises every 3 to 4.
      ...[3, 6, 9, 12].map(mo => ({
        title: `TM: Check TSDR status — month ${mo} after filing`,
        citation: "37 C.F.R. § 2.23(d)",
        due_date: addMonths(anchorDate, mo),
        party: "us",
        note: "Look the serial number up in TSDR (Status and Documents tabs) and confirm no office action or notice was missed in email. An office action runs from its issue date whether or not the email was seen. Mark complete once checked; delete the remaining checks after registration."
      }))
    ],
    // Anchor = ISSUE DATE of the office action. Titles carry the date so a
    // second office action on the same matter (e.g. a final action) is not
    // skipped by the duplicate-title check.
    tm_office_action: () => (filingBasis === "66(a)")
      ? [
          {
            title: `TM: Office Action (issued ${anchorDate}) — response due (Madrid § 66(a): no extension)`,
            citation: "37 C.F.R. § 2.62(a)(1)(ii)",
            due_date: addMonths(anchorDate, 6),
            party: "us",
            note: "6 months from the issue date for a Madrid § 66(a) application. NO extension is available. If no response is filed the application is ABANDONED. FINAL action: the request for reconsideration and/or notice of appeal to the TTAB is due by this same date." + ET
          }
        ]
      : [
          {
            title: `TM: Office Action (issued ${anchorDate}) — response OR extension request due`,
            citation: "15 U.S.C. § 1062(b) · 37 C.F.R. § 2.62(a)",
            due_date: addMonths(anchorDate, 3),
            party: "us",
            note: "3 months from the issue date (applications under Section 1 or 44). By this date file the response OR a one-time 3-month extension request ($125 per application). If neither is filed the application is ABANDONED; a petition to revive is then due 2 months after the notice of abandonment ($250). FINAL action: the request for reconsideration and/or notice of appeal to the TTAB is due by this same date, and a request for reconsideration does not extend the time to appeal. NOT for an office action on a Section 8 or renewal filing: that response is due 6 months from issue or the end of the filing period, whichever is later, with no extension (37 C.F.R. §§ 2.163(b), 2.184(b)); enter that date by hand." + ET
          },
          {
            title: `TM: Office Action (issued ${anchorDate}) — LAST DAY if extension was filed`,
            citation: "37 C.F.R. § 2.62(a)(2)",
            due_date: addMonths(anchorDate, 6),
            party: "us",
            note: "6 months from the issue date. Applies ONLY if the 3-month extension request was filed and paid on time. No further extension. Mark complete when the response is filed, or if the response was filed in the first 3 months." + ET
          }
        ],
    // Anchor = PUBLICATION DATE in the Trademark Official Gazette.
    tm_publication: () => [
      {
        title: `USPTO: Opposition period closes (published ${anchorDate})`,
        citation: "15 U.S.C. § 1063(a)",
        due_date: addCalendarDays(anchorDate, 30),
        party: "them",
        note: "Anyone may file an opposition, or a request to extend the time to oppose, within 30 days of publication. After this date check TSDR/TTABVUE for an opposition or extension."
      },
      (filingBasis === "1(b)")
        ? {
            title: `TM: Check TSDR — Notice of Allowance expected (published ${anchorDate})`,
            citation: "15 U.S.C. § 1063(b)(2)",
            due_date: addCalendarDays(anchorDate, 70),
            party: "us",
            note: "For a 1(b) application the notice of allowance issues about 8 weeks after publication if no opposition is filed. When it issues, click 'NOA Received' with the NOA issue date to calendar the statement of use deadlines."
          }
        : (filingBasis === "1(a)" || filingBasis === "44" || filingBasis === "66(a)")
        ? {
            title: `TM: Check TSDR — registration expected (published ${anchorDate})`,
            citation: "15 U.S.C. § 1063(b)(1)",
            due_date: addMonths(anchorDate, 3),
            party: "us",
            note: "The registration certificate issues about 3 months after publication if no opposition is filed. When it issues, click 'Registered' with the registration date to calendar the maintenance deadlines."
          }
        : {
            title: `TM: Check TSDR — NOA or registration expected (published ${anchorDate})`,
            citation: "15 U.S.C. § 1063(b)",
            due_date: addCalendarDays(anchorDate, 70),
            party: "us",
            note: "This matter has no recognised filing basis. A 1(b) application gets a notice of allowance about 8 weeks after publication; other applications register in about 3 months. Click 'NOA Received' or 'Registered' when the document issues."
          }
    ],
    // Six SOU/extension deadlines from the NOA issue date. Each period is
    // counted from the end of the one before it, which for an NOA issued on
    // the 29th to 31st can land a day or two EARLIER than counting straight
    // from the NOA date. The earlier date is used on purpose.
    tm_noa: () => {
      const p = [];
      let d = anchorDate;
      for (let i = 0; i < 6; i++) { d = addMonths(d, 6); p.push(d); }
      return [
        {
          title: "TM: Statement of Use OR 1st Extension Request due",
          citation: "15 U.S.C. § 1051(d)(1)",
          due_date: p[0],
          party: "us",
          note: "6 months from the NOA issue date. File the Statement of Use ($150/class) if the mark is in use, OR the 1st 6-month Extension Request ($125/class). Missing this date ABANDONS the application." + ET
        },
        {
          title: "TM: SOU OR 2nd Extension Request due",
          citation: "15 U.S.C. § 1051(d)(2)",
          due_date: p[1],
          party: "us",
          note: "12 months from NOA. Each extension after the 1st requires a showing of good cause." + ET
        },
        {
          title: "TM: SOU OR 3rd Extension Request due",
          citation: "15 U.S.C. § 1051(d)(2)",
          due_date: p[2],
          party: "us",
          note: "18 months from NOA." + ET
        },
        {
          title: "TM: SOU OR 4th Extension Request due",
          citation: "15 U.S.C. § 1051(d)(2)",
          due_date: p[3],
          party: "us",
          note: "24 months from NOA." + ET
        },
        {
          title: "TM: SOU OR 5th Extension Request due",
          citation: "15 U.S.C. § 1051(d)(2)",
          due_date: p[4],
          party: "us",
          note: "30 months from NOA. The 5th extension is the LAST one available." + ET
        },
        {
          title: "TM: SOU due — FINAL (no further extensions)",
          citation: "15 U.S.C. § 1051(d)(2) · 37 C.F.R. § 2.89",
          due_date: p[5],
          party: "us",
          note: "36 months from NOA. ABSOLUTE DEADLINE. No more extensions. If the SOU is not filed by this date, the application is ABANDONED. Confirm the exact date in TSDR." + ET
        }
      ];
    },
    tm_registration: () => [
      {
        title: "TM: Section 8 affidavit of continued use — window opens",
        citation: "15 U.S.C. § 1058(a)",
        due_date: addYears(anchorDate, 5),
        party: "us",
        note: "Filing window: between the 5th and 6th anniversary of registration. $325/class. For a Principal Register mark, a Section 15 declaration of incontestability can be filed with it after 5 consecutive years of use (combined $575/class). Gather a current specimen for each class. Keep this matter ACTIVE: archived matters do not send reminders. Madrid § 66(a) registrations are maintained under Section 71 instead; check the dates by hand."
      },
      {
        title: "TM: Section 8 affidavit — window CLOSES",
        citation: "15 U.S.C. § 1058(a)",
        due_date: addYears(anchorDate, 6),
        party: "us",
        note: "Last day of the regular window (6th anniversary). After this date the filing costs an extra $100/class grace-period fee."
      },
      {
        title: "TM: Section 8 affidavit — GRACE PERIOD ENDS (registration cancelled after this)",
        citation: "15 U.S.C. § 1058(a)(3)",
        due_date: addMonths(addYears(anchorDate, 6), 6),
        party: "us",
        note: "6 months after the 6th anniversary. ABSOLUTE DEADLINE. If the Section 8 declaration is not on file by this date the registration is CANCELLED and cannot be revived."
      },
      {
        title: "TM: Combined § 8 & § 9 renewal — window opens",
        citation: "15 U.S.C. § 1058 + § 1059",
        due_date: addYears(anchorDate, 9),
        party: "us",
        note: "Filing window: between the 9th and 10th anniversary of registration. $650/class combined."
      },
      {
        title: "TM: Combined § 8 & § 9 renewal — window CLOSES",
        citation: "15 U.S.C. § 1058 + § 1059",
        due_date: addYears(anchorDate, 10),
        party: "us",
        note: "Last day to file the regular renewal (10th anniversary). After this date the filing costs an extra $200/class in grace-period fees ($100 each for the § 8 and the § 9)."
      },
      {
        title: "TM: Combined § 8 & § 9 renewal — GRACE PERIOD ENDS (registration expires after this)",
        citation: "15 U.S.C. § 1059(a)",
        due_date: addMonths(addYears(anchorDate, 10), 6),
        party: "us",
        note: "6 months after the 10th anniversary. ABSOLUTE DEADLINE. If the renewal is not on file by this date the registration is CANCELLED/EXPIRED. The daily USPTO check calendars the next renewal (years 19 to 20) when TSDR shows this one accepted; if that check is not running, add it by hand."
      }
    ],

    // ── PATENT ─────────────────────────────────────────────────
    pat_examination: () => [
      {
        title: "Patent: 18-month publication date (informational)",
        citation: "35 U.S.C. § 122(b)",
        due_date: addMonths(anchorDate, 18),
        party: "them",
        note: "Application published 18 months from earliest priority date unless non-publication request filed. Public can begin to assert prior user rights from this date."
      },
      {
        title: "Patent: Expected first Office Action (informational)",
        citation: "MPEP § 707",
        due_date: addMonths(anchorDate, 16),
        party: "them",
        note: "Average time to first OA is ~16 months but varies by art unit. Monitor PAIR for OA arrival."
      }
    ],
    pat_first_oa: () => [
      {
        title: "Patent: OA response due (3-month statutory)",
        citation: "37 C.F.R. § 1.134",
        due_date: addMonths(anchorDate, 3),
        party: "us",
        note: "Statutory 3 months from OA mailing date. Extendable to 6 months total with monthly extension fees ($240-$1,500). Beyond 6 months: ABANDONMENT."
      },
      {
        title: "Patent: OA response — final extendable deadline",
        citation: "37 C.F.R. § 1.136(a)",
        due_date: addMonths(anchorDate, 6),
        party: "us",
        note: "Maximum extension. ABSOLUTE DEADLINE — beyond this the application is abandoned and only revivable in limited circumstances."
      }
    ],
    pat_noa: () => [
      {
        title: "Patent: Issue Fee due — NON-EXTENDABLE",
        citation: "37 C.F.R. § 1.311",
        due_date: addMonths(anchorDate, 3),
        party: "us",
        note: "⚠ 3 months from NOA mailing date. NO EXTENSIONS AVAILABLE. Missing this abandons the application. Issue fee + publication fee due. Consider also filing IDS if any new prior art surfaced."
      }
    ],
    pat_issue: () => [
      {
        title: "Patent: 3.5-year maintenance fee window opens",
        citation: "35 U.S.C. § 41(b) · 37 C.F.R. § 1.20",
        due_date: addMonths(anchorDate, 36),
        party: "us",
        note: "Filing window opens 3 years from issue. Without surcharge: pay between 3-3.5 years. With surcharge: pay between 3.5-4 years (6-mo grace)."
      },
      {
        title: "Patent: 3.5-year maintenance fee window CLOSES (with surcharge)",
        citation: "35 U.S.C. § 41(b)",
        due_date: addMonths(anchorDate, 48),
        party: "us",
        note: "Absolute deadline (4 years from issue). Missing this: patent EXPIRES."
      },
      {
        title: "Patent: 7.5-year maintenance fee window opens",
        citation: "35 U.S.C. § 41(b)",
        due_date: addMonths(anchorDate, 84),
        party: "us",
        note: "Filing window opens 7 years from issue. Pay between 7-7.5 years without surcharge."
      },
      {
        title: "Patent: 7.5-year maintenance fee window CLOSES (with surcharge)",
        citation: "35 U.S.C. § 41(b)",
        due_date: addMonths(anchorDate, 96),
        party: "us",
        note: "Absolute deadline (8 years from issue). Missing this: patent EXPIRES."
      },
      {
        title: "Patent: 11.5-year maintenance fee window opens",
        citation: "35 U.S.C. § 41(b)",
        due_date: addMonths(anchorDate, 132),
        party: "us",
        note: "Filing window opens 11 years from issue. Final maintenance fee. Pay between 11-11.5 years without surcharge."
      },
      {
        title: "Patent: 11.5-year maintenance fee window CLOSES (with surcharge)",
        citation: "35 U.S.C. § 41(b)",
        due_date: addMonths(anchorDate, 144),
        party: "us",
        note: "Absolute deadline (12 years from issue). Missing this: patent EXPIRES. No further maintenance fees after this."
      }
    ],

    // ── COPYRIGHT ──────────────────────────────────────────────
    cr_registration: () => [
      {
        title: "Copyright: Termination of Transfer — window opens",
        citation: "17 U.S.C. § 203(a)(3)",
        due_date: addYears(anchorDate, 35),
        party: "us",
        note: "For post-1977 grants: author or heirs may terminate transfers between 35-40 years from grant. Notice required 2-10 years before effective date. Plan early."
      },
      {
        title: "Copyright: Termination of Transfer — window CLOSES",
        citation: "17 U.S.C. § 203(a)(3)",
        due_date: addYears(anchorDate, 40),
        party: "us",
        note: "Absolute deadline. If not exercised by 40 years from grant, termination right is lost forever."
      }
    ]
  };

  const fn = events[eventKey];
  if (!fn) return null;
  return fn();
}

router.post("/api/matters/:matterId/lifecycle", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    // Verify user owns this matter
    const mr = await db.query(
      `SELECT id, case_type, filing_basis FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Matter not found" });
    const matter = mr.rows[0];

    const { event, anchor_date } = req.body || {};
    if (!event || typeof event !== "string") {
      return res.status(400).json({ error: "event required" });
    }
    if (!anchor_date || !/^\d{4}-\d{2}-\d{2}$/.test(anchor_date)) {
      return res.status(400).json({ error: "anchor_date required (YYYY-MM-DD)" });
    }
    // Reject impossible dates such as 2026-02-31 (JS would silently roll them forward)
    if (addCalendarDays(anchor_date, 0) !== anchor_date) {
      return res.status(400).json({ error: "anchor_date is not a real calendar date" });
    }

    // Validate event for matter type
    const validForType = {
      Trademark: ["tm_examination", "tm_office_action", "tm_publication", "tm_noa", "tm_registration"],
      Patent:    ["pat_examination", "pat_first_oa", "pat_noa", "pat_issue"],
      Copyright: ["cr_registration"]
    };
    const allowed = validForType[matter.case_type] || [];
    if (!allowed.includes(event)) {
      return res.status(400).json({
        error: `Event '${event}' not valid for ${matter.case_type || "unknown"} matters`
      });
    }

    // Extra rule: tm_noa only makes sense for 1(b)
    const normalizedBasis = normalizeFilingBasis(matter.filing_basis);
    if (event === "tm_noa" && normalizedBasis && normalizedBasis !== "1(b)") {
      return res.status(400).json({
        error: "NOA is only relevant for Section 1(b) intent-to-use applications. This matter's filing basis is " + matter.filing_basis
      });
    }

    const templates = lifecycleDeadlines(event, anchor_date, matter);
    if (!templates || templates.length === 0) {
      return res.status(500).json({ error: "No deadlines generated for that event" });
    }

    // Pull existing deadline titles to dedupe (case-insensitive)
    const existing = await db.query(
      `SELECT LOWER(title) AS lt FROM matter_deadlines WHERE matter_id = $1`,
      [matterId]
    );
    const existingTitles = new Set(existing.rows.map(r => r.lt));

    const added = [];
    const skipped = [];
    for (const t of templates) {
      if (existingTitles.has(t.title.toLowerCase())) {
        skipped.push(t.title);
        continue;
      }
      const ins = await db.query(
        `INSERT INTO matter_deadlines (matter_id, title, citation, due_date, party, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, due_date, party`,
        [matterId, t.title, t.citation, t.due_date, t.party, t.note]
      );
      added.push(ins.rows[0]);
    }

    res.json({
      event,
      anchor_date,
      added_count: added.length,
      skipped_count: skipped.length,
      added,
      skipped
    });
  } catch (err) {
    console.error("POST lifecycle error:", err.message);
    res.status(500).json({ error: err.message || "Server error" });
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
//  CHECKLISTS — per-matter task lists with templates
//
//  Endpoints:
//    POST   /api/matters/:matterId/checklists/template/:templateName
//             → seed a hardcoded template (pfr, habeas, mandamus)
//    POST   /api/matters/:matterId/checklists
//             → create empty checklist (ad-hoc)
//    POST   /api/checklists/:checklistId/items
//             → add an item to an existing checklist
//    PATCH  /api/checklist-items/:itemId
//             → toggle completed, edit text, or edit citation
//    DELETE /api/checklist-items/:itemId
//             → remove an item
//    DELETE /api/checklists/:checklistId
//             → remove an entire checklist (cascades to items)
//
//  All routes require auth and verify the matter belongs to the
//  current user (defense against IDOR / horizontal escalation).
// ─────────────────────────────────────────────────────────────

// ── Hardcoded checklist templates ────────────────────────────
// These are reference templates for common 9th Cir. / district
// court immigration matters. Items are inserted with display_order
// matching their array index.
const CHECKLIST_TEMPLATES = {
  pfr: [
    {
      title: "Initial Filing Packet",
      subtitle: "Cir. R. 15-4 · GO 6.4(c) · FRAP 15",
      items: [
        { text: "Form 3 Petition for Review prepared, signed, dated",                   citation: "Cir. R. 15-4" },
        { text: "Form 6 Representation Statement bound with PFR",                        citation: "Cir. R. 15-4" },
        { text: "BIA decision attached as exhibit",                                      citation: "" },
        { text: "Initial Motion to Stay drafted (separate PDF)",                         citation: "FRAP 18 · GO 6.4(c)(1)" },
        { text: "Filing fee $605 paid OR Form 4 (IFP) filed",                            citation: "28 U.S.C. § 1913" },
        { text: "Filed within 30 days of BIA decision",                                  citation: "Stone v. INS" },
        { text: "Certificate of Service on OIL and local DHS/ICE OCC",                   citation: "FRAP 25(d)" },
        { text: "ECF appearance entered, attorney registration current",                 citation: "Cir. R. 46-1" },
        { text: "Notice to ICE OGC for district of confinement (if detained)",           citation: "Best practice" },
        { text: "Docket assigned 9th Cir. case number recorded",                         citation: "" }
      ]
    },
    {
      title: "Opening Brief Workplan",
      subtitle: "FRAP 28 · 32 · Cir. R. 28-2.4(b) · 28-2.7",
      items: [
        { text: "CAR arrives — read cover-to-cover, mark indiscernibles",                 citation: "Cir. R. 17-1" },
        { text: "Frame issues; lock argument order",                                       citation: "" },
        { text: "Argument outline + record cites complete",                                citation: "" },
        { text: "Statement of Case + Statement of Facts drafted",                          citation: "FRAP 28(a)(6)(7)" },
        { text: "Summary of Argument + Argument Sections drafted",                         citation: "FRAP 28(a)(8)(9)" },
        { text: "Full draft assembled — word count under 14,000",                          citation: "FRAP 32(a)(7)" },
        { text: "Internal revision pass — verify all record cites",                        citation: "" },
        { text: "Polish — Table of Authorities · Table of Contents",                       citation: "FRAP 28(a)(2)(3)" },
        { text: "Addendum assembled: IJ + BIA decisions",                                  citation: "Cir. R. 28-2.7" },
        { text: "Certificates: compliance · service · related cases",                      citation: "FRAP 32(g) · Cir. R. 28-2.6" },
        { text: "File via CM/ECF on or before due date",                                   citation: "FRAP 31 · Cir. R. 31-2.1" }
      ]
    }
  ],

  habeas: [
    {
      title: "Habeas § 2241 Filing Packet",
      subtitle: "28 U.S.C. § 2241 · FRCP 81(a)(4)",
      items: [
        { text: "Petition drafted — name correct custodian as respondent",                 citation: "Rumsfeld v. Padilla" },
        { text: "Venue confirmed — district of confinement",                                citation: "28 U.S.C. § 2241(a)" },
        { text: "Statement of facts with detention timeline",                               citation: "" },
        { text: "Legal grounds: constitutional / statutory / treaty",                       citation: "" },
        { text: "Exhaustion addressed or excused",                                          citation: "" },
        { text: "Filing fee $5 paid OR IFP application filed",                              citation: "28 U.S.C. § 1914" },
        { text: "Service: USA · AG · custodian · ICE OGC",                                  citation: "FRCP 4(i)" },
        { text: "REAL ID jurisdictional bar reviewed",                                      citation: "8 U.S.C. § 1252(a)(5)" },
        { text: "OSC issued / answer deadline calendared",                                  citation: "28 U.S.C. § 2243" }
      ]
    }
  ],

  mandamus: [
    {
      title: "Mandamus § 1361 Filing Packet",
      subtitle: "28 U.S.C. § 1361 · FRCP 4(i)",
      items: [
        { text: "Complaint drafted with clear plaintiff/defendants",                         citation: "" },
        { text: "Three elements pleaded: clear right · clear duty · no other remedy",       citation: "Norton v. SUWA" },
        { text: "TRAC factors addressed (unreasonable delay)",                                citation: "TRAC v. FCC" },
        { text: "Venue: where defendants reside OR plaintiff resides",                       citation: "28 U.S.C. § 1391(e)" },
        { text: "Civil cover sheet + summons prepared",                                       citation: "Local Rule" },
        { text: "Filing fee $405 paid OR IFP filed",                                          citation: "28 U.S.C. § 1914" },
        { text: "Service on US Attorney · AG · agency",                                       citation: "FRCP 4(i)" },
        { text: "Summons issued by clerk",                                                    citation: "FRCP 4(b)" },
        { text: "60-day answer deadline calendared",                                          citation: "FRCP 12(a)(2)" },
        { text: "Status of underlying agency action documented",                              citation: "" }
      ]
    }
  ],

  trademark: [
    {
      title: "Trademark Filing — Initial",
      subtitle: "USPTO TMEP · 15 U.S.C. § 1051",
      items: [
        { text: "Conflict / clearance search completed (USPTO Trademark Search + state + common law)", citation: "TMEP §§ 1207-1208" },
        { text: "Trademark/Service Mark application drafted in Trademark Center (base application)", citation: "15 U.S.C. § 1051(a)/(b)" },
        { text: "Goods/services identification matches USPTO ID Manual",                       citation: "TMEP § 1402" },
        { text: "International class(es) confirmed",                                            citation: "Nice Agreement" },
        { text: "Filing basis selected: 1(a) in-use / 1(b) ITU / 44(e) / 66(a)",               citation: "15 U.S.C. § 1051(a)/(b), § 1126(e)" },
        { text: "Specimen acceptable (if 1(a)) — actual use in commerce",                      citation: "TMEP § 904" },
        { text: "Declaration signed by authorized party",                                       citation: "37 C.F.R. § 2.20" },
        { text: "Filing fee paid ($350/class base; +$200 free-form ID, +$100 missing info)",    citation: "37 C.F.R. § 2.6(a)(1)" },
        { text: "Filing receipt + serial number saved to matter",                               citation: "" },
        { text: "Engagement letter signed; conflict checked; client billed",                    citation: "" }
      ]
    },
    {
      title: "Examination & Prosecution",
      subtitle: "TMEP §§ 700-1400 · 37 C.F.R. Part 2",
      items: [
        { text: "Examining attorney assigned (first action averages 4 to 5 months after filing)", citation: "" },
        { text: "Office Action received — calendar 3-month response deadline (one 3-mo extension, $125)", citation: "37 C.F.R. § 2.62(a)" },
        { text: "OA response drafted with arguments & amendments as needed",                    citation: "" },
        { text: "OA response filed before deadline; new examiner review if needed",             citation: "" },
        { text: "Notice of Publication received (after approval)",                              citation: "TMEP § 1502" },
        { text: "Publication in Official Gazette — monitor 30-day opposition window",          citation: "15 U.S.C. § 1063(a)" },
        { text: "Confirm no opposition / extension of time to oppose filed",                    citation: "" }
      ]
    },
    {
      title: "Post-Approval (depends on filing basis)",
      subtitle: "Section 1(b) → SOU · Section 1(a) → Registration",
      items: [
        { text: "[1(b)] Notice of Allowance received — calendar SOU deadline (6 mo)",          citation: "15 U.S.C. § 1051(d)" },
        { text: "[1(b)] Statement of Use filed OR Extension Request (each 6 mo, max 5 ext)",   citation: "15 U.S.C. § 1051(d)(2)" },
        { text: "[1(a)] Registration Certificate issued — save copy",                          citation: "" },
        { text: "Owner notified; registration recorded internally",                             citation: "" }
      ]
    },
    {
      title: "Maintenance & Renewal",
      subtitle: "15 U.S.C. § 1058 · § 1059",
      items: [
        { text: "Section 8 affidavit of continued use filed (between 5th and 6th year)",       citation: "15 U.S.C. § 1058(a)" },
        { text: "Section 15 incontestability filed (optional, between 5th & 6th year)",        citation: "15 U.S.C. § 1065" },
        { text: "Combined § 8 & § 9 renewal filed (between 9th and 10th year)",                 citation: "15 U.S.C. § 1058 · § 1059" },
        { text: "Each subsequent 10-year renewal calendared",                                   citation: "" },
        { text: "Specimens current at each maintenance filing",                                 citation: "TMEP § 904" }
      ]
    }
  ],

  patent: [
    {
      title: "Patent Filing",
      subtitle: "35 U.S.C. · 37 C.F.R. Part 1",
      items: [
        { text: "Invention disclosure documented; prior-art search completed",                  citation: "" },
        { text: "Provisional or Non-provisional decision; foreign filing strategy",             citation: "35 U.S.C. § 111 · § 119(e)" },
        { text: "Specification + claims + drawings drafted",                                    citation: "35 U.S.C. § 112" },
        { text: "Inventor declaration signed (or assignee substitute statement)",               citation: "37 C.F.R. § 1.63" },
        { text: "Application Data Sheet (ADS) prepared",                                        citation: "37 C.F.R. § 1.76" },
        { text: "Filing fee + search fee + examination fee paid",                               citation: "37 C.F.R. § 1.16" },
        { text: "Application filed via Patent Center; filing receipt saved",                    citation: "" },
        { text: "Engagement + assignment recorded (USPTO assignment within 3 mo)",              citation: "35 U.S.C. § 261" }
      ]
    },
    {
      title: "Prosecution",
      subtitle: "MPEP · 37 C.F.R. § 1.111-1.116",
      items: [
        { text: "Application published 18 months from earliest priority (unless opted out)",    citation: "35 U.S.C. § 122(b)" },
        { text: "First Office Action received — calendar 3-month statutory response (6 max)",  citation: "37 C.F.R. § 1.134-1.136" },
        { text: "Information Disclosure Statement (IDS) filed within 3 mo of awareness",        citation: "37 C.F.R. § 1.97-1.98" },
        { text: "OA response: claim amendments + arguments + Examiner interview if helpful",   citation: "" },
        { text: "Final OA → RCE / appeal / abandonment decision; calendar deadlines",          citation: "37 C.F.R. § 1.114; § 41" },
        { text: "Notice of Allowance → calendar 3-month non-extendable issue fee deadline",    citation: "37 C.F.R. § 1.311" }
      ]
    },
    {
      title: "Post-Issuance & Maintenance",
      subtitle: "35 U.S.C. § 41(b) · 37 C.F.R. § 1.20-1.27",
      items: [
        { text: "Patent grant received — save certificate, update docket",                      citation: "" },
        { text: "Foreign filing under Paris Convention (12 mo) or PCT (30 mo)",                 citation: "35 U.S.C. § 119; PCT" },
        { text: "Maintenance fee — 3.5 years (with 6-month surcharge grace)",                   citation: "35 U.S.C. § 41(b)" },
        { text: "Maintenance fee — 7.5 years",                                                   citation: "35 U.S.C. § 41(b)" },
        { text: "Maintenance fee — 11.5 years",                                                  citation: "35 U.S.C. § 41(b)" },
        { text: "Assignments recorded promptly (priority within 3 months)",                      citation: "35 U.S.C. § 261" }
      ]
    }
  ],

  copyright: [
    {
      title: "Copyright Registration",
      subtitle: "17 U.S.C. · Copyright Office Circular 1",
      items: [
        { text: "Work identified — type (literary / visual / sound / etc.)",                    citation: "17 U.S.C. § 102" },
        { text: "Authorship confirmed (sole / joint / work-for-hire)",                           citation: "17 U.S.C. § 201" },
        { text: "Chain of title cleared (any prior transfers documented)",                       citation: "17 U.S.C. § 204" },
        { text: "eCO registration filed (Form TX / VA / PA / SR as applicable)",                citation: "37 C.F.R. § 202" },
        { text: "Deposit copies submitted within 3 months of publication",                       citation: "17 U.S.C. § 408(b)" },
        { text: "Filing fee paid ($45 single author / $65 standard / $125 paper)",              citation: "" },
        { text: "Registration certificate received and filed",                                   citation: "" },
        { text: "Pre-suit registration confirmed if litigation anticipated",                     citation: "17 U.S.C. § 411(a)" }
      ]
    },
    {
      title: "Post-Registration",
      subtitle: "Maintenance & enforcement",
      items: [
        { text: "Notice of copyright displayed on published copies (©, year, owner)",            citation: "17 U.S.C. § 401" },
        { text: "Transfers / assignments recorded with Copyright Office",                        citation: "17 U.S.C. § 205" },
        { text: "Renewal not required for works ≥ 1978 (auto by statute)",                       citation: "17 U.S.C. § 304" },
        { text: "Termination of transfer right calendared (35-40 yrs from grant, post-1977)",   citation: "17 U.S.C. § 203" },
        { text: "DMCA enforcement contacts documented if needed",                                 citation: "17 U.S.C. § 512" }
      ]
    }
  ]
};

// ── Helper: verify matter ownership ──────────────────────────
// Returns the matter row if the current user owns it, else null.
// All checklist routes use this to prevent horizontal escalation.
async function verifyMatterOwnership(matterId, userId) {
  const r = await db.query(
    `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
    [matterId, userId]
  );
  return r.rows.length > 0;
}

// ── Helper: verify checklist ownership (via parent matter) ───
async function verifyChecklistOwnership(checklistId, userId) {
  const r = await db.query(
    `SELECT c.id FROM matter_checklists c
       JOIN matters m ON m.id = c.matter_id
      WHERE c.id = $1 AND m.user_id = $2`,
    [checklistId, userId]
  );
  return r.rows.length > 0;
}

// ── Helper: verify item ownership (via parent checklist → matter) ─
async function verifyItemOwnership(itemId, userId) {
  const r = await db.query(
    `SELECT i.id FROM matter_checklist_items i
       JOIN matter_checklists c ON c.id = i.checklist_id
       JOIN matters m ON m.id = c.matter_id
      WHERE i.id = $1 AND m.user_id = $2`,
    [itemId, userId]
  );
  return r.rows.length > 0;
}

// ─────────────────────────────────────────────────────────────
//  POST /admin/matters/api/matters/:matterId/checklists/template/:templateName
//
//  Seed a hardcoded template (pfr, habeas, mandamus). Each
//  template creates one or more checklists with their items.
//  Use this on matter creation to bootstrap a standard set.
//
//  Does NOT clear existing checklists — call it on a fresh matter
//  or be prepared for duplicates.
// ─────────────────────────────────────────────────────────────
router.post("/api/matters/:matterId/checklists/template/:templateName", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const templateName = String(req.params.templateName || "").toLowerCase();
    const template = CHECKLIST_TEMPLATES[templateName];
    if (!template) {
      return res.status(404).json({
        error: "Template not found",
        available: Object.keys(CHECKLIST_TEMPLATES)
      });
    }

    if (!(await verifyMatterOwnership(matterId, userId))) {
      return res.status(404).json({ error: "Matter not found" });
    }

    // Find highest existing display_order so new templates append
    const ordR = await db.query(
      `SELECT COALESCE(MAX(display_order), -1) AS max_order
         FROM matter_checklists WHERE matter_id = $1`,
      [matterId]
    );
    let nextChecklistOrder = parseInt(ordR.rows[0].max_order) + 1;

    const created = [];
    for (const checklistDef of template) {
      const cr = await db.query(
        `INSERT INTO matter_checklists (matter_id, title, subtitle, display_order)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, subtitle, display_order, created_at, updated_at`,
        [matterId, checklistDef.title, checklistDef.subtitle || null, nextChecklistOrder]
      );
      const checklist = cr.rows[0];
      nextChecklistOrder++;

      const itemRows = [];
      for (let idx = 0; idx < checklistDef.items.length; idx++) {
        const it = checklistDef.items[idx];
        const ir = await db.query(
          `INSERT INTO matter_checklist_items
             (checklist_id, text, citation, completed, display_order)
           VALUES ($1, $2, $3, FALSE, $4)
           RETURNING id, text, citation, completed, display_order`,
          [checklist.id, it.text, it.citation || null, idx]
        );
        itemRows.push(ir.rows[0]);
      }

      created.push({ ...checklist, items: itemRows });
    }

    res.json({ checklists: created, template: templateName });
  } catch (err) {
    console.error("POST checklists/template error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /admin/matters/api/matters/:matterId/checklists
//
//  Create a single empty checklist on a matter.
//  Body: { title (required), subtitle (optional) }
// ─────────────────────────────────────────────────────────────
router.post("/api/matters/:matterId/checklists", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const { title, subtitle } = req.body || {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title required" });
    }

    if (!(await verifyMatterOwnership(matterId, userId))) {
      return res.status(404).json({ error: "Matter not found" });
    }

    const ordR = await db.query(
      `SELECT COALESCE(MAX(display_order), -1) AS max_order
         FROM matter_checklists WHERE matter_id = $1`,
      [matterId]
    );
    const nextOrder = parseInt(ordR.rows[0].max_order) + 1;

    const r = await db.query(
      `INSERT INTO matter_checklists (matter_id, title, subtitle, display_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, subtitle, display_order, created_at, updated_at`,
      [matterId, title, subtitle || null, nextOrder]
    );

    res.json({ checklist: { ...r.rows[0], items: [] } });
  } catch (err) {
    console.error("POST checklists error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE /admin/matters/api/checklists/:checklistId
//
//  Remove an entire checklist. Cascades to items.
// ─────────────────────────────────────────────────────────────
router.delete("/api/checklists/:checklistId", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const checklistId = parseInt(req.params.checklistId);
    if (isNaN(checklistId)) return res.status(400).json({ error: "Invalid checklist id" });

    if (!(await verifyChecklistOwnership(checklistId, userId))) {
      return res.status(404).json({ error: "Checklist not found" });
    }

    await db.query(`DELETE FROM matter_checklists WHERE id = $1`, [checklistId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE checklists error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /admin/matters/api/checklists/:checklistId/items
//
//  Add a single item to a checklist.
//  Body: { text (required), citation (optional) }
// ─────────────────────────────────────────────────────────────
router.post("/api/checklists/:checklistId/items", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const checklistId = parseInt(req.params.checklistId);
    if (isNaN(checklistId)) return res.status(400).json({ error: "Invalid checklist id" });

    const { text, citation } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text required" });
    }

    if (!(await verifyChecklistOwnership(checklistId, userId))) {
      return res.status(404).json({ error: "Checklist not found" });
    }

    const ordR = await db.query(
      `SELECT COALESCE(MAX(display_order), -1) AS max_order
         FROM matter_checklist_items WHERE checklist_id = $1`,
      [checklistId]
    );
    const nextOrder = parseInt(ordR.rows[0].max_order) + 1;

    const r = await db.query(
      `INSERT INTO matter_checklist_items
         (checklist_id, text, citation, completed, display_order)
       VALUES ($1, $2, $3, FALSE, $4)
       RETURNING id, text, citation, completed, display_order, created_at, updated_at`,
      [checklistId, text, citation || null, nextOrder]
    );

    res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("POST checklist items error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  PATCH /admin/matters/api/checklist-items/:itemId
//
//  Toggle completed status, or edit text/citation.
//  Body: any of { completed: bool, text: string, citation: string }
// ─────────────────────────────────────────────────────────────
router.patch("/api/checklist-items/:itemId", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const itemId = parseInt(req.params.itemId);
    if (isNaN(itemId)) return res.status(400).json({ error: "Invalid item id" });

    if (!(await verifyItemOwnership(itemId, userId))) {
      return res.status(404).json({ error: "Item not found" });
    }

    const allowed = ["completed", "text", "citation"];
    const fields = [];
    const values = [itemId];
    let i = 2;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        let v = req.body[k];
        if (k === "completed") {
          if (typeof v !== "boolean") {
            return res.status(400).json({ error: "completed must be boolean" });
          }
        } else if (k === "text") {
          if (typeof v !== "string" || !v.trim()) {
            return res.status(400).json({ error: "text must be non-empty string" });
          }
        }
        // citation: pass through; empty string allowed
        fields.push(`${k} = $${i++}`);
        values.push(v);
      }
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    const r = await db.query(
      `UPDATE matter_checklist_items SET ${fields.join(", ")}
       WHERE id = $1
       RETURNING id, text, citation, completed, display_order, created_at, updated_at`,
      values
    );

    res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("PATCH checklist items error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE /admin/matters/api/checklist-items/:itemId
//
//  Remove a single item.
// ─────────────────────────────────────────────────────────────
router.delete("/api/checklist-items/:itemId", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const itemId = parseInt(req.params.itemId);
    if (isNaN(itemId)) return res.status(400).json({ error: "Invalid item id" });

    if (!(await verifyItemOwnership(itemId, userId))) {
      return res.status(404).json({ error: "Item not found" });
    }

    await db.query(`DELETE FROM matter_checklist_items WHERE id = $1`, [itemId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE checklist items error:", err.message);
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

    // ── Entries typed into the Calendar page ───────────────
    //
    // "should be able to add or edit calender in tara and sync back to
    // the calender" (JJ, 2026-10-09). This feed is the sync-out: an entry
    // added in the app lands in whatever calendar is subscribed to this
    // URL. Without this it stayed inside the app and the office never saw
    // it in the calendar they actually watch.
    //
    // A deleted entry is published as CANCELLED rather than dropped. A
    // subscriber that has already seen the appointment needs to be told
    // it is off; silence leaves it on their calendar for good.
    //
    // Timed entries are written as floating local times -- DTSTART with
    // no Z and no TZID -- because that is what they are: a 9:30
    // appointment is at 9:30 where the office is. Stamping them UTC would
    // move every one of them by seven hours in the subscriber's calendar,
    // which is the bug this codebase has fixed three times already.
    try {
      const FE = require("./firm-events");
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - 30);
      const to = new Date();
      to.setUTCDate(to.getUTCDate() + 365);
      const events = await FE.listBetween(
        from.toISOString().slice(0, 10), to.toISOString().slice(0, 10),
        { includeDeleted: true });

      for (const ev of FE.icsRows(events)) {
        const day = ev.day.replace(/-/g, "");
        lines.push("BEGIN:VEVENT");
        lines.push(`UID:${ev.uid}`);
        lines.push(`DTSTAMP:${now}`);
        if (ev.start) {
          const [sh, sm] = ev.start.split(":");
          lines.push(`DTSTART:${day}T${sh}${sm}00`);
          if (ev.end) {
            const [eh, em] = ev.end.split(":");
            lines.push(`DTEND:${day}T${eh}${em}00`);
          }
        } else {
          lines.push(`DTSTART;VALUE=DATE:${day}`);
          lines.push(`DTEND;VALUE=DATE:${addDays(ev.day, 1)}`);
        }
        lines.push(`SUMMARY:${icsEscape(ev.summary)}`);
        if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
        if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
        lines.push(`STATUS:${ev.cancelled ? "CANCELLED" : "CONFIRMED"}`);
        lines.push("TRANSP:OPAQUE");
        lines.push("END:VEVENT");
      }
    } catch (e) {
      // A missing table or a bad row must not take the whole feed down:
      // the deadlines above are what the office relies on most.
      console.warn("[calendar feed] firm events unavailable:", e.message);
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

// ─────────────────────────────────────────────────────────────
//  TSDR STATUS (Trademark matters) — the daily USPTO status check
//  lives in tsdr-sync.js. These endpoints feed the matter page.
//
//  GET  /api/matters/:matterId/tsdr         stored status for one matter
//  POST /api/matters/:matterId/tsdr/check   run the check for one matter now
//  GET  /api/tsdr/test?sn=XXXXXXXX          read one serial, save nothing
// ─────────────────────────────────────────────────────────────
async function loadOwnedMatter(req, res) {
  const userId = await getCurrentUserId(req);
  const matterId = parseInt(req.params.matterId);
  if (isNaN(matterId)) { res.status(400).json({ error: "Invalid matter id" }); return null; }
  const mr = await db.query(
    `SELECT id, case_type, status, serial_number FROM matters WHERE id = $1 AND user_id = $2`,
    [matterId, userId]
  );
  if (!mr.rows.length) { res.status(404).json({ error: "Matter not found" }); return null; }
  return mr.rows[0];
}

router.get("/api/matters/:matterId/tsdr", requireAuth, async (req, res) => {
  try {
    const matter = await loadOwnedMatter(req, res);
    if (!matter) return;
    const tsdr = require("./tsdr-sync");
    const s = await tsdr.getStatusForMatter(matter.id);
    res.json({ ...s, serial_number: matter.serial_number, matter_status: matter.status });
  } catch (err) {
    console.error("GET tsdr error:", err.message);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

router.post("/api/matters/:matterId/tsdr/check", requireAuth, async (req, res) => {
  try {
    const matter = await loadOwnedMatter(req, res);
    if (!matter) return;
    if (matter.case_type !== "Trademark") return res.status(400).json({ error: "Only Trademark matters are checked against TSDR" });
    if (matter.status !== "active") return res.status(400).json({ error: "This matter is archived. Only active matters are checked." });
    const tsdr = require("./tsdr-sync");
    if (!tsdr.caseId(matter.serial_number)) {
      return res.status(400).json({ error: "Add the 8-digit serial number (or 7-digit registration number) to this matter first" });
    }
    // Any news is sent to Telegram as well as shown on the page, so a manual
    // check never uses up an alert that the morning run would have sent.
    const stats = await tsdr.runAll({ matterId: matter.id });
    if (stats.busy) return res.status(409).json({ error: "A USPTO check is already running. Try again in a minute." });
    if (stats.skippedNoKey) return res.status(400).json({ error: "USPTO_API_KEY is not set on the server, so the check cannot run" });
    if (stats.failures.length) return res.status(502).json({ error: stats.failures[0].message });
    const r = stats.results[0];
    if (!r) return res.status(500).json({ error: "The check did not run for this matter" });
    res.json({
      ok: true, baseline: r.baseline, status_desc: r.statusDesc, status_date: r.statusDate,
      status_changed: r.statusChanged, new_events: r.newEvents, added: r.added, proposed: r.proposed,
      mismatches: r.mismatches, passed: r.passed,
      completed_checks: r.completedChecks, summary: r.alertText || null
    });
  } catch (err) {
    console.error("POST tsdr/check error:", err.message);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

router.get("/api/tsdr/test", requireAuth, async (req, res) => {
  try {
    const tsdr = require("./tsdr-sync");
    const t = await tsdr.testSerial(String(req.query.sn || ""));
    res.json({ ok: true, ...t });
  } catch (err) {
    res.status(err.code === "BAD_NUMBER" ? 400 : 502).json({ error: err.message, code: err.code || null });
  }
});

module.exports = { router, handleCalendarFeed, ingestEmailText, lifecycleDeadlines, normalizeFilingBasis, matterAccess, staffRule, staffBodyProblem, usptoRef, trademarkRefTaken, STAFF_ROUTES, extractCaseNumbers, normalizeCaseRef, NOT_COURT_MATTERS };
