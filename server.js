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
const { initDB, clearHistory, getHistory } = require("./db");
const { scheduleWeeklyAnalytics, runWeeklyAnalysis } = require("./analytics");
const { askClaudeWithMemory }     = require("./askClaude-memory");
const { transcribeAudio }         = require("./whisper");
const { sendVoiceReply }          = require("./voice");
const { checkIntake, initIntakeTable } = require("./intake");
const { isJJAuthenticated }       = require("./jj-mode");
const { router: adminRouter, handleAdminCallback, initPromptTable, getSavedPrompt } = require("./admin");
const { checkCompliance, initComplianceTable } = require("./compliance");
const { scheduleUSCISRefresh, buildLivePrompt } = require("./uscis-updater");
const { startHotLeadMonitor } = require("./hot-leads");
const { handleIncomingCall, handleRespond, handleCallStatus, handleAudio, handleTransfer, handleTransferFallback, handleTranscription } = require("./voice-call");
const { startSolScheduler }   = require("./sol");
const { startDripScheduler }  = require("./drip");
const cookieParser = require("cookie-parser");

// ── Legal Intelligence modules ────────────────────────────
const { scheduleDigest, runDailyDigest }         = require("./legal-digest");
const { initCitationTables }                      = require("./citations");
const { initJudgeProfileTables, getScanStatus }   = require("./judge-scanner");
const { initCacheTable, getCacheStats, purgeExpiredCache } = require("./answer-cache");

// Matter manager: REST routes (mounted at /admin/matters) + .ics calendar feed
const { router: matterManagerRouter, handleCalendarFeed, ingestEmailText } = require("./matter-manager");
const multer  = require("multer");
const db      = require("./db");
const pdfParse = require("pdf-parse");

// In-memory multer for SendGrid inbound webhook (multipart/form-data).
// 25MB per file, 50MB per request total — handles typical EOIR PDFs (usually <2MB)
// with plenty of headroom for unusual cases.
const sendgridUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 }
});

// General document upload — used by /extract-document, /extract-i589,
// /extract-summary, /extract-exhibits. 32MB matches Anthropic PDF upload limit.
// Declared here (not later) so route definitions can reference it in order.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

// Extract text from a PDF buffer. Returns "" on error (so a corrupted PDF
// doesn't tank the whole ingest — we keep the email body for parsing).
async function extractPdfText(buffer, filename) {
  try {
    const data = await pdfParse(buffer);
    return data.text || "";
  } catch (err) {
    console.warn(`PDF extraction failed for ${filename}:`, err.message);
    return "";
  }
}

// Research module is loaded inside admin.js so it inherits admin auth.

const app = express();
// Body parser limits raised from 100kb default to 25mb so hearing note forms
// with extensive Q&A rows, closing arguments, and multiple witnesses don't
// hit "payload too large" errors. Individual merits prep can easily reach 1-3mb.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb", parameterLimit: 50000 }));
app.use(express.text({ type: "text/xml" }));
app.use(cookieParser());

// ── Admin panel ───────────────────────────────────────────
// Matter manager mounted BEFORE adminRouter so /admin/matters/* takes
// precedence; otherwise Express would route those requests into the
// general admin router (which has no /matters/* routes and would 404).
app.use("/admin/matters", matterManagerRouter);
app.use("/admin", adminRouter);
app.get("/admin", (req, res) => res.redirect("/admin/"));

// ──────────────────────────────────────────────────────────────
//  SENDGRID INBOUND-EMAIL WEBHOOK (auto-ingest)
//
//  How it works:
//    1. SendGrid forwards every email arriving at *@inbound.tezlawfirm.com
//       to this URL via POST multipart/form-data.
//    2. The URL itself contains a long secret (env var INBOUND_WEBHOOK_SECRET).
//       Anyone hitting the URL without the right secret gets 401. Equivalent
//       to a shared-secret bearer token but encoded in the path so SendGrid
//       doesn't need custom-header support.
//    3. We check the sender domain against an allowlist (court / gov senders
//       and your own address). Everything else gets logged and dropped.
//    4. We dedup against the Message-ID header — same email forwarded twice
//       doesn't create duplicate proposals.
//    5. We pass the email body to ingestEmailText() which creates proposals
//       in the existing inbox queue. You review and accept manually. NEVER
//       auto-creates matters or deadlines.
//    6. If parsing fails, we file a "raw" proposal so the email is at
//       least visible in your inbox for manual review.
//    7. Every webhook hit (accepted or rejected) is logged to inbound_email_log
//       for debugging and abuse forensics.
//
//  Setup checklist (you do these on your side):
//    [ ] Generate INBOUND_WEBHOOK_SECRET env var (32+ random hex chars)
//    [ ] Add MX record on tezlawfirm.com pointing inbound.tezlawfirm.com → mx.sendgrid.net
//    [ ] In SendGrid Inbound Parse settings, point inbound.tezlawfirm.com →
//        https://tezlaw-bot.onrender.com/webhook/inbound-email/{SECRET}
//    [ ] Forward a court email to dockets@inbound.tezlawfirm.com to test
// ──────────────────────────────────────────────────────────────

// Sender allowlist — only emails FROM these domains/addresses are accepted.
// Wildcard prefix '*@' = any user at that domain.
const INBOUND_SENDER_ALLOWLIST = [
  "*@uscourts.gov",
  "*@usdoj.gov",
  "*@uspto.gov",
  "*@dhs.gov",
  "*@ice.dhs.gov",
  "*@cbp.dhs.gov",
  "*@uscis.dhs.gov",
  "*@ecf.ca9.uscourts.gov",
  "*@ecf.cacd.uscourts.gov",
  "*@ecf.cand.uscourts.gov",
  "*@ecf.casd.uscourts.gov",
  "*@ecf.caed.uscourts.gov",
  // SendGrid sometimes wraps via subdomain; allow forwarded items from your own address
  "jj@tezlawfirm.com"
];

function senderAllowed(fromAddr) {
  if (!fromAddr) return false;
  const addr = String(fromAddr).toLowerCase().trim();
  // Pull the actual email out of "Name <addr@example.com>" if needed
  const m = addr.match(/<([^>]+)>/);
  const cleanAddr = (m ? m[1] : addr).trim();
  for (const rule of INBOUND_SENDER_ALLOWLIST) {
    if (rule.startsWith("*@")) {
      const domain = rule.slice(2);
      if (cleanAddr.endsWith("@" + domain)) return true;
    } else if (rule.toLowerCase() === cleanAddr) {
      return true;
    }
  }
  return false;
}

// Find which user owns the inbound flow. v1 = single-user (JJ).
// Matches the same lookup used by getCurrentUserId() in matter-manager.js
// so the auto-ingest pipeline writes proposals to the same user as paste-ingest.
async function getInboundOwnerUserId() {
  try {
    const r = await db.query(
      `SELECT id FROM users WHERE username = 'jj' LIMIT 1`
    );
    return r.rows[0]?.id || null;
  } catch {
    return null;
  }
}

