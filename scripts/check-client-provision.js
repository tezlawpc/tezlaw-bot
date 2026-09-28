/**
 * check-client-provision.js
 *
 * Guards the two things that make client folder provisioning safe:
 *
 *  1. A matter type is never GUESSED onto a branch. Filing an immigration
 *     client in the civil tree (or the reverse) hides the file for months,
 *     so anything ambiguous must return null and ask a human.
 *
 *  2. Adopt before create. Years of client folders already exist and every
 *     EOIR notice lives in one. If provisioning creates "Kong, Xiangmin"
 *     next to an existing "Kong, Xiangmin (A123 456 789)", the client's file
 *     is split and the empty folder is the one people find first. The
 *     needs_review return MUST come before any createFolder call.
 */
const fs = require("fs");
const path = require("path");
const cp = require("../client-provision");

let failures = 0;
const fail = m => { failures++; console.log("  FAIL " + m); };
const ok = m => console.log("  ok   " + m);
const eq = (got, want, label) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(label) : fail(`${label} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

console.log("\nClient folder provisioning\n");

// ── 1. Branch routing never guesses ───────────────────────────
eq(cp.branchForMatterType("Unlawful Detainer"), "civil", "unlawful detainer -> civil");
eq(cp.branchForMatterType("Eviction - commercial"), "civil", "eviction -> civil");
eq(cp.branchForMatterType("Breach of contract"), "civil", "breach of contract -> civil");
eq(cp.branchForMatterType("Personal Injury"), "civil", "personal injury -> civil");
eq(cp.branchForMatterType("Asylum"), "immigration", "asylum -> immigration");
eq(cp.branchForMatterType("Removal Defense (EOIR)"), "immigration", "removal defense -> immigration");
eq(cp.branchForMatterType("I-485 Adjustment of Status"), "immigration", "adjustment -> immigration");
eq(cp.branchForMatterType("EB-5"), "immigration", "EB-5 -> immigration");
eq(cp.branchForMatterType("Writ of Mandamus - USCIS delay"), "immigration", "USCIS mandamus -> immigration");

// The New Case wizard sends these exact category keys. Three of them are
// plainly civil and used to fall through to "ask" because an underscore is a
// word character, so \btenant\b never matched inside "ll_tenant".
eq(cp.branchForMatterType("ll_tenant"), "civil", "wizard key ll_tenant -> civil");
eq(cp.branchForMatterType("real_estate"), "civil", "wizard key real_estate -> civil");
eq(cp.branchForMatterType("business"), "civil", "wizard key business -> civil");
eq(cp.branchForMatterType("pi"), "civil", "wizard key pi -> civil");
eq(cp.branchForMatterType("immigration"), "immigration", "wizard key immigration -> immigration");
// Still refused: these two fit neither root, and picking one would be inventing
// a filing convention rather than reading one.
eq(cp.branchForMatterType("estate"), null, "wizard key estate -> null (ask)");
eq(cp.branchForMatterType("tm"), null, "wizard key tm -> null (ask)");
// Hyphens are NOT normalised, because these depend on them.
eq(cp.branchForMatterType("EB-5 petition"), "immigration", "EB-5 still matches after separator handling");
eq(cp.branchForMatterType("u-visa"), "immigration", "u-visa still matches after separator handling");

// The ones that must refuse rather than pick.
eq(cp.branchForMatterType(""), null, "empty matter type -> null (ask)");
eq(cp.branchForMatterType(null), null, "null matter type -> null (ask)");
eq(cp.branchForMatterType("Contact"), null, "bare 'Contact' -> null (ask)");
eq(cp.branchForMatterType("Estate Planning"), null, "estate planning fits neither branch -> null (ask)");
eq(cp.branchForMatterType("immigration litigation"), null, "matches BOTH branches -> null (ask), never a coin flip");

// ── 2. The two branches get different subfolders ──────────────
const civilSubs = cp.subfoldersFor("civil");
const immSubs = cp.subfoldersFor("immigration");
if (Array.isArray(civilSubs) && civilSubs.length && Array.isArray(immSubs) && immSubs.length) {
  ok(`civil has ${civilSubs.length} subfolders, immigration has ${immSubs.length}`);
} else {
  fail("both branches must define a non-empty subfolder list");
}
if (JSON.stringify(civilSubs) === JSON.stringify(immSubs)) {
  fail("civil and immigration subfolder lists are identical — one of them is wrong");
} else {
  ok("civil and immigration subfolder lists differ");
}
if (civilSubs.includes("Pleadings") && civilSubs.includes("Discovery")) ok("civil list is the litigation set");
else fail("civil list should come from civil-provision's STANDARD_SUBFOLDERS");

// ── 3. Source invariants ──────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, "..", "client-provision.js"), "utf8");

// The roots argument is what makes the search hit the right tree. Drop it and
// a civil client is silently searched for among the immigration branches.
if (/findClientFolder\(\{[^}]*roots[^}]*\}\)/s.test(src)) ok("findClientFolder is called WITH roots");
else fail("findClientFolder must be called with roots, or civil clients get searched in the immigration tree");
if (/suggestClientFolders\(\{[^}]*roots[^}]*\}\)/s.test(src)) ok("suggestClientFolders is called WITH roots");
else fail("suggestClientFolders must be called with roots");

// Adopt-before-create, checked positionally: the needs_review branch has to be
// reached before the first createFolder, or ambiguity turns into a duplicate.
const needsReview = src.indexOf('action: "needs_review", candidates');
const firstCreate = src.indexOf("createFolder(path)");
if (needsReview === -1) fail('no needs_review return found');
else if (firstCreate === -1) fail("no createFolder call found");
else if (needsReview < firstCreate) ok("needs_review returns BEFORE any folder is created");
else fail("createFolder happens before the needs_review check — ambiguous matches would create duplicates");

// Civil must never quietly borrow the immigration roots.
const civilBlock = src.slice(src.indexOf('if (branch === "civil")'), src.indexOf("return { roots: null, error: `unknown branch"));
if (/getBranchRoots\(/.test(civilBlock)) fail("the civil branch falls back to getBranchRoots() — that files litigation in the immigration tree");
else ok("the civil branch never falls back to the immigration roots");

// dropbox-integration must still default to the immigration roots when no
// roots are passed, or every existing caller changes behaviour.
const dsrc = fs.readFileSync(path.join(__dirname, "..", "dropbox-integration.js"), "utf8");
if (/roots = null \}\) \{\s*(\/\/[^\n]*\n\s*)*\/\/[^\n]*\n?\s*const branches = roots && roots\.length \? roots : getBranchRoots\(\);/s.test(dsrc)
    || /const branches = roots && roots\.length \? roots : getBranchRoots\(\);/.test(dsrc)) {
  const n = (dsrc.match(/const branches = roots && roots\.length \? roots : getBranchRoots\(\);/g) || []).length;
  if (n === 2) ok("findClientFolder and suggestClientFolders both default to the immigration roots");
  else fail(`expected 2 roots-defaulting call sites in dropbox-integration.js, found ${n}`);
} else {
  fail("dropbox-integration.js must default to getBranchRoots() when roots is omitted");
}

// ── 4. The wiring in app-api.js ───────────────────────────────
const api = fs.readFileSync(path.join(__dirname, "..", "app-api.js"), "utf8");

// Both creation paths must provision, or a client created on one screen gets a
// folder and the same client created on the other silently does not.
const calls = (api.match(/provisionFolderSafely\(\{/g) || []).length;
if (calls >= 3) ok(`provisionFolderSafely is called ${calls}x (both creation endpoints + the retry endpoint)`);
else fail(`expected provisionFolderSafely on both creation endpoints and the retry endpoint, found ${calls} call(s)`);

if (/app\.post\("\/api\/staff\/clients\/:key\/provision-folder"/.test(api)) ok("the provision-folder retry endpoint exists");
else fail("no provision-folder endpoint — needs_review and needs_branch would have no way to be resolved");

// Registering the same path twice means the second copy is dead code, which has
// already happened 13 times elsewhere in this file.
const dupe = (api.match(/app\.post\("\/api\/staff\/clients\/:key\/provision-folder"/g) || []).length;
if (dupe === 1) ok("provision-folder is registered exactly once");
else fail(`provision-folder is registered ${dupe}x — Express keeps the first, the rest are dead`);

// Creating the client must not fail because Dropbox is down. The helper has to
// swallow both a missing module and a failing call.
const helper = api.slice(api.indexOf("async function provisionFolderSafely"), api.indexOf("app.post(\"/api/staff/clients/contact-only\""));
if ((helper.match(/catch \(e\)/g) || []).length >= 2) ok("provisionFolderSafely catches both a missing module and a failing call");
else fail("provisionFolderSafely must not let a Dropbox failure break client creation");
if (/action: "needs_branch"/.test(helper)) ok("an unknown practice area returns needs_branch instead of guessing");
else fail("provisionFolderSafely should return needs_branch rather than pick a branch");

// adopt_path arrives from the client. It must be checked against the branch
// roots BEFORE it is written, or a bad request maps a client onto any folder.
const iInside = api.indexOf("const inside = roots.some");
const iMap = api.indexOf("await dbx.setClientFolderMapping({\n          clientKey: key");
if (iInside === -1) fail("adopt_path is not validated against the branch roots");
else if (iMap === -1) fail("could not locate the adopt_path mapping write");
else if (iInside < iMap) ok("adopt_path is validated against the branch roots BEFORE being written");
else fail("adopt_path is written before it is validated — a bad path could map a client onto any folder");
if (/is not under a \$\{b\.branch\} root/.test(api)) ok("an out-of-root adopt_path is rejected with a reason");
else fail("rejecting an out-of-root adopt_path should say why");

// ── 5. skipSuggest: the "none of these, make a new one" escape ─────
// It exists so a person who reviewed the candidates can proceed. The danger is
// that it grows into a general "just create it" flag, which would hand a client
// a second, empty folder while their real one sits elsewhere. These pin it down.
const iSkipDecl  = src.indexOf("skipSuggest = false");
const iMapped    = src.indexOf('action: "already_mapped"');
const iAdopted   = src.indexOf('action: "adopted"');
const iSkipGuard = src.indexOf("if (!skipSuggest)");
if (iSkipDecl === -1) fail("provisionClientFolder should accept skipSuggest so a reviewed client can be created");
else ok("provisionClientFolder accepts skipSuggest");
if (iSkipGuard === -1) fail("skipSuggest is declared but never guards the suggestion step");
else if (iMapped !== -1 && iAdopted !== -1 && iMapped < iSkipGuard && iAdopted < iSkipGuard) {
  ok("skipSuggest skips ONLY the weak-candidate step — already_mapped and adopted still run first");
} else {
  fail("skipSuggest must sit after the already_mapped and confident-adopt steps, or it could orphan a folder the client is already in");
}
const iCreateFolderCall = src.indexOf("dbx.createFolder(path)");
if (iSkipGuard !== -1 && iCreateFolderCall !== -1 && iSkipGuard < iCreateFolderCall) {
  ok("the suggestion step is still positioned before any folder is created");
} else if (iSkipGuard !== -1) {
  fail("the suggestion step must come before createFolder");
}

// Only the retry endpoint may forward it. At creation time nobody has looked at
// the candidates yet, so contact-only must still stop on needs_review.
const iContactOnly = api.indexOf('app.post("/api/staff/clients/contact-only"');
const iProvisionEp = api.indexOf('app.post("/api/staff/clients/:key/provision-folder"');
if (iContactOnly !== -1 && iProvisionEp !== -1) {
  const contactBody = api.slice(iContactOnly, api.indexOf("app.post(\"/api/staff/clients/extract-agreement\""));
  if (/skipSuggest|create_new/.test(contactBody)) {
    fail("contact-only forwards create_new/skipSuggest — a brand new client would skip the duplicate check nobody has reviewed");
  } else {
    ok("contact-only does not forward create_new — creation still stops on possible duplicates");
  }
  if (/skipSuggest: b\.create_new === true/.test(api)) {
    ok("create_new is honoured only as a strict boolean true, on the retry endpoint");
  } else if (/create_new/.test(api)) {
    fail("create_new should be compared strictly to true, so a stray truthy value cannot force creation");
  } else {
    fail("the provision-folder endpoint has no create_new path — a reviewer who rejects every candidate would be stuck");
  }
}

// ── 6. The New Case wizard ────────────────────────────────────
// This is the path a client with a signed retainer actually comes in through,
// and it went without folder provisioning entirely until now.
const iInst = api.indexOf('app.post("/api/staff/matter-templates/:id/instantiate"');
if (iInst === -1) {
  fail("could not find the matter-template instantiate endpoint");
} else {
  // Slice to the NEXT route registration, not a magic character count: this
  // check already broke once when the endpoint grew past an arbitrary 4000.
  const nextRoute = api.indexOf("\n  app.", iInst + 10);
  const body = api.slice(iInst, nextRoute === -1 ? api.length : nextRoute);
  if (/provisionFolderSafely\(\{/.test(body)) ok("the New Case wizard provisions a client folder");
  else fail("the New Case wizard creates a case with no client folder - the one path a signed-retainer client uses");

  // Order matters: the tasks must be written first. Provisioning reaches
  // Dropbox, and a Dropbox outage must not cost somebody a case they just
  // walked a three-step wizard to create.
  const iInsert = body.indexOf("INSERT INTO tasks");
  const iProv = body.indexOf("provisionFolderSafely({");
  if (iInsert !== -1 && iProv !== -1 && iInsert < iProv) {
    ok("the wizard writes the tasks BEFORE it touches Dropbox");
  } else if (iProv !== -1) {
    fail("the wizard provisions before it writes the tasks - a Dropbox failure could lose the case");
  }

  // The template's matter type is the branch: nobody should be asked to pick a
  // practice area they already picked a template for.
  if (/hint: effectiveMatter/.test(body)) ok("the wizard takes the branch from the template's matter type");
  else fail("the wizard should use the template matter type as the branch hint rather than asking again");

  if (/\n\s*folder,\n/.test(body)) ok("the wizard returns the folder outcome so the app can finish filing");
  else fail("the wizard must return the folder outcome, or needs_review has nowhere to surface");
}

// ── 7. The broker level ───────────────────────────────────────
// The tree is <branch root>/<broker>/<client>: dropbox-integration scans two
// levels deep for exactly that reason. Creating at the root instead puts a new
// client BESIDE the brokers, where nobody looking for them will look.
if (/brokerFolder = null,/.test(src)) ok("provisionClientFolder accepts a broker folder");
else fail("provisionClientFolder cannot put a client inside a broker's folder");

// brokerFolder comes from a browser or a phone, so it is not trusted: a bad
// value could drop a client anywhere in the tree, including inside another
// client's folder.
const iCreate = src.indexOf("let parent = String(roots[0])");
const iMkdir = src.indexOf("dbx.createFolder(path)");
const iValidate = src.indexOf("const okParent = roots.some");
if (iValidate === -1) {
  fail("brokerFolder is used without being checked against the branch roots");
} else if (iMkdir !== -1 && iValidate < iMkdir) {
  ok("brokerFolder is validated BEFORE the folder is created");
} else {
  fail("brokerFolder must be validated before anything is written");
}
if (/want\.slice\(rt\.length \+ 1\)\.indexOf\("\/"\) === -1/.test(src)) {
  ok("a broker folder must be exactly one level under a root - not nested deeper");
} else {
  fail("a broker folder nested deeper than one level would let a client be filed inside another client");
}
if (/is not a broker folder directly under a/.test(src)) {
  ok("a rejected broker folder says why");
} else {
  fail("rejecting a broker folder should say why");
}

// The picker's data source.
if (/async function brokerFolders\(/.test(src)) ok("the broker folders under a branch can be listed");
else fail("no brokerFolders - a create-client form has nothing to offer");
if (/looks_like_client/.test(src)) {
  ok("folders named 'Last, First' are flagged as probable clients, not brokers");
} else {
  fail("the listing should flag folders that look like client folders");
}
// The comma is a guess. Nothing may be hidden on the strength of it.
const iBF = src.indexOf("async function brokerFolders(");
if (iBF !== -1) {
  const body = src.slice(iBF, src.indexOf("\nmodule.exports", iBF));
  if (/\.filter\([^)]*looks_like_client/.test(body)) {
    fail("brokerFolders must not drop folders on the strength of a comma - flag them, do not hide them");
  } else {
    ok("every folder is returned and flagged, none hidden on a guess");
  }
}

// Every creation path must be able to pass it, or one screen files correctly
// and another silently does not.
const iContact = api.indexOf('app.post("/api/staff/clients/contact-only"');
const iWizard = api.indexOf('app.post("/api/staff/matter-templates/:id/instantiate"');
for (const [label, i] of [["contact-only", iContact], ["the New Case wizard", iWizard]]) {
  if (i === -1) { fail(`could not find ${label}`); continue; }
  const next = api.indexOf("\n  app.", i + 10);
  const body = api.slice(i, next === -1 ? api.length : next);
  if (/brokerFolder: /.test(body)) ok(`${label} passes the broker folder through`);
  else fail(`${label} drops the broker folder - the client would be created at the root`);
}
if (/app\.get\("\/api\/staff\/dropbox\/brokers"/.test(api)) ok("the app can list broker folders");
else fail("the app has no way to list broker folders");

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CLIENT PROVISION CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
