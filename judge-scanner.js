// ============================================================
//  judge-scanner.js — Historical Judge Profile Builder
//  Tez Law P.C. | Path B — Free sources only
//
//  SOURCES:
//  ┌─ State Trial Courts ──────────────────────────────────┐
//  │  San Bernardino  → old.sb-court.org (PDFs, 2021+)    │
//  │  Los Angeles     → lacourt.ca.gov (portal, 2019+)    │
//  │  Orange County   → occourts.org (PDFs, 2019+)        │
//  └───────────────────────────────────────────────────────┘
//  ┌─ Federal / Appellate ─────────────────────────────────┐
//  │  All CA Districts → CourtListener RECAP (2008+)       │
//  │  9th Circuit      → CourtListener (1990s+)            │
//  │  CA Appellate     → CourtListener (1950s+)            │
//  └───────────────────────────────────────────────────────┘
//  ┌─ Immigration ─────────────────────────────────────────┐
//  │  EOIR IJ data     → TRAC Syracuse (grant/deny rates)  │
//  │  BIA precedents   → CourtListener + justice.gov       │
//  │  9th Circuit imm  → CourtListener (ca9)               │
//  └───────────────────────────────────────────────────────┘
//
//  HOW TO RUN:
//  One-time bulk scan:  node judge-scanner.js --scan-all
//  Single court scan:   node judge-scanner.js --court=sb
//  Check progress:      node judge-scanner.js --status
//  Daily update:        runs automatically via legal-digest.js
//
//  WHAT IT BUILDS:
//  PostgreSQL table: judge_profiles
//  For each judge: motion grant rates, key reasoning phrases,
//  language patterns, what arguments they accept/reject,
//  case law they frequently cite, timing patterns
// ============================================================

const axios  = require("axios");
const db     = require("./db");
const { extractDeepReasoning, storeMotionIntelligence, initMotionIntelligenceTables } = require("./motion-intelligence");

const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const COURTLISTENER_TOKEN   = process.env.COURTLISTENER_TOKEN;

// ── Rate limiting — be respectful to public court servers ────
const DELAY_MS         = 800;   // ms between requests to same court
const CL_DELAY_MS      = 300;   // CourtListener is more robust
const CLAUDE_DELAY_MS  = 1200;  // Claude API calls
const MAX_RETRIES      = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Court configurations ──────────────────────────────────────
const COURTS = {
  sb: {
    name:      "San Bernardino Superior Court",
    shortName: "San Bernardino",
    type:      "state",
    baseUrl:   "https://old.sb-court.org/DesktopModules/TentativeRulings/TentativeRulings",
    newUrl:    "https://sanbernardino.courts.ca.gov/online-services/civil-tentative-rulings",
    // PDF pattern: CV[Dept][MMDDYY].pdf
    // Dept codes: S17, S24, S37, V11, etc.
    depts:     ["S17","S24","S37","V11","V15","V16","V17","V18","V19",
                "S15","S16","S18","S19","S26","S27","S28","S29","S30",
                "S31","S32","R08","R09","R10","R11","R12","R13"],
    startYear: 2021,
    clCourt:   null, // trial court not in CourtListener
  },
  la: {
    name:      "Los Angeles Superior Court",
    shortName: "Los Angeles",
    type:      "state",
    baseUrl:   "https://www.lacourt.ca.gov/tentativeRulingNet/ui/main.aspx",
    startYear: 2021,
    clCourt:   null,
  },
  oc: {
    name:      "Orange County Superior Court",
    shortName: "Orange County",
    type:      "state",
    baseUrl:   "https://www.occourts.org/online-services/tentative-rulings/civil-tentative-rulings",
    startYear: 2021,
    clCourt:   null,
  },
  cacd: {
    name:      "Central District of California",
    shortName: "CACD",
    type:      "federal",
    clCourt:   "cacd",
    startYear: 2010,
  },
  caed: {
    name:      "Eastern District of California",
    shortName: "CAED",
    type:      "federal",
    clCourt:   "caed",
    startYear: 2010,
  },
  cand: {
    name:      "Northern District of California",
    shortName: "CAND",
    type:      "federal",
    clCourt:   "cand",
    startYear: 2010,
  },
  casd: {
    name:      "Southern District of California",
    shortName: "CASD",
    type:      "federal",
    clCourt:   "casd",
    startYear: 2010,
  },
  ca9: {
    name:      "9th Circuit Court of Appeals",
    shortName: "9th Circuit",
    type:      "appellate",
    clCourt:   "ca9",
    startYear: 2005,
  },
  cal: {
    name:      "California Supreme Court",
    shortName: "CA Supreme",
    type:      "appellate",
    clCourt:   "cal",
    startYear: 2000,
  },
  calctapp: {
    name:      "California Courts of Appeal",
    shortName: "CA Appellate",
    type:      "appellate",
    clCourt:   "calctapp_1st,calctapp_2nd,calctapp_3rd,calctapp_4th,calctapp_5th,calctapp_6th",
    startYear: 2005,
  },
  bia: {
    name:      "Board of Immigration Appeals",
    shortName: "BIA",
    type:      "immigration",
    clCourt:   "bia",
    startYear: 2005,
  },
};

