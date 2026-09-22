// ============================================================
//  zara-actions.js — Zara changes the file; a person says yes
//  ─────────────────────────────────────────────────────────
//  Zara can now change a civil matter: correct its details, add a
//  note, a deadline or a hearing, log time, save a memo into the
//  case's Dropbox folder. She does it by PROPOSING. Each proposal
//  shows in the chat as a card: what will change, from what to
//  what, and an Apply button. Nothing is written until someone
//  presses it.
//
//  Why not let her write directly: this is a litigation file. A
//  wrong filing date regenerates the whole deadline chain; a wrong
//  trial date moves every expert and discovery cutoff with it. The
//  charter makes protecting the attorney from malpractice her
//  second goal, and a person reading a two-line diff before it is
//  saved is the cheapest protection there is. It also means the
//  case history can always say who approved a change, not just
//  that "Zara" made it.
//
//  Rules:
//    · A proposal records the value it expects to replace. If the
//      field has changed since (someone edited the case in the
//      meantime), that field is refused at Apply, not overwritten.
//    · Proposals expire after 7 days.
//    · Every applied proposal is written to the case history with
//      the name of the person who applied it.
// ============================================================

const db = require("./db");

const EDITABLE = {
  case_name: "Case name", case_number: "Case number", case_type: "Case type",
  court: "Court", county: "County", jurisdiction: "Jurisdiction", our_role: "Our role",
  stage: "Stage", opposing_party: "Opposing party",
  filed_date: "Filed date", service_date: "Service date", service_method: "Service method",
  answered_date: "Answer date", statute_of_limitations: "Statute of limitations",
  cmc_date: "CMC date", trial_date: "Trial date", discovery_cutoff_date: "Discovery cutoff",
  verdict_date: "Verdict date", judgment_date: "Judgment date", judgment_notice_date: "Notice of entry of judgment",
  amount_in_controversy: "Amount in controversy",
  billing_type: "Billing type", hourly_rate: "Hourly rate", contingency_pct: "Contingency %",
  retainer_amount: "Retainer amount", fee_arrangement_notes: "Fee arrangement notes",
  court_docket_url: "Court docket link",
};
const DATE_FIELDS = new Set(["filed_date", "service_date", "answered_date", "statute_of_limitations",
  "cmc_date", "trial_date", "discovery_cutoff_date", "verdict_date", "judgment_date", "judgment_notice_date"]);
const DEADLINE_DRIVERS = new Set([...DATE_FIELDS, "jurisdiction", "service_method"]);
const EXPIRY_DAYS = 7;

let ready = null;
function initTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS zara_proposals (
        id            SERIAL PRIMARY KEY,
        kind          TEXT NOT NULL,
        case_id       INTEGER,
        payload       JSONB NOT NULL,
        summary       TEXT,
        lines         JSONB,
        reason        TEXT,
        status        TEXT DEFAULT 'pending',
        requested_by  TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        decided_by    TEXT,
        decided_at    TIMESTAMPTZ,
        result        JSONB,
        error         TEXT
      )`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

function day(v) {
  if (v === null || v === undefined || v === "") return null;
  const t = new Date(v);
  return isNaN(t) ? null : t.toISOString().slice(0, 10);
}
function show(v) {
  if (v === null || v === undefined || v === "") return "(blank)";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
function norm(field, v) {
  if (v === undefined || v === null || v === "") return null;
  if (DATE_FIELDS.has(field)) return day(v);
  if (["hourly_rate", "contingency_pct", "retainer_amount", "amount_in_controversy"].includes(field)) {
    const n = Number(String(v).replace(/[$,%\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return String(v).trim();
}

async function loadCase(caseId) {
  const c = (await db.query(`SELECT * FROM civil_cases WHERE id = $1`, [parseInt(caseId, 10)])).rows[0];
  if (!c) throw new Error(`No civil matter #${caseId}`);
  return c;
}

async function save(kind, caseId, payload, summary, lines, reason, by) {
  await initTables();
  const r = await db.query(
    `INSERT INTO zara_proposals (kind, case_id, payload, summary, lines, reason, requested_by)
     VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7) RETURNING *`,
    [kind, caseId, JSON.stringify(payload), summary, JSON.stringify(lines || []), reason || null, by || null]
  );
  return r.rows[0];
}

// ── Proposing ───────────────────────────────────────────────

