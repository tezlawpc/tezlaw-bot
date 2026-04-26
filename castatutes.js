// ============================================================
//  castatutes.js — California Statute Lookup
//  Source: leginfo.legislature.ca.gov (official, public domain)
//  Gov. Code §10248.5 — no copyright, free to use
//
//  FEATURES:
//  - Look up any CA code section by number (CCP §430.10, etc.)
//  - Search statutes by keyword across all codes
//  - Built-in reference index for most-used sections
//  - Works in Zara JJ mode chat + web dashboard
//
//  USAGE IN JJ MODE:
//  "statute CCP 430.10"
//  "look up Civil Code 1710"
//  "what does CCP 437c say"
//  "statute of limitations personal injury"
// ============================================================

const axios = require("axios");

// ── CA Code abbreviations → leginfo lawCode values ───────────
const CODE_MAP = {
  // Common abbreviations JJ might type
  "ccp":      "CCP",   // Code of Civil Procedure
  "cc":       "CIV",   // Civil Code
  "civ":      "CIV",   // Civil Code
  "civil":    "CIV",
  "fam":      "FAM",   // Family Code
  "family":   "FAM",
  "prob":     "PROB",  // Probate Code
  "probate":  "PROB",
  "bus":      "BPC",   // Business & Professions Code
  "bpc":      "BPC",
  "corp":     "CORP",  // Corporations Code
  "evid":     "EVID",  // Evidence Code
  "evidence": "EVID",
  "gov":      "GOV",   // Government Code
  "govt":     "GOV",
  "hsc":      "HSC",   // Health & Safety Code
  "health":   "HSC",
  "ins":      "INS",   // Insurance Code
  "lab":      "LAB",   // Labor Code
  "labor":    "LAB",
  "pen":      "PEN",   // Penal Code
  "penal":    "PEN",
  "rev":      "RTC",   // Revenue & Taxation Code
  "rtc":      "RTC",
  "sts":      "STS",   // Streets & Highways Code
  "uic":      "UIC",   // Unemployment Insurance Code
  "veh":      "VEH",   // Vehicle Code
  "vehicle":  "VEH",
  "wat":      "WAT",   // Water Code
  "wic":      "WIC",   // Welfare & Institutions Code
};

const CODE_FULL_NAMES = {
  CCP:  "Code of Civil Procedure",
  CIV:  "Civil Code",
  FAM:  "Family Code",
  PROB: "Probate Code",
  BPC:  "Business & Professions Code",
  CORP: "Corporations Code",
  EVID: "Evidence Code",
  GOV:  "Government Code",
  HSC:  "Health & Safety Code",
  INS:  "Insurance Code",
  LAB:  "Labor Code",
  PEN:  "Penal Code",
  RTC:  "Revenue & Taxation Code",
  VEH:  "Vehicle Code",
  WIC:  "Welfare & Institutions Code",
};

