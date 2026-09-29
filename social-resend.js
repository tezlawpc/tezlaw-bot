// ============================================================
//  social-resend.js — bring waiting social posts back to the top of Telegram
//
//  JJ shouldn't have to scroll back through Telegram to find a post. This
//  does two things:
//
//  1. Posts JJ already approved that never reached Postiz (the channel wasn't
//     connected yet, or the approval happened before a fix) are scheduled now.
//     They were approved, so no new tap is asked for. approve() is idempotent:
//     anything already delivered, or still not deliverable, is left alone.
//  2. Posts still waiting for a decision (pending, or failed and waiting for a
//     retry) are sent again as fresh cards with the same buttons.
//
//  Runs once a minute after each deploy (each waiting post is re-sent only
//  once that way), and whenever JJ sends /posts (always re-sends).
//  Looks back 3 days by default.
// ============================================================

const db = require("./db");

const TOKEN = () => process.env.TELEGRAM_TOKEN;
const JJ = () => process.env.JJ_TELEGRAM_ID;
const TG = () => `https://api.telegram.org/bot${TOKEN()}`;

async function send(text, reply_markup = null) {
  if (!TOKEN() || !JJ()) return false;
  try {
    await require("axios").post(`${TG()}/sendMessage`, { chat_id: JJ(), text: String(text).slice(0, 3900),
      disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) }, { timeout: 10000 });
    return true;
  } catch (e) { console.warn("[social-resend] telegram:", e.message); return false; }
}
async function sendPhoto(buffer, caption, reply_markup = null) {
  if (!TOKEN() || !JJ()) return false;
  try {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("chat_id", String(JJ()));
    form.append("photo", buffer, { filename: "card.png" });
    if (caption) form.append("caption", String(caption).slice(0, 1020));
    if (reply_markup) form.append("reply_markup", JSON.stringify(reply_markup));
    await require("axios").post(`${TG()}/sendPhoto`, form, { headers: form.getHeaders(), timeout: 60000, maxBodyLength: Infinity });
    return true;
  } catch (e) { console.warn("[social-resend] telegram photo:", e.message); return false; }
}

const name = (S, ch) => ch === "video" ? "Video · YouTube Shorts + TikTok" : ((S.CHANNELS[ch] || {}).name || ch);
const fmt = d => new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PT";

let ready = null;
function initColumn() {
  if (!ready) ready = db.query(`ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS resent_at TIMESTAMPTZ`).catch(e => { ready = null; throw e; });
  return ready;
}

/**
 * { force } — /posts: re-send every waiting post. Without it (after a deploy),
 * each waiting post is re-sent at most once.
 * Returns { scheduled: [...], waiting: n }.
 */
async function resend({ force = false, days = 3 } = {}) {
  const S = require("./social-posts");
  await S.initTable();
  await initColumn();

  // 1. Approved but never delivered → schedule now.
  const scheduled = [];
  const late = (await db.query(
    `SELECT id, channel FROM social_posts
      WHERE status = 'approved' AND delivered IS NULL AND channel <> 'wechat_moments'
        AND created_at > NOW() - ($1 || ' days')::interval ORDER BY id`, [String(days)])).rows;
  for (const row of late) {
    try {
      const r = await S.approve(row.id, "JJ");
      if (r && r.ok && r.delivered) {
        for (const [ch, d] of Object.entries(r.delivered)) if (d && d.date) scheduled.push(`• ${name(S, ch)}: ${fmt(d.date)}`);
      }
    } catch (e) { console.warn(`[social-resend] post ${row.id}:`, e.message); }
  }

  // 2. Waiting for a decision → send the card again with buttons.
  const waiting = (await db.query(
    `SELECT * FROM social_posts
      WHERE status IN ('pending', 'error') AND created_at > NOW() - ($1 || ' days')::interval
        ${force ? "" : "AND resent_at IS NULL"} ORDER BY id`, [String(days)])).rows;

  if (!scheduled.length && !waiting.length) {
    if (force) await send("Nothing waiting. Every social post from the last 3 days is scheduled, posted or skipped.");
    return { scheduled, waiting: 0 };
  }

  const head = ["📣 Social posts, back on top"];
  if (scheduled.length) head.push("", "🗓 Scheduled in Postiz just now (you'd already approved these):", ...scheduled);
  if (waiting.length) head.push("", `${waiting.length} waiting for your tap, below.`);
  await send(head.join("\n"));

  for (const p of waiting) {
    const label = name(S, p.channel);
    const kb = { inline_keyboard: [[
      { text: p.status === "error" ? "🔁 Try again" : `✅ Post to ${label}`, callback_data: `soc_go_${p.id}` },
      { text: "🚫 Skip", callback_data: `soc_no_${p.id}` }]] };
    const note = p.status === "error" && p.error ? `\n\n⚠️ Last try: ${p.error}` : "";
    const body = `${label}${note}\n\n${p.text}`;
    let sent = false;
    if (p.media && p.media.card && S.CARD_FORMAT[p.channel]) {
      try {
        const img = S.renderCard(p.media.card, p.channel);
        if (body.length <= 1020) sent = await sendPhoto(img, body, kb);
        else { await sendPhoto(img, `${label} — card`); sent = await send(body, kb); }
      } catch (e) { console.warn("[social-resend] card:", e.message); }
    }
    if (!sent) sent = await send(body, kb);
    if (sent) await db.query(`UPDATE social_posts SET resent_at = NOW() WHERE id = $1`, [p.id]);
  }
  return { scheduled, waiting: waiting.length };
}

module.exports = { resend, send, sendPhoto };
