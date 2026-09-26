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
    voice: "Professional peers and referral sources are reading. Plain, "
      + "specific, no hype. One concrete point worth knowing.",
  },
  facebook: {
    name: "Facebook",
    max: 1200,
    lang: "en",
    voice: "Community audience. Warm and plain-spoken, short paragraphs, "
      + "no jargon. Explain the thing itself, not why to hire a lawyer.",
  },
  instagram: {
    name: "Instagram",
    max: 900,
    lang: "en",
    voice: "Short. One idea. Line breaks, not paragraphs. A handful of "
      + "specific hashtags at the end, never a wall of them.",
  },
  wechat_moments: {
    name: "WeChat 朋友圈",
    max: 600,
    lang: "zh",
    voice: "简体中文。写给在美国的华人移民读者。平实、具体、不夸张，"
      + "不用营销口号，不承诺结果。",
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
  if (sourceUrl && !s.includes(sourceUrl)) problems.push("does not link back to the source");

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

function buildPrompt(source, channel) {
  const ch = CHANNELS[channel];
  return [
    `Write one ${ch.name} post for ${FIRM}, a law firm in West Covina, California.`,
    "",
    ch.voice,
    "",
    `Hard limit: ${ch.max} characters, including the link.`,
    "",
    "It must be built ONLY from the material below. Do not add statistics,",
    "deadlines, case outcomes or legal claims that are not in it. If the",
    "material does not support an interesting post, say exactly NOTHING TO SAY",
    "and write nothing else.",
    "",
    "Never: guarantee or predict an outcome; call the firm the best or a",
    "leader; manufacture urgency; tell the reader what to file or say anything",
    "about 'your case'. The reader is a stranger, not a client.",
    "",
    `End with the link: ${source.url}`,
    "",
    "--- MATERIAL ---",
    `Title: ${source.title || ""}`,
    String(source.summary || source.content || "").slice(0, 6000),
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
async function composeOne(source, channel, { think = null, tries = 2 } = {}) {
  if (!CHANNELS[channel]) throw new Error(`Unknown channel ${channel}`);
  const ask = think || (message => require("./zara-core").think({
    surface: "system", tier: "balanced", message, lessonScope: "social-posts",
    extra: "You write for a law firm. Plain and specific beats clever. "
      + "Never promise a result.",
    maxTokens: 1200, timeout: 60000,
  }));

  let last = { ok: false, problems: ["not attempted"], text: "" };
  for (let i = 0; i < tries; i++) {
    const raw = String((await ask(buildPrompt(source, channel))).text || "").trim();
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
  })().catch(e => { ready = null; throw e; });
  return ready;
}

async function tellJJ(text, reply_markup = null) {
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return false;
  try {
    await require("axios").post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: JJ_TELEGRAM_ID, text: String(text).slice(0, 3900), disable_web_page_preview: true,
        ...(reply_markup ? { reply_markup } : {}) }, { timeout: 10000 });
    return true;
  } catch (e) { console.warn("[social] telegram:", e.message); return false; }
}

/**
 * Compose for a source and queue whatever passed, asking JJ once.
 * Returns what was queued and what was rejected.
 */
async function queueForSource(source, { channels = channelList(), think = null, notify = true } = {}) {
  if (!ENABLED) return { queued: 0, reason: "SOCIAL_POSTS_ENABLED is not true" };
  await initTable();
  const drafts = await compose(source, { channels, think });
  const queued = [], rejected = [];

  for (const d of drafts) {
    if (!d.ok) { rejected.push({ channel: d.channel, problems: d.problems }); continue; }
    const r = await db.query(
      `INSERT INTO social_posts (channel, text, source_url, source_title, problems)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [d.channel, d.text, source.url, source.title || null, JSON.stringify(d.problems || [])]);
    queued.push({ id: r.rows[0].id, channel: d.channel, text: d.text });
  }

  if (notify && (queued.length || rejected.length)) await askJJ(source, queued, rejected);
  return { queued: queued.length, rejected, posts: queued };
}

async function askJJ(source, queued, rejected) {
  const lines = [`📣 Social drafts — ${source.title || source.url}`, ""];
  for (const q of queued) {
    lines.push(`── ${CHANNELS[q.channel].name} ──`, q.text, "");
  }
  if (rejected.length) {
    lines.push("Not offered:");
    for (const r of rejected) lines.push(`• ${CHANNELS[r.channel].name}: ${r.problems.join("; ")}`);
    lines.push("");
  }
  lines.push("Approve to keep, or skip. Nothing posts on its own.");
  const buttons = queued.map(q => ([
    { text: `✅ ${CHANNELS[q.channel].name}`, callback_data: `soc_go_${q.id}` },
    { text: "🚫", callback_data: `soc_no_${q.id}` },
  ]));
  return tellJJ(lines.join("\n"), buttons.length ? { inline_keyboard: buttons } : null);
}

// ── Decisions ───────────────────────────────────────────────

async function approve(id, by = "JJ", { deliver = null } = {}) {
  await initTable();
  const p = (await db.query(`SELECT * FROM social_posts WHERE id = $1`, [id])).rows[0];
  if (!p) throw new Error(`No social post ${id}`);
  if (p.status !== "pending") return { alreadyDone: true, status: p.status };

  // Re-screen at approval. A post can sit for a day, and the rules are cheap
  // to re-apply; approving something that would now fail is not worth saving
  // one query.
  const v = screen(p.text, { channel: p.channel, sourceUrl: p.source_url });
  if (!v.ok) {
    await db.query(`UPDATE social_posts SET status = 'blocked', problems = $2::jsonb, decided_at = NOW(), decided_by = $3 WHERE id = $1`,
      [id, JSON.stringify(v.problems), by]);
    return { ok: false, status: "blocked", problems: v.problems };
  }

  // No channel is connected yet, so "delivering" means handing JJ the finished
  // text. When an adapter exists it goes here and nothing above changes.
  let delivered = null;
  if (deliver) {
    try { delivered = await deliver({ channel: p.channel, text: p.text, sourceUrl: p.source_url }); }
    catch (e) {
      await db.query(`UPDATE social_posts SET status = 'error', error = $2 WHERE id = $1`, [id, e.message]);
      return { ok: false, status: "error", error: e.message };
    }
  }

  await db.query(`UPDATE social_posts SET status = 'approved', decided_at = NOW(), decided_by = $2 WHERE id = $1`, [id, by]);
  if (!deliver) {
    await tellJJ([`✅ ${CHANNELS[p.channel] ? CHANNELS[p.channel].name : p.channel} — ready to paste:`, "", p.text].join("\n"));
  }
  return { ok: true, status: "approved", delivered };
}

async function skip(id, by = "JJ") {
  await initTable();
  const r = await db.query(
    `UPDATE social_posts SET status = 'skipped', decided_at = NOW(), decided_by = $2
      WHERE id = $1 AND status = 'pending' RETURNING id`, [id, by]);
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
    channels: channelList(),
    counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
  };
}

module.exports = {
  CHANNELS, BANNED, channelList,
  screen, buildPrompt, composeOne, compose,
  initTable, queueForSource, approve, skip, handleTelegramCallback, status,
};
