// ============================================================
//  retainer-handoff.js — what happens when an agreement goes out
//  ─────────────────────────────────────────────────────────
//  "when picking the client and it matches an existing client in the
//   system, the retainer will be stored to client's profile and case is
//   created. invoice should be created as well according to the
//   agreement." (JJ, 2026-10-08)
//
//  WHEN THIS RUNS
//  On send for signature, not on save. A draft is a draft: people make
//  three and discard two, and a discarded draft must not leave a case and
//  an invoice behind for someone to clean up. Sending is the first moment
//  the firm has committed to anything.
//
//  IDEMPOTENT, BECAUSE SEND IS A BUTTON
//  Someone will click it twice, or resend after a correction. Every step
//  checks for its own prior result first and reports "already" rather than
//  making a second case and a second invoice. The draft carries the ids it
//  created, so a second run has something to find.
//
//  WHAT IS INVOICED, AND WHY NOT THE WHOLE FEE EVERY TIME
//  The invoice is what the client owes NOW, which is not the same as the
//  fee:
//    flat / hybrid  the flat fee, payable on signing and held in trust
//                   until it is earned against the milestone table. This
//                   is not "earned on receipt" -- the money is collected
//                   now and earned later, which is what Rule 1.15 and the
//                   flat-fee clauses in this agreement describe.
//    hourly         the deposit, not an estimate of the eventual bill.
//                   Billing for time happens later, from time records.
//    contingency    NOTHING. A contingency client owes no fee until there
//                   is a recovery, and invoicing one at signature would be
//                   a demand for money that is not owed. Costs are billed
//                   as they are incurred, by whoever incurs them.
//
//  NEVER THROWS INTO THE SEND PATH
//  If any of this fails, the agreement still goes out and the failure is
//  reported. An accounting hiccup must not stop a client signing.
// ============================================================

const db = () => require("./db");

// Which table a matter of this kind lives in. Keys are MATTER_LABELS keys,
// which is what the form produces -- see check-retainer.js, which refuses
// any key the form cannot emit.
const ROUTING = {
  personal_injury:            "pi",
  civil_litigation:           "civil",
  landlord_tenant:            "civil",
  real_estate:                "civil",
  federal_litigation:         "federal",
  trademark:                  "federal",     // federal_matters carries tm_* columns
  immigration_removal:        "none",
  immigration_family:         "none",
  immigration_business:       "none",
  immigration_naturalization: "none",
  estate_planning:            "none",
};

const cents = (n) => Math.round(Number(n || 0) * 100);

/**
 * The client this agreement is for.
 *
 * Only an EXISTING client is matched. A name typed into the picker that
 * matches nobody is left alone: creating a client record from a fee
 * agreement would make a second profile for someone already on file under
 * a different spelling, and merging those by hand is worse than not having
 * made them. The caller is told, and the drafter adds the client properly.
 */
async function findClient(terms) {
  const cp = require("./client-profiles");
  const key = String(terms.client_key || "").trim();
  if (key) {
    const c = await cp.getClientByKey(key).catch(() => null);
    if (c) return c;
  }
  const name = String(terms.client_name || "").trim();
  if (!name) return null;
  // The picker stores the key when the name came from the list, so a
  // missing key means the drafter typed it. Match on the name exactly,
  // case-insensitively, and on nothing looser: a fuzzy match here attaches
  // an agreement to the wrong person's file.
  const r = await db().query(
    `SELECT client_key AS key, client_name FROM (
        SELECT client_key, client_name FROM pi_cases WHERE client_name IS NOT NULL
        UNION ALL SELECT client_key, client_name FROM federal_matters WHERE client_name IS NOT NULL
        UNION ALL SELECT client_key, case_name   FROM civil_cases     WHERE case_name IS NOT NULL
      ) t WHERE lower(trim(client_name)) = lower($1) LIMIT 2`, [name]).catch(() => ({ rows: [] }));
  if (r.rows.length === 1) {
    return require("./client-profiles").getClientByKey(r.rows[0].key).catch(() => null);
  }
  return null;   // none, or more than one: a person decides
}

/**
 * The agreement itself, on the client's file.
 *
 * The actual Word file, which is what the client is being sent -- not a
 * row pointing at a draft that can still be edited afterwards. The
 * profile should hold the document that went out.
 *
 * `description` carries "retainer:<id>" so a second send finds the first
 * rather than filing a duplicate.
 */
async function fileOnProfile(draft, client, by) {
  void by;   // client_documents records the client, not the uploader
  const ref = `retainer:${draft.id}`;
  const cd = require("./client-documents");
  await cd.initTable();

  const r = await db().query(
    `SELECT id FROM client_documents WHERE client_key = $1 AND description = $2 LIMIT 1`,
    [client.key, ref]).catch(() => ({ rows: [] }));
  if (r.rows.length) return { already: true, id: r.rows[0].id };

  const DOC = require("./retainer-doc");
  const DOCX = require("./retainer-docx");
  const terms = draft.terms || {};
  const buffer = DOCX.build(terms, DOC);

  const out = await cd.uploadDocument({
    clientKey: client.key,
    clientName: client.client_name || terms.client_name || null,
    aNumber: client.a_number || null,
    filename: DOCX.fileName(terms),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer,
    category: "Fee agreement",
    description: ref,
  });
  return { already: false, id: out && out.id, bytes: buffer.length };
}

