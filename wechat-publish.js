// ============================================================
//  wechat-publish.js — articles to the Tez Law 公众号
// ------------------------------------------------------------
//  JJ: "i have wechat clients too."
//
//  That is the whole reason this exists. The firm's clients are on
//  WeChat, and Zara has been authenticated to the Official Account all
//  along — server.js refreshes a stable_token for inbound chat. The same
//  token publishes articles, so the distance between "we talk to clients
//  on WeChat" and "we publish to clients on WeChat" was two endpoints.
//
//  The flow Tencent requires:
//    1. a cover image, uploaded as permanent material  → thumb_media_id
//    2. draft/add with the article                     → draft media_id
//    3. freepublish/submit with that media_id          → publish_id
//    4. a PUBLISHJOBFINISH callback, later, with the real outcome
//
//  Step 3 returns immediately and means nothing about success. The
//  callback is the truth, and it arrives at the same webhook that already
//  handles inbound WeChat messages.
//
//  NOTHING PUBLISHES WITHOUT JJ. A post is written, stored as pending,
//  and sent to Telegram with Approve / Skip. Publishing is an act of
//  attorney advertising with his bar number on it, so a person decides
//  every time. WECHAT_PUBLISH_AUTO=true removes that gate; it is off,
//  and the reasons to leave it off are in the plan doc.
// ============================================================

const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const db = require("./db");

const API = "https://api.weixin.qq.com/cgi-bin";

const APP_ID = process.env.WECHAT_APP_ID;
const APP_SECRET = process.env.WECHAT_APP_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const JJ_TELEGRAM_ID = process.env.JJ_TELEGRAM_ID;

// Off until JJ turns it on, so a deploy can never surprise him with a post.
const ENABLED = String(process.env.WECHAT_PUBLISH_ENABLED || "") === "true";
// The approval gate. Leaving this false is the recommendation.
const AUTO = String(process.env.WECHAT_PUBLISH_AUTO || "") === "true";
const AUTHOR = process.env.WECHAT_AUTHOR || "Tez Law P.C.";
// A cover uploaded once and reused. Read at call time, not at boot, so
// setting it is a Render env edit rather than a deploy.
function defaultCover() { return process.env.WECHAT_COVER_MEDIA_ID || ""; }

// Tencent's limits, enforced here so a long title fails at our edge with a
// clear message rather than as errcode 40001 from Beijing.
const MAX_TITLE = 64;
const MAX_DIGEST = 120;
const MAX_CONTENT = 20000;

function configured() {
  return Boolean(APP_ID && APP_SECRET);
}

// ── Access token ─────────────────────────────────────────
// stable_token hands back the same token to every caller rather than
// invalidating the last one, so this cache living beside server.js's is
// safe. force_refresh stays false for exactly that reason.
let tokenValue = null;
let tokenExpiry = 0;

async function token() {
  if (!configured()) throw new Error("WeChat not configured (WECHAT_APP_ID / WECHAT_APP_SECRET)");
  if (tokenValue && Date.now() < tokenExpiry) return tokenValue;
  const resp = await axios.post(`${API}/stable_token`, {
    grant_type: "client_credential", appid: APP_ID, secret: APP_SECRET,
  });
  if (!resp.data || !resp.data.access_token) {
    throw new Error("WeChat token error: " + JSON.stringify(resp.data));
  }
  tokenValue = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  return tokenValue;
}

