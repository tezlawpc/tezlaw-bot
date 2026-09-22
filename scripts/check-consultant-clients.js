/**
 * check-consultant-clients.js
 *
 * JJ: keep the consultant portal — "it is important for them to enter
 * client info and search client info and see on their phone and computer."
 * Pins the web pages (list + search, add, one client) and their wiring.
 * The SQL was checked against Postgres when written (search stays inside
 * the consultant's own clients; only clients they entered are editable).
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
    if (/\/tasks$/.test(u)) return { ok: true, tasks: [{ description: "File I-589", status: "pending", completed: false, matter_type: "immigration" }, { description: "Contact: x", matter_type: "Contact", completed: false }] };
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
  check("lists open work, not the contact placeholder", /File I-589/.test(t) && !/Contact: x/.test(t));
  check("shows messages", /Hello/.test(t));
  check("offers a work order for this client, name filled in", !!p.doc.querySelector('a[href="/consultant/new?client=Garcia%2C%20Ana"]'));
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
  check("the portal has My Clients and Add Client tabs", /\/consultant\/clients", "👥 My Clients"/.test(portal) && /\/consultant\/clients\/new", "＋ Add Client"/.test(portal));
  check("add, search and edit routes exist and are consultant-only", /app\.post\("\/api\/consultant\/clients", requireBearer, requireConsultantRole/.test(appApi) && /app\.patch\("\/api\/consultant\/clients\/:key", requireBearer, requireConsultantRole/.test(appApi));
  check("search stays inside the consultant's own clients", /WHERE cc\.consultant_id = \$1 AND cc\.removed_at IS NULL[\s\S]{0,200}HAVING \$2 = ''/.test(appApi));
  check("edits only on clients they entered", /matter_type = 'Contact' AND submitted_by_user_id = \$2/.test(appApi));
  check("the web sign-in cookie works for /api/consultant/*", /cookies\[auth\.COOKIE_NAME\]/.test(appApi.slice(0, 3000)));
  const pages = require("../consultant-portal");
  const html = pages.renderClientsPage({ mode: "view", clientKey: '"><script>x</script>' });
  check("a client key cannot break out of the page", !/<script>x/.test(html));

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
