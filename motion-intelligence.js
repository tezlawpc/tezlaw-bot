// ============================================================
//  motion-intelligence.js — Layer 2: Motion Intelligence
//  Tez Law P.C. | Zara Legal Intelligence Stack
//
//  WHAT THIS DOES:
//  Goes beyond surface outcome data (grant/deny rates) to extract
//  the FULL LEGAL REASONING from each opinion — the arguments
//  judges find convincing, the structures they respond to,
//  the language they use when they agree vs disagree.
//
//  This powers:
//  → Layer 3: Brief Generator (drafts calibrated to judge)
//  → Layer 4: Opposition Intelligence (finds weaknesses in opposing briefs)
//
//  DATABASE TABLES:
//  motion_arguments    — winning/losing argument structures per judge
//  motion_frameworks   — brief structures that work per judge per motion
//  reasoning_patterns  — judge's reasoning chains, logic flows
//
//  USAGE:
//  Called automatically by judge-scanner.js during scan
//  Called by daily digest for new high-relevance opinions
//  Queried by brief-generator.js when drafting motions
// ============================================================

const axios = require("axios");
const db    = require("./db");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Motion types we deeply analyze ──────────────────────────
const DEEP_ANALYSIS_MOTIONS = new Set([
  "Demurrer",
  "MSJ",
  "Motion to Strike",
  "Anti-SLAPP",
  "Preliminary Injunction",
  "Unlawful Detainer",
  "Motion to Compel",
  "Sanctions",
  "Asylum",
  "Removal",
  "Motion to Reopen",
  "Cancellation of Removal",
  "Withholding",
]);

// ── Practice area argument taxonomy ─────────────────────────
// These are the argument categories we track per practice area
const ARGUMENT_TAXONOMY = {
  civil: [
    "failure to state facts", "conclusory allegations", "uncertainty",
    "demurrer to evidence", "economic loss rule", "statute of limitations",
    "lack of standing", "primary assumption of risk", "comparative fault",
    "breach elements", "damages causation", "specific performance",
    "punitive damages", "attorney fees", "injunctive relief standard",
  ],
  immigration: [
    "asylum one year bar", "credibility adverse finding", "particular social group",
    "nexus to protected ground", "internal relocation", "corroboration",
    "country conditions", "past persecution", "well-founded fear",
    "CAT standard", "withholding standard", "motion to reopen deadline",
    "in absentia", "exceptional circumstances", "changed circumstances",
    "continuous presence", "good moral character", "hardship standard",
  ],
  eviction: [
    "proper notice", "notice defects", "just cause requirement",
    "habitability defense", "retaliatory eviction", "unlawful lockout",
    "rent control applicability", "AB 1482 exemption", "owner move-in",
    "substantial compliance", "cure period", "forfeiture",
  ],
  federal: [
    "12(b)(6) plausibility", "Iqbal/Twombly standard", "Rule 56 standard",
    "genuine dispute material fact", "qualified immunity", "standing Article III",
    "mootness", "ripeness", "exhaustion of remedies", "class certification",
    "personal jurisdiction", "subject matter jurisdiction",
  ],
};

