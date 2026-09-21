/**
 * check-kanban-layout.js
 *
 * Two fixes that came out of the same afternoon.
 *
 * 1. The board stacks vertically so case names are readable, but a
 *    stage with 115 matters in it then ran six screens long and the
 *    lifecycle order the board exists to show was never visible at
 *    once. Each stage band now scrolls inside itself. These checks pin
 *    that the scroll container is there, that it is capped, and — the
 *    part that is easy to break — that the drag-and-drop hooks the
 *    existing script targets survived the restructuring.
 *
 * 2. A client bundle has landed in the repository ROOT instead of
 *    public/ four separate times (GitHub's web uploader flattens
 *    folders; so does an unzip that does not preserve them). Every
 *    time the page came up empty or banner'd until a human moved one
 *    file. The server now moves it. These checks pin the two halves of
 *    that: it DOES rescue a bundle it knows, and it does NOT copy
 *    anything else out of the repository root into a publicly-served
 *    directory — which is how a .env reaches the internet.
 */
const Module = require("module");
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// ── A board with a stage big enough to need the roller ──────
const big = n => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  case_name: "Nguyen v. Pacific Holdings LLC and Related Cross-Actions",
  case_number: "25STCV0" + (1000 + i),
  case_type: "breach of contract",
  court: "LASC — Stanley Mosk",
  our_role: "plaintiff",
  stage: "intake",
  trial_date: i === 0 ? "2026-10-01" : null,
  statute_of_limitations: null,
  files_archived_at: null,
  amount_in_controversy: 250000,
  updated_at: "2026-03-01",
}));

const STAGES = [
  { key: "intake", label: "Intake / Assessment", color: "#7B5330" },
  { key: "discovery", label: "Discovery", color: "#B8891E" },
  { key: "trial_prep", label: "Trial Prep", color: "#A02818" },
];

const civilStub = {
  STAGES,
  STAGE_KEYS: new Set(STAGES.map(s => s.key)),
  CASE_TYPES: ["breach of contract"],
  OUR_ROLES: ["plaintiff"],
  kanban: async () => ({
    stages: STAGES,
    counts: { intake: 115, discovery: 3, trial_prep: 0 },
    cases_by_stage: {
      intake: big(115),
      discovery: big(3).map(c => Object.assign({}, c, { stage: "discovery" })),
      trial_prep: [],
    },
  }),
};

const origLoad = Module._load;
Module._load = function (r) {
  if (r === "./civil-litigation") return civilStub;
  if (r === "./db") return { query: async () => ({ rows: [] }) };
  return origLoad.apply(this, arguments);
};
const ui = require("../civil-litigation-ui");
Module._load = origLoad;

