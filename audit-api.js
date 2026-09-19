// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-api.js — HTTP ROUTES
//  ─────────────────────────────────────────────────────────
//  An Express router mounted at /audit. Thin by design: every
//  rule lives in audit-store.js, every page in audit-ui.js.
//
//  Route groups:
//    /audit/login|logout|setup      unauthenticated entry
//    /audit/...                     HTML pages (audit-ui.js)
//    /audit/api/...                 JSON + file transfer
//
//  Permission is checked per route via audit-auth.requirePermission.
//  The independence boundary (auditors cannot upload or answer on
//  the company's behalf) is enforced by requireCompanySide in
//  addition to the permission check — belt and braces, because
//  that boundary is an SEC Rule 2-01 matter and not a preference.
// ============================================================

const express = require("express");
const multer = require("multer");

const auth = require("./audit-auth");
const store = require("./audit-store");
const ui = require("./audit-ui");
const tax = require("./audit-taxonomy");
const cal = require("./audit-calendar");
const checklists = require("./audit-checklists");
const schema = require("./audit-schema");
const notify = require("./audit-notify");
const db = require("./db");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: schema.MAX_FILE_BYTES, files: 25 },
});

const router = express.Router();

// The host app is not required to have a global body parser, and the
// module promises that mounting is two lines. Without this every JSON
// route died with "Cannot read properties of undefined (reading ...)".
router.use("/api", express.json({ limit: "2mb" }));

// ── Small helpers ───────────────────────────────────────────
function ok(res, data) {
  return res.json({ ok: true, ...data });
}
// Errors we raise ourselves are written FOR the user and should be
// shown. Errors from the driver or a library are not: they leak schema
// names, absolute paths and the dependency tree. Postgres errors carry a
// SQLSTATE `code`, which is a reliable way to tell the two apart.
function isInternalError(err) {
  if (!err || typeof err !== "object") return false;
  if (typeof err.code === "string" && /^[0-9A-Z]{5}$/.test(err.code)) return true; // SQLSTATE
  if (err.name === "MulterError") return false;
  return /^(TypeError|ReferenceError|RangeError|SyntaxError)$/.test(err.name || "");
}

function fail(res, err, code = 400) {
  const raw = err && err.message ? err.message : String(err);
  const ref = Math.random().toString(36).slice(2, 10);
  console.error(`[ngtf-audit api][${ref}]`, raw, err && err.stack ? "\n" + err.stack : "");
  const msg = isInternalError(err)
    ? `Something went wrong handling that request. Quote reference ${ref} if you report it.`
    : raw;
  return res.status(code).json({ ok: false, error: msg, ref });
}
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((e) => fail(res, e, 500));
}
function htmlWrap(fn) {
  return (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error("[ngtf-audit ui]", e.message);
      res.status(500).send(ui.errorPage(e.message, req.auditUser));
    });
}

// ════════════════ UNAUTHENTICATED ════════════════

router.get("/healthz", (req, res) => res.json({ ok: true, service: "ngtf-audit-portal", time: new Date().toISOString() }));

router.get("/setup", htmlWrap(async (req, res) => {
  if (await auth.isSetupComplete()) return res.redirect(`${auth.mountBase()}/login`);
  res.send(ui.setupPage());
}));

router.post("/setup", express.urlencoded({ extended: true }), wrap(async (req, res) => {
  if (await auth.isSetupComplete()) return fail(res, "Setup has already been completed.", 403);
  const { email, name, password, confirm } = req.body || {};
  if (!email || !name || !password) return fail(res, "Name, email and password are all required.");
  if (password.length < 10) return fail(res, "Use at least 10 characters — this account can reach every audit document.");
  if (password !== confirm) return fail(res, "Passwords do not match.");
  const user = await auth.createUser({ email, name, role: "portal_admin", org: "company", password });
  await auth.markSetupComplete();
  const full = await auth.getUserById(user.id);
  await auth.login(res, full, false);
  await schema.logEvent({ event: "portal_setup", actor: { id: full.id, email: full.email, org: full.org } });
  res.redirect(auth.mountBase());
}));

router.get("/login", htmlWrap(async (req, res) => {
  if (!(await auth.isSetupComplete())) return res.redirect(`${auth.mountBase()}/setup`);
  res.send(ui.loginPage({ next: req.query.next, error: req.query.error }));
}));

