// ============================================================
//  server.js — Tez Law P.C. | Zara — All Bots Combined
//  Telegram + WhatsApp + Facebook Messenger + WeChat + Website
// ============================================================

const express  = require("express");
const axios    = require("axios");
const crypto   = require("crypto");
const xml2js   = require("xml2js");
const FormData = require("form-data");
const fs       = require("fs");
const { initDB, clearHistory }    = require("./db");
const { askClaudeWithMemory }     = require("./askClaude-memory");
const { transcribeAudio }         = require("./whisper");

const app = express();
app.use(express.json());
app.use(express.text({ type: "text/xml" }));

// ── Environment variables ─────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  // Telegram
  TELEGRAM_TOKEN,
  TEAM_TELEGRAM_CHAT_ID,
  // WhatsApp / Messenger
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,
  PAGE_ID,
  // WeChat
  WECHAT_TOKEN,
  WECHAT_APP_ID,
  WECHAT_APP_SECRET,
  OPENAI_API_KEY,
  // Render
  RENDER_EXTERNAL_URL,
  PORT = 3000,
} = process.env;

console.log("ANTHROPIC_API_KEY:", !!ANTHROPIC_API_KEY);
console.log("TELEGRAM_TOKEN:", !!TELEGRAM_TOKEN);
console.log("WHATSAPP_TOKEN:", !!WHATSAPP_TOKEN);
console.log("WECHAT_APP_ID:", !!WECHAT_APP_ID);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const CACHE_FILE   = process.env.CACHE_PATH || "/tmp/legal_cache.json";

// ── System prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `Your name is Zara. You are a warm, friendly legal assistant for Tez Law P.C. in West Covina, California.

============================
THE TEAM
============================

JJ ZHANG — Managing Attorney
- Phone: 626-678-8677
- Email: jj@tezlawfirm.com

JUE WANG — USCIS filings & immigration questions
- Email: jue.wang@tezlawfirm.com

MICHAEL LIU — Immigration court hearings & motions
- Email: michael.liu@tezlawfirm.com

LIN MEI — Car accidents & state court filings
- Email: lin.mei@tezlawfirm.com

============================
CONVERSATION STYLE — CRITICAL
============================

You are having a REAL conversation, not writing a legal document.

RULES:
- Keep responses SHORT. 2-4 sentences max for most replies.
- Ask ONE question at a time. Never ask two questions in one message.
- Be casual and warm. Like texting a knowledgeable friend.
- No bullet points unless absolutely necessary.
- No long lists. No headers. No walls of text.
- Respond in whatever language the person writes in (English, Spanish, Chinese).
- When someone tells you their problem, acknowledge it FIRST before asking anything.
- Only ask for more info if you genuinely need it to help them.

URGENT SITUATIONS (ICE detention, NTA, court date, serious accident):
Keep it short and direct. Give the phone number immediately.
Example: "That's urgent — please call us right now at 626-678-8677."

============================
WHAT YOU KNOW
============================

IMMIGRATION (USCIS → Jue Wang | Court → Michael Liu):
- Green cards: family (I-130), employment (EB-1 to EB-5), humanitarian (asylum, VAWA, U-visa)
- Processing times (2026): Marriage green card ~8-10 months. Naturalization ~5.5 months. EAD ~2 months.
- DACA: renewals only, renew 180 days before expiration
- ICE detention: URGENT — call 626-678-8677, locate via 1-888-351-4024, don't sign anything
- NTA: URGENT — doesn't mean automatic deportation, contact Michael Liu immediately
- Overstay bars: 180 days = 3-year bar; 1+ year = 10-year bar
- H-1B: specialty work visa, 85,000 spots/year, wage-based lottery
- California: AB 60 driver's license for undocumented, SB 54 limits local ICE cooperation

CAR ACCIDENTS (→ Lin Mei: lin.mei@tezlawfirm.com):
- After accident: call 911, get medical attention, document everything, don't admit fault
- Deadlines: personal injury 2 years; government vehicle only 6 MONTHS
- Contingency fee: 33.3% pre-lawsuit, 40% at trial — no upfront cost
- Partial fault: California pure comparative negligence — you can still recover

BUSINESS LITIGATION (→ JJ Zhang):
- Non-competes: VOID in California
- Trade secret theft: act fast, TRO available, 3 years from discovery
- Got served: 30 days to respond, preserve all documents

