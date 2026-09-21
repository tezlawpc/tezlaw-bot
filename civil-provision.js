// ============================================================
//  civil-provision.js — what happens the moment a case exists
//  ─────────────────────────────────────────────────────────
//  Opening a matter used to be three jobs that looked like one.
//  Somebody filled in the new-case form, then went to Dropbox and
//  made a folder, then went back and linked it, and at some point
//  a contact record got made so the client showed up in the client
//  list. Miss the second step and documents have nowhere to go.
//  Miss the third and the matter belongs to a client who does not
//  exist anywhere else in the system.
//
//  So the moment a case row is written, this runs:
//
//    1. The client profile. If the key on the case does not exist
//       as a contact, one is created with it — the same shape the
//       app's contact endpoint writes, so the client appears in the
//       normal lists rather than as a dangling foreign key.
//
//    2. The Dropbox folder, with the firm's standard subfolders
//       inside it, linked to the case and synced.
//
//  Two rules govern all of it:
//
//  · Provisioning NEVER fails case creation. The case is already
//    in the database by the time this is called. Dropbox being
//    down, or a token having expired, must not cost an attorney
//    the form they just filled in. Everything here is caught, and
//    what happened comes back as a report the page displays.
//
//  · Nothing is created on top of something that already exists.
//    An existing contact is reused, an existing folder is linked
//    rather than duplicated, and re-running this on a case that is
//    already provisioned is a no-op. That makes the retry button
//    safe to press, which is what makes a best-effort step
//    acceptable in the first place.
// ============================================================

const db = require("./db");

// The firm's standard matter folder. Each name is also a document
// category in civil-dropbox, and categorizeFile() reads the folder name
// before the filename — so a document dropped in "Discovery" is filed as
// discovery even if it is called "scan0007.pdf". The two lists have to
// stay in step; check-civil-provision.js asserts they do.
const STANDARD_SUBFOLDERS = [
  "Pleadings",
  "Discovery",
  "Depositions",
  "Motion Practice",
  "Orders & Rulings",
  "Settlement",
  "Experts",
  "Evidence",
  "Correspondence",
  "Billing & Trust",
  "Client Documents",
];

