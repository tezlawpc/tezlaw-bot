// ============================================================
//  weather-watch.js — safe-driving posts when the weather turns
//  TEZ Law Firm
//  ─────────────────────────────────────────────────────────
//  JJ: "if there are major weather changes locally, make caution posts
//  about driving and traveling for personal injury cases."
//
//  Every three hours in the daytime this reads the National Weather Service
//  for the three office areas (West Covina, City of Industry, Newport Beach):
//  active alerts (wind, fog, heat, fire weather, flooding, mountain snow,
//  dust) and the forecast (rain in the next day and a half). When something
//  new shows up, it drafts a short caution post and queues it for JJ like
//  every other post. Nothing goes out without his tap.
//
//  Same rule as the holiday and fun-fact banks: THE SAFETY ADVICE IS WRITTEN
//  BY A HUMAN (below). The model picks the words and weaves in the real
//  forecast; it may not invent tips, statistics or legal rules.
//
//  One post per hazard per three days, so a week of Santa Ana winds is one
//  post, not twelve.
// ============================================================

const axios = require("axios");
const db = require("./db");

const POINTS = [
  { name: "West Covina", lat: 34.0686, lon: -117.939 },
  { name: "City of Industry", lat: 34.0197, lon: -117.9587 },
  { name: "Newport Beach", lat: 33.6189, lon: -117.9298 },
];
const UA = { "User-Agent": "TEZ Law Firm weather-watch (jj@tezlawfirm.com)", Accept: "application/geo+json" };
const CHANNELS = ["facebook", "instagram", "linkedin", "gbp", "wechat_moments"];
const QUIET_DAYS = 3;

// The advice. Plain, well-established safety guidance only.
const HAZARDS = {
  rain: {
    match: /flood|flash flood|heavy rain|thunderstorm|atmospheric river|winter storm/i,
    title: "Rain on the roads", zhTitle: "雨天行车安全",
    tips: [
      "Slow down and leave extra space; stopping takes longer on wet pavement.",
      "The first rain after a dry spell is the slickest, because oil on the road floats up.",
      "In California, headlights must be on whenever your wipers are running.",
      "Never drive into a flooded street. Turn around.",
    ],
    zhTips: ["放慢车速，拉大车距，湿滑路面刹车距离更长。", "久旱后的第一场雨路面最滑，路上的油污会浮起来。", "在加州，只要开着雨刷就必须开大灯。", "切勿驶入积水路段，请掉头绕行。"],
  },
  wind: {
    match: /wind|santa ana/i,
    title: "High winds today", zhTitle: "大风天出行注意",
    tips: [
      "Keep both hands on the wheel, especially on freeway overpasses and canyon roads.",
      "Give trucks, vans and RVs extra room; wind pushes them across lanes.",
      "Watch for fallen branches and downed power lines. Stay far away from any line.",
      "Traffic lights may be out. Treat a dark signal as an all-way stop.",
    ],
    zhTips: ["双手握紧方向盘，经过高架桥和峡谷路段时尤其注意。", "与卡车、厢型车和房车保持更远距离，大风会把它们吹偏车道。", "留意掉落的树枝和倒下的电线，远离任何电线。", "红绿灯可能停电，遇到不亮的信号灯按四向停车处理。"],
  },
  fog: {
    match: /fog/i,
    title: "Dense fog this morning", zhTitle: "大雾行车安全",
    tips: [
      "Use low beams, not high beams; high beams reflect off the fog.",
      "Slow down well before you lose sight of the car ahead.",
      "Keep more distance than you think you need.",
      "If you have to pull over, get fully off the road and turn on your hazards.",
    ],
    zhTips: ["使用近光灯，不要开远光灯，远光会被雾反射。", "看不清前车之前就要提前减速。", "保持比平时更大的车距。", "如需停车，请完全驶离车道并打开双闪。"],
  },
  heat: {
    match: /heat/i,
    title: "Extreme heat", zhTitle: "高温天出行注意",
    tips: [
      "Never leave children or pets in a parked car, even for a minute.",
      "Check tire pressure; heat and underinflated tires are a bad mix.",
      "Carry water on longer drives, and plan for traffic.",
      "Watch your temperature gauge and pull over safely if the engine overheats.",
    ],
    zhTips: ["切勿把孩子或宠物留在停着的车内，哪怕一分钟。", "检查胎压，高温加上胎压不足很危险。", "长途出行带足饮用水，预留堵车时间。", "留意水温表，发动机过热时安全靠边停车。"],
  },
  fire: {
    match: /red flag|fire weather|fire warning|evacuation|smoke/i,
    title: "Fire weather", zhTitle: "山火天气注意",
    tips: [
      "Keep your gas tank at least half full in case you need to leave quickly.",
      "Follow evacuation orders right away, even before you can see flames.",
      "Smoke cuts visibility suddenly. Slow down and use low beams.",
      "Never toss anything that burns from a car, and don't park on dry grass.",
    ],
    zhTips: ["油箱保持至少半满，以便随时撤离。", "接到疏散令请立即撤离，不要等看到火才走。", "烟雾会让能见度骤降，请减速并开近光灯。", "不要从车内丢弃任何可燃物，也不要把车停在干草上。"],
  },
  snow: {
    match: /winter weather|snow|blizzard|ice/i,
    title: "Snow in the mountains", zhTitle: "山区降雪出行注意",
    tips: [
      "Heading to the mountains? Carry chains; they can be required on short notice.",
      "Check road conditions and closures before you leave.",
      "Slow down on bridges and shaded curves, where ice forms first.",
      "Keep water, a blanket and a charged phone in the car.",
    ],
    zhTips: ["去山区请随车携带防滑链，可能随时要求安装。", "出发前查看路况和封路信息。", "桥面和背阴弯道最先结冰，请减速。", "车上备好饮用水、毯子和充满电的手机。"],
  },
  dust: {
    match: /dust|blowing dust/i,
    title: "Blowing dust", zhTitle: "沙尘天行车注意",
    tips: [
      "If visibility drops, pull off the road, turn off your lights and keep your foot off the brake.",
      "Close windows and set the air to recirculate.",
      "Give yourself extra time and distance.",
    ],
    zhTips: ["能见度骤降时驶离路面，关灯并松开刹车踏板。", "关闭车窗，空调设为内循环。", "预留更多时间和车距。"],
  },
};
// Order matters where an alert could match two (a winter storm is rain here).
const ORDER = ["fire", "rain", "wind", "fog", "heat", "snow", "dust"];

