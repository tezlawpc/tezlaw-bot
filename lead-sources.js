// ============================================================
//  lead-sources.js — "How did you hear about us?"
//  Tez Law P.C.
//
//  The firm spends on listings, posts, a newsletter and print, and until now
//  had no way to tell which of them brought anyone in. This module is the
//  whole of that answer:
//
//    1. one list of sources, shared by the website form and Zara's chat
//       intake, so the two cannot drift apart;
//    2. a table, lead_sources, with one row per person who answered;
//    3. a page, /admin/lead-sources, that counts the answers by month.
//
//  What is stored is deliberately thin: the channel the person came in on,
//  the kind of matter, the category of source they named, and when. No name,
//  no phone number, no message; their own words are kept only for an answer
//  that fits no category. The report is about where enquiries come from, not
//  about who made them.
//
//  Mount once in server.js, after the /admin guards:
//      require("./lead-sources").mount(app);
// ============================================================

// Order is the order shown on the form. `match` reads a free-text answer
// typed into a chat; parseAnswer tries the specific ones before the general.
const OPTIONS = [
  { key: "search",  en: "Google or another search engine",                     zh: "谷歌等搜索引擎",                   match: /google|\bsearch|\bbing\b|baidu|谷歌|搜索|百度|buscador/i },
  { key: "maps",    en: "Google Maps or Apple Maps",                           zh: "地图（谷歌地图等）",               match: /\bmaps?\b|地图|mapa/i },
  { key: "ai",      en: "ChatGPT or another AI assistant",                     zh: "ChatGPT 等人工智能助手",           match: /chat\s?gpt|\bgpt\b|claude|gemini|perplexity|copilot|deepseek|\bkimi\b|\bai\b|人工智能|豆包|inteligencia artificial/i },
  { key: "friend",  en: "A friend or family member",                           zh: "亲友介绍",                         match: /friend|family|relative|cousin|brother|sister|husband|wife|mother|father|coworker|colleague|neighbor|朋友|亲戚|家人|亲友|老公|老婆|同事|邻居|同学|amig|famil|vecin/i },
  { key: "client",  en: "A current or past client of the firm",                zh: "本所客户介绍",                     match: /client|客户|cliente/i },
  { key: "partner", en: "A consultant, broker, accountant or another lawyer",  zh: "顾问、经纪人、会计师或其他律师介绍", match: /consultant|broker|agent|accountant|\bcpa\b|lawyer|attorney|realtor|lender|顾问|经纪|会计|律师|中介|abogad|contador/i },
  { key: "wechat",  en: "WeChat",                                              zh: "微信",                             match: /wechat|weixin|微信|公众号|朋友圈|视频号/i },
  { key: "xhs",     en: "Xiaohongshu",                                         zh: "小红书",                           match: /xiaohongshu|red\s?note|小红书/i },
  { key: "social",  en: "Facebook, Instagram or LinkedIn",                     zh: "Facebook、Instagram 或 LinkedIn",  match: /facebook|instagram|linkedin|tiktok|\bfb\b|\big\b|脸书|抖音|领英/i },
  { key: "video",   en: "YouTube or another video",                            zh: "YouTube 等视频",                   match: /youtube|video|视频|油管/i },
  { key: "article", en: "An article or newsletter",                            zh: "文章或简报",                       match: /article|newsletter|blog|\bbrief\b|newspaper|文章|简报|博客|报纸|artículo|periódico/i },
  { key: "print",   en: "A sign, card or brochure",                            zh: "招牌、名片或宣传册",               match: /\bsign\b|business card|\bcard\b|brochure|flyer|walk(?:ed|ing)? (?:by|past)|drove (?:by|past)|招牌|名片|宣传册|传单|路过|letrero|tarjeta|folleto/i },
  { key: "other",   en: "Something else",                                      zh: "其他",                             match: null },
];
const KEYS = OPTIONS.map(o => o.key);
const LABEL = Object.fromEntries(OPTIONS.map(o => [o.key, o.en]));