// ── Practice area keywords for relevance filtering ───────────
const PRACTICE_KEYWORDS = [
  // ── Civil litigation (state) ─────────────────────────────
  "demurrer","motion to strike","summary judgment","anti-slapp",
  "motion to compel","protective order","default judgment",
  "preliminary injunction","sanctions","attorneys fees",
  "breach of contract","fraud","negligence","damages",
  "intentional infliction","emotional distress","conversion",
  "unjust enrichment","specific performance","rescission",

  // ── Eviction / Landlord-Tenant ───────────────────────────
  "unlawful detainer","eviction","3-day notice","just cause",
  "habitability","security deposit","rent","landlord","tenant",
  "wrongful eviction","retaliatory","lease",

  // ── Personal Injury ──────────────────────────────────────
  "personal injury","premises liability","comparative fault",
  "pain and suffering","medical expenses","wrongful death",
  "products liability","defective","motor vehicle","accident",

  // ── Immigration ──────────────────────────────────────────
  "asylum","removal","deportation","voluntary departure",
  "credibility","particular social group","withholding",
  "bia","eoir","in absentia","motion to reopen","cat",
  "immigration","petitioner","respondent","nta","overstay",
  "cancellation of removal","adjustment of status","visa",
  "refugee","persecution","torture","hardship","inadmissible",

  // ── Federal / 9th Circuit ────────────────────────────────
  "qualified immunity","due process","equal protection",
  "fourth amendment","fifth amendment","first amendment",
  "section 1983","42 u.s.c","civil rights","constitutional",
  "habeas corpus","§ 2255","§ 2241","ineffective assistance",
  "class action","class certification","rule 23",
  "rule 12","rule 56","12(b)(6)","iqbal","twombly",
  "standing","mootness","ripeness","jurisdiction",
  "preliminary injunction","temporary restraining order",
  "erisa","title vii","adea","ada","fmla","employment",
  "discrimination","retaliation","hostile work environment",
  "copyright","trademark","patent","trade secret",
  "securities","fraud","false claims act","qui tam",
  "bankruptcy","discharge","automatic stay","adversary",
  "sentencing","guidelines","enhancement","career offender",
  "appeal","affirm","reverse","remand","de novo","abuse of discretion",

  // ── Estate / Probate ─────────────────────────────────────
  "probate","trust","conservatorship","will","estate",
  "fiduciary","trustee","executor","beneficiary","heir",

  // ── Business Litigation ───────────────────────────────────
  "breach of contract","trade secret","non-compete","noncompete",
  "misappropriation","partnership dispute","shareholder dispute",
  "llc dispute","operating agreement","buy-sell","breach of fiduciary",
  "corporate opportunity","alter ego","piercing the corporate veil",
  "franchise","license agreement","intellectual property",
  "copyright infringement","trademark infringement","patent infringement",
  "unfair business practices","unfair competition","business and professions",
  "17200","preliminary injunction","temporary restraining order",
  "inevitable disclosure","trade dress","unjust enrichment",

  // ── Employment Law ────────────────────────────────────────
  "title vii","feha","fair employment","age discrimination","adea",
  "disability discrimination","ada","fmla","cfra","pdl",
  "pregnancy discrimination","equal pay","wage and hour","overtime",
  "meal break","rest break","paga","labor code","wrongful termination",
  "constructive discharge","hostile work environment","sexual harassment",
  "employment retaliation","whistleblower","mcdonnell douglas",
  "disparate treatment","disparate impact","reasonable accommodation",
  "interactive process","arbitration agreement","class waiver",
  "pslra","misclassification","independent contractor","abc test",
  "piece rate","final pay","pay stub","expense reimbursement",

  // ── Public Entity & Securities ────────────────────────────
  "section 1983","42 u.s.c","monell","municipal liability",
  "public entity","government entity","civil rights","constitutional",
  "qualified immunity","public employee","due process","first amendment",
  "fourth amendment","14th amendment","deliberate indifference",
  "failure to train","official policy","custom and practice",
  "securities fraud","rule 10b-5","10b-5","insider trading",
  "material misrepresentation","loss causation","scienter",
  "false claims act","qui tam","false claim","original source",
  "government contract","sovereign immunity","tucker act",
  "dodd-frank","sarbanes-oxley","sec enforcement","sec v.",
  "public disclosure bar","presentment","reverse false claim",
  "dangerous condition","government claim act","design immunity",
  "discretionary immunity","scope of employment","public entity tort",
];

