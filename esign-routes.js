// ============================================================
//  esign-routes.js — the staff API for templates and signing,
//  and the public pages a signer uses.
// ------------------------------------------------------------
//  Staff routes are registered through the mirror, so each exists at
//  /api/staff/esign/* (the app, bearer token) AND /admin/esign/api/*
//  (the web admin, cookie). E-signing is not a civil feature: it serves
//  civil matters and immigration clients alike.
//
//  Who can do what (JJ: "only admin can access" the templates):
//    · templates — upload, edit, activate, archive, see drafts: ADMIN only
//    · preparing and sending from an ACTIVE template: any firm user who
//      is not view-only; for a client (not a civil matter), only staff
//      who can see that client
//    · uploading a document and sending it for signature (esign-pdf.js):
//      the same people. A document that belongs to no client and no
//      matter is seen by whoever uploaded it, and by admins and managers.
//
//  Staff pages (web admin, behind the /admin sign-in):
//    GET  /admin/esign                     documents out for signature; upload
//    GET  /admin/esign/prepare/:id         signers and fields for an upload
//
//  Public routes (no login — the token in the link IS the access):
//    GET  /sign/e/:token                   the signing page
//    GET  /api/public/esign/:token         what the page shows
//    GET  /api/public/esign/:token/pdf     the uploaded document, as it stands
//    POST /api/public/esign/:token/sign    sign
//    POST /api/public/esign/:token/decline decline
// ============================================================

const multer = require("multer");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

function who(req) { return (req.user && (req.user.n || req.user.u)) || "staff"; }

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const host = req.get("x-forwarded-host") || req.get("host");
  const proto = (req.get("x-forwarded-proto") || "").split(",")[0] || (/localhost|127\.0\.0\.1/.test(host || "") ? "http" : "https");
  return host ? `${proto}://${host}` : null;
}

function canWrite(req, res, next) {
  if (req.user && req.user.r === "viewer") return res.status(403).json({ ok: false, error: "View-only accounts cannot prepare or send documents" });
  next();
}
function adminOnly(req, res, next) {
  if (req.user && req.user.r === "admin") return next();
  return res.status(403).json({ ok: false, error: "Only an admin can manage document templates" });
}
const isAdminUser = req => !!(req.user && req.user.r === "admin");
// Admins and managers see every client, here as everywhere else.
const seesAll = req => !!(req.user && (req.user.r === "admin" || req.user.r === "manager"));
const mine = (req, p) => !!(req.user && req.user.uid != null && p.created_by_uid === req.user.uid);

function sendInline(res, buffer, name) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (name) res.setHeader("Content-Disposition", `attachment; filename="${String(name).replace(/[^\w .()-]+/g, "_")}"`);
  res.send(buffer);
}

function sendFile(res, f) {
  res.setHeader("Content-Type", f.type);
  res.setHeader("Content-Disposition", `attachment; filename="${String(f.name).replace(/[^\w .()-]+/g, "_")}"`);
  res.send(f.buffer);
}

const fail = (res, e, code = 400) => res.status(e.status || code).json({ ok: false, error: e.message });

const STAFF_PREFIX = "/api/staff/esign";
// The colour of ink on the page: what a signer writes is drawn in it, here and on the PDF.
const INK_BLUE = "#0B1F4B";

