// ============================================================
//  case-autofill.js — the case file fills in the case record
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  "in civil and PI cases and all federal cases, make a function
//   where when case files are linked via dropbox, make a function
//   to read the files and fill in the information on that case
//   automatically. Second, able to upload documents and read to
//   fill out the info in that case."
//
//  Both halves are here. The Dropbox half reads the documents the
//  matter's folder already holds; the upload half reads documents
//  handed to it. They produce the same thing: a PROPOSAL.
//
//  Nothing is ever written to a matter by this file on its own.
//  A run produces a list of fields, each with the exact phrase
//  from the document that gave it and the file it came from, and
//  somebody ticks the ones that are right. That is the whole
//  design, and the reasons are:
//
//   · A case record is the thing the deadline chain is computed
//     from. A wrong filed date moves every CCP deadline under it,
//     and a wrong one that LOOKS right never gets questioned. A
//     blank field gets filled in; a plausible wrong one gets filed.
//
//   · This reads whatever is in the folder, and folders hold the
//     other side's papers too. A defendant's cross-complaint
//     names a different plaintiff than ours. Only a person
//     reading the quote can tell.
//
//  Four rules the code enforces rather than hopes for:
//
//   1. A field that already has a value is NEVER proposed. If the
//      documents disagree with what is on file, that goes in
//      `conflicts` — shown, never applied. Somebody edits the case
//      themselves, having seen both.
//   2. A value with no quote from the document is dropped, the
//      same way civil-intake-extract drops one. If it cannot be
//      pointed to, it was not found.
//   3. At Apply the field is re-checked. If it stopped being blank
//      since the run — somebody typed it in meanwhile — it is
//      skipped and reported, not overwritten.
//   4. Only a column in this file's own list for that matter kind
//      can be written, and the list is what builds the SQL. A
//      field name arriving from a form cannot reach a column that
//      is not on it.
//
//  Two fields are deliberately NOT on any list: the civil statute
//  of limitations and the PI SOL date. No document states them —
//  the firm computes them from the incident and the defendant, and
//  a machine-filled SOL that is wrong is the worst single field in
//  this system. They stay typed by hand, and renderMissing() says
//  so on the page rather than leaving a suspicious blank.
//
//  The record: for a civil matter an applied run is also written
//  to the case history. PI and federal matters have no history
//  table, so the run row IS the record — who ran it, who applied
//  it, which fields, and the phrase each one came from. It is kept
//  after the decision and never rewritten.
// ============================================================

const db = require("./db");
const extract = require("./civil-intake-extract");
const core = require("./zara-core");

const MAX_DOCS = 6;
const MAX_CHARS_PER_DOC = 18000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const EXPIRY_DAYS = 7;

// ═══════════════════════════════════════════════════════════
//  WHAT EACH KIND OF MATTER KEEPS
//  The field list is the allow-list: it is what the prompt asks
//  for, what the review page shows, and what builds the UPDATE.
//  A column not here cannot be written by this file at all.
//    [column, label, what to look for, type]
//  type: text | date | number | enum:a|b|c
// ═══════════════════════════════════════════════════════════

const CIVIL_FIELDS = [
  ["case_name", "Case name", "Caption as the court styles it, e.g. 'Smith v. Acme Corp.'", "text"],
  ["case_number", "Case number", "The docket number exactly as printed, punctuation and all", "text"],
  ["court", "Court", "Full court name as printed on the caption", "text"],
  ["county", "County", "County only, if a state court", "text"],
  ["case_type", "Case type", "The cause of action in a few words: breach of contract, unlawful detainer, motor vehicle negligence", "text"],
  ["our_role", "Our role", "Which side this firm is on: plaintiff, defendant, petitioner, respondent, cross-defendant", "text"],
  ["opposing_party", "Opposing party", "The party on the other side from our client", "text"],
  ["filed_date", "Filed date", "The court's FILE STAMP on the complaint. Not the signature date, not the verification date, not the proof of service date", "date"],
  ["service_date", "Service date", "Date the summons and complaint were served, from the proof of service", "date"],
  ["answered_date", "Answer date", "Date the answer or responsive pleading was filed", "date"],
  ["cmc_date", "CMC date", "Case management conference date, from the notice", "date"],
  ["trial_date", "Trial date", "Trial date, from a notice of trial setting or minute order", "date"],
  ["amount_in_controversy", "Amount in controversy", "Damages demanded, as a plain number, only if the pleading states a figure", "number"],
  ["billing_type", "Billing type", "From the fee agreement", "enum:hourly|contingency|flat|hybrid"],
  ["hourly_rate", "Hourly rate", "The attorney's hourly rate as a plain number, from the fee agreement", "number"],
  ["contingency_pct", "Contingency %", "Contingency percentage as a plain number, e.g. 33.33", "number"],
  ["retainer_amount", "Retainer amount", "Initial deposit required by the fee agreement, as a plain number", "number"],
];

