// ============================================================
//  TEZ LAW P.C. — AUTOMATED HEARING REMINDERS
//  ─────────────────────────────────────────────────────────
//  Sends automated reminders to clients before their hearings.
//  Runs daily at 7:00 AM Pacific and looks for hearings that
//  are exactly 7 days out and 1 day out.
//
//  Sources:
//  - hearing_notes.next_hearing_date (master)
//  - individual_hearing_notes.next_hearing_date
//  - client_hearing_notices.hearing_date (auto-detected from Dropbox)
//
//  Channels:
//  - WhatsApp (preferred if phone number available)
//  - SMS via Twilio (fallback)
//
//  Idempotent: reminder_log table prevents double-sends.
//  Telegram alert to JJ with daily summary after each run.
// ============================================================

const db = require("./db");
const axios = require("axios");

const TIMEZONE_OFFSET_HOURS = -8;   // Pacific (adjust for DST manually if needed)

// ── Schema ───────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS hearing_reminder_log (
      id                SERIAL PRIMARY KEY,
      hearing_source    TEXT NOT NULL,       -- 'master', 'individual', 'notice'
      hearing_source_id INTEGER NOT NULL,
      client_key        TEXT,
      client_name       TEXT,
      hearing_date      TIMESTAMPTZ,
      days_out          INTEGER,             -- 7 or 1
      channel           TEXT,                -- 'whatsapp', 'sms', 'skipped'
      recipient         TEXT,                -- phone number sent to
      sent_at           TIMESTAMPTZ DEFAULT NOW(),
      success           BOOLEAN,
      error_message     TEXT
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_dedup
      ON hearing_reminder_log (hearing_source, hearing_source_id, days_out)
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_reminder_date ON hearing_reminder_log (sent_at DESC)`);
}

// ── Query upcoming hearings from all sources ─────────────

async function getUpcomingHearings(daysOut) {
  // Compute the target date window: exactly `daysOut` days from now.
  // We match anything from midnight to midnight in Pacific timezone.
  const now = new Date();
  const target = new Date(now.getTime() + daysOut * 24 * 60 * 60 * 1000);
  const dateStr = target.toISOString().substring(0, 10);   // YYYY-MM-DD
  const startOfDay = new Date(dateStr + "T00:00:00Z");
  const endOfDay = new Date(dateStr + "T23:59:59Z");

  const hearings = [];

  // Master hearings (from hearing_notes.next_hearing_date)
  try {
    const master = await db.query(
      `SELECT id, client_name, a_number, client_language, client_phone, client_email,
              next_hearing_date AS hearing_date, next_hearing_type AS hearing_type,
              judge_name
       FROM hearing_notes
       WHERE next_hearing_date IS NOT NULL
         AND next_hearing_date >= $1
         AND next_hearing_date < $2`,
      [startOfDay.toISOString(), endOfDay.toISOString()]
    );
    for (const row of master.rows) {
      hearings.push({ ...row, source: "master", source_id: row.id });
    }
  } catch (e) { console.warn("[reminders] master query failed:", e.message); }

  // Individual hearings
  try {
    const indiv = await db.query(
      `SELECT id, client_name, a_number, client_language, client_phone, client_email,
              next_hearing_date AS hearing_date, next_hearing_type AS hearing_type,
              judge_name
       FROM individual_hearing_notes
       WHERE next_hearing_date IS NOT NULL
         AND next_hearing_date >= $1
         AND next_hearing_date < $2`,
      [startOfDay.toISOString(), endOfDay.toISOString()]
    );
    for (const row of indiv.rows) {
      hearings.push({ ...row, source: "individual", source_id: row.id });
    }
  } catch (e) { console.warn("[reminders] individual query failed:", e.message); }

  // Detected hearing notices (from Dropbox scans)
  try {
    const notices = await db.query(
      `SELECT n.id, n.client_name, n.a_number, n.hearing_date,
              n.hearing_type, n.court_name, n.court_address, n.judge_name,
              n.client_key
       FROM client_hearing_notices n
       WHERE n.is_hearing_notice = TRUE
         AND n.dismissed_at IS NULL
         AND n.hearing_date >= $1
         AND n.hearing_date < $2`,
      [startOfDay.toISOString(), endOfDay.toISOString()]
    );
    for (const row of notices.rows) {
      // Enrich with client contact info from the hearing_notes tables
      const clientInfo = await getClientContactInfo(row.client_name, row.a_number);
      hearings.push({
        ...row,
        ...clientInfo,
        source: "notice",
        source_id: row.id,
      });
    }
  } catch (e) { console.warn("[reminders] notices query failed:", e.message); }

  return hearings;
}

async function getClientContactInfo(clientName, aNumber) {
  const info = { client_phone: null, client_email: null, client_language: "en" };
  try {
    // Look up most recent hearing note for this client to get phone/email/language
    const r = await db.query(
      `SELECT client_phone, client_email, client_language
       FROM (
         SELECT client_phone, client_email, client_language, created_at FROM hearing_notes
         WHERE ($1 IS NOT NULL AND client_name = $1) OR ($2 IS NOT NULL AND a_number = $2)
         UNION ALL
         SELECT client_phone, client_email, client_language, created_at FROM individual_hearing_notes
         WHERE ($1 IS NOT NULL AND client_name = $1) OR ($2 IS NOT NULL AND a_number = $2)
       ) x
       WHERE (client_phone IS NOT NULL OR client_email IS NOT NULL)
       ORDER BY created_at DESC LIMIT 1`,
      [clientName || null, aNumber || null]
    );
    if (r.rows[0]) {
      Object.assign(info, r.rows[0]);
      info.client_language = info.client_language || "en";
    }
  } catch (e) { /* silent */ }
  return info;
}

// ── Reminder message templates ────────────────────────────

function buildReminderMessage(hearing, daysOut, lang = "en") {
  const langKey = ["en", "zh", "es"].includes(lang) ? lang : "en";
  const templates = TEMPLATES[langKey];
  const dateStr = formatDateForLang(hearing.hearing_date, langKey);
  const typeStr = prettyType(hearing.hearing_type, langKey);
  const courtLine = hearing.court_name || hearing.court_address || "";
  const judgeLine = hearing.judge_name || "";

  if (daysOut === 7) {
    return templates.sevenDay({ date: dateStr, type: typeStr, court: courtLine, judge: judgeLine });
  } else {
    return templates.oneDay({ date: dateStr, type: typeStr, court: courtLine, judge: judgeLine });
  }
}

const TEMPLATES = {
  en: {
    sevenDay: ({ date, type, court, judge }) =>
      `Hi from TEZ LAW FIRM. This is a reminder that you have your ${type} hearing in ONE WEEK:

