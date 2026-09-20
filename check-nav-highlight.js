/**
 * check-nav-highlight.js
 *
 * The sidebar highlight used to be decided entirely server-side, and 43 of
 * the 65 nav links never called isActive() at all. The visible symptom: click
 * Intake, Pleadings or Discovery and the highlight stayed on "All Cases",
 * because the civil stage route passes activeItem "civil". You could not tell
 * from the sidebar which page you were on.
 *
 * It is now derived from the URL, client-side. This loads the REAL admin
 * chrome into jsdom, sets a real location, runs the page's own script, and
 * asserts exactly one link lights up — the right one.
 */
const { JSDOM } = require("jsdom");
const Module = require("module");
const path = require("path");

// Stub what renderAdminChrome pulls in.
const origLoad = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./db") return { query: async () => ({ rows: [] }) };
  return origLoad.call(this, r, ...rest);
};
const chrome = require("../hearing-notes");
Module._load = origLoad;

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const v = fn(); ok = v === true || v === undefined; if (v && v !== true) detail = String(v); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// Render the chrome once; every case reuses the same markup with a different URL.
const html = chrome.renderAdminChrome({
  title: "Test",
  body: "<div>body</div>",
  activeItem: "civil",          // what the stage route actually passes
});

function activeFor(url) {
  const dom = new JSDOM(html, {
    url: "https://tezlaw-bot.onrender.com" + url,
    runScripts: "outside-only",
  });
  const { window } = dom;
  // whoami is irrelevant to highlighting; stub it so the script doesn't hang.
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve({ authenticated: false }) });
  window.navigator.serviceWorker = undefined;

  // Run only the page's own inline scripts.
  const scripts = Array.from(window.document.querySelectorAll("script:not([src])"));
  for (const s of scripts) {
    try { window.eval(s.textContent); } catch (e) { /* unrelated blocks may need DOM we lack */ }
  }
  const act = Array.from(window.document.querySelectorAll(".nav-link.active"));
  return act.map(a => a.getAttribute("href"));
}

console.log("\nExactly one nav item lights up, and it is the right one");

// The bug as reported: every civil stage tab left the highlight on All Cases.
const stages = ["intake", "pre_filing", "pleadings", "discovery", "motions",
                "trial_prep", "trial", "post_trial", "closed"];
for (const s of stages) {
  const url = "/admin/civil/stage/" + s;
  const act = activeFor(url);
  check(`${url} → exactly one active`, () => act.length === 1 || `got ${act.length}: ${act}`);
  check(`  ↳ it is the ${s} link, not All Cases`, () => act[0] === url || `got ${act[0]}`);
}

console.log("\nThe other civil pages");
for (const [url, want] of Object.entries({
  "/admin/civil": "/admin/civil",
  "/admin/civil/triage": "/admin/civil/triage",
  "/admin/civil/wip": "/admin/civil/wip",
  "/admin/civil/dropbox": "/admin/civil/dropbox",
})) {
  const act = activeFor(url);
  check(`${url} → ${want}`, () => act.length === 1 && act[0] === want || `got ${act}`);
}

console.log("\nA page with no nav entry of its own falls back to its parent");
{
  // A case detail page is not in the nav. It should light up All Cases rather
  // than going blank — the longest matching prefix wins.
  const act = activeFor("/admin/civil/case/216");
  check("/admin/civil/case/216 → All Cases", () => act.length === 1 && act[0] === "/admin/civil" || `got ${act}`);
}

console.log("\nQuery-string links are distinguished from their base page");
for (const [url, want] of Object.entries({
  "/admin/federal": "/admin/federal",
  "/admin/federal?group=trademarks": "/admin/federal?group=trademarks",
  "/admin/federal?group=federal_court": "/admin/federal?group=federal_court",
  "/admin/federal?overdue=1": "/admin/federal?overdue=1",
})) {
  const act = activeFor(url);
  check(`${url} → ${want}`, () => act.length === 1 && act[0] === want || `got ${act}`);
}

console.log("\nHash links too — Zara's tabs never reload the page");
for (const [url, want] of Object.entries({
  "/admin/zara": "/admin/zara",
  "/admin/zara#lessons": "/admin/zara#lessons",
  "/admin/zara#health": "/admin/zara#health",
})) {
  const act = activeFor(url);
  check(`${url} → ${want}`, () => act.length === 1 && act[0] === want || `got ${act}`);
}

console.log("\nThe regression that started this");
{
  // renderAdminChrome is called with activeItem "civil" on every stage page.
  // The URL must win over that, or we are back where we started.
  const act = activeFor("/admin/civil/stage/discovery");
  check("a server-set activeItem does not override the URL",
    () => act.length === 1 && act[0] === "/admin/civil/stage/discovery" || `got ${act}`);
  check("and All Cases is NOT left highlighted",
    () => !act.includes("/admin/civil"));
}

console.log("\n" + (failures ? `${failures} FAILED` : "ALL NAV-HIGHLIGHT CHECKS PASSED"));
process.exit(failures ? 1 : 0);
