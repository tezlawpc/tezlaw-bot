// ============================================================
//  esign.js — send a document for signature, collect every
//  signature, file the signed copy in the case folder
// ------------------------------------------------------------
//  A PACKET is one document prepared from a template for one matter,
//  plus the people who sign it. Each signer gets their own private
//  link. Signing happens in ORDER: everyone with order 1 (the clients,
//  witnesses) can sign at once; the attorney (order 2) gets the link
//  when they are done, and countersigns last.
//
//  Signing (ESIGN Act / Cal. UETA, Civ. Code § 1633.1 et seq.):
//    · the signer sees the whole document before signing
//    · consents to sign electronically (checkbox, with the disclosure)
//    · types their name and draws a signature
//    · we record when, from what IP and browser, and a SHA-256 hash
//      of the exact document they signed
//  When the last person signs, the signatures go into the Word file,
//  and a signed PDF with a signature certificate page is made and
//  filed in the matter's Dropbox folder, with a line in its history.
// ============================================================

const crypto = require("crypto");
const db = require("./db");
const docx = require("./docx-fill");
const templates = require("./esign-templates");

const LINK_DAYS = 30;
const MAX_SIG_BYTES = 400 * 1024;
const CONSENT_TEXT =
  "I agree to sign this document electronically. I understand my electronic signature has the same legal effect as a handwritten signature, " +
  "that I may ask Tez Law P.C. for a paper copy or to sign on paper instead, and that I can withdraw this consent before I sign by contacting the firm.";

