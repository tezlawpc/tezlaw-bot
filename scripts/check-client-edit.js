/**
 * check-client-edit.js
 * ─────────────────────────────────────────────────────────
 * What a person can correct on a client's profile, and what they cannot.
 *
 * "i should be able to edit client's info in client's portal" (JJ,
 * 2026-10-09). The card showed Name, A-Number, Email, Phone, Address and
 * Language, and the form underneath it edited two of them. Email was the
 * sharp edge: client_contacts could already store one, the page displayed
 * one, and there was no box to change it -- so a wrong address could be
 * fixed and a wrong email could not.
 *
 * Name and A-Number are deliberately still read-only. They are what the
 * file is addressed by: clientKey() builds the profile's URL and the
 * grouping key out of the A-number, or out of the name when there is no
 * A-number. Storing a different one would leave the page showing one
 * identity while the aggregation still grouped the notes under the other.
 * This file pins that down so "edit client info" does not quietly grow to
 * include them without the re-key that would have to come with it.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const CP = require(path.join(ROOT, "client-profiles.js"));
const CC = require(path.join(ROOT, "client-contacts.js"));

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (err) { console.log("  FAIL  " + name); throw err; }
  console.log("  ok  " + name);
  passed++;
}

console.log("\nCorrecting a client's details\n");

const client = {
  key: "a-201555444", client_name: "Chen, Peng", a_number: "A201555444",
  client_email: "chen@example.com", client_phone: "626-555-0100",
  client_address: "1 Main St, West Covina, CA 91792", client_language: "zh",
  case_types: [], judges: [], hearings: [], upcoming: [], deadlines: [],
  sent_count: 0, hearing_count: 0, most_recent_date: null,
  most_recent_disposition: null,
  contact_source: "manual", contact_updated_at: "2026-10-09T22:00:00.000Z",
};
const page = CP.renderClientDetail(client, { documents: [] });

check("every detail the card shows has a box to change it", () => {
  // The four the store can hold. Each needs an input the form posts.
  for (const name of ["phone", "email", "address", "language"]) {
    assert.ok(new RegExp(`name="${name}"`).test(page),
      `the profile shows a value with no way to correct it: ${name}`);
  }
});

check("the boxes arrive holding what is on file", () => {
  // An edit form that opens empty is a delete button with a Save label.
  assert.ok(page.includes('value="626-555-0100"'), "the phone box is empty");
  assert.ok(page.includes('value="chen@example.com"'), "the email box is empty");
  assert.ok(page.includes('value="1 Main St, West Covina, CA 91792"'), "the address box is empty");
  assert.ok(/<option value="zh" selected>/.test(page), "the language is not preselected");
});

check("the store writes exactly the fields the form offers", () => {
  assert.deepStrictEqual(CC.WRITABLE, ["phone", "address", "email", "language"],
    "the form and the store disagree about what is editable");
});

check("the name and the A-Number are not editable here", () => {
  // Not an oversight. See client-contacts.js WRITABLE.
  assert.ok(!CC.WRITABLE.includes("a_number"), "the A-number became writable without a re-key");
  assert.ok(!CC.WRITABLE.includes("client_name") && !CC.WRITABLE.includes("name"),
    "the name became writable without a re-key");
  assert.ok(!/name="a_number"/.test(page) && !/name="client_name"/.test(page),
    "the profile offers to edit the identity it is filed under");
  assert.ok(/not edited here/.test(page), "the page does not say why they cannot be edited");
});

check("the route passes through only what was posted", () => {
  // set() reads an empty string as "clear this" and undefined as "leave it
  // alone". Handing it a key the form did not post wipes a stored value.
  const src = read("server.js");
  const i = src.indexOf('app.post("/admin/clients/:key/contact"');
  assert.ok(i > -1, "the save route is gone");
  const route = src.slice(i, i + 2000);
  assert.ok(/hasOwnProperty\.call\(b, key\)/.test(route),
    "the route passes fields the form may not have posted, which clears them");
  assert.ok(/CC\.WRITABLE/.test(route),
    "the route has its own list of fields instead of the store's");
});

check("a language the app cannot speak is not stored", () => {
  // It would reach a message builder, match no branch, and fall through
  // silently -- a client written to in a language nobody chose.
  const src = read("server.js");
  const i = src.indexOf('app.post("/admin/clients/:key/contact"');
  const route = src.slice(i, i + 2000);
  assert.ok(/\["en", "zh", "es", "hi", "pa"\]\.includes/.test(route),
    "any string can be saved as the client's language");
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:client-edit"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-client-edit.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-client-edit.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
