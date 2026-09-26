// eoir-parse.js — deterministic parser for EOIR eFiling / eROP notification email.
//
// These arrive from eRop@usdoj.gov and eFiling-DHSPortal@usdoj.gov on a fixed DOJ
// template: a short sentence, then an HTML list of "Label: value" pairs. Every
// message carries the respondent's FULL A-number and FULL name in labelled form.
//
// This is deliberately regex-only, with no LLM anywhere in the path. A regex on a
// fixed government template cannot invent a hearing date or transpose an A-number;
// an LLM can. For docketing, a parser that fails loudly on an unrecognised layout
// is safer than one that always produces a plausible-looking answer. Anything this
// file cannot parse is flagged for review rather than guessed at.
//
// Exports are db-free so the mail reader, the backfill and the tests share one
// implementation.

// Senders that use this template.
const EOIR_SENDERS = new Set(["erop@usdoj.gov", "efiling-dhsportal@usdoj.gov"]);

// Every label seen across the statuses. Order does not matter — each line is matched
// on its own — but the list must be complete or a field is silently lost, so unknown
// "Label: value" lines are collected in `unknownLabels` to catch template drift.
//
// Two labels mean the same thing: DOJ's Rejected template says "Noncitizen Name"
// where the Accepted/Entered/Service templates say "Alien Name". Both map to
// alien_name. Found by validating against real mail, not by reading a spec.
const LABEL_KEY = {
  "eFiled Document Name": "document_name",
  "Additional Document(s) Name": "additional_documents",
  "Document Category": "category",
  "Document Sub Category": "sub_category",
  "Notice Uploaded On": "uploaded_on",
  "Uploaded On": "uploaded_on",
  "Tracking Number": "tracking_number",
  "A-Number": "a_number",
  "Alien Name": "alien_name",
  "Noncitizen Name": "alien_name",
  "Charging Document Date": "charging_document_date",
  "Bond Requested Date": "bond_requested_date",
  "Case Type": "case_type",
  "Detained": "detained",
  "Other Information": "other_information",
  "Rejection Reasons": "rejection_reasons",
  "Rejection Explanation": "rejection_explanation",
};

const LABELS = Object.keys(LABEL_KEY);

// Labels whose value sits on the following line(s) rather than after the colon:
//   <p>Rejection Reasons: </p><ul><li>Duplicate Submission</li></ul>
const LOOKAHEAD_LABELS = new Set(["Rejection Reasons"]);

// status -> what actually happened, and whether a human needs to look.
//   Entered  = EOIR/the court put a document INTO the record. Has a PDF attached.
//              This is the only status that can carry a hearing date or an order.
//   Accepted = a document WE uploaded was approved into the record. A receipt.
//   Service  = DHS uploaded a document. Notice that the other side filed.
const STATUS_MEANING = {
  Entered: { kind: "court_document", docketable: true },
  Accepted: { kind: "filing_accepted", docketable: false },
  Service: { kind: "dhs_service", docketable: false },
  Rejected: { kind: "filing_rejected", docketable: true },
};

function isEoirSender(address) {
  return EOIR_SENDERS.has(String(address || "").trim().toLowerCase());
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&amp;/gi, "&"); // last, so &amp;lt; does not become <
}