let ready = null;
function initTables() {
  if (ready) return ready;
  ready = (async () => {
    await templates.initTables();
    await db.query(`
      CREATE TABLE IF NOT EXISTS esign_packets (
        id              SERIAL PRIMARY KEY,
        template_id     INTEGER,
        template_name   TEXT,
        category        TEXT,
        case_id         INTEGER,
        client_key      TEXT,
        title           TEXT NOT NULL,
        field_values    JSONB DEFAULT '{}'::jsonb,
        docx            BYTEA NOT NULL,
        doc_hash        TEXT,
        status          TEXT DEFAULT 'draft',
        message         TEXT,
        link_base       TEXT,
        created_by      TEXT,
        created_by_uid  INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        sent_at         TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        cancelled_at    TIMESTAMPTZ,
        signed_docx     BYTEA,
        signed_pdf      BYTEA,
        signed_hash     TEXT,
        dropbox_docx    TEXT,
        dropbox_pdf     TEXT,
        finalize_error  TEXT
      )`);
    await db.query(`ALTER TABLE esign_packets ADD COLUMN IF NOT EXISTS link_base TEXT`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_esign_packets_case ON esign_packets (case_id, created_at DESC)`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS esign_signers (
        id              SERIAL PRIMARY KEY,
        packet_id       INTEGER REFERENCES esign_packets(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        label           TEXT,
        name            TEXT NOT NULL,
        email           TEXT,
        phone           TEXT,
        sign_order      INTEGER DEFAULT 1,
        token           TEXT UNIQUE NOT NULL,
        status          TEXT DEFAULT 'waiting',
        expires_at      TIMESTAMPTZ,
        sent_at         TIMESTAMPTZ,
        sent_via        TEXT,
        delivery_error  TEXT,
        viewed_at       TIMESTAMPTZ,
        signed_at       TIMESTAMPTZ,
        typed_name      TEXT,
        signature_png   BYTEA,
        consent_text    TEXT,
        ip              TEXT,
        user_agent      TEXT,
        decline_reason  TEXT
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_esign_signers_packet ON esign_signers (packet_id)`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS esign_events (
        id          SERIAL PRIMARY KEY,
        packet_id   INTEGER REFERENCES esign_packets(id) ON DELETE CASCADE,
        signer_id   INTEGER,
        event       TEXT NOT NULL,
        detail      TEXT,
        ip          TEXT,
        at          TIMESTAMPTZ DEFAULT NOW()
      )`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

async function logEvent(packetId, event, { signerId = null, detail = null, ip = null } = {}) {
  try {
    await db.query(`INSERT INTO esign_events (packet_id, signer_id, event, detail, ip) VALUES ($1,$2,$3,$4,$5)`,
      [packetId, signerId, event, detail, ip]);
  } catch (e) { /* the audit line is secondary to the action */ }
}

const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");

// ── Formatting ──────────────────────────────────────────────

function longDate(v) {
  if (!v) return "";
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(v);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
}
function todayPT() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric" });
}
function stampPT(d) {
  return new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "long", timeStyle: "long" });
}
function formatValue(type, v) {
  if (v === null || v === undefined || v === "") return "";
  if (type === "date") return longDate(v);
  if (type === "money") {
    const n = Number(String(v).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  }
  return String(v);
}

// ── What the matter already knows ───────────────────────────

async function matterValues(caseId) {
  const out = { today: todayPT() };
  if (!caseId) return out;
  const c = await require("./civil-litigation").getCase(Number(caseId));
  if (!c) throw new Error("Matter not found");
  for (const k of ["case_name", "case_number", "court", "county", "jurisdiction", "case_type", "our_role", "opposing_party",
                   "fee_arrangement_notes", "contingency_pct"]) {
    if (c[k] !== null && c[k] !== undefined) out[k] = String(c[k]);
  }
  for (const k of ["filed_date", "service_date", "trial_date", "cmc_date"]) if (c[k]) out[k] = c[k];
  if (c.hourly_rate) out.hourly_rate = c.hourly_rate;
  if (c.retainer_amount) out.retainer_amount = c.retainer_amount;

  await clientValues(c.client_key, out, { hearings: false });

  try {
    const h = (await db.query(
      `SELECT * FROM civil_hearings WHERE case_id = $1 AND status = 'scheduled' AND hearing_date >= CURRENT_DATE
        ORDER BY hearing_date, hearing_time NULLS LAST LIMIT 1`, [c.id])).rows[0];
    if (h) {
      out.next_hearing_date = h.hearing_date;
      if (h.hearing_time) out.next_hearing_time = h.hearing_time;
      if (h.hearing_type) out.next_hearing_type = h.hearing_type;
      if (h.department) out.next_hearing_department = h.department;
      if (h.judge) out.next_hearing_judge = h.judge;
      if (h.location) out.next_hearing_location = h.location;
    }
  } catch (e) { /* no hearings table yet */ }
  return out;
}

/**
 * What a client's profile knows (immigration and every other client):
 * name, A-number, contact details, language — and, unless a civil matter
 * already supplied it, the next hearing from their hearing notes.
 */
async function clientValues(clientKey, out = {}, { hearings = true } = {}) {
  if (!clientKey) return out;
  let p = null;
  try { p = await require("./client-profiles").getClientByKey(clientKey); }
  catch (e) { return out; }   // the form still works; the user types the name
  if (!p) return out;
  const map = { client_name: "client_name", client_email: "client_email", client_phone: "client_phone",
    client_address: "client_address", a_number: "a_number", client_language: "client_language", date_of_birth: "date_of_birth" };
  for (const [src, key] of Object.entries(map)) if (p[src] && out[key] === undefined) out[key] = p[src];
  if (p.case_type && out.case_type === undefined) out.case_type = p.case_type;
  if (hearings && out.next_hearing_date === undefined) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const day = v => (v instanceof Date ? v.toISOString() : String(v || "")).slice(0, 10);
    const next = [[p.next_hearing_date, p.next_hearing_type], [p.hearing_date, p.hearing_type]]
      .find(([d]) => d && day(d) >= today);
    if (next) {
      out.next_hearing_date = day(next[0]);
      if (next[1]) out.next_hearing_type = next[1];
      if (p.judge_name) out.next_hearing_judge = p.judge_name;
      if (p.court_location) out.next_hearing_location = p.court_location;
    }
  }
  return out;
}

/** Where a document is being prepared: a civil matter, or a client (immigration and others). */
function targetOf(t) {
  if (t && typeof t === "object") return { caseId: t.caseId ? Number(t.caseId) : null, clientKey: t.clientKey || null };
  return { caseId: t ? Number(t) : null, clientKey: null };
}

/** The form to prepare a document: fields pre-filled from the matter or client, signers suggested. */
async function prefill(templateId, target, { user = null } = {}) {
  const t = await templates.getTemplate(templateId);
  if (t.status !== "active") throw new Error("That template is still a draft. Review and activate it on the Templates page first.");
  const { caseId, clientKey } = targetOf(target);
  const known = caseId ? await matterValues(caseId) : await clientValues(clientKey, { today: todayPT() });
  if (!caseId && clientKey && !known.client_name) throw new Error("Client not found");
  const fields = (t.fields || []).map(f => {
    const raw = f.source && f.source !== "ask" ? known[f.source] : undefined;
    const type = f.type === "text" && /date$/.test(f.source || "") ? "date" : f.type;
    return { key: f.key, label: f.label, type, source: f.source, value: raw === undefined ? "" : formatValue(type, raw) };
  });
  const signers = (t.signers || []).map(s => {
    const isClient = s.role === "client";
    const isAttorney = s.role === "attorney";
    return {
      role: s.role, label: s.label,
      name: isClient ? (known.client_name || "") : isAttorney ? ((user && user.n) || "") : "",
      email: isClient ? (known.client_email || "") : "",
      phone: isClient ? (known.client_phone || "") : "",
      sign_order: isAttorney ? 2 : 1,
    };
  });
  return {
    template: { id: t.id, name: t.name, category: t.category, description: t.description },
    title: t.name + (known.case_name ? " — " + known.case_name : known.client_name ? " — " + known.client_name : ""),
    fields, signers,
  };
}

// ── Preparing a packet ──────────────────────────────────────

function cleanSigner(s, i) {
  const name = String(s.name || "").trim();
  if (name.length < 2) throw new Error(`Enter a name for signer ${i + 1} (${s.label || s.role})`);
  const email = String(s.email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${name}: that email address does not look right`);
  const phone = String(s.phone || "").replace(/[^\d+]/g, "");
  return {
    role: String(s.role), label: String(s.label || s.role).slice(0, 60), name: name.slice(0, 200),
    email: email || null, phone: phone.length >= 10 ? (phone.startsWith("+") ? phone : "+1" + phone.slice(-10)) : null,
    sign_order: Math.max(1, Math.min(5, parseInt(s.sign_order, 10) || 1)),
  };
}

async function createPacket({ templateId, caseId = null, clientKey = null, title = null, values = {}, signers = [], message = null, user = null }) {
  await initTables();
  const t = await templates.getTemplate(templateId, { withDocx: true });
  if (t.status !== "active") throw new Error("That template is still a draft");
  const roles = new Set((t.signers || []).map(s => s.role));
  const list = (signers || []).map(cleanSigner);
  for (const r of roles) if (!list.some(s => s.role === r)) throw new Error(`Add the ${(t.signers.find(s => s.role === r) || {}).label || r} as a signer`);
  if (list.some(s => !roles.has(s.role))) throw new Error("A signer was given a spot this document does not have");

  // Values the form typed in, formatted by type.
  const typed = {};
  for (const f of t.fields || []) typed[f.key] = formatValue(f.type === "text" && /date$/.test(f.source || "") ? "date" : f.type, values[f.key]);
  const filled = docx.fill(t.docx, typed);
  if (filled.missing.length) {
    const labels = filled.missing.map(k => ((t.fields || []).find(f => f.key === k) || {}).label || k);
    throw new Error("Fill in: " + labels.join(", "));
  }

  if (caseId) {
    const c = await require("./civil-litigation").getCase(Number(caseId));
    if (!c) throw new Error("Matter not found");
    clientKey = c.client_key;
  } else if (clientKey) {
    const known = await clientValues(clientKey, {}, { hearings: false });
    if (!known.client_name) throw new Error("Client not found");
  }
  const p = (await db.query(
    `INSERT INTO esign_packets (template_id, template_name, category, case_id, client_key, title, field_values, docx, doc_hash, status, message, created_by, created_by_uid)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'draft',$10,$11,$12) RETURNING id`,
    [t.id, t.name, t.category, caseId ? Number(caseId) : null, clientKey,
     String(title || t.name).slice(0, 200), JSON.stringify(typed), filled.buffer, sha256(filled.buffer),
     message ? String(message).slice(0, 1000) : null, (user && (user.n || user.u)) || null, (user && user.uid) || null]
  )).rows[0];
  for (const s of list) {
    await db.query(
      `INSERT INTO esign_signers (packet_id, role, label, name, email, phone, sign_order, token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + INTERVAL '${LINK_DAYS} days')`,
      [p.id, s.role, s.label, s.name, s.email, s.phone, s.sign_order, crypto.randomBytes(24).toString("base64url")]);
  }
  await logEvent(p.id, "created", { detail: `Prepared by ${(user && (user.n || user.u)) || "staff"} from template "${t.name}"` });
  return getPacket(p.id);
}

async function getPacket(id, { withBytes = false, includeTokens = false } = {}) {
  await initTables();
  const p = (await db.query(`SELECT * FROM esign_packets WHERE id = $1`, [Number(id)])).rows[0];
  if (!p) throw new Error("Document not found");
  const signers = (await db.query(`SELECT * FROM esign_signers WHERE packet_id = $1 ORDER BY sign_order, id`, [p.id])).rows;
  return shape(p, signers, { withBytes, includeTokens: includeTokens || withBytes });
}

// Signing tokens ARE the access to sign. They leave this module only for
// the code that emails them and for the staff "copy link" route.
function shape(p, signers, { withBytes = false, includeTokens = false } = {}) {
  const out = { ...p };
  if (!withBytes) {
    delete out.docx; delete out.signed_docx; delete out.signed_pdf;
    out.has_signed_docx = !!p.signed_docx; out.has_signed_pdf = !!p.signed_pdf;
  }
  out.signers = signers.map(s => {
    const o = { ...s };
    if (!withBytes) { delete o.signature_png; o.has_signature = !!s.signature_png; }
    if (!includeTokens) delete o.token;
    return o;
  });
  return out;
}

async function listPackets({ caseId = null, clientKey = null, limit = 50 } = {}) {
  await initTables();
  // A client's page shows everything prepared for that client, including
  // documents prepared on any of their civil matters.
  const where = caseId ? "WHERE case_id = $1" : clientKey ? "WHERE client_key = $1" : "";
  const r = await db.query(
    `SELECT id FROM esign_packets ${where} ORDER BY created_at DESC LIMIT ${Math.min(200, limit)}`,
    caseId ? [Number(caseId)] : clientKey ? [String(clientKey)] : []);
  const out = [];
  for (const row of r.rows) out.push(await getPacket(row.id));
  return out;
}

// ── Sending ─────────────────────────────────────────────────

function signUrl(baseUrl, token) {
  return `${String(baseUrl || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com").replace(/\/$/, "")}/sign/e/${token}`;
}

function mailer() {
  const nodemailer = require("nodemailer");
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    return { from: process.env.SMTP_USER, t: nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: parseInt(process.env.SMTP_PORT, 10) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) };
  }
  if (process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD) {
    return { from: process.env.GMAIL_EMAIL, t: nodemailer.createTransport({
      service: "gmail", auth: { user: process.env.GMAIL_EMAIL, pass: process.env.GMAIL_APP_PASSWORD } }) };
  }
  return null;
}

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** Email and/or text one signer their link. Never throws: returns what happened. */
async function deliver(p, s, { baseUrl, reminder = false } = {}) {
  const url = signUrl(baseUrl || p.link_base, s.token);
  const via = [], errors = [];
  const intro = reminder ? "A reminder: " : "";
  if (s.email) {
    const m = mailer();
    if (!m) errors.push("email is not set up on the server (SMTP_* or GMAIL_* settings)");
    else {
      try {
        await m.t.sendMail({
          from: `"Tez Law P.C." <${m.from}>`, to: s.email,
          subject: `${reminder ? "Reminder — " : ""}Please sign: ${p.title}`,
          text: `Hello ${s.name},\n\n${intro}Tez Law P.C. has sent you "${p.title}" to review and sign.\n\n` +
            (p.message ? p.message + "\n\n" : "") + `Open this private link to read and sign it:\n${url}\n\n` +
            `The link is for you only; please do not forward it. Questions: 626-678-8677.\n\nTez Law P.C.`,
          html: `<div style="font-family:Georgia,serif;max-width:560px;color:#3E2818;">` +
            `<p>Hello ${esc(s.name)},</p><p>${esc(intro)}Tez Law P.C. has sent you <strong>${esc(p.title)}</strong> to review and sign.</p>` +
            (p.message ? `<p style="white-space:pre-wrap;">${esc(p.message)}</p>` : "") +
            `<p><a href="${esc(url)}" style="display:inline-block;padding:12px 22px;background:#5A3B22;color:#FBF3DE;text-decoration:none;border-radius:5px;">Review and sign</a></p>` +
            `<p style="font-size:12px;color:#7B5330;">This link is for you only; please do not forward it. Questions: 626-678-8677.</p></div>`,
        });
        via.push("email");
      } catch (e) { errors.push("email failed: " + e.message); }
    }
  }
  if (s.phone) {
    if (!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER)) {
      errors.push("text messages are not set up on the server (TWILIO_* settings)");
    } else {
      try {
        const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilio.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: s.phone,
          body: `Tez Law P.C.: ${intro}please review and sign "${p.title}": ${url}` });
        via.push("sms");
      } catch (e) { errors.push("text failed: " + e.message); }
    }
  }
  await db.query(
    `UPDATE esign_signers SET status = CASE WHEN status = 'waiting' THEN 'sent' ELSE status END,
            sent_at = COALESCE(sent_at, NOW()), sent_via = $2, delivery_error = $3 WHERE id = $1`,
    [s.id, via.join("+") || "link", errors.join("; ") || null]);
  await logEvent(p.id, reminder ? "reminded" : "sent", { signerId: s.id,
    detail: `${s.name}: ${via.length ? "sent by " + via.join(" and ") : "link ready to hand over (not emailed or texted)"}${errors.length ? " — " + errors.join("; ") : ""}` });
  return { signer_id: s.id, name: s.name, url, via, errors };
}