// Log every webhook attempt for forensics
async function logInbound(fields, outcome, reason, proposalId) {
  try {
    await db.query(
      `INSERT INTO inbound_email_log
        (from_email, to_email, subject, message_id, outcome, reason, proposal_id, body_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        (fields.from || "").substring(0, 300),
        (fields.to || "").substring(0, 300),
        (fields.subject || "").substring(0, 500),
        (fields.messageId || "").substring(0, 500),
        outcome,
        reason ? String(reason).substring(0, 2000) : null,
        proposalId,
        fields.bodySize || 0
      ]
    );
  } catch (err) {
    console.error("logInbound error:", err.message);
  }
}

app.post("/webhook/inbound-email/:secret", sendgridUpload.any(), async (req, res) => {
  // ── Step 1: Secret check (path-token auth) ──
  const expected = process.env.INBOUND_WEBHOOK_SECRET;
  if (!expected || expected.length < 16) {
    console.error("INBOUND_WEBHOOK_SECRET not set or too short");
    return res.status(500).send("Server not configured");
  }
  if (req.params.secret !== expected) {
    // Don't log the secret attempted; just count the rejection
    console.warn("Inbound webhook: bad secret from", req.ip);
    return res.status(401).send("unauthorized");
  }

  // ── Step 2: Pull fields from SendGrid multipart form ──
  // SendGrid sends these keys when "Send Raw, full MIME message" is OFF:
  //   from, to, subject, text, html, attachments, charsets, envelope, dkim, SPF, headers
  // We use `text` (plain-text body) per Q5 in the planning conversation.
  const fields = {
    from:      req.body?.from      || "",
    to:        req.body?.to        || "",
    subject:   req.body?.subject   || "",
    text:      req.body?.text      || req.body?.html || "",
    headers:   req.body?.headers   || "",
    envelope:  req.body?.envelope  || "",
    bodySize:  (req.body?.text || "").length
  };

  // Extract Message-ID from headers blob if present
  // Headers come as one big string: "Header-Name: value\r\nHeader-Name: value\r\n..."
  let messageId = null;
  const midMatch = fields.headers.match(/^Message-ID:\s*(<[^>]+>|[^\r\n]+)/im);
  if (midMatch) messageId = midMatch[1].trim();
  fields.messageId = messageId;

  // ── Step 3: Sender allowlist ──
  if (!senderAllowed(fields.from)) {
    await logInbound(fields, "rejected_sender", `From not on allowlist: ${fields.from}`, null);
    // Return 200 so SendGrid doesn't retry. Email is silently dropped — that's intentional.
    return res.status(200).send("dropped: sender not allowed");
  }

  // ── Step 4: Body validation ──
  if (!fields.text || fields.text.length < 20) {
    await logInbound(fields, "rejected_empty", "Body too short or missing", null);
    return res.status(200).send("dropped: empty body");
  }

  // ── Step 4.5: Extract PDF attachments ──
  // SendGrid sends attachments as fields named attachment1, attachment2, etc.,
  // each containing the binary file. multer.any() puts these in req.files.
  // We extract text from each PDF and append it to fields.text so the parser
  // sees both the email body AND the PDF contents in one combined input.
  let pdfsExtracted = 0;
  let pdfChars = 0;
  if (Array.isArray(req.files) && req.files.length > 0) {
    const pdfTexts = [];
    for (const file of req.files) {
      // SendGrid prepends "attachment" to all attachment field names. Filter to PDFs.
      const isPdf = (file.mimetype === "application/pdf") ||
                    (file.originalname && file.originalname.toLowerCase().endsWith(".pdf"));
      if (!isPdf) continue;
      const text = await extractPdfText(file.buffer, file.originalname || file.fieldname);
      if (text && text.length > 20) {
        pdfTexts.push(`\n\n--- PDF ATTACHMENT: ${file.originalname || file.fieldname} ---\n${text}`);
        pdfsExtracted++;
        pdfChars += text.length;
      }
    }
    if (pdfTexts.length > 0) {
      fields.text = fields.text + pdfTexts.join("");
      fields.bodySize = fields.text.length;
      console.log(`Inbound webhook: extracted ${pdfsExtracted} PDF(s), +${pdfChars} chars`);
    }
  }

  // ── Step 5: Resolve owner ──
  const userId = await getInboundOwnerUserId();
  if (!userId) {
    await logInbound(fields, "rejected_auth", "No owner user found", null);
    return res.status(500).send("server: owner unresolved");
  }

  // ── Step 6: Run the shared ingest pipeline ──
  // Source-ref encodes useful provenance: "From X · Subject: Y" so you can see at a glance where it came from
  const sourceRef = `email · From ${fields.from} · ${fields.subject || "(no subject)"}`;
  let result;
  try {
    result = await ingestEmailText(userId, fields.text, {
      source: "email_inbound",
      source_ref: sourceRef,
      message_id: messageId
    });
  } catch (err) {
    console.error("Inbound webhook ingest error:", err.message);
    await logInbound(fields, "parser_error", err.message, null);
    // 200 so SendGrid doesn't retry; we have the audit log
    return res.status(200).send("error: parser failed");
  }

  // ── Step 7: Handle outcomes ──
  if (!result.ok) {
    await logInbound(fields, "parser_error", result.error, null);
    return res.status(200).send(`error: ${result.error}`);
  }

  if (result.duplicate) {
    await logInbound(fields, "rejected_duplicate", `Already ingested as proposal ${result.existing_proposal_id}`, result.existing_proposal_id);
    return res.status(200).send("dropped: duplicate");
  }

  // If parsers ran but produced zero proposals, file a "raw" proposal so the
  // email isn't lost — you can still see and manually action it in the inbox.
  let firstProposalId = result.proposals?.[0]?.id || null;
  if (result.proposals.length === 0 || result.parser_failed) {
    try {
      const ins = await db.query(
        `INSERT INTO matter_proposals
           (user_id, kind, source, source_ref, proposed_data, raw_excerpt, status, confidence, message_id)
         VALUES ($1, 'new_matter', 'email_inbound', $2, $3, $4, 'pending', 'low', $5)
         RETURNING id`,
        [
          userId,
          sourceRef,
          JSON.stringify({
            _raw: true,
            _note: "Parser produced no structured fields — review email body manually.",
            subject: fields.subject,
            from: fields.from
          }),
          fields.text.substring(0, 4000),
          messageId
        ]
      );
      firstProposalId = ins.rows[0]?.id || firstProposalId;
      await logInbound(fields, "accepted_raw", "Filed as raw proposal for manual review", firstProposalId);
    } catch (err) {
      console.error("Raw proposal insert error:", err.message);
      await logInbound(fields, "parser_error", `Raw insert failed: ${err.message}`, null);
    }
  } else {
    await logInbound(
      fields,
      "accepted_parsed",
      `Created ${result.proposals.length} proposal(s); matter_matched=${result.summary?.matter_matched || "none"}`,
      firstProposalId
    );
  }

  return res.status(200).send("ok");
});

// Admin-side: simple log viewer so you can debug "why didn't that email land in my inbox?"
app.get("/admin/inbound-log", async (req, res) => {
  // Hooked into admin auth via cookie — same gate as admin panel
  const isAdmin = req.cookies && req.cookies.admin_auth === process.env.ADMIN_PASSWORD;
  if (!isAdmin) return res.status(401).send("unauthorized");
  try {
    const r = await db.query(
      `SELECT id, received_at, from_email, to_email, subject, outcome, reason, proposal_id, body_size
         FROM inbound_email_log
        ORDER BY received_at DESC
        LIMIT 100`
    );
    res.json({ entries: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Calendar .ics feed (top-level, secret-protected, no admin session) ──
// Outlook/Google Calendar fetch this URL on a refresh interval without
// cookies. Authenticated by the per-user calendar_secret in the URL path.
// Do NOT move this under /admin — it would break Outlook/Google subscriptions.
app.get("/calendar/:secret", handleCalendarFeed);

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
  // WordPress auto-poster
  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,
  // Gmail
  GMAIL_EMAIL,
  GMAIL_APP_PASSWORD,
  // Render
  RENDER_EXTERNAL_URL,
  PORT = 3000,
  // Legal Intelligence
  COURTLISTENER_TOKEN,
  TRELLIS_API_KEY,
  JJ_TELEGRAM_ID,
} = process.env;

console.log("ANTHROPIC_API_KEY:", !!ANTHROPIC_API_KEY);
console.log("TELEGRAM_TOKEN:", !!TELEGRAM_TOKEN);
console.log("WHATSAPP_TOKEN:", !!WHATSAPP_TOKEN);
console.log("WECHAT_APP_ID:", !!WECHAT_APP_ID);
console.log("COURTLISTENER_TOKEN:", !!COURTLISTENER_TOKEN);
console.log("TRELLIS_API_KEY:", !!TRELLIS_API_KEY);
console.log("JJ_TELEGRAM_ID:", !!JJ_TELEGRAM_ID);

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const CACHE_FILE   = process.env.CACHE_PATH || "/var/data/legal_cache.json";

// ── System prompt ─────────────────────────────────────────
const SYSTEM_PROMPT = `Your name is Zara. You are a warm, friendly legal assistant for Tez Law P.C. in West Covina, California.

============================
THE TEAM
============================

JJ ZHANG — Managing Attorney
- Phone: 626-678-8677
- Email: jj@tezlawfirm.com

JUE WANG — Paralegal (immigration filings & USCIS matters)
- Email: jue.wang@tezlawfirm.com

MICHAEL LIU — Paralegal (immigration court support & motions)
- Email: michael.liu@tezlawfirm.com

LIN MEI — Paralegal (personal injury & state court filings)
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

For HIGH URGENCY: acknowledge warmly, give 626-678-8677, tell them NOT to sign anything.

============================
VOICE CAPABILITIES
============================
You CAN send voice messages. When someone asks you to respond in voice, speak, or send audio:
- Just respond normally in text as usual
- The system automatically converts your text reply into a voice message and sends it
- NEVER say you cannot do voice or that you only communicate through text
- You have full voice capabilities on Telegram and WhatsApp`;

const WELCOME_MESSAGE = `Hi! 👋 I'm Zara, the virtual assistant for Tez Law P.C. in West Covina.

I'm here 24/7 to help with any legal questions — whether it's immigration, a car accident, estate planning, evictions, or business matters.

What brings you here today? Feel free to describe your situation and I'll point you in the right direction. 😊`;

const CONTACT_MESSAGE = `Here's the Tez Law P.C. team:

👨‍💼 JJ Zhang — Managing Attorney
📞 626-678-8677
📧 jj@tezlawfirm.com

📋 Jue Wang — Paralegal (immigration & USCIS)
📧 jue.wang@tezlawfirm.com

⚖️ Michael Liu — Paralegal (immigration court)
📧 michael.liu@tezlawfirm.com

🚗 Lin Mei — Paralegal (personal injury & state court)
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
  const t = msg.toLowerCase();

  // Use whole-word regex for short keywords that appear inside other words
  // e.g. "ice" inside "police", "raid" inside "afraid", "nta" inside "santa"
  function wholeWord(keyword) {
    return new RegExp("(?<![a-z])" + keyword.replace(/[-]/g, "\\-") + "(?![a-z])", "i").test(t);
  }

  // Keywords that need whole-word matching (short, risky substrings)
  const highWholeWord = ["ice","nta","raid","help me","scared","miedo"];
  // Keywords safe to substring match (long enough, unique enough)
  const highSubstring = ["detained","arrested","deportation","deported","removal",
    "notice to appear","they took","emergency","accident just happened","injured",
    "hospital","bleeding","please help","don\'t know what to do","court tomorrow",
    "hearing tomorrow","sign anything","拘留","被抓","遣返","紧急","帮我","害怕",
    "detenido","arrestado","deportación","ayúdame"];
  const med = ["visa expired","status expired","out of status","denied",
    "lost my job","fired","separated","family separated","worried","desperate","no options"];

  const highMatch = highWholeWord.some(k => wholeWord(k)) || highSubstring.some(k => t.includes(k));
  if (highMatch) return "high";
  if (med.some(k => t.includes(k))) return "medium";
  return "none";
}

async function notifyDistress(userId, message, urgency, platform) {
  if (!TEAM_TELEGRAM_CHAT_ID || !TELEGRAM_TOKEN) return;
  // Never forward JJ's private messages to the team
  if (isJJAuthenticated(platform, userId)) return;
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
  // Never forward JJ's private messages to the team
  if (isJJAuthenticated(platform, userId)) return;
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
  // Proactive greeting for brand new users on their very first message ever
  try {
    const hist = await getHistory(platform, userId);
    if (hist.length === 0) {
      await sendFn(WELCOME_MESSAGE);
      await new Promise(r => setTimeout(r, 600));
    }
  } catch(e) { /* non-fatal — continue */ }

  const lower = userText.toLowerCase().trim();

  // ── OWNER CHECK: never treat JJ as a client ──────────────
  // When JJ is authenticated, skip ALL client shortcuts and notifications.
  // Every message goes straight to askClaudeWithMemory → checkJJMode.
  if (!isJJAuthenticated(platform, userId)) {
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
  }

  const livePrompt = buildLivePrompt(app, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
  const reply = await askClaudeWithMemory(platform, userId, userText, livePrompt, {
    sendProgress: sendFn,
  });

  // Reply can be a string OR { text, attachment } — from /draft filling a .docx
  if (reply && typeof reply === "object" && reply.attachment) {
    await sendFn(reply.text || "");
    // Signal to caller (Telegram handler) that an attachment needs to be sent
    // by exposing it on sendFn if it supports it
    if (typeof sendFn._deliverAttachment === "function") {
      await sendFn._deliverAttachment(reply.attachment);
    }
  } else {
    await sendFn(typeof reply === "string" ? reply : (reply?.text || ""));
  }

  // ── PRIVACY: never forward JJ's messages to the team ──
  if (isJJAuthenticated(platform, userId)) return;

  // ── Post-response hooks (non-blocking) ─────────────────
  const urgency = detectDistress(userText);
  Promise.allSettled([
    urgency !== "none" ? notifyDistress(userId, userText, urgency, platform) : Promise.resolve(),
    notifyLead(userId, userText, platform),
    checkCompliance(platform, userId, userText, reply, sendFn),
  ]).catch(() => {});
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

// Send a file attachment to a Telegram chat.
// attachment = { buffer, filename, mimeType }
async function tgSendDocument(chatId, attachment) {
  if (!attachment || !attachment.buffer) return;
  const FormData = require("form-data");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", attachment.buffer, {
    filename: attachment.filename || "document.docx",
    contentType: attachment.mimeType || "application/octet-stream",
  });
  try {
    await axios.post(`${TELEGRAM_API}/sendDocument`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (err) {
    console.error("[tgSendDocument] Error:", err.response?.data || err.message);
    await tgSend(chatId, "⚠️ I generated the file but couldn't send it. Try /draft again.");
  }
}

// Handle a reply that may be a string OR { text, attachment } from JJ /draft flow.
async function handleReplyOrAttachment(chatId, reply) {
  if (reply && typeof reply === "object" && reply.attachment) {
    if (reply.text) await tgSend(chatId, reply.text);
    await tgSendDocument(chatId, reply.attachment);
  } else if (typeof reply === "string") {
    await tgSend(chatId, reply);
  } else if (reply && reply.text) {
    await tgSend(chatId, reply.text);
  }
}

// ────────────────────────────────────────────────────────────
//  Daily deadline summary (Telegram, sent each morning at 7am PT)
//
//  Two parts:
//    1. CRITICAL THRESHOLDS HIT TODAY — IP deadlines (TM, Patent, Copyright)
//       that just crossed a 30/14/7/1-day threshold. Tracked in
//       matter_ip_reminders so each (deadline, threshold) only fires once.
//    2. Standard 14-day rolling summary (Overdue / Today / Week / Next Week).
//
//  Excludes archived matters and party='them' (informational) deadlines.
//  Restricted to JJ_TELEGRAM_ID.
// ────────────────────────────────────────────────────────────

// IP deadline reminder thresholds (Checkpoint 4)
// Standard 30/14/7/1 for most IP deadlines.
// Patent issue fee gets the 3-day touch because it's non-extendable.
const IP_REMINDER_THRESHOLDS = [30, 14, 7, 1];
const PATENT_ISSUE_FEE_THRESHOLDS = [30, 14, 7, 3, 1];
// EOIR hearings: 60/30/14 — wider lead time but no aggressive ramp.
// (Per JJ preference 2026-05-27 — daily summary still surfaces hearings in
// the 14-day rolling window, so no risk of going silent close to hearing.)
const HEARING_THRESHOLDS = [60, 30, 14];

// Identify whether a deadline should get threshold reminders.
// Returns an array of threshold days (smallest fires first), or null if no reminders.
//
// Trigger rules:
//   - EOIR hearings → HEARING_THRESHOLDS (60/30/14)
//     Detection: case_type='Removal' AND party='court' AND title contains 'hearing',
//     OR title produced by the EOIR parser (Master / Individual / Bond / Immigration).
//     Non-EOIR court hearings (9th Cir oral argument, district court hearings, etc.)
//     get NO threshold reminders — daily summary covers them.
//   - IP matter + patent issue fee → PATENT_ISSUE_FEE_THRESHOLDS (30/14/7/3/1)
//   - IP matter (TM/Patent/Copyright) → IP_REMINDER_THRESHOLDS (30/14/7/1)
//   - Everything else → null (no threshold reminders; standard daily summary still covers it)
function thresholdsForDeadline(caseType, title, party) {
  const lowerTitle = (title || "").toLowerCase();
  // EOIR hearings — recognized either by case_type or by the title strings
  // the EOIR parser produces.
  const isEoirHearing =
    party === "court" && lowerTitle.includes("hearing") && (
      caseType === "Removal" ||
      lowerTitle.includes("master calendar") ||
      lowerTitle.includes("individual hearing") ||
      lowerTitle.includes("bond hearing") ||
      lowerTitle.includes("immigration hearing") ||
      lowerTitle.includes("immigration court")
    );
  if (isEoirHearing) {
    return HEARING_THRESHOLDS;
  }
  // IP-specific reminders
  if (!["Trademark", "Patent", "Copyright"].includes(caseType)) return null;
  if (lowerTitle.includes("issue fee") && caseType === "Patent") {
    return PATENT_ISSUE_FEE_THRESHOLDS;
  }
  return IP_REMINDER_THRESHOLDS;
}

async function sendDailyDeadlineSummary() {
  if (!JJ_TELEGRAM_ID) {
    console.log("Daily summary skipped — JJ_TELEGRAM_ID not set");
    return;
  }
  const db = require("./db");

  // Anchor "today" in Pacific time. We compare YYYY-MM-DD strings,
  // which avoids JS Date timezone confusion when matched against
  // the DATE-typed due_date column.
  const now = new Date();
  const ptFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  const todayStr = ptFmt.format(now); // YYYY-MM-DD in PT

  // 7 days from now and 14 days, computed in PT
  function addDaysPT(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return ptFmt.format(dt);
  }
  const in7Str  = addDaysPT(todayStr, 7);
  const in14Str = addDaysPT(todayStr, 14);
  const in30Str = addDaysPT(todayStr, 30);

  // Helper: compute days between two YYYY-MM-DD strings (PT-anchored).
  function daysBetween(fromStr, toStr) {
    const [fy, fm, fd] = fromStr.split("-").map(Number);
    const [ty, tm, td] = toStr.split("-").map(Number);
    const f = Date.UTC(fy, fm - 1, fd);
    const t = Date.UTC(ty, tm - 1, td);
    return Math.round((t - f) / 86400000);
  }

  // ─────────────────────────────────────────────────────────
  //  PART 1: Critical IP threshold check
  //  Find IP deadlines whose days-until matches a threshold AND we
  //  haven't already sent a reminder for that (deadline, threshold).
  // ─────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────
  //  PART 1: Critical threshold check
  //  Finds:
  //   - IP deadlines (TM/Patent/Copyright) with us-party
  //   - Immigration/litigation hearings (court-party, "hearing" in title)
  //  Tracks each (deadline, threshold) in matter_ip_reminders so we
  //  don't re-fire. The table name keeps "ip" for legacy reasons; it
  //  now covers both IP and hearing thresholds.
  //  Pulls in up to 60 days out so hearing 60-day threshold can fire.
  // ─────────────────────────────────────────────────────────
  const in60Str = addDaysPT(todayStr, 60);
  let ipRows = [];
  try {
    const r = await db.query(
      `SELECT d.id, d.title, d.party, d.due_date, d.citation,
              m.client_name, m.matter_ref, m.case_type, m.id AS matter_id, m.mark
         FROM matter_deadlines d
         JOIN matters m ON m.id = d.matter_id
        WHERE d.completed = FALSE
          AND m.status = 'active'
          AND d.due_date IS NOT NULL
          AND d.due_date::date >= $1::date
          AND d.due_date::date <= $2::date
          AND (
            -- IP us-party deadlines
            (m.case_type IN ('Trademark', 'Patent', 'Copyright') AND (d.party IS NULL OR d.party = 'us'))
            OR
            -- Court-party hearings (any matter type)
            (d.party = 'court' AND LOWER(d.title) LIKE '%hearing%')
          )`,
      [todayStr, in60Str]
    );
    ipRows = r.rows;
  } catch (err) {
    console.error("sendDailyDeadlineSummary threshold query error:", err.message);
    // Continue — we can still send the standard summary
  }

  // For each deadline, check if today crosses (or just crossed) any threshold
  // and we haven't sent that reminder before. Insert tracker row + push to alerts.
  const criticalAlerts = [];
  for (const row of ipRows) {
    const dueStr = String(row.due_date).slice(0, 10);
    const daysLeft = daysBetween(todayStr, dueStr);
    if (daysLeft < 0) continue; // shouldn't happen given query, but safe

    const thresholds = thresholdsForDeadline(row.case_type, row.title, row.party);
    if (!thresholds) continue;

    // Determine the SMALLEST threshold that's been crossed but not yet fired.
    // Crossed = daysLeft <= threshold. We fire the smallest such threshold first
    // so we don't double-alert (e.g. firing 30+14+7+1 all at once for a deadline
    // that's been ignored for a month). Tracker prevents re-firing same threshold.
    let firedThreshold = null;
    for (const threshold of thresholds.slice().sort((a, b) => a - b)) {
      if (daysLeft > threshold) continue;
      // Check if we've already sent THIS threshold for THIS deadline
      let alreadySent = false;
      try {
        const r2 = await db.query(
          `SELECT 1 FROM matter_ip_reminders
            WHERE deadline_id = $1 AND days_out = $2
            LIMIT 1`,
          [row.id, threshold]
        );
        alreadySent = r2.rows.length > 0;
      } catch (err) {
        console.error("matter_ip_reminders lookup error:", err.message);
        alreadySent = true; // fail-safe: don't spam if DB is broken
      }
      if (!alreadySent) {
        firedThreshold = threshold;
        break; // fire smallest unsent threshold; stop here
      }
    }

    if (firedThreshold !== null) {
      // Record the reminder BEFORE we add to outgoing alerts so a Telegram-send
      // failure doesn't cause re-fire next day. Worst case: we logged but failed
      // to send — you'll catch the deadline in the next day's standard summary.
      try {
        await db.query(
          `INSERT INTO matter_ip_reminders (matter_id, deadline_id, days_out)
           VALUES ($1, $2, $3)
           ON CONFLICT (deadline_id, days_out) DO NOTHING`,
          [row.matter_id, row.id, firedThreshold]
        );
      } catch (err) {
        console.error("matter_ip_reminders insert error:", err.message);
        continue; // skip this alert; don't risk double-firing
      }
      criticalAlerts.push({ row, daysLeft, threshold: firedThreshold });
    }
  }

  // ─────────────────────────────────────────────────────────
  //  PART 2: Standard 14-day rolling summary (unchanged from before)
  // ─────────────────────────────────────────────────────────
  let rows;
  try {
    const r = await db.query(
      `SELECT d.id, d.title, d.party, d.due_date, d.citation,
              m.client_name, m.matter_ref, m.id AS matter_id
         FROM matter_deadlines d
         JOIN matters m ON m.id = d.matter_id
        WHERE d.completed = FALSE
          AND m.status = 'active'
          AND d.due_date IS NOT NULL
          AND d.due_date::date <= $1::date
          AND (d.party IS NULL OR d.party <> 'them')
        ORDER BY d.due_date ASC, m.client_name ASC`,
      [in14Str]
    );
    rows = r.rows;
  } catch (err) {
    console.error("sendDailyDeadlineSummary query error:", err.message);
    return;
  }

  // Bucket each row
  const overdue = [];
  const today   = [];
  const week    = [];
  const next    = [];
  for (const row of rows) {
    const due = String(row.due_date).slice(0, 10);
    if (due < todayStr) overdue.push(row);
    else if (due === todayStr) today.push(row);
    else if (due <= in7Str) week.push(row);
    else if (due <= in14Str) next.push(row);
  }

  // Format the message
  const dateLabel = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long", month: "long", day: "numeric"
  });

  let msg = `📅 Daily Deadlines — ${dateLabel}\n`;

  function fmtRow(r) {
    const due = String(r.due_date).slice(0, 10);
    const [y, m, d] = due.split("-");
    const mmdd = `${parseInt(m)}/${parseInt(d)}`;
    const partyTag = r.party === "us" ? "[us]"
                   : r.party === "them" ? "[gov]"
                   : "[ct]";
    const caption = (r.client_name || "Unknown").substring(0, 30);
    const title   = (r.title || "Untitled").substring(0, 60);
    return `   • ${mmdd} ${partyTag} ${caption} — ${title}`;
  }

  function fmtCritical(alert) {
    const { row, daysLeft, threshold } = alert;
    const caption = (row.mark || row.client_name || "Unknown").substring(0, 40);
    const title   = (row.title || "Untitled").substring(0, 80);
    const dayLabel = daysLeft === 0 ? "TODAY" :
                     daysLeft === 1 ? "TOMORROW" :
                     `in ${daysLeft} days`;
    return `   • ${title}\n     ${caption} · ${dayLabel} · ${threshold}-day threshold`;
  }

  // Critical alerts go FIRST — they're the most important
  if (criticalAlerts.length > 0) {
    msg += `\n🚨 CRITICAL THRESHOLDS HIT (${criticalAlerts.length})\n${criticalAlerts.map(fmtCritical).join("\n")}\n`;
  }

  if (overdue.length === 0 && today.length === 0 && week.length === 0 && next.length === 0) {
    if (criticalAlerts.length === 0) {
      msg += `\nAll clear — nothing due in the next 14 days.\n\n📖 https://tezlaw-bot.onrender.com/admin/matters/`;
    } else {
      msg += `\n(Nothing else due in next 14 days.)\n\n📖 https://tezlaw-bot.onrender.com/admin/matters/`;
    }
  } else {
    if (overdue.length) {
      msg += `\n🔴 OVERDUE (${overdue.length})\n${overdue.map(fmtRow).join("\n")}\n`;
    }
    if (today.length) {
      msg += `\n⚠️ TODAY (${today.length})\n${today.map(fmtRow).join("\n")}\n`;
    }
    if (week.length) {
      msg += `\n📌 THIS WEEK (${week.length})\n${week.map(fmtRow).join("\n")}\n`;
    }
    if (next.length) {
      msg += `\n📋 NEXT WEEK (${next.length})\n${next.map(fmtRow).join("\n")}\n`;
    }
    msg += `\n📖 https://tezlaw-bot.onrender.com/admin/matters/`;
  }

  try {
    await tgSend(String(JJ_TELEGRAM_ID), msg);
    console.log(`📅 Daily deadline summary sent — ${criticalAlerts.length} critical, ${overdue.length} overdue, ${today.length} today, ${week.length} this week, ${next.length} next week`);
  } catch (err) {
    console.error("Failed to send daily summary:", err.message);
  }
}

