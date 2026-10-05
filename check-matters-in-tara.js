/**
 * check-matters-in-tara.js
 *
 * JJ: "on the matter manager, i think we can archive that part and just
 * implement to Tara."  — and, asked what that should mean: move it into Tara:
 * the same matters and features, as a Tara page under Federal & TM in the
 * TEZ brand; the data stays where it is; reminders and the calendar keep
 * working; the old page redirects.
 *
 * The Matter Manager used to be a page of its own — its own masthead, its
 * own palette (oxblood on parchment), a monospace face, emoji for icons, and
 * one link back to "Admin". This pins what moving it into Tara means, so a
 * later edit to matters.html cannot quietly put the old page back.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const REPO = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(REPO, f), "utf8");

let failed = 0;
function check(name, fn) {
  let ok = false, err = null;
  try { ok = !!fn(); } catch (e) { err = e; }
  if (ok) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + (err ? " — " + err.message : "")); }
}

const html = read("matters.html");
const mm = read("matter-manager.js");
const nav = read("hearing-notes.js");
const server = read("server.js");
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

console.log("\nThe Matter Manager, inside Tara\n");

console.log("── 1. It is a Tara page ────────────────────────");
check("/admin/matters/ is drawn inside Tara's chrome, the docket in a frame", () =>
  /router\.get\("\/", requireAuth/.test(mm) && /renderAdminChrome\(\{\s*title: "Matter Manager"/.test(mm) && /<iframe src="\/admin\/matters\/app/.test(mm));
check("the docket itself is served for that frame only (this site may frame it; no other)", () =>
  /router\.get\("\/app", requireAuth/.test(mm) && /frame-ancestors 'self'/.test(mm) && /sendFile\(path\.join\(__dirname, "matters\.html"\)\)/.test(mm));
check("…and never from a stale cache after a deploy", () => (mm.match(/Cache-Control", "no-store"/g) || []).length >= 2);
check("opened by itself, the frame's address goes to the Tara page", () =>
  /window\.top !== window\.self/.test(js) && /location\.replace\('\/admin\/matters\/'/.test(js));
check("the preview that was never shipped (/v2) goes there too, instead of an error", () =>
  /router\.get\("\/v2", requireAuth, \(req, res\) => res\.redirect\("\/admin\/matters\/"\)\)/.test(mm) && !/matters-v2\.html/.test(mm));
check("a session that has ended sends the whole window to sign in, not the frame", () =>
  /\(window\.top \|\| window\)\.location\.href = '\/admin\/login/.test(js));
// It was admins only. JJ, asked whether staff need to see trademark matters
// now that they live here: "Yes they do." The gate that lets staff reach the
// TRADEMARK matters and nothing else is pinned in check-trademarks.js.
check("it is JJ's, behind the firm's sign-in; staff reach its trademark matters only", () =>
  /app\.use\("\/admin\/matters", matterAccess, matterManagerRouter\)/.test(server) && (mm.match(/requireAuth/g) || []).length > 30
  && /if \(user\.r === "admin"\) \{ req\.mmScope = "all"; req\.mmCanWrite = true; return next\(\); \}/.test(mm));
check("the daily Telegram summary still links to the same address", () => (server.match(/tezlaw-bot\.onrender\.com\/admin\/matters\//g) || []).length >= 3);
check("the API the docket talks to has not moved", () => js.includes("const API_BASE = '/admin/matters/api';"));

console.log("\n── 2. It is in the sidebar where it belongs ────");
const fed = nav.slice(nav.indexOf('id="section-federal"'), nav.indexOf('id="section-pi"'));
const adminSec = nav.slice(nav.indexOf('id="section-admin"'));
check("Matter Manager is under Federal & TM", () => /href="\/admin\/matters\/" class="nav-link[^"]*" data-perm="matters\.access"/.test(fed));
check("…with its inbox one click away", () => /href="\/admin\/matters\/\?view=inbox"/.test(fed) && /VIEWS = new Set\(\[[^\]]*"inbox"/.test(mm));
check("…and no longer tucked under Admin", () => !/\/admin\/matters\//.test(adminSec));
check("a view asked for in the address is one the docket has", () =>
  ["active", "inbox", "archive", "courts", "reference"].every(v => html.includes(`id="view-${v}"`) && mm.includes(`"${v}"`)) && /START_VIEW/.test(js));

console.log("\n── 3. It wears the firm's brand ────────────────");
const token = n => (css.match(new RegExp("--" + n + ":\\s*([^;]+);")) || [])[1];
check("Charcoal ink on Marble, Travertine rules", () => /#1E1B1A/i.test(token("ink")) && /#FAF8F5/i.test(token("paper")) && /#E8E3DC/i.test(token("paper-3")));
check("Ember for accents in text, Seal Orange for marks", () => /#A34C00/i.test(token("brand")) && /#FF7B00/i.test(token("mark")));
check("urgent and overdue stay red — an alarm must not look like decoration", () => /#9C2B1E/i.test(token("accent")) && /\.deadline\.passed:not\(\.done\) \.days \{ color:var\(--accent\)/.test(css));
check("Cormorant Garamond headlines, Montserrat everything else", () =>
  /Cormorant Garamond/.test(token("serif")) && /^Montserrat/.test(token("sans").trim()) && /^Montserrat/.test(token("mono").trim()));
check("the old faces and the old palette are gone", () =>
  !/JetBrains|Inter Tight/.test(html) && !/#7a1d1d|#f4f1ea|#8a6a1f|#0f1419/i.test(html));
check("dark ink, never white, on the orange", () => !/background:var\(--mark\);\s*color:(#fff|white|var\(--paper\))/.test(css));
check("no emoji standing in for icons", () => !/[\u{1F300}-\u{1FAFF}\u{2B50}\u{23F0}\u{23F3}\u{26A1}\u{270F}\u{2699}]/u.test(html));
check("inside Tara the old masthead is not drawn, and the link back to “Admin” is gone", () =>
  /html\.embed \.masthead \{ display:none; \}/.test(css) && !/nav-link-admin"/.test(html.slice(html.indexOf("<body>"))));

console.log("\n── 4. It still works ───────────────────────────");
check("the page's script parses", () => { new vm.Script(js, { filename: "matters.html <script>" }); return true; });
check("a calendar date is shown as the day it names, wherever the server is", () => {
  const ctx = {}; vm.createContext(ctx);
  const grab = name => { const i = js.indexOf("function " + name + "("); let depth = 0, j = js.indexOf("{", i); for (; j < js.length; j++) { if (js[j] === "{") depth++; else if (js[j] === "}" && --depth === 0) break; } return js.slice(i, j + 1); };
  vm.runInContext(grab("dayOnly") + grab("dayLabel"), ctx);
  // Midnight UTC, as a server in UTC sends a DATE column: still August 1.
  return vm.runInContext(`dayOnly("2026-08-01T00:00:00.000Z") === "2026-08-01" && dayLabel("2026-08-01T00:00:00.000Z") === "8/1/2026" && dayLabel("") === "—" && dayOnly("nonsense") === ""`, ctx);
});
check("…and the opened and triggering dates use it", () =>
  /created: dayOnly\(dbm\.opened_date\)/.test(js) && /trigger: dayOnly\(dbm\.triggering_date\)/.test(js) && !/new Date\(m\.(trigger|created)\)\.toLocaleDateString/.test(js));
check("every view, form and button the script reaches for is still in the page", () => {
  const ids = [...js.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]);
  // Ids built at run time (a matter's or a deadline's own) are made by the script itself.
  const made = id => js.includes(`id="${id}"`) || js.includes(`id='${id}'`) || new RegExp("id=\\\\?[\"']" + id.replace(/-\w*$/, "-")).test(js);
  const missing = [...new Set(ids)].filter(id => !html.includes(`id="${id}"`) && !made(id));
  if (missing.length) console.log("       missing: " + missing.slice(0, 8).join(", "));
  return ids.length > 50 && missing.length === 0;
});

console.log(failed ? `\n${failed} FAILED\n` : "\nALL MATTER MANAGER CHECKS PASSED\n");
process.exit(failed ? 1 : 0);
