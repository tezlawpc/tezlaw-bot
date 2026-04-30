// ============================================================
//  expand-scan.js
//  Aggressive moat expansion scan.
//  Targets all major jurisdictions, deeper history, with cost optimizations.
//
//  OPTIMIZATIONS:
//    1. Pre-filter: skip already-indexed URLs
//    2. Concurrency: 5 parallel Claude calls
//    3. Prompt caching: schema portion cached across calls
//    4. Checkpointing: survives restart, resumes per court
//    5. Truncated input: 3,500 chars per ruling (already in original)
//
//  ESTIMATED:
//    ~10,000-15,000 opinions fetched, ~6,000-9,000 Claude calls
//    Runtime ~2-3 hours with parallelization
//    Cost ~$5-12 in Haiku 4.5 API
//
//  USAGE:
//    nohup node expand-scan.js > /tmp/expand-stdout.log 2>&1 &
//    # OR specific courts only:
//    nohup node expand-scan.js --courts=ca9,bia > /tmp/expand-stdout.log 2>&1 &
// ============================================================

const fs    = require("fs");
const path  = require("path");
const axios = require("axios");
const db    = require("./db");

// ============================================================
//  CONFIG
// ============================================================

const COURTLISTENER_TOKEN = process.env.COURTLISTENER_TOKEN;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;

if (!COURTLISTENER_TOKEN) { console.error("Missing COURTLISTENER_TOKEN"); process.exit(1); }
if (!ANTHROPIC_API_KEY)   { console.error("Missing ANTHROPIC_API_KEY");   process.exit(1); }

const STORAGE_DIR     = process.env.PERSISTENT_STORAGE_DIR || "/tmp";
const CHECKPOINT_FILE = path.join(STORAGE_DIR, "expand-checkpoint.json");
const REPORT_FILE     = path.join(STORAGE_DIR, "expand-report.json");
const LOG_FILE        = path.join(STORAGE_DIR, "expand-progress.log");
const STARTED_AT      = Date.now();

const MAX_RUNTIME_HOURS    = 3.5;
const CONCURRENCY          = 5;          // parallel Claude calls
const CL_PAGE_SIZE         = 50;         // larger pages = fewer round-trips
const CL_PAUSE_EVERY       = 10;         // pause 5s every N pages
const CL_PAUSE_MS          = 5000;
const SAVE_CHECKPOINT_EVERY = 25;
const MIN_TEXT_LENGTH      = 800;        // skip very short opinions
const MAX_PROMPT_CHARS     = 3500;       // truncate input to Claude

// ============================================================
//  COURTS — EXPANDED CONFIG
//  Aggressive: deeper dates, more courts, fixed calctapp ID
// ============================================================

const COURTS = {
  // ── Existing courts with deeper history ──
  ca9:      { name: "9th Circuit",                  clCourt: "ca9",      type: "appellate",   startYear: 1990 },
  bia:      { name: "Board of Immigration Appeals", clCourt: "bia",      type: "immigration", startYear: 1995 },
  cacd:     { name: "Central District CA",          clCourt: "cacd",     type: "federal",     startYear: 2000 },
  caed:     { name: "Eastern District CA",          clCourt: "caed",     type: "federal",     startYear: 2000 },
  cand:     { name: "Northern District CA",         clCourt: "cand",     type: "federal",     startYear: 2000 },
  casd:     { name: "Southern District CA",         clCourt: "casd",     type: "federal",     startYear: 2000 },
  cal:      { name: "California Supreme Court",     clCourt: "cal",      type: "appellate",   startYear: 1980 },

  // ── FIXED calctapp ID (was suspicious comma-separated, now single ID) ──
  calctapp: { name: "California Courts of Appeal",  clCourt: "calctapp", type: "appellate",   startYear: 1995 },

  // ── New courts ──
  scotus:   { name: "U.S. Supreme Court",            clCourt: "scotus",   type: "scotus",      startYear: 1990 },
  ag:       { name: "Attorney General (immigration)", clCourt: "ag",      type: "immigration", startYear: 1995 },
  ca1:      { name: "1st Circuit",                   clCourt: "ca1",      type: "appellate",   startYear: 1995, immigrationOnly: true },
  ca2:      { name: "2nd Circuit",                   clCourt: "ca2",      type: "appellate",   startYear: 1995, immigrationOnly: true },
  ca5:      { name: "5th Circuit",                   clCourt: "ca5",      type: "appellate",   startYear: 1995, immigrationOnly: true },
  ca11:     { name: "11th Circuit",                  clCourt: "ca11",     type: "appellate",   startYear: 1995, immigrationOnly: true },
};