PATENTS & TRADEMARKS (→ JJ Zhang):
- Trademark: 8-12 months, $350/class USPTO fee
- Utility patent: 20 years, $10,000-$30,000+ total

ESTATE PLANNING (→ JJ Zhang):
- Living trust avoids probate — an $800K West Covina home = $36,000+ in probate fees
- Trust packages: $1,500-$3,000 individual, $2,500-$5,000 couple
- No California estate tax; federal exemption $13.99M in 2025

============================
CASE STATUS QUESTIONS
============================
If anyone asks about case status, hearing dates, USCIS receipts — DO NOT look it up. Instead:
1. Acknowledge warmly
2. Flag it for the team
3. Ask for name + contact
4. Reassure someone will follow up

============================
GENERAL AI ASSISTANT
============================
You are also a helpful general AI assistant. Help with non-legal questions too — nearby places, translations, general knowledge. Be a smart, helpful friend first.

============================
DISTRESS DETECTION — CRITICAL
============================
HIGH URGENCY: ICE, detained, arrested, deportation, NTA, accident just happened, injured, scared, please help, court tomorrow
MEDIUM URGENCY: visa expired, out of status, denied, worried, desperate

For HIGH URGENCY: acknowledge warmly, give 626-678-8677, tell them NOT to sign anything.`;

const WELCOME_MESSAGE = `Hey there! 👋 I'm Zara, the virtual assistant for Tez Law P.C.

I'm here to help you figure out your legal options and connect you with the right person on our team. We handle:

🛂 Immigration
🚗 Car Accidents & Personal Injury
⚖️ Business Litigation
™️ Patents & Trademarks
📋 Estate Planning

What's going on? Tell me what's on your mind! 😊`;

const CONTACT_MESSAGE = `Here's the Tez Law P.C. team:

👨‍💼 JJ Zhang (Managing Attorney)
📞 626-678-8677
📧 jj@tezlawfirm.com

📋 Jue Wang (USCIS filings)
📧 jue.wang@tezlawfirm.com

⚖️ Michael Liu (Immigration court)
📧 michael.liu@tezlawfirm.com

🚗 Lin Mei (Car accidents & state court)
📧 lin.mei@tezlawfirm.com