router.post("/login", express.urlencoded({ extended: true }), wrap(async (req, res) => {
  const { email, password, remember, next: nextUrl } = req.body || {};

  if (await auth.loginThrottled(email, req.ip)) {
    await schema.logEvent({
      event: "login_throttled",
      actor: { id: null, email: String(email || "").slice(0, 120), org: null },
      ip: req.ip,
    });
    return res.redirect(
      `${auth.mountBase()}/login?error=` +
        encodeURIComponent("Too many failed attempts. Wait a few minutes and try again.")
    );
  }

  const user = await auth.authenticate(email, password);
  if (!user) {
    await schema.logEvent({ event: "login_failed", actor: { id: null, email: String(email || "").slice(0, 120), org: null }, ip: req.ip });
    return res.redirect(`${auth.mountBase()}/login?error=` + encodeURIComponent("Incorrect email or password."));
  }
  await auth.login(res, user, !!remember);
  await schema.logEvent({ event: "login", actor: { id: user.id, email: user.email, org: user.org }, ip: req.ip, userAgent: req.headers["user-agent"] });
  res.redirect(nextUrl && String(nextUrl).startsWith(auth.mountBase()) ? nextUrl : auth.mountBase());
}));

router.get("/logout", (req, res) => {
  auth.clearSessionCookie(res);
  res.redirect(`${auth.mountBase()}/login`);
});

// ════════════════ HTML PAGES ════════════════

router.get("/", auth.requirePermission("dashboard.view"), htmlWrap(async (req, res) => {
  const data = await store.dashboard();
  res.send(ui.dashboardPage(data, req.auditUser));
}));

router.get("/engagement/:id", auth.requirePermission("dashboard.view"), htmlWrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const engagement = await store.getEngagement(id);
  if (!engagement) return res.status(404).send(ui.errorPage("Engagement not found.", req.auditUser));
  const [checklist, docs, progress, notes, evts] = await Promise.all([
    store.getChecklist(id),
    store.listDocuments({ engagementId: id, status: "all" }),
    store.bracketProgress(id),
    store.listComments({ engagementId: id }),
    store.events({ engagementId: id, limit: 80 }),
  ]);
  res.send(ui.engagementPage({ engagement, checklist, documents: docs, progress, notes, events: evts }, req.auditUser));
}));

router.get("/checklist/:id", auth.requirePermission("checklist.view"), htmlWrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const engagement = await store.getEngagement(id);
  if (!engagement) return res.status(404).send(ui.errorPage("Engagement not found.", req.auditUser));
  const checklist = await store.getChecklist(id);
  res.send(ui.checklistPage({ engagement, checklist }, req.auditUser));
}));

router.get("/document/:id", auth.requirePermission("document.view_all"), htmlWrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = await store.getDocument(id);
  if (!doc) return res.status(404).send(ui.errorPage("Document not found.", req.auditUser));
  const [comments, evts, versions] = await Promise.all([
    store.listComments({ documentId: id }),
    store.events({ documentId: id, limit: 100 }),
    db.query(
      `WITH RECURSIVE chain AS (
         SELECT id, filename, version, status, uploaded_at, supersedes_id FROM ngtf_audit_documents WHERE id=$1
         UNION ALL
         SELECT d.id, d.filename, d.version, d.status, d.uploaded_at, d.supersedes_id
           FROM ngtf_audit_documents d JOIN chain c ON d.id = c.supersedes_id)
       SELECT * FROM chain ORDER BY version DESC`,
      [id]
    ),
  ]);
  const engagement = doc.engagement_id ? await store.getEngagement(doc.engagement_id) : null;
  res.send(ui.documentPage({ document: doc, engagement, comments, events: evts, versions: versions.rows }, req.auditUser));
}));

router.get("/documents", auth.requirePermission("document.view_all"), htmlWrap(async (req, res) => {
  const filters = {
    engagementId: req.query.engagement ? parseInt(req.query.engagement, 10) : undefined,
    categoryCode: req.query.category || undefined,
    bracketCode: req.query.bracket || undefined,
    status: req.query.status || "active",
  };
  const [docs, engagements] = await Promise.all([store.listDocuments(filters), store.listEngagements({ limit: 40 })]);
  res.send(ui.documentsPage({ documents: docs, engagements, filters }, req.auditUser));
}));

