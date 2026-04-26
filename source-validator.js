// ============================================================
//  source-validator.js — Source Credibility Filter
//  Tez Law P.C. | Four layers of validation for all case law
//
//  LAYER 1 — Document type whitelist
//    Only published opinions — never RECAP uploads, briefs,
//    motions, dockets, or other non-opinion documents
//
//  LAYER 2 — Precedential status check
//    CourtListener precedential_status field must be
//    "Published" — blocks unpublished/non-precedential memos
//
//  LAYER 3 — Court whitelist
//    Only courts that produce binding or persuasive authority
//    for CA practice — no stray out-of-jurisdiction opinions
//
//  LAYER 4 — Citation format validator
//    Before caching any answer containing a citation string,
//    validate it matches known reporter formats to prevent
//    hallucinated citations entering the answer cache
//
//  USAGE:
//    const { validateOpinion, validateCitation, TRUSTED_COURTS } = require("./source-validator");
//    const result = validateOpinion(rawOpinion);
//    if (!result.valid) { skip; }
//    const cite = validateCitation("45 Cal.3d 678");
// ============================================================

// ============================================================
//  LAYER 3 — TRUSTED COURT WHITELIST
//  Keyed by CourtListener court_id
//  Only these courts produce authority relevant to TEZ Law practice
// ============================================================
const TRUSTED_COURTS = {
  // ── California State Courts ──────────────────────────────
  cal:            { name: "California Supreme Court",        binding: true,  jurisdiction: "state" },
  calctapp_1st:   { name: "CA Court of Appeal 1st District", binding: true,  jurisdiction: "state" },
  calctapp_2nd:   { name: "CA Court of Appeal 2nd District", binding: true,  jurisdiction: "state" },
  calctapp_3rd:   { name: "CA Court of Appeal 3rd District", binding: true,  jurisdiction: "state" },
  calctapp_4th:   { name: "CA Court of Appeal 4th District", binding: true,  jurisdiction: "state" },
  calctapp_5th:   { name: "CA Court of Appeal 5th District", binding: true,  jurisdiction: "state" },
  calctapp_6th:   { name: "CA Court of Appeal 6th District", binding: true,  jurisdiction: "state" },
  // ── Federal Appellate ────────────────────────────────────
  ca9:            { name: "9th Circuit Court of Appeals",    binding: true,  jurisdiction: "federal" },
  scotus:         { name: "U.S. Supreme Court",              binding: true,  jurisdiction: "federal" },
  // ── CA Federal Districts ─────────────────────────────────
  cacd:           { name: "C.D. California",                 binding: false, jurisdiction: "federal" },
  caed:           { name: "E.D. California",                 binding: false, jurisdiction: "federal" },
  cand:           { name: "N.D. California",                 binding: false, jurisdiction: "federal" },
  casd:           { name: "S.D. California",                 binding: false, jurisdiction: "federal" },
  // ── Immigration Courts ───────────────────────────────────
  bia:            { name: "Board of Immigration Appeals",    binding: true,  jurisdiction: "immigration" },
  ag:             { name: "U.S. Attorney General",           binding: true,  jurisdiction: "immigration" },
};

const TRUSTED_COURT_IDS = new Set(Object.keys(TRUSTED_COURTS));

// Courts that produce BINDING authority for CA practice
const BINDING_COURT_IDS = new Set(
  Object.entries(TRUSTED_COURTS)
    .filter(([, v]) => v.binding)
    .map(([k]) => k)
);

// ============================================================
//  LAYER 1 & 2 — DOCUMENT TYPE + PRECEDENTIAL STATUS
// ============================================================

// CourtListener precedential_status values we accept
const VALID_PRECEDENTIAL = new Set([
  "Published",
  "Precedential",     // some courts use this label
  "Reported",         // some state courts
]);

// CourtListener type values we accept (only full opinions)
const VALID_DOC_TYPES = new Set([
  "010combined",      // combined opinion (most common)
  "020lead",          // lead opinion
  "030concurrence",   // concurring (secondary but real opinion)
  "040dissent",       // dissent (real opinion text)
  "050addendum",      // addendum to opinion
]);

// RECAP document types to explicitly reject
const REJECTED_DOC_TYPES = new Set([
  "060recapping",     // RECAP uploaded filing
  "070erratum",       // correction notice
  "080remittitur",    // administrative
  "090mandamus",      // some uses are non-precedential
  "100unknown",       // unknown type = untrustworthy
]);

