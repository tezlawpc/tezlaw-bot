/**
 * check-broker-accounts.js
 *
 * JJ: "when creating consultants/brokers, only allow the one in dropbox
 * folder."
 *
 * The rule has to hold on the SERVER, not merely in the dropdown, or it is
 * decoration. And the derived assignment has to be conservative in three
 * specific ways, each pinned below, because getting any of them wrong hands
 * one broker another broker's client list.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const REPO = path.join(__dirname, "..");
const ba = require("../broker-accounts");
const auth = fs.readFileSync(path.join(REPO, "auth.js"), "utf8");
const src = fs.readFileSync(path.join(REPO, "broker-accounts.js"), "utf8");
const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");

console.log("\n── Which folder is a client's broker ────────────");
for (const [p, want] of [
  ["/Immigration/Law Patrick/Wang, Baohong", "Law Patrick"],
  ["/TEZ Dropbox/Civil/ABC Realty/Chen, Wei", "ABC Realty"],
  ["/Immigration/Li, Junwei", null],          // filed straight under the root
  ["/lone", null],
  ["", null],
  [null, null],
]) ok(`${JSON.stringify(p)} → ${JSON.stringify(want)}`, ba.brokerOfPath(p) === want, JSON.stringify(ba.brokerOfPath(p)));

ok("a client filed directly under a branch root has NO broker, so they are "
 + "never handed to whoever shares the root's name",
  ba.brokerOfPath("/Immigration/Li, Junwei") === null);

console.log("\n── Only a real folder can become a login ────────");
ok("the rule is enforced on the server, not just offered in the dropdown",
  /if \(role === "consultant"\)[\s\S]{0,200}canonicalName\(req\.body\.broker_folder\)/.test(auth));
ok("…and creation is refused when it does not match",
  /is not a broker folder in Dropbox/.test(auth));
ok("the refusal says what to do about it",
  /create the folder first and then add the login/.test(auth));
ok("the match is case-insensitive, so capitalisation is not a trap",
  /f\.name\.toLowerCase\(\) === want/.test(src));
ok("the canonical Dropbox spelling is what gets stored, not what was typed",
  /return hit \? hit\.name : null/.test(src));
ok("client folders (\"Last, First\") are EXCLUDED from the broker list, not "
 + "merely sorted last", /if \(f\.looks_like_client\) continue;/.test(src));
ok("both branches are read, and one broker in both is still one person",
  /for \(const branch of \["immigration", "civil"\]\)/.test(src) && /seen\.has\(key\)/.test(src));
ok("Dropbox being unreachable does not take the user-admin page down",
  /try \{[\s\S]{0,200}allFolders\(\)[\s\S]{0,200}catch/.test(auth));
ok("…and says so instead of silently offering an empty list",
  /a Consultant account cannot be created right now/.test(auth));

console.log("\n── Assignment is derived, and conservative ──────");
ok("clients under the folder are linked when the account is created",
  /linkClients\(user\.id, folder/.test(auth));
ok("a consultant already linked to a client is not linked twice",
  /consultant_id = \$2 AND removed_at IS NULL LIMIT 1/.test(src));
ok("a consultant deliberately REMOVED from a client is not quietly re-added",
  /removed_at IS NOT NULL LIMIT 1/.test(src) && /Leave it removed/.test(src));
ok("the sweep only ever adds links",
  !/DELETE FROM client_consultants/.test(src) && !/UPDATE client_consultants/.test(src));
ok("each derived link records where it came from",
  /Derived from the Dropbox folder/.test(src));
ok("the sweep can be re-run as new clients are filed", typeof ba.relinkAll === "function");
ok("…and there is a button for it", /\/admin\/alerts\/relink/.test(srv) && /relinkAll/.test(srv));
ok("the relink route is behind the same admin-or-manager gate as the page",
  srv.indexOf('app.use("/admin/alerts", auth.requireRole("admin", "manager"))') <
  srv.indexOf('app.post("/admin/alerts/relink"'));

console.log("\n── It is visible when it has not worked ─────────");
const na = fs.readFileSync(path.join(REPO, "notify-admin.js"), "utf8");
ok("a consultant with no folder is flagged", /No Dropbox folder linked/.test(na));
ok("a folder that produced no clients is flagged too, rather than looking fine",
  /Folder linked but no clients found in it yet/.test(na));

console.log("\n── Every broker question is a dropdown ─────────");
{
  // JJ: "whenever any question asks for consultant or broker, always have the
  // dropdown to select the existing broker." Free text meant the same broker
  // was spelled three ways and none of them matched the Dropbox folder.
  const files = {
    "server.js (new matter)": srv,
    "personal-injury-ui.js (case edit)": fs.readFileSync(path.join(REPO, "personal-injury-ui.js"), "utf8"),
    "client-profiles.js (add client)": fs.readFileSync(path.join(REPO, "client-profiles.js"), "utf8"),
  };
  for (const [label, text] of Object.entries(files)) {
    const freeText = /<input[^>]*name="referral_source"[^>]*type="text"|<input[^>]*type="text"[^>]*name="referral_source"|id="ac_referral"/.test(text);
    ok(`${label} no longer asks for a broker as free text`, !freeText);
  }
  ok("the new-matter form uses the shared broker dropdown",
    /selectHTML\(\{ name: "referral_source"/.test(srv));
  ok("the PI case edit uses it too",
    /selectHTML\(\{ name: "referral_source"/.test(files["personal-injury-ui.js (case edit)"]));
  ok("the add-client modal derives the referral from the broker it already asked for",
    /referral_source: acBrokerName\(\)/.test(files["client-profiles.js (add client)"]));

  ok("an existing value that is not a Dropbox folder is KEPT, not silently "
   + "dropped when an old record is edited",
    /not a Dropbox folder<\/option>/.test(src) && /current && !known/.test(src));
  ok("…and Dropbox being down falls back to a text box rather than an empty "
   + "dropdown that would erase the value",
    /if \(!folders\.length\) \{[\s\S]{0,200}<input type="text"/.test(src));
  ok("the dropdown preserves the current selection",
    /f\.name\.toLowerCase\(\) === current\.toLowerCase\(\) \? " selected"/.test(src));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL BROKER ACCOUNT CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
