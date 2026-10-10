// ============================================================
//  client-contacts.js — WHERE A CLIENT'S CURRENT DETAILS LIVE
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  The client profile page shows Phone and Address, but until
//  now there was nothing behind those fields to write to. They
//  were read out of hearing_notes and individual_hearing_notes:
//  aggregateClients() walks every note newest-first and takes
//  the first non-empty value it finds.
//
//  That is why a profile can show "Los Angeles, CA" with no
//  street — it is whatever some hearing note happened to record,
//  and nobody could correct it.
//
//  WHY NOT JUST EDIT THE NOTES: a hearing note is a
//  contemporaneous record of what was known at that hearing.
//  Writing a 2026 address onto a 2023 note makes the file say
//  something untrue about 2023. In a litigation file that is not
//  a tidy-up, it is a falsified record.
//
//  So current details get their own row here, and the profile
//  prefers it. The notes are left exactly as they were written,
//  and every value carries where it came from — typed by hand,
//  or read off a specific I-589 — so a bad import can be
//  identified and removed without touching anything else.
// ============================================================

const db = () => require("./db");

let ready = null;
async function initTable() {
  if (ready) return ready;
  ready = (async () => {
    await db().query(`
      CREATE TABLE IF NOT EXISTS client_contacts (
        client_key     TEXT PRIMARY KEY,
        phone          TEXT,
        address        TEXT,
        email          TEXT,
        language       TEXT,          -- 'en' | 'zh' | 'es' | 'hi' | 'pa'
        source         TEXT,          -- 'manual' | 'i589' | ...
        source_detail  TEXT,          -- the Dropbox path of the form, say
        source_date    DATE,          -- the date OF that source document
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_by     TEXT
      )
    `);
    // Added after the table shipped, so existing deployments get it here
    // rather than only on a fresh database.
    await db().query(`ALTER TABLE client_contacts ADD COLUMN IF NOT EXISTS language TEXT`);
    await db().query(
      `CREATE INDEX IF NOT EXISTS client_contacts_updated ON client_contacts (updated_at DESC)`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/** Current details for one client, or null. */
async function get(clientKey) {
  await initTable();
  const r = await db().query(`SELECT * FROM client_contacts WHERE client_key = $1`, [clientKey]);
  return r.rows[0] || null;
}

/**
 * Every stored contact, as a Map keyed by client_key.
 * One query rather than one per client — aggregateClients runs over the whole
 * book and a per-client lookup there would be 2,000 round trips.
 */
async function all() {
  await initTable();
  const r = await db().query(`SELECT * FROM client_contacts`);
  const m = new Map();
  for (const row of r.rows) m.set(row.client_key, row);
  return m;
}

/**
 * Write current details.
 *
 * Only the fields passed are touched, so setting a phone does not wipe an
 * address someone typed last week. Passing an explicit empty string clears a
 * field; passing undefined leaves it alone. That distinction is the whole
 * reason this takes an object rather than positional arguments.
 */
// What a person is allowed to correct from the client's profile.
//
// NOT the name and NOT the A-number. Those two ARE the client's identity
// here: clientKey() in client-profiles.js builds the key the whole profile
// is addressed by out of the A-number, or out of the name when there is no
// A-number. Writing a new one into this table would leave the page showing
// one identity and the aggregation still grouping the hearing notes under
// the old one, which is worse than not being able to edit it. Correcting
// either needs a re-key, and a re-key needs to decide what happens to the
// notes, the documents, the Dropbox folder and any notice already sent --
// so it is its own job, not a text box.
const WRITABLE = ["phone", "address", "email", "language"];

async function set(clientKey, fields = {}, { source = "manual", sourceDetail = null, sourceDate = null, by = null } = {}) {
  await initTable();
  if (!clientKey) throw new Error("client_contacts: a client key is required");

  const cols = [], vals = [], sets = [];
  let i = 2;
  for (const key of WRITABLE) {
    if (fields[key] === undefined) continue;
    const v = String(fields[key] == null ? "" : fields[key]).trim() || null;
    cols.push(key); vals.push(v);
    sets.push(`${key} = $${i++}`);
  }
  if (!cols.length) return await get(clientKey);

  const meta = [source, sourceDetail, sourceDate, by];
  const metaCols = ["source", "source_detail", "source_date", "updated_by"];
  const metaSets = metaCols.map(c => `${c} = $${i++}`);

  await db().query(
    `INSERT INTO client_contacts (client_key, ${cols.join(", ")}, ${metaCols.join(", ")}, updated_at)
     VALUES ($1, ${cols.map((_, n) => "$" + (n + 2)).join(", ")}, ${metaCols.map((_, n) => "$" + (n + 2 + cols.length)).join(", ")}, NOW())
     ON CONFLICT (client_key) DO UPDATE SET ${sets.join(", ")}, ${metaSets.join(", ")}, updated_at = NOW()`,
    [clientKey, ...vals, ...meta]
  );
  return await get(clientKey);
}

/** Remove stored details — used to undo an import, never to tidy up. */
async function clear(clientKey) {
  await initTable();
  await db().query(`DELETE FROM client_contacts WHERE client_key = $1`, [clientKey]);
}

/**
 * Lay stored details over a client built from hearing notes.
 *
 * Stored wins where it has a value; the note-derived value shows through
 * where it does not. `contact_source` rides along so the page can say where
 * an address came from — a value read off an I-589 deserves to be labelled
 * as such rather than presented as though somebody confirmed it.
 */
function apply(client, row) {
  if (!row) return client;
  if (row.phone) client.client_phone = row.phone;
  if (row.address) client.client_address = row.address;
  if (row.email) client.client_email = row.email;
  if (row.language) client.client_language = row.language;
  if (row.phone || row.address || row.email || row.language) {
    client.contact_source = row.source || "manual";
    client.contact_source_detail = row.source_detail || null;
    client.contact_updated_at = row.updated_at || null;
  }
  return client;
}

module.exports = { initTable, get, all, set, clear, apply, WRITABLE };
