// ============================================================
//  transcripts-routes.js — reading and correcting saved transcripts
// ------------------------------------------------------------
//  /admin/transcripts             every recording, newest first, search
//  /admin/transcripts/:id         one recording, speaker by speaker
//  /admin/transcripts/api/*       the page's calls (and the panels on the
//                                 client profile and the hearing notes)
//
//  Admins, managers, attorneys and paralegals. Registered after the
//  /admin auth middleware in server.js, so req.user is set here.
// ============================================================

function attach(app, auth) {
  const T = () => require("./transcripts");
  const staff = auth.requireRole("admin", "manager", "attorney", "paralegal");
  const adminOnly = auth.requireRole("admin");
  // Paralegals read; changing names, titles or the client is for attorneys.
  const editors = auth.requireRole("admin", "manager", "attorney");
  const fail = (res, e, code = 400) => res.status(code).json({ ok: false, error: e.message });
  const P = "/admin/transcripts/api";
  const who = req => (req.user && (req.user.n || req.user.u)) || null;

  function page(res, title, inner) {
    const chrome = require("./hearing-notes");
    const body = `
      <div style="padding:24px;max-width:1100px;">
        ${inner}
      </div>
      ${require("./client-script").clientScriptTag("transcripts-page.js")}`;
    res.send(chrome.renderAdminChrome({ title, body, activeItem: "transcripts" }));
  }

  app.get("/admin/transcripts", staff, (req, res) => {
    try {
      page(res, "Transcripts", `
        <h1 style="margin:0 0 4px 0;font-family:Cinzel,serif;color:#3E2818;">🎙️ Transcripts</h1>
        <div style="color:#7B5330;font-style:italic;margin-bottom:16px;">Every voice dictation and hearing recording, saved when it is transcribed — whether or not it was applied to a note. Speakers are separated automatically and named by Zara; correct a name on the transcript and it changes everywhere.</div>
        <div data-transcripts="list"></div>`);
    } catch (e) { res.status(500).send("Transcripts failed: " + e.message); }
  });

  app.get("/admin/transcripts/:id(\\d+)", staff, (req, res) => {
    try {
      page(res, "Transcript", `
        <div style="margin-bottom:10px;"><a href="/admin/transcripts" style="color:#7B5330;">← All transcripts</a></div>
        <div data-transcripts="view" data-id="${Number(req.params.id)}"></div>`);
    } catch (e) { res.status(500).send("Transcript failed: " + e.message); }
  });

  app.get(`${P}/list`, staff, async (req, res) => {
    try { res.json({ ok: true, transcripts: await T().search({ q: req.query.q || "", unassigned: req.query.unassigned === "1" }) }); }
    catch (e) { fail(res, e, 500); }
  });

  app.get(`${P}/for-client/:key`, staff, async (req, res) => {
    try {
      const key = String(req.params.key);
      const c = await require("./client-profiles").getClientByKey(key).catch(() => null);
      res.json({ ok: true, transcripts: await T().listForClient({ key, clientName: c && c.client_name, aNumber: c && c.a_number }) });
    } catch (e) { fail(res, e, 500); }
  });

  app.get(`${P}/for-note/:type/:id(\\d+)`, staff, async (req, res) => {
    try {
      const type = req.params.type === "individual" ? "individual" : "master";
      res.json({ ok: true, transcripts: await T().listForNote(type, req.params.id) });
    } catch (e) { fail(res, e, 500); }
  });

  // Clients to assign an unassigned recording to.
  app.get(`${P}/clients`, staff, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (q.length < 2) return res.json({ ok: true, clients: [] });
      const found = await require("./client-profiles").searchClients(q, 10);
      const clients = found.map(c => ({ key: c.key, name: c.client_name, a_number: c.a_number }));
      res.json({ ok: true, clients });
    } catch (e) { fail(res, e, 500); }
  });

  app.get(`${P}/:id(\\d+)`, staff, async (req, res) => {
    try {
      const t = await T().get(req.params.id);
      if (!t) return res.status(404).json({ ok: false, error: "Not found" });
      res.json({ ok: true, transcript: T().full(t), can_delete: !!(req.user && req.user.r === "admin"),
        can_edit: !!(req.user && ["admin", "manager", "attorney"].includes(req.user.r)) });
    } catch (e) { fail(res, e, 500); }
  });

  app.post(`${P}/:id(\\d+)/speakers`, editors, async (req, res) => {
    try {
      const t = await T().setSpeakers(req.params.id, (req.body || {}).speakers || {});
      if (t.dropbox_path) T().fileSoon(t.id, 1500);
      res.json({ ok: true, transcript: T().full(t) });
    } catch (e) { fail(res, e); }
  });

  // Zara names the speakers again (only the ones nobody named, unless all=1).
  app.post(`${P}/:id(\\d+)/name-speakers`, editors, async (req, res) => {
    try {
      const t = await T().nameSpeakers(req.params.id, { recordedBy: who(req), force: (req.body || {}).all === true });
      if (!t) return res.status(404).json({ ok: false, error: "Not found" });
      if (t.dropbox_path) T().fileSoon(t.id, 1500);
      res.json({ ok: true, transcript: T().full(t) });
    } catch (e) { fail(res, e); }
  });

  app.post(`${P}/:id(\\d+)/title`, editors, async (req, res) => {
    try { res.json({ ok: true, transcript: T().full(await T().setTitle(req.params.id, (req.body || {}).title)) }); }
    catch (e) { fail(res, e); }
  });

  app.post(`${P}/:id(\\d+)/client`, editors, async (req, res) => {
    try {
      const t = await T().assignClient(req.params.id, (req.body || {}).client_key);
      T().fileSoon(t.id, 1500);
      res.json({ ok: true, transcript: T().full(t), note: t.dropbox_error || null });
    } catch (e) { fail(res, e); }
  });

  app.post(`${P}/:id(\\d+)/dropbox`, editors, async (req, res) => {
    try { res.json({ ok: true, path: await T().saveToDropbox(req.params.id) }); }
    catch (e) { fail(res, e); }
  });

  // Apply on a hearing note links the recorder's own transcript to it.
  // No role gate beyond being signed in (whoever may dictate may apply),
  // but only one's own recording, and only one not yet on a note.
  app.post(`${P}/:id(\\d+)/link`, async (req, res) => {
    try {
      const b = req.body || {};
      const type = b.note_type === "individual" ? "individual" : b.note_type === "master" ? "master" : null;
      const noteId = parseInt(b.note_id, 10);
      if (!type || !(noteId > 0)) return res.status(400).json({ ok: false, error: "note_type and note_id required" });
      const done = await T().linkToNote([req.params.id], { noteType: type, noteId, byUid: req.user ? req.user.uid : "none" });
      res.json({ ok: true, linked: done.length > 0 });
    } catch (e) { fail(res, e); }
  });

  app.get(`${P}/:id(\\d+)/download.:fmt(docx|txt)`, staff, async (req, res) => {
    try {
      const t = await T().get(req.params.id);
      if (!t) return res.status(404).send("Not found");
      const name = T().fileName(t).replace(/\.docx$/, "");
      const ascii = name.replace(/[^\w .()-]+/g, "_");
      if (req.params.fmt === "docx") {
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        res.setHeader("Content-Disposition", `attachment; filename="${ascii}.docx"`);
        return res.send(T().toDocx(t));
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${ascii}.txt"`);
      res.send(`${t.title || "Transcript"}\n${t.client_name ? "Client: " + t.client_name + (t.a_number ? "  A# " + t.a_number : "") + "\n" : ""}\n` + T().toText(t, { times: true }) + "\n");
    } catch (e) { res.status(500).send(e.message); }
  });

  app.delete(`${P}/:id(\\d+)`, adminOnly, async (req, res) => {
    try {
      const ok = await T().remove(req.params.id);
      try {
        const audit = require("./audit-log");
        await audit.log({ req, action: "transcript.deleted", target_type: "transcript", target_id: Number(req.params.id) });
      } catch (e) { /* audit is best effort */ }
      res.json({ ok });
    } catch (e) { fail(res, e, 500); }
  });
}

module.exports = { attach };
