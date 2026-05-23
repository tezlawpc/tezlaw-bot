// ============================================================
//  matter-manager.js — Tez Law P.C. | Matter Management API
//
//  REST API for managing active legal matters, deadlines,
//  notes, and document links. Mounted under /admin/matters
//  in server.js, inheriting admin auth via requireAuth.
//
//  Also exports a top-level calendar feed handler used by
//  GET /calendar/:secret.ics in server.js — the calendar feed
//  is NOT under /admin because Outlook/Google Calendar fetch
//  without cookies, authenticating via the per-user secret.
//
//  Cal. Rule of Professional Conduct 1.6 (confidentiality)
//  Cal. State Bar Formal Op. 2010-179 (cloud computing duties)
// ============================================================

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const db = require("./db");
const { requireAuth } = require("./admin");

const router = express.Router();

// ── Serve the dashboard UI at /admin/matters/ ────────────
// Auth-protected: unauthenticated users redirect to /admin/login
router.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "matters.html"));
});

// ── v2 dashboard at /admin/matters/v2 ─────────────────────
// Parallel new UI. The existing /admin/matters/ route is
// unchanged; v2 is a feature-flag preview to test the new
// case-card + checklists layout side-by-side before promoting.
router.get("/v2", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "matters-v2.html"));
});

// ─────────────────────────────────────────────────────────────
//  ORDER PARSER — Claude-powered deadline extraction
//
//  POST /admin/matters/api/parse
//  Body: { order_text: "...", matter_context: "..." (optional) }
//  Returns: { deadlines: [...], raw_response: "..." }
//
//  CRITICAL DESIGN CONSTRAINT: This endpoint PROPOSES deadlines.
//  It NEVER writes to the database. The client must explicitly
//  POST each accepted deadline to /api/matters/:id/deadlines.
//  This forces a human-confirmation click per deadline — the
//  friction is intentional and prevents Claude's extraction
//  errors from silently becoming missed court deadlines.
// ─────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a careful legal assistant extracting court-imposed deadlines from a legal document for a California immigration attorney.

The document below is a court order, minute order, NEF (Notice of Electronic Filing), BIA decision, scheduling order, or similar. Extract EVERY date-certain deadline you can find.

For each deadline you find, return:
- title: short description (e.g., "Opening Brief due", "CAR due", "Response to motion to dismiss due")
- due_date: ISO format YYYY-MM-DD. If the order says "within 30 days" without a starting date, do NOT guess — leave due_date null and explain in source_excerpt.
- party: who must act. "us" = the attorney (petitioner/movant/appellant client side). "them" = opposing party (gov/respondent/appellee). "court" = the court itself (e.g., when the court must rule by a date).
- citation: the rule or statute cited, if any (e.g., "FRAP 31", "8 USC § 1252(b)", "9th Cir. R. 31-2"). null if none.
- source_excerpt: the EXACT verbatim text from the document that supports this deadline (max 200 chars). This is critical — the attorney will verify your extraction against this excerpt.
- confidence: "high" / "medium" / "low".
  - high: explicit date in the document with clear party and trigger
  - medium: requires modest interpretation (e.g., computing 60 days from a stated start date)
  - low: ambiguous trigger, contingent on event not yet occurred, or unclear party

Important rules:
1. Do NOT compute deadlines from ambiguous starting points. If "within 30 days of filing the CAR" and CAR hasn't been filed, leave due_date null.
2. Do NOT fabricate. If you're not sure, say confidence: "low" and explain in source_excerpt.
3. Do include deadlines for the opposing party and the court — the attorney needs full case-wide awareness.
4. Use the calendar-day rule unless the document specifies business days. Federal: FRCP 6 / FRAP 26 generally use calendar days.
5. If the document mentions a date but it's not a deadline (e.g., date of order issuance, date of service), do NOT include it.

Return ONLY valid JSON with this exact shape, no other text:
{
  "deadlines": [
    {
      "title": "...",
      "due_date": "YYYY-MM-DD" or null,
      "party": "us" | "them" | "court",
      "citation": "..." or null,
      "source_excerpt": "...",
      "confidence": "high" | "medium" | "low"
    }
  ]
}

If you find no deadlines, return {"deadlines": []}.

DOCUMENT TO ANALYZE:
---
{ORDER_TEXT}
---`;

function callClaudeForExtraction(orderText) {
  const prompt = EXTRACTION_PROMPT.replace("{ORDER_TEXT}", orderText);
  return callClaudeAPI(prompt);
}

// Generic Claude API call returning the text content.
// Used by both order extraction and NEF intake parsing.
function callClaudeAPI(prompt, maxTokens = 4000) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error("ANTHROPIC_API_KEY not configured"));

    const payload = JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }]
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message || "Claude API error"));
          const text = data.content?.[0]?.text || "";
          resolve(text);
        } catch (e) {
          reject(new Error("Failed to parse Claude response: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

router.post("/api/parse", requireAuth, async (req, res) => {
  try {
    const { order_text } = req.body || {};

    if (!order_text || typeof order_text !== "string") {
      return res.status(400).json({ error: "order_text required" });
    }
    if (order_text.length < 30) {
      return res.status(400).json({ error: "Order text too short to analyze" });
    }
    if (order_text.length > 50000) {
      return res.status(400).json({ error: "Order text too long (max 50k chars). Paste relevant section." });
    }

    const responseText = await callClaudeForExtraction(order_text);

    // Claude should return JSON. Try to extract it even if wrapped in markdown.
    let parsed;
    try {
      // Strip markdown fences if present
      let cleaned = responseText.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Parser JSON error. Raw response:", responseText);
      return res.status(500).json({
        error: "Could not parse extraction. The order text may have confused the analyzer.",
        raw: responseText.substring(0, 500)
      });
    }

    if (!parsed.deadlines || !Array.isArray(parsed.deadlines)) {
      return res.status(500).json({ error: "Unexpected response shape from analyzer" });
    }

    // Validate each deadline has required fields and reasonable values
    const validated = parsed.deadlines
      .filter(d => d && typeof d === "object")
      .map(d => ({
        title: String(d.title || "Untitled").substring(0, 300),
        due_date: d.due_date && /^\d{4}-\d{2}-\d{2}$/.test(d.due_date) ? d.due_date : null,
        party: ["us", "them", "court"].includes(d.party) ? d.party : "us",
        citation: d.citation ? String(d.citation).substring(0, 200) : null,
        source_excerpt: d.source_excerpt ? String(d.source_excerpt).substring(0, 400) : "",
        confidence: ["high", "medium", "low"].includes(d.confidence) ? d.confidence : "low"
      }));

    res.json({ deadlines: validated });
  } catch (err) {
    console.error("POST /api/parse error:", err.message);
    res.status(500).json({ error: err.message || "Parser error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  NEF INTAKE PARSER — extract matter fields from email text
//
//  POST /admin/matters/api/parse-intake
//  Body: { nef_text: "..." }
//  Returns: { fields: {...}, raw_response: "..." }
//
//  Same propose-only design as the order parser: this returns
//  a proposed set of matter fields. The UI must show them in
//  an editable form before saving — never auto-creates a matter.
// ─────────────────────────────────────────────────────────────

const INTAKE_PROMPT = `You are extracting case information from a Notice of Electronic Filing (NEF), BIA decision, court order, or similar legal document so a California immigration attorney can open a new matter.

Extract these fields from the document. Be conservative — leave a field as null if not clearly present. Do NOT guess.

- client_name: The case caption. Use the format "Petitioner v. Respondent" if both parties named (e.g., "Lu v. Bondi" or "Zhang v. MULLIN"). If only one party named, use that party's name.
- petitioner_name: The full name of the petitioner/plaintiff/movant (e.g., "Guangfeng Lu", "Jiabin Zhang"). Single individual, not a caption.
- matter_ref: The case number or A-number (e.g., "5:26-cv-02340", "A 216-866-000", "23-1234"). Preserve formatting.
- court: Use SHORT FORM:
  - "9th Cir." for Court of Appeals for the Ninth Circuit
  - "C.D. Cal." for Central District of California
  - "N.D. Cal." for Northern District of California
  - "S.D.N.Y." for Southern District of New York
  - "W.D. Okla." for Western District of Oklahoma
  - "EOIR" for immigration court
  - "BIA" for Board of Immigration Appeals
  - "USCIS" for U.S. Citizenship and Immigration Services
  - Use similar abbreviations for other courts