/** Change fields on the matter. changes: { field: newValue } */
async function proposeMatterUpdate(caseId, changes, { reason = null, by = null } = {}) {
  const c = await loadCase(caseId);
  const fields = {}, lines = [], rejected = [];
  for (const [k, raw] of Object.entries(changes || {})) {
    if (!EDITABLE[k]) { rejected.push(k); continue; }
    const next = norm(k, raw);
    if (DATE_FIELDS.has(k) && raw && !next) { rejected.push(`${k} (not a date: ${raw})`); continue; }
    const cur = norm(k, c[k]);
    if (String(cur) === String(next)) continue;
    fields[k] = { from: cur, to: next };
    lines.push(`${EDITABLE[k]}: ${show(cur)} → ${show(next)}`);
  }
  if (!lines.length) {
    throw new Error(rejected.length
      ? `Nothing to change. Not editable this way: ${rejected.join(", ")}`
      : "Nothing to change — the matter already has those values");
  }
  if (Object.keys(fields).some(k => DEADLINE_DRIVERS.has(k))) {
    lines.push("Note: changing these dates recalculates the automatic deadlines.");
  }
  const p = await save("update_matter", c.id, { fields },
    `Update ${Object.keys(fields).length} field${Object.keys(fields).length === 1 ? "" : "s"} on ${c.case_name}`,
    lines, reason, by);
  return { proposal: p, rejected };
}

/** A note, deadline or hearing on the matter. */
async function proposeEntry(caseId, entry, { reason = null, by = null } = {}) {
  const c = await loadCase(caseId);
  const type = entry && entry.type;
  if (type === "note") {
    const title = String(entry.title || "").trim();
    if (!title) throw new Error("A note needs a title");
    return { proposal: await save("add_note", c.id,
      { title, description: String(entry.description || "").trim() || null, event_date: day(entry.date) || day(new Date()) },
      `Add a note to ${c.case_name}`, [title, entry.description ? String(entry.description).slice(0, 400) : null].filter(Boolean), reason, by) };
  }
  if (type === "deadline") {
    const due = day(entry.date);
    if (!due) throw new Error("A deadline needs a real due date");
    const desc = String(entry.description || entry.title || "").trim();
    if (!desc) throw new Error("Describe the deadline");
    const priority = ["high", "medium", "low"].includes(entry.priority) ? entry.priority : "medium";
    return { proposal: await save("add_deadline", c.id,
      { due_date: due, description: desc, ccp_rule: entry.rule || null, priority },
      `Add a deadline to ${c.case_name}`, [`${due} — ${desc}${entry.rule ? " (" + entry.rule + ")" : ""} · ${priority} priority`], reason, by) };
  }
  if (type === "hearing") {
    const d = day(entry.date);
    if (!d) throw new Error("A hearing needs a real date");
    const payload = {
      hearing_date: d, hearing_time: entry.time || null, hearing_type: entry.hearing_type || entry.title || "Other",
      department: entry.department || null, judge: entry.judge || null, purpose: entry.description || null,
    };
    return { proposal: await save("add_hearing", c.id, payload, `Add a hearing to ${c.case_name}`,
      [`${d}${payload.hearing_time ? " " + payload.hearing_time : ""} — ${payload.hearing_type}${payload.department ? " · Dept. " + payload.department : ""}`,
       payload.purpose].filter(Boolean), reason, by) };
  }
  throw new Error("Entry type must be note, deadline or hearing");
}

/** Save a memo (Word document) into the matter's Dropbox folder. */
async function proposeMemo(caseId, { title, content, category = null, reason = null, by = null } = {}) {
  const c = await loadCase(caseId);
  const t = String(title || "").trim();
  const body = String(content || "").trim();
  if (!t) throw new Error("A memo needs a title");
  if (body.length < 20) throw new Error("The memo has no content");
  return { proposal: await save("save_memo", c.id, { title: t, content: body, category },
    `Save a memo to ${c.case_name}'s Dropbox folder`,
    [`"${t}.docx"${category ? " → " + category : ""} · ${body.split(/\s+/).length} words`,
     body.slice(0, 300) + (body.length > 300 ? "…" : "")], reason, by) };
}

// ── Deciding ────────────────────────────────────────────────

async function getProposal(id) {
  await initTables();
  const p = (await db.query(`SELECT * FROM zara_proposals WHERE id = $1`, [id])).rows[0];
  if (!p) throw new Error("Proposal not found");
  return p;
}

async function note(caseId, title, description, by) {
  try {
    await require("./civil-litigation").logEvent(caseId, {
      event_kind: "note", event_date: day(new Date()), title, description, created_by: by,
    });
  } catch (e) { /* the change itself stands */ }
}