/** The signers whose turn it is now. */
function currentGroup(signers) {
  const open = signers.filter(s => s.status !== "signed");
  if (!open.length) return [];
  const order = Math.min(...open.map(s => s.sign_order));
  return open.filter(s => s.sign_order === order);
}

async function sendPacket(id, { baseUrl = null, user = null } = {}) {
  const p = await getPacket(id, { withBytes: true });
  if (p.status !== "draft") throw new Error(`This document was already ${p.status === "sent" ? "sent" : p.status}`);
  // Claimed, so a double-click cannot email everyone twice. The address the
  // links point to is fixed now, by staff — never by whoever opens a link.
  const claim = await db.query(
    `UPDATE esign_packets SET status = 'sent', sent_at = NOW(), link_base = $2 WHERE id = $1 AND status = 'draft' RETURNING id`,
    [p.id, baseUrl || null]);
  if (!claim.rows.length) throw new Error("This document was already sent");
  p.link_base = baseUrl || null;
  await logEvent(p.id, "released", { detail: `Sent for signature by ${(user && (user.n || user.u)) || "staff"}` });
  const results = [];
  for (const s of currentGroup(p.signers)) results.push(await deliver(p, s, { baseUrl }));
  return { packet: await getPacket(p.id), delivered: results };
}

async function packetIdForSigner(signerId) {
  await initTables();
  const r = await db.query(`SELECT * FROM esign_signers WHERE id = $1`, [Number(signerId)]);
  if (!r.rows[0]) throw new Error("Signer not found");
  return r.rows[0].packet_id;
}

