// ============================================================
//  zara-digest.js — the weekly review nudge
//  ─────────────────────────────────────────────────────────
//  Zara proposes lessons; a human approves them before any of
//  them reaches a prompt. JJ chose to be the only approver, which
//  is the right call for a law firm — the firm's judgment stays
//  his — but it creates a failure mode that is entirely silent.
//
//  Proposals accumulate in a tab nobody visits. Zara keeps making
//  the same mistake, the corrections keep arriving, nothing is
//  ever adopted, and the learning loop looks like it is working
//  because the proposals are being written. Nobody finds out for
//  months.
//
//  So the queue comes to him rather than waiting to be found.
//  Once a week, if and only if something is actually waiting.
//
//  Deliberately not a nag: no pending lessons means no message.
//  A digest that arrives every week regardless is one people stop
//  reading, and then it is worth less than nothing.
// ============================================================

const cron = require("node-cron");
const axios = require("axios");
const db = require("./db");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const JJ_TELEGRAM_ID = process.env.JJ_TELEGRAM_ID;
const ADMIN_URL = process.env.PUBLIC_ADMIN_URL || "https://tezlaw-bot.onrender.com";

/**
 * What is waiting, and what changed.
 *
 * Returns null when there is nothing worth sending, so the caller
 * can stay quiet rather than send an empty report.
 */
async function buildDigest({ days = 7 } = {}) {
  const core = require("./zara-core");
  await core.initTables();

  const pending = await db.query(
    `SELECT id, lesson, scope, source, proposed_by, created_at
       FROM zara_lessons
      WHERE status = 'proposed' AND retired_at IS NULL
      ORDER BY created_at ASC`
  );
  if (!pending.rows.length) return null;

  // Context, so the message says something beyond "you have a queue".
  const [approved, active, oldest] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS n FROM zara_lessons
        WHERE status = 'active' AND approved_at > NOW() - ($1 || ' days')::interval`,
      [String(days)]
    ).catch(() => ({ rows: [{ n: 0 }] })),
    db.query(
      `SELECT COUNT(*)::int AS n FROM zara_lessons
        WHERE status = 'active' AND retired_at IS NULL`
    ).catch(() => ({ rows: [{ n: 0 }] })),
    db.query(
      `SELECT MIN(created_at) AS t FROM zara_lessons
        WHERE status = 'proposed' AND retired_at IS NULL`
    ).catch(() => ({ rows: [{ t: null }] })),
  ]);

  const waitingDays = oldest.rows[0]?.t
    ? Math.floor((Date.now() - new Date(oldest.rows[0].t).getTime()) / 86400000)
    : 0;

  return {
    pending: pending.rows,
    approvedThisWeek: approved.rows[0]?.n || 0,
    activeTotal: active.rows[0]?.n || 0,
    oldestWaitingDays: waitingDays,
  };
}

function formatDigest(d) {
  const esc = t => String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines = [];
  lines.push(`<b>Zara has ${d.pending.length} lesson${d.pending.length === 1 ? "" : "s"} waiting for you</b>`);
  lines.push("");

  // The number that actually matters. A proposal sitting for three weeks
  // means she has been repeating a mistake you already corrected.
  if (d.oldestWaitingDays >= 14) {
    lines.push(`⚠️ The oldest has been waiting <b>${d.oldestWaitingDays} days</b>. Until it is approved she keeps making the mistake it came from.`);
    lines.push("");
  } else if (d.oldestWaitingDays >= 1) {
    lines.push(`<i>Oldest has waited ${d.oldestWaitingDays} day${d.oldestWaitingDays === 1 ? "" : "s"}.</i>`);
    lines.push("");
  }

  d.pending.slice(0, 12).forEach((l, i) => {
    lines.push(`${i + 1}. ${esc(l.lesson)}`);
    const from = l.source === "reflection" ? "from a correction" : `proposed by ${esc(l.proposed_by || "staff")}`;
    lines.push(`   <i>${esc(l.scope)} · ${from}</i>`);
  });
  if (d.pending.length > 12) {
    lines.push(`   <i>…and ${d.pending.length - 12} more.</i>`);
  }

  lines.push("");
  lines.push(`In her prompts now: <b>${d.activeTotal}</b>. Approved this week: <b>${d.approvedThisWeek}</b>.`);
  lines.push("");
  lines.push(`Approve or reject: ${ADMIN_URL}/admin/zara#lessons`);

  return lines.join("\n");
}

async function sendToJJ(text) {
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) {
    console.warn("[zara-digest] TELEGRAM_TOKEN or JJ_TELEGRAM_ID not set — digest not sent");
    return { sent: false, reason: "not configured" };
  }
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: JJ_TELEGRAM_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }, { timeout: 15000 });
  return { sent: true };
}

/** Run it now. Returns what happened, for the admin panel and for tests. */
async function runWeeklyDigest({ force = false } = {}) {
  try {
    const d = await buildDigest();
    if (!d) {
      console.log("[zara-digest] nothing pending — staying quiet");
      return { ok: true, sent: false, reason: "nothing pending" };
    }
    const text = formatDigest(d);
    if (force) return { ok: true, sent: false, preview: text, pending: d.pending.length };
    const out = await sendToJJ(text);
    console.log(`[zara-digest] ${d.pending.length} pending, sent=${out.sent}`);
    return { ok: true, pending: d.pending.length, ...out };
  } catch (e) {
    console.error("[zara-digest] failed:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Monday 08:00 Pacific. Start of the week, before the day fills up —
 * the point is that approving a handful of lessons is a five-minute job
 * if it happens weekly, and an hour-long chore if it happens quarterly.
 */
function scheduleZaraDigest() {
  if (process.env.ZARA_DIGEST === "off") {
    console.log("[zara-digest] disabled by ZARA_DIGEST=off");
    return;
  }
  cron.schedule("0 8 * * 1", () => { runWeeklyDigest().catch(() => {}); },
    { timezone: "America/Los_Angeles" });
  console.log("[zara-digest] scheduled — Mondays 08:00 Pacific, silent when nothing is pending");
}

module.exports = { scheduleZaraDigest, runWeeklyDigest, buildDigest, formatDigest };