router.get("/triage", auth.requirePermission("document.view_all"), htmlWrap(async (req, res) => {
  const docs = await store.listDocuments({ needsConfirmation: true, status: "active", limit: 200 });
  res.send(ui.triagePage({ documents: docs }, req.auditUser));
}));

router.get("/taxonomy", auth.requirePermission("dashboard.view"), htmlWrap(async (req, res) => {
  res.send(ui.taxonomyPage(req.auditUser));
}));

router.get("/calendar", auth.requirePermission("dashboard.view"), htmlWrap(async (req, res) => {
  const fy = parseInt(req.query.fy, 10) || cal.fiscalYearOf(new Date());
  const engagements = await store.listEngagements({ limit: 60 });
  res.send(ui.calendarPage({ fiscalYear: fy, engagements }, req.auditUser));
}));

router.get("/upload", auth.requirePermission("document.upload"), htmlWrap(async (req, res) => {
  const engagements = await store.listEngagements({ includeArchived: false, limit: 30 });
  res.send(ui.uploadPage({ engagements }, req.auditUser));
}));

router.get("/users", auth.requirePermission("portal.users"), htmlWrap(async (req, res) => {
  const users = await auth.listUsers();
  res.send(ui.usersPage({ users }, req.auditUser));
}));

// ════════════════ JSON API ════════════════

router.get("/api/dashboard", auth.requirePermission("dashboard.view"), wrap(async (req, res) => {
  ok(res, { dashboard: await store.dashboard() });
}));

router.get("/api/taxonomy", auth.requirePermission("dashboard.view"), wrap(async (req, res) => {
  ok(res, { brackets: tax.BRACKETS, categories: tax.CATEGORIES, stats: tax.STATS });
}));

router.get("/api/checklist/:id", auth.requirePermission("checklist.view"), wrap(async (req, res) => {
  const checklist = await store.getChecklist(parseInt(req.params.id, 10));
  if (!checklist) return fail(res, "No checklist for that engagement", 404);
  ok(res, { checklist });
}));

router.get("/api/engagements", auth.requirePermission("dashboard.view"), wrap(async (req, res) => {
  ok(res, { engagements: await store.listEngagements({ limit: 100 }) });
}));

router.get("/api/events", auth.requirePermission("events.view"), wrap(async (req, res) => {
  ok(res, {
    events: await store.events({
      documentId: req.query.document ? parseInt(req.query.document, 10) : undefined,
      engagementId: req.query.engagement ? parseInt(req.query.engagement, 10) : undefined,
      limit: Math.min(parseInt(req.query.limit, 10) || 200, 1000),
    }),
  });
}));

// ── Upload ──────────────────────────────────────────────────
router.post(
  "/api/upload",
  auth.requirePermission("document.upload"),
  auth.requireCompanySide,
  upload.array("files", 25),
  wrap(async (req, res) => {
    const files = req.files || [];
    if (!files.length) return fail(res, "No files received. Attach at least one file.");
    const results = [];
    for (const f of files) {
      try {
        const r = await store.ingestDocument({
          buffer: f.buffer,
          filename: f.originalname,
          mimeType: f.mimetype,
          user: req.auditUser,
          periodHint: req.body.periodHint || null,
          categoryOverride: req.body.category || null,
          engagementOverride: req.body.engagementId || null,
          additionReason: req.body.additionReason || null,
          req,
        });
        results.push({
          filename: f.originalname,
          ok: true,
          duplicate: !!r.duplicateOf,
          message: r.message || null,
          documentId: r.document ? r.document.id : null,
          version: r.document ? r.document.version : null,
          category: r.classification ? r.classification.categoryCode : null,
          categoryLabel: r.classification ? r.classification.categoryLabel : null,
          folderPath: r.classification ? r.classification.folderPath : null,
          period: r.classification ? r.classification.period : null,
          confidence: r.classification ? r.classification.confidence : null,
          method: r.classification ? r.classification.method : null,
          needsConfirmation: r.classification ? r.classification.needsConfirmation : null,
          brief: r.classification ? r.classification.brief : null,
          flags: r.classification ? r.classification.flags : [],
          satisfied: r.satisfiedItems.map((i) => i.label),
        });
      } catch (err) {
        results.push({ filename: f.originalname, ok: false, error: err.message });
      }
    }
    notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
    ok(res, { results, uploaded: results.filter((r) => r.ok && !r.duplicate).length });
  })
);

