// ============================================================
//  brief-generator.js — Layer 3
//  Tez Law P.C. | Zara Legal Intelligence Stack
//
//  WHAT IT DOES:
//  Drafts motion briefs calibrated to a SPECIFIC JUDGE using:
//    • Judge profile (grant rates, language patterns, citations)
//    • Motion intelligence (winning/losing arguments per judge)
//    • Jury instruction elements (CACI/9th Cir Model)
//    • Live case law from CourtListener
//    • CA statutes from leginfo
//
//  OUTPUT: A structured draft brief in JJ's voice with:
//    • Every argument the judge has accepted in past rulings
//    • Language patterns mirroring this judge's preferred phrasing
//    • Statutes this judge cites
//    • Cases this judge relies on
//    • Pre-emptive responses to arguments this judge rejects
//
//  HOW TO CALL:
//  const { generateBrief } = require("./brief-generator");
//  const brief = await generateBrief({
//    judgeName:    "Wardlaw",
//    court:        "9th Circuit",
//    motionType:   "Asylum Petition",
//    practiceArea: "immigration",
//    facts:        "Petitioner from Guatemala, gang threats...",
//    desiredRelief:"reverse BIA's denial of asylum",
//    opposingArguments: ["country conditions unchanged", "credibility issues"],
//  });
//
//  CLI MODE:
//  node brief-generator.js --judge="Wardlaw" --motion="Asylum" --facts-file=./facts.txt
// ============================================================

const axios = require("axios");
const db    = require("./db");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COURTLISTENER_TOKEN = process.env.COURTLISTENER_TOKEN;

// ============================================================
//  CORE: GENERATE BRIEF
// ============================================================
async function generateBrief({
  judgeName,
  court           = null,
  motionType,
  practiceArea    = null,
  facts,
  desiredRelief,
  opposingArguments = [],
  caseNumber      = null,
  caseName        = null,
  partyRepresented = null,
}) {
  if (!judgeName || !motionType || !facts) {
    throw new Error("generateBrief requires judgeName, motionType, and facts");
  }

  console.log(`[brief-gen] 📝 Building brief for ${judgeName} on ${motionType}`);

  // ── Step 1: Pull judge profile (Layer 1) ───────────────
  const judgeProfile = await getJudgeIntelligence(judgeName, court, motionType);

  // ── Step 2: Pull motion intelligence (Layer 2) ─────────
  const motionIntel = await getMotionIntelligence(judgeName, court, motionType, practiceArea);

  // ── Step 3: Pull peer panel insights (for 9th Cir) ─────
  const peerInsights = await getPeerJudges(judgeName, court, motionType);

  // ── Step 4: Pull jury instruction elements ─────────────
  const elements = getJuryInstructionElements(motionType, practiceArea);

  // ── Step 5: Search live case law for supporting auth ───
  const supportingCases = await findSupportingCaseLaw(motionType, practiceArea, judgeProfile);

  // ── Step 6: Build the master prompt ────────────────────
  const prompt = buildBriefPrompt({
    judgeName, court, motionType, practiceArea,
    facts, desiredRelief, opposingArguments,
    caseNumber, caseName, partyRepresented,
    judgeProfile, motionIntel, peerInsights, elements, supportingCases,
  });

  // ── Step 7: Generate brief with Claude Sonnet ──────────
  console.log(`[brief-gen] 🧠 Generating brief with Claude...`);
  const brief = await callClaudeForBrief(prompt);

  // ── Step 8: Add metadata + citations summary ───────────
  return {
    brief,
    metadata: {
      generated_at:      new Date().toISOString(),
      judge:             judgeName,
      court:             court || judgeProfile?.court || "Unknown",
      motion_type:       motionType,
      practice_area:     practiceArea,
      data_sources: {
        judge_rulings_analyzed: judgeProfile?.total_rulings || 0,
        winning_args_used:      motionIntel?.winning?.length || 0,
        losing_args_anticipated:motionIntel?.losing?.length  || 0,
        peer_judges_referenced: peerInsights?.length || 0,
        supporting_cases:       supportingCases?.length || 0,
      },
      caveats: [
        "AI-generated draft. Attorney must review every citation, fact statement, and argument.",
        "Verify all case citations in vLex Fastcase before filing (Shepardize for negative treatment).",
        "Confirm statutory subdivisions are current — code may have been amended.",
        "Adapt tone to your firm's voice — this is a starting point, not a final draft.",
      ],
    },
  };
}

