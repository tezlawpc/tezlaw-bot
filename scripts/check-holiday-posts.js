/**
 * check-holiday-posts.js
 *
 * JJ: "the posts are too generic and too legal. make it more fun and
 * educational. in addition, plan holiday posts for the next 30 days every
 * 1st of the month."
 *
 * The risk in answering the first half is obvious: "more fun" is one bad
 * edit away from "less compliant", and these are a lawyer's public
 * advertisements. So this pins BOTH halves — the instructions that make a
 * post worth reading, and every advertising rule that was there before.
 *
 * Separate from check-social-posts.js on purpose: that one loads
 * social-posts.js, which pulls in an image renderer that is not installed on
 * every machine. These checks read text and call pure date functions, so they
 * run anywhere.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail ? "  → " + detail : "")); }
}

const REPO = path.join(__dirname, "..");
const sp = fs.readFileSync(path.join(REPO, "social-posts.js"), "utf8");
const srv = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const hp = require("../holiday-posts");

console.log("\n── The post is asked to be worth reading ────────");
ok("the prompt says what a good post DOES before what it must avoid",
  sp.indexOf("THE JOB: teach the reader ONE specific thing") > -1 &&
  sp.indexOf("THE JOB: teach the reader ONE specific thing") < sp.indexOf("DO NOT WRITE, in any wording"));
ok("…and asks for the part people usually get wrong",
  /the thing people usually get wrong/i.test(sp));
ok("…and for a concrete number, date or example",
  /concrete number, date or example/.test(sp));
for (const c of ["Navigating X can be complex", "At TEZ Law Firm, we", "Contact us today", "Did you know"]) {
  ok(`the prompt bans the cliche "${c}"`, sp.includes(c));
}

console.log("\n── …without loosening one compliance rule ───────");
ok("the no-fabrication rule survived the rewrite",
  /build it ONLY from the material below/.test(sp) &&
  /invents a rule is worse than no post/.test(sp));
for (const [what, needle] of [
  ["outcome guarantees", "guarantees an outcome"],
  ["win-record claims", "claims a win record"],
  ["unsubstantiated superlatives", "unsubstantiated superlative"],
  ["manufactured urgency", "manufactured urgency"],
  ["telling a stranger what to file", "tells the reader what to file"],
  ["speaking to the reader's own case", "speaks to the reader's own case"],
  ["Chinese outcome promises", "promises a result (Chinese)"],
]) ok(`the screen still catches ${what}`, sp.includes(needle));
ok("the screen still runs on what the model produced, not on the request",
  /const v = screen\(text, \{ channel, sourceUrl: source\.url \}\)/.test(sp));
ok("the emoji ceiling is still enforced in code, not merely requested",
  /if \(emoji > 4\)/.test(sp));

console.log("\n── The calendar's arithmetic ────────────────────");
for (const [label, got, want] of [
  ["MLK 2026 (3rd Monday)", hp.nthWeekday(2026, 1, 1, 3), "2026-01-19"],
  ["Memorial 2026 (last Monday)", hp.nthWeekday(2026, 5, 1, -1), "2026-05-25"],
  ["Thanksgiving 2026 (4th Thursday)", hp.nthWeekday(2026, 11, 4, 4), "2026-11-26"],
  ["Labor Day 2027 (1st Monday)", hp.nthWeekday(2027, 9, 1, 1), "2027-09-06"],
  ["Mother's Day 2026 (2nd Sunday)", hp.nthWeekday(2026, 5, 0, 2), "2026-05-10"],
]) ok(`${label} is ${want}`, got === want, got);

console.log("\n── A lunar date is never guessed ────────────────");
const unknown = hp.upcoming({ from: new Date("2031-01-15"), days: 60 });
ok("a lunar festival in an unverified year is SKIPPED, not estimated",
  !unknown.holidays.some(h => h.lunar));
ok("…and the skip is reported rather than silent",
  unknown.warnings.some(w => /no verified date/.test(w)), JSON.stringify(unknown.warnings));
const known = hp.upcoming({ from: new Date("2027-02-01"), days: 10 });
ok("a verified year does produce the festival",
  known.holidays.some(h => h.key === "lunar_new_year" && h.date === "2027-02-06"));

console.log("\n── Tone is chosen per holiday ───────────────────");
ok("every holiday carries a human-written angle, so the model never invents "
 + "the substance", hp.HOLIDAYS.every(h => h.angle && h.angle.length > 40));
ok("every holiday has a tone the prompt knows", hp.HOLIDAYS.every(h => hp.TONE[h.tone]));
ok("solemn days forbid the word 'happy'", /Never the words 'happy' or 'celebrate'/.test(hp.TONE.solemn));
ok("Memorial Day is solemn", hp.HOLIDAYS.find(h => h.key === "memorial").tone === "solemn");
ok("Veterans Day is solemn", hp.HOLIDAYS.find(h => h.key === "veterans").tone === "solemn");
ok("Qingming is solemn", hp.HOLIDAYS.find(h => h.key === "qingming").tone === "solemn");
ok("Halloween is allowed to be fun", hp.HOLIDAYS.find(h => h.key === "halloween").tone === "celebratory");

console.log("\n── The monthly run reaches the whole month ──────");
const covers = (from, days, key) =>
  hp.upcoming({ from: new Date(from), days }).holidays.some(h => h.key === key);
ok("a plain 30-day window from the 1st would MISS Halloween",
  !covers("2026-10-01", 30, "halloween"));
ok("the monthly run's wider window covers Halloween", covers("2026-10-01", 38, "halloween"));
ok("…and New Year's Day", covers("2026-12-01", 38, "new_year"));
ok("…and Thanksgiving", covers("2026-11-01", 38, "thanksgiving"));
// Not a fixed character window: a comment added between the schedule and its
// timezone would break that, and a check that fails for an unrelated edit is
// how a suite stops being believed. Slice between the two landmarks instead
// and assert what has to be inside.
{
  const i = srv.indexOf('schedule("7 9 1 * *"');
  const j = i < 0 ? -1 : srv.indexOf("America/Los_Angeles", i);
  ok("the plan runs on the 1st of each month", i > -1);
  ok("…in Pacific time, in that same scheduled call",
    i > -1 && j > i && srv.slice(i, j).includes("queueHolidays"));
}
ok("the monthly run asks for more than 30 days, to close the month-end gap",
  /queueHolidays\(\{ days: 3[1-9] \}\)/.test(srv));

console.log("\n── Nothing publishes itself ─────────────────────");
ok("holiday drafts are deduped, so a restart on the 1st cannot double-post",
  /SELECT id FROM social_posts WHERE source_url = \$1 AND channel = \$2/.test(sp));
ok("holiday posts wait for the same approval buttons as every other post",
  /buttonsFor\(q\.id, "Approve"\)/.test(sp));
ok("nothing is drafted at all unless SOCIAL_POSTS_ENABLED is true",
  /if \(!ENABLED\) return \{ queued: 0, reason: "SOCIAL_POSTS_ENABLED is not true" \};[\s\S]{0,200}queueHolidays|async function queueHolidays[\s\S]{0,200}if \(!ENABLED\)/.test(sp));

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL HOLIDAY POST CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
