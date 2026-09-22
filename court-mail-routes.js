// ============================================================
//  court-mail-routes.js — the Court Mail page and its API
// ------------------------------------------------------------
//  /admin/court-mail            what came in, what was done, what
//                               needs a person (assign, undo, re-read)
//  /admin/court-mail/api/*      the page's calls
//
//  Attorneys, paralegals and admins. Registered after the /admin auth
//  middleware in server.js, so req.user is always set here.
// ============================================================

function attach(app, auth) {
  const CM = () => require("./court-mail");
  const staff = auth.requireRole("admin", "attorney", "paralegal");
  const who = req => (req.user && (req.user.n || req.user.u)) || "staff";
  const fail = (res, e, code = 400) => res.status(code).json({ ok: false, error: e.message });
  const P = "/admin/court-mail/api";

  app.get("/admin/court-mail", staff, (req, res) => {
    try {
      const chrome = require("./hearing-notes");
      const body = `
        <div style="padding:24px;max-width:1200px;">
          <h1 style="margin:0 0 4px 0;font-family:Cinzel,serif;color:#3E2818;">📨 Court Mail</h1>
          <div style="color:#7B5330;font-style:italic;margin-bottom:16px;">Court, EOIR and USCIS emails forwarded to the firm's court mailbox. Each one is read, matched to a case (by case number) or a client (by A-number), filed to Dropbox, and its hearings and deadlines added — marked "verify". Anything it could not match waits here for you.</div>
          <div data-court-mail></div>
        </div>
        ${require("./client-script").clientScriptTag("court-mail-page.js")}`;
      res.send(chrome.renderAdminChrome({ title: "Court Mail", body, activeItem: "court-mail" }));
    } catch (e) { res.status(500).send("Court Mail failed: " + e.message); }
  });

  app.get(`${P}/status`, staff, async (req, res) => {
    try { res.json({ ok: true, ...(await CM().status()) }); } catch (e) { fail(res, e, 500); }
  });
  app.get(`${P}/list`, staff, async (req, res) => {
    try { res.json({ ok: true, mail: await CM().list({ status: req.query.status || null }) }); } catch (e) { fail(res, e, 500); }
  });
  // Starts a check and answers at once: reading a batch can take minutes,
  // longer than a web request should wait. The page refreshes itself.
  app.post(`${P}/check`, staff, async (req, res) => {
    try {
      CM().runOnce().catch(e => console.warn("[court-mail] check:", e.message));
      res.json({ ok: true, started: true });
    } catch (e) { fail(res, e, 500); }
  });
  // Find a matter or client to assign an unmatched email to.
  app.get(`${P}/search`, staff, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json({ ok: true, matters: [], clients: [] });
      let matters = [];
      try { matters = await require("./civil-snapshot").findMatters(q, 8); } catch (e) { /* none */ }
      const digits = q.replace(/\D/g, "");
      const all = await require("./client-profiles").aggregateClients();
      const clients = all.filter(c => (c.client_name && c.client_name.toLowerCase().includes(q.toLowerCase())) ||
        (digits.length >= 5 && String(c.a_number || "").replace(/\D/g, "").includes(digits)))
        .slice(0, 8).map(c => ({ key: c.key, name: c.client_name, a_number: c.a_number }));
      res.json({ ok: true, matters, clients });
    } catch (e) { fail(res, e, 500); }
  });
  app.post(`${P}/:id/assign`, staff, async (req, res) => {
    try {
      const b = req.body || {};
      const target = b.case_id ? { caseId: Number(b.case_id), label: b.label || null }
        : b.client_key ? { clientKey: String(b.client_key), label: b.label || null } : null;
      if (!target) return res.status(400).json({ ok: false, error: "Pick a case or a client" });
      res.json({ ok: true, mail: await CM().processMail(req.params.id, { target, by: who(req) }) });
    } catch (e) { fail(res, e); }
  });
  app.post(`${P}/:id/reread`, staff, async (req, res) => {
    try { res.json({ ok: true, mail: await CM().processMail(req.params.id, { reread: true, by: who(req), notify: false }) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/:id/undo/:index`, staff, async (req, res) => {
    try { res.json({ ok: true, action: await CM().undoAction(req.params.id, req.params.index, { by: who(req) }) }); } catch (e) { fail(res, e); }
  });
  app.post(`${P}/:id/handled`, staff, async (req, res) => {
    try { await CM().markHandled(req.params.id, { by: who(req), note: (req.body || {}).note || null }); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.get(`${P}/:id/eml`, staff, async (req, res) => {
    try {
      await CM().initTables();
      const r = await require("./db").query(`SELECT subject, raw FROM court_mail WHERE id = $1`, [Number(req.params.id)]);
      if (!r.rows[0]) return res.status(404).send("Not found");
      res.setHeader("Content-Type", "message/rfc822");
      res.setHeader("Content-Disposition", `attachment; filename="${String(r.rows[0].subject || "court-email").replace(/[^\w .()-]+/g, "_").slice(0, 80)}.eml"`);
      res.send(r.rows[0].raw);
    } catch (e) { res.status(500).send(e.message); }
  });
}

module.exports = { attach };