// ── Download (chain of custody logged) ──────────────────────
router.get("/api/document/:id/download", auth.requirePermission("document.download"), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = await store.getDocument(id, { withBytes: true });
  if (!doc) return fail(res, "Document not found", 404);
  if (doc.is_confidential && !auth.can(req.auditUser, "document.download_confidential")) {
    return fail(res, "This document is restricted. Your role does not permit downloading confidential items.", 403);
  }
  await store.recordDownload({ documentId: id, user: req.auditUser, req, bytes: doc.size_bytes });
  res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${String(doc.filename).replace(/"/g, "")}"`);
  res.setHeader("Content-Length", doc.size_bytes);
  res.setHeader("X-Document-SHA256", doc.sha256);
  res.setHeader("X-Document-Version", String(doc.version));
  res.send(doc.file_data);
}));

router.post("/api/document/:id/reclassify", auth.requirePermission("document.reclassify"), wrap(async (req, res) => {
  const doc = await store.reclassify({
    documentId: parseInt(req.params.id, 10),
    newCategory: req.body.category,
    reason: req.body.reason,
    user: req.auditUser,
  });
  ok(res, { document: doc });
}));

router.post("/api/document/:id/confirm", auth.requirePermission("document.reclassify"), wrap(async (req, res) => {
  await store.confirmClassification(parseInt(req.params.id, 10), req.auditUser);
  ok(res, {});
}));

// ── Checklist actions ───────────────────────────────────────
router.post(
  "/api/item/:id/answer",
  auth.requirePermission("checklist.answer"),
  auth.requireCompanySide,
  wrap(async (req, res) => {
    const r = await store.answerSweep({
      itemId: parseInt(req.params.id, 10),
      answer: req.body.answer === true || req.body.answer === "true" || req.body.answer === "yes",
      note: req.body.note,
      supersede: req.body.supersede === true || req.body.supersede === "true",
      user: req.auditUser,
    });
    notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
    ok(res, { item: r.item, spawned: r.spawned, reopened: r.reopened || [], retracted: r.retracted || [] });
  })
);

router.post("/api/item/:id/waive", auth.requirePermission("checklist.waive"), wrap(async (req, res) => {
  ok(res, { item: await store.waiveItem({ itemId: parseInt(req.params.id, 10), reason: req.body.reason, user: req.auditUser }) });
}));

router.post("/api/item/:id/accept", auth.requirePermission("checklist.accept"), wrap(async (req, res) => {
  ok(res, { item: await store.acceptItem({ itemId: parseInt(req.params.id, 10), user: req.auditUser }) });
}));

router.post("/api/item/:id/reject", auth.requirePermission("checklist.reject"), wrap(async (req, res) => {
  if (!req.body.reason || String(req.body.reason).trim().length < 5) {
    return fail(res, "Say what is wrong with it — the company has to know what to fix.");
  }
  const r = await store.rejectItem({ itemId: parseInt(req.params.id, 10), reason: req.body.reason, user: req.auditUser });
  notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
  ok(res, r);
}));

// ── Comments / review notes ─────────────────────────────────
router.post("/api/comment", auth.requirePermission("comment.write"), wrap(async (req, res) => {
  const c = await store.addComment({
    documentId: req.body.documentId ? parseInt(req.body.documentId, 10) : null,
    itemId: req.body.itemId ? parseInt(req.body.itemId, 10) : null,
    engagementId: req.body.engagementId ? parseInt(req.body.engagementId, 10) : null,
    parentId: req.body.parentId ? parseInt(req.body.parentId, 10) : null,
    body: req.body.body,
    kind: req.body.kind || "comment",
    user: req.auditUser,
  });
  notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
  ok(res, { comment: c });
}));

router.post("/api/comment/:id/resolve", auth.requirePermission("comment.resolve"), wrap(async (req, res) => {
  await store.resolveComment(parseInt(req.params.id, 10), req.auditUser);
  ok(res, {});
}));

// ── Engagement lifecycle ────────────────────────────────────
router.post("/api/engagement/open", auth.requirePermission("engagement.create"), wrap(async (req, res) => {
  const tier = req.body.tier;
  const fy = parseInt(req.body.fiscalYear, 10);
  // For monthly/quarterly, n is the period number. For an S-1 bring-down
  // it is the amendment label ("Amendment No. 2"), and for an event it is
  // { label, eventDate } — neither may be coerced to an integer.
  let n;
  if (tier === "s1") {
    n = String(req.body.n || "S-1/A").trim();
  } else if (tier === "event") {
    const label = String((req.body.n && req.body.n.label) || req.body.label || "").trim();
    const eventDate = String((req.body.n && req.body.n.eventDate) || req.body.eventDate || "").trim();
    if (!label) return fail(res, "An event engagement needs a name — what happened, in a few words.");
    if (!eventDate) {
      return fail(
        res,
        "An event engagement needs the date the event occurred. The 8-K clock runs four business " +
          "days from that date and the Item 9.01(a)(4) amendment 71 days from the 8-K due date, so " +
          "the portal cannot compute either without it."
      );
    }
    n = { label, eventDate };
  } else {
    n = req.body.n ? parseInt(req.body.n, 10) : null;
  }
  if (!tier || !fy) return fail(res, "tier and fiscalYear are required");
  const r = await store.openEngagement({ tier, fiscalYear: fy, n, actor: req.auditUser });
  notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
  ok(res, { engagement: r.engagement, created: r.created });
}));

router.post("/api/engagement/seed-year", auth.requirePermission("engagement.create"), wrap(async (req, res) => {
  const fy = parseInt(req.body.fiscalYear, 10);
  if (!fy) return fail(res, "fiscalYear is required");
  const created = [];
  for (let m = 1; m <= 12; m++) {
    const info = cal.fiscalMonths(fy).find((x) => x.fiscalMonth === m);
    if (info.isFiscalYearEnd || info.isQuarterEnd) continue;
    const r = await store.openEngagement({ tier: "monthly", fiscalYear: fy, n: m, actor: req.auditUser });
    created.push({ period: r.engagement.period_label, created: r.created });
  }
  for (const q of [1, 2, 3]) {
    const r = await store.openEngagement({ tier: "quarterly", fiscalYear: fy, n: q, actor: req.auditUser });
    created.push({ period: r.engagement.period_label, created: r.created });
  }
  const a = await store.openEngagement({ tier: "annual", fiscalYear: fy, actor: req.auditUser });
  created.push({ period: a.engagement.period_label, created: a.created });
  notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
  ok(res, { fiscalYear: fy, engagements: created });
}));

router.post("/api/engagement/:id/report-release", auth.requirePermission("engagement.set_report_date"), wrap(async (req, res) => {
  const eng = await store.setReportReleaseDate(parseInt(req.params.id, 10), req.body.date, req.auditUser);
  notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
  ok(res, { engagement: eng, clock: cal.documentationCompletionDate(req.body.date) });
}));

router.post("/api/engagement/:id/archive", auth.requirePermission("engagement.archive"), wrap(async (req, res) => {
  const eng = await store.archiveEngagement(parseInt(req.params.id, 10), req.auditUser);
  notify.flush().catch((e) => console.error("[ngtf-audit] notification flush failed:", e.message));
  ok(res, { engagement: eng });
}));

router.post("/api/engagement/:id/legal-hold", auth.requirePermission("engagement.legal_hold"), wrap(async (req, res) => {
  const eng = await store.setLegalHold(parseInt(req.params.id, 10), req.body.on !== false, req.body.reason, req.auditUser);
  ok(res, { engagement: eng });
}));

router.post("/api/engagement/:id/filed", auth.requirePermission("engagement.create"), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const when = req.body.date || cal.iso(new Date());
  // Validate before writing: the chain-of-custody log is append-only, so
  // a "filing recorded" entry for an engagement that does not exist can
  // never be corrected or removed.
  const r = await db.query(`UPDATE ngtf_audit_engagements SET filed_on=$1 WHERE id=$2 RETURNING *`, [when, id]);
  if (!r.rowCount) return fail(res, `Engagement ${id} not found.`, 404);
  await schema.logEvent({ engagementId: id, event: "filing_recorded", actor: req.auditUser, detail: { date: when } });
  ok(res, { engagement: r.rows[0] });
}));

// ── PBC index export (xlsx) ─────────────────────────────────
// Auditors live in Excel. This hands them the whole request list
// with status, due dates, authority and SHA-256 per delivered item.
router.get("/api/engagement/:id/pbc.xlsx", auth.requirePermission("checklist.view"), wrap(async (req, res) => {
  const XLSX = require("xlsx");
  const id = parseInt(req.params.id, 10);
  const engagement = await store.getEngagement(id);
  if (!engagement) return fail(res, "Engagement not found", 404);
  const checklist = await store.getChecklist(id);
  if (!checklist) return fail(res, "No checklist for that engagement", 404);

  const rows = checklist.items.map((i) => ({
    Ref: i.category_code || i.sweep_id || "",
    Section: i.bracket_code ? tax.BRACKET_BY_CODE[i.bracket_code].label : "Sweep question",
    Item: i.label,
    Type: i.kind === "sweep" ? "Inquiry" : "Document",
    Gating: i.is_gate ? "YES" : "",
    Status: i.status,
    "Due date": cal.dstr(i.due_date),
    Owner: i.owner_role || "",
    "Delivered file": i.doc_filename || "",
    Version: i.doc_version || "",
    "SHA-256": i.doc_sha || "",
    "Satisfied / answered": cal.dstr(i.satisfied_at || i.answered_at),
    Answer: i.kind === "sweep" ? (i.answer === true ? "YES" : i.answer === false ? "NO" : "") : "",
    "Answer detail": i.answer_note || "",
    "Auditor accepted": i.auditor_accepted ? "YES" : "",
    Authority: Array.isArray(i.authority) ? i.authority.join("; ") : "",
    Waiver: i.waiver_reason || "",
  }));

  const summary = [
    ["Nightfood Holdings, Inc. — PBC Request Index"],
    ["Engagement", engagement.period_name || engagement.period_label],
    ["Tier", engagement.tier],
    ["Period end", cal.dstr(engagement.period_end)],
    ["Form", engagement.filing_form || "—"],
    ["Filing due", cal.dstr(engagement.filing_due_date)],
    ["Form 12b-25 due by", cal.dstr(engagement.filing_nt_due_date)],
    ["Extended date if 12b-25 filed", cal.dstr(engagement.filing_extended_date)],
    ["Report release date", cal.dstr(engagement.report_release_date) || "not set"],
    ["AS 1215.15 documentation completion date", cal.dstr(engagement.doc_completion_date) || "not set"],
    ["AS 1215.14 retention through", cal.dstr(engagement.retention_expiry) || "not set"],
    ["Engagement status", engagement.status],
    ["Total items", rows.length],
    ["Open", rows.filter((r) => r.Status === "open").length],
    ["Open gating items", checklist.items.filter((i) => i.status === "open" && i.is_gate).length],
    ["Exported", new Date().toISOString()],
    ["Exported by", `${req.auditUser.name} <${req.auditUser.email}>`],
  ];

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  ws1["!cols"] = [{ wch: 42 }, { wch: 52 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Summary");
  const ws2 = XLSX.utils.json_to_sheet(rows);
  ws2["!cols"] = [
    { wch: 8 }, { wch: 34 }, { wch: 58 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 12 },
    { wch: 18 }, { wch: 32 }, { wch: 8 }, { wch: 22 }, { wch: 18 }, { wch: 8 }, { wch: 46 },
    { wch: 16 }, { wch: 40 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, ws2, "PBC Index");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  await schema.logEvent({ engagementId: id, event: "pbc_index_exported", actor: req.auditUser, detail: { items: rows.length } });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="NGTF PBC Index ${engagement.period_label}.xlsx"`);
  res.send(buf);
}));

