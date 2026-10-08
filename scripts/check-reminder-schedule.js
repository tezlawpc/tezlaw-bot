/**
 * check-reminder-schedule.js
 * ─────────────────────────────────────────────────────────
 * The EOIR reminder schedule JJ set out on 2026-10-08.
 *
 * These messages go to people in removal proceedings, about dates that
 * decide whether they stay in the country. The checks here are mostly
 * about what the messages must NOT do:
 *
 *   - state a time that was not on the notice (hearing-when.js)
 *   - state a filing deadline the system worked out for itself, when the
 *     IJ's scheduling order is what governs and varies by case
 *   - explain voluntary departure, which is an election with conditions
 *     and consequences and belongs in a conversation with a lawyer
 *   - carry markdown, which SMS prints literally
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let passed = 0;
function check(name, fn) {
  try { fn(); } catch (err) { console.log("  FAIL  " + name); throw err; }
  console.log("  ok  " + name);
  passed++;
}

const S = require(path.join(ROOT, "reminder-schedule.js"));
const HR = require(path.join(ROOT, "hearing-reminders.js"));

console.log("\nWhat an Immigration Court client hears from us, and when\n");

// ── the schedule JJ asked for ───────────────────────────────

check("a master calendar hearing gets 30, 7 and 1 day, and a day after", () => {
  for (const d of [30, 7, 1]) {
    assert.strictEqual(S.stagesFor("master", d).length, 1, `no master stage at ${d} days`);
  }
  const after = S.stagesFor("master", -1);
  assert.strictEqual(after.length, 1, "nothing goes out after the master hearing");
  assert.strictEqual(after[0].kind, "collect",
    "the day-after message is not the one asking for the documents");
});

check("a merits hearing gets 60, 30, 7, 5, 2 and 1 day", () => {
  for (const d of [60, 30, 7, 5, 2, 1]) {
    assert.strictEqual(S.stagesFor("individual", d).length, 1, `no merits stage at ${d} days`);
  }
  assert.strictEqual(S.stagesFor("individual", 60)[0].kind, "review");
  assert.strictEqual(S.stagesFor("individual", 30)[0].kind, "cutoff");
  assert.strictEqual(S.stagesFor("individual", 5)[0].kind, "where");
});

check("a master client never gets the merits messages, and the reverse", () => {
  // The 60-day review and the filing cutoff are about a merits hearing. A
  // master-calendar client receiving them would be told a deadline that is
  // not theirs.
  for (const d of [60, 5, 2]) {
    assert.strictEqual(S.stagesFor("master", d).length, 0,
      `a merits-only stage at ${d} days fires for a master hearing`);
  }
  assert.strictEqual(S.stagesFor("individual", -1).length, 0,
    "the post-master collection message fires after a merits hearing too");
});

check("every stage has a distinct key, because the log dedups on it", () => {
  const keys = S.STAGES.map((s) => s.key);
  assert.strictEqual(new Set(keys).size, keys.length, "two stages share a key: " + keys.join(", "));
});

check("a stage can be switched off without touching anything else", () => {
  const stage = S.STAGES.find((s) => s.key === "merits-2");
  const was = stage.on;
  try {
    stage.on = false;
    assert.strictEqual(S.stagesFor("individual", 2).length, 0, "a stage that is off still fires");
    assert.ok(!S.allOffsets().includes(2) || S.STAGES.some((s) => s.on && s.when === 2),
      "the runner still walks an offset no live stage uses");
  } finally { stage.on = was; }
});

// ── what the messages may not say ───────────────────────────

const sample = {
  client_name: "Wang Xiang", hearing_type: "individual", source: "individual",
  hearing_date: "2026-12-10T08:30:00.000Z", hearing_time_text: "08:30",
  court_name: "Santa Ana Immigration Court",
  court_address: "1241 E. Dyer Road, Suite 200, Santa Ana, CA 92705",
  judge_name: "Hom, Howard C.",
};
const msg = (key, lang = "en") =>
  HR.buildReminderMessage(sample, S.STAGES.find((s) => s.key === key).when, lang,
    S.STAGES.find((s) => s.key === key));

check("the filing cutoff never states a number of days as the court's deadline", () => {
  // 8 C.F.R. § 1003.31(c) leaves the deadline to the IJ, and the notice in
  // a given case may say 15 days, or something else. JJ: "except the notes
  // specifically states a different deadline."
  const t = msg("merits-30");
  assert.ok(/the one in your hearing notice/.test(t),
    "the message does not point the client at their own notice");
  assert.ok(/can differ from case to case/.test(t),
    "the message does not say the deadline varies");
  assert.ok(!/\b(15|30|twenty|thirty|fifteen)[- ]day deadline\b/i.test(t),
    "the message asserts a deadline in days, which is the judge's to set");
});

check("voluntary departure is an invitation to call, not an explanation", () => {
  const t = msg("merits-30");
  assert.ok(/voluntary departure/i.test(t), "the option is not mentioned at all");
  assert.ok(/call us on 626-678-8677/.test(t), "no way to reach a lawyer about it");
  assert.ok(/not something to decide from a text message/i.test(t),
    "nothing tells the client this needs a conversation");
  // The heading used to read "SOMETHING YOU SHOULD KNOW ABOUT", which trips
  // the guard below on the words rather than the meaning. Reworded rather
  // than excused: a guard that gets loosened to fit the text it guards is
  // not a guard.
  // It must not read as advice, or as a description a client could act on.
  for (const bad of [/you should/i, /we recommend/i, /simply leave/i, /just leave/i,
                     /the best option/i, /you can avoid/i, /no consequences/i]) {
    assert.ok(!bad.test(t), "the message gives advice about voluntary departure: " + bad);
  }
});

check("every message quotes the time from the notice, never one of its own", () => {
  for (const key of ["merits-60", "merits-30", "merits-5"]) {
    assert.ok(msg(key).includes("8:30 AM"), `${key} does not carry the notice's time`);
  }
  // And a hearing with no time text says so rather than inventing one.
  const noTime = { ...sample, hearing_time_text: null };
  const t = HR.buildReminderMessage(noTime, 5, "en", S.STAGES.find((s) => s.key === "merits-5"));
  assert.ok(/time not confirmed/i.test(t), "a hearing with no stated time got one anyway");
  assert.ok(!/12:00/.test(t), "a date-only value was rendered as noon, which is the Imperial bug");
});

check("no message carries markdown, which SMS prints as asterisks", () => {
  for (const key of ["master-after", "merits-60", "merits-30", "merits-5"]) {
    for (const lang of ["en", "zh"]) {
      const t = msg(key, lang);
      assert.ok(!/\*/.test(t), `${key} (${lang}) carries an asterisk`);
      assert.ok(!/^#{1,6}\s/m.test(t), `${key} (${lang}) carries a markdown heading`);
    }
  }
});

