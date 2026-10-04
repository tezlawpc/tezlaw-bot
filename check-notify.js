/**
 * check-notify.js — broker/consultant alerts
 *
 * Self-sufficient: stubs pg and nodemailer so it runs on a machine with no
 * node_modules (JJ's M5 has none — it is the deploy clone).
 *
 * The assertions that matter most are the confidentiality ones. The rule JJ
 * chose is "headline and a login link, nothing else", and a rule like that
 * decays the moment someone adds a convenient parameter. So this checks the
 * SHAPE of the API, not just one rendered string: if a future caller can pass
 * free text, these fail.
 */

const path = require("path");
const Module = require("module");

// ── Stub unresolvable bare modules (the harness pattern) ────
const realLoad = Module._load;
const sent = { email: [], sms: [], telegram: [], app: [] };
Module._load = function (req, parent, isMain) {
  if (req === "nodemailer") {
    return { createTransport: () => ({ sendMail: async (m) => { sent.email.push(m); } }) };
  }
  if (req === "axios") {
    return {
      post: async (url, body) => {
        if (/exp\.host/.test(url)) { sent.app.push(...body); return { data: { data: body.map(() => ({ status: "ok" })) } }; }
        if (/api\.twilio\.com/.test(url)) sent.sms.push(String(body));
        else if (/api\.telegram\.org/.test(url)) sent.telegram.push(body);
        return { data: { ok: true } };
      },
      get: async () => ({ data: { ok: true } }),
    };
  }
  if (!req.startsWith(".") && !req.startsWith("/") && !Module.builtinModules.includes(req)) {
    try { return realLoad(req, parent, isMain); }
    catch { return new Proxy(function () {}, { get: () => () => {}, apply: () => ({}) }); }
  }
  return realLoad(req, parent, isMain);
};

// ── Fake database ───────────────────────────────────────────
const T = {
  users: [],
  links: [],       // { client_key, consultant_id, removed_at }
  tasks: [],       // { client_key, client_name, a_number }
  outbox: [],
  feed: [],        // consultant_feed: what a consultant sees when signed in
  phones: [],      // push_tokens: { user_kind, user_ref, expo_token }
  orders: [],      // work orders: { id, submitted_by_user_id, client_name, client_key }
};
let seq = 1;