- case_type: Pick ONE of these short-form values based on docket text:
  - "PFR" for Petition for Review (9th Cir. immigration appeals)
  - "Habeas" for 28 U.S.C. § 2241 habeas corpus
  - "Mandamus" for 28 U.S.C. § 1361 mandamus
  - "N400" for 8 U.S.C. § 1447(b) naturalization delay
  - "APA" for Administrative Procedure Act actions
  - "Removal" for EOIR removal proceedings
  - "USCIS" for affirmative USCIS applications
  - "Other" if none fit
- opened_date: Date the case/filing was opened, in YYYY-MM-DD. Use the "filed on" or "entered" date if present.
- triggering_date: The underlying event that triggered the case (e.g., BIA decision date for a PFR, agency denial date for an APA action, NTA date for removal). Leave null unless explicit.
- custody_location: If the petitioner is detained, the facility name (e.g., "Cimarron Facility, Cushing OK"). Leave null if not mentioned or if petitioner is not detained.
- relief_sought: Brief description (e.g., "Asylum / W/H / CAT", "Release from custody", "Adjudication of N-400"). Leave null if unclear.
- notes: A 1-2 sentence summary of what the document indicates about the case posture (e.g., "PFR filed 5/4/2026 challenging BIA dismissal. Petitioner detained at Cimarron.").

Return ONLY valid JSON with this exact shape, no other text:
{
  "fields": {
    "client_name": "..." or null,
    "petitioner_name": "..." or null,
    "matter_ref": "..." or null,
    "court": "..." or null,
    "case_type": "..." or null,
    "opened_date": "YYYY-MM-DD" or null,
    "triggering_date": "YYYY-MM-DD" or null,
    "custody_location": "..." or null,
    "relief_sought": "..." or null,
    "notes": "..." or null
  },
  "confidence": "high" | "medium" | "low"
}