const PI_FIELDS = [
  ["incident_date", "Incident date", "Date of the collision or injury", "date"],
  ["incident_type", "Incident type", "What kind of incident", "enum:auto|slip_fall|dog_bite|premises|product|med_mal|other"],
  ["incident_location", "Incident location", "Where it happened — intersection, address, premises", "text"],
  ["incident_description", "What happened", "Two or three sentences of how the incident occurred, from the report's narrative", "text"],
  ["police_report_number", "Police report #", "The report or incident number exactly as printed", "text"],
  ["police_agency", "Police agency", "The agency that wrote the report, e.g. 'CHP — Baldwin Park', 'West Covina PD'", "text"],
  ["client_dob", "Client date of birth", "Our client's date of birth", "date"],
  ["client_address", "Client address", "Our client's home address", "text"],
  ["client_phone", "Client phone", "Our client's telephone number", "text"],
  ["client_email", "Client email", "Our client's email address", "text"],
  ["injuries_description", "Injuries", "The injuries described in the medical records or report", "text"],
  ["severity", "Severity", "How serious the injuries are", "enum:minor|moderate|severe|catastrophic"],
  ["case_number", "Case number", "If a lawsuit was filed, the docket number as printed", "text"],
  ["case_filed_date", "Case filed date", "The court's file stamp, if a complaint was filed", "date"],
];

const FEDERAL_FIELDS = [
  ["matter_number", "Matter / case number", "The USPTO serial number or the court's case number, exactly as printed", "text"],
  ["agency", "Agency or court", "USPTO, TTAB, the District Court and district, the Circuit", "text"],
  ["opposing_party", "Opposing party", "The respondent, defendant or opposer", "text"],
  ["cause_of_action", "Cause of action", "What is pleaded: § 2241 habeas, mandamus / APA, § 1983, Lanham Act", "text"],
  ["filing_date", "Filing date", "The court's or the agency's file stamp", "date"],
  ["a_number", "A-number", "The alien registration number, if this is an immigration-related federal matter", "text"],
  ["tm_mark", "Mark", "The trademark itself, as applied for", "text"],
  ["tm_class", "Class(es)", "International class numbers, e.g. '9, 42'", "text"],
  ["tm_owner", "Owner of the mark", "The applicant or registrant, which may not be our client", "text"],
];

// Changing one of these regenerates the deadline chain under it, so the
// review page marks them rather than letting them slip past in a list of
// fifteen ticked boxes.
const DRIVES_DEADLINES = new Set([
  "filed_date", "service_date", "answered_date", "trial_date", "cmc_date",
  "incident_date", "case_filed_date", "filing_date",
]);

// Never read off a document. See the header.
const NEVER_PROPOSED = {
  civil: [["statute_of_limitations", "Statute of limitations",
    "The firm computes this from the cause of action and the defendant. No pleading states it."]],
  pi: [["sol_date", "SOL date",
    "Computed from the incident date, and tolled or shortened by a government defendant or a minor plaintiff. Nothing in a police report knows that."],
    ["gov_claim_required", "Government claim required",
      "A judgment about the defendant, not a fact printed anywhere."]],
  federal: [],
};

