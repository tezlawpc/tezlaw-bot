// ============================================================
//  uscis-drafts.js — a part-filled USCIS form, kept between visits
//  ─────────────────────────────────────────────────────────
//  "each question should be saved after client fills them out in case if
//   its closed or crashed accidently." (JJ, 2026-10-09)
//
//  WHY A ROW PER FORM AND NOT A SESSION
//  The G-28 page before this held nothing. Every value on it was
//  recomputed from the client record on each request and anything typed
//  survived exactly one POST. That is tolerable for a page an attorney
//  fills in two minutes. It is not tolerable for an I-589 or an N-400,
//  which a client fills over several evenings, on a phone, and abandons
//  halfway through more often than not.
//
//  ONE FIELD PER WRITE. saveAnswer writes a single key with jsonb_set
//  rather than replacing the answers object. Two reasons, both of which
//  have teeth:
//
//    - A client on a train loses the field they were typing, never the
//      forty before it. Sending the whole object back on every keystroke
//      means a half-loaded page can overwrite good answers with blanks.
//    - The same draft is open in the office and at the client's kitchen
//      table more often than anyone plans for. Whole-object writes make
//      that last-write-wins across every field at once; per-field writes
//      make it last-write-wins per field, which is the worst case people
//      actually expect.
//
//  AN EMPTY ANSWER IS AN ANSWER. "" is stored, not deleted. A client who
//  clears a box that was prefilled from the client record is telling us
//  the record is wrong, and a prefill that silently comes back on the
//  next page load is how a form gets filed with a stale address on it.
//  uscis-g28.js applyEdits already works this way; this matches it.
//
//  WHAT THIS IS NOT. It is not a filing, and the status column is not a
//  workflow engine. 'draft' means somebody is filling it in, 'ready'
//  means a person has reviewed it, 'filed' is a note to the file. Nothing
//  here produces a PDF -- uscis-g28.js does that, from answers this hands
//  it, and only when a person asks.
// ============================================================

const db = () => require("./db");

const STATUSES = ["draft", "ready", "filed"];