// ── Users ───────────────────────────────────────────────────
router.post("/api/users", auth.requirePermission("portal.users"), wrap(async (req, res) => {
  const { email, name, role, password, firmName, title, phone } = req.body || {};
  const u = await auth.createUser({ email, name, role, password, firmName, title, phone });
  await schema.logEvent({ event: "user_created", actor: req.auditUser, detail: { email, role } });
  ok(res, { user: u });
}));

router.post("/api/users/:id/password", auth.requirePermission("portal.users"), wrap(async (req, res) => {
  if (!req.body.password || req.body.password.length < 10) return fail(res, "Use at least 10 characters.");
  await auth.setPassword(parseInt(req.params.id, 10), req.body.password);
  await schema.logEvent({ event: "password_set", actor: req.auditUser, detail: { userId: req.params.id } });
  ok(res, {});
}));

router.post("/api/users/:id/deactivate", auth.requirePermission("portal.users"), wrap(async (req, res) => {
  const target = await auth.deactivateUser(parseInt(req.params.id, 10), req.auditUser.id);
  await schema.logEvent({
    event: "user_deactivated",
    actor: req.auditUser,
    detail: { userId: target.id, email: target.email, role: target.role },
  });
  ok(res, {});
}));

router.post("/api/users/:id/prefs", wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.auditUser.id !== id && !auth.can(req.auditUser, "portal.users")) {
    return fail(res, "You can only change your own notification preferences.", 403);
  }
  const { notifyEmail, notifySms, notifyInstant, notifyDigest, phone } = req.body || {};
  await db.query(
    `UPDATE ngtf_audit_users
        SET notify_email=COALESCE($1,notify_email), notify_sms=COALESCE($2,notify_sms),
            notify_instant=COALESCE($3,notify_instant), notify_digest=COALESCE($4,notify_digest),
            phone=COALESCE($5,phone)
      WHERE id=$6`,
    [notifyEmail, notifySms, notifyInstant, notifyDigest, phone, id]
  );
  ok(res, {});
}));

