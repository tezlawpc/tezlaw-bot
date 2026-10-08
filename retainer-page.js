// ============================================================
//  retainer-page.js — drafting a fee agreement, and who sees it
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  "tara allows enter name, scope of the work (AI generated
//   after minimal info), fee then it will generate the
//   agreement, after view all good can sent out for signature."
//
//  Four screens, one draft:
//    /admin/retainer              the drafts you have made
//    /admin/retainer/new          the form
//    /admin/retainer/:id          the agreement, as the client will read it
//    /admin/retainer/:id/send     hand it to the e-signature packet
//
//  WHO SEES WHAT. "each users have its own memory to their
//  history of e sign and retainer agreements." An admin or a
//  manager sees every draft; everyone else sees the ones they
//  made. The scoping is in SQL, not in the page, so a draft
//  somebody else made cannot be reached by guessing its id.
//
//  Plain forms, no script — notify-admin.js's rule. A page that
//  sets fee terms is not one to have quietly stop working
//  because an apostrophe landed in an onclick.
// ============================================================

const R = require("./retainer");
const DOC = require("./retainer-doc");

const db = () => require("./db");

const PAGE = "/admin/retainer";
const ROLES = ["admin", "manager", "attorney"];
const ALL_SEEING = ["admin", "manager"];

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const uidOf = (u) => (u && (u.uid || u.id)) || null;
const nameOf = (u) => (u && (u.n || u.u || u.name || u.username)) || "the firm";
const seesAll = (u) => !!u && ALL_SEEING.includes(u.r);

const when = (ts) => ts
  ? new Date(ts).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "short",
      day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT"
  : "—";

// ── Storage ──────────────────────────────────────────────────

async function initTable() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS retainer_drafts (
      id              SERIAL PRIMARY KEY,
      client_key      TEXT,
      client_name     TEXT NOT NULL,
      matter_type     TEXT,
      structure       TEXT,
      terms           JSONB NOT NULL,
      status          TEXT DEFAULT 'draft',
      esign_packet_id INTEGER,
      created_by      TEXT,
      created_by_uid  INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db().query(
    `CREATE INDEX IF NOT EXISTS idx_retainer_drafts_mine ON retainer_drafts (created_by_uid, created_at DESC)`);
}

// Every read goes through this, so a scoping rule cannot be
// forgotten at one call site: the WHERE is built here or nowhere.
function scope(user, params = []) {
  if (seesAll(user)) return { where: "", params };
  const uid = uidOf(user);
  if (!uid) return { where: "WHERE FALSE", params };     // unknown user sees nothing, never everything
  params.push(uid);
  return { where: `WHERE created_by_uid = $${params.length}`, params };
}

async function listDrafts(user, limit = 40) {
  await initTable();
  const { where, params } = scope(user);
  params.push(Math.min(200, limit));
  const r = await db().query(
    `SELECT id, client_name, matter_type, structure, status, created_by, created_at,
            terms->>'total_fee' AS total_fee, (terms->>'bilingual')::boolean AS bilingual
       FROM retainer_drafts ${where}
      ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

async function getDraft(user, id) {
  await initTable();
  const params = [parseInt(id, 10) || 0];
  const { where, params: p } = scope(user, params);
  const r = await db().query(
    `SELECT * FROM retainer_drafts ${where ? where + " AND" : "WHERE"} id = $1 LIMIT 1`, p);
  return r.rows[0] || null;
}

async function saveDraft(user, terms) {
  await initTable();
  const r = await db().query(
    `INSERT INTO retainer_drafts
       (client_key, client_name, matter_type, structure, terms, created_by, created_by_uid)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
    [terms.client_key || null, terms.client_name, terms.matter_type,
     terms.structure, JSON.stringify(terms), nameOf(user), uidOf(user)]);
  return r.rows[0].id;
}

