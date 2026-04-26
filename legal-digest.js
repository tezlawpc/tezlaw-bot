// ============================================================
//  legal-digest.js — Daily Legal Intelligence Agent
//  Runs every morning at 6:00 AM Pacific
//  Sends JJ a Telegram digest of new legal developments
//
//  SOURCES:
//  - CA courts.ca.gov — same-day CA Supreme + Courts of Appeal
//  - CourtListener — 9th Circuit + BIA published decisions
//  - justice.gov/eoir — BIA precedent decisions + policy memos
//  - uscis.gov — USCIS policy manual updates
//  - leginfo.legislature.ca.gov — CA bill status (practice areas)
//
//  HOW IT WORKS:
//  1. Pulls new opinions from all sources since yesterday
//  2. Claude reads each one and scores relevance to JJ's practice
//  3. Only sends digest if there's something relevant (no spam)
//  4. Formats into a clean Telegram message with direct links
//  5. Stores new citations in PostgreSQL for citation tracker
//
//  INTEGRATION: Add to server.js startup block (same as autoposter)
// ============================================================

const axios     = require("axios");
const cron      = require("node-cron");
const db        = require("./db");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const JJ_TELEGRAM_ID    = process.env.JJ_TELEGRAM_ID; // JJ's personal Telegram user ID

// ── Practice areas to monitor ────────────────────────────────
const PRACTICE_AREAS = [
  "immigration", "asylum", "removal", "deportation", "EOIR",
  "BIA", "9th circuit immigration", "USCIS", "visa", "green card",
  "unlawful detainer", "eviction", "landlord tenant", "AB 1482",
  "personal injury", "negligence", "premises liability",
  "civil procedure", "demurrer", "summary judgment", "CCP",
  "estate planning", "probate", "living trust", "conservatorship",
  "business litigation", "breach of contract", "trade secret",
  "real estate", "property", "foreclosure",
];

// ── Court RSS/API sources ────────────────────────────────────
const SOURCES = {
  ca_courts: {
    name:    "CA Courts",
    url:     "https://courts.ca.gov/opinions/rss/publishedcitable-opinions.rss",
    type:    "rss",
    icon:    "🏛️",
  },
  ninth_circuit: {
    name:    "9th Circuit",
    url:     "https://www.ca9.uscourts.gov/rss/opinions.php",
    type:    "rss",
    icon:    "⚖️",
  },
  courtlistener_ca: {
    name:    "CA Appellate (CourtListener)",
    url:     "https://www.courtlistener.com/api/rest/v4/search/",
    type:    "api",
    icon:    "📚",
  },
  courtlistener_bia: {
    name:    "BIA (CourtListener)",
    url:     "https://www.courtlistener.com/api/rest/v4/search/",
    type:    "api",
    icon:    "🛂",
  },
  eoir_memos: {
    name:    "EOIR Policy Memos",
    url:     "https://www.justice.gov/eoir/eoir-policy-manual/memoranda-pm-list",
    type:    "scrape",
    icon:    "📋",
  },
};

// ============================================================
//  FETCH NEW OPINIONS FROM COURTLISTENER
// ============================================================
async function fetchNewOpinions(court, daysSince = 1) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - daysSince);
  const dateStr = yesterday.toISOString().split("T")[0];

  const headers = {};
  if (process.env.COURTLISTENER_TOKEN) {
    headers["Authorization"] = `Token ${process.env.COURTLISTENER_TOKEN}`;
  }

  try {
    const resp = await axios.get("https://www.courtlistener.com/api/rest/v4/search/", {
      params: {
        type:           "o",
        stat_Published: "on",
        court:          court,
        filed_after:    dateStr,
        order_by:       "-dateFiled",
        page_size:      20,
      },
      headers,
      timeout: 15000,
    });

    return (resp.data?.results || []).map(r => ({
      id:         r.id,
      title:      r.caseName || r.case_name || "Unknown",
      citation:   (r.citation || []).join(", "),
      court:      r.court || court,
      date:       r.dateFiled || r.date_filed,
      snippet:    (r.snippet || "").replace(/<[^>]+>/g, " ").trim().substring(0, 500),
      url:        r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
      source:     "CourtListener",
    }));
  } catch (err) {
    console.error(`[digest] CourtListener fetch error (${court}):`, err.message);
    return [];
  }
}

