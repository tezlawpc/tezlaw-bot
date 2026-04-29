// ============================================================
//  research-engine.js
//  Orchestrator for the expanded Research module.
//  Mounts REST endpoints used by admin.js Research tab UI.
//
//  EXPORTS Express router — mount in server.js with:
//    const researchRouter = require("./research-engine");
//    app.use("/admin/api/research", requireAuth, researchRouter);
// ============================================================

const express = require("express");
const router  = express.Router();
const db      = require("./db");

const cl       = require("./courtlistener-client");
const statutes = require("./statute-fetcher");
const xref     = require("./judge-cross-reference");

// Optional dependencies — gracefully degrade if unavailable
let eyecite = null;
try { eyecite = require("./eyecite-bridge"); } catch (e) { /* sidecar not deployed */ }

// ============================================================
//  HEALTH CHECK
// ============================================================
router.get("/health", async (req, res) => {
  const services = {
    courtlistener: !!process.env.COURTLISTENER_TOKEN,
    eyecite:       eyecite ? await eyecite.health() : false,
    govinfo:       !!process.env.GOVINFO_API_KEY,
    database:      false,
  };
  try {
    await db.query("SELECT 1");
    services.database = true;
  } catch {}
  res.json({ ok: true, services });
});

// ============================================================
//  CASE LAW — UNIFIED SEARCH
// ============================================================

/**
 * GET /search
 * Query params:
 *   q                — search query
 *   jurisdiction[]   — array of court IDs (e.g., ['ca9','cacd'])
 *   court_level      — 'scotus','federal_appeals','federal_district','state','admin'
 *   date_from, date_to — YYYY-MM-DD
 *   judge            — judge name
 *   practice_area    — 'immigration','pi','employment',...
 *   page             — 1
 *   page_size        — 20
 */
