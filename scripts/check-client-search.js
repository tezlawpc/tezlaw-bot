/**
 * check-client-search.js
 *
 * JJ: "i should be able to search client based on their A# and name with
 * comma or no comma."
 *
 * Client folders are named "WANG, BAOHONG", so the stored name carries a
 * comma and puts the surname first. Nobody types it that way. This checks
 * that the search finds a client however the name is typed, and that an
 * A-number finds its client — without matching half the firm on a stray
 * digit.
 *
 * Also checks the other half: when an email is assigned by hand to a client
 * with no A-number on file, the A-number in the document is saved to that
 * client, so the next notice matches on its own. The guards matter more
 * than the feature — a wrong A-number is worse than a missing one.
 */
const Module = require("module");
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// ── Stand-in database ────────────────────────────────────
const mapping = [
  { client_key: "n-wang-baohong", a_number: null, client_name: "Wang, Baohong" },
  { client_key: "n-li-mei", a_number: "A111-222-333", client_name: "Li, Mei" },
];
const tasks = [
  { id: 1, client_key: "contact-ruiz-ana", a_number: null, client_name: "Ruiz, Ana" },
  { id: 2, client_key: "contact-ruiz-ana", a_number: null, client_name: "Ruiz, Ana" },
];

// The clients a search runs against. They reach searchClients the way the
// real ones do — as Dropbox-imported rows with no hearing notes yet.
const PEOPLE = [
  { client_key: "p-a", client_name: "Wang, Baohong", a_number: null },
  { client_key: "p-b", client_name: "Wang, Xuefeng", a_number: "A222-333-444" },
  { client_key: "p-c", client_name: "Li,Zhengguo_Gan,Lanzhen_Li, Lingwei", a_number: null },
  { client_key: "p-d", client_name: "O'Brien, Sean", a_number: null },
  { client_key: "p-e", client_name: "陈, 小明", a_number: null },
  { client_key: "p-f", client_name: "Nguyen, Van Minh", a_number: null },
];

const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^CREATE /i.test(q)) return { rows: [] };

  // What aggregateClients reads. Hearing notes and contact tasks are empty
  // here; the clients come in as bulk-imported Dropbox folders.
  if (/FROM client_dropbox_mapping WHERE resolved_by = 'bulk_import'/i.test(q)) {
    return { rows: PEOPLE.map(p => ({ ...p, dropbox_path: null, resolved_at: null })) };
  }

  if (/SELECT a_number FROM client_dropbox_mapping WHERE client_key = \$1 UNION ALL/i.test(q)) {
    const rows = [];
    for (const m of mapping) if (m.client_key === v[0]) rows.push({ a_number: m.a_number });
    for (const t of tasks) if (t.client_key === v[0] && t.a_number) rows.push({ a_number: t.a_number });
    return { rows };
  }
  if (/^UPDATE client_dropbox_mapping SET a_number/i.test(q)) {
    const rows = [];
    for (const m of mapping) {
      if (m.client_key === v[0] && !m.a_number) { m.a_number = v[1]; rows.push({ client_key: m.client_key }); }
    }
    return { rows };
  }
  if (/^UPDATE tasks SET a_number = \$2 WHERE client_key/i.test(q)) {
    const rows = [];
    for (const t of tasks) {
      if (t.client_key === v[0] && !t.a_number) { t.a_number = v[1]; rows.push({ id: t.id }); }
    }
    return { rows };
  }
  if (/^UPDATE client_dropbox_mapping SET a_number = NULL/i.test(q)) {
    for (const m of mapping) if (m.client_key === v[0] && m.a_number === v[1]) m.a_number = null;
    return { rows: [] };
  }
  if (/^UPDATE tasks SET a_number = NULL/i.test(q)) {
    for (const t of tasks) if (t.client_key === v[0] && t.a_number === v[1]) t.a_number = null;
    return { rows: [] };
  }
  return { rows: [] };
} };