// ── Built-in reference index — most-used sections ────────────
// JJ can ask "what's the statute for demurrer" and get this
const STATUTE_INDEX = {
  // ── CCP — Civil Procedure ──────────────────────────────────
  "demurrer":                    [{ code: "CCP", section: "430.10" }, { code: "CCP", section: "430.40" }, { code: "CCP", section: "430.41" }],
  "motion to strike":            [{ code: "CCP", section: "435" },   { code: "CCP", section: "436" }],
  "answer":                      [{ code: "CCP", section: "431.30" }],
  "complaint":                   [{ code: "CCP", section: "425.10" }],
  "amended complaint":           [{ code: "CCP", section: "471.5" }],
  "fac":                         [{ code: "CCP", section: "471.5" }],
  "meet and confer":             [{ code: "CCP", section: "430.41" }],
  "civ-141":                     [{ code: "CCP", section: "430.41" }],
  "summary judgment":            [{ code: "CCP", section: "437c" }],
  "msj":                         [{ code: "CCP", section: "437c" }],
  "discovery":                   [{ code: "CCP", section: "2016.010" }],
  "interrogatories":             [{ code: "CCP", section: "2030.010" }, { code: "CCP", section: "2030.260" }],
  "requests for production":     [{ code: "CCP", section: "2031.010" }, { code: "CCP", section: "2031.260" }],
  "rfp":                         [{ code: "CCP", section: "2031.010" }, { code: "CCP", section: "2031.260" }],
  "rfa":                         [{ code: "CCP", section: "2033.010" }],
  "request for admissions":      [{ code: "CCP", section: "2033.010" }],
  "deposition":                  [{ code: "CCP", section: "2025.010" }],
  "motion to compel":            [{ code: "CCP", section: "2030.300" }, { code: "CCP", section: "2031.310" }],
  "sanctions":                   [{ code: "CCP", section: "128.5" },  { code: "CCP", section: "2023.010" }],
  "service of process":          [{ code: "CCP", section: "415.10" }],
  "electronic service":          [{ code: "CCP", section: "1010.6" }],
  "email service":               [{ code: "CCP", section: "1010.6" }],
  "statute of limitations":      [{ code: "CCP", section: "335.1" },  { code: "CCP", section: "337" }, { code: "CCP", section: "338" }],
  "sol":                         [{ code: "CCP", section: "335.1" }],
  "personal injury sol":         [{ code: "CCP", section: "335.1" }],
  "contract sol":                [{ code: "CCP", section: "337" },    { code: "CCP", section: "339" }],
  "fraud sol":                   [{ code: "CCP", section: "338" }],
  "default":                     [{ code: "CCP", section: "585" }],
  "default judgment":            [{ code: "CCP", section: "585" }],
  "anti-slapp":                  [{ code: "CCP", section: "425.16" }],
  "slapp":                       [{ code: "CCP", section: "425.16" }],
  "preliminary injunction":      [{ code: "CCP", section: "526" }],
  "tro":                         [{ code: "CCP", section: "527" }],
  "temporary restraining order": [{ code: "CCP", section: "527" }],
  "appeal":                      [{ code: "CCP", section: "904.1" }],
  "notice of appeal":            [{ code: "CCP", section: "904.1" }],
  "judgment":                    [{ code: "CCP", section: "664.6" }],
  "attorneys fees":              [{ code: "CCP", section: "1021" },   { code: "CIV", section: "1717" }],
  "costs":                       [{ code: "CCP", section: "1032" },   { code: "CCP", section: "1033.5" }],
  "jury trial":                  [{ code: "CCP", section: "592" }],
  "jury fee":                    [{ code: "CCP", section: "631" }],
  "expert witness":              [{ code: "CCP", section: "2034.010" }],
  "expert exchange":             [{ code: "CCP", section: "2034.230" }],
  "trial continuance":           [{ code: "CCP", section: "595.2" }],

  // ── Eviction / UD ─────────────────────────────────────────
  "unlawful detainer":           [{ code: "CCP", section: "1161" },   { code: "CCP", section: "1167" }],
  "ud":                          [{ code: "CCP", section: "1161" }],
  "3-day notice":                [{ code: "CCP", section: "1161" }],
  "30-day notice":               [{ code: "CCP", section: "1946" }],
  "60-day notice":               [{ code: "CCP", section: "1946.1" }],
  "eviction notice":             [{ code: "CCP", section: "1161" },   { code: "CIV", section: "1946" }],
  "just cause eviction":         [{ code: "CIV", section: "1946.2" }],
  "ab 1482":                     [{ code: "CIV", section: "1946.2" }, { code: "CIV", section: "1947.12" }],
  "rent control":                [{ code: "CIV", section: "1947.12" }],
  "security deposit":            [{ code: "CIV", section: "1950.5" }],
  "habitability":                [{ code: "CIV", section: "1941" },   { code: "CIV", section: "1941.1" }],
  "warranty of habitability":    [{ code: "CIV", section: "1941" }],
  "retaliatory eviction":        [{ code: "CIV", section: "1942.5" }],

  // ── Civil Code — Contracts/Torts ───────────────────────────
  "breach of contract":          [{ code: "CIV", section: "1550" },   { code: "CIV", section: "3300" }],
  "contract formation":          [{ code: "CIV", section: "1550" }],
  "offer acceptance":            [{ code: "CIV", section: "1550" }],
  "consideration":               [{ code: "CIV", section: "1605" }],
  "fraud":                       [{ code: "CIV", section: "1709" },   { code: "CIV", section: "1710" }],
  "misrepresentation":           [{ code: "CIV", section: "1710" }],
  "negligence":                  [{ code: "CIV", section: "1714" }],
  "comparative negligence":      [{ code: "CIV", section: "1714" }],
  "damages":                     [{ code: "CIV", section: "3281" },   { code: "CIV", section: "3300" }],
  "punitive damages":            [{ code: "CIV", section: "3294" }],
  "emotional distress":          [{ code: "CIV", section: "1708.5" }],
  "defamation":                  [{ code: "CIV", section: "44" },     { code: "CIV", section: "45" }],
  "libel":                       [{ code: "CIV", section: "45" }],
  "slander":                     [{ code: "CIV", section: "46" }],
  "intentional tort":            [{ code: "CIV", section: "1708" }],
  "conversion":                  [{ code: "CIV", section: "3336" }],
  "trespass":                    [{ code: "CIV", section: "1714" }],
  "nuisance":                    [{ code: "CIV", section: "3479" }],
  "non-compete":                 [{ code: "BPC", section: "16600" }],
  "noncompete":                  [{ code: "BPC", section: "16600" }],
  "trade secret":                [{ code: "CIV", section: "3426" }],
  "arbitration":                 [{ code: "CCP", section: "1281" },   { code: "CCP", section: "1281.2" }],

  // ── Personal Injury ───────────────────────────────────────
  "pi":                          [{ code: "CCP", section: "335.1" },  { code: "CIV", section: "1714" }],
  "car accident":                [{ code: "CCP", section: "335.1" },  { code: "VEH", section: "17150" }],
  "government claim":            [{ code: "GOV", section: "911.2" },  { code: "GOV", section: "945.4" }],
  "govt tort claim":             [{ code: "GOV", section: "911.2" }],
  "6 month deadline":            [{ code: "GOV", section: "911.2" }],

  // ── Estate Planning ───────────────────────────────────────
  "living trust":                [{ code: "PROB", section: "15200" }],
  "revocable trust":             [{ code: "PROB", section: "15400" }],
  "will":                        [{ code: "PROB", section: "6100" }],
  "probate":                     [{ code: "PROB", section: "7000" }],
  "probate threshold":           [{ code: "PROB", section: "13100" }],
  "small estate":                [{ code: "PROB", section: "13100" }],
  "power of attorney":           [{ code: "PROB", section: "4000" }],
  "durable poa":                 [{ code: "PROB", section: "4124" }],
  "advance directive":           [{ code: "PROB", section: "4700" }],
  "conservatorship":             [{ code: "PROB", section: "1800" }],
  "prop 19":                     [{ code: "RTC", section: "69" },     { code: "RTC", section: "2.1" }],

  // ── Family Law ────────────────────────────────────────────
  "divorce":                     [{ code: "FAM", section: "2310" }],
  "dissolution":                 [{ code: "FAM", section: "2310" }],
  "child support":               [{ code: "FAM", section: "4053" }],
  "spousal support":             [{ code: "FAM", section: "4320" }],
  "alimony":                     [{ code: "FAM", section: "4320" }],
  "custody":                     [{ code: "FAM", section: "3011" }],
  "child custody":               [{ code: "FAM", section: "3011" }],
  "domestic violence":           [{ code: "FAM", section: "6200" }],
  "dvro":                        [{ code: "FAM", section: "6200" }],
};