// ============================================================
//  DATABASE SETUP — Layer 2 Tables
// ============================================================
async function initMotionIntelligenceTables() {
  try {
    // Winning/losing argument structures per judge per motion type
    await db.query(`
      CREATE TABLE IF NOT EXISTS motion_arguments (
        id                SERIAL PRIMARY KEY,
        judge_name        TEXT NOT NULL,
        court             TEXT NOT NULL,
        motion_type       TEXT NOT NULL,
        practice_area     TEXT,
        argument_text     TEXT NOT NULL,
        argument_category TEXT,
        outcome           TEXT NOT NULL,  -- 'winning' | 'losing' | 'neutral'
        frequency         INTEGER DEFAULT 1,
        confidence        NUMERIC(4,2),   -- 0.0-1.0 based on sample size
        example_case      TEXT,
        example_language  TEXT,           -- exact quote from opinion
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court, motion_type, argument_text)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_motion_args_judge
      ON motion_arguments(judge_name, court, motion_type)
    `);

    // Brief frameworks — structural patterns that work per judge
    await db.query(`
      CREATE TABLE IF NOT EXISTS motion_frameworks (
        id                SERIAL PRIMARY KEY,
        judge_name        TEXT NOT NULL,
        court             TEXT NOT NULL,
        motion_type       TEXT NOT NULL,
        framework_type    TEXT NOT NULL,  -- 'opening' | 'argument' | 'structure' | 'closing'
        description       TEXT NOT NULL,
        example_text      TEXT,
        success_rate      NUMERIC(4,2),
        sample_count      INTEGER DEFAULT 1,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court, motion_type, framework_type)
      )
    `);

    // Reasoning chains — how this judge thinks through each issue
    await db.query(`
      CREATE TABLE IF NOT EXISTS reasoning_patterns (
        id                SERIAL PRIMARY KEY,
        judge_name        TEXT NOT NULL,
        court             TEXT NOT NULL,
        motion_type       TEXT NOT NULL,
        legal_issue       TEXT NOT NULL,
        reasoning_chain   TEXT NOT NULL,  -- step-by-step logic
        key_factors       TEXT[],         -- what tips the scales
        counter_factors   TEXT[],         -- what they dismiss
        standard_applied  TEXT,           -- legal standard they use
        burden_placement  TEXT,           -- who bears burden
        sample_language   TEXT,           -- their exact words
        frequency         INTEGER DEFAULT 1,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court, motion_type, legal_issue)
      )
    `);

    console.log("[motion-intel] ✅ Motion intelligence tables ready");
  } catch (err) {
    console.error("[motion-intel] Table init error:", err.message);
    throw err;
  }
}

// ============================================================
//  DEEP REASONING EXTRACTION
//  Called during scan for high-relevance opinions
//  Uses Sonnet for accuracy on complex reasoning extraction
// ============================================================
async function extractDeepReasoning(ruling) {
  if (!ruling || !ruling.full_text || ruling.full_text.length < 100) return null;
  if (!DEEP_ANALYSIS_MOTIONS.has(ruling.motion_type)) return null;

  const practiceArea = detectPracticeArea(ruling.court, ruling.motion_type);

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages: [{
          role:    "user",
          content: `You are a legal analyst extracting deep reasoning patterns from a court opinion for a judge intelligence database.

Court: ${ruling.court}
Judge: ${ruling.judge_name}
Motion: ${ruling.motion_type}
Result: ${ruling.result}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${ruling.full_text.substring(0, 4000)}

Extract the judge's COMPLETE REASONING STRUCTURE. Focus on:
1. The exact legal standard they applied
2. Why they ruled the way they did — step by step
3. What specific arguments they found convincing
4. What arguments they rejected and why
5. What facts or elements were decisive
6. Their exact language when ruling

Respond ONLY with JSON (empty {} if insufficient text):
{
  "legal_standard": "exact standard applied e.g. 'Iqbal/Twombly plausibility standard'",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ... (judge's actual logic)",
  "decisive_factors": ["what actually tipped the ruling", "max 4 items"],
  "winning_arguments": [
    {
      "argument": "specific argument that worked",
      "why_it_worked": "judge's reasoning for accepting it",
      "exact_language": "quote from opinion under 20 words"
    }
  ],
  "losing_arguments": [
    {
      "argument": "specific argument that failed",
      "why_it_failed": "judge's reasoning for rejecting it",
      "exact_language": "quote from opinion under 20 words"
    }
  ],
  "burden_placement": "who bears burden and how judge described it",
  "key_factors": ["factor 1", "factor 2", "factor 3"],
  "counter_factors": ["what judge dismissed", "max 3"],
  "procedural_notes": "any procedural requirements judge emphasized",
  "drafting_insight": "one sentence: what an attorney should know before filing this motion with this judge"
}`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 25000,
      }
    );

    const text  = resp.data.content[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const data  = JSON.parse(clean);

    if (!data.reasoning_chain && !data.legal_standard) return null;

    return { ...data, practiceArea };

  } catch (err) {
    console.error("[motion-intel] Deep extraction error:", err.message);
    return null;
  }
}