📅 ${date}
${court ? `📍 ${court}\n` : ""}${judge ? `⚖️ Judge ${judge}\n` : ""}
Please:
1. Confirm you can attend (reply YES)
2. Review any documents your case manager sent
3. Plan to arrive 30 minutes early with government ID

Questions? Reply to this message or call 626-678-8677.

— TEZ LAW FIRM`,

    oneDay: ({ date, type, court, judge }) =>
      `URGENT REMINDER from TEZ LAW FIRM: Your ${type} hearing is TOMORROW:

📅 ${date}
${court ? `📍 ${court}\n` : ""}${judge ? `⚖️ Judge ${judge}\n` : ""}
IMPORTANT:
✓ Arrive 30 minutes early
✓ Bring government-issued ID
✓ Dress professionally
✓ NO phones/food/drinks in courtroom

If you CANNOT attend, call 626-678-8677 IMMEDIATELY. Missing your hearing can result in a removal order.

— TEZ LAW FIRM`,
  },
  zh: {
    sevenDay: ({ date, type, court, judge }) =>
      `您好，这里是TEZ律师事务所。提醒您：您的${type}庭审将在一周后举行：

📅 ${date}
${court ? `📍 ${court}\n` : ""}${judge ? `⚖️ ${judge} 法官\n` : ""}
请：
1. 确认您能出席（回复"是"）
2. 查看案件经理发送的文件
3. 提前30分钟到达并携带政府颁发的身份证件

如有疑问，请回复此消息或致电 626-678-8677。

— TEZ律师事务所`,

    oneDay: ({ date, type, court, judge }) =>
      `紧急提醒来自TEZ律师事务所：您的${type}庭审将在明天举行：

📅 ${date}
${court ? `📍 ${court}\n` : ""}${judge ? `⚖️ ${judge} 法官\n` : ""}
重要事项：
✓ 提前30分钟到达
✓ 携带政府颁发的身份证件
✓ 穿着专业得体
✓ 法庭内禁止携带手机/食物/饮料

如果您无法出席，请立即致电 626-678-8677。错过庭审可能导致驱逐令。

— TEZ律师事务所`,
  },
  es: {
    sevenDay: ({ date, type, court, judge }) =>
      `Saludos de TEZ LAW FIRM. Le recordamos que su audiencia de ${type} es en UNA SEMANA:

📅 ${date}
${court ? `📍 ${court}\n` : ""}${judge ? `⚖️ Juez ${judge}\n` : ""}
Por favor:
1. Confirme su asistencia (responda SÍ)
2. Revise los documentos enviados por su gestor de caso
3. Llegue 30 minutos antes con identificación oficial

¿Preguntas? Responda a este mensaje o llame al 626-678-8677.

— TEZ LAW FIRM`,

    oneDay: ({ date, type, court, judge }) =>
      `RECORDATORIO URGENTE de TEZ LAW FIRM: Su audiencia de ${type} es MAÑANA:

📅 ${date}
${court ? `📍 ${court}\n` : ""}${judge ? `⚖️ Juez ${judge}\n` : ""}
IMPORTANTE:
✓ Llegue 30 minutos antes
✓ Traiga identificación oficial
✓ Vístase profesionalmente
✓ NO se permiten teléfonos/comida/bebida en la sala

Si NO puede asistir, llame al 626-678-8677 INMEDIATAMENTE. Faltar a su audiencia puede resultar en una orden de deportación.

— TEZ LAW FIRM`,
  },
};

function prettyType(t, lang) {
  const map = {
    en: { master: "Master Calendar", individual: "Individual/Merits", bond: "Bond", status: "Status", biometrics: "Biometrics", interview: "Interview" },
    zh: { master: "主听证", individual: "个人/庭审", bond: "保释", status: "状态", biometrics: "指纹采集", interview: "面谈" },
    es: { master: "Calendario Maestro", individual: "Individual/Méritos", bond: "Fianza", status: "Estado", biometrics: "Biometría", interview: "Entrevista" },
  };
  return (map[lang] || map.en)[t] || (lang === "en" ? "hearing" : lang === "zh" ? "庭审" : "audiencia");
}

function formatDateForLang(dt, lang) {
  if (!dt) return "";
  const d = new Date(dt);
  if (isNaN(d)) return String(dt);
  const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  const locale = { en: "en-US", zh: "zh-CN", es: "es-MX" }[lang] || "en-US";
  return d.toLocaleString(locale, opts);
}

// ── Sending — WhatsApp via Meta Business API ─────────────

async function sendViaWhatsApp(phone, message) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("WhatsApp not configured (WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID)");
  }
  const cleanPhone = String(phone).replace(/[^\d]/g, "");
  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: cleanPhone,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

async function sendViaSms(phone, message) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
  if (!twilioSid || !twilioToken || !twilioFrom) {
    throw new Error("Twilio not configured");
  }
  const cleanPhone = String(phone).replace(/[^\d]/g, "");
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
    new URLSearchParams({ From: twilioFrom, To: "+" + cleanPhone, Body: message }).toString(),
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    }
  );
}

// ── Main scheduling logic ────────────────────────────────

// Process reminders for a specific days-out window (7 or 1).
async function processRemindersForWindow(daysOut) {
  await initTable();
  const hearings = await getUpcomingHearings(daysOut);
  const results = { hearings_found: hearings.length, sent: 0, skipped_no_phone: 0, skipped_already_sent: 0, errors: 0 };

  for (const h of hearings) {
    try {
      // Check if we already sent a reminder for this hearing at this window
      const existing = await db.query(
        `SELECT id FROM hearing_reminder_log WHERE hearing_source = $1 AND hearing_source_id = $2 AND days_out = $3`,
        [h.source, h.source_id, daysOut]
      );
      if (existing.rows.length) { results.skipped_already_sent++; continue; }

      if (!h.client_phone) {
        await db.query(
          `INSERT INTO hearing_reminder_log
             (hearing_source, hearing_source_id, client_key, client_name, hearing_date, days_out, channel, success, error_message)
           VALUES ($1, $2, $3, $4, $5, $6, 'skipped', FALSE, 'no phone number')
           ON CONFLICT DO NOTHING`,
          [h.source, h.source_id, h.client_key || null, h.client_name, h.hearing_date, daysOut]
        );
        results.skipped_no_phone++;
        continue;
      }

      const message = buildReminderMessage(h, daysOut, h.client_language || "en");
      let channelUsed = null, error = null, success = false;

      // Try WhatsApp first, fall back to SMS
      try {
        await sendViaWhatsApp(h.client_phone, message);
        channelUsed = "whatsapp";
        success = true;
      } catch (waErr) {
        console.warn(`[reminders] WhatsApp failed for ${h.client_name}, trying SMS:`, waErr.message);
        try {
          await sendViaSms(h.client_phone, message);
          channelUsed = "sms";
          success = true;
        } catch (smsErr) {
          error = `WhatsApp: ${waErr.message} | SMS: ${smsErr.message}`;
          channelUsed = "failed";
        }
      }

      await db.query(
        `INSERT INTO hearing_reminder_log
           (hearing_source, hearing_source_id, client_key, client_name, hearing_date, days_out, channel, recipient, success, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [h.source, h.source_id, h.client_key || null, h.client_name, h.hearing_date, daysOut, channelUsed, h.client_phone, success, error]
      );

      if (success) results.sent++;
      else results.errors++;
    } catch (e) {
      console.error(`[reminders] error processing ${h.client_name}:`, e.message);
      results.errors++;
    }
  }

  return results;
}