const AFTER_A_CRASH = "If a crash does happen: get to safety, call 911 if anyone is hurt, take photos, and exchange information. Get checked by a doctor, and talk to a lawyer before giving a recorded statement to an insurance company.";
const AFTER_A_CRASH_ZH = "万一发生车祸：先确保安全，有人受伤请拨打911，拍照留证并交换信息。请尽快就医，在向保险公司做录音陈述前先咨询律师。";

function classify(text) {
  for (const k of ORDER) if (HAZARDS[k].match.test(text)) return k;
  return null;
}

async function get(url) {
  const r = await axios.get(url, { headers: UA, timeout: 20000 });
  return r.data;
}

/** What's happening now: { key → { what, where[], when } } from alerts and forecast. */
async function observe({ fetch = get } = {}) {
  const found = {};
  const note = (key, what, where, when) => {
    if (!key) return;
    const f = found[key] || (found[key] = { key, what, where: [], when });
    if (!f.where.includes(where)) f.where.push(where);
  };
  for (const p of POINTS) {
    try {
      const a = await fetch(`https://api.weather.gov/alerts/active?point=${p.lat},${p.lon}`);
      for (const f of (a.features || [])) {
        const pr = f.properties || {};
        if (/test|statement$/i.test(pr.event || "") && !/special weather/i.test(pr.event || "")) continue;
        note(classify(`${pr.event} ${pr.headline || ""}`), pr.event, p.name, pr.ends || pr.expires || null);
      }
    } catch (e) { console.warn(`[weather] alerts ${p.name}:`, e.message); }
    try {
      const pt = await fetch(`https://api.weather.gov/points/${p.lat},${p.lon}`);
      const fc = await fetch(pt.properties.forecast);
      for (const per of (fc.properties.periods || []).slice(0, 3)) {
        const pop = (per.probabilityOfPrecipitation || {}).value || 0;
        if (pop >= 50 && /rain|shower|thunder/i.test(per.shortForecast || "")) {
          note("rain", `${per.shortForecast} (${pop}% chance), ${per.name}`, p.name, per.endTime);
        }
      }
    } catch (e) { console.warn(`[weather] forecast ${p.name}:`, e.message); }
  }
  return Object.values(found);
}

