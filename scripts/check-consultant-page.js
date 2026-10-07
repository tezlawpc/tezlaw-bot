/**
 * check-consultant-page.js
 *
 * "in admin, when clicking consultant tasks, it jumps to a different page.
 *  revise to the same page."
 *
 * It really was a different page: every other /admin screen renders through
 * hearing-notes.renderAdminChrome, and work-orders.js rendered through
 * tez-theme.page(), which draws a standalone page with its own small nav.
 *
 * What these checks defend:
 *   1. the two firm-side pages render in the admin chrome, with the sidebar;
 *   2. the components their bodies are written in still have styles, taken
 *      from tez-theme itself rather than copied;
 *   3. scoping those styles cannot leak out and restyle the rest of admin
 *      -- `input`, `label` and `h2, h3` are element selectors;
 *   4. the consultant portal is left alone. It is a different audience,
 *      signed in somewhere else, and bilingual.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const wo = read("work-orders.js");
// These files explain in comments why they no longer call theme.page(), so a
// naive grep for it finds the explanation. Structural checks read this; the
// ones about what is written down read the whole file.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const woCode = code(wo);
const hn = read("hearing-notes.js");
const portal = read("consultant-portal.js");
const theme = require(path.join(ROOT, "tez-theme.js"));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log("\nConsultant tasks is an admin page\n");

// ── It is the same page now ────────────────────────────────

check("both firm-side pages render in the admin chrome", () => {
  assert.ok(/renderAdminChrome/.test(wo), "work-orders.js does not use the admin chrome");
  assert.ok(!/theme\.page\(/.test(woCode),
    "a theme.page() call is a standalone page: that is the jump JJ saw");
  const i = wo.indexOf("function inAdminChrome");
  assert.ok(i > -1, "the wrapper is missing");
});

check("the sidebar marks it as the page you are on", () => {
  assert.ok(/activeItem: "consultant-tasks"/.test(wo));
  assert.ok(/\/admin\/consultant-tasks" class="nav-link \$\{isActive\('consultant-tasks'\)\}/.test(hn),
    "without this the sidebar highlights nothing and the page feels detached");
});

check("the two pages that belong to this screen stay reachable from it", () => {
  const i = wo.indexOf("function inAdminChrome");
  const body = wo.slice(i, wo.indexOf("function navFor"));
  assert.ok(/"pending"/.test(body) && /"alert"/.test(body),
    "waiting-for-approval and send-an-alert are the two halves of this screen");
  // Task list and Dashboard were in the old standalone nav; the sidebar has
  // them, so repeating them in the page is noise.
  assert.ok(/filter\(/.test(body), "the old nav's other links should be dropped, not reprinted");
});

check("approving still posts to the same places", () => {
  // The chrome changed; the forms and the routes behind them must not have.
  // A decision on a consultant's work order is the whole point of the page.
  for (const action of ['action="${PAGE}/${t.id}/approve"',
                        'action="${PAGE}/${t.id}/reject"',
                        'action="${PAGE}/alert"']) {
    assert.ok(wo.includes(action), `a form stopped posting to ${action}`);
  }
  for (const route of ['PAGE + "/:id/approve"', 'PAGE + "/:id/reject"', 'PAGE + "/alert"']) {
    assert.ok(wo.includes(route), `the route ${route} is gone`);
  }
  // And the page is still behind the role gate, not merely behind sign-in.
  assert.ok(/app\.use\(PAGE, auth\.requireRole\(\.\.\.APPROVER_ROLES\)\)/.test(wo),
    "an attorney, manager or admin decides these; the gate must survive the move");
});

// ── The components still have styles ──────────────────────

check("the component CSS comes from tez-theme, not a second copy", () => {
  assert.strictEqual(typeof theme.scopedCSS, "function", "tez-theme does not export scopedCSS");
  assert.ok(/theme\.scopedCSS\(/.test(wo), "work-orders.js does not inject it");
  // A copied block would mean two sets of styles drifting apart.
  assert.ok(!/\.btn-primary\s*\{/.test(woCode), "work-orders.js has its own copy of a component rule");
});

check("the classes the bodies actually use all survive the scoping", () => {
  const css = theme.scopedCSS(".tez-embed");
  for (const cls of ["card", "btn-primary", "btn-secondary", "grid2", "rows", "empty",
                     "page-header", "hint", "quote", "tag", "timeline", "field"]) {
    assert.ok(css.includes(`.tez-embed .${cls}`), `.${cls} lost its styles`);
  }
});

check("and so do the element rules the forms depend on", () => {
  const css = theme.scopedCSS(".tez-embed");
  // The approve/reject forms are inputs, selects and textareas with no class.
  assert.ok(/\.tez-embed input/.test(css), "form fields would fall back to browser defaults");
  assert.ok(/\.tez-embed label/.test(css));
  assert.ok(/\.tez-embed \*/.test(css), "border-box: the grid and card padding depend on it");
});

