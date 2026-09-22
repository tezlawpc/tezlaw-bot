// ============================================================
//  civil-intake-extract.js
//  Reading a new matter out of the documents that opened it.
//  ─────────────────────────────────────────────────────────
//  Opening a civil matter means retyping things that are already
//  written down: the parties, the court, the case number, the
//  filing date — all on the face of the complaint; the fee
//  arrangement — all in the retainer. Retyping them is slow and
//  it is where transcription errors enter a case file.
//
//  So Zara reads the documents and PROPOSES the fields. The
//  attorney confirms or corrects every one before anything is
//  saved. That is not politeness, it is the design:
//
//    · Nothing here is ever written straight to a matter. The
//      output is a proposal that populates a form the attorney
//      is already looking at.
//
//    · Every proposed value carries the exact snippet it came
//      from, so confirming it is reading one line rather than
//      trusting a machine.
//
//    · A field the documents do not contain comes back null.
//      Never a guess, never a plausible-looking default. A
//      wrong case number that looks right is worse than a blank
//      one, because a blank one gets filled in.
//
//  And some things documents simply cannot tell you — when the
//  client actually paid, what rate was agreed on the phone. Those
//  stay the attorney's to enter, and the API says so explicitly
//  rather than leaving a suspiciously empty box.
// ============================================================

const core = require("./zara-core");

const MAX_CHARS_PER_DOC = 18000;   // a complaint's first pages carry the caption
const MAX_DOCS = 6;

// ── Text extraction ─────────────────────────────────────────