function stubDb() {
  return {
    query: async (sql, v = []) => {
      const q = sql.replace(/\s+/g, " ").trim();

      if (/^(ALTER TABLE|CREATE TABLE|CREATE INDEX)/i.test(q)) return { rows: [] };

      if (/FROM client_consultants cc JOIN admin_users u/.test(q)) {
        const keys = T.links.filter(l => l.client_key === v[0] && !l.removed_at).map(l => l.consultant_id);
        return { rows: T.users.filter(u => keys.includes(u.id) && !u.disabled) };
      }
      if (/SELECT MAX\(client_name\) AS name FROM tasks/.test(q)) {
        const hit = T.tasks.filter(t => t.client_key === v[0]);
        return { rows: [{ name: hit.length ? hit[0].client_name : null }] };
      }
      if (/FROM tasks WHERE client_key IS NOT NULL AND regexp_replace/.test(q)) {
        const keys = [...new Set(T.tasks.filter(t => String(t.a_number || "").replace(/\D/g, "") === v[0]).map(t => t.client_key))];
        return { rows: keys.map(k => ({ client_key: k })) };
      }
      if (/FROM tasks WHERE client_key IS NOT NULL AND LOWER\(TRIM\(client_name\)\)/.test(q)) {
        const keys = [...new Set(T.tasks.filter(t => String(t.client_name || "").trim().toLowerCase() === String(v[0]).toLowerCase()).map(t => t.client_key))];
        return { rows: keys.map(k => ({ client_key: k })) };
      }
      if (/^INSERT INTO consultant_feed/.test(q)) {
        if (!T.feed.some(r => r.dedupe_key === v[5])) T.feed.push({ user_id: v[0], client_key: v[1], task_id: v[2], kind: v[3], who: v[4], dedupe_key: v[5] });
        return { rows: [] };
      }
      if (/FROM push_tokens WHERE user_ref = \$1 AND user_kind IN \('consultant', 'firm'\)/.test(q)) {
        return { rows: T.phones.filter(p => p.user_ref === v[0] && ["consultant", "firm"].includes(p.user_kind)).map(p => ({ expo_token: p.expo_token })) };
      }
      if (/FROM tasks WHERE id = \$1 AND submitted_by_user_id = \$2/.test(q)) {
        return { rows: T.orders.filter(o => o.id === v[0] && o.submitted_by_user_id === v[1]) };
      }
      if (/FROM admin_users WHERE id = \$1/.test(q)) {
        return { rows: T.users.filter(u => u.id === v[0]) };
      }
      if (/^INSERT INTO notification_outbox/.test(q)) {
        if (T.outbox.some(r => r.dedupe_key === v[7])) return { rows: [] };
        const row = {
          id: seq++, user_id: v[0], client_key: v[1], kind: v[2], channel: v[3],
          address: v[4], subject: v[5], body: v[6], dedupe_key: v[7],
          status: "pending", attempts: 0, last_error: null, last_try_at: null,
          queued_at: new Date(), task_id: v[8] == null ? null : v[8],
        };
        T.outbox.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/SELECT \* FROM notification_outbox WHERE status = 'pending'/.test(q)) {
        // Copies, not references — real pg hands back plain objects, and
        // returning live ones let the claim mutate the row the caller was
        // still reading, which made the retry count look one short.
        return { rows: T.outbox.filter(r => r.status === "pending" && r.attempts < v[1]).slice(0, v[0]).map(r => ({ ...r })) };
      }
      if (/UPDATE notification_outbox SET attempts = attempts \+ 1/.test(q)) {
        const r = T.outbox.find(x => x.id === v[0] && x.attempts === v[1] && x.status === "pending");
        if (!r) return { rows: [] };
        r.attempts++; r.last_try_at = new Date();
        return { rows: [{ id: r.id }] };
      }
      if (/UPDATE notification_outbox SET status = 'sent'/.test(q)) {
        const r = T.outbox.find(x => x.id === v[0]); if (r) { r.status = "sent"; r.last_error = null; }
        return { rows: [] };
      }
      if (/UPDATE notification_outbox SET status = \$2, last_error/.test(q)) {
        const r = T.outbox.find(x => x.id === v[0]); if (r) { r.status = v[1]; r.last_error = v[2]; }
        return { rows: [] };
      }
      if (/UPDATE admin_users SET telegram_link_code/.test(q)) {
        const u = T.users.find(x => x.id === v[0]); if (u) u.telegram_link_code = v[1];
        return { rows: [] };
      }
      if (/UPDATE admin_users SET telegram_chat_id/.test(q)) {
        const u = T.users.find(x => x.telegram_link_code === v[0]);
        if (!u) return { rows: [] };
        u.telegram_chat_id = v[1]; u.telegram_link_code = null; u.notify_telegram = true;
        return { rows: [{ id: u.id, username: u.username, full_name: u.full_name }] };
      }
      return { rows: [] };
    },
  };
}
require.cache[require.resolve(path.join(__dirname, "..", "db.js"))] = { id: "db", filename: "db", loaded: true, exports: stubDb() };

process.env.PUBLIC_BASE_URL = "https://tez.example";
const notify = require("../notify");

// ── Runner ──────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
}
function reset() {
  T.users.length = 0; T.links.length = 0; T.tasks.length = 0; T.outbox.length = 0;
  T.feed.length = 0; T.phones.length = 0; T.orders.length = 0;
  sent.email.length = 0; sent.sms.length = 0; sent.telegram.length = 0; sent.app.length = 0;
  for (const k of ["TWILIO_ACCOUNT_SID","TWILIO_AUTH_TOKEN","TWILIO_PHONE_NUMBER","TELEGRAM_TOKEN","SMTP_HOST","SMTP_USER","SMTP_PASS","GMAIL_EMAIL","GMAIL_APP_PASSWORD"]) delete process.env[k];
}
function consultant(o) { const u = { id: o.id, username: o.username || ("c" + o.id), full_name: o.full_name || null, email: null, phone: null, telegram_chat_id: null, notify_email: true, notify_sms: false, notify_telegram: false, notify_paused_until: null, disabled: false, ...o }; T.users.push(u); return u; }

