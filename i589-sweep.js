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
        method         TEXT,            -- fields | text | vision
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

/**
 * Clients to look at next.
 *
 * NOT from client_dropbox_mapping. That table is a lazy CACHE — a row appears
 * only once somebody has already opened that client's files — so reading it as
 * if it listed the firm's clients meant the sweep found almost nothing and
 * said so without explaining why. The roster is the hearing notes, the same
 * source the client list itself is built from.
 *
 * The folder is resolved per client as we go, and resolving caches itself, so
 * the mapping table fills in as a side effect rather than being a prerequisite.
 */
/**
 * Statuses worth a second look.
 *
 * The sweep skips anything it has already looked at, which is right for a
 * long job that resumes — but it means a row that failed under an old reader
 * is never tried again under a better one. When scanned pages started being
 * read by looking at them, every row the text reader had already given up on
 * stayed "unreadable" forever, and pressing Scan appeared to do nothing.
 *
 * no_form and no_folder are NOT here: nothing was read because nothing was
 * found, and re-reading cannot change that. Use "Start over" for those.
 */
const RETRY_STATUSES = new Set(["unreadable", "error"]);

async function clientsToScan({ limit = 20, rescan = false, retry = false } = {}) {
  await initTable();
  const r = await db().query(
    `SELECT t.client_name, t.a_number, MAX(t.at) AS at
       FROM (
         SELECT client_name, a_number, COALESCE(hearing_date, created_at) AS at
           FROM hearing_notes WHERE client_name IS NOT NULL AND client_name <> ''
         UNION ALL
         SELECT client_name, a_number, COALESCE(hearing_date, created_at) AS at
           FROM individual_hearing_notes WHERE client_name IS NOT NULL AND client_name <> ''
       ) t
      GROUP BY t.client_name, t.a_number
      ORDER BY MAX(t.at) DESC NULLS LAST`);

  const { clientKey } = require("./client-profiles");
  const seen = new Set();
  const out = [];
  for (const row of r.rows) {
    const key = clientKey({ aNumber: row.a_number, clientName: row.client_name });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ client_key: key, client_name: row.client_name, a_number: row.a_number });
  }

  if (rescan) return out.slice(0, limit);

  const already = (await db().query(`SELECT client_key, status FROM i589_proposals`)).rows;

  if (retry) {
    // Only the ones a previous pass could not read, in roster order so the
    // most recent clients are re-read first.
    const again = new Set(already.filter(r => RETRY_STATUSES.has(r.status)).map(r => r.client_key));
    return out.filter(c => again.has(c.client_key)).slice(0, limit);
  }

  // Skip the ones already looked at.
  const done = new Set(already.map(r => r.client_key));
  return out.filter(c => !done.has(c.client_key)).slice(0, limit);
}

/** How many rows a re-read could still change. Drives the retry button. */
async function retryableCount() {
  await initTable();
  const r = await db().query(
    `SELECT COUNT(*)::int AS n FROM i589_proposals WHERE status = ANY($1) AND applied_at IS NULL`,
    [[...RETRY_STATUSES]]);
  return r.rows[0].n;
}

/** How many clients there are in total, for the progress line. */
async function clientCount() {
  const all = await clientsToScan({ limit: 1e9, rescan: true });
  return all.length;
}

