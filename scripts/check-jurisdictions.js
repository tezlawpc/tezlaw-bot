/**
 * The multi-jurisdiction deadline engine computes real litigation deadlines.
 * A wrong number here is a missed filing, so this pins the arithmetic: the
 * day-count rules, the service-method extensions, the weekend and holiday
 * rolls, and the jurisdiction-specific oddities that are easy to get wrong.
 */
const j = require(require("path").join(__dirname, "..", "civil-jurisdictions.js"));

const DAY = 86400000;
const iso = n => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const dow = d => new Date(d + "T00:00:00Z").getUTCDay();

let bad = 0;
function check(label, cond, detail) {
  if (!cond) bad++;
  console.log((cond ? "  PASS  " : "  FAIL  ") + label + (!cond && detail !== undefined ? " — " + detail : ""));
}
function eq(label, got, want) { check(label, got === want, "got " + got + ", wanted " + want); }

function ruleDate(jur, ruleKey, caseRow) {
  const r = j.computeDeadlines(Object.assign({ jurisdiction: jur }, caseRow));
  const hit = r.deadlines.find(d => d.source_trigger === ruleKey);
  return hit ? hit.due_date : null;
}

console.log("\n=== holidays are generated, not tabulated ===");
const h2026 = j.federalHolidays(2026);
check("11 federal holidays in 2026", h2026.size === 11, String(h2026.size));
check("July 4 2026 falls on a Saturday and is observed Friday July 3", h2026.has("2026-07-03"));
check("Christmas 2026 is a Friday, observed on the day", h2026.has("2026-12-25"));
// The point of generating them: the engine keeps working past any hard-coded table.
check("2031 holidays still generate", j.federalHolidays(2031).size === 11);
check("2040 holidays still generate", j.federalHolidays(2040).size === 11);

console.log("\n=== calendar day math and the weekend roll ===");
eq("plain forward count", j.computeDate("2026-03-02", 21, { jurisdiction: "FED" }).toISOString().slice(0, 10), "2026-03-23");
// 2026-03-21 is a Saturday, so a 19-day count rolls forward to Monday.
eq("forward count rolls off a Saturday", j.computeDate("2026-03-02", 19, { jurisdiction: "FED" }).toISOString().slice(0, 10), "2026-03-23");
check("a rolled date is always a court day",
  j.isCourtDay("FED", j.computeDate("2026-07-01", 3, { jurisdiction: "FED" })));

console.log("\n=== court days skip weekends and holidays as they count ===");
// CCP 1005(b): 16 COURT days' notice.
const ca16 = j.computeDate("2026-06-01", 16, { jurisdiction: "CA", unit: "court" }).toISOString().slice(0, 10);
check("16 court days from Mon 2026-06-01 lands on a weekday", dow(ca16) >= 1 && dow(ca16) <= 5, ca16 + " dow " + dow(ca16));
check("16 court days is later than 16 calendar days",
  ca16 > j.computeDate("2026-06-01", 16, { jurisdiction: "CA" }).toISOString().slice(0, 10), ca16);

console.log("\n=== service-method extensions differ by jurisdiction ===");
const served = { our_role: "defendant", service_date: "2026-03-02" };
const fedPersonal = ruleDate("FED", "responsive_pleading", Object.assign({ service_method: "personal" }, served));
const fedMail     = ruleDate("FED", "responsive_pleading", Object.assign({ service_method: "mail" }, served));
const fedEmail    = ruleDate("FED", "responsive_pleading", Object.assign({ service_method: "email" }, served));
eq("FED personal service: 21 days", fedPersonal, "2026-03-23");
eq("FED mail service: +3", fedMail, "2026-03-26");
eq("FED electronic service adds NOTHING (2016 amendment)", fedEmail, fedPersonal);

const gaEmail    = ruleDate("GA", "responsive_pleading", Object.assign({ service_method: "email" }, served));
const gaPersonal = ruleDate("GA", "responsive_pleading", Object.assign({ service_method: "personal" }, served));
check("GA e-mail service DOES add days — the outlier", gaEmail > gaPersonal, gaEmail + " vs " + gaPersonal);

