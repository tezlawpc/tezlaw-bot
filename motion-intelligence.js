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
const { buildExtractionPrompt, normalizeExtractedData } = require("./extraction-prompts");

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
        outcome           TEXT NOT NULL,
        frequency         INTEGER DEFAULT 1,
        confidence        NUMERIC(4,2),
        example_case      TEXT,
        example_language  TEXT,
        ruling_year       INTEGER,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court, motion_type, argument_text)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_motion_args_judge
      ON motion_arguments(judge_name, court, motion_type)
    `);

    // Brief frameworks
    await db.query(`
      CREATE TABLE IF NOT EXISTS motion_frameworks (
        id                SERIAL PRIMARY KEY,
        judge_name        TEXT NOT NULL,
        court             TEXT NOT NULL,
        motion_type       TEXT NOT NULL,
        framework_type    TEXT NOT NULL,
        description       TEXT NOT NULL,
        example_text      TEXT,
        success_rate      NUMERIC(4,2),
        sample_count      INTEGER DEFAULT 1,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court, motion_type, framework_type)
      )
    `);

    // Reasoning patterns with full-scope fields
    await db.query(`
      CREATE TABLE IF NOT EXISTS reasoning_patterns (
        id                SERIAL PRIMARY KEY,
        judge_name        TEXT NOT NULL,
        court             TEXT NOT NULL,
        motion_type       TEXT NOT NULL,
        practice_area     TEXT,
        legal_issue       TEXT NOT NULL,
        reasoning_chain   TEXT NOT NULL,
        key_factors       TEXT[],
        counter_factors   TEXT[],
        standard_applied  TEXT,
        burden_placement  TEXT,
        sample_language   TEXT,
        area_data         JSONB,
        ruling_year       INTEGER,
        trend_note        TEXT,
        frequency         INTEGER DEFAULT 1,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court, motion_type, legal_issue)
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_reasoning_area
      ON reasoning_patterns(practice_area, motion_type)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_reasoning_year
      ON reasoning_patterns(ruling_year, judge_name)
    `);

    // Area-specific intelligence tables
    // Immigration-specific intelligence
    await db.query(`
      CREATE TABLE IF NOT EXISTS immigration_intelligence (
        id              SERIAL PRIMARY KEY,
        judge_name      TEXT NOT NULL,
        court           TEXT NOT NULL,
        ij_or_brd       TEXT,
        psg_definitions TEXT[],
        psg_rejections  TEXT[],
        credibility_factors TEXT[],
        corroboration_standard TEXT,
        country_conditions_weight TEXT,
        nexus_theories  TEXT[],
        mtr_standards   TEXT[],
        grant_rate      NUMERIC(5,2),
        deny_rate       NUMERIC(5,2),
        remand_rate     NUMERIC(5,2),
        sample_count    INTEGER DEFAULT 0,
        last_updated    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court)
      )
    `);

    // Temporal tracking — how judge standards evolve year by year
    await db.query(`
      CREATE TABLE IF NOT EXISTS judge_temporal (
        id              SERIAL PRIMARY KEY,
        judge_name      TEXT NOT NULL,
        court           TEXT NOT NULL,
        motion_type     TEXT NOT NULL,
        ruling_year     INTEGER NOT NULL,
        grant_count     INTEGER DEFAULT 0,
        deny_count      INTEGER DEFAULT 0,
        key_standard    TEXT,
        notable_shift   TEXT,
        UNIQUE(judge_name, court, motion_type, ruling_year)
      )
    `);

    console.log("[motion-intel] ✅ Motion intelligence tables ready");
  } catch (err) {
    console.error("[motion-intel] Table init error:", err.message);
    throw err;
  }
}

// ============================================================
//  FULL-SCOPE DEEP REASONING EXTRACTION
//  Uses practice-area-specific prompts for 15/15 coverage
// ============================================================
async function extractDeepReasoning(ruling) {
  if (!ruling || !ruling.full_text || ruling.full_text.length < 30) return null;

  // Build the right prompt for this practice area
  const { prompt, area } = buildExtractionPrompt(ruling);

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 30000,
      }
    );

    const text  = resp.data.content[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    const raw   = JSON.parse(clean);

    if (!raw || Object.keys(raw).length === 0) return null;

    // Normalize into standard fields regardless of which prompt was used
    const normalized = normalizeExtractedData(raw, area);
    if (!normalized) return null;

    return normalized;

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
  const rulingYear   = reasoning.ruling_year
    || (ruling.hearing_date ? parseInt(ruling.hearing_date.substring(0, 4)) : null);

  try {
    // ── Store winning arguments ─────────────────────────────
    for (const arg of (reasoning.winning_arguments || [])) {
      if (!arg.argument) continue;
      await db.query(`
        INSERT INTO motion_arguments
          (judge_name, court, motion_type, practice_area, argument_text,
           argument_category, outcome, frequency, example_case, example_language, ruling_year)
        VALUES ($1,$2,$3,$4,$5,$6,'winning',1,$7,$8,$9)
        ON CONFLICT (judge_name, court, motion_type, argument_text) DO UPDATE SET
          frequency        = motion_arguments.frequency + 1,
          example_language = COALESCE($8, motion_arguments.example_language),
          updated_at       = NOW()
      `, [
        judge_name, court, motion_type, practiceArea,
        arg.argument.substring(0, 500),
        categorizeArgument(arg.argument, practiceArea),
        ruling.case_name || null,
        arg.exact_language?.substring(0, 300) || null,
        rulingYear,
      ]);
    }

    // ── Store losing arguments ──────────────────────────────
    for (const arg of (reasoning.losing_arguments || [])) {
      if (!arg.argument) continue;
      await db.query(`
        INSERT INTO motion_arguments
          (judge_name, court, motion_type, practice_area, argument_text,
           argument_category, outcome, frequency, example_case, example_language, ruling_year)
        VALUES ($1,$2,$3,$4,$5,$6,'losing',1,$7,$8,$9)
        ON CONFLICT (judge_name, court, motion_type, argument_text) DO UPDATE SET
          frequency        = motion_arguments.frequency + 1,
          example_language = COALESCE($8, motion_arguments.example_language),
          updated_at       = NOW()
      `, [
        judge_name, court, motion_type, practiceArea,
        arg.argument.substring(0, 500),
        categorizeArgument(arg.argument, practiceArea),
        ruling.case_name || null,
        arg.exact_language?.substring(0, 300) || null,
        rulingYear,
      ]);
    }

    // ── Store reasoning pattern with full-scope data ────────
    if (reasoning.reasoning_chain || reasoning.legal_standard) {
      const legalIssue = `${motion_type} — ${reasoning.legal_standard || "general"}`;
      await db.query(`
        INSERT INTO reasoning_patterns
          (judge_name, court, motion_type, practice_area, legal_issue,
           reasoning_chain, key_factors, counter_factors, standard_applied,
           burden_placement, sample_language, area_data, ruling_year, trend_note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (judge_name, court, motion_type, legal_issue) DO UPDATE SET
          frequency       = reasoning_patterns.frequency + 1,
          reasoning_chain = $6,
          key_factors     = (SELECT ARRAY(SELECT DISTINCT unnest(reasoning_patterns.key_factors || $7::text[]) LIMIT 10)),
          counter_factors = (SELECT ARRAY(SELECT DISTINCT unnest(reasoning_patterns.counter_factors || $8::text[]) LIMIT 10)),
          area_data       = $12,
          trend_note      = COALESCE($14, reasoning_patterns.trend_note),
          updated_at      = NOW()
      `, [
        judge_name, court, motion_type, practiceArea,
        legalIssue.substring(0, 300),
        (reasoning.reasoning_chain || "").substring(0, 2000),
        reasoning.key_factors    || [],
        reasoning.counter_factors || [],
        reasoning.legal_standard?.substring(0, 300)    || null,
        reasoning.burden_placement?.substring(0, 300)  || null,
        reasoning.sample_language?.substring(0, 500)   || null,
        reasoning.area_data ? JSON.stringify(reasoning.area_data) : null,
        rulingYear,
        reasoning.trend_note?.substring(0, 300) || null,
      ]);
    }

    // ── Store drafting insight ──────────────────────────────
    if (reasoning.drafting_insight) {
      await db.query(`
        INSERT INTO motion_frameworks
          (judge_name, court, motion_type, framework_type, description, sample_count)
        VALUES ($1,$2,$3,'drafting_insight',$4,1)
        ON CONFLICT (judge_name, court, motion_type, framework_type) DO UPDATE SET
          sample_count = motion_frameworks.sample_count + 1,
          description  = $4
      `, [judge_name, court, motion_type,
          reasoning.drafting_insight.substring(0, 500)]);
    }

    // ── Temporal tracking ───────────────────────────────────
    if (rulingYear) {
      const isGrant = ["Sustained","Granted"].includes(reasoning.result);
      const isDeny  = ["Overruled","Denied"].includes(reasoning.result);
      await db.query(`
        INSERT INTO judge_temporal
          (judge_name, court, motion_type, ruling_year, grant_count, deny_count, key_standard)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (judge_name, court, motion_type, ruling_year) DO UPDATE SET
          grant_count  = judge_temporal.grant_count + $5,
          deny_count   = judge_temporal.deny_count  + $6,
          key_standard = COALESCE($7, judge_temporal.key_standard)
      `, [
        judge_name, court, motion_type, rulingYear,
        isGrant ? 1 : 0,
        isDeny  ? 1 : 0,
        reasoning.legal_standard?.substring(0, 200) || null,
      ]);
    }

    // ── Immigration-specific intelligence ──────────────────
    if (practiceArea === "immigration" && reasoning.area_data) {
      await storeImmigrationIntelligence(judge_name, court, reasoning);
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

// ── Store immigration-specific intelligence ──────────────────
async function storeImmigrationIntelligence(judgeName, court, reasoning) {
  const d = reasoning.area_data;
  if (!d) return;

  const psgAccepted   = d.psg_analysis?.psg_proposed ? [d.psg_analysis.psg_proposed] : [];
  const psgRejections = d.psg_analysis?.psg_rejection_reason ? [d.psg_analysis.psg_rejection_reason] : [];
  const credFactors   = d.credibility?.adverse_factors || [];

  try {
    await db.query(`
      INSERT INTO immigration_intelligence
        (judge_name, court, psg_definitions, psg_rejections, credibility_factors,
         corroboration_standard, country_conditions_weight, sample_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1)
      ON CONFLICT (judge_name, court) DO UPDATE SET
        psg_definitions = (SELECT ARRAY(SELECT DISTINCT unnest(immigration_intelligence.psg_definitions || $3::text[]) LIMIT 20)),
        psg_rejections  = (SELECT ARRAY(SELECT DISTINCT unnest(immigration_intelligence.psg_rejections  || $4::text[]) LIMIT 20)),
        credibility_factors = (SELECT ARRAY(SELECT DISTINCT unnest(immigration_intelligence.credibility_factors || $5::text[]) LIMIT 20)),
        corroboration_standard   = COALESCE($6, immigration_intelligence.corroboration_standard),
        country_conditions_weight = COALESCE($7, immigration_intelligence.country_conditions_weight),
        sample_count    = immigration_intelligence.sample_count + 1,
        last_updated    = NOW()
    `, [
      judgeName, court,
      psgAccepted,
      psgRejections,
      credFactors,
      d.credibility?.corroboration_required ? "required" : null,
      d.country_conditions?.weight_given || null,
    ]);
  } catch (err) {
    if (!err.message.includes("duplicate")) {
      console.error("[motion-intel] Immigration intel store error:", err.message);
    }
  }
}

// ── Query temporal evolution for a judge ────────────────────
async function getTemporalTrends(judgeName, court, motionType) {
  try {
    const result = await db.query(`
      SELECT ruling_year,
             grant_count,
             deny_count,
             key_standard,
             notable_shift,
             ROUND(grant_count::numeric / NULLIF(grant_count + deny_count, 0) * 100, 1) AS grant_rate
      FROM judge_temporal
      WHERE judge_name ILIKE $1
        AND ($2::text IS NULL OR court ILIKE $2)
        AND ($3::text IS NULL OR motion_type ILIKE $3)
      ORDER BY ruling_year ASC
    `, [`%${judgeName}%`, court ? `%${court}%` : null, motionType ? `%${motionType}%` : null]);

    return result.rows;
  } catch (err) {
    return [];
  }
}

module.exports = {
  initMotionIntelligenceTables,
  extractDeepReasoning,
  storeMotionIntelligence,
  getMotionIntelligence,
  formatMotionIntelligenceForJJ,
  enrichExistingProfiles,
  getTemporalTrends,
};
