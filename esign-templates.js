// ============================================================
//  esign-templates.js — templates made from documents already filed
// ------------------------------------------------------------
//  JJ uploads a document he has filed before (a declaration, a
//  verification, a proof of service, the retainer). Zara reads it and
//  says which words belong to THAT case — the client's name, the case
//  number, the hearing date — and where each person signs. Those
//  become {{fields}} and {{sig:…}} spots; everything else, including
//  the formatting, stays exactly as filed.
//
//  A new template is a DRAFT. JJ reviews the fields (rename, change
//  where a value comes from, or turn one back into fixed text) and
//  activates it. Only active templates can be sent for signature.
// ============================================================

const crypto = require("crypto");
const db = require("./db");
const docx = require("./docx-fill");

// Where a field's value comes from when a document is prepared on a
// matter. "ask" means the person preparing it types it in.
const SOURCES = {
  client_name: "Client's name",
  client_address: "Client's address",
  client_email: "Client's email",
  client_phone: "Client's phone",
  a_number: "A-number",
  client_language: "Client's language",
  date_of_birth: "Client's date of birth",
  case_name: "Case name (caption)",
  case_number: "Case number",
  court: "Court",
  county: "County",
  jurisdiction: "Jurisdiction",
  case_type: "Case type",
  our_role: "Our role (plaintiff/defendant)",
  opposing_party: "Opposing party",
  filed_date: "Filed date",
  service_date: "Service date",
  trial_date: "Trial date",
  cmc_date: "CMC date",
  next_hearing_date: "Next hearing — date",
  next_hearing_time: "Next hearing — time",
  next_hearing_type: "Next hearing — type",
  next_hearing_department: "Next hearing — department",
  next_hearing_judge: "Next hearing — judge",
  next_hearing_location: "Next hearing — location",
  hourly_rate: "Hourly rate",
  retainer_amount: "Retainer amount",
  contingency_pct: "Contingency %",
  fee_arrangement_notes: "Fee arrangement notes",
  today: "Today's date",
  ask: "Ask when preparing",
};
const TYPES = ["text", "date", "money", "number", "multiline"];
const CATEGORIES = ["retainer", "declaration", "affidavit", "verification", "proof_of_service", "motion", "notice", "stipulation", "letter", "other"];
const ROLE_RE = /^(client(_[2-9])?|witness(_[2-9])?|attorney|other(_[2-9])?)$/;

