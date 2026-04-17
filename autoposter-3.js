// ============================================================
//  TEZ LAW P.C. — WORDPRESS AUTO-POSTER v2
//  NEW: Weekly self-updating source research
//  Daily posts now use curated high-authority sources
// ============================================================

const axios = require("axios");
const fs    = require("fs");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TEAM_CHAT_ID      = process.env.TEAM_TELEGRAM_CHAT_ID;
const WP_URL            = process.env.WP_URL;
const WP_USER           = process.env.WP_USER;
const WP_APP_PASSWORD   = process.env.WP_APP_PASSWORD;

// ── File paths ────────────────────────────────────────────────
const STATE_FILE   = "/var/data/autoposter_state.json";
const SOURCES_FILE = "/var/data/sources.json";

// ── JJ Zhang voice profile ────────────────────────────────────
const JJ_VOICE = `
You are rewriting a legal blog post in the voice of JJ Zhang, managing attorney at Tez Law P.C.
JJ's style: Conversational and direct. Signature phrase: "Protect your rights — we handle the rest."
Uses "we"/"our team" not "I". Short punchy sentences mixed with longer explanations.
Never uses: "In today's complex landscape", "navigating", "it's important to note", "comprehensive", "multifaceted".
Gets straight to the point. Empathetic but practical. Uses contractions naturally.
Occasionally uses rhetorical questions. Never guarantees outcomes.
JJ is an immigrant himself. Has business/real estate background. Speaks English, Mandarin, Shanghainese.`;

