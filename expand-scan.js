// ============================================================
//  expand-scan.js v2 — Multi-Session Moat Expansion
//
//  CRITICAL FIX (v2): Uses /clusters/ endpoint instead of /opinions/.
//  The /opinions/ endpoint:
//    - Has only `date_created` (CL ingestion date), NOT `date_filed`
//    - Cannot filter or sort by real filing date
//  The /clusters/ endpoint:
//    - Has real `date_filed` field
//    - Supports `date_filed__gte`, `date_filed__lte`, `precedential_status` filters
//    - Each cluster has `sub_opinions` array (URLs to full-text opinions)
//
//  ARCHITECTURE:
//    1. Fetch clusters with date_filed filter + precedential_status=Published
//    2. For each cluster: fetch its first sub_opinion to get full_text
//    3. Pre-filter (already-indexed, length, keywords)
//    4. Analyze with Claude (Haiku 4.5, prompt-cached schema)
//    5. Store in judge_rulings + judge_insights
//
//  USAGE:
//    # All courts in priority order (no time cap, autonomous)
//    nohup node expand-scan.js > /tmp/expand-stdout.log 2>&1 &
//
//    # One court at a time (recommended for predictable runs)
//    nohup node expand-scan.js --courts=bia > /tmp/expand-stdout.log 2>&1 &
//
//    # Override dateStop
//    nohup node expand-scan.js --courts=bia --stop-year=1985 > /tmp/expand-stdout.log 2>&1 &
//
//    # Cap total clusters per court (safety on huge corpora like ca5)
//    nohup node expand-scan.js --courts=scotus --max-clusters=10000 > /tmp/expand-stdout.log 2>&1 &
//
//    # Time-cap for safety
//    nohup node expand-scan.js --courts=ca9 --max-hours=12 > /tmp/expand-stdout.log 2>&1 &
//
//    # Re-scan a court
//    nohup node expand-scan.js --courts=bia --rescan > /tmp/expand-stdout.log 2>&1 &
//
//    # Include unpublished too (default is Published only)
//    nohup node expand-scan.js --courts=cacd --include-unpublished > /tmp/expand-stdout.log 2>&1 &
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

// Defaults — can be overridden by CLI flags
let MAX_RUNTIME_HOURS    = Infinity;
let MAX_CLUSTERS_PER_COURT = Infinity;
let INCLUDE_UNPUBLISHED  = false;
let USE_KEYWORD_FILTER   = false;       // default: collect ALL — Claude will reject pure procedural

const CONCURRENCY            = 5;
const SUB_OPINION_CONCURRENCY = 5;
const CL_PAGE_SIZE           = 50;
const CL_PAUSE_EVERY         = 10;
const CL_PAUSE_MS            = 5000;
const SAVE_CHECKPOINT_EVERY  = 25;
const MIN_TEXT_LENGTH        = 800;
const MAX_PROMPT_CHARS       = 3500;

// ============================================================
//  COURTS — Per-court config
// ============================================================

const COURTS = {
  bia:      { name: "Board of Immigration Appeals", clCourt: "bia",      type: "immigration", dateStop: 1990, priority: 10 },
  scotus:   { name: "U.S. Supreme Court",           clCourt: "scotus",   type: "scotus",      dateStop: 1990, priority: 20 },
  ca9:      { name: "9th Circuit",                  clCourt: "ca9",      type: "appellate",   dateStop: 1995, priority: 21 },
  ca5:      { name: "5th Circuit",                  clCourt: "ca5",      type: "appellate",   dateStop: 2000, priority: 30, immigrationOnly: true },
  ca11:     { name: "11th Circuit",                 clCourt: "ca11",     type: "appellate",   dateStop: 2000, priority: 31, immigrationOnly: true },
  ca2:      { name: "2nd Circuit",                  clCourt: "ca2",      type: "appellate",   dateStop: 2000, priority: 32, immigrationOnly: true },
  ca1:      { name: "1st Circuit",                  clCourt: "ca1",      type: "appellate",   dateStop: 2000, priority: 33, immigrationOnly: true },
  cal:      { name: "California Supreme Court",     clCourt: "cal",      type: "appellate",   dateStop: 1990, priority: 40 },
  calctapp: { name: "California Courts of Appeal",  clCourt: "calctapp", type: "appellate",   dateStop: 2000, priority: 41 },
  cacd:     { name: "Central District CA",          clCourt: "cacd",     type: "federal",     dateStop: 2010, priority: 50 },
  cand:     { name: "Northern District CA",         clCourt: "cand",     type: "federal",     dateStop: 2010, priority: 51 },
  caed:     { name: "Eastern District CA",          clCourt: "caed",     type: "federal",     dateStop: 2010, priority: 52 },
  casd:     { name: "Southern District CA",         clCourt: "casd",     type: "federal",     dateStop: 2010, priority: 53 },
};

