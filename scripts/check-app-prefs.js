/**
 * check-app-prefs.js
 *
 * JJ: "for dashboard, give user the option to add or move" — each person's
 * Home layout is saved to their account; and the iPad's "Full Admin" opens
 * the web platform signed in, through a one-time 60-second link.
 */
const Module = require("module");
const express = require("express");
let failures = 0;
function check(name, ok, detail) { if (!ok) failures++; console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail)); }

const prefs = new Map();
const users = { 7: { id: 7, username: "jj", full_name: "JJ Zhang", role: "admin", disabled: false }, 9: { id: 9, username: "old", full_name: "Old", role: "attorney", disabled: true } };
const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^CREATE /.test(q)) return { rows: [] };
  if (/^SELECT value, updated_at FROM app_user_prefs/.test(q)) { const r = prefs.get(v[0] + "|" + v[1]); return { rows: r ? [r] : [] }; }
  if (/^INSERT INTO app_user_prefs/.test(q)) { const r = { value: JSON.parse(v[2]), updated_at: new Date() }; prefs.set(v[0] + "|" + v[1], r); return { rows: [r] }; }
  if (/^DELETE FROM app_user_prefs/.test(q)) { prefs.delete(v[0] + "|" + v[1]); return { rows: [] }; }
  if (/FROM admin_users WHERE id = \$1/.test(q)) { const u = users[v[0]]; return { rows: u ? [u] : [] }; }
  throw new Error("unexpected " + q);
} };
const orig = Module._load;
Module._load = function (r, ...rest) { if (r === "./db") return fakeDb; return orig.call(this, r, ...rest); };
const P = require("../app-prefs");

(async () => {
  const auth = { makeToken: async p => "tok." + Buffer.from(JSON.stringify(p)).toString("base64url"), COOKIE_NAME: "tezauth" };
  let who = { uid: 7, r: "admin" };
  const requireBearer = (req, res, next) => { req.user = who; next(); };
  const requireFirmUser = (req, res, next) => ["admin", "manager", "attorney", "paralegal", "viewer"].includes(req.user.r) ? next() : res.status(403).json({ ok: false });
  const app = express(); app.use(express.json({ limit: "1mb" }));
  P.attach(app, { requireBearer, requireFirmUser, auth });
  const srv = app.listen(0); const base = "http://127.0.0.1:" + srv.address().port;
  const J = async (m, u, b) => { const r = await fetch(base + u, { method: m, redirect: "manual", headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); let body = null; try { body = await r.clone().json(); } catch (e) { body = await r.text(); } return { status: r.status, body, headers: r.headers }; };

  console.log("\n— Saved dashboard layouts —");
  let r = await J("GET", "/api/staff/prefs/dashboard.phone");
  check("nothing saved yet → null (the app uses its default)", r.body.ok && r.body.value === null);
  const layout = { v: 1, sections: [{ id: "urgent", on: true }], shortcuts: ["search", "trust"] };
  r = await J("PUT", "/api/staff/prefs/dashboard.phone", { value: layout });
  check("saving a layout", r.body.ok);
  r = await J("GET", "/api/staff/prefs/dashboard.phone");
  check("…reads back the same layout", JSON.stringify(r.body.value) === JSON.stringify(layout));
  who = { uid: 8, r: "paralegal" };
  r = await J("GET", "/api/staff/prefs/dashboard.phone");
  check("another person has their own (not JJ's)", r.body.value === null);
  who = { uid: 7, r: "admin" };
  r = await J("GET", "/api/staff/prefs/dashboard.wide");
  check("phone and iPad layouts are separate", r.body.value === null);
  r = await J("PUT", "/api/staff/prefs/dashboard.phone", { reset: true });
  r = await J("GET", "/api/staff/prefs/dashboard.phone");
  check("reset removes it (back to the standard layout)", r.body.value === null);
  r = await J("PUT", "/api/staff/prefs/BAD KEY!", { value: 1 });
  check("odd keys are refused", r.status === 400);
  r = await J("PUT", "/api/staff/prefs/dashboard.phone", { value: { junk: "x".repeat(30000) } });
  check("oversized settings are refused", r.status === 400);
  who = { uid: 5, r: "consultant" };
  r = await J("GET", "/api/staff/prefs/dashboard.phone");
  check("consultants are not firm users here", r.status === 403);

  console.log("\n— Full Admin one-time link —");
  who = { uid: 7, r: "admin" };
  r = await J("POST", "/api/staff/web-link", { next: "/admin/clients" });
  check("the app gets a link", r.body.ok && /\/app-web-login\?c=[\w-]{20,}&next=%2Fadmin%2Fclients$/.test(r.body.url), r.body.url);
  const path = r.body.url.replace(/^https?:\/\/[^/]+/, "");
  let g = await J("GET", path);
  check("opening it signs the browser in", g.status === 302 && /^tezauth=tok\./.test(g.headers.get("set-cookie") || "") && /HttpOnly/.test(g.headers.get("set-cookie")));
  check("…and lands on the page asked for", g.headers.get("location") === "/admin/clients");
  const payload = JSON.parse(Buffer.from((g.headers.get("set-cookie").match(/tok\.([^;]+)/) || [])[1], "base64url").toString());
  check("…as the same person, with their current role", payload.uid === 7 && payload.r === "admin" && payload.exp > Date.now());
  g = await J("GET", path);
  check("the same link cannot be used twice", g.status === 302 && !g.headers.get("set-cookie") && /^\/admin\/login/.test(g.headers.get("location")));
  r = await J("POST", "/api/staff/web-link", { next: "https://evil.example/phish" });
  check("a link can only lead into the admin", /next=%2Fadmin%2Fdashboard$/.test(r.body.url));
  check("safeNext refuses //host tricks", P.safeNext("/admin//evil.com") === "/admin/dashboard" && P.safeNext("//evil.com") === "/admin/dashboard" && P.safeNext("/admin/calendar?x=1") === "/admin/calendar?x=1");
  r = await J("POST", "/api/staff/web-link", {});
  const code = new URL(r.body.url).searchParams.get("c");
  P._links.get(code).exp = Date.now() - 1;
  g = await J("GET", "/app-web-login?c=" + code);
  check("an expired link does nothing", !g.headers.get("set-cookie"));
  who = { uid: 9, r: "attorney" };
  r = await J("POST", "/api/staff/web-link", {});
  g = await J("GET", r.body.url.replace(/^https?:\/\/[^/]+/, ""));
  check("a disabled account is not signed in", !g.headers.get("set-cookie"));
  g = await J("GET", "/app-web-login?c=made-up");
  check("a made-up code does nothing", !g.headers.get("set-cookie"));

  srv.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
