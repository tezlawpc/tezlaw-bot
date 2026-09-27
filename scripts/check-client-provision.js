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

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CLIENT PROVISION CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
