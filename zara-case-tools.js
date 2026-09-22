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
  {
    name: "reconstruct_time",
    description: "Rebuild the attorney's billable time on a civil matter from its Dropbox case folder, its hearings and the firm's connected email, and propose it as ONE card of time entries. Use when asked to 'run my emails and Dropbox', 'reconstruct / catch up / enter the billable hours', or 'bill this case'. It runs in the background (2-4 minutes) and does NOT save: JJ is told on Telegram when the card is ready, and then show_time_proposal displays it.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        from: { type: "string", description: "Optional start date YYYY-MM-DD. Default: the whole matter." },
        to: { type: "string", description: "Optional end date YYYY-MM-DD. Default: today." },
        rate: { type: "number", description: "Hourly rate in dollars if the user gave one, e.g. 650. Default: the timekeeper's / matter's rate." },
        include_email: { type: "boolean", description: "Default true." },
        extra_email_terms: { type: "array", items: { type: "string" }, description: "Extra words to find this matter's email by: a client's name, an address, opposing counsel's email." },
      },
      required: ["case_id"],
    },
  },
  {
    name: "show_time_proposal",
    description: "Show the time reconstruction for a civil matter: whether it is still running, and when ready, the card of proposed time entries with its Apply button. Use when the user asks for the time proposal, or after reconstruct_time.",
    input_schema: { type: "object", properties: { case_id: { type: "number" } }, required: ["case_id"] },
  },
  {
    name: "import_time_ledger",
    description: "Import a billing ledger spreadsheet (.xlsx/.xls/.csv) that is in the matter's Dropbox folder — including one the user just attached in this chat — as ONE card of time entries. The file is read in code, so every row comes through exactly. Use this instead of propose_time_entries for any spreadsheet. Get file_id from list_case_documents. Does NOT save until Apply.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        file_id: { type: "number", description: "The spreadsheet's id from list_case_documents." },
        rate: { type: "number", description: "Only if the user names a rate different from the ledger's." },
      },
      required: ["case_id", "file_id"],
    },
  },
  {
    name: "propose_time_entries",
    description: "Propose a list of time entries for a civil matter as ONE card — from an attached billing ledger (Excel/CSV) or entries the user dictates. Does NOT save until Apply. Copy dates, hours and descriptions exactly as given; do not re-estimate them.",
    input_schema: {
      type: "object",
      properties: {
        case_id: { type: "number" },
        rate: { type: "number", description: "Hourly rate if given (the ledger's rate)." },
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "YYYY-MM-DD" },
              hours: { type: "number" },
              description: { type: "string" },
              utbms_code: { type: "string" },
              utbms_activity: { type: "string" },
              flag: { type: "string", description: "Anything to confirm, e.g. 'estimated'." },
            },
            required: ["date", "hours", "description"],
          },
        },
        reason: { type: "string", description: "Where the entries come from, e.g. 'Lee_v_SAL_Billable_Hours.xlsx'." },
      },
      required: ["case_id", "entries"],
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

    if (name === "reconstruct_time") {
      const rec = require("./civil-time-reconstruct");
      const job = rec.startJob(caseId, {
        from: args.from || null, to: args.to || null, rate: Number(args.rate) || null,
        includeEmail: args.include_email !== false, extraTerms: args.extra_email_terms || [],
        by, timekeeper: (user && (user.n || user.u)) || null,
      });
      return {
        started: true, already_running: !!job.already_running, started_at: job.started_at,
        status: "RUNNING IN THE BACKGROUND (2-4 minutes). Nothing is saved. Tell the user they will get a Telegram message when the proposed time is ready, and can then ask you to show the time proposal to review it and press Apply.",
      };
    }
    if (name === "show_time_proposal") {
      const rec = require("./civil-time-reconstruct");
      const job = rec.jobStatus(caseId);
      const pending = await rec.pendingBatches(caseId);
      if (pending.length && sink) pending.forEach(p => sink.push(actions.card(p)));
      return {
        job: job ? { status: job.status, started_at: job.started_at, finished_at: job.finished_at, error: job.error,
                     stats: job.stats ? { documents: job.stats.documents, hearings: job.stats.hearings, emails: job.stats.emails,
                                          mailboxes: job.stats.mailboxes, email_errors: job.stats.email_errors,
                                          hours: job.stats.hours, entries: job.stats.entries, gaps: job.stats.gaps } : undefined } : null,
        pending_cards: pending.map(p => ({ proposal_id: p.id, summary: p.summary, created_at: p.created_at })),
        status: pending.length
          ? "Cards are shown under your reply. Summarize the totals and the items marked to confirm, then tell the user to review and press Apply. Never say the time is logged."
          : (job && job.status === "running" ? "Still running — ask again in a minute or two." : "No pending time proposal on this matter."),
      };
    }
    if (name === "import_time_ledger") {
      const p = await require("./civil-time-reconstruct").importLedgerFromFile(caseId, Number(args.file_id), {
        rate: Number(args.rate) || null, by,
      });
      const c = actions.card(p);
      if (sink) sink.push(c);
      return { proposed: true, proposal_id: c.id, summary: c.summary, lines: (c.lines || []).slice(0, 3),
               status: "NOT SAVED YET. Tell the user the totals and to review the card and press Apply." };
    }
    if (name === "propose_time_entries") {
      const p = await require("./civil-time-reconstruct").proposeEntries(caseId, args.entries || [], {
        rate: Number(args.rate) || null, reason: args.reason || null, by,
      });
      const c = actions.card(p);
      if (sink) sink.push(c);
      return { proposed: true, proposal_id: c.id, summary: c.summary,
               status: "NOT SAVED YET. Tell the user to review the card and press Apply." };
    }

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
