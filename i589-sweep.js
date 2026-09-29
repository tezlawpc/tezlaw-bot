// ============================================================
//  i589-sweep.js — FIND THE FORMS, PROPOSE, DO NOT WRITE
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  JJ chose: report first, then apply. So this writes nothing
//  to a client record. It reads folders, extracts item 8, and
//  files a PROPOSAL per client for review. Applying a proposal
//  is a separate, deliberate act.
//
//  WHY IT RUNS IN STAGES:
//    count   — list folders only. No downloads. Answers "how
//              many clients even have an I-589" cheaply, which
//              decides whether the review is 200 rows or 2,000.
//    extract — download and read, for a limited number of
//              clients. Start at 20: the first real run is the
//              only way to learn whether these PDFs are fillable
//              (reliable) or flattened scans (much less so).
//
//  Dropbox is rate-limited and 2,000 client folders is a lot of
//  calls, so every stage takes a limit and records where it got
//  to. Nothing here assumes it can finish in one request — it
//  cannot, and a half-finished sweep that lost its place would
//  be worse than none.
// ============================================================

const db = () => require("./db");
const x = require("./i589-extract");

let ready = null;
async function initTable() {
  if (ready) return ready;
  ready = (async () => {
    await db().query(`
      CREATE TABLE IF NOT EXISTS i589_proposals (
        client_key     TEXT PRIMARY KEY,
        client_name    TEXT,
        status         TEXT NOT NULL,   -- found | no_form | unreadable | error
        form_path      TEXT,
        form_modified  TIMESTAMPTZ,
        method         TEXT,            -- fields | text
        found_phone    TEXT,
        found_address  TEXT,
        partial        TEXT,
        notes          JSONB DEFAULT '[]'::jsonb,
        current_phone  TEXT,
        current_address TEXT,
        action         JSONB,           -- what decide() proposed
        applied_at     TIMESTAMPTZ,
        applied_by     TEXT,
        scanned_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db().query(
      `CREATE INDEX IF NOT EXISTS i589_proposals_status ON i589_proposals (status, scanned_at DESC)`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

/** Clients that have a Dropbox folder mapped, oldest-scanned first. */
async function clientsToScan({ limit = 20, rescan = false } = {}) {
  await initTable();
  const r = await db().query(
    `SELECT m.client_key, m.client_name, m.a_number, m.dropbox_path
       FROM client_dropbox_mapping m
       LEFT JOIN i589_proposals p ON p.client_key = m.client_key
      WHERE $2 = true OR p.client_key IS NULL
      ORDER BY m.client_key
      LIMIT $1`, [limit, !!rescan]);
  return r.rows;
}

/** How many clients are mapped, and how many already looked at. */
async function progress() {
  await initTable();
  const [mapped, done] = await Promise.all([
    db().query(`SELECT COUNT(*)::int AS n FROM client_dropbox_mapping`),
    db().query(`SELECT status, COUNT(*)::int AS n FROM i589_proposals GROUP BY status`),
  ]);
  const byStatus = {};
  for (const r of done.rows) byStatus[r.status] = r.n;
  const scanned = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return { mapped: mapped.rows[0].n, scanned, remaining: mapped.rows[0].n - scanned, byStatus };
}

/**
 * The client's current details, as the profile shows them.
 *
 * Stored contacts win; otherwise the newest hearing note that has a value,
 * which is exactly what aggregateClients() does. Matched on A-number when
 * there is one (an identifier) and on the name only otherwise — the same
 * order of trust used everywhere else in this codebase.
 */
async function currentFor({ client_key, client_name, a_number }) {
  const stored = await require("./client-contacts").get(client_key);
  if (stored && (stored.phone || stored.address)) {
    return { phone: stored.phone || "", address: stored.address || "" };
  }

  const digits = String(a_number || "").replace(/\D/g, "");
  const r = await db().query(
    `SELECT client_phone, client_address FROM (
       SELECT client_phone, client_address, a_number, client_name,
              COALESCE(hearing_date, created_at) AS at
         FROM hearing_notes
       UNION ALL
       SELECT client_phone, client_address, a_number, client_name,
              COALESCE(hearing_date, created_at) AS at
         FROM individual_hearing_notes
     ) t
      WHERE ($1 <> '' AND regexp_replace(COALESCE(a_number,''), '\\D', '', 'g') = $1)
         OR ($1 = '' AND LOWER(TRIM(COALESCE(client_name,''))) = LOWER($2))
      ORDER BY at DESC NULLS LAST`,
    [digits, String(client_name || "").trim()]);

  const phone = (r.rows.find(x => x.client_phone) || {}).client_phone || "";
  const address = (r.rows.find(x => x.client_address) || {}).client_address || "";
  return { phone, address };
}

/**
 * Look at one client: find their most recent I-589, read item 8, and file a
 * proposal. Never writes to the client record.
 */
async function scanOne(row, { current = {} } = {}) {
  await initTable();
  const dbx = require("./dropbox-integration");
  const out = { client_key: row.client_key, client_name: row.client_name, status: "no_form" };

  try {
    const entries = await dbx.listFolderDeep(row.dropbox_path);
    if (!entries) {
      out.status = "error";
      out.notes = ["the client's Dropbox folder could not be read"];
    } else {
      const files = entries
        .filter(e => e[".tag"] === "file")
        .map(e => ({ name: e.name, path: e.path_display, modified: e.server_modified }));
      const pick = x.pickMostRecent(files);
      if (!pick) {
        out.status = "no_form";
      } else {
        out.form_path = pick.path;
        out.form_modified = pick.modified;
        const buf = await dbx.downloadFile(pick.path);
        const read = await readPdf(buf);
        const got = x.extract(read);
        out.method = got.method;
        out.found_phone = got.phone || null;
        out.found_address = got.address || null;
        out.partial = got.partial || null;
        out.notes = got.notes || [];
        out.status = got.ok ? "found" : "unreadable";
      }
    }
  } catch (e) {
    out.status = "error";
    out.notes = [e.message];
  }

  out.current_phone = current.phone || null;
  out.current_address = current.address || null;
  out.action = (out.status === "found")
    ? x.decide({ current, found: { phone: out.found_phone, address: out.found_address } })
    : null;

  await db().query(
    `INSERT INTO i589_proposals
       (client_key, client_name, status, form_path, form_modified, method,
        found_phone, found_address, partial, notes, current_phone, current_address, action, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,NOW())
     ON CONFLICT (client_key) DO UPDATE SET
       client_name=$2, status=$3, form_path=$4, form_modified=$5, method=$6,
       found_phone=$7, found_address=$8, partial=$9, notes=$10::jsonb,
       current_phone=$11, current_address=$12, action=$13::jsonb, scanned_at=NOW()`,
    [out.client_key, out.client_name, out.status, out.form_path || null, out.form_modified || null,
     out.method || null, out.found_phone, out.found_address, out.partial,
     JSON.stringify(out.notes || []), out.current_phone, out.current_address,
     out.action ? JSON.stringify(out.action) : null]);

  return out;
}

/**
 * Read a PDF both ways: its form fields first, its text as a fallback.
 * Form fields are the trustworthy source on a fillable I-589 — they are read
 * rather than inferred — so they are tried first and the text is only there
 * for flattened or scanned files.
 */
async function readPdf(buf) {
  const out = { fields: null, text: "" };
  try {
    const { PDFDocument } = require("pdf-lib");
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const form = doc.getForm();
    out.fields = form.getFields().map(f => {
      let value = "";
      try { value = typeof f.getText === "function" ? (f.getText() || "") : ""; } catch { value = ""; }
      return { name: f.getName(), value };
    });
  } catch { /* not fillable, or not loadable as a form */ }
  try {
    // Page 1 only: item 8 is on it, and item 8 is all that is wanted.
    const parsed = await require("pdf-parse")(buf, { max: 1 });
    out.text = parsed.text || "";
  } catch { /* a scan with no text layer */ }
  return out;
}

module.exports = { initTable, clientsToScan, progress, currentFor, scanOne, readPdf };
