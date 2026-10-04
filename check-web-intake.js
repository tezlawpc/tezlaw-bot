// check-web-intake.js — the public contact form, exercised against real logic.
//
// This module shipped once already without being mounted: the file was in the
// repo, the form was on tezlawfirm.com, and "Chat with us" went nowhere. A
// prospect who filled it in reached no one. So the first assertion here is not
// about validation at all — it is that server.js actually mounts the thing.
//
// The rest guards the two properties that decide whether an intake survives:
// a real person must get through, and a bot must not reach the team chat.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const wi = require(path.join(ROOT, "web-intake.js"));
const { validate, teamText, inboxText, rateLimited, SERVICES, ALLOWED_ORIGINS } = wi._internal;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// A payload that should always pass, so each test can vary one field.
function good(over = {}) {
  return Object.assign({
    name: "Mei Chen",
    phone: "(626) 678-8677",
    service: "immigration",
    message: "I received a notice to appear and do not know what to do next.",
  }, over);
}

console.log("\nweb-intake public form\n");

// ── The mount ──────────────────────────────────────────────
// Without this line the module is dead code and the form is a dead end.

check("server.js mounts web-intake", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const mounted = server
    .split("\n")
    .filter(l => !l.trim().startsWith("//"))
    .some(l => /require\(\s*["']\.\/web-intake["']\s*\)\s*\.mount\(\s*app\s*\)/.test(l));
  assert.ok(mounted,
    'server.js does not mount web-intake. Add require("./web-intake").mount(app); ' +
    "beside the WEBSITE CHAT routes, or the public contact form posts into nothing.");
});

check("the module exposes a mount function", () => {
  assert.strictEqual(typeof wi.mount, "function");
});

// ── The honeypot ───────────────────────────────────────────
// A filled hidden field means a bot. The route answers ok:true and files
// nothing, so the bot learns nothing from the response.

check("a filled hidden field is rejected as 'website'", () => {
  const v = validate(good({ website: "http://spam.example" }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.field, "website");
});

check("the honeypot is checked before anything else", () => {
  // Even a payload that is otherwise garbage must report 'website', so the
  // route takes the silent branch rather than returning a 400 a bot can read.
  const v = validate({ website: "x" });
  assert.strictEqual(v.field, "website");
});

// ── Letting a real person through ──────────────────────────

check("a complete form passes and keeps what was typed", () => {
  const v = validate(good());
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.intake.name, "Mei Chen");
  assert.strictEqual(v.intake.phone, "(626) 678-8677");
  assert.strictEqual(v.intake.caseType, SERVICES.immigration);
  assert.strictEqual(v.intake.platform, "website");
});

check("one conversation thread per phone number", () => {
  // Two spellings of the same number must land on the same thread, or the
  // same caller shows up in the inbox as two strangers.
  const a = validate(good({ phone: "(626) 678-8677" })).intake.platformId;
  const b = validate(good({ phone: "626.678.8677" })).intake.platformId;
  assert.strictEqual(a, b);
  assert.strictEqual(a, "web-6266788677");
});

check("email is optional", () => {
  const v = validate(good({ email: "" }));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.intake.email, "");
});

check("browser language narrows to en / es / zh", () => {
  assert.strictEqual(validate(good({ lang: "zh-CN" })).intake.lang, "zh");
  assert.strictEqual(validate(good({ lang: "es-MX" })).intake.lang, "es");
  assert.strictEqual(validate(good({ lang: "fr-FR" })).intake.lang, "en");
  assert.strictEqual(validate(good({})).intake.lang, "en");
});

check("source defaults rather than coming back empty", () => {
  assert.strictEqual(validate(good()).intake.source, "website form");
  assert.strictEqual(validate(good({ source: "jj page" })).intake.source, "jj page");
});

// ── Turning a bad form around with a usable message ────────
// Each rejection names its field, because the page highlights that input.

check("a missing name is refused, by field", () => {
  const v = validate(good({ name: "" }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.field, "name");
  assert.ok(v.error.length > 0);
});

check("a phone number we cannot call is refused", () => {
  assert.strictEqual(validate(good({ phone: "626-678" })).field, "phone");
  assert.strictEqual(validate(good({ phone: "" })).field, "phone");
  // Long enough to be an international number is fine.
  assert.strictEqual(validate(good({ phone: "+86 138 0013 8000" })).ok, true);
});

check("a malformed email is refused", () => {
  assert.strictEqual(validate(good({ email: "mei at example" })).field, "email");
  assert.strictEqual(validate(good({ email: "mei@example.com" })).ok, true);
});

check("a message too short to act on is refused", () => {
  assert.strictEqual(validate(good({ message: "help" })).field, "message");
});

check("the service must be one we offer", () => {
  assert.strictEqual(validate(good({ service: "divorce" })).field, "service");
  assert.strictEqual(validate(good({ service: "" })).field, "service");
  for (const key of Object.keys(SERVICES)) {
    assert.strictEqual(validate(good({ service: key })).ok, true, `service ${key} should pass`);
  }
});

check("the service lookup cannot be walked up the prototype chain", () => {
  // hasOwnProperty, not `in`: otherwise "constructor" is a valid service and
  // caseType becomes a function.
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const v = validate(good({ service: key }));
    assert.strictEqual(v.ok, false, `${key} must not be accepted as a service`);
    assert.strictEqual(v.field, "service");
  }
});

check("a non-object body does not throw", () => {
  for (const body of [null, undefined, "string", 42, []]) {
    const v = validate(body);
    assert.strictEqual(v.ok, false);
  }
});

// ── What reaches the team chat ─────────────────────────────

check("control characters cannot break the Telegram message", () => {
  const v = validate(good({ name: "Mei\u0000\u001bChen\nSmith" }));
  assert.strictEqual(v.ok, true);
  assert.ok(!/[\u0000-\u001f]/.test(v.intake.name), "name still holds control characters");
  assert.ok(!/\n/.test(v.intake.name), "name must stay on one line");
});

check("a very long message is truncated, not refused", () => {
  const v = validate(good({ message: "x".repeat(5000) }));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.intake.message.length, 1000);
});