/** Client names already in the system, for the picker. */
async function knownClients() {
  const out = new Map();
  const sources = [
    `SELECT name AS n, NULL::text AS k FROM clients WHERE name IS NOT NULL`,
    `SELECT client_name AS n, client_key AS k FROM pi_cases WHERE client_name IS NOT NULL`,
    `SELECT client_name AS n, client_key AS k FROM federal_matters WHERE client_name IS NOT NULL`,
    `SELECT case_name AS n, client_key AS k FROM civil_cases WHERE case_name IS NOT NULL`,
  ];
  for (const sql of sources) {
    try {
      const r = await db().query(sql);
      for (const row of r.rows) if (row.n && !out.has(row.n)) out.set(row.n, row.k || "");
    } catch { /* a practice area that is not switched on has no clients */ }
  }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 2000);
}

// ── The form ─────────────────────────────────────────────────

function renderForm({ user, clients = [], prefill = {}, problems = [] } = {}) {
  const { renderAdminChrome } = require("./hearing-notes");
  const p = prefill;

  const sel = (v, want) => (String(v) === String(want) ? " selected" : "");
  const presets = Object.entries(R.SCOPE_PRESETS)
    .map(([k, lines]) => `<optgroup label="${esc(R.MATTER_LABELS[k] || k)}">${
      lines.map((l) => `<option value="${esc(l)}">${esc(l.slice(0, 90))}${l.length > 90 ? "…" : ""}</option>`).join("")
    }</optgroup>`).join("");

  const body = `
    <div class="page-header"><h1>New fee agreement</h1></div>

    ${problems.length ? `
      <div style="margin:0 0 22px; padding:14px 18px; background:#FFF4E8; border-left:4px solid #FF7B00;">
        <strong style="color:#A34C00;">This is not ready to go out.</strong>
        <ul style="margin:8px 0 0; padding-left:20px; font-size:14px;">
          ${problems.map((x) => `<li>${esc(x)}</li>`).join("")}
        </ul>
      </div>` : ""}

    <form method="POST" action="${PAGE}/new" style="background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:24px;">

      <h2 style="font-size:15px; margin:0 0 14px; color:#2B2523;">The client and the matter</h2>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:22px;">
        <div>
          <label for="r-client" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:5px;">Client</label>
          <input id="r-client" name="client_name" list="r-clients" required maxlength="200" value="${esc(p.client_name || "")}"
            placeholder="Pick from the list, or type a new client"
            style="width:100%; padding:10px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px;">
          <datalist id="r-clients">${clients.map(([n]) => `<option value="${esc(n)}">`).join("")}</datalist>
          <div style="font-size:12px; color:#5E5854; margin-top:4px;">${clients.length.toLocaleString()} clients on file. Typing a name that is not on the list creates the agreement for a new client.</div>
        </div>
        <div>
          <label for="r-matter" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:5px;">Matter type</label>
          <select id="r-matter" name="matter_type" required style="width:100%; padding:10px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px;">
            <option value="">Choose…</option>
            ${Object.entries(R.MATTER_LABELS).map(([k, l]) => `<option value="${k}"${sel(p.matter_type, k)}>${esc(l)}</option>`).join("")}
          </select>
        </div>
      </div>

      <h2 style="font-size:15px; margin:0 0 6px; color:#2B2523;">Scope of work</h2>
      <p style="font-size:13px; color:#5E5854; margin:0 0 10px;">
        One item per line. § 6148(a)(2) requires the general nature of the services to be stated, so this is what
        the agreement covers and nothing else. Pick a starting line below and edit it.
      </p>
      <select onchange="" name="preset_ignored" style="width:100%; padding:9px; border:1px solid #E8E3DC; border-radius:6px; font-size:13px; margin-bottom:8px;">
        <option value="">— common scope lines, for copying —</option>
        ${presets}
      </select>
      <textarea id="r-scope" name="scope" rows="5" required maxlength="4000"
        style="width:100%; padding:11px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px; font-family:inherit; margin-bottom:22px;"
        placeholder="File and attend a bond redetermination hearing&#10;File a petition for writ of habeas corpus in the District Court">${esc(p.scope || "")}</textarea>

      <h2 style="font-size:15px; margin:0 0 14px; color:#2B2523;">Fee</h2>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; margin-bottom:16px;">
        <div>
          <label for="r-structure" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:5px;">Structure</label>
          <select id="r-structure" name="structure" required style="width:100%; padding:10px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px;">
            <option value="">Choose…</option>
            <option value="flat"${sel(p.structure, "flat")}>Flat fee</option>
            <option value="hourly"${sel(p.structure, "hourly")}>Hourly</option>
            <option value="contingency"${sel(p.structure, "contingency")}>Contingency</option>
            <option value="hybrid"${sel(p.structure, "hybrid")}>Flat fee, hourly outside the scope</option>
          </select>
        </div>
        <div>
          <label for="r-fee" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:5px;">Flat fee / deposit</label>
          <input id="r-fee" name="total_fee" type="number" min="0" step="50" value="${esc(p.total_fee || "")}"
            style="width:100%; padding:10px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px;">
        </div>
        <div>
          <label for="r-pct" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:5px;">Contingency %</label>
          <input id="r-pct" name="contingency_pct" type="number" min="0" max="50" step="1" value="${esc(p.contingency_pct || "")}"
            style="width:100%; padding:10px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px;">
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <div style="font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:6px;">Who bills by the hour on this matter</div>
        ${R.RATES.map((t) => `
          <label style="display:inline-flex; align-items:center; gap:7px; margin:0 18px 8px 0; font-size:14px;">
            <input type="checkbox" name="timekeepers" value="${esc(t.name)}">
            ${esc(t.name)} · ${R.money(t.rate)}/hr
          </label>`).join("")}
      </div>

      <div style="padding:14px 16px; background:#FAF8F5; border:1px solid #E8E3DC; border-radius:6px; margin-bottom:16px;">
        <label style="display:flex; gap:9px; align-items:flex-start; font-size:14px;">
          <input type="checkbox" name="operating_account_consent" value="1" style="margin-top:3px;">
          <span>The client agrees the flat fee may go into the firm's <strong>operating account</strong> rather than trust.
            <span style="display:block; color:#5E5854; font-size:13px; margin-top:3px;">
              Rule 1.15(b) requires this to be disclosed and, above $1,000, agreed in the signed writing. Leave it
              unticked and the agreement says the fee is held in trust until earned.
            </span></span>
        </label>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:22px;">
        <div>
          <label for="r-costs" style="display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#8A827C; margin-bottom:5px;">Costs, on a contingency</label>
          <select id="r-costs" name="costs_borne_by" style="width:100%; padding:10px; border:1px solid #E8E3DC; border-radius:6px; font-size:14px;">
            <option value="">—</option>
            <option value="firm_then_reimbursed"${sel(p.costs_borne_by, "firm_then_reimbursed")}>Firm advances, reimbursed after the fee</option>
            <option value="off_the_top"${sel(p.costs_borne_by, "off_the_top")}>Firm advances, deducted before the fee</option>
            <option value="client"${sel(p.costs_borne_by, "client")}>Client pays as incurred</option>
          </select>
        </div>
        <div style="align-self:end;">
          <label style="display:inline-flex; gap:7px; align-items:center; font-size:14px; margin-right:18px;">
            <input type="checkbox" name="micra" value="1"> Claim against a health care provider (§ 6146)
          </label>
        </div>
      </div>

      <h2 style="font-size:15px; margin:0 0 14px; color:#2B2523;">Language and history</h2>
      <label style="display:flex; gap:9px; align-items:flex-start; font-size:14px; margin-bottom:12px;">
        <input type="checkbox" name="bilingual" value="1" style="margin-top:3px;">
        <span>English and Chinese
          <span style="display:block; color:#5E5854; font-size:13px; margin-top:3px;">
            Four clauses have no Chinese yet, so a bilingual draft will be held back until a lawyer writes it.
            Civ. Code § 1632 makes the Chinese the version the client is held to have understood.
          </span></span>
      </label>
      <label style="display:flex; gap:9px; align-items:center; font-size:14px; margin-bottom:22px;">
        <input type="checkbox" name="work_already_begun" value="1">
        The firm has already started or finished work on this matter
      </label>

      <button type="submit" style="background:#A34C00; color:#FFFFFF; border:0; padding:12px 24px; border-radius:6px; font-size:15px; font-weight:600; cursor:pointer;">
        Draft the agreement
      </button>
      <span style="margin-left:14px; font-size:13px; color:#5E5854;">Nothing is sent. You read it first.</span>
    </form>`;

  return renderAdminChrome({ title: "New fee agreement", body, activeItem: "retainer" });
}

