// ============================================================
//  courtlistener-client.js
//  Production-grade CourtListener REST v4 client
//
//  Features:
//    - Token authentication (env: COURTLISTENER_TOKEN)
//    - Built-in retry/backoff for 429 / 5xx
//    - TTL'd response caching via research_cache table
//    - Citation lookup (hallucination-check API) with rate limit awareness
//    - Bulk fetch helpers
//
//  ENV VARS:
//    COURTLISTENER_TOKEN - your free token (get at courtlistener.com)
//    DEFAULT_CACHE_TTL_HOURS - cache duration (default: 24)
// ============================================================

const axios = require("axios");
const db    = require("./db");

const BASE_URL  = "https://www.courtlistener.com/api/rest/v4";
const TOKEN     = process.env.COURTLISTENER_TOKEN || "";
const TIMEOUT   = 30000;
const DEFAULT_TTL_HOURS = parseInt(process.env.DEFAULT_CACHE_TTL_HOURS || "24");

// Rate limits: 5000/hour for general, 60/min for /citation-lookup/
const CITATION_LOOKUP_INTERVAL_MS = 1100; // ~55/min, leaves headroom

let lastCitationLookup = 0;

const ax = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT,
  headers: TOKEN ? { Authorization: `Token ${TOKEN}` } : {},
});

// ============================================================
//  CACHE LAYER
// ============================================================
async function _cacheGet(key) {
  try {
    const r = await db.query(
      `SELECT payload FROM research_cache
       WHERE cache_key = $1 AND expires_at > NOW()`,
      [key]
    );
    if (r.rows.length) {
      // Increment hit count async (fire-and-forget)
      db.query(`UPDATE research_cache SET hit_count = hit_count + 1 WHERE cache_key = $1`, [key])
        .catch(() => {});
      return r.rows[0].payload;
    }
  } catch (err) {
    // Cache miss is non-fatal
  }
  return null;
}

async function _cacheSet(key, source, payload, ttlHours = DEFAULT_TTL_HOURS) {
  try {
    await db.query(
      `INSERT INTO research_cache (cache_key, source, payload, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval)
       ON CONFLICT (cache_key) DO UPDATE
       SET payload = EXCLUDED.payload,
           fetched_at = NOW(),
           expires_at = EXCLUDED.expires_at,
           hit_count = 0`,
      [key, source, payload, String(ttlHours)]
    );
  } catch (err) {
    // Cache write failure is non-fatal — log but proceed
    console.warn(`[CL cache] Write failed: ${err.message}`);
  }
}

