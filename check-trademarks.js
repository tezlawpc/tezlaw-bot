/**
 * check-trademarks.js
 *
 * JJ, on where trademark matters are tracked: "I don't want a different
 * system for the tracker. Whatever is most easy and efficient to keep track
 * and complete the task." — so they live in the Matter Manager and nowhere
 * else. On an automatic USPTO status check: "Yes I want automatic tsdr
 * status." And, asked whether staff need to see trademark matters now that
 * the Matter Manager is where they are: "Yes they do."
 *
 * Three things a later edit must not quietly undo:
 *
 *   1. The deadline rules. An office action on an application is answered in
 *      THREE months (one three-month extension), not six. This file said six
 *      until October 2026.
 *   2. The daily USPTO check (tsdr-sync.js) reads a record, recognises the
 *      entries that start a clock, and never mistakes a failure for "no
 *      change".
 *   3. Staff reach TRADEMARK matters in the Matter Manager and nothing else
 *      in it. The rule is "refused unless listed". Below, every route this
 *      router has is tried as a staff member and the ones that open are
 *      compared with a list written out here; every open address is then
 *      tried against a matter that is NOT a trademark (must be "Not found"),
 *      as a viewer (must not change anything), and for a second route
 *      answering at the same address. Add a route to matter-manager.js and
 *      it is closed to staff until it is added to STAFF_ROUTES there AND to
 *      OPEN_TO_STAFF here.
 *
 * No database and no network: ./db and ./auth are stood in for.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const REPO = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(REPO, f), "utf8");

// ── Stand-ins ────────────────────────────────────────────
const MATTERS = { 1: "Trademark", 2: "Habeas", 3: "Patent" };          // matter id → case_type
const ITEMS = { 10: 1, 20: 2 };                                         // checklist item id → matter id
const audit = [];                                                       // rows written to audit_log
let REFS = [];                                                          // case numbers other trademark matters carry
const DEADLINES = { 5: { matter: 1, title: "Respond", due_date: "2027-01-02", completed: false } };
const fakeDb = {
  query: async (sql, params) => {
    if (/INSERT INTO audit_log/.test(sql)) { audit.push({ username: params[1], role: params[2], action: params[3], target_id: params[5], changes: JSON.parse(params[7] || "null") }); return { rows: [] }; }
    if (/FROM matter_checklist_items i/.test(sql)) {
      const mid = ITEMS[params[0]];
      return { rows: mid ? [{ id: mid, case_type: MATTERS[mid], client_name: "C" + mid, mark: null }] : [] };
    }
    if (/SELECT id, case_type, client_name, mark FROM matters WHERE id = \$1/.test(sql)) {
      return { rows: MATTERS[params[0]] ? [{ id: params[0], case_type: MATTERS[params[0]], client_name: "C" + params[0], mark: null }] : [] };
    }
    if (/FROM matter_deadlines WHERE id = \$1 AND matter_id = \$2/.test(sql)) {
      const d = DEADLINES[params[0]];
      return { rows: d && d.matter === params[1] ? [d] : [] };
    }
    if (/regexp_replace\(matter_ref, '\[\^0-9\]'/.test(sql)) return { rows: REFS.map(r => ({ matter_ref: r })) };
    if (/FROM matter_notes WHERE id = \$1 AND matter_id = \$2/.test(sql)) return { rows: params[0] === 5 && params[1] === 1 ? [{ content: "Client approved the specimen." }] : [] };
    if (/FROM matter_files WHERE id = \$1 AND matter_id = \$2/.test(sql)) return { rows: params[0] === 5 && params[1] === 1 ? [{ filename: "specimen.pdf", url: "https://x.example/specimen.pdf" }] : [] };
    if (/FROM matters WHERE id = \$1/.test(sql)) return { rows: MATTERS[params[0]] ? [{ notes: "old notes", mark: "TEZ", serial_number: "99123456", matter_ref: "99123456", client_name: "C" }] : [] };
    if (/FROM matter_checklist_items WHERE id/.test(sql)) return { rows: [{ text: "item", completed: false }] };
    return { rows: [] };
  },
  logAudit: async () => {},
};
const GRANTS = {            // role → the two permissions that matter here
  admin: ["federal.read", "federal.write"], manager: ["federal.read", "federal.write"],
  attorney: ["federal.read", "federal.write"], paralegal: ["federal.read", "federal.write"],
  viewer: ["federal.read"], consultant: [],
};
const fakeAuth = { hasPermissionAsync: async (user, key) => (GRANTS[user.r] || []).includes(key) };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "./db") return fakeDb;
  if (request === "./auth") return fakeAuth;
  return origLoad.apply(this, arguments);
};

const mm = require("../matter-manager");
const tsdr = require("../tsdr-sync");
const I = tsdr._internal;

let failed = 0;
function check(name, fn) {
  let ok = false, err = null;
  try { ok = !!fn(); } catch (e) { err = e; }
  if (ok) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + (err ? " — " + err.message : "")); }
}
async function checkAsync(name, fn) {
  let ok = false, err = null;
  try { ok = !!(await fn()); } catch (e) { err = e; }
  if (ok) console.log("  ok   " + name);
  else { failed++; console.log("  FAIL " + name + (err ? " — " + err.message : "")); }
}
const dates = list => list.map(t => t.due_date);
const life = (event, anchor, basis) => mm.lifecycleDeadlines(event, anchor, { filing_basis: basis || null });

(async () => {
  console.log("\nTrademarks: the rules, the daily USPTO check, and who may see them\n");

  // ════════════════════════════════════════════════════════
  console.log("── 1. The deadline rules ───────────────────────");
  check("an office action is answered in 3 months; 6 is the last day and only with the extension", () => {
    const t = life("tm_office_action", "2026-11-30", "1(a)");
    return t.length === 2 && t[0].due_date === "2027-02-28" && t[1].due_date === "2027-05-30"
      && /response OR extension request due/.test(t[0].title) && /LAST DAY if extension was filed/.test(t[1].title)
      && /\$125/.test(t[0].note) && t.every(x => x.party === "us");
  });
  check("a Madrid (66(a)) application gets one date, six months, no extension", () => {
    const t = life("tm_office_action", "2026-11-30", "66(a)");
    return t.length === 1 && t[0].due_date === "2027-05-30" && /no extension/i.test(t[0].title);
  });
  check("the titles carry the issue date, so a second office action is not taken for the first", () =>
    life("tm_office_action", "2026-11-30")[0].title !== life("tm_office_action", "2027-06-01")[0].title);
  check("publication: 30 days to oppose, then a check for the registration or the notice of allowance", () => {
    const a = life("tm_publication", "2027-01-05", "1(a)"), b = life("tm_publication", "2027-01-05", "Section 1(b)");
    return a[0].due_date === "2027-02-04" && a[0].party === "them" && /registration expected/.test(a[1].title)
      && /Notice of Allowance expected/.test(b[1].title) && b[1].due_date === "2027-03-16";
  });
  check("statement of use: six dates, 6 months apart, never later than counting from the notice", () => {
    const d = dates(life("tm_noa", "2027-08-31", "1(b)"));
    return d.join() === "2028-02-29,2028-08-29,2029-02-28,2029-08-28,2030-02-28,2030-08-28";
  });
  check("registration: Section 8 and the first renewal, each with the day its grace period ends", () => {
    const t = life("tm_registration", "2028-02-29");
    return dates(t).join() === "2033-02-28,2034-02-28,2034-08-28,2037-02-28,2038-02-28,2038-08-28"
      && t.filter(x => /GRACE PERIOD ENDS/.test(x.title)).length === 2;
  });
  check("filing watch: two quiet estimates and a status check at months 3, 6, 9 and 12", () => {
    const t = life("tm_examination", "2026-10-15");
    return t.filter(x => x.party === "them").length === 2
      && t.filter(x => x.party === "us").map(x => x.due_date).join() === "2027-01-15,2027-04-15,2027-07-15,2027-10-15";
  });
  check("nothing here says six months to answer an office action, or TEAS Plus", () => {
    const src = read("matter-manager.js") + read("matters.html") + read("task-milestones.js");
    return !/6-month response deadline|6 months from issue to respond|so the 6-month response can be calculated/.test(src) && !/TEAS Plus/.test(src);
  });
  check("the filing basis is read however it was typed", () =>
    mm.normalizeFilingBasis("Section 1(b)") === "1(b)" && mm.normalizeFilingBasis("1A") === "1(a)" && mm.normalizeFilingBasis("66(a)") === "66(a)" && mm.normalizeFilingBasis("") === null);

  // ════════════════════════════════════════════════════════
  console.log("\n── 2. The daily USPTO check ────────────────────");
  const rec = (status, events, extra = {}) => JSON.stringify({ trademarks: [{
    gsList: [{ statusDescription: "ACTIVE", statusDate: "2021-11-19" }],
    relationshipBundleList: [{ usRegistrationNumber: "5123456" }],
    prosecutionHistory: events.map((e, i) => ({ entryNumber: i + 1, entryDate: e[0] + "T04:00:00.000+0000", entryDesc: e[1] })).reverse(),
    publication: {},
    status: { serialNumber: 99123456, markElement: "TEZ", filingDate: "2026-01-15", usRegistrationNumber: extra.reg || "", usRegistrationDate: extra.regDate || null, statusDate: "2026-09-01", extStatusDesc: status },
  }] });
  const plan = (body, today, baseline = true, seen = []) => I.planActions(I.parseBody(body).rec, { baseline, seenKeys: new Set(seen), today });

  check("it reads the record from where the USPTO puts it, not from a look-alike field", () => {
    const p = I.parseBody(rec("Awaiting examination.", [["2026-01-15", "NEW APPLICATION ENTERED"]]));
    return p.format === "json" && p.rec.statusDesc === "Awaiting examination." && p.rec.statusDate === "2026-09-01"
      && p.rec.regNumber === null && p.rec.events[0].date === "2026-01-15";
  });
  check("the same record as XML reads the same", () => {
    const xml = `<a:Trademark xmlns:a="t"><a:ApplicationDate>2026-01-15-04:00</a:ApplicationDate><a:MarkCurrentStatusExternalDescriptionText>Awaiting &amp; waiting.</a:MarkCurrentStatusExternalDescriptionText><a:MarkCurrentStatusDate>2026-09-01-04:00</a:MarkCurrentStatusDate><a:MarkEventBag><a:MarkEvent><a:MarkEventDate>2026-01-15-04:00</a:MarkEventDate><a:NationalMarkEvent><a:MarkEventDescriptionText>NEW APPLICATION ENTERED</a:MarkEventDescriptionText><a:MarkEventEntryNumber>1</a:MarkEventEntryNumber></a:NationalMarkEvent></a:MarkEvent></a:MarkEventBag></a:Trademark>`;
    const p = I.parseBody(xml);
    return p.format === "xml" && p.rec.statusDesc === "Awaiting & waiting." && p.rec.events.length === 1 && p.rec.filingDate === "2026-01-15";
  });
  check("a reply it cannot read is a failure, never “no change”", () =>
    I.parseBody('{"hello":"world"}').rec === null && I.parseBody("<html>maintenance</html>").rec === null
    && I.parseBody(rec("x", [])).rec === null && I.parseBody("").rec === null);
  check("the entries that start a clock are recognised by their wording", () => {
    const t = d => I.classifyEvent(d).type;
    return t("NON-FINAL ACTION E-MAILED") === "office_action" && t("FINAL REFUSAL E-MAILED") === "office_action"
      && I.classifyEvent("FINAL REFUSAL E-MAILED").final === true
      && t("INQUIRY TO SUSPENSION E-MAILED") === "office_action"
      && t("PUBLISHED FOR OPPOSITION") === "published"
      && t("NOA E-MAILED - SOU REQUIRED FROM APPLICANT") === "noa"
      && t("REGISTERED-PRINCIPAL REGISTER") === "registered"
      && t("REGISTERED AND RENEWED (FIRST RENEWAL - 10 YRS)") === "renewed"
      && t("ABANDONMENT - FAILURE TO RESPOND OR LATE RESPONSE") === "abandoned"
      && t("OPPOSITION INSTITUTED NO. 91299999") === "opposition";
  });
  check("…and the ones that do not, are not", () => {
    const t = d => I.classifyEvent(d).type;
    return t("TEAS RESPONSE TO OFFICE ACTION RECEIVED") === "other" && t("NON-FINAL ACTION WRITTEN") === "other"
      && t("PETITION TO REVIVE-GRANTED") === "other" && t("TEAS RESPONSE TO SUSPENSION INQUIRY RECEIVED") === "other"
      && t("CANCELLATION TERMINATED NO. 999999") === "other" && t("REGISTERED - SEC. 8 (6-YR) ACCEPTED") === "sec8_accepted";
  });
  check("a new office action becomes the 3- and 6-month deadlines, dated from its first mailed entry", () => {
    const body = rec("Office action.", [["2026-01-15", "NEW APPLICATION ENTERED"], ["2026-09-01", "NON-FINAL ACTION E-MAILED"], ["2026-09-02", "NOTIFICATION OF NON-FINAL ACTION E-MAILED"]]);
    const a = plan(body, "2026-09-10");
    const t = I.templatesFor(a[0], { filing_basis: "1(a)" }, mm.lifecycleDeadlines, "2026-09-10").templates;
    return a.length === 1 && a[0].type === "office_action" && a[0].date === "2026-09-01" && dates(t).join() === "2026-12-01,2027-03-01";
  });
  check("an office action already answered is left alone; a request for reconsideration is not an answer", () => {
    const answered = rec("x", [["2026-06-01", "NON-FINAL ACTION E-MAILED"], ["2026-07-01", "TEAS RESPONSE TO OFFICE ACTION RECEIVED"]]);
    const recon = rec("x", [["2026-08-01", "FINAL REFUSAL E-MAILED"], ["2026-08-20", "TEAS REQUEST FOR RECONSIDERATION RECEIVED"]]);
    return plan(answered, "2026-09-10").length === 0 && plan(recon, "2026-09-10")[0].final === true;
  });
  check("a registration under a cancellation PROCEEDING is alive and keeps its maintenance dates", () => {
    const body = rec("A cancellation proceeding is pending at the Trademark Trial and Appeal Board.", [["2021-10-04", "REGISTERED-PRINCIPAL REGISTER"], ["2026-09-01", "CANCELLATION INSTITUTED NO. 999999"]], { reg: "6100001", regDate: "2021-10-04" });
    const a = plan(body, "2026-10-04");
    return a.some(x => x.type === "registered") && !a.some(x => x.type === "dead");
  });
  check("after a renewal is accepted the NEXT ten-year cycle is calendared, not the one just finished", () => {
    const c = I.cycleAfterRenewal("2006-11-10", "2026-10-04");
    return c.k === 3 && dates(c.templates).join() === "2035-11-10,2036-11-10,2037-05-10";
  });
  check("a renewal is never counted from its own date when the registration date is missing", () => {
    const a = plan(rec("Registered and renewed.", [["2026-09-28", "REGISTERED AND RENEWED (FIRST RENEWAL - 10 YRS)"]]), "2026-10-04");
    return a[0].type === "renewed" && a[0].date == null;
  });
  check("the mark on the matter must match the USPTO's, so a mistyped number tracks nobody else's mark", () =>
    I.marksAgree("TEZ", "Tez Law") === true && I.marksAgree("TEZ", "SOMEONE ELSE") === false && I.marksAgree("CAFÉ ROMA", "CAFE ROMA") === true && I.marksAgree(null, "Shield design") === null);
  check("8 digits is a serial number, 7 a registration number, anything else is refused", () =>
    tsdr.caseId("99/123,456").id === "sn99123456" && tsdr.caseId("5,320,233").id === "rn5320233" && tsdr.caseId("12345") === null && tsdr.caseId("912999990") === null);
  check("a failure is reported at once when it matters, and not every day after", () => {
    const now = Date.now(), ago = h => new Date(now - h * 3600e3);
    const f = (code, o = {}) => I.shouldAlertFailure({ code, firstErrorAt: ago(1), hadSuccess: false, ...o }, now);
    return f("KEY_REJECTED") && f("MARK_MISMATCH") && f("BAD_NUMBER") && f("UNREADABLE", { hadSuccess: true })
      && !f("NETWORK") && f("NETWORK", { firstErrorAt: ago(21) }) && !f("NOT_FOUND") && f("NOT_FOUND", { firstErrorAt: ago(24 * 10) })
      && !f("UNREADABLE", { hadSuccess: true, lastAlertedAt: ago(24), lastAlertedCode: "UNREADABLE" })
      && f("UNREADABLE", { hadSuccess: true, lastAlertedAt: ago(24 * 7), lastAlertedCode: "UNREADABLE" });
  });
  const server = read("server.js"), sync = read("tsdr-sync.js");
  check("it runs every morning before the 7:00 summary, and catches up after a restart", () =>
    /cron\.schedule\("40 6 \* \* \*", scheduledRun, \{ timezone: "America\/Los_Angeles" \}\)/.test(sync) && /catch-up check/.test(sync)
    && /require\("\.\/tsdr-sync"\)/.test(server) && /tsdrSync\.startScheduler\(/.test(server));
  check("an alert that cannot be delivered is kept, not dropped", () =>
    /throw new Error\("JJ_TELEGRAM_ID is not set"\)/.test(server) && /pending_alert/.test(sync) && /async function flushPending/.test(sync));
  check("the reminder job reads a due date as text (a Date object here once made every reminder fire on day one)", () =>
    (server.match(/to_char\(d\.due_date, 'YYYY-MM-DD'\) AS due_date/g) || []).length >= 2);

  // ════════════════════════════════════════════════════════
  console.log("\n── 3. Trademarks live in one place ─────────────");
  const fm = require("../federal-matters");
  check("the Federal Matters page takes no new trademark rows", () =>
    fm.isTrademarkType("tm_application") && !fm.isTrademarkType("habeas_corpus_2241")
    && /if \(fm\.isTrademarkType\(req\.body && req\.body\.matter_type\)\)/.test(server)
    && /filter\(\(\[grp\]\) => grp !== "trademarks"\)/.test(server));
  check("…and can move the ones it has, closing them rather than deleting them", () =>
    typeof fm.moveTrademarkToMatterManager === "function" && /SET status = 'closed'/.test(read("federal-matters.js")) && !/DELETE FROM federal_matters[^`]*Moved/.test(read("federal-matters.js")));
  const nav = read("hearing-notes.js");
  const fedNav = nav.slice(nav.indexOf('id="section-federal"'), nav.indexOf('id="section-pi"'));
  check("the sidebar's Trademarks link opens the Matter Manager's trademark view", () =>
    /href="\/admin\/matters\/\?view=trademarks" class="nav-link[^"]*" data-perm="federal\.read"/.test(fedNav) && !/\/admin\/federal\?group=trademarks/.test(fedNav)
    && /"trademarks"\]\)/.test(read("matter-manager.js")));
  check("…and so do the Federal Matters page's own trademark tile and tab", () =>
    !/href="\/admin\/federal\?group=trademarks"/.test(server) && (server.match(/href="\/admin\/matters\/\?view=trademarks"/g) || []).length >= 2);

  // ════════════════════════════════════════════════════════
  console.log("\n── 4. Staff: trademark matters, and nothing else ");
  const src = read("matter-manager.js");
  check("the gate stands in front of the whole router", () =>
    /app\.use\("\/admin\/matters", matterAccess, matterManagerRouter\)/.test(server) && typeof mm.matterAccess === "function"
    && (server.match(/matterManagerRouter/g) || []).length === 2);          // named where it is loaded, and at that one mount
  check("without the gate in front, only the admin gets in", () =>
    /function requireAuth\(req, res, next\) \{\s*if \(req\.mmScope === "trademark"\) return next\(\);\s*return requireAdminAuth\(req, res, next\);/.test(src));
  check("a staff member who opens the Matter Manager lands on the trademark view", () =>
    /if \(req\.mmScope === "trademark" && req\.query\.view !== "trademarks"\) return res\.redirect\("\/admin\/matters\/\?view=trademarks"\);/.test(src));
  check("the list a staff member is sent is filtered by the server", () =>
    /const tmOnly = req\.mmScope === "trademark";/.test(src) && /\(tmOnly \? ` AND m\.case_type = '\$\{TM_TYPE\}'` : ""\)/.test(src));

  // ── The list of what is open, checked from four sides ──────
  // (a) Every route the router has, and what answers at each address.
  const layers = mm.router.stack.filter(l => l.route);
  const routes = [];
  for (const layer of layers) for (const method of Object.keys(layer.route.methods)) routes.push({ method: method.toUpperCase(), pattern: layer.route.path, layer });
  const answering = (method, p) => layers.filter(l => l.match(p) && (l.route.methods._all || l.route.methods[method.toLowerCase()]));
  check("no route answers every method (it would open to staff under whichever method is listed)", () => !routes.some(r => r.method === "_ALL"));

  const TM = 1, OTHER = 2;                                  // a Trademark matter and a Habeas matter (see MATTERS)
  const fill = (pattern, id) => pattern.replace(":templateName", "trademark").replace(/:itemId/, id === TM ? "10" : "20").replace(/:(id|matterId)\b/, String(id)).replace(/:\w+/g, "5");
  const open = routes.filter(r => mm.staffRule(r.method, fill(r.pattern, TM))).map(r => `${r.method} ${r.pattern}`).sort();
  const OPEN_TO_STAFF = [
    "DELETE /api/matters/:matterId/files/:id",
    "DELETE /api/matters/:matterId/notes/:id",
    "GET /",
    "GET /api/matters",
    "GET /api/matters/:id",
    "GET /api/matters/:matterId/tsdr",
    "GET /api/me",
    "GET /app",
    "GET /v2",
    "PATCH /api/checklist-items/:itemId",
    "PATCH /api/matters/:id",
    "PATCH /api/matters/:matterId/deadlines/:id",
    "POST /api/matters",
    "POST /api/matters/:id/client-summary",
    "POST /api/matters/:matterId/checklists/template/:templateName",
    "POST /api/matters/:matterId/deadlines",
    "POST /api/matters/:matterId/files",
    "POST /api/matters/:matterId/lifecycle",
    "POST /api/matters/:matterId/notes",
    "POST /api/matters/:matterId/tsdr/check",
    "POST /api/parse-uspto",
  ].sort();
  check(`of the router's ${routes.length} routes, exactly these ${OPEN_TO_STAFF.length} open to staff`, () => {
    const extra = open.filter(x => !OPEN_TO_STAFF.includes(x)), missing = OPEN_TO_STAFF.filter(x => !open.includes(x));
    if (extra.length) console.log("       open but not listed here: " + extra.join(", "));
    if (missing.length) console.log("       listed here but closed: " + missing.join(", "));
    return routes.length >= 34 && !extra.length && !missing.length;
  });
  check("each open address is answered by ONE route (a second route at the same address would inherit its permission)", () => {
    const doubled = OPEN_TO_STAFF.filter(x => { const [m, pat] = x.split(" "); return answering(m, fill(pat, TM)).length !== 1; });
    if (doubled.length) console.log("       answered by more than one route: " + doubled.join(", "));
    return !doubled.length;
  });

  // (b) The shape of every line of the list.
  check("every line that names a matter looks the matter up; every line that changes something needs the write permission", () => {
    const bad = mm.STAFF_ROUTES.filter(r => {
      const groups = new RegExp(r.re.source + "|").exec("").length - 1;      // how many ids the address carries
      if (groups > 0 && !(r.matter || r.item)) return true;                    // an id nobody looks up
      if (r.method !== "GET" && !r.write) return true;                         // a change without the write permission
      return false;
    });
    if (bad.length) console.log("       " + bad.map(r => r.method + " " + r.re.source).join(" ; "));
    return mm.STAFF_ROUTES.length === 15 && !bad.length;
  });
  check("closed to staff: the inbox, the court-order and NEF readers, email intake, deleting a matter, removing a deadline, the test lookup", () =>
    ["GET /api/proposals", "PATCH /api/proposals/1", "GET /api/proposals/count", "POST /api/parse", "POST /api/parse-intake",
     "POST /api/ingest", "POST /api/ingest-dry-run", "DELETE /api/matters/1", "DELETE /api/matters/1/deadlines/1",
     "DELETE /api/checklists/1", "POST /api/checklists/1/items", "DELETE /api/checklist-items/1", "GET /api/tsdr/test",
     "POST /api/matters/1/checklists/template/habeas"]
      .every(x => { const [m, p] = x.split(" "); return mm.staffRule(m, p) === null; }));
  check("an address dressed up to slip past is refused, not guessed at", () =>
    ["/api/matters/1/", "/API/matters/1", "/api/matters/%31", "/api/matters/1abc", "/api/matters/1/deadlines/1/x", "/api/matters//1", "/api/matters/1/../2"]
      .every(p => mm.staffRule("GET", p) === null) && mm.staffRule("HEAD", "/api/matters/1") === null
    && mm.staffRule("GET", "/api/matters/" + "9".repeat(10)) === null && mm.staffRule("PATCH", "/api/matters/1/deadlines/" + "9".repeat(30)) === null
    && mm.staffRule("DELETE", "/api/matters/1/notes/5").what === "notes" && mm.staffRule("DELETE", "/api/matters/1/files/7").subId === 7);

  // (c) The gate itself, with a stand-in database.
  const ask = (role, method, p, body) => new Promise(resolve => {
    const req = { user: role ? { r: role, u: role + "-user", uid: 7 } : undefined, method, path: p, originalUrl: "/admin/matters" + p, body: body === undefined ? {} : body, headers: {}, query: {} };
    const handlers = {};
    const res = {
      statusCode: 200,
      on(ev, fn) { handlers[ev] = fn; },
      status(code) { this.statusCode = code; return { json: b => resolve({ code, body: b, req }), send: b => resolve({ code, body: b, req }) }; },
      redirect(url) { resolve({ code: 302, url, req }); },
      json() { return this; },
    };
    mm.matterAccess(req, res, () => resolve({ code: "next", req, res, finish: () => handlers.finish && handlers.finish(), close: () => handlers.close && handlers.close() }));
  });
  const settle = () => new Promise(r => setTimeout(r, 20));
  const goodBody = x => /^POST \/api\/matters$/.test(x) ? { client_name: "X", case_type: "Trademark" } : /^PATCH \/api\/matters\/:id$/.test(x) ? { notes: "n" }
    : /\/files$/.test(x) ? { filename: "f", url: "https://x.example/f" } : { title: "t", notes: "n", completed: true };

  await checkAsync("every open address that names a matter answers “Not found” for a matter that is not a trademark", async () => {
    const named = OPEN_TO_STAFF.filter(x => /:(id|matterId|itemId)\b/.test(x.split(" ")[1].replace(/\/(deadlines|notes|files)\/:id$/, "/$1/5")));
    const wrong = [];
    for (const x of named) { const [m, pat] = x.split(" "); const r = await ask("paralegal", m, fill(pat, OTHER), goodBody(x)); if (!(r.code === 404 && r.body.error === "Not found" && r.req.mmScope === null)) wrong.push(x + " → " + r.code); }
    if (wrong.length) console.log("       " + wrong.join(" ; "));
    return named.length === 14 && !wrong.length;
  });
  await checkAsync("…and passes for one that is", async () => {
    const wrong = [];
    for (const x of OPEN_TO_STAFF) { const [m, pat] = x.split(" "); const r = await ask("paralegal", m, fill(pat, TM), goodBody(x)); if (!(r.code === "next" && r.req.mmScope === "trademark")) wrong.push(x + " → " + r.code); }
    if (wrong.length) console.log("       " + wrong.join(" ; "));
    return !wrong.length;
  });
  await checkAsync("every open address that changes something is refused to a viewer; every one that only reads is not", async () => {
    const wrong = [];
    for (const x of OPEN_TO_STAFF) {
      const [m, pat] = x.split(" "); const r = await ask("viewer", m, fill(pat, TM), goodBody(x));
      const want = m === "GET" ? "next" : 403;
      if (r.code !== want) wrong.push(x + " → " + r.code);
    }
    if (wrong.length) console.log("       " + wrong.join(" ; "));
    return !wrong.length;
  });
  await checkAsync("JJ passes, with everything", async () => {
    const r = await ask("admin", "DELETE", "/api/matters/2");
    return r.code === "next" && r.req.mmScope === "all" && r.req.mmCanWrite === true;
  });
  await checkAsync("staff open Trademark matters only, and cannot archive, reopen or re-type one", async () => {
    const ok = await ask("attorney", "POST", "/api/matters", { client_name: "X", case_type: "Trademark", custody_location: "x", user_id: 9 });
    const habeas = await ask("attorney", "POST", "/api/matters", { client_name: "X", case_type: "Habeas" });
    const none = await ask("attorney", "POST", "/api/matters", { client_name: "X" });
    const archived = await ask("attorney", "POST", "/api/matters", { client_name: "X", case_type: "Trademark", status: "archived" });
    const archive = await ask("attorney", "PATCH", "/api/matters/1", { status: "archived" });
    const retype = await ask("attorney", "PATCH", "/api/matters/1", { case_type: "Habeas" });
    const notes = await ask("attorney", "PATCH", "/api/matters/1", { notes: "called the client" });
    return ok.code === "next" && ok.req.body.court === "USPTO" && !("custody_location" in ok.req.body) && !("user_id" in ok.req.body)
      && habeas.code === 403 && none.code === 403 && archived.code === 403 && archive.code === 403 && retype.code === 403 && notes.code === "next";
  });
  await checkAsync("a matter's case number, set by staff, is a USPTO number and nothing that could catch a court email", async () => {
    const bad = [];
    for (const ref of ["cv", "a", "26-1234", "5:26-cv-01652", "A216866000", "123456789", "abc12345", "SN cv", "RN 1234", "RN 97123456", "SN 91234567", "Case No. 97123456"]) {
      const p = await ask("paralegal", "PATCH", "/api/matters/1", { matter_ref: ref }), c = await ask("paralegal", "POST", "/api/matters", { client_name: "X", case_type: "Trademark", matter_ref: ref });
      if (p.code !== 403 || c.code !== 403) bad.push(ref);
    }
    const good = await ask("paralegal", "PATCH", "/api/matters/1", { matter_ref: "97/555,123" }), reg = await ask("paralegal", "PATCH", "/api/matters/1", { matter_ref: "5320233" });
    const again = await ask("paralegal", "PATCH", "/api/matters/1", { matter_ref: "sn 97555123" }), made = await ask("paralegal", "POST", "/api/matters", { client_name: "X", case_type: "Trademark", matter_ref: "26-12345" });
    const cleared = await ask("paralegal", "PATCH", "/api/matters/1", { matter_ref: "" });
    if (bad.length) console.log("       accepted: " + bad.join(", "));
    // Stored with its prefix: a bare 2612345 would equal Ninth Circuit No. 26-12345 in the eyes of the unique index.
    return !bad.length && good.code === "next" && good.req.body.matter_ref === "SN 97555123" && reg.code === "next" && reg.req.body.matter_ref === "RN 5320233"
      && again.req.body.matter_ref === "SN 97555123" && made.code === "next" && made.req.body.matter_ref === "RN 2612345"
      && cleared.code === "next" && cleared.req.body.matter_ref === null                  // an empty one is "none", not a value that takes the unique slot
      && mm.usptoRef("RN 5320233") === "RN 5320233" && mm.usptoRef(5320233) === null && mm.usptoRef("") === null;
  });
  check("the number is filed as what the person said it is: a Board proceeding is not a serial number, and a wrong label is refused", () => {
    const u = mm.usptoRef;
    return u("91234567") === "TTAB 91234567" && u("Opposition No. 91234568") === "TTAB 91234568" && u("Canc. No. 92012345") === "TTAB 92012345"
      && u("Reg. No. 5,320,233") === "RN 5320233" && u("serial no. 97/123,456") === "SN 97123456" && u("RN 123456") === "RN 123456"
      && u("RN 97123456") === null && u("SN 91234567") === null && u("ttab 97123456") === null && u("123456") === null && u("SN 97123456 x") === null;
  });
  await checkAsync("one trademark matter to a USPTO number however it was written; references that merely share digits are different", async () => {
    const taken = async (have, want) => { REFS = [have]; const t = await mm.trademarkRefTaken(1, want, 0); REFS = []; return t; };
    return (await taken("97/123,456", "SN 97123456")) && (await taken("91234567", "Opp. No. 91234567")) && (await taken("RN 5320233", "5,320,233"))
      && !(await taken("Docket 12345-A", "Docket 12345-B")) && !(await taken("IR 1234567", "RN 1234567")) && !(await taken("Docket 97123456-A", "SN 97123456"))
      && !(await mm.trademarkRefTaken(1, "SN 97123456", 0));
  });
  check("a very long case number is refused at once, not studied", () => {
    const t = Date.now(), long = mm.usptoRef("SN" + " ".repeat(60000) + "x"), edge = mm.usptoRef("SN " + "9".repeat(98));
    return long === null && edge === null && Date.now() - t < 200 && mm.staffBodyProblem({ edits: true }, { matter_ref: " ".repeat(101) }) !== null;
  });
  check("…and the same form is used whoever enters it, with one trademark matter to a number", () =>
    (src.match(/refVal = usptoRef\(refVal\) \|\| refVal;/g) || []).length === 2 && (src.match(/await trademarkRefTaken\(userId, refVal, /g) || []).length === 2
    && /refVal = req\.body\.matter_ref\.trim\(\) \? req\.body\.matter_ref : null;/.test(src)
    && /\? \(digits\.length === 8 \? "SN " : "RN "\) \+ digits/.test(read("federal-matters.js"))
    && /require\("\.\/matter-manager"\)\.trademarkRefTaken\(userId, matterRef, 0\)\) throw new Error\(already\)/.test(read("federal-matters.js")));
  await checkAsync("what staff send is plain values only, so what is checked is what is stored", async () => {
    const refused = [];
    for (const body of [{ notes: { a: 1 } }, { notes: ["x"] }, { mark: 5 }, { client_name: "" }, { client_name: "   " }, { serial_number: true }]) {
      const r = await ask("paralegal", "PATCH", "/api/matters/1", body);
      if (r.code !== 403) refused.push(JSON.stringify(body) + " → " + r.code);
    }
    const many = {}; for (let i = 0; i < 41; i++) many["k" + i] = "v";
    const tooMany = await ask("paralegal", "POST", "/api/matters/1/notes", many), nested = await ask("paralegal", "POST", "/api/matters/1/deadlines", { title: { $ne: 1 }, due_date: "2027-01-02" });
    const noName = await ask("paralegal", "POST", "/api/matters", { client_name: "", case_type: "Trademark" }), fine = await ask("paralegal", "PATCH", "/api/matters/1/deadlines/5", { completed: true, note: null });
    if (refused.length) console.log("       accepted: " + refused.join(" ; "));
    return !refused.length && tooMany.code === 403 && nested.code === 403 && noName.code === 403 && fine.code === "next";
  });
  await checkAsync("a code field takes a code: no markup, a real filing basis, nothing longer than its column", async () => {
    const no = [];
    for (const body of [{ filing_basis: "<base href=//x.co>" }, { filing_basis: "<b>1(a)</b>" }, { filing_basis: "use" }, { intl_class: "<i>41" }, { serial_number: '97"123' }, { mark_format: "a\\b" },
                        { owner_email: "<x@y.co>" }, { mark: "M".repeat(301) }, { client_name: "C".repeat(201) }, { filing_basis: "1(a) and then some more words" }, { owner_name: "O".repeat(201) }]) {
      const r = await ask("paralegal", "PATCH", "/api/matters/1", body), c = await ask("paralegal", "POST", "/api/matters", { client_name: "X", case_type: "Trademark", ...body });
      if (r.code !== 403 || c.code !== 403) no.push(JSON.stringify(body).slice(0, 50));
    }
    const yes = [];
    for (const body of [{ filing_basis: "1(a)" }, { filing_basis: "44(e)" }, { filing_basis: "66(a)" }, { filing_basis: "" }, { filing_basis: null }, { intl_class: "009, 041" }, { owner_email: "o'brien@example.com" },
                        { mark: "I <3 NY" }, { mark_format: "Standard characters" }, { serial_number: "97/123,456" }]) {
      const r = await ask("paralegal", "PATCH", "/api/matters/1", body);
      if (r.code !== "next") yes.push(JSON.stringify(body));
    }
    if (no.length) console.log("       accepted: " + no.join(" ; "));
    if (yes.length) console.log("       refused: " + yes.join(" ; "));
    return !no.length && !yes.length;
  });
  check("…and the page escapes every trademark field it draws", () => {
    const page = read("matters.html");
    const grid = page.slice(page.indexOf("const filingBasisLabel"), page.indexOf("const filingBasisLabel") + 1600);
    return /<dd>\$\{escapeHtml\(filingBasisLabel\)\}<\/dd>/.test(grid) && !/<dd>\$\{(?:filingBasisLabel|m\.(?:serial_number|intl_class|mark_format|owner_email|relief|filing_basis|mark))\}/.test(grid);
  });
  await checkAsync("staff cannot set a field that is not theirs, or store a link that is not a web address", async () => {
    const a = await ask("paralegal", "PATCH", "/api/matters/1", { court: "9th Cir." }), b = await ask("paralegal", "PATCH", "/api/matters/1", { custody_location: "x", notes: "n" });
    const c = await ask("paralegal", "PATCH", "/api/matters/1", { dropbox_url: "javascript:alert(1)" }), d = await ask("paralegal", "POST", "/api/matters/1/files", { filename: "f", url: "javascript:alert(1)" });
    const e = await ask("paralegal", "PATCH", "/api/matters/1", ["status"]), f = await ask("paralegal", "PATCH", "/api/matters/1", { dropbox_url: "https://www.dropbox.com/x" });
    return [a, b, c, d].every(r => r.code === 403) && e.code === 400 && f.code === "next";
  });
  await checkAsync("a court email is never matched to a trademark, patent or copyright matter", async () =>
    mm.NOT_COURT_MATTERS.has("Trademark") && mm.NOT_COURT_MATTERS.has("Patent") && mm.NOT_COURT_MATTERS.has("Copyright") && !mm.NOT_COURT_MATTERS.has("Habeas")
    && mm.normalizeCaseRef("97261234").includes(mm.normalizeCaseRef(mm.extractCaseNumbers("Case No. 26-1234 order")[0]))   // why it matters
    && (src.match(/if \(NOT_COURT_MATTERS\.has\(m\.case_type\)\) continue;/g) || []).length === 3
    && (src.match(/normalizeCaseRef\(m\.matter_ref \|\| ""\)/g) || []).length === 3);     // one skip for each place a matter is matched by number
  await checkAsync("removing a deadline, deleting a matter and the inbox stay with JJ", async () => {
    const a = await ask("manager", "DELETE", "/api/matters/1/deadlines/5"), b = await ask("manager", "DELETE", "/api/matters/1"), c = await ask("manager", "GET", "/api/proposals");
    return [a, b, c].every(r => r.code === 403 && r.req.mmScope === null);
  });
  await checkAsync("someone without the Federal & TM permission, or not signed in, gets nothing", async () => {
    const a = await ask("consultant", "GET", "/api/matters"), b = await ask(null, "GET", "/api/matters"), c = await ask(null, "GET", "/");
    return a.code === 403 && b.code === 401 && c.code === 302 && /\/admin\/login/.test(c.url);
  });
  await checkAsync("a change a staff member makes is in the audit log with their name and what was there before; a look is not", async () => {
    audit.length = 0;
    await ask("paralegal", "GET", "/api/matters/1");
    const r = await ask("paralegal", "PATCH", "/api/matters/1/deadlines/5", { due_date: "2099-12-31", zz: "A".repeat(3000) });
    r.finish(); r.close(); await settle();
    const row = audit[0] || {};
    return audit.length === 1 && row.username === "paralegal-user" && row.action === "matter_manager.staff_change" && row.target_id === "1"
      && row.changes.set.due_date === "2099-12-31" && row.changes.before.due_date === "2027-01-02" && row.changes.set.zz.length < 320;
  });
  await checkAsync("…and it is written even when the connection drops before the reply", async () => {
    audit.length = 0;
    const r = await ask("paralegal", "POST", "/api/matters/1/deadlines", { title: "Respond", due_date: "2027-01-02" });
    r.close(); await settle();
    return audit.length === 1 && /connection closed/.test(audit[0].changes.note || "");
  });
  await checkAsync("…a change the server then turned down says so, and a new matter is logged under the number it was given", async () => {
    audit.length = 0;
    const a = await ask("paralegal", "PATCH", "/api/matters/1", { notes: "n" });
    a.res.statusCode = 409; a.finish(); await settle();
    const b = await ask("paralegal", "POST", "/api/matters", { client_name: "Acme", case_type: "Trademark", mark: "ZIPLINE" });
    b.res.json({ matter: { id: 77, client_name: "Acme", mark: "ZIPLINE" } }); b.finish(); await settle();
    return audit.length === 2 && audit[0].changes.refused_with === 409 && audit[0].changes.before.notes === "old notes"
      && audit[1].target_id === "77" && !("refused_with" in audit[1].changes);
  });
  await checkAsync("…a note or file a staff member removes is kept in the log", async () => {
    audit.length = 0;
    const n = await ask("paralegal", "DELETE", "/api/matters/1/notes/5"); n.finish();
    const f = await ask("paralegal", "DELETE", "/api/matters/1/files/5"); f.finish(); await settle();
    return audit.length === 2 && audit[0].changes.before.content === "Client approved the specimen." && audit[1].changes.before.filename === "specimen.pdf";
  });
  await checkAsync("…a change that is refused is logged as an attempt; a refused look is not", async () => {
    audit.length = 0;
    await ask("paralegal", "GET", "/api/proposals");
    await ask("paralegal", "DELETE", "/api/matters/1");
    await ask("paralegal", "PATCH", "/api/matters/1", { status: "archived" });
    await ask("viewer", "POST", "/api/matters/1/notes", { content: "x" });
    await settle();
    return audit.length === 3 && audit.every(r => r.action === "matter_manager.staff_refused" && r.changes.refused_with === 403)
      && audit[1].target_id === "1" && audit[1].changes.sent.status === "archived" && audit[2].username === "viewer-user";
  });
  await checkAsync("…a try at changing a matter that is not a trademark is on record too", async () => {
    audit.length = 0;
    const a = await ask("paralegal", "PATCH", "/api/matters/2", { notes: "x" }), b = await ask("paralegal", "PATCH", "/api/checklist-items/20", { completed: true });
    await ask("paralegal", "GET", "/api/matters/2"); await settle();
    return a.code === 404 && b.code === 404 && audit.length === 2 && audit.every(r => r.action === "matter_manager.staff_refused" && r.changes.refused_with === 404)
      && audit[0].target_id === "2" && audit[0].username === "paralegal-user";
  });
  await checkAsync("…no row in the log can be made enormous, and padding a request cannot push the real change out of it", async () => {
    audit.length = 0;
    const big = {}; for (let i = 0; i < 39; i++) big["junk_" + i] = "A".repeat(5000);
    big.due_date = "2032-02-02";                                              // the one real change, sent last
    const r = await ask("paralegal", "PATCH", "/api/matters/1/deadlines/5", big); r.finish(); await settle();
    const c = (audit[0] || {}).changes || {};
    const small = {}; for (let i = 0; i < 39; i++) small["j" + i] = "x";
    small.due_date = "2033-03-03";
    const s = await ask("paralegal", "PATCH", "/api/matters/1/deadlines/5", small); s.finish(); await settle();
    return audit.length === 2 && JSON.stringify(c).length < 12500 && c.set.due_date === "2032-02-02" && c.before.due_date === "2027-01-02"
      && Object.keys(c.set).length === 40 && /shortened/.test(c.note) && c.set.junk_0.length < 90
      && audit[1].changes.set.due_date === "2033-03-03" && audit[1].changes.before.due_date === "2027-01-02" && !audit[1].changes.note;
  });
  check("moving the Federal page's trademark rows across is JJ's to do", () =>
    /app\.post\("\/admin\/federal\/move-trademarks", auth\.requireRole\("admin"\)/.test(server));
  check("a long deadline summary is sent in parts, not refused whole by Telegram", () => {
    const lines = []; for (let i = 0; i < 400; i++) lines.push(`${i}. Matter ${i} — response due 2027-01-${String(1 + i % 28).padStart(2, "0")}`);
    const parts = tsdr.splitMessage(lines.join("\n"), 3850);
    const long = tsdr.splitMessage("x".repeat(9000) + "\nshort", 3850);
    return parts.length > 3 && parts.every(p => p.length <= 3850) && parts.join("\n") === lines.join("\n")       // nothing lost, nothing cut mid-line
      && long.length === 2 && long[0].length === 3850 && long[1] === "short"
      && tsdr.splitMessage("", 3850).length === 0 && tsdr.splitMessage("one line").length === 1
      && /require\("\.\/tsdr-sync"\)\.splitMessage\(msg, 3850\)/.test(server) && /parts\.length > 1 \? `\(\$\{i \+ 1\}\/\$\{parts\.length\}\)/.test(server)
      && /Today's deadline summary is incomplete/.test(server);
  });
  check("the Telegram /deadline pick list offers court matters first and says what each one is", () =>
    /ORDER BY \(case_type IN \('Trademark', 'Patent', 'Copyright'\)\) ASC/.test(server));
  const html = read("matters.html");
  check("the page draws only what will work for them", () =>
    /api\('\/me'\)/.test(html) && /html\.scope-tm \.nav-btn\[data-view="inbox"\]/.test(html) && /html\.scope-tm \.deadline \.remove/.test(html)
    && /html\.read-only #add-deadline/.test(html) && /if \(o\.value !== 'Trademark'\) o\.remove\(\)/.test(html));

  console.log(failed ? `\n${failed} FAILED\n` : "\nALL TRADEMARK CHECKS PASSED\n");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