async function remind(signerId, { baseUrl = null } = {}) {
  await initTables();
  const s = (await db.query(`SELECT * FROM esign_signers WHERE id = $1`, [Number(signerId)])).rows[0];
  if (!s) throw new Error("Signer not found");
  const p = await getPacket(s.packet_id);
  if (p.status !== "sent") throw new Error("This document is not out for signature");
  if (s.status === "signed") throw new Error(`${s.name} has already signed`);
  if (!currentGroup(p.signers).some(x => x.id === s.id)) throw new Error(`It is not ${s.name}'s turn yet`);
  await db.query(`UPDATE esign_signers SET expires_at = GREATEST(expires_at, NOW() + INTERVAL '${LINK_DAYS} days') WHERE id = $1`, [s.id]);
  return deliver(p, s, { baseUrl, reminder: true });
}

async function cancelPacket(id, { user = null, reason = null } = {}) {
  const p = await getPacket(id);
  if (p.status === "completed") throw new Error("This document is fully signed; it cannot be cancelled");
  await db.query(`UPDATE esign_packets SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [p.id]);
  await logEvent(p.id, "cancelled", { detail: `Cancelled by ${(user && (user.n || user.u)) || "staff"}${reason ? ": " + reason : ""}` });
  return getPacket(p.id);
}

// ── The signer's side ───────────────────────────────────────

async function bySigner(token) {
  await initTables();
  const t = String(token || "");
  if (t.length < 20) return null;
  const s = (await db.query(`SELECT * FROM esign_signers WHERE token = $1`, [t])).rows[0];
  if (!s) return null;
  const p = await getPacket(s.packet_id, { withBytes: true });
  return { s: p.signers.find(x => x.id === s.id), p };
}

function signedMap(signers) {
  const map = {};
  for (const s of signers) {
    if (s.status === "signed" && s.signature_png) {
      map[s.role] = { png: s.signature_png, name: s.typed_name || s.name, date: longDate(new Date(s.signed_at).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })) };
    }
  }
  return map;
}

/** What the signing page shows. Marks the link viewed. */
async function signerView(token, { ip = null } = {}) {
  const found = await bySigner(token);
  if (!found) return { ok: false, status: 404, error: "This signing link is not valid. Check that the whole link was copied." };
  const { s, p } = found;
  const base = { title: p.title, signer: { name: s.name, label: s.label, role: s.role } };
  if (p.status === "cancelled") return { ok: false, status: 410, error: "This document was withdrawn by Tez Law P.C. You do not need to sign it.", ...base };
  if (s.status === "signed") return { ok: true, signed: true, signed_at: s.signed_at, completed: p.status === "completed", ...base };
  if (s.status === "declined" || p.status === "declined") return { ok: false, status: 410, error: "Signing was declined for this document. Please contact Tez Law P.C. at 626-678-8677.", ...base };
  if (s.expires_at && new Date(s.expires_at) < new Date()) return { ok: false, status: 410, error: "This link has expired. Please ask Tez Law P.C. to send it again.", ...base };
  if (p.status !== "sent") return { ok: false, status: 409, error: "This document has not been sent for signature yet.", ...base };
  const turn = currentGroup(p.signers).some(x => x.id === s.id);

  if (!s.viewed_at) {
    await db.query(`UPDATE esign_signers SET viewed_at = NOW(), status = CASE WHEN status IN ('waiting','sent') THEN 'viewed' ELSE status END WHERE id = $1`, [s.id]);
    await logEvent(p.id, "viewed", { signerId: s.id, ip, detail: `${s.name} opened the document` });
  }
  // Show the document as it stands: earlier signatures in place, this
  // signer's spots highlighted.
  const current = docx.applySignatures(p.docx, signedMap(p.signers)).buffer;
  const html = sanitizeHtml((await require("mammoth").convertToHtml({ buffer: current })).value);
  return {
    ok: true, signed: false, your_turn: turn,
    waiting_for: turn ? [] : currentGroup(p.signers).map(x => x.name),
    document_html: markSpots(html, s.role),
    consent_text: CONSENT_TEXT,
    message: p.message || null,
    ...base,
  };
}

// mammoth does not sanitise. A template made from an outside document could
// carry a javascript: link; the signing page is public. Keep only the tags
// and attributes a document needs.
const ALLOWED_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "sup", "sub",
  "br", "a", "img", "table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "blockquote", "span"]);
function sanitizeHtml(html) {
  return String(html || "").replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (all, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return "";
    if (close) return `</${t}>`;
    const keep = [];
    const get = n => { const m = attrs.match(new RegExp(`\\s${n}\\s*=\\s*"([^"]*)"`, "i")); return m ? m[1] : null; };
    if (t === "a") {
      const href = get("href");
      if (href && /^(https?:|mailto:|#)/i.test(href.trim())) keep.push(`href="${href}" rel="noopener noreferrer" target="_blank"`);
      const id = get("id"); if (id && /^[\w-]+$/.test(id)) keep.push(`id="${id}"`);
    } else if (t === "img") {
      const src = get("src");
      if (!src || !/^data:image\/(png|jpeg|jpg|gif);base64,[A-Za-z0-9+/=]+$/i.test(src)) return "";
      keep.push(`src="${src}"`);
    } else if (t === "td" || t === "th") {
      for (const n of ["colspan", "rowspan"]) { const v = get(n); if (v && /^\d+$/.test(v)) keep.push(`${n}="${v}"`); }
    }
    return `<${t}${keep.length ? " " + keep.join(" ") : ""}${/\/\s*$/.test(attrs) ? " /" : ""}>`;
  });
}