// ── The list ─────────────────────────────────────────────────

function renderList({ user, drafts = [] } = {}) {
  const { renderAdminChrome } = require("./hearing-notes");
  const mine = !seesAll(user);

  const rows = drafts.map((d) => `
    <tr style="border-bottom:1px solid #E8E3DC;">
      <td style="padding:9px 12px;"><a href="${PAGE}/${d.id}" style="color:#A34C00;">${esc(d.client_name)}</a></td>
      <td style="padding:9px 12px; font-size:13px;">${esc(R.MATTER_LABELS[d.matter_type] || d.matter_type || "—")}</td>
      <td style="padding:9px 12px; font-size:13px;">${esc(d.structure || "—")}${d.total_fee ? ` · ${R.money(d.total_fee)}` : ""}</td>
      <td style="padding:9px 12px; font-size:13px;">${d.bilingual ? "EN + 中文" : "English"}</td>
      <td style="padding:9px 12px; font-size:13px;">${esc(d.status)}</td>
      <td style="padding:9px 12px; font-size:13px; color:#5E5854;">${esc(when(d.created_at))}${
        seesAll(user) && d.created_by ? `<br><span style="font-size:12px;">${esc(d.created_by)}</span>` : ""}</td>
    </tr>`).join("");

  const body = `
    <div class="page-header"><h1>Fee agreements</h1></div>
    <p style="font-size:14px; color:#1E1B1A; max-width:62ch;">
      ${mine ? "The agreements you have drafted." : "Every agreement the firm has drafted."}
      Each one records the fee structure, the scope as written, and the clauses that structure requires.
    </p>
    <p><a href="${PAGE}/new" style="display:inline-block; background:#A34C00; color:#FFFFFF; padding:11px 20px; border-radius:6px; text-decoration:none; font-size:15px; font-weight:600;">New fee agreement</a></p>
    ${drafts.length ? `
      <table style="width:100%; border-collapse:collapse; font-size:14px; background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; margin-top:20px;">
        <thead><tr style="text-align:left; color:#8A827C; font-size:11px; letter-spacing:.06em; text-transform:uppercase;">
          <th style="padding:7px 12px;">Client</th><th style="padding:7px 12px;">Matter</th>
          <th style="padding:7px 12px;">Fee</th><th style="padding:7px 12px;">Language</th>
          <th style="padding:7px 12px;">Status</th><th style="padding:7px 12px;">Drafted</th>
        </tr></thead><tbody>${rows}</tbody>
      </table>`
      : `<p style="margin-top:20px; color:#5E5854; font-style:italic;">${mine ? "You have not drafted one yet." : "None yet."}</p>`}`;

  return renderAdminChrome({ title: "Fee agreements", body, activeItem: "retainer" });
}

