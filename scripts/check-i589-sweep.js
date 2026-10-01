/**
 * check-i589-sweep.js
 *
 * JJ chose: report first, then apply. So the sweep must be incapable of
 * changing a client record on its own, and the review must be a real review
 * rather than a pre-ticked rubber stamp.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const REPO = path.join(__dirname, "..");
const sweep = fs.readFileSync(path.join(REPO, "i589-sweep.js"), "utf8");
const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const dbx = fs.readFileSync(path.join(REPO, "dropbox-integration.js"), "utf8");
const page = require("../i589-page");

console.log("\n── The sweep cannot change a client record ─────");
ok("scanning writes only to its own proposals table",
  !/client_contacts/.test(sweep.replace(/require\("\.\/client-contacts"\)\.get/g, "")) ||
  !/client-contacts"\)\.set/.test(sweep), "the sweep must not call contacts.set");
ok("it never updates hearing notes",
  !/UPDATE\s+hearing_notes/i.test(sweep) && !/UPDATE\s+individual_hearing_notes/i.test(sweep));
ok("applying is a separate route from scanning",
  /app\.post\("\/admin\/clients\/i589\/scan"/.test(srv) &&
  /app\.post\("\/admin\/clients\/i589\/apply"/.test(srv));
ok("only the apply route writes to the profile",
  /i589\/apply[\s\S]{0,900}client-contacts"\)\.set/.test(srv));
ok("an applied value is recorded as coming from the I-589, with the file",
  /source: "i589",[\s\S]{0,120}sourceDetail: p\.form_path/.test(srv));

console.log("\n── The review is a real review ─────────────────");
{
  const html = page.render({ prog: { mapped: 10, scanned: 2, remaining: 8, byStatus: { found: 1 } }, rows: [{
    client_key: "k", client_name: "Gao, Dongfang", status: "found", method: "fields",
    form_path: "/x/I-589.pdf", form_modified: "2025-04-02",
    found_phone: "626-555-0142", found_address: "1425 Cameron Avenue, West Covina, CA 91790",
    current_phone: "", current_address: "Los Angeles, CA",
    action: { phone: "626-555-0142", address: null, conflicts: [{ field: "address" }] }, notes: [],
  }] });
  ok("a blank field being filled is pre-ticked", /take_phone[^>]*checked/.test(html));
  ok("a CONFLICT is not pre-ticked — it has to be chosen",
    !/take_address[^>]*checked/.test(html));
  ok("the conflict shows what is already on file", /Los Angeles, CA/.test(html));
  ok("the source file is shown on the row", /I-589\.pdf/.test(html));
  // Compared against the page's own wording rather than a copy of it: the
  // labels gained an HTML entity and a third method (a scan, read by looking
  // at it) the day this was hardcoded, and a copy would only have gone stale.
  ok("how it was read is shown, so a text-extracted row can be weighted",
    Object.values(require("../i589-page").METHOD).some(w => html.includes(w)));
  ok("the page says item 9 is never used", /Item 9[\s\S]{0,80}never used/.test(html));
  ok("no inline JavaScript at all", !/onclick=|onchange=|<script/.test(html));

  const applied = page.render({ prog: { mapped: 1, scanned: 1, byStatus: {} }, rows: [{
    client_key: "k", client_name: "X", status: "found", found_phone: "1", current_phone: "",
    applied_at: "2026-09-29T12:00:00Z", applied_by: "jj", action: {}, notes: [],
  }] });
  ok("an applied row cannot be applied again", /disabled/.test(applied) && !/Apply to profile/.test(applied));

  const bad = page.render({ prog: { mapped: 1, scanned: 1, byStatus: {} }, rows: [{
    client_key: "k", client_name: "Y", status: "unreadable",
    notes: ["city could not be read from item 8"], partial: "9 Old Road, 91702",
  }] });
  ok("an unreadable form offers no Apply button", !/Apply to profile/.test(bad));
  ok("…but still shows what was partly read, for a human to finish",
    /9 Old Road/.test(bad) && /city could not be read/.test(bad));
}

console.log("\n── Finding the form at all ─────────────────────");
ok("subfolders are searched — an I-589 filed under Forms/ would otherwise "
 + "read as 'no I-589'", /listFolderDeep/.test(sweep) && /recursive: true/.test(dbx));
ok("the file is downloaded, not re-rendered through get_preview, which would "
 + "lose the form fields", /files\/download/.test(dbx) && /downloadFile/.test(sweep));
ok("form fields are read before the page text", 
  sweep.indexOf("getFields()") < sweep.indexOf('require("pdf-parse")'));
ok("only page 1 is parsed — item 8 is on it", /\{ max: 1 \}/.test(sweep));
ok("a PDF that is not fillable still gets read as text",
  /catch \{ \/\* not fillable/.test(sweep));

console.log("\n── Scale and safety ────────────────────────────");
ok("a scan is limited per press, because Dropbox is rate limited and a "
 + "request has a time limit", /Math\.min\(Math\.max\(parseInt\(req\.body\.limit/.test(srv));
ok("the limit is capped server-side", /, 100\)/.test(srv));
// Checked by behaviour rather than by quoting the expression: the query moved
// into a shared read when the retry mode was added, and a copy of the old line
// would have failed for a change that broke nothing.
ok("clients already looked at are not rescanned by default",
  /FROM i589_proposals/.test(sweep) &&
  /const done = new Set\(/.test(sweep) &&
  /out\.filter\(c => !done\.has\(c\.client_key\)\)/.test(sweep));
ok("progress is recorded so a sweep can be resumed",
  /async function progress/.test(sweep) && /i589_proposals/.test(sweep));
ok("the page is admin or manager only",
  /app\.use\("\/admin\/clients\/i589", auth\.requireRole\("admin", "manager"\)\)/.test(srv));
ok("…and that gate is registered before the routes it protects",
  srv.indexOf('app.use("/admin/clients/i589"') < srv.indexOf('app.get("/admin/clients/i589"'));

console.log("\n── The roster is the clients, not a cache ──────");
{
  ok("clients come from the hearing notes, the same source the client list uses",
    /FROM hearing_notes[\s\S]{0,200}UNION ALL[\s\S]{0,200}FROM individual_hearing_notes/.test(sweep));
  // Scoped to clientsToScan rather than the whole file. The rule this
  // protects is that the ROSTER must not come from the mapping cache — that
  // bug is what produced 237 proposal rows for 94 clients. Reading one
  // client's cached folder path elsewhere in the module is not that bug, and
  // a file-wide grep blocked inspectFolder from reporting which folder it
  // searched, which is the thing that tells a wrong-folder match apart from
  // a genuinely missing form.
  const roster = sweep.slice(sweep.indexOf("async function clientsToScan"),
                             sweep.indexOf("async function clientCount"));
  ok("clientsToScan does not build the roster from client_dropbox_mapping",
    roster.length > 200 && !/client_dropbox_mapping/.test(roster),
    "roster slice is " + roster.length + " chars");
  ok("…and the comment records why, so it is not 'simplified' back",
    /lazy CACHE/.test(sweep));
  ok("the client key is the shared one, so rows line up with contacts",
    /const \{ clientKey \} = require\("\.\/client-profiles"\)/.test(sweep));
  ok("a client whose folder was never resolved gets resolved during the sweep",
    /resolveClientFolder\(\{/.test(sweep));
  ok("…and a client with no findable folder is recorded as such, not as an error",
    /out\.status = "no_folder"/.test(sweep));
  ok("progress counts real clients", /clientCount\(\)/.test(sweep));

  const zero = page.render({ prog: { mapped: 10, scanned: 10, remaining: 0, byStatus: {} }, rows: [], ran: "0" });
  ok("a scan that finds nothing says WHY rather than looking broken",
    /Nothing to scan/.test(zero));
  ok("…and names where clients come from, so the cause is findable",
    /come from the hearing notes/.test(zero));
}

console.log("\n── It can actually be found ────────────────────");
{
  const cp = fs.readFileSync(path.join(REPO, "client-profiles.js"), "utf8");
  ok("the clients page links to it — it was reachable only by typing the URL",
    /href="\/admin\/clients\/i589"/.test(cp));
  ok("the link says what it does", /I-589 addresses/.test(cp));
  ok("the route is registered before /admin/clients/:key, or the literal path "
   + "would be swallowed by the wildcard",
    srv.indexOf('app.get("/admin/clients/i589"') < srv.indexOf('app.get("/admin/clients/:key"'));
}

console.log("\n── Rows that failed can be read again ─────────");
{
  // The bug this guards: an ordinary scan skips every client that already has
  // a proposal, so when the reader got better (scanned pages are now read by
  // looking at them) every row the old reader had given up on stayed
  // "unreadable" forever and pressing Scan appeared to do nothing at all.
  ok("clientsToScan takes a retry mode", /clientsToScan\(\{[^}]*retry = false/.test(sweep));
  ok("retry selects only the statuses a re-read could change",
    /RETRY_STATUSES = new Set\(\["unreadable", "error"\]\)/.test(sweep));

  const body = sweep.slice(sweep.indexOf("if (retry) {"), sweep.indexOf("// Skip the ones already looked at."));
  ok("in retry mode it returns ONLY the failed ones, not everything",
    /again\.has\(c\.client_key\)/.test(body));
  ok("...and is not confused with rescan, which starts over", /if \(rescan\) return out/.test(sweep));

  ok("nothing-was-found statuses are deliberately excluded",
    !/RETRY_STATUSES[^)]*no_form/.test(sweep) && !/RETRY_STATUSES[^)]*no_folder/.test(sweep));
  ok("an already-applied row is not offered for re-reading",
    /retryableCount[\s\S]{0,400}applied_at IS NULL/.test(sweep));

  ok("the route passes retry through", /retry = req\.body\.retry === "1"/.test(srv));
  ok("the route reports which mode ran", /mode=retry/.test(srv));

  const withRetry = page.render({
    prog: { mapped: 10, scanned: 10, remaining: 0, byStatus: { unreadable: 7 }, retryable: 7 },
    rows: [], ran: null });
  ok("the button appears when there is something to re-read", /name="retry" value="1"/.test(withRetry));
  // Asserts the COUNT reaches the label, not the sentence around it. The
  // wording changed once already (the 36 it offered were 27 unreadable plus 9
  // errors, which the old label called all unreadable).
  ok("...and says how many", /\b7 row\(s\)/.test(withRetry));

  const nothingToRetry = page.render({
    prog: { mapped: 10, scanned: 10, remaining: 0, byStatus: {}, retryable: 0 },
    rows: [], ran: null });
  ok("the button is hidden when nothing failed", !/name="retry"/.test(nothingToRetry));

  const ranNone = page.render({
    prog: { mapped: 10, scanned: 10, remaining: 0, byStatus: {}, retryable: 0 },
    rows: [], ran: "0", mode: "retry" });
  ok("a retry that found nothing says so in its own words",
    /Nothing left to re-read/.test(ranNone));
  ok("...and explains why no_form rows are not re-read", /nothing was\s+found to read/.test(ranNone));

  const ranNoneNormal = page.render({
    prog: { mapped: 10, scanned: 10, remaining: 0, byStatus: {}, retryable: 3 },
    rows: [], ran: "0" });
  ok("an ordinary scan that found nothing points at the re-read button",
    /Re-read the unreadable ones/.test(ranNoneNormal));
}

console.log("\n── More than one file gets a try ──────────────");
{
  const scan = sweep.slice(sweep.indexOf("async function scanOne"), sweep.indexOf("async function readPdf"));
  ok("the folder is ranked rather than reduced to one file", /x\.rankCandidates\(files\)/.test(scan));
  ok("each candidate is tried in turn", /for \(const pick of picks\)/.test(scan));
  ok("...and the loop stops the moment one works",
    /if \(one\.ok\) break;/.test(scan), "otherwise every folder pays for every candidate");
  ok("a row says when several files were tried and all failed",
    /tried \$\{picks\.length\} files in this folder/.test(scan));
  ok("an empty ranking is still no_form, not an error",
    /if \(!picks\.length\) \{\s*\n\s*out\.status = "no_form";/.test(scan));
  ok("the path recorded is the one actually read",
    scan.indexOf("out.form_path = pick.path") > scan.indexOf("for (const pick of picks)"));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL I-589 SWEEP CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
