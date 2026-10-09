// ============================================================
//  voice-rt.js — ZARA ANSWERS THE PHONE (realtime)
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  voice-call.js answers in turns: Twilio listens until the caller stops,
//  writes down what it heard (in English only), Claude writes a reply, and
//  ElevenLabs reads it out in an English voice. Each turn costs seconds, a
//  Mandarin caller is misheard, and Chinese read by an English voice sounds
//  wrong. JJ tried it and found it "slow and weird".
//
//  This one does not take turns. The call goes from Twilio straight to
//  OpenAI's realtime voice model over SIP: it hears and speaks in one step,
//  answers in under a second, stops when the caller talks over it, and
//  speaks Mandarin, English and Spanish natively. Nothing about the audio
//  passes through this server, so a deploy does not cut a call.
//
//  What this server does is everything around the voice:
//    1. POST /voice/rt/incoming — OpenAI says a call is ringing. We check the
//       signature, decide whether the office is open, and accept the call
//       with Zara's instructions and her tools.
//    2. A control line (WebSocket) to that call, on which the model asks us
//       to do things:  transfer_to_staff · log_lead · take_message ·
//       answer_question (Claude, from the firm's own answers) · end_call.
//    3. When the call ends, a line in Telegram if nothing else was logged,
//       and the call kept in voice_rt_calls. A heartbeat lets the next server
//       take a call over after a deploy.
//    4. POST /voice/rt/voicemail — voicemails from the backup line,
//       transcribed in whatever language they are in.
//
//  JJ's rules (9 Oct 2026):
//    · 9:00–5:00 Pacific, Monday–Friday: every caller is put through to the
//      intake line (RECEPTION_TRANSFER_TO — Lin Mei) after one or two
//      questions, so the staff member knows who is on the line.
//    · After hours: no transfers. Zara does what she can herself, and a
//      prospective client becomes a lead in Telegram's Leads & intake topic
//      for staff to pick up.
//
//  If any of this fails — this server is down, OpenAI does not answer, the
//  accept is refused — Twilio's Disaster Recovery URL on the SIP trunk takes
//  the call instead (see the update's READ-ME: a Twilio Function that rings
//  the intake line in office hours and takes a voicemail otherwise). A
//  caller is never left in silence.
//
//  Configuration (Render environment):
//    OPENAI_API_KEY            already set (Whisper, TTS)
//    OPENAI_WEBHOOK_SECRET     whsec_… from OpenAI → Settings → Webhooks
//    RECEPTION_TRANSFER_TO     the intake line, e.g. +16265551234 (Lin Mei)
//    RECEPTION_MODEL           optional, default gpt-realtime-2
//    RECEPTION_VOICE           optional, default marin
//    RECEPTION_CHINESE_LINES   optional, numbers whose callers hear Mandarin
//                              first (default 6269000688)
//    RECEPTION_CLOSED_DATES    optional, 2026-11-26,2026-12-25 … (holidays)
//    RECEPTION_REFER_DOMAIN    optional, the trunk's termination domain, if
//                              transfers to tel: numbers are refused
//    RECEPTION_BACKUP_TO       optional, a Twilio number running the backup
//                              Function (used only if Zara loses this server
//                              mid-call after hours)
// ============================================================

const crypto = require("crypto");

const API = "https://api.openai.com/v1/realtime";
const WS_API = "wss://api.openai.com/v1/realtime";
const TZ = "America/Los_Angeles";
const OPEN_HOUR = 9, CLOSE_HOUR = 17;                    // 9:00 to 5:00 Pacific
const FALLBACK_MODELS = ["gpt-realtime"];                 // tried if the configured one is refused

// ── Configuration ────────────────────────────────────────────────────────

function cfg(env = process.env) {
  return {
    apiKey: env.OPENAI_API_KEY || "",
    secret: env.OPENAI_WEBHOOK_SECRET || "",
    model: (env.RECEPTION_MODEL || "gpt-realtime-2").trim(),
    voice: (env.RECEPTION_VOICE || "marin").trim(),
    transferTo: normalizeNumber(env.RECEPTION_TRANSFER_TO || ""),
    chineseLines: String(env.RECEPTION_CHINESE_LINES || "6269000688").split(",").map(s => digits(s)).filter(Boolean),
    closedDates: String(env.RECEPTION_CLOSED_DATES || "").split(",").map(s => s.trim()).filter(Boolean),
    // Twilio accepts a transfer to tel:+1… ; if the trunk is set up with a
    // termination domain instead, name it here (e.g. tez-zara.pstn.twilio.com).
    referDomain: (env.RECEPTION_REFER_DOMAIN || "").trim().replace(/^sip:/, ""),
    // Where a call goes if Zara answered but lost her line to this server
    // after hours: a Twilio number that runs the backup Function (voicemail).
    backupTo: normalizeNumber(env.RECEPTION_BACKUP_TO || ""),
  };
}

function digits(s) { return String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); }

/** "+1 (626) 555-1234" → "+16265551234"; anything that is not a US number → "". */
function normalizeNumber(s) {
  const d = digits(s);
  return d.length === 10 ? `+1${d}` : "";
}

/** "(626) 555-1234" for a person to read; the raw value if it is not a US number. */
function prettyNumber(s) {
  const d = digits(s);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (String(s || "").trim() || "unknown");
}

// ── Office hours ─────────────────────────────────────────────────────────

/** The Pacific wall clock for `now`: { day 0–6, hour, minute, date "YYYY-MM-DD" }. */
function pacific(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(p => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day, hour: Number(parts.hour), minute: Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** True from 9:00 to 4:59 Pacific, Monday to Friday, except RECEPTION_CLOSED_DATES. */
function officeOpen(now = new Date(), env = process.env) {
  const p = pacific(now);
  if (p.day < 1 || p.day > 5) return false;
  if (cfg(env).closedDates.includes(p.date)) return false;
  return p.hour >= OPEN_HOUR && p.hour < CLOSE_HOUR;
}

/** "YYYY-MM-DD" plus n calendar days, and its weekday (0 = Sunday). */
function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { date: t.toISOString().slice(0, 10), day: t.getUTCDay() };
}

/** When a caller who rings now will hear back: "later today", "tomorrow morning", "on Monday morning". */
function nextCallback(now = new Date(), env = process.env) {
  const closed = cfg(env).closedDates;
  const p = pacific(now);
  const workday = (x) => x.day >= 1 && x.day <= 5 && !closed.includes(x.date);
  // "Later today" only while there is a working hour left to keep the promise in.
  if (officeOpen(now, env) && p.hour < CLOSE_HOUR - 1) return { en: "later today", zh: "今天稍后", es: "más tarde hoy" };
  if (workday({ day: p.day, date: p.date }) && p.hour < OPEN_HOUR) return { en: "this morning after 9", zh: "今天上午9点以后", es: "esta mañana después de las 9" };
  for (let i = 1; i <= 10; i++) {
    const q = addDays(p.date, i);
    if (!workday(q)) continue;
    if (i === 1) return { en: "tomorrow morning", zh: "明天上午", es: "mañana por la mañana" };
    const en = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][q.day];
    const zh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][q.day];
    const es = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][q.day];
    return { en: `on ${en} morning`, zh: `${zh}上午`, es: `el ${es} por la mañana` };
  }
  return { en: "on the next business day", zh: "下一个工作日", es: "el próximo día hábil" };
}