// ============================================================
//  DATABASE SETUP
// ============================================================
async function initJudgeProfileTables() {
  try {
    // Main judge profiles table
    await db.query(`
      CREATE TABLE IF NOT EXISTS judge_profiles (
        id              SERIAL PRIMARY KEY,
        judge_name      TEXT NOT NULL,
        court           TEXT NOT NULL,
        court_type      TEXT,
        department      TEXT,
        total_rulings   INTEGER DEFAULT 0,
        last_updated    TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court)
      )
    `);

    // Individual rulings table — raw data
    await db.query(`
      CREATE TABLE IF NOT EXISTS judge_rulings (
        id              SERIAL PRIMARY KEY,
        judge_profile_id INTEGER REFERENCES judge_profiles(id),
        judge_name      TEXT NOT NULL,
        court           TEXT NOT NULL,
        motion_type     TEXT,
        result          TEXT,
        case_name       TEXT,
        case_number     TEXT,
        hearing_date    TEXT,
        full_text       TEXT,
        url             TEXT,
        source          TEXT,
        processed       BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Extracted insights table — Claude's analysis of each ruling
    await db.query(`
      CREATE TABLE IF NOT EXISTS judge_insights (
        id               SERIAL PRIMARY KEY,
        judge_profile_id INTEGER REFERENCES judge_profiles(id),
        judge_name       TEXT NOT NULL,
        court            TEXT NOT NULL,
        motion_type      TEXT NOT NULL,
        result           TEXT NOT NULL,
        grant_count      INTEGER DEFAULT 0,
        deny_count       INTEGER DEFAULT 0,
        key_phrases      TEXT[],
        accepted_args    TEXT[],
        rejected_args    TEXT[],
        cited_statutes   TEXT[],
        cited_cases      TEXT[],
        reasoning_style  TEXT,
        sample_language  TEXT,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(judge_name, court, motion_type)
      )
    `);

    // Scan progress tracking
    await db.query(`
      CREATE TABLE IF NOT EXISTS scan_progress (
        id          SERIAL PRIMARY KEY,
        court_key   TEXT UNIQUE NOT NULL,
        court_name  TEXT,
        status      TEXT DEFAULT 'pending',
        total_found INTEGER DEFAULT 0,
        processed   INTEGER DEFAULT 0,
        last_scan   TIMESTAMPTZ,
        error_msg   TEXT,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log("[scanner] ✅ Judge profile tables ready");

    // Also init Layer 2 tables
    await initMotionIntelligenceTables();

  } catch (err) {
    console.error("[scanner] Table init error:", err.message);
    throw err;
  }
}

// ── Update scan progress ─────────────────────────────────────
async function updateScanProgress(courtKey, updates) {
  await db.query(`
    INSERT INTO scan_progress (court_key, court_name, ${Object.keys(updates).join(", ")}, updated_at)
    VALUES ($1, $2, ${Object.keys(updates).map((_, i) => `$${i+3}`).join(", ")}, NOW())
    ON CONFLICT (court_key) DO UPDATE SET
      ${Object.keys(updates).map((k, i) => `${k} = $${i+3}`).join(", ")},
      updated_at = NOW()
  `, [courtKey, COURTS[courtKey]?.name || courtKey, ...Object.values(updates)]);
}

// ============================================================
//  COURTLISTENER FETCHER
//  Used for: 9th Circuit, all CA Districts, BIA, CA Appellate
// ============================================================
// ── Fetch a batch from CourtListener using opinions endpoint ─
// Use /opinions/ endpoint directly — returns text fields we need
// Much more reliable than search API which returns empty snippets
async function fetchCourtListenerBatch(courtCode, nextUrl = null, dateAfter = "2005-01-01") {
  const headers = {};
  if (COURTLISTENER_TOKEN) headers["Authorization"] = `Token ${COURTLISTENER_TOKEN}`;

  try {
    let resp;

    if (nextUrl) {
      resp = await axios.get(nextUrl, { headers, timeout: 20000 });
    } else {
      // Use /opinions/ endpoint directly — returns plain_text and judge data
      resp = await axios.get("https://www.courtlistener.com/api/rest/v4/opinions/", {
        params: {
          cluster__court:             courtCode,
          cluster__date_filed__gte:   dateAfter,
          cluster__precedential_status: "Published",
          ordering:                   "-cluster__date_filed",
          page_size:                  20,
        },
        headers,
        timeout: 20000,
      });
    }

    const results = resp.data?.results || [];

    // One-time diagnostic — log what fields actually come back
    if (!fetchCourtListenerBatch._logged && results.length) {
      fetchCourtListenerBatch._logged = true;
      const sample = results[0];
      console.log("[scanner] OPINIONS API SAMPLE:");
      console.log("  keys:", Object.keys(sample).join(", "));
      console.log("  plain_text length:", (sample.plain_text||"").length);
      console.log("  html_with_citations length:", (sample.html_with_citations||"").length);
      console.log("  author_str:", sample.author_str);
      console.log("  cluster type:", typeof sample.cluster);
      if (typeof sample.cluster === "object") {
        console.log("  cluster keys:", Object.keys(sample.cluster||{}).join(", "));
        console.log("  cluster.judges:", sample.cluster?.judges);
        console.log("  cluster.date_filed:", sample.cluster?.date_filed);
      } else {
        console.log("  cluster value:", String(sample.cluster).substring(0,100));
      }
    }

    // Transform opinions into the format our scanner expects
    const transformed = results.map(op => ({
      id:           op.cluster_id || op.cluster?.id || op.id,
      opinionId:    op.id,
      caseName:     op.cluster?.case_name || op.cluster || "",
      judge:        op.author_str || op.joined_by_str || op.cluster?.judges || "",
      dateFiled:    op.cluster?.date_filed || "",
      absolute_url: op.cluster?.absolute_url || "",
      // Text directly available — no extra fetch needed
      _text:        op.plain_text || op.html_with_citations || "",
    }));

    return {
      results: transformed,
      count:   resp.data?.count || 0,
      next:    resp.data?.next  || null,
    };
  } catch (err) {
    if (err.response?.status === 429) {
      console.log("[scanner] Rate limited — waiting 60s");
      await sleep(60000);
      return { results: [], count: 0, next: null };
    }
    console.error(`[scanner] Fetch error (${courtCode}):`, err.message);
    if (err.response?.data) {
      console.error(`[scanner] Detail:`, JSON.stringify(err.response.data).substring(0, 200));
    }
    return { results: [], count: 0, next: null };
  }
}

// ── Fetch opinion full text ───────────────────────────────────
// Text is now pre-loaded from /opinions/ endpoint
// This function is only called as fallback for trial court PDFs
async function fetchOpinionText(clusterId) {
  const headers = {};
  if (COURTLISTENER_TOKEN) headers["Authorization"] = `Token ${COURTLISTENER_TOKEN}`;

  try {
    // Query opinions by cluster ID
    const resp = await axios.get(
      "https://www.courtlistener.com/api/rest/v4/opinions/",
      {
        params: { cluster: clusterId, fields: "id,plain_text,html_with_citations,author_str" },
        headers,
        timeout: 15000,
      }
    );

    const opinions = resp.data?.results || [];
    if (!opinions.length) return "";

    // Log first fetch for diagnostics
    if (!fetchOpinionText._logged) {
      fetchOpinionText._logged = true;
      console.log(`[scanner] Opinion fetch sample — keys: ${Object.keys(opinions[0]).join(", ")}`);
      console.log(`[scanner] plain_text length: ${(opinions[0].plain_text||"").length}`);
      console.log(`[scanner] html length: ${(opinions[0].html_with_citations||"").length}`);
    }

    const text = opinions[0].plain_text || opinions[0].html_with_citations || "";
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 8000);

  } catch (err) {
    return "";
  }
}

// ============================================================
//  SAN BERNARDINO TENTATIVE RULING FETCHER
//  Direct PDF scraping from old.sb-court.org
// ============================================================
async function fetchSBTentativeRulings(startYear = 2021) {
  const rulings = [];
  const now     = new Date();
  const depts   = COURTS.sb.depts;

  console.log(`[scanner] 🏛️  Scanning San Bernardino tentatives ${startYear}–${now.getFullYear()}...`);

  for (let year = startYear; year <= now.getFullYear(); year++) {
    for (let month = 1; month <= 12; month++) {
      if (year === now.getFullYear() && month > now.getMonth() + 1) break;

      // Get all court days in this month
      const courtDays = getCourtDays(year, month);

      for (const date of courtDays) {
        for (const dept of depts) {
          await sleep(DELAY_MS);

          const mmddyy = formatDateMMDDYY(date);
          const url    = `${COURTS.sb.baseUrl}/CV${dept}${mmddyy}.pdf`;

          try {
            const resp = await axios.get(url, {
              responseType: "arraybuffer",
              timeout:      10000,
              headers:      { "User-Agent": "Mozilla/5.0 (compatible; TezLaw-Zara/1.0)" },
              validateStatus: s => s === 200,
            });

            // PDF found — extract text
            const text = await extractPdfText(Buffer.from(resp.data));
            if (text && text.length > 100) {
              const judgeMatch = text.match(/(?:Judge|Hon\.|JUDGE)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?\s+)?[A-Z][a-z]+)/);
              const judgeName  = judgeMatch ? judgeMatch[1].trim() : `Dept ${dept}`;

              rulings.push({
                court:       "San Bernardino",
                department:  dept,
                judge_name:  judgeName,
                hearing_date: formatDate(date),
                full_text:   text.substring(0, 6000),
                url,
                source:      "sb-court.org",
              });
            }
          } catch (err) {
            // PDF doesn't exist for this dept/date — normal
            continue;
          }
        }
      }
    }
    console.log(`[scanner] SB ${year} complete — ${rulings.length} rulings so far`);
  }

  return rulings;
}

// ── Extract text from PDF buffer ─────────────────────────────
async function extractPdfText(buffer) {
  // Use pdf-parse if available, otherwise basic extraction
  try {
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    return data.text || "";
  } catch (err) {
    // Fallback: basic text extraction from PDF bytes
    const str = buffer.toString("binary");
    const texts = [];
    const regex = /BT\s*(.*?)\s*ET/gs;
    let match;
    while ((match = regex.exec(str)) !== null) {
      const textContent = match[1]
        .replace(/\(([^)]*)\)\s*Tj/g, "$1 ")
        .replace(/[^a-zA-Z0-9\s.,;:?!()\-]/g, "")
        .trim();
      if (textContent) texts.push(textContent);
    }
    return texts.join(" ").substring(0, 6000);
  }
}

