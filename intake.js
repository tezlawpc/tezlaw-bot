// ============================================================
//  intake.js — Conversational Intake Form for Zara
//  Tez Law P.C.
//  Notifies team via Telegram group (no email needed)
// ============================================================

const axios = require("axios");
const db    = require("./db");

// ── In-memory intake state per user ──────────────────────────
const intakeState = {};

// ── Phrases that trigger intake flow ─────────────────────────
const INTAKE_TRIGGERS = [
  "i need help", "i want to talk", "i want to speak", "schedule a consultation",
  "schedule an appointment", "book a consultation", "free consultation",
  "speak to an attorney", "speak to a lawyer", "talk to someone",
  "call me", "contact me", "follow up", "get in touch",
  "i'm ready", "let's get started", "how do i start",
  "what do i need to do", "how much does it cost", "how much do you charge",
  "quiero hablar", "necesito ayuda", "llamarme", "consulta",
  "我想咨询", "联系我", "预约", "需要帮助",
];

function shouldTriggerIntake(message) {
  const m = message.toLowerCase();
  return INTAKE_TRIGGERS.some(t => m.includes(t));
}

// ── Intake flow questions (3 steps) ──────────────────────────
const INTAKE_STEPS = [
  {
    key: "name",
    question: {
      en: "I'd love to get you connected with our team! First, what's your name?",
      es: "¡Me encantaría conectarte con nuestro equipo! Primero, ¿cómo te llamas?",
      zh: "我很乐意帮你联系我们的团队！首先，请问你叫什么名字？",
    }
  },
  {
    key: "issue",
    question: {
      en: "Nice to meet you, {name}! In a sentence or two, what do you need help with?",
      es: "¡Mucho gusto, {name}! En pocas palabras, ¿en qué necesitas ayuda?",
      zh: "很高兴认识你，{name}！简单说一下，你需要什么方面的帮助？",
    }
  },
  {
    key: "contact",
    question: {
      en: "Got it. What's the best phone number or email to reach you? The team will follow up within 1 business day.",
      es: "Entendido. ¿Cuál es el mejor número de teléfono o correo para contactarte? El equipo se pondrá en contacto en 1 día hábil.",
      zh: "明白了。请留下你的电话号码或电子邮件，我们的团队会在1个工作日内联系你。",
    }
  },
];

async function getClientLang(platform, platformId) {
  try {
    const client = await db.getOrCreateClient(platform, platformId, "en");
    return client?.preferred_language || "en";
  } catch { return "en"; }
}

// ── Main: check if intake should run ─────────────────────────
async function checkIntake(platform, platformId, userMessage) {
  const stateKey = `${platform}:${platformId}`;
  const state = intakeState[stateKey];

  // Already in flow — process the answer
  if (state && state.step < INTAKE_STEPS.length) {
    return { triggered: true, message: await processIntakeStep(platform, platformId, userMessage) };
  }

  // Flow completed — don't retrigger
  if (state && state.completed) return { triggered: false };

  // Check if message triggers intake
  if (shouldTriggerIntake(userMessage)) {
    const lang = await getClientLang(platform, platformId);
    intakeState[stateKey] = { step: 0, lang, data: {} };
    const q = INTAKE_STEPS[0].question[lang] || INTAKE_STEPS[0].question.en;
    return { triggered: true, message: q };
  }

  return { triggered: false };
}

// ── Process each step ─────────────────────────────────────────
async function processIntakeStep(platform, platformId, userMessage) {
  const stateKey = `${platform}:${platformId}`;
  const state    = intakeState[stateKey];
  const step     = INTAKE_STEPS[state.step];
  const lang     = state.lang;

  // Save the answer
  state.data[step.key] = userMessage.trim();
  state.step++;

  // More steps remaining
  if (state.step < INTAKE_STEPS.length) {
    let q = INTAKE_STEPS[state.step].question[lang] || INTAKE_STEPS[state.step].question.en;
    q = q.replace("{name}", state.data.name || "");
    return q;
  }

  // All steps done — finish
  state.completed = true;
  await finishIntake(platform, platformId, state.data, lang);

  const confirmations = {
    en: `✅ Got it! Here's a summary:\n\n👤 Name: ${state.data.name}\n📋 Issue: ${state.data.issue}\n📞 Contact: ${state.data.contact}\n\nI've notified the team and someone will reach out within 1 business day. Feel free to keep asking questions in the meantime! 😊`,
    es: `✅ ¡Listo! Aquí hay un resumen:\n\n👤 Nombre: ${state.data.name}\n📋 Problema: ${state.data.issue}\n📞 Contacto: ${state.data.contact}\n\nLe avisé al equipo y alguien se comunicará en 1 día hábil. ¡Puedes seguir haciendo preguntas! 😊`,
    zh: `✅ 好的！以下是摘要：\n\n👤 姓名：${state.data.name}\n📋 问题：${state.data.issue}\n📞 联系方式：${state.data.contact}\n\n我已通知团队，将在1个工作日内联系您。欢迎继续提问！😊`,
  };

  return confirmations[lang] || confirmations.en;
}