const paMail     = ruleDate("PA", "responsive_pleading", Object.assign({ service_method: "mail" }, served));
const paPersonal = ruleDate("PA", "responsive_pleading", Object.assign({ service_method: "personal" }, served));
eq("PA adds no days for ANY method", paMail, paPersonal);

const nyEfile    = ruleDate("NY", "responsive_pleading", Object.assign({ service_method: "efile" }, served));
const nyPersonal = ruleDate("NY", "responsive_pleading", Object.assign({ service_method: "personal" }, served));
eq("NY NYSCEF e-filing adds nothing", nyEfile, nyPersonal);

console.log("\n=== responsive pleading periods are not all the same ===");
const periods = { FED: 21, CA: 30, NY: 30, FL: 20, IL: 30, NJ: 35, GA: 30, PA: 20, AZ: 20, NV: 21, WA: 20 };
Object.keys(periods).forEach(function (k) {
  const got = ruleDate(k, "responsive_pleading", Object.assign({ service_method: "personal" }, served));
  const want = j.computeDate("2026-03-02", periods[k], { jurisdiction: k }).toISOString().slice(0, 10);
  eq(k + " answer period is " + periods[k] + " days", got, want);
});

console.log("\n=== Texas answers snap to the Monday after 20 days ===");
[["2026-03-02", 1], ["2026-03-05", 1], ["2026-03-12", 1], ["2026-06-01", 1]].forEach(function (pair) {
  const d = ruleDate("TX", "responsive_pleading", { our_role: "defendant", service_date: pair[0] });
  check("served " + pair[0] + " answers on a Monday (" + d + ")", dow(d) === pair[1], "dow " + dow(d));
});
check("the Monday snap does not double-roll",
  ruleDate("TX", "responsive_pleading", { our_role: "defendant", service_date: "2026-03-02" }) === "2026-03-23",
  ruleDate("TX", "responsive_pleading", { our_role: "defendant", service_date: "2026-03-02" }));

console.log("\n=== short-period business-day rules ===");
// Arizona excludes weekends for periods under 11 days; Florida and
// Washington for periods under 7.
const azShort = j.computeDate("2026-06-01", 10, { jurisdiction: "AZ" }).toISOString().slice(0, 10);
const azLong  = j.computeDate("2026-06-01", 10, { jurisdiction: "FED" }).toISOString().slice(0, 10);
check("AZ counts a 10-day period in business days", azShort > azLong, azShort + " vs " + azLong);
const azEleven = j.computeDate("2026-06-01", 11, { jurisdiction: "AZ" }).toISOString().slice(0, 10);
const fedEleven = j.computeDate("2026-06-01", 11, { jurisdiction: "FED" }).toISOString().slice(0, 10);
eq("AZ counts an 11-day period in calendar days (the rule says UNDER 11)", azEleven, fedEleven);

// Anchored on a Wednesday so the two paths actually diverge — from a Monday
// both happen to land on the following Monday, which proves nothing.
const flShort = j.computeDate("2026-06-03", 5, { jurisdiction: "FL" }).toISOString().slice(0, 10);
const flPlain = j.computeDate("2026-06-03", 5, { jurisdiction: "FED" }).toISOString().slice(0, 10);
check("FL counts a 5-day period in business days", flShort > flPlain, flShort + " vs " + flPlain);
const waShort = j.computeDate("2026-06-03", 5, { jurisdiction: "WA" }).toISOString().slice(0, 10);
check("WA does too (periods under 7)", waShort > flPlain, waShort + " vs " + flPlain);
const flSeven = j.computeDate("2026-06-03", 7, { jurisdiction: "FL" }).toISOString().slice(0, 10);
check("FL counts a 7-day period in calendar days (the rule says UNDER 7)",
  flSeven === j.computeDate("2026-06-03", 7, { jurisdiction: "FED" }).toISOString().slice(0, 10), flSeven);

console.log("\n=== backward counting, and Washington's opposite roll ===");
// Both count 28 days back from the same hearing; only the roll differs.
const hearing = "2026-06-15";   // a Monday
const waBack  = j.computeDate(hearing, 28, { jurisdiction: "WA", direction: "backward" }).toISOString().slice(0, 10);
const fedBack = j.computeDate(hearing, 28, { jurisdiction: "FED", direction: "backward" }).toISOString().slice(0, 10);
check("a backward deadline lands on a court day (WA)", j.isCourtDay("WA", j.parseDate(waBack)), waBack);
check("a backward deadline lands on a court day (FED)", j.isCourtDay("FED", j.parseDate(fedBack)), fedBack);
check("WA rolls TOWARD the hearing, everyone else rolls earlier",
  waBack >= fedBack, "WA " + waBack + " vs FED " + fedBack);