/** How many clients are mapped, and how many already looked at. */
async function progress() {
  await initTable();
  const [total, done, retryable] = await Promise.all([
    clientCount(),
    db().query(`SELECT status, COUNT(*)::int AS n FROM i589_proposals GROUP BY status`),
    retryableCount(),
  ]);
  const byStatus = {};
  for (const r of done.rows) byStatus[r.status] = r.n;
  const rows = Object.values(byStatus).reduce((a, b) => a + b, 0);

  // "Looked at" used to be every row in the proposals table, which produced
  // 237 looked at against 94 clients — impossible, and it made the remaining
  // count zero so the page claimed the job was finished. The extra rows are
  // real but they are leftovers from the first version of this sweep, which
  // read the Dropbox mapping cache as if it were the client roster and
  // produced keys no current client has.
  //
  // So the two populations are counted separately and both are reported. A
  // number that cannot be reconciled with the one next to it is worse than no
  // number at all.
  const inRoster = await db().query(
    `SELECT COUNT(*)::int AS n FROM i589_proposals p
      WHERE EXISTS (SELECT 1 FROM (
        SELECT client_name, a_number FROM hearing_notes
        UNION ALL SELECT client_name, a_number FROM individual_hearing_notes
      ) t WHERE p.client_name = t.client_name)`);
  const scanned = Math.min(inRoster.rows[0].n, total);

  return {
    mapped: total,
    scanned,
    remaining: Math.max(0, total - scanned),
    stale: Math.max(0, rows - scanned),   // rows from the old mapping-based sweep
    rows,
    byStatus,
    retryable,
  };
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
    // The folder may never have been resolved for this client. Resolving
    // caches itself, so the first sweep also fills in the mapping table.
    let folder = row.dropbox_path;
    if (!folder) {
      folder = await dbx.resolveClientFolder({
        clientKey: row.client_key, clientName: row.client_name, aNumber: row.a_number });
    }
    if (!folder) {
      out.status = "no_folder";
      out.notes = ["no Dropbox folder could be found for this client"];
      throw { __handled: true };
    }
    const entries = await dbx.listFolderDeep(folder);
    if (!entries) {
      out.status = "error";
      out.notes = ["the client's Dropbox folder could not be read"];
    } else {
      const files = entries
        .filter(e => e[".tag"] === "file")
        .map(e => ({ name: e.name, path: e.path_display, modified: e.server_modified }));
      // Several files in a folder can look like the form, and the newest match
      // is often not it: "updated I-589 and Statement.pdf" turned out to hold
      // the supplement and the statement while the base form sat beside it
      // under another name. So take an ordered list and try them in turn.
      const picks = x.rankCandidates(files);
      if (!picks.length) {
        out.status = "no_form";
      } else {
        let got = null;
        for (const pick of picks) {
          out.form_path = pick.path;
          out.form_modified = pick.modified;

          const buf = await dbx.downloadFile(pick.path);
          const read = await readPdf(buf);
          let one = x.extract(read);

          // Most of the firm's I-589s are SCANS: an image of each page, with
          // no form fields and no text layer. Both readers above find nothing
          // on one, which is why the first real sweep came back with a single
          // readable row. When they come up empty, look at the pages instead.
          if (!one.ok) {
            const seen = await require("./i589-vision").readItem8(buf);
            // Prefer the vision read when it actually read something. If it
            // did not, still prefer it when the earlier attempts had nothing
            // at all to show — its note explains why, where "item 8 heading
            // not found" only describes a scan without saying so.
            if (seen.ok || !one.partial) one = seen;
          }

          got = one;
          if (one.ok) break;        // found the form; stop paying for the rest
        }

        // When more than one was tried and none worked, say so — otherwise the
        // row reads as though a single file failed, and somebody goes looking
        // for a file that was already checked.
        const extra = (picks.length > 1 && got && !got.ok)
          ? [`tried ${picks.length} files in this folder`] : [];

        out.method = got.method;
        out.found_phone = got.phone || null;
        out.found_address = got.address || null;
        out.partial = got.partial || null;
        out.notes = (got.notes || []).concat(extra);
        out.status = got.ok ? "found" : "unreadable";
      }
    }
  } catch (e) {
    if (!(e && e.__handled)) {
      out.status = "error";
      out.notes = [e.message];
    }
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
 * Read a PDF both cheap ways: its form fields first, its text as a fallback.
 * Form fields are the trustworthy source on a fillable I-589 — they are read
 * rather than inferred — so they are tried first, and the text layer is there
 * for a flattened file that was still produced digitally.
 *
 * Neither works on a scan. That case is handled by i589-vision.js, which
 * scanOne falls back to; it is not here because it costs a model call and
 * should only happen once these two have failed.
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

/**
 * Every file in one client's Dropbox folder, with the score the ranker gave
 * each name and the reason it was or was not tried.
 *
 * WHY THIS EXISTS, so it does not get deleted as a debugging leftover:
 * 180 clients came back "no I-589", and twice now the matching rules have
 * been widened by inferring the firm's naming conventions from the five or
 * six filenames that happened to be visible. Both guesses were wrong, and
 * the second one started reading a folder's payment receipts as the form.
 * There is no way to tell a client who genuinely has no I-589 on file from
 * one whose form is simply named something unrecognised without looking at
 * the real filenames. This shows them.
 *
 * Read-only by design: it resolves the folder and lists names. It downloads
 * no file, calls no model, and writes nothing to i589_proposals — so it can
 * be run on a client whose proposal has already been applied without
 * disturbing anything.
 */
async function inspectFolder(client = {}) {
  const dbx = require("./dropbox-integration");
  const out = {
    client_key: client.client_key,
    client_name: client.client_name,
    folder: null,
    files: [],
    candidates: [],
    error: null,
  };

  try {
    const folder = client.dropbox_path || await dbx.resolveClientFolder({
      clientKey: client.client_key,
      clientName: client.client_name,
      aNumber: client.a_number,
    });
    if (!folder) {
      out.error = "no Dropbox folder could be found for this client";
      return out;
    }
    out.folder = folder;

    const entries = await dbx.listFolderDeep(folder);
    if (!entries) {
      out.error = "the folder could not be read";
      return out;
    }

    // EVERY file, not just the PDFs. A form saved as .jpg or inside a .zip is
    // a different problem from a form that is absent, and lumping the two
    // together is what made the 180 unreadable in the first place.
    const files = entries
      .filter(e => e[".tag"] === "file")
      .map(e => ({ name: e.name, path: e.path_display, modified: e.server_modified }));

    out.files = files
      .map(f => ({ ...f, score: x.scoreCandidate(f) }))
      .sort((a, b) =>
        b.score - a.score ||
        new Date(b.modified || 0) - new Date(a.modified || 0) ||
        String(a.name).localeCompare(String(b.name)));

    // Recomputed through the real ranker rather than re-derived here, so this
    // view cannot drift away from what the sweep would actually try.
    out.candidates = x.rankCandidates(files).map(f => f.path);
  } catch (err) {
    out.error = err && err.message ? err.message : String(err);
  }
  return out;
}

/**
 * The same listing for the first N clients in a given status — which is how
 * you look at a bucket of 180 without clicking through 180 rows.
 */
async function inspectStatus({ status = "no_form", limit = 10 } = {}) {
  await initTable();
  const keys = (await db().query(
    `SELECT client_key, client_name FROM i589_proposals
      WHERE status = $1
      ORDER BY scanned_at DESC NULLS LAST
      LIMIT $2`, [status, Math.max(1, Math.min(50, Number(limit) || 10))])).rows;

  const roster = await clientsToScan({ limit: 100000, rescan: true });
  const byKey = new Map(roster.map(c => [c.client_key, c]));

  const out = [];
  for (const k of keys) {
    const c = byKey.get(k.client_key) || { client_key: k.client_key, client_name: k.client_name };
    out.push(await inspectFolder(c));
  }
  return out;
}

module.exports = {
  initTable, clientsToScan, clientCount, progress, currentFor, scanOne, readPdf,
  retryableCount, RETRY_STATUSES, inspectFolder, inspectStatus,
};
