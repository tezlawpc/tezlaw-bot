// ============================================================
//  statute-fetcher.js
//  Unified interface for fetching statutes & regulations from:
//    - California (leginfo.legislature.ca.gov - scraped)
//    - U.S. Code (Cornell LII deep-link)
//    - CFR (eCFR API - free, no key required)
//    - Federal Register (federalregister.gov - free, no key required)
//
//  All results are cached in research_cache table.
// ============================================================

const axios   = require("axios");
const cheerio = require("cheerio");
const db      = require("./db");

const TIMEOUT = 30000;
const DEFAULT_TTL = 24 * 7; // 7 days for statutes (rarely change)

// ============================================================
//  CACHE HELPERS
// ============================================================
async function _cacheGet(key) {
  try {
    const r = await db.query(
      `SELECT payload FROM research_cache
       WHERE cache_key = $1 AND expires_at > NOW()`,
      [key]
    );
    return r.rows[0]?.payload || null;
  } catch { return null; }
}

async function _cacheSet(key, source, payload, ttlHours = DEFAULT_TTL) {
  try {
    let payloadJson;
    try {
      payloadJson = JSON.stringify(payload, (_, v) =>
        typeof v === "bigint" ? v.toString() : (v === undefined ? null : v)
      );
    } catch { return; }

    await db.query(
      `INSERT INTO research_cache (cache_key, source, payload, expires_at)
       VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' hours')::interval)
       ON CONFLICT (cache_key) DO UPDATE
       SET payload = EXCLUDED.payload,
           fetched_at = NOW(), expires_at = EXCLUDED.expires_at, hit_count = 0`,
      [key, source, payloadJson, String(ttlHours)]
    );
  } catch (err) { /* non-fatal */ }
}

// ============================================================
//  CALIFORNIA CODES (leginfo.legislature.ca.gov)
//  Scraping pattern. No API. Updated weekly via bulk dump.
//
//  URL:
//    https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml
//      ?lawCode={CODE}&sectionNum={NUM}.
//
//  Codes (lawCode values):
//    BPC = Business & Professions
//    CCP = Code of Civil Procedure
//    CIV = Civil Code
//    COM = Commercial
//    CORP = Corporations
//    EDC = Education
//    ELEC = Elections
//    EVID = Evidence
//    FAM = Family
//    FIN = Financial
//    FGC = Fish & Game
//    FAC = Food & Agriculture
//    GOV = Government
//    HNC = Harbors & Navigation
//    HSC = Health & Safety
//    INS = Insurance
//    LAB = Labor
//    MVC = Military & Veterans
//    PEN = Penal
//    PRC = Public Resources
//    PUC = Public Utilities
//    RTC = Revenue & Taxation
//    SHC = Streets & Highways
//    UIC = Unemployment Insurance
//    VEH = Vehicle
//    WAT = Water
//    WIC = Welfare & Institutions
//    PROB = Probate
// ============================================================

const CA_CODES = {
  BPC: "Business and Professions Code",
  CCP: "Code of Civil Procedure",
  CIV: "Civil Code",
  COM: "Commercial Code",
  CORP: "Corporations Code",
  EDC: "Education Code",
  ELEC: "Elections Code",
  EVID: "Evidence Code",
  FAM: "Family Code",
  FIN: "Financial Code",
  FGC: "Fish and Game Code",
  FAC: "Food and Agricultural Code",
  GOV: "Government Code",
  HNC: "Harbors and Navigation Code",
  HSC: "Health and Safety Code",
  INS: "Insurance Code",
  LAB: "Labor Code",
  MVC: "Military and Veterans Code",
  PEN: "Penal Code",
  PRC: "Public Resources Code",
  PUC: "Public Utilities Code",
  RTC: "Revenue and Taxation Code",
  SHC: "Streets and Highways Code",
  UIC: "Unemployment Insurance Code",
  VEH: "Vehicle Code",
  WAT: "Water Code",
  WIC: "Welfare and Institutions Code",
  PROB: "Probate Code",
};

