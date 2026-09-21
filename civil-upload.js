// ============================================================
//  civil-upload.js — files uploaded on the web go to Dropbox
//  ─────────────────────────────────────────────────────────
//  Dropbox is the matter file. The case page mirrors it; it is not
//  a second filing cabinet. So a document uploaded through the web
//  is written into the case's Dropbox folder, into the subfolder it
//  belongs in, and the mirror picks it up from there — exactly as
//  if somebody had dragged it into Dropbox by hand.
//
//  Sorting uses the same categoriser the sync uses, so a file lands
//  in the folder the case page would have filed it under anyway:
//
//      Complaint.pdf          → Pleadings
//      Retainer Agreement.pdf → Billing & Trust
//      RFP Set One.pdf        → Discovery
//
//  The attorney can override the category per upload. A file the
//  categoriser cannot place goes into the matter folder itself,
//  where it shows as Uncategorized and can be moved — never into a
//  guessed subfolder where nobody would look for it.
//
//  Three rules:
//
//  · Nothing is ever overwritten. Dropbox renames on conflict
//    ("Complaint (1).pdf"), and the result says so. A second upload
//    of "Complaint.pdf" must never replace the filed one.
//
//  · One bad file does not sink the batch. Each file succeeds or
//    fails on its own, and the response lists both.
//
//  · A case with no folder yet gets one first — the same setup a
//    new case gets — rather than refusing the upload.
// ============================================================

const MAX_FILES = 20;

/** A name Dropbox will accept, keeping the extension intact. */
function safeFileName(name) {
  const raw = String(name || "").split(/[\/\\]/).pop();       // never a path
  const cleaned = raw
    .replace(/[:?*"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim()
    .slice(0, 180);
  return cleaned || "document";
}

/**
 * Where a file goes. Returns { category, label, folder }.
 *
 *   explicit   — a category key the attorney picked, if valid
 *   fallback   — used only when the categoriser says "other"
 *                (the new-case intake passes "pleadings": those uploads
 *                are by definition the filed papers)
 */
function placeFile(fileName, caseFolder, cdx, { explicit = null, fallback = null } = {}) {
  const cats = cdx.DOC_CATEGORIES;
  const valid = k => k && cats.some(c => c.key === k);

  let category = valid(explicit) ? explicit : cdx.categorizeFile(fileName, "");
  if (category === "other" && valid(fallback)) category = fallback;

  const cat = cats.find(c => c.key === category) || cats.find(c => c.key === "other");
  const folder = category === "other"
    ? caseFolder
    : caseFolder.replace(/\/+$/, "") + "/" + cat.label;
  return { category: cat.key, label: category === "other" ? "the matter folder (uncategorized)" : cat.label, folder };
}

/**
 * Upload files into a case's Dropbox folder, sorted.
 *
 * files: [{ buffer, originalname | filename }]
 * Returns { ok, case_id, folder, uploaded:[...], failed:[...], provisioned? }
 */
async function uploadToCase(caseId, files, {
  category = null, fallback = null, by = null, provisionIfMissing = true, source = "web",
} = {}) {
  const civil = require("./civil-litigation");
  const cdx = require("./civil-dropbox");
  const dbx = require("./dropbox-integration");

  if (!files || !files.length) throw new Error("No files uploaded");
  if (files.length > MAX_FILES) throw new Error(`Too many files — ${MAX_FILES} at a time`);
  if (!dbx.isConfigured()) throw new Error("Dropbox is not connected — authorize it in admin settings first");

  let c = await civil.getCase(caseId);
  if (!c) throw new Error("Case not found");

  const out = { ok: true, case_id: caseId, uploaded: [], failed: [] };

  // No folder yet: make one, the same way opening a case does.
  if (!c.dropbox_path && provisionIfMissing) {
    const setup = await require("./civil-provision").ensureCaseFolder(c);
    out.provisioned = setup;
    c = await civil.getCase(caseId);
  }
  if (!c.dropbox_path) {
    const why = (out.provisioned && (out.provisioned.reason || out.provisioned.error)) || "no Dropbox folder is linked";
    throw new Error("Could not file these documents: " + why);
  }
  if (c.files_archived_at) {
    // An archived matter's mirror is frozen; filing into it would put a
    // document where nobody is looking. Say so rather than do it.
    throw new Error("This matter's files are archived. Unarchive it before adding documents.");
  }
  out.folder = c.dropbox_path;

  for (const f of files) {
    const name = safeFileName(f.originalname || f.filename);
    const where = placeFile(name, c.dropbox_path, cdx, { explicit: category, fallback });
    const target = where.folder + "/" + name;
    try {
      const meta = await dbx.uploadFile({ path: target, buffer: f.buffer, mode: "add", autorename: true });
      const saved = (meta && (meta.path_display || meta.path_lower)) || target;
      out.uploaded.push({
        name,
        saved_as: saved.split("/").pop(),
        renamed: saved.split("/").pop() !== name,
        category: where.category,
        folder_label: where.label,
        path: saved,
        bytes: f.buffer ? f.buffer.length : null,
      });
    } catch (e) {
      out.failed.push({ name, error: e.message });
    }
  }
  if (!out.uploaded.length) out.ok = false;

  // Bring the mirror up to date so the case page shows the new files on
  // reload, rather than after the next hourly sync.
  if (out.uploaded.length) {
    try { await cdx.syncCase(caseId); out.synced = true; }
    catch (e) { out.sync_error = e.message; }
  }

  // One line in the case history per batch, so "when did this arrive and
  // who put it there" has an answer that does not depend on Dropbox's own
  // version history.
  if (out.uploaded.length || out.failed.length) {
    const lines = out.uploaded.map(u =>
      `${u.saved_as} → ${u.folder_label}${u.renamed ? " (renamed; a file with that name was already there)" : ""}`);
    out.failed.forEach(f => lines.push(`FAILED: ${f.name} — ${f.error}`));
    try {
      await civil.logEvent(caseId, {
        event_kind: "note",
        event_date: new Date().toISOString().slice(0, 10),
        title: `${out.uploaded.length} document${out.uploaded.length === 1 ? "" : "s"} filed to Dropbox` +
               (source === "intake" ? " from the new-case intake" : ""),
        description: lines.join("\n"),
        created_by: by || "web-upload",
      });
    } catch (e) { /* the upload itself succeeded; the note is secondary */ }
  }

  return out;
}

module.exports = { uploadToCase, placeFile, safeFileName, MAX_FILES };