// Dropbox rejects these outright, and a trailing dot or space produces a
// folder that Windows clients cannot open.
function cleanPart(s) {
  return String(s || "")
    .replace(/[\/\\:?*"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
}
// The trailing-dot rule applies to the finished name only. Stripping it from
// each part would turn "Acme Corp. - 25STCV01234" into "Acme Corp - …" for no
// reason; the dot is only a problem when it is the last character.
function safeFolderName(s) {
  return cleanPart(s).slice(0, 120).replace(/[.\s]+$/, "").trim();
}

/**
 * What to call this matter's folder.
 *
 * Deliberately the same shape the bulk importer already parses —
 * "Nguyen v. Pacific Holdings LLC - 25STCV01234" — so a folder made here
 * and a folder made by hand three years ago read the same way, and
 * parseCaseFolderName() can still recover the parties and the number
 * from either.
 */
function folderNameForCase(c) {
  const base = cleanPart(c.case_name);
  const num = cleanPart(c.case_number);
  if (!base) return null;
  // Don't repeat a number the caption already carries.
  const full = num && !base.toLowerCase().includes(num.toLowerCase()) ? `${base} - ${num}` : base;
  return safeFolderName(full) || null;
}

/** "nguyen-pacific-holdings" → "Nguyen Pacific Holdings". A fallback only. */
function nameFromKey(key) {
  return String(key || "")
    .replace(/^contact-/, "")
    .replace(/-[a-z0-9]{6,}$/, "")     // the base-36 suffix generated keys carry
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

// ── 1. The client profile ───────────────────────────────────

/**
 * Make sure the case's client_key names a contact that actually exists.
 * Returns { key, created, name, reason? } and never throws.
 */
async function ensureClientProfile(caseRow, { createdBy = null, clientName = null } = {}) {
  const key = String(caseRow.client_key || "").trim();
  if (!key) return { key: null, created: false, reason: "the case has no client key" };

  try {
    const existing = await db.query(
      `SELECT client_name FROM tasks WHERE client_key = $1 ORDER BY created_at ASC LIMIT 1`,
      [key]
    );
    if (existing.rows.length) {
      return { key, created: false, name: existing.rows[0].client_name || key, reason: "already on file" };
    }
  } catch (e) {
    return { key, created: false, error: e.message };
  }

  // Best available name, in order of how much we trust it: what the attorney
  // typed, then the first-named party in the caption, then the key itself.
  let name = String(clientName || "").trim();
  if (!name) {
    const caption = String(caseRow.case_name || "");
    const vs = caption.match(/^(.+?)\s+(?:v|vs|versus)[.\-–]?\s+/i);
    if (vs && caseRow.our_role !== "defendant" && caseRow.our_role !== "respondent") {
      name = vs[1].trim();
    }
  }
  if (!name) name = nameFromKey(key);
  if (!name) return { key, created: false, reason: "could not work out a client name" };

  try {
    // The same row shape findOrCreateClient writes for Dropbox imports and
    // the app writes for a contact-only client, so this client behaves like
    // every other one rather than like a special case.
    await db.query(
      `INSERT INTO tasks
         (title, client_key, client_name, matter_type, description, assigned_to, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'Contact', $4, $5, 'completed', NOW(), NOW())`,
      [`Contact: ${name}`, key, name,
       `Created automatically when civil matter "${caseRow.case_name}" was opened`,
       createdBy || "civil-intake"]
    );
    return { key, created: true, name };
  } catch (e) {
    return { key, created: false, name, error: e.message };
  }
}

// ── 2. The Dropbox folder ───────────────────────────────────

/**
 * Create (or adopt) this matter's Dropbox folder, link it to the case, and
 * sync it. Returns { created, path, subfolders, linked, synced, reason? }
 * and never throws.
 */
async function ensureCaseFolder(caseRow, { subfolders = true } = {}) {
  let dbx, cdx;
  try {
    dbx = require("./dropbox-integration");
    cdx = require("./civil-dropbox");
  } catch (e) {
    return { created: false, linked: false, error: e.message };
  }

  if (caseRow.dropbox_path) {
    return { created: false, linked: true, path: caseRow.dropbox_path, reason: "already linked" };
  }
  if (!dbx.isConfigured()) {
    return { created: false, linked: false, reason: "Dropbox is not connected" };
  }

  // If the civil roots have never been configured, getCivilRoots() falls
  // back to the IMMIGRATION branch roots. Creating a civil matter folder
  // there would quietly scatter litigation files through the immigration
  // tree, and nobody would notice for months. Refuse and say why.
  let root;
  try {
    if (!(await cdx.rootsAreConfigured())) {
      return {
        created: false, linked: false,
        reason: "no civil Dropbox root is configured — set one in the Dropbox console first, " +
                "otherwise the folder would be created under the immigration branches",
      };
    }
    root = (await cdx.getCivilRoots())[0];
  } catch (e) {
    return { created: false, linked: false, error: e.message };
  }

  const name = folderNameForCase(caseRow);
  if (!name) return { created: false, linked: false, reason: "the case has no usable name" };

  const path = cdx.normalizePath(String(root).replace(/\/+$/, "") + "/" + name);
  if (!path) return { created: false, linked: false, reason: "could not build a folder path" };

  const out = { path, created: false, adopted: false, linked: false, subfolders: [], synced: false };

  try {
    // createFolder returns null when the folder is already there, which is
    // the case where somebody made it by hand five minutes ago. Adopt it.
    const made = await dbx.createFolder(path);
    out.created = !!made;
    out.adopted = !made;
  } catch (e) {
    return Object.assign(out, { error: e.message });
  }

  if (subfolders) {
    for (const sub of STANDARD_SUBFOLDERS) {
      try {
        await dbx.createFolder(path + "/" + sub);
        out.subfolders.push(sub);
      } catch (e) {
        // One subfolder failing is not worth losing the matter folder over.
        out.subfolder_errors = out.subfolder_errors || [];
        out.subfolder_errors.push(`${sub}: ${e.message}`);
      }
    }
  }

  try {
    await cdx.setCaseFolder(caseRow.id, path);
    out.linked = true;
  } catch (e) {
    return Object.assign(out, { error: e.message });
  }

  // A first sync so the case page shows the folder rather than an empty
  // panel that looks like a failure. An adopted folder may already have
  // documents in it, and they should be filed straight away.
  try {
    await cdx.syncCase(caseRow.id, { force: true });
    out.synced = true;
  } catch (e) {
    out.sync_error = e.message;
  }

  return out;
}

// ── The whole job ───────────────────────────────────────────

/**
 * Run both steps for a freshly created case.
 *
 * Never throws: the case already exists, and losing it to a Dropbox
 * outage would be a far worse bug than a folder that has to be made by
 * hand. The report is written back onto the case's event log so the
 * history says what was and was not set up.
 */
async function provisionNewCase(caseRow, { createdBy = null, clientName = null, subfolders = true } = {}) {
  const report = { case_id: caseRow && caseRow.id, client: null, dropbox: null, notes: [] };
  if (!caseRow || !caseRow.id) {
    report.notes.push("No case to provision.");
    return report;
  }

  try {
    report.client = await ensureClientProfile(caseRow, { createdBy, clientName });
  } catch (e) {
    report.client = { created: false, error: e.message };
  }

  try {
    report.dropbox = await ensureCaseFolder(caseRow, { subfolders });
  } catch (e) {
    report.dropbox = { created: false, linked: false, error: e.message };
  }

  // Say it in one line, in the case's own history, so six months from now
  // "where did this folder come from?" has an answer.
  const bits = [];
  if (report.client && report.client.created) bits.push(`client profile created (${report.client.name})`);
  else if (report.client && report.client.reason === "already on file") bits.push("client already on file");
  if (report.dropbox && report.dropbox.created) bits.push(`Dropbox folder created at ${report.dropbox.path}`);
  else if (report.dropbox && report.dropbox.adopted) bits.push(`linked to the existing Dropbox folder ${report.dropbox.path}`);
  else if (report.dropbox && (report.dropbox.reason || report.dropbox.error)) {
    bits.push(`no Dropbox folder — ${report.dropbox.reason || report.dropbox.error}`);
  }
  report.summary = bits.join("; ") || "nothing to set up";

  try {
    const civil = require("./civil-litigation");
    await civil.logEvent(caseRow.id, {
      event_kind: "note",
      event_date: new Date().toISOString().slice(0, 10),
      title: "Matter set up",
      description: report.summary,
      created_by: createdBy || "civil-intake",
    });
  } catch (e) {
    report.notes.push("Could not write the setup note to the case history: " + e.message);
  }

  return report;
}

/**
 * provisionNewCase, but the caller only waits so long.
 *
 * Eleven subfolders and a first sync is usually two or three seconds. On a
 * bad Dropbox day it can be thirty, and an attorney staring at a
 * "CREATING…" button for thirty seconds will press it again and open the
 * matter twice. So: wait up to `ms`, and if it is not done, answer anyway
 * and let it finish in the background. The case-history note it writes
 * when it finishes is the record either way.
 */
async function provisionWithin(caseRow, opts = {}, ms = 12000) {
  const job = provisionNewCase(caseRow, opts).catch(e => ({
    case_id: caseRow && caseRow.id, error: e.message, summary: "setup failed: " + e.message,
  }));
  let timer;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve({
      case_id: caseRow && caseRow.id,
      pending: true,
      summary: "still setting up the Dropbox folder — it will appear on the case page in a moment",
    }), ms);
  });
  const out = await Promise.race([job, late]);
  clearTimeout(timer);
  return out;
}

module.exports = {
  provisionNewCase, provisionWithin, ensureClientProfile, ensureCaseFolder,
  folderNameForCase, safeFolderName, nameFromKey, STANDARD_SUBFOLDERS,
};
