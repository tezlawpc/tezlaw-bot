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

// The agreement is set in Times New Roman 11pt, headings included; the
// brand faces are the COVER's, which is the brand's own artwork. SimSun is
// the Chinese face that pairs with Times in the firm's bilingual filings.
const HEAD_FONT = "Times New Roman";
const BODY_FONT = "Times New Roman";
const COVER_HEAD_FONT = "Cormorant Garamond";
const COVER_BODY_FONT = "Montserrat";
const ZH_FONT = "SimSun";

const CHARCOAL = "2B2523";
const ORANGE = "FF7B00";
const EMBER = "A34C00";
const STONE = "5E5854";

const xmlEsc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// HTML entities retainer-doc emits, plus the few a clause may carry.
const unescape = (s) => String(s == null ? "" : s)
  .replace(/&nbsp;/g, "\u00a0").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
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

/**
 * Body text is justified, the way a contract is set.
 *
 * "alignment to the body should be Justify. not to the left. i believe it
 *  kind of shifted when exporting the word doc." (JJ, 2026-10-09) -- and it
 * had: the stylesheet sets `p, li { text-align:justify }`, this builder set
 * no w:jc at all, and Word's default is left. The exported file came back
 * with 0 justified paragraphs out of 164.
 *
 * Headings, the meta lines and the signature block keep their own
 * alignment; only running text takes this.
 */
const BODY_ALIGN = "both";   // Word's name for justified

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
    // The source wraps and indents its paragraphs. HTML collapses that
    // run of newline-and-spaces; Word, with xml:space="preserve", prints
    // it. Collapse ASCII whitespace only, so the non-breaking spaces
    // after "Re:" survive as themselves.
    const t = unescape(raw.replace(/<[^>]+>/g, "")).replace(/[ \t\r\n]+/g, " ");
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
/**
 * The signature block, as a borderless two-column table.
 *
 * It has to be built rather than converted: the rules and the names are
 * divs, and fromHtml reads block tags. That is why every Word copy of this
 * agreement until now came out with nowhere to sign.
 */
function signatureBlock(names) {
  const cell = (xml, { line = false } = {}) =>
    `<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/>` +
    `<w:tcBorders>${line
      ? `<w:bottom w:val="single" w:sz="6" w:color="${CHARCOAL}"/>`
      : `<w:bottom w:val="nil"/>`}` +
    `<w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders>` +
    `</w:tcPr>${xml}</w:tc>`;
  const gap = `<w:tc><w:tcPr><w:tcW w:w="480" w:type="dxa"/>` +
    `<w:tcBorders><w:top w:val="nil"/><w:bottom w:val="nil"/>` +
    `<w:left w:val="nil"/><w:right w:val="nil"/></w:tcBorders></w:tcPr>` +
    `${para([run(" ")], { after: 0 })}</w:tc>`;
  const row = (cells) => `<w:tr>${cells[0]}${gap}${cells[1]}</w:tr>`;

  const blank = para([run(" ")], { before: 300, after: 40 });
  const who = (n) => para(runsFrom(n, { size: 20 }), { after: 220 });
  const when = para([run("Date: ____________________", { size: 20 })], { after: 0 });

  return `<w:tbl>` +
    `<w:tblPr><w:tblW w:w="9840" w:type="dxa"/>` +
    `<w:tblBorders><w:top w:val="nil"/><w:bottom w:val="nil"/><w:left w:val="nil"/>` +
    `<w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/></w:tblPr>` +
    row([cell(blank, { line: true }), cell(blank, { line: true })]) +
    row([cell(who(names[0] || "")), cell(who(names[1] || ""))]) +
    row([cell(when), cell(when)]) +
    `</w:tbl>` + para([run(" ")], { after: 0 });
}