let ready = null;
async function initTable() {
  if (ready) return ready;
  ready = (async () => {
    await db().query(`
      CREATE TABLE IF NOT EXISTS client_form_drafts (
        id           SERIAL PRIMARY KEY,
        client_key   TEXT NOT NULL,
        client_name  TEXT,
        form_id      TEXT NOT NULL,
        -- The matter this form is filed under, so it shows on that matter
        -- and the time can be billed against it. Null until attached.
        matter_id    TEXT,
        label        TEXT,
        answers      JSONB NOT NULL DEFAULT '{}'::jsonb,
        status       TEXT  NOT NULL DEFAULT 'draft',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        created_by   TEXT,
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_by   TEXT
      )
    `);
    // A client can have two of the same form -- an I-130 per relative --
    // so there is no unique key on (client_key, form_id) on purpose.
    await db().query(`
      CREATE INDEX IF NOT EXISTS client_form_drafts_client
        ON client_form_drafts (client_key, updated_at DESC)`);
    await db().query(`
      CREATE INDEX IF NOT EXISTS client_form_drafts_matter
        ON client_form_drafts (matter_id) WHERE matter_id IS NOT NULL`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

/** Start a form for a client. Returns the new row. */
async function start({ clientKey, clientName = null, formId, matterId = null, label = null, by = null } = {}) {
  await initTable();
  if (!clientKey) throw new Error("uscis-drafts: a client key is required");
  if (!formId) throw new Error("uscis-drafts: a form id is required");
  const r = await db().query(
    `INSERT INTO client_form_drafts (client_key, client_name, form_id, matter_id, label, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING *`,
    [clientKey, clientName, String(formId).toLowerCase(), matterId, label, by]
  );
  return r.rows[0];
}

async function get(id) {
  await initTable();
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  const r = await db().query(`SELECT * FROM client_form_drafts WHERE id = $1`, [n]);
  return r.rows[0] || null;
}

/** Every form on one client's file, newest touched first. */
async function listFor(clientKey) {
  await initTable();
  const r = await db().query(
    `SELECT * FROM client_form_drafts WHERE client_key = $1 ORDER BY updated_at DESC`,
    [clientKey]
  );
  return r.rows;
}

/** Every form attached to one matter. */
async function listForMatter(matterId) {
  await initTable();
  if (!matterId) return [];
  const r = await db().query(
    `SELECT * FROM client_form_drafts WHERE matter_id = $1 ORDER BY updated_at DESC`,
    [String(matterId)]
  );
  return r.rows;
}

/**
 * Save ONE answer.
 *
 * This is what the autosave calls, once per field, as the person leaves it.
 * jsonb_set touches that key and leaves every other answer alone, so a
 * stale page cannot post a blank object over a filled form. An empty
 * string is stored rather than removed -- see the header.
 */
async function saveAnswer(id, key, value, { by = null } = {}) {
  await initTable();
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw new Error("uscis-drafts: a draft id is required");
  const k = String(key || "").trim();
  if (!k) throw new Error("uscis-drafts: an answer needs a key");
  // A key is a field name, not a path. A dot in it is part of the name
  // ("attorney.family_name"), so it goes in as one element of a
  // single-element path and never splits into nested objects.
  const r = await db().query(
    `UPDATE client_form_drafts
     SET answers    = jsonb_set(COALESCE(answers, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text), true),
         updated_at = NOW(),
         updated_by = COALESCE($4, updated_by)
     WHERE id = $1
     RETURNING id, updated_at`,
    [n, k, String(value == null ? "" : value), by]
  );
  if (!r.rows.length) throw new Error("uscis-drafts: no such draft");
  return r.rows[0];
}

/**
 * Save several answers in one statement.
 *
 * For a page that posts a whole section at once. Still per-key underneath:
 * the keys given are merged over what is stored, and keys NOT given are
 * left alone, so this can never blank a field the caller did not mention.
 */
async function saveAnswers(id, answers = {}, { by = null } = {}) {
  await initTable();
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) throw new Error("uscis-drafts: a draft id is required");
  const clean = {};
  for (const [k, v] of Object.entries(answers)) {
    const key = String(k || "").trim();
    if (key) clean[key] = String(v == null ? "" : v);
  }
  if (!Object.keys(clean).length) return await get(n);
  const r = await db().query(
    `UPDATE client_form_drafts
     SET answers    = COALESCE(answers, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW(),
         updated_by = COALESCE($3, updated_by)
     WHERE id = $1
     RETURNING *`,
    [n, JSON.stringify(clean), by]
  );
  if (!r.rows.length) throw new Error("uscis-drafts: no such draft");
  return r.rows[0];
}

async function setStatus(id, status, { by = null } = {}) {
  await initTable();
  const s = String(status || "").toLowerCase();
  if (!STATUSES.includes(s)) throw new Error(`uscis-drafts: unknown status ${s}`);
  const r = await db().query(
    `UPDATE client_form_drafts SET status = $2, updated_at = NOW(), updated_by = COALESCE($3, updated_by)
     WHERE id = $1 RETURNING *`,
    [parseInt(id, 10), s, by]
  );
  return r.rows[0] || null;
}

/** Attach the form to a matter, so it shows on that matter's file. */
async function attachToMatter(id, matterId, { by = null } = {}) {
  await initTable();
  const r = await db().query(
    `UPDATE client_form_drafts SET matter_id = $2, updated_at = NOW(), updated_by = COALESCE($3, updated_by)
     WHERE id = $1 RETURNING *`,
    [parseInt(id, 10), matterId ? String(matterId) : null, by]
  );
  return r.rows[0] || null;
}

/** Delete a draft. Only a draft: a form marked filed is a record. */
async function remove(id) {
  await initTable();
  const r = await db().query(
    `DELETE FROM client_form_drafts WHERE id = $1 AND status <> 'filed' RETURNING id`,
    [parseInt(id, 10)]
  );
  return !!r.rows.length;
}

/** How much of a form has been answered, for a progress line. */
function progress(draft, questions = []) {
  const a = (draft && draft.answers) || {};
  const asked = questions.filter((q) => !q.readonly);
  const done = asked.filter((q) => String(a[q.key] == null ? "" : a[q.key]).trim() !== "").length;
  return { done, total: asked.length, pct: asked.length ? Math.round((done / asked.length) * 100) : 0 };
}

module.exports = {
  STATUSES, initTable, start, get, listFor, listForMatter,
  saveAnswer, saveAnswers, setStatus, attachToMatter, remove, progress,
};