async function textFromBuffer(buffer, filename = "") {
  const name = String(filename).toLowerCase();

  if (name.endsWith(".pdf")) {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return String(data.text || "");
  }
  if (name.endsWith(".docx")) {
    const mammoth = require("mammoth");
    const out = await mammoth.extractRawText({ buffer });
    return String(out.value || "");
  }
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".csv")) {
    return buffer.toString("utf8");
  }
  // A spreadsheet — e.g. a billing ledger attached in the Zara chat — reads as
  // CSV, one block per sheet, with dates as dates rather than serial numbers.
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    return wb.SheetNames.map(s =>
      `=== Sheet: ${s} ===\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s], { dateNF: "yyyy-mm-dd", blankrows: false })
    ).join("\n\n");
  }
  // A scan with no text layer reaches here as an empty string, which the
  // caller reports honestly rather than sending an empty prompt to the model.
  throw new Error("Unsupported file type: " + (filename || "unknown") +
    " — upload a PDF, DOCX or TXT.");
}

/** What kind of document is this, by name? A hint only; the model re-checks. */
function guessKind(filename = "") {
  const n = String(filename).toLowerCase();
  if (/retainer|engagement|fee\s*agreement|representation/.test(n)) return "retainer";
  if (/summons/.test(n)) return "summons";
  if (/complaint|petition|cross-?complaint/.test(n)) return "complaint";
  return "unknown";
}

// ── The schema Zara fills in ────────────────────────────────
//
// Kept flat and named exactly as the civil_cases columns are, so the form
// can map straight across without a translation layer that could drift.
const FIELDS = {
  pleading: [
    ["case_name", "Case caption as the court styles it, e.g. 'Smith v. Acme Corp.'"],
    ["plaintiffs", "Every plaintiff / petitioner, as an array of names"],
    ["defendants", "Every defendant / respondent, as an array of names"],
    ["court", "The full court name as printed, e.g. 'Superior Court of California, County of Los Angeles'"],
    ["county", "County only, if a state court"],
    ["case_number", "The docket or case number exactly as printed"],
    ["filed_date", "Date the complaint was filed, YYYY-MM-DD — the court's file stamp, NOT the date it was served or signed"],
    ["case_type", "The cause of action in a few words, e.g. 'breach of contract', 'unlawful detainer', 'motor vehicle negligence'"],
    ["amount_in_controversy", "Damages demanded, as a plain number, only if the pleading states a figure"],
    ["jurisdiction", "One of: CA, NY, TX, FL, IL, NJ, GA, PA, AZ, NV, WA, FED — whichever the caption shows"],
  ],
  retainer: [
    ["billing_type", "One of: hourly, contingency, flat, hybrid"],
    ["hourly_rate", "The attorney's hourly rate as a plain number, if hourly"],
    ["contingency_pct", "Contingency percentage as a plain number, e.g. 33.33"],
    ["retainer_amount", "Initial retainer / deposit required, as a plain number"],
    ["client_name", "The client as named in the agreement"],
    ["fee_arrangement_notes", "Anything unusual worth an attorney's eye: sliding scale, tiered rates, cost advances, hybrid terms"],
  ],
};

function schemaFor(kind) {
  const rows = kind === "retainer" ? FIELDS.retainer : FIELDS.pleading;
  return rows.map(([k, desc]) => `  "${k}": <${desc}, or null>`).join(",\n");
}

// ── The prompt ──────────────────────────────────────────────

function buildPrompt(kind, docs) {
  const body = docs.map((d, i) =>
    `--- DOCUMENT ${i + 1}: ${d.filename} (looks like: ${d.kind}) ---\n` +
    d.text.slice(0, MAX_CHARS_PER_DOC)
  ).join("\n\n");

  return [
    kind === "retainer"
      ? "Read this fee agreement and extract the fee terms."
      : "Read these filed papers and extract the case's identifying details.",
    "",
    "Return ONLY a JSON object, no prose before or after, in exactly this shape:",
    "{",
    schemaFor(kind) + ",",
    '  "_evidence": { "<field name>": "<the exact phrase from the document that gave you this value, under 120 characters>" },',
    '  "_unreadable": <true only if the documents contain no usable text at all>',
    "}",
    "",
    "RULES — these matter more than filling the object in:",
    "· A field you cannot find in the text is null. Never infer, never guess, never supply a typical value. A blank field gets filled in by the attorney; a wrong one that looks right gets filed.",
    "· Every non-null field must have an entry in _evidence quoting the document. If you cannot quote it, you did not find it — return null.",
    "· Copy case numbers, names and dates EXACTLY as printed, including punctuation and party suffixes. Do not normalise 'Acme Corp.' to 'Acme Corporation'.",
    "· The filing date is the court's file stamp. A signature date, a verification date, a proof-of-service date and a hearing date are all different things and none of them is the filing date.",
    "· If several documents disagree, prefer the one that is actually the filed complaint, and say so in _evidence.",
    "",
    body,
  ].join("\n");
}

// ── Parsing the answer ──────────────────────────────────────

function parseJson(text) {
  let raw = String(text || "").trim();
  // zara-core appends a note when an answer hits the length limit.
  raw = raw.replace(/\n*\(Cut off at the length limit[\s\S]*$/, "").trim();
  // Models sometimes wrap JSON in a fence even when told not to.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("Zara did not return JSON");
  const end = candidate.lastIndexOf("}");
  if (end > start) {
    const whole = candidate.slice(start, end + 1);
    try { return JSON.parse(whole); } catch (e) { /* fall through to repair */ }
    try { return JSON.parse(whole.replace(/,\s*([}\]])/g, "$1")); } catch (e) { /* repair below */ }
  }
  // Cut off mid-object (a long _evidence block on a many-defendant complaint
  // is what hits the limit). Close what is open; everything before the cut
  // is still good, and a field lost to the cut just stays blank.
  return JSON.parse(closeTruncated(candidate.slice(start)));
}

/** Close the strings, arrays and objects a truncated JSON text left open. */
function closeTruncated(s) {
  const stack = [];
  let inStr = false, esc = false, lastSafe = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
    if (!inStr && (ch === "," || ch === "{" || ch === "[")) lastSafe = i;
  }
  // Drop the half-written member after the last complete one.
  let body = s.slice(0, lastSafe + 1).replace(/[,\s]+$/, "");
  // Recount what is open at that point.
  const open = [];
  inStr = false; esc = false;
  for (const ch of body) {
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") open.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") open.pop();
  }
  return body + open.reverse().join("");
}

const NUMERIC = new Set(["amount_in_controversy", "hourly_rate", "contingency_pct", "retainer_amount"]);

/** Coerce and sanity-check. A value that fails its own type becomes null. */
function clean(kind, obj) {
  const allowed = new Set((kind === "retainer" ? FIELDS.retainer : FIELDS.pleading).map(r => r[0]));
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith("_") || !allowed.has(k)) continue;
    if (v === null || v === undefined || v === "") { out[k] = null; continue; }

    if (NUMERIC.has(k)) {
      const n = Number(String(v).replace(/[$,%\s,]/g, ""));
      out[k] = Number.isFinite(n) && n >= 0 ? n : null;
      continue;
    }
    if (k === "filed_date") {
      // Must be a real calendar date, and not in the future — a complaint
      // filed next March is a misread, not a filing.
      const d = new Date(v);
      const ok = !isNaN(d) && d.getTime() <= Date.now() + 86400000;
      out[k] = ok ? d.toISOString().slice(0, 10) : null;
      continue;
    }
    if (k === "plaintiffs" || k === "defendants") {
      out[k] = Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : null;
      continue;
    }
    if (k === "billing_type") {
      const t = String(v).toLowerCase().trim();
      out[k] = ["hourly", "contingency", "flat", "hybrid"].includes(t) ? t : null;
      continue;
    }
    out[k] = String(v).trim() || null;
  }
  return out;
}

/**
 * Read one or more documents into a proposal.
 *
 * files: [{ buffer, filename }]
 * Returns { ok, kind, fields, evidence, unread, warnings, attorney_must_enter }
 */
async function extractFromDocuments(files = [], opts = {}) {
  if (!files.length) throw new Error("No documents uploaded");
  if (files.length > MAX_DOCS) throw new Error(`Too many documents — ${MAX_DOCS} at a time`);

  const docs = [];
  const warnings = [];

  for (const f of files.slice(0, MAX_DOCS)) {
    let text = "";
    try {
      text = await textFromBuffer(f.buffer, f.filename);
    } catch (e) {
      warnings.push(`${f.filename}: ${e.message}`);
      continue;
    }
    if (!text.trim()) {
      // Almost always a scan without OCR. Say so plainly — silently
      // returning empty fields would look like the documents had nothing
      // in them, which is a different and much more confusing problem.
      warnings.push(`${f.filename}: no readable text — it looks like a scan. ` +
        `Run it through OCR, or enter this matter's details by hand.`);
      continue;
    }
    docs.push({ filename: f.filename, kind: guessKind(f.filename), text });
  }

  if (!docs.length) {
    return {
      ok: false, kind: null, fields: {}, evidence: {},
      unread: true, warnings,
      error: "Nothing readable in the upload.",
    };
  }

  const kind = opts.kind || (docs.every(d => d.kind === "retainer") ? "retainer" : "pleading");

  const prompt = buildPrompt(kind, docs);
  const ask = (message) => core.think({
    surface: "system",
    tier: "balanced",
    message,
    lessonScope: "intake",
    extra: "You are reading filed court papers or a fee agreement to pre-fill a new matter for an attorney to confirm. Accuracy beats completeness: a null you were honest about costs a few seconds of typing, a wrong value that looks plausible gets filed with the court. Your whole reply is one JSON object and nothing else.",
    // 1600 was too few for a complaint with many defendants plus a quote per
    // field: the answer was cut off mid-JSON and nothing could be read.
    maxTokens: 4000,
    // Every document, not just the first page of the first one.
    maxMessageChars: prompt.length + 100,
    timeout: 120000,
  });

  let out = await ask(prompt);
  let parsed;
  try {
    parsed = parseJson(out.text);
  } catch (e1) {
    console.warn("[civil-intake] unreadable answer (" + e1.message + "): " + String(out.text || "").slice(0, 300));
    // One retry, asking for the JSON alone and shorter quotes.
    try {
      out = await ask(prompt + "\n\nIMPORTANT: reply with the JSON object ONLY — no words before or after it. " +
        "Keep each _evidence quote under 60 characters.");
      parsed = parseJson(out.text);
    } catch (e2) {
      console.warn("[civil-intake] retry unreadable (" + e2.message + "): " + String(out && out.text || "").slice(0, 300));
      return {
        ok: false, kind, fields: {}, evidence: {}, unread: false,
        warnings: warnings.concat("Zara could not read these documents this time (" +
          (out && out.text ? "her answer was not in the expected format" : "no answer came back") +
          "). Try again, or upload the complaint on its own."),
        error: e2.message,
      };
    }
  }

  const fields = clean(kind, parsed);
  const evidence = (parsed && typeof parsed._evidence === "object" && parsed._evidence) || {};

  // A field with no quoted evidence is dropped. The model was told that a
  // value it cannot quote is a value it did not find; this enforces it
  // rather than trusting it.
  const unevidenced = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (!evidence[k]) { unevidenced.push(k); fields[k] = null; }
  }
  if (unevidenced.length) {
    warnings.push(`Dropped ${unevidenced.length} value(s) Zara could not point to in the text: ${unevidenced.join(", ")}.`);
  }

  return {
    ok: true,
    kind,
    documents: docs.map(d => ({ filename: d.filename, kind: d.kind, chars: d.text.length })),
    fields,
    evidence,
    unread: false,
    warnings,
    // Named explicitly so the form can mark them rather than leaving the
    // attorney to wonder whether Zara missed them or they are simply not
    // the kind of thing a document knows.
    attorney_must_enter: kind === "retainer"
      ? ["retainer_received_date", "lead_attorney", "case_manager"]
      : ["hourly_rate or fee arrangement", "retainer_received_date", "statute_of_limitations", "lead_attorney"],
    model: out.model,
  };
}

module.exports = {
  extractFromDocuments, textFromBuffer, guessKind, clean, parseJson, FIELDS,
};
