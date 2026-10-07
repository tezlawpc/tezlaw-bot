// ============================================================
//  TEZ LAW P.C. — SOCIAL POSTS
//
//  JJ on Sintra: "its too fake and not tailored for tez."
//
//  That is a content problem, not a tooling problem. A generic marketing bot
//  invents a topic and writes around it. This writes only from material the
//  firm actually produced — a published post, a development the legal digest
//  picked up — so every claim traces back to something on tezlawfirm.com, and
//  every post links there.
//
//  Three deliberate limits, because this is a law firm and not a SaaS:
//
//  1. NOTHING IS INVENTED. compose() takes a source with a real URL. No source,
//     no post. It cannot free-associate about immigration news it half-knows.
//
//  2. EVERY DRAFT IS SCREENED before it is offered, by `screen()` below —
//     deterministic rules, not a second opinion from the model that wrote it.
//     A model asked "is this compliant?" will usually say yes. Outcome
//     guarantees, superlatives, fake urgency and anything that reads as advice
//     to a stranger are rejected outright; the post is regenerated or dropped.
//
//  3. NOTHING POSTS ITSELF. Everything waits for JJ in Telegram, same as the
//     WeChat path. Approval hands back finished text to paste, and a `deliver`
//     hook is where a channel adapter plugs in later — so composition never
//     has to change when a channel is finally connected.
//
//  Since the Postiz build: approved posts go out by themselves, through
//  Postiz (postiz.js), at the next open time slot for that channel. The
//  approval tap is still the only way anything leaves. Facebook, Instagram,
//  LinkedIn and Google Business posts carry a branded image card; a weekly
//  explainer video (social-media.js) goes to YouTube Shorts and TikTok.
//
//  Compliance grounding: California Rules of Professional Conduct 7.1 (no
//  false or misleading communication about services) and 7.2 (advertising).
//  The screen is a first line, not counsel — JJ reads every one before it goes
//  out, which is the point of the approval gate.
// ============================================================

const db = require("./db");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const JJ_TELEGRAM_ID = process.env.JJ_TELEGRAM_ID;
const FIRM = process.env.FIRM_NAME || "Tez Law P.C.";

// Off until JJ turns it on, like the WeChat path before it.
const ENABLED = String(process.env.SOCIAL_POSTS_ENABLED || "") === "true";

// ── Channels ────────────────────────────────────────────────
//
// Length limits are the real constraint on each platform; tone is the rest.
// 小红书 is deliberately absent — JJ does not use it.
const CHANNELS = {
  linkedin: {
    name: "LinkedIn",
    max: 2800,
    lang: "en",
    voice: "Other lawyers, accountants and referral sources are reading, and "
      + "they can tell the difference between insight and content. Give them "
      + "the thing they did not already know: a procedural wrinkle, a misread "
      + "rule, a number that surprises. No hype, no thought-leader "
      + "throat-clearing.",
  },
  facebook: {
    name: "Facebook",
    max: 1200,
    lang: "en",
    voice: "Neighbours in the San Gabriel Valley. Warm, plain-spoken, short "
      + "paragraphs, zero jargon; if a term is unavoidable, say what it means "
      + "in the same breath. Explain the thing itself, never why to hire a "
      + "lawyer. Write it the way you would explain it to a friend at dinner "
      + "who asked a real question.",
  },
  instagram: {
    name: "Instagram",
    max: 900,
    lang: "en",
    voice: "Short. One idea, landed hard. Line breaks, not paragraphs: the "
      + "first line has to earn the second. Lead with the surprise. A handful "
      + "of specific hashtags at the end, never a wall of them.",
  },
  gbp: {
    name: "Google Business",
    max: 1400,
    lang: "en",
    linkInText: false,
    voice: "Someone who just searched for an answer and found the firm on "
      + "Maps. Two to four short, plain sentences that actually resolve one "
      + "question, because they arrived with one. Do NOT put a "
      + "web address or phone number in the text: Google rejects posts that "
      + "do, and a Learn more button carries the link.",
  },
  wechat_moments: {
    name: "WeChat 朋友圈",
    max: 600,
    lang: "zh",
    voice: "简体中文。写给在美国的华人移民读者，多半在南加州。像朋友聊天一样，"
      + "温和、具体、有人情味。讲一件大家常常弄错的事，并说清楚为什么。"
      + "不用营销口号，不夸张，不承诺结果。",
  },
};

function channelList() {
  return Object.keys(CHANNELS);
}

// ── The compliance screen ───────────────────────────────────
//
// Deterministic, and applied to what the model produced rather than asked of
// it. Each pattern is here because it is the kind of line that gets a lawyer
// in front of the State Bar, not because it sounds bad.

