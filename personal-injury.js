// ============================================================
//  TEZ LAW P.C. — PERSONAL INJURY CASE MANAGEMENT
//  ─────────────────────────────────────────────────────────
//  Full lifecycle: intake → treatment → demand → settlement →
//  disbursement → closing.
//
//  CA-specific defaults:
//   - 2-year SOL for tort (CCP § 335.1)
//   - Attorney fee: 33.33% pre-litigation, 40% post-filing
//   - Med-Pay stacking, UM/UIM handling
//   - Comparative negligence (pure)
//   - Hospital lien statute (H&S § 3040) + Medi-Cal lien (W&I § 14124.71)
//
//  Modern practice patterns:
//   - Letter of Protection (LOP) provider tracking
//   - Reduction negotiations captured (bill vs paid vs reduced)
//   - Property damage handled separately from bodily injury claim
//   - MedPay pursued in parallel with liability claim
//   - Structured settlement option flagged
// ============================================================

const db = require("./db");

// ─── Schema ─────────────────────────────────────────────

async function initTables() {
  // Main case record
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_cases (
      id                    SERIAL PRIMARY KEY,
      client_key            TEXT UNIQUE,                  -- links to Dropbox folder / client-profiles
      client_name           TEXT NOT NULL,
      client_email          TEXT,
      client_phone          TEXT,
      client_address        TEXT,
      client_dob            DATE,
      client_language       TEXT DEFAULT 'en',
      dropbox_folder_path   TEXT,                         -- auto-discovered via '-PI' suffix

      -- Incident details
      incident_date         DATE,
      incident_type         TEXT,                         -- auto, slip_fall, dog_bite, premises, product, med_mal, other
      incident_location     TEXT,
      incident_description  TEXT,
      police_report_number  TEXT,
      police_agency         TEXT,
      photos_available      BOOLEAN DEFAULT FALSE,
      witnesses             JSONB DEFAULT '[]'::jsonb,    -- [{name, phone, statement_summary}]

      -- Statute of limitations
      sol_date              DATE,                         -- calculated: incident + 2 years for CA tort
      sol_notes             TEXT,                         -- gov claim date, minor tolling, etc.
      gov_claim_required    BOOLEAN DEFAULT FALSE,
      gov_claim_filed_date  DATE,

      -- Liability & injuries
      liability_assessment  TEXT,                         -- clear liability / disputed / comparative
      client_fault_pct      NUMERIC(5,2) DEFAULT 0,       -- for comparative negligence math
      injuries_description  TEXT,
      body_parts            TEXT[],                       -- ['neck', 'lower_back', 'right_knee']
      severity              TEXT,                         -- minor | moderate | severe | catastrophic
      permanent_impairment  BOOLEAN DEFAULT FALSE,

      -- Damages tracking (running totals)
      lost_wages            NUMERIC(12,2) DEFAULT 0,
      lost_wages_notes      TEXT,
      pain_suffering_est    NUMERIC(12,2),                -- attorney's PS estimate

      -- Attorney fee config
      attorney_fee_pct_prelit    NUMERIC(5,2) DEFAULT 33.33,
      attorney_fee_pct_postfile  NUMERIC(5,2) DEFAULT 40.00,
      case_filed            BOOLEAN DEFAULT FALSE,        -- was a lawsuit filed?
      case_filed_date       DATE,
      case_number           TEXT,
      court                 TEXT,

      -- Workflow status
      status                TEXT DEFAULT 'intake',
        -- intake | investigating | treating | demand_prep | demanding | negotiating |
        -- settled | disbursing | closed | rejected
      status_notes          TEXT,
      last_status_change    TIMESTAMPTZ DEFAULT NOW(),
      referral_source       TEXT,
      referral_fee_pct      NUMERIC(5,2) DEFAULT 0,

      -- Assigned staff
      assigned_attorney     TEXT,
      assigned_paralegal    TEXT,

      -- Timestamps
      intake_date           DATE DEFAULT CURRENT_DATE,
      case_closed_date      DATE,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Insurance carriers involved
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_insurance (
      id                  SERIAL PRIMARY KEY,
      case_id             INTEGER NOT NULL REFERENCES pi_cases(id) ON DELETE CASCADE,
      role                TEXT NOT NULL,                  -- adverse | client_medpay | client_um_uim | client_health | client_auto
      carrier_name        TEXT,
      claim_number        TEXT,
      adjuster_name       TEXT,
      adjuster_phone      TEXT,
      adjuster_email      TEXT,
      policy_limits       NUMERIC(12,2),                  -- max coverage available
      policy_holder       TEXT,                           -- who owns the policy
      policy_number       TEXT,
      letter_of_rep_sent  DATE,
      subrogation_claim   NUMERIC(12,2) DEFAULT 0,        -- what health/medpay wants back
      subrogation_final   NUMERIC(12,2) DEFAULT 0,        -- what they actually got after negotiation
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Medical providers
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_providers (
      id                    SERIAL PRIMARY KEY,
      case_id               INTEGER NOT NULL REFERENCES pi_cases(id) ON DELETE CASCADE,
      provider_name         TEXT NOT NULL,
      provider_type         TEXT,                         -- ER, urgent_care, primary, chiro, PT, ortho, neuro, MRI, surgery, pain_mgmt, psych
      address               TEXT,
      phone                 TEXT,
      fax                   TEXT,
      contact_person        TEXT,
      billing_contact       TEXT,
      billing_email         TEXT,
      first_visit_date      DATE,
      last_visit_date       DATE,
      visits_count          INTEGER DEFAULT 0,
      is_lop                BOOLEAN DEFAULT FALSE,        -- Letter of Protection provider (paid from settlement)
      lop_signed_date       DATE,
      records_requested     DATE,
      records_received      DATE,
      bills_requested       DATE,
      bills_received        DATE,
      notes                 TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Medical bills / liens
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_bills (
      id                    SERIAL PRIMARY KEY,
      case_id               INTEGER NOT NULL REFERENCES pi_cases(id) ON DELETE CASCADE,
      provider_id           INTEGER REFERENCES pi_providers(id) ON DELETE SET NULL,
      provider_name         TEXT,                         -- denormalized for portability
      billed_amount         NUMERIC(12,2) DEFAULT 0,      -- what provider charged
      paid_by_insurance     NUMERIC(12,2) DEFAULT 0,      -- what health/medpay paid
      write_off             NUMERIC(12,2) DEFAULT 0,      -- provider-side write-offs
      outstanding_balance   NUMERIC(12,2) DEFAULT 0,      -- what's still owed
      reduction_negotiated  NUMERIC(12,2) DEFAULT 0,      -- $ reduction attorney negotiated
      final_paid_amount     NUMERIC(12,2) DEFAULT 0,      -- final $ paid from settlement
      is_lien               BOOLEAN DEFAULT FALSE,        -- provider has a legal lien
      is_medi_cal           BOOLEAN DEFAULT FALSE,        -- Medi-Cal statutory lien (W&I 14124.71)
      is_medicare           BOOLEAN DEFAULT FALSE,        -- Medicare Secondary Payer
      date_of_service_from  DATE,
      date_of_service_to    DATE,
      itemized_bill_received BOOLEAN DEFAULT FALSE,
      notes                 TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Settlement offers + final settlement
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_settlements (
      id                  SERIAL PRIMARY KEY,
      case_id             INTEGER NOT NULL REFERENCES pi_cases(id) ON DELETE CASCADE,
      offer_date          DATE,
      offer_from          TEXT,                           -- carrier name / party
      offer_amount        NUMERIC(12,2),
      counter_amount      NUMERIC(12,2),
      response            TEXT,                           -- accepted | countered | rejected | pending
      is_final            BOOLEAN DEFAULT FALSE,          -- this is the accepted final settlement
      structured          BOOLEAN DEFAULT FALSE,          -- structured settlement (annuity)
      release_signed_date DATE,
      check_received_date DATE,
      check_amount        NUMERIC(12,2),
      check_number        TEXT,
      trust_deposit_date  DATE,
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Case costs (advanced by firm, reimbursed from settlement)
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_costs (
      id                  SERIAL PRIMARY KEY,
      case_id             INTEGER NOT NULL REFERENCES pi_cases(id) ON DELETE CASCADE,
      description         TEXT NOT NULL,
      category            TEXT,                           -- filing_fee | medical_records | expert | court_reporter | mediation | other
      amount              NUMERIC(12,2) NOT NULL,
      paid_date           DATE,
      vendor              TEXT,
      receipt_path        TEXT,                           -- Dropbox path
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Final disbursement statement (settlement breakdown)
  await db.query(`
    CREATE TABLE IF NOT EXISTS pi_disbursements (
      id                    SERIAL PRIMARY KEY,
      case_id               INTEGER NOT NULL REFERENCES pi_cases(id) ON DELETE CASCADE,
      settlement_id         INTEGER REFERENCES pi_settlements(id) ON DELETE SET NULL,
      gross_settlement      NUMERIC(12,2) NOT NULL,
      attorney_fee_pct      NUMERIC(5,2) NOT NULL,
      attorney_fee_amount   NUMERIC(12,2) NOT NULL,
      case_costs_total      NUMERIC(12,2) DEFAULT 0,
      medical_bills_total   NUMERIC(12,2) DEFAULT 0,      -- final paid to providers
      liens_total           NUMERIC(12,2) DEFAULT 0,
      referral_fee_amount   NUMERIC(12,2) DEFAULT 0,
      other_deductions      NUMERIC(12,2) DEFAULT 0,
      other_deductions_notes TEXT,
      client_net_amount     NUMERIC(12,2) NOT NULL,
      client_check_number   TEXT,
      client_check_date     DATE,
      client_check_delivered_date DATE,
      client_signature_date DATE,                         -- client signed the statement
      statement_pdf_path    TEXT,                         -- Dropbox path to signed statement
      finalized             BOOLEAN DEFAULT FALSE,
      finalized_date        DATE,
      notes                 TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Indexes
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pi_cases_status ON pi_cases (status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pi_cases_sol ON pi_cases (sol_date) WHERE status NOT IN ('closed', 'rejected', 'settled', 'disbursed')`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pi_bills_case ON pi_bills (case_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pi_providers_case ON pi_providers (case_id)`);
}

// ─── Dropbox auto-discovery ─────────────────────────────
// Scans configured Dropbox branch roots (from DROPBOX_BRANCH_ROOTS env var)
// AND the Dropbox root, finds any folder that looks like a PI case, and
// creates/updates a matching pi_cases record.
//
// Matching is lenient — a folder counts as PI if its name contains "PI" as
// a whole word, or "Personal Injury" as a phrase. Position doesn't matter:
//   "Chen Wei -PI"            ✓
//   "Chen Wei PI"             ✓
//   "Chen Wei - PI"           ✓
//   "PI - Chen Wei"           ✓
//   "Chen Wei (PI)"           ✓
//   "Chen Wei PI Case"        ✓
//   "Personal Injury - Chen"  ✓
//   "SPIN class 2025"         ✗ (PI is inside another word)
//   "APIS documentation"      ✗
//
// The client name is extracted by stripping all PI markers wherever they
// appear, then cleaning up leftover punctuation.

// Whole-word PI or "Personal Injury" anywhere in the folder name (case-insensitive).
const PI_MATCHER = /\bPI\b|\bPersonal\s+Injury\b/i;

// Strips PI markers + surrounding punctuation from a folder name so we can
// use whatever's left as the client name.
function extractClientNameFromPIFolder(folderName) {
  return String(folderName)
    // Remove "Personal Injury" first (longer match), then "PI"
    .replace(/[\s\-_(\[]*\bPersonal\s+Injury\b[\s\-_)\]]*/gi, " ")
    .replace(/[\s\-_(\[]*\bPI\s+Case\b[\s\-_)\]]*/gi, " ")
    .replace(/[\s\-_(\[]*\bPI\b[\s\-_)\]]*/gi, " ")
    // Collapse leftover whitespace/punctuation
    .replace(/\s+/g, " ")
    .replace(/^[\s\-_,()\[\]]+|[\s\-_,()\[\]]+$/g, "")
    .trim();
}

async function discoverPICasesFromDropbox({ dryRun = false, paths = null } = {}) {
  await initTables();
  const dbx = require("./dropbox-integration");
  const results = {
    found: 0, created: 0, updated: 0,
    considered: [],  // { path, name, matched, client_name, action }
    errors: [],
    branches_scanned: [],
  };

  // Figure out where to scan. Priority order:
  //   1. Explicit paths passed in (from preview page "Scan here" button)
  //   2. PI_DROPBOX_ROOTS env var (comma-separated, dedicated to PI folders)
  //   3. DROPBOX_BRANCH_ROOTS env var (general branches used elsewhere)
  //   4. Dropbox root as last resort
  let rootsToScan;
  if (paths && paths.length) {
    rootsToScan = paths.map(p => (p.startsWith("/") || p === "" ? p : `/${p}`));
  } else {
    const piRoots = (process.env.PI_DROPBOX_ROOTS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (piRoots.length) {
      rootsToScan = piRoots.map(p => (p.startsWith("/") ? p : `/${p}`));
    } else {
      const branchRoots = (typeof dbx.getBranchRoots === "function")
        ? dbx.getBranchRoots()
        : (process.env.DROPBOX_BRANCH_ROOTS || "").split(",").map(s => s.trim()).filter(Boolean);
      rootsToScan = [""];  // Dropbox root
      for (const branch of branchRoots) {
        const path = branch.startsWith("/") ? branch : `/${branch}`;
        if (!rootsToScan.includes(path)) rootsToScan.push(path);
      }
    }
  }

  const piFolders = [];  // { name, path_display, root }

  for (const root of rootsToScan) {
    try {
      const entries = await dbx.listFolder(root);
      if (!entries) {
        results.errors.push(`Could not list Dropbox folder: ${root || "(root)"}`);
        results.branches_scanned.push({ root: root || "(root)", ok: false, count: 0 });
        continue;
      }
      results.branches_scanned.push({ root: root || "(root)", ok: true, count: entries.length });

      for (const e of entries) {
        if (e[".tag"] !== "folder") continue;
        const name = String(e.name || "").trim();
        const matched = PI_MATCHER.test(name);
        results.considered.push({
          path: e.path_display,
          name,
          matched,
          root: root || "(root)",
        });
        if (matched) {
          piFolders.push({ name, path_display: e.path_display, root });
        }
      }
    } catch (err) {
      results.errors.push(`Scan failed for ${root || "(root)"}: ${err.message}`);
    }
  }

  results.found = piFolders.length;

  if (dryRun) return results;

  for (const folder of piFolders) {
    try {
      const clientName = extractClientNameFromPIFolder(folder.name);
      if (!clientName) {
        results.errors.push(`Could not extract client name from: ${folder.name}`);
        continue;
      }

      const clientKey = clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      // Check if case already exists (by key OR by folder path — either indicates a match)
      const existing = await db.query(
        `SELECT id FROM pi_cases WHERE client_key = $1 OR dropbox_folder_path = $2`,
        [clientKey, folder.path_display]
      );

      if (existing.rows.length > 0) {
        // Update path if the folder location moved or changed
        await db.query(
          `UPDATE pi_cases SET dropbox_folder_path = $1, updated_at = NOW() WHERE id = $2`,
          [folder.path_display, existing.rows[0].id]
        );
        results.updated++;
      } else {
        // Create new case with minimal info (attorney fills in details later)
        await db.query(
          `INSERT INTO pi_cases (client_key, client_name, dropbox_folder_path, status, intake_date)
           VALUES ($1, $2, $3, 'intake', CURRENT_DATE)`,
          [clientKey, clientName, folder.path_display]
        );
        results.created++;
      }
    } catch (e) {
      results.errors.push(`${folder.name}: ${e.message}`);
    }
  }

  return results;
}

// ─── Case management ────────────────────────────────────

async function listCases(filters = {}) {
  await initTables();
  const conds = [];
  const params = [];
  let i = 1;
  if (filters.status) { conds.push(`status = $${i++}`); params.push(filters.status); }
  if (filters.assigned_attorney) { conds.push(`assigned_attorney = $${i++}`); params.push(filters.assigned_attorney); }
  if (filters.incident_type) { conds.push(`incident_type = $${i++}`); params.push(filters.incident_type); }
  if (filters.sol_approaching_days) {
    conds.push(`sol_date IS NOT NULL AND sol_date <= CURRENT_DATE + ($${i++} || ' days')::interval`);
    params.push(filters.sol_approaching_days);
    conds.push(`status NOT IN ('closed', 'rejected', 'settled', 'disbursed')`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const r = await db.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM pi_providers WHERE case_id = c.id)::int as providers_count,
            (SELECT COUNT(*) FROM pi_bills WHERE case_id = c.id)::int as bills_count,
            (SELECT COALESCE(SUM(billed_amount), 0) FROM pi_bills WHERE case_id = c.id) as total_billed,
            (SELECT COALESCE(SUM(outstanding_balance), 0) FROM pi_bills WHERE case_id = c.id) as total_outstanding,
            (SELECT COALESCE(SUM(amount), 0) FROM pi_costs WHERE case_id = c.id) as total_costs,
            (SELECT MAX(offer_amount) FROM pi_settlements WHERE case_id = c.id AND NOT is_final) as best_offer,
            (SELECT check_amount FROM pi_settlements WHERE case_id = c.id AND is_final LIMIT 1) as final_settlement,
            (sol_date - CURRENT_DATE) as days_to_sol
     FROM pi_cases c
     ${where}
     ORDER BY
       CASE status
         WHEN 'intake' THEN 1
         WHEN 'investigating' THEN 2
         WHEN 'treating' THEN 3
         WHEN 'demand_prep' THEN 4
         WHEN 'demanding' THEN 5
         WHEN 'negotiating' THEN 6
         WHEN 'settled' THEN 7
         WHEN 'disbursing' THEN 8
         WHEN 'closed' THEN 9
         WHEN 'rejected' THEN 10
         ELSE 99
       END,
       COALESCE(sol_date, '9999-12-31') ASC,
       c.updated_at DESC`,
    params
  );
  return r.rows;
}

async function getCase(id) {
  await initTables();
  const caseRow = (await db.query(`SELECT * FROM pi_cases WHERE id = $1`, [id])).rows[0];
  if (!caseRow) return null;
  const [insurance, providers, bills, settlements, costs, disbursements] = await Promise.all([
    db.query(`SELECT * FROM pi_insurance WHERE case_id = $1 ORDER BY id`, [id]),
    db.query(`SELECT * FROM pi_providers WHERE case_id = $1 ORDER BY first_visit_date ASC NULLS LAST, id`, [id]),
    db.query(`SELECT * FROM pi_bills WHERE case_id = $1 ORDER BY date_of_service_from ASC NULLS LAST, id`, [id]),
    db.query(`SELECT * FROM pi_settlements WHERE case_id = $1 ORDER BY offer_date DESC NULLS LAST, id DESC`, [id]),
    db.query(`SELECT * FROM pi_costs WHERE case_id = $1 ORDER BY paid_date DESC NULLS LAST, id DESC`, [id]),
    db.query(`SELECT * FROM pi_disbursements WHERE case_id = $1 ORDER BY id DESC`, [id]),
  ]);
  return {
    case: caseRow,
    insurance: insurance.rows,
    providers: providers.rows,
    bills: bills.rows,
    settlements: settlements.rows,
    costs: costs.rows,
    disbursements: disbursements.rows,
  };
}

async function updateCase(id, fields) {
  await initTables();
  const allowed = [
    "client_name", "client_email", "client_phone", "client_address", "client_dob", "client_language",
    "incident_date", "incident_type", "incident_location", "incident_description",
    "police_report_number", "police_agency", "photos_available",
    "sol_date", "sol_notes", "gov_claim_required", "gov_claim_filed_date",
    "liability_assessment", "client_fault_pct", "injuries_description", "body_parts", "severity", "permanent_impairment",
    "lost_wages", "lost_wages_notes", "pain_suffering_est",
    "attorney_fee_pct_prelit", "attorney_fee_pct_postfile",
    "case_filed", "case_filed_date", "case_number", "court",
    "status", "status_notes", "referral_source", "referral_fee_pct",
    "assigned_attorney", "assigned_paralegal",
  ];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      // Handle arrays (body_parts)
      if (key === "body_parts" && Array.isArray(fields[key])) {
        values.push(fields[key]);
      } else if (fields[key] === "" || fields[key] === "null") {
        values.push(null);
      } else {
        values.push(fields[key]);
      }
    }
  }
  if (!sets.length) return null;
  // Auto-update last_status_change if status changed
  if (fields.status) sets.push(`last_status_change = NOW()`);
  sets.push(`updated_at = NOW()`);
  // Auto-calculate SOL if incident_date provided and no explicit sol_date
  if (fields.incident_date && !fields.sol_date) {
    // CA CCP 335.1: 2 years for tort. Attorney can override.
    // We only set if not manually set — check current value
    const cur = await db.query(`SELECT sol_date FROM pi_cases WHERE id = $1`, [id]);
    if (!cur.rows[0]?.sol_date) {
      sets.push(`sol_date = ($${i++}::date + INTERVAL '2 years')::date`);
      values.push(fields.incident_date);
    }
  }
  values.push(id);
  const r = await db.query(
    `UPDATE pi_cases SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return r.rows[0] || null;
}

// ─── Provider / bill / insurance helpers ────────────────

async function addProvider(caseId, data) {
  await initTables();
  const r = await db.query(
    `INSERT INTO pi_providers
       (case_id, provider_name, provider_type, address, phone, fax, contact_person,
        billing_contact, billing_email, first_visit_date, last_visit_date, visits_count,
        is_lop, lop_signed_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      caseId, data.provider_name, data.provider_type || null, data.address || null,
      data.phone || null, data.fax || null, data.contact_person || null,
      data.billing_contact || null, data.billing_email || null,
      data.first_visit_date || null, data.last_visit_date || null, data.visits_count || 0,
      !!data.is_lop, data.lop_signed_date || null, data.notes || null,
    ]
  );
  return r.rows[0];
}

async function addBill(caseId, data) {
  await initTables();
  const outstanding = data.outstanding_balance !== undefined
    ? data.outstanding_balance
    : Math.max(0, (data.billed_amount || 0) - (data.paid_by_insurance || 0) - (data.write_off || 0));

  const r = await db.query(
    `INSERT INTO pi_bills
       (case_id, provider_id, provider_name, billed_amount, paid_by_insurance,
        write_off, outstanding_balance, is_lien, is_medi_cal, is_medicare,
        date_of_service_from, date_of_service_to, itemized_bill_received, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      caseId, data.provider_id || null, data.provider_name,
      data.billed_amount || 0, data.paid_by_insurance || 0, data.write_off || 0, outstanding,
      !!data.is_lien, !!data.is_medi_cal, !!data.is_medicare,
      data.date_of_service_from || null, data.date_of_service_to || null,
      !!data.itemized_bill_received, data.notes || null,
    ]
  );
  return r.rows[0];
}

async function addInsurance(caseId, data) {
  await initTables();
  const r = await db.query(
    `INSERT INTO pi_insurance
       (case_id, role, carrier_name, claim_number, adjuster_name, adjuster_phone, adjuster_email,
        policy_limits, policy_holder, policy_number, letter_of_rep_sent, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      caseId, data.role, data.carrier_name || null, data.claim_number || null,
      data.adjuster_name || null, data.adjuster_phone || null, data.adjuster_email || null,
      data.policy_limits || null, data.policy_holder || null, data.policy_number || null,
      data.letter_of_rep_sent || null, data.notes || null,
    ]
  );
  return r.rows[0];
}

async function addCost(caseId, data) {
  await initTables();
  const r = await db.query(
    `INSERT INTO pi_costs (case_id, description, category, amount, paid_date, vendor, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [caseId, data.description, data.category || null, data.amount, data.paid_date || null, data.vendor || null, data.notes || null]
  );
  return r.rows[0];
}

async function addSettlementOffer(caseId, data) {
  await initTables();
  const r = await db.query(
    `INSERT INTO pi_settlements
       (case_id, offer_date, offer_from, offer_amount, counter_amount, response, is_final,
        structured, release_signed_date, check_received_date, check_amount, check_number,
        trust_deposit_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      caseId, data.offer_date || null, data.offer_from || null, data.offer_amount || null,
      data.counter_amount || null, data.response || "pending", !!data.is_final,
      !!data.structured, data.release_signed_date || null,
      data.check_received_date || null, data.check_amount || null, data.check_number || null,
      data.trust_deposit_date || null, data.notes || null,
    ]
  );
  return r.rows[0];
}

// ─── Disbursement calculator ────────────────────────────
// The core financial math of a PI case: given the settlement + everything else,
// what does the client actually take home?

async function calculateDisbursement(caseId, overrides = {}) {
  await initTables();
  const data = await getCase(caseId);
  if (!data) throw new Error("Case not found");

  const finalSettlement = data.settlements.find(s => s.is_final);
  const grossSettlement = overrides.gross_settlement !== undefined
    ? Number(overrides.gross_settlement)
    : Number(finalSettlement?.check_amount || 0);

  // Attorney fee percentage: use post-filing rate if case was filed, else pre-litigation
  const feePct = overrides.attorney_fee_pct !== undefined
    ? Number(overrides.attorney_fee_pct)
    : Number(data.case.case_filed
        ? data.case.attorney_fee_pct_postfile
        : data.case.attorney_fee_pct_prelit) || 33.33;

  const attorneyFee = +(grossSettlement * feePct / 100).toFixed(2);

  // Case costs
  const caseCostsTotal = overrides.case_costs_total !== undefined
    ? Number(overrides.case_costs_total)
    : data.costs.reduce((sum, c) => sum + Number(c.amount || 0), 0);

  // Medical bills — use final_paid_amount if set, else outstanding_balance
  // (final_paid is the actual disbursement amount after negotiations)
  const medicalBillsTotal = overrides.medical_bills_total !== undefined
    ? Number(overrides.medical_bills_total)
    : data.bills.reduce((sum, b) => {
        const finalPaid = Number(b.final_paid_amount || 0);
        return sum + (finalPaid > 0 ? finalPaid : Number(b.outstanding_balance || 0));
      }, 0);

  // Liens (separate from ordinary bills — statutory liens like Medi-Cal, Medicare, hospital)
  const liensTotal = overrides.liens_total !== undefined
    ? Number(overrides.liens_total)
    : data.bills
        .filter(b => b.is_medi_cal || b.is_medicare)
        .reduce((sum, b) => {
          const finalPaid = Number(b.final_paid_amount || 0);
          return sum + (finalPaid > 0 ? finalPaid : Number(b.outstanding_balance || 0));
        }, 0);

  // Referral fee (paid out of attorney fee, not gross)
  const referralFeePct = Number(data.case.referral_fee_pct || 0);
  const referralFeeAmount = +(attorneyFee * referralFeePct / 100).toFixed(2);
  const netAttorneyFee = +(attorneyFee - referralFeeAmount).toFixed(2);

  const otherDeductions = Number(overrides.other_deductions || 0);

  // The client's net take-home
  const clientNet = +(
    grossSettlement - attorneyFee - caseCostsTotal - medicalBillsTotal - otherDeductions
  ).toFixed(2);

  return {
    gross_settlement: grossSettlement,
    attorney_fee_pct: feePct,
    attorney_fee_amount: attorneyFee,
    referral_fee_pct: referralFeePct,
    referral_fee_amount: referralFeeAmount,
    net_attorney_fee: netAttorneyFee,
    case_costs_total: caseCostsTotal,
    case_costs_breakdown: data.costs.map(c => ({
      description: c.description, amount: Number(c.amount || 0), category: c.category,
    })),
    medical_bills_total: medicalBillsTotal,
    medical_bills_breakdown: data.bills.map(b => ({
      provider_name: b.provider_name,
      billed: Number(b.billed_amount || 0),
      insurance_paid: Number(b.paid_by_insurance || 0),
      outstanding: Number(b.outstanding_balance || 0),
      reduction_negotiated: Number(b.reduction_negotiated || 0),
      final_paid: Number(b.final_paid_amount || 0) || Number(b.outstanding_balance || 0),
      is_lien: b.is_lien,
      is_medi_cal: b.is_medi_cal,
      is_medicare: b.is_medicare,
    })),
    liens_total: liensTotal,
    other_deductions: otherDeductions,
    other_deductions_notes: overrides.other_deductions_notes || null,
    client_net_amount: clientNet,

    // Efficiency metrics
    client_net_pct: grossSettlement > 0 ? +(clientNet / grossSettlement * 100).toFixed(1) : 0,
    total_medical_billed: data.bills.reduce((s, b) => s + Number(b.billed_amount || 0), 0),
    total_medical_reductions: data.bills.reduce((s, b) => s + Number(b.reduction_negotiated || 0), 0),
  };
}

// Save a finalized disbursement
async function saveDisbursement(caseId, data) {
  await initTables();
  const r = await db.query(
    `INSERT INTO pi_disbursements
       (case_id, settlement_id, gross_settlement, attorney_fee_pct, attorney_fee_amount,
        case_costs_total, medical_bills_total, liens_total, referral_fee_amount,
        other_deductions, other_deductions_notes, client_net_amount,
        client_check_number, client_check_date, notes, finalized, finalized_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      caseId, data.settlement_id || null,
      data.gross_settlement, data.attorney_fee_pct, data.attorney_fee_amount,
      data.case_costs_total || 0, data.medical_bills_total || 0, data.liens_total || 0,
      data.referral_fee_amount || 0, data.other_deductions || 0,
      data.other_deductions_notes || null, data.client_net_amount,
      data.client_check_number || null, data.client_check_date || null,
      data.notes || null, !!data.finalized, data.finalized ? new Date() : null,
    ]
  );
  return r.rows[0];
}

// ─── Stats for dashboard ────────────────────────────────

async function getStats() {
  await initTables();
  const r = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status NOT IN ('closed', 'rejected')) as active_cases,
      COUNT(*) FILTER (WHERE status = 'intake') as new_intake,
      COUNT(*) FILTER (WHERE status = 'treating') as in_treatment,
      COUNT(*) FILTER (WHERE status = 'demanding' OR status = 'negotiating') as in_negotiation,
      COUNT(*) FILTER (WHERE status = 'settled' OR status = 'disbursing') as awaiting_disbursement,
      COUNT(*) FILTER (WHERE status = 'closed') as closed,
      COUNT(*) FILTER (WHERE sol_date IS NOT NULL AND sol_date <= CURRENT_DATE + INTERVAL '60 days' AND status NOT IN ('closed', 'rejected', 'settled', 'disbursed')) as sol_within_60_days,
      COUNT(*) FILTER (WHERE sol_date IS NOT NULL AND sol_date <= CURRENT_DATE + INTERVAL '30 days' AND status NOT IN ('closed', 'rejected', 'settled', 'disbursed')) as sol_within_30_days,
      COUNT(*) FILTER (WHERE sol_date IS NOT NULL AND sol_date < CURRENT_DATE AND status NOT IN ('closed', 'rejected', 'settled', 'disbursed')) as sol_expired,
      (SELECT COALESCE(SUM(gross_settlement), 0) FROM pi_disbursements WHERE finalized AND finalized_date > NOW() - INTERVAL '365 days') as annual_gross_recovery,
      (SELECT COALESCE(SUM(attorney_fee_amount), 0) FROM pi_disbursements WHERE finalized AND finalized_date > NOW() - INTERVAL '365 days') as annual_attorney_fees
    FROM pi_cases
  `);
  return r.rows[0] || {};
}

module.exports = {
  initTables,
  discoverPICasesFromDropbox,
  extractClientNameFromPIFolder,
  PI_MATCHER,
  listCases,
  getCase,
  updateCase,
  addProvider,
  addBill,
  addInsurance,
  addCost,
  addSettlementOffer,
  calculateDisbursement,
  saveDisbursement,
  getStats,
};