// A chat answer names its source in a few words. Specific platforms are
// tested before the general ones, so "a friend sent me your WeChat article"
// counts as a referral from a friend only if nothing more specific matched.
const PARSE_ORDER = ["xhs", "wechat", "ai", "maps", "video", "social", "search", "article", "print", "client", "partner", "friend"];

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A key from the list, or "" when the value is not one of ours. */
function normalizeKey(v) {
  const k = clean(v, 20).toLowerCase();
  return KEYS.includes(k) ? k : "";
}

/** Free text from a chat -> { key, text }. Never throws; unknown answers are "other", with the words kept. */
function parseAnswer(text) {
  const t = clean(text, 200);
  for (const key of PARSE_ORDER) {
    const opt = OPTIONS.find(o => o.key === key);
    if (opt.match.test(t)) return { key, text: t };
  }
  return { key: "other", text: t };
}

/**
 * Is this message an answer to "how did you hear about us?", or has the
 * person moved on? A question, or anything long, is treated as a new subject
 * and is left for the normal conversation rather than swallowed here.
 */
function looksLikeAnswer(text) {
  const t = clean(text, 400);
  if (!t) return false;
  if (/[?？]/.test(t)) return false;
  if (/^(?:what|how|when|why|where|who|which|does|do|is|are|can|will|would|could|should|may|might)\b/i.test(t)) return false;
  if (/^(?:ok|okay|thanks|thank you|yes|no|sure|hi|hello|hey|好的|谢谢|嗯|gracias)\W*$/i.test(t)) return false;
  const cjk = /[一-鿿]/.test(t);
  if (cjk ? t.length > 40 : t.split(" ").length > 12) return false;
  return true;
}

// The two intakes name practice areas differently; the report shows one list.
const AREAS = {
  immigration: "Immigration", "Immigration": "Immigration",
  personal_injury: "Personal Injury", "Car Accident / Personal Injury": "Personal Injury",
  business_litigation: "Business Litigation", "Business Litigation": "Business Litigation",
  estate_planning: "Estate Planning", "Estate Planning": "Estate Planning",
  landlord_tenant: "Landlord/Tenant", "Landlord / Tenant": "Landlord/Tenant",
  trademark: "Trademark/Patent", "Patents & Trademarks": "Trademark/Patent",
  "Real Estate": "Real Estate",
};
function areaLabel(v) {
  const s = clean(v, 80);
  return AREAS[s] || (s && !/^other$|^general legal$/i.test(s) ? s : "Other");
}

// ── Storage ──────────────────────────────────────────────────
let ready = null;
function db() { return require("./db"); }
function ensure() {
  if (!ready) {
    ready = db().query(`
      CREATE TABLE IF NOT EXISTS lead_sources (
        id          SERIAL PRIMARY KEY,
        platform    VARCHAR(20)  NOT NULL,
        platform_id VARCHAR(100) NOT NULL,
        channel     VARCHAR(40),
        case_area   VARCHAR(80),
        heard_key   VARCHAR(20)  NOT NULL,
        heard_text  VARCHAR(200),
        created_at  TIMESTAMPTZ  DEFAULT NOW(),
        UNIQUE (platform, platform_id)
      )
    `).catch(err => { ready = null; throw err; });
  }
  return ready;
}

/**
 * Record one answer. One row per person per channel: a second answer from
 * the same person replaces the first, so nobody is counted twice.
 * Returns true if a row was written. Never throws: losing a marketing
 * statistic must not disturb an intake.
 */
async function record({ platform, platformId, caseType, heard, heardText, channel }) {
  try {
    const key = normalizeKey(heard);
    if (!key || !platform || !platformId) return false;
    await ensure();
    await db().query(
      `INSERT INTO lead_sources (platform, platform_id, channel, case_area, heard_key, heard_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (platform, platform_id) DO UPDATE SET
         channel = EXCLUDED.channel, case_area = EXCLUDED.case_area,
         heard_key = EXCLUDED.heard_key, heard_text = EXCLUDED.heard_text`,
      // The person's own words are kept only when they fit no category, so the
      // firm can see what the list is missing. A categorized answer keeps the
      // category alone: "my friend Li Wang" is stored as "friend".
      [clean(platform, 20), clean(platformId, 100), clean(channel || platform, 40), areaLabel(caseType), key, key === "other" ? (clean(heardText, 200) || null) : null]
    );
    return true;
  } catch (err) {
    console.error("[lead-sources] record:", err.message);
    return false;
  }
}