(async () => {
  console.log("\n── The board ───────────────────────────────────");
  const html = await ui.renderKanban();

  const cols = html.match(/class="civil-col"/g) || [];
  const scrolls = html.match(/class="civil-col-scroll"/g) || [];

  check("every stage renders a band", () => cols.length === 3 || `${cols.length} bands`);
  check("…and every band has its own scroll container", () =>
    scrolls.length === cols.length || `${scrolls.length} scrollers for ${cols.length} bands`);
  check("…capped so the page cannot run six screens", () => /max-height:46vh/.test(html));
  check("…scrolling a band does not scroll the page behind it", () =>
    /overscroll-behavior:contain/.test(html));
  check("the scrollbar is styled in both engines", () =>
    /::-webkit-scrollbar-thumb/.test(html) && /scrollbar-width: thin/.test(html));

  const hint = /scrolls &#8597;/g;
  check("a stage of 115 is marked as scrolling", () => hint.test(html));
  check("…and a stage of 3 is not", () => (html.match(hint) || []).length === 1);

  check("an empty stage renders collapsed", () => {
    const band = html.slice(html.indexOf('data-stage="trial_prep"'));
    const tag = band.slice(0, band.indexOf(">"));
    return !/\bopen\b/.test(tag);
  });
  check("…and a stage with work in it renders open", () => {
    const band = html.slice(html.indexOf('data-stage="intake"'));
    return /\bopen\b/.test(band.slice(0, band.indexOf(">")));
  });

  // The whole point of the restack was readable captions.
  check("the full caption is in the card, untruncated", () =>
    html.includes("Nguyen v. Pacific Holdings LLC and Related Cross-Actions"));
  check("…with no line clamp left over from the column layout", () =>
    !/-webkit-line-clamp/.test(html));
  check("…and the case number and court on a meta line", () =>
    /25STCV01000/.test(html) && /Stanley Mosk/.test(html));

  // Drag-and-drop targets the classes and data attributes, so a restack
  // that renames either one silently kills it.
  check("cards are still draggable", () => /draggable/.test(html));
  check("…still carry their case id", () => /data-case-id="1"/.test(html));
  check("…bands still carry their stage key", () => /class="civil-col" data-stage="intake"/.test(html));
  check("…and the move still posts to /move-stage", () => /\/move-stage/.test(html));

  check("each stage still links to its workspace", () =>
    html.includes('/admin/civil/stage/discovery'));

  // ── The bundle rescue ─────────────────────────────────────
  console.log("\n── Client bundles in the wrong folder ──────────");
  const cs = require("../client-script");

  check("the rescue list names only client bundles", () =>
    cs.CLIENT_BUNDLES.every(f => /\.js$/.test(f)) &&
    !cs.CLIENT_BUNDLES.includes("server.js") &&
    !cs.CLIENT_BUNDLES.some(f => /^\./.test(f)));
  check("…and covers the four that are actually served", () =>
    ["civil-admin.js", "zara-admin.js", "zara-chat.js", "civil-intake.js"]
      .every(f => cs.CLIENT_BUNDLES.includes(f)));

  check("with everything already in public/, nothing is moved", () =>
    cs.healClientBundles().length === 0);

  // Now the real scenario: the bundle is at the root and public/ has none.
  const NAME = "zara-chat.js";
  const inPublic = path.join(cs.PUBLIC_DIR, NAME);
  const atRoot = path.join(cs.ROOT_DIR, NAME);
  const stash = path.join(REPO, ".kanban-check-stash.js");
  let restored = false;

  try {
    fs.copyFileSync(inPublic, stash);
    fs.unlinkSync(inPublic);
    fs.copyFileSync(stash, atRoot);          // the stray, exactly as a flattened upload leaves it

    // healOne remembers what it has already looked at, so this goes through
    // the render path — which is the one that matters in production anyway.
    delete require.cache[require.resolve("../client-script")];
    const fresh = require("../client-script");
    const tag = fresh.clientScriptTag(NAME);

    check("a bundle stranded at the root is rescued, not banner'd", () =>
      /<script src="\/static\/zara-chat\.js\?v=/.test(tag));
    check("…by putting a copy where it is actually served from", () =>
      fs.existsSync(inPublic));
    check("…and the copy is the real file, not an empty one", () =>
      fs.statSync(inPublic).size === fs.statSync(stash).size);

    // The case that actually broke LOG TIME: public/ HAS the file, but it
    // is an old version, and the new upload is stranded at the root.
    fs.writeFileSync(inPublic, "/* stale */");
    delete require.cache[require.resolve("../client-script")];
    const freshStale = require("../client-script");
    const healedList = freshStale.healClientBundles();
    check("a newer upload at the root replaces a stale copy in public/", () =>
      healedList.includes(NAME) && fs.readFileSync(inPublic).equals(fs.readFileSync(stash)));
    delete require.cache[require.resolve("../client-script")];
    check("…and identical copies are left alone", () =>
      require("../client-script").healClientBundles().length === 0);

    // The dangerous half.
    fs.unlinkSync(inPublic);
    delete require.cache[require.resolve("../client-script")];
    const fresh2 = require("../client-script");
    const danger = fresh2.clientScriptTag("server.js");
    check("a file that is not a client bundle is NEVER copied into public/", () =>
      !fs.existsSync(path.join(cs.PUBLIC_DIR, "server.js")));
    check("…it gets the banner instead", () => /CLIENT SCRIPT IS MISSING/.test(danger));
    check("…and a path traversal cannot reach outside public/", () => {
      const t = fresh2.clientScriptTag("../../../etc/passwd");
      return !/<script/.test(t) && !t.includes("..") && !t.includes("etc");
    });

    // Genuinely absent from the repo: still the banner, which is right.
    fs.unlinkSync(atRoot);
    delete require.cache[require.resolve("../client-script")];
    const fresh3 = require("../client-script");
    const gone = fresh3.clientScriptTag(NAME);
    check("a bundle absent from the repo entirely still banners", () =>
      /CLIENT SCRIPT IS MISSING/.test(gone));
    check("…naming the file", () => gone.includes(NAME));
    check("…and saying a root copy would have been moved automatically", () =>
      /repository root/.test(gone));
  } finally {
    // Put the repo back exactly as it was, whatever happened above.
    try { if (fs.existsSync(stash)) { fs.copyFileSync(stash, inPublic); fs.unlinkSync(stash); restored = true; } } catch (e) {}
    try { if (fs.existsSync(atRoot)) fs.unlinkSync(atRoot); } catch (e) {}
    try { const s = path.join(cs.PUBLIC_DIR, "server.js"); if (fs.existsSync(s)) fs.unlinkSync(s); } catch (e) {}
    delete require.cache[require.resolve("../client-script")];
  }

  check("the repository is left exactly as it was found", () =>
    restored && fs.existsSync(inPublic) && !fs.existsSync(atRoot) && !fs.existsSync(stash));

  // ── And the server actually calls it ──────────────────────
  const serverSrc = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  check("the server runs the rescue at boot", () => /healClientBundles\(\)/.test(serverSrc));
  check("…and says so in the log when it moves something", () =>
    /Rescued client bundles/.test(serverSrc));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL KANBAN-LAYOUT CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