function markSpots(html, role) {
  return String(html).replace(/\{\{\s*(sig|date|name|initials):([a-z0-9_]+)\s*\}\}/gi, (_, kind, r) => {
    const mine = r === role;
    const label = kind === "sig" ? (mine ? "✍ Your signature goes here" : "Signature of another signer")
      : kind === "date" ? (mine ? "Date (filled in when you sign)" : "Date") : (mine ? "Your name" : "Name");
    return `<span class="esign-spot${mine ? " esign-mine" : ""}" data-kind="${kind}">${label}</span>`;
  });
}

function decodePng(dataUrl) {
  const m = String(dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error("Draw your signature in the box");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > MAX_SIG_BYTES) throw new Error("That signature image is too large");
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Draw your signature in the box");
  return buf;
}

async function sign(token, { typed_name, signature, consent, ip = null, userAgent = null, baseUrl = null } = {}) {
  const found = await bySigner(token);
  if (!found) throw Object.assign(new Error("This signing link is not valid"), { status: 404 });
  const { s, p } = found;
  if (p.status !== "sent") throw Object.assign(new Error("This document is not open for signing"), { status: 409 });
  if (s.status === "signed") throw Object.assign(new Error("You have already signed this document"), { status: 409 });
  if (s.expires_at && new Date(s.expires_at) < new Date()) throw Object.assign(new Error("This link has expired"), { status: 410 });
  if (!currentGroup(p.signers).some(x => x.id === s.id)) throw Object.assign(new Error("It is not your turn to sign yet"), { status: 409 });
  if (consent !== true) throw Object.assign(new Error("Please tick the box to agree to sign electronically"), { status: 400 });
  const name = String(typed_name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2) throw Object.assign(new Error("Type your full name"), { status: 400 });
  const png = decodePng(signature);

  // Only the first submission counts, even if two arrive together.
  const r = await db.query(
    `UPDATE esign_signers SET status = 'signed', signed_at = NOW(), typed_name = $2, signature_png = $3,
            consent_text = $4, ip = $5, user_agent = $6
      WHERE id = $1 AND status <> 'signed' RETURNING id`,
    [s.id, name.slice(0, 200), png, CONSENT_TEXT, ip, userAgent ? String(userAgent).slice(0, 400) : null]);
  if (!r.rows.length) throw Object.assign(new Error("You have already signed this document"), { status: 409 });
  await logEvent(p.id, "signed", { signerId: s.id, ip,
    detail: `${name} signed as ${s.label || s.role}${name.toLowerCase() !== s.name.toLowerCase() ? ` (sent to ${s.name})` : ""}; document SHA-256 ${p.doc_hash}` });

  const after = await getPacket(p.id, { withBytes: true });
  const next = currentGroup(after.signers);
  if (!next.length) {
    // Exactly one request finishes the document, even if the last two
    // signers press Sign at the same moment — and not if it was cancelled.
    const claim = await db.query(
      `UPDATE esign_packets SET status = 'completed', completed_at = NOW() WHERE id = $1 AND status = 'sent' RETURNING id`, [p.id]);
    if (!claim.rows.length) return { ok: true, completed: true };
    await logEvent(p.id, "completed", { detail: `All ${after.signers.length} signature(s) collected` });
    // Filing (Word, Dropbox's PDF, certificate) can take a minute: it runs
    // after the signer is told they are done, and a failure is recorded on
    // the document for staff to retry — never shown to the signer as
    // "your signature was not saved".
    const finalizing = finalize(p.id).catch(async (e) => {
      console.warn("[esign] finalize failed:", e.message);
      try { await db.query(`UPDATE esign_packets SET finalize_error = $2 WHERE id = $1`, [p.id, e.message]); } catch (x) { /* ignore */ }
    });
    return { ok: true, completed: true, finalizing };
  }
  // Hand over to whoever is next — each link sent once, even when two
  // signers finish together.
  const delivered = [];
  for (const n of next) {
    if (n.sent_at) continue;
    const c = await db.query(`UPDATE esign_signers SET sent_at = NOW() WHERE id = $1 AND sent_at IS NULL RETURNING id`, [n.id]);
    if (c.rows.length) delivered.push(await deliver(after, n, { baseUrl: null }));
  }
  return { ok: true, completed: false, next: next.map(n => n.name), delivered };
}