// ── Pending /deadline disambiguation map ──────────────────
// Key: chatId, Value: { matches[], title, dueDate, expiresAt }
const pendingDeadlines = new Map();

// Parse a date token into YYYY-MM-DD.
// Accepts: "8/3", "8/3/26", "8/3/2026", "2026-08-03", "8-3", "8-3-26".
// Defaults year to current year if missing. If date is already past
// today and only month/day given, bumps to next year.
function parseDateToken(token) {
  if (!token) return null;
  const t = token.trim();

  // Already YYYY-MM-DD
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = parseInt(m[1]), mo = parseInt(m[2]), d = parseInt(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  // M/D, M/D/YY, M/D/YYYY (or with dashes)
  m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const mo = parseInt(m[1]);
    const d  = parseInt(m[2]);
    let y;
    if (m[3]) {
      y = parseInt(m[3]);
      if (y < 100) y += 2000;
    } else {
      // Default to current year in PT
      const now = new Date();
      const ptYear = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric" }).format(now);
      y = parseInt(ptYear);
      // If the resulting date is already in the past, bump to next year
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const candidate = `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      if (candidate < today) y += 1;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  return null;
}

// Handle `/deadline ...` from JJ. Parses last token as date,
// first token as matter search, middle as title.
async function handleDeadlineCommand(chatId, text) {
  const db = require("./db");

  // Strip leading "/deadline"
  const rest = text.replace(/^\/deadline\s*/i, "").trim();

  if (!rest || rest === "cancel") {
    if (pendingDeadlines.has(chatId)) {
      pendingDeadlines.delete(chatId);
      await tgSend(chatId, "✕ Pending /deadline cancelled.");
    } else {
      await tgSend(chatId,
        "Usage: /deadline <matter> <title> <date>\n" +
        "Example: /deadline Lu opening brief 8/3\n" +
        "Dates: M/D, M/D/YY, M/D/YYYY, YYYY-MM-DD"
      );
    }
    return;
  }

  // Split on whitespace, isolate last token as date
  const parts = rest.split(/\s+/);
  if (parts.length < 3) {
    await tgSend(chatId, "Need at least: <matter> <title> <date>. Example: /deadline Lu opening brief 8/3");
    return;
  }
  const dateToken = parts[parts.length - 1];
  const dueDate = parseDateToken(dateToken);
  if (!dueDate) {
    await tgSend(chatId, `❌ Couldn't parse "${dateToken}" as a date. Try: M/D, M/D/YYYY, or YYYY-MM-DD`);
    return;
  }
  const matterSearch = parts[0];
  const title = parts.slice(1, -1).join(" ").trim();
  if (!title) {
    await tgSend(chatId, "❌ Need a title between matter and date. Example: /deadline Lu opening brief 8/3");
    return;
  }

  // Find matching matters for JJ (user_id 1)
  let matches;
  try {
    const r = await db.query(
      `SELECT id, client_name, matter_ref FROM matters
        WHERE user_id = 1 AND status = 'active'
          AND (client_name ILIKE $1 OR matter_ref ILIKE $1 OR petitioner_name ILIKE $1)
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 10`,
      [`%${matterSearch}%`]
    );
    matches = r.rows;
  } catch (err) {
    console.error("/deadline matter search error:", err.message);
    await tgSend(chatId, "❌ Database error. Try again.");
    return;
  }

  if (matches.length === 0) {
    await tgSend(chatId, `❌ No active matter found matching "${matterSearch}".`);
    return;
  }

  if (matches.length === 1) {
    await insertDeadlineFromCommand(chatId, matches[0], title, dueDate);
    return;
  }

  // Multiple matches → ask user to pick a number
  pendingDeadlines.set(chatId, {
    matches, title, dueDate,
    expiresAt: Date.now() + 5 * 60 * 1000 // 5 min
  });
  let msg = `Multiple matters matched "${matterSearch}". Reply with a number:\n\n`;
  matches.forEach((m, i) => {
    msg += `${i + 1}. ${m.client_name}${m.matter_ref ? " — " + m.matter_ref : ""}\n`;
  });
  msg += `\n(or /deadline cancel)`;
  await tgSend(chatId, msg);
}

async function resolveDeadlineChoice(chatId, choice, pending) {
  if (choice < 1 || choice > pending.matches.length) {
    await tgSend(chatId, `❌ Choose 1–${pending.matches.length}.`);
    return;
  }
  pendingDeadlines.delete(chatId);
  const matter = pending.matches[choice - 1];
  await insertDeadlineFromCommand(chatId, matter, pending.title, pending.dueDate);
}

async function insertDeadlineFromCommand(chatId, matter, title, dueDate) {
  const db = require("./db");
  try {
    const r = await db.query(
      `INSERT INTO matter_deadlines (matter_id, title, citation, due_date, party, note, completed)
       VALUES ($1, $2, NULL, $3, 'us', NULL, FALSE)
       RETURNING id`,
      [matter.id, title, dueDate]
    );
    db.logAudit("jj", "create_deadline_telegram", `matter:${matter.id}/deadline:${r.rows[0].id}`,
                null, JSON.stringify({title, dueDate}), null).catch(() => {});
    const dateLabel = new Date(dueDate + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric", year: "numeric"
    });
    await tgSend(chatId,
      `✅ Added to ${matter.client_name}:\n` +
      `   "${title}"\n` +
      `   Due ${dateLabel}\n\n` +
      `📖 https://tezlaw-bot.onrender.com/admin/matters/`
    );
  } catch (err) {
    console.error("insertDeadlineFromCommand error:", err.message);
    await tgSend(chatId, "❌ Couldn't save deadline. Try the web dashboard.");
  }
}