const MATTERS = {
  civil: {
    key: "civil",
    label: "Civil matter",
    table: "civil_cases",
    nameCol: "case_name",
    folderCol: "dropbox_path",
    fields: CIVIL_FIELDS,
    href: (id) => `/admin/civil/case/${id}`,
    docKinds: "a complaint, summons, answer, proof of service, case management notice or fee agreement",
  },
  pi: {
    key: "pi",
    label: "Personal injury case",
    table: "pi_cases",
    nameCol: "client_name",
    folderCol: "dropbox_folder_path",
    fields: PI_FIELDS,
    href: (id) => `/admin/pi/case/${id}`,
    docKinds: "a traffic collision or police report, an intake sheet, medical records, or a complaint",
  },
  federal: {
    key: "federal",
    label: "Federal matter",
    table: "federal_matters",
    nameCol: "client_name",
    folderCol: "dropbox_folder_path",
    fields: FEDERAL_FIELDS,
    href: (id) => `/admin/federal/${id}`,
    docKinds: "a petition, complaint, trademark application, office action or agency notice",
  },
};

const KINDS = Object.keys(MATTERS);

function matterKind(kind) {
  const m = MATTERS[String(kind || "").toLowerCase()];
  if (!m) throw new Error(`Not a kind of matter this reads: ${kind}`);
  return m;
}

/** The allow-list, as a map. Nothing outside it is ever written. */
function fieldMap(kind) {
  const out = new Map();
  for (const f of matterKind(kind).fields) out.set(f[0], { column: f[0], label: f[1], hint: f[2], type: f[3] });
  return out;
}

// ═══════════════════════════════════════════════════════════
//  THE RUN RECORD
// ═══════════════════════════════════════════════════════════

let ready = null;
function initTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS case_autofill_runs (
        id           SERIAL PRIMARY KEY,
        kind         TEXT NOT NULL,
        case_id      INTEGER NOT NULL,
        source       TEXT NOT NULL,
        documents    JSONB DEFAULT '[]'::jsonb,
        proposals    JSONB DEFAULT '[]'::jsonb,
        conflicts    JSONB DEFAULT '[]'::jsonb,
        warnings     JSONB DEFAULT '[]'::jsonb,
        status       TEXT DEFAULT 'pending',
        run_by       TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        decided_by   TEXT,
        decided_at   TIMESTAMPTZ,
        applied      JSONB,
        model        TEXT,
        error        TEXT
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_autofill_case
                    ON case_autofill_runs (kind, case_id, created_at DESC)`).catch(() => {});
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ═══════════════════════════════════════════════════════════
//  READING THE MATTER
// ═══════════════════════════════════════════════════════════

async function loadMatter(kind, caseId) {
  const m = matterKind(kind);
  const id = parseInt(caseId, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Which matter?");
  const r = await db.query(`SELECT * FROM ${m.table} WHERE id = $1`, [id]);
  if (!r.rows.length) throw new Error(`No ${m.label.toLowerCase()} #${id}`);
  return r.rows[0];
}

/** Blank means null, empty, or a string of spaces. A zero is a value. */
function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** What the record already holds, in the same shape the proposal uses. */
function currentValue(row, column, type) {
  const v = row[column];
  if (isBlank(v)) return null;
  if (type === "date") return day(v);
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return String(v).trim();
}

