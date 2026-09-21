/**
 * check-civil-intake.js
 *
 * Two halves of one promise.
 *
 * The server half (civil-intake-extract.js) promises that nothing Zara
 * cannot quote from a document ever reaches the attorney, and that a
 * value which fails its own type becomes null rather than garbage.
 *
 * The browser half (public/civil-intake.js) promises that nothing is
 * written into the form except what the attorney ticked, that a case
 * type the dropdown does not offer is refused instead of silently
 * selecting nothing, and that the notes box is added to rather than
 * wiped.
 *
 * Both halves are exercised here against the REAL files — the real
 * extractor with a stubbed model, and the real client script in jsdom
 * against the real markup of /admin/civil/new. An intake screen that
 * quietly mistypes a case number is worse than no intake screen, so
 * these are the checks that decide whether the feature ships.
 */
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const REPO = path.join(__dirname, "..");

let failures = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r === undefined; if (r && r !== true) detail = String(r); }
  catch (e) { detail = e.message; }
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}

// ── Load the extractor with zara-core's model call stubbed ──
// The extractor is the thing under test; the model is not. `reply` is what
// each test wants Zara to have said.
let reply = "{}";
let replies = [];          // one per call, when a test needs a sequence
const thinkCalls = [];
const ex = (() => {
  const orig = Module._load;
  Module._load = function (r, ...rest) {
    if (r === "./zara-core") {
      return {
        think: async (a) => { thinkCalls.push(a); return { text: replies.length ? replies.shift() : reply, model: "stub" }; },
        DEFAULT_CHARTER: {}, BOUNDARIES: [],
      };
    }
    if (r === "./db") return { query: async () => ({ rows: [] }) };
    return orig.call(this, r, ...rest);
  };
  const m = require("../civil-intake-extract");
  Module._load = orig;
  return m;
})();

const txt = s => ({ buffer: Buffer.from(s, "utf8"), filename: "complaint.txt" });