const orig = Module._load;
Module._load = function (r, ...rest) { if (r === "./db") return fakeDb; return orig.call(this, r, ...rest); };

const CP = require("../client-profiles");
const CM = require("../court-mail");

// Search the way the web page does: through the exported function itself,
// guards and ranking included.
async function find(q, limit) {
  const hits = await CP.searchClients(q, limit);
  return hits.map(c => c.client_name);
}

(async () => {
  console.log("client search — however the name is typed");

  check("the first name alone", (await find("baohong")).includes("Wang, Baohong"));
  check("surname then first name", (await find("wang baohong")).includes("Wang, Baohong"));
  check("first name then surname", (await find("baohong wang")).includes("Wang, Baohong"));
  check("with the comma the folder uses", (await find("wang, baohong")).includes("Wang, Baohong"));
  check("in capitals, as the folder spells it", (await find("WANG, BAOHONG")).includes("Wang, Baohong"));
  check("extra spaces are ignored", (await find("  wang   baohong ")).includes("Wang, Baohong"));
  check("a prefix is enough", (await find("bao")).includes("Wang, Baohong"));
  check("surname and an initial", (await find("wang b")).includes("Wang, Baohong"));
  check("an apostrophe does not split the name", (await find("obrien")).includes("O'Brien, Sean"));
  check("and typing the apostrophe also works", (await find("o'brien sean")).includes("O'Brien, Sean"));
  check("a name in Chinese", (await find("小明")).includes("陈, 小明"));
  check("a three-part name", (await find("nguyen van minh")).includes("Nguyen, Van Minh"));
  check("a client inside a shared folder name",
    (await find("lingwei")).includes("Li,Zhengguo_Gan,Lanzhen_Li, Lingwei"));

  check("a surname returns everyone who has it", (await find("wang")).length === 2,
    JSON.stringify(await find("wang")));
  check("the wrong first name is not returned", !(await find("baohong")).includes("Wang, Xuefeng"));
  check("a name nobody has returns nobody", (await find("zzzz")).length === 0);
  check("one letter is too little to search on", (await find("w")).length === 0,
    JSON.stringify(await find("w")));
  check("an empty box returns nobody", (await find("   ")).length === 0);
  check("the exact name comes before the others",
    (await find("wang baohong"))[0] === "Wang, Baohong", JSON.stringify(await find("wang baohong")));
  check("no more results than asked for", (await find("wang", 1)).length === 1);

  console.log("\nclient search — by A-number");
  check("the whole A-number", (await find("A222-333-444")).includes("Wang, Xuefeng"));
  check("just the digits", (await find("222333444")).includes("Wang, Xuefeng"));
  check("part of it", (await find("333-444")).includes("Wang, Xuefeng"));
  check("an A-number hit comes first", (await find("222333444"))[0] === "Wang, Xuefeng");
  check("a single digit matches nobody", (await find("2")).length === 0,
    JSON.stringify(await find("2")));
  check("three digits are still too few", (await find("222")).length === 0,
    JSON.stringify(await find("222")));
  check("an A-number nobody has returns nobody", (await find("999999999")).length === 0);

  console.log("\nlearning an A-number from a notice assigned by hand");
  const learned = await CM.learnANumber("n-wang-baohong", { a_numbers: ["236-564-456"] });
  check("it is saved", !!learned && learned.a_number === "A236-564-456", JSON.stringify(learned));
  check("stored on the client", mapping[0].a_number === "A236-564-456", String(mapping[0].a_number));
  check("the action says what happened", !!learned && /future notices will match/i.test(learned.label));
  check("and can be undone", learned && learned.type === "a_number" && !!learned.client_key);

  console.log("\nthe guards");
  check("an existing A-number is never overwritten",
    (await CM.learnANumber("n-li-mei", { a_numbers: ["999-888-777"] })) === null);
  check("and it still reads as it did", mapping[1].a_number === "A111-222-333");
  check("two A-numbers in one notice teach nothing",
    (await CM.learnANumber("contact-ruiz-ana", { a_numbers: ["111-111-111", "222-222-222"] })) === null);
  check("no A-number teaches nothing",
    (await CM.learnANumber("contact-ruiz-ana", { a_numbers: [] })) === null);
  check("a number too short to be an A-number is refused",
    (await CM.learnANumber("contact-ruiz-ana", { a_numbers: ["123"] })) === null);
  check("the same A-number written two ways is still one",
    !!(await CM.learnANumber("contact-ruiz-ana", { a_numbers: ["333-444-555", "A333-444-555"] })));
  check("a client added in the app is taught too", tasks[0].a_number === "A333-444-555");
  check("every one of their records gets it", tasks[1].a_number === "A333-444-555");
  check("a client we do not have is left alone",
    (await CM.learnANumber("nobody-at-all", { a_numbers: ["236-564-456"] })) === null);
  check("no client at all is safe",
    (await CM.learnANumber("", { a_numbers: ["236-564-456"] })) === null);
  check("already taught, so not taught twice",
    (await CM.learnANumber("n-wang-baohong", { a_numbers: ["236-564-456"] })) === null);

  // The Clients page filters in the browser, so the rules exist a second time
  // as an inline script. Run that script against fake rows — this is the box
  // that found nobody for "wang baohong" while the assign box found her.
  console.log("\nthe Clients page search box");
  {
    const html = CP.renderClientList(PEOPLE.map(p => ({
      key: p.client_key, client_name: p.client_name, a_number: p.a_number,
      case_types: [], judges: [], hearings: [], upcoming: [], deadlines: [],
      hearing_count: 0, sent_count: 0,
    })));
    const rows = [...html.matchAll(/<tr class="c-row"([\s\S]*?)>/g)].map(m => {
      // A browser hands the script the decoded value, so decode here too.
      const attr = n => (m[1].match(new RegExp(`data-${n}="([^"]*)"`)) || [, ""])[1]
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      return { style: {}, dataset: {
        words: attr("words"), anumber: attr("anumber"), name: attr("name"),
        email: attr("email"), casetypes: attr("casetypes"),
        lang: attr("lang"), hasupcoming: attr("hasupcoming"),
      } };
    });
    check("the page renders a row per client with its name split into words",
      rows.length === PEOPLE.length && rows[0].dataset.words === "wang baohong",
      rows.length + " rows, first words: " + JSON.stringify(rows[0] && rows[0].dataset.words));

    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map(m => m[1]).find(s => /function filterRows/.test(s)) || "";
    const inputs = { "search-input": { value: "" }, "filter-upcoming": { value: "" },
      "filter-lang": { value: "" }, "row-count": { textContent: "" } };
    // Enough of a page for the script to run: the rows it filters, the inputs
    // it reads, and a stub for everything else it decorates on load.
    const stub = () => ({ addEventListener: () => {}, style: {}, dataset: {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      textContent: "", value: "", appendChild: () => {}, querySelectorAll: () => [] });
    const document = {
      getElementById: id => inputs[id] || stub(),
      querySelector: () => stub(),
      querySelectorAll: sel => String(sel).includes("c-row")
        ? { forEach: fn => rows.forEach(fn), length: rows.length }
        : { forEach: () => {}, length: 0 },
      addEventListener: () => {},
      createElement: () => stub(),
      body: stub(),
    };
    let filterRows;
    try {
      const window = { addEventListener: () => {}, location: { href: "", search: "" } };
      filterRows = new Function("document", "window", "fetch", "alert",
        script + "; return filterRows;")(document, window, async () => ({ json: async () => ({}) }), () => {});
    } catch (e) { check("the page's script parses", false, e.message); }
    const onPage = q => {
      inputs["search-input"].value = q;
      filterRows();
      return rows.filter(r => r.style.display !== "none").map(r => r.dataset.name);
    };
    if (filterRows) {
      check("the first name alone", onPage("baohong").includes("wang, baohong"));
      check("surname then first name", onPage("wang baohong").includes("wang, baohong"),
        JSON.stringify(onPage("wang baohong")));
      check("first name then surname", onPage("baohong wang").includes("wang, baohong"));
      check("with the comma the folder uses", onPage("wang, baohong").includes("wang, baohong"));
      check("in capitals", onPage("WANG, BAOHONG").includes("wang, baohong"));
      check("a prefix is enough", onPage("bao").includes("wang, baohong"));
      check("surname and an initial", onPage("wang b").includes("wang, baohong"),
        JSON.stringify(onPage("wang b")));
      check("an apostrophe does not split the name", onPage("obrien").includes("o'brien, sean"));
      check("by A-number", onPage("222333444").includes("wang, xuefeng"));
      check("part of an A-number", onPage("333-444").includes("wang, xuefeng"));
      check("a single digit matches nobody", onPage("2").length === 0, JSON.stringify(onPage("2")));
      check("a name nobody has returns nobody", onPage("zzzz").length === 0);
      check("an empty box shows everyone", onPage("").length === PEOPLE.length);
    }
  }

  console.log("\nwiring");
  const cm = require("fs").readFileSync(require("path").join(__dirname, "..", "court-mail.js"), "utf8");
  check("only a hand assignment teaches", /if \(target && match\.clientKey && !actions\.some/.test(cm));
  check("a failure to teach never fails the assignment",
    /catch \(e\) \{ \/\* teaching is a bonus; never fail an assignment over it \*\/ \}/.test(cm));
  check("undo restores it", /else if \(a\.type === "a_number"\) \{/.test(cm));
  check("undo only reverts the value it saved", /AND a_number = \$2/.test(cm));

  const routes = require("fs").readFileSync(require("path").join(__dirname, "..", "court-mail-routes.js"), "utf8");
  check("the assign box uses the shared search", /searchClients\(q, 8\)/.test(routes));
  const tr = require("fs").readFileSync(require("path").join(__dirname, "..", "transcripts-routes.js"), "utf8");
  check("so does assigning a recording", /searchClients\(q, 10\)/.test(tr));

  // The rules sit in a module of their own so a test can check them without
  // a database, and so nothing has to keep a second copy of them.
  // Every box that takes a typed name uses the same rules. A surface left on
  // substring matching is the bug JJ hit: the Clients page found nobody for
  // "wang baohong" while the assign box found her.
  const ma = require("fs").readFileSync(require("path").join(__dirname, "..", "mobile-app.js"), "utf8");
  check("the app's client search matches names the same way",
    /CS\.matchesQuery\(c, words, digits\) \|\| haystack\.includes/.test(ma));
  const jm = require("fs").readFileSync(require("path").join(__dirname, "..", "jj-mode.js"), "utf8");
  check("/clients on Telegram does too", /CS\.matchesQuery\(c, words, digits\) \|\| e\.includes/.test(jm));
  check("and /docs", /CSD\.matchesQuery\(c, dq\.words, dq\.digits\)/.test(jm));
  check("no surface is left matching the raw name as a string",
    !/n\.includes\(query\)/.test(jm), "jj-mode still has a substring name match");

  const cs = require("fs").readFileSync(require("path").join(__dirname, "..", "client-search.js"), "utf8");
  check("the matching rules need no database", !/require\(/.test(cs));
  const cp = require("fs").readFileSync(require("path").join(__dirname, "..", "client-profiles.js"), "utf8");
  check("and the one search everything uses is built on them",
    /CS\.rankClients\(await aggregateClients\(\)/.test(cp));
  const ccm = require("fs").readFileSync(require("path").join(__dirname, "check-court-mail.js"), "utf8");
  check("the court-mail test searches with the real rules, not a stand-in",
    /rankClients\(PROFILES, q, n\)/.test(ccm));

  console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nclient search + A-number learning: all checks passed\n");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("THREW:", e); process.exit(1); });