const DEFAULT_SCAN_ORDER = [
  "calctapp",   // FIRST — debug fixed ID, fail fast
  "scotus", "ag",
  "ca9", "bia",
  "ca1", "ca2", "ca5", "ca11",  // immigration-only filter on these
  "cacd", "caed", "cand", "casd",
  "cal",
];

// ============================================================
//  PRACTICE KEYWORDS (subset of original — fast pre-filter)
// ============================================================

const PRACTICE_KEYWORDS = [
  "demurrer","motion to strike","summary judgment","anti-slapp","motion to compel",
  "preliminary injunction","sanctions","attorneys fees","breach of contract","fraud",
  "negligence","damages","unlawful detainer","eviction","landlord","tenant","lease",
  "personal injury","premises liability","wrongful death","products liability",
  "asylum","removal","deportation","credibility","particular social group","withholding",
  "bia","eoir","motion to reopen","cat","cancellation of removal","adjustment of status",
  "qualified immunity","due process","equal protection","section 1983","42 u.s.c",
  "habeas corpus","§ 2255","§ 2241","class action","class certification",
  "rule 12","rule 56","12(b)(6)","iqbal","twombly","standing","mootness",
];

const IMMIGRATION_KEYWORDS = [
  "asylum","removal","deportation","persecution","credibility","particular social group",
  "withholding","cat","cancellation of removal","adjustment of status","visa","immigration",
  "bia","eoir","ina ","8 u.s.c","8 c.f.r","nta","overstay","refugee",
];

// ============================================================
//  STATE
// ============================================================

let state = {
  job_id:        null,
  started_at:    new Date().toISOString(),
  current_court: null,
  courts:        {},  // { courtKey: { status, page, totalFound, processed, errors, skipped, cursor } }
  totals:        { fetched: 0, claude_calls: 0, processed: 0, skipped: 0, errors: 0 },
};

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    }
  } catch {}
  return null;
}

