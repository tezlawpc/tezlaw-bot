/**
 * check-social-posts.js
 *
 * JJ on Sintra: "its too fake and not tailored for tez."
 *
 * Two things have to hold for this to be better than Sintra rather than the
 * same thing wearing a different logo:
 *
 *   1. It cannot invent. No source, no post; a thin source produces nothing
 *      rather than filler.
 *   2. It cannot publish a line that would embarrass a licensed attorney.
 *      Most of these checks are the compliance screen, because that is the
 *      part with real consequences — JJ has an open State Bar matter, and
 *      "guaranteed approval" in a firm's own social post is the kind of
 *      sentence that becomes an exhibit.
 *
 * Zara is stubbed: these test the rules and the flow, not the model.
 */
const Module = require("module");
const path = require("path");

let failures = 0;
function check(name, got, want) {
  const okk = JSON.stringify(got) === JSON.stringify(want);
  if (!okk) failures++;
  console.log((okk ? "  ok   " : "  FAIL ") + name +
    (okk ? "" : `\n         got:  ${JSON.stringify(got)}\n         want: ${JSON.stringify(want)}`));
}
function ok(name, cond, detail = "") {
  if (!cond) failures++;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || !detail ? "" : "  → " + detail));
}
async function throwsA(name, fn, re) {
  let good = false, detail = "did not throw";
  try { await fn(); } catch (e) { good = re.test(e.message); detail = e.message; }
  if (!good) failures++;
  console.log((good ? "  ok   " : "  FAIL ") + name + (good ? "" : "  → " + detail));
}

process.env.SOCIAL_POSTS_ENABLED = "true";
delete process.env.TELEGRAM_TOKEN;          // no real Telegram in tests
delete process.env.JJ_TELEGRAM_ID;

// ── A social_posts table, in memory ──────────────────────────
const T = { rows: [] };
let seq = 1;
const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^(CREATE|ALTER)/i.test(q)) return { rows: [] };
  if (/^INSERT INTO social_posts/.test(q)) {
    const r = { id: seq++, channel: v[0], text: v[1], source_url: v[2], source_title: v[3],
      problems: JSON.parse(v[4]), status: "pending" };
    T.rows.push(r); return { rows: [{ id: r.id }] };
  }
  if (/^SELECT \* FROM social_posts WHERE id/.test(q)) {
    return { rows: T.rows.filter(r => r.id === v[0]).map(r => ({ ...r })) };
  }
  if (/^UPDATE social_posts SET status = 'blocked'/.test(q)) {
    Object.assign(T.rows.find(r => r.id === v[0]), { status: "blocked", problems: JSON.parse(v[1]), decided_by: v[2] });
    return { rows: [] };
  }
  if (/^UPDATE social_posts SET status = 'error'/.test(q)) {
    Object.assign(T.rows.find(r => r.id === v[0]), { status: "error", error: v[1] }); return { rows: [] };
  }
  if (/^UPDATE social_posts SET status = 'approved'/.test(q)) {
    Object.assign(T.rows.find(r => r.id === v[0]), { status: "approved", decided_by: v[1] }); return { rows: [] };
  }
  if (/^UPDATE social_posts SET status = 'skipped'/.test(q)) {
    const r = T.rows.find(x => x.id === v[0] && x.status === "pending");
    if (r) Object.assign(r, { status: "skipped", decided_by: v[1] });
    return { rows: r ? [{ id: r.id }] : [] };
  }
  if (/GROUP BY status/.test(q)) {
    const m = {}; for (const r of T.rows) m[r.status] = (m[r.status] || 0) + 1;
    return { rows: Object.entries(m).map(([status, n]) => ({ status, n })) };
  }
  return { rows: [] };
} };

const realLoad = Module._load;
Module._load = function (request) {
  if (request === "./db" || request === path.join(__dirname, "..", "db")) return fakeDb;
  return realLoad.apply(this, arguments);
};

const S = require("../social-posts");

const URL = "https://tezlawfirm.com/green-card-travel";
const SOURCE = {
  title: "Travelling on a pending green card application",
  url: URL,
  summary: "Leaving the United States while an adjustment of status application is pending "
    + "can be treated as abandoning it unless advance parole was granted first. The post "
    + "explains what advance parole is and when it is issued.",
};