function attachStaffRoutes(app, { requireBearer, requireFirmUser, canUserAccessClient = null }) {
  const T = () => require("./esign-templates");
  const E = () => require("./esign");
  const A = [requireBearer, requireFirmUser];
  const P = STAFF_PREFIX;

  // A document for a client (not a civil matter) is visible to staff who
  // can see that client, as everywhere else in the app.
  async function mayUseClient(req, clientKey) {
    if (!clientKey || isAdminUser(req) || !canUserAccessClient) return true;
    try { return await canUserAccessClient(req.user, clientKey); } catch (e) { return false; }
  }
  // Who may open a document: a civil matter's are the firm's; a client's
  // are for staff who can see that client; one that belongs to neither is
  // its sender's (and an admin's or manager's).
  async function maySee(req, p) {
    if (p.case_id) return true;
    if (p.client_key) return mayUseClient(req, p.client_key);
    return seesAll(req) || mine(req, p);
  }
  async function packetGuard(req, res, next) {
    try {
      const p = await E().getPacket(req.params.id);
      if (!(await maySee(req, p))) {
        return res.status(403).json({ ok: false, error: p.client_key ? "You do not have access to this client" : "That document was sent by someone else" });
      }
      next();
    } catch (e) { fail(res, e, 404); }
  }
  const PDF = () => require("./esign-pdf");

  app.get(`${P}/meta`, ...A, async (req, res) => {
    const t = T();
    // "Add myself as a signer" needs the name and address of whoever is signed in.
    let me = { name: (req.user && req.user.n) || "", email: "" };
    try {
      const r = await require("./db").query(`SELECT full_name, email FROM admin_users WHERE id = $1`, [req.user.uid]);
      if (r.rows[0]) me = { name: r.rows[0].full_name || me.name, email: r.rows[0].email || "" };
    } catch (e) { /* the name from the sign-in is enough */ }
    res.json({ ok: true, sources: t.SOURCES, types: t.TYPES, categories: t.CATEGORIES, can_manage_templates: isAdminUser(req),
      can_write: !(req.user && req.user.r === "viewer"), me,
      upload: { max_mb: Math.round(PDF().MAX_BYTES / 1048576), max_pages: PDF().MAX_PAGES, max_signers: PDF().MAX_SIGNERS, field_types: PDF().FIELD_TYPES } });
  });

  // ── Templates ──
  // Everyone preparing a document needs the ACTIVE ones; drafts and
  // archived ones are the admin's workbench.
  app.get(`${P}/templates`, ...A, async (req, res) => {
    try {
      const all = await T().listTemplates({ includeArchived: isAdminUser(req) && req.query.all === "1" });
      res.json({ ok: true, templates: isAdminUser(req) ? all : all.filter(t => t.status === "active") });
    } catch (e) { fail(res, e, 500); }
  });
  app.post(`${P}/templates`, ...A, adminOnly, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "Choose a document to upload" });
      res.json({ ok: true, template: await T().createFromUpload(req.file.buffer, req.file.originalname, { by: who(req) }) });
    } catch (e) { console.warn("[esign] template from upload:", e.message); fail(res, e); }
  });
  app.get(`${P}/templates/:id`, ...A, adminOnly, async (req, res) => {
    try { res.json({ ok: true, template: await T().getTemplate(req.params.id) }); } catch (e) { fail(res, e, 404); }
  });
  app.get(`${P}/templates/:id/preview`, ...A, adminOnly, async (req, res) => {
    try { res.json({ ok: true, html: await T().previewHtml(req.params.id) }); } catch (e) { fail(res, e); }
  });
  app.get(`${P}/templates/:id/download`, ...A, adminOnly, async (req, res) => {
    try {
      const t = await T().getTemplate(req.params.id, { withDocx: true });
      sendFile(res, { buffer: t.docx, name: `${t.name} (template).docx`, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    } catch (e) { fail(res, e, 404); }
  });
  app.patch(`${P}/templates/:id`, ...A, adminOnly, async (req, res) => {
    try { res.json({ ok: true, template: await T().updateTemplate(req.params.id, req.body || {}, { by: who(req) }) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/templates/:id/replace`, ...A, adminOnly, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "Choose the edited .docx" });
      res.json({ ok: true, template: await T().replaceDocx(req.params.id, req.file.buffer, req.file.originalname) });
    } catch (e) { fail(res, e); }
  });
  app.post(`${P}/templates/:id/status`, ...A, adminOnly, async (req, res) => {
    try { res.json({ ok: true, template: await T().setStatus(req.params.id, String((req.body || {}).status || "")) }); } catch (e) { fail(res, e); }
  });

  // ── Preparing and sending ──
  app.get(`${P}/prefill`, ...A, canWrite, async (req, res) => {
    try {
      const clientKey = req.query.case_id ? null : (req.query.client_key || null);
      if (!req.query.case_id && !clientKey) return res.status(400).json({ ok: false, error: "Open a case or a client first" });
      if (!(await mayUseClient(req, clientKey))) return res.status(403).json({ ok: false, error: "You do not have access to this client" });
      res.json({ ok: true, ...(await E().prefill(req.query.template_id, { caseId: req.query.case_id || null, clientKey }, { user: req.user })) });
    } catch (e) { fail(res, e); }
  });
  app.post(`${P}/packets`, ...A, canWrite, async (req, res) => {
    try {
      const b = req.body || {};
      const clientKey = b.case_id ? null : (b.client_key || null);
      if (!b.case_id && !clientKey) return res.status(400).json({ ok: false, error: "Open a case or a client first" });
      if (!(await mayUseClient(req, clientKey))) return res.status(403).json({ ok: false, error: "You do not have access to this client" });
      let packet = await E().createPacket({
        templateId: b.template_id, caseId: b.case_id || null, clientKey, title: b.title, values: b.values || {},
        signers: b.signers || [], message: b.message || null, user: req.user,
      });
      let delivered = null;
      if (b.send) {
        const out = await E().sendPacket(packet.id, { baseUrl: baseUrl(req), user: req.user });
        packet = out.packet; delivered = out.delivered;
      }
      res.json({ ok: true, packet, delivered });
    } catch (e) { fail(res, e); }
  });
  app.get(`${P}/packets`, ...A, async (req, res) => {
    try {
      const clientKey = req.query.case_id ? null : (req.query.client_key || null);
      if (!req.query.case_id && !clientKey && !isAdminUser(req)) return res.status(400).json({ ok: false, error: "Open a case or a client first" });
      if (!(await mayUseClient(req, clientKey))) return res.status(403).json({ ok: false, error: "You do not have access to this client" });
      res.json({ ok: true, packets: await E().listPackets({ caseId: req.query.case_id || null, clientKey }) });
    } catch (e) { fail(res, e, 500); }
  });
  app.get(`${P}/packets/:id`, ...A, packetGuard, async (req, res) => {
    try { res.json({ ok: true, packet: await E().getPacket(req.params.id) }); } catch (e) { fail(res, e, 404); }
  });
  app.post(`${P}/packets/:id/send`, ...A, canWrite, packetGuard, async (req, res) => {
    try { res.json({ ok: true, ...(await E().sendPacket(req.params.id, { baseUrl: baseUrl(req), user: req.user })) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/packets/:id/cancel`, ...A, canWrite, packetGuard, async (req, res) => {
    try { res.json({ ok: true, packet: await E().cancelPacket(req.params.id, { user: req.user, reason: (req.body || {}).reason }) }); } catch (e) { fail(res, e); }
  });
  // Links for signing in person (hand the tablet over in the office).
  app.get(`${P}/packets/:id/links`, ...A, canWrite, packetGuard, async (req, res) => {
    try {
      const p = await E().getPacket(req.params.id, { includeTokens: true });
      res.json({ ok: true, links: p.signers.map(s => ({ signer_id: s.id, name: s.name, role: s.role, status: s.status, url: E().signUrl(baseUrl(req), s.token) })) });
    } catch (e) { fail(res, e, 404); }
  });
  // File a fully signed document again, after Dropbox or the PDF step failed.
  app.post(`${P}/packets/:id/refile`, ...A, canWrite, packetGuard, async (req, res) => {
    try { res.json({ ok: true, packet: await E().refinalize(req.params.id) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/signers/:id/remind`, ...A, canWrite, async (req, res) => {
    try {
      const p = await E().getPacket(await E().packetIdForSigner(req.params.id));
      if (!(await maySee(req, p))) return res.status(403).json({ ok: false, error: "You do not have access to this document" });
      res.json({ ok: true, delivered: await E().remind(req.params.id, { baseUrl: baseUrl(req) }) });
    } catch (e) { fail(res, e); }
  });
  app.get(`${P}/packets/:id/download/:which`, ...A, packetGuard, async (req, res) => {
    try { sendFile(res, await E().download(req.params.id, req.params.which)); } catch (e) { fail(res, e, 404); }
  });

  // ── Upload a document and send it for signature (esign-pdf.js) ──
  // Everything out for signature that this person may see, newest first.
  app.get(`${P}/documents`, ...A, async (req, res) => {
    try {
      const all = await PDF().listAll({ limit: 400 });
      const seen = new Map();
      const out = [];
      for (const p of all) {
        let ok;
        if (seesAll(req) || p.case_id || mine(req, p)) ok = true;
        else if (!p.client_key) ok = false;
        else {
          if (!seen.has(p.client_key)) seen.set(p.client_key, await mayUseClient(req, p.client_key));
          ok = seen.get(p.client_key);
        }
        if (ok) out.push(p);
        if (out.length >= 150) break;
      }
      // The client's name, for the list (their key means nothing on screen).
      const names = {};
      try {
        const cp = require("./client-profiles");
        for (const key of new Set(out.map(p => p.client_key).filter(Boolean))) {
          const c = await cp.getClientByKey(key);
          if (c && c.client_name) names[key] = c.client_name;
        }
      } catch (e) { /* the list still works without names */ }
      res.json({ ok: true, documents: out.map(p => ({ ...p, client_name: names[p.client_key] || null })) });
    } catch (e) { fail(res, e, 500); }
  });
  // Step 1. The file becomes a draft; signers and fields come next.
  app.post(`${P}/uploads`, ...A, canWrite, (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ ok: false, error: err.code === "LIMIT_FILE_SIZE" ? "That file is over 25 MB." : "The upload did not come through. Try again." });
      next();
    });
  }, async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "Choose a document to upload" });
      const b = req.body || {};
      const clientKey = b.case_id ? null : (b.client_key || null);
      if (clientKey && !(await mayUseClient(req, clientKey))) return res.status(403).json({ ok: false, error: "You do not have access to this client" });
      if (clientKey) {
        const c = await require("./client-profiles").getClientByKey(clientKey).catch(() => null);
        if (!c) return res.status(404).json({ ok: false, error: "Client not found" });
      }
      res.json({ ok: true, packet: await PDF().createDraft({
        buffer: req.file.buffer, filename: req.file.originalname, title: b.title || null,
        clientKey, caseId: b.case_id || null, user: req.user }) });
    } catch (e) { fail(res, e); }
  });
  // The uploaded document itself, for the page that places the fields.
  app.get(`${P}/packets/:id/pdf`, ...A, packetGuard, async (req, res) => {
    try {
      const p = await E().getPacket(req.params.id, { withBytes: true });
      if (p.kind !== "upload" || !p.pdf) return res.status(404).json({ ok: false, error: "That document was made from a template" });
      sendInline(res, p.pdf);
    } catch (e) { fail(res, e, 404); }
  });
  // What the prepare page opens with: the draft, and who is likely to sign
  // it — the client it was uploaded for, and whoever is preparing it.
  app.get(`${P}/packets/:id/prepare`, ...A, packetGuard, async (req, res) => {
    try {
      const packet = await E().getPacket(req.params.id);
      if (packet.kind !== "upload") return res.status(400).json({ ok: false, error: "That document was made from a template; it is prepared on the client's or the matter's page." });
      const suggest = { client: null };
      if (packet.client_key) {
        const v = await E().clientValues(packet.client_key, {}, { hearings: false });
        if (v.client_name) suggest.client = { key: packet.client_key, name: v.client_name, email: v.client_email || "", phone: v.client_phone || "" };
      }
      res.json({ ok: true, packet, suggest });
    } catch (e) { fail(res, e, 404); }
  });
  // Steps 2 and 3: who signs, and where. `send: true` sends it in the same breath.
  app.post(`${P}/packets/:id/prepare`, ...A, canWrite, packetGuard, async (req, res) => {
    try {
      const b = req.body || {};
      let packet = await PDF().savePrepared(req.params.id, {
        title: b.title, message: b.message, signers: b.signers, fields: b.fields, email_copies: b.email_copies });
      let delivered = null;
      if (b.send) {
        const out = await E().sendPacket(packet.id, { baseUrl: baseUrl(req), user: req.user });
        packet = out.packet; delivered = out.delivered;
      }
      res.json({ ok: true, packet, delivered });
    } catch (e) { fail(res, e); }
  });
  // A draft that was never sent can be thrown away.
  app.post(`${P}/packets/:id/discard`, ...A, canWrite, packetGuard, async (req, res) => {
    try { res.json(await PDF().discardDraft(req.params.id)); } catch (e) { fail(res, e); }
  });
}

function attachPublicRoutes(app) {
  const E = () => require("./esign");
  // The signer's IP goes on a legal certificate, so it must not be theirs to
  // choose. Render's proxy APPENDS the address it saw to X-Forwarded-For;
  // anything before that came from the client. Take the last entry.
  const ipOf = req => {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || null;
  };

  app.get("/api/public/esign/:token", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const v = await E().signerView(req.params.token, { ip: ipOf(req) });
      res.status(v.ok ? 200 : (v.status || 400)).json(v);
    } catch (e) { res.status(500).json({ ok: false, error: "Something went wrong opening this document. Please try again." }); }
  });
  app.post("/api/public/esign/:token/sign", async (req, res) => {
    try {
      const b = req.body || {};
      const out = await E().sign(req.params.token, {
        typed_name: b.typed_name, signature: b.signature, consent: b.consent === true,
        // An uploaded document: initials, what was typed into the text boxes,
        // the ticked boxes — and pictures of any text the PDF fonts cannot write.
        initials: b.initials, values: b.values, images: b.images, lang: b.lang, mode: b.mode,
        // No baseUrl: the next signer's link uses the address fixed when
        // staff sent it, never one taken from this (public) request.
        ip: ipOf(req), userAgent: req.get("user-agent"),
      });
      res.json({ ok: true, completed: out.completed });
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Your signature could not be saved. Please try again." }); }
  });
  // The uploaded document as it stands (earlier signers' marks on it); once
  // everyone has signed, the finished copy with its certificate.
  app.get("/api/public/esign/:token/pdf", async (req, res) => {
    try {
      const out = await require("./esign-pdf").pdfForSigner(req.params.token);
      res.setHeader("X-Robots-Tag", "noindex");
      sendInline(res, out.pdf, req.query.download ? out.name : null);
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "The document could not be opened. Please try again." }); }
  });
  app.post("/api/public/esign/:token/decline", async (req, res) => {
    try { res.json(await E().decline(req.params.token, { reason: (req.body || {}).reason, ip: ipOf(req) })); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Could not record that. Please call 626-678-8677." }); }
  });

  // The page itself. Everything it does comes from /static/esign-sign.js.
  app.get("/sign/e/:token", (req, res) => {
    const token = String(req.params.token || "").replace(/[^A-Za-z0-9_-]/g, "");
    const theme = require("./tez-theme");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.setHeader("Referrer-Policy", "no-referrer");
    // No inline script. pdf.js (an uploaded document's pages) is this
    // server's own file and runs its worker from here too; it hands fonts
    // and pictures to the page as data: and blob: URLs.
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${theme.C.charcoal}">
<title>Review and sign — TEZ Law Firm</title>
${theme.FONTS}
<style>${theme.CSS}${SIGN_CSS}</style></head>
<body>
<header class="tez-top"><div class="tez-bar sign-bar">
  ${theme.SHIELD}
  <div class="tez-title"><small>TEZ Law Firm</small><span id="esign-area">Secure document signing</span></div>
  <button type="button" id="esign-lang" class="tez-signout" hidden>中文</button>
</div></header>
<main id="esign" data-token="${token}"><div class="card">Loading the document…</div></main>
<div class="foot">TEZ Law Firm · 626-678-8677 · tezlawfirm.com</div>
${require("./client-script").clientScriptTag("esign-sign.js")}
</body></html>`);
  });

  attachStaffPages(app);
}

// What the signing page adds to the firm's stylesheet (tez-theme.js).
const SIGN_CSS = `
  .sign-bar { padding-bottom: 14px; flex-wrap: nowrap; }
  .sign-bar #esign-lang { margin-left: auto; white-space: nowrap; }
  main#esign { max-width: 900px; margin-top: 20px; }
  .muted { color: var(--stone); font-size: 13.5px; }
  .err { color: var(--bad); font-weight: 600; margin-top: 10px; min-height: 1px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
  .btn-quiet { background: none; border: 0; color: var(--stone); font: 600 12px var(--sans); letter-spacing: .06em; text-decoration: underline; cursor: pointer; padding: 12px 6px; }
  textarea { font-family: inherit; }
  .doc { background: #fff; border: 1px solid var(--travertine); border-radius: 4px; padding: 28px 32px; max-height: 62vh; overflow: auto; font: 15px/1.55 Georgia, "Times New Roman", "Songti SC", serif; color: #111; margin-bottom: 16px; }
  .doc img { max-width: 220px; }
  .esign-spot { background: var(--marble); border: 1px dashed var(--stone); border-radius: 3px; padding: 1px 6px; font: 12px var(--sans); color: var(--stone); }
  .esign-spot.esign-mine { background: #FFE9D1; border: 2px solid var(--orange); color: var(--ink); font-weight: 600; }
  label.consent, :lang(zh) label.consent { display: flex; gap: 12px; align-items: flex-start; margin: 16px 0; text-transform: none; letter-spacing: 0; font-size: 14px; font-weight: 400; color: var(--charcoal); line-height: 1.5; }
  .consent input { flex: 0 0 auto; margin-top: 2px; }
  .zh-consent { display: block; margin-top: 6px; color: var(--stone); }
  canvas.sigpad { width: 100%; height: 170px; background: #fff; border: 1px solid #CFC8BE; border-radius: 3px; touch-action: none; display: block; }
  canvas.sigpad.small { height: 130px; max-width: 320px; }
  /* an uploaded document */
  .how { font-size: 14px; }
  .signbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--charcoal); color: var(--marble); padding: 10px 14px; border-radius: 4px; margin-bottom: 10px; border-bottom: 3px solid var(--orange); }
  .signbar.ok { border-bottom-color: var(--good); }
  .signbar .prog { font-size: 13px; font-weight: 600; letter-spacing: .04em; }
  .signbar .btn-secondary { border-color: var(--orange); background: var(--orange); color: var(--ink); }
  .pdf-wrap { background: #E4DFD8; border: 1px solid var(--travertine); border-radius: 4px; padding: 10px 10px 2px; margin-bottom: 16px; }
  .pdf-page { position: relative; background: #fff; margin: 0 auto; box-shadow: 0 1px 4px rgba(30,27,26,.22); width: 100%; }
  .pdf-page > canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }
  .pdf-num { text-align: center; font-size: 11px; color: var(--stone); letter-spacing: .08em; padding: 6px 0 10px; }
  .fld { position: absolute; box-sizing: border-box; border-radius: 2px; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 0; margin: 0; font-family: var(--sans); font-weight: 600; line-height: 1; }
  .fld.mine { border: 2px solid var(--orange); background: rgba(255,123,0,.16); color: var(--ink); }
  button.fld.mine { cursor: pointer; }
  .fld.mine.opt { border-style: dashed; }
  .fld.mine.done { border: 1px solid var(--good); background: rgba(47,107,63,.07); }
  .fld.mine.date, .fld.mine.name { border: 1px dashed var(--stone); background: rgba(250,248,245,.6); justify-content: flex-start; }
  .fld.mine.text.done, .fld.mine.name.done { justify-content: flex-start; }
  .fld.other { border: 1px dashed #8d8780; background: rgba(94,88,84,.10); }
  .fld img { max-width: 100%; max-height: 100%; display: block; }
  .fld .val { color: ${INK_BLUE}; font-weight: 500; white-space: nowrap; padding: 0 3px; }
  .fld .ask { white-space: nowrap; }
  .fld .tick { color: ${INK_BLUE}; font-weight: 700; }
  .fld.pulse { animation: pulse .5s ease 3; }
  @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(255,123,0,.45); } }
  .sheet-back { position: fixed; inset: 0; background: rgba(30,27,26,.62); z-index: 50; display: flex; align-items: flex-end; justify-content: center; }
  .sheet { background: var(--marble); width: min(560px, 100%); max-height: 92vh; overflow: auto; border-top: 4px solid var(--orange); border-radius: 6px 6px 0 0; padding: 20px 20px 24px; }
  @media (min-width: 640px) { .sheet-back { align-items: center; } .sheet { border-radius: 4px; } }
  .tabs { display: flex; gap: 0; margin: 0 0 10px; border-bottom: 1px solid var(--travertine); }
  .tab { background: none; border: 0; border-bottom: 3px solid transparent; padding: 10px 16px; font: 600 12px var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--stone); cursor: pointer; }
  .tab.on { color: var(--charcoal); border-bottom-color: var(--orange); }
  .typed-sig { min-height: 86px; display: flex; align-items: center; padding: 6px 12px; margin-top: 10px; background: #fff; border: 1px solid #CFC8BE; border-radius: 3px; color: ${INK_BLUE}; font: italic 40px "Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", "Lucida Handwriting", "KaiTi", "STKaiti", cursive; overflow: hidden; white-space: nowrap; }
  [hidden] { display: none !important; }
  :lang(zh) .tab, :lang(zh) .btn-quiet { letter-spacing: .04em; font-size: 13px; }
  @media (max-width: 720px) { .doc { padding: 18px 16px; } .pdf-wrap { padding: 6px 6px 0; margin-left: -8px; margin-right: -8px; } }
  @media (prefers-reduced-motion: reduce) { .fld.pulse { animation: none; outline: 3px solid var(--orange); } }
`;

// ── The staff pages ─────────────────────────────────────────
// Registered on the real app, after server.js has put the sign-in in front
// of everything under /admin. Any firm user may open them; what each one
// sees and may do is decided by the API above. Consultants have their own
// portal and do not come here.
function attachStaffPages(app) {
  const roles = require("./auth").requireRole("admin", "manager", "attorney", "paralegal", "viewer");
  const attr = v => String(v == null ? "" : v).replace(/[^A-Za-z0-9_:.@-]/g, "");
  const script = () => require("./client-script").clientScriptTag("esign-prepare.js");

  app.get("/admin/esign", roles, (req, res) => {
    try {
      const body = `
      <div style="padding:24px;max-width:1200px;">
        <h1 style="margin:0 0 4px 0;font-family:Cormorant Garamond,Georgia,serif;color:#2B2523;">Documents for Signature</h1>
        <div style="color:#5E5854;margin-bottom:18px;max-width:78ch;">Upload any document — a PDF, or a photo or scan — say who signs, mark where, and send it. Each signer gets a private link; when the last one signs, the signed copy is filed and emailed to everyone.</div>
        <div data-esign-docs data-client="${attr(req.query.client)}" data-case="${attr(req.query.case)}"></div>
      </div>
      ${script()}`;
      res.send(require("./hearing-notes").renderAdminChrome({ title: "Documents for Signature", body, activeItem: "esign" }));
    } catch (err) { res.status(500).send("E-signature page failed: " + err.message); }
  });

  app.get("/admin/esign/prepare/:id", roles, (req, res) => {
    try {
      const body = `
      <div style="padding:18px 20px 40px;">
        <div data-esign-prepare="${attr(req.params.id)}"></div>
      </div>
      ${script()}`;
      res.send(require("./hearing-notes").renderAdminChrome({ title: "Prepare for Signature", body, activeItem: "esign" }));
    } catch (err) { res.status(500).send("E-signature page failed: " + err.message); }
  });
}

module.exports = { attachStaffRoutes, attachPublicRoutes, attachStaffPages, baseUrl, STAFF_PREFIX };
