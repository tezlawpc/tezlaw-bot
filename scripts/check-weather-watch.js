/**
 * check-weather-watch.js — the weather caution posts.
 * db, the model and the weather service are stubbed.
 *   node scripts/check-weather-watch.js
 */
const Module = require("module");
const path = require("path");
let failures = 0;
const ok = (name, cond, detail = "") => { if (!cond) failures++; console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || !detail ? "" : `\n         ${detail}`)); };

const rows = [];
const fakeDb = { async query(q, v = []) {
  if (/SELECT id FROM social_posts WHERE source_url LIKE/.test(q)) return { rows: rows.filter(r => r.source_url.startsWith(v[0].replace("%", ""))).slice(0, 1) };
  if (/^\s*INSERT INTO social_posts/.test(q)) { const id = rows.length + 1; rows.push({ id, channel: v[0], text: v[1], source_url: v[2], media: v[5] && JSON.parse(v[5]), lang: v[6] }); return { rows: [{ id }] }; }
  return { rows: [] };
} };
const CH = { facebook: { name: "Facebook", max: 1500, voice: "", lang: "en" }, instagram: { name: "Instagram", max: 1500, voice: "", lang: "en" },
  linkedin: { name: "LinkedIn", max: 1500, voice: "", lang: "en" }, gbp: { name: "Google Business", max: 1500, voice: "", lang: "en", linkInText: false },
  wechat_moments: { name: "WeChat 朋友圈", max: 600, voice: "", lang: "zh" } };
const prompts = [];
const fakeS = { CHANNELS: CH, CARD_FORMAT: { facebook: "portrait", instagram: "portrait", linkedin: "portrait", gbp: "landscape", wechat_moments: "portrait" },
  initTable: async () => {}, composeOne: async (src, ch, { prompt }) => { prompts.push({ ch, prompt }); return { ok: true, text: `post for ${ch}` }; } };
const o = Module._load;
Module._load = function (r) { if (r === "./db") return fakeDb; if (r === "./social-posts") return fakeS; return o.apply(this, arguments); };
process.env.SOCIAL_POSTS_ENABLED = "true";
const W = require(path.join(__dirname, "..", "weather-watch.js"));

(async () => {
  console.log("Reading the weather");
  ok("a Wind Advisory is wind", W.classify("Wind Advisory") === "wind");
  ok("a Red Flag Warning is fire", W.classify("Red Flag Warning") === "fire");
  ok("a Dense Fog Advisory is fog", W.classify("Dense Fog Advisory") === "fog");
  ok("an Excessive Heat Warning is heat", W.classify("Excessive Heat Warning") === "heat");
  ok("a Flood Watch is rain", W.classify("Flood Watch") === "rain");
  ok("a Small Craft Advisory is ignored", W.classify("Small Craft Advisory") === null);

  const fetch = async url => {
    if (url.includes("alerts/active")) return { features: url.includes("33.6189") ? [] : [{ properties: { event: "Wind Advisory", headline: "Santa Ana winds", ends: "2026-10-01T03:00:00-07:00" } }] };
    if (url.includes("/points/")) return { properties: { forecast: "https://forecast.example/gridpoint" } };
    return { properties: { periods: [{ name: "Tonight", shortForecast: "Rain Showers Likely", probabilityOfPrecipitation: { value: 70 }, endTime: "x" }] } };
  };
  const obs = await W.observe({ fetch });
  const wind = obs.find(x => x.key === "wind"), rain = obs.find(x => x.key === "rain");
  ok("alerts and the forecast are both read", !!wind && !!rain);
  ok("an alert lists every office area it covers", wind && wind.where.join("|") === "West Covina|City of Industry");
  ok("rain in the forecast counts for all three offices", rain && rain.where.length === 3);

  console.log("Queueing");
  const r1 = await W.run({ observed: [wind], notify: false });
  ok("one post per channel, English and Chinese", r1.queued.length === 5 && rows.some(x => x.channel === "wechat_moments" && x.lang === "zh"));
  ok("each carries a Drive safe card", rows.filter(x => x.media && x.media.card).length === 5);
  ok("the Chinese card is in Chinese", rows.find(x => x.lang === "zh").media.card.title === "大风天出行注意");
  const en = prompts.find(p => p.ch === "facebook").prompt, zh = prompts.find(p => p.ch === "wechat_moments").prompt;
  ok("the prompt carries the real alert and the office areas", /Wind Advisory — West Covina, City of Industry/.test(en));
  ok("the prompt gives only the human-written tips", /trucks, vans and RVs/.test(en) && /Do not include any link or phone number/.test(en));
  ok("the Chinese prompt uses the Chinese tips and asks for Simplified Chinese", /卡车/.test(zh) && /Simplified Chinese/.test(zh));
  ok("it never asks for a sales pitch", /NOT an ad/.test(en) && /'call us'/.test(en));

  const r2 = await W.run({ observed: [wind], notify: false });
  ok("the same hazard is not posted again within three days", r2.queued.length === 0);
  const r3 = await W.run({ observed: [rain], notify: false });
  ok("a different hazard still gets its own post", r3.queued.length === 5);

  process.env.SOCIAL_POSTS_ENABLED = "";
  ok("off unless social posts are on", (await W.run({ observed: [rain] })).reason);

  console.log("Wiring");
  const auto = require("fs").readFileSync(path.join(__dirname, "..", "autoposter.js"), "utf8");
  ok("the auto-poster starts the weather watch", /require\("\.\/weather-watch"\)\.start\(\)/.test(auto));

  console.log(failures ? `\n${failures} WEATHER CHECK(S) FAILED` : "\nALL WEATHER CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
