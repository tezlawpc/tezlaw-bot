// ============================================================
//  TEZ LAW P.C. — CIVIL LITIGATION ⇄ DROPBOX SYNC  (build 39)
//  ─────────────────────────────────────────────────────────
//  Keeps each civil matter's Dropbox folder mirrored into the
//  database so the case file is browsable from the web admin
//  and the app without hitting Dropbox on every page load.
//
//  How it differs from dropbox-integration.js:
//    · That module maps ONE folder per CLIENT, keyed on
//      A-number — right for immigration, wrong here. A civil
//      client can have several matters, each with its own
//      folder, and civil matters have case numbers, not
//      A-numbers.
//    · This module maps one folder per CASE
//      (civil_cases.dropbox_path) and keeps a file-level
//      mirror in civil_case_files.
//
//  Cheap re-sync: Dropbox hands back a cursor with every
//  listing. We store it per case and call list_folder/continue
//  on later syncs, so an hourly run over an unchanged folder
//  costs one API call and returns zero entries. Full re-listing
//  only happens on first sync or when a cursor is invalidated.
//
//  Every file is filed into a litigation category derived from
//  its subfolder and filename, so "show me the discovery in
//  this matter" works without anyone tagging anything by hand.
// ============================================================

const db = require("./db");
const dbx = require("./dropbox-integration");

// ═══════════════════════════════════════════════════════════
//  DOCUMENT CATEGORIES
//  Ordered: the first match wins, so the more specific
//  patterns are listed before the looser ones.
// ═══════════════════════════════════════════════════════════

const DOC_CATEGORIES = [
  { key: "pleadings",      label: "Pleadings",       color: "#D97706",
    patterns: [/\bcomplaint\b/, /\banswer\b/, /\bdemurrer\b/, /cross[- ]?complaint/, /\bsummons\b/,
               /proof of service/, /\bpos\b/, /motion to strike/, /\bpetition\b/, /\bcaption\b/] },
  { key: "discovery",      label: "Discovery",       color: "#0284C7",
    patterns: [/\brogs?\b/, /interrogator/, /\brfps?\b/, /request.{0,12}production/,
               /\brfas?\b/, /request.{0,12}admission/, /meet.{0,3}(and|&).{0,3}confer/,
               /\bsubpoena\b/, /\bsdt\b/, /responses? to/, /\bverification\b/, /privilege log/] },
  { key: "depositions",    label: "Depositions",     color: "#7C3AED",
    patterns: [/\bdepo(sition)?\b/, /\btranscript\b/, /\berrata\b/, /\bpmk\b/, /\bpmq\b/] },
  { key: "motions",        label: "Motion Practice", color: "#6D28D9",
    patterns: [/\bmsj\b/, /summary judgment/, /motion in limine/, /\bmil\b/, /\bopposition\b/,
               /\breply\b/, /\bmemorandum\b/, /\bp&a\b/, /points and authorities/,
               /\bdeclaration\b/, /\bdecl\b/, /motion to compel/, /\bmtc\b/, /\bex parte\b/] },
  { key: "court_orders",   label: "Orders & Rulings", color: "#991B1B",
    patterns: [/\border\b/, /\bruling\b/, /minute order/, /\bjudgment\b/, /notice of ruling/,
               /\btentative\b/, /\bwrit\b/, /\bremittitur\b/] },
  { key: "settlement",     label: "Settlement",      color: "#166534",
    patterns: [/\bsettle/, /\b998\b/, /\bmediation\b/, /\bmsc\b/, /\brelease\b/,
               /\bstipulation\b/, /\bstip\b/, /\bdemand\b/] },
  { key: "experts",        label: "Experts",         color: "#B8891E",
    patterns: [/\bexpert\b/, /\bcv\b/, /\bvitae\b/, /expert report/, /\bdesignation\b/] },
  { key: "evidence",       label: "Evidence",        color: "#7B5330",
    patterns: [/\bexhibit\b/, /\bphoto/, /\brecords?\b/, /\bmedical\b/, /\bbilling record/,
               /\bestimate\b/, /\bappraisal\b/, /\bcontract\b/, /\bagreement\b/, /\bdeed\b/,
               /\blease\b/, /\binvoice\b/] },
  { key: "correspondence", label: "Correspondence",  color: "#5A3B22",
    patterns: [/\bletter\b/, /\bltr\b/, /\bcorrespond/, /\bemail\b/, /\be-?mail\b/, /\bmemo\b/] },
  { key: "billing",        label: "Billing & Trust", color: "#E0B44E",
    patterns: [/\bretainer\b/, /\bfee agreement\b/, /\bledger\b/, /\btrust\b/, /\biolta\b/,
               /\bstatement\b/, /\bbilling\b/] },
  { key: "client_docs",    label: "Client Documents", color: "#8B7355",
    patterns: [/\bintake\b/, /\bengagement\b/, /\bid\b/, /\bpassport\b/, /\bdl\b/,
               /\bauthorization\b/, /\bquestionnaire\b/] },
  { key: "other",          label: "Uncategorized",   color: "#4B5563", patterns: [] },
];

const CATEGORY_KEYS = new Set(DOC_CATEGORIES.map(c => c.key));

// A folder named after the category itself is the commonest convention by
// far ("Pleadings/", "Discovery/", "Motions/"), and the content patterns
// below don't contain those words, so match the category name first.
// Singular or plural both count: "Pleading" and "Pleadings" are the same.
const CATEGORY_NAME_RE = DOC_CATEGORIES
  .filter(c => c.key !== "other")
  .map(c => {
    const stem = c.key.replace(/_/g, "[ _-]?").replace(/s$/, "");
    return { key: c.key, re: new RegExp("(^|[^a-z])" + stem + "s?([^a-z]|$)", "i"),
             label: c.label.toLowerCase() };
  });

