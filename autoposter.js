// ============================================================
//  TEZ LAW P.C. — WORDPRESS AUTO-POSTER v3 (Sept 2026)
//  v3: exact category matching (English posts were being filed under
//      "Español-…"), no tag spam, Yoast meta that actually saves,
//      linked translations (hreflang), practice-page internal links,
//      Rule 7.1 compliance gate, complete translations, IndexNow ping
//      (Bing / ChatGPT search / Copilot), brand footer.
//  Requires the "Tez SEO pack" v2 snippet on WordPress (registers the
//  meta fields this file writes).
// ============================================================

const axios = require("axios");
const fs    = require("fs");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TEAM_CHAT_ID      = process.env.TEAM_TELEGRAM_CHAT_ID;
const WP_URL            = process.env.WP_URL;
const WP_USER           = process.env.WP_USER;
const WP_APP_PASSWORD   = process.env.WP_APP_PASSWORD;

const STATE_FILE   = "/var/data/autoposter_state.json";
const SITE_HOST    = "tezlawfirm.com";
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || "7f3c9a2e5b8d4e1fa6c0b9d27e4f8a13";
// Chinese script for translations: "simplified" (mainland / WeChat readers, default) or "traditional"
const ZH_SCRIPT    = (process.env.ZH_SCRIPT || "simplified").toLowerCase() === "traditional" ? "traditional" : "simplified";
const ZH_LANG_TAG  = ZH_SCRIPT === "traditional" ? "zh-Hant" : "zh-Hans";
// Optional: {"Immigration":123,"Personal Injury":456,...} WordPress media IDs used as featured images
let FEATURED_MEDIA = {};
try { FEATURED_MEDIA = JSON.parse(process.env.WP_FEATURED_MEDIA || "{}"); } catch (e) { FEATURED_MEDIA = {}; }

// Practice pages the posts should link into (hub-and-spoke internal linking)
const PRACTICE_LINKS = [
  ["Immigration overview", "https://tezlawfirm.com/immigration/"],
  ["Family-based immigration (I-130, green cards, K-1, naturalization)", "https://tezlawfirm.com/immigration/family-based-visa/"],
  ["Removal defense, Immigration Court, bond, asylum, habeas", "https://tezlawfirm.com/immigration/removal-proceedings-immigration-court/"],
  ["Investor visas overview", "https://tezlawfirm.com/immigration/investor-based-visa/"],
  ["EB-5 investor green card", "https://tezlawfirm.com/immigration/investor-based-visa/eb5-visa-lawyer/"],
  ["E-2 treaty investor visa", "https://tezlawfirm.com/immigration/investor-based-visa/e2-visa-lawyer-treaty-investor-visas-e-2/"],
  ["E-1 treaty trader visa", "https://tezlawfirm.com/immigration/investor-based-visa/e1-visa-lawyer/"],
  ["B-1 business visitor visa", "https://tezlawfirm.com/immigration/investor-based-visa/b1-visa-lawyer/"],
  ["Employment visas overview", "https://tezlawfirm.com/immigration/employment-based-visa/"],
  ["H-1B specialty occupation", "https://tezlawfirm.com/immigration/employment-based-visa/h1b-visa-lawyer/"],
  ["H-2B seasonal workers", "https://tezlawfirm.com/immigration/employment-based-visa/h2b-visa-lawyer/"],
  ["L-1A managers and executives", "https://tezlawfirm.com/immigration/employment-based-visa/l1a-visa-lawyer/"],
  ["L-1B specialized knowledge", "https://tezlawfirm.com/immigration/employment-based-visa/l1b-visa-lawyer/"],
  ["EB-1 green card", "https://tezlawfirm.com/immigration/employment-based-visa/eb1-visa-lawyer/"],
  ["EB-2 and national interest waiver", "https://tezlawfirm.com/immigration/employment-based-visa/eb2-visa-lawyer/"],
  ["EB-3 and PERM", "https://tezlawfirm.com/immigration/employment-based-visa/eb3-visa-lawyer/"],
  ["Personal injury and car accidents", "https://tezlawfirm.com/home/personal-injury/"],
  ["Business disputes, litigation, landlord-tenant and evictions", "https://tezlawfirm.com/business-litigation/"],
  ["Real estate and construction", "https://tezlawfirm.com/real-estate-construction/"],
  ["Estate planning, trusts, premarital agreements", "https://tezlawfirm.com/private-client/"],
  ["Trademarks, copyrights and IP", "https://tezlawfirm.com/intellectual-property/"],
  ["Public companies, OTC and Nasdaq uplisting", "https://tezlawfirm.com/public-companies/"],
  ["Contact / schedule a consultation", "https://tezlawfirm.com/contact/"],
];
const SOURCES_FILE = "/var/data/sources.json";

const JJ_VOICE = `
You are rewriting a legal blog post in the voice of JJ Zhang, founding attorney at TEZ Law Firm.
JJ's style: Conversational and direct. Signature phrase: "Protect your rights — we handle the rest."
Uses "we"/"our team" not "I". Short punchy sentences mixed with longer explanations.
Never uses: "In today's complex landscape", "navigating", "it's important to note", "comprehensive", "multifaceted".
Gets straight to the point. Empathetic but practical. Uses contractions naturally.
Occasionally uses rhetorical questions. Never guarantees outcomes.
JJ is an immigrant himself. Has business/real estate background. Speaks English, Mandarin, Shanghainese.`;

