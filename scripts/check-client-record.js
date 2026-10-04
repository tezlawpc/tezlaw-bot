/**
 * check-client-record.js
 *
 * JJ, signed in as a test client, asked Zara "when is my next appt" and got
 * "that's specific to your case, so I don't want to guess."
 *
 * She had been given nothing to answer from. A client token carries
 * uid "c<id>"; /api/client/chat handed that string to client_accounts.id,
 * an integer column; Postgres refused it; the catch swallowed the error.
 * The same string went to fourteen other client routes — documents,
 * invoices, signature requests, appointments, delete-account — which all
 * failed the same way. Nothing caught it because every test faked the
 * database with one that accepts anything.
 *
 * So the fake here is strict where Postgres is strict: an integer column
 * given "c12" throws, exactly as the real one does.
 *
 * Then, with hearings working, JJ asked about billing and got the same
 * answer: "when i ask about billing information, same error message appear.
 * review all relevant information can be pertained to client and allow
 * access." The record carried unpaid invoices only, and a section with
 * nothing in it was left out — so a client who owed nothing looked, to the
 * model, like a client whose billing she could not see.
 *
 * Pinned:
 *   · "c12" becomes 12 before it reaches a query
 *   · a confirmed appointment reaches Zara with its day AND time, in Pacific
 *   · "nothing scheduled" is stated, not left out (an omitted section reads
 *     to the model as "I can't see that")
 *   · an unlinked account says so
 *   · billing reaches Zara: what is owing with its total, what was paid,
 *     the trust balance — and "nothing is owing" is stated when that is so
 *   · matters, team, deadlines, documents and signature requests reach her
 *   · the firm's working file does not: staff notes, task descriptions,
 *     settlement offers, case assessments, unbilled time
 *   · only this client's rows are ever asked for
 *   · no client route in app-api.js passes req.user.uid to an integer column
 *
 *   node scripts/check-client-record.js
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// ── a database that is strict where Postgres is strict ───────────────
const CK = "a-246810121";
const OTHER = "a-999999999";
const D = (iso) => new Date(iso);
const T = {
  client_accounts: [
    { id: 1, phone: "+16265550001", email: "test.client@example.com", client_key: CK, full_name: "Test Client", preferred_lang: "en" },
    { id: 3, phone: "+16265550003", client_key: null, full_name: "Not Linked", preferred_lang: "en" },
  ],
  appointments: [
    { client_key: CK, purpose: "Case review with attorney", status: "confirmed", scheduled_time: D("2026-10-06T21:30:00Z"), scheduled_location: "West Covina office" },
    { client_key: CK, purpose: "Follow-up call", status: "paid_pending", scheduled_time: null, preferred_dates: "weekday afternoons" },
    { client_key: CK, purpose: "Old intake meeting", status: "confirmed", scheduled_time: D("2026-08-01T17:00:00Z") },
    { client_key: OTHER, purpose: "OTHERCLIENT appointment", status: "confirmed", scheduled_time: D("2026-10-07T21:30:00Z") },
  ],
  client_hearing_notices: [
    { client_key: CK, client_name: "Test Client", a_number: "246-810-121", hearing_date: D("2026-11-12T08:30:00Z"), hearing_time_text: "8:30 AM", hearing_type: "Master Calendar", court_name: "Los Angeles Immigration Court" },
  ],
  client_invoices: [
    { client_key: CK, description: "Retainer — second installment", amount_cents: 150000, status: "sent", due_date: D("2026-10-15T12:00:00"), created_at: D("2026-09-20T18:00:00Z") },
    { client_key: CK, description: "USCIS filing fee", amount_cents: 52000, status: "sent", due_date: D("2026-09-25T12:00:00"), created_at: D("2026-09-10T18:00:00Z"), client_claim_paid_at: D("2026-10-02T18:00:00Z") },
    { client_key: CK, description: "Retainer — first installment", amount_cents: 150000, status: "paid", paid_at: D("2026-08-05T18:00:00Z"), paid_method: "zelle", created_at: D("2026-08-01T18:00:00Z") },
    { client_key: CK, description: "Voided duplicate", amount_cents: 999900, status: "void", created_at: D("2026-08-02T18:00:00Z") },
    { client_key: OTHER, description: "OTHERCLIENT invoice", amount_cents: 777700, status: "sent", created_at: D("2026-09-01T18:00:00Z") },
  ],
  accounting_invoices: [
    { client_key: CK, invoice_number: "INV-1042", invoice_date: D("2026-09-20T12:00:00"), total_amount: "1500.00", amount_paid: "0.00", status: "sent" },
  ],
  trust_transactions: [
    { id: 9, client_key: CK, txn_type: "disbursement", amount_cents: 52000, running_balance_cents: 248000, transaction_date: D("2026-09-12T12:00:00"), description: "USCIS filing fee" },
    { id: 8, client_key: CK, txn_type: "deposit", amount_cents: 300000, running_balance_cents: 300000, transaction_date: D("2026-08-05T12:00:00"), description: "Initial deposit" },
  ],
  tasks: [
    { id: 41, client_key: CK, client_name: "Test Client", a_number: "246-810-121", title: "I-589 asylum application", matter_type: "immigration", status: "in_progress", attorney: "JJ Zhang", assigned_to: "Maria Lopez", due_date: D("2026-12-01T12:00:00"),
      description: "INTERNAL weak on nexus, credibility problem", completion_notes: "INTERNAL note", created_at: D("2026-08-01T18:00:00Z") },
    { id: 42, client_key: CK, title: "Work permit (I-765)", matter_type: "immigration", status: "completed", completed_at: D("2026-09-15T18:00:00Z"), completion_notes: "INTERNAL done late", created_at: D("2026-08-01T18:00:00Z") },
  ],
  task_milestones: [
    { task_id: 41, title: "Collect declarations", status: "completed", completed_at: D("2026-09-01T18:00:00Z") },
    { task_id: 41, title: "File with the court", status: "pending" },
  ],
  civil_cases: [
    { id: 7, client_key: CK, case_name: "Client v. Landlord LLC", case_number: "24STCV01234", court: "LA Superior Court", our_role: "plaintiff", stage: "discovery", status: "active",
      lead_attorney_id: 2, billing_type: "hourly", hourly_rate: "350.00", retainer_amount: "5000.00",
      internal_notes: "INTERNAL client is difficult", settlement_authority: "INTERNAL 40000", created_at: D("2026-06-01T18:00:00Z") },
  ],
  civil_hearings: [
    { case_id: 7, hearing_date: D("2026-10-20T12:00:00"), hearing_time: "8:30 AM", hearing_type: "motion_to_compel", department: "32", status: "scheduled", notes: "INTERNAL tentative against us" },
  ],
  civil_case_deadlines: [
    { case_id: 7, description: "Responses to interrogatories", due_date: D("2026-10-28T12:00:00"), status: "pending", notes: "INTERNAL ask for extension" },
  ],
  civil_invoices: [],
  civil_case_team: [{ case_id: 7, user_name: "Sam Park", role: "paralegal" }],
  admin_users: [{ id: 2, full_name: "JJ Zhang" }],
  pi_cases: [{ id: 5, client_key: CK, incident_type: "auto", incident_date: D("2026-03-03T12:00:00"), liability_assessment: "INTERNAL 60/40", demand_amount: "INTERNAL-85000" }],
  pi_disbursements: [],
  federal_matters: [],
  case_members: [{ client_key: CK, full_name: "Spouse Client", relationship: "spouse", a_number: "INTERNAL-A-number", is_primary: false }],
  client_contacts: [{ client_key: CK, phone: "+16265550001", address: "100 Test St, West Covina, CA", notes: "INTERNAL do not call before noon" }],
  client_consultants: [],
  // What the client sent from the app. client_documents is the firm's own
  // Documents tab — same client, and never part of the client's record.
  client_uploads: [{ client_key: CK, filename: "passport.pdf", category: "identity", uploaded_by: "client", uploaded_at: D("2026-09-02T18:00:00Z") }],
  client_documents: [{ client_key: CK, filename: "INTERNAL-strategy-memo.pdf", category: "work product", uploaded_at: D("2026-09-03T18:00:00Z") }],
  signature_requests: [
    { client_key: CK, title: "Fee agreement", status: "pending", created_at: D("2026-09-28T18:00:00Z") },
    { client_key: CK, title: "Release of information", status: "signed", signed_at: D("2026-08-03T18:00:00Z") },
  ],
  esign_packets: [],
  client_messages: [
    { client_key: CK, sender_kind: "firm", read_at: null, created_at: D("2026-10-01T18:00:00Z"), body: "INTERNAL message body" },
    { client_key: CK, sender_kind: "client", read_at: null, created_at: D("2026-09-30T18:00:00Z") },
  ],
  // no client_key column on these two: matched by A-number / name in SQL
  deadlines: [{ _ck: CK, description: "File I-589 with the court", due_date: D("2026-11-30T12:00:00"), priority: "high" },
              { _ck: OTHER, description: "OTHERCLIENT deadline", due_date: D("2026-11-01T12:00:00") }],
  hearing_notes: [],
};
// Rows that hang off a case or a task are fetched by id, not by client key.
const BY_ID = { civil_hearings: "case_id", civil_case_deadlines: "case_id", civil_invoices: "case_id",
                civil_case_team: "case_id", pi_disbursements: "case_id", task_milestones: "task_id", admin_users: "id" };
const asked = [];
function makeDb(tables) {
  return {
    query: async (sql, params = []) => {
      const q = sql.replace(/\s+/g, " ").trim();
      asked.push({ q, params });
      const v = params[0];
      if (/FROM client_accounts WHERE id = \$1/.test(q)) {
        if (typeof v !== "number" && !/^\d+$/.test(String(v))) {
          throw new Error(`invalid input syntax for type integer: "${v}"`);
        }
        return { rows: (tables.client_accounts || []).filter(a => a.id === Number(v)) };
      }
      if (/= ANY\(\$1::int\[\]\)/.test(q)) {
        if (!Array.isArray(v) || !v.every(Number.isInteger)) throw new Error(`malformed array literal: ${JSON.stringify(v)}`);
        const tbl = (q.match(/FROM (\w+)/) || [])[1];
        const col = BY_ID[tbl];
        if (!col) throw new Error(`unexpected id lookup on ${tbl}`);
        return { rows: (tables[tbl] || []).filter(r => v.includes(r[col])) };
      }
      if (typeof v !== "string") throw new Error(`expected a client key, got ${JSON.stringify(v)}`);
      if (/FROM hearing_notes/.test(q)) return { rows: (tables.hearing_notes || []).filter(r => r._ck === v) };
      if (/FROM deadlines/.test(q)) return { rows: (tables.deadlines || []).filter(r => r._ck === v) };
      const tbl = (q.match(/FROM (\w+)/) || [])[1];
      return { rows: (tables[tbl] || []).filter(r => r.client_key === v) };
    },
  };
}
const EMPTY = Object.fromEntries(Object.keys(T).map(k => [k, []]));

const R = require("../client-record");
const NOW = new Date("2026-10-04T05:50:00Z");          // Saturday Oct 3, 10:50 PM Pacific

// zara-app-chat pulls in zara-core; only CLIENT_OPS is wanted here.
const orig = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./zara-core") return { think: async () => ({ text: "" }) };
  if (r === "./zara-case-tools") return { CASE_TOOLS: [], NAMES: new Set(), run: async () => ({}) };
  return orig.call(this, r, ...rest);
};
const chat = require("../zara-app-chat");
Module._load = orig;

(async () => {
  console.log("The account id");
  check('"c12" is read as 12', () => R.accountIdOf("c12") === 12);
  check("a plain number passes through", () => R.accountIdOf(7) === 7);
  check("nothing usable gives null, not NaN or 0", () => R.accountIdOf("") === null && R.accountIdOf(undefined) === null && R.accountIdOf("c") === null);

  console.log("\nA linked client with an appointment");
  const quiet = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  const rec = await R.build(makeDb(T), { uid: "c1", clientKey: CK, name: "Test Client", now: NOW });
  console.warn = quiet;
  check('the token\'s "c1" does not reach the integer column', () => warned.length === 0 || warned.join(" | "));
  check("the record is linked", () => rec && rec.linked === true);
  check("the next appointment is there", () => rec.upcoming_appointments.length === 1);
  check("with its day, time and zone — 2:30 PM Pacific, not a bare date",
    () => /Tuesday, October 6, 2026 at 2:30 PM Pacific time/.test(rec.upcoming_appointments[0]) || rec.upcoming_appointments[0]);
  check("and its place", () => /West Covina office/.test(rec.upcoming_appointments[0]));
  check("a request with no time is kept apart from scheduled ones",
    () => rec.requested_appointments.length === 1 && /Follow-up call/.test(rec.requested_appointments[0]));
  check("a past appointment is not offered as the next one",
    () => !rec.upcoming_appointments.some(a => /Old intake/.test(a)) && rec.past_appointments.length === 1);
  check("the hearing keeps the time printed on the notice",
    () => rec.upcoming_hearings.some(h => /Thursday, November 12, 2026 at 8:30 AM — Master Calendar/.test(h)) || JSON.stringify(rec.upcoming_hearings));

  const ops = chat.CLIENT_OPS("Test Client", "en", rec);
  check("Zara is handed the appointment", () => ops.includes("Tuesday, October 6, 2026 at 2:30 PM Pacific time"));
  check("and told to answer from it — 'appt' and 'meeting' included",
    () => /Answer from it directly/.test(ops) && /Treat "appointment", "appt", "meeting" and "consultation" as the same question/.test(ops));
  check("and told what today is", () => ops.includes("Today is Saturday, October 3, 2026"));

  console.log("\nA linked client with nothing on file");
  const bare = await R.build(makeDb({ ...EMPTY, client_accounts: T.client_accounts }), { uid: "c1", now: NOW });
  const bareOps = chat.CLIENT_OPS("Test Client", "en", bare);
  check("still a record, not 'no case'", () => bare.linked === true && !bareOps.includes("NO CASE RECORD"));
  check('"None scheduled." is stated for appointments', () => /Upcoming appointments[^\n]*:\n {2}- None scheduled\./.test(bareOps));
  check('"None on file." is stated for court dates', () => /Upcoming court dates[^\n]*:\n {2}- None on file\./.test(bareOps));
  check('"Nothing is owing" is stated, not left out', () => /Invoices awaiting payment:\n {2}- None\. Nothing is owing on the invoices in this system\./.test(bareOps));
  check("no trust funds is stated", () => bareOps.includes("No trust funds on record for this client."));
  check("no deadlines, documents or signatures is stated",
    () => /Deadlines on file[^\n]*:\n {2}- None on file\./.test(bareOps) && bareOps.includes("None uploaded through the app.") && bareOps.includes("Nothing is waiting for a signature."));
  check("and she is told that 'none' is an answer", () => /"None", "None on file" and "None scheduled" are facts you hold/.test(bareOps));

  console.log("\nAn account not linked to a matter");
  const unl = await R.build(makeDb(T), { uid: "c3", now: NOW });
  check("linked is false", () => unl.linked === false);
  check("Zara is told to say so, appointments and bills included",
    () => { const t = chat.CLIENT_OPS("Not Linked", "en", unl); return t.includes("NO CASE RECORD") && /hearing, appointment, bill, filing/.test(t); });

  console.log("\nWhen the account row cannot be read");
  const viaToken = await R.build(makeDb({ ...T, client_accounts: [] }), { uid: "c99", clientKey: CK, name: "Test Client", now: NOW });
  check("the token's own client key still finds the record", () => viaToken.linked === true && viaToken.upcoming_appointments.length === 1);

  console.log("\nBilling");
  const B = rec.billing;
  check("what is owing is listed, oldest due first", () => B.owing.length === 2 && /USCIS filing fee — \$520\.00/.test(B.owing[0]) || JSON.stringify(B.owing));
  check("with the total", () => B.owing_total === "$2,020.00" || B.owing_total);
  check("an invoice past its due date says so", () => /PAST DUE/.test(B.owing[0]) && !/PAST DUE/.test(B.owing[1]));
  check("a payment the client reported is not called paid",
    () => /the client reported paying it on Friday, October 2, 2026 — the firm has not confirmed receipt yet/.test(B.owing[0]) || B.owing[0]);
  check("what was paid is listed with when and how",
    () => B.paid.length === 1 && /Retainer — first installment — \$1,500\.00.*PAID Wednesday, August 5, 2026 by zelle/.test(B.paid[0]) || B.paid[0]);
  check("a voided invoice is in neither list", () => !JSON.stringify(B).includes("Voided duplicate"));
  check("the trust balance is the latest entry's", () => /^\$2,480\.00 as of the last entry on Saturday, September 12, 2026/.test(B.trust_balance) || B.trust_balance);
  check("recent trust activity is listed", () => B.trust_recent.length === 2 && /deposit of \$3,000\.00: Initial deposit/.test(B.trust_recent[1]));
  check("fee terms on file are there", () => /hourly rate \$350\.00, retainer \$5,000\.00/.test(B.fee_terms[0]) || B.fee_terms[0]);
  check("Zara is handed the amounts", () => ops.includes("Invoices awaiting payment — total $2,020.00") && ops.includes("Balance $2,480.00"));
  check("and told billing is hers to answer", () => /"What do I owe[^"]*" are all answered from BILLING/.test(ops));
  check("and that the matter is in scope, not something to redirect", () => /bills and payments[^.]*are NOT outside your scope/.test(ops));
  check("the firm's second ledger is not to be added on top", () => ops.includes("INV-1042") && ops.includes("do not add the two lists together"));

  console.log("\nThe rest of what is theirs to know");
  check("their matters and where each stands",
    () => rec.matters.some(m => /Client v\. Landlord LLC; case no\. 24STCV01234.*stage: discovery.*lead attorney JJ Zhang/.test(m)) &&
          rec.matters.some(m => /I-589 asylum application.*in progress.*steps done 1 of 2, next: File with the court/.test(m)) || JSON.stringify(rec.matters));
  check("finished work is kept apart from open work",
    () => rec.completed_work.length === 1 && /Work permit \(I-765\).*completed Tuesday, September 15, 2026/.test(rec.completed_work[0]) && !rec.matters.some(m => /Work permit/.test(m)));
  check("each person on the team once", () => rec.team.filter(p => /JJ Zhang/.test(p)).length === 1 && rec.team.some(p => /Sam Park \(paralegal\)/.test(p)) && rec.team.some(p => /Maria Lopez/.test(p)));
  check("court dates from both dockets, soonest first",
    () => rec.upcoming_hearings.length === 2 && /Tuesday, October 20, 2026 at 8:30 AM — motion to compel, Dept\. 32/.test(rec.upcoming_hearings[0]) || JSON.stringify(rec.upcoming_hearings));
  check("deadlines are included now", () => rec.open_deadlines.length === 2 && rec.open_deadlines.some(d => /File I-589 with the court — due Monday, November 30, 2026/.test(d)));
  check("documents on file", () => /passport\.pdf \(identity\) — uploaded Wednesday, September 2, 2026/.test(rec.documents[0]) || rec.documents[0]);
  check("what is waiting for a signature, apart from what is signed",
    () => rec.signatures_pending.length === 1 && /Fee agreement/.test(rec.signatures_pending[0]) && /Release of information \[signed/.test(rec.signatures_done[0]));
  check("unread messages are counted, firm's only", () => rec.messages.unread === 1 && rec.messages.last_from_firm === "Thursday, October 1, 2026");
  check("family on the case by name and relationship", () => rec.family_on_case[0] === "Spouse Client (spouse)");
  check("all of it reaches Zara", () => ["Client v. Landlord LLC", "File I-589 with the court", "passport.pdf", "Fee agreement", "1 unread", "Sam Park"].every(x => ops.includes(x)) ||
    ["Client v. Landlord LLC", "File I-589 with the court", "passport.pdf", "Fee agreement", "1 unread", "Sam Park"].filter(x => !ops.includes(x)).join(", "));

  console.log("\nThe firm's working file stays with the firm");
  const everything = JSON.stringify(rec) + ops;
  check("no staff note, task description, assessment or message body is in the record", () => !everything.includes("INTERNAL") ||
    everything.slice(everything.indexOf("INTERNAL") - 60, everything.indexOf("INTERNAL") + 40));
  check("Zara is told what she is not shown", () => /Not shown to you, by design: the firm's internal notes, strategy, settlement offers and negotiations, and time not yet billed/.test(ops));
  check("she still may not predict, advise or guess", () => /Predict or estimate an outcome/.test(ops) && /Never fill a gap with a guess/.test(ops));
  check("and still closes dates and amounts with 'confirm with your legal team'", () => /a deadline, an appointment time or an amount, close with one short line/.test(ops));

  console.log("\nOnly this client");
  asked.length = 0;
  const again = await R.build(makeDb(T), { uid: "c1", now: NOW });
  const mine = (a) => a.params.length === 1 && (a.params[0] === 1 || a.params[0] === CK ||
    (Array.isArray(a.params[0]) && a.params[0].length > 0 && a.params[0].every(Number.isInteger)));
  check("every query is keyed to this account, this client key, or this client's own case ids",
    () => asked.every(mine) || JSON.stringify(asked.filter(a => !mine(a)).map(a => a.params)));
  check("the ids used are ones the client's own rows supplied",
    () => asked.filter(a => Array.isArray(a.params[0])).every(a => a.params[0].every(id => [7, 5, 41, 42, 2].includes(id))));
  check("another client's rows are nowhere in it", () => !(JSON.stringify(again) + chat.CLIENT_OPS("Test Client", "en", again)).includes("OTHERCLIENT"));
  check("file contents are never fetched — documents and signature requests by named columns only",
    () => asked.filter(a => /FROM (client_uploads|signature_requests|esign_packets|client_messages)/.test(a.q)).every(a => !/SELECT \*/.test(a.q) && !/\b(content|body_snapshot|signed_pdf|docx|body)\b/.test(a.q.split(" FROM ")[0])));
  check("the client's documents come from the app's table, and the firm's Documents tab is never read",
    () => asked.some(a => /FROM client_uploads/.test(a.q)) && !asked.some(a => /FROM client_documents/.test(a.q)) &&
      JSON.stringify(again).includes("passport.pdf") && !(JSON.stringify(again) + chat.CLIENT_OPS("Test Client", "en", again)).includes("INTERNAL-strategy-memo"));
  check("unbilled time, settlement offers and notes tables are not queried at all",
    () => !asked.some(a => /FROM (time_entries|civil_time_entries|pi_offers|pi_negotiations|client_notes|pi_liens|pi_medical)/.test(a.q)) ||
          asked.filter(a => /FROM (time_entries|civil_time_entries|pi_offers|pi_negotiations|client_notes|pi_liens|pi_medical)/.test(a.q)).map(a => a.q.slice(0, 60)).join(" | "));

  console.log("\nThe routes");
  const api = fs.readFileSync(path.join(__dirname, "..", "app-api.js"), "utf8");
  check("no client_accounts lookup is handed req.user.uid",
    () => !/client_accounts WHERE id = \$1[^;]{0,80}\[req\.user\.uid\]/.test(api));
  check("the chat route builds the record in client-record.js",
    () => /api\/client\/chat[\s\S]{0,1200}require\("\.\/client-record"\)\.build\(/.test(api));
  check("it no longer selects a column client_accounts does not have",
    () => !/SELECT full_name, email, phone, client_key, language/.test(api));
  check("the document download recognises a client by role (r), not by a field tokens never carry (k)",
    () => !/req\.user\.k === 'client'/.test(api));
  check("delete-account no longer runs a statement that aborts its own transaction",
    () => !/DELETE FROM client_messages WHERE from_user_id/.test(api));
  check("CLIENT_OPS does not declare its own Zara", () => !chat.CLIENT_OPS("Ana", "en", null).includes("You are Zara"));

  console.log("\n" + (failures ? `${failures} FAILED` : "all client-record checks passed"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("check crashed:", e); process.exit(1); });
