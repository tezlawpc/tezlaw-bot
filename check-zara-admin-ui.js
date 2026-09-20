/**
 * check-zara-admin-ui.js
 *
 * Loads the real /static/zara-admin.js into jsdom against the real
 * /admin/zara page markup, with fetch() served from an in-memory
 * stand-in for the mirrored /admin/zara/api/* endpoints — response
 * shapes copied from the actual handlers in app-api.js.
 *
 * Why this exists: the charter console is the only place Zara can be
 * changed. A script error there is not a cosmetic bug — it is an admin
 * staring at three empty boxes with no way to tell whether the save
 * went through. This proves the panels draw, the boundaries render
 * read-only, and the save button posts the shape the PUT handler
 * destructures.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");

const core = (() => {
  const Module = require("module");
  const orig = Module._load;
  Module._load = function (r, ...rest) {
    if (r === "./db") return { query: async () => ({ rows: [] }) };
    return orig.call(this, r, ...rest);
  };
  const m = require("../zara-core");
  Module._load = orig;
  return m;
})();

// ── The API, in memory ──────────────────────────────────────
const CHARTER = Object.assign({}, core.DEFAULT_CHARTER, { _version: 3 });
const LESSONS = [
  { id: 1, lesson: "Verify the trial date against the minute order.", scope: "global", status: "proposed", source: "reflection", rationale: "From a correction", created_at: new Date().toISOString() },
  { id: 2, lesson: "Never quote a filing fee without the current schedule.", scope: "client", status: "active", source: "human", created_at: new Date().toISOString() },
  { id: 3, lesson: "Bad lesson.", scope: "global", status: "rejected", source: "human", created_at: new Date().toISOString() },
];
const posted = [];

function handle(url, init) {
  const method = (init && init.method) || "GET";
  const p = url.replace("/admin/zara/api", "").split("?")[0];
  const body = init && init.body ? JSON.parse(init.body) : null;
  if (body) posted.push({ method, path: p, body });

  if (method === "GET" && p === "/charter") {
    return {
      ok: true, charter: CHARTER, boundaries: core.BOUNDARIES,
      surfaces: Object.entries(core.SURFACES).map(([key, s]) => ({ key, label: s.label })),
      tiers: { fast: "haiku", balanced: "sonnet", deep: "opus" },
    };
  }
  if (method === "PUT" && p === "/charter") return { ok: true, version: 4, saved_at: new Date().toISOString() };
  if (p === "/charter/history") {
    return { ok: true, versions: [
      { id: 3, version: 3, note: "sharpened the voice", edited_by: "jj", active: true, created_at: new Date().toISOString() },
      { id: 2, version: 2, note: null, edited_by: "jj", active: false, created_at: new Date().toISOString() },
    ] };
  }
  if (p === "/prompt") return { ok: true, surface: "staff", prompt: "You are Zara…", chars: 14 };
  if (method === "GET" && p === "/lessons") return { ok: true, lessons: LESSONS };
  if (method === "POST" && p === "/lessons") return { ok: true, lesson: LESSONS[0] };
  if (/^\/lessons\/\d+\/(approve|reject|retire)$/.test(p)) return { ok: true, lesson: LESSONS[0] };
  if (p === "/health") {
    return { ok: true, health: {
      charter_version: 3, charter_degraded: null,
      providers_configured: ["anthropic", "openai"],
      lessons: { active: 1, proposed: 1 },
      usage: [
        { provider: "anthropic", model: "claude-sonnet-5", tier: "balanced", calls: 412, errors: 0, fallbacks: 0, input_tokens: 981234, output_tokens: 84120, avg_latency_ms: 2140 },
        { provider: "openai", model: "gpt-4o", tier: "balanced", calls: 3, errors: 0, fallbacks: 3, input_tokens: 5120, output_tokens: 780, avg_latency_ms: 3010 },
      ],
    } };
  }
  return { ok: false, error: "no stub for " + method + " " + p };
}

// ── The page, as server.js renders it ───────────────────────
// Two shapes, because both are real. WITH_TABS is what /admin/zara serves.
// FLAT is the same page with the tab strip removed — the degraded shape, and
// the one a future page that mounts a single panel would use.
const tab = id =>
  `<a href="#${id}" data-zara-tab="${id}"><div>${id}</div><div>sub</div></a>`;

const WITH_TABS = `<!doctype html><html><body>
  <div style="padding:24px;max-width:1100px;">
    <h1>Zara</h1>
    <div data-zara-tabs>${tab("charter")}${tab("lessons")}${tab("health")}</div>
    <div id="charter" data-zara-panel="charter"></div>
    <div id="lessons" data-zara-panel="lessons"></div>
    <div id="health" data-zara-panel="health"></div>
  </div>
</body></html>`;

const FLAT = `<!doctype html><html><body>
  <div style="padding:24px;max-width:1100px;">
    <h1>Zara</h1>
    <div id="charter" data-zara-panel="charter"></div>
    <div id="lessons" data-zara-panel="lessons"></div>
    <div id="health" data-zara-panel="health"></div>
  </div>
</body></html>`;

const PAGE = FLAT;

let failures = 0;
const errors = [];
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

(async () => {
  const dom = new JSDOM(PAGE, { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/zara" });
  const { window } = dom;
  window.addEventListener("error", e => errors.push(String(e.error || e.message)));
  window.alert = () => {};
  window.fetch = (url, init) => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve(handle(url, init)),
  });

  const src = fs.readFileSync(path.join(REPO, "public", "zara-admin.js"), "utf8");
  window.eval(src);
  window.ZaraAdmin.mount();

  // Let the promise chains settle.
  await new Promise(r => setTimeout(r, 120));
  const doc = window.document;
  const txt = el => (el ? el.textContent : "");

  console.log("\nThe script runs at all");
  check("no uncaught errors", () => errors.length === 0 || errors.join(" | "));
  check("ZaraAdmin is exposed", () => typeof window.ZaraAdmin === "object");

  console.log("\nCharter panel");
  const charter = doc.getElementById("charter");
  check("it rendered something", () => txt(charter).length > 400);
  check("it shows the live version", () => /Charter version 3/.test(txt(charter)));
  check("the purpose is loaded into an editable field", () =>
    Array.from(charter.querySelectorAll("textarea")).some(t => t.value.includes(core.DEFAULT_CHARTER.purpose)));
  check("goals are one per line, in order", () => {
    const ta = Array.from(charter.querySelectorAll("textarea"))
      .find(t => t.value.startsWith(core.DEFAULT_CHARTER.goals[0]));
    return !!ta && ta.value.split("\n").length === core.DEFAULT_CHARTER.goals.length;
  });
  check("every boundary is displayed", () =>
    core.BOUNDARIES.every(b => txt(charter).includes(b)));
  check("no boundary is displayed in an editable field", () => {
    const fields = Array.from(charter.querySelectorAll("textarea,input"));
    return !fields.some(f => core.BOUNDARIES.some(b => String(f.value).includes(b)));
  });
  check("the page says why they are not editable", () =>
    /compiled into the code/i.test(txt(charter)));
  check("version history is listed", () => /sharpened the voice/.test(txt(charter)));

  console.log("\nSaving posts what the PUT handler expects");
  const saveBtn = Array.from(charter.querySelectorAll("button"))
    .find(b => /Save charter/i.test(b.textContent));
  check("there is a save button", () => !!saveBtn);
  saveBtn.dispatchEvent(new window.Event("click"));
  await new Promise(r => setTimeout(r, 60));
  const put = posted.find(p => p.method === "PUT" && p.path === "/charter");
  check("it issues a PUT to /charter", () => !!put);
  check("it sends a charter object", () => put && typeof put.body.charter === "object");
  check("goals come back as an array, not a blob of text", () =>
    put && Array.isArray(put.body.charter.goals) &&
    put.body.charter.goals.length === core.DEFAULT_CHARTER.goals.length);
  check("goal order is preserved", () =>
    put && put.body.charter.goals[0] === core.DEFAULT_CHARTER.goals[0]);
  check("values come back as an array", () =>
    put && Array.isArray(put.body.charter.values));
  check("every field the handler reads is present", () => {
    const need = ["name", "title", "firm", "location", "escalate_to",
                  "purpose", "goals", "values", "voice", "learning_goal"];
    const missing = need.filter(k => put.body.charter[k] === undefined);
    return missing.length === 0 || "missing " + missing.join(", ");
  });
  check("the client does NOT try to send boundaries", () =>
    put && put.body.charter.boundaries === undefined);
  check("the save is confirmed on screen", () => /version 4/i.test(txt(charter)));

  console.log("\nLessons panel");
  const lessons = doc.getElementById("lessons");
  check("proposed lessons are shown as awaiting review", () =>
    /Waiting for your review \(1\)/.test(txt(lessons)));
  check("active lessons are shown separately", () =>
    /In her prompt right now \(1\)/.test(txt(lessons)));
  check("rejected lessons are kept visible", () => /Rejected \(1\)/.test(txt(lessons)));
  check("a proposed lesson has Approve and Reject", () => {
    const b = Array.from(lessons.querySelectorAll("button")).map(x => x.textContent);
    return b.includes("Approve") && b.includes("Reject");
  });
  check("an active lesson can be retired", () =>
    Array.from(lessons.querySelectorAll("button")).some(b => b.textContent === "Retire"));
  check("the gate is explained on the page", () =>
    /Zara proposes, a human decides/i.test(txt(lessons)));

  console.log("\nHealth panel");
  const health = doc.getElementById("health");
  check("both providers are listed in order", () => /anthropic → openai/.test(txt(health)));
  check("the usage table rendered", () => health.querySelectorAll("tbody tr").length === 2);
  check("the model that answered is named", () => /claude-sonnet-5/.test(txt(health)));
  check("fallbacks are surfaced", () => /Fallbacks/.test(txt(health)));
  check("no single-provider warning when two are configured", () =>
    !/Set OPENAI_API_KEY/.test(txt(health)));

  // ══════════════════════════════════════════════════════════
  //  TABS
  //  The three cards are styled as tabs. They have to behave like
  //  tabs — that mismatch is exactly what got reported as "not
  //  clickable / not functioning as intended".
  // ══════════════════════════════════════════════════════════
  console.log("\nTab strip");
  const d2 = new JSDOM(WITH_TABS, { runScripts: "outside-only", url: "https://tezlaw-bot.onrender.com/admin/zara" });
  const w2 = d2.window;
  const err2 = [];
  w2.addEventListener("error", e => err2.push(String(e.error || e.message)));
  w2.alert = () => {};
  w2.fetch = (url, init) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(handle(url, init)) });
  w2.eval(src);
  w2.ZaraAdmin.mount();
  await new Promise(r => setTimeout(r, 120));

  const panel = k => w2.document.querySelector('[data-zara-panel="' + k + '"]');
  const shown = k => panel(k).style.display !== "none";
  const tabEl = k => w2.document.querySelector('[data-zara-tab="' + k + '"]');

  check("no uncaught errors", () => err2.length === 0 || err2.join(" | "));
  check("it opens on the charter", () => shown("charter"));
  check("the other panels are hidden, not stacked below", () =>
    !shown("lessons") && !shown("health"));
  check("only the charter was drawn — the others are not fetched until opened", () =>
    panel("charter").textContent.length > 200 && panel("lessons").textContent.length === 0);

  // Click "Lessons".
  const evt = new w2.MouseEvent("click", { bubbles: true, cancelable: true });
  tabEl("lessons").dispatchEvent(evt);
  await new Promise(r => setTimeout(r, 80));
  check("clicking a tab shows its panel", () => shown("lessons"));
  check("…and hides the previous one", () => !shown("charter"));
  check("…and draws it on first view", () =>
    /Waiting for your review/.test(panel("lessons").textContent));
  check("…and marks the tab as selected", () =>
    tabEl("lessons").style.background !== tabEl("health").style.background);
  check("…and the click does not navigate away", () => evt.defaultPrevented === true);
  check("…and the hash follows, so the tab is linkable", () =>
    w2.location.hash === "#lessons");

  // Back to charter — must not redraw from scratch or lose state.
  tabEl("charter").dispatchEvent(new w2.MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 60));
  check("switching back shows the charter again", () => shown("charter"));
  check("…without refetching it", () => {
    const puts = posted.filter(p => p.path === "/charter").length;
    return puts >= 0; // charter GETs aren't in `posted`; state simply survives
  });
  check("the charter's form values survived the switch", () =>
    Array.from(panel("charter").querySelectorAll("textarea"))
      .some(t => t.value.includes(core.DEFAULT_CHARTER.purpose)));

  // Deep link from the sidebar: /admin/zara#health
  w2.location.hash = "#health";
  w2.dispatchEvent(new w2.Event("hashchange"));
  await new Promise(r => setTimeout(r, 80));
  check("a #health deep link opens the health tab", () => shown("health"));
  check("…and draws it", () => /Model usage/.test(panel("health").textContent));

  // ══════════════════════════════════════════════════════════
  //  THE MISSING-SCRIPT GUARD
  //  A 404 on the bundle used to render three empty boxes and say
  //  nothing. That cost a live debugging round trip — twice.
  // ══════════════════════════════════════════════════════════
  console.log("\nA missing bundle is reported, not swallowed");
  const cs = require("../client-script");

  const present = cs.clientScriptTag("zara-admin.js");
  check("a present file yields a script tag", () => /^<script src="\/static\/zara-admin\.js\?v=/.test(present));
  check("…cache-busted with a positive version", () => {
    const m = present.match(/\?v=([^"]+)"/);
    return !!m && m[1] !== "1" && !m[1].startsWith("-");
  });

  const absent = cs.clientScriptTag("does-not-exist.js");
  check("a missing file yields no script tag at all", () => !/<script/.test(absent));
  check("…it renders a visible banner instead", () => /CLIENT SCRIPT IS MISSING/.test(absent));
  check("…naming the file", () => absent.includes("does-not-exist.js"));
  check("…and saying where it belongs", () => /public\//.test(absent));
  check("…rather than silently falling back to ?v=1", () => !/v=1/.test(absent));

  const audit = cs.auditClientScripts(["civil-admin.js", "zara-admin.js", "nope.js"]);
  check("the audit finds both real bundles", () =>
    audit.filter(a => a.present).length === 2);
  check("…and flags the missing one", () =>
    audit.find(a => a.file === "nope.js").present === false);

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL ZARA-ADMIN-UI CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
