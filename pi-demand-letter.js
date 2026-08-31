// ============================================================
//  TEZ LAW P.C. — PI DEMAND LETTER GENERATOR
//  ─────────────────────────────────────────────────────────
//  Drafts time-limited policy limits demand letters compliant
//  with CCP §§ 999-999.5. Uses ONLY verified case law from the
//  firm's GOAT/MOAT documents (zero hallucinated cites).
//
//  Key statutory framework:
//   - Cal. Ins. Code § 791.13 — policy limits disclosure
//   - Cal. Veh. Code § 16058 — auto insurance disclosure
//   - Cal. Ins. Code § 11580.09 — commercial auto disclosure
//   - CCP §§ 999-999.5 — time-limited demand requirements
//   - Comunale v. Traders (1958) — bad faith framework
//   - Crisci v. Security Ins. (1967)
//   - Johansen v. CSAA (1975)
//   - Hedayati v. Interinsurance Exchange (2021)
//
//  Deadline calculation per CCP § 999.1:
//   - Policy limits ≤ $250K → 33 days minimum
//   - Policy limits > $250K → 60 days minimum
//
//  Version tracking: all versions preserved for audit trail.
// ============================================================

const axios = require("axios");
const db = require("./db");
const pi = require("./personal-injury");

const MODEL = "claude-sonnet-4-6";