// ============================================================
//  FETCH A SPECIFIC STATUTE SECTION
//  Scrapes leginfo.legislature.ca.gov — public domain content
// ============================================================
async function fetchStatuteSection(lawCode, sectionNum) {
  // Normalize section number — leginfo requires trailing period
  const normalizedSection = sectionNum.endsWith(".")
    ? sectionNum
    : sectionNum + ".";

  const url = `https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=${lawCode}&sectionNum=${encodeURIComponent(normalizedSection)}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TezLaw-Zara/1.0; legal research bot)",
        "Accept": "text/html",
      },
      timeout: 12000,
    });

    const html = resp.data;

    // Extract section text from leginfo HTML
    // The statute text is inside <div id="codeLawSectionNoClass"> or similar
    let text = "";

    // Primary extraction — statute body
    const bodyMatch = html.match(/<div[^>]*id="codeLawSectionNoClass"[^>]*>([\s\S]*?)<\/div>/i) ||
                      html.match(/<div[^>]*class="[^"]*lawText[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    if (bodyMatch) {
      text = bodyMatch[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<p[^>]*>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n))
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    // Extract section heading
    const headingMatch = html.match(/<div[^>]*id="codeLawSectionNoClassHeading"[^>]*>([\s\S]*?)<\/div>/i);
    const heading = headingMatch
      ? headingMatch[1].replace(/<[^>]+>/g, "").trim()
      : `${CODE_FULL_NAMES[lawCode] || lawCode} §${sectionNum}`;

    if (!text) {
      // Try broader extraction if specific divs not found
      const altMatch = html.match(/§\s*[\d.]+[\s\S]{0,5000}/);
      if (altMatch) {
        text = altMatch[0]
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 3000);
      }
    }

    if (!text || text.length < 10) {
      return {
        found:   false,
        lawCode,
        section: sectionNum,
        url,
        error:   "Section text could not be extracted. The section may not exist or leginfo formatting changed.",
      };
    }

    return {
      found:    true,
      lawCode,
      codeName: CODE_FULL_NAMES[lawCode] || lawCode,
      section:  sectionNum,
      heading,
      text:     text.substring(0, 4000),
      url,
    };

  } catch (err) {
    console.error(`[castatutes] Fetch error ${lawCode} §${sectionNum}:`, err.message);
    return {
      found:   false,
      lawCode,
      section: sectionNum,
      url,
      error:   `Could not fetch statute: ${err.message}`,
    };
  }
}

// ============================================================
//  SEARCH BY KEYWORD — uses built-in index
// ============================================================
async function searchStatutes(keyword) {
  const k = keyword.toLowerCase().trim();

  // Find matching topics in index
  const matches = Object.entries(STATUTE_INDEX)
    .filter(([topic]) => topic.includes(k) || k.includes(topic) || k.split(" ").some(w => w.length > 3 && topic.includes(w)))
    .slice(0, 4);

  if (matches.length === 0) {
    return { found: false, keyword, message: `No statute index matches for "${keyword}". Try a specific section like "CCP 430.10" or a term like "demurrer", "damages", "unlawful detainer".` };
  }

  // Fetch top matched sections
  const results = [];
  const seen = new Set();

  for (const [topic, sections] of matches) {
    for (const { code, section } of sections.slice(0, 2)) {
      const key = `${code}-${section}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await fetchStatuteSection(code, section);
      results.push({ topic, ...result });
      if (results.length >= 4) break;
    }
    if (results.length >= 4) break;
  }

  return { found: true, keyword, results };
}