// ============================================================
//  STEP 1 — JUDGE INTELLIGENCE FROM LAYER 1
// ============================================================
async function getJudgeIntelligence(judgeName, court, motionType) {
  try {
    let query = `
      SELECT
        jp.judge_name,
        jp.court,
        jp.court_type,
        jp.total_rulings,
        ji.motion_type,
        ji.grant_count,
        ji.deny_count,
        ji.key_phrases,
        ji.accepted_args,
        ji.rejected_args,
        ji.cited_statutes,
        ji.cited_cases,
        ji.reasoning_style,
        ji.sample_language,
        ROUND(ji.grant_count::numeric / NULLIF(ji.grant_count + ji.deny_count, 0) * 100, 1) AS grant_rate
      FROM judge_profiles jp
      LEFT JOIN judge_insights ji ON jp.id = ji.judge_profile_id
      WHERE jp.judge_name ILIKE $1
    `;
    const params = [`%${judgeName}%`];
    if (court) {
      query += ` AND jp.court ILIKE $${params.length + 1}`;
      params.push(`%${court}%`);
    }
    if (motionType) {
      query += ` AND (ji.motion_type ILIKE $${params.length + 1} OR ji.motion_type IS NULL)`;
      params.push(`%${motionType}%`);
    }
    query += " ORDER BY jp.total_rulings DESC, (ji.grant_count + ji.deny_count) DESC LIMIT 5";

    const result = await db.query(query, params);
    if (!result.rows.length) {
      console.log(`[brief-gen] ⚠️  No profile for ${judgeName} — generating with general intelligence only`);
      return null;
    }

    // Aggregate insights across rulings
    const profile = result.rows[0];
    const allKeyPhrases   = new Set();
    const allAccepted     = new Set();
    const allRejected     = new Set();
    const allStatutes     = new Set();
    const allCases        = new Set();

    for (const row of result.rows) {
      (row.key_phrases || []).forEach(p => p && allKeyPhrases.add(p));
      (row.accepted_args || []).forEach(a => a && allAccepted.add(a));
      (row.rejected_args || []).forEach(a => a && allRejected.add(a));
      (row.cited_statutes || []).forEach(s => s && allStatutes.add(s));
      (row.cited_cases || []).forEach(c => c && allCases.add(c));
    }

    return {
      judge_name:      profile.judge_name,
      court:           profile.court,
      court_type:      profile.court_type,
      total_rulings:   profile.total_rulings,
      grant_rate:      profile.grant_rate,
      reasoning_style: profile.reasoning_style,
      sample_language: profile.sample_language,
      key_phrases:     [...allKeyPhrases].slice(0, 10),
      accepted_args:   [...allAccepted].slice(0, 8),
      rejected_args:   [...allRejected].slice(0, 8),
      cited_statutes:  [...allStatutes].slice(0, 12),
      cited_cases:     [...allCases].slice(0, 12),
    };
  } catch (err) {
    console.error("[brief-gen] Judge intel error:", err.message);
    return null;
  }
}

// ============================================================
//  STEP 2 — MOTION INTELLIGENCE FROM LAYER 2
// ============================================================
async function getMotionIntelligence(judgeName, court, motionType, practiceArea) {
  try {
    // Winning arguments (frequency-weighted)
    const winQuery = await db.query(`
      SELECT argument_text, frequency, example_language, why_it_worked
      FROM motion_arguments
      WHERE judge_name ILIKE $1
        AND argument_type = 'winning'
        ${court ? "AND court ILIKE $3" : ""}
        AND motion_type ILIKE $2
      ORDER BY frequency DESC
      LIMIT 8
    `, court ? [`%${judgeName}%`, `%${motionType}%`, `%${court}%`] : [`%${judgeName}%`, `%${motionType}%`]);

    // Losing arguments (anticipate opposition)
    const lossQuery = await db.query(`
      SELECT argument_text, frequency, why_it_failed
      FROM motion_arguments
      WHERE judge_name ILIKE $1
        AND argument_type = 'losing'
        AND motion_type ILIKE $2
      ORDER BY frequency DESC
      LIMIT 6
    `, [`%${judgeName}%`, `%${motionType}%`]);

    // Frameworks (drafting structure)
    const frameQuery = await db.query(`
      SELECT framework_type, description, structure
      FROM motion_frameworks
      WHERE judge_name ILIKE $1 AND motion_type ILIKE $2
      LIMIT 5
    `, [`%${judgeName}%`, `%${motionType}%`]);

    // Reasoning patterns (how judge thinks)
    const reasonQuery = await db.query(`
      SELECT pattern_type, description, sample_language
      FROM reasoning_patterns
      WHERE (judge_name ILIKE $1 OR judge_name IS NULL)
        AND (motion_type ILIKE $2 OR motion_type IS NULL)
        ${practiceArea ? "AND (practice_area = $3 OR practice_area IS NULL)" : ""}
      ORDER BY judge_name NULLS LAST
      LIMIT 6
    `, practiceArea
      ? [`%${judgeName}%`, `%${motionType}%`, practiceArea]
      : [`%${judgeName}%`, `%${motionType}%`]);

    return {
      winning:    winQuery.rows,
      losing:     lossQuery.rows,
      frameworks: frameQuery.rows,
      patterns:   reasonQuery.rows,
    };
  } catch (err) {
    console.error("[brief-gen] Motion intel error:", err.message);
    return { winning: [], losing: [], frameworks: [], patterns: [] };
  }
}