async function decline(token, { reason = null, ip = null } = {}) {
  const found = await bySigner(token);
  if (!found) throw Object.assign(new Error("This signing link is not valid"), { status: 404 });
  const { s, p } = found;
  if (s.status === "signed") throw Object.assign(new Error("You have already signed"), { status: 409 });
  if (p.status !== "sent") throw Object.assign(new Error("This document is not open for signing"), { status: 409 });
  if (s.expires_at && new Date(s.expires_at) < new Date()) throw Object.assign(new Error("This link has expired"), { status: 410 });
  await db.query(`UPDATE esign_signers SET status = 'declined', decline_reason = $2 WHERE id = $1`, [s.id, reason ? String(reason).slice(0, 1000) : null]);
  await db.query(`UPDATE esign_packets SET status = 'declined' WHERE id = $1`, [p.id]);
  await logEvent(p.id, "declined", { signerId: s.id, ip, detail: `${s.name} declined to sign${reason ? ": " + reason : ""}` });
  await notify(p, `✋ ${s.name} declined to sign "${p.title}"${reason ? ": " + String(reason).slice(0, 120) : ""}`);
  return { ok: true };
}

async function notify(p, text) {
  try {
    if (p.created_by_uid) await require("./push-notifications").sendToUser("firm", String(p.created_by_uid), { title: "E-signature", body: text, data: { type: "esign", packet_id: p.id } });
  } catch (e) { /* best effort */ }
}

// ── Finishing ───────────────────────────────────────────────