// ── Fetch from CA courts RSS ──────────────────────────────────
async function fetchCACourtsRSS() {
  try {
    const resp = await axios.get(SOURCES.ca_courts.url, { timeout: 10000 });
    const xml  = resp.data;

    // Parse RSS items
    const items = [];
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const match of itemMatches) {
      const item  = match[1];
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     item.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || "";
      const link  = item.match(/<link>(.*?)<\/link>/)?.[1]?.trim() || "";
      const date  = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim() || "";
      const desc  = (item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                     item.match(/<description>(.*?)<\/description>/))?.[1]
                      ?.replace(/<[^>]+>/g, " ").trim().substring(0, 300) || "";

      if (title && link) {
        items.push({ title, url: link, date, snippet: desc, court: "CA Courts", source: "courts.ca.gov" });
      }
    }

    // Filter to today/yesterday
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 1);

    return items.filter(item => {
      if (!item.date) return true; // include if no date
      const d = new Date(item.date);
      return d >= cutoff;
    });

  } catch (err) {
    console.error("[digest] CA Courts RSS error:", err.message);
    return [];
  }
}

// ── Fetch EOIR policy memos (scrape) ─────────────────────────
async function fetchEOIRMemos() {
  try {
    const resp = await axios.get(SOURCES.eoir_memos.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TezLaw-Zara/1.0)" },
      timeout: 10000,
    });

    const html = resp.data;
    const memos = [];

    // Extract recent memo links from the page
    const linkMatches = html.matchAll(/<a\s+href="([^"]*pm[^"]*)"[^>]*>([^<]+)<\/a>/gi);
    for (const match of linkMatches) {
      const url   = match[1].startsWith("http") ? match[1] : `https://www.justice.gov${match[1]}`;
      const title = match[2].trim();

      // Only include if it looks like a 2025 or 2026 memo
      if (/PM\s*2[56]-\d+|2025|2026/i.test(title)) {
        memos.push({
          title,
          url,
          court:  "EOIR",
          source: "justice.gov/eoir",
          date:   new Date().toISOString().split("T")[0],
        });
      }
    }

    return memos.slice(0, 5);
  } catch (err) {
    console.error("[digest] EOIR memos error:", err.message);
    return [];
  }
}

// ============================================================
//  CLAUDE RELEVANCE SCORING
//  Claude reads each opinion and rates relevance 0-10
//  Only opinions scoring 5+ get included in digest
// ============================================================
async function scoreRelevance(opinions) {
  if (!opinions || opinions.length === 0) return [];

  const opinionList = opinions.map((o, i) =>
    `${i+1}. [${o.court}] ${o.title}\n   ${o.snippet || "No snippet"}`
  ).join("\n\n");

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{
          role:    "user",
          content: `You are a legal assistant for Tez Law P.C. in West Covina, CA.

Practice areas: immigration (EOIR/USCIS), personal injury (car accidents), eviction/unlawful detainer (CA), civil litigation, estate planning/probate, real estate.

Rate each opinion's relevance to this firm on a scale of 0-10:
- 0-3: Not relevant (criminal, family, tax, unrelated areas)
- 4-6: Somewhat relevant (general CA procedure, could apply)
- 7-10: Highly relevant (directly affects practice area, important development)

Also classify each as: immigration | personal_injury | eviction | litigation | estate | procedure | other

Opinions to rate:
${opinionList}

Respond ONLY with JSON array:
[{"index": 1, "score": 8, "category": "immigration", "reason": "BIA asylum credibility ruling affects pending cases"},...]`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 20000,
      }
    );

    const text = resp.data.content[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const scores = JSON.parse(clean);

    return opinions
      .map((opinion, i) => {
        const score = scores.find(s => s.index === i + 1);
        return {
          ...opinion,
          relevanceScore:    score?.score    || 0,
          category:          score?.category || "other",
          relevanceReason:   score?.reason   || "",
        };
      })
      .filter(o => o.relevanceScore >= 5)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

  } catch (err) {
    console.error("[digest] Relevance scoring error:", err.message);
    // If scoring fails, return all opinions without filtering
    return opinions.map(o => ({ ...o, relevanceScore: 5, category: "other", relevanceReason: "" }));
  }
}

