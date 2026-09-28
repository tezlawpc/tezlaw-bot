/**
 * The WEB add-client surfaces: /admin/clients and the consultant portal.
 *
 * These exist because the app's equivalents are bearer-only and a browser
 * session cannot reach them. That split is the thing worth guarding: it is easy
 * to fix a bug on one surface and leave the other one wrong, which is exactly
 * how the web page ended up creating clients with no Dropbox folder for months
 * while the app created them correctly.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { failures++; console.log("  FAIL " + m); };

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const profiles = fs.readFileSync(path.join(root, "client-profiles.js"), "utf8");
const consultant = fs.readFileSync(path.join(root, "public", "consultant-clients.js"), "utf8");

console.log("\nWeb add-client\n");

// ── The extraction endpoints the browser can actually reach ──
if (/app\.post\("\/admin\/clients\/extract-agreement"/.test(server)) {
  ok("the admin page has an extraction endpoint it can reach with its cookie");
} else {
  fail("no /admin/clients/extract-agreement - the web Add Client form has nothing to call");
}
if (/app\.post\("\/consultant\/clients\/extract-agreement"/.test(server)) {
  ok("the consultant portal has one too");
} else {
  fail("no /consultant/clients/extract-agreement");
}

// A consultant is an outside referrer. Reading a client's name off an agreement
// saves them typing; reading what the firm charges that client is not theirs.
// The strip must happen on the SERVER - a field hidden in the page is not a
// boundary, it is a field somebody can open devtools and read.
const iCons = server.indexOf('app.post("/consultant/clients/extract-agreement"');
if (iCons === -1) {
  fail("cannot check the consultant fee-term boundary - endpoint missing");
} else {
  const body = server.slice(iCons, server.indexOf("\napp.", iCons + 10));
  if (/fee_terms:\s*\{\}/.test(body)) {
    ok("the consultant response carries NO fee terms - stripped server-side");
  } else if (/fee_terms/.test(body)) {
    fail("the consultant endpoint returns fee terms - an outside referrer must not see what the firm charges");
  } else {
    fail("could not confirm the consultant endpoint strips fee terms");
  }
  if (/requireConsultant/.test(server.slice(iCons - 200, iCons + 200))) {
    ok("the consultant endpoint is behind requireConsultant");
  } else {
    fail("the consultant extraction endpoint has no consultant auth");
  }
}

// ── The web add-contact must provision, like every other creation path ──
const iAdd = server.indexOf('app.post("/admin/clients/add-contact"');
if (iAdd === -1) {
  fail("could not find /admin/clients/add-contact");
} else {
  const body = server.slice(iAdd, server.indexOf("\napp.", iAdd + 10));
  if (/provisionClientFolder\(/.test(body)) {
    ok("the web Add Client creates a client folder");
  } else {
    fail("the web Add Client still creates clients with nowhere to put their paper");
  }
  const iInsert = body.indexOf("INSERT INTO tasks");
  const iProv = body.indexOf("provisionClientFolder(");
  if (iInsert !== -1 && iProv !== -1 && iInsert < iProv) {
    ok("the row is written BEFORE Dropbox is touched");
  } else if (iProv !== -1) {
    fail("provisioning runs before the insert - a Dropbox failure could lose the client");
  }
  if (/action: "needs_branch"/.test(body)) {
    ok("an unknown practice area returns needs_branch rather than a guess");
  } else {
    fail("the web endpoint should return needs_branch rather than pick a branch");
  }
}

// ── adopt_path from a browser is untrusted ──
const iProvEp = server.indexOf('app.post("/admin/clients/:key/provision-folder"');
if (iProvEp === -1) {
  fail("no web provision-folder endpoint - needs_review would have no way to be resolved from the page");
} else {
  const body = server.slice(iProvEp, server.indexOf("\napp.", iProvEp + 10));
  const iCheck = body.indexOf("const inside = roots.some");
  const iWrite = body.indexOf("setClientFolderMapping");
  if (iCheck !== -1 && iWrite !== -1 && iCheck < iWrite) {
    ok("adopt_path is validated against the branch roots BEFORE it is written");
  } else {
    fail("adopt_path must be checked against the branch roots before any mapping is written");
  }
  if (/skipSuggest: b\.create_new === true/.test(body)) {
    ok("create_new is honoured only as a strict boolean true");
  } else {
    fail("create_new should be compared strictly to true so a stray truthy value cannot force creation");
  }
}

// ── The page must not skip the duplicate check nobody has reviewed ──
// needs_branch means no candidates were ever shown. Sending create_new there
// would skip the duplicate scan on a client nobody has looked at.
if (/function acfResolve\(\) \{ acfCall\(\{\}\); \}/.test(profiles)) {
  ok("the page has a resolve path that does NOT set create_new");
} else {
  fail("the needs_branch button must call a resolver that omits create_new");
}
const iBranchBtn = profiles.indexOf("Find or create the folder");
if (iBranchBtn !== -1) {
  const around = profiles.slice(iBranchBtn - 400, iBranchBtn);
  if (/acfResolve\(\)/.test(around)) {
    ok("the needs_branch button calls acfResolve, not acfCreateNew");
  } else {
    fail("the needs_branch button skips the duplicate check - nobody has reviewed candidates for that client");
  }
}
if (/function acfCreateNew\(\) \{ acfCall\(\{ create_new: true \}\); \}/.test(profiles)) {
  ok("create_new is reachable only from the 'none of these' button");
} else {
  fail("could not confirm create_new is limited to the reviewed-candidates path");
}

// ── Fee terms start unticked on the page that shows them ──
// The asymmetry is the safety property, not a default worth tidying away.
if (/rows\(fees, false,/.test(profiles)) {
  ok("fee terms start UNTICKED in the admin modal");
} else {
  fail("fee terms must start unticked - confirming has to be a real check against the document");
}
if (/rows\(ids, true,/.test(profiles)) {
  ok("client details start ticked");
} else {
  fail("client details should start ticked");
}
if (/if \(!empty && c\.quote\)/.test(profiles)) {
  ok("only values the extractor could QUOTE are offered in the admin modal");
} else {
  fail("the admin modal must offer only quoted values");
}
if (/!c\.quote\) return;/.test(consultant)) {
  ok("only quoted values are offered in the consultant portal");
} else {
  fail("the consultant portal must offer only quoted values");
}

// ── Per-client state must not leak between modal opens ──
if (/acBranch = null; acFileName = ""; window\.__acProposal = null;/.test(profiles)) {
  ok("the modal resets its state on open, so one client cannot inherit another's branch");
} else {
  fail("the modal must reset acBranch/acProposal on open");
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL WEB ADD-CLIENT CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