// ============================================================
//  STEP 3 — PEER JUDGES (for 9th Circuit panels especially)
// ============================================================
async function getPeerJudges(judgeName, court, motionType) {
  if (!court || !court.toLowerCase().includes("circuit")) return [];

  try {
    const result = await db.query(`
      SELECT DISTINCT
        ji.judge_name,
        ji.motion_type,
        ji.grant_count,
        ji.deny_count,
        ji.accepted_args,
        ji.cited_cases
      FROM judge_insights ji
      WHERE ji.court = $1
        AND ji.motion_type ILIKE $2
        AND ji.judge_name NOT ILIKE $3
        AND (ji.grant_count + ji.deny_count) >= 3
      ORDER BY (ji.grant_count + ji.deny_count) DESC
      LIMIT 5
    `, [court, `%${motionType}%`, `%${judgeName}%`]);

    return result.rows;
  } catch (err) {
    return [];
  }
}

// ============================================================
//  STEP 4 — JURY INSTRUCTION ELEMENTS
//  Maps motion type → required elements that judges look for
// ============================================================
function getJuryInstructionElements(motionType, practiceArea) {
  const m = (motionType || "").toLowerCase();
  const p = (practiceArea || "").toLowerCase();

  // ── Immigration ─────────────────────────────────────────
  if (m.includes("asylum") || p.includes("immigration")) {
    return {
      framework: "INA 208 / 8 U.S.C. § 1158",
      elements: [
        "Refugee definition (8 U.S.C. § 1101(a)(42))",
        "Past persecution OR well-founded fear of future persecution",
        "Persecution on account of: race, religion, nationality, PSG, or political opinion (nexus)",
        "Persecutor is government OR government unable/unwilling to control",
        "Internal relocation analysis (if government persecutor: presumption favors applicant)",
        "Credibility (totality of circumstances — REAL ID Act)",
        "Corroboration where reasonable to expect",
      ],
      authorities: [
        "Matter of A-B-, 27 I&N Dec. 316 (A.G. 2018) — PSG analysis",
        "Matter of Mogharrabi, 19 I&N Dec. 439 (BIA 1987) — well-founded fear",
        "Cardoza-Fonseca, 480 U.S. 421 (1987) — 10% threshold",
      ],
    };
  }
  if (m.includes("withholding")) {
    return {
      framework: "INA 241(b)(3) / 8 U.S.C. § 1231(b)(3)",
      elements: [
        "More likely than not standard (clear probability)",
        "Life or freedom would be threatened",
        "On account of protected ground",
        "No discretionary determination (mandatory if eligible)",
      ],
      authorities: ["Stevic, 467 U.S. 407 (1984)", "Aguirre-Aguirre, 526 U.S. 415 (1999)"],
    };
  }
  if (m.includes("motion to reopen") || m.includes("mtr")) {
    return {
      framework: "8 C.F.R. § 1003.23",
      elements: [
        "Filed within 90 days of final order (numerical limit)",
        "Material new evidence not available at prior hearing",
        "Reasonable likelihood of changed outcome",
        "Exceptions: changed country conditions, ineffective assistance (Lozada), in absentia rescission",
      ],
      authorities: ["Matter of Lozada, 19 I&N Dec. 637 (BIA 1988)"],
    };
  }

  // ── Civil — Demurrer ────────────────────────────────────
  if (m.includes("demurrer")) {
    return {
      framework: "CCP § 430.10",
      elements: [
        "Failure to state facts sufficient to constitute cause of action (430.10(e))",
        "Uncertainty (430.10(f))",
        "Misjoinder of parties (430.10(d))",
        "Lack of legal capacity (430.10(b))",
        "Court accepts factual allegations as true",
        "Liberal pleading standard — leave to amend usually granted",
      ],
      authorities: [
        "Blank v. Kirwan, 39 Cal.3d 311 (1985) — pleading standard",
        "Aubry v. Tri-City Hospital, 2 Cal.4th 962 (1992) — leave to amend",
      ],
    };
  }

  // ── Civil — MSJ ─────────────────────────────────────────
  if (m.includes("msj") || m.includes("summary judgment")) {
    return {
      framework: "CCP § 437c (state) / FRCP 56 (federal)",
      elements: [
        "No triable issue of material fact",
        "Moving party entitled to judgment as matter of law",
        "Burden shift: prima facie showing, then nonmovant must produce evidence",
        "All inferences drawn in favor of nonmovant",
      ],
      authorities: [
        "Aguilar v. Atlantic Richfield Co., 25 Cal.4th 826 (2001) — burden shifting",
        "Anderson v. Liberty Lobby, 477 U.S. 242 (1986) — federal standard",
      ],
    };
  }

  // ── Civil — Anti-SLAPP ──────────────────────────────────
  if (m.includes("anti-slapp") || m.includes("slapp")) {
    return {
      framework: "CCP § 425.16",
      elements: [
        "Prong 1: Defendant must show conduct was 'in furtherance of' protected speech/petition activity",
        "Prong 2: Plaintiff must show probability of prevailing on the merits",
        "Mandatory attorneys' fees to prevailing defendant (§ 425.16(c))",
        "Discovery stayed pending ruling",
      ],
      authorities: [
        "Equilon Enterprises v. Consumer Cause, 29 Cal.4th 53 (2002)",
        "Baral v. Schnitt, 1 Cal.5th 376 (2016) — mixed causes of action",
      ],
    };
  }

  // ── Eviction / UD ───────────────────────────────────────
  if (m.includes("unlawful detainer") || m.includes("eviction")) {
    return {
      framework: "CCP § 1161 / Civil Code § 1946.2 (AB 1482)",
      elements: [
        "Valid notice (3-day pay or quit, 30-day, 60-day, or just-cause notice)",
        "Proper service of notice",
        "Notice period expired without cure or surrender",
        "AB 1482 just cause (if covered): at-fault or no-fault category",
        "Habitability defense (Civ. Code § 1941.1) — material conditions",
        "Retaliatory eviction defense (Civ. Code § 1942.5)",
      ],
      authorities: [
        "Green v. Superior Court, 10 Cal.3d 616 (1974) — implied warranty of habitability",
        "Schweiger v. Superior Court, 3 Cal.3d 507 (1970) — retaliation",
      ],
    };
  }

  // ── Personal Injury — Negligence ────────────────────────
  if (m.includes("negligence") || p.includes("personal injury") || p.includes("pi")) {
    return {
      framework: "CACI 400 / Civil Code § 1714",
      elements: [
        "Duty (Rowland factors: foreseeability, certainty, closeness, moral blame, prevention, burden, insurance)",
        "Breach (reasonable person standard)",
        "Causation: but-for + substantial factor (CACI 430)",
        "Proximate cause / superseding cause analysis",
        "Damages (economic, non-economic, future)",
      ],
      authorities: [
        "Rowland v. Christian, 69 Cal.2d 108 (1968)",
        "Howell v. Hamilton Meats, 52 Cal.4th 541 (2011) — medical specials",
      ],
    };
  }

  // ── Estate / Trust ──────────────────────────────────────
  if (m.includes("trust") || m.includes("trustee") || p.includes("estate")) {
    return {
      framework: "Probate Code §§ 16000-17200",
      elements: [
        "Trustee duties: loyalty (16002), impartiality (16003), prudent investor (16047)",
        "Duty to inform/account (16060, 16062)",
        "Self-dealing transactions void unless authorized",
        "Surcharge for breach (with interest)",
        "Removal standard (15642): breach, insolvency, hostility, best interest",
      ],
      authorities: [
        "Estate of Giraldin, 55 Cal.4th 1058 (2012)",
        "Hearst v. Ganzi, 145 Cal.App.4th 1195 (2006)",
      ],
    };
  }

  // ── Section 1983 / Civil Rights ─────────────────────────
  if (m.includes("1983") || p.includes("civil rights") || p.includes("public")) {
    return {
      framework: "42 U.S.C. § 1983 / 9th Cir. Model 9.1",
      elements: [
        "Deprivation of federal constitutional or statutory right",
        "Under color of state law",
        "Causation by defendant's conduct",
        "Qualified immunity defense: (1) constitutional violation, (2) clearly established",
        "Monell: official policy, custom, or failure to train (deliberate indifference)",
      ],
      authorities: [
        "Monell v. Dept. of Social Services, 436 U.S. 658 (1978)",
        "Saucier v. Katz, 533 U.S. 194 (2001) — QI two-step",
        "Pearson v. Callahan, 555 U.S. 223 (2009) — QI flexibility",
      ],
    };
  }

  // ── Default ─────────────────────────────────────────────
  return {
    framework: "General civil practice",
    elements: [
      "Identify cause of action elements",
      "State applicable legal standard",
      "Apply facts to each element",
      "Address foreseeable counter-arguments",
    ],
    authorities: [],
  };
}

