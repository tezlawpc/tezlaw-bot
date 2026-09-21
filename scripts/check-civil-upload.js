/**
 * check-civil-upload.js
 *
 * Documents uploaded on the web are filed into the case's Dropbox
 * folder, sorted into the right subfolder — and the documents dropped
 * on the new-case form are filed there as soon as the case exists.
 *
 * What this pins:
 *
 *   · Sorting matches the Dropbox sync's own categoriser, so a file
 *     lands where the case page would have filed it anyway.
 *   · NOTHING IS EVER OVERWRITTEN. Every upload is mode "add" with
 *     autorename; a second Complaint.pdf becomes "Complaint (1).pdf".
 *   · A file name can never become a path out of the matter folder.
 *   · One bad file does not sink the batch.
 *   · A case with no folder gets one first; an archived case refuses.
 *   · The two browser halves post what the route expects.
 */
const { JSDOM } = require("jsdom");
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

// ── Fakes ───────────────────────────────────────────────────
const S = {};
function reset(over = {}) {
  Object.assign(S, {
    cases: { 42: { id: 42, case_name: "Ruiz v. Acme Corp.", dropbox_path: "/Civil/Ruiz v. Acme Corp. - 25STCV01234", files_archived_at: null } },
    uploads: [], events: [], synced: 0,
    existing: new Set(), failNames: new Set(),
    dbxConfigured: true, provisionResult: null,
  }, over);
}
reset();

const fakeDb = { query: async () => ({ rows: [] }) };
const realCdx = (() => {
  const orig = Module._load;
  Module._load = function (r, ...rest) {
    if (r === "./db") return fakeDb;
    if (r === "./dropbox-integration") return {};
    return orig.call(this, r, ...rest);
  };
  const m = require("../civil-dropbox");
  Module._load = orig;
  return m;
})();

const fakeDbx = {
  isConfigured: () => S.dbxConfigured,
  uploadFile: async ({ path: p, buffer, mode, autorename }) => {
    S.uploads.push({ path: p, mode, autorename, bytes: buffer.length });
    const name = p.split("/").pop();
    if (S.failNames.has(name)) throw new Error("Dropbox upload failed: too_many_write_operations");
    let saved = p;
    if (S.existing.has(p)) saved = p.replace(/(\.[^.]+)$/, " (1)$1");
    S.existing.add(saved);
    return { path_display: saved };
  },
};
const fakeCdx = {
  DOC_CATEGORIES: realCdx.DOC_CATEGORIES,
  categorizeFile: realCdx.categorizeFile,
  syncCase: async () => { S.synced++; return { ok: true }; },
};
const fakeCivil = {
  getCase: async id => (S.cases[id] ? Object.assign({}, S.cases[id]) : null),
  logEvent: async (id, ev) => { S.events.push(Object.assign({ id }, ev)); },
};
const fakeProvision = {
  ensureCaseFolder: async c => {
    if (S.provisionResult && S.provisionResult.linked) S.cases[c.id].dropbox_path = S.provisionResult.path;
    return S.provisionResult || { created: false, linked: false, reason: "Dropbox is not connected" };
  },
};

const U = (() => {
  const orig = Module._load;
  Module._load = function (r, ...rest) {
    if (r === "./db") return fakeDb;
    if (r === "./dropbox-integration") return fakeDbx;
    if (r === "./civil-dropbox") return fakeCdx;
    if (r === "./civil-litigation") return fakeCivil;
    if (r === "./civil-provision") return fakeProvision;
    return orig.call(this, r, ...rest);
  };
  return require("../civil-upload");
})();

const file = (name, body = "x") => ({ originalname: name, buffer: Buffer.from(body) });
const ROOT = "/Civil/Ruiz v. Acme Corp. - 25STCV01234";

