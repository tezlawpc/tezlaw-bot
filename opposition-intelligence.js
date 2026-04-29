// ============================================================
//  opposition-intelligence.js — Layer 4
//  Tez Law P.C. | Zara Legal Intelligence Stack
//
//  WHAT IT DOES:
//  Analyzes opposing counsel's brief and predicts how the
//  assigned judge will respond to each argument, based on:
//    • Layer 1 judge profiles (accepted/rejected arguments)
//    • Layer 2 motion intelligence (winning/losing patterns)
//    • Layer 3 brief generator (now used in reverse —
//      to deconstruct opposing arguments)
//
//  OUTPUT: A structured analysis document containing:
//    1. Summary of opposing counsel's arguments (numbered list)
//    2. Per-argument prediction: how this judge has responded
//       to similar arguments before (with confidence score)
//    3. Recommended counter-arguments to lead with in your reply
//    4. Suggested rebuttal language calibrated to the judge
//    5. Risk assessment: which opposing arguments are most
//       dangerous before this specific judge
//    6. Optional draft reply brief generated from the analysis
//
//  HOW TO CALL:
//  const { analyzeOpposition } = require("./opposition-intelligence");
//  const result = await analyzeOpposition({
//    judgeName:      "Wardlaw",
//    court:          "9th Circuit",
//    motionType:     "Asylum",
//    practiceArea:   "immigration",
//    opposingBrief:  "...full text or summary...",
//    yourPosition:   "Petitioner seeks reversal of BIA denial",
//    facts:          "...case facts...",
//    generateReply:  true,    // optional — auto-draft reply brief
//  });
//
//  CLI MODE:
//  node opposition-intelligence.js \
//    --judge="Wardlaw" \
//    --motion="Asylum" \
//    --area="immigration" \
//    --court="9th Circuit" \
//    --opposing-file=opposing-brief.txt \
//    --facts-file=facts.txt \
//    --generate-reply \
//    --output=analysis.txt
// ============================================================

const axios = require("axios");
const db    = require("./db");

const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const COURTLISTENER_TOKEN = process.env.COURTLISTENER_TOKEN;

// Reuse Layer 1/2 helpers if Layer 3 is deployed
let layer3 = null;
try { layer3 = require("./brief-generator"); } catch (e) { /* optional */ }

// ============================================================
//  CORE: ANALYZE OPPOSITION
// ============================================================
async function analyzeOpposition({
  judgeName,
  court           = null,
  motionType,
  practiceArea    = null,
  opposingBrief,
  yourPosition    = null,
  facts           = null,
  caseNumber      = null,
  caseName        = null,
  generateReply   = false,
}) {
  if (!judgeName || !motionType || !opposingBrief) {
    throw new Error("analyzeOpposition requires judgeName, motionType, opposingBrief");
  }

  console.log(`[oppo-intel] 🔎 Analyzing opposition for ${judgeName} on ${motionType}`);

  // ── Step 1: Pull judge intelligence ────────────────────
  const judgeProfile = await getJudgeIntelligence(judgeName, court, motionType);

  // ── Step 2: Pull motion intelligence ───────────────────
  const motionIntel = await getMotionIntelligence(judgeName, court, motionType, practiceArea);

  // ── Step 3: Extract opposing arguments ─────────────────
  console.log(`[oppo-intel] 📋 Extracting opposing arguments...`);
  const extractedArgs = await extractOpposingArguments({
    opposingBrief, motionType, practiceArea,
  });

  if (!extractedArgs || !extractedArgs.arguments?.length) {
    throw new Error("Failed to extract any arguments from opposing brief");
  }

  console.log(`[oppo-intel] Found ${extractedArgs.arguments.length} opposing arguments`);

  // ── Step 4: Per-argument prediction ────────────────────
  console.log(`[oppo-intel] 🎯 Predicting judge response to each argument...`);
  const predictions = [];
  for (const arg of extractedArgs.arguments) {
    const prediction = await predictJudgeResponse({
      argument: arg,
      judgeProfile, motionIntel, motionType, practiceArea,
    });
    predictions.push(prediction);
  }

  // ── Step 5: Risk assessment ────────────────────────────
  const riskAssessment = assessRisks(predictions);

  // ── Step 6: Generate counter-arguments ─────────────────
  console.log(`[oppo-intel] ⚔️  Building counter-argument strategy...`);
  const counterStrategy = await buildCounterStrategy({
    extractedArgs, predictions, judgeProfile, motionIntel,
    motionType, practiceArea, yourPosition, facts,
  });

  // ── Step 7: Optional — generate reply brief ────────────
  let replyBrief = null;
  if (generateReply && layer3 && facts) {
    console.log(`[oppo-intel] 📝 Generating draft reply brief...`);
    try {
      // Pass the LOSING-from-judge's-perspective opposing args
      // as the "opposing arguments to refute" parameter to Layer 3
      const opposingArgsForReply = extractedArgs.arguments.map(a => a.text);
      const briefResult = await layer3.generateBrief({
        judgeName, court, motionType, practiceArea,
        facts,
        desiredRelief: yourPosition,
        opposingArguments: opposingArgsForReply,
        caseNumber, caseName,
      });
      replyBrief = briefResult.brief;
    } catch (err) {
      console.error("[oppo-intel] Reply brief generation failed:", err.message);
    }
  }

  // ── Step 8: Assemble result ────────────────────────────
  return {
    metadata: {
      generated_at:   new Date().toISOString(),
      judge:          judgeName,
      court:          court || judgeProfile?.court || "Unknown",
      motion_type:    motionType,
      practice_area:  practiceArea,
      data_sources: {
        judge_rulings_analyzed: judgeProfile?.total_rulings || 0,
        opposing_args_found:    extractedArgs.arguments.length,
        predictions_made:       predictions.length,
      },
    },
    summary:        extractedArgs.summary,
    arguments:      extractedArgs.arguments,
    predictions:    predictions,
    risk:           riskAssessment,
    counterStrategy: counterStrategy,
    replyBrief:     replyBrief,
    caveats: [
      "AI-generated analysis — attorney must verify every prediction against current case law.",
      "Predictions are based on historical patterns, not guarantees of judicial behavior.",
      "Confidence scores reflect data sample size; low-confidence predictions are weakly supported.",
      "Verify all citations in vLex Fastcase before any filing.",
    ],
  };
}