const DEFAULT_SCAN_ORDER = Object.entries(COURTS)
  .sort((a, b) => (a[1].priority || 100) - (b[1].priority || 100))
  .map(([k]) => k);

// ============================================================
//  PRACTICE KEYWORDS
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
  courts:        {},
  totals:        { fetched: 0, claude_calls: 0, processed: 0, skipped: 0, errors: 0, sub_opinion_fetches: 0 },
};

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {}
  return null;
}

function saveCheckpoint() {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2));
  } catch {}
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
  return ((Date.now() - STARTED_AT) / 3600000) < MAX_RUNTIME_HOURS;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
//  COURTLISTENER FETCHERS
// ============================================================

async function fetchClusterPage(courtCode, dateStopStr, nextUrl, retries = 3) {
  const headers = { Authorization: `Token ${COURTLISTENER_TOKEN}` };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = nextUrl
        ? await axios.get(nextUrl, { headers, timeout: 60000 })
        : await axios.get("https://www.courtlistener.com/api/rest/v4/clusters/", {
            params: {
              docket__court:      courtCode,
              date_filed__gte:    dateStopStr,
              order_by:           "-date_filed",
              page_size:          CL_PAGE_SIZE,
              ...(INCLUDE_UNPUBLISHED ? {} : { precedential_status: "Published" }),
            },
            headers,
            timeout: 60000,
          });

      const results = (resp.data?.results || []).map(c => ({
        cluster_id:     c.id,
        case_name:      c.case_name || c.case_name_short || "",
        case_name_full: c.case_name_full || "",
        date_filed:     c.date_filed || null,
        date_approx:    c.date_filed_is_approximate,
        absolute_url:   c.absolute_url || "",
        slug:           c.slug || "",
        precedential:   c.precedential_status || "",
        citations:      c.citations || [],
        sub_opinions:   c.sub_opinions || [],
        judges:         c.judges || "",
        syllabus:       c.syllabus || "",
        docket_id:      c.docket_id,
        cite_count:     c.citation_count || 0,
      }));

      return { results, next: resp.data?.next || null, ok: true };
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) {
        log(`[CL] Rate limited — sleeping 60s (attempt ${attempt + 1}/${retries})`);
        await sleep(60000);
        continue;
      }
      if (status === 401 || status === 403) throw new Error(`CL auth error: ${status}`);
      if (status === 400 || status === 404) {
        log(`[CL] ${status} for court ${courtCode} — likely invalid court ID, aborting`);
        return { results: [], next: null, ok: false, abort: true };
      }

      const isTransient = !status || (status >= 500 && status < 600) || ["ECONNRESET","ETIMEDOUT","ECONNABORTED"].includes(err.code);
      if (isTransient && attempt < retries - 1) {
        const backoff = Math.min(60000, 5000 * Math.pow(2, attempt));
        log(`[CL] Transient error (${status || err.code}) for ${courtCode} — retry ${attempt + 1}/${retries} in ${backoff/1000}s`);
        await sleep(backoff);
        continue;
      }

      log(`[CL] Fetch error (${courtCode}) after ${retries} attempts: ${err.message}`);
      return { results: [], next: nextUrl, ok: false, transient: true };
    }
  }

  return { results: [], next: nextUrl, ok: false, transient: true };
}

