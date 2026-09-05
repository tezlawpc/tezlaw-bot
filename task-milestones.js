// ============================================================
//  TEZ LAW P.C. — TASK MILESTONES
//  ─────────────────────────────────────────────────────────
//  Each task can have an ordered list of milestones — the standard
//  steps to complete the workflow. Common legal workflows come with
//  pre-built templates (habeas corpus, motion to reopen, RFE response,
//  TM application, etc.) so JJ doesn't have to re-enter the same
//  steps every time.
//
//  Consultants see milestone progress on their work orders so they
//  can follow along without asking for updates.
// ============================================================

const db = require("./db");

// ── Pre-built milestone templates, keyed by task.category ────
// Order matters — first entry = step 1, and so on. Every milestone
// is optional (can be skipped) but the template ensures the standard
// path is always at hand.
const TEMPLATES = {
  // ── Federal writs & appeals ────────────────────────
  habeas_corpus: [
    "Draft habeas petition",
    "File with U.S. District Court",
    "Response filed by government",
    "Receive briefing schedule / hearing date",
    "Bond hearing / merits hearing",
    "Receive additional order (if any)",
    "Receive final order",
    "Request for refund from government (if applicable)",
    "Case closed",
  ],
  writ_of_mandamus: [
    "Draft mandamus complaint",
    "File with U.S. District Court",
    "Serve DOJ / defendants",
    "Government's response due",
    "Reply brief (if any)",
    "Agency takes final action (adjudicates delayed matter)",
    "Voluntary dismissal / court order",
    "Case closed",
  ],
  circuit_court_petition: [
    "File petition for review with 9th Circuit",
    "Certified administrative record served",
    "Opening brief filed",
    "Government's response brief",
    "Reply brief filed",
    "Oral argument scheduled (if granted)",
    "Decision issued",
    "Petition granted / denied",
  ],
  notice_of_appeal_bia: [
    "File notice of appeal with BIA (Form EOIR-26)",
    "Filing fee paid / fee waiver requested",
    "Certified record of proceedings received",
    "Briefing schedule issued",
    "Opening brief filed with BIA",
    "DHS response brief",
    "BIA decision issued",
  ],

  // ── Immigration motions ────────────────────────────
  motion_to_reopen: [
    "Prepare motion to reopen",
    "Gather supporting evidence and affidavits",
    "File motion with IJ / BIA",
    "Government's response due",
    "Decision issued",
    "Further action if granted (new hearing scheduled)",
  ],
  motion_to_reconsider: [
    "Prepare motion to reconsider",
    "File motion with IJ / BIA within 30 days of decision",
    "Government's response due",
    "Decision issued",
  ],
  motion_to_terminate: [
    "Prepare motion to terminate proceedings",
    "File motion with IJ",
    "Government's response",
    "Master calendar or written decision",
    "Ruling issued",
  ],
  motion_to_continue: [
    "Prepare motion for continuance with supporting reason",
    "File motion at least 15 days before hearing",
    "IJ ruling (granted / denied)",
    "New hearing date confirmed",
  ],

  // ── Immigration filings & responses ────────────────
  rfe_response: [
    "Review the RFE and identify all requested items",
    "Gather requested evidence from client",
    "Draft response cover letter and legal argument",
    "Prepare exhibit list and organize documents",
    "File response with USCIS before deadline",
    "Await adjudication",
    "Decision issued",
  ],
  noid_response: [
    "Review the NOID and identify all objections",
    "Gather rebuttal evidence and expert declarations",
    "Draft NOID response with legal argument",
    "File response with USCIS before deadline",
    "Await adjudication",
    "Decision issued (approval / denial)",
  ],
  uscis_filing: [
    "Complete USCIS form(s) and supporting materials",
    "Client review + signature",
    "File package with USCIS + fee",
    "Receive receipt notice",
    "Biometrics appointment (if applicable)",
    "Interview scheduled (if applicable)",
    "Decision issued",
  ],
  eoir_filing: [
    "Prepare filing per Immigration Court Practice Manual",
    "Serve DHS via proof of service",
    "File with EOIR clerk",
    "Await master calendar or written response",
    "IJ decision / next hearing",
  ],

  // ── Immigration hearings ───────────────────────────
  master_calendar_prep: [
    "Confirm hearing date and location",
    "Review case file and pleadings",
    "Prepare client for hearing (interpretation, dress code, procedure)",
    "Attend master calendar",
    "Receive next hearing date or filing schedule",
  ],
  individual_hearing_prep: [
    "Review case theory and legal claims",
    "Prepare witness list and affidavits",
    "Compile exhibit binder for court and DHS",
    "Prepare client for direct + cross examination",
    "Prepare closing argument outline",
    "Attend individual hearing",
    "Receive oral decision or reserved decision",
  ],
  bond_hearing_prep: [
    "Gather bond hearing evidence (ties to community, sponsors, employment)",
    "Prepare release plan / sponsor declarations",
    "File bond motion with IJ",
    "Attend bond hearing",
    "Bond decision (granted / denied / amount set)",
    "Post bond and coordinate release (if granted)",
  ],

  // ── Personal Injury ────────────────────────────────
  demand_letter: [
    "Gather medical records and bills",
    "Calculate damages (medicals, lost wages, pain & suffering)",
    "Draft demand letter with liability + damages sections",
    "Attorney review and finalize",
    "Send to insurance adjuster",
    "Receive initial offer / response",
    "Begin negotiation",
  ],
  settlement_offer_response: [
    "Analyze insurance offer vs. case value",
    "Consult client with recommendation",
    "Draft counter-offer or acceptance",
    "Send response to adjuster",
    "Receive next offer",
    "Repeat until settled or impasse",
  ],
  lien_negotiation: [
    "Identify all liens (medical, gov, private)",
    "Request itemized lien statements",
    "Negotiate reductions with each lienholder",
    "Confirm final lien amounts in writing",
    "Coordinate payment at disbursement",
  ],
  disbursement: [
    "Confirm settlement funds received in trust",
    "Prepare settlement statement / closing statement",
    "Client signs disbursement authorization",
    "Pay liens and costs",
    "Cut attorney fee check",
    "Cut client net check",
    "Close case file",
  ],

  // ── Trademarks ─────────────────────────────────────
  tm_application: [
    "Conduct trademark clearance search",
    "Prepare specimen and description of use",
    "File application with USPTO (TEAS)",
    "Await examining attorney review (2-3 months)",
    "Respond to any office actions",
    "Publication for opposition",
    "Registration certificate issued",
  ],
  tm_office_action: [
    "Review office action objections",
    "Draft substantive response with legal argument",
    "Client review and approval",
    "File response with USPTO before deadline (usually 3-6 months)",
    "Await examiner's next action",
  ],
  tm_sou: [
    "Gather specimens of actual use in commerce",
    "Draft Statement of Use (Form 1553)",
    "File with USPTO + fee",
    "Await USPTO acceptance",
    "Registration issued",
  ],
  tm_renewal: [
    "Confirm continued use of mark in commerce",
    "Gather current specimens",
    "File Section 8 & 9 renewal with USPTO",
    "Registration renewed",
  ],
  tm_opposition: [
    "File Notice of Opposition with TTAB",
    "Serve applicant",
    "Discovery period",
    "Testimony period (opposer, then applicant)",
    "Briefing",
    "TTAB decision",
  ],

  // ── Business litigation ────────────────────────────
  file_complaint: [
    "Draft complaint with causes of action",
    "Verify facts with client",
    "File complaint + summons + civil case cover sheet",
    "Serve defendants",
    "Await defendant's answer or motion",
    "Case management conference",
  ],
  discovery_response: [
    "Analyze requests (interrogatories, RFPs, RFAs)",
    "Gather responsive documents from client",
    "Draft objections and responses",
    "Client review + verification",
    "Serve responses before deadline",
    "Meet & confer on any disputes",
  ],
  mediation: [
    "Select mediator (or agree with other side)",
    "Prepare mediation brief",
    "Client prep session (BATNA, ranges, priorities)",
    "Attend mediation",
    "Settlement agreement or continued negotiation",
  ],

  // ── Landlord/Tenant ────────────────────────────────
  ud_complaint: [
    "Verify notice was properly served (3/30/60/90-day)",
    "Draft UD complaint",
    "File with LASC clerk",
    "Serve tenant (personal, sub-service, post & mail)",
    "Await tenant's answer (5 court days)",
    "Trial date set",
    "Trial or default judgment",
  ],
  writ_of_possession: [
    "Confirm judgment for possession entered",
    "File writ of possession with clerk",
    "Deliver writ to sheriff",
    "Sheriff serves 5-day notice",
    "Lockout scheduled",
    "Restoration of possession",
  ],
};