async function certificatePdf(p, signers, events) {
  const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  let y = 740;
  const clean = s => String(s || "").replace(/[^\x20-\x7E -ÿ]/g, "?");
  const line = (text, { f = font, size = 10, color = rgb(0.24, 0.16, 0.09), indent = 0 } = {}) => {
    const words = clean(text).split(" ");
    let cur = "";
    const flush = () => {
      if (y < 60) { page = pdf.addPage([612, 792]); y = 740; }
      page.drawText(cur, { x: 54 + indent, y, size, font: f, color }); y -= size + 4; cur = "";
    };
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (f.widthOfTextAtSize(t, size) > 504 - indent) flush(), cur = w; else cur = t;
    }
    if (cur) flush();
  };
  line("CERTIFICATE OF ELECTRONIC SIGNATURE", { f: bold, size: 14 });
  y -= 4;
  line(`Document: ${p.title}`, { f: bold });
  line(`Reference: TEZ-ESIGN-${p.id}   Prepared by: ${p.created_by || "Tez Law P.C."}`);
  line(`Document as sent (SHA-256): ${p.doc_hash}`, { size: 8 });
  line(`Document as signed (SHA-256): ${p.signed_hash}`, { size: 8 });
  line(`Completed: ${stampPT(p.completed_at || new Date())}`);
  y -= 8;
  for (const s of signers) {
    line(`${s.label || s.role}: ${s.typed_name || s.name}`, { f: bold, size: 11 });
    if (s.signature_png) {
      try {
        const img = await pdf.embedPng(s.signature_png);
        const w = 150, h = Math.min(60, w * img.height / img.width);
        if (y - h < 60) { page = pdf.addPage([612, 792]); y = 740; }
        page.drawImage(img, { x: 60, y: y - h, width: w, height: h }); y -= h + 6;
      } catch (e) { /* the record below still stands */ }
    }
    line(`Sent to: ${s.name}${s.email ? " <" + s.email + ">" : ""}${s.phone ? " " + s.phone : ""}   via ${s.sent_via || "link"}`, { indent: 6 });
    if (s.sent_at) line(`Sent: ${stampPT(s.sent_at)}`, { indent: 6 });
    if (s.viewed_at) line(`First opened: ${stampPT(s.viewed_at)}`, { indent: 6 });
    line(`Signed: ${stampPT(s.signed_at)}   IP address: ${s.ip || "unknown"}`, { indent: 6 });
    if (s.user_agent) line(`Device: ${s.user_agent}`, { indent: 6, size: 8 });
    line(`Agreed to sign electronically: "${s.consent_text || CONSENT_TEXT}"`, { indent: 6, size: 8 });
    y -= 6;
  }
  y -= 4;
  line("AUDIT TRAIL", { f: bold, size: 11 });
  for (const e of events) line(`${stampPT(e.at)} — ${e.event}${e.detail ? ": " + e.detail : ""}${e.ip ? " (IP " + e.ip + ")" : ""}`, { size: 8 });
  y -= 6;
  line("Each signer consented to use electronic signatures, reviewed the document, typed their name and drew their signature. " +
       "Electronic signatures are valid under the federal ESIGN Act (15 U.S.C. § 7001 et seq.) and California's Uniform Electronic Transactions Act (Civ. Code § 1633.1 et seq.).",
       { size: 8, color: rgb(0.48, 0.33, 0.19) });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function dropboxPdf(path) {
  const dbx = require("./dropbox-integration");
  const token = await dbx.getAccessToken();
  const root = await dbx.getPathRootHeader();
  const headers = { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path }) };
  if (root) headers["Dropbox-API-Path-Root"] = root;
  const r = await require("axios").post("https://content.dropboxapi.com/2/files/get_preview", null,
    { headers, responseType: "arraybuffer", timeout: 90000 });
  return Buffer.from(r.data);
}

async function mergePdfs(a, b) {
  const { PDFDocument } = require("pdf-lib");
  const out = await PDFDocument.create();
  for (const buf of [a, b]) {
    const src = await PDFDocument.load(buf);
    for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
  }
  return Buffer.from(await out.save({ useObjectStreams: false }));
}

function fileBase(p) {
  return `${String(p.title).replace(/[\/\\:?*"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90)} - signed ${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}`;
}

async function fileToClientFolder(p, signed, cert) {
  const dbx = require("./dropbox-integration");
  const errors = [];
  if (!dbx.isConfigured || !(await Promise.resolve(dbx.isConfigured()))) throw new Error("Dropbox is not connected; the signed copies are kept here to download");
  const c = await require("./client-profiles").getClientByKey(p.client_key);
  if (!c) throw new Error("Client not found; the signed copies are kept here to download");
  const folder = await dbx.resolveClientFolder({ clientKey: c.key, clientName: c.client_name, aNumber: c.a_number });
  if (!folder) throw new Error("This client has no Dropbox folder linked (set it on the client's profile); the signed copies are kept here to download");
  const dir = `${folder}/Signed Documents`;
  try { await dbx.createFolder(dir); } catch (e) { /* already there */ }
  const base = fileBase(p);
  const up1 = await dbx.uploadFile({ path: `${dir}/${base}.docx`, buffer: signed, mode: "add", autorename: true });
  const docxPath = (up1 && (up1.path_display || up1.path_lower)) || `${dir}/${base}.docx`;
  let pdf = cert;
  try { pdf = await mergePdfs(await dropboxPdf(docxPath), cert); }
  catch (e) { errors.push("PDF of the document could not be made (" + e.message + "); the PDF holds the signature certificate only"); }
  const up2 = await dbx.uploadFile({ path: `${dir}/${base}.pdf`, buffer: pdf, mode: "add", autorename: true });
  const pdfPath = (up2 && (up2.path_display || up2.path_lower)) || `${dir}/${base}.pdf`;
  try { if (dbx.clearListCache) dbx.clearListCache(folder); } catch (e) { /* cache only */ }
  return { docxPath, pdfPath, pdf, errors };
}

