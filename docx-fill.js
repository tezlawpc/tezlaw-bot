// ============================================================
//  docx-fill.js — Word documents as templates, without losing
//  their formatting.
// ------------------------------------------------------------
//  A filed document keeps its caption, pleading paper, fonts and
//  line numbers only if we edit it where it lives: inside the
//  .docx XML. Everything here works on that XML directly.
//
//  The one hard part: Word splits text into "runs" wherever the
//  formatting, spell-check state or edit history changes, so
//  "Jing Liu" can be stored as "Ji" + "ng L" + "iu". A plain
//  search-and-replace misses it. replaceText() reads each
//  paragraph as one string, finds the text there, and edits the
//  runs it spans — keeping the formatting of the run it starts in.
//
//  Placeholders are {{field_key}}. Signature spots are
//  {{sig:role}}, {{date:role}} and {{name:role}}.
// ============================================================

const PizZip = require("pizzip");

const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
// {{key}} or {{key|upper}} — the caption often repeats a name in capitals.
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_:.-]+)\s*(?:\|\s*(upper|lower)\s*)?\}\}/g;

// ── XML text helpers ────────────────────────────────────────

function decode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}
function encode(s) {
  return String(s)
    // Characters XML 1.0 does not allow at all.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Paragraphs, including ones inside textboxes ─────────────
//
// A paragraph can contain another one: a textbox or shape sits inside a
// run of its paragraph and holds paragraphs of its own. So the XML is
// walked token by token rather than matched paragraph by paragraph. The
// text before a textbox, each paragraph inside it, and the text after it
// are separate groups: nothing is matched across a textbox edge, and no
// text is ever skipped.
const TOKEN_RE = /<w:p\b[^>]*?(\/?)>|<\/w:p>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;

function segments(xml) {
  const segs = [];
  let cur = null, depth = 0, m;
  const start = (continuation) => { cur = { nodes: [], continuation }; segs.push(cur); };
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(xml))) {
    const tok = m[0];
    if (tok === "</w:p>") {
      depth = Math.max(0, depth - 1);
      if (depth > 0) start(true); else cur = null;       // back in the outer paragraph
    } else if (tok.startsWith("<w:p")) {
      if (m[1] === "/") {                                  // <w:p/>: an empty paragraph
        start(false);
        if (depth > 0) start(true); else cur = null;
      } else { depth++; start(false); }
    } else {
      if (!cur) start(true);
      cur.nodes.push({ xmlStart: m.index, xmlEnd: m.index + tok.length, text: decode(m[2]), dirty: false });
    }
  }
  // Continuation groups with no text are not paragraphs anyone can see.
  return segs.filter(g => !(g.continuation && !g.nodes.length));
}

/** Replace inside one group of text nodes. Mutates the nodes; returns the count. */
function replaceInNodes(nodes, pairs) {
  if (!nodes.length) return 0;
  let count = 0;
  for (const { find, replace } of pairs) {
    const full = nodes.map(n => n.text).join("");
    const matches = [];
    if (find instanceof RegExp) {
      const re = new RegExp(find.source, find.flags.includes("g") ? find.flags : find.flags + "g");
      let m;
      while ((m = re.exec(full))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        matches.push({ from: m.index, to: m.index + m[0].length, text: typeof replace === "function" ? replace(...m) : String(replace) });
      }
    } else if (find) {
      let i = full.indexOf(find);
      while (i !== -1) {
        matches.push({ from: i, to: i + find.length, text: String(replace) });
        i = full.indexOf(find, i + find.length);
      }
    }
    if (!matches.length) continue;
    count += matches.length;
    // Right to left, so earlier offsets stay valid.
    for (const mt of matches.reverse()) {
      let pos = 0, placed = false;
      for (const n of nodes) {
        const from = pos, to = pos + n.text.length;
        pos = to;
        if (to <= mt.from || from >= mt.to) continue;
        const a = Math.max(mt.from, from) - from;
        const b = Math.min(mt.to, to) - from;
        // The replacement goes in the run where the match starts, in its formatting.
        n.text = n.text.slice(0, a) + (placed ? "" : mt.text) + n.text.slice(b);
        n.dirty = true;
        placed = true;
      }
    }
  }
  return count;
}

function rebuild(xml, segs) {
  const nodes = [];
  for (const g of segs) for (const n of g.nodes) if (n.dirty) nodes.push(n);
  if (!nodes.length) return xml;
  nodes.sort((x, y) => x.xmlStart - y.xmlStart);
  let out = "", last = 0;
  for (const n of nodes) {
    out += xml.slice(last, n.xmlStart) + `<w:t xml:space="preserve">${encode(n.text)}</w:t>`;
    last = n.xmlEnd;
  }
  return out + xml.slice(last);
}