DOCUMENT TO ANALYZE:
---
{NEF_TEXT}
---`;

router.post("/api/parse-intake", requireAuth, async (req, res) => {
  try {
    const { nef_text } = req.body || {};

    if (!nef_text || typeof nef_text !== "string") {
      return res.status(400).json({ error: "nef_text required" });
    }
    if (nef_text.length < 20) {
      return res.status(400).json({ error: "Text too short to analyze" });
    }
    if (nef_text.length > 50000) {
      return res.status(400).json({ error: "Text too long (max 50k chars). Paste relevant section." });
    }

    const prompt = INTAKE_PROMPT.replace("{NEF_TEXT}", nef_text);
    const responseText = await callClaudeAPI(prompt, 2000);

    let parsed;
    try {
      let cleaned = responseText.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("Intake parser JSON error. Raw:", responseText);
      return res.status(500).json({
        error: "Could not parse extraction.",
        raw: responseText.substring(0, 500)
      });
    }

    const f = parsed.fields || {};

    // Validate and sanitize each field
    const validated = {
      client_name:      f.client_name ? String(f.client_name).substring(0, 200) : null,
      petitioner_name:  f.petitioner_name ? String(f.petitioner_name).substring(0, 200) : null,
      matter_ref:       f.matter_ref ? String(f.matter_ref).substring(0, 100) : null,
      court:            f.court ? String(f.court).substring(0, 100) : null,
      case_type:        f.case_type ? String(f.case_type).substring(0, 50) : null,
      opened_date:      f.opened_date && /^\d{4}-\d{2}-\d{2}$/.test(f.opened_date) ? f.opened_date : null,
      triggering_date:  f.triggering_date && /^\d{4}-\d{2}-\d{2}$/.test(f.triggering_date) ? f.triggering_date : null,
      custody_location: f.custody_location ? String(f.custody_location).substring(0, 300) : null,
      relief_sought:    f.relief_sought ? String(f.relief_sought).substring(0, 300) : null,
      notes:            f.notes ? String(f.notes).substring(0, 2000) : null
    };

    const confidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low";

    res.json({ fields: validated, confidence });
  } catch (err) {
    console.error("POST /api/parse-intake error:", err.message);
    res.status(500).json({ error: err.message || "Parser error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  INGEST DRY-RUN — Phase 0 validation for auto-NEF pipeline
//
//  POST /admin/matters/api/ingest-dry-run
//  Body: { email_text: "..." }
//  Returns: {
//    case_numbers_found: [...],
//    matter_match: { id, client_name, matter_ref } | null,
//    proposed_deadlines: [...],
//    proposed_fields: {...},
//    raw_match_attempts: [...]
//  }
//
//  PURE READ — never writes to the database. The point is to
//  validate (a) we can extract case numbers from real CM/ECF
//  emails and (b) we can match them to existing matters in
//  the user's account.
// ─────────────────────────────────────────────────────────────

// Normalize a case number for fuzzy matching:
// "5:26-cv-02340" -> "526cv02340"
// "23-1234"       -> "231234"
// "A 216-866-000" -> "a216866000"
function normalizeCaseRef(s) {
  return String(s || "").toLowerCase().replace(/[\s\-:\.\/]/g, "");
}

// Extract candidate case numbers from CM/ECF email text.
// Returns array of distinct candidates (max 8) in order of appearance.
// Patterns covered:
//  - District: 5:26-cv-02340, 2:23-cr-00100, etc.
//  - Circuit:  23-1234, 26-12345
//  - A-number: A 216-866-000, A216-866-000
//  - BIA:      File: A 216 866 000
function extractCaseNumbers(text) {
  const seen = new Set();
  const out = [];
  const push = (s) => {
    const norm = normalizeCaseRef(s);
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(s.trim()); }
  };
  // District court: D:YY-{cv,cr,mj,mc,ml}-NNNNN (with optional spaces)
  const districtRe = /\b\d{1,2}\s*:\s*\d{2}\s*-\s*(?:cv|cr|mj|mc|ml|bk)\s*-\s*\d{4,6}\b/gi;
  // Circuit: YY-NNNN or YY-NNNNN
  const circuitRe = /(?:^|\s|No\.\s*|Case\s*Number:\s*|Case\s*No\.\s*)(\d{2}-\d{4,5})(?=\b)/gi;
  // A-number: A followed by 8-9 digits with optional spaces/dashes
  const aNumRe = /A[\s\-]*\d{3}[\s\-]*\d{3}[\s\-]*\d{3}\b/gi;

  let m;
  while ((m = districtRe.exec(text)) !== null) push(m[0]);
  while ((m = circuitRe.exec(text)) !== null) push(m[1]);
  while ((m = aNumRe.exec(text)) !== null) push(m[0]);

  return out.slice(0, 8);
}

router.post("/api/ingest-dry-run", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const { email_text } = req.body || {};
    if (!email_text || typeof email_text !== "string") {
      return res.status(400).json({ error: "email_text required" });
    }
    if (email_text.length < 20) {
      return res.status(400).json({ error: "Text too short to analyze" });
    }
    if (email_text.length > 100000) {
      return res.status(400).json({ error: "Text too long (max 100k chars)" });
    }

    // 1. Extract candidate case numbers
    const candidates = extractCaseNumbers(email_text);

    // 2. Try to match against existing matters
    let matterMatch = null;
    const matchAttempts = [];

    if (candidates.length > 0) {
      const allMatters = await db.query(
        `SELECT id, client_name, matter_ref, court, case_type
           FROM matters
          WHERE user_id = $1
          ORDER BY id ASC`,
        [userId]
      );

      for (const cand of candidates) {
        const candNorm = normalizeCaseRef(cand);
        for (const m of allMatters.rows) {
          const refNorm = normalizeCaseRef(m.matter_ref || "");
          if (!refNorm) continue;
          // Match if either contains the other (handles "5:26-cv-02340" vs "26-2340")
          if (candNorm === refNorm || candNorm.includes(refNorm) || refNorm.includes(candNorm)) {
            matchAttempts.push({ candidate: cand, matched_matter_id: m.id, matched_ref: m.matter_ref, strategy: "normalized contains" });
            if (!matterMatch) {
              matterMatch = {
                id: m.id,
                client_name: m.client_name,
                matter_ref: m.matter_ref,
                court: m.court,
                case_type: m.case_type
              };
            }
          }
        }
      }
    }

    // 3. Run both parsers in parallel (proposals only — no writes)
    const [intakeResult, orderResult] = await Promise.allSettled([
      (async () => {
        const prompt = INTAKE_PROMPT.replace("{NEF_TEXT}", email_text);
        const text = await callClaudeAPI(prompt, 2000);
        let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        return JSON.parse(cleaned);
      })(),
      (async () => {
        const responseText = await callClaudeForExtraction(email_text);
        let cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        return JSON.parse(cleaned);
      })()
    ]);

    const proposedFields = intakeResult.status === "fulfilled" ? (intakeResult.value.fields || {}) : null;
    const intakeConfidence = intakeResult.status === "fulfilled" ? intakeResult.value.confidence : null;
    const intakeError = intakeResult.status === "rejected" ? intakeResult.reason.message : null;

    const proposedDeadlines = orderResult.status === "fulfilled" && Array.isArray(orderResult.value.deadlines)
      ? orderResult.value.deadlines
      : [];
    const orderError = orderResult.status === "rejected" ? orderResult.reason.message : null;

    res.json({
      // === Phase 0 validation report ===
      summary: {
        case_numbers_found: candidates.length,
        matter_matched: matterMatch ? true : false,
        proposed_deadline_count: proposedDeadlines.length,
        proposed_field_count: proposedFields ? Object.values(proposedFields).filter(v => v != null && v !== "").length : 0,
        intake_confidence: intakeConfidence
      },
      case_numbers_found: candidates,
      matter_match: matterMatch,
      match_attempts: matchAttempts,
      proposed_deadlines: proposedDeadlines,
      proposed_fields: proposedFields,
      errors: {
        intake_parser: intakeError,
        order_parser: orderError
      },
      // What WOULD happen if this were live (not a dry run):
      would_do: matterMatch
        ? `Attach ${proposedDeadlines.length} proposed deadline(s) to matter #${matterMatch.id} (${matterMatch.client_name}) for review`
        : (proposedFields && proposedFields.matter_ref)
          ? `No matter match — would queue ${proposedDeadlines.length} deadline(s) + matter draft for "${proposedFields.client_name || 'unknown'}" pending your confirmation`
          : `No matter match and no extractable case number — would queue email body in inbox for manual review`
    });
  } catch (err) {
    console.error("POST /api/ingest-dry-run error:", err.message);
    res.status(500).json({ error: err.message || "Dry-run error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  INGEST — Phase 2: actually save proposals to the inbox
//
//  POST /admin/matters/api/ingest
//  Body: { email_text: "...", source?: "manual_paste"|"email_inbound"|"api", source_ref?: "..." }
//  Returns: { proposals: [...], matter_match, summary }
//
//  Does the same matching + parsing as dry-run, but writes any
//  resulting proposals to the matter_proposals table for review.
//
//  Still PROPOSE-ONLY for deadlines: nothing is added to
//  matter_deadlines. The proposal sits in 'pending' state until
//  PATCH /api/proposals/:id with action='accept' is called.
// ─────────────────────────────────────────────────────────────
router.post("/api/ingest", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const { email_text, source, source_ref } = req.body || {};
    if (!email_text || typeof email_text !== "string") {
      return res.status(400).json({ error: "email_text required" });
    }
    if (email_text.length < 20) {
      return res.status(400).json({ error: "Text too short to analyze" });
    }
    if (email_text.length > 100000) {
      return res.status(400).json({ error: "Text too long (max 100k chars)" });
    }

    const sourceVal = ["manual_paste", "email_inbound", "api"].includes(source) ? source : "manual_paste";
    const sourceRefVal = source_ref ? String(source_ref).substring(0, 200) : null;

    // 1. Extract case numbers and find matter match
    const candidates = extractCaseNumbers(email_text);
    let matterMatch = null;

    if (candidates.length > 0) {
      const allMatters = await db.query(
        `SELECT id, client_name, matter_ref, court, case_type
           FROM matters WHERE user_id = $1 ORDER BY id ASC`,
        [userId]
      );
      for (const cand of candidates) {
        const candNorm = normalizeCaseRef(cand);
        for (const m of allMatters.rows) {
          const refNorm = normalizeCaseRef(m.matter_ref || "");
          if (!refNorm) continue;
          if (candNorm === refNorm || candNorm.includes(refNorm) || refNorm.includes(candNorm)) {
            if (!matterMatch) {
              matterMatch = { id: m.id, client_name: m.client_name, matter_ref: m.matter_ref };
            }
          }
        }
      }
    }

    // 2. Run both parsers in parallel
    const [intakeResult, orderResult] = await Promise.allSettled([
      (async () => {
        const prompt = INTAKE_PROMPT.replace("{NEF_TEXT}", email_text);
        const text = await callClaudeAPI(prompt, 2000);
        let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        return JSON.parse(cleaned);
      })(),
      (async () => {
        const responseText = await callClaudeForExtraction(email_text);
        let cleaned = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        return JSON.parse(cleaned);
      })()
    ]);

    const intakeFields = intakeResult.status === "fulfilled" ? (intakeResult.value.fields || {}) : null;
    const intakeConfidence = intakeResult.status === "fulfilled" ? intakeResult.value.confidence : null;
    const deadlines = orderResult.status === "fulfilled" && Array.isArray(orderResult.value.deadlines)
      ? orderResult.value.deadlines : [];

    // 3. Write proposals to the inbox table
    const excerpt = email_text.substring(0, 4000); // store first 4k chars for context
    const created = [];

    // 3a. Deadline proposals (one per extracted deadline that has a date)
    for (const d of deadlines) {
      if (!d.due_date) continue; // skip dateless proposals
      const ins = await db.query(
        `INSERT INTO matter_proposals
           (user_id, matter_id, kind, source, source_ref,
            proposed_data, raw_excerpt, status, confidence)
         VALUES ($1, $2, 'deadline', $3, $4, $5, $6, 'pending', $7)
         RETURNING id, kind, matter_id, proposed_data, confidence, created_at`,
        [
          userId,
          matterMatch ? matterMatch.id : null,
          sourceVal,
          sourceRefVal,
          JSON.stringify({
            title: d.title,
            due_date: d.due_date,
            party: d.party || "us",
            citation: d.citation || null,
            source_excerpt: d.source_excerpt || null
          }),
          d.source_excerpt ? String(d.source_excerpt).substring(0, 2000) : excerpt.substring(0, 2000),
          d.confidence || "low"
        ]
      );
      created.push(ins.rows[0]);
    }

    // 3b. New-matter proposal (only if NO matter matched AND intake parser found enough info)
    if (!matterMatch && intakeFields && (intakeFields.client_name || intakeFields.matter_ref)) {
      const ins = await db.query(
        `INSERT INTO matter_proposals
           (user_id, matter_id, kind, source, source_ref,
            proposed_data, raw_excerpt, status, confidence)
         VALUES ($1, NULL, 'new_matter', $2, $3, $4, $5, 'pending', $6)
         RETURNING id, kind, matter_id, proposed_data, confidence, created_at`,
        [
          userId,
          sourceVal,
          sourceRefVal,
          JSON.stringify(intakeFields),
          excerpt,
          intakeConfidence || "low"
        ]
      );
      created.push(ins.rows[0]);
    }

    // 3c. Field-update proposal (matter matched + intake parser has useful field updates)
    if (matterMatch && intakeFields) {
      // Only propose fields that have a non-null value
      const meaningfulFields = Object.fromEntries(
        Object.entries(intakeFields).filter(([k, v]) => v != null && v !== "")
      );
      if (Object.keys(meaningfulFields).length > 0) {
        const ins = await db.query(
          `INSERT INTO matter_proposals
             (user_id, matter_id, kind, source, source_ref,
              proposed_data, raw_excerpt, status, confidence)
           VALUES ($1, $2, 'field_update', $3, $4, $5, $6, 'pending', $7)
           RETURNING id, kind, matter_id, proposed_data, confidence, created_at`,
          [
            userId,
            matterMatch.id,
            sourceVal,
            sourceRefVal,
            JSON.stringify(meaningfulFields),
            excerpt,
            intakeConfidence || "low"
          ]
        );
        created.push(ins.rows[0]);
      }
    }

    res.json({
      summary: {
        case_numbers_found: candidates,
        matter_matched: matterMatch ? matterMatch.id : null,
        proposals_created: created.length,
        deadline_proposals: created.filter(c => c.kind === "deadline").length,
        new_matter_proposals: created.filter(c => c.kind === "new_matter").length,
        field_update_proposals: created.filter(c => c.kind === "field_update").length
      },
      matter_match: matterMatch,
      proposals: created
    });
  } catch (err) {
    console.error("POST /api/ingest error:", err.message);
    res.status(500).json({ error: err.message || "Ingest error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/proposals — list pending proposals (the inbox)
//  Query: ?status=pending|accepted|dismissed|all  (default: pending)
//         ?matter_id=N  (optional filter)
// ─────────────────────────────────────────────────────────────
router.get("/api/proposals", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const statusFilter = req.query.status || "pending";
    if (!["pending", "accepted", "dismissed", "all"].includes(statusFilter)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }
    const matterFilter = req.query.matter_id ? parseInt(req.query.matter_id) : null;
    if (req.query.matter_id && isNaN(matterFilter)) {
      return res.status(400).json({ error: "Invalid matter_id" });
    }

    const conditions = ["p.user_id = $1"];
    const params = [userId];
    let i = 2;
    if (statusFilter !== "all") {
      conditions.push(`p.status = $${i++}`);
      params.push(statusFilter);
    }
    if (matterFilter !== null) {
      conditions.push(`p.matter_id = $${i++}`);
      params.push(matterFilter);
    }

    const r = await db.query(
      `SELECT p.id, p.matter_id, p.kind, p.source, p.source_ref,
              p.proposed_data, p.raw_excerpt, p.status, p.confidence,
              p.created_at, p.resolved_at,
              m.client_name AS matter_client_name,
              m.matter_ref  AS matter_ref
         FROM matter_proposals p
         LEFT JOIN matters m ON m.id = p.matter_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY p.created_at DESC
         LIMIT 200`,
      params
    );

    res.json({ proposals: r.rows });
  } catch (err) {
    console.error("GET /api/proposals error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  PATCH /api/proposals/:id — accept or dismiss a proposal
//  Body: { action: 'accept' | 'dismiss', matter_id?: N (for unmatched proposals) }
//
//  On 'accept':
//    - kind='deadline': creates a row in matter_deadlines
//    - kind='new_matter': creates a row in matters
//    - kind='field_update': applies fields to the matter row
//  Then marks the proposal as 'accepted'.
//
//  On 'dismiss': just marks as 'dismissed'. No data written.
// ─────────────────────────────────────────────────────────────
router.patch("/api/proposals/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const propId = parseInt(req.params.id);
    if (isNaN(propId)) return res.status(400).json({ error: "Invalid id" });

    const { action, matter_id: matterIdOverride } = req.body || {};
    if (!["accept", "dismiss"].includes(action)) {
      return res.status(400).json({ error: "action must be 'accept' or 'dismiss'" });
    }

    // Load the proposal (verify ownership)
    const pr = await db.query(
      `SELECT * FROM matter_proposals WHERE id = $1 AND user_id = $2`,
      [propId, userId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: "Proposal not found" });
    const prop = pr.rows[0];

    if (prop.status !== "pending") {
      return res.status(409).json({ error: `Proposal already ${prop.status}` });
    }

    // DISMISS path — easy
    if (action === "dismiss") {
      await db.query(
        `UPDATE matter_proposals SET status='dismissed', resolved_at=NOW() WHERE id=$1`,
        [propId]
      );
      return res.json({ ok: true, action: "dismissed", id: propId });
    }

    // ACCEPT path — depends on kind
    const data = typeof prop.proposed_data === "string"
      ? JSON.parse(prop.proposed_data)
      : prop.proposed_data;
    const effectiveMatterId = matterIdOverride
      ? parseInt(matterIdOverride)
      : prop.matter_id;

    if (prop.kind === "deadline") {
      if (!effectiveMatterId) {
        return res.status(400).json({ error: "Deadline proposal has no matter_id — pass matter_id in body" });
      }
      // Verify the target matter is ours
      const mc = await db.query(
        `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
        [effectiveMatterId, userId]
      );
      if (!mc.rows.length) return res.status(404).json({ error: "Target matter not found" });

      const ins = await db.query(
        `INSERT INTO matter_deadlines (matter_id, title, citation, due_date, party, note, completed)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         RETURNING id, title, due_date`,
        [
          effectiveMatterId,
          String(data.title || "Untitled").substring(0, 300),
          data.citation ? String(data.citation).substring(0, 200) : null,
          data.due_date,
          ["us", "them", "court"].includes(data.party) ? data.party : "us",
          data.source_excerpt ? String(data.source_excerpt).substring(0, 1000) : null
        ]
      );
      await db.query(
        `UPDATE matter_proposals SET status='accepted', resolved_at=NOW(), matter_id=$2 WHERE id=$1`,
        [propId, effectiveMatterId]
      );
      return res.json({ ok: true, action: "accepted", kind: "deadline", deadline: ins.rows[0] });
    }

    if (prop.kind === "new_matter") {
      // Build matter payload from intake fields
      const finalStatus = "active";
      const ins = await db.query(
        `INSERT INTO matters
           (user_id, client_name, matter_ref, court, case_type, status,
            opened_date, triggering_date, custody_location,
            petitioner_name, relief_sought, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, client_name, matter_ref`,
        [
          userId,
          (data.client_name || data.petitioner_name || "Unknown").substring(0, 200),
          data.matter_ref ? String(data.matter_ref).substring(0, 100) : null,
          data.court ? String(data.court).substring(0, 100) : null,
          data.case_type ? String(data.case_type).substring(0, 50) : null,
          finalStatus,
          data.opened_date && /^\d{4}-\d{2}-\d{2}$/.test(data.opened_date) ? data.opened_date : null,
          data.triggering_date && /^\d{4}-\d{2}-\d{2}$/.test(data.triggering_date) ? data.triggering_date : null,
          data.custody_location ? String(data.custody_location).substring(0, 300) : null,
          data.petitioner_name ? String(data.petitioner_name).substring(0, 200) : null,
          data.relief_sought ? String(data.relief_sought).substring(0, 300) : null,
          data.notes ? String(data.notes).substring(0, 2000) : null
        ]
      );
      const newMatterId = ins.rows[0].id;
      await db.query(
        `UPDATE matter_proposals SET status='accepted', resolved_at=NOW(), matter_id=$2 WHERE id=$1`,
        [propId, newMatterId]
      );
      // Also attach any pending unmatched deadline proposals to this new matter
      await db.query(
        `UPDATE matter_proposals
            SET matter_id = $1
          WHERE user_id = $2 AND matter_id IS NULL AND kind = 'deadline' AND status = 'pending'
            AND proposed_data->>'matter_ref' = $3`,
        [newMatterId, userId, ins.rows[0].matter_ref || ""]
      );
      return res.json({ ok: true, action: "accepted", kind: "new_matter", matter: ins.rows[0] });
    }

    if (prop.kind === "field_update") {
      if (!effectiveMatterId) {
        return res.status(400).json({ error: "field_update proposal has no matter_id" });
      }
      // Apply each field as an update on the matter
      const allowed = ["matter_ref", "court", "case_type", "petitioner_name",
                       "opened_date", "triggering_date", "custody_location", "relief_sought"];
      const sets = [];
      const params = [effectiveMatterId, userId];
      let i = 3;
      for (const k of allowed) {
        if (data[k] != null && data[k] !== "") {
          sets.push(`${k} = $${i++}`);
          params.push(data[k]);
        }
      }
      if (sets.length === 0) {
        await db.query(
          `UPDATE matter_proposals SET status='dismissed', resolved_at=NOW() WHERE id=$1`,
          [propId]
        );
        return res.json({ ok: true, action: "dismissed", reason: "no fields to apply" });
      }
      const upd = await db.query(
        `UPDATE matters SET ${sets.join(", ")}
          WHERE id = $1 AND user_id = $2
          RETURNING id, client_name, matter_ref`,
        params
      );
      if (!upd.rows.length) return res.status(404).json({ error: "Target matter not found" });
      await db.query(
        `UPDATE matter_proposals SET status='accepted', resolved_at=NOW() WHERE id=$1`,
        [propId]
      );
      return res.json({ ok: true, action: "accepted", kind: "field_update", matter: upd.rows[0], applied_fields: Object.keys(data).filter(k => allowed.includes(k)) });
    }

    return res.status(500).json({ error: "Unknown proposal kind: " + prop.kind });
  } catch (err) {
    console.error("PATCH /api/proposals error:", err.message);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/proposals/count — quick badge count for UI
//  Returns: { pending: N, by_matter: { matter_id: count, ... } }
// ─────────────────────────────────────────────────────────────
router.get("/api/proposals/count", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const tot = await db.query(
      `SELECT COUNT(*)::int AS n FROM matter_proposals WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    const byMatter = await db.query(
      `SELECT matter_id, COUNT(*)::int AS n
         FROM matter_proposals
        WHERE user_id = $1 AND status = 'pending'
        GROUP BY matter_id`,
      [userId]
    );

    const byMatterMap = {};
    for (const row of byMatter.rows) {
      byMatterMap[row.matter_id ?? "unmatched"] = row.n;
    }

    res.json({
      pending: tot.rows[0].n,
      by_matter: byMatterMap
    });
  } catch (err) {
    console.error("GET /api/proposals/count error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Helper: get the current user id (single-user system) ──
// For now, every authenticated admin session is JJ Zhang (user id 1).
// When multi-user is added later, derive this from the session token.
async function getCurrentUserId(req) {
  try {
    const r = await db.query(
      `SELECT id FROM users WHERE username = 'jj' LIMIT 1`
    );
    return r.rows[0]?.id || null;
  } catch (err) {
    console.error("getCurrentUserId error:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  MATTERS — list, create, read, update, archive, delete
// ─────────────────────────────────────────────────────────────

// GET /admin/matters/api/matters?status=active
// List matters for the current user.
router.get("/api/matters", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const status = req.query.status || "active";
    if (!["active", "closed", "archived", "all"].includes(status)) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    const whereClause = status === "all"
      ? "WHERE m.user_id = $1"
      : "WHERE m.user_id = $1 AND m.status = $2";
    const params = status === "all" ? [userId] : [userId, status];

    const r = await db.query(
      `SELECT m.id, m.client_name, m.matter_ref, m.court, m.case_type, m.status,
              m.dropbox_url, m.notes, m.created_at, m.updated_at,
              m.opened_date, m.triggering_date, m.custody_location,
              m.petitioner_name, m.relief_sought,
              COALESCE(cl.checklist_total, 0)     AS checklist_total,
              COALESCE(cl.checklist_completed, 0) AS checklist_completed
       FROM matters m
       LEFT JOIN (
         SELECT c.matter_id,
                COUNT(i.id)::int                                      AS checklist_total,
                COUNT(i.id) FILTER (WHERE i.completed = TRUE)::int    AS checklist_completed
         FROM matter_checklists c
         LEFT JOIN matter_checklist_items i ON i.checklist_id = c.id
         GROUP BY c.matter_id
       ) cl ON cl.matter_id = m.id
       ${whereClause}
       ORDER BY m.updated_at DESC`,
      params
    );

    // Attach the count of upcoming uncompleted deadlines per matter
    const matters = await Promise.all(r.rows.map(async (m) => {
      const dr = await db.query(
        `SELECT COUNT(*) AS upcoming,
                MIN(due_date) AS next_due
         FROM matter_deadlines
         WHERE matter_id = $1 AND completed = FALSE`,
        [m.id]
      );
      return {
        ...m,
        upcoming_deadlines: parseInt(dr.rows[0].upcoming) || 0,
        next_due: dr.rows[0].next_due
      };
    }));

    res.json({ matters });
  } catch (err) {
    console.error("GET /api/matters error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /admin/matters/api/matters/:id
// Get full matter detail including deadlines, notes, files.
router.get("/api/matters/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.id);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid id" });

    const mr = await db.query(
      `SELECT * FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Not found" });

    const dr = await db.query(
      `SELECT id, title, citation, due_date, party, note, completed,
              created_at, updated_at
       FROM matter_deadlines
       WHERE matter_id = $1
       ORDER BY due_date ASC`,
      [matterId]
    );

    const nr = await db.query(
      `SELECT id, content, created_at, updated_at
       FROM matter_notes
       WHERE matter_id = $1
       ORDER BY created_at DESC`,
      [matterId]
    );

    const fr = await db.query(
      `SELECT id, filename, url, created_at
       FROM matter_files
       WHERE matter_id = $1
       ORDER BY created_at DESC`,
      [matterId]
    );

    // Checklists with nested items, aggregated in a single query
    // via json_agg. Items ordered by display_order then id.
    const cr = await db.query(
      `SELECT
         c.id, c.title, c.subtitle, c.display_order,
         c.created_at, c.updated_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id',            i.id,
               'text',          i.text,
               'citation',      i.citation,
               'completed',     i.completed,
               'display_order', i.display_order
             ) ORDER BY i.display_order, i.id
           ) FILTER (WHERE i.id IS NOT NULL),
           '[]'::json
         ) AS items
       FROM matter_checklists c
       LEFT JOIN matter_checklist_items i ON i.checklist_id = c.id
       WHERE c.matter_id = $1
       GROUP BY c.id
       ORDER BY c.display_order, c.id`,
      [matterId]
    );

    res.json({
      matter: mr.rows[0],
      deadlines: dr.rows,
      notes: nr.rows,
      files: fr.rows,
      checklists: cr.rows
    });
  } catch (err) {
    console.error("GET /api/matters/:id error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /admin/matters/api/matters
// Create a new matter.
router.post("/api/matters", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    if (!userId) return res.status(500).json({ error: "User not found" });

    const {
      client_name, matter_ref, court, case_type,
      status, dropbox_url, notes,
      opened_date, triggering_date, custody_location,
      petitioner_name, relief_sought
    } = req.body || {};

    if (!client_name || typeof client_name !== "string") {
      return res.status(400).json({ error: "client_name required" });
    }

    const finalStatus = status || "active";
    if (!["active", "closed", "archived"].includes(finalStatus)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    // Normalize date inputs: empty string → null. Postgres rejects "".
    // Validate ISO YYYY-MM-DD if provided (allow Postgres to do final check).
    const normDate = (v) => {
      if (v === undefined || v === null || v === "") return null;
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new Error("Invalid date format (expected YYYY-MM-DD)");
      }
      return v;
    };

    let openedDateVal, triggeringDateVal;
    try {
      openedDateVal = normDate(opened_date);
      triggeringDateVal = normDate(triggering_date);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const r = await db.query(
      `INSERT INTO matters
         (user_id, client_name, matter_ref, court, case_type, status, dropbox_url, notes,
          opened_date, triggering_date, custody_location, petitioner_name, relief_sought)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [userId, client_name, matter_ref || null, court || null, case_type || null,
       finalStatus, dropbox_url || null, notes || null,
       openedDateVal, triggeringDateVal,
       custody_location || null, petitioner_name || null, relief_sought || null]
    );

    res.json({ matter: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") { // unique violation
      return res.status(409).json({ error: "Matter with that case number already exists" });
    }
    console.error("POST /api/matters error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /admin/matters/api/matters/:id
// Update matter fields.
router.patch("/api/matters/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.id);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid id" });

    const allowed = ["client_name", "matter_ref", "court", "case_type",
                     "status", "dropbox_url", "notes",
                     "opened_date", "triggering_date", "custody_location",
                     "petitioner_name", "relief_sought"];
    const dateFields = new Set(["opened_date", "triggering_date"]);
    const fields = [];
    const values = [matterId, userId];
    let i = 3;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        if (k === "status" && !["active", "closed", "archived"].includes(req.body[k])) {
          return res.status(400).json({ error: "Invalid status" });
        }
        let v = req.body[k];
        // Normalize date inputs: empty string → null
        if (dateFields.has(k)) {
          if (v === "" || v === undefined) {
            v = null;
          } else if (v !== null) {
            if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
              return res.status(400).json({ error: `Invalid date format for ${k} (expected YYYY-MM-DD)` });
            }
          }
        }
        fields.push(`${k} = $${i++}`);
        values.push(v);
      }
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    const r = await db.query(
      `UPDATE matters SET ${fields.join(", ")}
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      values
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ matter: r.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Matter with that case number already exists" });
    }
    console.error("PATCH /api/matters/:id error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/matters/api/matters/:id
// Hard delete. CASCADES to deadlines, notes, files.
// Use status='archived' for soft delete; this is for true removal.
router.delete("/api/matters/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.id);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid id" });

    const r = await db.query(
      `DELETE FROM matters WHERE id = $1 AND user_id = $2 RETURNING id`,
      [matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: matterId });
  } catch (err) {
    console.error("DELETE /api/matters/:id error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  DEADLINES — nested under matters
// ─────────────────────────────────────────────────────────────

// POST /admin/matters/api/matters/:matterId/deadlines
router.post("/api/matters/:matterId/deadlines", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    // Verify user owns this matter
    const mr = await db.query(
      `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Matter not found" });

    const { title, citation, due_date, party, note } = req.body || {};
    if (!title) return res.status(400).json({ error: "title required" });
    if (!due_date) return res.status(400).json({ error: "due_date required" });
    if (party && !["us", "them", "court"].includes(party)) {
      return res.status(400).json({ error: "Invalid party (must be us, them, or court)" });
    }

    const r = await db.query(
      `INSERT INTO matter_deadlines
         (matter_id, title, citation, due_date, party, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [matterId, title, citation || null, due_date, party || "us", note || null]
    );

    res.json({ deadline: r.rows[0] });
  } catch (err) {
    console.error("POST deadlines error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /admin/matters/api/matters/:matterId/deadlines/:id
router.patch("/api/matters/:matterId/deadlines/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const deadlineId = parseInt(req.params.id);
    if (isNaN(matterId) || isNaN(deadlineId)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    // Verify ownership chain: deadline -> matter -> user
    const own = await db.query(
      `SELECT md.id FROM matter_deadlines md
       JOIN matters m ON m.id = md.matter_id
       WHERE md.id = $1 AND md.matter_id = $2 AND m.user_id = $3`,
      [deadlineId, matterId, userId]
    );
    if (!own.rows.length) return res.status(404).json({ error: "Not found" });

    const allowed = ["title", "citation", "due_date", "party", "note", "completed"];
    const fields = [];
    const values = [deadlineId];
    let i = 2;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        if (k === "party" && !["us", "them", "court"].includes(req.body[k])) {
          return res.status(400).json({ error: "Invalid party" });
        }
        fields.push(`${k} = $${i++}`);
        values.push(req.body[k]);
      }
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    const r = await db.query(
      `UPDATE matter_deadlines SET ${fields.join(", ")}
       WHERE id = $1 RETURNING *`,
      values
    );
    res.json({ deadline: r.rows[0] });
  } catch (err) {
    console.error("PATCH deadlines error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /admin/matters/api/matters/:matterId/deadlines/:id
router.delete("/api/matters/:matterId/deadlines/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const deadlineId = parseInt(req.params.id);

    const r = await db.query(
      `DELETE FROM matter_deadlines md
       USING matters m
       WHERE md.id = $1 AND md.matter_id = $2 AND m.id = md.matter_id AND m.user_id = $3
       RETURNING md.id`,
      [deadlineId, matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: deadlineId });
  } catch (err) {
    console.error("DELETE deadlines error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  NOTES — nested under matters
// ─────────────────────────────────────────────────────────────

router.post("/api/matters/:matterId/notes", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const mr = await db.query(
      `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Matter not found" });

    const { content } = req.body || {};
    if (!content) return res.status(400).json({ error: "content required" });

    const r = await db.query(
      `INSERT INTO matter_notes (matter_id, content)
       VALUES ($1, $2) RETURNING *`,
      [matterId, content]
    );
    res.json({ note: r.rows[0] });
  } catch (err) {
    console.error("POST notes error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/api/matters/:matterId/notes/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const noteId = parseInt(req.params.id);

    const r = await db.query(
      `DELETE FROM matter_notes mn
       USING matters m
       WHERE mn.id = $1 AND mn.matter_id = $2 AND m.id = mn.matter_id AND m.user_id = $3
       RETURNING mn.id`,
      [noteId, matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: noteId });
  } catch (err) {
    console.error("DELETE notes error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  FILES — nested under matters
// ─────────────────────────────────────────────────────────────

router.post("/api/matters/:matterId/files", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const mr = await db.query(
      `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
      [matterId, userId]
    );
    if (!mr.rows.length) return res.status(404).json({ error: "Matter not found" });

    const { filename, url } = req.body || {};
    if (!filename || !url) {
      return res.status(400).json({ error: "filename and url required" });
    }

    const r = await db.query(
      `INSERT INTO matter_files (matter_id, filename, url)
       VALUES ($1, $2, $3) RETURNING *`,
      [matterId, filename, url]
    );
    res.json({ file: r.rows[0] });
  } catch (err) {
    console.error("POST files error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/api/matters/:matterId/files/:id", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    const fileId = parseInt(req.params.id);

    const r = await db.query(
      `DELETE FROM matter_files mf
       USING matters m
       WHERE mf.id = $1 AND mf.matter_id = $2 AND m.id = mf.matter_id AND m.user_id = $3
       RETURNING mf.id`,
      [fileId, matterId, userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    res.json({ deleted: true, id: fileId });
  } catch (err) {
    console.error("DELETE files error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  CHECKLISTS — per-matter task lists with templates
//
//  Endpoints:
//    POST   /api/matters/:matterId/checklists/template/:templateName
//             → seed a hardcoded template (pfr, habeas, mandamus)
//    POST   /api/matters/:matterId/checklists
//             → create empty checklist (ad-hoc)
//    POST   /api/checklists/:checklistId/items
//             → add an item to an existing checklist
//    PATCH  /api/checklist-items/:itemId
//             → toggle completed, edit text, or edit citation
//    DELETE /api/checklist-items/:itemId
//             → remove an item
//    DELETE /api/checklists/:checklistId
//             → remove an entire checklist (cascades to items)
//
//  All routes require auth and verify the matter belongs to the
//  current user (defense against IDOR / horizontal escalation).
// ─────────────────────────────────────────────────────────────

// ── Hardcoded checklist templates ────────────────────────────
// These are reference templates for common 9th Cir. / district
// court immigration matters. Items are inserted with display_order
// matching their array index.
const CHECKLIST_TEMPLATES = {
  pfr: [
    {
      title: "Initial Filing Packet",
      subtitle: "Cir. R. 15-4 · GO 6.4(c) · FRAP 15",
      items: [
        { text: "Form 3 Petition for Review prepared, signed, dated",                   citation: "Cir. R. 15-4" },
        { text: "Form 6 Representation Statement bound with PFR",                        citation: "Cir. R. 15-4" },
        { text: "BIA decision attached as exhibit",                                      citation: "" },
        { text: "Initial Motion to Stay drafted (separate PDF)",                         citation: "FRAP 18 · GO 6.4(c)(1)" },
        { text: "Filing fee $605 paid OR Form 4 (IFP) filed",                            citation: "28 U.S.C. § 1913" },
        { text: "Filed within 30 days of BIA decision",                                  citation: "Stone v. INS" },
        { text: "Certificate of Service on OIL and local DHS/ICE OCC",                   citation: "FRAP 25(d)" },
        { text: "ECF appearance entered, attorney registration current",                 citation: "Cir. R. 46-1" },
        { text: "Notice to ICE OGC for district of confinement (if detained)",           citation: "Best practice" },
        { text: "Docket assigned 9th Cir. case number recorded",                         citation: "" }
      ]
    },
    {
      title: "Opening Brief Workplan",
      subtitle: "FRAP 28 · 32 · Cir. R. 28-2.4(b) · 28-2.7",
      items: [
        { text: "CAR arrives — read cover-to-cover, mark indiscernibles",                 citation: "Cir. R. 17-1" },
        { text: "Frame issues; lock argument order",                                       citation: "" },
        { text: "Argument outline + record cites complete",                                citation: "" },
        { text: "Statement of Case + Statement of Facts drafted",                          citation: "FRAP 28(a)(6)(7)" },
        { text: "Summary of Argument + Argument Sections drafted",                         citation: "FRAP 28(a)(8)(9)" },
        { text: "Full draft assembled — word count under 14,000",                          citation: "FRAP 32(a)(7)" },
        { text: "Internal revision pass — verify all record cites",                        citation: "" },
        { text: "Polish — Table of Authorities · Table of Contents",                       citation: "FRAP 28(a)(2)(3)" },
        { text: "Addendum assembled: IJ + BIA decisions",                                  citation: "Cir. R. 28-2.7" },
        { text: "Certificates: compliance · service · related cases",                      citation: "FRAP 32(g) · Cir. R. 28-2.6" },
        { text: "File via CM/ECF on or before due date",                                   citation: "FRAP 31 · Cir. R. 31-2.1" }
      ]
    }
  ],

  habeas: [
    {
      title: "Habeas § 2241 Filing Packet",
      subtitle: "28 U.S.C. § 2241 · FRCP 81(a)(4)",
      items: [
        { text: "Petition drafted — name correct custodian as respondent",                 citation: "Rumsfeld v. Padilla" },
        { text: "Venue confirmed — district of confinement",                                citation: "28 U.S.C. § 2241(a)" },
        { text: "Statement of facts with detention timeline",                               citation: "" },
        { text: "Legal grounds: constitutional / statutory / treaty",                       citation: "" },
        { text: "Exhaustion addressed or excused",                                          citation: "" },
        { text: "Filing fee $5 paid OR IFP application filed",                              citation: "28 U.S.C. § 1914" },
        { text: "Service: USA · AG · custodian · ICE OGC",                                  citation: "FRCP 4(i)" },
        { text: "REAL ID jurisdictional bar reviewed",                                      citation: "8 U.S.C. § 1252(a)(5)" },
        { text: "OSC issued / answer deadline calendared",                                  citation: "28 U.S.C. § 2243" }
      ]
    }
  ],

  mandamus: [
    {
      title: "Mandamus § 1361 Filing Packet",
      subtitle: "28 U.S.C. § 1361 · FRCP 4(i)",
      items: [
        { text: "Complaint drafted with clear plaintiff/defendants",                         citation: "" },
        { text: "Three elements pleaded: clear right · clear duty · no other remedy",       citation: "Norton v. SUWA" },
        { text: "TRAC factors addressed (unreasonable delay)",                                citation: "TRAC v. FCC" },
        { text: "Venue: where defendants reside OR plaintiff resides",                       citation: "28 U.S.C. § 1391(e)" },
        { text: "Civil cover sheet + summons prepared",                                       citation: "Local Rule" },
        { text: "Filing fee $405 paid OR IFP filed",                                          citation: "28 U.S.C. § 1914" },
        { text: "Service on US Attorney · AG · agency",                                       citation: "FRCP 4(i)" },
        { text: "Summons issued by clerk",                                                    citation: "FRCP 4(b)" },
        { text: "60-day answer deadline calendared",                                          citation: "FRCP 12(a)(2)" },
        { text: "Status of underlying agency action documented",                              citation: "" }
      ]
    }
  ]
};

// ── Helper: verify matter ownership ──────────────────────────
// Returns the matter row if the current user owns it, else null.
// All checklist routes use this to prevent horizontal escalation.
async function verifyMatterOwnership(matterId, userId) {
  const r = await db.query(
    `SELECT id FROM matters WHERE id = $1 AND user_id = $2`,
    [matterId, userId]
  );
  return r.rows.length > 0;
}

// ── Helper: verify checklist ownership (via parent matter) ───
async function verifyChecklistOwnership(checklistId, userId) {
  const r = await db.query(
    `SELECT c.id FROM matter_checklists c
       JOIN matters m ON m.id = c.matter_id
      WHERE c.id = $1 AND m.user_id = $2`,
    [checklistId, userId]
  );
  return r.rows.length > 0;
}

// ── Helper: verify item ownership (via parent checklist → matter) ─
async function verifyItemOwnership(itemId, userId) {
  const r = await db.query(
    `SELECT i.id FROM matter_checklist_items i
       JOIN matter_checklists c ON c.id = i.checklist_id
       JOIN matters m ON m.id = c.matter_id
      WHERE i.id = $1 AND m.user_id = $2`,
    [itemId, userId]
  );
  return r.rows.length > 0;
}

// ─────────────────────────────────────────────────────────────
//  POST /admin/matters/api/matters/:matterId/checklists/template/:templateName
//
//  Seed a hardcoded template (pfr, habeas, mandamus). Each
//  template creates one or more checklists with their items.
//  Use this on matter creation to bootstrap a standard set.
//
//  Does NOT clear existing checklists — call it on a fresh matter
//  or be prepared for duplicates.
// ─────────────────────────────────────────────────────────────
router.post("/api/matters/:matterId/checklists/template/:templateName", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const templateName = String(req.params.templateName || "").toLowerCase();
    const template = CHECKLIST_TEMPLATES[templateName];
    if (!template) {
      return res.status(404).json({
        error: "Template not found",
        available: Object.keys(CHECKLIST_TEMPLATES)
      });
    }

    if (!(await verifyMatterOwnership(matterId, userId))) {
      return res.status(404).json({ error: "Matter not found" });
    }

    // Find highest existing display_order so new templates append
    const ordR = await db.query(
      `SELECT COALESCE(MAX(display_order), -1) AS max_order
         FROM matter_checklists WHERE matter_id = $1`,
      [matterId]
    );
    let nextChecklistOrder = parseInt(ordR.rows[0].max_order) + 1;

    const created = [];
    for (const checklistDef of template) {
      const cr = await db.query(
        `INSERT INTO matter_checklists (matter_id, title, subtitle, display_order)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, subtitle, display_order, created_at, updated_at`,
        [matterId, checklistDef.title, checklistDef.subtitle || null, nextChecklistOrder]
      );
      const checklist = cr.rows[0];
      nextChecklistOrder++;

      const itemRows = [];
      for (let idx = 0; idx < checklistDef.items.length; idx++) {
        const it = checklistDef.items[idx];
        const ir = await db.query(
          `INSERT INTO matter_checklist_items
             (checklist_id, text, citation, completed, display_order)
           VALUES ($1, $2, $3, FALSE, $4)
           RETURNING id, text, citation, completed, display_order`,
          [checklist.id, it.text, it.citation || null, idx]
        );
        itemRows.push(ir.rows[0]);
      }

      created.push({ ...checklist, items: itemRows });
    }

    res.json({ checklists: created, template: templateName });
  } catch (err) {
    console.error("POST checklists/template error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /admin/matters/api/matters/:matterId/checklists
//
//  Create a single empty checklist on a matter.
//  Body: { title (required), subtitle (optional) }
// ─────────────────────────────────────────────────────────────
router.post("/api/matters/:matterId/checklists", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const matterId = parseInt(req.params.matterId);
    if (isNaN(matterId)) return res.status(400).json({ error: "Invalid matter id" });

    const { title, subtitle } = req.body || {};
    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title required" });
    }

    if (!(await verifyMatterOwnership(matterId, userId))) {
      return res.status(404).json({ error: "Matter not found" });
    }

    const ordR = await db.query(
      `SELECT COALESCE(MAX(display_order), -1) AS max_order
         FROM matter_checklists WHERE matter_id = $1`,
      [matterId]
    );
    const nextOrder = parseInt(ordR.rows[0].max_order) + 1;

    const r = await db.query(
      `INSERT INTO matter_checklists (matter_id, title, subtitle, display_order)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, subtitle, display_order, created_at, updated_at`,
      [matterId, title, subtitle || null, nextOrder]
    );

    res.json({ checklist: { ...r.rows[0], items: [] } });
  } catch (err) {
    console.error("POST checklists error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE /admin/matters/api/checklists/:checklistId
//
//  Remove an entire checklist. Cascades to items.
// ─────────────────────────────────────────────────────────────
router.delete("/api/checklists/:checklistId", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const checklistId = parseInt(req.params.checklistId);
    if (isNaN(checklistId)) return res.status(400).json({ error: "Invalid checklist id" });

    if (!(await verifyChecklistOwnership(checklistId, userId))) {
      return res.status(404).json({ error: "Checklist not found" });
    }

    await db.query(`DELETE FROM matter_checklists WHERE id = $1`, [checklistId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE checklists error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /admin/matters/api/checklists/:checklistId/items
//
//  Add a single item to a checklist.
//  Body: { text (required), citation (optional) }
// ─────────────────────────────────────────────────────────────
router.post("/api/checklists/:checklistId/items", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const checklistId = parseInt(req.params.checklistId);
    if (isNaN(checklistId)) return res.status(400).json({ error: "Invalid checklist id" });

    const { text, citation } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text required" });
    }

    if (!(await verifyChecklistOwnership(checklistId, userId))) {
      return res.status(404).json({ error: "Checklist not found" });
    }

    const ordR = await db.query(
      `SELECT COALESCE(MAX(display_order), -1) AS max_order
         FROM matter_checklist_items WHERE checklist_id = $1`,
      [checklistId]
    );
    const nextOrder = parseInt(ordR.rows[0].max_order) + 1;

    const r = await db.query(
      `INSERT INTO matter_checklist_items
         (checklist_id, text, citation, completed, display_order)
       VALUES ($1, $2, $3, FALSE, $4)
       RETURNING id, text, citation, completed, display_order, created_at, updated_at`,
      [checklistId, text, citation || null, nextOrder]
    );

    res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("POST checklist items error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  PATCH /admin/matters/api/checklist-items/:itemId
//
//  Toggle completed status, or edit text/citation.
//  Body: any of { completed: bool, text: string, citation: string }
// ─────────────────────────────────────────────────────────────
router.patch("/api/checklist-items/:itemId", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const itemId = parseInt(req.params.itemId);
    if (isNaN(itemId)) return res.status(400).json({ error: "Invalid item id" });

    if (!(await verifyItemOwnership(itemId, userId))) {
      return res.status(404).json({ error: "Item not found" });
    }

    const allowed = ["completed", "text", "citation"];
    const fields = [];
    const values = [itemId];
    let i = 2;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        let v = req.body[k];
        if (k === "completed") {
          if (typeof v !== "boolean") {
            return res.status(400).json({ error: "completed must be boolean" });
          }
        } else if (k === "text") {
          if (typeof v !== "string" || !v.trim()) {
            return res.status(400).json({ error: "text must be non-empty string" });
          }
        }
        // citation: pass through; empty string allowed
        fields.push(`${k} = $${i++}`);
        values.push(v);
      }
    }
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });

    const r = await db.query(
      `UPDATE matter_checklist_items SET ${fields.join(", ")}
       WHERE id = $1
       RETURNING id, text, citation, completed, display_order, created_at, updated_at`,
      values
    );

    res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("PATCH checklist items error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
//  DELETE /admin/matters/api/checklist-items/:itemId
//
//  Remove a single item.
// ─────────────────────────────────────────────────────────────
router.delete("/api/checklist-items/:itemId", requireAuth, async (req, res) => {
  try {
    const userId = await getCurrentUserId(req);
    const itemId = parseInt(req.params.itemId);
    if (isNaN(itemId)) return res.status(400).json({ error: "Invalid item id" });

    if (!(await verifyItemOwnership(itemId, userId))) {
      return res.status(404).json({ error: "Item not found" });
    }

    await db.query(`DELETE FROM matter_checklist_items WHERE id = $1`, [itemId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE checklist items error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});


// ─────────────────────────────────────────────────────────────
//  CALENDAR FEED — top-level, no session auth, secret-protected
//
//  Mounted in server.js as GET /calendar/:secret.ics
//  Outlook/Google Calendar fetch this URL on a schedule (every
//  15min – 1hr depending on client) without cookies.
//  Authenticated by the per-user calendar_secret.
// ─────────────────────────────────────────────────────────────

// RFC 5545 date format (YYYYMMDD for all-day events)
function icsDate(date) {
  const d = new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// RFC 5545 timestamp format (DTSTAMP requires UTC ISO)
function icsTimestamp(date) {
  const d = new Date(date);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Escape special chars in calendar text fields per RFC 5545
function icsEscape(s) {
  if (!s) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "");
}

// Add days to a date string (YYYY-MM-DD), returning YYYYMMDD ICS format
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return icsDate(d);
}

// Handler — called from server.js
// GET /calendar/:secret.ics
async function handleCalendarFeed(req, res) {
  try {
    let secretParam = req.params.secret || "";
    // Strip trailing ".ics" if present (some clients add it; some don't)
    if (secretParam.endsWith(".ics")) {
      secretParam = secretParam.slice(0, -4);
    }

    // Must be 64-char hex per our schema
    if (!/^[a-f0-9]{64}$/.test(secretParam)) {
      return res.status(404).send("Not found");
    }

    // Look up the user by secret. Use a constant-time comparison even though
    // we're querying — the DB query itself is parameterized which prevents
    // injection; constant-time matters for the actual string compare.
    const r = await db.query(
      `SELECT id, username, display_name, calendar_secret
       FROM users
       WHERE calendar_secret = $1`,
      [secretParam]
    );

    if (!r.rows.length) return res.status(404).send("Not found");

    const user = r.rows[0];
    // Defense in depth: constant-time compare of the matched row
    const a = Buffer.from(user.calendar_secret);
    const b = Buffer.from(secretParam);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(404).send("Not found");
    }

    // Pull deadlines: non-archived matters, not-done, within next 365 days
    const dr = await db.query(
      `SELECT
         d.id           AS deadline_id,
         d.title        AS title,
         d.citation     AS citation,
         d.due_date     AS due_date,
         d.party        AS party,
         d.note         AS note,
         m.id           AS matter_id,
         m.client_name  AS client_name,
         m.matter_ref   AS matter_ref,
         m.court        AS court,
         m.case_type    AS case_type
       FROM matter_deadlines d
       JOIN matters m ON m.id = d.matter_id
       WHERE m.user_id = $1
         AND m.status != 'archived'
         AND d.completed = FALSE
         AND d.due_date >= CURRENT_DATE
         AND d.due_date <= CURRENT_DATE + INTERVAL '365 days'
       ORDER BY d.due_date ASC`,
      [user.id]
    );

    // Build the .ics body
    const now = icsTimestamp(new Date());
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Tez Law P.C.//Matter Manager//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:TEZ Matters — ${icsEscape(user.display_name || user.username)}`,
      "X-WR-TIMEZONE:America/Los_Angeles",
      "X-PUBLISHED-TTL:PT15M"
    ];

    for (const row of dr.rows) {
      const partyLabel = row.party === "them" ? "OPP" : row.party === "court" ? "CT" : "US";
      const summary = `[${partyLabel}] ${row.client_name} — ${row.title}`;
      const descParts = [];
      if (row.matter_ref) descParts.push(`Ref: ${row.matter_ref}`);
      if (row.court)      descParts.push(`Court: ${row.court}`);
      if (row.case_type)  descParts.push(`Type: ${row.case_type}`);
      if (row.citation)   descParts.push(`Citation: ${row.citation}`);
      if (row.note)       descParts.push("", row.note);
      const description = descParts.join("\n");
      const uid = `${row.matter_id}-${row.deadline_id}@tezlawfirm`;
      const dtstart = icsDate(row.due_date);
      const dtend   = addDays(row.due_date, 1); // all-day events, exclusive end

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART;VALUE=DATE:${dtstart}`);
      lines.push(`DTEND;VALUE=DATE:${dtend}`);
      lines.push(`SUMMARY:${icsEscape(summary)}`);
      if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
      lines.push("STATUS:CONFIRMED");
      lines.push("TRANSP:OPAQUE");

      // 7-day reminder
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${icsEscape(summary)} — 7 days`);
      lines.push("TRIGGER:-P7D");
      lines.push("END:VALARM");

      // 1-day reminder
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${icsEscape(summary)} — 1 day`);
      lines.push("TRIGGER:-P1D");
      lines.push("END:VALARM");

      lines.push("END:VEVENT");
    }

    lines.push("END:VCALENDAR");

    // RFC 5545 requires CRLF line endings
    const body = lines.join("\r\n") + "\r\n";

    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow"
    });
    res.send(body);
  } catch (err) {
    console.error("Calendar feed error:", err.message);
    res.status(500).send("Internal Server Error");
  }
}

module.exports = { router, handleCalendarFeed };