check("nothing leaks out to restyle the rest of admin", () => {
  const css = theme.scopedCSS(".tez-embed");
  // Every rule has to be scoped. An unscoped `input` or `h3` rule would
  // reach into every other admin page that shares this stylesheet's page.
  for (const line of css.split("\n")) {
    const sel = line.split("{")[0].trim();
    if (!sel || sel.startsWith("@") || sel.startsWith("}") || sel === ":root") continue;
    if (!/[{:;]/.test(line)) continue;                       // a declaration, not a selector
    if (!line.includes("{")) continue;
    for (const part of sel.split(",")) {
      assert.ok(part.trim().startsWith(".tez-embed"),
        `this rule is not scoped and would affect the whole page: ${part.trim()}`);
    }
  }
});

check("the standalone chrome's own rules are dropped, not scoped", () => {
  const css = theme.scopedCSS(".tez-embed");
  // The admin chrome draws the header and nav. Carrying these in would draw
  // a second header inside the first.
  assert.ok(!/\.tez-top/.test(css) && !/\.tez-nav/.test(css) && !/\.tez-who/.test(css));
  assert.ok(!/\.tez-embed main/.test(css), "main sets the standalone page's width");
  assert.ok(!/\.tez-embed body/.test(css) && !/\.tez-embed html/.test(css));
});

check("the brand's custom properties stay readable by the scoped rules", () => {
  const css = theme.scopedCSS(".tez-embed");
  assert.ok(/:root\{/.test(css), "scope :root and every var() below it resolves to nothing");
  assert.ok(/--orange:/.test(css));
  // The forms colour their two halves with these.
  assert.ok(/--good:/.test(css) && /--bad:/.test(css) || /--good:/.test(css));
});

check("a media query keeps its wrapper and scopes what is inside it", () => {
  const css = theme.scopedCSS(".tez-embed");
  const i = css.indexOf("@media");
  assert.ok(i > -1, "the mobile rules were dropped entirely");
  const inner = css.slice(i, i + 600);
  assert.ok(/\.tez-embed /.test(inner), "the rules inside the query are unscoped");
});

check("the scoping is mechanical, so it cannot drift from the real CSS", () => {
  // Same input, same output; and it reads CSS rather than restating it.
  assert.strictEqual(theme.scopedCSS(".a").length > 0, true);
  assert.notStrictEqual(theme.scopedCSS(".a"), theme.scopedCSS(".b"));
  assert.ok(theme.scopedCSS(".tez-embed").length > 1000, "suspiciously little CSS survived");
});

// ── The portal is not an admin page ───────────────────────

check("the consultant portal still renders as its own page", () => {
  assert.ok(/theme\.page\(/.test(code(portal)),
    "the portal is a different audience, signed in elsewhere, and bilingual");
  assert.ok(!/renderAdminChrome/.test(code(portal)), "a consultant must not get the firm's sidebar");
});

check("the reason is written next to the code", () => {
  assert.ok(/different application|looks like another application/.test(wo),
    "the next person needs to know why these do not use theme.page()");
  assert.ok(/second copy/.test(read("tez-theme.js")));
});

console.log(`\n${passed} checks passed\n`);