/**
 * Fetch a California statute section.
 * @param {string} code - e.g., "CCP", "CIV", "PEN"
 * @param {string} section - e.g., "335.1", "3342"
 * @returns {Object} { code, section, title, text, url, source }
 */
// Map CA code abbreviations to Justia URL slugs
const JUSTIA_CODE_SLUGS = {
  BPC:  "bpc",  // Business and Professions
  CCP:  "ccp",  // Code of Civil Procedure
  CIV:  "civ",  // Civil Code
  COM:  "com",  // Commercial
  CORP: "corp", // Corporations
  EDC:  "edc",  // Education
  ELEC: "elec", // Elections
  EVID: "evid", // Evidence
  FAM:  "fam",  // Family
  FIN:  "fin",  // Financial
  FGC:  "fgc",  // Fish & Game
  FAC:  "fac",  // Food & Agriculture
  GOV:  "gov",  // Government
  HNC:  "hnc",  // Harbors & Navigation
  HSC:  "hsc",  // Health & Safety
  INS:  "ins",  // Insurance
  LAB:  "lab",  // Labor
  MVC:  "mvc",  // Military & Veterans
  PEN:  "pen",  // Penal
  PRC:  "prc",  // Public Resources
  PUC:  "puc",  // Public Utilities
  RTC:  "rtc",  // Revenue & Taxation
  SHC:  "shc",  // Streets & Highways
  UIC:  "uic",  // Unemployment Insurance
  VEH:  "veh",  // Vehicle
  WAT:  "wat",  // Water
  WIC:  "wic",  // Welfare & Institutions
  PROB: "prob", // Probate
};

/**
 * Fetch a California statute section.
 *
 * Strategy: Try leginfo first (authoritative, current). If that fails or returns
 * empty content (some sections are JS-rendered and unreachable from server),
 * fall back to Justia mirror. Both URLs are returned so the UI can show both.
 *
 * @param {string} code - e.g., "CCP", "CIV", "PEN"
 * @param {string} section - e.g., "335.1", "3342"
 * @returns {Object} { code, section, title, text, breadcrumbs, url, official_url, source }
 */
async function getCaliforniaStatute(code, section) {
  code = code.toUpperCase().trim();
  section = String(section).trim();

  if (!CA_CODES[code]) {
    throw new Error(`Unknown CA code: ${code}. Valid codes: ${Object.keys(CA_CODES).join(", ")}`);
  }

  const cacheKey = `ca:${code}:${section}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const officialUrl = `https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=${code}&sectionNum=${section}.`;
  const justiaSlug  = JUSTIA_CODE_SLUGS[code];
  const justiaSection = section.replace(/\./g, "-");
  const justiaUrl   = `https://law.justia.com/codes/california/code-${justiaSlug}/section-${justiaSection}/`;

  // Try leginfo first
  try {
    const result = await _fetchFromLeginfo(officialUrl, code, section);
    if (result && result.text && result.text.length > 30) {
      result.url = officialUrl;
      result.official_url = officialUrl;
      result.justia_url = justiaUrl;
      await _cacheSet(cacheKey, "ca_leginfo", result);
      return result;
    }
  } catch (err) {
    console.warn(`[statute] leginfo failed for ${code} § ${section}: ${err.message}, trying Justia...`);
  }

  // Fall back to Justia
  try {
    const result = await _fetchFromJustia(justiaUrl, code, section);
    if (result && result.text && result.text.length > 30) {
      result.url = justiaUrl;
      result.official_url = officialUrl;
      result.justia_url = justiaUrl;
      result.note = "Text from Justia mirror. Verify against official URL for currency.";
      await _cacheSet(cacheKey, "ca_justia", result);
      return result;
    }
  } catch (err) {
    console.warn(`[statute] Justia also failed for ${code} § ${section}: ${err.message}`);
  }

  throw new Error(
    `Could not retrieve Cal. ${code} § ${section} from either leginfo or Justia. ` +
    `Section may not exist. Try the official URL: ${officialUrl}`
  );
}