// ============================================================
//  STEP 5 — FIND SUPPORTING CASE LAW
// ============================================================
async function findSupportingCaseLaw(motionType, practiceArea, judgeProfile) {
  const courtFilter = inferCourtFilter(judgeProfile?.court);
  const queries = buildSearchQueries(motionType, practiceArea, judgeProfile);
  const found = [];

  for (const q of queries.slice(0, 3)) {
    try {
      const headers = COURTLISTENER_TOKEN
        ? { Authorization: `Token ${COURTLISTENER_TOKEN}` } : {};

      const resp = await axios.get(
        "https://www.courtlistener.com/api/rest/v4/search/",
        {
          params: {
            q: q,
            type: "o",
            stat_Published: "on",
            court: courtFilter,
            order_by: "score desc",
            page_size: 4,
          },
          headers,
          timeout: 10000,
        }
      );

      (resp.data?.results || []).forEach(r => {
        found.push({
          name:     r.caseName || r.case_name,
          citation: (r.citation || []).join(", "),
          court:    r.court,
          date:     r.dateFiled || r.date_filed,
          query:    q,
          url:      r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
        });
      });
    } catch (err) {
      // Non-fatal
    }
  }

  // Deduplicate by case name
  const seen = new Set();
  return found.filter(c => {
    const key = (c.name || "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function inferCourtFilter(court) {
  if (!court) return "ca9,cacd,caed,cand,casd,cal,calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th";
  const c = court.toLowerCase();
  if (c.includes("9th") || c.includes("ninth")) return "ca9,scotus";
  if (c.includes("supreme") && c.includes("california")) return "cal,scotus";
  if (c.includes("central")) return "cacd,ca9,scotus";
  if (c.includes("eastern")) return "caed,ca9,scotus";
  if (c.includes("northern")) return "cand,ca9,scotus";
  if (c.includes("southern")) return "casd,ca9,scotus";
  if (c.includes("appeal")) return "calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th,calctapp_5th,calctapp_6th,cal";
  if (c.includes("bia") || c.includes("immigration")) return "bia,ca9";
  return "ca9,cacd,caed,cand,casd,cal,calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th";
}

function buildSearchQueries(motionType, practiceArea, judgeProfile) {
  const queries = [];
  const m = (motionType || "").toLowerCase();
  const p = (practiceArea || "").toLowerCase();

  if (m.includes("asylum"))             queries.push("asylum well-founded fear nexus particular social group");
  if (m.includes("withholding"))        queries.push("withholding of removal more likely than not protected ground");
  if (m.includes("motion to reopen"))   queries.push("motion to reopen changed country conditions");
  if (m.includes("demurrer"))           queries.push("demurrer leave to amend pleading standard");
  if (m.includes("msj") || m.includes("summary judgment")) queries.push("summary judgment triable issue material fact burden");
  if (m.includes("anti-slapp"))         queries.push("anti-SLAPP probability of prevailing protected activity");
  if (m.includes("unlawful detainer")) queries.push("unlawful detainer notice habitability AB 1482");
  if (m.includes("negligence"))         queries.push("Rowland duty foreseeability comparative fault");
  if (m.includes("1983"))               queries.push("section 1983 qualified immunity clearly established");
  if (m.includes("trust") || m.includes("trustee")) queries.push("trustee fiduciary duty surcharge breach");

  // Add cases the judge has cited as additional searches
  if (judgeProfile?.cited_cases?.length) {
    judgeProfile.cited_cases.slice(0, 2).forEach(c => {
      if (c && c.length > 5) queries.push(`"${c}"`);
    });
  }

  // Fallback
  if (!queries.length) queries.push(motionType);

  return queries;
}

// ============================================================
//  STEP 6 — BUILD MASTER PROMPT
// ============================================================
function buildBriefPrompt(ctx) {
  const {
    judgeName, court, motionType, practiceArea,
    facts, desiredRelief, opposingArguments,
    caseNumber, caseName, partyRepresented,
    judgeProfile, motionIntel, peerInsights, elements, supportingCases,
  } = ctx;

  const judgeIntelBlock = judgeProfile ? `
JUDGE PROFILE — ${judgeProfile.judge_name} (${judgeProfile.court}):
• Total rulings analyzed: ${judgeProfile.total_rulings}
• Grant rate on ${motionType}: ${judgeProfile.grant_rate || "insufficient data"}%
• Reasoning style: ${judgeProfile.reasoning_style || "Not yet characterized"}

LANGUAGE THIS JUDGE USES (mirror this phrasing where natural):
${judgeProfile.key_phrases?.length ? judgeProfile.key_phrases.map(p => `  • "${p}"`).join("\n") : "  • (no language patterns captured yet)"}

ARGUMENTS THIS JUDGE HAS ACCEPTED IN PAST RULINGS:
${judgeProfile.accepted_args?.length ? judgeProfile.accepted_args.map(a => `  ✅ ${a}`).join("\n") : "  • (none captured)"}

ARGUMENTS THIS JUDGE HAS REJECTED — ANTICIPATE & PREEMPT:
${judgeProfile.rejected_args?.length ? judgeProfile.rejected_args.map(a => `  ❌ ${a}`).join("\n") : "  • (none captured)"}

STATUTES THIS JUDGE TYPICALLY CITES:
${judgeProfile.cited_statutes?.length ? "  " + judgeProfile.cited_statutes.join(", ") : "  (none captured)"}

CASES THIS JUDGE TYPICALLY CITES:
${judgeProfile.cited_cases?.length ? "  " + judgeProfile.cited_cases.slice(0, 8).join("; ") : "  (none captured)"}
` : `
JUDGE PROFILE — ${judgeName}:
No prior rulings analyzed yet for this judge. Brief will use general practice intelligence.
`;

  const motionIntelBlock = motionIntel?.winning?.length ? `
PROVEN WINNING ARGUMENTS BEFORE THIS JUDGE (USE THESE):
${motionIntel.winning.map((a, i) =>
  `  ${i+1}. ${a.argument_text}${a.frequency > 1 ? ` (confirmed ${a.frequency}x)` : ""}` +
  (a.example_language ? `\n     Example language: "${a.example_language}"` : "") +
  (a.why_it_worked ? `\n     Why it worked: ${a.why_it_worked}` : "")
).join("\n")}
` : "";

  const losingBlock = motionIntel?.losing?.length ? `
ARGUMENTS THAT FAIL BEFORE THIS JUDGE (DON'T LEAD WITH THESE; ADDRESS PREEMPTIVELY IF OPPOSING):
${motionIntel.losing.map((a, i) =>
  `  ${i+1}. ${a.argument_text}${a.frequency > 1 ? ` (rejected ${a.frequency}x)` : ""}` +
  (a.why_it_failed ? `\n     Why it fails: ${a.why_it_failed}` : "")
).join("\n")}
` : "";

  const peerBlock = peerInsights?.length ? `
PEER PANEL JUDGES ON SAME COURT — what colleagues accept:
${peerInsights.slice(0, 4).map(p =>
  `  • ${p.judge_name}: ${p.accepted_args?.slice(0, 2).join("; ") || "no data"}`
).join("\n")}
` : "";

  const elementsBlock = elements ? `
LEGAL FRAMEWORK & ELEMENTS:
Framework: ${elements.framework}
Required elements / factors:
${elements.elements.map((e, i) => `  ${i+1}. ${e}`).join("\n")}
${elements.authorities?.length ? `\nKey authorities:\n${elements.authorities.map(a => `  • ${a}`).join("\n")}` : ""}
` : "";

  const casesBlock = supportingCases?.length ? `
RECENT SUPPORTING CASE LAW (verify each in vLex before relying):
${supportingCases.map(c =>
  `  • ${c.name || "Unknown"}, ${c.citation || "no citation"} (${c.court}, ${c.date || "unknown date"})`
).join("\n")}
` : "";

  const opposingBlock = opposingArguments?.length ? `
KNOWN OPPOSING ARGUMENTS — REFUTE EACH IN A DEDICATED SECTION:
${opposingArguments.map((a, i) => `  ${i+1}. ${a}`).join("\n")}
` : "";

  return `You are JJ Zhang, Managing Attorney at Tez Law P.C., drafting a motion brief.

═══════════════════════════════════════════════════════════════
DRAFTING ASSIGNMENT
═══════════════════════════════════════════════════════════════
Motion type:        ${motionType}
Court / Judge:      ${judgeName}${court ? ` (${court})` : ""}
Practice area:      ${practiceArea || "general civil"}
Case:               ${caseName || "[Case Name]"}, ${caseNumber || "[Case No.]"}
Party represented:  ${partyRepresented || "(not specified)"}
Desired relief:     ${desiredRelief || "(not specified)"}

CASE FACTS:
${facts}

═══════════════════════════════════════════════════════════════
INTELLIGENCE — USE EVERY DATA POINT BELOW
═══════════════════════════════════════════════════════════════
${judgeIntelBlock}
${motionIntelBlock}
${losingBlock}
${peerBlock}
${elementsBlock}
${casesBlock}
${opposingBlock}

═══════════════════════════════════════════════════════════════
DRAFTING INSTRUCTIONS
═══════════════════════════════════════════════════════════════
Write a complete, court-ready motion brief with these sections:

1. **CAPTION** — Court name, case caption, case number, motion title, hearing info placeholder
2. **NOTICE OF MOTION** (if California state) — date/time/location placeholders
3. **MEMORANDUM OF POINTS AND AUTHORITIES** — main body
4. **I. INTRODUCTION** — 1-2 paragraphs framing the issue and requested relief
5. **II. STATEMENT OF FACTS** — neutral, specific recitation drawn from CASE FACTS provided
6. **III. LEGAL STANDARD** — cite the framework above; mirror this judge's preferred phrasing
7. **IV. ARGUMENT** — main analysis section, organized by element OR by sub-issue:
   • Lead with the proven winning arguments above (most-rejected-by-this-judge arguments LAST or never)
   • Apply each element to the facts
   • Cite specifically the statutes and cases this judge prefers
   • If opposing arguments are listed, dedicate a sub-section to refuting each
   • Mirror the judge's reasoning style (analytical, formalistic, equitable, etc.)
8. **V. CONCLUSION** — clear statement of relief sought
9. **SIGNATURE BLOCK** — JJ Zhang, Tez Law P.C., placeholder

CRITICAL DRAFTING RULES:
• Do NOT invent case citations. Only use cases listed above OR widely-known foundational cases (Iqbal, Twombly, Cardoza-Fonseca, etc.).
• When citing a case, use the format from this judge's prior rulings.
• Do NOT use first-person pronouns ("I"); use "Petitioner/Plaintiff/Defendant" appropriately.
• Section headings in **bold** and ALL CAPS at top level, **bold** mixed-case for sub-sections.
• Pin-cite cases where possible (e.g., "Cardoza-Fonseca, 480 U.S. at 440").
• Block quotes only for definitive holdings under 50 words; otherwise paraphrase.
• Maintain the firm's professional, persuasive but not aggressive tone.
• Address every losing argument preemptively — bury it before opposing counsel raises it.
• If data is insufficient to confirm a fact (a date, dollar amount, witness name), use a clearly marked placeholder like "[DATE]" or "[$AMOUNT]".

OUTPUT: Begin directly with the caption — no preamble, no commentary. End with the signature block.`;
}

// ============================================================
//  STEP 7 — CALL CLAUDE TO GENERATE BRIEF
// ============================================================
async function callClaudeForBrief(prompt) {
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 120000,
      }
    );
    return resp.data.content[0]?.text?.trim() || "";
  } catch (err) {
    console.error("[brief-gen] Claude call failed:", err.message);
    throw err;
  }
}