const FOOTER_TEXT = {
  en: { label: "About the Author", title: "Founding Attorney · TEZ Law Firm", bio: "<strong>JJ Zhang came to the United States as an immigrant</strong> and built businesses in hospitality, manufacturing, real estate and lending before practicing law. Today he and the TEZ Law Firm team represent individuals, families, investors and companies.", tagline: "Protect your rights, we’ll lead the fight.", cta1: "Schedule a consultation · 626-678-8677", cta2: "Save our contact details →", chat: "WhatsApp, WeChat, Telegram, phone and email — all on our contact page:", areas: "<strong>Immigration:</strong> nationwide · <strong>Injury, disputes and real estate:</strong> Los Angeles, Orange, San Bernardino and Riverside counties", disc: "This article is general information, not legal advice, and reading it does not create an attorney-client relationship. Laws and agency practices change; contact TEZ Law Firm at 626-678-8677 or jj@tezlawfirm.com about your situation. Prior results do not guarantee a similar outcome." },
  zh: { label: "关于作者", title: "创始律师 · TEZ律师事务所", bio: "<strong>章律师本人也是移民</strong>，从事法律工作之前曾经营酒店、制造、房地产开发和贷款业务。如今，他与 TEZ律师事务所团队一起为个人、家庭、投资人和企业提供法律服务。", tagline: "守护您的权益，我们为您据理力争。", cta1: "预约咨询 · 626-678-8677", cta2: "保存我们的联系方式 →", chat: "WhatsApp、微信、Telegram、电话和电子邮件，尽在我们的联系页面：", areas: "<strong>移民案件：</strong>全美 · <strong>人身伤害、商业纠纷与房地产：</strong>洛杉矶、橙县、圣贝纳迪诺和河滨县", disc: "本文仅为一般信息，不构成法律意见，阅读本文不建立律师与客户关系。法律和政府做法经常变化，具体情况请致电 626-678-8677 或发邮件至 jj@tezlawfirm.com 咨询 TEZ律师事务所。过往结果不保证类似结果。" },
  es: { label: "Sobre el autor", title: "Abogado fundador · TEZ Law Firm", bio: "<strong>JJ Zhang llegó a Estados Unidos como inmigrante</strong> y dirigió negocios de hotelería, manufactura, bienes raíces y préstamos antes de ejercer la abogacía. Hoy él y el equipo de TEZ Law Firm representan a personas, familias, inversionistas y empresas.", tagline: "Proteja sus derechos, nosotros damos la pelea.", cta1: "Programe una consulta · 626-678-8677", cta2: "Guarde nuestros datos de contacto →", chat: "WhatsApp, WeChat, Telegram, teléfono y correo, todo en nuestra página de contacto:", areas: "<strong>Inmigración:</strong> en todo el país · <strong>Lesiones, disputas y bienes raíces:</strong> condados de Los Ángeles, Orange, San Bernardino y Riverside", disc: "Este artículo es información general, no asesoría legal, y leerlo no crea una relación abogado-cliente. Las leyes cambian; comuníquese con TEZ Law Firm al 626-678-8677 o jj@tezlawfirm.com sobre su caso. Los resultados anteriores no garantizan un resultado similar." },
};
const FOOTER_MARK = "<style>.tez-ab{";
// Every way to reach the firm lives on one page, tezlawfirm.com/jj, so that a
// number or a handle that changes is changed in one place. This footer used
// to carry its own copies — the retired V1CE intake link, a WhatsApp number
// and a Telegram bot that are not the ones on the contact page, and a WeChat
// id — and each new post published them again.
function getStaticFooter(title, lang = "en") {
  const t = FOOTER_TEXT[lang] || FOOTER_TEXT.en;
  return `
<style>.tez-ab{display:flex;flex-direction:column;gap:14px;padding:28px 24px;margin:40px 0 24px;background:#FAF8F5;border:1px solid #D6CFC6;border-left:5px solid #FF7B00;font-family:'Montserrat','Helvetica Neue',Arial,sans-serif;line-height:1.6;color:#2B2523}.tez-ab *{box-sizing:border-box}.tez-ab-label{display:inline-block;font-size:.7rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#A34C00}.tez-ab-name{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.5rem;font-weight:600;color:#2B2523;margin:4px 0 2px}.tez-ab-cn{font-size:.95rem;color:#5E5652;margin-left:8px}.tez-ab-title{font-size:.88rem;color:#5E5652;margin-bottom:6px}.tez-ab-creds{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.8rem;color:#5E5652;margin-bottom:8px}.tez-ab-bio{font-size:.92rem;margin:0 0 10px}.tez-ab-langs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}.tez-lang{background:#fff;border:1px solid #D6CFC6;padding:3px 12px;font-size:.78rem;font-weight:600}.tez-ab-tagline{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.1rem;font-weight:600;color:#A34C00;margin-bottom:12px}.tez-ab-ctas{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px}.tez-cta1{background:#FF7B00;color:#2B2523!important;font-size:.82rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:11px 20px;text-decoration:none!important}.tez-cta2{color:#2B2523!important;font-size:.82rem;font-weight:600;padding:9px 18px;border:1px solid #2B2523;text-decoration:none!important}.tez-ab-chat,.tez-ab-areas{font-size:.8rem;color:#5E5652}.tez-ab-chat a{color:#A34C00;font-weight:600}</style>
<aside class="tez-ab" aria-label="${t.label}"><div>
<span class="tez-ab-label">${t.label}</span>
<div class="tez-ab-name">JJ Zhang, Esq.<span class="tez-ab-cn">章律师</span></div>
<div class="tez-ab-title">${t.title}</div>
<div class="tez-ab-creds"><span>California State Bar #326666</span><span>U.S. Court of Appeals, Ninth Circuit</span><span>CA Real Estate Broker #01921248</span></div>
<p class="tez-ab-bio">${t.bio}</p>
<div class="tez-ab-langs"><span class="tez-lang">English</span><span class="tez-lang">普通话 Mandarin</span><span class="tez-lang">上海话 Shanghainese</span><span class="tez-lang">Español (support)</span></div>
<div class="tez-ab-tagline">${t.tagline}</div>
<div class="tez-ab-ctas"><a href="https://tezlawfirm.com/contact/" class="tez-cta1">${t.cta1}</a><a href="https://tezlawfirm.com/jj" class="tez-cta2">${t.cta2}</a></div>
<div class="tez-ab-chat">${t.chat} <a href="https://tezlawfirm.com/jj">tezlawfirm.com/jj</a></div>
<div class="tez-ab-areas">${t.areas}</div>
</div></aside>
<p style="font-size:12px;color:#5E5652;margin-top:18px;"><em>${t.disc}</em></p>`;
}
function stripFooter(html) {
  const s = String(html || "");
  const i = s.indexOf(FOOTER_MARK);
  const j = s.indexOf("<style>.tez-ab{display:flex;flex-direction:column;gap:16px"); // v2 footer
  const k = [i, j].filter(x => x > 0).sort((x, y) => x - y)[0];
  return k ? s.substring(0, k) : s;
}

// ─────────────────────────────────────────────────────────────
//  CA Rule 7.1 compliance gate
//  Flags comparative / superlative claims about the firm, outcome
//  promises and "specialist" claims. Third-party uses ("expert
//  witnesses", "specialized knowledge", "no one can guarantee") pass.
// ─────────────────────────────────────────────────────────────
function complianceIssues(html) {
  const text = String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const issues = [];
  const rules = [
    [/\b(best|top|top-rated|leading|premier|number one|#1)\b[^.!?]{0,40}\b(lawyers?|attorneys?|law firms?|legal team|firm)\b/gi, "superlative about lawyers or the firm"],
    [/\b(expert|experienced expert)s?\s+(lawyers?|attorneys?|legal (team|help|advice|representation|services?)|immigration (lawyers?|attorneys?|help))\b/gi, "calls the firm 'expert'"],
    [/\bspeciali(?:sts?|[sz]es?|[sz]ing)\b/gi, "specialist / specializing claim"],
    [/\b(we|our (team|firm|attorneys?|lawyers?))\s+(will\s+)?(win|get you|secure|obtain)\b[^.!?]{0,30}\b(case|approval|green card|visa|settlement|compensation)\b/gi, "promises a result"],
    [/\b(our|we have an?|we have)\b[^.!?]{0,25}\b(success|approval|win) rates?\b|\b(our|we)\b[^.!?]{0,30}\d+\s*%\s*(success|approval|win)/gi, "success-rate claim"],
    [/\b(we|our (team|firm|attorneys?|lawyers?)|tez law(?: p\.c\.)?)[^!?]{0,40}?\bguarantee[sd]?\b|\bguaranteed\s+(approval|results?|outcomes?|visas?|green cards?|wins?|settlements?|compensation)\b/gi, "guarantee"],
  ];
  for (const [re, why] of rules) {
    let m;
    while ((m = re.exec(text))) {
      const before = text.substring(Math.max(0, m.index - 30), m.index).toLowerCase();
      if (why === "guarantee" && (/(not|no|never|cannot|can't|doesn't|don't|won't|without|no one can)\s*(\w+\s*){0,3}$/.test(before) || /\b(not|never|cannot|can't|can not|no one can|don't|doesn't|won't)\b/i.test(m[0]))) continue;
      if (why.startsWith("specialist") && /specialized knowledge|specialty occupation/i.test(text.substring(m.index, m.index + 30))) continue;
      issues.push(`${why}: "${text.substring(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim()}"`);
    }
  }
  return issues;
}

function loadState() {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) {}
  return { lastImmigrationCheck: null, lastWeatherCheck: null, publishedTitles: [], weeklyEvergreen: { pi: null, business: null, trademark: null, estate: null }, lastHolidayPost: null, titleHistory: [] };
}
function saveState(state) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {} }

const DEFAULT_SOURCES = {
  immigration: [
    "uscis.gov/newsroom",
    "aila.org",
    "migrationpolicy.org",
    "apnews.com/hub/immigration",
    "politico.com/immigration",
    "laopinion.com/inmigracion",
    "univision.com/noticias/inmigracion",
    "immigrationimpact.com"
  ],
  personalInjury: [
    "nhtsa.gov",
    "claimsjournal.com",
    "insurancejournal.com",
    "courthousenews.com",
    "caoc.org",
    "courts.ca.gov/newsroom"
  ],
  business: [
    "ftc.gov/news-events",
    "sec.gov/newsroom",
    "justice.gov/atr",
    "law.com/therecorder",
    "courthousenews.com",
    "corpgov.law.harvard.edu"
  ],
  trademark: [
    "uspto.gov",
    "ipwatchdog.com",
    "patentlyo.com",
    "thettablog.blogspot.com",
    "law360.com/ip"
  ],
  realEstate: [
    "dre.ca.gov",
    "hcd.ca.gov",
    "car.org/newsroom",
    "therealdeal.com/la",
    "courts.ca.gov/newsroom",
    "latimes.com/homeless-housing"
  ],
  landlordTenant: [
    "hcd.ca.gov",
    "courts.ca.gov/selfhelp-eviction",
    "lahd.lacity.gov",
    "caanet.org",
    "calmatters.org/housing",
    "courts.ca.gov/newsroom"
  ],
  estate: [
    "irs.gov/newsroom",
    "actecfoundation.org/blog",
    "wealthmanagement.com/estate-planning",
    "kiplinger.com/retirement",
    "courts.ca.gov/newsroom"
  ],
  lastResearched: null,
  version: 1
};