// ============================================================
//  PARSE JJ'S MESSAGE FOR STATUTE REFERENCES
//  Detects patterns like "CCP 430.10", "Civil Code 1710", etc.
// ============================================================
function parseStatuteReference(message) {
  const m = message.trim();

  // Pattern 1: "CCP 430.10" or "CCP §430.10" or "CCP section 430.10"
  const pattern1 = m.match(/\b([A-Za-z]{2,6})\s*(?:§|section|sec\.?)?\s*(\d+(?:\.\d+)?[a-z]?)\b/i);

  // Pattern 2: "Code of Civil Procedure 430.10"
  const pattern2 = m.match(/\b(code of civil procedure|civil code|family code|probate code|evidence code|penal code|vehicle code|government code|labor code|business.*professions)\s*(?:§|section|sec\.?)?\s*(\d+(?:\.\d+)?[a-z]?)\b/i);

  if (pattern2) {
    const codeKey = pattern2[1].toLowerCase()
      .replace("code of civil procedure", "ccp")
      .replace("civil code", "civ")
      .replace("family code", "fam")
      .replace("probate code", "prob")
      .replace("evidence code", "evid")
      .replace("penal code", "pen")
      .replace("vehicle code", "veh")
      .replace("government code", "gov")
      .replace("labor code", "lab")
      .replace(/business.*professions/, "bpc");
    const lawCode = CODE_MAP[codeKey];
    if (lawCode) return { lawCode, section: pattern2[2] };
  }

  if (pattern1) {
    const codeKey = pattern1[1].toLowerCase();
    const lawCode = CODE_MAP[codeKey];
    if (lawCode) return { lawCode, section: pattern1[2] };
  }

  return null;
}