// The template puts one field per <li>. Turn every block-ish tag into a newline so
// each field lands on its own line, then strip tags. Works on the HTML body and is
// harmless on the plain-text body (which uses "  *   Label: value").
function htmlToText(html) {
  return decodeEntities(
    String(html == null ? "" : html)
      .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
      .replace(/<\s*\/?\s*(br|li|p|div|ul|ol|tr|td|table|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

// "EOIR - FANG - 503 - Entered - Notices - RMV"
// Surname, last three digits of the A-number, status, document category, case type.
// The category is truncated to fit ("Change of Addre", "Entry of Appear"), so the
// body's Document Category is authoritative and this is only a cross-check.
function parseSubject(subject) {
  const parts = String(subject == null ? "" : subject)
    .split(/\s+-\s+/)
    .map((p) => p.trim());
  if (parts.length < 4 || !/^EOIR$/i.test(parts[0])) return null;
  const [, surname, a3, status, category, caseType] = parts;
  return {
    surname: surname || null,
    a_last3: /^\d{3}$/.test(a3 || "") ? a3 : null,
    status: status || null,
    subject_category: category || null,
    subject_case_type: caseType || null,
  };
}

// "ZHAO, ZHIWEN" -> { last: "ZHAO", first: "ZHIWEN", display: "ZHAO, ZHIWEN" }
// Some records carry only one token, or a middle name. Keep it simple: everything
// before the first comma is the surname, the rest is given names.
function parseAlienName(raw) {
  const s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (!s) return null;
  const i = s.indexOf(",");
  if (i === -1) return { last: s, first: "", display: s };
  const last = s.slice(0, i).trim();
  const first = s.slice(i + 1).trim();
  return { last, first, display: first ? `${last}, ${first}` : last };
}

// A-numbers appear as 208-817-329 in the body and as 208817329 in link URLs and
// attachment filenames. Normalise to the nine digits.
function aDigits(raw) {
  const d = String(raw == null ? "" : raw).replace(/\D/g, "");
  return d.length >= 8 && d.length <= 9 ? d : null;
}

function formatANumber(digits) {
  const d = aDigits(digits);
  if (!d) return null;
  const p = d.padStart(9, "0");
  return `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`;
}

// Attachments are named <timestamp>_<a-digits>.pdf, e.g. 2026092523270039_240996009.pdf
// It is a second, independent witness to the A-number, so a mismatch is worth
// knowing about rather than papering over.
function aNumberFromFilename(name) {
  const m = String(name == null ? "" : name).match(/(?:^|[^\d])(\d{9})\.pdf$/i);
  return m ? m[1] : null;
}

// Microsoft Graph calls it `name`; the `mailparser` the mail reader uses calls
// it `filename`. Reading only one of them makes the cross-check above look
// present while never actually firing, so take whichever is there.
function attachmentName(a) {
  if (!a) return "";
  return String(a.name || a.filename || "");
}

// The body links carry ?alien=208817329 — a third witness.
function aNumberFromBodyLinks(html) {
  const out = new Set();
  const re = /alien(?:=|-3D)(\d{8,9})/gi;
  let m;
  while ((m = re.exec(String(html == null ? "" : html)))) out.add(m[1]);
  return [...out];
}

const LABEL_LINE = /^\s*(?:[*•-]\s+)?([A-Za-z][A-Za-z0-9 ().\-/]{2,40}?)\s*:\s*(.*)$/;

function extractFields(text) {
  const fields = {};
  const unknownLabels = [];
  const lines = String(text).split("\n");

  for (let i = 0; i < lines.length; i++) {
    // "  *   Label: value" (plain text) or "Label: value" (from HTML)
    const m = lines[i].match(LABEL_LINE);
    if (!m) continue;
    const label = m[1].trim();
    let value = m[2].trim();
    const known = LABELS.find((l) => l.toLowerCase() === label.toLowerCase());
    if (!known) {
      if (value) unknownLabels.push(label);
      continue;
    }

    // "Rejection Reasons:" carries its values as list items on the next lines.
    if (!value && LOOKAHEAD_LABELS.has(known)) {
      const collected = [];
      for (let j = i + 1; j < lines.length && !LABEL_LINE.test(lines[j]); j++) {
        if (lines[j].trim()) collected.push(lines[j].trim());
      }
      value = collected.join("; ");
    }

    const key = LABEL_KEY[known];
    // First occurrence wins: the fields block precedes the boilerplate.
    if (fields[key] === undefined && value) fields[key] = value;
  }
  return { fields, unknownLabels };
}

// Everything before July 2024 arrived wrapped in Proofpoint Encryption: the body is
// a "click here to read your message" stub and the real content is inside an
// encrypted HTML attachment. The read-by links expired five days after delivery, so
// these bodies cannot be recovered from the mailbox. The SUBJECT line is not
// encrypted, which is what makes them partially salvageable.
function isSecureWrapper(text) {
  const s = String(text || "");
  return /this is a secure message/i.test(s) &&
    (/open the attachment/i.test(s) || /click here by/i.test(s));
}

/**
 * Parse one EOIR notification email.
 *
 * @param {object} msg
 * @param {string} msg.subject
 * @param {string} [msg.sender]        sender address
 * @param {string} [msg.html]          HTML body
 * @param {string} [msg.text]          plain-text body (often empty on these)
 * @param {Array}  [msg.attachments]   [{ name, size, contentType }]
 * @param {string} [msg.receivedAt]    ISO timestamp
 * @returns {object} parsed record. `ok` is true only when the fields a docket entry
 *          needs are present. `problems` lists what is missing or inconsistent.
 */
function parseEoirEmail(msg = {}) {
  const subject = msg.subject || "";
  const html = msg.html || "";
  const text = msg.text || "";
  const body = htmlToText(html || text);
  const { fields, unknownLabels } = extractFields(body);
  const subj = parseSubject(subject);
  const problems = [];

  const status = subj && subj.status ? subj.status : null;
  const meaning = STATUS_MEANING[status] || { kind: "unknown", docketable: true };

  // Proofpoint-encrypted: there is no body to read. Fall back to the subject line,
  // which still gives surname, the last three A-number digits, status and category —
  // enough for a filing-history row, and enough to join to a full A-number learned
  // from the unencrypted era. Returned separately so callers never mistake a
  // subject-only record for a parsed one.
  if (isSecureWrapper(body)) {
    return {
      ok: false,
      source: "subject",
      encrypted: true,
      problems: ["Proofpoint-encrypted body; the read-by link has expired"],
      a_number: null,
      a_digits: null,
      a_last3: subj ? subj.a_last3 : null,
      name_display: null,
      name_last: subj ? subj.surname : null,
      name_first: null,
      status,
      kind: meaning.kind,
      docketable: Boolean(meaning.docketable),
      category: subj ? subj.subject_category : null,
      sub_category: null,
      case_type: subj ? subj.subject_case_type : null,
      detained: null,
      document_name: null,
      tracking_number: null,
      uploaded_on: null,
      charging_document_date: null,
      other_information: null,
      rejection_reasons: null,
      rejection_explanation: null,
      received_at: msg.receivedAt || null,
      attachments: [],
    };
  }

  const name = parseAlienName(fields.alien_name);
  const bodyDigits = aDigits(fields.a_number);

  // Cross-check the A-number against the attachment filename and the body links.
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const witnesses = new Set();
  if (bodyDigits) witnesses.add(bodyDigits);
  for (const a of attachments) {
    const d = aNumberFromFilename(attachmentName(a));
    if (d) witnesses.add(d);
  }
  for (const d of aNumberFromBodyLinks(html)) witnesses.add(d);

  if (!bodyDigits) problems.push("no A-Number in body");
  if (witnesses.size > 1) {
    problems.push(`A-number disagreement: ${[...witnesses].join(", ")}`);
  }
  if (!name) problems.push("no Alien Name in body");
  if (!subj) problems.push("subject does not match the EOIR pattern");
  if (subj && subj.a_last3 && bodyDigits && !bodyDigits.endsWith(subj.a_last3)) {
    problems.push(`subject A-number suffix ${subj.a_last3} does not match ${bodyDigits}`);
  }
  if (subj && subj.surname && name && name.last &&
      name.last.toLowerCase() !== subj.surname.toLowerCase()) {
    problems.push(`subject surname ${subj.surname} does not match ${name.last}`);
  }
  if (status && !STATUS_MEANING[status]) problems.push(`unrecognised status "${status}"`);
  if (unknownLabels.length) problems.push(`unknown labels: ${unknownLabels.join(", ")}`);
  if (msg.sender && !isEoirSender(msg.sender)) problems.push(`unexpected sender ${msg.sender}`);

  // A record is usable for docketing when we can say WHO it concerns and WHAT it is.
  // The disagreement and drift warnings above do not by themselves make it unusable,
  // but they are carried through so the backfill can quarantine them.
  const ok = Boolean(bodyDigits && name && status && witnesses.size <= 1);

  return {
    ok,
    source: "body",
    encrypted: false,
    problems,
    // identity
    a_number: formatANumber(bodyDigits),
    a_digits: bodyDigits,
    a_last3: subj ? subj.a_last3 : null,
    name_display: name ? name.display : null,
    name_last: name ? name.last : null,
    name_first: name ? name.first : null,
    // classification
    status,
    kind: meaning.kind,
    docketable: Boolean(meaning.docketable),
    category: fields.category || null,
    sub_category: fields.sub_category || null,
    case_type: fields.case_type || (subj ? subj.subject_case_type : null) || null,
    detained: fields.detained ? /^y/i.test(fields.detained) : null,
    // provenance
    document_name: fields.document_name || null,
    tracking_number: fields.tracking_number || null,
    uploaded_on: fields.uploaded_on || null,
    charging_document_date: fields.charging_document_date || null,
    bond_requested_date: fields.bond_requested_date || null,
    other_information: fields.other_information || null,
    additional_documents: fields.additional_documents || null,
    rejection_reasons: fields.rejection_reasons || null,
    rejection_explanation: fields.rejection_explanation || null,
    received_at: msg.receivedAt || null,
    attachments: attachments.map((a) => ({
      name: attachmentName(a) || null,
      size: (a && a.size) || null,
      contentType: (a && a.contentType) || null,
    })),
  };
}

module.exports = {
  EOIR_SENDERS,
  LABELS,
  STATUS_MEANING,
  isEoirSender,
  isSecureWrapper,
  htmlToText,
  parseSubject,
  parseAlienName,
  aDigits,
  formatANumber,
  aNumberFromFilename,
  attachmentName,
  aNumberFromBodyLinks,
  parseEoirEmail,
};
