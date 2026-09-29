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
  ok("how it was read is shown, so a text-extracted row can be weighted",
    /the form's own fields|the page text/.test(html));
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
ok("clients already looked at are not rescanned by default",
  /WHERE \$2 = true OR p\.client_key IS NULL/.test(sweep));
ok("progress is recorded so a sweep can be resumed",
  /async function progress/.test(sweep) && /i589_proposals/.test(sweep));
ok("the page is admin or manager only",
  /app\.use\("\/admin\/clients\/i589", auth\.requireRole\("admin", "manager"\)\)/.test(srv));
ok("…and that gate is registered before the routes it protects",
  srv.indexOf('app.use("/admin/clients/i589"') < srv.indexOf('app.get("/admin/clients/i589"'));

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL I-589 SWEEP CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