// ============================================================
//  ORANGE COUNTY TENTATIVE RULING FETCHER
//  Direct from occourts.org/sites/default/files/oc/
// ============================================================
async function fetchOCTentativeRulings() {
  const rulings = [];

  console.log("[scanner] 🏛️  Scanning Orange County tentatives...");

  // OC posts tentatives as PDFs per judge
  // URL pattern: occourts.org/sites/default/files/oc/default/tentative-rulings/[judgename]rulings.pdf
  const ocJudges = [
    "dbrickerrulings","dclasterrulings","dhesseltinerulings",
    "djudgerulings","dhoferrulings","dmortersonrulings",
    "fandersonrulings","ggriffingrulings","jkimrulings",
    "kgorulings","lmartinrulings","mamerianrulings",
    "ndobrutasrulings","rchengrulings","sbowickrulings",
    "wbeckettrulings","wclasterrulings",
  ];

  for (const judge of ocJudges) {
    await sleep(DELAY_MS);
    const url = `https://www.occourts.org/sites/default/files/oc/default/tentative-rulings/${judge}.pdf`;

    try {
      const resp = await axios.get(url, {
        responseType: "arraybuffer",
        timeout:      12000,
        headers:      { "User-Agent": "Mozilla/5.0 (compatible; TezLaw-Zara/1.0)" },
        validateStatus: s => s === 200,
      });

      const text = await extractPdfText(Buffer.from(resp.data));
      if (text && text.length > 100) {
        const judgeMatch = text.match(/(?:Judge|Hon\.|JUDGE)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?\s+)?[A-Z][a-z]+)/);
        const judgeName  = judgeMatch ? judgeMatch[1].trim() : judge.replace("rulings","");

        rulings.push({
          court:       "Orange County",
          judge_name:  judgeName,
          full_text:   text.substring(0, 8000),
          url,
          source:      "occourts.org",
        });
      }
    } catch (err) {
      continue;
    }
  }

  return rulings;
}

// ============================================================
//  EOIR / IMMIGRATION IJ DATA
//  From TRAC Syracuse — grant/denial rates by IJ
// ============================================================
async function fetchEOIRJudgeData() {
  console.log("[scanner] 🛂  Fetching EOIR IJ grant rates from TRAC...");

  // TRAC provides IJ-level asylum grant rates
  // URL: trac.syr.edu/phptools/immigration/asylum/
  // We fetch their data tables for LA Immigration Court

  const courts = [
    { name: "Los Angeles",  tracId: "LOS" },
    { name: "San Diego",    tracId: "SDO" },
    { name: "San Francisco",tracId: "SFR" },
  ];

  const results = [];

  for (const court of courts) {
    await sleep(DELAY_MS);
    try {
      // TRAC has a data API for IJ statistics
      const resp = await axios.get(
        `https://trac.syr.edu/phptools/immigration/asylum/`,
        {
          params: { court: court.tracId, report_period: "2024" },
          timeout: 12000,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TezLaw-Zara/1.0; legal research)" },
        }
      );

      // Extract IJ grant rate table from HTML
      const html = resp.data;
      const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
      if (tableMatch) {
        // Parse judge rows
        const rows = tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
        for (const row of rows) {
          const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
            .map(c => c[1].replace(/<[^>]+>/g, "").trim());
          if (cells.length >= 3 && cells[0] && !cells[0].includes("Judge")) {
            results.push({
              judge_name:  cells[0],
              court:       `EOIR ${court.name}`,
              grant_rate:  parseFloat(cells[1]) || 0,
              total_cases: parseInt(cells[2]) || 0,
              source:      "TRAC Syracuse",
            });
          }
        }
      }
    } catch (err) {
      // TRAC may require specific params — non-fatal
      console.log(`[scanner] TRAC ${court.name} error: ${err.message}`);
    }
  }

  return results;
}

// ============================================================
//  CLAUDE ANALYSIS ENGINE
//  Reads each ruling and extracts structured judge intelligence
// ============================================================
async function analyzeRulingWithClaude(ruling) {
  if (!ruling.full_text || ruling.full_text.length < 30) {
    // Too short — skip silently
    return null;
  }

  // Check relevance first (fast keyword check)
  const text = ruling.full_text.toLowerCase();
  const isRelevant = PRACTICE_KEYWORDS.some(kw => text.includes(kw));
  if (!isRelevant) {
    // Not relevant to practice areas — skip silently
    return null;
  }

  await sleep(CLAUDE_DELAY_MS);

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{
          role:    "user",
          content: `You are extracting structured data from a court ruling for a judge intelligence database at a California law firm.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

RULING TEXT:
${ruling.full_text.substring(0, 3500)}

Extract ONLY if this is a civil motion ruling (demurrer, MSJ, motion to strike, motion to compel, UD, anti-SLAPP, PI/injunction, discovery, sanctions, or immigration motion).

Respond with JSON only (empty object {} if not a relevant civil ruling):
{
  "judge_name": "exact name from ruling",
  "motion_type": "Demurrer|MSJ|Motion to Strike|Motion to Compel|Unlawful Detainer|Anti-SLAPP|Preliminary Injunction|Discovery Motion|Sanctions|Asylum|Removal|Other",
  "result": "Sustained|Overruled|Granted|Denied|Continued|Mixed",
  "key_phrases": ["exact phrases judge used in reasoning, max 5, under 15 words each"],
  "accepted_args": ["specific arguments/grounds judge agreed with, max 4"],
  "rejected_args": ["specific arguments judge rejected with brief reason, max 4"],
  "cited_statutes": ["CCP 430.10", "CCP 437c"],
  "cited_cases": ["case names only, max 4"],
  "leave_to_amend": true,
  "legal_standard": "exact standard applied e.g. 'Iqbal/Twombly' or 'CCP 430.10(e)'",
  "decisive_factor": "the single most important reason for the ruling in one sentence",
  "reasoning_notes": "2 sentence summary: what the judge required and why this motion won/lost"
}`,
        }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type":      "application/json",
        },
        timeout: 20000,
      }
    );

    const text2  = resp.data.content[0]?.text || "{}";
    const clean  = text2.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    if (!parsed.motion_type || !parsed.result) return null;
    return { ...ruling, ...parsed };

  } catch (err) {
    return null;
  }
}

