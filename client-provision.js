/**
 * client-provision.js — put a new client's Dropbox folder in the right branch.
 *
 * Two branches, and they get their roots from different places:
 *   immigration -> DROPBOX_BRANCH_ROOTS (env), via dbx.getBranchRoots()
 *   civil       -> the DB, via cdx.getCivilRoots()
 *
 * The ONE rule that matters here: adopt before you create. Years of client
 * folders already exist in Dropbox, and every EOIR notice we have ever filed
 * lives in one of them. A client whose folder is "Kong, Xiangmin (A123 456 789)"
 * must not end up with a second, empty "Kong, Xiangmin" beside it — that splits
 * the file, and nobody notices until someone goes looking for a notice that is
 * in the other folder. So: search first, adopt a confident match, hand back
 * candidates when it is ambiguous, and create only when nothing matches.
 *
 * Refusing is a valid outcome. Creating the folder in the wrong tree is worse
 * than creating nothing, because scattered litigation files in the immigration
 * tree are invisible until they matter.
 */

const dbx = require("./dropbox-integration");
const cdx = require("./civil-dropbox");
const { STANDARD_SUBFOLDERS: CIVIL_SUBFOLDERS } = require("./civil-provision");

const BRANCHES = ["immigration", "civil"];

// Immigration matters are filed by agency and stage rather than by litigation
// phase, so they need their own set. Edit this list in one place; provisioning
// reads it, nothing else hardcodes these names.
const IMMIGRATION_SUBFOLDERS = [
  "Client Documents",
  "Forms & Filings",
  "USCIS Correspondence",
  "EOIR - Court",
  "Evidence & Exhibits",
  "Country Conditions",
  "Correspondence",
  "Billing & Trust",
];

function subfoldersFor(branch) {
  return branch === "civil" ? CIVIL_SUBFOLDERS : IMMIGRATION_SUBFOLDERS;
}

/**
 * Which roots does this branch use? Returns { roots, error }.
 * An unconfigured branch is an error, never a silent fallback to the other
 * branch's roots — that is exactly how files end up in the wrong tree.
 */
async function rootsForBranch(branch) {
  if (branch === "immigration") {
    const roots = dbx.getBranchRoots();
    if (!roots.length) {
      return { roots: null, error: "no immigration roots configured - set DROPBOX_BRANCH_ROOTS in Render" };
    }
    return { roots, error: null };
  }
  if (branch === "civil") {
    if (!(await cdx.rootsAreConfigured())) {
      return {
        roots: null,
        error: "no civil Dropbox root is configured - set one in the Dropbox console first, " +
               "otherwise the folder would be created under the immigration branches",
      };
    }
    const roots = await cdx.getCivilRoots();
    if (!roots || !roots.length) return { roots: null, error: "civil roots are configured but empty" };
    return { roots, error: null };
  }
  return { roots: null, error: `unknown branch "${branch}" - expected one of ${BRANCHES.join(", ")}` };
}

/**
 * Map a matter type onto a branch. Anything not recognised returns null rather
 * than guessing, and the caller then asks a human. A wrong guess here files the
 * client in the wrong tree, which is the failure this module exists to prevent.
 */
const CIVIL_HINTS = /\b(civil|litigation|unlawful detainer|eviction|landlord|tenant|real estate|contract|business dispute|breach|partition|quiet title|construction|personal injury|pi)\b/i;
const IMMIGRATION_HINTS = /\b(immigration|asylum|removal|deportation|eoir|bia|uscis|adjustment|aos|naturalization|citizenship|visa|eb-?5|sijs|habeas|mandamus|daca|tps|vawa|u-?visa|consular)\b/i;

function branchForMatterType(matterType) {
  const s = String(matterType || "");
  if (!s.trim()) return null;
  const civil = CIVIL_HINTS.test(s);
  const imm = IMMIGRATION_HINTS.test(s);
  if (civil && !imm) return "civil";
  if (imm && !civil) return "immigration";
  return null;   // both or neither - ask, do not guess
}

/**
 * Provision (or adopt) the client's folder.
 *
 * Returns { ok, action, branch, path, score, reason, candidates, subfolders }
 * where action is one of:
 *   already_mapped - this client_key already points at a folder; nothing done
 *   adopted        - an existing folder matched confidently and is now mapped
 *   needs_review   - possible matches found; NOTHING created, a human picks
 *   created        - no match anywhere, so a new folder was made
 *   refused        - the branch is unusable; nothing touched
 */