function buildPrompt(h, obs, ch) {
  const zh = ch.lang === "zh";
  const hz = HAZARDS[h];
  return [
    `Write one ${ch.name} post for TEZ Law Firm, a law firm with offices in West Covina, City of Industry and Newport Beach, California.`,
    "",
    "Purpose: a neighborly safety reminder about today's weather. Helpful first. It is NOT an ad for accident cases.",
    "",
    ch.voice,
    "",
    "WHAT THE NATIONAL WEATHER SERVICE SAYS (use this for the opening; don't add details it doesn't give):",
    `${obs.what} — ${obs.where.join(", ")}`,
    "",
    "SAFETY ADVICE — use only these, in your own words, two or three of them:",
    ...(zh ? hz.zhTips : hz.tips).map(t => `  · ${t}`),
    "",
    "Close with this idea, briefly, in your own words:",
    zh ? AFTER_A_CRASH_ZH : AFTER_A_CRASH,
    "",
    "DO NOT: invent statistics or other tips; mention settlements, compensation, or 'your case'; say 'call us' or 'we can help'; frighten people; use more than two emoji.",
    zh ? "Write in Simplified Chinese." : "",
    `Hard limit: ${ch.max} characters. Do not include any link or phone number.`,
    "",
    "Output only the post text.",
  ].filter(x => x !== "").join("\n");
}

/**
 * Check the weather and queue a post for anything new. `observed` and `think`
 * are injectable for the checks.
 */
async function run({ observed = null, think = null, notify = true } = {}) {
  if (String(process.env.SOCIAL_POSTS_ENABLED || "") !== "true") return { queued: 0, reason: "SOCIAL_POSTS_ENABLED is not true" };
  const S = require("./social-posts");
  await S.initTable();
  const obs = observed || await observe();
  const out = { hazards: [], queued: [], rejected: [] };

  for (const o of obs) {
    const recent = await db.query(
      `SELECT id FROM social_posts WHERE source_url LIKE $1 AND created_at > NOW() - ($2 || ' days')::interval LIMIT 1`,
      [`weather:${o.key}:%`, String(QUIET_DAYS)]);
    if (recent.rows.length) continue;
    out.hazards.push(o.key);
    const hz = HAZARDS[o.key];
    const tag = `weather:${o.key}:${new Date().toISOString().slice(0, 10)}`;
    for (const channel of CHANNELS) {
      const ch = S.CHANNELS[channel];
      if (!ch) continue;
      const zh = ch.lang === "zh";
      let d;
      try { d = await S.composeOne({ url: "", title: hz.title }, channel, { think, prompt: buildPrompt(o.key, o, ch) }); }
      catch (e) { out.rejected.push({ channel, problems: [e.message] }); continue; }
      if (!d.ok) { out.rejected.push({ channel, problems: d.problems }); continue; }
      const card = S.CARD_FORMAT[channel] ? { card: {
        eyebrow: zh ? "安全出行" : "Drive safe",
        title: zh ? hz.zhTitle : hz.title,
        points: (zh ? hz.zhTips : hz.tips).slice(0, 3),
        lang: zh ? "zh" : "en" } } : null;
      const r = await db.query(
        `INSERT INTO social_posts (channel, text, source_url, source_title, problems, media, lang)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING id`,
        [channel, d.text, tag, `${zh ? hz.zhTitle : hz.title} · ${o.where.join(", ")}`,
          JSON.stringify(d.problems || []), card ? JSON.stringify(card) : null, zh ? "zh" : "en"]);
      out.queued.push({ id: r.rows[0].id, channel });
    }
  }

  if (notify && out.queued.length) {
    const R = require("./social-resend");
    await R.send([`🌦 Weather caution posts — ${out.hazards.map(k => HAZARDS[k].title).join(", ")}`,
      "From the National Weather Service for our office areas. Approve the ones you want; posting soon matters for weather."].join("\n"));
    await R.resend({ days: 1 });
  }
  return out;
}

/** Every three hours from 6 AM to 6 PM Pacific. */
function start() {
  const tick = async () => {
    const h = Number(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }));
    if (h < 6 || h > 18) return;
    try {
      const r = await run();
      if (r.queued && r.queued.length) console.log(`[weather] queued ${r.queued.length} post(s): ${r.hazards.join(", ")}`);
    } catch (e) { console.warn("[weather] run failed:", e.message); }
  };
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, 3 * 60 * 60 * 1000);
  console.log("🌦 Weather watch on: NWS alerts + forecast for West Covina, City of Industry, Newport Beach, every 3 hours");
}

module.exports = { HAZARDS, POINTS, classify, observe, buildPrompt, run, start };