// Classify on the folder path first — a file sitting in a "Discovery"
// subfolder is discovery even if its name is "Draft3_final.docx" — then
// fall back to the filename.
function categorizeFile(fileName, relativeFolder = "") {
  const folder = String(relativeFolder || "").toLowerCase();
  const name = String(fileName || "").toLowerCase();

  // 1. Folder named for the category outright.
  if (folder) {
    for (const c of CATEGORY_NAME_RE) {
      if (c.re.test(folder) || folder.includes(c.label)) return c.key;
    }
    // 2. Folder whose name matches a content pattern.
    for (const cat of DOC_CATEGORIES) {
      if (!cat.patterns.length) continue;
      if (cat.patterns.some(p => p.test(folder))) return cat.key;
    }
  }

  // 3. Filename named for the category, then by content pattern.
  for (const c of CATEGORY_NAME_RE) {
    if (c.re.test(name)) return c.key;
  }
  for (const cat of DOC_CATEGORIES) {
    if (!cat.patterns.length) continue;
    if (cat.patterns.some(p => p.test(name))) return cat.key;
  }
  return "other";
}

// ═══════════════════════════════════════════════════════════
//  SCHEMA
// ═══════════════════════════════════════════════════════════

async function initTables() {
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS dropbox_path TEXT`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS dropbox_cursor TEXT`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS dropbox_synced_at TIMESTAMPTZ`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS dropbox_sync_error TEXT`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS dropbox_file_count INTEGER DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS files_archived_at TIMESTAMPTZ`).catch(() => {});
  // Remembered so un-archiving can put the matter back where it was.
  await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS stage_before_archive TEXT`).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_case_files (
      id                SERIAL PRIMARY KEY,
      case_id           INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      dropbox_id        TEXT,
      path_lower        TEXT NOT NULL,
      path_display      TEXT,
      name              TEXT,
      relative_folder   TEXT,
      category          TEXT DEFAULT 'other',
      size_bytes        BIGINT,
      rev               TEXT,
      content_hash      TEXT,
      client_modified   TIMESTAMPTZ,
      server_modified   TIMESTAMPTZ,
      archived          BOOLEAN DEFAULT FALSE,
      first_seen_at     TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at      TIMESTAMPTZ DEFAULT NOW(),
      removed_at        TIMESTAMPTZ
    )
  `);
  // One row per physical file per case. Re-syncing upserts on this.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_civil_files_case_path
                  ON civil_case_files (case_id, path_lower)`).catch(() => {});
  // Which lifecycle phase produced this document, so each stage workspace can
  // show its own file set instead of the whole matter folder.
  await db.query(`ALTER TABLE civil_case_files ADD COLUMN IF NOT EXISTS phase TEXT`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_files_phase
                  ON civil_case_files (case_id, phase) WHERE removed_at IS NULL`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_files_case_cat
                  ON civil_case_files (case_id, category) WHERE removed_at IS NULL`).catch(() => {});

  // Roots live in the database, not an env var: getting this wrong sends the
  // sync into the wrong practice area, and fixing it should not need a deploy.
  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_dropbox_settings (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      roots       TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_by  TEXT,
      CONSTRAINT civil_dbx_single_row CHECK (id = 1)
    )
  `).catch(() => {});
  await db.query(`INSERT INTO civil_dropbox_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`).catch(() => {});

  await backfillArchivedStages();
}

// Cases archived before archiving moved a matter to Closed kept whatever stage
// they were sitting in, so they stayed on the board looking active. Sweep them
// into Closed once — guarded by a settings flag so a matter deliberately
// re-opened later is never dragged back on the next boot.
let _archiveBackfillChecked = false;
async function backfillArchivedStages() {
  if (_archiveBackfillChecked) return;
  _archiveBackfillChecked = true;
  try {
    await db.query(
      `ALTER TABLE civil_dropbox_settings
         ADD COLUMN IF NOT EXISTS archive_stage_backfill_at TIMESTAMPTZ`
    );
    const done = await db.query(
      `SELECT archive_stage_backfill_at FROM civil_dropbox_settings WHERE id = 1`
    );
    if (done.rows[0] && done.rows[0].archive_stage_backfill_at) return;

    const r = await db.query(
      `UPDATE civil_cases
          SET stage_before_archive = COALESCE(stage_before_archive, stage),
              stage = 'closed',
              updated_at = NOW()
        WHERE files_archived_at IS NOT NULL
          AND COALESCE(stage, '') <> 'closed'
        RETURNING id`
    );
    await db.query(
      `UPDATE civil_dropbox_settings SET archive_stage_backfill_at = NOW() WHERE id = 1`
    );
    if (r.rowCount) {
      console.log(`[civil-dropbox] backfill: moved ${r.rowCount} archived matter(s) to Closed`);
    }
  } catch (e) {
    console.warn("[civil-dropbox] archive-stage backfill skipped:", e.message);
  }
}

// ═══════════════════════════════════════════════════════════
//  FOLDER MAPPING
// ═══════════════════════════════════════════════════════════

// Manual link — the attorney pastes the Dropbox folder path (or a
// share link, which we reduce to a path).
async function setCaseFolder(caseId, dropboxPath) {
  await initTables();
  const path = normalizePath(dropboxPath);
  if (!path) throw new Error("A Dropbox folder path is required");
  // Changing the folder invalidates the cursor — the next sync re-lists.
  const r = await db.query(
    `UPDATE civil_cases
        SET dropbox_path = $1, dropbox_cursor = NULL, dropbox_sync_error = NULL, updated_at = NOW()
      WHERE id = $2
      RETURNING id, dropbox_path`,
    [path, caseId]
  );
  if (!r.rows.length) throw new Error("Case not found");
  return r.rows[0];
}

async function clearCaseFolder(caseId) {
  await initTables();
  await db.query(
    `UPDATE civil_cases
        SET dropbox_path = NULL, dropbox_cursor = NULL, dropbox_synced_at = NULL,
            dropbox_sync_error = NULL, dropbox_file_count = 0, updated_at = NOW()
      WHERE id = $1`,
    [caseId]
  );
  await db.query(`DELETE FROM civil_case_files WHERE case_id = $1`, [caseId]);
  return { ok: true };
}

// Accepts a bare path, a path with a leading slash, or a Dropbox share
// URL, and returns the "/Folder/Sub" form the API expects.
function normalizePath(input) {
  let p = String(input || "").trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      // .../scl/fo/xxxx/Folder%20Name?... or /home/Folder
      const parts = u.pathname.split("/").filter(Boolean);
      const home = parts.indexOf("home");
      if (home >= 0) p = "/" + parts.slice(home + 1).join("/");
      else p = "/" + decodeURIComponent(parts[parts.length - 1] || "");
    } catch (e) { /* fall through and treat as a path */ }
  }
  p = decodeURIComponent(p).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  return p === "/" ? null : p;
}

// Roots to scan. CIVIL_DROPBOX_ROOTS lets civil folders live somewhere
// separate from the immigration branches (mirroring PI_DROPBOX_ROOTS);
// otherwise fall back to the shared branch roots, and finally to the
// Dropbox root itself so a firm with no roots configured still gets matches.
async function getCivilRoots() {
  // 1. Explicitly configured in the UI — the only source that is unambiguous.
  try {
    const r = await db.query(`SELECT roots FROM civil_dropbox_settings WHERE id = 1`);
    const saved = (r.rows[0] && r.rows[0].roots || "").split(",").map(x => x.trim()).filter(Boolean);
    if (saved.length) return saved;
  } catch (e) { /* table may not exist yet */ }
  // 2. Env override.
  const envRoots = (process.env.CIVIL_DROPBOX_ROOTS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (envRoots.length) return envRoots;
  // 3. Shared branch roots — these are the IMMIGRATION branches, so this is a
  //    last resort and the caller flags it as unconfigured.
  const shared = dbx.getBranchRoots();
  if (shared.length) return shared;
  return [""];
}

// True when we are falling back to immigration branches rather than using
// roots chosen for civil. The console warns loudly in that state.
async function rootsAreConfigured() {
  try {
    const r = await db.query(`SELECT roots FROM civil_dropbox_settings WHERE id = 1`);
    if ((r.rows[0] && r.rows[0].roots || "").trim()) return true;
  } catch (e) { /* ignore */ }
  return !!(process.env.CIVIL_DROPBOX_ROOTS || "").trim();
}

async function setCivilRoots(roots, by) {
  await initTables();
  const list = (Array.isArray(roots) ? roots : String(roots || "").split(","))
    .map(x => normalizePath(x)).filter(Boolean);
  await db.query(
    `UPDATE civil_dropbox_settings SET roots = $1, updated_at = NOW(), updated_by = $2 WHERE id = 1`,
    [list.join(","), by || null]
  );
  return { ok: true, roots: list };
}

// Browse Dropbox folders so the right root can be picked by clicking rather
// than typed from memory.
async function browseFolders(path = "") {
  if (!dbx.isConfigured()) throw new Error("Dropbox is not connected");
  const p = path ? normalizePath(path) : "";
  const entries = await dbx.listFolder(p || "");
  if (!entries) throw new Error("Folder not found: " + (p || "(root)"));
  const folders = entries.filter(e => e[".tag"] === "folder")
    .map(e => ({ name: e.name, path: e.path_display }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fileCount = entries.filter(e => e[".tag"] === "file").length;
  return { path: p || "", parent: p ? (p.split("/").slice(0, -1).join("/") || "") : null, folders, file_count: fileCount };
}

// Undo a bad bulk import: unlink every case and drop the mirrored rows.
// Nothing in Dropbox is touched.
async function unlinkAll({ onlyUnderRoot = null } = {}) {
  await initTables();
  const vals = [];
  let where = "dropbox_path IS NOT NULL";
  if (onlyUnderRoot) { where += " AND dropbox_path ILIKE $1"; vals.push(normalizePath(onlyUnderRoot) + "%"); }
  const r = await db.query(`SELECT id FROM civil_cases WHERE ${where}`, vals);
  for (const row of r.rows) await clearCaseFolder(row.id);
  return { ok: true, unlinked: r.rows.length };
}

// Civil case names are adversarial ("Nguyen v. Pacific Holdings LLC"), so the
// party names are the signal and the connective tissue is noise. Strip the
// entity suffixes and "v." so "Nguyen" still matches a "Nguyen" folder.
const CIVIL_STOPWORDS = new Set([
  "v", "vs", "versus", "et", "al", "llc", "inc", "corp", "corporation",
  "company", "co", "ltd", "lp", "llp", "plc", "trust", "estate",
  "matter", "matters", "civil", "litigation", "lawsuit", "action",
]);

function civilTokens(text) {
  return dbx.nameTokens(text).filter(t => !CIVIL_STOPWORDS.has(t));
}

// Auto-match a case to a folder by client name + case number, reusing the
// scoring already tuned for the immigration side.
async function suggestFolderForCase(caseId, { limit = 8, debug = false } = {}) {
  const c = await getCaseRow(caseId);
  if (!c) throw new Error("Case not found");

  const roots = await getCivilRoots();
  // Both the case caption and the client key are worth matching on: folders
  // are named after one or the other depending on who set them up.
  const captionTerms = civilTokens(c.case_name);
  const clientTerms = civilTokens(String(c.client_key || "").replace(/[-_]/g, " "));
  const digits = String(c.case_number || "").replace(/\D/g, "");

  const seen = [];
  const rootErrors = [];
  for (const root of roots) {
    let entries;
    try { entries = await dbx.listFolder(root); }
    catch (e) { rootErrors.push({ root, error: e.message }); continue; }
    if (!entries) { rootErrors.push({ root, error: "folder not found" }); continue; }

    for (const e of entries) {
      if (e[".tag"] !== "folder") continue;
      // scoreFolderMatch returns { score, reason } — not a bare number.
      const byCaption = captionTerms.length ? (dbx.scoreFolderMatch(e.name, captionTerms, null) || {}) : {};
      const byClient = clientTerms.length ? (dbx.scoreFolderMatch(e.name, clientTerms, null) || {}) : {};
      let score = Math.max(Number(byCaption.score) || 0, Number(byClient.score) || 0);
      let reason = (Number(byCaption.score) || 0) >= (Number(byClient.score) || 0)
        ? byCaption.reason : byClient.reason;

      // A case number in the folder name is the strongest signal there is —
      // stronger than any name overlap, and it alone is enough to match.
      if (digits.length >= 4 && String(e.name).replace(/\D/g, "").includes(digits)) {
        score += 80;
        reason = reason ? reason + " + case number" : "case number match";
      }
      if (score > 0) seen.push({ path: e.path_display, name: e.name, score, reason: reason || null });
    }
  }

  const ranked = seen.sort((a, b) => b.score - a.score).slice(0, limit);
  if (!debug) return ranked;
  return {
    suggestions: ranked,
    debug: {
      roots, root_errors: rootErrors,
      caption_terms: captionTerms, client_terms: clientTerms,
      case_number_digits: digits || null,
      folders_scanned: seen.length,
    },
  };
}

async function getCaseRow(caseId) {
  const r = await db.query(
    `SELECT id, case_name, client_key, case_number, status, stage,
            dropbox_path, dropbox_cursor, dropbox_synced_at, dropbox_file_count
       FROM civil_cases WHERE id = $1`,
    [caseId]
  );
  return r.rows[0] || null;
}

// ═══════════════════════════════════════════════════════════
//  SYNC
// ═══════════════════════════════════════════════════════════

// Walks a folder (or replays a cursor) and mirrors it into
// civil_case_files. Returns a summary of what changed.
async function syncCase(caseId, { force = false } = {}) {
  await initTables();
  if (!dbx.isConfigured()) throw new Error("Dropbox is not connected — authorize it in admin settings first");

  const c = await getCaseRow(caseId);
  if (!c) throw new Error("Case not found");
  if (!c.dropbox_path) return { ok: false, reason: "no_folder", case_id: caseId };

  const useCursor = !force && c.dropbox_cursor;
  let entries = [];
  let cursor = null;

  try {
    if (useCursor) {
      const res = await continueFrom(c.dropbox_cursor);
      entries = res.entries; cursor = res.cursor;
    } else {
      const res = await listRecursive(c.dropbox_path);
      entries = res.entries; cursor = res.cursor;
    }
  } catch (e) {
    // A reset cursor means Dropbox wants a full re-list; do it once here
    // rather than leaving the case stuck.
    if (/reset/i.test(e.message) && useCursor) {
      const res = await listRecursive(c.dropbox_path);
      entries = res.entries; cursor = res.cursor;
    } else {
      await db.query(
        `UPDATE civil_cases SET dropbox_sync_error = $1, dropbox_synced_at = NOW() WHERE id = $2`,
        [e.message.slice(0, 400), caseId]
      );
      throw e;
    }
  }

  const base = c.dropbox_path.toLowerCase();
  let added = 0, updated = 0, removed = 0;

  for (const e of entries) {
    if (e[".tag"] === "deleted") {
      const r = await db.query(
        `UPDATE civil_case_files SET removed_at = NOW()
          WHERE case_id = $1 AND path_lower = $2 AND removed_at IS NULL`,
        [caseId, String(e.path_lower || "").toLowerCase()]
      );
      removed += r.rowCount || 0;
      continue;
    }
    if (e[".tag"] !== "file") continue;

    const pathLower = String(e.path_lower || "").toLowerCase();
    // Subfolder path relative to the case root, used for categorisation.
    const rel = pathLower.startsWith(base)
      ? pathLower.slice(base.length).replace(/^\/+/, "").split("/").slice(0, -1).join("/")
      : "";
    const category = categorizeFile(e.name, rel);

    const r = await db.query(
      `INSERT INTO civil_case_files
         (case_id, dropbox_id, path_lower, path_display, name, relative_folder, category,
          size_bytes, rev, content_hash, client_modified, server_modified, phase, last_seen_at, removed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW(), NULL)
       ON CONFLICT (case_id, path_lower) DO UPDATE
         SET dropbox_id = EXCLUDED.dropbox_id,
             path_display = EXCLUDED.path_display,
             name = EXCLUDED.name,
             relative_folder = EXCLUDED.relative_folder,
             category = EXCLUDED.category,
             size_bytes = EXCLUDED.size_bytes,
             rev = EXCLUDED.rev,
             content_hash = EXCLUDED.content_hash,
             client_modified = EXCLUDED.client_modified,
             server_modified = EXCLUDED.server_modified,
             phase = EXCLUDED.phase,
             last_seen_at = NOW(),
             removed_at = NULL
       RETURNING (xmax = 0) AS inserted`,
      [
        caseId, e.id || null, pathLower, e.path_display || null, e.name || null,
        rel || null, category, e.size || null, e.rev || null, e.content_hash || null,
        e.client_modified || null, e.server_modified || null, phaseOfFile(e.name, rel),
      ]
    );
    if (r.rows[0] && r.rows[0].inserted) added++; else updated++;
  }

  const countR = await db.query(
    `SELECT COUNT(*)::int AS n FROM civil_case_files WHERE case_id = $1 AND removed_at IS NULL`,
    [caseId]
  );
  const total = countR.rows[0] ? countR.rows[0].n : 0;

  await db.query(
    `UPDATE civil_cases
        SET dropbox_cursor = $1, dropbox_synced_at = NOW(),
            dropbox_sync_error = NULL, dropbox_file_count = $2
      WHERE id = $3`,
    [cursor || null, total, caseId]
  );

  // Only log a timeline event when documents actually arrive — an hourly
  // no-op sync must not clutter the case history.
  if (added > 0) {
    try {
      const civil = require("./civil-litigation");
      await civil.logEvent(caseId, {
        event_kind: "note",
        event_date: new Date().toISOString().slice(0, 10),
        title: `${added} new document${added === 1 ? "" : "s"} in Dropbox`,
        description: `Synced from ${c.dropbox_path}`,
        created_by: "dropbox-sync",
      });
    } catch (e) { console.warn("[civil-dropbox] timeline event failed:", e.message); }
  }

  return { ok: true, case_id: caseId, folder: c.dropbox_path, added, updated, removed, total,
           mode: useCursor ? "delta" : "full" };
}

async function listRecursive(path) {
  const res = await dbx.dropboxApi("files/list_folder", {
    path, recursive: true, include_deleted: false, include_media_info: false,
  });
  const entries = [...res.entries];
  let cursor = res.cursor, hasMore = res.has_more;
  while (hasMore) {
    const more = await dbx.dropboxApi("files/list_folder/continue", { cursor });
    entries.push(...more.entries);
    cursor = more.cursor; hasMore = more.has_more;
  }
  return { entries, cursor };
}

async function continueFrom(startCursor) {
  const entries = [];
  let cursor = startCursor, hasMore = true;
  while (hasMore) {
    const res = await dbx.dropboxApi("files/list_folder/continue", { cursor });
    entries.push(...res.entries);
    cursor = res.cursor; hasMore = res.has_more;
  }
  return { entries, cursor };
}

// Sweep every mapped, non-archived case. Used by the scheduler and the
// "Sync all now" admin button. One bad folder never stops the run.
async function syncAll({ limit = 200, includeClosed = false } = {}) {
  await initTables();
  if (!dbx.isConfigured()) return { ok: false, reason: "dropbox_not_configured", results: [] };
  const r = await db.query(
    `SELECT id FROM civil_cases
      WHERE dropbox_path IS NOT NULL
        AND files_archived_at IS NULL
        ${includeClosed ? "" : "AND status = 'active'"}
      ORDER BY COALESCE(dropbox_synced_at, '1970-01-01') ASC
      LIMIT $1`,
    [limit]
  );
  const results = [];
  for (const row of r.rows) {
    try { results.push(await syncCase(row.id)); }
    catch (e) { results.push({ ok: false, case_id: row.id, error: e.message }); }
  }
  const added = results.reduce((a, x) => a + (x.added || 0), 0);
  return {
    ok: true, cases: results.length,
    added, removed: results.reduce((a, x) => a + (x.removed || 0), 0),
    failed: results.filter(x => !x.ok).length,
    results,
  };
}

// ═══════════════════════════════════════════════════════════
//  BULK IMPORT — match every civil case to a Dropbox folder
// ═══════════════════════════════════════════════════════════

// dryRun (the default) reports what WOULD be linked without writing
// anything, so the matching can be eyeballed before it touches data.
async function bulkImport({ dryRun = true, minScore = 60, sync = false } = {}) {
  await initTables();
  if (!dbx.isConfigured()) throw new Error("Dropbox is not connected");

  const r = await db.query(
    `SELECT id, case_name, client_key, case_number FROM civil_cases
      WHERE dropbox_path IS NULL AND status = 'active' ORDER BY updated_at DESC`
  );

  // Diagnostics first: "0 matched" is ambiguous between "no cases",
  // "no folders configured" and "nothing scored high enough".
  const roots = await getCivilRoots();
  const configured = await rootsAreConfigured();
  const totalCasesR = await db.query(`SELECT COUNT(*)::int AS n FROM civil_cases`);
  const totalCases = totalCasesR.rows[0] ? totalCasesR.rows[0].n : 0;
  let rootFolderCount = 0;
  const rootReport = [];
  for (const root of roots) {
    try {
      const entries = await dbx.listFolder(root);
      const n = entries ? entries.filter(e => e[".tag"] === "folder").length : 0;
      rootFolderCount += n;
      rootReport.push({ root: root || "(Dropbox root)", folders: n, ok: entries !== null });
    } catch (e) {
      rootReport.push({ root: root || "(Dropbox root)", folders: 0, ok: false, error: e.message });
    }
  }

  const diagnostics = {
    total_civil_cases: totalCases,
    cases_needing_a_folder: r.rows.length,
    roots_scanned: rootReport,
    folders_visible: rootFolderCount,
    roots_configured: configured,
    hint: !configured
      ? "No civil Dropbox root is set, so this scanned the shared immigration branches — which is why matches land in folders like /USCIS/ASYLUM_EOIR. Pick your civil folder under 'Civil Dropbox root' above before importing."
      : totalCases === 0
        ? "There are no civil cases in the database yet — create one first."
        : r.rows.length === 0
          ? "Every active case already has a folder linked."
          : rootFolderCount === 0
            ? "No folders were visible in the configured root. Check the path is right."
            : null,
  };

  const linked = [], ambiguous = [], unmatched = [];
  for (const c of r.rows) {
    let matches = [];
    try { matches = await suggestFolderForCase(c.id, { limit: 3 }); }
    catch (e) { unmatched.push({ ...c, error: e.message }); continue; }

    const best = matches[0];
    if (!best || best.score < minScore) { unmatched.push({ ...c, best: best || null }); continue; }
    // Two near-equal candidates means guessing would be a coin flip.
    if (matches[1] && (best.score - matches[1].score) < 15) {
      ambiguous.push({ ...c, candidates: matches });
      continue;
    }
    if (!dryRun && !configured) {
      // Applying against immigration branches is never what was wanted.
      unmatched.push({ ...c, best, blocked: "civil root not configured" });
      continue;
    }
    if (!dryRun) {
      await setCaseFolder(c.id, best.path);
      if (sync) { try { await syncCase(c.id); } catch (e) { /* reported by the sweep */ } }
    }
    linked.push({ case_id: c.id, case_name: c.case_name, folder: best.path, score: best.score });
  }
  return {
    ok: true, dry_run: dryRun,
    linked_count: linked.length, ambiguous_count: ambiguous.length, unmatched_count: unmatched.length,
    linked, ambiguous, unmatched, diagnostics,
  };
}

// ═══════════════════════════════════════════════════════════
//  IMPORT CASES *FROM* FOLDERS
//  The other direction from bulkImport(): there, cases already
//  exist and we hunt for their folders. Here the Dropbox folders
//  ARE the case list — each one becomes a civil case, and a
//  client record is created for it if none exists yet.
// ═══════════════════════════════════════════════════════════

// Folders that are plainly not matters. Anything here is reported as
// skipped rather than silently turned into a case.
const NON_CASE_FOLDERS = [
  /^_/, /^\./, /^templates?$/i, /^forms?$/i, /^admin/i, /^archive/i, /^old\b/i,
  /^misc/i, /^scans?$/i, /^inbox$/i, /^to ?file$/i, /^shared$/i, /^general$/i,
  /^firm\b/i, /^marketing$/i, /^billing$/i, /^accounting$/i, /^closed$/i,
];

// California and federal case-number shapes, plus a generic fallback.
const CASE_NUMBER_RES = [
  /\b\d{2}[A-Z]{2,6}\d{4,6}\b/i,          // 25STCV01234, 25NNCV09262
  /\b[A-Z]{2,6}\d{6,9}\b/,                 // CIVSB2512345
  /\b\d{1,2}:\d{2}-[a-z]{2,3}-\d{3,6}\b/i, // 2:26-cv-00123
  /\b\d{2}-\d{4,6}\b/,                     // 26-12345
];

// Turn a folder name into the fields a civil case needs. Deliberately
// conservative: when the shape is unfamiliar the whole name becomes the case
// name and the client, rather than guessing a split that could be wrong.
function parseCaseFolderName(folderName) {
  const raw = String(folderName || "").trim();
  const out = { folder: raw, case_number: null, case_name: raw, client_name: raw, opposing_party: null, confidence: "low" };
  if (!raw) return { ...out, looks_like_case: false, skip_reason: "empty name" };
  if (NON_CASE_FOLDERS.some(re => re.test(raw))) {
    return { ...out, looks_like_case: false, skip_reason: "looks like an admin/support folder" };
  }

  let rest = raw;

  // Pull a case number out wherever it sits.
  for (const re of CASE_NUMBER_RES) {
    const m = rest.match(re);
    if (m) {
      out.case_number = m[0];
      rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length));
      break;
    }
  }
  // Only light cleaning here. Normalising dashes BEFORE the party split would
  // turn "v-" into "v - " and "Yvette S- Ramirez" into "Yvette S - Ramirez",
  // wrecking both the separator match and the party names.
  rest = rest.replace(/[\(\)\[\]]/g, " ").replace(/\s+/g, " ")
             .replace(/^[\s\-–—_]+|[\s\-–—_]+$/g, "");

  // "Party v. Party" — the client is the first-named party, the other side is
  // the opposing party. Real folder names use every separator going:
  // "v.", "v-", "vs", "VS-", "versus".
  const vs = rest.match(/^(.+?)\s+(?:v|vs|versus)[.\-–]?\s+(.+)$/i);
  if (vs) {
    out.case_name = rest;
    out.client_name = vs[1].trim().replace(/[\s\-–—_]+$/, "");
    out.opposing_party = vs[2].trim().replace(/^[\s\-–—_]+/, "");
    out.confidence = "high";
  } else {
    // "Client - Matter description". Safe to normalise dashes now: we already
    // know there is no party separator to damage.
    const spaced = rest.replace(/\s*[-–—]\s*/g, " - ").replace(/\s+/g, " ").trim();
    const dash = spaced.split(" - ");
    if (dash.length >= 2 && dash[0].trim().length >= 2) {
      out.case_name = spaced;
      out.client_name = dash[0].trim();
      out.confidence = "medium";
    } else {
      out.case_name = rest || raw;
      out.client_name = rest || raw;
      out.confidence = out.case_number ? "medium" : "low";
    }
  }

  // "Last, First" reads better as "First Last" for a client record.
  const comma = out.client_name.match(/^([^,]+),\s*(.+)$/);
  if (comma && comma[2].split(/\s+/).length <= 3) {
    out.client_name = (comma[2] + " " + comma[1]).replace(/\s+/g, " ").trim();
  }

  out.case_name = out.case_name.replace(/\s+/g, " ").trim() || raw;
  out.client_name = out.client_name.replace(/\s+/g, " ").trim() || raw;
  if (out.opposing_party) out.opposing_party = out.opposing_party.replace(/\s+/g, " ").trim() || null;
  return { ...out, looks_like_case: true };
}

// Reuse an existing contact when the name already exists, so importing twice
// doesn't produce duplicate clients.
async function findOrCreateClient(clientName, { dryRun, createdBy }) {
  const name = String(clientName || "").trim();
  if (!name) throw new Error("client name required");
  const norm = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const existing = await db.query(
    `SELECT client_key, client_name FROM tasks
      WHERE client_key IS NOT NULL
        AND LOWER(REGEXP_REPLACE(COALESCE(client_name,''), '[^a-zA-Z0-9]+', ' ', 'g')) = $1
      ORDER BY created_at ASC LIMIT 1`,
    [norm]
  ).catch(() => ({ rows: [] }));
  if (existing.rows[0]) return { client_key: existing.rows[0].client_key, created: false, client_name: existing.rows[0].client_name };

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const client_key = `contact-${slug}-${Date.now().toString(36)}`;
  if (dryRun) return { client_key, created: true, client_name: name, dry_run: true };

  // Same shape the app's contact-only endpoint writes, so imported clients
  // show up in the normal client lists.
  await db.query(
    `INSERT INTO tasks
       (title, client_key, client_name, matter_type, description, assigned_to, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Contact', $4, $5, 'completed', NOW(), NOW())`,
    [`Contact: ${name}`, client_key, name, `Imported from Dropbox civil folder`, createdBy || "dropbox-import"]
  );
  return { client_key, created: true, client_name: name };
}