// Every WeChat call answers 200 with an errcode in the body, so a failure
// looks like a success to axios. This is the only place that is unwrapped.
function unwrap(data, what) {
  if (data && data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat ${what} failed (${data.errcode}): ${data.errmsg || "no message"}`);
  }
  return data;
}

// ── Images ───────────────────────────────────────────────
// A cover is permanent material and yields a media_id the draft points at.
// Upload one cover per practice area once, keep the ids, reuse forever.
async function uploadCover(file, filename = "cover.jpg") {
  const t = await token();
  const form = new FormData();
  form.append("media", Buffer.isBuffer(file) ? file : fs.createReadStream(file), { filename });
  const resp = await axios.post(
    `${API}/material/add_material?access_token=${t}&type=image`,
    form, { headers: form.getHeaders(), maxBodyLength: Infinity }
  );
  const data = unwrap(resp.data, "cover upload");
  return { media_id: data.media_id, url: data.url };
}

// An image inside the article body is a different endpoint: no media_id,
// just a mp.weixin URL. Tencent strips every external image from content,
// so anything that must appear in the body goes through here first.
async function uploadInlineImage(file, filename = "inline.jpg") {
  const t = await token();
  const form = new FormData();
  form.append("media", Buffer.isBuffer(file) ? file : fs.createReadStream(file), { filename });
  const resp = await axios.post(
    `${API}/media/uploadimg?access_token=${t}`,
    form, { headers: form.getHeaders(), maxBodyLength: Infinity }
  );
  return unwrap(resp.data, "inline image upload").url;
}

// ── Content ──────────────────────────────────────────────
// The blog footer is built for WordPress: a <style> block, an author card,
// JSON-LD in a <script>. None of it survives WeChat, and the script would
// be stripped anyway, so the body is cut at the footer and a plain WeChat
// signature is appended instead.
function toWeChatHtml(html, { sourceUrl } = {}) {
  let body = String(html == null ? "" : html);

  // Everything from the author card down belongs to the website.
  const footerAt = body.search(/<style>\s*\.tez-ab|<aside class="tez-ab"/);
  if (footerAt > 0) body = body.slice(0, footerAt);

  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Tencent filters external images anyway; dropping them here keeps the
    // article from rendering with a row of broken placeholders.
    .replace(/<img\b(?![^>]*mmbiz\.qpic\.cn)[^>]*>/gi, "")
    .trim();

  const sig = [
    '<p style="margin-top:28px;color:#888;font-size:13px;line-height:1.7;">',
    "Tez Law P.C. · 626-678-8677<br>",
    "移民 · 房地產 · 商業訴訟 · 遺產規劃<br>",
    sourceUrl ? `原文：${escapeHtml(sourceUrl)}<br>` : "",
    "本文僅供參考，不構成法律意見。具體問題請聯繫我們。",
    "</p>",
  ].join("");

  return (body + sig).slice(0, MAX_CONTENT);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// A digest is what shows in the timeline. Left empty, WeChat takes the
// first 54 characters of the body, which is usually a sentence fragment.
function makeDigest(digest, content) {
  const from = digest || String(content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return from.slice(0, MAX_DIGEST);
}

// ── Draft and publish ────────────────────────────────────
async function createDraft({ title, content, digest, thumbMediaId, sourceUrl, author }) {
  if (!title) throw new Error("A WeChat article needs a title");
  if (!content) throw new Error("A WeChat article needs content");
  const thumb = thumbMediaId || defaultCover();
  if (!thumb) throw new Error("A WeChat article needs a cover image (thumb_media_id)");

  const t = await token();
  const resp = await axios.post(`${API}/draft/add?access_token=${t}`, {
    articles: [{
      article_type: "news",
      title: String(title).slice(0, MAX_TITLE),
      author: author || AUTHOR,
      digest: makeDigest(digest, content),
      content,
      content_source_url: sourceUrl || "",
      thumb_media_id: thumb,
      need_open_comment: 1,
      only_fans_can_comment: 0,
    }],
  });
  return unwrap(resp.data, "draft/add").media_id;
}

// Returns a publish_id, not a result. The PUBLISHJOBFINISH callback is
// what says whether the article actually went out.
async function publishDraft(draftMediaId) {
  const t = await token();
  const resp = await axios.post(`${API}/freepublish/submit?access_token=${t}`, {
    media_id: draftMediaId,
  });
  return unwrap(resp.data, "freepublish/submit").publish_id;
}

// ── Storage ──────────────────────────────────────────────
async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wechat_posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      digest TEXT,
      content TEXT NOT NULL,
      cover_media_id TEXT,
      source_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      draft_media_id TEXT,
      publish_id TEXT,
      article_url TEXT,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      decided_by TEXT,
      published_at TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS wechat_posts_status ON wechat_posts (status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS wechat_posts_publish ON wechat_posts (publish_id)`);
}

