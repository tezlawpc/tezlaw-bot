// ============================================================
//  retainer-docx.js — the agreement as a Word file
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  "there is no button to send for esign or print or export as
//   word or pdf."
//
//  This builds a real .docx -- pizzip and WordprocessingML, the
//  way zara-actions builds a memo -- rather than renaming an HTML
//  file, which opens in Word with the styles stripped and the fee
//  table collapsed into a run-on paragraph.
//
//  It does NOT restate the agreement. It CONVERTS the markup that
//  retainer-doc already produced, the same way tez-theme.scopedCSS
//  rewrites its own stylesheet rather than keeping a second copy.
//  That matters most in the fee section: § 6147 and § 6148 decide
//  what has to be in it, the rules on flat fees decide how it is
//  worded, and a Word exporter that reasoned about fees a second
//  time would eventually disagree with the page about what the
//  client is paying. This one cannot: if it is not in the HTML it
//  is not in the Word file, and if the HTML changes so does this.
//
//  The tag set is small because retainer-doc's output is small:
//  h1, h2, p, strong, em, ul/li, and one table. Anything it does
//  not recognise still comes through as its text, so a new tag
//  degrades to a plain paragraph rather than vanishing.
// ============================================================

const HEAD_FONT = "Cormorant Garamond";
const BODY_FONT = "Montserrat";
const ZH_FONT = "Noto Serif SC";

const CHARCOAL = "2B2523";
const EMBER = "A34C00";
const STONE = "5E5854";

const xmlEsc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// HTML entities retainer-doc emits, plus the few a clause may carry.
const unescape = (s) => String(s == null ? "" : s)
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&middot;/g, "·").replace(/&rarr;/g, "→");