(async () => {
  console.log("\n── The extractor ───────────────────────────────");

  // ── guessKind ─────────────────────────────────────────────
  check("a retainer is recognised by name", () => ex.guessKind("Smith Retainer Agreement.pdf") === "retainer");
  check("…as is an engagement letter", () => ex.guessKind("engagement-letter.docx") === "retainer");
  check("…and a fee agreement", () => ex.guessKind("FEE AGREEMENT signed.pdf") === "retainer");
  check("a summons is recognised", () => ex.guessKind("SUM-100 summons.pdf") === "summons");
  check("a complaint is recognised", () => ex.guessKind("Verified Complaint.pdf") === "complaint");
  check("a cross-complaint too", () => ex.guessKind("cross-complaint.pdf") === "complaint");
  check("anything else is honestly 'unknown'", () => ex.guessKind("scan0001.pdf") === "unknown");

  // ── clean(): a value that fails its own type becomes null ──
  const C = (k, v) => ex.clean("pleading", { [k]: v })[k];
  const R = (k, v) => ex.clean("retainer", { [k]: v })[k];

  check("a money figure loses its $ and commas", () => C("amount_in_controversy", "$1,250,000") === 1250000);
  check("…and nonsense money becomes null", () => C("amount_in_controversy", "a lot") === null);
  check("…as does negative money", () => C("amount_in_controversy", "-500") === null);
  check("a real filing date normalises to YYYY-MM-DD", () => C("filed_date", "March 4, 2024") === "2024-03-04");
  check("…a date that is not a date becomes null", () => C("filed_date", "sometime last spring") === null);
  check("…and a filing date in the future is refused", () => {
    // A complaint "filed" next month is a misread of a hearing or a
    // discovery-deadline date, not a filing.
    const next = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    return C("filed_date", next) === null;
  });
  check("parties come back as a trimmed array", () => {
    const v = C("plaintiffs", ["  Ana Ruiz ", "", "Ruiz Holdings LLC"]);
    return Array.isArray(v) && v.length === 2 && v[0] === "Ana Ruiz";
  });
  check("…a single string where an array belongs is refused", () => C("defendants", "Acme Corp.") === null);
  check("a known billing type is kept, lowercased", () => R("billing_type", "Contingency") === "contingency");
  check("…an invented one is refused", () => R("billing_type", "handshake") === null);
  check("a case number keeps its exact punctuation", () => C("case_number", "25STCV01234-B") === "25STCV01234-B");
  check("an empty string is null, not empty", () => C("court", "") === null);
  check("a field outside the schema is dropped entirely", () =>
    !("ssn" in ex.clean("pleading", { ssn: "123-45-6789" })));
  check("…including anything the model prefixed with _", () =>
    !("_thoughts" in ex.clean("pleading", { _thoughts: "hmm" })));
  check("retainer fields are not accepted on a pleading", () =>
    !("hourly_rate" in ex.clean("pleading", { hourly_rate: 500 })));

  // ── parseJson ─────────────────────────────────────────────
  check("plain JSON parses", () => ex.parseJson('{"a":1}').a === 1);
  check("…fenced JSON parses", () => ex.parseJson('```json\n{"a":2}\n```').a === 2);
  check("…JSON with a preamble parses", () => ex.parseJson('Sure!\n{"a":3}').a === 3);
  check("…and prose with no JSON throws rather than guessing", () => {
    try { ex.parseJson("I could not read those."); return false; }
    catch (e) { return /did not return JSON/.test(e.message); }
  });

  // ── The evidence gate — the point of the whole module ─────
  reply = JSON.stringify({
    case_name: "Ruiz v. Acme Corp.",
    case_number: "25STCV01234",
    court: "Superior Court of California, County of Los Angeles",
    filed_date: "2025-02-11",
    amount_in_controversy: "250000",
    _evidence: {
      case_name: "ANA RUIZ, Plaintiff, v. ACME CORP.",
      case_number: "Case No. 25STCV01234",
      // court, filed_date and amount deliberately unquoted
    },
  });
  const gated = await ex.extractFromDocuments([txt("ANA RUIZ, Plaintiff, v. ACME CORP. Case No. 25STCV01234")]);

  check("a quoted value survives", () => gated.fields.case_name === "Ruiz v. Acme Corp.");
  check("…and so does the second one", () => gated.fields.case_number === "25STCV01234");
  check("an UNQUOTED court is dropped to null", () => gated.fields.court === null);
  check("…an unquoted filing date is dropped", () => gated.fields.filed_date === null);
  check("…an unquoted damages figure is dropped", () => gated.fields.amount_in_controversy === null);
  check("…and the attorney is told it happened", () =>
    gated.warnings.some(w => /Dropped 3 value/.test(w)));
  check("…naming which fields were dropped", () => {
    const w = gated.warnings.find(w => /Dropped/.test(w)) || "";
    return w.includes("court") && w.includes("filed_date") && w.includes("amount_in_controversy");
  });
  check("the evidence itself comes back for display", () =>
    gated.evidence.case_number === "Case No. 25STCV01234");
  check("what only the attorney can know is named", () =>
    gated.attorney_must_enter.some(s => /retainer_received_date/.test(s)));

  // ── A scan with no text layer ─────────────────────────────
  const scanned = await ex.extractFromDocuments([{ buffer: Buffer.from("   \n  "), filename: "scan.txt" }]);
  check("a scan with no text layer fails honestly", () => scanned.ok === false);
  check("…and says it looks like a scan", () =>
    scanned.warnings.some(w => /scan/i.test(w)));
  check("…and proposes nothing at all", () => Object.keys(scanned.fields).length === 0);

  const bad = await ex.extractFromDocuments([{ buffer: Buffer.from("x"), filename: "photo.heic" }]);
  check("an unsupported file type is reported, not swallowed", () =>
    bad.ok === false && bad.warnings.some(w => /Unsupported file type/.test(w)));

  // ── The model going off-script ────────────────────────────
  reply = "I think this is probably a breach of contract case.";
  const prose = await ex.extractFromDocuments([txt("some pleading text")]);
  check("prose instead of JSON fails closed", () => prose.ok === false);
  check("…with nothing proposed", () => Object.keys(prose.fields).length === 0);

  // ── "Zara's answer could not be read as JSON" (JJ, uploading Liu v. Turco) ──
  const cut = '{"case_name": "Jing Liu v. James Turco, et al.", "defendants": ["James Turco", "Margaret Cheng Turco", "American Gateway Regional Centers"], ' +
    '"_evidence": {"case_name": "JING LIU, Plaintiff, v. JAMES TURCO", "defendants": "JAMES TURCO; MARGARET CHENG TUR' +
    '\n\n(Cut off at the length limit. Reply "continue" for the rest.)';
  check("an answer cut off mid-JSON is repaired, not thrown away", () => {
    const o = ex.parseJson(cut);
    return o.case_name === "Jing Liu v. James Turco, et al." && o.defendants.length === 3 && o._evidence.case_name === "JING LIU, Plaintiff, v. JAMES TURCO";
  });
  check("…and a trailing comma does not sink it", () => ex.parseJson('{"a": 1, "b": [1,2,],}').b.length === 2);
  check("…nor an unterminated fence", () => ex.parseJson('```json\n{"a": 5}').a === 5);

  thinkCalls.length = 0;
  replies = ["Here are the details: case is Liu v. Turco.", JSON.stringify({ case_name: "Liu v. Turco", _evidence: { case_name: "LIU v. TURCO" } })];
  const retried = await ex.extractFromDocuments([txt("LIU v. TURCO complaint")]);
  check("an unreadable answer gets one retry asking for JSON only", () =>
    thinkCalls.length === 2 && /JSON object ONLY/.test(thinkCalls[1].message) && retried.ok && retried.fields.case_name === "Liu v. Turco");
  check("the reader has room for a long answer", () => thinkCalls[0].maxTokens >= 4000);
  const longDoc = txt("CAPTION " + "x".repeat(15000) + " PRAYER FOR RELIEF");
  thinkCalls.length = 0; replies = [];
  await ex.extractFromDocuments([longDoc, txt("SUMMONS " + "y".repeat(5000))]);
  check("…and reads every document, not the first 8000 characters", () =>
    thinkCalls[0].maxMessageChars >= thinkCalls[0].message.length && /PRAYER FOR RELIEF/.test(thinkCalls[0].message) && /SUMMONS/.test(thinkCalls[0].message));
  replies = ["nope", "still nope"];
  const failed = await ex.extractFromDocuments([txt("x")]);
  check("two unreadable answers fail with a plain message", () =>
    failed.ok === false && failed.warnings.some(w => /could not read these documents this time/.test(w)));
  replies = [];

  reply = JSON.stringify({ case_name: null, court: null, _evidence: {} });
  const empty = await ex.extractFromDocuments([txt("some pleading text")]);
  check("an honest all-null answer still succeeds", () => empty.ok === true);
  check("…proposing nothing rather than inventing", () =>
    Object.values(empty.fields).every(v => v === null));

  await ex.extractFromDocuments([]).then(
    () => { failures++; console.log("  FAIL an empty upload must throw"); },
    e => console.log("  ok   an empty upload is refused  → " + e.message)
  );
  await ex.extractFromDocuments(new Array(9).fill(txt("x"))).then(
    () => { failures++; console.log("  FAIL more than six documents must be refused"); },
    e => console.log("  ok   more than six documents is refused  → " + e.message)
  );

  // ── The browser half ────────────────────────────────────────
  console.log("\n── The form filler ─────────────────────────────");

  // The real markup of /admin/civil/new: the mount point inside the form,
  // the selects with their real option lists, the notes textarea.
  const civil = require("../civil-litigation");
  const options = civil.CASE_TYPES.map(t => `<option value="${t}">${t}</option>`).join("");

  const PAGE = `<!doctype html><html><body>
    <h1>New Civil Case</h1>
    <form>
      <div data-civil-intake></div>
      <input name="client_key">
      <input name="case_name">
      <select name="case_type"><option value=""></option>${options}</select>
      <input name="case_number">
      <input name="court">
      <input name="county">
      <input name="opposing_party">
      <input type="number" name="amount_in_controversy">
      <input type="date" name="filed_date">
      <select name="billing_type"><option value="hourly">Hourly</option><option value="flat">Flat fee</option><option value="contingency">Contingency</option><option value="hybrid">Hybrid</option></select>
      <input type="number" name="hourly_rate">
      <input type="number" name="contingency_pct">
      <input type="number" name="retainer_amount">
      <textarea name="internal_notes"></textarea>
    </form>
  </body></html>`;

  const SERVER_REPLY = {
    ok: true,
    kind: "pleading",
    fields: {
      case_name: "Ruiz v. Acme Corp.",
      case_number: "25STCV01234",
      court: "Superior Court of California, County of Los Angeles",
      county: "Los Angeles",
      case_type: "breach of contract",
      filed_date: "2025-02-11",
      amount_in_controversy: 250000,
      plaintiffs: ["Ana Ruiz"],
      defendants: ["Acme Corp."],
      jurisdiction: "CA",
      billing_type: "hourly",
      hourly_rate: 525,
      fee_arrangement_notes: "Rate rises to $575 after 60 days.",
    },
    evidence: {
      case_name: "ANA RUIZ v. ACME CORP.",
      case_number: "Case No. 25STCV01234",
      court: "SUPERIOR COURT OF CALIFORNIA",
      county: "COUNTY OF LOS ANGELES",
      case_type: "FIRST CAUSE OF ACTION — BREACH OF CONTRACT",
      filed_date: "FILED Feb 11 2025",
      amount_in_controversy: "in excess of $250,000",
      plaintiffs: "ANA RUIZ, an individual",
      defendants: "ACME CORP., a Delaware corporation",
      jurisdiction: "STATE OF CALIFORNIA",
      billing_type: "billed hourly",
      hourly_rate: "$525.00 per hour",
      fee_arrangement_notes: "the rate shall increase to $575",
    },
    warnings: [],
    attorney_must_enter: ["retainer_received_date", "lead_attorney"],
  };

  const dom = new JSDOM(PAGE, { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/new" });
  const { window } = dom;
  const errors = [];
  window.addEventListener("error", e => errors.push(String(e.error || e.message)));

  let lastRequest = null;
  window.fetch = (url, init) => {
    lastRequest = { url, init };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SERVER_REPLY) });
  };

  const src = fs.readFileSync(path.join(REPO, "public", "civil-intake.js"), "utf8");
  window.eval(src);
  // The script defers to DOMContentLoaded, exactly as it does in a browser.
  await new Promise(r => setTimeout(r, 10));

  const doc = window.document;
  const host = doc.querySelector("[data-civil-intake]");

  check("the script mounted on the form's dropzone", () => host.children.length > 0);
  check("…without throwing", () => errors.length === 0 || errors.join("; "));
  check("…and exposes a re-boot hook", () => typeof window.CivilIntake.boot === "function");
  check("the dropzone names what it accepts", () => /PDF, DOCX or TXT/.test(host.textContent));
  check("…and says the attorney confirms", () => /proposes/i.test(host.textContent));

  // Drive an upload through the real change handler.
  const fileInput = host.querySelector('input[type="file"]');
  check("the file picker takes more than one document", () => fileInput.hasAttribute("multiple"));
  check("…and restricts to readable types", () => /pdf/.test(fileInput.getAttribute("accept")));

  Object.defineProperty(fileInput, "files", {
    value: [{ name: "complaint.pdf" }, { name: "summons.pdf" }],
    configurable: true,
  });
  fileInput.dispatchEvent(new window.Event("change"));
  await new Promise(r => setTimeout(r, 20));

  check("it posted to the extract endpoint", () =>
    lastRequest && lastRequest.url === "/admin/civil/intake/extract");
  check("…as a POST", () => lastRequest.init.method === "POST");
  check("…as multipart, not JSON", () =>
    !(lastRequest.init.headers && lastRequest.init.headers["Content-Type"]));

  const panelText = host.textContent;
  check("every found field is offered", () => /Zara proposes 13 fields/.test(panelText));
  check("…each shown with its quote", () => panelText.includes("Case No. 25STCV01234"));
  check("…and the attorney is told nothing is saved yet", () =>
    /Nothing is saved until you submit it yourself/.test(panelText));
  check("what documents cannot know is listed separately", () =>
    /yours to enter/.test(panelText) && /lead_attorney/.test(panelText));

  check("a field with no home on the form is marked as reference only", () =>
    /no matching field/.test(panelText));

  const checkboxes = host.querySelectorAll('input[type="checkbox"]');
  check("one tickbox per proposal", () => checkboxes.length === 13);
  check("…all ticked to start", () =>
    Array.prototype.every.call(checkboxes, c => c.checked));

  // Untick the case number, and put something in the notes by hand, before
  // filling — both of which the filler must respect.
  const labels = Array.prototype.slice.call(host.querySelectorAll("label"));
  const caseNoRow = labels.find(l => /CASE NUMBER/i.test(l.textContent));
  check("the case-number row is findable", () => !!caseNoRow);
  caseNoRow.querySelector('input[type="checkbox"]').checked = false;

  const form = doc.querySelector("form");
  form.querySelector('[name="internal_notes"]').value = "Client walked in 9/12, upset.";

  const fillBtn = Array.prototype.slice.call(host.querySelectorAll("button"))
    .find(b => /FILL THE FORM/.test(b.textContent));
  check("the fill button exists", () => !!fillBtn);
  fillBtn.dispatchEvent(new window.Event("click"));

  const val = n => form.querySelector('[name="' + n + '"]').value;

  check("the case name is filled", () => val("case_name") === "Ruiz v. Acme Corp.");
  check("the court is filled verbatim", () =>
    val("court") === "Superior Court of California, County of Los Angeles");
  check("the county is filled", () => val("county") === "Los Angeles");
  check("the filing date lands in the date input", () => val("filed_date") === "2025-02-11");
  check("the damages figure is filled", () => val("amount_in_controversy") === "250000");
  check("the hourly rate is filled", () => val("hourly_rate") === "525");

  check("AN UNTICKED FIELD IS NOT FILLED", () => val("case_number") === "");

  check("a case type the dropdown offers is selected", () => val("case_type") === "breach of contract");
  check("a billing type the dropdown offers is selected", () => val("billing_type") === "hourly");

  check("the notes the attorney typed survive", () =>
    val("internal_notes").indexOf("Client walked in 9/12, upset.") === 0);
  check("…with the fee note added below, attributed", () =>
    /From the retainer/.test(val("internal_notes")) && /\$575/.test(val("internal_notes")));

  check("plaintiffs are NOT guessed into the opposing-party box", () =>
    val("opposing_party") === "");
  check("…nor are defendants", () => !/Acme/.test(val("opposing_party")));

  check("the result line says how many were filled", () => /Filled \d+ field/.test(host.textContent));
  check("…and tells the attorney to check them", () =>
    /Check each one against the document/.test(host.textContent));
  check("…and names what had nowhere to go", () =>
    /No field on this form for:/.test(host.textContent) && /Jurisdiction/.test(host.textContent));

  // A second click must not double up the note.
  fillBtn.dispatchEvent(new window.Event("click"));
  check("filling twice does not duplicate the note", () =>
    val("internal_notes").split("From the retainer").length === 2);

  // ── A case type the dropdown does not have ────────────────
  const dom2 = new JSDOM(PAGE, { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/new" });
  dom2.window.fetch = () => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({
      ok: true, kind: "pleading",
      fields: { case_type: "admiralty salvage", case_name: "In re M/V Corsair" },
      evidence: { case_type: "IN ADMIRALTY", case_name: "IN RE M/V CORSAIR" },
      warnings: [], attorney_must_enter: [],
    }),
  });
  dom2.window.eval(src);
  await new Promise(r => setTimeout(r, 10));
  const host2 = dom2.window.document.querySelector("[data-civil-intake]");
  const fi2 = host2.querySelector('input[type="file"]');
  Object.defineProperty(fi2, "files", { value: [{ name: "c.pdf" }], configurable: true });
  fi2.dispatchEvent(new dom2.window.Event("change"));
  await new Promise(r => setTimeout(r, 20));
  Array.prototype.slice.call(host2.querySelectorAll("button"))
    .find(b => /FILL THE FORM/.test(b.textContent))
    .dispatchEvent(new dom2.window.Event("click"));
  const form2 = dom2.window.document.querySelector("form");

  check("a case type the dropdown does not offer selects NOTHING", () =>
    form2.querySelector('[name="case_type"]').value === "");
  check("…and the attorney is told it was skipped", () =>
    /No field on this form for:[^.]*Case type/.test(host2.textContent));
  check("…while the fields that did fit still filled", () =>
    form2.querySelector('[name="case_name"]').value === "In re M/V Corsair");

  // ── A failed read reaches the screen ──────────────────────
  const dom3 = new JSDOM(PAGE, { runScripts: "outside-only", url: "https://tezlawfirm.com/admin/civil/new" });
  dom3.window.fetch = () => Promise.resolve({
    ok: false, status: 500,
    json: () => Promise.resolve({ ok: false, error: "Nothing readable in the upload.", warnings: ["scan.pdf: no readable text — it looks like a scan."] }),
  });
  dom3.window.eval(src);
  await new Promise(r => setTimeout(r, 10));
  const host3 = dom3.window.document.querySelector("[data-civil-intake]");
  const fi3 = host3.querySelector('input[type="file"]');
  Object.defineProperty(fi3, "files", { value: [{ name: "scan.pdf" }], configurable: true });
  fi3.dispatchEvent(new dom3.window.Event("change"));
  await new Promise(r => setTimeout(r, 20));

  check("a failed read shows the error", () => /Nothing readable/.test(host3.textContent));
  check("…and the warning that explains it", () => /looks like a scan/.test(host3.textContent));
  check("…and fills nothing", () =>
    dom3.window.document.querySelector('[name="case_name"]').value === "");

  // ── The page actually serves the script ───────────────────
  console.log("\n── Wiring ──────────────────────────────────────");
  const serverSrc = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  check("the new-case form has a mount point", () => /data-civil-intake/.test(serverSrc));
  check("…and the page serves civil-intake.js", () =>
    /clientScriptTag\("civil-intake\.js"\)/.test(serverSrc));
  check("…the extract route exists", () =>
    /app\.post\("\/admin\/civil\/intake\/extract"/.test(serverSrc));
  check("…behind multer, capped at six files", () =>
    /docUpload\.array\("documents", 6\)/.test(serverSrc));
  check("…and under /admin, so requireAdminAuth covers it", () => {
    const authAt = serverSrc.indexOf('app.use("/admin", auth.requireAdminAuth)');
    const routeAt = serverSrc.indexOf('app.post("/admin/civil/intake/extract"');
    return authAt > -1 && routeAt > authAt;
  });
  check("the client bundle is deployed, not just written", () =>
    fs.existsSync(path.join(REPO, "public", "civil-intake.js")));

  console.log("\n" + (failures ? `${failures} FAILED` : "ALL CIVIL-INTAKE CHECKS PASSED"));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
