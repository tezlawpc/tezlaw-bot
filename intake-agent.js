// ============================================================
//  TEZ LAW P.C. — INTAKE AGENT v1
//  ─────────────────────────────────────────────────────────
//  Structured multi-turn intake for new leads across:
//    - WhatsApp
//    - Telegram
//    - Website chat widget
//
//  Flow:
//    1. Detect new inquiry (first message from unknown contact)
//    2. Ask language preference (auto-detect if possible)
//    3. Ask practice area (or infer from initial message)
//    4. Ask practice-area-specific follow-up questions
//    5. Ask for name, callback number, best time
//    6. Classify: HOT / WARM / COLD based on urgency triggers
//    7. Email summary to JJ + WhatsApp alert with tag
//    8. Auto-reply to client with next steps
//
//  Urgent triggers (HOT):
//    - Court date within 7 days
//    - Client in custody / ICE detention
//    - Removal proceedings scheduled
//    - Statute of limitations imminent
//    - Bond hearing pending
//
//  Practice areas supported:
//    - Immigration (asylum, family-based, employment, removal defense)
//    - Personal Injury
//    - Business Litigation
//    - Estate Planning
//    - Landlord/Tenant (evictions)
//    - Trademark (also patents where design, not utility)
// ============================================================

const axios = require("axios");
const db = require("./db");

const ANTHROPIC_MODEL_HAIKU = "claude-haiku-4-5-20251001";

// ── Schema ───────────────────────────────────────────────