// ============================================================
//  GENERATE DIGEST SUMMARY WITH CLAUDE
// ============================================================
async function generateDigestSummary(relevantOpinions) {
  if (!relevantOpinions || relevantOpinions.length === 0) return null;

  const opinionList = relevantOpinions.map((o, i) =>
    `${i+1}. [Score: ${o.relevanceScore}/10] [${o.category}] ${o.title}\n   Court: ${o.court} | Date: ${o.date}\n   ${o.snippet}`
  ).join("\n\n");

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{
          role:    "user",
          content: `You are Zara, the AI legal assistant for JJ Zhang at Tez Law P.C. in West Covina, CA.

Write JJ's daily legal intelligence digest based on these new opinions. 

INSTRUCTIONS:
- Group by practice area
- For each opinion: 1 sentence what happened, 1 sentence why it matters to JJ's practice
- Flag anything URGENT or that could affect active cases with ⚠️
- End with "Zara's Take" — 2-3 sentences on what actually matters today
- Keep the whole digest under 1,500 characters for Telegram readability
- Use plain language, not legalese
- If an opinion is landmark or changes the law, say so clearly

Today's date: ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}

New opinions:
${opinionList}`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 30000,
      }
    );

    return resp.data.content[0]?.text?.trim() || null;
  } catch (err) {
    console.error("[digest] Summary generation error:", err.message);
    return null;
  }
}

// ============================================================
//  SEND TELEGRAM MESSAGE TO JJ
// ============================================================
async function sendTelegramDigest(message) {
  if (!TELEGRAM_TOKEN || !JJ_TELEGRAM_ID) {
    console.log("[digest] Telegram not configured — would have sent:\n", message);
    return false;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id:    JJ_TELEGRAM_ID,
      text:       message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    console.log("[digest] ✅ Digest sent to JJ via Telegram");
    return true;
  } catch (err) {
    console.error("[digest] Telegram send error:", err.message);
    return false;
  }
}

// ============================================================
//  STORE CITATIONS IN POSTGRESQL (for citation tracker)
// ============================================================
async function storeCitationsFromOpinions(opinions) {
  if (!opinions || opinions.length === 0) return;

  for (const opinion of opinions) {
    if (!opinion.citation || !opinion.title) continue;
    try {
      await db.query(
        `INSERT INTO legal_citations
         (case_name, citation, court, date_filed, url, source, category, relevance_score, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (citation) DO UPDATE SET
           relevance_score = EXCLUDED.relevance_score,
           updated_at = NOW()`,
        [
          opinion.title,
          opinion.citation || opinion.url,
          opinion.court,
          opinion.date,
          opinion.url,
          opinion.source,
          opinion.category || "other",
          opinion.relevanceScore || 0,
        ]
      ).catch(() => {}); // Non-fatal
    } catch (err) {
      // Table may not exist yet — handled by initCitationTable
    }
  }
}

// ── Initialize citation table in PostgreSQL ──────────────────
async function initCitationTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS legal_citations (
        id              SERIAL PRIMARY KEY,
        case_name       TEXT NOT NULL,
        citation        TEXT UNIQUE,
        court           TEXT,
        date_filed      TEXT,
        url             TEXT,
        source          TEXT,
        category        TEXT,
        relevance_score INTEGER DEFAULT 0,
        treatment       JSONB DEFAULT '[]',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("[digest] ✅ legal_citations table ready");
  } catch (err) {
    console.error("[digest] Table init error:", err.message);
  }
}

