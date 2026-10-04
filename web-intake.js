// ============================================================
//  web-intake.js — Brief intake form for tezlawfirm.com pages
//  Tez Law P.C.
//
//  The contact page behind the TEZ card (tezlawfirm.com/jj) shows a short
//  form under "Chat with us": name, phone, optional email, the service
//  needed and a few sentences. The form posts here. This module then:
//
//    1. stores it as a website message, so it shows in the Tara inbox and
//       is already in Zara's history if the person chats later;
//    2. files it where Zara's own chat intakes go (intakes table, client
//       record, lead pipeline, conflict check);
//    3. tells the team on Telegram and by email.
//
//  The page is told "sent" only if at least one of the two notifications
//  went out. If neither did, it gets an error and shows the phone number,
//  so nobody is left believing the firm has a message it never saw.
//
//  Mount once in server.js, next to the website chat routes:
//      require("./web-intake").mount(app);
//
//  Uses the env vars the rest of the bot already has:
//      TELEGRAM_TOKEN, TEAM_TELEGRAM_CHAT_ID, JJ_TELEGRAM_ID,
//      GMAIL_EMAIL, GMAIL_APP_PASSWORD
// ============================================================

const ALLOWED_ORIGINS = ["https://tezlawfirm.com", "https://www.tezlawfirm.com"];

// The choices offered on the form, and the case type each is filed under.
const SERVICES = {
  immigration: "Immigration",
  injury:      "Car Accident / Personal Injury",
  business:    "Business Litigation",
  realestate:  "Real Estate",
  other:       "General Legal",
};

const LIMIT_PER_IP    = 5;                 // submissions per address per window
const LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LIMIT_GLOBAL    = 40;                // submissions per hour, all addresses: keeps a flood out of the team chat
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

const hitsByIp = new Map();
let globalHits = [];

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimited(ip, now = Date.now()) {
  globalHits = globalHits.filter(t => now - t < GLOBAL_WINDOW_MS);
  const mine = (hitsByIp.get(ip) || []).filter(t => now - t < LIMIT_WINDOW_MS);
  if (mine.length >= LIMIT_PER_IP || globalHits.length >= LIMIT_GLOBAL) {
    hitsByIp.set(ip, mine);
    return true;
  }
  mine.push(now); hitsByIp.set(ip, mine); globalHits.push(now);
  if (hitsByIp.size > 5000) {                        // do not let the table grow without bound
    for (const [k, v] of hitsByIp) if (!v.some(t => now - t < LIMIT_WINDOW_MS)) hitsByIp.delete(k);
  }
  return false;
}

// One line of text: control characters and runs of whitespace become one space.
function line(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
// A few sentences: line breaks are kept, other control characters are not.
function para(v, max) {
  return String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Returns { ok: true, intake } or { ok: false, error, field }. */
function validate(body) {
  const b = body && typeof body === "object" ? body : {};
  if (line(b.website, 200)) return { ok: false, error: "rejected", field: "website" };   // hidden field a person never fills
  const name = line(b.name, 80);
  if (name.length < 2) return { ok: false, error: "Please enter your name.", field: "name" };
  const phoneRaw = line(b.phone, 40);
  const digits = phoneRaw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return { ok: false, error: "Please enter a phone number we can reach you at.", field: "phone" };
  const email = line(b.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: "That email address does not look right.", field: "email" };
  const serviceKey = line(b.service, 30).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SERVICES, serviceKey)) return { ok: false, error: "Please choose what you need help with.", field: "service" };
  const message = para(b.message, 1000);
  if (message.length < 10) return { ok: false, error: "Please tell us a little about your situation.", field: "message" };
  const lang = line(b.lang, 12).toLowerCase();
  return {
    ok: true,
    intake: {
      name, phone: phoneRaw, digits, email, serviceKey, caseType: SERVICES[serviceKey], message,
      lang: /^zh/.test(lang) ? "zh" : /^es/.test(lang) ? "es" : "en",
      source: line(b.source, 40) || "website form",
      platform: "website",
      platformId: "web-" + digits,                    // one thread per phone number
    },
  };
}

function nowPT() {
  return new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
}

function teamText(i) {
  return [
    "📋 NEW INTAKE — WEBSITE FORM",
    "",
    `👤 Name: ${i.name}`,
    `⚖️ Needs help with: ${i.caseType}`,
    `📞 Phone: ${i.phone}`,
    i.email ? `📧 Email: ${i.email}` : null,
    `🌐 Browser language: ${i.lang}`,
    `📝 ${i.message}`,
    "",
    `🕐 ${nowPT()} PT · from ${i.source}`,
    "",
    "Reply to this client ASAP! 🔔",
  ].filter(v => v !== null).join("\n");
}

function inboxText(i) {
  return [
    "[Intake form]",
    `Name: ${i.name}`,
    `Phone: ${i.phone}`,
    i.email ? `Email: ${i.email}` : null,
    `Needs help with: ${i.caseType}`,
    "",
    i.message,
  ].filter(v => v !== null).join("\n");
}

async function notifyTelegram(i, deps) {
  // Still throws when nothing is configured: the caller treats a failed
  // team notification as a failed intake, and a silently dropped intake is
  // a lost client.
  const sent = await require("./tg-route").send("leads", teamText(i));
  if (!sent) throw new Error("Telegram is not configured");
}

