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
const { validateOpinions, isSafeToCache } = require("./source-validator");

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
//  Uses opinions endpoint directly to get real text,
//  not search snippets which come back empty in v4
// ============================================================
async function fetchNewOpinions(court, daysSince = 7) {
  const since = new Date();
  since.setDate(since.getDate() - daysSince);
  const dateStr = since.toISOString().split("T")[0];

  const headers = {};
  if (process.env.COURTLISTENER_TOKEN) {
    headers["Authorization"] = `Token ${process.env.COURTLISTENER_TOKEN}`;
  }

  try {
    // Use opinions endpoint — returns plain_text directly
    const resp = await axios.get("https://www.courtlistener.com/api/rest/v4/opinions/", {
      params: {
        cluster__docket__court:   court,
        cluster__date_filed__gte: dateStr,
        order_by:                 "-id",   // valid for deep pagination
        page_size:                30,
      },
      headers,
      timeout: 15000,
    });

    const raw = resp.data?.results || [];
    if (!raw.length) return [];

    // Fetch cluster info for case names — opinions endpoint returns cluster as URL
    const enriched = [];
    for (const op of raw.slice(0, 20)) {
      const text = (op.plain_text || op.html_with_citations || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 4000);

      // Extract case name from text or fetch cluster
      let caseName = "Unknown";
      let dateFiled = "";

      if (typeof op.cluster === "string" && op.cluster_id) {
        try {
          const clusterResp = await axios.get(
            `https://www.courtlistener.com/api/rest/v4/clusters/${op.cluster_id}/`,
            { headers, timeout: 8000 }
          );
          caseName  = clusterResp.data?.case_name || "Unknown";
          dateFiled = clusterResp.data?.date_filed || "";
        } catch (e) {
          // First-line extraction fallback
          const firstLine = text.split(/[.\n]/)[0]?.trim();
          if (firstLine && firstLine.length < 200) caseName = firstLine;
        }
      }

      enriched.push({
        id:        op.cluster_id || op.id,
        title:     caseName,
        court:     court,
        date:      dateFiled,
        snippet:   text.substring(0, 1500),    // real text now, not empty
        full_text: text,                        // full text available for digest
        url:       op.absolute_url
                    ? `https://www.courtlistener.com${op.absolute_url}`
                    : null,
        source:    "CourtListener",
        author:    op.author_str || op.joined_by_str || "",
      });
    }

    // Layers 1-3: run through source validator
    const { valid, rejected } = validateOpinions(enriched);
    if (rejected.length > 0) {
      console.log(`[digest] 🚫 Filtered ${rejected.length} non-credible sources from ${court}`);
    }

    return valid;

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
//  Produces substantive case briefs with facts, holding, significance
// ============================================================
async function generateDigestSummary(relevantOpinions) {
  if (!relevantOpinions || relevantOpinions.length === 0) return null;

  // Use full text (not just snippet) so Claude can read actual holdings
  const opinionList = relevantOpinions.slice(0, 8).map((o, i) => {
    const text = (o.full_text || o.snippet || "").substring(0, 2500);
    return `${i+1}. [${o.category || "general"}] ${o.title}
   Court: ${o.court} | Date: ${o.date}${o.author ? ` | Judge: ${o.author}` : ""}
   OPINION TEXT:
   ${text}`;
  }).join("\n\n---\n\n");

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-5-20250929",
        max_tokens: 4500,                       // raised for substantive briefs
        messages: [{
          role:    "user",
          content: `You are Zara, AI legal assistant for JJ Zhang at Tez Law P.C. in West Covina, CA.

JJ's practice areas: immigration (asylum/removal/CAT/cancellation), personal injury (auto/premises/wrongful death), eviction/UD (CA), business litigation (contracts/trade secrets), employment (FEHA/PAGA/wage hour), estate planning/probate, real estate, public entity/securities, federal civil rights.

Write JJ's daily legal intelligence digest based on these opinions. For EACH opinion you include, provide a SUBSTANTIVE brief with:

**Format for each case:**
**[Case Name]** ([Court], [Date])
- *Facts:* 1-2 sentences on what happened
- *Holding:* The actual legal ruling — what the court decided
- *Why it matters:* 1 sentence on practical impact for JJ's specific practice areas
- *Citation:* Bluebook-style if available

**STRICT RULES:**
- Read the OPINION TEXT for each case — extract real facts and the actual holding
- Never just say "decision on X matter" — say what the holding IS
- Group by practice area with bold headers (IMMIGRATION, EVICTION, PI, BUSINESS, EMPLOYMENT, ESTATE, FEDERAL CIVIL RIGHTS, OTHER)
- Skip cases that don't touch JJ's practice areas
- Flag with ⚠️ URGENT only if it changes existing law or affects a pending case type
- End with "**Zara's Take**" — 3-4 sentences on what genuinely changes JJ's practice today
- No character limit — be substantive, but don't pad. If only 3 cases matter, write 3.
- Use plain language, but include exact statutory cites when the court did

Today's date: ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}

Opinions:
${opinionList}`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 60000,
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

  // Telegram limit is 4096 chars per message. Split substantive digests on paragraph boundaries.
  const MAX_LEN = 3900;
  const chunks = [];
  if (message.length <= MAX_LEN) {
    chunks.push(message);
  } else {
    let remaining = message;
    while (remaining.length > MAX_LEN) {
      // Find last paragraph break before MAX_LEN
      let cutAt = remaining.lastIndexOf("\n\n", MAX_LEN);
      if (cutAt < MAX_LEN * 0.5) cutAt = remaining.lastIndexOf("\n", MAX_LEN);
      if (cutAt < MAX_LEN * 0.5) cutAt = MAX_LEN;
      chunks.push(remaining.substring(0, cutAt));
      remaining = remaining.substring(cutAt).trimStart();
    }
    if (remaining.length) chunks.push(remaining);
  }

  try {
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks.length > 1 ? `[Part ${i+1}/${chunks.length}]\n\n${chunks[i]}` : chunks[i];
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id:    JJ_TELEGRAM_ID,
        text:       part,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      // Brief pause between parts to maintain order
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[digest] ✅ Digest sent to JJ via Telegram (${chunks.length} part${chunks.length>1?"s":""})`);
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

// ============================================================
//  ADDITION 3 — CONTRADICTION DETECTION + APPROVAL QUEUE
//  Before writing a new Q&A to answer_cache, check whether
//  a similar question already has a DIFFERENT answer. If so,
//  divert to pending_cache_updates and alert JJ on Telegram.
//  JJ replies /approve <id> or /reject <id> from his phone.
// ============================================================
async function initPendingUpdatesTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS pending_cache_updates (
        id              SERIAL PRIMARY KEY,
        question        TEXT NOT NULL,
        old_answer      TEXT,
        new_answer      TEXT NOT NULL,
        practice_area   TEXT,
        opinion_title   TEXT,
        opinion_url     TEXT,
        opinion_court   TEXT,
        opinion_date    TEXT,
        status          TEXT DEFAULT 'pending',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        decided_at      TIMESTAMPTZ
      )
    `);
    console.log("[digest] ✅ pending_cache_updates table ready");
  } catch (err) {
    console.error("[digest] pending_cache_updates init error:", err.message);
  }
}

// Look up existing cached answer for a similar question.
// Uses the same lookup answer-cache.js uses for client queries,
// so we catch the exact entry a client would have received.
async function findExistingCachedAnswer(question, practiceArea) {
  try {
    const { findCachedAnswer } = require("./answer-cache");
    if (typeof findCachedAnswer === "function") {
      const hit = await findCachedAnswer(question, practiceArea, "en");
      if (hit && hit.answer) return hit;
    }
  } catch (_) { /* fall through to direct query */ }

  // Fallback: direct DB lookup using the correct column name.
  try {
    const result = await db.query(
      `SELECT question_sample AS question, answer FROM answer_cache
       WHERE language = 'en'
         AND expires_at > NOW()
         AND ($1::text IS NULL OR practice_area = $1 OR cache_layer = 'global')
         AND question_sample ILIKE '%' || $2 || '%'
       ORDER BY hit_count DESC
       LIMIT 1`,
      [practiceArea || null, question.substring(0, 40)]
    );
    if (result.rows.length && result.rows[0].answer) {
      return { question: result.rows[0].question, answer: result.rows[0].answer };
    }
  } catch (_) { /* table may not exist yet */ }
  return null;
}

// Heuristic: do two answers materially disagree?
// We let Claude Haiku decide because phrasing varies wildly
// ("2 years" vs "two-year statute" vs "24 months" all agree).
async function answersContradict(oldAnswer, newAnswer) {
  if (!oldAnswer || !newAnswer) return false;

  // Cheap pre-check: if they're nearly identical, skip the API call.
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (norm(oldAnswer) === norm(newAnswer)) return false;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 50,
        messages: [{
          role:    "user",
          content: `Do these two legal answers materially CONTRADICT each other (state different rules, holdings, deadlines, or outcomes)? Different wording or extra detail is NOT a contradiction.

OLD: ${oldAnswer}
NEW: ${newAnswer}

Reply with one word: YES or NO.`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 10000,
      }
    );
    const verdict = (resp.data.content[0]?.text || "").trim().toUpperCase();
    return verdict.startsWith("YES");
  } catch (err) {
    console.error("[digest] Contradiction check error:", err.message);
    // On error, fail SAFE: treat as contradiction → goes to JJ for approval.
    return true;
  }
}

// Queue a pending update and alert JJ on Telegram with approve/reject buttons.
async function queuePendingUpdate({ question, oldAnswer, newAnswer, practiceArea, opinion }) {
  try {
    const result = await db.query(
      `INSERT INTO pending_cache_updates
        (question, old_answer, new_answer, practice_area,
         opinion_title, opinion_url, opinion_court, opinion_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        question,
        oldAnswer,
        newAnswer,
        practiceArea || "general",
        opinion.title,
        opinion.url || null,
        opinion.court || null,
        opinion.date || null,
      ]
    );
    const id = result.rows[0].id;

    if (TELEGRAM_TOKEN && JJ_TELEGRAM_ID) {
      const msg = [
        `⚠️ <b>Cache update needs your approval</b>`,
        ``,
        `<b>Q:</b> ${question}`,
        ``,
        `<b>OLD answer (currently cached):</b>`,
        `${oldAnswer.substring(0, 400)}`,
        ``,
        `<b>NEW answer (from ${opinion.court || "new opinion"}):</b>`,
        `${newAnswer.substring(0, 400)}`,
        ``,
        opinion.url ? `📄 <a href="${opinion.url}">Read opinion</a>` : "",
        ``,
        `Reply: <code>/approve ${id}</code> or <code>/reject ${id}</code>`,
      ].filter(Boolean).join("\n");

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          chat_id:    JJ_TELEGRAM_ID,
          text:       msg,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }
      ).catch(err => console.error("[digest] Pending alert error:", err.message));
    }

    console.log(`[digest] ⚠️  Contradiction queued (id=${id}): "${question.substring(0, 60)}"`);
    return id;
  } catch (err) {
    console.error("[digest] Pending queue error:", err.message);
    return null;
  }
}

// Apply (approve) or discard (reject) a pending update.
// Called from jj-mode.js when JJ replies /approve <id> or /reject <id>.
async function decidePendingUpdate(id, decision) {
  const { storeCachedAnswer } = require("./answer-cache");
  try {
    const row = await db.query(
      `SELECT * FROM pending_cache_updates WHERE id = $1 AND status = 'pending'`,
      [id]
    );
    if (!row.rows.length) {
      return { ok: false, msg: `No pending update with id ${id} (already decided?)` };
    }
    const p = row.rows[0];

    if (decision === "approve") {
      await storeCachedAnswer(p.question, p.new_answer, p.practice_area, "en");
      await db.query(
        `UPDATE pending_cache_updates SET status='approved', decided_at=NOW() WHERE id=$1`,
        [id]
      );
      return { ok: true, msg: `✅ Approved #${id} — cache updated for "${p.question.substring(0, 60)}"` };
    } else {
      await db.query(
        `UPDATE pending_cache_updates SET status='rejected', decided_at=NOW() WHERE id=$1`,
        [id]
      );
      return { ok: true, msg: `🚫 Rejected #${id} — old cached answer kept` };
    }
  } catch (err) {
    console.error("[digest] decidePendingUpdate error:", err.message);
    return { ok: false, msg: `Error: ${err.message}` };
  }
}

// ============================================================
//  ADDITION 1 — SEED ANSWER CACHE FROM HIGH-RELEVANCE OPINIONS
//  For any opinion scoring 8+, generate 3-5 Q&A pairs and
//  pre-load them into the answer cache so clients get
//  accurate, up-to-date answers before they even ask.
//  CONTRADICTIONS are diverted to pending_cache_updates
//  and require JJ's /approve to take effect.
// ============================================================
async function seedCacheFromOpinion(opinion) {
  if (!opinion || (opinion.relevanceScore || 0) < 8) return 0;

  const { storeCachedAnswer, detectPracticeArea } = require("./answer-cache");

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{
          role:    "user",
          content: `You are generating FAQ cache entries for a law firm chatbot based on a new court opinion.

Opinion: ${opinion.title}
Court: ${opinion.court}
Category: ${opinion.category}
Summary: ${opinion.snippet || opinion.relevanceReason || ""}

Generate 3-5 client FAQ questions that this opinion answers, with concise accurate answers.
ONLY generate questions a general client would actually ask — not legal jargon.
ONLY include factual, general answers — never personal advice.

Rules:
- Questions must be general (no "my case" or specific facts)
- Answers max 2 sentences
- Answers must accurately reflect the opinion's holding
- Skip if the holding is too narrow to generate useful FAQs

Respond ONLY with JSON array (empty array [] if no good FAQs):
[{"q": "client question", "a": "concise accurate answer"}, ...]`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 15000,
      }
    );

    const text  = resp.data.content[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const pairs = JSON.parse(clean);

    if (!Array.isArray(pairs) || pairs.length === 0) return 0;

    let seeded = 0;
    for (const pair of pairs) {
      if (!pair.q || !pair.a || pair.q.length < 10 || pair.a.length < 20) continue;

      const practiceArea = detectPracticeArea(pair.q) || opinion.category || "general";
      const answer = `${pair.a} (Based on ${opinion.title}, ${opinion.court}, ${opinion.date || "2025"})`;

      // Layer 4: validate any citations in the generated answer
      const safetyCheck = isSafeToCache(pair.q, answer);
      if (!safetyCheck.safe) {
        console.log(`[digest] 🚫 Skipping cache entry — ${safetyCheck.reason}`);
        continue;
      }

      // Add disclaimer if answer contains weak citations
      const finalAnswer = safetyCheck.addDisclaimer
        ? `${answer} ${safetyCheck.disclaimer}`
        : answer;

      // Contradiction gate: if a similar Q already has a DIFFERENT answer,
      // queue for JJ approval instead of silently overwriting.
      const existing = await findExistingCachedAnswer(pair.q, practiceArea);
      if (existing && await answersContradict(existing.answer, finalAnswer)) {
        await queuePendingUpdate({
          question:     pair.q,
          oldAnswer:    existing.answer,
          newAnswer:    finalAnswer,
          practiceArea,
          opinion,
        });
        continue; // do NOT write to cache — JJ must /approve first
      }

      await storeCachedAnswer(pair.q, finalAnswer, practiceArea, "en");
      seeded++;
    }

    if (seeded > 0) {
      console.log(`[digest] 💾 Cache seeded: ${seeded} Q&As from "${opinion.title.substring(0, 50)}"`);
    }
    return seeded;

  } catch (err) {
    console.error("[digest] Cache seed error:", err.message);
    return 0;
  }
}

// ============================================================
//  ADDITION 2 — SAVE RESEARCH NOTES TO JJ MEMORY
//  For any opinion scoring 8+, save a concise research note
//  into jj_memory so JJ mode already knows about it.
//  Scores 9-10 also trigger an immediate Telegram alert.
// ============================================================
async function saveResearchNoteToJJMemory(opinion) {
  if (!opinion || (opinion.relevanceScore || 0) < 8) return;

  try {
    // Build a concise research note
    const note = [
      `📚 New ${opinion.court} opinion: ${opinion.title}`,
      opinion.citation ? `Citation: ${opinion.citation}` : null,
      `Date: ${opinion.date || "Recent"}`,
      `Category: ${opinion.category}`,
      `Why it matters: ${opinion.relevanceReason || opinion.snippet?.substring(0, 200) || ""}`,
      opinion.url ? `Read: ${opinion.url}` : null,
    ].filter(Boolean).join(" | ");

    // Save to jj_memory as a research entry
    await db.query(
      `INSERT INTO jj_memory (timestamp, jj_said, zara_said)
       VALUES ($1, $2, $3)`,
      [
        new Date().toISOString(),
        `[RESEARCH] ${opinion.title}`,
        note.substring(0, 2000),
      ]
    );

    console.log(`[digest] 🧠 JJ memory updated: "${opinion.title.substring(0, 50)}"`);

    // For score 9-10 (critical/landmark): send immediate Telegram alert
    if ((opinion.relevanceScore || 0) >= 9 && TELEGRAM_TOKEN && JJ_TELEGRAM_ID) {
      const urgentMsg = [
        `🚨 <b>URGENT — New Legal Development</b>`,
        ``,
        `<b>${opinion.title}</b>`,
        `🏛️ ${opinion.court} | 📅 ${opinion.date || "Today"}`,
        ``,
        `⚠️ ${opinion.relevanceReason || opinion.snippet?.substring(0, 200) || ""}`,
        ``,
        opinion.url ? `<a href="${opinion.url}">📄 Read Full Opinion →</a>` : "",
        ``,
        `<i>Zara has saved this to your research memory and pre-seeded the client cache.</i>`,
      ].filter(s => s !== null).join("\n");

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        {
          chat_id:    JJ_TELEGRAM_ID,
          text:       urgentMsg,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }
      ).catch(err => console.error("[digest] Urgent alert error:", err.message));

      console.log(`[digest] 🚨 Urgent alert sent for score-${opinion.relevanceScore} opinion`);
    }

  } catch (err) {
    console.error("[digest] JJ memory save error:", err.message);
  }
}

