// ============================================================
//  i589-vision.js — READING A SCANNED I-589
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  JJ, after the first scan came back almost entirely
//  unreadable: "just look at 589 application scanned pdf and
//  look at question 8 on the application."
//
//  He is right, and it explains the result. The firm's I-589s
//  are SCANS — images of pages. A scan has no AcroForm fields
//  and no text layer, so both existing read methods find
//  nothing: pdf-lib sees no fields, pdf-parse returns an empty
//  string, and every row comes back "item 8 heading not found".
//  The one that worked was a genuine fillable PDF.
//
//  So this one looks at the page instead, the same way
//  individual-hearing-notes.js already reads filed PDFs.
//
//  THE RULES ARE THE SAME, and they are in the prompt because
//  here the model IS the parser:
//    · Item 8 only. Item 9 is the mailing address and on a
//      represented case it is frequently this firm's office —
//      harvesting it would replace clients' home addresses with
//      Tez Law's.
//    · Nothing invented. A field it cannot read comes back null,
//      and a null stays null all the way to the review screen.
//    · Only page 1 is sent. Item 8 is on it, the rest of the
//      form is somebody's asylum claim, and there is no reason
//      to ship twelve pages of it to a model to read an address.
// ============================================================

// The same model string the working document-block call in
// individual-hearing-notes.js uses. The first version of this sent
// "claude-sonnet-4-6", copied from other files in this repo that send PLAIN
// TEXT, and every scan came back "Request failed with status code 400".
//
// Haiku 4.5 reads a scanned page perfectly well, and for twenty-seven of them
// it is faster and cheaper than Sonnet, which matters more here than depth:
// the task is reading six fields off a form, not reasoning about them.
const MODEL = process.env.I589_VISION_MODEL || "claude-haiku-4-5-20251001";

const PROMPT = `This is page 1 of a Form I-589 (Application for Asylum and for Withholding of Removal).

Read ONLY Item Number 8, "Residence in the U.S." — where the applicant physically lives.

DO NOT read Item Number 9. Item 9 is the mailing address, and on a represented
case it is very often the law firm's own address. Nothing from Item 9 may appear
in your answer. If Item 8 is blank but Item 9 is filled in, Item 8 is still blank.

Return JSON with exactly these keys:
  "street"  - street number and name from item 8, or null
  "apt"     - apartment/suite/floor number from item 8, or null
  "city"    - city or town from item 8, or null
  "state"   - two-letter state from item 8, or null
  "zip"     - ZIP code from item 8, or null
  "phone"   - telephone number from item 8, or null
  "legible" - true if you could actually read item 8; false if the scan is too
              poor, the page is not an I-589, or item 8 is not visible
  "note"    - one short sentence if anything was hard to read, else null

Rules:
- Handwriting counts: read it if you can read it.
- If a field is empty on the form, return null for it. Do not guess.
- If you are unsure of a character (a 3 that might be an 8), set legible to
  false and say so in note. A wrong address is worse than no address: these are
  people in removal proceedings and a bad address means a missed hearing notice.
- Return only the JSON object.`;

/**
 * Just page 1, as its own PDF.
 * Works on a scan as well as a text PDF — pdf-lib copies the page object
 * whatever it contains.
 */
async function firstPage(buffer) {
  const { PDFDocument } = require("pdf-lib");
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  if (src.getPageCount() === 0) throw new Error("the PDF has no pages");
  if (src.getPageCount() === 1) return buffer;
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [0]);
  out.addPage(page);
  return Buffer.from(await out.save());
}

/**
 * Read item 8 by looking at the page.
 * Returns the same shape the text and field readers produce, so the sweep and
 * the review screen do not care which one answered.
 */
async function readItem8(buffer, { ask = null } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, method: "vision", address: "", phone: "", notes: ["no ANTHROPIC_API_KEY set on the server"] };
  }

  let page1;
  try { page1 = await firstPage(buffer); }
  catch (e) { return { ok: false, method: "vision", address: "", phone: "", notes: ["could not open the PDF: " + e.message] }; }

  const call = ask || (async (pdf) => {
    const axios = require("axios");
    const resp = await axios.post("https://api.anthropic.com/v1/messages", {
      model: MODEL,
      max_tokens: 1000,
      messages: [
        { role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          { type: "text", text: PROMPT },
        ] },
        { role: "assistant", content: "{" },
      ],
    }, {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 120000,
    });
    return "{" + (resp.data.content[0].text || "");
  });

  let got;
  try {
    const raw = await call(page1);
    got = JSON.parse(String(raw).trim());
  } catch (e) {
    return { ok: false, method: "vision", address: "", phone: "", notes: ["could not read the page: " + describe(e)] };
  }

  return shape(got);
}

/**
 * Say what actually went wrong.
 *
 * axios throws with e.message = "Request failed with status code 400", which
 * is true and useless — the API puts the reason in the response body. Every
 * row on the review screen said exactly that for an afternoon, which cost a
 * round trip to find out something the server had been told the first time.
 *
 * So: the API's own words when there are any, the status when there are not.
 */
function describe(e) {
  const body = e && e.response && e.response.data;
  const fromApi = body && body.error && body.error.message;
  if (fromApi) return fromApi;
  if (body && typeof body === "string" && body.length < 300) return body;
  if (e && e.response && e.response.status) {
    return "HTTP " + e.response.status + " from the API with no explanation in the body";
  }
  return (e && e.message) || "unknown error";
}

/**
 * Turn the model's answer into the same result the other readers give.
 * Kept separate so it can be checked without calling anything.
 */
function shape(got) {
  const x = require("./i589-extract");
  const clean = v => {
    const s = String(v == null ? "" : v).trim();
    return s && !/^(null|n\/?a|none|unknown)$/i.test(s) ? s : "";
  };
  const g = {
    street: clean(got.street), apt: clean(got.apt), city: clean(got.city),
    state: clean(got.state).toUpperCase().slice(0, 2), zip: clean(got.zip),
  };
  const phone = x.normalizePhone(clean(got.phone));
  const notes = [];
  if (clean(got.note)) notes.push(clean(got.note));

  if (got.legible === false) {
    notes.unshift("the scan could not be read reliably");
    return { ok: false, method: "vision", address: "", phone: "", partial: g.street ? x.joinAddress(g) : "", notes };
  }

  // Same bar as the text reader: a street with no city or state is not a
  // postal address, and a hearing notice sent to it would not arrive.
  const complete = !!(g.street && g.city && g.state);
  if (g.street && !g.city) notes.push("city could not be read from item 8");
  if (g.street && !g.state) notes.push("state could not be read from item 8");
  if (!g.street && !phone) notes.push("item 8 appears to be blank on this form");

  return {
    ok: !!((complete && g.street) || phone),
    method: "vision",
    address: complete ? x.joinAddress(g) : "",
    phone: x.formatPhone(phone),
    partial: !complete && g.street ? x.joinAddress(g) : "",
    notes,
  };
}

module.exports = { readItem8, firstPage, shape, describe, PROMPT, MODEL };
