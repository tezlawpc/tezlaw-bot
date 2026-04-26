// ============================================================
//  courtlistener.js — CourtListener REST API v4 Integration
//  Free Law Project | courtlistener.com/api/rest/v4/
//
//  FEATURES:
//  - Search California case law by keyword or citation
//  - Look up specific citations (e.g. "230 Cal.App.4th 1234")
//  - Get full opinion text
//  - Search BIA/9th Circuit immigration decisions
//  - Citation verification (checks if a citation is real)
//
//  SETUP:
//  1. Register free account at courtlistener.com
//  2. Get API token: courtlistener.com/sign-in/ → Profile → API Token
//  3. Add to Render env vars: COURTLISTENER_TOKEN=your_token_here
//
//  USAGE IN JJ MODE (Zara chat):
//  "research demurrer elements breach of contract California"
//  "find cases on unlawful detainer 3-day notice requirements"
//  "look up 230 Cal.App.4th 1234"
//  "verify citation Martinez v Jones 45 Cal.3d 123"
//  "BIA cases on asylum credibility findings"
//  "9th circuit cases on voluntary departure"
// ============================================================

const axios = require("axios");

const CL_BASE    = "https://www.courtlistener.com/api/rest/v4";
const CL_TOKEN   = process.env.COURTLISTENER_TOKEN;

// ── California court identifiers in CourtListener ────────────
// Full list: courtlistener.com/api/rest/v4/courts/?jurisdiction=s&state=ca
const CA_COURTS = {
  supreme:    "cal",          // California Supreme Court
  app1:       "calctapp_1st", // Court of Appeal 1st District
  app2:       "calctapp_2nd", // Court of Appeal 2nd District (LA)
  app3:       "calctapp_3rd", // Court of Appeal 3rd District (Sacramento)
  app4:       "calctapp_4th", // Court of Appeal 4th District (San Bernardino/Riverside)
  app5:       "calctapp_5th", // Court of Appeal 5th District (Fresno)
  app6:       "calctapp_6th", // Court of Appeal 6th District (San Jose)
  all_state:  "cal,calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th,calctapp_5th,calctapp_6th",
  ninth:      "ca9",          // 9th Circuit Court of Appeals
  bia:        "bia",          // Board of Immigration Appeals
  cacd:       "cacd",         // Central District of California (federal)
  caed:       "caed",         // Eastern District of California (federal)
  immigration: "ca9,bia",     // 9th Circuit + BIA
};

// ── Practice area → court mapping ───────────────────────────
const PRACTICE_COURTS = {
  civil:       CA_COURTS.all_state,
  immigration: CA_COURTS.immigration,
  federal:     `${CA_COURTS.ninth},${CA_COURTS.cacd},${CA_COURTS.caed}`,
  pi:          CA_COURTS.all_state,
  eviction:    CA_COURTS.all_state,
  estate:      CA_COURTS.all_state,
  all:         `${CA_COURTS.all_state},${CA_COURTS.ninth},${CA_COURTS.bia}`,
};

// ============================================================
//  CORE API FUNCTIONS
// ============================================================

function clHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (CL_TOKEN) headers["Authorization"] = `Token ${CL_TOKEN}`;
  return headers;
}

// ── Search opinions by keyword ───────────────────────────────
// Returns array of top results with citation, court, date, snippet
async function searchCaseLaw(query, options = {}) {
  const {
    courts     = CA_COURTS.all_state,
    maxResults = 5,
    dateAfter  = "2010-01-01", // default: last 15 years
    dateBefore = null,
    orderBy    = "score",      // "score" | "dateFiled" | "-dateFiled"
  } = options;

  try {
    const params = {
      q:           query,
      type:        "o",          // opinions
      stat_Published: "on",      // published opinions only
      order_by:    orderBy,
      page_size:   maxResults,
    };

    // Add court filter
    if (courts) {
      params.court = courts;
    }

    // Date filters
    if (dateAfter)  params.filed_after  = dateAfter;
    if (dateBefore) params.filed_before = dateBefore;

    const resp = await axios.get(`${CL_BASE}/search/`, {
      params,
      headers: clHeaders(),
      timeout: 15000,
    });

    const results = resp.data?.results || [];
    return results.map(r => formatOpinion(r));

  } catch (err) {
    console.error("[courtlistener] Search error:", err.response?.data || err.message);
    throw new Error(`Case law search failed: ${err.message}`);
  }
}