(async () => {
  console.log("\n── Where a file goes ───────────────────────────");
  const place = (n, o) => U.placeFile(n, ROOT, fakeCdx, o);
  check("a complaint goes to Pleadings", () => place("Verified Complaint.pdf").folder === ROOT + "/Pleadings");
  check("a summons goes to Pleadings", () => place("SUM-100 Summons.pdf").folder === ROOT + "/Pleadings");
  check("a retainer goes to Billing & Trust", () => place("Retainer Agreement - Ruiz.pdf").folder === ROOT + "/Billing & Trust");
  check("a fee agreement goes to Billing & Trust, not Evidence", () =>
    place("Fee Agreement.pdf").category === "billing");
  check("…an engagement letter too", () => place("Engagement Letter - Ruiz.pdf").category === "billing");
  check("…but a contract in dispute is still Evidence", () => place("Purchase Agreement.pdf").category === "evidence");
  check("…and a settlement agreement is still Settlement", () => place("Settlement Agreement.pdf").category === "settlement");
  check("a discovery set goes to Discovery", () => place("Special Interrogatories Set One.pdf").folder === ROOT + "/Discovery");
  check("a deposition transcript goes to Depositions", () => place("Ruiz Deposition Transcript.pdf").folder === ROOT + "/Depositions");
  check("an unrecognisable file goes to the matter folder, not a guessed one", () =>
    place("scan0007.pdf").folder === ROOT && /uncategorized/.test(place("scan0007.pdf").label));
  check("…unless it came from the new-case intake, where it is a pleading", () =>
    place("scan0007.pdf", { fallback: "pleadings" }).folder === ROOT + "/Pleadings");
  check("…but the intake fallback never overrides a clear name", () =>
    place("Retainer.pdf", { fallback: "pleadings" }).category === "billing");
  check("the attorney's chosen category wins over the name", () =>
    place("scan0007.pdf", { explicit: "depositions" }).folder === ROOT + "/Depositions");
  check("…even when the name points somewhere else", () =>
    place("Complaint.pdf", { explicit: "evidence" }).category === "evidence");
  check("an invented category is ignored, not trusted", () =>
    place("Complaint.pdf", { explicit: "../../etc" }).category === "pleadings");
  check("every subfolder used is one the new-case setup creates", () => {
    const made = new Set(require("../civil-provision").STANDARD_SUBFOLDERS);
    const used = realCdx.DOC_CATEGORIES.filter(c => c.key !== "other").map(c => c.label);
    const stray = used.filter(l => !made.has(l));
    return !stray.length || "not created by setup: " + stray.join(", ");
  });

  console.log("\n── File names ──────────────────────────────────");
  check("a path in the name is stripped to the file name", () => U.safeFileName("../../etc/passwd") === "passwd");
  check("…Windows paths too", () => U.safeFileName("C:\\Users\\jj\\Complaint.pdf") === "Complaint.pdf");
  check("characters Dropbox rejects are removed", () => U.safeFileName('Ex "A": <photo>?.jpg') === "Ex A photo .jpg");
  check("the extension survives", () => /\.pdf$/.test(U.safeFileName("Order re: MSJ.pdf")));
  check("an empty name still gets a name", () => U.safeFileName("   ") === "document");

  console.log("\n── Uploading ───────────────────────────────────");
  reset();
  let r = await U.uploadToCase(42, [file("Complaint.pdf"), file("Retainer Agreement.pdf"), file("scan0007.pdf")], { by: "jj" });
  check("every file is uploaded", () => r.ok && r.uploaded.length === 3);
  check("…each into its own subfolder", () =>
    S.uploads[0].path === ROOT + "/Pleadings/Complaint.pdf" &&
    S.uploads[1].path === ROOT + "/Billing & Trust/Retainer Agreement.pdf" &&
    S.uploads[2].path === ROOT + "/scan0007.pdf");
  check("EVERY upload is add-only with autorename — never an overwrite", () =>
    S.uploads.every(u => u.mode === "add" && u.autorename === true));
  check("the mirror is synced so the case page shows them", () => r.synced && S.synced === 1);
  check("the case history records what went where, and who", () =>
    S.events.length === 1 && /3 documents filed to Dropbox/.test(S.events[0].title) &&
    /Complaint\.pdf → Pleadings/.test(S.events[0].description) && S.events[0].created_by === "jj");

  reset();
  S.existing.add(ROOT + "/Pleadings/Complaint.pdf");
  r = await U.uploadToCase(42, [file("Complaint.pdf")]);
  check("a second Complaint.pdf is kept alongside the first, not over it", () =>
    r.uploaded[0].saved_as === "Complaint (1).pdf" && r.uploaded[0].renamed === true);
  check("…and the history says it was renamed", () => /renamed/.test(S.events[0].description));

  reset();
  S.failNames.add("Bad.pdf");
  r = await U.uploadToCase(42, [file("Complaint.pdf"), file("Bad.pdf"), file("Answer.pdf")]);
  check("one failing file does not sink the batch", () => r.uploaded.length === 2 && r.failed.length === 1);
  check("…the failure is named, with Dropbox's reason", () =>
    r.failed[0].name === "Bad.pdf" && /too_many_write_operations/.test(r.failed[0].error));
  check("…and recorded in the history", () => /FAILED: Bad\.pdf/.test(S.events[0].description));

  reset();
  S.failNames.add("Complaint.pdf");
  r = await U.uploadToCase(42, [file("Complaint.pdf")]);
  check("if nothing uploads, the result says so", () => r.ok === false && r.uploaded.length === 0);
  check("…and nothing is synced for no reason", () => S.synced === 0);

  reset({ intake: true });
  r = await U.uploadToCase(42, [file("scan0007.pdf")], { fallback: "pleadings", source: "intake" });
  check("new-case intake papers the name cannot place go to Pleadings", () =>
    S.uploads[0].path === ROOT + "/Pleadings/scan0007.pdf");
  check("…and the history says they came from the intake", () => /from the new-case intake/.test(S.events[0].title));

  const expectThrow = async (label, fn, re) => {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    check(label, () => (err && re.test(err.message)) || (err ? err.message : "did not throw"));
  };

  reset();
  S.cases[42].dropbox_path = null;
  S.provisionResult = { created: true, linked: true, path: ROOT };
  r = await U.uploadToCase(42, [file("Complaint.pdf")]);
  check("a case with no folder gets one first, then the file", () =>
    r.provisioned && r.provisioned.created && S.uploads[0].path === ROOT + "/Pleadings/Complaint.pdf");

  reset();
  S.cases[42].dropbox_path = null;
  S.provisionResult = { created: false, linked: false, reason: "no civil Dropbox root is configured" };
  await expectThrow("…and when no folder can be made, it refuses and says why",
    () => U.uploadToCase(42, [file("Complaint.pdf")]), /no civil Dropbox root/);
  check("…having uploaded nothing", () => S.uploads.length === 0);

  reset();
  S.cases[42].files_archived_at = "2026-01-01";
  await expectThrow("an archived matter refuses new documents",
    () => U.uploadToCase(42, [file("Complaint.pdf")]), /archived/);

  reset({ dbxConfigured: false });
  await expectThrow("Dropbox disconnected is said plainly",
    () => U.uploadToCase(42, [file("Complaint.pdf")]), /not connected/);

  reset();
  await expectThrow("no files is refused", () => U.uploadToCase(42, []), /No files/);
  await expectThrow("more than twenty is refused", () =>
    U.uploadToCase(42, Array.from({ length: 21 }, (_, i) => file("f" + i + ".pdf"))), /Too many/);
  await expectThrow("an unknown case is refused", () => U.uploadToCase(999, [file("a.pdf")]), /not found/);

  // ── The case-page uploader ────────────────────────────────
  console.log("\n── The case-page uploader ──────────────────────");
  const cats = realCdx.DOC_CATEGORIES.filter(c => c.key !== "other").map(c => ({ key: c.key, label: c.label }));
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const page = `<!doctype html><html><body>
    <div id="dbx-msg"></div>
    <div data-civil-upload data-case-id="42" data-categories="${esc(JSON.stringify(cats))}"></div>
  </body></html>`;
  const dom = new JSDOM(page, { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/case/42" });
  const w = dom.window;
  let posted = null;
  w.fetch = (url, init) => {
    posted = { url, init };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({
      ok: true,
      uploaded: [
        { name: "Complaint.pdf", saved_as: "Complaint (1).pdf", renamed: true, folder_label: "Pleadings" },
        { name: "RFP.pdf", saved_as: "RFP.pdf", renamed: false, folder_label: "Discovery" },
      ],
      failed: [{ name: "Huge.pdf", error: "File too large" }],
    }) });
  };
  let reloaded = false;
  try { Object.defineProperty(w.location, "reload", { value: () => { reloaded = true; } }); } catch (e) {}
  w.eval(fs.readFileSync(path.join(REPO, "public", "civil-docs.js"), "utf8"));
  await new Promise(res => setTimeout(res, 10));

  const host = w.document.querySelector("[data-civil-upload]");
  const sel = host.querySelector("select");
  check("the uploader mounts on the case page", () => !!sel && /Drop documents here/.test(host.textContent));
  check("…offering Auto-sort first", () => sel.options[0].value === "" && /Auto-sort/.test(sel.options[0].text));
  check("…then every category", () => sel.options.length === cats.length + 1);
  check("…but not Uncategorized as a destination", () =>
    !Array.prototype.some.call(sel.options, o => o.value === "other"));

  sel.value = "depositions";
  const fi = host.querySelector('input[type="file"]');
  Object.defineProperty(fi, "files", {
    value: [new w.File(["a"], "Complaint.pdf"), new w.File(["b"], "RFP.pdf")], configurable: true,
  });
  fi.dispatchEvent(new w.Event("change"));
  await new Promise(res => setTimeout(res, 20));

  check("it posts to the case's upload route", () => posted && posted.url === "/admin/civil/api/cases/42/upload");
  check("…as multipart, under the field name the route reads", () =>
    posted.init.body instanceof w.FormData && posted.init.body.getAll("files").length === 2);
  check("…carrying the chosen category", () => posted.init.body.get("category") === "depositions");
  check("each result line says where the file went", () =>
    /Complaint \(1\)\.pdf → Pleadings/.test(host.textContent) && /RFP\.pdf → Discovery/.test(host.textContent));
  check("…says when a file was renamed rather than overwritten", () => /renamed/.test(host.textContent));
  check("…and names a failure with its reason", () => /Huge\.pdf — File too large/.test(host.textContent));

  // ── The new-case intake hands its files over ──────────────
  console.log("\n── The new-case intake ─────────────────────────");
  const dom2 = new JSDOM(`<!doctype html><html><body><form><div data-civil-intake></div><input name="case_name"></form></body></html>`,
    { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/new" });
  const w2 = dom2.window;
  const calls = [];
  w2.fetch = (url, init) => {
    calls.push({ url, init });
    const body = /upload$/.test(url)
      ? { ok: true, uploaded: [{ saved_as: "Complaint.pdf", folder_label: "Pleadings" }], failed: [] }
      : { ok: true, fields: {}, evidence: {}, warnings: [], attorney_must_enter: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  w2.eval(fs.readFileSync(path.join(REPO, "public", "civil-intake.js"), "utf8"));
  await new Promise(res => setTimeout(res, 10));

  check("nothing is pending before anything is dropped", () => w2.CivilIntake.pendingCount() === 0);
  const fi2 = w2.document.querySelector('[data-civil-intake] input[type="file"]');
  Object.defineProperty(fi2, "files", {
    value: [new w2.File(["c"], "Complaint.pdf"), new w2.File(["s"], "Summons.pdf")], configurable: true,
  });
  fi2.dispatchEvent(new w2.Event("change"));
  await new Promise(res => setTimeout(res, 20));
  check("the dropped documents are kept for filing", () => w2.CivilIntake.pendingCount() === 2);
  check("…and the form says they will be filed when the case is created", () =>
    /will be filed to this matter's Dropbox folder/.test(w2.document.body.textContent));

  Object.defineProperty(fi2, "files", {
    value: [new w2.File(["c"], "Complaint.pdf"), new w2.File(["r"], "Retainer.pdf")], configurable: true,
  });
  fi2.dispatchEvent(new w2.Event("change"));
  await new Promise(res => setTimeout(res, 20));
  check("dropping more adds to them, without duplicating one already there", () =>
    w2.CivilIntake.pendingCount() === 3);

  const res = await w2.CivilIntake.fileTo(77);
  const up = calls.find(c => /\/upload$/.test(c.url));
  check("once the case exists they are posted to ITS upload route", () =>
    up && up.url === "/admin/civil/api/cases/77/upload");
  check("…all of them", () => up.init.body.getAll("files").length === 3);
  check("…marked as intake papers", () => up.init.body.get("source") === "intake");
  check("…and the result comes back to the form", () => res.ok && res.uploaded.length === 1);

  // ── Wiring ────────────────────────────────────────────────
  console.log("\n── Wiring ──────────────────────────────────────");
  const api = fs.readFileSync(path.join(REPO, "app-api.js"), "utf8");
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const ui = fs.readFileSync(path.join(REPO, "civil-litigation-ui.js"), "utf8");
  const cs = require("../client-script");

  check("the upload route exists, behind multer", () =>
    /app\.post\("\/api\/staff\/civil\/cases\/:id\/upload", auth1, auth2, civilDocUpload\.array\("files", 20\)/.test(api));
  check("…reaching the web through the admin mirror", () =>
    /"\/admin\/civil\/api\/cases\/" \+ encodeURIComponent\(caseId\) \+ "\/upload"/.test(fs.readFileSync(path.join(REPO, "public", "civil-docs.js"), "utf8")));
  check("the case page mounts the uploader and serves its script", () =>
    /data-civil-upload/.test(ui) && /clientScriptTag\("civil-docs\.js"\)/.test(ui));
  check("…but not on an archived matter", () => /\$\{archived \? "" : `<div data-civil-upload/.test(ui));
  check("the new-case form files the intake papers after creating the case", () =>
    /ci\.fileTo\(d\.case\.id\)/.test(server) &&
    server.indexOf('fetch("/admin/civil", {') < server.indexOf("ci.fileTo(d.case.id)"));
  check("the uploader is a rescuable client bundle", () => cs.CLIENT_BUNDLES.includes("civil-docs.js"));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL CIVIL-UPLOAD CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