async function applyProposal(id, { by = null, userId = null } = {}) {
  const p = await getProposal(id);
  if (p.status !== "pending") throw new Error(`This proposal was already ${p.status}`);
  if (Date.now() - new Date(p.created_at).getTime() > EXPIRY_DAYS * 86400000) {
    await db.query(`UPDATE zara_proposals SET status = 'expired' WHERE id = $1`, [id]);
    throw new Error("This proposal is more than a week old. Ask Zara again so it reflects the file as it is now.");
  }
  // Claim it, so a double-click cannot apply the same change twice.
  const claim = await db.query(
    `UPDATE zara_proposals SET status = 'applying' WHERE id = $1 AND status = 'pending' RETURNING id`, [id]);
  if (!claim.rows.length) throw new Error("This proposal is already being applied");
  const civil = require("./civil-litigation");
  const payload = p.payload || {};
  let result;
  try {
    if (p.kind === "update_matter") {
      const c = await loadCase(p.case_id);
      const apply = {}, stale = [];
      for (const [k, { from, to }] of Object.entries(payload.fields || {})) {
        // Someone changed it since Zara looked: do not overwrite their edit.
        if (String(norm(k, c[k])) !== String(from)) { stale.push(`${EDITABLE[k] || k} (now ${show(norm(k, c[k]))})`); continue; }
        apply[k] = to;
      }
      if (!Object.keys(apply).length) throw new Error("Every field has changed since Zara proposed this: " + stale.join(", "));
      await civil.updateCase(p.case_id, apply);
      result = { applied: Object.keys(apply), skipped_changed_since: stale };
      await note(p.case_id, "Case details updated (proposed by Zara)",
        (p.lines || []).filter(l => !/^Note:/.test(l)).join("\n") +
        (stale.length ? `\nNot applied — changed since proposed: ${stale.join(", ")}` : "") +
        `\nApproved by ${by || "unknown"}.` + (p.reason ? `\nWhy: ${p.reason}` : ""), by);
    } else if (p.kind === "add_note") {
      result = await civil.logEvent(p.case_id, {
        event_kind: "note", event_date: payload.event_date, title: payload.title,
        description: (payload.description || "") + `\n\n(Drafted by Zara, approved by ${by || "unknown"})`, created_by: by,
      });
    } else if (p.kind === "add_deadline") {
      result = await civil.addManualDeadline(p.case_id, payload);
      await note(p.case_id, `Deadline added: ${payload.description}`, `Due ${payload.due_date}. Proposed by Zara, approved by ${by || "unknown"}.`, by);
    } else if (p.kind === "add_hearing") {
      result = await require("./civil-hearings").addHearing(p.case_id, payload, { by: `${by || "unknown"} (via Zara)` });
    } else if (p.kind === "save_memo") {
      const buffer = buildDocx(payload.title, payload.content);
      const up = await require("./civil-upload").uploadToCase(p.case_id,
        [{ originalname: safeName(payload.title) + ".docx", buffer }],
        { category: payload.category || null, by: `${by || "unknown"} (memo drafted by Zara)` });
      if (!up.uploaded.length) throw new Error((up.failed[0] && up.failed[0].error) || "Upload failed");
      result = up.uploaded[0];
    } else if (p.kind === "log_time_batch") {
      // Reconstructed or imported time: every entry goes through civil-time.logTime.
      result = await require("./civil-time-reconstruct").applyBatch(p, { by, userId });
    } else {
      throw new Error("Unknown proposal type: " + p.kind);
    }
  } catch (e) {
    // Stays pending: a failure is usually Dropbox or the network, and the
    // user should be able to press Apply again once it is back.
    await db.query(`UPDATE zara_proposals SET status = 'pending', error = $2 WHERE id = $1`, [id, e.message]);
    throw e;
  }
  await db.query(`UPDATE zara_proposals SET status = 'applied', decided_by = $2, decided_at = NOW(), result = $3::jsonb WHERE id = $1`,
    [id, by, JSON.stringify(result || {})]);
  return { ok: true, kind: p.kind, result };
}

async function discardProposal(id, { by = null } = {}) {
  const p = await getProposal(id);
  if (p.status !== "pending") return { ok: true, status: p.status };
  await db.query(`UPDATE zara_proposals SET status = 'discarded', decided_by = $2, decided_at = NOW() WHERE id = $1`, [id, by]);
  return { ok: true, status: "discarded" };
}

/** What a chat card needs to draw a proposal. */
function card(p) {
  return { id: p.id, kind: p.kind, case_id: p.case_id, summary: p.summary, lines: p.lines || [],
           reason: p.reason, status: p.status };
}

// ── A minimal Word document ─────────────────────────────────

function safeName(s) {
  return String(s || "Memo").replace(/[\/\\:?*"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Memo";
}
function xmlEsc(s) {
  return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildDocx(title, content) {
  const PizZip = require("pizzip");
  const zip = new PizZip();
  const para = (text, bold, size) =>
    `<w:p><w:r><w:rPr>${bold ? "<w:b/>" : ""}${size ? `<w:sz w:val="${size}"/>` : ""}<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/></w:rPr>` +
    `<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  const body = [para(title, true, 28), para("", false)]
    .concat(String(content).split(/\r?\n/).map(line => {
      const h = line.match(/^#{1,3}\s+(.*)$/);
      if (h) return para(h[1], true, 24);
      return para(line.replace(/\*\*(.+?)\*\*/g, "$1"), false, 24);
    })).join("");
  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer" });
}

module.exports = {
  EDITABLE, initTables, proposeMatterUpdate, proposeEntry, proposeMemo,
  getProposal, applyProposal, discardProposal, card, buildDocx,
};
