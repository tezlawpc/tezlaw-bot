// ============================================================
//  tg-ops.js — THE OPS GROUP'S HOUSE RULES
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  tg-route.js decides where an alert lands. This file decides how
//  the bot behaves once it is sitting in that group:
//
//  1. It stays quiet. The same bot is Zara for the public, and
//     without this every line a staff member typed in the group
//     was answered as if a client had written it, intake included.
//     In the ops group only a short list of commands is read.
//
//  2. Staff commands are for staff. /tasks, /done, /snooze and
//     /newtask used to answer anyone who messaged the bot, and the
//     bot is linked from the public contact page: a stranger could
//     read the open task list, client names included, and close
//     tasks. They now work in the ops group, and for JJ and
//     TG_APPROVER_IDS in a direct message, and nowhere else.
//
//  3. /routing shows where each kind of alert is going, and
//     /routing test posts one line into each topic, so a wrong
//     thread id is seen in a minute, not on the day a notice
//     goes missing.
//
//  Pure where it can be, so scripts/check-ops-chat.js can run it
//  with no network and no node_modules.
// ============================================================

const route = () => require("./tg-route");

function opsChatId() {
  return (process.env.TG_OPS_CHAT_ID || "").trim() || null;
}

function isOpsChat(chatId) {
  const g = opsChatId();
  return !!g && String(chatId) === g;
}

// The commands the bot will read inside the ops group. Anything else typed
// there is a colleague talking to a colleague, and is left alone.
const GROUP_COMMANDS = /^\/(chatid|whereami|routing|tasks|done|snooze|newtask)(@\w+)?(\s|$)/i;

function allowedInOpsGroup(text) {
  return GROUP_COMMANDS.test(String(text || "").trim());
}

// JJ, plus anyone listed in TG_APPROVER_IDS. Unlike the approval buttons,
// an empty list here means nobody: a missing env var must not open the task
// list to the public.
function staffIds() {
  return new Set(
    [process.env.JJ_TELEGRAM_ID, process.env.RECIPIENT_JJ_TELEGRAM_ID]
      .concat(String(process.env.TG_APPROVER_IDS || "").split(","))
      .map(v => String(v == null ? "" : v).trim())
      .filter(Boolean)
  );
}

function mayUseStaffCommands(from, chatId) {
  if (isOpsChat(chatId)) return true;
  return staffIds().has(String((from && from.id) || ""));
}

// Where to answer a message: the same chat, and inside the ops group the
// same topic it was typed in. Returns a plain chat id everywhere else, so
// existing callers that expect a string still get one.
function replyDest(msg) {
  const chatId = String(msg && msg.chat ? msg.chat.id : "");
  if (isOpsChat(chatId) && msg.message_thread_id) {
    return { chat_id: chatId, message_thread_id: msg.message_thread_id };
  }
  return chatId;
}

function payloadFor(dest) {
  return (dest && typeof dest === "object") ? { ...dest } : { chat_id: dest };
}

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || null;
}

// A plain-text reply to wherever `dest` points. Never throws.
async function reply(dest, text) {
  const tok = token();
  if (!tok || !dest) return false;
  const url = `https://api.telegram.org/bot${tok}/sendMessage`;
  const body = { ...payloadFor(dest), text: String(text).slice(0, 3900), disable_web_page_preview: true };
  try {
    await require("axios").post(url, body, { timeout: 10000 });
    return true;
  } catch (e) {
    const status = e.response && e.response.status;
    if (body.message_thread_id && status === 400) {
      try { delete body.message_thread_id; await require("axios").post(url, body, { timeout: 10000 }); return true; }
      catch (e2) { console.warn("[tg-ops] reply:", e2.message); return false; }
    }
    console.warn("[tg-ops] reply:", e.message);
    return false;
  }
}

// ── /routing ────────────────────────────────────────────────

function describe() {
  const rows = route().describeRouting();
  const group = opsChatId();
  const lines = ["Where alerts go", ""];
  for (const r of rows) {
    const env = route().TOPICS[r.topic].env;
    let where;
    if (r.via === "topic")      where = `its own topic in the group (thread ${r.message_thread_id})`;
    else if (r.via === "parent") where = `the ${route().TOPICS[r.parent].label} topic for now. Set ${env} to give it its own topic.`;
    else if (r.via === "group") where = `the group, with no topic. Set ${env} to the topic's thread id.`;
    else if (r.via === "dm")    where = "JJ's direct messages, because no group is set";
    else                        where = "NOWHERE. Neither a group nor JJ's id is set.";
    lines.push(`${r.parent ? "   " : ""}${r.label}: ${where}`);
  }
  lines.push("");
  lines.push(group ? `Group: ${group}` : "Group: not set (TG_OPS_CHAT_ID). Send /whereami inside the group to get its id.");
  lines.push("");
  lines.push("Court notices are sorted by the court they come from. One that names no court stays in Court & deadlines.");
  lines.push("");
  lines.push("Always direct to JJ, never the group: distress alerts and admin sign-in approvals.");
  lines.push("");
  lines.push("/routing test posts one line into each topic.");
  return lines.join("\n");
}

async function test() {
  const rows = route().describeRouting();
  const out = ["Routing test", ""];
  for (const r of rows) {
    if (r.via === "none") { out.push(`${r.label}: not sent, nothing is configured`); continue; }
    const ok = await route().send(r.topic,
      r.via === "parent"
        ? `Routing test for ${r.label}. It has no topic of its own yet, so it arrives here.`
        : `Routing test for ${r.label}. If you are reading this in the ${r.label} topic, it is set up correctly.`);
    out.push(`${r.label}: ${ok ? "sent" : "FAILED, see the server log for [tg-route]"}` +
             (ok && r.via === "parent" ? ` (to ${route().TOPICS[r.parent].label}, its own topic is not set yet)` : "") +
             (ok && r.via === "group" ? " (to the group itself, no topic set)" : "") +
             (ok && r.via === "dm" ? " (to JJ's direct messages, no group set)" : ""));
  }
  return out.join("\n");
}

/**
 * Handle /routing and /routing test. Returns true when the message was this
 * command (handled or refused), false when it is something else.
 */
async function handleRouting(msg) {
  const text = String((msg && (msg.text || msg.caption)) || "").trim();
  const m = text.match(/^\/routing(@\w+)?(?:\s+(\S+))?\s*$/i);
  if (!m) return false;
  const chatId = String(msg.chat.id);
  const dest = replyDest(msg);
  if (!mayUseStaffCommands(msg.from, chatId)) {
    await reply(dest, "Sorry, that command is restricted.");
    return true;
  }
  if ((m[2] || "").toLowerCase() === "test") await reply(dest, await test());
  else await reply(dest, describe());
  return true;
}

module.exports = {
  isOpsChat, allowedInOpsGroup, mayUseStaffCommands, staffIds,
  replyDest, payloadFor, reply, describe, test, handleRouting,
};
