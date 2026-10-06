// tg-discover.js — read the chat id and topic thread ids off real messages.
//
// Telegram does not list a group's topics through the Bot API. The thread id
// only appears on a message sent inside that topic, so the way to learn them
// is to post once in each topic and read it back.
//
//   1. Create the supergroup, turn Topics on, add the bot as an admin.
//   2. Create the four topics: Court & deadlines, Social & content,
//      Leads & intake, Ops & system.
//   3. Post any word in each topic, from your own account.
//   4. node scripts/tg-discover.js
//
// THIS BOT RUNS ON A WEBHOOK, so getUpdates will almost certainly answer
// 409 and this script will tell you so. The working route is to send
// /whereami inside each topic — server.js answers with the ids. This
// script stays for installs that poll rather than use a webhook.
//
// Prints every chat and thread it saw, ready to paste as env vars.
//
// Note: getUpdates is useless while a webhook is set — it returns 409. If this
// reports that, the bot is in webhook mode and the ids have to come from the
// webhook payloads instead; the error message says as much.

const axios = require("axios");

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
if (!token) {
  console.error("No TELEGRAM_BOT_TOKEN / TELEGRAM_TOKEN in the environment.");
  process.exit(1);
}

(async () => {
  let updates;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`,
      { params: { limit: 100 }, timeout: 15000 });
    updates = r.data.result || [];
  } catch (e) {
    const status = e.response && e.response.status;
    if (status === 409) {
      console.error("getUpdates is blocked because a webhook is set (409).");
      console.error("Either read the ids from an incoming webhook payload, or");
      console.error("temporarily deleteWebhook, run this, and set it back.");
      process.exit(2);
    }
    console.error("getUpdates failed:", e.message);
    process.exit(2);
  }

  if (!updates.length) {
    console.log("No recent updates. Post a message in each topic, then re-run.");
    console.log("Telegram only keeps undelivered updates ~24h.");
    return;
  }

  const seen = new Map();
  for (const u of updates) {
    const m = u.message || u.channel_post || u.edited_message;
    if (!m || !m.chat) continue;
    const key = `${m.chat.id}:${m.message_thread_id || ""}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      chat_id: m.chat.id,
      chat_title: m.chat.title || m.chat.username || "(direct message)",
      chat_type: m.chat.type,
      thread_id: m.message_thread_id || null,
      topic_name: (m.reply_to_message && m.reply_to_message.forum_topic_created
                   && m.reply_to_message.forum_topic_created.name) || null,
      sample: String(m.text || "").slice(0, 40),
    });
  }

  console.log("\nWhat the bot has seen:\n");
  for (const v of seen.values()) {
    console.log(`  chat_id ${v.chat_id}  [${v.chat_type}]  ${v.chat_title}`);
    if (v.thread_id) {
      console.log(`    message_thread_id ${v.thread_id}` +
                  (v.topic_name ? `  — topic "${v.topic_name}"` : "") +
                  (v.sample ? `   (“${v.sample}”)` : ""));
    }
  }

  const group = [...seen.values()].find(v => v.chat_type === "supergroup");
  if (group) {
    console.log("\nLikely env vars:\n");
    console.log(`  TG_OPS_CHAT_ID=${group.chat_id}`);
    for (const v of seen.values()) {
      if (v.chat_id === group.chat_id && v.thread_id) {
        const guess = (v.topic_name || "").toLowerCase();
        // tg-route.js knows which setting a topic's name belongs to,
        // the four court divisions included.
        const name = require("../tg-route").envForTopicName(guess) || "TG_TOPIC_?";
        console.log(`  ${name}=${v.thread_id}` +
                    (name.endsWith("?") ? `   # topic "${v.topic_name || "unnamed"}"` : ""));
      }
    }
  }
  console.log("");
})();
