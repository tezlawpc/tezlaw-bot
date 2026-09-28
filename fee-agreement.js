/**
 * fee-agreement.js — read a signed retainer or fee agreement and PROPOSE client fields.
 *
 * The word proposing is load-bearing. Extracted fields split into two kinds:
 *
 *   identity  — name, A-number, phone, email, address, matter type. A wrong
 *               value here is annoying and visible, so these may prefill a form.
 *
 *   fee terms — amount, structure, what is included and excluded, who pays
 *               costs. A wrong value here is the substance of a fee dispute and
 *               later of a Bar complaint. These NEVER prefill silently: each one
 *               comes back with the verbatim sentence it was read from, so a
 *               human confirms it against the document in seconds.
 *
 * Nothing here writes to a client record. It returns a proposal; the caller
 * shows it, a person accepts it, and the caller saves. That separation is the
 * whole safety property — keep it.
 */

const axios = require("axios");

const MAX_CHARS = 60000;   // ~15 pages; fee agreements are far shorter

const IDENTITY_FIELDS = [
  "client_name", "a_number", "client_phone", "client_email",
  "client_address", "matter_type", "opposing_party", "signed_date",
];
const FEE_FIELDS = [
  "fee_structure", "fee_amount", "hourly_rate", "retainer_deposit",
  "scope_included", "scope_excluded", "costs_responsibility", "payment_schedule",
];

/** Pull text out of the uploaded file. No OCR — say so rather than guess. */
async function textFrom({ buffer, filename = "" }) {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".pdf")) {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    const text = (data && data.text ? data.text : "").trim();
    if (text.length < 40) {
      // A scan with no text layer. Guessing at a fee from an image is exactly
      // the failure mode this module exists to avoid.
      const e = new Error(
        "This PDF has no text layer — it looks like a scan or photo. " +
        "There is no OCR on the server, so nothing can be read from it reliably. " +
        "Upload a text PDF, or enter the fields by hand."
      );
      e.code = "NO_TEXT_LAYER";
      throw e;
    }
    return text;
  }
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return buffer.toString("utf8");
  if (/\.(jpe?g|png|heic|tiff?)$/.test(lower)) {
    const e = new Error("Photos and images cannot be read — there is no OCR on the server. Upload a PDF of the agreement.");
    e.code = "IMAGE_UNSUPPORTED";
    throw e;
  }
  if (lower.endsWith(".docx")) {
    const e = new Error("Word files are not supported yet — export the agreement to PDF and upload that.");
    e.code = "DOCX_UNSUPPORTED";
    throw e;
  }
  const e = new Error(`Unsupported file type: ${filename || "(no name)"}. Upload a PDF.`);
  e.code = "UNSUPPORTED";
  throw e;
}

function buildPrompt(text) {
  return `You are reading a signed legal fee or retainer agreement from a law firm. Extract only what the document actually says.

RULES — these matter more than completeness:
- If the document does not state something, return null. Never infer, never guess, never fill from what is typical.
- For every non-null value, include the VERBATIM sentence or clause you read it from, in "quote". If you cannot quote it, the value must be null.
- Money: digits only, no currency symbols or commas (e.g. 5000, not $5,000.00).
- Dates: YYYY-MM-DD. If only a month and year appear, return null.
- a_number: digits only, no "A" prefix, no dashes.
- fee_structure must be exactly one of: flat, hourly, contingency, hybrid, or null.
- scope_included and scope_excluded are arrays of short phrases quoted from the document, or empty arrays.
- matter_type: the practice area in the document's own words (e.g. "removal defense", "unlawful detainer").

Return ONLY valid JSON, no prose before or after, in exactly this shape:

{
  "identity": {
    "client_name":     {"value": null, "quote": null},
    "a_number":        {"value": null, "quote": null},
    "client_phone":    {"value": null, "quote": null},
    "client_email":    {"value": null, "quote": null},
    "client_address":  {"value": null, "quote": null},
    "matter_type":     {"value": null, "quote": null},
    "opposing_party":  {"value": null, "quote": null},
    "signed_date":     {"value": null, "quote": null}
  },
  "fee_terms": {
    "fee_structure":        {"value": null, "quote": null},
    "fee_amount":           {"value": null, "quote": null},
    "hourly_rate":          {"value": null, "quote": null},
    "retainer_deposit":     {"value": null, "quote": null},
    "scope_included":       {"value": [],   "quote": null},
    "scope_excluded":       {"value": [],   "quote": null},
    "costs_responsibility": {"value": null, "quote": null},
    "payment_schedule":     {"value": null, "quote": null}
  },
  "document_type": "retainer agreement | fee agreement | engagement letter | other",
  "concerns": []
}

"concerns" is for things a reviewing attorney should look at: an unsigned signature block, a blank fee amount, contradictory terms, a missing scope clause. Quote them. An empty array is fine.

AGREEMENT TEXT:
---
${text}
---`;
}