async function finalize(id) {
  const p = await getPacket(id, { withBytes: true });
  if (p.status !== "completed") throw new Error("Not every signer has signed yet");
  const signed = docx.applySignatures(p.docx, signedMap(p.signers)).buffer;
  const signedHash = sha256(signed);
  await db.query(`UPDATE esign_packets SET signed_docx = $2, signed_hash = $3, finalize_error = NULL WHERE id = $1`,
    [p.id, signed, signedHash]);
  const done = await getPacket(p.id, { withBytes: true });
  const events = (await db.query(`SELECT * FROM esign_events WHERE packet_id = $1 ORDER BY at, id`, [p.id])).rows;
  const cert = await certificatePdf(done, done.signers, events);

  // File it. Without a matter or Dropbox, the signed copies stay here to download.
  const errors = [];
  let docxPath = null, pdfPath = null, pdf = cert;
  if (p.case_id) {
    try {
      const up = require("./civil-upload");
      const category = p.category === "retainer" ? "billing" : null;
      const base = fileBase(p);
      const r1 = await up.uploadToCase(p.case_id, [{ originalname: base + ".docx", buffer: signed }],
        { category, by: "e-signature", provisionIfMissing: true });
      if (r1.uploaded && r1.uploaded[0]) docxPath = r1.uploaded[0].path;
      else errors.push((r1.failed && r1.failed[0] && r1.failed[0].error) || "Word copy not filed");
      // Dropbox makes the PDF from the Word file, so it looks exactly like it.
      if (docxPath) {
        try { pdf = await mergePdfs(await dropboxPdf(docxPath), cert); }
        catch (e) { errors.push("PDF of the document could not be made (" + e.message + "); the PDF holds the signature certificate only"); }
      }
      const r2 = await up.uploadToCase(p.case_id, [{ originalname: base + ".pdf", buffer: pdf }],
        { category, by: "e-signature", provisionIfMissing: false });
      if (r2.uploaded && r2.uploaded[0]) pdfPath = r2.uploaded[0].path;
    } catch (e) { errors.push(e.message); }
    try {
      await require("./civil-litigation").logEvent(p.case_id, {
        event_kind: "note", event_date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
        title: `Signed: ${p.title}`,
        description: done.signers.map(s => `${s.label || s.role}: ${s.typed_name} — ${stampPT(s.signed_at)}`).join("\n") +
          (pdfPath ? `\nFiled to Dropbox: ${pdfPath}` : "") + (errors.length ? `\nNote: ${errors.join("; ")}` : ""),
        created_by: "e-signature",
      });
    } catch (e) { /* the signature record stands on its own */ }
  }
  if (!p.case_id && p.client_key) {
    // An immigration (or any non-civil) client: their own Dropbox folder,
    // in a "Signed Documents" subfolder.
    try {
      const filed = await fileToClientFolder(p, signed, cert);
      docxPath = filed.docxPath; pdfPath = filed.pdfPath; pdf = filed.pdf;
      errors.push(...filed.errors);
    } catch (e) { errors.push(e.message); }
  }
  await db.query(`UPDATE esign_packets SET signed_pdf = $2, dropbox_docx = $3, dropbox_pdf = $4, finalize_error = $5 WHERE id = $1`,
    [p.id, pdf, docxPath, pdfPath, errors.join("; ") || null]);
  await notify(done, `✅ "${p.title}" is fully signed${pdfPath ? " and filed in Dropbox" : ""}`);
  return getPacket(p.id);
}

/** Staff: file a completed document again (after Dropbox was down). */
async function refinalize(id) {
  const p = await getPacket(id);
  if (p.status !== "completed") throw new Error("Only a fully signed document can be filed");
  if (p.dropbox_pdf && !p.finalize_error) throw new Error("This document is already filed: " + p.dropbox_pdf);
  return finalize(p.id);
}

async function download(id, which) {
  const p = await getPacket(id, { withBytes: true });
  const base = String(p.title).replace(/[\/\\:?*"<>|]+/g, " ").trim().slice(0, 90);
  if (which === "signed-pdf") { if (!p.signed_pdf) throw new Error("Not signed yet"); return { buffer: p.signed_pdf, name: base + " - signed.pdf", type: "application/pdf" }; }
  if (which === "signed-docx") { if (!p.signed_docx) throw new Error("Not signed yet"); return { buffer: p.signed_docx, name: base + " - signed.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }; }
  return { buffer: p.docx, name: base + ".docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
}

module.exports = {
  CONSENT_TEXT, LINK_DAYS, initTables, matterValues, clientValues, prefill, formatValue, longDate,
  createPacket, getPacket, listPackets, sendPacket, remind, cancelPacket, packetIdForSigner,
  signerView, sign, decline, finalize, refinalize, download, sanitizeHtml, certificatePdf, currentGroup, signUrl, markSpots,
};
