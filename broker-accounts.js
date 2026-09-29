// ============================================================
//  broker-accounts.js — A BROKER IS A DROPBOX FOLDER
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  JJ: "when creating consultants/brokers, only allow the one in
//  dropbox folder."
//
//  That one rule fixes a problem this feature had all day. A
//  client lives at <branch root>/<broker>/<client>, so the firm
//  ALREADY knows which broker every client belongs to — it is
//  written in the folder tree. What was missing was any link
//  between that tree and a login, so somebody would have had to
//  re-enter by hand a fact the system already held.
//
//  Tying the account to the folder closes it:
//
//    · the folder name is the broker's identity, so there is one
//      spelling of it rather than one in Dropbox and another in
//      the user list;
//    · a consultant account cannot be created for a broker who
//      does not exist, which is what JJ asked for;
//    · and their clients can be DERIVED rather than assigned —
//      every client under their folder is theirs, and that is
//      what makes the alerts actually fire.
//
//  Folders with a comma in the name are client folders ("Last,
//  First"), not brokers. They are excluded here rather than
//  merely sorted last: this list decides who can be given a
//  login, so a client must not appear in it.
// ============================================================

// Lazy, so the pure helpers here (brokerOfPath) can be loaded and checked on
// a machine with no database driver installed.
const db = () => require("./db");

let ensured = false;
async function ensureColumn() {
  if (ensured) return;
  for (const sql of [
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS broker_folder TEXT`,
    `CREATE INDEX IF NOT EXISTS admin_users_broker_folder ON admin_users (broker_folder)`,
  ]) {
    try { await db().query(sql); } catch (e) { console.warn("[broker-accounts] schema:", e.message); }
  }
  ensured = true;
}

/**
 * Every broker folder across both branches, by name.
 *
 * The same broker often has a folder under immigration AND civil; they are
 * one person, so the list is deduped by name and remembers where each was
 * seen. Returns { folders, error } — never throws, because this is called
 * while rendering the user-admin page and Dropbox being down must not take
 * that page with it.
 */
async function allFolders() {
  const provision = require("./client-provision");
  const seen = new Map();
  const errors = [];

  for (const branch of ["immigration", "civil"]) {
    let r;
    try { r = await provision.brokerFolders(branch); }
    catch (e) { errors.push(`${branch}: ${e.message}`); continue; }
    if (r.error) { errors.push(`${branch}: ${r.error}`); continue; }
    for (const f of r.folders || []) {
      if (f.looks_like_client) continue;          // "Last, First" is a client
      const key = f.name.trim().toLowerCase();
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, { name: f.name.trim(), branches: [], paths: [] });
      const e = seen.get(key);
      if (!e.branches.includes(branch)) e.branches.push(branch);
      e.paths.push(f.path);
    }
  }
  const folders = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { folders, error: errors.length ? errors.join("; ") : null };
}

/**
 * Is this the name of a real broker folder?
 * Returns the canonical folder name (Dropbox's own spelling) or null.
 * Compared case-insensitively — JJ should not have to match capitalisation.
 */
async function canonicalName(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return null;
  const { folders } = await allFolders();
  const hit = folders.find(f => f.name.toLowerCase() === want);
  return hit ? hit.name : null;
}

/**
 * The broker folder a client sits in, from their mapped Dropbox path.
 *
 * Some clients sit DIRECTLY under a branch root with no broker at all — JJ
 * confirmed both arrangements exist. Those have no broker, and the parent
 * segment is the root itself, so requiring three segments
 * (<root>/<broker>/<client>) is what stops a direct-filed client being
 * handed to whichever broker happens to share the root's name.
 */
function brokerOfPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  return parts[parts.length - 2];
}

/**
 * Link every client sitting in this broker's folder to this consultant.
 *
 * Derived, not typed: the folder tree is the source of truth, so this can be
 * re-run whenever new clients have been filed and it will pick them up. It
 * only ever ADDS links — a consultant deliberately removed from a client is
 * not quietly re-added, because removal is a decision and this sweep is not
 * entitled to overrule it.
 */
async function linkClients(userId, folderName, { by = null } = {}) {
  await ensureColumn();
  const folder = String(folderName || "").trim().toLowerCase();
  const out = { linked: [], already: 0, scanned: 0 };
  if (!folder) return out;

  const rows = (await db().query(
    `SELECT client_key, client_name, dropbox_path FROM client_dropbox_mapping`)).rows;

  for (const r of rows) {
    out.scanned++;
    const b = brokerOfPath(r.dropbox_path);
    if (!b || b.trim().toLowerCase() !== folder) continue;

    // Any live link already? Including one to somebody else — a client can
    // have more than one consultant, so this only checks for a duplicate.
    const have = await db().query(
      `SELECT id FROM client_consultants
        WHERE client_key = $1 AND consultant_id = $2 AND removed_at IS NULL LIMIT 1`,
      [r.client_key, userId]);
    if (have.rows.length) { out.already++; continue; }

    // Removed on purpose? Leave it removed.
    const removed = await db().query(
      `SELECT id FROM client_consultants
        WHERE client_key = $1 AND consultant_id = $2 AND removed_at IS NOT NULL LIMIT 1`,
      [r.client_key, userId]);
    if (removed.rows.length) continue;

    await db().query(
      `INSERT INTO client_consultants (client_key, consultant_id, role_description, assigned_by, notes)
       VALUES ($1, $2, 'Referring broker', $3, $4)`,
      [r.client_key, userId, by, `Derived from the Dropbox folder ${folderName}`]);
    out.linked.push({ client_key: r.client_key, client_name: r.client_name });
  }
  return out;
}

/** Re-run the sweep for every consultant that has a broker folder. */
async function relinkAll({ by = null } = {}) {
  await ensureColumn();
  const users = (await db().query(
    `SELECT id, username, broker_folder FROM admin_users
      WHERE role = 'consultant' AND broker_folder IS NOT NULL AND broker_folder <> ''`)).rows;
  const out = { consultants: users.length, linked: 0, detail: [] };
  for (const u of users) {
    const r = await linkClients(u.id, u.broker_folder, { by });
    out.linked += r.linked.length;
    out.detail.push({ username: u.username, folder: u.broker_folder, linked: r.linked.length, already: r.already });
  }
  return out;
}

module.exports = { ensureColumn, allFolders, canonicalName, brokerOfPath, linkClients, relinkAll };