// ============================================================
//  STORE MOTION INTELLIGENCE
//  Persists extracted reasoning to Layer 2 tables
// ============================================================
async function storeMotionIntelligence(ruling, reasoning) {
  if (!reasoning || !ruling.judge_name || !ruling.motion_type) return;

  const { judge_name, court, motion_type } = ruling;
  const practiceArea = reasoning.practiceArea || "general";

  try {
    // Store winning arguments
    if (reasoning.winning_arguments?.length) {
      for (const arg of reasoning.winning_arguments) {
        if (!arg.argument) continue;
        await db.query(`
          INSERT INTO motion_arguments
            (judge_name, court, motion_type, practice_area, argument_text,
             argument_category, outcome, frequency, example_case, example_language)
          VALUES ($1,$2,$3,$4,$5,$6,'winning',1,$7,$8)
          ON CONFLICT (judge_name, court, motion_type, argument_text) DO UPDATE SET
            frequency     = motion_arguments.frequency + 1,
            example_language = COALESCE($8, motion_arguments.example_language),
            updated_at    = NOW()
        `, [
          judge_name, court, motion_type, practiceArea,
          arg.argument.substring(0, 500),
          categorizeArgument(arg.argument, practiceArea),
          ruling.case_name || null,
          arg.exact_language?.substring(0, 300) || null,
        ]);
      }
    }

    // Store losing arguments
    if (reasoning.losing_arguments?.length) {
      for (const arg of reasoning.losing_arguments) {
        if (!arg.argument) continue;
        await db.query(`
          INSERT INTO motion_arguments
            (judge_name, court, motion_type, practice_area, argument_text,
             argument_category, outcome, frequency, example_case, example_language)
          VALUES ($1,$2,$3,$4,$5,$6,'losing',1,$7,$8)
          ON CONFLICT (judge_name, court, motion_type, argument_text) DO UPDATE SET
            frequency     = motion_arguments.frequency + 1,
            example_language = COALESCE($8, motion_arguments.example_language),
            updated_at    = NOW()
        `, [
          judge_name, court, motion_type, practiceArea,
          arg.argument.substring(0, 500),
          categorizeArgument(arg.argument, practiceArea),
          ruling.case_name || null,
          arg.exact_language?.substring(0, 300) || null,
        ]);
      }
    }

    // Store reasoning pattern
    if (reasoning.reasoning_chain) {
      const legalIssue = `${motion_type} — ${reasoning.legal_standard || "general"}`;
      await db.query(`
        INSERT INTO reasoning_patterns
          (judge_name, court, motion_type, legal_issue, reasoning_chain,
           key_factors, counter_factors, standard_applied, burden_placement,
           sample_language, frequency)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
        ON CONFLICT (judge_name, court, motion_type, legal_issue) DO UPDATE SET
          frequency       = reasoning_patterns.frequency + 1,
          reasoning_chain = $5,
          key_factors     = (
            SELECT ARRAY(
              SELECT DISTINCT unnest(reasoning_patterns.key_factors || $6::text[])
              LIMIT 10
            )
          ),
          counter_factors = (
            SELECT ARRAY(
              SELECT DISTINCT unnest(reasoning_patterns.counter_factors || $7::text[])
              LIMIT 10
            )
          ),
          updated_at = NOW()
      `, [
        judge_name, court, motion_type,
        legalIssue.substring(0, 300),
        reasoning.reasoning_chain.substring(0, 2000),
        reasoning.key_factors || [],
        reasoning.counter_factors || [],
        reasoning.legal_standard?.substring(0, 300) || null,
        reasoning.burden_placement?.substring(0, 300) || null,
        reasoning.drafting_insight?.substring(0, 500) || null,
      ]);
    }

    // Store brief framework insight
    if (reasoning.drafting_insight) {
      await db.query(`
        INSERT INTO motion_frameworks
          (judge_name, court, motion_type, framework_type, description,
           example_text, sample_count)
        VALUES ($1,$2,$3,'drafting_insight',$4,$5,1)
        ON CONFLICT (judge_name, court, motion_type, framework_type) DO UPDATE SET
          sample_count = motion_frameworks.sample_count + 1,
          description  = $4
      `, [
        judge_name, court, motion_type,
        reasoning.drafting_insight.substring(0, 500),
        reasoning.procedural_notes?.substring(0, 500) || null,
      ]);
    }

  } catch (err) {
    if (!err.message.includes("duplicate")) {
      console.error("[motion-intel] Store error:", err.message);
    }
  }
}