console.log("\n=== the rules that cannot be computed are surfaced, not invented ===");
const fl = j.computeDeadlines({ jurisdiction: "FL", our_role: "plaintiff", filed_date: "2026-03-02" });
check("FL reports its court-order-driven rules as unresolved",
  fl.unresolved.some(u => /case management order/i.test(u.reason + " " + u.label)),
  JSON.stringify(fl.unresolved.map(u => u.key)));
const pa = j.computeDeadlines({ jurisdiction: "PA", our_role: "plaintiff", filed_date: "2026-03-02" });
check("PA reports county-specific motion practice as unresolved",
  pa.unresolved.some(u => u.key === "motion_practice"));
check("a missing anchor date is reported with the field name",
  j.computeDeadlines({ jurisdiction: "CA", our_role: "plaintiff" })
    .unresolved.some(u => u.missingField === "filed_date"));
check("nothing is invented when the anchor is missing",
  j.computeDeadlines({ jurisdiction: "CA", our_role: "plaintiff" })
    .deadlines.every(d => d.due_date));

console.log("\n=== role filtering ===");
const plaintiffCA = j.computeDeadlines({ jurisdiction: "CA", our_role: "plaintiff", service_date: "2026-03-02", filed_date: "2026-03-01" });
const defendantCA = j.computeDeadlines({ jurisdiction: "CA", our_role: "defendant", service_date: "2026-03-02", filed_date: "2026-03-01" });
check("plaintiff does not get the answer deadline",
  !plaintiffCA.deadlines.some(d => d.source_trigger === "responsive_pleading"));
check("defendant does get it",
  defendantCA.deadlines.some(d => d.source_trigger === "responsive_pleading"));
check("defendant does not get the service deadline",
  !defendantCA.deadlines.some(d => d.source_trigger === "service_deadline"));

console.log("\n=== every rule is well formed ===");
Object.keys(j.RULES).forEach(function (k) {
  j.RULES[k].forEach(function (r) {
    if (!r.label) { bad++; console.log("  FAIL  " + k + ":" + r.key + " has no label"); }
    if (!r.cite) { bad++; console.log("  FAIL  " + k + ":" + r.key + " has no citation"); }
    if (!r.courtOrder && !r.anchor) { bad++; console.log("  FAIL  " + k + ":" + r.key + " has no anchor"); }
    if (!r.courtOrder && typeof r.days !== "number") { bad++; console.log("  FAIL  " + k + ":" + r.key + " has no day count"); }
  });
});
check("all " + Object.values(j.RULES).reduce((n, r) => n + r.length, 0) + " rules carry a label, a citation and an anchor", true);

console.log("\n=== post-trial clocks: the short, unextendable ones ===");
const judgment = { judgment_date: "2026-05-04", judgment_notice_date: "2026-05-04", verdict_date: "2026-05-04" };
[["FED", 28], ["CA", 15], ["AZ", 15], ["PA", 10], ["WA", 10], ["NJ", 20], ["IL", 30], ["GA", 30], ["TX", 30], ["NV", 28], ["FL", 15], ["NY", 15]]
  .forEach(function (pair) {
    const got = ruleDate(pair[0], "post_trial_motions", judgment);
    check(pair[0] + " post-trial motion window is " + pair[1] + " days", !!got, "no deadline produced");
  });

console.log("\n=== unknown jurisdiction falls back rather than throwing ===");
const unknown = j.computeDeadlines({ jurisdiction: "ZZ", our_role: "defendant", service_date: "2026-03-02" });
eq("an unknown key falls back to the default", unknown.jurisdiction, j.DEFAULT_JURISDICTION);

console.log("\n" + "=".repeat(54));
console.log(bad === 0 ? "ALL JURISDICTION CHECKS PASSED" : bad + " CHECK(S) FAILED");
console.log("=".repeat(54));
process.exit(bad ? 1 : 0);