function saveCheckpoint() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2));
  } catch (err) { /* non-fatal */ }
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function checkBudget() {
  const hoursElapsed = (Date.now() - STARTED_AT) / (1000 * 60 * 60);
  return hoursElapsed < MAX_RUNTIME_HOURS;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
//  COURTLISTENER FETCHER
// ============================================================

async function fetchBatch(courtCode, nextUrl, dateAfter) {
  const headers = { Authorization: `Token ${COURTLISTENER_TOKEN}` };

  try {
    const resp = nextUrl
      ? await axios.get(nextUrl, { headers, timeout: 30000 })
      : await axios.get("https://www.courtlistener.com/api/rest/v4/opinions/", {
          params: {
            cluster__docket__court:    courtCode,
            cluster__date_filed__gte:  dateAfter,
            order_by:                  "-id",
            page_size:                 CL_PAGE_SIZE,
          },
          headers,
          timeout: 30000,
        });

    const results = (resp.data?.results || []).map(op => ({
      cluster_id:   op.cluster_id || op.id,
      opinionId:    op.id,
      judge:        (op.author_str || op.joined_by_str || "").trim(),
      dateFiled:    op.date_created?.split("T")[0] || "",
      absolute_url: op.absolute_url || "",
      _text:        op.plain_text || op.html_with_citations || op.xml_harvard || "",
    }));

    return {
      results,
      count: resp.data?.count || 0,
      next:  resp.data?.next  || null,
    };
  } catch (err) {
    if (err.response?.status === 429) {
      log(`[CL] Rate limited — sleeping 60s`);
      await sleep(60000);
      return { results: [], count: 0, next: null };
    }
    if (err.response?.status === 401 || err.response?.status === 403) {
      throw new Error(`CL auth error: ${err.response.status}`);
    }
    log(`[CL] Fetch error (${courtCode}): ${err.message}`);
    return { results: [], count: 0, next: null };
  }
}

// ============================================================
//  CLAUDE ANALYZER (with prompt caching)
//
//  Anthropic prompt caching: split the prompt into a STATIC SCHEMA
//  block (cacheable) and a per-call DYNAMIC block (court/judge/date/text).
//  Within 5 minutes, repeated calls only pay 10% for the static block.
// ============================================================

const STATIC_SCHEMA_PROMPT = `You are extracting structured data from a court ruling for a judge intelligence database at a California law firm.

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
}`;

async function analyzeWithClaude(ruling) {
  if (!ruling.full_text || ruling.full_text.length < MIN_TEXT_LENGTH) return null;

  const dynamic = `Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

RULING TEXT:
${ruling.full_text.substring(0, MAX_PROMPT_CHARS)}`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: [
          {
            type: "text",
            text: STATIC_SCHEMA_PROMPT,
            cache_control: { type: "ephemeral" },  // cache the schema across calls
          },
        ],
        messages: [{ role: "user", content: dynamic }],
      },
      {
        headers: {
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta":    "prompt-caching-2024-07-31",
          "Content-Type":      "application/json",
        },
        timeout: 30000,
      }
    );

    state.totals.claude_calls++;
    const txt = resp.data.content[0]?.text || "{}";
    const clean = txt.replace(/```json|```/g, "").trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch { return null; }

    if (!parsed.judge_name || !parsed.motion_type) return null;

    return {
      ...ruling,
      ...parsed,
      judge_name: parsed.judge_name || ruling.judge_name,
    };
  } catch (err) {
    if (err.response?.status === 429) {
      log("[claude] rate limited — 30s pause");
      await sleep(30000);
      return null;
    }
    state.totals.errors++;
    return null;
  }
}

// ============================================================
//  STORE RULING (matches existing schema)
// ============================================================