📍 West Covina, California`;

// ── Legal research cache ──────────────────────────────────
const CACHE_TTL = {
  statute: 30*24*60*60*1000, caselaw: 7*24*60*60*1000,
  policy: 7*24*60*60*1000, fees: 3*24*60*60*1000, general: 14*24*60*60*1000,
};
function detectCacheType(q) {
  q = q.toLowerCase();
  if (/processing time|fee|cost|how long/.test(q)) return "fees";
  if (/bia|case law|decision|matter of/.test(q)) return "caselaw";
  if (/policy|policy manual/.test(q)) return "policy";
  if (/ina|cfr|§|vehicle code|civil code|probate code|statute|section/.test(q)) return "statute";
  return "general";
}
function loadCache() { try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE,"utf8")) : {}; } catch(e) { return {}; } }
function saveCache(c) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c,null,2)); } catch(e) {} }
function getCacheKey(m) { return m.toLowerCase().trim().replace(/[^a-z0-9\s§]/g,"").replace(/\s+/g,"_").substring(0,100); }
function getCachedAnswer(m) {
  const c = loadCache(), k = getCacheKey(m), e = c[k];
  if (!e) return null;
  if (Date.now()-e.timestamp > CACHE_TTL[detectCacheType(m)]) return null;
  return e.answer;
}
function setCachedAnswer(m, a) {
  const c = loadCache(), k = getCacheKey(m);
  c[k] = { answer: a, timestamp: Date.now(), type: detectCacheType(m) };
  saveCache(c);
}
function isLegalResearchQuestion(m) {
  return /ina|cfr|§|statute|code|regulation|uscis|bia|eoir|removal|deportation|vehicle code|civil code|probate code|ccp|uspto|patent|trademark|processing time|filing fee|form i-|case law|matter of|what does|what is the law|is it legal|what are the requirements/i.test(m);
}

// ── Distress detection ────────────────────────────────────
function detectDistress(msg) {
  msg = msg.toLowerCase();
  const high = ["ice","detained","arrested","deportation","deported","removal","notice to appear","nta","they took","raid","emergency","accident just happened","injured","hospital","bleeding","scared","please help","don't know what to do","help me","court tomorrow","hearing tomorrow","sign anything","拘留","被抓","遣返","紧急","帮我","害怕","detenido","arrestado","deportación","ayúdame","miedo"];
  const med  = ["visa expired","status expired","out of status","denied","lost my job","fired","separated","family separated","worried","desperate","no options"];
  if (high.some(k => msg.includes(k))) return "high";
  if (med.some(k => msg.includes(k)))  return "medium";
  return "none";
}

async function notifyDistress(userId, message, urgency, platform) {
  if (!TEAM_TELEGRAM_CHAT_ID || !TELEGRAM_TOKEN) return;
  const emoji = urgency === "high" ? "🚨" : "⚠️";
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TEAM_TELEGRAM_CHAT_ID,
      text: `${emoji} ${urgency.toUpperCase()} — ${platform}\n\n"${message.substring(0,200)}"\n\nFollow up immediately! 📞 626-678-8677`
    });
  } catch(e) { console.error("Distress notify error:", e.message); }
}

async function notifyLead(userId, message, platform) {
  if (!TEAM_TELEGRAM_CHAT_ID || !TELEGRAM_TOKEN) return;
  const phoneMatch = message.match(/(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
  const emailMatch = message.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (!phoneMatch && !emailMatch) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TEAM_TELEGRAM_CHAT_ID,
      text: `🆕 New Lead from ${platform}!\n\n${phoneMatch ? `📞 ${phoneMatch[0]}\n` : ""}${emailMatch ? `📧 ${emailMatch[0]}\n` : ""}\nClient: ${userId}`
    });
  } catch(e) { console.error("Lead notify error:", e.message); }
}

// ── Shared message processor ──────────────────────────────
async function processMessage(platform, userId, userText, sendFn) {
  const lower = userText.toLowerCase().trim();
  if (["hi","hello","hey","hola","start","你好"].includes(lower)) {
    await sendFn(WELCOME_MESSAGE); return;
  }
  if (["contact","team","contacto"].includes(lower)) {
    await sendFn(CONTACT_MESSAGE); return;
  }
  if (lower === "reset") {
    await clearHistory(platform, userId);
    await sendFn("Fresh start! What can I help you with? 😊"); return;
  }
  const reply = await askClaudeWithMemory(platform, userId, userText, SYSTEM_PROMPT);
  await sendFn(reply);
  const urgency = detectDistress(userText);
  if (urgency !== "none") await notifyDistress(userId, userText, urgency, platform);
  await notifyLead(userId, userText, platform);
}

// ────────────────────────────────────────────────────────────
//  TELEGRAM
// ────────────────────────────────────────────────────────────
async function tgSend(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text });
}
async function tgDownloadFile(fileId) {
  const r = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: fileId } });
  const path = r.data.result.file_path;
  const fr = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${path}`, { responseType: "arraybuffer" });
  return { buffer: Buffer.from(fr.data), extension: path.split(".").pop().toLowerCase() };
}