async function fetchSubOpinion(opinionUrl) {
  if (!opinionUrl) return null;
  const headers = { Authorization: `Token ${COURTLISTENER_TOKEN}` };

  try {
    const resp = await axios.get(opinionUrl, { headers, timeout: 30000 });
    state.totals.sub_opinion_fetches++;

    const o = resp.data;
    const fullText = (o.plain_text || o.html_with_citations || o.html || o.xml_harvard || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      opinion_id: o.id,
      author:     (o.author_str || "").trim(),
      joined_by:  (o.joined_by_str || "").trim(),
      full_text:  fullText,
    };
  } catch {
    return null;
  }
}

// ============================================================
//  CLAUDE ANALYZER
// ============================================================

const STATIC_SCHEMA_PROMPT = `You are extracting structured data from a court ruling for a judge intelligence database at a California law firm.

Extract data for ANY substantive judge ruling — including:
- Civil motion rulings (demurrer, MSJ, motion to strike, motion to compel, UD, anti-SLAPP, PI/injunction, discovery, sanctions)
- Appellate decisions (affirmance, reversal, remand)
- Constitutional rulings, statutory interpretation
- Habeas petitions, removal/asylum decisions, criminal motions
- Class certification, Rule 12(b)(6), summary judgment review
- Any order or opinion deciding a contested legal issue

ONLY return {} for: pure procedural orders without legal reasoning (e.g., scheduling orders, certificate of service, simple cert grants/denials with no opinion text), opinions under 800 chars, or content that is clearly not a judicial ruling.

Respond with JSON only:
{
  "judge_name": "exact name of authoring judge or panel",
  "ruling_type": "Demurrer|MSJ|Motion to Strike|Motion to Compel|Unlawful Detainer|Anti-SLAPP|Preliminary Injunction|Discovery|Sanctions|Asylum|Removal|Cancellation|Habeas|Class Cert|Appeal|Constitutional|Statutory Interpretation|Criminal Motion|Other",
  "motion_type": "same as ruling_type, kept for backwards-compat",
  "result": "Granted|Denied|Sustained|Overruled|Affirmed|Reversed|Remanded|Vacated|Mixed|Continued|Dismissed",
  "key_phrases": ["exact phrases judge used in reasoning, max 5, under 15 words each"],
  "accepted_args": ["specific arguments/grounds judge agreed with, max 4"],
  "rejected_args": ["specific arguments judge rejected with brief reason, max 4"],
  "cited_statutes": ["CCP 430.10", "8 U.S.C. § 1158", etc., max 6],
  "cited_cases": ["case names only, max 6"],
  "holding": "the rule of law established or applied, in one sentence (e.g., 'Asylum requires nexus between persecution and a protected ground')",
  "legal_standard": "exact standard applied (e.g., 'Iqbal/Twombly', 'CCP 430.10(e)', 'reasonable possibility of persecution')",
  "decisive_factor": "the single most important reason for the ruling in one sentence",
  "reasoning_notes": "2 sentence summary: what the judge required and why the case came out this way",
  "leave_to_amend": true
}

For appellate/SCOTUS opinions: ruling_type = "Appeal" or "Constitutional", result = "Affirmed/Reversed/Remanded", and "holding" should capture the rule of law most likely to be cited later.
For BIA/immigration: ruling_type = "Asylum/Removal/Cancellation", capture the procedural posture.
For trial court motions: ruling_type matches the motion (Demurrer, MSJ, etc.).`;

