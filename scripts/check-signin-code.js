/**
 * check-signin-code.js
 *
 * Staff and consultants sign in with a password and then a code sent to the
 * phone or email on file. The four rules that keep that from locking the
 * office out — or from being a formality — are in signin-code.js's header.
 * This pins each of them, against a pretend database so it runs anywhere.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail !== undefined ? "  → " + JSON.stringify(detail) : "")); }
}

// ── A pretend database, just enough for signin-code.js ──
const users = {
  1: { id: 1, username: "jj", full_name: "JJ", role: "admin", password_hash: "hash-a", phone: null, email: null, disabled: false },
  2: { id: 2, username: "chandler", full_name: "Chandler", role: "attorney", password_hash: "hash-b", phone: "626-555-0142", email: null, disabled: false },
  3: { id: 3, username: "jue", full_name: "Jue", role: "manager", password_hash: "hash-c", phone: "", email: "jue@example.com", disabled: false },
  4: { id: 4, username: "both", full_name: "Both", role: "consultant", password_hash: "hash-d", phone: "(909) 555-7777", email: "b@example.com", disabled: false },
  5: { id: 5, username: "bad", full_name: "Bad", role: "consultant", password_hash: "hash-e", phone: "12", email: "not-an-email", disabled: false },
};
let settings = { web_required: true, app_required: false };
let codes = []; let seq = 0; const NOW = () => Date.now();
const db = {
  logAudit: async () => {},
  query: async (sql, p = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^(ALTER|CREATE)/.test(s) || /INSERT INTO signin_settings/.test(s)) return { rows: [] };
    if (/SELECT web_required, app_required FROM signin_settings/.test(s)) return { rows: [settings] };
    if (/UPDATE signin_settings SET/.test(s)) { settings = { web_required: p[0], app_required: p[1] }; return { rows: [] }; }
    if (/SELECT phone, email FROM admin_users WHERE id = \$1/.test(s)) return { rows: users[p[0]] ? [users[p[0]]] : [] };
    if (/SELECT id, phone, email FROM admin_users/.test(s)) return { rows: Object.values(users) };
    if (/SELECT id, username, password_hash, full_name, role, disabled FROM admin_users WHERE id = \$1/.test(s)) return { rows: users[p[0]] && !users[p[0]].disabled ? [users[p[0]]] : [] };
    if (/SELECT COUNT\(\*\)::int AS n FROM staff_signin_codes/.test(s)) return { rows: [{ n: codes.filter(c => c.user_id === p[0] && NOW() - c.created < 15 * 60e3).length }] };
    if (/UPDATE staff_signin_codes SET used = TRUE WHERE user_id = \$1/.test(s)) { codes.forEach(c => { if (c.user_id === p[0]) c.used = true; }); return { rows: [] }; }
    if (/INSERT INTO staff_signin_codes/.test(s)) { codes.push({ id: ++seq, user_id: p[0], channel: p[1], sent_to: p[2], code_hash: p[3], attempts: 0, used: false, created: NOW(), expires: NOW() + Number(p[4]) * 60e3 }); return { rows: [] }; }
    if (/SELECT \* FROM staff_signin_codes WHERE user_id = \$1 AND used = FALSE AND expires_at > NOW\(\)/.test(s)) {
      const live = codes.filter(c => c.user_id === p[0] && !c.used && c.expires > NOW()).sort((a, b) => b.id - a.id);
      return { rows: live.slice(0, 1).map(r => ({ ...r })) };   // a row is a snapshot, as from a real database
    }
    if (/SET attempts = attempts \+ 1 WHERE id = \$1/.test(s)) { codes.find(c => c.id === p[0]).attempts++; return { rows: [] }; }
    if (/SET used = TRUE WHERE id = \$1/.test(s)) { codes.find(c => c.id === p[0]).used = true; return { rows: [] }; }
    throw new Error("the pretend database was asked something new: " + s.slice(0, 90));
  },
};
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub("../db", db);
// auth.js signs tokens with a secret it keeps in the database; a stand-in
// that refuses a tampered or expired token is all this needs.
const crypto = require("crypto");
const KEY = "check-key";
const sign = (b) => crypto.createHmac("sha256", KEY).update(b).digest("hex").slice(0, 24);
stub("../auth", {
  makeToken: async (payload) => { const b = Buffer.from(JSON.stringify(payload)).toString("base64url"); return b + "." + sign(b); },
  verifyToken: async (t) => { try { const [b, sig] = String(t).split("."); if (sign(b) !== sig) return null; const p = JSON.parse(Buffer.from(b, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; } },
});
const told = [];
stub("../tg-route", { send: async (topic, text) => { told.push({ topic, text }); } });
stub("../notify", { mailTransport: () => null });

for (const k of ["NODE_ENV", "RENDER", "RENDER_EXTERNAL_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SID", "TWILIO_SMS_FROM", "TWILIO_PHONE_NUMBER"]) delete process.env[k];
const signin = require("../signin-code");
const src = fs.readFileSync(path.join(__dirname, "..", "signin-code.js"), "utf8");

// The code a development server prints instead of sending.
let lastCode = null;
const realWarn = console.warn;
console.warn = (...a) => { const m = String(a[0]).match(/sign-in code for user \d+: (\d{6})/); if (m) lastCode = m[1]; };

(async () => {
  console.log("\n── Rule 1: no phone and no email → the password alone ──");
  let g = await signin.gate(users[1], { surface: "web" });
  ok("an account with nothing on file is not asked for a code", g.required === false && g.why === "no_contact", g);
  g = await signin.gate(users[5], { surface: "web" });
  ok("a phone that is not a phone and an email that is not an email count as nothing", g.required === false && g.why === "no_contact", g);
  const cov = await signin.coverage();
  ok("the Users page can name the accounts in that position", cov.total === 5 && cov.uncovered.sort().join() === "1,5", cov);

  console.log("\n── Who is asked ──");
  g = await signin.gate(users[2], { surface: "web" });
  ok("a phone on file → a code on the website", g.required === true && g.channels.length === 1 && g.channels[0].channel === "sms", g);
  ok("the number is put in +1 form", g.channels[0].to === "+16265550142", g.channels[0]);
  ok("…and shown only by its last four digits", g.channels[0].masked === "phone ending 0142");
  g = await signin.gate(users[3], { surface: "web" });
  ok("an email on file → a code by email", g.required && g.channels[0].channel === "email" && !g.channels[0].masked.includes("jue@"), g.channels);
  g = await signin.gate(users[4], { surface: "web" });
  ok("both on file → both offered", g.channels.map(c => c.channel).sort().join() === "email,sms");

  console.log("\n── Rule 4: the phone app ──");
  g = await signin.gate(users[2], { surface: "app", supportsCode: false });
  ok("a build that cannot show the code step is let in on the password", g.required === false && g.why === "old_app", g);
  g = await signin.gate(users[2], { surface: "app", supportsCode: true });
  ok("a build that can is asked", g.required === true && !g.updateApp, g);
  settings = { web_required: true, app_required: true };
  g = await signin.gate(users[2], { surface: "app", supportsCode: false });
  ok("once the firm requires it in the app, an old build is told to update", g.required === true && g.updateApp === true, g);
  g = await signin.gate(users[1], { surface: "app", supportsCode: false });
  ok("…but never an account with nothing on file (the App Review demo account)", g.required === false, g);
  settings = { web_required: false, app_required: false };
  g = await signin.gate(users[2], { surface: "web" });
  ok("the website switch turns it off", g.required === false && g.why === "off", g);
  settings = { web_required: true, app_required: false };

  console.log("\n── The code itself ──");
  let sent = await signin.send(users[2]);
  ok("a code is issued", sent.ok && sent.channel === "sms" && /^\d{6}$/.test(lastCode || ""), sent);
  ok("it is stored only as a hash", codes[0].code_hash !== lastCode && /^[0-9a-f]{64}$/.test(codes[0].code_hash));
  ok("it lives ten minutes", Math.round((codes[0].expires - codes[0].created) / 60e3) === 10);
  const good = lastCode;
  const wrong = good === "000000" ? "111111" : "000000";
  let c = await signin.check(users[2], wrong);
  ok("a wrong code is refused and counted", c.ok === false && /4 tries left/.test(c.error), c);
  c = await signin.check(users[2], "12");
  ok("a short entry is not counted as a try", c.ok === false && codes[0].attempts === 1, codes[0].attempts);
  c = await signin.check(users[3], good);
  ok("one person's code does not open another's account", c.ok === false);
  c = await signin.check(users[2], ` ${good.slice(0, 3)} ${good.slice(3)} `);
  ok("the right code is accepted, spaces and all", c.ok === true, c);
  c = await signin.check(users[2], good);
  ok("and cannot be used twice", c.ok === false && c.expired === true, c);

  sent = await signin.send(users[2]);
  for (let i = 0; i < 5; i++) c = await signin.check(users[2], wrong);
  ok("five wrong tries end the code", c.ok === false && c.expired === true && /Too many wrong tries/.test(c.error), c);
  c = await signin.check(users[2], lastCode);
  ok("…even for the right code afterwards", c.ok === false, c);

  const first = (await signin.send(users[4])) && lastCode;
  await signin.send(users[4], { prefer: "email" });
  ok("a new code retires the one before it", (await signin.check(users[4], first)).ok === false && (await signin.check(users[4], lastCode)).ok === true);
  codes = []; let lim;
  for (let i = 0; i < 6; i++) lim = await signin.send(users[4]);
  ok("five codes in fifteen minutes, then wait", lim.ok === false && lim.limited === true, lim);
  codes = [];
  codes.push({ id: ++seq, user_id: 2, channel: "sms", sent_to: "+16265550142", code_hash: crypto.createHash("sha256").update("424242").digest("hex"), attempts: 0, used: false, created: NOW() - 11 * 60e3, expires: NOW() - 60e3 });
  c = await signin.check(users[2], "424242");
  ok("an expired code is refused", c.ok === false && c.expired === true, c);

  console.log("\n── Rule 3: this device, for 30 days ──");
  const dev = await signin.deviceToken(users[2]);
  ok("a remembered device is not asked again", (await signin.gate(users[2], { surface: "web", device: dev })).why === "trusted_device");
  ok("on the app too", (await signin.gate(users[2], { surface: "app", supportsCode: true, device: dev })).required === false);
  ok("another person's device token does nothing", (await signin.gate(users[4], { surface: "web", device: dev })).required === true);
  ok("a made-up token does nothing", (await signin.gate(users[2], { surface: "web", device: "x.y" })).required === true);
  users[2].password_hash = "hash-b2";
  ok("changing the password forgets every device", (await signin.gate(users[2], { surface: "web", device: dev })).required === true);

  console.log("\n── Between the password and the code ──");
  const pend = await signin.pendingToken(users[4]);
  ok("the pending token names the person", ((await signin.userFromPending(pend)) || {}).user.id === 4);
  ok("it is not a session", !/"uid"|"r":/.test(Buffer.from(pend.split(".")[0], "base64url").toString()));
  users[4].password_hash = "hash-d2";
  ok("it dies if the password changes meanwhile", (await signin.userFromPending(pend)) === null);
  users[4].disabled = true;
  ok("a disabled account cannot finish", (await signin.userFromPending(await signin.pendingToken(users[4]))) === null);
  users[4].disabled = false;
  ok("rubbish is not a pending token", (await signin.userFromPending("nope")) === null && (await signin.userFromPending(dev)) === null);

  console.log("\n── Rule 2: the code cannot be sent ──");
  process.env.NODE_ENV = "production";      // a live server never prints a code
  lastCode = null;
  sent = await signin.send(users[2]);
  ok("on the live server with no text-message account, sending fails rather than pretending", sent.ok === false && sent.tried.length === 1 && lastCode === null, sent);
  await signin.reportUnsendable(users[2], sent, "web");
  ok("the firm is told on Telegram, so it does not go unnoticed", told.length === 1 && told[0].topic === "ops" && /could not be sent to Chandler/.test(told[0].text) && /let in on their password alone/.test(told[0].text), told);
  delete process.env.NODE_ENV;

  console.log("\n── Where it is wired in ──");
  const authSrc = fs.readFileSync(path.join(__dirname, "..", "auth.js"), "utf8");
  const apiSrc = fs.readFileSync(path.join(__dirname, "..", "app-api.js"), "utf8");
  const webLogin = (authSrc.match(/app\.post\("\/admin\/login",[\s\S]*?\n  \}\);/) || authSrc.match(/\.post\("\/admin\/login"[\s\S]{0,4000}/) || [""])[0];
  ok("the website asks after the password, never before", authSrc.indexOf("signin.gate(") > authSrc.indexOf("verifyPasswordHash(") && /signin\.gate\(/.test(authSrc) && /\/admin\/login\/code/.test(authSrc), webLogin.length);
  const appLogin = (apiSrc.match(/app\.post\("\/api\/auth\/staff\/login"[\s\S]*?\n  \}\);/) || [""])[0];
  ok("the app login checks the password first, then the gate",
    appLogin.indexOf("verifyPasswordHash") > 0 && appLogin.indexOf("signin.gate(") > appLogin.indexOf("verifyPasswordHash"));
  ok("an old build is told to update with 426, not left on a blank screen", /status\(426\)/.test(appLogin) && /UPDATE_REQUIRED/.test(appLogin));
  ok("a code that cannot be sent lets them in and reports it", /await signin\.reportUnsendable\(user, sent, "app"\)/.test(appLogin));
  ok("the app's code step exists", /app\.post\("\/api\/auth\/staff\/verify-code"/.test(apiSrc) && /app\.post\("\/api\/auth\/staff\/resend-code"/.test(apiSrc));
  ok("the code never goes into a log on the live server", (src.match(/console\.(log|warn)\([^)]*\$\{code\}/g) || []).length === 2 && (src.match(/if \(!isLive\(\)\) \{\s*const code[\s\S]{0,80}console\.warn/g) || []).length === 1 && /if \(!m\) \{\s*if \(isLive\(\)\) throw/.test(src));

  console.warn = realWarn;
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.warn = realWarn; console.error("CRASH", e); process.exit(1); });