// ── The approval gate ────────────────────────────────────
// A post is stored, then JJ is asked. Nothing reaches WeChat in between.
async function queueForApproval({ title, content, digest, coverMediaId, sourceUrl }) {
  if (!ENABLED) return { queued: false, reason: "WECHAT_PUBLISH_ENABLED is not true" };

  const html = toWeChatHtml(content, { sourceUrl });
  const row = await db.query(
    `INSERT INTO wechat_posts (title, digest, content, cover_media_id, source_url, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [String(title).slice(0, MAX_TITLE), makeDigest(digest, html), html,
     coverMediaId || defaultCover() || null, sourceUrl || null,
     AUTO ? "approved" : "pending"]
  );
  const id = row.rows[0].id;

  if (AUTO) {
    const out = await publishById(id, "auto");
    return { queued: true, id, auto: true, ...out };
  }

  await askJJ(id, title, makeDigest(digest, html));
  return { queued: true, id, auto: false };
}

async function askJJ(id, title, digest) {
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) {
    console.log(`[wechat] Telegram not configured — post ${id} is waiting at /admin/wechat`);
    return;
  }
  const text = [
    "📣 *WeChat 公众号 — ready to publish*",
    "",
    `*${title}*`,
    "",
    digest,
    "",
    "_Publishing puts this out under the firm's name._",
  ].join("\n");
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: JJ_TELEGRAM_ID,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Publish", callback_data: `wcpost_go_${id}` },
          { text: "🚫 Skip", callback_data: `wcpost_no_${id}` },
        ]],
      },
    });
  } catch (e) {
    // An unsent approval leaves the post pending, which is the safe end.
    console.warn("[wechat] could not ask JJ:", e.message);
  }
}

// ── Publishing one stored post ───────────────────────────
async function publishById(id, by = "JJ") {
  const r = await db.query(`SELECT * FROM wechat_posts WHERE id = $1`, [id]);
  const post = r.rows[0];
  if (!post) throw new Error(`No WeChat post ${id}`);
  if (post.status === "published" || post.status === "publishing") {
    return { alreadyDone: true, status: post.status };
  }

  try {
    const draftId = await createDraft({
      title: post.title,
      content: post.content,
      digest: post.digest,
      thumbMediaId: post.cover_media_id,
      sourceUrl: post.source_url,
    });
    const publishId = await publishDraft(draftId);
    await db.query(
      `UPDATE wechat_posts
       SET status = 'publishing', draft_media_id = $2, publish_id = $3,
           decided_at = NOW(), decided_by = $4, error = NULL
       WHERE id = $1`,
      [id, draftId, String(publishId), by]
    );
    return { submitted: true, publishId: String(publishId) };
  } catch (e) {
    await db.query(
      `UPDATE wechat_posts SET status = 'failed', error = $2, decided_at = NOW(), decided_by = $3
       WHERE id = $1`,
      [id, e.message, by]
    );
    throw e;
  }
}

async function skipById(id, by = "JJ") {
  await db.query(
    `UPDATE wechat_posts SET status = 'skipped', decided_at = NOW(), decided_by = $2
     WHERE id = $1 AND status = 'pending'`,
    [id, by]
  );
}

// ── Telegram buttons ─────────────────────────────────────
async function handleTelegramCallback(data, callbackQueryId, by = "JJ") {
  const m = String(data || "").match(/^wcpost_(go|no)_(\d+)$/);
  if (!m) return null;
  const [, verb, idStr] = m;
  const id = Number(idStr);

  if (verb === "no") {
    await skipById(id, by);
    return { answer: "Skipped — nothing was published." };
  }
  try {
    const out = await publishById(id, by);
    if (out.alreadyDone) return { answer: "Already handled." };
    return { answer: "Submitted to WeChat. I'll confirm when it lands." };
  } catch (e) {
    return { answer: "Failed: " + e.message.slice(0, 180) };
  }
}

// ── The callback that tells the truth ────────────────────
// Tencent pushes PUBLISHJOBFINISH to the message webhook once the article
// is really out. Status 0 is success; everything else is a reason it is not.
const PUBLISH_FAILURE = {
  1: "publishing",
  2: "rejected — original-article check",
  3: "rejected — routine check",
  4: "rejected — platform",
  5: "published, then deleted by the account",
};

async function handlePublishCallback(msg) {
  const info = msg && (msg.PublishEventInfo || msg.publisheventinfo);
  if (!info) return null;
  const publishId = String(info.publish_id || "");
  const status = Number(info.publish_status);
  if (!publishId) return null;

  if (status === 0) {
    const url = (info.article_detail && info.article_detail.item &&
      (Array.isArray(info.article_detail.item)
        ? info.article_detail.item[0]?.article_url
        : info.article_detail.item.article_url)) || null;
    await db.query(
      `UPDATE wechat_posts SET status = 'published', published_at = NOW(),
       article_url = COALESCE($2, article_url), error = NULL WHERE publish_id = $1`,
      [publishId, url]
    );
    await tellJJ(`✅ WeChat article is live.${url ? "\n" + url : ""}`);
    return { publishId, published: true, url };
  }

  const why = PUBLISH_FAILURE[status] || `status ${status}`;
  await db.query(
    `UPDATE wechat_posts SET status = 'failed', error = $2 WHERE publish_id = $1`,
    [publishId, why]
  );
  await tellJJ(`⚠️ WeChat did not publish the article: ${why}`);
  return { publishId, published: false, reason: why };
}

async function tellJJ(text) {
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: JJ_TELEGRAM_ID, text });
  } catch (e) { /* a lost notification must never fail a publish */ }
}

// ── Status, for the admin page ───────────────────────────
async function status() {
  const out = {
    configured: configured(),
    enabled: ENABLED,
    auto_publish: AUTO,
    default_cover: Boolean(defaultCover()),
    counts: {},
    recent: [],
  };
  try {
    const c = await db.query(`SELECT status, COUNT(*)::int AS n FROM wechat_posts GROUP BY status`);
    for (const row of c.rows) out.counts[row.status] = row.n;
    const r = await db.query(
      `SELECT id, title, status, article_url, error, created_at, published_at
       FROM wechat_posts ORDER BY id DESC LIMIT 10`
    );
    out.recent = r.rows;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

module.exports = {
  initTable,
  queueForApproval,
  publishById,
  skipById,
  handleTelegramCallback,
  handlePublishCallback,
  uploadCover,
  uploadInlineImage,
  createDraft,
  publishDraft,
  toWeChatHtml,
  makeDigest,
  status,
  // exported for the checks
  _internals: { MAX_TITLE, MAX_DIGEST, MAX_CONTENT, PUBLISH_FAILURE },
};
