// ============================================================
//  case-autofill-page.js — read the file, then decide
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  The screen behind "Read the case file" on a civil, PI or
//  federal matter. Two ways in, one way out:
//
//      Read the Dropbox folder  ─┐
//                                ├─→  a list of fields, each with
//      Upload a document        ─┘    the phrase it came from  ─→  tick  ─→  written
//
//  Plain HTML forms, no script. notify-admin.js records why that
//  is the rule: these pages are template literals, and an
//  apostrophe inside an onclick reaches the browser as a syntax
//  error that kills every script on the page — client search was
//  down for five hours that way. A form cannot break like that,
//  and 'O'Brien' is a case name.
//
//  Two deliberate choices in how it asks:
//
//  · Ordinary fields arrive ticked, so a read that is simply
//    right is one click. Dates that drive the deadline chain
//    arrive UNTICKED and say so. Filling in a filed date
//    recomputes every CCP deadline under it, and that should
//    be somebody's decision, not the fifteenth checkbox they
//    did not uncheck.
//
//  · Fields the record already holds are not offered at all.
//    Where a document disagrees with one, it shows under
//    "Worth your eye" with both values and no checkbox: the
//    page will not choose between a person's entry and a
//    machine's reading. Whoever is right, it is an edit on the
//    case page.
//
//  Roles: the same four who can edit a matter by hand. Gating
//  this more tightly than the case page's own edit form would
//  only push a paralegal to type the value in without the quote
//  and without the record — which is the thing this exists to
//  stop.
//
//  The reading is case-autofill.js. This file only asks and shows.
// ============================================================

const autofill = require("./case-autofill");

const PAGE = "/admin/case-autofill";
const ROLES = ["admin", "manager", "attorney", "paralegal"];

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const nameOf = (u) => (u && (u.n || u.u || u.name || u.username)) || "the firm";

const when = (ts) => {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " PT";
};

const bytes = (n) => {
  const k = Number(n || 0);
  if (!k) return "";
  if (k < 1024) return `${k} B`;
  if (k < 1024 * 1024) return `${Math.round(k / 1024)} KB`;
  return `${(k / (1024 * 1024)).toFixed(1)} MB`;
};

// ── Pieces ──────────────────────────────────────────────────

function box(inner, { tint = "#FAF8F5", edge = "#E8E3DC" } = {}) {
  return `<div style="background:${tint}; border:1px solid ${edge}; border-radius:6px; padding:16px 18px; margin-bottom:18px;">${inner}</div>`;
}

function heading(text, sub) {
  return `
    <div style="margin-bottom:10px;">
      <div style="font-family:Cormorant Garamond,Georgia,serif; font-size:19px; color:#2B2523;">${esc(text)}</div>
      ${sub ? `<div style="font-size:13px; color:#5E5854; font-style:italic; margin-top:3px;">${esc(sub)}</div>` : ""}
    </div>`;
}

function button(label, { primary = true } = {}) {
  return `<button type="submit" style="background:${primary ? "#A34C00" : "#F3EFE9"}; color:${primary ? "#FFFFFF" : "#2B2523"}; border:1px solid ${primary ? "#A34C00" : "#E8E3DC"}; padding:9px 18px; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer;">${esc(label)}</button>`;
}

function warningList(warnings = []) {
  if (!warnings.length) return "";
  return box(`
    <div style="font-size:13px; color:#A34C00; font-weight:600; margin-bottom:6px;">What could not be read</div>
    <ul style="margin:0; padding-left:20px; font-size:13px; color:#5E5854;">
      ${warnings.map((w) => `<li style="margin-bottom:4px;">${esc(w)}</li>`).join("")}
    </ul>`, { tint: "#FFF4E8", edge: "#E8CFB4" });
}

// ── The proposal ────────────────────────────────────────────

function proposalRow(p) {
  const risky = p.drives_deadlines;
  return `
    <tr style="border-bottom:1px solid #E8E3DC; vertical-align:top;">
      <td style="padding:12px 10px; width:34px;">
        <input type="checkbox" name="field" value="${esc(p.field)}" ${risky ? "" : "checked"}
               id="f_${esc(p.field)}" style="width:17px; height:17px; cursor:pointer;">
      </td>
      <td style="padding:12px 10px;">
        <label for="f_${esc(p.field)}" style="cursor:pointer;">
          <div style="font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C;">${esc(p.label)}</div>
          <div style="font-size:16px; color:#2B2523; font-weight:600; margin-top:2px;">${esc(p.value)}</div>
        </label>
        ${risky ? `<div style="margin-top:5px; font-size:12px; color:#A34C00;">
            ◆ Filling this in recomputes the deadlines under it. Ticked only on purpose.
          </div>` : ""}
      </td>
      <td style="padding:12px 10px; font-size:13px; color:#5E5854; max-width:380px;">
        <div style="font-style:italic;">“${esc(p.quote)}”</div>
        <div style="font-size:12px; color:#8A827C; margin-top:4px;">${esc(p.source)}</div>
      </td>
    </tr>`;
}

