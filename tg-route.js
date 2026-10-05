// ============================================================
//  tg-route.js — WHERE A FIRM ALERT LANDS
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  Before this file, twenty-seven modules each built their own
//  Telegram call and every one of them addressed JJ_TELEGRAM_ID.
//  Court notices, social posts, lead alerts and backup reports
//  all arrived in the same direct message, in the order they
//  happened, which is the same as arriving in no order at all.
//
//  This routes them instead. One supergroup with Topics turned
//  on; each category posts into its own topic thread. The group
//  is TG_OPS_CHAT_ID and each topic is a message_thread_id:
//
//    TG_TOPIC_COURT    Court & deadlines
//    TG_TOPIC_SOCIAL   Social & content
//    TG_TOPIC_LEADS    Leads & intake
//    TG_TOPIC_OPS      Ops & system
//
//  THE FALLBACK IS THE POINT. With none of those set, every
//  send goes to JJ_TELEGRAM_ID exactly as it did before. A
//  half-configured group must never turn into a silent alert —
//  the failure mode of a notification system is not noise, it
//  is a court date nobody was told about. The same applies per
//  topic: an unset topic lands in the group untopiced rather
//  than nowhere.
//
//  Use `scripts/tg-discover.js` to read the ids off a real
//  message once the group exists.
// ============================================================

// Lazy, matching broker-accounts.js: the pure helpers below (routeFor,
// describeRouting) can then be loaded and checked on a machine with no
// node_modules installed.
const axios = () => require("axios");

const TOPICS = {
  court:  { env: "TG_TOPIC_COURT",  label: "Court & deadlines" },
  social: { env: "TG_TOPIC_SOCIAL", label: "Social & content" },
  leads:  { env: "TG_TOPIC_LEADS",  label: "Leads & intake" },
  ops:    { env: "TG_TOPIC_OPS",    label: "Ops & system" },
};

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || null;
}

function dmChatId() {
  // RECIPIENT_JUE_TELEGRAM_ID is last, and only because several senders
  // already fell back to it. Preserved rather than tidied away: dropping
  // it would silence an alert on an install where it is the only id set.
  return process.env.JJ_TELEGRAM_ID
      || process.env.RECIPIENT_JJ_TELEGRAM_ID
      || process.env.RECIPIENT_JUE_TELEGRAM_ID
      || null;
}

/**
 * Where a topic's messages should go, as a chat_id and an optional
 * message_thread_id. Pure — no network, no env mutation — so the
 * routing table can be exercised in a check without a token.
 */
function routeFor(topic) {
  const group = (process.env.TG_OPS_CHAT_ID || "").trim();
  const spec = TOPICS[topic];

  if (group && spec) {
    // A topic id must be a number. Anything else — a topic's NAME pasted in
    // by mistake, a stray quote — is treated as unset, and `via` says so
    // rather than claiming a thread the message never reached.
    const thread = (process.env[spec.env] || "").trim();
    const usable = thread !== "" && /^-?\d+$/.test(thread);
    const out = { chat_id: group, via: usable ? "topic" : "group" };
    if (usable) out.message_thread_id = Number(thread);
    return out;
  }

  const dm = dmChatId();
  return dm ? { chat_id: dm, via: "dm" } : null;
}

/**
 * Send one alert. Never throws: a notifier that can bring down the
 * job it reports on is worse than no notifier. Returns true on a
 * delivered message, false otherwise, and says why in the log.
 */