/** A case or matter, in whichever table this practice area uses. */
async function openMatter(draft, client, by) {
  const terms = draft.terms || {};
  const kind = ROUTING[terms.matter_type] || "none";
  const label = terms.matter_label || draft.matter_type || "Matter";

  if (kind === "none") {
    // Immigration, estate planning: no case table of their own in this
    // system. The agreement on the profile IS the record, and saying so is
    // better than inventing a row in a table that was built for something
    // else.
    return { kind, created: false,
             note: `${terms.matter_type} has no case table here; the agreement is on the client's file.` };
  }

  if (kind === "civil") {
    const L = require("./civil-litigation");
    const dup = await db().query(
      `SELECT id FROM civil_cases WHERE client_key = $1 AND case_name = $2 LIMIT 1`,
      [client.key, label]).catch(() => ({ rows: [] }));
    if (dup.rows.length) return { kind, created: false, id: dup.rows[0].id, already: true };
    const c = await L.createCase({
      client_key: client.key, case_name: label,
      case_type: terms.matter_type, stage: "intake",
      billing_type: terms.structure || null,
      contingency_pct: terms.contingency_pct || null,
      retainer_amount: terms.total_fee || null,
      created_by: by || null,
      // Deliberately NOT set: statute_of_limitations. It drives the
      // deadline chain and is not something a fee agreement knows.
    });
    return { kind, created: true, id: c && (c.id || (c.rows && c.rows[0] && c.rows[0].id)) };
  }

  if (kind === "federal") {
    const F = require("./federal-matters");
    const dup = await db().query(
      `SELECT id FROM federal_matters WHERE client_key = $1 AND lower(COALESCE(cause_of_action,'')) = lower($2) LIMIT 1`,
      [client.key, label]).catch(() => ({ rows: [] }));
    if (dup.rows.length) return { kind, created: false, id: dup.rows[0].id, already: true };
    const m = await F.createMatter({
      matter_type: terms.matter_type === "trademark" ? "trademark" : "litigation",
      client_name: terms.client_name, client_key: client.key,
      a_number: client.a_number || null,
      cause_of_action: label, status: "active",
      assigned_attorney: terms.drafted_by || null, created_by: by || null,
    });
    return { kind, created: true, id: m && m.id };
  }

  // pi
  const dup = await db().query(
    `SELECT id FROM pi_cases WHERE client_key = $1 LIMIT 1`, [client.key]).catch(() => ({ rows: [] }));
  if (dup.rows.length) return { kind, created: false, id: dup.rows[0].id, already: true };
  const p = await db().query(
    `INSERT INTO pi_cases (client_key, client_name, status, intake_date)
     VALUES ($1, $2, 'intake', NOW()) RETURNING id`,
    [client.key, terms.client_name]);
  return { kind, created: true, id: p.rows[0].id };
}

/**
 * What the client owes on signing.
 *
 * Returns null where nothing is owed yet, which is not a failure: a
 * contingency client owes no fee until there is a recovery.
 */
function amountDue(terms) {
  const s = terms.structure;
  if (s === "flat" || s === "hybrid") {
    return Number(terms.total_fee) > 0
      ? { amount: Number(terms.total_fee),
          description: `Flat fee on signing, held in the client trust account and earned as the work is performed` }
      : null;
  }
  if (s === "hourly") {
    return Number(terms.deposit) > 0
      ? { amount: Number(terms.deposit),
          description: `Deposit against hourly fees, held in the client trust account and applied as time is billed` }
      : null;
  }
  return null;   // contingency: nothing is owed at signature
}

/** The invoice, if anything is owed. */
async function raiseInvoice(draft, client, by) {
  const terms = draft.terms || {};
  const due = amountDue(terms);
  if (!due) {
    return { created: false,
             note: terms.structure === "contingency"
               ? "Contingency: no fee is owed until there is a recovery, so no invoice was raised."
               : "The agreement states no amount payable on signing, so no invoice was raised." };
  }
  const ref = `retainer:${draft.id}`;
  const dup = await db().query(
    `SELECT id FROM client_invoices WHERE client_key = $1 AND notes = $2 LIMIT 1`,
    [client.key, ref]).catch(() => ({ rows: [] }));
  if (dup.rows.length) return { created: false, id: dup.rows[0].id, already: true };

  const matter = terms.matter_label ? ` (${terms.matter_label})` : "";
  const r = await db().query(
    `INSERT INTO client_invoices (client_key, description, amount_cents, notes, status, created_by)
     VALUES ($1, $2, $3, $4, 'sent', $5) RETURNING id`,
    [client.key, due.description + matter, cents(due.amount), ref, by || null]);
  return { created: true, id: r.rows[0].id, amount: due.amount };
}

/**
 * Everything that follows from sending an agreement.
 *
 * Returns a record of what happened, for the screen to show. Never throws:
 * the agreement goes out either way, and a failure here is reported rather
 * than blocking a client from signing.
 */
async function handoff(draft, { by = null } = {}) {
  const steps = [];
  let client = null;
  try {
    client = await findClient(draft.terms || {});
  } catch (err) {
    steps.push({ step: "client", ok: false, note: err.message });
  }

  if (!client) {
    steps.push({ step: "client", ok: false,
      note: "No existing client matched this name, so nothing was filed. Add the client first, then resend." });
    return { ok: false, client: null, steps };
  }
  steps.push({ step: "client", ok: true, note: `Matched ${client.client_name || client.key}.` });

  for (const [name, fn] of [
    ["agreement on file", () => fileOnProfile(draft, client, by)],
    ["case", () => openMatter(draft, client, by)],
    ["invoice", () => raiseInvoice(draft, client, by)],
  ]) {
    try {
      const r = await fn();
      steps.push({ step: name, ok: true, ...r });
    } catch (err) {
      steps.push({ step: name, ok: false, note: err.message });
    }
  }
  return { ok: steps.every((s) => s.ok), client, steps };
}

module.exports = { handoff, findClient, fileOnProfile, openMatter, raiseInvoice, amountDue, ROUTING };