// ============================================================
//  STORE RULING IN DATABASE
// ============================================================
async function storeRuling(analyzed) {
  if (!analyzed || !analyzed.motion_type) return;

  try {
    // Upsert judge profile
    const profileResult = await db.query(`
      INSERT INTO judge_profiles (judge_name, court, court_type, department, total_rulings)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (judge_name, court) DO UPDATE SET
        total_rulings = judge_profiles.total_rulings + 1,
        last_updated  = NOW()
      RETURNING id
    `, [
      analyzed.judge_name || "Unknown",
      analyzed.court,
      getCourtsType(analyzed.court),
      analyzed.department || null,
    ]);

    const profileId = profileResult.rows[0]?.id;

    // Store raw ruling
    await db.query(`
      INSERT INTO judge_rulings
        (judge_profile_id, judge_name, court, motion_type, result, case_name,
         case_number, hearing_date, full_text, url, source, processed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
      ON CONFLICT DO NOTHING
    `, [
      profileId,
      analyzed.judge_name || "Unknown",
      analyzed.court,
      analyzed.motion_type,
      analyzed.result,
      analyzed.case_name || null,
      analyzed.case_number || null,
      analyzed.hearing_date || null,
      analyzed.full_text?.substring(0, 2000) || null,
      analyzed.url || null,
      analyzed.source || null,
    ]);

    // Upsert aggregated insights
    const isGrant = ["Sustained","Granted"].includes(analyzed.result);
    const isDeny  = ["Overruled","Denied"].includes(analyzed.result);

    await db.query(`
      INSERT INTO judge_insights
        (judge_profile_id, judge_name, court, motion_type, result,
         grant_count, deny_count, key_phrases, accepted_args, rejected_args,
         cited_statutes, cited_cases, reasoning_style, sample_language)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (judge_name, court, motion_type) DO UPDATE SET
        grant_count    = judge_insights.grant_count + $6,
        deny_count     = judge_insights.deny_count  + $7,
        key_phrases    = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(judge_insights.key_phrases || $8::text[])
            LIMIT 20
          )
        ),
        accepted_args  = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(judge_insights.accepted_args || $9::text[])
            LIMIT 15
          )
        ),
        rejected_args  = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(judge_insights.rejected_args || $10::text[])
            LIMIT 15
          )
        ),
        cited_statutes = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(judge_insights.cited_statutes || $11::text[])
            LIMIT 20
          )
        ),
        cited_cases    = (
          SELECT ARRAY(
            SELECT DISTINCT unnest(judge_insights.cited_cases || $12::text[])
            LIMIT 20
          )
        ),
        updated_at     = NOW()
    `, [
      profileId,
      analyzed.judge_name || "Unknown",
      analyzed.court,
      analyzed.motion_type,
      analyzed.result,
      isGrant ? 1 : 0,
      isDeny  ? 1 : 0,
      analyzed.key_phrases   || [],
      analyzed.accepted_args || [],
      analyzed.rejected_args || [],
      analyzed.cited_statutes || [],
      analyzed.cited_cases   || [],
      analyzed.reasoning_notes || null,
      analyzed.key_phrases?.[0] || null,
    ]);

  } catch (err) {
    // Non-fatal — log and continue
    if (!err.message.includes("duplicate")) {
      console.error("[scanner] Store error:", err.message);
    }
  }

  // ── Layer 2: Deep reasoning extraction ──────────────────
  // Only for high-value motion types — runs async after storing surface data
  try {
    const reasoning = await extractDeepReasoning(analyzed);
    if (reasoning) {
      await storeMotionIntelligence(analyzed, reasoning);
    }
  } catch (err) {
    // Non-fatal — Layer 2 failure never blocks Layer 1
  }
}