async function send(topic, text, opts = {}) {
  const tok = token();
  const route = routeFor(topic);
  if (!tok || !route) {
    console.warn(`[tg-route] ${topic}: no ${!tok ? "token" : "destination"}; dropped`);
    return false;
  }

  const body = {
    chat_id: route.chat_id,
    text: String(text == null ? "" : text).slice(0, 3900),
    disable_web_page_preview: opts.disable_web_page_preview !== false,
  };
  if (route.message_thread_id) body.message_thread_id = route.message_thread_id;
  if (opts.parse_mode) body.parse_mode = opts.parse_mode;
  if (opts.reply_markup) body.reply_markup = opts.reply_markup;

  const url = `https://api.telegram.org/bot${tok}/sendMessage`;

  try {
    await axios().post(url, body, { timeout: 10000 });
    return true;
  } catch (e) {
    // A deleted or closed topic answers 400. Retry into the group
    // itself rather than losing the message — being in the wrong
    // thread beats not arriving.
    const status = e.response && e.response.status;
    if (body.message_thread_id && status === 400) {
      try {
        delete body.message_thread_id;
        await axios().post(url, body, { timeout: 10000 });
        console.warn(`[tg-route] ${topic}: topic thread rejected; sent to the group instead`);
        return true;
      } catch (e2) {
        console.warn(`[tg-route] ${topic}: ${e2.message}`);
        return false;
      }
    }
    console.warn(`[tg-route] ${topic}: ${e.message}`);
    return false;
  }
}

/**
 * Just the address, for senders that must keep their own posting logic —
 * the hearing-note senders chunk a long note across several messages and
 * throw on failure, and that behaviour should not be flattened into send().
 * Spread it into an existing payload:
 *
 *   const to = tgRoute.target("court");
 *   await axios.post(url, { ...to, text: chunk, parse_mode: "Markdown" });
 */
function target(topic) {
  const r = routeFor(topic);
  if (!r) return null;
  const out = { chat_id: r.chat_id };
  if (r.message_thread_id) out.message_thread_id = r.message_thread_id;
  return out;
}

/** A one-line view of where each topic currently points. */
function describeRouting() {
  return Object.keys(TOPICS).map(k => {
    const r = routeFor(k);
    return {
      topic: k,
      label: TOPICS[k].label,
      via: r ? r.via : "none",
      chat_id: r ? r.chat_id : null,
      message_thread_id: r ? r.message_thread_id || null : null,
    };
  });
}

/**
 * A photo or a video with a caption, to a topic. Same promises as send():
 * never throws, falls back to the group itself when the topic thread is
 * rejected, and to JJ's direct message when no group is configured.
 * kind is "photo" or "video". Returns true once Telegram has it.
 */
async function sendMedia(topic, kind, buffer, filename, caption, opts = {}) {
  const tok = token();
  const route = routeFor(topic);
  if (!tok || !route) {
    console.warn(`[tg-route] ${topic}: no ${!tok ? "token" : "destination"}; ${kind} dropped`);
    return false;
  }
  const method = kind === "video" ? "sendVideo" : "sendPhoto";
  const url = `https://api.telegram.org/bot${tok}/${method}`;
  const post = async (withThread) => {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("chat_id", String(route.chat_id));
    if (withThread && route.message_thread_id) form.append("message_thread_id", String(route.message_thread_id));
    form.append(kind === "video" ? "video" : "photo", buffer, { filename });
    if (caption) form.append("caption", String(caption).slice(0, 1020));
    if (kind === "video") form.append("supports_streaming", "true");
    if (opts.reply_markup) form.append("reply_markup", JSON.stringify(opts.reply_markup));
    await axios().post(url, form, { headers: form.getHeaders(), timeout: opts.timeout || 120000, maxBodyLength: Infinity });
  };
  try {
    await post(true);
    return true;
  } catch (e) {
    const status = e.response && e.response.status;
    if (route.message_thread_id && status === 400) {
      try {
        await post(false);
        console.warn(`[tg-route] ${topic}: topic thread rejected; ${kind} sent to the group instead`);
        return true;
      } catch (e2) { console.warn(`[tg-route] ${topic} ${kind}: ${e2.message}`); return false; }
    }
    console.warn(`[tg-route] ${topic} ${kind}: ${e.message}`);
    return false;
  }
}

module.exports = { send, sendMedia, target, routeFor, describeRouting, TOPICS };