/**
 * Strip breadcrumb / navigation noise from leginfo content.
 *
 * leginfo serves text inline (no newlines between breadcrumbs and statute text).
 * The breadcrumb chain always ends with a parenthetical like:
 *   "( Part 2 enacted 1872. )" or "( Chapter 3 added 1980. )"
 *
 * Strategy: greedy match from start of string to the LAST such parenthetical,
 * then strip everything matched. What remains is the actual statute text.
 *
 * Removes patterns like:
 *   "Code of Civil Procedure - CCP"
 *   "PART 2. OF CIVIL ACTIONS [307 - 1062.34] ( Part 2 enacted 1872. )"
 *   "TITLE 2. OF THE TIME OF COMMENCING CIVIL ACTIONS [312 - 366.3] ( Title 2 enacted 1872. )"
 *   "CHAPTER 3. The Time of Commencing Actions Other Than for the Recovery of Real Property [335 - 349.4] ( Chapter 3 enacted 1872. )"
 */
function _stripBreadcrumbs(text) {
  return text
    .replace(
      /^[\s\S]*\(\s*(?:Part|Title|Chapter|Division|Article|Subdivision)\s+\d+(?:\.\d+)?\s+(?:enacted|added|amended|repealed)[^)]*\)\s*/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the cleanest version of statute text from a list of candidate strings.
 * leginfo nests content in multiple divs that all contain overlapping text;
 * we want the SHORTEST one that still has the section number.
 */
function _pickCleanestText(candidates, section) {
  if (!candidates.length) return "";

  // Filter to ones containing section number
  const sectionEsc = section.replace(/\./g, "\\.");
  const sectionRx = new RegExp(`\\b${sectionEsc}\\b`);
  let withSection = candidates.filter(c => sectionRx.test(c));
  if (!withSection.length) withSection = candidates;

  // Sort by length ascending — shortest is usually the leaf
  withSection.sort((a, b) => a.length - b.length);

  // Pick the shortest one that's at least 30 chars (avoid super-short fragments)
  for (const c of withSection) {
    if (c.length >= 30) return c;
  }
  return withSection[0] || "";
}

async function _fetchFromLeginfo(url, code, section) {
  const r = await axios.get(url, {
    timeout: TIMEOUT,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const $ = cheerio.load(r.data);

  // leginfo has multiple possible content containers across pages
  const SELECTORS = [
    "#codeLawSectionNoHead",
    "#manylawsections",
    "#displayCodeSection",
    "#codeLawSectionHead",
    "div[id*='lawSection']",
    "div[class*='lawsection']",
  ];

  // Collect text from each matching selector
  const candidates = [];
  let usedSelector = null;
  for (const sel of SELECTORS) {
    $(sel).each((i, el) => {
      const t = $(el).text().trim().replace(/\s+/g, " ");
      if (t.length > 30) {
        candidates.push(t);
        if (!usedSelector) usedSelector = sel;
      }
    });
    if (candidates.length) break;
  }

  if (!candidates.length) {
    throw new Error("No content found at leginfo selectors");
  }

  // Pick the cleanest (shortest matching) candidate
  let text = _pickCleanestText(candidates, section);
  text = _stripBreadcrumbs(text);

  // Extract breadcrumbs separately from longer candidates
  let breadcrumbs = null;
  const longestCandidate = candidates.sort((a, b) => b.length - a.length)[0];
  const partMatch = longestCandidate.match(/(PART\s+\d+[^[]+\[[^\]]+\][^()]*\([^)]+\))/);
  const titleMatch = longestCandidate.match(/(TITLE\s+\d+[^[]+\[[^\]]+\][^()]*\([^)]+\))/);
  const chapterMatch = longestCandidate.match(/(CHAPTER\s+\d+[^[]+\[[^\]]+\][^()]*\([^)]+\))/);
  if (partMatch || titleMatch || chapterMatch) {
    breadcrumbs = [partMatch?.[1], titleMatch?.[1], chapterMatch?.[1]].filter(Boolean).join(" › ");
  }

  return {
    code,
    code_name:     CA_CODES[code],
    section,
    title:         `Cal. ${CA_CODES[code]} § ${section}`,
    text:          text.substring(0, 50000),
    breadcrumbs,
    source:        "leginfo.legislature.ca.gov",
    selector_used: usedSelector,
    fetched_at:    new Date().toISOString(),
  };
}