// ============================================================
//  COURTLISTENER COURT SCANNER
//  For 9th Circuit, all CA Districts, BIA, CA Appellate
// ============================================================
async function scanCourtListenerCourt(courtKey, options = {}) {
  const court      = COURTS[courtKey];
  const dateAfter  = options.dateAfter || `${court.startYear}-01-01`;
  let   nextUrl    = null;   // null = first page, then follow cursor
  let   pageNum    = 0;
  let   totalFound = 0;
  let   processed  = 0;

  console.log(`[scanner] ⚖️  Scanning ${court.name} via CourtListener (from ${dateAfter})...`);

  await updateScanProgress(courtKey, { status: "running", last_scan: new Date() });

  while (true) {
    const batch = await fetchCourtListenerBatch(court.clCourt, nextUrl, dateAfter);

    if (!batch.results.length) break;

    pageNum++;
    totalFound += batch.results.length;
    console.log(`[scanner] ${court.shortName} p${pageNum}: ${batch.results.length} opinions (total: ${totalFound})`);

    for (const opinion of batch.results) {
      const opinionId = opinion.id;
      if (!opinionId) continue;

      // Text is pre-loaded from /opinions/ endpoint — no extra fetch needed
      let fullText = (opinion._text || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Log first opinion for diagnostics
      if (batch.results.indexOf(opinion) === 0 && pageNum === 1) {
        console.log(`[scanner] ${court.shortName} sample — caseName: "${opinion.caseName?.substring(0,50)}", judge: "${opinion.judge?.substring(0,40)}", text length: ${fullText.length}`);
      }

      if (!fullText || fullText.length < 30) {
        // No text — store minimal profile from metadata if we have a judge name
        const judgeName = opinion.judge?.trim();
        if (judgeName && judgeName.length > 2) {
          await db.query(`
            INSERT INTO judge_profiles (judge_name, court, court_type, total_rulings)
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (judge_name, court) DO UPDATE SET
              total_rulings = judge_profiles.total_rulings + 1,
              last_updated  = NOW()
          `, [judgeName, court.name, court.type || "appellate"]);
          processed++;
        }
        continue;
      }

      // Check relevance
      const textLower = fullText.toLowerCase();
      const isRelevant = PRACTICE_KEYWORDS.some(kw => textLower.includes(kw));
      if (!isRelevant) continue;

      // Extract judge names
      const judgeNames = extractJudgeNamesFromText(fullText, opinion);

      for (const judgeName of judgeNames) {
        const ruling = {
          judge_name:   judgeName,
          court:        court.name,
          case_name:    opinion.caseName || opinion.case_name,
          case_number:  opinion.docketNumber,
          hearing_date: opinion.dateFiled || opinion.date_filed,
          full_text:    fullText,
          url:          opinion.absolute_url
                          ? `https://www.courtlistener.com${opinion.absolute_url}`
                          : null,
          source:       "CourtListener",
        };

        const analyzed = await analyzeRulingWithClaude(ruling);
        if (analyzed) {
          await storeRuling(analyzed);
          processed++;
        }
      }
    } // end for opinion of batch.results

    await updateScanProgress(courtKey, {
      total_found: totalFound,
      processed,
    });

    // Follow cursor to next page — null means done
    if (!batch.next) break;
    nextUrl = batch.next;

    // Pause every 10 pages to be respectful
    if (pageNum % 10 === 0) {
      console.log(`[scanner] Pausing 5s after page ${pageNum}...`);
      await sleep(5000);
    }
  }

  await updateScanProgress(courtKey, {
    status:      "complete",
    total_found: totalFound,
    processed,
    last_scan:   new Date(),
  });

  console.log(`[scanner] ✅ ${court.name}: ${totalFound} opinions, ${processed} profiles built`);
  return { totalFound, processed };
}

// ============================================================
//  TRIAL COURT SCANNER (SB, LA, OC)
// ============================================================
async function scanTrialCourt(courtKey) {
  let rulings = [];

  await updateScanProgress(courtKey, { status: "running", last_scan: new Date() });

  if (courtKey === "sb") {
    rulings = await fetchSBTentativeRulings(2021);
  } else if (courtKey === "oc") {
    rulings = await fetchOCTentativeRulings();
  } else if (courtKey === "la") {
    rulings = await fetchLATentativeRulings();
  }

  console.log(`[scanner] ${COURTS[courtKey].name}: ${rulings.length} rulings found, analyzing...`);

  let processed = 0;
  for (const ruling of rulings) {
    const analyzed = await analyzeRulingWithClaude(ruling);
    if (analyzed) {
      await storeRuling(analyzed);
      processed++;
    }
    if (processed % 50 === 0 && processed > 0) {
      console.log(`[scanner] ${COURTS[courtKey].shortName}: ${processed}/${rulings.length} analyzed`);
    }
  }

  await updateScanProgress(courtKey, {
    status:      "complete",
    total_found: rulings.length,
    processed,
    last_scan:   new Date(),
  });

  return { totalFound: rulings.length, processed };
}

// ── LA Superior Court fetcher ─────────────────────────────────
async function fetchLATentativeRulings() {
  // LA posts tentatives via their portal — we use their department index
  // lacourt.ca.gov/tentativeRulingNet/ui/main.aspx
  // Returns HTML per department/date combo
  const rulings = [];
  console.log("[scanner] 🏛️  Scanning LA Superior Court tentatives...");

  // LA Dept list for civil divisions
  const laDepts = [
    "1","2","3","4","5","6","7","8","9","10",
    "11","12","13","14","15","16","17","18","19","20",
    "24","25","26","27","28","29","30","31","32",
    "36","37","38","39","40","44","45","46","47","48",
    "49","50","51","52","53","54","55","56","57","58",
  ];

  // Scan last 2 years for LA (it's large)
  const now   = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 2);

  for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 7)) {
    // Sample weekly — LA is massive, don't hammer it
    if (isWeekend(d)) continue;

    const dateStr = d.toISOString().split("T")[0].replace(/-/g, "");

    for (const dept of laDepts.slice(0, 20)) { // Sample 20 depts
      await sleep(DELAY_MS);
      try {
        const resp = await axios.get(
          `https://www.lacourt.ca.gov/tentativeRulingNet/ui/main.aspx`,
          {
            params: {
              casetype:   "civil",
              dept:       dept,
              hearingdate: `${d.toLocaleDateString("en-US")}`,
            },
            timeout: 10000,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; TezLaw-Zara/1.0)" },
          }
        );

        const html = resp.data;
        if (!html || html.length < 200) continue;

        // Extract ruling text blocks
        const textBlocks = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (textBlocks.length > 200) {
          const judgeMatch = textBlocks.match(/(?:Judge|Hon\.|Department\s+\d+\s*[-–]\s*)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
          rulings.push({
            court:        "Los Angeles",
            department:   dept,
            judge_name:   judgeMatch?.[1]?.trim() || `Dept ${dept}`,
            hearing_date: d.toISOString().split("T")[0],
            full_text:    textBlocks.substring(0, 6000),
            source:       "lacourt.ca.gov",
          });
        }
      } catch (err) {
        continue;
      }
    }
  }

  return rulings;
}

// ============================================================
//  JUDGE PROFILE QUERY — Used by jj-mode.js when drafting
// ============================================================
async function getJudgeProfile(judgeName, court = null, motionType = null) {
  try {
    let query = `
      SELECT
        jp.judge_name,
        jp.court,
        jp.court_type,
        jp.department,
        jp.total_rulings,
        jp.last_updated,
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
        ROUND(ji.grant_count::numeric / NULLIF(ji.grant_count + ji.deny_count, 0) * 100, 1) AS grant_rate_pct
      FROM judge_profiles jp
      LEFT JOIN judge_insights ji ON jp.id = ji.judge_profile_id
      WHERE jp.judge_name ILIKE $1
    `;
    const params = [`%${judgeName}%`];

    if (court) {
      query  += ` AND jp.court ILIKE $${params.length + 1}`;
      params.push(`%${court}%`);
    }
    if (motionType) {
      query  += ` AND (ji.motion_type ILIKE $${params.length + 1} OR ji.motion_type IS NULL)`;
      params.push(`%${motionType}%`);
    }

    query += " ORDER BY jp.total_rulings DESC, ji.grant_count + ji.deny_count DESC LIMIT 10";

    const result = await db.query(query, params);
    return result.rows || [];
  } catch (err) {
    console.error("[scanner] Profile query error:", err.message);
    return [];
  }
}