// ── Look up a specific citation ──────────────────────────────
// e.g. "230 Cal.App.4th 1234" or "45 Cal.3d 678"
async function lookupCitation(citation) {
  try {
    // Use citation lookup endpoint
    const resp = await axios.get(`${CL_BASE}/search/`, {
      params: {
        q:         `"${citation}"`,
        type:      "o",
        page_size: 3,
      },
      headers: clHeaders(),
      timeout: 15000,
    });

    const results = resp.data?.results || [];
    if (results.length === 0) {
      return { found: false, citation, message: "Citation not found in CourtListener database." };
    }

    return {
      found:   true,
      citation,
      results: results.map(r => formatOpinion(r)),
    };
  } catch (err) {
    console.error("[courtlistener] Citation lookup error:", err.message);
    throw new Error(`Citation lookup failed: ${err.message}`);
  }
}

// ── Verify a citation is real (anti-hallucination check) ─────
// Returns { verified: bool, caseName, citation, url, warning }
async function verifyCitation(citation) {
  try {
    const result = await lookupCitation(citation);

    if (!result.found || result.results.length === 0) {
      return {
        verified: false,
        citation,
        warning: "⚠️ CITATION NOT VERIFIED — Could not confirm this citation exists. DO NOT use in filings without manual Westlaw/Lexis verification.",
      };
    }

    const best = result.results[0];
    return {
      verified:  true,
      citation,
      caseName:  best.caseName,
      court:     best.court,
      dateFiled: best.dateFiled,
      url:       best.absoluteUrl,
      warning:   null,
    };
  } catch (err) {
    return {
      verified: false,
      citation,
      warning:  `⚠️ VERIFICATION FAILED: ${err.message}. Manually verify before use.`,
    };
  }
}