// Walk the civil root and turn each matter folder into a case.
async function importCasesFromFolders({ dryRun = true, root = null, createdBy = null } = {}) {
  await initTables();
  if (!dbx.isConfigured()) throw new Error("Dropbox is not connected");

  const roots = root ? [normalizePath(root)] : await getCivilRoots();
  const configured = root ? true : await rootsAreConfigured();
  if (!configured) {
    return {
      ok: false, reason: "roots_not_configured",
      hint: "Set the civil Dropbox root first — otherwise this would create cases from your immigration folders.",
    };
  }

  // Folders already attached to a case must never be imported twice.
  const linkedR = await db.query(`SELECT LOWER(dropbox_path) AS p FROM civil_cases WHERE dropbox_path IS NOT NULL`);
  const linked = new Set(linkedR.rows.map(r => r.p));

  const created = [], skipped = [], failed = [];
  for (const r of roots) {
    let entries;
    try { entries = await dbx.listFolder(r || ""); }
    catch (e) { failed.push({ folder: r, error: e.message }); continue; }
    if (!entries) { failed.push({ folder: r, error: "root not found" }); continue; }

    for (const e of entries) {
      if (e[".tag"] !== "folder") continue;

      // Is this a client folder holding several matters, or a matter itself?
      // Real trees mix both: "BZ" holds "BZ v. Hernandez" and two siblings,
      // while "ADREON vs TREASURE MOUNTAIN" IS the matter and its children are
      // document categories. Children that read as matters settle it.
      let units = [{ name: e.name, path: e.path_display, clientOverride: null }];
      try {
        const kids = await dbx.listFolder(e.path_display);
        const matterKids = (kids || []).filter(k =>
          k[".tag"] === "folder" && parseCaseFolderName(k.name).confidence === "high");
        if (matterKids.length) {
          units = matterKids.map(k => ({
            name: k.name, path: k.path_display,
            // The parent folder names the client more reliably than parsing
            // the child ever could.
            clientOverride: parseCaseFolderName(e.name).client_name,
          }));
        }
      } catch (err) { /* unreadable child listing — treat the parent as the matter */ }

      for (const unit of units) {
      const path = unit.path;
      if (linked.has(String(path).toLowerCase())) {
        skipped.push({ folder: unit.name, path, reason: "already linked to a case" });
        continue;
      }
      const parsed = parseCaseFolderName(unit.name);
      if (!parsed.looks_like_case) {
        skipped.push({ folder: unit.name, path, reason: parsed.skip_reason });
        continue;
      }

      try {
        const client = await findOrCreateClient(unit.clientOverride || parsed.client_name, { dryRun, createdBy });
        if (dryRun) {
          created.push({
            folder: unit.name, path, case_name: parsed.case_name, case_number: parsed.case_number,
            opposing_party: parsed.opposing_party,
            client_name: client.client_name, client_key: client.client_key,
            client_created: client.created, confidence: parsed.confidence, case_id: null,
            nested: !!unit.clientOverride,
          });
          continue;
        }
        const civil = require("./civil-litigation");
        const newCase = await civil.createCase({
          client_key: client.client_key,
          case_name: parsed.case_name,
          case_number: parsed.case_number,
          opposing_party: parsed.opposing_party,
          stage: "intake",
          internal_notes: `Imported from Dropbox folder: ${path}`,
          created_by: createdBy || "dropbox-import",
        });
        await setCaseFolder(newCase.id, path);
        let synced = null;
        try { synced = await syncCase(newCase.id); } catch (err) { /* reported by the next sweep */ }
        created.push({
          folder: unit.name, path, case_id: newCase.id, case_name: parsed.case_name,
          case_number: parsed.case_number, opposing_party: parsed.opposing_party,
          client_name: client.client_name,
          client_key: client.client_key, client_created: client.created,
          confidence: parsed.confidence, files: synced ? synced.total : 0,
          nested: !!unit.clientOverride,
        });
      } catch (err) {
        failed.push({ folder: unit.name, path, error: err.message });
      }
      }
    }
  }

  return {
    ok: true, dry_run: dryRun, roots,
    created_count: created.length, skipped_count: skipped.length, failed_count: failed.length,
    clients_created: created.filter(c => c.client_created).length,
    created, skipped, failed,
  };
}