function conflictRow(c) {
  return `
    <tr style="border-bottom:1px solid #E8E3DC; vertical-align:top;">
      <td style="padding:11px 10px;">
        <div style="font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C;">${esc(c.label)}</div>
      </td>
      <td style="padding:11px 10px; font-size:14px; color:#2B2523;">${esc(c.current)}</td>
      <td style="padding:11px 10px; font-size:14px; color:#A34C00; font-weight:600;">${esc(c.value)}</td>
      <td style="padding:11px 10px; font-size:13px; color:#5E5854;">
        <div style="font-style:italic;">“${esc(c.quote)}”</div>
        <div style="font-size:12px; color:#8A827C; margin-top:4px;">${esc(c.source)}</div>
      </td>
    </tr>`;
}

function renderRun({ run, matter, row, user }) {
  const proposals = run.proposals || [];
  const conflicts = run.conflicts || [];
  const docs = run.documents || [];
  const applied = run.applied || null;

  const docLine = docs.length
    ? `Read ${docs.length} document${docs.length === 1 ? "" : "s"}: ${docs.map((d) => esc(d.filename)).join(", ")}`
    : "No documents could be read.";

  const header = `
    <div style="margin-bottom:6px;">
      <a href="${esc(matter.href(row.id))}" style="color:#A34C00; text-decoration:none; font-size:14px;">← ${esc(matter.label)}: ${esc(row[matter.nameCol] || "#" + row.id)}</a>
    </div>
    <h1 style="margin:0 0 4px 0; font-family:Cormorant Garamond,Georgia,serif; color:#2B2523;">What the file says</h1>
    <div style="color:#5E5854; font-style:italic; margin-bottom:18px;">
      ${docLine} · ${run.source === "dropbox" ? "from the matter's Dropbox folder" : "from documents you uploaded"} · ${esc(when(run.created_at))}
    </div>`;

  // Built before anything returns, because a read that found ONLY conflicts
  // has a status of "empty" — and the conflicts are the whole point of it.
  // They used to be thrown away behind a "this read was empty" card.
  const conflictBlock = conflicts.length ? box(`
    ${heading("Worth your eye", "The record already has these, and the documents say something else. Nothing here is written by this page — if the document is right, change it on the matter yourself.")}
    <table style="width:100%; border-collapse:collapse; margin-top:4px;">
      <thead><tr style="text-align:left; color:#8A827C; font-size:11px; letter-spacing:.06em; text-transform:uppercase;">
        <th style="padding:6px 10px;">Field</th>
        <th style="padding:6px 10px;">On file</th>
        <th style="padding:6px 10px;">In the document</th>
        <th style="padding:6px 10px;">Where</th>
      </tr></thead>
      <tbody>${conflicts.map(conflictRow).join("")}</tbody>
    </table>`, { tint: "#FFF4E8", edge: "#E8CFB4" }) : "";

  const never = autofill.neverProposed(run.kind);
  const neverBlock = never.length ? `
    <details style="margin-top:18px;">
      <summary style="cursor:pointer; color:#5E5854; font-size:13px;">
        ${never.length} field${never.length === 1 ? "" : "s"} this never reads off a document
      </summary>
      <ul style="margin:10px 0 0; padding-left:20px; font-size:13px; color:#5E5854;">
        ${never.map((n) => `<li style="margin-bottom:6px;"><strong>${esc(n.label)}</strong> — ${esc(n.why)}</li>`).join("")}
      </ul>
    </details>` : "";

  const extras = conflictBlock + warningList(run.warnings || []) + neverBlock;

  if (applied) {
    const w = applied.fields || [];
    return header + box(`
      ${heading(`${w.length} field${w.length === 1 ? "" : "s"} written to the matter`,
        `Approved by ${applied_by(run)} · ${when(run.decided_at)}`)}
      <ul style="margin:8px 0 0; padding-left:20px; font-size:14px; color:#2B2523;">
        ${w.map((f) => `<li style="margin-bottom:5px;"><strong>${esc(f.label)}</strong>: ${esc(f.value)}
          <span style="color:#8A827C; font-size:12px;">— ${esc(f.source)}</span></li>`).join("")}
      </ul>
      ${(applied.skipped || []).length ? `<div style="margin-top:12px; font-size:13px; color:#A34C00;">
        Not written, because somebody had filled them in since the read: ${esc((applied.skipped || []).join("; "))}
      </div>` : ""}
      <div style="margin-top:16px;">
        <a href="${esc(matter.href(row.id))}" style="display:inline-block; background:#A34C00; color:#FFFFFF; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:14px; font-weight:600;">Back to the matter</a>
      </div>`, { tint: "#F2F6F2", edge: "#CFDFD0" }) + extras;
  }

  // Settled one way or the other: there is no decision left to take, but
  // whatever the read found is still worth showing.
  if (["discarded", "expired", "applying"].includes(run.status)) {
    return header + box(`
      ${heading(`This read was ${esc(run.status)}`, run.error ? String(run.error) : "")}
      <form method="POST" action="${PAGE}/read" style="margin-top:12px;">
        <input type="hidden" name="kind" value="${esc(run.kind)}">
        <input type="hidden" name="id" value="${row.id}">
        ${button("Read the file again")}
      </form>`) + extras;
  }

  const applyForm = proposals.length ? `
    <form method="POST" action="${PAGE}/apply">
      <input type="hidden" name="run" value="${run.id}">
      ${heading(`${proposals.length} field${proposals.length === 1 ? "" : "s"} the record does not have yet`,
        "Each one shows the phrase it came from. Untick anything that is not right — nothing is written until you press the button.")}
      <table style="width:100%; border-collapse:collapse; margin:4px 0 16px;">
        <thead><tr style="text-align:left; color:#8A827C; font-size:11px; letter-spacing:.06em; text-transform:uppercase;">
          <th style="padding:6px 10px;"></th>
          <th style="padding:6px 10px;">Field and what it read</th>
          <th style="padding:6px 10px;">Where it got it</th>
        </tr></thead>
        <tbody>${proposals.map(proposalRow).join("")}</tbody>
      </table>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        ${button("Write the ticked fields to the matter")}
        <span style="font-size:13px; color:#5E5854;">Only blank fields are written, and only the ones ticked.</span>
      </div>
    </form>
    <form method="POST" action="${PAGE}/discard" style="margin-top:14px;">
      <input type="hidden" name="run" value="${run.id}">
      ${button("Discard this read", { primary: false })}
    </form>` : `
    ${heading("Nothing to fill in", run.error
      ? String(run.error)
      : conflicts.length
        ? "Everything these documents state, the record already has — but some of it does not match. That is below."
        : "Either the record already holds everything these documents state, or they do not state it in a form worth copying.")}
    <div style="margin-top:12px;">
      <a href="${PAGE}?kind=${esc(run.kind)}&amp;id=${row.id}" style="display:inline-block; background:#F3EFE9; color:#2B2523; border:1px solid #E8E3DC; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:14px;">Try other documents</a>
    </div>`;

  void user;
  return header + box(applyForm) + extras;
}