function day(v) {
  if (v === null || v === undefined || v === "") return null;
  const t = new Date(v);
  return isNaN(t) ? null : t.toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════
//  CHOOSING WHICH FILES TO READ
//  A matter folder holds a hundred files and the model reads six.
//  Which six decides whether this works at all, so it is a ranked
//  list by what a document of that name actually tells you — not
//  the six most recent, which on an active matter are discovery
//  responses that say nothing about the caption.
// ═══════════════════════════════════════════════════════════

const READABLE = /\.(pdf|docx|txt|md|csv|xlsx|xls)$/i;

const RANKS = [
  [1, /\b(complaint|petition)\b/i],
  [1, /cross[- ]?complaint/i],
  [2, /\b(police|traffic|collision|incident)\s*report\b/i, "pi"],
  [2, /\b(chp|crash)\b/i, "pi"],
  [3, /\bsummons\b/i],
  [3, /civil\s*case\s*cover/i],
  [4, /\b(retainer|engagement|fee\s*agreement|representation\s*agreement)\b/i],
  [5, /notice\s*of\s*(trial|case\s*management|hearing)/i],
  [5, /\bcase\s*management\b/i],
  [6, /\banswer\b/i],
  [6, /proof\s*of\s*service/i],
  [7, /\b(intake|client\s*information)\b/i],
  [8, /office\s*action/i, "federal"],
  [8, /\b(application|trademark)\b/i, "federal"],
];

/**
 * Rank one filename. Lower is better; null means "not worth a read".
 * The folder it sits in counts too: a file called "Scan 004.pdf" in
 * Pleadings is worth more than the same name in Correspondence.
 */
function rankFile(name, folder = "", kind = "civil") {
  const n = String(name || "");
  if (!READABLE.test(n)) return null;
  for (const [rank, pattern, onlyKind] of RANKS) {
    if (onlyKind && onlyKind !== kind) continue;
    if (pattern.test(n)) return rank;
  }
  if (/pleading/i.test(folder)) return 9;
  if (/billing|trust/i.test(folder)) return 10;
  return null;      // not promising enough to spend one of six reads on
}

/** The files this matter's folder holds, best first. */
async function candidateFiles(kind, caseId, { limit = MAX_DOCS } = {}) {
  const m = matterKind(kind);
  const row = await loadMatter(kind, caseId);
  const folder = row[m.folderCol];
  if (!folder) {
    return { folder: null, files: [], note: `This ${m.label.toLowerCase()} has no Dropbox folder linked yet. Link one, or upload the documents here instead.` };
  }

  let entries = [];
  if (kind === "civil") {
    // The mirror already knows this folder — no Dropbox call needed.
    const rows = await require("./civil-dropbox").listCaseFiles(caseId);
    entries = rows.map((f) => ({
      name: f.name, path: f.path_display, folder: f.relative_folder || "",
      size: Number(f.size_bytes || 0), modified: f.server_modified,
    }));
  } else {
    // PI and federal matters keep no file mirror, so this lists the folder.
    const dbx = require("./dropbox-integration");
    const deep = await dbx.listFolderDeep(folder, { limit: 2000 });
    if (deep === null) {
      // listFolderDeep returns null for not_found. The matter points at a
      // folder Dropbox does not have — moved or renamed — which is a
      // different problem from an empty one and should not read as one.
      return {
        folder, files: [], considered: 0,
        note: `Dropbox has no folder at ${folder}. It has probably been moved or renamed; relink it on the matter, or upload the documents here instead.`,
      };
    }
    const list = Array.isArray(deep) ? deep : (deep && deep.entries) || [];
    entries = list
      .filter((e) => (e[".tag"] || e.tag) === "file" || e.is_file || e.size != null)
      .map((e) => ({
        name: e.name,
        path: e.path_display || e.path_lower,
        folder: String(e.path_display || "").slice(folder.length).replace(/\/[^/]*$/, "").replace(/^\//, ""),
        size: Number(e.size || 0),
        modified: e.server_modified || e.client_modified || null,
      }));
  }

  const ranked = entries
    .map((f) => ({ ...f, rank: rankFile(f.name, f.folder, kind) }))
    .filter((f) => f.rank !== null && f.size > 0 && f.size <= MAX_FILE_BYTES)
    .sort((a, b) => a.rank - b.rank ||
      new Date(b.modified || 0) - new Date(a.modified || 0));

  return {
    folder,
    files: ranked.slice(0, limit),
    considered: entries.length,
    note: ranked.length ? null
      : `${entries.length} file${entries.length === 1 ? "" : "s"} in the folder, none of them ${m.docKinds}. Upload the document here instead.`,
  };
}

// ═══════════════════════════════════════════════════════════
//  READING THEM
// ═══════════════════════════════════════════════════════════

function buildPrompt(m, wanted, row, docs) {
  const schema = wanted
    .map((f) => `  "${f.column}": <${f.hint}, or null>`)
    .join(",\n");

  // What the record already says about who this matter is. Not fields to
  // fill — context, so the model can tell our client's complaint from the
  // cross-complaint filed against them, which is in the same folder.
  const known = [
    row.client_name ? `Our client: ${row.client_name}` : null,
    row.case_name ? `Matter: ${row.case_name}` : null,
    row.client_key ? `Client key: ${row.client_key}` : null,
  ].filter(Boolean).join("\n");

  const body = docs.map((d, i) =>
    `--- DOCUMENT ${i + 1}: ${d.filename} ---\n${d.text.slice(0, MAX_CHARS_PER_DOC)}`
  ).join("\n\n");

  return [
    `Read these documents from a ${m.label.toLowerCase()}'s file and extract the matter's details.`,
    known ? `\nWhat the firm's record already says:\n${known}\n` : "",
    "Return ONLY a JSON object, no prose before or after, in exactly this shape:",
    "{",
    schema + ",",
    '  "_evidence": { "<field name>": "<the exact phrase from the document that gave you this value, under 120 characters>" },',
    '  "_source": { "<field name>": "<the filename it came from>" }',
    "}",
    "",
    "RULES — these matter more than filling the object in:",
    "· A field you cannot find in the text is null. Never infer, never guess, never supply a typical value. A blank field gets filled in by the attorney; a wrong one that looks right gets filed.",
    "· Every non-null field must have an entry in _evidence quoting the document, and one in _source naming the file. If you cannot quote it, you did not find it — return null.",
    "· Copy numbers, names and dates EXACTLY as printed, including punctuation and party suffixes. Do not normalise 'Acme Corp.' to 'Acme Corporation'.",
    "· A filing date is the court's file stamp. A signature date, a verification date, a proof-of-service date and a hearing date are four different things and none of them is the filing date.",
    "· This folder may hold the OTHER SIDE's papers. If a document is adverse to the client named above — a cross-complaint against them, a demand on them — read it as the other side's, and say so in the quote.",
    "· If two documents disagree, prefer the filed original over a copy or a letter about it, and make the quote say which document you took it from.",
    "",
    body,
  ].join("\n");
}

const TYPE_ENUM = (t) => (t.startsWith("enum:") ? t.slice(5).split("|") : null);

/** Coerce one value to its field's type. Anything that fails becomes null. */
function coerce(type, v) {
  if (v === null || v === undefined || v === "") return null;
  if (type === "number") {
    const n = Number(String(v).replace(/[$,%\s]/g, ""));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (type === "date") {
    const d = new Date(v);
    // A matter filed next March is a misread, not a filing. Future dates are
    // real for a trial or a CMC, so only the past-only ones are capped; the
    // caller marks which by passing the column in.
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const en = TYPE_ENUM(type);
  if (en) {
    const t = String(v).toLowerCase().trim().replace(/\s+/g, "_");
    return en.includes(t) ? t : null;
  }
  const s = String(v).trim();
  return s || null;
}

const PAST_ONLY = new Set(["filed_date", "service_date", "answered_date",
  "incident_date", "case_filed_date", "filing_date", "client_dob"]);

/**
 * Read documents into a proposal for one matter.
 *
 * files: [{ buffer, filename }]
 * Returns the run row, already saved: proposals, conflicts, warnings.
 */
async function readDocuments(kind, caseId, files = [], { source = "upload", by = null } = {}) {
  await initTables();
  const m = matterKind(kind);
  const row = await loadMatter(kind, caseId);
  if (!files.length) throw new Error("No documents to read.");

  const docs = [];
  const warnings = [];
  for (const f of files.slice(0, MAX_DOCS)) {
    let text = "";
    try {
      text = await extract.textFromBuffer(f.buffer, f.filename);
    } catch (e) {
      warnings.push(`${f.filename}: ${e.message}`);
      continue;
    }
    if (!text.trim()) {
      // Almost always a scan with no text layer. Saying so plainly matters:
      // silently returning nothing looks like the document was empty, which
      // is a different and much more confusing problem.
      warnings.push(`${f.filename}: no readable text — it looks like a scan. Run it through OCR, or type this one in by hand.`);
      continue;
    }
    docs.push({ filename: f.filename, text, chars: text.length });
  }

  if (!docs.length) {
    return save(kind, row.id, source, [], [], [], warnings, by, null,
      "Nothing readable in these documents.");
  }

  // Ask about every field — including the ones already filled in, because a
  // document that disagrees with the record is worth knowing about even
  // though it will never be applied automatically.
  const wanted = m.fields.map((f) => ({ column: f[0], label: f[1], hint: f[2], type: f[3] }));
  const prompt = buildPrompt(m, wanted, row, docs);

  const ask = (message) => core.think({
    surface: "system",
    tier: "balanced",
    message,
    lessonScope: "intake",
    extra: "You are reading a matter's own file to pre-fill its record for an attorney to confirm. " +
      "Accuracy beats completeness: a null you were honest about costs a few seconds of typing; a wrong value that looks plausible is filed with the court and recomputes every deadline under it. " +
      "Your whole reply is one JSON object and nothing else.",
    maxTokens: 4000,
    maxMessageChars: prompt.length + 100,
    timeout: 120000,
  });

  let out, parsed;
  try {
    out = await ask(prompt);
    parsed = extract.parseJson(out.text);
  } catch (e1) {
    try {
      out = await ask(prompt + "\n\nIMPORTANT: reply with the JSON object ONLY — no words before or after it. Keep each _evidence quote under 60 characters.");
      parsed = extract.parseJson(out.text);
    } catch (e2) {
      return save(kind, row.id, source, docs.map(d => ({ filename: d.filename, chars: d.chars })),
        [], [], warnings.concat(
          "Zara could not read these documents this time. Try again, or upload the complaint on its own."),
        by, out && out.model, e2.message);
    }
  }

  const evidence = (parsed && typeof parsed._evidence === "object" && parsed._evidence) || {};
  const sourceOf = (parsed && typeof parsed._source === "object" && parsed._source) || {};

  const proposals = [];
  const conflicts = [];
  let unevidenced = 0;

  for (const f of wanted) {
    const value = coerce(f.type, parsed ? parsed[f.column] : null);
    if (value === null) continue;

    // No quote, no value. The model was told this; this enforces it rather
    // than trusting it.
    const quote = String(evidence[f.column] || "").trim();
    if (!quote) { unevidenced++; continue; }

    if (PAST_ONLY.has(f.column) && new Date(value).getTime() > Date.now() + 86400000) {
      warnings.push(`${f.label}: read as ${value}, which is in the future. Dropped — that is a misread, not a date.`);
      continue;
    }

    const item = {
      field: f.column,
      label: f.label,
      value,
      quote: quote.slice(0, 200),
      source: String(sourceOf[f.column] || docs[0].filename).slice(0, 160),
      drives_deadlines: DRIVES_DEADLINES.has(f.column),
    };

    const current = currentValue(row, f.column, f.type);
    if (current === null) {
      proposals.push(item);                       // blank: this is a fill
    } else if (String(current) !== String(value)) {
      conflicts.push({ ...item, current });       // filled, and they differ
    }
    // filled and the same: nothing to say.
  }

  if (unevidenced) {
    warnings.push(`${unevidenced} value${unevidenced === 1 ? " was" : "s were"} dropped because Zara could not point to ${unevidenced === 1 ? "it" : "them"} in the text.`);
  }

  return save(kind, row.id, source,
    docs.map((d) => ({ filename: d.filename, chars: d.chars })),
    proposals, conflicts, warnings, by, out && out.model, null);
}

/** Read the matter's own Dropbox folder. The other half of the request. */
async function readFromDropbox(kind, caseId, { by = null } = {}) {
  const m = matterKind(kind);
  const picked = await candidateFiles(kind, caseId);
  if (!picked.files.length) throw new Error(picked.note || "Nothing in the folder worth reading.");

  const dbx = require("./dropbox-integration");
  const files = [];
  const warnings = [];
  for (const f of picked.files) {
    try {
      const buffer = await dbx.downloadFile(f.path);
      files.push({ buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), filename: f.name });
    } catch (e) {
      warnings.push(`${f.name}: could not be downloaded from Dropbox (${e.message})`);
    }
  }
  if (!files.length) {
    throw new Error("None of the matter's files could be downloaded from Dropbox. " +
      (warnings[0] || "") + " Check the Dropbox connection, or upload the document here instead.");
  }

  const run = await readDocuments(kind, caseId, files, { source: "dropbox", by });
  if (warnings.length) {
    const merged = (run.warnings || []).concat(warnings);
    await db.query(`UPDATE case_autofill_runs SET warnings = $2::jsonb WHERE id = $1`,
      [run.id, JSON.stringify(merged)]).catch(() => {});
    run.warnings = merged;
  }
  run.folder = picked.folder;
  void m;
  return run;
}

async function save(kind, caseId, source, documents, proposals, conflicts, warnings, by, model, error) {
  await initTables();
  const r = await db.query(
    `INSERT INTO case_autofill_runs
       (kind, case_id, source, documents, proposals, conflicts, warnings, run_by, model, error, status)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11)
     RETURNING *`,
    [kind, caseId, source,
     JSON.stringify(documents || []), JSON.stringify(proposals || []),
     JSON.stringify(conflicts || []), JSON.stringify(warnings || []),
     by, model || null, error || null,
     (proposals || []).length ? "pending" : "empty"]
  );
  return r.rows[0];
}

// ═══════════════════════════════════════════════════════════
//  DECIDING
// ═══════════════════════════════════════════════════════════

async function getRun(id) {
  await initTables();
  const r = await db.query(`SELECT * FROM case_autofill_runs WHERE id = $1`, [parseInt(id, 10)]);
  if (!r.rows.length) throw new Error("That read is not on file.");
  return r.rows[0];
}

async function runsFor(kind, caseId, limit = 10) {
  await initTables();
  const r = await db.query(
    `SELECT id, source, status, run_by, created_at, decided_by, decided_at,
            jsonb_array_length(proposals) AS proposed, applied, error
       FROM case_autofill_runs
      WHERE kind = $1 AND case_id = $2
      ORDER BY id DESC LIMIT $3`,
    [kind, parseInt(caseId, 10), limit]
  );
  return r.rows;
}

/**
 * Write the ticked fields, and only those.
 *
 * chosen: the field names the person ticked.
 * Every one of them must be in this run's own proposals AND in the
 * kind's field list — the first stops a field being added to the form,
 * the second is what builds the SQL, so a column outside the list can
 * never be reached. A field that stopped being blank since the run is
 * skipped and reported.
 */
async function applyRun(runId, chosen = [], { by = null } = {}) {
  const run = await getRun(runId);
  if (run.status === "applied") throw new Error("This read has already been applied.");
  if (run.status !== "pending") throw new Error(`This read was ${run.status}; run it again to work from the file as it is now.`);
  if (Date.now() - new Date(run.created_at).getTime() > EXPIRY_DAYS * 86400000) {
    await db.query(`UPDATE case_autofill_runs SET status = 'expired' WHERE id = $1`, [run.id]);
    throw new Error("This read is more than a week old. Run it again so it reflects the file as it is now.");
  }

  const m = matterKind(run.kind);
  const allowed = fieldMap(run.kind);
  const proposed = new Map((run.proposals || []).map((p) => [p.field, p]));
  const want = [...new Set((chosen || []).map(String))];
  if (!want.length) throw new Error("Nothing was ticked, so nothing was written.");

  // Claim it, so a double-click cannot write the same fields twice.
  const claim = await db.query(
    `UPDATE case_autofill_runs SET status = 'applying' WHERE id = $1 AND status = 'pending' RETURNING id`,
    [run.id]);
  if (!claim.rows.length) throw new Error("This read is already being applied.");

  try {
    const row = await loadMatter(run.kind, run.case_id);
    const write = [];
    const skipped = [];
    const refused = [];

    for (const field of want) {
      const spec = allowed.get(field);
      const prop = proposed.get(field);
      if (!spec || !prop) { refused.push(field); continue; }
      // Rule 3: it has to still be blank. Somebody typing it in while this
      // sat on screen wins — their value is a person's, this one is a read.
      if (currentValue(row, field, spec.type) !== null) {
        skipped.push(`${spec.label} (filled in since: ${currentValue(row, field, spec.type)})`);
        continue;
      }
      write.push({ field, label: spec.label, value: prop.value, quote: prop.quote, source: prop.source });
    }

    if (!write.length) {
      await db.query(`UPDATE case_autofill_runs SET status = 'pending' WHERE id = $1`, [run.id]);
      throw new Error(skipped.length
        ? `Nothing was written — every field was filled in since this read: ${skipped.join("; ")}`
        : "Nothing was written — none of those fields came from this read.");
    }

    // The column names come from the allow-list, never from the form.
    const sets = write.map((w, i) => `${w.field} = $${i + 2}`);
    const vals = write.map((w) => w.value);
    const hasUpdatedAt = ["civil_cases", "federal_matters", "pi_cases"].includes(m.table);
    await db.query(
      `UPDATE ${m.table} SET ${sets.join(", ")}${hasUpdatedAt ? ", updated_at = NOW()" : ""} WHERE id = $1`,
      [row.id, ...vals]
    );

    const applied = { fields: write, skipped, refused };
    await db.query(
      `UPDATE case_autofill_runs
          SET status = 'applied', decided_by = $2, decided_at = NOW(), applied = $3::jsonb
        WHERE id = $1`,
      [run.id, by, JSON.stringify(applied)]);

    // A civil matter has a history; PI and federal do not, and for those the
    // run row above is the record.
    if (run.kind === "civil") {
      await require("./civil-litigation").logEvent(run.case_id, {
        event_kind: "note",
        event_date: day(new Date()),
        title: `Case details read from the file (${write.length} field${write.length === 1 ? "" : "s"})`,
        description: write.map((w) => `${w.label}: ${w.value}\n    from ${w.source} — "${w.quote}"`).join("\n") +
          (skipped.length ? `\nNot written — filled in since the read: ${skipped.join("; ")}` : "") +
          `\nRead by ${run.run_by || "unknown"}, approved by ${by || "unknown"}.`,
        created_by: by,
      }).catch(() => { /* the write itself stands */ });
    }

    return { ok: true, applied: write, skipped, refused, run_id: run.id };
  } catch (e) {
    // Back to pending unless it was already settled: a failure here is
    // usually the database, and Apply should be pressable again.
    await db.query(
      `UPDATE case_autofill_runs SET status = 'pending', error = $2 WHERE id = $1 AND status = 'applying'`,
      [run.id, e.message]).catch(() => {});
    throw e;
  }
}

async function discardRun(runId, { by = null } = {}) {
  const run = await getRun(runId);
  if (run.status !== "pending") throw new Error(`This read was already ${run.status}.`);
  await db.query(
    `UPDATE case_autofill_runs SET status = 'discarded', decided_by = $2, decided_at = NOW() WHERE id = $1`,
    [run.id, by]);
  return { ok: true };
}

/** The fields this never reads, and why — so the page can say it. */
function neverProposed(kind) {
  return (NEVER_PROPOSED[String(kind || "").toLowerCase()] || [])
    .map(([field, label, why]) => ({ field, label, why }));
}

module.exports = {
  MATTERS, KINDS, MAX_DOCS, EXPIRY_DAYS,
  CIVIL_FIELDS, PI_FIELDS, FEDERAL_FIELDS, DRIVES_DEADLINES,
  initTables, matterKind, fieldMap, neverProposed,
  isBlank, currentValue, coerce, rankFile, candidateFiles,
  loadMatter, readDocuments, readFromDropbox,
  getRun, runsFor, applyRun, discardRun,
};