// ═══════════════════════════════════════════════════════════
//  ARCHIVE
//  Closing a matter freezes its file list: we stop syncing it
//  and mark the rows archived. Nothing is deleted or moved in
//  Dropbox — the firm's retention obligations outlive the case,
//  and an automated process should never be the thing that
//  touches client files.
// ═══════════════════════════════════════════════════════════

async function archiveCaseFiles(caseId, { by = null } = {}) {
  await initTables();
  const c = await getCaseRow(caseId);
  if (!c) throw new Error("Case not found");

  // One last sync so the archived snapshot is complete.
  if (c.dropbox_path) { try { await syncCase(caseId); } catch (e) { /* archive anyway */ } }

  const r = await db.query(
    `UPDATE civil_case_files SET archived = TRUE
      WHERE case_id = $1 AND removed_at IS NULL RETURNING id`,
    [caseId]
  );
  // Archiving means the matter is finished, so move it to the Closed column.
  // Previously this only froze the file list, which left closed matters sitting
  // in their old kanban stage looking active.
  await db.query(
    `UPDATE civil_cases
        SET files_archived_at = NOW(),
            stage_before_archive = COALESCE(stage_before_archive, stage),
            stage = 'closed',
            updated_at = NOW()
      WHERE id = $1`,
    [caseId]
  );

  try {
    const civil = require("./civil-litigation");
    await civil.logEvent(caseId, {
      event_kind: "note",
      event_date: new Date().toISOString().slice(0, 10),
      title: "Case file archived",
      description: `${r.rowCount} document${r.rowCount === 1 ? "" : "s"} frozen and the matter moved to Closed. Dropbox sync paused; nothing was moved or deleted in Dropbox.`,
      created_by: by || "dropbox-sync",
    });
  } catch (e) { /* non-fatal */ }

  return { ok: true, archived: r.rowCount, case_id: caseId };
}