app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  // ── Admin panel auth callback ─────────────────────────
  if (update.callback_query) {
    const cb = update.callback_query;
    if (cb.data?.startsWith("admin_")) {
      const result = await handleAdminCallback(cb.data, cb.id);
      if (result) {
        axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
          callback_query_id: cb.id,
          text: result.answer,
        }).catch(() => {});
      }
      return;
    }
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = String(msg.chat.id);
  const firstName = msg.from?.first_name || "there";

  try {
    // ── /chatid — utility command for setting up group chats ──
    // Works in DMs, groups, and channels. Returns the current chat's ID
    // so JJ can set env vars like HEARING_NOTES_TELEGRAM_GROUP_ID.
    const textForCmd = (msg.text || msg.caption || "").trim();
    if (/^\/chatid(@\w+)?\s*$/i.test(textForCmd)) {
      const chatType = msg.chat.type || "unknown"; // 'private', 'group', 'supergroup', 'channel'
      const chatTitle = msg.chat.title || "(no title)";
      const info =
        `📍 *Chat ID Info*\n\n` +
        `Chat ID: \`${chatId}\`\n` +
        `Type: ${chatType}\n` +
        (chatType !== "private" ? `Title: ${chatTitle}\n` : `From: ${firstName}\n`) +
        `\n_Copy the Chat ID above to use in env vars like_ \`HEARING_NOTES_TELEGRAM_GROUP_ID\`.`;
      await tgSend(chatId, info);
      return;
    }
    if (msg.photo) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const best = msg.photo[msg.photo.length-1];
      const { buffer, extension } = await tgDownloadFile(best.file_id);
      const mimeMap = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", gif:"image/gif", webp:"image/webp" };
      const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "Analyze this image.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), { isImage:true, imageData:buffer.toString("base64"), imageMediaType:mimeMap[extension]||"image/jpeg" });
      await tgSend(chatId, reply); return;
    }
    if (msg.document) {
      await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: "typing" });
      const { buffer } = await tgDownloadFile(msg.document.file_id);
      const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      if (msg.document.mime_type === "application/pdf") {
        const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "Analyze this PDF.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
          isPdf:true, pdfData:buffer.toString("base64"),
          sendProgress: (t) => tgSend(chatId, t),
        });
        await handleReplyOrAttachment(chatId, reply);
      } else if (msg.document.mime_type === docxMime ||
                 (msg.document.file_name && msg.document.file_name.toLowerCase().endsWith(".docx"))) {
        // DOCX — for /template add or /draft with facts doc
        const reply = await askClaudeWithMemory("telegram", chatId, msg.caption || "", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
          isDocx:true, docxData:buffer.toString("base64"),
          sendProgress: (t) => tgSend(chatId, t),
        });
        await handleReplyOrAttachment(chatId, reply);
      } else {
        await tgSend(chatId, "I can read images, PDFs, and .docx files. Please resend in one of those formats.");
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

    // ── Matter Manager commands (JJ-only) ─────────────────
    if (text === "/today" || text.startsWith("/deadline") || text === "/help_matters") {
      const isJJ = JJ_TELEGRAM_ID && String(chatId) === String(JJ_TELEGRAM_ID);
      if (!isJJ) {
        await tgSend(chatId, "Sorry, that command is restricted.");
        return;
      }
      if (text === "/today") {
        await sendDailyDeadlineSummary();
        return;
      }
      if (text === "/help_matters") {
        await tgSend(chatId,
          "📚 Matter Manager Commands\n\n" +
          "/today — Send today's deadline summary now\n" +
          "/deadline <matter> <title> <date>\n" +
          "   e.g. /deadline Lu opening brief 8/3\n" +
          "   Dates: M/D, M/D/YY, M/D/YYYY, YYYY-MM-DD\n" +
          "/deadline cancel — Cancel a pending command"
        );
        return;
      }
      // /deadline command
      await handleDeadlineCommand(chatId, text);
      return;
    }

    // If there's a pending /deadline disambiguation, treat a bare number as the choice
    if (pendingDeadlines.has(chatId) && /^\d+$/.test(text.trim())) {
      const pending = pendingDeadlines.get(chatId);
      if (Date.now() > pending.expiresAt) {
        pendingDeadlines.delete(chatId);
        await tgSend(chatId, "⏱️ That selection expired. Please re-run /deadline.");
        return;
      }
      await resolveDeadlineChoice(chatId, parseInt(text.trim()), pending);
      return;
    }

    // Send "thinking" message if Claude takes more than 5 seconds
    let thinkingMsg = null;
    const thinkingTimer = setTimeout(async () => {
      try {
        const r = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "🤔 Let me think about that for a moment..."
        });
        thinkingMsg = r.data.result?.message_id;
      } catch(e) {}
    }, 5000);

    await processMessage("telegram", chatId, text, Object.assign(async (t) => {
      lastTgReply = t;
      await tgSend(chatId, t);
    }, {
      _deliverAttachment: async (att) => { await tgSendDocument(chatId, att); },
    }));
    clearTimeout(thinkingTimer);

    // Delete the thinking message once real reply is sent
    if (thinkingMsg) {
      axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: thinkingMsg }).catch(() => {});
    }
    if (lastTgReply && isJJAuthenticated("telegram", chatId)) {
      sendVoiceReply("telegram", chatId, lastTgReply).catch(() => {});
    }
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
  try {
    await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body: text }
    }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } });
  } catch(e) {
    // 400 = invalid recipient or status webhook — ignore silently
    if (e.response?.status === 400) return;
    throw e;
  }
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