function applied_by(run) {
  return run.decided_by || "unknown";
}

// ── The landing screen ──────────────────────────────────────

function renderStart({ matter, row, picked, recent, user, error }) {
  const files = (picked && picked.files) || [];
  const never = autofill.neverProposed(matter.key);

  const errorBlock = error ? box(
    `<div style="font-size:14px; color:#A34C00;"><strong>${esc(error)}</strong></div>`,
    { tint: "#FFF4E8", edge: "#E8CFB4" }) : "";

  const dropboxBlock = box(`
    ${heading("Read the matter's Dropbox folder",
      picked && picked.folder ? picked.folder : "No folder is linked to this matter yet.")}
    ${files.length ? `
      <div style="font-size:13px; color:#5E5854; margin-bottom:10px;">
        These ${files.length} would be read, chosen by what a document of that name tells you${picked.considered ? ` — out of ${picked.considered} in the folder` : ""}:
      </div>
      <ul style="margin:0 0 14px; padding-left:20px; font-size:14px; color:#2B2523;">
        ${files.map((f) => `<li style="margin-bottom:4px;">${esc(f.name)}
          <span style="color:#8A827C; font-size:12px;">${f.folder ? esc(f.folder) + " · " : ""}${esc(bytes(f.size))}</span></li>`).join("")}
      </ul>
      <form method="POST" action="${PAGE}/read">
        <input type="hidden" name="kind" value="${esc(matter.key)}">
        <input type="hidden" name="id" value="${row.id}">
        ${button("Read these")}
      </form>` : `
      <div style="font-size:13px; color:#A34C00;">${esc((picked && picked.note) || "Nothing in the folder worth reading.")}</div>`}`);

  const uploadBlock = box(`
    ${heading("Or read documents you upload",
      `Up to ${autofill.MAX_DOCS} at a time — ${matter.docKinds}. PDF, Word, text or spreadsheet.`)}
    <form method="POST" action="${PAGE}/upload" enctype="multipart/form-data">
      <input type="hidden" name="kind" value="${esc(matter.key)}">
      <input type="hidden" name="id" value="${row.id}">
      <input type="file" name="documents" multiple accept=".pdf,.docx,.txt,.md,.csv,.xlsx,.xls"
             style="display:block; margin-bottom:12px; font-size:14px;">
      ${button("Read them")}
      <div style="margin-top:8px; font-size:13px; color:#5E5854;">
        Uploading here reads the documents; it does not file them. Use the matter's Documents tab to put a file in the folder.
      </div>
    </form>`);

  const recentBlock = (recent || []).length ? box(`
    ${heading("Earlier reads of this matter")}
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <tbody>
        ${recent.map((r) => `
          <tr style="border-bottom:1px solid #E8E3DC;">
            <td style="padding:8px 10px; color:#8A827C; font-size:13px;">${esc(when(r.created_at))}</td>
            <td style="padding:8px 10px;">${esc(r.source === "dropbox" ? "Dropbox folder" : "upload")}</td>
            <td style="padding:8px 10px;">${esc(r.run_by || "—")}</td>
            <td style="padding:8px 10px;">${r.proposed} proposed</td>
            <td style="padding:8px 10px; color:${r.status === "applied" ? "#2F6B3F" : "#5E5854"};">${esc(r.status)}${r.decided_by ? ` by ${esc(r.decided_by)}` : ""}</td>
            <td style="padding:8px 10px; text-align:right;"><a href="${PAGE}?run=${r.id}" style="color:#A34C00; text-decoration:none;">open →</a></td>
          </tr>`).join("")}
      </tbody>
    </table>`) : "";

  const neverBlock = never.length ? box(`
    ${heading("What this does not read", "Typed in by hand, on purpose.")}
    <ul style="margin:0; padding-left:20px; font-size:13px; color:#5E5854;">
      ${never.map((n) => `<li style="margin-bottom:6px;"><strong>${esc(n.label)}</strong> — ${esc(n.why)}</li>`).join("")}
    </ul>`) : "";

  void user;
  return `
    <div style="margin-bottom:6px;">
      <a href="${esc(matter.href(row.id))}" style="color:#A34C00; text-decoration:none; font-size:14px;">← ${esc(matter.label)}: ${esc(row[matter.nameCol] || "#" + row.id)}</a>
    </div>
    <h1 style="margin:0 0 4px 0; font-family:Cormorant Garamond,Georgia,serif; color:#2B2523;">Read the case file</h1>
    <div style="color:#5E5854; font-style:italic; margin-bottom:20px;">
      Reads the documents and proposes the fields the record does not have yet. Nothing is written until you tick it.
    </div>
    ${errorBlock}${dropboxBlock}${uploadBlock}${recentBlock}${neverBlock}`;
}

