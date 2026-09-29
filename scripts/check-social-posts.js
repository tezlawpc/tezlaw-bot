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
process.env.SOCIAL_VIDEO_ENABLED = "true";
delete process.env.SOCIAL_VIDEOS_PER_WEEK;
delete process.env.SOCIAL_SLOTS;
delete process.env.POSTIZ_API_KEY;
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
      problems: JSON.parse(v[4]), status: "pending", media: v[5] ? JSON.parse(v[5]) : null,
      lang: v[6] || null, media_file: v[7] || null, delivered: null };
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
  if (/^SELECT lang FROM social_posts WHERE channel = 'video'/.test(q)) {
    return { rows: T.rows.filter(r => r.channel === "video").reverse().map(r => ({ lang: r.lang })) };
  }
  if (/^UPDATE social_posts SET delivered/.test(q)) {
    T.rows.find(r => r.id === v[0]).delivered = JSON.parse(v[1]); return { rows: [] };
  }
  if (/^UPDATE social_posts SET media_file = NULL/.test(q)) {
    const r = T.rows.find(x => x.id === v[0]); if (r) r.media_file = null; return { rows: [] };
  }
  if (/^SELECT delivered FROM social_posts/.test(q)) {
    return { rows: T.rows.filter(r => r.delivered).map(r => ({ delivered: r.delivered })) };
  }
  if (/GROUP BY status/.test(q)) {
    const m = {}; for (const r of T.rows) m[r.status] = (m[r.status] || 0) + 1;
    return { rows: Object.entries(m).map(([status, n]) => ({ status, n })) };
  }
  return { rows: [] };
} };

// Postiz, stubbed: records what would have been uploaded and scheduled.
const P = { on: false, calls: [], uploads: [], connected: ["facebook", "instagram", "linkedin", "gbp", "youtube", "tiktok"], failOn: null };
const fakePostiz = {
  PROVIDERS: { facebook: ["facebook"], instagram: ["instagram"], linkedin: ["linkedin-page"], gbp: ["gmb"], youtube: ["youtube"], tiktok: ["tiktok"] },
  configured: () => P.on,
  integrationFor: async ch => P.connected.includes(ch) ? { id: "int-" + ch, identifier: ch === "gbp" ? "gmb" : ch, name: "Tez " + ch } : null,
  upload: async (buf, name, type) => { P.uploads.push({ name, type, bytes: buf.length }); return { id: "up" + P.uploads.length, path: "https://cdn/x/" + name }; },
  schedule: async o => {
    if (P.failOn === o.channel) throw new Error("Postiz HTTP 500: boom");
    P.calls.push(o); return { date: new Date(o.date).toISOString(), postId: "p" + P.calls.length, account: "Tez " + o.channel };
  },
};