/** size is half-points, the unit Word uses: 22 = 11pt. */
function run(text, { bold, italic, size = 22, color, font = BODY_FONT, spacing } = {}) {
  if (text === "") return "";
  const rpr =
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${ZH_FONT}" w:cs="${font}"/>` +
    (bold ? "<w:b/>" : "") + (italic ? "<w:i/>" : "") +
    (spacing ? `<w:spacing w:val="${spacing}"/>` : "") +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    (color ? `<w:color w:val="${color}"/>` : "");
  return `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}

function para(runs, { align, before = 0, after = 140, indent, border, shade, keepNext } = {}) {
  const body = [].concat(runs).filter(Boolean).join("");
  const ppr =
    `<w:spacing w:before="${before}" w:after="${after}" w:line="280" w:lineRule="auto"/>` +
    (align ? `<w:jc w:val="${align}"/>` : "") +
    (indent ? `<w:ind w:left="${indent}"/>` : "") +
    (keepNext ? "<w:keepNext/>" : "") +
    (shade ? `<w:shd w:val="clear" w:fill="${shade}"/>` : "") +
    (border ? `<w:pBdr><w:bottom w:val="single" w:sz="12" w:color="${border}"/></w:pBdr>` : "");
  return `<w:p><w:pPr>${ppr}</w:pPr>${body}</w:p>`;
}

const text = (s, o = {}) => para(run(s, o), o);

// ── Reading the markup ──────────────────────────────────────
//
// Deliberately not a DOM parser: there is no DOM here, the input is
// this repo's own output, and a 40-line reader that fails visibly
// beats a dependency that fails quietly.

/** Split one element's inner HTML into styled runs. */
function runsFrom(html, base = {}) {
  const out = [];
  // <strong>, <b>, <em>, <i> and nothing else; everything between them
  // is plain text.
  const re = /<(\/?)(strong|b|em|i)\b[^>]*>/gi;
  let at = 0, bold = !!base.bold, italic = !!base.italic, m;
  const push = (raw) => {
    const t = unescape(raw.replace(/<[^>]+>/g, ""));
    if (t) out.push(run(t, { ...base, bold, italic }));
  };
  while ((m = re.exec(html)) !== null) {
    push(html.slice(at, m.index));
    const on = m[1] !== "/";
    if (/^(strong|b)$/i.test(m[2])) bold = on; else italic = on;
    at = m.index + m[0].length;
  }
  push(html.slice(at));
  return out;
}

const classOf = (tag) => (tag.match(/class="([^"]*)"/) || [])[1] || "";

/** One <table class="fees"> becomes a Word table. */
function tableXml(html) {
  const widths = [1300, 5500, 1800];
  const cell = (inner, i, isHead) =>
    `<w:tc><w:tcPr><w:tcW w:w="${widths[i] || 2000}" w:type="dxa"/>` +
    `<w:tcBorders><w:bottom w:val="single" w:sz="4" w:color="${isHead ? "E8E3DC" : "F3EFE9"}"/></w:tcBorders>` +
    `</w:tcPr>` +
    para(runsFrom(inner, { size: 20, bold: isHead, color: isHead ? STONE : undefined }),
      { after: 70, align: i === 2 ? "right" : undefined }) +
    `</w:tc>`;

  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let c, i = 0;
    while ((c = cellRe.exec(r[1])) !== null) {
      cells.push(cell(c[2], i++, c[1].toLowerCase() === "th"));
    }
    if (cells.length) rows.push(`<w:tr>${cells.join("")}</w:tr>`);
  }
  if (!rows.length) return "";
  return `<w:tbl><w:tblPr><w:tblW w:w="8600" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>` +
    rows.join("") + `</w:tbl>` + para("", { after: 120 });
}

/** The agreement's rendered HTML body, as WordprocessingML. */
function fromHtml(html) {
  const out = [];
  // Block elements, in document order.
  const re = /<(h1|h2|h3|p|li|table)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    const inner = m[3];
    const cls = classOf("<x" + attrs + ">");

    if (tag === "table") { out.push(tableXml(inner)); continue; }

    // The drafter's "why this clause is here" notes never leave the firm.
    if (/\bwhy\b/.test(cls)) continue;

    if (tag === "h1") {
      out.push(para(runsFrom(inner, { size: 34, bold: true, color: CHARCOAL, font: HEAD_FONT }),
        { before: 120, after: 60, keepNext: true }));
    } else if (tag === "h2" || tag === "h3") {
      out.push(para(runsFrom(inner, { size: 26, bold: true, color: CHARCOAL, font: HEAD_FONT }),
        { before: 260, after: 80, keepNext: true }));
    } else if (tag === "li") {
      out.push(para([run("•  ", { size: 22 }), ...runsFrom(inner)], { indent: 360, after: 90 }));
    } else if (/\bzh\b/.test(cls) && /\bmissing\b/.test(cls)) {
      out.push(para(runsFrom(inner, { size: 18, italic: true, color: EMBER })));
    } else if (/\bzh\b/.test(cls)) {
      out.push(para(runsFrom(inner, { size: 21, font: ZH_FONT })));
    } else if (/\bconsent\b/.test(cls)) {
      out.push(para(runsFrom(inner), { shade: "FFF4E8", before: 80, after: 80 }));
    } else if (/\b(meta|siglet)\b/.test(cls)) {
      out.push(para(runsFrom(inner, { size: 19, color: STONE })));
    } else {
      out.push(para(runsFrom(inner)));
    }
  }
  return out.join("");
}

// ── The letterhead, which the HTML draws with CSS ───────────

function letterhead(FIRM, a) {
  const wc = FIRM.offices[0];
  const when = new Date(a.agreement_date || a.date || Date.now()).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric",
  });
  return [
    para(run("TEZ LAW FIRM", { bold: true, size: 40, color: CHARCOAL, font: HEAD_FONT, spacing: 70 }),
      { align: "center", after: 40 }),
    para(run(`${FIRM.entity} · A Professional Corporation`, { size: 17, color: STONE }),
      { align: "center", after: 20 }),
    para(run(wc.lines.join(", "), { size: 17, color: STONE }), { align: "center", after: 20 }),
    para(run(`Tel ${FIRM.phone} · ${FIRM.email} · www.tezlawfirm.com`, { size: 17, color: STONE }),
      { align: "center", after: 180, border: EMBER }),
    text(when, { size: 20, after: 180 }),
  ].join("");
}

function offices(FIRM) {
  const line = FIRM.offices.map((o) => o.city).join("   ·   ");
  const note = FIRM.offices.find((o) => o.note);
  return para(run(line, { size: 16, color: STONE }), { before: 560, align: "center", after: 20 }) +
    (note ? para(run(`${note.city} — ${note.note}`, { size: 15, color: STONE, italic: true }),
      { align: "center" }) : "");
}

// ── The container ───────────────────────────────────────────

function wrap(bodyXml) {
  const PizZip = require("pizzip");
  const zip = new PizZip();

  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`);

  zip.file("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`);

  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}` +
    // Letter, one-inch margins, matching the print stylesheet.
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1296" w:left="1440" w:header="720" w:footer="720"/>` +
    `</w:sectPr></w:body></w:document>`);

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * The agreement as a Word file.
 *
 * a   — the terms object
 * doc — retainer-doc, which renders the body and holds FIRM
 */
function build(a = {}, doc) {
  const html = doc.body(a, { forClient: true });
  return wrap(letterhead(doc.FIRM, a) + fromHtml(html) + offices(doc.FIRM));
}

/** A filename a person can find again. */
function fileName(a = {}) {
  const who = String(a.client_name || "Client").replace(/[^\w一-鿿 -]+/g, "").trim() || "Client";
  // The date the document is dated by. A stored YYYY-MM-DD is used AS IT IS:
  // court-calendar.js sets the convention at the top of the file -- a date
  // with no zone is the date printed on the paper and is never converted --
  // and running it through a timezone moves it. new Date("2026-10-07") is
  // midnight UTC, which is 5pm on the 6th in West Covina.
  //
  // Only when nothing is stored is "today" computed, and then it is the
  // office's today, not UTC's.
  const stored = String(a.agreement_date || a.date || "");
  const when = /^\d{4}-\d{2}-\d{2}/.test(stored)
    ? stored.slice(0, 10)
    : new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
  return `Agreement for Legal Services - ${who} - ${when}.docx`;
}

module.exports = { build, fileName, fromHtml, runsFrom, tableXml, wrap };