/** Milliseconds from now until 5:00 Pacific today, or null if that has passed or the office is not open. */
function msUntilClose(now = new Date(), env = process.env) {
  if (!officeOpen(now, env)) return null;
  const p = pacific(now);
  return ((CLOSE_HOUR - p.hour) * 60 - p.minute) * 60000 - (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());
}

// ── Webhook signature (Standard Webhooks, as OpenAI signs them) ─────────

/**
 * OpenAI signs `${webhook-id}.${webhook-timestamp}.${raw body}` with
 * HMAC-SHA256, keyed by the base64 part of the whsec_ secret. The header
 * holds one or more "v1,<base64>" entries separated by spaces.
 */
function verifyWebhook(raw, headers, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || raw == null) return false;
  const h = (k) => headers[k] || headers[k.toLowerCase()] || "";
  const id = h("webhook-id"), ts = h("webhook-timestamp"), sig = h("webhook-signature");
  if (!id || !ts || !sig) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowSec - Number(ts)) > 300) return false;   // five minutes either way
  // As OpenAI's own SDK does: a whsec_ secret is base64 after the prefix; any other is used as text.
  const key = String(secret).startsWith("whsec_") ? Buffer.from(String(secret).slice(6), "base64") : Buffer.from(String(secret), "utf8");
  const body = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const want = crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest();
  return String(sig).split(" ").some(part => {
    const [v, b64] = part.split(",");
    if (v !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

// ── Who is calling ───────────────────────────────────────────────────────

/** From the SIP headers OpenAI forwards: { from: "+16265551234" | "", to: "+16269000688" | "", name }. */
function parseSip(sipHeaders) {
  const list = Array.isArray(sipHeaders) ? sipHeaders : [];
  const get = (n) => (list.find(x => String(x.name || "").toLowerCase() === n) || {}).value || "";
  const num = (v) => {
    const m = String(v).match(/(?:sip|tel):\+?([0-9]{10,15})/i) || String(v).match(/\+?1?\d{10}/);
    return m ? normalizeNumber(m[1] || m[0]) : "";
  };
  const fromRaw = get("from");
  const name = (fromRaw.match(/^\s*"([^"]+)"/) || [])[1] || "";
  return { from: num(fromRaw), to: num(get("to")), name: /^\+?\d+$/.test(name) ? "" : name };
}

// ── What Zara is told ────────────────────────────────────────────────────

function greeting(zhFirst) {
  return zhFirst
    ? "您好，这里是TEZ律师事务所。我是Zara，事务所的AI助理，不是律师。本通话可能会被录音并转成文字。请问有什么可以帮您？"
    : "Thank you for calling TEZ Law Firm. This is Zara, the firm's AI assistant. I'm not an attorney. This call may be recorded and transcribed. How can I help you today?";
}

/** "Friday, October 9, 2026, 7:30 p.m." for the Pacific wall clock at `now`. */
function longDate(now) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(now).replace(/ at /, ", ").replace(/AM$/, "a.m.").replace(/PM$/, "p.m.");
}

/** "Monday, October 12" — the next day the office opens (today if it has not opened yet). */
function nextOpenDay(now, env) {
  const closed = cfg(env).closedDates;
  const p = pacific(now);
  const start = (p.day >= 1 && p.day <= 5 && !closed.includes(p.date) && p.hour < OPEN_HOUR) ? 0 : 1;
  for (let i = start; i <= 10; i++) {
    const q = addDays(p.date, i);
    if (q.day < 1 || q.day > 5 || closed.includes(q.date)) continue;
    const [y, m, d] = q.date.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
  }
  return "the next business day";
}

function buildInstructions({ open, zhFirst, callerNumber = "", now = new Date(), env = process.env, midCall = false } = {}) {
  const back = nextCallback(now, env);
  const clock = `${longDate(now)} Pacific`;
  const reopen = `${nextOpenDay(now, env)}, at 9 in the morning`;

  const officeBlock = open ? `
THE OFFICE IS OPEN NOW (${clock}). It closes at 5 p.m.
Every caller is put through to the office. Before you transfer, find out only what you do not already have of:
  - who they are (name), and
  - in one sentence, what the call is about.
Then say, in their language, that you are connecting them ("One moment, I'm connecting you to our office now."), and call transfer_to_staff in the same turn. Say "our office"; never name the person you are connecting them to, and never say you are connecting them to the attorney.
Court clerks, judges' chambers, other attorneys and insurance adjusters: in one sentence, ask only for whichever of their name, where they are calling from, and the case name or number they have not already given. If they have given them, or decline, transfer at once. Do not ask them anything else.
Do not use answer_question during office hours: transfer instead, and staff will answer.
If the transfer fails, apologize briefly, take a message with take_message (or the details with log_lead for a prospective client), and say our staff will call back as soon as they can.
Do NOT transfer: robocalls, recorded messages, or people selling something to the firm (marketing, SEO, software, advertising). Take their name and company only (no read-back), call take_message with role "vendor", and end the call politely. Never give out the names of anyone at the firm.`
    : `
THE OFFICE IS CLOSED NOW (${clock}). Office hours are Monday to Friday, 9 a.m. to 5 p.m. Pacific. The office reopens ${reopen}.
There are NO transfers after hours. Never say you will connect them, and never promise that someone will call tonight or at any particular time before the office reopens.
Do your best to help the caller yourself:
  - General questions about the law or how a process works: use answer_question and give them the short answer.
  - A prospective client (anyone who may want to hire the firm: an accident, immigration, a business dispute, real estate, an eviction, a will or trust): take the details below and call log_lead. Tell them our staff will call them back ${back.en}.
  - Court clerks, other attorneys, adjusters, existing clients and anyone else: take a complete message with take_message and tell them it will be with our staff ${back.en}.
  - Anything that cannot wait (an ICE detention, a court date or deadline before the office reopens, a very recent serious injury): mark it urgent, and instead of a call-back day say: "I've marked this urgent so our team sees it as soon as possible." Do not promise a time.
  - You may name a government service by what to search for (for example, "search online for the ICE detainee locator"), but never read out a web address.
  - Appointments: to change or cancel one, use take_message with a message beginning "APPOINTMENT:" and the date and time. If the appointment is before the office reopens, mark it urgent and tell them you cannot confirm the change tonight.`;

  return `ON THIS LINE you answer the phone for TEZ Law Firm (Tez Law P.C.), a law firm in West Covina, California, with offices in City of Industry and Newport Beach. The responsible attorney is JJ Zhang. Callers are the public: prospective clients, clients, court clerks, other attorneys, insurance adjusters.
On this phone line, these rules govern wherever they differ from anything above, including how you describe yourself: you are the firm's AI assistant. You are not a lawyer, not a paralegal, not staff and not a person, and you never call yourself any of those. Route callers to "our office" or "our staff", never to the attorney by name.

${midCall ? `THE CALL IS ALREADY IN PROGRESS. Do not greet the caller again. It is now 5:00 p.m. and the office has just closed: if you were about to transfer them, explain that the office has just closed and take a message or the lead details instead. If the caller switches language, tell them in that language that you are the firm's AI assistant, not an attorney, and that the call may be recorded and transcribed.` : `FIRST THING ON THE CALL: say exactly this, then stop and listen:
"${greeting(zhFirst)}"
If the caller answers in a different language, tell them briefly in their language that you are the firm's AI assistant, not an attorney, and that the call may be recorded and transcribed — in the same breath as your first answer to them, not as a separate speech.`}

HOW YOU SPEAK
- Like a calm, warm, experienced receptionist. Short sentences. One question at a time. Never read out lists, menus or web addresses.
- Reply in the language the caller uses, from their first sentence: Mandarin, English or Spanish. If they switch, you switch.
- A caller who speaks Shanghainese gets Mandarin; tell them one of our attorneys speaks Shanghainese, and note "Shanghainese" in the summary. A caller who speaks Cantonese gets Mandarin; say plainly that the firm works in English, Mandarin and Shanghainese.
- Callers often give numbers in pieces, with pauses. If they stop partway through a number, say only a short "mm-hm" (嗯 / ajá) and wait for the rest; do not read anything back until they have finished.
- Read back only a phone number, case number, date or time the caller gave you, once, to confirm it. If a phone number is still unclear after a second try, use the number they are calling from and say so in the notes.
- The caller's number on this call is ${callerNumber ? callerNumber.replace(/^\+1/, "") : "not available"}. When you take a message or a lead, ask whether that is the best number to call back.
- Write names as the caller says them; for a Chinese name, add the pinyin too (for example 王丽 Wang Li).
- If the caller interrupts, stop and listen.
- If you did not catch something, ask once more, simply.
${officeBlock}

PROSPECTIVE CLIENTS — what to collect after hours, or when a transfer fails (during office hours, ask only name and reason, then transfer). Keep it short; a few questions, not an interview. Get the callback number early, in case the call drops.
- Name, best callback number, and their language.
- What happened, in their words, and roughly when.
- Car accident or other injury: the date, whether anyone was hurt and is getting medical treatment, whether there is a police report, and whose insurance is involved. If someone is badly hurt or in danger right now, tell them to call 911 first.
- Someone detained by immigration (ICE): the caller's number first, then the detained person's full name, date of birth, country of birth, A-number if they have it, when and where they were taken, where they are held if known, and the caller's relationship to them. Mark it urgent.
- A court date or deadline coming up: the date. Mark it urgent if it is within 7 days.
- An injury or accident that happened more than a year ago: mark it urgent (time limits may be close).

MESSAGES — for take_message, get: their name, who they are (court clerk, attorney, adjuster, client, other), where they are calling from, the case name or number if there is one, the message itself in full, and a callback number (a clerk or a vendor may not need one; do not insist). For court clerks, write the message down exactly, including every date, time and department number, and read the dates, times and department back once.

EXISTING CLIENTS
- You cannot see anyone's file, and you cannot confirm who a caller is over the phone, so never give out information about a case, not even a hearing date. ${open ? "Ask the case name if they have not said it, then transfer them." : "Take a message, with the case name. If they have a Tara account, they can also check their case in the Tara app or message the firm there."}

THE RULES YOU NEVER BREAK (they are the attorney advertising rules and the firm's own):
- No legal advice about the caller's own situation, and no predictions: never say whether they have a case, will win, will get a visa, or what a case is worth. Say the attorney will need to review the details.
- If a caller asks how a time limit applies to them ("am I too late?"), do not answer: say there are exceptions, that the attorney needs to review it soon, and offer to take their details.
- Never say a consultation is free. If asked about cost, say exactly: "There may be a consultation fee. Our staff will go over it with you." In Mandarin: "可能需要收取咨询费，我们的工作人员会跟您说明。" In Spanish: "Puede haber un cargo por la consulta. Nuestro personal se lo explicará." For any other fee question, say you can't quote fees and staff will go over them.
- Never claim the firm's or the attorney's experience, skill, record, success rate or results. Never call anyone an expert or a specialist.
- Never speak as the attorney or for him. Never say "I am a lawyer" or "the attorney says".
- Never confirm or deny that the firm represents anyone, and never say who the firm's clients are.
- Languages: the firm's attorneys work in English, Mandarin and Shanghainese. Spanish help comes from office staff, who are not attorneys. You may speak Spanish yourself. If asked whether anyone speaks Spanish, say: "I can speak Spanish, and our office staff can help you in Spanish. Our attorneys do not speak Spanish." (in Spanish if they asked in Spanish).
- If a caller objects to the call being recorded or transcribed, apologize, say it cannot be turned off on this line, and offer to end the call; they can write to the firm at 4141 South Nogales Street, Suite C102, West Covina, California 91792.
- Emergencies (someone hurt, in danger, a crime in progress): tell them to call 911.
- If you do not know something, say so and offer a call back. Never make anything up — not a date, a fee, a law, a name or a phone number.${open ? "" : " Cite a law or rule only if answer_question gave it to you."}

TOOLS
${open ? "" : `- answer_question: for general questions about the law, government forms, government filing fees or legal processes. Say "Let me check that for you" first. Pass the question in general terms, WITHOUT the caller's own facts (not "I was rear-ended yesterday, how long do I have?" but "What is the general time limit to file a car accident injury claim in California?"). Then give the answer in two or three short sentences in the caller's language, and add that the attorney would need to review their own situation. Never use it for the firm's own fees: for those, use the consultation fee sentence above.
`}- log_lead: once you have a prospective client's name, number and what happened. Call it once per caller.
- take_message: for everyone else who leaves a message.
${open ? "- transfer_to_staff: office hours only.\n" : ""}- end_call: after you have said goodbye and the caller has nothing else. Do not hang up on someone who is still talking.

Before ending, tell the caller what happens next, thank them, and say goodbye.`;
}

function toolDefs(open) {
  const T = (name, description, properties, required) => ({ type: "function", name, description, parameters: { type: "object", properties, required } });
  const s = (description) => ({ type: "string", description });
  const lang = { type: "string", enum: ["en", "zh", "es", "wuu", "yue", "other"], description: "The language the caller is speaking: en English, zh Mandarin, es Spanish, wuu Shanghainese, yue Cantonese." };
  const tools = [
    T("log_lead", "Record a prospective client so staff can call them back. Call once per caller, when you have their name, number and what happened.", {
      name: s("The caller's name; for a Chinese name, the characters and the pinyin."),
      phone: s("Best callback number, with any extension."),
      language: lang,
      matter: { type: "string", enum: ["personal_injury", "immigration", "detention", "business", "real_estate", "eviction", "estate_planning", "other"], description: "What the matter is about." },
      summary: s("One or two sentences: what happened, in plain words."),
      details: s("Everything else they said that staff will need: dates, injuries, treatment, police report, insurance, the detained person's details, court dates."),
      urgent: { type: "boolean", description: "True for ICE detention, a court date or deadline within 7 days or before the office reopens, a very recent serious injury, an injury or accident more than a year ago, or anything the caller says cannot wait." },
    }, ["name", "phone", "language", "matter", "summary", "urgent"]),
    T("take_message", "Take a message for the office from anyone who is not a prospective client (court clerks, attorneys, adjusters, clients, vendors, appointment changes).", {
      name: s("The caller's name; for a Chinese name, the characters and the pinyin."),
      role: { type: "string", enum: ["court_clerk", "attorney", "adjuster", "client", "vendor", "other"], description: "Who the caller is." },
      calling_from: s("Court, firm, company or relationship to the client."),
      case_ref: s("Case name or case number, if any."),
      message: s("The message in full, including every date, time and department number they gave. Begin with APPOINTMENT: for an appointment change."),
      phone: s("Callback number, with any extension, if they gave one."),
      language: lang,
      urgent: { type: "boolean", description: "True if the caller says it cannot wait, or a deadline, hearing or appointment falls before the office reopens or within 7 days." },
    }, ["name", "role", "message", "language", "urgent"]),
    T("end_call", "Hang up, after you have said goodbye.", {
      reason: s("Why the call is ending, in a few words."),
    }, ["reason"]),
  ];
  if (!open) tools.splice(2, 0, T("answer_question", "Look up a short, general answer to a question about the law, a government form, a government filing fee or a legal process. Not for the firm's own fees and not for the caller's own case.", {
    question: s("The question in general terms, translated into English, with the caller's personal facts left out."),
    language: lang,
  }, ["question", "language"]));
  if (open) tools.unshift(T("transfer_to_staff", "Put the caller through to the office now. Say you are connecting them first, in the same turn.", {
    name: s("The caller's name; for a Chinese name, the characters and the pinyin."),
    role: { type: "string", enum: ["prospective_client", "client", "court_clerk", "attorney", "adjuster", "other"], description: "Who the caller is." },
    summary: s("One line for the staff member who picks up: who it is and what they need."),
    case_ref: s("Case name or number, if any."),
    phone: s("Their callback number if they gave one (otherwise the number they are calling from is used)."),
    urgent: { type: "boolean", description: "True for ICE detention, a court date within 7 days, or anything that cannot wait." },
    language: lang,
  }, ["name", "role", "summary", "language"]));
  return tools;
}

/** The body of POST /calls/{id}/accept. */
function acceptBody({ model, voice, instructions, tools, minimal = false }) {
  const body = { type: "realtime", model, instructions, tools, tool_choice: "auto" };
  body.audio = minimal
    ? { output: { voice } }
    : {
        input: {
          noise_reduction: { type: "near_field" },
          transcription: { model: "gpt-4o-mini-transcribe" },
          // "medium" waits up to 4 seconds when unsure the caller has finished:
          // people pause while reading out a phone number or an A-number, and
          // "high" (2 seconds) would talk over them.
          turn_detection: { type: "semantic_vad", eagerness: "medium" },
        },
        output: { voice },
      };
  if (!minimal) {
    // gpt-realtime-2 reasons before it speaks. On a phone line, low effort
    // keeps replies fast; one tool at a time keeps transfers orderly.
    body.reasoning = { effort: "low" };
    body.parallel_tool_calls = false;
  }
  return body;
}

// ── Telegram text ────────────────────────────────────────────────────────

const LANG = { en: "English", zh: "Mandarin", es: "Spanish", wuu: "Shanghainese", yue: "Cantonese", other: "other language" };
const MATTER = { personal_injury: "Personal injury", immigration: "Immigration", detention: "ICE detention", business: "Business", real_estate: "Real estate", eviction: "Eviction", estate_planning: "Estate planning", other: "Other" };
const ROLE = { court_clerk: "Court clerk", attorney: "Attorney", adjuster: "Insurance adjuster", client: "Client", vendor: "Vendor / sales", other: "Caller", prospective_client: "Prospective client" };
/** A number as the caller gave it: tidied when it is a plain US number, kept as is (extension and all) otherwise. */
const showPhone = (p) => (/^\D*1?\D*(\d\D*){10}$/.test(String(p)) ? prettyNumber(p) : String(p || "").trim().slice(0, 40));
const clip = (s, n = 900) => { const t = String(s || "").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function leadText(a, call) {
  return [
    `${a.urgent ? "🚨 URGENT " : ""}📞 NEW LEAD — phone (${call.open ? "office hours" : "after hours"})`,
    `${clip(a.name, 80)} · ${a.phone ? showPhone(a.phone) : prettyNumber(call.from)} · ${LANG[a.language] || a.language || "?"}`,
    `${MATTER[a.matter] || a.matter || "Other"}: ${clip(a.summary, 400)}`,
    a.details ? `\n${clip(a.details, 1200)}` : "",
    `\nCaller ID ${prettyNumber(call.from)} · line ${prettyNumber(call.to)}`,
  ].filter(Boolean).join("\n");
}

function messageText(a, call) {
  return [
    `${a.urgent ? "🚨 URGENT " : ""}📞 MESSAGE — ${ROLE[a.role] || "Caller"}${a.calling_from ? `, ${clip(a.calling_from, 120)}` : ""}`,
    `${clip(a.name, 80)} · ${a.phone ? showPhone(a.phone) : `caller ID ${prettyNumber(call.from)}`} · ${LANG[a.language] || a.language || "?"}`,
    a.case_ref ? `Case: ${clip(a.case_ref, 160)}` : "",
    `\n${clip(a.message, 1500)}`,
    `\nCaller ID ${prettyNumber(call.from)} · ${call.open ? "office hours" : "after hours"}`,
  ].filter(Boolean).join("\n");
}

function transferText(a, call, to) {
  return [
    `${a.urgent ? "🚨 URGENT " : ""}📲 TRANSFERRING NOW → ${prettyNumber(to)}`,
    `${ROLE[a.role] || "Caller"}: ${clip(a.name, 80)} · ${(a.phone ? showPhone(a.phone) : prettyNumber(call.from))} · ${LANG[a.language] || a.language || "?"}`,
    a.case_ref ? `Case: ${clip(a.case_ref, 160)}` : "",
    clip(a.summary, 500),
  ].filter(Boolean).join("\n");
}

/** Where a message goes: court clerks to the court topic for that court, everything else to Leads & intake. */
function topicForMessage(a, tg) {
  if (a.role === "court_clerk" && tg && typeof tg.courtTopic === "function") {
    return tg.courtTopic({ court: a.calling_from, title: a.case_ref, text: a.message });
  }
  return "leads";
}

// ── One call ─────────────────────────────────────────────────────────────

const ME = process.env.RENDER_INSTANCE_ID || crypto.randomBytes(6).toString("hex");   // this server process
const HEARTBEAT_MS = 10000;
const STALE_SQL = "INTERVAL '25 seconds'";       // a call whose owner has not beaten for this long is free to take over

/** Roughly how long it takes to say `text` aloud: Chinese about 4.5 characters a second, others about 14. */
function speakingMs(text) {
  const t = String(text || "");
  const cjk = (t.match(/[㐀-鿿]/g) || []).length;
  return Math.round(((cjk / 4.5) + ((t.length - cjk) / 14)) * 1000);
}

/** A promise that settles within `ms` either way (Telegram must not keep a caller waiting). */
function capped(promise, ms, wait) {
  return Promise.race([Promise.resolve(promise).catch(() => {}), wait(ms)]);
}

/**
 * deps: { http (axios-like post), WebSocket, tg ({ send, courtTopic }), db ({ query }),
 *         askClaude (question, language), compose (ops) → instructions, wait (ms), now (), log, cfg, env }
 */
class Call {
  constructor(id, info, deps) {
    this.id = id;
    this.from = info.from || "";
    this.to = info.to || "";
    this.open = !!info.open;
    this.zhFirst = !!info.zhFirst;
    this.started = info.started || new Date();
    this.deps = deps;
    this.transcript = info.transcript || [];
    this.logged = info.logged || [];            // [{ kind: "lead"|"message"|"transfer", at, args }]
    this.ended = false;
    this.left = false;                          // transferred or hung up: the call is no longer Zara's
    this.transferring = false;
    this.ws = null;
    this.queue = [];
    this.reconnects = 0;
    this.respStart = 0;
    this.audioStoppedAt = 0;
    this.onStopped = null;
    this.timers = [];
  }

  now() { return this.deps.now ? this.deps.now() : new Date(); }

  /** Open the control line. Resolves true once it is open, false if it never opens. */
  connect() {
    const { WebSocket, cfg: c, log } = this.deps;
    return new Promise((resolve) => {
      let opened = false;
      const ws = new WebSocket(`${WS_API}?call_id=${encodeURIComponent(this.id)}`, { headers: { Authorization: `Bearer ${c.apiKey}` }, handshakeTimeout: 4000 });
      ws.on("open", () => {
        opened = true;
        this.ws = ws;
        const q = this.queue; this.queue = [];
        for (const ev of q) ws.send(JSON.stringify(ev));
        this.startHeartbeat();
        resolve(true);
      });
      ws.on("message", (data) => {
        if (ws !== this.ws) return;
        let ev; try { ev = JSON.parse(String(data)); } catch { return; }
        this.onEvent(ev).catch(e => log.warn(`[voice-rt] ${this.id} event ${ev.type}: ${e.message}`));
      });
      ws.on("error", (e) => { log.warn(`[voice-rt] ${this.id} ws error: ${e.message}`); if (!opened) resolve(false); });
      ws.on("close", () => {
        if (!opened) { resolve(false); return; }  // a line that never opened is the caller's (connect's) business
        if (ws !== this.ws) return;               // an old line closing after a newer one replaced it
        this.onClose().catch(e => log.warn(`[voice-rt] ${this.id} close: ${e.message}`));
      });
    });
  }

  /** Send now if the line is open; otherwise hold it until it reopens. */
  send(ev) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(ev));
    else if (this.queue.length < 50) this.queue.push(ev);
  }

  startHeartbeat() {
    if (this.heartbeat || !this.deps.db) return;
    this.heartbeat = setInterval(() => {
      this.deps.db.query(`UPDATE voice_rt_calls SET heartbeat_at = NOW() WHERE call_id = $1 AND owner = $2 AND ended_at IS NULL`, [this.id, ME])
        .then(r => { if (r && r.rowCount === 0) this.release(); })
        .catch(e => this.deps.log.warn(`[voice-rt] heartbeat: ${e.message}`));
    }, HEARTBEAT_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  /** Another server has taken this call over (or it was closed off): let go without finishing it. */
  release() {
    if (this.ended) return;
    this.ended = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const t of this.timers) clearTimeout(t);
    if (ACTIVE.get(this.id) === this) ACTIVE.delete(this.id);
    try { if (this.ws) this.ws.close(); } catch { /* already closed */ }
  }

  /** At 5:00 the office closes under a call in progress: new instructions, and no transfer tool. */
  scheduleClose() {
    const ms = msUntilClose(this.now(), this.deps.env);
    if (!this.open || ms == null || ms <= 0 || ms > 8 * 3600000) return;
    const t = setTimeout(() => this.closeOffice().catch(e => this.deps.log.warn(`[voice-rt] 5pm switch: ${e.message}`)), ms);
    if (t.unref) t.unref();
    this.timers.push(t);
  }

  async closeOffice() {
    if (this.ended || this.left) return;
    this.open = false;
    const ops = buildInstructions({ open: false, zhFirst: this.zhFirst, callerNumber: this.from, now: this.now(), env: this.deps.env, midCall: true });
    const instructions = await composeCapped(ops, this.deps);
    this.send({ type: "session.update", session: { type: "realtime", instructions, tools: toolDefs(false) } });
  }

  async onEvent(ev) {
    switch (ev.type) {
      case "response.created":
        this.respStart = Date.now();
        break;
      case "output_audio_buffer.stopped":
        this.audioStoppedAt = Date.now();
        if (this.onStopped) { const f = this.onStopped; this.onStopped = null; f(); }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript && ev.transcript.trim()) this.transcript.push({ who: "caller", text: ev.transcript.trim() });
        break;
      case "response.output_audio_transcript.done":
        if (ev.transcript && ev.transcript.trim()) this.transcript.push({ who: "zara", text: ev.transcript.trim() });
        break;
      case "response.done":
        await this.onResponseDone(ev.response || {});
        break;
      case "error":
        this.deps.log.warn(`[voice-rt] ${this.id} model error: ${JSON.stringify(ev.error || ev).slice(0, 300)}`);
        break;
      default: break;
    }
  }

  /** What Zara said aloud in this response (the transcript of its audio). */
  static spoken(response) {
    return ((response && response.output) || [])
      .filter(o => o.type === "message")
      .flatMap(o => o.content || [])
      .map(c => c.transcript || c.text || "")
      .join(" ").trim();
  }

  /** Run every tool the model asked for in this response, then answer them together with one response.create. */
  async onResponseDone(response) {
    const calls = (response.output || []).filter(o => o.type === "function_call");
    const spokenNow = Call.spoken(response);
    if (!calls.length) { if (spokenNow) { this.lastSaid = spokenNow; this.lastSaidAt = Date.now(); } return; }
    // Models sometimes speak in one response and call the tool in the next:
    // what she said in the last 15 seconds counts as the announcement.
    const said = spokenNow || (this.lastSaid && Date.now() - (this.lastSaidAt || 0) < 15000 ? this.lastSaid : "");
    if (spokenNow) { this.lastSaid = spokenNow; this.lastSaidAt = Date.now(); }
    const outputs = [];
    let speak = false;
    const after = [];
    for (const fc of calls) {
      const r = await this.runTool(fc, said);
      if (r.output !== undefined) outputs.push({ call_id: fc.call_id, output: r.output });
      if (r.speak) speak = true;
      if (r.after) after.push(r.after);
    }
    if (this.left) return;                       // transferred: nothing more to say on this line
    for (const o of outputs) this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: o.call_id, output: JSON.stringify(o.output) } });
    if (speak) this.send({ type: "response.create" });
    for (const f of after) await f();
  }

  /** How long to wait for what she just said to finish playing. */
  async waitForQuiet(said) {
    const { wait } = this.deps;
    if (this.audioStoppedAt && this.audioStoppedAt >= this.respStart) return wait(200);
    const left = Math.min(9000, Math.max(600, speakingMs(said) - (Date.now() - (this.respStart || Date.now())) + 400));
    return Promise.race([wait(left), new Promise(r => { this.onStopped = r; })]);
  }

  async runTool(fc, said) {
    let args = {};
    try { args = JSON.parse(fc.arguments || "{}"); } catch { args = {}; }
    const { tg, log } = this.deps;
    const lang = args.language === "zh" ? "zh" : args.language === "es" ? "es" : "en";
    try {
      switch (fc.name) {
        case "log_lead": {
          if (this.logged.some(l => l.kind === "lead")) return { output: { ok: true, note: "Already recorded for this call." }, speak: true };
          this.logged.push({ kind: "lead", at: new Date().toISOString(), args });
          this.save().catch(e => log.warn(`[voice-rt] save: ${e.message}`));
          await capped(tg.send("leads", leadText(args, this)), 1500, this.deps.wait);
          return { output: { ok: true, staff_will_call: nextCallback(this.now(), this.deps.env)[lang] }, speak: true };
        }
        case "take_message": {
          this.logged.push({ kind: "message", at: new Date().toISOString(), args });
          this.save().catch(e => log.warn(`[voice-rt] save: ${e.message}`));
          await capped(tg.send(topicForMessage(args, tg), messageText(args, this)), 1500, this.deps.wait);
          return { output: { ok: true, staff_will_call: nextCallback(this.now(), this.deps.env)[lang] }, speak: true };
        }
        case "answer_question": {
          const text = await Promise.race([
            Promise.resolve(this.deps.askClaude(String(args.question || ""), args.language || "en")).catch(() => ""),
            this.deps.wait(9000).then(() => ""),
          ]);
          return { output: { answer: text || "No reliable answer is available. Say so, and offer to have staff call them back." }, speak: true };
        }
        case "transfer_to_staff":
          return await this.transfer(args, said);
        case "end_call":
          return { output: { ok: true }, speak: false, after: async () => { await this.waitForQuiet(said); await this.hangup(); } };
        default:
          return { output: { ok: false, error: `No tool called ${fc.name}.` }, speak: true };
      }
    } catch (e) {
      log.warn(`[voice-rt] ${this.id} tool ${fc.name}: ${e.message}`);
      return { output: { ok: false, error: "That did not go through. Take a message instead and promise a call back." }, speak: true };
    }
  }

  async transfer(args, said) {
    const { cfg: c, tg, http, log } = this.deps;
    if (this.transferring || this.left) return { output: { ok: true, note: "Already transferring." }, speak: false };
    if (!this.open || !officeOpen(this.now(), this.deps.env)) {
      return { output: { ok: false, reason: "after_hours", say: "The office is closed now. Do not transfer. Take a message or log the lead instead." }, speak: true };
    }
    if (!c.transferTo) {
      log.warn("[voice-rt] RECEPTION_TRANSFER_TO is not set; cannot transfer");
      return { output: { ok: false, reason: "no_line", say: "Transfers are not available right now. Take a message or log the lead instead." }, speak: true };
    }
    if (!said && !this.askedToAnnounce) {
      // Ringing with no word of warning is worse than one more sentence first.
      // Asked once only: a second request goes through either way.
      this.askedToAnnounce = true;
      return { output: { ok: false, reason: "announce_first", say: "First tell the caller, in their language, that you are connecting them now. Then call transfer_to_staff again." }, speak: true };
    }
    this.transferring = true;
    const entry = { kind: "transfer", at: new Date().toISOString(), args };
    this.logged.push(entry);
    // The note reaches Telegram first, so whoever picks up already knows who it is. Not awaited for
    // long: a slow Telegram must not leave the caller in silence.
    await capped(tg.send("leads", transferText(args, this, c.transferTo)), 1000, this.deps.wait);
    await this.waitForQuiet(said);
    try {
      await http.post(`${API}/calls/${encodeURIComponent(this.id)}/refer`, { target_uri: c.referDomain ? `sip:${c.transferTo}@${c.referDomain}` : `tel:${c.transferTo}` },
        { headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" }, timeout: 8000 });
    } catch (e) {
      log.warn(`[voice-rt] ${this.id} refer failed: ${e.message}`);
      entry.failed = true;
      this.transferring = false;
      tg.send("leads", `⚠️ The transfer did not go through. Zara is taking a message instead (caller ${prettyNumber(this.from)}).`).catch(() => {});
      return { output: { ok: false, reason: "transfer_failed", say: "Apologize: the line did not connect. Take a message (or log the lead) and say our staff will call back as soon as they can." }, speak: true };
    }
    this.left = true;                            // the call has left Zara; when the line closes, it is over
    this.save().catch(e => log.warn(`[voice-rt] save: ${e.message}`));
    return { output: undefined, speak: false };
  }

  async hangup() {
    const { cfg: c, http, log } = this.deps;
    this.left = true;
    try {
      await http.post(`${API}/calls/${encodeURIComponent(this.id)}/hangup`, {}, { headers: { Authorization: `Bearer ${c.apiKey}` }, timeout: 8000 });
    } catch (e) { log.warn(`[voice-rt] ${this.id} hangup: ${e.message}`); }
  }

  async onClose() {
    if (this.ended) return;
    // A closed control line is not always the end of the call. Try once
    // straight away (a network blip); a restart is handled by sweep() on the
    // next server, which takes the call over once this one stops beating.
    if (!this.left && this.reconnects < 1) {
      this.reconnects++;
      await this.deps.wait(500);
      if (await this.connect()) return;
    }
    await this.finish();
  }

  async finish() {
    if (this.ended) return;
    this.ended = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const t of this.timers) clearTimeout(t);
    if (ACTIVE.get(this.id) === this) ACTIVE.delete(this.id);
    const secs = Math.round((Date.now() - new Date(this.started).getTime()) / 1000);
    await this.save(true).catch(() => {});
    // A call that ended without a lead, a message or a transfer is still worth
    // one line: a caller who hung up is a lead nobody would otherwise know about.
    if (!this.logged.length && secs >= 10) {
      const said = this.transcript.filter(t => t.who === "caller").map(t => t.text).join(" ");
      await this.deps.tg.send("leads", [
        `📞 Call ended without a message (${secs}s, ${this.open ? "office hours" : "after hours"})`,
        `Caller ID ${prettyNumber(this.from)}`,
        said ? `They said: "${clip(said, 500)}"` : "",
      ].filter(Boolean).join("\n")).catch(() => {});
    }
  }

  async save(ending = false) {
    const { db } = this.deps;
    if (!db) return;
    await db.query(
      `INSERT INTO voice_rt_calls (call_id, from_number, to_number, office_open, started_at, transcript, logged, ended_at, owner, heartbeat_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NOW())
       ON CONFLICT (call_id) DO UPDATE SET transcript = EXCLUDED.transcript, logged = EXCLUDED.logged,
         office_open = EXCLUDED.office_open,
         heartbeat_at = CASE WHEN voice_rt_calls.owner = EXCLUDED.owner THEN NOW() ELSE voice_rt_calls.heartbeat_at END,
         ended_at = COALESCE(voice_rt_calls.ended_at, EXCLUDED.ended_at)`,
      [this.id, this.from, this.to, this.open, this.started, JSON.stringify(this.transcript), JSON.stringify(this.logged), ending ? new Date() : null, ME]);
  }
}

const ACTIVE = new Map();

// ── Accepting a call ─────────────────────────────────────────────────────

/**
 * Accept with the configured model; if refused as a bad request, the same
 * with fewer options, then the fallback model. Anything else (a server error,
 * a timeout) is not retried: the caller is waiting, and a timed-out accept
 * may in fact have gone through. Returns { ok } or { ok: false, unknown }.
 */
async function acceptCall(id, { instructions, tools }, deps) {
  const { http, cfg: c, log } = deps;
  const tries = [
    acceptBody({ model: c.model, voice: c.voice, instructions, tools }),
    acceptBody({ model: c.model, voice: c.voice, instructions, tools, minimal: true }),
    ...FALLBACK_MODELS.filter(m => m !== c.model).map(m => acceptBody({ model: m, voice: c.voice, instructions, tools, minimal: true })),
  ];
  for (const body of tries) {
    try {
      await http.post(`${API}/calls/${encodeURIComponent(id)}/accept`, body,
        { headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" }, timeout: 6000 });
      return { ok: true, body };
    } catch (e) {
      const status = e.response && e.response.status;
      log.warn(`[voice-rt] accept ${id} (${body.model}${body.audio.input ? "" : ", minimal"}) refused: ${status || "no answer"} ${JSON.stringify((e.response && e.response.data) || e.message).slice(0, 300)}`);
      if (!status) return { ok: false, unknown: true, error: e };
      if (status !== 400 && status !== 422) return { ok: false, error: e };
    }
  }
  return { ok: false, error: new Error("every accept was refused") };
}

/** The charter around the line's own rules, within 1.5 seconds; the line's rules alone if not. */
async function composeCapped(ops, deps) {
  try {
    const r = await Promise.race([deps.compose(ops), deps.wait(1500).then(() => { throw new Error("charter took too long"); })]);
    return r || ops;
  } catch (e) {
    deps.log.warn(`[voice-rt] charter compose failed, using the line's rules alone: ${e.message}`);
    return ops;
  }
}

async function handleIncoming(event, deps) {
  const data = (event && event.data) || {};
  const id = data.call_id;
  if (!id) return { ok: false, why: "no call_id" };
  if (ACTIVE.has(id)) return { ok: true, why: "already handling" };
  const sip = parseSip(data.sip_headers);
  const now = deps.now ? deps.now() : new Date();
  const open = officeOpen(now, deps.env);
  const zhFirst = deps.cfg.chineseLines.includes(digits(sip.to));
  const call = new Call(id, { from: sip.from, to: sip.to, open, zhFirst, started: now }, deps);
  ACTIVE.set(id, call);                          // before anything is awaited, so a second delivery is ignored

  // Charter first (who she is, her boundaries), the line's own rules last, as
  // voice-call.js does. A slow or unreachable charter does not hold the call.
  const ops = buildInstructions({ open, zhFirst, callerNumber: sip.from, now, env: deps.env });
  const instructions = await composeCapped(ops, deps);
  const tools = toolDefs(open);

  const backup = async (why) => {
    ACTIVE.delete(id);
    // Refusing hands the call back to Twilio, whose Disaster Recovery URL rings the office.
    await deps.http.post(`${API}/calls/${encodeURIComponent(id)}/reject`, { status_code: 503 },
      { headers: { Authorization: `Bearer ${deps.cfg.apiKey}`, "Content-Type": "application/json" }, timeout: 5000 }).catch(() => {});
    deps.tg.send("ops", `⚠️ Zara could not answer a call from ${prettyNumber(sip.from)}; it went to the backup line. ${why}`).catch(() => {});
    return { ok: false, why: "accept refused" };
  };

  const acc = await acceptCall(id, { instructions, tools }, deps);
  if (!acc.ok && !acc.unknown) return backup(String((acc.error && acc.error.message) || "").slice(0, 200));

  call.save().catch(e => deps.log.warn(`[voice-rt] save: ${e.message}`));
  let connected = false;
  for (let i = 0; i < 3 && !connected; i++) { connected = await call.connect(); if (!connected) await deps.wait(300); }
  if (!connected && acc.unknown) {
    // The accept timed out and no line opens. If the call can still be
    // refused, it was never answered: refuse it to the backup line. If it
    // cannot, it was answered after all, and is handled as below.
    const refused = await deps.http.post(`${API}/calls/${encodeURIComponent(id)}/reject`, { status_code: 503 },
      { headers: { Authorization: `Bearer ${deps.cfg.apiKey}`, "Content-Type": "application/json" }, timeout: 5000 }).then(() => true, () => false);
    if (refused) {
      call.left = true; call.ended = true; ACTIVE.delete(id);
      call.logged.push({ kind: "fallback", at: new Date().toISOString(), args: { to: "backup line" } });
      call.save(true).catch(() => {});
      deps.tg.send("ops", `⚠️ Zara could not answer a call from ${prettyNumber(sip.from)}; it went to the backup line. OpenAI did not answer the accept in time.`).catch(() => {});
      return { ok: false, why: "accept timed out" };
    }
  }
  if (!connected) {
    // Answered, but with no line to this server she can neither speak first
    // nor use her tools. Put the call somewhere a person (or a voicemail) is.
    deps.log.warn(`[voice-rt] ${id}: answered but no control line`);
    const target = open && deps.cfg.transferTo ? deps.cfg.transferTo : deps.cfg.backupTo;
    let moved = false;
    if (target) {
      moved = await deps.http.post(`${API}/calls/${encodeURIComponent(id)}/refer`, { target_uri: deps.cfg.referDomain ? `sip:${target}@${deps.cfg.referDomain}` : `tel:${target}` },
        { headers: { Authorization: `Bearer ${deps.cfg.apiKey}`, "Content-Type": "application/json" }, timeout: 8000 }).then(() => true, () => false);
    }
    if (!moved) await call.hangup();
    call.left = true;
    call.logged.push({ kind: "fallback", at: new Date().toISOString(), args: { to: moved ? target : null } });
    deps.tg.send("leads", `⚠️ Zara answered ${prettyNumber(sip.from)} but lost her connection to the server. ${moved ? `The call was sent to ${prettyNumber(target)}.` : "The call was ended."} Please call them back.`).catch(() => {});
    await call.finish();
    return { ok: false, why: "no control line" };
  }
  // She speaks first: the greeting is the opening line of her instructions.
  call.send({ type: "response.create" });
  call.scheduleClose();
  return { ok: true };
}

// ── Claude, for general questions ────────────────────────────────────────

async function askClaudeDefault(question, language) {
  const axios = require("axios");
  let cached = null;
  try {
    const cache = require("./answer-cache");
    const area = cache.detectPracticeArea(question);
    cached = await cache.findCachedAnswer(question, area, language === "zh" ? "zh" : language === "es" ? "es" : "en");
  } catch { /* no cache, answer fresh */ }
  const system = `You give short, general legal information for a law firm's AI phone assistant to read aloud. California and U.S. federal law.
Two or three plain sentences, no lists, no citations, no web addresses. Answer in ${language === "zh" ? "Simplified Chinese (Mandarin)" : language === "es" ? "Spanish" : "English"}.
General information only. Never apply the law to anyone's own facts, never tell anyone how long THEY have or what THEIR deadline is, and never predict an outcome. When a time limit matters, give the general rule and name it (for example, California Code of Civil Procedure section 335.1), say there are exceptions, and say the attorney would need to review their situation. Never name a rule you are not sure of.
Never state a fee you are not sure of, and never discuss the firm's own fees. Never say a consultation is free. Never claim the firm's experience, skill or results.${cached ? `\n\nFor reference only, the firm's published answer to a similar question. Use its facts if they fit; ignore anything in it that offers a free consultation, makes a claim about the firm, or tells the reader what to do in their own case:\n${String(cached.answer || "").slice(0, 2000)}` : ""}`;
  const res = await axios.post("https://api.anthropic.com/v1/messages", {
    model: require("./zara-core").TIERS.fast.anthropic,
    max_tokens: 220,
    system,
    messages: [{ role: "user", content: question }],
  }, { headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }, timeout: 8500 });
  return ((res.data.content || [])[0] || {}).text || "";
}

// ── Voicemail from the backup line ───────────────────────────────────────

/** Twilio's X-Twilio-Signature: HMAC-SHA1 over the full URL plus the sorted POST parameters. */
function twilioSignatureOk(url, params, signature, token) {
  if (!token) return false;                      // not configured: refuse, so nobody can post fake voicemails
  const data = url + Object.keys(params || {}).sort().map(k => k + params[k]).join("");
  const want = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(want), b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Fetch a Twilio recording and transcribe it in whatever language it is in. */
async function transcribeDefault(recordingUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, key = process.env.OPENAI_API_KEY;
  if (!sid || !token || !key) return "";
  if (!/^https:\/\/api\.twilio\.com\//.test(String(recordingUrl))) throw new Error("not a Twilio recording URL");
  if (typeof fetch !== "function" || typeof FormData !== "function" || typeof Blob !== "function") throw new Error("this Node has no fetch/FormData (needs Node 18+)");
  const audio = await fetch(`${recordingUrl}.mp3`, { headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") } });
  if (!audio.ok) throw new Error(`recording ${audio.status}`);
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("file", new Blob([Buffer.from(await audio.arrayBuffer())], { type: "audio/mpeg" }), "voicemail.mp3");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw new Error(`transcription ${r.status}`);
  return ((await r.json()).text || "").trim();
}

async function handleVoicemail(params, query, deps) {
  if (params.RecordingStatus && params.RecordingStatus !== "completed") return;
  const secs = Number(params.RecordingDuration || 0);
  const from = query.from || "";
  let text = "";
  if (secs >= 2 && params.RecordingUrl) {
    try { text = await deps.transcribe(params.RecordingUrl); } catch (e) { deps.log.warn(`[voice-rt] voicemail transcription: ${e.message}`); }
  }
  await deps.tg.send("leads", [
    `📨 VOICEMAIL (backup line) · ${prettyNumber(from)} · ${secs}s`,
    text ? `\n${clip(text, 1500)}` : (secs < 2 ? "\n(no message left)" : "\n(could not transcribe; the recording is in Twilio → Monitor → Call recordings)"),
  ].join("\n"));
}

// ── Wiring ───────────────────────────────────────────────────────────────

function defaultDeps(over = {}) {
  const env = over.env || process.env;
  const d = { env, cfg: cfg(env), askClaude: askClaudeDefault, transcribe: transcribeDefault,
    compose: (extra) => require("./zara-core").composePrompt({ surface: "voice", extra, lessonScope: "voice" }),
    wait: (ms) => new Promise(r => setTimeout(r, ms)), log: console, ...over };
  // Packages are loaded only when not supplied, so the checks run without node_modules.
  if (!d.http) d.http = require("axios");
  if (!d.WebSocket) d.WebSocket = require("ws");
  if (!d.tg) d.tg = require("./tg-route");
  if (!d.db) d.db = require("./db");
  return d;
}

let tableReady = null;
function initTable(db) {
  tableReady = tableReady || db.query(`
    CREATE TABLE IF NOT EXISTS voice_rt_calls (
      call_id TEXT PRIMARY KEY,
      from_number TEXT, to_number TEXT, office_open BOOLEAN,
      started_at TIMESTAMPTZ DEFAULT NOW(), ended_at TIMESTAMPTZ,
      transcript JSONB, logged JSONB);
    ALTER TABLE voice_rt_calls ADD COLUMN IF NOT EXISTS owner TEXT;
    ALTER TABLE voice_rt_calls ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS voice_rt_calls_started ON voice_rt_calls(started_at);`).catch(e => { tableReady = null; throw e; });
  return tableReady;
}

/**
 * Take over calls whose server has stopped (a deploy: Render starts the new
 * server before it stops the old one, so this waits until the old one has
 * stopped beating, then claims each call atomically). A call that has ended
 * meanwhile is finished properly, so a caller who hung up is still reported.
 * Calls left open for 45 minutes are closed off.
 */
async function sweep(deps) {
  if (!deps.cfg.apiKey) return 0;
  await initTable(deps.db);
  const rows = (await deps.db.query(
    `UPDATE voice_rt_calls SET owner = $1, heartbeat_at = NOW()
      WHERE ended_at IS NULL AND started_at > NOW() - INTERVAL '45 minutes'
        AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - ${STALE_SQL})
        AND NOT (call_id = ANY($2::text[]))
      RETURNING *`, [ME, [...ACTIVE.keys()]])).rows;
  let n = 0;
  for (const r of rows) {
    const call = new Call(r.call_id, { from: r.from_number, to: r.to_number, open: r.office_open, started: r.started_at, transcript: r.transcript || [], logged: r.logged || [] }, deps);
    call.reconnects = 1;                         // one attempt; a call that has ended just finishes
    ACTIVE.set(r.call_id, call);
    if (await call.connect()) { n++; call.scheduleClose(); }
    else { call.left = true; await call.finish(); }
  }
  await deps.db.query(`UPDATE voice_rt_calls SET ended_at = NOW() WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL '45 minutes'
                        AND (heartbeat_at IS NULL OR heartbeat_at < NOW() - ${STALE_SQL})`).catch(() => {});
  if (n) deps.log.log(`[voice-rt] took over ${n} call(s) in progress`);
  return n;
}

const seenWebhooks = new Map();                    // webhook-id → time, so a retried delivery is not answered twice

function mount(app, over = {}) {
  const deps = defaultDeps(over);
  app.post("/voice/rt/incoming", (req, res) => {
    const raw = req.rawBody;
    if (!deps.cfg.secret || !deps.cfg.apiKey) { res.status(503).send("not configured"); return; }
    if (!verifyWebhook(raw, req.headers, deps.cfg.secret)) { res.status(400).send("bad signature"); return; }
    const wid = req.headers["webhook-id"];
    const now = Date.now();
    for (const [k, t] of seenWebhooks) if (now - t > 600000) seenWebhooks.delete(k);
    if (seenWebhooks.has(wid)) { res.status(200).send("ok"); return; }
    seenWebhooks.set(wid, now);
    let event; try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { res.status(400).send("bad json"); return; }
    res.status(200).send("ok");                    // answer the webhook at once; accept the call alongside
    if (event.type !== "realtime.call.incoming") return;
    // The table is made alongside, never in front: a database that is down
    // must not stop a call from being answered.
    initTable(deps.db).catch(e => deps.log.warn(`[voice-rt] table: ${e.message}`));
    handleIncoming(event, deps).catch(e => deps.log.warn(`[voice-rt] incoming: ${e.message}`));
  });
  // The backup line's voicemails (Twilio recordingStatusCallback), transcribed in any language.
  app.post("/voice/rt/voicemail", (req, res) => {
    // Signed over the URL Twilio called: this request's own host, as https (Render terminates TLS).
    const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const url = `${proto}://${req.headers.host}${req.originalUrl}`;
    if (!twilioSignatureOk(url, req.body || {}, req.headers["x-twilio-signature"], deps.env.TWILIO_AUTH_TOKEN)) {
      deps.log.warn(`[voice-rt] voicemail callback refused: bad Twilio signature for ${url}`);
      deps.tg.send("ops", `⚠️ A backup-line voicemail notice was refused (Twilio signature did not match ${url}). Check TWILIO_AUTH_TOKEN and the Function's VOICEMAIL_NOTIFY.`).catch(() => {});
      res.status(403).send("bad signature"); return;
    }
    res.status(200).type("text/xml").send("<Response/>");
    handleVoicemail(req.body || {}, req.query || {}, deps).catch(e => deps.log.warn(`[voice-rt] voicemail: ${e.message}`));
  });
  if (!over.noSweep) {
    const t = setInterval(() => sweep(deps).catch(e => deps.log.warn(`[voice-rt] sweep: ${e.message}`)), 15000);
    if (t.unref) t.unref();
  }
  return deps;
}

module.exports = {
  mount, handleIncoming, sweep, initTable,
  // for scripts/check-voice-rt.js
  _internal: { cfg, officeOpen, nextCallback, msUntilClose, pacific, verifyWebhook, parseSip, buildInstructions, toolDefs, acceptBody, acceptCall,
    leadText, messageText, transferText, topicForMessage, normalizeNumber, prettyNumber, greeting, speakingMs, twilioSignatureOk, handleVoicemail,
    Call, ACTIVE, ME },
};