check("line breaks survive in the message body", () => {
  const v = validate(good({ message: "First thing.\n\nSecond thing entirely." }));
  assert.ok(v.intake.message.includes("\n"), "paragraphs were flattened");
});

check("the team message carries name, case type and phone", () => {
  const t = teamText(validate(good()).intake);
  assert.ok(t.includes("Mei Chen"));
  assert.ok(t.includes("(626) 678-8677"));
  assert.ok(t.includes(SERVICES.immigration));
});

check("no email means no empty email line", () => {
  const t = teamText(validate(good({ email: "" })).intake);
  assert.ok(!/Email:/.test(t), "team message shows an Email label with nothing after it");
  const t2 = teamText(validate(good({ email: "mei@example.com" })).intake);
  assert.ok(/Email: mei@example\.com/.test(t2));
});

check("the inbox copy reads as the client's own first message", () => {
  const i = validate(good()).intake;
  const text = inboxText(i);
  assert.ok(text.includes(i.message), "the client's words are missing from the inbox entry");
  assert.ok(text.includes(i.phone));
});

// ── Keeping a flood out of the team chat ───────────────────

check("a burst from one address is cut off", () => {
  const t = 2_000_000_000_000;              // fixed clock: these tests must not drift
  const ip = "198.51.100.7";
  for (let n = 1; n <= 5; n++) {
    assert.strictEqual(rateLimited(ip, t), false, `submission ${n} should be allowed`);
  }
  assert.strictEqual(rateLimited(ip, t), true, "the sixth submission should be refused");
});

check("one flooder does not block everyone else", () => {
  const t = 2_000_000_000_000;
  assert.strictEqual(rateLimited("203.0.113.9", t), false);
});

check("the limit lifts once the window passes", () => {
  const t = 2_000_000_000_000;
  const later = t + 3_600_001;              // past both the per-IP and global windows
  assert.strictEqual(rateLimited("198.51.100.7", later), false,
    "a legitimate caller is locked out after the window should have expired");
});

// ── Who may post the form ──────────────────────────────────

check("only the firm's own site may post cross-origin", () => {
  assert.deepStrictEqual(
    [...ALLOWED_ORIGINS].sort(),
    ["https://tezlawfirm.com", "https://www.tezlawfirm.com"],
  );
  for (const o of ALLOWED_ORIGINS) {
    assert.ok(o.startsWith("https://"), `${o} must be https`);
  }
});

console.log(`\n${passed} checks passed\n`);