// ── Format judge profile for JJ ─────────────────────────────
async function formatJudgeProfileForJJ(judgeName, court = null, motionType = null) {
  const rows = await getJudgeProfile(judgeName, court, motionType);

  if (!rows.length) {
    return `⚖️ No profile found for "${judgeName}" yet.\n\nZara's database grows daily. If this judge is in San Bernardino, LA, Orange County, federal CA districts, 9th Circuit, or EOIR — they'll appear after the next scan.\n\nRun: node judge-scanner.js --scan-all to trigger a fresh scan.`;
  }

  const profile = rows[0];
  const allMotions = rows.filter(r => r.motion_type);

  let out = `⚖️ JUDGE PROFILE: ${profile.judge_name}\n`;
  out    += `🏛️  ${profile.court}${profile.department ? ` — Dept ${profile.department}` : ""}\n`;
  out    += `📊 ${profile.total_rulings} rulings in Zara's database\n`;
  out    += `🔄 Last updated: ${new Date(profile.last_updated).toLocaleDateString()}\n`;
  out    += `${"─".repeat(50)}\n\n`;

  if (allMotions.length > 0) {
    out += `📋 MOTION GRANT RATES\n`;

    const specific = motionType
      ? allMotions.find(m => m.motion_type?.toLowerCase().includes(motionType.toLowerCase()))
      : null;

    if (specific) {
      const total = (specific.grant_count || 0) + (specific.deny_count || 0);
      const rate  = specific.grant_rate_pct;
      const bar   = "█".repeat(Math.round((rate||0)/10)) + "░".repeat(10-Math.round((rate||0)/10));
      out += `\n🎯 ${specific.motion_type}: ${bar} ${rate || 0}% (${total} rulings)\n\n`;
    }

    allMotions.forEach(m => {
      if (!m.motion_type) return;
      const total = (m.grant_count || 0) + (m.deny_count || 0);
      if (total < 2) return;
      const rate = m.grant_rate_pct || 0;
      const bar  = "█".repeat(Math.round(rate/10)) + "░".repeat(10-Math.round(rate/10));
      out += `  ${m.motion_type.padEnd(28)} ${bar} ${rate}% (${total})\n`;
    });
    out += "\n";
  }

  const insight = motionType
    ? allMotions.find(m => m.motion_type?.toLowerCase().includes(motionType.toLowerCase()))
    : allMotions[0];

  if (insight) {
    if (insight.key_phrases?.length) {
      out += `💬 LANGUAGE THIS JUDGE USES\n`;
      insight.key_phrases.slice(0, 5).forEach(p => out += `  • "${p}"\n`);
      out += "\n";
    }

    if (insight.accepted_args?.length) {
      out += `✅ ARGUMENTS THIS JUDGE ACCEPTS\n`;
      insight.accepted_args.slice(0, 4).forEach(a => out += `  • ${a}\n`);
      out += "\n";
    }

    if (insight.rejected_args?.length) {
      out += `❌ ARGUMENTS THIS JUDGE REJECTS\n`;
      insight.rejected_args.slice(0, 4).forEach(a => out += `  • ${a}\n`);
      out += "\n";
    }

    if (insight.cited_statutes?.length) {
      out += `📚 STATUTES THIS JUDGE CITES\n`;
      out += `  ${insight.cited_statutes.slice(0,8).join(", ")}\n\n`;
    }

    if (insight.reasoning_style) {
      out += `🧠 REASONING STYLE\n  ${insight.reasoning_style}\n\n`;
    }
  }

  // ── Layer 2: Motion Intelligence ─────────────────────────
  // Append deep reasoning data if available
  if (motionType) {
    try {
      const { getMotionIntelligence } = require("./motion-intelligence");
      const intel = await getMotionIntelligence(judgeName, court, motionType);

      if (intel.hasData) {
        out += `${"─".repeat(50)}\n`;
        out += `🔬 DEEP MOTION INTELLIGENCE — ${motionType}\n\n`;

        const pattern = intel.patterns[0];
        if (pattern?.standard_applied) {
          out += `⚖️ Standard: ${pattern.standard_applied}\n\n`;
        }

        if (intel.winning.length) {
          out += `✅ PROVEN WINNING ARGUMENTS\n`;
          intel.winning.slice(0, 4).forEach((a, i) => {
            out += `  ${i+1}. ${a.argument_text}`;
            if (a.frequency > 1) out += ` (${a.frequency}x confirmed)`;
            out += "\n";
            if (a.example_language) out += `     → "${a.example_language}"\n`;
          });
          out += "\n";
        }

        if (intel.losing.length) {
          out += `❌ PROVEN LOSING ARGUMENTS\n`;
          intel.losing.slice(0, 3).forEach((a, i) => {
            out += `  ${i+1}. ${a.argument_text}`;
            if (a.frequency > 1) out += ` (${a.frequency}x rejected)`;
            out += "\n";
          });
          out += "\n";
        }

        const framework = intel.frameworks.find(f => f.framework_type === "drafting_insight");
        if (framework?.description) {
          out += `💡 DRAFTING INSIGHT\n  ${framework.description}\n\n`;
        }
      }
    } catch (err) {
      // Layer 2 data is additive — never breaks Layer 1 display
    }
  }

  out += `💡 DRAFTING TIP\n`;
  out += formatDraftingTip(allMotions, motionType);

  return out;
}

// ── Generate drafting tip from profile data ──────────────────
function formatDraftingTip(motions, motionType) {
  const insight = motionType
    ? motions.find(m => m.motion_type?.toLowerCase().includes(motionType?.toLowerCase()))
    : motions[0];

  if (!insight) return "File a motion and Zara will learn from this judge's response.\n";

  const rate  = insight.grant_rate_pct || 0;
  const total = (insight.grant_count || 0) + (insight.deny_count || 0);

  if (total < 5) return `Limited data (${total} rulings). Use language patterns above as starting point.\n`;

  if (rate > 65) {
    return `This judge grants ${insight.motion_type}s ${rate}% of the time — above average. Lead with your strongest statutory ground and mirror their typical language above. Avoid speaking demurrers — focus on the pleadings themselves.\n`;
  } else if (rate > 40) {
    return `Near-average grant rate (${rate}%). This judge expects thorough M&C compliance and specific statutory citations. Use the accepted arguments above. Avoid conclusory assertions.\n`;
  } else {
    return `Below-average grant rate (${rate}%). Consider whether alternative procedural approaches serve your client better. If proceeding, address every rejected-argument pattern above preemptively.\n`;
  }
}

// ============================================================
//  GET SCAN STATUS
// ============================================================
async function getScanStatus() {
  try {
    const progress = await db.query("SELECT * FROM scan_progress ORDER BY court_key");
    const profiles = await db.query("SELECT COUNT(*) as total FROM judge_profiles");
    const rulings  = await db.query("SELECT COUNT(*) as total FROM judge_rulings");
    const insights = await db.query("SELECT COUNT(*) as total FROM judge_insights");

    return {
      courts:   progress.rows,
      totals: {
        judges:   parseInt(profiles.rows[0]?.total || 0),
        rulings:  parseInt(rulings.rows[0]?.total  || 0),
        insights: parseInt(insights.rows[0]?.total || 0),
      },
    };
  } catch (err) {
    return { courts: [], totals: { judges: 0, rulings: 0, insights: 0 } };
  }
}