// ── The screen ───────────────────────────────────────────────
(async () => {
console.log("\n── What the screen refuses ──────────────────────");
const REFUSE = [
  ["an outcome guarantee", "We guarantee your green card will be approved. " + URL],
  ["a win record", "We never lose an asylum case. " + URL],
  ["a success rate", "100% approval rate for our clients. " + URL],
  ["a promise of result", "We will get you a work permit. " + URL],
  ["a Chinese guarantee", "我们保证您一定能通过。 " + URL],
  ["'best immigration lawyer'", "The best immigration lawyer in Los Angeles. " + URL],
  ["a Chinese superlative", "洛杉矶最好的律师事务所。 " + URL],
  ["manufactured urgency", "Act now — limited time to file! " + URL],
  ["Chinese urgency", "抓紧时间，名额有限。 " + URL],
  ["telling a stranger what to file", "You should file an I-485 immediately. " + URL],
  ["speaking to the reader's own case", "Your case will be approved in six months. " + URL],
  ["a free-benefit claim", "Free green card consultation and free green card for you. " + URL],
];
for (const [label, text] of REFUSE) {
  const v = S.screen(text, { channel: "facebook", sourceUrl: URL });
  ok(label, v.ok === false, JSON.stringify(v.problems));
}

console.log("\n── What the screen allows ───────────────────────");
{
  const good = "Leaving the US while an adjustment application is pending can be treated as "
    + "abandoning it, unless advance parole was granted first. Here is what advance parole "
    + `is and when it is issued. ${URL}`;
  const v = S.screen(good, { channel: "facebook", sourceUrl: URL });
  check("a plain, sourced, factual post passes", [v.ok, v.problems], [true, []]);
}
ok("'guarantee' is caught regardless of case", S.screen("We GUARANTEE it. " + URL, { sourceUrl: URL }).ok === false);

console.log("\n── The other tells of a generated post ──────────");
{
  const v = S.screen("Big news 🎉🎊🥳🙌🇺🇸 read on " + URL, { channel: "facebook", sourceUrl: URL });
  ok("emoji soup is refused", !v.ok && v.problems.some(p => /emoji/.test(p)), JSON.stringify(v.problems));
}
{
  const tags = "#a #b #c #d #e #f #g #h #i #j";
  const v = S.screen(`A note about advance parole. ${URL} ${tags}`, { channel: "instagram", sourceUrl: URL });
  ok("a hashtag wall is refused", !v.ok && v.problems.some(p => /hashtag/.test(p)), JSON.stringify(v.problems));
}
{
  const v = S.screen("A perfectly nice post with no link at all.", { channel: "facebook", sourceUrl: URL });
  ok("a post that does not link back is refused", !v.ok && v.problems.some(p => /link back/.test(p)));
}
{
  const long = "x".repeat(1000) + " " + URL;
  const v = S.screen(long, { channel: "instagram", sourceUrl: URL });
  ok("over the channel's limit is refused", !v.ok && v.problems.some(p => /limit/.test(p)), JSON.stringify(v.problems));
  check("…and the same text is fine on LinkedIn", S.screen(long, { channel: "linkedin", sourceUrl: URL }).ok, true);
}
check("empty is refused", S.screen("", { channel: "facebook" }).ok, false);

console.log("\n── It cannot invent ─────────────────────────────");
await throwsA("no source at all is refused", () => S.compose(null), /real URL/);
await throwsA("a source with no URL is refused", () => S.compose({ title: "Something" }), /real URL/);
{
  // The model says the material is too thin. That must produce nothing, not filler.
  const r = await S.composeOne(SOURCE, "facebook", { think: async () => ({ text: "NOTHING TO SAY" }) });
  check("a thin source yields no post", [r.ok, r.skip], [false, true]);
  check("…and says why", r.problems, ["the material does not support a post"]);
}
{
  // A model that ignores the rules must not get through.
  const r = await S.composeOne(SOURCE, "facebook",
    { think: async () => ({ text: "We guarantee approval! " + URL }), tries: 2 });
  check("a non-compliant draft is not returned as ok", r.ok, false);
  ok("…and the reason is reported", r.problems.some(p => /guarantees an outcome/.test(p)), JSON.stringify(r.problems));
  check("…after retrying", r.attempts, 2);
}
{
  // Second attempt fixes it — the retry should be taken.
  let n = 0;
  const think = async () => ({ text: n++ === 0 ? "We guarantee it. " + URL : "Advance parole explained. " + URL });
  const r = await S.composeOne(SOURCE, "facebook", { think, tries: 2 });
  check("a retry that complies is accepted", [r.ok, r.attempts], [true, 2]);
}
{
  const r = await S.composeOne(SOURCE, "facebook",
    { think: async () => ({ text: '"Quoted draft." ' + URL }) });
  ok("wrapping quotes are stripped", r.text.startsWith("Quoted"), r.text);
}

console.log("\n── The prompt is bounded by the material ────────");
{
  const p = S.buildPrompt(SOURCE, "instagram");
  ok("the source is in the prompt", p.includes(SOURCE.summary.slice(0, 40)));
  ok("the link is required", p.includes(URL));
  ok("the channel limit is stated", /900 characters/.test(p));
  ok("inventing is forbidden", /Do not add statistics/.test(p));
  ok("an escape hatch exists", /NOTHING TO SAY/.test(p));
}
check("the Chinese channel asks for Chinese", /简体中文/.test(S.buildPrompt(SOURCE, "wechat_moments")), true);
ok("小红书 is not a channel — JJ does not use it", !S.channelList().includes("xiaohongshu"));

console.log("\n── Nothing posts itself ─────────────────────────");
{
  T.rows = [];
  const think = async () => ({ text: "Advance parole, explained plainly. " + URL });
  const r = await S.queueForSource(SOURCE, { channels: ["facebook", "linkedin"], think, notify: false });
  check("both channels queued", r.queued, 2);
  check("…as pending, not posted", T.rows.map(x => x.status), ["pending", "pending"]);
}
{
  const before = T.rows.find(r => r.channel === "facebook");
  const r = await S.approve(before.id, "JJ");
  check("approving marks it approved", [r.ok, r.status], [true, "approved"]);
  check("…recording who", T.rows.find(x => x.id === before.id).decided_by, "JJ");
  const again = await S.approve(before.id, "JJ");
  check("approving twice is a no-op", again.alreadyDone, true);
}
{
  const li = T.rows.find(r => r.channel === "linkedin" && r.status === "pending");
  check("skipping marks it skipped", (await S.skip(li.id)).ok, true);
  check("…and skipping again does nothing", (await S.skip(li.id)).ok, false);
}
{
  // A post that would now fail the screen must be blocked at approval, not
  // waved through because it passed when it was written.
  T.rows = [];
  T.rows.push({ id: 900, channel: "facebook", text: "We guarantee approval. " + URL,
    source_url: URL, status: "pending", problems: [] });
  const r = await S.approve(900, "JJ");
  check("approval re-screens", [r.ok, r.status], [false, "blocked"]);
  ok("…and says why", r.problems.some(p => /guarantees an outcome/.test(p)));
}
{
  // The delivery hook is where a channel adapter will plug in.
  T.rows = [];
  T.rows.push({ id: 901, channel: "facebook", text: "Advance parole, explained. " + URL,
    source_url: URL, status: "pending", problems: [] });
  let got = null;
  const r = await S.approve(901, "JJ", { deliver: async p => { got = p; return { posted: "fb-1" }; } });
  check("an adapter receives the approved post", [got.channel, got.sourceUrl], ["facebook", URL]);
  check("…and its result is returned", r.delivered, { posted: "fb-1" });
}
{
  T.rows = [];
  T.rows.push({ id: 902, channel: "facebook", text: "Advance parole, explained. " + URL,
    source_url: URL, status: "pending", problems: [] });
  const r = await S.approve(902, "JJ", { deliver: async () => { throw new Error("channel down"); } });
  check("a failing adapter is recorded, not swallowed", [r.ok, r.status, r.error], [false, "error", "channel down"]);
  check("…and the post is not marked approved", T.rows.find(x => x.id === 902).status, "error");
}

console.log("\n── Telegram buttons ─────────────────────────────");
{
  T.rows = [];
  T.rows.push({ id: 910, channel: "facebook", text: "Fine post. " + URL, source_url: URL, status: "pending", problems: [] });
  const r = await S.handleTelegramCallback("soc_go_910", "cb1");
  check("approve button approves", [r.handled, r.action, r.result.status], [true, "go", "approved"]);
}
check("an unrelated callback is left alone", (await S.handleTelegramCallback("wcpost_go_5", "cb2")).handled, false);

console.log("\n── Wiring ───────────────────────────────────────");
{
  const fs = require("fs");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const auto = fs.readFileSync(path.join(__dirname, "..", "autoposter.js"), "utf8");

  ok("the server creates the table at boot", /require\("\.\/social-posts"\)\.initTable\(\)/.test(server));
  ok("…and dispatches the approve/skip buttons", /cb\.data\?\.startsWith\("soc_"\)/.test(server));

  ok("the autoposter drafts from a published post", /social\.queueForSource\(/.test(auto));
  // An English draft behind the Chinese URL would be worse than no draft.
  ok("…English channels use the English link",
    /linkFor\("English"\)[\s\S]{0,400}channels: \["linkedin", "facebook", "instagram"\]/.test(auto));
  ok("…and 朋友圈 uses the Chinese link",
    /linkFor\("中文"\)[\s\S]{0,400}channels: \["wechat_moments"\]/.test(auto));
  // The blog post already succeeded by this point; social must never undo it.
  ok("…and a social failure cannot break the blog post",
    /catch \(soErr\)[\s\S]{0,120}social queue error/.test(auto));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL SOCIAL POST CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
})();