(async () => {
console.log("\n── What may leave the firm ──");
{
  reset();
  const { subject, body } = notify.renderMessage("court_mail", "Wang, Baohong", "wang-baohong");
  check("the message names the event and the client", /New court notice/.test(body) && /Wang, Baohong/.test(body));
  check("it carries a login link", /https:\/\/tez\.example\/consultant\/client\/wang-baohong/.test(body));
  check("it is two lines and nothing more", body.split("\n").length === 2, JSON.stringify(body));

  // The shape check: notifyClientEvent must not accept caller text.
  const src = require("fs").readFileSync(path.join(__dirname, "..", "notify.js"), "utf8");
  const sig = (src.match(/async function notifyClientEvent\(\{([^}]*)\}/) || [])[1] || "";
  const params = sig.split(",").map(x => x.trim().split(/[=:]/)[0].trim()).filter(Boolean);
  const allowed = ["clientKey", "kind", "ref", "clientName"];
  check("callers cannot pass message text into an alert",
    params.every(p => allowed.includes(p)),
    "parameters are: " + params.join(", ") + " — anything outside " + allowed.join("/") + " is a way to leak case detail");
  check("every kind renders through the same function",
    Object.keys(notify.KINDS).every(k => { const b = notify.renderMessage(k, "X", "y").body; return b.split("\n").length === 2; }));
}

console.log("\n── Who gets told ──");
{
  reset();
  consultant({ id: 1, email: "a@x.com" });
  consultant({ id: 2, email: "b@x.com" });
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  T.links.push({ client_key: "k1", consultant_id: 2, removed_at: new Date() });  // taken off the case
  T.tasks.push({ client_key: "k1", client_name: "Wang, Baohong", a_number: "A200000000" });
  const r = await notify.notifyClientEvent({ clientKey: "k1", kind: "court_mail", ref: 7 });
  check("only currently-assigned consultants are told", r.queued === 1 && T.outbox[0].user_id === 1);

  reset();
  consultant({ id: 1, email: "a@x.com", disabled: true });
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  const r2 = await notify.notifyClientEvent({ clientKey: "k1", kind: "court_mail", ref: 7 });
  check("a disabled account is not told", r2.queued === 0);

  reset();
  const u = consultant({ id: 1, notify_sms: true });   // sms on, no phone
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  u.notify_email = false;
  const r3 = await notify.notifyClientEvent({ clientKey: "k1", kind: "court_mail", ref: 7 });
  check("a consultant with no reachable channel is reported, not silently skipped",
    r3.queued === 0 && r3.unreachable.length === 1 && /no phone/.test(r3.unreachable[0].why), JSON.stringify(r3.unreachable));
}

console.log("\n── Matching a name to a client ──");
{
  reset();
  T.tasks.push({ client_key: "k1", client_name: "Li, Junwei", a_number: "A123456789" });
  T.tasks.push({ client_key: "k2", client_name: "Li, Junwei", a_number: "A987654321" });
  const amb = await notify.resolveClientKey({ clientName: "Li, Junwei" });
  check("two clients with the same name resolve to nobody rather than a guess", amb.key === null && amb.how === "ambiguous_name");
  const byA = await notify.resolveClientKey({ aNumber: "A123-456-789" });
  check("an A-number resolves through punctuation", byA.key === "k1" && byA.how === "a_number");
  const none = await notify.resolveClientKey({ clientName: "Nobody At All" });
  check("an unknown name resolves to nobody", none.key === null && none.how === "no_match");
}

console.log("\n── The outbox ──");
{
  reset();
  consultant({ id: 1, email: "a@x.com" });
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  await notify.notifyClientEvent({ clientKey: "k1", kind: "court_mail", ref: 7 });
  check("the row is written before anything is sent", T.outbox.length === 1 && T.outbox[0].status === "pending" && sent.email.length === 0);

  await notify.notifyClientEvent({ clientKey: "k1", kind: "court_mail", ref: 7 });
  check("the same event does not queue twice", T.outbox.length === 1);

  // No transport configured: the send fails but the record survives.
  let r = await notify.flush();
  check("a failed send leaves the alert pending, not lost", T.outbox[0].status === "pending" && r.sent === 0);
  check("the reason is recorded", /not configured/.test(T.outbox[0].last_error || ""), T.outbox[0].last_error);

  // Backoff must stop a single sweep from burning every attempt.
  const before = T.outbox[0].attempts;
  await notify.flush();
  check("a retry waits rather than burning attempts in one sweep", T.outbox[0].attempts === before);

  // Now configure email and let it through.
  process.env.GMAIL_EMAIL = "firm@x.com"; process.env.GMAIL_APP_PASSWORD = "pw";
  T.outbox[0].last_try_at = new Date(Date.now() - 99 * 60000);
  r = await notify.flush();
  check("it goes out once the channel is configured", T.outbox[0].status === "sent" && sent.email.length === 1);
  check("the email carries no case detail beyond the headline",
    sent.email[0].text.split("\n").length === 2 && !/A\d{9}/.test(sent.email[0].text));

  // Give up after MAX_ATTEMPTS rather than retrying forever.
  reset();
  consultant({ id: 1, email: "a@x.com" });
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  await notify.notifyClientEvent({ clientKey: "k1", kind: "deadline", ref: 9 });
  for (let i = 0; i < 8; i++) { if (T.outbox[0]) T.outbox[0].last_try_at = new Date(Date.now() - 999 * 60000); await notify.flush(); }
  check("it eventually gives up and says so", T.outbox[0].status === "failed" && T.outbox[0].attempts === 5,
    `status=${T.outbox[0].status} attempts=${T.outbox[0].attempts}`);
}

console.log("\n── Channels ──");
{
  reset();
  process.env.TWILIO_ACCOUNT_SID = "AC1"; process.env.TWILIO_AUTH_TOKEN = "t"; process.env.TWILIO_PHONE_NUMBER = "+15550000";
  consultant({ id: 1, phone: "626-555-0100", notify_sms: true, notify_email: false });
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  await notify.notifyAndFlush({ clientKey: "k1", kind: "hearing_set", ref: 1 });
  check("SMS goes through the REST API, not the twilio package", sent.sms.length === 1);
  check("a 10-digit US number is sent in E.164", /To=%2B16265550100/.test(sent.sms[0]), sent.sms[0]);

  reset();
  process.env.TELEGRAM_TOKEN = "tok";
  consultant({ id: 1, telegram_chat_id: "555", notify_telegram: true, notify_email: false });
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  await notify.notifyAndFlush({ clientKey: "k1", kind: "status", ref: 1 });
  check("Telegram sends to the linked chat", sent.telegram.length === 1 && sent.telegram[0].chat_id === "555");

  const h = notify.channelHealth();
  check("channel health reports what is actually configured", h.telegram === true && h.email === false);
}

// JJ: "should be able to push case notification to brokers/consultants as
// well." Two halves: the Tara app as a channel, and a record the consultant
// can read once signed in — the alert has always said "log in to view" and,
// until this, logging in showed nothing.
console.log("\n── The Tara app, and what they see when signed in ──");
{
  reset();
  consultant({ id: 1, notify_email: false });           // no email, no text, no Telegram
  T.links.push({ client_key: "k1", consultant_id: 1, removed_at: null });
  T.tasks.push({ client_key: "k1", client_name: "Wang, Baohong" });
  const r = await notify.notifyClientEvent({ clientKey: "k1", kind: "update", ref: "m1" });
  check("an event is listed for the consultant even when no channel can reach them",
    r.queued === 0 && r.unreachable.length === 1 && T.feed.length === 1 && T.feed[0].kind === "update" && T.feed[0].who === "Wang, Baohong",
    JSON.stringify({ r, feed: T.feed }));
  await notify.notifyClientEvent({ clientKey: "k1", kind: "update", ref: "m1" });
  check("and listed once", T.feed.length === 1);

  reset();
  consultant({ id: 7, notify_email: false });
  T.links.push({ client_key: "k1", consultant_id: 7, removed_at: null });
  T.tasks.push({ client_key: "k1", client_name: "Wang, Baohong" });
  T.phones.push({ user_kind: "firm", user_ref: "7", expo_token: "ExponentPushToken[old]" });       // registered before the fix
  T.phones.push({ user_kind: "consultant", user_ref: "7", expo_token: "ExponentPushToken[new]" });
  T.phones.push({ user_kind: "client", user_ref: "7", expo_token: "ExponentPushToken[a-client]" }); // client account 7 is someone else
  const q = await notify.notifyAndFlush({ clientKey: "k1", kind: "court_mail", ref: 3 });
  check("a consultant signed in to the app is reachable through it", q.queued === 1 && q.unreachable.length === 0 && T.outbox[0].channel === "app");
  check("the push goes to their phones — however they were registered — and to nobody else's",
    sent.app.length === 2 && sent.app.every(m => /\[(old|new)\]/.test(m.to)), JSON.stringify(sent.app.map(m => m.to)));
  check("the lock screen shows the headline only",
    sent.app.every(m => m.title === "New court notice — Wang, Baohong" && m.body === "Open Tara to view."), JSON.stringify(sent.app[0]));

  reset();
  const off = consultant({ id: 7, notify_email: false, notify_app: false });
  T.links.push({ client_key: "k1", consultant_id: 7, removed_at: null });
  T.phones.push({ user_kind: "consultant", user_ref: "7", expo_token: "ExponentPushToken[new]" });
  const q2 = await notify.notifyClientEvent({ clientKey: "k1", kind: "court_mail", ref: 4 });
  check("turning the app channel off is respected", q2.queued === 0 && off.notify_app === false);

  check("the hand-sent kinds are fixed headlines too",
    ["update", "action", "document"].every(k => notify.KINDS[k] && notify.renderMessage(k, "X", "y").body.split("\n").length === 2));
}

// JJ: work orders "will need attorney or manager's approval" — so the person
// who sent one has to hear which way it went. (On screen they are "tasks".)
console.log("\n── A consultant's own task ──");
{
  reset();
  process.env.GMAIL_EMAIL = "firm@x.com"; process.env.GMAIL_APP_PASSWORD = "pw";
  consultant({ id: 1, email: "a@x.com" });
  consultant({ id: 2, email: "b@x.com" });
  T.orders.push({ id: 40, submitted_by_user_id: 1, client_name: "Chen, Mei", client_key: null });
  T.orders.push({ id: 41, submitted_by_user_id: 1, client_name: null, client_key: null });

  const src = require("fs").readFileSync(path.join(__dirname, "..", "notify.js"), "utf8");
  const sig = (src.match(/async function notifyUserEvent\(\{([^}]*)\}/) || [])[1] || "";
  const params = sig.split(",").map(x => x.trim().split(/[=:]/)[0].trim()).filter(Boolean);
  check("callers cannot pass message text here either", params.every(p => ["userId", "kind", "taskId", "ref"].includes(p)), params.join(", "));

  const r = await notify.notifyUserEvent({ userId: 1, kind: "wo_approved", taskId: 40, ref: "act-1" });
  await notify.flush();
  check("the submitter is told their task was approved", r.queued === 1 && sent.email.length === 1 && sent.email[0].to === "a@x.com");
  check("with the client's name and a link to it, and nothing else",
    sent.email[0].subject === "Task approved — Chen, Mei" &&
    sent.email[0].text.split("\n").length === 2 && /https:\/\/tez\.example\/consultant\/task\/40$/.test(sent.email[0].text), sent.email[0].text);
  check("it is in their list, pointing at the task", T.feed.length === 1 && T.feed[0].task_id === 40 && T.feed[0].kind === "wo_approved");

  const wrong = await notify.notifyUserEvent({ userId: 2, kind: "wo_rejected", taskId: 40, ref: "act-2" });
  check("it cannot be pointed at somebody else's task", wrong.recipients === 0 && wrong.queued === 0 && sent.email.length === 1 && T.feed.length === 1);

  const bare = notify.renderUserMessage("wo_rejected", { id: 41, client_name: null });
  check("one that named no client is referred to by number", bare.subject === "Task not accepted — task #41");
  let threw = false; try { await notify.notifyUserEvent({ userId: 1, kind: "court_mail", taskId: 40 }); } catch { threw = true; }
  check("a client-event kind is refused here", threw);

  const tasksSrc = require("fs").readFileSync(path.join(__dirname, "..", "tasks.js"), "utf8");
  check("every visible step on a task a consultant sent alerts its submitter, from one place",
    /await tellSubmitter\(taskId, activityId, action, actor_id, visible_to_submitter\)/.test(tasksSrc) &&
    /approved: "wo_approved", rejected: "wo_rejected"/.test(tasksSrc));
  check("but not for something the submitter did themselves", /String\(to\) === String\(actorId\)\) return/.test(tasksSrc));
}

console.log("\n── Telegram linking ──");
{
  reset();
  consultant({ id: 1, email: "a@x.com" });
  const code = await notify.issueLinkCode(1);
  check("the code has a recognisable shape", /^TEZ-[0-9A-F]{6}$/.test(code), code);
  check("a wrong code links nobody", (await notify.linkTelegram("TEZ-000000", "9")) === null || T.users[0].telegram_chat_id === null);
  const linked = await notify.linkTelegram(code, "12345");
  check("the right code links the account", linked && linked.id === 1 && T.users[0].telegram_chat_id === "12345");
  check("Telegram is turned on by linking", T.users[0].notify_telegram === true);
  check("the code cannot be used twice", (await notify.linkTelegram(code, "99999")) === null);
}

console.log("\n── Wiring ──");
{
  const fs = require("fs");
  const cm = fs.readFileSync(path.join(__dirname, "..", "court-mail.js"), "utf8");
  check("court mail alerts the broker", /notifyAndFlush\(\{[\s\S]{0,120}kind: "court_mail"/.test(cm));
  check("an alerting failure cannot roll back a filed email",
    /try \{[\s\S]{0,400}notifyAndFlush[\s\S]{0,400}catch/.test(cm));

  const pi = fs.readFileSync(path.join(__dirname, "..", "personal-injury.js"), "utf8");
  check("a PI status change alerts only when the status really changed",
    /before\.status !== updated\.status/.test(pi));

  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  check("the outbox is swept on a timer", /setInterval\(sweep/.test(srv));
  check("hearings and deadlines are swept daily", /sweepUpcoming\(\)/.test(srv));
  check("the alerts admin page is role-gated", /app\.use\("\/admin\/alerts", auth\.requireRole\("admin", "manager"\)\)/.test(srv));
  const send = (srv.match(/app\.post\("\/admin\/alerts\/send"[\s\S]*?\n\}\);/) || [""])[0];
  check("an alert sent by hand takes a client and a kind, and no text",
    /notify\.KINDS\[kind\]/.test(send) && /notifyAndFlush\(\{ clientKey, kind, ref:/.test(send) && !/b\.(message|text|body|note|subject)/.test(send));
  check("a consultant cannot change the address they are alerted at",
    !/UPDATE admin_users SET email[\s\S]{0,200}req\.user\.uid/.test(srv));
  check("the Telegram link code is read before the text reaches Zara",
    // The /chatid test became /^\/(chatid|whereami)…/ when alert routing was
    // added, and this still looked for the old spelling — which is not in
    // the file, so indexOf gave -1 and the comparison could never pass.
    srv.indexOf("linkTelegram(linkMatch[0]") > 0 &&
    srv.indexOf("linkTelegram(linkMatch[0]") < srv.search(/if \(\/\^\\\/\(?chatid/));
}

console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