// ============================================================
//  QUERY MOTION INTELLIGENCE
//  Called by brief-generator.js and JJ mode
// ============================================================
async function getMotionIntelligence(judgeName, court, motionType) {
  try {
    const [args, patterns, frameworks] = await Promise.all([

      // Winning and losing arguments
      db.query(`
        SELECT argument_text, outcome, frequency, example_language, argument_category
        FROM motion_arguments
        WHERE judge_name ILIKE $1
          AND ($2::text IS NULL OR court ILIKE $2)
          AND motion_type ILIKE $3
        ORDER BY frequency DESC, outcome ASC
        LIMIT 20
      `, [`%${judgeName}%`, court ? `%${court}%` : null, `%${motionType}%`]),

      // Reasoning patterns
      db.query(`
        SELECT legal_issue, reasoning_chain, key_factors, counter_factors,
               standard_applied, burden_placement, sample_language, frequency
        FROM reasoning_patterns
        WHERE judge_name ILIKE $1
          AND ($2::text IS NULL OR court ILIKE $2)
          AND motion_type ILIKE $3
        ORDER BY frequency DESC
        LIMIT 5
      `, [`%${judgeName}%`, court ? `%${court}%` : null, `%${motionType}%`]),

      // Brief frameworks
      db.query(`
        SELECT framework_type, description, example_text, sample_count
        FROM motion_frameworks
        WHERE judge_name ILIKE $1
          AND ($2::text IS NULL OR court ILIKE $2)
          AND motion_type ILIKE $3
        ORDER BY sample_count DESC
      `, [`%${judgeName}%`, court ? `%${court}%` : null, `%${motionType}%`]),
    ]);

    const winning = args.rows.filter(r => r.outcome === "winning");
    const losing  = args.rows.filter(r => r.outcome === "losing");

    return {
      judge:      judgeName,
      court:      court || "Unknown",
      motionType,
      winning,
      losing,
      patterns:   patterns.rows,
      frameworks: frameworks.rows,
      hasData:    args.rows.length > 0 || patterns.rows.length > 0,
    };

  } catch (err) {
    console.error("[motion-intel] Query error:", err.message);
    return { judge: judgeName, court, motionType, winning: [], losing: [], patterns: [], frameworks: [], hasData: false };
  }
}

// ============================================================
//  FORMAT MOTION INTELLIGENCE FOR JJ
//  Returns a clean readable summary for Telegram
// ============================================================
async function formatMotionIntelligenceForJJ(judgeName, court, motionType) {
  const intel = await getMotionIntelligence(judgeName, court, motionType);

  if (!intel.hasData) {
    return `⚖️ No motion intelligence yet for ${judgeName} — ${motionType}\n\nZara is still building this profile from scanned opinions. Check back after the daily digest runs a few times, or run the scanner against more historical opinions.`;
  }

  let out = `🧠 MOTION INTELLIGENCE: ${judgeName}\n`;
  out    += `📋 Motion: ${motionType}`;
  if (court) out += ` | Court: ${court}`;
  out    += `\n${"─".repeat(50)}\n\n`;

  // Reasoning standard
  const pattern = intel.patterns[0];
  if (pattern?.standard_applied) {
    out += `⚖️ STANDARD APPLIED\n${pattern.standard_applied}\n\n`;
  }

  if (pattern?.burden_placement) {
    out += `📌 BURDEN\n${pattern.burden_placement}\n\n`;
  }

  // Winning arguments
  if (intel.winning.length) {
    out += `✅ ARGUMENTS THAT WIN (${intel.winning.length} patterns)\n`;
    intel.winning.slice(0, 5).forEach((a, i) => {
      out += `${i+1}. ${a.argument_text}`;
      if (a.frequency > 1) out += ` (seen ${a.frequency}x)`;
      out += "\n";
      if (a.example_language) out += `   → "${a.example_language}"\n`;
    });
    out += "\n";
  }

  // Losing arguments
  if (intel.losing.length) {
    out += `❌ ARGUMENTS THAT LOSE (${intel.losing.length} patterns)\n`;
    intel.losing.slice(0, 4).forEach((a, i) => {
      out += `${i+1}. ${a.argument_text}`;
      if (a.frequency > 1) out += ` (seen ${a.frequency}x)`;
      out += "\n";
      if (a.example_language) out += `   → "${a.example_language}"\n`;
    });
    out += "\n";
  }

  // Reasoning chain
  if (pattern?.reasoning_chain) {
    out += `🔗 HOW THIS JUDGE THINKS\n${pattern.reasoning_chain.substring(0, 400)}\n\n`;
  }

  // Key factors
  if (pattern?.key_factors?.length) {
    out += `🎯 DECISIVE FACTORS\n`;
    pattern.key_factors.slice(0, 4).forEach(f => out += `  • ${f}\n`);
    out += "\n";
  }

  // Drafting insight
  const framework = intel.frameworks.find(f => f.framework_type === "drafting_insight");
  if (framework?.description) {
    out += `💡 DRAFTING INSIGHT\n${framework.description}\n`;
  }

  return out;
}