// ============================================================
//  FORMAT BRIEF FOR JJ — adds metadata header
// ============================================================
function formatBriefForDisplay(result) {
  if (!result || !result.brief) return "Brief generation failed.";

  const m = result.metadata || {};
  let out = "📝 MOTION BRIEF — DRAFT\n";
  out += "═".repeat(60) + "\n";
  out += `Generated:    ${new Date(m.generated_at).toLocaleString()}\n`;
  out += `Judge:        ${m.judge}\n`;
  out += `Court:        ${m.court}\n`;
  out += `Motion:       ${m.motion_type}\n`;
  out += `Practice:     ${m.practice_area || "general"}\n`;
  out += "─".repeat(60) + "\n";
  out += "DATA SOURCES USED:\n";
  out += `  • ${m.data_sources.judge_rulings_analyzed} prior rulings analyzed for this judge\n`;
  out += `  • ${m.data_sources.winning_args_used} proven winning arguments incorporated\n`;
  out += `  • ${m.data_sources.losing_args_anticipated} losing arguments preempted\n`;
  out += `  • ${m.data_sources.peer_judges_referenced} peer judges referenced\n`;
  out += `  • ${m.data_sources.supporting_cases} supporting cases pulled from CourtListener\n`;
  out += "═".repeat(60) + "\n\n";
  out += result.brief;
  out += "\n\n" + "═".repeat(60) + "\n";
  out += "⚠️  ATTORNEY REVIEW REQUIRED:\n";
  m.caveats.forEach(c => out += `  • ${c}\n`);

  return out;
}