// Upload a media file to WhatsApp's Cloud API. Returns the media_id which
// can then be referenced in a sendMessage document call.
// WhatsApp requires 2-step upload: first upload media to get an ID,
// then send a message referencing that media_id.
async function waUploadMedia(buffer, filename, mimeType) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", buffer, { filename, contentType: mimeType });

  const uploadResp = await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/media`,
    form,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );
  return uploadResp.data.id;
}

// Send a file attachment to a WhatsApp chat.
// attachment = { buffer, filename, mimeType }
async function waSendDocument(to, attachment) {
  if (!attachment || !attachment.buffer) return;
  try {
    const mediaId = await waUploadMedia(
      attachment.buffer,
      attachment.filename || "document.docx",
      attachment.mimeType || "application/octet-stream"
    );
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: mediaId,
          filename: attachment.filename || "document.docx",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("[waSendDocument] Error:", err.response?.data || err.message);
    await waSend(to, "⚠️ I generated the file but couldn't send it. Try /draft again.");
  }
}

// Handle a reply that may be a string OR { text, attachment } from JJ /draft flow.
async function waHandleReplyOrAttachment(to, reply) {
  if (reply && typeof reply === "object" && reply.attachment) {
    if (reply.text) await waSend(to, reply.text);
    await waSendDocument(to, reply.attachment);
  } else if (typeof reply === "string") {
    await waSend(to, reply);
  } else if (reply && reply.text) {
    await waSend(to, reply.text);
  }
}

// WhatsApp verification
app.get("/whatsapp", (req, res) => {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN && req.query["hub.challenge"]) {
    res.send(req.query["hub.challenge"]);
  } else { res.sendStatus(403); }
});

// ── Facebook Messenger webhook verification ───────────────
app.get("/messenger", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === (process.env.MESSENGER_VERIFY_TOKEN || VERIFY_TOKEN)) {
    console.log("✅ Messenger webhook verified");
    res.send(challenge);
  } else {
    console.error("❌ Messenger webhook verification failed");
    res.sendStatus(403);
  }
});

app.post("/whatsapp", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  if (body.object === "whatsapp_business_account") {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    // Ignore status updates (delivered, read, sent) — these are not messages
    if (!value || value?.statuses || !value?.messages) return;
    const message = value.messages[0];
    if (!message) return;
    if (!["text","image","audio","document"].includes(message.type)) return;
    const from = message.from;
    try {
      if (message.type === "image") {
        const { buffer, mimeType } = await waDownloadMedia(message.image.id);
        const reply = await askClaudeWithMemory("whatsapp", from, message.image.caption || "Analyze this image.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), { isImage:true, imageData:buffer.toString("base64"), imageMediaType:mimeType });
        await waSend(from, reply); return;
      }
      if (message.type === "document") {
        const { buffer, mimeType } = await waDownloadMedia(message.document.id);
        const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        const filename = message.document.filename || "";
        if (mimeType === "application/pdf") {
          const reply = await askClaudeWithMemory("whatsapp", from, message.document.caption || "Analyze this PDF.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
            isPdf:true, pdfData:buffer.toString("base64"),
            sendProgress: (t) => waSend(from, t),
          });
          await waHandleReplyOrAttachment(from, reply);
        } else if (mimeType === docxMime || filename.toLowerCase().endsWith(".docx")) {
          // DOCX — for /template add, /brief, /case add, or /draft with facts doc
          const reply = await askClaudeWithMemory("whatsapp", from, message.document.caption || "", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), {
            isDocx:true, docxData:buffer.toString("base64"),
            sendProgress: (t) => waSend(from, t),
          });
          await waHandleReplyOrAttachment(from, reply);
        } else {
          await waSend(from, "I can read images, PDFs, and .docx files. Please resend in one of those formats.");
        }
        return;
      }
      if (message.type === "audio") {
        const { buffer, mimeType } = await waDownloadMedia(message.audio.id);
        const ext = mimeType.includes("ogg") ? "ogg" : "m4a";
        const transcript = await transcribeAudio(buffer, `voice.${ext}`);
        if (!transcript) { await waSend(from, "Sorry, I couldn't make out that voice message. Please type instead."); return; }
        await waSend(from, `🎤 I heard: "${transcript}"\n\nLet me help...`);
        await processMessage("whatsapp", from, transcript, Object.assign(async (t) => {
          await waSend(from, t);
        }, {
          _deliverAttachment: async (att) => { await waSendDocument(from, att); },
        }));
        return;
      }
      if (message.type === "text") {
        // Send "thinking" message if Claude takes more than 5 seconds
        let thinkingTimer = setTimeout(() => {
          waSend(from, "🤔 Let me think about that for a moment...").catch(() => {});
        }, 5000);
        await processMessage("whatsapp", from, message.text.body, Object.assign(async (t) => {
          await waSend(from, t);
        }, {
          _deliverAttachment: async (att) => { await waSendDocument(from, att); },
        }));
        clearTimeout(thinkingTimer);
      }
    } catch(err) {
      console.error("WhatsApp error:", err.message);
      try { await waSend(from, "Something went wrong. 📞 626-678-8677"); } catch(e) {}
    }
    return;
  }

  // Facebook Messenger
  if (body.object === "page") {
    const entry = body.entry?.[0];
    // Handle messaging events (not echoes, not reads)
    const event = entry?.messaging?.[0];
    if (!event || event.message?.is_echo) return;
    const senderId = event.sender.id;

    // Handle postbacks (button clicks)
    if (event.postback) {
      try {
        await processMessage("messenger", senderId, event.postback.payload || event.postback.title, (t) => msgrSend(senderId, t));
      } catch(err) { console.error("Messenger postback error:", err.message); }
      return;
    }

    // Must have a message
    if (!event.message) return;

    try {
      // Send typing indicator
      await axios.post(`https://graph.facebook.com/v18.0/${PAGE_ID}/messages`, {
        recipient: { id: senderId },
        sender_action: "typing_on"
      }, { headers: { Authorization: `Bearer ${PAGE_ACCESS_TOKEN}` } }).catch(() => {});

      // Handle image attachments
      if (event.message.attachments) {
        const att = event.message.attachments[0];
        if (att.type === "image") {
          const reply = await askClaudeWithMemory("messenger", senderId,
            "The user sent an image. Please acknowledge and ask how you can help.",
            buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
          await msgrSend(senderId, reply);
          return;
        }
      }

      if (!event.message.text) return;

      // Thinking message if Claude takes > 5s
      let thinkingTimer = setTimeout(() => {
        msgrSend(senderId, "🤔 Let me look into that for you...").catch(() => {});
      }, 5000);

      await processMessage("messenger", senderId, event.message.text, (t) => msgrSend(senderId, t));
      clearTimeout(thinkingTimer);

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
            const r = await askClaudeWithMemory("wechat", from, userText, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
            if (!isJJAuthenticated("wechat", from)) {
              const urgency = detectDistress(userText);
              if (urgency !== "none") notifyDistress(from, userText, urgency, "WeChat").catch(()=>{});
              notifyLead(from, userText, "WeChat").catch(()=>{});
            }
            return r;
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4500))
        ]);
        res.type("application/xml").send(wcXmlReply(from, to, reply.substring(0, 600)));
      } catch(err) {
        if (err.message === "timeout") {
          console.log("WeChat response timeout — sending fallback");
          res.type("application/xml").send(wcXmlReply(from, to, "🤔 Still thinking... please send your message again in a moment. 😊"));
        } else {
          console.error("WeChat text error:", err.message);
          res.type("application/xml").send(wcXmlReply(from, to, "Sorry, something went wrong. Please call us at 626-678-8677."));
        }
      }
      return;
    }
    if (type === "voice") {
      // Use WeChat built-in recognition if available
      if (msg.Recognition) {
        try {
          const text = msg.Recognition;
          console.log(`WeChat voice recognized: "${text.substring(0,50)}"`);
          const reply = await Promise.race([
            askClaudeWithMemory("wechat", from, text, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT)),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4200))
          ]);
          res.type("application/xml").send(wcXmlReply(from, to,
            `🎤 "${text}"\n\n${reply}`.substring(0, 600)
          ));
        } catch(err) {
          res.type("application/xml").send(wcXmlReply(from, to,
            "I heard your voice message but took too long to respond. Please type your question instead. 😊"
          ));
        }
        return;
      }
      // No built-in recognition available — ask user to type, suggest other channels
      res.type("application/xml").send(wcXmlReply(from, to,
        "🎤 WeChat暂不支持语音识别，请改用文字提问。如需语音服务，请使用 Telegram (@TEZJJBot) 或 WhatsApp (+1 555-634-2247)。\n\nVoice isn\'t supported on WeChat. For voice, please use Telegram (@TEZJJBot) or WhatsApp (+1 555-634-2247). Or just type here! 😊"
      ));
      return;
    }
    if (type === "image") {
      try {
        const imgResp = await axios.get(msg.PicUrl, { responseType: "arraybuffer" });
        const mimeType = imgResp.headers["content-type"] || "image/jpeg";
        const reply = await Promise.race([
          askClaudeWithMemory("wechat", from, "Analyze this image. If it's a legal document, explain what it is.", buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT), { isImage:true, imageData:Buffer.from(imgResp.data).toString("base64"), imageMediaType:mimeType }),
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
    const reply = await askClaudeWithMemory("website", sessionId, message, buildLivePrompt(app, app.locals.SYSTEM_PROMPT || SYSTEM_PROMPT));
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
//  ANALYTICS — Manual trigger endpoint
// ────────────────────────────────────────────────────────────
app.get("/analytics/run", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  res.json({ status: "started", message: "Analytics running — check jj@tezlawfirm.com in ~2 minutes." });
  runWeeklyAnalysis(true).catch(err => console.error("Manual analytics error:", err.message));
});

// ── Manual autoposter trigger ─────────────────────────────
app.post("/autoposter/run", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  const { runDailyScheduler } = require("./autoposter");
  res.json({ status: "started", message: "Auto-poster running — check Telegram for results." });
  runDailyScheduler().catch(err => console.error("Manual autoposter error:", err.message));
});


// ────────────────────────────────────────────────────────────
//  LEGAL INTELLIGENCE — Manual trigger endpoints
// ────────────────────────────────────────────────────────────

// Manual digest trigger
app.post("/legal/digest/run", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  res.json({ status: "started", message: "Legal digest running — check Telegram in ~2 minutes." });
  runDailyDigest(true).catch(err => console.error("Manual digest error:", err.message));
});

