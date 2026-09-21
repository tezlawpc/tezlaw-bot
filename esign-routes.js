// ============================================================
//  esign-routes.js — the staff API for templates and signing,
//  and the public pages a signer uses.
// ------------------------------------------------------------
//  Staff routes are registered through the civil mirror, so each
//  exists at /api/staff/civil/esign/* (the app, bearer token) AND
//  /admin/civil/api/esign/* (the web admin, cookie).
//
//  Public routes (no login — the token in the link IS the access):
//    GET  /sign/e/:token                   the signing page
//    GET  /api/public/esign/:token         what the page shows
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
function canApprove(req, res, next) {
  if (req.user && ["admin", "attorney"].includes(req.user.r)) return next();
  return res.status(403).json({ ok: false, error: "Only an attorney or admin can activate or archive a template" });
}

function sendFile(res, f) {
  res.setHeader("Content-Type", f.type);
  res.setHeader("Content-Disposition", `attachment; filename="${String(f.name).replace(/[^\w .()-]+/g, "_")}"`);
  res.send(f.buffer);
}

const fail = (res, e, code = 400) => res.status(e.status || code).json({ ok: false, error: e.message });

function attachStaffRoutes(app, { requireBearer, requireFirmUser }) {
  const T = () => require("./esign-templates");
  const E = () => require("./esign");
  const A = [requireBearer, requireFirmUser];
  const P = "/api/staff/civil/esign";

  app.get(`${P}/meta`, ...A, (req, res) => {
    const t = T();
    res.json({ ok: true, sources: t.SOURCES, types: t.TYPES, categories: t.CATEGORIES });
  });

  // ── Templates ──
  app.get(`${P}/templates`, ...A, async (req, res) => {
    try { res.json({ ok: true, templates: await T().listTemplates({ includeArchived: req.query.all === "1" }) }); }
    catch (e) { fail(res, e, 500); }
  });
  app.post(`${P}/templates`, ...A, canWrite, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "Choose a document to upload" });
      res.json({ ok: true, template: await T().createFromUpload(req.file.buffer, req.file.originalname, { by: who(req) }) });
    } catch (e) { console.warn("[esign] template from upload:", e.message); fail(res, e); }
  });
  app.get(`${P}/templates/:id`, ...A, async (req, res) => {
    try { res.json({ ok: true, template: await T().getTemplate(req.params.id) }); } catch (e) { fail(res, e, 404); }
  });
  app.get(`${P}/templates/:id/preview`, ...A, async (req, res) => {
    try { res.json({ ok: true, html: await T().previewHtml(req.params.id) }); } catch (e) { fail(res, e); }
  });
  app.get(`${P}/templates/:id/download`, ...A, async (req, res) => {
    try {
      const t = await T().getTemplate(req.params.id, { withDocx: true });
      sendFile(res, { buffer: t.docx, name: `${t.name} (template).docx`, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    } catch (e) { fail(res, e, 404); }
  });
  app.patch(`${P}/templates/:id`, ...A, canWrite, async (req, res) => {
    try { res.json({ ok: true, template: await T().updateTemplate(req.params.id, req.body || {}, { by: who(req) }) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/templates/:id/replace`, ...A, canWrite, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: "Choose the edited .docx" });
      res.json({ ok: true, template: await T().replaceDocx(req.params.id, req.file.buffer, req.file.originalname) });
    } catch (e) { fail(res, e); }
  });
  app.post(`${P}/templates/:id/status`, ...A, canApprove, async (req, res) => {
    try { res.json({ ok: true, template: await T().setStatus(req.params.id, String((req.body || {}).status || "")) }); } catch (e) { fail(res, e); }
  });

  // ── Preparing and sending ──
  app.get(`${P}/prefill`, ...A, async (req, res) => {
    try { res.json({ ok: true, ...(await E().prefill(req.query.template_id, req.query.case_id || null, { user: req.user })) }); }
    catch (e) { fail(res, e); }
  });
  app.post(`${P}/packets`, ...A, canWrite, async (req, res) => {
    try {
      const b = req.body || {};
      let packet = await E().createPacket({
        templateId: b.template_id, caseId: b.case_id || null, title: b.title, values: b.values || {},
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
    try { res.json({ ok: true, packets: await E().listPackets({ caseId: req.query.case_id || null }) }); } catch (e) { fail(res, e, 500); }
  });
  app.get(`${P}/packets/:id`, ...A, async (req, res) => {
    try { res.json({ ok: true, packet: await E().getPacket(req.params.id) }); } catch (e) { fail(res, e, 404); }
  });
  app.post(`${P}/packets/:id/send`, ...A, canWrite, async (req, res) => {
    try { res.json({ ok: true, ...(await E().sendPacket(req.params.id, { baseUrl: baseUrl(req), user: req.user })) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/packets/:id/cancel`, ...A, canWrite, async (req, res) => {
    try { res.json({ ok: true, packet: await E().cancelPacket(req.params.id, { user: req.user, reason: (req.body || {}).reason }) }); } catch (e) { fail(res, e); }
  });
  // Links for signing in person (hand the tablet over in the office).
  app.get(`${P}/packets/:id/links`, ...A, canWrite, async (req, res) => {
    try {
      const p = await E().getPacket(req.params.id, { includeTokens: true });
      res.json({ ok: true, links: p.signers.map(s => ({ signer_id: s.id, name: s.name, role: s.role, status: s.status, url: E().signUrl(baseUrl(req), s.token) })) });
    } catch (e) { fail(res, e, 404); }
  });
  // File a fully signed document again, after Dropbox or the PDF step failed.
  app.post(`${P}/packets/:id/refile`, ...A, canWrite, async (req, res) => {
    try { res.json({ ok: true, packet: await E().refinalize(req.params.id) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/signers/:id/remind`, ...A, canWrite, async (req, res) => {
    try { res.json({ ok: true, delivered: await E().remind(req.params.id, { baseUrl: baseUrl(req) }) }); } catch (e) { fail(res, e); }
  });
  app.get(`${P}/packets/:id/download/:which`, ...A, async (req, res) => {
    try { sendFile(res, await E().download(req.params.id, req.params.which)); } catch (e) { fail(res, e, 404); }
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
        // No baseUrl: the next signer's link uses the address fixed when
        // staff sent it, never one taken from this (public) request.
        ip: ipOf(req), userAgent: req.get("user-agent"),
      });
      res.json({ ok: true, completed: out.completed });
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Your signature could not be saved. Please try again." }); }
  });
  app.post("/api/public/esign/:token/decline", async (req, res) => {
    try { res.json(await E().decline(req.params.token, { reason: (req.body || {}).reason, ip: ipOf(req) })); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Could not record that. Please call 626-678-8677." }); }
  });

  // The page itself. Everything it does comes from /static/esign-sign.js.
  app.get("/sign/e/:token", (req, res) => {
    const token = String(req.params.token || "").replace(/[^A-Za-z0-9_-]/g, "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Review and sign — Tez Law P.C.</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#F5EBD3;color:#3E2818;font-family:Georgia,"Times New Roman",serif;line-height:1.5}
  header{background:#3E2818;color:#FBF3DE;padding:14px 20px;border-bottom:3px solid #B8891E}
  header b{font-family:Cinzel,Georgia,serif;letter-spacing:1.5px}
  main{max-width:860px;margin:0 auto;padding:18px 14px 60px}
  .card{background:#FBF3DE;border:1px solid #D4C4A0;border-radius:8px;padding:16px 18px;margin-bottom:16px}
  .doc{background:#fff;border:1px solid #D4C4A0;border-radius:6px;padding:28px 32px;max-height:62vh;overflow:auto;font-size:15px}
  .doc img{max-width:220px}
  .esign-spot{background:#F3E3B0;border:1px dashed #B8891E;border-radius:4px;padding:1px 6px;font-family:Arial,sans-serif;font-size:12px;color:#7B5330}
  .esign-spot.esign-mine{background:#FFE08A;border:2px solid #F07800;color:#3E2818;font-weight:bold}
  label{display:block;margin:10px 0 4px;font-size:14px}
  input[type=text]{width:100%;padding:10px 12px;font-size:16px;border:1px solid #D4C4A0;border-radius:6px}
  canvas{width:100%;height:170px;background:#fff;border:1px solid #D4C4A0;border-radius:6px;touch-action:none;display:block}
  button{font-size:15px;padding:11px 20px;border-radius:6px;cursor:pointer;font-family:inherit}
  .primary{background:#5A3B22;color:#FBF3DE;border:1px solid #B8891E}
  .primary:disabled{opacity:.5;cursor:not-allowed}
  .quiet{background:none;border:1px solid #D4C4A0;color:#7B5330}
  .muted{color:#7B5330;font-size:13px}
  .err{color:#A02818;margin-top:8px}
</style></head>
<body><header><b>TEZ LAW P.C.</b> &nbsp;·&nbsp; secure document signing</header>
<main id="esign" data-token="${token}"><div class="card">Loading the document…</div></main>
${require("./client-script").clientScriptTag("esign-sign.js")}
</body></html>`);
  });
}

module.exports = { attachStaffRoutes, attachPublicRoutes, baseUrl };