/** Replace text inside a single paragraph's XML (kept for callers and tests). */
function replaceInParagraph(paraXml, pairs) {
  const segs = segments(paraXml);
  let count = 0;
  for (const g of segs) count += replaceInNodes(g.nodes, pairs);
  return { xml: count ? rebuild(paraXml, segs) : paraXml, count };
}

// ── Whole-document operations ───────────────────────────────

function load(buffer) {
  try { return new PizZip(buffer); }
  catch (e) { throw new Error("That is not a readable Word (.docx) file"); }
}

function textPartNames(zip) {
  const names = Object.keys(zip.files).filter(n => TEXT_PARTS.test(n));
  if (!names.includes("word/document.xml")) throw new Error("That .docx has no document body");
  // Body first, so paragraph numbers start in the body.
  return ["word/document.xml", ...names.filter(n => n !== "word/document.xml").sort()];
}

/** Every paragraph's text, in order, tagged with the part it is in. */
function paragraphs(buffer) {
  const zip = load(buffer);
  const out = [];
  for (const part of textPartNames(zip)) {
    for (const g of segments(zip.file(part).asText())) out.push({ part, text: g.nodes.map(n => n.text).join("") });
  }
  return out;
}

function plainText(buffer) {
  return paragraphs(buffer).filter(p => p.part === "word/document.xml").map(p => p.text).join("\n");
}

/**
 * Apply replacements across the document, headers and footers.
 * `pairs`: [{find, replace}] applied in order. `only`: optional
 * { index: [pairs] } for replacements limited to one paragraph
 * (numbered as paragraphs() numbers them).
 */
function replaceText(buffer, pairs = [], { only = null } = {}) {
  const zip = load(buffer);
  const counts = new Array(pairs.length).fill(0);
  let index = 0, total = 0;
  for (const part of textPartNames(zip)) {
    const xml = zip.file(part).asText();
    const segs = segments(xml);
    for (const g of segs) {
      pairs.forEach((pair, i) => { const c = replaceInNodes(g.nodes, [pair]); counts[i] += c; total += c; });
      if (only && only[index]) total += replaceInNodes(g.nodes, only[index]);
      index++;
    }
    const next = rebuild(xml, segs);
    if (next !== xml) zip.file(part, next);
  }
  return { buffer: zip.generate({ type: "nodebuffer", compression: "DEFLATE" }), counts, total };
}