async function _fetchFromJustia(url, code, section) {
  const r = await axios.get(url, {
    timeout: TIMEOUT,
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const $ = cheerio.load(r.data);

  const title = $("h1").first().text().trim() || `Cal. ${CA_CODES[code]} § ${section}`;

  const SELECTORS = [
    ".codes-content",
    "article.codes-content",
    "#codes-content",
    "article p",
  ];

  let text = "";
  let usedSelector = null;
  for (const sel of SELECTORS) {
    const $content = $(sel);
    if ($content.length) {
      const paragraphs = $content.find("p").length
        ? $content.find("p").map((i, el) => $(el).text().trim().replace(/\s+/g, " ")).get()
        : [$content.text().trim().replace(/\s+/g, " ")];

      const seen = new Set();
      text = paragraphs.filter(p => {
        if (!p || p.length < 5 || seen.has(p)) return false;
        seen.add(p);
        return true;
      }).join("\n\n");

      if (text.length > 30) {
        usedSelector = sel;
        break;
      }
    }
  }

  if (!text || text.length < 30) {
    throw new Error("No content found at Justia selectors");
  }

  return {
    code,
    code_name:     CA_CODES[code],
    section,
    title,
    text:          text.substring(0, 50000),
    breadcrumbs:   null,
    source:        "law.justia.com",
    selector_used: usedSelector,
    fetched_at:    new Date().toISOString(),
  };
}

// ============================================================
//  U.S. CODE (Cornell LII deep-link + structure)
//  We don't scrape Cornell — we generate the citation, deep-link,
//  and then the UI loads Cornell in an iframe or lets user click.
// ============================================================

/**
 * Build a Cornell LII URL for a USC section.
 * @param {number|string} title - USC title, e.g., 8, 28, 42
 * @param {string} section - USC section, e.g., "1158", "1983"
 */
function getUSCUrl(title, section) {
  return `https://www.law.cornell.edu/uscode/text/${title}/${section}`;
}

/**
 * Fetch USC section text from govinfo.gov USCODE collection.
 * Requires GOVINFO_API_KEY env var (free at api.data.gov).
 *
 * If no API key, falls back to building Cornell LII URL only.
 */
async function getUSC(title, section) {
  title = String(title).trim();
  section = String(section).trim();
  const cacheKey = `usc:${title}:${section}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.GOVINFO_API_KEY;
  const cornellUrl = getUSCUrl(title, section);

  if (!apiKey) {
    return {
      title:    `${title} U.S.C. § ${section}`,
      cornell_url: cornellUrl,
      source:   "cornell-link-only",
      note:     "Set GOVINFO_API_KEY env var for full text retrieval",
    };
  }

  try {
    // govinfo USCODE collection — packageId pattern: USCODE-{year}-title{N}-section{X}
    // Try current year first
    const year = new Date().getFullYear();
    const packageId = `USCODE-${year - 1}-title${title}-section${section}`;
    const summaryUrl = `https://api.govinfo.gov/packages/${packageId}/summary?api_key=${apiKey}`;

    const r = await axios.get(summaryUrl, { timeout: TIMEOUT });
    const result = {
      title:        `${title} U.S.C. § ${section}`,
      package_id:   packageId,
      cornell_url:  cornellUrl,
      govinfo_url:  r.data.detailsLink,
      pdf_url:      r.data.download?.pdfLink,
      title_text:   r.data.title,
      last_modified: r.data.lastModified,
      source:       "govinfo",
    };
    await _cacheSet(cacheKey, "govinfo_usc", result, 24 * 30);
    return result;
  } catch (err) {
    return {
      title:    `${title} U.S.C. § ${section}`,
      cornell_url: cornellUrl,
      source:   "cornell-link-only",
      error:    err.message,
    };
  }
}

// ============================================================
//  CFR (Code of Federal Regulations) via eCFR API
//  Free, keyless. Updated daily. Most useful for 8 CFR (immigration).
// ============================================================

/**
 * Get a CFR section as XML/text.
 * @param {string} title - e.g., "8" for immigration regs
 * @param {string} part - e.g., "208" for asylum
 * @param {string} section - e.g., "208.13" (optional)
 * @param {string} date - YYYY-MM-DD (optional, defaults to today)
 */
async function getCFR(title, part, section = null, date = null) {
  title = String(title).trim();
  part = String(part).trim();
  const today = date || new Date().toISOString().substring(0, 10);

  const cacheKey = `cfr:${title}:${part}:${section || "all"}:${today}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  // eCFR Versioner API:
  //   /api/versioner/v1/full/{date}/title-{title}.xml?part={part}
  const url = `https://www.ecfr.gov/api/versioner/v1/full/${today}/title-${title}.xml`;
  const params = { part };
  if (section) params.section = section;

  try {
    const r = await axios.get(url, {
      params,
      timeout: TIMEOUT,
      headers: { Accept: "application/xml" },
    });

    const result = {
      title:    `${title} C.F.R. § ${part}${section ? "." + section : ""}`,
      cfr_title: title,
      part,
      section,
      date_fetched: today,
      xml:      r.data,
      url:      `https://www.ecfr.gov/current/title-${title}/part-${part}${section ? "/section-" + section : ""}`,
      source:   "ecfr.gov",
    };
    await _cacheSet(cacheKey, "ecfr", result, 24); // 1-day cache (eCFR updates daily)
    return result;
  } catch (err) {
    throw new Error(`Failed to fetch ${title} C.F.R. § ${part}: ${err.message}`);
  }
}

/**
 * Get the eCFR table of contents structure for a title.
 * Useful for browsing.
 */
async function getCFRStructure(title, date = null) {
  title = String(title).trim();
  const today = date || new Date().toISOString().substring(0, 10);
  const cacheKey = `cfr:struct:${title}:${today}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const url = `https://www.ecfr.gov/api/versioner/v1/structure/${today}/title-${title}.json`;
  try {
    const r = await axios.get(url, { timeout: TIMEOUT });
    await _cacheSet(cacheKey, "ecfr_structure", r.data, 24);
    return r.data;
  } catch (err) {
    throw new Error(`Failed to fetch CFR title ${title} structure: ${err.message}`);
  }
}

// ============================================================
//  FEDERAL REGISTER
//  Free, keyless. For tracking proposed rules, immigration policy, etc.
// ============================================================

/**
 * Search the Federal Register.
 * @param {Object} opts
 *   query       — search term
 *   agency      — e.g., 'us-citizenship-and-immigration-services'
 *   type        — 'RULE', 'PRORULE', 'NOTICE', 'PRESDOCU'
 *   from        — YYYY-MM-DD
 *   to          — YYYY-MM-DD
 *   page        — 1
 *   per_page    — 20 (max 1000)
 */
async function searchFederalRegister(opts = {}) {
  const params = {
    "conditions[term]":         opts.query,
    "conditions[agencies][]":   opts.agency,
    "conditions[type][]":       opts.type,
    "conditions[publication_date][gte]": opts.from,
    "conditions[publication_date][lte]": opts.to,
    page:                       opts.page || 1,
    per_page:                   opts.per_page || 20,
  };
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([_, v]) => v !== undefined && v !== null)
  );

  const cacheKey = `fr:search:${JSON.stringify(cleanParams)}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const r = await axios.get("https://www.federalregister.gov/api/v1/documents.json", {
      params: cleanParams,
      timeout: TIMEOUT,
    });
    await _cacheSet(cacheKey, "federalregister", r.data, 6);
    return r.data;
  } catch (err) {
    throw new Error(`Federal Register search failed: ${err.message}`);
  }
}

// ============================================================
//  EXPORTS
// ============================================================
module.exports = {
  // California
  CA_CODES,
  getCaliforniaStatute,

  // U.S. Code
  getUSCUrl,
  getUSC,

  // CFR
  getCFR,
  getCFRStructure,

  // Federal Register
  searchFederalRegister,
};