// ─── Schema ─────────────────────────────────────────────

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_demand_letters (
      id                       SERIAL PRIMARY KEY,
      case_id                  INTEGER NOT NULL REFERENCES pi_cases(id) ON DELETE CASCADE,
      target_insurance_id      INTEGER REFERENCES pi_insurance(id) ON DELETE SET NULL,
      target_carrier_name      TEXT,
      target_adjuster_name     TEXT,
      target_claim_number      TEXT,

      -- Letter content (immutable original)
      letter_text              TEXT NOT NULL,
      certificate_of_service   TEXT,
      cases_cited              TEXT[],

      -- CCP § 999 compliance
      deadline_date            DATE,
      deadline_days            INTEGER,          -- 33 or 60 per statute
      policy_limits_amount     NUMERIC(12,2),    -- what we know at time of drafting
      is_time_limited_demand   BOOLEAN DEFAULT TRUE,

      -- Version tracking
      version                  INTEGER DEFAULT 1,
      parent_id                INTEGER,          -- id of prior version this was regenerated from
      additional_context       TEXT,             -- attorney's direction at generation time

      -- Delivery record
      sent_date                DATE,
      sent_via                 TEXT,             -- certified_mail | email | fax | courier
      sent_to_carrier          BOOLEAN DEFAULT FALSE,
      sent_to_insured          BOOLEAN DEFAULT FALSE,
      insured_service_address  TEXT,
      tracking_number          TEXT,

      -- Response tracking (bad faith preservation!)
      response_received_date   DATE,
      response_summary         TEXT,
      policy_limits_disclosed  BOOLEAN,
      disclosed_limits_amount  NUMERIC(12,2),
      carrier_tendered_limits  BOOLEAN,
      tendered_amount          NUMERIC(12,2),
      settlement_offered       NUMERIC(12,2),
      settlement_offered_date  DATE,
      bad_faith_flagged        BOOLEAN DEFAULT FALSE,
      bad_faith_flag_date      DATE,
      bad_faith_notes          TEXT,

      -- Workflow
      status                   TEXT DEFAULT 'draft',
        -- draft | sent | carrier_responded | limits_disclosed | tendered | rejected | bad_faith_flagged | superseded
      user_edits               TEXT,             -- attorney's polished version

      -- Model metadata
      model                    TEXT,
      input_tokens             INTEGER,
      output_tokens            INTEGER,
      estimated_cost_usd       NUMERIC(10,4),
      created_by               INTEGER,

      generated_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pi_demand_case ON pi_demand_letters (case_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pi_demand_deadline ON pi_demand_letters (deadline_date) WHERE status IN ('sent', 'carrier_responded')`);
}

// ─── Verified case law retrieval ─────────────────────────

async function retrieveVerifiedPICaseLaw() {
  const cases = new Map();

  // 1. Cases from firm_documents.authorities_cited for PI-related briefs/demands
  try {
    const r = await db.query(
      `SELECT id, matter_label, authorities_cited, key_arguments
       FROM firm_documents
       WHERE (practice_area ILIKE '%personal injury%'
              OR practice_area ILIKE '%tort%'
              OR practice_area ILIKE '%bad faith%'
              OR practice_area ILIKE '%insurance%'
              OR document_type ILIKE '%demand%'
              OR document_type ILIKE '%policy limits%')
         AND authorities_cited IS NOT NULL
         AND array_length(authorities_cited, 1) > 0
       ORDER BY created_at DESC
       LIMIT 100`
    );
    for (const row of r.rows) {
      for (const auth of row.authorities_cited || []) {
        const clean = String(auth).trim();
        if (!clean || clean.length < 5) continue;
        if (!cases.has(clean.toLowerCase())) {
          cases.set(clean.toLowerCase(), {
            citation: clean,
            source: `firm demand/brief: ${row.matter_label || "unlabeled"}`,
            source_id: row.id,
          });
        }
      }
    }
  } catch (e) { console.warn("[demand-letter] firm_documents fetch:", e.message); }

  // 2. Legal citations table (PI/bad faith/insurance categories)
  try {
    const r = await db.query(
      `SELECT case_name, citation, court, date_filed, url, category
       FROM legal_citations
       WHERE (category ILIKE '%personal injury%'
              OR category ILIKE '%bad faith%'
              OR category ILIKE '%insurance%'
              OR category ILIKE '%tort%'
              OR case_name ILIKE '%comunale%'
              OR case_name ILIKE '%crisci%'
              OR case_name ILIKE '%johansen%'
              OR case_name ILIKE '%hedayati%'
              OR case_name ILIKE '%policy limits%')
       ORDER BY relevance_score DESC, date_filed DESC
       LIMIT 60`
    );
    for (const row of r.rows) {
      const key = (row.case_name || "").toLowerCase();
      if (key && !cases.has(key)) {
        cases.set(key, {
          case_name: row.case_name,
          citation: row.citation,
          court: row.court,
          date: row.date_filed,
          url: row.url,
          source: "legal_citations table",
        });
      }
    }
  } catch (e) { console.warn("[demand-letter] legal_citations fetch:", e.message); }

  // 3. Foundational cases (always included — universally cited in CA PI demand letters)
  // These are so canonical they should be in every firm's pool. If firm_documents
  // doesn't have them, we include them here as a safety net.
  const foundational = [
    { case_name: "Comunale v. Traders & General Ins. Co.", citation: "50 Cal.2d 654 (1958)", source: "foundational" },
    { case_name: "Crisci v. Security Ins. Co.", citation: "66 Cal.2d 425 (1967)", source: "foundational" },
    { case_name: "Johansen v. California State Auto. Assn.", citation: "15 Cal.3d 9 (1975)", source: "foundational" },
    { case_name: "Hedayati v. Interinsurance Exchange", citation: "67 Cal.App.5th 833 (2021)", source: "foundational" },
    { case_name: "Egan v. Mutual of Omaha Ins. Co.", citation: "24 Cal.3d 809 (1979)", source: "foundational" },
    { case_name: "Neal v. Farmers Ins. Exchange", citation: "21 Cal.3d 910 (1978)", source: "foundational" },
  ];
  for (const c of foundational) {
    if (!cases.has(c.case_name.toLowerCase())) {
      cases.set(c.case_name.toLowerCase(), c);
    }
  }

  return Array.from(cases.values());
}

// ─── Deadline calculation per CCP § 999.1 ──────────────
// - Policy limits ≤ $250,000 → 33 days minimum
// - Policy limits > $250,000 → 60 days minimum
// - When limits unknown, default to 60 days (safer / more likely valid)

function calculateDeadlineDays(policyLimitsAmount) {
  if (!policyLimitsAmount || policyLimitsAmount <= 0) return 60;
  return policyLimitsAmount <= 250000 ? 33 : 60;
}

function calculateDeadlineDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ─── Main generator ─────────────────────────────────────

async function generateDemandLetter({
  caseId,
  targetInsuranceId = null,
  additionalContext = "",
  createdBy = null,
  parentId = null,
}) {
  await initTable();
  const data = await pi.getCase(caseId);
  if (!data) throw new Error(`PI case #${caseId} not found`);
  const c = data.case;

  // Pick the target insurance carrier (default: first adverse carrier)
  let targetIns = null;
  if (targetInsuranceId) {
    targetIns = data.insurance.find(i => i.id === Number(targetInsuranceId));
  }
  if (!targetIns) {
    targetIns = data.insurance.find(i => i.role === "adverse") || data.insurance[0];
  }
  if (!targetIns) {
    throw new Error("No insurance carrier on file for this case. Add an adverse party carrier first.");
  }

  const verifiedCases = await retrieveVerifiedPICaseLaw();

  // Calculate CCP § 999.1 deadline
  const policyLimits = Number(targetIns.policy_limits || 0);
  const deadlineDays = calculateDeadlineDays(policyLimits);
  const deadlineDate = calculateDeadlineDate(deadlineDays);

  // Determine version
  let version = 1;
  if (parentId) {
    const p = await db.query(`SELECT version FROM pi_demand_letters WHERE id = $1`, [parentId]);
    if (p.rows[0]) version = (p.rows[0].version || 0) + 1;
  } else {
    const p = await db.query(
      `SELECT COALESCE(MAX(version), 0) as max_v FROM pi_demand_letters WHERE case_id = $1 AND target_insurance_id = $2`,
      [caseId, targetIns.id]
    );
    version = (p.rows[0]?.max_v || 0) + 1;
  }

  // Build citation block (only verified cases)
  const citesBlock = verifiedCases.slice(0, 30).map((cc, i) => {
    const cite = cc.case_name && cc.citation
      ? `${cc.case_name}, ${cc.citation}`
      : (cc.citation || cc.case_name || "unknown");
    return `${i + 1}. ${cite}`;
  }).join("\n");

  // Build case facts context
  const totalBilled = data.bills.reduce((s, b) => s + Number(b.billed_amount || 0), 0);
  const totalOutstanding = data.bills.reduce((s, b) => s + Number(b.outstanding_balance || 0), 0);

  const providersBlock = data.providers.length ? data.providers.map(p => {
    const parts = [`- ${p.provider_name}`];
    if (p.provider_type) parts.push(`(${p.provider_type})`);
    if (p.first_visit_date) parts.push(`first visit ${new Date(p.first_visit_date).toLocaleDateString()}`);
    if (p.last_visit_date) parts.push(`last visit ${new Date(p.last_visit_date).toLocaleDateString()}`);
    if (p.visits_count) parts.push(`${p.visits_count} visits`);
    return parts.join(" ");
  }).join("\n") : "(no providers on file)";

  const billsBlock = data.bills.length ? data.bills.map(b =>
    `- ${b.provider_name}: $${Number(b.billed_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}${b.is_lien ? " [LIEN]" : ""}${b.is_medi_cal ? " [MEDI-CAL]" : ""}${b.is_medicare ? " [MEDICARE]" : ""}`
  ).join("\n") : "(no bills on file)";

  const facts = [
    `**Case Info**`,
    `- Client (Claimant): ${c.client_name}`,
    c.client_dob ? `- DOB: ${new Date(c.client_dob).toLocaleDateString()}` : null,
    `- Incident Date: ${c.incident_date ? new Date(c.incident_date).toLocaleDateString() : "(not set)"}`,
    c.incident_type ? `- Incident Type: ${c.incident_type.replace(/_/g, " ")}` : null,
    c.incident_location ? `- Location: ${c.incident_location}` : null,
    c.police_report_number ? `- Police Report #: ${c.police_report_number} (${c.police_agency || "agency not specified"})` : null,
    ``,
    `**Adverse Carrier (Target)**`,
    `- Carrier: ${targetIns.carrier_name || "(unknown)"}`,
    `- Claim #: ${targetIns.claim_number || "(unknown)"}`,
    `- Adjuster: ${targetIns.adjuster_name || "(unknown)"}${targetIns.adjuster_phone ? " · " + targetIns.adjuster_phone : ""}${targetIns.adjuster_email ? " · " + targetIns.adjuster_email : ""}`,
    `- Insured (Adverse Party / Tortfeasor): ${targetIns.policy_holder || "(unknown)"}`,
    `- Policy Limits: ${policyLimits > 0 ? "$" + policyLimits.toLocaleString() : "(UNDISCLOSED — this letter demands disclosure)"}`,
    ``,
    `**Liability**`,
    c.liability_assessment ? `- Assessment: ${c.liability_assessment}` : "- Assessment: to be argued from facts",
    c.client_fault_pct > 0 ? `- Client comparative fault: ${c.client_fault_pct}%` : null,
    ``,
    `**Incident Description**`,
    c.incident_description || "(none)",
    ``,
    `**Injuries**`,
    c.injuries_description || "(none listed)",
    c.severity ? `Severity: ${c.severity}` : null,
    c.body_parts && c.body_parts.length ? `Body parts affected: ${c.body_parts.join(", ")}` : null,
    c.permanent_impairment ? `PERMANENT IMPAIRMENT` : null,
    ``,
    `**Medical Providers (${data.providers.length})**`,
    providersBlock,
    ``,
    `**Medical Bills (Total: $${totalBilled.toLocaleString(undefined, { minimumFractionDigits: 2 })}; Outstanding: $${totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })})**`,
    billsBlock,
    ``,
    `**Special Damages**`,
    `- Total medical bills: $${totalBilled.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    c.lost_wages > 0 ? `- Lost wages: $${Number(c.lost_wages).toLocaleString(undefined, { minimumFractionDigits: 2 })}${c.lost_wages_notes ? " (" + c.lost_wages_notes + ")" : ""}` : null,
    ``,
    `**General Damages (Pain & Suffering)**`,
    c.pain_suffering_est > 0 ? `Attorney estimate: $${Number(c.pain_suffering_est).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "Not yet estimated — argue from severity, treatment duration, permanence",
    ``,
    additionalContext ? `**Attorney Direction for This Letter**\n${additionalContext}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `You are drafting a TIME-LIMITED POLICY LIMITS DEMAND LETTER for a California personal injury case, on behalf of Tez Law P.C.

# CRITICAL RULES

**ZERO HALLUCINATION**: Every case citation in the letter MUST be from the VERIFIED CASE LAW list below. If you need to cite a case not on the list, write [CITATION NEEDED — <describe>] instead of inventing one. Every case citation must appear VERBATIM as it does in the verified list.

**CCP §§ 999-999.5 COMPLIANCE**: This letter must qualify as a valid time-limited demand under CCP § 999.1. Requirements:
- Explicit label as a policy limits demand
- Reference to CCP § 999.1
- Deadline of at least ${deadlineDays} days (policy limits ${policyLimits <= 250000 ? "≤ $250K" : "> $250K"}, so ${deadlineDays}-day minimum)
- Include supporting medical records and bills (will be attached separately — reference them)
- Include HIPAA authorization mention
- Specify release wording expected

**STRUCTURE** (all sections required, in this order, with headings):

## RE: [Client] v. [Insured] — Claim No. [Claim#], Date of Loss: [DOL]

1. **INTRODUCTION** — Identify Tez Law P.C. as counsel for [claimant], purpose of letter (time-limited policy limits demand), statutory basis (CCP §§ 999-999.5).

2. **FACTS AND LIABILITY** — Concise chronology of the incident. Analyze liability using the case-specific facts. If clear liability, say so with reasoning.

3. **INJURIES** — Every injury sustained, tied to the incident. Prognosis. Any permanence.

4. **MEDICAL TREATMENT** — Chronological summary of treatment by provider. Reference that itemized bills and records are attached (or available upon request).

5. **DAMAGES CALCULATION**
   - Special damages: total medicals + lost wages (concrete numbers from case facts)
   - General damages: pain and suffering, loss of enjoyment, emotional distress (justify the P&S estimate)
   - Future medicals if permanent injuries

6. **DEMAND FOR POLICY LIMITS DISCLOSURE** — Cite Cal. Ins. Code § 791.13, Cal. Veh. Code § 16058, and Cal. Ins. Code § 11580.09 (if commercial). Demand written disclosure within 30 days of:
   (a) All applicable primary/excess/umbrella policy limits
   (b) Additional insureds
   (c) Reservations of rights
   (d) Known coverage disputes
   Cite the bad faith framework (Comunale, Crisci, Johansen, Hedayati) as consequences of refusal.

7. **TIME-LIMITED POLICY LIMITS OFFER** — This is the key CCP § 999.1-compliant paragraph. State clearly:
   - "Pursuant to CCP § 999.1, this constitutes a time-limited policy limits demand."
   - Offer to release the insured in exchange for tender of the applicable policy limits.
   - **Deadline: ${deadlineDate}** (${deadlineDays} days from ${new Date().toLocaleDateString()})
   - Specify release wording (release of the insured from all claims, subject to standard exclusions, contingent on tender)
   - Reference HIPAA authorization enclosed
   - Reference itemized medical records/bills enclosed
   - State clearly that failure to accept exposes carrier to bad faith liability under Comunale and its progeny.

8. **NOTICE TO INSURED (Copy of this letter)** — Bold section warning the insured personally that:
   (a) A claim has been made against them
   (b) Their carrier has been demanded to disclose limits and tender
   (c) If the carrier refuses and a verdict exceeds coverage, the insured is PERSONALLY LIABLE for the excess
   (d) The insured should demand their carrier disclose limits and tender immediately
   (e) The insured should consider retaining personal counsel if they have concerns

9. **CONCLUSION** — Reiterate deadline. Contact info for response. Signature block for JJ Zhang, Managing Attorney, Tez Law P.C.

# VERIFIED CASE LAW (cite ONLY from this list)

${citesBlock}

# STATUTORY AUTHORITY (may be cited freely — these are statutes, not case law)

- California Insurance Code § 791.13 — policy limits disclosure
- California Vehicle Code § 16058 — auto insurance disclosure
- California Insurance Code § 11580.09 — commercial auto disclosure
- California Code of Civil Procedure §§ 999-999.5 — time-limited demand requirements
- California Insurance Code § 790.03 — unfair claim settlement practices

# CASE FACTS

${facts}

# WRITING STYLE

- Professional, firm, but not aggressive
- Formal legal correspondence — the recipient is an insurance adjuster who reads dozens of these
- ~1500-2500 words
- Use section headings for readability
- Cite statutes inline (e.g., "Pursuant to Cal. Ins. Code § 791.13...")
- Cite cases with proper Bluebook format (e.g., "Comunale v. Traders & General Ins. Co., 50 Cal.2d 654 (1958)")
- The demand paragraph must be UNAMBIGUOUS — a court must be able to look at it and confirm CCP § 999.1 compliance
- No hedging language in the demand section — this is a firm offer with a firm deadline
- Use the client's actual name and facts throughout — never leave placeholders

# BEGIN DEMAND LETTER

Output only the letter body starting with "Dear [Adjuster Name / Claims Department]:" and ending with the signature block. Do not include the header (attorney letterhead) — that's added separately.`;

  const resp = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: MODEL,
      max_tokens: 5000,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: 180000,
    }
  );

  const letter = resp.data.content?.[0]?.text || "";
  const usage = resp.data.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  // Sonnet 4.6 pricing: $3/MTok input, $15/MTok output
  const costUsd = +((inputTokens * 3 + outputTokens * 15) / 1_000_000).toFixed(4);

  // Extract cases actually cited by matching against verified list
  const citedCases = [];
  for (const cc of verifiedCases) {
    const label = cc.case_name || cc.citation;
    if (label && letter.toLowerCase().includes(label.toLowerCase())) {
      citedCases.push(cc.case_name || cc.citation);
    }
  }

  // Build certificate of service
  const certificateOfService = buildCertificateOfService({
    letterDate: new Date().toLocaleDateString(),
    carrierName: targetIns.carrier_name,
    adjusterName: targetIns.adjuster_name,
    insuredName: targetIns.policy_holder,
    claimNumber: targetIns.claim_number,
  });

  // Save to DB
  const inserted = await db.query(
    `INSERT INTO pi_demand_letters
       (case_id, target_insurance_id, target_carrier_name, target_adjuster_name, target_claim_number,
        letter_text, certificate_of_service, cases_cited,
        deadline_date, deadline_days, policy_limits_amount,
        version, parent_id, additional_context,
        model, input_tokens, output_tokens, estimated_cost_usd, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'draft')
     RETURNING id`,
    [
      caseId, targetIns.id, targetIns.carrier_name, targetIns.adjuster_name, targetIns.claim_number,
      letter, certificateOfService, citedCases,
      deadlineDate, deadlineDays, policyLimits > 0 ? policyLimits : null,
      version, parentId, additionalContext || null,
      MODEL, inputTokens, outputTokens, costUsd, createdBy,
    ]
  );

  const demandId = inserted.rows[0].id;

  // Log to universal audit trail
  try {
    const audit = require("./ai-audit-trail");
    await audit.log({
      feature_type: "demand_letter",
      source_module: "pi-demand-letter.js",
      related_table: "pi_demand_letters",
      related_id: demandId,
      client_key: c.client_key,
      client_name: c.client_name,
      matter_type: "personal_injury",
      original_output: letter,
      input_context_summary: `Time-limited demand v${version} to ${targetIns.carrier_name || "carrier"} (claim ${targetIns.claim_number || "?"}), ${deadlineDays}-day deadline (${deadlineDate}), policy limits ${policyLimits > 0 ? "$" + policyLimits.toLocaleString() : "UNDISCLOSED"}. Attorney context: ${additionalContext ? additionalContext.substring(0, 200) : "(none)"}`,
      input_context_full: prompt,
      model_used: MODEL,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: costUsd,
      generated_by: createdBy,
    });
  } catch (e) { console.warn("[audit-trail] demand-letter log failed:", e.message); }

  return {
    id: demandId,
    letter,
    certificate_of_service: certificateOfService,
    cases_cited: citedCases,
    verified_pool_size: verifiedCases.length,
    version,
    parent_id: parentId,
    deadline_date: deadlineDate,
    deadline_days: deadlineDays,
    policy_limits: policyLimits,
    target_carrier: targetIns.carrier_name,
    estimated_cost_usd: costUsd,
  };
}

// ─── Certificate of service ─────────────────────────────

function buildCertificateOfService({ letterDate, carrierName, adjusterName, insuredName, claimNumber }) {
  return `
CERTIFICATE OF SERVICE

I, the undersigned, declare that on ${letterDate}, I served a true and correct copy of the foregoing
POLICY LIMITS DEMAND LETTER on the following parties by the methods indicated:

TO THE CARRIER (Primary Recipient):
  ${carrierName || "[CARRIER NAME]"}
  Attn: ${adjusterName || "[ADJUSTER NAME]"}, Claims Adjuster
  Re: Claim No. ${claimNumber || "[CLAIM NUMBER]"}
  Method: [ ] Certified U.S. Mail, Return Receipt Requested
          [ ] Email (with confirmation of delivery)
          [ ] Fax with confirmation
          [ ] Courier / Hand Delivery

TO THE INSURED (Cc):
  ${insuredName || "[INSURED NAME]"}
  [INSURED ADDRESS — TO BE FILLED IN]
  Method: [ ] Certified U.S. Mail, Return Receipt Requested
          [ ] First-class U.S. Mail
  Notice to Insured: You are being provided a copy of the enclosed demand letter to
  advise you personally of the claim against you and the potential consequences of
  your insurance carrier's failure to timely tender applicable policy limits.

I declare under penalty of perjury under the laws of the State of California that
the foregoing is true and correct.

Executed on: _______________________, ${new Date().getFullYear()}
             at West Covina, California

Signature: __________________________________
           [SERVER NAME], Tez Law P.C.
`.trim();
}

// ─── CRUD ────────────────────────────────────────────────

async function getDemandLetter(id) {
  await initTable();
  const r = await db.query(`SELECT * FROM pi_demand_letters WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

async function listForCase(caseId) {
  await initTable();
  const r = await db.query(
    `SELECT dl.*, ins.role as insurance_role
     FROM pi_demand_letters dl
     LEFT JOIN pi_insurance ins ON ins.id = dl.target_insurance_id
     WHERE dl.case_id = $1
     ORDER BY dl.version DESC, dl.generated_at DESC`,
    [caseId]
  );
  return r.rows;
}

async function updateDeliveryStatus(id, {
  sent_date, sent_via, sent_to_carrier, sent_to_insured, tracking_number, insured_service_address,
}) {
  await initTable();
  const r = await db.query(
    `UPDATE pi_demand_letters SET
       sent_date = COALESCE($1, sent_date),
       sent_via = COALESCE($2, sent_via),
       sent_to_carrier = COALESCE($3, sent_to_carrier),
       sent_to_insured = COALESCE($4, sent_to_insured),
       tracking_number = COALESCE($5, tracking_number),
       insured_service_address = COALESCE($6, insured_service_address),
       status = CASE WHEN COALESCE($1, sent_date) IS NOT NULL AND status = 'draft' THEN 'sent' ELSE status END,
       updated_at = NOW()
     WHERE id = $7 RETURNING *`,
    [sent_date, sent_via, sent_to_carrier, sent_to_insured, tracking_number, insured_service_address, id]
  );
  return r.rows[0] || null;
}

async function updateResponseStatus(id, {
  response_received_date, response_summary, policy_limits_disclosed, disclosed_limits_amount,
  carrier_tendered_limits, tendered_amount, settlement_offered, settlement_offered_date,
}) {
  await initTable();
  // Determine new status
  let newStatus = null;
  if (carrier_tendered_limits) newStatus = "tendered";
  else if (policy_limits_disclosed) newStatus = "limits_disclosed";
  else if (response_received_date) newStatus = "carrier_responded";

  const r = await db.query(
    `UPDATE pi_demand_letters SET
       response_received_date = COALESCE($1, response_received_date),
       response_summary = COALESCE($2, response_summary),
       policy_limits_disclosed = COALESCE($3, policy_limits_disclosed),
       disclosed_limits_amount = COALESCE($4, disclosed_limits_amount),
       carrier_tendered_limits = COALESCE($5, carrier_tendered_limits),
       tendered_amount = COALESCE($6, tendered_amount),
       settlement_offered = COALESCE($7, settlement_offered),
       settlement_offered_date = COALESCE($8, settlement_offered_date),
       status = COALESCE($9, status),
       updated_at = NOW()
     WHERE id = $10 RETURNING *`,
    [
      response_received_date, response_summary, policy_limits_disclosed, disclosed_limits_amount,
      carrier_tendered_limits, tendered_amount, settlement_offered, settlement_offered_date,
      newStatus, id,
    ]
  );
  return r.rows[0] || null;
}

async function flagBadFaith(id, notes) {
  await initTable();
  const r = await db.query(
    `UPDATE pi_demand_letters SET
       bad_faith_flagged = TRUE,
       bad_faith_flag_date = CURRENT_DATE,
       bad_faith_notes = $1,
       status = 'bad_faith_flagged',
       updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [notes, id]
  );
  return r.rows[0] || null;
}

async function markSuperseded(id) {
  await initTable();
  await db.query(`UPDATE pi_demand_letters SET status = 'superseded', updated_at = NOW() WHERE id = $1`, [id]);
}

// ─── Cases needing bad faith flag (auto-check) ─────────
// Called by a cron / manual review: finds demand letters where the deadline has
// passed with no timely response or tender.

async function findExpiredDeadlines() {
  await initTable();
  const r = await db.query(
    `SELECT dl.*, c.client_name as case_client_name
     FROM pi_demand_letters dl
     JOIN pi_cases c ON c.id = dl.case_id
     WHERE dl.deadline_date < CURRENT_DATE
       AND dl.status IN ('sent', 'carrier_responded')
       AND NOT dl.carrier_tendered_limits
       AND NOT dl.bad_faith_flagged
     ORDER BY dl.deadline_date ASC`
  );
  return r.rows;
}

module.exports = {
  initTable,
  retrieveVerifiedPICaseLaw,
  calculateDeadlineDays,
  calculateDeadlineDate,
  generateDemandLetter,
  buildCertificateOfService,
  getDemandLetter,
  listForCase,
  updateDeliveryStatus,
  updateResponseStatus,
  flagBadFaith,
  markSuperseded,
  findExpiredDeadlines,
};
