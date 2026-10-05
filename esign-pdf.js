// ============================================================
//  esign-pdf.js — upload any document and send it for signature
//  TEZ Law Firm (Tez Law P.C.)
// ------------------------------------------------------------
//  JJ: "i want a upload signatory document and sent document for
//  esign just like dropbox esign function."
//
//  The firm's e-signature (esign.js) worked only from a Word
//  TEMPLATE the firm had prepared in advance. A lease the other
//  side drafted, a form from a court, a one-off agreement — none
//  of those could be sent. This adds the other way in:
//
//    1. upload a PDF (or a photo/scan: JPG, PNG)
//    2. say who signs, and in what order
//    3. put the fields on the pages — signature, initials, date,
//       name, a text box, a checkbox — each belonging to a signer
//    4. send. Each signer gets a private link, fills in only
//       their own fields, and signs.
//    5. when the last one signs, their marks are stamped onto the
//       PDF, the certificate of signature is appended, the result
//       is filed and (if asked) emailed to everyone.
//
//  It is the same PACKET as a template document — same signers,
//  same private links, same order of signing, same consent, same
//  audit trail and certificate. Only what is signed differs: a
//  PDF with placed fields instead of a Word file with marked spots.
//
//  Where a field sits is kept as fractions of the page as it is
//  DISPLAYED (0–1 from the left and from the top), so the same
//  numbers work on a phone, on a laptop and when stamping the PDF,
//  whatever size the page is drawn at and however it is rotated.
// ============================================================

const crypto = require("crypto");
const db = require("./db");

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 150;
const MAX_FIELDS = 400;
const MAX_SIGNERS = 10;
const MAX_IMAGE_BYTES = 400 * 1024;          // one drawn signature, initials, or rendered text
const FIELD_TYPES = ["signature", "initials", "date", "name", "text", "checkbox"];
// Filled in by the server when the person signs; the signer types nothing.
const AUTO_TYPES = new Set(["date", "name"]);

const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const E = () => require("./esign");
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ── What was uploaded ───────────────────────────────────────

function sniff(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
  // Some PDFs carry a few junk bytes before the header.
  if (buf.slice(0, 1024).toString("latin1").includes("%PDF-")) return "pdf";
  if (buf.readUInt32BE(0) === 0x89504e47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  return null;
}

function pageInfo(page) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const flipped = rot === 90 || rot === 270;
  return { w: Math.round((flipped ? box.height : box.width) * 100) / 100, h: Math.round((flipped ? box.width : box.height) * 100) / 100, rotation: rot };
}

/**
 * Turn an upload into the PDF that will be signed.
 * A PDF is kept byte for byte. A photo or scan becomes a one-page PDF.
 * @returns {{pdf:Buffer, pages:Array<{w,h,rotation}>, kind:string}}
 */