// ── Static footer (author box + disclaimer + schema) ──────────
function getStaticFooter(title) {
  const today = new Date().toISOString().split("T")[0];
  return `
<style>.tez-ab{display:flex;flex-direction:column;gap:16px;padding:28px 24px;margin:40px 0 28px;background:#f9fafb;border:1px solid #e2e6ea;border-left:5px solid #1B3A5C;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,.06);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;line-height:1.6}.tez-ab *{box-sizing:border-box}.tez-ab-label{display:inline-block;font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1B3A5C;background:#e8eef4;padding:2px 10px;border-radius:3px}.tez-ab-name{font-size:1.25rem;font-weight:800;color:#1B3A5C;margin:4px 0 2px}.tez-ab-cn{font-size:.9rem;font-weight:400;color:#666;margin-left:6px}.tez-ab-title{font-size:.9rem;color:#4a5568;margin-bottom:8px}.tez-ab-creds{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.8rem;color:#555;margin-bottom:10px}.tez-ab-bio{font-size:.92rem;color:#333;margin:0 0 12px;line-height:1.7}.tez-ab-bio strong{color:#1B3A5C}.tez-ab-langs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.tez-lang{display:inline-flex;align-items:center;gap:5px;background:#fff;border:1px solid #d1d9e0;border-radius:20px;padding:3px 12px;font-size:.78rem;font-weight:600;color:#1B3A5C}.tez-dot{width:8px;height:8px;border-radius:50%;display:inline-block}.tez-dot-en{background:#1B3A5C}.tez-dot-zh{background:#DE2910}.tez-dot-sh{background:#D4A017}.tez-ab-tagline{font-size:.87rem;font-style:italic;color:#1B3A5C;font-weight:600;padding:7px 14px;background:rgba(27,58,92,.06);border-radius:6px;display:inline-block;margin-bottom:14px}.tez-ab-ctas{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}.tez-cta1{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:#1B3A5C;color:#fff!important;font-size:.9rem;font-weight:700;padding:11px 22px;border-radius:6px;text-decoration:none!important}.tez-cta1:hover{background:#0f2740}.tez-cta2{display:inline-flex;align-items:center;justify-content:center;gap:6px;color:#1B3A5C;font-size:.87rem;font-weight:600;padding:9px 18px;border:2px solid #1B3A5C;border-radius:6px;text-decoration:none!important}.tez-cta2:hover{background:#1B3A5C;color:#fff!important}.tez-ab-chat{font-size:.82rem;color:#4a5568;margin-bottom:8px}.tez-ab-chat a{color:#1B3A5C;font-weight:600;text-decoration:none}.tez-ab-areas{font-size:.78rem;color:#718096}@media(min-width:768px){.tez-ab{flex-direction:row;align-items:flex-start;gap:24px;padding:32px 28px}.tez-ab-ctas{flex-direction:row}.tez-cta1,.tez-cta2{width:auto}}</style>
<aside class="tez-ab" aria-label="About the author"><div>
<span class="tez-ab-label">About the Author</span>
<div class="tez-ab-name">JJ Zhang, Esq.<span class="tez-ab-cn">章律師</span></div>
<div class="tez-ab-title">Founding Attorney · Tez Law P.C.</div>
<div class="tez-ab-creds"><span>⚖️ California Bar #326666</span><span>🏛️ 9th Circuit Court of Appeals</span><span>🏢 CA RE Broker #01921248</span></div>
<p class="tez-ab-bio"><strong>JJ Zhang is an immigrant who built his American dream from the ground up</strong> — and now fights to protect yours. Before law, JJ operated businesses and developed residential and commercial real estate. Today he brings that real-world hustle and first-hand immigration experience to every client he represents at Tez Law P.C.</p>
<div class="tez-ab-langs"><span class="tez-lang"><span class="tez-dot tez-dot-en"></span>English</span><span class="tez-lang"><span class="tez-dot tez-dot-zh"></span>中文 Mandarin</span><span class="tez-lang"><span class="tez-dot tez-dot-sh"></span>上海话 Shanghainese</span></div>
<div class="tez-ab-tagline">"Protect your rights — we handle the rest."</div>
<div class="tez-ab-ctas"><a href="https://tezlawfirm.com/contact/" class="tez-cta1">📞 Free Consultation — 626-678-8677</a><a href="https://link.v1ce.co/tezintake" class="tez-cta2" target="_blank">📋 Start Intake Form →</a></div>
<div class="tez-ab-chat">💬 Chat with Zara 24/7: <a href="https://wa.me/16266788677" target="_blank">WhatsApp</a> · <a href="https://m.me/tezlawfirm" target="_blank">Messenger</a> · <a href="https://t.me/TEZJJBot" target="_blank">Telegram</a> · <a href="https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=gh_03f700f08037" target="_blank">WeChat</a></div>
<div class="tez-ab-areas"><strong>Immigration:</strong> Nationwide &nbsp;·&nbsp; <strong>PI &amp; Litigation:</strong> LA, Orange, San Bernardino &amp; Riverside Counties<br><em>我們也會說中文 · Puede hablar español</em></div>
</div></aside>
<p style="font-size:12px;color:#666;margin-top:20px;"><em>Disclaimer: This article is for informational purposes only and does not constitute legal advice. Contact Tez Law P.C. at 626-678-8677 or <a href="mailto:jj@tezlawfirm.com">jj@tezlawfirm.com</a> for advice specific to your situation. Results may vary.</em></p>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${title.replace(/"/g, '\\"')}","author":{"@type":"Person","name":"JJ Zhang","alternateName":"章律師","jobTitle":"Founding Attorney","knowsLanguage":["English","Chinese","Shanghainese"],"worksFor":{"@type":"LegalService","name":"Tez Law P.C.","url":"https://tezlawfirm.com"}},"publisher":{"@type":"Organization","name":"Tez Law P.C.","url":"https://tezlawfirm.com"},"datePublished":"${today}","dateModified":"${today}"}</script>`;
}

// ── State management ──────────────────────────────────────────
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) {}
  return { lastImmigrationCheck: null, lastWeatherCheck: null, publishedTitles: [], weeklyEvergreen: { pi: null, business: null, trademark: null, estate: null }, lastHolidayPost: null, titleHistory: [] };
}
function saveState(state) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {} }

// ── Sources management ────────────────────────────────────────
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
      // Merge with defaults to ensure all keys exist
      return { ...DEFAULT_SOURCES, ...s };
    }
  } catch (e) {}
  return { ...DEFAULT_SOURCES };
}

function saveSources(sources) {
  try { fs.writeFileSync(SOURCES_FILE, JSON.stringify(sources, null, 2)); } catch (e) {}
}

// ── Claude API ────────────────────────────────────────────────
async function askClaude(prompt, useWebSearch = false) {
  const body = { model: "claude-sonnet-4-20250514", max_tokens: 4096, messages: [{ role: "user", content: prompt }] };
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const response = await axios.post("https://api.anthropic.com/v1/messages", body, {
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }
  });
  return response.data.content.filter(b => b.type === "text").map(b => b.text).join("");
}