function loadSources() {
  try {
    if (fs.existsSync(SOURCES_FILE)) {
      const s = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
      return { ...DEFAULT_SOURCES, ...s };
    }
  } catch (e) {}
  return { ...DEFAULT_SOURCES };
}
function saveSources(sources) { try { fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2)); } catch (e) {} }

async function askClaude(prompt, useWebSearch = false, retries = 3, maxTokens = 8192) {
  const body = { model: require("./zara-core").TIERS.balanced.anthropic, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post("https://api.anthropic.com/v1/messages", body, {
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }
      });
      return response.data.content.filter(b => b.type === "text").map(b => b.text).join("");
    } catch (e) {
      if (e.response?.status === 429 && attempt < retries) {
        const wait = attempt * 30000;
        console.log(`⏳ Rate limited. Waiting ${wait/1000}s before retry ${attempt}/${retries}...`);
        await new Promise(r => setTimeout(r, wait));
      } else { throw e; }
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  DUPLICATE DETECTION — FIXED
//  FIX 1: isDuplicateTitle checks BOTH titleHistory AND publishedTitles
//  FIX 2: recordPublishedTitle deduplicates and caps at 500 entries
// ─────────────────────────────────────────────────────────────

function isDuplicateTitle(title, state) {
  const normalize = t => t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, " ").replace(/\s+/g, " ").trim();
  const normalized = normalize(title);
  // Check BOTH lists — previously only checked titleHistory, missing entries saved to publishedTitles
  const allTitles = [...new Set([...(state.titleHistory || []), ...(state.publishedTitles || [])])];
  return allTitles.some(t => {
    const n = normalize(t);
    const words = normalized.split(" ").filter(w => w.length > 3);
    const matches = words.filter(w => n.includes(w));
    return matches.length >= 3 || (matches.length / Math.max(words.length, 1)) >= 0.6;
  });
}

async function checkWordPressDuplicate(title, auth) {
  try {
    const search = title.split(" ").slice(0, 5).join(" ");
    const res = await axios.get(`${WP_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(search)}&per_page=5&status=publish`, { headers: { Authorization: `Basic ${auth}` } });
    if (res.data.length > 0) {
      const normalize = t => t.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
      const normalized = normalize(title);
      for (const post of res.data) {
        const existing = normalize(post.title.rendered);
        const words = normalized.split(" ").filter(w => w.length > 3);
        if (words.filter(w => existing.includes(w)).length >= 4) { console.log(`⚠️ WP duplicate found: "${post.title.rendered}"`); return true; }
      }
    }
  } catch (e) { console.log("WP duplicate check failed:", e.message); }
  return false;
}

function recordPublishedTitle(title, state) {
  if (!state.titleHistory) state.titleHistory = [];
  if (!state.publishedTitles) state.publishedTitles = [];
  // Deduplicate — don't add if already present
  if (!state.titleHistory.includes(title)) state.titleHistory.push(title);
  if (!state.publishedTitles.includes(title)) state.publishedTitles.push(title);
  // Cap at 500 entries to prevent state file bloat
  if (state.titleHistory.length > 500) state.titleHistory = state.titleHistory.slice(-400);
  if (state.publishedTitles.length > 500) state.publishedTitles = state.publishedTitles.slice(-400);
  saveState(state);
}

function countTags(html, tag) { return (String(html).match(new RegExp(`<${tag}[\\s>]`, "gi")) || []).length; }

async function translatePost(post, language) {
  const zhLabel = ZH_SCRIPT === "traditional" ? "Traditional Chinese (繁體中文)" : "Simplified Chinese (简体中文)";
  const cfgs = {
    chinese: { label: zhLabel, lang: "zh", langTag: ZH_LANG_TAG, categoryPrefix: "中文-" },
    spanish: { label: "Latin American Spanish", lang: "es", langTag: "es", categoryPrefix: "Español-" },
  };
  const cfg = cfgs[language];
  if (!cfg) return null;
  console.log(`🌐 Translating to ${cfg.label}...`);
  const articleBody = stripFooter(post.content);
  const prompt = `Translate this law-firm blog post into ${cfg.label} for readers in the United States.
Rules:
- Keep every HTML tag, attribute and URL exactly as is. Translate only visible text.
- Keep phone numbers, emails, form numbers (I-130, H-1B…), statute and case names unchanged.
- Natural, plain language — not word-for-word. Keep legal terms accurate${language === "chinese" ? " (e.g. green card = 绿卡, asylum = 庇护, USCIS = 美国移民局 USCIS)" : ""}.
- Do not add claims, superlatives or promises that are not in the original.
- Translate the WHOLE article. Do not summarize or stop early.

Return exactly this format and nothing else:
===TITLE===
(translated title, under 60 characters if possible)
===META===
(translated meta description, 120-155 characters)
===KEYWORD===
(main search keyword in ${cfg.label})
===CONTENT===
(the full translated HTML)
===END===

ORIGINAL TITLE: ${post.title}
ORIGINAL HTML:
${articleBody}`;
  try {
    await new Promise(r => setTimeout(r, 8000));
    const raw = await askClaude(prompt, false, 3, 12000);
    const grab = (a, b) => { const i = raw.indexOf(a), j = raw.indexOf(b, i + a.length); return i >= 0 && j > i ? raw.substring(i + a.length, j).trim() : ""; };
    if (!raw.includes("===END===")) { console.log(`Translation to ${cfg.label} incomplete (no end marker) — skipped`); return null; }
    const title = grab("===TITLE===", "===META==="), meta = grab("===META===", "===KEYWORD==="), kw = grab("===KEYWORD===", "===CONTENT===");
    let content = grab("===CONTENT===", "===END===").replace(/```(?:html)?/g, "").trim();
    if (content.indexOf("<") > 0) content = content.substring(content.indexOf("<"));
    // Completeness: same number of H2s, at least 80% of the paragraphs
    const h2a = countTags(articleBody, "h2"), h2b = countTags(content, "h2"), pa = countTags(articleBody, "p"), pb = countTags(content, "p");
    if (!title || !content || h2b < h2a || pb < Math.floor(pa * 0.8)) {
      console.log(`Translation to ${cfg.label} looks incomplete (h2 ${h2b}/${h2a}, p ${pb}/${pa}) — skipped`);
      await notifyTeam(`⚠️ ${cfg.label} translation skipped (incomplete) for: ${post.title}`);
      return null;
    }
    return { title, content: content + getStaticFooter(title, cfg.lang), category: cfg.categoryPrefix + post.category, tags: [], metaDescription: meta, focusKeyword: kw, lang: cfg.langTag, practiceArea: post.practiceArea };
  } catch (e) { console.log(`Translation to ${cfg.label} failed:`, e.message); return null; }
}

// Link the language versions to each other (hreflang + language switcher on the site)
async function linkTranslations(results, auth) {
  const withId = results.filter(r => r.id);
  if (withId.length < 2) return;
  const map = {};
  for (const r of withId) map[r.langTag] = { id: r.id, url: r.link };
  for (const r of withId) {
    try {
      await axios.post(`${WP_URL}/wp-json/wp/v2/posts/${r.id}`, { meta: { tez_translations: JSON.stringify(map) } },
        { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } });
    } catch (e) { console.log(`[autoposter] translation link failed for #${r.id}:`, e.response?.status || e.message); }
  }
}

// IndexNow: tells Bing (which feeds ChatGPT search and Copilot), Yandex, Seznam and Naver right away
async function pingIndexNow(urls) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) return;
  try {
    await axios.post("https://api.indexnow.org/indexnow", { host: SITE_HOST, key: INDEXNOW_KEY, keyLocation: `https://${SITE_HOST}/${INDEXNOW_KEY}.txt`, urlList: list },
      { headers: { "Content-Type": "application/json; charset=utf-8" }, timeout: 15000 });
    console.log(`[autoposter] 🔎 IndexNow notified (${list.length} URL(s))`);
  } catch (e) { console.log("[autoposter] IndexNow ping failed:", e.response?.status || e.message); }
}