app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  const msg = update.message;
  const chatId = String(msg.chat.id);
  const firstName = msg.from?.first_name || "there";

  try {
    if (msg.photo) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const best = msg.photo[msg.photo.length-1];
      const { buffer, extension } = await tgDownloadFile(best.file_id);
      const mimeMap = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", gif:"image/gif", webp:"image/webp" };
      const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "Analyze this image.", SYSTEM_PROMPT, { isImage:true, imageData:buffer.toString("base64"), imageMediaType:mimeMap[extension]||"image/jpeg" });
      await tgSend(chatId, reply); return;
    }
    if (msg.document) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const { buffer } = await tgDownloadFile(msg.document.file_id);
      if (msg.document.mime_type === "application/pdf") {
        const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "Analyze this PDF.", SYSTEM_PROMPT, { isPdf:true, pdfData:buffer.toString("base64") });
        await tgSend(chatId, reply);
      } else {
        await tgSend(chatId, "I can read images and PDFs. Please resend in one of those formats.");
      }
      return;
    }
    if (msg.voice || msg.audio) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const { buffer } = await tgDownloadFile((msg.voice||msg.audio).file_id);
      const transcript = await transcribeAudio(buffer, "voice.ogg");
      if (!transcript) { await tgSend(chatId, "Sorry, I couldn't make out that voice message. Please type instead."); return; }
      await tgSend(chatId, `🎤 I heard: "${transcript}"\n\nLet me help...`);
      await processMessage("telegram", chatId, transcript, (t) => tgSend(chatId, t));
      return;
    }
    if (!msg.text) return;
    const text = msg.text;
    if (text === "/start") {
      await clearHistory("telegram", chatId);
      await tgSend(chatId, `Hi ${firstName}! ${WELCOME_MESSAGE}`); return;
    }
    if (text === "/contact") { await tgSend(chatId, CONTACT_MESSAGE); return; }
    if (text === "/reset") { await clearHistory("telegram", chatId); await tgSend(chatId, "✅ Reset! How can I help?"); return; }
    await processMessage("telegram", chatId, text, (t) => tgSend(chatId, t));
  } catch(err) {
    console.error("Telegram error:", err.message);
    try { await tgSend(chatId, "Sorry, technical issue. Call us: 626-678-8677"); } catch(e) {}
  }
});

// Telegram GET verification
app.get("/telegram", (req, res) => res.send("Telegram webhook active"));