// ── Case type detection ───────────────────────────────────────
function detectCaseType(text) {
  if (!text) return "General";
  const t = text.toLowerCase();
  if (/immigra|visa|green card|citizen|deport|asylum|daca|uscis|work permit/.test(t)) return "Immigration";
  if (/accident|crash|injury|hurt|hospital|car|slip|fall/.test(t))                    return "Personal Injury";
  if (/business|contract|lawsuit|sue|litigation|employment/.test(t))                  return "Business Litigation";
  if (/patent|trademark|copyright/.test(t))                                           return "Patents & Trademarks";
  if (/trust|will|estate|probate|inheritance/.test(t))                                return "Estate Planning";
  return "General";
}

function getRoutedAttorney(caseType) {
  const routing = {
    "Immigration":          "Jue Wang / Michael Liu",
    "Personal Injury":      "Lin Mei",
    "Business Litigation":  "JJ Zhang",
    "Patents & Trademarks": "JJ Zhang",
    "Estate Planning":      "JJ Zhang",
    "General":              "JJ Zhang",
  };
  return routing[caseType] || "JJ Zhang";
}

// ── Save to DB and notify Telegram group ─────────────────────
async function finishIntake(platform, platformId, data, lang) {
  try {
    // Save to PostgreSQL
    await db.saveIntake(platform, platformId, data);

    // Update client record with name + contact info
    const updates = { name: data.name };
    const emailMatch = data.contact?.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const phoneMatch = data.contact?.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
    if (emailMatch) updates.email = emailMatch[0];
    if (phoneMatch) updates.phone = phoneMatch[0];
    await db.updateClient(platform, platformId, updates);

    const caseType = detectCaseType(data.issue);
    const attorney = getRoutedAttorney(caseType);

    // Notify team Telegram group
    await notifyTeamTelegram(platform, data, caseType, attorney);

    console.log(`✅ Intake completed — ${data.name} via ${platform}`);
  } catch (err) {
    console.error("finishIntake error:", err.message);
  }
}

// ── Send intake card to Telegram group ───────────────────────
async function notifyTeamTelegram(platform, data, caseType, attorney) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID   = process.env.TEAM_TELEGRAM_CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️  TELEGRAM_BOT_TOKEN or TEAM_TELEGRAM_CHAT_ID not set — skipping notification");
    return;
  }

  const platformEmoji = {
    telegram:  "📱 Telegram",
    whatsapp:  "💬 WhatsApp",
    wechat:    "🟢 WeChat",
    website:   "🌐 Website",
  };

  const msg =
    `📋 *NEW CLIENT INTAKE*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 *Name:* ${escMd(data.name)}\n` +
    `📞 *Contact:* ${escMd(data.contact)}\n` +
    `📝 *Issue:* ${escMd(data.issue)}\n` +
    `⚖️ *Case Type:* ${escMd(caseType)}\n` +
    `🔀 *Route to:* ${escMd(attorney)}\n` +
    `📱 *Via:* ${escMd(platformEmoji[platform] || platform)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ *Follow up within 1 business day\\!*`;

  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id:    CHAT_ID,
    text:       msg,
    parse_mode: "MarkdownV2",
  });

  console.log(`📣 Intake notification sent to Telegram group — ${data.name}`);
}

// Escape special chars for MarkdownV2
function escMd(text) {
  if (!text) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// ── Reset intake for a user (on /reset) ──────────────────────
function resetIntake(platform, platformId) {
  delete intakeState[`${platform}:${platformId}`];
}

module.exports = { checkIntake, resetIntake };