async function analyzeWithClaude(ruling) {
  if (!ruling.full_text || ruling.full_text.length < MIN_TEXT_LENGTH) return null;

  const dynamic = `Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}
Case: ${ruling.case_name || "Unknown"}

RULING TEXT:
${ruling.full_text.substring(0, MAX_PROMPT_CHARS)}`;

  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: [
          { type: "text", text: STATIC_SCHEMA_PROMPT, cache_control: { type: "ephemeral" } },
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
    try { parsed = JSON.parse(clean); } catch { return null; }

    if (!parsed.judge_name || !parsed.motion_type) return null;
    return { ...ruling, ...parsed, judge_name: parsed.judge_name || ruling.judge_name };
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
//  STORE RULING
// ============================================================

async function storeRuling(analyzed) {
  if (!analyzed.judge_name || analyzed.judge_name.length < 3) return false;

  try {
    const profileResult = await db.query(`
      INSERT INTO judge_profiles (judge_name, court, court_type, total_rulings)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (judge_name, court) DO UPDATE SET
        total_rulings = judge_profiles.total_rulings + 1,
        last_updated  = NOW()
      RETURNING id
    `, [analyzed.judge_name, analyzed.court, analyzed.court_type || "federal"]);

    const profileId = profileResult.rows[0].id;

    await db.query(`
      INSERT INTO judge_rulings
        (judge_profile_id, judge_name, court, motion_type, result,
         case_name, case_number, hearing_date, full_text, url, source, processed, cluster_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12)
      ON CONFLICT DO NOTHING
    `, [
      profileId,
      analyzed.judge_name,
      analyzed.court,
      analyzed.motion_type,
      analyzed.result,
      analyzed.case_name,
      analyzed.case_number || null,
      analyzed.hearing_date,
      analyzed.full_text,
      analyzed.url,
      "CourtListener (expand-scan v2)",
      analyzed.cluster_id || null,
    ]);

    if (analyzed.motion_type) {
      const insightExists = await db.query(`
        SELECT id, grant_count, deny_count, key_phrases, accepted_args, rejected_args, cited_statutes, cited_cases
        FROM judge_insights
        WHERE judge_profile_id = $1 AND motion_type = $2
      `, [profileId, analyzed.motion_type]);

      const isGrant = /^(Granted|Sustained)$/i.test(analyzed.result || "");
      const isDeny  = /^(Denied|Overruled)$/i.test(analyzed.result || "");

      if (insightExists.rows.length) {
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
//  PRE-FILTER: Skip already-indexed
// ============================================================

async function filterAlreadyIndexed(clusters) {
  if (!clusters.length) return [];

  const urls = clusters.map(c => c.absolute_url ? `https://www.courtlistener.com${c.absolute_url}` : null).filter(Boolean);
  const clusterIds = clusters.map(c => c.cluster_id ? String(c.cluster_id) : null).filter(Boolean);

  const [byUrl, byClusterId] = await Promise.all([
    urls.length
      ? db.query(`SELECT url FROM judge_rulings WHERE url = ANY($1::text[])`, [urls])
      : Promise.resolve({ rows: [] }),
    clusterIds.length
      ? db.query(`SELECT cluster_id FROM judge_rulings WHERE cluster_id::text = ANY($1::text[])`, [clusterIds])
      : Promise.resolve({ rows: [] }),
  ]);

  const existingUrls = new Set(byUrl.rows.map(r => r.url));
  const existingClusterIds = new Set(byClusterId.rows.map(r => String(r.cluster_id)));

  return clusters.filter(c => {
    const url = c.absolute_url ? `https://www.courtlistener.com${c.absolute_url}` : null;
    if (url && existingUrls.has(url)) return false;
    if (c.cluster_id && existingClusterIds.has(String(c.cluster_id))) return false;
    return true;
  });
}

// ============================================================
//  EXTRACT JUDGE NAMES
// ============================================================

function extractJudgeNames(text, cluster, opinion) {
  const names = new Set();

  if (opinion?.author && opinion.author.length > 2) names.add(opinion.author.trim());
  if (opinion?.joined_by) {
    opinion.joined_by.split(/[,;]/).forEach(n => {
      const trimmed = n.trim();
      if (trimmed.length > 2) names.add(trimmed);
    });
  }
  if (cluster?.judges) {
    cluster.judges.split(/[,;]/).forEach(n => {
      const trimmed = n.trim();
      if (trimmed.length > 2) names.add(trimmed);
    });
  }

  const matches = (text || "").match(/(?:Hon(?:orable)?\.?|Judge|Justice)\s+([A-Z][a-z]+(?:\s+[A-Z]\.\s*)?(?:\s+[A-Z][a-z]+){1,3})/g) || [];
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

  const dateStopStr = `${court.dateStop}-01-01`;

  const cs = state.courts[courtKey] = state.courts[courtKey] || {
    status: "running",
    page: 0,
    totalFound: 0,
    processed: 0,
    errors: 0,
    skipped: 0,
    cursor: null,
    dateAfter: dateStopStr,
    dateStop: dateStopStr,
    earliestSeen: null,
    latestSeen: null,
    pagesUnder: 0,
  };

  if (!cs.dateStop) cs.dateStop = dateStopStr;
  if (cs.pagesUnder === undefined) cs.pagesUnder = 0;

  cs.status = "running";
  state.current_court = courtKey;

  log(`╔═════════════════════════════════════════════╗`);
  log(`║ ${court.name.padEnd(43)} ║`);
  log(`║ stops at ${cs.dateStop}, imm_only=${court.immigrationOnly ? "YES" : "no "}, pub_only=${INCLUDE_UNPUBLISHED ? "no" : "YES"}${" ".repeat(2)}║`);
  log(`╚═════════════════════════════════════════════╝`);

  const keywords = court.immigrationOnly ? IMMIGRATION_KEYWORDS : PRACTICE_KEYWORDS;
  let consecutiveErrors = 0;

  while (true) {
    if (!checkBudget()) {
      log(`[${courtKey}] runtime budget exceeded — pausing`);
      cs.status = "paused_budget";
      saveCheckpoint();
      return;
    }

    if (cs.totalFound >= MAX_CLUSTERS_PER_COURT) {
      log(`[${courtKey}] hit per-court max (${MAX_CLUSTERS_PER_COURT}) — moving on`);
      cs.status = "paused_max";
      saveCheckpoint();
      return;
    }

    const batch = await fetchClusterPage(court.clCourt, cs.dateAfter, cs.cursor);

    if (batch.abort) {
      log(`[${courtKey}] aborting — permanent error`);
      cs.status = "aborted";
      saveCheckpoint();
      return;
    }

    if (batch.transient) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        log(`[${courtKey}] 3 consecutive transient errors — pausing`);
        cs.status = "paused_errors";
        saveCheckpoint();
        return;
      }
      log(`[${courtKey}] transient error #${consecutiveErrors} — sleeping 30s`);
      await sleep(30000);
      continue;
    }

    consecutiveErrors = 0;

    if (batch.ok && !batch.results.length) {
      log(`[${courtKey}] no more results — court fully scanned`);
      break;
    }

    cs.page++;
    cs.totalFound += batch.results.length;
    state.totals.fetched += batch.results.length;

    let pageEarliest = null, pageLatest = null, allBelowStop = true;
    for (const c of batch.results) {
      if (!c.date_filed) continue;
      const yyyy = parseInt(c.date_filed.substring(0, 4));
      if (!yyyy) continue;
      if (yyyy >= court.dateStop) allBelowStop = false;
      if (!pageEarliest || c.date_filed < pageEarliest) pageEarliest = c.date_filed;
      if (!pageLatest   || c.date_filed > pageLatest)   pageLatest   = c.date_filed;
    }
    if (pageEarliest) cs.earliestSeen = (!cs.earliestSeen || pageEarliest < cs.earliestSeen) ? pageEarliest : cs.earliestSeen;
    if (pageLatest)   cs.latestSeen   = (!cs.latestSeen   || pageLatest   > cs.latestSeen)   ? pageLatest   : cs.latestSeen;

    if (allBelowStop && batch.results.length > 0) {
      cs.pagesUnder = (cs.pagesUnder || 0) + 1;
      log(`[${courtKey}] page ${cs.page}: ALL clusters below dateStop ${court.dateStop} (range ${pageEarliest}..${pageLatest}, pagesUnder=${cs.pagesUnder})`);
      if (cs.pagesUnder >= 3) {
        log(`[${courtKey}] reached dateStop ${court.dateStop} — finishing court`);
        break;
      }
      saveCheckpoint();
      if (!batch.next) break;
      cs.cursor = batch.next;
      continue;
    } else {
      cs.pagesUnder = 0;
    }

    const fresh = await filterAlreadyIndexed(batch.results);
    cs.skipped += (batch.results.length - fresh.length);
    state.totals.skipped += (batch.results.length - fresh.length);

    log(`[${courtKey}] page ${cs.page}: ${batch.results.length} fetched (${pageLatest}..${pageEarliest}), ${fresh.length} new, ${batch.results.length - fresh.length} already-indexed`);

    // Fetch sub_opinions in parallel batches, then keyword-filter, then build candidates
    const candidates = [];
    for (let i = 0; i < fresh.length; i += SUB_OPINION_CONCURRENCY) {
      if (!checkBudget()) { cs.status = "paused_budget"; saveCheckpoint(); return; }

      const slice = fresh.slice(i, i + SUB_OPINION_CONCURRENCY);
      const opinions = await Promise.all(
        slice.map(c => c.sub_opinions.length ? fetchSubOpinion(c.sub_opinions[0]) : null)
      );

      for (let j = 0; j < slice.length; j++) {
        const cluster = slice[j];
        const opinion = opinions[j];

        if (!opinion || !opinion.full_text || opinion.full_text.length < MIN_TEXT_LENGTH) {
          // Save minimal judge profile if we have author from cluster
          if (cluster.judges) {
            const names = cluster.judges.split(/[,;]/).map(n => n.trim()).filter(n => n.length > 2);
            for (const name of names.slice(0, 3)) {
              try {
                await db.query(`
                  INSERT INTO judge_profiles (judge_name, court, court_type, total_rulings)
                  VALUES ($1, $2, $3, 1)
                  ON CONFLICT (judge_name, court) DO UPDATE SET
                    total_rulings = judge_profiles.total_rulings + 1,
                    last_updated  = NOW()
                `, [name, court.name, court.type]);
              } catch {}
            }
          }
          continue;
        }

        // Date filter — skip if individual cluster is below dateStop
        const clusterYear = parseInt((cluster.date_filed || "").substring(0, 4));
        if (clusterYear && clusterYear < court.dateStop) continue;

        // Keyword filter — default OFF (collect all). Enabled if --keyword-filter
        // OR if court is immigration-only (filters general circuit cases to immigration matters)
        const useKeywordFilter = USE_KEYWORD_FILTER || court.immigrationOnly;
        if (useKeywordFilter) {
          const lower = opinion.full_text.toLowerCase();
          const isRelevant = keywords.some(kw => lower.includes(kw));
          if (!isRelevant) continue;
        }

        const judgeNames = extractJudgeNames(opinion.full_text, cluster, opinion);

        const citationStr = (cluster.citations || [])
          .map(ct => `${ct.volume} ${ct.reporter} ${ct.page}`)
          .filter(Boolean)
          .join("; ");

        for (const judgeName of judgeNames) {
          candidates.push({
            judge_name:   judgeName,
            court:        court.name,
            court_type:   court.type,
            cluster_id:   cluster.cluster_id,
            case_name:    cluster.case_name,
            case_number:  citationStr,
            hearing_date: cluster.date_filed,
            full_text:    opinion.full_text,
            url:          cluster.absolute_url ? `https://www.courtlistener.com${cluster.absolute_url}` : null,
          });
        }
      }
    }

    // Process candidates with Claude analysis (5 parallel)
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      if (!checkBudget()) { cs.status = "paused_budget"; saveCheckpoint(); return; }

      const slice = candidates.slice(i, i + CONCURRENCY);
      const analyzed = await Promise.all(
        slice.map(c => analyzeWithClaude(c).catch(e => { state.totals.errors++; return null; }))
      );

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

    saveCheckpoint();
    log(`[${courtKey}] page ${cs.page} done: total ${cs.processed} stored, ${cs.skipped} skipped, latest=${cs.latestSeen}, earliest=${cs.earliestSeen}`);

    if (cs.page % CL_PAUSE_EVERY === 0) {
      log(`[${courtKey}] pausing ${CL_PAUSE_MS/1000}s after page ${cs.page}`);
      await sleep(CL_PAUSE_MS);
    }

    if (!batch.next) break;
    cs.cursor = batch.next;
  }

  cs.status = "complete";
  saveCheckpoint();
  log(`[${courtKey}] ✅ COMPLETE — ${cs.totalFound} fetched, ${cs.processed} stored, ${cs.skipped} skipped, range ${cs.earliestSeen}..${cs.latestSeen}`);
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
    runtime_hours: ((Date.now() - STARTED_AT) / 3600000).toFixed(2),
    courts:        state.courts,
    totals:        state.totals,
    db_stats:      stats.rows[0],
  };

  try { fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); } catch {}

  log("");
  log(`Runtime: ${report.runtime_hours}h`);
  log(`Total judges:   ${report.db_stats.total_judges}`);
  log(`Total rulings:  ${report.db_stats.total_rulings} (+${report.db_stats.new_rulings_this_run} this run)`);
  log(`Total insights: ${report.db_stats.total_insights}`);
  log(`Claude calls:   ${state.totals.claude_calls}`);
  log(`Sub-opinion fetches: ${state.totals.sub_opinion_fetches}`);
  log(`Skipped:        ${state.totals.skipped} (already-indexed)`);
  log(`Errors:         ${state.totals.errors}`);
  log("");
  log(`By court:`);
  for (const [k, c] of Object.entries(state.courts)) {
    log(`  ${k}: ${c.status} — ${c.totalFound} fetched, ${c.processed} stored, ${c.skipped} skipped, range ${c.earliestSeen}..${c.latestSeen}`);
  }
  log(`Full report: cat ${REPORT_FILE}`);
}

// ============================================================
//  MAIN
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  let courtsToRun = DEFAULT_SCAN_ORDER;
  let rescan = false;
  let overrideStop = null;

  for (const a of args) {
    if (a.startsWith("--courts="))            courtsToRun = a.split("=")[1].split(",");
    else if (a.startsWith("--max-hours="))    MAX_RUNTIME_HOURS = parseFloat(a.split("=")[1]);
    else if (a.startsWith("--max-clusters=")) MAX_CLUSTERS_PER_COURT = parseInt(a.split("=")[1]);
    else if (a === "--include-unpublished")   INCLUDE_UNPUBLISHED = true;
    else if (a === "--keyword-filter")        USE_KEYWORD_FILTER = true;
    else if (a === "--rescan")                rescan = true;
    else if (a.startsWith("--rescan="))      { courtsToRun = a.split("=")[1].split(","); rescan = true; }
    else if (a.startsWith("--stop-year="))    overrideStop = parseInt(a.split("=")[1]);
  }

  if (overrideStop) {
    for (const k of courtsToRun) if (COURTS[k]) COURTS[k].dateStop = overrideStop;
  }

  log("═".repeat(60));
  log("MOAT EXPANSION SCAN v2 — /clusters/ endpoint");
  log("═".repeat(60));
  log(`Courts: ${courtsToRun.join(", ")}`);
  log(`Per-court dateStop: ${courtsToRun.map(k => k + "→" + (COURTS[k]?.dateStop || "?")).join(", ")}`);
  log(`Max runtime: ${MAX_RUNTIME_HOURS === Infinity ? "UNLIMITED" : MAX_RUNTIME_HOURS + "h"}`);
  log(`Max clusters per court: ${MAX_CLUSTERS_PER_COURT === Infinity ? "UNLIMITED" : MAX_CLUSTERS_PER_COURT}`);
  log(`Include unpublished: ${INCLUDE_UNPUBLISHED ? "YES" : "no (Published only)"}`);
  log(`Keyword filter: ${USE_KEYWORD_FILTER ? "YES (only ruling-keyword matches)" : "no (analyze all opinions; immigration courts still filter)"}`);
  log(`Rescan complete courts: ${rescan ? "YES" : "no"}`);
  log(`Concurrency: ${CONCURRENCY} Claude calls + ${SUB_OPINION_CONCURRENCY} sub-opinion fetches`);
  log("");

  const cp = loadCheckpoint();
  if (cp) {
    state = cp;
    log(`[init] Resumed from checkpoint`);
  } else {
    state.job_id = `expand-${Date.now()}`;
    saveCheckpoint();
  }

  if (rescan) {
    for (const k of courtsToRun) {
      if (state.courts[k]) {
        log(`[init] --rescan: clearing prior status for ${k}`);
        delete state.courts[k];
      }
    }
    saveCheckpoint();
  }

  for (const courtKey of courtsToRun) {
    if (!checkBudget()) { log(`[main] Runtime budget exhausted — stopping`); break; }
    const existing = state.courts[courtKey];
    if (existing?.status === "complete") {
      log(`[${courtKey}] already complete — skipping (use --rescan to redo)`);
      continue;
    }
    if (existing?.status === "aborted") {
      log(`[${courtKey}] previously aborted — skipping`);
      continue;
    }
    if (existing?.cursor) {
      log(`[${courtKey}] resuming from page ${existing.page || "?"} (status: ${existing.status})`);
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
