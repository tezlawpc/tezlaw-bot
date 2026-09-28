/**
 * Does the JavaScript the BROWSER receives actually compile?
 *
 * These pages are built as template literals, so the file on disk and the
 * script the browser runs are not the same text. A backslash-escaped quote in
 * the source - \' - is eaten by the template literal and reaches the browser as
 * a bare quote, which ends the string early and kills the entire <script>.
 * Every function on the page goes with it.
 *
 * That happened: an inline onclick="...getElementById(\'ac_file\')..." on the
 * Add Client button took out the whole client list script, so the search box
 * silently stopped filtering 2,172 clients. The file parsed fine the whole
 * time, which is exactly why checking the file was not enough.
 *
 * So this renders the page and compiles what comes out.
 */
const path = require("path");

// This check renders a page, so it has to load client-profiles, which loads
// db.js, which wants pg. None of that is used - rendering touches no database -
// but the require chain still has to resolve, and the repo is deployed to
// Render rather than installed locally, so node_modules is often absent on the
// machine where somebody runs the checks. A check that only runs in one place
// is a check that does not run.
//
// So: stub ONLY what cannot be resolved, and only for bare module names. Real
// project files still load normally, which means this exercises the actual
// rendering code rather than a mock of it.
const Module = require("module");
const origLoad = Module._load;
const stubbed = new Set();
Module._load = function (request, parent, isMain) {
  try {
    return origLoad.apply(this, arguments);
  } catch (e) {
    if (e && e.code === "MODULE_NOT_FOUND" && !request.startsWith(".") && !request.startsWith("/")) {
      stubbed.add(request);
      const fn = () => fn;
      return new Proxy(fn, { get: () => fn, apply: () => fn });
    }
    throw e;
  }
};

let failures = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { failures++; console.log("  FAIL " + m); };

// One plausible client. The shapes matter: aggregateClients builds Sets.
const client = () => ({
  key: "wang-baohong", client_name: "Wang, Baohong", a_number: "A123-456-789",
  client_email: "b@example.com", client_phone: "626-555-0100", client_address: null,
  client_language: "Mandarin", case_types: ["Asylum"], judges: ["Bowen"],
  hearings: [], upcoming: [], deadlines: [], sent_count: 0, dropbox_path: "/Law ICAN Immigration/Law Patrick/Wang, Baohong",
});

function compileAll(label, html) {
  const blocks = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) { fail(`${label}: no inline scripts found - did the page render?`); return; }
  let bad = 0;
  blocks.forEach((b, i) => {
    try {
      new Function(b);
    } catch (e) {
      bad++;
      fail(`${label}: inline script ${i} does NOT compile in a browser - ${e.message}`);
    }
  });
  if (!bad) ok(`${label}: all ${blocks.length} inline script(s) compile as the browser gets them`);
}

console.log("\nRendered page scripts\n");

const cp = require(path.join(__dirname, "..", "client-profiles.js"));
try {
  compileAll("/admin/clients", cp.renderClientList([client()]));
} catch (e) {
  fail(`/admin/clients did not render at all: ${e.message}`);
}

// The escape that caused it, called out by name so the fix cannot quietly
// come back: inside a template literal, \' reaches the browser as a bare '.
const fs = require("fs");
const src = fs.readFileSync(path.join(__dirname, "..", "client-profiles.js"), "utf8");
// A SINGLE backslash before the quote is the bug: the template literal eats it.
// A DOUBLE backslash is correct - it renders as \' and the browser sees a
// properly escaped quote. The lookbehind is what tells the two apart, and
// getting that wrong once already flagged working code as broken.
const singleEscaped = /onclick="[^"]*(?<!\\)\\'/;
if (singleEscaped.test(src)) {
  fail("an inline onclick uses a single-backslash \\' inside a template literal - the backslash is eaten and the quote ends the string early");
} else {
  ok("no inline handler relies on a single-backslash quote inside a template literal");
}

if (stubbed.size) console.log("\n  (stubbed missing deps, not used for rendering: " + [...stubbed].join(", ") + ")");

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL RENDERED-SCRIPT CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