// ─────────────────────────────────────────────────────────────
//  WEEKLY SOURCE RESEARCH — runs every Sunday
// ─────────────────────────────────────────────────────────────
async function runWeeklySourceResearch() {
  console.log("🔬 Running weekly source research...");
  const sources = loadSources();

  const prompt = `You are a legal content research specialist. Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.

Search the web to find the CURRENT most authoritative, most-trafficked, and most-trending websites for legal news in these practice areas for a California law firm (Tez Law P.C. in West Covina):

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

    // Update sources but keep structure
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

    // Notify team about source update
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
    return sources; // Fall back to existing sources
  }
}

// ── Check if weekly research is needed ───────────────────────
function shouldRunWeeklyResearch(sources) {
  if (!sources.lastResearched) return true;
  const daysSince = (Date.now() - new Date(sources.lastResearched).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= 7;
}

// ── WordPress publish ─────────────────────────────────────────
async function publishToWordPress({ title, content, category, tags, metaDescription, focusKeyword }) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  console.log("Publishing to WordPress:", title?.substring(0, 50));

  let categoryId = 1;
  try {
    const catRes = await axios.get(`${WP_URL}/wp-json/wp/v2/categories?search=${encodeURIComponent(category)}`, { headers: { Authorization: `Basic ${auth}` } });
    if (catRes.data.length > 0) { categoryId = catRes.data[0].id; }
    else { const newCat = await axios.post(`${WP_URL}/wp-json/wp/v2/categories`, { name: category }, { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } }); categoryId = newCat.data.id; }
  } catch (e) { console.log("Category lookup failed:", e.message); }

  let tagIds = [];
  try {
    for (const tagName of (tags || [])) {
      await new Promise(r => setTimeout(r, 500));
      const tagRes = await axios.get(`${WP_URL}/wp-json/wp/v2/tags?search=${encodeURIComponent(tagName)}`, { headers: { Authorization: `Basic ${auth}` } });
      if (tagRes.data.length > 0) { tagIds.push(tagRes.data[0].id); }
      else { const newTag = await axios.post(`${WP_URL}/wp-json/wp/v2/tags`, { name: tagName }, { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } }); tagIds.push(newTag.data.id); }
    }
  } catch (e) { console.log("Tag lookup failed:", e.message); tagIds = []; }

  const postData = { title, content, status: "publish", categories: [categoryId], tags: tagIds, excerpt: metaDescription || "" };
  if (metaDescription || focusKeyword) {
    postData.meta = {};
    if (metaDescription) { postData.meta._yoast_wpseo_metadesc = metaDescription; postData.meta._yoast_wpseo_opengraph_description = metaDescription; }
    if (focusKeyword) postData.meta._yoast_wpseo_focuskw = focusKeyword;
    if (title) postData.meta._yoast_wpseo_title = title + " - Tez Law P.C.";
  }

  const postRes = await axios.post(`${WP_URL}/wp-json/wp/v2/posts`, postData, { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } });
  console.log("✅ WordPress published, ID:", postRes.data.id);
  return postRes.data;
}

// ── Telegram notification ─────────────────────────────────────
async function notifyTeam(message) {
  if (!TEAM_CHAT_ID || !TELEGRAM_TOKEN) { console.log("Telegram notify:", message); return; }
  try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, { chat_id: TEAM_CHAT_ID, text: message, parse_mode: "Markdown" }); }
  catch (e) { console.error("Telegram notify failed:", e.message); }
}

// ── Duplicate detection ───────────────────────────────────────
function isDuplicateTitle(title, state) {
  const normalize = t => t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, " ").replace(/\s+/g, " ").trim();
  const normalized = normalize(title);
  const history = state.titleHistory || [];
  return history.some(t => {
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

// ── Translation ───────────────────────────────────────────────
async function translatePost(post, language) {
  const cfgs = {
    chinese: { label: "Traditional Chinese (繁體中文)", instruction: "Translate to Traditional Chinese. Keep all HTML tags. Only translate visible text. Keep URLs, phone numbers, emails unchanged.", categoryPrefix: "中文-", tagSuffix: " 中文" },
    spanish: { label: "Spanish (Latin American)", instruction: "Translate to Latin American Spanish. Keep all HTML tags. Only translate visible text. Keep URLs, phone numbers, emails unchanged.", categoryPrefix: "Español-", tagSuffix: " español" }
  };
  const cfg = cfgs[language];
  if (!cfg) return null;
  console.log(`🌐 Translating to ${cfg.label}...`);
  const footerIdx = post.content.indexOf("<style>.tez-ab{");
  const articleBody = footerIdx > 0 ? post.content.substring(0, footerIdx) : post.content;
  const prompt = `${cfg.instruction}\n\nORIGINAL TITLE: ${post.title}\nHTML BODY:\n${articleBody}\n\nReturn ONLY JSON:\n{"title":"translated title","content":"translated HTML body","metaDescription":"150-160 char translated meta","focusKeyword":"primary keyword in ${cfg.label}"}`;
  try {
    await new Promise(r => setTimeout(r, 8000));
    const raw = await askClaude(prompt, false);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const translated = JSON.parse(cleaned.substring(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
    return { title: translated.title, content: (translated.content || "") + getStaticFooter(translated.title || post.title), category: cfg.categoryPrefix + post.category, tags: (post.tags || []).map(t => t + cfg.tagSuffix), metaDescription: translated.metaDescription, focusKeyword: translated.focusKeyword };
  } catch (e) { console.log(`Translation to ${cfg.label} failed:`, e.message); return null; }
}

// ── Publish in all 3 languages ────────────────────────────────
async function publishAllLanguages(post, notifyPrefix) {
  const results = [];
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString("base64");
  if (await checkWordPressDuplicate(post.title, auth)) { console.log("⚠️ Skipping WP duplicate:", post.title); return 0; }

  try { const p = await publishToWordPress(post); results.push({ lang: "English", link: p.link }); }
  catch (e) { console.error("English publish failed:", e.message); }

  const chPost = await translatePost(post, "chinese");
  if (chPost) { try { const p = await publishToWordPress(chPost); results.push({ lang: "中文", link: p.link }); } catch (e) { console.error("Chinese publish failed:", e.message); } }

  const esPost = await translatePost(post, "spanish");
  if (esPost) { try { const p = await publishToWordPress(esPost); results.push({ lang: "Español", link: p.link }); } catch (e) { console.error("Spanish publish failed:", e.message); } }

  if (results.length > 0) {
    await notifyTeam(`${notifyPrefix}\n\n📌 *${post.title}*\n\n🌐 Published in ${results.length} language(s):\n${results.map(r => `${r.lang}: ${r.link}`).join("\n")}`);
  }
  return results.length;
}

function recordPublishedTitle(title, state) {
  if (!state.titleHistory) state.titleHistory = [];
  if (!state.publishedTitles) state.publishedTitles = [];
  state.titleHistory.push(title);
  state.publishedTitles.push(title);
  saveState(state);
}

// ── Generate post using curated sources ───────────────────────
async function generatePost({ topic, practiceArea, context, useSearch, sources }) {
  const currentYear = new Date().getFullYear();
  const todayStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  const locationContext = ["Immigration Law", "Immigration"].includes(practiceArea)
    ? "nationwide United States (Tez Law handles immigration cases across the entire US)"
    : "Southern California — Los Angeles County, Orange County, San Bernardino County, and Riverside Counties. Key cities: West Covina, LA, Anaheim, San Bernardino, Riverside, Ontario, Pomona.";

  // Build source instruction if sources are provided
  const sourceInstruction = sources && sources.length > 0
    ? `\nPRIORITY SOURCES: When researching this topic, prioritize information from these high-authority sources: ${sources.join(", ")}. Search these first, then supplement with other credible sources if needed.\n`
    : "";

  const prompt = `You are an expert legal content writer and SEO specialist for Tez Law P.C., West Covina, California. JJ Zhang is managing attorney (California Bar #326666).

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
   - H2: Why Choose Tez Law P.C.
   - H2: Frequently Asked Questions
     * 3 FAQs as <div class="faq-item"><h3>Question?</h3><p>Answer</p></div>
   - Closing CTA paragraph
4. INTERNAL LINKS:
   - Immigration: <a href="https://tezlawfirm.com/immigration/">immigration services</a>
   - PI: <a href="https://tezlawfirm.com/home/personal-injury/">personal injury attorney</a>
   - General: <a href="https://tezlawfirm.com/contact/">free consultation</a>
5. TAGS: 5-7 specific tags including location + practice area keywords

Return ONLY this JSON (no markdown, no backticks):
{"title":"SEO title","metaDescription":"150-160 char meta","content":"full HTML content","category":"Immigration|Personal Injury|Business Law|Trademarks|Estate Planning","tags":["tag1","tag2","tag3","tag4","tag5"],"focusKeyword":"main SEO keyword"}`;

  const raw = await askClaude(prompt, useSearch);
  let postData;
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    postData = JSON.parse(cleaned.substring(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
  } catch (e) { console.error("Failed to parse Claude response:", e.message); return null; }

  postData.content = (postData.content || "") + getStaticFooter(postData.title || "");

  // Humanize intro in JJ Zhang's voice
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

// ─────────────────────────────────────────────────────────────
//  TRIGGER 1: Immigration News (uses curated sources)
// ─────────────────────────────────────────────────────────────
async function checkImmigrationNews(state, sources) {
  console.log("📰 Checking immigration news...");
  const sourceList = sources.immigration.join(", ");
  const weeklyContext = sources.weeklyTrends ? `\nWeekly context: ${sources.weeklyTrends}` : "";
  const urgentContext = sources.urgentArea === "immigration" && sources.urgentTopic
    ? `\nUrgent topic flagged this week: ${sources.urgentTopic}` : "";

  const prompt = `Search for the most significant US immigration law news or development from the past 7 days.

PRIORITY SOURCES to check: ${sourceList}
${weeklyContext}${urgentContext}

Pick the single most newsworthy item relevant to US immigration (visas, green cards, deportation, work permits, asylum, DACA, TPS, immigration enforcement).

Respond ONLY in this exact JSON format:
{"hasNews":true,"headline":"brief headline here","summary":"one sentence summary","source":"which source had this news"}

If nothing noteworthy in past 7 days: {"hasNews":false}`;

  const result = await askClaude(prompt, true);
  let newsData;
  try {
    const cleaned = result.replace(/```json|```/g, "").trim();
    newsData = JSON.parse(cleaned.substring(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
  } catch (e) { console.log("Failed to parse news result:", e.message); return 0; }

  if (!newsData.hasNews) { console.log("No new immigration news today."); return 0; }
  if (isDuplicateTitle(newsData.headline, state)) { console.log("⚠️ Duplicate:", newsData.headline); return 0; }

  console.log(`📰 News found from ${newsData.source}: ${newsData.headline}`);
  await new Promise(r => setTimeout(r, 10000));

  let post = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      post = await generatePost({
        topic: newsData.headline,
        practiceArea: "Immigration Law",
        context: newsData.summary,
        useSearch: false,
        sources: sources.immigration
      });
      if (post) break;
    } catch (e) { if (attempt < 3) await new Promise(r => setTimeout(r, 15000)); }
  }
  if (!post) return 0;

  const count = await publishAllLanguages(post, "📢 *New Immigration Post Published!*");
  if (count > 0) recordPublishedTitle(post.title, state);
  return count > 0 ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 2: Weather check (PI)
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
    const count = await publishAllLanguages(post, "🌧️ *Weather PI Post Published!*");
    if (count > 0) { state.lastWeatherCheck = now; state.publishedTitles.push(post.title); }
    return count > 0 ? 1 : 0;
  } catch (e) { console.error("Weather check failed:", e.message); return 0; }
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 3: Holiday posts
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
      const count = await publishAllLanguages(post, "🎉 *Holiday Post Published!*");
      if (count > 0) { state.lastHolidayPost = key; state.publishedTitles.push(post.title); return 1; }
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────
//  TRIGGER 4: Evergreen posts (uses curated sources)
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
    const available = EVERGREEN_TOPICS.pi.filter(t => !(state.publishedTitles || []).includes(t));
    const topic = available.length > 0 ? available[0] : EVERGREEN_TOPICS.pi[Math.floor(Math.random() * EVERGREEN_TOPICS.pi.length)];
    const post = await generatePost({ topic, practiceArea: "Personal Injury", useSearch: false, sources: sources.personalInjury });
    if (post) { const c = await publishAllLanguages(post, "📝 *PI Evergreen Post!*"); if (c > 0) { state.weeklyEvergreen.pi = now.toDateString(); state.publishedTitles.push(post.title); published++; } }
  }

  // Business or Trademark — every Thursday (alternating)
  if (dayOfWeek === 4 && state.weeklyEvergreen.business !== now.toDateString()) {
    const weekNum = Math.floor(now.getDate() / 7);
    if (weekNum % 2 === 0) {
      const topic = EVERGREEN_TOPICS.business[Math.floor(Math.random() * EVERGREEN_TOPICS.business.length)];
      const post = await generatePost({ topic, practiceArea: "Business Law", useSearch: false, sources: sources.business });
      if (post) { const c = await publishAllLanguages(post, "📝 *Business Law Post!*"); if (c > 0) { state.weeklyEvergreen.business = now.toDateString(); state.publishedTitles.push(post.title); published++; } }
    } else {
      const topic = EVERGREEN_TOPICS.trademark[Math.floor(Math.random() * EVERGREEN_TOPICS.trademark.length)];
      const post = await generatePost({ topic, practiceArea: "Trademarks", useSearch: false, sources: sources.trademark });
      if (post) { const c = await publishAllLanguages(post, "📝 *Trademark Post!*"); if (c > 0) { state.weeklyEvergreen.trademark = now.toDateString(); state.publishedTitles.push(post.title); published++; } }
    }
  }

  // Estate Planning — every other Friday
  if (dayOfWeek === 5 && state.weeklyEvergreen.estate !== now.toDateString()) {
    const weekNum = Math.floor(now.getDate() / 7);
    if (weekNum % 2 === 0) {
      const topic = EVERGREEN_TOPICS.estate[Math.floor(Math.random() * EVERGREEN_TOPICS.estate.length)];
      const post = await generatePost({ topic, practiceArea: "Estate Planning", useSearch: false, sources: sources.estate });
      if (post) { const c = await publishAllLanguages(post, "📝 *Estate Planning Post!*"); if (c > 0) { state.weeklyEvergreen.estate = now.toDateString(); state.publishedTitles.push(post.title); published++; } }
    }
  }

  return published;
}

// ─────────────────────────────────────────────────────────────
//  URGENT TOPIC — if weekly research flagged something urgent
// ─────────────────────────────────────────────────────────────
async function checkUrgentTopic(state, sources) {
  if (!sources.urgentTopic || !sources.urgentArea) return 0;

  // Only post urgent topic once — check if already posted
  const urgentKey = `urgent-${sources.urgentTopic?.substring(0, 30)}`;
  if (isDuplicateTitle(urgentKey, state)) { console.log("Urgent topic already posted."); return 0; }

  console.log(`🚨 Posting urgent topic: ${sources.urgentTopic}`);

  const areaToSources = {
    immigration: sources.immigration,
    "personal injury": sources.personalInjury,
    business: sources.business,
    trademark: sources.trademark,
    estate: sources.estate,
  };
  const practiceAreaMap = {
    immigration: "Immigration Law",
    "personal injury": "Personal Injury",
    business: "Business Law",
    trademark: "Trademarks",
    estate: "Estate Planning",
  };

  const area = sources.urgentArea?.toLowerCase();
  const practiceArea = practiceAreaMap[area] || "Immigration Law";
  const relevantSources = areaToSources[area] || sources.immigration;

  const post = await generatePost({
    topic: sources.urgentTopic,
    practiceArea,
    context: sources.weeklyTrends || "",
    useSearch: true,
    sources: relevantSources
  });

  if (!post) return 0;
  const count = await publishAllLanguages(post, `🚨 *Urgent Topic Post: ${practiceArea}!*`);
  if (count > 0) {
    recordPublishedTitle(urgentKey, state);
    // Clear urgent topic after posting
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

  // Run weekly source research if needed (Sundays or overdue)
  const today = new Date();
  const isSunday = today.getDay() === 0;
  if (isSunday || shouldRunWeeklyResearch(sources)) {
    console.log("📅 Running weekly source research...");
    sources = await runWeeklySourceResearch();
    await new Promise(r => setTimeout(r, 15000)); // cooldown
  }

  // Run all triggers using curated sources
  try { total += await checkUrgentTopic(state, sources); } catch (e) { console.error("Urgent topic error:", e.message); }
  try { total += await checkImmigrationNews(state, sources); } catch (e) { console.error("Immigration check error:", e.message); }
  try { total += await checkWeather(state, sources); } catch (e) { console.error("Weather check error:", e.message); }
  try { total += await checkHolidays(state, sources); } catch (e) { console.error("Holiday check error:", e.message); }
  try { total += await checkEvergreen(state, sources); } catch (e) { console.error("Evergreen check error:", e.message); }

  saveState(state);
  console.log(`✅ Auto-poster complete. Published ${total} post(s) today.\n`);
}

// ─────────────────────────────────────────────────────────────
//  SCHEDULER — runs on startup + daily at 8 AM Pacific
// ─────────────────────────────────────────────────────────────
function scheduleDaily() {
  // Run immediately on startup to catch missed posts
  console.log("🚀 Running auto-poster on startup...");
  setTimeout(async () => { await runDailyScheduler(); }, 10000);

  // Schedule daily at 15:00 UTC (8 AM Pacific)
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

module.exports = { runDailyScheduler, scheduleDaily, runWeeklySourceResearch };
