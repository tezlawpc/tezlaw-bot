/**
 * One bot, one token — however many variable names the code grew.
 *
 * TELEGRAM_TOKEN and TELEGRAM_BOT_TOKEN both drive @TEZJJBot. About half the
 * senders read one and half the other, so when the two drifted apart, half the
 * notifications died and half kept working — which reads as "the feature is
 * broken" rather than "a credential is wrong", and sent us looking in the code.
 *
 * Worse, most of those senders swallow their errors. Hearing notes was the only
 * one that showed a person the failure; court mail, digests, deadline alerts
 * and task notifications had been failing quietly for hours.
 *
 * So: every read falls back, and the server says at boot whether the token
 * actually works.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
const ok = (m) => console.log("  ok   " + m);
const fail = (m) => { failures++; console.log("  FAIL " + m); };

const root = path.join(__dirname, "..");
console.log("\nTelegram token\n");

// Every plain read of TELEGRAM_BOT_TOKEN must fall back to TELEGRAM_TOKEN.
const files = fs.readdirSync(root).filter(f => f.endsWith(".js"));
const offenders = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), "utf8");
  src.split("\n").forEach((line, i) => {
    if (!line.includes("process.env.TELEGRAM_BOT_TOKEN")) return;
    // A line naming both is either the fallback or the boot-time comparison.
    const rest = line.replace(/TELEGRAM_BOT_TOKEN/g, "");
    if (!rest.includes("TELEGRAM_TOKEN")) offenders.push(`${f}:${i + 1}`);
  });
}
if (offenders.length) {
  fail(`these read TELEGRAM_BOT_TOKEN with no fallback, so one stale variable takes them down: ${offenders.join(", ")}`);
} else {
  ok("every TELEGRAM_BOT_TOKEN read falls back to TELEGRAM_TOKEN");
}

// The boot check: a rejected token must be shouted, not swallowed.
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
if (/getMe/.test(server)) ok("the server checks the token at boot");
else fail("nothing verifies the Telegram token at boot - a revoked token would go unnoticed again");
if (/token REJECTED/.test(server)) ok("a rejected token is logged loudly, naming the fix");
else fail("a rejected token should say so plainly in the logs");
if (/TELEGRAM_BOT_TOKEN !== process\.env\.TELEGRAM_TOKEN/.test(server)) {
  ok("the server warns when the two variables disagree");
} else {
  fail("the server should warn when TELEGRAM_TOKEN and TELEGRAM_BOT_TOKEN differ");
}

// The webhook: registered by the server, not by a curl somebody has to remember.
if (/setWebhook/.test(server)) {
  ok("the server registers its own webhook, so a token change needs no manual curl");
} else {
  fail("no setWebhook - after a token change the bot would send but never receive");
}
const iSet = server.indexOf("setWebhook");
if (iSet !== -1 && /\/telegram/.test(server.slice(iSet, iSet + 400))) {
  ok("the webhook points at this server's /telegram route");
} else if (iSet !== -1) {
  fail("the webhook URL should point at /telegram on this server");
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL TELEGRAM TOKEN CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