check("the five-day message gives the place, and says what missing it costs", () => {
  const t = msg("merits-5");
  assert.ok(t.includes("Santa Ana Immigration Court"), "no court");
  assert.ok(t.includes("1241 E. Dyer Road"), "no address");
  assert.ok(/order of removal in your absence/i.test(t),
    "nothing says what happens if they do not attend");
});

check("the day-after-master message asks for the evidence and says where to send it", () => {
  const t = HR.buildReminderMessage({ ...sample, source: "master", hearing_type: "master" },
    -1, "en", S.STAGES.find((s) => s.key === "master-after"));
  assert.ok(/send us everything/i.test(t), "it does not ask for the documents");
  assert.ok(/jj@tezlawfirm\.com/.test(t), "it does not say where to send them");
});

check("Chinese clients get Chinese, and Spanish clients are not machine-translated", () => {
  assert.ok(/律师事务所/.test(msg("merits-60", "zh")), "the Chinese message is missing");
  // The long messages are not written in Spanish. English is the honest
  // fallback: a machine translation of a filing deadline is worse than a
  // language the client may have to ask about.
  assert.strictEqual(S.MESSAGES.es, S.MESSAGES.en,
    "Spanish has its own copy now; it needs a human translator, not this file");
});

// ── how the runner uses it ──────────────────────────────────

check("the runner walks the schedule rather than two hard-coded windows", () => {
  const src = read("hearing-reminders.js");
  assert.ok(/reminder-schedule/.test(src), "the runner does not know about the schedule");
  assert.ok(!/const sevenDay = await processRemindersForWindow\(7\)/.test(src),
    "the two hard-coded windows are still what runs");
});

check("the reminder window is the firm's calendar day, not UTC's", () => {
  const src = read("hearing-reminders.js");
  const i = src.indexOf("async function getUpcomingHearings");
  const block = src.slice(i, i + 900);
  // toISOString() names tomorrow from 5pm Pacific, so for seven hours of
  // every day the 30-day window was really the 31-day window.
  assert.ok(/America\/Los_Angeles/.test(block), "the window is not taken in the firm's zone");
  assert.ok(!/target\.toISOString\(\)\.substring\(0, 10\)/.test(block),
    "the window is back on the UTC clock");
});

check("the dedup log keys on the stage, not the day count", () => {
  const src = read("hearing-reminders.js");
  assert.ok(/stage_key = \$3/.test(src), "two messages at the same distance would suppress each other");
  assert.ok(/ADD COLUMN IF NOT EXISTS stage_key/.test(src), "the column is never created");
  assert.ok(/SET stage_key = days_out::text WHERE stage_key IS NULL/.test(src),
    "rows written before the schedule existed would re-send");
});

check("the check is registered the way every check here is", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.ok(pkg.scripts["check:reminder-schedule"], "no npm script");
  assert.ok(pkg.scripts["test:chain"].includes("check-reminder-schedule.js"), "not in the chain");
  assert.ok(read(".github/workflows/ci.yml").includes("check-reminder-schedule.js"), "not in CI");
});

console.log(`\n${passed} checks passed\n`);
