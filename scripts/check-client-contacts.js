/**
 * check-client-contacts.js
 *
 * JJ, shown a client profile: "every client have a profile. enter the info
 * there."
 *
 * The profile page had Phone and Address fields with nothing behind them —
 * both were read out of whatever hearing note happened to mention them, which
 * is how a profile ends up showing "Los Angeles, CA" with no street and
 * nobody able to correct it.
 *
 * Current details now live in client_contacts and are laid over the
 * note-derived values. The hearing notes themselves are never touched: a note
 * is a contemporaneous record, and rewriting a 2023 note with a 2026 address
 * falsifies it.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const REPO = path.join(__dirname, "..");
const cc = require("../client-contacts");
const cp = fs.readFileSync(path.join(REPO, "client-profiles.js"), "utf8");
const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const src = fs.readFileSync(path.join(REPO, "client-contacts.js"), "utf8");

console.log("\n── Stored details win, notes show through ──────");
{
  const fromNotes = () => ({
    key: "gao-dongfang", client_name: "Gao, Dongfang",
    client_phone: null, client_address: "Los Angeles, CA", client_email: "old@x.com",
  });

  const c1 = cc.apply(fromNotes(), { phone: "626-555-0142", address: "1425 Cameron Avenue, West Covina, CA 91790", source: "i589" });
  ok("a stored address replaces the one scraped from a hearing note",
    c1.client_address === "1425 Cameron Avenue, West Covina, CA 91790", c1.client_address);
  ok("a stored phone fills an empty one", c1.client_phone === "626-555-0142");
  ok("a field with no stored value still shows what the notes said",
    c1.client_email === "old@x.com", c1.client_email);
  ok("where the value came from travels with it", c1.contact_source === "i589");

  const c2 = cc.apply(fromNotes(), { phone: "626-555-0142", source: "manual" });
  ok("storing only a phone does not blank the address",
    c2.client_address === "Los Angeles, CA", c2.client_address);
  ok("a manual value is not labelled as unconfirmed", c2.contact_source === "manual");

  const c3 = cc.apply(fromNotes(), null);
  ok("a client with nothing stored is returned untouched",
    c3.client_address === "Los Angeles, CA" && !c3.contact_source);

  const c4 = cc.apply(fromNotes(), { phone: "", address: "", source: "i589" });
  ok("empty stored values do not blank out what the notes had",
    c4.client_address === "Los Angeles, CA" && !c4.contact_source);
}

console.log("\n── Hearing notes are never rewritten ───────────");
ok("nothing here updates hearing_notes",
  !/UPDATE\s+hearing_notes/i.test(src) && !/UPDATE\s+individual_hearing_notes/i.test(src));
ok("the overlay is applied in memory, after the notes are read",
  /const contacts = await require\("\.\/client-contacts"\)\.all\(\)/.test(cp));
ok("…as ONE query for the whole book, not one per client",
  /\.all\(\)/.test(cp) && !/for \(const c of results\)[\s\S]{0,80}await/.test(cp));
// Sliced between landmarks rather than matched inside a fixed character
// window: a comment added between the two would break a window, and a check
// that fails for an unrelated edit stops being believed.
{
  const i = cp.indexOf('require("./client-contacts").all()');
  const j = i < 0 ? -1 : cp.indexOf("contacts overlay", i);
  ok("a contacts failure leaves the client list working",
    i > -1 && j > i && /catch\s*\(/.test(cp.slice(i, j)),
    i < 0 ? "the overlay call is missing" : "no catch between the call and the warning");
}

console.log("\n── Writing is precise ──────────────────────────");
ok("only the fields passed are written",
  /if \(fields\[key\] === undefined\) continue;/.test(src));
ok("an explicit empty string can still clear a field",
  /String\(fields\[key\] == null \? "" : fields\[key\]\)\.trim\(\) \|\| null/.test(src));
ok("a write with nothing in it does not wipe the row",
  /if \(!cols\.length\) return await get\(clientKey\);/.test(src));
ok("every value records where it came from",
  /source_detail/.test(src) && /source_date/.test(src));
ok("an import can be removed without touching anything else",
  /DELETE FROM client_contacts WHERE client_key/.test(src));

console.log("\n── The profile page can be edited ──────────────");
ok("phone and address are editable on the profile",
  /action="\/admin\/clients\/\$\{escapeAttr\(client\.key\)\}\/contact"/.test(cp));
ok("a value read off a form is labelled as not yet confirmed",
  /not yet confirmed with the client/.test(cp));
ok("…and a hand-typed one is not labelled",
  /client\.contact_source !== "manual"/.test(cp));
ok("the save route is registered BEFORE /admin/clients/:key, or the literal "
 + "path would never match",
  srv.indexOf('app.post("/admin/clients/:key/contact"') < srv.indexOf('app.get("/admin/clients/:key"'));
ok("a hand edit is recorded as manual, not attributed to a document",
  /source: "manual", by: \(req\.user && req\.user\.u\)/.test(srv));

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CLIENT CONTACT CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
