/**
 * check-public-terms.js
 *
 * /legal/terms exists for one reason: Intuit's production-key questionnaire
 * requires an end-user licence agreement URL that their reviewer can open.
 * Three things about it have to stay true, and each would fail silently.
 *
 *   1. IT MUST BE PUBLIC. If it ever ends up behind the /admin gate, Intuit's
 *      reviewer sees a login page, the submission is rejected, and the only
 *      symptom is a rejection email weeks later.
 *   2. IT MUST CARRY NO INLINE SCRIPT. Same template-literal trap as every
 *      other page in this file.
 *   3. IT MUST NOT READ AS ADVERTISING. The firm has a live State Bar
 *      advertising matter (25-O-27445). This page is hosted on the app rather
 *      than tezlawfirm.com precisely so it stays out of that; it must not
 *      drift into soliciting clients or describing legal services for sale.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const at = srv.indexOf('app.get("/legal/terms"');
ok("the terms page exists", at > 0);

if (at > 0) {
  const next = srv.indexOf("\napp.", at + 10);
  const route = srv.slice(at, next > 0 ? next : srv.length);

  // 1. Public.
  ok("it is not mounted under /admin", !/app\.get\("\/admin\/legal\/terms"/.test(srv));
  const gates = [...srv.matchAll(/app\.use\((?:"([^"]*)",\s*)?auth\./g)].map(m => m[1] || "(global)");
  // Scoped UNDER /admin, not equal to it — several gates guard deeper paths
  // like /admin/clients/i589. The property that matters is that no gate is
  // global or mounted anywhere a public page could fall under.
  ok("every auth gate is scoped under /admin, so a public page stays public",
     gates.length > 0 && gates.every(g => g.startsWith("/admin")),
     gates.filter(g => !g.startsWith("/admin")).join(", ") || gates.length + " gates");

  // 2. No inline script.
  ok("it carries no inline <script>", !/<script/i.test(route));

  // 3. Not advertising, and honest about what it is.
  for (const [label, re] of [
    ["says it is private, not offered to the public", /not\s+offered\s+to\s+the\s+public/i],
    ["names the firm", /Tez Law P\.C\./],
    ["disclaims legal advice", /is legal advice/i],
    ["says no attorney-client relationship is created", /attorney-client\s+relationship\s+is\s+created/i],
    ["states trust money stays on the law firm's books", /1\.15/],
    ["says authorisation can be withdrawn", /withdrawn\s+at\s+any\s+time/i],
    ["links the real privacy policy", /tezlawfirm\.com\/our-privacy-policy/],
  ]) ok(label, re.test(route));

  // Superlatives are the exact exposure in the open Bar matter.
  const bad = (route.match(/\b(#1|No\.? ?1|best|top-rated|leading|premier|award-winning)\b/gi) || []);
  ok("no superlative or comparative claims", bad.length === 0, bad.join(", "));
  ok("it does not solicit clients",
     !/free consultation|contact us today|hire us|call now/i.test(route));
}

// ── The Disconnect URL Intuit sends people to ─────────────────────────
// Intuit requires a Disconnect URL that a browser can GET. The app's own
// disconnect is a POST behind admin auth, so it cannot serve as one.
{
  const d = srv.indexOf('app.get("/legal/quickbooks-disconnected"');
  ok("there is a GET disconnect landing page", d > 0);
  if (d > 0) {
    const next = srv.indexOf("\napp.", d + 10);
    const page = srv.slice(d, next > 0 ? next : srv.length);

    // The dangerous shortcut: having this public URL revoke the tokens. Anyone
    // who learned the URL could then sign the firm out of QuickBooks.
    ok("it does not revoke anything — it is a public URL",
       !/disconnect\(|DELETE FROM accounting_qb_config|saveConfig\(/.test(page));
    ok("it carries no inline <script>", !/<script/i.test(page));

    // The thing that is otherwise invisible: Intuit does not tell the app.
    ok("it says disconnecting inside QuickBooks does not notify the app",
       /not\s+told\s+when\s+that\s+happens/i.test(page));
    ok("…and says the admin will keep showing it as connected",
       /keep\s+showing\s+the\s*\n?\s*connection\s+as\s+active/i.test(page));
    ok("it says nothing in QuickBooks is deleted",
       /Nothing\s+already\s+in\s+QuickBooks\s+is\s+changed/i.test(page));
    ok("it explains how to reconnect", /To\s+reconnect/i.test(page));
    const bad = (page.match(/\b(#1|No\.? ?1|best|top-rated|leading|premier)\b/gi) || []);
    ok("no superlative claims", bad.length === 0, bad.join(", "));
  }

  // The real disconnect must stay an authenticated POST.
  ok("the real disconnect is still a POST under /admin",
     /app\.post\("\/admin\/accounting\/quickbooks\/disconnect"/.test(srv));
  ok("…and there is no GET that disconnects",
     !/app\.get\("\/admin\/accounting\/quickbooks\/disconnect"/.test(srv));
}

console.log(failures ? "\n" + failures + " failed" : "\nall good");
process.exit(failures ? 1 : 0);