// ============================================================
//  STEP 1 — JUDGE INTELLIGENCE (same query Layer 3 uses)
// ============================================================
async function getJudgeIntelligence(judgeName, court, motionType) {
  if (layer3?.getJudgeIntelligence) {
    return await layer3.getJudgeIntelligence(judgeName, court, motionType);
  }

  // Fallback if Layer 3 not deployed
  try {
    let query = `
      SELECT jp.judge_name, jp.court, jp.court_type, jp.total_rulings,
        ji.motion_type, ji.grant_count, ji.deny_count,
        ji.key_phrases, ji.accepted_args, ji.rejected_args,
        ji.cited_statutes, ji.cited_cases, ji.reasoning_style, ji.sample_language,
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
    query += " ORDER BY jp.total_rulings DESC LIMIT 5";

    const result = await db.query(query, params);
    if (!result.rows.length) return null;

    const profile = result.rows[0];
    const accepted = new Set(), rejected = new Set(), phrases = new Set();
    const statutes = new Set(), cases = new Set();

    for (const row of result.rows) {
      (row.key_phrases   || []).forEach(p => p && phrases.add(p));
      (row.accepted_args || []).forEach(a => a && accepted.add(a));
      (row.rejected_args || []).forEach(a => a && rejected.add(a));
      (row.cited_statutes|| []).forEach(s => s && statutes.add(s));
      (row.cited_cases   || []).forEach(c => c && cases.add(c));
    }

    return {
      judge_name:       profile.judge_name,
      court:            profile.court,
      court_type:       profile.court_type,
      total_rulings:    profile.total_rulings,
      grant_rate:       profile.grant_rate,
      reasoning_style:  profile.reasoning_style,
      sample_language:  profile.sample_language,
      key_phrases:      [...phrases].slice(0, 12),
      accepted_args:    [...accepted].slice(0, 10),
      rejected_args:    [...rejected].slice(0, 10),
      cited_statutes:   [...statutes].slice(0, 12),
      cited_cases:      [...cases].slice(0, 12),
    };
  } catch (err) {
    console.error("[oppo-intel] Judge intel error:", err.message);
    return null;
  }
}

// ============================================================
//  STEP 2 — MOTION INTELLIGENCE
// ============================================================
async function getMotionIntelligence(judgeName, court, motionType, practiceArea) {
  if (layer3?.getMotionIntelligence) {
    return await layer3.getMotionIntelligence(judgeName, court, motionType, practiceArea);
  }

  // Fallback if Layer 3 not deployed
  try {
    const winQuery = await db.query(`
      SELECT argument_text, frequency, example_language, why_it_worked
      FROM motion_arguments
      WHERE judge_name ILIKE $1 AND argument_type = 'winning' AND motion_type ILIKE $2
      ORDER BY frequency DESC LIMIT 10
    `, [`%${judgeName}%`, `%${motionType}%`]);

    const lossQuery = await db.query(`
      SELECT argument_text, frequency, why_it_failed
      FROM motion_arguments
      WHERE judge_name ILIKE $1 AND argument_type = 'losing' AND motion_type ILIKE $2
      ORDER BY frequency DESC LIMIT 10
    `, [`%${judgeName}%`, `%${motionType}%`]);

    return {
      winning:  winQuery.rows,
      losing:   lossQuery.rows,
    };
  } catch (err) {
    return { winning: [], losing: [] };
  }
}

// ============================================================
//  STEP 3 — EXTRACT OPPOSING ARGUMENTS
//  Use Claude to parse opposing brief into structured arguments
// ============================================================
async function extractOpposingArguments({ opposingBrief, motionType, practiceArea }) {
  // Trim opposing brief if very long (preserve start/end which usually have args)
  const briefText = opposingBrief.length > 15000
    ? opposingBrief.substring(0, 8000) + "\n\n[...middle truncated...]\n\n" + opposingBrief.substring(opposingBrief.length - 4000)
    : opposingBrief;

  const prompt = `You are analyzing opposing counsel's brief on a ${motionType} in ${practiceArea || "general civil"} matter.

OPPOSING COUNSEL'S BRIEF:
${briefText}

Extract opposing counsel's arguments in structured form. Identify:
1. The MAIN arguments (top-level legal claims they make)
2. The reasoning/authority each argument relies on
3. The relief they seek

Return ONLY valid JSON in this exact structure:
{
  "summary": "1-2 sentence overall summary of opposing counsel's position",
  "relief_sought": "what opposing counsel asks the court to do",
  "arguments": [
    {
      "id": 1,
      "text": "concise statement of the argument (one sentence)",
      "reasoning": "the legal/factual reasoning behind it (1-3 sentences)",
      "authorities_cited": ["case 1", "statute 1", "..."],
      "argument_type": "legal_standard|factual|procedural|equitable|policy",
      "vulnerability_points": ["weak link 1", "weak link 2"]
    }
  ]
}

Extract 3-8 arguments. Focus on substantive legal arguments, not procedural noise.
NO commentary outside the JSON. Begin with { and end with }.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-5-20250929",
        max_tokens: 3500,
        messages: [{ role: "user", content: prompt }],
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
    const text = resp.data.content[0]?.text?.trim() || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return safeJsonParse(clean) || { summary: "", arguments: [] };
  } catch (err) {
    console.error("[oppo-intel] Argument extraction failed:", err.message);
    return null;
  }
}