// ── Notification utilities ──────────────────────────────────
router.post("/api/notify/test", auth.requirePermission("portal.settings"), wrap(async (req, res) => {
  ok(res, { result: await notify.selfTest(req.body.email || req.auditUser.email) });
}));

router.post("/api/notify/flush", auth.requirePermission("portal.settings"), wrap(async (req, res) => {
  ok(res, { result: await notify.flush(200) });
}));

router.post("/api/notify/run-sweeps", auth.requirePermission("portal.settings"), wrap(async (req, res) => {
  const out = {
    dueAndOverdue: await notify.notifyDueAndOverdue(),
    filingDeadlines: await notify.notifyFilingDeadlines(),
    archiveCountdown: await notify.notifyArchiveCountdown(),
  };
  out.flush = await notify.flush(200);
  ok(res, out);
}));

router.get("/api/notify/outbox", auth.requirePermission("portal.settings"), wrap(async (req, res) => {
  const r = await db.query(
    `SELECT id, kind, channel, recipient_addr, subject, status, error, scheduled_for, sent_at, created_at
       FROM ngtf_audit_notifications ORDER BY id DESC LIMIT 100`
  );
  ok(res, { notifications: r.rows });
}));

// ── Settings ────────────────────────────────────────────────
router.get("/api/settings", auth.requirePermission("portal.settings"), wrap(async (req, res) => {
  const r = await db.query(`SELECT key, value, updated_at FROM ngtf_audit_settings ORDER BY key`);
  ok(res, { settings: r.rows });
}));