// ── Get full opinion text ─────────────────────────────────────
async function getOpinionText(opinionId) {
  try {
    const resp = await axios.get(`${CL_BASE}/opinions/${opinionId}/`, {
      headers: clHeaders(),
      timeout: 15000,
    });

    const opinion = resp.data;
    return {
      id:         opinion.id,
      caseName:   opinion.cluster?.case_name,
      text:       (opinion.plain_text || opinion.html_with_citations || "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .substring(0, 5000), // first 5000 chars
      url:        `https://www.courtlistener.com${opinion.cluster?.absolute_url}`,
    };
  } catch (err) {
    throw new Error(`Could not fetch opinion text: ${err.message}`);
  }
}

// ── Format a raw CourtListener result ────────────────────────
function formatOpinion(r) {
  return {
    id:           r.id,
    caseName:     r.caseName || r.case_name || "Unknown",
    citation:     (r.citation || []).join(", ") || "No citation",
    court:        r.court      || r.court_id   || "Unknown court",
    dateFiled:    r.dateFiled  || r.date_filed  || "Unknown date",
    snippet:      (r.snippet || "")
                    .replace(/<[^>]+>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .substring(0, 300),
    absoluteUrl:  r.absolute_url
                    ? `https://www.courtlistener.com${r.absolute_url}`
                    : null,
    score:        r.score || null,
  };
}

// ============================================================
//  ZARA CHAT INTEGRATION
//  Detect and handle research commands in JJ mode
// ============================================================

const RESEARCH_TRIGGERS = [
  /\b(research|find cases?|look up|search for|case law on|cases? on|cases? about|find me cases?)\b/i,
  /\b(verify citation|check citation|is .+ a real case)\b/i,
  /\b(\d+\s+Cal\.\s*(?:App\.|Rptr\.)?\s*(?:\d+d|4th|3d|2d|1st)?\s*\d+)\b/i, // citation pattern
  /\b(\d+\s+F\.\s*(?:\d+d|4th|3d|2d|1st)\s*\d+)\b/i,                         // federal citation
  /\b(\d+\s+U\.S\.\s*\d+)\b/i,                                                  // USSC citation
];

function isResearchCommand(message) {
  return RESEARCH_TRIGGERS.some(r => r.test(message));
}

// ── Detect practice area from message ────────────────────────
function detectResearchArea(message) {
  const m = message.toLowerCase();
  if (/immigra|asylum|bia|eoir|nta|removal|deporta|visa|i-589|green card/.test(m)) return "immigration";
  if (/accident|injury|personal injury|negligence|tort/.test(m)) return "pi";
  if (/eviction|unlawful detainer|ud|landlord|tenant|rent/.test(m)) return "eviction";
  if (/federal|9th circuit|district court|habeas/.test(m)) return "federal";
  if (/estate|trust|probate|will|conservat/.test(m)) return "estate";
  return "civil";
}

// ── Main handler called from paralegal.js or jj-mode.js ──────
async function handleResearchCommand(message) {
  const m = message.toLowerCase();

  // ── Citation verification ────────────────────────────────
  const citationMatch = message.match(
    /(\d+\s+(?:Cal\.(?:\s*App\.)?(?:\s*\d+[a-z]+)?\s*\d+|F\.\d+[a-z]+\s*\d+|U\.S\.\s*\d+|F\.\s*Supp\.\s*\d+[a-z]*\s*\d+))/i
  );

  if (/verify|check citation|real case|confirm/.test(m) && citationMatch) {
    const citation = citationMatch[1].trim();
    const result = await verifyCitation(citation);
    return formatVerificationResult(result);
  }

  // ── Direct citation lookup ───────────────────────────────
  if (citationMatch && !/research|find|cases/.test(m)) {
    const citation = citationMatch[1].trim();
    const result   = await lookupCitation(citation);
    return formatLookupResult(result);
  }

  // ── Keyword search ───────────────────────────────────────
  // Strip command words to get the actual search query
  const query = message
    .replace(/^(research|find cases?|look up|search for|case law on|cases? on|cases? about|find me cases?\s+(?:on|about)?)/i, "")
    .replace(/\b(in california|california cases?|ca cases?)\b/i, "")
    .trim();

  if (!query || query.length < 3) {
    return "Please provide a more specific search query. Example: \"find cases on unlawful detainer 3-day notice\" or \"research demurrer grounds breach of contract\"";
  }

  const area    = detectResearchArea(message);
  const courts  = PRACTICE_COURTS[area] || PRACTICE_COURTS.civil;

  const results = await searchCaseLaw(query, {
    courts,
    maxResults: 5,
    dateAfter:  "2005-01-01",
  });

  return formatSearchResults(query, results, area);
}

// ============================================================
//  RESPONSE FORMATTERS
// ============================================================

function formatSearchResults(query, results, area) {
  if (!results || results.length === 0) {
    return `🔍 No published cases found for: "${query}"\n\nTry broader search terms or check Westlaw/Lexis for more comprehensive coverage.`;
  }

  const areaLabel = {
    immigration: "Immigration (9th Circuit/BIA)",
    pi:          "Personal Injury",
    eviction:    "Eviction/Landlord-Tenant",
    federal:     "Federal",
    estate:      "Estate Planning",
    civil:       "California Civil",
  }[area] || "California";

  let out = `🔍 Case Law Research: "${query}"\n`;
  out    += `Court: ${areaLabel} | ${results.length} results\n`;
  out    += `Source: CourtListener (Free Law Project)\n`;
  out    += `⚠️  Always verify citations in Westlaw/Lexis before filing\n`;
  out    += `${"─".repeat(50)}\n\n`;

  results.forEach((r, i) => {
    out += `${i + 1}. ${r.caseName}\n`;
    if (r.citation) out += `   📎 ${r.citation}\n`;
    out += `   🏛️  ${r.court} | 📅 ${r.dateFiled}\n`;
    if (r.snippet) out += `   "${r.snippet}..."\n`;
    if (r.absoluteUrl) out += `   🔗 ${r.absoluteUrl}\n`;
    out += "\n";
  });

  out += `\nTo read full opinion text, say: "get full text for case [number]"`;
  return out;
}

function formatVerificationResult(result) {
  if (result.verified) {
    return `✅ CITATION VERIFIED\n\n📎 ${result.citation}\n📋 ${result.caseName}\n🏛️  ${result.court}\n📅 ${result.dateFiled}\n🔗 ${result.url}\n\nThis citation appears genuine. Still verify Good Law status in Westlaw KeyCite or Lexis Shepard's before filing.`;
  }
  return `❌ CITATION NOT VERIFIED\n\n📎 ${result.citation}\n\n${result.warning}\n\nThis citation could not be confirmed in CourtListener. It may be:\n- A hallucinated/fake citation\n- A very recent case not yet indexed\n- A lower court case not in the database\n\n🚨 DO NOT use in any filing without manual Westlaw/Lexis verification.`;
}

function formatLookupResult(result) {
  if (!result.found) {
    return `📎 Citation: ${result.citation}\n\n❌ Not found in CourtListener.\n\n${result.message}\n\nVerify manually in Westlaw or Lexis.`;
  }
  let out = `📎 Citation Lookup: ${result.citation}\n\n`;
  result.results.forEach((r, i) => {
    out += `${i + 1}. ${r.caseName}\n`;
    out += `   🏛️  ${r.court} | 📅 ${r.dateFiled}\n`;
    if (r.snippet) out += `   "${r.snippet}..."\n`;
    if (r.absoluteUrl) out += `   🔗 ${r.absoluteUrl}\n`;
    out += "\n";
  });
  return out;
}

// ============================================================
//  EXPORTS
// ============================================================
module.exports = {
  searchCaseLaw,
  lookupCitation,
  verifyCitation,
  getOpinionText,
  handleResearchCommand,
  isResearchCommand,
  CA_COURTS,
  PRACTICE_COURTS,
};