// ============================================================
//  CLI MODE
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const m = args.find(a => a.startsWith(`--${name}=`));
    return m ? m.split("=").slice(1).join("=") : null;
  };

  if (args.includes("--help") || !getArg("judge")) {
    console.log(`
ZARA BRIEF GENERATOR (Layer 3)

Usage:
  node brief-generator.js --judge="Wardlaw" --motion="Asylum" --area="immigration" --facts-file=facts.txt --court="9th Circuit"

Required:
  --judge="Last name"          The judge or panel name
  --motion="Motion type"       e.g. Demurrer, MSJ, Asylum, Anti-SLAPP

Optional:
  --area="practice area"       immigration|civil|eviction|pi|estate|business|employment|federal
  --court="Court name"         e.g. "9th Circuit", "CACD", "San Bernardino"
  --facts="..."                Or use --facts-file
  --facts-file=path/to.txt     Read facts from file
  --relief="..."               Desired relief
  --case="Case Name"           e.g. "Doe v. Garland"
  --case-no="..."              Case number
  --party="Petitioner"         Party represented
  --opposing="arg 1|arg 2"     Pipe-separated opposing arguments
  --output=brief.txt           Write output to file (else stdout)

Example:
  node brief-generator.js \\
    --judge="Wardlaw" \\
    --motion="Motion to Reopen" \\
    --area="immigration" \\
    --court="9th Circuit" \\
    --facts-file=./facts.txt \\
    --relief="Reverse BIA's denial of motion to reopen" \\
    --opposing="Country conditions unchanged|MTR untimely"
    `);
    process.exit(0);
  }

  (async () => {
    try {
      let facts = getArg("facts");
      const factsFile = getArg("facts-file");
      if (factsFile && require("fs").existsSync(factsFile)) {
        facts = require("fs").readFileSync(factsFile, "utf8");
      }

      if (!facts) {
        console.error("Error: --facts or --facts-file required");
        process.exit(1);
      }

      const opposing = getArg("opposing");
      const opposingArgs = opposing ? opposing.split("|").map(s => s.trim()) : [];

      const result = await generateBrief({
        judgeName:        getArg("judge"),
        court:            getArg("court"),
        motionType:       getArg("motion"),
        practiceArea:     getArg("area"),
        facts:            facts,
        desiredRelief:    getArg("relief"),
        caseName:         getArg("case"),
        caseNumber:       getArg("case-no"),
        partyRepresented: getArg("party"),
        opposingArguments: opposingArgs,
      });

      const formatted = formatBriefForDisplay(result);
      const outFile = getArg("output");

      if (outFile) {
        require("fs").writeFileSync(outFile, formatted);
        console.log(`✅ Brief written to ${outFile}`);
      } else {
        console.log(formatted);
      }

      process.exit(0);
    } catch (err) {
      console.error("Brief generation failed:", err.message);
      console.error(err.stack);
      process.exit(1);
    }
  })();
}

module.exports = {
  generateBrief,
  formatBriefForDisplay,
  getJudgeIntelligence,
  getMotionIntelligence,
  getJuryInstructionElements,
};
