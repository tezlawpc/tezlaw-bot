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

console.log("\n── American holidays, not just the lunar ones ───");
{
  const us = hp.HOLIDAYS.filter(h => !h.lunar);
  ok(`the calendar carries ${us.length} American/Western holidays`, us.length >= 24, String(us.length));
  for (const k of ["independence", "thanksgiving", "memorial", "veterans", "juneteenth",
                   "labor_day", "mlk", "christmas", "new_year", "halloween",
                   "valentines", "st_patricks", "tax_day", "easter", "flag_day",
                   "patriot_day", "new_years_eve", "small_business_saturday"]) {
    ok(`  ${k} is on the calendar`, hp.HOLIDAYS.some(h => h.key === k));
  }
  // West Covina is not only a Chinese-American community.
  for (const k of ["cinco_de_mayo", "mexican_independence", "dia_de_muertos"]) {
    ok(`  ${k} is on the calendar`, hp.HOLIDAYS.some(h => h.key === k));
  }
  ok("Cinco de Mayo's angle corrects the usual mistake",
    /NOT Mexican\s+"\s*\+\s*"Independence Day|NOT Mexican Independence Day/.test(
      hp.HOLIDAYS.find(h => h.key === "cinco_de_mayo").angle.replace(/\s+/g, " ")));
  ok("September 11 is solemn", hp.HOLIDAYS.find(h => h.key === "patriot_day").tone === "solemn");
}

console.log("\n── Easter is computed, not tabulated ───────────");
for (const [y, want] of [[2026, "2026-04-05"], [2027, "2027-03-28"], [2028, "2028-04-16"],
                         [2029, "2029-04-01"], [2030, "2030-04-21"]]) {
  ok(`Easter ${y} is ${want}`, hp.easter(y) === want, hp.easter(y));
}
ok("Small Business Saturday 2026 is the Saturday after Thanksgiving",
  hp.HOLIDAYS.find(h => h.key === "small_business_saturday").date(2026) === "2026-11-28",
  hp.HOLIDAYS.find(h => h.key === "small_business_saturday").date(2026));

console.log("\n── Wednesday fun facts ─────────────────────────");
{
  const ff = require("../fun-facts");
  const keys = ff.FACTS.map(f => f.key);
  ok(`the bank holds ${ff.FACTS.length} facts (about ${(ff.FACTS.length / 4.33).toFixed(0)} months of Wednesdays)`,
    ff.FACTS.length >= 20, String(ff.FACTS.length));
  ok("every fact key is unique", new Set(keys).size === keys.length);
  ok("every fact is written out in full, not a prompt for one",
    ff.FACTS.every(f => f.fact && f.fact.length > 60));
  ok("facts resting on a statute carry the authority to check them against",
    ff.FACTS.filter(f => f.cite).length >= 3);
  ok("no fact quotes a fee, a processing time or an 'as of' figure that "
   + "would go stale", !ff.FACTS.some(f => /\$\d|as of \d{4}|currently \d/.test(f.fact)));

  ok("a fresh bank starts at the first fact", ff.nextFact(new Set()).key === keys[0]);
  ok("a used fact is skipped", ff.nextFact(new Set([keys[0]])).key === keys[1]);
  const order = [...keys].reverse();
  ok("once the bank is exhausted it goes round again, oldest first",
    ff.nextFact(new Set(keys), order).key === order[0]);
  ok("…and the one just used does not come straight back",
    ff.nextFact(new Set(keys), [...order.slice(1), order[0]]).key !== order[0]);

  const CH = { name: "Facebook", max: 1200, voice: "(voice)" };   // stub: no database needed
  const prompt = ff.buildFactPrompt(ff.FACTS.find(f => f.cite), "facebook", CH);
  ok("the prompt hands over the fact as the only substance",
    /use this and nothing else as the substance/.test(prompt));
  ok("…and forbids adding any further legal rule",
    /may NOT add "?\s*\+?\s*"?further facts, dates, numbers, statutes/.test(prompt.replace(/\s+/g, " ")));
  ok("…and keeps the citation out of the published post",
    /do NOT put this in the post/.test(prompt));
  ok("the tired openers are banned", /Fun fact:/.test(prompt) && /hump day/.test(prompt));

  const i = srv.indexOf('schedule("22 9 * * 3"');
  const j = i < 0 ? -1 : srv.indexOf("America/Los_Angeles", i);
  ok("fun facts run on Wednesdays", i > -1);
  ok("…in Pacific time, in that same scheduled call",
    i > -1 && j > i && srv.slice(i, j).includes("queueFunFact"));
  ok("a fun fact is not re-queued within the same week",
    /created_at > NOW\(\) - INTERVAL '6 days'/.test(sp));
  ok("fun facts wait for approval too, like every other post",
    /queueFunFact[\s\S]{0,3000}buttonsFor\(q\.id, "Approve"\)/.test(sp));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL HOLIDAY POST CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