router.post("/api/settings/:key", auth.requirePermission("portal.settings"), wrap(async (req, res) => {
  await schema.setSetting(req.params.key, req.body.value);
  await schema.logEvent({ event: "setting_changed", actor: req.auditUser, detail: { key: req.params.key } });
  ok(res, {});
}));

// ── Whoami ──────────────────────────────────────────────────
router.get("/api/whoami", (req, res) => {
  ok(res, {
    user: req.auditUser,
    role: req.auditUser ? auth.ROLES[req.auditUser.role] : null,
    permissions: req.auditUser ? auth.permissionsFor(req.auditUser.role) : {},
  });
});

// ── Error handler (MUST be last) ────────────────────────────
// multer calls next(err) on LIMIT_FILE_SIZE, and with no handler here it
// escaped to the HOST app's default handler, which returned an HTML 500
// containing absolute server paths and a stack trace — and the upload
// page then failed to parse it as JSON, so the user saw
// "Unexpected token '<'" instead of a usable message.
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && err.name === "MulterError") {
    const limitMb = Math.floor(schema.MAX_FILE_BYTES / 1024 / 1024);
    const messages = {
      LIMIT_FILE_SIZE:
        `That file is over the ${limitMb} MB limit. Split large general-ledger extracts by month or by ` +
        `account range, or ask the portal administrator to raise AUDIT_MAX_FILE_MB.`,
      LIMIT_FILE_COUNT: "Too many files at once — send 25 or fewer per upload.",
      LIMIT_UNEXPECTED_FILE: "Unexpected form field. Use the upload page, or post files under the 'files' field.",
    };
    return fail(res, messages[err.code] || `Upload rejected: ${err.code}`, 413);
  }

  if (auth.wantsJSON(req)) return fail(res, err, 500);
  console.error("[ngtf-audit ui]", err && err.message);
  return res.status(500).send(ui.errorPage("Something went wrong handling that request.", req.auditUser));
});

module.exports = { router, upload };
