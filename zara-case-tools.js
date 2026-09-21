// ============================================================
//  zara-case-tools.js — Zara's hands on a civil matter
// ------------------------------------------------------------
//  JJ: "can we give zara the tool to update the file, upload
//  documents and analyze the file and update the case folder?"
//
//  READ tools run immediately:
//    list_case_documents  — what is in the matter's Dropbox folder
//    read_case_document   — the text of one of those documents
//
//  WRITE tools never write. Each one records a PROPOSAL and the chat
//  shows it as a card with Apply / Discard. Nothing touches the matter
//  until a person presses Apply (zara-actions.applyProposal):
//    propose_matter_update — change case details (dates, court, number…)
//    propose_case_entry    — add a note, a deadline or a hearing
//    propose_memo          — save a Word memo into the Dropbox folder
//
//  Documents the user attaches in the chat are filed into the case
//  folder by the attach route itself (the user's own action), and their
//  text is handed to Zara with the next message.
// ============================================================

const actions = require("./zara-actions");

const MAX_DOC_CHARS = 40000;

const CASE_TOOLS = [
  {
    name: "list_case_documents",
    description: "List the documents in a civil matter's Dropbox case folder (name, category/subfolder, date, file id). Use before read_case_document, or when asked what is in the file.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        category: { type: "string", description: "Optional subfolder key to narrow the list, e.g. pleadings, discovery, correspondence, billing." },
      },
      required: ["case_id"],
    },
  },
  {
    name: "read_case_document",
    description: "Read the text of one document in a civil matter's Dropbox folder (PDF, DOCX or TXT). Use to analyze a complaint, answer, motion, order, letter or contract. Scanned PDFs without OCR have no text.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        file_id: { type: "number", description: "The id from list_case_documents." },
      },
      required: ["case_id", "file_id"],
    },
  },
  {
    name: "propose_matter_update",
    description: "Propose changes to a civil matter's details. Does NOT save: the user sees a card and presses Apply. Editable fields: " +
      Object.keys(actions.EDITABLE).join(", ") + ". Dates as YYYY-MM-DD. Only include fields that should change.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        changes: { type: "object", description: "field → new value, e.g. {\"service_date\": \"2026-09-02\", \"court\": \"C.D. Cal.\"}" },
        reason: { type: "string", description: "One line: where this comes from (e.g. 'Proof of service filed 9/4')." },
      },
      required: ["case_id", "changes"],
    },
  },
  {
    name: "propose_case_entry",
    description: "Propose adding a note, a deadline or a hearing to a civil matter. Does NOT save: the user presses Apply on a card. Call once per entry.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        type: { type: "string", enum: ["note", "deadline", "hearing"] },
        date: { type: "string", description: "YYYY-MM-DD. Due date for a deadline, hearing date for a hearing, event date for a note (default today)." },
        title: { type: "string", description: "Note title, or short label." },
        description: { type: "string", description: "Note body, deadline description, or hearing purpose." },
        time: { type: "string", description: "Hearing time, e.g. 8:30 AM." },
        hearing_type: { type: "string", description: "e.g. CMC, Motion hearing, Trial setting conference, OSC." },
        department: { type: "string" },
        judge: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        rule: { type: "string", description: "Rule the deadline comes from, e.g. CCP § 412.20(a)(3), FRCP 12(a)(1)(A)(i)." },
        reason: { type: "string" },
      },
      required: ["case_id", "type"],
    },
  },
  {
    name: "propose_memo",
    description: "Propose saving a memo (a Word document) into the matter's Dropbox folder — case analysis, strategy memo, summary of a document. Does NOT save until the user presses Apply. Write the full memo in content; use blank lines between paragraphs and lines starting with '# ' for headings.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        title: { type: "string", description: "Becomes the file name, e.g. 'Memo - Motion to Dismiss Analysis 2026-09-20'." },
        content: { type: "string" },
        category: { type: "string", description: "Optional subfolder key, e.g. research, pleadings, correspondence. Default: sorted automatically." },
        reason: { type: "string" },
      },
      required: ["case_id", "title", "content"],
    },
  },
];

const NAMES = new Set(CASE_TOOLS.map(t => t.name));

async function readDocument(caseId, fileId) {
  const db = require("./db");
  const r = await db.query(
    `SELECT id, case_id, name, path_display, category FROM civil_case_files WHERE id = $1 AND removed_at IS NULL`, [fileId]);
  const f = r.rows[0];
  if (!f) return { error: `No document #${fileId} in the case files.` };
  // The model picks both ids; do not let it read another matter's file by mistake.
  if (Number(f.case_id) !== Number(caseId)) return { error: `Document #${fileId} belongs to a different matter.` };
  const link = await require("./civil-dropbox").fileLink(f.id);
  const resp = await require("axios").get(link, { responseType: "arraybuffer", timeout: 60000, maxContentLength: 60 * 1024 * 1024 });
  let text;
  try { text = await require("./civil-intake-extract").textFromBuffer(Buffer.from(resp.data), f.name); }
  catch (e) { return { error: e.message, name: f.name }; }
  text = String(text || "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return { name: f.name, error: "No text in this document — probably a scan without OCR." };
  return {
    name: f.name, category: f.category, chars: text.length,
    truncated: text.length > MAX_DOC_CHARS,
    text: text.slice(0, MAX_DOC_CHARS),
  };
}

/**
 * Run one case tool. `sink` collects proposal cards for the chat response.
 * Returns what Zara sees as the tool result.
 */
async function run(name, args, { user = null, sink = null } = {}) {
  const by = (user && (user.u || user.n)) || null;
  args = args || {};
  const caseId = Number(args.case_id);
  if (!caseId) return { error: "case_id is required — use find_civil_matter to get it." };
  try {
    if (name === "list_case_documents") {
      const rows = await require("./civil-dropbox").listCaseFiles(caseId, { category: args.category || null });
      return {
        count: rows.length,
        documents: rows.slice(0, 200).map(d => ({
          file_id: d.id, name: d.name, category: d.category, folder: d.relative_folder,
          modified: d.server_modified ? String(d.server_modified).slice(0, 10) : null,
        })),
        note: rows.length ? undefined : "No documents are mirrored for this matter. The Dropbox folder may be empty or not linked yet.",
      };
    }
    if (name === "read_case_document") return await readDocument(caseId, Number(args.file_id));

    let out;
    if (name === "propose_matter_update") {
      out = await actions.proposeMatterUpdate(caseId, args.changes, { reason: args.reason, by });
    } else if (name === "propose_case_entry") {
      out = await actions.proposeEntry(caseId, args, { reason: args.reason, by });
    } else if (name === "propose_memo") {
      out = await actions.proposeMemo(caseId, { title: args.title, content: args.content, category: args.category, reason: args.reason, by });
    } else {
      return { error: "Unknown tool " + name };
    }
    const c = actions.card(out.proposal);
    if (sink) sink.push(c);
    return {
      proposed: true, proposal_id: c.id, summary: c.summary, lines: c.lines,
      not_applied: out.rejected && out.rejected.length ? out.rejected : undefined,
      status: "NOT SAVED YET. The user sees this as a card with an Apply button. Tell them to review and press Apply; do not say it is done.",
    };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { CASE_TOOLS, NAMES, run, readDocument, MAX_DOC_CHARS };