// ============================================================
//  ADDITION 4 — SEED ANSWER CACHE FROM DAILY BLOG POSTS
//  Called by autoposter.js right after a successful English
//  publish. Extracts FAQ Q&As directly from the post HTML
//  (no extra API call — the autoposter already structured them),
//  runs them through the SAME contradiction gate as digest seeds,
//  and tags them with the blog URL so Zara can link back.
// ============================================================
function extractFAQsFromBlogHTML(html) {
  if (!html) return [];

  // The autoposter generates FAQs as:
  //   <div class="faq-item"><h3>Question?</h3><p>Answer</p></div>
  const pairs = [];
  const faqRegex = /<div[^>]*class=["'][^"']*faq-item[^"']*["'][^>]*>\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/div>/gi;

  let match;
  while ((match = faqRegex.exec(html)) !== null) {
    const q = match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const a = match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (q.length >= 10 && a.length >= 20) {
      pairs.push({ q, a });
    }
  }

  return pairs;
}

// Map autoposter category names to answer_cache practice areas
function normalizeBlogCategory(category) {
  if (!category) return "general";
  const c = category.toLowerCase();
  if (c.includes("immigration"))     return "immigration";
  if (c.includes("personal injury")) return "personal_injury";
  if (c.includes("business"))        return "business";
  if (c.includes("trademark"))       return "trademark";
  if (c.includes("estate"))          return "estate_planning";
  return "general";
}

async function seedCacheFromBlogPost({ title, htmlContent, url, category }) {
  if (!htmlContent || !url) {
    console.log("[blog-seed] Skipped — missing content or URL");
    return 0;
  }

  const { storeCachedAnswer } = require("./answer-cache");
  const practiceArea = normalizeBlogCategory(category);

  // Extract FAQs from the post (no API call needed — they're structured)
  const faqs = extractFAQsFromBlogHTML(htmlContent);

  if (faqs.length === 0) {
    console.log(`[blog-seed] No FAQs found in "${title.substring(0, 50)}" — skipping`);
    return 0;
  }

  console.log(`[blog-seed] Found ${faqs.length} FAQs in "${title.substring(0, 50)}"`);

  let seeded = 0;
  let queued = 0;

  for (const pair of faqs) {
    // Layer 4 safety: validate citations in answer text
    const safetyCheck = isSafeToCache(pair.q, pair.a);
    if (!safetyCheck.safe) {
      console.log(`[blog-seed] 🚫 Skipping — ${safetyCheck.reason}`);
      continue;
    }

    const finalAnswer = safetyCheck.addDisclaimer
      ? `${pair.a} ${safetyCheck.disclaimer}`
      : pair.a;

    // Contradiction gate (same as digest pipeline)
    const existing = await findExistingCachedAnswer(pair.q, practiceArea);
    if (existing && await answersContradict(existing.answer, finalAnswer)) {
      await queuePendingUpdate({
        question:     pair.q,
        oldAnswer:    existing.answer,
        newAnswer:    finalAnswer,
        practiceArea,
        opinion: {
          title,
          url,
          court: "Tez Law Blog",
          date:  new Date().toISOString().split("T")[0],
        },
      });
      queued++;
      continue;
    }

    // Write to cache with blog source tagging
    // (answer-cache.js handles the source_type + source_url columns)
    await storeCachedAnswer(
      pair.q,
      finalAnswer,
      practiceArea,
      "en",
      { sourceType: "blog", sourceUrl: url }
    );
    seeded++;
  }

  // Save a research note to jj_memory so JJ mode knows about the post
  try {
    const topicsList = faqs.slice(0, 3).map(f => f.q).join(" | ");
    await db.query(
      `INSERT INTO jj_memory (timestamp, jj_said, zara_said) VALUES ($1, $2, $3)`,
      [
        new Date().toISOString(),
        `[BLOG] Published: ${title}`,
        `URL: ${url} | Practice: ${practiceArea} | Topics: ${topicsList}`.substring(0, 2000),
      ]
    );
  } catch (err) {
    console.error("[blog-seed] jj_memory write error:", err.message);
  }

  console.log(`[blog-seed] ✅ Seeded ${seeded} | Queued ${queued} for approval | Post: ${url}`);
  return seeded;
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

    // ── Seed answer cache + save to JJ memory ────────────────
    // Runs for all opinions scoring 8+ (high relevance)
    // Non-blocking — digest continues even if these fail
    const highRelevance = relevant.filter(o => (o.relevanceScore || 0) >= 8);
    if (highRelevance.length > 0) {
      console.log(`[digest] 🔄 Processing ${highRelevance.length} high-relevance opinions for cache + memory...`);
      let totalSeeded = 0;
      for (const opinion of highRelevance) {
        // Run sequentially to avoid hammering the API
        const [seeded] = await Promise.allSettled([
          seedCacheFromOpinion(opinion),
          saveResearchNoteToJJMemory(opinion),
        ]);
        totalSeeded += (seeded.value || 0);
      }
      console.log(`[digest] ✅ Cache seeded: ${totalSeeded} total Q&As | Memory updated: ${highRelevance.length} notes`);
    }

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

  // Initialize tables on startup
  initCitationTable();
  initPendingUpdatesTable();
}

module.exports = {
  scheduleDigest,
  runDailyDigest,
  initCitationTable,
  initPendingUpdatesTable,
  fetchNewOpinions,
  scoreRelevance,
  seedCacheFromOpinion,
  saveResearchNoteToJJMemory,
  seedCacheFromBlogPost,
  decidePendingUpdate,
};