async function initTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS task_milestones (
      id            SERIAL PRIMARY KEY,
      task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      order_num     INTEGER NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT,
      status        TEXT DEFAULT 'pending',      -- pending | in_progress | completed | skipped
      due_date      DATE,
      completed_at  TIMESTAMPTZ,
      completed_by  INTEGER,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_task_milestones_task ON task_milestones (task_id, order_num)`);
}

// Return the template for a task category, or [] if no template exists.
// Templates are just an array of milestone titles — anything more detailed
// (due dates, descriptions, notes) gets added per-instance later.
function getTemplate(category) {
  if (!category) return [];
  return TEMPLATES[category] || [];
}

function hasTemplate(category) {
  return !!(category && TEMPLATES[category] && TEMPLATES[category].length);
}

// List all task categories that have a milestone template — useful for UI
// hints so users know which categories will auto-populate.
function listTemplateCategories() {
  return Object.keys(TEMPLATES);
}

// Create milestones for a task from its category template. Idempotent —
// if milestones already exist for this task, this is a no-op.
async function seedFromTemplate(taskId, category) {
  await initTable();
  const template = getTemplate(category);
  if (!template.length) return [];
  // Idempotency: skip if any milestones already exist
  const existing = await db.query(`SELECT COUNT(*)::int AS n FROM task_milestones WHERE task_id = $1`, [taskId]);
  if (existing.rows[0].n > 0) return [];
  const created = [];
  for (let i = 0; i < template.length; i++) {
    const r = await db.query(
      `INSERT INTO task_milestones (task_id, order_num, title, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [taskId, i + 1, template[i]]
    );
    created.push(r.rows[0]);
  }
  return created;
}