// ────────────────────────────────────────────────────────────
//  WHATSAPP + MESSENGER
// ────────────────────────────────────────────────────────────
async function waSend(to, text) {
  await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp", to, type: "text", text: { body: text }
  }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
}
async function msgrSend(recipientId, text) {
  await axios.post(`https://graph.facebook.com/v18.0/${PAGE_ID}/messages`, {
    recipient: { id: recipientId }, message: { text }
  }, { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`, "Content-Type": "application/json" } });
}
async function waDownloadMedia(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const file = await axios.get(meta.data.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: "arraybuffer" });
  return { buffer: Buffer.from(file.data), mimeType: meta.data.mime_type };
}

// WhatsApp verification
app.get("/whatsapp", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN && req.query["hub.challenge"]) {
    res.send(req.query["hub.challenge"]);
  } else { res.sendStatus(403); }
});

app.post("/whatsapp", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  // WhatsApp
  if (body.object === "whatsapp_business_account") {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;
    const from = message.from;
    try {
      if (message.type === "image") {
        const { buffer, mimeType } = await waDownloadMedia(message.image.id);
        const reply = await askClaudeWithMemory("whatsapp", from, message.image.caption || "Analyze this image.", SYSTEM_PROMPT, { isImage:true, imageData:buffer.toString("base64"), imageMediaType:mimeType });
        await waSend(from, reply); return;
      }
      if (message.type === "document") {
        const { buffer, mimeType } = await waDownloadMedia(message.document.id);
        if (mimeType === "application/pdf") {
          const reply = await askClaudeWithMemory("whatsapp", from, message.document.caption || "Analyze this PDF.", SYSTEM_PROMPT, { isPdf:true, pdfData:buffer.toString("base64") });
          await waSend(from, reply);
        } else { await waSend(from, "I can read images and PDFs. Please resend in one of those formats."); }
        return;
      }
      if (message.type === "audio") {
        const { buffer, mimeType } = await waDownloadMedia(message.audio.id);
        const ext = mimeType.includes("ogg") ? "ogg" : "m4a";
        const transcript = await transcribeAudio(buffer, `voice.${ext}`);
        if (!transcript) { await waSend(from, "Sorry, I couldn't make out that voice message. Please type instead."); return; }
        await waSend(from, `🎤 I heard: "${transcript}"\n\nLet me help...`);
        await processMessage("whatsapp", from, transcript, (t) => waSend(from, t));
        return;
      }
      if (message.type === "text") {
        await processMessage("whatsapp", from, message.text.body, (t) => waSend(from, t));
      }
    } catch(err) {
      console.error("WhatsApp error:", err.message);
      try { await waSend(from, "Something went wrong. 📞 626-678-8677"); } catch(e) {}
    }
    return;
  }

  // Facebook Messenger
  if (body.object === "page") {
    const event = body.entry?.[0]?.messaging?.[0];
    if (!event?.message?.text) return;
    const senderId = event.sender.id;
    try {
      await processMessage("messenger", senderId, event.message.text, (t) => msgrSend(senderId, t));
    } catch(err) {
      console.error("Messenger error:", err.message);
      try { await msgrSend(senderId, "Something went wrong. 📞 626-678-8677"); } catch(e) {}
    }
  }
});

// ────────────────────────────────────────────────────────────
//  WECHAT
// ────────────────────────────────────────────────────────────
let wcToken = null, wcTokenExpiry = 0;

async function getWeChatToken() {
  if (wcToken && Date.now() < wcTokenExpiry) return wcToken;
  const resp = await axios.post("https://api.weixin.qq.com/cgi-bin/stable_token", {
    grant_type: "client_credential", appid: WECHAT_APP_ID, secret: WECHAT_APP_SECRET
  });
  if (!resp.data.access_token) throw new Error("WeChat token error: " + JSON.stringify(resp.data));
  wcToken = resp.data.access_token;
  wcTokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
  console.log("✅ WeChat token refreshed");
  return wcToken;
}

// wcSend removed — using direct XML reply instead

// wcSendDirect — used for async responses AFTER initial XML reply (voice messages)
async function wcSendDirect(openId, text) {
  try {
    const token = await getWeChatToken();
    const chunks = [];
    for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
    for (const chunk of chunks) {
      const r = await axios.post(
        `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`,
        { touser: openId, msgtype: "text", text: { content: chunk } }
      );
      if (r.data.errcode && r.data.errcode !== 0) {
        console.error("wcSendDirect error:", JSON.stringify(r.data));
      }
    }
  } catch(err) {
    console.error("wcSendDirect error:", err.message);
  }
}

async function wcDownloadMedia(mediaId) {
  const token = await getWeChatToken();
  const resp = await axios.get(`https://api.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`, { responseType: "arraybuffer" });
  return { buffer: Buffer.from(resp.data), contentType: resp.headers["content-type"] || "audio/amr" };
}

function wcXmlReply(toUser, fromUser, content) {
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${Math.floor(Date.now()/1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;
}

async function handleWeChatMsg(req, res) {
  try {
    const xml   = await xml2js.parseStringPromise(req.body, { explicitArray: false });
    const msg   = xml.xml;
    const from  = msg.FromUserName;
    const to    = msg.ToUserName;
    const type  = msg.MsgType;
    console.log(`WeChat ${type} from ${from}`);

    if (type === "event" && msg.Event === "subscribe") {
      res.type("application/xml").send(wcXmlReply(from, to, WELCOME_MESSAGE)); return;
    }
    if (type === "text") {
      // Direct XML reply — no IP whitelist needed
      try {
        const userText = msg.Content?.trim() || "";
        console.log(`WeChat text from ${from}: "${userText.substring(0, 50)}"`);
        // Race Claude against 4.5s timeout to stay within WeChat's 5s window
        const reply = await Promise.race([
          (async () => {
            const lowerText = userText.toLowerCase().trim();
            if (["hi","hello","hey","hola","start","你好"].includes(lowerText)) {
              await clearHistory("wechat", from);
              return WELCOME_MESSAGE;
            }
            if (["contact","team","contacto"].includes(lowerText)) return CONTACT_MESSAGE;
            if (lowerText === "reset") { await clearHistory("wechat", from); return "Fresh start! What can I help you with? 😊"; }
            const r = await askClaudeWithMemory("wechat", from, userText, SYSTEM_PROMPT);
            const urgency = detectDistress(userText);
            if (urgency !== "none") notifyDistress(from, userText, urgency, "WeChat").catch(()=>{});
            notifyLead(from, userText, "WeChat").catch(()=>{});
            return r;
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500))
        ]);
        res.type("application/xml").send(wcXmlReply(from, to, reply.substring(0, 600)));
      } catch(err) {
        if (err.message === "timeout") {
          console.log("WeChat response timeout — sending fallback");
          res.type("application/xml").send(wcXmlReply(from, to, "Processing your request... please send your message again in a moment. 😊"));
        } else {
          console.error("WeChat text error:", err.message);
          res.type("application/xml").send(wcXmlReply(from, to, "Sorry, something went wrong. Please call us at 626-678-8677."));
        }
      }
      return;
    }
    if (type === "voice") {
      try {
        // Use WeChat built-in recognition if available (Chinese)
        if (msg.Recognition) {
          const text = msg.Recognition;
          const reply = await Promise.race([
            askClaudeWithMemory("wechat", from, text, SYSTEM_PROMPT),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
          ]);
          res.type("application/xml").send(wcXmlReply(from, to,
            `🎤 I heard: "${text}"\n\n${reply}`.substring(0, 600)
          ));
          return;
        }
        // No built-in recognition — download AMR and use Whisper asynchronously
        // Acknowledge immediately within 5s, then process
        res.type("application/xml").send(wcXmlReply(from, to,
          "🎤 Processing your voice message... I\'ll respond in a moment!"
        ));
        // Process async after responding
        setImmediate(async () => {
          try {
            const { buffer } = await wcDownloadMedia(msg.MediaId);
            const text = await transcribeAudio(buffer, "voice.amr");
            if (!text) {
              await wcSendDirect(from, "Sorry, I couldn\'t transcribe that voice message. Please type instead.");
              return;
            }
            const reply = await askClaudeWithMemory("wechat", from, text, SYSTEM_PROMPT);
            await wcSendDirect(from, `🎤 I heard: "${text}"\n\n${reply}`);
          } catch(err) {
            console.error("WeChat async voice error:", err.message);
            await wcSendDirect(from, "I had trouble with that voice message. Please type instead, or call us at 626-678-8677.");
          }
        });
      } catch(err) {
        console.error("WeChat voice error:", err.message);
        res.type("application/xml").send(wcXmlReply(from, to, "I had trouble with that voice message. Please type instead."));
      }
      return;
    }
    if (type === "image") {
      try {
        const imgResp = await axios.get(msg.PicUrl, { responseType: "arraybuffer" });
        const mimeType = imgResp.headers["content-type"] || "image/jpeg";
        const reply = await Promise.race([
          askClaudeWithMemory("wechat", from, "Analyze this image. If it's a legal document, explain what it is.", SYSTEM_PROMPT, { isImage:true, imageData:Buffer.from(imgResp.data).toString("base64"), imageMediaType:mimeType }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
        ]);
        res.type("application/xml").send(wcXmlReply(from, to, reply.substring(0, 600)));
      } catch(err) {
        if (err.message === "timeout") {
          res.type("application/xml").send(wcXmlReply(from, to, "Processing your image... please send it again in a moment. 😊"));
        } else {
          console.error("WeChat image error:", err.message);
          res.type("application/xml").send(wcXmlReply(from, to, "I had trouble reading that image. Please describe what you need help with."));
        }
      }
      return;
    }
    res.type("application/xml").send(wcXmlReply(from, to, "I support text, voice, and image messages. 😊\n\n我支持文字、语音和图片消息。"));
  } catch(err) {
    console.error("WeChat handler error:", err.message);
    res.send("success");
  }
}

function wcVerify(req, res) {
  const { signature, timestamp, nonce, echostr } = req.query;
  const hash = crypto.createHash("sha1").update([WECHAT_TOKEN, timestamp, nonce].sort().join("")).digest("hex");
  if (hash === signature) { console.log("✅ WeChat verified"); res.send(echostr); }
  else { res.status(403).send("Forbidden"); }
}

app.get("/wechat",   wcVerify);
app.post("/wechat",  handleWeChatMsg);
app.get("/webhook",  wcVerify);
app.post("/webhook", handleWeChatMsg);

// ────────────────────────────────────────────────────────────
//  WEBSITE CHAT
// ────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  const { message, sessionId } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing message or sessionId" });
  try {
    const reply = await askClaudeWithMemory("website", sessionId, message, SYSTEM_PROMPT);
    res.json({ reply });
  } catch(err) {
    console.error("Web chat error:", err.message);
    res.status(500).json({ reply: "Having trouble connecting. Please call us at 626-678-8677." });
  }
});
app.options("/chat", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.sendStatus(200);
});

// ────────────────────────────────────────────────────────────
//  HEALTH CHECK + START
// ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Tez Law P.C. — Zara running on all channels ✅"));

app.listen(PORT, () => {
  console.log(`🚀 Zara running on port ${PORT}`);
  initDB();
  const url = RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  setInterval(() => axios.get(url).catch(() => {}), 4 * 60 * 1000);
  console.log("Keep-alive ping →", url);
});