async function notifyEmail(i, deps) {
  const { GMAIL_EMAIL, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_EMAIL || !GMAIL_APP_PASSWORD) throw new Error("Email is not configured");
  const transporter = deps.nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_EMAIL, pass: GMAIL_APP_PASSWORD } });
  const row = (k, v, alt) => `<tr${alt ? ' style="background:#fff"' : ""}><td style="padding:10px;font-weight:bold;width:150px;vertical-align:top">${k}</td><td style="padding:10px">${v}</td></tr>`;
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#2B2523">
    <div style="background:#2B2523;padding:20px 24px;border-bottom:4px solid #FF7B00">
      <h2 style="color:#FAF8F5;margin:0">New intake from the website form</h2>
    </div>
    <div style="padding:24px;background:#f9f9f9">
      <table style="width:100%;border-collapse:collapse">
        ${row("Name", esc(i.name))}
        ${row("Needs help with", esc(i.caseType), true)}
        ${row("Phone", esc(i.phone))}
        ${row("Email", i.email ? esc(i.email) : "Not given", true)}
        ${row("In their words", esc(i.message).replace(/\n/g, "<br>"))}
        ${row("Sent", `${esc(nowPT())} PT, from ${esc(i.source)}`, true)}
      </table>
    </div>
    <div style="background:#2B2523;padding:14px 24px;text-align:center">
      <p style="color:#E8E3DC;margin:0;font-size:12px">TEZ Law Firm &nbsp;·&nbsp; Zara intake &nbsp;·&nbsp; 626-678-8677</p>
    </div>
  </div>`;
  await transporter.sendMail({
    from: `"Zara Intake" <${GMAIL_EMAIL}>`,
    to: "jj@tezlawfirm.com",
    subject: `📋 New Intake: ${i.caseType} — ${i.name} (website form)`,
    html,
  });
}

// Everything that files the intake inside Zara. None of it may stop the
// notifications, so each step is caught on its own.
async function fileWithZara(i, deps) {
  const db = deps.db;
  const step = async (label, fn) => { try { await fn(); } catch (e) { console.error(`[web-intake] ${label}:`, e.message); } };
  const contact = i.email ? `${i.phone} · ${i.email}` : i.phone;
  await step("client", async () => {
    await db.getOrCreateClient(i.platform, i.platformId, i.lang);
    await db.updateClient(i.platform, i.platformId, { name: i.name, case_type: i.caseType, phone: i.phone, email: i.email || undefined });
  });
  await step("message", () => db.saveMessage(i.platform, i.platformId, "user", inboxText(i)));
  await step("intake", () => db.saveIntake(i.platform, i.platformId, { name: i.name, issue: i.message, contact, caseType: i.caseType }));
  await step("lead", async () => {
    const lead = await db.createLead({ platform: i.platform, platformId: i.platformId, name: i.name, contact, caseType: i.caseType });
    if (!lead) return;
    const conflict = await db.runConflictCheck(lead.id, i.platform, i.platformId, i.name);
    if (conflict && conflict.disposition === "possible") {
      await require("./tg-route").send("leads",
        `⚠️ CONFLICT CHECK — Possible match!\n\nNew client: ${i.name}\nCase: ${i.caseType}\n\n${(conflict.matches || []).length} existing record(s) found with similar name.\n\nReview in Admin Panel → Conflicts tab before assigning.`);
    }
  });
}

function mount(app, overrides = {}) {
  const deps = {
    get axios()      { return overrides.axios      || require("axios"); },
    get nodemailer() { return overrides.nodemailer || require("nodemailer"); },
    get db()         { return overrides.db         || require("./db"); },
  };

  app.options("/intake/web", (req, res) => { cors(req, res); res.sendStatus(200); });

  // The page asks this before showing the form, so the form never appears
  // on a day this module is not deployed.
  app.get("/intake/web", (req, res) => { cors(req, res); res.json({ ok: true, form: "web-intake", version: 1 }); });

  app.post("/intake/web", async (req, res) => {
    cors(req, res);
    const v = validate(req.body);
    if (!v.ok) {
      if (v.field === "website") return res.json({ ok: true });      // a bot filled the hidden field: say thanks, do nothing
      return res.status(400).json({ ok: false, error: v.error, field: v.field });
    }
    if (rateLimited(clientIp(req))) {
      return res.status(429).json({ ok: false, error: "Too many requests. Please call us at 626-678-8677." });
    }
    const intake = v.intake;
    try {
      const [tg, mail] = await Promise.allSettled([notifyTelegram(intake, deps), notifyEmail(intake, deps)]);
      if (tg.status === "rejected")   console.error("[web-intake] Telegram:", tg.reason && tg.reason.message);
      if (mail.status === "rejected") console.error("[web-intake] Email:", mail.reason && mail.reason.message);
      const reachedTeam = tg.status === "fulfilled" || mail.status === "fulfilled";
      await fileWithZara(intake, deps);
      if (!reachedTeam) {
        return res.status(502).json({ ok: false, error: "We could not send this just now. Please call us at 626-678-8677." });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[web-intake] error:", err.message);
      res.status(500).json({ ok: false, error: "We could not send this just now. Please call us at 626-678-8677." });
    }
  });
}

module.exports = { mount, _internal: { validate, teamText, inboxText, rateLimited, SERVICES, ALLOWED_ORIGINS } };
