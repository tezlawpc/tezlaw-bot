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
 * Pinned:
 *   · "c12" becomes 12 before it reaches a query
 *   · a confirmed appointment reaches Zara with its day AND time, in Pacific
 *   · "nothing scheduled" is stated, not left out (an omitted section reads
 *     to the model as "I can't see that")
 *   · an unlinked account says so
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
const T = {
  client_accounts: [
    { id: 1, phone: "+16265550001", client_key: CK, full_name: "Test Client", preferred_lang: "en" },
    { id: 3, phone: "+16265550003", client_key: null, full_name: "Not Linked", preferred_lang: "en" },
  ],
  appointments: [
    { client_key: CK, purpose: "Case review with attorney", status: "confirmed", scheduled_time: new Date("2026-10-06T21:30:00Z"), scheduled_location: "West Covina office" },
    { client_key: CK, purpose: "Follow-up call", status: "paid_pending", scheduled_time: null, preferred_dates: "weekday afternoons" },
    { client_key: CK, purpose: "Old intake meeting", status: "confirmed", scheduled_time: new Date("2026-08-01T17:00:00Z") },
  ],
  client_hearing_notices: [
    { client_key: CK, client_name: "Test Client", a_number: "246-810-121", hearing_date: new Date("2026-11-12T08:30:00Z"), hearing_time_text: "8:30 AM", hearing_type: "Master Calendar", court_name: "Los Angeles Immigration Court" },
  ],
};
const asked = [];
function makeDb(tables) {
  return {
    query: async (sql, params = []) => {
      const q = sql.replace(/\s+/g, " ");
      asked.push({ q, params });
      if (/FROM client_accounts WHERE id = \$1/.test(q)) {
        const v = params[0];
        if (typeof v !== "number" && !/^\d+$/.test(String(v))) {
          throw new Error(`invalid input syntax for type integer: "${v}"`);
        }
        return { rows: tables.client_accounts.filter(a => a.id === Number(v)) };
      }
      if (/SELECT client_name, a_number FROM client_hearing_notices/.test(q)) return { rows: tables.client_hearing_notices.filter(r => r.client_key === params[0]) };
      if (/FROM client_hearing_notices/.test(q)) return { rows: tables.client_hearing_notices.filter(r => r.client_key === params[0]) };
      if (/FROM appointments/.test(q)) return { rows: (tables.appointments || []).filter(r => r.client_key === params[0]) };
      return { rows: [] };
    },
  };
}

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
    () => /Thursday, November 12, 2026 at 8:30 AM — Master Calendar/.test(rec.upcoming_hearings[0]) || rec.upcoming_hearings[0]);
  check("deadlines are not sent to the client surface", () => !("open_deadlines" in rec));

  const ops = chat.CLIENT_OPS("Test Client", "en", rec);
  check("Zara is handed the appointment", () => ops.includes("Tuesday, October 6, 2026 at 2:30 PM Pacific time"));
  check("and told to answer from it", () => /"When is my next appointment\?" is answered from the record/.test(ops));
  check("and told what today is", () => ops.includes("Today is Saturday, October 3, 2026"));

  console.log("\nA linked client with nothing scheduled");
  const bare = await R.build(makeDb({ ...T, appointments: [], client_hearing_notices: [] }), { uid: "c1", now: NOW });
  const bareOps = chat.CLIENT_OPS("Test Client", "en", bare);
  check("still a record, not 'no case'", () => bare.linked === true && !bareOps.includes("NO CASE RECORD"));
  check('"None scheduled." is stated for appointments', () => /Upcoming appointments[^\n]*:\n {2}- None scheduled\./.test(bareOps));
  check('"None on file." is stated for hearings', () => /Upcoming hearings[^\n]*:\n {2}- None on file\./.test(bareOps));

  console.log("\nAn account not linked to a matter");
  const unl = await R.build(makeDb(T), { uid: "c3", now: NOW });
  check("linked is false", () => unl.linked === false);
  check("Zara is told to say so, appointments included",
    () => { const t = chat.CLIENT_OPS("Not Linked", "en", unl); return t.includes("NO CASE RECORD") && /hearing, appointment, filing/.test(t); });

  console.log("\nWhen the account row cannot be read");
  const viaToken = await R.build(makeDb({ ...T, client_accounts: [] }), { uid: "c99", clientKey: CK, name: "Test Client", now: NOW });
  check("the token's own client key still finds the record", () => viaToken.linked === true && viaToken.upcoming_appointments.length === 1);

  console.log("\nOnly this client");
  asked.length = 0;
  await R.build(makeDb(T), { uid: "c1", now: NOW });
  check("every query is keyed to this account or this client key",
    () => asked.every(a => a.params.length === 1 && (a.params[0] === 1 || a.params[0] === CK)) ||
          JSON.stringify(asked.filter(a => !(a.params.length === 1 && (a.params[0] === 1 || a.params[0] === CK))).map(a => a.params)));
  check("deadlines are not queried at all", () => !asked.some(a => /FROM deadlines/.test(a.q)));

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