async function normalize(buffer) {
  if (!buffer || !buffer.length) throw bad("No file was received.");
  if (buffer.length > MAX_BYTES) throw bad("That file is over 25 MB.", 413);
  const kind = sniff(buffer);
  const { PDFDocument } = require("pdf-lib");
  if (kind === "pdf") {
    // A damaged file can get past load() and fail only when its pages are
    // asked for, so the counting and measuring are inside the same net.
    let n = 0, pages = [];
    try {
      const doc = await PDFDocument.load(buffer, { updateMetadata: false });
      n = doc.getPageCount();
      if (n && n <= MAX_PAGES) pages = doc.getPages().map(pageInfo);
    } catch (e) {
      if (/encrypt/i.test(e.message)) throw bad("That PDF is locked — password-protected, or protected against changes, as many government and bank forms are. Open it, choose Print → Save as PDF, and upload the copy that makes.");
      throw bad("That PDF could not be read. Try saving it again as a PDF (Print → Save as PDF) and uploading the new copy.");
    }
    if (!n) throw bad("That PDF has no pages.");
    if (n > MAX_PAGES) throw bad(`That PDF has ${n} pages; the most that can be sent for signature is ${MAX_PAGES}.`);
    return { pdf: buffer, pages, kind };
  }
  if (kind === "png" || kind === "jpg") {
    const doc = await PDFDocument.create();
    let img;
    try { img = kind === "png" ? await doc.embedPng(buffer) : await doc.embedJpg(buffer); }
    catch (e) { throw bad("That picture could not be read. Try a PDF, or a JPG or PNG saved again from the photo."); }
    // A letter-width page as tall as the picture needs, capped at twice letter height.
    const w = 612, h = Math.min(1584, Math.max(200, Math.round(w * img.height / img.width)));
    const scale = Math.min(w / img.width, h / img.height);
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: (w - img.width * scale) / 2, y: (h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
    const pdf = Buffer.from(await doc.save({ useObjectStreams: false }));
    return { pdf, pages: [{ w, h, rotation: 0 }], kind };
  }
  throw bad("Upload a PDF, or a JPG or PNG picture. A Word file can be saved as a PDF first (File → Save As → PDF).", 415);
}

// ── Fields ──────────────────────────────────────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Validate what the prepare page sent. Nothing here is trusted: the list
 * comes from a browser. Returns the fields with server-assigned ids.
 */
function cleanFields(list, signerCount, pageCount) {
  if (!Array.isArray(list)) throw bad("No fields were sent.");
  if (list.length > MAX_FIELDS) throw bad(`A document can carry ${MAX_FIELDS} fields.`);
  return list.map((f, i) => {
    const type = String((f && f.type) || "");
    if (!FIELD_TYPES.includes(type)) throw bad(`Field ${i + 1}: unknown kind of field.`);
    const signer = parseInt(f.signer, 10);
    if (!(signer >= 0 && signer < signerCount)) throw bad(`Field ${i + 1}: it does not belong to one of the signers.`);
    const page = parseInt(f.page, 10);
    if (!(page >= 0 && page < pageCount)) throw bad(`Field ${i + 1}: it is not on a page of this document.`);
    let x = num(f.x), y = num(f.y), w = num(f.w), h = num(f.h);
    if ([x, y, w, h].some(Number.isNaN)) throw bad(`Field ${i + 1}: its position is missing.`);
    w = clamp(w, 0.01, 1); h = clamp(h, 0.005, 1);
    x = clamp(x, 0, 1 - w); y = clamp(y, 0, 1 - h);
    const round = (n) => Math.round(n * 100000) / 100000;
    return {
      id: "f" + (i + 1), type, signer, page, x: round(x), y: round(y), w: round(w), h: round(h),
      // A signature, initials, the date and the name are never optional. A
      // text box is required unless marked otherwise; a checkbox is optional
      // unless marked required ("I have read …").
      required: type === "text" ? f.required !== false : type === "checkbox" ? f.required === true : true,
      label: String(f.label || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60) || null,
    };
  });
}

function cleanSigners(list) {
  if (!Array.isArray(list) || !list.length) throw bad("Add at least one signer.");
  if (list.length > MAX_SIGNERS) throw bad(`A document can have ${MAX_SIGNERS} signers.`);
  return list.map((s, i) => {
    const name = String((s && s.name) || "").trim().replace(/\s+/g, " ");
    if (name.length < 2) throw bad(`Enter a name for signer ${i + 1}.`);
    const email = String(s.email || "").trim();
    if (email && !E().oneAddress(email)) throw bad(`${name}: that email address does not look right.`);
    const digits = String(s.phone || "").replace(/[^\d+]/g, "");
    const phone = digits.replace(/\D/g, "").length >= 10 ? (digits.startsWith("+") ? digits : "+1" + digits.replace(/\D/g, "").slice(-10)) : null;
    if (String(s.phone || "").trim() && !phone) throw bad(`${name}: that phone number does not look right.`);
    return {
      role: "s" + (i + 1),
      label: String(s.label || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60) || `Signer ${i + 1}`,
      name: name.slice(0, 200), email: email || null, phone,
      sign_order: clamp(parseInt(s.sign_order, 10) || 1, 1, MAX_SIGNERS),
    };
  });
}

// ── Preparing ───────────────────────────────────────────────

/** Step 1: the upload becomes a draft. No signers, no fields yet. */
async function createDraft({ buffer, filename, title = null, clientKey = null, caseId = null, user = null }) {
  await E().initTables();
  const doc = await normalize(buffer);
  const name = String(filename || "document").replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f<>:"|?*]/g, "").trim().slice(0, 160) || "document";
  if (caseId) {
    const c = await require("./civil-litigation").getCase(Number(caseId));
    if (!c) throw bad("Matter not found", 404);
    clientKey = c.client_key;
  }
  const r = await db.query(
    `INSERT INTO esign_packets (kind, title, source_filename, case_id, client_key, pdf, pages, fields, doc_hash, status, created_by, created_by_uid)
     VALUES ('upload', $1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, $7, 'draft', $8, $9) RETURNING id`,
    [String(title || name.replace(/\.[A-Za-z0-9]{1,5}$/, "")).slice(0, 200), name, caseId ? Number(caseId) : null, clientKey || null,
     doc.pdf, JSON.stringify(doc.pages), sha256(doc.pdf), (user && (user.n || user.u)) || null, (user && user.uid) || null]);
  await E().logEvent(r.rows[0].id, "created", { detail: `Uploaded by ${(user && (user.n || user.u)) || "staff"}: ${name} (${doc.pages.length} page${doc.pages.length === 1 ? "" : "s"})` });
  return E().getPacket(r.rows[0].id);
}

/** Step 2–3: who signs, and where. Replaces what was saved before; drafts only. */
async function savePrepared(id, { title, message, signers, fields, email_copies } = {}) {
  const p = await E().getPacket(id);
  if (p.kind !== "upload") throw bad("That document was made from a template; its signers are set there.");
  if (p.status !== "draft") throw bad("This document has already been sent. Cancel it and upload it again to change it.", 409);
  const who = cleanSigners(signers);
  const placed = cleanFields(fields || [], who.length, (p.pages || []).length).map(f => ({ ...f, role: who[f.signer].role }));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM esign_signers WHERE packet_id = $1`, [p.id]);
    for (const s of who) {
      await client.query(
        `INSERT INTO esign_signers (packet_id, role, label, name, email, phone, sign_order, token, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + INTERVAL '${E().LINK_DAYS} days')`,
        [p.id, s.role, s.label, s.name, s.email, s.phone, s.sign_order, crypto.randomBytes(24).toString("base64url")]);
    }
    await client.query(
      `UPDATE esign_packets SET title = COALESCE($2, title), message = $3, fields = $4::jsonb, email_copies = $5 WHERE id = $1`,
      [p.id, title ? String(title).trim().slice(0, 200) || null : null, message ? String(message).slice(0, 1000) : null,
       JSON.stringify(placed), email_copies !== false]);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); }
  return E().getPacket(p.id);
}

/** Before it goes out: every signer must have somewhere to sign. */
function readyToSend(p) {
  if (!p.signers || !p.signers.length) throw bad("Add at least one signer before sending.");
  const fields = p.fields || [];
  for (const s of p.signers) {
    if (!fields.some(f => f.role === s.role && f.type === "signature")) {
      throw bad(`${s.name} has no signature field. Put one on the page where they should sign.`);
    }
  }
}

// ── The signer's side ───────────────────────────────────────

const mineOf = (p, s) => (p.fields || []).filter(f => f.role === s.role);

/** What the signing page needs for an uploaded document. */
function viewFor(p, s) {
  const signed = new Set(p.signers.filter(x => x.status === "signed").map(x => x.role));
  return {
    kind: "upload",
    pages: p.pages || [],
    // Their own fields in full. Other people's as outlines only: where
    // someone else will sign is not a secret; what they typed is on the PDF
    // itself once they have signed, and nowhere before that.
    fields: (p.fields || []).map(f => f.role === s.role
      ? { id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, label: f.label, mine: true }
      : { page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, type: f.type, mine: false, done: signed.has(f.role) }),
    needs: {
      signature: mineOf(p, s).some(f => f.type === "signature"),
      initials: mineOf(p, s).some(f => f.type === "initials"),
    },
  };
}

function decodePng(dataUrl, what) {
  const m = String(dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw bad(what);
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw bad("That image is too large.");
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw bad(what);
  if (!E().pngFits(buf)) throw bad("That image is too large.");      // what it declares, not what it weighs
  return buf;
}

// Can the standard PDF fonts write this? Latin-1, and the typographic quotes
// and dashes a phone keyboard puts in by itself (all in the fonts' WinAnsi
// set). The signing page uses the same test to decide when to send a picture.
const plain = (s) => /^[\x20-\x7E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2026]*$/.test(String(s));

/**
 * Check what a signer submitted against the fields that are theirs.
 * @returns {{initials:Buffer|null, saved:{values:Object, images:Object}}}
 */
function checkSubmission(p, s, { typed_name, initials, values, images } = {}) {
  const fields = mineOf(p, s);
  const vals = (values && typeof values === "object") ? values : {};
  const pics = (images && typeof images === "object") ? images : {};
  const out = { values: {}, images: {} };
  let initialsPng = null;
  if (fields.some(f => f.type === "initials")) initialsPng = decodePng(initials, "Add your initials.");
  let imageBytes = 0;
  const keepImage = (key, dataUrl) => {
    const png = decodePng(dataUrl, "Something you typed could not be saved. Please try again.");
    imageBytes += png.length;
    if (imageBytes > 2 * 1024 * 1024) throw bad("Too much text to save. Shorten what you typed.");
    out.images[key] = png.toString("base64");
  };
  for (const f of fields) {
    if (f.type === "text") {
      const v = String(vals[f.id] == null ? "" : vals[f.id]).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 500);
      if (!v && f.required) throw bad(`Fill in ${f.label ? "“" + f.label + "”" : "every required box"} on page ${f.page + 1}.`);
      if (v) {
        out.values[f.id] = v;
        // Chinese, Korean, Arabic …: the standard PDF fonts cannot write it,
        // so the page sends a picture of the text and the words go on the
        // certificate. Without the picture the field would come out blank.
        if (!plain(v)) {
          if (!pics[f.id]) throw bad("Something you typed could not be saved. Please try again.");
          keepImage(f.id, pics[f.id]);
        }
      }
    } else if (f.type === "checkbox") {
      const on = vals[f.id] === true;
      if (!on && f.required) throw bad(`Tick the required box on page ${f.page + 1}.`);
      out.values[f.id] = on;
    }
  }
  // The name fields show the typed name; same rule for scripts the font
  // lacks. Without a name field the picture is still kept when it was sent:
  // the certificate shows it.
  const name = String(typed_name || "").trim();
  if (!plain(name)) {
    if (pics.__name) keepImage("__name", pics.__name);
    else if (fields.some(f => f.type === "name")) throw bad("Your name could not be saved. Please try again.");
  }
  return { initials: initialsPng, saved: out };
}

/**
 * A template document has no placed fields, but a name in Chinese still
 * deserves to be legible on its certificate. Never throws: the picture is
 * a courtesy here, not a requirement.
 */
function nameImage(typedName, images) {
  try {
    const pic = images && typeof images === "object" && images.__name;
    if (!pic || plain(String(typedName || "").trim())) return null;
    return { values: {}, images: { __name: decodePng(pic, "bad image").toString("base64") } };
  } catch (e) { return null; }
}

// ── Putting the marks on the PDF ────────────────────────────

const dateOf = (v) => new Date(v).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", year: "numeric" });

/**
 * The page as it is displayed has its origin at the top left. A PDF page has
 * its origin at the bottom left of the UNROTATED page, and may carry a
 * /Rotate. Given a rectangle in displayed fractions, return where the
 * bottom-left corner of upright content goes in PDF space, and the rotation
 * to draw it with so it reads upright on screen and on paper.
 */
function place(page, f) {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const flipped = rot === 90 || rot === 270;
  const W = flipped ? box.height : box.width, H = flipped ? box.width : box.height;
  const X = f.x * W, Y = f.y * H, w = f.w * W, h = f.h * H;
  if (rot === 90) return { x: box.x + Y + h, y: box.y + X, w, h, rot: 90 };
  if (rot === 180) return { x: box.x + box.width - X, y: box.y + Y + h, w, h, rot: 180 };
  if (rot === 270) return { x: box.x + box.width - (Y + h), y: box.y + box.height - X, w, h, rot: 270 };
  return { x: box.x + X, y: box.y + box.height - Y - h, w, h, rot: 0 };
}
// A point (dx right, dy up) from the content's own bottom-left corner, in PDF space.
function offset(at, dx, dy) {
  const r = at.rot * Math.PI / 180;
  return { x: at.x + dx * Math.cos(r) - dy * Math.sin(r), y: at.y + dx * Math.sin(r) + dy * Math.cos(r) };
}

/**
 * The document with the marks of everyone who has signed so far.
 * @param {object} p  packet with bytes (pdf, signers with signature_png …)
 */
async function stamp(p) {
  const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");
  const doc = await PDFDocument.load(p.pdf, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.05, 0.09, 0.25);
  const pages = doc.getPages();
  const embedded = new Map();
  const png = async (key, buf) => {
    if (!embedded.has(key)) embedded.set(key, await doc.embedPng(buf));
    return embedded.get(key);
  };
  const drawImage = (page, at, img, { align = "left" } = {}) => {
    const scale = Math.min(at.w / img.width, at.h / img.height);
    const w = img.width * scale, h = img.height * scale;
    const o = offset(at, align === "center" ? (at.w - w) / 2 : 0, (at.h - h) / 2);
    page.drawImage(img, { x: o.x, y: o.y, width: w, height: h, rotate: degrees(at.rot) });
  };
  const drawText = (page, at, text) => {
    let size = clamp(at.h * 0.62, 5, 13);
    const width = font.widthOfTextAtSize(text, size);
    if (width > at.w - 2) size = Math.max(4, size * (at.w - 2) / width);
    const o = offset(at, 1, (at.h - size) / 2 + size * 0.18);
    page.drawText(text, { x: o.x, y: o.y, size, font, color: ink, rotate: degrees(at.rot) });
  };

  for (const s of p.signers) {
    if (s.status !== "signed") continue;
    const saved = s.field_values || {};
    const values = saved.values || {}, images = saved.images || {};
    for (const f of (p.fields || [])) {
      if (f.role !== s.role) continue;
      const page = pages[f.page];
      if (!page) continue;
      const at = place(page, f);
      try {
        if (f.type === "signature" && s.signature_png) drawImage(page, at, await png("sig" + s.id, s.signature_png));
        else if (f.type === "initials" && s.initials_png) drawImage(page, at, await png("ini" + s.id, s.initials_png), { align: "center" });
        else if (f.type === "date") drawText(page, at, dateOf(s.signed_at));
        else if (f.type === "name") {
          const name = s.typed_name || s.name;
          if (plain(name)) drawText(page, at, name);
          else if (images.__name) drawImage(page, at, await png("name" + s.id, Buffer.from(images.__name, "base64")));
        } else if (f.type === "text" && values[f.id]) {
          if (plain(values[f.id])) drawText(page, at, String(values[f.id]));
          else if (images[f.id]) drawImage(page, at, await png(f.id + ":" + s.id, Buffer.from(images[f.id], "base64")));
        } else if (f.type === "checkbox" && values[f.id] === true) {
          const m = Math.min(at.w, at.h), pad = m * 0.2, t = Math.max(0.8, m * 0.12);
          const a = offset(at, (at.w - m) / 2 + pad, (at.h - m) / 2 + pad), b = offset(at, (at.w + m) / 2 - pad, (at.h + m) / 2 - pad);
          const c = offset(at, (at.w - m) / 2 + pad, (at.h + m) / 2 - pad), d = offset(at, (at.w + m) / 2 - pad, (at.h - m) / 2 + pad);
          page.drawLine({ start: a, end: b, thickness: t, color: ink });
          page.drawLine({ start: c, end: d, thickness: t, color: ink });
        }
      } catch (e) {
        // One field that cannot be drawn must not lose the rest; the
        // certificate still records that this person signed.
        console.warn(`[esign-pdf] field ${f.id} on packet ${p.id}: ${e.message}`);
      }
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/**
 * What a signer's page shows: the PDF as it stands now — and, once everyone
 * has signed, the finished copy (either kind of document) to keep.
 * @returns {{pdf:Buffer, name:string}}
 */
async function pdfForSigner(token) {
  const found = await E().bySigner(token);
  if (!found) throw bad("This signing link is not valid.", 404);
  const { s, p } = found;
  const base = String(p.title).replace(/[\/\\:?*"<>|]+/g, " ").trim().slice(0, 90) || "document";
  if (p.status === "completed" && p.signed_pdf) return { pdf: p.signed_pdf, name: base + " - signed.pdf" };
  if (p.kind !== "upload") throw bad("Not found", 404);
  if (p.status === "cancelled" || p.status === "declined") throw bad("This document is no longer open.", 410);
  if (s.status !== "signed" && s.expires_at && new Date(s.expires_at) < new Date()) throw bad("This link has expired.", 410);
  if (p.status !== "sent" && p.status !== "completed") throw bad("This document has not been sent yet.", 409);
  // Nobody has signed yet: the upload itself, byte for byte.
  if (!p.signers.some(x => x.status === "signed")) return { pdf: p.pdf, name: base + ".pdf" };
  return { pdf: await stamp(p), name: base + ".pdf" };
}

// ── Finishing ───────────────────────────────────────────────

/**
 * Where the firm's own copy of a signed document goes.
 *
 * Not the creating user's `admin_users.email`, which is what this used to be.
 * JJ's admin record carries a personal Hotmail address, so every signed fee
 * agreement, retainer and release the firm produced was being delivered into
 * consumer webmail — and what he received there was the letter written for
 * clients, not one written for the firm.
 *
 * Overridable with ESIGN_FIRM_COPY_EMAIL so this is a setting rather than a
 * fact about one person.
 */
const FIRM_DOMAIN = "tezlawfirm.com";
function firmCopyAddress() {
  const a = String(process.env.ESIGN_FIRM_COPY_EMAIL || "jj@" + FIRM_DOMAIN).trim().toLowerCase();
  return E().oneAddress(a) ? a : "jj@" + FIRM_DOMAIN;
}

/**
 * The signed copy, to the signers and to the firm — as two different letters,
 * because they are written to two different audiences.
 *
 * A signer gets their own signed copy and nothing more. When they signed they
 * were told the firm would send a copy once everyone had signed, so the
 * arrival of the copy is the whole message. Announcing "Everyone has signed"
 * reports on the other parties' conduct, which is not this signer's business
 * — and on a document with an opposing party on it, saying so is a disclosure
 * about someone else that the firm never meant to make.
 *
 * The firm gets the completion notice, with who signed and when, at a firm
 * address.
 */
async function emailCopies(p, pdf) {
  const m = E().mailer();
  const sent = [], errors = [];
  if (!m) return { sent, errors: ["email is not set up on the server, so no copies were emailed"] };

  const signers = new Map();
  for (const s of p.signers) {
    const a = s.email && String(s.email).trim().toLowerCase();
    if (a) signers.set(a, s.name || "");
  }

  const firmTo = new Set([firmCopyAddress()]);
  // Whoever prepared it gets their own copy too, but only at a firm address.
  // A member of staff using personal webmail is not a reason to send client
  // documents there.
  try {
    if (p.created_by_uid) {
      const r = await db.query(`SELECT email FROM admin_users WHERE id = $1`, [p.created_by_uid]);
      const a = r.rows[0] && String(r.rows[0].email || "").trim().toLowerCase();
      if (a && a.endsWith("@" + FIRM_DOMAIN)) firmTo.add(a);
    }
  } catch (e) { /* the firm address still gets it */ }

  // Nobody receives both letters. A firm address that is also a signer is
  // staff signing on the firm's behalf, and the firm letter is the fuller one.
  for (const a of firmTo) signers.delete(a);

  const filename = E().fileBase(p) + ".pdf";
  const mail = require("./tez-email");
  const attachments = [{ filename, content: pdf, contentType: "application/pdf" }];

  for (const [address, name] of signers) {
    try {
      await m.t.sendMail({
        from: `"TEZ Law Firm" <${m.from}>`, to: address,
        subject: `Your signed copy: ${p.title}`,
        text: `Hello${name ? " " + name : ""},\n\nAttached is your signed copy of "${p.title}", with a certificate of signature on its last page.\n\n` +
          `Please keep it for your records. Questions: 626-678-8677.\n\nTEZ Law Firm`,
        html: mail.wrap({
          heading: "Your signed copy",
          body: `<p>Hello${name ? " " + mail.esc(name) : ""},</p>` +
            `<p>Attached is your signed copy of <strong>${mail.esc(p.title)}</strong>, with a certificate of signature on its last page.</p>` +
            `<p>Please keep it for your records.</p>`,
        }),
        attachments,
      });
      sent.push(address);
    } catch (e) { errors.push(`copy to ${address} failed: ${e.message}`); }
  }

  const roll = p.signers
    .map(s => `${s.label || s.role}: ${s.typed_name || s.name}${s.signed_at ? " — " + E().stampPT(s.signed_at) : ""}`);
  for (const address of firmTo) {
    try {
      await m.t.sendMail({
        from: `"TEZ Law Firm" <${m.from}>`, to: address,
        subject: `Signed: ${p.title}`,
        text: `"${p.title}" is fully signed. The signed copy is attached, with the certificate of signature on its last page.\n\n` +
          roll.join("\n") + `\n\nTEZ Law Firm`,
        html: mail.wrap({
          heading: "Fully signed",
          body: `<p><strong>${mail.esc(p.title)}</strong> is fully signed. The signed copy is attached, with the certificate of signature on its last page.</p>` +
            `<p style="margin:0;white-space:pre-wrap;">${mail.esc(roll.join("\n"))}</p>`,
        }),
        attachments,
      });
      sent.push(address);
    } catch (e) { errors.push(`firm copy to ${address} failed: ${e.message}`); }
  }
  return { sent, errors };
}

/** Everyone has signed: stamp, certify, file, send the copies. */
async function finalize(id) {
  const p = await E().getPacket(id, { withBytes: true });
  if (p.status !== "completed") throw new Error("Not every signer has signed yet");
  const stamped = await stamp(p);
  const signedHash = sha256(stamped);
  await db.query(`UPDATE esign_packets SET signed_hash = $2, finalize_error = NULL WHERE id = $1`, [p.id, signedHash]);
  const done = await E().getPacket(p.id, { withBytes: true });
  const events = (await db.query(`SELECT * FROM esign_events WHERE packet_id = $1 ORDER BY at, id`, [p.id])).rows;
  const cert = await E().certificatePdf(done, done.signers, events);
  const pdf = await E().mergePdfs(stamped, cert);
  // Kept first, filed second: whatever happens to Dropbox, the signed PDF is here.
  await db.query(`UPDATE esign_packets SET signed_pdf = $2 WHERE id = $1`, [p.id, pdf]);

  const errors = [];
  let pdfPath = null;
  const base = E().fileBase(p);
  if (p.case_id) {
    try {
      const r = await require("./civil-upload").uploadToCase(p.case_id, [{ originalname: base + ".pdf", buffer: pdf }],
        { category: null, by: "e-signature", provisionIfMissing: true });
      if (r.uploaded && r.uploaded[0]) pdfPath = r.uploaded[0].path;
      else errors.push((r.failed && r.failed[0] && r.failed[0].error) || "not filed in the matter's folder");
    } catch (e) { errors.push(e.message); }
    try {
      await require("./civil-litigation").logEvent(p.case_id, {
        event_kind: "note", event_date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
        title: `Signed: ${p.title}`,
        description: done.signers.map(s => `${s.label || s.role}: ${s.typed_name} — ${E().stampPT(s.signed_at)}`).join("\n") + (pdfPath ? `\nFiled to Dropbox: ${pdfPath}` : ""),
        created_by: "e-signature",
      });
    } catch (e) { /* the signature record stands on its own */ }
  } else if (p.client_key) {
    try {
      const dbx = require("./dropbox-integration");
      if (!dbx.isConfigured || !(await Promise.resolve(dbx.isConfigured()))) throw new Error("Dropbox is not connected; the signed copy is kept here to download");
      const c = await require("./client-profiles").getClientByKey(p.client_key);
      const folder = c && await dbx.resolveClientFolder({ clientKey: c.key, clientName: c.client_name, aNumber: c.a_number });
      if (!folder) throw new Error("this client has no Dropbox folder linked; the signed copy is kept here to download");
      const dir = `${folder}/Signed Documents`;
      try { await dbx.createFolder(dir); } catch (e) { /* already there */ }
      const up = await dbx.uploadFile({ path: `${dir}/${base}.pdf`, buffer: pdf, mode: "add", autorename: true });
      pdfPath = (up && (up.path_display || up.path_lower)) || `${dir}/${base}.pdf`;
      try { if (dbx.clearListCache) dbx.clearListCache(folder); } catch (e) { /* cache only */ }
    } catch (e) { errors.push(e.message); }
  }
  let copies = { sent: [], errors: [] };
  if (p.email_copies !== false) {
    copies = await emailCopies(done, pdf);
    errors.push(...copies.errors);
    if (copies.sent.length) await E().logEvent(p.id, "copies_sent", { detail: `Signed copy emailed to ${copies.sent.join(", ")}` });
  }
  await db.query(`UPDATE esign_packets SET dropbox_pdf = $2, finalize_error = $3 WHERE id = $1`, [p.id, pdfPath, errors.join("; ") || null]);
  await E().notify(done, `"${p.title}" is fully signed${pdfPath ? " and filed in Dropbox" : ""}`);
  return E().getPacket(p.id);
}

// ── The firm's list ─────────────────────────────────────────

/**
 * Documents out for signature, newest first, without any file bytes.
 * @param {{mineUid?:number|null, clientKeys?:Set<string>|null, limit?:number}} who
 *        null mineUid and null clientKeys = everything (an administrator)
 */
async function listAll({ mineUid = null, clientKeys = null, limit = 100 } = {}) {
  await E().initTables();
  const r = await db.query(
    `SELECT id, kind, title, source_filename, template_name, case_id, client_key, status, message, created_by, created_by_uid,
            created_at, sent_at, completed_at, cancelled_at, finalize_error, dropbox_pdf,
            (signed_pdf IS NOT NULL) AS has_signed_pdf, COALESCE(jsonb_array_length(pages), 0) AS page_count
       FROM esign_packets ORDER BY created_at DESC LIMIT 400`);
  const rows = r.rows.filter(p => mineUid == null && clientKeys == null
    ? true
    : (mineUid != null && p.created_by_uid === mineUid) || (p.client_key && clientKeys && clientKeys.has(p.client_key))).slice(0, limit);
  if (!rows.length) return [];
  const s = await db.query(
    `SELECT id, packet_id, label, name, email, phone, sign_order, status, sent_at, sent_via, delivery_error, viewed_at, signed_at, decline_reason
       FROM esign_signers WHERE packet_id = ANY($1::int[]) ORDER BY sign_order, id`, [rows.map(p => p.id)]);
  const by = {};
  for (const x of s.rows) (by[x.packet_id] = by[x.packet_id] || []).push(x);
  return rows.map(p => ({ ...p, signers: by[p.id] || [] }));
}

/** A draft that was never sent can be thrown away. Nothing sent is ever deleted. */
async function discardDraft(id) {
  const p = await E().getPacket(id);
  if (p.status !== "draft") throw bad("Only a draft can be discarded. A document that was sent is cancelled instead, and kept.", 409);
  await db.query(`DELETE FROM esign_packets WHERE id = $1 AND status = 'draft'`, [p.id]);
  return { ok: true };
}

module.exports = {
  MAX_BYTES, MAX_PAGES, MAX_FIELDS, MAX_SIGNERS, FIELD_TYPES, AUTO_TYPES,
  sniff, normalize, cleanFields, cleanSigners, createDraft, savePrepared, readyToSend,
  viewFor, checkSubmission, nameImage, place, offset, stamp, pdfForSigner, finalize, emailCopies, listAll, discardDraft, plain, dateOf,
  // For the check: where the firm's copy goes, without a database or a mail server.
  firmCopyAddress, FIRM_DOMAIN,
};