// ============================================================
//  LAYER 4 — CITATION FORMAT VALIDATOR
//  Known reporter patterns for courts Zara uses
// ============================================================
const CITATION_PATTERNS = [
  // California State
  { pattern: /\d+\s+Cal\.\s*(?:App\.)?\s*(?:\d+[a-z]+)?\s*\d+/i,  court: "CA State",    example: "45 Cal.3d 678" },
  { pattern: /\d+\s+Cal\.\s*(?:App\.\s*)?(?:3d|4th|5th|2d|1st)\s*\d+/i, court: "CA State", example: "230 Cal.App.4th 1234" },
  { pattern: /\d+\s+Cal\.\s*Rptr\.\s*(?:\d+[a-z]+)?\s*\d+/i,       court: "CA State",    example: "45 Cal.Rptr.3d 789" },
  // 9th Circuit
  { pattern: /\d+\s+F\.\s*(?:\d+[a-z]+)\s*\d+/i,                    court: "9th Circuit", example: "45 F.4th 123" },
  { pattern: /\d+\s+F\.3d\s*\d+/i,                                   court: "9th Circuit", example: "45 F.3d 123" },
  { pattern: /\d+\s+F\.2d\s*\d+/i,                                   court: "9th Circuit", example: "45 F.2d 123" },
  // Federal District
  { pattern: /\d+\s+F\.\s*Supp\.\s*(?:\d+[a-z]+)?\s*\d+/i,          court: "Federal",     example: "123 F.Supp.3d 456" },
  // Supreme Court
  { pattern: /\d+\s+U\.S\.\s*\d+/i,                                  court: "SCOTUS",      example: "410 U.S. 113" },
  { pattern: /\d+\s+S\.\s*Ct\.\s*\d+/i,                              court: "SCOTUS",      example: "143 S.Ct. 1231" },
  // BIA / Immigration
  { pattern: /\d+\s+I&N\s+Dec\.\s*\d+/i,                             court: "BIA",         example: "28 I&N Dec. 123" },
  { pattern: /\d+\s+I\.\s*&\s*N\.\s*Dec\.\s*\d+/i,                   court: "BIA",         example: "28 I. & N. Dec. 123" },
  // Westlaw neutral citations
  { pattern: /\d{4}\s+WL\s+\d+/i,                                    court: "Westlaw",     example: "2024 WL 12345" },
  // Slip opinion / docket reference (weak — flag as unverified)
  { pattern: /No\.\s+\d{2}-\d+/i,                                    court: "Docket",      example: "No. 23-1234", weak: true },
];

// ============================================================
//  LAYER 4 — validateCitation()
//  Returns { valid, format, court, weak, raw }
// ============================================================
function validateCitation(citationStr) {
  if (!citationStr || typeof citationStr !== "string") {
    return { valid: false, reason: "Empty citation string" };
  }

  const clean = citationStr.trim().replace(/\s+/g, " ");

  // Check against all known patterns
  for (const { pattern, court, example, weak } of CITATION_PATTERNS) {
    if (pattern.test(clean)) {
      return {
        valid:   !weak,        // docket-only refs are weak
        weak:    weak || false,
        format:  example,
        court,
        raw:     clean,
        reason:  weak ? "Docket number only — no reporter citation" : null,
      };
    }
  }

  // Check for obviously fake patterns (hallucination signatures)
  const fakeSigns = [
    /\d+\s+Cal\.\s*\d+[a-z]+\s+\d+\s+\(\d{4}\)/i,  // extra year in wrong place
    /[A-Z][a-z]+\s+v\.\s+[A-Z][a-z]+,\s+\d{4}/i,    // case name only, no reporter
    /§\s*\d+/,                                         // statute section, not citation
  ];

  if (fakeSigns.some(p => p.test(clean))) {
    return {
      valid:  false,
      weak:   false,
      raw:    clean,
      reason: "Suspected malformed or hallucinated citation — does not match any known reporter format",
    };
  }

  return {
    valid:  false,
    weak:   false,
    raw:    clean,
    reason: "Unknown citation format — does not match CA, 9th Circuit, BIA, or federal reporter patterns",
  };
}

// ── Extract all citation strings from a text block ──────────
function extractCitations(text) {
  if (!text) return [];
  const found = [];

  for (const { pattern, court } of CITATION_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, "gi");
    let match;
    while ((match = globalPattern.exec(text)) !== null) {
      found.push({ raw: match[0].trim(), court });
    }
  }

  // Deduplicate
  const seen = new Set();
  return found.filter(c => {
    if (seen.has(c.raw)) return false;
    seen.add(c.raw);
    return true;
  });
}

// ── Validate all citations in a text block ───────────────────
function validateCitationsInText(text) {
  const citations = extractCitations(text);
  if (citations.length === 0) return { hasCitations: false, allValid: true, results: [] };

  const results = citations.map(c => ({
    ...c,
    ...validateCitation(c.raw),
  }));

  return {
    hasCitations: true,
    allValid:     results.every(r => r.valid),
    invalid:      results.filter(r => !r.valid),
    weak:         results.filter(r => r.weak),
    valid:        results.filter(r => r.valid && !r.weak),
    results,
  };
}