const realLoad = Module._load;
Module._load = function (request) {
  if (request === "./db" || request === path.join(__dirname, "..", "db")) return fakeDb;
  if (request === "./postiz") return fakePostiz;
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
ok("a wrong firm name is refused", !S.screen("TezLaw explains advance parole. " + URL, { channel: "facebook", sourceUrl: URL }).ok);
ok("…and so is an invented one", !S.screen("Tez Law Group explains advance parole. " + URL, { channel: "facebook", sourceUrl: URL }).ok);
check("the trade name TEZ Law Firm is fine", S.screen("TEZ Law Firm explains advance parole. " + URL, { channel: "facebook", sourceUrl: URL }).ok, true);
check("…while tezlawfirm.com in a link is fine", S.screen("Tez Law P.C. explains. https://tezlawfirm.com/x", { channel: "facebook", sourceUrl: "https://tezlawfirm.com/x" }).ok, true);
ok("the prompt carries the brand rules", /TEZ Law Firm/.test(S.buildPrompt(SOURCE, "linkedin")) && /Tez Law P\.C\./.test(S.buildPrompt(SOURCE, "linkedin")));

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


console.log("\n── Google Business posts ────────────────────────");
{
  const good = "Leaving the US while an adjustment application is pending can count as abandoning it unless advance parole was granted first.";
  check("a plain GBP post with no link passes", S.screen(good, { channel: "gbp", sourceUrl: URL }).ok, true);
  ok("a web address is refused on GBP", !S.screen(good + " " + URL, { channel: "gbp", sourceUrl: URL }).ok);
  ok("a phone number is refused on GBP", !S.screen(good + " Call 626-678-8677.", { channel: "gbp", sourceUrl: URL }).ok);
  ok("the GBP prompt forbids links", /Do not include any link/.test(S.buildPrompt(SOURCE, "gbp")) && !S.buildPrompt(SOURCE, "gbp").includes("End with the link"));
  ok("the article body reaches the prompt, not just the meta description",
    S.buildPrompt({ ...SOURCE, content: "<p>BODY-MARKER about parole</p>" }, "linkedin").includes("BODY-MARKER"));
}

console.log("\n── Image cards ──────────────────────────────────");
{
  const card = await S.composeCard(SOURCE, "en", { think: async () => ({ text: '{"eyebrow":"Immigration","title":"Travel while a green card is pending","points":["Leaving can abandon the application.","Advance parole comes first."]}' }) });
  check("a card is built from the model's JSON", [card.eyebrow, card.points.length], ["Immigration", 2]);
  const bad = await S.composeCard(SOURCE, "en", { think: async () => ({ text: '{"title":"We guarantee your green card","points":[]}' }) });
  check("a card that fails the screen falls back to the article title", bad.title, SOURCE.title);
  const junk = await S.composeCard(SOURCE, "en", { think: async () => ({ text: "not json" }) });
  check("…and so does a reply that is not JSON", junk.title, SOURCE.title);
  const png = S.renderCard(card, "facebook");
  ok("the card renders to a PNG", png.slice(1, 4).toString() === "PNG" && png.length > 20000, String(png.length));
  const zh = S.renderCard({ eyebrow: "移民", title: "绿卡审理期间出境要注意什么", points: ["未获回美证就出境，申请可能被视为放弃。"], lang: "zh" }, "gbp");
  ok("…Chinese too, landscape for Google Business", zh.readUInt32BE(16) === 1200 && zh.readUInt32BE(20) === 900);
}
{
  T.rows = [];
  let n = 0;
  const think = async p => ({ text: /image card/.test(p) ? '{"eyebrow":"Immigration","title":"Travel and advance parole","points":["Leaving can abandon it."]}'
    : (n++, /Google Business/.test(p) ? "Advance parole, explained plainly." : "Advance parole, explained plainly. " + URL) });
  const r = await S.queueForSource(SOURCE, { channels: ["facebook", "gbp", "linkedin"], think, notify: false });
  check("FB, GBP and LinkedIn queued", r.queued, 3);
  ok("…each with the card attached", T.rows.every(x => x.media && x.media.card && x.media.card.title === "Travel and advance parole"));
}

console.log("\n── Video scripts ────────────────────────────────");
const SCRIPT = {
  title: "Can you travel while your green card is pending?",
  caption: "What advance parole is, and why leaving without it can end an application.",
  tags: ["green card", "advance parole", "immigration"],
  scenes: [
    { text: "Can you leave the U.S. while a green card application is pending?", say: "Can you leave the United States while a green card application is pending?" },
    { text: "Leaving can be treated as abandoning the application.", say: "Leaving can be treated as abandoning the application." },
    { text: "Unless advance parole was granted first.", say: "Unless advance parole was granted before you left." },
    { text: "Full article at tezlawfirm.com", say: "The full article is at tez law firm dot com." },
  ],
};
{
  const c = S.checkScript(SCRIPT, "en");
  check("a sound script passes", [c.ok, c.problems], [true, []]);
  ok("too few scenes is refused", !S.checkScript({ ...SCRIPT, scenes: SCRIPT.scenes.slice(0, 2) }, "en").ok);
  ok("a narrator speaking as the lawyer is refused",
    S.checkScript({ ...SCRIPT, scenes: [...SCRIPT.scenes, { text: "x", say: "I'm an attorney and I can help." }] }, "en").problems.some(p => /speaks as the attorney/.test(p)));
  ok("…in Chinese too", !S.checkScript({ ...SCRIPT, scenes: [...SCRIPT.scenes, { text: "我是律师，我来告诉你" }] }, "zh").ok);
  ok("a guarantee anywhere in the script is refused",
    !S.checkScript({ ...SCRIPT, caption: "We guarantee approval." }, "en").ok);
  ok("narration over ~50 seconds is refused",
    S.checkScript({ ...SCRIPT, scenes: SCRIPT.scenes.map(x => ({ ...x, say: "word ".repeat(45) })) }, "en").problems.some(p => /too long/.test(p)));
  const r = await S.composeVideoScript(SOURCE, "en", { think: async () => ({ text: "```json\n" + JSON.stringify({ ...SCRIPT, caption: SCRIPT.caption + " https://evil.example" }) + "\n```" }) });
  ok("the composer reads fenced JSON", r.ok, JSON.stringify(r.problems));
  ok("…strips any URL the model put in the caption", !/evil/.test(r.script.caption));
  const yt = S.videoCaption(r.script, "youtube"), tt = S.videoCaption(r.script, "tiktok");
  ok("the YouTube description links the article", yt.includes(URL));
  ok("…and both say the narration is AI-generated", /AI-generated/.test(yt) && /AI-generated/.test(tt));
  ok("the video prompt keeps the narrator from speaking as the attorney", /never speak as a lawyer/.test(S.buildVideoPrompt(SOURCE, "en")));
  {
    const M = require("../social-media");
    const end = M.slide({ text: M.DISCLAIMER.en, kind: "end" });
    ok("the closing slide renders with the logo", end.length > 40000, String(end.length));
    ok("brand fonts measure text (Cormorant is narrower than Montserrat)",
      M.measure("Protect your rights", { latin: "cormorant", cjk: "serifBold" }, 40) < M.measure("Protect your rights", { latin: "montserrat", cjk: "serif" }, 40));
  }
  ok("the closing slide says the voice is AI-generated", /AI-generated/.test(require("../social-media").DISCLAIMER.en) && /AI合成/.test(require("../social-media").DISCLAIMER.zh));
}

console.log("\n── Videos: weekly cap and language ──────────────");
{
  T.rows = [];
  const fs = require("fs"), os = require("os");
  const render = async () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-")); const file = path.join(dir, "v.mp4"); fs.writeFileSync(file, Buffer.alloc(1000, 1)); return { file, dir, seconds: 31 }; };
  const ZH_SCRIPT = { title: "绿卡审理期间可以出境吗？", caption: "什么是回美证，没有它就出境为什么可能导致申请被放弃。", tags: ["绿卡", "回美证"],
    scenes: [{ text: "绿卡审理期间可以出境吗？" }, { text: "出境可能被视为放弃申请。" }, { text: "除非事先获得回美证。" }, { text: "完整文章请见 tezlawfirm.com" }] };
  const think = async p => ({ text: JSON.stringify(/简体中文/.test(p) ? ZH_SCRIPT : SCRIPT) });
  const ZH = { title: "绿卡", url: "https://tezlawfirm.com/zh-post", summary: "回美证" };
  const a = await S.queueVideo({ en: SOURCE, zh: ZH }, { think, render, notify: false });
  const b = await S.queueVideo({ en: SOURCE, zh: ZH }, { think, render, notify: false });
  check("two videos are queued", [a.queued, b.queued], [1, 1]);
  check("…alternating languages", [a.lang, b.lang], ["en", "zh"]);
  const c = await S.queueVideo({ en: SOURCE, zh: ZH }, { think, render, notify: false });
  ok("a third in the same week is refused", c.queued === 0 && /weekly limit/.test(c.reason), c.reason);
  const row = T.rows.find(x => x.id === a.id);
  check("the video waits for approval", [row.channel, row.status, !!row.media_file], ["video", "pending", true]);
  process.env.SOCIAL_VIDEO_ENABLED = "false";
  ok("nothing is made when videos are off", (await S.queueVideo({ en: SOURCE }, { think, render })).queued === 0);
  process.env.SOCIAL_VIDEO_ENABLED = "true";
}

console.log("\n── Time slots (Pacific) ─────────────────────────");
{
  const pt = d => new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" });
  // Monday 29 Sep 2026, 9:00 PT
  const mon = S.laToDate(2026, 9, 29 - 1, 9, 0).getTime();
  check("9:00 PT Monday converts correctly (PDT, UTC-7)", new Date(mon).toISOString(), "2026-09-28T16:00:00.000Z");
  check("winter time is UTC-8", S.laToDate(2026, 12, 1, 10, 0).toISOString(), "2026-12-01T18:00:00.000Z");
  check("LinkedIn goes Tuesday 8:30", pt(S.nextSlot("linkedin", [], mon)), "Tue 8:30 AM");
  check("Google Business later the same Monday", pt(S.nextSlot("gbp", [], mon)), "Mon 10:00 AM");
  const tue = S.nextSlot("linkedin", [], mon);
  check("…a second LinkedIn post takes the next open day", pt(S.nextSlot("linkedin", [tue], mon)), "Wed 8:30 AM");
  check("a slot less than 20 minutes away is skipped", pt(S.nextSlot("gbp", [], S.laToDate(2026, 9, 28, 9, 50).getTime())), "Wed 10:00 AM");
}

console.log("\n── Approval schedules through Postiz ────────────");
{
  T.rows = []; P.on = true; P.calls = []; P.uploads = [];
  T.rows.push({ id: 920, channel: "instagram", text: "Advance parole, explained. " + URL, source_url: URL, source_title: SOURCE.title,
    status: "pending", problems: [], media: { card: { eyebrow: "Immigration", title: "Advance parole", points: [], lang: "en" } } });
  const r = await S.approve(920, "JJ");
  check("approving schedules it", [r.ok, r.status], [true, "approved"]);
  check("…with the card uploaded as a PNG", P.uploads.map(u => u.type), ["image/png"]);
  check("…to Instagram, as a future scheduled post", [P.calls[0].channel, new Date(P.calls[0].date) > new Date()], ["instagram", true]);
  ok("…and where it went is recorded", T.rows[0].delivered.instagram.postId === "p1");
  check("approving again does not post twice", [(await S.approve(920)).alreadyDone, P.calls.length], [true, 1]);
}
{
  // Approved while Postiz was not set up: only the paste text came back.
  // Once Postiz is on, tapping Approve again schedules it — once.
  T.rows = []; P.on = false; P.calls = []; P.uploads = [];
  T.rows.push({ id: 925, channel: "facebook", text: "Advance parole, explained. " + URL, source_url: URL, source_title: SOURCE.title,
    status: "pending", problems: [] });
  check("approved with Postiz off: nothing is scheduled", [(await S.approve(925)).status, P.calls.length], ["approved", 0]);
  check("…and re-tapping while still off does nothing", (await S.approve(925)).alreadyDone, true);
  P.on = true;
  const r = await S.approve(925, "JJ");
  check("once Postiz is on, re-tapping schedules it", [r.ok, P.calls.map(c => c.channel)], [true, ["facebook"]]);
  check("…and a third tap does not post twice", [(await S.approve(925)).alreadyDone, P.calls.length], [true, 1]);
}
{
  // WeChat Moments has no Postiz provider: approving hands back the text to
  // paste rather than failing, even with Postiz switched on.
  T.rows = []; P.on = true; P.calls = []; P.uploads = [];
  T.rows.push({ id: 926, channel: "wechat_moments", text: "移民小知识：回美证。" + URL, source_url: URL, source_title: SOURCE.title,
    status: "pending", problems: [] });
  const r = await S.approve(926, "JJ");
  check("WeChat Moments approves as paste text, not a Postiz error", [r.ok, r.status, P.calls.length], [true, "approved", 0]);
  check("…and Postiz can't deliver WeChat, but can deliver Facebook", [S.postizCanDeliver("wechat_moments"), S.postizCanDeliver("facebook")], [false, true]);
}
{
  // WeChat gets a Chinese image card to save with the text.
  const png = S.renderCard({ eyebrow: "法律常识", title: "美国移民局2026政策提醒：贩运不可入境规定", points: [], lang: "zh" }, "wechat_moments");
  ok("a Chinese WeChat card renders to a PNG", Buffer.isBuffer(png) && png.length > 10000 && png.slice(1, 4).toString() === "PNG");
  // Google Business is a Postiz channel, but not connected: paste text, no error.
  T.rows = []; P.on = true; P.calls = []; P.uploads = [];
  const saved = P.connected; P.connected = saved.filter(c => c !== "gbp");
  T.rows.push({ id: 927, channel: "gbp", text: "Traveling on a pending green card? Advance parole explained, in plain terms, on our website.", source_url: URL, source_title: SOURCE.title,
    status: "pending", problems: [] });
  const r = await S.approve(927, "JJ");
  check("an unconnected Postiz channel approves as paste text, not an error", [r.ok, r.status, P.calls.length], [true, "approved", 0]);
  P.connected = saved;
}
{
  T.rows = []; P.calls = []; P.uploads = []; P.failOn = "tiktok";
  T.rows.push({ id: 930, channel: "video", text: S.videoCaption({ ...SCRIPT, lang: "en", url: URL }, "youtube"), source_url: URL,
    status: "pending", problems: [], media: { script: { ...SCRIPT, lang: "en", url: URL }, targets: ["youtube", "tiktok"] }, media_file: Buffer.alloc(500, 2) });
  const r1 = await S.approve(930, "JJ");
  check("a TikTok failure is reported", [r1.ok, r1.status], [false, "error"]);
  check("…after YouTube was scheduled", P.calls.map(c => c.channel), ["youtube"]);
  check("…with the YouTube title set", P.calls[0].meta.title, SCRIPT.title);
  P.failOn = null;
  const r2 = await S.approve(930, "JJ");
  check("retrying finishes TikTok only", [r2.ok, P.calls.map(c => c.channel)], [true, ["youtube", "tiktok"]]);
  check("…uploading the video just once per attempt", P.uploads.filter(u => u.type === "video/mp4").length, 2);
  check("…and the stored video is released afterwards", T.rows[0].media_file, null);
  ok("TikTok's text says tezlawfirm.com, not a long link", /tezlawfirm\.com/.test(P.calls[1].content) && !P.calls[1].content.includes(URL));
}
{
  T.rows = []; P.calls = []; P.connected = ["youtube"];
  T.rows.push({ id: 940, channel: "video", text: "Video. " + URL, source_url: URL, status: "pending", problems: [],
    media: { script: { ...SCRIPT, lang: "en", url: URL }, targets: ["youtube", "tiktok"] }, media_file: Buffer.alloc(10) });
  const r = await S.approve(940, "JJ");
  check("an unconnected platform is skipped, not failed", [r.ok, r.delivered.tiktok.skipped], [true, "not connected in Postiz"]);
  P.connected = ["facebook", "instagram", "linkedin", "gbp", "youtube", "tiktok"]; P.on = false;
}

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
    /linkFor\("English"\)[\s\S]{0,400}channels: \["linkedin", "facebook", "instagram", "gbp"\]/.test(auto));
  ok("…and 朋友圈 uses the Chinese link",
    /linkFor\("中文"\)[\s\S]{0,400}channels: \["wechat_moments"\]/.test(auto));
  // The blog post already succeeded by this point; social must never undo it.
  ok("…videos are queued from the same article",
    /social\.queueVideo\(vsrc\)/.test(auto));
  ok("…in the background, so a slow render cannot hold up the blog post",
    /social\.queueVideo\(vsrc\)\s*\.then\(/.test(auto));
  ok("…and a social failure cannot break the blog post",
    /catch \(soErr\)[\s\S]{0,120}social queue error/.test(auto));
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL SOCIAL POST CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
})();