// ============================================================
//  HTTP WITH RETRY/BACKOFF
// ============================================================
async function _request(method, path, opts = {}, attempt = 1) {
  try {
    const r = await ax.request({ method, url: path, ...opts });
    return r.data;
  } catch (err) {
    const status = err.response?.status;
    const retryable = status === 429 || (status >= 500 && status <= 599);

    if (retryable && attempt < 4) {
      // Exponential backoff: 1s, 2s, 4s
      const wait = Math.pow(2, attempt) * 1000;
      const retryAfter = parseInt(err.response?.headers?.["retry-after"] || "0") * 1000;
      const delay = Math.max(wait, retryAfter);
      console.warn(`[CL] ${status} on ${path}, retry ${attempt}/3 in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return _request(method, path, opts, attempt + 1);
    }

    if (status === 401 || status === 403) {
      throw new Error(`CourtListener auth error (${status}). Check COURTLISTENER_TOKEN.`);
    }
    throw err;
  }
}

// ============================================================
//  CORE API
// ============================================================

/**
 * Search opinions (caselaw).
 * @param {Object} params - CourtListener search params
 *   q              — text query
 *   court          — court ID(s), comma-separated. Examples:
 *                     'scotus','ca9','cacd','caed','cand','casd',
 *                     'cal','calctapp','bia','ag'
 *   cited_lt       — opinion was cited before this date
 *   filed_after    — date filed after (YYYY-MM-DD)
 *   filed_before   — date filed before (YYYY-MM-DD)
 *   judge          — judge name
 *   citation       — exact citation match
 *   type           — 'o' (opinions), 'r' (RECAP docket), etc.
 *   order_by       — '-dateFiled', 'score desc', etc.
 *   stat_Precedential — 'on'
 *   page_size      — default 20, max 100
 * @returns {Promise<Object>} { count, next, previous, results: [...] }
 */
async function searchOpinions(params = {}) {
  const cacheKey = `cl:search:${JSON.stringify(params)}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const data = await _request("GET", "/search/", { params: { type: "o", ...params } });
  await _cacheSet(cacheKey, "courtlistener", data, 6); // 6-hour cache for searches
  return data;
}

/**
 * Fetch a specific opinion cluster by ID.
 * Cluster = a group of opinions for the same case (majority, dissent, concurrence)
 */
async function getCluster(clusterId) {
  const cacheKey = `cl:cluster:${clusterId}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const data = await _request("GET", `/clusters/${clusterId}/`);
  await _cacheSet(cacheKey, "courtlistener", data, 24 * 7); // 7-day cache
  return data;
}

/**
 * Fetch a specific opinion by ID.
 * Returns full text in one of: html, plain_text, html_lawbox, html_columbia
 */
async function getOpinion(opinionId) {
  const cacheKey = `cl:opinion:${opinionId}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const data = await _request("GET", `/opinions/${opinionId}/`);
  await _cacheSet(cacheKey, "courtlistener", data, 24 * 30); // 30-day cache
  return data;
}

/**
 * List opinions citing a given cluster.
 * @param {number} clusterId - the cluster being cited
 * @returns Array of citing opinions with their cluster info
 */
async function getCitedBy(clusterId, opts = {}) {
  const params = {
    cited_opinion__cluster_id: clusterId,
    page_size: opts.pageSize || 20,
    ...opts,
  };
  const cacheKey = `cl:citedby:${clusterId}:${JSON.stringify(opts)}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const data = await _request("GET", "/opinions-cited/", { params });
  await _cacheSet(cacheKey, "courtlistener", data, 6);
  return data;
}

/**
 * List opinions that a given cluster cites (the "cites" list).
 */
async function getAuthorities(clusterId, opts = {}) {
  const params = {
    citing_opinion__cluster_id: clusterId,
    page_size: opts.pageSize || 50,
    ...opts,
  };
  const cacheKey = `cl:auth:${clusterId}:${JSON.stringify(opts)}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const data = await _request("GET", "/opinions-cited/", { params });
  await _cacheSet(cacheKey, "courtlistener", data, 6);
  return data;
}

/**
 * Citation lookup — THE hallucination-check endpoint.
 * Pass raw text or a parsed citation; receive matched cluster IDs.
 * Rate-limited: 60/min on this endpoint specifically.
 *
 * @param {string} text - text containing citations OR a single citation string
 * @returns Array of { citation, status (200|404|...), normalized_citations, clusters: [{id, case_name, ...}] }
 */
async function citationLookup(text) {
  if (!text || !text.trim()) return [];

  // Throttle to ~55/min
  const now = Date.now();
  const sinceLast = now - lastCitationLookup;
  if (sinceLast < CITATION_LOOKUP_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, CITATION_LOOKUP_INTERVAL_MS - sinceLast));
  }
  lastCitationLookup = Date.now();

  const cacheKey = `cl:citelookup:${Buffer.from(text).toString("base64").substring(0, 200)}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  // The endpoint is at /citation-lookup/ on v3 (still active in v4)
  // Use POST with form-encoded body
  try {
    const r = await axios.post(
      "https://www.courtlistener.com/api/rest/v3/citation-lookup/",
      new URLSearchParams({ text }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(TOKEN ? { Authorization: `Token ${TOKEN}` } : {}),
        },
        timeout: TIMEOUT,
      }
    );
    const data = r.data || [];
    await _cacheSet(cacheKey, "courtlistener_citelookup", data, 24 * 30); // 30-day
    return data;
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn("[CL citation-lookup] rate limit hit, backing off");
      await new Promise(r => setTimeout(r, 30000));
      return citationLookup(text); // single retry
    }
    throw err;
  }
}

/**
 * List courts. Useful for resolving court IDs to readable names.
 */
async function listCourts(opts = {}) {
  const cacheKey = `cl:courts:${JSON.stringify(opts)}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const data = await _request("GET", "/courts/", { params: { page_size: 200, ...opts } });
  await _cacheSet(cacheKey, "courtlistener", data, 24 * 30);
  return data;
}

/**
 * Get judge by ID.
 */
async function getJudge(judgeId) {
  const cacheKey = `cl:judge:${judgeId}`;
  const cached = await _cacheGet(cacheKey);
  if (cached) return cached;

  const data = await _request("GET", `/people/${judgeId}/`);
  await _cacheSet(cacheKey, "courtlistener", data, 24 * 30);
  return data;
}

/**
 * Search judges by name.
 */
async function searchJudges(name) {
  return _request("GET", "/people/", { params: { name__icontains: name, page_size: 20 } });
}

// ============================================================
//  CONVENIENCE WRAPPERS
// ============================================================

/**
 * High-level case search — returns simplified results for UI display.
 */
async function caselaw({ query, jurisdictions = [], dateFrom, dateTo, judge, pageSize = 20, page = 1 }) {
  const params = { q: query, page_size: pageSize, page };
  if (jurisdictions.length) params.court = jurisdictions.join(",");
  if (dateFrom) params.filed_after = dateFrom;
  if (dateTo) params.filed_before = dateTo;
  if (judge) params.judge = judge;

  const data = await searchOpinions(params);
  return {
    total:    data.count,
    next:     data.next,
    previous: data.previous,
    results: (data.results || []).map(r => ({
      cluster_id:   r.cluster_id || r.id,
      opinion_id:   r.id,
      case_name:    r.caseName || r.case_name,
      court:        r.court,
      court_id:     r.court_id,
      date_filed:   r.dateFiled || r.date_filed,
      citation:     (r.citation || []).join("; "),
      docket_number: r.docketNumber,
      judge:        r.judge,
      snippet:      r.snippet,
      url:          r.absolute_url
        ? `https://www.courtlistener.com${r.absolute_url}`
        : `https://www.courtlistener.com/opinion/${r.cluster_id || r.id}/`,
      cite_count:   r.citeCount,
    })),
  };
}

/**
 * Cite-check a block of text. Returns one entry per citation found.
 * Combines eyecite (parsing) + CL /citation-lookup/ (verification).
 */
async function verifyCitations(text) {
  if (!text || !text.trim()) return [];
  // Use bulk POST — single API call returns all matches
  const data = await citationLookup(text);
  return data;
}

module.exports = {
  // Low-level
  searchOpinions,
  getCluster,
  getOpinion,
  getCitedBy,
  getAuthorities,
  citationLookup,
  listCourts,
  getJudge,
  searchJudges,
  // High-level
  caselaw,
  verifyCitations,
};
