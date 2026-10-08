// ============================================================
//  ad-rules.js — what every TEZ advertisement has to say, and what none may
//
//  One place for the facts the ad rules turn on, so a post, a card, a video
//  and the blog footer cannot drift apart:
//
//  · B&P Code § 6157.2(b) (in force Jan 1, 2026): an advertisement names a
//    California lawyer or the firm AND the city of a bona fide office.
//  · Rule 7.1, Comment [5]: a piece must not imply that the lawyer can serve
//    clients in a language he does not speak. JJ speaks English, Mandarin
//    and Shanghainese; Spanish help comes from office staff. So wherever
//    Spanish help is offered, the piece says, in its own language, that it
//    comes from office staff, not an attorney — and a Spanish piece also says
//    which languages the attorneys speak. (JJ, Oct 8 2026: no staff job
//    title is to be named. A title can still be set with env SPANISH_STAFF,
//    JSON {"en": "...", "zh": "...", "es": "..."}, and is then used instead
//    of "office staff".)
//  · Rule 7.1 and § 6157.2(a)(5): no claims about results, skill or record
//    that cannot be substantiated, and no "free" consultation — some
//    consultations carry a fee.
// ============================================================

const FIRM = "TEZ Law Firm";
const OFFICE_CITY = "West Covina, CA";
const OFFICE_CITY_LONG = "West Covina, California";

function spanishStaff() {
  try {
    const j = JSON.parse(process.env.SPANISH_STAFF || "{}");
    const out = {};
    for (const k of ["en", "zh", "es"]) if (j[k] && String(j[k]).trim()) out[k] = String(j[k]).trim().slice(0, 60);
    return out;
  } catch { return {}; }
}

/** The job title of the Spanish speaker in `lang`, or "" when not set. */
function spanishStaffTitle(lang = "en") {
  return spanishStaff()[lang] || "";
}

/** Spanish help can always be offered, worded as office staff help (see above). */
function spanishReady() {
  return true;
}

/** The line that offers Spanish help, in the piece's own language. */
function spanishLine(lang = "en") {
  const t = spanishStaffTitle(lang);
  if (lang === "zh") return `西班牙语协助：${t || "办公室工作人员"}（非律师）`;
  if (lang === "es") return `Atención en español: ${t || "personal de la oficina"} (no es abogado). Nuestros abogados atienden en inglés, mandarín y shanghainés`;
  return `Spanish: ${t || "office staff"} (not an attorney)`;
}

/** The language chip in the blog author box. */
function spanishChip(lang = "en") {
  const t = spanishStaffTitle(lang);
  const l = lang === "zh" ? `西班牙语：${t || "办公室工作人员"}（非律师）`
          : lang === "es" ? `Español: ${t || "personal de oficina"} (no abogado)`
          : `Spanish: ${t || "office staff"} (not an attorney)`;
  return `<span class="tez-lang">${l}</span>`;
}

/** Closing card text for a video: the fixed disclaimer, plus the Spanish line on Spanish videos. */
function videoDisclaimer(lang, table) {
  const base = (table && (table[lang] || table.en)) || "";
  if (lang !== "es") return base;
  const line = spanishLine("es");
  return line ? `${base}\n${line}.` : base;
}

// Words a post, card or caption may not use about the firm. Each is here
// because the blog filter or the October 2026 review found it in something
// the firm had published. Kept narrow: news that quotes "legal experts" or
// reports "approval rates" is fine; the firm describing itself that way is not.
const CLAIM_RULES = [
  { re: /\bfree\s+(?:initial\s+)?consultations?\b|consulta\s+(?:gratuita|gratis)|免费(?:初步)?咨询|免費諮詢/i, why: "offers a free consultation (some consultations carry a fee)" },
  { re: /\bcertified\s+specialist|\bspeciali[sz](?:t|ts)\b/i, why: "specialist claim (Rule 7.4)" },
  { re: /\b(?:our|we\s+are|tez\s+law(?:\s+firm|\s+p\.c\.)?(?:\s+is|\s+are)?)\s+(?:legal\s+|immigration\s+)?experts?\b|\bexpert\s+(?:legal|immigration|attorneys?|lawyers?|representation|help|team)\b/i, why: "calls the firm expert" },
  { re: /\b(?:our|we\s+have\s+an?|we\s+have|high)\s+(?:approval|success|win)\s+rates?\b|\d+\s*%\s*(?:success|approval|win)/i, why: "success-rate claim" },
  { re: /\b(?:our|we\s+have\s+a|with\s+a)\s+(?:proven\s+)?track\s+record\b|\bTrack\s+Record\s+of\s+Success\b|\bproven\s+(?:results?|advocacy|record|success)/i, why: "track-record claim" },
  { re: /\b(?:we|our)\b[^.!?\n]{0,30}\baggressive(?:ly)?\b/i, why: "describes the firm as aggressive" },
  { re: /\b(?:over|more\s+than)\s+(?:a\s+)?decades?\s+of\s+experience\b/i, why: "years-of-experience claim" },
  { re: /\b(?:we|our\s+(?:team|firm|attorneys?|lawyers?))\s+(?:have\s+)?(?:won|secured|recovered|obtained)\b[^.!?\n]{0,40}\b(?:cases?|settlements?|verdicts?|approvals?|release)/i, why: "claims past results" },
  { re: /(?:本所|我们)[^。！？\n]{0,10}专家|专家团队|胜诉率|成功率/, why: "expert or success-rate claim (Chinese)" },
];

module.exports = {
  FIRM, OFFICE_CITY, OFFICE_CITY_LONG,
  spanishStaff, spanishStaffTitle, spanishReady, spanishLine, spanishChip, videoDisclaimer,
  CLAIM_RULES,
};