// Judge scanner status
app.get("/legal/judge-scanner/status", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    const status = await getScanStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Citation stats for dashboard
app.get("/legal/citation-stats", async (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  try {
    const db = require("./db");
    const result = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM legal_citations)         AS total_cases,
        (SELECT COUNT(*) FROM citation_treatments)      AS total_treatments,
        (SELECT COUNT(*) FROM citation_treatments
         WHERE treatment_type = 'negative')             AS negative_count,
        (SELECT COUNT(*) FROM legal_citations
         WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
    `);
    res.json(result.rows[0] || {});
  } catch (err) {
    res.json({ total_cases: 0, total_treatments: 0, negative_count: 0, new_this_week: 0 });
  }
});

// Cache stats endpoint
app.get("/legal/cache-stats", async (req, res) => {
  if (req.query.token !== process.env.ANALYTICS_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    const stats = await getCacheStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
//  HEALTH CHECK + START
// ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Tez Law P.C. — Zara running on all channels ✅"));

// ── Draft templates admin ─────────────────────────────────
// One-time initialization endpoint (idempotent) — creates the three
// draft_templates tables. Also called automatically on server boot below.
app.get("/admin/init-drafts", async (req, res) => {
  try {
    const dt = require("./draft-templates");
    await dt.initDraftTables();
    const templates = await dt.listTemplates();
    res.json({
      ok: true,
      message: "Draft tables initialized",
      templates: templates.length,
    });
  } catch (err) {
    console.error("[/admin/init-drafts] error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── IMAP Email Paralegal — Setup + Admin Endpoints ────────
//
// Setup: JJ visits /admin/email-setup, gets an HTML form to enter
// IMAP credentials for each account. Zara tests the connection,
// encrypts the password, stores in DB, and starts scanning.
//
// Common IMAP settings for JJ's providers:
//   GoDaddy Workspace Email: imap.secureserver.net:993 (SSL)
//   GoDaddy 365 through GoDaddy: outlook.office365.com:993 (SSL)
//   Gmail:  imap.gmail.com:993 (SSL) — needs "App Password" from Google
//   Hotmail/Outlook.com: outlook.office365.com:993 (SSL) — may need app password
//

app.get("/admin/email-setup", async (req, res) => {
  try {
    const paralegal = require("./email-paralegal");
    const accounts = await paralegal.listAccounts();

    const accountsHtml = accounts.length ? accounts.map(a => `
      <div style="background:#f5f5f5; padding:12px; margin:8px 0; border-left: 4px solid ${a.active ? "#4CAF50" : "#999"};">
        <strong>${a.email}</strong> <span style="color:#666;">(${a.imap_host}:${a.imap_port})</span>
        <br><small>Last scan: ${a.last_scan_at ? new Date(a.last_scan_at).toLocaleString() : "never"}</small>
        ${a.last_error ? `<br><small style="color:red;">Error: ${a.last_error}</small>` : ""}
      </div>
    `).join("") : "<p><em>No accounts linked yet.</em></p>";

    res.send(`
      <html><head><title>Zara Email Setup</title>
      <style>
        body { font-family: sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; }
        h1 { color: #0C1C36; }
        h2 { color: #B79C62; margin-top: 30px; }
        input, select, button { padding: 8px; margin: 4px 0; font-size: 14px; }
        input[type="text"], input[type="password"], input[type="email"] { width: 100%; box-sizing: border-box; }
        button { background: #B79C62; color: white; border: none; padding: 10px 20px; cursor: pointer; }
        button:hover { background: #8f7a4c; }
        .preset { display: inline-block; margin: 3px; padding: 4px 10px; background: #eee; cursor: pointer; border-radius: 3px; font-size: 12px; }
        .preset:hover { background: #ddd; }
        .warn { background: #fff3cd; padding: 12px; border-left: 4px solid #ffc107; margin: 20px 0; }
      </style>
      </head><body>
        <h1>📬 Zara Email Setup</h1>
        <p>Configure IMAP credentials for accounts you want Zara to monitor.</p>

        <h2>Linked Accounts</h2>
        ${accountsHtml}

        <h2>Add / Update Account</h2>
        <div class="warn">
          <strong>⚠️ App passwords:</strong> For Gmail, Hotmail, and Google Workspace accounts with 2FA, you likely need an <em>app-specific password</em> (not your login password). 
          <br>• Gmail: <a href="https://myaccount.google.com/apppasswords" target="_blank">myaccount.google.com/apppasswords</a>
          <br>• Hotmail/Outlook: <a href="https://account.microsoft.com/security" target="_blank">account.microsoft.com/security</a> → App passwords
        </div>

        <form method="POST" action="/admin/email-setup">
          <label>Email address:<br>
          <input type="email" name="email" required placeholder="jj@tezlawfirm.com"></label><br>

          <label>Display name (optional):<br>
          <input type="text" name="display_name" placeholder="Tez Law primary"></label><br>

          <label>IMAP host:<br>
          <input type="text" name="imap_host" required placeholder="imap.secureserver.net" id="imap_host"></label>
          <div>
            <small>Quick fill:</small>
            <span class="preset" onclick="fillPreset('imap.secureserver.net',993)">GoDaddy Workspace</span>
            <span class="preset" onclick="fillPreset('outlook.office365.com',993)">GoDaddy 365 / Hotmail / Outlook</span>
            <span class="preset" onclick="fillPreset('imap.gmail.com',993)">Gmail</span>
            <span class="preset" onclick="fillPreset('imap.mail.yahoo.com',993)">Yahoo</span>
            <span class="preset" onclick="fillPreset('imap.zoho.com',993)">Zoho</span>
          </div>

          <label>IMAP port:<br>
          <input type="number" name="imap_port" value="993" id="imap_port" required></label><br>

          <label>Username (usually same as email):<br>
          <input type="text" name="imap_user" required placeholder="jj@tezlawfirm.com"></label><br>

          <label>Password (or app-specific password):<br>
          <input type="password" name="password" required></label><br>

          <label>
            <input type="checkbox" name="use_tls" value="1" checked>
            Use TLS/SSL (recommended)
          </label><br><br>

          <button type="submit" name="action" value="test">Test connection</button>
          <button type="submit" name="action" value="save">Test + Save</button>
        </form>

        <h2>Remove Account</h2>
        <form method="POST" action="/admin/email-setup">
          <label>Email to remove:<br>
          <input type="email" name="email" required></label>
          <button type="submit" name="action" value="remove" style="background:#c00;">Remove</button>
        </form>

        <script>
          function fillPreset(host, port) {
            document.getElementById("imap_host").value = host;
            document.getElementById("imap_port").value = port;
          }
        </script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.post("/admin/email-setup", async (req, res) => {
  try {
    const paralegal = require("./email-paralegal");
    const { email, imap_host, imap_port, imap_user, password, use_tls, display_name, action } = req.body;

    if (action === "remove") {
      const removed = await paralegal.removeAccount(email);
      return res.send(`
        <html><body style="font-family:sans-serif; padding:40px;">
          ${removed ? `<h1 style="color:#c00;">🗑️ Removed</h1><p>Account <strong>${email}</strong> has been removed.</p>` : `<h1>Not found</h1><p>${email} was not in the account list.</p>`}
          <p><a href="/admin/email-setup">← Back to setup</a></p>
        </body></html>
      `);
    }

    // Test the connection first
    const testResult = await paralegal.testAccount({
      imap_host, imap_port: parseInt(imap_port) || 993, imap_user, password,
      use_tls: use_tls === "1" || use_tls === "on",
    });

    if (!testResult.ok) {
      return res.send(`
        <html><body style="font-family:sans-serif; padding:40px; max-width:600px;">
          <h1 style="color:#c00;">❌ Connection failed</h1>
          <p><strong>Host:</strong> ${imap_host}:${imap_port}</p>
          <p><strong>User:</strong> ${imap_user}</p>
          <p><strong>Error:</strong> <code>${testResult.error}</code></p>
          <h3>Common fixes:</h3>
          <ul>
            <li>Verify the password is correct — try app-specific password if 2FA is enabled</li>
            <li>Check IMAP is enabled in your email provider settings</li>
            <li>Confirm the host and port match your provider's docs</li>
            <li>Some providers block IMAP for OAuth-only accounts (e.g., Microsoft may require Modern Auth)</li>
          </ul>
          <p><a href="/admin/email-setup">← Try again</a></p>
        </body></html>
      `);
    }

    if (action === "test") {
      return res.send(`
        <html><body style="font-family:sans-serif; padding:40px;">
          <h1 style="color:#4CAF50;">✅ Connection works!</h1>
          <p>Successfully connected to <strong>${imap_host}:${imap_port}</strong> as <strong>${imap_user}</strong>.</p>
          <p>INBOX contains ${testResult.messageCount} messages.</p>
          <p>Click "Test + Save" if you're ready to store this account.</p>
          <p><a href="/admin/email-setup">← Back to setup</a></p>
        </body></html>
      `);
    }

    // action === "save"
    const account = await paralegal.addAccount({
      email, imap_host, imap_port: parseInt(imap_port) || 993, imap_user, password,
      use_tls: use_tls === "1" || use_tls === "on",
      display_name,
    });

    res.send(`
      <html><body style="font-family:sans-serif; padding:40px;">
        <h1 style="color:#4CAF50;">✅ Saved!</h1>
        <p>Account <strong>${account.email}</strong> is now linked to Zara (id: ${account.id}).</p>
        <p>${testResult.messageCount} messages in INBOX. Zara will scan every 30 min.</p>
        <p><a href="/admin/email-setup">← Add another account</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error("[/admin/email-setup POST] error:", err.message);
    res.status(500).send(`<html><body><h1>Error</h1><p>${err.message}</p><p><a href="/admin/email-setup">← Back</a></p></body></html>`);
  }
});

// Trigger digest manually (for testing)
app.get("/admin/email-digest/:when", async (req, res) => {
  try {
    const digest = require("./email-digest");
    const when = req.params.when || "test";
    const dryRun = req.query.dry === "1";
    const result = await digest.runDigest(when, { dryRun });
    res.json({ ok: true, ...result, dryRun });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Master Calendar Hearing Form ─────────────────────────
//
// REDIRECT: The original pre-hearing email form has been replaced
// by the hearing NOTES tool at /admin/hearing/notes.
//
app.get("/admin/hearing/master", (req, res) => res.redirect("/admin/hearing/notes"));
app.post("/admin/hearing/master", (req, res) => res.redirect("/admin/hearing/notes"));
app.get("/admin/hearing/master/history", (req, res) => res.redirect("/admin/hearing/notes/history"));
app.get("/admin/hearing/master/:id", (req, res) => res.redirect(`/admin/hearing/notes/${req.params.id}`));

// ── Hearing Notes ─────────────────────────────────────────
//
// Structured note-taking during hearings + AI-generated summaries
// for paralegal (English, detailed) and client (their language, plain).
//
// Routes:
//   GET  /admin/hearing/notes                    → note-taking form
//   POST /admin/hearing/notes                    → generate + preview/save
//   GET  /admin/hearing/notes/history            → past notes
//   GET  /admin/hearing/notes/:id                → one hearing detail
//   POST /admin/hearing/notes/:id/send-paralegal → send to Jue via Telegram
//
app.get("/admin/hearing/notes", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    await hn.initHearingNotesTables();
    res.send(hn.renderNoteForm({}));
  } catch (err) {
    console.error("[/admin/hearing/notes GET]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/notes", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const action = req.body.action;
    const parsed = hn.parseFormSubmission(req.body);

    if (!parsed.client_name) {
      return res.send(hn.renderNoteForm({
        error: "Client name is required.",
        prev: parsed,
      }));
    }

    if (action === "save") {
      const saved = await hn.saveNote(parsed, { generateSummaries: true });
      return res.send(hn.renderNoteForm({
        generated: {
          id: saved.id,
          paralegal_summary: saved.paralegal_summary,
          client_summary: saved.client_summary,
        },
        saved: true,
        prev: parsed,
      }));
    }

    // Preview only — generate summaries but don't save to DB
    const hnMod = require("./hearing-notes");
    const [paralegal_summary, client_summary] = await Promise.all([
      hnMod.generateParalegalSummary(parsed),
      hnMod.generateClientSummary(parsed),
    ]);
    return res.send(hn.renderNoteForm({
      generated: { paralegal_summary, client_summary },
      saved: false,
      prev: parsed,
    }));
  } catch (err) {
    console.error("[/admin/hearing/notes POST]:", err.message, err.stack);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><p><a href="/admin/hearing/notes">Back</a></p>`);
  }
});

app.get("/admin/hearing/notes/history", (req, res) => res.redirect("/admin/hearing/history"));

app.get("/admin/hearing/notes/:id", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const note = await hn.getNote(id);
    if (!note) return res.status(404).send(`<h1>Not found</h1><p><a href="/admin/hearing/history">← Back to history</a></p>`);
    res.send(hn.renderNoteForm({
      noteId: id,
      prev: note,
      saved: req.query.saved === "1",
    }));
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Update an existing master hearing note
app.post("/admin/hearing/notes/:id", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const parsed = hn.parseFormSubmission(req.body);
    if (!parsed.client_name) {
      return res.send(hn.renderNoteForm({
        noteId: id,
        error: "Client name is required.",
        prev: { ...parsed, id },
      }));
    }
    await hn.updateNote(id, parsed);
    if (req.body.action === "update_and_regenerate") {
      await hn.generateAndSaveSummariesForMaster(id);
    }
    res.redirect(`/admin/hearing/notes/${id}?saved=1`);
  } catch (err) {
    console.error("[/admin/hearing/notes/:id POST]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/notes/:id/send-paralegal", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await hn.sendToParalegal(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[send-paralegal]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/admin/hearing/notes/:id", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await hn.deleteNote(id);
    console.log(`[hearing-notes] Deleted note #${id} (${result.client_name})`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[delete-hearing-note]:", err.message);
    res.status(err.message.includes("not found") ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// ── Individual Hearing Notes ──────────────────────────────
//
// Full prep tool for individual/merits hearings. Supports Excel exhibit
// upload, PDF/text hearing summary upload with Claude extraction, and
// pre-fill from prior master hearing.
//
app.get("/admin/hearing/individual", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    await ih.initTables();
    // ?copy_from=<id> — pre-fill client info from an existing hearing to create
    // a continuation. We copy client/court/judge info but NOT exhibits, exams,
    // or closing (those are specific to each hearing session).
    let prev = {};
    if (req.query.copy_from) {
      const src = await ih.getIndividualNote(parseInt(req.query.copy_from));
      if (src) {
        prev = {
          client_name: src.client_name,
          a_number: src.a_number,
          client_language: src.client_language,
          client_email: src.client_email,
          client_phone: src.client_phone,
          client_address: src.client_address,
          case_type: src.case_type,
          judge_name: src.judge_name,
          court_location: src.court_location,
          court_address: src.court_address,
          dhs_attorney: src.dhs_attorney,
        };
      }
    }
    res.send(ih.renderForm({ prev }));
  } catch (err) {
    console.error("[/admin/hearing/individual GET]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/individual", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const parsed = ih.parseFormSubmission(req.body);
    if (!parsed.client_name) {
      return res.send(ih.renderForm({ error: "Client name is required.", prev: parsed }));
    }
    const saved = await ih.saveIndividualNote(parsed);
    res.redirect(`/admin/hearing/individual/${saved.id}?saved=1`);
  } catch (err) {
    console.error("[/admin/hearing/individual POST]:", err.message, err.stack);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p><p><a href="/admin/hearing/individual">Back</a></p>`);
  }
});

app.get("/admin/hearing/individual/history", (req, res) => res.redirect("/admin/hearing/history"));

// ── Client Profiles ───────────────────────────────────────
// Aggregated view of every client across master and individual hearing
// notes. Grouped by A-Number (preferred) or client name.
app.get("/admin/clients", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const clients = await cp.aggregateClients();
    res.send(cp.renderClientList(clients));
  } catch (err) {
    console.error("[/admin/clients]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.get("/admin/clients/:key", async (req, res) => {
  try {
    const cp = require("./client-profiles");
    const client = await cp.getClientByKey(req.params.key);
    res.send(cp.renderClientDetail(client));
  } catch (err) {
    console.error("[/admin/clients/:key]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// ── Unified Hearing History ──────────────────────────────
// Combines master + individual hearing notes into one searchable/filterable
// list. Every row has an "edit" link that goes to the appropriate editor.
app.get("/admin/hearing/history", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const ih = require("./individual-hearing-notes");
    const [masterRows, individualRows] = await Promise.all([
      hn.listNotes(200),
      ih.listIndividualNotes(200),
    ]);

    // Normalize rows into a unified shape
    const normalized = [];
    for (const m of masterRows) {
      normalized.push({
        kind: "master",
        id: m.id,
        edit_url: `/admin/hearing/notes/${m.id}`,
        type_label: m.hearing_type || "master",
        sequence: m.sequence,
        sequence_total: m.sequence_total,
        client_name: m.client_name,
        a_number: m.a_number,
        client_language: m.client_language,
        hearing_date: m.hearing_date,
        judge_name: null,
        sent_to_paralegal_at: m.sent_to_paralegal_at,
        created_at: m.created_at,
      });
    }
    for (const i of individualRows) {
      normalized.push({
        kind: "individual",
        id: i.id,
        edit_url: `/admin/hearing/individual/${i.id}`,
        type_label: "individual",
        sequence: null,
        sequence_total: null,
        client_name: i.client_name,
        a_number: i.a_number,
        client_language: i.client_language,
        hearing_date: i.hearing_date,
        judge_name: i.judge_name,
        sent_to_paralegal_at: i.sent_to_paralegal_at,
        created_at: i.created_at,
      });
    }
    // Sort by created_at desc
    normalized.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.send(renderUnifiedHistory(normalized));
  } catch (err) {
    console.error("[/admin/hearing/history]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

function renderUnifiedHistory(rows) {
  const hn = require("./hearing-notes");

  const html = require("./hearing-notes"); // reuse escapes if exported? not exported — inline them here
  const esc = (s) => s == null ? "" : String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");

  const tbody = rows.length ? rows.map(r => {
    const seqBadge = r.sequence_total && r.sequence_total > 1
      ? ` <span style="background:#B79C62; color:white; padding:1px 6px; border-radius:8px; font-size:11px;">#${r.sequence}/${r.sequence_total}</span>`
      : "";
    const kindBadge = r.kind === "individual"
      ? `<span style="background:#0C1C36; color:#B79C62; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">INDIV</span>`
      : `<span style="background:#B79C62; color:white; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold;">MASTER</span>`;
    const deleteUrl = r.kind === "master" ? `/admin/hearing/notes/${r.id}` : `/admin/hearing/individual/${r.id}`;
    return `
    <tr class="h-row"
        data-kind="${r.kind}"
        data-type="${esc((r.type_label || "").toLowerCase())}"
        data-name="${esc((r.client_name || "").toLowerCase())}"
        data-anumber="${esc((r.a_number || "").toLowerCase().replace(/[-\s]/g, ""))}"
        data-judge="${esc((r.judge_name || "").toLowerCase())}"
        data-sent="${r.sent_to_paralegal_at ? "sent" : "unsent"}"
        data-lang="${esc(r.client_language || "")}">
      <td>${kindBadge} #${r.id}</td>
      <td>${esc(r.type_label || "-")}${seqBadge}</td>
      <td>${esc(r.client_name)}</td>
      <td>${esc(r.a_number || "")}</td>
      <td>${r.hearing_date ? new Date(r.hearing_date).toLocaleDateString() : "-"}</td>
      <td>${esc(r.judge_name || "-")}</td>
      <td>${r.client_language}</td>
      <td>${r.sent_to_paralegal_at ? "✅" : "—"}</td>
      <td>${new Date(r.created_at).toLocaleDateString()}</td>
      <td>
        <a href="${r.edit_url}" style="color:#B79C62;">edit</a>
        &nbsp;·&nbsp;
        <a href="#" onclick="delRow('${r.kind}', ${r.id}, ${JSON.stringify(r.client_name).replace(/"/g, '&quot;')}); return false;" style="color:#c00; font-size:12px;">🗑️</a>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="10" style="text-align:center; color:#888;">No hearing notes yet.</td></tr>`;

  const body = `
    <div class="page-header">
      <h1>📚 All Hearing Notes</h1>
      <div>
        <a href="/admin/hearing/notes" class="back-link">+ New master hearing</a>
        &nbsp;·&nbsp;
        <a href="/admin/hearing/individual" class="back-link">+ New individual hearing</a>
      </div>
    </div>

    <div style="background:white; padding:15px; border-radius:4px; margin-bottom:15px; border:1px solid #eee;">
      <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        <div style="flex:1; min-width:260px;">
          <input type="text" id="search-input" placeholder="🔍 Search by client name, A-Number, or judge..."
                 onkeyup="filterRows()"
                 style="width:100%; padding:9px 12px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
        </div>
        <div>
          <select id="filter-kind" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All hearings</option>
            <option value="master">Master hearings only</option>
            <option value="individual">Individual hearings only</option>
          </select>
        </div>
        <div>
          <select id="filter-type" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All types</option>
            <option value="master">Master</option>
            <option value="individual">Individual</option>
            <option value="individual/merits">Individual/Merits</option>
            <option value="status">Status</option>
            <option value="bond">Bond</option>
            <option value="custody redetermination">Custody Redetermination</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <select id="filter-sent" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All</option>
            <option value="sent">Sent ✅</option>
            <option value="unsent">Not sent</option>
          </select>
        </div>
        <div>
          <select id="filter-lang" onchange="filterRows()" style="padding:9px; border:1px solid #ccc; border-radius:4px; font-size:14px;">
            <option value="">All languages</option>
            <option value="en">English</option>
            <option value="zh">Chinese</option>
            <option value="es">Spanish</option>
            <option value="hi">Hindi</option>
            <option value="pa">Punjabi</option>
          </select>
        </div>
        <div>
          <button type="button" onclick="clearFilters()"
                  style="padding:9px 14px; background:#eee; border:none; border-radius:4px; cursor:pointer; font-size:13px;">
            Clear
          </button>
        </div>
      </div>
      <div id="row-count" style="margin-top:10px; font-size:13px; color:#666;">
        Showing ${rows.length} note${rows.length === 1 ? "" : "s"}
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>ID</th><th>Type</th><th>Client</th><th>A#</th><th>Hearing</th>
          <th>Judge</th><th>Lang</th><th>Sent</th><th>Created</th><th></th>
        </tr>
      </thead>
      <tbody id="rows-body">${tbody}</tbody>
    </table>

    <script>
      const TOTAL = ${rows.length};
      function filterRows() {
        const search = document.getElementById("search-input").value.toLowerCase().replace(/[-\\s]/g, "");
        const kind = document.getElementById("filter-kind").value;
        const type = document.getElementById("filter-type").value;
        const sent = document.getElementById("filter-sent").value;
        const lang = document.getElementById("filter-lang").value;
        let visible = 0;
        document.querySelectorAll(".h-row").forEach(row => {
          const name = row.dataset.name || "";
          const anumber = row.dataset.anumber || "";
          const judge = row.dataset.judge || "";
          const matchesSearch = !search || name.includes(search) || anumber.includes(search) || judge.includes(search);
          const matchesKind = !kind || row.dataset.kind === kind;
          const matchesType = !type || row.dataset.type === type;
          const matchesSent = !sent || row.dataset.sent === sent;
          const matchesLang = !lang || row.dataset.lang === lang;
          const show = matchesSearch && matchesKind && matchesType && matchesSent && matchesLang;
          row.style.display = show ? "" : "none";
          if (show) visible++;
        });
        const count = document.getElementById("row-count");
        if (visible === TOTAL) count.textContent = "Showing " + TOTAL + " note" + (TOTAL === 1 ? "" : "s");
        else count.textContent = "Showing " + visible + " of " + TOTAL + " notes";
      }
      function clearFilters() {
        document.getElementById("search-input").value = "";
        document.getElementById("filter-kind").value = "";
        document.getElementById("filter-type").value = "";
        document.getElementById("filter-sent").value = "";
        document.getElementById("filter-lang").value = "";
        filterRows();
      }
      async function delRow(kind, id, name) {
        if (!confirm("Delete " + kind + " hearing note #" + id + " for " + name + "?")) return;
        const url = kind === "master" ? "/admin/hearing/notes/" + id : "/admin/hearing/individual/" + id;
        try {
          const resp = await fetch(url, { method: "DELETE" });
          const data = await resp.json();
          if (data.ok) {
            const rows = document.querySelectorAll(".h-row");
            for (const r of rows) {
              if (r.querySelector('a[href="' + (kind === "master" ? "/admin/hearing/notes/" + id : "/admin/hearing/individual/" + id) + '"]')) {
                r.remove();
                break;
              }
            }
            filterRows();
          } else {
            alert("❌ " + (data.error || "delete failed"));
          }
        } catch (e) { alert("❌ " + e.message); }
      }
    </script>`;

  return hn.renderAdminChrome({
    title: "All Hearing Notes",
    body,
    activeItem: "history",
  });
}

// GET /admin/hearing/individual/prior-lookup?name=...&a=...
app.get("/admin/hearing/individual/prior-lookup", async (req, res) => {
  try {
    const hn = require("./hearing-notes");
    const note = await hn.getMostRecentForClient({
      clientName: req.query.name || "",
      aNumber: req.query.a || "",
    });
    if (!note) return res.json({ ok: true, note: null });
    // Return only the fields we need on the form
    res.json({
      ok: true,
      note: {
        id: note.id,
        client_name: note.client_name,
        a_number: note.a_number,
        client_email: note.client_email,
        client_phone: note.client_phone,
        client_address: note.client_address,
        client_language: note.client_language,
        case_type: note.case_type,
        judge_name: note.judge_name,
        dhs_attorney: note.dhs_attorney,
        created_at: note.created_at,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Extract hearing summary from PDF, Word (.docx), or text file.
// Registered BEFORE the /:id route so Express matches this specific path first.
app.post("/admin/hearing/individual/extract-summary", docUpload.single("summary"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const ih = require("./individual-hearing-notes");
    const name = req.file.originalname || "summary";
    const mime = req.file.mimetype || "";
    const isPdf  = mime.includes("pdf") || /\.pdf$/i.test(name);
    const isText = mime.startsWith("text/") || /\.(txt|md)$/i.test(name);
    const isDocx =
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      /\.docx$/i.test(name);
    const isDoc  = /\.doc$/i.test(name) && !isDocx;

    let extracted, rawText = null;
    if (isPdf) {
      extracted = await ih.extractHearingSummary({
        pdfBuffer: req.file.buffer,
        mimeType: "application/pdf",
        filename: name,
      });
    } else if (isDocx) {
      // Word .docx — extract plain text with mammoth, then run through Claude
      const mammoth = require("mammoth");
      try {
        const result = await mammoth.extractRawText({ buffer: req.file.buffer });
        rawText = (result.value || "").trim();
        if (!rawText) {
          return res.status(400).json({
            ok: false,
            error: "Word document appears to be empty or contains only images.",
          });
        }
      } catch (e) {
        return res.status(400).json({
          ok: false,
          error: `Could not read Word document: ${e.message}. Try saving as PDF instead.`,
        });
      }
      // Try the AI extraction — but if it fails, still return the raw text
      // so the attorney can save it to the note and manually work from it.
      try {
        extracted = await ih.extractHearingSummary({ textContent: rawText, filename: name });
      } catch (e) {
        return res.status(200).json({
          ok: true,
          extracted: { witnesses: [], examinations: [], closing_argument: "", case_summary: "" },
          raw_text: rawText,
          warning: e.message,
        });
      }
    } else if (isText) {
      rawText = req.file.buffer.toString("utf8");
      extracted = await ih.extractHearingSummary({ textContent: rawText, filename: name });
    } else if (isDoc) {
      return res.status(400).json({
        ok: false,
        error: "Old-format .doc files aren't supported — please save as .docx or PDF and re-upload.",
      });
    } else {
      return res.status(400).json({
        ok: false,
        error: "File must be PDF, Word (.docx), or text (.txt/.md).",
      });
    }
    res.json({ ok: true, extracted, raw_text: rawText });
  } catch (err) {
    console.error("[extract-summary]:", err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
});

// Parse Excel/CSV exhibit list. Registered BEFORE the /:id route.
app.post("/admin/hearing/individual/extract-exhibits", docUpload.single("exhibits"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    const ih = require("./individual-hearing-notes");
    const name = req.file.originalname || "exhibits.xlsx";
    if (!/\.(xlsx|xls|csv)$/i.test(name)) {
      return res.status(400).json({ ok: false, error: "File must be .xlsx, .xls, or .csv" });
    }
    const result = ih.parseExhibitExcel(req.file.buffer, name);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[extract-exhibits]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/admin/hearing/individual/:id", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const note = await ih.getIndividualNote(id);
    if (!note) return res.status(404).send("Not found");
    // Find sibling individual hearings for the same client (for continuation tabs)
    const siblings = await ih.getIndividualNotesForClient({
      clientName: note.client_name,
      aNumber: note.a_number,
    });
    res.send(ih.renderForm({
      noteId: id,
      prev: note,
      siblings,
      saved: req.query.saved === "1",
    }));
  } catch (err) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

app.post("/admin/hearing/individual/:id", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const parsed = ih.parseFormSubmission(req.body);
    if (!parsed.client_name) {
      const siblings = await ih.getIndividualNotesForClient({
        clientName: parsed.client_name,
        aNumber: parsed.a_number,
      });
      return res.send(ih.renderForm({ noteId: id, error: "Client name is required.", prev: parsed, siblings }));
    }
    await ih.saveIndividualNote(parsed, id);
    res.redirect(`/admin/hearing/individual/${id}?saved=1`);
  } catch (err) {
    console.error("[/admin/hearing/individual/:id POST]:", err.message);
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

// Autosave endpoint — same save logic, returns JSON instead of redirect.
// Called by the client every 5 seconds when form is dirty.
app.post("/admin/hearing/individual/:id/autosave", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const parsed = ih.parseFormSubmission(req.body);
    // For autosave, tolerate missing client_name (user might be mid-typing)
    if (!parsed.client_name) {
      return res.json({ ok: false, error: "Client name required for save", skip: true });
    }
    await ih.saveIndividualNote(parsed, id);
    res.json({ ok: true, id, saved_at: new Date().toISOString() });
  } catch (err) {
    console.error("[individual autosave]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/admin/hearing/individual/:id", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await ih.deleteIndividualNote(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.message.includes("not found") ? 404 : 500).json({ ok: false, error: err.message });
  }
});

// Generate AI paralegal + client summaries for a saved individual hearing
app.post("/admin/hearing/individual/:id/generate-summaries", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await ih.generateAndSaveSummaries(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[individual generate-summaries]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send paralegal summary of an individual hearing to team Telegram group
app.post("/admin/hearing/individual/:id/send-paralegal", async (req, res) => {
  try {
    const ih = require("./individual-hearing-notes");
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "Invalid id" });
    const result = await ih.sendToTeamGroup(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[individual send-paralegal]:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Extract hearing summary from PDF or text file
// Extract routes moved to earlier in the file — see /admin/hearing/individual/extract-summary
// and /admin/hearing/individual/extract-exhibits above the /:id route.

// Document upload + extract — accepts PDF, JPG, PNG, WebP.
// Uses Claude vision to OCR + extract structured client/case data.
// (docUpload is declared near the top of this file — see near sendgridUpload.)

async function handleExtract(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }
    const name = req.file.originalname || "upload";
    const mime = req.file.mimetype || "";
    const isPdf   = mime.includes("pdf")    || /\.pdf$/i.test(name);
    const isImage = mime.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(name);
    if (!isPdf && !isImage) {
      return res.status(400).json({ ok: false, error: "Unsupported file type. Use PDF, JPG, PNG, or WebP." });
    }
    // Normalize mime type when browser sent something generic
    let effectiveMime = mime;
    if (!effectiveMime || effectiveMime === "application/octet-stream") {
      if (isPdf) effectiveMime = "application/pdf";
      else if (/\.jpe?g$/i.test(name)) effectiveMime = "image/jpeg";
      else if (/\.png$/i.test(name))   effectiveMime = "image/png";
      else if (/\.webp$/i.test(name))  effectiveMime = "image/webp";
    }
    console.log(`[extract-document] Processing ${name} (${req.file.size} bytes, ${effectiveMime})`);
    const hn = require("./hearing-notes");
    const extracted = await hn.extractDocumentFields(req.file.buffer, effectiveMime, name);
    res.json({ ok: true, ...extracted });
  } catch (err) {
    console.error("[extract-document]:", err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
}

app.post("/admin/hearing/notes/extract-document", docUpload.single("document"), handleExtract);

// Backward-compat: old /extract-i589 endpoint still works
app.post("/admin/hearing/notes/extract-i589", docUpload.single("i589"), handleExtract);

// ── Voice call routes ─────────────────────────────────────
app.post("/voice/incoming",          (req, res) => {
  const savedPrompt = app.locals.SYSTEM_PROMPT || null;
  handleIncomingCall(req, res, savedPrompt);
});
app.post("/voice/respond",           (req, res) => handleRespond(req, res));
app.post("/voice/status",            (req, res) => handleCallStatus(req, res));
app.get( "/voice/audio/:id",         (req, res) => handleAudio(req, res));
app.post("/voice/transfer",          (req, res) => handleTransfer(req, res));
app.post("/voice/transfer-fallback", (req, res) => handleTransferFallback(req, res));
app.post("/voice/transcribe",        (req, res) => handleTranscription(req, res));

app.listen(PORT, async () => {
  console.log(`🚀 Zara running on port ${PORT}`);
  initDB();
  initIntakeTable();
  initComplianceTable();

  // Initialize draft template tables (Phase 4)
  try {
    const dt = require("./draft-templates");
    await dt.initDraftTables();
    console.log("✅ Draft template tables ready");
  } catch (e) {
    console.error("⚠️  Draft table init failed:", e.message);
  }

  // Initialize case files table (persistent memory for drafting)
  try {
    const cf = require("./case-files");
    await cf.initCaseFilesTable();
    console.log("✅ Case files table ready");
  } catch (e) {
    console.error("⚠️  Case files table init failed:", e.message);
  }

  // Initialize email paralegal tables + start scheduler
  try {
    const paralegal = require("./email-paralegal");
    const digest = require("./email-digest");
    await paralegal.initEmailTables();
    console.log("✅ Email paralegal tables ready");
    digest.startEmailScheduler();
  } catch (e) {
    console.error("⚠️  Email paralegal init failed:", e.message);
  }

  // Initialize structured intake agent
  try {
    const intakeAgent = require("./intake-agent");
    await intakeAgent.initIntakeAgentTables();
    console.log("✅ Intake agent tables ready");
  } catch (e) {
    console.error("⚠️  Intake agent init failed:", e.message);
  }

  // Initialize USPTO watch tables (trademark monitoring)
  try {
    const usptoWatch = require("./uspto-watch");
    await usptoWatch.initUsptoWatchTables();
    console.log("✅ USPTO watch tables ready");
    usptoWatch.startUsptoScheduler();
  } catch (e) {
    console.error("⚠️  USPTO watch init failed:", e.message);
  }

  // Initialize hearing notes tables (courtroom note-taking tool)
  try {
    const hn = require("./hearing-notes");
    await hn.initHearingNotesTables();
    console.log("✅ Hearing notes tables ready");
  } catch (e) {
    console.error("⚠️  Hearing notes init failed:", e.message);
  }

  // Initialize individual hearing notes tables (merits hearing prep tool)
  try {
    const ih = require("./individual-hearing-notes");
    await ih.initTables();
    console.log("✅ Individual hearing tables ready");
  } catch (e) {
    console.error("⚠️  Individual hearing init failed:", e.message);
  }

  // Load saved system prompt from DB (if admin has edited it)
  initPromptTable().then(() => getSavedPrompt()).then(saved => {
    if (saved) {
      app.locals.SYSTEM_PROMPT = saved;
      console.log("✅ Loaded saved system prompt from DB");
    }
  }).catch(() => {});

  const url = RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com";
  setInterval(() => axios.get(url).catch(() => {}), 4 * 60 * 1000);
  console.log("Keep-alive ping →", url);

  // ── Start WordPress auto-poster ─────────────────────────
  try {
    const { scheduleDaily } = require("./autoposter");
    scheduleDaily();
    console.log("📅 WordPress auto-poster scheduler started.");
  } catch (e) {
    console.error("❌ Auto-poster failed to load:", e.message);
  }

  // ── Start weekly analytics ──────────────────────────────
  try {
    scheduleWeeklyAnalytics();
    console.log("📊 Analytics scheduler started.");
  } catch (e) {
    console.error("❌ Analytics failed to load:", e.message);
  }

  // ── Init Wave 1 tables ─────────────────────────────────
  try {
    const { initWave1Tables } = require("./db");
    initWave1Tables();
  } catch (e) {
    console.error("❌ Wave 1 tables failed:", e.message);
  }

  // ── Hot lead escalation monitor ─────────────────────────
  try {
    startHotLeadMonitor();
  } catch (e) {
    console.error("❌ Hot lead monitor failed:", e.message);
  }

  try {
    startSolScheduler();
  } catch (e) {
    console.error("❌ SOL scheduler failed:", e.message);
  }

  try {
    startDripScheduler();
  } catch (e) {
    console.error("❌ Drip scheduler failed:", e.message);
  }

  // ── Load USCIS processing times ─────────────────────────
  try {
    scheduleUSCISRefresh(app);
    console.log("🏛️  USCIS processing times scheduler started.");
  } catch (e) {
    console.error("❌ USCIS updater failed to load:", e.message);
  }

  // ── Answer cache table ──────────────────────────────────
  try {
    await initCacheTable();
    console.log("⚡ Answer cache table ready.");
  } catch (e) {
    console.error("❌ Answer cache table failed:", e.message);
  }

  // ── Weekly cache purge (every Sunday 3 AM PT) ────────────
  try {
    const { default: cron } = await import("node-cron").catch(() => ({ default: require("node-cron") }));
    cron.schedule("0 11 * * 0", () => {
      purgeExpiredCache().catch(err => console.error("Cache purge error:", err.message));
    }, { timezone: "America/Los_Angeles" });
    console.log("🧹 Weekly cache purge scheduled (Sunday 3 AM PT).");
  } catch (e) {
    console.error("❌ Cache purge scheduler failed:", e.message);
  }

  // ── Legal Intelligence — Citation tables ────────────────
  try {
    await initCitationTables();
    console.log("🔗 Citation tracker tables ready.");
  } catch (e) {
    console.error("❌ Citation tables failed:", e.message);
  }

  // ── Legal Intelligence — Judge profile tables ────────────
  try {
    await initJudgeProfileTables();
    console.log("⚖️  Judge profile tables ready.");
  } catch (e) {
    console.error("❌ Judge profile tables failed:", e.message);
  }

  // ── Legal Intelligence — Daily digest scheduler ──────────
  try {
    scheduleDigest();
    console.log("📰 Legal digest scheduler started (6:00 AM Pacific).");
  } catch (e) {
    console.error("❌ Legal digest scheduler failed:", e.message);
  }

  // ── Matter Manager — Daily deadline summary (7:00 AM PT) ─
  try {
    const { default: cron } = await import("node-cron").catch(() => ({ default: require("node-cron") }));
    cron.schedule("0 7 * * *", () => {
      sendDailyDeadlineSummary().catch(err => console.error("Daily deadline summary error:", err.message));
    }, { timezone: "America/Los_Angeles" });
    console.log("📅 Daily deadline summary scheduled (7:00 AM PT).");
  } catch (e) {
    console.error("❌ Daily deadline summary scheduler failed:", e.message);
  }
});