router.get("/search", async (req, res) => {
  const {
    q, judge, date_from, date_to,
    page = 1, page_size = 20,
    practice_area,
  } = req.query;

  let jurisdictions = req.query.jurisdiction || [];
  if (typeof jurisdictions === "string") jurisdictions = jurisdictions.split(",");

  // Auto-add jurisdictions based on court_level
  if (req.query.court_level) {
    const levels = {
      scotus: ["scotus"],
      federal_appeals: ["ca1","ca2","ca3","ca4","ca5","ca6","ca7","ca8","ca9","ca10","ca11","cadc","cafc"],
      federal_district: ["cacd","caed","cand","casd"],
      california_state: ["cal","calctapp"],
      immigration: ["bia","ag"],
    };
    if (levels[req.query.court_level]) jurisdictions = [...new Set([...jurisdictions, ...levels[req.query.court_level]])];
  }

  // Practice-area presets
  if (practice_area === "immigration") {
    jurisdictions = [...new Set([...jurisdictions, "bia","ag","ca9"])];
  } else if (practice_area === "pi" || practice_area === "personal_injury") {
    jurisdictions = [...new Set([...jurisdictions, "cal","calctapp","cacd"])];
  }

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: "Query 'q' required (min 2 chars)" });
  }

  try {
    const data = await cl.caselaw({
      query:       q,
      jurisdictions,
      dateFrom:    date_from,
      dateTo:      date_to,
      judge,
      pageSize:    Math.min(parseInt(page_size), 100),
      page:        parseInt(page),
    });

    // Log search history (fire-and-forget)
    if (req.user?.id) {
      db.query(
        `INSERT INTO search_history (user_id, query_text, query_mode, sources_searched, filters, result_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.user.id, q, "nl", ["courtlistener"], req.query, data.total]
      ).catch(() => {});
    }

    res.json(data);
  } catch (err) {
    console.error("[research /search]", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /case/:clusterId
 * Returns case detail + cited-by + authorities + judge cross-reference
 */
router.get("/case/:clusterId", async (req, res) => {
  const { clusterId } = req.params;

  try {
    // Parallel fetches
    const [cluster, citedBy, authorities] = await Promise.all([
      cl.getCluster(clusterId),
      cl.getCitedBy(clusterId, { pageSize: 10 }).catch(() => ({ results: [] })),
      cl.getAuthorities(clusterId, { pageSize: 30 }).catch(() => ({ results: [] })),
    ]);

    // Optional: full opinion text (first sub_opinions entry)
    let fullText = null;
    if (cluster.sub_opinions?.length) {
      const opUrl = cluster.sub_opinions[0];
      const opId = opUrl.match(/\/opinions\/(\d+)/)?.[1];
      if (opId) {
        try {
          const op = await cl.getOpinion(opId);
          fullText = op.html_with_citations || op.html || op.plain_text || null;
        } catch {}
      }
    }

    // Judge cross-reference: which judges in our DB have cited this?
    const citation = (cluster.citations || [])[0];
    const citationStr = citation
      ? `${citation.volume} ${citation.reporter} ${citation.page}`
      : null;

    let judgesCiting = [];
    if (citationStr || cluster.case_name) {
      judgesCiting = await xref.judgesCitingCase({
        citation: citationStr,
        caseName: cluster.case_name,
        caseId:   clusterId,
      });
    }

    res.json({
      cluster_id:    clusterId,
      case_name:     cluster.case_name,
      citations:     cluster.citations || [],
      court:         cluster.docket?.court_id,
      docket_number: cluster.docket?.docket_number,
      date_filed:    cluster.date_filed,
      judges:        cluster.judges,
      url:           `https://www.courtlistener.com/opinion/${clusterId}/`,
      full_text:     fullText,
      authorities:   authorities.results || [],
      cited_by:      citedBy.results || [],
      cite_count:    citedBy.count || 0,
      judges_in_firm_db_who_cited: judgesCiting,
    });
  } catch (err) {
    console.error(`[research /case/${clusterId}]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CITATION VERIFICATION (the hallucination-check endpoint)
// ============================================================

/**
 * POST /verify-citation
 * Body: { text: "..." }
 * Returns verified citations from CourtListener /citation-lookup/.
 */
router.post("/verify-citation", express.json({ limit: "5mb" }), async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Body must include 'text'" });
  }

  try {
    const verified = await cl.verifyCitations(text);

    // Optional: also extract via eyecite for richer parsing
    let extracted = [];
    if (eyecite) {
      try {
        extracted = await eyecite.extract(text);
        extracted = eyecite.classifyTreatment(extracted);
      } catch {}
    }

    res.json({
      total_found: verified.length,
      verified,
      extracted_full: extracted,
    });
  } catch (err) {
    console.error("[research /verify-citation]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  STATUTE LOOKUPS
// ============================================================

/**
 * GET /statute/ca/:code/:section
 * California statutes
 */
router.get("/statute/ca/:code/:section", async (req, res) => {
  try {
    const r = await statutes.getCaliforniaStatute(req.params.code, req.params.section);
    res.json(r);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** GET /statute/usc/:title/:section — U.S. Code */
router.get("/statute/usc/:title/:section", async (req, res) => {
  try {
    const r = await statutes.getUSC(req.params.title, req.params.section);
    res.json(r);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** GET /statute/cfr/:title/:part/:section? — CFR */
router.get("/statute/cfr/:title/:part/:section?", async (req, res) => {
  try {
    const r = await statutes.getCFR(req.params.title, req.params.part, req.params.section);
    res.json(r);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

/** GET /federal-register?query=...&agency=...&type=... */
router.get("/federal-register", async (req, res) => {
  try {
    const r = await statutes.searchFederalRegister(req.query);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /statute/ca/codes — list available CA codes */
router.get("/statute/ca/codes", (req, res) => {
  res.json(statutes.CA_CODES);
});

// ============================================================
//  JUDGE CROSS-REFERENCE (THE MOAT)
// ============================================================

/**
 * GET /judge/:name/has-cited
 *   ?citation=... or ?case_name=... or ?case_id=...
 */
router.get("/judge/:name/has-cited", async (req, res) => {
  const caseRef = {
    citation: req.query.citation,
    caseName: req.query.case_name,
    caseId:   req.query.case_id,
  };
  try {
    const r = await xref.hasJudgeCited(req.params.name, caseRef);
    res.json({ count: r.length, citations: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /judge/:name/top-cited
 * Returns cases this judge cites most often.
 */
router.get("/judge/:name/top-cited", async (req, res) => {
  try {
    const r = await xref.judgeTopCitedCases(req.params.name, req.query.motion, parseInt(req.query.limit) || 20);
    res.json({ count: r.length, cases: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /judges-citing
 *   ?citation=... or ?case_name=... or ?case_id=...
 */
router.get("/judges-citing", async (req, res) => {
  const caseRef = {
    citation: req.query.citation,
    caseName: req.query.case_name,
    caseId:   req.query.case_id,
  };
  try {
    const r = await xref.judgesCitingCase(caseRef);
    res.json({ count: r.length, judges: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /co-cited
 *   ?citation=... or ?case_name=... or ?case_id=...
 *   &judge=Wardlaw (optional)
 */
router.get("/co-cited", async (req, res) => {
  const caseRef = {
    citation: req.query.citation,
    caseName: req.query.case_name,
    caseId:   req.query.case_id,
  };
  try {
    const r = await xref.coCitedCases(caseRef, req.query.judge, parseInt(req.query.limit) || 10);
    res.json({ count: r.length, cases: r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /predict-treatment
 * Body: { judge_name, citation?, case_name?, case_id?, motion_type? }
 */
router.post("/predict-treatment", express.json(), async (req, res) => {
  try {
    const { judge_name, citation, case_name, case_id, motion_type } = req.body;
    const r = await xref.predictionSnapshot(
      judge_name,
      { citation, caseName: case_name, caseId: case_id },
      motion_type
    );
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  COLLECTIONS & SAVED CASES
// ============================================================

/** GET /collections?matter_id=... */
router.get("/collections", async (req, res) => {
  try {
    const userId = req.user?.id;
    const matterId = req.query.matter_id;
    let q = `SELECT * FROM research_collections WHERE 1=1`;
    const params = [];
    if (matterId) { params.push(matterId); q += ` AND matter_id = $${params.length}`; }
    if (userId)   { params.push(userId);   q += ` AND (user_id = $${params.length} OR user_id IS NULL)`; }
    q += ` ORDER BY sort_order ASC, name ASC`;

    const r = await db.query(q, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /collections — create collection */
router.post("/collections", express.json(), async (req, res) => {
  try {
    const { matter_id, parent_id, name, color = "gray" } = req.body;
    if (!name) return res.status(400).json({ error: "'name' required" });
    const r = await db.query(`
      INSERT INTO research_collections (matter_id, parent_id, user_id, name, color)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [matter_id || null, parent_id || null, req.user?.id || null, name, color]);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /save — save a case/statute/etc to a collection */
router.post("/save", express.json(), async (req, res) => {
  try {
    const { collection_id, matter_id, resource_type, resource_id,
            cached_title, cached_citation, cached_snippet, cached_url,
            notes_md, tags } = req.body;

    if (!resource_type || !resource_id) {
      return res.status(400).json({ error: "'resource_type' and 'resource_id' required" });
    }

    const r = await db.query(`
      INSERT INTO saved_cases
        (collection_id, matter_id, user_id, resource_type, resource_id,
         cached_title, cached_citation, cached_snippet, cached_url, notes_md, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (matter_id, resource_type, resource_id, user_id)
      DO UPDATE SET
        cached_title = EXCLUDED.cached_title,
        cached_citation = EXCLUDED.cached_citation,
        cached_snippet = EXCLUDED.cached_snippet,
        cached_url = EXCLUDED.cached_url,
        notes_md = EXCLUDED.notes_md,
        tags = EXCLUDED.tags,
        collection_id = EXCLUDED.collection_id
      RETURNING *
    `, [
      collection_id || null, matter_id || null, req.user?.id || null,
      resource_type, resource_id,
      cached_title || null, cached_citation || null,
      cached_snippet || null, cached_url || null,
      notes_md || "", tags || [],
    ]);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /saved?matter_id=...&tag=... */
router.get("/saved", async (req, res) => {
  try {
    let q = `SELECT * FROM saved_cases WHERE 1=1`;
    const params = [];
    if (req.user?.id)        { params.push(req.user.id);          q += ` AND (user_id = $${params.length} OR user_id IS NULL)`; }
    if (req.query.matter_id) { params.push(req.query.matter_id);  q += ` AND matter_id = $${params.length}`; }
    if (req.query.tag)       { params.push(req.query.tag);        q += ` AND $${params.length} = ANY(tags)`; }
    if (req.query.type)      { params.push(req.query.type);       q += ` AND resource_type = $${params.length}`; }
    q += ` ORDER BY created_at DESC LIMIT 200`;

    const r = await db.query(q, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /save/:id */
router.delete("/save/:id", async (req, res) => {
  try {
    await db.query(`DELETE FROM saved_cases WHERE id = $1`, [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  HISTORY
// ============================================================
router.get("/history", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const params = [];
    let q = `SELECT * FROM search_history WHERE 1=1`;
    if (req.user?.id) { params.push(req.user.id); q += ` AND user_id = $${params.length}`; }
    params.push(limit);
    q += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const r = await db.query(q, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  USE-IN-BRIEF (HANDOFF TO LAYER 3)
// ============================================================

/**
 * POST /use-in-brief
 * Body: { resource_type, resource_id, brief_request: { judge, motion, ... } }
 *
 * Hands the case off to brief-generator.js as a supporting authority.
 */
router.post("/use-in-brief", express.json(), async (req, res) => {
  try {
    const { resource_type, resource_id, brief_request } = req.body;
    if (resource_type !== "case") {
      return res.status(400).json({ error: "Only resource_type=case supported currently" });
    }

    // Fetch case content
    const cluster = await cl.getCluster(resource_id);

    // Try to invoke Layer 3
    let layer3 = null;
    try { layer3 = require("./brief-generator"); }
    catch { return res.status(503).json({ error: "Layer 3 (brief-generator.js) not deployed" }); }

    const briefResult = await layer3.generateBrief({
      ...brief_request,
      pre_loaded_authorities: [{
        case_name: cluster.case_name,
        citation:  (cluster.citations || []).map(c => `${c.volume} ${c.reporter} ${c.page}`).join("; "),
        url:       `https://www.courtlistener.com/opinion/${resource_id}/`,
      }],
    });

    res.json(briefResult);
  } catch (err) {
    console.error("[research /use-in-brief]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
