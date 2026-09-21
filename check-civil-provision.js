/**
 * check-civil-provision.js
 *
 * When a case is created, its client profile and its Dropbox folder are
 * created with it. This proves the promises that make doing that
 * automatically safe:
 *
 *   · It never fails case creation. Dropbox down, token expired,
 *     database hiccup — the case is already saved, and provisioning
 *     reports what went wrong rather than throwing.
 *
 *   · It never creates on top of what exists. A known client is
 *     reused, an existing folder is adopted and linked, an already-
 *     linked case is left alone.
 *
 *   · It never puts a civil matter folder under the IMMIGRATION tree.
 *     With no civil root configured, the lookup falls back to the
 *     immigration branches; provisioning refuses rather than scatter
 *     litigation files through them.
 *
 *   · The standard subfolders are exactly the document categories, so
 *     anything dropped into one of them is filed correctly by folder.
 *
 * Everything runs against the real civil-provision.js with the database
 * and Dropbox replaced by in-memory fakes that record every call.
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

// ── Fakes, reset per scenario ───────────────────────────────
const S = {};
function reset(over = {}) {
  Object.assign(S, {
    contacts: { "existing-client": "Existing Client LLC" },
    inserts: [],
    events: [],
    folders: new Set(),
    created: [],
    linked: null,
    synced: 0,
    dbxConfigured: true,
    rootsConfigured: true,
    roots: ["/Civil Litigation"],
    dbDown: false,
    dbxDown: false,
    slowMs: 0,
  }, over);
}
reset();

const fakeDb = {
  query: async (sql, vals) => {
    if (S.dbDown) throw new Error("connect ECONNREFUSED");
    if (/SELECT client_name FROM tasks WHERE client_key/.test(sql)) {
      const n = S.contacts[vals[0]];
      return { rows: n ? [{ client_name: n }] : [] };
    }
    if (/INSERT INTO tasks/.test(sql)) {
      S.inserts.push({ key: vals[1], name: vals[2], by: vals[4] });
      S.contacts[vals[1]] = vals[2];
      return { rows: [] };
    }
    return { rows: [] };
  },
};

const fakeDbx = {
  isConfigured: () => S.dbxConfigured,
  createFolder: async p => {
    if (S.slowMs) await new Promise(r => setTimeout(r, S.slowMs));
    if (S.dbxDown) throw new Error("Dropbox 503 service unavailable");
    if (S.folders.has(p)) return null;          // the real client's "already exists" contract
    S.folders.add(p); S.created.push(p);
    return { metadata: { path_display: p } };
  },
};

const realCdx = (() => {
  const orig = Module._load;
  Module._load = function (r, ...rest) {
    if (r === "./db") return fakeDb;
    if (r === "./dropbox-integration") return fakeDbx;
    return orig.call(this, r, ...rest);
  };
  const m = require("../civil-dropbox");
  Module._load = orig;
  return m;
})();

const fakeCdx = {
  normalizePath: realCdx.normalizePath,
  rootsAreConfigured: async () => S.rootsConfigured,
  getCivilRoots: async () => S.roots,
  setCaseFolder: async (id, p) => { S.linked = { id, path: p }; return { id, dropbox_path: p }; },
  syncCase: async () => { S.synced++; return { ok: true }; },
};

const fakeCivil = {
  logEvent: async (id, ev) => { if (S.dbDown) throw new Error("db down"); S.events.push({ id, ...ev }); },
};

const P = (() => {
  const orig = Module._load;
  Module._load = function (r, ...rest) {
    if (r === "./db") return fakeDb;
    if (r === "./dropbox-integration") return fakeDbx;
    if (r === "./civil-dropbox") return fakeCdx;
    if (r === "./civil-litigation") return fakeCivil;
    return orig.call(this, r, ...rest);
  };
  const m = require("../civil-provision");
  // Leave the hook in place: civil-provision requires Dropbox and civil
  // lazily, inside the functions under test.
  return m;
})();

const caseRow = (over = {}) => Object.assign({
  id: 42, client_key: "ruiz-ana", case_name: "Ruiz v. Acme Corp.",
  case_number: "25STCV01234", our_role: "plaintiff", dropbox_path: null,
}, over);

(async () => {
  console.log("\n── Naming the folder ───────────────────────────");
  check("caption and case number, the way the importer parses them", () =>
    P.folderNameForCase(caseRow()) === "Ruiz v. Acme Corp. - 25STCV01234");
  check("…without repeating a number the caption already has", () =>
    P.folderNameForCase(caseRow({ case_name: "Ruiz v. Acme 25STCV01234" })) === "Ruiz v. Acme 25STCV01234");
  check("…just the caption when there is no number yet", () =>
    P.folderNameForCase(caseRow({ case_number: null })) === "Ruiz v. Acme Corp");
  check("…a dot mid-name survives; only a final one is dropped", () =>
    /Corp\. - 25STCV/.test(P.folderNameForCase(caseRow())));
  check("characters Dropbox rejects are removed", () =>
    P.folderNameForCase(caseRow({ case_name: 'A/B: "C" <d>|e?', case_number: null })) === "A B C d e");
  check("a trailing dot Windows cannot open is removed", () =>
    !/\.$/.test(P.safeFolderName("Smith Holdings Inc.")));
  check("a case with no name gets no folder rather than a blank one", () =>
    P.folderNameForCase(caseRow({ case_name: "   " })) === null);
  check("the importer still reads a folder made here", () => {
    const parsed = realCdx.parseCaseFolderName(P.folderNameForCase(caseRow()));
    return parsed.case_number === "25STCV01234" && /Ruiz/.test(parsed.client_name) && /Acme/.test(parsed.opposing_party || "");
  });

  console.log("\n── The standard subfolders ─────────────────────");
  const cats = realCdx.DOC_CATEGORIES.filter(c => c.key !== "other");
  P.STANDARD_SUBFOLDERS.forEach(sub => {
    check(`a file dropped in "${sub}" is filed by its folder`, () => {
      const got = realCdx.categorizeFile("scan0007.pdf", sub);
      return got !== "other" || `categorised as ${got}`;
    });
  });
  check("every document category has a subfolder", () => {
    const hit = new Set(P.STANDARD_SUBFOLDERS.map(s => realCdx.categorizeFile("scan0007.pdf", s)));
    const missing = cats.filter(c => !hit.has(c.key)).map(c => c.label);
    return !missing.length || "no folder for: " + missing.join(", ");
  });
  check("…and no two subfolders file to the same category", () =>
    new Set(P.STANDARD_SUBFOLDERS.map(s => realCdx.categorizeFile("x.pdf", s))).size === P.STANDARD_SUBFOLDERS.length);

  console.log("\n── The client profile ──────────────────────────");
  reset();
  let c = await P.ensureClientProfile(caseRow({ client_key: "existing-client" }));
  check("a client already on file is reused", () => c.created === false && c.reason === "already on file");
  check("…and nothing is inserted", () => S.inserts.length === 0);

  reset();
  c = await P.ensureClientProfile(caseRow(), { clientName: "Ana Ruiz", createdBy: "jj" });
  check("a new key gets a contact", () => c.created === true);
  check("…under exactly the key on the case", () => S.inserts[0].key === "ruiz-ana");
  check("…with the name the attorney typed", () => S.inserts[0].name === "Ana Ruiz");
  check("…attributed to whoever opened the matter", () => S.inserts[0].by === "jj");

  reset();
  c = await P.ensureClientProfile(caseRow());
  check("no name typed, plaintiff side: the first-named party", () => S.inserts[0].name === "Ruiz");

  reset();
  c = await P.ensureClientProfile(caseRow({ our_role: "defendant", client_key: "acme-corp" }));
  check("…but for the DEFENDANT, never the first-named party", () =>
    S.inserts[0].name !== "Ruiz" || "named our client after the plaintiff suing them");
  check("…it falls back to the key instead", () => S.inserts[0].name === "Acme Corp");

  check("a generated key's suffix does not become part of the name", () =>
    P.nameFromKey("contact-ana-ruiz-lx9k2m1q") === "Ana Ruiz");

  reset();
  c = await P.ensureClientProfile(caseRow({ client_key: "" }));
  check("a case with no client key is reported, not guessed at", () => c.created === false && !!c.reason);

  reset({ dbDown: true });
  c = await P.ensureClientProfile(caseRow());
  check("a database failure is reported, not thrown", () => c.created === false && /ECONNREFUSED/.test(c.error));

  console.log("\n── The Dropbox folder ──────────────────────────");
  reset();
  let d = await P.ensureCaseFolder(caseRow());
  const want = "/Civil Litigation/Ruiz v. Acme Corp. - 25STCV01234";
  check("the matter folder is created under the civil root", () => d.created && d.path === want);
  check("…with all eleven standard subfolders inside it", () =>
    d.subfolders.length === 11 && S.created.includes(want + "/Discovery") && S.created.includes(want + "/Orders & Rulings"));
  check("…linked to the case", () => S.linked && S.linked.id === 42 && S.linked.path === want);
  check("…and synced once so the case page is not empty", () => d.synced && S.synced === 1);

  reset();
  S.folders.add(want);                          // somebody made it by hand already
  d = await P.ensureCaseFolder(caseRow());
  check("an existing folder of that name is adopted, not duplicated", () =>
    d.adopted && !d.created && !S.created.includes(want));
  check("…and still linked", () => d.linked && S.linked.path === want);

  reset();
  d = await P.ensureCaseFolder(caseRow({ dropbox_path: "/Civil Litigation/Old Folder" }));
  check("a case that already has a folder is left completely alone", () =>
    d.reason === "already linked" && S.created.length === 0 && S.linked === null);

  reset({ dbxConfigured: false });
  d = await P.ensureCaseFolder(caseRow());
  check("with Dropbox disconnected it says so", () => /not connected/.test(d.reason) && S.created.length === 0);

  reset({ rootsConfigured: false, roots: ["/Immigration/West Covina"] });
  d = await P.ensureCaseFolder(caseRow());
  check("with NO CIVIL ROOT set, nothing is created anywhere", () => S.created.length === 0 || "created: " + S.created.join(", "));
  check("…in particular nothing under the immigration tree", () => !S.created.some(p => /Immigration/.test(p)));
  check("…and the attorney is told why", () => /immigration/i.test(d.reason));

  reset({ dbxDown: true });
  d = await P.ensureCaseFolder(caseRow());
  check("a Dropbox outage is reported, not thrown", () => d.created === false && /503/.test(d.error));
  check("…and nothing is linked to a folder that was never made", () => S.linked === null);

  console.log("\n── The whole job ───────────────────────────────");
  reset();
  let rep = await P.provisionNewCase(caseRow(), { createdBy: "jj", clientName: "Ana Ruiz" });
  check("both halves run", () => rep.client.created && rep.dropbox.created);
  check("the summary says what was done", () =>
    /client profile created \(Ana Ruiz\)/.test(rep.summary) && /Dropbox folder created at/.test(rep.summary));
  check("…and it is written into the case's own history", () =>
    S.events.length === 1 && S.events[0].title === "Matter set up" && S.events[0].description === rep.summary);

  reset({ dbDown: true, dbxDown: true });
  let threw = null;
  try { rep = await P.provisionNewCase(caseRow()); } catch (e) { threw = e; }
  check("EVERYTHING failing still does not throw", () => threw === null || threw.message);
  check("…the report says what failed", () => /no Dropbox folder/.test(rep.summary));
  check("…and notes that the history could not be written", () =>
    rep.notes.some(n => /history/.test(n)));

  reset();
  rep = await P.provisionNewCase(null);
  check("no case at all is handled, not thrown", () => rep.notes.length === 1);

  reset({ slowMs: 60 });
  const t0 = Date.now();
  rep = await P.provisionWithin(caseRow(), {}, 25);
  check("a slow Dropbox does not hold the form hostage", () => Date.now() - t0 < 55 || `${Date.now() - t0}ms`);
  check("…the caller is told it is still going", () => rep.pending === true && /still setting up/.test(rep.summary));
  await new Promise(r => setTimeout(r, 1200));   // let the background job finish
  check("…and it does finish in the background", () => S.linked && S.linked.id === 42);

  reset();
  rep = await P.provisionWithin(caseRow(), {}, 2000);
  check("a quick setup comes back complete, not pending", () => !rep.pending && rep.dropbox.created);

  console.log("\n── Wiring ──────────────────────────────────────");
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const api = fs.readFileSync(path.join(REPO, "app-api.js"), "utf8");
  const ui = fs.readFileSync(path.join(REPO, "civil-litigation-ui.js"), "utf8");

  const webCreate = server.slice(server.indexOf('app.post("/admin/civil", '), server.indexOf('app.get("/admin/pi/case/:id"'));
  check("the web create route provisions", () => /provisionWithin\(created/.test(webCreate));
  check("…AFTER the case is saved", () => webCreate.indexOf("createCase(") < webCreate.indexOf("provisionWithin("));
  check("…and hands the report back", () => /res\.json\(\{ ok: true, case: created, provisioning \}\)/.test(webCreate));

  const appCreate = api.slice(api.indexOf('app.post("/api/staff/civil/cases", '), api.indexOf('app.get("/api/staff/civil/cases/:id"'));
  check("the app create route provisions too", () => /provisionWithin\(created/.test(appCreate));
  check("a retry endpoint exists for existing matters", () =>
    /app\.post\("\/api\/staff\/civil\/cases\/:id\/provision"/.test(api));
  check("…which the web reaches through the admin mirror", () =>
    ui.includes('"/admin/civil/api/cases/" + id + "/provision"'));
  check("the case page offers CREATE FOLDER when nothing is linked", () =>
    /dbxProvision\(\$\{id\}\)/.test(ui) && /CREATE FOLDER/.test(ui));
  check("the new-case form takes a client name for a new client", () => /name="client_name"/.test(server));
  check("the documents-panel handlers load even with no documents", () =>
    /\+ script;/.test(ui) && /\$\{script\}/.test(ui));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL CIVIL-PROVISION CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