const TZ = "America/Los_Angeles";

// Enquiries come from two tables, and the chat one is created the first time
// Zara runs an intake. Ask which exist before reading, so a new database is
// not sent a query for a table it does not have yet.
async function enquiriesByMonth(n) {
  const since = `(date_trunc('month', NOW() AT TIME ZONE $1) - ($2::int - 1) * INTERVAL '1 month') AT TIME ZONE $1`;
  const have = (await db().query(
    `SELECT to_regclass('public.intakes') IS NOT NULL AS intakes, to_regclass('public.intake_agent_records') IS NOT NULL AS agent`)).rows[0] || {};
  const parts = [];
  // intakes.created_at has no time zone and is written in UTC.
  if (have.intakes) parts.push(
    `SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC' AT TIME ZONE $1), 'YYYY-MM') AS month, COUNT(*)::int AS n
       FROM intakes WHERE (created_at AT TIME ZONE 'UTC') >= ${since} GROUP BY 1`);
  if (have.agent) parts.push(
    `SELECT to_char(date_trunc('month', created_at AT TIME ZONE $1), 'YYYY-MM') AS month, COUNT(*)::int AS n
       FROM intake_agent_records WHERE created_at >= ${since} GROUP BY 1`);
  if (!parts.length) return { rows: [] };
  return db().query(`SELECT month, SUM(n)::int AS n FROM (${parts.join(" UNION ALL ")}) t GROUP BY 1`, [TZ, n]);
}