async function unarchiveCaseFiles(caseId) {
  await initTables();
  await db.query(`UPDATE civil_case_files SET archived = FALSE WHERE case_id = $1`, [caseId]);
  // Put it back in whatever stage it was in before it was archived.
  await db.query(
    `UPDATE civil_cases
        SET files_archived_at = NULL,
            stage = COALESCE(stage_before_archive, 'intake'),
            stage_before_archive = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [caseId]
  );
  return { ok: true, case_id: caseId };
}

// ═══════════════════════════════════════════════════════════
//  READ
// ═══════════════════════════════════════════════════════════

// Route a mirrored file to a lifecycle phase. The phase module is optional,
// so a load failure leaves files unphased rather than failing the sync.
let _phasesMod;
function phaseOfFile(name, relativeFolder) {
  try {
    if (_phasesMod === undefined) _phasesMod = require("./civil-phases");
    return _phasesMod ? _phasesMod.phaseForFile(name, relativeFolder) : null;
  } catch (e) { _phasesMod = null; return null; }
}

/** Re-route every mirrored file for a case after the taxonomy changes. */
async function rephaseCaseFiles(caseId) {
  await initTables();
  const r = await db.query(
    `SELECT id, name, relative_folder FROM civil_case_files WHERE case_id = $1`, [caseId]);
  let n = 0;
  for (const row of r.rows) {
    const ph = phaseOfFile(row.name, row.relative_folder);
    await db.query(`UPDATE civil_case_files SET phase = $1 WHERE id = $2`, [ph, row.id]);
    if (ph) n++;
  }
  return { ok: true, case_id: caseId, files: r.rows.length, phased: n };
}

/** File counts per lifecycle phase, for the stage tabs. */
async function phaseSummary(caseId) {
  await initTables();
  const r = await db.query(
    `SELECT COALESCE(phase, 'unfiled') AS phase, COUNT(*)::int AS count
       FROM civil_case_files
      WHERE case_id = $1 AND removed_at IS NULL
      GROUP BY COALESCE(phase, 'unfiled')`,
    [caseId]
  );
  return r.rows;
}

async function listCaseFiles(caseId, { category = null, includeRemoved = false, phase = null } = {}) {
  await initTables();
  const where = ["case_id = $1"];
  const vals = [caseId];
  let i = 2;
  if (!includeRemoved) where.push("removed_at IS NULL");
  if (category && CATEGORY_KEYS.has(category)) { where.push(`category = $${i++}`); vals.push(category); }
  if (phase) {
    if (phase === "unfiled") where.push("phase IS NULL");
    else { where.push(`phase = $${i++}`); vals.push(phase); }
  }
  const r = await db.query(
    `SELECT id, dropbox_id, path_display, name, relative_folder, category, phase,
            size_bytes, client_modified, server_modified, archived, first_seen_at, removed_at
       FROM civil_case_files
      WHERE ${where.join(" AND ")}
      ORDER BY category ASC, server_modified DESC NULLS LAST`,
    vals
  );
  return r.rows;
}

// File counts per category, for the case-detail tab headers.
async function categorySummary(caseId) {
  await initTables();
  const r = await db.query(
    `SELECT category, COUNT(*)::int AS n, MAX(server_modified) AS latest
       FROM civil_case_files WHERE case_id = $1 AND removed_at IS NULL
      GROUP BY category`,
    [caseId]
  );
  const byKey = Object.fromEntries(r.rows.map(x => [x.category, x]));
  return DOC_CATEGORIES.map(c => ({
    key: c.key, label: c.label, color: c.color,
    count: byKey[c.key] ? byKey[c.key].n : 0,
    latest: byKey[c.key] ? byKey[c.key].latest : null,
  }));
}

// Short-lived direct link, fetched on demand — we never store Dropbox URLs,
// since temporary links expire in about four hours.
async function fileLink(fileId) {
  const r = await db.query(`SELECT path_display FROM civil_case_files WHERE id = $1`, [fileId]);
  if (!r.rows.length) throw new Error("File not found");
  return await dbx.getTemporaryLink(r.rows[0].path_display);
}

// ═══════════════════════════════════════════════════════════
//  SCHEDULER
//  Deliberately NOT setHours(): that pattern skips a day when
//  the process restarts past the target time, which is exactly
//  how the autoposter lost runs. This computes the next slot
//  from the wall clock every tick, so a restart at any moment
//  simply picks up the next hour.
// ═══════════════════════════════════════════════════════════

let _timer = null;

function startScheduler({ everyMinutes = 60 } = {}) {
  if (_timer) return { ok: true, already_running: true };
  const period = Math.max(5, everyMinutes) * 60 * 1000;

  const tick = async () => {
    try {
      if (!dbx.isConfigured()) return;
      const res = await syncAll({ limit: 200 });
      if (res.added || res.removed || res.failed) {
        console.log(`[civil-dropbox] sync: ${res.cases} cases, +${res.added} new, -${res.removed} removed, ${res.failed} failed`);
      }
    } catch (e) {
      console.warn("[civil-dropbox] scheduled sync failed:", e.message);
    }
  };

  // First run shortly after boot so a fresh deploy reconciles quickly,
  // then on a fixed period. Any missed window is simply the next tick.
  setTimeout(tick, 2 * 60 * 1000);
  _timer = setInterval(tick, period);
  if (_timer.unref) _timer.unref();
  console.log(`[civil-dropbox] sync scheduler started (every ${everyMinutes} min)`);
  return { ok: true, every_minutes: everyMinutes };
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  return { ok: true };
}

// Undo an import: deletes ONLY cases this module created (they carry the
// import marker in internal_notes) so the corrected import can run again.
// Cases created by hand are never touched. Client contacts are left alone —
// they are harmless and may have been used elsewhere.
async function deleteImportedCases({ dryRun = true } = {}) {
  await initTables();
  const r = await db.query(
    `SELECT id, case_name FROM civil_cases
      WHERE internal_notes LIKE 'Imported from Dropbox folder:%'
      ORDER BY id ASC`
  );
  if (dryRun) return { ok: true, dry_run: true, count: r.rows.length, cases: r.rows };
  const civil = require("./civil-litigation");
  let deleted = 0;
  for (const row of r.rows) {
    try { await civil.deleteCase(row.id); deleted++; }
    catch (e) { /* keep going — one bad row must not strand the rest */ }
  }
  return { ok: true, dry_run: false, count: r.rows.length, deleted };
}

module.exports = {
  initTables,
  DOC_CATEGORIES, CATEGORY_KEYS, categorizeFile,
  normalizePath,
  setCaseFolder, clearCaseFolder, suggestFolderForCase, civilTokens,
  getCivilRoots, setCivilRoots, rootsAreConfigured, browseFolders, unlinkAll,
  syncCase, syncAll,
  bulkImport, importCasesFromFolders, parseCaseFolderName, deleteImportedCases,
  archiveCaseFiles, unarchiveCaseFiles,
  listCaseFiles, categorySummary, fileLink, phaseSummary, rephaseCaseFiles, phaseOfFile,
  startScheduler, stopScheduler,
};