// ============================================================
//  MAIN DAILY DIGEST RUNNER
// ============================================================
async function runDailyDigest(forceRun = false) {
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  console.log(`[digest] 🌅 Running daily digest — ${now}`);

  try {
    // ── Fetch from all sources in parallel ──────────────────
    console.log("[digest] Fetching new opinions...");
    const [caOpinions, ninthCircuit, biaOpinions, caCourtsRSS, eoirMemos] = await Promise.all([
      fetchNewOpinions("cal,calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th,calctapp_5th,calctapp_6th"),
      fetchNewOpinions("ca9"),
      fetchNewOpinions("bia"),
      fetchCACourtsRSS(),
      fetchEOIRMemos(),
    ]);

    const allOpinions = [
      ...caOpinions,
      ...ninthCircuit,
      ...biaOpinions,
      ...caCourtsRSS,
      ...eoirMemos,
    ];

    console.log(`[digest] Fetched ${allOpinions.length} total items`);

    if (allOpinions.length === 0 && !forceRun) {
      console.log("[digest] No new opinions found — skipping digest");
      return;
    }

    // ── Score relevance with Claude ──────────────────────────
    console.log("[digest] Scoring relevance...");
    const relevant = await scoreRelevance(allOpinions);
    console.log(`[digest] ${relevant.length} relevant opinions after scoring`);

    if (relevant.length === 0 && !forceRun) {
      console.log("[digest] Nothing relevant today — no digest sent");
      return;
    }

    // ── Store in PostgreSQL ──────────────────────────────────
    await storeCitationsFromOpinions(relevant);

    // ── Generate summary ────────────────────────────────────
    console.log("[digest] Generating summary...");
    const summary = await generateDigestSummary(relevant);

    if (!summary) {
      console.log("[digest] Summary generation failed");
      return;
    }

    // ── Build final message ──────────────────────────────────
    const date = new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
      timeZone: "America/Los_Angeles",
    });

    const links = relevant.slice(0, 5)
      .filter(o => o.url)
      .map(o => `• <a href="${o.url}">${o.title.substring(0, 60)}${o.title.length > 60 ? "..." : ""}</a>`)
      .join("\n");

    const message = [
      `🏛️ <b>Zara Legal Intelligence — ${date}</b>`,
      `<i>${relevant.length} relevant development${relevant.length !== 1 ? "s" : ""} today</i>`,
      "━━━━━━━━━━━━━━━━━━━━",
      summary,
      links ? "\n📎 <b>Read:</b>\n" + links : "",
      "━━━━━━━━━━━━━━━━━━━━",
      `<i>Source: CourtListener • courts.ca.gov • justice.gov/eoir</i>`,
      `<i>Verify citations in vLex before filing</i>`,
    ].filter(Boolean).join("\n");

    // ── Send to JJ ───────────────────────────────────────────
    await sendTelegramDigest(message);

    console.log("[digest] ✅ Daily digest complete");
    return { sent: true, count: relevant.length };

  } catch (err) {
    console.error("[digest] ❌ Error:", err.message);
    return { sent: false, error: err.message };
  }
}

// ============================================================
//  SCHEDULER — 6:00 AM Pacific every day
// ============================================================
function scheduleDigest() {
  // 6:00 AM Pacific = 14:00 UTC
  cron.schedule("0 14 * * *", async () => {
    console.log("[digest] ⏰ Scheduled digest triggered");
    await runDailyDigest();
  }, {
    timezone: "America/Los_Angeles",
  });

  console.log("[digest] 📅 Daily digest scheduled for 6:00 AM Pacific");

  // Initialize citation table on startup
  initCitationTable();
}

module.exports = {
  scheduleDigest,
  runDailyDigest,
  initCitationTable,
  fetchNewOpinions,
  scoreRelevance,
};