const BANNED = [
  // Outcome guarantees — the classic advertising violation.
  { re: /\b(guarantee|guaranteed|guarantees)\b/i, why: "guarantees an outcome" },
  { re: /\b(we|i)\s+(always|never)\s+(win|lose)\b/i, why: "claims a win record" },
  { re: /\b100%\s*(success|approval|win)/i, why: "claims a success rate" },
  { re: /\bno\s+risk\b/i, why: "claims there is no risk" },
  { re: /\bwill\s+(win|get you|be approved)\b/i, why: "promises a result" },
  { re: /保证|百分之百|一定(能|会)(成功|通过|赢)/, why: "promises a result (Chinese)" },
  // Superlatives a firm cannot substantiate.
  { re: /\b(best|top|#\s?1|number one|leading)\s+(immigration\s+)?(lawyer|attorney|law firm)\b/i,
    why: "unsubstantiated superlative" },
  { re: /最(好|佳|强)的?(律师|律所)/, why: "unsubstantiated superlative (Chinese)" },
  // Manufactured urgency — the thing that makes marketing feel fake, and
  // with immigration deadlines it is also cruel.
  { re: /\b(act now|don'?t wait|limited time|last chance|hurry)\b/i, why: "manufactured urgency" },
  { re: /抓紧时间|最后机会|名额有限/, why: "manufactured urgency (Chinese)" },
  // Specific advice to a stranger reads as forming a relationship.
  { re: /\byou\s+should\s+(file|apply|sue|appeal)\b/i, why: "tells the reader what to file" },
  { re: /\byour\s+case\s+(will|is)\b/i, why: "speaks to the reader's own case" },
  // Fee claims that invite trouble if not carefully qualified.
  { re: /\bfree\s+(green\s?card|visa|citizenship)\b/i, why: "implies a free immigration benefit" },
];

// A post that never names the firm is not marketing, and one with no link
// cannot be checked by the reader.
function screen(text, { channel = "", sourceUrl = "" } = {}) {
  const problems = [];
  const s = String(text || "");
  if (!s.trim()) return { ok: false, problems: ["empty"] };

  for (const b of BANNED) if (b.re.test(s)) problems.push(b.why);

  const ch = CHANNELS[channel];
  if (ch && s.length > ch.max) problems.push(`over ${ch.name}'s ${ch.max}-character limit (${s.length})`);
  if (ch && ch.linkInText === false) {
    if (/https?:\/\/|www\.|\.com\b/i.test(s)) problems.push(`${ch.name} posts cannot contain a web address`);
    if (/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(s)) problems.push(`${ch.name} posts cannot contain a phone number`);
  } else if (sourceUrl && !s.includes(sourceUrl)) problems.push("does not link back to the source");

  // The firm's name: TEZ Law Firm (trade name) or Tez Law P.C. (legal name), nothing else.
  if (/\bTezLaw\b(?!firm)|\bTez\s+Legal\b|\bTez\s+Law\s+(Group|Office|Offices|LLP|LLC|Inc)\b/i.test(s.replace(/https?:\/\/\S+|tezlawfirm\.com|tez\s*law\s*firm\s*(dot\s*com|\.\s*com)/gi, "")))
    problems.push("firm name not written as TEZ Law Firm or Tez Law P.C.");

  // Emoji soup is the tell of a generated post. A couple is fine.
  // The range starts at 1F000, not 1F300, so regional-indicator flags (🇺🇸 is
  // a pair of them, at 1F1E6-1F1FF) are counted rather than slipping past.
  const emoji = (s.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu) || []).length;
  if (emoji > 4) problems.push(`${emoji} emoji — reads as generated`);

  // Hashtag walls, likewise.
  const tags = (s.match(/#[\w一-鿿]+/g) || []).length;
  if (tags > 8) problems.push(`${tags} hashtags`);

  return { ok: problems.length === 0, problems };
}

// ── Composing ───────────────────────────────────────────────

// The meta description alone is too thin to write from; the article body is
// what the post is about.
function material(source, max = 6000) {
  const strip = h => String(h || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const parts = [strip(source.summary), strip(source.content)].filter(Boolean);
  if (parts.length === 2 && parts[1].startsWith(parts[0])) parts.shift();
  return parts.join("\n\n").slice(0, max);
}

/**
 * What the post is FOR comes before what it must avoid.
 *
 * The earlier version opened with a wall of prohibitions and asked only that
 * the post be "built from the material". Both together produced exactly one
 * kind of post: a hedged summary of the article, opening "Navigating X can be
 * complex" and closing "contact us to learn more". Nobody reads those,
 * including the person who wrote them.
 *
 * The fix is not to loosen the rules — every compliance line below is still
 * here, unchanged, because they are the lines that put a lawyer in front of
 * the State Bar. The fix is to say what a good post DOES: teach one specific
 * thing, usually the part people get wrong, in the voice of a person who
 * finds it interesting. The prohibitions then act as a fence rather than as
 * the brief.
 */
function buildPrompt(source, channel) {
  const ch = CHANNELS[channel];
  return [
    `Write one ${ch.name} post for ${FIRM}, a law firm in West Covina, California.`,
    "",
    "THE JOB: teach the reader ONE specific thing they could repeat to a friend",
    "tonight. Best of all is the thing people usually get wrong — a rule that",
    "is not the rule, a deadline that is not the deadline, a form that does",
    "something other than what its name suggests. Interesting and true beats",
    "comprehensive. One idea, fully landed, beats four mentioned.",
    "",
    ch.voice,
    "",
    "HOW IT READS: like a person who finds this genuinely interesting telling",
    "you about it, not like a firm publishing. Open on the surprising part —",
    "never on the topic. Contractions are good. Short sentences are good. A",
    "concrete number, date or example from the material is what makes it stick.",
    "",
    "DO NOT WRITE, in any wording:",
    "  · \"Navigating X can be complex/confusing/overwhelming\"",
    "  · \"Understanding X is important\" or \"X can be daunting\"",
    "  · \"At TEZ Law Firm, we...\" or any description of the firm's services",
    "  · an opening rhetorical question (\"Did you know...?\", \"Ever wondered...?\")",
    "  · \"Contact us today\", \"reach out to learn more\", \"we're here to help\"",
    "  · a list of practice areas",
    "These are the sentences that make a post feel generated. If your draft",
    "contains one, the post is not finished.",
    "",
    `Hard limit: ${ch.max} characters, including the link.`,
    "",
    "TRUTH: build it ONLY from the material below. Do not add statistics,",
    "deadlines, case outcomes or legal claims that are not in it — an",
    "interesting post that invents a rule is worse than no post. If the",
    "material does not support one, say exactly NOTHING TO SAY and write",
    "nothing else.",
    "",
    "Brand: the firm's public name is \"TEZ Law Firm\" (legal name Tez Law P.C.; in",
    "Chinese posts: TEZ Law Firm 律师事务所). Never write TezLaw, Tez Legal or",
    "Tez Law Group. Warmth is welcome; hype is not. At most three emoji, and",
    "none at all is usually better. At most one exclamation mark in the whole",
    "post, and only if something is actually worth it.",
    "",
    "Never: guarantee or predict an outcome; call the firm the best or a",
    "leader; manufacture urgency; tell the reader what to file or say anything",
    "about 'your case'. The reader is a stranger, not a client. Teaching what",
    "the law says is the point; telling one person what to do is not.",
    "",
    ch.linkInText === false ? "Do not include any link, web address or phone number." : `End with the link: ${source.url}`,
    "",
    "--- MATERIAL ---",
    `Title: ${source.title || ""}`,
    material(source),
    "--- END ---",
    "",
    "Reply with the post text only. No preamble, no quotation marks.",
  ].join("\n");
}

/**
 * Compose one post for one channel. `think` lets a test stand in for Zara.
 * Returns { ok, text, problems, attempts } — a draft that cannot pass the
 * screen is reported, never quietly published.
 */
async function composeOne(source, channel, { think = null, tries = 2, prompt = null } = {}) {
  if (!CHANNELS[channel]) throw new Error(`Unknown channel ${channel}`);
  const ask = think || (message => require("./zara-core").think({
    surface: "system", tier: "balanced", message, lessonScope: "social-posts",
    extra: "You write for a law firm. Plain and specific beats clever. "
      + "Never promise a result.",
    maxTokens: 1200, timeout: 60000,
  }));

  let last = { ok: false, problems: ["not attempted"], text: "" };
  for (let i = 0; i < tries; i++) {
    const raw = String((await ask(prompt || buildPrompt(source, channel))).text || "").trim();
    if (/^NOTHING TO SAY/i.test(raw)) {
      return { ok: false, skip: true, text: "", problems: ["the material does not support a post"], attempts: i + 1 };
    }
    const text = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
    const v = screen(text, { channel, sourceUrl: source.url });
    last = { ...v, text, attempts: i + 1 };
    if (v.ok) return last;
  }
  return last;
}

/**
 * Compose across channels. Returns one entry per channel, including the ones
 * that failed the screen — JJ should see what was rejected and why, not a
 * silently shorter list.
 */
async function compose(source, { channels = channelList(), think = null } = {}) {
  if (!source || !source.url) throw new Error("A source with a real URL is required");
  const out = [];
  for (const c of channels) {
    try { out.push({ channel: c, ...(await composeOne(source, c, { think })) }); }
    catch (e) { out.push({ channel: c, ok: false, text: "", problems: [e.message], attempts: 0 }); }
  }
  return out;
}


// ── Image cards ─────────────────────────────────────────────
//
// Facebook, Instagram and LinkedIn get a 1080×1350 card, Google Business a
// 1200×900 one. The words on the card come from the same article and pass
// the same screen as the post text.
const CARD_FORMAT = { facebook: "portrait", instagram: "portrait", linkedin: "portrait", gbp: "landscape", wechat_moments: "portrait" };

function parseJSON(raw) {
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function defaultAsk(maxTokens = 1200) {
  return message => require("./zara-core").think({
    surface: "system", tier: "balanced", message, lessonScope: "social-posts",
    extra: "You write for a law firm. Plain and specific beats clever. Never promise a result.",
    maxTokens, timeout: 90000,
  });
}

async function composeCard(source, lang = "en", { think = null } = {}) {
  const fallback = { eyebrow: "", title: String(source.title || "").slice(0, 110), points: [], lang };
  const zh = lang === "zh";
  const prompt = [
    zh ? "为下面这篇文章设计一张社交媒体图片卡的文字，简体中文。" : "Write the words for a social media image card about the article below.",
    "Return JSON only:",
    zh ? '{"eyebrow": "领域，2-6个字，如 投资移民", "title": "标题，最多24个字", "points": ["要点，每条最多28个字", "…"]}'
       : '{"eyebrow": "practice area, 1-3 words", "title": "headline, at most 70 characters", "points": ["key fact, at most 90 characters", "..."]}',
    "Two or three points. Only facts stated in the material. No advice to the reader, no promises, no superlatives, no urgency.",
    "", "--- MATERIAL ---", `Title: ${source.title || ""}`, material(source, 5000), "--- END ---",
  ].join("\n");
  try {
    const j = parseJSON((await (think || defaultAsk(600))(prompt)).text);
    if (!j || !j.title) return fallback;
    const spec = {
      eyebrow: String(j.eyebrow || "").slice(0, 30),
      title: String(j.title).slice(0, 110),
      points: (Array.isArray(j.points) ? j.points : []).map(String).filter(Boolean).slice(0, 3).map(x => x.slice(0, 140)),
      lang,
    };
    const v = screen([spec.eyebrow, spec.title, ...spec.points].join("\n"));
    return v.ok ? spec : fallback;
  } catch { return fallback; }
}

function renderCard(spec, channel) {
  return require("./social-media").card({ ...spec, format: CARD_FORMAT[channel] || "portrait" });
}

// ── Storage ─────────────────────────────────────────────────

let ready = null;
function initTable() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS social_posts (
        id SERIAL PRIMARY KEY,
        channel TEXT NOT NULL,
        text TEXT NOT NULL,
        source_url TEXT,
        source_title TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        problems JSONB DEFAULT '[]'::jsonb,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        decided_at TIMESTAMPTZ,
        decided_by TEXT
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts (status, created_at DESC)`);
    // Added with Postiz: the image card or video script, the rendered video,
    // and where each approved post was scheduled.
    await db.query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS lang TEXT`);
    await db.query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS media JSONB`);
    await db.query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS media_file BYTEA`);
    await db.query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS delivered JSONB`);
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// ── Telegram ────────────────────────────────────────────────

const TG = () => `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Drafts and their Approve / Skip buttons go to the Social & content topic of
// the ops group, and to JJ's direct message when no group is set (tg-route.js).
// Who may press the buttons is decided in server.js (isApprover), not here.
async function tellJJ(text, reply_markup = null) {
  return require("./tg-route").send("social", String(text), reply_markup ? { reply_markup } : {});
}

// Photo or video with a caption (Telegram allows 1,024 characters there).
async function sendMediaToJJ(kind, buffer, filename, caption, reply_markup = null) {
  return require("./tg-route").sendMedia("social", kind, buffer, filename, caption, reply_markup ? { reply_markup } : {});
}

const nameOf = ch => ch === "video" ? "Video · YouTube Shorts + TikTok" : (CHANNELS[ch] ? CHANNELS[ch].name : ch);
const buttonsFor = (id, label) => ({ inline_keyboard: [[
  { text: `✅ ${label}`, callback_data: `soc_go_${id}` }, { text: "🚫 Skip", callback_data: `soc_no_${id}` }]] });

// ── Holiday posts ───────────────────────────────────────────

/**
 * Plan the holidays falling in the next `days` days and queue a draft for
 * each, for JJ to approve exactly like an article post.
 *
 * Meant to run on the 1st of the month. Re-running it is safe: a holiday
 * already queued or already decided is not queued again, so a restart on the
 * 1st does not produce two Thanksgiving posts.
 *
 * Warnings from the calendar (a lunar festival whose year has no verified
 * date) are passed through and told to JJ rather than swallowed — a festival
 * that silently never posts is the failure this would otherwise have.
 */
async function queueHolidays({ days = 30, from = new Date(), think = null, notify = true } = {}) {
  if (!ENABLED) return { queued: 0, reason: "SOCIAL_POSTS_ENABLED is not true" };
  await initTable();
  const hp = require("./holiday-posts");
  const { holidays, warnings } = hp.upcoming({ from, days });
  const out = { planned: holidays.length, queued: [], rejected: [], skipped: [], warnings };

  for (const h of holidays) {
    const channels = h.channels || ["facebook", "instagram", "linkedin", "gbp", "wechat_moments"];
    for (const channel of channels) {
      if (!CHANNELS[channel]) continue;

      // Already handled? A holiday is identified by its key and its date, so
      // the same festival next year is a different post.
      const tag = `holiday:${h.key}:${h.date}`;
      const seen = await db.query(
        `SELECT id FROM social_posts WHERE source_url = $1 AND channel = $2 LIMIT 1`, [tag, channel]);
      if (seen.rows.length) { out.skipped.push({ holiday: h.name, channel, why: "already queued" }); continue; }

      let d;
      try {
        d = await composeOne({ url: "", title: h.name }, channel,
          { think, prompt: hp.buildHolidayPrompt(h, channel) });
      } catch (e) {
        out.rejected.push({ holiday: h.name, channel, problems: [e.message] });
        continue;
      }
      if (!d.ok) { out.rejected.push({ holiday: h.name, channel, problems: d.problems }); continue; }

      const r = await db.query(
        `INSERT INTO social_posts (channel, text, source_url, source_title, problems, lang)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
        [channel, d.text, tag, `${h.name} — ${h.date}`, JSON.stringify(d.problems || []),
          CHANNELS[channel].lang || "en"]);
      out.queued.push({ id: r.rows[0].id, holiday: h.name, date: h.date, channel, text: d.text });
    }
  }

  if (notify && (out.queued.length || warnings.length)) {
    const lines = [`🗓 Holiday posts for the next ${days} days`];
    if (out.queued.length) {
      const byHoliday = {};
      for (const q of out.queued) (byHoliday[`${q.date} · ${q.holiday}`] ||= []).push(nameOf(q.channel));
      for (const [k, v] of Object.entries(byHoliday)) lines.push(`• ${k} — ${v.join(", ")}`);
      lines.push("", "Each one is waiting for your approval below.");
    } else {
      lines.push("Nothing new to queue.");
    }
    if (warnings.length) lines.push("", "⚠️ " + warnings.join("\n⚠️ "));
    if (out.rejected.length) {
      lines.push("", `${out.rejected.length} draft(s) did not pass the screen:`);
      for (const r of out.rejected.slice(0, 6)) lines.push(`• ${r.holiday} (${nameOf(r.channel)}): ${(r.problems || []).join("; ")}`);
    }
    await tellJJ(lines.join("\n"));
    for (const q of out.queued) {
      await tellJJ(`${q.date} · ${q.holiday} · ${nameOf(q.channel)}\n\n${q.text}`, buttonsFor(q.id, "Approve"));
    }
  }
  return out;
}

// ── Wednesday fun facts ─────────────────────────────────────

/**
 * One fact, a few channels, queued for approval. Meant for Wednesdays.
 *
 * Which fact comes next is decided from what has already been queued, so the
 * bank rotates without repeating and a restart cannot post the same fact
 * twice in a week.
 */
async function queueFunFact({ channels = ["facebook", "instagram", "linkedin"], think = null, notify = true } = {}) {
  if (!ENABLED) return { queued: 0, reason: "SOCIAL_POSTS_ENABLED is not true" };
  await initTable();
  const ff = require("./fun-facts");

  // What has run before, oldest first — the rotation reads this.
  const prior = await db.query(
    `SELECT source_url, MIN(created_at) AS first_at FROM social_posts
      WHERE source_url LIKE 'funfact:%' GROUP BY source_url ORDER BY MIN(created_at) ASC`);
  const order = prior.rows.map(r => String(r.source_url).slice("funfact:".length));
  const used = new Set(order);

  const fact = ff.nextFact(used, order);
  if (!fact) return { queued: 0, reason: "the fact bank is empty" };

  const tag = `funfact:${fact.key}`;
  const out = { fact: fact.key, queued: [], rejected: [] };

  for (const channel of channels) {
    if (!CHANNELS[channel]) continue;
    // Already queued this week for this channel? Leave it.
    const seen = await db.query(
      `SELECT id FROM social_posts WHERE source_url = $1 AND channel = $2
         AND created_at > NOW() - INTERVAL '6 days' LIMIT 1`, [tag, channel]);
    if (seen.rows.length) continue;

    let d;
    try {
      d = await composeOne({ url: "", title: "Fun fact" }, channel,
        { think, prompt: ff.buildFactPrompt(fact, channel) });
    } catch (e) { out.rejected.push({ channel, problems: [e.message] }); continue; }
    if (!d.ok) { out.rejected.push({ channel, problems: d.problems }); continue; }

    const r = await db.query(
      `INSERT INTO social_posts (channel, text, source_url, source_title, problems, lang)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
      [channel, d.text, tag, `Fun fact · ${fact.key}`, JSON.stringify(d.problems || []),
        CHANNELS[channel].lang || "en"]);
    out.queued.push({ id: r.rows[0].id, channel, text: d.text });
  }

  if (notify && (out.queued.length || out.rejected.length)) {
    const head = [`🧠 Wednesday fun fact — ${fact.key}`];
    if (fact.cite) head.push(`Authority: ${fact.cite}`);
    if (out.rejected.length) head.push("", `${out.rejected.length} draft(s) did not pass the screen: `
      + out.rejected.map(r => `${nameOf(r.channel)} (${(r.problems || []).join("; ")})`).join(", "));
    await tellJJ(head.join("\n"));
    for (const q of out.queued) {
      await tellJJ(`${nameOf(q.channel)}\n\n${q.text}`, buttonsFor(q.id, "Approve"));
    }
  }
  return out;
}

// ── Queueing ────────────────────────────────────────────────

/**
 * Compose for a source and queue whatever passed, asking JJ once.
 * Returns what was queued and what was rejected.
 */
async function queueForSource(source, { channels = channelList(), think = null, notify = true, lang = null } = {}) {
  if (!ENABLED) return { queued: 0, reason: "SOCIAL_POSTS_ENABLED is not true" };
  await initTable();
  const drafts = await compose(source, { channels, think });
  const queued = [], rejected = [];
  const postLang = lang || (CHANNELS[channels[0]] || {}).lang || "en";

  // One card per article, shared by every channel that shows an image.
  const wantsCard = drafts.some(d => d.ok && CARD_FORMAT[d.channel]);
  const card = wantsCard ? await composeCard(source, postLang, { think }) : null;

  for (const d of drafts) {
    if (!d.ok) { rejected.push({ channel: d.channel, problems: d.problems }); continue; }
    const media = CARD_FORMAT[d.channel] && card ? { card } : null;
    const r = await db.query(
      `INSERT INTO social_posts (channel, text, source_url, source_title, problems, media, lang)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING id`,
      [d.channel, d.text, source.url, source.title || null, JSON.stringify(d.problems || []),
        media ? JSON.stringify(media) : null, postLang]);
    queued.push({ id: r.rows[0].id, channel: d.channel, text: d.text, media });
  }

  if (notify && (queued.length || rejected.length)) await askJJ(source, queued, rejected);
  return { queued: queued.length, rejected, posts: queued };
}

async function askJJ(source, queued, rejected) {
  const head = [`📣 Social drafts — ${source.title || source.url}`];
  if (rejected.length) {
    head.push("", "Not offered:");
    for (const r of rejected) head.push(`• ${nameOf(r.channel)}: ${r.problems.join("; ")}`);
  }
  head.push("", require("./postiz").configured()
    ? "Each approved post is scheduled in Postiz for that channel's next open slot."
    : "Postiz is not connected yet — approving gives you the text to paste.");
  await tellJJ(head.join("\n"));

  for (const q of queued) {
    const label = nameOf(q.channel);
    const kb = buttonsFor(q.id, `Post to ${label}`);
    let sent = false;
    if (q.media && q.media.card) {
      try {
        const img = renderCard(q.media.card, q.channel);
        const fits = q.text.length + label.length + 6 <= 1020;
        sent = await sendMediaToJJ("photo", img, `card-${q.id}.png`,
          fits ? `${label}\n\n${q.text}` : `${label} — card`, fits ? kb : null);
        if (sent && !fits) sent = await tellJJ(`── ${label} ──\n${q.text}`, kb);
      } catch (e) { console.warn("[social] card render:", e.message); }
    }
    if (!sent) await tellJJ(`── ${label} ──\n${q.text}`, kb);
  }
  return true;
}

// ── Explainer videos ────────────────────────────────────────
//
// For each article, one short vertical video per language: 普通话, English
// and Español, each written from that language's own published post and
// each approved on its own. At most SOCIAL_VIDEOS_PER_WEEK articles a week
// (default 2) get videos. Branded slides, the spoken line on screen, an AI
// voice, and a closing slide with the disclaimer that also says the voice is
// AI-generated — an ad must not suggest a synthetic voice is the lawyer's
// (Bus. & Prof. Code § 6157.2(c)).
//
// What the voice reads is written for the ear and then listened back to:
// see video-voice.js for why and how.
const VIDEO_ON = () => ENABLED && String(process.env.SOCIAL_VIDEO_ENABLED || "") === "true";
const VIDEO_TARGETS = ["youtube", "tiktok"];
const videoVoice = () => require("./video-voice");
const VIDEO_LANGS = () => String(process.env.SOCIAL_VIDEO_LANGS || "zh,en,es").split(",").map(x => x.trim())
  .filter((l, i, a) => videoVoice().LANGS.includes(l) && a.indexOf(l) === i);

const AI_NOTE = { en: "Narration is AI-generated. General information, not legal advice.",
                  zh: "配音为AI合成。本视频仅供一般参考，不构成法律意见。",
                  es: "La narración es generada por IA. Información general, no asesoría legal." };
const VIDEO_EYEBROW = { en: "Know the law", zh: "法律常识", es: "Conozca la ley" };

const VIDEO_BRIEF = {
  zh: {
    ask: "为下面的文章写一段30–50秒的竖屏讲解短视频脚本，简体中文，普通话配音。",
    shape: '{"title": "视频标题，最多30个字", "caption": "视频简介，1-2句，最多120个字，不要网址", "tags": ["3-6个关键词"], "scenes": [{"text": "屏幕上的字，最多30个字", "say": "配音读的话，最多60个字"}]}',
    scenes: "4到6个场景。第一个场景用一个问题引出主题；最后一个场景的屏幕文字是：完整文章请见 tezlawfirm.com。",
    narrator: "旁白是中性的讲解员，不是律师本人：不要用“我是律师”或以律师身份说话。",
  },
  en: {
    ask: "Write the script for a 30-50 second vertical explainer video about the article below.",
    shape: '{"title": "at most 70 characters", "caption": "1-2 sentences, at most 280 characters, no URL", "tags": ["3-6 plain keywords"], "scenes": [{"text": "on-screen line, at most 90 characters", "say": "what the narrator says, at most 30 words"}]}',
    scenes: "4 to 6 scenes. Scene 1 opens with the question the article answers. The last scene says the full article is at tezlawfirm.com.",
    narrator: "The narrator is a neutral explainer, not the attorney: never speak as a lawyer or say \"I\".",
  },
  es: {
    ask: "Escriba en español el guion de un video explicativo vertical de 30 a 50 segundos sobre el artículo de abajo.",
    shape: '{"title": "máximo 70 caracteres", "caption": "1 o 2 frases, máximo 280 caracteres, sin URL", "tags": ["3 a 6 palabras clave"], "scenes": [{"text": "línea en pantalla, máximo 90 caracteres", "say": "lo que dice el narrador, máximo 30 palabras"}]}',
    scenes: "De 4 a 6 escenas. La primera abre con la pregunta que responde el artículo. La última dice en pantalla: Artículo completo en tezlawfirm.com.",
    narrator: "El narrador es un presentador neutral, no el abogado: nunca hable como abogado ni diga «yo».",
  },
};

// `fix` is the list of problems a previous attempt was refused for, so the
// second attempt is a correction and not a second guess.
function buildVideoPrompt(source, lang, fix = null) {
  const b = VIDEO_BRIEF[lang] || VIDEO_BRIEF.en;
  return [
    b.ask,
    "Return JSON only, in this shape:",
    b.shape,
    b.scenes,
    b.narrator,
    ...videoVoice().speechRules(lang),
    "Only facts in the material. No advice to the viewer about their own case, no promises, no superlatives, no urgency, no call to hire the firm.",
    "If the material cannot support a video, reply exactly NOTHING TO SAY.",
    ...(fix && fix.length ? ["", "Your previous script was refused. Write it again and fix exactly this: " + fix.join("; ") + "."] : []),
    "", "--- MATERIAL ---", `Title: ${source.title || ""}`, material(source, 7000), "--- END ---",
  ].join("\n");
}

function checkScript(j, lang) {
  const problems = [];
  if (!j || typeof j !== "object") return { ok: false, problems: ["not valid JSON"] };
  const scenes = Array.isArray(j.scenes) ? j.scenes.filter(x => x && x.text) : [];
  if (scenes.length < 3 || scenes.length > 7) problems.push(`${scenes.length} scenes (want 4-6)`);
  if (!j.title || String(j.title).length < 2) problems.push("no title");
  const said = scenes.map(x => String(x.say || x.text)).join(" ");
  if (lang === "zh") { if (said.replace(/\s/g, "").length > 340) problems.push("narration too long for 50 seconds"); }
  else if (said.split(/\s+/).length > 150) problems.push("narration too long for 50 seconds");
  if (scenes.some(x => String(x.text).length > (lang === "zh" ? 40 : 120))) problems.push("an on-screen line is too long");
  // Each spoken line must be something a synthetic voice can read in this language.
  for (const x of scenes) for (const p of videoVoice().checkSay(x.say || x.text, lang)) if (!problems.includes(p)) problems.push(p);
  const all = [j.title, j.caption, ...scenes.map(x => `${x.text}\n${x.say || ""}`)].join("\n");
  if (/\b(I am|I'm|as your) (an? )?(attorney|lawyer)\b/i.test(all) || /我是律师|作为您的律师/.test(all) || /\b(soy|como su) (un |una )?abogad[oa]\b/i.test(all))
    problems.push("the AI narrator speaks as the attorney");
  if (lang === "es" && /\bnotari[oa]s?\b/i.test(all)) problems.push("uses \"notario\", which misleads in Spanish");
  const v = screen(all);
  return { ok: !problems.length && v.ok, problems: problems.concat(v.problems), scenes };
}

async function composeVideoScript(source, lang = "en", { think = null, tries = 3 } = {}) {
  const ask = think || defaultAsk(1500);
  let last = { ok: false, problems: ["not attempted"] };
  for (let i = 0; i < tries; i++) {
    const raw = String((await ask(buildVideoPrompt(source, lang, i ? last.problems : null))).text || "").trim();
    if (/^NOTHING TO SAY/i.test(raw)) return { ok: false, skip: true, problems: ["the material does not support a video"] };
    const j = parseJSON(raw);
    const c = checkScript(j, lang);
    if (c.ok) {
      const url = source.url;
      const caption = String(j.caption || "").replace(/https?:\/\/\S+/g, "").trim();
      return { ok: true, attempts: i + 1, script: {
        title: String(j.title).slice(0, 90), caption,
        tags: (Array.isArray(j.tags) ? j.tags : []).map(String).slice(0, 6),
        scenes: c.scenes.map(x => ({ text: String(x.text), say: String(x.say || x.text) })),
        lang, url,
      } };
    }
    last = { ok: false, problems: c.problems, attempts: i + 1 };
  }
  return last;
}

// The public text that goes with the video on each platform.
function videoCaption(script, target) {
  const note = AI_NOTE[script.lang] || AI_NOTE.en;
  const link = target === "tiktok" ? "tezlawfirm.com" : script.url;
  return [script.caption, link, note].filter(Boolean).join("\n\n");
}

// One row per video. Videos made together for one article share media.group.
async function videosThisWeek() {
  const r = await db.query(`SELECT id, lang, media->>'group' AS grp FROM social_posts WHERE channel = 'video' AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC`);
  return r.rows || [];
}

// One language's video for one article: script, render, store, send for approval.
async function makeVideo(source, lang, { think, notify, render, group, position }) {
  const c = await composeVideoScript(source, lang, { think });
  if (!c.ok) return { lang, skip: !!c.skip, reason: c.problems.join("; ") };
  const s = c.script;
  const out = await (render || require("./social-media").video)({ lang, eyebrow: VIDEO_EYEBROW[lang] || VIDEO_EYEBROW.en, scenes: s.scenes });
  const fs = require("fs");
  const file = fs.readFileSync(out.file);
  try { fs.rmSync(out.dir, { recursive: true, force: true }); } catch {}

  const voice = (out.voice || []).map(v => ({ scene: v.scene, checked: v.checked, clear: v.clear, score: v.score, takes: v.takes, heard: v.clear === false ? String(v.heard || "").slice(0, 200) : undefined }));
  const text = videoCaption(s, "youtube");
  const r = await db.query(
    `INSERT INTO social_posts (channel, text, source_url, source_title, problems, media, lang, media_file)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) RETURNING id`,
    ["video", text, source.url, source.title || null, "[]",
      JSON.stringify({ script: s, targets: VIDEO_TARGETS, seconds: Math.round(out.seconds || 0), group, voice }), lang, file]);
  const id = r.rows[0].id;

  if (notify) {
    const V = videoVoice();
    const cap1 = [`🎬 ${V.LANG_NAME[lang] || lang} explainer · ${Math.round(out.seconds || 0)}s · ${position}`,
      `YouTube / TikTok title: ${s.title}`, "", s.caption, "", V.voiceReport(out.voice),
      "Goes to YouTube Shorts and TikTok at their next open slots."].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
    const ok = await sendMediaToJJ("video", file, `tez-video-${id}.mp4`, cap1, buttonsFor(id, "Post video"));
    if (!ok) await tellJJ(`${cap1}\n\n(The video was too large to preview here.)`, buttonsFor(id, "Post video"));
  }
  return { lang, id, seconds: out.seconds, voice };
}

/**
 * Make the videos for one article. `sources` is { zh, en, es }: that
 * language's published post ({ title, url, summary, content }). A language
 * with no post gets no video. Each video is its own row and its own approval.
 * The weekly limit counts articles, not videos.
 */
async function queueVideo(sources, { think = null, notify = true, render = null } = {}) {
  if (!VIDEO_ON()) return { queued: 0, reason: "SOCIAL_VIDEO_ENABLED is not true" };
  await initTable();
  const cap = Math.max(0, Number(process.env.SOCIAL_VIDEOS_PER_WEEK || 2));
  const recent = await videosThisWeek();
  const articles = new Set(recent.map(r => r.grp || "video-" + r.id));
  if (articles.size >= cap) return { queued: 0, reason: `weekly limit reached (${articles.size}/${cap})` };

  const want = VIDEO_LANGS();
  const langs = want.filter(l => sources[l] && sources[l].url);
  if (!langs.length) return { queued: 0, reason: "no source in a video language" };
  const group = (sources.en && sources.en.url) || sources[langs[0]].url;
  const title = (sources.en || sources[langs[0]]).title || "";
  const V = videoVoice();

  const made = [];
  const skipped = want.filter(l => !langs.includes(l)).map(l => ({ lang: l, reason: "no published post in that language" }));
  for (const lang of langs) {
    // One language failing must not cost the other two.
    try {
      const one = await makeVideo(sources[lang], lang, { think, notify, render, group, position: `${langs.indexOf(lang) + 1} of ${langs.length}` });
      if (one.id) made.push(one); else skipped.push(one);
    } catch (e) { skipped.push({ lang, reason: e.message }); }
  }
  const told = skipped.filter(x => !x.skip);
  if (notify && told.length)
    await tellJJ(`🎬 ${made.length ? `${made.length} of ${want.length} videos made` : "No video"} for "${title}". Not made: ` +
      told.map(x => `${V.LANG_NAME[x.lang] || x.lang} (${x.reason})`).join("; "));

  const first = made[0] || {};
  return { queued: made.length, id: first.id, lang: first.lang, seconds: first.seconds,
    ids: made.map(x => x.id), langs: made.map(x => x.lang), made, skipped,
    reason: made.length ? undefined : (skipped.map(x => `${x.lang}: ${x.reason}`).join("; ") || "nothing was made") };
}

// ── When each channel posts ─────────────────────────────────
//
// Pacific time. One post per channel per slot, so three articles approved on
// the same morning go out on three different days rather than all at once.
// Override with SOCIAL_SLOTS, e.g. {"linkedin":{"days":[2,4],"time":"09:00"}}
// (days: 0 = Sunday).
const DEFAULT_SLOTS = {
  linkedin:  { days: [2, 3, 4],       time: "08:30" },
  facebook:  { days: [1, 2, 3, 4, 5], time: "12:15" },
  instagram: { days: [1, 2, 3, 4, 5, 6], time: "18:30" },
  gbp:       { days: [1, 3, 5],       time: "10:00" },
  youtube:   { days: [2, 4, 6],       time: "16:00" },
  tiktok:    { days: [2, 4, 6],       time: "19:00" },
};
function slots() {
  try { return { ...DEFAULT_SLOTS, ...JSON.parse(process.env.SOCIAL_SLOTS || "{}") }; }
  catch { return DEFAULT_SLOTS; }
}

const TZ = "America/Los_Angeles";
function laParts(t) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const o = {}; for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute,
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday), key: `${o.year}-${o.month}-${o.day}` };
}
// Pacific wall-clock time → the real instant (handles daylight saving).
function laToDate(y, m, d, h, mi) {
  let t = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = laParts(t);
    t += Date.UTC(y, m - 1, d, h, mi) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  }
  return new Date(t);
}

/** The next open slot for a channel. `taken` = dates already used on it. */
function nextSlot(channel, taken = [], now = Date.now()) {
  const s = slots()[channel] || { days: [1, 2, 3, 4, 5], time: "12:00" };
  const [hh, mm] = String(s.time).split(":").map(Number);
  const used = new Set(taken.map(t => laParts(t).key));
  const start = laParts(now);
  for (let i = 0; i < 60; i++) {
    const base = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate();
    const when = laToDate(y, m, d, hh, mm);
    const p = laParts(when);
    if (!s.days.includes(p.dow) || used.has(p.key)) continue;
    if (when.getTime() < now + 20 * 60 * 1000) continue;
    return when;
  }
  return new Date(now + 24 * 3600 * 1000);
}

async function takenSlots(channel) {
  const r = await db.query(
    `SELECT delivered FROM social_posts WHERE delivered IS NOT NULL AND decided_at > NOW() - INTERVAL '60 days'`);
  const out = [];
  for (const row of r.rows || []) {
    const d = row.delivered && row.delivered[channel];
    if (d && d.date && new Date(d.date).getTime() > Date.now() - 24 * 3600 * 1000) out.push(new Date(d.date));
  }
  return out;
}

const fmtPT = d => new Date(d).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";

// ── Delivery through Postiz ─────────────────────────────────
//
// Card channels: render the card, upload it, schedule the post.
// Video: upload the MP4 once, schedule it on YouTube and on TikTok.
// What already went through is recorded as it happens, so a retry after a
// partial failure does not post anything twice.
async function deliverViaPostiz({ row }) {
  const postiz = require("./postiz");
  const done = { ...(row.delivered || {}) };
  const save = () => db.query(`UPDATE social_posts SET delivered = $2::jsonb WHERE id = $1`, [row.id, JSON.stringify(done)]);

  if (row.channel === "video") {
    const s = row.media && row.media.script;
    if (!s) throw new Error("video script missing");
    let file = row.media_file;
    if (!file && VIDEO_TARGETS.some(t => !done[t])) throw new Error("the rendered video is no longer stored");
    let up = null;
    for (const target of (row.media.targets || VIDEO_TARGETS)) {
      if (done[target]) continue;
      if (!(await postiz.integrationFor(target))) { done[target] = { skipped: "not connected in Postiz" }; await save(); continue; }
      up = up || await postiz.upload(Buffer.from(file), `tez-video-${row.id}.mp4`, "video/mp4");
      const date = nextSlot(target, await takenSlots(target));
      const r = await postiz.schedule({ channel: target, content: videoCaption(s, target), media: [up], date,
        meta: { title: s.title, url: row.source_url, tags: s.tags } });
      done[target] = { date: r.date, postId: r.postId, account: r.account };
      await save();
    }
    await db.query(`UPDATE social_posts SET media_file = NULL WHERE id = $1`, [row.id]);
    return done;
  }

  if (done[row.channel]) return done;
  let media = [];
  if (row.media && row.media.card && CARD_FORMAT[row.channel]) {
    const png = renderCard(row.media.card, row.channel);
    media = [await postiz.upload(png, `tez-card-${row.id}.png`, "image/png")];
  }
  const date = nextSlot(row.channel, await takenSlots(row.channel));
  const r = await postiz.schedule({ channel: row.channel, content: row.text, media, date,
    meta: { title: row.source_title, url: row.source_url } });
  done[row.channel] = { date: r.date, postId: r.postId, account: r.account };
  await save();
  return done;
}

// ── Decisions ───────────────────────────────────────────────

/**
 * Hand an approved post back to JJ to post by hand: the image first (to
 * save), then the text. WeChat posts are Chinese end to end, message included.
 */
async function pasteToJJ(p, reason = null) {
  const zh = (CHANNELS[p.channel] || {}).lang === "zh";
  let spec = p.media && p.media.card;
  if (!spec && CARD_FORMAT[p.channel] && p.source_title) {
    // Posts queued before this channel had a card: build one from the title.
    spec = { eyebrow: zh ? "法律常识" : "Know the law", title: p.source_title, points: [], lang: zh ? "zh" : "en" };
  }
  if (spec) {
    try {
      await sendMediaToJJ("photo", renderCard(spec, p.channel), `card-${p.id}.png`,
        zh ? `${nameOf(p.channel)} 配图（长按保存）` : `${nameOf(p.channel)} image (save it)`);
    } catch (e) { console.warn("[social] paste card:", e.message); }
  }
  const head = zh
    ? `✅ ${nameOf(p.channel)}：已批准。请复制下面的文字，连同上面的图片一起发布。`
    : `✅ ${nameOf(p.channel)} — ready to paste${reason ? ` (${reason})` : ""}:`;
  return tellJJ([head, "", p.text].join("\n"));
}

/** True when Postiz has a provider for this channel (video goes to YouTube/TikTok). */
function postizCanDeliver(channel) {
  if (channel === "video") return true;
  return !!(require("./postiz").PROVIDERS || {})[channel];
}

async function approve(id, by = "JJ", { deliver } = {}) {
  await initTable();
  const p = (await db.query(`SELECT * FROM social_posts WHERE id = $1`, [id])).rows[0];
  if (!p) throw new Error(`No social post ${id}`);
  // 'error' can be retried: the tap is JJ saying "try again".
  // So can a post approved while Postiz was not set up: approval then only
  // handed the text back to paste, and nothing reached Postiz. Once Postiz is
  // configured, tapping Approve again schedules it. A post with anything in
  // `delivered` already went through and is never sent twice.
  if (deliver === undefined) deliver = require("./postiz").configured() ? deliverViaPostiz : null;
  // Postiz can't post to every channel we draft for (WeChat Moments has no
  // API at all). Those always come back to JJ as text to paste, instead of
  // failing with "No wechat_moments account is connected in Postiz".
  if (deliver === deliverViaPostiz && !postizCanDeliver(p.channel)) deliver = null;
  // A channel Postiz supports but that isn't connected there (Google Business
  // today) also comes back as text to paste, not as an error.
  let pasteReason = null;
  if (deliver === deliverViaPostiz && p.channel !== "video") {
    try {
      if (!(await require("./postiz").integrationFor(p.channel))) { deliver = null; pasteReason = "not connected in Postiz"; }
    } catch (e) { /* Postiz unreachable: let delivery fail and report it */ }
  }
  const lateDelivery = p.status === "approved" && !p.delivered && !!deliver;
  if (p.status !== "pending" && p.status !== "error" && !lateDelivery) return { alreadyDone: true, status: p.status };

  // Re-screen at approval. A post can sit for a day, and the rules are cheap
  // to re-apply; approving something that would now fail is not worth saving
  // one query.
  const v = screen(p.text, { channel: p.channel, sourceUrl: p.source_url });
  if (!v.ok) {
    await db.query(`UPDATE social_posts SET status = 'blocked', problems = $2::jsonb, decided_at = NOW(), decided_by = $3 WHERE id = $1`,
      [id, JSON.stringify(v.problems), by]);
    return { ok: false, status: "blocked", problems: v.problems };
  }

  // Postiz connected → schedule it there. Otherwise hand JJ the text to paste.
  // (`deliver` was settled above.)

  let delivered = null;
  if (deliver) {
    try { delivered = await deliver({ channel: p.channel, text: p.text, sourceUrl: p.source_url, row: p }); }
    catch (e) {
      await db.query(`UPDATE social_posts SET status = 'error', error = $2 WHERE id = $1`, [id, e.message]);
      if (deliver === deliverViaPostiz) {
        await tellJJ(`⚠️ ${nameOf(p.channel)} was not scheduled: ${e.message}\nNothing was posted. Tap to try again once it's fixed.`,
          { inline_keyboard: [[{ text: "🔁 Try again", callback_data: `soc_go_${id}` }, { text: "🚫 Drop it", callback_data: `soc_no_${id}` }]] });
      }
      return { ok: false, status: "error", error: e.message };
    }
  }

  await db.query(`UPDATE social_posts SET status = 'approved', decided_at = NOW(), decided_by = $2 WHERE id = $1`, [id, by]);
  if (!deliver) {
    await pasteToJJ(p, pasteReason);
  } else if (deliver === deliverViaPostiz && delivered) {
    const lines = Object.entries(delivered).map(([ch, d]) =>
      d.skipped ? `• ${nameOf(ch)}: skipped — ${d.skipped}` : `• ${nameOf(ch)}: ${fmtPT(d.date)}${d.account ? ` (${d.account})` : ""}`);
    await tellJJ([`🗓 Scheduled in Postiz`, ...lines].join("\n"));
  }
  return { ok: true, status: "approved", delivered };
}

async function skip(id, by = "JJ") {
  await initTable();
  const r = await db.query(
    `UPDATE social_posts SET status = 'skipped', decided_at = NOW(), decided_by = $2
      WHERE id = $1 AND status IN ('pending', 'error') RETURNING id`, [id, by]);
  if (r.rows.length) await db.query(`UPDATE social_posts SET media_file = NULL WHERE id = $1`, [id]);
  return { ok: !!r.rows.length };
}

/** Telegram button dispatch: soc_go_ID / soc_no_ID. */
async function handleTelegramCallback(data, callbackQueryId, by = "JJ") {
  const m = String(data || "").match(/^soc_(go|no)_(\d+)$/);
  if (!m) return { handled: false };
  const id = Number(m[2]);
  const r = m[1] === "go" ? await approve(id, by) : await skip(id, by);
  return { handled: true, id, action: m[1], result: r };
}

async function status() {
  await initTable();
  const counts = (await db.query(`SELECT status, COUNT(*)::int AS n FROM social_posts GROUP BY status`)).rows;
  return {
    enabled: ENABLED,
    video: VIDEO_ON(),
    postiz: require("./postiz").configured(),
    channels: channelList(),
    counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
  };
}

module.exports = {
  CHANNELS, BANNED, channelList, CARD_FORMAT, DEFAULT_SLOTS,
  screen, material, buildPrompt, composeOne, compose, composeCard, renderCard,
  buildVideoPrompt, checkScript, composeVideoScript, videoCaption, queueVideo, VIDEO_LANGS,
  nextSlot, laToDate, deliverViaPostiz, postizCanDeliver, pasteToJJ,
  initTable, queueForSource, queueHolidays, queueFunFact, approve, skip, handleTelegramCallback, status,
};