// ── Chrome ──────────────────────────────────────────────────

function page(body, activeItem = null) {
  return require("./hearing-notes").renderAdminChrome({
    title: "Read the case file",
    activeItem,
    body: `<div style="padding:24px; max-width:1100px;">${body}</div>`,
  });
}

const ACTIVE = { civil: "civil-cases", pi: "pi-cases", federal: "federal" };

function fail(message) {
  return page(`
    <h1 style="margin:0 0 10px 0; font-family:Cormorant Garamond,Georgia,serif; color:#2B2523;">Read the case file</h1>
    ${box(`<div style="font-size:14px; color:#A34C00;"><strong>${esc(message)}</strong></div>`,
      { tint: "#FFF4E8", edge: "#E8CFB4" })}`);
}

// ── Routes ──────────────────────────────────────────────────

function mount(app, auth, upload) {
  app.use(PAGE, auth.requireRole(...ROLES));

  // The review screen (?run=) or the landing screen (?kind=&id=).
  app.get(PAGE, async (req, res) => {
    try {
      const q = req.query || {};
      if (q.run) {
        const run = await autofill.getRun(q.run);
        const matter = autofill.matterKind(run.kind);
        const row = await autofill.loadMatter(run.kind, run.case_id);
        return res.send(page(renderRun({ run, matter, row, user: req.user }), ACTIVE[run.kind]));
      }
      const matter = autofill.matterKind(q.kind);
      const row = await autofill.loadMatter(matter.key, q.id);
      const picked = await autofill.candidateFiles(matter.key, row.id).catch((e) => ({
        folder: null, files: [], note: `The folder could not be listed: ${e.message}`,
      }));
      const recent = await autofill.runsFor(matter.key, row.id).catch(() => []);
      res.send(page(renderStart({
        matter, row, picked, recent, user: req.user,
        error: q.error ? String(q.error).slice(0, 300) : null,
      }), ACTIVE[matter.key]));
    } catch (err) {
      console.error("[case-autofill page]:", err.message);
      res.status(400).send(fail(err.message));
    }
  });

  // Read the matter's own Dropbox folder.
  app.post(`${PAGE}/read`, async (req, res) => {
    const b = req.body || {};
    try {
      const run = await autofill.readFromDropbox(b.kind, b.id, { by: nameOf(req.user) });
      res.redirect(`${PAGE}?run=${run.id}`);
    } catch (err) {
      console.error("[case-autofill read]:", err.message);
      res.redirect(`${PAGE}?kind=${encodeURIComponent(b.kind || "")}&id=${encodeURIComponent(b.id || "")}&error=${encodeURIComponent(err.message)}`);
    }
  });

  // Read documents handed to it. The upload is read, not filed.
  app.post(`${PAGE}/upload`, upload.array("documents", autofill.MAX_DOCS), async (req, res) => {
    const b = req.body || {};
    try {
      const files = (req.files || []).map((f) => ({ buffer: f.buffer, filename: f.originalname }));
      if (!files.length) throw new Error("No documents were attached.");
      const run = await autofill.readDocuments(b.kind, b.id, files, {
        source: "upload", by: nameOf(req.user),
      });
      res.redirect(`${PAGE}?run=${run.id}`);
    } catch (err) {
      console.error("[case-autofill upload]:", err.message);
      res.redirect(`${PAGE}?kind=${encodeURIComponent(b.kind || "")}&id=${encodeURIComponent(b.id || "")}&error=${encodeURIComponent(err.message)}`);
    }
  });

  // Write the ticked fields.
  app.post(`${PAGE}/apply`, async (req, res) => {
    const b = req.body || {};
    const runId = b.run;
    try {
      // One checkbox arrives as a string, several as an array.
      const chosen = [].concat(b.field || []).filter(Boolean);
      await autofill.applyRun(runId, chosen, { by: nameOf(req.user) });
      res.redirect(`${PAGE}?run=${encodeURIComponent(runId)}`);
    } catch (err) {
      console.error("[case-autofill apply]:", err.message);
      try {
        const run = await autofill.getRun(runId);
        const matter = autofill.matterKind(run.kind);
        const row = await autofill.loadMatter(run.kind, run.case_id);
        return res.status(400).send(page(
          box(`<div style="font-size:14px; color:#A34C00;"><strong>${esc(err.message)}</strong></div>`,
            { tint: "#FFF4E8", edge: "#E8CFB4" }) +
          renderRun({ run, matter, row, user: req.user }), ACTIVE[run.kind]));
      } catch (e2) {
        return res.status(400).send(fail(err.message));
      }
    }
  });

  app.post(`${PAGE}/discard`, async (req, res) => {
    const b = req.body || {};
    try {
      const run = await autofill.getRun(b.run);
      await autofill.discardRun(b.run, { by: nameOf(req.user) });
      res.redirect(`${PAGE}?kind=${encodeURIComponent(run.kind)}&id=${run.case_id}`);
    } catch (err) {
      console.error("[case-autofill discard]:", err.message);
      res.status(400).send(fail(err.message));
    }
  });
}

/** The link a case page puts behind its button. */
function linkFor(kind, caseId) {
  return `${PAGE}?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(caseId)}`;
}

/** The button itself, so all three case pages say the same thing. */
function buttonFor(kind, caseId, { note = null } = {}) {
  return `
    <div style="margin-top:16px; padding:14px 16px; background:#FAF8F5; border:1px solid #E8E3DC; border-radius:6px;">
      <a href="${esc(linkFor(kind, caseId))}" style="display:inline-block; background:#A34C00; color:#FFFFFF; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:14px; font-weight:600;">
        ❏ Read the case file
      </a>
      <div style="margin-top:8px; font-size:13px; color:#5E5854;">
        ${esc(note || "Reads this matter's documents — from its Dropbox folder, or ones you upload — and proposes the details the record does not have yet. Nothing is written until you tick it.")}
      </div>
    </div>`;
}

module.exports = { PAGE, ROLES, mount, linkFor, buttonFor, renderRun, renderStart };