// ============================================================
//  LAYERS 1–3 — validateOpinion()
//  Main gate — call this on every raw CourtListener result
//  Returns { valid, binding, warnings[], filtered }
// ============================================================
function validateOpinion(opinion) {
  const warnings = [];
  let valid   = true;
  let binding = false;

  if (!opinion) return { valid: false, binding: false, warnings: ["Null opinion"], filtered: "null" };

  // ── Layer 3: Court whitelist ─────────────────────────────
  const courtId = (opinion.court_id || opinion.court || "").toLowerCase().trim();

  // Try to match court ID from URL or field
  const matchedCourtId = [...TRUSTED_COURT_IDS].find(id =>
    courtId === id || courtId.includes(id)
  );

  if (!matchedCourtId) {
    return {
      valid:    false,
      binding:  false,
      warnings: [`Court "${courtId}" not in trusted whitelist`],
      filtered: "untrusted_court",
    };
  }

  binding = BINDING_COURT_IDS.has(matchedCourtId);

  // ── Layer 2: Precedential status ─────────────────────────
  const precedentialStatus = opinion.precedential_status || opinion.status || "";

  if (precedentialStatus && !VALID_PRECEDENTIAL.has(precedentialStatus)) {
    // Non-precedential — still allow but add strong warning
    if (/unpublish|non.?precedent|memorandum|memo|not for publication/i.test(precedentialStatus)) {
      warnings.push(`⚠️ NON-PRECEDENTIAL: "${precedentialStatus}" — cannot be cited as authority in 9th Circuit under FRAP 32.1(a) or CA rules`);
      valid = false; // Reject non-precedential entirely
    } else {
      warnings.push(`Status "${precedentialStatus}" — verify citability before filing`);
    }
  }

  // ── Layer 1: Document type ───────────────────────────────
  const docType = opinion.type || opinion.document_type || "";

  if (docType && REJECTED_DOC_TYPES.has(docType)) {
    return {
      valid:    false,
      binding:  false,
      warnings: [`Document type "${docType}" is a RECAP filing or non-opinion — not citable authority`],
      filtered: "recap_or_filing",
    };
  }

  // RECAP detection by source field (belt and suspenders)
  if (opinion.source === "RECAP" || opinion.filepath_local?.includes("recap")) {
    return {
      valid:    false,
      binding:  false,
      warnings: ["RECAP-sourced document — this is a court filing, not a published opinion"],
      filtered: "recap_upload",
    };
  }

  return {
    valid,
    binding,
    courtInfo: TRUSTED_COURTS[matchedCourtId],
    warnings,
    filtered: valid ? null : "non_precedential",
  };
}

// ============================================================
//  BATCH VALIDATE — filter an array of opinions
//  Returns { valid[], rejected[], warnings{} }
// ============================================================
function validateOpinions(opinions) {
  if (!Array.isArray(opinions)) return { valid: [], rejected: [], warnings: {} };

  const valid    = [];
  const rejected = [];
  const warnings = {};

  for (const opinion of opinions) {
    const result = validateOpinion(opinion);

    if (result.valid) {
      valid.push({
        ...opinion,
        _binding:   result.binding,
        _courtInfo: result.courtInfo,
        _warnings:  result.warnings,
      });
    } else {
      rejected.push({
        title:    opinion.caseName || opinion.title || "Unknown",
        reason:   result.filtered,
        warnings: result.warnings,
      });
    }

    if (result.warnings.length > 0) {
      warnings[opinion.id || opinion.title] = result.warnings;
    }
  }

  if (rejected.length > 0) {
    console.log(`[validator] 🚫 Filtered ${rejected.length} invalid opinions:`,
      rejected.map(r => `${r.title} (${r.reason})`).join(", "));
  }

  return { valid, rejected, warnings };
}

// ============================================================
//  CACHE SAFETY CHECK
//  Before storing any answer in the cache, check if it
//  contains citations and validate them all
// ============================================================
function isSafeToCache(question, answer) {
  const check = validateCitationsInText(answer);

  // No citations — safe to cache
  if (!check.hasCitations) return { safe: true };

  // Has invalid (non-hallucinated format) citations — block
  if (check.invalid.length > 0) {
    return {
      safe:   false,
      reason: `Answer contains ${check.invalid.length} unrecognized citation(s): ${check.invalid.map(c => c.raw).join(", ")}`,
    };
  }

  // Has weak (docket-only) citations — allow but add disclaimer
  if (check.weak.length > 0) {
    return {
      safe:       true,
      addDisclaimer: true,
      disclaimer: "⚠️ Citations should be verified in Westlaw/Lexis before relying on them.",
    };
  }

  return { safe: true };
}

module.exports = {
  validateOpinion,
  validateOpinions,
  validateCitation,
  validateCitationsInText,
  extractCitations,
  isSafeToCache,
  TRUSTED_COURTS,
  TRUSTED_COURT_IDS,
  BINDING_COURT_IDS,
  CITATION_PATTERNS,
};
