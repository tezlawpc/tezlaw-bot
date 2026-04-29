// ============================================================
//  eyecite-bridge.js
//  Node client for the Python eyecite Flask sidecar
//
//  ENV VAR REQUIRED:
//    EYECITE_URL = "https://tezlaw-eyecite.onrender.com" (no trailing slash)
//
//  USAGE:
//    const ec = require("./eyecite-bridge");
//    const citations = await ec.extract("Bush v. Gore, 531 U.S. 98 (2000).");
//    const resolved  = await ec.resolve(briefText);
// ============================================================

const axios = require("axios");

const EYECITE_URL = process.env.EYECITE_URL || "http://localhost:5000";
const TIMEOUT_MS  = 30000;

async function _post(endpoint, body) {
  try {
    const r = await axios.post(`${EYECITE_URL}${endpoint}`, body, {
      timeout: TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
    });
    return r.data;
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
      console.error(`[eyecite-bridge] Sidecar unreachable at ${EYECITE_URL}`);
    }
    throw new Error(`Eyecite sidecar error: ${err.message}`);
  }
}

/**
 * Extract all citations from text.
 * @param {string} text - Raw text (PDF extraction, brief, opinion)
 * @param {string[]} cleanSteps - eyecite clean_text steps. Default: ['all_whitespace']
 *                                Common: 'html', 'all_whitespace', 'underscores', 'xml'
 * @returns {Promise<Array>} Array of citation objects
 */
async function extract(text, cleanSteps = ["all_whitespace"]) {
  if (!text || !text.trim()) return [];
  const data = await _post("/extract", { text, clean: cleanSteps });
  if (data.error) throw new Error(data.error);
  return data || [];
}

/**
 * Extract + resolve short forms / supra / id back to full citations.
 * @param {string} text
 * @param {string[]} cleanSteps
 * @returns {Promise<Object>} { resolutions: [...] }
 */
async function resolve(text, cleanSteps = ["all_whitespace"]) {
  if (!text || !text.trim()) return { resolutions: [] };
  return await _post("/resolve", { text, clean: cleanSteps });
}

/** Clean text using eyecite's clean_text helper. */
async function clean(text, steps = ["all_whitespace"]) {
  return await _post("/clean", { text, steps });
}

/** Health check — returns true if sidecar is reachable. */
async function health() {
  try {
    const r = await axios.get(`${EYECITE_URL}/health`, { timeout: 5000 });
    return r.data?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Filter to ONLY full case citations (excludes id, supra, short forms).
 * Most useful for cite-checking tasks where we want canonical citations.
 */
async function extractFullCases(text, cleanSteps = ["all_whitespace"]) {
  const all = await extract(text, cleanSteps);
  return all.filter(c => c.type === "full_case");
}

/**
 * Detect negative-treatment signals in extracted citations by scanning
 * parenthetical text for Bluebook negative phrases.
 *
 * Returns citations enriched with `treatment` field:
 *   - "overrules"   — parenthetical says overruled / abrogated
 *   - "reverses"    — parenthetical says reversed / vacated
 *   - "criticizes"  — parenthetical says criticized / called into doubt
 *   - "distinguishes" — parenthetical says distinguished / declined to follow
 *   - "positive"    — parenthetical says followed / affirmed / reaffirmed
 *   - "neutral"     — parenthetical exists but is descriptive only
 *   - null          — no parenthetical
 */
function classifyTreatment(citations) {
  const NEG = {
    overrules:     /\boverrul(ed|ing|es)\b|\babrogat(ed|ing|es)\b|\bsuperseded by statute\b/i,
    reverses:      /\brevers(ed|ing|es)\b|\bvacat(ed|ing|es)\b/i,
    criticizes:    /\bcriticiz(ed|ing|es)\b|\bcalled into doubt\b|\bquestioned\b/i,
    distinguishes: /\bdistinguish(ed|ing|es)\b|\bdeclin(ed|ing|es) to follow\b/i,
  };
  const POS = {
    positive: /\b(?:re)?affirm(ed|ing|s)\b|\bfollow(ed|ing|s)\b|\breaffirm(ed|ing|s)\b/i,
  };

  return citations.map(c => {
    const par = c.parenthetical || "";
    if (!par) return { ...c, treatment: null };

    for (const [k, rx] of Object.entries(NEG)) {
      if (rx.test(par)) return { ...c, treatment: k };
    }
    for (const [k, rx] of Object.entries(POS)) {
      if (rx.test(par)) return { ...c, treatment: k };
    }
    return { ...c, treatment: "neutral" };
  });
}

module.exports = {
  extract,
  resolve,
  clean,
  health,
  extractFullCases,
  classifyTreatment,
};