async function storeRuling(analyzed) {
  if (!analyzed.judge_name || analyzed.judge_name.length < 3) return false;

  try {
    // Upsert judge_profiles
    const profileResult = await db.query(`
      INSERT INTO judge_profiles (judge_name, court, court_type, total_rulings)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (judge_name, court) DO UPDATE SET
        total_rulings = judge_profiles.total_rulings + 1,
        last_updated  = NOW()
      RETURNING id
    `, [analyzed.judge_name, analyzed.court, analyzed.court_type || "federal"]);

    const profileId = profileResult.rows[0].id;

    // Insert ruling
    await db.query(`
      INSERT INTO judge_rulings
        (judge_profile_id, judge_name, court, motion_type, result,
         case_name, case_number, hearing_date, full_text, url, source, processed)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
      ON CONFLICT DO NOTHING
    `, [
      profileId,
      analyzed.judge_name,
      analyzed.court,
      analyzed.motion_type,
      analyzed.result,
      analyzed.case_name,
      analyzed.case_number,
      analyzed.hearing_date,
      analyzed.full_text,
      analyzed.url,
      "CourtListener (expand-scan)",
    ]);

    // Upsert insight aggregation per (judge, motion_type)
    if (analyzed.motion_type) {
      const insightExists = await db.query(`
        SELECT id, grant_count, deny_count, key_phrases, accepted_args, rejected_args, cited_statutes, cited_cases
        FROM judge_insights
        WHERE judge_profile_id = $1 AND motion_type = $2
      `, [profileId, analyzed.motion_type]);

      const isGrant = /^(Granted|Sustained)$/i.test(analyzed.result || "");
      const isDeny  = /^(Denied|Overruled)$/i.test(analyzed.result || "");

      if (insightExists.rows.length) {
        // Update existing
        const r = insightExists.rows[0];
        const mergeArr = (existing, fresh, max = 50) => {
          const set = new Set(existing || []);
          (fresh || []).forEach(v => { if (v) set.add(v); });
          return Array.from(set).slice(0, max);
        };

        await db.query(`
          UPDATE judge_insights SET
            grant_count = grant_count + $1,
            deny_count = deny_count + $2,
            key_phrases = $3,
            accepted_args = $4,
            rejected_args = $5,
            cited_statutes = $6,
            cited_cases = $7,
            updated_at = NOW()
          WHERE id = $8
        `, [
          isGrant ? 1 : 0, isDeny ? 1 : 0,
          mergeArr(r.key_phrases, analyzed.key_phrases),
          mergeArr(r.accepted_args, analyzed.accepted_args),
          mergeArr(r.rejected_args, analyzed.rejected_args),
          mergeArr(r.cited_statutes, analyzed.cited_statutes),
          mergeArr(r.cited_cases, analyzed.cited_cases),
          r.id,
        ]);
      } else {
        // Insert new
        await db.query(`
          INSERT INTO judge_insights
            (judge_profile_id, judge_name, court, motion_type, result,
             grant_count, deny_count,
             key_phrases, accepted_args, rejected_args, cited_statutes, cited_cases)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          profileId, analyzed.judge_name, analyzed.court,
          analyzed.motion_type, analyzed.result,
          isGrant ? 1 : 0, isDeny ? 1 : 0,
          analyzed.key_phrases || [], analyzed.accepted_args || [],
          analyzed.rejected_args || [], analyzed.cited_statutes || [],
          analyzed.cited_cases || [],
        ]);
      }
    }
    return true;
  } catch (err) {
    state.totals.errors++;
    return false;
  }
}

// ============================================================
//  PRE-FILTER: Skip already-indexed URLs
// ============================================================

async function filterAlreadyIndexed(opinions) {
  if (!opinions.length) return [];
  const urls = opinions.map(o => o.absolute_url ? `https://www.courtlistener.com${o.absolute_url}` : null).filter(Boolean);
  if (!urls.length) return opinions;

  const existing = await db.query(`SELECT url FROM judge_rulings WHERE url = ANY($1::text[])`, [urls]);
  const existingSet = new Set(existing.rows.map(r => r.url));

  return opinions.filter(o => {
    const url = o.absolute_url ? `https://www.courtlistener.com${o.absolute_url}` : null;
    return !url || !existingSet.has(url);
  });
}

// ============================================================
//  EXTRACT JUDGE NAMES (lightweight version)
// ============================================================

function extractJudgeNames(text, opinion) {
  const names = new Set();
  if (opinion.judge && opinion.judge.length > 2) names.add(opinion.judge.trim());

  // Simple regex for "Hon. NAME" or "JUDGE NAME"
  const matches = text.match(/(?:Hon(?:orable)?\.?|Judge|Justice)\s+([A-Z][a-z]+(?:\s+[A-Z]\.\s*)?(?:\s+[A-Z][a-z]+){1,3})/g) || [];
  for (const m of matches.slice(0, 3)) {
    const name = m.replace(/^(?:Hon(?:orable)?\.?|Judge|Justice)\s+/i, "").trim();
    if (name.length > 4) names.add(name);
  }

  return Array.from(names).slice(0, 3);
}

// ============================================================
//  PROCESS A SINGLE COURT
// ============================================================

async function scanCourt(courtKey) {
  const court = COURTS[courtKey];
  if (!court) { log(`Unknown court: ${courtKey}`); return; }

  const cs = state.courts[courtKey] = state.courts[courtKey] || {
    status: "running", page: 0, totalFound: 0, processed: 0, errors: 0, skipped: 0,
    cursor: null, dateAfter: `${court.startYear}-01-01`,
  };

  cs.status = "running";
  state.current_court = courtKey;

  log(`╔═════════════════════════════════════╗`);
  log(`║ ${court.name.padEnd(35)} ║`);
  log(`║ from ${cs.dateAfter}, immigration_only=${court.immigrationOnly ? "YES" : "no"}${" ".repeat(8)}║`);
  log(`╚═════════════════════════════════════╝`);

  const keywords = court.immigrationOnly ? IMMIGRATION_KEYWORDS : PRACTICE_KEYWORDS;

  while (true) {
    if (!checkBudget()) {
      log(`[${courtKey}] runtime budget exceeded — pausing`);
      cs.status = "paused_budget";
      saveCheckpoint();
      return;
    }

    const batch = await fetchBatch(court.clCourt, cs.cursor, cs.dateAfter);
    if (!batch.results.length) break;

    cs.page++;
    cs.totalFound += batch.results.length;
    state.totals.fetched += batch.results.length;

    // Pre-filter: skip already-indexed
    const fresh = await filterAlreadyIndexed(batch.results);
    cs.skipped += (batch.results.length - fresh.length);
    state.totals.skipped += (batch.results.length - fresh.length);

    log(`[${courtKey}] page ${cs.page}: ${batch.results.length} fetched, ${fresh.length} new, ${batch.results.length - fresh.length} already-indexed`);

    // Pre-filter by keyword relevance
    const candidates = [];
    for (const op of fresh) {
      const fullText = (op._text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (fullText.length < MIN_TEXT_LENGTH) {
        // Save minimal profile if we have a judge name
        if (op.judge && op.judge.length > 2) {
          await db.query(`
            INSERT INTO judge_profiles (judge_name, court, court_type, total_rulings)
            VALUES ($1, $2, $3, 1)
            ON CONFLICT (judge_name, court) DO UPDATE SET
              total_rulings = judge_profiles.total_rulings + 1,
              last_updated  = NOW()
          `, [op.judge, court.name, court.type]);
        }
        continue;
      }

      const lower = fullText.toLowerCase();
      const isRelevant = keywords.some(kw => lower.includes(kw));
      if (!isRelevant) continue;

      const judgeNames = extractJudgeNames(fullText, op);
      for (const judgeName of judgeNames) {
        candidates.push({
          judge_name:   judgeName,
          court:        court.name,
          court_type:   court.type,
          case_name:    op.caseName || "",
          case_number:  op.docketNumber || "",
          hearing_date: op.dateFiled,
          full_text:    fullText,
          url:          op.absolute_url ? `https://www.courtlistener.com${op.absolute_url}` : null,
        });
      }
    }

    // Process candidates with concurrency limit
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      if (!checkBudget()) { cs.status = "paused_budget"; saveCheckpoint(); return; }

      const slice = candidates.slice(i, i + CONCURRENCY);
      const analyzed = await Promise.all(slice.map(c => analyzeWithClaude(c).catch(e => { state.totals.errors++; return null; })));

      for (const a of analyzed) {
        if (a) {
          const ok = await storeRuling(a);
          if (ok) {
            cs.processed++;
            state.totals.processed++;
          }
        }
      }

      if (cs.processed % SAVE_CHECKPOINT_EVERY === 0) saveCheckpoint();
    }

    // Update progress
    saveCheckpoint();
    log(`[${courtKey}] page ${cs.page} done: total ${cs.processed} processed, ${cs.skipped} skipped`);

    // Pause every N pages
    if (cs.page % CL_PAUSE_EVERY === 0) {
      log(`[${courtKey}] pausing ${CL_PAUSE_MS/1000}s after page ${cs.page}`);
      await sleep(CL_PAUSE_MS);
    }

    if (!batch.next) break;
    cs.cursor = batch.next;
  }

  cs.status = "complete";
  saveCheckpoint();
  log(`[${courtKey}] ✅ COMPLETE — ${cs.totalFound} fetched, ${cs.processed} stored, ${cs.skipped} skipped`);
}

// ============================================================
//  FINAL REPORT
// ============================================================

async function generateReport() {
  log("═".repeat(60));
  log("EXPAND SCAN COMPLETE — GENERATING REPORT");
  log("═".repeat(60));

  const stats = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM judge_profiles) AS total_judges,
      (SELECT COUNT(*) FROM judge_rulings) AS total_rulings,
      (SELECT COUNT(*) FROM judge_insights) AS total_insights,
      (SELECT COUNT(*) FROM judge_rulings WHERE created_at > $1) AS new_rulings_this_run
  `, [new Date(STARTED_AT).toISOString()]);

  const report = {
    job_id:        state.job_id,
    started_at:    state.started_at,
    finished_at:   new Date().toISOString(),
    runtime_hours: ((Date.now() - STARTED_AT) / (1000 * 60 * 60)).toFixed(2),
    courts:        state.courts,
    totals:        state.totals,
    db_stats:      stats.rows[0],
  };

  try {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  } catch {}

  log("");
  log(`Runtime: ${report.runtime_hours}h`);
  log(`Total judges:   ${report.db_stats.total_judges}`);
  log(`Total rulings:  ${report.db_stats.total_rulings} (+${report.db_stats.new_rulings_this_run} this run)`);
  log(`Total insights: ${report.db_stats.total_insights}`);
  log(`Claude calls:   ${state.totals.claude_calls}`);
  log(`Skipped:        ${state.totals.skipped} (already-indexed)`);
  log(`Errors:         ${state.totals.errors}`);
  log("");
  log(`By court:`);
  for (const [k, c] of Object.entries(state.courts)) {
    log(`  ${k}: ${c.status} — ${c.totalFound} fetched, ${c.processed} stored, ${c.skipped} skipped`);
  }
  log(`Full report: cat ${REPORT_FILE}`);
}

// ============================================================
//  MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  let courtsToRun = DEFAULT_SCAN_ORDER;
  for (const a of args) {
    if (a.startsWith("--courts=")) courtsToRun = a.split("=")[1].split(",");
  }

  log("═".repeat(60));
  log("AGGRESSIVE MOAT EXPANSION SCAN");
  log("═".repeat(60));
  log(`Courts: ${courtsToRun.join(", ")}`);
  log(`Max runtime: ${MAX_RUNTIME_HOURS}h`);
  log(`Concurrency: ${CONCURRENCY} parallel Claude calls`);
  log("");

  const cp = loadCheckpoint();
  if (cp) {
    state = cp;
    log(`[init] Resumed from checkpoint`);
  } else {
    state.job_id = `expand-${Date.now()}`;
    saveCheckpoint();
  }

  for (const courtKey of courtsToRun) {
    if (!checkBudget()) {
      log(`[main] Budget exhausted — stopping`);
      break;
    }
    if (state.courts[courtKey]?.status === "complete") {
      log(`[${courtKey}] already complete — skipping`);
      continue;
    }
    try {
      await scanCourt(courtKey);
    } catch (err) {
      log(`[${courtKey}] FATAL: ${err.message}`);
      state.courts[courtKey] = state.courts[courtKey] || {};
      state.courts[courtKey].status = "errored";
      state.courts[courtKey].error = err.message;
      saveCheckpoint();
    }
  }

  await generateReport();
  log("");
  log("Goodnight 🌙");
  process.exit(0);
}

main().catch(err => {
  log(`[main] FATAL: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