async function provisionClientFolder({
  clientKey, clientName, aNumber = null, branch,
  subfolders = true, dryRun = false, allowCreate = true, skipSuggest = false,
}) {
  const out = {
    ok: false, action: null, branch, path: null, score: null,
    reason: null, candidates: [], subfolders: [], subfolder_errors: [],
  };

  if (!clientName || !String(clientName).trim()) {
    return Object.assign(out, { action: "refused", reason: "client name is required" });
  }
  const key = clientKey || dbx.makeClientKey({ clientName, aNumber });
  if (!key) return Object.assign(out, { action: "refused", reason: "could not derive a client key" });
  out.client_key = key;

  const { roots, error } = await rootsForBranch(branch);
  if (error) return Object.assign(out, { action: "refused", reason: error });

  // 1. Already mapped? Then this client has a folder and we are done. Checked
  //    before any Dropbox call so re-running provisioning is free and harmless.
  try {
    const existing = await dbx.resolveClientFolder({ clientKey: key, clientName, aNumber });
    if (existing && existing.path) {
      return Object.assign(out, {
        ok: true, action: "already_mapped", path: existing.path,
        score: existing.score ?? null, reason: "client_key is already mapped to a folder",
      });
    }
  } catch (e) {
    // A mapping lookup failure must not stop provisioning; fall through to search.
    out.mapping_lookup_error = e.message;
  }

  // 2. Confident match inside THIS branch's roots -> adopt it.
  let best = null;
  try {
    best = await dbx.findClientFolder({ clientName, aNumber, roots });
  } catch (e) {
    return Object.assign(out, { action: "refused", reason: `folder search failed: ${e.message}` });
  }
  if (best && best.path) {
    if (!dryRun) {
      await dbx.setClientFolderMapping({ clientKey: key, aNumber, clientName, dropboxPath: best.path });
    }
    return Object.assign(out, {
      ok: true, action: "adopted", path: best.path, score: best.score,
      reason: best.reason || "confident match on an existing folder",
    });
  }

  // 3. Weaker candidates -> stop. Creating now is how a client ends up with two
  //    folders, and the second one is the empty one everybody finds first.
  //
  //    skipSuggest is the one way past this, and it exists for exactly one
  //    caller: a person who was shown these candidates, looked at them, and
  //    said none of them is this client. It skips THIS step only - an existing
  //    mapping (1) and a confident match (2) are both still honoured above, so
  //    it can never orphan a folder this client is already filed in.
  if (!skipSuggest) try {
    const cands = await dbx.suggestClientFolders({ clientName, aNumber, roots, minScore: 20, limit: 8 });
    if (cands && cands.length) {
      return Object.assign(out, {
        ok: true, action: "needs_review", candidates: cands,
        reason: `${cands.length} possible existing folder(s) - pick one or confirm this is a new client`,
      });
    }
  } catch (e) {
    out.suggest_error = e.message;   // not fatal; fall through to create
  }

  // 4. Nothing resembling this client exists -> make the folder.
  if (!allowCreate) {
    return Object.assign(out, { ok: true, action: "needs_review", reason: "no match found and creation was not permitted" });
  }
  const folderName = dbx.toLastCommaFirst(clientName);
  if (!folderName) return Object.assign(out, { action: "refused", reason: "could not build a folder name" });

  const root = String(roots[0]).replace(/\/+$/, "");
  const path = (root.startsWith("/") ? root : "/" + root) + "/" + folderName;
  out.path = path;

  if (dryRun) {
    return Object.assign(out, { ok: true, action: "created", reason: "dry run - nothing written", subfolders: subfolders ? subfoldersFor(branch) : [] });
  }

  try {
    await dbx.createFolder(path);   // returns null when it already exists; adopt either way
  } catch (e) {
    return Object.assign(out, { action: "refused", reason: `could not create ${path}: ${e.message}` });
  }

  if (subfolders) {
    for (const sub of subfoldersFor(branch)) {
      try { await dbx.createFolder(path + "/" + sub); out.subfolders.push(sub); }
      catch (e) { out.subfolder_errors.push(`${sub}: ${e.message}`); }
    }
  }

  try {
    await dbx.setClientFolderMapping({ clientKey: key, aNumber, clientName, dropboxPath: path });
  } catch (e) {
    // The folder exists; only the mapping failed. Say so rather than claiming success.
    return Object.assign(out, { ok: false, action: "created", reason: `folder created but mapping failed: ${e.message}` });
  }

  return Object.assign(out, { ok: true, action: "created", reason: "no existing folder matched, so a new one was created" });
}

module.exports = {
  provisionClientFolder,
  branchForMatterType,
  rootsForBranch,
  subfoldersFor,
  BRANCHES,
  IMMIGRATION_SUBFOLDERS,
};