// Run reminders for both windows (7 days and 1 day out)
async function runDailyReminders() {
  console.log("[reminders] Starting daily run at", new Date().toISOString());
  const sevenDay = await processRemindersForWindow(7);
  const oneDay = await processRemindersForWindow(1);

  const summary = `📅 Daily hearing reminder summary:

7-day window:
  Hearings: ${sevenDay.hearings_found}
  ✓ Sent: ${sevenDay.sent}
  ⚠️ No phone: ${sevenDay.skipped_no_phone}
  ✓ Already sent: ${sevenDay.skipped_already_sent}
  ❌ Errors: ${sevenDay.errors}

1-day window (URGENT):
  Hearings: ${oneDay.hearings_found}
  ✓ Sent: ${oneDay.sent}
  ⚠️ No phone: ${oneDay.skipped_no_phone}
  ✓ Already sent: ${oneDay.skipped_already_sent}
  ❌ Errors: ${oneDay.errors}`;

  console.log(summary);

  // Alert JJ via Telegram
  try {
    await sendTelegramAlert(summary);
  } catch (e) {
    console.warn("[reminders] Telegram alert failed:", e.message);
  }

  return { sevenDay, oneDay };
}

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const jjChatId = process.env.RECIPIENT_JJ_TELEGRAM_ID || process.env.RECIPIENT_JUE_TELEGRAM_ID;
  if (!token || !jjChatId) return;
  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: jjChatId, text: message },
    { timeout: 10000 }
  );
}

// ── Cron scheduler ────────────────────────────────────────

// Node's setInterval-based scheduler. Runs every hour and checks if
// it's the right time to fire reminders (7 AM Pacific).
let _lastRunDate = null;
function startCron() {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000;    // check every hour

  async function tick() {
    try {
      const now = new Date();
      // Convert to Pacific approximately (server likely in UTC)
      const pacificHour = (now.getUTCHours() + TIMEZONE_OFFSET_HOURS + 24) % 24;
      const dateKey = now.toISOString().substring(0, 10);
      // Fire at 7 AM Pacific, once per day
      if (pacificHour === 7 && _lastRunDate !== dateKey) {
        _lastRunDate = dateKey;
        console.log("[reminders] cron trigger at", now.toISOString());
        await runDailyReminders();
      }
    } catch (e) {
      console.error("[reminders] cron tick error:", e.message);
    }
  }

  // Run first tick after startup, then every hour
  setTimeout(tick, 60 * 1000);
  setInterval(tick, CHECK_INTERVAL_MS);
  console.log("✅ Hearing reminder cron scheduled (7 AM Pacific daily)");
}

// ── Recent runs / stats for admin viewer ─────────────────

async function getRecentReminders(limit = 50) {
  await initTable();
  const r = await db.query(
    `SELECT id, hearing_source, hearing_source_id, client_name, hearing_date,
            days_out, channel, recipient, sent_at, success, error_message
     FROM hearing_reminder_log
     ORDER BY sent_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getStats() {
  await initTable();
  const r = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE success = TRUE)::int AS sent,
       COUNT(*) FILTER (WHERE channel = 'whatsapp' AND success = TRUE)::int AS whatsapp_sent,
       COUNT(*) FILTER (WHERE channel = 'sms' AND success = TRUE)::int AS sms_sent,
       COUNT(*) FILTER (WHERE success = FALSE AND channel != 'skipped')::int AS failed,
       COUNT(*) FILTER (WHERE channel = 'skipped')::int AS skipped,
       COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '7 days')::int AS last_7_days
     FROM hearing_reminder_log`
  );
  return r.rows[0];
}

module.exports = {
  initTable,
  startCron,
  runDailyReminders,
  processRemindersForWindow,
  getUpcomingHearings,
  buildReminderMessage,
  getRecentReminders,
  getStats,
};