// ─────────────────────────────────────────────────────────────
//  FIX 3: publishAllLanguages — pass state to check/record
//         translated titles so Chinese/Spanish can't duplicate
// ─────────────────────────────────────────────────────────────
async function publishAllLanguages(post, notifyPrefix, state) {
  const results = [];
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");

  // English — check WP first
  if (await checkWordPressDuplicate(post.title, auth)) {
    console.log("⚠️ Skipping WP duplicate:", post.title);
    return 0;
  }
  try {
    const p = await publishToWordPress({ ...post, lang: "en" });
    results.push({ lang: "English", link: p.link, id: p.id, langTag: "en", status: p.status });
    if (p.status !== "publish") throw { held: true };   // held for Rule 7.1 review: no cache/ingest yet

    // 🧠 Feed Zara's memory — seed cache + jj_memory with this post's FAQs
    // Non-blocking; failures don't affect publishing.
    try {
      const { seedCacheFromBlogPost } = require("./legal-digest");
      await seedCacheFromBlogPost({
        title:       post.title,
        htmlContent: post.content,
        url:         p.link,
        category:    post.category,
      });
    } catch (seedErr) {
      console.error("[autoposter] Blog→cache seed error:", seedErr.message);
    }

    // 🏛️ Ingest full post as a firm document (Phase 2 self-learning)
    // Non-blocking; failures don't affect publishing.
    try {
      const { ingestDocument } = require("./firm-documents");
      // Strip HTML tags for cleaner extraction, keep basic structure
      const plainText = String(post.content || "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

      // Prepend title so extraction has context
      const fullText = "Title: " + post.title + "\n\n" + plainText;

      // Only ingest if substantive (skip tiny posts)
      if (fullText.length >= 500) {
        const result = await ingestDocument({
          text: fullText,
          sourceUrl: p.link,
          matterLabelOverride: post.title,
          allowPrivate: false,
          actorId: "autoposter",
        });
        if (result.ok) {
          console.log(`[autoposter] 🏛️ Ingested to firm_documents #${result.docId}: ${result.matterLabel}`);
        } else {
          console.log(`[autoposter] 🏛️ Firm doc ingest skipped: ${result.reason}`);
        }
      }
    } catch (firmErr) {
      console.error("[autoposter] Blog→firm_docs error:", firmErr.message);
    }
  }
  catch (e) { if (!e || !e.held) console.error("English publish failed:", e && e.message); }

  // If the English version was held for review, its translations are held too
  const holdStatus = results[0] && results[0].status !== "publish" ? "draft" : undefined;

  if (!results.length) { console.log("⚠️ English version did not publish — skipping translations"); return 0; }

  // Chinese — check both WP and local history before publishing
  const chPost = await translatePost(post, "chinese");
  if (chPost) {
    if (isDuplicateTitle(chPost.title, state)) {
      console.log("⚠️ Skipping duplicate Chinese translation:", chPost.title);
    } else if (await checkWordPressDuplicate(chPost.title, auth)) {
      console.log("⚠️ Skipping WP duplicate Chinese:", chPost.title);
    } else {
      try {
        const p = await publishToWordPress({ ...chPost, status: holdStatus });
        results.push({ lang: "中文", link: p.link, id: p.id, langTag: chPost.lang, status: p.status });
        recordPublishedTitle(chPost.title, state);

        // The same Chinese post goes to the 公众号, where the firm's clients
        // actually are. It is only queued — JJ taps Publish on Telegram, and
        // nothing reaches WeChat before he does. A failure here must never
        // affect the blog post that already succeeded.
        if (p.status === "publish") try {
          const wechat = require("./wechat-publish");
          const q = await wechat.queueForApproval({
            title: chPost.title,
            content: chPost.content,
            digest: chPost.metaDescription,
            sourceUrl: p.link,
          });
          if (q.queued) console.log(`[autoposter] 📣 WeChat post #${q.id} awaiting approval`);
          else console.log(`[autoposter] WeChat skipped: ${q.reason}`);
        } catch (wcErr) {
          console.error("[autoposter] WeChat queue error:", wcErr.message);
        }

      } catch (e) { console.error("Chinese publish failed:", e.message); }
    }
  }

  // Spanish — same checks
  const esPost = await translatePost(post, "spanish");
  if (esPost) {
    if (isDuplicateTitle(esPost.title, state)) {
      console.log("⚠️ Skipping duplicate Spanish translation:", esPost.title);
    } else if (await checkWordPressDuplicate(esPost.title, auth)) {
      console.log("⚠️ Skipping WP duplicate Spanish:", esPost.title);
    } else {
      try {
        const p = await publishToWordPress({ ...esPost, status: holdStatus });
        results.push({ lang: "Español", link: p.link, id: p.id, langTag: "es", status: p.status });
        recordPublishedTitle(esPost.title, state);
      } catch (e) { console.error("Spanish publish failed:", e.message); }
    }
  }

  // ── Short-form social drafts ────────────────────────────────
  // Drafted from the post that just went live, so every claim traces back to
  // something the firm actually published. Each language's channels link to
  // that language's post — an English LinkedIn draft pointing at the Chinese
  // URL would be worse than no draft. Queued only: JJ approves each one, and
  // a failure here must never affect the posts that already succeeded.
  try {
    const social = require("./social-posts");
    const linkFor = lang => (results.find(r => r.lang === lang && r.status === "publish") || {}).link;

    const en = linkFor("English");
    if (en) {
      const s = await social.queueForSource(
        { title: post.title, url: en, summary: post.metaDescription, content: post.content },
        { channels: ["linkedin", "facebook", "instagram", "gbp"] });
      if (s.queued) console.log(`[autoposter] 📣 ${s.queued} English social draft(s) awaiting approval`);
      else if (s.reason) console.log(`[autoposter] social skipped: ${s.reason}`);
      for (const r of s.rejected || []) console.log(`[autoposter] social ${r.channel} not offered: ${r.problems.join("; ")}`);
    }

    const zh = linkFor("中文");
    if (zh && chPost) {
      const s = await social.queueForSource(
        { title: chPost.title, url: zh, summary: chPost.metaDescription || chPost.content },
        { channels: ["wechat_moments"] });
      if (s.queued) console.log(`[autoposter] 📣 ${s.queued} Chinese social draft(s) awaiting approval`);
      for (const r of s.rejected || []) console.log(`[autoposter] social ${r.channel} not offered: ${r.problems.join("; ")}`);
    }

    // Explainer video (YouTube Shorts + TikTok), capped per week and rendered
    // in the background: it takes a minute and must not hold up the rest.
    const vsrc = {};
    if (en) vsrc.en = { title: post.title, url: en, summary: post.metaDescription, content: post.content };
    if (zh && chPost) vsrc.zh = { title: chPost.title, url: zh, summary: chPost.metaDescription, content: chPost.content };
    const es = linkFor("Español");
    if (es && esPost) vsrc.es = { title: esPost.title, url: es, summary: esPost.metaDescription, content: esPost.content };
    if (vsrc.en || vsrc.zh || vsrc.es) {
      social.queueVideo(vsrc)
        .then(v => console.log(v.queued ? `[autoposter] 🎬 ${v.queued} video(s) awaiting approval: ${(v.langs || [v.lang]).join(", ")}` : `[autoposter] video skipped: ${v.reason}`))
        .catch(e => console.error("[autoposter] video error:", e.message));
    }
  } catch (soErr) {
    console.error("[autoposter] social queue error:", soErr.message);
  }

  // 🔗 hreflang links between the language versions + instant indexing
  try { await linkTranslations(results, auth); } catch (e) { console.log("[autoposter] linkTranslations:", e.message); }
  // IndexNow is sent by the site itself when a post goes live (Tez SEO pack v2), including drafts approved later

  if (results.some(r => r.status === "draft")) {
    await notifyTeam(`⚖️ *Held as draft for review (Rule 7.1 check):*\n${results.filter(r => r.status === "draft").map(r => `${r.lang}: ${WP_URL}/wp-admin/post.php?post=${r.id}&action=edit`).join("\n")}`);
  }
  if (results.length > 0) {
    const live = results.filter(r => r.status === "publish"), held = results.length - live.length;
    await notifyTeam(`${notifyPrefix}\n\n📌 *${post.title}*\n\n🌐 ${live.length} published${held ? `, ${held} held as draft` : ""}:\n${results.map(r => `${r.lang}${r.status === "publish" ? "" : " (draft)"}: ${r.link}`).join("\n")}`);
  }
  // Count drafts too, so a held topic is recorded and not regenerated tomorrow
  return results.length;
}

async function notifyTeam(message) {
  const sent = await require("./tg-route").send("social", message, { parse_mode: "Markdown" });
  if (!sent) console.log("Telegram notify:", message);
}

const decodeEntities = t => String(t || "").replace(/&amp;/g, "&").replace(/&#0?38;/g, "&").replace(/&#8217;/g, "’").replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();

async function findOrCreateCategory(name, auth) {
  // Exact-name match. The old search-and-take-first matched "Español-Immigration"
  // for "Immigration", which filed most English posts under the Spanish category.
  const res = await axios.get(`${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=100`, { headers: { Authorization: `Basic ${auth}` } });
  const hit = (res.data || []).find(c => decodeEntities(c.name).toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const created = await axios.post(`${WP_URL}/wp-json/wp/v2/categories`, { name }, { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } });
  return created.data.id;
}

async function publishToWordPress({ title, content, category, tags, metaDescription, focusKeyword, lang, practiceArea, status }) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  console.log("Publishing to WordPress:", title?.substring(0, 50));

  let categoryId = 1;
  try { categoryId = await findOrCreateCategory(category || "Immigration", auth); }
  catch (e) { console.log("Category lookup failed:", e.message); }

  // Rule 7.1 gate — anything flagged is saved as a draft for JJ instead of going live
  const issues = complianceIssues(stripFooter(content));
  const finalStatus = status || (issues.length ? "draft" : "publish");
  if (issues.length) console.log(`⚖️ Compliance hold (${issues.length}):`, issues.slice(0, 3).join(" | "));

  // Tags: none. 5–7 new tags per post x 3 languages created 2,600+ thin tag pages.
  const postData = { title, content, status: finalStatus, categories: [categoryId], tags: [], excerpt: metaDescription || "" };
  const area = practiceArea || String(category || "").replace(/^(中文-|Español-)/, "");
  if (FEATURED_MEDIA[area]) postData.featured_media = FEATURED_MEDIA[area];
  postData.meta = { tez_lang: lang || "en" };
  if (metaDescription) postData.meta._yoast_wpseo_metadesc = metaDescription.substring(0, 158);
  if (focusKeyword) postData.meta._yoast_wpseo_focuskw = focusKeyword;
  if (title) postData.meta._yoast_wpseo_title = (title.length > 45 ? title : title + " | TEZ Law Firm");

  let postRes;
  try {
    postRes = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, postData, { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } });
  } catch (e) {
    // If the site snippet isn't active yet, the meta keys are unknown — retry without them
    const errBody = JSON.stringify(e.response?.data || "");
    if ((e.response?.status === 400 && /meta/i.test(errBody)) || (e.response?.status === 403 && /rest_cannot_update/.test(errBody))) {
      console.log("⚠️ Meta rejected (is the Tez SEO pack v2 snippet active?) — publishing without meta");
      delete postData.meta;
      postRes = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, postData, { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } });
    } else {
      if (e.response?.status === 401 || (e.response?.status === 403 && !/rest_cannot_update/.test(errBody))) {
        try { await require("./site-watch").tell(`🔑 The autoposter could not publish "${String(title).substring(0, 60)}": WordPress rejected the login (HTTP ${e.response.status}). Create a new application password (WordPress → Users → Profile) and update WP_APP_PASSWORD on Render.`); } catch (x) {}
      }
      throw e;
    }
  }
  console.log(`✅ WordPress ${finalStatus === "publish" ? "published" : "saved as DRAFT"}, ID:`, postRes.data.id);
  // `url` kept for callers that read it (admin manual publish)
  return { ...postRes.data, url: postRes.data.link, complianceIssues: issues };
}