function fromHtml(html) {
  const out = [];

  // The signature block comes out first: it is divs, which the loop below
  // does not see, and a fee agreement with no signature lines is not one.
  // A marker paragraph keeps its place in document order.
  let sigXml = "";
  html = html.replace(/<div class="sigs">([\s\S]*?)<\/div>\s*<\/section>/i, (_all, inner) => {
    const names = [];
    const who = /<div class="who">([\s\S]*?)<\/div>/gi;
    let w;
    while ((w = who.exec(inner)) !== null) names.push(w[1].replace(/<[^>]*>/g, "").trim());
    sigXml = signatureBlock(names);
    return `<p class="sigmark"> </p></section>`;
  });
  // Block elements, in document order.
  // div is here only for the firm profile's point titles and its lead and
  // section lines, which are not paragraphs but do have to print.
  const re = /<(h1|h2|h3|p|li|table|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || "";
    const inner = m[3];
    const cls = classOf("<x" + attrs + ">");

    if (tag === "table") { out.push(tableXml(inner)); continue; }

    // The drafter's "why this clause is here" notes never leave the firm.
    if (/\bwhy\b/.test(cls)) continue;

    if (/\bfp-(point-t|lead|apart)\b/.test(cls)) {
      out.push(para(runsFrom(inner, { bold: true }), { before: 120, after: 40, keepNext: true }));
    } else if (/\bsigmark\b/.test(cls)) {
      out.push(sigXml);
    } else if (tag === "h1") {
      // 22 half-points is 11pt. The title is centred and tracked rather
      // than enlarged, which is how the page sets it.
      out.push(para(runsFrom(inner, { size: 22, bold: true, font: HEAD_FONT, spacing: 12 }),
        { align: "center", before: 240, after: 200, keepNext: true }));
    } else if (tag === "h2" || tag === "h3") {
      out.push(para(runsFrom(inner, { size: 22, bold: true, font: HEAD_FONT }),
        { before: 240, after: 60, keepNext: true }));
    } else if (tag === "li") {
      out.push(para([run("•  ", { size: 22 }), ...runsFrom(inner)], { indent: 360, after: 90, align: BODY_ALIGN }));
    } else if (/\bzh\b/.test(cls) && /\bmissing\b/.test(cls)) {
      out.push(para(runsFrom(inner, { size: 18, italic: true, color: EMBER })));
    } else if (/\bzh\b/.test(cls)) {
      out.push(para(runsFrom(inner, { size: 21, font: ZH_FONT }), { align: BODY_ALIGN }));
    } else if (/\bconsent\b/.test(cls)) {
      out.push(para(runsFrom(inner), { shade: "FFF4E8", before: 80, after: 80, align: BODY_ALIGN }));
    } else if (/\b(meta|siglet)\b/.test(cls)) {
      out.push(para(runsFrom(inner, { size: 19, color: STONE })));
    } else {
      out.push(para(runsFrom(inner), { align: BODY_ALIGN }));
    }
  }
  return out.join("");
}

// ── The letterhead sheets ───────────────────────────────────
//
// Full-page artwork, anchored behind the text at the page origin. Letter is
// 8.5 x 11in, and Word measures in EMU at 914400 to the inch, so the extent
// is fixed rather than computed: these images are always a whole page.

const PAGE_W_EMU = 7772400;   // 8.5in
const PAGE_H_EMU = 10058400;  // 11in

const NS = {
  w: 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  r: 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  wp: 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  a: 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  pic: 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
};

/** A header whose only content is one full-page image behind the text. */
function sheetHeader(name) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS.w} ${NS.r} ${NS.wp} ${NS.a} ${NS.pic}>
  <w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:drawing>
    <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1"
               behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">
      <wp:simplePos x="0" y="0"/>
      <wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>
      <wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>
      <wp:extent cx="${PAGE_W_EMU}" cy="${PAGE_H_EMU}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:wrapNone/>
      <wp:docPr id="1" name="${name}"/>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:nvPicPr><pic:cNvPr id="1" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${PAGE_W_EMU}" cy="${PAGE_H_EMU}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData></a:graphic>
    </wp:anchor>
  </w:drawing></w:r></w:p>
</w:hdr>`;
}

/** The first page's header: present, and empty. */
function emptyHeader() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS.w} ${NS.r} ${NS.wp} ${NS.a} ${NS.pic}>
  <w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:p>
</w:hdr>`;
}

