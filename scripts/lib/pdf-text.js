/**
 * pdf-text.js — the text drawn into a PDF, read from its content streams.
 *
 * Why this exists instead of pdf-parse:
 *
 * pdf-parse@1.1.1 bundles pdf.js v1.10.100 (2018), and that version cannot
 * read a SINGLE-PAGE pdf-lib document. It reports "bad XRef entry" on a file
 * that is structurally valid — startxref correct, every object offset
 * correct, xref entries exactly the 20 bytes the spec requires. Two pages and
 * up parse fine. Real-world PDFs parse fine. Re-saving someone else's PDF
 * through pdf-lib parses fine. Only from-scratch single-page output trips it.
 *
 * That combination is why nothing in production is affected: all six
 * production callers of pdf-parse read documents made by somebody else —
 * court notices, retainer agreements, filed documents. The signature
 * certificate is the one PDF this platform both creates and reads back, and
 * it is usually one page.
 *
 * So the check reads the drawn strings directly rather than depending on a
 * seven-year-old parser's handling of an edge case. It is also a better
 * check: it asserts what was drawn, not what a parser chose to recover.
 */
const zlib = require("zlib");

function pdfText(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf);
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    const raw = Buffer.from(s.slice(start, end), "latin1");
    let body;
    try { body = zlib.inflateSync(raw).toString("latin1"); }
    catch { body = raw.toString("latin1"); }   // uncompressed content streams
    // pdf-lib writes drawn text as hex strings; other writers use literals.
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      out.push(Buffer.from(t[1].replace(/\s+/g, ""), "hex").toString("latin1"));
    }
    for (const t of body.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)) {
      out.push(t[1].replace(/\\([()\\])/g, "$1"));
    }
  }
  return out.join("\n");
}

module.exports = { pdfText };