async function listMilestones(taskId) {
  await initTable();
  const r = await db.query(
    `SELECT * FROM task_milestones WHERE task_id = $1 ORDER BY order_num ASC, id ASC`,
    [taskId]
  );
  return r.rows;
}

async function createMilestone(taskId, { title, description = null, due_date = null, order_num = null }) {
  await initTable();
  // Auto-assign order_num as next-highest if not given
  let orderNum = order_num;
  if (orderNum == null) {
    const maxR = await db.query(`SELECT COALESCE(MAX(order_num), 0) AS m FROM task_milestones WHERE task_id = $1`, [taskId]);
    orderNum = maxR.rows[0].m + 1;
  }
  const r = await db.query(
    `INSERT INTO task_milestones (task_id, order_num, title, description, due_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [taskId, orderNum, title, description, due_date]
  );
  return r.rows[0];
}

async function updateMilestone(id, fields) {
  await initTable();
  const allowed = ["title", "description", "status", "due_date", "notes", "order_num"];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(fields[key] === "" ? null : fields[key]);
    }
  }
  if (fields.status === "completed" && !fields.completed_at) {
    sets.push(`completed_at = NOW()`);
    if (fields.completed_by) {
      sets.push(`completed_by = $${i++}`);
      values.push(fields.completed_by);
    }
  }
  if (fields.status && fields.status !== "completed") {
    // Un-complete: clear completed_at
    sets.push(`completed_at = NULL`);
    sets.push(`completed_by = NULL`);
  }
  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  values.push(id);
  const r = await db.query(
    `UPDATE task_milestones SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`,
    values
  );
  return r.rows[0];
}

async function deleteMilestone(id) {
  await initTable();
  const r = await db.query(`DELETE FROM task_milestones WHERE id = $1 RETURNING task_id`, [id]);
  return r.rows[0] || null;
}

async function getMilestone(id) {
  await initTable();
  const r = await db.query(`SELECT * FROM task_milestones WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// Progress summary — count of milestones by status for a task
async function getProgress(taskId) {
  await initTable();
  const r = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM task_milestones WHERE task_id = $1 GROUP BY status`,
    [taskId]
  );
  const counts = { pending: 0, in_progress: 0, completed: 0, skipped: 0, total: 0 };
  for (const row of r.rows) {
    counts[row.status] = row.n;
    counts.total += row.n;
  }
  const done = counts.completed + counts.skipped;
  counts.percent = counts.total > 0 ? Math.round(done / counts.total * 100) : 0;
  return counts;
}

module.exports = {
  initTable,
  TEMPLATES,
  getTemplate, hasTemplate, listTemplateCategories,
  seedFromTemplate,
  listMilestones, createMilestone, updateMilestone, deleteMilestone, getMilestone,
  getProgress,
};