// ============================================================
//  TRIGGER DETECTION
// ============================================================
function isStatuteCommand(message) {
  const m = message.toLowerCase();

  // Explicit statute lookup commands
  if (/^(statute|look up statute|what does|what is|ccp|civil code|fam|prob|evid|pen|veh|gov|lab|bpc)\s/i.test(message)) return true;

  // Section reference pattern
  if (parseStatuteReference(message)) return true;

  // Keyword search for statute
  if (/\b(what statute|which statute|find statute|statute for|code section|what section|look up code|search statute)\b/i.test(m)) return true;

  return false;
}

// ============================================================
//  MAIN HANDLER — called from jj-mode.js
// ============================================================
async function handleStatuteCommand(message) {
  const m = message.toLowerCase().trim();

  // ── Direct section lookup ─────────────────────────────────
  const ref = parseStatuteReference(message);
  if (ref) {
    const result = await fetchStatuteSection(ref.lawCode, ref.section);
    return formatStatuteResult(result);
  }

  // ── Keyword search ────────────────────────────────────────
  // Strip command words
  const keyword = message
    .replace(/^(statute|look up statute|what does|what is|find statute|statute for|what statute|which statute|code section for|search statute|what section covers?)\s*/i, "")
    .replace(/\s*(say|mean|cover|provide|require|allow|state|define)\??$/i, "")
    .trim();

  if (!keyword || keyword.length < 2) {
    return formatStatuteHelp();
  }

  const result = await searchStatutes(keyword);
  if (!result.found) return result.message + "\n\n" + formatStatuteHelp();

  return formatSearchResults(result);
}

// ============================================================
//  FORMATTERS
// ============================================================
function formatStatuteResult(r) {
  if (!r.found) {
    return `❌ ${r.lawCode} §${r.section} — Not found\n\n${r.error}\n\n🔗 Check directly: ${r.url}`;
  }

  return [
    `📚 ${r.codeName} §${r.section}`,
    r.heading !== `${r.codeName} §${r.section}` ? `${r.heading}` : "",
    `${"─".repeat(50)}`,
    r.text,
    `${"─".repeat(50)}`,
    `🔗 Official source: ${r.url}`,
    `⚠️  Always verify current text before filing — statutes are amended annually.`,
  ].filter(Boolean).join("\n");
}

function formatSearchResults(r) {
  let out = `📚 Statute Search: "${r.keyword}"\n`;
  out    += `Found ${r.results.length} relevant section(s)\n`;
  out    += `${"─".repeat(50)}\n\n`;

  for (const res of r.results) {
    if (!res.found) continue;
    out += `📌 ${res.codeName} §${res.section}`;
    if (res.topic) out += ` (re: ${res.topic})`;
    out += "\n";
    out += res.text.substring(0, 500);
    if (res.text.length > 500) out += "...";
    out += `\n🔗 ${res.url}\n\n`;
  }

  out += `⚠️  Verify current text in leginfo.legislature.ca.gov before filing.`;
  return out;
}

function formatStatuteHelp() {
  return `
📚 CA Statute Lookup — Usage Examples:

Direct lookup:
  "CCP 430.10" — demurrer grounds
  "Civil Code 1710" — fraud/misrepresentation
  "CCP §437c" — summary judgment
  "Probate Code 15200" — living trusts
  "Family Code 4320" — spousal support factors

Keyword search:
  "statute demurrer"
  "statute unlawful detainer"
  "statute personal injury sol"
  "statute non-compete"
  "statute punitive damages"

Supported codes: CCP, Civil Code (CIV), Family Code (FAM),
Probate Code (PROB), Evidence Code (EVID), Business &
Professions Code (BPC), Government Code (GOV), Labor Code
(LAB), Penal Code (PEN), Vehicle Code (VEH)`.trim();
}

// ── Get statute URL for direct link (used by dashboard) ──────
function getStatuteUrl(lawCode, sectionNum) {
  const normalized = sectionNum.endsWith(".") ? sectionNum : sectionNum + ".";
  return `https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=${lawCode}&sectionNum=${encodeURIComponent(normalized)}`;
}

module.exports = {
  fetchStatuteSection,
  searchStatutes,
  parseStatuteReference,
  isStatuteCommand,
  handleStatuteCommand,
  getStatuteUrl,
  STATUTE_INDEX,
  CODE_MAP,
  CODE_FULL_NAMES,
};
