// ============================================================
//  citations.js — Citation Tracker & Graph
//  Builds a growing citation database from daily opinion ingestion
//
//  HOW IT WORKS:
//  1. legal-digest.js stores new opinions daily
//  2. This module extracts citations FROM those opinions
//  3. Detects treatment language (overruled, distinguished, etc.)
//  4. Builds a citation graph in PostgreSQL
//  5. Answers "is this case still good law?" queries
//
//  TABLE: legal_citations    — case metadata
//  TABLE: citation_treatments — how Case B treats Case A
//
//  USAGE IN JJ MODE:
//  "is Martinez v Jones still good law"
//  "check citation 45 Cal.3d 678"
//  "has Smith v City been overruled"
//  "citation history for this case"
// ============================================================

const axios = require("axios");
const db    = require("./db");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Treatment classification labels ──────────────────────────
const TREATMENT_TYPES = {
  POSITIVE: ["followed", "approved", "affirmed", "adopted", "relied on", "applied", "cited with approval"],
  NEGATIVE: ["overruled", "disapproved", "reversed", "rejected", "criticized", "limited", "distinguished", "questioned", "declined to follow", "not followed"],
  NEUTRAL:  ["cited", "mentioned", "noted", "distinguished on other grounds"],
};

// ============================================================
//  DATABASE INITIALIZATION
// ============================================================
async function initCitationTables() {
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
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS citation_treatments (
        id              SERIAL PRIMARY KEY,
        citing_case_id  INTEGER REFERENCES legal_citations(id),
        cited_case_name TEXT NOT NULL,
        cited_citation  TEXT,
        treatment_type  TEXT NOT NULL,
        treatment_label TEXT,
        context_snippet TEXT,
        date_decided    TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_cited_citation 
      ON citation_treatments(cited_citation)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_cited_case_name 
      ON citation_treatments(cited_case_name)
    `);

    console.log("[citations] ✅ Citation tables ready");
  } catch (err) {
    console.error("[citations] Table init error:", err.message);
  }
}

// ============================================================
//  EXTRACT CITATIONS FROM AN OPINION TEXT
//  Uses Claude to find all cited cases and classify treatment
// ============================================================
async function extractCitationsFromOpinion(opinionText, opinionTitle, opinionId) {
  if (!opinionText || opinionText.length < 100) return [];

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{
          role:    "user",
          content: `Extract all case citations from this legal opinion and classify how this opinion treats each cited case.

Opinion: "${opinionTitle}"

Text (first 3000 chars):
${opinionText.substring(0, 3000)}

For each cited case, determine:
1. The case citation (e.g. "45 Cal.3d 678", "230 Cal.App.4th 1234")
2. The case name if mentioned
3. How this opinion treats the cited case:
   - "positive" (followed, approved, cited with approval, relied on)
   - "negative" (overruled, disapproved, distinguished, criticized, limited, questioned)
   - "neutral" (merely cited for a proposition)
4. A short context snippet (max 100 chars) showing the treatment language

Respond ONLY with JSON array (empty array [] if no citations found):
[{
  "citation": "45 Cal.3d 678",
  "case_name": "Smith v. Jones",
  "treatment_type": "negative",
  "treatment_label": "distinguished",
  "context": "We distinguish Smith v. Jones because..."
}]

Focus on explicit treatment language. If just cited as support, use "neutral".`,
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

    const text  = resp.data.content[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const citations = JSON.parse(clean);

    // Store in database
    if (Array.isArray(citations) && citations.length > 0 && opinionId) {
      for (const cite of citations) {
        await db.query(
          `INSERT INTO citation_treatments
           (citing_case_id, cited_case_name, cited_citation, treatment_type, treatment_label, context_snippet, date_decided)
           VALUES ($1, $2, $3, $4, $5, $6, NOW()::text)
           ON CONFLICT DO NOTHING`,
          [
            opinionId,
            cite.case_name || "Unknown",
            cite.citation  || null,
            cite.treatment_type  || "neutral",
            cite.treatment_label || "cited",
            cite.context   || null,
          ]
        ).catch(() => {});
      }
    }

    return citations;

  } catch (err) {
    console.error("[citations] Extraction error:", err.message);
    return [];
  }
}

// ============================================================
//  CITATION LOOKUP
//  Check if a case has been treated negatively
// ============================================================
async function lookupCitationHistory(citationOrName) {
  try {
    // Search both by citation string and case name
    const result = await db.query(
      `SELECT 
        ct.treatment_type,
        ct.treatment_label,
        ct.context_snippet,
        ct.date_decided,
        lc.case_name   AS citing_case,
        lc.citation    AS citing_citation,
        lc.court       AS citing_court,
        lc.url         AS citing_url
       FROM citation_treatments ct
       JOIN legal_citations lc ON ct.citing_case_id = lc.id
       WHERE ct.cited_citation ILIKE $1
          OR ct.cited_case_name ILIKE $2
       ORDER BY ct.date_decided DESC
       LIMIT 20`,
      [`%${citationOrName}%`, `%${citationOrName}%`]
    );

    return result.rows || [];
  } catch (err) {
    console.error("[citations] Lookup error:", err.message);
    return [];
  }
}

// ── Check if case has negative treatment ────────────────────
async function checkGoodLaw(citationOrName) {
  const history = await lookupCitationHistory(citationOrName);

  const negative = history.filter(h => h.treatment_type === "negative");
  const positive = history.filter(h => h.treatment_type === "positive");
  const neutral  = history.filter(h => h.treatment_type === "neutral");

  const overruled     = negative.filter(h => h.treatment_label === "overruled");
  const disapproved   = negative.filter(h => ["disapproved", "rejected", "criticized"].includes(h.treatment_label));
  const distinguished = negative.filter(h => ["distinguished", "limited"].includes(h.treatment_label));

  return {
    citation:     citationOrName,
    totalCitations: history.length,
    hasNegative:  negative.length > 0,
    isOverruled:  overruled.length > 0,
    summary: {
      overruled:     overruled.length,
      disapproved:   disapproved.length,
      distinguished: distinguished.length,
      followed:      positive.length,
      cited:         neutral.length,
    },
    recentNegative: negative.slice(0, 3),
    recentPositive: positive.slice(0, 3),
    dataSource:    history.length > 0 ? "Tez Law Citation Database" : "No data",
    disclaimer:    history.length === 0
      ? "No citation data found in our database. This case may predate our tracking (launched April 2026). ALWAYS verify in vLex Fastcase before filing."
      : "Citation data from Tez Law's database (launched April 2026). Verify in vLex Fastcase for pre-launch history.",
  };
}

// ============================================================
//  TRIGGER DETECTION
// ============================================================
function isCitationCommand(message) {
  const m = message.toLowerCase();
  return (
    /\b(is .+ still good law|good law|been overruled|check citation|citation history|has .+ been|shepardize|verify citation)\b/.test(m) ||
    /\b(cite check|citation check|still valid|still citable|negative treatment)\b/.test(m)
  );
}

// ============================================================
//  MAIN HANDLER
// ============================================================
async function handleCitationCommand(message) {
  const m = message.toLowerCase();

  // Extract citation or case name
  const citationMatch = message.match(/(\d+\s+(?:Cal\.\s*(?:App\.)?\s*(?:\d+[a-z]+)?\s*\d+|F\.\d+[a-z]+\s*\d+|U\.S\.\s*\d+))/i);
  const caseNameMatch = message.match(/\b([A-Z][a-z]+\s+v\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);

  const lookup = citationMatch?.[1] || caseNameMatch?.[1];

  if (!lookup) {
    return `Please specify a citation or case name. Examples:\n• "is 45 Cal.3d 678 still good law"\n• "check citation Smith v. Jones"\n• "has Martinez v City been overruled"`;
  }

  const result = await checkGoodLaw(lookup);
  return formatCitationResult(result);
}

// ── Format citation result ───────────────────────────────────
function formatCitationResult(result) {
  let out = `📎 Citation Check: ${result.citation}\n`;
  out    += `${"─".repeat(50)}\n\n`;

  if (result.totalCitations === 0) {
    out += `⚠️ NO DATA IN DATABASE\n\n`;
    out += `${result.disclaimer}\n\n`;
    out += `🔍 Check manually in:\n`;
    out += `• vLex Fastcase (free via CLA) — most reliable\n`;
    out += `• CourtListener citation lookup\n`;
    out += `• Google Scholar "How cited"`;
    return out;
  }

  // Overall status
  if (result.isOverruled) {
    out += `🚨 WARNING — POTENTIALLY OVERRULED\n`;
    out += `This case has been overruled ${result.summary.overruled} time(s) in our database.\n`;
    out += `DO NOT cite without verifying in vLex Fastcase.\n\n`;
  } else if (result.summary.disapproved > 0) {
    out += `⚠️ CRITICIZED/DISAPPROVED\n`;
    out += `This case has been criticized or disapproved ${result.summary.disapproved} time(s).\n`;
    out += `Verify current status before citing.\n\n`;
  } else if (result.summary.followed > 0 && result.summary.overruled === 0) {
    out += `✅ APPEARS GOOD LAW (in our database)\n`;
    out += `Followed ${result.summary.followed} time(s), no overruling detected.\n\n`;
  } else {
    out += `ℹ️ CITED — No Negative Treatment Found\n`;
    out += `Cited ${result.totalCitations} time(s) with no overruling detected.\n\n`;
  }

  // Summary stats
  out += `📊 TREATMENT SUMMARY\n`;
  out += `  Overruled:     ${result.summary.overruled}\n`;
  out += `  Criticized:    ${result.summary.disapproved}\n`;
  out += `  Distinguished: ${result.summary.distinguished}\n`;
  out += `  Followed:      ${result.summary.followed}\n`;
  out += `  Cited:         ${result.summary.cited}\n\n`;

  // Recent negative treatment
  if (result.recentNegative.length > 0) {
    out += `⚠️ RECENT NEGATIVE TREATMENT\n`;
    result.recentNegative.forEach(t => {
      out += `• ${t.citing_case} (${t.date_decided || "Unknown date"})\n`;
      out += `  Treatment: ${t.treatment_label}\n`;
      if (t.context_snippet) out += `  "${t.context_snippet}"\n`;
      if (t.citing_url) out += `  ${t.citing_url}\n`;
    });
    out += "\n";
  }

  // Recent positive treatment
  if (result.recentPositive.length > 0) {
    out += `✅ RECENT POSITIVE TREATMENT\n`;
    result.recentPositive.forEach(t => {
      out += `• ${t.citing_case} — ${t.treatment_label}\n`;
    });
    out += "\n";
  }

  out += `${"─".repeat(50)}\n`;
  out += `⚠️ ${result.disclaimer}`;

  return out;
}

// ── Get citation stats for dashboard ────────────────────────
async function getCitationStats() {
  try {
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM legal_citations)         AS total_cases,
        (SELECT COUNT(*) FROM citation_treatments)      AS total_treatments,
        (SELECT COUNT(*) FROM citation_treatments WHERE treatment_type = 'negative') AS negative_count,
        (SELECT COUNT(*) FROM legal_citations WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
    `);
    return stats.rows[0] || {};
  } catch (err) {
    return { total_cases: 0, total_treatments: 0, negative_count: 0, new_this_week: 0 };
  }
}

module.exports = {
  initCitationTables,
  extractCitationsFromOpinion,
  lookupCitationHistory,
  checkGoodLaw,
  isCitationCommand,
  handleCitationCommand,
  getCitationStats,
};