async function initIntakeAgentTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS intake_agent_sessions (
      id                SERIAL PRIMARY KEY,
      platform          TEXT NOT NULL,
      platform_id       TEXT NOT NULL,
      state             TEXT DEFAULT 'greeting',
      language          TEXT DEFAULT 'en',
      collected         JSONB DEFAULT '{}'::jsonb,
      practice_area     TEXT,
      urgency           TEXT,
      classification    TEXT,
      transcript        JSONB DEFAULT '[]'::jsonb,
      last_message_at   TIMESTAMPTZ DEFAULT NOW(),
      completed_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (platform, platform_id)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_intake_agent_state
      ON intake_agent_sessions (state, last_message_at DESC)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS intake_agent_records (
      id                SERIAL PRIMARY KEY,
      platform          TEXT NOT NULL,
      platform_id       TEXT NOT NULL,
      session_id        INTEGER REFERENCES intake_agent_sessions(id),
      client_name       TEXT,
      client_phone      TEXT,
      client_email      TEXT,
      language          TEXT,
      practice_area     TEXT,
      case_description  TEXT,
      urgency           TEXT,
      classification    TEXT,
      collected         JSONB,
      preferred_callback TEXT,
      notified_jj       BOOLEAN DEFAULT FALSE,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_intake_records_created
      ON intake_agent_records (created_at DESC)
  `);
}

// ── Language Detection ───────────────────────────────────

function detectLanguage(text) {
  if (!text) return "en";
  // Chinese: any CJK character
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  // Spanish: common markers
  const spanishMarkers = /\b(hola|gracias|necesito|abogado|inmigración|migración|deportación|ayuda|por favor|buenos días|buenas tardes|buenas noches)\b/i;
  if (spanishMarkers.test(text)) return "es";
  return "en";
}

// ── Practice Area Detection ──────────────────────────────

// Fast keyword-based detection. Falls back to Claude Haiku for ambiguous cases.
// Note: `\b` in JS regex requires ASCII word boundaries, so for CJK / Spanish
// accented characters, we use `(?:^|[^\w\u4e00-\u9fff])` instead.
function detectPracticeAreaByKeywords(text) {
  const t = text.toLowerCase();

  // Boundary helper for non-ASCII: matches start/end or non-word character
  const B = "(?:^|[^\\w\\u4e00-\\u9fff])";  // before
  const A = "(?:$|[^\\w\\u4e00-\\u9fff])";  // after

  const patterns = {
    immigration: [
      /\b(uscis|visa|green card|asylum|green-card|refugee|deportation|removal|deportado|deportación|inmigración|migración|immigrat(?:ion|e))\b/,
      /\b(daca|tps|adjustment of status|naturalization|citizenship|ciudadanía)\b/,
      /\b(i-?\d{3}[a-z]?)\b/,
      /\b(eb-?[1-5]|h-?1b|h-?2[ab]|l-?[12]|o-?1|f-?[12]|k-?[13]|j-?1|b-?[12])\b/,
      /\b(ice|detention|detained|detenido|immigration court|removal proceedings|bond hearing|master calendar|individual hearing)\b/,
      /\b(waiver|inadmissibility|admissibility|212\(h\)|601a|hardship|criminal bar)\b/,
      /(移民|签证|绿卡|庇护|驱逐|拘留|移民局|移民法院|入籍|归化)/,
    ],
    personal_injury: [
      /\b(accident|injury|injured|hurt|hospital|ambulance|crash|collision|slip|fall|assault|dog bite|whiplash|concussion)\b/,
      /\b(insurance company|adjuster|settlement|medical bills|lost wages)\b/,
      /\b(lesionado|lesión|accidente|choque|indemnización|seguro médico)\b/,
      /(工伤|车祸|事故|受伤|摔倒|被撞|保险公司|理赔|医疗费|误工费)/,
    ],
    business_litigation: [
      /\b(contract dispute|breach of contract|business dispute|partnership dispute|shareholder|being sued|is suing|suing me|trying to sue|sue (?:me|us)|lawsuit|litigation|dispute)\b/,
      /\b(demand letter|cease and desist|complaint|summons|arbitration|mediation)\b/,
      /\b(demanda|contrato|litigio|arbitraje|socio comercial)\b/,
      /(合同纠纷|合同违约|违约|诉讼|股东纠纷|合伙纠纷|律师函|警告函|起诉|应诉|仲裁|调解)/,
    ],
    estate_planning: [
      /\b(will|trust|estate plan|probate|inheritance|beneficiary|power of attorney|living will|advance directive)\b/,
      /\b(testamento|herencia|fideicomiso|sucesión|patrimonio|poder legal)\b/,
      /(遗嘱|信托|遗产|继承|遗产规划|授权书|受益人)/,
    ],
    landlord_tenant: [
      /\b(eviction|evict|tenant|landlord|rent|lease|unlawful detainer|3.?day notice|30.?day notice|60.?day notice)\b/,
      /\b(desalojo|inquilino|arrendador|arrendataria|renta atrasada|arrendamiento)\b/,
      /(驱逐|房东|房客|租客|租金|租约|驱逐通知)/,
    ],
    trademark: [
      /\b(trademark|tm|servicemark|service mark|brand name|register(?:ing)? (?:a )?mark|uspto|opposition|infringement)\b/,
      /\b(marca|marca registrada|logotipo|infracción de marca)\b/,
      /\b(patent|utility patent|design patent|patent application)\b/,
      /(商标|品牌|商标注册|商标局|商标侵权|专利|发明|设计专利)/,
    ],
  };

  const scores = {};
  for (const [area, regexes] of Object.entries(patterns)) {
    scores[area] = 0;
    for (const re of regexes) {
      const matches = t.match(re);
      if (matches) scores[area] += matches.length;
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] === 0) return null; // no keyword match
  if (sorted[0][1] > sorted[1][1]) return sorted[0][0]; // clear winner
  return null; // tied — need Claude
}

async function detectPracticeAreaClaude(text) {
  try {
    const prompt = `Classify this inquiry into ONE of these practice areas:
- immigration
- personal_injury
- business_litigation
- estate_planning
- landlord_tenant
- trademark
- other

Reply with ONLY the practice area identifier (e.g., "immigration") and nothing else.

Inquiry: "${text.substring(0, 500)}"`;

    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: ANTHROPIC_MODEL_HAIKU,
        max_tokens: 20,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    const answer = resp.data.content?.[0]?.text?.trim().toLowerCase() || "other";
    const valid = ["immigration", "personal_injury", "business_litigation",
                   "estate_planning", "landlord_tenant", "trademark", "other"];
    return valid.includes(answer) ? answer : "other";
  } catch (e) {
    console.error("[intake] Claude classification error:", e.message);
    return "other";
  }
}

// ── Urgency Detection ────────────────────────────────────

function detectUrgencyByKeywords(text) {
  const t = text.toLowerCase();
  const urgentPatterns = [
    { pattern: /\b(detained|detention|in custody|jailed|ice arrested|arrested by ice|拘留|被抓|羁押)\b/, reason: "client_in_custody" },
    { pattern: /\b(court date|hearing|court next week|court tomorrow|court in \d+ days?|court on|开庭|听证)\b/, reason: "court_date_pending" },
    { pattern: /\b(deportation order|removal order|final order|驱逐令|遣返)\b/, reason: "removal_ordered" },
    { pattern: /\b(bond hearing|bond amount|保释|担保)\b/, reason: "bond_hearing" },
    { pattern: /\b(statute of limitations|running out|expires soon|deadline|时效|截止日期)\b/, reason: "sol_imminent" },
    { pattern: /\b(emergency|urgent|asap|right away|immediately|紧急|马上|立刻|urgente|inmediato)\b/, reason: "explicit_urgent" },
    { pattern: /\b(master calendar|individual hearing|merits hearing)\b/, reason: "immigration_hearing_pending" },
  ];

  const triggers = [];
  for (const { pattern, reason } of urgentPatterns) {
    if (pattern.test(t)) triggers.push(reason);
  }
  return triggers;
}

// Check for court date within 7 days from natural language
function checkCourtWithin7Days(text) {
  const t = text.toLowerCase();
  // "court next week", "hearing this week", "court tomorrow", "court in 3 days"
  if (/\b(tomorrow|this week|next week|in \d+ days?|in a few days?|明天|下周|这周|几天后)\b/.test(t) &&
      /\b(court|hearing|开庭|听证|corte|audiencia)\b/.test(t)) {
    return true;
  }
  return false;
}

// ── Classification ───────────────────────────────────────

function classifyLead({ urgencyTriggers, courtWithin7, practiceArea, collected }) {
  // HOT: any urgent trigger fires
  if (urgencyTriggers.length > 0 || courtWithin7) {
    // Prioritize the most severe reason
    const severity = ["client_in_custody", "removal_ordered", "court_date_pending",
                      "bond_hearing", "immigration_hearing_pending", "sol_imminent", "explicit_urgent"];
    for (const s of severity) {
      if (urgencyTriggers.includes(s)) return { level: "hot", reason: s };
    }
    if (courtWithin7) return { level: "hot", reason: "court_date_pending" };
    return { level: "hot", reason: urgencyTriggers[0] };
  }

  // WARM: qualified lead (practice area matches firm services, decent info collected)
  const firmAreas = ["immigration", "personal_injury", "business_litigation",
                     "estate_planning", "landlord_tenant", "trademark"];
  if (firmAreas.includes(practiceArea)) {
    const hasContact = collected.phone || collected.email;
    if (hasContact && collected.name) return { level: "warm", reason: "qualified_lead" };
  }

  // COLD: everything else
  return { level: "cold", reason: "unqualified_or_incomplete" };
}

// ── Localized Strings ────────────────────────────────────

const STRINGS = {
  en: {
    greeting: "Hi! I'm Zara, the AI assistant at Tez Law, P.C. I help attorney JJ Zhang triage new inquiries. To make sure someone gets back to you quickly, I'll ask a few questions.\n\nFirst — what's your name?",
    ask_practice_area: "Thanks, {name}. What type of legal help are you looking for?\n\n1. Immigration (visa, green card, asylum, deportation)\n2. Personal injury (car accident, workplace, etc.)\n3. Business dispute (contract, lawsuit, partnership)\n4. Estate planning (will, trust)\n5. Landlord/Tenant (eviction, lease dispute)\n6. Trademark or patent\n7. Something else\n\nReply with the number or a brief description.",
    ask_description: "Got it. Please briefly describe your situation. Include any deadlines, court dates, or urgent circumstances.",
    ask_contact: "What's the best phone number to reach you at? (You can also share email if preferred.)",
    ask_callback_time: "When's the best time to call you back?\n\n1. Morning (9-12 PT)\n2. Afternoon (1-5 PT)\n3. Evening (5-8 PT)\n4. Anytime\n5. Weekend only",
    hot_close: "Thank you, {name}. Based on what you've shared, this appears urgent. JJ will reach out within 4 hours during business hours (Mon-Fri 9-6 PT). Outside those hours, we'll call as soon as we're back. If truly emergency, call our main line: 626-678-8677.",
    warm_close: "Thank you, {name}. JJ will personally review your inquiry and reach out within 24 business hours. If you need to reach us sooner, call 626-678-8677.",
    cold_close: "Thanks for reaching out, {name}. We'll review your inquiry and follow up if it's a matter our firm can assist with. If it's outside our practice areas, we'll try to refer you elsewhere.",
  },
  zh: {
    greeting: "您好!我是章律师事务所的AI助手Zara。我帮章律师筛选新的咨询。为了让律师能尽快回复您,我会问您几个问题。\n\n首先,请问您的姓名?",
    ask_practice_area: "谢谢您,{name}。请问您需要什么类型的法律帮助?\n\n1. 移民 (签证、绿卡、庇护、驱逐)\n2. 人身伤害 (车祸、工伤等)\n3. 商业纠纷 (合同、诉讼、合伙)\n4. 遗产规划 (遗嘱、信托)\n5. 房东租客 (驱逐、租约纠纷)\n6. 商标或专利\n7. 其他\n\n请回复数字或简短描述。",
    ask_description: "好的。请简要描述您的情况,请包括任何截止日期、开庭日期或紧急情况。",
    ask_contact: "请问您最方便的电话号码是?(如果您愿意,也可以提供电子邮件)",
    ask_callback_time: "什么时间给您回电最方便?\n\n1. 上午 (9-12 太平洋时间)\n2. 下午 (1-5 太平洋时间)\n3. 晚上 (5-8 太平洋时间)\n4. 任何时间\n5. 只有周末",
    hot_close: "谢谢您,{name}。根据您所提供的信息,此事看起来紧急。章律师会在4个营业小时内联系您(周一至周五 上午9点至下午6点 太平洋时间)。如果紧急情况,请拨打事务所主线:626-678-8677。",
    warm_close: "谢谢您,{name}。章律师会亲自审阅您的咨询,并在24个营业小时内回复。如需更快回复,请拨打626-678-8677。",
    cold_close: "谢谢您的咨询,{name}。我们会审阅您的咨询,如果是我们事务所可以协助的事项,会跟进联系。如果不在我们的业务范围内,我们会尽量为您推荐其他律师。",
  },
  es: {
    greeting: "¡Hola! Soy Zara, la asistente virtual de Tez Law, P.C. Ayudo al abogado JJ Zhang a filtrar nuevas consultas. Para asegurar que alguien le responda rápidamente, le haré algunas preguntas.\n\nPrimero, ¿cómo se llama?",
    ask_practice_area: "Gracias, {name}. ¿Qué tipo de ayuda legal está buscando?\n\n1. Inmigración (visa, residencia, asilo, deportación)\n2. Lesiones personales (accidente de auto, trabajo, etc.)\n3. Disputa comercial (contrato, demanda, sociedad)\n4. Planificación patrimonial (testamento, fideicomiso)\n5. Arrendador/Inquilino (desalojo)\n6. Marca o patente\n7. Otra cosa\n\nResponda con el número o una breve descripción.",
    ask_description: "Entendido. Por favor describa brevemente su situación. Incluya cualquier fecha límite, fecha de corte, o circunstancia urgente.",
    ask_contact: "¿Cuál es el mejor número de teléfono para contactarle? (También puede compartir email si prefiere.)",
    ask_callback_time: "¿Cuándo es el mejor momento para llamarle de vuelta?\n\n1. Mañana (9-12 PT)\n2. Tarde (1-5 PT)\n3. Noche (5-8 PT)\n4. Cualquier hora\n5. Solo fin de semana",
    hot_close: "Gracias, {name}. Según lo que ha compartido, esto parece urgente. JJ le contactará dentro de 4 horas hábiles (Lun-Vie 9-6 PT). Fuera de ese horario, le llamaremos cuando regresemos. Para emergencias, llame a: 626-678-8677.",
    warm_close: "Gracias, {name}. JJ revisará personalmente su consulta y responderá dentro de 24 horas hábiles. Si necesita hablar antes, llame al 626-678-8677.",
    cold_close: "Gracias por contactarnos, {name}. Revisaremos su consulta y responderemos si es un asunto en el que nuestra firma puede ayudar. Si está fuera de nuestras áreas de práctica, trataremos de referirle a otro abogado.",
  },
};

function t(lang, key, vars = {}) {
  const table = STRINGS[lang] || STRINGS.en;
  let str = table[key] || STRINGS.en[key] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`{${k}}`, "g"), v);
  }
  return str;
}

// Practice area index to name
const PRACTICE_AREAS_BY_NUM = {
  "1": "immigration",
  "2": "personal_injury",
  "3": "business_litigation",
  "4": "estate_planning",
  "5": "landlord_tenant",
  "6": "trademark",
  "7": "other",
};

// ── State Machine ────────────────────────────────────────

/**
 * Get or create an intake session for this platform+platformId.
 * Sessions live for 24 hours since last message; older sessions are treated as new inquiries.
 */
async function getOrCreateSession(platform, platformId) {
  const r = await db.query(
    `SELECT * FROM intake_agent_sessions
     WHERE platform = $1 AND platform_id = $2
       AND last_message_at > NOW() - INTERVAL '24 hours'
     ORDER BY id DESC LIMIT 1`,
    [platform, platformId]
  );
  if (r.rows[0]) return r.rows[0];

  // Create new
  const insert = await db.query(
    `INSERT INTO intake_agent_sessions (platform, platform_id, state)
     VALUES ($1, $2, 'greeting')
     ON CONFLICT (platform, platform_id) DO UPDATE SET
       state = 'greeting',
       collected = '{}'::jsonb,
       language = 'en',
       practice_area = NULL,
       urgency = NULL,
       classification = NULL,
       transcript = '[]'::jsonb,
       last_message_at = NOW(),
       completed_at = NULL
     RETURNING *`,
    [platform, platformId]
  );
  return insert.rows[0];
}

async function updateSession(sessionId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;
  for (const [k, v] of Object.entries(updates)) {
    if (k === "collected" || k === "transcript") {
      fields.push(`${k} = $${idx}::jsonb`);
      values.push(JSON.stringify(v));
    } else {
      fields.push(`${k} = $${idx}`);
      values.push(v);
    }
    idx++;
  }
  fields.push(`last_message_at = NOW()`);
  values.push(sessionId);
  await db.query(
    `UPDATE intake_agent_sessions SET ${fields.join(", ")} WHERE id = $${idx}`,
    values
  );
}

async function appendTranscript(session, role, message) {
  const t = session.transcript || [];
  t.push({ role, message, at: new Date().toISOString() });
  await db.query(
    `UPDATE intake_agent_sessions SET transcript = $1::jsonb, last_message_at = NOW() WHERE id = $2`,
    [JSON.stringify(t), session.id]
  );
  session.transcript = t;
}

// ── Main Entry Point ─────────────────────────────────────

/**
 * Process a new message through the intake state machine.
 * Returns { handled, message } — if handled=true, the caller should send
 * `message` to the user and NOT invoke normal Claude reply.
 */
async function processIntakeMessage(platform, platformId, userMessage, options = {}) {
  try {
    await initIntakeAgentTables();

    // Skip if this is JJ himself (identified by JJ_TELEGRAM_ID)
    if (platform === "telegram" && platformId === process.env.JJ_TELEGRAM_ID) {
      return { handled: false };
    }

    // Skip if this is a slash command (JJ/team commands: /help, /case, /draft, etc.)
    // Intake should never intercept commands.
    if (userMessage && userMessage.trim().startsWith("/")) {
      return { handled: false };
    }

    // Skip if this is a hashtag command (#casename shortcut)
    if (userMessage && userMessage.trim().startsWith("#")) {
      return { handled: false };
    }

    // Skip if intake explicitly disabled for this contact
    if (options.skipIntake) return { handled: false };

    // Skip on empty messages
    if (!userMessage || !userMessage.trim()) return { handled: false };

    // Skip on very short messages that aren't intake material (e.g. "ok", "thanks")
    // UNLESS we're mid-session (state != greeting).
    const shortResponses = ["ok", "okay", "thanks", "thank you", "yes", "no", "sure", "hi", "hello", "hey"];
    if (shortResponses.includes(userMessage.trim().toLowerCase())) {
      // Only proceed with intake if we already have an active session
      const existing = await db.query(
        `SELECT state FROM intake_agent_sessions
         WHERE platform = $1 AND platform_id = $2
           AND last_message_at > NOW() - INTERVAL '24 hours'
           AND state != 'completed'`,
        [platform, platformId]
      );
      if (!existing.rows.length) {
        return { handled: false };
      }
    }

    const session = await getOrCreateSession(platform, platformId);

    // Auto-detect language from first substantive message if not set
    if (session.state === "greeting" || !session.language) {
      const detectedLang = detectLanguage(userMessage);
      if (detectedLang !== session.language) {
        await updateSession(session.id, { language: detectedLang });
        session.language = detectedLang;
      }
    }

    // Log incoming
    await appendTranscript(session, "user", userMessage);

    let reply = null;
    let done = false;

    const collected = session.collected || {};

    // ── State: greeting → ask for name ──
    if (session.state === "greeting") {
      // Try to extract name from first message if provided
      // But usually first message is a question, so just greet and ask name
      reply = t(session.language, "greeting");
      await updateSession(session.id, { state: "ask_name" });
    }

    // ── State: ask_name → parse name, ask practice area ──
    else if (session.state === "ask_name") {
      const name = extractName(userMessage);
      collected.name = name || userMessage.substring(0, 60).trim();

      // If they didn't just give a name — might have described situation
      // Try to detect practice area from name+description
      const areaFromKeywords = detectPracticeAreaByKeywords(userMessage);
      if (areaFromKeywords) {
        collected.likely_practice_area = areaFromKeywords;
      }

      // Also check urgency signals in whatever they said
      const urgencyTriggers = detectUrgencyByKeywords(userMessage);
      const courtSoon = checkCourtWithin7Days(userMessage);
      if (urgencyTriggers.length || courtSoon) {
        collected.early_urgency_signals = { urgencyTriggers, courtSoon };
      }

      reply = t(session.language, "ask_practice_area", { name: collected.name });
      await updateSession(session.id, {
        state: "ask_practice_area",
        collected,
      });
    }

    // ── State: ask_practice_area → detect area, ask description ──
    else if (session.state === "ask_practice_area") {
      const trimmed = userMessage.trim();
      let area = null;

      // Try number-based selection first
      const numMatch = trimmed.match(/^([1-7])\b/);
      if (numMatch) {
        area = PRACTICE_AREAS_BY_NUM[numMatch[1]];
      }

      // Try keyword detection
      if (!area) {
        area = detectPracticeAreaByKeywords(trimmed);
      }

      // Fall back to Claude Haiku
      if (!area) {
        area = await detectPracticeAreaClaude(trimmed);
      }

      collected.practice_area = area;
      collected.practice_area_source = trimmed.substring(0, 200);

      reply = t(session.language, "ask_description");
      await updateSession(session.id, {
        state: "ask_description",
        practice_area: area,
        collected,
      });
    }

    // ── State: ask_description → save, check urgency, ask contact ──
    else if (session.state === "ask_description") {
      collected.description = userMessage.substring(0, 2000);

      const urgencyTriggers = detectUrgencyByKeywords(userMessage);
      const courtSoon = checkCourtWithin7Days(userMessage);
      // Combine with any early signals from the intake
      const earlySignals = collected.early_urgency_signals || {};
      const allTriggers = [...new Set([
        ...urgencyTriggers,
        ...(earlySignals.urgencyTriggers || [])
      ])];
      const anyCourtSoon = courtSoon || earlySignals.courtSoon;

      collected.urgency_triggers = allTriggers;
      collected.court_within_7_days = anyCourtSoon;

      reply = t(session.language, "ask_contact");
      await updateSession(session.id, {
        state: "ask_contact",
        collected,
      });
    }

    // ── State: ask_contact → parse contact, ask callback time ──
    else if (session.state === "ask_contact") {
      const { phone, email } = extractContact(userMessage);
      if (phone) collected.phone = phone;
      if (email) collected.email = email;
      collected.contact_raw = userMessage.substring(0, 200);

      // Also — check if platform gives us a phone (WhatsApp provides it)
      if (!collected.phone && platform === "whatsapp") {
        collected.phone = platformId;
      }

      reply = t(session.language, "ask_callback_time");
      await updateSession(session.id, {
        state: "ask_callback_time",
        collected,
      });
    }

    // ── State: ask_callback_time → save, classify, close ──
    else if (session.state === "ask_callback_time") {
      const timeMap = {
        "1": "morning",
        "2": "afternoon",
        "3": "evening",
        "4": "anytime",
        "5": "weekend only",
      };
      const numMatch = userMessage.trim().match(/^([1-5])\b/);
      collected.preferred_callback = numMatch
        ? timeMap[numMatch[1]]
        : userMessage.substring(0, 100).trim();

      // Classify
      const classification = classifyLead({
        urgencyTriggers: collected.urgency_triggers || [],
        courtWithin7: collected.court_within_7_days,
        practiceArea: collected.practice_area,
        collected,
      });

      collected.classification = classification;

      // Persist final record
      const record = await saveIntakeRecord({
        platform, platformId, session, collected, classification,
      });

      // Send closing message
      const closeKey = classification.level === "hot" ? "hot_close"
                       : classification.level === "warm" ? "warm_close"
                       : "cold_close";
      reply = t(session.language, closeKey, { name: collected.name });

      // Fire notifications (async, don't block reply)
      notifyJJ({ record, session, collected, classification }).catch(e => {
        console.error("[intake] notify JJ error:", e.message);
      });

      await updateSession(session.id, {
        state: "completed",
        collected,
        classification: classification.level,
        urgency: classification.reason,
        completed_at: new Date(),
      });

      done = true;
    }

    // ── State: completed → session is done. Return handled=false so normal
    //    Claude chat takes over for any further messages ──
    else if (session.state === "completed") {
      return { handled: false };
    }

    // Otherwise: unknown state
    else {
      console.error("[intake] Unknown state:", session.state);
      return { handled: false };
    }

    if (reply) {
      await appendTranscript(session, "assistant", reply);
    }

    return { handled: true, message: reply, done };
  } catch (err) {
    console.error("[intake-agent] processIntakeMessage error:", err.message, err.stack);
    return { handled: false };
  }
}

// ── Helpers ──────────────────────────────────────────────

function extractName(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // "My name is X" / "I'm X" / "This is X"
  const m1 = trimmed.match(/^(?:my name is|i'?m|this is|i am|call me|it's|it is)\s+([a-z][a-z '\-]{1,50})/i);
  if (m1) return m1[1].trim();
  // Very short answer = probably just the name
  if (trimmed.length < 60 && /^[a-z\u4e00-\u9fff][a-z '\-\u4e00-\u9fff]{1,40}$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function extractContact(text) {
  const phone = text.match(/\+?\d[\d\s\-\(\)\.]{9,17}\d/);
  const email = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return {
    phone: phone ? phone[0].replace(/\s+/g, "") : null,
    email: email ? email[0].toLowerCase() : null,
  };
}

async function saveIntakeRecord({ platform, platformId, session, collected, classification }) {
  const r = await db.query(
    `INSERT INTO intake_agent_records
      (platform, platform_id, session_id, client_name, client_phone, client_email,
       language, practice_area, case_description, urgency, classification,
       collected, preferred_callback)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
     RETURNING id`,
    [
      platform, platformId, session.id,
      collected.name || null,
      collected.phone || null,
      collected.email || null,
      session.language,
      collected.practice_area || null,
      collected.description || null,
      classification.reason,
      classification.level,
      JSON.stringify(collected),
      collected.preferred_callback || null,
    ]
  );
  return r.rows[0];
}

// ── Notifications ────────────────────────────────────────

async function notifyJJ({ record, session, collected, classification }) {
  const summary = buildJJSummary({ session, collected, classification });

  // Send WhatsApp alert to JJ
  try {
    await sendWhatsAppToJJ(summary.whatsapp);
  } catch (e) {
    console.error("[intake] WhatsApp alert to JJ failed:", e.message);
  }

  // Send email summary
  try {
    await sendEmailToJJ(summary.email);
  } catch (e) {
    console.error("[intake] Email to JJ failed:", e.message);
  }

  // Mark notified
  await db.query(
    `UPDATE intake_agent_records SET notified_jj = TRUE WHERE id = $1`,
    [record.id]
  );
}

function buildJJSummary({ session, collected, classification }) {
  const emoji = classification.level === "hot" ? "🔴"
                : classification.level === "warm" ? "🟡" : "🟢";
  const areaLabel = {
    immigration: "Immigration",
    personal_injury: "Personal Injury",
    business_litigation: "Business Litigation",
    estate_planning: "Estate Planning",
    landlord_tenant: "Landlord/Tenant",
    trademark: "Trademark/Patent",
    other: "Other",
  }[collected.practice_area] || "Unknown";

  const lines = [
    `${emoji} *${classification.level.toUpperCase()} LEAD — ${areaLabel}*`,
    "",
    `*Name:* ${collected.name || "(not provided)"}`,
    `*Phone:* ${collected.phone || "(not provided)"}`,
    `*Email:* ${collected.email || "(not provided)"}`,
    `*Language:* ${session.language}`,
    `*Callback:* ${collected.preferred_callback || "(not specified)"}`,
    `*Platform:* ${session.platform}`,
    "",
    `*Urgency:* ${classification.reason}`,
    "",
    `*Description:*`,
    (collected.description || "(none)").substring(0, 800),
  ];

  const whatsapp = lines.join("\n");

  const emailBody = [
    `New intake — ${classification.level.toUpperCase()} lead (${areaLabel})`,
    ``,
    `Name: ${collected.name || "(not provided)"}`,
    `Phone: ${collected.phone || "(not provided)"}`,
    `Email: ${collected.email || "(not provided)"}`,
    `Language: ${session.language}`,
    `Preferred callback time: ${collected.preferred_callback || "(not specified)"}`,
    `Platform: ${session.platform}`,
    `Classification reason: ${classification.reason}`,
    ``,
    `Description:`,
    collected.description || "(none)",
    ``,
    `Full collected data:`,
    JSON.stringify(collected, null, 2),
  ].join("\n");

  const emailSubject = `${emoji} ${classification.level.toUpperCase()} lead: ${collected.name || "(no name)"} — ${areaLabel}`;

  return {
    whatsapp,
    email: { subject: emailSubject, body: emailBody, to: process.env.JJ_INTAKE_EMAIL || "jj@tezlawfirm.com" },
  };
}

async function sendWhatsAppToJJ(text) {
  const to = process.env.JJ_WHATSAPP_NUMBER;
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  if (!to || !token || !phoneNumberId) {
    console.log("[intake] WhatsApp env vars missing, skipping JJ alert");
    return;
  }
  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text.substring(0, 3900), preview_url: false },
    },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
}

async function sendEmailToJJ({ subject, body, to }) {
  // Use nodemailer if configured, otherwise skip
  const nodemailer = require("nodemailer");

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpUser) {
    console.log("[intake] SMTP env vars missing, skipping email alert");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(smtpPort) || 587,
    secure: parseInt(smtpPort) === 465,
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from: `"Zara Intake" <${smtpUser}>`,
    to,
    subject,
    text: body,
  });
}

// ── Query API ────────────────────────────────────────────

async function listRecentIntakes(limit = 20) {
  const r = await db.query(
    `SELECT * FROM intake_agent_records ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getIntake(id) {
  const r = await db.query(`SELECT * FROM intake_agent_records WHERE id = $1`, [id]);
  return r.rows[0];
}

async function getIntakeStats(days = 30) {
  const r = await db.query(`
    SELECT
      classification,
      practice_area,
      COUNT(*) AS n
    FROM intake_agent_records
    WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
    GROUP BY classification, practice_area
    ORDER BY classification, n DESC
  `);
  return r.rows;
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  initIntakeAgentTables,
  processIntakeMessage,
  listRecentIntakes,
  getIntake,
  getIntakeStats,
  // exposed for testing
  detectLanguage,
  detectPracticeAreaByKeywords,
  detectUrgencyByKeywords,
  classifyLead,
};

// CLI
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--init")) {
      await initIntakeAgentTables();
      console.log("Intake agent tables ready");
      process.exit(0);
    }
    if (args.includes("--list")) {
      const rows = await listRecentIntakes(20);
      console.log(`${rows.length} recent intake(s):`);
      for (const r of rows) {
        console.log(`  #${r.id} | ${r.classification} | ${r.practice_area} | ${r.client_name} | ${r.created_at}`);
      }
      process.exit(0);
    }
    if (args.includes("--stats")) {
      const rows = await getIntakeStats(30);
      console.log(rows);
      process.exit(0);
    }
    console.log("Usage: node intake-agent.js [--init | --list | --stats]");
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