/** Counts for the last `months` calendar months (Pacific time), newest last. */
async function report(months = 6) {
  await ensure();
  const n = Math.min(Math.max(parseInt(months, 10) || 6, 1), 24);
  const [bySource, byArea, asked, other] = await Promise.all([
    db().query(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE $1), 'YYYY-MM') AS month, heard_key, COUNT(*)::int AS n
         FROM lead_sources
        WHERE created_at >= (date_trunc('month', NOW() AT TIME ZONE $1) - ($2::int - 1) * INTERVAL '1 month') AT TIME ZONE $1
        GROUP BY 1, 2`, [TZ, n]),
    db().query(
      `SELECT case_area, heard_key, COUNT(*)::int AS n
         FROM lead_sources
        WHERE created_at >= (date_trunc('month', NOW() AT TIME ZONE $1) - ($2::int - 1) * INTERVAL '1 month') AT TIME ZONE $1
        GROUP BY 1, 2`, [TZ, n]),
    // How many enquiries there were in all, so the answers can be read as a share.
    enquiriesByMonth(n),
    db().query(
      `SELECT heard_text, COUNT(*)::int AS n FROM lead_sources
        WHERE heard_key = 'other' AND heard_text IS NOT NULL
          AND created_at >= (date_trunc('month', NOW() AT TIME ZONE $1) - ($2::int - 1) * INTERVAL '1 month') AT TIME ZONE $1
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 15`, [TZ, n]),
  ]);

  // The month labels, oldest first, in Pacific time.
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const monthKeys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const grid = {};                       // key -> month -> n
  for (const k of KEYS) grid[k] = Object.fromEntries(monthKeys.map(m => [m, 0]));
  for (const r of bySource.rows) if (grid[r.heard_key] && r.month in grid[r.heard_key]) grid[r.heard_key][r.month] = r.n;
  const answered = Object.fromEntries(monthKeys.map(m => [m, KEYS.reduce((s, k) => s + grid[k][m], 0)]));
  const enquiries = Object.fromEntries(monthKeys.map(m => [m, 0]));
  for (const r of asked.rows) if (r.month in enquiries) enquiries[r.month] = r.n;

  const areas = {};                      // area -> key -> n
  for (const r of byArea.rows) {
    const a = r.case_area || "Other";
    areas[a] = areas[a] || {};
    areas[a][r.heard_key] = (areas[a][r.heard_key] || 0) + r.n;
  }
  return {
    months: monthKeys,
    sources: OPTIONS.map(o => ({ key: o.key, label: o.en, byMonth: grid[o.key], total: monthKeys.reduce((s, m) => s + grid[o.key][m], 0) })),
    answered, enquiries, areas,
    otherAnswers: other.rows.map(r => ({ text: r.heard_text, n: r.n })),
    total: monthKeys.reduce((s, m) => s + answered[m], 0),
  };
}

// ── The page ─────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function monthName(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

function renderPage(r) {
  const cell = "padding:9px 12px; border-top:1px solid #E8E3DC; font-size:13px;";
  const num = cell + " text-align:right; font-variant-numeric:tabular-nums;";
  const head = "padding:9px 12px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#A34C00; background:#F3EFE9; text-align:right;";
  const ranked = r.sources.filter(s => s.total > 0).sort((a, b) => b.total - a.total);
  const top = ranked[0];
  const thisMonth = r.months[r.months.length - 1];

  const rows = r.sources
    .slice().sort((a, b) => b.total - a.total || KEYS.indexOf(a.key) - KEYS.indexOf(b.key))
    .map(s => `<tr><td style="${cell}">${esc(s.label)}</td>${r.months.map(m => `<td style="${num}${s.byMonth[m] ? "" : " color:#B9B2AA;"}">${s.byMonth[m]}</td>`).join("")}<td style="${num} font-weight:600;">${s.total}</td></tr>`)
    .join("");
  const share = m => (r.enquiries[m] ? Math.min(100, Math.round(100 * r.answered[m] / r.enquiries[m])) + "%" : "–");

  const areaNames = Object.keys(r.areas).sort((a, b) => {
    const t = x => Object.values(r.areas[x]).reduce((s, v) => s + v, 0);
    return t(b) - t(a);
  });
  const areaRows = areaNames.map(a => {
    const parts = Object.entries(r.areas[a]).sort((x, y) => y[1] - x[1]);
    const total = parts.reduce((s, p) => s + p[1], 0);
    return `<tr><td style="${cell} font-weight:600;">${esc(a)}</td><td style="${num}">${total}</td><td style="${cell}">${parts.map(([k, v]) => `${esc(LABEL[k] || k)} (${v})`).join(", ")}</td></tr>`;
  }).join("");

  const empty = r.total === 0;
  return `
  <div style="max-width:1080px;">
    <p style="color:#5E5854; font-size:13px; line-height:1.6; margin:0 0 18px; max-width:760px;">
      What people said when the website form or Zara asked how they heard about the firm, for the last ${r.months.length} months.
      Only the answer, the kind of matter and the channel are kept, not the person’s name.
      <a href="/admin/lead-sources.json" style="color:#A34C00;">Download the numbers</a>
    </p>
    ${empty ? `<div style="background:#F3EFE9; border-left:3px solid #FF7B00; padding:14px 18px; font-size:13px; line-height:1.6; margin-bottom:18px;">
      No answers yet. They start to appear once the contact page form includes the new question, and after Zara’s next completed chat intake.</div>` : ""}
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px;">
      <div style="flex:1; min-width:170px; background:#fff; border:1px solid #E8E3DC; border-top:3px solid #FF7B00; border-radius:6px; padding:14px 16px;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:.06em;">Answers, ${esc(monthName(thisMonth))}</div>
        <div style="font-size:24px; font-weight:600; color:#2B2523; margin-top:6px;">${r.answered[thisMonth]}</div>
      </div>
      <div style="flex:1; min-width:170px; background:#fff; border:1px solid #E8E3DC; border-top:3px solid #2B2523; border-radius:6px; padding:14px 16px;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:.06em;">Answers, ${r.months.length} months</div>
        <div style="font-size:24px; font-weight:600; color:#2B2523; margin-top:6px;">${r.total}</div>
      </div>
      <div style="flex:2; min-width:240px; background:#fff; border:1px solid #E8E3DC; border-top:3px solid #A34C00; border-radius:6px; padding:14px 16px;">
        <div style="font-size:11px; color:#5E5854; text-transform:uppercase; letter-spacing:.06em;">Most named source</div>
        <div style="font-size:18px; font-weight:600; color:#2B2523; margin-top:8px;">${top ? `${esc(top.label)} (${top.total})` : "None yet"}</div>
      </div>
    </div>

    <h3 style="font-size:15px; color:#2B2523; margin:0 0 8px;">By source and month</h3>
    <div style="overflow-x:auto; background:#fff; border:1px solid #E8E3DC; border-radius:6px; margin-bottom:22px;">
      <table style="border-collapse:collapse; width:100%;">
        <tr><th style="${head} text-align:left;">Source</th>${r.months.map(m => `<th style="${head}">${esc(monthName(m))}</th>`).join("")}<th style="${head}">Total</th></tr>
        ${rows}
        <tr><td style="${cell} font-weight:600; background:#FAF8F5;">All answers</td>${r.months.map(m => `<td style="${num} font-weight:600; background:#FAF8F5;">${r.answered[m]}</td>`).join("")}<td style="${num} font-weight:600; background:#FAF8F5;">${r.total}</td></tr>
        <tr><td style="${cell} color:#5E5854;">Enquiries received</td>${r.months.map(m => `<td style="${num} color:#5E5854;">${r.enquiries[m]}</td>`).join("")}<td style="${num}"></td></tr>
        <tr><td style="${cell} color:#5E5854;">Share who answered</td>${r.months.map(m => `<td style="${num} color:#5E5854;">${share(m)}</td>`).join("")}<td style="${num}"></td></tr>
      </table>
    </div>

    <h3 style="font-size:15px; color:#2B2523; margin:0 0 8px;">By kind of matter</h3>
    <div style="overflow-x:auto; background:#fff; border:1px solid #E8E3DC; border-radius:6px; margin-bottom:22px;">
      <table style="border-collapse:collapse; width:100%;">
        <tr><th style="${head} text-align:left;">Matter</th><th style="${head}">Answers</th><th style="${head} text-align:left;">Sources named</th></tr>
        ${areaRows || `<tr><td colspan="3" style="${cell} color:#5E5854;">Nothing yet.</td></tr>`}
      </table>
    </div>

    ${r.otherAnswers.length ? `<h3 style="font-size:15px; color:#2B2523; margin:0 0 8px;">Answers that fit no category</h3>
    <div style="background:#fff; border:1px solid #E8E3DC; border-radius:6px; padding:12px 16px; font-size:13px; line-height:1.8; margin-bottom:22px;">
      ${r.otherAnswers.map(o => `${esc(o.text)}${o.n > 1 ? ` (${o.n})` : ""}`).join("<br>")}
    </div>` : ""}
  </div>`;
}

function mount(app) {
  const auth = require("./auth");
  const guard = auth.requirePermission("matters.access");
  ensure().catch(err => console.error("[lead-sources] table:", err.message));

  app.get("/admin/lead-sources", guard, async (req, res) => {
    try {
      const r = await report(req.query.months);
      res.send(require("./hearing-notes").renderAdminChrome({ title: "Lead Sources", body: renderPage(r), activeItem: null }));
    } catch (err) {
      console.error("[lead-sources] page:", err.message);
      res.status(500).send(`<h1>Error</h1><p>${esc(err.message)}</p>`);
    }
  });

  app.get("/admin/lead-sources.json", guard, async (req, res) => {
    try { res.json({ ok: true, report: await report(req.query.months) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
}

module.exports = {
  mount, record, report, parseAnswer, looksLikeAnswer, normalizeKey, areaLabel,
  OPTIONS, KEYS,
  /** What the public form needs: keys and labels only, never the patterns. */
  publicOptions: () => OPTIONS.map(o => ({ key: o.key, en: o.en, zh: o.zh })),
  _internal: { renderPage, PARSE_ORDER },
};