// ============================================================
//  STEP 4 — PREDICT JUDGE RESPONSE TO EACH ARGUMENT
// ============================================================
async function predictJudgeResponse({ argument, judgeProfile, motionIntel, motionType, practiceArea }) {
  const judgeBlock = judgeProfile ? `
JUDGE: ${judgeProfile.judge_name} (${judgeProfile.court})
Total rulings analyzed: ${judgeProfile.total_rulings}
Grant rate on ${motionType}: ${judgeProfile.grant_rate || "n/a"}%
Reasoning style: ${judgeProfile.reasoning_style || "Not characterized"}

ARGUMENTS THIS JUDGE HAS ACCEPTED:
${(judgeProfile.accepted_args || []).slice(0,8).map((a, i) => `  ${i+1}. ${a}`).join("\n") || "  (none captured)"}

ARGUMENTS THIS JUDGE HAS REJECTED:
${(judgeProfile.rejected_args || []).slice(0,8).map((a, i) => `  ${i+1}. ${a}`).join("\n") || "  (none captured)"}

LANGUAGE PATTERNS:
${(judgeProfile.key_phrases || []).slice(0,6).map(p => `  • "${p}"`).join("\n")}

STATUTES THIS JUDGE CITES:
${(judgeProfile.cited_statutes || []).slice(0,8).join(", ")}
` : `JUDGE: ${argument.judge_name || "Unknown"}\nNo profile data available — predictions will be based on general patterns.`;

  const motionBlock = motionIntel?.winning?.length || motionIntel?.losing?.length ? `
KNOWN PATTERNS BEFORE THIS JUDGE:
Winning argument types: ${(motionIntel.winning || []).slice(0,5).map(w => w.argument_text).join(" | ")}
Losing argument types:  ${(motionIntel.losing || []).slice(0,5).map(l => l.argument_text).join(" | ")}
` : "";

  const prompt = `Predict how a specific judge will respond to a single argument made by opposing counsel.

${judgeBlock}
${motionBlock}

OPPOSING COUNSEL'S ARGUMENT (#${argument.id}):
"${argument.text}"

REASONING THEY OFFER:
${argument.reasoning}

AUTHORITIES THEY CITE:
${(argument.authorities_cited || []).join(", ") || "None specified"}

VULNERABILITY POINTS YOU IDENTIFIED:
${(argument.vulnerability_points || []).join(", ") || "None specified"}

Predict this judge's response. Return ONLY valid JSON:
{
  "argument_id": ${argument.id},
  "likely_outcome": "ACCEPT|LIKELY_ACCEPT|UNCERTAIN|LIKELY_REJECT|REJECT",
  "confidence": "HIGH|MEDIUM|LOW",
  "reasoning": "Why this judge will likely respond this way (2-4 sentences). Reference specific past patterns, accepted/rejected arguments, or language preferences.",
  "judge_likely_phrasing": "Quote-style snippet of language this judge might use, mirroring their captured phrasings",
  "key_weakness": "The single biggest weakness in opposing counsel's argument before THIS judge",
  "best_attack_angle": "The most effective way to undermine this argument given this judge's pattern"
}

NO commentary outside the JSON. Begin with { and end with }.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-5-20250929",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 45000,
      }
    );
    const text = resp.data.content[0]?.text?.trim() || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = safeJsonParse(clean);
    return parsed || {
      argument_id: argument.id,
      likely_outcome: "UNCERTAIN",
      confidence: "LOW",
      reasoning: "Could not generate prediction — extraction failed.",
    };
  } catch (err) {
    console.error(`[oppo-intel] Prediction failed for arg ${argument.id}:`, err.message);
    return {
      argument_id: argument.id,
      likely_outcome: "UNCERTAIN",
      confidence: "LOW",
      reasoning: "Prediction generation failed.",
    };
  }
}

// ============================================================
//  STEP 5 — RISK ASSESSMENT
//  Aggregate predictions into a risk overview
// ============================================================
function assessRisks(predictions) {
  const counts = {
    ACCEPT: 0, LIKELY_ACCEPT: 0, UNCERTAIN: 0, LIKELY_REJECT: 0, REJECT: 0,
  };
  const dangerous = [];

  for (const p of predictions) {
    if (p.likely_outcome) counts[p.likely_outcome] = (counts[p.likely_outcome] || 0) + 1;

    if (["ACCEPT", "LIKELY_ACCEPT"].includes(p.likely_outcome)) {
      dangerous.push({
        argument_id: p.argument_id,
        outcome:     p.likely_outcome,
        confidence:  p.confidence,
        weakness:    p.key_weakness,
      });
    }
  }

  const total = predictions.length;
  const acceptanceRisk = total
    ? Math.round(((counts.ACCEPT * 1.0 + counts.LIKELY_ACCEPT * 0.7 + counts.UNCERTAIN * 0.4) / total) * 100)
    : 0;

  let overall = "LOW";
  if (acceptanceRisk >= 60) overall = "HIGH";
  else if (acceptanceRisk >= 35) overall = "MODERATE";

  return {
    overall_risk:    overall,
    acceptance_risk_score: acceptanceRisk,
    distribution:    counts,
    dangerous_arguments: dangerous.sort((a, b) => {
      // Sort dangerous args by how confident the prediction is
      const confRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return (confRank[b.confidence] || 0) - (confRank[a.confidence] || 0);
    }),
  };
}

// ============================================================
//  STEP 6 — BUILD COUNTER-STRATEGY
// ============================================================
async function buildCounterStrategy({
  extractedArgs, predictions, judgeProfile, motionIntel,
  motionType, practiceArea, yourPosition, facts,
}) {
  // Pair each opposing argument with its prediction
  const pairs = extractedArgs.arguments.map(a => ({
    argument:   a,
    prediction: predictions.find(p => p.argument_id === a.id) || {},
  }));

  const opposingArgsBlock = pairs.map((p, i) => `
ARGUMENT ${p.argument.id}: "${p.argument.text}"
  Prediction: ${p.prediction.likely_outcome || "UNCERTAIN"} (confidence: ${p.prediction.confidence || "LOW"})
  Best attack angle: ${p.prediction.best_attack_angle || "Standard refutation"}
  Key weakness: ${p.prediction.key_weakness || "Not identified"}`).join("\n");

  const judgeBlock = judgeProfile ? `
JUDGE PROFILE (${judgeProfile.judge_name}):
Accepted argument patterns: ${(judgeProfile.accepted_args || []).slice(0,5).join(" | ")}
Rejected argument patterns: ${(judgeProfile.rejected_args || []).slice(0,5).join(" | ")}
Language patterns: ${(judgeProfile.key_phrases || []).slice(0,4).map(p => `"${p}"`).join(", ")}
Statutes cited: ${(judgeProfile.cited_statutes || []).slice(0,6).join(", ")}
` : "";

  const prompt = `Build a counter-argument strategy for responding to opposing counsel's brief before a specific judge.

CONTEXT:
Motion type: ${motionType}
Practice area: ${practiceArea || "general civil"}
Your position: ${yourPosition || "(not specified)"}
${facts ? `\nCASE FACTS:\n${facts.substring(0, 1500)}` : ""}

${judgeBlock}

OPPOSING ARGUMENTS WITH PREDICTIONS:
${opposingArgsBlock}

Build a counter-argument strategy. Return ONLY valid JSON:
{
  "lead_with": "The single strongest counter-argument to lead your reply with — and why this judge will respond best to it",
  "counter_arguments": [
    {
      "responds_to_argument_id": 1,
      "counter": "Direct rebuttal language calibrated to this judge",
      "supporting_authority": "Specific case/statute to cite (use only authorities the judge has cited or foundational ones)",
      "rhetorical_approach": "How to frame this — e.g., 'distinguish factually', 'concede legal standard but reframe application', 'attack premise', etc.",
      "judge_calibrated_phrasing": "Sample sentence using language patterns similar to this judge's"
    }
  ],
  "preemptive_concessions": ["Things to concede early to build credibility (1-3 items)"],
  "strategic_priorities": ["Top 3 priorities for the reply brief, in order"],
  "themes_to_avoid": ["Argument types this judge has rejected — don't use these (1-3 items)"],
  "tone_recommendation": "How to pitch the reply — formal/aggressive/measured/equitable, with brief reasoning"
}

NO commentary outside JSON. Begin with { and end with }.`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-5-20250929",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
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
    const text = resp.data.content[0]?.text?.trim() || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return safeJsonParse(clean) || {
      lead_with: "Strategy generation failed",
      counter_arguments: [],
    };
  } catch (err) {
    console.error("[oppo-intel] Counter-strategy failed:", err.message);
    return null;
  }
}

// ============================================================
//  SAFE JSON PARSE — handles truncation
// ============================================================
function safeJsonParse(text) {
  if (!text || text.length < 5) return null;

  // First try: direct parse
  try { return JSON.parse(text); } catch (e) {}

  // Second try: trim to last valid closing brace
  let depth = 0;
  let lastValidEnd = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) lastValidEnd = i;
    }
  }
  if (lastValidEnd > 0) {
    try { return JSON.parse(text.substring(0, lastValidEnd + 1)); } catch (e) {}
  }

  // Third try: regex first complete object
  const match = text.match(/\{[\s\S]*?\}(?=[^}]*$)/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) {}
  }

  return null;
}

// ============================================================
//  FORMAT FOR DISPLAY
// ============================================================
function formatAnalysis(result) {
  if (!result) return "Analysis failed.";

  const m = result.metadata || {};
  let out = "🛡️  OPPOSITION INTELLIGENCE — ANALYSIS\n";
  out += "═".repeat(60) + "\n";
  out += `Generated:    ${new Date(m.generated_at).toLocaleString()}\n`;
  out += `Judge:        ${m.judge}\n`;
  out += `Court:        ${m.court}\n`;
  out += `Motion:       ${m.motion_type}\n`;
  out += `Practice:     ${m.practice_area || "general"}\n`;
  out += "─".repeat(60) + "\n";
  out += "DATA SOURCES:\n";
  out += `  • ${m.data_sources.judge_rulings_analyzed} prior rulings analyzed for this judge\n`;
  out += `  • ${m.data_sources.opposing_args_found} opposing arguments extracted\n`;
  out += `  • ${m.data_sources.predictions_made} predictions generated\n`;
  out += "═".repeat(60) + "\n\n";

  // ── Opposing summary ─────────────────────────────────
  out += "📋 OPPOSING COUNSEL'S POSITION\n";
  out += "─".repeat(60) + "\n";
  out += `${result.summary}\n\n`;

  // ── Risk overview ────────────────────────────────────
  out += "⚠️  RISK ASSESSMENT\n";
  out += "─".repeat(60) + "\n";
  const r = result.risk;
  out += `Overall risk to your position: ${r.overall_risk}\n`;
  out += `Acceptance-risk score: ${r.acceptance_risk_score}/100\n`;
  out += `Argument outcome distribution:\n`;
  Object.entries(r.distribution).forEach(([k, v]) => {
    if (v > 0) out += `  ${k.padEnd(15)} ${"█".repeat(Math.min(v, 10))} ${v}\n`;
  });
  if (r.dangerous_arguments.length) {
    out += `\nMost dangerous opposing arguments (likely to succeed):\n`;
    r.dangerous_arguments.forEach(d => {
      out += `  ⚡ Argument #${d.argument_id} — ${d.outcome} (confidence: ${d.confidence})\n`;
      if (d.weakness) out += `     Key weakness to attack: ${d.weakness}\n`;
    });
  }
  out += "\n";

  // ── Per-argument predictions ─────────────────────────
  out += "🎯 ARGUMENT-BY-ARGUMENT PREDICTIONS\n";
  out += "─".repeat(60) + "\n";
  for (const arg of result.arguments) {
    const pred = result.predictions.find(p => p.argument_id === arg.id) || {};
    out += `\n[Argument ${arg.id}] ${arg.text}\n`;
    out += `  Type: ${arg.argument_type || "unspecified"}\n`;
    out += `  Reasoning: ${arg.reasoning}\n`;
    if (arg.authorities_cited?.length) {
      out += `  Cites: ${arg.authorities_cited.join(", ")}\n`;
    }
    out += `  ─\n`;
    out += `  📊 Prediction: ${pred.likely_outcome || "UNCERTAIN"} (confidence: ${pred.confidence || "LOW"})\n`;
    out += `  💭 Why: ${pred.reasoning || "n/a"}\n`;
    if (pred.judge_likely_phrasing) {
      out += `  🗣️  Judge's likely phrasing: "${pred.judge_likely_phrasing}"\n`;
    }
    if (pred.key_weakness) {
      out += `  💥 Key weakness: ${pred.key_weakness}\n`;
    }
    if (pred.best_attack_angle) {
      out += `  ⚔️  Best attack: ${pred.best_attack_angle}\n`;
    }
  }
  out += "\n";

  // ── Counter-strategy ─────────────────────────────────
  if (result.counterStrategy) {
    const cs = result.counterStrategy;
    out += "⚔️  COUNTER-ARGUMENT STRATEGY\n";
    out += "─".repeat(60) + "\n";
    out += `🎯 LEAD WITH: ${cs.lead_with || "(no recommendation)"}\n\n`;

    if (cs.strategic_priorities?.length) {
      out += "Strategic priorities for your reply:\n";
      cs.strategic_priorities.forEach((p, i) => out += `  ${i+1}. ${p}\n`);
      out += "\n";
    }

    if (cs.preemptive_concessions?.length) {
      out += "Concede early to build credibility:\n";
      cs.preemptive_concessions.forEach(c => out += `  ✓ ${c}\n`);
      out += "\n";
    }

    if (cs.themes_to_avoid?.length) {
      out += "DO NOT USE these argument types (this judge rejects them):\n";
      cs.themes_to_avoid.forEach(t => out += `  ✗ ${t}\n`);
      out += "\n";
    }

    if (cs.tone_recommendation) {
      out += `Tone: ${cs.tone_recommendation}\n\n`;
    }

    if (cs.counter_arguments?.length) {
      out += "Counter-arguments to deploy:\n\n";
      cs.counter_arguments.forEach((ca, i) => {
        out += `[Counter ${i+1}] Responds to opposing argument #${ca.responds_to_argument_id}\n`;
        out += `  Rebuttal: ${ca.counter}\n`;
        if (ca.supporting_authority) out += `  Authority: ${ca.supporting_authority}\n`;
        if (ca.rhetorical_approach) out += `  Approach: ${ca.rhetorical_approach}\n`;
        if (ca.judge_calibrated_phrasing) out += `  Sample language: "${ca.judge_calibrated_phrasing}"\n`;
        out += "\n";
      });
    }
  }

  // ── Reply brief (if generated) ───────────────────────
  if (result.replyBrief) {
    out += "═".repeat(60) + "\n";
    out += "📝 DRAFT REPLY BRIEF (generated by Layer 3)\n";
    out += "═".repeat(60) + "\n\n";
    out += result.replyBrief;
    out += "\n";
  }

  // ── Caveats ──────────────────────────────────────────
  out += "\n" + "═".repeat(60) + "\n";
  out += "⚠️  ATTORNEY REVIEW REQUIRED:\n";
  result.caveats.forEach(c => out += `  • ${c}\n`);

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
  const hasFlag = (name) => args.includes(`--${name}`);

  if (hasFlag("help") || (!getArg("judge") && !hasFlag("test"))) {
    console.log(`
ZARA OPPOSITION INTELLIGENCE (Layer 4)

Usage:
  node opposition-intelligence.js \\
    --judge="Wardlaw" \\
    --motion="Asylum" \\
    --area="immigration" \\
    --court="9th Circuit" \\
    --opposing-file=./opposing-brief.txt \\
    --facts-file=./facts.txt \\
    --your-position="Affirm IJ's grant of asylum"

Required:
  --judge="Last name"          Judge or panel name
  --motion="Motion type"       e.g. Demurrer, MSJ, Asylum, Anti-SLAPP
  --opposing OR --opposing-file  Opposing brief text (or path to file)

Optional:
  --area="practice area"       immigration|civil|eviction|pi|estate|business|employment|federal
  --court="Court name"         e.g. "9th Circuit", "BIA", "CACD"
  --your-position="..."        Your desired outcome
  --facts="..." OR --facts-file=path  Case facts (required for reply brief)
  --case="Case Name"           e.g. "Doe v. Garland"
  --case-no="..."              Case number
  --generate-reply             Auto-draft a reply brief using Layer 3
  --output=analysis.txt        Write output to file (else stdout)

Example:
  node opposition-intelligence.js \\
    --judge="Malphrus" \\
    --motion="Continuance Appeal" \\
    --area="immigration" \\
    --court="BIA" \\
    --opposing-file=./dhs-brief.txt \\
    --facts-file=./case-facts.txt \\
    --your-position="Affirm continuance order" \\
    --generate-reply \\
    --output=oppo-analysis.txt
    `);
    process.exit(0);
  }

  (async () => {
    try {
      let opposingBrief = getArg("opposing");
      const opposingFile = getArg("opposing-file");
      if (opposingFile && require("fs").existsSync(opposingFile)) {
        opposingBrief = require("fs").readFileSync(opposingFile, "utf8");
      }
      if (!opposingBrief) {
        console.error("Error: --opposing or --opposing-file required");
        process.exit(1);
      }

      let facts = getArg("facts");
      const factsFile = getArg("facts-file");
      if (factsFile && require("fs").existsSync(factsFile)) {
        facts = require("fs").readFileSync(factsFile, "utf8");
      }

      const result = await analyzeOpposition({
        judgeName:     getArg("judge"),
        court:         getArg("court"),
        motionType:    getArg("motion"),
        practiceArea:  getArg("area"),
        opposingBrief: opposingBrief,
        yourPosition:  getArg("your-position"),
        facts:         facts,
        caseName:      getArg("case"),
        caseNumber:    getArg("case-no"),
        generateReply: hasFlag("generate-reply"),
      });

      const formatted = formatAnalysis(result);
      const outFile = getArg("output");
      if (outFile) {
        require("fs").writeFileSync(outFile, formatted);
        console.log(`✅ Analysis written to ${outFile}`);
      } else {
        console.log(formatted);
      }
      process.exit(0);
    } catch (err) {
      console.error("Opposition analysis failed:", err.message);
      console.error(err.stack);
      process.exit(1);
    }
  })();
}

module.exports = {
  analyzeOpposition,
  formatAnalysis,
  extractOpposingArguments,
  predictJudgeResponse,
  buildCounterStrategy,
};