function headerRels(target) {
  // No image on the cover's header, so no relationship either.
  if (!target) return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>
</Relationships>`;
}

/**
 * The cover, from the brand set's TEZ-Fee-Agreement-Cover.
 *
 * Its wording is the brand's, not mine: the title, its Chinese, the
 * eyebrow, the four fields and the entity line at the foot.
 */
/** A hard page break of its own, for a section the converter cannot see. */
function pageBreak() {
  return `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>`;
}

function coverPage(FIRM, a, doc) {
  const when = dateFor(a);
  const rule = (label, value) =>
    para(run(label.toUpperCase(), { size: 16, bold: true, color: CHARCOAL, spacing: 30 }),
      { before: 260, after: 40, border: CHARCOAL }) +
    para(run(value || " ", { size: 22 }), { after: 180 });

  // The brand cover's two bars, as borders on an empty paragraph: Seal
  // Orange over Charcoal. A shaded paragraph would not print unless the
  // person had background graphics on.
  const bar = (color, weight) =>
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>` +
    `<w:pBdr><w:bottom w:val="single" w:sz="${weight}" w:color="${color}"/></w:pBdr>` +
    `</w:pPr></w:p>`;

  return [
    bar(ORANGE, 10),
    bar(CHARCOAL, 22),
    para([
      run("TEZ", { size: 30, bold: true, color: ORANGE, font: COVER_BODY_FONT, spacing: 60 }),
      run(" LAW FIRM", { size: 30, bold: true, color: CHARCOAL, font: COVER_BODY_FONT, spacing: 60 }),
    ], { before: 520, after: 60 }),
    para(run(FIRM.tagline.en, { size: 20, italic: true, color: EMBER, font: COVER_HEAD_FONT }),
      { after: 900 }),
    para(run("Confidential  ·  Privileged Attorney Communication",
      { size: 17, bold: true, color: EMBER, spacing: 36 }), { before: 0, after: 120 }),
    para(run("Agreement for", { size: 64, bold: true, color: CHARCOAL, font: COVER_HEAD_FONT }),
      { after: 0 }),
    para(run("Legal Services", { size: 64, bold: true, color: CHARCOAL, font: COVER_HEAD_FONT }),
      { after: 80 }),
    para(run("律师与客户委托收费协议", { size: 36, color: EMBER, font: ZH_FONT }), { after: 560 }),
    rule("Client", a.client_name),
    rule("Matter", doc.matterOf ? doc.matterOf(a) : a.matter_label),
    rule("Responsible attorney", FIRM.attorney),
    rule("Date", when.long),
    para(run(FIRM.dba, { size: 17, color: STONE }), { before: 760, after: 20 }),
    para(run(FIRM.offices[0].lines.join(", "), { size: 17, color: STONE }), { after: 20 }),
    para(run(`${FIRM.phone} · ${FIRM.email}`, { size: 17, color: STONE }), { after: 20 }),
    para(run("Please read the full agreement before signing. Keep a copy for your records.",
      { size: 17, color: STONE, italic: true }), { before: 160 }),
    // Everything after this starts on the letterhead.
    `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>`,
  ].join("");
}

/** The date the document is dated by, in both the shapes this file needs. */
function dateFor(a) {
  const stored = String(a.agreement_date || a.date || "");
  const iso = /^\d{4}-\d{2}-\d{2}/.test(stored)
    ? stored.slice(0, 10)
    : new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
  // Parsed as a local noon so the long form cannot slip a day either way.
  const long = new Date(`${iso}T12:00:00`).toLocaleDateString("en-US",
    { year: "numeric", month: "long", day: "numeric" });
  return { iso, long };
}

// ── The letterhead, which the HTML draws with CSS ───────────

function letterhead(FIRM, a, doc) {
  const matter = doc && doc.matterOf ? doc.matterOf(a) : (a.matter_label || "");
  const wc = FIRM.offices[0];
  // No drawn header any more: the sheet underneath IS the letterhead. This
  // is only what a letter opens with on top of it.
  void wc;
  return [
    text(dateFor(a).long, { size: 20, after: 180 }),
    a.client_name ? text(a.client_name, { size: 22, after: 40 }) : "",
    text(`Re:  Agreement for Legal Services${matter ? ` (${matter})` : ""}`,
      { bold: true, size: 22, after: 160 }),
    text(`Dear ${a.client_name || "Client"}:`, { size: 22, after: 180 }),
  ].filter(Boolean).join("");
}