// ============================================================
//  ENRICH EXISTING JUDGE PROFILES
//  Runs on already-scanned opinions to add Layer 2 depth
//  Call this after the bulk scan completes
// ============================================================
async function enrichExistingProfiles() {
  console.log("[motion-intel] 🔄 Enriching existing judge profiles with deep reasoning...");

  try {
    // Get all stored rulings that haven't been deeply analyzed yet
    const rulings = await db.query(`
      SELECT jr.id, jr.judge_name, jr.court, jr.motion_type, jr.result,
             jr.full_text, jr.case_name, jr.hearing_date, jr.url
      FROM judge_rulings jr
      WHERE jr.full_text IS NOT NULL
        AND jr.full_text != ''
        AND jr.motion_type IN (
          'Demurrer','MSJ','Motion to Strike','Anti-SLAPP',
          'Preliminary Injunction','Unlawful Detainer',
          'Asylum','Removal','Motion to Reopen','Sanctions'
        )
        AND NOT EXISTS (
          SELECT 1 FROM motion_arguments ma
          WHERE ma.judge_name = jr.judge_name
            AND ma.court      = jr.court
            AND ma.motion_type = jr.motion_type
        )
      ORDER BY jr.id DESC
      LIMIT 500
    `);

    console.log(`[motion-intel] Found ${rulings.rows.length} rulings to enrich`);

    let enriched = 0;
    for (const ruling of rulings.rows) {
      const reasoning = await extractDeepReasoning(ruling);
      if (reasoning) {
        await storeMotionIntelligence(ruling, reasoning);
        enriched++;
      }
      // Respectful rate limiting
      await new Promise(r => setTimeout(r, 1500));

      if (enriched % 20 === 0 && enriched > 0) {
        console.log(`[motion-intel] Enriched ${enriched}/${rulings.rows.length} rulings...`);
      }
    }

    console.log(`[motion-intel] ✅ Enrichment complete: ${enriched} rulings deeply analyzed`);
    return enriched;

  } catch (err) {
    console.error("[motion-intel] Enrichment error:", err.message);
    return 0;
  }
}

// ============================================================
//  HELPERS
// ============================================================
function detectPracticeArea(court, motionType) {
  const c = (court || "").toLowerCase();
  const m = (motionType || "").toLowerCase();
  if (/bia|eoir|immigration|asylum|removal/.test(c) ||
      /asylum|removal|reopen|withholding|cat/.test(m)) return "immigration";
  if (/federal|cacd|caed|cand|casd|ca9/.test(c)) return "federal";
  if (/unlawful detainer|eviction/.test(m)) return "eviction";
  return "civil";
}

function categorizeArgument(argumentText, practiceArea) {
  const text    = argumentText.toLowerCase();
  const taxonomy = ARGUMENT_TAXONOMY[practiceArea] || ARGUMENT_TAXONOMY.civil;
  const matched  = taxonomy.find(cat => text.includes(cat.toLowerCase()));
  return matched || "general";
}

// ============================================================
//  CLI — node motion-intelligence.js --enrich
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--enrich")) {
    initMotionIntelligenceTables()
      .then(() => enrichExistingProfiles())
      .then(n => {
        console.log(`\n✅ Enriched ${n} rulings with deep reasoning data`);
        process.exit(0);
      })
      .catch(err => { console.error(err); process.exit(1); });
  } else {
    console.log(`
ZARA MOTION INTELLIGENCE — Layer 2

Usage:
  node motion-intelligence.js --enrich    Enrich existing judge profiles with deep reasoning

After enrichment, use in JJ mode:
  "motion intelligence judge Ortiz demurrer"
  "what arguments win for judge Martinez MSJ"
  "how does judge Chen reason through anti-SLAPP"
    `);
    process.exit(0);
  }
}

module.exports = {
  initMotionIntelligenceTables,
  extractDeepReasoning,
  storeMotionIntelligence,
  getMotionIntelligence,
  formatMotionIntelligenceForJJ,
  enrichExistingProfiles,
};