// ── One draft, as the client will read it ───────────────────

function renderReview({ user, draft }) {
  const { renderAdminChrome } = require("./hearing-notes");
  const terms = draft.terms || {};
  const problems = R.problemsWith(terms);

  const body = `
    <div class="page-header"><h1>${esc(draft.client_name)}</h1></div>
    <p style="font-size:13px; color:#5E5854;">
      Drafted ${esc(when(draft.created_at))} by ${esc(draft.created_by || "—")} · ${esc(draft.status)}
      &nbsp;·&nbsp;<a href="${PAGE}" style="color:#A34C00;">all agreements</a>
    </p>

    ${problems.length ? `
      <div style="margin:0 0 20px; padding:14px 18px; background:#FFF4E8; border-left:4px solid #FF7B00;">
        <strong style="color:#A34C00;">Not ready to send.</strong>
        <ul style="margin:8px 0 0; padding-left:20px; font-size:14px;">${problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      </div>`
      : `<div style="margin:0 0 20px; padding:12px 18px; background:#E8E3DC; border-left:4px solid #2B2523; font-size:14px;">
           Everything § 6148 and § 6147 require is present. Read it, then send it.
         </div>`}

    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:22px;">
      <a href="${PAGE}/${draft.id}/print" target="_blank" style="background:#A34C00; color:#FFFFFF; padding:10px 18px; border-radius:6px; text-decoration:none; font-size:14px; font-weight:600;">Open to read or print</a>
      <a href="${PAGE}/${draft.id}/word" style="background:#F3EFE9; color:#2B2523; border:1px solid #E8E3DC; padding:10px 18px; border-radius:6px; text-decoration:none; font-size:14px; font-weight:600;">Download Word</a>
      ${problems.length ? "" : `
        <form method="POST" action="${PAGE}/${draft.id}/send" style="margin:0;">
          <button type="submit" style="background:#2B2523; color:#FFFFFF; border:0; padding:10px 18px; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer;">Send for signature</button>
        </form>`}
    </div>

    <div style="border:1px solid #E8E3DC; border-radius:8px; overflow:hidden; background:#FFFFFF;">
      <div style="padding:10px 16px; background:#FAF8F5; border-bottom:1px solid #E8E3DC; font-size:12px; color:#5E5854;">
        The agreement, with the notes that say which rule each clause answers. The client's copy carries none of them.
      </div>
      <div style="padding:4px 20px 20px;">${DOC.body(terms, { forClient: false })}</div>
    </div>
    <style>${DOC.CSS.replace(/@page[^}]*}/g, "").replace(/body\s*\{[^}]*}/g, "")}</style>`;

  return renderAdminChrome({ title: `Fee agreement — ${draft.client_name}`, body, activeItem: "retainer" });
}

// ── Reading the form ─────────────────────────────────────────

function termsFromForm(b, user) {
  const lines = String(b.scope || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const structure = String(b.structure || "");
  const fee = Number(b.total_fee || 0);
  const matter = String(b.matter_type || "");

  // The milestone split: the matter type's default, front-loaded, which the
  // drafter can change later. JJ: "for other cases, its different based on
  // case and clients."
  const milestones = (structure === "flat" || structure === "hybrid")
    ? (matter.startsWith("immigration") ? R.FLAT_MILESTONES.immigration : R.FLAT_MILESTONES.default)
    : [];

  return {
    client_name: String(b.client_name || "").trim(),
    client_key: String(b.client_key || "").trim() || null,
    matter_type: matter,
    structure,
    scope: lines,
    total_fee: fee || null,
    deposit: structure === "hourly" ? (fee || null) : null,
    contingency_pct: Number(b.contingency_pct || 0) || null,
    costs_borne_by: String(b.costs_borne_by || "") || null,
    micra: !!b.micra,
    timekeepers: [].concat(b.timekeepers || []).filter(Boolean),
    milestones,
    operating_account_consent: !!b.operating_account_consent,
    bilingual: !!b.bilingual,
    work_already_begun: !!b.work_already_begun,
    agreement_date: new Date().toISOString().slice(0, 10),
    drafted_by: nameOf(user),
  };
}

// ── Routes ───────────────────────────────────────────────────

function mount(app, auth) {
  app.use(PAGE, auth.requireRole(...ROLES));

  app.get(PAGE, async (req, res) => {
    try {
      res.send(renderList({ user: req.user, drafts: await listDrafts(req.user) }));
    } catch (err) {
      console.error("[retainer list]:", err.message);
      res.status(500).send("<h1>Could not read the agreements</h1><p>The reason is in the server log.</p>");
    }
  });

  app.get(PAGE + "/new", async (req, res) => {
    try {
      res.send(renderForm({ user: req.user, clients: await knownClients() }));
    } catch (err) {
      console.error("[retainer form]:", err.message);
      res.status(500).send("<h1>Could not build the form</h1>");
    }
  });

  app.post(PAGE + "/new", async (req, res) => {
    const terms = termsFromForm(req.body || {}, req.user);
    try {
      // Saved whatever its state: a draft with problems is still the
      // drafter's work, and losing it to a validation error is worse than
      // showing the problems on the draft itself.
      const id = await saveDraft(req.user, terms);
      res.redirect(`${PAGE}/${id}`);
    } catch (err) {
      console.error("[retainer save]:", err.message);
      res.status(500).send(renderForm({
        user: req.user, clients: await knownClients().catch(() => []),
        prefill: { ...terms, scope: (terms.scope || []).join("\n") },
        problems: ["The draft could not be saved: " + err.message],
      }));
    }
  });

  app.get(PAGE + "/:id", async (req, res) => {
    try {
      const d = await getDraft(req.user, req.params.id);
      if (!d) return res.status(404).send(renderList({ user: req.user, drafts: await listDrafts(req.user) }));
      res.send(renderReview({ user: req.user, draft: d }));
    } catch (err) {
      console.error("[retainer review]:", err.message);
      res.status(500).send("<h1>Could not open that agreement</h1>");
    }
  });

  // The document on its own, for reading and for print-to-PDF. This is the
  // file the e-signature packet is built from.
  app.get(PAGE + "/:id/print", async (req, res) => {
    try {
      const d = await getDraft(req.user, req.params.id);
      if (!d) return res.status(404).send("Not found");
      res.send(DOC.render(d.terms || {}, { forClient: true, id: d.id }));
    } catch (err) {
      console.error("[retainer print]:", err.message);
      res.status(500).send("Could not render the agreement");
    }
  });

  // The agreement as a Word file. Built by converting the markup the print
  // view already renders, so the two cannot disagree about the fee.
  app.get(PAGE + "/:id/word", async (req, res) => {
    try {
      const d = await getDraft(req.user, req.params.id);
      if (!d) return res.status(404).send("Not found");
      const DOCX = require("./retainer-docx");
      const terms = d.terms || {};
      const buf = DOCX.build(terms, DOC);
      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(DOCX.fileName(terms))}`);
      res.send(buf);
    } catch (err) {
      console.error("[retainer word]:", err.message);
      res.status(500).send("Could not build the Word file");
    }
  });

  app.post(PAGE + "/:id/send", async (req, res) => {
    try {
      const d = await getDraft(req.user, req.params.id);
      if (!d) return res.status(404).send("Not found");
      const problems = R.problemsWith(d.terms || {});
      if (problems.length) {
        // Refused server-side as well as hidden in the page: a draft that
        // is not compliant must not become a signature request because
        // somebody kept the URL.
        return res.status(400).send(renderReview({ user: req.user, draft: d }));
      }
      await db().query(
        `UPDATE retainer_drafts SET status = 'ready_to_send', updated_at = NOW() WHERE id = $1`, [d.id]);
      res.redirect(`/admin/esign?retainer=${d.id}`);
    } catch (err) {
      console.error("[retainer send]:", err.message);
      res.status(500).send("Could not hand it to the e-signature packet");
    }
  });
}

module.exports = {
  PAGE, ROLES, initTable, listDrafts, getDraft, saveDraft, knownClients,
  renderForm, renderList, renderReview, termsFromForm, scope, seesAll, mount,
};