function offices(FIRM) {
  const line = FIRM.offices.map((o) => o.city).join("   ·   ");
  const note = FIRM.offices.find((o) => o.note);
  return para(run(line, { size: 16, color: STONE }), { before: 560, align: "center", after: 20 }) +
    (note ? para(run(`${note.city} (${note.note})`, { size: 15, color: STONE, italic: true }),
      { align: "center" }) : "");
}

// ── The container ───────────────────────────────────────────

// `bilingual` is accepted and currently unused: it used to choose between
// the English and Chinese first-page sheets, and there is no first-page
// sheet any more -- the cover owns page one. Kept because callers pass it.
function wrap(bodyXml, { bilingual = false } = {}) {  // eslint-disable-line no-unused-vars
  const PizZip = require("pizzip");
  const fs = require("fs");
  const path = require("path");
  const zip = new PizZip();

  const art = (f) => fs.readFileSync(path.join(__dirname, "assets", "brand", f));

  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
    `<Override PartName="/word/header2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` +
    `</Types>`);

  zip.file("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`);

  // header1 runs on every page after the first. header2 is the FIRST page,
  // which is the cover -- and the cover carries the firm's mark itself, so
  // that header is deliberately empty. It used to hold the full first-page
  // sheet, which put a second shield and a second footer on top of the
  // cover's own.
  zip.file("word/media/letterhead-continuation.png", art("letterhead-continuation.png"));
  zip.file("word/header1.xml", sheetHeader("Continuation sheet"));
  zip.file("word/header2.xml", emptyHeader());
  zip.file("word/_rels/header1.xml.rels", headerRels("media/letterhead-continuation.png"));
  zip.file("word/_rels/header2.xml.rels", headerRels(null));

  zip.file("word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` +
    `<Relationship Id="rIdH2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>` +
    `</Relationships>`);

  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${NS.w} ${NS.r} ${NS.wp} ${NS.a} ${NS.pic}>` +
    `<w:body>${bodyXml}` +
    `<w:sectPr>` +
    `<w:headerReference w:type="default" r:id="rIdH1"/>` +
    `<w:headerReference w:type="first" r:id="rIdH2"/>` +
    // titlePg: the first page (the cover) takes the empty header, every
    // page after it the continuation sheet. Without it Word uses one
    // header for all and the cover gets a letterhead on top of it.
    `<w:titlePg/>` +
    `<w:pgSz w:w="12240" w:h="15840"/>` +
    // Measured off the continuation sheet, not guessed: its ink stops at
    // 0.85in and its rule sits at 10.47in, so 1.15in top (1656 twips) and
    // 0.80in bottom (1152). The old 1.3in/1.0in was the FIRST-page sheet's,
    // whose office block starts at 9.35in -- text ran through it.
    `<w:pgMar w:top="1656" w:right="1080" w:bottom="1152" w:left="1080" w:header="0" w:footer="0"/>` +
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
  // Without the cover and the letter's head: this builder makes its own.
  const html = doc.body(a, { forClient: true, withLetterhead: false });
  // ORDER. "the tez profile is still in the front. But it should be after
  // the signature page." (JJ, 2026-10-09)
  //
  // The HTML already had it last; this builder did not, because it adds
  // the profile itself rather than taking it from the body -- body() is
  // asked for the agreement WITHOUT the letterhead, and the profile rides
  // with the letterhead. So it went in right after the cover, which put
  // the firm's sales page between the cover and the client's own letter.
  //
  // Now: cover, letter, agreement, signatures, payment, then the profile
  // on a page of its own at the back, where a reader who wants it will
  // find it and a reader who does not has already signed.
  //
  // The offices are on the letterhead sheet and in the profile, so they
  // are not printed a third time at the end.
  return wrap(
    coverPage(doc.FIRM, a, doc) + pageBreak() +
    letterhead(doc.FIRM, a, doc) + fromHtml(html) +
    pageBreak() + fromHtml(doc.firmProfilePage(a)),
    { bilingual: !!a.bilingual });
}

/** A filename a person can find again. */
function fileName(a = {}) {
  const who = String(a.client_name || "Client").replace(/[^\w一-鿿 -]+/g, "").trim() || "Client";
  const when = dateFor(a).iso;
  return `Attorney-Client Fee Agreement - ${who} - ${when}.docx`;
}

module.exports = { build, fileName, fromHtml, runsFrom, tableXml, wrap, coverPage, dateFor };