/** The {{placeholders}} a template uses, in first-seen order. */
function placeholders(buffer) {
  const seen = [];
  for (const p of paragraphs(buffer)) {
    let m;
    PLACEHOLDER.lastIndex = 0;
    while ((m = PLACEHOLDER.exec(p.text))) if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/**
 * Fill {{key}} placeholders. Signature spots ({{sig:…}}, {{date:…}},
 * {{name:…}}) are left for signing. Returns { buffer, missing }.
 */
function fill(buffer, values = {}) {
  const missing = [];
  for (const k of placeholders(buffer)) {
    if (/^(sig|date|name|initials):/.test(k)) continue;
    const v = values[k];
    if (v === undefined || v === null || String(v).trim() === "") missing.push(k);
  }
  const out = replaceText(buffer, [{
    find: PLACEHOLDER,
    replace: (whole, key, filter) => {
      if (/^(sig|date|name|initials):/.test(key)) return whole;
      const v = values[key];
      if (v === undefined || v === null || String(v).trim() === "") return whole;
      return filter === "upper" ? String(v).toUpperCase() : filter === "lower" ? String(v).toLowerCase() : String(v);
    },
  }]);
  return { buffer: out.buffer, missing };
}

// ── Signatures ──────────────────────────────────────────────

function pngSize(png) {
  // IHDR: width and height are big-endian at bytes 16..23.
  if (png.length > 24 && png.readUInt32BE(12) === 0x49484452) {
    return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
  }
  return { w: 600, h: 200 };
}

function ensureImageSupport(zip) {
  const ctPath = "[Content_Types].xml";
  let ct = zip.file(ctPath).asText();
  if (!/Extension="png"/i.test(ct)) {
    ct = ct.replace("</Types>", `<Default Extension="png" ContentType="image/png"/></Types>`);
    zip.file(ctPath, ct);
  }
  const relsPath = "word/_rels/document.xml.rels";
  if (!zip.file(relsPath)) {
    zip.file(relsPath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  }
  let doc = zip.file("word/document.xml").asText();
  const root = doc.match(/<w:document\b[^>]*>/);
  if (root) {
    let tag = root[0];
    const need = {
      "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "xmlns:wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
      "xmlns:a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "xmlns:pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    };
    for (const [k, v] of Object.entries(need)) {
      if (!new RegExp(`\\s${k}=`).test(tag)) tag = tag.replace(/>$/, ` ${k}="${v}">`);
    }
    if (tag !== root[0]) { doc = doc.replace(root[0], tag); zip.file("word/document.xml", doc); }
  }
}

function drawingRun(rId, id, cx, cy) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Signature ${id}"/><wp:cNvGraphicFramePr/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="esign_${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

/**
 * Put signatures in. `signed` is { role: { png: Buffer, name, date } }.
 * {{sig:role}} becomes the drawn signature, {{name:role}} the typed name,
 * {{date:role}} the signing date. Roles not in `signed` are left alone.
 * Signature pictures go in the document body (not headers or footers).
 */
function applySignatures(buffer, signed = {}) {
  const roles = Object.keys(signed);
  const pairs = [];
  roles.forEach((role, i) => {
    const s = signed[role];
    pairs.push({ find: `{{name:${role}}}`, replace: s.name || "" });
    pairs.push({ find: `{{date:${role}}}`, replace: s.date || "" });
    pairs.push({ find: `{{initials:${role}}}`, replace: s.initials || "" });
    // Each signature spot becomes a marker that sits whole in one text node.
    if (s.png) pairs.push({ find: `{{sig:${role}}}`, replace: `SIG${i}` });
  });
  const buf = pairs.length ? replaceText(buffer, pairs).buffer : buffer;

  const zip = load(buf);
  ensureImageSupport(zip);
  let doc = zip.file("word/document.xml").asText();
  let rels = zip.file("word/_rels/document.xml.rels").asText();
  const placed = {};
  let pic = 0;

  roles.forEach((role, i) => {
    const s = signed[role];
    if (!s.png) return;
    const marker = `SIG${i}`;
    placed[role] = 0;
    if (doc.indexOf(marker) === -1) return;
    const { w, h } = pngSize(s.png);
    const cx = 1714500;                                  // 1.875 inches wide
    const cy = Math.max(228600, Math.min(800000, Math.round(cx * h / Math.max(1, w))));
    const file = `media/esign_${role.replace(/[^a-z0-9_]/gi, "_")}_${i + 1}.png`;
    const rId = `rIdEsign${i + 1}`;
    zip.file("word/" + file, s.png);
    rels = rels.replace("</Relationships>",
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${file}"/></Relationships>`);

    // Split the innermost run that holds the marker: [text before] [picture]
    // [text after]. Everything else in that run is kept, in order.
    let idx;
    while ((idx = doc.indexOf(marker)) !== -1) {
      const runStart = Math.max(doc.lastIndexOf("<w:r>", idx), doc.lastIndexOf("<w:r ", idx));
      const runEndAt = doc.indexOf("</w:r>", idx);
      if (runStart === -1 || runEndAt === -1) { doc = doc.replace(marker, ""); continue; }
      const openEnd = doc.indexOf(">", runStart) + 1;
      const runOpen = doc.slice(runStart, openEnd);
      const bodyXml = doc.slice(openEnd, runEndAt);
      const rPrM = bodyXml.match(/^\s*<w:rPr>[\s\S]*?<\/w:rPr>/);
      const rPr = rPrM ? rPrM[0] : "";
      const rest = bodyXml.slice(rPr.length);
      const at = rest.indexOf(marker);
      const before = rest.slice(0, at);                  // ends inside the <w:t> that held the marker
      const after = rest.slice(at + marker.length);      // starts inside that same <w:t>
      pic++;
      const replacement =
        `${runOpen}${rPr}${before}</w:t></w:r>` +
        drawingRun(rId, 9000 + pic, cx, cy) +
        `${runOpen}${rPr}<w:t xml:space="preserve">${after}</w:r>`;
      doc = doc.slice(0, runStart) + replacement + doc.slice(runEndAt + "</w:r>".length);
      placed[role]++;
    }
  });
  zip.file("word/document.xml", doc);
  zip.file("word/_rels/document.xml.rels", rels);
  return { buffer: zip.generate({ type: "nodebuffer", compression: "DEFLATE" }), placed };
}

// ── A .docx from plain text (for a filed PDF) ──────────────

function textToDocx(text, { title = null } = {}) {
  const zip = new PizZip();
  const para = (t, bold) => `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr>${bold ? "<w:b/>" : ""}` +
    `<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr>` +
    `<w:t xml:space="preserve">${encode(t)}</w:t></w:r></w:p>`;
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const body = (title ? [para(title, true)] : []).concat(lines.map(l => para(l, false))).join("");
  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = {
  paragraphs, plainText, replaceText, replaceInParagraph, segments, placeholders, fill,
  applySignatures, textToDocx, pngSize, decode, encode, PLACEHOLDER,
};
