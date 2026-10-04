/**
 * check-consultant-clients.js
 *
 * JJ: keep the consultant portal — "it is important for them to enter
 * client info and search client info and see on their phone and computer."
 * Pins the web pages (list + search, add, one client) and their wiring.
 * The SQL was checked against Postgres when written (search stays inside
 * the consultant's own clients; only clients they entered are editable).
 *
 * JJ, signed in as consultant luna.huang (2026-10-04):
 *   1. "keep the design theme similar to tez"
 *   2. "broker's client is not showing in the brokers portal. it shows
 *      (column t.completed does not exist)"
 *   3. "work orders can be submitted. however, will need attorney or
 *      manager's approval."
 * (4, alerts, is pinned in check-notify.js.) The second was a column that
 * has never existed, in a query no check ran against a database — so the
 * guard here is on the SQL text: nothing may ask tasks for `completed`.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const REPO = path.join(__dirname, "..");
let failures = 0;
function check(name, ok, detail) { if (!ok) failures++; console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail)); }
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const bundle = fs.readFileSync(path.join(REPO, "public", "consultant-clients.js"), "utf8");
  function page(mode, key, responder, url) {
    const dom = new JSDOM(`<div class="page-header"><h1>x</h1></div><div data-consultant-clients="${mode}"${key ? ` data-key="${key}"` : ""}></div>`,
      { runScripts: "outside-only", url: url || "http://x/consultant/clients" });
    const calls = [];
    dom.window.fetch = async (u, init) => {
      const body = init && init.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: u, method: (init && init.method) || "GET", body });
      const r = responder(u, (init && init.method) || "GET", body);
      return { ok: r.ok !== false, status: r.status || 200, json: async () => r };
    };
    dom.window.eval(bundle);
    return { dom, calls, doc: dom.window.document };
  }

  console.log("\n— My Clients (search) —");
  const clients = [
    { client_key: "a-111", client_name: "Wang, Li", client_phone: "626-555-1234", a_number: "A111", entered_by_me: false, role_description: "Case helper", open_task_count: 2, matter_type: "immigration" },
    { client_key: "contact-garcia", client_name: "Garcia, Ana", entered_by_me: true, open_task_count: 0 },
  ];
  let p = page("list", null, u => ({ ok: true, clients: /q=garc/.test(u) ? [clients[1]] : clients }));
  await wait(30);
  check("lists the consultant's clients, linked to their page", !!p.doc.querySelector('a[href="/consultant/client/a-111"]') && !!p.doc.querySelector('a[href="/consultant/client/contact-garcia"]'));
  check("shows who entered each one", /Entered by you/.test(p.doc.body.textContent) && /Case helper/.test(p.doc.body.textContent));
  const q = p.doc.querySelector('input[type="search"]');
  q.value = "garc"; q.dispatchEvent(new p.dom.window.Event("input"));
  await wait(320);
  check("search asks the server with ?q=", p.calls.some(c => /\/api\/consultant\/clients\?q=garc$/.test(c.url)));
  check("…and shows only the matches", !p.doc.querySelector('a[href="/consultant/client/a-111"]') && !!p.doc.querySelector('a[href="/consultant/client/contact-garcia"]'));

  console.log("\n— Add a client —");
  p = page("new", null, (u, m) => m === "POST" ? { ok: true, client: { client_key: "contact-new-1" } } : { ok: true });
  const f = p.doc.querySelector("form");
  f.querySelector('[name="client_name"]').value = "Chen, Mei";
  f.querySelector('[name="client_phone"]').value = "909-555-0000";
  f.querySelector('[name="a_number"]').value = "A123";
  f.querySelector('[name="matter_interest"]').value = "Immigration — asylum";
  let navigated = null;
  try { Object.defineProperty(p.dom.window, "location", { value: { set href(v) { navigated = v; }, search: "" } }); } catch (e) { /* jsdom */ }
  f.dispatchEvent(new p.dom.window.Event("submit", { cancelable: true }));
  await wait(30);
  const post = p.calls.find(c => c.method === "POST");
  check("saving posts the details to /api/consultant/clients", post && /\/api\/consultant\/clients$/.test(post.url) && post.body.client_name === "Chen, Mei" && post.body.a_number === "A123" && post.body.matter_interest === "Immigration — asylum");
  check("…and blank fields are not sent", post && !("client_email" in post.body));
  const p2 = page("new", null, () => ({ ok: true }));
  p2.doc.querySelector("form").dispatchEvent(new p2.dom.window.Event("submit", { cancelable: true }));
  await wait(20);
  check("a client name is required", !p2.calls.some(c => c.method === "POST") && /name is required/i.test(p2.doc.body.textContent));

  console.log("\n— One client —");
  const detail = (editable) => (u, m, b) => {
    if (/\/tasks$/.test(u)) return { ok: true, tasks: [
      { description: "File I-589", status: "pending", completed: false, matter_type: "immigration" },
      { description: "Old matter", status: "completed", completed: true, matter_type: "immigration" },
      { description: "Sent by me", status: "pending_approval", completed: false, matter_type: "immigration", mine: true },
      { description: "Contact: x", matter_type: "Contact", completed: false }] };
    if (/\/updates$/.test(u)) return { ok: true,
      court_dates: [{ day: "Thursday, November 12, 2026", time: "8:30 AM", type: "Master Calendar", court: "Los Angeles Immigration Court" }],
      alerts: [{ id: 1, kind: "court_mail", label: "New court notice", at: new Date().toISOString(), task_id: null }] };
    if (/\/messages$/.test(u) && m === "POST") return { ok: true };
    if (/\/messages$/.test(u)) return { ok: true, messages: [{ body: "Hello", sender_kind: "client", created_at: new Date().toISOString() }] };
    if (m === "PATCH") return { ok: true };
    return { ok: true, client: { client_key: "k1", client_name: "Garcia, Ana", client_phone: "909", a_number: "A9", matter_type: "Contact", editable }, assignment: { role_description: "Referred by this consultant" } };
  };
  p = page("view", "k1", detail(true), "http://x/consultant/client/k1?saved=1");
  await wait(40);
  const t = p.doc.body.textContent;
  check("shows the client's details", /Garcia, Ana/.test(t) && /A9/.test(t) && /contact only/.test(t));
  check("says the save worked (after Add)", /Client saved/.test(t));
  check("lists open work, not the contact placeholder or finished work", /File I-589/.test(t) && !/Contact: x/.test(t) && !/Old matter/.test(t) && /Open work \(2\)/.test(t));
  check("says which task of theirs is still waiting for approval", /Sent by me/.test(t) && /Awaiting approval · sent by you/.test(t));
  check("shows the court date an alert pointed them to: day, time, kind, court",
    /Thursday, November 12, 2026 at 8:30 AM/.test(t) && /Master Calendar · Los Angeles Immigration Court/.test(t) && /Confirm with the firm/.test(t));
  check("and what they have been alerted to", /Recent updates/.test(t) && /New court notice/.test(t));
  check("shows messages", /Hello/.test(t));
  check("offers a new task for this client, name filled in", !!p.doc.querySelector('a[href="/consultant/new?client=Garcia%2C%20Ana"]') && /New task for this client/.test(t));
  const editBtn = [...p.doc.querySelectorAll("button")].find(b => /Edit details/.test(b.textContent));
  check("a client they entered can be edited", !!editBtn);
  editBtn.click();
  const ef = p.doc.querySelector("form");
  ef.querySelector('[name="client_email"]').value = "ana@example.com";
  ef.dispatchEvent(new p.dom.window.Event("submit", { cancelable: true }));
  await wait(30);
  const patch = p.calls.find(c => c.method === "PATCH");
  check("…saving sends a PATCH with the new email", patch && /\/api\/consultant\/clients\/k1$/.test(patch.url) && patch.body.client_email === "ana@example.com");
  const ta = p.doc.querySelector("textarea");
  ta.value = "We need your passport copy";
  [...p.doc.querySelectorAll("button")].find(b => b.textContent === "Send").click();
  await wait(30);
  check("sending a message posts it", p.calls.some(c => c.method === "POST" && /\/messages$/.test(c.url) && c.body.body === "We need your passport copy"));
  p = page("view", "k1", detail(false));
  await wait(40);
  check("a firm-assigned client is read-only (with the reason)", ![...p.doc.querySelectorAll("button")].some(b => /Edit details/.test(b.textContent)) && /belongs to the firm/.test(p.doc.body.textContent));

  console.log("\n— Wiring —");
  const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
  const portal = fs.readFileSync(path.join(REPO, "consultant-portal.js"), "utf8");
  const appApi = fs.readFileSync(path.join(REPO, "app-api.js"), "utf8");
  check("the three pages are consultant-only", ['"/consultant/clients", requireConsultant', '"/consultant/clients/new", requireConsultant', '"/consultant/client/:key", requireConsultant'].every(s => server.includes(s)));
  {
    // Asked of the page a consultant is actually sent, in both languages.
    // (This used to look for `label: "My clients"` in the source; the labels
    // moved into the English/Chinese table and the literal went with them.)
    const P = require("../consultant-portal");
    const tab = (html, href) => (html.match(new RegExp('<a href="' + href.replace(/\//g, "\\/") + '"[^>]*>([\\s\\S]*?)<\\/a>')) || [])[1] || "";
    const en = P.renderChrome({ title: "t", user: { uid: 5, n: "Luna", r: "consultant" }, body: "" });
    const zh = P.renderChrome({ title: "t", user: { uid: 5, n: "Luna", r: "consultant", lang: "zh" }, body: "" });
    check("the portal has My Clients and Add Client tabs",
      /My clients/.test(tab(en, "/consultant/clients")) && /Add client/.test(tab(en, "/consultant/clients/new")) &&
      /我的客户/.test(tab(zh, "/consultant/clients")) && /添加客户/.test(tab(zh, "/consultant/clients/new")),
      [tab(en, "/consultant/clients"), tab(zh, "/consultant/clients/new")]);
  }
  check("add, search and edit routes exist and are consultant-only", /app\.post\("\/api\/consultant\/clients", requireBearer, requireConsultantRole/.test(appApi) && /app\.patch\("\/api\/consultant\/clients\/:key", requireBearer, requireConsultantRole/.test(appApi));
  const listRoute = (appApi.match(/app\.get\("\/api\/consultant\/clients", requireBearer[\s\S]*?\n  \}\);/) || [""])[0];
  check("search stays inside the consultant's own clients",
    /WHERE cc\.consultant_id = \$1 AND cc\.removed_at IS NULL/.test(listRoute) && /clients = clients\.filter\(/.test(listRoute) &&
    (listRoute.match(/FROM tasks|FROM client_consultants|FROM client_dropbox_mapping|FROM client_contacts/g) || []).length === 3 &&
    /client_key = ANY\(\$1::text\[\]\)/.test(listRoute));
  check("a client filed in the broker's folder with no task yet still has a name", /FROM client_dropbox_mapping WHERE client_key = ANY/.test(listRoute));
  check("edits only on clients they entered", /matter_type = 'Contact' AND submitted_by_user_id = \$2/.test(appApi));
  check("the web sign-in cookie works for /api/consultant/*", /cookies\[auth\.COOKIE_NAME\]/.test(appApi.slice(0, 3000)));
  const pages = require("../consultant-portal");
  const html = pages.renderClientsPage({ mode: "view", clientKey: '"><script>x</script>' });
  check("a client key cannot break out of the page", !/<script>x/.test(html));

  // ── 2. The column that does not exist ───────────────────
  console.log("\n— tasks has no `completed` column —");
  const zara = fs.readFileSync(path.join(REPO, "zara-app-chat.js"), "utf8");
  const tasksJs = fs.readFileSync(path.join(REPO, "tasks.js"), "utf8");
  check("the tasks table really has no such column (if this fails, the guard below is out of date)",
    !/ADD COLUMN IF NOT EXISTS completed\b/.test(tasksJs) && !/^\s*completed\s+BOOLEAN/m.test((tasksJs.match(/CREATE TABLE IF NOT EXISTS tasks \([\s\S]*?\n {4}\)/) || [""])[0]));
  // Any statement that reads tasks and names a bare `completed` column.
  // `completed_at`, `completed_by`, `status = 'completed'` and
  // `(status = 'completed') AS completed` are all fine.
  const bad = [];
  for (const [file, src] of [["app-api.js", appApi], ["zara-app-chat.js", zara]]) {
    for (const m of src.matchAll(/`([^`]*\bFROM tasks\b[^`]*)`/g)) {
      const sql = m[1].replace(/\(status = 'completed'\) AS completed/g, "").replace(/status (=|<>|!=) 'completed'/g, "").replace(/'completed'/g, "");
      if (/\bcompleted\b(?!_)/.test(sql)) bad.push(file + ": " + m[1].replace(/\s+/g, " ").slice(0, 90));
    }
    if (/\(t?\.?completed = false OR t?\.?completed IS NULL\)|AND completed = true/.test(src)) bad.push(file + ": a `completed = …` filter");
  }
  check("no query asks tasks for it", bad.length === 0, bad.join(" | "));
  check("the client list counts open work by status", /COUNT\(DISTINCT t\.id\) FILTER \(WHERE t\.status NOT IN \('completed', 'cancelled', 'rejected'\)/.test(listRoute));
  check("the phone app still gets a `completed` field, computed", /\(status = 'completed'\) AS completed/.test(appApi));
  const taskRoute = (appApi.match(/app\.get\("\/api\/consultant\/clients\/:key\/tasks"[\s\S]*?\n  \}\);/) || [""])[0];
  check("a consultant reads the wording only of tasks they sent; the firm's own tasks show a title",
    /CASE WHEN submitted_by_user_id = \$2 THEN COALESCE\(description, title\) ELSE title END AS description/.test(taskRoute));
  const upd = (appApi.match(/app\.get\("\/api\/consultant\/clients\/:key\/updates"[\s\S]*?\n  \}\);/) || [""])[0];
  check("court dates are only for a client they are assigned to", /if \(!keys\.has\(key\)\) return res\.status\(403\)/.test(upd));
  check("and carry the date, time, kind and court — not the notice, documents or notes",
    /SELECT hearing_date, hearing_time_text, hearing_type, court_name FROM client_hearing_notices/.test(upd) && !/SELECT \*/.test(upd) && !/dropbox_path|summary|extracted|raw_text/.test(upd));

  // ── 1. The look ──────────────────────────────────────────
  console.log("\n— In the TEZ brand —");
  const theme = require("../tez-theme");
  const sample = {
    task: { id: 9, title: "New matter", status: "pending_approval", matter_type: "immigration", priority: "high", client_name: "Chen, Mei", created_at: new Date(), description: "x" },
    user: { uid: 5, n: "Luna Huang", r: "consultant", alerts: 2 },
  };
  const rendered = [
    pages.renderChrome({ title: "t", activeTab: "dashboard", user: sample.user, body:
      pages.renderDashboard({ user: sample.user, tasks: [sample.task], stats: { pending_approval: 1 } }) }),
    pages.renderChrome({ title: "t", activeTab: "new", user: sample.user, body: pages.renderNewForm() }),
    pages.renderChrome({ title: "t", user: sample.user, body: pages.renderTaskDetail({ task: sample.task, activity: [{ action: "created", created_at: new Date(), actor_name: "Luna Huang" }], user: sample.user }) }),
    pages.renderChrome({ title: "t", activeTab: "alerts", user: sample.user, body: pages.renderAlertsPage({ user: sample.user, me: { email: "l@x.com" }, health: { email: true, sms: true, telegram: true }, feed: [{ kind: "court_mail", label: "New court notice", who: "Wang, Li", client_key: "a-1", created_at: new Date() }] }) }),
  ];
  check("brand colours: charcoal, marble, seal orange, ember", [theme.C.charcoal, theme.C.marble, theme.C.orange, theme.C.ember].join() === "#2B2523,#FAF8F5,#FF7B00,#A34C00");
  check("every page carries the shield and the brand type", rendered.every(h => /class="tez-shield"/.test(h) && /Cormorant\+Garamond/.test(h) && /Montserrat/.test(h)));
  check("the shield is the kit's own drawing, not a retyped wordmark", /<svg class="tez-shield"[^>]*viewBox="134\.0 25\.0 262\.3 289\.0"/.test(theme.SHIELD) && /fill="#FF7B00"/.test(theme.SHIELD));
  check("none of the old navy and gold is left", rendered.every(h => !/#0C1C36|#B79C62/i.test(h)) && !/#0C1C36|#B79C62/i.test(bundle));
  check("no emoji anywhere on the pages or in the client script", rendered.every(h => !/[\u{1F300}-\u{1FAFF}\u2705\u23F3\u270E\uFF0B]/u.test(h)) && !/[\u{1F300}-\u{1FAFF}\u2705\u23F3\u270E\uFF0B]/u.test(bundle));
  check("seal orange is never used for text on the light page", !/(?<![-\w])color:\s*var\(--orange\)/.test(theme.CSS.replace(/\.tez-[^{]*\{[^}]*\}/g, "")));
  check("the Alerts tab shows how many are unread", /Alerts<span class="n">2<\/span>/.test(rendered[0]));
  check("the page scripts hold nothing a template literal would swallow",
    [pages.renderNewForm(), pages.renderTaskDetail({ task: sample.task, activity: [], user: sample.user })]
      .every(h => (h.match(/<script>[\s\S]*?<\/script>/g) || []).every(sc => { try { new Function(sc.replace(/<\/?script>/g, "")); return true; } catch (e) { return false; } })));

  // ── 3. A work order needs a yes ──────────────────────────
  // On screen it is a "task" — JJ: "word work order seems weird. tez is a law
  // firm after all, maybe revise to task or case?" The old words must not
  // come back on anything a person reads.
  console.log("\n— A consultant's task needs an attorney or manager —");
  const fromNotify = Object.values(require("../notify").USER_KINDS).map(k => k.label).join(" | ");
  const noSvg = (h) => h.replace(/<svg[\s\S]*?<\/svg>/g, "");
  check("nothing a person reads says 'work order'",
    rendered.every(h => !/work.?orders?/i.test(noSvg(h))) && !/work orders?/i.test(bundle.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")) && !/work order/i.test(fromNotify),
    (noSvg(rendered.join(" ")).match(/.{30}work.?orders?.{20}/i) || [fromNotify])[0]);
  {
    const tab = (html, href) => (html.match(new RegExp('<a href="' + href.replace(/\//g, "\\/") + '"[^>]*>([\\s\\S]*?)<\\/a>')) || [])[1] || "";
    check("the tabs read Tasks and New task", /^\s*Tasks/.test(tab(rendered[0], "/consultant")) && /New task/.test(tab(rendered[0], "/consultant/new")),
      [tab(rendered[0], "/consultant"), tab(rendered[0], "/consultant/new")]);
  }
  check("the dashboard says a task is awaiting approval", /Awaiting approval/.test(rendered[0]) && /An attorney or manager approves a task before the firm starts on it/.test(rendered[0]));
  check("the form says so before they send it, and sends to the route that enforces it",
    /Send for approval/.test(rendered[1]) && /fetch\("\/api\/consultant\/tasks"/.test(rendered[1]));
  check("a waiting order says nothing has started", /Waiting for approval\./.test(rendered[2]) && /before any work starts/.test(rendered[2]));
  const rej = pages.renderTaskDetail({ task: { ...sample.task, status: "rejected" }, user: sample.user,
    activity: [{ action: "rejected", note: "Already represented <b>elsewhere</b>", actor_name: "Jue Wang", created_at: new Date() }] });
  check("one that was turned down shows the reason, escaped", /did not accept/.test(rej) && /Already represented &lt;b&gt;elsewhere/.test(rej) && !/<b>elsewhere/.test(rej));
  check("and no longer offers a note box", !/comment-text/.test(rej));

  const apiSubmit = (appApi.match(/app\.post\("\/api\/consultant\/tasks"[\s\S]*?\n  \}\);/) || [""])[0];
  const webSubmit = (server.match(/app\.post\("\/consultant\/tasks", requireConsultant[\s\S]*?\n\}\);/) || [""])[0];
  check("both ways of submitting file it as pending approval", /status: "pending_approval"/.test(apiSubmit) && /status: "pending_approval"/.test(webSubmit) && !/status: "pending",/.test(webSubmit));
  check("the website route no longer files it under a client by name alone", !/cleaned\.client_key =/.test(webSubmit));
  check("both tell the people who can approve", /require\("\.\/work-orders"\)\.announce\(/.test(apiSubmit) && /require\("\.\/work-orders"\)\.announce\(/.test(webSubmit));
  check("the phone's approve and reject routes are for an attorney or manager, not admin only",
    ["tasks/pending\"", "tasks/:id/approve\"", "tasks/:id/reject\"", "tasks/pending-count\""].every(r => appApi.includes(r + ", requireBearer, requireFirmUser, requireApprover,")));
  check("nothing still calls the function that never existed", !/recordActivity/.test(appApi));
  check("the firm has a page for it, behind the role", /require\("\.\/work-orders"\)\.mount\(app, auth\)/.test(server));
  check("orders nobody approved stay out of the firm's list, counts and reminders",
    /const NOT_LIVE = "\('completed', 'cancelled', 'rejected', 'pending_approval'\)"/.test(tasksJs) &&
    (tasksJs.match(/status NOT IN \$\{NOT_LIVE\}/g) || []).length >= 9 && /if \(task\.status === "pending_approval"\) return;/.test(tasksJs));

  // The deciding itself, against a database that behaves like one.
  const W = { tasks: [{ id: 1, status: "pending_approval", title: "T", submitted_by_user_id: 5, assigned_to: null, priority: "normal" }], activity: [] };
  const fakeDb = { query: async (sql, v = []) => {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^UPDATE tasks SET .* WHERE id = \$1 AND status = 'pending_approval' RETURNING \*/.test(q)) {
      const t = W.tasks.find(x => x.id === v[0] && x.status === "pending_approval");
      if (!t) return { rows: [] };
      t.status = /status = 'open'/.test(q) ? "open" : "rejected";
      const m = q.match(/assigned_to = \$(\d)/); if (m) t.assigned_to = v[Number(m[1]) - 1];
      return { rows: [{ ...t }] };
    }
    if (/^SELECT status FROM tasks WHERE id = \$1/.test(q)) return { rows: W.tasks.filter(x => x.id === v[0]).map(x => ({ status: x.status })) };
    if (/^INSERT INTO task_activity/.test(q)) { W.activity.push({ task_id: v[0], actor_name: v[2], action: v[4], note: v[7], visible: v[8] }); return { rows: [{ id: W.activity.length }] }; }
    return { rows: [] };
  } };
  for (const f of ["db.js"]) require.cache[require.resolve(path.join(REPO, f))] = { id: f, filename: f, loaded: true, exports: fakeDb };
  const wo = require("../work-orders");
  const silence = console.warn; console.warn = () => {};
  const asRole = (r, n) => ({ uid: 9, n: n || r, r });
  let out = await wo.approve(1, asRole("paralegal"), {});
  check("a paralegal cannot approve", out.ok === false && out.status === 403 && W.tasks[0].status === "pending_approval");
  out = await wo.approve(1, asRole("consultant"), {});
  check("nor can a consultant", out.ok === false && out.status === 403);
  out = await wo.reject(1, asRole("manager"), "   ");
  check("turning one down needs a reason", out.ok === false && out.status === 400 && W.tasks[0].status === "pending_approval");
  out = await wo.approve(1, asRole("attorney", "Chandler Jin"), { assigned_to: "Jue Wang", note: "ok" });
  check("an attorney can, and can say who it goes to", out.ok === true && W.tasks[0].status === "open" && W.tasks[0].assigned_to === "Jue Wang");
  check("the consultant's timeline gets the decision, who made it, and the note",
    W.activity.length === 1 && W.activity[0].action === "approved" && W.activity[0].actor_name === "Chandler Jin" && W.activity[0].note === "ok" && W.activity[0].visible === true);
  out = await wo.approve(1, asRole("manager"), {});
  check("it cannot be decided twice", out.ok === false && out.status === 409 && W.activity.length === 1);
  out = await wo.reject(1, asRole("manager"), "too late");
  check("nor turned down once approved", out.ok === false && out.status === 409 && W.tasks[0].status === "open");
  W.tasks.push({ id: 2, status: "pending_approval", title: "U", submitted_by_user_id: 5 });
  out = await wo.reject(2, asRole("manager", "Jue Wang"), "Already represented elsewhere.");
  check("a manager can turn one down, and the reason is kept for the consultant",
    out.ok === true && W.tasks[1].status === "rejected" && W.activity[1].action === "rejected" && W.activity[1].note === "Already represented elsewhere." && W.activity[1].visible === true);
  console.warn = silence;
  const pg = wo.renderPage({ user: asRole("attorney", "Chandler Jin"), staff: ["Jue Wang"],
    pending: [{ id: 3, title: "<script>x</script>", description: "it's \"quoted\"", priority: "urgent", submitter_name: "Luna Huang", created_at: new Date(), matter_type: "pi", client_name: "Chen, Mei", assigned_to: "Lin Mei" }] });
  check("the firm's page is plain forms — no script to break", !/<script/i.test(pg) && /method="POST" action="\/admin\/consultant-tasks\/3\/approve"/.test(pg) && /action="\/admin\/consultant-tasks\/3\/reject"/.test(pg) && !/work.?orders?/i.test(pg.replace(/<svg[\s\S]*?<\/svg>/g, "")) && /name="reason"[^>]*required/.test(pg));
  check("what the consultant typed cannot break out of it", /&lt;script&gt;x/.test(pg) && /it&#39;s &quot;quoted&quot;/.test(pg));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