/** Strip anything the model wrapped around the JSON, then parse. */
function parseJsonBlock(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) throw new Error("the model did not return JSON");
  return JSON.parse(s.slice(a, b + 1));
}

/** Drop any value that arrived without a quote — unquoted means unverifiable. */
function requireQuotes(group, keys) {
  const out = {}, dropped = [];
  for (const k of keys) {
    const cell = (group && group[k]) || {};
    const isArray = Array.isArray(cell.value);
    const empty = cell.value == null || (isArray && cell.value.length === 0) || cell.value === "";
    if (empty) { out[k] = { value: isArray ? [] : null, quote: null }; continue; }
    if (!cell.quote || !String(cell.quote).trim()) {
      dropped.push(k);
      out[k] = { value: isArray ? [] : null, quote: null };
      continue;
    }
    out[k] = { value: cell.value, quote: String(cell.quote).trim() };
  }
  return { out, dropped };
}

/**
 * Read an agreement and return a PROPOSAL. Never writes anything.
 *
 * { ok, document_type, identity, fee_terms, concerns, dropped_unquoted, text_chars }
 *
 * identity values may prefill a form. fee_terms values must be confirmed by a
 * person before they are saved anywhere — every one carries its source quote
 * so that confirmation is a real check and not a rubber stamp.
 */
async function extractFromAgreement({ buffer, filename }) {
  if (!buffer || !buffer.length) throw new Error("no file was uploaded");
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server");

  let text = await textFrom({ buffer, filename });
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);

  const body = {
    model: require("./zara-core").TIERS.balanced.anthropic,
    max_tokens: 4096,
    messages: [{ role: "user", content: buildPrompt(text) }],
  };
  const resp = await axios.post("https://api.anthropic.com/v1/messages", body, {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    timeout: 120000,
  });
  const raw = (resp.data.content || []).filter(b => b.type === "text").map(b => b.text).join("");

  let parsed;
  try { parsed = parseJsonBlock(raw); }
  catch (e) { throw new Error(`could not read the extraction result: ${e.message}`); }

  const id = requireQuotes(parsed.identity, IDENTITY_FIELDS);
  const fee = requireQuotes(parsed.fee_terms, FEE_FIELDS);

  // Normalise the A-number to digits so it matches what the folder matcher wants.
  if (id.out.a_number.value) {
    id.out.a_number.value = String(id.out.a_number.value).replace(/\D/g, "") || null;
  }

  const concerns = Array.isArray(parsed.concerns) ? parsed.concerns.filter(Boolean).map(String) : [];
  if (truncated) concerns.push("The agreement was longer than we read — only the first part was examined. Check the later pages by hand.");
  if (!fee.out.fee_structure.value) concerns.push("No fee structure (flat, hourly, contingency) could be quoted from the document.");

  return {
    ok: true,
    document_type: parsed.document_type || null,
    identity: id.out,
    fee_terms: fee.out,
    concerns,
    // Values the model produced but could not quote. Surfaced rather than hidden:
    // an unquotable value is one it could not point at in the document.
    dropped_unquoted: [...id.dropped, ...fee.dropped],
    text_chars: text.length,
    truncated,
  };
}

module.exports = {
  extractFromAgreement,
  textFrom,
  parseJsonBlock,
  requireQuotes,
  IDENTITY_FIELDS,
  FEE_FIELDS,
};