async function generatePost({ topic, practiceArea, context, useSearch, sources }) {
  const currentYear = new Date().getFullYear();
  const todayStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const locationContext = ["Immigration Law", "Immigration"].includes(practiceArea)
    ? "nationwide United States (TEZ Law Firm handles immigration cases across the entire US)"
    : "Southern California — Los Angeles County, Orange County, San Bernardino County, and Riverside Counties. Key cities: West Covina, LA, Anaheim, San Bernardino, Riverside, Ontario, Pomona.";
  const sourceInstruction = sources && sources.length > 0
    ? `\nPRIORITY SOURCES: When researching this topic, prioritize information from these high-authority sources: ${sources.join(", ")}. Search these first, then supplement with other credible sources if needed.\n`
    : "";
  const linkList = PRACTICE_LINKS.map(([label, url]) => `- ${label}: ${url}`).join("\n");
  const prompt = `You write clear, accurate legal articles for TEZ Law Firm (legal name Tez Law P.C.), a California law firm with offices in West Covina, City of Industry and Newport Beach, and an office in Flushing, New York that handles immigration matters only. In the article, call the firm "TEZ Law Firm". JJ Zhang is the founding attorney (California Bar #326666).

IMPORTANT: Today is ${todayStr}. Current year is ${currentYear}. ALWAYS use ${currentYear} — NEVER use any past year.
${sourceInstruction}
Write a COMPREHENSIVE, SEO-optimized WordPress blog post about:
TOPIC: ${topic}
PRACTICE AREA: ${practiceArea}
CONTEXT: ${context || "None"}
LOCATION: ${locationContext}

REQUIREMENTS:
1. TITLE (under 65 chars, include primary keyword + location. If adding year, use ${currentYear} only)
2. META DESCRIPTION (150-160 chars, includes keyword + CTA)
3. CONTENT (1,000-1,400 words):
   - Opening paragraph: hook + who this affects + what to do
   - H2: Background/What This Means
   - H2: How This Affects [Specific Audience]
   - H2: What You Should Do Now (actionable steps)
   - H2: How TEZ Law Firm Can Help (2-3 sentences describing the services only — no claims about being better than others)
   - H2: Frequently Asked Questions
     * 3-5 FAQs as <div class="faq-item"><h3>Question?</h3><p>Answer in 2-4 sentences</p></div>
   - Closing paragraph inviting readers to schedule a consultation
   - Cite official sources (uscis.gov, state.gov, dol.gov, courts, Federal Register, leginfo.legislature.ca.gov) with links where you rely on them, and state dates ("as of ${todayStr}") for fees, deadlines and figures that change.
4. INTERNAL LINKS — link 2 to 4 of the MOST relevant pages below, in natural sentences, using descriptive anchor text (never "click here"). Always include the most specific matching page (e.g. an H-1B article links the H-1B page). Use only these URLs:
${linkList}
5. CALIFORNIA RULES OF PROFESSIONAL CONDUCT 7.1–7.5 (mandatory):
   - Never call the firm or its lawyers best, top, leading, premier, #1, expert or specialists; never say the firm "specializes".
   - Never promise or imply an outcome ("we will win", "guaranteed", "get your green card approved"). Use "may", "can", "generally".
   - No success rates, case counts or client testimonials.
   - Do not say "free consultation".
6. Write for readers who may speak English as a second language: short sentences, plain words, define legal terms once.

Return ONLY this JSON (no markdown, no backticks):
{"title":"SEO title","metaDescription":"150-160 char meta","content":"full HTML content","category":"Immigration|Personal Injury|Business Law|Trademarks|Estate Planning","focusKeyword":"main SEO keyword"}`;
  const raw = await askClaude(prompt, useSearch);
  let postData;
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    postData = JSON.parse(cleaned.substring(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
  } catch (e) { console.error("Failed to parse Claude response:", e.message); return null; }
  // One repair pass if the draft slipped a Rule 7.1 problem; publishToWordPress holds it as a draft if it persists
  const issues = complianceIssues(postData.content || "");
  if (issues.length) {
    try {
      const fixed = await askClaude(`Revise this HTML article so it complies with California Rule of Professional Conduct 7.1. Fix ONLY these problems, change nothing else, keep all HTML and links, and return ONLY the full revised HTML:\n${issues.join("\n")}\n\n${postData.content}`, false, 3, 12000);
      let f2 = String(fixed || "").replace(/```(?:html)?/g, "").trim();
      if (f2.indexOf("<") > 0) f2 = f2.substring(f2.indexOf("<"));
      if (f2.includes("<h2") && f2.length > postData.content.length * 0.8) postData.content = f2;
    } catch (e) { console.log("Compliance repair failed:", e.message); }
  }
  postData.tags = [];
  postData.practiceArea = postData.category;
  postData.content = (postData.content || "") + getStaticFooter(postData.title || "", "en");
  await new Promise(r => setTimeout(r, 5000));
  try {
    const firstParaMatch = postData.content.match(/(<p>.*?<\/p>\s*<p>.*?<\/p>)/s);
    if (firstParaMatch) {
      const humanized = await askClaude(`${JJ_VOICE}\n\nRewrite ONLY these two opening paragraphs in JJ Zhang's voice. Return ONLY the rewritten HTML:\n\n${firstParaMatch[1]}`, false);
      if (humanized && humanized.includes("<p>")) { postData.content = postData.content.replace(firstParaMatch[1], humanized.trim()); }
    }
  } catch (e) { console.log("Humanization failed:", e.message); }
  return postData;
}

async function runWeeklySourceResearch() {
  console.log("🔬 Running weekly source research...");
  const sources = loadSources();
  const state = loadState();
  // Pass recent titles so Claude doesn't suggest already-covered topics as urgent
  const recentlyPublished = (state.titleHistory || []).slice(-20).join(", ") || "None yet";

  const prompt = `You are a legal content research specialist. Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

Search the web to find the CURRENT most authoritative, most-trafficked, and most-trending websites for legal news in these practice areas for a California law firm (TEZ Law Firm, based in West Covina):

1. US IMMIGRATION LAW — USCIS updates, visa news, deportation, green cards, asylum
2. PERSONAL INJURY / CAR ACCIDENTS — California car accident law, insurance changes, court decisions
3. BUSINESS LITIGATION — California business law, commercial disputes, court decisions
4. TRADEMARKS & PATENTS — USPTO news, IP law updates
5. ESTATE PLANNING — California probate, trusts, tax updates

For each practice area, identify:
- The 6-8 BEST current sources (government .gov sites, major news outlets, top legal blogs)
- Prioritize: high Google authority, frequent updates, free access, .gov sources first
- Include any NEW trending sources that have emerged recently
- Remove any sources that are no longer active or authoritative

Also note:
- Any MAJOR legal news or trends happening RIGHT NOW that should influence posting topics
- Which practice area has the most urgent news this week

Return ONLY this JSON (no markdown, no backticks):
{
  "immigration": ["source1.com", "source2.com", ...],
  "personalInjury": ["source1.com", "source2.com", ...],
  "business": ["source1.com", "source2.com", ...],
  "trademark": ["source1.com", "source2.com", ...],
  "estate": ["source1.com", "source2.com", ...],
  "weeklyTrends": "2-3 sentence summary of major legal news trends this week",
  "urgentArea": "which practice area has most urgent news right now",
  "urgentTopic": "specific urgent topic if any, or null"
}`;

  try {
    const raw = await askClaude(prompt, true);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
    const newSources = JSON.parse(cleaned.substring(start, end + 1));

    const updated = {
      immigration:    newSources.immigration    || sources.immigration,
      personalInjury: newSources.personalInjury || sources.personalInjury,
      business:       newSources.business       || sources.business,
      trademark:      newSources.trademark      || sources.trademark,
      estate:         newSources.estate         || sources.estate,
      weeklyTrends:   newSources.weeklyTrends   || null,
      urgentArea:     newSources.urgentArea      || null,
      urgentTopic:    newSources.urgentTopic     || null,
      lastResearched: new Date().toISOString(),
      version:        (sources.version || 1) + 1,
      previousSources: {
        immigration:    sources.immigration,
        personalInjury: sources.personalInjury,
        business:       sources.business,
        trademark:      sources.trademark,
        estate:         sources.estate,
      }
    };

    saveSources(updated);
    console.log("✅ Sources updated. Urgent area:", updated.urgentArea);
    console.log("📊 Weekly trends:", updated.weeklyTrends?.substring(0, 100));

    await notifyTeam(
      `🔬 *Weekly Source Research Complete!*\n\n` +
      `📊 *Trends:* ${updated.weeklyTrends || "No major trends detected"}\n\n` +
      `🔥 *Most urgent area:* ${updated.urgentArea || "None"}\n` +
      `📰 *Urgent topic:* ${updated.urgentTopic || "None"}\n\n` +
      `Sources updated for: Immigration (${updated.immigration.length}), PI (${updated.personalInjury.length}), Business (${updated.business.length}), TM (${updated.trademark.length}), Estate (${updated.estate.length})`
    );

    return updated;
  } catch (e) {
    console.error("Weekly source research failed:", e.message);
    return sources;
  }
}

function shouldRunWeeklyResearch(sources) {
  if (!sources.lastResearched) return true;
  const daysSince = (Date.now() - new Date(sources.lastResearched).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 1: Immigration News
//  FIX 4: Check generated post.title for duplicates (not raw headline)
// ─────────────────────────────────────────────────────────────
async function checkImmigrationNews(state, sources) {
  console.log("📰 Checking immigration news...");
  const sourceList = sources.immigration.join(", ");
  const weeklyContext = sources.weeklyTrends ? `\nWeekly context: ${sources.weeklyTrends}` : "";
  const urgentContext = sources.urgentArea === "immigration" && sources.urgentTopic ? `\nUrgent topic flagged this week: ${sources.urgentTopic}` : "";
  // Pass recently published titles so Claude avoids researching the same topics
  const recentTitles = (state.titleHistory || []).slice(-30).join(" | ");
  const avoidContext = recentTitles ? `\nAVOID these recently published topics (do NOT repeat these): ${recentTitles.substring(0, 800)}` : "";

  const prompt = `Search for the most significant US immigration law news from the past 7 days. PRIORITY SOURCES: ${sourceList}${weeklyContext}${urgentContext}${avoidContext}

Pick a topic that has NOT been recently covered (check the AVOID list above).
Respond ONLY in this exact JSON:
{"hasNews":true,"headline":"brief headline","summary":"one sentence summary","source":"which source"}
If nothing noteworthy or all recent news already covered: {"hasNews":false}`;
  const result = await askClaude(prompt, true);
  let newsData;
  try {
    const cleaned = result.replace(/```json|```/g, "").trim();
    newsData = JSON.parse(cleaned.substring(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
  } catch (e) { console.log("Failed to parse news result:", e.message); return 0; }
  if (!newsData.hasNews) { console.log("No new immigration news today."); return 0; }
  // Check BOTH headline AND any existing title to catch near-duplicates
  if (isDuplicateTitle(newsData.headline, state)) { console.log("⚠️ Duplicate headline:", newsData.headline); return 0; }
  console.log(`📰 News found from ${newsData.source}: ${newsData.headline}`);
  await new Promise(r => setTimeout(r, 10000));
  let post = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { post = await generatePost({ topic: newsData.headline, practiceArea: "Immigration Law", context: newsData.summary, useSearch: false, sources: sources.immigration }); if (post) break; }
    catch (e) { if (attempt < 3) await new Promise(r => setTimeout(r, 15000)); }
  }
  if (!post) return 0;
  // Check the GENERATED title too (may differ from headline)
  if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate generated title:", post.title); return 0; }
  const count = await publishAllLanguages(post, "📢 *New Immigration Post Published!*", state);
  if (count > 0) recordPublishedTitle(post.title, state);
  return count > 0 ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 1b: Legal news for every practice area, one a day
//  JJ, 28 Sep 2026: "update on all area of laws tez do, not just
//  immigration." Immigration keeps its daily check; the others take
//  turns, one per weekday, so each area gets a news look every week.
// ─────────────────────────────────────────────────────────────
const PRACTICE_NEWS = {
  1: { area: "Real Estate",             key: "realEstate",     evergreen: null,       ask: "California real estate law: property sales and disclosures, title and escrow, zoning and ADUs, construction and contractor law, HOA rules, and property tax" },
  2: { area: "Landlord-Tenant",         key: "landlordTenant", evergreen: null,       ask: "California landlord-tenant law: evictions and unlawful detainer procedure, rent caps (AB 1482) and local rent control in Los Angeles and Orange County, just-cause rules, security deposits, and habitability" },
  3: { area: "Personal Injury",         key: "personalInjury", evergreen: "pi",       ask: "California personal injury law: car, truck, rideshare and pedestrian accidents, insurance rules, premises liability, and court decisions affecting injured people" },
  4: { area: "Estate Planning",         key: "estate",         evergreen: "estate",   ask: "California estate planning: living trusts, wills, probate, Prop 19 and property transfers, federal estate and gift tax rules, and conservatorship" },
  5: { area: "Business Law",            key: "business",       evergreen: "business", ask: "California business law and business litigation: contracts, partnership and LLC disputes, employment rules that affect small businesses, and court decisions" },
  6: { area: "Trademarks",              key: "trademark",      evergreen: "trademark",ask: "U.S. trademark and intellectual property law: USPTO rule changes, trademark scams, and court decisions that affect small businesses" },
};

async function checkPracticeNews(state, sources, { day = new Date().getDay() } = {}) {
  const p = PRACTICE_NEWS[day];
  if (!p) return 0;
  const todayKey = new Date().toDateString();
  state.practiceNews = state.practiceNews || {};
  if (state.practiceNews[p.key] === todayKey) return 0;
  console.log(`📰 Checking ${p.area} news...`);
  const list = (sources[p.key] || DEFAULT_SOURCES[p.key] || []).join(", ");
  const recentTitles = (state.titleHistory || []).slice(-40).join(" | ");
  const prompt = `Search for the most significant legal news from the past 10 days in ${p.ask}. PRIORITY SOURCES: ${list}
The readers are individuals, families and small-business owners in Los Angeles and Orange County.
Only count real changes: a new law or regulation taking effect, a court decision, an agency announcement, or a deadline people need to know about. Not opinion pieces, not market commentary.
AVOID these recently published topics: ${recentTitles.substring(0, 800)}
Respond ONLY in this exact JSON:
{"hasNews":true,"headline":"brief headline","summary":"one sentence summary","source":"which source"}
If nothing qualifies: {"hasNews":false}`;
  const result = await askClaude(prompt, true);
  let news;
  try {
    const c = result.replace(/```json|```/g, "").trim();
    news = JSON.parse(c.substring(c.indexOf("{"), c.lastIndexOf("}") + 1));
  } catch (e) { console.log(`Failed to parse ${p.area} news:`, e.message); return 0; }
  state.practiceNews[p.key] = todayKey;
  if (!news.hasNews) { console.log(`No ${p.area} news worth a post today.`); return 0; }
  if (isDuplicateTitle(news.headline, state)) { console.log("⚠️ Duplicate headline:", news.headline); return 0; }
  await new Promise(r => setTimeout(r, 10000));
  const post = await generatePost({ topic: news.headline, practiceArea: p.area, context: news.summary, useSearch: false, sources: sources[p.key] || [] });
  if (!post || isDuplicateTitle(post.title, state)) return 0;
  const count = await publishAllLanguages(post, `📢 *New ${p.area} Post Published!*`, state);
  if (count > 0) {
    recordPublishedTitle(post.title, state);
    // One post per area per day: the evergreen slot for this area stands down.
    if (p.evergreen) { state.weeklyEvergreen = state.weeklyEvergreen || {}; state.weeklyEvergreen[p.evergreen] = todayKey; }
  }
  return count > 0 ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 2: Weather (PI)
//  FIX 5: Use recordPublishedTitle instead of push directly
// ─────────────────────────────────────────────────────────────
async function checkWeather(state, sources) {
  console.log("🌦️ Checking weather...");
  try {
    const pointRes = await axios.get("https://api.weather.gov/points/34.0686,-117.9390");
    const forecastRes = await axios.get(pointRes.data.properties.forecast);
    const weatherText = forecastRes.data.properties.periods.slice(0, 3).map(p => p.detailedForecast).join(" ");
    if (!/rain|storm|shower|thunderstorm|flood|wet/i.test(weatherText)) { console.log("No rain, skipping."); return 0; }
    const now = Date.now();
    if (state.lastWeatherCheck && (now - state.lastWeatherCheck) < 3 * 24 * 60 * 60 * 1000) { console.log("Weather post recent."); return 0; }
    const rainType = /thunderstorm|flood/i.test(weatherText) ? "Storms" : "Rain";
    const post = await generatePost({ topic: `Car Accidents During ${rainType} in California`, practiceArea: "Personal Injury", context: `Weather: ${weatherText.substring(0, 200)}`, useSearch: false, sources: sources.personalInjury });
    if (!post) return 0;
    if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate weather post:", post.title); return 0; }
    const count = await publishAllLanguages(post, "🌧️ *Weather PI Post Published!*", state);
    if (count > 0) { state.lastWeatherCheck = now; recordPublishedTitle(post.title, state); }
    return count > 0 ? 1 : 0;
  } catch (e) { console.error("Weather check failed:", e.message); return 0; }
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 3: Holiday posts
//  FIX 6: Use recordPublishedTitle instead of push directly
// ─────────────────────────────────────────────────────────────
const HOLIDAYS = [
  { month:1,  day:1,  name:"New Year's Day",  topic:"New Year's DUI Accidents in California — What to Do If You're Hit by a Drunk Driver" },
  { month:5,  day:25, name:"Memorial Day",    topic:"Memorial Day Weekend Car Accidents in California — Your Legal Rights" },
  { month:7,  day:4,  name:"July 4th",        topic:"Fourth of July DUI Accidents in Los Angeles — What Victims Need to Know" },
  { month:9,  day:1,  name:"Labor Day",       topic:"Labor Day Weekend Accidents in California — Personal Injury Rights and Deadlines" },
  { month:11, day:27, name:"Thanksgiving",    topic:"Thanksgiving Travel Accidents in California — Know Your Rights" },
  { month:12, day:24, name:"Christmas Eve",   topic:"Holiday Season DUI Accidents in Los Angeles — Legal Options for Victims" },
];

async function checkHolidays(state, sources) {
  const now = new Date();
  for (const holiday of HOLIDAYS) {
    const holidayDate = new Date(now.getFullYear(), holiday.month - 1, holiday.day);
    const daysUntil = Math.ceil((holidayDate - now) / (1000 * 60 * 60 * 24));
    if (daysUntil >= 0 && daysUntil <= 2) {
      const key = `${now.getFullYear()}-${holiday.name}`;
      if (state.lastHolidayPost === key) continue;
      const post = await generatePost({ topic: holiday.topic, practiceArea: "Personal Injury", context: `${holiday.name} in ${daysUntil} day(s).`, useSearch: false, sources: sources.personalInjury });
      if (!post) continue;
      if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate holiday post:", post.title); continue; }
      const count = await publishAllLanguages(post, "🎉 *Holiday Post Published!*", state);
      if (count > 0) { state.lastHolidayPost = key; recordPublishedTitle(post.title, state); return 1; }
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 4: Evergreen posts
//  FIX 7: Use recordPublishedTitle consistently for all 4 types
// ─────────────────────────────────────────────────────────────
const EVERGREEN_TOPICS = {
  pi:        ["How Long Does a Personal Injury Case Take in California?","What Is California's Pure Comparative Negligence Rule?","Uber and Lyft Accident Claims in Los Angeles — A Complete Guide","Slip and Fall Accidents in California — What You Need to Prove","How Much Is My Car Accident Case Worth in California?","Hit and Run Accidents in California — Your Legal Options","Truck Accident Claims in Los Angeles — Why They're Different","What to Do Immediately After a Car Accident in California"],
  business:  ["Non-Compete Agreements Are Void in California — What Employers Need to Know","What to Do When Your Business Gets Served in California","Trade Secret Theft in California — How to Protect Your Business","Breach of Contract Claims in California — A Practical Guide"],
  trademark: ["How to Register a Trademark in the United States — Step by Step","Trademark vs. Copyright vs. Patent — What's the Difference?","How to Respond to a Cease and Desist Letter for Trademark Infringement","Common Trademark Mistakes Small Businesses Make in California"],
  estate:    ["Why Every California Homeowner Needs a Living Trust","How Probate Works in California — And How to Avoid It","Prop 19 and California Property Tax — What California Families Need to Know","What Happens If You Die Without a Will in California?"],
};

async function checkEvergreen(state, sources) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  let published = 0;

  // PI — every Tuesday
  if (dayOfWeek === 2 && state.weeklyEvergreen.pi !== now.toDateString()) {
    const allSeen = [...new Set([...(state.titleHistory || []), ...(state.publishedTitles || [])])];
    // Use full isDuplicateTitle fuzzy match (not just 20-char prefix)
    const available = EVERGREEN_TOPICS.pi.filter(t => !isDuplicateTitle(t, state));
    const topic = available.length > 0 ? available[0] : EVERGREEN_TOPICS.pi[Math.floor(Math.random() * EVERGREEN_TOPICS.pi.length)];
    const post = await generatePost({ topic, practiceArea: "Personal Injury", useSearch: false, sources: sources.personalInjury });
    if (post) {
      if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate PI evergreen:", post.title); }
      else {
        const c = await publishAllLanguages(post, "📝 *PI Evergreen Post!*", state);
        if (c > 0) { state.weeklyEvergreen.pi = now.toDateString(); recordPublishedTitle(post.title, state); published++; }
      }
    }
  }

  // Business or Trademark — every Thursday (alternating)
  if (dayOfWeek === 4 && state.weeklyEvergreen.business !== now.toDateString()) {
    const weekNum = Math.floor(now.getDate() / 7);
    if (weekNum % 2 === 0) {
      const availBiz = EVERGREEN_TOPICS.business.filter(t => !isDuplicateTitle(t, state));
      const topic = availBiz.length > 0 ? availBiz[Math.floor(Math.random() * availBiz.length)] : EVERGREEN_TOPICS.business[Math.floor(Math.random() * EVERGREEN_TOPICS.business.length)];
      const post = await generatePost({ topic, practiceArea: "Business Law", useSearch: false, sources: sources.business });
      if (post) {
        if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate Business evergreen:", post.title); }
        else {
          const c = await publishAllLanguages(post, "📝 *Business Law Post!*", state);
          if (c > 0) { state.weeklyEvergreen.business = now.toDateString(); recordPublishedTitle(post.title, state); published++; }
        }
      }
    } else {
      const availTm = EVERGREEN_TOPICS.trademark.filter(t => !isDuplicateTitle(t, state));
      const topic = availTm.length > 0 ? availTm[Math.floor(Math.random() * availTm.length)] : EVERGREEN_TOPICS.trademark[Math.floor(Math.random() * EVERGREEN_TOPICS.trademark.length)];
      const post = await generatePost({ topic, practiceArea: "Trademarks", useSearch: false, sources: sources.trademark });
      if (post) {
        if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate Trademark evergreen:", post.title); }
        else {
          const c = await publishAllLanguages(post, "📝 *Trademark Post!*", state);
          if (c > 0) { state.weeklyEvergreen.trademark = now.toDateString(); recordPublishedTitle(post.title, state); published++; }
        }
      }
    }
  }

  // Estate Planning — every other Friday
  if (dayOfWeek === 5 && state.weeklyEvergreen.estate !== now.toDateString()) {
    const weekNum = Math.floor(now.getDate() / 7);
    if (weekNum % 2 === 0) {
      const availEst = EVERGREEN_TOPICS.estate.filter(t => !isDuplicateTitle(t, state));
      const topic = availEst.length > 0 ? availEst[Math.floor(Math.random() * availEst.length)] : EVERGREEN_TOPICS.estate[Math.floor(Math.random() * EVERGREEN_TOPICS.estate.length)];
      const post = await generatePost({ topic, practiceArea: "Estate Planning", useSearch: false, sources: sources.estate });
      if (post) {
        if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate Estate evergreen:", post.title); }
        else {
          const c = await publishAllLanguages(post, "📝 *Estate Planning Post!*", state);
          if (c > 0) { state.weeklyEvergreen.estate = now.toDateString(); recordPublishedTitle(post.title, state); published++; }
        }
      }
    }
  }

  return published;
}

// ─────────────────────────────────────────────────────────────
//  URGENT TOPIC
//  FIX 8: Save post.title not truncated urgentKey
// ─────────────────────────────────────────────────────────────
async function checkUrgentTopic(state, sources) {
  if (!sources.urgentTopic || !sources.urgentArea) return 0;
  const urgentKey = `urgent-${sources.urgentTopic?.substring(0, 30)}`;
  if (isDuplicateTitle(urgentKey, state)) { console.log("Urgent topic already posted."); return 0; }
  console.log(`🚨 Posting urgent topic: ${sources.urgentTopic}`);
  const areaToSources = { immigration: sources.immigration, "personal injury": sources.personalInjury, business: sources.business, trademark: sources.trademark, estate: sources.estate };
  const practiceAreaMap = { immigration: "Immigration Law", "personal injury": "Personal Injury", business: "Business Law", trademark: "Trademarks", estate: "Estate Planning" };
  const area = sources.urgentArea?.toLowerCase();
  const practiceArea = practiceAreaMap[area] || "Immigration Law";
  const relevantSources = areaToSources[area] || sources.immigration;
  // Skip if urgent topic is already a duplicate of something published
  if (isDuplicateTitle(sources.urgentTopic, state)) {
    console.log("⚠️ Urgent topic already covered — clearing:", sources.urgentTopic);
    const s = loadSources(); s.urgentTopic = null; saveSources(s);
    return 0;
  }

  const post = await generatePost({ topic: sources.urgentTopic, practiceArea, context: sources.weeklyTrends || "", useSearch: true, sources: relevantSources });
  if (!post) return 0;
  if (isDuplicateTitle(post.title, state)) { console.log("⚠️ Duplicate urgent post:", post.title); return 0; }
  const count = await publishAllLanguages(post, `🚨 *Urgent Topic Post: ${practiceArea}!*`, state);
  if (count > 0) {
    recordPublishedTitle(post.title, state);   // save actual generated title
    recordPublishedTitle(urgentKey, state);     // also save key to prevent re-check
    const s = loadSources(); s.urgentTopic = null; saveSources(s);
  }
  return count > 0 ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
//  MAIN DAILY SCHEDULER
// ─────────────────────────────────────────────────────────────
async function runDailyScheduler() {
  console.log("\n🚀 TEZ LAW AUTO-POSTER v2 running:", new Date().toLocaleString());
  const state = loadState();
  let sources = loadSources();
  let total = 0;
  const today = new Date();
  const isSunday = today.getDay() === 0;
  if (isSunday || shouldRunWeeklyResearch(sources)) {
    console.log("📅 Running weekly source research...");
    sources = await runWeeklySourceResearch();
    await new Promise(r => setTimeout(r, 15000));
  }
  const runWithDelay = async (fn, label, delayMs = 0) => {
    if (delayMs > 0) { console.log(`⏳ Waiting ${delayMs/1000}s before ${label}...`); await new Promise(r => setTimeout(r, delayMs)); }
    try { total += await fn(); } catch (e) { console.error(`${label} error:`, e.message); }
  };
  await runWithDelay(() => checkUrgentTopic(state, sources),     "Urgent topic",       0);
  await runWithDelay(() => checkImmigrationNews(state, sources), "Immigration check",  45000);
  await runWithDelay(() => checkPracticeNews(state, sources),     "Practice-area news", 30000);
  await runWithDelay(() => checkWeather(state, sources),          "Weather check",     15000);
  await runWithDelay(() => checkHolidays(state, sources),         "Holiday check",      5000);
  await runWithDelay(() => checkEvergreen(state, sources),        "Evergreen check",    5000);
  state.lastDailyRun = new Date().toISOString();
  saveState(state);
  console.log(`✅ Auto-poster complete. Published ${total} post(s) today.\n`);
}

function scheduleDaily() {
  // NO startup run — prevents duplicate posts on every Render redeploy
  // Posts run daily at 8am PT via the scheduler below
  // Use Admin Panel → Analytics → "Run Auto-Poster Now" for manual runs
  console.log("📅 Auto-poster scheduler ready (runs daily at 8am PT / 15:00 UTC)");
  // Safe-driving posts when the local weather turns (weather-watch.js).
  try { require("./weather-watch").start(); } catch (e) { console.warn("[weather] not started:", e.message); }
  function scheduleNext() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(15, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const ms = next - now;
    console.log(`⏰ Next auto-post in ${Math.round(ms / 1000 / 60 / 60 * 10) / 10} hours (8 AM Pacific / 15:00 UTC)`);
    setTimeout(async () => { await runDailyScheduler(); scheduleNext(); }, ms);
  }
  scheduleNext();
}

module.exports = { checkPracticeNews, PRACTICE_NEWS, runDailyScheduler, scheduleDaily, runWeeklySourceResearch, generatePost, publishToWordPress, publishAllLanguages, translatePost, linkTranslations, pingIndexNow, complianceIssues, stripFooter, getStaticFooter, loadState, saveState };