// ============================================================
//  MAIN SCAN ORCHESTRATOR
// ============================================================
async function runFullScan(options = {}) {
  const {
    courts:    courtFilter = null,   // e.g. ["sb","ca9"] to scan specific courts
    dateAfter: dateOverride = null,
    verbose:   verbose = true,
  } = options;

  console.log("\n🔍 ZARA JUDGE SCANNER — FULL HISTORICAL SCAN");
  console.log("━".repeat(50));
  console.log("This will scan years of court documents to build");
  console.log("judge profiles. Expected time: 2-6 hours.\n");

  await initJudgeProfileTables();

  const scanOrder = courtFilter || [
    // Start with CourtListener courts (fastest, most reliable)
    "ca9","bia","calctapp","cacd","caed","cand","casd","cal",
    // Then trial courts (slower scraping)
    "sb","oc","la",
  ];

  const results = {};

  for (const courtKey of scanOrder) {
    const court = COURTS[courtKey];
    if (!court) {
      console.log(`[scanner] Unknown court key: ${courtKey} — skipping`);
      continue;
    }

    try {
      console.log(`\n[scanner] Starting ${court.name}...`);

      if (court.clCourt) {
        // CourtListener-based court
        const dateAfter = dateOverride || `${court.startYear}-01-01`;
        results[courtKey] = await scanCourtListenerCourt(courtKey, { dateAfter });
      } else {
        // Direct scraping court (SB, LA, OC)
        results[courtKey] = await scanTrialCourt(courtKey);
      }

      console.log(`[scanner] ✅ ${court.name}: ${results[courtKey].totalFound} found, ${results[courtKey].processed} profiles built`);

    } catch (err) {
      console.error(`[scanner] ❌ ${court.name} failed:`, err.message);
      await updateScanProgress(courtKey, {
        status:    "error",
        error_msg: err.message,
      });
      results[courtKey] = { error: err.message };
    }
  }

  // Print summary
  console.log("\n" + "━".repeat(50));
  console.log("SCAN COMPLETE — SUMMARY");
  console.log("━".repeat(50));

  const status = await getScanStatus();
  console.log(`Total judges indexed:   ${status.totals.judges}`);
  console.log(`Total rulings analyzed: ${status.totals.rulings}`);
  console.log(`Total insights built:   ${status.totals.insights}`);
  console.log("\nZara now knows how your judges think. 🎯\n");

  return results;
}

// ============================================================
//  HELPERS
// ============================================================
function getCourtDays(year, month) {
  const days = [];
  const lastDay = new Date(year, month, 0).getDate();
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month - 1, d);
    if (!isWeekend(date)) days.push(date);
  }
  return days;
}

function isWeekend(date) {
  const dow = date.getDay();
  return dow === 0 || dow === 6;
}

function formatDateMMDDYY(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}${dd}${yy}`;
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function getCourtsType(courtName) {
  const n = (courtName || "").toLowerCase();
  if (n.includes("9th") || n.includes("circuit") || n.includes("appellate")) return "appellate";
  if (n.includes("district") || n.includes("federal") || n.includes("cacd") || n.includes("caed")) return "federal";
  if (n.includes("eoir") || n.includes("bia") || n.includes("immigration")) return "immigration";
  return "state";
}

// ── Extract judge name from case name as last resort ────────
// e.g. "Smith v. Jones" → no judge, but "In re: Petition of Hon. Smith" → Smith
function extractJudgeFromCaseName(caseName) {
  const m = caseName.match(/(?:Hon\.|Judge|Justice)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  return m ? m[1] : null;
}

function extractJudgeNamesFromText(text, opinion) {
  const names = new Set();

  // CourtListener search API returns judge field directly — use it first
  if (opinion?.judge && opinion.judge.trim().length > 2) {
    // May be comma-separated panel e.g. "Wardlaw, Tallman, Bea"
    opinion.judge.split(",").forEach(n => {
      const name = n.trim();
      if (name.length > 2 && name.length < 60) names.add(name);
    });
  }

  // Also try panel_names array if present
  if (Array.isArray(opinion?.panel_names)) {
    opinion.panel_names.forEach(n => {
      if (n && n.length > 2) names.add(n.trim());
    });
  }

  // Fallback: extract from text
  if (names.size === 0) {
    const patterns = [
      /(?:Judge|Justice|Hon\.|Honorable)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?\s*)?[A-Z][a-z]+)/g,
      /([A-Z][A-Z]+,\s+[A-Z][a-z]+)\s*,\s*(?:Circuit Judge|District Judge|J\.)/g,
    ];

    for (const pattern of patterns) {
      let match;
      const globalRe = new RegExp(pattern.source, "g");
      while ((match = globalRe.exec(text)) !== null) {
        const name = match[1].trim();
        if (name.length > 4 && name.length < 60) names.add(name);
      }
    }
  }

  // If still nothing, use court as fallback label so ruling isn't lost
  if (names.size === 0) {
    const courtLabel = opinion?.court || opinion?.court_id || "Unknown Judge";
    names.add(courtLabel);
  }

  return [...names].slice(0, 3);
}

// ============================================================
//  CLI RUNNER — node judge-scanner.js --scan-all
// ============================================================
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    initJudgeProfileTables().then(() =>
      getScanStatus().then(s => {
        console.log("\n📊 ZARA JUDGE DATABASE STATUS");
        console.log("━".repeat(40));
        console.log(`Judges indexed:   ${s.totals.judges}`);
        console.log(`Rulings analyzed: ${s.totals.rulings}`);
        console.log(`Insights built:   ${s.totals.insights}`);
        console.log("\nCourt scan status:");
        s.courts.forEach(c => {
          console.log(`  ${c.court_key.padEnd(12)} ${c.status.padEnd(12)} ${c.processed || 0}/${c.total_found || 0} processed`);
        });
        process.exit(0);
      })
    );
  } else if (args.includes("--scan-all")) {
    initJudgeProfileTables()
      .then(() => runFullScan())
      .then(() => process.exit(0))
      .catch(err => { console.error(err); process.exit(1); });
  } else {
    const courtArg = args.find(a => a.startsWith("--court="));
    if (courtArg) {
      const courts = courtArg.replace("--court=", "").split(",");
      initJudgeProfileTables()
        .then(() => runFullScan({ courts }))
        .then(() => process.exit(0))
        .catch(err => { console.error(err); process.exit(1); });
    } else {
      console.log(`
ZARA JUDGE SCANNER

Usage:
  node judge-scanner.js --scan-all          Full historical scan (all courts)
  node judge-scanner.js --court=sb,ca9,bia  Scan specific courts
  node judge-scanner.js --status            Show database status

Court keys: sb, la, oc, cacd, caed, cand, casd, ca9, cal, calctapp, bia
      `);
      process.exit(0);
    }
  }
}

module.exports = {
  initJudgeProfileTables,
  runFullScan,
  scanCourtListenerCourt,
  scanTrialCourt,
  getJudgeProfile,
  formatJudgeProfileForJJ,
  getScanStatus,
};