let ready = null;
function initTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS esign_templates (
        id              SERIAL PRIMARY KEY,
        name            TEXT NOT NULL,
        category        TEXT DEFAULT 'other',
        description     TEXT,
        docx            BYTEA NOT NULL,
        fields          JSONB DEFAULT '[]'::jsonb,
        signers         JSONB DEFAULT '[]'::jsonb,
        source_filename TEXT,
        notes           JSONB DEFAULT '[]'::jsonb,
        status          TEXT DEFAULT 'draft',
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// ── Reading the upload ──────────────────────────────────────

async function toDocx(buffer, filename) {
  const n = String(filename || "").toLowerCase();
  if (n.endsWith(".docx")) return { buffer, fromPdf: false };
  if (n.endsWith(".pdf")) {
    const text = await require("./civil-intake-extract").textFromBuffer(buffer, filename);
    if (!String(text).trim()) throw new Error("That PDF has no text layer (a scan). Upload the Word version, or run OCR first.");
    return { buffer: docx.textToDocx(text), fromPdf: true };
  }
  if (n.endsWith(".doc")) throw new Error("Old .doc files cannot be read. Open it in Word and Save As .docx.");
  throw new Error("Upload a .docx (best — keeps the formatting) or a PDF.");
}

function numbered(paras, max = 70000) {
  let out = "", i = 0;
  for (const p of paras) {
    const line = `[${i}] ${p.part === "word/document.xml" ? "" : "(" + p.part.replace(/^word\/|\.xml$/g, "") + ") "}${p.text.slice(0, 600)}\n`;
    if (out.length + line.length > max) { out += `[…${paras.length - i} more paragraphs not shown]\n`; break; }
    out += line; i++;
  }
  return out;
}

function buildPrompt(paras, filename) {
  return [
    `This is a document a law firm has already filed or used ("${filename}"). Turn it into a reusable template.`,
    "",
    "Find the words that belong to THIS particular case and would change next time — names of clients, parties and witnesses, the case number, A-number, court, county, immigration judge, dates, hearing details, amounts, addresses — and where each person signs.",
    "It may be a civil court filing, an immigration court or USCIS document (declaration, affidavit, cover letter), or a retainer.",
    "Leave the firm's own details (attorney name, bar number, firm name, address, phone, email) as fixed text: they do not change. Leave the legal text alone.",
    "",
    "Reply with ONLY a JSON object:",
    "{",
    '  "name": "<short template name, e.g. \\"Declaration of Client re Continuance\\">",',
    `  "category": "<one of: ${CATEGORIES.join(", ")}>",`,
    '  "description": "<one sentence: what this document is and when it is used>",',
    '  "fields": [ { "key": "<snake_case>", "label": "<plain-English label>",',
    `      "source": "<one of: ${Object.keys(SOURCES).join(", ")}>",`,
    `      "type": "<one of: ${TYPES.join(", ")}>",`,
    '      "find": ["<every exact spelling of this value as it appears in the text, e.g. \\"Jing Liu\\", \\"JING LIU\\">"] } ],',
    '  "signers": [ { "role": "<client | client_2 | witness | witness_2 | attorney | other>", "label": "<e.g. Client, Declarant, Attorney>",',
    '      "signature_paragraph": <paragraph number holding the signature line>,',
    '      "date_paragraph": <paragraph number holding that signer\'s date line, or null> } ],',
    '  "notes": ["<anything the attorney should check, e.g. a value you were unsure about>"]',
    "}",
    "",
    "RULES:",
    "· \"find\" strings must be copied EXACTLY from the paragraphs below (same capitals, punctuation, spacing). Each at least 3 characters. Never include a string that also appears as ordinary legal text (e.g. do not list \"Plaintiff\").",
    "· One field per value. The client's name in capitals and in normal case is ONE field with two find strings.",
    "· Use a real source when the value is something the case file knows (case number, court, next hearing date, client name…); use \"ask\" for anything else (a witness's name, a specific fact).",
    "· A signer is someone who signs by hand/e-signature on a line. An attorney's \"/s/\" conformed signature on a court filing is NOT a signer — leave it as text. A retainer's attorney signature line IS a signer (role attorney).",
    "· Several clients who each sign → client, client_2, client_3.",
    "· Paragraph numbers are the [n] below.",
    "",
    "PARAGRAPHS:",
    numbered(paras),
  ].join("\n");
}

function parseAnalysis(text) {
  const parse = require("./civil-intake-extract").parseJson;
  const o = parse(text);
  if (!o || typeof o !== "object") throw new Error("Zara's answer was not a JSON object");
  return o;
}

/** "client_2" → "Client 2", "attorney" → "Attorney". */
function prettyRole(role) {
  const r = String(role || "").replace(/_/g, " ").trim();
  return r ? r[0].toUpperCase() + r.slice(1) : "Signer";
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}

function cleanFields(raw) {
  const out = [], seen = new Set();
  for (const f of Array.isArray(raw) ? raw : []) {
    let key = slug(f && (f.key || f.label));
    if (!key || /^(sig|date|name|initials)$/.test(key)) continue;
    while (seen.has(key)) key += "_2";
    const find = [...new Set((Array.isArray(f.find) ? f.find : [f.find]).map(x => String(x || "")).filter(x => x.trim().length >= 3))];
    if (!find.length) continue;
    seen.add(key);
    out.push({
      key,
      label: String(f.label || key).slice(0, 120),
      source: SOURCES[f.source] ? f.source : "ask",
      type: TYPES.includes(f.type) ? f.type : "text",
      find,
      sample: find[0],
    });
  }
  return out;
}

function cleanSigners(raw, paraCount) {
  const out = [], roles = new Set();
  for (const s of Array.isArray(raw) ? raw : []) {
    const role = String(s && s.role || "").toLowerCase().trim();
    if (!ROLE_RE.test(role) || roles.has(role)) continue;
    const sp = Number(s.signature_paragraph);
    if (!Number.isInteger(sp) || sp < 0 || sp >= paraCount) continue;
    const dp = s.date_paragraph === null || s.date_paragraph === undefined ? null : Number(s.date_paragraph);
    roles.add(role);
    out.push({
      role, label: String(s.label || role).slice(0, 60),
      signature_paragraph: sp,
      date_paragraph: Number.isInteger(dp) && dp >= 0 && dp < paraCount ? dp : null,
    });
  }
  return out;
}

const DATE_TEXT = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

/**
 * Put the fields and signature spots into the document.
 * Returns { buffer, fields, signers, notes }.
 */
function applyAnalysis(buffer, fields, signers) {
  const notes = [];

  // Longest strings first, so "Jing Liu" is not half-replaced by "Liu".
  const pairs = [];
  for (const f of fields) {
    const base = f.sample;
    for (const s of f.find) {
      const caps = s === s.toUpperCase() && /[A-Z]/.test(s) && base !== base.toUpperCase();
      pairs.push({ find: s, replace: `{{${f.key}${caps ? "|upper" : ""}}}`, field: f.key });
    }
  }
  pairs.sort((a, b) => b.find.length - a.find.length);

  const only = {};
  const add = (i, pair) => { (only[i] = only[i] || []).push(pair); };
  for (const s of signers) {
    // The signature line (a run of underscores) becomes the signature spot.
    add(s.signature_paragraph, { find: /_{4,}/, replace: `{{sig:${s.role}}}` });
    if (s.date_paragraph !== null) {
      add(s.date_paragraph, { find: new RegExp(`_{3,}|${DATE_TEXT.source}`), replace: `{{date:${s.role}}}` });
    }
  }
  let out = docx.replaceText(buffer, pairs.map(p => ({ find: p.find, replace: p.replace })), { only });

  // A signature paragraph with no drawn line: put the spot at its end.
  const placedNow = new Set(docx.placeholders(out.buffer));
  const append = {};
  for (const s of signers) {
    if (!placedNow.has("sig:" + s.role)) {
      (append[s.signature_paragraph] = append[s.signature_paragraph] || [])
        .push({ find: /([\s\S])$/, replace: (m) => `${m} {{sig:${s.role}}}` });
    }
  }
  if (Object.keys(append).length) out = docx.replaceText(out.buffer, [], { only: append });

  // Keep only fields that actually landed somewhere.
  const used = new Set(docx.placeholders(out.buffer));
  const kept = fields.filter(f => {
    if (used.has(f.key)) return true;
    notes.push(`"${f.label}" was not found in the document text, so it was left out.`);
    return false;
  });
  const keptSigners = signers.filter(s => {
    if (used.has("sig:" + s.role)) return true;
    notes.push(`Could not place the ${s.label} signature — add {{sig:${s.role}}} in Word where it goes.`);
    return false;
  });
  return { buffer: out.buffer, fields: kept, signers: keptSigners, notes };
}

// ── Creating a template ─────────────────────────────────────

/**
 * Upload → Zara's analysis → draft template.
 * opts.think lets a test stand in for the model.
 */
async function createFromUpload(buffer, filename, { by = null, think = null } = {}) {
  await initTables();
  if (!buffer || !buffer.length) throw new Error("The file is empty");
  const { buffer: source, fromPdf } = await toDocx(buffer, filename);
  const paras = docx.paragraphs(source);
  if (!paras.some(p => p.text.trim())) throw new Error("No text found in that document");

  // Already a template (someone put {{fields}} in by hand)? Use it as is.
  const existing = docx.placeholders(source);
  let fields, signers, notes = [], meta = {};
  let body = source;
  if (existing.length) {
    fields = existing.filter(k => !/^(sig|date|name|initials):/.test(k))
      .map(k => ({ key: k, label: k.replace(/_/g, " "), source: SOURCES[k] ? k : "ask", type: "text", find: [], sample: "" }));
    signers = existing.filter(k => /^sig:/.test(k)).map(k => ({ role: k.slice(4), label: prettyRole(k.slice(4)) }));
    meta = { name: String(filename).replace(/\.[^.]+$/, ""), category: "other" };
    notes.push("This file already had {{fields}} in it, so it was used as written.");
  } else {
    const ask = think || ((message) => require("./zara-core").think({
      surface: "system", tier: "balanced", message, lessonScope: "templates",
      extra: "You are converting a law firm's filed document into a reusable template. Precision matters: a wrong find string corrupts the template. Reply with one JSON object and nothing else.",
      maxTokens: 6000, maxMessageChars: 90000, timeout: 150000,
    }));
    const prompt = buildPrompt(paras, filename);
    let parsed;
    try { parsed = parseAnalysis((await ask(prompt)).text); }
    catch (e) {
      parsed = parseAnalysis((await ask(prompt + "\n\nIMPORTANT: reply with the JSON object ONLY.")).text);
    }
    meta = parsed;
    const applied = applyAnalysis(source, cleanFields(parsed.fields), cleanSigners(parsed.signers, paras.length));
    body = applied.buffer; fields = applied.fields; signers = applied.signers;
    notes = (Array.isArray(parsed.notes) ? parsed.notes.map(String) : []).concat(applied.notes);
  }
  if (fromPdf) notes.unshift("Made from a PDF, so the original formatting is lost. For a court-ready template, upload the Word version.");

  const r = await db.query(
    `INSERT INTO esign_templates (name, category, description, docx, fields, signers, source_filename, notes, status, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,'draft',$9) RETURNING *`,
    [String(meta.name || filename).slice(0, 160), CATEGORIES.includes(meta.category) ? meta.category : "other",
     meta.description ? String(meta.description).slice(0, 500) : null, body,
     JSON.stringify(fields), JSON.stringify(signers), String(filename).slice(0, 200), JSON.stringify(notes), by]
  );
  return summary(r.rows[0]);
}

// ── Reading and editing ─────────────────────────────────────

function summary(t) {
  if (!t) return null;
  const { docx: _bytes, ...rest } = t;
  return rest;
}

async function listTemplates({ includeArchived = false } = {}) {
  await initTables();
  const r = await db.query(
    `SELECT id, name, category, description, fields, signers, status, source_filename, notes, created_by, created_at, updated_at
       FROM esign_templates ${includeArchived ? "" : "WHERE status <> 'archived'"} ORDER BY status = 'active' DESC, category, name`);
  return r.rows;
}

async function getTemplate(id, { withDocx = false } = {}) {
  await initTables();
  const r = await db.query(`SELECT * FROM esign_templates WHERE id = $1`, [Number(id)]);
  if (!r.rows[0]) throw new Error("Template not found");
  return withDocx ? r.rows[0] : summary(r.rows[0]);
}

async function previewHtml(id) {
  const t = await getTemplate(id, { withDocx: true });
  const out = await require("mammoth").convertToHtml({ buffer: t.docx });
  return highlight(require("./esign").sanitizeHtml(out.value));
}

function highlight(html) {
  return String(html).replace(/\{\{\s*([a-zA-Z0-9_:.-]+)(?:\|(upper|lower))?\s*\}\}/g, (_, k) =>
    /^sig:/.test(k)
      ? `<span class="esign-spot esign-sig" data-spot="${k}">✍ ${k.slice(4).replace(/_/g, " ")} signs here</span>`
      : /^date:/.test(k)
        ? `<span class="esign-spot esign-date" data-spot="${k}">📅 date signed</span>`
        : `<span class="esign-spot" data-field="${k}">${k.replace(/_/g, " ")}</span>`);
}

/**
 * Edit a template's fields and details. `fields` entries may set
 * label/source/type; a field with `remove: true` is turned back into
 * fixed text (its original wording).
 */
async function updateTemplate(id, patch = {}, { by = null } = {}) {
  const t = await getTemplate(id, { withDocx: true });
  let buffer = t.docx;
  let fields = Array.isArray(t.fields) ? t.fields : [];

  if (Array.isArray(patch.fields)) {
    const byKey = Object.fromEntries(patch.fields.map(f => [f.key, f]));
    const removed = fields.filter(f => byKey[f.key] && byKey[f.key].remove);
    if (removed.length) {
      const pairs = [];
      for (const f of removed) {
        if (!f.sample) throw new Error(`"${f.label}" has no original wording to go back to — edit it out in Word instead`);
        pairs.push({ find: new RegExp(`\\{\\{\\s*${f.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\|\\s*(upper|lower)\\s*)?\\}\\}`, "g"),
          replace: (_m, _f, filt) => filt === "upper" ? f.sample.toUpperCase() : f.sample });
      }
      buffer = docx.replaceText(buffer, pairs).buffer;
    }
    fields = fields.filter(f => !(byKey[f.key] && byKey[f.key].remove)).map(f => {
      const p = byKey[f.key];
      if (!p) return f;
      return {
        ...f,
        label: p.label !== undefined ? String(p.label).slice(0, 120) : f.label,
        source: p.source !== undefined && SOURCES[p.source] ? p.source : f.source,
        type: p.type !== undefined && TYPES.includes(p.type) ? p.type : f.type,
      };
    });
  }
  const signers = Array.isArray(patch.signers)
    ? (t.signers || []).map(s => { const p = patch.signers.find(x => x.role === s.role); return p && p.label ? { ...s, label: String(p.label).slice(0, 60) } : s; })
    : t.signers;

  const r = await db.query(
    `UPDATE esign_templates SET name = $2, category = $3, description = $4, docx = $5, fields = $6::jsonb,
            signers = $7::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [t.id, patch.name !== undefined ? String(patch.name).slice(0, 160) : t.name,
     patch.category !== undefined && CATEGORIES.includes(patch.category) ? patch.category : t.category,
     patch.description !== undefined ? String(patch.description).slice(0, 500) : t.description,
     buffer, JSON.stringify(fields), JSON.stringify(signers)]
  );
  return summary(r.rows[0]);
}

/** Replace the Word file (after editing the template in Word). */
async function replaceDocx(id, buffer, filename) {
  const t = await getTemplate(id);
  if (!/\.docx$/i.test(filename || "")) throw new Error("Upload the edited template as a .docx");
  const keys = docx.placeholders(buffer);
  const known = Object.fromEntries((t.fields || []).map(f => [f.key, f]));
  const fields = keys.filter(k => !/^(sig|date|name|initials):/.test(k))
    .map(k => known[k] || { key: k, label: k.replace(/_/g, " "), source: SOURCES[k] ? k : "ask", type: "text", find: [], sample: "" });
  const knownS = Object.fromEntries((t.signers || []).map(s => [s.role, s]));
  const signers = keys.filter(k => /^sig:/.test(k)).map(k => knownS[k.slice(4)] || { role: k.slice(4), label: prettyRole(k.slice(4)) });
  const r = await db.query(
    `UPDATE esign_templates SET docx = $2, fields = $3::jsonb, signers = $4::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [t.id, buffer, JSON.stringify(fields), JSON.stringify(signers)]);
  return summary(r.rows[0]);
}

async function setStatus(id, status) {
  if (!["draft", "active", "archived"].includes(status)) throw new Error("Bad status");
  const t = await getTemplate(id);
  if (status === "active" && !(t.signers || []).length) {
    throw new Error("This template has no signature spot. Add {{sig:client}} in Word (download, edit, re-upload) before activating it.");
  }
  const r = await db.query(`UPDATE esign_templates SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`, [t.id, status]);
  return summary(r.rows[0]);
}

function hashOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

module.exports = {
  SOURCES, TYPES, CATEGORIES, initTables,
  createFromUpload, applyAnalysis, cleanFields, cleanSigners, buildPrompt, toDocx,
  listTemplates, getTemplate, previewHtml, highlight, updateTemplate, replaceDocx, setStatus, hashOf,
};
