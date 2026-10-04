// check-court-mail-reading.js — what happens when the model will not cooperate.
//
// A pre-hearing order from an immigration judge arrived, the model answered
// with nothing twice, and the firm saw one line: "Error: Zara did not return
// JSON". Three separate things made that possible, and this holds all three
// shut:
//
//   · think() does not throw on an empty answer, it returns { text: "" }, so
//     "no JSON" and "no answer at all" came out under the same sentence;
//   · the retry re-sent the same prompt to the same model, which fails the
//     same way;
//   · the throw marked the row 'error', where it retried three times and
//     stopped — so a judge's order sat as a red box instead of in front of
//     somebody.
//
// The last one is the one that matters. Court mail may fail to be understood;
// it may never be lost.

const assert = require("assert");
const path = require("path");

require("./lib/stub-pg").install();        // court-mail → db.js → require("pg")

const ROOT = path.join(__dirname, "..");
const cm = require(path.join(ROOT, "court-mail.js"));
const { parseJson } = require(path.join(ROOT, "civil-intake-extract.js"));

let passed = 0;
function check(name, fn) {
  const done = fn();
  const settle = done && typeof done.then === "function" ? done : Promise.resolve();
  return settle.then(() => { passed++; console.log(`  ok  ${name}`); });
}

const GOOD = JSON.stringify({
  is_court_mail: true, agency: "EOIR", kind: "order",
  title: "Pre-Hearing Order", summary: "Filings due 60 days before the merits hearing.",
  a_numbers: ["A245-154-689"], case_numbers: [], suggested: [],
});

// A stand-in for zara-core.think: scripted answers, one per attempt, and a
// record of the tier each attempt asked for.
function scriptedAsk(answers) {
  const calls = [];
  const ask = async (message, tier) => {
    calls.push({ tier: tier || "balanced", chars: String(message).length });
    const next = answers[calls.length - 1];
    if (next === undefined) throw new Error("asked more times than the script allows");
    if (next instanceof Error) throw next;
    return typeof next === "string"
      ? { text: next, provider: "anthropic", model: "claude-test", stop_reason: "end_turn" }
      : next;
  };
  ask.calls = calls;
  return ask;
}

async function main() {
  console.log("\ncourt mail: reading an email that resists\n");

  await check("a clean answer is read on the first try", async () => {
    const ask = scriptedAsk([GOOD]);
    const out = await cm.readWithModel(ask, "PROMPT", parseJson);
    assert.strictEqual(out.kind, "order");
    assert.strictEqual(out.a_numbers[0], "A245-154-689");
    assert.strictEqual(ask.calls.length, 1, "it should not keep asking after a good answer");
  });

  await check("JSON wrapped in a code fence is still read", async () => {
    const ask = scriptedAsk(["```json\n" + GOOD + "\n```"]);
    const out = await cm.readWithModel(ask, "PROMPT", parseJson);
    assert.strictEqual(out.kind, "order");
  });

  await check("an empty answer is named as an empty answer", async () => {
    // This is the exact failure that hid the pre-hearing order.
    const ask = scriptedAsk(["", "", ""]);
    await assert.rejects(
      () => cm.readWithModel(ask, "PROMPT", parseJson),
      err => {
        assert.ok(/empty answer/i.test(err.message),
          `the error must say the model answered with nothing, got: ${err.message}`);
        assert.ok(!/did not return JSON/i.test(err.message),
          "an empty answer must not be reported as malformed JSON");
        return true;
      }
    );
  });

  await check("it escalates instead of re-asking the same model", async () => {
    const ask = scriptedAsk(["", "", ""]);
    await assert.rejects(() => cm.readWithModel(ask, "PROMPT", parseJson));
    assert.strictEqual(ask.calls.length, 3, "three attempts expected");
    const tiers = ask.calls.map(c => c.tier);
    assert.ok(tiers.includes("deep"),
      `the last attempt should reach for a better model, got tiers: ${tiers.join(", ")}`);
    assert.ok(ask.calls[1].chars > ask.calls[0].chars,
      "the second attempt should add the JSON-only instruction");
  });

  await check("a late answer still counts", async () => {
    const ask = scriptedAsk(["", "I'm not sure what you want.", GOOD]);
    const out = await cm.readWithModel(ask, "PROMPT", parseJson);
    assert.strictEqual(out.kind, "order");
    assert.strictEqual(ask.calls.length, 3);
  });

  await check("prose is quoted back, so the failure can be diagnosed", async () => {
    const chatter = "I cannot process this document because it appears to be incomplete.";
    const ask = scriptedAsk([chatter, chatter, chatter]);
    await assert.rejects(
      () => cm.readWithModel(ask, "PROMPT", parseJson),
      err => {
        assert.ok(err.message.includes("incomplete"),
          `the error should carry what the model actually said, got: ${err.message}`);
        return true;
      }
    );
  });

  await check("a provider blowing up is reported as that, not as bad JSON", async () => {
    const ask = scriptedAsk([new Error("529 overloaded"), new Error("529 overloaded"), new Error("529 overloaded")]);
    await assert.rejects(
      () => cm.readWithModel(ask, "PROMPT", parseJson),
      err => {
        assert.ok(/529 overloaded/.test(err.message), `got: ${err.message}`);
        assert.ok(/model call failed/i.test(err.message), `got: ${err.message}`);
        return true;
      }
    );
  });

  await check("every failed attempt is kept, not just the last", async () => {
    const ask = scriptedAsk(["", "no json here", new Error("timeout")]);
    await assert.rejects(
      () => cm.readWithModel(ask, "PROMPT", parseJson),
      err => {
        assert.ok(Array.isArray(err.readFailures), "readFailures should be attached");
        assert.strictEqual(err.readFailures.length, 3);
        assert.ok(/empty answer/i.test(err.readFailures[0]));
        assert.ok(/no json/i.test(err.readFailures[1]) || /it said/i.test(err.readFailures[1]));
        assert.ok(/timeout/.test(err.readFailures[2]));
        return true;
      }
    );
  });

  // ── Attachments ────────────────────────────────────────

  await check("an unreadable attachment says why instead of reading as blank", async () => {
    const got = await cm.attachmentText({
      filename: "order.pdf",
      content: Buffer.from("this is not a PDF at all"),
    });
    assert.strictEqual(got.text, "");
    assert.ok(got.error, "a PDF that will not parse must report an error, not an empty string");
  });

  await check("a file type we do not read is not an error", async () => {
    const got = await cm.attachmentText({ filename: "logo.png", content: Buffer.from("x") });
    assert.strictEqual(got.text, "");
    assert.strictEqual(got.error, null, "skipping an image is normal, not a problem to report");
  });

  await check("a text attachment is read", async () => {
    const got = await cm.attachmentText({
      filename: "notice.txt",
      content: Buffer.from("IMMIGRATION COURT\nA245-154-689\n"),
    });
    assert.ok(got.text.includes("A245-154-689"));
    assert.strictEqual(got.error, null);
  });

  await check("an empty text layer is called a scan, not nothing", async () => {
    const got = await cm.attachmentText({ filename: "scanned.txt", content: Buffer.from("   \n  ") });
    assert.strictEqual(got.text, "");
    assert.ok(/scan/i.test(got.error || ""),
      "a document with no text layer is the usual reason court mail reads as blank — say so");
  });

  console.log(`\n${passed} checks passed\n`);
}

main().catch(err => {
  console.error("\n" + (err && err.stack || err) + "\n");
  process.exit(1);
});
